"""Walk-forward parameter selection with a multiple-testing guard.

The protocol is deliberately unglamorous:

1. split the sample with
   :func:`src.quantlib.crossvalidation.purged_walk_forward_splits`;
2. inside each training window, score every grid cell and pick the best;
3. read the test window only after the choice is made, and concatenate those
   out-of-sample returns in time order;
4. hand the size of the grid to
   :func:`src.quantlib.multipletesting.deflated_sharpe_ratio` as ``n_trials``.

Step 4 is the one research processes skip. ``n_trials`` counts *strategies
searched*, not evaluations: the same grid is re-searched in every fold, and
those repeats are not independent trials. Evaluation count is reported
separately as ``n_evaluations`` so the cost stays visible without corrupting
the statistic.
"""

from __future__ import annotations

from collections.abc import Mapping, Sequence
from dataclasses import dataclass

import numpy as np
import pandas as pd

from src.quantlib.crossvalidation import purged_walk_forward_splits
from src.quantlib.multipletesting import (
    MIN_OBSERVATIONS,
    DeflatedSharpeResult,
    deflated_sharpe_ratio,
    sharpe_ratio,
)

#: Sharpe differences at or below this are ties; ties break on parameter name.
TIE_EPSILON: float = 1e-12


@dataclass(frozen=True)
class FoldSelection:
    """One fold where a parameter was chosen and evaluated out of sample.

    Attributes:
        fold: 1-based fold number, matching the splitter's test-block order.
        train_start: First positional index in the training window.
        train_stop: One past the last training index. Purging can pull this
            back before ``test_start``.
        test_start: First positional index in the test block.
        test_stop: One past the last test index.
        chosen: Parameter name selected on the training window.
        train_sharpe: Per-observation Sharpe of ``chosen`` on the training window.
        test_sharpe: Per-observation Sharpe of ``chosen`` on the test block;
            NaN when the test returns have no dispersion.
    """

    fold: int
    train_start: int
    train_stop: int
    test_start: int
    test_stop: int
    chosen: str
    train_sharpe: float
    test_sharpe: float


@dataclass(frozen=True)
class SkippedFold:
    """A fold where no grid cell was eligible on the training window.

    Attributes:
        fold: 1-based fold number.
        train_start: First positional index in the training window.
        train_stop: One past the last training index.
        test_start: First positional index in the test block.
        test_stop: One past the last test index.
        reason: Why the fold produced no out-of-sample segment.
    """

    fold: int
    train_start: int
    train_stop: int
    test_start: int
    test_stop: int
    reason: str


@dataclass(frozen=True)
class WalkForwardSelection:
    """Result of one walk-forward selection run.

    Attributes:
        folds: Folds that produced an out-of-sample segment, in time order.
        skipped: Folds skipped because no grid cell was eligible.
        oos_returns: Concatenated out-of-sample returns, indexed like the input.
        grid_size: Number of parameter combinations searched per fold.
        n_trials: ``grid_size`` -- what the deflated statistic corrects for.
        n_evaluations: ``grid_size * (len(folds) + len(skipped))``; diagnostic
            only, never fed to the deflated statistic.
        deflated: Deflated Sharpe result, or None when the OOS sample is too
            short or has no dispersion.
        note: Why ``deflated`` is None; None when it was computed.
    """

    folds: tuple[FoldSelection, ...]
    skipped: tuple[SkippedFold, ...]
    oos_returns: pd.Series
    grid_size: int
    n_trials: int
    n_evaluations: int
    deflated: DeflatedSharpeResult | None
    note: str | None


def _as_matrix(
    returns_by_param: Mapping[str, Sequence[float] | np.ndarray | pd.Series],
) -> tuple[list[str], np.ndarray, pd.Index]:
    """Normalise the mapping into a column matrix plus its index.

    Raises:
        ValueError: On an empty mapping, a non-string name, mixed Series and
            arrays, misaligned Series indexes, unequal lengths, non-1-D values,
            or fewer than two observations.
    """
    if not returns_by_param:
        raise ValueError("returns_by_param must contain at least one parameter")

    names = list(returns_by_param)
    if any(not isinstance(name, str) or not name for name in names):
        raise ValueError("parameter names must be non-empty strings")

    values = list(returns_by_param.values())
    series_flags = [isinstance(value, pd.Series) for value in values]
    if any(series_flags) and not all(series_flags):
        raise ValueError("pass either all pandas Series or all arrays, not a mix")

    arrays = [np.asarray(value, dtype=float) for value in values]
    for name, array in zip(names, arrays):
        if array.ndim != 1:
            raise ValueError(f"returns for {name!r} must be one-dimensional")

    lengths = {array.shape[0] for array in arrays}
    if len(lengths) != 1:
        raise ValueError(
            f"all return series must have the same length, got {sorted(lengths)}"
        )
    if arrays[0].shape[0] < 2:
        raise ValueError("need at least 2 observations per return series")

    if all(series_flags):
        index = values[0].index
        for name, value in zip(names[1:], values[1:]):
            if not value.index.equals(index):
                raise ValueError(f"index of {name!r} is not aligned with {names[0]!r}")
    else:
        index = pd.RangeIndex(arrays[0].shape[0])

    return names, np.column_stack(arrays), index


def _sharpe_or_nan(values: np.ndarray) -> float:
    finite = values[np.isfinite(values)]
    if finite.size < 2 or np.ptp(finite) == 0.0:
        return float("nan")
    try:
        return sharpe_ratio(finite)
    except ValueError:
        return float("nan")


