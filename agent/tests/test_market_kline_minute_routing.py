"""Tests for ``/market/kline`` minute-bar routing (FutuOpenD first, market-wide).

Before this routing existed, minute bars reached Sina and nothing else, which
made HK/US intraday charts impossible even with a live OpenD window open — the
loader has always been able to serve them. These tests pin the new order and,
more importantly, the three ways it must *not* silently misbehave:

* ``60m`` must be sent to the loader as ``1H`` (its table has no ``60m`` key);
* a non-qfq ``adjust`` must not be served qfq bars from the loader, which pins
  ``autype="qfq"`` and would answer with a different price caliber than asked;
* a non-A-share whose gateway is down must be told *that*, not handed the stale
  "minutes are A-share only" message that would send the user hunting the wrong
  fix.

``session=latest`` (the 分时 view's one-trading-day slice) is pinned at the end
of the file, including the case that decides where the code has to live: a
session cut on the *viewer's* calendar splits New York afternoons in half.

No test here opens a socket or calls akshare.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

import pandas as pd
import pytest

from src.api import market_routes


def _minute_frame(n: int = 3, day: str = "2026-09-04") -> pd.DataFrame:
    """A loader-shaped minute frame: naive DatetimeIndex + OHLCV."""
    index = pd.date_range(f"{day} 09:30", periods=n, freq="1min")
    return pd.DataFrame(
        {
            "open": [440.0 + i for i in range(n)],
            "high": [441.0 + i for i in range(n)],
            "low": [439.0 + i for i in range(n)],
            "close": [440.5 + i for i in range(n)],
            "volume": [1000.0 + i for i in range(n)],
        },
        index=index,
    )


@pytest.fixture()
def futu_seen(monkeypatch):
    """Install a fake ``FutuLoader`` and record what the route asked it for."""
    seen: dict[str, list] = {"calls": [], "intervals": []}

    def install(*, available=True, frame=None, error=None):
        class FakeLoader:
            def is_available(self):
                return available

            def fetch(self, codes, start_date, end_date, interval="1D"):
                seen["calls"].append(
                    {"codes": list(codes), "start": start_date, "end": end_date}
                )
                seen["intervals"].append(interval)
                if error is not None:
                    raise error
                if frame is None:
                    return {}
                return {codes[0]: frame}

        # Patched on the module, not imported by name: ``_futu_minute_bars``
        # imports FutuLoader inside the function, so it re-reads the attribute
        # on every call.
        monkeypatch.setattr("backtest.loaders.futu.FutuLoader", FakeLoader)

    install(frame=_minute_frame())
    return {"seen": seen, "install": install}


@pytest.fixture()
def sina_spy(monkeypatch):
    """Replace the Sina path so a fall-through is observable without network."""
    calls: list[dict] = []

    def _fake(symbol, period, count, adjust, before):
        calls.append({"symbol": symbol, "period": period})
        return [{"timestamp": 1, "open": 1.0, "high": 1.0, "low": 1.0, "close": 1.0, "volume": 1.0}]

    monkeypatch.setattr(market_routes, "_fetch_minute_a_share", _fake)
    return calls


class TestFutuServesEveryMinuteMarket:
    def test_hk_symbol_comes_from_the_gateway(self, futu_seen):
        out = market_routes._kline_sync("700.HK", "5m", 100, "qfq")
        assert out["source"] == "futu:opend"
        assert len(out["bars"]) == 3
        assert futu_seen["seen"]["intervals"] == ["5m"]

    def test_us_symbol_comes_from_the_gateway(self, futu_seen):
        out = market_routes._kline_sync("AAPL.US", "1m", 100, "qfq")
        assert out["source"] == "futu:opend"

    def test_a_share_now_prefers_the_gateway(self, futu_seen, sina_spy):
        """The user asked for Futu-first *including* A-shares.

        Sina stays wired as the fall-through (next class), but a live gateway
        must win here or the A-share chart keeps the older, shallower series.
        """
        out = market_routes._kline_sync("600519.SH", "15m", 100, "qfq")
        assert out["source"] == "futu:opend"
        assert sina_spy == []

    def test_sixty_minute_interval_is_requested_as_one_hour(self, futu_seen):
        """The loader keys 60-minute bars ``1H``; ``60m`` is not in its table.

        Passing the endpoint's spelling straight through would raise inside the
        loader and be swallowed by the broad ``except`` — so the bug would look
        like "Futu has no 60m data", forever, for the one interval the tape is
        best at.
        """
        market_routes._kline_sync("700.HK", "60m", 100, "qfq")
        assert futu_seen["seen"]["intervals"] == ["1H"]

    def test_bars_are_capped_at_the_requested_count(self, futu_seen):
        futu_seen["install"](frame=_minute_frame(n=40))
        out = market_routes._kline_sync("700.HK", "5m", 10, "qfq")
        assert len(out["bars"]) == 10
        # Newest tail, ascending: the chart pages backwards from the last bar.
        assert out["bars"][-1]["timestamp"] > out["bars"][0]["timestamp"]

    def test_before_cursor_filters_the_tail(self, futu_seen):
        frame = _minute_frame(n=5)
        futu_seen["install"](frame=frame)
        # Take the cursor from a previous response, the way the chart pages.
        # Re-deriving it here (an earlier draft did ``Timestamp(...).timestamp()``)
        # silently re-implements the route's clock in the test, which went stale
        # the moment minute bars became real instants instead of naive UTC.
        first = market_routes._kline_sync("700.HK", "5m", 100, "qfq")
        cutoff = first["bars"][3]["timestamp"]
        out = market_routes._kline_sync("700.HK", "5m", 100, "qfq", before=cutoff)
        assert all(b["timestamp"] < cutoff for b in out["bars"])
        assert len(out["bars"]) == 3


class TestWindowSizing:
    """Ask for enough days to cover ``count``, but never more than the cap.

    A retail OpenD entitlement reaches back roughly a week of intraday bars; a
    window that overshoots it buys no extra bars and risks the whole call.
    """

    def _span(self, seen):
        """Calendar days covered, undoing the route's ``end + 1 day``.

        The route widens the inclusive ``end_date`` by one day so today's bars
        are inside the window; leaving that in makes every assertion here look
        off by one against ``_MINUTE_WINDOW_CAP_DAYS``.
        """
        call = seen["calls"][-1]
        delta = datetime.fromisoformat(call["end"]) - datetime.fromisoformat(call["start"])
        return delta.days - 1

    def test_small_request_asks_for_a_small_window(self, futu_seen):
        market_routes._kline_sync("700.HK", "5m", 20, "qfq")
        assert self._span(futu_seen["seen"]) <= 4

    def test_large_request_is_capped(self, futu_seen):
        market_routes._kline_sync("700.HK", "1m", 2000, "qfq")
        assert self._span(futu_seen["seen"]) == market_routes._MINUTE_WINDOW_CAP_DAYS

    def test_cap_leaves_room_for_a_free_entitlement(self, futu_seen):
        assert market_routes._MINUTE_WINDOW_CAP_DAYS <= 14

    def test_the_live_window_is_never_served_from_the_loader_cache(self, futu_seen):
        """The ``end + 1 day`` the route adds is load-bearing for freshness.

        ``loader_cache_range_is_final`` refuses to cache anything whose end is
        today or later, precisely because a content-addressed key would pin a
        still-forming bar forever. Removing that +1 -- it looks redundant --
        would make an alert polled every five minutes read the same cached
        minute bars all day, and the first such bug report would be a price
        cross that never fired.

        Paging back into settled history *does* get cached, which is the
        entitlement-friendly half of the arrangement.
        """
        from backtest.loaders.base import loader_cache_range_is_final

        market_routes._kline_sync("700.HK", "5m", 100, "qfq")
        live_end = futu_seen["seen"]["calls"][-1]["end"]
        assert loader_cache_range_is_final(live_end) is False

    def test_a_paged_back_window_is_cacheable(self, futu_seen):
        """A page that has already settled *is* the case the cache may answer.

        Only the ``end_date`` handed to the loader matters, so the stub returns
        no bars at all -- that keeps the assertion about the window instead of
        about whether the fixture's canned timestamps happen to sit before the
        cursor.
        """
        from backtest.loaders.base import loader_cache_range_is_final

        futu_seen["install"](frame=None)
        cursor = int((datetime.now() - timedelta(days=3)).timestamp() * 1000)
        assert market_routes._futu_minute_bars("700.HK", "5m", 100, "qfq", cursor) is None
        assert loader_cache_range_is_final(futu_seen["seen"]["calls"][-1]["end"]) is True


class TestTablesAgree:
    """Three parallel interval tables must stay the same length.

    ``_MINUTE_PERIODS`` (Sina), ``_FUTU_MINUTE_INTERVAL`` (Futu) and
    ``_MINUTE_BARS_PER_DAY`` (window sizing) are keyed by the same endpoint
    spellings and edited by hand. Adding ``3m`` to the first alone keeps it
    reachable on the route but silently Sina-only, so HK/US 3-minute charts
    would 400 with no hint that the gateway could have served them. A Futu
    spelling missing from the density table is a ``KeyError``, which the broad
    ``except`` reports as "no data". Cheaper to fail here.
    """

    def test_every_served_interval_has_a_futu_spelling_and_a_daily_density(self):
        assert set(market_routes._MINUTE_PERIODS) == set(market_routes._FUTU_MINUTE_INTERVAL)
        assert set(market_routes._MINUTE_PERIODS) == set(market_routes._MINUTE_BARS_PER_DAY)

    def test_futu_spellings_are_all_accepted_by_the_loader(self):
        """The right-hand column must exist in the loader's own table."""
        from backtest.loaders.futu import _INTERVAL_MAP

        unknown = set(market_routes._FUTU_MINUTE_INTERVAL.values()) - set(_INTERVAL_MAP)
        assert unknown == set(), f"loader would reject {unknown}"

    def test_the_wall_clock_table_covers_exactly_the_futu_markets(self):
        """Every servable suffix must know whose clock it is on.

        A gap here is a ``KeyError`` inside the try block, which the broad
        ``except`` reports as "the gateway did not answer" -- the one diagnosis
        that would send a user to restart OpenD for no reason.
        """
        assert set(market_routes._MINUTE_WALL_CLOCK_ZONE) == market_routes._FUTU_MINUTE_SUFFIXES


