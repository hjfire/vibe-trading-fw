# G8（tier 3）实现计划：换手成本与净收益

日期：2026-10-29
坐标：spec＝`superpowers/specs/2026-10-29-g8-turnover-cost-design.md`
路线图：`superpowers/plans/2026-10-29-tier3-signal-to-execution-roadmap.md`
基线：main `d86b806c`（G7 收口、CI 九腿全绿之后）

## Global Constraints

- 纯函数：无 I/O、无时钟、无环境变量、无全局状态；输入表不得被修改。
- 只依赖 numpy/pandas；不新增第三方依赖，不 import `impact.py`（调用方
  逐笔算好填 `impact` 表）。
- 第 t 行只用 ≤t 的信息；`weights.shift(lag)` 只许向未来。
- 不注册进 `quantlib_tool.ALLOWED_MODULES`。
- 提交一律 `git commit -s` ＋显式 pathspec；推送前 `git ls-remote`。
- 恒红门先证「本片 0 贡献」，不调阈值、不修门、不清白名单。

---

## Task 1: RED — 写测试面

文件：`agent/tests/quantlib/test_turnover.py`

覆盖（期望值一律写字面量或分数，全部已由仓库外原型真跑核对）：

1. **A** `cost_bps=10`、4 行权重 → `turnover=[0.5,0.1,0,0.3]`、
   `cost=[0.0005,0.0001,0,0.0003]`、`cum=[0.0005,0.0006,0.0006,0.0009]`；
   列序 `["turnover","cost","cumulative_cost"]`。
2. **A2** 权重不变行 `turnover=cost=0`、累计成本不增（成本只扣一次）。
3. **B** `initial_weights` 按标签对齐（Series 索引故意乱序）→
   `turnover=[0,0.2]`、`cost=[0,0.0002]`。
4. **C1** 仅 `impact`（`cost_bps=0`）→ `cost=[0.0005,0.0006]`。
5. **C2** `impact`＋`cost_bps=10` → `cost=[0.001,0.0008]`。
6. **D1** `lag=1` → `gross=[0,0.01,0.016]`、
   `net=[-0.0005,0.0097,0.016]`。
7. **D2** `lag=0` → `gross=[0.015,-0.002,0.016]`、
   `net=[0.0145,-0.0023,0.016]`。
8. **D3** `lag=3`（2 行面板）→ `gross` 全 0。
9. **E** 归因：0.026／0.0008／0.0252／`2/65`／325.0。
10. **F** 零换手：`cost=0`、`cost_ratio=0`、`breakeven_bps` 为 NaN。
11. **G1** 持有资产缺收益 → 当日 `gross` 为 NaN；**G2** 零权重资产
    NaN 不污染。
12. **H** 带冲击的恒等式 `net == gross - cost`（±1e-12）。
13. **I** 空头 `[0.5,-0.5]→[0.2,-0.2]` → `turnover=[0.5,0.3]`、
    `cost=[0.0005,0.0003]`。
14. **J1** 改权重最后一行，前面各行 `gross/net` 逐位不变；
    **J2** 改收益最后一行同理；**J3** `lag=0` 时只影响最后一行。
15. **K** 负毛收益：`breakeven_bps` 为负、`cost_ratio` 保持负号。
16. **输出面**：index 与输入逐位相等、`AttributionSummary` 是
    frozen dataclass、字段名齐五枚。
17. **确定性/纯度**：同输入两跑逐位相等；输入三表前后 `.equals`；
    模块源码不含 `import os`、`import time`、`open(`、`os.environ`、
    `random`。
18. **错误契约**（spec §3.6 逐行）：`trade_cost` 12 组、`net_returns`
    7 组、`attribution_summary` 3 组。

测试骨架（关键断言）：

