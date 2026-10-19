"""Folding base bars into a multiplier interval — bar-for-bar, hand-checked.

Every numeric claim here is a hand-written vector, not a re-run of the
implementation's own expression. The four shapes worth the ink:

* the OHLCV rule is the one the weekly merge already uses (open = group's first,
  close = its last, high/low = extremes, volume = sum, timestamp = **first**);
* a minute fold is anchored **inside a trading session** — stitching the A-share
  lunch break into one 120-minute bar would draw a candle that never existed;
* the anchor is absolute (a day's ordinal, a week's ordinal, a bar's position in
  its session), never "the index inside whatever this page happened to fetch", so
  paging cannot repaint the tape;
* a fold of a prefix equals the prefix of the fold — the same invariant that makes
  an indicator free of lookahead, applied to the data path itself.

The `k == 1` shape pins referee themselves against `_legacy_merge_reference` below —
a frozen copy of the merge as it ran before the fold existed — because the live
`_merge_to_calendar` is now a one-line delegation to `fold_bars`, and a wrapper can
never refute the expression it delegates to.

Nothing here opens a socket. The daily/minute channels are fed literal bars.
"""

from __future__ import annotations

import zoneinfo
from datetime import datetime, timezone
from typing import Any

import pandas as pd
import pytest

from src.api import interval_spec as spec_mod
from src.api import market_routes
from src.api.interval_spec import (
    MONTH_SECONDS,
    WEEK_SECONDS,
    IntervalSpec,
    bar_seconds,
    calendar_fold_spec,
    fold_bars,
    fold_by_keys,
    fold_spec,
    parse_interval,
)

DAY_MS = 86_400_000
SH = "Asia/Shanghai"


def _day_ms(label: str) -> int:
    """Epoch ms of a trading-day *label* — midnight UTC, exactly as daily bars carry it."""
    return int(pd.Timestamp(label, tz="UTC").timestamp() * 1000)


def _bar(label: str, price: float, volume: float = 100.0) -> dict:
    return {
        "timestamp": _day_ms(label),
        "open": price,
        "high": price + 1.0,
        "low": price - 1.0,
        "close": price + 0.5,
        "volume": volume,
    }


def _weekdays(start: str, n: int) -> list[str]:
    return [d.strftime("%Y-%m-%d") for d in pd.bdate_range(start, periods=n)]


def _daily_series(days: list[str]) -> list[dict]:
    return [_bar(d, 10.0 + i * 0.1, volume=100.0 + i) for i, d in enumerate(days)]


def _minute_label(label: str, hhmm: str, zone: str = SH) -> int:
    """Epoch ms of an exchange wall-clock minute, stamped the way `_bars_from_frame` does."""
    naive = datetime.strptime(f"{label} {hhmm}", "%Y-%m-%d %H:%M")
    return int(naive.replace(tzinfo=zoneinfo.ZoneInfo(zone)).timestamp() * 1000)


#: Frozen oracle, lifted from `agent/src/api/market_routes.py` as it stood at
#: `41c75b0c` (`_calendar_group_key` at `:471-491`, `_merge_to_calendar` at `:494-516`),
#: read out with `git show 41c75b0c:agent/src/api/market_routes.py`. Every executable
#: statement below is byte-identical to that text; the only edits are the two names —
#: the key function is suffixed `_legacy_` and called under that name, so this copy
#: cannot accidentally referee the live one — and the docstring prose, which lives in
#: the archive. It exists because the task's headline judgement is 「k=1 与既有折叠逐字
#: 同形」, and the only witness to a fold that must not be vacuous is the code that ran
#: before it. Test-only on purpose: production keeps one merge, the delegating
#: `_merge_to_calendar`, never a second copy the tests could keep alive.
def _legacy_calendar_group_key(ts_ms: int, unit: str) -> tuple[int, int]:
    day = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
    if unit == "week":
        iso = day.isocalendar()
        return (int(iso[0]), int(iso[1]))
    return (day.year, day.month)


