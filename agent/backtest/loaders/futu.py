"""Futu OpenAPI-backed loader for HK, US and China A-share OHLCV data."""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Optional

import pandas as pd

from backtest.loaders import futu_gateway
from backtest.loaders.base import (
    NoAvailableSourceError,
    loader_cache_get,
    loader_cache_put,
    validate_date_range,
)
from backtest.loaders.registry import register

logger = logging.getLogger(__name__)

_OHLCV_COLUMNS = ["open", "high", "low", "close", "volume"]

#: Price adjustment requested of OpenD. ``qfq`` (forward-adjusted) matches what
#: the rest of the equity chain serves (tencent/eastmoney/akshare/baostock are
#: all qfq), and it is the SDK's own default — stated here because the SDK
#: rejects every other spelling (``front``/``none``/``backward`` all come back
#: as ``autype is front, which is not valid. (None,qfq,hfq)``) and a wrong value
#: would silently drop each symbol through the per-symbol error path.
_AUTYPE = "qfq"

#: OpenD code prefixes this loader can serve. Anything else (crypto pairs,
#: LSE/TSX/SET lines, Yahoo index symbols) is not a Futu instrument and must
#: not be sent to the gateway at all.
_SERVED_PREFIXES = ("HK.", "SH.", "SZ.", "US.")

_INTERVAL_MAP: dict[str, str] = {
    "1m": "K_1M",
    "5m": "K_5M",
    "15m": "K_15M",
    "30m": "K_30M",
    "1D": "K_DAY",
    "1d": "K_DAY",
    "1H": "K_60M",
    "1h": "K_60M",
    "4H": "K_240M",
    "4h": "K_240M",
    "1W": "K_WEEK",
    "1w": "K_WEEK",
    "1M": "K_MON",
}


def _to_futu_symbol(code: str) -> str:
    """Convert project symbol to Futu OpenAPI format.

    Examples:
        700.HK    -> HK.00700
        5.HK      -> HK.00005
        000001.SZ -> SZ.000001
        600519.SH -> SH.600519
        AAPL.US   -> US.AAPL
    """
    upper = code.strip().upper()
    if upper.endswith(".HK"):
        return f"HK.{upper[:-3].zfill(5)}"
    if upper.endswith(".SZ"):
        return f"SZ.{upper[:-3].zfill(6)}"
    if upper.endswith(".SH"):
        return f"SH.{upper[:-3].zfill(6)}"
    # US tickers arrive both as the project's ``AAPL.US`` and bare ``AAPL``
    # (the chart normalizes to the suffixed form, ad-hoc callers do not).
    # Zero-padding is deliberately not applied: US tickers are alphabetic.
    if upper.endswith(".US"):
        return f"US.{upper[:-3]}"
    if upper.isascii() and upper.isalpha() and 1 <= len(upper) <= 5:
        return f"US.{upper}"
    return upper


def _to_futu_ktype(interval: str):
    """Map project interval string to a futu KLType enum value.

    Lazy-imports futu so the module can be imported without futu installed.
    Unsupported intervals fail explicitly so requested bar fidelity is never
    changed silently.
    """
    from futu import KLType  # noqa: PLC0415

    token = interval.strip()
    attr = _INTERVAL_MAP.get(token)
    if attr is None:
        raise NoAvailableSourceError(
            f"unsupported Futu interval: {interval!r}; "
            f"supported intervals: {sorted(_INTERVAL_MAP)}"
        )
    try:
        return getattr(KLType, attr)
    except AttributeError as exc:
        raise NoAvailableSourceError(
            f"installed Futu SDK does not expose KLType.{attr}"
        ) from exc


def _normalize_frame(df: pd.DataFrame) -> pd.DataFrame:
    """Normalise a Futu kline DataFrame to the standard OHLCV schema.

    Args:
        df: Raw DataFrame returned by ``request_history_kline()``.

    Returns:
        DataFrame with columns [open, high, low, close, volume] indexed
        by ``trade_date`` (timezone-naive DatetimeIndex), sorted ascending.
    """
    if df.empty:
        return pd.DataFrame(columns=_OHLCV_COLUMNS)

    result = df.copy()
    result.index = pd.to_datetime(result["time_key"])
    result.index.name = "trade_date"
    result = result[_OHLCV_COLUMNS].copy()
    result = result.apply(pd.to_numeric, errors="coerce")
    result["volume"] = result["volume"].fillna(0.0)
    result = result.dropna(subset=["open", "high", "low", "close"])
    result = result.sort_index()
    return result[~result.index.duplicated(keep="last")]


