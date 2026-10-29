# G9（tier 3）实现计划：参与率上限下的执行排程

日期：2026-10-29
坐标：spec＝`superpowers/specs/2026-10-29-g9-execution-scheduling-design.md`
路线图：`superpowers/plans/2026-10-29-tier3-signal-to-execution-roadmap.md`
基线：main `3c195bdd`（G8 收口并推送之后）

## Global Constraints

- 纯函数：无 I/O、无时钟、无环境变量、无全局状态；输入四件不得被修改。
- 只依赖 numpy/pandas；不新增第三方依赖，不 import `impact.py`／G7／G8。
- 按名独立切片；不随机、不依赖输入 Series 的排列顺序。
- 不注册进 `quantlib_tool.ALLOWED_MODULES`。
- 提交一律 `git commit -s` ＋显式 pathspec；推送前 `git ls-remote`。
- 恒红门先证「本片 0 贡献」，不调阈值、不修门、不清白名单。

---

## Task 1: RED — 写测试面

文件：`agent/tests/quantlib/test_execution.py`

覆盖（期望值一律写字面量；所有向量已按 spec §3.2 手算并为整数或精确二进制小数）：

1. **A** 基本切片（三资产）：`trades` 三行
   `[[400,-200,-50],[400,-200,0],[100,0,0]]`；
   `residual/unfilled/lot_residual` 全 0；`days_used=[3,2,1]`。
2. **B** 期限触顶：`max_days=2`、`delta=1000`、`cap=300` →
   `trades=[[300],[300]]`、`residual=[400]`、`unfilled=[400]`、
   `days_used=[2]`。
3. **C** 末日部分成交：`delta=750`、`cap=300` → `[300,300,150]`、
   `residual=0`、`days_used=[3]`。
4. **D** 整手与不足一手：`delta=950`、`cap=400`、`lot=100` →
   `[400,400,100]`、`residual=[50]`、`unfilled=[0]`、
   `lot_residual=[50]`、`days_used=[3]`。
5. **E** 整手 + 期限触顶：同 D、`max_days=2` → `residual=[150]`、
   `unfilled=[100]`、`lot_residual=[50]`、`days_used=[2]`。
6. **F** 差额不足一手：`delta=30`、`lot=100` → `H=0`、`residual=[30]`、
   `unfilled=[0]`、`lot_residual=[30]`、`days_used=[0]`。
7. **G** `adv=0`：`delta=250` → `H=0`、`residual=[250]`、
   `unfilled=[250]`、`lot_residual=[0]`、`days_used=[0]`。
8. **H** 空头回补：`target=-500`、`current=200`、`cap=300` →
   `[[-300],[-300],[-100]]`、`residual=0`、`days_used=[3]`。
9. **I** 逐名整手（Series）：A `450/cap400/lot100`、B `-400/cap300/lot200`
   → `trades=[[400,-200],[0,-200]]`、`residual=[50,0]`、
   `lot_residual=[50,0]`、`unfilled=[0,0]`、`days_used=[1,2]`。
10. **J** 标签对齐：三个 Series 用故意乱序的 index，输出与规范序逐位相等，
    columns 为 `["A","B"]`（或 `["A","B","C"]`）。
11. **K** 不变量总检（以 A 为例）：逐日逐名 `|trade| ≤ cap`（±1e-12）；
    方向与 `delta` 同号或 0；`Σ trades + residual == delta`（±1e-12）；
    `unfilled + lot_residual == residual`；每行至少一个非零；
    `days_used == (trades != 0).sum()`；`H == max(days_used)`。
12. **L** 无需调仓：`target == current` → 0 行、四个 Series 全 0、
    `days_used` 全 0；columns 仍为标签。
13. **M1** 确定性：同输入两跑 `trades.equals` 与四个 Series `.equals`；
    **M2** 纯度：四件输入前后 `.equals` 不变；源码不含 `import os`、
    `import time`、`open(`、`random`、`datetime`。
14. **输出面**：`ExecutionPlan` 是 frozen dataclass（`dataclasses.fields`）；
    `trades.index` 为 `RangeIndex(1, H+1)`；四个 Series 的 index 为字典序；
    `days_used.dtype` 为整数；`trades` 列序为字典序。
