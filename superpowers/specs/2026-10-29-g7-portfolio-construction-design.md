# G7（tier 3）设计：从信号到约束权重

日期：2026-10-29
状态：定稿（随 G7 提交落仓）
上游：G5 `supervised.fit_predict_panel` 产出的 `predictions` 宽表；
本片消费「一行分数」，产出「一行目标权重」。

## 1. 要治的痛

`agent/src/quantlib/` 已有组合算法的两个端点，但中间那段是空的：

- `portfolio.py` 的 HRP／逆方差要一张**协方差矩阵**，不是一组分数；
- `combination.py` 只把多张因子面板合成一张分数面板；
- `neutralization.py` 只做因子残差化，不产出仓位；
- `impact.py` 只给单笔订单定价，不知道「昨天持有什么」。

于是「分数 → 目标权重」只能由调用方手写，而手写版本反复踩三类坑：

1. 秩基权重没处理并列，同一分数在不同行得到不同权重；
2. 单名上限靠一次 `clip` 后忘记重新归一，gross 静默缩水；
3. 多空账本在收缩后失去中性（混合两个净 0 的向量不保证 L1 仍等于
   gross——符号翻转会让绝对值相消）。

缺口写成一句话：**一个纯函数，把逐日分数变成满足制度约束（long-only／
dollar-neutral、gross、单名上限、向先验收缩）的目标权重，并把每一行的
约束体检结果如实报出来。**

## 2. 目标 / 非目标

目标：

1. 新模块 `agent/src/quantlib/construction.py`（纯函数，无 I/O、无时钟、
   无环境变量、无全局状态）。
2. 公开面：
   - `build_weights(scores, *, long_only=False, gross=1.0,
     max_weight=None, prior_weights=None, turnover_penalty=0.0,
     min_names=1) -> WeightResult`；
   - 冻结数据类 `ConstraintReport`（单行体检）、`WeightResult`
     （权重宽表 + 逐行体检元组）。
3. 两种制度：`long_only=True` 时权重非负、和等于 gross；否则
   dollar-neutral：净敞口为 0、Σ|w| 等于 gross。
4. 秩基权重（并列取平均秩）、逐名上限的迭代等量重分配、向先验权重
   收缩且收缩后仍**精确**满足全部约束、逐行退化报告。
5. 验收：手算向量 A–N、错误契约、逐行独立、精确性不变量、确定性/纯度、
   变异自证 M1–M6。

非目标：

- 不做均值-方差／风险平价优化，不读协方差矩阵。`portfolio.py` 已有 HRP。
- 不做行业／风格中性。`neutralization.py` 做的是因子残差化；把残差分
  作为本模块的输入分数是调用方的组合方式，本模块不 import 它。
- 不做回测、不计算成本、不生成订单。成本归 G8，执行切片归 G9。
- 不做整数股、手数、最小交易单位、融券费用。
- 不做持久化；`WeightResult.weights` 是普通宽表，调用方可交给 G4
  `write_panel`。
- **不注册进 `quantlib_tool.ALLOWED_MODULES`**。与 `selection`、
  `supervised` 一致：整表输入/输出会超出该工具 5000 叶的结果预算，
  且经由 JSON 信封传面板会把索引语义留在外面。

## 3. 定义（冻结）

### 3.1 输入

`scores: pd.DataFrame`

- index 为 `pd.DatetimeIndex`：唯一、严格升序、非空；
- columns：唯一、非空的 `str`，插入顺序即输出列序；
- 值：可转 `float64` 的数值；**NaN／±inf 不报错**，视为「该名当日不可
  投标」（不参与排名、权重为 0）。整表 0 行或 0 列 → `ValueError`。

`prior_weights: pd.DataFrame | None`

- 非 None 时必须与 `scores` 的 index、columns **逐位相等**
  （`.equals`），值必须全部有限；
- 数值不要求满足任何约束（本模块先投影再用）。

参数：

| 名称 | 类型 | 约束 | 默认 |
| --- | --- | --- | --- |
| `long_only` | `bool` | 严格 `bool`（`1` 不算） | `False` |
| `gross` | `float` | 有限且 > 0 | `1.0` |
| `max_weight` | `float \| None` | None 或有限且 > 0 | `None` |
| `prior_weights` | `DataFrame \| None` | 见上 | `None` |
| `turnover_penalty` | `float` | `[0, 1]` 内的有限数（`bool` 拒绝） | `0.0` |
| `min_names` | `int` | ≥ 1（`bool` 拒绝） | `1` |

### 3.2 单行算法（唯一规范描述）

对每一行，记可投标集合 `V = {i : score_i 有限}`，`n = |V|`。

**第 0 步：退化判定。**

- `n < min_names` → 该行权重全 0，`degenerate="insufficient"`，结束。
- 否则排序求秩。

