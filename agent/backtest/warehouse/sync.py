"""Fill the warehouse: backfill, incremental update, and factor-hole repair.

The sync loop is deliberately boring — one symbol at a time, throttled, with
resume state on disk — because it runs against a rate-limited API and a mistake
is permanent: a partial bar or a factor-less row written into a yearly
partition will sit there until someone notices a hole years later.

Four window modes decide what gets fetched:

* **backfill** — the first run for a symbol, or an explicit ``--start``.
* **increment** — resume from the last stored session.
* **hole repair** — dates the write gate refused for a missing adjustment
  factor are recorded as ``pending_dates`` and pull the window start back to the
  earliest one.
* **re-anchor** — an explicit ``--start`` reaching further back than what is
  already stored; the read side re-anchors qfq levels per window anyway, so the
  extra history is additive and no old row is rewritten.

An increment rewinds ``SETTLING_DAYS`` on purpose. The sessions at the tail of a
pull are the ones whose factor may not be published yet (Tushare updates
``adj_factor`` after the session closes) and a bar without its factor is refused
by the gate, so re-requesting the tail is how it eventually lands. Re-writing a
session is safe: the partition merge keys on ``(symbol, session_date)``.
"""

from __future__ import annotations

import json
import logging
import os
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping

import pandas as pd

from backtest.warehouse import store
from backtest.warehouse.layout import atomic_replace, state_path, utc_now_iso
from backtest.warehouse.schema import classify_asset, declared_amount_unit, normalize_bars

logger = logging.getLogger(__name__)

DEFAULT_SOURCE = "tushare"
DEFAULT_INTERVAL = "1D"
DEFAULT_YEARS = 10

#: Requests per minute. Tushare's free tier documents ~200 calls/min for the
#: daily endpoints and this path issues two per symbol, so the default keeps a
#: 300-name universe to ~600 calls without hovering at the ceiling.
DEFAULT_PER_MINUTE = 150.0

#: Wall-clock budget for one run so a rate-limited API cannot hang a caller.
DEFAULT_BUDGET_S = 1800.0

#: Calendar days an increment rewinds, waiting for tail-session factors to be
#: published. Eight covers five trading sessions plus a weekend.
SETTLING_DAYS = 8

#: Backoff waits (seconds) after consecutive quota rejections. The configured
#: per-minute gap is widened on top of these, so a run that keeps hitting the
#: quota slows down instead of burning its budget on refused calls.
_RATE_PENALTY_STEPS: tuple[float, ...] = (30.0, 120.0, 300.0)

_GAP_WIDENING = 1.5

#: Per-symbol outcomes. ``planned`` appears only in a dry run; ``refused`` means
#: the source answered but the write gate rejected the whole frame (a unit or
#: caliber mismatch), which is a configuration problem, not a data problem.
STATUSES = ("planned", "ok", "empty", "failed", "refused")


class SyncConfigError(RuntimeError):
    """The requested sync cannot run (unknown source, no raw-factor support)."""


@dataclass
class SymbolSync:
    """What happened to one symbol in one run.

    Attributes:
        window_start/window_end: The span that was requested from the source.
        first/last: The span this run actually left on disk, which can be
            narrower — a tail session whose factor is unpublished is refused,
            so ``last`` stops before the requested end.
    """

    symbol: str
    mode: str
    window_start: str
    window_end: str
    status: str = "ok"
    first: str | None = None
    last: str | None = None
    rows_written: int = 0
    rows_added: int = 0
    dropped: dict[str, int] = field(default_factory=dict)
    pending_dates: list[str] = field(default_factory=list)
    rate_limited: bool = False
    error: str | None = None

    @property
    def covered(self) -> bool:
        """Whether this run extends or repairs the stored range."""
        return self.status == "ok"


