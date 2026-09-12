"""The sync loop: what it asks the source for, and what it refuses to write.

``sync`` is the only place in the warehouse that touches the network, and it runs
against a rate-limited API where a mistake is permanent. These tests drive it
with a fake source — ``TUSHARE_TOKEN`` is empty in this environment, so nothing
here claims to have verified the real endpoint; what is verified is the loop's
own contract:

* **Incremental, not re-downloading** (acceptance criterion 3): the second run
  requests a window that starts at the last stored session rewound by the
  settling margin, and never asks for history it already has.
* **Idempotent**: re-running a sync adds no rows, so an interrupted run can be
  resumed by a human without a cleanup step.
* **A hole is a promise, not an absence**: a session the write gate refused for
  a missing adjustment factor is recorded as pending and pulls the *next* window
  start back to it. Confusing "the factor has not been published yet" with "the
  market was closed" would freeze a permanent hole into the series.
* **Refusals are per symbol**: one bad ticker or one unit mismatch must not
  abandon the other 299, and a unit conflict is caught before the first request.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

import pandas as pd
import pytest

from backtest.warehouse import store, sync
from backtest.warehouse.layout import state_path
from backtest.warehouse.schema import WarehouseConfigError

_SYMBOL = "600519.SH"
_OTHER = "000858.SZ"
_TODAY = pd.Timestamp("2020-01-10")

SESSIONS = pd.DatetimeIndex(["2020-01-06", "2020-01-07", "2020-01-08", "2020-01-09"])


# ---------------------------------------------------------------------------
# Fake source
# ---------------------------------------------------------------------------


def bars_frame(index: pd.DatetimeIndex, *, close: float = 100.0, volume: float = 1000.0) -> pd.DataFrame:
    """Raw (unadjusted) daily bars shaped like Tushare's ``pro.daily``."""
    closes = [close + position for position in range(len(index))]
    frame = pd.DataFrame(
        {
            "open": closes,
            "high": [c + 1.0 for c in closes],
            "low": [c - 1.0 for c in closes],
            "close": closes,
            "volume": [volume] * len(index),
            "amount": [5000.0] * len(index),
        },
        index=index,
    )
    frame.index.name = "trade_date"
    return frame


def factor_frame(index: pd.DatetimeIndex, values: list[float]) -> pd.DataFrame:
    """A ``pro.adj_factor``-shaped frame: the warehouse's only factor source."""
    return pd.DataFrame({"trade_date": index, "adj_factor": values})


class FakeSource:
    """A source that answers from a dict and records every request it got."""

    name = "tushare"
    markets = {"a_share"}
    requires_auth = True
    volume_units: dict[str, str] = {"a_share": "lots"}

    def __init__(
        self,
        frames: dict[str, tuple[pd.DataFrame, pd.DataFrame | None]] | None = None,
        *,
        errors: dict[str, Exception] | None = None,
    ) -> None:
        self.frames = frames or {}
        self.errors = errors or {}
        self.requests: list[tuple[str, str, str]] = []

    @property
    def requested_symbols(self) -> list[str]:
        return [request[0] for request in self.requests]

    @property
    def windows(self) -> dict[str, tuple[str, str]]:
        return {symbol: (start, end) for symbol, start, end in self.requests}

    def is_available(self) -> bool:
        return True

    def fetch_raw_with_factor(
        self, codes: list[str], start_date: str, end_date: str, *, interval: str = "1D"
    ) -> dict[str, tuple[Any, Any]]:
        symbol = codes[0]
        self.requests.append((symbol, str(start_date), str(end_date)))
        if symbol in self.errors:
            raise self.errors[symbol]
        return {symbol: self.frames.get(symbol, (None, None))}


def run(source: FakeSource, symbols: list[str], root: Path, **kwargs) -> sync.SyncReport:
    """Call :func:`sync.sync_symbols` with the deterministic knobs pinned."""
    options: dict[str, Any] = dict(
        source="tushare", interval="1D", root=root, loader=source, today=_TODAY,
        per_minute=6000.0, sleeper=lambda _seconds: None, clock=lambda: 0.0,
    )
    options.update(kwargs)
    return sync.sync_symbols(symbols, **options)


# ---------------------------------------------------------------------------
# First run / incremental behaviour (acceptance criterion 3)
# ---------------------------------------------------------------------------


def test_the_first_run_backfills_and_records_what_it_stored(tmp_path: Path) -> None:
    source = FakeSource({_SYMBOL: (bars_frame(SESSIONS), factor_frame(SESSIONS, [1.0] * 4))})

    report = run(source, [_SYMBOL], tmp_path, years=10)

    assert [item.status for item in report.symbols] == ["ok"]
    assert report.rows_written == 4 and report.rows_added == 4
    assert (report.symbols[0].first, report.symbols[0].last) == ("2020-01-06", "2020-01-09")
    assert report.partitions == 1
    stored = store.read_raw_with_factor([_SYMBOL], start="2020-01-01", end="2020-01-31", root=tmp_path)
    assert len(stored[_SYMBOL]) == 4
    assert report.throttled_s == pytest.approx(60.0 / 6000.0), "only the nominal gap, never a backoff"


