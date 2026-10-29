# G7（tier 3）实现计划：从信号到约束权重

日期：2026-10-29
坐标：spec＝`superpowers/specs/2026-10-29-g7-portfolio-construction-design.md`
路线图：`superpowers/plans/2026-10-29-tier3-signal-to-execution-roadmap.md`
基线：main `2646ebec`（G5 收口、CI 九腿全绿之后）

## Global Constraints

- 纯函数：无 I/O、无时钟、无环境变量、无全局状态；输入表不得被修改。
- 只依赖 numpy/pandas；不新增第三方依赖，不 import sklearn/scipy。
- 第 t 行只用第 t 行分数与先验；跨行独立，禁止任何跨行统计量。
- 不注册进 `quantlib_tool.ALLOWED_MODULES`。
- 提交一律 `git commit -s` ＋显式 pathspec；推送前 `git ls-remote`。
- 恒红门先证「本片 0 贡献」，不调阈值、不修门、不清白名单。

---

## Task 1: RED — 写测试面

文件：`agent/tests/quantlib/test_construction.py`

覆盖（按 spec §4 的向量逐条落针；期望值一律写字面量或分数）：

1. **A** long-only `[0.1,0.2,0.3]` → `[0, 1/3, 2/3]`；报告
   `n_valid=3`、`n_held=2`、`max_abs=2/3`、`turnover=0.5`、
   `capped=False`、`degenerate=None`。
2. **B** 并列 `[0.5,0.5,0.2,0.9]` → `[0.25,0.25,0,0.5]`。
3. **C** cap 0.3 → `[3/10, 3/10, 17/60, 7/60]`、`capped=True`。
4. **D** long-only 3 名 cap 0.2 与 dollar-neutral 8 名 cap 0.1 各抛
   `ValueError(match="infeasible cap")`。
5. **E** dn `[1,2,3,4]` → `[-0.375,-0.125,0.125,0.375]`。
6. **F** dn `[1,2,3]` → `[-0.5,0,0.5]`、`n_held=2`。
7. **G** dn 并列 `[1,1,3,4]` → `[-0.25,-0.25,0.125,0.375]`。
8. **H** dn 10 名 cap 0.1 → 全部 `±0.1`、`capped=True`、`n_held=10`。
9. **I** long-only 收缩、λ=0.5 → `[1/4, 7/24, 11/24]`、`turnover=0.25`。
10. **J** dn 收缩、λ=0.5 → `[-1/6,-1/6,-1/6,1/2]`、`turnover=0.6`、
    `gross=1`、`net=0`。
11. **K1** `[1.0,nan,nan]`、`min_names=2` → 全 0、`"insufficient"`。
12. **K2** 全员并列（long-only 与 dn 各一次）→ `"no_dispersion"`。
13. **K3** 单名、默认参数 → `"no_dispersion"`（不是 `"insufficient"`）。
14. **K4** 面板混合行：退化行零权重、邻行逐位不变、`report[i].date`
    与 `weights.index[i]` 相等。
15. **L** `[1,inf,-inf,nan,2,3]` → `n_valid=3`、
    `[0,0,0,0,1/3,2/3]`。
16. **M** `[1,2]` cap 0.5 → `[0.5,0.5]`。
17. **N** cap 恰等于最大原始权重（`2/3`）→ `capped=False`、权重不变。
18. **O** cap 0.6 → `[1/30, 11/30, 3/5]`。
19. **报告面**：`report` 是元组、长度与行数相等、字段类型；
    `turnover` 对原始先验（不是投影先验）计：long-only `[1,2,3]`、
    先验 `[1,0,0]`、λ=0 → `0.5*(1+1/3+2/3)=1.0`。
20. **先验无方向回退**：long-only 先验全 0、dn 先验常数 → λ=1 时
    结果等于原始权重（`project` 回退到 `raw`）。
21. **精确性扫掠**：一张 6 行固定面板，long-only 与 dn 各跑
    cap+收缩；逐行断言 `Σw=gross`（long-only）、`|Σw|≤1e-12` 且
    `Σ|w|=gross`（dn）、`max|w|≤cap+1e-12`。
22. **确定性/纯度**：同输入两跑权重逐位相等、报告元组相等；
    `scores`／`prior_weights` 前后 `.equals`；模块源码不含
    `import os`、`import time`、`open(`、`os.environ`、`random`。
23. **错误契约**（spec §3.5 逐行）：非 DataFrame、非 DatetimeIndex、
    0 行/0 列、重复/乱序 index、重复/非 str/空串列、非数值、
    `long_only` 非 bool、`gross`/`max_weight`/`turnover_penalty`
    的 bool 与非正/越界、`min_names` 非 int 或 <1、λ>0 无先验、
    先验非 DataFrame/形状不符/非有限。

