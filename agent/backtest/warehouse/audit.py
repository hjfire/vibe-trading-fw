"""Health self-check of the local warehouse: coverage, suspected halts, bad rows.

Reporting only. A partition is either written by the gated sync path or not at
all — an audit that "fixed" a file would create exactly the untraceable edit
this warehouse exists to avoid. Every finding carries the predicate that
produced it, so a suspicion can be confirmed by hand.

The halt detector is a heuristic and says so: the reference calendar is the
union of sessions *already stored for the same market*, which is how the
backtest engine itself defines a trading day (``engines/base.py:_align`` builds
the panel calendar as the union of the symbols it was given). That claims only
"peers traded and this name did not", never "the exchange was open", so a
whole-market data gap shows up as no gap at all. Absences outside a symbol's own
first/last stored session are excluded — a name that listed in 2019 is not
halted for the 2015-2018 window, and a delisted name is not halted after it
stopped trading.
"""

from __future__ import annotations

import json
import logging
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Iterable, Sequence

import pandas as pd

from backtest.loaders.base import _duckdb_sql_string
from backtest.warehouse import store
from backtest.warehouse.layout import (
    bars_dir,
    interval_glob,
    list_intervals,
    normalize_interval,
    partition_dir,
    partition_grain,
    warehouse_root,
)
from backtest.warehouse.schema import asset_classes_with, classify_asset

logger = logging.getLogger(__name__)

#: Reference sessions a name must miss before it is called a suspected halt. One
#: or two days are as often a partial backfill or a roster change as a halt.
MIN_GAP_SESSIONS = 3

#: ``code -> (severity, predicate)`` over one interval's stored rows. Each
#: predicate counts rows, so a hit always reads as "N rows on disk are
#: impossible" — the same invariants the write gate enforces, re-checked where
#: the data actually lives (a hand-edited or hand-copied partition is exactly
#: what this file cannot see any other way).
ROW_CHECKS: tuple[tuple[str, str, str], ...] = (
    (
        "missing_price",
        "error",
        "open IS NULL OR high IS NULL OR low IS NULL OR close IS NULL OR volume IS NULL",
    ),
    (
        # Mirrors ``loaders.base.validate_ohlc``: a bar the audit passes is a bar
        # the loader pipeline would also have passed.
        "ohlc_invariant",
        "error",
        "high < low OR high < open OR high < close OR low > open OR low > close",
    ),
    (
        "nonpositive_price",
        "error",
        "open <= 0 OR high <= 0 OR low <= 0 OR close <= 0",
    ),
    ("negative_volume", "error", "volume < 0"),
    ("bad_adj_factor", "error", "adj_factor IS NOT NULL AND adj_factor <= 0"),
    # A full day of slack: stored stamps are exchange-local and
    # ``current_timestamp`` casts to UTC, so a Friday close in Shanghai is
    # legitimately "ahead" of UTC by up to 13 hours. What this can still catch
    # is a bar from a year that has not happened — a wrong epoch, a fixture
    # copied in by hand, or a source stamping forward-dated rows.
    (
        "future_timestamp",
        "error",
        "session_date > CAST(current_timestamp AS TIMESTAMP) + INTERVAL '1 day'",
    ),
)


class WarehouseAuditError(RuntimeError):
    """The requested audit cannot be run (no such interval, unreadable root)."""


@dataclass
class Issue:
    """One finding. ``rows`` is the number of stored rows it applies to."""

    code: str
    severity: str
    rows: int = 0
    detail: str = ""

    @property
    def is_error(self) -> bool:
        return self.severity == "error"


@dataclass
class Coverage:
    """What one symbol has on disk."""

    symbol: str
    market: str
    asset_class: str
    first: str
    last: str
    rows: int
    sources: list[str] = field(default_factory=list)


@dataclass
class Gap:
    """A run of reference sessions one symbol has no bar for."""

    symbol: str
    market: str
    start: str
    end: str
    sessions: int
    #: The stored sessions on either side of the run, so the reader can tell a
    #: halt from a delisting without another query.
    neighbors: str = ""


