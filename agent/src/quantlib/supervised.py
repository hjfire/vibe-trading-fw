"""Leakage-audited cross-sectional learning pipeline.

The module strings together four steps that are easy to get wrong by hand:
purged walk-forward splitting, in-fold preprocessing, model fitting and
out-of-sample scoring. Every guarantee it offers is about *what the training
step was allowed to see*:

- the standardisation statistics come from the training rows of that fold only;
- the split is audited for shared indices and label-window overlap before any
  model is fitted;
- test-period labels are never read while fitting or predicting.

The label convention is the caller's responsibility: a value at date ``t`` must
already be the forward outcome over ``t+1..t+horizon``. ``horizon`` is used only
to purge training rows whose label window reaches into the test block; this
module cannot verify that the supplied labels really look forward.

The module is pure: no file I/O, no clock, no environment access, no global
state. Randomness is confined to ``random_state``.
"""

from __future__ import annotations

from collections.abc import Iterable, Mapping
from dataclasses import dataclass, field
from typing import Any

import numpy as np
import pandas as pd
from sklearn.ensemble import GradientBoostingRegressor, RandomForestRegressor
from sklearn.linear_model import Ridge

from src.quantlib.crossvalidation import (
    Split,
    detect_boundary_leakage,
    purged_walk_forward_splits,
)

__all__ = [
    "ComparisonResult",
    "FoldPrediction",
    "LeakageError",
    "MLRun",
    "ModelSpec",
    "RunMetrics",
    "SkippedFold",
    "assert_clean_splits",
    "compare_runs",
    "fit_predict_panel",
]

_MODEL_PARAMS: dict[str, frozenset[str]] = {
    "ridge": frozenset({"alpha"}),
    "random_forest": frozenset({"n_estimators", "max_depth", "min_samples_leaf"}),
    "gradient_boosting": frozenset(
        {"n_estimators", "learning_rate", "max_leaf_nodes"}
    ),
}

_EMPTY_NOTE = "no fold produced predictions"


class LeakageError(ValueError):
    """A split lets training observations see the test block."""


@dataclass(frozen=True, slots=True)
class ModelSpec:
    """A learner choice plus its explicitly allowed parameters."""

    name: str
    kind: str = "ridge"
    params: Mapping[str, Any] = field(default_factory=dict)

    def __post_init__(self) -> None:
        if not isinstance(self.name, str) or not self.name.strip():
            raise ValueError("model name must be a non-empty string")
        if self.kind not in _MODEL_PARAMS:
            raise ValueError(
                f"unknown model kind {self.kind!r}; "
                f"allowed: {sorted(_MODEL_PARAMS)}"
            )
        params = dict(self.params)
        unknown = sorted(set(params) - _MODEL_PARAMS[self.kind])
        if unknown:
            raise ValueError(
                f"unknown parameter(s) for kind {self.kind!r}: {unknown}; "
                f"allowed: {sorted(_MODEL_PARAMS[self.kind])}"
            )
        object.__setattr__(self, "params", params)


@dataclass(frozen=True, slots=True)
class FoldPrediction:
    """One fold's out-of-sample block and the statistics used to produce it."""

    fold: int
    train_bounds: tuple[int, int]
    test_bounds: tuple[int, int]
    purged: int
    n_train_samples: int
    n_test_predictions: int
    used_features: tuple[str, ...]
    scaler_mean: pd.Series
    scaler_scale: pd.Series
    predictions: pd.DataFrame


@dataclass(frozen=True, slots=True)
class SkippedFold:
    """A fold with a training window that could not support a fit."""

    fold: int
    train_bounds: tuple[int, int]
    test_bounds: tuple[int, int]
    reason: str


@dataclass(frozen=True, slots=True)
class RunMetrics:
    """Out-of-sample metrics; NaN where the sample cannot support a value."""

    n_days: int
    n_pairs: int
    rank_ic_mean: float
    rank_ic_std: float
    rank_ic_ir: float
    rank_ic_t: float
    mse: float
    hit_rate: float
    coverage: float
    rank_ic_by_day: pd.Series


