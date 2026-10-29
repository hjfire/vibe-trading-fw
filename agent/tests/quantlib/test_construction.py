"""Constrained portfolio construction: hand vectors, contracts, row independence."""

from __future__ import annotations

from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from src.quantlib.construction import (
    ConstraintReport,
    WeightResult,
    build_weights,
)

COLUMNS = list("ABCDEFGHIJ")


def panel(values, columns=None, dates=None, start="2024-01-02"):
    """Build a scores panel from a 1-D or 2-D array."""
    array = np.asarray(values, dtype=float)
    if array.ndim == 1:
        array = array[:, None]
    if dates is None:
        dates = pd.date_range(start, periods=array.shape[0], freq="D")
    if columns is None:
        columns = [f"s{i}" for i in range(array.shape[1])]
    return pd.DataFrame(array, index=dates, columns=columns)


def one_row(values, columns=None, **kwargs):
    """Run one date and return (weights ndarray, report)."""
    result = build_weights(panel([values], columns=columns), **kwargs)
    return result.weights.iloc[0].to_numpy(), result.report[0]


def test_long_only_rank_weights():
    weights, report = one_row([0.1, 0.2, 0.3], columns=list("ABC"), long_only=True)

    np.testing.assert_allclose(weights, [0.0, 1 / 3, 2 / 3], rtol=0, atol=1e-15)
    assert report.n_valid == 3
    assert report.n_held == 2
    assert report.gross == pytest.approx(1.0)
    assert report.net == pytest.approx(1.0)
    assert report.max_abs_weight == pytest.approx(2 / 3)
    assert report.turnover == pytest.approx(0.5)
    assert report.capped is False
    assert report.degenerate is None


def test_long_only_average_ranks_for_ties():
    weights, _ = one_row([0.5, 0.5, 0.2, 0.9], columns=list("ABCD"), long_only=True)

    np.testing.assert_allclose(weights, [0.25, 0.25, 0.0, 0.5], rtol=0, atol=1e-15)


def test_long_only_cap_redistributes_iteratively():
    weights, report = one_row(
        [4.0, 3.0, 2.0, 1.0], columns=list("ABCD"), long_only=True, max_weight=0.3
    )

    np.testing.assert_allclose(
        weights, [3 / 10, 3 / 10, 17 / 60, 7 / 60], rtol=0, atol=1e-15
    )
    assert report.capped is True
    assert report.n_held == 4
    assert report.max_abs_weight == pytest.approx(0.3)


def test_long_only_cap_infeasible_raises():
    with pytest.raises(ValueError, match="infeasible cap"):
        build_weights(
            panel([[3.0, 2.0, 1.0]], columns=list("ABC")),
            long_only=True,
            max_weight=0.2,
        )


def test_dollar_neutral_cap_infeasible_raises():
    scores = panel([list(range(1, 9))], columns=COLUMNS[:8])

    with pytest.raises(ValueError, match="infeasible cap"):
        build_weights(scores, max_weight=0.1)


def test_dollar_neutral_weights():
    weights, report = one_row([1.0, 2.0, 3.0, 4.0], columns=list("ABCD"))

    np.testing.assert_allclose(
        weights, [-0.375, -0.125, 0.125, 0.375], rtol=0, atol=1e-15
    )
    assert report.net == pytest.approx(0.0, abs=1e-15)
    assert report.gross == pytest.approx(1.0)
    assert report.max_abs_weight == pytest.approx(0.375)
    assert report.n_held == 4
    assert report.capped is False


def test_dollar_neutral_odd_name_has_zero_centroid():
    weights, report = one_row([1.0, 2.0, 3.0], columns=list("ABC"))

    np.testing.assert_allclose(weights, [-0.5, 0.0, 0.5], rtol=0, atol=1e-15)
    assert report.n_held == 2


def test_dollar_neutral_average_ranks_for_ties():
    weights, _ = one_row([1.0, 1.0, 3.0, 4.0], columns=list("ABCD"))

    np.testing.assert_allclose(
        weights, [-0.25, -0.25, 0.125, 0.375], rtol=0, atol=1e-15
    )


