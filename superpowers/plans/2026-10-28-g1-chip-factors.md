# G1 筹码因子与筹码信号 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. 本片按用户 2026-10-28 的授权**内联自主执行**，不派 Agent（2026-10-24 起拒绝派单，不得声称第二评审席）。

**Goal:** 新增一个只吃日线 OHLC + 换手率的筹码成本分布引擎、四枚 zoo alpha 与三类筹码信号，全部可用手算向量与独立 oracle 对账。

**Architecture:** 纯函数引擎 `chips.py` 按「每日三角分布 + 换手率递归混合 + 绝对整数分价格格」维护持仓成本分布，输出六列宽表；四枚 zoo alpha 各自只是引擎一列的薄包装；信号模块在引擎输出上做滚动比较。所有模块无 I/O、无网络、无全局状态。

**Tech Stack:** Python 3.11、numpy、pandas、pytest；不引入新依赖。

**Spec:** `superpowers/specs/2026-10-28-g1-chip-factors-design.md`（模型、单位、离散化、指标、信号、验收全部冻结在该文件；执行时以 spec 为准，计划与 spec 冲突时停下核对）

## Global Constraints

- 全程自主推进，不逐项请示（用户 2026-10-28 明示「全程不需要我审核」）；破坏性操作、范围重定、对外可见操作（Issue、评论、推送说明）仍须停。
- 提交一律 `git commit -s` ＋显式 pathspec；禁止 `git add -A` / `git add .` / `git commit -a`。
- 改动严格限定在项目范围内：不动全局 git 配置、Node/Python/pnpm/uv 工具链、`.pnpm-store`、SQLite。
- `.github/workflows/test.yml` 为上游所有，绝对保护（只读）。
- 商标词不得复写进跟踪面或 scratch 面；提交消息同样不写。
- 交易指标禁用未来函数：本片以后端等价自查代替 Bar Replay——「前缀==全量」与「未来污染」两针必须为 0 差异，并在最终报告附后端五步自查。
- 恒红门先证「本片 0 贡献」再报告；不调阈值、不修门、不清白名单。
- `TUSHARE_TOKEN` 只报存在/长度，不打印值；不提交可能含密钥的文件。
- fork 二开：origin=`hjfire/vibe-trading-fw`，upstream=`HKUDS/Vibe-Trading`；推送前 `git ls-remote` 对真值；合入用 merge 不用 rebase。
- 许可证路径：只按公开定义自研，一行第三方代码不搬，不调用 cyq_* 端点；对方 Issue 未经授权不发。
- 所有命令从仓库根执行；本机 Python 3.11.9。

---

## File Structure

- Create: `agent/src/factors/chips.py` — 筹码分布引擎（纯函数，宽表进宽表出）。
- Create: `agent/src/factors/chip_signals.py` — 三类信号（纯函数）。
- Create: `agent/src/factors/zoo/chip/__init__.py` — zoo 包文档。
- Create: `agent/src/factors/zoo/chip/cost_deviation.py` — `chip_cost_deviation`。
- Create: `agent/src/factors/zoo/chip/profit_ratio.py` — `chip_profit_ratio`。
- Create: `agent/src/factors/zoo/chip/concentration.py` — `chip_concentration`。
- Create: `agent/src/factors/zoo/chip/concentration_change_20.py` — `chip_concentration_change_20`。
- Create: `agent/tests/factors/test_chip_engine.py` — 手算向量、oracle、前缀、污染、缺口语义、上限。
- Create: `agent/tests/factors/test_chip_signals.py` — 三信号的命中/未命中/掩码/互斥。
- Create: `agent/tests/factors/test_chip_registry.py` — 注册表契约与引擎一致性。
- Modify: `agent/backtest/loaders/valuation_loader.py` — `VALUATION_FIELDS` 追加 `turnover_rate`，头注写百分数。
- Modify: `agent/tests/factors/test_fundamental_valuation_samples.py:335` — 白名单元组断言改新元组；新增接受测试。
- Modify: `agent/tests/factors/test_alpha_purity.py:47` — 仓内 import 白名单从单元素字符串改成集合，纳入 `src.factors.chips`。
- Modify: `agent/tests/factors/test_missing_bar_fabrication.py` — `_base()` 末尾追加 `val:turnover_rate`；新增 `CHIP_STATEFUL` 豁免集并接入价值 oracle 与存在性断言。
- Modify: `wiki/alpha-library/i18n.zh.json` — 四枚 alpha 的 `notes` 与 `nicknames` 中文条目。
- Modify: `项目档案.md` — 追加 §7.33。

---

### Task 1: 引擎核心与手算向量 A–E

**Files:**
- Create: `agent/src/factors/chips.py`
- Test: `agent/tests/factors/test_chip_engine.py`

**Interfaces:**
- Consumes: 无（本片第一块）。
- Produces:
  - `triangular_cdf(x, low, mode, high) -> np.ndarray`（`mode` 夹到支撑内，`high<=low` 为阶跃）。
  - `chip_metrics(high, low, close, turnover_rate, *, tick=0.01, coverage=0.90, max_bins_per_day=2048, max_span_bins=4_000_000) -> dict[str, pd.DataFrame]`，键集合 `METRICS = ("mass","avg_cost","cost_deviation","profit_ratio","concentration","concentration_change_20")`；输入输出都是 `index=trading_date`、`columns=instrument_code` 的宽表。
  - 模块常量 `DEFAULT_TICK=0.01`、`DEFAULT_COVERAGE=0.90`、`DEFAULT_MAX_BINS_PER_DAY=2048`、`DEFAULT_MAX_SPAN_BINS=4_000_000`、`CONCENTRATION_CHANGE_WINDOW=20`。

- [ ] **Step 1: 写失败测试（手算向量 A–E ＋多标的隔离 ＋对齐校验）**

Create `agent/tests/factors/test_chip_engine.py`:

```python
"""Chip engine hand vectors (A-E) frozen from the G1 design.

Every expected number is derivable by hand; the derivation lives in
``superpowers/specs/2026-10-28-g1-chip-factors-design.md`` section 6.1.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from src.factors.chips import chip_metrics

INDEX = pd.bdate_range("2024-01-02", periods=200)
COLUMNS = ["X.SH"]


def _frame(values) -> pd.DataFrame:
    array = np.asarray(values, dtype=float)
    if array.ndim == 1:
        array = array[:, None]
    return pd.DataFrame(array, index=INDEX[: len(array)], columns=COLUMNS)


def _run(high, low, close, turnover, **kwargs) -> dict[str, pd.DataFrame]:
    return chip_metrics(_frame(high), _frame(low), _frame(close), _frame(turnover), **kwargs)


def test_vector_a_single_point_day() -> None:
    out = _run([10.0], [10.0], [10.0], [50.0])
    assert out["mass"].iloc[0, 0] == pytest.approx(0.5)
    assert out["avg_cost"].iloc[0, 0] == pytest.approx(10.0)
    assert out["cost_deviation"].iloc[0, 0] == pytest.approx(0.0)
    assert out["profit_ratio"].iloc[0, 0] == pytest.approx(1.0)
    assert out["concentration"].iloc[0, 0] == pytest.approx(0.0)
    assert np.isnan(out["concentration_change_20"].iloc[0, 0])


def test_vector_b_two_days_triangular_second_day() -> None:
    out = _run([10.0, 11.0], [10.0, 9.0], [10.0, 10.0], [50.0, 100.0])
    assert out["mass"].iloc[1, 0] == pytest.approx(1.0)
    assert out["avg_cost"].iloc[1, 0] == pytest.approx(10.0, abs=1e-9)
    assert out["cost_deviation"].iloc[1, 0] == pytest.approx(0.0, abs=1e-9)
    assert out["profit_ratio"].iloc[1, 0] == pytest.approx(0.5, abs=1e-9)
    assert out["concentration"].iloc[1, 0] == pytest.approx(0.0685, abs=2e-3)


def test_vector_c_missing_bar_carries_the_state() -> None:
    out = _run(
        [10.0, np.nan, 12.0],
        [10.0, np.nan, 12.0],
        [10.0, np.nan, 12.0],
        [50.0, np.nan, 50.0],
    )
    for metric in ("mass", "avg_cost", "cost_deviation", "profit_ratio", "concentration"):
        assert np.isnan(out[metric].iloc[1, 0]), metric
    assert out["mass"].iloc[2, 0] == pytest.approx(0.75)
    assert out["avg_cost"].iloc[2, 0] == pytest.approx(11.333333333333334, abs=1e-9)
    assert out["cost_deviation"].iloc[2, 0] == pytest.approx(0.05882352941176465, abs=1e-9)
    assert out["profit_ratio"].iloc[2, 0] == pytest.approx(1.0)
    assert out["concentration"].iloc[2, 0] == pytest.approx(0.09095, abs=1e-3)


def test_vector_d_constant_series_change_is_zero_at_row_20() -> None:
    n = 22
    out = _run([11.0] * n, [9.0] * n, [10.0] * n, [100.0] * n)
    assert np.isnan(out["concentration_change_20"].iloc[19, 0])
    assert out["concentration_change_20"].iloc[20, 0] == pytest.approx(0.0)
    assert out["concentration_change_20"].iloc[21, 0] == pytest.approx(0.0)


def test_vector_e_adaptive_step_coarsens_the_ladder() -> None:
    out = _run([40.0], [10.0], [20.0], [100.0], max_bins_per_day=100)
    assert out["mass"].iloc[0, 0] == pytest.approx(1.0)
    assert out["avg_cost"].iloc[0, 0] == pytest.approx(24.444444444444443, abs=1e-9)
    assert out["cost_deviation"].iloc[0, 0] == pytest.approx(-0.18181818181818177, abs=1e-9)
    assert out["profit_ratio"].iloc[0, 0] == pytest.approx(0.25005, abs=1e-9)
    assert out["concentration"].iloc[0, 0] == pytest.approx(0.4149151, abs=2e-3)


def test_symbols_are_computed_independently() -> None:
    high = pd.DataFrame(
        {"A.SH": [10.0, 11.0], "B.SH": [10.0, 10.0]},
        index=INDEX[:2],
    )
    low = pd.DataFrame(
        {"A.SH": [10.0, 9.0], "B.SH": [10.0, 10.0]},
        index=INDEX[:2],
    )
    close = pd.DataFrame(
        {"A.SH": [10.0, 10.0], "B.SH": [10.0, 10.0]},
        index=INDEX[:2],
    )
    turnover = pd.DataFrame(
        {"A.SH": [50.0, 100.0], "B.SH": [50.0, 100.0]},
        index=INDEX[:2],
    )
    out = chip_metrics(high, low, close, turnover)
    assert out["concentration"].iloc[1, 0] == pytest.approx(0.0685, abs=2e-3)
    assert out["profit_ratio"].iloc[1, 1] == pytest.approx(1.0)


def test_misaligned_frames_raise() -> None:
    high = _frame([10.0, 11.0])
    low = _frame([9.0, 10.0])
    close = _frame([10.0])
    turnover = _frame([10.0, 10.0])
    with pytest.raises(ValueError, match="aligned"):
        chip_metrics(high, low, close, turnover)
```

