"""Tests for turnover cost and net-return accounting (G8)."""

from __future__ import annotations

import dataclasses
import math
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from src.quantlib.turnover import (
    AttributionSummary,
    attribution_summary,
    net_returns,
    trade_cost,
)

DATES = pd.date_range("2024-01-02", periods=4, freq="D")
COLS = ["A", "B"]


def frame(values, dates=None, columns=None):
    """Build a two-asset wide table from a list of rows."""
    dates = DATES[: len(values)] if dates is None else dates
    columns = COLS if columns is None else columns
    return pd.DataFrame(values, index=dates, columns=columns)


# ── hand-computed vectors ─────────────────────────────────────────────────


def test_vector_a_turnover_cost_and_cumulative():
    w = frame([[0.6, 0.4], [0.5, 0.5], [0.5, 0.5], [0.2, 0.8]])
    out = trade_cost(w, cost_bps=10.0)
    assert list(out.columns) == ["turnover", "cost", "cumulative_cost"]
    assert out.index.equals(w.index)
    np.testing.assert_allclose(out["turnover"], [0.5, 0.1, 0.0, 0.3], atol=1e-15)
    np.testing.assert_allclose(out["cost"], [0.0005, 0.0001, 0.0, 0.0003], atol=1e-15)
    np.testing.assert_allclose(
        out["cumulative_cost"], [0.0005, 0.0006, 0.0006, 0.0009], atol=1e-15
    )


def test_vector_a2_costs_are_charged_once_and_cumulative_is_monotone():
    w = frame([[0.6, 0.4], [0.5, 0.5], [0.5, 0.5], [0.2, 0.8]])
    out = trade_cost(w, cost_bps=10.0)
    assert out["turnover"].iloc[2] == 0.0
    assert out["cost"].iloc[2] == 0.0
    assert out["cumulative_cost"].iloc[2] == out["cumulative_cost"].iloc[1]
    assert (out["turnover"] >= 0.0).all()
    assert (out["cost"] >= 0.0).all()
    assert out["cumulative_cost"].is_monotonic_increasing


def test_vector_b_initial_weights_start_the_turnover_series():
    w = frame([[0.5, 0.5], [0.7, 0.3]])
    initial = pd.Series({"A": 0.5, "B": 0.5})
    out = trade_cost(w, cost_bps=10.0, initial_weights=initial)
    np.testing.assert_allclose(out["turnover"], [0.0, 0.2], atol=1e-15)
    np.testing.assert_allclose(out["cost"], [0.0, 0.0002], atol=1e-15)


def test_initial_weights_are_aligned_by_label_not_position():
    w = frame([[0.6, 0.4], [0.6, 0.4]])
    aligned = pd.Series({"A": 0.6, "B": 0.4})
    shuffled = pd.Series({"B": 0.4, "A": 0.6})
    out_aligned = trade_cost(w, cost_bps=10.0, initial_weights=aligned)
    out_shuffled = trade_cost(w, cost_bps=10.0, initial_weights=shuffled)
    pd.testing.assert_frame_equal(out_aligned, out_shuffled)
    np.testing.assert_allclose(out_shuffled["turnover"], [0.0, 0.0], atol=1e-15)


def test_vector_c1_impact_only():
    w = frame([[0.6, 0.4], [0.4, 0.6]])
    impact = frame([[0.001, 0.001], [0.002, 0.004]])
    out = trade_cost(w, cost_bps=0.0, impact=impact)
    np.testing.assert_allclose(out["turnover"], [0.5, 0.2], atol=1e-15)
    np.testing.assert_allclose(out["cost"], [0.0005, 0.0006], atol=1e-15)


def test_vector_c2_impact_plus_bps():
    w = frame([[0.6, 0.4], [0.4, 0.6]])
    impact = frame([[0.001, 0.001], [0.002, 0.004]])
    out = trade_cost(w, cost_bps=10.0, impact=impact)
    np.testing.assert_allclose(out["turnover"], [0.5, 0.2], atol=1e-15)
    np.testing.assert_allclose(out["cost"], [0.001, 0.0008], atol=1e-15)


