"""Shared FutuOpenD gateway access: failure cooldown and realtime snapshots.

FutuOpenD is a gateway process the operator starts and logs into by hand. It
is up when the desk is open and gone otherwise, and it backs both the
historical-kline loader (:mod:`backtest.loaders.futu`) and the realtime
snapshots exposed here.

Why the cooldown exists
-----------------------
``futu`` leads the ``a_share`` / ``us_equity`` / ``hk_equity`` fallback chains.
When the gateway is down, an unguarded walk pays a full SDK connect failure
*per symbol per resolution pass*: every candidate constructs an
``OpenQuoteContext``, eats the error, and only then moves on to the next
source. Latching the first failure as "known down" for :data:`COOLDOWN_S`
turns those N attempts into one, so an absent gateway degrades immediately
and with predictable latency. A later success clears the latch, so an OpenD
that comes back mid-session is picked up without restarting anything.

Failure is a normal state here, not an exception
------------------------------------------------
Nothing in this module raises at a caller that is only asking whether the
gateway is usable. :func:`fetch_snapshots` returns an empty dict on any
problem so quote consumers fall through to the daily-bar path — "OpenD is not
running" must not turn into a failed request or a dead alert rule.

Rate limiting
-------------
Futu documents the snapshot endpoint at 60 requests per 30 seconds.
:data:`MIN_SNAPSHOT_INTERVAL_S` spaces outbound snapshot calls so a batch of
watchlist symbols polled in a loop cannot spend the whole allowance on one
page load.
"""

from __future__ import annotations

import logging
import socket
import threading
import time
from typing import Any, Iterable

logger = logging.getLogger(__name__)

#: How long a gateway failure keeps :func:`in_cooldown` answering True.
#: Long enough to cover one multi-symbol backtest walk, short enough that a
#: restarted OpenD is usable again without a restart of this process.
COOLDOWN_S = 90.0

#: Minimum spacing between outbound snapshot calls (60 per 30s documented).
MIN_SNAPSHOT_INTERVAL_S = 0.5

#: How long a successful :func:`probe` is trusted before it is re-checked. A
#: walk asks once per (source, market) group, so without a window a single
#: multi-market request would open several probes.
PROBE_TTL_S = 30.0

#: A localhost gateway answers in well under a millisecond; the timeout only
#: has to catch a remote gateway that has stopped accepting.
PROBE_TIMEOUT_S = 0.75

_lock = threading.Lock()

# (host, port) -> monotonic deadline until which the gateway is known down.
_DOWN_UNTIL: dict[tuple[str, int], float] = {}

# Monotonic deadline of the next permitted snapshot call (single global gate:
# one OpenD process serves the whole app, so one spacing rule is enough).
_NEXT_SNAPSHOT_AT = [0.0]

# (host, port) -> monotonic deadline until which a successful probe is trusted.
_PROBE_OK_UNTIL: dict[tuple[str, int], float] = {}


def gateway_target() -> tuple[str, int]:
    """Return the configured ``(host, port)`` of the FutuOpenD gateway."""
    from src.config.accessor import get_env_config

    cfg = get_env_config().data
    return cfg.futu_host, cfg.futu_port


def in_cooldown(host: str | None = None, port: int | None = None) -> bool:
    """True when the gateway failed recently and should not be retried yet.

    Answers from memory only — no socket, no SDK — which is the point: the
    callers are fallback-chain walks that need an instant answer.
    """
    if host is None or port is None:
        host, port = gateway_target()
    with _lock:
        until = _DOWN_UNTIL.get((host, int(port)))
        if until is None:
            return False
        if time.monotonic() >= until:
            _DOWN_UNTIL.pop((host, int(port)), None)
            return False
        return True


def cooldown_remaining(host: str | None = None, port: int | None = None) -> float:
    """Seconds left on the current cooldown (``0.0`` when not latched)."""
    if host is None or port is None:
        host, port = gateway_target()
    with _lock:
        until = _DOWN_UNTIL.get((host, int(port)))
        if until is None:
            return 0.0
        return max(0.0, until - time.monotonic())


def note_failure(host: str | None = None, port: int | None = None, *, reason: str = "") -> None:
    """Latch the gateway as down for :data:`COOLDOWN_S`."""
    if host is None or port is None:
        host, port = gateway_target()
    with _lock:
        _DOWN_UNTIL[(host, int(port))] = time.monotonic() + COOLDOWN_S
    logger.warning(
        "FutuOpenD %s:%s marked unavailable for %.0fs (%s)", host, port, COOLDOWN_S, reason
    )


def note_success(host: str | None = None, port: int | None = None) -> None:
    """Clear a down-latch after a call that proved the gateway is back."""
    if host is None or port is None:
        host, port = gateway_target()
    with _lock:
        _DOWN_UNTIL.pop((host, int(port)), None)


def reset_state() -> None:
    """Drop all cooldown, pacing and probe state. For tests and gateway re-logins."""
    with _lock:
        _DOWN_UNTIL.clear()
        _PROBE_OK_UNTIL.clear()
        _NEXT_SNAPSHOT_AT[0] = 0.0


