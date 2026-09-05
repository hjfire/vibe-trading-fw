"""Render an alert and hand it to the channel runtime.

This module adds no transport. The repo already owns sending: a
:class:`~src.channels.base.BaseChannel` adapter with ``send_with_receipt``, the
opaque delivery-target registry in :mod:`src.channels.targets`, and the retry
wrapper the channel manager applies. Alerting's job is the message and the
state around it, so every send here goes out through the same
``send_with_receipt`` call the scheduled briefings use.

Two invariants:

**Never claim a send that was not accepted.** A missing channel runtime, an
unconfigured channel, or a provider error leaves the incident ``failed`` with
the diagnostic attached. An alert that says "delivered" when nothing reached the
group is worse than a visibly failed one, because the user stops checking the
app.

**One notification, once.** Idempotency rides on the incident row: a row already
``sent`` is skipped, and the delivery key baked into the row
(``alert:<rule>:<f|r>:<seq>``) is unique per notification, so a restarted poller
or a retried sweep cannot produce a second copy of the same message.
"""

from __future__ import annotations

import logging
import sys as _sys
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any, List, Mapping, Optional
from zoneinfo import ZoneInfo

from src.alerts.conditions import shown_number
from src.alerts.models import AlertIncident, AlertRule, AlertState
from src.alerts.sessions import subject_market

logger = logging.getLogger(__name__)

#: Give up sweeping a row after this many attempted sends.
MAX_DELIVERY_ATTEMPTS = 6

#: Character budget for a pushed message. Long messages are truncated rather
#: than split: a channel that silently drops the tail of a two-part alert is
#: how a threshold reads as a different number.
_MAX_MESSAGE_CHARS = 900

_MARKET_TZ = {
    "cn_equity": "Asia/Shanghai",
    "hk_equity": "Asia/Hong_Kong",
    "us_equity": "America/New_York",
    "crypto": "UTC",
}

_STATE_MARK = {
    AlertState.FIRING: "⚠️",
    AlertState.RESOLVED: "✅",
}

#: Engine fallbacks that carry no information a user can act on; the rule's own
#: condition line already says the same thing.
_GENERIC_REASONS = frozenset({"", "条件成立", "条件已不再成立", "已在点火中，未设置重复通知"})


def _scrub(text: str) -> str:
    """Make a user-authored or inbound string safe to paste into a chat.

    Both passes are needed and neither subsumes the other: path redaction hides
    server topology (a rule title or a webhook body that quotes a failed file
    read must not print ``C:\\Users\\...`` onto someone's screen), while token
    neutralization defangs chat-template control tokens, because this text also
    lands in the incident store and a store row can be pasted back into a model
    prompt later.

    Args:
        text: The raw string, from a rule field, an engine reason, or an
            untrusted webhook body.

    Returns:
        The string with internal paths collapsed and control tokens defanged.
    """
    from src.security.scanner import neutralize_special_tokens
    from src.tools.redaction import redact_internal_paths
    # ``redact_internal_paths`` lives beside the tool registry, which the API
    # server has already imported by the time an alert can fire.

    return neutralize_special_tokens(redact_internal_paths(text))


@dataclass(frozen=True)
class DeliveryAddress:
    """Where one message goes.

    Attributes:
        channel: Channel id as registered with the manager (``telegram`` ...).
        target: Address within that channel (chat / group / user id).
        label: Human label, used in the UI and in failure diagnostics. Never
            included in the pushed message.
    """

    channel: str
    target: str
    label: str = ""


def resolve_addresses(rule: AlertRule) -> List[DeliveryAddress]:
    """Turn a rule's targets into concrete addresses.

    Opaque refs (``research-group``) win over an inline ``channel``/``target``
    pair, and an unresolvable ref is an error rather than a partial send — a
    rule that points at a renamed group must fail loudly, not quietly stop
    notifying.

    Args:
        rule: The rule about to notify.

    Returns:
        One address per configured destination; empty when the rule has none
        (the incident is then recorded but not pushed, which is a valid
        "log only" rule).

    Raises:
        ValueError: When a ref does not resolve.
    """
    addresses: List[DeliveryAddress] = []
    if rule.targets:
        from src.channels.targets import resolve_delivery_target

        for ref in rule.targets:
            resolved = resolve_delivery_target(ref)
            addresses.append(
                DeliveryAddress(
                    channel=resolved.channel,
                    target=resolved.target,
                    label=resolved.label or ref,
                )
            )
    elif rule.channel and rule.target:
        addresses.append(
            DeliveryAddress(channel=rule.channel, target=rule.target, label="direct")
        )
    return addresses


def _local_text(at_ms: int, symbol: str) -> str:
    """Format an epoch-ms instant in the subject market's own trading timezone.

    Args:
        at_ms: Epoch milliseconds, UTC.
        symbol: Used only to pick the display timezone.

    Returns:
        Something like ``2026-09-04 15:00 Asia/Shanghai``. The zone name stays
        in the output: an alert that reads "15:00" without a zone is ambiguous
        across the three markets this project covers.
    """
    market = subject_market(symbol)
    tz_name = _MARKET_TZ.get(market or "", "UTC")
    try:
        local = datetime.fromtimestamp(at_ms / 1000, tz=timezone.utc).astimezone(
            ZoneInfo(tz_name)
        )
    except Exception:  # pragma: no cover — a bad tz database must not eat the alert
        local = datetime.fromtimestamp(at_ms / 1000, tz=timezone.utc)
        tz_name = "UTC"
    return f"{local.strftime('%Y-%m-%d %H:%M')} {tz_name}"