**第 1 步：平均秩。** 在 `V` 内按分数升序排位（1-based）；并列的分数
取所占位次的算术平均。分数越高秩越大。

**第 2 步：原始权重。**

- long-only：`s_i = rank_i - min(rank)`，`raw_i = s_i / Σs × gross`
  （`V` 外为 0）。若 `Σs == 0`（全员并列，或只有一个名）→ 退化，
  `degenerate="no_dispersion"`，权重全 0。
- dollar-neutral：`c_i = rank_i - (n + 1) / 2`，
  `raw_i = c_i / Σ|c| × gross`。若 `Σ|c| == 0`（全员并列）→ 同
  `no_dispersion`。

注意 long-only 的「减 min」让当日最差名权重恰为 0；这是秩基多头的
定义，不是缺陷（手算向量 A/B 钉住）。

**第 3 步：先验投影 `project(v)`。** 仅当 `prior_weights` 非 None 且
`turnover_penalty > 0` 时用到；`v` 在 `V` 外先置 0。

- long-only：`clip(v, 0, ∞)`；若和 > 0 则按和缩放到 gross；若和为 0
  （先验没有可用多头方向）→ 返回 `raw`（先验无信息 ⇒ 收缩不动）。
- dollar-neutral：只对 `V` 内去均值（`v_i -= mean_{V}(v)`），若
  `Σ|v| > 0` 则缩放到 gross；若为 0 → 返回 `raw`。

**第 4 步：收缩与再投影。**

```
mix = (1 - λ) × raw + λ × project(prior)        # λ = turnover_penalty
mix = project(mix)
```

`λ > 0` 而 `prior_weights is None` → `ValueError`（调用契约错误）。

第二次投影不可省：dollar-neutral 的 `Σ|w| = gross` 是 L1 球面而**不是**
凸集，两个可行点混合时符号翻转会让 L1 相消（手算向量 J：混合后
gross 从 1 掉到 0.75，再投影回 1）。long-only 在非负象限上 L1 等于和，
混合与再投影都是恒等。

**第 5 步：单名上限。** `max_weight is None` → 跳过。

- 先做可行性检查（不可行是调用契约错误，不是数据问题）：
  - long-only：`max_weight × n ≥ gross - 1e-12`，否则
    `ValueError("infeasible cap: ...")`；
  - dollar-neutral：按 `mix` 的符号分桶 `P = {i : mix_i > 0}`、
    `N = {i : mix_i < 0}`，桶预算取 `Σ_{P} mix` 与 `Σ_{N} |mix|`
    （净 0 时各为 gross/2）；桶内 `max_weight × |桶| ≥ 预算 - 1e-12`，
    否则同错。
- **迭代等量重分配**（对每个桶的绝对值做 water-filling）：

```
w ← |mix|（桶内）
fixed ← 全 False
循环：
    over ← 未 fixed 且 w > cap
    若 over 为空：结束
    excess ← Σ(w[over] - cap)
    w[over] ← cap；fixed[over] ← True
    active ← 未 fixed
    若 active 非空：w[active] ← w[active] + excess / |active|
```

  每轮至少固定一个名，至多 n 轮终止。超限部分**等量**分给尚未封顶的
  名（含原本权重为 0 的名），不按原分数比例——这是刻意的简化：封顶
  之后残余信号已被制度截断，等量分配让结果可手算、可复现。
- `capped = True` 当且仅当封顶前有任意 `|mix_i| > max_weight`（严格
  大于；恰等于上限不算）。

**第 6 步：收尾。** `V` 外权重强制 0。

**第 7 步：体检。**

| 字段 | 定义 |
| --- | --- |
| `date` | 该行 index 标签（`pd.Timestamp`） |
| `n_valid` | `n` |
| `n_held` | 非零权重个数（精确 `!= 0`） |
| `gross` | `Σ|w|` |
| `net` | `Σw` |
| `max_abs_weight` | `max|w|`；无持仓时为 0.0 |
| `turnover` | `0.5 × Σ|w - prior_row|`；无先验时 `prior_row` 取全 0，退化行同式 |
| `capped` | 见第 5 步；退化行为 False |
| `degenerate` | `None` / `"insufficient"` / `"no_dispersion"` |

`turnover` 对**原始先验**计（不是投影后的先验），单边口径；它只描述
权重变化，不折算成钱（G8 负责定价）。无先验且满仓时
`turnover = gross / 2`。

### 3.3 输出

```python
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
    weights: pd.DataFrame          # 与输入同 index/columns，float64
    report: tuple[ConstraintReport, ...]   # 与 index 同序同长
```

### 3.4 不变量（规范，测试必钉）

