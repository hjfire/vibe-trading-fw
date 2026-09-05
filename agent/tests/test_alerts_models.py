"""Rule/incident models, duration parsing, and what the validators refuse.

The validators are the only thing standing between a typo in a rule and a
background loop that spams a group chat or never speaks again, so the refusals
are as important as the acceptances.
"""

from __future__ import annotations

from typing import Any, Dict

import pytest

from src.alerts.models import (
    AlertIncident,
    AlertKind,
    AlertRule,
    AlertState,
    Severity,
    parse_duration_ms,
    validate_condition,
    validate_rule,
    validate_rule_id,
)


def _rule(**overrides: Any) -> AlertRule:
    """A valid market rule, overridable per test."""
    defaults: Dict[str, Any] = {
        "id": "moutai-breakout",
        "symbol": "600519.SH",
        "condition": {"op": "crossUp", "lhs": "close", "value": 1700},
        "targets": ["research-group"],
        "created_at": 1,
    }
    defaults.update(overrides)
    return AlertRule(**defaults)


# ---------------------------------------------------------------------------
# Durations
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "value,expected",
    [
        (None, 0),
        (0, 0),
        (30, 30),
        (30.9, 30),
        ("30", 30),
        ("250ms", 250),
        ("90s", 90_000),
        ("30m", 1_800_000),
        ("4h", 14_400_000),
        ("1d", 86_400_000),
        (" 4 H ", 14_400_000),
    ],
)
def test_parse_duration_ms_accepts_the_documented_shapes(value: Any, expected: int) -> None:
    assert parse_duration_ms(value) == expected


@pytest.mark.parametrize("value", [-1, "4x", "soon", "", "h", True, [1]])
def test_parse_duration_ms_refuses_nonsense(value: Any) -> None:
    with pytest.raises(ValueError):
        parse_duration_ms(value)


def test_parse_duration_ms_names_the_offending_field() -> None:
    with pytest.raises(ValueError, match="realert"):
        parse_duration_ms("nope", field_name="realert")


# ---------------------------------------------------------------------------
# Ids and conditions
# ---------------------------------------------------------------------------


def test_rule_ids_are_limited_to_url_safe_grammar() -> None:
    validate_rule_id("a")
    validate_rule_id("tv-pine_01")
    for bad in ("", "a b", "../etc", "id;rm", "x" * 129, "600519.SH", None):
        with pytest.raises(ValueError):
            validate_rule_id(bad)  # type: ignore[arg-type]


def test_validate_condition_accepts_every_operator() -> None:
    from src.alerts.models import CONDITION_OPS

    for op in CONDITION_OPS:
        condition: Dict[str, Any] = {"op": op, "lhs": "close"}
        if op in ("gt", "lt", "crossUp", "crossDown"):
            condition["value"] = 1
        validate_condition(condition)


def test_validate_condition_refuses_mismatched_operands() -> None:
    with pytest.raises(ValueError, match="rhs or value"):
        validate_condition({"op": "gt", "lhs": "close"})
    with pytest.raises(ValueError, match="does not take"):
        validate_condition({"op": "rising", "lhs": "close", "value": 1})
    with pytest.raises(ValueError, match="not supported"):
        validate_condition({"op": "equals", "lhs": "close", "value": 1})
    with pytest.raises(ValueError, match="lhs"):
        validate_condition({"op": "gt", "lhs": "  ", "value": 1})
    with pytest.raises(ValueError, match="number"):
        validate_condition({"op": "gt", "lhs": "close", "value": "1700"})
    with pytest.raises(ValueError, match="number"):
        validate_condition({"op": "gt", "lhs": "close", "value": True})
    with pytest.raises(ValueError, match="series name"):
        validate_condition({"op": "gt", "lhs": "close", "rhs": "  "})
    with pytest.raises(ValueError, match="object"):
        validate_condition("close > 1700")  # type: ignore[arg-type]


# ---------------------------------------------------------------------------
# Rules
# ---------------------------------------------------------------------------


def test_a_well_formed_rule_validates() -> None:
    validate_rule(_rule())


def test_market_and_position_rules_need_a_subject() -> None:
    with pytest.raises(ValueError, match="symbol"):
        validate_rule(_rule(symbol="  "))
    with pytest.raises(ValueError, match="symbol"):
        validate_rule(_rule(kind="position", symbol=""))
    validate_rule(_rule(kind="account", symbol=""))  # an account has no subject


def test_an_event_rule_need_not_carry_a_condition() -> None:
    """The sender's own alert is the trigger; there is nothing to re-test."""
    validate_rule(
        _rule(kind="event", condition={}, symbol="", send_resolved=False)
    )


def test_a_non_event_rule_must_have_a_testable_condition() -> None:
    with pytest.raises(ValueError):
        validate_rule(_rule(condition={}))


