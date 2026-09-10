"""Weekly / monthly bars on ``/market/kline`` — merged out of the daily chain.

The pro chart had no 周K / 月K button: the route only ever answered ``1m``-``60m``
and ``1D``, so a user who wanted the weekly picture had to read it off 500 daily
candles. Adding them by asking the data sources for weekly bars was rejected for
the reasons pinned here — coverage (the Yahoo chain has no weekly at all), price
caliber (a source's own weekly series rides on its own adjustment base, so
「前复权」 would mean two different things on two buttons), and paging (a merged
bar must be timestamped where the ``before`` cursor can land, which is its first
day).

No test here opens a socket, calls akshare, or touches a loader.
"""

from __future__ import annotations

import pandas as pd
import pytest

from src.api import market_routes

DAY_MS = 86_400_000


def _day_ms(label: str) -> int:
    """Epoch ms of a trading-day *label*, written the way `_bars_from_frame` writes it.

    Daily bars carry no zone: the label is midnight UTC of the trading day, which
    is exactly why grouping can read the calendar back off the number without a
    zone table. Minute paths are the ones that need `_MINUTE_WALL_CLOCK_ZONE`.
    """
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
    """`n` trading days (Mon-Fri) beginning on or after `start`."""
    return [
        d.strftime("%Y-%m-%d")
        for d in pd.bdate_range(start, periods=n)
    ]


def _daily_series(days: list[str]) -> list[dict]:
    return [_bar(d, 10.0 + i * 0.1, volume=100.0 + i) for i, d in enumerate(days)]


class TestGroupKey:
    """One natural week = one bar, on the exchange's calendar, not the viewer's."""

    def test_five_weekdays_are_one_week(self):
        keys = {market_routes._calendar_group_key(_day_ms(d), "week") for d in _weekdays("2026-06-01", 5)}
        assert len(keys) == 1

    def test_two_weeks_are_two_keys(self):
        a = market_routes._calendar_group_key(_day_ms("2026-06-01"), "week")
        b = market_routes._calendar_group_key(_day_ms("2026-06-08"), "week")
        assert a != b

    def test_the_new_year_week_stays_one_bar(self):
        """Mon 29 Dec – Fri 2 Jan is one trading week on every broker's chart.

        `strftime("%W")` would call 2026-01-02 week 1 of a *different* year from
        2025-12-29's week 53, splitting the week in two; ISO numbering carries
        the year with the week.
        """
        assert market_routes._calendar_group_key(_day_ms("2025-12-29"), "week") == (
            market_routes._calendar_group_key(_day_ms("2026-01-02"), "week")
        )

    def test_months_split_on_the_calendar_month(self):
        june = market_routes._calendar_group_key(_day_ms("2026-06-30"), "month")
        july = market_routes._calendar_group_key(_day_ms("2026-07-01"), "month")
        assert june == (2026, 6)
        assert july == (2026, 7)

    def test_the_key_ignores_what_clock_the_server_runs_under(self):
        """The claim behind the grouping: a label is a label wherever it is read."""
        stamp = _day_ms("2026-07-03")
        as_utc_midnight = pd.Timestamp(stamp, unit="ms", tz="UTC")
        assert as_utc_midnight.hour == 0
        assert market_routes._calendar_group_key(stamp, "week") == (2026, 27)


