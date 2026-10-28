# G2 参数网格寻优 × walk-forward OOS × Deflated Sharpe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task.
> Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增一个纯函数协议：每折只在训练窗里挑参数，测试窗只评估不重挑，
并把网格大小如实交给 `deflated_sharpe_ratio`。

**Architecture:** `agent/src/quantlib/selection.py` 只做三件事：
（1）把「参数名 → 收益序列」规范成矩阵并对齐校验；
（2）用既有 `purged_walk_forward_splits` 切分、逐折按训练窗 Sharpe 选参；
（3）拼接 OOS 并把 `grid_size` 作为 `n_trials` 调用既有
`deflated_sharpe_ratio`。不复制既有公式，不改它们的字节。

**Tech Stack:** Python 3.11+、numpy、pandas、pytest。

---

## Global Constraints

- 只新增 `agent/src/quantlib/selection.py` 与
  `agent/tests/test_walk_forward_selection.py`；`crossvalidation.py`、
  `multipletesting.py` **一个字节不改**（只 import）。
- 不新增第三方依赖。
- 每笔提交 `git commit -s` 且显式 pathspec；禁止 `git add -A` / `git add .` /
  `git commit -a`。
- 不碰 `wiki/**`、`.github/workflows/**`、`tools/ci_grep_gates.sh`、
  `.gitignore`（上游所有）。
- 测试命令固定：在仓库根执行
  `python -m pytest agent/tests/test_walk_forward_selection.py -q`。
- 变异注入后必须按**动手前的内存副本**还原（不用互逆替换），还原后复跑全绿并
  核对 sha256。
- 所有手算常量写死；测试不得调用被测函数来生成期望值。

## File Structure

| 动作 | 路径 | 职责 |
|---|---|---|
| Create | `agent/src/quantlib/selection.py` | 协议实现（约 230 行） |
| Create | `agent/tests/test_walk_forward_selection.py` | 手算向量、未来污染、输入校验（约 220 行） |
| Modify | `agent/src/quantlib/__init__.py` | docstring 的 Submodules 列表加一行 |
| Create | `superpowers/specs/2026-10-28-g2-walkforward-selection-design.md` | 设计（已写） |
| Create | `superpowers/plans/2026-10-28-g2-walkforward-selection.md` | 本文件 |

---

## Task 1: RED——先写测试，确认收集失败

**Files:**
- Create: `agent/tests/test_walk_forward_selection.py`

**Step 1: 写测试文件（全部针，一次写完）**

```python
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
```

**Step 2: 运行确认 RED**

```bash
python -m pytest agent/tests/test_walk_forward_selection.py -q
```

Expected: collection error，`ModuleNotFoundError: No module named 'src.quantlib.selection'`。
把输出末尾 3 行记下来（RED 证据）。

---

## Task 2: GREEN——实现 `selection.py`

**Files:**
- Create: `agent/src/quantlib/selection.py`

**Step 1: 写完整实现**

```python
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
```

**Step 2: 跑测试**

```bash
python -m pytest agent/tests/test_walk_forward_selection.py -q
```

Expected: `20 passed`（若有红，先改实现，不改手算常量）。

**Step 3: 跑一次相邻套件确认没碰坏既有行为**

```bash
python -m pytest agent/tests/test_bench_multiple_testing.py agent/tests/test_walkforward_empty_training_regressions.py agent/tests/test_crossvalidation.py -q
```

Expected: 全绿。记下读数。

---

## Task 3: 变异自证 M1–M6

每枚都按同一循环：**备份 → 注入 → 跑 → 必须红 → 按备份还原 → 复跑绿**。

**Step 0: 备份与基线**

```bash
TASKDIR="C:/Users/fire/AppData/Local/Temp"
cp agent/src/quantlib/selection.py "$TASKDIR/selection.py.baseline"
sha256sum agent/src/quantlib/selection.py
python -m pytest agent/tests/test_walk_forward_selection.py -q
```