- [ ] **Step 2: 跑测试确认 RED**

Run: `python -m pytest agent/tests/factors/test_chip_engine.py -q`
Expected: FAIL/collection error，`ModuleNotFoundError: No module named 'src.factors.chips'`。

- [ ] **Step 3: 写引擎实现**

Create `agent/src/factors/chips.py`:

```python
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
```

- [ ] **Step 4: 跑测试确认 GREEN**

Run: `python -m pytest agent/tests/factors/test_chip_engine.py -q`
Expected: `7 passed`。

- [ ] **Step 5: 提交**

```bash
git add agent/src/factors/chips.py agent/tests/factors/test_chip_engine.py
git commit -s -m "feat(factors): chip distribution engine with analytic average cost" -m "Daily triangular mass on [low, high] mixed by turnover; absolute cent bins keep prefix invariance, and the mean cost is tracked analytically so boundary point masses carry no half-cent bias. Hand vectors A-E pin the ladder, the adaptive step and the missing-bar carry." -m "Signed-off-by: hjfire <307501063+hjfire@users.noreply.github.com>"
```

---

### Task 2: 引擎不变量（oracle／前缀／污染／非法 bar／跨度上限）

**Files:**
- Modify: `agent/tests/factors/test_chip_engine.py`（追加）

**Interfaces:**
- Consumes: `chip_metrics`（Task 1）。
- Produces: 无新接口；这些针是 Task 3 变异自证的对象，也是 Task 8 未来函数自查的证据面。

- [ ] **Step 1: 追加独立 oracle 与不变量测试**

Append to `agent/tests/factors/test_chip_engine.py`:

```python
def _triangular_cdf_point(x: float, low: float, mode: float, high: float) -> float:
    if high <= low:
        return 1.0 if x >= low else 0.0
    mode = min(max(mode, low), high)
    if x <= low:
        return 0.0
    if x >= high:
        return 1.0
    if x <= mode:
        return (x - low) ** 2 / ((high - low) * (mode - low))
    return 1.0 - (high - x) ** 2 / ((high - low) * (high - mode))


def _oracle_day(high, low, close, turnover, day: int, coverage: float = 0.90) -> dict[str, float]:
    """Continuous mixture for ``day``: no price grid, weights rebuilt per day."""
    turnover = np.asarray(turnover, dtype=float)
    high = np.asarray(high, dtype=float)
    low = np.asarray(low, dtype=float)
    close = np.asarray(close, dtype=float)
    valid = (
        np.isfinite(high)
        & np.isfinite(low)
        & np.isfinite(close)
        & np.isfinite(turnover)
        & (high >= low)
        & (low > 0)
        & (turnover >= 0)
    )
    u = np.clip(turnover / 100.0, 0.0, 1.0)
    weights = np.zeros(day + 1)
    for i in range(day, -1, -1):
        if not valid[i]:
            continue
        weight = u[i]
        for k in range(i + 1, day + 1):
            if valid[k]:
                weight *= 1.0 - u[k]
        weights[i] = weight
    mass = float(weights.sum())
    modes = [
        min(max((high[i] + low[i] + close[i]) / 3.0, low[i]), high[i])
        for i in range(day + 1)
    ]
    means = [(high[i] + low[i] + modes[i]) / 3.0 for i in range(day + 1)]
    average = float(sum(weights[i] * means[i] for i in range(day + 1)) / mass)
    profit = float(
        sum(
            weights[i] * _triangular_cdf_point(close[day], low[i], modes[i], high[i])
            for i in range(day + 1)
            if valid[i]
        )
        / mass
    )

    def mixture_cdf(x: float) -> float:
        return float(
            sum(
                weights[i] * _triangular_cdf_point(x, low[i], modes[i], high[i])
                for i in range(day + 1)
                if valid[i]
            )
            / mass
        )

    tail = (1.0 - coverage) / 2.0
    floor_price = min(low[i] for i in range(day + 1) if valid[i])
    ceiling_price = max(high[i] for i in range(day + 1) if valid[i])

    def quantile(q: float) -> float:
        left, right = floor_price, ceiling_price
        for _ in range(60):
            middle = (left + right) / 2.0
            if mixture_cdf(middle) < q:
                left = middle
            else:
                right = middle
        return (left + right) / 2.0

    q_low = quantile(tail)
    q_high = quantile(1.0 - tail)
    return {
        "mass": mass,
        "avg_cost": average,
        "cost_deviation": (close[day] - average) / average,
        "profit_ratio": profit,
        "concentration": (q_high - q_low) / (q_high + q_low),
    }


def _cent_panel(n_rows: int = 60, n_symbols: int = 3, seed: int = 11):
    rng = np.random.default_rng(seed)
    index = pd.bdate_range("2023-03-01", periods=n_rows)
    columns = [f"S{i}.SH" for i in range(n_symbols)]
    close_cents = np.clip(
        1200 + np.cumsum(rng.integers(-30, 31, size=(n_rows, n_symbols)), axis=0),
        800,
        1500,
    )
    high_cents = close_cents + rng.integers(0, 50, size=(n_rows, n_symbols))
    low_cents = np.maximum(
        close_cents - rng.integers(0, 50, size=(n_rows, n_symbols)), 1
    )

    def frame(values):
        return pd.DataFrame(values, index=index, columns=columns)

    return (
        frame(high_cents / 100.0),
        frame(low_cents / 100.0),
        frame(close_cents / 100.0),
        frame(rng.uniform(0.2, 20.0, size=(n_rows, n_symbols))),
        index,
        columns,
    )


ORACLE_TOLERANCES = {
    "mass": 1e-12,
    "avg_cost": 1e-9,
    "cost_deviation": 1e-9,
    "profit_ratio": 1e-9,
    "concentration": 2e-3,
}


def test_continuous_oracle_matches_on_cent_quoted_panels() -> None:
    high, low, close, turnover, index, columns = _cent_panel()
    out = chip_metrics(high, low, close, turnover)
    high_values = high.to_numpy()
    low_values = low.to_numpy()
    close_values = close.to_numpy()
    turnover_values = turnover.to_numpy()
    for day in range(len(index)):
        for position, symbol in enumerate(columns):
            expected = _oracle_day(
                high_values[:, position],
                low_values[:, position],
                close_values[:, position],
                turnover_values[:, position],
                day,
            )
            for metric, tolerance in ORACLE_TOLERANCES.items():
                actual = out[metric].iloc[day, position]
                assert actual == pytest.approx(expected[metric], abs=tolerance, rel=0), (
                    symbol,
                    day,
                    metric,
                    actual,
                    expected[metric],
                )


def test_prefix_equals_full_history() -> None:
    high, low, close, turnover, _, _ = _cent_panel(n_rows=120, n_symbols=3, seed=23)
    full = chip_metrics(high, low, close, turnover)
    prefix = chip_metrics(
        high.iloc[:80], low.iloc[:80], close.iloc[:80], turnover.iloc[:80]
    )
    for metric in (
        "mass",
        "avg_cost",
        "cost_deviation",
        "profit_ratio",
        "concentration",
        "concentration_change_20",
    ):
        pd.testing.assert_frame_equal(
            prefix[metric],
            full[metric].iloc[:80],
            check_exact=False,
            rtol=0,
            atol=1e-12,
        )


def test_future_bars_do_not_change_past_values() -> None:
    high, low, close, turnover, _, _ = _cent_panel(n_rows=120, n_symbols=3, seed=29)
    baseline = chip_metrics(high, low, close, turnover)
    corrupted_high = high.copy()
    corrupted_low = low.copy()
    corrupted_close = close.copy()
    corrupted_turnover = turnover.copy()
    corrupted_high.iloc[60:] = 999.0
    corrupted_low.iloc[60:] = 1.0
    corrupted_close.iloc[60:] = 500.0
    corrupted_turnover.iloc[60:] = 99.0
    corrupted = chip_metrics(
        corrupted_high, corrupted_low, corrupted_close, corrupted_turnover
    )
    for metric in (
        "mass",
        "avg_cost",
        "cost_deviation",
        "profit_ratio",
        "concentration",
        "concentration_change_20",
    ):
        pd.testing.assert_frame_equal(
            baseline[metric].iloc[:60],
            corrupted[metric].iloc[:60],
            check_exact=False,
            rtol=0,
            atol=1e-12,
        )


def test_invalid_bars_are_nan_and_leave_the_state_untouched() -> None:
    high = [10.0, 9.0, 11.0, 10.0, 12.0]
    low = [10.0, 10.0, 9.0, 0.0, 12.0]
    close = [10.0, 9.5, 10.0, 10.0, 12.0]
    turnover = [50.0, 10.0, -1.0, 10.0, 50.0]
    out = _run(high, low, close, turnover)
    for row in (1, 2, 3):
        assert np.isnan(out["mass"].iloc[row, 0]), row
    reference = _run([10.0, 12.0], [10.0, 12.0], [10.0, 12.0], [50.0, 50.0])
    for metric in ("mass", "avg_cost", "cost_deviation", "profit_ratio", "concentration"):
        assert out[metric].iloc[4, 0] == pytest.approx(
            reference[metric].iloc[1, 0], abs=1e-12
        ), metric


def test_span_cap_raises_instead_of_coarsening() -> None:
    with pytest.raises(ValueError, match="spans 21 cent bins"):
        _run([1.2], [1.0], [1.1], [10.0], max_span_bins=20)
```