@dataclass
class AuditReport:
    """Result of :func:`audit`."""

    interval: str
    root: str
    symbols: int = 0
    rows: int = 0
    first: str | None = None
    last: str | None = None
    partitions: int = 0
    coverage: list[Coverage] = field(default_factory=list)
    gaps: list[Gap] = field(default_factory=list)
    issues: list[Issue] = field(default_factory=list)

    @property
    def errors(self) -> list[Issue]:
        return [issue for issue in self.issues if issue.is_error]

    @property
    def warnings(self) -> list[Issue]:
        return [issue for issue in self.issues if issue.severity == "warn"]

    def is_clean(self) -> bool:
        """Whether any stored row is impossible.

        Suspected halts and thin coverage are deliberately not failures: a halt
        is a fact about the market, and a short history is a choice by the
        operator, not a defect.
        """
        return not self.errors

    def to_dict(self) -> dict[str, Any]:
        return {
            "interval": self.interval,
            "root": self.root,
            "symbols": self.symbols,
            "rows": self.rows,
            "first": self.first,
            "last": self.last,
            "partitions": self.partitions,
            "clean": self.is_clean(),
            "issues": [asdict(issue) for issue in self.issues],
            "gaps": [asdict(gap) for gap in self.gaps],
            "coverage": [asdict(row) for row in self.coverage],
        }

    def summary(self, *, max_rows: int = 12) -> str:
        """A CLI digest: totals, findings, suspected halts, thinnest coverage."""
        lines = [
            f"warehouse {self.interval} at {self.root}",
            f"  {self.symbols} symbol(s), {self.rows} row(s), {self.partitions} partition(s)"
            + (f" spanning {self.first}..{self.last}" if self.first else ""),
        ]
        if not self.issues:
            lines.append("  no row-level defects found")
        for issue in self.issues:
            lines.append(f"  [{issue.severity}] {issue.code}: {issue.rows} — {issue.detail}")
        if self.gaps:
            lines.append(
                f"  {len(self.gaps)} suspected halt window(s), heuristic "
                f"(>= {MIN_GAP_SESSIONS} missing reference session(s)):"
            )
            for gap in self.gaps[:max_rows]:
                lines.append(
                    f"    {gap.symbol}: {gap.sessions} session(s) missing {gap.start}..{gap.end} "
                    f"(between {gap.neighbors})"
                )
            if len(self.gaps) > max_rows:
                lines.append(f"    ... {len(self.gaps) - max_rows} more")
        if len(self.coverage) > max_rows:
            lines.append(f"  thinnest coverage of {len(self.coverage)} symbol(s):")
            for row in sorted(self.coverage, key=lambda item: item.rows)[:max_rows]:
                lines.append(f"    {row.symbol}: {row.rows} row(s) {row.first}..{row.last}")
        return "\n".join(lines)


# ---------------------------------------------------------------------------
# Query helpers
# ---------------------------------------------------------------------------


def _connect() -> Any:
    import duckdb

    return duckdb.connect(database=":memory:")


def _source(interval: str, root: Path | None) -> str:
    """Return the SQL ``FROM`` expression covering one stored interval."""
    return (
        f"read_parquet({_duckdb_sql_string(interval_glob(interval, root))}, "
        "hive_partitioning=0, union_by_name=1)"
    )


def _raise_unreadable(exc: BaseException, interval: str, root: Path | None) -> None:
    """Turn DuckDB's missing-file error into an actionable one, else re-raise."""
    text = str(exc)
    if "does not exist" in text or "No files found" in text:
        raise WarehouseAuditError(
            f"no {interval!r} bars stored under {bars_dir(root)}; run "
            f"'python -m backtest.warehouse sync' first"
        ) from exc
    raise WarehouseAuditError(f"warehouse audit of {interval!r} failed: {text}") from exc


def _quoted(values: Iterable[str]) -> str:
    return ", ".join(_duckdb_sql_string(str(value)) for value in values)


# ---------------------------------------------------------------------------
# Coverage and the reference calendar
# ---------------------------------------------------------------------------


