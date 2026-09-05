"""The service layer: what one pass does to stored rules and to the channels.

The pieces below this layer are pure (conditions, engine, store) and are tested
against fixed inputs. This file tests the wiring, where the failure modes that
matter live:

* a data outage must be counted as an error and must **not** move the state
  machine, or an expired subscription would read as "the position recovered";
* an incident is written before the send is attempted, so a rule that fires
  while every channel is down still shows up in the timeline;
* "nothing was configured to receive this" is recorded as a skip, never as a
  successful delivery;
* ``dry_run`` and ``test_send`` must leave the persisted episode untouched.

The clock is always injected: the cooldown and session gates are pure functions
of ``now_ms``, and a test that read the wall clock could pass on Tuesday and
fail on Saturday.
"""

from __future__ import annotations

import asyncio
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional, Sequence

import pytest

from src.alerts.delivery import DeliveryError
from src.alerts.inbox import InboundAlert
from src.alerts.models import AlertKind, AlertRule, AlertState, Severity
from src.alerts.service import AlertService
from src.alerts.store import AlertStore


def _ms(*args: int) -> int:
    """Epoch ms for a UTC instant, e.g. ``_ms(2026, 9, 4, 3, 0)``."""
    return int(datetime(*args, tzinfo=timezone.utc).timestamp() * 1000)


# Friday 2026-09-04 is a CN trading day; Saturday 2026-09-05 is not.
_OPEN = _ms(2026, 9, 4, 3, 0)  # 11:00 Asia/Shanghai
_CLOSED = _ms(2026, 9, 5, 3, 0)
_HOUR = 3_600_000

_RISE = [1690.0, 1695.0, 1698.0, 1712.5]  # closes across 1700 on the last bar
_FLAT = [1690.0, 1692.0, 1693.0, 1694.0]


def _make_bars(closes: Sequence[float]) -> List[Dict[str, Any]]:
    """Oldest-first OHLCV bars whose closes are *closes*."""
    return [
        {
            "timestamp": i * 86_400_000,
            "open": close,
            "high": close + 1,
            "low": close - 1,
            "close": close,
            "volume": 100.0 + i,
        }
        for i, close in enumerate(closes)
    ]


def _rule(**overrides: Any) -> AlertRule:
    """A market rule that crosses 1700 on the newest bar."""
    defaults: Dict[str, Any] = {
        "id": "moutai-breakout",
        "symbol": "600519.SH",
        "title": "茅台突破 1700",
        "condition": {"op": "crossUp", "lhs": "close", "value": 1700},
        "severity": Severity.WARNING,
        "channel": "telegram",
        "target": "-1001",
        "created_at": 1,
    }
    defaults.update(overrides)
    if defaults.get("kind") == AlertKind.EVENT and "send_resolved" not in overrides:
        # An inbound event has no "condition cleared" to announce; the store
        # refuses that combination, as does the route.
        defaults["send_resolved"] = False
    return AlertRule(**defaults)


class _Sends:
    """A stand-in for :func:`src.alerts.delivery.send_alert_text`."""

    def __init__(self, *, message_id: Optional[str] = "tg:1", error: Optional[str] = None) -> None:
        self.message_id = message_id
        self.error = error
        self.calls: List[tuple[str, str]] = []

    async def __call__(self, rule: AlertRule, text: str) -> Optional[str]:
        self.calls.append((rule.id, text))
        if self.error:
            raise DeliveryError(self.error)
        return self.message_id


@pytest.fixture
def send(monkeypatch: pytest.MonkeyPatch) -> _Sends:
    """Replace the transport with a recorder, so no test can reach a channel."""
    sender = _Sends()
    monkeypatch.setattr("src.alerts.service.send_alert_text", sender)
    return sender


def _minute() -> int:
    """One minute in epoch milliseconds, for scheduling assertions."""
    return 60_000


def _service(
    tmp_path: Any,
    *,
    closes: Sequence[float] = _RISE,
    bars_error: Optional[str] = None,
    positions: Optional[List[Dict[str, Any]]] = None,
    history: Optional[List[Dict[str, Any]]] = None,
    quote: Optional[Dict[str, Any]] = None,
) -> AlertService:
    """A service over a temp store with every data source faked."""

    def _bars(symbol: str, interval: str, count: int, adjust: str) -> List[Dict[str, Any]]:
        if bars_error:
            raise RuntimeError(bars_error)
        return _make_bars(list(closes))

    return AlertService(
        AlertStore(directory=tmp_path / "alerts"),
        bars=_bars,
        portfolio=lambda: (list(positions or []), list(history or [])),
        quote=lambda symbol: dict(quote if quote is not None else {"last": 1712.5, "change_pct": 2.31}),
    )


