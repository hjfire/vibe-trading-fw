"""Route-level contracts for ``/alerts``.

Three things are only visible at this layer, so they are tested here rather than
in the engine tests:

* **Status codes as an API contract** — 422 for an unbuildable rule, 404 for a
  missing one, 409 for a paused webhook target, 202 for an accepted event.
* **What the wire is allowed to expose.** The stored webhook secret is a hash,
  the plaintext appears exactly once (at creation), ``webhook_secret_hash`` is
  never serialized, and an id that exists only to deduplicate sends
  (``delivery_key``) stays server-side.
* **The webhook's trust model.** It is deliberately *not* behind bearer auth,
  because its caller is TradingView's alert dispatcher; the shared secret is the
  only gate. A test pins that the gate holds while the API key is configured,
  and that a market rule and an unknown rule answer the same 404 so the route
  cannot be used to enumerate ids.

The service singleton is redirected onto a temp store, so nothing here touches
the real runtime root, and every data source is faked — a route test must not
depend on a quote feed.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, Dict, List, Optional

import pytest
from fastapi.testclient import TestClient

import api_server
from src.alerts.service import AlertService
from src.alerts.store import AlertStore
from src.api import alerts_routes

_BARS = [
    {"timestamp": i * 86_400_000, "open": c, "high": c + 1, "low": c - 1, "close": c, "volume": 100.0}
    for i, c in enumerate([1690.0, 1695.0, 1698.0, 1712.5])
]

_MARKET_BODY: Dict[str, Any] = {
    "id": "moutai-breakout",
    "kind": "market",
    "title": "茅台突破 1700",
    "symbol": "600519.SH",
    "condition": {"op": "crossUp", "lhs": "close", "value": 1700},
    "channel": "telegram",
    "target": "-1001",
}


def _bars_fetcher(symbol: str, interval: str, count: int, adjust: str) -> List[Dict[str, Any]]:
    return list(_BARS)


@pytest.fixture
def service(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> AlertService:
    """Point the module singleton at a temp store with faked data sources."""
    svc = AlertService(
        AlertStore(directory=tmp_path / "alerts"),
        bars=_bars_fetcher,
        portfolio=lambda: ([], []),
        quote=lambda symbol: {"last": 1712.5, "change_pct": 2.31},
    )
    monkeypatch.setattr(alerts_routes, "_alert_service", svc)
    monkeypatch.setattr(alerts_routes, "_alert_store", svc.store)
    return svc


@pytest.fixture
def client(service: AlertService, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """A loopback caller with no API key configured."""
    monkeypatch.delenv("API_AUTH_KEY", raising=False)
    monkeypatch.setattr(api_server, "_API_KEY", "")
    return TestClient(api_server.app, client=("127.0.0.1", 50000))


@pytest.fixture
def authed_client(service: AlertService, monkeypatch: pytest.MonkeyPatch) -> TestClient:
    """The same app with a bearer key required, as a deployed server has one."""
    monkeypatch.delenv("API_AUTH_KEY", raising=False)
    monkeypatch.setattr(api_server, "_API_KEY", "s3cret-key")
    return TestClient(api_server.app, client=("127.0.0.1", 50000))


def _create(client: TestClient, headers: Optional[Dict[str, str]] = None, **overrides: Any) -> Dict[str, Any]:
    body = dict(_MARKET_BODY)
    body.update(overrides)
    response = client.post("/alerts/rules", json=body, headers=headers or {})
    assert response.status_code == 201, response.text
    return response.json()


# ---------------------------------------------------------------------------
# Rule CRUD
# ---------------------------------------------------------------------------


def test_an_empty_setup_lists_no_rules(client: TestClient) -> None:
    response = client.get("/alerts/rules")
    assert response.status_code == 200
    assert response.json() == []


def test_creating_a_rule_returns_the_live_state_fields(client: TestClient) -> None:
    payload = _create(client, realert="4h", poll_interval="15m")
    assert payload["id"] == "moutai-breakout"
    assert payload["state"] == "inactive"
    assert payload["realert_ms"] == 14_400_000
    assert payload["poll_interval_ms"] == 900_000
    # A market rule has no inbound secret, and the raw hash never crosses the wire.
    assert payload["webhook_configured"] is False
    assert payload["webhook_url"] is None
    assert "webhook_secret_hash" not in payload


def test_an_unknown_operator_is_refused_before_it_is_stored(client: TestClient) -> None:
    response = client.post(
        "/alerts/rules",
        json={**_MARKET_BODY, "condition": {"op": "nope", "lhs": "close", "value": 1}},
    )
    assert response.status_code == 422
    assert client.get("/alerts/rules").json() == []


def test_an_id_that_could_escape_a_path_is_refused(client: TestClient) -> None:
    for bad in ("..%2Fescape", "has space", "a" * 129):
        response = client.post("/alerts/rules", json={**_MARKET_BODY, "id": bad})
        assert response.status_code == 422, bad


def test_an_unsupported_interval_is_refused(client: TestClient) -> None:
    response = client.post("/alerts/rules", json={**_MARKET_BODY, "interval": "7m"})
    assert response.status_code == 422


def test_reading_a_missing_rule_is_a_404_not_an_empty_body(client: TestClient) -> None:
    assert client.get("/alerts/rules/gone").status_code == 404


def test_listing_filters_by_kind_and_enabled(client: TestClient) -> None:
    _create(client)
    _create(client, id="tv-rule", kind="event", condition=None, send_resolved=False)
    assert [r["id"] for r in client.get("/alerts/rules", params={"kind": "event"}).json()] == [
        "tv-rule"
    ]
    assert [r["id"] for r in client.get("/alerts/rules", params={"enabled": "false"}).json()] == []
    client.post("/alerts/rules/moutai-breakout/enabled", params={"enabled": "false"})
    assert [r["id"] for r in client.get("/alerts/rules", params={"enabled": "false"}).json()] == [
        "moutai-breakout"
    ]


def test_an_update_keeps_the_state_the_engine_already_computed(
    client: TestClient, service: AlertService
) -> None:
    """Editing a label must not reset an episode, or the rule would re-notify."""
    _create(client)
    assert client.post("/alerts/run", params={"deliver": "false"}).json()["fired"] == 1
    assert client.get("/alerts/rules/moutai-breakout").json()["state"] == "firing"

    updated = client.put(
        "/alerts/rules/moutai-breakout",
        json={**_MARKET_BODY, "title": "改个名字而已"},
    ).json()
    assert updated["title"] == "改个名字而已"
    assert updated["state"] == "firing"
    assert updated["fired_count"] == 1


def test_a_client_cannot_author_live_state(client: TestClient) -> None:
    """A PUT body has no state fields; a rule must not be able to claim it has
    already fired by editing itself."""
    _create(client)
    body = {**_MARKET_BODY, "state": "inactive", "fired_count": 99}
    response = client.put("/alerts/rules/moutai-breakout", json=body)
    assert response.status_code == 201 or response.status_code == 200
    payload = client.get("/alerts/rules/moutai-breakout").json()
    assert payload["state"] == "inactive"  # the stored value, not a forged one


def test_an_update_whose_body_id_disagrees_with_the_path_is_refused(
    client: TestClient,
) -> None:
    _create(client)
    response = client.put("/alerts/rules/moutai-breakout", json={**_MARKET_BODY, "id": "other"})
    assert response.status_code == 422


def test_an_update_of_a_missing_rule_is_a_404(client: TestClient) -> None:
    response = client.put("/alerts/rules/gone", json={**_MARKET_BODY, "id": "gone"})
    assert response.status_code == 404


def test_deleting_keeps_the_history_and_the_second_delete_is_a_404(
    client: TestClient, service: AlertService
) -> None:
    _create(client)
    client.post("/alerts/run", params={"deliver": "false"})
    assert client.delete("/alerts/rules/moutai-breakout").status_code == 200
    assert client.get("/alerts/rules/moutai-breakout").status_code == 404
    assert client.delete("/alerts/rules/moutai-breakout").status_code == 404
    rows = client.get("/alerts/incidents", params={"rule_id": "moutai-breakout"}).json()
    assert len(rows) == 1 and rows[0]["rule_title"] == "茅台突破 1700"


def test_pause_and_resume_round_trip(client: TestClient) -> None:
    _create(client)
    assert client.post("/alerts/rules/moutai-breakout/enabled", params={"enabled": "false"}).json()[
        "enabled"
    ] is False
    assert client.post("/alerts/rules/moutai-breakout/enabled", params={"enabled": "true"}).json()[
        "enabled"
    ] is True
    assert client.post("/alerts/rules/gone/enabled", params={"enabled": "true"}).status_code == 404
    # ``enabled`` is required, so omitting it is a client bug, not a toggle.
    assert client.post("/alerts/rules/moutai-breakout/enabled").status_code == 422


def test_reset_clears_the_episode_but_keeps_the_rule(client: TestClient) -> None:
    _create(client, realert="4h")
    client.post("/alerts/run", params={"deliver": "false"})
    payload = client.post("/alerts/rules/moutai-breakout/reset").json()
    assert payload["state"] == "inactive"
    assert payload["fired_count"] == 0
    assert payload["condition"]["value"] == 1700
    assert client.post("/alerts/rules/gone/reset").status_code == 404


# ---------------------------------------------------------------------------
# Evaluate / probe
# ---------------------------------------------------------------------------


def test_run_now_does_not_push_by_default(client: TestClient) -> None:
    _create(client)
    report = client.post("/alerts/run").json()
    assert report["status"] == "ok"
    assert (report["evaluated"], report["fired"]) == (1, 1)
    assert report["delivered"] == 0
    row = client.get("/alerts/incidents").json()[0]
    # Nothing was sent, so nothing may claim it was: the row stays owed, and the
    # retry sweep is what eventually delivers it.
    assert row["delivery_status"] == "pending"
    # The idempotency key is internal to the outbox.
    assert "delivery_key" not in row


def test_run_with_delivery_reports_what_the_channels_answered(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _create(client)

    async def _fake_send(rule: Any, text: str) -> str:
        return "telegram:77"

    monkeypatch.setattr("src.alerts.service.send_alert_text", _fake_send)
    report = client.post("/alerts/run", params={"deliver": "true"}).json()
    assert (report["fired"], report["delivered"]) == (1, 1)
    row = client.get("/alerts/incidents").json()[0]
    assert row["delivery_status"] == "sent" and row["provider_message_id"] == "telegram:77"


def test_run_can_be_restricted_to_one_rule(client: TestClient) -> None:
    _create(client)
    _create(client, id="second", condition={"op": "gt", "lhs": "close", "value": 100})
    assert client.post("/alerts/run", params={"rule_id": "second"}).json()["evaluated"] == 1
    # A well-formed id that simply has no rule is not an error to the poller.
    assert client.post("/alerts/run", params={"rule_id": "unknown-rule"}).json()["evaluated"] == 0
    assert client.post("/alerts/run", params={"rule_id": "bad id"}).status_code == 422


def test_dry_run_answers_without_changing_anything(client: TestClient) -> None:
    _create(client)
    result = client.post("/alerts/rules/moutai-breakout/dry-run").json()
    assert result["hit"] is True and result["would_notify"] is True
    assert result["reason"] == "收盘 上穿 1700"
    assert client.get("/alerts/rules/moutai-breakout").json()["state"] == "inactive"
    assert client.get("/alerts/incidents").json() == []


def test_dry_run_of_a_missing_rule_is_a_404(client: TestClient) -> None:
    assert client.post("/alerts/rules/gone/dry-run").status_code == 404


def test_test_send_states_why_it_could_not_push(client: TestClient) -> None:
    _create(client, channel=None, target=None)
    result = client.post("/alerts/rules/moutai-breakout/test-send").json()
    assert result["status"] == "no_target" and result["addresses"] == 0
    assert client.post("/alerts/rules/gone/test-send").status_code == 404


def test_a_rule_pointed_at_a_missing_target_ref_is_refused_at_the_wire(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A renamed delivery group must fail the create, not the first fire."""
    monkeypatch.setattr("src.channels.targets.list_delivery_targets", lambda: [])
    response = client.post("/alerts/rules", json={**_MARKET_BODY, "targets": ["gone-group"]})
    assert response.status_code == 422


