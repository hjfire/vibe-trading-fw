"""TradingView UDF (Universal Datafeed) protocol front door for the chart.

Mounted by ``agent/api_server.py`` via ``register_udf_routes(app)``.

Why this module exists
----------------------
The chart page (``frontend/src/pages/ProChart.tsx``) and the data route
(``market_routes.py``) had grown a private contract: ``interval=1m``, epoch
**milliseconds** on the wire, ``bars: [{timestamp, open, ...}]`` row-wise, and a
``{status, error}`` envelope. That is a perfectly good contract for one page, and
it is not a standard: nothing but our own page can read it, so "swap in
TradingView Advanced Charts" (whose built-in adapter speaks UDF) would have
meant writing a second data route from memory and hoping both kinds of bar came
out the same.

This module is that standard, implemented once against the plumbing that already
exists. **It fetches nothing.** Every bar comes out of
:func:`src.api.market_routes._kline_sync`, so the Futu-OpenD-first routing, the
``autype="qfq"`` caliber guard, the exchange wall-clock table and the
weekly/monthly merge all stay in exactly one place. Two feeds that each
re-implement the routing are how a widget ends up drawing a different tape than
the page underneath it.

Endpoints (paths below the mount prefix, per the published UDF protocol)
------------------------------------------------------------------------
* ``GET  /config``   datafeed capabilities (``supported_resolutions``, ...)
* ``GET  /time``     server clock, bare unix **seconds**
* ``GET  /search``   type-ahead, array of ``SearchSymbolResultItem``
* ``GET  /symbols``  one symbol -> ``LibrarySymbolInfo``
* ``GET  /symbol_info?group=``  the same, whole-venue table (group mode)
* ``GET  /history``  OHLCV columns ``{s, t, o, h, l, c, v}`` in unix seconds
* ``GET  /marks`` / ``/timescale_marks``  ``[]`` (declared unsupported)
* ``GET  /quotes``  ``{s, d:[{s, n, v}]}`` for the trading-panel layout

Units, because this is where a UDF server goes wrong quietly
-----------------------------------------------------------
``/history`` timestamps are unix **seconds** and ``/time`` is seconds, while
``/market/kline`` has always been milliseconds (the unit KLineChart v10 wants).
The conversion is this module's job and the page converts back on arrival; no
function in the middle is allowed to accept "a timestamp" without saying which
unit it means. ``market_routes._bars_from_frame`` stamps daily bars at midnight
UTC of their trading day, which is exactly what UDF asks for a daily bar, so the
division is a unit change and never a calendar shift.

Real-time
---------
Deliberately not a WebSocket. The library's own ``UDFCompatibleDatafeed``
implements live updates by re-reading a feed at ``updateFrequency`` (the docs
call UDF's live behaviour "pull/pulse based"), so ``/quotes`` — backed by one
batched FutuOpenD snapshot — is the standard-conformant live channel. Adding a
private WS protocol on top would make the widget the second consumer of a
message format only we understand.

Extensions, clearly marked
--------------------------
Two UDF-legal extras ride on ``/history`` because the 分时 view needs them and
the protocol has no slot for a single trading session: ``session=latest`` (the
view) and ``adjust`` (the 复权 caliber). Both are ignored by the library, so a
plain TradingView widget still works against this endpoint; only our page uses
them. Unknown ``session`` / ``adjust`` values are refused, never guessed.
"""

from __future__ import annotations

import asyncio
import logging
import math
import time
from typing import Any, Awaitable, Callable

from fastapi import Depends, FastAPI, Query
from fastapi.responses import JSONResponse, PlainTextResponse, Response

from src.api import market_routes

logger = logging.getLogger(__name__)

AuthDep = Callable[..., Awaitable[Any] | Any]

#: Default mount prefix. ``/api/`` rather than a bare ``/udf`` for the reason
#: documented in :mod:`src.api.warehouse_routes`: the API namespace never gets
#: the SPA shell, so an unregistered path 404s as JSON instead of answering 200
#: with ``index.html`` (see :mod:`src.api.spa`).
UDF_PREFIX = "/api/udf"