- [ ] **Step 2: 跑测试确认 GREEN**

Run: `python -m pytest agent/tests/factors/test_chip_engine.py -q`
Expected: `12 passed`。

- [ ] **Step 3: 提交**

```bash
git add agent/tests/factors/test_chip_engine.py
git commit -s -m "test(factors): independent oracle and no-lookahead pins for the chip engine" -m "A continuous mixture oracle (weights rebuilt per day, no price grid) checks 60 cent-quoted days; prefix==full and future-corruption pins compare at atol=1e-12; invalid bars are pinned to a no-op state carry; the span cap raises instead of silently coarsening absolute keys." -m "Signed-off-by: hjfire <307501063+hjfire@users.noreply.github.com>"
```

---

### Task 3: 变异自证 M1–M5

**Files:**
- Modify (临时注入后还原): `agent/src/factors/chips.py`
- 不提交任何改动（本任务只取证）。

**Interfaces:**
- Consumes: Task 1/2 的测试。
- Produces: 每条变异「测试真红」的读数，写进 Task 8 的档案与报告。

- [ ] **Step 1: 记录基线哈希**

```bash
sha256sum agent/src/factors/chips.py | tee /tmp/chips.sha256
python -m pytest agent/tests/factors/test_chip_engine.py -q | tail -2
```
Expected: `12 passed`。

- [ ] **Step 2: 逐条注入变异——每条必须真红，再按动手前的内存副本还原**

每条变异用同一模板（只在 `needle`/`replacement` 两行不同）。下面逐条给出完整命令：

M1 `(1−u)`→`(1+u)`：

```bash
python - <<'PY'
from pathlib import Path
import subprocess, sys
path = Path("agent/src/factors/chips.py")
original = path.read_bytes()
mutated = original.replace(b"weights *= 1.0 - u", b"weights *= 1.0 + u")
assert mutated != original, "M1 needle not found"
path.write_bytes(mutated)
try:
    result = subprocess.run([sys.executable, "-m", "pytest", "agent/tests/factors/test_chip_engine.py", "-q"], capture_output=True, text=True)
    print("M1 rc", result.returncode)
    print(result.stdout.strip().splitlines()[-1])
finally:
    path.write_bytes(original)
print("restored", path.read_bytes() == original)
PY
sha256sum -c /tmp/chips.sha256
```
Expected: `M1 rc 1`（或非 0）且末行为 `failed`；`restored True`；`OK`。

M2 换手率前移一日：

```bash
python - <<'PY'
from pathlib import Path
import subprocess, sys
path = Path("agent/src/factors/chips.py")
original = path.read_bytes()
needle = b"u = min(max(float(turnover_rate[t]) / 100.0, 0.0), 1.0)"
replacement = b"u = min(max(float(turnover_rate[t - 1] if t > 0 else 0.0) / 100.0, 0.0), 1.0)"
mutated = original.replace(needle, replacement)
assert mutated != original, "M2 needle not found"
path.write_bytes(mutated)
try:
    result = subprocess.run([sys.executable, "-m", "pytest", "agent/tests/factors/test_chip_engine.py", "-q"], capture_output=True, text=True)
    print("M2 rc", result.returncode)
    print(result.stdout.strip().splitlines()[-1])
finally:
    path.write_bytes(original)
print("restored", path.read_bytes() == original)
PY
sha256sum -c /tmp/chips.sha256
```
Expected: 非 0 rc，至少 `test_vector_a_single_point_day` 与 `test_vector_b_two_days_triangular_second_day` 变红。

M3 `cost_deviation` 取负：

```bash
python - <<'PY'
from pathlib import Path
import subprocess, sys
path = Path("agent/src/factors/chips.py")
original = path.read_bytes()
needle = b'out["cost_deviation"][t] = (c - avg_cost) / avg_cost'
replacement = b'out["cost_deviation"][t] = (avg_cost - c) / avg_cost'
mutated = original.replace(needle, replacement)
assert mutated != original, "M3 needle not found"
path.write_bytes(mutated)
try:
    result = subprocess.run([sys.executable, "-m", "pytest", "agent/tests/factors/test_chip_engine.py", "-q"], capture_output=True, text=True)
    print("M3 rc", result.returncode)
    print(result.stdout.strip().splitlines()[-1])
finally:
    path.write_bytes(original)
print("restored", path.read_bytes() == original)
PY
sha256sum -c /tmp/chips.sha256
```
Expected: 非 0 rc；`test_vector_c_missing_bar_carries_the_state` 与 `test_vector_e_adaptive_step_coarsens_the_ladder` 变红。

M4 分位 0.05/0.95→0.01/0.99：

```bash
python - <<'PY'
from pathlib import Path
import subprocess, sys
path = Path("agent/src/factors/chips.py")
original = path.read_bytes()
needle = b"tail = (1.0 - coverage) / 2.0"
replacement = b"tail = 0.01"
mutated = original.replace(needle, replacement)
assert mutated != original, "M4 needle not found"
path.write_bytes(mutated)
try:
    result = subprocess.run([sys.executable, "-m", "pytest", "agent/tests/factors/test_chip_engine.py", "-q"], capture_output=True, text=True)
    print("M4 rc", result.returncode)
    print(result.stdout.strip().splitlines()[-1])
finally:
    path.write_bytes(original)
print("restored", path.read_bytes() == original)
PY
sha256sum -c /tmp/chips.sha256
```
Expected: 非 0 rc；集中度向量 B/C 变红。

M5 缺失 bar 重置状态：

```bash
python - <<'PY'
from pathlib import Path
import subprocess, sys
path = Path("agent/src/factors/chips.py")
original = path.read_bytes()
needle = b"        if not valid[t]:\n            continue\n"
replacement = (
    b"        if not valid[t]:\n"
    b"            weights[:] = 0.0\n"
    b"            mass_state = 0.0\n"
    b"            mean_state = 0.0\n"
    b"            continue\n"
)
mutated = original.replace(needle, replacement)
assert mutated != original, "M5 needle not found"
path.write_bytes(mutated)
try:
    result = subprocess.run([sys.executable, "-m", "pytest", "agent/tests/factors/test_chip_engine.py", "-q"], capture_output=True, text=True)
    print("M5 rc", result.returncode)
    print(result.stdout.strip().splitlines()[-1])
finally:
    path.write_bytes(original)
print("restored", path.read_bytes() == original)
PY
sha256sum -c /tmp/chips.sha256
```
Expected: 非 0 rc；`test_vector_c_missing_bar_carries_the_state` 变红。

- [ ] **Step 3: 复核工作树零残留**

```bash
git status --short agent/src/factors/chips.py
```
Expected: 无输出（文件与 HEAD 态一致；此刻尚未提交则在 Task 1 提交后复核）。

---

### Task 4: 四枚 zoo alpha 与纯度白名单

**Files:**
- Create: `agent/src/factors/zoo/chip/__init__.py`
- Create: `agent/src/factors/zoo/chip/cost_deviation.py`
- Create: `agent/src/factors/zoo/chip/profit_ratio.py`
- Create: `agent/src/factors/zoo/chip/concentration.py`
- Create: `agent/src/factors/zoo/chip/concentration_change_20.py`
- Modify: `agent/tests/factors/test_alpha_purity.py:47`
- Test: `agent/tests/factors/test_chip_registry.py`

**Interfaces:**
- Consumes: `chip_metrics`（Task 1）。
- Produces: 四个注册表 id 与各自一列输出——`chip_cost_deviation → cost_deviation`、`chip_profit_ratio → profit_ratio`、`chip_concentration → concentration`、`chip_concentration_change_20 → concentration_change_20`；均为 `columns_required = ["high","low","close","val:turnover_rate"]`、`universe = ["equity_cn"]`。