class TestMinuteAxisIsARealInstant:
    """Minute bars must carry the epoch of the moment they happened at.

    Sources hand back exchange-local clock times with no zone, and pandas reads
    a naive timestamp as UTC -- so before this was pinned, an A-share 14:35 bar
    went out as 14:35 UTC and a UTC+8 screen drew it at 22:35. Daily bars never
    revealed that, because a date label survives an 8-hour nudge; intraday bars
    are the first thing in this route where it shows.
    """

    def _first_epoch(self, futu_seen, symbol, day="2026-09-04"):
        futu_seen["install"](frame=_minute_frame(n=1, day=day))  # index starts 09:30
        out = market_routes._kline_sync(symbol, "5m", 10, "qfq")
        return out["bars"][0]["timestamp"]

    def test_hk_bars_are_placed_on_the_hk_clock(self, futu_seen):
        assert self._first_epoch(futu_seen, "700.HK") == int(
            pd.Timestamp("2026-09-04 09:30").tz_localize("Asia/Shanghai").timestamp() * 1000
        )

    def test_us_bars_are_placed_on_the_new_york_clock(self, futu_seen):
        # September is daylight time, so 09:30 ET is 13:30 UTC.
        assert self._first_epoch(futu_seen, "AAPL.US") == int(
            pd.Timestamp("2026-09-04 13:30", tz="UTC").timestamp() * 1000
        )

    def test_us_bars_follow_the_dst_switch(self, futu_seen):
        """A fixed +5 would be wrong half the year, and only on US charts."""
        # November 2026 is standard time: 09:30 ET is 14:30 UTC, an hour later.
        assert self._first_epoch(futu_seen, "AAPL.US", day="2026-11-06") == int(
            pd.Timestamp("2026-11-06 14:30", tz="UTC").timestamp() * 1000
        )

    def test_daily_bars_keep_their_trading_day_label_semantics(self):
        """The fix must not have leaked into the daily path.

        Localizing a US session's midnight would move the *date label* to the
        previous calendar day, which is a worse bug than the one being fixed.
        """
        frame = _minute_frame(n=1)
        assert market_routes._bars_from_frame(frame)[0]["timestamp"] == int(
            pd.Timestamp("2026-09-04 09:30").timestamp() * 1000
        )

    def test_an_aware_index_is_not_shifted_twice(self):
        """If a source ever starts reporting its own zone, believe it and stop.

        Localizing an aware timestamp would raise, and the broad ``except`` in
        the route would report that as the gateway being down.
        """
        frame = _minute_frame(n=1)
        frame.index = frame.index.tz_localize("Asia/Shanghai")
        assert market_routes._bars_from_frame(frame, "America/New_York")[0]["timestamp"] == int(
            pd.Timestamp("2026-09-04 09:30", tz="Asia/Shanghai").timestamp() * 1000
        )


