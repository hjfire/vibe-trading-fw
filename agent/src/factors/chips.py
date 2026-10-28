"""Chip-distribution engine: daily holding-cost distribution from OHLC + turnover.

Public model (frozen in
``superpowers/specs/2026-10-28-g1-chip-factors-design.md``):

- every valid day contributes ``Triangular(low, (high + low + close) / 3, high)``;
- the state mixes as ``W_t = (1 - u_t) * W_{t-1} + u_t * D_t`` with
  ``u = clip(turnover_rate / 100, 0, 1)`` and ``turnover_rate`` in percent;
- an invalid bar leaves the state untouched and outputs NaN for that day;
- price bins are absolute cents ``[k * tick, (k + 1) * tick)``, so a bin key
  means the same price in every window (prefix invariance by construction).

Pure functions only: no I/O, no network, no global state.
"""

from __future__ import annotations

import math

import numpy as np
import pandas as pd

DEFAULT_TICK = 0.01
DEFAULT_COVERAGE = 0.90
DEFAULT_MAX_BINS_PER_DAY = 2048
DEFAULT_MAX_SPAN_BINS = 4_000_000
CONCENTRATION_CHANGE_WINDOW = 20

_EPS = 1e-9

METRICS = (
    "mass",
    "avg_cost",
    "cost_deviation",
    "profit_ratio",
    "concentration",
    "concentration_change_20",
)


def triangular_cdf(x: np.ndarray, low: float, mode: float, high: float) -> np.ndarray:
    """CDF of ``Triangular(low, mode, high)`` with ``mode`` clamped to the support."""
    values = np.asarray(x, dtype=np.float64)
    if high <= low:
        return (values >= low).astype(np.float64)
    mode = min(max(float(mode), float(low)), float(high))
    if mode <= low:
        denominator = (high - low) * (high - mode)
        return np.where(
            values <= low,
            0.0,
            np.where(values >= high, 1.0, 1.0 - (high - values) ** 2 / denominator),
        )
    if mode >= high:
        denominator = (high - low) * (mode - low)
        return np.where(
            values <= low,
            0.0,
            np.where(values >= high, 1.0, (values - low) ** 2 / denominator),
        )
    lower_denominator = (high - low) * (mode - low)
    upper_denominator = (high - low) * (high - mode)
    lower = (values - low) ** 2 / lower_denominator
    upper = 1.0 - (high - values) ** 2 / upper_denominator
    return np.where(
        values <= low,
        0.0,
        np.where(values <= mode, lower, np.where(values < high, upper, 1.0)),
    )


def _chip_metrics_symbol(
    high: np.ndarray,
    low: np.ndarray,
    close: np.ndarray,
    turnover_rate: np.ndarray,
    *,
    tick: float,
    coverage: float,
    max_bins_per_day: int,
    max_span_bins: int,
    label: str,
) -> dict[str, np.ndarray]:
    n_rows = len(high)
    out = {name: np.full(n_rows, np.nan) for name in METRICS}
    valid = (
        np.isfinite(high)
        & np.isfinite(low)
        & np.isfinite(close)
        & np.isfinite(turnover_rate)
        & (high >= low)
        & (low > 0)
        & (turnover_rate >= 0)
    )
    if not valid.any():
        return out

    steps = np.ones(n_rows, dtype=np.int64)
    firsts = np.zeros(n_rows, dtype=np.int64)
    lasts = np.zeros(n_rows, dtype=np.int64)
    for t in np.flatnonzero(valid):
        span = float(high[t]) - float(low[t])
        step = 1
        if span / tick > max_bins_per_day:
            step = int(math.ceil(span / max_bins_per_day / tick))
        steps[t] = step
        width = step * tick
        first = int(math.floor(float(low[t]) / width - _EPS))
        last = int(math.ceil(float(high[t]) / width - _EPS)) - 1
        firsts[t] = first
        lasts[t] = max(last, first)

    valid_days = np.flatnonzero(valid)
    k_min = int((firsts[valid_days] * steps[valid_days]).min())
    k_max = int((lasts[valid_days] * steps[valid_days] + steps[valid_days] - 1).max())
    size = k_max - k_min + 1
    if size > max_span_bins:
        raise ValueError(
            f"chip ladder for {label!r} spans {size} cent bins "
            f"(> max_span_bins={max_span_bins})"
        )

    weights = np.zeros(size, dtype=np.float64)
    mass_state = 0.0
    mean_state = 0.0
    concentration = np.full(n_rows, np.nan)
    tail = (1.0 - coverage) / 2.0

    for t in range(n_rows):
        if not valid[t]:
            continue
        h = float(high[t])
        l = float(low[t])
        c = float(close[t])
        u = min(max(float(turnover_rate[t]) / 100.0, 0.0), 1.0)
        mode = min(max((h + l + c) / 3.0, l), h)
        step = int(steps[t])
        width = step * tick

        weights *= 1.0 - u
        mass_state = (1.0 - u) * mass_state + u
        mean_state = (1.0 - u) * mean_state + u * ((l + h + mode) / 3.0)

        bins = np.arange(int(firsts[t]), int(lasts[t]) + 1)
        left = bins * width
        right = left + width
        mass = triangular_cdf(right, l, mode, h) - triangular_cdf(left, l, mode, h)
        mass = np.clip(mass, 0.0, None)
        mass = mass / mass.sum()
        if step == 1:
            weights[bins - k_min] += u * mass
        else:
            for bin_index, bin_mass in zip(bins, mass):
                start = int(bin_index) * step - k_min
                weights[start : start + step] += u * bin_mass / step

        out["mass"][t] = mass_state
        if mass_state <= 0.0:
            continue

        avg_cost = mean_state / mass_state
        out["avg_cost"][t] = avg_cost
        if avg_cost > 0.0:
            out["cost_deviation"][t] = (c - avg_cost) / avg_cost

        position = c / tick
        key = int(math.floor(position + _EPS))
        index = key - k_min
        if index <= 0:
            profit = 0.0
        elif index >= size:
            profit = 1.0
        else:
            fraction = min(max(position - key, 0.0), 1.0)
            profit = (weights[:index].sum() + fraction * weights[index]) / mass_state
        out["profit_ratio"][t] = profit

        cumulative = np.cumsum(weights)
        low_index = min(
            int(np.searchsorted(cumulative, tail * mass_state, side="left")), size - 1
        )
        high_index = min(
            int(np.searchsorted(cumulative, (1.0 - tail) * mass_state, side="left")),
            size - 1,
        )
        price_low = (k_min + low_index + 0.5) * tick
        price_high = (k_min + high_index + 0.5) * tick
        if price_low + price_high > 0.0:
            concentration[t] = (price_high - price_low) / (price_high + price_low)
            out["concentration"][t] = concentration[t]

    for t in range(CONCENTRATION_CHANGE_WINDOW, n_rows):
        earlier = t - CONCENTRATION_CHANGE_WINDOW
        if np.isfinite(concentration[t]) and np.isfinite(concentration[earlier]):
            out["concentration_change_20"][t] = (
                concentration[t] - concentration[earlier]
            )
    return out


