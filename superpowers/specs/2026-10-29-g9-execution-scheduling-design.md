# G9（tier 3）设计：参与率上限下的执行排程

日期：2026-10-29
路线图：`superpowers/plans/2026-10-29-tier3-signal-to-execution-roadmap.md` §3
前置：G7 `superpowers/specs/2026-10-29-g7-portfolio-construction-design.md`、
G8 `superpowers/specs/2026-10-29-g8-turnover-cost-design.md`

## 1. 要治的痛

G7 给出目标权重，G8 给这次换手记上成本，但两者都只回答「换多少、花多少」，
不回答「怎么换得出去」。`impact.py` 自陈没有交易轨迹：它给单笔订单定价，
却没有任何函数把「当前持仓 → 目标持仓」的差额切成若干天的可执行切片。
于是最常见的实现错误是：假定差额一天成交，忽略参与率；或者在参与率触顶时
静默截断，把未完成的部分当成不存在。

本模块只做一件事：给定一次调仓的快照（目标、当前、每名资产的日均成交量）
与参与率上限，输出逐日的成交切片；没有做完的部分如实报告，不静默丢弃。

## 2. 目标 / 非目标

**目标**

- `schedule_trades(target, current, *, adv, max_participation=0.1,
  max_days=5, lot_size=None) -> ExecutionPlan`。
- 逐名独立切片：每日每名的成交绝对值 ≤ `max_participation × adv`。
- 确定性：不随机、不依赖输入 Series 的排列顺序；同一输入两次运行逐位相等。
- 残差如实报告：`residual`（目标 − 当前 − 已成交）、`days_used`（逐名用掉
  的天数）、`unfilled`（整手可交易但未在期限内完成的部分）、
  `lot_residual`（不足一手的残差）。
- 可选整手取整（`lot_size`），取整残差单独报告。
- 计划可复算：`trades` 的每一行、每一列都由输入唯一确定。

**非目标**

- 不连接券商、不读实时盘口、不下单；不产生任何 I/O、时钟或环境依赖。
- 不建模盘中价格路径、冲击成本或机会成本（那是 `impact.py` 与 G8 的输入）。
- 不做跨资产现金约束、组合层排队或优化（每名资产独立切片）。
- 不做多日 ADV 面板：`adv` 是每名资产一个常数（日均成交量）。
- 不引入第三方依赖；不注册 `quantlib_tool.ALLOWED_MODULES`。

## 3. 定义（冻结）

### 3.1 输入

`target`、`current`

- `pd.Series`，index 为非空字符串标签（唯一、非空），值为有限实数。
- 两者的标签集合必须相等；按标签对齐，不看输入顺序。
- **单位**：两者与 `adv`、`lot_size` 必须使用同一单位（例如「股」或
  「名义金额」）。若调用方持有的是组合权重（0.5 = 50%），需先把 ADV 换算
  成同一单位再传入：`adv_weight_units = adv_notional / nav`。
- 允许负值（空头/负持仓）；本模块只做带符号的算术，不限制市场制度。

`adv`

- `pd.Series`，标签集合与 `target` 相等，值为有限非负数。
- 语义：该资产的日均成交量（与 `target` 同单位）。`0` 合法，表示不可交易。

`max_participation`

- 实数标量，`0 < p ≤ 1`，拒绝 `bool`。缺省 `0.1`。
- 语义：每日每名资产的成交量上限为 `p × adv`。

`max_days`

- `int`（拒绝 `bool`），`≥ 1`，缺省 `5`。
- 语义：计划最多跨越的交易日数；到期未完成的部分进 `residual`。

`lot_size`

- `None`、正整数（拒绝 `bool`），或 `pd.Series`：标签集合与 `target`
  相等、每个值为正整数。
- 语义：一手对应的单位数；每日成交量向下取整到手的整数倍。`None` 表示
  不取整（连续单位）。

### 3.2 排程算法（唯一规范描述）