class TestFallThroughToSina:
    def test_a_share_falls_back_when_the_gateway_is_down(self, futu_seen, sina_spy):
        futu_seen["install"](available=False)
        out = market_routes._kline_sync("600519.SH", "5m", 100, "qfq")
        assert out["source"] == "akshare:sina_stock_zh_a_minute"
        assert sina_spy == [{"symbol": "600519.SH", "period": "5"}]

    def test_a_share_falls_back_when_the_loader_raises(self, futu_seen, sina_spy):
        futu_seen["install"](error=OSError("connection refused"))
        out = market_routes._kline_sync("600519.SH", "5m", 100, "qfq")
        assert out["source"] == "akshare:sina_stock_zh_a_minute"

    def test_a_share_falls_back_on_an_empty_frame(self, futu_seen, sina_spy):
        futu_seen["install"](frame=None)
        out = market_routes._kline_sync("600519.SH", "5m", 100, "qfq")
        assert out["source"] == "akshare:sina_stock_zh_a_minute"

    def test_hk_symbol_never_reaches_the_sina_path(self, futu_seen, sina_spy):
        """Sina's A-share API has no HK code shape; calling it would be a 500."""
        futu_seen["install"](available=False)
        with pytest.raises(ValueError):
            market_routes._kline_sync("700.HK", "5m", 100, "qfq")
        assert sina_spy == []