def test_an_event_rule_cannot_promise_a_resolution_notice() -> None:
    with pytest.raises(ValueError, match="resolution"):
        validate_rule(_rule(kind="event", condition={}, send_resolved=True))


@pytest.mark.parametrize(
    "overrides",
    [
        {"for_bars": 0},
        {"for_bars": 1001},
        {"realert_ms": -1},
        {"realert_ms": 14_400_000, "exponential_realert_ms": 3_600_000},
        {"poll_interval_ms": 999},
        {"count": 1},
        {"count": 2001},
    ],
)
def test_runaway_or_broken_settings_are_refused(overrides: Dict[str, Any]) -> None:
    with pytest.raises(ValueError):
        validate_rule(_rule(**overrides))


def test_an_unknown_kind_cannot_be_constructed() -> None:
    """A kind this build does not know must not be silently read as "market"."""
    with pytest.raises(ValueError):
        AlertRule(id="x", kind="nonsense")  # type: ignore[arg-type]


def test_a_delivery_target_ref_must_look_like_a_ref() -> None:
    validate_rule(_rule(targets=["research-group", "ops_room"]))
    for bad in ("telegram:1234", "has space", ""):
        with pytest.raises(ValueError, match="ref"):
            validate_rule(_rule(targets=[bad]))


def test_channel_and_target_come_as_a_pair() -> None:
    with pytest.raises(ValueError, match="target"):
        validate_rule(_rule(channel="telegram", target=None))
    with pytest.raises(ValueError, match="channel"):
        validate_rule(_rule(channel=None, target="123"))
    validate_rule(_rule(channel="telegram", target="123"))


def test_symbol_and_title_are_normalized_and_history_is_counted() -> None:
    rule = AlertRule(id="r", symbol=" 600519.sh ", title="  茅台  ")
    assert rule.symbol == "600519.SH"
    assert rule.title == "茅台"
    assert rule.kind is AlertKind.MARKET
    assert rule.state is AlertState.INACTIVE
    assert rule.created_at > 0 and rule.updated_at == rule.created_at


def test_display_title_falls_back_to_the_subject() -> None:
    assert _rule(title="").display_title == "600519.SH 1D"
    assert _rule(title="茅台突破").display_title == "茅台突破"


def test_rule_round_trips_through_json() -> None:
    rule = _rule(
        kind="position",
        severity=Severity.CRITICAL,
        realert_ms=14_400_000,
        exponential_realert_ms=86_400_000,
        session_only=True,
        send_resolved=False,
        webhook_secret_hash="abc123",
        state=AlertState.FIRING,
        fired_count=3,
        muted_until=99,
        last_notify_ms=98,
        last_value=1712.5,
        last_reason="收盘 上穿 1700",
        last_error=None,
        last_checked_at=97,
    )
    restored = AlertRule.from_dict(rule.to_dict())
    assert restored.to_dict() == rule.to_dict()
    assert restored.state is AlertState.FIRING
    assert restored.kind is AlertKind.POSITION


def test_unknown_enum_values_are_refused_rather_than_guessed() -> None:
    """Guessing a state wrong can spam a channel or silently mute one."""
    with pytest.raises(ValueError):
        AlertRule.from_dict({**_rule().to_dict(), "state": "half_fired"})
    with pytest.raises(ValueError):
        AlertRule.from_dict({**_rule().to_dict(), "severity": "apocalyptic"})
    with pytest.raises(TypeError):
        AlertRule.from_dict({**_rule().to_dict(), "for_bars": "3"})
    with pytest.raises(TypeError):
        AlertRule.from_dict({**_rule().to_dict(), "targets": "research-group"})
    with pytest.raises(TypeError):
        AlertRule.from_dict("not an object")  # type: ignore[arg-type]


def test_incident_round_trips_and_defends_its_types() -> None:
    incident = AlertIncident(
        id="alr-1",
        rule_id="moutai-breakout",
        rule_title="茅台突破",
        symbol="600519.SH",
        kind=AlertKind.MARKET,
        state=AlertState.RESOLVED,
        severity=Severity.INFO,
        value=1712.5,
        reason="收盘 下穿 1700",
        at_ms=1000,
        delivery_key="alert:moutai-breakout:r:1",
        delivery_status="sent",
        provider_message_id="telegram:42",
        delivery_updated_at=1001,
    )
    assert AlertIncident.from_dict(incident.to_dict()).to_dict() == incident.to_dict()

    with pytest.raises(ValueError):
        AlertIncident.from_dict({**incident.to_dict(), "state": "exploded"})
    with pytest.raises(TypeError):
        AlertIncident.from_dict({**incident.to_dict(), "id": ""})
    with pytest.raises(TypeError):
        AlertIncident.from_dict({**incident.to_dict(), "delivery_attempts": -1})
    with pytest.raises(TypeError):
        AlertIncident.from_dict({**incident.to_dict(), "value": "1712.5"})