class TestMerge:
    def test_ohlcv_follows_the_broker_convention(self):
        days = _weekdays("2026-06-01", 5)
        bars = [
            {**_bar(days[0], 10.0), "high": 11.0, "low": 9.0, "close": 10.5, "volume": 100.0},
            {**_bar(days[1], 12.0), "high": 20.0, "low": 8.0, "close": 13.0, "volume": 200.0},
            {**_bar(days[2], 11.0), "high": 15.0, "low": 5.0, "close": 11.5, "volume": 300.0},
            {**_bar(days[3], 9.0), "high": 10.0, "low": 2.0, "close": 8.5, "volume": 400.0},
            {**_bar(days[4], 7.0), "high": 9.0, "low": 6.0, "close": 7.5, "volume": 500.0},
        ]
        (one,) = market_routes._merge_to_calendar(bars, "week")
        assert one["open"] == 10.0  # first day
        assert one["close"] == 7.5  # last day
        assert one["high"] == 20.0  # across the group, not the last day's
        assert one["low"] == 2.0
        assert one["volume"] == 1500.0
        # Paging depends on this: the merged bar sits where its first day sits.
        assert one["timestamp"] == _day_ms(days[0])

    def test_a_single_day_week_is_a_whole_bar(self):
        """A holiday week is one trading day long, not a partial something."""
        (one,) = market_routes._merge_to_calendar([_bar("2026-05-25", 10.0)], "week")
        assert one["open"] == one["high"] - 1.0 == 10.0
        assert one["timestamp"] == _day_ms("2026-05-25")

    def test_out_of_order_input_still_merges_ascending(self):
        days = _weekdays("2026-06-01", 5) + _weekdays("2026-06-08", 5)
        bars = _daily_series(days)
        scrambled = bars[::2] + bars[1::2]
        assert market_routes._merge_to_calendar(scrambled, "week") == (
            market_routes._merge_to_calendar(bars, "week")
        )

    def test_two_weeks_and_two_months_come_back_separately(self):
        days = _weekdays("2026-05-04", 30)
        bars = _daily_series(days)
        assert len(market_routes._merge_to_calendar(bars, "week")) == 6
        months = market_routes._merge_to_calendar(bars, "month")
        assert [pd.Timestamp(m["timestamp"], unit="ms", tz="UTC").month for m in months] == [5, 6]

    def test_a_missing_volume_does_not_poison_the_sum(self):
        days = _weekdays("2026-06-01", 3)
        bars = [_bar(days[0], 10.0), {**_bar(days[1], 11.0), "volume": None}, _bar(days[2], 12.0)]
        (one,) = market_routes._merge_to_calendar(bars, "week")
        assert one["volume"] == 200.0  # the two real ones, not None treated as 100


