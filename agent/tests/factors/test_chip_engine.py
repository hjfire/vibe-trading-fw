"""Chip engine hand vectors (A-E) frozen from the G1 design.

Every expected number is derivable by hand; the derivation lives in
``superpowers/specs/2026-10-28-g1-chip-factors-design.md`` section 6.1.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from src.factors.chips import chip_metrics

INDEX = pd.bdate_range("2024-01-02", periods=200)
COLUMNS = ["X.SH"]


def _frame(values) -> pd.DataFrame:
    array = np.asarray(values, dtype=float)
    if array.ndim == 1:
        array = array[:, None]
    return pd.DataFrame(array, index=INDEX[: len(array)], columns=COLUMNS)


def _run(high, low, close, turnover, **kwargs) -> dict[str, pd.DataFrame]:
    return chip_metrics(_frame(high), _frame(low), _frame(close), _frame(turnover), **kwargs)


def test_vector_a_single_point_day() -> None:
    out = _run([10.0], [10.0], [10.0], [50.0])
    assert out["mass"].iloc[0, 0] == pytest.approx(0.5)
    assert out["avg_cost"].iloc[0, 0] == pytest.approx(10.0)
    assert out["cost_deviation"].iloc[0, 0] == pytest.approx(0.0)
    assert out["profit_ratio"].iloc[0, 0] == pytest.approx(1.0)
    assert out["concentration"].iloc[0, 0] == pytest.approx(0.0)
    assert np.isnan(out["concentration_change_20"].iloc[0, 0])


def test_vector_b_two_days_triangular_second_day() -> None:
    out = _run([10.0, 11.0], [10.0, 9.0], [10.0, 10.0], [50.0, 100.0])
    assert out["mass"].iloc[1, 0] == pytest.approx(1.0)
    assert out["avg_cost"].iloc[1, 0] == pytest.approx(10.0, abs=1e-9)
    assert out["cost_deviation"].iloc[1, 0] == pytest.approx(0.0, abs=1e-9)
    assert out["profit_ratio"].iloc[1, 0] == pytest.approx(0.5, abs=1e-9)
    assert out["concentration"].iloc[1, 0] == pytest.approx(0.0685, abs=2e-3)


def test_vector_c_missing_bar_carries_the_state() -> None:
    out = _run(
        [10.0, np.nan, 12.0],
        [10.0, np.nan, 12.0],
        [10.0, np.nan, 12.0],
        [50.0, np.nan, 50.0],
    )
    for metric in ("mass", "avg_cost", "cost_deviation", "profit_ratio", "concentration"):
        assert np.isnan(out[metric].iloc[1, 0]), metric
    assert out["mass"].iloc[2, 0] == pytest.approx(0.75)
    assert out["avg_cost"].iloc[2, 0] == pytest.approx(11.333333333333334, abs=1e-9)
    assert out["cost_deviation"].iloc[2, 0] == pytest.approx(0.05882352941176465, abs=1e-9)
    assert out["profit_ratio"].iloc[2, 0] == pytest.approx(1.0)
    assert out["concentration"].iloc[2, 0] == pytest.approx(0.09095, abs=1e-3)


def test_vector_d_constant_series_change_is_zero_at_row_20() -> None:
    n = 22
    out = _run([11.0] * n, [9.0] * n, [10.0] * n, [100.0] * n)
    assert np.isnan(out["concentration_change_20"].iloc[19, 0])
    assert out["concentration_change_20"].iloc[20, 0] == pytest.approx(0.0)
    assert out["concentration_change_20"].iloc[21, 0] == pytest.approx(0.0)


def test_vector_e_adaptive_step_coarsens_the_ladder() -> None:
    out = _run([40.0], [10.0], [20.0], [100.0], max_bins_per_day=100)
    assert out["mass"].iloc[0, 0] == pytest.approx(1.0)
    assert out["avg_cost"].iloc[0, 0] == pytest.approx(24.444444444444443, abs=1e-9)
    assert out["cost_deviation"].iloc[0, 0] == pytest.approx(-0.18181818181818177, abs=1e-9)
    assert out["profit_ratio"].iloc[0, 0] == pytest.approx(0.25005, abs=1e-9)
    assert out["concentration"].iloc[0, 0] == pytest.approx(0.4149151, abs=2e-3)


def test_symbols_are_computed_independently() -> None:
    high = pd.DataFrame(
        {"A.SH": [10.0, 11.0], "B.SH": [10.0, 10.0]},
        index=INDEX[:2],
    )
    low = pd.DataFrame(
        {"A.SH": [10.0, 9.0], "B.SH": [10.0, 10.0]},
        index=INDEX[:2],
    )
    close = pd.DataFrame(
        {"A.SH": [10.0, 10.0], "B.SH": [10.0, 10.0]},
        index=INDEX[:2],
    )
    turnover = pd.DataFrame(
        {"A.SH": [50.0, 100.0], "B.SH": [50.0, 100.0]},
        index=INDEX[:2],
    )
    out = chip_metrics(high, low, close, turnover)
    assert out["concentration"].iloc[1, 0] == pytest.approx(0.0685, abs=2e-3)
    assert out["profit_ratio"].iloc[1, 1] == pytest.approx(1.0)


def test_misaligned_frames_raise() -> None:
    high = _frame([10.0, 11.0])
    low = _frame([9.0, 10.0])
    close = _frame([10.0])
    turnover = _frame([10.0, 10.0])
    with pytest.raises(ValueError, match="aligned"):
        chip_metrics(high, low, close, turnover)