def coverage(*, interval: str = "1D", root: Path | None = None) -> list[Coverage]:
    """Return one :class:`Coverage` row per stored symbol.

    Raises:
        WarehouseAuditError: The interval has no data or cannot be read.
    """
    con = _connect()
    try:
        try:
            rows = con.execute(
                "SELECT symbol, market, asset_class, min(session_date), max(session_date), "
                f"count(*), list(DISTINCT source) FROM {_source(interval, root)} "
                "GROUP BY symbol, market, asset_class ORDER BY symbol"
            ).fetchall()
        except Exception as exc:  # noqa: BLE001 - translated for the caller
            _raise_unreadable(exc, interval, root)
    finally:
        con.close()
    return [
        Coverage(
            symbol=str(row[0]),
            market=str(row[1]),
            asset_class=str(row[2]),
            first=pd.Timestamp(row[3]).date().isoformat(),
            last=pd.Timestamp(row[4]).date().isoformat(),
            rows=int(row[5]),
            sources=sorted(str(source) for source in (row[6] or [])),
        )
        for row in rows
    ]


def reference_calendar(
    market: str, *, interval: str = "1D", root: Path | None = None
) -> pd.DatetimeIndex:
    """Return the sessions stored for one *market*, sorted.

    This is the union of stored dates, not an exchange calendar: it makes no
    claim about when the exchange was open, only about which days somebody in
    the warehouse has a bar for.
    """
    return calendars_by_market(interval=interval, root=root).get(market, pd.DatetimeIndex([]))


def calendars_by_market(
    *, interval: str = "1D", root: Path | None = None
) -> dict[str, pd.DatetimeIndex]:
    """Return every market's reference calendar in one pass."""
    con = _connect()
    try:
        try:
            rows = con.execute(
                "SELECT market, session_date FROM ("
                f"SELECT DISTINCT market, session_date FROM {_source(interval, root)}) "
                "ORDER BY market, session_date"
            ).fetchall()
        except Exception as exc:  # noqa: BLE001
            _raise_unreadable(exc, interval, root)
    finally:
        con.close()
    out: dict[str, pd.DatetimeIndex] = {}
    for market, stamp in rows:
        out.setdefault(str(market), []).append(pd.Timestamp(stamp))
    return {market: pd.DatetimeIndex(dates) for market, dates in out.items()}


def halt_gaps(
    *,
    interval: str = "1D",
    root: Path | None = None,
    min_sessions: int = MIN_GAP_SESSIONS,
    symbols: Sequence[str] | None = None,
    calendars: dict[str, pd.DatetimeIndex] | None = None,
) -> list[Gap]:
    """Return runs of missing reference sessions inside each symbol's own span.

    Args:
        interval: Stored interval to inspect.
        root: Warehouse root override.
        min_sessions: Shortest run worth reporting.
        symbols: Restrict to these names (``None`` = everything stored).
        calendars: Pre-computed ``market -> calendar``; pass
            :func:`calendars_by_market` to audit many symbols without repeating
            the calendar query.

    Returns:
        Gaps sorted by symbol then start; empty when nothing is missing.
    """
    wanted = None if symbols is None else {str(symbol) for symbol in symbols}
    con = _connect()
    source = _source(interval, root)
    try:
        try:
            runs = con.execute(
                "WITH own AS (SELECT symbol, market, session_date FROM "
                f"{source} GROUP BY symbol, market, session_date), "
                "cal AS (SELECT market, session_date, row_number() OVER "
                "  (PARTITION BY market ORDER BY session_date) AS n FROM "
                f"  (SELECT DISTINCT market, session_date FROM {source})), "
                "spans AS (SELECT own.symbol, own.market, own.session_date, cal.n, "
                "  lag(cal.n) OVER (PARTITION BY own.symbol ORDER BY own.session_date) AS prev_n "
                "  FROM own JOIN cal ON own.market = cal.market "
                "  AND own.session_date = cal.session_date) "
                "SELECT symbol, market, prev_n + 1, n - 1, n - prev_n - 1 FROM spans "
                "WHERE prev_n IS NOT NULL AND n - prev_n - 1 >= ? ORDER BY symbol, prev_n",
                [int(min_sessions)],
            ).fetchall()
        except Exception as exc:  # noqa: BLE001
            _raise_unreadable(exc, interval, root)
    finally:
        con.close()
    owned = calendars if calendars is not None else {}
    gaps: list[Gap] = []
    for symbol, market, start_n, end_n, missing in runs:
        if wanted is not None and str(symbol) not in wanted:
            continue
        market = str(market)
        calendar = owned.get(market)
        if calendar is None:
            calendar = reference_calendar(market, interval=interval, root=root)
            owned[market] = calendar
        if calendar.empty:
            continue
        # ``row_number`` starts at 1; the positions either side of the run are
        # the stored sessions that bracket it, which is what a reader needs to
        # tell a halt from a delisting.
        first = calendar[int(start_n) - 2] if int(start_n) >= 2 else calendar[0]
        last = calendar[int(end_n)] if int(end_n) < len(calendar) else calendar[-1]
        gaps.append(
            Gap(
                symbol=str(symbol),
                market=market,
                start=calendar[int(start_n) - 1].date().isoformat(),
                end=calendar[int(end_n) - 1].date().isoformat(),
                sessions=int(missing),
                neighbors=f"{first.date().isoformat()} .. {last.date().isoformat()}",
            )
        )
    return gaps