#: UDF resolution spellings -> ``market_routes`` interval tokens.
#:
#: The protocol names intraday bars by bare minutes (``"1"``, ``"60"``) and
#: calendar bars by a unit letter, with the ``"1D"`` form also accepted because
#: both spellings appear in the wild and in our own toolbar. ``"2D"`` / ``"3M"``
#: style multipliers are **not** here: the route has no such interval, and the
#: honest answer to an interval we cannot serve is an error naming the ones we
#: can — a silent round to the nearest neighbour would draw monthly bars on a
#: ``3M`` request and look like data.
_RESOLUTION_TO_INTERVAL: dict[str, str] = {
    "1": "1m",
    "5": "5m",
    "15": "15m",
    "30": "30m",
    "60": "60m",
    "1H": "60m",
    "1D": "1D",
    "D": "1D",
    "1W": "1W",
    "W": "1W",
    "1M": "1M",
    "M": "1M",
}

#: What ``/config`` advertises. The canonical spellings only: a chart that offers
#: a resolution the feed does not name is an offer the feed has to keep.
SUPPORTED_RESOLUTIONS: tuple[str, ...] = ("1", "5", "15", "30", "60", "D", "W", "M")

#: Approximate seconds per resolution, used only to size a bar count from a
#: ``[from, to)`` window when the library does not send ``countback``. Monthly is
#: 31 days (the long month), so the count can only ever come out too large and
#: be trimmed by the response — never too small, which would clip the window.
_RESOLUTION_SECONDS: dict[str, int] = {
    "1": 60,
    "5": 300,
    "15": 900,
    "30": 1800,
    "60": 3600,
    "1H": 3600,
    "D": 86400,
    "1D": 86400,
    "W": 604800,
    "1W": 604800,
    "M": 2678400,
    "1M": 2678400,
}

#: Venue code per market suffix, as ``/search`` and ``/symbols`` report the
#: exchange. These strings are what the library shows in its symbol dialog and
#: what ``exchange=`` in a later ``/search`` comes back as, so they have to be
#: stable identifiers rather than display names.
_EXCHANGE_BY_SUFFIX: dict[str, str] = {
    "SH": "SSE",
    "SZ": "SZSE",
    "BJ": "BSE",
    "HK": "HKEX",
    "US": "US",
}

#: Regular trading hours per venue, in the venue's own wall clock, as UDF wants
#: them: ``HHHH-HHH`` comma-separated, one entry per session.
#:
#: This table exists nowhere else in the repository — KLineChart is handed the
#: bars it is given and draws an axis from them, so it never needed to know when
#: a market opens. The library does need to know, because it extrapolates empty
#: bars and draws a session gap. Which zone each venue's clock is *already* is
#: in :data:`market_routes._MINUTE_WALL_CLOCK_ZONE` and is read from there below
#: rather than restated.
_SESSION_BY_SUFFIX: dict[str, str] = {
    "SH": "0930-1130,1300-1500",
    "SZ": "0930-1130,1300-1500",
    "BJ": "0930-1130,1300-1500",
    "HK": "0930-1600",
    "US": "0930-1600",
}

#: 24x7 venues have no session to name; UDF wants a range that covers the day.
_CRYPTO_SESSION = "0000-2359"

#: Fallback venue for a symbol nobody recognised, so a resolve request never
#: answers "unknown" to the library and blocks the chart from loading. The
#: session stays empty for those: an invented trading window on an instrument we
#: cannot classify is worse than no window, because the library would then hide
#: real bars that fall outside it.
_UNKNOWN_EXCHANGE = "unknown"

#: Price decimals. Two for every venue served here (A-shares, HK, US quote to
#: the cent) and the same for crypto, which is what the daily loader returns.
#: Volume is a whole number of shares/coins everywhere in this feed.
_PRICE_SCALE = 100
_VOLUME_PRECISION = 0

#: Statuses UDF allows in ``s``.
_S_OK, _S_NO_DATA, _S_ERROR = "ok", "no_data", "error"

#: Symbols per ``/quotes`` call, mirroring the watchlist cap that already exists.
_MAX_QUOTE_SYMBOLS = market_routes._MAX_QUOTE_SYMBOLS


# --------------------------------------------------------------------------- #
# capability + clock
# --------------------------------------------------------------------------- #