def chip_metrics(
    high: pd.DataFrame,
    low: pd.DataFrame,
    close: pd.DataFrame,
    turnover_rate: pd.DataFrame,
    *,
    tick: float = DEFAULT_TICK,
    coverage: float = DEFAULT_COVERAGE,
    max_bins_per_day: int = DEFAULT_MAX_BINS_PER_DAY,
    max_span_bins: int = DEFAULT_MAX_SPAN_BINS,
) -> dict[str, pd.DataFrame]:
    """Compute the chip metrics for an aligned wide panel.

    Args:
        high: Daily high price (yuan), wide ``date x symbol``.
        low: Daily low price (yuan), wide, aligned with ``high``.
        close: Daily close price (yuan), wide, aligned with ``high``.
        turnover_rate: Daily turnover in **percent** (2.35 means 2.35%),
            wide, aligned with ``high``.
        tick: Price-bin width in yuan; 0.01 means absolute cents.
        coverage: Central coverage of the concentration quantiles (0.90).
        max_bins_per_day: Coarsen a day's ladder to at most this many bins.
        max_span_bins: Hard cap on a symbol's total cent ladder; raising is
            deliberate — silently coarsening would destroy the absolute keys.

    Returns:
        ``metric -> wide DataFrame`` with the keys in :data:`METRICS`.

    Raises:
        ValueError: A frame is not a DataFrame, is not aligned with ``high``,
            or one symbol's ladder exceeds ``max_span_bins``.
    """
    frames = {
        "high": high,
        "low": low,
        "close": close,
        "turnover_rate": turnover_rate,
    }
    for name, frame in frames.items():
        if not isinstance(frame, pd.DataFrame):
            raise ValueError(
                f"{name} must be a pandas DataFrame, got {type(frame).__name__}"
            )
        if not frame.index.equals(high.index) or not frame.columns.equals(high.columns):
            raise ValueError(f"{name} is not aligned with the high panel")

    index = high.index
    columns = high.columns
    n_rows = len(index)
    results = {name: np.full((n_rows, len(columns)), np.nan) for name in METRICS}

    values = {name: frame.to_numpy(dtype=np.float64) for name, frame in frames.items()}
    for position, symbol in enumerate(columns):
        per_symbol = _chip_metrics_symbol(
            values["high"][:, position],
            values["low"][:, position],
            values["close"][:, position],
            values["turnover_rate"][:, position],
            tick=tick,
            coverage=coverage,
            max_bins_per_day=max_bins_per_day,
            max_span_bins=max_span_bins,
            label=str(symbol),
        )
        for name in METRICS:
            results[name][:, position] = per_symbol[name]

    return {
        name: pd.DataFrame(values_, index=index, columns=columns)
        for name, values_ in results.items()
    }