class TestFetchCalendarBars:
    """The daily walk behind one coarse request, and the seam it must not create."""

    @pytest.fixture()
    def daily_chain(self, monkeypatch):
        """A fake :func:`_fetch_daily` that behaves like the real paging contract."""
        seen: list[dict] = []
        days = _weekdays("2024-06-05", 600)
        all_bars = _daily_series(days)

        def install(bars):
            def fake(symbol, count, before):
                seen.append({"symbol": symbol, "count": count, "before": before})
                window = [b for b in bars if before is None or b["timestamp"] < before]
                return window[-count:], "backtest:test_chain"

            monkeypatch.setattr(market_routes, "_fetch_daily", fake)
            return all_bars

        install(all_bars)
        return {"seen": seen, "all": all_bars, "install": install}

    def test_the_daily_fetch_is_sized_to_fill_the_request(self, daily_chain):
        bars, _src = market_routes._fetch_calendar_bars("600519.SH", "1W", 40, None)
        asked = daily_chain["seen"][0]["count"]
        assert asked == 40 * 8 + 30
        assert len(bars) == 40
        assert daily_chain["seen"][0]["symbol"] == "600519.SH"

    def test_monthly_asks_for_more_days_per_bar(self, daily_chain):
        market_routes._fetch_calendar_bars("600519.SH", "1M", 40, None)
        assert daily_chain["seen"][-1]["count"] == 40 * 32 + 30

    def test_the_daily_walk_is_bounded(self, daily_chain):
        """`count` is capped by the route; the multiplication must not run away.

        2000 monthly bars would ask for 64000 daily ones, which pushes
        `_fetch_daily`'s calendar buffer into 1803 — a range the public endpoints
        answer with an error rather than with nothing.
        """
        market_routes._fetch_calendar_bars("600519.SH", "1M", 2000, None)
        assert daily_chain["seen"][-1]["count"] == market_routes._AGG_DAILY_CAP

    def test_a_seven_day_tape_still_fills_its_page(self, monkeypatch):
        """The sizing unit is calendar days, because crypto really has 7 a week.

        Sized by *trading* days (6 per week, 24 per month) this undersold every
        symbol whose tape never closes. Measured live 2026-09-10, before the unit
        was fixed: `BTC-USDT interval=1W count=200` answered **176** bars out of
        a chain holding four more years. A short page is what the chart reads as
        the end of the tape (`more.forward = bars >= count`), so the page stops
        filling and the user concludes the history does — a sizing bug is
        indistinguishable from an empty source, which is why this is pinned at the
        longest possible week and month rather than the average one.
        """
        days = [d.strftime("%Y-%m-%d") for d in pd.date_range("2020-01-01", periods=1400)]
        bars_in = _daily_series(days)

        def fake(symbol, count, before):
            window = [b for b in bars_in if before is None or b["timestamp"] < before]
            return window[-count:], "backtest:crypto"

        monkeypatch.setattr(market_routes, "_fetch_daily", fake)

        weekly, _src = market_routes._fetch_calendar_bars("BTC-USDT", "1W", 200, None)
        assert len(weekly) == 200  # 176 here is the shipped bug
        assert weekly == market_routes._merge_to_calendar(bars_in, "week")[-200:]

        monthly, _src = market_routes._fetch_calendar_bars("BTC-USDT", "1M", 40, None)
        assert len(monthly) == 40  # 31 at 24 days/month, which is the same bug
        assert monthly == market_routes._merge_to_calendar(bars_in, "month")[-40:]

    def test_the_stub_week_at_a_full_windows_left_edge_is_dropped(self, daily_chain):
        """A filled daily window ends mid-week, and that half-week is not drawn.

        The series starts on a Wednesday and 600 business days span 120 whole
        weeks, so the 350-day tail behind ``count=40`` (40 * 8 + 30) opens on a
        Wednesday too: the oldest merged group would hold Wed/Thu/Fri of a week
        whose Mon/Tue sit outside the fetch. Dropping it is free — those days land
        complete at the newest end of the next page.

        (Change the sizing constants and `open_at` drifts off Wednesday; move the
        start date along with them, or this test stops proving the drop needed.)
        """
        days = _weekdays("2025-06-04", 600)  # 2025-06-04 is a Wednesday
        bars_in = _daily_series(days)
        daily_chain["install"](bars_in)
        needed = 40 * 8 + 30
        open_at = len(days) - needed
        assert pd.Timestamp(days[open_at]).weekday() == 2  # where the window opens
        # Proof the drop was needed: the window's own first group is a 3-day stub.
        window = market_routes._merge_to_calendar(bars_in[open_at:], "week")
        assert window[0]["timestamp"] == _day_ms(days[open_at])
        assert window[0]["open"] == bars_in[open_at]["open"]  # Wednesday's, not Monday's
        bars, _src = market_routes._fetch_calendar_bars("600519.SH", "1W", 40, None)
        assert _day_ms(days[open_at]) not in [b["timestamp"] for b in bars]
        # What the user gets is exactly what a full weekly chart would show.
        assert bars == market_routes._merge_to_calendar(bars_in, "week")[-40:]

    def test_the_guard_still_fires_when_the_page_itself_is_short(self, monkeypatch):
        """The drop's own case: a page so short the tail trim cannot rescue it.

        At the shipped calendar maxima a full window always merges *more* groups
        than `count`, so the tail trim throws the left-edge stub away and the
        explicit drop never fires — deleting it turns nothing red, which is worth
        saying out loud rather than leaving the guard looking tested. Patch the
        table back to the trading-day figures the live pass rejected and the
        window comes back full with the stub still inside a short page. Keeping it
        there is not cosmetic: page 2 is asked with `before` = the stub's own first
        day, so that week's earlier days belong to neither page and the joined
        series has a hole in the middle of it.
        """
        monkeypatch.setitem(market_routes._AGG_DAILY_PER_BAR, "1W", 6)
        days = [d.strftime("%Y-%m-%d") for d in pd.date_range("2025-01-01", periods=400)]
        bars_in = _daily_series(days)

        def fake(symbol, count, before):
            window = [b for b in bars_in if before is None or b["timestamp"] < before]
            return window[-count:], "backtest:crypto"

        monkeypatch.setattr(market_routes, "_fetch_daily", fake)
        truth = market_routes._merge_to_calendar(bars_in, "week")

        page1, _src = market_routes._fetch_calendar_bars("BTC-USDT", "1W", 40, None)
        assert len(page1) < 40  # full window, short page: the guard's own territory
        # 2025-05-07 is the window's first day and a Wednesday, so the week whose
        # Mon/Tue sit outside it is exactly what must not be drawn.
        assert page1[0]["timestamp"] != _day_ms("2025-05-07")
        page2, _src = market_routes._fetch_calendar_bars(
            "BTC-USDT", "1W", 40, page1[0]["timestamp"]
        )
        joined = page2 + page1
        assert joined == truth[len(truth) - len(joined):]  # no week split across pages

    def test_a_history_shorter_than_the_window_keeps_its_first_week(self, daily_chain):
        """Nothing is a suspect edge group when the source simply ran out."""
        days = _weekdays("2025-06-04", 600)
        bars_in = _daily_series(days)
        daily_chain["install"](bars_in)
        truth = market_routes._merge_to_calendar(bars_in, "week")
        assert len(truth) * 8 + 30 > len(bars_in)  # the walk cannot fill
        bars, _src = market_routes._fetch_calendar_bars("600519.SH", "1W", len(truth), None)
        assert bars == truth

    def test_paging_renders_the_same_weeks_the_whole_series_would(self, daily_chain):
        """The sharp one: two pages stitched must equal the truth, exactly.

        A merged bar is timestamped by its first day so that `before` is always a
        group boundary. If the newest group of a page were dropped, or a week
        appeared on both pages, or a week appeared as a stub on one and a
        different stub on the other, this fails.
        """
        truth = market_routes._merge_to_calendar(daily_chain["all"], "week")
        page1, _src1 = market_routes._fetch_calendar_bars("600519.SH", "1W", 40, None)
        page2, _src2 = market_routes._fetch_calendar_bars(
            "600519.SH", "1W", 40, page1[0]["timestamp"]
        )
        assert page1 == truth[-40:]
        assert page2 == truth[: len(truth) - 40][-40:]
        assert page2[-1]["timestamp"] < page1[0]["timestamp"]
        stamps = [b["timestamp"] for b in page2 + page1]
        assert len(set(stamps)) == len(stamps)
        assert daily_chain["seen"][1]["before"] == page1[0]["timestamp"]

    def test_source_says_the_bars_were_merged(self, daily_chain):
        _bars, src = market_routes._fetch_calendar_bars("600519.SH", "1W", 40, None)
        assert src.endswith("+1W")
        _bars, src = market_routes._fetch_calendar_bars("600519.SH", "1M", 12, None)
        assert src.endswith("+1M")