- [ ] **Step 1: 先写注册表契约测试（RED）**

Create `agent/tests/factors/test_chip_registry.py`:

```python
"""Chip alphas obey the zoo contract and equal the engine's own output."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from src.factors.chips import chip_metrics
from src.factors.registry import Registry, SkipAlpha

CHIP_ALPHAS = {
    "chip_cost_deviation": "cost_deviation",
    "chip_profit_ratio": "profit_ratio",
    "chip_concentration": "concentration",
    "chip_concentration_change_20": "concentration_change_20",
}


def _panel(n_rows: int = 80, n_symbols: int = 3, seed: int = 7) -> dict[str, pd.DataFrame]:
    rng = np.random.default_rng(seed)
    index = pd.bdate_range("2023-01-02", periods=n_rows)
    columns = [f"{600000 + i}.SH" for i in range(n_symbols)]
    cents = np.maximum(
        1000 + np.cumsum(rng.integers(-40, 41, size=(n_rows, n_symbols)), axis=0),
        300,
    )

    def frame(values):
        return pd.DataFrame(values, index=index, columns=columns)

    close = frame(cents / 100.0)
    high = frame(cents / 100.0 + rng.integers(0, 60, size=(n_rows, n_symbols)) / 100.0)
    low = frame(cents / 100.0 - rng.integers(0, 60, size=(n_rows, n_symbols)) / 100.0)
    turnover = frame(rng.uniform(0.5, 8.0, size=(n_rows, n_symbols)))
    return {"high": high, "low": low, "close": close, "val:turnover_rate": turnover}


def test_registry_discovers_the_chip_zoo() -> None:
    registry = Registry()
    assert set(registry.list(zoo="chip")) == set(CHIP_ALPHAS)
    assert all(registry.get(alpha_id).zoo == "chip" for alpha_id in CHIP_ALPHAS)


def test_metadata_contract() -> None:
    registry = Registry()
    for alpha_id in CHIP_ALPHAS:
        meta = registry.get(alpha_id).meta
        assert meta["theme"] == ["microstructure"], alpha_id
        assert meta["columns_required"] == [
            "high",
            "low",
            "close",
            "val:turnover_rate",
        ], alpha_id
        assert meta["universe"] == ["equity_cn"], alpha_id
        assert meta["frequency"] == ["1d"], alpha_id
        assert meta["decay_horizon"] == 20, alpha_id
        assert meta["min_warmup_bars"] == (
            21 if alpha_id.endswith("change_20") else 1
        ), alpha_id
        assert "no third-party code copied" in meta["notes"], alpha_id
        assert "no cyq_* endpoint is called" in meta["notes"], alpha_id


def test_missing_turnover_column_skips() -> None:
    panel = _panel()
    del panel["val:turnover_rate"]
    with pytest.raises(SkipAlpha):
        Registry().compute("chip_profit_ratio", panel)


def test_registry_output_equals_the_engine() -> None:
    panel = _panel()
    panel["val:turnover_rate"].iloc[10:12, 0] = np.nan
    metrics = chip_metrics(
        panel["high"], panel["low"], panel["close"], panel["val:turnover_rate"]
    )
    registry = Registry()
    for alpha_id, metric in CHIP_ALPHAS.items():
        actual = registry.compute(alpha_id, panel)
        pd.testing.assert_frame_equal(actual, metrics[metric])


def test_registry_masks_a_bar_with_a_missing_dependency() -> None:
    panel = _panel()
    panel["close"].iloc[5, 1] = np.nan
    out = Registry().compute("chip_concentration", panel)
    assert np.isnan(out.iloc[5, 1])


def test_change_20_is_nan_through_warmup_then_finite() -> None:
    out = Registry().compute("chip_concentration_change_20", _panel())
    assert np.isnan(out.iloc[:20].to_numpy()).all()
    assert np.isfinite(out.iloc[20:].to_numpy()).all()
```

Run: `python -m pytest agent/tests/factors/test_chip_registry.py -q`
Expected: FAIL——`chip` zoo 尚未注册（`set() != set(CHIP_ALPHAS)`）。

- [ ] **Step 2: 建 zoo 包与四枚 alpha**

Create `agent/src/factors/zoo/chip/__init__.py`:

```python
"""Chip (holding-cost) alpha zoo — factors over the pure chip engine."""
```

Create `agent/src/factors/zoo/chip/cost_deviation.py`:

```python
"""Chip cost deviation: close vs the turnover-weighted average cost."""

from __future__ import annotations

import pandas as pd

from src.factors.chips import chip_metrics

__alpha_meta__ = {
    "id": "chip_cost_deviation",
    "nickname": "Chip cost deviation: close vs turnover-weighted average cost",
    "theme": ["microstructure"],
    "formula_latex": r"\frac{close_t - \bar{cost}_t}{\bar{cost}_t}",
    "columns_required": ["high", "low", "close", "val:turnover_rate"],
    "universe": ["equity_cn"],
    "frequency": ["1d"],
    "decay_horizon": 20,
    "min_warmup_bars": 1,
    "notes": (
        "Daily triangular chip distribution on [low, high] with the mode at the "
        "typical price (high+low+close)/3, mixed by turnover into a "
        "turnover-weighted holding-cost distribution; this factor is the "
        "close's relative deviation from the mean chip cost. Self-implemented "
        "from public definitions; no third-party code copied and no cyq_* "
        "endpoint is called. Price levels are taken as the panel supplies them: "
        "on forward-adjusted panels the historical cost level scales with "
        "corporate actions."
    ),
}


def compute(panel: dict[str, pd.DataFrame]) -> pd.DataFrame:
    """Return the close's relative deviation from the average chip cost."""
    metrics = chip_metrics(
        panel["high"], panel["low"], panel["close"], panel["val:turnover_rate"]
    )
    return metrics["cost_deviation"]
```

Create `agent/src/factors/zoo/chip/profit_ratio.py`:

```python
"""Chip profit ratio: modelled share of holders in profit."""

from __future__ import annotations

import pandas as pd

from src.factors.chips import chip_metrics

__alpha_meta__ = {
    "id": "chip_profit_ratio",
    "nickname": "Chip profit ratio: modelled share of holders in profit",
    "theme": ["microstructure"],
    "formula_latex": r"\frac{\sum_{k:\, k \cdot tick < close_t} W_k}{M_t}",
    "columns_required": ["high", "low", "close", "val:turnover_rate"],
    "universe": ["equity_cn"],
    "frequency": ["1d"],
    "decay_horizon": 20,
    "min_warmup_bars": 1,
    "notes": (
        "Share of the modelled chip mass whose cost is at or below today's "
        "close, i.e. the estimated fraction of holders in profit. Daily "
        "triangular distributions are mixed by turnover; a missing bar leaves "
        "the state untouched. Self-implemented from public definitions; no "
        "third-party code copied and no cyq_* endpoint is called. A "
        "cent-aligned close is exact; an off-grid close is linearly "
        "interpolated inside its bin."
    ),
}


def compute(panel: dict[str, pd.DataFrame]) -> pd.DataFrame:
    """Return the modelled share of chips below today's close."""
    metrics = chip_metrics(
        panel["high"], panel["low"], panel["close"], panel["val:turnover_rate"]
    )
    return metrics["profit_ratio"]
```

Create `agent/src/factors/zoo/chip/concentration.py`:

```python
"""Chip concentration: (q95 - q05) / (q95 + q05) cost dispersion."""

from __future__ import annotations

import pandas as pd

from src.factors.chips import chip_metrics

__alpha_meta__ = {
    "id": "chip_concentration",
    "nickname": "Chip concentration: (q95-q05)/(q95+q05) cost dispersion",
    "theme": ["microstructure"],
    "formula_latex": r"\frac{q_{95} - q_{05}}{q_{95} + q_{05}}",
    "columns_required": ["high", "low", "close", "val:turnover_rate"],
    "universe": ["equity_cn"],
    "frequency": ["1d"],
    "decay_horizon": 20,
    "min_warmup_bars": 1,
    "notes": (
        "Cost dispersion of the chip distribution: (q95 - q05) / (q95 + q05) "
        "of the modelled holding cost, with quantile prices taken at bin "
        "midpoints. Higher = a more dispersed cost basis (the public field is "
        "named concentration, but its direction is dispersion). "
        "Self-implemented from public definitions; no third-party code copied "
        "and no cyq_* endpoint is called."
    ),
}


def compute(panel: dict[str, pd.DataFrame]) -> pd.DataFrame:
    """Return the modelled cost dispersion of the chip distribution."""
    metrics = chip_metrics(
        panel["high"], panel["low"], panel["close"], panel["val:turnover_rate"]
    )
    return metrics["concentration"]
```

Create `agent/src/factors/zoo/chip/concentration_change_20.py`:

```python
"""Chip concentration change over 20 trading days."""

from __future__ import annotations

import pandas as pd

from src.factors.chips import chip_metrics

__alpha_meta__ = {
    "id": "chip_concentration_change_20",
    "nickname": "Chip concentration change over 20 days",
    "theme": ["microstructure"],
    "formula_latex": (
        r"\mathrm{concentration}_t - \mathrm{concentration}_{t-20}"
    ),
    "columns_required": ["high", "low", "close", "val:turnover_rate"],
    "universe": ["equity_cn"],
    "frequency": ["1d"],
    "decay_horizon": 20,
    "min_warmup_bars": 21,
    "notes": (
        "20-trading-day change of the chip cost dispersion "
        "(concentration_t - concentration_{t-20}). Negative values mean the "
        "cost basis is converging. NaN until 20 rows of history exist and "
        "wherever either endpoint is NaN. Self-implemented from public "
        "definitions; no third-party code copied and no cyq_* endpoint is "
        "called."
    ),
}


def compute(panel: dict[str, pd.DataFrame]) -> pd.DataFrame:
    """Return the 20-day change of the modelled cost dispersion."""
    metrics = chip_metrics(
        panel["high"], panel["low"], panel["close"], panel["val:turnover_rate"]
    )
    return metrics["concentration_change_20"]
```

