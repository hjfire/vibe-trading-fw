"""Turn a panel of target weights into turnover, cost and net returns.

``construction.py`` ends at a table of target weights; ``impact.py`` prices one
order at a time. Neither answers the portfolio-level questions that decide
whether a strategy survives its own trading:

* How much did the book actually trade between two consecutive target rows?
* What did that trading cost at a given fee and impact rate, and what is the
  running total?
* After costs, what did the strategy earn, how much of gross did costs eat, and
  what fee would take net return to zero?

The module is deliberately narrow. ``cost_bps`` is charged per unit of
one-sided turnover (``cost = turnover x bps / 1e4``), not per unit of traded
notional on both sides; a caller holding a one-side fee should double it.
Per-asset cost differences, including market impact, arrive through the
``impact`` table the caller fills in -- this module does not call
``impact.py`` models, size orders or choose a fee model.

The accounting identity ``net_return = gross_return - cost`` holds on every
row, cost is charged once -- on the day the weights change -- and the weights
formed at the close of day t only earn from day ``t + lag`` onward. No function
reads the clock, the environment or a file.

This is reporting arithmetic, not an execution engine: it does not schedule
trades, split orders, or model taxes, borrow fees or minimum commissions.
"""

from __future__ import annotations

from dataclasses import dataclass
from numbers import Real

import numpy as np
import pandas as pd

__all__ = ["AttributionSummary", "attribution_summary", "net_returns", "trade_cost"]

#: Basis points in one unit (100%).
_BPS_PER_UNIT = 10_000.0


@dataclass(frozen=True)
class AttributionSummary:
    """Totals and ratios computed from a net-return table.

    Attributes:
        total_gross: Sum of ``gross_return`` over every row.
        total_cost: Sum of ``cost`` over every row.
        total_net: Sum of ``net_return`` over every row.
        cost_ratio: ``total_cost / total_gross``; NaN when gross is zero.
        breakeven_bps: Fee in basis points, charged per unit of one-sided
            turnover, at which ``total_net`` would reach zero; NaN when
            nothing traded. Negative when gross return is negative.
    """

    total_gross: float
    total_cost: float
    total_net: float
    cost_ratio: float
    breakeven_bps: float


def _validate_weights(weights: pd.DataFrame) -> np.ndarray:
    """Validate a weight panel and return its values as a float array.

    Args:
        weights: Wide target-weight table, one row per date.

    Returns:
        The panel as a ``(dates, assets)`` float array.

    Raises:
        TypeError: If ``weights`` is not a DataFrame, or its index is not a
            :class:`pandas.DatetimeIndex`.
        ValueError: If the panel is empty, the index is duplicated or not
            ascending, the columns are duplicated or not non-empty strings,
            or any value is non-numeric or non-finite. Short positions are
            legal: a dollar-neutral book carries negative weights.
    """
    if not isinstance(weights, pd.DataFrame):
        raise TypeError("weights must be a pandas DataFrame")
    if not isinstance(weights.index, pd.DatetimeIndex):
        raise TypeError("weights.index must be a DatetimeIndex")
    if len(weights.index) == 0 or len(weights.columns) == 0:
        raise ValueError("weights cannot be empty")
    if not weights.index.is_unique:
        raise ValueError("weights.index must be unique")
    if not weights.index.is_monotonic_increasing:
        raise ValueError("weights.index must be sorted ascending")
    if not weights.columns.is_unique:
        raise ValueError("weights.columns must be unique")
    if not all(isinstance(column, str) and column for column in weights.columns):
        raise ValueError("weights.columns must be non-empty strings")
    try:
        values = weights.to_numpy(dtype=float)
    except (TypeError, ValueError) as error:
        raise ValueError("weights must be finite numeric") from error
    if not np.isfinite(values).all():
        raise ValueError("weights must be finite numeric")
    return values


def _validate_impact(impact: pd.DataFrame, weights: pd.DataFrame) -> np.ndarray:
    """Validate a per-asset impact table against the weight panel.

    Args:
        impact: Relative cost rate per asset per date, e.g. 0.001 for 10bps.
        weights: The panel whose index and columns ``impact`` must match.

    Returns:
        The impact table as a ``(dates, assets)`` float array.

    Raises:
        TypeError: If ``impact`` is not a DataFrame.
        ValueError: If ``impact`` does not share ``weights``' index and columns
            position for position, or any value is non-numeric, non-finite or
            negative. A negative impact would pay the trader for trading.
    """
    if not isinstance(impact, pd.DataFrame):
        raise TypeError("impact must be a pandas DataFrame")
    if not impact.index.equals(weights.index) or not impact.columns.equals(
        weights.columns
    ):
        raise ValueError("impact must share weights' index and columns")
    try:
        values = impact.to_numpy(dtype=float)
    except (TypeError, ValueError) as error:
        raise ValueError("impact must be finite non-negative numeric") from error
    if not np.isfinite(values).all() or np.any(values < 0.0):
        raise ValueError("impact must be finite non-negative numeric")
    return values


