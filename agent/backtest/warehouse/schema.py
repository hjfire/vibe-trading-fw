"""Column contract and write gate for the local market-data warehouse.

Everything stored here is *raw*: unadjusted prices plus the adjustment factor
that was in force for that bar. The reason is that the project's qfq is
window-anchored — ``backtest.loaders.cn_adjust.apply_qfq`` divides by
``series.iloc[-1]``, the last factor *of the requested window* — so a stored
qfq series would be rewritten by the next dividend and ``2020-2023`` would stop
matching the same slice of a ``2016-2026`` pull. Raw + per-row factor is the
only append-only stable form; adjusted prices are computed on read.

The gate below encodes three rules learned from the existing pipeline:

1. A bar with no usable adjustment factor never enters the warehouse for a
    corporate-action-bearing asset. ``tushare.py:256-274`` already prefers
    dropping a symbol over backtesting unadjusted prices (the -47.2% fake
    return on 300750.SZ 2023-04-26), and the same reasoning applies to writing
    storage: one raw close among adjusted ones is a silent split.
2. A zero-volume bar is *deleted*, not kept as a placeholder. Missing rows are
    how the whole project spells "halted": ``engines/base.py:_align`` builds the
    calendar as the union of the symbols' own indexes and forward-fills with a
    limit, and ``test_backtest_with_suspension_gap`` asserts the gap stays NaN.
    An ``is_halt`` placeholder row would turn "did not trade" into "price did
    not move" and defeat that. Indexes are exempt — an index can legitimately
    print zero volume.
3. Units are reconciled at write time. ``volume`` for A-shares is board lots
    (``#1062``, declared by every A-share loader) and tushare ``amount`` is CNY
    thousands (relied on by ``alpha_bench_tool.py:427-435``). A 100x or 1000x
    unit slip inside one partition is invisible downstream, so an undeclared
    market is refused outright instead of guessed.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass, field
from typing import Any

import pandas as pd

from backtest.loaders.base import validate_ohlc
from backtest.loaders._symbol_utils import _is_etf_listed

logger = logging.getLogger(__name__)

#: Every column of a ``data.parquet`` partition, in write order.
BAR_COLUMNS: tuple[str, ...] = (
    "symbol",
    "market",
    "asset_class",
    "session_date",
    "open",
    "high",
    "low",
    "close",
    "volume",
    "amount",
    "adj_factor",
    "source",
)

_PRICE_COLUMNS: tuple[str, ...] = ("open", "high", "low", "close")
_FLOAT_COLUMNS: tuple[str, ...] = ("open", "high", "low", "close", "volume", "amount", "adj_factor")

#: Timestamp column names accepted from a source frame, index first.
_TIME_COLUMN_CANDIDATES: tuple[str, ...] = (
    "datetime",
    "trade_date",
    "time",
    "timestamp",
    "date",
)

_INTERVAL_RE = re.compile(r"^(\d+)([mHdD])$")

# Asset classes, mirroring the routing branches of ``tushare._fetch_daily_frame``
# (fund_daily / index_daily / hk_daily / daily). ``market`` alone cannot
# separate them: 000300.SH (index), 510050.SH (ETF) and 600519.SH (equity) all
# detect as ``a_share``.
ASSET_EQUITY = "equity"
ASSET_FUND = "fund"
ASSET_INDEX = "index"
ASSET_OTHER = "other"
ASSET_CLASSES: tuple[str, ...] = (ASSET_EQUITY, ASSET_FUND, ASSET_INDEX, ASSET_OTHER)

_EQUITY_MARKETS = frozenset(
    {
        "a_share",
        "hk_equity",
        "us_equity",
        "india_equity",
        "kr_equity",
        "ca_equity",
        "uk_equity",
        "vietnam_equity",
    }
)


def _is_index_code(code: str) -> bool:
    """Detect A-share index symbols, mirroring ``tushare._is_index``.

    Kept as a local copy of the rule rather than an import from the loader: the
    warehouse must not import a network loader to classify a symbol, and a test
    pins the two definitions against each other.
    """
    if code.endswith(".SH"):
        digits = code.split(".")[0]
        return len(digits) == 6 and digits.isdigit() and digits.startswith("000")
    if code.endswith(".SZ"):
        digits = code.split(".")[0]
        return len(digits) == 6 and digits.isdigit() and digits.startswith("399")
    return False


class WarehouseConfigError(RuntimeError):
    """A (source, market) pair is not admissible; nothing was written.

    Raised for configuration-level mismatches (undeclared canonical unit, a
    market whose prices need factors but whose source has no factor series).
    Row-level rejections are quiet by design and land in :class:`RejectReport`
    instead, since a handful of bad bars is normal.
    """


@dataclass(frozen=True)
class AssetRule:
    """How the gate treats one asset class.

    Args:
        adjust_applicable: whether a finite positive ``adj_factor`` is required
            on every stored bar.
        drop_zero_volume: whether a zero-volume row is dropped as a non-session.
    """

    adjust_applicable: bool
    drop_zero_volume: bool


_ASSET_RULES: dict[str, AssetRule] = {
    ASSET_EQUITY: AssetRule(adjust_applicable=True, drop_zero_volume=True),
    ASSET_FUND: AssetRule(adjust_applicable=True, drop_zero_volume=True),
    # An index level is already continuous across its members' ex-dates, and it
    # can print zero volume without that meaning a data hole.
    ASSET_INDEX: AssetRule(adjust_applicable=False, drop_zero_volume=False),
    # crypto / futures / forex: no corporate actions, but a 0-volume print is
    # noise rather than an informative gap.
    ASSET_OTHER: AssetRule(adjust_applicable=False, drop_zero_volume=True),
}


@dataclass(frozen=True)
class CanonicalUnits:
    """Units the warehouse insists on storing, per market.

    A ``None`` field means "not yet established by evidence", which blocks
    writes for that market rather than letting a guessed unit in.
    """

    volume_unit: str | None
    amount_unit: str | None


_CANONICAL_UNITS: dict[str, CanonicalUnits] = {
    # Board lots + CNY thousands, the pair every A-share loader already delivers
    # (``volume_units = {"a_share": "lots"}``, #1062) and the pair the factor
    # pipeline already multiplies by 100 / 1000 for vwap.
    "a_share": CanonicalUnits(volume_unit="lots", amount_unit="cny_thousand"),
}

#: ``amount`` units, keyed by ``(source, market)``. No loader declares an amount
#: unit (only ``volume_units`` exists on the protocol), and the units really do
#: differ: Tushare documents ``amount`` in CNY thousands and
#: ``alpha_bench_tool.py:427-435`` multiplies by 1000 to build VWAP, while the
#: HTTP sources deliver CNY. An unlisted pair stores NULL, never a guess.
_AMOUNT_UNITS: dict[tuple[str, str], str] = {
    ("tushare", "a_share"): "cny_thousand",
}

#: Exact, documented unit conversions. Only pairs whose ratio is a constant are
#: listed; board-lot size is fixed at 100 for A-shares, so ``lots`` <->
#: ``shares`` is safe there, while nothing here claims an HK lot size.
_UNIT_CONVERSIONS: dict[tuple[str, str], float] = {
    ("lots", "shares"): 100.0,
    ("shares", "lots"): 1.0 / 100.0,
    ("cny", "cny_thousand"): 1.0 / 1000.0,
    ("cny_thousand", "cny"): 1000.0,
}


@dataclass
class RejectReport:
    """What the gate threw away, and what still has to be fetched.

    Attributes:
        rows_in: Rows handed to :func:`normalize_bars`.
        rows_out: Rows that survived the gate, so ``rows_in - rows_out`` is the
            drop count without having to re-derive it from :attr:`dropped`.
        dropped: Reason-keyed row counts.
        pending_dates: ``YYYY-MM-DD`` sessions dropped for a missing adjustment
            factor. These are *holes*, not absences: a later sync must retry
            them, because the factor series can lag the price series by hours.
        notes: Human-readable lines for the run log / audit.
    """

    rows_in: int = 0
    rows_out: int = 0
    dropped: dict[str, int] = field(default_factory=dict)
    pending_dates: list[str] = field(default_factory=list)
    notes: list[str] = field(default_factory=list)

    @property
    def total_dropped(self) -> int:
        return int(sum(self.dropped.values()))

    @property
    def is_clean(self) -> bool:
        """Whether every input row survived the gate."""
        return not self.dropped and not self.pending_dates

    def note(self, text: str) -> None:
        if text not in self.notes:
            self.notes.append(text)

    def to_dict(self) -> dict[str, Any]:
        return {
            "rows_in": self.rows_in,
            "rows_out": self.rows_out,
            "dropped": dict(self.dropped),
            "pending_dates": list(self.pending_dates),
            "notes": list(self.notes),
        }


def classify_asset(symbol: str, market: str | None = None) -> tuple[str, str]:
    """Return ``(market, asset_class)`` for one project symbol.

    Market detection is delegated to the engine's table so the warehouse cannot
    disagree with the hooks that price the same symbol; the asset class reuses
    the loader predicates that decide which Tushare endpoint serves the code.

    Args:
        symbol: Project-format ticker (``600519.SH``, ``510050.SH``, ``BTC-USDT``).
        market: Pre-computed market, when the caller already knows it.

    Returns:
        ``(market, asset_class)`` with asset_class in
        ``equity | fund | index | other``.
    """
    if market is None:
        from backtest.engines._market_hooks import _detect_market

        market = _detect_market(str(symbol))
    code = str(symbol).upper()
    if _is_index_code(code):
        return market, ASSET_INDEX
    if _is_etf_listed(code):
        return market, ASSET_FUND
    if market in _EQUITY_MARKETS:
        return market, ASSET_EQUITY
    return market, ASSET_OTHER


def asset_rule(market: str, asset_class: str) -> AssetRule:
    """Return the gate rule for one ``(market, asset_class)`` pair."""
    return _ASSET_RULES.get(asset_class, _ASSET_RULES[ASSET_OTHER])


def asset_classes_with(rule_attr: str) -> list[str]:
    """Return the asset classes whose gate rule has ``rule_attr`` set.

    The audit needs to phrase its questions in the same rule table the writer
    used, so "which assets must never hold a zero-volume row" is read from one
    place rather than restated as a literal list somewhere else.
    """
    return [name for name in ASSET_CLASSES if getattr(_ASSET_RULES[name], rule_attr)]


def canonical_units(market: str) -> CanonicalUnits:
    """Return the units the warehouse stores for *market* (``None`` = blocked)."""
    return _CANONICAL_UNITS.get(market, CanonicalUnits(volume_unit=None, amount_unit=None))


def storable_markets() -> list[str]:
    """Return the markets the gate can currently store, sorted.

    One volume unit is the whole question: :func:`_require_admissible` refuses
    any market with no canonical volume unit established, so "storable" and
    "unit-declared" are the same set. The read-side loader derives its
    ``markets``/``volume_units`` declarations from here rather than restating
    the list, so a new market becomes servable exactly when it becomes writable.
    """
    return sorted(market for market, units in _CANONICAL_UNITS.items() if units.volume_unit)


def declared_amount_unit(source: str, market: str) -> str | None:
    """Return the unit *source* delivers ``amount`` in for *market*, or ``None``.

    ``None`` means "nobody verified this yet": the column is stored as NULL
    rather than as a number that might be off by 1000x.
    """
    return _AMOUNT_UNITS.get((str(source), str(market)))


def empty_bars() -> pd.DataFrame:
    """Return an empty frame carrying the exact partition dtypes."""
    return pd.DataFrame(
        {
            "symbol": pd.Series(dtype="object"),
            "market": pd.Series(dtype="object"),
            "asset_class": pd.Series(dtype="object"),
            "session_date": pd.Series(dtype="datetime64[ns]"),
            **{col: pd.Series(dtype="float64") for col in ("open", "high", "low", "close", "volume", "amount", "adj_factor")},
            "source": pd.Series(dtype="object"),
        }
    )


def bar_duration(interval: str) -> pd.Timedelta:
    """Return one bar's length, used to decide whether a bar has closed.

    Raises:
        ValueError: ``interval`` is not of the ``<int><m|H|d>`` form the runner
            accepts.
    """
    match = _INTERVAL_RE.match(str(interval).strip())
    if not match:
        raise ValueError(f"unsupported interval {interval!r}")
    count, unit = int(match.group(1)), match.group(2).lower()
    if unit == "m":
        return pd.Timedelta(minutes=count)
    if unit == "h":
        return pd.Timedelta(hours=count)
    return pd.Timedelta(days=count)


def _naive_stamps(stamps: pd.Series) -> pd.Series:
    """Return *stamps* as naive UTC, the one meaning ``session_date`` carries.

    A tz-aware source is converted to UTC and then stripped, so a Shanghai
    15:00 print and a UTC 07:00 print key the same partition instead of landing
    in two files whose names disagree about the day.
    """
    out = pd.to_datetime(stamps, errors="coerce")
    if getattr(out.dtype, "tz", None) is not None:
        out = out.dt.tz_convert("UTC").dt.tz_localize(None)
    return out


def _extract_stamps(frame: pd.DataFrame) -> pd.Series:
    """Return the row timestamps, from the index or a recognized column.

    A ``MultiIndex`` is only accepted when one of its levels is *named* like a
    session stamp: guessing from "this level happens to hold dates" would key
    bars on whichever column a merge happened to put second.
    """
    index = frame.index
    if isinstance(index, pd.DatetimeIndex):
        return _naive_stamps(pd.Series(index, index=index))
    if isinstance(index, pd.MultiIndex):
        for candidate in _TIME_COLUMN_CANDIDATES:
            if candidate in index.names:
                return _naive_stamps(pd.Series(index.get_level_values(candidate), index=index))
    for candidate in _TIME_COLUMN_CANDIDATES:
        if candidate in frame.columns:
            return _naive_stamps(pd.Series(frame[candidate], index=index))
    raise WarehouseConfigError(
        "no timestamp column to key bars on; expected a DatetimeIndex, a MultiIndex "
        f"level, or one of {list(_TIME_COLUMN_CANDIDATES)}"
    )


def _count_dropped(report: RejectReport, mask: pd.Series, stamps: pd.Series, reason: str, *, pending: bool) -> None:
    count = int(mask.sum())
    if not count:
        return
    report.dropped[reason] = report.dropped.get(reason, 0) + count
    if pending:
        for stamp in stamps[mask]:
            day = str(pd.Timestamp(stamp).date())
            if day not in report.pending_dates:
                report.pending_dates.append(day)
        report.pending_dates.sort()


def normalize_bars(
    frame: pd.DataFrame,
    *,
    symbol: str,
    interval: str,
    source: str,
    volume_unit: str | None = None,
    amount_unit: str | None = None,
    market: str | None = None,
    now: pd.Timestamp | None = None,
) -> tuple[pd.DataFrame, RejectReport]:
    """Gate one source frame into partition-ready rows.

    Args:
        frame: Source rows — a DatetimeIndex (or a date column) plus
            ``open/high/low/close`` and optional ``volume``/``amount``/
            ``adj_factor``. Prices must be *unadjusted*.
        symbol: Project-format ticker.
        interval: Bar interval; decides the closed-bar cutoff and the partition
            grain used by the caller.
        source: Loader name recorded on every row.
        volume_unit: Unit the source delivers ``volume`` in (the loader's own
            ``volume_units`` declaration for this market).
        amount_unit: Unit the source delivers ``amount`` in.
        market: Pre-computed market for *symbol*.
        now: Reference clock for the closed-bar test, expressed in the same
            clock the source stamps use (naive). Callers that know the exchange
            timezone should pass it; the default is the current UTC time.

    Returns:
        ``(bars, report)`` where ``bars`` has exactly :data:`BAR_COLUMNS`, is
        sorted by ``session_date`` and de-duplicated, and ``report`` explains
        what was thrown away. ``bars`` may be empty.

    Raises:
        WarehouseConfigError: The (source, market) pair cannot be stored
            correctly — no canonical unit established, or an asset needing
            factors supplied without an ``adj_factor`` column.
    """
    report = RejectReport(rows_in=int(len(frame)))
    if frame is None or len(frame) == 0:
        return empty_bars(), report

    market, asset_class = classify_asset(symbol, market)
    rule = asset_rule(market, asset_class)
    units = canonical_units(market)
    _require_admissible(
        source=source,
        market=market,
        asset_class=asset_class,
        rule=rule,
        units=units,
        frame=frame,
        report=report,
    )

    work = frame.copy()
    absent = [col for col in _PRICE_COLUMNS if col not in work.columns]
    if absent:
        raise WarehouseConfigError(
            f"{source!r} returned bars without {absent}; the warehouse stores raw OHLC "
            "plus volume, not whatever subset an endpoint happened to include"
        )
    stamps = _extract_stamps(work)
    work = work.loc[:, [c for c in work.columns if c not in _TIME_COLUMN_CANDIDATES]]
    work = work.loc[:, ~work.columns.duplicated()]
    work["session_date"] = stamps.reindex(work.index)

    for col in _PRICE_COLUMNS:
        work[col] = pd.to_numeric(work[col], errors="coerce")
    for col in ("volume", "amount", "adj_factor"):
        work[col] = (
            pd.to_numeric(work[col], errors="coerce")
            if col in work.columns
            else pd.Series(float("nan"), index=work.index)
        )

    missing_prices = work[list(_PRICE_COLUMNS)].isna().any(axis=1)
    _count_dropped(report, missing_prices, work["session_date"], "missing_ohlc", pending=False)
    work = work[~missing_prices]
    if work.empty:
        return empty_bars(), report

    # Canonical loader-boundary OHLC check, shared with every online source.
    before = len(work)
    work = validate_ohlc(work, strategy="drop")
    if len(work) < before:
        report.dropped["ohlc_invariant"] = report.dropped.get("ohlc_invariant", 0) + (before - len(work))
    if work.empty:
        return empty_bars(), report

    # Rule 1: the adjustment factor must be present per bar for an asset that
    # carries corporate actions. Absent rows are recorded as *pending* so the
    # next sync retries them rather than treating them as a halt.
    if rule.adjust_applicable:
        factor_bad = work["adj_factor"].isna() | (work["adj_factor"] <= 0)
        _count_dropped(report, factor_bad, work["session_date"], "missing_adj_factor", pending=True)
        work = work[~factor_bad]
        if work.empty:
            return empty_bars(), report

    # Rule 2: zero volume is a non-session, never a placeholder row. A NULL
    # volume is counted under its own reason first: "the source never said it
    # traded" and "it printed zero on a halted day" are different findings for
    # the audit even though neither may be stored.
    missing_volume = work["volume"].isna()
    _count_dropped(report, missing_volume, work["session_date"], "missing_volume", pending=False)
    work = work[~missing_volume]
    if work.empty:
        return empty_bars(), report

    if rule.drop_zero_volume:
        zero_volume = work["volume"] <= 0
        _count_dropped(report, zero_volume, work["session_date"], "zero_volume", pending=False)
        work = work[~zero_volume]
        if work.empty:
            return empty_bars(), report

    # Rule 3: units.
    work["volume"] = _reconcile(
        work["volume"], volume_unit, units.volume_unit, symbol=symbol, column="volume", report=report
    )
    work["amount"] = _reconcile_amount(
        work["amount"], amount_unit, units.amount_unit, symbol=symbol, report=report
    )

    # Bar-closure gate: a partial bar written today is a permanent poison pill,
    # because appends never revisit an in-progress session's *source*.
    reference = now if now is not None else pd.Timestamp.now(tz="UTC").tz_localize(None)
    cutoff = pd.Timestamp(reference) - bar_duration(interval)
    unsealed = work["session_date"] > cutoff
    _count_dropped(report, unsealed, work["session_date"], "bar_not_closed", pending=False)
    work = work[~unsealed]
    if work.empty:
        return empty_bars(), report

    work = work.sort_values("session_date")
    duplicates = work["session_date"].duplicated(keep="last")
    _count_dropped(report, duplicates, work["session_date"], "duplicate_session", pending=False)
    work = work[~duplicates]

    work["symbol"] = str(symbol)
    work["market"] = market
    work["asset_class"] = asset_class
    work["source"] = str(source)
    work["session_date"] = pd.to_datetime(work["session_date"], errors="coerce").astype("datetime64[ns]")
    for col in _FLOAT_COLUMNS:
        work[col] = work[col].astype("float64")

    bars = work[list(BAR_COLUMNS)].reset_index(drop=True)
    report.rows_out = int(len(bars))
    return bars, report


def _require_admissible(
    *,
    source: str,
    market: str,
    asset_class: str,
    rule: AssetRule,
    units: CanonicalUnits,
    frame: pd.DataFrame,
    report: RejectReport,
) -> None:
    """Refuse to store a (source, market) pair that cannot be represented.

    Failing loudly here is the point: a guessed unit or an unadjusted price
    series stored as if it were adjusted both surface as plausible-looking
    numbers years later, with no error to trace.
    """
    if units.volume_unit is None:
        raise WarehouseConfigError(
            f"market {market!r} has no canonical volume unit established; refusing to "
            f"store {source!r} bars. Add it to _CANONICAL_UNITS once the unit is "
            "empirically verified (see HKUDS/Vibe-Trading#1062)."
        )
    if rule.adjust_applicable and "adj_factor" not in frame.columns:
        raise WarehouseConfigError(
            f"{source!r} delivers {asset_class} bars for market {market!r} without an "
            "adj_factor column. A source that only offers window-anchored adjusted "
            "prices (e.g. baostock's adjustflag='2') cannot feed the warehouse: the "
            "stored series would be silently re-anchored by the next dividend. Use a "
            "source that exposes raw prices plus the factor series (tushare via "
            "fetch_raw_with_factor)."
        )


def _reconcile(
    series: pd.Series,
    declared: str | None,
    target: str | None,
    *,
    symbol: str,
    column: str,
    report: RejectReport,
) -> pd.Series:
    """Convert *series* to the canonical unit, or refuse the write."""
    if target is None:  # optional column with no canonical unit: caller handles it
        return series
    if declared is None:
        raise WarehouseConfigError(
            f"{column} unit for {symbol!r} is undeclared by the source; refusing to "
            "store it. Declare the unit on the loader (its ``volume_units`` mapping, "
            "keyed by market name) after empirical verification."
        )
    if declared == target:
        return series
    factor = _UNIT_CONVERSIONS.get((declared, target))
    if factor is None:
        raise WarehouseConfigError(
            f"{column} unit {declared!r} cannot be converted to the canonical "
            f"{target!r} for {symbol!r}: no exact conversion rule exists. Refusing to "
            "store rather than mix units inside one partition."
        )
    report.note(f"{column}: converted {declared} -> {target} for {symbol}")
    return series * factor


def _reconcile_amount(
    series: pd.Series,
    declared: str | None,
    target: str | None,
    *,
    symbol: str,
    report: RejectReport,
) -> pd.Series:
    """Same contract as volume, except an unproven ``amount`` becomes NULL.

    ``amount`` is optional (the backtest never reads it; only the CN vwap
    derivation does), so nulling it is both safe and honest, whereas a
    1000x-scaled amount would pass silently.
    """
    if series.isna().all():
        return series
    if target is None or declared is None:
        report.note(f"amount nulled for {symbol}: unit not established for this source")
        return pd.Series(float("nan"), index=series.index)
    return _reconcile(series, declared, target, symbol=symbol, column="amount", report=report)


def factor_holes(bars: pd.DataFrame) -> pd.DatetimeIndex:
    """Return sessions whose adjustment factor is missing, for a written frame.

    Only the asset classes the gate requires a factor for are inspected: an
    index or a crypto partition legitimately stores ``adj_factor`` as NULL
    throughout, and calling that a hole would point the reader at rows that are
    exactly as intended. The question is read from the same rule table the
    writer used instead of being restated here.
    """
    if bars.empty or "adj_factor" not in bars.columns:
        return pd.DatetimeIndex([])
    work = bars
    if "asset_class" in bars.columns:
        needs_factor = set(asset_classes_with("adjust_applicable"))
        work = bars[bars["asset_class"].isin(needs_factor)]
    if work.empty:
        return pd.DatetimeIndex([])
    bad = work["adj_factor"].isna() | (work["adj_factor"] <= 0)
    return pd.DatetimeIndex(work.loc[bad, "session_date"])