def test_dollar_neutral_cap_applies_per_sign_bucket():
    weights, report = one_row(
        [float(i) for i in range(1, 11)], columns=COLUMNS, max_weight=0.1
    )

    np.testing.assert_allclose(
        weights, [-0.1] * 5 + [0.1] * 5, rtol=0, atol=1e-15
    )
    assert report.capped is True
    assert report.n_held == 10
    assert report.net == pytest.approx(0.0, abs=1e-15)
    assert report.gross == pytest.approx(1.0)


def test_long_only_shrinks_toward_prior():
    weights, report = one_row(
        [1.0, 2.0, 3.0],
        columns=list("ABC"),
        long_only=True,
        prior_weights=panel([[0.5, 0.25, 0.25]], columns=list("ABC")),
        turnover_penalty=0.5,
    )

    np.testing.assert_allclose(
        weights, [1 / 4, 7 / 24, 11 / 24], rtol=0, atol=1e-15
    )
    assert report.turnover == pytest.approx(0.25)
    assert report.capped is False


def test_dollar_neutral_shrinkage_reprojects_after_sign_flip():
    weights, report = one_row(
        [1.0, 2.0, 3.0, 4.0],
        columns=list("ABCD"),
        prior_weights=panel([[0.3, 0.2, 0.1, 0.4]], columns=list("ABCD")),
        turnover_penalty=0.5,
    )

    np.testing.assert_allclose(
        weights, [-1 / 6, -1 / 6, -1 / 6, 0.5], rtol=0, atol=1e-15
    )
    assert report.gross == pytest.approx(1.0)
    assert report.net == pytest.approx(0.0, abs=1e-15)
    assert report.turnover == pytest.approx(0.6)


def test_insufficient_names_goes_flat():
    weights, report = one_row(
        [1.0, np.nan, np.nan], columns=list("ABC"), long_only=True, min_names=2
    )

    np.testing.assert_array_equal(weights, np.zeros(3))
    assert report.n_valid == 1
    assert report.n_held == 0
    assert report.gross == 0.0
    assert report.turnover == 0.0
    assert report.degenerate == "insufficient"


@pytest.mark.parametrize("long_only", [True, False])
def test_no_dispersion_goes_flat(long_only):
    weights, report = one_row([0.7, 0.7, 0.7], columns=list("ABC"), long_only=long_only)

    np.testing.assert_array_equal(weights, np.zeros(3))
    assert report.n_valid == 3
    assert report.degenerate == "no_dispersion"
    assert report.capped is False


def test_single_name_is_no_dispersion_not_insufficient():
    weights, report = one_row([0.4], columns=["A"], long_only=True)

    np.testing.assert_array_equal(weights, np.zeros(1))
    assert report.degenerate == "no_dispersion"


def test_panel_reports_dates_in_order_and_flags_degenerate_rows():
    scores = panel(
        [
            [1.0, 2.0, 3.0],
            [np.nan, np.nan, np.nan],
            [3.0, 2.0, 1.0],
        ],
        columns=list("ABC"),
    )
    prior = panel([[0.2, 0.2, 0.2]] * 3, columns=list("ABC"))
    result = build_weights(scores, prior_weights=prior, turnover_penalty=0.5)

    assert [row.date for row in result.report] == list(result.weights.index)
    np.testing.assert_array_equal(result.weights.iloc[1].to_numpy(), np.zeros(3))
    assert result.report[1].degenerate == "insufficient"
    assert result.report[1].turnover == pytest.approx(0.3)
    assert result.report[0].degenerate is None
    assert result.report[2].degenerate is None


def test_non_finite_scores_are_ineligible():
    weights, report = one_row(
        [1.0, np.inf, -np.inf, np.nan, 2.0, 3.0], columns=COLUMNS[:6], long_only=True
    )

    np.testing.assert_allclose(
        weights, [0.0, 0.0, 0.0, 0.0, 1 / 3, 2 / 3], rtol=0, atol=1e-15
    )
    assert report.n_valid == 3
    assert report.n_held == 2


