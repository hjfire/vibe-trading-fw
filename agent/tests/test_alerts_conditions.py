"""Condition evaluation for alert rules: the operator grammar and its failure modes.

The grammar is the frontend screener's (``frontend/src/lib/screener.ts``), so
these tests pin both the verdicts and, more importantly, the promise that a data
failure is reported as ``error`` and never as ``hit=False`` — an outage must not
look like a condition that cleared.
"""

from __future__ import annotations

from typing import Any, Dict, List

import pytest

from src.alerts.conditions import (
    EvalContext,
    describe_condition,
    evaluate_condition,
    resolve_series,
    series_label,
    shown_number,
)


def _bars(closes: List[float]) -> List[Dict[str, Any]]:
    """Build oldest-first OHLCV bars whose closes are *closes*."""
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


def _ctx(**overrides: Any) -> EvalContext:
    """An :class:`EvalContext` over a rising 4-bar series, overridable per test."""
    defaults: Dict[str, Any] = {
        "symbol": "600519.SH",
        "bars": _bars([1690.0, 1695.0, 1698.0, 1712.5]),
    }
    defaults.update(overrides)
    return EvalContext(**defaults)


# ---------------------------------------------------------------------------
# Series resolution
# ---------------------------------------------------------------------------


def test_close_series_exposes_last_and_prev() -> None:
    bundle = resolve_series("close", _ctx())
    assert bundle.ok
    assert (bundle.last, bundle.prev, bundle.bars) == (1712.5, 1698.0, 4)


def test_volume_and_ohlc_columns_resolve() -> None:
    ctx = _ctx()
    assert resolve_series("volume", ctx).last == 103.0
    assert resolve_series("high", ctx).last == 1713.5
    assert resolve_series("low", ctx).last == 1711.5


def test_missing_bars_is_an_error_not_a_zero() -> None:
    bundle = resolve_series("close", _ctx(bars=[]))
    assert bundle.error is not None
    assert bundle.last is None


def test_non_numeric_close_is_skipped_not_crashed() -> None:
    bars = _bars([1690.0, 1695.0]) + [{"timestamp": 9, "close": "n/a"}]
    bundle = resolve_series("close", _ctx(bars=bars))
    assert (bundle.last, bundle.bars) == (1695.0, 2)


def test_change_pct_uses_the_two_newest_bars() -> None:
    bundle = resolve_series("change_pct", _ctx())
    assert bundle.last == pytest.approx((1712.5 - 1698.0) / 1698.0 * 100.0)
    assert bundle.prev == pytest.approx((1698.0 - 1695.0) / 1695.0 * 100.0)


def test_change_pct_needs_two_bars() -> None:
    assert resolve_series("change_pct", _ctx(bars=_bars([10.0]))).error is not None


def test_indicators_need_enough_bars_and_report_shortfall() -> None:
    bundle = resolve_series("sma:20", _ctx(bars=_bars([1.0, 2.0, 3.0])))
    assert bundle.error is not None
    assert "20" in bundle.error


@pytest.mark.parametrize(
    "name,expected",
    [
        ("sma:3", 59.0),
        ("ema:3", None),
        ("rsi:3", 100.0),
        ("macd_line", None),
        ("macd_signal", None),
        ("macd_hist", None),
        ("bb_upper", None),
        ("bb_middle", None),
        ("bb_lower", None),
    ],
)
def test_indicator_series_names_resolve(name: str, expected: float | None) -> None:
    # Sixty rising bars: enough for every period the helpers default to, so an
    # ``error`` here means the wiring is wrong, not that the data is thin.
    bundle = resolve_series(name, _ctx(bars=_bars([float(i) for i in range(1, 61)])))
    assert bundle.error is None, bundle.error
    assert bundle.last is not None
    if expected is not None:
        assert bundle.last == pytest.approx(expected)
    if name == "bb_upper":
        assert bundle.last > 60.0
    if name == "bb_lower":
        assert bundle.last < 60.0


def test_rsi_period_defaults_to_14_and_labels_keep_the_period() -> None:
    assert resolve_series("rsi", _ctx(bars=_bars(list(range(1, 30))))).last == pytest.approx(100.0)
    assert series_label("rsi:14") == "RSI(14)"
    assert series_label("sma:20") == "均线(20)"
    assert series_label("bb_upper") == "布林上轨"
    assert series_label("close") == "收盘"
    assert series_label("mystery_indicator") == "mystery_indicator"