# ---------------------------------------------------------------------------
# Rule lifecycle
# ---------------------------------------------------------------------------


def test_an_unusable_condition_never_reaches_the_store(tmp_path: Any) -> None:
    service = _service(tmp_path)
    with pytest.raises(ValueError):
        service.save_rule(_rule(condition={"op": "no_such_operator", "lhs": "close", "value": 1}))
    assert service.list_rules() == []


def test_pausing_keeps_the_episode_so_resuming_does_not_dump_a_backlog(
    tmp_path: Any, send: Any
) -> None:
    service = _service(tmp_path)
    service.save_rule(_rule())
    asyncio.run(service.tick(now_ms=_OPEN))
    paused = service.set_enabled("moutai-breakout", False)
    assert paused is not None and paused.state is AlertState.FIRING
    # A paused rule that kept its firing state must not re-notify on resume.
    send.calls.clear()
    report = asyncio.run(service.tick(now_ms=_OPEN + 10 * _HOUR, rule_ids=["moutai-breakout"]))
    assert report.evaluated == 0
    assert len(send.calls) == 0


def test_reset_forges_the_state_but_not_the_definition(tmp_path: Any) -> None:
    service = _service(tmp_path)
    service.save_rule(_rule(realert_ms=4 * _HOUR))
    asyncio.run(service.tick(now_ms=_OPEN))
    reset = service.reset_rule("moutai-breakout")
    assert reset is not None
    assert reset.state is AlertState.INACTIVE
    assert reset.fired_count == 0
    assert reset.muted_until == 0
    # The definition survives, otherwise "reset" would mean "recreate it".
    assert reset.symbol == "600519.SH" and reset.condition["value"] == 1700


def test_deleting_a_rule_keeps_the_notifications_it_sent(tmp_path: Any, send: Any) -> None:
    service = _service(tmp_path)
    service.save_rule(_rule())
    asyncio.run(service.tick(now_ms=_OPEN))
    assert service.delete_rule("moutai-breakout") is True
    assert service.list_incidents(rule_id="moutai-breakout") != []


def test_lifecycle_calls_on_a_missing_rule_are_quiet(tmp_path: Any) -> None:
    service = _service(tmp_path)
    assert service.set_enabled("gone", False) is None
    assert service.reset_rule("gone") is None
    assert service.delete_rule("gone") is False


# ---------------------------------------------------------------------------
# One evaluation pass
# ---------------------------------------------------------------------------


def test_a_crossing_rule_fires_records_and_delivers(tmp_path: Any, send: Any) -> None:
    service = _service(tmp_path)
    service.save_rule(_rule())
    report = asyncio.run(service.tick(now_ms=_OPEN))
    assert (report.evaluated, report.fired, report.delivered) == (1, 1, 1)
    assert report.errors == 0 and report.suppressed == 0

    incident = service.list_incidents(rule_id="moutai-breakout")[0]
    assert incident.state is AlertState.FIRING
    assert incident.delivery_status == "sent"
    assert incident.provider_message_id == "tg:1"
    assert incident.reason == "收盘 上穿 1700"
    assert "茅台突破 1700" in send.calls[0][1]


def test_a_non_crossing_series_evaluates_without_firing(tmp_path: Any, send: Any) -> None:
    service = _service(tmp_path, closes=_FLAT)
    service.save_rule(_rule())
    report = asyncio.run(service.tick(now_ms=_OPEN))
    assert (report.evaluated, report.fired) == (1, 0)
    assert send.calls == []
    assert service.get_rule("moutai-breakout").state is AlertState.INACTIVE


def test_run_now_without_delivery_still_writes_a_retryable_incident(
    tmp_path: Any, send: Any
) -> None:
    """``deliver=False`` is "evaluate as if now" for the UI, not a dry run: the
    timeline should show the firing, and the send must stay owed."""
    service = _service(tmp_path)
    service.save_rule(_rule())
    report = asyncio.run(service.tick(now_ms=_OPEN, deliver=False))
    assert (report.fired, report.delivered) == (1, 0)
    assert send.calls == []
    incident = service.list_incidents(rule_id="moutai-breakout")[0]
    assert incident.delivery_status == "pending"
    # The retry sweep is what turns that pending row into a real send.
    send.message_id = "tg:2"
    assert asyncio.run(service.sweep_deliveries()) == 1


