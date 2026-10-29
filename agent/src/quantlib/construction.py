"""Turn a panel of cross-sectional scores into constrained target weights.

``supervised.fit_predict_panel`` ends at a table of out-of-sample predictions;
``portfolio.py`` begins at a covariance matrix. Nothing in between turned a
score row into a portfolio, so every caller re-implemented the same three
decisions and each of them is easy to get silently wrong:

* **Rank weights with ties.** Sorting scores and assigning weights by rank
  gives a different answer for tied names unless the tie block shares its
  average rank. Equal scores must produce equal weights.
* **A per-name cap that does not leak gross.** One ``clip`` without
  redistribution quietly shrinks the book; the excess has to be reallocated
  until every remaining name is under the cap.
* **A dollar-neutral book that stays neutral after shrinkage.** Mixing two
  net-zero vectors does not preserve ``sum(|w|) = gross`` when a component
  flips sign — the L1 sphere is not convex. The mixture must be projected
  back onto the constraint after blending, not only before.

The module works one date at a time and never looks at another date, so a
row's weights cannot depend on any future observation. Degenerate rows (too
few eligible names, or no rank dispersion at all) go flat and say why in the
report instead of silently holding an arbitrary book.

Two regimes are supported:

``long_only=True``
    Weights are non-negative and sum to ``gross``. Ranks are shifted by the
    worst rank, so the lowest-scored eligible name gets exactly zero.

``long_only=False`` (dollar-neutral)
    Ranks are centred on the median, so positive and negative weights sum to
    zero and ``sum(|w|) = gross``.

This module only builds target weights. It does not estimate risk, price a
trade (``impact.py``), schedule execution, or touch a broker.
"""

from __future__ import annotations

from dataclasses import dataclass
from numbers import Integral, Real

import numpy as np
import pandas as pd

__all__ = ["ConstraintReport", "WeightResult", "build_weights"]

#: Slack used where a feasibility check compares two floats that should be
#: equal in exact arithmetic (a cap times a bucket size against its budget).
_TOLERANCE = 1e-12


@dataclass(frozen=True)
class ConstraintReport:
    """Per-date audit of the weights that were produced.

    Attributes:
        date: The row label this report describes.
        n_valid: Number of eligible names (finite score).
        n_held: Number of non-zero weights in the result.
        gross: ``sum(|w|)`` of the result.
        net: ``sum(w)`` of the result.
        max_abs_weight: Largest absolute weight (0.0 when flat).
        turnover: One-way turnover against the *raw* prior,
            ``0.5 * sum(|w - prior|)``; the prior defaults to flat, so a
            full book with no prior reports ``gross / 2``.
        capped: Whether any pre-cap weight strictly exceeded ``max_weight``.
        degenerate: ``None`` for a normal row, otherwise ``"insufficient"``
            or ``"no_dispersion"``.
    """

    date: pd.Timestamp
    n_valid: int
    n_held: int
    gross: float
    net: float
    max_abs_weight: float
    turnover: float
    capped: bool
    degenerate: str | None


@dataclass(frozen=True)
class WeightResult:
    """Target weights plus the per-date constraint audit.

    Attributes:
        weights: Same index and columns as the scores, ``float64``; names
            without a finite score carry exactly zero.
        report: One :class:`ConstraintReport` per row, in index order.
    """

    weights: pd.DataFrame
    report: tuple[ConstraintReport, ...]


def _positive_float(value: object, name: str) -> float:
    """Validate a strictly positive finite real parameter."""
    if isinstance(value, bool) or not isinstance(value, Real):
        raise ValueError(f"{name} must be a real number")
    number = float(value)
    if not np.isfinite(number) or number <= 0.0:
        raise ValueError(f"{name} must be finite and > 0")
    return number


