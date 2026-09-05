"""The alert state machine: debounce, cooldown, exponential repeat, inhibition.

Every test injects ``now_ms`` and asserts the resulting action plus the state to
persist, so a whole week of evaluations is walked in a millisecond. The
behaviours pinned here are the ones that decide whether a user's group gets one
message or forty.
"""

from __future__ import annotations

from typing import Any, Dict, List, Optional

import pytest

from src.alerts.conditions import ConditionResult
from src.alerts.engine import (
    ACTION_CLOSED,
    ACTION_COOLING,
    ACTION_ERROR,
    ACTION_NONE,
    ACTION_NOTIFY_FIRING,
    ACTION_NOTIFY_RESOLVED,
    ACTION_PENDING,
    ACTION_SUPPRESSED,
    RuleState,
    advance_rule,
    cooldown_ms,
    decide_incident_actions,
    find_inhibitor,
    make_incident,
)
from src.alerts.models import AlertRule, AlertState, Severity

HOUR = 3_600_000


def _rule(**overrides: Any) -> AlertRule:
    """A minimal market rule, overridable per test."""
    defaults: Dict[str, Any] = {
        "id": "rule-a",
        "symbol": "600519.SH",
        "condition": {"op": "gt", "lhs": "close", "value": 1700},
        "created_at": 1,
    }
    defaults.update(overrides)
    return AlertRule(**defaults)


def _hit(value: float = 1712.5, reason: str = "") -> ConditionResult:
    """A passing verdict."""
    return ConditionResult(hit=True, value=value, reason=reason, bars=4)


def _miss(value: float = 1600.0, reason: str = "") -> ConditionResult:
    """A failing verdict (a real measurement, not an outage)."""
    return ConditionResult(hit=False, value=value, reason=reason, bars=4)


def _advance(rule: AlertRule, result: ConditionResult, now_ms: int, **kwargs: Any) -> AlertRule:
    """Advance *rule* and return the stored-state copy for the next pass."""
    decision = advance_rule(rule, result, now_ms, **kwargs)
    return decision.state.apply_to(rule)


# ---------------------------------------------------------------------------
# Happy path through the states
# ---------------------------------------------------------------------------


def test_first_hit_fires_immediately_when_for_bars_is_one() -> None:
    decision = advance_rule(_rule(), _hit(), 1000)
    assert decision.action == ACTION_NOTIFY_FIRING
    assert decision.state.state is AlertState.FIRING
    assert decision.state.notify_seq == 1
    assert decision.notifies
    assert decision.incident_state is AlertState.FIRING


def test_a_hit_is_persisted_even_when_it_only_becomes_firing() -> None:
    """``apply_to`` must land the transition, not just report it."""
    rule = _rule()
    decision = advance_rule(rule, _hit(), 1000)
    stored = decision.state.apply_to(rule)
    assert stored.state is AlertState.FIRING
    assert stored.fired_count == 1
    # The input rule is never mutated, so a pass can be replayed in a test.
    assert rule.state is AlertState.INACTIVE


def test_pending_debounce_requires_consecutive_hits() -> None:
    rule = _rule(for_bars=3)
    first = advance_rule(rule, _hit(), 1000)
    assert first.action == ACTION_PENDING
    assert first.state.pending_hits == 1
    assert not first.notifies

    second = advance_rule(first.state.apply_to(rule), _hit(), 2000)
    assert second.action == ACTION_PENDING
    assert second.state.pending_hits == 2

    third = advance_rule(second.state.apply_to(rule), _hit(), 3000)
    assert third.action == ACTION_NOTIFY_FIRING
    assert third.state.state is AlertState.FIRING
    assert third.state.pending_hits == 0


def test_a_miss_mid_debounce_forgets_the_partial_hits() -> None:
    rule = _for_bars(3, hits=1)
    decision = advance_rule(rule, _miss(), 2000)
    assert decision.action == ACTION_NONE
    assert decision.state.state is AlertState.INACTIVE
    assert decision.state.pending_hits == 0


def _for_bars(for_bars: int, hits: int) -> AlertRule:
    """A rule parked mid-debounce (``hits`` consecutive passes so far)."""
    rule = _rule(for_bars=for_bars)
    return RuleState(state=AlertState.PENDING, pending_hits=hits).apply_to(rule)


def test_an_already_announced_condition_stays_quiet_without_realert() -> None:
    rule = RuleState(state=AlertState.FIRING, notify_seq=1).apply_to(_rule(realert_ms=0))
    decision = advance_rule(rule, _hit(), 10 * HOUR)
    assert decision.action == ACTION_NONE
    assert decision.notifies is False
    assert decision.state.notify_seq == 1


