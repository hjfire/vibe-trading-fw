"""Chip signal hand vectors: hit, miss, mask and arm separation."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from src.factors.chip_signals import (
    chip_capital_resonance,
    chip_squeeze_buildup,
    chip_volume_price_divergence,
)

INDEX = pd.bdate_range("2024-01-02", periods=90)
COLUMNS = ["A.SH", "B.SH"]


def _frame(values) -> pd.DataFrame:
    array = np.asarray(values, dtype=float)
    if array.ndim == 1:
        array = np.repeat(array[:, None], len(COLUMNS), axis=1)
    return pd.DataFrame(array, index=INDEX[: len(array)], columns=COLUMNS)


def test_squeeze_fires_when_concentration_falls_with_price_at_cost() -> None:
    concentration = np.full(25, 0.2)
    concentration[21:] = 0.1
    out = chip_squeeze_buildup(
        _frame(concentration), _frame(np.full(25, 0.0)), _frame(np.full(25, 0.5))
    )
    assert np.isnan(out.iloc[:20].to_numpy()).all()
    assert out.iloc[20, 0] == 0.0
    assert (out.iloc[21:].to_numpy() == 1.0).all()


def test_squeeze_arms_are_independent() -> None:
    concentration = np.full(25, 0.2)
    concentration[21:] = 0.1
    assert (
        chip_squeeze_buildup(
            _frame(concentration), _frame(np.full(25, 0.2)), _frame(np.full(25, 0.5))
        ).iloc[21, 0]
        == 0.0
    )
    assert (
        chip_squeeze_buildup(
            _frame(concentration), _frame(np.full(25, 0.0)), _frame(np.full(25, 0.8))
        ).iloc[21, 0]
        == 0.0
    )
    rising = np.full(25, 0.2)
    rising[21:] = 0.3
    assert (
        chip_squeeze_buildup(
            _frame(rising), _frame(np.full(25, 0.0)), _frame(np.full(25, 0.5))
        ).iloc[21, 0]
        == 0.0
    )
    missing = np.full(26, 0.2)
    missing[5] = np.nan
    out = chip_squeeze_buildup(
        _frame(missing), _frame(np.full(26, 0.0)), _frame(np.full(26, 0.5))
    )
    assert np.isnan(out.iloc[5, 0])
    assert np.isnan(out.iloc[25, 0])


def test_resonance_requires_volume_profit_and_price_above_cost() -> None:
    turnover = np.full(25, 0.01)
    turnover[20:] = 0.03
    out = chip_capital_resonance(
        _frame(turnover), _frame(np.full(25, 0.7)), _frame(np.full(25, 0.01))
    )
    assert np.isnan(out.iloc[:20].to_numpy()).all()
    assert (out.iloc[20:].to_numpy() == 1.0).all()
    assert (
        chip_capital_resonance(
            _frame(turnover), _frame(np.full(25, 0.5)), _frame(np.full(25, 0.01))
        ).iloc[20, 0]
        == 0.0
    )
    assert (
        chip_capital_resonance(
            _frame(turnover), _frame(np.full(25, 0.7)), _frame(np.full(25, 0.0))
        ).iloc[20, 0]
        == 0.0
    )
    calm = np.full(25, 0.01)
    assert (
        chip_capital_resonance(
            _frame(calm), _frame(np.full(25, 0.7)), _frame(np.full(25, 0.01))
        ).iloc[24, 0]
        == 0.0
    )


def test_divergence_high_and_low_arms() -> None:
    n = 80
    close = np.full(n, 10.0)
    high = np.full(n, 10.0)
    low = np.full(n, 9.0)
    rising = 0.2 + 0.001 * np.arange(n)
    quiet = np.full(n, 0.02)
    quiet[60:] = 0.01
    out = chip_volume_price_divergence(
        _frame(close), _frame(high), _frame(low), _frame(rising), _frame(quiet)
    )
    assert np.isnan(out.iloc[:59].to_numpy()).all()
    assert (out.iloc[60:].to_numpy() == -1.0).all()

    falling = 0.4 - 0.001 * np.arange(n)
    loud = np.full(n, 0.02)
    loud[60:] = 0.03
    out_low = chip_volume_price_divergence(
        _frame(np.full(n, 9.0)),
        _frame(high),
        _frame(np.full(n, 9.0)),
        _frame(falling),
        _frame(loud),
    )
    assert (out_low.iloc[60:].to_numpy() == 1.0).all()


def test_divergence_arms_are_separated_by_turnover_on_a_flat_range() -> None:
    n = 80
    flat = np.full(n, 10.0)
    rising = 0.2 + 0.001 * np.arange(n)
    quiet = np.full(n, 0.02)
    quiet[60:] = 0.01
    out = chip_volume_price_divergence(
        _frame(flat), _frame(flat), _frame(flat), _frame(rising), _frame(quiet)
    )
    assert out.iloc[60, 0] == -1.0
    falling = 0.4 - 0.001 * np.arange(n)
    loud = np.full(n, 0.02)
    loud[60:] = 0.03
    out_low = chip_volume_price_divergence(
        _frame(flat), _frame(flat), _frame(flat), _frame(falling), _frame(loud)
    )
    assert out_low.iloc[60, 0] == 1.0


def test_divergence_is_nan_when_a_window_input_is_missing() -> None:
    n = 80
    concentration = np.full(n, 0.3)
    concentration[30] = np.nan
    turnover = np.full(n, 0.02)
    out = chip_volume_price_divergence(
        _frame(np.full(n, 10.0)),
        _frame(np.full(n, 10.0)),
        _frame(np.full(n, 9.0)),
        _frame(concentration),
        _frame(turnover),
    )
    assert np.isnan(out.iloc[30, 0])
    assert np.isnan(out.iloc[50, 0])


def test_signals_reject_misaligned_frames() -> None:
    with pytest.raises(ValueError, match="aligned"):
        chip_squeeze_buildup(_frame([0.2, 0.1]), _frame([0.0]), _frame([0.5, 0.5]))