def _unit_interval(value: object, name: str) -> float:
    """Validate a finite real parameter in [0, 1]."""
    if isinstance(value, bool) or not isinstance(value, Real):
        raise ValueError(f"{name} must be a real number")
    number = float(value)
    if not np.isfinite(number) or number < 0.0 or number > 1.0:
        raise ValueError(f"{name} must lie in [0, 1]")
    return number


def _positive_int(value: object, name: str) -> int:
    """Validate an integer parameter of at least one."""
    if isinstance(value, bool) or not isinstance(value, Integral):
        raise ValueError(f"{name} must be an integer >= 1")
    if value < 1:
        raise ValueError(f"{name} must be an integer >= 1")
    return int(value)


def _validate_scores(scores: pd.DataFrame) -> np.ndarray:
    """Validate the scores panel and return its values as float64."""
    if not isinstance(scores, pd.DataFrame):
        raise TypeError("scores must be a pandas DataFrame")
    if not isinstance(scores.index, pd.DatetimeIndex):
        raise TypeError("scores.index must be a DatetimeIndex")
    if len(scores.index) == 0 or len(scores.columns) == 0:
        raise ValueError("scores cannot be empty")
    if not scores.index.is_unique:
        raise ValueError("scores.index must be unique")
    if not scores.index.is_monotonic_increasing:
        raise ValueError("scores.index must be sorted ascending")
    if not scores.columns.is_unique:
        raise ValueError("scores.columns must be unique")
    if any(not isinstance(column, str) or not column for column in scores.columns):
        raise ValueError("scores.columns must be non-empty strings")
    try:
        return scores.to_numpy(dtype=float)
    except (TypeError, ValueError) as error:
        raise ValueError("scores must be numeric") from error


def _validate_prior(prior: pd.DataFrame | None, scores: pd.DataFrame) -> np.ndarray | None:
    """Validate the optional prior panel against the scores' labels."""
    if prior is None:
        return None
    if not isinstance(prior, pd.DataFrame):
        raise TypeError("prior_weights must be a pandas DataFrame")
    if not prior.index.equals(scores.index) or not prior.columns.equals(scores.columns):
        raise ValueError("prior_weights must share scores' index and columns")
    try:
        values = prior.to_numpy(dtype=float)
    except (TypeError, ValueError) as error:
        raise ValueError("prior_weights must be numeric") from error
    if not np.isfinite(values).all():
        raise ValueError("prior_weights must be finite")
    return values


def _average_rank(values: np.ndarray) -> np.ndarray:
    """Return 1-based ascending ranks, sharing the average rank within ties."""
    size = values.size
    order = np.argsort(values, kind="stable")
    ranks = np.empty(size, dtype=float)
    start = 0
    while start < size:
        stop = start + 1
        while stop < size and values[order[stop]] == values[order[start]]:
            stop += 1
        ranks[order[start:stop]] = 0.5 * (start + 1 + stop)
        start = stop
    return ranks


def _project(
    values: np.ndarray,
    raw: np.ndarray,
    valid: np.ndarray,
    long_only: bool,
    gross: float,
) -> np.ndarray:
    """Project weights onto the regime's sign, net and gross constraints.

    The projection deliberately ignores ``max_weight``; the cap is applied
    once, after shrinkage, by :func:`_apply_cap`.

    Args:
        values: Weights to project (prior or a blended vector).
        raw: The row's rank target, returned when the prior has no usable
            direction after projection (a flat prior carries no information).
        valid: Eligibility mask.
        long_only: Whether the long-only regime applies.
        gross: Requested gross exposure.

    Returns:
        A new array, zero outside ``valid``.
    """
    projected = np.where(valid, values, 0.0)
    if long_only:
        projected = np.clip(projected, 0.0, None)
        total = float(projected.sum())
        if total <= 0.0:
            return raw.copy()
        return projected * (gross / total)
    mean = float(projected[valid].mean())
    projected = np.where(valid, projected - mean, 0.0)
    total = float(np.abs(projected).sum())
    if total == 0.0:
        return raw.copy()
    return projected * (gross / total)


