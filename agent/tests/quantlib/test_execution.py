"""Hand-computed vectors for the participation-capped execution scheduler.

Every expected value here is a literal or a small fraction that was worked out
on paper from the frozen algorithm in the G9 spec, not read back from the
implementation. The vectors cover the four ways a schedule can end: filled on
the last day, truncated by ``max_days``, stopped by a sub-lot remainder, and
never started because ``adv`` is zero.
"""

from __future__ import annotations

import dataclasses
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from src.quantlib.execution import ExecutionPlan, schedule_trades

LABELS = ["A", "B", "C"]
MODULE = Path(__file__).resolve().parents[2] / "src" / "quantlib" / "execution.py"


def snap(**values) -> pd.Series:
    """Build a float Series from keyword arguments."""
    return pd.Series(values, dtype=float)


def base_plan(**overrides) -> ExecutionPlan:
    """Run the three-asset vector used by several tests."""
    kwargs = dict(
        target=snap(A=1000.0, B=-400.0, C=0.0),
        current=snap(A=100.0, B=0.0, C=50.0),
        adv=snap(A=4000.0, B=2000.0, C=1000.0),
    )
    kwargs.update(overrides)
    return schedule_trades(**kwargs)


def valid_kwargs(**overrides) -> dict:
    """A minimal valid call, with per-test overrides."""
    kwargs = dict(target=snap(A=100.0), current=snap(A=0.0), adv=snap(A=1000.0))
    kwargs.update(overrides)
    return kwargs


# ---------------------------------------------------------------------------
# Hand-computed vectors
# ---------------------------------------------------------------------------


def test_vector_a_basic_schedule():
    plan = base_plan()
    assert plan.trades.index.equals(pd.RangeIndex(1, 4))
    assert list(plan.trades.columns) == LABELS
    np.testing.assert_allclose(
        plan.trades.to_numpy(),
        [[400.0, -200.0, -50.0], [400.0, -200.0, 0.0], [100.0, 0.0, 0.0]],
        atol=1e-12,
    )
    np.testing.assert_allclose(plan.residual.to_numpy(), [0.0, 0.0, 0.0], atol=1e-12)
    np.testing.assert_allclose(plan.unfilled.to_numpy(), [0.0, 0.0, 0.0], atol=1e-12)
    np.testing.assert_allclose(
        plan.lot_residual.to_numpy(), [0.0, 0.0, 0.0], atol=1e-12
    )
    assert plan.days_used.to_dict() == {"A": 3, "B": 2, "C": 1}


def test_vector_b_horizon_truncation():
    plan = schedule_trades(
        target=snap(A=1000.0),
        current=snap(A=0.0),
        adv=snap(A=3000.0),
        max_days=2,
    )
    np.testing.assert_allclose(plan.trades["A"].to_numpy(), [300.0, 300.0])
    assert plan.residual["A"] == pytest.approx(400.0, abs=1e-12)
    assert plan.unfilled["A"] == pytest.approx(400.0, abs=1e-12)
    assert plan.lot_residual["A"] == pytest.approx(0.0, abs=1e-12)
    assert plan.days_used["A"] == 2
    assert len(plan.trades) == 2


def test_vector_c_partial_last_day():
    plan = schedule_trades(
        target=snap(A=750.0),
        current=snap(A=0.0),
        adv=snap(A=3000.0),
        max_days=5,
    )
    np.testing.assert_allclose(plan.trades["A"].to_numpy(), [300.0, 300.0, 150.0])
    assert plan.residual["A"] == pytest.approx(0.0, abs=1e-12)
    assert plan.days_used["A"] == 3
    assert len(plan.trades) == 3