@register
class FutuLoader:
    """Fetch HK, US and China A-share bars from Futu OpenAPI.

    Requires FutuOpenD running locally (https://www.futunn.com/download/openAPI)
    and the environment variables ``FUTU_HOST`` / ``FUTU_PORT`` to be set.

    ``us_equity`` is served for stocks and ETFs only. Futu exposes no US index
    quotes, so ``^SPX``-style codes never reach this loader — ``infer_market``
    routes them to the ``index`` market, whose chain deliberately excludes
    ``futu``.
    """

    name = "futu"
    markets = {"hk_equity", "a_share", "us_equity"}
    requires_auth = True

    def __init__(self) -> None:
        from src.config.accessor import get_env_config

        cfg = get_env_config().data
        self._host = cfg.futu_host
        self._port = cfg.futu_port

    def is_available(self) -> bool:
        """Return True when FutuOpenD is configured and accepting connections.

        Deliberately a TCP accept check rather than an ``OpenQuoteContext``
        handshake. The chain walk asks once per symbol, and every handshake
        costs a connect, a close and the SDK's background threads — a
        30-symbol backtest used to spend 30 of them to learn what a sub-millisecond
        socket probe already knows. Churned connections against OpenD are also
        exactly the failure mode the gateway cooldown exists to damp.

        A gateway that accepts the socket but refuses the handshake is still
        caught, one level down: :meth:`fetch` latches the cooldown on the connect
        failure and the walk moves on to the next source.
        """
        from src.config.accessor import get_env_config

        cfg = get_env_config().data
        if not cfg.futu_host or not cfg.futu_port:
            return False
        return futu_gateway.probe(cfg.futu_host, cfg.futu_port)

    def fetch(
        self,
        codes: List[str],
        start_date: str,
        end_date: str,
        *,
        interval: str = "1D",
        fields: Optional[List[str]] = None,
    ) -> Dict[str, pd.DataFrame]:
        """Fetch OHLCV history from Futu OpenAPI.

        Args:
            codes: Project symbols such as ``700.HK`` or ``000001.SZ``.
            start_date: Start date in ``YYYY-MM-DD`` format.
            end_date: End date in ``YYYY-MM-DD`` format.
            interval: Backtest interval supported by :data:`_INTERVAL_MAP`.
            fields: Ignored; included for interface compatibility.

        Returns:
            Mapping of input symbol to normalised OHLCV dataframe.

        Raises:
            NoAvailableSourceError: If FutuOpenD connection fails.
        """
        del fields
        if not codes:
            return {}
        validate_date_range(start_date, end_date)
        if interval.strip() not in _INTERVAL_MAP:
            raise NoAvailableSourceError(
                f"unsupported Futu interval: {interval!r}; "
                f"supported intervals: {sorted(_INTERVAL_MAP)}"
            )

        results: Dict[str, pd.DataFrame] = {}

        # Serve cached symbols first; only open a FutuOpenD connection when at
        # least one symbol is uncached, so a fully-cached request needs no
        # running gateway.
        pending: List[str] = []
        for code in codes:
            cached = loader_cache_get(
                source=self.name,
                symbol=code,
                timeframe=interval,
                start_date=start_date,
                end_date=end_date,
                fields=None,
            )
            if cached is not None and not cached.empty:
                results[code] = cached.copy()
            else:
                pending.append(code)

        if not pending:
            return results

        # Resolved here rather than at the top of the method: a request served
        # entirely from the cache must not need futu-api installed at all. It is
        # still resolved before the connect attempt, so an interval the installed
        # SDK cannot express is reported as what it is instead of being dressed
        # up as "cannot connect to FutuOpenD".
        ktype = _to_futu_ktype(interval)

        if futu_gateway.in_cooldown(self._host, self._port):
            # Fail fast rather than eat another connect timeout per symbol; the
            # chain walk treats this as "try the next source".
            raise NoAvailableSourceError(
                f"FutuOpenD at {self._host}:{self._port} is marked unavailable "
                f"({futu_gateway.cooldown_remaining(self._host, self._port):.0f}s of cooldown left)"
            )

        try:
            import futu  # noqa: PLC0415

            ctx = futu_gateway.open_context(self._host, self._port)
        except Exception as exc:
            futu_gateway.note_failure(
                self._host, self._port, reason=f"kline connect: {type(exc).__name__}"
            )
            raise NoAvailableSourceError(
                f"Cannot connect to FutuOpenD at {self._host}:{self._port}: {exc}"
            ) from exc

        served = 0
        try:
            for code in pending:
                futu_code = _to_futu_symbol(code)
                page_key = None
                pages: List[pd.DataFrame] = []
                failed = False
                while True:
                    ret, data, next_page_key = ctx.request_history_kline(
                        futu_code,
                        start=start_date,
                        end=end_date,
                        ktype=ktype,
                        autype=_AUTYPE,
                        max_count=10_000,
                        page_req_key=page_key,
                    )
                    if ret != futu.RET_OK:
                        logger.warning(
                            "Futu returned error for %s: %s", futu_code, data
                        )
                        failed = True
                        break
                    if isinstance(data, pd.DataFrame) and not data.empty:
                        pages.append(data)
                    if not next_page_key:
                        break
                    page_key = next_page_key

                if failed or not pages:
                    continue
                served += 1
                normalized = _normalize_frame(pd.concat(pages, ignore_index=True))
                if normalized.empty:
                    continue
                loader_cache_put(
                    source=self.name,
                    symbol=code,
                    timeframe=interval,
                    start_date=start_date,
                    end_date=end_date,
                    fields=None,
                    frame=normalized,
                )
                results[code] = normalized
            if served:
                # A batch that came back proves the gateway is live again, so an
                # earlier down-latch must not keep suppressing it.
                futu_gateway.note_success(self._host, self._port)
        except Exception as exc:
            # Mid-batch transport failure (dropped socket, OpenD quit): latch it
            # so the remaining symbols of this walk degrade immediately. Bars
            # already fetched are kept — dropping them would turn a partial
            # result into a worse one.
            futu_gateway.note_failure(
                self._host, self._port, reason=f"kline batch: {type(exc).__name__}"
            )
            if not results:
                raise NoAvailableSourceError(
                    f"FutuOpenD fetch failed for {len(pending)} symbol(s) at "
                    f"{self._host}:{self._port}: {exc}"
                ) from exc
            logger.warning("FutuOpenD batch interrupted after %d symbol(s): %s", served, exc)
        finally:
            ctx.close()

        return results