def _legacy_merge_reference(bars: list[dict], unit: str) -> list[dict]:
    merged: list[dict[str, Any]] = []
    group: tuple[int, int] | None = None
    for bar in sorted(bars, key=lambda b: int(b["timestamp"])):
        key = _legacy_calendar_group_key(int(bar["timestamp"]), unit)
        if key != group:
            group = key
            merged.append(dict(bar))
            continue
        held = merged[-1]
        held["high"] = max(float(held["high"]), float(bar["high"]))
        held["low"] = min(float(held["low"]), float(bar["low"]))
        held["close"] = float(bar["close"])
        held["volume"] = float(held["volume"] or 0.0) + float(bar["volume"] or 0.0)
    return merged


class TestHandComputedVector:
    def test_a_two_day_fold_is_the_vector_arithmetic_says_it_is(self):
        """Tue 2026-06-02 + Wed 2026-06-03 weld into one bar, on the calendar's say-so.

        The anchor is the absolute epoch-day ordinal (design §2.2), and 2026-06-02
        is day 20606 — even, so it opens a group and 20607 lands inside it. Picking
        the pair by arithmetic instead of by wish is the point: the same table read
        off "the first two bars of the page" would redraw on every page.
        """
        bars = [_bar("2026-06-02", 10.0, 100.0), _bar("2026-06-03", 12.0, 50.0)]
        (folded,) = fold_bars(bars, fold_spec("1D", 2))
        assert folded["timestamp"] == _day_ms("2026-06-02")  # the group's FIRST bar
        assert folded["open"] == 10.0
        assert folded["high"] == 13.0  # day two's high is 12 + 1
        assert folded["low"] == 9.0  # day one's low
        assert folded["close"] == 12.5  # day two's close
        assert folded["volume"] == 150.0

    def test_a_monday_that_a_weekend_left_alone_stays_alone(self):
        """Design §2.2's accepted cost, pinned rather than smoothed: no bar is invented.

        2026-06-01 (Mon) is day 20605, odd, so its partner would be 20531 = Sunday —
        no bar. Thursday and Friday do weld. So one trading week under a `2D`
        multiplier is three served bars, and a holiday week can be two; the fold
        comes back short and never pads.
        """
        days = _weekdays("2026-06-01", 5)  # Mon 1 … Fri 5
        folded = fold_bars(_daily_series(days), fold_spec("1D", 2))
        assert [b["open"] for b in folded] == [
            _bar(days[0], 10.0)["open"],  # Jun 1, alone
            _bar(days[1], 10.1)["open"],  # Jun 2 + Jun 3
            _bar(days[3], 10.3)["open"],  # Jun 4 + Jun 5
        ]
        assert [b["timestamp"] for b in folded] == [
            _day_ms(d) for d in ("2026-06-01", "2026-06-02", "2026-06-04")
        ]


