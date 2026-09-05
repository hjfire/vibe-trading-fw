"""Inbound alert events — the TradingView / Pine webhook bridge.

A Pine ``alert()`` on someone's chart already knows things this server cannot
compute cheaply: a custom indicator's own verdict, a drawing's touch, a strategy
fill. Rather than re-implement a Pine runtime, the rule of the same name accepts
that verdict as an event and forwards it to IM.

Trust model
-----------
The webhook route is deliberately *not* behind the API's bearer auth: TradingView
cannot present one. Its credential is a per-rule secret that the sender echoes
back inside the alert message. Only its SHA-256 hash is stored, the plaintext is
shown once at creation and is never readable afterwards, so a leaked store
document does not hand out a working webhook URL. The comparison is constant
time and the accepted shape matches the target-ref grammar used elsewhere in
this repo.

Symbol normalization
--------------------
TradingView writes ``SSE:600519`` / ``SZSE:000001`` / ``BINANCE:BTCUSDT``; this
project's canonical form is ``600519.SH`` / ``000001.SZ`` / ``BTC-USDT``. The
mapping below is exact where the payload names the venue, and rule-based only
for the one case that is unambiguous without a venue: a bare six-digit code,
whose first digits already determine the CN exchange. Anything else is passed
through unchanged rather than guessed at.
"""

from __future__ import annotations

import hashlib
import hmac
import re
from dataclasses import dataclass
from typing import Any, Mapping, Optional

#: Secret shape. Same grammar as the Telegram webhook secret token check in
#: ``src/channels/telegram.py`` and the target-ref rule in
#: ``src/channels/targets.py``: URL-safe, 8-128 characters.
SECRET_RE = re.compile(r"^[A-Za-z0-9_-]{8,128}$")

_CN_PREFIX_MARKET = {
    "6": ".SH",  # 600/601/603/605/688 main + STAR
    "9": ".SH",  # B shares
    "5": ".SH",  # funds
    "0": ".SZ",  # 000/001/002/003 main + SME
    "3": ".SZ",  # 300 ChiNext
    "1": ".SZ",  # funds / bonds
    "4": ".BJ",  # NEEQ / BSE
    "8": ".BJ",  # BSE
}

#: ``{{exchange}}`` / TV ticker-prefix -> this project's venue suffix.
_EXCHANGE_SUFFIX = {
    "SSE": ".SH",
    "SH": ".SH",
    "SHSE": ".SH",
    "SS": ".SH",
    "SZSE": ".SZ",
    "SZ": ".SZ",
    "BJSE": ".BJ",
    "BSE": ".BJ",
    "HKEX": ".HK",
    "HK": ".HK",
    "NASDAQ": ".US",
    "NYSE": ".US",
    "NYSEARCA": ".US",
    "AMEX": ".US",
    "OTC": ".US",
    "OTCPINK": ".US",
}

#: Venues whose pairs are crypto quotes; their symbols get the ``-USDT`` shape.
_CRYPTO_EXCHANGES = frozenset(
    {"BINANCE", "OKX", "BYBIT", "COINBASE", "KRAKEN", "BITFINEX", "GATEIO", "CRYPTO"}
)

_QUOTE_SEPARATORS = ("/", "-", ":", "_")

_STABLE_BASES = ("USDT", "USDC", "USD", "BUSD", "FDUSD", "TUSD", "DAI", "EUR")


@dataclass(frozen=True)
class InboundAlert:
    """A normalized event from an external alert sender.

    Attributes:
        rule_id: The rule this event belongs to (from the URL path).
        symbol: Canonical symbol when it could be determined, else the raw
            ticker as written by the sender.
        value: The numeric the sender reported (usually a close price).
        change_pct: Percentage change, when the sender included one.
        message: The sender's own alert text, already length-bounded.
        source: Which ecosystem sent this ("tradingview" today).
        at_ms: The sender's bar time, or the receive time when it sent none.
        interval: Sender's interval label, if any.
    """

    rule_id: str
    symbol: str = ""
    value: Optional[float] = None
    change_pct: Optional[float] = None
    message: str = ""
    source: str = "tradingview"
    at_ms: int = 0
    interval: str = ""

    def as_event_values(self) -> dict[str, Any]:
        """Return the mapping :func:`src.alerts.conditions.resolve_series` reads."""
        return {
            "value": self.value,
            "price": self.value,
            "change_pct": self.change_pct,
            "message": self.message,
            "source": self.source,
            "interval": self.interval,
        }