def test_vector_d1_lag_one_shifts_weights_into_the_future():
    w = frame([[0.5, 0.5], [0.2, 0.8], [0.2, 0.8]])
    r = frame([[0.01, 0.02], [0.03, -0.01], [0.0, 0.02]])
    net = net_returns(w, r, trade_cost(w, cost_bps=10.0), lag=1)
    assert list(net.columns) == ["gross_return", "cost", "turnover", "net_return"]
    np.testing.assert_allclose(net["gross_return"], [0.0, 0.01, 0.016], atol=1e-15)
    np.testing.assert_allclose(net["turnover"], [0.5, 0.3, 0.0], atol=1e-15)
    np.testing.assert_allclose(net["net_return"], [-0.0005, 0.0097, 0.016], atol=1e-15)


def test_vector_d2_lag_zero_executes_same_day():
    w = frame([[0.5, 0.5], [0.2, 0.8], [0.2, 0.8]])
    r = frame([[0.01, 0.02], [0.03, -0.01], [0.0, 0.02]])
    net = net_returns(w, r, trade_cost(w, cost_bps=10.0), lag=0)
    np.testing.assert_allclose(net["gross_return"], [0.015, -0.002, 0.016], atol=1e-15)
    np.testing.assert_allclose(
        net["net_return"], [0.0145, -0.0023, 0.016], atol=1e-15
    )


def test_vector_d3_lag_beyond_panel_holds_no_weight():
    w = frame([[0.5, 0.5], [0.2, 0.8]])
    r = frame([[0.01, 0.02], [0.03, -0.01]])
    net = net_returns(w, r, trade_cost(w, cost_bps=10.0), lag=3)
    np.testing.assert_allclose(net["gross_return"], [0.0, 0.0], atol=1e-15)
    np.testing.assert_allclose(net["net_return"], [-0.0005, -0.0003], atol=1e-15)


def test_vector_e_attribution_summary():
    w = frame([[0.5, 0.5], [0.2, 0.8], [0.2, 0.8]])
    r = frame([[0.01, 0.02], [0.03, -0.01], [0.0, 0.02]])
    net = net_returns(w, r, trade_cost(w, cost_bps=10.0), lag=1)
    summary = attribution_summary(net)
    assert isinstance(summary, AttributionSummary)
    assert summary.total_gross == pytest.approx(0.026, abs=1e-15)
    assert summary.total_cost == pytest.approx(0.0008, abs=1e-15)
    assert summary.total_net == pytest.approx(0.0252, abs=1e-15)
    assert summary.cost_ratio == pytest.approx(2 / 65, rel=1e-12)
    assert summary.breakeven_bps == pytest.approx(325.0, abs=1e-9)


def test_vector_f_zero_turnover_has_no_breakeven_rate():
    w = frame([[0.5, 0.5], [0.5, 0.5]])
    r = frame([[0.01, 0.02], [0.01, 0.02]])
    initial = pd.Series({"A": 0.5, "B": 0.5})
    costs = trade_cost(w, cost_bps=10.0, initial_weights=initial)
    net = net_returns(w, r, costs, lag=1)
    np.testing.assert_allclose(net["gross_return"], [0.0, 0.015], atol=1e-15)
    np.testing.assert_allclose(net["cost"], [0.0, 0.0], atol=1e-15)
    np.testing.assert_allclose(net["net_return"], [0.0, 0.015], atol=1e-15)
    summary = attribution_summary(net)
    assert summary.total_gross == pytest.approx(0.015, abs=1e-15)
    assert summary.total_cost == 0.0
    assert summary.total_net == pytest.approx(0.015, abs=1e-15)
    assert summary.cost_ratio == 0.0
    assert math.isnan(summary.breakeven_bps)


def test_vector_g1_held_asset_missing_return_propagates():
    w = frame([[0.5, 0.0], [0.0, 0.5]])
    r = frame([[np.nan, 0.02], [np.nan, 0.02]])
    net = net_returns(w, r, trade_cost(w, cost_bps=0.0), lag=1)
    assert net["gross_return"].iloc[0] == 0.0
    assert math.isnan(net["gross_return"].iloc[1])
    assert math.isnan(net["net_return"].iloc[1])


def test_vector_g2_zero_weight_missing_return_is_masked():
    w = frame([[0.0, 0.5], [0.0, 0.5]])
    r = frame([[np.nan, 0.02], [np.nan, 0.02]])
    net = net_returns(w, r, trade_cost(w, cost_bps=0.0), lag=1)
    np.testing.assert_allclose(net["gross_return"], [0.0, 0.01], atol=1e-15)


