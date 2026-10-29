"""Turn a rebalance snapshot into a participation-capped day-by-day schedule.

``construction.py`` ends at target weights and ``turnover.py`` prices the
resulting turnover, but neither answers the execution question: how does the
book get from where it is to where it wants to be without taking more than a
fixed share of each asset's average daily volume? ``impact.py`` prices one
order at a time and says outright that it has no trading trajectory.

This module fills that gap with one deterministic, per-asset schedule:

* every day's trade in an asset is at most ``max_participation x adv``;
* the plan stops after ``max_days`` or as soon as nothing tradable remains;
* whatever did not fill is reported, never silently dropped -- split into the
  whole-lot part that the horizon was too short for (``unfilled``) and the
  sub-lot remainder no whole-lot trade can remove (``lot_residual``).

Inputs are one snapshot: ``target`` and ``current`` are a Series over asset
labels, not a panel of dates. Units are the caller's choice but must be
consistent across all four inputs (shares, notional, or weights with ``adv``
converted to weight units as ``adv_notional / nav``). The module does not
convert units, connect to a broker, read a live order book or place orders.
It never reads the clock, the environment or a file.
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from numbers import Integral, Real

import numpy as np
import pandas as pd

__all__ = ["ExecutionPlan", "schedule_trades"]


@dataclass(frozen=True)
class ExecutionPlan:
    """Per-day trades plus an honest account of what was left behind.

    Attributes:
        trades: Frame of signed trades, rows numbered ``1..H`` where ``H`` is
            the last day with any trade, columns sorted asset labels.
        residual: ``target - current - sum(trades)`` per asset.
        unfilled: The part of ``residual`` that could be traded in whole lots
            but was not, because ``max_days`` ran out or ``adv`` was zero.
        lot_residual: The part of ``residual`` smaller than one lot, which no
            whole-lot trade can remove. Zero when ``lot_size`` is ``None``.
        days_used: Number of days each asset traded; an integer Series.
    """

    trades: pd.DataFrame
    residual: pd.Series
    unfilled: pd.Series
    lot_residual: pd.Series
    days_used: pd.Series


def _validate_snapshot(series: pd.Series, name: str) -> None:
    """Validate a labelled snapshot Series.

    Args:
        series: Target, current holdings or ADV, one value per asset.
        name: Argument name used in error messages.

    Raises:
        TypeError: If ``series`` is not a Series.
        ValueError: If the index is empty, duplicated or not composed of
            non-empty strings, or any value is non-numeric or non-finite.
    """
    if not isinstance(series, pd.Series):
        raise TypeError(f"{name} must be a pandas Series")
    if len(series.index) == 0:
        raise ValueError(f"{name} cannot be empty")
    if not series.index.is_unique:
        raise ValueError(f"{name}.index must be unique")
    if not all(isinstance(label, str) and label for label in series.index):
        raise ValueError(f"{name}.index must be non-empty strings")
    try:
        values = series.to_numpy(dtype=float)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{name} must be finite numeric") from error
    if not np.isfinite(values).all():
        raise ValueError(f"{name} must be finite numeric")


def _to_vector(series: pd.Series, labels: list[str], name: str) -> np.ndarray:
    """Validate a snapshot and return its values in canonical label order.

    Args:
        series: The Series to align.
        labels: Canonical (sorted) asset labels.
        name: Argument name used in error messages.

    Returns:
        A float array ordered like ``labels``.

    Raises:
        TypeError: If ``series`` is not a Series.
        ValueError: If validation fails or its label set differs from
            ``labels``.
    """
    _validate_snapshot(series, name)
    if set(series.index) != set(labels):
        raise ValueError(f"{name} must share target's labels")
    return series.reindex(labels).to_numpy(dtype=float)


def _validate_participation(max_participation: float) -> float:
    """Validate the per-day participation cap.

    Args:
        max_participation: Fraction of ADV tradable per asset per day.

    Returns:
        The cap as a float.

    Raises:
        TypeError: If the value is not a real scalar or is a ``bool``.
        ValueError: If it is non-finite, not positive, or above 1.
    """
    if isinstance(max_participation, bool) or not isinstance(max_participation, Real):
        raise TypeError(
            f"max_participation must be a real number, got {type(max_participation).__name__}"
        )
    value = float(max_participation)
    if not np.isfinite(value) or value <= 0.0 or value > 1.0:
        raise ValueError(
            f"max_participation must be in (0, 1], got {max_participation!r}"
        )
    return value


def _validate_max_days(max_days: int) -> int:
    """Validate the planning horizon.

    Args:
        max_days: Maximum number of trading days in the plan.

    Returns:
        The horizon as a plain ``int``.

    Raises:
        TypeError: If the value is not an integer or is a ``bool``.
        ValueError: If it is smaller than 1.
    """
    if isinstance(max_days, bool) or not isinstance(max_days, int):
        raise TypeError(f"max_days must be an integer, got {type(max_days).__name__}")
    if max_days < 1:
        raise ValueError(f"max_days must be at least 1, got {max_days!r}")
    return int(max_days)


def _lot_vector(lot_size: int | pd.Series | None, labels: list[str]) -> np.ndarray:
    """Expand ``lot_size`` into a per-asset float vector.

    Args:
        lot_size: ``None`` for continuous units, a positive integer applied to
            every asset, or a Series of positive integers aligned by label.
        labels: Canonical (sorted) asset labels.

    Returns:
        A float array of per-asset lot sizes, zero meaning "no rounding".

    Raises:
        TypeError: If ``lot_size`` is not ``None``, a non-boolean integer or a
            Series, or a Series value is not a non-boolean integer.
        ValueError: If a scalar lot size is not positive, the Series index is
            duplicated or does not match ``labels``, or a value is not
            positive.
    """
    if lot_size is None:
        return np.zeros(len(labels), dtype=float)
    if isinstance(lot_size, bool):
        raise TypeError("lot_size must be None, a positive integer, or a Series")
    if isinstance(lot_size, Integral):
        if int(lot_size) <= 0:
            raise ValueError(f"lot_size must be positive, got {lot_size!r}")
        return np.full(len(labels), float(int(lot_size)))
    if not isinstance(lot_size, pd.Series):
        raise TypeError("lot_size must be None, a positive integer, or a Series")
    if not lot_size.index.is_unique:
        raise ValueError("lot_size.index must be unique")
    if set(lot_size.index) != set(labels):
        raise ValueError("lot_size must share target's labels")
    lots = []
    for value in lot_size.reindex(labels):
        if isinstance(value, bool) or not isinstance(value, Integral):
            raise TypeError("lot_size values must be integers")
        if int(value) <= 0:
            raise ValueError(f"lot_size values must be positive, got {value!r}")
        lots.append(float(int(value)))
    return np.asarray(lots, dtype=float)


def schedule_trades(
    target: pd.Series,
    current: pd.Series,
    *,
    adv: pd.Series,
    max_participation: float = 0.1,
    max_days: int = 5,
    lot_size: int | pd.Series | None = None,
) -> ExecutionPlan:
    """Schedule the move from ``current`` to ``target`` over at most ``max_days``.

    Each asset is scheduled independently. On every day it trades the smaller
    of its remaining gap and ``max_participation * adv`` (rounded down to a
    whole lot when ``lot_size`` is given). The plan stops early when a day
    would trade nothing, so a sub-lot remainder does not pad the frame with
    empty rows. Whatever remains is reported in ``residual``, split into
    ``unfilled`` and ``lot_residual``.

    Args:
        target: Desired position per asset, a Series of finite numbers.
        current: Current position per asset; must share ``target``'s labels.
        adv: Average daily volume per asset, non-negative and in the same
            unit as ``target``/``current``.
        max_participation: Maximum fraction of ``adv`` tradable per asset per
            day, in ``(0, 1]``. Defaults to 0.1.
        max_days: Maximum planning horizon in trading days. Defaults to 5.
        lot_size: Optional whole-lot size in the same unit, either one positive
            integer for every asset or a Series of positive integers.

    Returns:
        An :class:`ExecutionPlan` with the trades, residual, unfilled amount,
        sub-lot remainder and per-asset day counts.

    Raises:
        TypeError: If an input has the wrong type (including ``bool`` where a
            number or integer is expected).
        ValueError: If labels are empty, duplicated, non-string or
            inconsistent, values are non-numeric, non-finite or out of range,
            or a scalar input is outside its allowed interval.
    """
    _validate_snapshot(target, "target")
    _validate_snapshot(current, "current")
    if set(target.index) != set(current.index):
        raise ValueError("current must share target's labels")
    labels = sorted(target.index)
    target_values = target.reindex(labels).to_numpy(dtype=float)
    current_values = current.reindex(labels).to_numpy(dtype=float)
    adv_values = _to_vector(adv, labels, "adv")
    if np.any(adv_values < 0.0):
        raise ValueError("adv must be finite non-negative numeric")
    participation = _validate_participation(max_participation)
    horizon = _validate_max_days(max_days)
    lots = _lot_vector(lot_size, labels)

    caps = participation * adv_values
    remaining = (target_values - current_values).copy()
    rows = []
    for _ in range(horizon):
        row = np.zeros(len(labels), dtype=float)
        for index in range(len(labels)):
            leftover = remaining[index]
            if leftover == 0.0:
                continue
            room = min(abs(leftover), caps[index])
            if lots[index] > 0.0:
                room = math.floor(room / lots[index]) * lots[index]
            if room <= 0.0:
                continue
            trade = math.copysign(room, leftover)
            row[index] = trade
            remaining[index] = leftover - trade
        if not np.any(row != 0.0):
            break
        rows.append(row)

    if rows:
        trades = pd.DataFrame(
            rows, index=pd.RangeIndex(1, len(rows) + 1), columns=labels
        )
    else:
        trades = pd.DataFrame(
            np.zeros((0, len(labels))),
            index=pd.RangeIndex(1, 1),
            columns=labels,
        )

    residual = pd.Series(remaining, index=labels, dtype=float)
    lot_residual_values = np.zeros(len(labels), dtype=float)
    mask = lots > 0.0
    if mask.any():
        lot_residual_values[mask] = np.fmod(
            np.abs(remaining[mask]), lots[mask]
        ) * np.sign(remaining[mask])
    lot_residual = pd.Series(lot_residual_values, index=labels, dtype=float)
    unfilled = residual - lot_residual

    counts = (trades != 0.0).sum(axis=0).reindex(labels).fillna(0).astype(int)
    days_used = pd.Series(counts.to_numpy(dtype=int), index=labels, dtype=int)
    return ExecutionPlan(trades, residual, unfilled, lot_residual, days_used)
