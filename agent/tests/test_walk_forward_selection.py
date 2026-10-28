"""Walk-forward selection: choices come from the training window only."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from src.quantlib.selection import walk_forward_selection


TINY = np.array([0.4, 0.2, 0.4, 0.2, -1.1, -0.9, -1.1, -0.9, 1.1, 0.9, 1.1, 0.9])


def _tiny_params() -> dict[str, np.ndarray]:
    return {"A": TINY.copy(), "B": (-TINY).copy()}


def _long_params() -> dict[str, np.ndarray]:
    values = np.empty(120)
    for i in range(120):
        if i < 70:
            values[i] = 0.012 if i % 2 == 0 else -0.008
        else:
            values[i] = -0.012 if (i - 70) % 2 == 0 else 0.008
    return {"A": values, "B": (-values).copy()}


def _alternating(n: int = 120) -> np.ndarray:
    return np.array([0.01, -0.01] * (n // 2))


# ── 手算向量 4.1：12 点 × 2 参数 × 3 段 → 2 折 ──


def test_hand_vector_tiny_choices_and_oos() -> None:
    result = walk_forward_selection(
        _tiny_params(), n_folds=3, min_train_observations=2
    )
    assert [fold.chosen for fold in result.folds] == ["A", "B"]
    np.testing.assert_allclose(
        result.oos_returns.to_numpy(),
        [-1.1, -0.9, -1.1, -0.9, -1.1, -0.9, -1.1, -0.9],
        atol=0.0,
    )
    assert result.grid_size == 2
    assert result.n_trials == 2
    assert result.n_evaluations == 4
    assert result.deflated is None
    assert result.note is not None


def test_default_min_train_observations_rejects_the_tiny_vector() -> None:
    with pytest.raises(ValueError, match="no fold produced an eligible parameter"):
        walk_forward_selection(_tiny_params(), n_folds=3)


# ── 手算向量 4.2：120 点 → DSR 数值面 ──


def test_hand_vector_long_deflated_fields() -> None:
    result = walk_forward_selection(_long_params(), n_folds=3)
    assert [fold.chosen for fold in result.folds] == ["A", "A"]
    assert result.grid_size == 2
    assert result.n_trials == 2
    assert result.n_evaluations == 4
    assert result.deflated is not None
    assert result.deflated.n_trials == 2
    assert result.deflated.n_observations == 80
    assert result.deflated.observed_sharpe == pytest.approx(
        -0.04878030414305711, abs=1e-12
    )
    assert result.deflated.trial_sharpe_std == pytest.approx(
        0.20138952196611307, abs=1e-12
    )
    assert result.deflated.survives is False


def test_training_sharpes_match_the_hand_computed_values() -> None:
    result = walk_forward_selection(_long_params(), n_folds=3)
    assert result.folds[0].train_sharpe == pytest.approx(
        0.19748417658131495, abs=1e-12
    )
    assert result.folds[1].train_sharpe == pytest.approx(
        0.14777215345459818, abs=1e-12
    )


# ── 未来污染：选择只读训练窗 ──


def test_the_test_window_does_not_change_the_choice() -> None:
    baseline = walk_forward_selection(
        _tiny_params(), n_folds=3, min_train_observations=2
    )
    tampered = _tiny_params()
    tampered["A"][4:8] = 100.0
    tampered["B"][4:8] = -100.0
    after = walk_forward_selection(
        tampered, n_folds=3, min_train_observations=2
    )
    # Fold 2 trains on [0, 8), so it legitimately sees the tampered block and
    # may switch. Only fold 1's choice must be invariant: its training window
    # is [0, 4), which never touches the tampered test block.
    assert after.folds[0].chosen == baseline.folds[0].chosen == "A"


def test_a_later_test_block_does_not_change_earlier_choices_or_oos_prefix() -> None:
    baseline = walk_forward_selection(
        _tiny_params(), n_folds=3, min_train_observations=2
    )
    tampered = _tiny_params()
    tampered["A"][8:12] = -100.0
    tampered["B"][8:12] = 100.0
    after = walk_forward_selection(
        tampered, n_folds=3, min_train_observations=2
    )
    assert after.folds[0].chosen == baseline.folds[0].chosen
    np.testing.assert_array_equal(
        after.oos_returns.iloc[:4].to_numpy(),
        baseline.oos_returns.iloc[:4].to_numpy(),
    )


def test_train_and_test_indices_never_overlap() -> None:
    result = walk_forward_selection(_long_params(), n_folds=5)
    for fold in (*result.folds, *result.skipped):
        train = set(range(fold.train_start, fold.train_stop))
        test = set(range(fold.test_start, fold.test_stop))
        assert train.isdisjoint(test)


# ── 并列、不可选、跳过 ──


def test_ties_break_on_the_parameter_name_not_insertion_order() -> None:
    values = _alternating()
    first = walk_forward_selection(
        {"b": values.copy(), "a": values.copy()}, n_folds=3
    )
    second = walk_forward_selection(
        {"a": values.copy(), "b": values.copy()}, n_folds=3
    )
    assert all(fold.chosen == "a" for fold in first.folds)
    assert all(fold.chosen == "a" for fold in second.folds)


def test_a_constant_parameter_is_not_eligible() -> None:
    values = _alternating()
    result = walk_forward_selection(
        {"a": values, "constant": np.full(120, 0.01)}, n_folds=3
    )
    assert all(fold.chosen == "a" for fold in result.folds)


def test_a_fold_with_too_few_training_observations_is_skipped_with_a_reason() -> None:
    values = _alternating()
    sparse = values.copy()
    sparse[:40] = np.nan
    result = walk_forward_selection(
        {"a": sparse}, n_folds=3, min_train_observations=30
    )
    assert len(result.folds) == 1
    assert len(result.skipped) == 1
    assert result.skipped[0].reason == "no_eligible_parameter"
    assert result.n_evaluations == 2
    assert result.n_trials == 1
    assert len(result.oos_returns) == 40


def test_min_train_observations_counts_finite_values_not_rows() -> None:
    values = _alternating()
    sparse = values.copy()
    sparse[:40] = np.nan
    with pytest.raises(ValueError, match="no fold produced an eligible parameter"):
        walk_forward_selection(
            {"a": sparse}, n_folds=3, min_train_observations=41
        )


def test_all_folds_skipped_raises() -> None:
    with pytest.raises(ValueError, match="no fold produced an eligible parameter"):
        walk_forward_selection(
            {"a": _alternating()}, n_folds=3, min_train_observations=10_000
        )


# ── DSR 口径与单参数网格 ──


def test_a_single_parameter_grid_has_no_expected_maximum() -> None:
    result = walk_forward_selection({"only": _alternating()}, n_folds=3)
    assert result.n_trials == 1
    assert result.deflated is not None
    assert result.deflated.n_trials == 1
    assert result.deflated.expected_maximum_sharpe == 0.0


# ── OOS 索引与 NaN ──


def test_oos_returns_keep_the_input_index() -> None:
    index = pd.bdate_range("2024-01-01", periods=120)
    result = walk_forward_selection(
        {"only": pd.Series(_alternating(), index=index)}, n_folds=3
    )
    assert result.oos_returns.index.equals(index[40:120])


def test_nan_in_the_test_window_is_carried_not_filled() -> None:
    params = _long_params()
    params["A"][100] = np.nan
    result = walk_forward_selection(params, n_folds=3)
    assert np.isnan(result.oos_returns.to_numpy()[60])


# ── 输入校验 ──


def test_index_misalignment_is_rejected() -> None:
    index = pd.date_range("2024-01-01", periods=120, freq="B")
    a = pd.Series(_alternating(), index=index)
    b = pd.Series(_alternating(), index=index[::-1])
    with pytest.raises(ValueError, match="not aligned"):
        walk_forward_selection({"a": a, "b": b}, n_folds=3)


def test_mixing_series_and_arrays_is_rejected() -> None:
    series = pd.Series(_alternating())
    with pytest.raises(ValueError, match="not a mix"):
        walk_forward_selection({"a": series, "b": _alternating()}, n_folds=3)


def test_length_mismatch_is_rejected() -> None:
    with pytest.raises(ValueError, match="same length"):
        walk_forward_selection(
            {"a": np.zeros(120), "b": np.zeros(119)}, n_folds=3
        )


def test_empty_mapping_is_rejected() -> None:
    with pytest.raises(ValueError, match="at least one parameter"):
        walk_forward_selection({}, n_folds=3)


def test_n_folds_below_two_is_rejected() -> None:
    with pytest.raises(ValueError, match="n_folds must be an integer >= 2"):
        walk_forward_selection(
            _tiny_params(), n_folds=1, min_train_observations=2
        )
