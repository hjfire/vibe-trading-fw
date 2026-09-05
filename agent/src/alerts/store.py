"""Crash-safe persistence for alert rules and their notification history.

Same atomic-write discipline as :mod:`src.scheduled_research.store`: write a
temp file in the target directory, ``fsync``, ``os.replace``, ``fsync`` the
parent directory. A ``SIGKILL`` at any point leaves either the old complete
document or the new one, never a partial write.

Rules and incidents live in two documents on purpose. An incident row is
appended every time a rule speaks and is trimmed to a bounded history, while a
rule document only changes when someone edits a rule or its state machine
advances. Keeping them apart means a notification burst can never put a rule
definition at risk, and deleting a rule does not silently erase the audit trail
of what it already said.

A missing file is the only clean empty result. A file that exists but fails to
parse is quarantined (renamed aside) and raises :class:`CorruptAlertStoreError`
rather than returning an empty list — an empty list here would look exactly
like "the user has no alert rules", and the poller would then quietly stop
watching everything.
"""

from __future__ import annotations

import json
import logging
import os
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Optional

from src.alerts.models import AlertIncident, AlertRule, validate_rule
from src.config.paths import get_runtime_root

logger = logging.getLogger(__name__)

_RULES_FILENAME = "alert_rules.json"
_INCIDENTS_FILENAME = "alert_incidents.json"
_SCHEMA_VERSION = 1

#: Incident rows kept per rule. Enough for a week of five-minute cooldowns
#: without the history document growing without bound.
INCIDENTS_KEPT_PER_RULE = 200


def _default_dir() -> Path:
    """Return the directory alert state is rooted in.

    Under the user runtime root (``~/.vibe-trading`` by default), never inside
    the repository working tree — the same root the scheduled-research and live
    runtime stores resolve to.
    """
    return get_runtime_root() / "alerts"


class CorruptAlertStoreError(RuntimeError):
    """Raised when a store document exists but cannot be parsed.

    Attributes:
        original: Path that failed to parse.
        quarantined: Path the corrupt file was moved to.
        cause: Short description of the parse failure.
    """

    def __init__(self, original: Path, quarantined: Path, cause: str) -> None:
        super().__init__(
            f"alert store {original} is corrupt ({cause}); quarantined to {quarantined}"
        )
        self.original = original
        self.quarantined = quarantined
        self.cause = cause