记下基线 sha256 与 `20 passed`。

**Step 1: M1 —— 选参改用 test 段 Sharpe**

- 注入：把 `score = _sharpe_or_nan(train[:, column])` 改成
  `score = _sharpe_or_nan(test[:, column])`（`finite.size` 那行仍用 train）。
- Expected red：`test_hand_vector_tiny_choices_and_oos`（chosen 变成 `["B","A"]`）。

**Step 2: M2 —— n_trials 误乘折数**

- 注入：`n_trials = grid_size * attempted_folds`。
- Expected red：`test_hand_vector_long_deflated_fields`
  （`deflated.n_trials` 期望 2、实际 4）。

**Step 3: M3 —— 并列裁决改成 dict 顺序**

- 注入：把 `tied = sorted(...)` 改成 `tied = [names[column] for column in eligible if abs(best - scores[column]) <= TIE_EPSILON]`。
- Expected red：`test_ties_break_on_the_parameter_name_not_insertion_order`
  （第一次插入序是 `b, a`，不排序时选 `b`）。

**Step 4: M4 —— 跳过折仍拼进 OOS**

- 注入：在 `if not eligible:` 分支的 `continue` 前加
  `oos_pieces.append(pd.Series(test[:, 0].copy(), index=index[split.test]))`。
- Expected red：`test_a_fold_with_too_few_training_observations_is_skipped_with_a_reason`
  （`len(result.oos_returns)` 期望 40、实际 80）。

**Step 5: M5 —— trial_sharpe_std 改用 OOS**

- 注入：把 `finite_trials = np.asarray([...])` 那一整段替换成
  `finite_trials = np.asarray([observed_sharpe], dtype=float)`。
- Expected red：`test_hand_vector_long_deflated_fields`
  （`trial_sharpe_std` 期望 0.201389…、实际 0.0，因为只有一个值）。

**Step 5b: M6 —— 摘掉常数列守卫**

- 注入：把 `_sharpe_or_nan` 里的
  `if finite.size < 2 or np.ptp(finite) == 0.0: return float("nan")`
  改成 `if finite.size < 2: return float("nan")`（两行压成一行）。
- Expected red：`test_a_constant_parameter_is_not_eligible`
  （fold 2 训练窗上常数列因浮点求和误差算出约 5.7e15 的假 Sharpe，选中 `constant`）。
- 说明：`sharpe_ratio` 以 `std == 0` 判「无离散」，但对 80 个相同的
  `0.01`，求和的舍入误差让 std 变成 1e-18 量级；`ptp == 0` 是精确判据。

**Step 6: 还原核对**

```bash
cp "$TASKDIR/selection.py.baseline" agent/src/quantlib/selection.py
sha256sum agent/src/quantlib/selection.py
python -m pytest agent/tests/test_walk_forward_selection.py -q
```

Expected: sha256 与 Step 0 一致；`20 passed`。

---

## Task 4: 文档面与门禁

**Step 1: `agent/src/quantlib/__init__.py` docstring 加一行**

在 Submodules 列表的 `crossvalidation` 行后加：

```
  selection    Walk-forward parameter selection with a deflated-Sharpe guard
```

只改 docstring，不加 import（该文件明确「deliberately imports nothing」）。

**Step 2: 门禁读数**

```bash
python -m pytest agent/tests/test_walk_forward_selection.py agent/tests/test_bench_multiple_testing.py agent/tests/test_walkforward_empty_training_regressions.py -q
python -m pytest agent/tests/factors -q
python -m pytest tools/test_wiki_drift.py -q
```

Expected: 全绿；wiki drift 240 passed（本片不改 wiki）。
若出现红，先按「本片 0 贡献」口径比对基线，不调阈值、不修门。

**Step 3: 空白与状态**

```bash
git diff --check
git status --porcelain
```

Expected: `git diff --check` rc=0；`git status` 只多出新文件与 `__init__.py`。

---

## Task 5: 提交与推送