- [ ] **Step 3: 跑纯度门确认 RED**

Run: `python -m pytest agent/tests/factors/test_alpha_purity.py -q`
Expected: FAIL——四枚新 alpha 的 `from src.factors.chips import chip_metrics` 报 `disallowed import-from 'src.factors.chips'`。

- [ ] **Step 4: 扩纯度白名单（只加一个纯计算模块）**

Modify `agent/tests/factors/test_alpha_purity.py`：把第 47 行

```python
# ``src.factors.base`` is the only operator import accepted from this repo.
_ALLOWED_REPO_IMPORT = "src.factors.base"
```

改为

```python
# In-repo imports accepted by this gate. Both modules are pure computation:
# ``base`` holds the shared cross-sectional operators, ``chips`` the chip
# distribution engine. Anything with I/O stays out.
_ALLOWED_REPO_IMPORTS: frozenset[str] = frozenset(
    {"src.factors.base", "src.factors.chips"}
)
```

并把 `_is_allowed_import` 里的

```python
    if module == _ALLOWED_REPO_IMPORT:
        return True
```

改为

```python
    if module in _ALLOWED_REPO_IMPORTS:
        return True
```

同时把模块 docstring 里的白名单条目

```
* Allowed imports (whitelist): ``pandas``, ``numpy``, ``scipy[.*]``,
  ``src.factors.base``, ``__future__``, ``typing``, ``math``, ``dataclasses``.
```

改为

```
* Allowed imports (whitelist): ``pandas``, ``numpy``, ``scipy[.*]``,
  ``src.factors.base``, ``src.factors.chips``, ``__future__``, ``typing``,
  ``math``, ``dataclasses``.
```

- [ ] **Step 5: 跑两条测试确认 GREEN**

Run: `python -m pytest agent/tests/factors/test_chip_registry.py agent/tests/factors/test_alpha_purity.py -q`
Expected: 全部 passed（registry 6 条 ＋ purity 按文件参数化全绿）。

- [ ] **Step 6: 提交**

```bash
git add agent/src/factors/zoo/chip/__init__.py agent/src/factors/zoo/chip/cost_deviation.py agent/src/factors/zoo/chip/profit_ratio.py agent/src/factors/zoo/chip/concentration.py agent/src/factors/zoo/chip/concentration_change_20.py agent/tests/factors/test_chip_registry.py agent/tests/factors/test_alpha_purity.py
git commit -s -m "feat(factors): four chip alphas in a new zoo over val:turnover_rate" -m "Each alpha wraps one engine column; the registry contract tests pin discovery, metadata, SkipAlpha on a missing val:turnover_rate, dependency masking and exact equality with the engine. The purity gate admits src.factors.chips as the second in-repo pure module; its forbidden-name and module-body rules are untouched." -m "Signed-off-by: hjfire <307501063+hjfire@users.noreply.github.com>"
```

---

### Task 5: 三类筹码信号

**Files:**
- Create: `agent/src/factors/chip_signals.py`
- Test: `agent/tests/factors/test_chip_signals.py`

**Interfaces:**
- Consumes: 引擎输出的宽表（`concentration`、`cost_deviation`、`profit_ratio`）＋原始 `close`/`high`/`low` ＋ `turnover_fraction = turnover_rate / 100`。
- Produces:
  - `chip_squeeze_buildup(concentration, cost_deviation, profit_ratio, *, window=20, deviation_max=0.05, profit_min=0.30, profit_max=0.70) -> pd.DataFrame`（1/0/NaN）。
  - `chip_capital_resonance(turnover_fraction, profit_ratio, cost_deviation, *, window=20, multiple=2.0, profit_min=0.60) -> pd.DataFrame`（1/0/NaN）。
  - `chip_volume_price_divergence(close, high, low, concentration, turnover_fraction, *, window=20, peak_window=60) -> pd.DataFrame`（−1/+1/0/NaN）。

- [ ] **Step 1: 写失败测试**

Create `agent/tests/factors/test_chip_signals.py`:

```python
"""Chip signal hand vectors: hit, miss, mask and arm separation."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from src.factors.chip_signals import (
    chip_capital_resonance,
    chip_squeeze_buildup,
    chip_volume_price_divergence,
)

INDEX = pd.bdate_range("2024-01-02", periods=90)
COLUMNS = ["A.SH", "B.SH"]


def _frame(values) -> pd.DataFrame:
    array = np.asarray(values, dtype=float)
    if array.ndim == 1:
        array = np.repeat(array[:, None], len(COLUMNS), axis=1)
    return pd.DataFrame(array, index=INDEX[: len(array)], columns=COLUMNS)


def test_squeeze_fires_when_concentration_falls_with_price_at_cost() -> None:
    concentration = np.full(25, 0.2)
    concentration[21:] = 0.1
    out = chip_squeeze_buildup(
        _frame(concentration), _frame(np.full(25, 0.0)), _frame(np.full(25, 0.5))
    )
    assert np.isnan(out.iloc[:20].to_numpy()).all()
    assert out.iloc[20, 0] == 0.0
    assert (out.iloc[21:].to_numpy() == 1.0).all()


def test_squeeze_arms_are_independent() -> None:
    concentration = np.full(25, 0.2)
    concentration[21:] = 0.1
    assert (
        chip_squeeze_buildup(
            _frame(concentration), _frame(np.full(25, 0.2)), _frame(np.full(25, 0.5))
        ).iloc[21, 0]
        == 0.0
    )
    assert (
        chip_squeeze_buildup(
            _frame(concentration), _frame(np.full(25, 0.0)), _frame(np.full(25, 0.8))
        ).iloc[21, 0]
        == 0.0
    )
    rising = np.full(25, 0.2)
    rising[21:] = 0.3
    assert (
        chip_squeeze_buildup(
            _frame(rising), _frame(np.full(25, 0.0)), _frame(np.full(25, 0.5))
        ).iloc[21, 0]
        == 0.0
    )
    missing = np.full(26, 0.2)
    missing[5] = np.nan
    out = chip_squeeze_buildup(
        _frame(missing), _frame(np.full(26, 0.0)), _frame(np.full(26, 0.5))
    )
    assert np.isnan(out.iloc[5, 0])
    assert np.isnan(out.iloc[25, 0])


def test_resonance_requires_volume_profit_and_price_above_cost() -> None:
    turnover = np.full(25, 0.01)
    turnover[20:] = 0.03
    out = chip_capital_resonance(
        _frame(turnover), _frame(np.full(25, 0.7)), _frame(np.full(25, 0.01))
    )
    assert np.isnan(out.iloc[:20].to_numpy()).all()
    assert (out.iloc[20:].to_numpy() == 1.0).all()
    assert (
        chip_capital_resonance(
            _frame(turnover), _frame(np.full(25, 0.5)), _frame(np.full(25, 0.01))
        ).iloc[20, 0]
        == 0.0
    )
    assert (
        chip_capital_resonance(
            _frame(turnover), _frame(np.full(25, 0.7)), _frame(np.full(25, 0.0))
        ).iloc[20, 0]
        == 0.0
    )
    calm = np.full(25, 0.01)
    assert (
        chip_capital_resonance(
            _frame(calm), _frame(np.full(25, 0.7)), _frame(np.full(25, 0.01))
        ).iloc[24, 0]
        == 0.0
    )


def test_divergence_high_and_low_arms() -> None:
    n = 80
    close = np.full(n, 10.0)
    high = np.full(n, 10.0)
    low = np.full(n, 9.0)
    rising = 0.2 + 0.001 * np.arange(n)
    quiet = np.full(n, 0.02)
    quiet[60:] = 0.01
    out = chip_volume_price_divergence(
        _frame(close), _frame(high), _frame(low), _frame(rising), _frame(quiet)
    )
    assert np.isnan(out.iloc[:59].to_numpy()).all()
    assert (out.iloc[60:].to_numpy() == -1.0).all()

    falling = 0.4 - 0.001 * np.arange(n)
    loud = np.full(n, 0.02)
    loud[60:] = 0.03
    out_low = chip_volume_price_divergence(
        _frame(np.full(n, 9.0)),
        _frame(high),
        _frame(np.full(n, 9.0)),
        _frame(falling),
        _frame(loud),
    )
    assert (out_low.iloc[60:].to_numpy() == 1.0).all()


def test_divergence_arms_are_separated_by_turnover_on_a_flat_range() -> None:
    n = 80
    flat = np.full(n, 10.0)
    rising = 0.2 + 0.001 * np.arange(n)
    quiet = np.full(n, 0.02)
    quiet[60:] = 0.01
    out = chip_volume_price_divergence(
        _frame(flat), _frame(flat), _frame(flat), _frame(rising), _frame(quiet)
    )
    assert out.iloc[60, 0] == -1.0
    falling = 0.4 - 0.001 * np.arange(n)
    loud = np.full(n, 0.02)
    loud[60:] = 0.03
    out_low = chip_volume_price_divergence(
        _frame(flat), _frame(flat), _frame(flat), _frame(falling), _frame(loud)
    )
    assert out_low.iloc[60, 0] == 1.0


def test_divergence_is_nan_when_a_window_input_is_missing() -> None:
    n = 80
    concentration = np.full(n, 0.3)
    concentration[30] = np.nan
    turnover = np.full(n, 0.02)
    out = chip_volume_price_divergence(
        _frame(np.full(n, 10.0)),
        _frame(np.full(n, 10.0)),
        _frame(np.full(n, 9.0)),
        _frame(concentration),
        _frame(turnover),
    )
    assert np.isnan(out.iloc[30, 0])
    assert np.isnan(out.iloc[50, 0])


def test_signals_reject_misaligned_frames() -> None:
    with pytest.raises(ValueError, match="aligned"):
        chip_squeeze_buildup(_frame([0.2, 0.1]), _frame([0.0]), _frame([0.5, 0.5]))
```

