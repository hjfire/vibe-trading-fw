"""Alert rule and incident data model.

One :class:`AlertRule` is a complete description of "when should we speak up":
what to look at (``kind`` + ``symbol``), how to decide (``condition``), how
long to wait before believing it (``for_bars``), and how often a persistent
condition may repeat (``realert_ms`` / ``exponential_realert_ms``).

The rule also carries its own *runtime* state (the alert state machine and the
cooldown bookkeeping). That is deliberate: a rule that restarts with the
process must not re-notify for a condition it already announced, so the state
lives in the same atomically-written document as the definition — there is no
second file that can be lost, rebuilt, or disagree with the first.

Serialization is explicit ``to_dict`` / ``from_dict`` (no dataclass magic) so a
stored document from an older schema version fails loudly at the field that
broke instead of silently defaulting a boolean that gates a send.
"""

from __future__ import annotations

import re
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Mapping, Optional

# ---------------------------------------------------------------------------
# Enums
# ---------------------------------------------------------------------------

#: Id rule grammar, mirroring ``_SAFE_JOB_ID_RE`` in
#: ``src/api/scheduled_routes.py`` and the ``_SAFE_PATH_PARAM_RE`` the delete
#: route enforces — a rule created under an id the delete route rejects could
#: never be removed through the API.
SAFE_RULE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")

#: Opaque delivery-target ref grammar, shared with ``src/channels/targets.py``.
_SAFE_TARGET_REF_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")


class AlertKind(str, Enum):
    """What the rule watches.

    Attributes:
        MARKET: A symbol's own bars/indicators (``close``, ``rsi:14``, ...).
        POSITION: A holding from the connected portfolio (``pnl_pct``, ...).
        ACCOUNT: Portfolio-level numbers (``drawdown_pct``, ``equity_usd``).
        EVENT: An inbound alert event (a TradingView / Pine alert webhook).
    """

    MARKET = "market"
    POSITION = "position"
    ACCOUNT = "account"
    EVENT = "event"


class AlertState(str, Enum):
    """Where a rule currently sits in the alert state machine.

    ``RESOLVED`` is never stored as a resting state: a resolved incident ends
    by the rule returning to :attr:`INACTIVE`. ``RESOLVED`` exists so the
    incident record and the rendered message can name the transition that
    produced them.
    """

    INACTIVE = "inactive"
    PENDING = "pending"
    FIRING = "firing"
    RESOLVED = "resolved"


class Severity(str, Enum):
    """How loud a rule is, and what it may silence.

    Ordering matters: a higher-severity firing incident inhibits lower-severity
    ones for the same subject (``src/alerts/engine.py``), so "the account is
    down" mutes "this name is -3% today" instead of burying the user in both.
    """

    INFO = "info"
    WARNING = "warning"
    CRITICAL = "critical"

    @property
    def rank(self) -> int:
        """Return a comparable level (higher is louder)."""
        return _SEVERITY_RANK[self]


_SEVERITY_RANK = {Severity.INFO: 0, Severity.WARNING: 1, Severity.CRITICAL: 2}

#: Condition operators. The names and their semantics are the same set
#: ``frontend/src/lib/screener.ts`` implements, so the app's screener and the
#: server's alert engine cannot disagree about what "crossUp" means.
CONDITION_OPS = (
    "nonEmpty",
    "truthy",
    "gt",
    "lt",
    "crossUp",
    "crossDown",
    "rising",
    "falling",
)

#: Operators that need a comparison partner (a second series or a constant).
_RELATIONAL_OPS = frozenset({"gt", "lt", "crossUp", "crossDown"})

#: Operators that only ever look at one series.
_UNARY_OPS = frozenset({"nonEmpty", "truthy", "rising", "falling"})

# ---------------------------------------------------------------------------
# Durations
# ---------------------------------------------------------------------------