测试骨架（关键断言）：

```python
from src.quantlib.construction import build_weights

def panel(values, columns=None, dates=None):
    array = np.asarray(values, dtype=float)
    if array.ndim == 1:
        array = array[:, None]
    if dates is None:
        dates = pd.date_range("2024-01-02", periods=array.shape[0], freq="D")
    if columns is None:
        columns = [f"s{i}" for i in range(array.shape[1])]
    return pd.DataFrame(array, index=dates, columns=columns)

def test_long_only_rank_weights():
    res = build_weights(panel([[0.1, 0.2, 0.3]], columns=list("ABC")),
                        long_only=True)
    np.testing.assert_allclose(res.weights.iloc[0], [0.0, 1 / 3, 2 / 3],
                               atol=1e-15)
    rep = res.report[0]
    assert (rep.n_valid, rep.n_held, rep.capped, rep.degenerate) == (3, 2, False, None)
    assert rep.gross == pytest.approx(1.0)
    assert rep.turnover == pytest.approx(0.5)

def test_dollar_neutral_shrinkage_reprojects_after_sign_flip():
    scores = panel([[1, 2, 3, 4]], columns=list("ABCD"))
    prior = panel([[0.3, 0.2, 0.1, 0.4]], columns=list("ABCD"))
    res = build_weights(scores, prior_weights=prior, turnover_penalty=0.5)
    np.testing.assert_allclose(res.weights.iloc[0],
                               [-1 / 6, -1 / 6, -1 / 6, 0.5], atol=1e-15)
    assert res.report[0].turnover == pytest.approx(0.6)
    assert abs(res.report[0].net) <= 1e-12
```

运行：

```bash
cd agent && python -m pytest tests/quantlib/test_construction.py -q
```

期望：收集期 `ModuleNotFoundError: No module named 'src.quantlib.construction'`。
实读：`1 error in ...`（枚数现读；只记「收集期模块不存在」这一形状）。

---

## Task 2: GREEN — 写实现

文件：`agent/src/quantlib/construction.py`

公开面：

```python
__all__ = ["ConstraintReport", "WeightResult", "build_weights"]

@dataclass(frozen=True)
class ConstraintReport:
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
    weights: pd.DataFrame
    report: tuple[ConstraintReport, ...]
```

核心片段（逐字采用；这是唯一容易写错的算术）：

```python
def _average_rank(values: np.ndarray) -> np.ndarray:
    n = values.size
    order = np.argsort(values, kind="stable")
    ranks = np.empty(n, dtype=float)
    i = 0
    while i < n:
        j = i + 1
        while j < n and values[order[j]] == values[order[i]]:
            j += 1
        ranks[order[i:j]] = 0.5 * (i + 1 + j)
        i = j
    return ranks


def _project(values, raw, valid, long_only, gross):
    v = np.where(valid, values, 0.0)
    if long_only:
        v = np.clip(v, 0.0, None)
        total = float(v.sum())
        if total <= 0.0:
            return raw.copy()
        return v * (gross / total)
    mean = float(v[valid].mean())
    v = np.where(valid, v - mean, 0.0)
    total = float(np.abs(v).sum())
    if total == 0.0:
        return raw.copy()
    return v * (gross / total)


def _cap_bucket(magnitudes, cap):
    w = magnitudes.copy()
    fixed = np.zeros(w.shape, dtype=bool)
    while True:
        over = (~fixed) & (w > cap)
        if not over.any():
            return w
        excess = float((w[over] - cap).sum())
        w[over] = cap
        fixed |= over
        active = ~fixed
        if not active.any():
            return w
        w[active] += excess / float(active.sum())
```

单行流程：

1. `valid = np.isfinite(row)`；`n = int(valid.sum())`；
   `prior_ref = prior_row if prior is not None else zeros`。
2. `n < min_names` → `w = zeros`、`"insufficient"`，跳到第 8 步。
3. `ranks = _average_rank(row[valid])`。
4. long-only：`shifted = ranks - ranks.min()`；`total = shifted.sum()`；
   为 0 → `"no_dispersion"`；否则 `raw[valid] = shifted / total * gross`。
   dn：`centered = ranks - (n + 1) / 2`；`total = |centered|.sum()`；
   为 0 → `"no_dispersion"`；否则 `raw[valid] = centered / total * gross`。
5. `mix = raw`；若 `λ > 0`：
   `mix = (1-λ) * raw + λ * _project(prior_row, raw, valid, long_only, gross)`；
   然后 `mix = _project(mix, raw, valid, long_only, gross)`（**第二次投影
   不得省**）。
