"""Alert rule HTTP routes.

Mounted by ``agent/api_server.py`` via ``register_alerts_routes(app, ...)``.

Two auth postures live in this file, and the difference is deliberate.

Everything under ``/alerts/rules``, ``/alerts/incidents``, ``/alerts/targets``
and ``/alerts/run`` sits behind the API's bearer auth, like every other route.

``POST /alerts/webhook/{rule_id}`` cannot: TradingView posts it from a server
that has no way to present our token. Its credential is the per-rule secret,
which the store holds only as a SHA-256 hash and which is compared in constant
time. A rule with no secret configured is unreachable through this route — the
absence of a hash is not a wildcard.
"""

from __future__ import annotations

import logging
import re
import secrets
import sys as _sys
import time
from typing import TYPE_CHECKING, Any, Awaitable, Callable, Dict, List, Optional

from fastapi import Depends, FastAPI, HTTPException, Query, Request, status
from pydantic import BaseModel, Field
from starlette.responses import JSONResponse

from src.alerts.models import (
    CONDITION_OPS,
    AlertKind,
    AlertRule,
    Severity,
    parse_duration_ms,
    validate_rule,
    validate_rule_id,
)
from src.alerts.store import AlertStore
from src.config.accessor import get_env_config

if TYPE_CHECKING:
    from src.alerts.service import AlertService

logger = logging.getLogger(__name__)

#: Mirrors the alert layer's id grammar; kept in sync with the store so a rule
#: can never be created under an id the delete route refuses.
_SAFE_RULE_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,128}$")

_INTERVALS = ("1m", "5m", "15m", "30m", "60m", "1D")
_ADJUSTS = ("none", "qfq", "hfq")

_alert_store: Any = None
_alert_service: Any = None
_alert_poller: Any = None


# ---------------------------------------------------------------------------
# Singletons and lifecycle
# ---------------------------------------------------------------------------


def _alerts_enabled() -> bool:
    """Return whether alert polling runs, following the scheduler switch.

    Alerting is part of "the background scheduler is on". Reading it through the
    config layer (never ``os.getenv``) is what keeps the CI environment gate
    satisfied and the flag in one place.
    """
    return get_env_config().agent_tuning.vibe_trading_enable_scheduler


def _get_alert_store() -> AlertStore:
    """Return the singleton rule/incident store, creating it on first call."""
    global _alert_store
    if _alert_store is None:
        _alert_store = AlertStore()
    return _alert_store


def get_alert_service() -> "AlertService":
    """Return the singleton :class:`~src.alerts.service.AlertService`."""
    global _alert_service
    if _alert_service is None:
        from src.alerts.service import AlertService

        _alert_service = AlertService(_get_alert_store())
    return _alert_service


def _get_alert_poller() -> Any:
    """Return the singleton poller, creating it on first call."""
    global _alert_poller
    if _alert_poller is None:
        from src.alerts.poller import AlertPoller

        _alert_poller = AlertPoller(get_alert_service(), enabled=_alerts_enabled())
    return _alert_poller


def _start_alert_poller() -> None:
    """Start alert evaluation when the scheduler is enabled.

    A failure here must not take the API server down — the routes still work and
    the rules are simply not evaluated until something starts the loop.
    """
    if not _alerts_enabled():
        return
    try:
        _get_alert_poller().start()
    except Exception:  # noqa: BLE001 — startup must not fail over a background task
        logger.exception("alert poller failed to start; alerting is idle")


async def _stop_alert_poller() -> None:
    """Stop the poller if it was ever created.

    Shutdown must not fail over a background loop that is already on its way
    out, so a raise from :meth:`AlertPoller.stop` is logged and swallowed.
    """
    poller = _alert_poller
    if poller is None:
        return
    try:
        await poller.stop()
    except Exception:  # noqa: BLE001 — shutdown is best effort
        logger.exception("alert poller did not stop cleanly")


def _wake_poller() -> None:
    """Nudge the poller so a just-created rule is measured without waiting a tick."""
    poller = _alert_poller
    if poller is not None:
        try:
            poller.wake()
        except Exception:  # pragma: no cover — advisory only
            logger.debug("could not wake the alert poller", exc_info=True)