class TestCaliberGuard:
    """The gateway serves one caliber only, and that limit must be honoured."""

    @pytest.mark.parametrize("adjust", ["none", "hfq"])
    def test_non_qfq_is_not_served_from_the_gateway(self, futu_seen, adjust):
        futu_seen["install"](available=True, frame=_minute_frame())
        assert (
            market_routes._futu_minute_bars("700.HK", "5m", 100, adjust, None) is None
        )
        assert futu_seen["seen"]["calls"] == []

    @pytest.mark.parametrize("adjust", ["none", "hfq"])
    def test_a_share_non_qfq_goes_to_sina_which_supports_it(self, futu_seen, sina_spy, adjust):
        market_routes._kline_sync("600519.SH", "5m", 100, adjust)
        assert futu_seen["seen"]["calls"] == []
        assert sina_spy != []

    def test_hk_non_qfq_explains_the_caliber_not_the_gateway(self, futu_seen):
        with pytest.raises(ValueError) as exc:
            market_routes._kline_sync("700.HK", "5m", 100, "hfq")
        message = str(exc.value)
        assert "qfq" in message
        assert "hfq" in message


class TestErrorMessagesNameTheRealCause:
    """Three different reasons produce one exception type; the text is the only
    thing that separates them, and a live probe found this function sending
    BTC-USDT users to go start a gateway that was never queried. So the
    assertions are on the wording, not just on the raise.
    """

    def test_gateway_down_says_check_opend(self, futu_seen):
        futu_seen["install"](available=False)
        with pytest.raises(ValueError) as exc:
            market_routes._kline_sync("700.HK", "5m", 100, "qfq")
        assert "OpenD" in str(exc.value)
        assert "running and logged in" in str(exc.value)

    def test_uncovered_market_does_not_tell_you_to_start_the_gateway(self, futu_seen, sina_spy):
        """The distinction that matters to whoever reads the error.

        ``BTC-USDT`` is filtered out before any socket opens, so "check that
        OpenD is running" is advice about a component that was never involved.
        """
        with pytest.raises(ValueError) as exc:
            market_routes._kline_sync("BTC-USDT", "5m", 100, "qfq")
        message = str(exc.value)
        assert "covers" in message
        assert "running and logged in" not in message
        assert futu_seen["seen"]["calls"] == []
        assert sina_spy == []

    def test_uncovered_market_names_the_markets_that_do_work(self, futu_seen):
        with pytest.raises(ValueError) as exc:
            market_routes._kline_sync("SHEL.L", "1m", 100, "qfq")
        for suffix in market_routes._FUTU_MINUTE_SUFFIXES:
            assert suffix in str(exc.value)

    def test_wrong_caliber_is_not_reported_as_a_missing_gateway(self, futu_seen):
        with pytest.raises(ValueError) as exc:
            market_routes._kline_sync("700.HK", "5m", 100, "none")
        assert "running and logged in" not in str(exc.value)

    def test_no_stale_a_share_only_wording_survives(self, futu_seen):
        """The pre-routing text is now false for HK/US and misleading for A-shares."""
        futu_seen["install"](available=False)
        with pytest.raises(ValueError) as exc:
            market_routes._kline_sync("AAPL.US", "5m", 100, "qfq")
        assert "only supported for .SH/.SZ" not in str(exc.value)