def test_a_rule_with_no_target_is_skipped_never_claimed_as_sent(
    tmp_path: Any, send: Any
) -> None:
    service = _service(tmp_path)
    service.save_rule(_rule(channel=None, target=None))
    report = asyncio.run(service.tick(now_ms=_OPEN))
    assert (report.fired, report.delivered, report.suppressed) == (1, 0, 1)
    assert send.calls == []
    incident = service.list_incidents(rule_id="moutai-breakout")[0]
    assert incident.delivery_status == "skipped"
    # The firing reason must survive: the row says both what happened and that
    # it stayed local.
    assert incident.reason == "收盘 上穿 1700"


def test_a_condition_that_stays_true_is_cooled_down(tmp_path: Any, send: Any) -> None:
    service = _service(tmp_path)
    service.save_rule(_rule(realert_ms=4 * _HOUR))
    asyncio.run(service.tick(now_ms=_OPEN))
    report = asyncio.run(
        service.tick(now_ms=_OPEN + _minute(), rule_ids=["moutai-breakout"])
    )
    assert (report.evaluated, report.fired, report.suppressed) == (1, 0, 1)
    assert len(send.calls) == 1
    rule = service.get_rule("moutai-breakout")
    assert rule.state is AlertState.FIRING and rule.fired_count == 1


def test_a_rule_that_is_not_due_is_left_alone(tmp_path: Any) -> None:
    service = _service(tmp_path)
    service.save_rule(_rule(poll_interval_ms=5 * _minute()))
    assert asyncio.run(service.tick(now_ms=_OPEN)).evaluated == 1
    assert asyncio.run(service.tick(now_ms=_OPEN + _minute())).evaluated == 0
    assert asyncio.run(service.tick(now_ms=_OPEN + 6 * _minute())).evaluated == 1


def test_an_explicit_rule_id_bypasses_the_schedule(tmp_path: Any) -> None:
    """The user asked for a measurement now, not for the poller's opinion."""
    service = _service(tmp_path)
    service.save_rule(_rule(poll_interval_ms=5 * _minute()))
    asyncio.run(service.tick(now_ms=_OPEN))
    again = asyncio.run(service.tick(now_ms=_OPEN + 1, rule_ids=["moutai-breakout"]))
    assert again.evaluated == 1


def test_event_rules_are_never_measured_by_the_poller(tmp_path: Any, send: Any) -> None:
    service = _service(tmp_path)
    service.save_rule(_rule(kind=AlertKind.EVENT, condition={}))
    assert asyncio.run(service.tick(now_ms=_OPEN)).evaluated == 0
    assert send.calls == []


def test_a_data_failure_is_an_error_and_freezes_the_state(tmp_path: Any, send: Any) -> None:
    """An expired data vendor is not a condition that cleared."""
    service = _service(tmp_path, bars_error="429 too many requests")
    service.save_rule(_rule())
    report = asyncio.run(service.tick(now_ms=_OPEN))
    assert (report.evaluated, report.fired, report.errors) == (1, 0, 1)
    assert send.calls == []
    rule = service.get_rule("moutai-breakout")
    assert rule.state is AlertState.INACTIVE
    assert "行情读取失败" in (rule.last_error or "")


def test_a_closed_session_freezes_a_session_only_rule(tmp_path: Any, send: Any) -> None:
    service = _service(tmp_path)
    service.save_rule(_rule(session_only=True))
    report = asyncio.run(service.tick(now_ms=_CLOSED))
    assert report.skipped == 1 and report.fired == 0
    assert send.calls == []
    assert service.get_rule("moutai-breakout").state is AlertState.INACTIVE


def test_the_same_rule_measures_normally_while_the_session_is_open(
    tmp_path: Any, send: Any
) -> None:
    service = _service(tmp_path)
    service.save_rule(_rule(session_only=True))
    assert asyncio.run(service.tick(now_ms=_OPEN)).fired == 1


def test_a_louder_rule_on_the_same_subject_mutes_the_quieter_one(
    tmp_path: Any, send: Any
) -> None:
    service = _service(tmp_path)
    service.save_rule(
        _rule(id="account-crash", symbol="600519.SH", severity=Severity.CRITICAL, created_at=1)
    )
    service.save_rule(_rule(id="small-wiggle", severity=Severity.WARNING, created_at=2))
    report = asyncio.run(service.tick(now_ms=_OPEN))
    assert report.fired == 1 and report.suppressed == 1
    assert [call[0] for call in send.calls] == ["account-crash"]
    # Suppressed is about the push, not the truth: the quieter rule still knows
    # its own condition holds.
    assert service.get_rule("small-wiggle").state is AlertState.FIRING


