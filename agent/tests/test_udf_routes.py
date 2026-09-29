"""TradingView UDF protocol conformance for ``/api/udf/*``.

These tests read the protocol page, not the implementation: every assertion is
about a shape the chart library acts on (bare seconds, columnar arrays, numbers
not strings, ``no_data`` + ``nextTime``, a 404 for an unknown group). A test that
only re-states what ``udf_routes.py`` happens to return would pass forever and
tell us nothing when a real widget rejects the feed.

Nothing here opens a socket or calls akshare. The one seam used for bars is
``market_routes._fetch_daily`` (and ``_futu_minute_bars`` for minutes), which is
deliberate: the load-bearing claim is that the UDF door and ``/market/kline``
serve *the same bars out of the same function*, so the comparison test at the
bottom hits both over HTTP and diffs them bar by bar.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from src.api import market_routes, udf_routes

DAY = 86400


def _day_ts(year: int, month: int, day: int) -> int:
    """Unix seconds of 00:00 UTC on a trading day — the shape UDF wants."""
    return int(datetime(year, month, day, tzinfo=timezone.utc).timestamp())


def _daily_bars(n: int = 20, start: int = _day_ts(2026, 9, 1)) -> list[dict]:
    """Ascending daily bars, midnight UTC, epoch **milliseconds** (internal unit)."""
    return [
        {
            "timestamp": (start + i * DAY) * 1000,
            "open": 100.0 + i,
            "high": 101.0 + i,
            "low": 99.0 + i,
            "close": 100.5 + i,
            "volume": 1000.0 + i,
        }
        for i in range(n)
    ]


@pytest.fixture()
def client():
    """Both route families on one bare app, auth stubbed out.

    ``require_auth`` is passed explicitly (the same hook ``/market/kline`` tests
    use) so the module's ``sys.modules["api_server"]`` fallback is not what is
    under test here.
    """
    app = FastAPI()
    market_routes.register_market_routes(app, require_auth=lambda: None)
    udf_routes.register_udf_routes(app, require_auth=lambda: None)
    return TestClient(app)


@pytest.fixture()
def daily_feed(monkeypatch):
    """Pin the daily chain to a fixed ladder of bars and record the asks."""
    bars = _daily_bars()
    seen: list[dict] = []

    def fake_fetch_daily(symbol: str, count: int, before: int | None):
        seen.append({"symbol": symbol, "count": count, "before": before})
        window = [b for b in bars if before is None or b["timestamp"] < before]
        return window[-count:], "test:daily"

    monkeypatch.setattr(market_routes, "_fetch_daily", fake_fetch_daily)
    bars_by_ts = {b["timestamp"]: b for b in bars}
    return {"bars": bars, "seen": seen, "by_ts": bars_by_ts}


# --------------------------------------------------------------------------- #
# /config — the two fields the library requires
# --------------------------------------------------------------------------- #

def test_config_has_the_two_required_capability_flags(client):
    cfg = client.get("/api/udf/config").json()
    assert cfg["supports_search"] is True
    assert cfg["supports_group_request"] is False
    assert cfg["supported_resolutions"] == list(udf_routes.SUPPORTED_RESOLUTIONS)


def test_config_does_not_offer_a_resolution_the_feed_refuses(
    client, daily_feed, minute_feed
):
    """``supported_resolutions`` is an offer, so nothing in it may 400.

    The mirror case is what makes this worth pinning: ``2D`` is absent from the
    table *and* rejected by ``/history`` — a widget that offered it anyway would
    show the user an empty chart with no reason.
    """
    cfg = client.get("/api/udf/config").json()
    for resolution in cfg["supported_resolutions"]:
        body = client.get(
            "/api/udf/history",
            params={"symbol": "600519.SH", "resolution": resolution, "countback": 10},
        ).json()
        assert body["s"] == "ok", resolution


def test_config_advertises_only_extensions_that_are_actually_accepted(
    client, minute_feed
):
    """A ``/config`` claim nobody honours is worse than not claiming it."""
    cfg = client.get("/api/udf/config").json()
    ext = cfg["extensions"]
    assert set(ext["history_params"]) == {"session", "adjust"}
    body = client.get(
        "/api/udf/history",
        params={
            "symbol": "600519.SH",
            "resolution": "1",
            "session": "latest",
            "adjust": "qfq",
            "countback": 10,
        },
    ).json()
    for key in ext["history_response"]:
        assert key in body, key


# --------------------------------------------------------------------------- #
# /time — bare seconds
# --------------------------------------------------------------------------- #

def test_time_is_a_bare_number_in_seconds_not_an_envelope(client):
    response = client.get("/api/udf/time")
    assert response.headers["content-type"].startswith("text/plain")
    # ``json.loads`` would happily parse a bare integer, so the shape test is
    # "digits and nothing else": no ``{"status": "ok"}`` envelope, no quotes.
    assert response.text.isdigit()
    value = int(response.text)
    # A millisecond clock would parse fine and then schedule every update years
    # away, so the *magnitude* is the assertion, not just the parse.
    assert 1_700_000_000 < value < 4_000_000_000


# --------------------------------------------------------------------------- #
# /history — units, shape, and the failure paths
# --------------------------------------------------------------------------- #

def test_history_timestamps_are_seconds_and_daily_bars_are_midnight_utc(client, daily_feed):
    body = client.get(
        "/api/udf/history",
        params={"symbol": "600519.SH", "resolution": "D", "countback": 5},
    ).json()
    assert body["s"] == "ok"
    assert len(body["t"]) == 5
    for stamp in body["t"]:
        assert stamp % DAY == 0, "daily bar time must be 00:00 UTC of a trading day"
        assert stamp < 4_000_000_000, "seconds, not milliseconds"


def test_history_price_columns_are_numbers_not_strings(client, daily_feed):
    """The protocol says prices must be numbers; a string silently draws no bar."""
    body = client.get(
        "/api/udf/history",
        params={"symbol": "600519.SH", "resolution": "D", "countback": 3},
    ).json()
    for column in ("o", "h", "l", "c", "v"):
        assert len(body[column]) == len(body["t"]) == 3
        for value in body[column]:
            assert isinstance(value, float) and not isinstance(value, bool)


def test_history_window_filter_uses_seconds_on_both_edges(client, daily_feed):
    bars = daily_feed["bars"]
    frm = int(bars[3]["timestamp"]) // 1000
    to = int(bars[6]["timestamp"]) // 1000  # exclusive, per the spec
    body = client.get(
        "/api/udf/history",
        params={"symbol": "600519.SH", "resolution": "D", "from": frm, "to": to},
    ).json()
    assert body["t"] == [frm, frm + DAY, frm + 2 * DAY]


def test_history_sends_to_as_the_millisecond_cursor_the_data_routeexpects(client, daily_feed):
    """Paging correctness: ``to`` (seconds) must reach the loader as ``before`` ms.

    If someone multiplies by 1000 in the wrong place, the chart does not error —
    it just shows the wrong decade, which is the kind of bug only an assertion on
    the outgoing argument can catch.
    """
    to = _day_ts(2026, 9, 10)
    client.get(
        "/api/udf/history", params={"symbol": "600519.SH", "resolution": "D", "to": to}
    )
    assert daily_feed["seen"][-1]["before"] == to * 1000


def test_history_countback_beats_from_and_returns_the_requested_length(client, daily_feed):
    """``countback`` wins over ``from``, which the protocol states outright.

    The window is what the library is *not* asking about any more when it sends
    a bar count, so honouring a stale ``from`` here would answer 3 bars to a
    request for 8 and leave the left of the chart blank.
    """
    frm = _day_ts(2026, 9, 18)
    to = _day_ts(2026, 9, 21)
    body = client.get(
        "/api/udf/history",
        params={"symbol": "600519.SH", "resolution": "D", "from": frm, "to": to, "countback": 8},
    ).json()
    assert len(body["t"]) == 8
    assert body["t"][-1] < to


def test_history_unknown_resolution_is_an_error_naming_the_known_ones(client, daily_feed):
    body = client.get(
        "/api/udf/history", params={"symbol": "600519.SH", "resolution": "3M"}
    ).json()
    assert body["s"] == "error"
    assert "unsupported resolution" in body["errmsg"]
    assert "D" in body["errmsg"]


def test_history_rejects_unknown_adjust_and_session_instead_of_guessing(client, daily_feed):
    assert client.get(
        "/api/udf/history",
        params={"symbol": "600519.SH", "resolution": "D", "adjust": "forward"},
    ).json()["errmsg"].startswith("unsupported adjust")
    assert client.get(
        "/api/udf/history",
        params={"symbol": "600519.SH", "resolution": "D", "session": "today"},
    ).json()["errmsg"].startswith("unsupported session")


def test_history_empty_window_is_no_data_with_a_seconds_cursor(client, daily_feed):
    """``t: []`` with ``s: ok`` reads to the widget as "this stock never traded"."""
    bars = daily_feed["bars"]
    first = int(bars[0]["timestamp"]) // 1000
    body = client.get(
        "/api/udf/history",
        params={
            "symbol": "600519.SH",
            "resolution": "D",
            "from": first - 40 * DAY,
            "to": first - 30 * DAY,
        },
    ).json()
    assert body["s"] == "no_data"
    assert "t" not in body
    # Nothing exists before that window, so no cursor may be invented either.
    assert "nextTime" not in body


def test_history_no_data_cursor_points_at_the_nearest_older_bar(client, daily_feed):
    bars = daily_feed["bars"]
    # A window a whole month past the end of the feed: the loader hands back
    # everything it has, and all of it is further back than ``from``.
    newest = int(bars[-1]["timestamp"]) // 1000
    frm = newest + 30 * DAY
    body = client.get(
        "/api/udf/history",
        params={
            "symbol": "600519.SH",
            "resolution": "D",
            "from": frm,
            "to": frm + 10 * DAY,
        },
    ).json()
    assert body["s"] == "no_data"
    assert body["nextTime"] == newest


def test_history_error_keeps_the_data_routes_by_cause_message(client, monkeypatch):
    """OpenD-down and unknown-symbol must stay distinguishable in the widget."""

    def boom(*_a, **_kw):
        raise LookupError("no daily data for FOO.US")

    monkeypatch.setattr(market_routes, "_fetch_daily", boom)
    body = client.get(
        "/api/udf/history", params={"symbol": "FOO.US", "resolution": "D"}
    ).json()
    assert body["s"] == "error"
    assert body["errmsg"] == "no daily data for FOO.US"


def test_history_unexpected_failure_is_a_type_name_not_a_stack_trace(client, monkeypatch):
    def boom(*_a, **_kw):
        raise RuntimeError("gateway exploded")

    monkeypatch.setattr(market_routes, "_fetch_daily", boom)
    body = client.get(
        "/api/udf/history", params={"symbol": "600519.SH", "resolution": "D"}
    ).json()
    assert body == {"s": "error", "errmsg": "history fetch failed: RuntimeError"}


def test_history_session_latest_passes_the_view_extension_through(client, minute_feed):
    body = client.get(
        "/api/udf/history",
        params={"symbol": "600519.SH", "resolution": "1", "session": "latest"},
    ).json()
    assert body["s"] == "ok"
    assert body["session_date"] == "2026-09-04"
    assert body["prev_close"] is None
    assert body["source"] == "futu:opend"
    assert len(body["t"]) == len(minute_feed)


# --------------------------------------------------------------------------- #
# /search, /symbols, /symbol_info
# --------------------------------------------------------------------------- #

_ROSTER = [
    {"symbol": "600519.SH", "name": "贵州茅台", "type": "equity", "market": "CN"},
    {"symbol": "0700.HK", "name": "腾讯控股", "type": "equity", "market": "HK"},
    {"symbol": "AAPL.US", "name": "Apple", "type": "equity", "market": "US"},
    {"symbol": "BTC-USDT", "name": "Bitcoin", "type": "crypto", "market": "CC"},
]


@pytest.fixture()
def minute_feed(monkeypatch):
    """Pin the minute path to one trading session of bars (no gateway, no Sina).

    Separate from :func:`daily_feed` because ``_kline_sync`` takes a different
    branch per interval: patching only the daily chain would let an intraday
    test fall through into a real ``import akshare``.
    """
    day = _day_ts(2026, 9, 4)
    bars = [
        {
            "timestamp": (day + 9 * 3600 + 30 * 60 + i * 60) * 1000,
            "open": 10.0,
            "high": 11.0,
            "low": 9.0,
            "close": 10.5,
            "volume": 1.0,
        }
        for i in range(12)
    ]
    monkeypatch.setattr(market_routes, "_futu_minute_bars", lambda *a, **kw: list(bars))
    return bars


@pytest.fixture()
def roster(monkeypatch):
    monkeypatch.setattr(
        "src.symbol_roster.peek_roster", lambda **_kw: (list(_ROSTER), False)
    )

    def fake_search(query, *, limit=20, rows=None, load=True):
        rows = rows if rows is not None else list(_ROSTER)
        needle = (query or "").lower()
        hits = [
            r
            for r in rows
            if needle in r["symbol"].lower() or needle in r["name"].lower()
        ]
        return hits[:limit]

    monkeypatch.setattr("src.symbol_roster.search", fake_search)
    return _ROSTER


def test_search_answers_a_bare_array_with_stable_venue_codes(client, roster):
    body = client.get("/api/udf/search", params={"query": "茅台"}).json()
    assert isinstance(body, list) and len(body) == 1
    hit = body[0]
    assert hit["symbol"] == "600519.SH" and hit["ticker"] == "600519.SH"
    assert hit["exchange"] == "SSE" and hit["type"] == "stock"
    assert hit["session"] == "0930-1130,1300-1500"


def test_search_exchange_filter_uses_the_codes_config_publishes(client, roster):
    """``exchange=`` comes back to us as a value we published in ``/config``.

    Matching on ``.`` is deliberate: it hits one row per venue in the fixture,
    so a filter that quietly dropped everything would fail on the venue with
    ``want == 1`` rather than being proven by a ``want == 0`` alone.
    """
    cfg = client.get("/api/udf/config").json()
    offered = {e["value"] for e in cfg["exchanges"]} - {""}
    for venue, want in (("SSE", 1), ("HKEX", 1), ("US", 1), ("BSE", 0)):
        assert venue in offered
        hits = client.get(
            "/api/udf/search", params={"query": ".", "exchange": venue}
        ).json()
        assert [h["exchange"] for h in hits] == [venue] * want, venue


def test_search_blank_query_and_empty_index_both_answer_an_empty_list(client, roster):
    assert client.get("/api/udf/search", params={"query": "  "}).json() == []


def test_search_cold_roster_is_an_empty_array_not_an_error(client, monkeypatch):
    monkeypatch.setattr("src.symbol_roster.peek_roster", lambda **_kw: ([], True))
    assert client.get("/api/udf/search", params={"query": "600"}).json() == []


def test_symbols_resolve_names_the_ticker_the_history_route_accepts(client, roster):
    info = client.get("/api/udf/symbols", params={"symbol": "600519.SH"}).json()
    assert info["ticker"] == "600519.SH"
    assert info["name"] == info["ticker"]
    assert info["description"] == "贵州茅台"
    assert info["timezone"] == "Asia/Shanghai"
    assert info["pricescale"] == 100


def test_symbols_resolve_offers_intraday_only_where_a_minute_path_exists(client, roster):
    a_share = client.get("/api/udf/symbols", params={"symbol": "600519.SH"}).json()
    assert a_share["has_intraday"] is True
    assert "1" in a_share["supported_resolutions"]

    bj = client.get("/api/udf/symbols", params={"symbol": "830799.BJ"}).json()
    assert bj["has_intraday"] is False
    assert bj["supported_resolutions"] == ["D", "W", "M"]


def test_symbols_resolve_strips_the_venue_token_the_library_prepends(client, roster):
    """``SSE:600519.SH`` comes back from a search; the suffix already says it."""
    info = client.get("/api/udf/symbols", params={"symbol": "SSE:600519.SH"}).json()
    assert info["ticker"] == "600519.SH"


def test_symbols_resolve_crypto_gets_a_24x7_session_and_its_own_venue(client, roster):
    info = client.get("/api/udf/symbols", params={"symbol": "BTC-USDT"}).json()
    assert info["type"] == "crypto" and info["exchange"] == "CRYPTO"
    assert info["session"] == "0000-2359"


def test_symbol_info_group_is_a_table_and_collapses_constant_columns(client, roster):
    table = client.get("/api/udf/symbol_info", params={"group": "SSE"}).json()
    assert table["symbol"] == ["600519.SH"]
    assert table["pricescale"] == 100, "a column of one value is sent as that value"
    assert isinstance(table["description"], list)


def test_symbol_info_unknown_group_is_a_404(client, roster):
    """The protocol is explicit: an unknown group is a status, not an empty body."""
    response = client.get("/api/udf/symbol_info", params={"group": "NOWHERE"})
    assert response.status_code == 404
    assert "unknown group" in response.json()["errmsg"]


# --------------------------------------------------------------------------- #
# /quotes — the live channel
# --------------------------------------------------------------------------- #

def test_quotes_use_the_trading_panel_field_names_and_second_clock(client, monkeypatch):
    rows = [
        {
            "symbol": "600519.SH",
            "ok": True,
            "last": 440.2,
            "change_pct": 1.23,
            "prev_close": 434.85,
            "open": 435.0,
            "high": 441.0,
            "low": 434.0,
            "volume": 3_200_000.0,
            "turnover": 1.4e9,
            "timestamp": _day_ts(2026, 9, 4) * 1000 + 500,
            "realtime": True,
        }
    ]
    monkeypatch.setattr(market_routes, "_quote_batch", lambda items: rows)
    body = client.get("/api/udf/quotes", params={"symbols": "600519.SH"}).json()
    assert body["s"] == "ok"
    tile = body["d"][0]
    assert tile["s"] == "ok" and tile["n"] == "600519.SH"
    value = tile["v"]
    assert value["lp"] == 440.2
    assert value["chp"] == 1.23
    assert value["ch"] == pytest.approx(5.35, abs=1e-9)
    assert value["prev_close_price"] == 434.85
    assert value["update_time"] == _day_ts(2026, 9, 4)
    assert isinstance(value["lp"], float), "a price rendered as a string draws nothing"


def test_quotes_omit_keys_the_source_cannot_answer_instead_of_zero_filling(client, monkeypatch):
    """A daily-chain row has no session; ``lp: 0`` would be a lie, ``""`` a string."""
    monkeypatch.setattr(
        market_routes,
        "_quote_batch",
        lambda items: [{"symbol": "600519.SH", "ok": True, "last": 10.0, "timestamp": None}],
    )
    value = client.get("/api/udf/quotes", params={"symbols": "600519.SH"}).json()["d"][0]["v"]
    assert set(value) == {"lp", "short_name", "exchange", "symbol_name", "currency_code"}


def test_quotes_keep_per_symbol_failures_in_the_row(client, monkeypatch):
    monkeypatch.setattr(
        market_routes,
        "_quote_batch",
        lambda items: [
            {"symbol": "600519.SH", "ok": True, "last": 10.0},
            {"symbol": "FOO.US", "ok": False, "error": "no data"},
        ],
    )
    body = client.get("/api/udf/quotes", params={"symbols": "600519.SH,FOO.US"}).json()
    assert [row["s"] for row in body["d"]] == ["ok", "error"]
    assert body["d"][1]["errmsg"] == "no data"


def test_quotes_without_symbols_is_an_error_not_an_empty_panel(client):
    body = client.get("/api/udf/quotes", params={"symbols": " , "}).json()
    assert body["s"] == "error"


def test_marks_endpoints_answer_bare_arrays_as_declared(client):
    cfg = client.get("/api/udf/config").json()
    assert cfg["supports_marks"] is False and cfg["supports_timescale_marks"] is False
    for path in ("/api/udf/marks", "/api/udf/timescale_marks"):
        body = client.get(path, params={"symbol": "600519.SH"}).json()
        assert body == []


# --------------------------------------------------------------------------- #
# the claim that makes this a refactor and not a second data feed
# --------------------------------------------------------------------------- #

@pytest.mark.parametrize(
    ("resolution", "interval", "bar_span"),
    [("D", "1D", DAY), ("W", "1W", 7 * DAY), ("M", "1M", 31 * DAY)],
)
def test_udf_history_and_market_kline_are_the_same_bars(
    client, daily_feed, resolution, interval, bar_span
):
    """Bar-for-bar equality over HTTP, one window, two protocols.

    This is the whole reason ``udf_routes`` calls ``_kline_sync`` instead of
    fetching: two feeds that each re-implement Futu-first routing, the qfq caliber
    guard and the weekly fold end up drawing a different tape than the page
    underneath them, and nothing fails loudly when they do.

    The overlap rule is spelled out here with its own literal table instead of
    importing the module's, so that "a bar counts when it covers the window" is
    checked against the calendar and not against the same expression twice.
    """
    bars = daily_feed["bars"]
    frm = int(bars[2]["timestamp"]) // 1000
    to = int(bars[15]["timestamp"]) // 1000

    kline = client.get(
        "/market/kline",
        params={"symbol": "600519.SH", "interval": interval, "count": 200, "before": to * 1000},
    ).json()["bars"]
    kline_in_window = [
        b for b in kline
        if int(b["timestamp"]) // 1000 < to and int(b["timestamp"]) // 1000 + bar_span > frm
    ]

    udf = client.get(
        "/api/udf/history",
        params={"symbol": "600519.SH", "resolution": resolution, "from": frm, "to": to},
    ).json()

    assert kline_in_window, "the window has to actually hold a bar for this to mean anything"
    assert udf["s"] == "ok"
    assert udf["t"] == [b["timestamp"] // 1000 for b in kline_in_window]
    for column, key in (("o", "open"), ("h", "high"), ("l", "low"), ("c", "close"), ("v", "volume")):
        assert [round(v, 6) for v in udf[column]] == [
            round(float(b[key]), 6) for b in kline_in_window
        ], column


def test_every_udf_path_is_under_the_api_prefix(client):
    """``/api/`` never falls through to the SPA shell, so a typo 404s as JSON.

    The prefix is load-bearing rather than cosmetic: a bare ``/udf`` mount would
    be swallowed by the SPA catch-all and answer an unknown protocol path with
    ``index.html`` at 200 — see :mod:`src.api.spa`. Reading the paths back off
    the mounted app (instead of a hand-written list) is what makes renaming the
    prefix in one place the only thing a caller has to do.
    """
    paths = {getattr(route, "path", "") for route in client.app.routes}
    for name in (
        "config", "time", "search", "symbols", "symbol_info",
        "history", "marks", "timescale_marks", "quotes",
    ):
        assert f"{udf_routes.UDF_PREFIX}/{name}" in paths, name
    assert not [path for path in paths if path.startswith("/udf")]


def test_api_server_mounts_the_protocol():
    """The mount lives in the assembler; a forgotten line here is a silent 404."""
    import api_server

    # ``getattr`` because the real app also carries routers whose entries have
    # no ``path`` attribute — this is the assembled app, not a bare FastAPI.
    paths = {getattr(route, "path", "") for route in api_server.app.routes}
    assert f"{udf_routes.UDF_PREFIX}/history" in paths
    assert f"{udf_routes.UDF_PREFIX}/config" in paths