def test_vector_d_lot_rounding_and_sub_lot_residual():
    plan = schedule_trades(
        target=snap(A=950.0),
        current=snap(A=0.0),
        adv=snap(A=4000.0),
        lot_size=100,
    )
    np.testing.assert_allclose(plan.trades["A"].to_numpy(), [400.0, 400.0, 100.0])
    assert plan.residual["A"] == pytest.approx(50.0, abs=1e-12)
    assert plan.unfilled["A"] == pytest.approx(0.0, abs=1e-12)
    assert plan.lot_residual["A"] == pytest.approx(50.0, abs=1e-12)
    assert plan.days_used["A"] == 3
    assert len(plan.trades) == 3


def test_vector_e_lot_and_horizon():
    plan = schedule_trades(
        target=snap(A=950.0),
        current=snap(A=0.0),
        adv=snap(A=4000.0),
        max_days=2,
        lot_size=100,
    )
    np.testing.assert_allclose(plan.trades["A"].to_numpy(), [400.0, 400.0])
    assert plan.residual["A"] == pytest.approx(150.0, abs=1e-12)
    assert plan.unfilled["A"] == pytest.approx(100.0, abs=1e-12)
    assert plan.lot_residual["A"] == pytest.approx(50.0, abs=1e-12)
    assert plan.days_used["A"] == 2


def test_vector_f_sub_lot_delta():
    plan = schedule_trades(
        target=snap(A=30.0),
        current=snap(A=0.0),
        adv=snap(A=1000.0),
        lot_size=100,
    )
    assert plan.trades.shape == (0, 1)
    assert plan.trades.index.equals(pd.RangeIndex(1, 1))
    assert plan.residual["A"] == pytest.approx(30.0, abs=1e-12)
    assert plan.unfilled["A"] == pytest.approx(0.0, abs=1e-12)
    assert plan.lot_residual["A"] == pytest.approx(30.0, abs=1e-12)
    assert plan.days_used["A"] == 0


def test_vector_g_zero_adv():
    plan = schedule_trades(
        target=snap(A=250.0),
        current=snap(A=0.0),
        adv=snap(A=0.0),
    )
    assert plan.trades.shape == (0, 1)
    assert plan.residual["A"] == pytest.approx(250.0, abs=1e-12)
    assert plan.unfilled["A"] == pytest.approx(250.0, abs=1e-12)
    assert plan.lot_residual["A"] == pytest.approx(0.0, abs=1e-12)
    assert plan.days_used["A"] == 0


def test_vector_h_short_cover():
    plan = schedule_trades(
        target=snap(A=-500.0),
        current=snap(A=200.0),
        adv=snap(A=3000.0),
    )
    np.testing.assert_allclose(plan.trades["A"].to_numpy(), [-300.0, -300.0, -100.0])
    assert plan.residual["A"] == pytest.approx(0.0, abs=1e-12)
    assert plan.days_used["A"] == 3


def test_vector_i_per_asset_lots():
    plan = schedule_trades(
        target=snap(A=450.0, B=-400.0),
        current=snap(A=0.0, B=0.0),
        adv=snap(A=4000.0, B=3000.0),
        lot_size=pd.Series({"A": 100, "B": 200}),
    )
    np.testing.assert_allclose(
        plan.trades.to_numpy(), [[400.0, -200.0], [0.0, -200.0]], atol=1e-12
    )
    assert list(plan.trades.columns) == ["A", "B"]
    assert plan.residual.to_dict() == pytest.approx({"A": 50.0, "B": 0.0})
    assert plan.unfilled.to_dict() == pytest.approx({"A": 0.0, "B": 0.0})
    assert plan.lot_residual.to_dict() == pytest.approx({"A": 50.0, "B": 0.0})
    assert plan.days_used.to_dict() == {"A": 1, "B": 2}
    assert len(plan.trades) == 2