class TestMinuteSessionAnchor:
    """The 120-minute fold of an A-share day is two bars, not one stitched across lunch."""

    def _sixty(self, label: str, zone: str = SH) -> list[dict]:
        # 60-minute bars close at 10:30 / 11:30 / 14:00 / 15:00 (the shape this repo's
        # own 分时 path records; the reason is in the design doc §2.1).
        out = []
        for i, hhmm in enumerate(("10:30", "11:30", "14:00", "15:00")):
            stamp = _minute_label(label, hhmm, zone)
            out.append(
                {
                    "timestamp": stamp,
                    "open": 10.0 + i,
                    "high": 11.0 + i,
                    "low": 9.0 + i,
                    "close": 10.5 + i,
                    "volume": 100.0 + i,
                }
            )
        return out

    def test_the_lunch_break_is_never_stitched_into_one_bar(self):
        bars = self._sixty("2026-06-01")
        folded = fold_bars(bars, IntervalSpec("minute-fold", "60m", 2, ""), SH)
        assert len(folded) == 2
        assert [b["timestamp"] for b in folded] == [bars[0]["timestamp"], bars[2]["timestamp"]]
        assert folded[0]["open"] == 10.0 and folded[0]["close"] == 11.5
        assert folded[0]["high"] == 12.0 and folded[0]["low"] == 9.0
        assert folded[1]["open"] == 12.0 and folded[1]["close"] == 13.5
        # What this proves: the two served bars are not the two halves of one
        # continuous 120-minute chain — the second does not open where the first
        # closed, so the lunch gap stays *between* bars instead of inside one.
        # What it does NOT prove: any separation of the session anchor from a
        # UTC-minute floor. Asia/Shanghai is +8 = 480 minutes, an exact multiple of
        # this fold's 120-minute width, so the floor's buckets land on the session
        # boundary and return byte-identical bars here. The floor is refuted by the
        # offset-clock pin below, which is the one that can tell them apart.
        assert folded[0]["close"] != folded[1]["open"]

    def test_a_utc_minute_floor_would_split_the_morning_pair_on_an_offset_clock(self):
        """The same four bars on a +5:30 clock: session anchor serves 2, floor serves 3.

        The anchor arithmetic Shanghai cannot test. `Asia/Kolkata` is UTC+5:30 — 330
        minutes — and 330 % (2 × 60) = 90, so a `ts_ms // (k * base_ms)` floor no
        longer lines its buckets up with the session boundary: 10:30 and 11:30 fall in
        different buckets, the first served bar closes at 10.5 with volume 100, and the
        fold returns three bars. The delivered anchor counts positions *inside* the
        session, so the offset changes nothing — [10:30, 11:30] and [14:00, 15:00],
        the same two bars it serves on every clock.

        `Asia/Kolkata` here is a witness for the offset remainder, not a market this
        repo routes: `_MINUTE_WALL_CLOCK_ZONE` carries no India entry, and the four
        closing labels are this repo's A-share shape read off a +5:30 clock.
        """
        bars = self._sixty("2026-06-01", "Asia/Kolkata")
        folded = fold_bars(bars, IntervalSpec("minute-fold", "60m", 2, ""), "Asia/Kolkata")
        assert len(folded) == 2  # the floor of the same width returns 3
        assert [b["timestamp"] for b in folded] == [bars[0]["timestamp"], bars[2]["timestamp"]]
        assert folded[0]["open"] == 10.0 and folded[0]["close"] == 11.5  # floor: 10.5
        assert folded[0]["high"] == 12.0 and folded[0]["low"] == 9.0
        assert folded[0]["volume"] == 201.0  # 100 + 101; the floor would say 100.0
        assert folded[1]["open"] == 12.0 and folded[1]["close"] == 13.5
        assert folded[1]["volume"] == 205.0  # 102 + 103

    def test_the_fold_drops_across_sessions_rather_than_spanning_them(self):
        bars = self._sixty("2026-06-01") + self._sixty("2026-06-02")
        folded = fold_bars(bars, IntervalSpec("minute-fold", "60m", 2, ""), SH)
        assert len(folded) == 4
        assert folded[1]["timestamp"] == _minute_label("2026-06-01", "14:00")
        assert folded[2]["timestamp"] == _minute_label("2026-06-02", "10:30")

    def test_a_prime_minute_count_folds_off_the_one_minute_base(self):
        bars = self._sixty("2026-06-01")  # reuse as 1m bars, times irrelevant
        one_minute = [dict(b, timestamp=b["timestamp"] + i * 60_000) for i, b in enumerate(bars)]
        folded = fold_bars(one_minute, IntervalSpec("minute-fold", "1m", 3, ""), SH)
        assert len(folded) == 2  # four 1m bars -> groups (0,1,2) and (3,)
        assert folded[0]["timestamp"] == one_minute[0]["timestamp"]
        assert folded[0]["volume"] == 303.0  # 100 + 101 + 102; the fourth bar is its own group
        assert folded[1]["volume"] == 103.0

    def test_a_minute_fold_without_an_exchange_clock_is_refused(self):
        with pytest.raises(ValueError, match="exchange clock"):
            fold_bars(self._sixty("2026-06-01"), IntervalSpec("minute-fold", "60m", 2, ""))

    def test_a_ninety_minute_fold_welds_across_the_midday_gap_by_design(self):
        """Known behaviour, pinned so nobody later reads it as an accident.

        ``90m`` is ``30m`` × 3 and both spellings are reachable through
        :func:`parse_interval` today. The anchor groups by *position inside the day*,
        and an A-share day holds eight 30-minute bars (10:00 / 10:30 / 11:00 / 11:30,
        then 13:30 / 14:00 / 14:30 / 15:00), so positions 3-5 weld into one served bar:
        the 11:30, the 13:30 and the 14:00 bar. That group spans the lunch break — the
        guarantee the anchor actually gives is *never crossing a day or session
        boundary*, not never crossing the midday gap, and
        ``interval_spec._session_position_keys``'s docstring now says exactly that.
        Refusing a ``k`` that does not divide the morning block would need an exchange
        session table this repo holds no forensic basis for, so the straddle is served,
        named, and pinned here.
        """
        closes = ("10:00", "10:30", "11:00", "11:30", "13:30", "14:00", "14:30", "15:00")
        bars = [
            {
                "timestamp": _minute_label("2026-06-01", hhmm),
                "open": 1.0 + i,
                "high": 2.0 + i,
                "low": 0.5,
                "close": 1.5 + i,
                "volume": 10.0,
            }
            for i, hhmm in enumerate(closes)
        ]
        assert (parse_interval("90m").base, parse_interval("90m").k) == ("30m", 3)
        folded = fold_bars(bars, parse_interval("90m"), SH)
        assert len(folded) == 3
        assert [b["timestamp"] for b in folded] == [
            _minute_label("2026-06-01", t) for t in ("10:00", "11:30", "14:30")
        ]
        straddle = folded[1]
        assert straddle["open"] == 4.0 and straddle["close"] == 6.5  # 11:30 opens, 14:00 closes
        assert straddle["high"] == 7.0 and straddle["low"] == 0.5
        assert straddle["volume"] == 30.0  # three base bars, the midday gap between them