15. **错误契约**（spec §3.5 逐行）：
    - `target`／`current` 9 组：非 Series（2）、空 index、重复 index、
      非字符串标签、空串标签、非数值、非有限、标签集合不等；
    - `adv` 6 组：非 Series、标签不等、重复标签、非数值、非有限、负值；
    - `max_participation` 3 组：字符串（TypeError）、`bool`（TypeError）、
      `0`／`-0.1`／`1.5`／`nan`（ValueError）；
    - `max_days` 3 组：`2.0`（TypeError）、`True`（TypeError）、
      `0`／`-1`（ValueError）；
    - `lot_size` 7 组：字符串（TypeError）、`True`（TypeError）、
      `0`／`-5`（ValueError）、Series 标签不等（ValueError）、
      Series 值 `100.5`（TypeError）、Series 值 `0`（ValueError）。

测试骨架（关键断言，逐字采用）：

```python
import dataclasses
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from src.quantlib.execution import ExecutionPlan, schedule_trades

LABELS = ["A", "B", "C"]

def snap(**values):
    return pd.Series(values, dtype=float)

def base_plan(**overrides):
    kwargs = dict(
        target=snap(A=1000.0, B=-400.0, C=0.0),
        current=snap(A=100.0, B=0.0, C=50.0),
        adv=snap(A=4000.0, B=2000.0, C=1000.0),
    )
    kwargs.update(overrides)
    return schedule_trades(**kwargs)

def test_vector_a_basic_schedule():
    plan = base_plan()
    assert plan.trades.index.equals(pd.RangeIndex(1, 4))
    assert list(plan.trades.columns) == LABELS
    np.testing.assert_allclose(
        plan.trades.to_numpy(),
        [[400.0, -200.0, -50.0], [400.0, -200.0, 0.0], [100.0, 0.0, 0.0]],
        atol=1e-12,
    )
    np.testing.assert_allclose(plan.residual.to_numpy(), [0.0, 0.0, 0.0], atol=1e-12)
    np.testing.assert_allclose(plan.unfilled.to_numpy(), [0.0, 0.0, 0.0], atol=1e-12)
    np.testing.assert_allclose(plan.lot_residual.to_numpy(), [0.0, 0.0, 0.0], atol=1e-12)
    assert plan.days_used.to_dict() == {"A": 3, "B": 2, "C": 1}

def test_vector_d_lot_rounding_and_sub_lot_residual():
    plan = schedule_trades(
        target=snap(A=950.0), current=snap(A=0.0), adv=snap(A=4000.0), lot_size=100
    )
    np.testing.assert_allclose(plan.trades["A"].to_numpy(), [400.0, 400.0, 100.0])
    assert plan.residual["A"] == pytest.approx(50.0, abs=1e-12)
    assert plan.unfilled["A"] == pytest.approx(0.0, abs=1e-12)
    assert plan.lot_residual["A"] == pytest.approx(50.0, abs=1e-12)
    assert plan.days_used["A"] == 3

def test_plan_is_frozen_dataclass_with_five_fields():
    assert dataclasses.is_dataclass(ExecutionPlan)
    assert [field.name for field in dataclasses.fields(ExecutionPlan)] == [
        "trades", "residual", "unfilled", "lot_residual", "days_used"
    ]
```

运行：

```bash
cd agent && python -m pytest tests/quantlib/test_execution.py -q
```

期望：收集期 `ModuleNotFoundError: No module named 'src.quantlib.execution'`。

---

## Task 2: GREEN — 写实现

文件：`agent/src/quantlib/execution.py`

公开面：

```python
__all__ = ["ExecutionPlan", "schedule_trades"]

@dataclass(frozen=True)
class ExecutionPlan:
    trades: pd.DataFrame
    residual: pd.Series
    unfilled: pd.Series
    lot_residual: pd.Series
    days_used: pd.Series
```

校验与主体（逐字采用）：