def test_vector_g3_attribution_totals_propagate_nan():
    w = frame([[0.5, 0.0], [0.0, 0.5]])
    r = frame([[np.nan, 0.02], [np.nan, 0.02]])
    net = net_returns(w, r, trade_cost(w, cost_bps=0.0), lag=1)
    summary = attribution_summary(net)
    assert math.isnan(summary.total_gross)
    assert summary.total_cost == 0.0
    assert math.isnan(summary.total_net)
    assert math.isnan(summary.cost_ratio)
    assert math.isnan(summary.breakeven_bps)


def test_vector_h_identity_holds_with_impact():
    w = frame([[0.6, 0.4], [0.4, 0.6]])
    r = frame([[0.01, 0.02], [0.03, -0.01]])
    impact = frame([[0.001, 0.001], [0.002, 0.004]])
    costs = trade_cost(w, cost_bps=10.0, impact=impact)
    net = net_returns(w, r, costs, lag=1)
    np.testing.assert_allclose(
        net["net_return"], net["gross_return"] - net["cost"], atol=1e-12
    )


def test_vector_i_short_weights_turn_over_on_absolute_change():
    w = frame([[0.5, -0.5], [0.2, -0.2]])
    out = trade_cost(w, cost_bps=10.0)
    np.testing.assert_allclose(out["turnover"], [0.5, 0.3], atol=1e-15)
    np.testing.assert_allclose(out["cost"], [0.0005, 0.0003], atol=1e-15)


def test_vector_j1_changing_last_weights_leaves_prefix_untouched():
    w = frame([[0.5, 0.5], [0.2, 0.8], [0.2, 0.8]])
    r = frame([[0.01, 0.02], [0.03, -0.01], [0.0, 0.02]])
    base = net_returns(w, r, trade_cost(w, cost_bps=10.0), lag=1)
    changed = w.copy()
    changed.iloc[-1] = [0.9, 0.1]
    other = net_returns(changed, r, trade_cost(changed, cost_bps=10.0), lag=1)
    pd.testing.assert_series_equal(
        base["gross_return"].iloc[:-1], other["gross_return"].iloc[:-1]
    )
    pd.testing.assert_series_equal(
        base["net_return"].iloc[:-1], other["net_return"].iloc[:-1]
    )


def test_vector_j2_changing_last_returns_leaves_prefix_untouched():
    w = frame([[0.5, 0.5], [0.2, 0.8], [0.2, 0.8]])
    r = frame([[0.01, 0.02], [0.03, -0.01], [0.0, 0.02]])
    costs = trade_cost(w, cost_bps=10.0)
    base = net_returns(w, r, costs, lag=1)
    changed = r.copy()
    changed.iloc[-1] = [0.5, 0.5]
    other = net_returns(w, changed, costs, lag=1)
    pd.testing.assert_series_equal(
        base["gross_return"].iloc[:-1], other["gross_return"].iloc[:-1]
    )
    pd.testing.assert_series_equal(
        base["net_return"].iloc[:-1], other["net_return"].iloc[:-1]
    )


def test_vector_j3_lag_zero_change_touches_only_the_last_row():
    w = frame([[0.5, 0.5], [0.2, 0.8], [0.2, 0.8]])
    r = frame([[0.01, 0.02], [0.03, -0.01], [0.0, 0.02]])
    costs = trade_cost(w, cost_bps=0.0)
    base = net_returns(w, r, costs, lag=0)
    changed = r.copy()
    changed.iloc[-1] = [0.5, 0.5]
    other = net_returns(w, changed, costs, lag=0)
    pd.testing.assert_series_equal(
        base["gross_return"].iloc[:-1], other["gross_return"].iloc[:-1]
    )
    assert base["gross_return"].iloc[-1] != other["gross_return"].iloc[-1]


def test_vector_k_negative_gross_keeps_signs():
    w = frame([[0.5, 0.5], [0.5, 0.5]])
    r = frame([[-0.01, -0.02], [-0.01, -0.02]])
    net = net_returns(w, r, trade_cost(w, cost_bps=10.0), lag=0)
    summary = attribution_summary(net)
    assert summary.total_gross == pytest.approx(-0.03, abs=1e-15)
    assert summary.total_cost == pytest.approx(0.0005, abs=1e-15)
    assert summary.total_net == pytest.approx(-0.0305, abs=1e-15)
    assert summary.cost_ratio == pytest.approx(-1 / 60, rel=1e-12)
    assert summary.breakeven_bps == pytest.approx(-600.0, abs=1e-9)