def _cap_bucket(magnitudes: np.ndarray, cap: float) -> np.ndarray:
    """Cap magnitudes at ``cap``, spreading each excess equally.

    Names still under the cap (including names at exactly zero) receive an
    equal share of every round's excess. Each round fixes at least one name,
    so the loop ends within ``magnitudes.size`` rounds. The caller checks
    feasibility first, which guarantees the final round has enough room.

    Args:
        magnitudes: Non-negative weights summing to the bucket budget.
        cap: Maximum absolute weight.

    Returns:
        New magnitudes with the same sum, each at most ``cap``.
    """
    capped = magnitudes.copy()
    fixed = np.zeros(capped.shape, dtype=bool)
    while True:
        over = (~fixed) & (capped > cap)
        if not over.any():
            return capped
        excess = float((capped[over] - cap).sum())
        capped[over] = cap
        fixed |= over
        active = ~fixed
        if not active.any():
            return capped
        capped[active] += excess / float(active.sum())


def _apply_cap(
    mixed: np.ndarray,
    valid: np.ndarray,
    long_only: bool,
    gross: float,
    cap: float,
) -> np.ndarray:
    """Enforce the per-name cap, raising when the constraint is infeasible.

    Long-only has one budget; dollar-neutral has one budget per sign bucket,
    because capping must not move weight from the long side to the short
    side (that would break neutrality). Bucket membership follows the sign
    of the blended weight, which shrinkage may have flipped.

    Args:
        mixed: Weights after shrinkage and projection.
        valid: Eligibility mask.
        long_only: Whether the long-only regime applies.
        gross: Requested gross exposure.
        cap: Maximum absolute weight.

    Returns:
        New weights with every bucket's budget preserved.
    """
    if long_only:
        count = int(valid.sum())
        if cap * count < gross - _TOLERANCE:
            raise ValueError(
                f"infeasible cap: max_weight={cap} over {count} names "
                f"cannot fund gross={gross}"
            )
        result = mixed.copy()
        result[valid] = _cap_bucket(np.abs(mixed[valid]), cap)
        return result

    positive = valid & (mixed > 0.0)
    negative = valid & (mixed < 0.0)
    for mask in (positive, negative):
        budget = float(np.abs(mixed[mask]).sum())
        count = int(mask.sum())
        if cap * count < budget - _TOLERANCE:
            raise ValueError(
                f"infeasible cap: max_weight={cap} over {count} names "
                f"cannot fund bucket budget={budget}"
            )
    result = np.where(valid, mixed, 0.0)
    result[positive] = _cap_bucket(np.abs(mixed[positive]), cap)
    result[negative] = -_cap_bucket(np.abs(mixed[negative]), cap)
    return result


def _build_row(
    row: np.ndarray,
    prior_row: np.ndarray | None,
    date: pd.Timestamp,
    long_only: bool,
    gross: float,
    max_weight: float | None,
    turnover_penalty: float,
    min_names: int,
) -> tuple[np.ndarray, ConstraintReport]:
    """Build one date's weights and its audit."""
    valid = np.isfinite(row)
    n_valid = int(valid.sum())
    prior_reference = np.zeros_like(row) if prior_row is None else prior_row
    weights = np.zeros_like(row)
    degenerated: str | None = None
    capped = False

    if n_valid < min_names:
        degenerated = "insufficient"
    else:
        ranks = _average_rank(row[valid])
        raw = np.zeros_like(row)
        if long_only:
            shifted = ranks - ranks.min()
            total = float(shifted.sum())
        else:
            shifted = ranks - 0.5 * (n_valid + 1)
            total = float(np.abs(shifted).sum())
        if total == 0.0:
            degenerated = "no_dispersion"
        else:
            raw[valid] = shifted / total * gross
            mixed = raw
            if turnover_penalty > 0.0:
                projected_prior = _project(
                    prior_reference, raw, valid, long_only, gross
                )
                mixed = (1.0 - turnover_penalty) * raw + turnover_penalty * projected_prior
                mixed = _project(mixed, raw, valid, long_only, gross)
            if max_weight is not None:
                capped = bool(np.any(np.abs(mixed) > max_weight))
                mixed = _apply_cap(mixed, valid, long_only, gross, max_weight)
            weights = np.where(valid, mixed, 0.0)

    report = ConstraintReport(
        date=date,
        n_valid=n_valid,
        n_held=int(np.count_nonzero(weights)),
        gross=float(np.abs(weights).sum()),
        net=float(weights.sum()),
        max_abs_weight=float(np.abs(weights).max()),
        turnover=0.5 * float(np.abs(weights - prior_reference).sum()),
        capped=capped,
        degenerate=degenerated,
    )
    return weights, report