class TestDailyPathIsUntouched:
    def test_1d_still_routes_through_the_daily_chain(self, futu_seen, sina_spy, monkeypatch):
        """The minute branch must not have swallowed the daily one."""
        asked: list[str] = []

        def _fake_daily(symbol, count, before):
            asked.append(symbol)
            return [{"timestamp": 1, "close": 1.0}], "backtest:loader_fallback_chain"

        monkeypatch.setattr(market_routes, "_fetch_daily", _fake_daily)
        out = market_routes._kline_sync("AAPL.US", "1D", 100, "qfq")
        assert out["source"] == "backtest:loader_fallback_chain"
        assert asked == ["AAPL.US"]
        assert futu_seen["seen"]["intervals"] == []
        assert sina_spy == []


def _two_session_frame(day1: str = "2026-09-03", day2: str = "2026-09-04") -> pd.DataFrame:
    """Two adjacent sessions, deliberately of *different* lengths.

    Equal-length days let an off-by-one-day slice pass by coincidence: the
    assertion on ``prev_close`` is only meaningful when the two sessions end on
    different closes.
    """
    return pd.concat([_minute_frame(n=390, day=day1), _minute_frame(n=400, day=day2)])


def _http_client():
    """A one-route app, so the query string itself is under test.

    ``register_market_routes`` takes the auth dependency explicitly, which is
    what makes an HTTP round trip cheap here — no socket, no api_server import.
    """
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    market_routes.register_market_routes(app, require_auth=lambda: None)
    return TestClient(app)