_DURATION_RE = re.compile(
    r"^\s*([0-9]+(?:\.[0-9]+)?)\s*(ms|s|m|h|d)?\s*$", re.IGNORECASE
)
_UNIT_MS = {"ms": 1, "s": 1000, "m": 60_000, "h": 3_600_000, "d": 86_400_000}


def parse_duration_ms(value: Any, *, field_name: str = "duration") -> int:
    """Convert a duration into whole milliseconds.

    Accepts an ``int``/``float`` (already milliseconds), ``None`` (zero), or a
    string with an optional unit suffix — ``"4h"``, ``"30m"``, ``"90s"``,
    ``"1d"``, ``"5000ms"``. A bare number is milliseconds, which keeps the API
    shape identical to the interval schedules the scheduler already stores.

    Args:
        value: The duration to convert.
        field_name: Name to quote in error messages.

    Returns:
        Non-negative milliseconds.

    Raises:
        ValueError: When *value* is negative, unparseable, or carries no unit
            the parser recognizes.
    """
    if value is None:
        return 0
    if isinstance(value, bool):
        raise ValueError(f"{field_name} must be a number or a duration string")
    if isinstance(value, (int, float)):
        if value < 0:
            raise ValueError(f"{field_name} must not be negative")
        return int(value)
    match = _DURATION_RE.fullmatch(str(value))
    if match is None:
        raise ValueError(
            f"{field_name} {value!r} is not a duration; use milliseconds or a "
            "number with ms/s/m/h/d (e.g. '4h', '30m')"
        )
    amount = float(match.group(1))
    unit = (match.group(2) or "ms").lower()
    return int(round(amount * _UNIT_MS[unit]))


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------


def validate_rule_id(rule_id: str) -> None:
    """Raise ``ValueError`` when *rule_id* is not usable as an API path param."""
    if not isinstance(rule_id, str) or not SAFE_RULE_ID_RE.fullmatch(rule_id):
        raise ValueError(
            "alert id must be 1-128 characters of letters, digits, '_' or '-'"
        )


def validate_condition(condition: Mapping[str, Any]) -> None:
    """Raise ``ValueError`` when a condition dict is not evaluable.

    The check is structural, not statistical: it refuses an unknown operator, a
    relational operator with neither ``rhs`` nor ``value`` to compare against, a
    unary operator that was handed a comparison anyway, and a non-numeric
    ``value``. Whether the series actually has enough bars is a runtime fact the
    engine reports per evaluation — a rule for a freshly listed symbol is
    legitimate.

    Args:
        condition: Mapping with ``op`` plus the operator's operands.
    """
    if not isinstance(condition, Mapping):
        raise ValueError("condition must be an object")
    op = condition.get("op")
    if not isinstance(op, str) or op not in CONDITION_OPS:
        raise ValueError(
            f"condition.op {op!r} is not supported; expected one of "
            + ", ".join(CONDITION_OPS)
        )
    lhs = condition.get("lhs")
    if not isinstance(lhs, str) or not lhs.strip():
        raise ValueError("condition.lhs must be a non-empty series name")
    value = condition.get("value")
    if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))):
        raise ValueError("condition.value must be a number or null")
    rhs = condition.get("rhs")
    if rhs is not None and (not isinstance(rhs, str) or not rhs.strip()):
        raise ValueError("condition.rhs must be a series name or null")
    if op in _RELATIONAL_OPS and rhs is None and value is None:
        raise ValueError(f"condition.op {op!r} needs either rhs or value")
    if op in _UNARY_OPS and (rhs is not None or value is not None):
        raise ValueError(f"condition.op {op!r} does not take rhs or value")