def probe(host: str | None = None, port: int | None = None) -> bool:
    """Answer whether it is worth routing a request through the gateway.

    This is a TCP accept check, not an SDK connect: :meth:`FutuLoader.is_available`
    builds an ``OpenQuoteContext`` (threads + handshake, ~1s) which is far too
    expensive to consult once per symbol group while deciding *whether* to
    prefer a source. A refused port is the dominant failure mode — OpenD is not
    running — and this catches it for free.

    A ``True`` here is not a promise that the call will succeed: the process can
    be up but logged out, or it can lack the entitlement for a given code. Those
    show up as ordinary per-symbol failures and latch :func:`note_failure`, which
    is what :func:`in_cooldown` and therefore this function then report.
    """
    if host is None or port is None:
        host, port = gateway_target()
    if not host or not port:
        # Not configured is a different answer from "configured and down": no
        # latch, no log, and no socket call attempted against an empty target.
        return False
    key = (host, int(port))
    if in_cooldown(host, port):
        return False
    with _lock:
        if time.monotonic() < _PROBE_OK_UNTIL.get(key, 0.0):
            return True
    try:
        with socket.create_connection(key, timeout=PROBE_TIMEOUT_S):
            pass
    except OSError as exc:
        logger.debug("FutuOpenD %s:%s not accepting connections: %s", host, port, exc)
        # Latch the cooldown, not just the probe: a port that refuses is proof
        # the gateway is gone, and every other caller asks this same question.
        note_failure(host, port, reason="probe: connection refused")
        return False
    with _lock:
        _PROBE_OK_UNTIL[key] = time.monotonic() + PROBE_TTL_S
    return True


def open_context(host: str | None = None, port: int | None = None) -> Any:
    """Construct an ``OpenQuoteContext`` for the gateway.

    Raises whatever the SDK raises on a refused/failed connect; callers decide
    whether that is a cooldown-worthy failure or something to surface. The SDK
    is imported lazily so this module stays importable where ``futu-api`` is
    not installed (CI, containers built from the hash-pinned lock files).
    """
    if host is None or port is None:
        host, port = gateway_target()
    import futu  # noqa: PLC0415 — optional dependency, absent in CI

    return futu.OpenQuoteContext(host=host, port=int(port))


def _wait_for_snapshot_slot() -> None:
    """Block briefly so outbound snapshot calls respect the documented pace.

    The next deadline is measured from the *previous* one, not from "now", so
    a burst of calls queues at a steady interval instead of each call
    restarting the clock from its own arrival time.
    """
    with _lock:
        now = time.monotonic()
        due = max(now, _NEXT_SNAPSHOT_AT[0])
        _NEXT_SNAPSHOT_AT[0] = due + MIN_SNAPSHOT_INTERVAL_S
        wait = due - now
    if wait > 0:
        time.sleep(wait)


def fetch_snapshots(codes: Iterable[str]) -> dict[str, dict[str, Any]]:
    """Realtime snapshot per Futu-format code, keyed by the code asked for.

    ``codes`` must already be in OpenD form (``HK.00700`` / ``SH.600519`` /
    ``US.AAPL``); symbol normalization belongs to the loader.

    Returns ``{}`` when the gateway is in cooldown, not installed, unreachable,
    or rejects the batch — every one of those is a fall-through signal, not an
    error. Partial results are returned as-is: a code OpenD refuses simply
    does not appear in the mapping.
    """
    wanted = [c for c in dict.fromkeys(codes) if c]
    if not wanted:
        return {}

    host, port = gateway_target()
    if in_cooldown(host, port):
        logger.debug("FutuOpenD in cooldown; skipping %d snapshot code(s)", len(wanted))
        return {}

    _wait_for_snapshot_slot()
    try:
        import futu  # noqa: PLC0415 — optional dependency, absent in CI

        ctx = open_context(host, port)
    except Exception as exc:  # noqa: BLE001 — any connect failure is a down signal
        note_failure(host, port, reason=f"snapshot connect: {type(exc).__name__}")
        return {}

    try:
        ret, data = ctx.get_market_snapshot(wanted)
        if ret != futu.RET_OK:
            # A refusal of this particular batch is not proof the gateway is
            # down (bad code, missing entitlement), so no cooldown is latched.
            logger.debug("FutuOpenD snapshot rejected %s: %s", wanted, data)
            return {}
        note_success(host, port)
        out: dict[str, dict[str, Any]] = {}
        for _idx, row in data.iterrows():
            last = row.get("last_price")
            if last is None or last != last:  # None / NaN
                continue
            out[str(row["code"])] = {
                "last": float(last),
                "prev_close": float(row.get("prev_close_price") or 0.0) or None,
                "open": float(row.get("open_price") or 0.0) or None,
                "high": float(row.get("high_price") or 0.0) or None,
                "low": float(row.get("low_price") or 0.0) or None,
                "volume": float(row.get("volume") or 0.0),
                "turnover": float(row.get("turnover") or 0.0),
                "update_time": str(row.get("update_time") or ""),
                "name": str(row.get("name") or ""),
            }
        return out
    except OSError as exc:
        # Only a transport-level failure is evidence about the gateway itself.
        # Latching on any exception would let a local bug (a bad unpack, a typo
        # in a field name) take a healthy gateway out of every chain for
        # COOLDOWN_S, which is far more damaging than the bug it hides.
        note_failure(host, port, reason=f"snapshot transport: {type(exc).__name__}")
        return {}
    except Exception:  # noqa: BLE001 — report, keep the gateway considered up
        logger.exception("FutuOpenD snapshot processing failed")
        return {}
    finally:
        try:
            ctx.close()
        except Exception:  # noqa: BLE001 — close failures must not mask results
            logger.debug("FutuOpenD snapshot context close failed", exc_info=True)