# ── output surface, determinism, purity ───────────────────────────────────


def test_output_surface():
    w = frame([[0.5, 0.5], [0.2, 0.8]])
    r = frame([[0.01, 0.02], [0.03, -0.01]])
    costs = trade_cost(w, cost_bps=10.0)
    net = net_returns(w, r, costs, lag=1)
    assert list(costs.columns) == ["turnover", "cost", "cumulative_cost"]
    assert list(net.columns) == ["gross_return", "cost", "turnover", "net_return"]
    assert costs.index.equals(w.index)
    assert net.index.equals(w.index)


def test_attribution_summary_is_frozen_with_five_float_fields():
    w = frame([[0.5, 0.5], [0.2, 0.8]])
    r = frame([[0.01, 0.02], [0.03, -0.01]])
    net = net_returns(w, r, trade_cost(w, cost_bps=10.0), lag=1)
    summary = attribution_summary(net)
    names = [field.name for field in dataclasses.fields(AttributionSummary)]
    assert names == [
        "total_gross",
        "total_cost",
        "total_net",
        "cost_ratio",
        "breakeven_bps",
    ]
    for name in names:
        assert isinstance(getattr(summary, name), float)
    with pytest.raises(dataclasses.FrozenInstanceError):
        summary.total_gross = 0.0


def test_same_input_twice_is_bit_identical():
    w = frame([[0.6, 0.4], [0.5, 0.5], [0.2, 0.8]])
    r = frame([[0.01, 0.02], [0.03, -0.01], [0.0, 0.02]])
    impact = frame([[0.001, 0.001], [0.0005, 0.0005], [0.002, 0.002]])
    first_cost = trade_cost(w, cost_bps=5.0, impact=impact)
    first_net = net_returns(w, r, first_cost, lag=0)
    first_summary = attribution_summary(first_net)
    second_cost = trade_cost(w, cost_bps=5.0, impact=impact)
    second_net = net_returns(w, r, second_cost, lag=0)
    second_summary = attribution_summary(second_net)
    pd.testing.assert_frame_equal(first_cost, second_cost)
    pd.testing.assert_frame_equal(first_net, second_net)
    assert first_summary == second_summary


def test_inputs_are_not_modified():
    w = frame([[0.6, 0.4], [0.5, 0.5], [0.2, 0.8]])
    r = frame([[0.01, 0.02], [0.03, -0.01], [0.0, 0.02]])
    impact = frame([[0.001, 0.001], [0.0005, 0.0005], [0.002, 0.002]])
    snapshot = {
        name: value.copy(deep=True)
        for name, value in (("w", w), ("r", r), ("impact", impact))
    }
    costs = trade_cost(w, cost_bps=5.0, impact=impact)
    net_returns(w, r, costs, lag=0)
    assert w.equals(snapshot["w"])
    assert r.equals(snapshot["r"])
    assert impact.equals(snapshot["impact"])


def test_module_has_no_io_or_clock_imports():
    module_path = (
        Path(__file__).resolve().parents[2] / "src" / "quantlib" / "turnover.py"
    )
    source = module_path.read_text(encoding="utf-8")

    for token in ("import os", "import time", "open(", "os.environ", "random"):
        assert token not in source


# ── error contract ────────────────────────────────────────────────────────


def test_trade_cost_weights_container_contract():
    with pytest.raises(TypeError, match="weights must be a pandas DataFrame"):
        trade_cost([[0.5, 0.5]], cost_bps=0.0)
    bad_index = pd.DataFrame([[0.5, 0.5]], index=["2024-01-02"], columns=COLS)
    with pytest.raises(TypeError, match="DatetimeIndex"):
        trade_cost(bad_index, cost_bps=0.0)


def test_trade_cost_weights_shape_contract():
    no_rows = pd.DataFrame(index=pd.DatetimeIndex([]), columns=COLS, dtype=float)
    with pytest.raises(ValueError, match="cannot be empty"):
        trade_cost(no_rows)
    no_columns = pd.DataFrame(index=DATES[:1], dtype=float)
    with pytest.raises(ValueError, match="cannot be empty"):
        trade_cost(no_columns)