Run: `python -m pytest agent/tests/factors/test_chip_signals.py -q`
Expected: collection error，`ModuleNotFoundError: No module named 'src.factors.chip_signals'`。

- [ ] **Step 2: 写信号实现**

Create `agent/src/factors/chip_signals.py`:

```python
"""Chip-based signals over the engine's wide output.

Every function is pure: wide frames in, one float wide frame out
(1.0 hit / 0.0 miss / NaN not evaluable; the divergence signal uses
-1.0 / +1.0 / 0.0 / NaN).
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def _require_aligned(reference: pd.DataFrame, **frames: pd.DataFrame) -> None:
    for name, frame in frames.items():
        if not isinstance(frame, pd.DataFrame):
            raise ValueError(
                f"{name} must be a pandas DataFrame, got {type(frame).__name__}"
            )
        if not frame.index.equals(reference.index) or not frame.columns.equals(
            reference.columns
        ):
            raise ValueError(f"{name} is not aligned with the reference frame")


def chip_squeeze_buildup(
    concentration: pd.DataFrame,
    cost_deviation: pd.DataFrame,
    profit_ratio: pd.DataFrame,
    *,
    window: int = 20,
    deviation_max: float = 0.05,
    profit_min: float = 0.30,
    profit_max: float = 0.70,
) -> pd.DataFrame:
    """1.0 while the cost range narrows around a price pinned to average cost."""
    _require_aligned(
        concentration, cost_deviation=cost_deviation, profit_ratio=profit_ratio
    )
    previous = concentration.shift(window)
    condition = (
        (concentration < previous)
        & (cost_deviation.abs() <= deviation_max)
        & (profit_ratio >= profit_min)
        & (profit_ratio <= profit_max)
    )
    valid = (
        concentration.notna()
        & previous.notna()
        & cost_deviation.notna()
        & profit_ratio.notna()
    )
    return condition.astype(float).where(valid)


def chip_capital_resonance(
    turnover_fraction: pd.DataFrame,
    profit_ratio: pd.DataFrame,
    cost_deviation: pd.DataFrame,
    *,
    window: int = 20,
    multiple: float = 2.0,
    profit_min: float = 0.60,
) -> pd.DataFrame:
    """1.0 when volume doubles its prior mean while most holders sit in profit."""
    _require_aligned(
        turnover_fraction, profit_ratio=profit_ratio, cost_deviation=cost_deviation
    )
    mean_previous = (
        turnover_fraction.rolling(window, min_periods=window).mean().shift(1)
    )
    condition = (
        (turnover_fraction >= multiple * mean_previous)
        & (profit_ratio >= profit_min)
        & (cost_deviation > 0.0)
    )
    valid = (
        turnover_fraction.notna()
        & mean_previous.notna()
        & profit_ratio.notna()
        & cost_deviation.notna()
    )
    return condition.astype(float).where(valid)


def chip_volume_price_divergence(
    close: pd.DataFrame,
    high: pd.DataFrame,
    low: pd.DataFrame,
    concentration: pd.DataFrame,
    turnover_fraction: pd.DataFrame,
    *,
    window: int = 20,
    peak_window: int = 60,
) -> pd.DataFrame:
    """-1.0 new high on shrinking volume with dispersing cost; +1.0 the mirror."""
    _require_aligned(
        close,
        high=high,
        low=low,
        concentration=concentration,
        turnover_fraction=turnover_fraction,
    )
    rolling_high = high.rolling(peak_window, min_periods=peak_window).max()
    rolling_low = low.rolling(peak_window, min_periods=peak_window).min()
    mean_previous = (
        turnover_fraction.rolling(window, min_periods=window).mean().shift(1)
    )
    previous_concentration = concentration.shift(window)
    high_divergence = (
        (close >= rolling_high)
        & (turnover_fraction < mean_previous)
        & (concentration > previous_concentration)
    )
    low_divergence = (
        (close <= rolling_low)
        & (turnover_fraction > mean_previous)
        & (concentration < previous_concentration)
    )
    verdict = np.where(high_divergence, -1.0, np.where(low_divergence, 1.0, 0.0))
    valid = (
        close.notna()
        & high.notna()
        & low.notna()
        & concentration.notna()
        & turnover_fraction.notna()
        & rolling_high.notna()
        & rolling_low.notna()
        & mean_previous.notna()
        & previous_concentration.notna()
    )
    return pd.DataFrame(verdict, index=close.index, columns=close.columns).where(valid)
```

- [ ] **Step 3: 跑测试确认 GREEN**

Run: `python -m pytest agent/tests/factors/test_chip_signals.py -q`
Expected: `7 passed`。

- [ ] **Step 4: 提交**

```bash
git add agent/src/factors/chip_signals.py agent/tests/factors/test_chip_signals.py
git commit -s -m "feat(factors): three chip signals over the engine output" -m "Squeeze (narrowing dispersion with price at cost), capital resonance (volume vs its prior mean plus profit share) and volume-price divergence (new high/low against turnover and dispersion). Each hit is 1/0/NaN, divergence is -1/+1/0/NaN, and every window input is part of the validity mask; the divergence arms are separated by opposite turnover comparisons and cannot both hold." -m "Signed-off-by: hjfire <307501063+hjfire@users.noreply.github.com>"
```

---

### Task 6: 数据接线（`val:turnover_rate`）

**Files:**
- Modify: `agent/backtest/loaders/valuation_loader.py:38`（元组）与文件头注
- Modify: `agent/tests/factors/test_fundamental_valuation_samples.py:335`（逐字元组断言）＋新增接受测试

**Interfaces:**
- Consumes: 无。
- Produces: `VALUATION_FIELDS == ("pe","pe_ttm","pb","ps_ttm","dv_ttm","turnover_rate")`；`load_valuation_panel(fields=["turnover_rate"], ...)` 请求 `daily_basic` 的同名列并按百分数原样返回；baostock 回退对它返回全 NaN 帧。

- [ ] **Step 1: 先改测试为 RED**

Modify `agent/tests/factors/test_fundamental_valuation_samples.py` 第 335 行：

```python
    assert VALUATION_FIELDS == ("pe", "pe_ttm", "pb", "ps_ttm", "dv_ttm")
```

改为：

```python
    assert VALUATION_FIELDS == (
        "pe",
        "pe_ttm",
        "pb",
        "ps_ttm",
        "dv_ttm",
        "turnover_rate",
    )
```

并在该测试函数后追加：

```python
def test_turnover_rate_is_a_supported_val_field() -> None:
    from backtest.loaders.valuation_loader import validate_valuation_fields

    assert validate_valuation_fields(["turnover_rate"]) == ["turnover_rate"]
```

Run: `python -m pytest agent/tests/factors/test_fundamental_valuation_samples.py -q -k "val_whitelist or turnover_rate"`
Expected: FAIL——旧元组不含 `turnover_rate`，`validate_valuation_fields` 抛 `ValueError`。

- [ ] **Step 2: 改 loader**

Modify `agent/backtest/loaders/valuation_loader.py`：

头注字段清单

```
(``pe``, ``pe_ttm``, ``pb``, ``ps_ttm``, ``dv_ttm``)
```

改为

```
(``pe``, ``pe_ttm``, ``pb``, ``ps_ttm``, ``dv_ttm``, ``turnover_rate``)
```

并改元组上方的注释

```python
#: ``daily_basic`` columns the ``val:`` namespace serves. ``dv_ttm`` is in
#: percent units (股息率TTM, %); consumers z-score it, which is scale-invariant.
VALUATION_FIELDS: tuple[str, ...] = ("pe", "pe_ttm", "pb", "ps_ttm", "dv_ttm")
```

为

```python
#: ``daily_basic`` columns the ``val:`` namespace serves. ``dv_ttm`` (股息率TTM)
#: and ``turnover_rate`` (换手率) are both in percent units; consumers either
#: z-score them (scale-invariant) or divide by 100 at the engine boundary.
VALUATION_FIELDS: tuple[str, ...] = (
    "pe",
    "pe_ttm",
    "pb",
    "ps_ttm",
    "dv_ttm",
    "turnover_rate",
)
```

- [ ] **Step 3: 跑测试确认 GREEN，并确认 baostock 断言不受影响**

Run: `python -m pytest agent/tests/factors/test_fundamental_valuation_samples.py agent/tests/factors/test_valuation_baostock_fallback.py -q`
Expected: 全部 passed（baostock 的 `{"pe_ttm","pb","ps_ttm"}` 精确断言不变）。