```python
import math

import numpy as np
import pandas as pd
import pytest

from src.quantlib.turnover import (
    AttributionSummary,
    attribution_summary,
    net_returns,
    trade_cost,
)

DATES = pd.date_range("2024-01-02", periods=4, freq="D")
COLS = ["A", "B"]

def frame(values, dates=None, columns=None):
    dates = DATES[: len(values)] if dates is None else dates
    columns = COLS if columns is None else columns
    return pd.DataFrame(values, index=dates, columns=columns)

def test_vector_a_turnover_cost_and_cumulative():
    w = frame([[0.6, 0.4], [0.5, 0.5], [0.5, 0.5], [0.2, 0.8]])
    out = trade_cost(w, cost_bps=10.0)
    assert list(out.columns) == ["turnover", "cost", "cumulative_cost"]
    assert out.index.equals(w.index)
    np.testing.assert_allclose(out["turnover"], [0.5, 0.1, 0.0, 0.3], atol=1e-15)
    np.testing.assert_allclose(out["cost"], [0.0005, 0.0001, 0.0, 0.0003], atol=1e-15)
    np.testing.assert_allclose(
        out["cumulative_cost"], [0.0005, 0.0006, 0.0006, 0.0009], atol=1e-15
    )

def test_vector_e_attribution_summary():
    w = frame([[0.5, 0.5], [0.2, 0.8], [0.2, 0.8]])
    r = frame([[0.01, 0.02], [0.03, -0.01], [0.0, 0.02]])
    net = net_returns(w, r, trade_cost(w, cost_bps=10.0), lag=1)
    summary = attribution_summary(net)
    assert isinstance(summary, AttributionSummary)
    assert summary.total_gross == pytest.approx(0.026, abs=1e-15)
    assert summary.total_cost == pytest.approx(0.0008, abs=1e-15)
    assert summary.total_net == pytest.approx(0.0252, abs=1e-15)
    assert summary.cost_ratio == pytest.approx(2 / 65, rel=1e-12)
    assert summary.breakeven_bps == pytest.approx(325.0, abs=1e-9)
```

运行：

```bash
cd agent && python -m pytest tests/quantlib/test_turnover.py -q
```

期望：收集期 `ModuleNotFoundError: No module named 'src.quantlib.turnover'`。

---

## Task 2: GREEN — 写实现

文件：`agent/src/quantlib/turnover.py`

公开面：

```python
__all__ = ["AttributionSummary", "attribution_summary", "net_returns", "trade_cost"]

_BPS_PER_UNIT = 10_000.0

@dataclass(frozen=True)
class AttributionSummary:
    total_gross: float
    total_cost: float
    total_net: float
    cost_ratio: float
    breakeven_bps: float
```

核心片段（逐字采用）：

```python
def _validate_weights(weights):
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
    if not all(isinstance(c, str) and c for c in weights.columns):
        raise ValueError("weights.columns must be non-empty strings")
    try:
        values = weights.to_numpy(dtype=float)
    except (TypeError, ValueError) as error:
        raise ValueError("weights must be finite numeric") from error
    if not np.isfinite(values).all():
        raise ValueError("weights must be finite numeric")
    return values


def _validate_impact(impact, weights):
    if not isinstance(impact, pd.DataFrame):
        raise TypeError("impact must be a pandas DataFrame")
    if not impact.index.equals(weights.index) or not impact.columns.equals(weights.columns):
        raise ValueError("impact must share weights' index and columns")
    try:
        values = impact.to_numpy(dtype=float)
    except (TypeError, ValueError) as error:
        raise ValueError("impact must be finite non-negative numeric") from error
    if not np.isfinite(values).all() or np.any(values < 0.0):
        raise ValueError("impact must be finite non-negative numeric")
    return values


def _initial_vector(initial_weights, weights):
    if initial_weights is None:
        return np.zeros(weights.shape[1], dtype=float)
    if not isinstance(initial_weights, pd.Series):
        raise TypeError("initial_weights must be a pandas Series")
    if not initial_weights.index.is_unique or set(initial_weights.index) != set(weights.columns):
        raise ValueError("initial_weights must share weights' columns")
    try:
        values = initial_weights.reindex(weights.columns).to_numpy(dtype=float)
    except (TypeError, ValueError) as error:
        raise ValueError("initial_weights must be finite numeric") from error
    if not np.isfinite(values).all():
        raise ValueError("initial_weights must be finite numeric")
    return values


def _cost_rate(cost_bps):
    if isinstance(cost_bps, bool) or not isinstance(cost_bps, Real):
        raise TypeError(f"cost_bps must be a real number, got {type(cost_bps).__name__}")
    rate = float(cost_bps)
    if not np.isfinite(rate) or rate < 0.0:
        raise ValueError(f"cost_bps must be finite and non-negative, got {cost_bps!r}")
    return rate / _BPS_PER_UNIT
```

`trade_cost` 主体：