def test_trade_cost_weights_index_contract():
    duplicated = pd.DataFrame(
        [[0.5, 0.5], [0.4, 0.6]],
        index=pd.DatetimeIndex([DATES[0], DATES[0]]),
        columns=COLS,
    )
    with pytest.raises(ValueError, match="unique"):
        trade_cost(duplicated)
    unsorted = pd.DataFrame(
        [[0.5, 0.5], [0.4, 0.6]],
        index=pd.DatetimeIndex([DATES[1], DATES[0]]),
        columns=COLS,
    )
    with pytest.raises(ValueError, match="sorted ascending"):
        trade_cost(unsorted)


def test_trade_cost_weights_columns_contract():
    duplicated = pd.DataFrame([[0.5, 0.5]], index=DATES[:1], columns=["A", "A"])
    with pytest.raises(ValueError, match="columns must be unique"):
        trade_cost(duplicated)
    numeric = pd.DataFrame([[0.5, 0.5]], index=DATES[:1], columns=[1, 2])
    with pytest.raises(ValueError, match="non-empty strings"):
        trade_cost(numeric)
    blank = pd.DataFrame([[0.5, 0.5]], index=DATES[:1], columns=["", "A"])
    with pytest.raises(ValueError, match="non-empty strings"):
        trade_cost(blank)


def test_trade_cost_weights_values_must_be_finite_numeric():
    text = pd.DataFrame([["x", "y"]], index=DATES[:1], columns=COLS)
    with pytest.raises(ValueError, match="weights must be finite numeric"):
        trade_cost(text)
    infinite = pd.DataFrame([[0.5, np.inf]], index=DATES[:1], columns=COLS)
    with pytest.raises(ValueError, match="weights must be finite numeric"):
        trade_cost(infinite)


def test_trade_cost_bps_contract():
    w = frame([[0.5, 0.5]])
    with pytest.raises(TypeError, match="cost_bps"):
        trade_cost(w, cost_bps=True)
    with pytest.raises(TypeError, match="cost_bps"):
        trade_cost(w, cost_bps="10")
    with pytest.raises(ValueError, match="cost_bps"):
        trade_cost(w, cost_bps=-1.0)
    with pytest.raises(ValueError, match="cost_bps"):
        trade_cost(w, cost_bps=float("inf"))


def test_trade_cost_impact_contract():
    w = frame([[0.6, 0.4], [0.4, 0.6]])
    with pytest.raises(TypeError, match="impact must be a pandas DataFrame"):
        trade_cost(w, impact=[[0.0, 0.0], [0.0, 0.0]])
    wrong_index = frame([[0.0, 0.0], [0.0, 0.0]], dates=DATES[1:3])
    with pytest.raises(ValueError, match="impact must share"):
        trade_cost(w, impact=wrong_index)
    wrong_columns = frame([[0.0, 0.0], [0.0, 0.0]], columns=["A", "C"])
    with pytest.raises(ValueError, match="impact must share"):
        trade_cost(w, impact=wrong_columns)
    negative = frame([[0.0, -0.001], [0.0, 0.0]])
    with pytest.raises(ValueError, match="impact must be finite non-negative numeric"):
        trade_cost(w, impact=negative)
    non_finite = frame([[0.0, np.inf], [0.0, 0.0]])
    with pytest.raises(ValueError, match="impact must be finite non-negative numeric"):
        trade_cost(w, impact=non_finite)
    text = pd.DataFrame([["x", "y"], ["x", "y"]], index=DATES[:2], columns=COLS)
    with pytest.raises(ValueError, match="impact must be finite non-negative numeric"):
        trade_cost(w, impact=text)


def test_trade_cost_initial_weights_contract():
    w = frame([[0.6, 0.4], [0.4, 0.6]])
    with pytest.raises(TypeError, match="initial_weights must be a pandas Series"):
        trade_cost(w, initial_weights=[0.5, 0.5])
    wrong_names = pd.Series({"A": 0.5, "C": 0.5})
    with pytest.raises(ValueError, match="initial_weights must share"):
        trade_cost(w, initial_weights=wrong_names)
    duplicated = pd.Series([0.5, 0.5], index=["A", "A"])
    with pytest.raises(ValueError, match="initial_weights must share"):
        trade_cost(w, initial_weights=duplicated)
    text = pd.Series({"A": "x", "B": "y"})
    with pytest.raises(ValueError, match="initial_weights must be finite numeric"):
        trade_cost(w, initial_weights=text)
    non_finite = pd.Series({"A": 0.5, "B": np.nan})
    with pytest.raises(ValueError, match="initial_weights must be finite numeric"):
        trade_cost(w, initial_weights=non_finite)