- [ ] **Step 4: 提交**

```bash
git add agent/backtest/loaders/valuation_loader.py agent/tests/factors/test_fundamental_valuation_samples.py
git commit -s -m "feat(valuation): serve daily_basic turnover_rate as val:turnover_rate" -m "The chip engine needs turnover in percent; daily_basic already returns it next to the valuation multiples. The exact whitelist assertion moves to the new tuple (a deliberate extension, not a subset relaxation); baostock has no counterpart and keeps returning all-NaN frames for it." -m "Signed-off-by: hjfire <307501063+hjfire@users.noreply.github.com>"
```

---

### Task 7: 全量扫描夹具、豁免集与中文词表

**Files:**
- Modify: `agent/tests/factors/test_missing_bar_fabrication.py`
- Modify: `wiki/alpha-library/i18n.zh.json`
- Test: `agent/tests/factors/test_alpha_library_translations.py`（不改，作为门）

**Interfaces:**
- Consumes: Task 4 的四个 id、Task 1 的引擎。
- Produces: 全量扫描对 chip alpha 不再 SkipAlpha/报错；价值 oracle 对四枚 chip alpha 明确 skip；i18n 八条译文与注册表原文逐字对应。

- [ ] **Step 1: 先跑现状确认 RED**

Run: `python -m pytest agent/tests/factors/test_missing_bar_fabrication.py -q -k "chip"`
Expected: ERROR——`chip_*` 因缺 `val:turnover_rate` 抛 `SkipAlpha`（未被该文件的 skip 分支覆盖）。

- [ ] **Step 2: 夹具末尾追加字段＋新增豁免集**

Modify `agent/tests/factors/test_missing_bar_fabrication.py`：

`_base()` 的末尾追加循环里，在 `"val:dv_ttm"` 之后（元组最后）追加一行：

```python
        "val:turnover_rate",
```

在 `SMOOTHERS` 列表之后追加：

```python
# Recursive state carriers outside the GTJA smoothers: the chip engine mixes
# yesterday's whole distribution into today's, so after a gap it continues from
# the state it saw (the #1463 policy). concentration_change_20 additionally
# re-reads the gap bar 20 rows later and is legitimately NaN there, which is why
# these alphas are exempt from the value oracle but are NOT added to SMOOTHERS.
CHIP_STATEFUL = {
    "chip_cost_deviation",
    "chip_profit_ratio",
    "chip_concentration",
    "chip_concentration_change_20",
}
```

价值 oracle 的 skip 行

```python
    if alpha_id in set(SMOOTHERS) | RESIDUE_ARTIFACTS | PARTIAL_WINDOWS | BENCHMARK_FROM_THE_PANEL:
        pytest.skip("classified above: smoother, residue artifact, partial window or panel benchmark")
```

改为

```python
    if alpha_id in set(SMOOTHERS) | CHIP_STATEFUL | RESIDUE_ARTIFACTS | PARTIAL_WINDOWS | BENCHMARK_FROM_THE_PANEL:
        pytest.skip(
            "classified above: smoother / state carrier / residue artifact / "
            "partial window / panel benchmark"
        )
```

存在性断言

```python
def test_the_value_oracle_exemptions_are_real_alphas() -> None:
    known = set(_all_alpha_ids())
    assert (RESIDUE_ARTIFACTS | PARTIAL_WINDOWS | BENCHMARK_FROM_THE_PANEL | set(SMOOTHERS)) <= known
```

改为

```python
def test_the_value_oracle_exemptions_are_real_alphas() -> None:
    known = set(_all_alpha_ids())
    exempt = (
        RESIDUE_ARTIFACTS
        | PARTIAL_WINDOWS
        | BENCHMARK_FROM_THE_PANEL
        | set(SMOOTHERS)
        | CHIP_STATEFUL
    )
    assert exempt <= known
```

并把模块 docstring 中「The recursive smoothers are held to a different rule...」一段末尾补一句：

```
The four chip alphas are state carriers of the same kind (the whole prior
distribution is the state); their concentration_change_20 additionally blanks
again 20 rows after the gap because its lookback reaches the gap bar.
```

- [ ] **Step 3: 跑夹具与豁免测试确认 GREEN**

Run: `python -m pytest agent/tests/factors/test_missing_bar_fabrication.py -q -k "chip or value_oracle_exemptions"`
Expected: chip 四条被 skip（不是 error），存在性断言 passed。

- [ ] **Step 4: 补 i18n 八条（先跑红）**

Run: `python -m pytest agent/tests/factors/test_alpha_library_translations.py -q`
Expected: FAIL——`untranslated: add them to i18n.zh.json`，列出四枚新 id。

把下面八条写进 `wiki/alpha-library/i18n.zh.json`（`notes` 与 `nicknames` 各四条；`en` 必须与 Task 4 的 `notes`/`nickname` **逐字一致**）。文件是 CRLF＋1 空格缩进；用下面的脚本追加，保持其余字节不变：

```bash
python - <<'PY'
import json
from pathlib import Path

path = Path("wiki/alpha-library/i18n.zh.json")
report = json.loads

raw = path.read_bytes()
text = raw.decode("utf-8")
data = json.loads(text)

notes = {
    "chip_cost_deviation": {
        "en": (
            "Daily triangular chip distribution on [low, high] with the mode at the "
            "typical price (high+low+close)/3, mixed by turnover into a "
            "turnover-weighted holding-cost distribution; this factor is the "
            "close's relative deviation from the mean chip cost. Self-implemented "
            "from public definitions; no third-party code copied and no cyq_* "
            "endpoint is called. Price levels are taken as the panel supplies them: "
            "on forward-adjusted panels the historical cost level scales with "
            "corporate actions."
        ),
        "zh": (
            "按日线 [low, high] 上的三角分布、众数取典型价 (high+low+close)/3，"
            "以换手率混合成换手加权的持仓成本分布；本因子为收盘价相对平均筹码成本的偏离，"
            "正值表示价格位于平均持仓成本之上。按公开定义自研，未搬第三方代码，"
            "也不调用 cyq_* 端点。使用面板给出的价格口径：前复权面板上的历史成本会随除权缩放。"
        ),
    },
    "chip_profit_ratio": {
        "en": (
            "Share of the modelled chip mass whose cost is at or below today's "
            "close, i.e. the estimated fraction of holders in profit. Daily "
            "triangular distributions are mixed by turnover; a missing bar leaves "
            "the state untouched. Self-implemented from public definitions; no "
            "third-party code copied and no cyq_* endpoint is called. A "
            "cent-aligned close is exact; an off-grid close is linearly "
            "interpolated inside its bin."
        ),
        "zh": (
            "模型筹码中成本不高于当日收盘价的质量占比，即获利盘比例的估计。"
            "每日三角分布按换手率混合，缺失 bar 保持状态不变。按公开定义自研，"
            "未搬第三方代码，也不调用 cyq_* 端点。整分收盘价精确；"
            "非整分收盘价在所在价格格内线性插值。"
        ),
    },
    "chip_concentration": {
        "en": (
            "Cost dispersion of the chip distribution: (q95 - q05) / (q95 + q05) "
            "of the modelled holding cost, with quantile prices taken at bin "
            "midpoints. Higher = a more dispersed cost basis (the public field is "
            "named concentration, but its direction is dispersion). "
            "Self-implemented from public definitions; no third-party code copied "
            "and no cyq_* endpoint is called."
        ),
        "zh": (
            "筹码成本离散度：(q95 − q05) / (q95 + q05)，分位价格取价格格中点。"
            "数值越大＝成本越分散（公开字段叫「集中度」，方向是离散度）。"
            "按公开定义自研，未搬第三方代码，也不调用 cyq_* 端点。"
        ),
    },
    "chip_concentration_change_20": {
        "en": (
            "20-trading-day change of the chip cost dispersion "
            "(concentration_t - concentration_{t-20}). Negative values mean the "
            "cost basis is converging. NaN until 20 rows of history exist and "
            "wherever either endpoint is NaN. Self-implemented from public "
            "definitions; no third-party code copied and no cyq_* endpoint is "
            "called."
        ),
        "zh": (
            "筹码成本离散度的 20 个交易日变化（concentration_t − concentration_{t−20}）。"
            "负值表示成本区间在收敛。历史不足 20 行或任一端为 NaN 时为 NaN。"
            "按公开定义自研，未搬第三方代码，也不调用 cyq_* 端点。"
        ),
    },
}

nicknames = {
    "chip_cost_deviation": {
        "en": "Chip cost deviation: close vs turnover-weighted average cost",
        "zh": "筹码成本偏离：收盘价相对换手加权平均成本",
    },
    "chip_profit_ratio": {
        "en": "Chip profit ratio: modelled share of holders in profit",
        "zh": "筹码获利比例：模型口径的获利盘占比",
    },
    "chip_concentration": {
        "en": "Chip concentration: (q95-q05)/(q95+q05) cost dispersion",
        "zh": "筹码集中度：(q95−q05)/(q95+q05) 成本离散度",
    },
    "chip_concentration_change_20": {
        "en": "Chip concentration change over 20 days",
        "zh": "筹码集中度 20 日变化",
    },
}

assert set(notes) == set(nicknames)
data["notes"].update(notes)
data["nicknames"].update(nicknames)
rendered = json.dumps(data, ensure_ascii=False, indent=1) + "\n"
path.write_bytes(rendered.replace("\n", "\r\n").encode("utf-8"))
print("entries", len(data["notes"]), len(data["nicknames"]))
PY
```

