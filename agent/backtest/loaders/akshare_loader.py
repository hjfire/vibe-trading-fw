"""AKShare loader: free, no-auth data for A-shares, US, HK, futures, forex, macro.

AKShare (https://github.com/akfamily/akshare) is a completely free financial
data aggregator covering Chinese and global markets.  No API token required.
"""

from __future__ import annotations

import logging
import re
from typing import Any, Dict, List, Optional

import pandas as pd

from backtest.engines._market_hooks import _detect_market, _is_china_futures
from backtest.loaders._symbol_utils import _is_etf_listed
from backtest.loaders.base import cached_loader_fetch, validate_date_range
from backtest.loaders.registry import register

logger = logging.getLogger(__name__)

_INTERVAL_MAP_DAILY = {
    "1D": "daily",
    "1d": "daily",
    "1W": "weekly",
    "1w": "weekly",
    "1M": "monthly",
}

# US/HK/ETF/forex serve daily bars only.
_DAILY_ONLY_ALIASES = frozenset({"1d", "d", "day", "daily"})


def _require_daily_interval(interval: str, market: str) -> None:
    if str(interval).strip().lower() not in _DAILY_ONLY_ALIASES:
        raise ValueError(
            f"Unsupported interval {interval!r}; akshare {market} supports daily bars only"
        )


def _is_a_share(code: str) -> bool:
    return code.upper().endswith((".SZ", ".SH", ".BJ"))


def _is_hk(code: str) -> bool:
    return code.upper().endswith(".HK")


def _is_us(code: str) -> bool:
    return code.upper().endswith(".US")


def _is_crypto(code: str) -> bool:
    return "-USDT" in code.upper() or "/USDT" in code.upper()


#: The local warehouse's A-share entry point. Sina is used rather than the
#: ``stock_zh_a_hist`` (Eastmoney push2) endpoint the online ``fetch`` walks
#: because push2 is blocked by this project's own residential proxy and Tencent's
#: kline host answers HTTP 501 under load, while Sina stayed reachable
#: (项目档案.md 坑⑧, re-confirmed 2026-09-13).
_SINA_DAILY_ALIASES = frozenset({"1d", "d", "day", "daily"})

#: Sina quotes daily ``volume`` in single shares. That is not a documentation
#: claim: ``stock_zh_a_daily`` computes ``turnover = volume /
#: (outstanding_share * 10000)`` on its own way out, and ``outstanding_share``
#: arrives in 万股 — a ratio of like units only if volume is shares. The
#: warehouse's canonical A-share unit is board lots, and ``volume_units`` is
#: declared per *source* rather than per endpoint, so the conversion belongs here
#: and not in the class attribute that ``fetch`` also relies on.
_SINA_SHARES_PER_LOT = 100.0


def _sina_stock_symbol(code: str) -> Optional[str]:
    """Return Sina's ``sh600519`` form for an A-share stock, or None.

    ETFs and Beijing-listed shares are refused on purpose: ``stock_zh_a_daily``
    is the Shanghai/Shenzhen equity feed, and handing it ``518880.SH`` would
    store a fund whose "adjustment factor" came from a stock table — a plausible
    number with no meaning, which is the failure this loader exists to catch.
    """
    if _is_etf_listed(code):
        return None
    symbol, _, suffix = code.upper().partition(".")
    if suffix not in {"SH", "SZ"} or not symbol.isdigit():
        return None
    return f"{suffix.lower()}{symbol}"


def _with_exchange_suffix(code: Any, exchange: Any) -> Optional[str]:
    """Turn a CSIndex constituent row into the warehouse's ``600519.SH`` form.

    The compiler's table carries a Chinese exchange name per row, which is
    authoritative; the code prefix is only a fallback for a table that omits it.
    A code that is not six digits is dropped rather than guessed at, because a
    wrong suffix here syncs a name that never existed in the index.
    """
    digits = str(code).strip().split(".")[0]
    if not digits.isdigit() or len(digits) != 6:
        return None
    text = str(exchange or "")
    if "上海" in text:
        suffix = "SH"
    elif "深圳" in text:
        suffix = "SZ"
    else:
        suffix = "SH" if digits[0] in {"6", "9"} else "SZ"
    return f"{digits}.{suffix}"