def test_targets_reports_refs_without_raw_chat_ids(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    class _Target:
        ref = "research-group"
        label = "研究群"
        channel = "telegram"
        target = "-100123456"

    monkeypatch.setattr("src.channels.targets.list_delivery_targets", lambda: [_Target()])
    payload = client.get("/alerts/targets").json()
    assert payload["targets"] == [
        {"ref": "research-group", "label": "研究群", "channel": "telegram"}
    ]
    assert "-100123456" not in str(payload)


# ---------------------------------------------------------------------------
# The inbound webhook
# ---------------------------------------------------------------------------


def _event_rule(
    client: TestClient, headers: Optional[Dict[str, str]] = None, **overrides: Any
) -> Dict[str, Any]:
    body = {
        "id": "tv-pine",
        "kind": "event",
        "title": "TV 报警",
        "symbol": "600519.SH",
        "condition": None,
    }
    body.update(overrides)
    response = client.post("/alerts/rules", json=body, headers=headers or {})
    assert response.status_code == 201, response.text
    return response.json()


def test_creating_an_event_rule_hands_out_the_secret_once(client: TestClient) -> None:
    payload = _event_rule(client)
    secret = payload["webhook_secret"]
    assert len(secret) >= 8
    assert payload["webhook_url"] == f"/alerts/webhook/tv-pine?key={secret}"
    assert payload["webhook_configured"] is True
    # A later read cannot recover it, hashed or otherwise.
    later = client.get("/alerts/rules/tv-pine").json()
    assert "webhook_secret" not in later
    assert later["webhook_configured"] is True
    assert secret not in str(later)


def test_an_event_rule_never_promises_a_resolution_notice(client: TestClient) -> None:
    assert _event_rule(client)["send_resolved"] is False
    response = client.post(
        "/alerts/rules",
        json={"id": "tv2", "kind": "event", "condition": None, "send_resolved": True},
    )
    assert response.status_code == 422


def test_a_client_supplied_secret_is_the_one_that_works(client: TestClient) -> None:
    payload = _event_rule(client, webhook_secret="my-own-secret")
    assert "webhook_secret" not in payload  # nothing to hand back; it was theirs
    accepted = client.post("/alerts/webhook/tv-pine?key=my-own-secret", json={"price": 1712.5})
    assert accepted.status_code == 202


@pytest.mark.parametrize("bad", ["short", "has space", "punct!!!"])
def test_a_weak_or_malformed_secret_is_refused(client: TestClient, bad: str) -> None:
    response = client.post(
        "/alerts/rules",
        json={"id": "tv-pine", "kind": "event", "condition": None, "webhook_secret": bad},
    )
    assert response.status_code == 422


def test_an_event_arrives_and_reaches_the_timeline(client: TestClient) -> None:
    secret = _event_rule(client)["webhook_secret"]
    response = client.post(
        f"/alerts/webhook/tv-pine?key={secret}",
        json={"ticker": "SSE:600519", "price": 1712.5, "message": "收盘突破 1700"},
    )
    assert response.status_code == 202
    payload = response.json()
    # The webhook took it; the push is a separate answer, and this rule has no
    # target, so it must say so instead of going quiet.
    assert payload["status"] == "accepted"
    assert payload["delivery"] == "skipped"
    row = client.get("/alerts/incidents").json()[0]
    assert row["reason"] == "收盘突破 1700"
    assert row["kind"] == "event"
    assert client.get("/alerts/rules/tv-pine").json()["state"] == "firing"


def test_a_key_can_travel_inside_the_alert_body(client: TestClient) -> None:
    """A TradingView template only substitutes variables into the message text."""
    secret = _event_rule(client)["webhook_secret"]
    response = client.post(
        "/alerts/webhook/tv-pine",
        json={"key": secret, "price": 1712.5, "message": "突破"},
    )
    assert response.status_code == 202


def test_a_key_can_travel_in_a_header(client: TestClient) -> None:
    secret = _event_rule(client)["webhook_secret"]
    response = client.post(
        "/alerts/webhook/tv-pine",
        json={"price": 1.0},
        headers={"x-alert-key": secret},
    )
    assert response.status_code == 202


@pytest.mark.parametrize(
    "kwargs",
    [
        {"params": {"key": "wrong-wrong"}},
        {},
    ],
)
def test_a_bad_or_missing_key_is_not_authorized(client: TestClient, kwargs: Dict[str, Any]) -> None:
    _event_rule(client)
    assert client.post("/alerts/webhook/tv-pine", json={"price": 1.0}, **kwargs).status_code == 401


def test_the_webhook_does_not_require_the_bearer_key(authed_client: TestClient) -> None:
    """The whole point of this route: TradingView has no bearer token."""
    key = {"Authorization": "Bearer s3cret-key"}
    secret = _event_rule(authed_client, headers=key)["webhook_secret"]
    assert (
        authed_client.post(f"/alerts/webhook/tv-pine?key={secret}", json={"price": 1.0}).status_code
        == 202
    )
    # ... while every other route in this module does.
    assert authed_client.get("/alerts/rules").status_code == 401
    assert authed_client.get("/alerts/rules", headers=key).status_code == 200


def test_an_unknown_rule_and_a_non_event_rule_answer_identically(client: TestClient) -> None:
    _create(client)  # a market rule
    for rule_id in ("gone", "moutai-breakout"):
        response = client.post(f"/alerts/webhook/{rule_id}?key=abcdefgh", json={"price": 1.0})
        assert response.status_code == 404
        assert response.json()["detail"] == "alert rule not found"


def test_a_paused_event_rule_tells_the_sender_so(client: TestClient) -> None:
    secret = _event_rule(client)["webhook_secret"]
    client.post("/alerts/rules/tv-pine/enabled", params={"enabled": "false"})
    response = client.post(f"/alerts/webhook/tv-pine?key={secret}", json={"price": 1.0})
    assert response.status_code == 409


def test_a_plain_text_body_is_still_an_event(client: TestClient) -> None:
    secret = _event_rule(client)["webhook_secret"]
    response = client.post(
        "/alerts/webhook/tv-pine",
        content="my drawing got touched",
        headers={"content-type": "text/plain", "x-alert-key": secret},
    )
    assert response.status_code == 202
    assert client.get("/alerts/rules/tv-pine").json()["state"] == "firing"


def test_an_oversized_payload_is_answered_422_not_500(client: TestClient) -> None:
    secret = _event_rule(client)["webhook_secret"]
    response = client.post(
        "/alerts/webhook/tv-pine",
        json={"price": ["not", "a", "number"] * 40, "message": {"deep": [1, 2]}},
        params={"key": secret},
    )
    assert response.status_code in (202, 422)
