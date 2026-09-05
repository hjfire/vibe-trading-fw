"""The alerting domain service: collect, decide, record, notify.

:class:`AlertService` is the only component that touches the clock, the data
sources, and the channel runtime. The HTTP routes and the background poller both
go through it, which is what keeps "what the UI shows when I press *test*" and
"what the poller does on its own" the same code path.

Data collection happens for a whole pass **in one worker thread, sequentially**.
The upstream loader chain (shared akshare / yfinance sessions and caches) is not
thread-safe — a concurrent walk returns data only for the first symbol — so
parallelizing the fetches would trade correct alerts for speed. Deciding and
notifying then happen back on the event loop.

Every dependency that reaches outside this package is injectable, so a test can
hand it literal bars and a fake sender and still exercise the real state
machine, cooldown arithmetic, incident rows, and delivery bookkeeping.
"""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Mapping, Optional, Sequence

from src.alerts.conditions import (
    ConditionResult,
    EvalContext,
    describe_condition,
    evaluate_condition,
)
from src.alerts.delivery import (
    MAX_DELIVERY_ATTEMPTS,
    DeliveryError,
    render_alert_message,
    resolve_addresses,
    send_alert_text,
)
from src.alerts.engine import (
    ACTION_ERROR,
    RuleState,
    advance_rule,
    find_inhibitor,
    make_incident,
)
from src.alerts.inbox import InboundAlert
from src.alerts.models import (
    AlertIncident,
    AlertRule,
    AlertState,
    validate_rule,
)
from src.alerts.sessions import symbol_market_is_open
from src.alerts.store import AlertStore

logger = logging.getLogger(__name__)

#: How many portfolio snapshots feed an account-level series. Two years of daily
#: snapshots at most, which is also roughly the store's own window.
ACCOUNT_HISTORY_ROWS = 250

#: A poller pass never evaluates more rules than this, so one slow data source
#: cannot make a tick outlive the tick interval.
_RULES_PER_PASS = 50


BarsFetcher = Callable[[str, str, int, str], List[Dict[str, Any]]]
PortfolioFetcher = Callable[[], tuple[List[Mapping[str, Any]], List[Mapping[str, Any]]]]
QuoteFetcher = Callable[[str], Mapping[str, Any]]


def _default_bars(symbol: str, interval: str, count: int, adjust: str) -> List[Dict[str, Any]]:
    """Pull bars through the same loader chain ``/market/kline`` serves.

    Args:
        symbol: Canonical symbol.
        interval: ``1D`` or a minute interval the chain supports.
        count: Bars requested.
        adjust: ``none`` / ``qfq`` / ``hfq``.

    Returns:
        Oldest-first bar dicts.

    Raises:
        Exception: Whatever the loader raises; the caller records it per rule.
    """
    from src.api.market_routes import _kline_sync

    payload = _kline_sync(symbol, interval, count, adjust, None)
    rows = payload.get("bars") if isinstance(payload, dict) else None
    return list(rows or [])


def _default_portfolio() -> tuple[List[Mapping[str, Any]], List[Mapping[str, Any]]]:
    """Return ``(positions, equity history)`` from the portfolio service.

    Reads the newest stored snapshot only — an alert pass must not trigger a
    broker refresh, which is a user-initiated, rate-limited action.
    """
    from src.portfolio.service import PortfolioService

    service = PortfolioService()
    snapshot = service.latest() or {}
    positions = list(snapshot.get("positions") or [])
    try:
        history = list(service.history(ACCOUNT_HISTORY_ROWS) or [])
    except Exception as exc:  # noqa: BLE001 — history is optional context
        logger.debug("portfolio history unavailable: %s", exc)
        history = []
    return positions, history


def _default_quote(symbol: str) -> Mapping[str, Any]:
    """Fetch one live quote row for message context (best effort)."""
    from src.api.market_routes import _quote_one

    return _quote_one(symbol) or {}


