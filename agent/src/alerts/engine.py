"""The alert state machine: ``inactive -> pending -> firing -> resolved``.

Everything here is a pure function of its arguments. ``now_ms`` is injected
rather than read from a clock, which is what lets a test walk a rule through a
week of evaluations in a millisecond and assert exactly which notifications the
operator would have received.

Three semantics are load-bearing and were lifted from the alerting systems this
design borrows from (Prometheus Alertmanager's ``for`` / ``repeat_interval`` /
inhibition, ElastAlert 2's ``realert`` / ``exponential_realert``):

``for_bars``
    A condition has to hold that many evaluations in a row before anyone is
    notified. One wick through a level is not an event.

``realert_ms``
    The minimum gap between two notifications for a condition that stays true.
    With ``exponential_realert_ms`` set, the gap doubles per notification up to
    that ceiling, so a level a name sits below all day produces one message,
    then two, then four-hour-apart reminders — not one per poll.

inhibition
    While a louder rule about the same subject is firing, a quieter rule still
    moves to ``firing`` (the fact is recorded) but does not speak. Recovering
    notifications are never inhibited: a user who was told "critical" still has
    to learn that it stopped.
"""

from __future__ import annotations

from dataclasses import dataclass, replace
from typing import Dict, Iterable, List, Optional, Sequence

from src.alerts.conditions import ConditionResult, describe_condition
from src.alerts.models import AlertIncident, AlertRule, AlertState

#: What the caller should do with an evaluation's outcome.
ACTION_NOTIFY_FIRING = "notify_firing"
ACTION_NOTIFY_RESOLVED = "notify_resolved"
ACTION_PENDING = "pending"
ACTION_COOLING = "cooling"
ACTION_SUPPRESSED = "suppressed"
ACTION_NONE = "none"
ACTION_ERROR = "error"
ACTION_CLOSED = "closed"


@dataclass(frozen=True)
class RuleState:
    """The mutable half of a rule, isolated so transitions are comparable.

    Attributes:
        state: Where the rule sits in the state machine.
        pending_hits: Consecutive hits so far toward ``for_bars``.
        notify_seq: Notifications sent for this rule's lifetime (episode-agnostic
            and monotonic, which is what makes an idempotency key unique).
        muted_until: Epoch-ms before which a repeat notification is withheld.
        last_notify_ms: Epoch-ms of the last accepted notification.
    """

    state: AlertState = AlertState.INACTIVE
    pending_hits: int = 0
    notify_seq: int = 0
    muted_until: int = 0
    last_notify_ms: Optional[int] = None

    @classmethod
    def of(cls, rule: AlertRule) -> "RuleState":
        """Read the current state off a stored rule."""
        return cls(
            state=rule.state,
            pending_hits=rule.pending_hits,
            notify_seq=rule.fired_count,
            muted_until=rule.muted_until,
            last_notify_ms=rule.last_notify_ms,
        )

    def apply_to(self, rule: AlertRule) -> AlertRule:
        """Return a copy of *rule* carrying this state.

        Args:
            rule: The rule to update.

        Returns:
            A new rule object; the input is never mutated, so an evaluation can
            be replayed against the same stored snapshot in a test.
        """
        return replace(
            rule,
            state=self.state,
            pending_hits=self.pending_hits,
            fired_count=self.notify_seq,
            muted_until=self.muted_until,
            last_notify_ms=self.last_notify_ms,
        )


@dataclass(frozen=True)
class AlertDecision:
    """One evaluation's outcome and the transition it produced.

    Attributes:
        action: One of the ``ACTION_*`` constants.
        state: The rule state to persist.
        incident_state: Set for the two notifying actions (``FIRING`` /
            ``RESOLVED``), ``None`` otherwise.
        reason: Why it fired or is still quiet (human-readable, Chinese).
        value: The newest lhs value.
        bars: Data points behind that value.
        error: Data failure, when the verdict could not be measured.
    """

    action: str
    state: RuleState
    incident_state: Optional[AlertState] = None
    reason: str = ""
    value: Optional[float] = None
    bars: int = 0
    error: Optional[str] = None

    @property
    def notifies(self) -> bool:
        """Whether this decision should produce a pushed message."""
        return self.incident_state is not None


def cooldown_ms(rule: AlertRule, notify_seq: int) -> int:
    """Return the gap to hold after the ``notify_seq``-th notification.

    Args:
        rule: The rule being evaluated.
        notify_seq: The 1-based sequence number of the notification about to be
            sent (the gap is applied *after* a send, so a zero realert means
            "one notice per episode" rather than "unlimited").

    Returns:
        Milliseconds to stay quiet. ``0`` when the rule has no repeat cooldown.
    """
    if rule.realert_ms <= 0:
        return 0
    gap = rule.realert_ms
    if rule.exponential_realert_ms > 0:
        # Double per notification, clamped: 4h, 8h, 16h ... capped at 24h.
        steps = max(0, notify_seq - 1)
        gap = min(rule.realert_ms * (2**steps), rule.exponential_realert_ms)
    return int(gap)


