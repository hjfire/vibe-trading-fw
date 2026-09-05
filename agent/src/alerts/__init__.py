"""Durable alert rules, the firing state machine, and IM delivery.

The package is the alerting counterpart to :mod:`src.scheduled_research`:
where that one runs a research prompt on a clock and pushes its briefing,
this one evaluates a *condition* against market/portfolio data (or accepts an
inbound alert event, e.g. a TradingView webhook) and pushes the transition.

Module map
----------
``models``
    Rule / incident dataclasses, enums, validation, duration parsing.
``conditions``
    Pure condition evaluation over named series (``close``, ``rsi:14``,
    ``pnl_pct`` ...). Same operator grammar as ``frontend/src/lib/screener.ts``.
``engine``
    The ``inactive -> pending -> firing -> resolved`` state machine with
    ``for_bars`` debouncing, ``realert`` cooldown, severity inhibition and
    resolution notifications. Pure functions over an injected ``now_ms``.
``store``
    Crash-safe JSON persistence (atomic replace), same pattern as
    :mod:`src.scheduled_research.store`.
``delivery``
    Message rendering plus idempotent send through the existing channel
    runtime (:mod:`src.channels`) — the alert layer never talks to a channel
    SDK directly.
``inbox``
    Inbound alert events (TradingView / Pine alert webhooks): payload
    normalization, symbol canonicalization, constant-time secret check.
``service``
    The domain service the HTTP routes and the background poller share.
"""

from __future__ import annotations

from src.alerts.conditions import (
    ConditionResult,
    EvalContext,
    SeriesBundle,
    evaluate_condition,
    resolve_series,
)
from src.alerts.delivery import (
    DeliveryError,
    render_alert_message,
    resolve_addresses,
    send_alert_text,
)
from src.alerts.engine import (
    ACTION_COOLING,
    ACTION_ERROR,
    ACTION_NOTIFY_FIRING,
    ACTION_NOTIFY_RESOLVED,
    ACTION_PENDING,
    ACTION_SUPPRESSED,
    AlertDecision,
    RuleState,
    advance_rule,
    decide_incident_actions,
    find_inhibitor,
    make_incident,
)
from src.alerts.inbox import (
    InboundAlert,
    InboundAlertError,
    canonical_symbol,
    normalize_alert_event,
    secret_matches,
    secret_sha256,
)
from src.alerts.models import (
    AlertIncident,
    AlertRule,
    AlertState,
    Severity,
    parse_duration_ms,
    validate_condition,
    validate_rule,
    validate_rule_id,
)
from src.alerts.poller import AlertPoller
from src.alerts.sessions import (
    market_open,
    subject_market,
    symbol_market_is_open,
)
from src.alerts.service import AlertService, TickReport
from src.alerts.store import AlertStore, CorruptAlertStoreError

__all__ = [
    "ACTION_COOLING",
    "ACTION_ERROR",
    "ACTION_NOTIFY_FIRING",
    "ACTION_NOTIFY_RESOLVED",
    "ACTION_PENDING",
    "ACTION_SUPPRESSED",
    "AlertDecision",
    "AlertIncident",
    "AlertPoller",
    "AlertRule",
    "AlertService",
    "AlertState",
    "AlertStore",
    "ConditionResult",
    "CorruptAlertStoreError",
    "DeliveryError",
    "EvalContext",
    "InboundAlert",
    "InboundAlertError",
    "RuleState",
    "SeriesBundle",
    "Severity",
    "TickReport",
    "advance_rule",
    "canonical_symbol",
    "decide_incident_actions",
    "evaluate_condition",
    "find_inhibitor",
    "make_incident",
    "market_open",
    "normalize_alert_event",
    "parse_duration_ms",
    "render_alert_message",
    "resolve_addresses",
    "resolve_series",
    "secret_matches",
    "secret_sha256",
    "send_alert_text",
    "subject_market",
    "symbol_market_is_open",
    "validate_condition",
    "validate_rule",
    "validate_rule_id",
]