**Step 1: 提交（显式 pathspec）**

```bash
git add agent/src/quantlib/selection.py \
        agent/src/quantlib/__init__.py \
        agent/tests/test_walk_forward_selection.py \
        superpowers/specs/2026-10-28-g2-walkforward-selection-design.md \
        superpowers/plans/2026-10-28-g2-walkforward-selection.md
git commit -s -m "feat(quantlib): walk-forward parameter selection with a DSR guard"
```

**Step 2: 推送前对真值**

```bash
git fetch origin
git ls-remote origin refs/heads/main
git log --oneline -1 origin/main
```

若远程已被 cron 推进：`git merge origin/main`（不 rebase），复跑 Task 4 的门禁后
再推。

**Step 3: 推送**

```bash
git push origin main
```

---

## Self-Review（写完计划后的自查）

- 判据覆盖：spec 的 11 条判据 → Task 1 测试针 20 条一一对应；
  判据 5（并列）→ `test_ties_...`；判据 6（跳过/全跳）→ 三条；判据 7
  （短样本）→ `test_hand_vector_tiny_...`；判据 8（DSR 口径）→ 长向量与单参数；
  判据 9（校验）→ 五条；判据 10（变异）→ Task 3 六枚。
- 坐标：`crossvalidation.py:417`、`multipletesting.py:339` 已现读确认；
  未在 plan 里写会漂的行号作为唯一依据。
- 依赖：只 import 既有模块；`__init__.py` 不加 import。
- 上游面：不碰 `wiki/**`、workflow、`.gitignore`、`ci_grep_gates.sh`。

## 执行期偏差（执行后追加）

1. **落仓前沙盒预演发现两处计划正文缺陷（2026-10-28，执行前修正）**：把
   本计划的 RED/GREEN 代码块原样抽到仓库外沙盒跑，`2 failed, 18 passed`：
   - 常数列在 80 点训练窗上被 `sharpe_ratio` 判为「有离散」——80 个相同的
     `0.01` 求和有舍入误差，`std` 落到 1e-18 量级，假 Sharpe ≈ 5.7e15，
     `constant` 反而被选中。修法：`_sharpe_or_nan` 先按 `np.ptp(finite) == 0`
     判无离散（精确判据），并把验证钉进 Task 3 的 M6。
   - `test_the_test_window_does_not_change_the_choice` 断言两折 `chosen` 都
     不变，但篡改块 `[4,8)` 同时是 fold 2 的训练窗，fold 2 合法换选。修法：
     断言收窄为 fold 1（训练窗 `[0,4)` 不碰篡改块）；spec §6 判据 2 同步
     带日期更正。
   - 计划里四处 `21 passed` / `21 条` 是笔误，实际测试针 **20** 条，已改。
   - 修正后同一抽取脚本重跑：`20 passed`。
### 执行期偏差（2026-10-28，落仓时）

- Task 2 Step 3 的相邻套件路径 `agent/tests/test_crossvalidation.py` 在盘上不存在；
  实际文件是 `agent/tests/quantlib/test_crossvalidation.py`。改按实际路径跑：
  `44 passed`；与另两份合跑 `9 passed`。
- 落仓执行读数：RED 为 `ModuleNotFoundError: No module named 'src.quantlib.selection'`；
  GREEN `20 passed`；四文件合跑 `73 passed`；`agent/tests/factors` `2044 passed, 76 skipped`；
  wiki drift `240 passed`；`git diff --check` rc=0。
- 变异 M1–M6 各自命中指定针（均 `1 failed, 19 deselected`）；还原按动手前的
  内存副本写回，sha256 `9a7e6935…679a3` 与基线一致，复跑 `20 passed`。
  首轮驱动脚本因 pytest 输出含 GBK 字节在解码时崩溃，崩溃点已覆盖第一个变异体，
  当场按备份还原并复验 sha 后才重跑（驱动改为子进程 `PYTHONIOENCODING=utf-8`）。