def test_rejected_period_bounds_raise() -> None:
    with pytest.raises(ValueError):
        resolve_series("sma:0", _ctx())
    with pytest.raises(ValueError):
        resolve_series("sma:abc", _ctx())


def test_unknown_series_name_is_an_error() -> None:
    assert resolve_series("nope", _ctx()).error is not None
    assert resolve_series("", _ctx()).error is not None


# ---------------------------------------------------------------------------
# Portfolio and account series
# ---------------------------------------------------------------------------

POSITION = {
    "symbol": "600519",
    "cost_price": 1600.0,
    "market_price": 1712.5,
    "quantity": 100,
    "market_value_usd": 23500.0,
}


def test_pnl_pct_is_measured_on_the_holding() -> None:
    result = evaluate_condition(
        {"op": "gt", "lhs": "pnl_pct", "value": 5}, _ctx(positions=[POSITION])
    )
    assert result.hit
    assert result.value == pytest.approx(7.03125)


def test_position_series_errors_when_the_holding_is_absent() -> None:
    """A rule about a name not held is *unknown*, never "false"."""
    result = evaluate_condition({"op": "gt", "lhs": "pnl_pct", "value": 5}, _ctx())
    assert not result.hit
    assert result.error is not None
    assert "600519.SH" in result.error


@pytest.mark.parametrize(
    "rule_symbol,broker_symbol",
    [
        ("600519.SH", "600519"),
        ("0700.HK", "700.HK"),
        ("AAPL.US", "AAPL"),
        ("BTC-USDT", "BTCUSDT"),
    ],
)
def test_holdings_match_rules_across_broker_symbol_shapes(
    rule_symbol: str, broker_symbol: str
) -> None:
    row = dict(POSITION, symbol=broker_symbol)
    ctx = _ctx(symbol=rule_symbol, positions=[row])
    assert ctx.position(rule_symbol) is not None
    assert resolve_series("cost_price", ctx).last == 1600.0


def test_equity_history_is_read_oldest_first() -> None:
    history = [
        {"total_usd": 100_000.0, "total_cny": 700_000.0, "created_at": 1},
        {"total_usd": 120_000.0, "total_cny": 840_000.0, "created_at": 2},
        {"total_usd": 90_000.0, "total_cny": 630_000.0, "created_at": 3},
    ]
    ctx = _ctx(account_history=history)
    assert resolve_series("equity_usd", ctx).last == 90_000.0
    assert resolve_series("equity_usd", ctx).prev == 120_000.0
    assert resolve_series("equity_cny", ctx).last == 630_000.0


def test_drawdown_is_measured_from_the_account_high_water_mark() -> None:
    history = [
        {"total_usd": 100_000.0},
        {"total_usd": 120_000.0},
        {"total_usd": 90_000.0},
    ]
    bundle = resolve_series("drawdown_pct", _ctx(account_history=history))
    assert bundle.last == pytest.approx((90_000.0 - 120_000.0) / 120_000.0 * 100.0)
    assert bundle.prev == pytest.approx(0.0)  # 120k was the peak one row ago


def test_account_series_without_snapshots_errors() -> None:
    assert resolve_series("equity_usd", _ctx()).error is not None
    assert resolve_series("drawdown_pct", _ctx(account_history=[{"total_usd": 1}])).error is not None


# ---------------------------------------------------------------------------
# Operators
# ---------------------------------------------------------------------------


def test_gt_and_lt_against_a_constant() -> None:
    ctx = _ctx()
    assert evaluate_condition({"op": "gt", "lhs": "close", "value": 1700}, ctx).hit
    assert not evaluate_condition({"op": "gt", "lhs": "close", "value": 1800}, ctx).hit
    assert evaluate_condition({"op": "lt", "lhs": "close", "value": 1800}, ctx).hit


def test_gt_and_lt_against_another_series() -> None:
    ctx = _ctx()
    assert evaluate_condition({"op": "gt", "lhs": "close", "rhs": "sma:3"}, ctx).hit
    assert not evaluate_condition({"op": "lt", "lhs": "close", "rhs": "sma:3"}, ctx).hit


def test_cross_up_requires_being_below_before_and_above_now() -> None:
    ctx = _ctx()
    hit = evaluate_condition({"op": "crossUp", "lhs": "close", "value": 1700}, ctx)
    assert hit.hit and hit.value == 1712.5
    # 1690 was below, 1695 is below, 1698 below, 1712.5 above: a real crossing.
    # A level already breached two bars ago must not re-cross.
    assert not evaluate_condition({"op": "crossUp", "lhs": "close", "value": 1600}, ctx).hit