```python
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

    frame = pd.DataFrame(rows, index=weights.index, columns=["turnover", "cost"])
    frame["cumulative_cost"] = frame["cost"].cumsum()
    return frame
```

`net_returns` 主体：

```python
    _validate_weights(weights)
    if not isinstance(asset_returns, pd.DataFrame):
        raise TypeError("asset_returns must be a pandas DataFrame")
    if not asset_returns.index.equals(weights.index) or not asset_returns.columns.equals(weights.columns):
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

    frame = pd.DataFrame(
        {
            "gross_return": gross,
            "cost": costs["cost"].to_numpy(dtype=float),
            "turnover": costs["turnover"].to_numpy(dtype=float),
        },
        index=weights.index,
    )
    frame["net_return"] = frame["gross_return"] - frame["cost"]
    return frame
```

`attribution_summary` 主体：

```python
    if not isinstance(net, pd.DataFrame):
        raise TypeError("net must be a pandas DataFrame")
    required = ("gross_return", "cost", "turnover", "net_return")
    if len(net.index) == 0 or any(name not in net.columns for name in required):
        raise ValueError("net must be non-empty and contain gross_return, cost, turnover, net_return")
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
        total_gross / total_turnover * _BPS_PER_UNIT if total_turnover > 0.0 else float("nan")
    )
    return AttributionSummary(total_gross, total_cost, total_net, cost_ratio, breakeven)
```

运行同一命令，期望全绿（枚数现数）。

---

## Task 3: 变异自证 M1–M6

先确认基线全绿并记录模块 sha256。每条：内存保留原始 bytes → 字节级
替换 → 跑目标套件 → 必须真红 → 从内存副本写回 → 复校 sha256 与
`git diff` 为空。禁止用 `git checkout --` 还原。

| 针 | 字节级注入 | 期望红针 |
| --- | --- | --- |
| M1 | `turnover = 0.5 * float(delta.sum())` 去掉 `0.5 *` | A／B／C／I |
| M2 | `cost = 0.5 * float(...)` 去掉 `0.5 *`（两条分支各一） | A／C／D／E |
| M3 | `previous = _initial_vector(...)` 改为 `np.zeros(...)` | B／F |
| M4 | `weights.shift(lag)` 改为 `weights.shift(-lag)` | D／E／J |
| M5 | 删去 `.fillna(0.0)` | D／E／F |
| M6 | `np.where(effective == 0.0, 0.0, ...)` 改为直接乘 | G |

每条记录实际红针名；比预期宽不算问题，比预期窄要写清原因。若某针
不红，先算可达域并补针，不得把「没红」记成「已证」。

---

## Task 4: 门禁、徽章、档案 §7.38、提交与推送

```bash
cd agent && python -m pytest tests/quantlib -q 2>&1 | tail -3
cd .. && bash tools/ci_grep_gates.sh; echo "grep-gates rc=$?"
python -m pytest tools/test_ci_env_var_gate.py tools/test_ci_private_files_gate.py tools/test_doc_tables.py -q 2>&1 | tail -3
python -m pytest tools/test_wiki_drift.py -q 2>&1 | tail -3
bash tools/wiki_freshness_gate.sh; echo "watermark rc=$?"
```

后端全量（与 G7 同一命令行）：

```bash
PYTHONDONTWRITEBYTECODE=1 python -B -X utf8 -m pytest agent/tests -q --tb=no -rf \
  --continue-on-collection-errors --ignore=agent/tests/e2e_backtest \
  --ignore=agent/tests/test_e2e_harness_v2.py -p no:cacheprovider
```

取 FAILED 名集合与 G7 基线（`86 failed, 21966 passed, 205 skipped,
9 errors`，85 名既有＋1 名已登记 Windows 时序 flake）做差，新增红必须 0。
前端三门免跑（本片零 `frontend/**`）。

七份 README 徽章：`322` → `326`、`27` → `28`（只改 Quant Library
徽章行）。

档案 `${...}/项目档案.md` 追加 `### 7.38 G8…`（bytes 层、CRLF），
读数现填；改完复跑读档门。

提交（显式 pathspec）：

```bash
git add agent/src/quantlib/turnover.py agent/tests/quantlib/test_turnover.py \
  README.md README_zh.md README_ja.md README_ko.md README_ar.md README_es.md README_id.md \
  项目档案.md superpowers/specs/2026-10-29-g8-turnover-cost-design.md \
  superpowers/plans/2026-10-29-g8-turnover-cost.md
git commit -s -m "feat(quantlib): turnover cost and net-return accounting" \
  -m "<why>"
```