def test_realert_gates_repeats_and_then_allows_one_more() -> None:
    rule = _rule(realert_ms=4 * HOUR)
    fired = advance_rule(rule, _hit(), 1000)
    assert fired.action == ACTION_NOTIFY_FIRING
    live = fired.state.apply_to(rule)
    assert live.muted_until == 1000 + 4 * HOUR

    cooling = advance_rule(live, _hit(), 1000 + 2 * HOUR)
    assert cooling.action == ACTION_COOLING
    assert "2h 后可再发" in cooling.reason  # human gap, not a raw millisecond count

    repeated = advance_rule(live, _hit(), 1000 + 5 * HOUR)
    assert repeated.action == ACTION_NOTIFY_FIRING
    assert repeated.state.notify_seq == 2


def test_exponential_realert_doubles_then_clamps_at_the_ceiling() -> None:
    rule = _rule(realert_ms=4 * HOUR, exponential_realert_ms=24 * HOUR)
    assert cooldown_ms(rule, 1) == 4 * HOUR
    assert cooldown_ms(rule, 2) == 8 * HOUR
    assert cooldown_ms(rule, 3) == 16 * HOUR
    assert cooldown_ms(rule, 4) == 24 * HOUR  # clamped
    assert cooldown_ms(rule, 9) == 24 * HOUR

    # Walking the machine, the mute window actually doubles.
    live = advance_rule(rule, _hit(), 0).state.apply_to(rule)
    step_two = advance_rule(live, _hit(), 5 * HOUR)
    assert step_two.action == ACTION_NOTIFY_FIRING
    assert step_two.state.muted_until == 5 * HOUR + 8 * HOUR


def test_a_rule_without_a_ceiling_repeats_on_the_same_gap() -> None:
    rule = _rule(realert_ms=4 * HOUR)
    assert cooldown_ms(rule, 1) == 4 * HOUR
    assert cooldown_ms(rule, 5) == 4 * HOUR


# ---------------------------------------------------------------------------
# Resolution
# ---------------------------------------------------------------------------


def test_a_clearing_condition_resolves_and_notifies() -> None:
    rule = RuleState(
        state=AlertState.FIRING, notify_seq=2, muted_until=10 * HOUR, last_notify_ms=0
    ).apply_to(_rule(realert_ms=4 * HOUR))
    decision = advance_rule(rule, _miss(), HOUR)
    assert decision.action == ACTION_NOTIFY_RESOLVED
    assert decision.state.state is AlertState.INACTIVE
    assert decision.state.muted_until == 0
    assert decision.state.notify_seq == 3
    assert decision.incident_state is AlertState.RESOLVED


def test_cooldown_never_delays_a_resolution() -> None:
    """The gap throttles a condition that stays true; a cleared one is the opposite."""
    rule = RuleState(state=AlertState.FIRING, notify_seq=1, muted_until=99 * HOUR).apply_to(
        _rule(realert_ms=4 * HOUR)
    )
    decision = advance_rule(rule, _miss(), HOUR)
    assert decision.action == ACTION_NOTIFY_RESOLVED
    assert decision.notifies


def test_send_resolved_false_records_the_recovery_without_a_message() -> None:
    rule = RuleState(state=AlertState.FIRING, notify_seq=1).apply_to(
        _rule(send_resolved=False)
    )
    decision = advance_rule(rule, _miss(), HOUR)
    assert decision.action == ACTION_NONE
    assert decision.state.state is AlertState.INACTIVE
    assert decision.state.notify_seq == 1  # no send, so no sequence bump


def test_a_quiet_rule_that_stays_quiet_does_nothing() -> None:
    decision = advance_rule(_rule(), _miss(), 1000)
    assert decision.action == ACTION_NONE
    assert decision.state.state is AlertState.INACTIVE


# ---------------------------------------------------------------------------
# Unknown inputs and closed sessions
# ---------------------------------------------------------------------------


def test_a_data_error_leaves_the_state_machine_alone() -> None:
    rule = RuleState(state=AlertState.FIRING, notify_seq=1, muted_until=5 * HOUR).apply_to(_rule())
    decision = advance_rule(rule, ConditionResult(hit=False, error="行情读取失败"), 2 * HOUR)
    assert decision.action == ACTION_ERROR
    assert decision.state == RuleState.of(rule)
    assert decision.notifies is False


def test_a_closed_market_freezes_everything() -> None:
    rule = RuleState(state=AlertState.FIRING, notify_seq=1).apply_to(_rule(session_only=True))
    decision = advance_rule(rule, _miss(), HOUR, market_is_open=False)
    assert decision.action == ACTION_CLOSED
    assert decision.state.state is AlertState.FIRING
    assert decision.notifies is False


# ---------------------------------------------------------------------------
# Inhibition
# ---------------------------------------------------------------------------