def build_weights(
    scores: pd.DataFrame,
    *,
    long_only: bool = False,
    gross: float = 1.0,
    max_weight: float | None = None,
    prior_weights: pd.DataFrame | None = None,
    turnover_penalty: float = 0.0,
    min_names: int = 1,
) -> WeightResult:
    """Turn each row of cross-sectional scores into constrained weights.

    Ranks are assigned per row (average ranks within ties). Positive scores
    always rank above negative ones; only the ordering matters, not the
    spacing. Rows are independent — no statistic is computed across dates,
    so a row can never see another date's information.

    Args:
        scores: Scores panel; ``DatetimeIndex`` sorted ascending, unique
            string columns. NaN and infinities mean "not investable today"
            and are not an error.
        long_only: ``True`` for a non-negative book summing to ``gross``;
            ``False`` for a dollar-neutral book with ``sum(w) = 0`` and
            ``sum(|w|) = gross``.
        gross: Gross exposure (finite, > 0).
        max_weight: Per-name absolute weight cap, or ``None``. Applied after
            shrinkage by iterative equal redistribution. Infeasible caps
            raise ``ValueError`` rather than silently violating the cap or
            the gross.
        prior_weights: Optional previous book, same index and columns, all
            finite. Shrinking toward it keeps every constraint exact.
        turnover_penalty: Shrinkage weight in [0, 1]; ``0`` ignores the
            prior, ``1`` uses its projection. Positive values require
            ``prior_weights``.
        min_names: Minimum number of eligible names for a row to trade;
            fewer eligible names go flat (``"insufficient"``).

    Returns:
        A :class:`WeightResult` with one report per row. Degenerate rows are
        flat and labelled ``"insufficient"`` or ``"no_dispersion"``.

    Raises:
        TypeError: If ``scores``/``prior_weights`` is not a DataFrame, the
            index is not a ``DatetimeIndex``, or ``long_only`` is not a bool.
        ValueError: For empty, unsorted, duplicated or mislabelled inputs,
            non-numeric values, out-of-range parameters, a missing prior when
            ``turnover_penalty > 0``, mismatched/non-finite priors, or an
            infeasible cap.
    """
    if not isinstance(long_only, bool):
        raise TypeError("long_only must be a bool")
    gross_value = _positive_float(gross, "gross")
    cap = None if max_weight is None else _positive_float(max_weight, "max_weight")
    penalty = _unit_interval(turnover_penalty, "turnover_penalty")
    minimum = _positive_int(min_names, "min_names")
    values = _validate_scores(scores)
    priors = _validate_prior(prior_weights, scores)
    if penalty > 0.0 and priors is None:
        raise ValueError("turnover_penalty > 0 requires prior_weights")

    weights = np.zeros_like(values)
    reports: list[ConstraintReport] = []
    for position, date in enumerate(scores.index):
        row, report = _build_row(
            values[position],
            None if priors is None else priors[position],
            date,
            long_only,
            gross_value,
            cap,
            penalty,
            minimum,
        )
        weights[position] = row
        reports.append(report)

    return WeightResult(
        weights=pd.DataFrame(weights, index=scores.index, columns=scores.columns),
        report=tuple(reports),
    )