def test_cap_redistributes_into_zero_weight_name():
    weights, report = one_row(
        [1.0, 2.0], columns=list("AB"), long_only=True, max_weight=0.5
    )

    np.testing.assert_allclose(weights, [0.5, 0.5], rtol=0, atol=1e-15)
    assert report.capped is True
    assert report.n_held == 2


def test_cap_equal_to_max_is_not_flagged():
    weights, report = one_row(
        [1.0, 2.0, 3.0], columns=list("ABC"), long_only=True, max_weight=2 / 3
    )

    np.testing.assert_allclose(weights, [0.0, 1 / 3, 2 / 3], rtol=0, atol=1e-15)
    assert report.capped is False


def test_cap_single_round_redistribution():
    weights, report = one_row(
        [1.0, 2.0, 3.0], columns=list("ABC"), long_only=True, max_weight=0.6
    )

    np.testing.assert_allclose(weights, [1 / 30, 11 / 30, 3 / 5], rtol=0, atol=1e-15)
    assert report.capped is True


def test_report_is_typed_tuple():
    result = build_weights(panel([[1.0, 2.0]], columns=list("AB")), long_only=True)

    assert isinstance(result, WeightResult)
    assert isinstance(result.weights, pd.DataFrame)
    assert isinstance(result.report, tuple)
    assert len(result.report) == len(result.weights) == 1
    assert isinstance(result.report[0], ConstraintReport)
    assert isinstance(result.report[0].date, pd.Timestamp)
    assert isinstance(result.report[0].n_valid, int)
    assert isinstance(result.report[0].gross, float)
    assert isinstance(result.report[0].capped, bool)


def test_turnover_uses_raw_prior():
    _, report = one_row(
        [1.0, 2.0, 3.0],
        columns=list("ABC"),
        long_only=True,
        prior_weights=panel([[1.0, 0.0, 0.0]], columns=list("ABC")),
        turnover_penalty=0.0,
    )

    assert report.turnover == pytest.approx(1.0)


def test_prior_without_direction_falls_back_to_target():
    long_weights, _ = one_row(
        [1.0, 2.0, 3.0],
        columns=list("ABC"),
        long_only=True,
        prior_weights=panel([[0.0, 0.0, 0.0]], columns=list("ABC")),
        turnover_penalty=1.0,
    )
    neutral_weights, _ = one_row(
        [1.0, 2.0, 3.0, 4.0],
        columns=list("ABCD"),
        prior_weights=panel([[0.25, 0.25, 0.25, 0.25]], columns=list("ABCD")),
        turnover_penalty=1.0,
    )

    np.testing.assert_allclose(long_weights, [0.0, 1 / 3, 2 / 3], rtol=0, atol=1e-15)
    np.testing.assert_allclose(
        neutral_weights, [-0.375, -0.125, 0.125, 0.375], rtol=0, atol=1e-15
    )


def test_constraints_hold_across_a_mixed_panel():
    scores = panel(
        [
            [1.0, 2.0, 3.0, 4.0],
            [4.0, 3.0, 2.0, 1.0],
            [2.0, 1.0, 4.0, 3.0],
            [0.5, 0.4, 0.3, 0.2],
            [1.0, 1.0, 1.0, 1.0],
            [2.0, -1.0, 0.0, 5.0],
            [np.nan, np.nan, np.nan, np.nan],
        ],
        columns=list("ABCD"),
    )

    for long_only in (True, False):
        result = build_weights(
            scores, long_only=long_only, gross=1.0, max_weight=0.25
        )
        assert len(result.report) == len(scores.index)
        for i, report in enumerate(result.report):
            weights = result.weights.iloc[i].to_numpy()
            if report.degenerate is not None:
                np.testing.assert_array_equal(weights, np.zeros(4))
                continue
            assert np.all(np.abs(weights) <= 0.25 + 1e-12)
            if long_only:
                assert np.all(weights >= 0)
                assert abs(weights.sum() - 1.0) <= 1e-12
            else:
                assert abs(weights.sum()) <= 1e-12
                assert abs(np.abs(weights).sum() - 1.0) <= 1e-12