def test_a_rule_about_another_subject_is_not_muted(tmp_path: Any, send: Any) -> None:
    service = _service(tmp_path)
    service.save_rule(_rule(id="critical-moutai", severity=Severity.CRITICAL, created_at=1))
    service.save_rule(
        _rule(id="warning-byd", symbol="002594.SZ", severity=Severity.WARNING, created_at=2)
    )
    report = asyncio.run(service.tick(now_ms=_OPEN))
    assert report.fired == 2 and report.suppressed == 0
    assert len(send.calls) == 2


# ---------------------------------------------------------------------------
# Inbound events (the TradingView / Pine bridge)
# ---------------------------------------------------------------------------


def _event(**overrides: Any) -> InboundAlert:
    defaults: Dict[str, Any] = {
        "rule_id": "tv-pine",
        "symbol": "600519.SH",
        "value": 1712.5,
        "message": "收盘突破 1700",
        "at_ms": _OPEN,
        "source": "tradingview",
    }
    defaults.update(overrides)
    return InboundAlert(**defaults)


def test_an_event_rule_uses_the_senders_own_text(tmp_path: Any, send: Any) -> None:
    service = _service(tmp_path)
    service.save_rule(
        _rule(id="tv-pine", kind=AlertKind.EVENT, condition={}, title="TV  Pine")
    )
    result = asyncio.run(service.ingest_event(_event()))
    assert result["status"] == "sent"
    assert "收盘突破 1700" in send.calls[0][1]
    incident = service.list_incidents(rule_id="tv-pine")[0]
    assert incident.reason == "收盘突破 1700"


def test_an_event_with_a_condition_is_judged_by_that_condition(tmp_path: Any, send: Any) -> None:
    service = _service(tmp_path)
    service.save_rule(
        _rule(
            id="tv-pine",
            kind=AlertKind.EVENT,
            condition={"op": "gt", "lhs": "event_price", "value": 2000},
        )
    )
    result = asyncio.run(service.ingest_event(_event()))
    assert result["status"] == "none"
    assert send.calls == []
    assert service.get_rule("tv-pine").state is AlertState.INACTIVE
    # The same bridge, with a price above the level, does notify.
    assert asyncio.run(service.ingest_event(_event(value=2100.0, at_ms=_OPEN + _minute())))[
        "status"
    ] == "sent"


def test_an_event_rule_that_asks_for_bars_reports_an_error(tmp_path: Any, send: Any) -> None:
    """A webhook carries a number, not a bar series. Saying "the condition is
    false" would hide a mis-written rule behind a healthy-looking quiet one."""
    service = _service(tmp_path)
    service.save_rule(
        _rule(
            id="tv-pine",
            kind=AlertKind.EVENT,
            condition={"op": "crossUp", "lhs": "close", "value": 1700},
        )
    )
    result = asyncio.run(service.ingest_event(_event()))
    assert result["status"] == "error"
    assert result["reason"]
    assert send.calls == []


def test_an_event_for_an_unknown_rule_id_is_a_lookup_error(tmp_path: Any) -> None:
    service = _service(tmp_path)
    service.save_rule(_rule(id="some-other-rule", kind=AlertKind.EVENT, condition={}))
    with pytest.raises(LookupError):
        asyncio.run(service.ingest_event(_event()))


def test_a_market_rule_refuses_an_inbound_event(tmp_path: Any) -> None:
    """The sender aimed at the wrong rule; saying "ok" would lose the alert."""
    service = _service(tmp_path)
    service.save_rule(_rule(id="tv-pine"))
    with pytest.raises(ValueError, match="not an event rule"):
        asyncio.run(service.ingest_event(_event()))


def test_a_paused_event_rule_refuses_the_event(tmp_path: Any) -> None:
    service = _service(tmp_path)
    service.save_rule(_rule(id="tv-pine", kind=AlertKind.EVENT, condition={}, enabled=False))
    with pytest.raises(ValueError, match="paused"):
        asyncio.run(service.ingest_event(_event()))


