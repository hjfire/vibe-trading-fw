"""Market K-line HTTP routes for the Web pro-chart page.

Mounted by ``agent/api_server.py`` via ``register_market_routes(app)``.

Routes (auth via the caller-supplied ``require_auth`` dependency):

- ``GET /market/kline``  — single-instrument OHLCV bars for interactive charts.
- ``GET /market/quote``  — batch last-price + change-pct quotes for the watchlist.
- ``GET /market/symbols`` — type-ahead symbol lookup over the local roster.

Daily bars walk the same loader fallback chain ``/correlation`` uses
(``backtest.correlation._fetch_price_series``), so any instrument the
backtest layer can serve is chartable without new data plumbing.

Minute bars (1m/5m/15m/30m/60m) come off **FutuOpenD first, for every market it
lists** (.SH/.SZ/.HK/.US) -- it is the only source here with intraday bars for
HK and US equities. Two deliberate limits on that:

* ``FutuLoader`` pins ``autype="qfq"``, so a ``none``/``hfq`` request falls
  through rather than being served the wrong price caliber;
* when the gateway is not answering, A-shares drop to Sina's
  ``ak.stock_zh_a_minute`` (the pre-Futu path, and still the reason Eastmoney's
  push2 hosts are avoided -- they are unreachable from this machine's proxy, see
  agent/src/skills/akshare/references/intraday-bars.md). A non-A-share with no
  answering gateway is told which of those two cases it is.

The routing lives in ``_kline_sync``; ``_futu_minute_bars`` returns ``None`` to
mean "fall through", never "error".

Error surface: bad/unsupported params → 400 ``{"status":"error","error":...}``;
an upstream data failure → 502 with the same envelope. All network I/O runs
in ``asyncio.to_thread`` to keep the event loop free.
"""

from __future__ import annotations

import asyncio
import logging
import threading
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable
from zoneinfo import ZoneInfo

import pandas as pd
from fastapi import Depends, FastAPI, Query
from fastapi.responses import JSONResponse, Response

logger = logging.getLogger(__name__)

AuthDep = Callable[..., Awaitable[Any] | Any]

_MAX_BARS = 2000
_MAX_QUOTE_SYMBOLS = 30
_MINUTE_PERIODS = {"1m": "1", "5m": "5", "15m": "15", "30m": "30", "60m": "60"}
_ADJUSTS = {"none": "", "qfq": "qfq", "hfq": "hfq"}

#: Weekly / monthly bars, and how many daily ones a single merged bar can eat
#: (local custom ㉜). They are *built* from the daily chain instead of being
#: asked of a source by name — see :func:`_fetch_calendar_bars` for why.
#: The bound is **calendar days per group**, not trading days: a week holds at
#: most 7 daily bars and a month at most 31, and crypto tapes really have one
#: bar every day. Measured live 2026-09-10 with the trading-day figures (6/24):
#: `BTC-USDT interval=1W count=200` answered 176 bars, so the page came up short
#: and the chart's `more.forward` went false while four more years of daily bars
#: were still sitting in the chain — a wrong unit reads as "history ran out".
#: 8 and 32 are those maxima plus a day, which makes the sizing provable instead
#: of empirical: no market's calendar can overflow it.
_AGG_DAILY_PER_BAR = {"1W": 8, "1M": 32}
#: Extra daily bars on top of `count * per_bar`, so the request still answers
#: `count` merged bars after the half-group at the window's left edge is dropped
#: (that drop costs at most 31 daily bars, which is what this pays for).
_AGG_DAILY_MARGIN = 30
#: Ceiling on the daily walk-in behind one coarse request. The route caps
#: `count` at 2000, and 2000 monthly bars would otherwise ask for 64000 daily
#: ones — which makes `_fetch_daily`'s calendar buffer reach into 1803, a range
#: the public endpoints answer with an error rather than with nothing. 16500 sits
#: one page above what the chart itself ever sends (500 * 32 + 30 = 16030), so
#: the ceiling only bites a hand-made request: ~540 months (~45 years) of daily
#: bars, which is more history than the sources behind this page hold.
_AGG_DAILY_CAP = 16500

#: This endpoint's minute spellings -> the interval token ``FutuLoader`` accepts.
#: The loader's own table keys 60-minute bars as ``1H``, *not* ``60m``, so
#: passing ``interval`` straight through would fail its lookup and every 60m
#: request would fall through to Sina -- the one interval the Futu tape serves
#: best would quietly become the one nobody ever gets.
_FUTU_MINUTE_INTERVAL = {"1m": "1m", "5m": "5m", "15m": "15m", "30m": "30m", "60m": "1H"}