def test_cross_down_is_the_mirror() -> None:
    ctx = _ctx(bars=_bars([1690.0, 1695.0, 1712.5, 1690.0]))
    assert evaluate_condition({"op": "crossDown", "lhs": "close", "value": 1700}, ctx).hit
    assert not evaluate_condition({"op": "crossUp", "lhs": "close", "value": 1700}, ctx).hit


def test_a_level_breached_earlier_does_not_cross_again() -> None:
    """Only the newest bar may make the edge — a wick two bars back is history."""
    ctx = _ctx(bars=_bars([1750.0, 1760.0, 1755.0, 1762.0]))
    assert not evaluate_condition({"op": "crossUp", "lhs": "close", "value": 1700}, ctx).hit


def test_crossing_two_series_uses_both_previous_values() -> None:
    # Last bar jumps above the 3-bar mean (30 > 16.67) while the previous close
    # sat at the previous mean (10 <= 10): a genuine golden-cross shape.
    ctx = _ctx(bars=_bars([10.0, 10.0, 10.0, 30.0]))
    assert evaluate_condition({"op": "crossUp", "lhs": "close", "rhs": "sma:3"}, ctx).hit
    flat = _ctx(bars=_bars([10.0, 10.0, 10.0, 10.0]))
    assert not evaluate_condition({"op": "crossUp", "lhs": "close", "rhs": "sma:3"}, flat).hit


def test_rising_and_falling_compare_the_two_newest_points() -> None:
    ctx = _ctx()
    assert evaluate_condition({"op": "rising", "lhs": "close"}, ctx).hit
    assert not evaluate_condition({"op": "falling", "lhs": "close"}, ctx).hit
    assert evaluate_condition(
        {"op": "falling", "lhs": "close"}, _ctx(bars=_bars([1712.5, 1690.0]))
    ).hit


def test_single_point_series_cannot_show_a_slope() -> None:
    result = evaluate_condition(
        {"op": "rising", "lhs": "pnl_pct"}, _ctx(positions=[POSITION])
    )
    assert not result.hit
    assert result.error is not None


def test_unary_and_empty_operators() -> None:
    ctx = _ctx()
    assert evaluate_condition({"op": "nonEmpty", "lhs": "close"}, ctx).hit
    assert evaluate_condition({"op": "truthy", "lhs": "close"}, ctx).hit
    assert not evaluate_condition(
        {"op": "truthy", "lhs": "close"}, _ctx(bars=_bars([-1.0, -2.0]))
    ).hit


def test_unsupported_operator_is_reported_as_an_error() -> None:
    result = evaluate_condition({"op": "equals", "lhs": "close", "value": 1}, _ctx())
    assert not result.hit
    assert "equals" in (result.error or "")


def test_a_series_failure_surfaces_through_the_verdict() -> None:
    result = evaluate_condition({"op": "gt", "lhs": "close", "rhs": "sma:50"}, _ctx())
    assert not result.hit
    assert result.error is not None


def test_context_errors_are_reported_when_no_value_exists() -> None:
    """A dead data vendor must not be able to "resolve" a firing rule."""
    ctx = _ctx(bars=[], errors=["行情读取失败：timeout"])
    result = evaluate_condition({"op": "gt", "lhs": "close", "value": 1}, ctx)
    assert not result.hit
    assert "timeout" in (result.error or "")


def test_event_series_reads_the_inbound_payload() -> None:
    ctx = _ctx(event={"price": 1712.5, "change_pct": 2.3})
    assert resolve_series("event_price", ctx).last == 1712.5
    assert resolve_series("event_change_pct", ctx).last == 2.3
    assert resolve_series("event_value", ctx).last == 1712.5
    assert resolve_series("event_value", _ctx()).error is not None


# ---------------------------------------------------------------------------
# Labels
# ---------------------------------------------------------------------------


def test_describe_condition_is_never_empty() -> None:
    assert describe_condition({"op": "crossUp", "lhs": "close", "value": 1700}) == "收盘 上穿 1700"
    assert describe_condition({"op": "gt", "lhs": "rsi:14", "value": 70}) == "RSI(14) >70"
    assert describe_condition({"op": "truthy", "lhs": "pnl_pct"}) == "浮盈 为真"
    assert describe_condition({}) == "? ?"


def test_shown_number_is_compact_and_handles_empty() -> None:
    assert shown_number(1712.5) == "1712.5"
    assert shown_number(1712.0) == "1712"
    assert shown_number(0.00004) == "0"
    assert shown_number(None) == "空"