def test_two_identical_events_produce_one_notification(tmp_path: Any, send: Any) -> None:
    service = _service(tmp_path)
    service.save_rule(
        _rule(id="tv-pine", kind=AlertKind.EVENT, condition={}, realert_ms=4 * _HOUR)
    )
    first = asyncio.run(service.ingest_event(_event()))
    second = asyncio.run(service.ingest_event(_event(at_ms=_OPEN + _minute())))
    assert first["status"] == "sent"
    assert "incident_id" not in second
    assert len(send.calls) == 1
    assert len(service.list_incidents(rule_id="tv-pine")) == 1


def test_recording_an_event_without_pushing_it_is_a_valid_choice(
    tmp_path: Any, send: Any
) -> None:
    service = _service(tmp_path)
    service.save_rule(_rule(id="tv-pine", kind=AlertKind.EVENT, condition={}))
    result = asyncio.run(service.ingest_event(_event(), deliver=False))
    assert result["status"] == "recorded"
    assert send.calls == []
    assert service.get_rule("tv-pine").state is AlertState.FIRING


# ---------------------------------------------------------------------------
# Delivery bookkeeping
# ---------------------------------------------------------------------------


def test_a_rule_that_already_sent_is_not_sent_again(tmp_path: Any, send: Any) -> None:
    service = _service(tmp_path)
    rule = _rule()
    service.save_rule(rule)
    asyncio.run(service.tick(now_ms=_OPEN))
    incident = service.list_incidents(rule_id="moutai-breakout")[0]
    assert incident.delivery_status == "sent"
    again = asyncio.run(service.deliver_incident(rule, incident, now_ms=_OPEN + _minute()))
    assert again.delivery_status == "sent"
    assert len(send.calls) == 1


def test_a_failed_send_keeps_the_diagnostic_and_stays_retryable(
    tmp_path: Any, send: Any
) -> None:
    service = _service(tmp_path)
    send.error = "chat not found"
    service.save_rule(_rule())
    asyncio.run(service.tick(now_ms=_OPEN))
    incident = service.list_incidents(rule_id="moutai-breakout")[0]
    assert incident.delivery_status == "failed"
    assert incident.delivery_attempts == 1
    assert "chat not found" in (incident.delivery_error or "")

    # The channel comes back; the sweep owes the user that message.
    send.error = None
    send.message_id = "tg:9"
    assert asyncio.run(service.sweep_deliveries()) == 1
    fresh = service.list_incidents(rule_id="moutai-breakout")[0]
    assert fresh.delivery_status == "sent" and fresh.provider_message_id == "tg:9"
    assert fresh.delivery_error is None


def test_a_sweep_gives_up_after_the_attempt_ceiling(tmp_path: Any, send: Any) -> None:
    """A revoked token is not transient; retrying it forever starves the rows
    behind it."""
    from src.alerts.delivery import MAX_DELIVERY_ATTEMPTS

    service = _service(tmp_path)
    send.error = "token revoked"
    service.save_rule(_rule())
    asyncio.run(service.tick(now_ms=_OPEN))
    for _ in range(MAX_DELIVERY_ATTEMPTS - 1):
        asyncio.run(service.sweep_deliveries())
    incident = service.list_incidents(rule_id="moutai-breakout")[0]
    assert incident.delivery_attempts == MAX_DELIVERY_ATTEMPTS
    assert service.store.pending_deliveries(max_attempts=MAX_DELIVERY_ATTEMPTS) == []
    # One more sweep changes nothing: the row is no longer retryable.
    assert asyncio.run(service.sweep_deliveries()) == 0
    assert len(send.calls) == MAX_DELIVERY_ATTEMPTS


def test_an_orphaned_incident_fails_with_a_reason_instead_of_hanging(
    tmp_path: Any, send: Any
) -> None:
    service = _service(tmp_path)
    service.save_rule(_rule())
    asyncio.run(service.tick(now_ms=_OPEN, deliver=False))
    service.delete_rule("moutai-breakout")
    assert asyncio.run(service.sweep_deliveries()) == 0
    incident = service.list_incidents(rule_id="moutai-breakout")[0]
    assert incident.delivery_status == "failed"
    assert "规则已删除" in (incident.delivery_error or "")


# ---------------------------------------------------------------------------
# Test send and dry run
# ---------------------------------------------------------------------------


def test_a_test_send_pushes_without_touching_the_episode(tmp_path: Any, send: Any) -> None:
    service = _service(tmp_path, closes=_FLAT)
    service.save_rule(_rule())
    result = asyncio.run(service.test_send("moutai-breakout"))
    assert result["status"] == "sent" and result["addresses"] == 1
    rule = service.get_rule("moutai-breakout")
    assert rule.state is AlertState.INACTIVE
    assert rule.fired_count == 0
    assert service.list_incidents(rule_id="moutai-breakout") == []
    assert "测试推送" in send.calls[0][1]