def secret_sha256(secret: str) -> str:
    """Return the hex SHA-256 of a webhook secret (what the store keeps).

    Args:
        secret: The plaintext secret.

    Returns:
        Lowercase hex digest.
    """
    return hashlib.sha256(str(secret).encode("utf-8")).hexdigest()


def secret_matches(candidate: Optional[str], stored_hash: Optional[str]) -> bool:
    """Constant-time check of a presented secret against the stored hash.

    Both sides must exist: a rule with no secret configured can never be
    triggered through this route, because "no secret" is not the same as "any
    secret is fine".

    Args:
        candidate: The secret the sender presented.
        stored_hash: The stored SHA-256 hex digest.

    Returns:
        ``True`` only when both are present and equal.
    """
    if not candidate or not stored_hash:
        return False
    presented = secret_sha256(str(candidate))
    return hmac.compare_digest(presented, str(stored_hash).lower())


def canonical_symbol(raw: Any, exchange: Any = None) -> str:
    """Normalize a sender's ticker into this project's canonical form.

    Args:
        raw: The ticker as written by the sender (``SSE:600519``, ``600519``,
            ``AAPL``, ``BTCUSDT``, ``BTC/USDT``, ``600519.SH`` ...).
        exchange: An explicit exchange label (``{{exchange}}``) when the sender
            provided one.

    Returns:
        A canonical symbol. Anything the rules below cannot classify comes back
        as the uppercased input, which keeps the alert usable and the venue
        unknown instead of wrong.
    """
    text = str(raw or "").strip().upper()
    if not text:
        return ""
    venue = str(exchange or "").strip().upper()

    # ``SSE:600519`` — the venue is inside the ticker itself.
    if ":" in text:
        head, _, tail = text.partition(":")
        if head in _EXCHANGE_SUFFIX:
            return _apply_suffix(tail.strip(), _EXCHANGE_SUFFIX[head])
        if head in _CRYPTO_EXCHANGES:
            return _crypto_symbol(tail.strip())
        # Unknown prefix: keep the tail's shape, do not invent a venue.
        text = tail.strip() or text

    if venue in _CRYPTO_EXCHANGES:
        return _crypto_symbol(text)
    if venue in _EXCHANGE_SUFFIX:
        return _apply_suffix(text, _EXCHANGE_SUFFIX[venue])

    for suffix in _EXCHANGE_SUFFIX.values():
        if text.endswith(suffix):
            return text

    if re.fullmatch(r"[0-9]{6}", text):
        return text + _CN_PREFIX_MARKET.get(text[0], "")

    if _looks_like_crypto(text):
        return _crypto_symbol(text)
    # A bare ``AAPL`` stays bare. The data loaders accept unqualified symbols,
    # and guessing ".US" would silently point an alert at the wrong venue —
    # worse, it would make the session gate start judging a non-US listing by
    # New York hours.
    return text


def _looks_like_crypto(text: str) -> bool:
    """Whether ``BTCUSDT`` / ``BTC_USDT`` / ``ETHUSD`` shape reads as a crypto pair."""
    if any(sep in text for sep in _QUOTE_SEPARATORS):
        base, quote = _split_pair(text)
        return quote in _STABLE_BASES or (base in _STABLE_BASES and quote)
    for base in _STABLE_BASES:
        if text.endswith(base) and len(text) > len(base):
            return True
    return False


def _split_pair(text: str) -> tuple[str, str]:
    """Split ``BTC/USDT`` into ``("BTC", "USDT")`` on any known separator."""
    for sep in _QUOTE_SEPARATORS:
        if sep in text:
            head, _, tail = text.partition(sep)
            return head.strip(), tail.strip()
    return text, ""