```python
def _validate_snapshot(series, name):
    if not isinstance(series, pd.Series):
        raise TypeError(f"{name} must be a pandas Series")
    if len(series.index) == 0:
        raise ValueError(f"{name} cannot be empty")
    if not series.index.is_unique:
        raise ValueError(f"{name}.index must be unique")
    if not all(isinstance(label, str) and label for label in series.index):
        raise ValueError(f"{name}.index must be non-empty strings")
    try:
        values = series.to_numpy(dtype=float)
    except (TypeError, ValueError) as error:
        raise ValueError(f"{name} must be finite numeric") from error
    if not np.isfinite(values).all():
        raise ValueError(f"{name} must be finite numeric")


def _to_vector(series, labels, name):
    _validate_snapshot(series, name)
    if set(series.index) != set(labels):
        raise ValueError(f"{name} must share target's labels")
    return series.reindex(labels).to_numpy(dtype=float)


def _validate_participation(max_participation):
    if isinstance(max_participation, bool) or not isinstance(max_participation, Real):
        raise TypeError(
            f"max_participation must be a real number, got {type(max_participation).__name__}"
        )
    value = float(max_participation)
    if not np.isfinite(value) or value <= 0.0 or value > 1.0:
        raise ValueError(
            f"max_participation must be in (0, 1], got {max_participation!r}"
        )
    return value


def _validate_max_days(max_days):
    if isinstance(max_days, bool) or not isinstance(max_days, int):
        raise TypeError(f"max_days must be an integer, got {type(max_days).__name__}")
    if max_days < 1:
        raise ValueError(f"max_days must be at least 1, got {max_days!r}")
    return int(max_days)


def _lot_vector(lot_size, labels):
    if lot_size is None:
        return np.zeros(len(labels), dtype=float)
    if isinstance(lot_size, bool):
        raise TypeError("lot_size must be None, a positive integer, or a Series")
    if isinstance(lot_size, Integral):
        if int(lot_size) <= 0:
            raise ValueError(f"lot_size must be positive, got {lot_size!r}")
        return np.full(len(labels), float(int(lot_size)))
    if not isinstance(lot_size, pd.Series):
        raise TypeError("lot_size must be None, a positive integer, or a Series")
    if not lot_size.index.is_unique:
        raise ValueError("lot_size.index must be unique")
    if set(lot_size.index) != set(labels):
        raise ValueError("lot_size must share target's labels")
    lots = []
    for value in lot_size.reindex(labels):
        if isinstance(value, bool) or not isinstance(value, Integral):
            raise TypeError("lot_size values must be integers")
        if int(value) <= 0:
            raise ValueError(f"lot_size values must be positive, got {value!r}")
        lots.append(float(int(value)))
    return np.asarray(lots, dtype=float)


def schedule_trades(
    target: pd.Series,
    current: pd.Series,
    *,
    adv: pd.Series,
    max_participation: float = 0.1,
    max_days: int = 5,
    lot_size: int | pd.Series | None = None,
) -> ExecutionPlan:
    _validate_snapshot(target, "target")
    _validate_snapshot(current, "current")
    if set(target.index) != set(current.index):
        raise ValueError("current must share target's labels")
    labels = sorted(target.index)
    target_values = target.reindex(labels).to_numpy(dtype=float)
    current_values = current.reindex(labels).to_numpy(dtype=float)
    adv_values = _to_vector(adv, labels, "adv")
    if np.any(adv_values < 0.0):
        raise ValueError("adv must be finite non-negative numeric")
    participation = _validate_participation(max_participation)
    horizon = _validate_max_days(max_days)
    lots = _lot_vector(lot_size, labels)

    caps = participation * adv_values
    remaining = (target_values - current_values).copy()
    rows = []
    for _ in range(horizon):
        row = np.zeros(len(labels), dtype=float)
        for index in range(len(labels)):
            leftover = remaining[index]
            if leftover == 0.0:
                continue
            room = min(abs(leftover), caps[index])
            if lots[index] > 0.0:
                room = math.floor(room / lots[index]) * lots[index]
            if room <= 0.0:
                continue
            trade = math.copysign(room, leftover)
            row[index] = trade
            remaining[index] = leftover - trade
        if not np.any(row != 0.0):
            break
        rows.append(row)

    if rows:
        trades = pd.DataFrame(
            rows, index=pd.RangeIndex(1, len(rows) + 1), columns=labels
        )
    else:
        trades = pd.DataFrame(
            np.zeros((0, len(labels))),
            index=pd.RangeIndex(1, 1),
            columns=labels,
        )
    residual = pd.Series(remaining, index=labels, dtype=float)
    lot_residual_values = np.zeros(len(labels), dtype=float)
    mask = lots > 0.0
    if mask.any():
        lot_residual_values[mask] = np.fmod(
            np.abs(remaining[mask]), lots[mask]
        ) * np.sign(remaining[mask])
    lot_residual = pd.Series(lot_residual_values, index=labels, dtype=float)
    unfilled = residual - lot_residual
    counts = (trades != 0.0).sum(axis=0).reindex(labels).fillna(0).astype(int)
    days_used = pd.Series(counts.to_numpy(dtype=int), index=labels, dtype=int)
    return ExecutionPlan(trades, residual, unfilled, lot_residual, days_used)
```