推送前 `git ls-remote origin refs/heads/main` 对真值；cron 推进则改道
merge（不 rebase），合后复跑门 A 与档案读档门。推送后复读 CI 九腿与
逐腿注解，读数回填本文件的「执行期偏差」。

## 执行期偏差（执行时回填）

- 2026-10-29 变异实读（基线 `39 passed`，模块 sha256 注入前后同为
  `a1498d31…ecee0`，CR=0／LF=371）：M1 **10 红**（A／B／C1／C2／D1／
  D2／D3／E／I／K）；M2a **8 红**（A／B／D1／D2／D3／E／I／K）；
  M2b **2 红**（C1／C2）；M3 **4 红**（B／initial 对齐／F／initial 错误
  契约）；M4 **7 红**（D1／E／F／G1／G2／G3／J1）；M5 **6 红**（D1／D3／
  E／F／G1／G2）；M6 **2 红**（G1／G2）。
- 首轮变异（38 例基线）之后补了一枚 spec §3.4 的判别针 `G3`
  （`sum(skipna=False)`：持有资产缺收益时五个总量该为 NaN，默认
  `skipna=True` 会给出 0.0／0.0／0.0／NaN／0.0），基线 38→39；M4 的
  红针相应多一枚 G3。两轮读数都记过，上表以 39 例这轮为准。
- M2 按计划「两条分支各一」拆成 M2a（统一费率分支翻倍）与 M2b（冲击
  分支去 `0.5`）。M2a 在 C1／C2 上不红是可达域所致：C 的 `cost_bps=0`
  使统一分支 `turnover*0` 恒 0，翻倍仍是 0；两针并集覆盖计划预期的
  A／C／D／E。
- M3 比预期宽：忽略 `initial_weights` 同时绕过 `_initial_vector` 的
  校验，故「标签对齐」与「initial 错误契约」两针也红。
- M4 比预期窄：D2／D3／J2／J3 不红且各有原因——`lag=0` 时
  `shift(-0)==shift(0)`；`shift(-3)` 在 2 行面板同样全 NaN；收益扰动
  与权重位移方向无关；J3 走 `lag=0`。实际红针已覆盖「权重只向未来
  生效」这一承诺（D1／E／J1）。
- M1／M2a／M5 比预期宽：成本翻倍或前导 NaN 波及所有含成本断言的向量，
  属预期内的连锁红。
- 2026-10-29 门册现读（同一棵树）：A `1582 passed, 64 skipped`（＋39
  恰为本片测试数）；B `87 failed, 22002 passed, 206 skipped, 31 warnings,
  9 errors in 955.45s`；FAILED 名集合对 G7 基线（同机现存 g7 日志 86
  名）逐名差集＝新增 1、消失 0，新增者为
  `test_rate_limiter_memory.py::test_empty_buckets_are_evicted_after_window_expires`
  （`window_seconds=0.05`＋`sleep(0.06)` 的墙钟 flake：文件自 `d86b806c`
  零改动、同树单跑三次全绿）；全量枚数增量 38 比本片 39 少 1，差额落在
  动态参数化／跳过计数摆动，不在 FAILED 名集合内。C rc=1 只红 `[gate b]`，
  35 枚命中文件全部未跟踪（tracked=0），本片文件商标零命中；D
  `1 failed, 51 passed`（Windows 换行文件名既知红）；E `240 passed`；
  F `447 (threshold 439)` rc=1（与 §7.32～§7.37 同读数）；前端零改动。
- 2026-10-29 推送与 CI 复读：推送前 `git ls-remote origin refs/heads/main`
  ＝`d86b806c`，本地 `3c195bdd` 为其直接后继，快进推送成功
  （`d86b806c..3c195bdd`）。匿名 check-runs 复读：九腿全部 `success`
  （Hash lock ×3、Windows 生命周期 ×3、frontend、test/3.11、test/3.14），
  「name the failing tests」条件腿 `skipped`。逐腿注解：四腿各 1 枚
  `notice`（ubuntu-latest 将于 2026-10-19 迁移 Ubuntu 26 ×3、macOS ARM64
  排队时长 ×1），零代码相关注解。

