"""The TradingView / Pine inbound bridge: symbol normalization and trust.

Two things are worth pinning hard here. A webhook is the one alerting entry point
that is not behind bearer auth, so the secret comparison's truth table is a
security contract. And a mis-normalized ticker is worse than an unmapped one:
``AAPL`` guessed as ``AAPL.US`` would make a session gate judge an unlisted name
by New York hours.
"""

from __future__ import annotations

import hashlib
from typing import Any, Dict, Optional

import pytest

from src.alerts.inbox import (
    SECRET_RE,
    InboundAlert,
    InboundAlertError,
    canonical_symbol,
    normalize_alert_event,
    secret_matches,
    secret_sha256,
)


# ---------------------------------------------------------------------------
# Symbol normalization
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw,exchange,expected",
    [
        # Venue named in the ticker.
        ("SSE:600519", None, "600519.SH"),
        ("SZSE:000001", None, "000001.SZ"),
        ("SZSE:1", None, "000001.SZ"),  # padded to the local six-digit form
        ("SHSE:600519", None, "600519.SH"),
        ("HKEX:9988", None, "9988.HK"),
        ("HKEX:700", None, "0700.HK"),  # HK writes four digits
        ("NASDAQ:AAPL", None, "AAPL.US"),
        ("BINANCE:BTCUSDT", None, "BTC-USDT"),
        ("BINANCE:ETHUSDT", None, "ETH-USDT"),
        ("COINBASE:BTCUSD", None, "BTC-USD"),
        # Venue in a separate field.
        ("600519", "SSE", "600519.SH"),
        ("600519", "szse", "600519.SZ"),  # the explicit venue wins
        ("0700.HK", "HKEX", "0700.HK"),  # already canonical, left alone
        ("BTCUSDT", "BINANCE", "BTC-USDT"),
        # A bare six-digit CN code determines its own exchange.
        ("600519", None, "600519.SH"),
        ("688981", None, "688981.SH"),
        ("000001", None, "000001.SZ"),
        ("300750", None, "300750.SZ"),
        ("830799", None, "830799.BJ"),
        # Crypto shapes that need no venue at all.
        ("BTC/USDT", None, "BTC-USDT"),
        ("BTC_USDT", None, "BTC-USDT"),
        ("BTC-USDT", None, "BTC-USDT"),
        ("ETHUSDT", None, "ETH-USDT"),
        # Already-suffixed forms pass through untouched.
        ("600519.SH", None, "600519.SH"),
        ("AAPL.US", None, "AAPL.US"),
        # Anything ambiguous keeps its own shape instead of a guessed venue.
        ("AAPL", None, "AAPL"),
        ("SPY", None, "SPY"),
        ("60051", None, "60051"),  # five digits is not a CN code
        ("FOOBAR:AAPL", None, "AAPL"),
        ("", None, ""),
        (None, None, ""),
        ("   ", None, ""),
    ],
)
def test_canonical_symbol(
    raw: Optional[str], exchange: Optional[str], expected: str
) -> None:
    assert canonical_symbol(raw, exchange) == expected


def test_a_prefixed_ticker_ignores_a_contradicting_venue_field() -> None:
    """The ticker's own prefix is the more specific claim."""
    assert canonical_symbol("SSE:600519", "SZSE") == "600519.SH"


# ---------------------------------------------------------------------------
# Secret handling
# ---------------------------------------------------------------------------


def test_secret_sha256_is_the_plain_hex_digest() -> None:
    assert secret_sha256("abc12345") == hashlib.sha256(b"abc12345").hexdigest()
    assert len(secret_sha256("abc12345")) == 64


def test_secret_truth_table() -> None:
    stored = secret_sha256("correct horse")
    assert secret_matches("correct horse", stored) is True
    assert secret_matches("wrong horse", stored) is False
    # A rule with no configured secret is unreachable, not wide open.
    assert secret_matches("anything", None) is False
    assert secret_matches(None, stored) is False
    assert secret_matches("", stored) is False
    assert secret_matches(None, None) is False


def test_a_leaked_hash_cannot_be_replayed_as_the_secret() -> None:
    """The route hashes what the sender presents, so the stored digest is not a
    password-equivalent: reading the store document does not hand out a working
    webhook URL."""
    stored = secret_sha256("abcdef12")
    assert secret_matches(stored, stored) is False
    assert secret_matches("abcdef12", stored) is True


