# G8（tier 3）设计：换手成本与净收益

日期：2026-10-29
路线图：`superpowers/plans/2026-10-29-tier3-signal-to-execution-roadmap.md` §2
前置：G7 `superpowers/specs/2026-10-29-g7-portfolio-construction-design.md`

## 1. 要治的痛

`impact.py` 已有四种单笔冲击/滑点模型，但全是标量函数：调用方拿到一个价格、
一个方向、一个规模，换回一个成交价。仓库里没有任何函数回答组合层面的三个
问题：

1. 两个相邻目标权重之间到底交易了多少（单边换手）？`ConstraintReport.turnover`
   只对「当期权重 vs 原始先验」计，不构成一条跨日成本序列。
2. 这些交易按费率/冲击折成多少收益损失，累计多少？
3. 毛收益扣掉成本之后净收益是多少，成本吃掉毛收益的几成，费率涨到多少
   净收益归零？

没有这三件，G7 的权重无法进入任何以净收益为准的评估，G9 的执行排程也没有
成本口径可对账。

## 2. 目标 / 非目标

**目标**

- `trade_cost(weights, *, cost_bps=0.0, impact=None, initial_weights=None)`：
  逐日单边换手与成本、累计成本。
- `net_returns(weights, asset_returns, costs, *, lag=1)`：把 t 日收盘形成的
  权重在 t+lag 日生效，逐日组合毛收益、成本、换手、净收益。
- `attribution_summary(net)`：毛收益、成本、净收益、成本占毛收益比、
  盈亏平衡费率（bps）。
- 会计恒等式 `net = gross - cost` 逐日成立。
- 换手口径与 G7 `ConstraintReport.turnover` 一致：单边、对上一期权重。

**非目标**

- 不构造收益（调用方给逐资产收益）。
- 不优化换手、不做交易轨迹拆分（G9 负责）。
- 不算融券费用、税、印花税差别、最低佣金。
- 不引入第三方依赖；不注册 `quantlib_tool.ALLOWED_MODULES`（与
  `selection`／`supervised`／`construction` 一致，面板超 5000 叶预算）。
- 不做复利链接：`attribution_summary` 的总量是逐日简单加总，不是几何收益。

## 3. 定义（冻结）

### 3.1 输入

`weights`

- 宽表 `pd.DataFrame`，index 为 `DatetimeIndex`（唯一、升序、非空），
  columns 为非空字符串（唯一），值必须有限（允许负权重，dollar-neutral 合法）。
- 语义：第 t 行是 t 日收盘形成的目标权重，t 日收盘之后才可能成交。

`initial_weights`（可选）

- `pd.Series`，索引与 `weights.columns` 集合相等（按标签对齐），值为有限数。
- 语义：第 0 行之前的持仓。缺省视为全 0（从空仓开始建仓）。

`impact`（可选）

- 与 `weights` 同形的 `pd.DataFrame`，index 与 columns 必须与 `weights`
  **逐位全等**（`.equals`）；值为有限且非负的相对成本率（如 0.001＝10bps），
  由调用方按 `impact.py` 的模型逐笔算出后填表。
- 语义：在该日该资产上，每交易一单位名义金额额外付出的比例成本。

`cost_bps`

- 实数标量，有限、非负，拒绝 `bool`。缺省 0。
- **口径冻结**：`cost_bps` 按「一单位单边换手」计费，即无冲击时
  `cost = turnover × cost_bps/1e4`。它不是「每单位双边成交额」的费率；
  若调用方拿到的是单边费率，自行乘 2。

`asset_returns`

- 与 `weights` 同形（index/columns 逐位 `.equals`）的 `pd.DataFrame`，
  数值 dtype；允许 `NaN`（缺收益）。

`costs`

- `trade_cost` 的返回值（可含额外列），必须含 `turnover` 与 `cost` 两列，
  index 与 `weights` 逐位 `.equals`。

`lag`