def test_cap_and_shrinkage_together_stay_inside_constraints():
    weights, report = one_row(
        [1.0, 2.0, 3.0, 4.0],
        columns=list("ABCD"),
        long_only=True,
        prior_weights=panel([[0.4, 0.3, 0.2, 0.1]], columns=list("ABCD")),
        turnover_penalty=0.5,
        max_weight=0.25,
    )

    np.testing.assert_allclose(weights, [0.25] * 4, rtol=0, atol=1e-15)
    assert report.capped is True


def test_rows_are_independent():
    scores = panel(
        [[1.0, 2.0, 3.0, 4.0], [4.0, 3.0, 2.0, 1.0], [0.1, 0.2, 0.3, 0.4]],
        columns=list("ABCD"),
    )
    baseline = build_weights(scores)
    edited = scores.copy(deep=True)
    edited.iloc[1] = [np.nan, np.nan, 9.0, -9.0]
    changed = build_weights(edited)

    np.testing.assert_array_equal(
        changed.weights.iloc[0].to_numpy(), baseline.weights.iloc[0].to_numpy()
    )
    np.testing.assert_array_equal(
        changed.weights.iloc[2].to_numpy(), baseline.weights.iloc[2].to_numpy()
    )
    assert changed.report[0] == baseline.report[0]
    assert changed.report[2] == baseline.report[2]
    assert not np.array_equal(
        changed.weights.iloc[1].to_numpy(), baseline.weights.iloc[1].to_numpy()
    )


def test_same_input_twice_is_bit_identical():
    scores = panel(
        [[1.0, 2.0, 3.0, 4.0], [4.0, 3.0, 2.0, 1.0]], columns=list("ABCD")
    )
    prior = panel([[0.1, 0.2, 0.3, 0.4]] * 2, columns=list("ABCD"))
    kwargs = dict(prior_weights=prior, turnover_penalty=0.3, max_weight=0.4)
    first = build_weights(scores, **kwargs)
    second = build_weights(scores, **kwargs)

    assert first.weights.equals(second.weights)
    assert first.report == second.report


def test_inputs_are_not_modified():
    scores = panel([[1.0, 2.0, 3.0]], columns=list("ABC"))
    prior = panel([[0.2, 0.3, 0.5]], columns=list("ABC"))
    scores_before = scores.copy(deep=True)
    prior_before = prior.copy(deep=True)

    build_weights(scores, prior_weights=prior, turnover_penalty=0.5, max_weight=0.6)

    assert scores.equals(scores_before)
    assert prior.equals(prior_before)


def test_module_has_no_io_or_clock_imports():
    module_path = (
        Path(__file__).resolve().parents[2] / "src" / "quantlib" / "construction.py"
    )
    source = module_path.read_text(encoding="utf-8")

    for token in ("import os", "import time", "open(", "os.environ", "random"):
        assert token not in source


# ── error contract ────────────────────────────────────────────────────────


def test_scores_must_be_a_dataframe():
    with pytest.raises(TypeError, match="DataFrame"):
        build_weights([1.0, 2.0, 3.0])


def test_scores_index_must_be_a_datetime_index():
    scores = pd.DataFrame(
        [[1.0, 2.0]], index=[0], columns=list("AB")
    )

    with pytest.raises(TypeError, match="DatetimeIndex"):
        build_weights(scores)


