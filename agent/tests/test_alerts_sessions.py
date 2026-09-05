"""Session calendar used by ``session_only`` alert rules.

The gate exists so a rule does not fire on stale bars while its venue is shut,
and so a closed session can never be mistaken for "the condition cleared". US
equity and crypto answers are delegated to the runtime registry
(:mod:`src.live.runtime.triggers`) rather than re-derived here, which is why the
US cases below are assertions about *agreement*, not about wall-clock rules.
"""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from src.alerts.sessions import market_open, subject_market, symbol_market_is_open
from src.live.runtime.triggers import market_is_open_at


def _ms(*args: int) -> int:
    """Epoch ms for a UTC instant, e.g. ``_ms(2026, 9, 4, 3, 0)``."""
    return int(datetime(*args, tzinfo=timezone.utc).timestamp() * 1000)


# Friday 2026-09-04 and Saturday 2026-09-05, both non-holiday weekdays in CN/HK.
_OPEN_CN = _ms(2026, 9, 4, 3, 0)  # 11:00 Shanghai
_LUNCH_CN = _ms(2026, 9, 4, 4, 30)  # 12:30 Shanghai (still "open": one session)
_PRE_OPEN_CN = _ms(2026, 9, 4, 1, 0)  # 09:00 Shanghai
_CLOSED_CN = _ms(2026, 9, 4, 7, 30)  # 15:30 Shanghai
_SATURDAY_CN = _ms(2026, 9, 5, 3, 0)


@pytest.mark.parametrize(
    "moment,expected",
    [
        (_PRE_OPEN_CN, False),
        (_ms(2026, 9, 4, 1, 30), True),  # 09:30 sharp, the open is inclusive
        (_OPEN_CN, True),
        (_LUNCH_CN, True),
        (_ms(2026, 9, 4, 7, 0), False),  # 15:00 sharp, the close is exclusive
        (_CLOSED_CN, False),
        (_SATURDAY_CN, False),
    ],
)
def test_cn_session_is_weekday_morning_to_afternoon(moment: int, expected: bool) -> None:
    assert market_open("cn_equity", moment) is expected


def test_hk_session_runs_an_hour_longer_than_cn() -> None:
    assert market_open("hk_equity", _ms(2026, 9, 4, 7, 30)) is True  # 15:30 HKT
    assert market_open("hk_equity", _ms(2026, 9, 4, 8, 30)) is False  # 16:30 HKT
    assert market_open("hk_equity", _ms(2026, 9, 4, 1, 0)) is False  # 09:00 HKT


@pytest.mark.parametrize("moment", [_ms(2026, 9, 4, 3, 0), _ms(2026, 1, 1, 0, 0)])
def test_crypto_never_closes(moment: int) -> None:
    assert market_open("crypto", moment) is True


def test_us_equity_and_unknown_markets_are_answered_by_the_runtime_registry() -> None:
    """One owner for the US calendar, holidays included."""
    for moment in (_ms(2026, 9, 4, 14, 0), _ms(2026, 9, 4, 21, 0), _ms(2026, 12, 25, 15, 0)):
        assert market_open("us_equity", moment) == market_is_open_at("us_equity", moment)

    with pytest.raises(ValueError):
        market_open("not_a_market", _ms(2026, 9, 4, 3, 0))


@pytest.mark.parametrize(
    "symbol,market",
    [
        ("600519.SH", "cn_equity"),
        ("600519.SS", "cn_equity"),
        ("000001.SZ", "cn_equity"),
        ("830799.BJ", "cn_equity"),
        ("0700.HK", "hk_equity"),
        ("AAPL.US", "us_equity"),
        ("BTC-USDT", "crypto"),
        ("ETH-USDC", "crypto"),
        ("BTC/USD", None),  # no venue claimed, so no session judged
        ("AAPL", None),
        ("", None),
    ],
)
def test_subject_market_inference(symbol: str, market: str | None) -> None:
    assert subject_market(symbol) == market


def test_an_unqualified_symbol_is_treated_as_open() -> None:
    """Not knowing the venue must not silence a rule; it only drops the gate."""
    assert symbol_market_is_open("AAPL", _SATURDAY_CN) is True
    assert symbol_market_is_open("600519.SH", _SATURDAY_CN) is False
    assert symbol_market_is_open("BTC-USDT", _SATURDAY_CN) is True