1. `labels = sorted(target.index)`（字典序）；所有序列按 `labels` 重排。
2. `delta = target − current`；`cap = max_participation × adv`。
3. `remaining = delta`；从第 1 天到第 `max_days` 天，逐名执行：
   - `room = min(|remaining|, cap)`；
   - 有 `lot_size` 时 `room = floor(room / lot) × lot`；
   - `trade = sign(remaining) × room`；`remaining -= trade`。
4. 若某天所有资产的 `trade` 都为 0（没有剩余、cap 为 0、或剩余不足一手），
   停止并**不记录该空行**。
5. `trades` 的行号从 1 开始，最多 `max_days` 行、最多到最后一个有成交的
   行为止；columns 为 `labels`。
6. `residual = remaining`。
7. 有 `lot_size` 时
   `lot_residual = sign(residual) × fmod(|residual|, lot)`，
   否则 `lot_residual = 0`；`unfilled = residual − lot_residual`。
8. `days_used[a] = trades[a] 中非零行的个数`。

等价形式：无整手限制时，每名资产的成交天数 =
`min(max_days, ceil(|delta| / cap))`（`cap = 0` 时为 0），
最后一天只成交剩余的部分。

**残差分解语义**：`lot_residual` 是不足一手、任何整手成交都无法消除的部分
（`|lot_residual| < lot`）；`unfilled` 是整手可交易但受 `max_days` 或
`cap = 0` 限制未完成的部分。无 `lot_size` 时 `unfilled == residual`。

### 3.3 输出

冻结 dataclass：

```python
@dataclass(frozen=True)
class ExecutionPlan:
    trades: pd.DataFrame      # 行 1..H，columns 为排序后的资产名，float
    residual: pd.Series       # 逐名：target - current - Σ trades，float
    unfilled: pd.Series       # 逐名：整手可交易但未完成的部分，float
    lot_residual: pd.Series   # 逐名：不足一手的残差，float
    days_used: pd.Series      # 逐名：有成交的天数，int64
```

- `trades.index` 为 `RangeIndex(1, H+1)`；`H = max(days_used)`，全无成交时
  `H = 0`（0 行、columns 仍为 `labels`）。
- 四个 Series 的 index 均为 `labels`。
- 每一行 `trades` 至少有一个非零值（空行已在算法第 4 步截掉）。

公开面：

```python
__all__ = ["ExecutionPlan", "schedule_trades"]
```

### 3.4 不变量（规范，测试必钉）

1. **参与率**：`|trades.loc[t, a]| ≤ max_participation × adv[a]`（±1e-12）。
2. **方向**：`sign(trades.loc[t, a]) ∈ {sign(delta[a]), 0}`；不会反向交易。
3. **整手**：有 `lot_size` 时每笔成交都是 `lot_size[a]` 的整数倍。
4. **守恒**：`Σ_t trades[t, a] + residual[a] = target[a] − current[a]`
   （±1e-12）。
5. **分解**：`unfilled[a] + lot_residual[a] = residual[a]`（±1e-12）；
   有 `lot_size` 时 `|lot_residual[a]| < lot_size[a]`。
6. **天数**：`1 ≤ days_used[a] ≤ max_days`（有成交时），
   `days_used[a] = count(trades[a] != 0)`，`H = max(days_used)`。
7. **无静默截断**：`max_days` 触顶时 `residual != 0` 且 `unfilled != 0`
   （整手残差单独进 `lot_residual`）。
8. **确定性**：同一输入两次运行，五个字段逐位相等（`.equals`）。
9. **输入不变**：函数返回后 `target`、`current`、`adv`、`lot_size` 均不被修改。
10. **顺序无关**：`target`/`current`/`adv`/`lot_size` 的 Series 排列顺序改变，
    计划逐位不变（columns 恒为字典序）。
11. **纯函数**：不读时钟、环境变量、文件；模块源码无 `import os`、
    `import time`、`open(`、`random`。

### 3.5 错误契约

`target` / `current`