def _date_value_columns(frame: pd.DataFrame) -> tuple[str, str]:
    """Return ``(date column, value column)`` of a two-column vendor table.

    Detected by dtype and name rather than by position or literal: akshare builds
    the factor frame with ``reset_index()`` on an unnamed index, so the date
    column can come back named ``index``, ``dt`` or ``date`` depending on the
    release, and the value is ``hfq_factor`` or ``qfq_factor``.
    """
    date_col = next(
        (col for col in frame.columns if pd.api.types.is_datetime64_any_dtype(frame[col])),
        None,
    )
    value_col = next((col for col in frame.columns if "factor" in str(col).lower()), None)
    if date_col is None or value_col is None:
        raise ValueError(
            f"expected a dated factor table, got columns {list(frame.columns)!r}"
        )
    return str(date_col), str(value_col)


def _assert_cumulative(series: pd.Series, window: pd.DatetimeIndex | None = None) -> None:
    """Refuse a factor series that does not rise across corporate actions.

    ``store.read_bars(adjust="qfq")`` re-anchors on read as
    ``factor / factor_at_window_end``, which only pulls history *down* when the
    factor is a cumulative multiplier — Sina's ``hfq_factor``, applied by its own
    consumer as ``price * hfq_factor``. Sina's *qfq* factor is a divisor
    (``price / qfq_factor``) and falls over time; stored as-is it would scale
    every past bar up instead of down, and no row would ever look invalid.

    Args:
        series: The published ex-date -> factor table, sorted and de-duplicated.
        window: The sessions this sync is actually filling. When given, only the
            steps a stored bar can see are judged — see the note below.

    Note:
        Scoping to *window* is not a loosening, it is the question. A decrease is
        only a defect if a bar we are about to store reads a factor that fell; the
        single label before the window is kept as that window's baseline, and any
        earlier history belongs to a sync that will re-ask this guard for its own
        range. Judging the whole published life cost 000568.SZ its entire
        2016-2026 fill over one 0.38% dip in 2002 that no stored bar can see, and
        the refusal was not retryable. A real divisor still falls at every
        dividend inside any window long enough to contain one.
    """
    checked = series
    if window is not None and len(window):
        start = int(series.index.searchsorted(pd.Timestamp(window.min()), side="right"))
        end = int(series.index.searchsorted(pd.Timestamp(window.max()), side="right"))
        checked = series.iloc[max(start - 1, 0):end]
    steps = checked.diff().dropna()
    downs = steps[steps < -1e-9]
    if downs.empty:
        return
    stamp = downs.idxmin()
    raise ValueError(
        f"sina factor falls by {-float(downs.min()):.6g} at {stamp.date()} "
        f"({len(downs)} of {len(steps)} steps decrease in the synced window), so it "
        "is not a cumulative multiplier; refusing to store it under adj_factor"
    )


def _assert_share_basis(volume: pd.Series, amount: pd.Series, close: pd.Series) -> None:
    """Confirm Sina's volume is per share via the payoff identity.

    ``amount / (volume * close)`` is ~1.0 when volume and amount are both quoted
    per share and ~100.0 if volume were board lots. Measuring costs one division
    and catches the class of bug recorded as HKUDS/Vibe-Trading#1062 (akshare's
    own docs state shares for an endpoint that delivered lots); a silent 100x on
    volume survives into every vwap-derived factor.
    """
    usable = volume.gt(0) & amount.gt(0) & close.gt(0)
    if int(usable.sum()) < 5:
        return  # nothing measurable in this window; the declared unit stands
    ratio = float((amount[usable] / (volume[usable] * close[usable])).median())
    if not 0.2 <= ratio <= 5.0:
        raise ValueError(
            f"sina volume is not in shares (median amount/(volume*close) = "
            f"{ratio:.4g}); re-measure the unit before storing it "
            "(see HKUDS/Vibe-Trading#1062)"
        )