@pytest.mark.parametrize(
    "frame",
    [
        pd.DataFrame(index=pd.DatetimeIndex([]), columns=["A"], dtype=float),
        pd.DataFrame(index=pd.date_range("2024-01-02", periods=1), columns=[], dtype=float),
        pd.DataFrame(
            [[1.0, 2.0]],
            index=pd.DatetimeIndex(["2024-01-02", "2024-01-02"]),
            columns=["A", "B"],
        ),
        pd.DataFrame(
            [[1.0, 2.0]],
            index=pd.DatetimeIndex(["2024-01-03", "2024-01-02"]),
            columns=["A", "B"],
        ),
        pd.DataFrame(
            [[1.0, 2.0]],
            index=pd.date_range("2024-01-02", periods=1),
            columns=["A", "A"],
        ),
        pd.DataFrame(
            [[1.0]],
            index=pd.date_range("2024-01-02", periods=1),
            columns=[1],
        ),
        pd.DataFrame(
            [[1.0]],
            index=pd.date_range("2024-01-02", periods=1),
            columns=[""],
        ),
    ],
    ids=[
        "no-rows",
        "no-columns",
        "duplicate-dates",
        "unsorted-dates",
        "duplicate-columns",
        "non-string-column",
        "empty-column-name",
    ],
)
def test_scores_frame_contract(frame):
    with pytest.raises(ValueError):
        build_weights(frame)


def test_scores_must_be_numeric():
    scores = pd.DataFrame(
        [["not-a-number"]],
        index=pd.date_range("2024-01-02", periods=1),
        columns=["A"],
    )

    with pytest.raises(ValueError, match="numeric"):
        build_weights(scores)


def test_long_only_must_be_bool():
    with pytest.raises(TypeError, match="long_only"):
        build_weights(panel([[1.0, 2.0]], columns=list("AB")), long_only=1)


@pytest.mark.parametrize(
    "kwargs",
    [
        {"gross": 0.0},
        {"gross": -1.0},
        {"gross": float("inf")},
        {"gross": float("nan")},
        {"gross": True},
        {"max_weight": 0.0},
        {"max_weight": -0.5},
        {"max_weight": float("inf")},
        {"max_weight": True},
        {"turnover_penalty": -0.1},
        {"turnover_penalty": 1.1},
        {"turnover_penalty": float("nan")},
        {"turnover_penalty": True},
        {"min_names": 0},
        {"min_names": True},
        {"min_names": 1.5},
    ],
    ids=[
        "gross-zero",
        "gross-negative",
        "gross-inf",
        "gross-nan",
        "gross-bool",
        "cap-zero",
        "cap-negative",
        "cap-inf",
        "cap-bool",
        "lambda-negative",
        "lambda-above-one",
        "lambda-nan",
        "lambda-bool",
        "min-names-zero",
        "min-names-bool",
        "min-names-float",
    ],
)
def test_bad_parameters(kwargs):
    with pytest.raises(ValueError):
        build_weights(panel([[1.0, 2.0]], columns=list("AB")), **kwargs)


def test_turnover_penalty_requires_prior():
    with pytest.raises(ValueError, match="prior_weights"):
        build_weights(panel([[1.0, 2.0]], columns=list("AB")), turnover_penalty=0.5)


def test_prior_must_be_dataframe():
    with pytest.raises(TypeError, match="prior_weights"):
        build_weights(
            panel([[1.0, 2.0]], columns=list("AB")),
            prior_weights=[[0.5, 0.5]],
        )


@pytest.mark.parametrize(
    "prior",
    [
        pd.DataFrame(
            [[0.5, 0.5]],
            index=pd.date_range("2024-01-03", periods=1),
            columns=["A", "B"],
        ),
        pd.DataFrame(
            [[0.5, 0.5]],
            index=pd.date_range("2024-01-02", periods=1),
            columns=["B", "A"],
        ),
        pd.DataFrame(
            [[0.5, np.nan]],
            index=pd.date_range("2024-01-02", periods=1),
            columns=["A", "B"],
        ),
        pd.DataFrame(
            [[np.inf, 0.0]],
            index=pd.date_range("2024-01-02", periods=1),
            columns=["A", "B"],
        ),
    ],
    ids=["wrong-index", "reordered-columns", "nan", "inf"],
)
def test_prior_contract(prior):
    with pytest.raises(ValueError):
        build_weights(
            panel([[1.0, 2.0]], columns=list("AB")),
            prior_weights=prior,
            turnover_penalty=0.5,
        )