| 条件 | 异常 |
| --- | --- |
| 非 `pd.Series` | `TypeError` |
| index 为空 | `ValueError` |
| index 重复 | `ValueError` |
| index 含非字符串或空串 | `ValueError` |
| 值非数值 / 非有限 | `ValueError` |
| 两者标签集合不相等 | `ValueError` |

`adv`

| 条件 | 异常 |
| --- | --- |
| 非 `pd.Series` | `TypeError` |
| 标签集合与 `target` 不相等 | `ValueError` |
| 标签重复 | `ValueError` |
| 值非数值 / 非有限 / 为负 | `ValueError` |

`max_participation`

| 条件 | 异常 |
| --- | --- |
| 非实数或 `bool` | `TypeError` |
| 非有限 / `≤ 0` / `> 1` | `ValueError` |

`max_days`

| 条件 | 异常 |
| --- | --- |
| 非 `int` 或 `bool` | `TypeError` |
| `< 1` | `ValueError` |

`lot_size`

| 条件 | 异常 |
| --- | --- |
| 非 `None` / 非整数标量 / 非 `pd.Series` | `TypeError` |
| `bool` | `TypeError` |
| 整数标量 `≤ 0` | `ValueError` |
| Series 标签集合与 `target` 不相等 / 重复 | `ValueError` |
| Series 值非整数或 `bool` | `TypeError` |
| Series 值 `≤ 0` | `ValueError` |

## 4. 手算向量（测试逐条落针）

所有向量使用 `max_participation=0.1`（除特别注明）与字典序资产 `A, B, C`。

**A 基本切片**

```text
target  A 1000  B -400  C 0
current A  100  B    0  C 50
adv     A 4000  B 2000  C 1000   → cap A 400  B 200  C 100
max_days=5，无整手

day 1: A 400   B -200  C -50
day 2: A 400   B -200  C   0
day 3: A 100   B    0  C   0
residual [0,0,0]  unfilled [0,0,0]  lot_residual [0,0,0]
days_used A 3  B 2  C 1   H=3
```

**B 期限触顶**

```text
target A 1000  current A 0  adv A 3000 → cap 300  max_days=2
day 1: 300   day 2: 300
residual 400  unfilled 400  lot_residual 0  days_used 2  H=2
```

**C 末日部分成交**

```text
target A 750  current A 0  adv A 3000 → cap 300  max_days=5
day 1: 300   day 2: 300   day 3: 150
residual 0  days_used 3  H=3
```

**D 整手取整与不足一手残差**

```text
target A 950  current A 0  adv A 4000 → cap 400  lot 100  max_days=5
day 1: 400   day 2: 400   day 3: 100（floor(150/100)×100）
remaining 50 < 100 → 第 4 天无可成交，计划停在 H=3
residual 50  unfilled 0  lot_residual 50  days_used 3
```

**E 整手 + 期限触顶**

```text
同 D，但 max_days=2：day 1/2 各 400，剩余 150
residual 150  unfilled 100  lot_residual 50  days_used 2  H=2
```

**F 差额不足一手**

```text
target A 30  current A 0  adv A 1000 → cap 100  lot 100  max_days=5
无任何成交：floor(30/100)×100 = 0
H=0  residual 30  unfilled 0  lot_residual 30  days_used 0
```

**G adv 为 0（停牌）**

```text
target A 250  current A 0  adv A 0  max_days=5
无成交：H=0  residual 250  unfilled 250  lot_residual 0  days_used 0
```

**H 空头回补（带符号）**

```text
target A -500  current A 200  adv A 3000 → cap 300  max_days=5
day 1: -300   day 2: -300   day 3: -100
residual 0  days_used 3  H=3
```

**I 逐名整手（Series）**