def find_inhibitor(rule: AlertRule, others: Iterable[AlertRule]) -> Optional[AlertRule]:
    """Return a louder firing rule about the same subject, if there is one.

    Only the same subject is comparable: ``600519.SH``-critical does not mute
    ``BTC-USDT``-warning. Equal severity does not mute either, so two peers both
    stay audible.

    Args:
        rule: The candidate about to notify.
        others: Every other enabled rule (their persisted state is what counts).

    Returns:
        The muting rule, or ``None``.
    """
    if rule.kind.value == "event":
        # An inbound alert already carries someone else's judgement; muting it
        # on a local heuristic would drop a message the user explicitly asked
        # their chart to send.
        return None
    subject = (rule.symbol or "").upper()
    if not subject:
        return None
    for other in others:
        if other.id == rule.id or not other.enabled:
            continue
        if other.state != AlertState.FIRING:
            continue
        if (other.symbol or "").upper() != subject:
            continue
        if other.severity.rank > rule.severity.rank:
            return other
    return None


def advance_rule(
    rule: AlertRule,
    result: ConditionResult,
    now_ms: int,
    *,
    market_is_open: bool = True,
    inhibited_by: Optional[str] = None,
) -> AlertDecision:
    """Move one rule forward by a single evaluation.

    Args:
        rule: The rule as currently stored (never mutated).
        result: The condition verdict for this pass.
        now_ms: Epoch milliseconds for this pass — injected, never read here.
        market_is_open: Session gate. ``False`` freezes the rule: no evaluation
            is trusted, so nothing fires and nothing resolves.
        inhibited_by: Id of a louder firing rule about the same subject, from
            :func:`find_inhibitor`. Blocks a *firing* send only.

    Returns:
        :class:`AlertDecision` carrying the state to persist.
    """
    state = RuleState.of(rule)

    if not market_is_open:
        # A closed session is not evidence that a condition cleared.
        return AlertDecision(action=ACTION_CLOSED, state=state)

    if result.error:
        # Unknown is unknown: a vendor outage must neither fabricate an alert
        # nor "resolve" one that is still true.
        return AlertDecision(
            action=ACTION_ERROR,
            state=state,
            reason=result.reason,
            error=result.error,
            bars=result.bars,
        )

    if result.hit:
        return _advance_hit(rule, state, result, now_ms, inhibited_by)

    if state.state == AlertState.FIRING:
        # The episode ends here. Repeat cooldown never applies to a resolution:
        # the gap exists to throttle a condition that stays true, and a
        # condition that stopped is the opposite of that.
        resolved_state = replace(
            state,
            state=AlertState.INACTIVE,
            pending_hits=0,
            muted_until=0,
        )
        if not rule.send_resolved:
            return AlertDecision(
                action=ACTION_NONE,
                state=resolved_state,
                value=result.value,
                bars=result.bars,
                reason="条件已解除（该规则未开启解除通知）",
            )
        seq = resolved_state.notify_seq + 1
        return AlertDecision(
            action=ACTION_NOTIFY_RESOLVED,
            state=replace(
                resolved_state, notify_seq=seq, last_notify_ms=now_ms
            ),
            incident_state=AlertState.RESOLVED,
            value=result.value,
            bars=result.bars,
            reason=result.reason or "条件已不再成立",
        )

    # Quiet, and never firing: reset the debounce counter.
    if state.state == AlertState.PENDING or state.pending_hits:
        return AlertDecision(
            action=ACTION_NONE,
            state=replace(state, state=AlertState.INACTIVE, pending_hits=0),
            value=result.value,
            bars=result.bars,
            reason=result.reason,
        )
    return AlertDecision(
        action=ACTION_NONE,
        state=state,
        value=result.value,
        bars=result.bars,
        reason=result.reason,
    )


def _human_gap(ms: int) -> str:
    """Render a millisecond gap the way a reader counts it: ``3h59m``.

    Args:
        ms: Non-negative milliseconds.

    Returns:
        A compact duration; seconds only below a minute, so a cooldown note
        never reads as "23999ms 后可再发".
    """
    total = max(0, int(ms))
    if total < 60_000:
        return f"{total // 1000}s"
    hours, remainder = divmod(total, 3_600_000)
    minutes = remainder // 60_000
    if hours:
        return f"{hours}h{minutes:02d}m" if minutes else f"{hours}h"
    return f"{minutes}m"


def _hit_reason(rule: AlertRule, result: ConditionResult) -> str:
    """Return the text stored with a hit that produced a notification.

    The evaluator only writes a reason when there is something to explain, so a
    plain hit comes back with empty text. Repeating "条件成立" in the timeline
    and in the pushed message would say nothing; spelling out the tested
    condition (``收盘 上穿 1700``) is the same fact at the reader's level.

    Args:
        rule: The rule being evaluated.
        result: Its verdict for this pass.

    Returns:
        The evaluator's note, or the described condition, or a generic fallback.
    """
    if result.reason:
        return result.reason
    try:
        return describe_condition(rule.condition)
    except Exception:  # noqa: BLE001 — a description must never break a notify
        return "条件成立"


