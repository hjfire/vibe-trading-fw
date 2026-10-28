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


def _triangular_cdf_point(x: float, low: float, mode: float, high: float) -> float:
    if high <= low:
        return 1.0 if x >= low else 0.0
    mode = min(max(mode, low), high)
    if x <= low:
        return 0.0
    if x >= high:
        return 1.0
    if x <= mode:
        return (x - low) ** 2 / ((high - low) * (mode - low))
    return 1.0 - (high - x) ** 2 / ((high - low) * (high - mode))


def _oracle_day(high, low, close, turnover, day: int, coverage: float = 0.90) -> dict[str, float]:
    """Continuous mixture for ``day``: no price grid, weights rebuilt per day."""
    turnover = np.asarray(turnover, dtype=float)
    high = np.asarray(high, dtype=float)
    low = np.asarray(low, dtype=float)
    close = np.asarray(close, dtype=float)
    valid = (
        np.isfinite(high)
        & np.isfinite(low)
        & np.isfinite(close)
        & np.isfinite(turnover)
        & (high >= low)
        & (low > 0)
        & (turnover >= 0)
    )
    u = np.clip(turnover / 100.0, 0.0, 1.0)
    weights = np.zeros(day + 1)
    for i in range(day, -1, -1):
        if not valid[i]:
            continue
        weight = u[i]
        for k in range(i + 1, day + 1):
            if valid[k]:
                weight *= 1.0 - u[k]
        weights[i] = weight
    mass = float(weights.sum())
    modes = [
        min(max((high[i] + low[i] + close[i]) / 3.0, low[i]), high[i])
        for i in range(day + 1)
    ]
    means = [(high[i] + low[i] + modes[i]) / 3.0 for i in range(day + 1)]
    average = float(sum(weights[i] * means[i] for i in range(day + 1)) / mass)
    profit = float(
        sum(
            weights[i] * _triangular_cdf_point(close[day], low[i], modes[i], high[i])
            for i in range(day + 1)
            if valid[i]
        )
        / mass
    )

    def mixture_cdf(x: float) -> float:
        return float(
            sum(
                weights[i] * _triangular_cdf_point(x, low[i], modes[i], high[i])
                for i in range(day + 1)
                if valid[i]
            )
            / mass
        )

    tail = (1.0 - coverage) / 2.0
    floor_price = min(low[i] for i in range(day + 1) if valid[i])
    ceiling_price = max(high[i] for i in range(day + 1) if valid[i])

    def quantile(q: float) -> float:
        left, right = floor_price, ceiling_price
        for _ in range(60):
            middle = (left + right) / 2.0
            if mixture_cdf(middle) < q:
                left = middle
            else:
                right = middle
        return (left + right) / 2.0

    q_low = quantile(tail)
    q_high = quantile(1.0 - tail)
    return {
        "mass": mass,
        "avg_cost": average,
        "cost_deviation": (close[day] - average) / average,
        "profit_ratio": profit,
        "concentration": (q_high - q_low) / (q_high + q_low),
    }


def _cent_panel(n_rows: int = 60, n_symbols: int = 3, seed: int = 11):
    rng = np.random.default_rng(seed)
    index = pd.bdate_range("2023-03-01", periods=n_rows)
    columns = [f"S{i}.SH" for i in range(n_symbols)]
    close_cents = np.clip(
        1200 + np.cumsum(rng.integers(-30, 31, size=(n_rows, n_symbols)), axis=0),
        800,
        1500,
    )
    high_cents = close_cents + rng.integers(0, 50, size=(n_rows, n_symbols))
    low_cents = np.maximum(
        close_cents - rng.integers(0, 50, size=(n_rows, n_symbols)), 1
    )

    def frame(values):
        return pd.DataFrame(values, index=index, columns=columns)

    return (
        frame(high_cents / 100.0),
        frame(low_cents / 100.0),
        frame(close_cents / 100.0),
        frame(rng.uniform(0.2, 20.0, size=(n_rows, n_symbols))),
        index,
        columns,
    )