class TestFoldByKeysLengthGuard:
    """`fold_by_keys` takes two lists it cannot verify against each other — so it checks."""

    def test_a_key_list_that_is_not_the_bar_list_raises_instead_of_truncating(self):
        bars = _daily_series(_weekdays("2026-06-01", 3))
        with pytest.raises(ValueError, match="fold keys off the bar list"):
            fold_by_keys(bars, [0, 1])


class TestPrefixInvariant:
    """A fold never uses a bar to its right — the future-function probe on the data path."""

    def test_folding_a_prefix_is_the_prefix_of_the_full_fold(self):
        days = _weekdays("2024-01-01", 130)
        bars = _daily_series(days)
        for spec in (fold_spec("1D", 2), fold_spec("1D", 5), fold_spec("1W", 2), fold_spec("1M", 3)):
            full = fold_bars(bars, spec)
            for cut in (30, 31, 77, 120):
                # Every group but the last is complete on both sides; the tail group is
                # the only one a cut can leave short, so it drops out of the comparison
                # instead of being excused by a comment. This is the future-function
                # probe on the fold: nothing to the right of bar `cut` can move a bar.
                # 31 is the one that earns its place: this 130-weekday set ends on ISO
                # week ordinal 2842, and cuts 30 / 77 / 120 each end on an *even*
                # newest week (2822 / 2832 / 2840), so pairing those weeks from the
                # newest one backwards — a pure lookahead — lands on exactly the same
                # pairs as the absolute ordinal and stays green. Bar 31 ends on Monday
                # 2024-02-12, week ordinal 2823, odd, and that is where right- and
                # left-pairing split. (The monthly leg already bites at 77: month
                # ordinal 24291 versus the full window's 24293 is not a multiple of 3.)
                head = fold_bars(bars[:cut], spec)
                assert head[:-1] == full[: len(head) - 1], (spec, cut)

    def test_minute_fold_is_also_a_prefix_function(self):
        base = [
            {
                "timestamp": _minute_label("2026-06-01", "09:30") + i * 60_000,
                "open": 1.0 + i,
                "high": 2.0 + i,
                "low": 0.5 + i,
                "close": 1.5 + i,
                "volume": 10.0,
            }
            for i in range(30)
        ]
        spec = IntervalSpec("minute-fold", "1m", 7, "")
        full = fold_bars(base, spec, SH)
        for cut in (9, 15, 21):
            head = fold_bars(base[:cut], spec, SH)
            assert head[:-1] == full[:len(head) - 1]