6. `capped = False`；若 `max_weight is not None`：
   - long-only：可行 `cap*n ≥ gross-1e-12`，否则 `ValueError("infeasible cap: ...")`；
     `capped = bool(np.any(np.abs(mix) > cap))`；
     `mix[valid] = _cap_bucket(np.abs(mix[valid]), cap)`。
   - dn：`pos = valid & (mix > 0)`、`neg = valid & (mix < 0)`；
     对每个非空桶检查 `cap*size ≥ budget-1e-12`（budget 用桶内绝对值和），
     否则同错；`capped` 同式；分别对 `np.abs(mix[pos])` 与
     `np.abs(mix[neg])` 做 `_cap_bucket`，再把负桶取负写回。
7. `w = np.where(valid, mix, 0.0)`；浮点收尾：不做再归一化（桶和已守恒）。
8. 报告：`gross=Σ|w|`、`net=Σw`、`max_abs=max|w|`、
   `turnover=0.5*Σ|w-prior_ref|`、`n_held=count_nonzero(w)`。

校验层按 spec §3.5 逐条实现；数值转换失败包装为
`ValueError("scores must be numeric")`；参数 helper 统一拒绝 `bool`。

面板循环：逐行调用单行核心，结果写进 `np.zeros_like(values)`，
报告按行序装进元组；返回 `WeightResult`（weights 的 index/columns
与输入一致）。

运行同一命令，期望全绿（枚数现数）。

---

## Task 3: 变异自证 M1–M6

先确认基线全绿并记录模块 sha256。每条：内存保留原始 bytes →
字节级替换 → 跑目标套件 → 必须真红 → 从内存副本写回 →
复校 sha256 与 `git diff` 为空。禁止用 `git checkout --` 还原。

| 针 | 字节级注入 | 期望红针 |
| --- | --- | --- |
| M1 | 上限分支条件改为 `if False:` | C／H／M／O |
| M2 | long-only 的 `ranks - ranks.min()` 改为 `ranks` | A／B |
| M3 | dn 的 `ranks - (n + 1) / 2` 改为 `ranks` | E／F／G |
| M4 | `mix = (1 - lam) * raw + ...` 前强制 `lam = 0.0` | I／J |
| M5 | 删去 `n < min_names` 的早退分支 | K1／K4 |
| M6 | 混合后的第二次 `_project` 调用删除 | J（gross 0.75） |

每条记录实际红针名；比预期宽不算问题，比预期窄要写清原因。若某针
不红，先算可达域并补针，不得把「没红」记成「已证」。

实读（2026-10-29，仓库外 harness 全量重跑留档；基线 `62 passed`，
模块 sha256 前后均为 `d53709f0…214b22`，六针均真红、无一针 SKIP）：

| 针 | 实读 | 实际红针 |
| --- | --- | --- |
| M1 | 8 failed, 54 passed | `test_long_only_cap_redistributes_iteratively`、`test_long_only_cap_infeasible_raises`、`test_dollar_neutral_cap_infeasible_raises`、`test_dollar_neutral_cap_applies_per_sign_bucket`、`test_cap_redistributes_into_zero_weight_name`、`test_cap_single_round_redistribution`、`test_constraints_hold_across_a_mixed_panel`、`test_cap_and_shrinkage_together_stay_inside_constraints` |
| M2 | 11 failed, 51 passed | `test_long_only_rank_weights`、`test_long_only_average_ranks_for_ties`、`test_long_only_cap_redistributes_iteratively`、`test_long_only_shrinks_toward_prior`、`test_no_dispersion_goes_flat[True]`、`test_single_name_is_no_dispersion_not_insufficient`、`test_non_finite_scores_are_ineligible`、`test_cap_equal_to_max_is_not_flagged`、`test_cap_single_round_redistribution`、`test_turnover_uses_raw_prior`、`test_prior_without_direction_falls_back_to_target` |
| M3 | 7 failed, 55 passed | `test_dollar_neutral_weights`、`test_dollar_neutral_odd_name_has_zero_centroid`、`test_dollar_neutral_average_ranks_for_ties`、`test_dollar_neutral_cap_applies_per_sign_bucket`、`test_dollar_neutral_shrinkage_reprojects_after_sign_flip`、`test_no_dispersion_goes_flat[False]`、`test_constraints_hold_across_a_mixed_panel` |
| M4 | 2 failed, 60 passed | `test_long_only_shrinks_toward_prior`、`test_dollar_neutral_shrinkage_reprojects_after_sign_flip` |
| M5 | 3 failed, 59 passed | `test_insufficient_names_goes_flat`、`test_panel_reports_dates_in_order_and_flags_degenerate_rows`、`test_constraints_hold_across_a_mixed_panel` |
| M6 | 1 failed, 61 passed | `test_dollar_neutral_shrinkage_reprojects_after_sign_flip`（gross 0.75，与预期同针） |