# ---------------------------------------------------------------------------
# Row-level and file-level checks
# ---------------------------------------------------------------------------


def row_defects(*, interval: str = "1D", root: Path | None = None) -> list[Issue]:
    """Count stored rows that violate an invariant the write gate enforces.

    Returns:
        Issues for every predicate with at least one hit; empty means the stored
        rows are shaped the way the gate makes them.

    Raises:
        WarehouseAuditError: The interval has no data or cannot be read.
    """
    issues: list[Issue] = []
    source = _source(interval, root)
    con = _connect()
    try:
        for code, severity, predicate in ROW_CHECKS:
            try:
                count = int(con.execute(f"SELECT count(*) FROM {source} WHERE {predicate}").fetchone()[0])
            except Exception as exc:  # noqa: BLE001 - a failed check is not a passed check
                logger.warning("warehouse audit check %s failed: %s", code, exc)
                issues.append(
                    Issue(code=f"check_error:{code}", severity="warn", rows=0, detail=str(exc))
                )
                continue
            if count:
                issues.append(Issue(code=code, severity=severity, rows=count, detail=predicate))

        # A zero-volume row is how some sources spell "did not trade"; for an
        # asset the gate keeps clean it means something bypassed the write path.
        drop_zero = asset_classes_with("drop_zero_volume")
        needs_factor = asset_classes_with("adjust_applicable")
        pairs = [
            (
                "placeholder_row",
                "warn",
                f"volume = 0 AND asset_class IN ({_quoted(drop_zero)})" if drop_zero else None,
            ),
            (
                "factor_hole",
                "error",
                f"adj_factor IS NULL AND asset_class IN ({_quoted(needs_factor)})"
                if needs_factor
                else None,
            ),
        ]
        for code, severity, predicate in pairs:
            if predicate is None:
                continue
            count = int(con.execute(f"SELECT count(*) FROM {source} WHERE {predicate}").fetchone()[0])
            if count:
                issues.append(Issue(code=code, severity=severity, rows=count, detail=predicate))

        duplicated = int(
            con.execute(
                f"SELECT count(*) FROM (SELECT symbol, session_date, count(*) AS c FROM {source} "
                "GROUP BY symbol, session_date HAVING c > 1)"
            ).fetchone()[0]
        )
        if duplicated:
            issues.append(
                Issue(
                    code="duplicate_key",
                    severity="error",
                    rows=duplicated,
                    detail="(symbol, session_date) stored more than once, which doubles every read",
                )
            )
    except WarehouseAuditError:
        raise
    except Exception as exc:  # noqa: BLE001
        _raise_unreadable(exc, interval, root)
    finally:
        con.close()
    return issues