- `int`（拒绝 `bool`），`≥0`，缺省 1。`lag=0` 表示当日收盘权重当日生效，
  只用于研究对齐，调用方自担前视风险；缺省 1 与 A 股 T+1 一致。

`net`

- `net_returns` 的返回值，必须含 `gross_return`、`cost`、`turnover`、
  `net_return` 四列，非空。

### 3.2 成本算法（唯一规范描述）

逐日、按行序：

1. `prev = initial_weights` 对齐到 `weights.columns` 后的向量；缺省全 0。
2. 第 t 行：`delta = |w_t - prev|`；
   `turnover_t = 0.5 × Σ_a delta_a`。
3. `rate_t = cost_bps/1e4 + impact_t`（无 `impact` 时 `rate_t` 为标量
   `cost_bps/1e4`）；
   `cost_t = 0.5 × Σ_a delta_a × rate_{t,a}`。
4. `prev = w_t`；下一行重复。
5. `cumulative_cost_t = Σ_{s≤t} cost_s`。

输出 `pd.DataFrame`，index 同 `weights`，列序
`["turnover", "cost", "cumulative_cost"]`。

等价形式：费率均匀时 `cost_t = turnover_t × rate`；`rate` 逐资产不同时，
`cost_t = 0.5 × Σ_a |Δw_{t,a}| × rate_{t,a}`。两条写法在测试里都要钉。

### 3.3 净收益算法

逐日：

1. `effective = weights.shift(lag)`；前 `lag` 行为缺失，按 0 权重处理。
2. `contribution = effective × asset_returns`，但 `effective == 0` 的位置
   强制为 0（零权重资产当日的 `NaN` 收益不污染组合）。
3. `gross_return_t = Σ_a contribution_{t,a}`，**NaN 不跳过**：持有资产缺
   收益时当日毛收益为 `NaN`。
4. `cost_t`、`turnover_t` 取自 `costs` 同名列；
   `net_return_t = gross_return_t - cost_t`（NaN 自然传播）。

输出 `pd.DataFrame`，index 同 `weights`，列序
`["gross_return", "cost", "turnover", "net_return"]`。

### 3.4 归因汇总

对 `net` 的每一列做 `sum(skipna=False)`（任一 `NaN` 使总量为 `NaN`）：

- `total_gross = Σ gross_return`
- `total_cost = Σ cost`
- `total_net = Σ net_return`
- `cost_ratio = total_cost / total_gross`，`total_gross == 0` 时为 `NaN`
- `breakeven_bps = total_gross / Σ turnover × 1e4`，`Σ turnover == 0`
  时为 `NaN`（可为负：毛收益为负时没有非负费率能救）

返回冻结 dataclass：

```python
@dataclass(frozen=True)
class AttributionSummary:
    total_gross: float
    total_cost: float
    total_net: float
    cost_ratio: float
    breakeven_bps: float
```

公开面：

```python
__all__ = ["AttributionSummary", "attribution_summary", "net_returns", "trade_cost"]
```

### 3.5 不变量（规范，测试必钉）

1. `turnover ≥ 0`、`cost ≥ 0`、`cumulative_cost` 单调非减。
2. `turnover_t = 0.5 × Σ|w_t - w_{t-1}|`（`w_{-1}=initial_weights` 或 0）。
3. 费率均匀时 `cost_t = turnover_t × (cost_bps/1e4 + impact_t)`；
   逐资产时 `cost_t = 0.5 × Σ|Δw| × rate`。
4. **成本只扣一次**：权重不变的日子 `turnover = cost = 0`，累计成本不增。
5. `net_return = gross_return - cost` 逐日成立（±1e-12；NaN 位置同为 NaN）。
6. **无前视**：改动最后一行的权重或收益，前面所有行的 `gross_return`
   与 `net_return` 逐位不变；`lag=0` 之外权重只向未来生效。
7. 零权重资产的 `NaN` 收益不污染组合；持有资产的 `NaN` 收益必传播。

### 3.6 错误契约

`trade_cost`

