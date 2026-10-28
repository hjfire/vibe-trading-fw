"""Leakage-audited cross-sectional learning pipeline: hand vectors and probes."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from src.quantlib.crossvalidation import Split
from src.quantlib.supervised import (
    ComparisonResult,
    LeakageError,
    ModelSpec,
    assert_clean_splits,
    compare_runs,
    fit_predict_panel,
)

START = "2024-01-01"


def wide(values, start=START, columns=None):
    array = np.asarray(values, dtype=float)
    if array.ndim == 1:
        array = array[:, None]
    index = pd.date_range(start, periods=array.shape[0], freq="D")
    if columns is None:
        columns = [f"s{i}" for i in range(array.shape[1])]
    return pd.DataFrame(array, index=index, columns=columns)


def fit(features, labels, **kwargs):
    kwargs.setdefault("model", ModelSpec("m", kind="ridge", params={"alpha": 0.0}))
    kwargs.setdefault("n_folds", 2)
    kwargs.setdefault("standardize", False)
    kwargs.setdefault("min_train_samples", 2)
    return fit_predict_panel(features, labels, **kwargs)


def assert_metrics_equal(left, right):
    assert left.n_days == right.n_days
    assert left.n_pairs == right.n_pairs
    for name in (
        "rank_ic_mean",
        "rank_ic_std",
        "rank_ic_ir",
        "rank_ic_t",
        "mse",
        "hit_rate",
        "coverage",
    ):
        a, b = getattr(left, name), getattr(right, name)
        if isinstance(a, float) and np.isnan(a):
            assert isinstance(b, float) and np.isnan(b), name
        else:
            assert a == b, name
    pd.testing.assert_series_equal(
        left.rank_ic_by_day, right.rank_ic_by_day, check_exact=True
    )


# --------------------------------------------------------------------------- #
# Vector A: OLS exact fit and a perfect daily rank IC
# --------------------------------------------------------------------------- #


def test_vector_a_ols_fit_is_exact_and_daily_rank_ic_is_one():
    t = np.arange(6, dtype=float)
    matrix = np.column_stack([t, t + 1.0])
    labels = wide(2.0 * matrix + 1.0)

    run = fit({"x": wide(matrix)}, labels, n_folds=3)

    assert len(run.folds) == 2
    assert [fold.test_bounds for fold in run.folds] == [(2, 3), (4, 5)]
    assert [fold.train_bounds for fold in run.folds] == [(0, 1), (0, 3)]
    assert [fold.purged for fold in run.folds] == [0, 0]

    expected = pd.DataFrame(
        2.0 * matrix[2:] + 1.0, index=labels.index[2:], columns=labels.columns
    )
    pd.testing.assert_frame_equal(
        run.predictions,
        expected,
        check_exact=False,
        rtol=0,
        atol=1e-12,
        check_freq=False,
    )

    metrics = run.metrics
    assert metrics.n_days == 4
    assert metrics.n_pairs == 8
    assert metrics.rank_ic_mean == pytest.approx(1.0, abs=1e-12)
    assert metrics.rank_ic_std == pytest.approx(0.0, abs=1e-12)
    assert np.isnan(metrics.rank_ic_ir)
    assert np.isnan(metrics.rank_ic_t)
    assert metrics.mse == pytest.approx(0.0, abs=1e-24)
    assert metrics.hit_rate == pytest.approx(1.0, abs=1e-12)
    assert metrics.coverage == pytest.approx(1.0, abs=1e-12)
    assert metrics.rank_ic_by_day.notna().all()
    assert list(run.predictions.columns) == list(labels.columns)


# --------------------------------------------------------------------------- #
# Vector B: ridge shrinkage closed form, single stock per day
# --------------------------------------------------------------------------- #


def test_vector_b_ridge_shrinkage_matches_closed_form():
    x = np.arange(6, dtype=float)
    labels = wide(2.0 * x)

    run = fit(
        {"x": wide(x)},
        labels,
        model=ModelSpec("ridge", kind="ridge", params={"alpha": 17.5}),
        n_folds=3,
    )

    predictions = run.predictions["s0"].to_numpy()
    np.testing.assert_allclose(
        predictions, [13 / 12, 41 / 36, 37 / 9, 41 / 9], rtol=0, atol=1e-12
    )

    fold_one, fold_two = run.folds
    assert fold_one.scaler_mean["x"] == pytest.approx(0.5)
    assert fold_one.scaler_scale["x"] == pytest.approx(0.5)
    assert fold_two.scaler_mean["x"] == pytest.approx(1.5)
    assert fold_two.scaler_scale["x"] == pytest.approx(np.sqrt(1.25))

    metrics = run.metrics
    assert metrics.n_days == 0
    assert np.isnan(metrics.rank_ic_mean)
    assert metrics.n_pairs == 4
    assert metrics.mse == pytest.approx(99666 / 5184, rel=0, abs=1e-12)
    assert metrics.hit_rate == pytest.approx(1.0, abs=1e-12)
    assert metrics.coverage == pytest.approx(1.0, abs=1e-12)


# --------------------------------------------------------------------------- #
# Vector B2: a constant cross-section scores no IC (the ptp guard, not size<2)
# --------------------------------------------------------------------------- #


def test_vector_b2_constant_cross_section_scores_no_ic():
    t = np.arange(6, dtype=float)
    features = {"x": wide(np.column_stack([t, t]))}
    labels = wide(np.column_stack([2.0 * t, -1.0 * t]))

    run = fit(features, labels, n_folds=3)

    assert run.predictions["s0"].to_numpy() == pytest.approx(
        run.predictions["s1"].to_numpy()
    )
    assert run.metrics.n_days == 0
    assert np.isnan(run.metrics.rank_ic_mean)
    assert run.metrics.rank_ic_by_day.isna().all()
    assert run.metrics.n_pairs == 8


# --------------------------------------------------------------------------- #
# Vector C: standardization is invertible for a linear fit
# --------------------------------------------------------------------------- #


def test_vector_c_standardization_preserves_the_linear_fit():
    t = np.arange(6, dtype=float)
    matrix = np.column_stack([t, t + 1.0])
    labels = wide(matrix)

    run = fit({"x": wide(matrix)}, labels, standardize=True)

    expected = pd.DataFrame(
        matrix[3:], index=labels.index[3:], columns=labels.columns
    )
    pd.testing.assert_frame_equal(
        run.predictions,
        expected,
        check_exact=False,
        rtol=0,
        atol=1e-12,
        check_freq=False,
    )

    fold_one = run.folds[0]
    assert fold_one.scaler_mean["x"] == pytest.approx(1.5)
    assert fold_one.scaler_scale["x"] == pytest.approx(np.sqrt(5.5 / 6))
    assert fold_one.used_features == ("x",)


# --------------------------------------------------------------------------- #
# Vector D: horizon drives the purge geometry
# --------------------------------------------------------------------------- #


def _purge_panel(rows=12, stocks=2):
    t = np.arange(rows, dtype=float)
    matrix = np.column_stack([t + i for i in range(stocks)])
    return {"x": wide(matrix)}, wide(0.01 * matrix)


def test_vector_d_horizon_four_purges_three_training_dates():
    features, labels = _purge_panel()
    run = fit(
        features,
        labels,
        model=ModelSpec("ridge", kind="ridge", params={"alpha": 1.0}),
        n_folds=4,
        horizon=4,
        standardize=True,
    )

    assert [fold.test_bounds for fold in run.folds] == [(6, 8), (9, 11)]
    assert [fold.purged for fold in run.folds] == [3, 3]
    assert [fold.n_train_samples for fold in run.folds] == [6, 12]
    assert run.skipped == ()


def test_vector_d_horizon_one_purges_nothing():
    features, labels = _purge_panel()
    run = fit(
        features,
        labels,
        model=ModelSpec("ridge", kind="ridge", params={"alpha": 1.0}),
        n_folds=4,
        horizon=1,
        standardize=True,
    )

    assert [fold.test_bounds for fold in run.folds] == [(3, 5), (6, 8), (9, 11)]
    assert [fold.purged for fold in run.folds] == [0, 0, 0]
    assert [fold.n_train_samples for fold in run.folds] == [6, 12, 18]


def test_vector_d_min_train_samples_skips_the_short_fold():
    features, labels = _purge_panel()
    run = fit(
        features,
        labels,
        model=ModelSpec("ridge", kind="ridge", params={"alpha": 1.0}),
        n_folds=4,
        horizon=4,
        standardize=True,
        min_train_samples=10,
    )

    assert [fold.test_bounds for fold in run.folds] == [(9, 11)]
    assert len(run.skipped) == 1
    assert run.skipped[0].test_bounds == (6, 8)
    assert run.skipped[0].reason == "insufficient_training_samples"


# --------------------------------------------------------------------------- #
# Vector E: the audit rejects dirty splits and accepts a clean one
# --------------------------------------------------------------------------- #


def _split(train, test):
    train = np.asarray(train, dtype=int)
    test = np.asarray(test, dtype=int)
    return Split(
        train=train,
        test=test,
        purged=0,
        embargoed=0,
        test_bounds=(int(test[0]), int(test[-1])),
    )


def test_vector_e_shared_index_is_rejected():
    dirty = _split([0, 1, 2], [2, 3])
    with pytest.raises(LeakageError) as excinfo:
        assert_clean_splits([dirty])
    assert "shared" in str(excinfo.value)


def test_vector_e_label_overlap_is_rejected():
    dirty = _split([0, 1, 2], [3, 4])
    with pytest.raises(LeakageError) as excinfo:
        assert_clean_splits([dirty], label_end_times=[0, 1, 4, 4, 4])
    assert "overlap" in str(excinfo.value)


def test_vector_e_clean_split_passes():
    clean = _split([0, 1, 2], [3, 4])
    result = assert_clean_splits([clean], label_end_times=[0, 1, 2, 4, 4])
    assert result == [clean]


# --------------------------------------------------------------------------- #
# Vector F: in-fold preprocessing and test-period invisibility
# --------------------------------------------------------------------------- #


def _probe_panel():
    t = np.arange(8, dtype=float)
    first = np.column_stack([t, 2.0 * t + 1.0, 0.5 * t - 3.0])
    second = np.column_stack([np.sin(t), np.cos(t), t**1.5])
    labels = 0.01 * first + 0.02 * second
    return {"a": wide(first), "b": wide(second)}, wide(labels)


def _probe_run(features, labels):
    return fit(
        features,
        labels,
        model=ModelSpec("ridge", kind="ridge", params={"alpha": 1.0}),
        n_folds=4,
        standardize=True,
    )


def test_vector_f_test_features_do_not_enter_the_scaler_but_do_drive_predictions():
    features, labels = _probe_panel()
    baseline = _probe_run(features, labels)

    corrupt = {name: frame.copy() for name, frame in features.items()}
    for frame in corrupt.values():
        frame.iloc[2:] = frame.iloc[2:] * 1000.0
    shifted = _probe_run(corrupt, labels)

    pd.testing.assert_series_equal(
        baseline.folds[0].scaler_mean, shifted.folds[0].scaler_mean, check_exact=True
    )
    pd.testing.assert_series_equal(
        baseline.folds[0].scaler_scale, shifted.folds[0].scaler_scale, check_exact=True
    )
    assert not baseline.folds[0].predictions.equals(shifted.folds[0].predictions)


def test_vector_f_training_features_do_change_the_scaler():
    features, labels = _probe_panel()
    baseline = _probe_run(features, labels)

    corrupt = {name: frame.copy() for name, frame in features.items()}
    for frame in corrupt.values():
        frame.iloc[:2] = frame.iloc[:2] + 1.0
    shifted = _probe_run(corrupt, labels)

    assert not baseline.folds[0].scaler_mean.equals(shifted.folds[0].scaler_mean)


def test_vector_f_test_labels_are_invisible_to_predictions():
    features, labels = _probe_panel()
    baseline = _probe_run(features, labels)

    corrupt = labels.copy()
    corrupt.iloc[2:4] = -corrupt.iloc[2:4]
    shifted = _probe_run(features, corrupt)

    pd.testing.assert_frame_equal(
        baseline.folds[0].predictions,
        shifted.folds[0].predictions,
        check_exact=True,
    )
    baseline_ic = baseline.metrics.rank_ic_by_day.iloc[:2]
    shifted_ic = shifted.metrics.rank_ic_by_day.iloc[:2]
    assert baseline_ic.notna().all()
    assert not baseline_ic.equals(shifted_ic)


def test_vector_f_future_features_leave_earlier_folds_untouched():
    features, labels = _probe_panel()
    baseline = _probe_run(features, labels)

    corrupt = {name: frame.copy() for name, frame in features.items()}
    for frame in corrupt.values():
        frame.iloc[4:] = 1e6
    shifted = _probe_run(corrupt, labels)

    pd.testing.assert_series_equal(
        baseline.folds[0].scaler_mean, shifted.folds[0].scaler_mean, check_exact=True
    )
    pd.testing.assert_frame_equal(
        baseline.folds[0].predictions,
        shifted.folds[0].predictions,
        check_exact=True,
    )
    assert not baseline.folds[1].predictions.equals(shifted.folds[1].predictions)


# --------------------------------------------------------------------------- #
# Vector G: NaN policy and zero-variance columns
# --------------------------------------------------------------------------- #


def _nan_panel(rows=6, stocks=2):
    t = np.arange(rows, dtype=float)
    matrix = np.column_stack([t + i for i in range(stocks)])
    return matrix


def test_vector_g_missing_feature_yields_nan_not_zero():
    matrix = _nan_panel()
    features = wide(matrix)
    features.iloc[4, 1] = np.nan

    run = fit({"x": features}, wide(0.01 * matrix), n_folds=3)

    assert np.isnan(run.predictions.iloc[2, 1])
    assert np.isfinite(run.predictions.iloc[2, 0])
    assert np.isfinite(run.predictions.iloc[0, 1])


def test_vector_g_missing_training_label_is_excluded_from_the_count():
    matrix = _nan_panel()
    labels = wide(0.01 * matrix)
    labels.iloc[1, 0] = np.nan

    run = fit({"x": wide(matrix)}, labels, n_folds=3)

    assert run.folds[0].n_train_samples == 3
    assert run.folds[1].n_train_samples == 7


def test_vector_g_constant_column_is_dropped_with_zero_importance():
    matrix = _nan_panel()
    labels = wide(0.01 * matrix)
    base = fit({"x": wide(matrix)}, labels, n_folds=3)
    const = fit(
        {"x": wide(matrix), "const": wide(np.full_like(matrix, 7.0))},
        labels,
        n_folds=3,
    )

    assert "const" not in const.folds[0].used_features
    assert const.folds[0].scaler_scale["const"] == 0.0
    assert const.importance["const"] == 0.0
    pd.testing.assert_frame_equal(base.predictions, const.predictions, check_exact=True)


def test_vector_g_all_nan_column_skips_every_fold():
    matrix = _nan_panel()
    features = {
        "x": wide(matrix),
        "bad": wide(np.full_like(matrix, np.nan)),
    }

    run = fit(features, wide(0.01 * matrix), n_folds=3)

    assert run.folds == ()
    assert len(run.skipped) == 2
    assert {fold.reason for fold in run.skipped} == {"insufficient_training_samples"}
    assert run.predictions.empty
    assert run.metrics.n_pairs == 0
    assert np.isnan(run.metrics.coverage)
    assert run.note == "no fold produced predictions"


# --------------------------------------------------------------------------- #
# Vector H: tree models are deterministic and directionally sane
# --------------------------------------------------------------------------- #


def _tree_panel():
    rows, stocks = 20, 10
    base = np.arange(rows, dtype=float)[:, None]
    x1 = base + np.arange(stocks)[None, :] * 0.1
    x2 = np.tile(np.linspace(-1.0, 1.0, stocks), (rows, 1)) + 0.01 * base
    x3 = np.cos(base) * np.ones((1, stocks)) + np.arange(stocks)[None, :] * 0.05
    labels = 0.01 * x1 + 0.002 * x2
    return {"x1": wide(x1), "x2": wide(x2), "x3": wide(x3)}, wide(labels)


@pytest.mark.parametrize(
    "spec",
    [
        ModelSpec(
            "rf", kind="random_forest", params={"n_estimators": 50, "max_depth": 3}
        ),
        ModelSpec(
            "gbm",
            kind="gradient_boosting",
            params={"n_estimators": 50, "learning_rate": 0.1},
        ),
    ],
    ids=["random_forest", "gradient_boosting"],
)
def test_vector_h_tree_models_are_deterministic(spec):
    features, labels = _tree_panel()

    first = fit(features, labels, model=spec, n_folds=4, min_train_samples=20)
    second = fit(features, labels, model=spec, n_folds=4, min_train_samples=20)

    pd.testing.assert_frame_equal(first.predictions, second.predictions, check_exact=True)
    assert_metrics_equal(first.metrics, second.metrics)
    assert first.predictions.shape == (15, 10)
    assert first.metrics.rank_ic_mean > 0.0
    assert list(first.importance.index) == ["x1", "x2", "x3"]
    assert (first.importance >= 0.0).all()
    assert first.importance.sum() <= 1.0 + 1e-12


# --------------------------------------------------------------------------- #
# Vector I: A-B comparison
# --------------------------------------------------------------------------- #


def test_vector_i_comparing_a_run_with_itself_is_all_zero():
    features, labels = _tree_panel()
    run = fit(
        features,
        labels,
        model=ModelSpec("ridge", kind="ridge", params={"alpha": 1.0}),
        n_folds=4,
        min_train_samples=20,
    )

    result = compare_runs(run, run)

    assert isinstance(result, ComparisonResult)
    assert result.rank_ic_delta == 0.0
    assert result.mse_delta == 0.0
    assert result.coverage_delta == 0.0
    assert np.isnan(result.rank_ic_t)
    assert result.n_days == run.metrics.n_days


def test_vector_i_ridge_vs_tree_reports_a_finite_delta():
    features, labels = _tree_panel()
    ridge = fit(
        features,
        labels,
        model=ModelSpec("ridge", kind="ridge", params={"alpha": 1.0}),
        n_folds=4,
        min_train_samples=20,
    )
    tree = fit(
        features,
        labels,
        model=ModelSpec("rf", kind="random_forest", params={"n_estimators": 30}),
        n_folds=4,
        min_train_samples=20,
    )

    result = compare_runs(ridge, tree)

    assert np.isfinite(result.rank_ic_delta)
    assert np.isfinite(result.mse_delta)
    assert result.coverage_delta == 0.0


def test_vector_i_misaligned_grids_are_rejected():
    features, labels = _tree_panel()
    left = fit(
        features,
        labels,
        model=ModelSpec("ridge", kind="ridge", params={"alpha": 1.0}),
        n_folds=4,
        min_train_samples=20,
    )
    swapped = {name: frame.iloc[:, ::-1] for name, frame in features.items()}
    right = fit(
        swapped,
        labels.iloc[:, ::-1],
        model=ModelSpec("ridge", kind="ridge", params={"alpha": 1.0}),
        n_folds=4,
        min_train_samples=20,
    )

    with pytest.raises(ValueError, match="columns"):
        compare_runs(left, right)


# --------------------------------------------------------------------------- #
# Input validation
# --------------------------------------------------------------------------- #


def _valid_panel(rows=6, stocks=2):
    matrix = _nan_panel(rows, stocks)
    return {"x": wide(matrix)}, wide(0.01 * matrix)


def test_non_dataframe_labels_are_rejected():
    features, _ = _valid_panel()
    with pytest.raises(TypeError, match="DataFrame"):
        fit(features, np.zeros((6, 2)))


def test_non_datetime_index_is_rejected():
    features, labels = _valid_panel()
    broken = labels.copy()
    broken.index = np.arange(len(broken))
    with pytest.raises(TypeError, match="DatetimeIndex"):
        fit(features, broken)


def test_unsorted_index_is_rejected():
    features, labels = _valid_panel()
    broken = labels.iloc[::-1]
    with pytest.raises(ValueError, match="ascending"):
        fit({"x": features["x"].iloc[::-1]}, broken)


def test_duplicate_index_is_rejected():
    features, labels = _valid_panel()
    duplicated = labels.copy()
    duplicated.index = duplicated.index[:-1].append(duplicated.index[-2:-1])
    with pytest.raises(ValueError, match="unique"):
        fit({"x": duplicated}, duplicated)


def test_misaligned_index_is_rejected():
    features, labels = _valid_panel()
    with pytest.raises(ValueError, match="index"):
        fit({"x": features["x"].iloc[:-1]}, labels)


def test_misaligned_columns_are_rejected():
    features, labels = _valid_panel()
    renamed = features["x"].rename(columns={"s0": "other"})
    with pytest.raises(ValueError, match="columns"):
        fit({"x": renamed}, labels)


def test_infinite_feature_is_rejected():
    features, labels = _valid_panel()
    broken = features["x"].copy()
    broken.iloc[0, 0] = np.inf
    with pytest.raises(ValueError, match="inf"):
        fit({"x": broken}, labels)


def test_infinite_label_is_rejected():
    features, labels = _valid_panel()
    broken = labels.copy()
    broken.iloc[0, 0] = -np.inf
    with pytest.raises(ValueError, match="inf"):
        fit(features, broken)


def test_empty_features_mapping_is_rejected():
    _, labels = _valid_panel()
    with pytest.raises(ValueError, match="at least one"):
        fit({}, labels)


def test_non_string_feature_name_is_rejected():
    features, labels = _valid_panel()
    with pytest.raises(TypeError, match="feature name"):
        fit({1: features["x"]}, labels)


def test_unknown_model_kind_is_rejected():
    with pytest.raises(ValueError, match="kind"):
        ModelSpec("x", kind="magic")


def test_unknown_model_parameter_is_rejected():
    with pytest.raises(ValueError, match="param"):
        ModelSpec("x", kind="ridge", params={"alpah": 1.0})


@pytest.mark.parametrize(
    "kwargs, match",
    [
        ({"n_folds": 1}, "n_folds"),
        ({"n_folds": True}, "n_folds"),
        ({"horizon": 0}, "horizon"),
        ({"min_train_samples": 1}, "min_train_samples"),
        ({"random_state": False}, "random_state"),
        ({"standardize": 1}, "standardize"),
        ({"embargo_fraction": 1.0}, "embargo_fraction"),
    ],
)
def test_invalid_run_parameters_are_rejected(kwargs, match):
    features, labels = _valid_panel()
    with pytest.raises(ValueError, match=match):
        fit(features, labels, **kwargs)


# --------------------------------------------------------------------------- #
# Determinism, immutability, purity
# --------------------------------------------------------------------------- #


def test_repeated_runs_are_bitwise_identical():
    features, labels = _probe_panel()
    first = _probe_run(features, labels)
    second = _probe_run(features, labels)

    pd.testing.assert_frame_equal(first.predictions, second.predictions, check_exact=True)
    assert_metrics_equal(first.metrics, second.metrics)
    pd.testing.assert_series_equal(first.importance, second.importance, check_exact=True)


def test_inputs_are_not_mutated():
    features, labels = _probe_panel()
    feature_snapshot = {name: frame.copy(deep=True) for name, frame in features.items()}
    label_snapshot = labels.copy(deep=True)

    _probe_run(features, labels)

    for name, frame in features.items():
        assert frame.equals(feature_snapshot[name])
    assert labels.equals(label_snapshot)


def test_module_has_no_clock_io_or_environment_reads():
    module_path = (
        Path(__file__).resolve().parents[2] / "src" / "quantlib" / "supervised.py"
    )
    source = module_path.read_text(encoding="utf-8")
    for token in ("import os", "import time", "open(", "os.environ"):
        assert token not in source