def config_payload() -> dict[str, Any]:
    """The ``/config`` body: what this feed can answer, stated as facts.

    ``supports_search`` and ``supports_group_request`` are the two the library
    requires, and they are mutually exclusive in practice: search is on because
    the roster can answer a keystroke, group request is off because the roster is
    ~5000 rows and shipping it to every browser tab to name one symbol is the
    inefficiency the docs warn about.
    """
    exchanges = [{"value": "", "name": "All Exchanges", "desc": ""}]
    exchanges += [
        {"value": code, "name": code, "desc": ""}
        for code in sorted(set(_EXCHANGE_BY_SUFFIX.values()))
    ]
    return {
        "api_version": 2,
        "supported_resolutions": list(SUPPORTED_RESOLUTIONS),
        "supports_search": True,
        "supports_group_request": False,
        "supports_marks": False,
        "supports_timescale_marks": False,
        "supports_time": True,
        "supports_resolve": True,
        "exchanges": exchanges,
        "symbolsTypes": [
            {"name": "All types", "value": ""},
            {"name": "股票", "value": "stock"},
            {"name": "指数", "value": "index"},
            {"name": "加密", "value": "crypto"},
        ],
        # Which upstreams may end up behind a bar. Informational, but naming them
        # here keeps the "is this from OpenD?" question answerable from the
        # protocol alone.
        "datasources": [
            "futu:opend",
            "warehouse",
            "akshare:sina",
            "backtest:loader_fallback_chain",
        ],
        "defaultSymbol": "600519.SH",
        "defaultSymbolDescription": "贵州茅台",
        "defaultInterval": "D",
        "timezone": "Asia/Shanghai",
        "serverTimezone": "UTC",
        "pricescale": [_PRICE_SCALE, _PRICE_SCALE],
        "min_period_size": "1",
        "records_per_request": market_routes._MAX_BARS,
        # The two extensions ``/history`` understands, advertised so a third party
        # reading only the protocol can discover them instead of finding out by
        # getting an empty answer to a question this feed does not ask.
        "extensions": {
            "history_params": ["session", "adjust"],
            "history_response": ["session_date", "prev_close", "source"],
        },
    }


def server_time_seconds() -> int:
    """``/time``: unix seconds, no milliseconds.

    A millisecond value here makes the library schedule its own updates years
    away, which looks like a dead feed rather than a wrong unit.
    """
    return int(time.time())


# --------------------------------------------------------------------------- #
# symbology
# --------------------------------------------------------------------------- #

def _suffix_of(symbol: str) -> str:
    """Market suffix, or ``""`` for a symbol with no venue tag (crypto, bare US)."""
    return symbol.rsplit(".", 1)[-1].upper() if "." in symbol else ""


def _is_crypto(symbol: str) -> bool:
    """``BTC-USDT`` style codes: a dash and no recognised venue suffix.

    The dash is the pair separator every crypto loader here uses, and the suffix
    test is what keeps a US ticker that happens to contain a dot out of the
    crypto branch. Deliberately local rather than imported: the loader chain
    reaches crypto through :func:`backtest.correlation.infer_market`, which keys
    off the same two facts — a copy of that function's rules would be a second
    table of "which market is this" to drift, and this one only has to answer
    "does this symbol have a venue suffix".
    """
    return "-" in symbol and _suffix_of(symbol) not in _EXCHANGE_BY_SUFFIX


def _market_type(row_type: str, symbol: str) -> str:
    """Map a roster ``type`` onto the instrument type the library expects.

    ``equity`` is what this project's roster calls a stock and ``stock`` is what
    the library calls it; passing the roster word through unchanged would put
    every symbol in an instrument type the symbol dialog has no label for. The
    roster's own vocabulary is ``equity`` / ``etf`` / ``index``, so that table is
    spelled out instead of being guessed at by substring.
    """
    if _is_crypto(symbol):
        return "crypto"
    return {"equity": "stock", "etf": "fund", "index": "index"}.get(
        (row_type or "").strip().lower(), "stock"
    )