# ---------------------------------------------------------------------------
# Request / response models
# ---------------------------------------------------------------------------


class ConditionModel(BaseModel):
    """The condition a rule tests, in the screener's operator grammar.

    ``lhs`` and ``rhs`` are series names (``close``, ``rsi:14``, ``sma:20``,
    ``pnl_pct``, ``drawdown_pct``, ``event_value``). ``value`` is a constant and
    is an alternative to ``rhs`` — a constant behaves like a series whose
    previous value equals its last, which is what makes ``crossUp`` against a
    fixed level mean "the newest bar crossed it".
    """

    op: str = Field(..., description=f"One of: {', '.join(CONDITION_OPS)}")
    lhs: str = Field(..., min_length=1, description="Series to test")
    rhs: Optional[str] = Field(None, description="Another series to compare against")
    value: Optional[float] = Field(None, description="A constant to compare against")


class AlertRuleRequest(BaseModel):
    """Request body for creating or replacing an alert rule."""

    id: str = Field(
        ...,
        min_length=1,
        description="Rule id: letters, digits, '_' and '-', 1-128 characters",
    )
    kind: str = Field("market", description="market | position | account | event")
    title: Optional[str] = Field(None, description="Label used in pushed messages")
    symbol: Optional[str] = Field(None, description="Canonical symbol, e.g. 600519.SH")
    interval: str = Field("1D", description="Bar interval: " + ", ".join(_INTERVALS))
    count: int = Field(320, ge=2, le=2000, description="Bars pulled per evaluation")
    adjust: str = Field("qfq", description="none | qfq | hfq (daily bars)")
    condition: Optional[ConditionModel] = None
    for_bars: int = Field(1, ge=1, le=1000, description="Consecutive hits before firing")
    realert: Optional[str] = Field(
        None, description="Repeat gap for a condition that stays true, e.g. '4h'"
    )
    exponential_realert: Optional[str] = Field(
        None, description="Ceiling for the doubling repeat gap, e.g. '24h'"
    )
    severity: str = Field("warning", description="info | warning | critical")
    send_resolved: bool = Field(
        True, description="Also push the recovery notice (always false for event rules)"
    )
    session_only: bool = Field(
        False, description="Evaluate only while the subject's market is open"
    )
    poll_interval: Optional[str] = Field(
        None, description="How often to measure this rule, e.g. '5m' (default 5m)"
    )
    targets: List[str] = Field(
        default_factory=list,
        description="Opaque delivery-target refs (preferred over raw chat ids)",
    )
    channel: Optional[str] = Field(None, description="Channel id for an inline target")
    target: Optional[str] = Field(None, description="Address within that channel")
    webhook_secret: Optional[str] = Field(
        None,
        description=(
            "Shared secret an inbound webhook must present (event rules). Omit "
            "to have one generated; the value is returned once and stored only "
            "as a hash."
        ),
    )
    enabled: bool = True


class AlertRuleResponse(BaseModel):
    """One rule as the API reports it, definition and live state together."""

    id: str
    kind: str
    title: str = ""
    symbol: str = ""
    interval: str
    count: int
    adjust: str
    condition: Dict[str, Any] = Field(default_factory=dict)
    for_bars: int
    realert_ms: int
    exponential_realert_ms: int
    severity: str
    send_resolved: bool
    session_only: bool
    poll_interval_ms: int
    targets: List[str] = Field(default_factory=list)
    channel: Optional[str] = None
    target: Optional[str] = None
    enabled: bool
    state: str
    pending_hits: int
    fired_count: int
    last_value: Optional[float] = None
    last_reason: str = ""
    last_error: Optional[str] = None
    last_checked_at: Optional[int] = None
    last_notify_ms: Optional[int] = None
    muted_until: int = 0
    created_at: int
    updated_at: int
    webhook_configured: bool = False
    webhook_url: Optional[str] = None


