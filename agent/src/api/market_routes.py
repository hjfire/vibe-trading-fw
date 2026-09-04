"""Market K-line HTTP routes for the Web pro-chart page.

Mounted by ``agent/api_server.py`` via ``register_market_routes(app)``.

Routes (auth via the caller-supplied ``require_auth`` dependency):

- ``GET /market/kline``  — single-instrument OHLCV bars for interactive charts.
- ``GET /market/quote``  — batch last-price + change-pct quotes for the watchlist.

Daily bars walk the same loader fallback chain ``/correlation`` uses
(``backtest.correlation._fetch_price_series``), so any instrument the
backtest layer can serve is chartable without new data plumbing.

Minute bars (1m/5m/15m/30m/60m) cover A-shares only, via Sina's
``ak.stock_zh_a_minute``: registered a-share loaders reject non-daily
intervals by design, and the Eastmoney push2 hosts that back the other
minute APIs are frequently unreachable from residential proxies
(verified 2026-09-04 — see agent/src/skills/akshare/references/intraday-bars.md).

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

import pandas as pd
from fastapi import Depends, FastAPI, Query
from fastapi.responses import JSONResponse, Response

logger = logging.getLogger(__name__)

AuthDep = Callable[..., Awaitable[Any] | Any]

_MAX_BARS = 2000
_MAX_QUOTE_SYMBOLS = 30
_MINUTE_PERIODS = {"1m": "1", "5m": "5", "15m": "15", "30m": "30", "60m": "60"}
_ADJUSTS = {"none": "", "qfq": "qfq", "hfq": "hfq"}

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


def _bars_from_frame(df: pd.DataFrame) -> list[dict[str, Any]]:
    """Convert a loader frame (trade_date index or column + OHLCV) to bar dicts.

    Timestamps are epoch **milliseconds** (naive, tz-stripped) because that is
    the unit KLineChart v10 expects on the wire; keeping one unit end-to-end
    avoids the 1970-axis / failed-paging bugs a seconds-vs-ms mismatch causes.
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
        bars.append(
            {
                "timestamp": int(pd.Timestamp(ts).tz_localize(None).timestamp() * 1000),
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


def _fetch_daily(symbol: str, count: int, before: int | None) -> tuple[list[dict[str, Any]], str]:
    """Walk the market's loader fallback chain for up to ``count`` daily bars.

    Returns ``(bars, source)`` so callers can label which path actually served
    the data. ``before`` (epoch **milliseconds**) caps the window to
    older-than that timestamp so KLineChart can page backwards on scroll;
    ``None`` returns the latest bars.
    """
    from backtest.correlation import _fetch_price_series, infer_market

    market = infer_market(symbol)
    # A-share daily: prefer Sina, then fall through to the loader chain if it
    # ever comes back dry (see _fetch_daily_sina_a_share for the rationale).
    if symbol.rsplit(".", 1)[-1] in {"SH", "SZ"}:
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


def _fetch_minute_a_share(
    symbol: str, period: str, count: int, adjust: str, before: int | None
) -> list[dict[str, Any]]:
    """A-share minute bars via Sina (``stock_zh_a_minute``), e.g. sh600519."""
    code, _, suffix = symbol.partition(".")
    if suffix not in {"SH", "SZ"}:
        raise ValueError("minute bars are only supported for .SH/.SZ A-share symbols")
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
    bars = _bars_from_frame(frame)
    if before:
        bars = [b for b in bars if b["timestamp"] < before]
    return bars[-count:]


def _kline_sync(
    symbol: str, interval: str, count: int, adjust: str, before: int | None = None
) -> dict[str, Any]:
    if interval in _MINUTE_PERIODS:
        bars = _fetch_minute_a_share(symbol, _MINUTE_PERIODS[interval], count, adjust, before)
        source = "akshare:sina_stock_zh_a_minute"
    else:
        bars, source = _fetch_daily(symbol, count, before)
    return {"status": "ok", "symbol": symbol, "interval": interval, "source": source, "bars": bars}


def _quote_one(symbol: str) -> dict[str, Any]:
    """Latest daily bar + previous close -> a compact quote row (any market).

    Errors are returned in-row (``ok: false``) so one bad symbol never sinks
    a whole watchlist batch.
    """
    s = symbol.strip().upper()
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
    # Sequential on purpose: the loader fallback chain (shared akshare/yfinance
    # sessions and caches) is not thread-safe — concurrent walks returned data
    # only for the first symbol (verified 2026-09-04).
    return [_quote_one(s) for s in items]


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
        interval: str = Query("1D", description="1m/5m/15m/30m/60m (A-share only) or 1D"),
        count: int = Query(500, ge=10, le=_MAX_BARS),
        adjust: str = Query("qfq", description="none/qfq/hfq — minute bars only"),
        before: int | None = Query(None, ge=0, description="epoch milliseconds — load bars strictly older than this (scroll-back paging)"),
    ) -> Response:
        """OHLCV bars for the pro-chart page; envelope mirrors the other routes."""
        key = symbol.strip().upper()
        if interval not in _MINUTE_PERIODS and interval != "1D":
            return JSONResponse(
                status_code=400,
                content={"status": "error", "error": f"unsupported interval {interval!r}"},
            )
        if adjust not in _ADJUSTS:
            return JSONResponse(
                status_code=400, content={"status": "error", "error": f"unsupported adjust {adjust!r}"}
            )
        try:
            # Loader/akshare calls are blocking — keep the event loop free.
            return await asyncio.to_thread(_kline_sync, key, interval, count, adjust, before)
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

        Goes through the same daily loader chain as ``/market/kline``, two bars
        per symbol, fetched sequentially (the chain is not thread-safe).
        Per-symbol failures show up in-row (``ok: false``) instead of failing
        the request.
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