@dataclass(frozen=True, slots=True)
class ComparisonResult:
    """Right-minus-left comparison on a shared out-of-sample grid."""

    n_days: int
    rank_ic_delta: float
    rank_ic_t: float
    mse_delta: float
    coverage_delta: float


@dataclass(frozen=True, slots=True)
class MLRun:
    """Assembled out-of-sample run across folds."""

    predictions: pd.DataFrame
    folds: tuple[FoldPrediction, ...]
    skipped: tuple[SkippedFold, ...]
    metrics: RunMetrics
    importance: pd.Series
    model: ModelSpec
    note: str | None


def _validate_run_parameters(
    n_folds: object,
    horizon: object,
    min_train_samples: object,
    random_state: object,
    standardize: object,
    expanding: object,
    embargo_fraction: object,
) -> None:
    if isinstance(n_folds, bool) or not isinstance(n_folds, int) or n_folds < 2:
        raise ValueError(f"n_folds must be an integer >= 2, got {n_folds!r}")
    if isinstance(horizon, bool) or not isinstance(horizon, int) or horizon < 1:
        raise ValueError(f"horizon must be an integer >= 1, got {horizon!r}")
    if (
        isinstance(min_train_samples, bool)
        or not isinstance(min_train_samples, int)
        or min_train_samples < 2
    ):
        raise ValueError(
            f"min_train_samples must be an integer >= 2, got {min_train_samples!r}"
        )
    if isinstance(random_state, bool) or not isinstance(random_state, int):
        raise ValueError(f"random_state must be an integer, got {random_state!r}")
    if not isinstance(standardize, bool):
        raise ValueError(f"standardize must be a boolean, got {standardize!r}")
    if not isinstance(expanding, bool):
        raise ValueError(f"expanding must be a boolean, got {expanding!r}")
    if (
        isinstance(embargo_fraction, bool)
        or not isinstance(embargo_fraction, (int, float))
        or not 0.0 <= float(embargo_fraction) < 1.0
    ):
        raise ValueError(
            f"embargo_fraction must be in [0, 1), got {embargo_fraction!r}"
        )


def _validate_inputs(
    features: object, labels: object
) -> tuple[list[str], list[pd.DataFrame], np.ndarray]:
    if not isinstance(labels, pd.DataFrame):
        raise TypeError(
            f"labels must be a pandas DataFrame, got {type(labels).__name__}"
        )
    if not isinstance(labels.index, pd.DatetimeIndex):
        raise TypeError("labels index must be a DatetimeIndex")
    if not labels.index.is_unique:
        raise ValueError("labels index must be unique")
    if not labels.index.is_monotonic_increasing:
        raise ValueError("labels index must be strictly ascending")
    if not isinstance(features, Mapping):
        raise TypeError("features must be a mapping of name to DataFrame")
    if not features:
        raise ValueError("features must contain at least one feature")

    names: list[str] = []
    frames: list[pd.DataFrame] = []
    for name, frame in features.items():
        if not isinstance(name, str) or not name:
            raise TypeError(f"feature name must be a non-empty string, got {name!r}")
        if not isinstance(frame, pd.DataFrame):
            raise TypeError(f"feature {name!r} must be a pandas DataFrame")
        if not frame.index.equals(labels.index):
            raise ValueError(f"feature {name!r} index must equal the labels index")
        if not frame.columns.equals(labels.columns):
            raise ValueError(
                f"feature {name!r} columns must equal the labels columns"
            )
        values = np.asarray(frame.to_numpy(dtype=np.float64))
        if np.isinf(values).any():
            raise ValueError(f"feature {name!r} holds an infinite value")
        names.append(name)
        frames.append(frame)

    label_values = np.asarray(labels.to_numpy(dtype=np.float64))
    if np.isinf(label_values).any():
        raise ValueError("labels hold an infinite value")
    return names, frames, label_values