def _initial_vector(initial_weights: pd.Series | None, weights: pd.DataFrame) -> np.ndarray:
    """Align the pre-sample holdings to the panel's column order.

    Args:
        initial_weights: Holdings before the first row, or ``None`` for a
            flat start.
        weights: The panel whose columns define the target order.

    Returns:
        A float vector ordered like ``weights.columns``.

    Raises:
        TypeError: If ``initial_weights`` is given but is not a Series.
        ValueError: If its index is not exactly the set of ``weights.columns``
            (duplicates included), or any value is non-numeric or non-finite.
            Alignment is by label: the Series' own order is irrelevant.
    """
    if initial_weights is None:
        return np.zeros(weights.shape[1], dtype=float)
    if not isinstance(initial_weights, pd.Series):
        raise TypeError("initial_weights must be a pandas Series")
    if not initial_weights.index.is_unique or set(initial_weights.index) != set(
        weights.columns
    ):
        raise ValueError("initial_weights must share weights' columns")
    try:
        values = initial_weights.reindex(weights.columns).to_numpy(dtype=float)
    except (TypeError, ValueError) as error:
        raise ValueError("initial_weights must be finite numeric") from error
    if not np.isfinite(values).all():
        raise ValueError("initial_weights must be finite numeric")
    return values


def _cost_rate(cost_bps: float) -> float:
    """Convert a basis-point fee into a decimal rate per unit of turnover.

    Args:
        cost_bps: Fee in basis points, non-negative.

    Returns:
        ``cost_bps / 1e4``.

    Raises:
        TypeError: If ``cost_bps`` is not a real scalar or is a ``bool``.
        ValueError: If ``cost_bps`` is non-finite or negative.
    """
    if isinstance(cost_bps, bool) or not isinstance(cost_bps, Real):
        raise TypeError(f"cost_bps must be a real number, got {type(cost_bps).__name__}")
    rate = float(cost_bps)
    if not np.isfinite(rate) or rate < 0.0:
        raise ValueError(f"cost_bps must be finite and non-negative, got {cost_bps!r}")
    return rate / _BPS_PER_UNIT


def trade_cost(
    weights: pd.DataFrame,
    *,
    cost_bps: float = 0.0,
    impact: pd.DataFrame | None = None,
    initial_weights: pd.Series | None = None,
) -> pd.DataFrame:
    """Compute one-sided turnover and trading cost for every row.

    Turnover between two target rows is ``0.5 * sum(|w_t - w_{t-1}|)``, the
    same one-sided convention as ``ConstraintReport.turnover``. Cost is charged
    once, on the day the weights change:

    * uniform fee: ``cost_t = turnover_t * cost_bps / 1e4``;
    * with ``impact``: ``cost_t = 0.5 * sum(|w_t - w_{t-1}| * (bps/1e4 + impact_t))``.

    Args:
        weights: Wide target-weight table, one row per date, index a sorted
            unique ``DatetimeIndex``. Negative weights are allowed.
        cost_bps: Fee in basis points charged per unit of one-sided turnover.
            Defaults to 0.
        impact: Optional table shaped like ``weights`` holding the extra
            relative cost per asset per date (for example the output of an
            ``impact.py`` model). Defaults to ``None``.
        initial_weights: Optional Series of holdings before the first row,
            aligned by label. Defaults to ``None``, meaning a flat start.

    Returns:
        A frame indexed like ``weights`` with columns
        ``["turnover", "cost", "cumulative_cost"]``; ``cumulative_cost`` is the
        running sum of ``cost``.

    Raises:
        TypeError: If ``weights`` is not a DataFrame, its index is not a
            ``DatetimeIndex``, ``cost_bps`` is not a real scalar, or
            ``initial_weights`` is not a Series.
        ValueError: If the panel violates its contract, ``cost_bps`` or an
            impact value is negative or non-finite, or ``initial_weights``
            does not match the columns.
    """
    rate = _cost_rate(cost_bps)
    values = _validate_weights(weights)
    impact_values = None if impact is None else _validate_impact(impact, weights)
    previous = _initial_vector(initial_weights, weights)

    rows = []
    for index in range(len(weights.index)):
        current = values[index]
        delta = np.abs(current - previous)
        turnover = 0.5 * float(delta.sum())
        if impact_values is None:
            cost = turnover * rate
        else:
            cost = 0.5 * float((delta * (rate + impact_values[index])).sum())
        rows.append((turnover, cost))
        previous = current

    result = pd.DataFrame(rows, index=weights.index, columns=["turnover", "cost"])
    result["cumulative_cost"] = result["cost"].cumsum()
    return result


