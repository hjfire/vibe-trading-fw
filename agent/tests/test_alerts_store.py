"""Crash-safe persistence for alert rules and their notification history.

Covers the two documents the store owns: rules (edit-in-place) and incidents
(append-and-trim). The behaviours worth pinning are the ones whose failure mode
is silent data loss — an atomically replaced file, a corrupt document that
raises instead of reading as "no rules", and a history bound that keeps the
newest rows.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

import pytest

from src.alerts.models import AlertIncident, AlertRule, AlertState, Severity
from src.alerts.store import INCIDENTS_KEPT_PER_RULE, AlertStore, CorruptAlertStoreError


def _rule(rule_id: str = "rule-a", **overrides: Any) -> AlertRule:
    """A valid market rule."""
    defaults: Dict[str, Any] = {
        "id": rule_id,
        "symbol": "600519.SH",
        "condition": {"op": "gt", "lhs": "close", "value": 1700},
        "created_at": 1,
    }
    defaults.update(overrides)
    return AlertRule(**defaults)


def _incident(incident_id: str, rule_id: str = "rule-a", **overrides: Any) -> AlertIncident:
    """A notification row."""
    defaults: Dict[str, Any] = {
        "id": incident_id,
        "rule_id": rule_id,
        "at_ms": 1000,
        "delivery_key": f"alert:{rule_id}:f:{incident_id}",
    }
    defaults.update(overrides)
    return AlertIncident(**defaults)


@pytest.fixture
def store(tmp_path: Path) -> AlertStore:
    """A store rooted in a scratch directory."""
    return AlertStore(tmp_path / "alerts")


# ---------------------------------------------------------------------------
# Layout
# ---------------------------------------------------------------------------


def test_two_documents_are_written(tmp_path: Path) -> None:
    store = AlertStore(tmp_path / "alerts")
    store.upsert_rule(_rule())
    store.append_incident(_incident("a"))
    assert store.rules_path.exists()
    assert store.incidents_path.exists()
    assert store.rules_path.parent == store.incidents_path.parent


def test_a_file_path_is_tolerated_as_the_directory(tmp_path: Path) -> None:
    """Callers habitually pass the json file; the store owns both documents."""
    store = AlertStore(tmp_path / "alerts" / "alert_rules.json")
    store.upsert_rule(_rule())
    assert store.rules_path.exists()


def test_the_default_store_lives_under_the_runtime_root() -> None:
    """State goes to the user's runtime root, never the repository working tree."""
    from src.config.paths import get_runtime_root

    store = AlertStore()
    assert store.rules_path == get_runtime_root() / "alerts" / "alert_rules.json"


def test_nothing_saved_yet_reads_empty(store: AlertStore) -> None:
    assert store.load_rules() == {}
    assert store.list_incidents() == []
    assert store.get_rule("missing") is None


# ---------------------------------------------------------------------------
# Rules
# ---------------------------------------------------------------------------


def test_upsert_then_get_round_trips_state(store: AlertStore) -> None:
    stored = store.upsert_rule(
        _rule(state=AlertState.FIRING, fired_count=2, muted_until=99_000, severity=Severity.CRITICAL)
    )
    loaded = store.get_rule("rule-a")
    assert loaded is not None
    assert loaded.state is AlertState.FIRING
    assert loaded.fired_count == 2
    assert loaded.muted_until == 99_000
    assert loaded.severity is Severity.CRITICAL
    assert stored.updated_at >= stored.created_at


def test_editing_a_rule_keeps_its_creation_instant(store: AlertStore) -> None:
    first = store.upsert_rule(_rule(title="v1", created_at=5_000))
    second = store.upsert_rule(_rule(title="v2", created_at=9_999_999))
    assert first.created_at == 5_000
    assert second.created_at == 5_000  # not the caller's fabricated timestamp
    assert second.updated_at >= first.updated_at


def test_upsert_validates_unless_the_caller_is_persisting_state(store: AlertStore) -> None:
    with pytest.raises(ValueError):
        store.upsert_rule(_rule(for_bars=0))
    # A lifecycle write must always land, or a firing rule would re-notify on
    # every restart.
    store.upsert_rule(_rule(for_bars=0), validate=False)
    assert store.get_rule("rule-a") is not None


def test_save_rules_replaces_the_whole_set(store: AlertStore) -> None:
    store.upsert_rule(_rule("keep"))
    store.save_rules({"gone": _rule("gone")})
    assert store.get_rule("keep") is None
    assert store.get_rule("gone") is not None