def walk_forward_selection(
    returns_by_param: Mapping[str, Sequence[float] | np.ndarray | pd.Series],
    *,
    n_folds: int = 5,
    expanding: bool = True,
    label_end_times: pd.Series | Sequence[int] | np.ndarray | None = None,
    confidence: float = 0.95,
    min_train_observations: int = MIN_OBSERVATIONS,
) -> WalkForwardSelection:
    """Choose one parameter per training window and evaluate it out of sample.

    Args:
        returns_by_param: Parameter name -> per-observation return series. All
            series must share a length; pandas Series inputs must share an
            index. NaN is kept, never filled.
        n_folds: Number of sample segments; the splitter yields ``n_folds - 1``
            test blocks because the first segment trains only.
        expanding: True for an expanding training window, False for a rolling
            window one segment wide.
        label_end_times: Where each label's outcome window ends, passed through
            to the splitter's purging logic.
        confidence: Level at which the deflated statistic decides ``survives``.
        min_train_observations: Fewest finite training observations a grid cell
            needs before it can be selected. Defaults to ``MIN_OBSERVATIONS``.

    Returns:
        A :class:`WalkForwardSelection`.

    Raises:
        ValueError: On invalid inputs, or when no fold yields an eligible
            parameter.
    """
    if isinstance(n_folds, bool) or not isinstance(n_folds, int) or n_folds < 2:
        raise ValueError(f"n_folds must be an integer >= 2, got {n_folds!r}")
    if (
        isinstance(min_train_observations, bool)
        or not isinstance(min_train_observations, int)
        or min_train_observations < 2
    ):
        raise ValueError(
            "min_train_observations must be an integer >= 2, "
            f"got {min_train_observations!r}"
        )

    names, matrix, index = _as_matrix(returns_by_param)
    grid_size = len(names)
    folds: list[FoldSelection] = []
    skipped: list[SkippedFold] = []
    oos_pieces: list[pd.Series] = []
    trial_sharpes: list[float] = []

    splits = purged_walk_forward_splits(
        matrix.shape[0],
        label_end_times=label_end_times,
        n_folds=n_folds,
        expanding=expanding,
    )
    for fold_number, split in enumerate(splits, start=1):
        train = matrix[split.train]
        test = matrix[split.test]
        train_start = int(split.train[0])
        train_stop = int(split.train[-1]) + 1
        test_start = int(split.test[0])
        test_stop = int(split.test[-1]) + 1

        scores: list[float] = []
        for column in range(grid_size):
            finite = train[:, column][np.isfinite(train[:, column])]
            if finite.size < min_train_observations:
                score = float("nan")
            else:
                score = _sharpe_or_nan(train[:, column])
            if np.isfinite(score):
                trial_sharpes.append(score)
            scores.append(score)

        eligible = [
            column for column, score in enumerate(scores) if np.isfinite(score)
        ]
        if not eligible:
            skipped.append(
                SkippedFold(
                    fold=fold_number,
                    train_start=train_start,
                    train_stop=train_stop,
                    test_start=test_start,
                    test_stop=test_stop,
                    reason="no_eligible_parameter",
                )
            )
            continue

        best = max(scores[column] for column in eligible)
        tied = sorted(
            names[column]
            for column in eligible
            if abs(best - scores[column]) <= TIE_EPSILON
        )
        chosen = tied[0]
        chosen_column = names.index(chosen)

        folds.append(
            FoldSelection(
                fold=fold_number,
                train_start=train_start,
                train_stop=train_stop,
                test_start=test_start,
                test_stop=test_stop,
                chosen=chosen,
                train_sharpe=scores[chosen_column],
                test_sharpe=_sharpe_or_nan(test[:, chosen_column]),
            )
        )
        oos_pieces.append(
            pd.Series(test[:, chosen_column].copy(), index=index[split.test])
        )

    if not folds:
        raise ValueError(
            "no fold produced an eligible parameter; lower min_train_observations, "
            "lengthen the sample, or widen the grid"
        )

    oos_returns = pd.concat(oos_pieces)
    attempted_folds = len(folds) + len(skipped)
    n_trials = grid_size
    n_evaluations = grid_size * attempted_folds
    observed_sharpe = _sharpe_or_nan(oos_returns.to_numpy(dtype=float))
    finite_trials = np.asarray(
        [score for score in trial_sharpes if np.isfinite(score)], dtype=float
    )
    trial_sharpe_std = (
        float(finite_trials.std(ddof=1)) if finite_trials.size >= 2 else 0.0
    )

    if len(oos_returns) < MIN_OBSERVATIONS:
        deflated = None
        note = (
            f"OOS has {len(oos_returns)} observations, fewer than "
            f"MIN_OBSERVATIONS={MIN_OBSERVATIONS}; the deflated statistic "
            "is not reported"
        )
    elif not np.isfinite(observed_sharpe):
        deflated = None
        note = (
            "OOS Sharpe is not finite (no dispersion); the deflated statistic "
            "is not reported"
        )
    else:
        deflated = deflated_sharpe_ratio(
            observed_sharpe=observed_sharpe,
            n_trials=n_trials,
            n_observations=len(oos_returns),
            trial_sharpe_std=trial_sharpe_std,
            confidence=confidence,
        )
        note = None

    return WalkForwardSelection(
        folds=tuple(folds),
        skipped=tuple(skipped),
        oos_returns=oos_returns,
        grid_size=grid_size,
        n_trials=n_trials,
        n_evaluations=n_evaluations,
        deflated=deflated,
        note=note,
    )
