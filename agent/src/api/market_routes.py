"""Market K-line HTTP routes for the Web pro-chart page.

Mounted by ``agent/api_server.py`` via ``register_market_routes(app)``.

Routes (auth via the caller-supplied ``require_auth`` dependency):

- ``GET /market/kline`` — single-instrument OHLCV bars for interactive charts.

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
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

import pandas as pd
from fastapi import Depends, FastAPI, Query
from fastapi.responses import JSONResponse, Response

logger = logging.getLogger(__name__)

AuthDep = Callable[..., Awaitable[Any] | Any]

_MAX_BARS = 2000
_MINUTE_PERIODS = {"1m": "1", "5m": "5", "15m": "15", "30m": "30", "60m": "60"}
_ADJUSTS = {"none": "", "qfq": "qfq", "hfq": "hfq"}


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


def _fetch_daily(symbol: str, count: int, before: int | None) -> list[dict[str, Any]]:
    """Walk the market's loader fallback chain for up to ``count`` daily bars.

    ``before`` (epoch **milliseconds**) caps the window to older-than that
    timestamp so KLineChart can page backwards on scroll; ``None`` returns the
    latest bars.
    """
    from backtest.correlation import _fetch_price_series, infer_market

    market = infer_market(symbol)
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
    return bars[-count:]


def _fetch_minute_a_share(
    symbol: str, period: str, count: int, adjust: str, before: int | None
) -> list[dict[str, Any]]:
    """A-share minute bars via Sina (``stock_zh_a_minute``), e.g. sh600519."""
    code, _, suffix = symbol.partition(".")
    if suffix not in {"SH", "SZ"}:
        raise ValueError("minute bars are only supported for .SH/.SZ A-share symbols")
    import akshare as ak

    raw = ak.stock_zh_a_minute(
        symbol=f"{suffix.lower()}{code}", period=period, adjust=_ADJUSTS[adjust]
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
        bars = _fetch_daily(symbol, count, before)
        source = "backtest:loader_fallback_chain"
    return {"status": "ok", "symbol": symbol, "interval": interval, "source": source, "bars": bars}


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