def symbol_info(symbol: str, name: str = "", row_type: str = "") -> dict[str, Any]:
    """``LibrarySymbolInfo`` for one symbol, derived, never looked up.

    Two things this has to get right because the library acts on them:

    * ``ticker`` — the identifier used on every later request. It is the
      project's canonical ``600519.SH`` form, so a ``/history`` call that comes
      back through :func:`_kline_sync` is asking for the symbol that route
      already understands.
    * ``supported_resolutions`` — the offer the toolbar draws. Intraday is
      advertised only for the suffixes ``market_routes`` actually has a minute
      path for, so the widget never offers a button that would answer an error.
    """
    suffix = _suffix_of(symbol)
    intraday = suffix in market_routes._FUTU_MINUTE_SUFFIXES or suffix in {"SH", "SZ"}
    resolutions = list(SUPPORTED_RESOLUTIONS) if intraday else ["D", "W", "M"]
    exchange = _exchange_of(symbol)
    info: dict[str, Any] = {
        "name": symbol,
        "ticker": symbol,
        "description": name or symbol,
        "type": _market_type(row_type, symbol),
        "exchange": exchange,
        "listed_exchange": exchange,
        "session": _crypto_session_or(exchange, suffix),
        "timezone": market_routes._MINUTE_WALL_CLOCK_ZONE.get(suffix, "UTC"),
        "pricescale": _PRICE_SCALE,
        "minmov": 1,
        "minmov2": 0,
        "fractional": False,
        "volume_precision": _VOLUME_PRECISION,
        "has_volume": True,
        "has_intraday": intraday,
        "has_daily": True,
        "has_weekly_and_monthly": True,
        "supported_resolutions": resolutions,
        "visible_plots_set": "ohlcv",
    }
    if intraday:
        info["intraday_multipliers"] = ["1", "5", "15", "30", "60"]
    return info


def _exchange_of(name: str) -> str:
    """Venue code for a symbol: the suffix table, ``CRYPTO``, or ``unknown``."""
    if _is_crypto(name):
        return "CRYPTO"
    return _EXCHANGE_BY_SUFFIX.get(_suffix_of(name), _UNKNOWN_EXCHANGE)


def _crypto_session_or(exchange: str, suffix: str) -> str:
    """Session string for a venue, or the 24x7 one for crypto.

    Empty for anything unclassified, and that is the point: no session means the
    library draws every bar it is given instead of hiding the ones outside a
    window it was never told the truth about.
    """
    if exchange == "CRYPTO":
        return _CRYPTO_SESSION
    return _SESSION_BY_SUFFIX.get(suffix, "")


def search_results(query: str, *, limit: int, exchange: str = "") -> list[dict[str, Any]]:
    """``/search``: ``SearchSymbolResultItem`` rows from the local roster.

    The roster is the only search index here (see :mod:`src.symbol_roster` for
    why the vendors' suggest endpoints are not it), so a cold index answers an
    empty list and the widget falls back to typing a symbol in — which is exactly
    as designed for the page's own picker.
    """
    from src import symbol_roster

    rows, _stale = symbol_roster.peek_roster()
    hits = symbol_roster.search(query, limit=limit, rows=rows, load=False)
    out: list[dict[str, Any]] = []
    for row in hits:
        symbol = str(row.get("symbol") or "")
        if not symbol:
            continue
        suffix = _suffix_of(symbol)
        venue = _exchange_of(symbol)
        if exchange and venue != exchange:
            continue
        out.append(
            {
                "symbol": symbol,
                "ticker": symbol,
                "description": str(row.get("name") or symbol),
                "exchange": venue,
                "type": _market_type(str(row.get("type") or ""), symbol),
                "session": _crypto_session_or(venue, suffix),
            }
        )
    return out


def symbol_group_table(group: str, *, limit: int = 2000) -> dict[str, Any]:
    """``/symbol_info?group=`` as a UDF "response-as-a-table".

    Only reached when a client turns on ``supports_group_request`` — this feed
    advertises it off — but implemented because a group request is the same
    roster filtered by venue, and answering 404 for it would be a needless
    difference between what we can serve and what we claim to serve.

    Columns whose values are all equal collapse to a single value, per the
    protocol's size optimisation; ``pricescale`` is the one that always collapses
    here, since no venue in this feed quotes in fractions.
    """
    from src import symbol_roster

    rows, _stale = symbol_roster.peek_roster()
    suffixes = [sfx for sfx, code in _EXCHANGE_BY_SUFFIX.items() if code == group]
    if not suffixes:
        # An unrecognised group names no venue, so it selects nothing — and the
        # route turns the empty table into the 404 the protocol asks for. The
        # alternative (treat "no suffix matched" as "no filter") would answer a
        # typo'd group with the whole roster, which is the failure a client
        # cannot tell apart from a real one.
        return {}
    picked = [r for r in rows if _suffix_of(str(r.get("symbol") or "")) in suffixes][:limit]
    if not picked:
        return {}
    symbols = [str(r.get("symbol")) for r in picked]
    table: dict[str, Any] = {
        "symbol": symbols,
        "ticker": symbols,
        "description": [str(r.get("name") or "") for r in picked],
        "exchange_listed_name": [group] * len(picked),
        "type": [_market_type(str(r.get("type") or ""), s) for s, r in zip(symbols, picked)],
        "session-regular": [_crypto_session_or(group, _suffix_of(s)) for s in symbols],
        "timezone": [
            market_routes._MINUTE_WALL_CLOCK_ZONE.get(_suffix_of(s), "UTC") for s in symbols
        ],
        "pricescale": _PRICE_SCALE,
        "minmovement": 1,
        "has-intraday": True,
        "has-daily": True,
        "visible-plots-set": "ohlcv",
    }
    return table