class AlertStore:
    """Durable storage for alert rules and incidents.

    The store owns serialization and atomic I/O only. No scheduling, no
    evaluation, no delivery — those are the engine's and the service's jobs.

    Attributes:
        rules_path: Absolute path of the rule document.
        incidents_path: Absolute path of the incident document.
    """

    def __init__(self, directory: Optional[Path] = None) -> None:
        """Initialize the store.

        Args:
            directory: Explicit directory. Defaults to
                ``<runtime root>/alerts``.
        """
        root = Path(directory) if directory is not None else _default_dir()
        if root.suffix == ".json":  # tolerate a caller passing the file itself
            root = root.parent
        self._dir = root
        self.rules_path = root / _RULES_FILENAME
        self.incidents_path = root / _INCIDENTS_FILENAME
        # The API runs on an event loop while evaluations run in a worker
        # thread; a read-modify-write from two of those would otherwise lose a
        # rule edit or drop an incident row.
        self._lock = threading.RLock()

    # ------------------------------------------------------------------
    # Rules
    # ------------------------------------------------------------------

    def load_rules(self) -> Dict[str, AlertRule]:
        """Load every persisted rule.

        Returns:
            A dict mapping rule id to rule; empty when nothing was ever saved.

        Raises:
            CorruptAlertStoreError: When the document exists but cannot be read.
        """
        return self._load_rules_unlocked()

    def save_rules(self, rules: Dict[str, AlertRule]) -> None:
        """Atomically replace the full rule set.

        Args:
            rules: Mapping of rule id to rule (the whole set, not a delta).

        Raises:
            OSError: When the directory or write fails.
        """
        with self._lock:
            self._write(self.rules_path, "rules", [r.to_dict() for r in rules.values()])

    def upsert_rule(self, rule: AlertRule, *, validate: bool = True) -> AlertRule:
        """Insert or replace one rule by id.

        Args:
            rule: The rule to store.
            validate: When ``False``, skip :func:`validate_rule`. The engine
                sets this while persisting a state-machine advance for a rule
                that is already on disk: a lifecycle write must always land,
                otherwise a rule stuck in ``firing`` would be re-evaluated (and
                could re-notify) on every restart.

        Returns:
            The stored rule (a copy of *rule* with ``updated_at`` stamped).

        Raises:
            ValueError: When validation is on and the rule is not storeable.
            CorruptAlertStoreError: When the existing document cannot be parsed.
        """
        if validate:
            validate_rule(rule)
        with self._lock:
            stored = AlertRule(**{**rule.to_dict(), "updated_at": _now_ms()})
            rules = self._load_rules_unlocked()
            # Keep the original creation instant across edits.
            existing = rules.get(stored.id)
            if existing is not None:
                stored.created_at = existing.created_at
            rules[stored.id] = stored
            self._write(self.rules_path, "rules", [r.to_dict() for r in rules.values()])
        return stored

    def get_rule(self, rule_id: str) -> Optional[AlertRule]:
        """Return one rule by id, or ``None``."""
        with self._lock:
            return self._load_rules_unlocked().get(rule_id)

    def list_rules(
        self,
        *,
        kind: Optional[str] = None,
        enabled: Optional[bool] = None,
        limit: int = 200,
    ) -> List[AlertRule]:
        """Return rules, newest first.

        Args:
            kind: When set, keep only rules of that kind (``"market"`` ...).
            enabled: When set, keep only rules matching the pause flag.
            limit: Maximum rows returned.

        Returns:
            At most *limit* rules, ordered by creation time descending.
        """
        with self._lock:
            rows = list(self._load_rules_unlocked().values())
        if kind is not None:
            rows = [r for r in rows if r.kind.value == kind]
        if enabled is not None:
            rows = [r for r in rows if bool(r.enabled) is enabled]
        rows.sort(key=lambda r: (r.created_at, r.id), reverse=True)
        return rows[: max(0, limit)]

    def delete_rule(self, rule_id: str) -> bool:
        """Remove a rule; its incident history is deliberately kept.

        Args:
            rule_id: Rule to remove.

        Returns:
            ``True`` when a rule was found and removed.
        """
        with self._lock:
            rules = self._load_rules_unlocked()
            if rule_id not in rules:
                return False
            del rules[rule_id]
            self._write(self.rules_path, "rules", [r.to_dict() for r in rules.values()])
        return True

    def enabled_rules(self) -> List[AlertRule]:
        """Return the rules the poller should evaluate, oldest-created first."""
        with self._lock:
            rows = [r for r in self._load_rules_unlocked().values() if r.enabled]
        rows.sort(key=lambda r: (r.created_at, r.id))
        return rows

    # ------------------------------------------------------------------
    # Incidents
    # ------------------------------------------------------------------

    def append_incident(self, incident: AlertIncident) -> AlertIncident:
        """Add one incident row, trimming each rule's history to a bound.

        Args:
            incident: The row to store.

        Returns:
            The stored incident.

        Raises:
            CorruptAlertStoreError: When the existing document cannot be parsed.
        """
        with self._lock:
            rows = self._load_incidents_unlocked()
            rows.append(incident)
            rows.sort(key=lambda i: (i.at_ms, i.id))
            trimmed = _trim_per_rule(rows, INCIDENTS_KEPT_PER_RULE)
            self._write(
                self.incidents_path, "incidents", [i.to_dict() for i in trimmed]
            )
        return incident

    def update_incident(
        self, incident_id: str, **fields: object
    ) -> Optional[AlertIncident]:
        """Patch one incident row (delivery outcome, error, attempts).

        Args:
            incident_id: Row to update.
            **fields: Known :class:`AlertIncident` attributes to overwrite.

        Returns:
            The updated row, or ``None`` when no row has that id.

        Raises:
            ValueError: When a field is not an incident attribute.
        """
        allowed = {
            "delivery_status",
            "delivery_error",
            "delivery_attempts",
            "provider_message_id",
            "delivery_updated_at",
            "reason",
            "value",
        }
        unknown = set(fields) - allowed
        if unknown:
            raise ValueError(f"not incident delivery fields: {sorted(unknown)}")
        with self._lock:
            rows = self._load_incidents_unlocked()
            target: Optional[AlertIncident] = None
            for row in rows:
                if row.id == incident_id:
                    for key, value in fields.items():
                        setattr(row, key, value)
                    target = row
                    break
            if target is None:
                return None
            self._write(self.incidents_path, "incidents", [i.to_dict() for i in rows])
        return target

    def list_incidents(
        self,
        *,
        rule_id: Optional[str] = None,
        state: Optional[str] = None,
        delivery_status: Optional[str] = None,
        limit: int = 50,
    ) -> List[AlertIncident]:
        """Return incident rows, newest first.

        Args:
            rule_id: When set, keep only that rule's rows.
            state: When set, keep only rows in that state (``firing`` /
                ``resolved``).
            delivery_status: When set, filter on ``pending`` / ``sent`` /
                ``failed``.
            limit: Maximum rows returned.

        Returns:
            At most *limit* rows, newest first.
        """
        with self._lock:
            rows = self._load_incidents_unlocked()
        if rule_id is not None:
            rows = [r for r in rows if r.rule_id == rule_id]
        if state is not None:
            rows = [r for r in rows if r.state.value == state]
        if delivery_status is not None:
            rows = [r for r in rows if r.delivery_status == delivery_status]
        rows.sort(key=lambda i: (i.at_ms, i.id), reverse=True)
        return rows[: max(0, limit)]

    def pending_deliveries(
        self, limit: int = 20, max_attempts: int = 6
    ) -> List[AlertIncident]:
        """Return incidents whose send is still retryable, oldest first.

        An outage is transient, so a failed send stays retryable. *max_attempts*
        bounds it: a row that has been tried that many times has a problem a
        sweep cannot fix (a revoked token, a deleted group), and retrying it
        forever would starve the newer rows behind it.

        Args:
            limit: Maximum rows returned.
            max_attempts: Give up at this many tried sends.

        Returns:
            At most *limit* incidents, oldest first.
        """
        rows = self.list_incidents(delivery_status="pending", limit=limit * 4)
        rows += [
            row
            for row in self.list_incidents(delivery_status="failed", limit=limit * 4)
            if row.delivery_attempts < max_attempts
        ]
        rows.sort(key=lambda i: (i.at_ms, i.id))
        return rows[:limit]

    def clear_incidents(self, rule_id: Optional[str] = None) -> int:
        """Drop incident history, optionally for one rule only.

        Args:
            rule_id: When set, only that rule's rows go away.

        Returns:
            How many rows were removed.
        """
        with self._lock:
            rows = self._load_incidents_unlocked()
            keep = [r for r in rows if rule_id is not None and r.rule_id != rule_id]
            removed = len(rows) - len(keep)
            if removed:
                self._write(self.incidents_path, "incidents", [i.to_dict() for i in keep])
        return removed

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _load_rules_unlocked(self) -> Dict[str, AlertRule]:
        items = self._read(self.rules_path, "rules")
        result: Dict[str, AlertRule] = {}
        try:
            for item in items:
                rule = AlertRule.from_dict(item)
                result[rule.id] = rule
        except (TypeError, ValueError) as exc:
            # A row this build cannot understand is just as corrupt as a
            # truncated file: returning the subset that did parse would look
            # like "the user's other rules never existed".
            raise self._corrupt(self.rules_path, exc, "rules") from exc
        return result

    def _load_incidents_unlocked(self) -> List[AlertIncident]:
        rows = self._read(self.incidents_path, "incidents")
        try:
            return [AlertIncident.from_dict(row) for row in rows]
        except (TypeError, ValueError) as exc:
            raise self._corrupt(self.incidents_path, exc, "incidents") from exc

    def _read(self, path: Path, key: str) -> List[dict]:
        if not path.exists():
            return []
        try:
            envelope = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise self._corrupt(path, exc, key) from exc
        if not isinstance(envelope, dict):
            raise self._corrupt(path, ValueError("root is not a JSON object"), key)
        rows = envelope.get(key)
        if not isinstance(rows, list):
            raise self._corrupt(path, ValueError(f"'{key}' is missing or not a list"), key)
        if not all(isinstance(row, dict) for row in rows):
            raise self._corrupt(path, ValueError(f"'{key}' holds a non-object row"), key)
        try:
            _validate_rows_shape(rows)
        except (TypeError, ValueError) as exc:
            raise self._corrupt(path, exc, key) from exc
        return rows

    def _write(self, path: Path, key: str, rows: List[dict]) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        payload = json.dumps(
            {"schema_version": _SCHEMA_VERSION, key: rows},
            ensure_ascii=False,
            indent=2,
        )
        tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
        fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        try:
            os.write(fd, payload.encode("utf-8"))
            os.fsync(fd)
        finally:
            os.close(fd)
        os.replace(tmp, path)
        _fsync_dir(path.parent)

    def _corrupt(self, path: Path, exc: Exception, key: str) -> CorruptAlertStoreError:
        cause = f"{key}: {exc}"
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        quarantined = path.with_name(f"{path.name}.corrupt-{stamp}")
        try:
            os.replace(path, quarantined)
            logger.error(
                "alert store %s corrupt (%s) — quarantined to %s", path, cause, quarantined
            )
        except OSError:
            logger.error(
                "alert store %s corrupt (%s) — quarantine rename failed",
                path,
                cause,
                exc_info=True,
            )
            quarantined = path
        return CorruptAlertStoreError(path, quarantined, cause)