class TestCalendarOrdinals:
    def test_the_ordinal_relabels_exactly_the_partition_the_pair_describes(self):
        days = _weekdays("2025-11-03", 60)
        for unit in ("week", "month"):
            pairs = [spec_mod.calendar_group_key(_day_ms(d), unit) for d in days]
            ordinals = [spec_mod.calendar_group_ordinal(p, unit) for p in pairs]
            assert len(set(ordinals)) == len(set(pairs))  # injective: no two weeks collide
            assert [ordinals.index(o) for o in ordinals] == [pairs.index(p) for p in pairs]

    def test_the_new_year_week_is_one_group_however_the_year_is_numbered(self):
        # Mon 29 Dec 2025 – Fri 2 Jan 2026 is ISO 2026-W01; 26 Dec 2025 is 2025-W52.
        straddling = [_day_ms(d) for d in ("2025-12-29", "2025-12-30", "2025-12-31",
                                           "2026-01-01", "2026-01-02")]
        keys = {spec_mod.calendar_group_key(ts, "week") for ts in straddling}
        assert len(keys) == 1
        ordinals = {spec_mod.calendar_group_ordinal(k, "week") for k in keys}
        assert len(ordinals) == 1

    def test_two_weeks_fold_the_straddling_week_whole(self):
        """The weld pairs *whole* natural weeks, so a year boundary cannot split one.

        Read the table off the calendar: ``2025-12-08`` starts ISO 2025-W50, and the
        twenty trading days run W50 (08–12), W51 (15–19), W52 (22–26) and 2026-W01
        (29–02, five days that straddle the year). Two-fold therefore welds W50+W51
        and W52+2026-W01 — the straddling week is the *second half* of the second
        served bar, and none of its five days may reach into a third bar.
        """
        days = _weekdays("2025-12-08", 20)
        members = _daily_series(days)
        folded = fold_bars(members, fold_spec("1W", 2))
        assert len(folded) == 2
        assert [b["timestamp"] for b in folded] == [
            _day_ms("2025-12-08"), _day_ms("2025-12-22")
        ]
        straddle = [_day_ms(d) for d in ("2025-12-29", "2025-12-30", "2025-12-31",
                                         "2026-01-01", "2026-01-02")]
        start, end = folded[1]["timestamp"], folded[1]["timestamp"] + 2 * 7 * DAY_MS
        assert all(start <= ts < end for ts in straddle)
        assert folded[1]["open"] == members[10]["open"]    # 2025-12-22, first day of W52
        assert folded[1]["close"] == members[-1]["close"]  # 2026-01-02, last day of 2026-W01

    def test_k_equals_one_reproduces_the_merge_the_daily_chain_already_did(self):
        """The shape every existing caller uses must still *group*, not pass through.

        ``fold_spec("1W", 1)`` is native — that is what ``1W`` means on the wire. The
        calendar merge is the opposite case: its ``k == 1`` default welds one natural
        group at a time, which is the merge that has always run. So the merge asks for
        a grouping spec directly, and this pin is the bar-for-bar proof that a
        multiplier-less fold still collapses (裁定四).

        The equality goes to ``_legacy_merge_reference``, the frozen pre-fold merge —
        not to ``_merge_to_calendar``, which since this task is a one-line delegation to
        the very call being tested and could not fail however the fold were written.
        """
        days = _weekdays("2024-06-05", 120)
        bars = _daily_series(days)
        for unit, base in (("week", "1W"), ("month", "1M")):
            folded = fold_bars(bars, calendar_fold_spec(unit, 1))
            assert len(folded) < len(bars), unit
            assert folded == _legacy_merge_reference(bars, unit), unit

    def test_the_default_multiplier_is_the_same_call_as_saying_one(self):
        """The merge's default ``k`` is still 1, pinned against the frozen merge.

        ``_merge_to_calendar(bars, unit) == _merge_to_calendar(bars, unit, 1)`` is the
        wrapper equalled with itself and carries no information either, so each form is
        pinned against ``_legacy_merge_reference``: a default that drifted to 2 would
        weld two natural groups where the old merge welded one, and the explicit-1 call
        would keep answering correctly — which is exactly the drift this pair catches.
        """
        days = _weekdays("2026-06-01", 10)
        bars = _daily_series(days)
        for unit in ("week", "month"):
            reference = _legacy_merge_reference(bars, unit)
            assert market_routes._merge_to_calendar(bars, unit) == reference, unit
            assert market_routes._merge_to_calendar(bars, unit, 1) == reference, unit

    def test_the_two_spellings_of_one_week_request_disagree_only_in_kind(self):
        """``1W`` is native to the parser and a grouping fold to the merge.

        Both are right and both must stay reachable, so the difference is pinned here
        instead of being hidden by making one shape serve both jobs: the router sends a
        native ``1W`` to the four-arg daily walk, which then merges; only a
        multiplier-beyond-one reaches ``fold_bars`` through ``spec.kind``.
        """
        native = parse_interval("1W")
        grouped = calendar_fold_spec("week", 1)
        assert (native.kind, grouped.kind) == ("native", "calendar-fold")
        assert native.interval == grouped.interval == "1W"
        assert native.base == grouped.base and native.k == grouped.k == 1

    def test_monthly_fold_is_three_month_groups(self):
        days = _weekdays("2026-01-01", 60)  # Jan..Mar 2026 trading days
        folded = fold_bars(_daily_series(days), fold_spec("1M", 3))
        assert len(folded) == 1
        assert folded[0]["timestamp"] == _day_ms(days[0])