#: Market suffixes the gateway lists, mirroring ``backtest.loaders.futu
#: ._SERVED_PREFIXES``. A cheap pre-filter so a crypto or LSE code never opens
#: a socket to a desktop app that cannot know it.
_FUTU_MINUTE_SUFFIXES = {"SH", "SZ", "HK", "US"}

#: Bars per trading day, sized by the widest session (US regular hours is 390
#: one-minute bars), used only to pick how far back to ask.
_MINUTE_BARS_PER_DAY = {"1m": 390, "5m": 78, "15m": 26, "30m": 13, "60m": 7}

#: How far back minute bars are requested at all. A retail OpenD login is
#: entitled to roughly a week of intraday history; asking for a month buys no
#: extra bars, it just risks the whole call.
_MINUTE_WINDOW_CAP_DAYS = 12

# akshare decrypts Sina responses through py_mini_racer, whose bundled Chromium
# hard-crashes the whole process when first used off the main thread on Windows
# (V8 partition_address_space FATAL, seen 2026-09-04). All Sina/akshare calls
# are therefore funnelled onto ONE dedicated, reused worker thread; serialising
# them on that thread also keeps the non-thread-safe loader chain quiet.
_sina_lock = threading.Lock()
_sina_thread: threading.Thread | None = None


def _run_sina(fn, *args, **kwargs):
    """Run ``fn`` on a single reused worker thread, serialised by a lock."""
    global _sina_thread
    with _sina_lock:
        box: dict[str, Any] = {}

        def _work() -> None:
            try:
                box["value"] = fn(*args, **kwargs)
            except BaseException as exc:  # re-raise on the caller side
                box["error"] = exc

        _sina_thread = threading.Thread(target=_work, daemon=True)
        _sina_thread.start()
        _sina_thread.join()
        if "error" in box:
            raise box["error"]
        return box.get("value")


#: Which wall clock a naive minute timestamp is written in, per market suffix.
#:
#: Every minute source here (FutuOpenD's ``time_key``, Sina's ``day`` column)
#: yields exchange-local clock times with no zone attached. ``pandas`` then
#: reads that naive value as **UTC** when taking ``.timestamp()`` -- unlike
#: ``datetime``, which uses the machine's zone -- so an A-share 14:35 bar lands
#: on the wire as 14:35 UTC and a UTC+8 browser draws it at 22:35. Daily bars
#: never showed this: a trading-day label survives an 8-hour nudge, a clock time
#: does not.
#: ``Asia/Shanghai`` is a flat +8 with no DST, so it serves HKT as exactly as it
#: serves CST. ``America/New_York`` carries the DST rule, which is what keeps a
#: US session honest across the March and November switches.
_MINUTE_WALL_CLOCK_ZONE = {
    "SH": "Asia/Shanghai",
    "SZ": "Asia/Shanghai",
    "HK": "Asia/Shanghai",
    "US": "America/New_York",
}


def _bars_from_frame(
    df: pd.DataFrame, wall_clock_zone: str | None = None
) -> list[dict[str, Any]]:
    """Convert a loader frame (trade_date index or column + OHLCV) to bar dicts.

    Timestamps are epoch **milliseconds** (naive, tz-stripped) because that is
    the unit KLineChart v10 expects on the wire; keeping one unit end-to-end
    avoids the 1970-axis / failed-paging bugs a seconds-vs-ms mismatch causes.

    Pass ``wall_clock_zone`` for intraday bars to say which zone the naive index
    is the wall clock of, so the epoch on the wire is a real instant. Leave it
    ``None`` for daily bars: their timestamp is a trading-day label, and
    localizing a US session's midnight would move that label to the previous
    calendar day.
    """
    frame = df.copy()
    if "trade_date" in frame.columns:
        frame = frame.set_index("trade_date")
    if not isinstance(frame.index, pd.DatetimeIndex):
        frame.index = pd.to_datetime(frame.index)
    required = ("open", "high", "low", "close")
    if any(col not in frame.columns for col in required):
        raise ValueError("loader frame is missing OHLC columns")
    if "volume" not in frame.columns:
        frame["volume"] = 0.0
    frame = frame.sort_index()
    bars: list[dict[str, Any]] = []
    for ts, row in frame.iterrows():
        try:
            close = float(row["close"])
        except (TypeError, ValueError):
            continue
        if pd.isna(close):
            continue
        stamp = pd.Timestamp(ts)
        if wall_clock_zone is None:
            stamp = stamp.tz_localize(None)
        elif stamp.tzinfo is None:
            # An already-aware index has told us its own zone; localizing it
            # again would shift it a second time. ambiguous/nonexistent cover
            # the New York fall-back and spring-forward hours, which regular
            # sessions never trade in but a paging request can still reach.
            stamp = stamp.tz_localize(
                wall_clock_zone, ambiguous=True, nonexistent="shift_forward"
            )
        bars.append(
            {
                "timestamp": int(stamp.timestamp() * 1000),
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": close,
                "volume": float(row["volume"] or 0.0),
            }
        )
    return bars