def test_a_test_send_says_why_it_couldnt_send(tmp_path: Any, send: Any) -> None:
    service = _service(tmp_path)
    service.save_rule(_rule(channel=None, target=None))
    result = asyncio.run(service.test_send("moutai-breakout"))
    assert result["status"] == "no_target" and result["addresses"] == 0
    assert send.calls == []


def test_a_test_send_reports_a_channel_failure(tmp_path: Any, send: Any) -> None:
    service = _service(tmp_path)
    send.error = "bot was kicked from the group chat"
    service.save_rule(_rule())
    result = asyncio.run(service.test_send("moutai-breakout"))
    assert result["status"] == "failed"
    assert "kicked" in result["error"]


def test_a_test_send_of_a_missing_rule_is_a_lookup_error(tmp_path: Any) -> None:
    service = _service(tmp_path)
    with pytest.raises(LookupError):
        asyncio.run(service.test_send("gone"))


def test_a_dry_run_leaves_the_store_exactly_as_it_found_it(tmp_path: Any, send: Any) -> None:
    service = _service(tmp_path)
    service.save_rule(_rule())
    result = asyncio.run(service.dry_run("moutai-breakout", now_ms=_CLOSED))
    assert result["hit"] is True and result["would_notify"] is True
    assert result["reason"] == "收盘 上穿 1700"
    # A market rule that never opted into the session gate is not frozen by a
    # weekend, so a dry run must not imply it is.
    assert result["market_open"] is True
    assert send.calls == []
    assert service.list_incidents() == []
    rule = service.get_rule("moutai-breakout")
    assert rule.state is AlertState.INACTIVE and rule.last_checked_at is None


def test_a_dry_run_names_a_cooldown_instead_of_calling_it_a_miss(
    tmp_path: Any, send: Any
) -> None:
    service = _service(tmp_path)
    service.save_rule(_rule(realert_ms=4 * _HOUR))
    asyncio.run(service.tick(now_ms=_OPEN))
    result = asyncio.run(service.dry_run("moutai-breakout", now_ms=_OPEN + _minute()))
    assert result["hit"] is True  # the condition still holds
    assert result["would_notify"] is False
    assert result["action"] == "cooling"
    assert "后可再发" in result["note"]


def test_a_dry_run_reports_a_missing_data_source_as_an_error(tmp_path: Any) -> None:
    service = _service(tmp_path, bars_error="network down")
    service.save_rule(_rule())
    result = asyncio.run(service.dry_run("moutai-breakout", now_ms=_OPEN))
    assert result["hit"] is False and result["error"]
    assert result["action"] == "error"


def test_a_dry_run_tells_a_session_rule_it_is_frozen(tmp_path: Any) -> None:
    service = _service(tmp_path)
    service.save_rule(_rule(session_only=True))
    result = asyncio.run(service.dry_run("moutai-breakout", now_ms=_CLOSED))
    assert result["market_open"] is False
    assert result["would_notify"] is False
    assert result["hit"] is True  # the bars still crossed; only the gate stopped it


def test_a_dry_run_of_a_missing_rule_is_a_lookup_error(tmp_path: Any) -> None:
    service = _service(tmp_path)
    with pytest.raises(LookupError):
        asyncio.run(service.dry_run("gone"))


# ---------------------------------------------------------------------------
# Position rules read the stored snapshot, never a broker call
# ---------------------------------------------------------------------------


def test_a_position_rule_uses_the_injected_holdings(tmp_path: Any, send: Any) -> None:
    service = _service(
        tmp_path,
        positions=[
            {
                "symbol": "600519.SH",
                "name": "贵州茅台",
                "quantity": 100,
                "cost_price": 1800.0,
                "market_price": 1620.0,
            }
        ],
    )
    service.save_rule(
        _rule(
            id="loss-trip",
            kind=AlertKind.POSITION,
            condition={"op": "lt", "lhs": "pnl_pct", "value": -5},
            title="浮亏超过 5%",
        )
    )
    report = asyncio.run(service.tick(now_ms=_OPEN))
    assert report.errors == 0
    assert report.fired == 1
    assert "浮亏超过 5%" in send.calls[0][1]
    # -10% is what the numbers say, and the message states the value.
    assert "-10" in send.calls[0][1]