def _build_estimator(spec: ModelSpec, random_state: int):
    params = spec.params
    if spec.kind == "ridge":
        alpha = float(params.get("alpha", 1.0))
        if not np.isfinite(alpha) or alpha < 0.0:
            raise ValueError("ridge alpha must be a finite non-negative number")
        return Ridge(alpha=alpha, fit_intercept=True)
    if spec.kind == "random_forest":
        return RandomForestRegressor(
            n_estimators=int(params.get("n_estimators", 100)),
            max_depth=(
                None
                if params.get("max_depth") is None
                else int(params["max_depth"])
            ),
            min_samples_leaf=int(params.get("min_samples_leaf", 1)),
            n_jobs=1,
            random_state=random_state,
        )
    return GradientBoostingRegressor(
        n_estimators=int(params.get("n_estimators", 100)),
        learning_rate=float(params.get("learning_rate", 0.1)),
        max_leaf_nodes=int(params.get("max_leaf_nodes", 31)),
        random_state=random_state,
    )


def assert_clean_splits(
    splits: Iterable[Split],
    label_end_times: pd.Series | Iterable[int] | np.ndarray | None = None,
    *,
    n_samples: int | None = None,
    embargo_size: int = 0,
) -> list[Split]:
    """Reject any split whose training rows can see the test block.

    Args:
        splits: Splits to audit, in chronological order.
        label_end_times: Last positional index each label covers.
        n_samples: Sample size, forwarded to the auditor.
        embargo_size: Observations that should have been embargoed.

    Returns:
        The splits as a list, in the given order.

    Raises:
        LeakageError: If any split shares indices with its test block, has a
            training label reaching into it, or violates the embargo.
    """
    checked = list(splits)
    for position, split in enumerate(checked, start=1):
        report = detect_boundary_leakage(
            split,
            label_end_times=label_end_times,
            n_samples=n_samples,
            embargo_size=embargo_size,
        )
        if not report.clean:
            raise LeakageError(
                f"fold {position} leaks: shared={report.shared.size} "
                f"overlapping={report.overlapping.size} "
                f"embargo_violations={report.embargo_violations.size}"
            )
    return checked


def _rank_ic(predictions: np.ndarray, labels: np.ndarray) -> float:
    if predictions.size < 2:
        return float("nan")
    ranks = pd.Series(predictions).rank(method="average").to_numpy()
    targets = pd.Series(labels).rank(method="average").to_numpy()
    if np.ptp(ranks) == 0.0 or np.ptp(targets) == 0.0:
        return float("nan")
    return float(np.corrcoef(ranks, targets)[0, 1])


def _metrics(
    predictions: pd.DataFrame, label_values: np.ndarray
) -> RunMetrics:
    values = predictions.to_numpy(dtype=np.float64)
    finite = np.isfinite(values) & np.isfinite(label_values)
    n_pairs = int(finite.sum())
    coverage = float(n_pairs / values.size) if values.size else float("nan")

    if n_pairs:
        residual = values[finite] - label_values[finite]
        mse = float(np.mean(residual * residual))
        products = values[finite] * label_values[finite]
        nonzero = products != 0.0
        hit_rate = (
            float(np.mean(products[nonzero] > 0.0))
            if nonzero.any()
            else float("nan")
        )
    else:
        mse = float("nan")
        hit_rate = float("nan")

    per_day = [
        _rank_ic(values[row][finite[row]], label_values[row][finite[row]])
        for row in range(values.shape[0])
    ]
    rank_ic_by_day = pd.Series(per_day, index=predictions.index, dtype=float)
    usable = rank_ic_by_day.dropna()
    n_days = int(usable.size)
    if n_days >= 2:
        rank_ic_mean = float(usable.mean())
        rank_ic_std = float(usable.std(ddof=1))
        if rank_ic_std > 0.0:
            rank_ic_ir = rank_ic_mean / rank_ic_std
            rank_ic_t = rank_ic_mean / (rank_ic_std / np.sqrt(n_days))
        else:
            rank_ic_ir = float("nan")
            rank_ic_t = float("nan")
    else:
        rank_ic_mean = float("nan")
        rank_ic_std = float("nan")
        rank_ic_ir = float("nan")
        rank_ic_t = float("nan")

    return RunMetrics(
        n_days=n_days,
        n_pairs=n_pairs,
        rank_ic_mean=rank_ic_mean,
        rank_ic_std=rank_ic_std,
        rank_ic_ir=rank_ic_ir,
        rank_ic_t=rank_ic_t,
        mse=mse,
        hit_rate=hit_rate,
        coverage=coverage,
        rank_ic_by_day=rank_ic_by_day,
    )