def test_the_backfill_window_is_the_requested_depth_ending_yesterday(tmp_path: Path) -> None:
    source = FakeSource({_SYMBOL: (bars_frame(SESSIONS), factor_frame(SESSIONS, [1.0] * 4))})

    run(source, [_SYMBOL], tmp_path, years=3)

    start, end = source.windows[_SYMBOL]
    assert end == "2020-01-09", "today is never requested: its bar cannot be complete"
    assert start == "2017-01-09", "three years back from the settled end"


def test_a_second_run_only_requests_the_unsettled_tail(tmp_path: Path) -> None:
    """The whole point of resume state: history already on disk is not re-pulled."""
    source = FakeSource({_SYMBOL: (bars_frame(SESSIONS), factor_frame(SESSIONS, [1.0] * 4))})
    run(source, [_SYMBOL], tmp_path, years=10)
    first_window = source.windows[_SYMBOL]
    source.requests.clear()

    report = run(source, [_SYMBOL], tmp_path, today=pd.Timestamp("2020-01-20"))

    start, end = source.windows[_SYMBOL]
    assert list(source.windows) == [_SYMBOL]
    assert end == "2020-01-19", "the request still stops at the last settled session"
    assert start == str((pd.Timestamp("2020-01-09") - pd.Timedelta(days=sync.SETTLING_DAYS)).date())
    assert pd.Timestamp(start) > pd.Timestamp(first_window[0]), "the deep history is not pulled twice"
    assert report.symbols[0].mode == "increment"


def test_a_resync_adds_no_rows_and_no_duplicate_keys(tmp_path: Path) -> None:
    index = SESSIONS
    source = FakeSource({_SYMBOL: (bars_frame(index), factor_frame(index, [1.0] * len(index)))})
    run(source, [_SYMBOL], tmp_path)

    # A day later the rewound window re-requests sessions that are already stored.
    second = run(source, [_SYMBOL], tmp_path, today=pd.Timestamp("2020-01-20"))

    assert second.rows_written == len(index), "the overlapping rows are written again"
    assert second.rows_added == 0, "but they add nothing"
    frame = store.read_raw_with_factor([_SYMBOL], start="2020-01-01", end="2020-01-31", root=tmp_path)[_SYMBOL]
    assert len(frame) == len(index)
    assert not frame.index.duplicated().any()


def test_yesterdays_new_bar_extends_the_store_without_rewriting_history(
    tmp_path: Path,
) -> None:
    source = FakeSource({_SYMBOL: (bars_frame(SESSIONS), factor_frame(SESSIONS, [1.0] * 4))})
    run(source, [_SYMBOL], tmp_path)
    old_digest = (tmp_path / "bars" / "interval=1D" / "year=2020" / "data.parquet").read_bytes()
    extended = SESSIONS.union(pd.DatetimeIndex(["2020-01-10"]))
    source.frames[_SYMBOL] = (bars_frame(extended), factor_frame(extended, [1.0] * len(extended)))

    with pytest.MonkeyPatch.context() as patch:
        patch.setattr(sync, "SETTLING_DAYS", 1)  # pretend the tail has settled
        report = run(source, [_SYMBOL], tmp_path, today=pd.Timestamp("2020-01-12"))

    assert report.symbols[0].last == "2020-01-10"
    frame = store.read_raw_with_factor([_SYMBOL], start="2020-01-01", end="2020-01-31", root=tmp_path)[_SYMBOL]
    assert len(frame) == len(extended)
    assert frame.loc[SESSIONS[0], "close"] == 100.0, "the old rows are untouched"
    assert (tmp_path / "bars" / "interval=1D" / "year=2020" / "data.parquet").read_bytes() != old_digest


def test_a_store_that_is_current_makes_no_request(tmp_path: Path) -> None:
    source = FakeSource({_SYMBOL: (bars_frame(SESSIONS), factor_frame(SESSIONS, [1.0] * 4))})
    run(source, [_SYMBOL], tmp_path)
    source.requests.clear()

    report = run(source, [_SYMBOL], tmp_path, today=pd.Timestamp("2020-01-10"), end="2020-01-09")

    assert source.requests == [], "nothing left to ask for, so nothing is asked"
    assert report.symbols[0].mode == "current"
    assert report.symbols[0].status == "empty"