def test_vector_j_label_alignment():
    canonical = schedule_trades(
        target=snap(A=1000.0, B=-400.0),
        current=snap(A=100.0, B=0.0),
        adv=snap(A=4000.0, B=2000.0),
    )
    shuffled = schedule_trades(
        target=snap(B=-400.0, A=1000.0),
        current=snap(A=100.0, B=0.0),
        adv=snap(B=2000.0, A=4000.0),
    )
    assert list(shuffled.trades.columns) == ["A", "B"]
    assert shuffled.trades.equals(canonical.trades)
    assert shuffled.residual.equals(canonical.residual)
    assert shuffled.unfilled.equals(canonical.unfilled)
    assert shuffled.lot_residual.equals(canonical.lot_residual)
    assert shuffled.days_used.equals(canonical.days_used)


def test_vector_k_invariants():
    plan = base_plan()
    delta = pd.Series({"A": 900.0, "B": -400.0, "C": -50.0})
    caps = pd.Series({"A": 400.0, "B": 200.0, "C": 100.0})
    traded = plan.trades.sum(axis=0)
    for asset in LABELS:
        assert np.abs(plan.trades[asset]).max() <= caps[asset] + 1e-12
        assert (np.sign(plan.trades[asset]) * np.sign(delta[asset]) >= 0).all()
        assert traded[asset] + plan.residual[asset] == pytest.approx(
            delta[asset], abs=1e-12
        )
        assert plan.unfilled[asset] + plan.lot_residual[asset] == pytest.approx(
            plan.residual[asset], abs=1e-12
        )
        assert plan.days_used[asset] == int((plan.trades[asset] != 0).sum())
    assert len(plan.trades) == int(plan.days_used.max())
    assert (plan.trades != 0.0).any(axis=1).all()


def test_vector_k_lot_trades_are_whole_lots():
    plan = schedule_trades(
        target=snap(A=950.0),
        current=snap(A=0.0),
        adv=snap(A=4000.0),
        lot_size=100,
    )
    for value in plan.trades["A"]:
        assert value % 100 == pytest.approx(0.0, abs=1e-12)


def test_vector_l_no_rebalance():
    same = snap(A=0.5, B=-0.25, C=0.0)
    plan = schedule_trades(
        target=same.copy(), current=same.copy(), adv=snap(A=1000.0, B=1000.0, C=1000.0)
    )
    assert plan.trades.shape == (0, 3)
    assert list(plan.trades.columns) == LABELS
    assert plan.residual.to_dict() == {"A": 0.0, "B": 0.0, "C": 0.0}
    assert plan.unfilled.to_dict() == {"A": 0.0, "B": 0.0, "C": 0.0}
    assert plan.lot_residual.to_dict() == {"A": 0.0, "B": 0.0, "C": 0.0}
    assert plan.days_used.to_dict() == {"A": 0, "B": 0, "C": 0}


# ---------------------------------------------------------------------------
# Output face, determinism and purity
# ---------------------------------------------------------------------------


def test_plan_is_frozen_dataclass_with_five_fields():
    assert dataclasses.is_dataclass(ExecutionPlan)
    assert ExecutionPlan.__dataclass_params__.frozen
    assert [field.name for field in dataclasses.fields(ExecutionPlan)] == [
        "trades",
        "residual",
        "unfilled",
        "lot_residual",
        "days_used",
    ]


def test_output_shapes_and_index_order():
    plan = base_plan()
    assert isinstance(plan.trades, pd.DataFrame)
    assert isinstance(plan.residual, pd.Series)
    assert list(plan.residual.index) == LABELS
    assert list(plan.unfilled.index) == LABELS
    assert list(plan.lot_residual.index) == LABELS
    assert list(plan.days_used.index) == LABELS
    assert plan.days_used.dtype == np.dtype(int)
    assert plan.trades.index.equals(pd.RangeIndex(1, len(plan.trades) + 1))


def test_same_inputs_produce_bitwise_equal_plans():
    first = base_plan(lot_size=pd.Series({"A": 100, "B": 100, "C": 100}))
    second = base_plan(lot_size=pd.Series({"A": 100, "B": 100, "C": 100}))
    assert first.trades.equals(second.trades)
    assert first.residual.equals(second.residual)
    assert first.unfilled.equals(second.unfilled)
    assert first.lot_residual.equals(second.lot_residual)
    assert first.days_used.equals(second.days_used)