class AlertIncidentResponse(BaseModel):
    """One notification row: what fired, when, and whether it got through."""

    id: str
    rule_id: str
    rule_title: str = ""
    symbol: str = ""
    kind: str
    state: str
    severity: str
    value: Optional[float] = None
    reason: str = ""
    at_ms: int
    delivery_status: str
    delivery_error: Optional[str] = None
    delivery_attempts: int = 0
    provider_message_id: Optional[str] = None
    delivery_updated_at: Optional[int] = None


def _rule_to_response(
    rule: AlertRule, *, webhook_url: Optional[str] = None
) -> AlertRuleResponse:
    """Flatten a rule for the wire.

    ``webhook_url`` is filled in only when the caller already knows the secret
    (immediately after creating it); otherwise the URL is omitted and only
    ``webhook_configured`` says a secret exists. The stored hash is never
    exported, so a reader of this response cannot derive the URL.
    """
    return AlertRuleResponse(
        **{
            k: v
            for k, v in rule.to_dict().items()
            if k not in ("webhook_secret_hash", "state", "targets", "condition")
        },
        condition=dict(rule.condition),
        targets=list(rule.targets),
        state=rule.state.value,
        webhook_configured=bool(rule.webhook_secret_hash),
        webhook_url=webhook_url,
    )


def _build_rule(
    request: AlertRuleRequest, existing: Optional[AlertRule]
) -> tuple[AlertRule, Optional[str]]:
    """Turn a request into a rule object.

    Args:
        request: The validated request body.
        existing: The rule being replaced, when this is an update. Carried so an
            omitted secret keeps the hash that was already handed out, and so a
            creation timestamp survives an edit.

    Returns:
        A ``(rule, generated_secret)`` tuple. ``generated_secret`` is the
        plaintext webhook secret handed to the caller, or ``None`` when the rule
        was not given a new one — it is never recoverable afterwards.

    Raises:
        ValueError: When a duration string, interval, adjust mode, or kind is not
            one the engine supports.
    """
    kind = AlertKind(request.kind)
    condition = request.condition.model_dump() if request.condition else {}
    if request.interval not in _INTERVALS:
        raise ValueError(f"interval {request.interval!r} is not supported")
    if request.adjust not in _ADJUSTS:
        raise ValueError(f"adjust {request.adjust!r} is not supported")

    # An event has no "back to normal" edge, so resolution notices are off for it
    # by default. Only an explicit ``send_resolved: true`` is refused (by
    # validation) — a client that never mentioned the field is not at fault.
    send_resolved = request.send_resolved
    if kind == AlertKind.EVENT and "send_resolved" not in request.model_fields_set:
        send_resolved = False

    secret_hash = existing.webhook_secret_hash if existing else None
    generated: Optional[str] = None
    if kind == AlertKind.EVENT:
        if request.webhook_secret:
            from src.alerts.inbox import SECRET_RE, secret_sha256

            if not SECRET_RE.fullmatch(request.webhook_secret):
                raise ValueError(
                    "webhook_secret must be 8-128 characters of letters, digits, "
                    "'_' or '-'"
                )
            secret_hash = secret_sha256(request.webhook_secret)
        elif secret_hash is None:
            from src.alerts.inbox import secret_sha256

            generated = secrets.token_urlsafe(24).rstrip("_-")
            secret_hash = secret_sha256(generated)

    rule = AlertRule(
        id=request.id,
        kind=kind,
        title=request.title or "",
        symbol=request.symbol or "",
        interval=request.interval,
        count=request.count,
        adjust=request.adjust,
        condition=condition,
        for_bars=request.for_bars,
        realert_ms=parse_duration_ms(request.realert, field_name="realert"),
        exponential_realert_ms=parse_duration_ms(
            request.exponential_realert, field_name="exponential_realert"
        ),
        severity=Severity(request.severity),
        send_resolved=send_resolved,
        session_only=request.session_only,
        targets=list(request.targets),
        channel=request.channel,
        target=request.target,
        webhook_secret_hash=secret_hash,
        enabled=request.enabled,
        poll_interval_ms=parse_duration_ms(request.poll_interval, field_name="poll_interval")
        or 300_000,
        created_at=existing.created_at if existing else 0,
        updated_at=int(time.time() * 1000),
    )
    # ``AlertState`` and the notify counters are not authorable from the wire:
    # an edit must not be able to fake a rule into "already firing".
    if existing is not None:
        rule.state = existing.state
        rule.pending_hits = existing.pending_hits
        rule.fired_count = existing.fired_count
        rule.muted_until = existing.muted_until
        rule.last_notify_ms = existing.last_notify_ms
        rule.last_value = existing.last_value
        rule.last_reason = existing.last_reason
        rule.last_error = existing.last_error
        rule.last_checked_at = existing.last_checked_at

    if rule.targets:
        # Resolve the opaque refs now, at the keystroke. A rule aimed at a renamed
        # group would otherwise fail only when it fires, which is the worst time
        # to learn the notification was never going to arrive.
        from src.alerts.delivery import resolve_addresses

        try:
            resolve_addresses(rule)
        except ValueError as exc:
            raise ValueError(f"推送目标不可用：{exc}") from exc

    return rule, generated


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------