def test_an_explicit_start_re_anchors_without_losing_the_stored_tail(
    tmp_path: Path,
) -> None:
    source = FakeSource({_SYMBOL: (bars_frame(SESSIONS), factor_frame(SESSIONS, [1.0] * 4))})
    run(source, [_SYMBOL], tmp_path)
    early = pd.DatetimeIndex(["2019-12-30", "2019-12-31"])
    source.frames[_SYMBOL] = (
        bars_frame(early),
        factor_frame(early, [1.0, 1.0]),
    )
    source.requests.clear()

    report = run(source, [_SYMBOL], tmp_path, start="2019-12-01", end="2019-12-31")

    assert report.symbols[0].mode == "re-anchor"
    assert source.windows[_SYMBOL] == ("2019-12-01", "2019-12-31")
    first, last, rows = store.symbol_range(_SYMBOL, root=tmp_path)
    assert (str(first.date()), str(last.date()), rows) == ("2019-12-30", "2020-01-09", 6)


# ---------------------------------------------------------------------------
# Halts (acceptance criterion 5b, write side)
# ---------------------------------------------------------------------------


def test_a_halt_stays_absent_rather_than_becoming_a_placeholder_row(
    tmp_path: Path,
) -> None:
    """Sessions the source never returned are missing rows, and missing is right.

    The distinction that matters here is between "the market did not trade" and
    "the factor has not been published": only the latter is recorded as pending,
    because a halt retried forever would never converge, while an unpublished
    factor is a hole that closes on its own.
    """
    trading = SESSIONS[[0, 3]]  # 2020-01-07 and 08 were halted
    source = FakeSource({_SYMBOL: (bars_frame(trading), factor_frame(trading, [1.0, 1.0]))})

    report = run(source, [_SYMBOL], tmp_path)

    assert report.symbols[0].status == "ok"
    assert report.symbols[0].pending_dates == [], "a halt is not a hole to retry"
    frame = store.read_raw_with_factor(
        [_SYMBOL], start="2020-01-01", end="2020-01-31", root=tmp_path
    )[_SYMBOL]
    assert list(frame.index) == list(trading), "no synthesized 'price did not move' rows"
    state = sync.read_state([_SYMBOL], root=tmp_path)["per_symbol"][_SYMBOL]
    assert state["pending_dates"] == [] and state["last"] == "2020-01-09"


# ---------------------------------------------------------------------------
# Adjustment-factor holes
# ---------------------------------------------------------------------------


def test_a_session_waiting_on_its_factor_is_recorded_as_pending(tmp_path: Path) -> None:
    """Not a halt: the factor lags the price, so the row must be retried."""
    source = FakeSource(
        {_SYMBOL: (bars_frame(SESSIONS), factor_frame(SESSIONS[:3], [1.0, 1.0, 1.0]))}
    )

    report = run(source, [_SYMBOL], tmp_path)

    assert report.symbols[0].pending_dates == ["2020-01-09"]
    assert report.pending_total == 1
    frame = store.read_raw_with_factor([_SYMBOL], start="2020-01-01", end="2020-01-31", root=tmp_path)[_SYMBOL]
    assert len(frame) == 3, "the pending session is absent from disk, not stored unadjusted"
    state = sync.read_state([_SYMBOL], root=tmp_path)["per_symbol"][_SYMBOL]
    assert state["pending_dates"] == ["2020-01-09"]


def test_the_next_run_retries_a_tail_hole_inside_the_rewound_window(
    tmp_path: Path,
) -> None:
    source = FakeSource(
        {_SYMBOL: (bars_frame(SESSIONS), factor_frame(SESSIONS[:3], [1.0, 1.0, 1.0]))}
    )
    run(source, [_SYMBOL], tmp_path)
    source.requests.clear()
    source.frames[_SYMBOL] = (bars_frame(SESSIONS), factor_frame(SESSIONS, [1.0] * 4))

    report = run(source, [_SYMBOL], tmp_path, today=pd.Timestamp("2020-01-20"))

    start, end = source.windows[_SYMBOL]
    assert report.symbols[0].mode == "increment"
    assert pd.Timestamp(start) <= pd.Timestamp("2020-01-09") <= pd.Timestamp(end), (
        "the rewound tail has to reach the hole, or it would never be retried"
    )
    assert report.symbols[0].pending_dates == [], "the hole is closed and forgotten"
    state = sync.read_state([_SYMBOL], root=tmp_path)["per_symbol"][_SYMBOL]
    assert state["pending_dates"] == []
    frame = store.read_raw_with_factor([_SYMBOL], start="2020-01-01", end="2020-01-31", root=tmp_path)[_SYMBOL]
    assert len(frame) == 4