def render_alert_message(
    rule: AlertRule,
    incident: AlertIncident,
    *,
    quote: Optional[Mapping[str, Any]] = None,
    subject: str = "",
    event_message: str = "",
) -> str:
    """Build the text that lands in the chat.

    Args:
        rule: The rule that fired.
        incident: The notification row (carries state, severity, value, reason).
        quote: Optional live quote row (``last`` / ``change_pct``) for extra
            context. Absent data is omitted, never guessed.
        subject: Free-text subject override (used by event rules to name the
            inbound source).
        event_message: The sender's own alert text, for ``event`` rules. Passed
            through the same neutralization as every other untrusted string.

    Returns:
        A compact multi-line message: what happened, the number behind it, when,
        and which rule said so.
    """
    mark = _STATE_MARK.get(incident.state, "•")
    headline = subject or rule.display_title
    verb = "已解除" if incident.state == AlertState.RESOLVED else "触发"
    lines: List[str] = [f"{mark} {_scrub(headline)} · {verb}"]

    # What was tested, in the rule's own terms — the state-machine reason is
    # written for the log and reads the same for every rule, so a pushed
    # message that quoted only it would tell the user nothing about the level.
    from src.alerts.conditions import describe_condition

    tested = describe_condition(rule.condition) if rule.condition else ""
    if tested:
        lines.append(_scrub(tested))
    detail = incident.reason
    if detail and detail not in _GENERIC_REASONS:
        lines.append(_scrub(detail))

    facts: List[str] = []
    last = quote.get("last") if quote else None
    shows_price = isinstance(last, (int, float)) and not isinstance(last, bool)
    if incident.value is not None and not (
        shows_price and abs(float(last) - float(incident.value)) < 1e-9  # type: ignore[arg-type]
    ):
        # "当前" is the number the condition was judged on (an RSI, a floating
        # P&L); when that number *is* the price, saying it twice adds noise.
        facts.append(f"当前 {shown_number(incident.value)}")
    if shows_price:
        facts.append(f"最新 {shown_number(float(last))}")  # type: ignore[arg-type]
    if quote:
        change = quote.get("change_pct")
        if isinstance(change, (int, float)) and not isinstance(change, bool):
            facts.append(f"{float(change):+.2f}%")
    if facts:
        lines.append("｜".join(facts))
    if event_message:
        lines.append(_scrub(event_message)[:300])

    lines.append(
        f"{_local_text(incident.at_ms, rule.symbol)} · {rule.severity.value} · "
        f"第 {rule.fired_count} 次通知 · 规则 {rule.id}"
    )
    text = "\n".join(lines)
    if len(text) > _MAX_MESSAGE_CHARS:
        text = text[: _MAX_MESSAGE_CHARS - 1] + "…"
    return text


def _channel_manager() -> Any:
    """Return the running channel manager, or ``None`` when there is none.

    Resolved through the host ``api_server`` module the same way scheduled
    delivery does, so alerting works identically under the API server, the CLI
    runtime, and a test that installs its own host.
    """
    host = _sys.modules.get("api_server") or _sys.modules.get("agent.api_server")
    return getattr(host, "_channel_manager", None) if host else None


class DeliveryError(RuntimeError):
    """Raised when an alert cannot be pushed.

    Attributes:
        reason: Redaction-safe diagnostic stored on the incident row.
    """


async def send_alert_text(rule: AlertRule, text: str) -> Optional[str]:
    """Push one rendered alert to every address the rule names.

    Args:
        rule: The rule being announced.
        text: The rendered message.

    Returns:
        The first provider message id seen, or ``None`` when no address was
        configured (nothing to send, which is not a failure).

    Raises:
        DeliveryError: When no address accepted the message. Partial success is
            reported as success with the failing addresses logged, so a group
            that was deleted does not block the group that still works.
    """
    addresses = resolve_addresses(rule)
    if not addresses:
        return None

    manager = _channel_manager()
    if manager is None:
        raise DeliveryError("channel runtime is not running")

    from src.channels.bus.events import OutboundMessage

    first_id: Optional[str] = None
    failures: List[str] = []
    for address in addresses:
        adapter = manager.get_channel(address.channel)
        if adapter is None:
            failures.append(f"{address.channel}: not configured")
            continue
        try:
            receipt = await adapter.send_with_receipt(
                OutboundMessage(
                    channel=address.channel,
                    chat_id=address.target,
                    content=text,
                    metadata={"alert_rule_id": rule.id},
                )
            )
        except Exception as exc:  # noqa: BLE001 — the incident row records it
            logger.warning(
                "alert %s send failed on %s: %s", rule.id, address.channel, exc
            )
            failures.append(f"{address.channel}: {str(exc)[:160]}")
            continue
        provider_id = getattr(receipt, "provider_message_id", None)
        if first_id is None and provider_id:
            first_id = str(provider_id)

    if first_id is None and failures and len(failures) == len(addresses):
        raise DeliveryError("；".join(failures)[:300])
    if failures:
        logger.warning("alert %s partially delivered: %s", rule.id, "; ".join(failures))
    return first_id