def test_inputs_are_not_mutated():
    target = snap(A=950.0, B=-400.0)
    current = snap(A=100.0, B=0.0)
    adv = snap(A=4000.0, B=2000.0)
    lots = pd.Series({"A": 100, "B": 100})
    before = (target.copy(), current.copy(), adv.copy(), lots.copy())
    schedule_trades(
        target=target, current=current, adv=adv, lot_size=lots, max_days=2
    )
    for original, saved in zip((target, current, adv, lots), before):
        assert original.equals(saved)


def test_module_has_no_io_clock_or_randomness():
    source = MODULE.read_text(encoding="utf-8")
    for token in (
        "import os",
        "import time",
        "import random",
        "from datetime",
        "open(",
        "os.environ",
    ):
        assert token not in source


# ---------------------------------------------------------------------------
# Error contract
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "overrides, error",
    [
        ({"target": [100.0]}, TypeError),
        ({"current": [0.0]}, TypeError),
        ({"target": pd.Series(dtype=float)}, ValueError),
        ({"target": pd.Series([1.0, 2.0], index=["A", "A"])}, ValueError),
        ({"target": pd.Series([1.0, 2.0], index=[1, 2])}, ValueError),
        ({"target": pd.Series([1.0], index=[""])}, ValueError),
        ({"target": pd.Series(["x"], index=["A"])}, ValueError),
        ({"target": pd.Series([np.inf], index=["A"])}, ValueError),
        ({"current": pd.Series([0.0, 0.0], index=["A", "B"])}, ValueError),
        ({"current": pd.Series({"A": np.nan})}, ValueError),
    ],
)
def test_target_and_current_contract(overrides, error):
    with pytest.raises(error):
        schedule_trades(**valid_kwargs(**overrides))


@pytest.mark.parametrize(
    "overrides, error",
    [
        ({"adv": [1000.0]}, TypeError),
        ({"adv": snap(B=1000.0)}, ValueError),
        ({"adv": pd.Series([1000.0, 1000.0], index=["A", "A"])}, ValueError),
        ({"adv": pd.Series(["x"], index=["A"])}, ValueError),
        ({"adv": snap(A=np.inf)}, ValueError),
        ({"adv": snap(A=-1.0)}, ValueError),
    ],
)
def test_adv_contract(overrides, error):
    with pytest.raises(error):
        schedule_trades(**valid_kwargs(**overrides))


@pytest.mark.parametrize(
    "value, error",
    [
        ("0.1", TypeError),
        (True, TypeError),
        (0.0, ValueError),
        (-0.1, ValueError),
        (1.5, ValueError),
        (float("nan"), ValueError),
    ],
)
def test_max_participation_contract(value, error):
    with pytest.raises(error):
        schedule_trades(**valid_kwargs(max_participation=value))


@pytest.mark.parametrize(
    "value, error",
    [
        (2.0, TypeError),
        (True, TypeError),
        (0, ValueError),
        (-1, ValueError),
    ],
)
def test_max_days_contract(value, error):
    with pytest.raises(error):
        schedule_trades(**valid_kwargs(max_days=value))


@pytest.mark.parametrize(
    "value, error",
    [
        ("100", TypeError),
        (True, TypeError),
        (0, ValueError),
        (-5, ValueError),
        (pd.Series({"B": 100}), ValueError),
        (pd.Series([100, 100], index=["A", "A"]), ValueError),
        (pd.Series({"A": 100.5}), TypeError),
        (pd.Series({"A": 0}), ValueError),
    ],
)
def test_lot_size_contract(value, error):
    with pytest.raises(error):
        schedule_trades(**valid_kwargs(lot_size=value))