def test_a_hole_older_than_the_rewound_tail_pulls_the_window_back_to_it(
    tmp_path: Path,
) -> None:
    """A session whose factor surfaced months later is still reachable."""
    source = FakeSource({_SYMBOL: (bars_frame(SESSIONS), factor_frame(SESSIONS, [1.0] * 4))})
    run(source, [_SYMBOL], tmp_path)
    sync.write_state(
        {
            "per_symbol": {
                _SYMBOL: {
                    "first": "2020-01-06",
                    "last": "2020-01-09",
                    "pending_dates": ["2019-06-03"],
                }
            }
        },
        [_SYMBOL],
        interval="1D",
        root=tmp_path,
    )
    hole = pd.DatetimeIndex(["2019-06-03"])
    source.frames[_SYMBOL] = (bars_frame(hole), factor_frame(hole, [1.0]))
    source.requests.clear()

    report = run(source, [_SYMBOL], tmp_path)

    assert report.symbols[0].mode == "hole-repair"
    assert source.windows[_SYMBOL][0] == "2019-06-03", "the window starts at the hole"
    frame = store.read_raw_with_factor(
        [_SYMBOL], start="2019-01-01", end="2020-01-31", root=tmp_path
    )[_SYMBOL]
    assert frame.index[0] == pd.Timestamp("2019-06-03") and len(frame) == 5
    assert sync.read_state([_SYMBOL], root=tmp_path)["per_symbol"][_SYMBOL]["pending_dates"] == []


def test_factors_are_matched_by_date_not_by_row_position(tmp_path: Path) -> None:
    """A factor frame aligned by position would silently apply tomorrow's factor."""
    by_date = {
        pd.Timestamp("2020-01-06"): (100.0, 1.0),
        pd.Timestamp("2020-01-07"): (101.0, 2.0),
        pd.Timestamp("2020-01-08"): (102.0, 3.0),
        pd.Timestamp("2020-01-09"): (103.0, 4.0),
    }
    order = [
        pd.Timestamp("2020-01-08"),
        pd.Timestamp("2020-01-06"),
        pd.Timestamp("2020-01-09"),
        pd.Timestamp("2020-01-07"),
    ]
    index = pd.DatetimeIndex(order)
    bars = bars_frame(index)
    bars["close"] = [by_date[stamp][0] for stamp in order]
    bars["open"] = bars["close"]
    bars["high"] = bars["close"] + 1.0
    bars["low"] = bars["close"] - 1.0
    source = FakeSource({_SYMBOL: (bars, factor_frame(index, [by_date[stamp][1] for stamp in order]))})

    run(source, [_SYMBOL], tmp_path)

    stored = store.read_raw_with_factor(
        [_SYMBOL], start="2020-01-01", end="2020-01-31", root=tmp_path
    )[_SYMBOL]
    assert stored.index.is_monotonic_increasing
    assert stored["adj_factor"].to_list() == [1.0, 2.0, 3.0, 4.0]
    assert stored["close"].to_list() == [100.0, 101.0, 102.0, 103.0]