@dataclass
class TickReport:
    """What one evaluation pass did, for logs and the UI's "run now" button.

    Attributes:
        evaluated: Rules whose condition was measured this pass.
        fired: Rules that transitioned to firing and notified.
        resolved: Rules that cleared and notified.
        suppressed: Transitions recorded without a send (inhibited, cooling, or
            a rule with no target).
        errors: Rules whose data source failed. Skipped rules are not counted as
            errors, because nothing was wrong with the data.
        skipped: Rules held back by their session being closed or their poll
            interval not yet elapsed.
        delivered: Notifications whose send a channel accepted.
    """

    evaluated: int = 0
    fired: int = 0
    resolved: int = 0
    suppressed: int = 0
    errors: int = 0
    skipped: int = 0
    delivered: int = 0
    incidents: List[str] = field(default_factory=list)

    def as_dict(self) -> Dict[str, Any]:
        """Return a JSON-safe summary."""
        return {
            "evaluated": self.evaluated,
            "fired": self.fired,
            "resolved": self.resolved,
            "suppressed": self.suppressed,
            "errors": self.errors,
            "skipped": self.skipped,
            "delivered": self.delivered,
            "incidents": list(self.incidents),
        }


class AlertService:
    """Alert rule lifecycle plus the evaluation/notification pass.

    Attributes:
        store: The durable rule/incident store this service drives.
    """

    def __init__(
        self,
        store: Optional[AlertStore] = None,
        *,
        bars: Optional[BarsFetcher] = None,
        portfolio: Optional[PortfolioFetcher] = None,
        quote: Optional[QuoteFetcher] = None,
    ) -> None:
        """Initialize the service.

        Args:
            store: Rule store. Defaults to the runtime-root store.
            bars: Bar fetcher, injectable for tests.
            portfolio: ``(positions, history)`` fetcher.
            quote: Latest-quote fetcher used for message context.
        """
        self.store = store if store is not None else AlertStore()
        self._bars = bars or _default_bars
        self._portfolio = portfolio or _default_portfolio
        self._quote = quote or _default_quote
        self._portfolio_cache: Optional[tuple[List[Mapping[str, Any]], List[Mapping[str, Any]]]] = None

    # ------------------------------------------------------------------
    # Rule lifecycle
    # ------------------------------------------------------------------

    def list_rules(self, **filters: Any) -> List[AlertRule]:
        """Return stored rules (see :meth:`src.alerts.store.AlertStore.list_rules`)."""
        return self.store.list_rules(**filters)

    def get_rule(self, rule_id: str) -> Optional[AlertRule]:
        """Return one rule, or ``None``."""
        return self.store.get_rule(rule_id)

    def save_rule(self, rule: AlertRule) -> AlertRule:
        """Validate and persist a rule.

        Args:
            rule: The rule to store.

        Returns:
            The stored rule.

        Raises:
            ValueError: When the rule is not storeable.
        """
        validate_rule(rule)
        return self.store.upsert_rule(rule)

    def set_enabled(self, rule_id: str, enabled: bool) -> Optional[AlertRule]:
        """Pause or resume a rule without erasing its state machine.

        Args:
            rule_id: The rule to change.
            enabled: ``False`` pauses evaluation.

        Returns:
            The updated rule, or ``None`` when no rule has that id.
        """
        rule = self.store.get_rule(rule_id)
        if rule is None:
            return None
        rule.enabled = enabled
        return self.store.upsert_rule(rule)

    def reset_rule(self, rule_id: str) -> Optional[AlertRule]:
        """Put a rule's state machine back to rest, keeping its definition.

        Pausing is not forgetting: a user who un-pauses a rule that fired while
        it was off should not get the backlog all at once, and one whose episode
        is stale should stop being reported as currently firing.

        Args:
            rule_id: The rule to reset.

        Returns:
            The updated rule, or ``None`` when it does not exist.
        """
        rule = self.store.get_rule(rule_id)
        if rule is None:
            return None
        quiet = RuleState()
        return self.store.upsert_rule(quiet.apply_to(rule), validate=False)

    def delete_rule(self, rule_id: str) -> bool:
        """Remove a rule; its notification history stays.

        Args:
            rule_id: The rule to remove.

        Returns:
            ``True`` when a rule was deleted.
        """
        return self.store.delete_rule(rule_id)

    def list_incidents(self, **filters: Any) -> List[AlertIncident]:
        """Return notification history (see the store's method of the same name)."""
        return self.store.list_incidents(**filters)

    # ------------------------------------------------------------------
    # Evaluation
    # ------------------------------------------------------------------

    def collect_contexts(
        self, rules: Sequence[AlertRule], portfolio: bool = True
    ) -> Dict[str, EvalContext]:
        """Fetch the data every rule in *rules* needs, in one sequential pass.

        Runs in a worker thread. Each rule's failure is captured into its own
        context rather than aborting the pass, so one dead data vendor yields
        "unknown" rules, not a stopped alert loop.

        Args:
            rules: The rules to gather for.
            portfolio: Whether any rule needs holdings. ``False`` skips the
                portfolio read entirely (a market-only loop stays cheap).

        Returns:
            A per-rule-id mapping of :class:`EvalContext`.
        """
        positions: List[Mapping[str, Any]] = []
        history: List[Mapping[str, Any]] = []
        if portfolio and any(r.kind.value in ("position", "account") for r in rules):
            try:
                if self._portfolio_cache is None:
                    self._portfolio_cache = self._portfolio()
                positions, history = self._portfolio_cache
            except Exception as exc:  # noqa: BLE001 — recorded per rule
                logger.warning("portfolio read failed: %s", exc)
                positions_error = f"持仓读取失败：{str(exc)[:160]}"
                return {
                    r.id: EvalContext(
                        symbol=r.symbol,
                        errors=[positions_error]
                        if r.kind.value in ("position", "account")
                        else [],
                    )
                    for r in rules
                }

        contexts: Dict[str, EvalContext] = {}
        for rule in rules:
            ctx = EvalContext(
                symbol=rule.symbol,
                positions=positions if rule.kind.value == "position" else [],
                account_history=history if rule.kind.value == "account" else [],
            )
            if rule.kind.value in ("market", "position"):
                try:
                    ctx.bars = list(
                        self._bars(rule.symbol, rule.interval, rule.count, rule.adjust) or []
                    )
                except Exception as exc:  # noqa: BLE001 — per-rule containment
                    logger.warning(
                        "alert %s: bar fetch failed for %s %s: %s",
                        rule.id,
                        rule.symbol,
                        rule.interval,
                        exc,
                    )
                    ctx.errors.append(f"行情读取失败：{str(exc)[:160]}")
            contexts[rule.id] = ctx
        return contexts

    def measure(self, rule: AlertRule, ctx: EvalContext) -> ConditionResult:
        """Evaluate a rule's condition against an already-collected context.

        Args:
            rule: The rule whose condition is judged.
            ctx: Data snapshot for its subject.

        Returns:
            The verdict; ``error`` set means "could not be measured".
        """
        if not rule.condition:
            return ConditionResult(hit=False, error="规则没有条件")
        return evaluate_condition(rule.condition, ctx)

    async def tick(
        self,
        now_ms: Optional[int] = None,
        *,
        deliver: bool = True,
        rule_ids: Optional[Sequence[str]] = None,
    ) -> TickReport:
        """Run one evaluation pass over the due rules.

        Args:
            now_ms: Instant to evaluate at. Defaults to the wall clock; tests
                pass a fixed value.
            deliver: When ``False``, transitions are recorded but nothing is
                pushed (used by "run now" in the UI).
            rule_ids: Restrict the pass to these rules.

        Returns:
            A :class:`TickReport` summarizing the pass.
        """
        moment = now_ms if now_ms is not None else _wall_ms()
        report = TickReport()

        rules = self._due_rules(moment, rule_ids)
        if not rules:
            return report

        self._portfolio_cache = None
        contexts = await asyncio.to_thread(self.collect_contexts, rules)
        # Inhibition is judged against the states as they stand, which includes
        # what this very pass has already decided: a critical rule that fired two
        # iterations ago mutes the warning rule about the same subject today,
        # not one poll later.
        by_id = {r.id: r for r in self.store.enabled_rules()}

        for rule in rules:
            ctx = contexts.get(rule.id) or EvalContext(symbol=rule.symbol)
            result = await asyncio.to_thread(self.measure, rule, ctx)
            open_now = True
            if rule.session_only:
                open_now = await asyncio.to_thread(
                    symbol_market_is_open, rule.symbol, moment
                )
                if not open_now:
                    report.skipped += 1
            inhibitor = find_inhibitor(
                rule, [r for r in by_id.values() if r.id != rule.id]
            )
            decision = advance_rule(
                rule,
                result,
                moment,
                market_is_open=open_now,
                inhibited_by=inhibitor.id if inhibitor else None,
            )
            updated = decision.state.apply_to(rule)
            updated.last_value = decision.value
            updated.last_reason = decision.reason
            updated.last_error = decision.error
            updated.last_checked_at = moment
            self.store.upsert_rule(updated, validate=False)
            by_id[rule.id] = updated
            report.evaluated += 1

            if decision.action == ACTION_ERROR:
                report.errors += 1
                continue
            if not decision.notifies:
                if decision.action in ("suppressed", "cooling"):
                    report.suppressed += 1
                continue
            if decision.incident_state == AlertState.FIRING:
                report.fired += 1
            else:
                report.resolved += 1

            incident = make_incident(updated, decision, _new_incident_id(), moment)
            self.store.append_incident(incident)
            report.incidents.append(incident.id)

            addresses = resolve_addresses(updated)
            if not addresses:
                self.store.update_incident(
                    incident.id,
                    delivery_status="skipped",
                    delivery_error=None,
                    delivery_updated_at=moment,
                )
                report.suppressed += 1
                continue
            if not deliver:
                continue
            outcome = await self.deliver_incident(updated, incident, now_ms=moment)
            if outcome.delivery_status == "sent":
                report.delivered += 1
        return report

    def _due_rules(
        self, now_ms: int, rule_ids: Optional[Sequence[str]]
    ) -> List[AlertRule]:
        """Return the enabled, non-event rules whose poll interval has elapsed.

        Args:
            now_ms: The instant to test against.
            rule_ids: When given, only these ids are considered (an explicit
                "evaluate this now" from the UI bypasses the poll interval,
                because the user asked for a measurement, not a schedule).

        Returns:
            At most :data:`_RULES_PER_PASS` rules, oldest-created first.
        """
        wanted = set(rule_ids or ())
        rows: List[AlertRule] = []
        for rule in self.store.enabled_rules():
            if rule.kind.value == "event":
                continue
            if wanted and rule.id not in wanted:
                continue
            last = rule.last_checked_at or 0
            if not wanted and now_ms - last < rule.poll_interval_ms:
                continue
            rows.append(rule)
            if len(rows) >= _RULES_PER_PASS:
                break
        return rows

    async def ingest_event(self, event: InboundAlert, *, deliver: bool = True) -> Dict[str, Any]:
        """Apply an inbound alert event to its rule.

        Args:
            event: The normalized event (see
                :func:`src.alerts.inbox.normalize_alert_event`).
            deliver: Push the resulting notification when it fires.

        Returns:
            ``{"status": ..., "rule_id": ..., "incident_id": ...}``.

        Raises:
            LookupError: When the rule does not exist.
            ValueError: When the rule is not an event rule or is paused — a
                sender must learn that its target is wrong rather than get a
                200 for an event nobody consumed.
        """
        rule = self.store.get_rule(event.rule_id)
        if rule is None:
            raise LookupError(f"alert rule {event.rule_id!r} does not exist")
        if rule.kind.value != "event":
            raise ValueError(f"alert rule {rule.id!r} is not an event rule")
        if not rule.enabled:
            raise ValueError(f"alert rule {rule.id!r} is paused")

        moment = event.at_ms or _wall_ms()
        ctx = EvalContext(symbol=event.symbol or rule.symbol, event=event.as_event_values())
        if rule.condition:
            result = self.measure(rule, ctx)
        else:
            # No condition means "whatever the sender alerted on is the event".
            result = ConditionResult(
                hit=True,
                value=event.value,
                reason=event.message or "收到外部警报",
                bars=1 if event.value is not None else 0,
            )
        decision = advance_rule(rule, result, moment)
        updated = decision.state.apply_to(rule)
        updated.last_value = decision.value
        updated.last_reason = decision.reason or result.reason
        updated.last_error = decision.error
        updated.last_checked_at = moment
        self.store.upsert_rule(updated, validate=False)

        if not decision.notifies:
            return {
                "status": decision.action,
                "rule_id": rule.id,
                "reason": decision.reason or decision.error,
            }

        incident = make_incident(updated, decision, _new_incident_id(), moment)
        # An event carries its own text; show it instead of a computed reason.
        incident.reason = decision.reason or event.message or "收到外部警报"
        self.store.append_incident(incident)
        if not deliver:
            return {"status": "recorded", "rule_id": rule.id, "incident_id": incident.id}
        outcome = await self.deliver_incident(
            updated, incident, now_ms=moment, event_message=event.message
        )
        return {
            "status": outcome.delivery_status,
            "rule_id": rule.id,
            "incident_id": incident.id,
        }

    # ------------------------------------------------------------------
    # Delivery
    # ------------------------------------------------------------------

    async def deliver_incident(
        self,
        rule: AlertRule,
        incident: AlertIncident,
        *,
        now_ms: Optional[int] = None,
        event_message: str = "",
    ) -> AlertIncident:
        """Send one incident and record what the channels said.

        Args:
            rule: The rule that produced the incident.
            incident: Row to deliver; already in the store.
            now_ms: Timestamp for the delivery record.
            event_message: Sender-authored text for event rules.

        Returns:
            The updated incident row.
        """
        moment = now_ms if now_ms is not None else _wall_ms()
        if incident.delivery_status == "sent":
            return incident

        addresses = resolve_addresses(rule)
        if not addresses:
            # Nothing to send to is not a send that succeeded. Record it as a
            # deliberate skip (the firing reason is kept intact — the row says
            # both what happened and that it stayed local) so a sweep does not
            # retry a message no target was ever waiting for.
            return self.store.update_incident(
                incident.id,
                delivery_status="skipped",
                delivery_error=None,
                delivery_updated_at=moment,
            ) or incident

        quote: Mapping[str, Any] = {}
        if rule.kind.value in ("market", "position") and rule.symbol:
            try:
                quote = await asyncio.to_thread(self._quote, rule.symbol) or {}
            except Exception as exc:  # noqa: BLE001 — context, not a verdict
                logger.debug("alert %s quote context failed: %s", rule.id, exc)
                quote = {}

        text = render_alert_message(
            rule, incident, quote=quote, event_message=event_message
        )
        try:
            provider_id = await send_alert_text(rule, text)
        except (DeliveryError, ValueError) as exc:
            attempts = incident.delivery_attempts + 1
            return self.store.update_incident(
                incident.id,
                delivery_status="failed",
                delivery_error=str(exc)[:300],
                delivery_attempts=attempts,
                delivery_updated_at=moment,
            ) or incident
        return self.store.update_incident(
            incident.id,
            delivery_status="sent",
            delivery_error=None,
            provider_message_id=provider_id,
            delivery_updated_at=moment,
        ) or incident

    async def sweep_deliveries(self, limit: int = 20) -> int:
        """Retry the sends that never completed.

        Args:
            limit: Maximum rows attempted this sweep.

        Returns:
            How many rows reached ``sent``.
        """
        sent = 0
        for incident in self.store.pending_deliveries(
            limit=limit, max_attempts=MAX_DELIVERY_ATTEMPTS
        ):
            rule = self.store.get_rule(incident.rule_id)
            if rule is None:
                # The rule is gone, but the message was owed to someone. Keep
                # the row honest: it failed, with the reason stated.
                self.store.update_incident(
                    incident.id,
                    delivery_status="failed",
                    delivery_error="规则已删除，无法投递",
                    delivery_attempts=MAX_DELIVERY_ATTEMPTS,
                )
                continue
            outcome = await self.deliver_incident(rule, incident)
            if outcome.delivery_status == "sent":
                sent += 1
        return sent

    async def test_send(self, rule_id: str) -> Dict[str, Any]:
        """Push one sample notification through a rule's real targets.

        This is the answer to "is my IM setup actually working", so it uses the
        same path a firing rule uses — including the failure text when a channel
        is not configured.

        Args:
            rule_id: The rule to test.

        Returns:
            ``{"status": ..., "addresses": n, "error": ...}``.

        Raises:
            LookupError: When the rule does not exist.
        """
        rule = self.store.get_rule(rule_id)
        if rule is None:
            raise LookupError(f"alert rule {rule_id!r} does not exist")
        addresses = resolve_addresses(rule)
        if not addresses:
            return {
                "status": "no_target",
                "addresses": 0,
                "error": "规则没有配置推送目标（targets 引用或 channel+target）",
            }
        moment = _wall_ms()
        incident = AlertIncident(
            id=_new_incident_id(),
            rule_id=rule.id,
            rule_title=rule.display_title,
            symbol=rule.symbol,
            kind=rule.kind,
            state=AlertState.FIRING,
            severity=rule.severity,
            value=rule.last_value,
            reason="这是一条测试推送，规则本身没有触发",
            at_ms=moment,
            delivery_key=f"alert:{rule.id}:test:{moment}",
        )
        text = render_alert_message(rule, incident)
        try:
            provider_id = await send_alert_text(rule, text)
        except (DeliveryError, ValueError) as exc:
            return {"status": "failed", "addresses": len(addresses), "error": str(exc)[:300]}
        return {
            "status": "sent",
            "addresses": len(addresses),
            "provider_message_id": provider_id,
        }

    # ------------------------------------------------------------------
    # Dry run
    # ------------------------------------------------------------------

    async def dry_run(self, rule_id: str, now_ms: Optional[int] = None) -> Dict[str, Any]:
        """Evaluate a rule and report the verdict without storing or sending.

        The UI's "test the condition" affordance. The rule's persisted state is
        untouched, which is what makes it safe to press on a rule that is
        currently firing.

        Args:
            rule_id: The rule to measure.
            now_ms: Session-gate instant; defaults to the wall clock.

        Returns:
            The verdict plus the data it was measured from.

        Raises:
            LookupError: When the rule does not exist.
        """
        rule = self.store.get_rule(rule_id)
        if rule is None:
            raise LookupError(f"alert rule {rule_id!r} does not exist")
        moment = now_ms if now_ms is not None else _wall_ms()
        self._portfolio_cache = None
        ctx = (await asyncio.to_thread(self.collect_contexts, [rule])).get(rule.id) or EvalContext(
            symbol=rule.symbol
        )
        result = await asyncio.to_thread(self.measure, rule, ctx)
        # The session gate is only consulted for a rule that asked for it; a
        # 24h-account rule must not come back "frozen because the market is
        # closed" when it never opted into session-only evaluation.
        open_now = True
        if rule.session_only:
            open_now = await asyncio.to_thread(symbol_market_is_open, rule.symbol, moment)
        decision = advance_rule(rule, result, moment, market_is_open=open_now)
        return {
            "status": "ok",
            "rule_id": rule.id,
            "hit": result.hit,
            # Two separate fields on purpose: what the data says about the
            # condition, and what the state machine would do about it (cooldown,
            # debounce, inhibition). Collapsing them would make a rule that is
            # merely cooling down look like a condition that failed.
            "reason": result.reason or describe_condition(rule.condition),
            "note": decision.reason,
            "error": result.error,
            "value": result.value,
            "bars": result.bars,
            "positions": len(ctx.positions),
            "market_open": open_now,
            "would_notify": decision.notifies,
            "action": decision.action,
            "next_state": decision.state.state.value,
        }


def _wall_ms() -> int:
    """Epoch milliseconds now."""
    return int(time.time() * 1000)


def _new_incident_id() -> str:
    """A unique incident id."""
    return f"alr-{uuid.uuid4().hex[:12]}"