def net_returns(
    weights: pd.DataFrame,
    asset_returns: pd.DataFrame,
    costs: pd.DataFrame,
    *,
    lag: int = 1,
) -> pd.DataFrame:
    """Combine gross asset returns with trading costs into net returns.

    The weights formed at the close of row ``t`` earn from row ``t + lag``
    onward (``lag=1`` matches China A-share T+1). Positions with zero weight
    contribute exactly zero even when that asset's return is missing; a held
    asset with a missing return makes the portfolio return NaN rather than
    quietly skipping the position.

    Args:
        weights: Wide target-weight table, one row per date.
        asset_returns: Simple returns per asset per date, shaped like
            ``weights``. Missing values are allowed.
        costs: Output of :func:`trade_cost` (extra columns are ignored); must
            carry ``turnover`` and ``cost`` on the same index as ``weights``.
        lag: Rows to delay execution by. ``0`` lets same-day weight earn the
            same day's return and is a research-alignment option, not a
            no-look-ahead guarantee. Defaults to 1.

    Returns:
        A frame indexed like ``weights`` with columns
        ``["gross_return", "cost", "turnover", "net_return"]``, where
        ``net_return = gross_return - cost``.

    Raises:
        TypeError: If any table argument is not a DataFrame, or ``lag`` is not
            an integer (``bool`` included).
        ValueError: If ``asset_returns`` or ``costs`` do not align with
            ``weights``, ``costs`` lacks a required column, ``asset_returns``
            is non-numeric, or ``lag`` is negative.
    """
    _validate_weights(weights)
    if not isinstance(asset_returns, pd.DataFrame):
        raise TypeError("asset_returns must be a pandas DataFrame")
    if not asset_returns.index.equals(weights.index) or not asset_returns.columns.equals(
        weights.columns
    ):
        raise ValueError("asset_returns must share weights' index and columns")
    try:
        returns = asset_returns.to_numpy(dtype=float)
    except (TypeError, ValueError) as error:
        raise ValueError("asset_returns must be numeric") from error

    if not isinstance(costs, pd.DataFrame):
        raise TypeError("costs must be a pandas DataFrame")
    if not costs.index.equals(weights.index):
        raise ValueError("costs must share weights' index")
    if "turnover" not in costs.columns or "cost" not in costs.columns:
        raise ValueError("costs must contain turnover and cost columns")

    if isinstance(lag, bool) or not isinstance(lag, int):
        raise TypeError(f"lag must be an integer, got {type(lag).__name__}")
    if lag < 0:
        raise ValueError(f"lag must be non-negative, got {lag!r}")

    effective = weights.shift(lag).fillna(0.0).to_numpy(dtype=float)
    contributions = np.where(effective == 0.0, 0.0, effective * returns)
    gross = np.sum(contributions, axis=1)

    result = pd.DataFrame(
        {
            "gross_return": gross,
            "cost": costs["cost"].to_numpy(dtype=float),
            "turnover": costs["turnover"].to_numpy(dtype=float),
        },
        index=weights.index,
    )
    result["net_return"] = result["gross_return"] - result["cost"]
    return result


def attribution_summary(net: pd.DataFrame) -> AttributionSummary:
    """Summarise a net-return table into totals and break-even fee.

    Every total is a simple sum over rows (no compounding), and a single NaN
    makes the corresponding total NaN. ``cost_ratio`` and ``breakeven_bps``
    are NaN when their denominator is zero.

    Args:
        net: Output of :func:`net_returns` (extra columns are ignored); must
            be non-empty and carry ``gross_return``, ``cost``, ``turnover``
            and ``net_return``.

    Returns:
        An :class:`AttributionSummary` with the five totals and ratios.

    Raises:
        TypeError: If ``net`` is not a DataFrame.
        ValueError: If ``net`` is empty, lacks one of the four required
            columns, or those columns are not numeric.
    """
    if not isinstance(net, pd.DataFrame):
        raise TypeError("net must be a pandas DataFrame")
    required = ("gross_return", "cost", "turnover", "net_return")
    if len(net.index) == 0 or any(name not in net.columns for name in required):
        raise ValueError(
            "net must be non-empty and contain gross_return, cost, turnover, net_return"
        )
    try:
        frame = net.loc[:, list(required)].astype(float)
    except (TypeError, ValueError) as error:
        raise ValueError("net columns must be numeric") from error

    total_gross = float(frame["gross_return"].sum(skipna=False))
    total_cost = float(frame["cost"].sum(skipna=False))
    total_net = float(frame["net_return"].sum(skipna=False))
    total_turnover = float(frame["turnover"].sum(skipna=False))
    cost_ratio = total_cost / total_gross if total_gross != 0.0 else float("nan")
    breakeven = (
        total_gross / total_turnover * _BPS_PER_UNIT
        if total_turnover > 0.0
        else float("nan")
    )
    return AttributionSummary(total_gross, total_cost, total_net, cost_ratio, breakeven)