def _advance_hit(
    rule: AlertRule,
    state: RuleState,
    result: ConditionResult,
    now_ms: int,
    inhibited_by: Optional[str],
) -> AlertDecision:
    """Handle a passing evaluation (the condition holds right now)."""
    if state.state == AlertState.FIRING:
        # Already announced. Either stay quiet or repeat after the cooldown.
        if rule.realert_ms <= 0:
            return AlertDecision(
                action=ACTION_NONE,
                state=state,
                value=result.value,
                bars=result.bars,
                reason="已在点火中，未设置重复通知",
            )
        if now_ms < state.muted_until:
            return AlertDecision(
                action=ACTION_COOLING,
                state=state,
                value=result.value,
                bars=result.bars,
                reason=f"重复通知冷却中，{_human_gap(state.muted_until - now_ms)} 后可再发",
            )
        if inhibited_by:
            return AlertDecision(
                action=ACTION_SUPPRESSED,
                state=state,
                value=result.value,
                bars=result.bars,
                reason=f"被更高级别规则 {inhibited_by} 压制",
            )
        seq = state.notify_seq + 1
        gap = cooldown_ms(rule, seq)
        return AlertDecision(
            action=ACTION_NOTIFY_FIRING,
            state=replace(
                state,
                notify_seq=seq,
                muted_until=now_ms + gap,
                last_notify_ms=now_ms,
            ),
            incident_state=AlertState.FIRING,
            value=result.value,
            bars=result.bars,
            reason=_hit_reason(rule, result),
        )

    hits = state.pending_hits + 1
    if hits < max(1, rule.for_bars):
        return AlertDecision(
            action=ACTION_PENDING,
            state=replace(state, state=AlertState.PENDING, pending_hits=hits),
            value=result.value,
            bars=result.bars,
            reason=f"条件成立 {hits}/{rule.for_bars} 次，等待确认",
        )

    # The episode becomes real regardless of whether a message goes out: the
    # timeline must show that it fired even while muted or inhibited.
    advanced = replace(
        state, state=AlertState.FIRING, pending_hits=0
    )

    if inhibited_by:
        return AlertDecision(
            action=ACTION_SUPPRESSED,
            state=advanced,
            value=result.value,
            bars=result.bars,
            reason=f"点火，但被更高级别规则 {inhibited_by} 压制，未推送",
        )
    if now_ms < state.muted_until:
        return AlertDecision(
            action=ACTION_COOLING,
            state=advanced,
            value=result.value,
            bars=result.bars,
            reason="点火，处于冷却窗口内，未推送",
        )
    seq = advanced.notify_seq + 1
    gap = cooldown_ms(rule, seq)
    return AlertDecision(
        action=ACTION_NOTIFY_FIRING,
        state=replace(
            advanced, notify_seq=seq, muted_until=now_ms + gap, last_notify_ms=now_ms
        ),
        incident_state=AlertState.FIRING,
        value=result.value,
        bars=result.bars,
        reason=_hit_reason(rule, result),
    )


def make_incident(
    rule: AlertRule,
    decision: AlertDecision,
    incident_id: str,
    at_ms: int,
) -> AlertIncident:
    """Build the incident record a notifying decision stands for.

    The delivery key is derived from the rule id and the notification sequence
    number, both of which are persisted with the rule. That is what makes a
    restart safe: a poller that comes back up and re-evaluates a still-true
    condition produces a *higher* sequence number only when it actually sends,
    and a send whose row is already ``SENT`` is refused by the outbox, so no
    ordering of crashes and retries can emit the same message twice.

    Args:
        rule: The rule that produced the decision.
        decision: A notifying decision.
        incident_id: Caller-supplied unique id.
        at_ms: Epoch-ms of the transition.

    Returns:
        An :class:`AlertIncident` with ``delivery_status`` left ``pending`` —
        pending, not sent, because at this point nothing has been accepted by a
        channel yet.
    """
    state = decision.incident_state or AlertState.FIRING
    prefix = "r" if state == AlertState.RESOLVED else "f"
    seq = decision.state.notify_seq
    return AlertIncident(
        id=incident_id,
        rule_id=rule.id,
        rule_title=rule.display_title,
        symbol=rule.symbol,
        kind=rule.kind,
        state=state,
        severity=rule.severity,
        value=decision.value,
        reason=decision.reason,
        at_ms=at_ms,
        delivery_key=f"alert:{rule.id}:{prefix}:{seq}",
    )


def decide_incident_actions(
    rules: Sequence[AlertRule],
    decisions: Dict[str, AlertDecision],
) -> List[str]:
    """Return the rule ids whose decisions carry a notification, in order.

    Split out so the caller (``service``) has one place that says "these are
    the messages this pass produces", and so a test can assert the batching
    without standing up a channel runtime.

    Args:
        rules: The rules evaluated this pass (order preserved).
        decisions: Per-rule decision keyed by rule id.

    Returns:
        Rule ids, in ``rules`` order, whose decision needs delivery.
    """
    return [rule.id for rule in rules if decisions.get(rule.id, _NOTHING).notifies]


_NOTHING = AlertDecision(action=ACTION_NONE, state=RuleState())