class TestMergeToCalendarStillAnswersTheOldCall:
    def test_the_two_argument_form_is_the_native_merge(self):
        """Every caller that never mentions `k` still gets the old merge.

        Again against the frozen copy: `_merge_to_calendar(bars, "week")` folded through
        the new spec has to come back the bar-for-bar merge of `41c75b0c`, or every
        weekly chart in the repo changed shape without anyone asking.
        """
        days = _weekdays("2026-06-01", 10)
        bars = _daily_series(days)
        assert market_routes._merge_to_calendar(bars, "week") == _legacy_merge_reference(
            bars, "week"
        )
        assert market_routes._merge_to_calendar(bars, "month") == _legacy_merge_reference(
            bars, "month"
        )


class TestServedBarWidth:
    """The specs this task hands the router must size the fetch they imply."""

    def test_a_calendar_multiplier_widens_the_served_bar_by_exactly_that_multiple(self):
        """`2W` is two weeks of bars and `2M` two months — off the spec's own base.

        Task 1's fix round made :func:`bar_seconds` derive the width from ``spec.base``
        alone and raise for anything outside ``NATIVE_INTERVALS``. Nothing here asks it
        to bend: ``calendar_fold_spec`` writes a real ``1W`` / ``1M`` base into the spec,
        so the multiplier lands on top of a width the guard already knows. A month is
        priced at its **widest** (31 days) for the same reason ``udf_routes`` priced it
        that way — a window sized from it can only overshoot and be trimmed, never clip
        a page short.
        """
        assert bar_seconds(calendar_fold_spec("week", 2)) == 2 * WEEK_SECONDS
        assert bar_seconds(calendar_fold_spec("month", 2)) == 2 * MONTH_SECONDS


def _client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    market_routes.register_market_routes(app, require_auth=lambda: None)
    return TestClient(app)