@pytest.mark.parametrize("secret", ["short12", "a" * 129, "has space", "punct!!!", ""])
def test_rejected_secret_shapes(secret: str) -> None:
    assert SECRET_RE.fullmatch(secret) is None


@pytest.mark.parametrize("secret", ["abcdefgh", "A_b-c9_8_7", "x" * 128])
def test_accepted_secret_shapes(secret: str) -> None:
    assert SECRET_RE.fullmatch(secret) is not None


# ---------------------------------------------------------------------------
# Payload normalization
# ---------------------------------------------------------------------------


def test_a_tradingview_template_payload_becomes_an_event() -> None:
    event = normalize_alert_event(
        {
            "ticker": "SSE:600519",
            "exchange": "SSE",
            "price": 1712.5,
            "message": "收盘突破 1700",
            "time": 1_767_225_600_000,
            "interval": "D",
        },
        rule_id="tv-pine",
        now_ms=1,
    )
    assert event.rule_id == "tv-pine"
    assert event.symbol == "600519.SH"
    assert event.value == 1712.5
    assert event.message == "收盘突破 1700"
    assert event.at_ms == 1_767_225_600_000
    assert event.interval == "D"
    assert event.source == "tradingview"


@pytest.mark.parametrize("moment", [1_767_225_600, "1767225600"])
def test_seconds_scale_and_string_timestamps_are_normalized(
    moment: Any,
) -> None:
    """A 1970-dated alert is a bug someone must see, not a silent default."""
    event = normalize_alert_event({"time": moment}, rule_id="r", now_ms=7)
    assert event.at_ms == 1_767_225_600_000


def test_a_garbage_timestamp_falls_back_to_receive_time() -> None:
    event = normalize_alert_event({"time": "yesterday"}, rule_id="r", now_ms=7)
    assert event.at_ms == 7


def test_an_event_without_a_number_is_still_an_event() -> None:
    """``alert("my drawing got touched")`` is a legitimate sender."""
    event = normalize_alert_event({"message": "触碰到画线"}, rule_id="r", now_ms=42)
    assert event.value is None
    assert event.symbol == ""
    assert event.at_ms == 42
    assert event.message == "触碰到画线"


def test_price_can_come_from_several_template_keys() -> None:
    for key, expected in [
        ("price", 1.5),
        ("close", 2.5),
        ("value", 3.5),
        ("last", 4.5),
        ("current", 5.5),
    ]:
        event = normalize_alert_event({key: expected}, rule_id="r", now_ms=0)
        assert event.value == expected


def test_numbers_are_parsed_out_of_template_strings() -> None:
    event = normalize_alert_event(
        {"price": "1,712.50", "change_pct": "+2.31%"},
        rule_id="r",
        now_ms=0,
    )
    assert event.value == 1712.5
    assert event.change_pct == 2.31


def test_a_boolean_is_never_read_as_a_price() -> None:
    event = normalize_alert_event({"price": True, "value": 3}, rule_id="r", now_ms=0)
    assert event.value == 3


def test_symbol_keys_are_alternatives() -> None:
    for key in ("ticker", "symbol", "instrument"):
        event = normalize_alert_event({key: "SSE:600519"}, rule_id="r", now_ms=0)
        assert event.symbol == "600519.SH"


def test_message_is_length_bounded_and_stringified() -> None:
    long_event = normalize_alert_event({"message": "x" * 5000}, rule_id="r", now_ms=0)
    assert len(long_event.message) == 500
    odd = normalize_alert_event({"message": {"nested": 1}}, rule_id="r", now_ms=0)
    assert odd.message.startswith("{'nested'")


def test_a_plain_text_body_survives_as_a_message() -> None:
    event = normalize_alert_event({"text": "Alert triggered"}, rule_id="r", now_ms=3)
    assert event.message == "Alert triggered"


@pytest.mark.parametrize("payload", [None, "a string", 5, ["list"]])
def test_a_body_that_is_not_an_object_is_refused(payload: Any) -> None:
    with pytest.raises(InboundAlertError):
        normalize_alert_event(payload, rule_id="r", now_ms=0)


def test_event_values_feed_the_condition_evaluator() -> None:
    values: Dict[str, Any] = InboundAlert(
        rule_id="r", symbol="600519.SH", value=1712.5, change_pct=2.3, message="突破"
    ).as_event_values()
    assert values["price"] == 1712.5
    assert values["value"] == 1712.5
    assert values["change_pct"] == 2.3