1. **逐行独立**：第 i 行输出只依赖第 i 行分数、第 i 行先验与参数；
   改动别的行不得改变本行（逐位相等）。
2. **精确性**（非退化行）：long-only `w ≥ 0`、`Σw = gross`；
   dollar-neutral `|Σw| ≤ 1e-12`、`Σ|w| = gross`；有上限时
   `max|w| ≤ max_weight + 1e-12`。均按 `1e-12` 容差。
3. **不可变性**：`scores`／`prior_weights` 调用前后 `.equals` 为真。
4. **确定性**：同输入两次运行，权重逐位相等、报告 dataclass 元组相等。
5. **纯度**：模块源码不含 `import os`、`import time`、`open(`、
   `os.environ`、`random`。

### 3.5 错误契约

| 情形 | 异常 |
| --- | --- |
| `scores` 不是 DataFrame | `TypeError` |
| index 不是 `DatetimeIndex` | `TypeError` |
| 0 行 / 0 列 | `ValueError` |
| index 重复 / 非升序 | `ValueError` |
| columns 重复 / 含非 str / 空串 | `ValueError` |
| 值不可转 float | `ValueError` |
| `long_only` 非严格 bool | `TypeError` |
| `gross` 为 bool／≤0／非有限 | `ValueError` |
| `max_weight` 为 bool／≤0／非有限 | `ValueError` |
| `turnover_penalty` 为 bool／越界／非有限 | `ValueError` |
| `min_names` 为 bool／<1／非 int | `ValueError` |
| `λ > 0` 但 `prior_weights is None` | `ValueError` |
| `prior_weights` 非 DataFrame | `TypeError` |
| `prior_weights` 的 index 或 columns 不逐位相等 | `ValueError` |
| `prior_weights` 含非有限值 | `ValueError` |
| 上限不可行 | `ValueError`（消息以 `infeasible cap` 开头） |

## 4. 手算向量（测试逐条落针）

列名 A, B, C, …；所有 gross 未注明时为 1.0；`λ` 即
`turnover_penalty`。

**向量 A —— long-only 基本形。** `[0.1, 0.2, 0.3]` → 秩 1,2,3，
减 min 后 0,1,2 → **`[0, 1/3, 2/3]`**；`n_held=2`、`max_abs=2/3`、
`turnover=0.5`、`capped=False`。

**向量 B —— 并列取平均秩。** `[0.5, 0.5, 0.2, 0.9]` → 秩
`2.5, 2.5, 1, 4`，减 min 后 `1.5, 1.5, 0, 3`，和 6 →
**`[0.25, 0.25, 0, 0.5]`**。

**向量 C —— 上限迭代重分配。** `[4, 3, 2, 1]`，原始
`[1/2, 1/3, 1/6, 0]`，cap `0.3`：
第一轮封 A=0.3，余 0.2 均分给 B/C/D；B 升到 0.4；
第二轮封 B=0.3，余 0.1 均分给 C/D →
**`[3/10, 3/10, 17/60, 7/60]`**；`capped=True`、`n_held=4`。

**向量 D —— 上限不可行。** long-only 3 名 cap 0.2（3×0.2 < 1）→
`ValueError`；dollar-neutral 8 名 gross 1 cap 0.1（每桶 4×0.1 < 0.5）
→ `ValueError`。

**向量 E —— dollar-neutral 基本形。** `[1,2,3,4]` → 中心化秩
`-1.5, -0.5, 0.5, 1.5`，`Σ|c|=4` →
**`[-0.375, -0.125, 0.125, 0.375]`**；`net=0`、`gross=1`、
`max_abs=0.375`、`turnover=0.5`。

**向量 F —— 奇数名的零心名。** `[1,2,3]` → `[-1, 0, 1]`，`Σ|c|=2` →
**`[-0.5, 0, 0.5]`**；`n_held=2`（中间名恰为 0）。

**向量 G —— dollar-neutral 并列。** `[1,1,3,4]` → 秩
`1.5,1.5,3,4`，中心 2.5 → `[-1,-1,0.5,1.5]`，`Σ|c|=4` →
**`[-0.25, -0.25, 0.125, 0.375]`**。

**向量 H —— dollar-neutral 上限按符号桶。** 10 名，分数 `1..10`，
gross 1，cap 0.1：原始正侧 `[0.02,0.06,0.10,0.14,0.18]`，桶预算 0.5，
三轮 water-filling 后正侧全为 **0.10**；负侧对称 →
最终 **`[-0.1×5, +0.1×5]`**；`n_held=10`、`capped=True`、
`net=0`、`gross=1`。

**向量 I —— long-only 收缩。** `[1,2,3]`，先验
`[0.5,0.25,0.25]`，`λ=0.5`：原始 `[0,1/3,2/3]`，先验投影不变，
混合 → **`[1/4, 7/24, 11/24]`**；`turnover=0.25`、`capped=False`。