class TestRouteServesFolds:
    def test_a_two_day_request_is_the_fold_of_the_daily_chain(self, monkeypatch):
        days = _weekdays("2026-06-01", 40)
        bars_in = _daily_series(days)

        def fake(symbol, count, before):
            return bars_in[-count:], "backtest:test_chain"

        monkeypatch.setattr(market_routes, "_fetch_daily", fake)
        out = market_routes._kline_sync("600519.SH", "2D", 10, "qfq")
        assert out["interval"] == "2D"
        assert out["source"] == "backtest:test_chain+2D"
        assert out["bars"] == fold_bars(bars_in, fold_spec("1D", 2))[-10:]
        assert set(out) == {"status", "symbol", "interval", "source", "bars"}

    def test_two_pages_cut_at_different_before_agree_where_they_overlap(self, monkeypatch):
        """Design §4.2's paging leg: the anchor is the calendar's, never the page's.

        The stub honours `before` the way every real channel does (drop the bars at
        or after the cursor, then take the tail), so page two really is a different
        slice of the same chain. Grouping by "the Nth bar I happened to fetch" would
        pass a single-page test and then redraw the chart on the first scroll — this
        is the only pin that can see that, and it is why the fold keys on an
        absolute ordinal.
        """
        days = _weekdays("2026-03-02", 40)
        chain = _daily_series(days)

        def fake(symbol, count, before):
            pool = [b for b in chain if before is None or b["timestamp"] < before]
            return pool[-count:], "backtest:test_chain"

        monkeypatch.setattr(market_routes, "_fetch_daily", fake)
        page_one = market_routes._kline_sync("600519.SH", "2D", 6, "qfq")["bars"]
        page_two = market_routes._kline_sync(
            "600519.SH", "2D", 6, "qfq", before=page_one[-1]["timestamp"]
        )["bars"]
        assert page_two[-1]["timestamp"] < page_one[-1]["timestamp"]
        shared = [b for b in page_two if b["timestamp"] >= page_one[0]["timestamp"]]
        assert shared == page_one[: len(shared)]

    def test_the_daily_walk_is_scaled_by_the_multiplier(self, monkeypatch):
        asked: list[int] = []

        def fake(symbol, count, before):
            asked.append(count)
            return _daily_series(_weekdays("2020-01-01", count)), "backtest:test_chain"

        monkeypatch.setattr(market_routes, "_fetch_daily", fake)
        market_routes._kline_sync("600519.SH", "3W", 20, "qfq")
        assert asked == [20 * 8 * 3 + 30 * 3]  # per_bar 8, one margin per folded bar
        market_routes._kline_sync("600519.SH", "1W", 20, "qfq")
        assert asked[-1] == 20 * 8 + 30  # k = 1 is the old sizing, verbatim

    def test_the_daily_fold_asks_for_k_daily_bars_plus_the_leftover(self, monkeypatch):
        asked: list[int] = []

        def fake(symbol, count, before):
            asked.append(count)
            return _daily_series(_weekdays("2024-01-01", count)), "backtest:test_chain"

        monkeypatch.setattr(market_routes, "_fetch_daily", fake)
        market_routes._kline_sync("600519.SH", "2D", 30, "qfq")
        assert asked == [30 * 1 * 2 + 30 * 2]  # per_bar 1 for a daily base, margin × k too

    def test_a_minute_fold_asks_the_base_channel_for_k_times_the_bars(self, monkeypatch):
        """50 served bars of 120m asks the 60-minute channel for 101 base bars.

        The stub lays the base bars out the way an A-share tape really is — four 60m
        closes per trading day at 10:30 / 11:30 / 14:00 / 15:00 — because the anchor
        being tested is the session, and a stub that ran bars straight through the
        night would fold into groups no exchange ever produces. 101 = 25 whole days
        plus one orphan bar, so the fold has 51 groups and the leftover-orphan tail
        is what `count` then trims.
        """
        seen: list[tuple[str, int]] = []
        session_close_times = ("10:30", "11:30", "14:00", "15:00")

        def fake_minute(symbol, interval, count, adjust, before):
            seen.append((interval, count))
            days = _weekdays("2026-06-01", -(-count // 4))
            return [
                {
                    "timestamp": _minute_label(days[i // 4], session_close_times[i % 4]),
                    "open": 1.0 + i,
                    "high": 2.0 + i,
                    "low": 0.5,
                    "close": 1.5 + i,
                    "volume": 10.0,
                }
                for i in range(count)
            ]

        monkeypatch.setattr(market_routes, "_futu_minute_bars", fake_minute)
        out = market_routes._kline_sync("600519.SH", "120m", 50, "qfq")
        assert seen == [("60m", 50 * 2 + 2 - 1)]
        assert out["interval"] == "120m"
        assert out["source"].endswith("+120m")
        assert len(out["bars"]) == 50

    def test_a_page_that_cannot_be_filled_comes_back_short_and_says_so(self, monkeypatch):
        """设计 §6 那条「如实少返」的判据：不补根，靠 bars 与 source 自己说话。"""
        only = _daily_series(_weekdays("2026-06-01", 4))

        def fake(symbol, count, before):
            return only, "backtest:test_chain"

        monkeypatch.setattr(market_routes, "_fetch_daily", fake)
        out = market_routes._kline_sync("600519.SH", "2D", 10, "qfq")
        assert len(out["bars"]) < 10
        assert out["source"] == "backtest:test_chain+2D"

    def test_the_full_window_drops_the_leftover_group_like_the_weekly_merge_does(self, monkeypatch):
        """An exactly-satisfied ask means the chain ran further left, so the first fold is a stub.

        Same rule `_fetch_calendar_bars` already applies to weekly bars, carried to the
        multiplier — and the stub is built to *hit* it: `len(bars) == dailies`, which is
        how the pin knows the drop branch is the one that ran.
        """
        dailies = 40 * 2 + 30 * 2  # count * per_bar * k + margin * k
        chain = _daily_series(_weekdays("2026-06-01", dailies))

        def fake(symbol, count, before):
            assert count == dailies, count
            return chain, "backtest:test_chain"

        monkeypatch.setattr(market_routes, "_fetch_daily", fake)
        out = market_routes._kline_sync("600519.SH", "2D", 40, "qfq")
        assert out["bars"] == fold_bars(chain, fold_spec("1D", 2))[1:][-40:]


class TestRouteRefusals:
    def test_a_fold_with_session_latest_names_the_fold_not_the_day(self, monkeypatch):
        monkeypatch.setattr(market_routes, "_fetch_daily", lambda *a, **k: ([], "x"))
        with pytest.raises(ValueError, match="folded") as exc:
            market_routes._kline_sync("600519.SH", "2D", 100, "qfq", session="latest")
        assert "already are one day each" not in str(exc.value)

    def test_a_minute_fold_with_session_latest_is_refused_the_same_way(self, monkeypatch):
        monkeypatch.setattr(
            market_routes, "_futu_minute_bars",
            lambda symbol, interval, count, adjust, before: [
                {"timestamp": _minute_label("2026-06-01", "10:30") + i * 3_600_000,
                 "open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5, "volume": 1.0}
                for i in range(count)
            ],
        )
        with pytest.raises(ValueError, match="folded"):
            market_routes._kline_sync("600519.SH", "120m", 10, "qfq", session="latest")

    def test_the_native_refusals_still_say_what_they_said(self, monkeypatch):
        """设计 §2.1：那两句既有文案一字不改，因为它俩说的是真话。"""
        monkeypatch.setattr(market_routes, "_fetch_daily", lambda *a, **k: ([], "x"))
        with pytest.raises(ValueError, match="1W bars are merged from daily"):
            market_routes._kline_sync("600519.SH", "1W", 100, "qfq", session="latest")
        with pytest.raises(ValueError, match="daily bars already are one day each"):
            market_routes._kline_sync("600519.SH", "1D", 100, "qfq", session="latest")

    def test_an_unserviceable_interval_names_the_rule_and_the_bases(self):
        res = _client().get("/market/kline?symbol=600519.SH&interval=2.5m")
        assert res.status_code == 400
        body = res.json()["error"]
        assert "'2.5m'" in body
        for base in ("1D", "1W", "1M"):
            assert base in body, body
        assert "multiplier" in body, body


class TestRouteDoc:
    def _interval_description(self) -> str:
        client = _client()
        schema = client.app.openapi()
        params = schema["paths"]["/market/kline"]["get"]["parameters"]
        return [p for p in params if p["name"] == "interval"][0]["description"]

    def test_the_route_doc_describes_a_rule_not_a_dead_list(self):
        """Carries the judgment: the old text was a closed list of eight literals.

        The eight base spellings still appear (they are the bases), so only the two
        assertions below actually separate the new copy from the old.
        """
        description = self._interval_description()
        assert "multiplier" in description, description
        assert "120m" in description, description