def _crypto_symbol(text: str) -> str:
    """Return ``BASE-QUOTE`` for a crypto pair in any of the sender's shapes."""
    clean = text.replace(" ", "")
    if "-" in clean:
        head, tail = clean.split("-", 1)
        return f"{head.upper()}-{tail.upper()}"
    for sep in ("/", "_", ":"):
        if sep in clean:
            head, tail = clean.split(sep, 1)
            return f"{head.upper()}-{tail.upper()}"
    for base in _STABLE_BASES:
        if clean.endswith(base) and len(clean) > len(base):
            return f"{clean[: -len(base)].upper()}-{base}"
    return text.upper()


def _apply_suffix(ticker: str, suffix: str) -> str:
    """Attach a venue suffix, zero-padding numeric tickers to the local form.

    ``SSE:600519`` and ``SZSE:1`` describe the same instrument; CN exchanges
    write six digits and HK writes four, so a short numeric code is padded
    before the suffix goes on rather than left as a lookup miss.
    """
    if not ticker:
        return ticker
    if ticker.endswith(suffix):
        return ticker
    if suffix == ".HK" and re.fullmatch(r"[0-9]{1,5}", ticker):
        return ticker.zfill(4) + ".HK"
    if suffix in (".SH", ".SZ", ".BJ") and re.fullmatch(r"[0-9]{1,5}", ticker):
        return ticker.zfill(6) + suffix
    return ticker + suffix


def _number(payload: Mapping[str, Any], *keys: str) -> Optional[float]:
    """First finite float found under *keys* (handles ``"1,234.5"`` strings)."""
    for key in keys:
        raw = payload.get(key)
        if raw is None or isinstance(raw, bool):
            continue
        if isinstance(raw, (int, float)):
            return float(raw)
        text = str(raw).replace(",", "").replace("%", "").strip()
        if not text:
            continue
        try:
            return float(text)
        except ValueError:
            continue
    return None


class InboundAlertError(ValueError):
    """Raised when a payload cannot be turned into a trustworthy event."""


def normalize_alert_event(
    payload: Optional[Mapping[str, Any]],
    *,
    rule_id: str,
    now_ms: int,
) -> InboundAlert:
    """Normalize a webhook body into an :class:`InboundAlert`.

    Accepts the shapes a TradingView alert can produce: a JSON object built from
    the alert template (``{"ticker": "{{ticker}}", "price": {{close}}, "message":
    "..."}``) or a plain string body sent as ``{"text": "..."}``. A number is
    optional — an alert that only says "my drawing got touched" is legitimate —
    but then the condition must not compare a value.

    Args:
        payload: The parsed JSON body.
        rule_id: The rule from the URL path.
        now_ms: Receive time, used when the sender carries no bar timestamp.

    Returns:
        The normalized event.

    Raises:
        InboundAlertError: When the body is not an object at all.
    """
    if payload is None:
        raise InboundAlertError("请求体为空")
    if not isinstance(payload, Mapping):
        raise InboundAlertError("请求体必须是 JSON 对象")

    message = payload.get("message") or payload.get("alert_message") or payload.get("text") or ""
    if not isinstance(message, str):
        message = str(message)
    symbol = canonical_symbol(
        payload.get("ticker") or payload.get("symbol") or payload.get("instrument") or "",
        payload.get("exchange") or payload.get("venue"),
    )
    value = _number(payload, "price", "close", "value", "last", "current")
    change = _number(payload, "change_pct", "percent", "change")
    at_raw = payload.get("time") or payload.get("server_time") or payload.get("timestamp")
    if isinstance(at_raw, str):
        # ``{{time}}`` interpolated into a quoted template slot arrives as text;
        # it is still the sender's bar time and must not degrade to receive time.
        digits = at_raw.strip()
        at_raw = int(digits) if digits.isdigit() else None
    at_ms = now_ms
    if isinstance(at_raw, (int, float)) and not isinstance(at_raw, bool):
        # TradingView's ``{{time}}`` is milliseconds; a seconds-scale value is
        # detected by magnitude so a 1970-dated alert cannot be shown.
        number = int(at_raw)
        at_ms = number if number > 10_000_000_000 else number * 1000
    interval = str(payload.get("interval") or payload.get("period") or "").strip()

    return InboundAlert(
        rule_id=rule_id,
        symbol=symbol,
        value=value,
        change_pct=change,
        message=message.strip()[:500],
        source="tradingview",
        at_ms=at_ms,
        interval=interval,
    )