Run: `python -m pytest agent/tests/factors/test_alpha_library_translations.py -q`
Expected: `3 passed`。

- [ ] **Step 5: 提交**

```bash
git add agent/tests/factors/test_missing_bar_fabrication.py wiki/alpha-library/i18n.zh.json
git commit -s -m "test(factors): wire chip alphas into the missing-bar sweep and zh glossary" -m "The sweep's base panel gains val:turnover_rate so the new alphas are exercised instead of SkipAlpha; the state-carrier exemption set is explicit and its members are asserted to exist. The zh glossary gains four notes and four nicknames with en strings copied verbatim from the registry." -m "Signed-off-by: hjfire <307501063+hjfire@users.noreply.github.com>"
```

---

### Task 8: 门禁、档案、推送与 CI 复读

**Files:**
- Modify: `项目档案.md`（追加 §7.33，bytes 层追加）

**Interfaces:**
- Consumes: 全部前序任务。
- Produces: 合入 main 并推送的盖章提交；CI 复读读数；档案 §7.33。

- [ ] **Step 1: 跑门禁前先记同树基线并逐条复跑**

```bash
python -m pytest agent/tests/factors -q 2>&1 | tail -3
python -m pytest agent/tests -q --ignore=agent/tests/e2e_backtest --ignore=agent/tests/test_e2e_harness_v2.py 2>&1 | tail -3
bash tools/ci_grep_gates.sh; echo "grep-gates rc=$?"
python -m pytest tools/test_ci_env_var_gate.py tools/test_ci_private_files_gate.py tools/test_doc_tables.py -q 2>&1 | tail -3
python -m pytest tools/test_wiki_drift.py -q 2>&1 | tail -3
bash tools/wiki_freshness_gate.sh; echo "watermark rc=$?"
```

所有命令的读数原样记录到档案（本片新增红必须为 0；恒红门若红，先证明本片 0 贡献：对同一棵树在改动前的基线读数与改动后逐条对照）。

- [ ] **Step 2: 后端等价「未来函数自查」五步（写进报告）**

1. `test_prefix_equals_full_history` 绿（前 80 行 vs 全长，atol=1e-12）。
2. `test_future_bars_do_not_change_past_values` 绿（第 60 行起污染，前 60 行不变）。
3. 手算向量 D：`change_20` 在 t−20 不存在时为 NaN，存在时为 0。
4. 自适应 step 只看当日振幅（向量 E；跨日无耦合构造）。
5. 变异 M2（换手率前移一日）真红——证明测试能看见「用了邻近 bar」这类泄漏。

- [ ] **Step 3: 追加档案 §7.33**

先确认档案当前末节号与 EOL：

```bash
grep -n "^## §7\." 项目档案.md | tail -3
python - <<'PY'
from pathlib import Path
raw = Path("项目档案.md").read_bytes()
print("crlf", raw.count(b"\r\n"), "lf", raw.count(b"\n"), "tail", raw[-80:])
PY
```

用 bytes 层追加（EOL 与档案现有口径一致；先写出内容到变量再 `write_bytes(raw + block)`，不改动任何既有字节）：

```bash
python - <<'PY'
from pathlib import Path

path = Path("项目档案.md")
raw = path.read_bytes()
eol = b"\r\n" if raw.count(b"\r\n") else b"\n"
section = """### 7.33 G1 筹码因子与三类信号（2026-10-28；控制席本人 inline，未派实现席）

- **引擎 `agent/src/factors/chips.py`**：每日三角分布＋换手率递归混合＋绝对整数分价格格；`avg_cost` 走解析混合式（不经分格中点），缺失 bar 状态原样保留。
- **四枚 zoo alpha（新 zoo `chip`）**：`chip_cost_deviation`、`chip_profit_ratio`、`chip_concentration`、`chip_concentration_change_20`；只吃 `high/low/close/val:turnover_rate`，universe 仅 `equity_cn`。
- **三类信号 `agent/src/factors/chip_signals.py`**：蓄势、资金共振、量价背离（−1/+1/0/NaN）。
- **数值读数（测试现值）**：手算向量 A–E 全绿；独立连续 oracle 在 60 日整分面板上 `mass ≤ 6.7e-16`、`avg_cost ≤ 8.9e-15`、`profit_ratio ≤ 5.3e-15`、`concentration ≤ 4.7e-4`；前缀==全量与未来污染两针差异 0.0；变异 M1–M5 各自真红。
- **接线三处（第四处作废）**：`VALUATION_FIELDS` 追加 `turnover_rate`（百分数；baostock 回退仍是全 NaN 帧）；纯度门仓内白名单加入 `src.factors.chips`（纯计算模块，禁用名与模块体规则未动）；缺 bar 全量扫描的夹具末尾追加 `val:turnover_rate` 并新增显式状态载体豁免集。中文词表那一步因 `wiki/**` 属上游所有被撤销（`i18n.zh.json` 恢复上游字节，alpha 的 `notes`/`nickname` 留空、出处与方向移入 zoo docstring，修复提交 `d7cd3498`）。
- **许可**：只按公开定义自研，一行第三方代码未搬，不调用 cyq_* 端点；对外 Issue 未发。
- **门册与 CI 读数**：<此处由执行时逐条填写，不预写数字>。

"""
block = eol + section.replace("\n", "\r\n" if eol == b"\r\n" else "\n").encode("utf-8")
path.write_bytes(raw.rstrip(b"\r\n") + block)
print("appended", len(block), "bytes")
PY
```

执行完把 Step 1 的真实读数替换占位行（用 Edit 精确替换那一行，行数守恒），然后复跑读档门：

```bash
python -m pytest tools/test_wiki_drift.py -q 2>&1 | tail -3
bash tools/wiki_freshness_gate.sh; echo "watermark rc=$?"
```

- [ ] **Step 4: 盖章提交、合入 main、推送**

```bash
git add 项目档案.md superpowers/specs/2026-10-28-g1-chip-factors-design.md superpowers/plans/2026-10-28-g1-chip-factors.md
git commit -s -m "docs(archive): §7.33 落 G1——筹码引擎、四枚 alpha 与三类信号" -m "手算向量 A-E、独立 oracle、前缀与污染两针、五条变异各自真红；接线三处（val 白名单、纯度门、缺 bar 夹具），第四处中文词表因 wiki/** 属上游所有被撤销并记录在案；门册读数按执行当趟填写。" -m "Signed-off-by: hjfire <307501063+hjfire@users.noreply.github.com>"
git ls-remote origin refs/heads/main
git log --oneline -3
```

推送（长期授权覆盖收尾的合入与推送；若远程 main 已被 cron 推进，改道 `git merge origin/main` 后重跑门禁，不 rebase）：

```bash
git push origin main
```

- [ ] **Step 5: CI 复读**

```bash
curl -s -H "Accept: application/vnd.github+json" "https://api.github.com/repos/hjfire/vibe-trading-fw/actions/runs?head_sha=$(git rev-parse HEAD)&per_page=5" | python -c "import json,sys; d=json.load(sys.stdin); [print(r['id'], r['name'], r['status'], r['conclusion']) for r in d.get('workflow_runs', [])]"
```

等全部腿完成后再复读一次；报告 run id 与绿/红，不写「全绿」除非每条腿 conclusion 都是 success。

---

## Self-Review（写完计划后的自查）

- **Spec coverage:** 模型（§3）→ Task 1；信号（§4）→ Task 5；数据接线（§5）＋代连改动（§5.1）→ Task 6/7；验收九条（§6）→ Task 1/2/3/4/7/8；风险与限制（§7）→ notes/档案；后端等价自查（§8）→ Task 8 Step 2。无缺口。
- **Placeholder scan:** 唯一占位是档案 §7.33 的门册读数行，计划已写明「执行时填写、不预写数字」，不是漏写。
- **Type consistency:** `chip_metrics` 返回键 `METRICS`；四枚 alpha 各自取 `cost_deviation`/`profit_ratio`/`concentration`/`concentration_change_20`，与注册表测试的映射表一致；`turnover_fraction = turnover_rate / 100` 只在信号面出现，不与引擎的百分数入口混用。

---

## 执行期偏差（2026-10-28，首轮执行后追加）

1. **任务 7 的中文词表一步作废**：`wiki/**` 属上游所有，
   `tools/test_wiki_drift.py::test_no_fork_commit_touches_an_upstream_owned_file`
   在本片首跑即红（offender＝`wiki/alpha-library/i18n.zh.json`）。改为：四枚
   alpha 的 `notes`/`nickname` 留空，出处与方向说明移入 zoo docstring，
   `i18n.zh.json` 恢复上游字节。修复提交 `d7cd3498`；详见 spec §9。
2. **Task 2 的测试数**：计划写 `13 passed`，实测 7（手算向量与隔离）＋5
   （oracle／前缀／污染／非法 bar／跨度上限）＝**12**。
3. **Task 5 的标量夹具**：`_frame(x)` 无法接收标量（0 维数组触发
   `TypeError: len() of unsized object`），执行时逐处改为
   `_frame(np.full(N, x))`，`N` 按该用例的行数（25 或 26）。
4. **档案节标题**：仓内既有格式是 `### 7.32 …`＋`- **…**：` 项目符号，
   不是计划草稿里的 `## §7.33`；落档时按仓库实际格式写。
