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

Nothing here opens a socket. The daily/minute channels are fed literal bars.
"""

from __future__ import annotations

import zoneinfo
from datetime import datetime

import pandas as pd
import pytest

from src.api import interval_spec as spec_mod
from src.api import market_routes
from src.api.interval_spec import (
    IntervalSpec,
    calendar_fold_spec,
    fold_bars,
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

    def _sixty(self, label: str) -> list[dict]:
        # 60-minute bars close at 10:30 / 11:30 / 14:00 / 15:00 (the shape this repo's
        # own 分时 path records; the reason is in the design doc §2.1).
        out = []
        for i, hhmm in enumerate(("10:30", "11:30", "14:00", "15:00")):
            stamp = _minute_label(label, hhmm)
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
        # The stitched bar would have this number; asserting it is NOT there is the
        # whole point of the pin — a UTC-minute floor produces exactly that shape.
        assert folded[0]["close"] != folded[1]["open"]

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


class TestPrefixInvariant:
    """A fold never uses a bar to its right — the future-function probe on the data path."""

    def test_folding_a_prefix_is_the_prefix_of_the_full_fold(self):
        days = _weekdays("2024-01-01", 130)
        bars = _daily_series(days)
        for spec in (fold_spec("1D", 2), fold_spec("1D", 5), fold_spec("1W", 2), fold_spec("1M", 3)):
            full = fold_bars(bars, spec)
            for cut in (30, 77, 120):
                # Every group but the last is complete on both sides; the tail group is
                # the only one a cut can leave short, so it drops out of the comparison
                # instead of being excused by a comment. This is the future-function
                # probe on the fold: nothing to the right of bar `cut` can move a bar.
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
        """
        days = _weekdays("2024-06-05", 120)
        bars = _daily_series(days)
        for unit, base in (("week", "1W"), ("month", "1M")):
            folded = fold_bars(bars, calendar_fold_spec(unit, 1))
            assert len(folded) < len(bars), unit
            assert folded == market_routes._merge_to_calendar(bars, unit), unit

    def test_the_default_multiplier_is_the_same_call_as_saying_one(self):
        days = _weekdays("2026-06-01", 10)
        bars = _daily_series(days)
        assert market_routes._merge_to_calendar(bars, "week") == market_routes._merge_to_calendar(
            bars, "week", 1
        )

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
        days = _weekdays("2026-06-01", 10)
        bars = _daily_series(days)
        assert market_routes._merge_to_calendar(bars, "week") == fold_bars(
            bars, calendar_fold_spec("week", 1)
        )