class TestLatestSessionSlice:
    """``session=latest`` — one trading day, cut on the *exchange's* calendar.

    This exists for the 分时 view (the intraday line chart brokers show),
    which must render exactly the newest session. The slicing is done here
    rather than in the browser on purpose: the minute paths already stamped
    every bar against ``_MINUTE_WALL_CLOCK_ZONE``, so a second copy of that
    table in the frontend would be free to drift — and a viewer east of
    Greenwich grouping by their own clock cuts a US session in half. See
    ``test_us_session_is_not_cut_on_the_viewers_clock``.
    """

    def test_only_the_newest_exchange_day_comes_back(self, futu_seen):
        futu_seen["install"](frame=_two_session_frame())
        out = market_routes._kline_sync("700.HK", "1m", 2000, "qfq", session="latest")
        assert out["session_date"] == "2026-09-04"
        assert len(out["bars"]) == 400

    def test_prev_close_is_the_last_bar_of_the_previous_session(self, futu_seen):
        futu_seen["install"](frame=_two_session_frame())
        out = market_routes._kline_sync("700.HK", "1m", 2000, "qfq", session="latest")
        assert out["prev_close"] == 440.5 + 389  # day1's last bar, not day2's

    def test_a_one_session_window_says_none_rather_than_reusing_today(self, futu_seen):
        """Defaulting ``prev_close`` to the first bar would draw every 分时 flat.

        A fresh Monday on a free-tier gateway really can hold one session, and
        that is a fact the view has to be able to show.
        """
        futu_seen["install"](frame=_minute_frame(n=5))
        out = market_routes._kline_sync("700.HK", "1m", 2000, "qfq", session="latest")
        assert out["prev_close"] is None
        assert len(out["bars"]) == 5

    def test_us_session_is_not_cut_on_the_viewers_clock(self, futu_seen):
        """The load-bearing case for doing this server-side.

        New York in September is UTC+8 plus twelve hours on the wall clock, so
        09:30-16:10 ET reads 21:30-04:10 *next day* in Beijing. Grouping the
        same bars on a UTC+8 calendar leaves only the post-midnight tail — 250
        of 400 bars — standing in as "today".
        """
        futu_seen["install"](frame=_two_session_frame())
        out = market_routes._kline_sync("AAPL.US", "1m", 2000, "qfq", session="latest")
        assert out["session_date"] == "2026-09-04"
        assert len(out["bars"]) == 400

    def test_a_trading_day_is_the_exchanges_midnight_not_utcs(self):
        """New York evenings are already *tomorrow* on a UTC calendar.

        No minute source in this route ever hands over such a bar (the live tape
        ends at 16:00 ET), which is why every data-driven case above agrees with
        a hard-coded UTC — a mutation probe measured `ZoneInfo("UTC")` inside the
        slicer as surviving this whole file. That makes the property untestable
        end-to-end rather than absent, so it gets pinned here, directly, where an
        evening bar can be staged.
        """
        tz = ZoneInfo("America/New_York")
        bars = [
            {
                "timestamp": int(datetime(2026, 9, 3, hour, tzinfo=tz).timestamp() * 1000),
                "close": 330.0 + i,
            }
            for i, hour in enumerate((20, 21))
        ]
        session, day, prev_close = market_routes._split_latest_session(bars, "America/New_York")
        assert day == "2026-09-03"  # UTC would already be calling it 09-04
        assert len(session) == 2
        assert prev_close is None

    @pytest.mark.parametrize(
        "symbol,zone",
        [
            ("600519.SH", "Asia/Shanghai"),
            ("000001.SZ", "Asia/Shanghai"),
            ("700.HK", "Asia/Shanghai"),
            ("AAPL.US", "America/New_York"),
        ],
    )
    def test_the_slice_is_asked_in_the_exchanges_own_clock(self, futu_seen, monkeypatch, symbol, zone):
        """Which zone the slicer is *handed* is a wiring fact, not a data fact.

        The two calendars cannot be told apart from the four sessions served
        today (see the case above), so the per-suffix table lookup is asserted
        on its argument instead of on output that happens to agree either way.
        """
        asked: list[str] = []
        real = market_routes._split_latest_session

        def spy(bars, zone_arg):
            asked.append(zone_arg)
            return real(bars, zone_arg)

        monkeypatch.setattr(market_routes, "_split_latest_session", spy)
        market_routes._kline_sync(symbol, "1m", 100, "qfq", session="latest")
        assert asked == [zone]

    def test_before_cursor_browses_back_to_an_earlier_session(self, futu_seen):
        """``before`` + ``latest`` = 分时 of a chosen past day, for free."""
        futu_seen["install"](frame=_two_session_frame())
        everything = market_routes._kline_sync("700.HK", "1m", 2000, "qfq")["bars"]
        day2_open = everything[390]["timestamp"]  # the fixture's own construction
        out = market_routes._kline_sync(
            "700.HK", "1m", 2000, "qfq", before=day2_open, session="latest"
        )
        assert out["session_date"] == "2026-09-03"
        assert len(out["bars"]) == 390
        assert out["prev_close"] is None

    def test_the_payload_is_untouched_without_the_param(self, futu_seen):
        """Every existing client of this route reads a fixed key set."""
        futu_seen["install"](frame=_two_session_frame())
        out = market_routes._kline_sync("700.HK", "1m", 2000, "qfq")
        assert set(out) == {"status", "symbol", "interval", "source", "bars"}

    def test_daily_bars_refuse_the_slice_and_say_why(self, monkeypatch):
        monkeypatch.setattr(
            market_routes,
            "_fetch_daily",
            lambda symbol, count, before: ([{"timestamp": 1, "close": 1.0}], "x"),
        )
        with pytest.raises(ValueError) as exc:
            market_routes._kline_sync("700.HK", "1D", 100, "qfq", session="latest")
        assert "already are one day" in str(exc.value)

    def test_an_unknown_session_value_is_not_silently_ignored(self, futu_seen):
        with pytest.raises(ValueError) as exc:
            market_routes._kline_sync("700.HK", "1m", 100, "qfq", session="yesterday")
        assert "latest" in str(exc.value)

    def test_the_query_parameter_reaches_the_router(self, futu_seen):
        """Wiring ``session`` into ``_kline_sync`` but not off the request would
        leave the 分时 view showing several sessions at once, with nothing in
        the UI to say so."""
        futu_seen["install"](frame=_two_session_frame())
        body = _http_client().get(
            "/market/kline",
            params={
                "symbol": "700.hk",
                "interval": "1m",
                "count": 2000,
                "session": "latest",
            },
        ).json()
        assert body["session_date"] == "2026-09-04"
        assert len(body["bars"]) == 400

    def test_an_empty_window_slices_to_nothing_instead_of_raising(self):
        assert market_routes._split_latest_session([], "Asia/Shanghai") == ([], "", None)