**向量 J —— 收缩后的符号翻转与再投影。** `[1,2,3,4]`，
先验 `[0.3,0.2,0.1,0.4]`，`λ=0.5`：原始 `[-0.375,-0.125,0.125,0.375]`；
先验去均值后 `[0.05,-0.05,-0.15,0.15]`，缩放到 `[0.125,-0.125,-0.375,0.375]`；
混合 `[-0.125,-0.125,-0.125,0.375]`（C 由正翻负），`Σ|·|=0.75`；
再投影回 gross 1 → **`[-1/6, -1/6, -1/6, 1/2]`**；`turnover=0.6`、
`net=0`、`gross=1`。**跳过第二次投影时 gross=0.75**，本向量即红。

**向量 K —— 退化。**
- K1 `[1.0, nan, nan]`、`min_names=2` → 全 0、`"insufficient"`、
  `n_valid=1`、`n_held=0`、`turnover=0`；
- K2 `[0.7,0.7,0.7]`（long-only 与 dollar-neutral 各一次）→ 全 0、
  `"no_dispersion"`；
- K3 单名 `[0.4]`（默认 `min_names=1`）→ `"no_dispersion"`（秩 1，
  减 min 后为 0），不是 `"insufficient"`；
- K4 面板混合行：退化行的上下邻行逐位不受影响，`report[i].date`
  与 `weights.index[i]` 相等。

**向量 L —— 不可投标的分数。** long-only
`[1, inf, -inf, nan, 2, 3]` → `n_valid=3`，
**`[0, 0, 0, 0, 1/3, 2/3]`**。

**向量 M —— 上限把余量分进零权重名。** `[1,2]`，cap 0.5：原始
`[0,1]` → **`[0.5, 0.5]`**、`capped=True`、`n_held=2`。

**向量 N —— 恰好等于上限不算 capped。** `[1,2,3]`，cap `2/3` →
权重不变、`capped=False`（严格大于才封顶）。

**向量 O —— 单轮封顶与零权重名接余量。** `[1,2,3]`，cap 0.6：原始
`[0, 1/3, 2/3]`，封 C=0.6，余 `1/15` 均分给 A/B →
**`[1/30, 11/30, 3/5]`**、`capped=True`、`n_held=3`。

## 5. 变异自证 M1–M6

先跑绿基线，再逐条注入；每条必须真红，随后从**动手前的内存副本**
按字节还原并复校 sha256。

| 针 | 注入 | 期望红针 |
| --- | --- | --- |
| M1 | 上限分支改为永不进入 | C／H／M／O |
| M2 | long-only 用原始秩（不减 min） | A／B |
| M3 | dollar-neutral 用原始秩（不去心） | E／F／G |
| M4 | 强制 `λ = 0` | I／J |
| M5 | 删掉 `n < min_names` 分支 | K1／K4 |
| M6 | 删掉混合后的第二次投影 | J |

若某条在可达域上不红，先算可达域并补针，再判红；「没红」不得记成
「已证」。

## 6. 验收口径

- 测试：`agent/tests/quantlib/test_construction.py`；
- 门 A：`cd agent && python -m pytest tests/quantlib -q`；
- 门 B：仓库根全量后端（命令行见 plan），FAILED 名集合与 G5 最终树
  基线逐名相等，新增 0、消失 0；
- 门 C：`bash tools/ci_grep_gates.sh`；门 D：三个工具测试；
  门 E：`tools/test_wiki_drift.py`；门 F：`tools/wiki_freshness_gate.sh`；
- 前端三门免跑（本片零 `frontend/**` 改动，判据
  `git diff --name-only | grep '^frontend/'` 为空）；
- README 七份徽章：319 → **322** 函数、26 → **27** 模块；
- 档案 §7.37；提交 `git commit -s` ＋显式 pathspec；
- 推送前 `git ls-remote origin refs/heads/main` 对真值；推送后复读
  CI 九腿与注解。

## 7. 已知边界

- 秩基权重丢弃分数间距，只保留序；等距分数与极端离群分数得到同一
  组权重。这是为了横截面稳健与可手算，不是疏忽。
- long-only 的「减 min」使最差名恒为 0，因此 `n_held ≤ n_valid - 1`
  （并列最差时更少）。调用方若要求全员持有，应改用等权或 HRP。
- 上限之后的等量重分配不再看分数；封顶名越多，组合越接近等权。
- dollar-neutral 的符号在收缩后可能翻转（向量 J 的 C 名），桶归属按
  **混合后的符号**判定，不按原始秩的符号。
- 不处理同日多次调仓、盘中价格、停牌与涨跌停；这些属于执行层（G9）。