def _validate_rows_shape(rows: List[dict]) -> None:
    """Cheap structural check so a truncated file fails here, not mid-parse."""
    for row in rows:
        if not isinstance(row.get("id"), str) or not row["id"]:
            raise ValueError("a row is missing its 'id'")


def _trim_per_rule(
    rows: List[AlertIncident], kept: int
) -> List[AlertIncident]:
    """Keep the newest *kept* rows per rule id.

    Args:
        rows: Incident rows in ascending time order.
        kept: Rows to retain for each rule.

    Returns:
        The retained rows, still ascending.
    """
    counts: Dict[str, int] = {}
    result: List[AlertIncident] = []
    for row in reversed(rows):
        seen = counts.get(row.rule_id, 0)
        if seen >= kept:
            continue
        counts[row.rule_id] = seen + 1
        result.append(row)
    result.reverse()
    return result


def _fsync_dir(directory: Path) -> None:
    try:
        dir_fd = os.open(directory, os.O_RDONLY)
    except OSError:
        return
    try:
        os.fsync(dir_fd)
    except OSError:
        logger.debug("parent-dir fsync unsupported on %s", directory, exc_info=True)
    finally:
        os.close(dir_fd)


def _now_ms() -> int:
    """Epoch milliseconds now (the one place this module reads a clock)."""
    return int(datetime.now(timezone.utc).timestamp() * 1000)
