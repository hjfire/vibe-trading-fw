"""Chip-based signals over the engine's wide output.

Every function is pure: wide frames in, one float wide frame out
(1.0 hit / 0.0 miss / NaN not evaluable; the divergence signal uses
-1.0 / +1.0 / 0.0 / NaN).
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def _require_aligned(reference: pd.DataFrame, **frames: pd.DataFrame) -> None:
    for name, frame in frames.items():
        if not isinstance(frame, pd.DataFrame):
            raise ValueError(
                f"{name} must be a pandas DataFrame, got {type(frame).__name__}"
            )
        if not frame.index.equals(reference.index) or not frame.columns.equals(
            reference.columns
        ):
            raise ValueError(f"{name} is not aligned with the reference frame")


def chip_squeeze_buildup(
    concentration: pd.DataFrame,
    cost_deviation: pd.DataFrame,
    profit_ratio: pd.DataFrame,
    *,
    window: int = 20,
    deviation_max: float = 0.05,
    profit_min: float = 0.30,
    profit_max: float = 0.70,
) -> pd.DataFrame:
    """1.0 while the cost range narrows around a price pinned to average cost."""
    _require_aligned(
        concentration, cost_deviation=cost_deviation, profit_ratio=profit_ratio
    )
    previous = concentration.shift(window)
    condition = (
        (concentration < previous)
        & (cost_deviation.abs() <= deviation_max)
        & (profit_ratio >= profit_min)
        & (profit_ratio <= profit_max)
    )
    valid = (
        concentration.notna()
        & previous.notna()
        & cost_deviation.notna()
        & profit_ratio.notna()
    )
    return condition.astype(float).where(valid)


def chip_capital_resonance(
    turnover_fraction: pd.DataFrame,
    profit_ratio: pd.DataFrame,
    cost_deviation: pd.DataFrame,
    *,
    window: int = 20,
    multiple: float = 2.0,
    profit_min: float = 0.60,
) -> pd.DataFrame:
    """1.0 when volume doubles its prior mean while most holders sit in profit."""
    _require_aligned(
        turnover_fraction, profit_ratio=profit_ratio, cost_deviation=cost_deviation
    )
    mean_previous = (
        turnover_fraction.rolling(window, min_periods=window).mean().shift(1)
    )
    condition = (
        (turnover_fraction >= multiple * mean_previous)
        & (profit_ratio >= profit_min)
        & (cost_deviation > 0.0)
    )
    valid = (
        turnover_fraction.notna()
        & mean_previous.notna()
        & profit_ratio.notna()
        & cost_deviation.notna()
    )
    return condition.astype(float).where(valid)


def chip_volume_price_divergence(
    close: pd.DataFrame,
    high: pd.DataFrame,
    low: pd.DataFrame,
    concentration: pd.DataFrame,
    turnover_fraction: pd.DataFrame,
    *,
    window: int = 20,
    peak_window: int = 60,
) -> pd.DataFrame:
    """-1.0 new high on shrinking volume with dispersing cost; +1.0 the mirror."""
    _require_aligned(
        close,
        high=high,
        low=low,
        concentration=concentration,
        turnover_fraction=turnover_fraction,
    )
    rolling_high = high.rolling(peak_window, min_periods=peak_window).max()
    rolling_low = low.rolling(peak_window, min_periods=peak_window).min()
    mean_previous = (
        turnover_fraction.rolling(window, min_periods=window).mean().shift(1)
    )
    previous_concentration = concentration.shift(window)
    high_divergence = (
        (close >= rolling_high)
        & (turnover_fraction < mean_previous)
        & (concentration > previous_concentration)
    )
    low_divergence = (
        (close <= rolling_low)
        & (turnover_fraction > mean_previous)
        & (concentration < previous_concentration)
    )
    verdict = np.where(high_divergence, -1.0, np.where(low_divergence, 1.0, 0.0))
    valid = (
        close.notna()
        & high.notna()
        & low.notna()
        & concentration.notna()
        & turnover_fraction.notna()
        & rolling_high.notna()
        & rolling_low.notna()
        & mean_previous.notna()
        & previous_concentration.notna()
    )
    return pd.DataFrame(verdict, index=close.index, columns=close.columns).where(valid)
