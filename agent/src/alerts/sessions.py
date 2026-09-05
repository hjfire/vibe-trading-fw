"""Session calendar for alert subjects.

Alert rules must not fire against a closed market on stale data, and the
question "is this market open" already has one owner in this repo:
:data:`src.live.runtime.triggers.MARKET_SPECS`, which carries the US equity
session with a maintained holiday list and marks crypto as always open.

That registry has no CN or HK entry, so this module adds exactly those two
sessions and delegates everything else to the existing implementation rather
than re-deriving the US one. The CN/HK entries deliberately carry no holiday
table: a public holiday simply produces no new bar, so an over-eager
evaluation is idempotent (same close, same verdict, cooldown holds), while a
wrong "closed" verdict could skip a genuine open. Weekday + local clock is the
narrow, safe subset of the session question this first version answers.
"""

from __future__ import annotations

from datetime import time
from typing import Mapping, Optional

from src.live.runtime.triggers import (
    _MarketSpec,
    _ms_to_aware_dt,
    market_is_open_at,
)

#: Sessions this module owns. Anything else goes to the runtime registry.
_LOCAL_SPECS: Mapping[str, _MarketSpec] = {
    "cn_equity": _MarketSpec(
        tz="Asia/Shanghai",
        open_time=time(9, 30),
        close_time=time(15, 0),
        weekdays=frozenset({0, 1, 2, 3, 4}),
    ),
    "hk_equity": _MarketSpec(
        tz="Asia/Hong_Kong",
        open_time=time(9, 30),
        close_time=time(16, 0),
        weekdays=frozenset({0, 1, 2, 3, 4}),
    ),
}

#: Suffix / shape -> market identifier. Symbols in this project are already
#: canonical (``600519.SH``, ``0700.HK``, ``AAPL.US``, ``BTC-USDT``).
_SUFFIX_MARKETS = {
    ".SH": "cn_equity",
    ".SS": "cn_equity",
    ".SZ": "cn_equity",
    ".BJ": "cn_equity",
    ".HK": "hk_equity",
    ".US": "us_equity",
}


def subject_market(symbol: str) -> Optional[str]:
    """Infer which market *symbol* trades on.

    Args:
        symbol: A canonical project symbol.

    Returns:
        The market identifier, or ``None`` when the symbol is unqualified
        (the caller then evaluates without a session gate rather than guessing
        that an unknown venue is closed).
    """
    text = str(symbol or "").strip().upper()
    if not text:
        return None
    for suffix, market in _SUFFIX_MARKETS.items():
        if text.endswith(suffix):
            return market
    if any(sep in text for sep in ("-USDT", "-USDC", "/USDT", "USD/")):
        return "crypto"
    return None


def market_open(market: str, now_ms: int) -> bool:
    """Return whether *market* is open at *now_ms* (epoch milliseconds, UTC).

    Args:
        market: A market identifier known here or to the runtime registry.
        now_ms: Epoch milliseconds, UTC. Pure — reads no clock.

    Returns:
        ``True`` when the venue is open at that instant.

    Raises:
        ValueError: When *market* is unknown to both tables. Fail-loud, matching
            :func:`src.live.runtime.triggers.market_is_open_at`: an unrecognized
            venue must never be silently treated as open (or closed).
    """
    spec = _LOCAL_SPECS.get(market)
    if spec is None:
        return market_is_open_at(market, now_ms)
    if spec.always_open:
        return True
    # Same local-clock projection the runtime registry uses, so a CN rule and a
    # US rule answer "is it open" in one code path rather than two dialects.
    local_dt = _ms_to_aware_dt(now_ms, spec.tz)
    if spec.weekdays and local_dt.weekday() not in spec.weekdays:
        return False
    if local_dt.date() in spec.holidays:
        return False
    return spec.open_time <= local_dt.time() < spec.close_time


def symbol_market_is_open(symbol: str, now_ms: int) -> bool:
    """Return ``True`` for an unqualified symbol, so alerts keep working.

    Args:
        symbol: Canonical symbol, possibly without a venue suffix.
        now_ms: Epoch milliseconds, UTC.

    Returns:
        Whether the subject's session is open, or ``True`` when no session is
        known for it.
    """
    market = subject_market(symbol)
    if market is None:
        return True
    return market_open(market, now_ms)