| 输入 | 条件 | 异常 |
| --- | --- | --- |
| `weights` | 非 DataFrame | `TypeError` |
| `weights.index` | 非 DatetimeIndex | `TypeError` |
| `weights` | 0 行或 0 列 | `ValueError` |
| `weights.index` | 重复 / 非升序 | `ValueError` |
| `weights.columns` | 重复 / 非字符串 / 空串 | `ValueError` |
| `weights` 值 | 非数值 / 非有限 | `ValueError("weights must be finite numeric")` |
| `cost_bps` | 非实数或 `bool` | `TypeError` |
| `cost_bps` | 非有限 / < 0 | `ValueError` |
| `impact` | 非 DataFrame | `TypeError` |
| `impact` | index/columns 与 `weights` 不全等 | `ValueError` |
| `impact` 值 | 非数值 / 非有限 / < 0 | `ValueError` |
| `initial_weights` | 非 Series | `TypeError` |
| `initial_weights.index` | 与 `weights.columns` 集合不等（或重复） | `ValueError` |
| `initial_weights` 值 | 非数值 / 非有限 | `ValueError` |

`net_returns`

| 输入 | 条件 | 异常 |
| --- | --- | --- |
| 三个表参数 | 任一非 DataFrame | `TypeError` |
| `asset_returns` | index/columns 与 `weights` 不全等 | `ValueError` |
| `costs` | index 与 `weights` 不全等 | `ValueError` |
| `costs` | 缺 `turnover` 或 `cost` 列 | `ValueError` |
| `asset_returns` | 非数值 dtype | `ValueError` |
| `lag` | 非 int 或 `bool` | `TypeError` |
| `lag` | < 0 | `ValueError` |

`attribution_summary`

| 输入 | 条件 | 异常 |
| --- | --- | --- |
| `net` | 非 DataFrame | `TypeError` |
| `net` | 空 / 缺四列之一 | `ValueError` |
| `net` 列 | 非数值 dtype | `ValueError` |

## 4. 手算向量（测试逐条落针）

日期 `d0..d3 = 2024-01-02..05`，资产 `A, B`。

**A 基本换手与成本**（`cost_bps=10`，无初始持仓）

```text
weights: d0 [0.6,0.4]  d1 [0.5,0.5]  d2 [0.5,0.5]  d3 [0.2,0.8]
turnover: [0.5, 0.1, 0, 0.3]
cost:     [0.0005, 0.0001, 0, 0.0003]
cum:      [0.0005, 0.0006, 0.0006, 0.0009]
```

d2 权重不变 ⇒ 成本只扣一次。

**B 初始持仓**（`initial_weights=[0.5,0.5]`，`cost_bps=10`）

```text
weights: d0 [0.5,0.5]  d1 [0.7,0.3]
turnover: [0, 0.2]
cost:     [0, 0.0002]
```

**C 逐资产冲击**（`cost_bps=0` / `cost_bps=10`）

```text
weights: d0 [0.6,0.4]  d1 [0.4,0.6]
impact:  d0 [0.001,0.001]  d1 [0.002,0.004]
turnover: [0.5, 0.2]
cost(bps=0):  [0.0005, 0.0006]
cost(bps=10): [0.001,  0.0008]
```

**D 净收益的 lag**（`cost_bps=10`）

```text
weights: d0 [0.5,0.5]  d1 [0.2,0.8]  d2 [0.2,0.8]
returns: d0 [0.01,0.02]  d1 [0.03,-0.01]  d2 [0,0.02]
costs: turnover [0.5,0.3,0]  cost [0.0005,0.0003,0]

lag=1: gross [0, 0.01, 0.016]
       net   [-0.0005, 0.0097, 0.016]
lag=0: gross [0.015, -0.002, 0.016]
       net   [0.0145, -0.0023, 0.016]
lag=3（行数 2 的面板）: gross 全 0
```

**E 归因**（D 的 lag=1 结果）