def misplaced_rows(*, root: Path | None = None) -> list[Issue]:
    """Report rows living in a partition their ``session_date`` disagrees with.

    The write path refuses this, so a hit means a file was edited or copied in
    by hand. Such a row is invisible to the merge that would repair it and
    duplicates on every read that spans both partitions.
    """
    issues: list[Issue] = []
    base = bars_dir(root)
    for path in sorted(base.glob("**/data.parquet")):
        keys = {
            part.split("=", 1)[0]: part.split("=", 1)[1]
            for part in path.parent.parts
            if "=" in part
        }
        interval = keys.get("interval")
        if not interval:
            issues.append(
                Issue(
                    code="orphan_partition",
                    severity="error",
                    rows=0,
                    detail=f"{path.as_posix()} sits outside the interval=/year= tree",
                )
            )
            continue
        con = _connect()
        try:
            stamp_row = con.execute(
                "SELECT min(session_date), max(session_date), count(*) FROM read_parquet("
                f"{_duckdb_sql_string(path.as_posix())}, hive_partitioning=0)"
            ).fetchone()
        except Exception as exc:  # noqa: BLE001 - an unreadable file is a finding
            con.close()
            issues.append(
                Issue(
                    code="unreadable_partition",
                    severity="error",
                    rows=0,
                    detail=f"{path.as_posix()}: {exc}",
                )
            )
            continue
        con.close()
        if not stamp_row or not stamp_row[2]:
            issues.append(
                Issue(code="empty_partition", severity="warn", rows=0, detail=path.as_posix())
            )
            continue
        low, high = pd.Timestamp(stamp_row[0]), pd.Timestamp(stamp_row[1])
        named = partition_dir(interval, low, root)
        if named != path.parent:
            issues.append(
                Issue(
                    code="misplaced_partition",
                    severity="error",
                    rows=int(stamp_row[2]),
                    detail=f"{path.as_posix()} holds a {low.date()} bar; that belongs in {named.as_posix()}",
                )
            )
        elif partition_dir(interval, high, root) != path.parent:
            issues.append(
                Issue(
                    code="partition_spans_period",
                    severity="error",
                    rows=int(stamp_row[2]),
                    detail=(
                        f"{path.as_posix()} ({partition_grain(interval)} grain) holds "
                        f"{low.date()}..{high.date()}"
                    ),
                )
            )
    return issues


def manifest_gaps(*, interval: str = "1D", root: Path | None = None) -> list[Issue]:
    """Compare ``_manifest.json`` with what is actually on disk.

    Unit provenance is what a reader trusts to interpret a column, so a stored
    market with no manifest declaration is a warning even though the rows are
    internally consistent: nothing says which units they were normalized under.
    """
    issues: list[Issue] = []
    manifest = store.read_manifest(root)
    rows = coverage(interval=interval, root=root)
    if not rows:
        return issues
    declared = manifest.get("sources")
    declared = declared if isinstance(declared, dict) else {}
    if not declared:
        return [
            Issue(
                code="manifest_missing",
                severity="warn",
                rows=sum(row.rows for row in rows),
                detail="bars are stored with no source/unit provenance recorded",
            )
        ]
    known_markets = {
        str(market)
        for entry in declared.values()
        if isinstance(entry, dict)
        for market in entry.get("markets", [])
    }
    for market in sorted({row.market for row in rows} - known_markets):
        issues.append(
            Issue(
                code="undeclared_market",
                severity="warn",
                rows=sum(row.rows for row in rows if row.market == market),
                detail=f"market {market!r} is stored but no manifest source declares it",
            )
        )
    known_sources = {str(name) for name in declared}
    for row in rows:
        for source in row.sources:
            if source not in known_sources:
                issues.append(
                    Issue(
                        code="undeclared_source",
                        severity="warn",
                        rows=row.rows,
                        detail=(
                            f"{row.symbol} carries source {source!r}, absent from the "
                            "manifest provenance"
                        ),
                    )
                )
    return issues