def _fetch_daily_sina_a_share(
    symbol: str, count: int, before: int | None
) -> list[dict[str, Any]]:
    """A-share daily bars via Sina's ``stock_zh_a_daily`` (qfq), e.g. sh600519.

    Preferred source for A-share daily: fast and, unlike the tencent (HTTP 501
    under load) / eastmoney (proxy-blocked) loaders on the primary chain, it
    stayed reachable through the residential proxy (verified 2026-09-04).
    """
    code, _, suffix = symbol.partition(".")
    if suffix not in {"SH", "SZ"}:
        raise LookupError("sina daily is only available for .SH/.SZ A-shares")
    import akshare as ak

    buffer_days = int(count * 1.7) + 30
    if before:
        end = datetime.fromtimestamp(before / 1000, tz=timezone.utc).date()
    else:
        end = datetime.now(timezone.utc).date()
    start = end - timedelta(days=buffer_days)
    raw = _run_sina(
        ak.stock_zh_a_daily,
        symbol=f"{suffix.lower()}{code}",
        start_date=start.strftime("%Y%m%d"),
        end_date=end.strftime("%Y%m%d"),
        adjust="qfq",
    )
    if raw is None or raw.empty:
        raise LookupError(f"sina returned no daily data for {symbol}")
    frame = raw.copy()
    frame["date"] = pd.to_datetime(frame["date"])
    frame = frame.set_index("date")
    bars = _bars_from_frame(frame)
    if before:
        bars = [b for b in bars if b["timestamp"] < before]
    return bars[-count:]


def _futu_daily_bars(
    symbol: str, count: int, before: int | None
) -> list[dict[str, Any]] | None:
    """Daily bars straight from FutuOpenD, or ``None`` to fall through.

    ``None`` is the whole point: an operator who has not opened the desktop
    gateway must end up on the public chain with the same request, not on an
    error page. The loader's own cooldown keeps a closed desk from being
    re-probed once per chart pan.
    """
    try:
        from backtest.loaders.futu import FutuLoader

        buffer_days = int(count * 1.7) + 30
        if before:
            end = datetime.fromtimestamp(before / 1000, tz=timezone.utc).date()
        else:
            end = datetime.now(timezone.utc).date()
        start = end - timedelta(days=buffer_days)
        loader = FutuLoader()
        if not loader.is_available():
            return None
        frames = loader.fetch(
            codes=[symbol],
            start_date=start.isoformat(),
            end_date=(end + timedelta(days=1)).isoformat(),
            interval="1D",
        )
        frame = frames.get(symbol)
        if frame is None or frame.empty:
            return None
        bars = _bars_from_frame(frame)
    except Exception as exc:  # noqa: BLE001 — gateway absence is normal, not an error
        logger.debug("futu daily bars unavailable for %s: %s", symbol, exc)
        return None
    if before:
        bars = [b for b in bars if b["timestamp"] < before]
    return bars[-count:] or None