```text
total_gross = 0.026
total_cost  = 0.0008
total_net   = 0.0252
cost_ratio  = 2/65 ≈ 0.03076923076923077
Σ turnover  = 0.8
breakeven_bps = 325.0
```

**F 零换手**（`initial_weights` 等于首行，权重不变，`cost_bps=10`）

```text
weights: d0 [0.5,0.5]  d1 [0.5,0.5]
returns: d0 [0.01,0.02]  d1 [0.01,0.02]
lag=1: gross [0, 0.015]  cost [0,0]  net [0,0.015]
total_gross = 0.015, total_cost = 0, cost_ratio = 0,
breakeven_bps = NaN（Σ turnover = 0）
```

**G NaN 传播与零权重屏蔽**

```text
weights: d0 [0.5,0.0]  d1 [0.0,0.5]
returns: d0 [NaN,0.02]  d1 [NaN,0.02]
lag=1: gross [0, NaN]（d1 持有的 B 有收益，d0 持有的 A 缺收益已滚出）
另一面板 weights [0.0,0.5]×2：gross [0, 0.01]（A 零权重，NaN 不污染）
```

**H 带冲击的会计恒等式**

`net_return == gross_return - cost` 逐位成立（D/C 组合各一次）。

**I 空头权重**

```text
weights: d0 [0.5,-0.5]  d1 [0.2,-0.2]（initial 缺省为 0）
turnover: [0.5, 0.3]  cost(bps=10): [0.0005, 0.0003]
```

**J 无前视前缀不变**

- 改 `weights` 最后一行：前面各行的 `gross_return`／`net_return` 逐位不变。
- 改 `asset_returns` 最后一行：前面各行不变。
- `lag=0` 时改最后一行的收益只影响最后一行。

**K 归因负毛收益**：`total_gross < 0` 时 `breakeven_bps` 为负（不钳到 0），
`cost_ratio` 为负值（保持符号，不改绝对值）。

## 5. 变异自证 M1–M6

| 针 | 字节级注入 | 期望红针 |
| --- | --- | --- |
| M1 | `turnover = 0.5 * delta.sum()` 去掉 `0.5` | A／B／C／I |
| M2 | `cost = 0.5 * (delta * rate_vec).sum()` 去掉 `0.5` | A／C／D／E |
| M3 | `prev = zeros` 恒成立（忽略 `initial_weights`） | B／F |
| M4 | `weights.shift(lag)` 改为 `weights.shift(-lag)` | D／E／J |
| M5 | 删去 `fillna(0.0)` | D／E／F |
| M6 | 删去 `effective == 0` 的 NaN 屏蔽 | G |

每条记录实际红针名；比预期宽不算问题，比预期窄须写清原因。还原只从
动手前的内存副本写回，并复校 sha256。

## 6. 验收口径

- `agent/tests/quantlib/test_turnover.py` 覆盖 §4 全部向量与 §3.6 全部
  错误行。
- `tests/quantlib` 全绿（枚数现数）。
- README 七份 Quant Library 徽章：`322` → `326` 函数、`27` → `28` 模块
  （`__all__` 四名：dataclass 一个＋函数三个）；`tests/test_readme_counts.py`
  全绿。
- 变体自证六针真红且模块 sha256 还原。
- 门 A–F 读数现填；恒红门先证本片 0 贡献。
- 档案追加 `### 7.38 G8…`（bytes 层、CRLF），读数现填。

## 7. 已知边界

- `cost_bps` 是常数费率；逐资产差异只能通过 `impact` 表表达。
- `impact` 表由调用方生成：本模块不替调用方决定用 `fixed_slippage`、
  `linear_impact` 还是 `sqrt_impact`，也不做 ADV/波动率取数。
- 成本在换手发生日一次性扣除，不摊销到持有期。
- 收益按逐日简单加总口径归因，不复利、不对数化。
- `lag=0` 会允许同日权重同日生效，这是研究对齐选项，不是无前视保证。
- 不做币种换算、不做现金账户、不做融资/融券利息。