```text
target A 450  B -400   current A 0  B 0
adv A 4000  B 3000 → cap A 400  B 300
lot A 100  B 200  max_days=5

A: day 1 成交 400，剩 50（不足一手）→ days_used 1
B: day 1 成交 -200（floor(300/200)=1），day 2 成交 -200 → days_used 2
trades: day 1 [400, -200]   day 2 [0, -200]
residual [50, 0]  unfilled [0, 0]  lot_residual [50, 0]  H=2
```

**J 标签对齐与顺序无关**

`target` 的 index 为 `["B","A"]`、`current` 为 `["A","B"]`、`adv` 为
`["B","A"]`，数值与 A 相同 → 输出与 A 逐位相等，columns 为 `["A","B"]`。

**K 不变量总检**

对 A 的计划逐条核：参与率、方向、守恒、分解、天数、每行至少一个非零。

**L 无需调仓**

`target == current` → `trades` 为 0 行、`residual`/`unfilled`/`lot_residual`
全 0、`days_used` 全 0、columns 仍为 `labels`。

**M 决定性与纯度**

同输入两跑 `trades.equals` 与四个 Series `.equals` 全真；输入四件前后
`.equals` 不变；模块源码不含 I/O/时钟/随机符号。

## 5. 变异自证 M1–M6

| 针 | 字节级注入 | 期望红针 |
| --- | --- | --- |
| M1 | `room = min(abs(rem), caps[i])` 改为 `room = abs(rem)`（去掉上限） | A／B／C／D／E／H／I |
| M2 | `caps = max_participation * adv_values` 改为 `max_participation * np.ones(...)` | A／B／C／D／E／H／I |
| M3 | `for _ in range(max_days)` 改为 `while True` 并不设期限 | B／E |
| M4 | `room = math.floor(room / lots[i]) * lots[i]` 改为 `math.ceil(...)` | D／E／F／I（及 K 的参与率） |
| M5 | `unfilled = residual - lot_residual` 改为 `unfilled = residual.copy()` | D／E／F |
| M6 | 三处 `.reindex(labels)` 删除（按输入原序取数） | J（及错位向量） |

每条记录实际红针名；比预期宽不算问题，比预期窄须写清原因。还原只从
动手前的内存副本写回，并复校 sha256 与 `git diff` 为空。

## 6. 验收口径

- `agent/tests/quantlib/test_execution.py` 覆盖 §4 全部向量与 §3.5 全部
  错误行。
- `tests/quantlib` 全绿（枚数现数）。
- README 七份 Quant Library 徽章：`326` → `328` 函数、`28` → `29` 模块
  （`__all__` 两名：dataclass 一个＋函数一个）；`tests/test_readme_counts.py`
  全绿。
- 变异自证六针真红且模块 sha256 还原。
- 门 A–F 读数现填；恒红门先证本片 0 贡献。
- 档案追加 `### 7.39 G9…`（bytes 层、CRLF），读数现填。
- 推送后 CI 九腿读数回填本片 plan 的「执行期偏差」。

## 7. 已知边界与路线图解释

- **输入形态**：路线图 §4 说「G8/G9 都以任意权重宽表为输入」。G9 的执行
  对象是**一次调仓快照**，逐日排程天然没有「多个日期行」的语义；本片把
  它冻结为「每名资产一个值的 Series」，宽表调用方取一行即可
  （`panel.loc[date]`）。G8 仍消费完整宽表。这是对路线图的窄化解释，
  不改变「不与 G7 import 耦合」的承诺。
- **单位**：本模块不对「股 / 权重 / 名义金额」做换算，四个输入必须同单位。
  权重调用方传 `adv_notional / nav` 即可；这是路线图签名没有 `nav` 参数
  时的唯一自洽做法。
- **整手**：`lot_size` 只接受正整数；小数手数不在本片范围。向下取整，
  不足一手的部分进 `lot_residual`。
- **ADV**：常数日均量，不做日内曲线或逐日 ADV 面板。
- **跨资产**：逐名独立，不做现金约束、卖出先行集合竞价或组合层排队。
- **不做**：盘中价格路径、冲击成本、机会成本、撤单/改单、券商接口。
