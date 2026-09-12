"""The audit: what it can prove about the files, and what it must never touch.

Two properties make this module worth having, and they pull in opposite
directions. It has to find the damage that the write gate cannot see — a
partition edited by hand, copied in from an older build, or left with a row in
the wrong year — and it has to be *harmless* while doing it. So every check here
is a read, and every finding carries the predicate that produced it so a human
can confirm it. A suspected halt is the sharpest edge: the reference calendar is
the union of sessions already stored for the same market, which is what the
backtest engine itself calls a trading day (``engines/base.py:_align`` builds
its grid from the symbols it was given). That justifies the claim "peers traded
and this name did not", and nothing stronger.

``TUSHARE_TOKEN`` is empty in this environment, so nothing here is verified
against the live endpoint; what is verified is the reading of files this test
suite writes itself, including files written on purpose behind the gate.
"""

from __future__ import annotations

import hashlib
import json
import shutil
from pathlib import Path
from typing import Any, Callable

import duckdb
import pandas as pd
import pytest

from backtest.loaders.base import _duckdb_sql_string
from backtest.warehouse import audit, store, sync
from backtest.warehouse.audit import (
    MIN_GAP_SESSIONS,
    AuditReport,
    WarehouseAuditError,
)
from backtest.warehouse.layout import (
    atomic_replace,
    bars_dir,
    partition_dir,
    partition_file,
    state_path,
)
from backtest.warehouse.schema import BAR_COLUMNS, normalize_bars

AUDIT_LOGGER = "backtest.warehouse.audit"

#: Ten Mon-Fri sessions, and a calendar to reason about positions in.
_SESSIONS = pd.bdate_range("2020-01-06", periods=10)
_PEER = "600000.SH"
_HALTED = "600519.SH"
_LATE = "600004.SH"
_INDEX = "000300.SH"


# ---------------------------------------------------------------------------
# Store builders
# ---------------------------------------------------------------------------


def _source_frame(
    index: pd.DatetimeIndex,
    *,
    close: float = 100.0,
    volume: float = 1000.0,
    factor: float = 1.0,
    with_factor: bool = True,
) -> pd.DataFrame:
    """Raw-shaped daily bars, the way a gated sync would hand them over."""
    frame = pd.DataFrame(
        {
            "open": [close] * len(index),
            "high": [close + 1.0] * len(index),
            "low": [close - 1.0] * len(index),
            "close": [close] * len(index),
            "volume": [volume] * len(index),
            "amount": [5000.0] * len(index),
        },
        index=index,
    )
    frame.index.name = "trade_date"
    if with_factor:
        frame["adj_factor"] = [factor] * len(index)
    return frame


def _write(
    root: Path,
    symbol: str,
    index: pd.DatetimeIndex,
    **kwargs: Any,
) -> store.WriteResult:
    """Push *index* through the real write gate into *root*."""
    bars, report = normalize_bars(
        _source_frame(index, **kwargs),
        symbol=symbol,
        interval="1D",
        source="tushare",
        volume_unit="lots",
        amount_unit="cny_thousand",
    )
    assert report.is_clean, f"the fixture must survive its own gate: {report.to_dict()}"
    return store.write_bars(bars, interval="1D", root=root)


def _partition(root: Path, symbol: str = _PEER, stamp: pd.Timestamp = _SESSIONS[0]) -> Path:
    return partition_file("1D", stamp, root)


def _rewrite(path: Path, mutate: Callable[[pd.DataFrame], pd.DataFrame]) -> pd.DataFrame:
    """Apply *mutate* to a stored partition, bypassing the write gate.

    This is the scenario the audit exists for: a file that did not come from the
    gated sync path. The store's own writer is used so the parquet shape stays
    realistic — only the values are wrong.
    """
    frame = mutate(store._read_partition(path).copy())
    store._write_partition(path, frame, interval="1D", root=path.parents[3])
    return frame