ORACLE_TOLERANCES = {
    "mass": 1e-12,
    "avg_cost": 1e-9,
    "cost_deviation": 1e-9,
    "profit_ratio": 1e-9,
    "concentration": 2e-3,
}


def test_continuous_oracle_matches_on_cent_quoted_panels() -> None:
    high, low, close, turnover, index, columns = _cent_panel()
    out = chip_metrics(high, low, close, turnover)
    high_values = high.to_numpy()
    low_values = low.to_numpy()
    close_values = close.to_numpy()
    turnover_values = turnover.to_numpy()
    for day in range(len(index)):
        for position, symbol in enumerate(columns):
            expected = _oracle_day(
                high_values[:, position],
                low_values[:, position],
                close_values[:, position],
                turnover_values[:, position],
                day,
            )
            for metric, tolerance in ORACLE_TOLERANCES.items():
                actual = out[metric].iloc[day, position]
                assert actual == pytest.approx(expected[metric], abs=tolerance, rel=0), (
                    symbol,
                    day,
                    metric,
                    actual,
                    expected[metric],
                )


def test_prefix_equals_full_history() -> None:
    high, low, close, turnover, _, _ = _cent_panel(n_rows=120, n_symbols=3, seed=23)
    full = chip_metrics(high, low, close, turnover)
    prefix = chip_metrics(
        high.iloc[:80], low.iloc[:80], close.iloc[:80], turnover.iloc[:80]
    )
    for metric in (
        "mass",
        "avg_cost",
        "cost_deviation",
        "profit_ratio",
        "concentration",
        "concentration_change_20",
    ):
        pd.testing.assert_frame_equal(
            prefix[metric],
            full[metric].iloc[:80],
            check_exact=False,
            rtol=0,
            atol=1e-12,
        )


def test_future_bars_do_not_change_past_values() -> None:
    high, low, close, turnover, _, _ = _cent_panel(n_rows=120, n_symbols=3, seed=29)
    baseline = chip_metrics(high, low, close, turnover)
    corrupted_high = high.copy()
    corrupted_low = low.copy()
    corrupted_close = close.copy()
    corrupted_turnover = turnover.copy()
    corrupted_high.iloc[60:] = 999.0
    corrupted_low.iloc[60:] = 1.0
    corrupted_close.iloc[60:] = 500.0
    corrupted_turnover.iloc[60:] = 99.0
    corrupted = chip_metrics(
        corrupted_high, corrupted_low, corrupted_close, corrupted_turnover
    )
    for metric in (
        "mass",
        "avg_cost",
        "cost_deviation",
        "profit_ratio",
        "concentration",
        "concentration_change_20",
    ):
        pd.testing.assert_frame_equal(
            baseline[metric].iloc[:60],
            corrupted[metric].iloc[:60],
            check_exact=False,
            rtol=0,
            atol=1e-12,
        )


def test_invalid_bars_are_nan_and_leave_the_state_untouched() -> None:
    high = [10.0, 9.0, 11.0, 10.0, 12.0]
    low = [10.0, 10.0, 9.0, 0.0, 12.0]
    close = [10.0, 9.5, 10.0, 10.0, 12.0]
    turnover = [50.0, 10.0, -1.0, 10.0, 50.0]
    out = _run(high, low, close, turnover)
    for row in (1, 2, 3):
        assert np.isnan(out["mass"].iloc[row, 0]), row
    reference = _run([10.0, 12.0], [10.0, 12.0], [10.0, 12.0], [50.0, 50.0])
    for metric in ("mass", "avg_cost", "cost_deviation", "profit_ratio", "concentration"):
        assert out[metric].iloc[4, 0] == pytest.approx(
            reference[metric].iloc[1, 0], abs=1e-12
        ), metric


def test_span_cap_raises_instead_of_coarsening() -> None:
    with pytest.raises(ValueError, match="spans 21 cent bins"):
        _run([1.2], [1.0], [1.1], [10.0], max_span_bins=20)