def validate_rule(rule: "AlertRule") -> None:
    """Raise ``ValueError`` when a rule cannot be safely stored or evaluated.

    Args:
        rule: The rule to check.
    """
    validate_rule_id(rule.id)
    if rule.kind not in AlertKind:
        raise ValueError(f"alert kind {rule.kind!r} is not supported")
    if rule.kind in (AlertKind.MARKET, AlertKind.POSITION):
        if not rule.symbol.strip():
            raise ValueError(f"{rule.kind.value} alerts need a symbol")
    if rule.kind != AlertKind.EVENT:
        validate_condition(rule.condition)
    if rule.for_bars < 1:
        raise ValueError("for_bars must be at least 1")
    if rule.for_bars > 1000:
        raise ValueError("for_bars must stay at or below 1000")
    if rule.realert_ms < 0:
        raise ValueError("realert_ms must not be negative")
    if rule.exponential_realert_ms and rule.exponential_realert_ms < rule.realert_ms:
        raise ValueError("exponential_realert_ms must not be shorter than realert_ms")
    if rule.poll_interval_ms < 1000:
        raise ValueError("poll_interval_ms must be at least 1000")
    if rule.count < 2:
        raise ValueError("count must be at least 2 (a crossing needs a previous bar)")
    if rule.count > 2000:
        raise ValueError("count must stay at or below 2000")
    for ref in rule.targets:
        if not _SAFE_TARGET_REF_RE.fullmatch(ref):
            raise ValueError(f"delivery target ref {ref!r} is not a valid ref name")
    if rule.channel and not rule.target:
        raise ValueError("channel is set without a target address")
    if rule.target and not rule.channel:
        raise ValueError("target is set without a channel")
    if rule.send_resolved and rule.kind == AlertKind.EVENT:
        # An event has no "back to normal" edge — the sender's own cadence is
        # the only recovery signal, so promising a resolution note would be
        # promising something the model cannot deliver.
        raise ValueError("event alerts cannot send a resolution notice")


# ---------------------------------------------------------------------------
# Rule
# ---------------------------------------------------------------------------