def test_list_rules_filters_and_orders_newest_first(store: AlertStore) -> None:
    store.upsert_rule(_rule("old", kind="market", created_at=1, enabled=False))
    store.upsert_rule(_rule("mid", kind="position", created_at=2))
    store.upsert_rule(_rule("new", kind="market", created_at=3))

    assert [r.id for r in store.list_rules()] == ["new", "mid", "old"]
    assert [r.id for r in store.list_rules(kind="market")] == ["new", "old"]
    assert [r.id for r in store.list_rules(enabled=False)] == ["old"]
    assert [r.id for r in store.list_rules(limit=2)] == ["new", "mid"]
    # The poller walks the other direction, oldest first, so no rule starves.
    assert [r.id for r in store.enabled_rules()] == ["mid", "new"]


def test_delete_rule_keeps_the_notification_history(store: AlertStore) -> None:
    store.upsert_rule(_rule(title="茅台突破"))
    # The engine denormalizes the title onto the row, which is what lets history
    # keep explaining itself after the rule is gone.
    store.append_incident(_incident("a", rule_title="茅台突破", symbol="600519.SH"))
    assert store.delete_rule("rule-a") is True
    assert store.delete_rule("rule-a") is False
    assert store.load_rules() == {}
    rows = store.list_incidents()
    assert [row.id for row in rows] == ["a"]
    assert rows[0].rule_title == "茅台突破"
    assert rows[0].symbol == "600519.SH"


# ---------------------------------------------------------------------------
# Incidents
# ---------------------------------------------------------------------------


def test_incidents_are_returned_newest_first(store: AlertStore) -> None:
    store.append_incident(_incident("old", at_ms=1))
    store.append_incident(_incident("mid", at_ms=2))
    store.append_incident(_incident("new", at_ms=3))
    assert [row.id for row in store.list_incidents()] == ["new", "mid", "old"]
    assert [row.id for row in store.list_incidents(limit=2)] == ["new", "mid"]


def test_incident_filters(store: AlertStore) -> None:
    store.append_incident(_incident("f1", state=AlertState.FIRING, delivery_status="sent"))
    store.append_incident(_incident("r1", state=AlertState.RESOLVED, delivery_status="failed"))
    store.append_incident(_incident("f2", rule_id="other", state=AlertState.FIRING))
    assert [r.id for r in store.list_incidents(state="resolved")] == ["r1"]
    assert [r.id for r in store.list_incidents(delivery_status="failed")] == ["r1"]
    assert [r.id for r in store.list_incidents(rule_id="other")] == ["f2"]
    assert [r.id for r in store.list_incidents(rule_id="rule-a")] == ["r1", "f1"]


def test_history_is_bounded_per_rule(store: AlertStore) -> None:
    rows = [_incident(f"i{index}", at_ms=index) for index in range(INCIDENTS_KEPT_PER_RULE + 25)]
    for row in rows:
        store.append_incident(row)
    kept = store.list_incidents(limit=500)
    assert len(kept) == INCIDENTS_KEPT_PER_RULE
    # The trim drops the oldest, never the newest.
    assert kept[0].id == f"i{INCIDENTS_KEPT_PER_RULE + 24}"


def test_update_incident_patches_known_fields_only(store: AlertStore) -> None:
    store.append_incident(_incident("a"))
    updated = store.update_incident(
        "a",
        delivery_status="sent",
        provider_message_id="telegram:9",
        delivery_attempts=1,
        delivery_updated_at=2000,
        delivery_error=None,
    )
    assert updated is not None
    assert updated.delivery_status == "sent"
    assert updated.provider_message_id == "telegram:9"
    assert store.update_incident("nope", delivery_status="sent") is None

    with pytest.raises(ValueError, match="delivery fields"):
        store.update_incident("a", rule_id="hijacked")
    with pytest.raises(ValueError, match="delivery fields"):
        store.update_incident("a", at_ms=1)
    # The guard fires before any read, so a bad call cannot half-apply.
    assert store.list_incidents()[0].rule_id == "rule-a"


def test_pending_deliveries_bounds_retries(store: AlertStore) -> None:
    store.append_incident(_incident("never-sent", delivery_status="pending", at_ms=1))
    store.append_incident(
        _incident("gave-up", delivery_status="failed", delivery_attempts=6, at_ms=2)
    )
    store.append_incident(
        _incident("retriable", delivery_status="failed", delivery_attempts=2, at_ms=3)
    )
    store.append_incident(_incident("done", delivery_status="sent", at_ms=4))

    ids = [row.id for row in store.pending_deliveries()]
    assert ids == ["never-sent", "retriable"]  # oldest first
    assert [row.id for row in store.pending_deliveries(limit=1)] == ["never-sent"]
    # A tighter attempt budget drops the retried row but never a row whose send
    # has not been attempted at all.
    assert [row.id for row in store.pending_deliveries(max_attempts=1)] == ["never-sent"]