比预期宽的四针（M2 多 9 枚、M3 多 4 枚、M5 多 1 枚、M1 多 4 枚）都是
同一缺陷的下游断言，非缺陷外溢；比预期窄的没有。

---

## Task 4: 门禁、徽章、档案 §7.37、提交与推送

```bash
cd agent && python -m pytest tests/quantlib -q 2>&1 | tail -3
cd .. && bash tools/ci_grep_gates.sh; echo "grep-gates rc=$?"
python -m pytest tools/test_ci_env_var_gate.py tools/test_ci_private_files_gate.py tools/test_doc_tables.py -q 2>&1 | tail -3
python -m pytest tools/test_wiki_drift.py -q 2>&1 | tail -3
bash tools/wiki_freshness_gate.sh; echo "watermark rc=$?"
```

后端全量（与 G5 最终树同一命令行）：

```bash
PYTHONDONTWRITEBYTECODE=1 python -B -X utf8 -m pytest agent/tests -q --tb=no -rf \
  --continue-on-collection-errors --ignore=agent/tests/e2e_backtest \
  --ignore=agent/tests/test_e2e_harness_v2.py -p no:cacheprovider
```

取 FAILED 名集合与 G5 基线（`85 failed, 21904 passed, 206 skipped,
9 errors`）做差，新增红必须 0。前端三门免跑（本片零 `frontend/**`）。

七份 README 徽章：`319` → `322`、`26` → `27`（只改 Quant Library
徽章行；`319` 在其他行是历史 PR 号，逐行确认后只动徽章）。

档案 `${...}/项目档案.md` 追加 `### 7.37 G7…`（bytes 层、CRLF），
读数现填；改完复跑读档门。

提交（显式 pathspec）：

```bash
git add agent/src/quantlib/construction.py agent/tests/quantlib/test_construction.py \
  README.md README_zh.md README_ja.md README_ko.md README_ar.md README_es.md README_id.md \
  项目档案.md superpowers/specs/2026-10-29-g7-portfolio-construction-design.md \
  superpowers/plans/2026-10-29-g7-portfolio-construction.md \
  superpowers/plans/2026-10-29-tier3-signal-to-execution-roadmap.md
git commit -s -m "feat(quantlib): constrained portfolio construction from cross-sectional scores" \
  -m "<why>"
```

推送前 `git ls-remote origin refs/heads/main` 对真值；cron 推进则改道
merge（不 rebase），合后复跑门 A 与档案读档门。推送后复读 CI 九腿与
逐腿注解，读数回填本文件的「执行期偏差」。

## 起草期更正（写入计划前，供后续会话防复发）

- 2026-10-29：向量 I 的 `turnover` 初稿写作 `0.5`，实际按原始先验
  计算为 `0.25`（`0.5*(0.25+1/24+5/24)`），以本文件与 spec 的
  `0.25` 为准。
- 2026-10-29：dollar-neutral 的缩放因子是 `gross/Σ|c|`（不是
  `(gross/2)/Σ|c|`）；后者会让 Σ|w| 只有 gross 的一半。向量 E/F/G/H
  已按前者重算。

## 执行期偏差（执行时回填）

- 2026-10-29：Task 1 的精确性扫掠面板由计划的 6 行改为 7 行（4 名或全
  NaN 两种行，cap 0.25、gross 1.0）。原 6 行设计里 dn 的某个符号桶只有
  1 名、桶预算 1.0，`cap*1 < 1.0` 必然触发「infeasible cap」，扫掠无法
  覆盖 cap+收缩的正常路径。
- 2026-10-29：输入不可变针的 cap 由草案的 0.4 改为 0.6。dn 正桶只有 1
  名、预算 0.5，cap 0.4 同样不可行；该针只验证输入不被修改，用 0.6
  即可。
- 2026-10-29：变异实读见 Task 3 表；基线 `62 passed`，模块 sha256 前后
  一致。
- 2026-10-29：推送后复读 d86b806c：check-runs 共 10 条＝九腿全部
  success（Hash lock ×3、Windows 生命周期 ×3、frontend、test / Python
  3.11、test / Python 3.14）＋「name the failing tests」skipped（无失败
  时的预期姿态）。四腿各 1 枚注解且全为 notice：macOS ARM64＝runner
  容量排队提示；frontend 与两条 test 腿＝`ubuntu-latest` 自 2026-10-19
  起迁移 Ubuntu 26 的提示。零代码相关注解。