def test_net_returns_table_container_contract():
    w = frame([[0.5, 0.5], [0.2, 0.8]])
    r = frame([[0.01, 0.02], [0.03, -0.01]])
    costs = trade_cost(w, cost_bps=10.0)
    with pytest.raises(TypeError, match="weights must be a pandas DataFrame"):
        net_returns([[0.5, 0.5]], r, costs)
    with pytest.raises(TypeError, match="asset_returns must be a pandas DataFrame"):
        net_returns(w, [[0.01, 0.02]], costs)
    with pytest.raises(TypeError, match="costs must be a pandas DataFrame"):
        net_returns(w, r, [[0.5, 0.0]])


def test_net_returns_alignment_contract():
    w = frame([[0.5, 0.5], [0.2, 0.8]])
    r = frame([[0.01, 0.02], [0.03, -0.01]])
    costs = trade_cost(w, cost_bps=10.0)
    shifted = frame([[0.01, 0.02], [0.03, -0.01]], dates=DATES[1:3])
    with pytest.raises(ValueError, match="asset_returns must share"):
        net_returns(w, shifted, costs)
    wrong_columns = frame([[0.01, 0.02], [0.03, -0.01]], columns=["A", "C"])
    with pytest.raises(ValueError, match="asset_returns must share"):
        net_returns(w, wrong_columns, costs)
    with pytest.raises(ValueError, match="costs must share"):
        net_returns(w, r, costs.iloc[::-1])


def test_net_returns_costs_columns_contract():
    w = frame([[0.5, 0.5], [0.2, 0.8]])
    r = frame([[0.01, 0.02], [0.03, -0.01]])
    costs = trade_cost(w, cost_bps=10.0)
    with pytest.raises(ValueError, match="turnover and cost"):
        net_returns(w, r, costs.drop(columns=["cost"]))
    with pytest.raises(ValueError, match="turnover and cost"):
        net_returns(w, r, costs.drop(columns=["turnover"]))


def test_net_returns_asset_returns_must_be_numeric():
    w = frame([[0.5, 0.5], [0.2, 0.8]])
    costs = trade_cost(w, cost_bps=10.0)
    text = pd.DataFrame([["x", "y"], ["x", "y"]], index=DATES[:2], columns=COLS)
    with pytest.raises(ValueError, match="asset_returns must be numeric"):
        net_returns(w, text, costs)


def test_net_returns_lag_contract():
    w = frame([[0.5, 0.5], [0.2, 0.8]])
    r = frame([[0.01, 0.02], [0.03, -0.01]])
    costs = trade_cost(w, cost_bps=10.0)
    with pytest.raises(TypeError, match="lag"):
        net_returns(w, r, costs, lag=True)
    with pytest.raises(TypeError, match="lag"):
        net_returns(w, r, costs, lag=1.0)
    with pytest.raises(ValueError, match="lag"):
        net_returns(w, r, costs, lag=-1)


def test_attribution_summary_contract():
    with pytest.raises(TypeError, match="net must be a pandas DataFrame"):
        attribution_summary([[0.1, 0.0, 0.1, 0.0]])
    empty = pd.DataFrame(columns=["gross_return", "cost", "turnover", "net_return"])
    with pytest.raises(ValueError, match="non-empty"):
        attribution_summary(empty)
    w = frame([[0.5, 0.5], [0.2, 0.8]])
    r = frame([[0.01, 0.02], [0.03, -0.01]])
    net = net_returns(w, r, trade_cost(w, cost_bps=10.0), lag=1)
    with pytest.raises(ValueError, match="gross_return, cost, turnover, net_return"):
        attribution_summary(net.drop(columns=["net_return"]))
    text = net.copy()
    text["cost"] = "x"
    with pytest.raises(ValueError, match="numeric"):
        attribution_summary(text)