# --------------------------------------------------------------------------- #
# history
# --------------------------------------------------------------------------- #

def _columns(bars: list[dict[str, Any]]) -> dict[str, Any]:
    """Row-wise bars -> the columnar arrays UDF sends.

    Seconds, deliberately: ``//`` on an int millisecond is a truncation, and for
    the two units this feed actually uses (midnight UTC daily, exchange-wall
    minute) truncation is exact. Rounding instead would be off by a second at the
    window's left edge on a sub-second stamp, which there is no such thing for
    here — but truncation is also what makes ``t[i] < t[i+1]`` survive a bar that
    starts mid-second, so it is the right choice independent of that argument.
    """
    times = [int(bar["timestamp"]) // 1000 for bar in bars]
    return {
        "t": times,
        "o": [float(bar["open"]) for bar in bars],
        "h": [float(bar["high"]) for bar in bars],
        "l": [float(bar["low"]) for bar in bars],
        "c": [float(bar["close"]) for bar in bars],
        "v": [float(bar.get("volume") or 0.0) for bar in bars],
    }


def _bar_count(resolution: str, frm: int, to: int, countback: int | None) -> int:
    """How many bars to ask the loader for to cover ``[from, to)``.

    ``countback`` wins when the library sends it (it means "``countback`` bars
    ending at ``to``", and is the only request shape that avoids asking for a
    range nobody traded). Note there is **no minimum bar count** here: ``/market/kline``
    validates ``ge=10`` because a human scrolling back with 3 bars would be a
    broken UI, but a widget legitimately asks for 1 bar to fill a hole, and
    quietly answering 10 would return bars the caller did not ask for. This
    module calls :func:`market_routes._kline_sync` directly, so that route's
    query model never sees the number.
    """
    if countback and countback > 0:
        return max(1, min(int(countback), market_routes._MAX_BARS))
    per_bar = _RESOLUTION_SECONDS.get(resolution, 86400)
    span = max(int(to) - int(frm), 0)
    estimated = math.ceil(span / per_bar) + 2 if span else market_routes._MAX_BARS
    return max(1, min(estimated, market_routes._MAX_BARS))


def history_payload(
    symbol: str,
    resolution: str,
    frm: int | None,
    to: int | None,
    countback: int | None = None,
    adjust: str = "qfq",
    session: str = "",
) -> dict[str, Any]:
    """One ``/history`` answer: ``ok`` columns, ``no_data`` + ``nextTime``, or error.

    ``no_data`` and ``nextTime`` are the part a hand-rolled feed usually gets
    wrong. When the requested window holds nothing, the protocol does not want an
    empty array — it wants the timestamp of the newest bar that exists *before*
    the window, so the library can page to where the data is instead of concluding
    the symbol has no history. Returning ``t: []`` with ``s: "ok"`` reads as "this
    stock never traded" to the widget.

    ``nextTime`` is seconds, matching ``t``. TradingView's own page prints a
    millisecond value in one example and seconds in another; seconds is the
    reading consistent with the array it is describing, and the adapter in
    ``frontend/src/lib/udfDatafeed.ts`` normalises either unit.

    A window that holds nothing but has bars *after* it also answers ``no_data``
    without a ``nextTime``: the cursor means "the closest bar further back in
    time", and inventing one out of the future would page the chart the wrong
    way with a timestamp it was never asked for.
    """
    interval = _RESOLUTION_TO_INTERVAL.get(resolution)
    if interval is None:
        return {
            "s": _S_ERROR,
            "errmsg": (
                f"unsupported resolution {resolution!r} (known: {'/'.join(SUPPORTED_RESOLUTIONS)})"
            ),
        }
    if adjust not in market_routes._ADJUSTS:
        return {
            "s": _S_ERROR,
            "errmsg": f"unsupported adjust {adjust!r} (known: none/qfq/hfq)",
        }
    if session not in {"", "latest"}:
        return {
            "s": _S_ERROR,
            "errmsg": f"unsupported session {session!r} (only 'latest' is defined)",
        }

    to_s = int(to) if to else server_time_seconds()
    frm_s = int(frm) if frm else 0
    count = _bar_count(resolution, frm_s, to_s, countback)
    try:
        payload = market_routes._kline_sync(
            symbol.strip().upper(), interval, count, adjust, before=to_s * 1000, session=session
        )
    except (ValueError, LookupError) as exc:
        # The route's own "which of these two cases is it" messages survive into
        # the widget's error dialog here; collapsing them to "history failed"
        # would send the operator to the network instead of to OpenD.
        return {"s": _S_ERROR, "errmsg": str(exc)}
    except Exception as exc:  # noqa: BLE001 — never hand the library a stack trace
        logger.exception("udf history failed (%s %s)", symbol, resolution)
        return {"s": _S_ERROR, "errmsg": f"history fetch failed: {type(exc).__name__}"}

    bars: list[dict[str, Any]] = list(payload.get("bars") or [])
    if session == "latest":
        # One trading session, already sliced server-side; the window and the
        # paging cursor are both meaningless here, so nothing below is applied.
        out: dict[str, Any] = {"s": _S_OK, **_columns(bars)}
        out["session_date"] = payload.get("session_date") or ""
        out["prev_close"] = payload.get("prev_close")
        out["source"] = payload.get("source") or ""
        return out

    # Overlap, not containment. A bar is *required* when it covers any part of
    # ``[from, to)``, and the two spellings differ exactly where the chart is
    # drawn from a coarse series: a monthly bar is timestamped its first trading
    # day (Sep 1), so a window opening mid-month (``from`` = Sep 3) contains none
    # of its own bar's timestamps and the widget would answer "no data" about a
    # month that has one — a hole at the left edge that looks like a thin
    # history. ``_RESOLUTION_SECONDS`` is the generous approximation of a bar's
    # width (31 days for a month), which can only ever over-include a bar that
    # really does reach the window, never drop one.
    #
    # ``countback`` short-circuits the filter entirely, because the protocol says
    # so ("If countback is set, from should be ignored"): the caller has asked for
    # N bars ending at ``to``, and applying a stale ``from`` on top would return
    # fewer bars than were requested for a window the caller no longer means.
    span = _RESOLUTION_SECONDS.get(resolution, 86400)
    starts = [int(b["timestamp"]) // 1000 for b in bars]
    if countback and countback > 0:
        in_window = bars
    else:
        in_window = [
            bar for bar, start in zip(bars, starts) if start < to_s and start + span > frm_s
        ]
    if not in_window:
        # `nextTime` belongs to this branch and only this branch: the protocol
        # defines it as "unix timestamp of the next available bar *if s is
        # no_data*". Attaching it to an `ok` page would be a second, private
        # paging channel — our own chart pages with the `from`/`to` window it
        # already sends, and a stock TradingView widget ignores the key there.
        out = {"s": _S_NO_DATA}
        older = [start for start in starts if start + span <= frm_s]
        if older:
            out["nextTime"] = older[-1]
        out["source"] = payload.get("source") or ""
        return out

    return {"s": _S_OK, **_columns(in_window), "source": payload.get("source") or ""}


# --------------------------------------------------------------------------- #
# quotes (the live channel: /quotes re-read, per the UDF adapter's own design)
# --------------------------------------------------------------------------- #

def _quote_value(row: dict[str, Any]) -> dict[str, Any]:
    """One watchlist row as the ``v`` object the trading panel reads.

    ``lp`` is last price, ``ch`` the absolute change and ``chp`` the percentage —
    three names for two numbers, so ``ch`` is computed from ``last`` and
    ``prev_close`` rather than copied from ``chp`` (a tile that prints a
    percentage in a price slot is a classic UDF integration bug, and the row this
    reads already carries both).

    The values come from :func:`market_routes._quote_batch`, so a quote here is
    the same number the page's watchlist is showing, out of the same FutuOpenD
    snapshot — and a row that came off the daily chain instead is missing the
    session keys, which are then *absent* rather than zero-filled.
    """
    name = str(row.get("symbol") or "")
    last = row.get("last")
    prev_close = row.get("prev_close")
    change = row.get("change_pct")
    value: dict[str, Any] = {
        "lp": last,
        "chp": change,
        "short_name": name,
        "exchange": _exchange_of(name),
        "symbol_name": name,
        "currency_code": "CNY",
    }
    if isinstance(last, (int, float)) and isinstance(prev_close, (int, float)):
        value["ch"] = round(last - prev_close, 4)
        value["prev_close_price"] = prev_close
    # No recovery branch for "change but no prev close": both quote producers
    # here (`_live_quote_row` off the tape and `_quote_one` off the daily chain)
    # send `prev_close` now, so the arithmetic above always has both operands. A
    # branch that infers one from the other would be untestable by construction.
    for udf_key, row_key in (
        ("open_price", "open"),
        ("high_price", "high"),
        ("low_price", "low"),
        ("volume", "volume"),
        ("turnover", "turnover"),
    ):
        if row.get(row_key) is not None:
            value[udf_key] = row[row_key]
    if row.get("timestamp"):
        value["update_time"] = int(row["timestamp"]) // 1000
    # The percent sign belongs to the widget, not to this payload: an
    # ``lp: "440.2"`` string would make every price field a string.
    return {k: v for k, v in value.items() if v is not None}


def quotes_payload(symbols: str) -> dict[str, Any]:
    """``/quotes?symbols=A,B,C`` -> ``{s, d:[{s, n, v}]}``.

    Per-symbol failures stay in-row (``s:"error"``), which is what lets a panel of
    thirty watchlist names still draw twenty-nine tiles. The batch itself only
    fails as a whole when the loader chain raises.
    """
    items = [s.strip().upper() for s in symbols.split(",") if s.strip()][:_MAX_QUOTE_SYMBOLS]
    if not items:
        return {"s": _S_ERROR, "errmsg": "no symbols provided"}
    rows = market_routes._quote_batch(items)
    d: list[dict[str, Any]] = []
    for row in rows:
        name = str(row.get("symbol") or "")
        if not row.get("ok"):
            d.append({"s": "error", "n": name, "errmsg": str(row.get("error") or "no data")})
            continue
        d.append({"s": "ok", "n": name, "v": _quote_value(row)})
    return {"s": _S_OK, "d": d}


# --------------------------------------------------------------------------- #
# mounting
# --------------------------------------------------------------------------- #

def register_udf_routes(
    app: FastAPI, require_auth: AuthDep | None = None, *, prefix: str = UDF_PREFIX
) -> None:
    """Mount the UDF endpoints under ``prefix`` (options_routes pattern).

    ``prefix`` is a parameter rather than a constant because a self-hosted
    TradingView widget pointed at ``datafeedURL = "<origin>/api/udf"`` needs
    nothing special, while one vendored into a page that already owns ``/api``
    may want the protocol at the root. The endpoint *names below* the prefix are
    fixed by the protocol and are not configurable.
    """
    if require_auth is None:
        import sys as _sys

        host = _sys.modules.get("api_server") or _sys.modules.get("agent.api_server")
        if host is None:  # pragma: no cover — only triggers on weird import setups
            raise RuntimeError(
                "register_udf_routes: api_server module not in sys.modules; "
                "pass require_auth explicitly"
            )
        require_auth = host.require_auth

    @app.get(f"{prefix}/config", dependencies=[Depends(require_auth)])
    async def udf_config() -> dict[str, Any]:
        """Datafeed capabilities; the first request the library makes."""
        return config_payload()

    @app.get(f"{prefix}/time", dependencies=[Depends(require_auth)])
    async def udf_time() -> Response:
        """Bare unix seconds as text — not a JSON object, the protocol reads a number."""
        return PlainTextResponse(str(server_time_seconds()), media_type="text/plain")

    @app.get(f"{prefix}/search", dependencies=[Depends(require_auth)])
    async def udf_search(
        query: str = Query("", max_length=64, description="Text typed in the symbol box"),
        type: str = Query("", max_length=32, description="Instrument type filter"),  # noqa: A002
        exchange: str = Query("", max_length=32, description="Venue filter"),  # noqa: A002
        limit: int = Query(20, ge=1, le=100),
    ) -> list[dict[str, Any]]:
        """Type-ahead candidates, as a bare array (the protocol sends no envelope)."""
        if not query.strip():
            return []
        return await asyncio.to_thread(
            search_results, query.strip(), limit=limit, exchange=exchange.strip()
        )

    @app.get(f"{prefix}/symbols", dependencies=[Depends(require_auth)])
    async def udf_symbols(
        symbol: str = Query(..., min_length=1, max_length=64, description="Symbol or EXCHANGE:SYMBOL"),
    ) -> Response:
        """Resolve one symbol to ``LibrarySymbolInfo``.

        ``EXCHANGE:SYMBOL`` is a spelling the library sends back after a search,
        so it is accepted and dropped here — the project's canonical form already
        carries the venue in its suffix, and a second venue token would be a
        second source of truth about which market a code belongs to.
        """
        raw = symbol.strip().upper()
        if ":" in raw:
            raw = raw.split(":", 1)[1] or raw

        def _lookup() -> dict[str, Any]:
            from src import symbol_roster

            hits = symbol_roster.search(raw, limit=1, load=False)
            row = hits[0] if hits else {}
            # A roster miss is not a refusal: the chart still needs to know which
            # resolutions to offer, and that is derivable from the suffix alone.
            return symbol_info(
                raw,
                name=str(row.get("name") or ""),
                row_type=str(row.get("type") or ""),
            )

        try:
            return await asyncio.to_thread(_lookup)
        except Exception:  # noqa: BLE001 — a resolve failure must not be a 500
            logger.exception("udf symbol resolve failed (%s)", raw)
            return JSONResponse(
                status_code=404, content={"s": _S_ERROR, "errmsg": f"unknown symbol {raw!r}"}
            )

    @app.get(f"{prefix}/symbol_info", dependencies=[Depends(require_auth)])
    async def udf_symbol_info(
        group: str = Query(..., min_length=1, max_length=32, description="Symbol group / venue"),
    ) -> Response:
        """Whole-group table, only consulted when ``supports_group_request`` is on."""
        table = await asyncio.to_thread(symbol_group_table, group.strip().upper())
        if not table:
            # The protocol is explicit: an unknown group is a 404, not an empty
            # body the client has to interpret.
            return JSONResponse(
                status_code=404, content={"s": _S_ERROR, "errmsg": f"unknown group {group!r}"}
            )
        return JSONResponse(content=table)

    @app.get(f"{prefix}/history", dependencies=[Depends(require_auth)])
    async def udf_history(
        symbol: str = Query(..., min_length=1, max_length=64),
        resolution: str = Query("D", max_length=8),
        frm: int = Query(0, alias="from", ge=0, description="unix seconds of the leftmost bar"),
        to: int | None = Query(None, ge=0, description="unix seconds, not inclusive"),
        countback: int | None = Query(None, ge=1, description="bars ending at `to`; beats `from`"),
        adjust: str = Query("qfq", description="extension: none/qfq/hfq price caliber"),
        session: str = Query("", description="extension: 'latest' for one trading session"),
    ) -> dict[str, Any]:
        """OHLCV columns in unix seconds, or ``no_data`` with a paging cursor."""
        return await asyncio.to_thread(
            history_payload, symbol, resolution, frm, to, countback, adjust, session
        )

    @app.get(f"{prefix}/marks", dependencies=[Depends(require_auth)])
    async def udf_marks(
        symbol: str = Query(..., max_length=64),  # noqa: ARG001 — protocol shape
        resolution: str = Query("D", max_length=8),  # noqa: ARG001
        frm: int = Query(0, alias="from", ge=0),  # noqa: ARG001
        to: int | None = Query(None, ge=0),  # noqa: ARG001
    ) -> list[Any]:
        """Bar marks: none, and declared as none in ``/config``."""
        return []

    @app.get(f"{prefix}/timescale_marks", dependencies=[Depends(require_auth)])
    async def udf_timescale_marks(
        symbol: str = Query(..., max_length=64),  # noqa: ARG001
        resolution: str = Query("D", max_length=8),  # noqa: ARG001
        frm: int = Query(0, alias="from", ge=0),  # noqa: ARG001
        to: int | None = Query(None, ge=0),  # noqa: ARG001
    ) -> list[Any]:
        """Time-scale marks: none, and declared as none in ``/config``."""
        return []

    @app.get(f"{prefix}/quotes", dependencies=[Depends(require_auth)])
    async def udf_quotes(
        symbols: str = Query(..., min_length=1, description="Comma-separated tickers"),
    ) -> dict[str, Any]:
        """Quote objects for the trading panel; also this feed's live update channel."""
        return await asyncio.to_thread(quotes_payload, symbols)