def test_clear_incidents_can_be_scoped(store: AlertStore) -> None:
    store.append_incident(_incident("a"))
    store.append_incident(_incident("b", rule_id="other"))
    assert store.clear_incidents("other") == 1
    assert [row.id for row in store.list_incidents()] == ["a"]
    assert store.clear_incidents() == 1
    assert store.list_incidents() == []


# ---------------------------------------------------------------------------
# Corruption
# ---------------------------------------------------------------------------


def _write_raw(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload), encoding="utf-8")


@pytest.mark.parametrize("payload", ["{not json", "[]", '{"schema_version": 1}'])
def test_an_unreadable_document_is_quarantined_and_raises(
    store: AlertStore, payload: Any
) -> None:
    """An empty result here would read as "the user has no alert rules"."""
    _write_raw(store.rules_path, payload)
    if isinstance(payload, str):
        store.rules_path.write_text(payload, encoding="utf-8")

    with pytest.raises(CorruptAlertStoreError) as excinfo:
        store.load_rules()
    error = excinfo.value
    assert error.original == store.rules_path
    assert error.quarantined != store.rules_path
    assert error.quarantined.exists()
    assert not store.rules_path.exists()
    # After quarantine, the store is usable again.
    assert store.load_rules() == {}


def test_a_row_with_an_unknown_state_is_corruption(store: AlertStore) -> None:
    _write_raw(store.rules_path, {"schema_version": 1, "rules": [_rule().to_dict()]})
    rows: List[Dict[str, Any]] = json.loads(store.rules_path.read_text(encoding="utf-8"))["rules"]
    rows[0]["state"] = "half_fired"
    _write_raw(store.rules_path, {"schema_version": 1, "rules": rows})

    with pytest.raises(CorruptAlertStoreError):
        store.load_rules()


def test_a_corrupt_incident_document_does_not_break_the_rules(store: AlertStore) -> None:
    store.upsert_rule(_rule())
    _write_raw(store.incidents_path, {"schema_version": 1, "incidents": [{"no_id": True}]})
    with pytest.raises(CorruptAlertStoreError):
        store.list_incidents()
    assert store.get_rule("rule-a") is not None


def test_corruption_error_reports_its_cause(store: AlertStore) -> None:
    _write_raw(store.incidents_path, {"schema_version": 1, "incidents": "not-a-list"})
    with pytest.raises(CorruptAlertStoreError) as excinfo:
        store.list_incidents()
    assert "incidents" in excinfo.value.cause


def test_a_second_quarantine_does_not_clobber_the_first(store: AlertStore) -> None:
    """Distinct timestamps, so two corrupt generations stay auditable."""
    for _ in range(2):
        _write_raw(store.rules_path, "broken")
        with pytest.raises(CorruptAlertStoreError) as excinfo:
            store.load_rules()
        assert excinfo.value.quarantined.exists()
        assert excinfo.value.quarantined.name.count("corrupt") == 1
    names = sorted(p.name for p in store.rules_path.parent.iterdir() if "corrupt" in p.name)
    assert len(set(names)) == 2


# ---------------------------------------------------------------------------
# Concurrency shape
# ---------------------------------------------------------------------------


def test_a_reentrant_lock_protects_read_modify_write(store: AlertStore) -> None:
    """``upsert`` reads then writes; the lock must be reentrant for that."""
    with store._lock:  # noqa: SLF001 — asserting the primitive the safety rests on
        assert store.get_rule("rule-a") is None


def test_written_documents_are_human_readable_json(store: AlertStore) -> None:
    store.upsert_rule(_rule(title="茅台突破"))
    payload = json.loads(store.rules_path.read_text(encoding="utf-8"))
    assert payload["schema_version"] == 1
    assert payload["rules"][0]["title"] == "茅台突破"
    assert "\\u" not in store.rules_path.read_text(encoding="utf-8")


def test_no_temp_files_survive_a_write(store: AlertStore) -> None:
    store.upsert_rule(_rule())
    store.append_incident(_incident("a"))
    leftovers = [p.name for p in store.rules_path.parent.iterdir() if p.name.startswith(".")]
    assert leftovers == []