def _sina_bars(raw: pd.DataFrame) -> pd.DataFrame:
    """Turn Sina's unadjusted daily frame into warehouse bars.

    Prices stay as traded; ``volume`` is converted to the canonical board-lot
    unit; the index is a unique, sorted ``trade_date`` — the shape
    :func:`backtest.warehouse.sync._merge_factor` reindexes a factor onto.
    """
    frame = raw.copy()
    date_col = next((col for col in ("date", "trade_date") if col in frame.columns), None)
    if date_col is not None:
        stamps = pd.to_datetime(frame[date_col], errors="coerce")
    else:
        stamps = pd.to_datetime(pd.Series(frame.index, dtype="object"), errors="coerce")

    bars = pd.DataFrame(index=pd.DatetimeIndex(stamps.to_numpy()))
    for col in ("open", "high", "low", "close", "volume", "amount"):
        bars[col] = (
            pd.to_numeric(frame[col], errors="coerce").to_numpy()
            if col in frame.columns
            else float("nan")
        )

    bars = bars[bars.index.notna()]
    bars = bars[~bars.index.duplicated(keep="last")].sort_index()
    bars.index.name = "trade_date"

    volume = bars["volume"].fillna(0.0)
    _assert_share_basis(volume, bars["amount"], bars["close"])
    bars["volume"] = volume / _SINA_SHARES_PER_LOT
    return bars.dropna(subset=["open", "high", "low", "close"])


def _sina_factor(ak, symbol: str, axis: pd.DatetimeIndex) -> pd.DataFrame:
    """Expand Sina's sparse 后复权 factor table to one row per session in *axis*.

    The expansion is the loader's job, not the store's: ``_merge_factor`` aligns
    on exact stamps and leaves misses NaN, and the write gate reads a NaN factor
    as "this bar cannot be stored yet". A table carrying one row per ex-date
    would therefore refuse almost every session in the window.
    """
    table = ak.stock_zh_a_daily(symbol=symbol, adjust="hfq-factor")
    if table is None or table.empty:
        raise ValueError("sina published no adjustment-factor table")
    date_col, value_col = _date_value_columns(table)
    stamps = pd.DatetimeIndex(pd.to_datetime(table[date_col], errors="coerce").to_numpy())
    values = pd.to_numeric(table[value_col], errors="coerce").to_numpy()
    series = pd.Series(values, index=stamps).dropna().sort_index()
    series = series[~series.index.duplicated(keep="last")]
    if series.empty:
        raise ValueError("sina adjustment table carried no usable factors")
    _assert_cumulative(series, axis)
    # ``method="ffill"`` is the point, not an optimization: a plain reindex drops
    # every source label absent from the target, so a factor published years
    # before the window would leave the whole window empty and the gate would
    # refuse every bar. Labels *before* the first published factor stay NaN — a
    # back fill would quote a bar a factor the market had not issued yet, which
    # is the future-information leak store._adjust_qfq refuses on the read side.
    dense = series.reindex(axis, method="ffill")
    return pd.DataFrame({"trade_date": axis, "adj_factor": dense.to_numpy()})


#: Sina takes the bare contract code. Passing the exchange suffix through does
#: not return an empty frame — ``futures_zh_daily_sina("RB2601.SHFE")`` raises
#: ``ValueError: Length mismatch`` from inside akshare, so the suffix has to be
#: stripped here rather than discovered as a fetch failure.
def _sina_contract(code: str) -> str:
    """Return the bare uppercase contract code Sina's endpoints expect."""
    return code.split(".")[0].upper()


_CN_FUTURES_MAIN_RE = re.compile(r"^[A-Z]{1,2}0$")





def _is_forex(code: str) -> bool:
    """Detect forex pairs by matching against AKShare's symbol_market_map.

    Issue #54 — forex symbols (EURUSD, GBPUSD, etc.) have no exchange suffix
    and previously fell through to the A-share endpoint.
    """
    # Accept the canonical slash form (EUR/USD) too, so the forex fallback
    # chain (mt5 → akshare) actually engages for project-style codes.
    upper = code.upper().removesuffix(".FX").replace("/", "")
    try:
        from akshare.forex.cons import symbol_market_map
    except Exception:
        return False
    return upper in symbol_market_map