def _futu_minute_bars(
    symbol: str, interval: str, count: int, adjust: str, before: int | None
) -> list[dict[str, Any]] | None:
    """Minute bars straight from FutuOpenD, or ``None`` to fall through.

    ``None`` and not an error, in three situations -- and the third is the one
    worth reading twice:

    * the gateway is not answering, so an operator who never opens the desktop
      app keeps exactly what they had before (Sina A-share minutes);
    * the symbol is outside the four markets Futu lists;
    * ``adjust`` is not ``qfq``. ``FutuLoader`` pins ``autype="qfq"``, so
      serving a ``none``/``hfq`` request from it would return a **different
      price caliber than the caller asked for** with nothing on the wire to say
      so -- the exact failure ``PRICE_CALIBER_BY_SOURCE`` exists to make
      impossible. Falling through keeps the caliber honest instead.
    """
    if adjust != "qfq":
        return None
    futu_interval = _FUTU_MINUTE_INTERVAL.get(interval)
    if futu_interval is None or symbol.rsplit(".", 1)[-1] not in _FUTU_MINUTE_SUFFIXES:
        return None
    try:
        from backtest.loaders.futu import FutuLoader

        # Ceiling-division of bars into days, then x2 for the trading-day to
        # calendar-day gap, capped because the entitlement does not reach far.
        per_day = _MINUTE_BARS_PER_DAY[interval]
        span_days = min(-(-count // per_day) * 2 + 2, _MINUTE_WINDOW_CAP_DAYS)
        if before:
            end = datetime.fromtimestamp(before / 1000, tz=timezone.utc).date()
        else:
            end = datetime.now(timezone.utc).date()
        start = end - timedelta(days=span_days)
        loader = FutuLoader()
        if not loader.is_available():
            return None
        frames = loader.fetch(
            codes=[symbol],
            start_date=start.isoformat(),
            end_date=(end + timedelta(days=1)).isoformat(),
            interval=futu_interval,
        )
        frame = frames.get(symbol)
        if frame is None or frame.empty:
            return None
        # ``time_key`` is the exchange's own wall clock, naive; see the table.
        suffix = symbol.rsplit(".", 1)[-1]
        bars = _bars_from_frame(frame, _MINUTE_WALL_CLOCK_ZONE[suffix])
    except Exception as exc:  # noqa: BLE001 — gateway absence is normal, not an error
        logger.debug("futu minute bars unavailable for %s/%s: %s", symbol, interval, exc)
        return None
    if before:
        bars = [b for b in bars if b["timestamp"] < before]
    return bars[-count:] or None


def _minute_no_source_reason(symbol: str, adjust: str) -> str:
    """Why a non-A-share got no minute bars, stated as the actual cause.

    The old text claimed minutes were "only supported for .SH/.SZ", which after
    this routing is true only of the *public fallback*. Left standing there it
    would tell a user with a sleeping OpenD window that their symbol is
    unsupported, and they would never go check the one thing that fixes it.
    """
    if adjust != "qfq":
        return (
            f"minute bars for {symbol} are served by FutuOpenD, which only offers "
            f"the forward-adjusted (qfq) caliber; adjust={adjust!r} has no source here"
        )
    if symbol.rsplit(".", 1)[-1] not in _FUTU_MINUTE_SUFFIXES:
        # Never sent to the gateway at all. Telling this user to go start OpenD
        # would send them fixing something that was never the problem.
        return (
            f"no source here serves minute bars for {symbol}: FutuOpenD covers "
            f"{'/'.join(sorted(_FUTU_MINUTE_SUFFIXES))}-suffixed equities and the "
            f"public fall-back is an A-share API"
        )
    return (
        f"minute bars for {symbol} have only one source, FutuOpenD, and it did not "
        f"answer -- check that OpenD is running and logged in"
    )


def _live_quote_row(symbol: str, row: dict[str, Any] | None) -> dict[str, Any] | None:
    """Shape one Futu snapshot row into this endpoint's quote contract.

    Returns ``None`` when the row is empty or carries an unparseable
    ``update_time``: a quote published with a fabricated timestamp would be
    worse than no quote, because the chart and the alert rules both sort on it.
    """
    if not row or row.get("last") is None:
        return None
    stamp = row.get("update_time") or ""
    try:
        timestamp = int(pd.Timestamp(stamp).tz_localize(None).timestamp() * 1000)
    except (TypeError, ValueError):
        logger.debug("futu quote for %s has an unparseable update_time %r", symbol, stamp)
        return None
    return {
        "symbol": symbol,
        "ok": True,
        "last": round(float(row["last"]), 4),
        "change_pct": round(float(row.get("change_pct") or 0.0), 2),
        "timestamp": timestamp,
        "realtime": True,
        "source": "futu",
    }


def _futu_live_quote(symbol: str) -> dict[str, Any] | None:
    """Realtime quote row from the FutuOpenD snapshot, or ``None``.

    The daily-bar path this replaces reports the last *settled* close; during a
    live session that is yesterday's number. Single-symbol on purpose: it is the
    per-rule shape the alert poller needs, while watchlists go through
    :func:`_quote_batch` so the whole page costs one gateway call.
    """
    try:
        from backtest.loaders.futu import realtime_quotes

        rows = realtime_quotes([symbol])
    except Exception as exc:  # noqa: BLE001 — absence of a gateway is not an error
        logger.debug("futu live quote unavailable for %s: %s", symbol, exc)
        return None
    return _live_quote_row(symbol, rows.get(symbol))


def _fetch_daily(symbol: str, count: int, before: int | None) -> tuple[list[dict[str, Any]], str]:
    """Walk the market's loader fallback chain for up to ``count`` daily bars.

    Returns ``(bars, source)`` so callers can label which path actually served
    the data. ``before`` (epoch **milliseconds**) caps the window to
    older-than that timestamp so KLineChart can page backwards on scroll;
    ``None`` returns the latest bars.
    """
    from backtest.correlation import _fetch_price_series, infer_market

    market = infer_market(symbol)
    # A-share daily: FutuOpenD first when the operator's gateway is answering.
    # It is an own-account source with a realtime tape and, unlike the public
    # endpoints below, is not subject to this machine's proxy; when it is down
    # (or in cooldown) the Sina preference documented in
    # _fetch_daily_sina_a_share takes over unchanged.
    if symbol.rsplit(".", 1)[-1] in {"SH", "SZ"}:
        futu_bars = _futu_daily_bars(symbol, count, before)
        if futu_bars is not None:
            return futu_bars, "futu:opend"
        try:
            return (
                _fetch_daily_sina_a_share(symbol, count, before),
                "akshare:sina_stock_zh_a_daily",
            )
        except LookupError:
            pass
    # Calendar buffer: trading days ≈ 0.68 calendar days; holidays stack up.
    buffer_days = int(count * 1.7) + 30
    if before:
        end = datetime.fromtimestamp(before / 1000, tz=timezone.utc).date()
    else:
        end = datetime.now(timezone.utc).date()
    start = end - timedelta(days=buffer_days)
    frames = _fetch_price_series(
        [symbol], start.isoformat(), (end + timedelta(days=1)).isoformat()
    )
    if symbol not in frames or frames[symbol].empty:
        raise LookupError(f"no loader in the {market} chain returned data for {symbol}")
    bars = _bars_from_frame(frames[symbol])
    if before:
        bars = [b for b in bars if b["timestamp"] < before]
    return bars[-count:], "backtest:loader_fallback_chain"


def _calendar_group_key(ts_ms: int, unit: str) -> tuple[int, int]:
    """Which natural week / month one daily bar belongs to.

    Daily bars arrive stamped with the epoch of **midnight UTC of their
    trading-day label** (`_bars_from_frame` leaves ``wall_clock_zone`` as
    ``None`` precisely so that a US session's date does not walk back a day), so
    the calendar date is read straight off the number with no zone table — and
    it stays the same however far from Greenwich the server sits. Grouping on
    the *viewer's* calendar instead is what splits a US week in half, the same
    failure `timeShare.ts` records for the 分时 cut.

    ISO week numbering rather than ``strftime("%W")``: the trading week that
    straddles New Year (Mon 29 Dec – Fri 2 Jan) is one bar on every broker's
    chart, and an (iso-year, iso-week) pair keeps it that way across the year
    boundary, where a bare week number would collide with week 1 of next year.
    """
    day = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
    if unit == "week":
        iso = day.isocalendar()
        return (int(iso[0]), int(iso[1]))
    return (day.year, day.month)


def _merge_to_calendar(bars: list[dict[str, Any]], unit: str) -> list[dict[str, Any]]:
    """Collapse ascending daily bars into natural-week / natural-month bars.

    OHLC follows what every broker does: open from the group's first day, close
    from its last, the high/low across the whole group, volume summed. The
    merged bar keeps the **first** day's timestamp, which is what makes paging
    exact — `before` is then always a group boundary, so a page can never split
    one week into two stubs (see :func:`_fetch_calendar_bars`).
    """
    merged: list[dict[str, Any]] = []
    group: tuple[int, int] | None = None
    for bar in sorted(bars, key=lambda b: int(b["timestamp"])):
        key = _calendar_group_key(int(bar["timestamp"]), unit)
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


def _fetch_calendar_bars(
    symbol: str, interval: str, count: int, before: int | None
) -> tuple[list[dict[str, Any]], str]:
    """Weekly / monthly bars for one symbol, merged out of the daily chain.

    Not asking the source for weekly bars is a decision with three reasons:

    * **coverage** — anything this page can draw daily can draw weekly and
      monthly, with no second routing table of per-source spellings (akshare
      says ``weekly``, Futu says ``K_WEEK``, the Yahoo chain has no weekly at
      all and would fall through to a different market's loader);
    * **one price caliber** — the daily answer already settled the 复权 question,
      while a source's own weekly series is computed on its own adjusted base,
      so the toolbar's 前复权 selector would silently mean two different things
      on two buttons;
    * **paging** — a merged bar is timestamped by its first day, so the
      `before` cursor is a group boundary and the daily contract in
      :func:`_fetch_daily` needs no coarse variant.

    The daily walk is sized to actually fill the request; ``count`` itself is
    capped by the route, and :data:`_AGG_DAILY_CAP` keeps that bounded.
    """
    dailies = min(
        count * _AGG_DAILY_PER_BAR[interval] + _AGG_DAILY_MARGIN, _AGG_DAILY_CAP
    )
    bars, source = _fetch_daily(symbol, dailies, before)
    merged = _merge_to_calendar(bars, "week" if interval == "1W" else "month")
    if len(bars) >= dailies and len(merged) > 1:
        # The window came back full, so its left edge landed somewhere inside a
        # group whose earlier days are outside the fetch. Keeping that stub would
        # draw a week nobody draws on the source's own chart, and it costs
        # nothing to drop: the next page is asked with before = the oldest merged
        # timestamp, which lands those days at that page's newest end, complete.
        #
        # With :data:`_AGG_DAILY_PER_BAR` at calendar maxima a full window always
        # merges more groups than `count`, so the tail trim below already discards
        # the stub and this line is a no-op — it earns its place on the case where
        # it is not: a page short enough to still hold the stub would otherwise
        # strand that group's earlier days between the two pages. Pinned by
        # ``test_the_guard_still_fires_when_the_page_itself_is_short``, which
        # reaches it by lowering the table.
        merged = merged[1:]
    # Label the merge on the source the chart shows in its status line: these
    # bars did not come from a source that speaks "weekly", and "this is daily
    # data, folded" is information rather than noise.
    return merged[-count:], f"{source}+{interval}"


def _fetch_minute_a_share(
    symbol: str, period: str, count: int, adjust: str, before: int | None
) -> list[dict[str, Any]]:
    """A-share minute bars via Sina (``stock_zh_a_minute``), e.g. sh600519."""
    code, _, suffix = symbol.partition(".")
    if suffix not in {"SH", "SZ"}:
        raise ValueError(f"sina minute bars have no path for {symbol} (A-share suffix required)")
    import akshare as ak

    raw = _run_sina(
        ak.stock_zh_a_minute,
        symbol=f"{suffix.lower()}{code}",
        period=period,
        adjust=_ADJUSTS[adjust],
    )
    if raw is None or raw.empty:
        raise LookupError(f"sina returned no minute data for {symbol}")
    frame = raw.copy()
    frame["day"] = pd.to_datetime(frame["day"])
    frame = frame.set_index("day")
    for col in ("open", "high", "low", "close", "volume"):
        frame[col] = pd.to_numeric(frame[col], errors="coerce")
    # Sina's ``day`` column is Beijing wall clock, which is also what the
    # suffix table says for SH/SZ.
    bars = _bars_from_frame(frame, _MINUTE_WALL_CLOCK_ZONE[suffix])
    if before:
        bars = [b for b in bars if b["timestamp"] < before]
    return bars[-count:]


def _split_latest_session(
    bars: list[dict[str, Any]], zone: str
) -> tuple[list[dict[str, Any]], str, float | None]:
    """Keep the most recent trading session only, plus what preceded it.

    ``bars`` ascend in epoch milliseconds, every one of them stamped against
    ``zone`` by the minute path that produced it (see
    :data:`_MINUTE_WALL_CLOCK_ZONE`). Grouping on that same zone is therefore
    exact -- and it is *why* this runs here rather than in the browser: taking a
    plain ``date`` of the epoch splits a US session in half for any viewer east
    of Greenwich, and teaching the chart the exchange calendar would put a
    second copy of that zone table in the codebase to drift.

    Returns ``(session_bars, session_date, prev_close)``. ``prev_close`` is the
    last bar of the session before it, or ``None`` when the window only ever
    held one session. The 分时 view needs that number to draw 涨跌幅, and
    defaulting it to the day's first bar would report every session as opening
    flat -- which is exactly the kind of wrong-but-quiet answer this route
    refuses to give.
    """
    if not bars:
        return [], "", None
    dates = [
        datetime.fromtimestamp(bar["timestamp"] / 1000, tz=ZoneInfo(zone)).date()
        for bar in bars
    ]
    last = dates[-1]
    start = len(bars)
    while start > 0 and dates[start - 1] == last:
        start -= 1
    prev_close = float(bars[start - 1]["close"]) if start > 0 else None
    return bars[start:], last.isoformat(), prev_close


def _kline_sync(
    symbol: str, interval: str, count: int, adjust: str, before: int | None = None,
    session: str = "",
) -> dict[str, Any]:
    if session not in {"", "latest"}:
        raise ValueError(f"unsupported session {session!r} (only 'latest' is defined)")
    bars: list[dict[str, Any]]
    if interval in _MINUTE_PERIODS:
        bars = _futu_minute_bars(symbol, interval, count, adjust, before)
        source = "futu:opend"
        if bars is None:
            # Fall through to the public path, which reaches A-shares only.
            # Everything else has no source left and is told so *by cause*.
            if symbol.rsplit(".", 1)[-1] not in {"SH", "SZ"}:
                raise ValueError(_minute_no_source_reason(symbol, adjust))
            bars = _fetch_minute_a_share(symbol, _MINUTE_PERIODS[interval], count, adjust, before)
            source = "akshare:sina_stock_zh_a_minute"
    elif interval in _AGG_DAILY_PER_BAR:
        if session == "latest":
            raise ValueError(
                "session=latest narrows one trading day out of minute bars; "
                f"{interval} bars are merged from daily ones, which are one day each already"
            )
        bars, source = _fetch_calendar_bars(symbol, interval, count, before)
    else:
        if session == "latest":
            raise ValueError(
                "session=latest narrows one trading day out of minute bars; "
                "daily bars already are one day each"
            )
        bars, source = _fetch_daily(symbol, count, before)
    payload: dict[str, Any] = {
        "status": "ok",
        "symbol": symbol,
        "interval": interval,
        "source": source,
        "bars": bars,
    }
    if session == "latest":
        suffix = symbol.rsplit(".", 1)[-1]
        zone = _MINUTE_WALL_CLOCK_ZONE.get(suffix)
        if zone is None:
            # Reached only by a suffix that has a minute path but no clock
            # table entry; a 502 from a KeyError would send the user hunting
            # the gateway instead of the routing.
            raise ValueError(f"session=latest cannot place {symbol}'s bars on a trading day")
        bars, session_date, prev_close = _split_latest_session(bars, zone)
        payload["bars"] = bars
        payload["session_date"] = session_date
        payload["prev_close"] = prev_close
    return payload


def _quote_one(symbol: str) -> dict[str, Any]:
    """Latest price for one symbol: FutuOpenD tape first, daily bars fallback.

    Errors are returned in-row (``ok: false``) so one bad symbol never sinks
    a whole watchlist batch.
    """
    s = symbol.strip().upper()
    live = _futu_live_quote(s)
    if live is not None:
        return live
    try:
        # Same canonical form the /market/kline route accepts (e.g. 600519.SH,
        # AAPL.US, BTC-USDT) — the loader chain normalizes internally.
        bars, _src = _fetch_daily(s, count=2, before=None)
    except Exception as exc:  # noqa: BLE001 — per-row containment is the point
        return {"symbol": s, "ok": False, "error": str(exc)[:200]}
    if not bars:
        return {"symbol": s, "ok": False, "error": "no data"}
    last = float(bars[-1]["close"])
    prev = float(bars[-2]["close"]) if len(bars) > 1 else last
    change_pct = ((last - prev) / prev * 100.0) if prev else 0.0
    return {
        "symbol": s,
        "ok": True,
        "last": round(last, 4),
        "change_pct": round(change_pct, 2),
        "timestamp": int(bars[-1]["timestamp"]),
    }


def _quote_batch(items: list[str]) -> list[dict[str, Any]]:
    """Quote a watchlist: one batched FutuOpenD snapshot, then per-symbol gaps.

    Batching is not an optimization here — calling :func:`_quote_one` per symbol
    would open and close a gateway connection for every row of one refresh, and
    with the snapshot pacing applied that turns a 30-symbol watchlist into a
    15-second request. One call covers every Futu-served symbol at once; only
    the rows it could not fill (crypto, LSE, a closed gateway) fall through to
    the daily-bar path, which is sequential because the shared loader chain is
    not thread-safe (concurrent walks returned data only for the first symbol,
    verified 2026-09-04).
    """
    live: dict[str, dict[str, Any]] = {}
    try:
        from backtest.loaders.futu import realtime_quotes

        rows = realtime_quotes(items)
    except Exception as exc:  # noqa: BLE001 — a missing gateway is not an error
        logger.debug("futu batch quote unavailable: %s", exc)
        rows = {}
    for symbol, row in rows.items():
        shaped = _live_quote_row(symbol, row)
        if shaped is not None:
            live[symbol] = shaped
    return [live.get(s) or _quote_one(s) for s in items]


def register_market_routes(app: FastAPI, require_auth: AuthDep | None = None) -> None:
    """Mount the market-data routes onto ``app`` (options_routes pattern)."""
    if require_auth is None:
        import sys as _sys

        host = _sys.modules.get("api_server") or _sys.modules.get("agent.api_server")
        if host is None:  # pragma: no cover — only triggers on weird import setups
            raise RuntimeError(
                "register_market_routes: api_server module not in sys.modules; "
                "pass require_auth explicitly"
            )
        require_auth = host.require_auth

    @app.get("/market/kline", dependencies=[Depends(require_auth)])
    async def market_kline(
        symbol: str = Query(..., min_length=1, max_length=32, description="e.g. 600519.SH / AAPL / BTC-USDT"),
        interval: str = Query("1D", description="1m/5m/15m/30m/60m, 1D, or 1W/1M (merged from daily bars)"),
        count: int = Query(500, ge=10, le=_MAX_BARS),
        adjust: str = Query("qfq", description="none/qfq/hfq — minute bars only"),
        before: int | None = Query(None, ge=0, description="epoch milliseconds — load bars strictly older than this (scroll-back paging)"),
        session: str = Query("", description="'latest' — return only the newest trading session of a minute interval, plus prev_close (the 分时 view)"),
    ) -> Response:
        """OHLCV bars for the pro-chart page; envelope mirrors the other routes."""
        key = symbol.strip().upper()
        if interval not in _MINUTE_PERIODS and interval not in _AGG_DAILY_PER_BAR and interval != "1D":
            return JSONResponse(
                status_code=400,
                content={
                    "status": "error",
                    "error": f"unsupported interval {interval!r} "
                    f"(known: {'/'.join(_MINUTE_PERIODS)}/1D/{'/'.join(_AGG_DAILY_PER_BAR)})",
                },
            )
        if adjust not in _ADJUSTS:
            return JSONResponse(
                status_code=400, content={"status": "error", "error": f"unsupported adjust {adjust!r}"}
            )
        try:
            # Loader/akshare calls are blocking — keep the event loop free.
            return await asyncio.to_thread(_kline_sync, key, interval, count, adjust, before, session)
        except ValueError as exc:
            return JSONResponse(status_code=400, content={"status": "error", "error": str(exc)})
        except LookupError as exc:
            return JSONResponse(status_code=404, content={"status": "error", "error": str(exc)})
        except Exception:  # noqa: BLE001 — never leak a stack frame to clients
            logger.exception("market kline fetch failed (symbol=%s interval=%s)", key, interval)
            return JSONResponse(
                status_code=502, content={"status": "error", "error": "kline fetch failed"}
            )

    @app.get("/market/quote", dependencies=[Depends(require_auth)])
    async def market_quote(
        symbols: str = Query(..., min_length=1, description="Comma-separated symbols (<= 30)"),
    ) -> Response:
        """Batch watchlist quotes: last price + day-over-day change per symbol.

        Futu-served symbols come off the FutuOpenD tape in one snapshot call
        (``realtime: true`` on those rows); everything else — and everything
        when the gateway is not running — falls back to two bars per symbol
        through the daily loader chain, sequentially, because the chain is not
        thread-safe. Per-symbol failures show up in-row (``ok: false``) instead
        of failing the request.
        """
        items = [s.strip().upper() for s in symbols.split(",") if s.strip()][
            : _MAX_QUOTE_SYMBOLS
        ]
        if not items:
            return JSONResponse(
                status_code=400, content={"status": "error", "error": "no symbols provided"}
            )
        try:
            # Loader calls are blocking — keep the event loop free.
            quotes = await asyncio.to_thread(_quote_batch, items)
        except Exception:  # noqa: BLE001 — defensive; per-row errors are contained
            logger.exception("market quote batch failed (%d symbols)", len(items))
            return JSONResponse(
                status_code=502, content={"status": "error", "error": "quote fetch failed"}
            )
        return {"status": "ok", "quotes": quotes}

    @app.get("/market/symbols", dependencies=[Depends(require_auth)])
    async def market_symbols(
        q: str = Query(
            "",
            max_length=32,
            description="Code prefix (600), symbol (600519.SH), ticker (aapl) or Chinese name (茅台)",
        ),
        limit: int = Query(10, ge=1, le=50),
        refresh: bool = Query(False, description="Force a background roster rebuild"),
    ) -> Response:
        """Type-ahead candidates for a symbol box, answered from the local roster.

        Never builds the roster inline: a cold build costs 17-20 s of gateway
        round-trips, so an empty index answers immediately with
        ``status: "warming"`` while the work happens on a daemon thread. The
        client keeps this usable as a plain text input either way — see
        :mod:`src.symbol_roster` for why the remote suggest endpoints are not
        the fallback here.
        """
        from src import symbol_roster

        rows, stale = await asyncio.to_thread(symbol_roster.peek_roster)
        if not rows or stale or refresh:
            started = await asyncio.to_thread(symbol_roster.start_warmup, force=refresh)
            if not rows:
                return {
                    "status": "warming",
                    "ready": False,
                    "results": [],
                    "count": 0,
                    "building": started or symbol_roster.is_building(),
                }

        results = await asyncio.to_thread(symbol_roster.search, q, limit=limit, load=False)
        return {"status": "ok", "ready": True, "results": results, "count": len(results)}