@dataclass
class SyncReport:
    """Result of :func:`sync_symbols`."""

    source: str
    interval: str
    symbols: list[SymbolSync] = field(default_factory=list)
    rows_written: int = 0
    rows_added: int = 0
    partitions: int = 0
    throttled_s: float = 0.0
    stopped_reason: str | None = None
    notes: list[str] = field(default_factory=list)

    @property
    def failed(self) -> list[SymbolSync]:
        return [item for item in self.symbols if item.status in ("failed", "refused")]

    @property
    def pending_total(self) -> int:
        return sum(len(item.pending_dates) for item in self.symbols)

    def problems(self) -> list[str]:
        """Human-readable lines for everything that is not a clean outcome."""
        lines = list(self.notes)
        if self.stopped_reason:
            lines.append(f"stopped early: {self.stopped_reason}")
        for item in self.symbols:
            if item.status in ("failed", "refused"):
                lines.append(f"{item.symbol} [{item.status}]: {item.error}")
            elif item.pending_dates:
                lines.append(
                    f"{item.symbol}: {len(item.pending_dates)} session(s) waiting on an "
                    f"adjustment factor ({', '.join(item.pending_dates[:3])}"
                    f"{' ...' if len(item.pending_dates) > 3 else ''})"
                )
        return lines

    def to_dict(self) -> dict[str, Any]:
        return {
            "source": self.source,
            "interval": self.interval,
            "rows_written": self.rows_written,
            "rows_added": self.rows_added,
            "partitions": self.partitions,
            "throttled_s": round(self.throttled_s, 3),
            "stopped_reason": self.stopped_reason,
            "notes": list(self.notes),
            "symbols": [asdict(item) for item in self.symbols],
        }

    def summary(self) -> str:
        """A short digest for the CLI."""
        lines = [
            f"{self.source}/{self.interval}: {len(self.symbols)} symbol(s), "
            f"{self.rows_written} row(s) written ({self.rows_added} new) into "
            f"{self.partitions} partition(s)"
        ]
        if self.pending_total:
            lines.append(
                f"  {self.pending_total} session(s) still waiting on an adjustment factor"
            )
        if self.failed:
            lines.append(f"  {len(self.failed)} symbol(s) failed or were refused")
        if self.throttled_s:
            lines.append(f"  {self.throttled_s:.0f}s spent waiting on the rate limit")
        if self.stopped_reason:
            lines.append(f"  stopped early: {self.stopped_reason} (re-run to continue)")
        return "\n".join(lines)