def test_a_louder_firing_rule_about_the_same_symbol_suppresses_a_quieter_one() -> None:
    quiet = _rule(id="quiet", severity=Severity.WARNING)
    loud = _rule(id="loud", severity=Severity.CRITICAL)
    loud = RuleState(state=AlertState.FIRING).apply_to(loud)

    inhibitor = find_inhibitor(quiet, [loud])
    assert inhibitor is not None
    assert inhibitor.id == "loud"

    decision = advance_rule(quiet, _hit(), 1000, inhibited_by="loud")
    assert decision.action == ACTION_SUPPRESSED
    assert decision.notifies is False
    # The fact is still recorded: the rule really did fire, it just stayed quiet.
    assert decision.state.state is AlertState.FIRING


def test_inhibition_ignores_peers_other_symbols_and_the_resolved_edge() -> None:
    same = _rule(id="same", severity=Severity.WARNING)
    peer = RuleState(state=AlertState.FIRING).apply_to(_rule(id="peer", severity=Severity.WARNING))
    assert find_inhibitor(same, [peer]) is None  # equal severity does not mute

    other = RuleState(state=AlertState.FIRING).apply_to(
        _rule(id="other", symbol="BTC-USDT", severity=Severity.CRITICAL)
    )
    assert find_inhibitor(same, [other]) is None

    paused = RuleState(state=AlertState.FIRING).apply_to(
        _rule(id="paused", severity=Severity.CRITICAL, enabled=False)
    )
    assert find_inhibitor(same, [paused]) is None


def test_inbound_event_rules_are_never_inhibited() -> None:
    """The sender already made a judgement; a local heuristic must not drop it."""
    event = _rule(id="tv", kind="event", severity=Severity.INFO)
    loud = RuleState(state=AlertState.FIRING).apply_to(_rule(id="loud", severity=Severity.CRITICAL))
    assert find_inhibitor(event, [loud]) is None


# ---------------------------------------------------------------------------
# Incidents
# ---------------------------------------------------------------------------


def test_incident_carries_the_rule_context_and_an_idempotency_key() -> None:
    rule = _rule(title="茅台突破")
    decision = advance_rule(rule, _hit(), 1000)
    stored = decision.state.apply_to(rule)
    incident = make_incident(stored, decision, "alr-1", 1000)
    assert incident.delivery_key == "alert:rule-a:f:1"
    assert incident.rule_title == "茅台突破"
    assert incident.state is AlertState.FIRING
    assert incident.delivery_status == "pending"
    assert incident.severity is stored.severity


def test_the_delivery_key_distinguishes_repeat_and_recovery_sends() -> None:
    rule = _rule(realert_ms=1)
    keys: List[str] = []
    live = rule
    decision = advance_rule(live, _hit(), 1000)
    keys.append(make_incident(decision.state.apply_to(live), decision, "a", 1000).delivery_key)
    live = decision.state.apply_to(live)
    decision = advance_rule(live, _hit(), 2000)
    keys.append(make_incident(live, decision, "b", 2000).delivery_key)
    live = decision.state.apply_to(live)
    decision = advance_rule(live, _miss(), 3000)
    keys.append(make_incident(live, decision, "c", 3000).delivery_key)
    assert keys == ["alert:rule-a:f:1", "alert:rule-a:f:2", "alert:rule-a:r:3"]
    assert len(set(keys)) == 3


def test_decide_incident_actions_lists_only_the_notifying_rules() -> None:
    rules = [_rule(id="a"), _rule(id="b"), _rule(id="c")]
    decisions: Dict[str, Any] = {
        "a": advance_rule(rules[0], _hit(), 1000),
        "b": advance_rule(rules[1], _miss(), 1000),
        "c": advance_rule(_for_bars(3, 0), _hit(), 1000),
    }
    assert decide_incident_actions(rules, decisions) == ["a"]


def test_unknown_rules_count_as_no_action() -> None:
    assert decide_incident_actions([_rule(id="ghost")], {}) == []


def test_severity_rank_orders_the_ladder() -> None:
    assert Severity.CRITICAL.rank > Severity.WARNING.rank > Severity.INFO.rank


@pytest.mark.parametrize(
    "moment,expected",
    [(4 * HOUR - 1, ACTION_COOLING), (4 * HOUR, ACTION_NOTIFY_FIRING)],
)
def test_the_gap_boundary_is_inclusive_of_the_mute_horizon(
    moment: int, expected: Optional[str]
) -> None:
    """At exactly ``muted_until`` the rule may speak; one ms earlier it may not."""
    rule = RuleState(
        state=AlertState.FIRING, notify_seq=1, muted_until=4 * HOUR, last_notify_ms=0
    ).apply_to(_rule(realert_ms=4 * HOUR))
    decision = advance_rule(rule, _hit(), moment)
    assert decision.action == expected