def _dump(path: Path, frame: pd.DataFrame) -> None:
    """Write *frame* to *path* with no membership check at all, like a copy."""
    path.parent.mkdir(parents=True, exist_ok=True)
    con = duckdb.connect(database=":memory:")
    tmp = path.with_name(f"{path.name}.hand-edited")
    try:
        con.register("hand_edited", frame.loc[:, list(BAR_COLUMNS)])
        con.execute(
            f"COPY (SELECT * FROM hand_edited) TO {_duckdb_sql_string(tmp)} (FORMAT PARQUET)"
        )
    finally:
        con.close()
    atomic_replace(tmp, path)


def _digests(root: Path) -> dict[str, str]:
    """Every file under *root*, hashed. The proof that an audit is read-only."""
    return {
        path.relative_to(root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
        for path in sorted(root.rglob("*"))
        if path.is_file()
    }


def _codes(issues: list[audit.Issue]) -> list[str]:
    return sorted(issue.code for issue in issues)


@pytest.fixture()
def halted_store(tmp_path: Path) -> Path:
    """A peer with the full calendar, one name halted 4 sessions, one listed late.

    ``600519.SH`` is missing 2020-01-09/10/13/14 (calendar positions 4-7) and
    ``600004.SH`` has only the last three sessions, so its absence before them
    is a listing date, not a halt.
    """
    _write(tmp_path, _PEER, _SESSIONS)
    _write(tmp_path, _HALTED, _SESSIONS[[0, 1, 2, 7, 8, 9]])
    _write(tmp_path, _LATE, _SESSIONS[-3:])
    return tmp_path


@pytest.fixture()
def clean_store(tmp_path: Path) -> Path:
    """One symbol, ten clean sessions, nothing suspicious about it."""
    _write(tmp_path, _PEER, _SESSIONS)
    return tmp_path


# ---------------------------------------------------------------------------
# Coverage and inventory
# ---------------------------------------------------------------------------


def test_coverage_describes_the_files(tmp_path: Path, halted_store: Path) -> None:
    rows = audit.coverage(root=halted_store)

    assert [row.symbol for row in rows] == [_PEER, _LATE, _HALTED], "ordered by symbol"
    peer = rows[0]
    assert (peer.first, peer.last, peer.rows) == ("2020-01-06", "2020-01-17", 10)
    assert (peer.market, peer.asset_class) == ("a_share", "equity")
    assert peer.sources == ["tushare"]
    assert [(row.rows, row.first) for row in rows[1:]] == [(3, "2020-01-15"), (6, "2020-01-06")]


def test_coverage_counts_minutes_and_days_as_separate_intervals(tmp_path: Path) -> None:
    _write(tmp_path, _PEER, _SESSIONS)
    minute = pd.DatetimeIndex(["2020-01-06 09:35", "2020-01-06 09:40"])
    bars, report = normalize_bars(
        _source_frame(minute),
        symbol=_PEER,
        interval="5m",
        source="tushare",
        volume_unit="lots",
        amount_unit="cny_thousand",
    )
    assert report.is_clean
    store.write_bars(bars, interval="5m", root=tmp_path)

    inventory = {line["interval"]: line for line in audit.summarize_intervals(tmp_path)}

    assert set(inventory) == {"1D", "5m"}
    assert inventory["1D"]["grain"] == "year" and inventory["1D"]["rows"] == 10
    assert inventory["5m"]["grain"] == "year,month" and inventory["5m"]["rows"] == 2
    assert inventory["1D"]["bytes"] > 0 and inventory["1D"]["partitions"] == 1
    assert inventory["1D"]["markets"] == ["a_share"]
    assert inventory["1D"]["asset_classes"] == ["equity"]
    assert inventory["1D"]["sources"] == ["tushare"]
    assert (inventory["1D"]["first"], inventory["1D"]["last"]) == (
        "2020-01-06",
        "2020-01-17",
    )


def test_an_unstored_interval_says_what_to_do(tmp_path: Path, clean_store: Path) -> None:
    with pytest.raises(WarehouseAuditError, match="no '30m' bars stored"):
        audit.coverage(interval="30m", root=clean_store)

    assert list(tmp_path.iterdir()), "the question was about an interval, not the root"


def test_markets_of_names_the_scopes_a_symbol_list_touches() -> None:
    assert audit.markets_of([_PEER, "AAPL.US", "BTC-USDT"]) == [
        "a_share",
        "crypto",
        "us_equity",
    ]


# ---------------------------------------------------------------------------
# The reference calendar
# ---------------------------------------------------------------------------


def test_the_reference_calendar_is_the_union_of_stored_days(
    tmp_path: Path, halted_store: Path
) -> None:
    """It claims which days somebody has a bar for, not when an exchange opened."""
    calendar = audit.reference_calendar("a_share", root=halted_store)

    assert list(calendar) == list(_SESSIONS), "the peer's days are the calendar"
    assert audit.reference_calendar("us_equity", root=halted_store).empty
    by_market = audit.calendars_by_market(root=halted_store)
    assert list(by_market) == ["a_share"]
    pd.testing.assert_index_equal(by_market["a_share"], calendar)


# ---------------------------------------------------------------------------
# Suspected halts (acceptance criterion 5b)
# ---------------------------------------------------------------------------


def test_a_name_missing_reference_sessions_is_reported_as_a_suspected_halt(
    tmp_path: Path, halted_store: Path
) -> None:
    gaps = audit.halt_gaps(root=halted_store)

    assert [(gap.symbol, gap.sessions) for gap in gaps] == [(_HALTED, 4)]
    gap = gaps[0]
    assert (gap.start, gap.end) == ("2020-01-09", "2020-01-14")
    assert gap.neighbors == "2020-01-08 .. 2020-01-15", "the stored days on either side"
    assert gap.market == "a_share"


def test_an_absence_shorter_than_the_threshold_is_not_called_a_halt(
    tmp_path: Path,
) -> None:
    _write(tmp_path, _PEER, _SESSIONS)
    _write(tmp_path, _HALTED, _SESSIONS.drop(_SESSIONS[3]))  # one session out

    assert audit.halt_gaps(root=tmp_path) == []
    assert len(audit.halt_gaps(root=tmp_path, min_sessions=1)) == 1, "the knob is honest"


def test_the_threshold_is_the_default_of_one_or_two_meaningless_absences(
    tmp_path: Path,
) -> None:
    _write(tmp_path, _PEER, _SESSIONS)
    _write(tmp_path, _HALTED, _SESSIONS[[0, 1, 4, 5, 6, 7, 8, 9]])  # 2 sessions out

    assert audit.halt_gaps(root=tmp_path) == [], MIN_GAP_SESSIONS
    assert [gap.sessions for gap in audit.halt_gaps(root=tmp_path, min_sessions=2)] == [2]


def test_days_before_a_name_has_any_bar_are_its_listing_date_not_a_halt(
    tmp_path: Path, halted_store: Path
) -> None:
    """``600004.SH`` stores only the last three sessions; it is not halted for 7."""
    gaps = audit.halt_gaps(root=halted_store, min_sessions=1)

    assert [gap.symbol for gap in gaps] == [_HALTED], "the late name reports no gap at all"


def test_a_day_no_symbol_traded_is_not_a_gap_in_anything(tmp_path: Path) -> None:
    """A whole-market absence is invisible to a calendar made of stored rows.

    This is the heuristic's honest limit, stated in the module docstring and
    pinned here: the union of two names that both lack 2020-01-09/10 contains no
    such day, so nothing looks missing. Pretending otherwise would need an
    exchange calendar the warehouse does not hold.
    """
    both_off = _SESSIONS[[0, 1, 2, 5, 6, 7, 8, 9]]
    _write(tmp_path, _PEER, both_off)
    _write(tmp_path, _HALTED, both_off)

    assert audit.halt_gaps(root=tmp_path, min_sessions=1) == []


def test_the_symbol_filter_and_the_precomputed_calendar_change_nothing(
    tmp_path: Path, halted_store: Path
) -> None:
    full = audit.halt_gaps(root=halted_store)
    calendars = audit.calendars_by_market(root=halted_store)

    assert audit.halt_gaps(root=halted_store, calendars=calendars) == full
    assert audit.halt_gaps(root=halted_store, symbols=[_PEER]) == []
    assert audit.halt_gaps(root=halted_store, symbols=[_HALTED]) == full


def test_an_index_is_held_to_the_same_shape_as_an_equity(tmp_path: Path) -> None:
    """The halt scan does not care about asset class; the row checks do."""
    _write(tmp_path, _INDEX, _SESSIONS)
    _write(tmp_path, "000905.SH", _SESSIONS[[0, 1, 5, 6, 7, 8, 9]])

    gaps = audit.halt_gaps(root=tmp_path)

    assert [(gap.symbol, gap.sessions, gap.start, gap.end) for gap in gaps] == [
        ("000905.SH", 3, "2020-01-08", "2020-01-10")
    ]


# ---------------------------------------------------------------------------
# Row-level defects
# ---------------------------------------------------------------------------


def test_a_gate_written_store_has_no_row_defects(tmp_path: Path, halted_store: Path) -> None:
    assert audit.row_defects(root=halted_store) == []


def test_the_store_holds_no_zero_volume_equity_row(tmp_path: Path) -> None:
    """The gate deletes those rows, so the audit never has to explain one."""
    _write(tmp_path, _PEER, _SESSIONS)
    bars, report = normalize_bars(
        _source_frame(_SESSIONS[[4]], volume=0.0),
        symbol=_PEER,
        interval="1D",
        source="tushare",
        volume_unit="lots",
        amount_unit="cny_thousand",
    )
    assert report.dropped == {"zero_volume": 1} and bars.empty

    assert store.write_bars(bars, interval="1D", root=tmp_path).rows_written == 0
    stored = store.read_bars([_PEER], start="2020-01-01", end="2020-01-31", root=tmp_path)
    assert len(stored[_PEER]) == 10 and (stored[_PEER]["volume"] > 0).all()
    assert audit.row_defects(root=tmp_path) == []


def test_an_index_printing_zero_volume_is_not_a_defect(tmp_path: Path) -> None:
    """A 0-volume index session is a fact about the index, not a broken row."""
    _write(tmp_path, _INDEX, _SESSIONS, volume=0.0)

    assert audit.row_defects(root=tmp_path) == []


def _set(column: str, value: Any) -> Callable[[pd.DataFrame], pd.DataFrame]:
    def mutate(frame: pd.DataFrame) -> pd.DataFrame:
        frame.loc[frame.index[0], column] = value
        return frame

    return mutate


def _flat_price(value: float) -> Callable[[pd.DataFrame], pd.DataFrame]:
    """Set all four prices at once, so only the sign check can fire."""

    def mutate(frame: pd.DataFrame) -> pd.DataFrame:
        for column in ("open", "high", "low", "close"):
            frame.loc[frame.index[0], column] = value
        return frame

    return mutate


def _duplicate_first(frame: pd.DataFrame) -> pd.DataFrame:
    return pd.concat([frame, frame.iloc[[0]]], ignore_index=True)


@pytest.mark.parametrize(
    "mutate, code, severity, rows",
    [
        (_set("close", None), "missing_price", "error", 1),
        (_set("volume", None), "missing_price", "error", 1),
        (_set("high", 1.0), "ohlc_invariant", "error", 1),
        (_flat_price(-1.0), "nonpositive_price", "error", 1),
        (_set("volume", -1.0), "negative_volume", "error", 1),
        (_set("adj_factor", 0.0), "bad_adj_factor", "error", 1),
        (_set("adj_factor", None), "factor_hole", "error", 1),
        (_set("volume", 0.0), "placeholder_row", "warn", 1),
        (_duplicate_first, "duplicate_key", "error", 1),
    ],
    ids=[
        "null close",
        "null volume",
        "high under low",
        "negative prices",
        "negative volume",
        "zero factor",
        "missing factor",
        "zero volume",
        "duplicate key",
    ],
)
def test_a_row_that_came_by_no_honest_route_is_named(
    tmp_path: Path, clean_store: Path, mutate, code: str, severity: str, rows: int
) -> None:
    path = _partition(clean_store)
    _rewrite(path, mutate)

    issues = audit.row_defects(root=clean_store)

    assert _codes(issues) == [code], "one check fires, and it is the one expected"
    assert (issues[0].severity, issues[0].rows) == (severity, rows)
    assert issues[0].detail, "every finding carries the predicate that produced it"


def test_two_bad_rows_are_counted_not_just_reported(tmp_path: Path, clean_store: Path) -> None:
    path = _partition(clean_store)

    def mutate(frame: pd.DataFrame) -> pd.DataFrame:
        for position in (0, 1):
            frame.loc[frame.index[position], "volume"] = None
        return frame

    _rewrite(path, mutate)

    issues = audit.row_defects(root=clean_store)

    assert [(issue.code, issue.rows) for issue in issues] == [("missing_price", 2)]


def test_a_row_dated_beyond_today_is_a_defect(tmp_path: Path, clean_store: Path) -> None:
    """The one check that cannot be about 2020: a stamp from a future epoch."""
    frame = store._read_partition(_partition(clean_store))
    late = frame.iloc[[0]].copy()
    stamp = pd.Timestamp.now().normalize() + pd.Timedelta(days=40)
    late["session_date"] = stamp

    _dump(_partition(clean_store, stamp=stamp), late)

    issues = audit.row_defects(root=clean_store)
    assert [issue.code for issue in issues] == ["future_timestamp"]
    assert issues[0].rows == 1


def test_unreadable_data_is_never_reported_as_healthy(tmp_path: Path) -> None:
    """A store that cannot be read must not come back clean.

    The check-by-check fallback (``check_error:<code>``) exists for a predicate
    that fails while its neighbours succeed, but a wholesale unreadable store is
    a raised error, so no caller can mistake it for "0 defects".
    """
    (tmp_path / "bars" / "interval=1D" / "year=2020").mkdir(parents=True)
    path = tmp_path / "bars" / "interval=1D" / "year=2020" / "data.parquet"
    path.write_bytes(b"not a parquet file")

    with pytest.raises(WarehouseAuditError):
        audit.row_defects(root=tmp_path)
    with pytest.raises(WarehouseAuditError):
        audit.coverage(root=tmp_path)

    direct = audit.misplaced_rows(root=tmp_path)
    assert _codes(direct) == ["unreadable_partition"], "the per-file scan still names it"


# ---------------------------------------------------------------------------
# File placement
# ---------------------------------------------------------------------------


def test_well_placed_rows_are_not_reported(tmp_path: Path, clean_store: Path) -> None:
    assert audit.misplaced_rows(root=clean_store) == []


def test_a_copied_partition_in_the_wrong_year_is_named(tmp_path: Path, clean_store: Path) -> None:
    """A hand-copied file is invisible to the merge that would repair it."""
    source = _partition(clean_store)
    wrong = partition_dir("1D", pd.Timestamp("2021-01-01"), clean_store)
    wrong.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(source, wrong / "data.parquet")

    issues = audit.misplaced_rows(root=clean_store)

    assert _codes(issues) == ["misplaced_partition"]
    assert issues[0].rows == 10 and issues[0].is_error
    assert "belongs in" in issues[0].detail and "year=2020" in issues[0].detail


def test_a_partition_spanning_two_years_is_named(tmp_path: Path, clean_store: Path) -> None:
    frame = store._read_partition(_partition(clean_store))
    extra = frame.iloc[[0]].copy()
    extra["session_date"] = pd.Timestamp("2021-01-04")

    _dump(_partition(clean_store), pd.concat([frame, extra], ignore_index=True))

    issues = audit.misplaced_rows(root=clean_store)

    assert _codes(issues) == ["partition_spans_period"]
    assert issues[0].rows == 11 and "2021-01-04" in issues[0].detail


def test_a_file_outside_the_partition_tree_is_orphaned(tmp_path: Path, clean_store: Path) -> None:
    stray = bars_dir(clean_store) / "handed-over-by-a-friend"
    stray.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(_partition(clean_store), stray / "data.parquet")

    issues = audit.misplaced_rows(root=clean_store)

    assert _codes(issues) == ["orphan_partition"]
    assert "interval=" in issues[0].detail


def test_an_empty_partition_is_a_warning(tmp_path: Path, clean_store: Path) -> None:
    empty = partition_dir("1D", pd.Timestamp("2019-06-05"), clean_store) / "data.parquet"

    _dump(empty, store._read_partition(_partition(clean_store)).iloc[0:0])

    issues = audit.misplaced_rows(root=clean_store)

    assert _codes(issues) == ["empty_partition"]
    assert issues[0].severity == "warn", "an empty file wastes a partition, it is not corruption"


# ---------------------------------------------------------------------------
# Manifest provenance
# ---------------------------------------------------------------------------


def test_bars_with_no_manifest_say_so(tmp_path: Path, clean_store: Path) -> None:
    issues = audit.manifest_gaps(root=clean_store)

    assert _codes(issues) == ["manifest_missing"]
    assert issues[0].rows == 10 and issues[0].severity == "warn"


def test_rows_the_manifest_explains_raise_no_provenance_issue(
    tmp_path: Path, clean_store: Path
) -> None:
    store.write_manifest(
        source="tushare",
        markets=["a_share"],
        volume_unit="lots",
        amount_unit="cny_thousand",
        root=clean_store,
    )

    assert audit.manifest_gaps(root=clean_store) == []


def test_a_market_no_declared_source_covers_is_reported(tmp_path: Path, clean_store: Path) -> None:
    """Rows can only be read correctly in the units of the market they belong to."""
    store.write_manifest(
        source="tushare",
        markets=["a_share"],
        volume_unit="lots",
        amount_unit="cny_thousand",
        root=clean_store,
    )
    _rewrite(_partition(clean_store), _set("market", "us_equity"))

    issues = audit.manifest_gaps(root=clean_store)

    assert _codes(issues) == ["undeclared_market"]
    assert "us_equity" in issues[0].detail


def test_a_row_carrying_an_unlisted_source_is_reported(tmp_path: Path, clean_store: Path) -> None:
    store.write_manifest(
        source="tushare",
        markets=["a_share"],
        volume_unit="lots",
        amount_unit="cny_thousand",
        root=clean_store,
    )
    _rewrite(_partition(clean_store), _set("source", "someone-elses-file"))

    issues = audit.manifest_gaps(root=clean_store)

    assert _codes(issues) == ["undeclared_source"]
    assert "someone-elses-file" in issues[0].detail


# ---------------------------------------------------------------------------
# Factor holes the sync is still waiting on
# ---------------------------------------------------------------------------


def _pending(root: Path, symbol: str, dates: list[str]) -> None:
    sync.write_state(
        {"per_symbol": {symbol: {"first": dates[0], "last": dates[-1], "pending_dates": dates}}},
        [symbol],
        interval="1D",
        root=root,
    )


def _relative(days: int) -> str:
    return (pd.Timestamp.now(tz="UTC").tz_localize(None) + pd.Timedelta(days=days)).date().isoformat()


def test_a_factor_hole_that_outranks_its_patience_is_reported(
    tmp_path: Path, clean_store: Path
) -> None:
    """A pending date is a promise of a retry; an old one means the hole is permanent."""
    _pending(tmp_path, _HALTED, [_relative(-40), _relative(-30)])

    issues = audit.stale_pending_dates(root=clean_store)

    assert _codes(issues) == ["stale_pending_date"]
    assert issues[0].rows == 2 and issues[0].severity == "warn"
    assert _relative(-40) in issues[0].detail


def test_a_recent_hole_is_left_alone(tmp_path: Path, clean_store: Path) -> None:
    _pending(tmp_path, _HALTED, [_relative(-1)])

    assert audit.stale_pending_dates(root=clean_store) == []
    assert audit.stale_pending_dates(root=clean_store, older_than_days=0), "the knob works"


def test_an_unreadable_state_file_is_a_finding(tmp_path: Path, clean_store: Path) -> None:
    path = state_path("1D", [_HALTED], clean_store)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{not json", encoding="utf-8")

    issues = audit.stale_pending_dates(root=clean_store)

    assert _codes(issues) == ["unreadable_state"]


def test_the_state_of_an_unrelated_interval_is_not_searched(
    tmp_path: Path, clean_store: Path
) -> None:
    _pending(tmp_path, _HALTED, [_relative(-40)])

    assert audit.stale_pending_dates(interval="5m", root=clean_store) == []


# ---------------------------------------------------------------------------
# Assembly, and the promise that reading is all it does
# ---------------------------------------------------------------------------


def test_an_audit_never_rewrites_a_single_byte(tmp_path: Path, halted_store: Path) -> None:
    """Reporting is the whole job: a fix here would be an untraceable edit."""
    _rewrite(_partition(halted_store, _HALTED), _set("volume", 0.0))
    store.write_manifest(
        source="tushare",
        markets=["a_share"],
        volume_unit="lots",
        amount_unit="cny_thousand",
        root=halted_store,
    )
    _pending(halted_store, _HALTED, ["2020-01-09"])
    before = _digests(halted_store)

    report = audit.audit(root=halted_store)

    assert report.gaps and report.issues, "there was something to complain about"
    assert _digests(halted_store) == before, "not one byte changed, none added"


def test_the_report_totals_come_from_the_files(tmp_path: Path, halted_store: Path) -> None:
    report = audit.audit(root=halted_store)

    assert (report.symbols, report.rows, report.partitions) == (3, 19, 1)
    assert (report.first, report.last) == ("2020-01-06", "2020-01-17")
    assert report.root == str(halted_store) and report.interval == "1D"
    assert report.coverage[0].symbol == _PEER


def test_a_suspected_halt_is_not_a_failed_audit(tmp_path: Path, halted_store: Path) -> None:
    """A halt is a fact about the market; a 3-row history is an operator's choice."""
    report = audit.audit(root=halted_store)

    assert [gap.symbol for gap in report.gaps] == [_HALTED]
    assert report.is_clean() and not report.errors, "suspicions are never failures"
    assert _codes(report.warnings) == ["manifest_missing"], "provenance is a warning, not an error"


def test_an_impossible_row_fails_the_audit(tmp_path: Path, halted_store: Path) -> None:
    _rewrite(_partition(halted_store, _HALTED), _set("high", 1.0))

    report = audit.audit(root=halted_store)

    assert not report.is_clean()
    assert [(issue.code, issue.rows) for issue in report.errors] == [("ohlc_invariant", 1)]


def test_check_gaps_can_be_skipped_without_losing_the_row_checks(
    tmp_path: Path, halted_store: Path
) -> None:
    _rewrite(_partition(halted_store, _HALTED), _set("adj_factor", None))

    report = audit.audit(root=halted_store, check_gaps=False)

    assert report.gaps == []
    assert _codes(report.issues) == ["factor_hole", "manifest_missing"]


def test_the_summary_reads_like_a_diagnosis(tmp_path: Path, halted_store: Path) -> None:
    _rewrite(_partition(halted_store, _HALTED), _set("volume", 0.0))

    summary = audit.audit(root=halted_store).summary()

    assert f"warehouse 1D at {halted_store.as_posix()}" in summary.replace("\\", "/")
    assert "3 symbol(s), 19 row(s), 1 partition(s) spanning 2020-01-06..2020-01-17" in summary
    assert "[warn] placeholder_row: 1" in summary
    assert f"1 suspected halt window(s), heuristic (>= {MIN_GAP_SESSIONS}" in summary
    assert "600519.SH: 4 session(s) missing 2020-01-09..2020-01-14" in summary


def test_the_summary_trims_a_long_gap_list(tmp_path: Path, halted_store: Path) -> None:
    summary = audit.audit(root=halted_store).summary(max_rows=0)

    assert "1 suspected halt window(s)" in summary
    assert "... 1 more" in summary


def test_the_report_serialises_to_json(tmp_path: Path, halted_store: Path) -> None:
    payload = audit.audit(root=halted_store).to_dict()

    assert json.dumps(payload)[0] == "{", "the CLI prints it, so it must be encodable"
    assert payload["clean"] is True
    assert payload["gaps"][0]["symbol"] == _HALTED
    assert payload["coverage"][0]["sources"] == ["tushare"]
    assert payload["issues"] == [
        {"code": "manifest_missing", "severity": "warn", "rows": 19, "detail": payload["issues"][0]["detail"]}
    ]


def test_an_empty_store_is_an_error_with_the_command_that_fills_it(
    tmp_path: Path,
) -> None:
    with pytest.raises(WarehouseAuditError, match="python -m backtest.warehouse sync"):
        audit.audit(root=tmp_path)


def test_the_audit_type_is_reachable_through_the_package(tmp_path: Path) -> None:
    report = AuditReport(interval="1D", root=str(tmp_path))

    assert report.symbols == 0 and report.is_clean()
    assert report.summary().startswith("warehouse 1D at")