class Throttle:
    """Minimum spacing between requests, widened after a quota rejection."""

    def __init__(
        self,
        per_minute: float,
        *,
        sleeper: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        """Build a gap-based limiter.

        Args:
            per_minute: Request ceiling.
            sleeper: Injection point for tests, called with each wait.
            clock: Injection point for tests, replacing ``time.monotonic``.
        """
        rate = float(per_minute)
        if rate <= 0:
            raise ValueError("per_minute must be positive")
        self._base_gap = 60.0 / rate
        self._gap = self._base_gap
        self._penalty = 0
        self._clock = clock
        self._sleep = sleeper
        self._last = clock()
        self.waited_s = 0.0

    def wait(self) -> None:
        """Block until the next request is due."""
        delay = self._last + self._gap - self._clock()
        if delay > 0:
            self._sleep(delay)
            self.waited_s += delay
        self._last = self._clock()

    def penalize(self) -> float:
        """Slow down after a quota rejection; return the wait that was used."""
        step = _RATE_PENALTY_STEPS[min(self._penalty, len(_RATE_PENALTY_STEPS) - 1)]
        self._penalty += 1
        self._gap = self._base_gap * (_GAP_WIDENING ** self._penalty)
        logger.warning(
            "warehouse: quota hit, waiting %.0fs (gap now %.2fs/request)", step, self._gap
        )
        self._sleep(step)
        self.waited_s += step
        return step

    def reward(self) -> None:
        """Creep back toward the configured rate after a request that was not refused."""
        if self._penalty:
            self._penalty -= 1
            self._gap = self._base_gap * (_GAP_WIDENING ** self._penalty)


# ---------------------------------------------------------------------------
# Source plumbing
# ---------------------------------------------------------------------------


def load_source(source: str = DEFAULT_SOURCE) -> Any:
    """Return a loader instance for *source*, with no silent fallback.

    Fallback is refused on purpose: the warehouse records which source delivered
    which rows, and quietly storing a different source's units or price caliber
    under ``tushare``'s name is exactly the mixing the manifest exists to catch.

    Raises:
        SyncConfigError: Unknown source, unavailable, or no raw-factor support.
    """
    from backtest.loaders.registry import LOADER_REGISTRY, _ensure_registered

    _ensure_registered()
    name = str(source).strip()
    if name not in LOADER_REGISTRY:
        raise SyncConfigError(
            f"unknown source {name!r} for the warehouse; expected one of "
            f"{sorted(LOADER_REGISTRY)}"
        )
    loader_cls = LOADER_REGISTRY[name]
    if not hasattr(loader_cls, "fetch_raw_with_factor"):
        raise SyncConfigError(
            f"source {name!r} cannot supply unadjusted prices plus an adjustment "
            "factor; only sources with fetch_raw_with_factor() may fill the "
            "warehouse, because a stored qfq series is re-anchored by the next dividend"
        )
    try:
        loader = loader_cls()
    except Exception as exc:  # noqa: BLE001 - construction reads credentials
        raise SyncConfigError(f"source {name!r} failed to initialize: {exc}") from exc
    if not loader.is_available():
        raise SyncConfigError(
            f"source {name!r} is unavailable (missing credentials or network)"
        )
    return loader


@dataclass
class UniverseRoster:
    """Which names a universe covered in a window, and *when* each belonged to it.

    Carrying the matrix alongside the name list is the point. ``codes`` alone is
    "every name that was ever a member", which is exactly the roster that
    smuggles survivorship bias into a cross-sectional panel: a name is present
    in the early years only because it survived to the end. The mask answers the
    question the panel actually needs — was it a member *on that date*.

    Attributes:
        universe: Requested name, normalized (``csi300``).
        codes: Every name that was a member at any point in the window.
        membership: date x symbol boolean matrix at roster-snapshot dates, or
            ``None`` when the roster could not be resolved (degraded path).
        constituent_source: Verbatim provenance, e.g. ``tushare index_weight``.
        constituent_source_date: Latest roster snapshot, if known.
    """

    universe: str
    codes: list[str]
    membership: pd.DataFrame | None
    constituent_source: str
    constituent_source_date: str | None = None

    @property
    def pit_membership(self) -> bool:
        """Whether the roster can date each name's membership."""
        return self.membership is not None

    def persist(self, *, root: Path | None = None, dry_run: bool = False) -> Path | None:
        """Write the roster into the warehouse; returns the path, or ``None``.

        Nothing is written on a dry run or when the matrix is missing — the
        absent file is what makes a later offline panel report itself as
        survivorship-biased rather than quietly using today's roster.
        """
        if dry_run:
            return None
        return store.write_universe_roster(
            self.universe,
            self.membership,
            constituent_source=self.constituent_source,
            constituent_source_date=self.constituent_source_date,
            root=root,
        )


def resolve_universe(
    universe: str, *, start: str, end: str, loader: Any
) -> UniverseRoster:
    """Expand a named universe into symbols plus its point-in-time roster.

    Args:
        universe: Currently ``csi300`` only; other names raise.
        start: Window start, ``YYYY-MM-DD``.
        end: Window end, ``YYYY-MM-DD``.
        loader: The source instance, used for its Tushare ``api`` client.

    Returns:
        A :class:`UniverseRoster`: the symbols that were index members at any
        point in the window, and the matrix saying which were members when.

    Raises:
        SyncConfigError: Unknown universe, or no client to ask.
    """
    key = str(universe).strip().lower()
    if key in {"csi300", "csi 300", "沪深300"}:
        api = getattr(loader, "api", None)
        if api is None:
            raise SyncConfigError(
                f"universe {universe!r} needs a source that exposes an index-weight "
                f"roster; {getattr(loader, 'name', '?')!r} does not"
            )
        from src.tools.alpha_bench_tool import _csi300_constituents

        codes, constituent_source, source_date, membership = _csi300_constituents(
            api, start, end
        )
        if constituent_source != "tushare index_weight":
            logger.warning(
                "warehouse: csi300 roster came from the %s list — the warehouse will "
                "hold those names, not the real index",
                constituent_source,
            )
        if membership is None:
            logger.warning(
                "warehouse: csi300 has no point-in-time membership from %s, so no roster "
                "is stored; a panel built from these names offline cannot mask ex-members "
                "and will report survivorship_bias=true",
                constituent_source,
            )
        return UniverseRoster(
            universe="csi300",
            codes=[str(code) for code in codes],
            membership=membership,
            constituent_source=constituent_source,
            constituent_source_date=source_date,
        )
    raise SyncConfigError(
        f"universe {universe!r} is not resolvable here; pass --symbols or use csi300"
    )


def _merge_factor(bars: pd.DataFrame, factor: pd.DataFrame | None) -> pd.DataFrame:
    """Return *bars* with an ``adj_factor`` column, leaving misses as NaN.

    Never raises: a factor frame shaped differently than expected is reported
    and ignored, which routes the symbol through the gate's missing-factor rule
    (refuse the rows, record them as pending) instead of failing the run.
    """
    if factor is None or getattr(factor, "empty", True):
        return bars
    columns = getattr(factor, "columns", ())
    if "adj_factor" not in columns or "trade_date" not in columns:
        logger.warning("warehouse: factor frame lacks trade_date/adj_factor; ignoring it")
        return bars
    try:
        stamps = pd.DatetimeIndex(pd.to_datetime(factor["trade_date"], errors="coerce"))
        # Built from arrays, not Series: ``pd.Series(series, index=other_series)``
        # aligns on labels, and aligning a 0..n factor index onto timestamps
        # resolves to nothing — every factor would read back as NaN and the gate
        # would report the whole history as one giant hole.
        values = pd.to_numeric(factor["adj_factor"], errors="coerce").to_numpy()
        series = pd.Series(values, index=stamps).dropna().sort_index()
        series = series[~series.index.duplicated(keep="last")]
        out = bars.copy()
        out["adj_factor"] = series.reindex(pd.DatetimeIndex(bars.index)).to_numpy()
        return out
    except Exception as exc:  # noqa: BLE001 - an unusable factor series is a hole
        logger.warning("warehouse: factor frame unusable (%s); ignoring it", exc)
        return bars


def _looks_like_quota(exc: BaseException) -> bool:
    """Whether an exception is a rate-limit rejection."""
    try:
        from backtest.loaders.tushare import _is_rate_limited

        return _is_rate_limited(exc)  # type: ignore[arg-type]
    except Exception:  # noqa: BLE001 - the marker table is best-effort
        text = str(exc).lower()
        return any(marker in text for marker in ("rate limit", "每分钟", "too many"))


# ---------------------------------------------------------------------------
# Resume state
# ---------------------------------------------------------------------------

#: State shape, one file per (interval, symbol-set) scope::
#:
#:     {"interval": "1D", "source": "tushare", "symbols": [...],
#:      "per_symbol": {"600519.SH": {"first": "2016-01-04", "last": "2026-09-11",
#:                                    "pending_dates": ["2026-09-10"],
#:                                    "failures": 0, "last_error": null,
#:                                    "empty_windows": 0, "updated_at": "..."}}}
#:
#: Row counts are deliberately absent: they can be recomputed from the
#: partitions, and a stale count that disagrees with the files is worse than no
#: count at all.


def read_state(
    symbols: Iterable[str], *, interval: str = DEFAULT_INTERVAL, root: Path | None = None
) -> dict[str, Any]:
    """Return the resume state for one sync scope, or a fresh skeleton."""
    state: dict[str, Any] = {"symbols": [], "per_symbol": {}}
    path = state_path(interval, [str(symbol) for symbol in symbols], root)
    if not path.is_file():
        return state
    try:
        loaded = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("warehouse state unreadable (%s): %s", path, exc)
        return state
    if not isinstance(loaded, dict):
        logger.warning("warehouse state is not an object (%s); starting fresh", path)
        return state
    if not isinstance(loaded.get("per_symbol"), dict):
        loaded["per_symbol"] = {}
    return loaded


def write_state(
    state: dict[str, Any],
    symbols: Iterable[str],
    *,
    interval: str = DEFAULT_INTERVAL,
    root: Path | None = None,
) -> Path:
    """Persist resume state for one scope; returns the path written."""
    path = state_path(interval, [str(symbol) for symbol in symbols], root)
    state["updated_at"] = utc_now_iso()
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    tmp.write_text(json.dumps(state, sort_keys=True, indent=2, default=str), encoding="utf-8")
    atomic_replace(tmp, path)
    return path


# ---------------------------------------------------------------------------
# Windows
# ---------------------------------------------------------------------------


def settled_end(*, today: pd.Timestamp | None = None) -> pd.Timestamp:
    """Return the last session whose bars can be complete (yesterday).

    Asking the source for today is what a partial bar starts as; the write gate
    drops it anyway, but not requesting it keeps the run card honest.
    """
    reference = _clock(today)
    return pd.Timestamp(reference).normalize() - pd.Timedelta(days=1)


def _clock(today: pd.Timestamp | None) -> pd.Timestamp:
    """Return the reference instant, injected by tests and schedulers."""
    if today is not None:
        return pd.Timestamp(today)
    return pd.Timestamp.now(tz="UTC").tz_localize(None)


def resolve_window(
    state_entry: dict[str, Any] | None,
    *,
    start: str | None,
    end: str | None,
    years: int,
    today: pd.Timestamp | None = None,
) -> tuple[str, str, str]:
    """Return ``(window_start, window_end, mode)`` for one symbol.

    Mode is ``backfill``, ``increment``, ``hole-repair``, ``re-anchor`` or
    ``current`` (nothing left to ask for, so the caller can skip the request).

    Raises:
        ValueError: ``years`` is not a positive number of years of history.
    """
    depth = int(years)
    if depth <= 0:
        raise ValueError(f"years must be positive, got {years!r}")
    entry = state_entry if isinstance(state_entry, dict) else {}
    last_stored = _as_timestamp(entry.get("last"))
    stop = settled_end(today=today)
    requested_end = _as_timestamp(end)
    if requested_end is not None:
        stop = min(requested_end, stop)
    pending = sorted(str(date) for date in entry.get("pending_dates", []) if date)

    if start:
        begin = pd.Timestamp(start)
        mode = "backfill"
        if last_stored is not None and begin < last_stored:
            mode = "re-anchor"
    elif last_stored is None:
        begin = stop - pd.Timedelta(days=365 * depth)
        mode = "backfill"
    elif last_stored >= stop and not pending:
        return stop.strftime("%Y-%m-%d"), stop.strftime("%Y-%m-%d"), "current"
    else:
        begin = last_stored - pd.Timedelta(days=SETTLING_DAYS)
        mode = "increment"

    if pending:
        earliest = _as_timestamp(pending[0])
        if earliest is not None and earliest < begin:
            begin = earliest
            if mode == "increment":
                mode = "hole-repair"
    return begin.strftime("%Y-%m-%d"), stop.strftime("%Y-%m-%d"), mode


def _as_timestamp(value: Any) -> pd.Timestamp | None:
    """Parse a stored date, treating anything unparseable as absent."""
    if value in (None, ""):
        return None
    try:
        return pd.Timestamp(value)
    except (ValueError, TypeError):
        logger.warning("warehouse state holds an unparseable date: %r", value)
        return None


def resume_entry(
    state_entry: Any, symbol: str, *, interval: str, root: Path | None
) -> dict[str, Any]:
    """Return the resume entry for one symbol, seeded from the partitions.

    State is keyed by the requested symbol set, so a roster that moves by one
    name — CSI 300 membership is revised monthly — lands in a scope with no
    entries and would otherwise re-backfill every symbol from scratch. The
    coverage question is answerable from disk, so it is answered from disk;
    state then keeps only what disk cannot tell us (pending factor holes, the
    failure count) and acts as a cache for the rest.
    """
    entry = dict(state_entry) if isinstance(state_entry, dict) else {}
    if _as_timestamp(entry.get("last")) is not None:
        return entry
    first, last, rows = store.symbol_range(symbol, interval=interval, root=root)
    if rows and first is not None and last is not None:
        entry["first"] = str(first.date())
        entry["last"] = str(last.date())
    return entry


# ---------------------------------------------------------------------------
# The loop
# ---------------------------------------------------------------------------


def sync_symbols(
    symbols: Iterable[str],
    *,
    source: str = DEFAULT_SOURCE,
    interval: str = DEFAULT_INTERVAL,
    start: str | None = None,
    end: str | None = None,
    years: int = DEFAULT_YEARS,
    root: Path | None = None,
    per_minute: float = DEFAULT_PER_MINUTE,
    budget_s: float = DEFAULT_BUDGET_S,
    dry_run: bool = False,
    loader: Any | None = None,
    progress: Callable[[str], None] | None = None,
    today: pd.Timestamp | None = None,
    sleeper: Callable[[float], None] = time.sleep,
    clock: Callable[[], float] = time.monotonic,
) -> SyncReport:
    """Fetch, gate, and store bars for *symbols*.

    Args:
        symbols: Project-format tickers.
        source: Loader name; must expose ``fetch_raw_with_factor``.
        interval: Bar interval (daily for now).
        start: Force a window start (``YYYY-MM-DD``); implies a backfill.
        end: Force a window end; always capped at the last settled session.
        years: History depth when nothing is stored yet.
        root: Warehouse root override.
        per_minute: Request-rate ceiling.
        budget_s: Wall-clock budget, after which the run stops resumably.
        dry_run: Plan and report without fetching or writing.
        loader: Pre-built source instance (tests inject a fake here).
        progress: One-line status callback for the CLI.
        today: Reference clock for the settled-end and closure gates.
        sleeper: Injection point for the throttle's waits.
        clock: Injection point for the budget and throttle clock.

    Returns:
        A :class:`SyncReport`. Per-symbol failures are recorded, not raised, so
        one bad ticker does not abandon the other 299.

    Raises:
        SyncConfigError: The source cannot be loaded, or another source already
            stores one of these markets in different units.
        WarehouseSchemaMismatch: The on-disk warehouse is newer than this build.
    """
    wanted = [str(symbol) for symbol in symbols if str(symbol).strip()]
    report = SyncReport(source=str(source), interval=str(interval))
    if not wanted:
        report.notes.append("no symbols requested")
        return report

    state = read_state(wanted, interval=interval, root=root)
    per_symbol_state = state["per_symbol"]
    state["interval"] = str(interval)
    state["source"] = str(source)
    state["symbols"] = sorted({str(symbol) for symbol in state.get("symbols", [])} | set(wanted))

    if loader is None and not dry_run:
        loader = load_source(source)
    volume_units = dict(getattr(loader, "volume_units", {}) or {}) if loader is not None else {}
    source_name = str(getattr(loader, "name", source) or source)
    plan = _units_for(wanted, source=source_name, volume_units=volume_units)
    if not dry_run:
        # Fail before spending a request: a newer on-disk schema or another
        # source's unit declaration means this run would write rows the reader
        # cannot interpret, and the damage is not reversible by re-syncing.
        conflicts = store.unit_conflicts(
            store.read_manifest(root), source=source_name, units_by_market=plan
        )
        if conflicts:
            raise SyncConfigError("; ".join(conflicts))
    throttle = Throttle(per_minute, sleeper=sleeper, clock=clock)
    deadline = clock() + float(budget_s)
    now = _clock(today)
    partitions: set[Path] = set()

    for index, symbol in enumerate(wanted):
        entry = resume_entry(
            per_symbol_state.get(symbol), symbol, interval=interval, root=root
        )
        window_start, window_end, mode = resolve_window(
            entry, start=start, end=end, years=years, today=today
        )
        if dry_run:
            item = SymbolSync(
                symbol=symbol,
                mode=mode,
                window_start=window_start,
                window_end=window_end,
                status="planned",
            )
        elif mode == "current":
            item = SymbolSync(
                symbol=symbol,
                mode=mode,
                window_start=window_start,
                window_end=window_end,
                status="empty",
            )
        elif clock() >= deadline:
            report.stopped_reason = (
                f"wall-clock budget of {budget_s:.0f}s exhausted with "
                f"{len(wanted) - index} symbol(s) left"
            )
            logger.warning(
                "warehouse: %s; state is saved, re-run to continue", report.stopped_reason
            )
            break
        else:
            item = _sync_one(
                symbol,
                loader=loader,
                source_name=source_name,
                interval=interval,
                window_start=window_start,
                window_end=window_end,
                mode=mode,
                volume_unit=volume_units.get(classify_asset(symbol)[0]),
                throttle=throttle,
                root=root,
                now=now,
                partitions=partitions,
            )
        _fold(report, item)
        if item.status != "planned":
            per_symbol_state[symbol] = _next_state_entry(per_symbol_state.get(symbol), item)
        if progress is not None:
            progress(
                f"{symbol} [{item.status}/{item.mode}]: "
                f"{item.rows_added} new, {item.rows_written} written"
                + (f", {len(item.pending_dates)} pending" if item.pending_dates else "")
            )

    report.partitions = len(partitions)
    report.throttled_s = throttle.waited_s
    if not dry_run:
        write_state(state, wanted, interval=interval, root=root)
        _record_manifest(report, source=source_name, plan=plan, root=root)
    return report


def _fold(report: SyncReport, item: SymbolSync) -> None:
    """Add one symbol's outcome to the run totals."""
    report.symbols.append(item)
    if item.status == "ok":
        report.rows_written += item.rows_written
        report.rows_added += item.rows_added


def _units_for(
    symbols: Iterable[str], *, source: str, volume_units: Mapping[str, Any]
) -> dict[str, tuple[str | None, str | None]]:
    """Return ``market -> (volume_unit, amount_unit)`` this run would store.

    Only the first symbol of a market decides, which is safe because both units
    are functions of ``(source, market)`` — not of the symbol.
    """
    plan: dict[str, tuple[str | None, str | None]] = {}
    for symbol in symbols:
        market = classify_asset(symbol)[0]
        if market not in plan:
            plan[market] = (volume_units.get(market), declared_amount_unit(source, market))
    return plan


def _record_manifest(
    report: SyncReport,
    *,
    source: str,
    plan: Mapping[str, tuple[str | None, str | None]],
    root: Path | None,
) -> None:
    """Record the units behind the markets whose rows were just written."""
    markets = sorted(
        {
            market
            for market in {
                classify_asset(item.symbol)[0] for item in report.symbols if item.covered
            }
            if market in plan
        }
    )
    if not markets:
        return
    try:
        for market in markets:
            volume_unit, amount_unit = plan[market]
            store.write_manifest(
                source=source,
                markets=[market],
                volume_unit=volume_unit,
                amount_unit=amount_unit,
                root=root,
            )
    except OSError as exc:  # the bars are already durable; only provenance is lost
        logger.warning("warehouse manifest not updated: %s", exc)
        report.notes.append(f"manifest write failed: {exc}")


def _sync_one(
    symbol: str,
    *,
    loader: Any,
    source_name: str,
    interval: str,
    window_start: str,
    window_end: str,
    mode: str,
    volume_unit: str | None,
    throttle: Throttle,
    root: Path | None,
    now: pd.Timestamp,
    partitions: set[Path],
) -> SymbolSync:
    """Fetch, gate, and store one symbol; never raises."""
    item = SymbolSync(
        symbol=symbol,
        mode=mode,
        window_start=window_start,
        window_end=window_end,
        status="ok",
    )
    try:
        throttle.wait()
        pairs = loader.fetch_raw_with_factor(
            [symbol], window_start, window_end, interval=interval
        )
        pair = (pairs or {}).get(symbol)
    except Exception as exc:  # noqa: BLE001 - classified just below
        item.status = "failed"
        item.error = f"{type(exc).__name__}: {exc}"
        if _looks_like_quota(exc):
            item.rate_limited = True
            throttle.penalize()
        logger.warning("warehouse: %s fetch failed: %s", symbol, exc)
        return item
    throttle.reward()

    bars, factor = pair if pair is not None else (None, None)
    if bars is None or bars.empty:
        item.status = "empty"
        return item

    try:
        normalized, gate = normalize_bars(
            _merge_factor(bars, factor),
            symbol=symbol,
            interval=interval,
            source=source_name,
            volume_unit=volume_unit,
            amount_unit=declared_amount_unit(source_name, classify_asset(symbol)[0]),
            now=now,
        )
    except Exception as exc:  # noqa: BLE001 - a refused source must not kill the run
        item.status = "refused"
        item.error = f"{type(exc).__name__}: {exc}"
        logger.warning("warehouse: %s refused — %s", symbol, exc)
        return item

    item.dropped = dict(gate.dropped)
    item.pending_dates = sorted(str(date) for date in gate.pending_dates)
    if normalized.empty:
        item.status = "empty"
        return item

    try:
        written = store.write_bars(normalized, interval=interval, root=root)
    except Exception as exc:  # noqa: BLE001 - a store failure is this symbol's problem
        item.status = "failed"
        item.error = f"store: {type(exc).__name__}: {exc}"
        logger.warning("warehouse: %s could not be stored: %s", symbol, exc)
        return item

    stamps = pd.to_datetime(normalized["session_date"])
    item.first = str(stamps.min().date())
    item.last = str(stamps.max().date())
    item.rows_written = int(len(normalized))
    item.rows_added = int(written.rows_added)
    partitions.update(written.paths)
    return item


def _next_state_entry(previous: Any, item: SymbolSync) -> dict[str, Any]:
    """Fold one symbol's outcome into its resume state."""
    entry = dict(previous) if isinstance(previous, dict) else {}
    if item.status in ("failed", "refused"):
        entry["failures"] = int(entry.get("failures", 0)) + 1
        entry["last_error"] = item.error
        entry["updated_at"] = utc_now_iso()
        return entry
    if item.status != "ok":
        entry["empty_windows"] = int(entry.get("empty_windows", 0)) + 1
        entry["updated_at"] = utc_now_iso()
        return entry

    stored_first = _as_timestamp(entry.get("first"))
    stored_last = _as_timestamp(entry.get("last"))
    firsts = [t for t in (stored_first, _as_timestamp(item.first)) if t is not None]
    lasts = [t for t in (stored_last, _as_timestamp(item.last)) if t is not None]
    # A hole inside the re-requested window is judged by this run's report;
    # holes outside it are still waiting to be reachable.
    requested = {
        str(stamp.date()) for stamp in pd.date_range(item.window_start, item.window_end)
    }
    pending = {
        str(date) for date in entry.get("pending_dates", []) if str(date) not in requested
    } | set(item.pending_dates)
    entry.update(
        {
            "first": str(min(firsts).date()),
            "last": str(max(lasts).date()),
            "pending_dates": sorted(pending),
            "failures": 0,
            "last_error": None,
            "updated_at": utc_now_iso(),
        }
    )
    return entry