def fit_predict_panel(
    features: Mapping[str, pd.DataFrame],
    labels: pd.DataFrame,
    *,
    model: ModelSpec | None = None,
    n_folds: int = 5,
    horizon: int = 1,
    expanding: bool = True,
    embargo_fraction: float = 0.01,
    standardize: bool = True,
    random_state: int = 0,
    min_train_samples: int = 10,
) -> MLRun:
    """Fit a learner fold by fold and assemble out-of-sample predictions.

    Args:
        features: Feature name -> wide ``date x instrument`` panel. Insertion
            order is the design-matrix column order.
        labels: Wide panel of forward outcomes, aligned with every feature
            panel. The caller owns the forward-looking convention.
        model: Learner specification; ridge by default.
        n_folds: Walk-forward segments; the first segment trains only.
        horizon: Bars covered by each label, used only for purging.
        expanding: True for an expanding training window, False for rolling.
        embargo_fraction: Forwarded to the splitter.
        standardize: Whether to standardise inside each fold. Statistics are
            computed and reported either way.
        random_state: Seed for the learner.
        min_train_samples: Fewest valid training rows a fold must offer.

    Returns:
        An :class:`MLRun` with the assembled predictions, per-fold audit data,
        metrics, feature importance and a note when nothing could be fitted.

    Raises:
        ValueError: On invalid parameters or panel geometry.
        TypeError: On a non-DataFrame label panel or a non-DatetimeIndex.
        LeakageError: If a generated split fails the audit.
    """
    spec = ModelSpec("ridge") if model is None else model
    _validate_run_parameters(
        n_folds,
        horizon,
        min_train_samples,
        random_state,
        standardize,
        expanding,
        embargo_fraction,
    )
    names, frames, label_values = _validate_inputs(features, labels)
    n_dates, n_assets = label_values.shape
    n_features = len(names)

    label_ends = np.arange(n_dates) + horizon - 1
    splits = assert_clean_splits(
        purged_walk_forward_splits(
            n_dates,
            label_end_times=label_ends,
            n_folds=n_folds,
            embargo_fraction=embargo_fraction,
            expanding=expanding,
        ),
        label_ends,
        n_samples=n_dates,
    )

    tensor = np.stack(
        [np.asarray(frame.to_numpy(dtype=np.float64)) for frame in frames], axis=2
    )
    finite_features = np.isfinite(tensor).all(axis=2)
    finite_labels = np.isfinite(label_values)

    folds: list[FoldPrediction] = []
    skipped: list[SkippedFold] = []
    pieces: list[pd.DataFrame] = []
    row_positions: list[np.ndarray] = []
    importance_total = np.zeros(n_features)
    n_fitted = 0

    for fold_number, split in enumerate(splits, start=1):
        train = split.train
        train_mask = finite_features[train] & finite_labels[train]
        n_train = int(train_mask.sum())
        train_bounds = (int(train[0]), int(train[-1]))
        if n_train < min_train_samples:
            skipped.append(
                SkippedFold(
                    fold=fold_number,
                    train_bounds=train_bounds,
                    test_bounds=split.test_bounds,
                    reason="insufficient_training_samples",
                )
            )
            continue

        x_train = tensor[train][train_mask]
        y_train = label_values[train][train_mask]
        mean = x_train.mean(axis=0)
        scale = x_train.std(axis=0, ddof=0)
        used = scale > 0.0
        if not used.any():
            skipped.append(
                SkippedFold(
                    fold=fold_number,
                    train_bounds=train_bounds,
                    test_bounds=split.test_bounds,
                    reason="no_variance_in_training_features",
                )
            )
            continue

        x_fit = x_train[:, used]
        if standardize:
            x_fit = (x_fit - mean[used]) / scale[used]
        estimator = _build_estimator(spec, random_state)
        estimator.fit(x_fit, y_train)

        test = split.test
        x_test = tensor[test][:, :, used]
        if standardize:
            x_test = (x_test - mean[used]) / scale[used]
        predictable = np.isfinite(x_test).all(axis=2)
        block = np.full((test.size, n_assets), np.nan)
        if predictable.any():
            block[predictable] = np.asarray(
                estimator.predict(x_test[predictable]), dtype=float
            )

        if spec.kind == "ridge":
            raw = np.abs(np.asarray(estimator.coef_, dtype=float)).ravel()
        else:
            raw = np.asarray(estimator.feature_importances_, dtype=float).ravel()
        fold_importance = np.zeros(n_features)
        fold_importance[used] = raw
        total = fold_importance.sum()
        if total > 0.0:
            fold_importance = fold_importance / total
        importance_total += fold_importance
        n_fitted += 1

        fold_frame = pd.DataFrame(
            block, index=labels.index[test], columns=labels.columns
        )
        pieces.append(fold_frame)
        row_positions.append(test)
        folds.append(
            FoldPrediction(
                fold=fold_number,
                train_bounds=train_bounds,
                test_bounds=split.test_bounds,
                purged=split.purged,
                n_train_samples=n_train,
                n_test_predictions=int(np.isfinite(block).sum()),
                used_features=tuple(name for name, keep in zip(names, used) if keep),
                scaler_mean=pd.Series(mean, index=names, dtype=float),
                scaler_scale=pd.Series(
                    np.where(used, scale, 0.0), index=names, dtype=float
                ),
                predictions=fold_frame,
            )
        )

    if pieces:
        predictions = pd.concat(pieces, axis=0)
        if predictions.index.has_duplicates:
            raise RuntimeError("splits produced overlapping test dates")
        if not predictions.index.is_monotonic_increasing:
            raise RuntimeError("splits produced test blocks out of order")
        predicted_labels = label_values[np.concatenate(row_positions)]
        note = None
    else:
        predictions = pd.DataFrame(
            index=labels.index[:0], columns=labels.columns, dtype=float
        )
        predicted_labels = label_values[:0]
        note = _EMPTY_NOTE

    importance = (
        pd.Series(importance_total / n_fitted, index=names, dtype=float)
        if n_fitted
        else pd.Series(np.nan, index=names, dtype=float)
    )

    return MLRun(
        predictions=predictions,
        folds=tuple(folds),
        skipped=tuple(skipped),
        metrics=_metrics(predictions, predicted_labels),
        importance=importance,
        model=spec,
        note=note,
    )