def test_an_unshapen_factor_frame_is_reported_and_refuses_that_symbol(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Never fatal: one unusable frame must not abandon the rest of the run."""
    source = FakeSource(
        {
            _SYMBOL: (bars_frame(SESSIONS), pd.DataFrame({"date": SESSIONS, "value": [1.0] * 4})),
            _OTHER: (bars_frame(SESSIONS), factor_frame(SESSIONS, [1.0] * 4)),
        }
    )

    report = run(source, [_SYMBOL, _OTHER], tmp_path)

    assert "ignoring it" in caplog.text
    assert report.symbols[0].status == "refused"
    assert "adj_factor" in (report.symbols[0].error or "")
    assert report.symbols[0].pending_dates == [], "no factor at all is a config error, not a hole"
    assert report.symbols[1].status == "ok", "the other name is still fetched and stored"
    assert store.stored_symbols(root=tmp_path) == [_OTHER]


def test_a_symbol_with_no_factor_column_is_refused_rather_than_stored_raw(
    tmp_path: Path,
) -> None:
    """A qfq-only source must not be able to poison the store."""
    frame = bars_frame(SESSIONS)
    source = FakeSource({_SYMBOL: (frame, None)})

    report = run(source, [_SYMBOL], tmp_path)

    assert report.symbols[0].status == "refused"
    assert "WarehouseConfigError" in (report.symbols[0].error or "")
    assert store.stored_symbols(root=tmp_path) == []


# ---------------------------------------------------------------------------
# Throttling, backoff and budgets
# ---------------------------------------------------------------------------


def test_requests_are_spaced_at_the_configured_rate() -> None:
    waits: list[float] = []

    throttle = sync.Throttle(60.0, sleeper=waits.append, clock=lambda: 0.0)
    for _ in range(3):
        throttle.wait()

    assert waits == [1.0, 1.0, 1.0], "60/min is one request per second"
    assert throttle.waited_s == pytest.approx(3.0)


def test_a_quota_rejection_costs_a_wait_and_widens_the_gap() -> None:
    waits: list[float] = []
    throttle = sync.Throttle(60.0, sleeper=waits.append, clock=lambda: 0.0)

    assert [throttle.penalize() for _ in range(4)] == [30.0, 120.0, 300.0, 300.0]
    assert waits == [30.0, 120.0, 300.0, 300.0], "the schedule plateaus instead of growing forever"

    throttle.wait()
    assert waits[-1] == pytest.approx(1.0 * sync._GAP_WIDENING ** 4), (
        "the normal gap was widened on top of the penalty"
    )

    throttle.reward()
    throttle.wait()
    assert waits[-1] == pytest.approx(1.0 * sync._GAP_WIDENING ** 3), (
        "a clean request earns a little speed back"
    )
    assert throttle.waited_s > sum(waits[:-1]), "every wait was accounted for"


def test_a_quota_rejection_is_classified_and_slows_the_rest_of_the_run(
    tmp_path: Path,
) -> None:
    source = FakeSource(
        {},
        errors={_SYMBOL: RuntimeError("抱歉,您每分钟最多访问该接口500次")},
    )
    waits: list[float] = []

    report = run(source, [_SYMBOL], tmp_path, sleeper=waits.append, per_minute=6000.0)

    assert report.symbols[0].status == "failed"
    assert report.symbols[0].rate_limited is True
    assert 30.0 in waits, "the run paid the backoff rather than hammering again"
    assert report.throttled_s > 0.0
    state = sync.read_state([_SYMBOL], root=tmp_path)["per_symbol"][_SYMBOL]
    assert state["failures"] == 1 and "RuntimeError" in state["last_error"]


def test_a_plain_failure_does_not_trigger_the_backoff(tmp_path: Path) -> None:
    source = FakeSource({}, errors={_SYMBOL: RuntimeError("connection reset by peer")})
    waits: list[float] = []

    report = run(source, [_SYMBOL], tmp_path, sleeper=waits.append)

    assert report.symbols[0].status == "failed"
    assert report.symbols[0].rate_limited is False
    assert 30.0 not in waits and max(waits) < 1.0, "no quota backoff was paid for a plain error"


def test_the_wall_clock_budget_stops_the_run_and_saves_progress(tmp_path: Path) -> None:
    source = FakeSource(
        {
            _SYMBOL: (bars_frame(SESSIONS), factor_frame(SESSIONS, [1.0] * 4)),
            _OTHER: (bars_frame(SESSIONS), factor_frame(SESSIONS, [1.0] * 4)),
        }
    )
    elapsed = {"s": 0.0}

    def advance(seconds: float) -> None:
        elapsed["s"] += seconds

    report = run(
        source,
        [_SYMBOL, _OTHER],
        tmp_path,
        budget_s=0.005,  # one request gap (60/6000 = 0.01s) is already over it
        sleeper=advance,
        clock=lambda: elapsed["s"],
    )

    assert report.stopped_reason and "budget" in report.stopped_reason
    assert "1 symbol(s) left" in report.stopped_reason
    assert [item.symbol for item in report.symbols] == [_SYMBOL], "the second name was never started"
    assert store.stored_symbols(root=tmp_path) == [_SYMBOL]
    state = sync.read_state([_SYMBOL, _OTHER], root=tmp_path)["per_symbol"]
    assert state[_SYMBOL]["last"] == "2020-01-09" and _OTHER not in state


def test_no_request_is_made_when_the_run_is_a_dry_plan(tmp_path: Path) -> None:
    source = FakeSource({_SYMBOL: (bars_frame(SESSIONS), factor_frame(SESSIONS, [1.0] * 4))})

    report = run(source, [_SYMBOL], tmp_path, dry_run=True)

    assert source.requests == []
    assert report.symbols[0].status == "planned"
    assert report.symbols[0].mode == "backfill"
    assert list(tmp_path.iterdir()) == [], "a plan must not create a single file"
    assert not state_path("1D", [_SYMBOL], tmp_path).exists()


# ---------------------------------------------------------------------------
# Refusals that must happen before any network call
# ---------------------------------------------------------------------------


def test_a_unit_conflict_with_another_source_refuses_the_run(tmp_path: Path) -> None:
    """One column cannot be lots for one source and shares for another."""
    store.write_manifest(
        source="akshare", markets=["a_share"], volume_unit="lots",
        amount_unit="cny_thousand", root=tmp_path,
    )
    source = FakeSource({_SYMBOL: (bars_frame(SESSIONS), factor_frame(SESSIONS, [1.0] * 4))})
    source.volume_units = {"a_share": "shares"}

    with pytest.raises(sync.SyncConfigError, match="already stored from 'akshare'"):
        run(source, [_SYMBOL], tmp_path)

    assert source.requests == [], "the conflict is caught before the first request"


def test_a_newer_on_disk_schema_stops_the_run(tmp_path: Path) -> None:
    (tmp_path / "_manifest.json").write_text('{"schema_version": 999}', encoding="utf-8")
    source = FakeSource({_SYMBOL: (bars_frame(SESSIONS), factor_frame(SESSIONS, [1.0] * 4))})

    with pytest.raises(store.WarehouseSchemaMismatch):
        run(source, [_SYMBOL], tmp_path)

    assert source.requests == []


def test_an_undeclared_volume_unit_refuses_the_symbol_without_writing(
    tmp_path: Path,
) -> None:
    """No guessing: a bar stored in the wrong unit is unreadable forever."""
    source = FakeSource({_SYMBOL: (bars_frame(SESSIONS), factor_frame(SESSIONS, [1.0] * 4))})
    source.volume_units = {}  # the source declares nothing for a_share

    report = run(source, [_SYMBOL], tmp_path)

    assert report.symbols[0].status == "refused"
    assert "undeclared" in (report.symbols[0].error or "")
    assert [item.symbol for item in report.failed] == [_SYMBOL]
    assert report.problems() == [f"{_SYMBOL} [refused]: {report.symbols[0].error}"]
    assert store.stored_symbols(root=tmp_path) == []


def test_an_empty_answer_is_recorded_as_an_empty_window(tmp_path: Path) -> None:
    source = FakeSource({_SYMBOL: (pd.DataFrame(), None)})

    report = run(source, [_SYMBOL], tmp_path)

    assert report.symbols[0].status == "empty"
    state = sync.read_state([_SYMBOL], root=tmp_path)["per_symbol"][_SYMBOL]
    assert state["empty_windows"] == 1


def test_a_no_symbol_run_reports_rather_than_crashing(tmp_path: Path) -> None:
    report = sync.sync_symbols([], root=tmp_path)

    assert report.symbols == []
    assert report.notes == ["no symbols requested"]


# ---------------------------------------------------------------------------
# Source selection
# ---------------------------------------------------------------------------


def test_load_source_refuses_an_unknown_name() -> None:
    with pytest.raises(sync.SyncConfigError, match="unknown source"):
        sync.load_source("definitely-not-a-loader")


def test_load_source_refuses_a_source_that_cannot_supply_factors() -> None:
    """A qfq-only source would store a series the next dividend re-anchors."""
    with pytest.raises(sync.SyncConfigError, match="fetch_raw_with_factor"):
        sync.load_source("baostock")


def test_the_warehouse_cannot_sync_itself() -> None:
    with pytest.raises(sync.SyncConfigError, match="fetch_raw_with_factor"):
        sync.load_source("warehouse")


def test_load_source_checks_availability_before_the_first_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A source that answers "no" is never fetched from."""
    from backtest.loaders.registry import LOADER_REGISTRY, _ensure_registered

    asked: list[str] = []

    class Unreachable:
        name = "unreachable"

        def fetch_raw_with_factor(self, *_args, **_kwargs):
            asked.append("fetch")

        def is_available(self) -> bool:
            return False

    _ensure_registered()
    monkeypatch.setitem(LOADER_REGISTRY, "unreachable", Unreachable)

    with pytest.raises(sync.SyncConfigError, match="unavailable"):
        sync.load_source("unreachable")

    assert asked == []


def test_a_source_that_cannot_initialize_reports_why(monkeypatch: pytest.MonkeyPatch) -> None:
    """Missing credentials surface as a config error, not as a traceback later.

    This environment has no ``TUSHARE_TOKEN``, so the real endpoint is never
    reached here; what is pinned is how ``load_source`` treats a loader whose
    constructor cannot get as far as a request.
    """
    from backtest.loaders.registry import LOADER_REGISTRY, _ensure_registered

    class Broken:
        name = "broken"

        def __init__(self) -> None:
            raise RuntimeError("api init error")

        def fetch_raw_with_factor(self, *_args, **_kwargs):  # pragma: no cover
            raise AssertionError("must not be reached")

    _ensure_registered()
    monkeypatch.setitem(LOADER_REGISTRY, "broken", Broken)

    with pytest.raises(sync.SyncConfigError, match="failed to initialize"):
        sync.load_source("broken")


# ---------------------------------------------------------------------------
# Resume state
# ---------------------------------------------------------------------------


def test_state_falls_back_to_the_disk_when_the_roster_shifted(tmp_path: Path) -> None:
    """CSI 300 membership changes monthly; a one-name shift must not re-backfill."""
    source = FakeSource({_SYMBOL: (bars_frame(SESSIONS), factor_frame(SESSIONS, [1.0] * 4))})
    run(source, [_SYMBOL], tmp_path)
    source.requests.clear()

    entry = sync.resume_entry(None, _SYMBOL, interval="1D", root=tmp_path)
    window = sync.resolve_window(
        entry, start=None, end=None, years=10, today=pd.Timestamp("2020-01-20")
    )

    assert (entry["first"], entry["last"]) == ("2020-01-06", "2020-01-09")
    assert window[2] == "increment", "the disk says what is stored, so no re-backfill"
    assert window[0] == str((pd.Timestamp("2020-01-09") - pd.Timedelta(days=sync.SETTLING_DAYS)).date())


def test_a_state_entry_wins_over_the_disk(tmp_path: Path) -> None:
    entry = sync.resume_entry({"first": "2010-01-01", "last": "2010-06-01"}, _SYMBOL, interval="1D", root=tmp_path)

    assert entry["last"] == "2010-06-01"


def test_corrupt_state_is_treated_as_fresh(tmp_path: Path, caplog: pytest.LogCaptureFixture) -> None:
    path = state_path("1D", [_SYMBOL], tmp_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{not json", encoding="utf-8")

    assert sync.read_state([_SYMBOL], root=tmp_path)["per_symbol"] == {}
    assert "unreadable" in caplog.text, "a state file that cannot be read says so"


def test_state_round_trips_and_records_its_provenance(tmp_path: Path) -> None:
    source = FakeSource({_SYMBOL: (bars_frame(SESSIONS), factor_frame(SESSIONS, [1.0] * 4))})

    run(source, [_SYMBOL], tmp_path)

    path = state_path("1D", [_SYMBOL], tmp_path)
    payload = json.loads(path.read_text(encoding="utf-8"))
    assert payload["interval"] == "1D" and payload["source"] == "tushare"
    assert payload["symbols"] == [_SYMBOL]
    assert payload["per_symbol"][_SYMBOL]["pending_dates"] == []
    assert "rows" not in payload["per_symbol"][_SYMBOL], "counts live in the partitions, not state"


def test_the_manifest_records_the_units_behind_the_written_rows(tmp_path: Path) -> None:
    source = FakeSource({_SYMBOL: (bars_frame(SESSIONS), factor_frame(SESSIONS, [1.0] * 4))})

    run(source, [_SYMBOL], tmp_path)

    entry = store.read_manifest(tmp_path)["sources"]["tushare"]
    assert entry["markets"] == ["a_share"]
    assert entry["units_by_market"]["a_share"] == {
        "volume_unit": "lots", "amount_unit": "cny_thousand",
    }


def test_dry_run_writes_no_manifest(tmp_path: Path) -> None:
    source = FakeSource({_SYMBOL: (bars_frame(SESSIONS), factor_frame(SESSIONS, [1.0] * 4))})

    run(source, [_SYMBOL], tmp_path, dry_run=True)

    assert store.read_manifest(tmp_path) == {}


def test_progress_lines_are_emitted_for_every_symbol(tmp_path: Path) -> None:
    source = FakeSource(
        {
            _SYMBOL: (bars_frame(SESSIONS), factor_frame(SESSIONS, [1.0] * 4)),
            _OTHER: (bars_frame(SESSIONS), factor_frame(SESSIONS, [1.0] * 4)),
        }
    )
    lines: list[str] = []

    run(source, [_SYMBOL, _OTHER], tmp_path, progress=lines.append)

    assert len(lines) == 2
    assert all("4 new" in line for line in lines)


# ---------------------------------------------------------------------------
# Window arithmetic
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "entry, start, years, expected",
    [
        (None, None, 10, "backfill"),
        ({"last": "2020-01-09"}, None, 10, "current"),
        ({"last": "2019-01-09"}, None, 10, "increment"),
        ({"last": "2019-01-09", "pending_dates": ["2018-12-20"]}, None, 10, "hole-repair"),
        ({"last": "2019-01-09"}, "2015-01-01", 10, "re-anchor"),
        (None, "2015-01-01", 10, "backfill"),
    ],
)
def test_resolve_window_picks_the_mode_from_what_is_stored(
    entry: dict[str, Any] | None, start: str | None, years: int, expected: str
) -> None:
    _begin, _end, mode = sync.resolve_window(entry, start=start, end=None, years=years, today=_TODAY)

    assert mode == expected


def test_a_hole_inside_the_stored_range_pulls_the_start_back_only_to_the_hole(
    tmp_path: Path,
) -> None:
    entry = {"first": "2019-01-02", "last": "2020-01-09", "pending_dates": ["2019-06-03"]}

    begin, end, mode = sync.resolve_window(entry, start=None, end=None, years=10, today=_TODAY)

    assert mode == "hole-repair"
    assert begin == "2019-06-03" and end == "2020-01-09"


def test_an_explicit_end_is_capped_at_the_settled_session() -> None:
    _begin, end, _mode = sync.resolve_window(
        None, start=None, end="2020-06-30", years=10, today=_TODAY
    )

    assert end == "2020-01-09", "--end cannot ask for a day whose bar is still open"


def test_settled_end_is_yesterday() -> None:
    assert sync.settled_end(today=pd.Timestamp("2020-01-10 15:30")) == pd.Timestamp("2020-01-09")


def test_a_non_positive_history_depth_is_refused() -> None:
    with pytest.raises(ValueError, match="years must be positive"):
        sync.resolve_window(None, start=None, end=None, years=0)


def test_a_source_without_an_api_cannot_resolve_a_named_universe() -> None:
    with pytest.raises(sync.SyncConfigError, match="index-weight"):
        sync.resolve_universe("csi300", start="2020-01-01", end="2020-01-31", loader=FakeSource())


def test_an_unknown_universe_is_refused_rather_than_guessed() -> None:
    class WithApi(FakeSource):
        api = object()

    with pytest.raises(sync.SyncConfigError, match="not resolvable here"):
        sync.resolve_universe("csi1000", start="2020-01-01", end="2020-01-31", loader=WithApi())


# ---------------------------------------------------------------------------
# Universe roster persistence
# ---------------------------------------------------------------------------


def _roster(*, membership: pd.DataFrame | None) -> sync.UniverseRoster:
    return sync.UniverseRoster(
        universe="csi300",
        codes=[_SYMBOL, _OTHER],
        membership=membership,
        constituent_source="tushare index_weight",
        constituent_source_date="2020-01-03",
    )


def test_the_roster_lands_on_disk_with_its_provenance(tmp_path: Path) -> None:
    membership = pd.DataFrame(
        {_SYMBOL: [True], _OTHER: [False]}, index=pd.DatetimeIndex(["2020-01-03"])
    )

    path = _roster(membership=membership).persist(root=tmp_path)

    assert path is not None and path.is_file()
    read_back, meta = store.read_universe_roster("csi300", root=tmp_path)
    assert list(read_back.columns) == [_SYMBOL], "only the True cells are stored"
    assert list(read_back.index) == [pd.Timestamp("2020-01-03")]
    assert meta["constituent_source"] == "tushare index_weight"
    assert meta["constituent_source_date"] == "2020-01-03"
    assert meta["constituent_count"] == 1, "only the member of that snapshot is stored"


def test_an_unresolved_roster_is_not_stored_as_an_empty_one(tmp_path: Path) -> None:
    """Absent and empty mean different things; only absent is honest."""
    assert _roster(membership=None).persist(root=tmp_path) is None
    assert not (tmp_path / "universe").exists()

    read_back, meta = store.read_universe_roster("csi300", root=tmp_path)
    assert read_back is None and meta == {}


def test_a_dry_run_does_not_write_the_roster(tmp_path: Path) -> None:
    membership = pd.DataFrame({_SYMBOL: [True]}, index=pd.DatetimeIndex(["2020-01-03"]))

    assert _roster(membership=membership).persist(root=tmp_path, dry_run=True) is None
    assert not (tmp_path / "universe").exists()


def test_a_roster_without_a_matrix_is_flagged_as_not_point_in_time() -> None:
    assert _roster(membership=None).pit_membership is False
    assert _roster(membership=pd.DataFrame({_SYMBOL: [True]}, index=pd.DatetimeIndex(["2020-01-03"]))).pit_membership is True


def test_the_report_digest_names_the_pending_and_failed_work(tmp_path: Path) -> None:
    source = FakeSource(
        {
            _SYMBOL: (bars_frame(SESSIONS), factor_frame(SESSIONS[:3], [1.0, 1.0, 1.0])),
            _OTHER: (bars_frame(SESSIONS), factor_frame(SESSIONS, [1.0] * 4)),
        },
        errors={},
    )

    report = run(source, [_SYMBOL, _OTHER], tmp_path)

    digest = report.summary()
    assert digest.startswith(
        "tushare/1D: 2 symbol(s), 7 row(s) written (7 new) into 1 partition(s)"
    )
    assert "1 session(s) still waiting on an adjustment factor" in digest
    assert report.problems() == [
        "600519.SH: 1 session(s) waiting on an adjustment factor (2020-01-09)"
    ]


def test_the_write_gate_error_path_is_a_refusal_not_a_crash(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A gate that raises mid-run must be attributed to its symbol."""

    def explode(*_args, **_kwargs):
        raise WarehouseConfigError("synthetic gate failure")

    monkeypatch.setattr(sync, "normalize_bars", explode)
    source = FakeSource({_SYMBOL: (bars_frame(SESSIONS), factor_frame(SESSIONS, [1.0] * 4))})

    report = run(source, [_SYMBOL], tmp_path)

    assert report.symbols[0].status == "refused"
    assert "synthetic gate failure" in (report.symbols[0].error or "")