注意：`_to_vector(adv, ...)` 内部 `_validate_snapshot` 已判非 Series／空／重复／
非字符串／非数值／非有限；`adv` 的负值在该函数返回后单独判。`target`／
`current` 的标签集合比较放在 `sorted` 之前。

运行同一命令，期望全绿（枚数现数）。

---

## Task 3: 变异自证 M1–M6

先确认基线全绿并记录模块 sha256。每条：内存保留原始 bytes → 字节级
替换 → 跑目标套件 → 必须真红 → 从内存副本写回 → 复校 sha256 与
`git diff` 为空。禁止用 `git checkout --` 还原。

| 针 | 字节级注入 | 期望红针 |
| --- | --- | --- |
| M1 | `room = min(abs(leftover), caps[index])` 改为 `room = abs(leftover)` | A／B／C／D／E／H／I |
| M2 | `caps = participation * adv_values` 改为 `caps = participation * np.ones(len(labels))` | A／B／C／D／E／H／I |
| M3 | `for _ in range(horizon):` 改为 `for _ in range(10**6):`（等价于无期限） | B／E |
| M4 | `room = math.floor(...) * lots[index]` 改为 `math.ceil(...)` | D／E／F／I／K |
| M5 | `unfilled = residual - lot_residual` 改为 `unfilled = residual.copy()` | D／E／F |
| M6 | 三处 `.reindex(labels)` 删除（`target_values`／`current_values`／`_to_vector` 的入参改原序） | J |

M6 的精确注入：`_to_vector` 中 `return series.reindex(labels).to_numpy(dtype=float)`
改为 `return series.to_numpy(dtype=float)`，且主体两行 `target.reindex(labels)`／
`current.reindex(labels)` 同样删去 `.reindex(labels)`。J 用 target 乱序
`["B","A"]`，按原序取数会把 B 的 450 配给 A，数值全错。

每条记录实际红针名；比预期宽不算问题，比预期窄要写清原因。若某针
不红，先算可达域并补针，不得把「没红」记成「已证」。

---

## Task 4: 门禁、徽章、档案 §7.39、提交与推送

```bash
cd agent && python -m pytest tests/quantlib -q 2>&1 | tail -3
cd .. && bash tools/ci_grep_gates.sh; echo "grep-gates rc=$?"
python -m pytest tools/test_ci_env_var_gate.py tools/test_ci_private_files_gate.py tools/test_doc_tables.py -q 2>&1 | tail -3
python -m pytest tools/test_wiki_drift.py -q 2>&1 | tail -3
bash tools/wiki_freshness_gate.sh; echo "watermark rc=$?"
```

后端全量（与 G8 同一命令行）：

```bash
PYTHONDONTWRITEBYTECODE=1 python -B -X utf8 -m pytest agent/tests -q --tb=no -rf \
  --continue-on-collection-errors --ignore=agent/tests/e2e_backtest \
  --ignore=agent/tests/test_e2e_harness_v2.py -p no:cacheprovider
```

取 FAILED 名集合与 G8 基线（`87 failed, 22002 passed, 206 skipped,
31 warnings, 9 errors`，含 1 枚已登记 rate_limiter 墙钟 flake）逐名做差，
新增红必须 0。前端三门免跑（本片零 `frontend/**`）。

七份 README 徽章：`326` → `328`、`28` → `29`（只改 Quant Library
徽章行）。`cd agent && python -m pytest tests/test_readme_counts.py -q`
必须全绿。