@dataclass
class AlertRule:
    """One alert rule: its definition and its live state-machine bookkeeping.

    Attributes:
        id: Stable identifier; part of every delivery idempotency key.
        title: Human label used in the pushed message.
        kind: Which subject the rule watches.
        symbol: Canonical project symbol (``600519.SH`` / ``AAPL.US`` /
            ``BTC-USDT``), required for market and position rules.
        interval: Bar interval for market rules, e.g. ``1D`` or ``5m``.
        count: How many bars to pull per evaluation.
        adjust: Price adjustment for daily bars (``qfq`` by default, matching
            the app's screener).
        condition: The operator dict validated by :func:`validate_condition`.
        for_bars: Consecutive hits required before firing (debounce).
        realert_ms: Minimum gap between two notifications for a condition that
            stays true.
        exponential_realert_ms: Ceiling for the doubling cooldown.
        severity: Loudness, used by inhibition.
        send_resolved: Also push the recovery note when the condition clears.
        session_only: Skip evaluation while the subject's market is closed.
        targets: Opaque delivery-target refs (``research-group``), never raw
            chat ids.
        channel: Explicit channel id for ad-hoc targets.
        target: Address within ``channel``; kept out of the store when
            ``targets`` refs are used instead.
        webhook_secret_hash: SHA-256 hex of the inbound webhook secret for
            ``event`` rules. The plaintext is shown once at creation and is
            never readable afterwards.
        enabled: Paused rules are stored and listed but never evaluated.
        state: Current alert state machine position.
        pending_hits: Consecutive hits seen toward ``for_bars``.
        fired_count: Notifications actually sent for the current episode.
        last_notify_ms: Wall time of the last accepted send.
        muted_until: Cooldown horizon; evaluations before it do not notify.
        last_value: Newest evaluated lhs value (for display).
        last_reason: Newest human-readable evaluation note.
        last_error: Last data failure, if any.
        last_checked_at: Epoch-ms of the last evaluation attempt.
        created_at / updated_at: Epoch-ms.
    """

    id: str
    kind: AlertKind = AlertKind.MARKET
    title: str = ""
    symbol: str = ""
    interval: str = "1D"
    count: int = 320
    adjust: str = "qfq"
    condition: Dict[str, Any] = field(default_factory=dict)
    for_bars: int = 1
    realert_ms: int = 0
    exponential_realert_ms: int = 0
    severity: Severity = Severity.WARNING
    send_resolved: bool = True
    session_only: bool = False
    targets: List[str] = field(default_factory=list)
    channel: Optional[str] = None
    target: Optional[str] = None
    webhook_secret_hash: Optional[str] = None
    enabled: bool = True
    state: AlertState = AlertState.INACTIVE
    pending_hits: int = 0
    fired_count: int = 0
    last_notify_ms: Optional[int] = None
    muted_until: int = 0
    last_value: Optional[float] = None
    last_reason: str = ""
    last_error: Optional[str] = None
    last_checked_at: Optional[int] = None
    poll_interval_ms: int = 300_000
    created_at: int = 0
    updated_at: int = 0

    def __post_init__(self) -> None:
        """Normalize enums handed in as strings and stamp timestamps."""
        if isinstance(self.kind, str):
            self.kind = AlertKind(self.kind)
        if isinstance(self.severity, str):
            self.severity = Severity(self.severity)
        if isinstance(self.state, str):
            self.state = AlertState(self.state)
        self.symbol = str(self.symbol or "").strip().upper()
        self.title = str(self.title or "").strip()
        if not self.created_at:
            self.created_at = int(time.time() * 1000)
        if not self.updated_at:
            self.updated_at = self.created_at

    @property
    def display_title(self) -> str:
        """Title to show in a message: the author's label, or the subject."""
        return self.title or f"{self.symbol or self.kind.value} {self.interval}"

    def to_dict(self) -> Dict[str, Any]:
        """Serialize to a JSON-safe dict (full round trip with :meth:`from_dict`)."""
        return {
            "id": self.id,
            "kind": self.kind.value,
            "title": self.title,
            "symbol": self.symbol,
            "interval": self.interval,
            "count": self.count,
            "adjust": self.adjust,
            "condition": dict(self.condition),
            "for_bars": self.for_bars,
            "realert_ms": self.realert_ms,
            "exponential_realert_ms": self.exponential_realert_ms,
            "severity": self.severity.value,
            "send_resolved": self.send_resolved,
            "session_only": self.session_only,
            "targets": list(self.targets),
            "channel": self.channel,
            "target": self.target,
            "webhook_secret_hash": self.webhook_secret_hash,
            "enabled": self.enabled,
            "poll_interval_ms": self.poll_interval_ms,
            "state": self.state.value,
            "pending_hits": self.pending_hits,
            "fired_count": self.fired_count,
            "last_notify_ms": self.last_notify_ms,
            "muted_until": self.muted_until,
            "last_value": self.last_value,
            "last_reason": self.last_reason,
            "last_error": self.last_error,
            "last_checked_at": self.last_checked_at,
            "created_at": self.created_at,
            "updated_at": self.updated_at,
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "AlertRule":
        """Reconstruct a rule from :meth:`to_dict` output.

        Args:
            data: The stored mapping.

        Returns:
            The reconstructed rule.

        Raises:
            ValueError: When ``kind``, ``severity`` or ``state`` holds a value
                this build does not know — an unknown state must not be
                guessed at, because guessing wrong can either spam a channel or
                silently mute one.
            TypeError: When a scalar field holds the wrong type.
        """
        if not isinstance(data, Mapping):
            raise TypeError("alert rule must be an object")

        def _enum(name: str, value: Any, kind, default):  # type: ignore[no-untyped-def]
            if value is None:
                return default
            try:
                return kind(value)
            except ValueError as exc:
                raise ValueError(f"unknown {name} {value!r}") from exc

        def _int(name: str, value: Any, default: int = 0) -> int:
            if value is None:
                return default
            if isinstance(value, bool) or not isinstance(value, int):
                raise TypeError(f"'{name}' must be an integer")
            return value

        def _opt_int(name: str, value: Any) -> Optional[int]:
            if value is None:
                return None
            if isinstance(value, bool) or not isinstance(value, int):
                raise TypeError(f"'{name}' must be an integer or null")
            return value

        def _num(name: str, value: Any) -> Optional[float]:
            if value is None:
                return None
            if isinstance(value, bool) or not isinstance(value, (int, float)):
                raise TypeError(f"'{name}' must be a number or null")
            return float(value)

        def _text(name: str, value: Any, default: str = "") -> str:
            if value is None:
                return default
            if not isinstance(value, str):
                raise TypeError(f"'{name}' must be a string")
            return value

        def _flag(name: str, value: Any, default: bool) -> bool:
            if value is None:
                return default
            if not isinstance(value, bool):
                raise TypeError(f"'{name}' must be a boolean")
            return value

        condition = data.get("condition") or {}
        if not isinstance(condition, dict):
            raise TypeError("'condition' must be an object")
        targets = data.get("targets") or []
        if not isinstance(targets, list) or not all(isinstance(t, str) for t in targets):
            raise TypeError("'targets' must be a list of strings")

        return cls(
            id=_text("id", data.get("id")),
            kind=_enum("kind", data.get("kind"), AlertKind, AlertKind.MARKET),
            title=_text("title", data.get("title")),
            symbol=_text("symbol", data.get("symbol")),
            interval=_text("interval", data.get("interval"), "1D"),
            count=_int("count", data.get("count"), 320),
            adjust=_text("adjust", data.get("adjust"), "qfq"),
            condition=dict(condition),
            for_bars=_int("for_bars", data.get("for_bars"), 1),
            realert_ms=_int("realert_ms", data.get("realert_ms"), 0),
            exponential_realert_ms=_int(
                "exponential_realert_ms", data.get("exponential_realert_ms"), 0
            ),
            severity=_enum("severity", data.get("severity"), Severity, Severity.WARNING),
            send_resolved=_flag("send_resolved", data.get("send_resolved"), True),
            session_only=_flag("session_only", data.get("session_only"), False),
            targets=list(targets),
            channel=data.get("channel"),
            target=data.get("target"),
            webhook_secret_hash=data.get("webhook_secret_hash"),
            enabled=_flag("enabled", data.get("enabled"), True),
            state=_enum("state", data.get("state"), AlertState, AlertState.INACTIVE),
            pending_hits=_int("pending_hits", data.get("pending_hits"), 0),
            fired_count=_int("fired_count", data.get("fired_count"), 0),
            last_notify_ms=_opt_int("last_notify_ms", data.get("last_notify_ms")),
            muted_until=_int("muted_until", data.get("muted_until"), 0),
            last_value=_num("last_value", data.get("last_value")),
            last_reason=_text("last_reason", data.get("last_reason")),
            last_error=data.get("last_error"),
            last_checked_at=_opt_int("last_checked_at", data.get("last_checked_at")),
            poll_interval_ms=_int("poll_interval_ms", data.get("poll_interval_ms"), 300_000),
            created_at=_int("created_at", data.get("created_at")),
            updated_at=_int("updated_at", data.get("updated_at")),
        )


# ---------------------------------------------------------------------------
# Incident
# ---------------------------------------------------------------------------


@dataclass
class AlertIncident:
    """One notification-producing transition of a rule.

    An incident is written *before* the send is attempted and updated with the
    delivery outcome afterwards: a rule that fired while every channel was down
    still has to appear in the timeline, otherwise the audit trail would claim
    the condition never happened.

    Attributes:
        id: Incident identifier.
        rule_id: The rule that produced it.
        rule_title: Denormalized title so history survives rule deletion.
        symbol: Denormalized subject.
        kind: Rule kind at fire time.
        state: The transition — ``firing`` or ``resolved``.
        severity: Rule severity at fire time.
        value: The evaluated lhs value.
        reason: Human-readable why, from the condition evaluator.
        at_ms: Epoch-ms of the transition.
        delivery_key: Idempotency key handed to the outbox.
        delivery_status: ``none`` / ``pending`` / ``sent`` / ``failed``.
        delivery_error: Redaction-safe failure diagnostic.
        delivery_attempts: Send attempts for this incident.
        provider_message_id: Channel-side message id of the accepted send.
        delivery_updated_at: Epoch-ms of the last delivery state change.
    """

    id: str
    rule_id: str
    rule_title: str = ""
    symbol: str = ""
    kind: AlertKind = AlertKind.MARKET
    state: AlertState = AlertState.FIRING
    severity: Severity = Severity.WARNING
    value: Optional[float] = None
    reason: str = ""
    at_ms: int = 0
    delivery_key: str = ""
    delivery_status: str = "pending"
    delivery_error: Optional[str] = None
    delivery_attempts: int = 0
    provider_message_id: Optional[str] = None
    delivery_updated_at: Optional[int] = None

    def to_dict(self) -> Dict[str, Any]:
        """Serialize to a JSON-safe dict."""
        return {
            "id": self.id,
            "rule_id": self.rule_id,
            "rule_title": self.rule_title,
            "symbol": self.symbol,
            "kind": self.kind.value if isinstance(self.kind, AlertKind) else str(self.kind),
            "state": self.state.value if isinstance(self.state, AlertState) else str(self.state),
            "severity": self.severity.value if isinstance(self.severity, Severity) else str(self.severity),
            "value": self.value,
            "reason": self.reason,
            "at_ms": self.at_ms,
            "delivery_key": self.delivery_key,
            "delivery_status": self.delivery_status,
            "delivery_error": self.delivery_error,
            "delivery_attempts": self.delivery_attempts,
            "provider_message_id": self.provider_message_id,
            "delivery_updated_at": self.delivery_updated_at,
        }

    @classmethod
    def from_dict(cls, data: Mapping[str, Any]) -> "AlertIncident":
        """Reconstruct an incident, rejecting unknown enum values loudly.

        Args:
            data: The stored mapping.

        Returns:
            The reconstructed incident.

        Raises:
            ValueError: When an enum field holds an unrecognized value.
            TypeError: When a field holds the wrong type.
        """
        if not isinstance(data, Mapping):
            raise TypeError("alert incident must be an object")
        try:
            kind = AlertKind(data.get("kind", AlertKind.MARKET.value))
            state = AlertState(data.get("state", AlertState.FIRING.value))
            severity = Severity(data.get("severity", Severity.WARNING.value))
        except ValueError as exc:
            raise ValueError(f"alert incident field is not recognized: {exc}") from exc
        for name in ("id", "rule_id"):
            value = data.get(name)
            if not isinstance(value, str) or not value:
                raise TypeError(f"alert incident '{name}' must be a non-empty string")
        attempts = data.get("delivery_attempts", 0)
        if isinstance(attempts, bool) or not isinstance(attempts, int) or attempts < 0:
            raise TypeError("'delivery_attempts' must be a non-negative integer")
        value = data.get("value")
        if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float))):
            raise TypeError("'value' must be a number or null")
        return cls(
            id=data["id"],
            rule_id=data["rule_id"],
            rule_title=str(data.get("rule_title") or ""),
            symbol=str(data.get("symbol") or ""),
            kind=kind,
            state=state,
            severity=severity,
            value=float(value) if value is not None else None,
            reason=str(data.get("reason") or ""),
            at_ms=int(data.get("at_ms") or 0),
            delivery_key=str(data.get("delivery_key") or ""),
            delivery_status=str(data.get("delivery_status") or "pending"),
            delivery_error=data.get("delivery_error"),
            delivery_attempts=int(attempts),
            provider_message_id=data.get("provider_message_id"),
            delivery_updated_at=data.get("delivery_updated_at"),
        )