AuthDep = Callable[..., Awaitable[Any] | Any]


def register_alerts_routes(
    app: FastAPI,
    require_auth: AuthDep | None = None,
) -> None:
    """Mount the alerting routes onto ``app``.

    Resolves ``require_auth`` from the host ``api_server`` module when not passed
    explicitly, matching the other ``register_*_routes`` modules.
    """
    host = _sys.modules.get("api_server") or _sys.modules.get("agent.api_server")
    if host is None:
        raise RuntimeError(
            "register_alerts_routes: api_server module not in sys.modules; ensure "
            "api_server is imported before calling this function"
        )
    if require_auth is None:
        require_auth = host.require_auth

    def _service() -> "AlertService":
        return get_alert_service()

    def _checked_id(rule_id: str) -> str:
        try:
            validate_rule_id(rule_id)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        return rule_id

    def _store_rule(rule: AlertRule) -> AlertRule:
        try:
            validate_rule(rule)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        try:
            return _service().save_rule(rule)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    # --- rules ---

    @app.get("/alerts/rules", response_model=List[AlertRuleResponse], dependencies=[Depends(require_auth)])
    async def list_alert_rules(
        kind: Optional[str] = Query(None, description="Filter by rule kind"),
        enabled: Optional[bool] = Query(None, description="Filter by pause flag"),
        limit: int = Query(200, ge=1, le=500),
    ) -> List[AlertRuleResponse]:
        """List alert rules, newest first."""
        rows = _service().list_rules(kind=kind, enabled=enabled, limit=limit)
        return [_rule_to_response(rule) for rule in rows]

    @app.post(
        "/alerts/rules",
        response_model=AlertRuleResponse,
        status_code=status.HTTP_201_CREATED,
        dependencies=[Depends(require_auth)],
    )
    async def create_alert_rule(request: AlertRuleRequest) -> JSONResponse:
        """Create or replace an alert rule.

        For an ``event`` rule the response body carries ``webhook_secret`` and
        ``webhook_url`` exactly once: the plaintext is never stored, so a later
        read can only report that a secret exists.
        """
        _checked_id(request.id)
        existing = _service().get_rule(request.id)
        try:
            rule, generated = _build_rule(request, existing)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        stored = _store_rule(rule)
        payload = _rule_to_response(stored).model_dump()
        if generated:
            payload["webhook_secret"] = generated
            payload["webhook_url"] = f"/alerts/webhook/{stored.id}?key={generated}"
        _wake_poller()
        return JSONResponse(status_code=201, content=payload)

    @app.get("/alerts/rules/{rule_id}", response_model=AlertRuleResponse, dependencies=[Depends(require_auth)])
    async def get_alert_rule(rule_id: str) -> AlertRuleResponse:
        """Return one rule."""
        rule = _service().get_rule(_checked_id(rule_id))
        if rule is None:
            raise HTTPException(status_code=404, detail="alert rule not found")
        return _rule_to_response(rule)

    @app.put("/alerts/rules/{rule_id}", response_model=AlertRuleResponse, dependencies=[Depends(require_auth)])
    async def update_alert_rule(rule_id: str, request: AlertRuleRequest) -> AlertRuleResponse:
        """Replace a rule's definition, keeping its live state and history."""
        _checked_id(rule_id)
        if request.id != rule_id:
            raise HTTPException(status_code=422, detail="body id must match the path id")
        existing = _service().get_rule(rule_id)
        if existing is None:
            raise HTTPException(status_code=404, detail="alert rule not found")
        try:
            rule, _generated = _build_rule(request, existing)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        stored = _store_rule(rule)
        _wake_poller()
        return _rule_to_response(stored)

    @app.delete("/alerts/rules/{rule_id}", dependencies=[Depends(require_auth)])
    async def delete_alert_rule(rule_id: str) -> Dict[str, Any]:
        """Delete a rule. Its notification history is kept on purpose."""
        _checked_id(rule_id)
        deleted = _service().delete_rule(rule_id)
        if not deleted:
            raise HTTPException(status_code=404, detail="alert rule not found")
        return {"status": "deleted", "id": rule_id}

    @app.post("/alerts/rules/{rule_id}/enabled", response_model=AlertRuleResponse, dependencies=[Depends(require_auth)])
    async def set_alert_rule_enabled(
        rule_id: str, enabled: bool = Query(..., description="True resumes, False pauses")
    ) -> AlertRuleResponse:
        """Pause or resume a rule."""
        _checked_id(rule_id)
        rule = _service().set_enabled(rule_id, enabled)
        if rule is None:
            raise HTTPException(status_code=404, detail="alert rule not found")
        _wake_poller()
        return _rule_to_response(rule)

    @app.post("/alerts/rules/{rule_id}/reset", response_model=AlertRuleResponse, dependencies=[Depends(require_auth)])
    async def reset_alert_rule(rule_id: str) -> AlertRuleResponse:
        """Put a rule's state machine back to rest without touching its definition."""
        _checked_id(rule_id)
        rule = _service().reset_rule(rule_id)
        if rule is None:
            raise HTTPException(status_code=404, detail="alert rule not found")
        return _rule_to_response(rule)

    @app.post("/alerts/rules/{rule_id}/dry-run", dependencies=[Depends(require_auth)])
    async def dry_run_alert_rule(rule_id: str) -> Dict[str, Any]:
        """Measure a rule now and report the verdict, without storing or sending.

        This is the "will my condition ever be true" affordance: it reads live
        data, runs the same evaluator the poller runs, and leaves the rule's
        state untouched — so it is safe to press on a rule that is firing.
        """
        _checked_id(rule_id)
        try:
            return await _service().dry_run(rule_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

    @app.post("/alerts/rules/{rule_id}/test-send", dependencies=[Depends(require_auth)])
    async def test_send_alert_rule(rule_id: str) -> Dict[str, Any]:
        """Push one sample message through the rule's real targets.

        The message says it is a test, so a group that receives it is not left
        wondering whether a level was breached.
        """
        _checked_id(rule_id)
        try:
            return await _service().test_send(rule_id)
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

    # --- history & capabilities ---

    @app.get("/alerts/incidents", response_model=List[AlertIncidentResponse], dependencies=[Depends(require_auth)])
    async def list_alert_incidents(
        rule_id: Optional[str] = Query(None),
        state: Optional[str] = Query(None, description="firing | resolved"),
        delivery_status: Optional[str] = Query(None, description="pending | sent | failed | skipped"),
        limit: int = Query(50, ge=1, le=500),
    ) -> List[AlertIncidentResponse]:
        """List notifications this alerting setup has produced, newest first."""
        rows = _service().list_incidents(
            rule_id=rule_id, state=state, delivery_status=delivery_status, limit=limit
        )
        return [
            AlertIncidentResponse(
                **{k: v for k, v in row.to_dict().items() if k != "delivery_key"}
            )
            for row in rows
        ]

    @app.get("/alerts/targets", dependencies=[Depends(require_auth)])
    async def list_alert_targets() -> Dict[str, Any]:
        """Return push destinations: registered refs and configured channels."""
        from src.channels.targets import list_delivery_targets

        refs = [
            {
                "ref": target.ref,
                "label": target.label,
                "channel": target.channel,
            }
            for target in list_delivery_targets()
        ]
        manager = getattr(host, "_channel_manager", None)
        channels: List[str] = []
        if manager is not None:
            try:
                channels = sorted(manager.channels.keys())
            except AttributeError:  # pragma: no cover — a stub manager in tests
                channels = []
        return {"targets": refs, "channels": channels}

    @app.post("/alerts/run", dependencies=[Depends(require_auth)])
    async def run_alerts_now(
        deliver: bool = Query(False, description="Also push what fires"),
        rule_id: Optional[str] = Query(None, description="Restrict to one rule"),
    ) -> Dict[str, Any]:
        """Evaluate rules immediately.

        ``deliver`` defaults to ``False``: pressing "run now" in the UI should
        answer "what does the engine see", not send a batch of messages to a
        group. A rule whose cooldown or state says "already announced" stays
        quiet either way.
        """
        ids = [rule_id] if rule_id else None
        if rule_id:
            _checked_id(rule_id)
        report = await _service().tick(deliver=deliver, rule_ids=ids)
        return {"status": "ok", **report.as_dict()}

    # --- inbound webhook (TradingView / Pine alerts) ---

    @app.post("/alerts/webhook/{rule_id}")
    async def alert_webhook(
        rule_id: str,
        request: Request,
        key: Optional[str] = Query(None, description="The rule's shared webhook secret"),
    ) -> JSONResponse:
        """Accept an external alert event and forward it to IM.

        No bearer auth by design — the sender is TradingView's alert dispatcher.
        The shared secret travels as ``?key=`` or as ``key``/``secret`` inside the
        alert message body, since the alert template is the only thing the
        sender controls.
        """
        if not _SAFE_RULE_ID_RE.fullmatch(rule_id):
            raise HTTPException(status_code=404, detail="alert rule not found")
        rule = _service().get_rule(rule_id)
        if rule is None or rule.kind != AlertKind.EVENT:
            # One answer for "no such rule" and "not an event rule": the route
            # must not become a probe for which ids exist and what they are.
            raise HTTPException(status_code=404, detail="alert rule not found")
        if not rule.enabled:
            raise HTTPException(status_code=409, detail="alert rule is paused")

        try:
            body = await request.json()
        except Exception:  # noqa: BLE001 — a non-JSON body is a bad request
            body = None
        presented = key
        if presented is None and isinstance(body, dict):
            raw = body.get("key") or body.get("secret") or body.get("token")
            if isinstance(raw, str):
                presented = raw
        if presented is None:
            header = request.headers.get("x-alert-key")
            if isinstance(header, str) and header:
                presented = header

        from src.alerts.inbox import secret_matches

        if not secret_matches(presented, rule.webhook_secret_hash):
            logger.warning("alert webhook rejected for rule %s (bad secret)", rule_id)
            raise HTTPException(status_code=401, detail="invalid webhook key")

        from src.alerts.inbox import InboundAlertError, normalize_alert_event

        try:
            event = normalize_alert_event(
                body if isinstance(body, dict) else {"text": str(body or "")},
                rule_id=rule_id,
                now_ms=int(time.time() * 1000),
            )
        except InboundAlertError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc

        try:
            outcome = await _service().ingest_event(event)
        except ValueError as exc:
            raise HTTPException(status_code=422, detail=str(exc)) from exc
        # Two different answers must not overwrite each other: "the webhook took
        # the event" and "an IM channel accepted the push" are separate facts, and
        # collapsing them would let a skipped send read as a delivered one.
        content: Dict[str, Any] = {"status": "accepted", "delivery": outcome.get("status")}
        content.update({k: v for k, v in outcome.items() if k != "status"})
        return JSONResponse(status_code=202, content=content)