档案 `项目档案.md` 追加 `### 7.39 G9…`（bytes 层、CRLF），读数现填；
改完复跑读档门。

提交（显式 pathspec）：

```bash
git add agent/src/quantlib/execution.py agent/tests/quantlib/test_execution.py \
  README.md README_zh.md README_ja.md README_ko.md README_ar.md README_es.md README_id.md \
  项目档案.md superpowers/specs/2026-10-29-g9-execution-scheduling-design.md \
  superpowers/plans/2026-10-29-g9-execution-scheduling.md
git commit -s -m "feat(quantlib): participation-capped execution scheduling" \
  -m "Turn a target/current snapshot into deterministic per-asset day slices capped by ADV participation, with unfilled and sub-lot residuals reported instead of silently truncated."
```

推送前 `git ls-remote origin refs/heads/main` 对真值；cron 推进则改道
merge（不 rebase），合后复跑门 A 与档案读档门。推送后复读 CI 九腿与
逐腿注解，读数回填本文件的「执行期偏差」。

## 执行期偏差（执行时回填）

- 2026-10-29 变异实读（基线 `52 passed`，模块 sha256 注入前后同为
  `9d03c6b4…2402`，CR=0／LF=294）：M1 **9 红**（A／B／C／D／E／G／H／
  I／K）；M2 **8 红**（A／B／C／D／E／G／H／I）；M3 **2 红**（B／E）；
  M4 **3 红**（D／F／I）；M5 **4 红**（D／E／F／I）；M6 **1 红**（J）。
- M1 比预期宽：去掉 cap 后 G（`adv=0`）也成交、K 的参与率断言被触发。
- M2 比预期宽：G 的零 ADV 在「cap 恒为 p」下变成可交易；K 不红是因为
  它的参与率断言以字面 caps 为上限，小成交仍满足 ≤ 上限（守恒与分解
  不依赖 cap）。
- M4 比预期窄：E 在 `max_days=2` 下两次成交都是 400，floor 与 ceil 同值；
  K 的整手针只检查「是 100 的倍数」，ceil 仍产生整手（400/200）故不红。
- M5 比预期宽：I 的 A 项 `unfilled` 由 0 变 50，故也红。
- M6 与预期一致：仅 J 的对齐向量红。
- 2026-10-29 门册现读（同一棵树）：A `1634 passed, 64 skipped`；B
  `86 failed, 22057 passed, 205 skipped, 31 warnings, 9 errors in
  1039.50s`，FAILED 名集合对 G8 基线（87 名）逐名差集＝新增 0、消失 1
  （`test_rate_limiter_memory.py::test_empty_buckets_are_evicted_after_window_expires`
  ——已登记的墙钟 flake 本轮自然转绿）；全量枚数 +53＝本片 52 枚＋1 枚
  动态参数化摆动；C rc=1 只红 `[gate b]`，54 条命中／35 枚唯一文件
  tracked=0，本片提交面 12 枚文件商标计数全 0；D `1 failed, 51 passed`
  （Windows 换行文件名既知红）；E `240 passed`；F `447 (threshold 439)`
  rc=1（与 §7.32～§7.38 同读数）。前端三门免跑（本片零 `frontend/**`）。
- 2026-10-29 CI 复读（`4b7ed084`，run 40807874201）：九腿中 8 腿
  success；`test / Python 3.11` **cancelled**＝作业 20m 上限（依赖安装步
  02:41:54→02:49:27 共 7m33s，同树 3.14 腿仅 51s；测试步
  02:49:42→03:01:59 共 12m17s 被切），注解为 `The job has exceeded the
  maximum execution time of 20m0s` 与 `The operation was canceled.`，
  **无任何测试失败名**；本机同树门 B 新增红 0。`name the failing tests`
  仪器在该自然红上首次触发并 success（6s、3 枚 notice），census 注解
  `legs=1 name_budget=8 names_sent=0 used=1/10 L1[id=123231028497
  http=200 bytes=143159 names=0 chunks=0 sent=0]`——红腿是超时型、日志里
  没有可发的失败用例名，仪器不再自死。为取得同树外部绿读数，以本 docs
  提交重触发一次 CI。