class TestRouting:
    def test_weekly_bars_do_not_take_the_minute_path(self, monkeypatch):
        """Minute routing has its own quota and error text; coarse bars have neither."""

        def tripwire(*args, **kwargs):
            raise AssertionError(f"minute path called for a coarse interval: {args}")

        monkeypatch.setattr(market_routes, "_futu_minute_bars", tripwire)
        monkeypatch.setattr(market_routes, "_fetch_minute_a_share", tripwire)
        monkeypatch.setattr(
            market_routes,
            "_fetch_daily",
            lambda symbol, count, before: (_daily_series(_weekdays("2026-06-01", 5)), "backtest:test_chain"),
        )
        out = market_routes._kline_sync("600519.SH", "1W", 30, "qfq")
        assert out["interval"] == "1W"
        assert len(out["bars"]) == 1
        assert out["source"] == "backtest:test_chain+1W"

    def test_latest_session_on_weekly_bars_is_refused_by_name(self, monkeypatch):
        """`session=latest` is a minute concept; say so instead of slicing days."""
        monkeypatch.setattr(market_routes, "_fetch_daily", lambda *a, **k: ([], "x"))
        with pytest.raises(ValueError, match="1W bars are merged from daily"):
            market_routes._kline_sync("600519.SH", "1W", 100, "qfq", session="latest")

    def test_daily_bars_still_answer_without_the_merge(self, monkeypatch):
        calls: list[int] = []

        def fake(symbol, count, before):
            calls.append(count)
            return _daily_series(_weekdays("2026-06-01", 3)), "backtest:test_chain"

        monkeypatch.setattr(market_routes, "_fetch_daily", fake)
        out = market_routes._kline_sync("600519.SH", "1D", 3, "qfq")
        assert calls == [3]  # not scaled up by the merge ratio
        assert out["source"] == "backtest:test_chain"
        assert len(out["bars"]) == 3


class TestQueryValidation:
    """The 400 gate is the only part of this that a hand-made URL can hit."""

    def _client(self):
        from fastapi import FastAPI
        from fastapi.testclient import TestClient

        app = FastAPI()
        market_routes.register_market_routes(app, require_auth=lambda: None)
        return TestClient(app)

    def test_coarse_intervals_pass_the_gate(self, monkeypatch):
        seen: list[str] = []

        def fake(symbol, interval, count, before):
            seen.append(interval)
            return [], "backtest:test_chain"

        monkeypatch.setattr(market_routes, "_fetch_calendar_bars", fake)
        client = self._client()
        for interval in ("1W", "1M"):
            res = client.get(f"/market/kline?symbol=600519.SH&interval={interval}&count=100")
            assert res.status_code == 200, res.text
        assert seen == ["1W", "1M"]

    def test_an_unknown_interval_names_the_ones_that_work(self):
        res = self._client().get("/market/kline?symbol=600519.SH&interval=4h")
        assert res.status_code == 400
        body = res.json()["error"]
        assert "'4h'" in body and "1D" in body and "1W" in body and "1M" in body

    def test_count_bounds_are_unchanged(self):
        client = self._client()
        assert client.get("/market/kline?symbol=600519.SH&interval=1W&count=5").status_code == 422
        assert client.get("/market/kline?symbol=600519.SH&interval=1W&count=99999").status_code == 422