def realtime_quotes(codes: List[str]) -> Dict[str, Dict[str, Any]]:
    """Live snapshot rows for project symbols, keyed by the symbol asked for.

    Unlike :meth:`FutuLoader.fetch` this is *not* historical: it returns the
    current price and the session's open/high/low, so a watchlist or an alert
    rule can act on the tape instead of yesterday's closing bar. Returns ``{}``
    whenever FutuOpenD is not answering (not installed, not running, cooldown
    latched, symbol refused) — callers treat that as "use the daily chain", so
    a closed desk never breaks a quote endpoint.

    Only the fields this project consumes are mapped; the raw snapshot carries
    much more (lot size, stamp-duty fields, short-sell state).
    """
    host, port = futu_gateway.gateway_target()
    if not host or not port:
        return {}

    # Ask only for shapes Futu can actually serve. Without this filter a
    # watchlist holding crypto or an LSE line would send OpenD a batch it
    # rejects wholesale, and the refusal would cost a round trip on every
    # refresh for symbols that can never succeed.
    mapped = {}
    for code in codes:
        futu_code = _to_futu_symbol(code)
        if futu_code.startswith(_SERVED_PREFIXES):
            mapped[futu_code] = code
    if not mapped:
        return {}
    snapshots = futu_gateway.fetch_snapshots(list(mapped))

    out: Dict[str, Dict[str, Any]] = {}
    for futu_code, original in mapped.items():
        row = snapshots.get(futu_code)
        if not row:
            continue
        prev = row.get("prev_close")
        last = row.get("last")
        change_pct = ((last - prev) / prev * 100.0) if prev and last is not None else 0.0
        out[original] = {
            "last": last,
            "prev_close": prev,
            "open": row.get("open"),
            "high": row.get("high"),
            "low": row.get("low"),
            "volume": row.get("volume"),
            "turnover": row.get("turnover"),
            "change_pct": change_pct,
            "update_time": row.get("update_time"),
            "name": row.get("name"),
            "source": "futu",
        }
    return out