def _difference(right: float, left: float) -> float:
    if np.isnan(right) or np.isnan(left):
        return float("nan")
    return float(right - left)


def compare_runs(left: MLRun, right: MLRun) -> ComparisonResult:
    """Compare two runs on the same out-of-sample grid, right minus left.

    Args:
        left: Baseline run.
        right: Candidate run.

    Returns:
        Paired per-day IC differences, its t statistic, and MSE / coverage
        deltas. Values are NaN where the sample cannot support them.

    Raises:
        ValueError: If the prediction index or columns differ.
    """
    if not left.predictions.index.equals(right.predictions.index):
        raise ValueError("runs must share the same prediction index")
    if not left.predictions.columns.equals(right.predictions.columns):
        raise ValueError("runs must share the same prediction columns")

    baseline = left.metrics.rank_ic_by_day
    candidate = right.metrics.rank_ic_by_day
    paired = baseline.notna() & candidate.notna()
    deltas = (candidate[paired] - baseline[paired]).to_numpy()
    n_days = int(deltas.size)
    if n_days:
        rank_ic_delta = float(deltas.mean())
    else:
        rank_ic_delta = float("nan")
    if n_days >= 2:
        spread = float(deltas.std(ddof=1))
        rank_ic_t = (
            rank_ic_delta / (spread / np.sqrt(n_days))
            if spread > 0.0
            else float("nan")
        )
    else:
        rank_ic_t = float("nan")

    return ComparisonResult(
        n_days=n_days,
        rank_ic_delta=rank_ic_delta,
        rank_ic_t=rank_ic_t,
        mse_delta=_difference(right.metrics.mse, left.metrics.mse),
        coverage_delta=_difference(right.metrics.coverage, left.metrics.coverage),
    )