def stale_pending_dates(
    *, interval: str = "1D", root: Path | None = None, older_than_days: int = 14
) -> list[Issue]:
    """Report factor holes the resume state still has open.

    A pending date is a promise that the next sync retries it. After a couple of
    weeks that promise has usually broken — the name is delisted, the source
    never published the factor, or the scope changed — and the hole has quietly
    become the permanent shape of the series.
    """
    issues: list[Issue] = []
    state_root = bars_dir(root).parent / "state" / f"interval={normalize_interval(interval)}"
    if not state_root.is_dir():
        return issues
    cutoff = pd.Timestamp.now(tz="UTC").tz_localize(None) - pd.Timedelta(days=older_than_days)
    for path in sorted(state_root.glob("scope-*.json")):
        try:
            payload = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            issues.append(
                Issue(code="unreadable_state", severity="warn", rows=0, detail=f"{path}: {exc}")
            )
            continue
        per_symbol = payload.get("per_symbol") if isinstance(payload, dict) else None
        if not isinstance(per_symbol, dict):
            continue
        for symbol, entry in sorted(per_symbol.items()):
            if not isinstance(entry, dict):
                continue
            pending = sorted(str(date) for date in entry.get("pending_dates", []) if date)
            waiting = [date for date in pending if pd.Timestamp(date) <= cutoff]
            if waiting:
                issues.append(
                    Issue(
                        code="stale_pending_date",
                        severity="warn",
                        rows=len(waiting),
                        detail=(
                            f"{symbol} has waited over {older_than_days} days for the "
                            f"adjustment factor of {waiting[0]}..{waiting[-1]}"
                        ),
                    )
                )
    return issues


# ---------------------------------------------------------------------------
# Assembly
# ---------------------------------------------------------------------------


def audit(
    *,
    interval: str = "1D",
    root: Path | None = None,
    min_sessions: int = MIN_GAP_SESSIONS,
    symbols: Sequence[str] | None = None,
    check_gaps: bool = True,
) -> AuditReport:
    """Run every check over one stored interval.

    Args:
        interval: Bar interval to audit.
        root: Warehouse root override.
        min_sessions: Shortest missing run reported as a suspected halt.
        symbols: Restrict the halt scan to these names. Coverage and row checks
            always describe the whole interval — they are per-file, not per-name.
        check_gaps: Set ``False`` to skip the halt scan.

    Returns:
        An :class:`AuditReport`.

    Raises:
        WarehouseAuditError: The interval has no data, or a file cannot be read.
    """
    target = root or warehouse_root()
    report = AuditReport(interval=str(interval), root=str(target))
    rows = coverage(interval=interval, root=target)
    report.coverage = rows
    report.symbols = len(rows)
    report.rows = sum(row.rows for row in rows)
    if rows:
        report.first = min(row.first for row in rows)
        report.last = max(row.last for row in rows)
    report.partitions = len(
        list(bars_dir(target).glob(f"interval={normalize_interval(interval)}/**/data.parquet"))
    )
    report.issues.extend(row_defects(interval=interval, root=target))
    report.issues.extend(misplaced_rows(root=target))
    report.issues.extend(manifest_gaps(interval=interval, root=target))
    report.issues.extend(stale_pending_dates(interval=interval, root=target))
    if check_gaps and rows:
        report.gaps = halt_gaps(
            interval=interval,
            root=target,
            min_sessions=min_sessions,
            symbols=symbols,
            calendars=calendars_by_market(interval=interval, root=target),
        )
    return report


def summarize_intervals(root: Path | None = None) -> list[dict[str, Any]]:
    """Return one inventory line per stored interval, for ``warehouse list``."""
    target = root or warehouse_root()
    out: list[dict[str, Any]] = []
    for interval in list_intervals(target):
        try:
            rows = coverage(interval=interval, root=target)
        except WarehouseAuditError as exc:
            logger.warning("warehouse inventory skipped %s: %s", interval, exc)
            continue
        files = list(bars_dir(target).glob(f"interval={interval}/**/data.parquet"))
        out.append(
            {
                "interval": interval,
                "grain": partition_grain(interval),
                "symbols": len(rows),
                "rows": sum(row.rows for row in rows),
                "first": min((row.first for row in rows), default=None),
                "last": max((row.last for row in rows), default=None),
                "markets": sorted({row.market for row in rows}),
                "asset_classes": sorted({row.asset_class for row in rows}),
                "sources": sorted({source for row in rows for source in row.sources}),
                "partitions": len(files),
                "bytes": sum(path.stat().st_size for path in files),
            }
        )
    return out


def markets_of(symbols: Iterable[str]) -> list[str]:
    """Return the markets a symbol list would touch, for scope-narrowed audits."""
    return sorted({classify_asset(symbol)[0] for symbol in symbols})