@register
class DataLoader:
    """AKShare universal OHLCV loader (free, no auth)."""

    name = "akshare"
    markets = {"a_share", "us_equity", "hk_equity", "futures", "fund", "macro", "forex"}
    # stock_zh_a_hist empirically returns board lots (HKUDS/Vibe-Trading#1062;
    # 600519.SH 2026-07-31 ratio 1.00 vs tencent/eastmoney). Note: akshare's
    # own documentation states shares for this interface — the docs disagree
    # with the actual behavior. Other markets stay undeclared.
    volume_units = {"a_share": "lots"}
    requires_auth = False

    def is_available(self) -> bool:
        """Available if akshare is installed."""
        try:
            import akshare  # noqa: F401
            return True
        except ImportError:
            return False

    def __init__(self) -> None:
        pass

    def fetch(
        self,
        codes: List[str],
        start_date: str,
        end_date: str,
        *,
        interval: str = "1D",
        fields: Optional[List[str]] = None,
    ) -> Dict[str, pd.DataFrame]:
        """Fetch OHLCV data via AKShare.

        Args:
            codes: Symbol list.
            start_date: YYYY-MM-DD.
            end_date: YYYY-MM-DD.
            interval: Bar size (only 1D supported currently).
            fields: Ignored.

        Returns:
            Mapping symbol -> OHLCV DataFrame.
        """
        validate_date_range(start_date, end_date)

        result: Dict[str, pd.DataFrame] = {}
        for code in codes:
            try:
                df = cached_loader_fetch(
                    source=self.name,
                    symbol=code,
                    timeframe=interval,
                    start_date=start_date,
                    end_date=end_date,
                    fields=None,
                    fetch=lambda code=code: self._fetch_one(code, start_date, end_date, interval),
                )
                if df is not None and not df.empty:
                    result[code] = df
            except Exception as exc:
                logger.warning("akshare failed for %s: %s", code, exc)
        return result

    def _fetch_one(
        self, code: str, start_date: str, end_date: str, interval: str,
    ) -> Optional[pd.DataFrame]:
        """Fetch a single symbol."""
        import akshare as ak

        # ETF check must precede A-share — 518880.SH ends with .SH but is an ETF.
        if _is_etf_listed(code):
            _require_daily_interval(interval, "etf")
            return self._fetch_etf(ak, code, start_date, end_date)
        if _is_a_share(code):
            return self._fetch_a_share(ak, code, start_date, end_date, interval)
        if _is_us(code):
            _require_daily_interval(interval, "us")
            return self._fetch_us(ak, code, start_date, end_date)
        if _is_hk(code):
            _require_daily_interval(interval, "hk")
            return self._fetch_hk(ak, code, start_date, end_date)
        if _is_forex(code):
            _require_daily_interval(interval, "forex")
            return self._fetch_forex(ak, code, start_date, end_date)
        if _is_china_futures(code):
            _require_daily_interval(interval, "futures")
            return self._fetch_china_futures(ak, code, start_date, end_date)
        if _detect_market(code) == "futures":
            # A futures contract Sina does not carry (CL2412.NYMEX, ESZ4).
            # Returning None hands the symbol to the next link in the chain;
            # letting it reach the A-share default below priced a USD-quoted
            # global contract off ``stock_zh_a_hist`` without erroring (#1395).
            logger.warning(
                "akshare serves Chinese futures only; %s has no akshare source", code
            )
            return None
        # Default: try A-share
        return self._fetch_a_share(ak, code, start_date, end_date, interval)

    def _fetch_a_share(
        self, ak, code: str, start_date: str, end_date: str, interval: str,
    ) -> Optional[pd.DataFrame]:
        """Fetch A-share via stock_zh_a_hist."""
        symbol = code.split(".")[0]
        period = _INTERVAL_MAP_DAILY.get(interval)
        if period is None:
            raise ValueError(
                f"Unsupported interval {interval!r}; akshare a-share supports "
                f"{sorted(_INTERVAL_MAP_DAILY)}"
            )
        sd = start_date.replace("-", "")
        ed = end_date.replace("-", "")
        df = ak.stock_zh_a_hist(
            symbol=symbol,
            period=period,
            start_date=sd,
            end_date=ed,
            adjust="qfq",
        )
        if df is None or df.empty:
            return None
        return self._normalize(df, date_col="日期")

    def _fetch_us(self, ak, code: str, start_date: str, end_date: str) -> Optional[pd.DataFrame]:
        """Fetch US stock via stock_us_hist."""
        symbol = code.replace(".US", "")
        # akshare uses the format like "105.AAPL" for NASDAQ
        # Try common prefixes
        for prefix in ["105.", "106.", ""]:
            try:
                df = ak.stock_us_hist(
                    symbol=f"{prefix}{symbol}",
                    period="daily",
                    start_date=start_date.replace("-", ""),
                    end_date=end_date.replace("-", ""),
                    adjust="qfq",
                )
                if df is not None and not df.empty:
                    return self._normalize(df, date_col="日期")
            except Exception:
                continue
        return None

    def _fetch_etf(self, ak, code: str, start_date: str, end_date: str) -> Optional[pd.DataFrame]:
        """Fetch exchange-listed ETF / LOF via fund_etf_hist_sina.

        Sina symbol format is ``sh518880`` / ``sz159915``. The endpoint returns
        the full history; we filter to the requested window after fetching.
        """
        digits, _, suffix = code.upper().partition(".")
        symbol = f"{suffix.lower()}{digits}"
        df = ak.fund_etf_hist_sina(symbol=symbol)
        if df is None or df.empty:
            return None
        df = self._normalize(df, date_col="date")
        # fund_etf_hist_sina returns full history — clip to window.
        return df.loc[start_date:end_date]

    def _fetch_forex(self, ak, code: str, start_date: str, end_date: str) -> Optional[pd.DataFrame]:
        """Fetch forex pair via forex_hist_em.

        Columns returned are 日期 / 代码 / 名称 / 今开 / 最新价 / 最高 / 最低 / 振幅
        — note ``最新价`` (latest) plays the role of close. Volume isn't reported,
        so we synthesize a zero column to satisfy the OHLCV contract.
        """
        symbol = code.upper().removesuffix(".FX").replace("/", "")
        df = ak.forex_hist_em(symbol=symbol)
        if df is None or df.empty:
            return None
        df = df.rename(columns={
            "日期": "trade_date",
            "今开": "open",
            "最新价": "close",
            "最高": "high",
            "最低": "low",
        })
        df["trade_date"] = pd.to_datetime(df["trade_date"])
        df = df.set_index("trade_date").sort_index()
        df["volume"] = 0.0
        for col in ("open", "high", "low", "close"):
            df[col] = pd.to_numeric(df[col], errors="coerce")
        df = df[["open", "high", "low", "close", "volume"]].dropna(
            subset=["open", "high", "low", "close"]
        )
        return df.loc[start_date:end_date]

    def _fetch_hk(self, ak, code: str, start_date: str, end_date: str) -> Optional[pd.DataFrame]:
        """Fetch HK stock via stock_hk_hist."""
        symbol = code.replace(".HK", "").zfill(5)
        df = ak.stock_hk_hist(
            symbol=symbol,
            period="daily",
            start_date=start_date.replace("-", ""),
            end_date=end_date.replace("-", ""),
            adjust="qfq",
        )
        if df is None or df.empty:
            return None
        return self._normalize(df, date_col="日期")

    def _fetch_china_futures(
        self, ak, code: str, start_date: str, end_date: str,
    ) -> Optional[pd.DataFrame]:
        """Fetch a Chinese futures contract from Sina's token-free endpoints.

        Two contract forms arrive here, and they use different endpoints with
        different payload shapes:

        * Dated (``RB2601``, ``IF2512.CFFEX``) -> ``futures_zh_daily_sina``,
          which takes *no* date range and serves the contract's whole life, so
          the requested window is applied here. Columns are already English.
        * Main continuous (``RB0``) -> ``futures_main_sina``, which does take a
          range and answers in Chinese column names carrying a ``价`` suffix
          (``开盘价``), distinct from the ``开盘`` spelling ``_normalize``
          knows from the equity endpoints.

        Args:
            ak: The imported ``akshare`` module.
            code: Contract code, with or without an exchange suffix.
            start_date: YYYY-MM-DD, inclusive.
            end_date: YYYY-MM-DD, inclusive.

        Returns:
            OHLCV frame indexed by trade date, or None when Sina carries no
            series for the contract.
        """
        symbol = _sina_contract(code)
        try:
            if _CN_FUTURES_MAIN_RE.match(symbol):
                raw = ak.futures_main_sina(
                    symbol=symbol,
                    start_date=start_date.replace("-", ""),
                    end_date=end_date.replace("-", ""),
                )
                if raw is None or raw.empty:
                    return None
                raw = raw.rename(columns={
                    "开盘价": "开盘", "最高价": "最高",
                    "最低价": "最低", "收盘价": "收盘",
                })
                return self._normalize(raw, date_col="日期")

            raw = ak.futures_zh_daily_sina(symbol=symbol)
        except Exception as exc:  # noqa: BLE001 - one bad contract must not raise
            # akshare raises rather than returning empty for a code Sina does
            # not list (a ZCE three-digit delivery month such as ``MA605``, or
            # a stray exchange suffix), so this is the not-found path too.
            logger.warning("akshare futures fetch failed for %s: %s", code, exc)
            return None

        if raw is None or raw.empty:
            return None
        df = self._normalize(raw, date_col="date")
        # The dated endpoint ignores the window, so slice it here; without this
        # a one-month request came back with the contract's entire history.
        return df.loc[str(start_date):str(end_date)]

    def fetch_raw_with_factor(
        self,
        codes: List[str],
        start_date: str,
        end_date: str,
        *,
        interval: str = "1D",
    ) -> Dict[str, tuple[pd.DataFrame, Optional[pd.DataFrame]]]:
        """Fetch **unadjusted** Sina daily bars plus Sina's own factor series.

        The local warehouse's entry point, mirroring
        :meth:`backtest.loaders.tushare.DataLoader.fetch_raw_with_factor` so
        ``warehouse.sync`` can hold either source to one contract: nothing here
        is adjusted, and unlike :meth:`fetch` this bypasses the per-request
        loader cache because the store *is* the durable cache.

        The factor comes from Sina as published data (``adjust="hfq-factor"``),
        not reverse-engineered from a ratio of the vendor's adjusted series — the
        route that failed for FutuOpenD, whose qfq is a constant *difference* so
        ``qfq/raw`` drifts on nearly every day and cannot be stored as a step
        factor. Sina's table is sparse (one row per ex-date), so it is expanded
        onto the sessions here with a forward fill only: back-filling would hand
        an early bar a factor that had not been published yet.

        Args:
            codes: Symbols, e.g. ``["600519.SH", "000001.SZ"]``.
            start_date: Start date (YYYY-MM-DD).
            end_date: End date (YYYY-MM-DD).
            interval: Only ``1D`` is supported.

        Returns:
            Mapping code -> ``(bars, factor)``. ``bars`` is indexed by
            ``trade_date`` with as-traded open/high/low/close, ``volume`` in
            board lots and ``amount`` in CNY; ``factor`` carries one row per bar
            ``(trade_date, adj_factor)`` or ``None`` when Sina's table could not
            be read — the write gate then refuses those rows and records them as
            pending rather than storing an unadjusted series.

        Raises:
            ValueError: ``interval`` is not a daily one.
        """
        validate_date_range(start_date, end_date)
        if str(interval).strip().lower() not in _SINA_DAILY_ALIASES:
            raise ValueError(
                f"fetch_raw_with_factor supports daily bars only, got interval={interval!r}"
            )

        import akshare as ak

        result: Dict[str, tuple[pd.DataFrame, Optional[pd.DataFrame]]] = {}
        for code in codes:
            try:
                pair = self._fetch_sina_raw_pair(ak, code, start_date, end_date)
            except Exception as exc:  # noqa: BLE001 - one bad symbol must not end the run
                logger.warning("failed to fetch %s: %s", code, exc)
                continue
            if pair is not None:
                result[code] = pair
        return result

    def _fetch_sina_raw_pair(
        self, ak, code: str, start_date: str, end_date: str
    ) -> Optional[tuple[pd.DataFrame, Optional[pd.DataFrame]]]:
        """Read one stock's unadjusted bars and its adjustment factors from Sina."""
        symbol = _sina_stock_symbol(code)
        if symbol is None:
            logger.warning(
                "akshare warehouse source serves SH/SZ stocks only; %s has no factor series here", code
            )
            return None

        sd = start_date.replace("-", "")
        ed = end_date.replace("-", "")
        raw = ak.stock_zh_a_daily(symbol=symbol, start_date=sd, end_date=ed, adjust="")
        if raw is None or raw.empty:
            logger.warning("sina returned no unadjusted daily bars for %s", code)
            return None
        bars = _sina_bars(raw)

        try:
            factor = _sina_factor(ak, symbol, bars.index)
        except Exception as exc:  # noqa: BLE001 - a missing factor is a hole, not a halt
            logger.warning("akshare adjustment-factor fetch failed for %s: %s", code, exc)
            factor = None
        return bars, factor

    #: Named rosters this source can name, mapped to the CSIndex table behind them.
    _UNIVERSE_INDEX_CODES = {"csi300": "000300"}

    #: A constituent table with fewer rows than this is a partial download, not
    #: a small index - syncing "csi300" as 40 names would be worse than failing.
    _MIN_ROSTER_NAMES = 200

    def fetch_universe_members(
        self, universe: str
    ) -> Optional[tuple[list[str], Optional[str]]]:
        """Today's members of a named index, from the compiler's own table.

        There is deliberately no point-in-time answer here: the compiler publishes
        the roster in force on *one* date, so a ten-year window filled from it holds
        today's members for all ten years. A caller must therefore leave the
        membership matrix empty, which makes the warehouse report such a panel as
        survivorship-biased rather than pretending the roster is historical.

        Args:
            universe: ``csi300`` only; any other name returns ``None`` so the
                caller gets to choose its own refusal message.

        Returns:
            ``(codes, snapshot_date)`` where codes carry the same ``.SH``/``.SZ``
            suffixes every other warehouse symbol uses, or ``None`` for a name
            this source cannot resolve.

        Raises:
            RuntimeError: The table came back empty or implausibly short.
        """
        index_code = self._UNIVERSE_INDEX_CODES.get(str(universe).strip().lower())
        if index_code is None:
            return None

        import akshare as ak

        frame = ak.index_stock_cons_csindex(symbol=index_code)
        if frame is None or frame.empty:
            raise RuntimeError(f"csindex returned no constituent rows for {index_code}")
        if "成分券代码" not in frame.columns:
            raise RuntimeError(
                f"csindex constituent table for {index_code} has no 成分券代码 column; "
                f"got {list(frame.columns)}"
            )

        codes = sorted(
            {
                suffixed
                for row in frame.to_dict("records")
                if (suffixed := _with_exchange_suffix(row.get("成分券代码"), row.get("交易所")))
            }
        )
        if len(codes) < self._MIN_ROSTER_NAMES:
            raise RuntimeError(
                f"csindex roster for {index_code} has {len(codes)} names, below the "
                f"{self._MIN_ROSTER_NAMES} floor - refusing to treat that as an index"
            )
        date_col = frame.get("日期")
        snapshot = str(date_col.iloc[0]) if date_col is not None and len(date_col) else None
        return codes, snapshot

    @staticmethod
    def _normalize(df: pd.DataFrame, date_col: str = "日期") -> pd.DataFrame:
        """Normalize AKShare DataFrame to standard OHLCV schema.

        AKShare Chinese column names: 日期, 开盘, 最高, 最低, 收盘, 成交量
        AKShare English column names: date, open, high, low, close, volume
        """
        col_map_cn = {"开盘": "open", "最高": "high", "最低": "low", "收盘": "close", "成交量": "volume"}
        col_map_en = {"date": "trade_date", "open": "open", "high": "high", "low": "low", "close": "close", "volume": "volume"}

        if date_col in df.columns:
            df = df.rename(columns={date_col: "trade_date"})
        elif "date" in df.columns:
            df = df.rename(columns={"date": "trade_date"})

        # Try Chinese column names first, then English
        if "开盘" in df.columns:
            df = df.rename(columns=col_map_cn)
        else:
            df = df.rename(columns=col_map_en)

        df["trade_date"] = pd.to_datetime(df["trade_date"])
        df = df.set_index("trade_date").sort_index()

        for col in ["open", "high", "low", "close", "volume"]:
            if col in df.columns:
                df[col] = pd.to_numeric(df[col], errors="coerce")

        ohlcv_cols = [c for c in ["open", "high", "low", "close", "volume"] if c in df.columns]
        df = df[ohlcv_cols].dropna(subset=["open", "high", "low", "close"])
        if "volume" not in df.columns:
            df["volume"] = 0.0
        return df
