# G1（第 1 档）设计：筹码因子与三类筹码信号

日期：2026-10-28
状态：已定稿（用户已授权全程自主推进，本 spec 的设计裁定不等待复核）

## 1. 要治的痛

Alpha 库现有因子全部只吃价量、基本面或估值，**没有「持仓成本」这一维**。A 股研究常用的
筹码口径（cyq_perf / cyq_chips）需要 tushare 5000+ 积分；本机 token 的可用性无法在本片
证明（只报存在/长度，不打印值），因此：

- 本片**不调用** `cyq_perf` / `cyq_chips`，也不假装与它们的数值一致；
- 只按**公开定义**自研：`cost_5pct`/`cost_95pct` 公开定义了集中度
  `(cost_95pct − cost_5pct) / (cost_95pct + cost_5pct)`，`winner_rate` 公开定义了获利比例；
- 一行第三方实现代码不搬（许可证路径：只按公开定义自研，2026-10-28 用户裁定）。

缺口因此写成一句话：**一个只吃日线 + 换手率、可手算、可独立对账的筹码成本分布模型，
连同四枚因子与三类信号。**

## 2. 目标 / 非目标

目标：

1. 纯函数引擎 `agent/src/factors/chips.py`：宽表进、宽表出，无 I/O、无网络、无全局状态。
2. 四枚 zoo alpha（`agent/src/factors/zoo/chip/`）：
   `chip_cost_deviation`、`chip_profit_ratio`、`chip_concentration`、
   `chip_concentration_change_20`。
3. 三类信号纯函数（`agent/src/factors/chip_signals.py`）：
   `chip_squeeze_buildup`、`chip_capital_resonance`、`chip_volume_price_divergence`。
4. 数据接线：`val:turnover_rate` 加入 tushare `daily_basic` 白名单（百分数单位）。
5. 验收：手算向量、独立 oracle、前缀不变量、未来污染、变异自证、注册表契约、
   九语言无关（后端无 locale 面）但 alpha 库中文词表必须补齐。

非目标：

- 不新增 API 路由、工具、前端页面；不接实时行情。
- 不引入新依赖（只用 numpy / pandas）。
- 不写死任何「全仓 alpha 总数」；新 alpha 的 id / 文案由注册表现读。
- 不宣称与 cyq_perf 数值一致；不把本模型叫做「官方筹码」。

## 3. 模型定义（冻结）

### 3.1 输入与单位

宽表：`index = trading_date`（DatetimeIndex），`columns = instrument_code`。

- `high`、`low`、`close`：元。
- `turnover_rate`：**百分数**（与 tushare `daily_basic.turnover_rate` 一致，例如 2.35 表示
  2.35%）。引擎入口 `chip_metrics(..., turnover_rate=...)` 明确接收百分数；
  内部换算 `u = clip(turnover_rate / 100, 0, 1)`。
  - 上限 1.0 是「单日最多替换全部流通筹码」的建模上限（换手率可超过 100%，此时截断）。
  - 负数视为非法 bar（NaN 语义，见 3.4）。

### 3.2 每日筹码分布 `D_t`

对每个**合法**交易日：

- 区间 `[lo_t, hi_t] = [low_t, high_t]`；
- 众数 `m_t = (high_t + low_t + close_t) / 3`（典型价），并夹到 `[lo, hi]` 内；
- `D_t` 为三角分布 `Triangular(lo, m, hi)`，总质量 1；
- 单点日（`hi == lo`）：`D_t` 为该价格处的点质量 1。

### 3.3 递归

```
W_t = (1 − u_t) · W_{t−1} + u_t · D_t
W_{−1} = 0                      （空初始状态，显式披露）
```

- 总质量 `M_t = (1 − u_t)·M_{t−1} + u_t`，从 0 起，恒 `≤ 1`；`u≡1` 时当日即达 1。
- 所有对外指标都是**按 M 归一化的比值**（见 3.6），因此空初始状态只影响 `mass` 这一个
  诊断列，不影响位置/离散度/获利比例的含义。
- 不做事后重归一化：`mass` 本身就是「模型已覆盖的筹码比例」，藏起来才是失真。

### 3.4 缺失与非法 bar

以下任一成立即判该 bar 非法：`high`/`low`/`close`/`turnover_rate` 为 NaN；`high < low`；
`low ≤ 0`；`turnover_rate < 0`。

非法 bar：**状态原样保留**（无交易则筹码不动），当日全部输出 NaN，不做任何插值或补零。
下一条合法 bar 用 `u_t` 作用于**保留的状态**。这正是基座 `base.py` 头注允许的
「递归统计跳过缺失观测、从上次状态继续」的一类。

### 3.5 离散化

- 价格阶梯为**绝对整数分**：bin `k` 覆盖半开区间 `[k·tick, (k+1)·tick)`，
  `tick = 0.01` 元；键 `k` 始终表示同一个绝对价格，不随窗口起止而变
  （前缀不变性的构造性保证）。
- 每日 bin 质量 = `F(x_right) − F(x_left)`，`F` 为三角 CDF。
  bin 范围取 `first = floor(lo/tick − 1e-9)`、`last = ceil(hi/tick − 1e-9) − 1`，
  于是 `[first·tick, (last+1)·tick]` 覆盖整个支撑、质量精确加和为 1。
  恰在「分」边界上的点质量落在左侧 bin（`[p−tick, p)`）；因此对分价收盘价，
  累计质量等于连续模型的 `F(close)`，无半 bin 偏差。
- 自适应 tick：若 `(hi − lo) / 0.01 > max_bins_per_day`（默认 2048），当日改用
  `step = ceil((hi − lo) / max_bins_per_day / 0.01)` 个「分」为宽度的 bin；一条
  step-bin 的质量均分到它覆盖的 `step` 个整数分键上（分键仍是绝对价格）。
  该选择只依赖当日自身振幅，不依赖未来。
- 总跨度硬上限 `max_span_bins`（默认 4,000,000 个分键，约 32 MB）：任一标的的
  分键跨度超限即抛 `ValueError`——不静默粗化（粗化会破坏绝对键）。
- `F` 的闭式（`lo < m < hi`）：
  - `x ≤ lo → 0`；`x ≥ hi → 1`；
  - `lo < x ≤ m → (x−lo)² / ((hi−lo)(m−lo))`；
  - `m < x < hi → 1 − (hi−x)² / ((hi−lo)(hi−m))`。
  - `m == lo` / `m == hi` 用对应单边式；`lo == hi` 用阶跃。

### 3.6 指标（全部宽表）

设 `M = Σ_k W[k]`（引擎内部以标量跟踪，与 `W` 加和一致到浮点噪声）。

| 指标 | 定义 | NaN 条件 |
| --- | --- | --- |
| `mass` | `M` | 非法 bar |
| `avg_cost` | 解析式：`Σ_i w_i·(lo_i+hi_i+m_i)/3 / M`，`w_i` 为第 i 个合法日的混合权重（与 `W` 同一递归，标量跟踪） | `M == 0` |
| `cost_deviation` | `(close − avg_cost) / avg_cost` | `M == 0` 或 `avg_cost ≤ 0` |
| `profit_ratio` | 收盘价 `c` 处的混合 CDF 近似：右端点 `≤ c` 的 bin 全量计入，再加上 `c` 所在 bin 的 `frac = c/tick − floor(c/tick)` 比例。分价收盘时 `frac=0`，即 `Σ_{k: (k+1)·tick ≤ c} W[k] / M`（半开 bin 下等价于连续 CDF 在 `c` 处的值） | `M == 0` |
| `concentration` | `(q_hi − q_lo) / (q_hi + q_lo)`，`q_lo = 0.05` 分位、`q_hi = 0.95` 分位（`coverage=0.90`）；分位价格取 bin 中点 `(k+0.5)·tick` | `M == 0` |
| `concentration_change_20` | `concentration_t − concentration_{t−20}`（按行，恰 20 个交易日） | 任一端 NaN |

分位数取**最小 bin** 使累计质量 `≥ q·M`。分位价格用 bin 中点而非边界，误差
≤ 0.5 tick（价格 8–15 元时集中度误差 ≤ 1e-3，实测 4.6e-4）。

`avg_cost` 走解析混合式而非分格加和：分格中点会把「恰在分边界上的点质量」记成
`p − 0.005`，均价与偏离度会带半分系统偏；解析式没有这一项。

### 3.6.1 已知限制

- 收盘价不是整分（如复权价）且当日振幅小于 1 分时，`profit_ratio` 的分箱线性
  近似误差可占该 bin 质量的一大截；原始日线（整分报价）下实测误差 5e-15。
- 筹码成本应按**原始成交价**解释；若面板用前复权价，历史成本水平会随除权缩放。
  本片按面板给什么用什么，不做复权换算（notes 明写）。

`concentration` 沿用公开字段的命名与方向：**值越大 = 成本越分散**；名字里的
「集中度」是公开叫法，文档与 notes 必须同时写明方向，避免误读。

### 3.7 为什么没有未来函数

- 状态递归只依赖 `t` 及以前；
- bin 键是绝对价格，窗口伸缩不改变任何键的含义；
- 自适应 tick 只看当日振幅；
- `concentration_change_20` 只看 `t` 与 `t−20`。

由 `test_chip_engine.py` 的「前缀==全量」与「未来污染」两针实证。

## 4. 三类信号（冻结）

信号输入为**引擎输出的宽表**（`turnover_fraction = turnover_rate / 100`，单独的参数名，
不叫 `turnover_rate`，避免单位混淆）。输出为 float 宽表：命中 1.0 / 未命中 0.0 /
不可判 NaN；背离信号为 −1.0 / +1.0 / 0.0 / NaN。

### 4.1 `chip_squeeze_buildup(concentration, cost_deviation, profit_ratio, *, window=20, deviation_max=0.05, profit_min=0.30, profit_max=0.70)`

```
cond = (concentration_t < concentration_{t−window})
     & (|cost_deviation_t| ≤ deviation_max)
     & (profit_min ≤ profit_ratio_t ≤ profit_max)
输出 = cond ? 1 : 0，且仅当 concentration_t、concentration_{t−window}、
       cost_deviation_t、profit_ratio_t 全部非 NaN
```

语义：成本区间在收敛（分散度下降），价格贴着平均成本，获利盘不过热也不过冷 =
筹码蓄势。

### 4.2 `chip_capital_resonance(turnover_fraction, profit_ratio, cost_deviation, *, window=20, multiple=2.0, profit_min=0.60)`

```
mean_prev = rolling_mean(turnover_fraction, window, min_periods=window).shift(1)
cond = (turnover_fraction_t ≥ multiple × mean_prev)
     & (profit_ratio_t ≥ profit_min)
     & (cost_deviation_t > 0)
输出 = cond ? 1 : 0，且仅当以上全部输入（含 mean_prev）非 NaN
```

语义：放量（≥ 前窗口均值的 `multiple` 倍）且多数持仓已获利、价格在平均成本之上 =
资金与筹码共振。均值不含当日（`shift(1)`），避免当日量把门槛抬高。

### 4.3 `chip_volume_price_divergence(close, high, low, concentration, turnover_fraction, *, window=20, peak_window=60)`

```
rollmax = rolling_max(high, peak_window, min_periods=peak_window)
rollmin = rolling_min(low,  peak_window, min_periods=peak_window)
mean_prev = rolling_mean(turnover_fraction, window, min_periods=window).shift(1)

高位背离 = (close ≥ rollmax) & (turnover_fraction < mean_prev) & (concentration > concentration.shift(window))
低位背离 = (close ≤ rollmin) & (turnover_fraction > mean_prev) & (concentration < concentration.shift(window))

输出 = 高位背离 ? −1 : (低位背离 ? +1 : 0)
```

- 两臂**互斥**：高位臂要求 `turnover < mean_prev`、低位臂要求 `turnover > mean_prev`，
  同一行不可能同时成立（`mean_prev` NaN 时整行被掩码）。退化常量序列
  （`close == rollmax == rollmin`）下由换手比较分臂，测试钉住这一行为；
- 掩码 = 以上全部输入与其窗口（`rollmax`/`rollmin`/`mean_prev`/
  `concentration.shift(window)`）全部非 NaN。

语义：创新高却缩量且筹码发散 = 高位背离（−1）；创新低却放量且筹码收敛 = 低位背离（+1）。

## 5. 数据接线

- `agent/backtest/loaders/valuation_loader.py`：`VALUATION_FIELDS` 追加
  `"turnover_rate"`；头注写明**百分数**单位（与 `dv_ttm` 同类）。
- `load_valuation_panel` 的 tushare 请求天然带出新字段；baostock 回退不含该字段 →
  照既有规则返回全 NaN 帧（不伪造）。
- `_attach_valuation_columns` 的「少于两只股票有数据即 RuntimeError」保持原样：
  没有可用 token 时，bench 路径照既有 `val:` 契约报错，**纯函数验收不依赖它**。
- universe 仅 `equity_cn`（`daily_basic` 是 A 股字段）。
- 既有测试 `agent/tests/factors/test_fundamental_valuation_samples.py` 对白名单元组有
  逐字断言，本片**有意**扩白名单，因此该断言随本片更新为新元组（不是放宽为子集）。

### 5.1 既有守卫与夹具的连带改动（逐条有据，不是放宽）

- `agent/tests/factors/test_alpha_purity.py`：zoo 模块的仓内 import 白名单目前只有
  `src.factors.base`。四枚 alpha 需要 `src.factors.chips`（同样是无 I/O 的纯计算模块），
  白名单改成集合 `{"src.factors.base", "src.factors.chips"}` 并同步头注；
  禁用名与模块级语句规则一字不动。
- `agent/tests/factors/test_missing_bar_fabrication.py`：
  - `_base()` 的价格/基本面字段表**末尾追加** `val:turnover_rate`（追加在最后，
    不移动既有随机抽样顺序），否则全量扫描对 chip alpha 会因缺列抛 `SkipAlpha`；
  - 新增 `CHIP_STATEFUL` 豁免集，仅用于价值 oracle 的 skip 列表，理由：筹码状态是
    #1463 允许的「递归统计跳过缺失观测、从上次状态继续」类，缺口后的值**必然**与
    无缺口运行不同；`concentration_change_20` 的 20 日回看还会在缺口后第 20 行
    重新读到缺口那一格而合法变 NaN。豁免集并入 `test_the_value_oracle_exemptions_are_real_alphas`
    的存在性断言；`test_a_smoother_skips_the_gap` 不为 chip 放宽（该针对连续值的要求
    与 change 的回看 NaN 不相容），chip 的缺口语义由本片自己的测试钉住。
- `agent/tests/factors/test_alpha_library_translations.py` 不动；只补
  `wiki/alpha-library/i18n.zh.json` 的四条 `notes` 与四条 `nicknames` 中文条目。

## 6. 验收判据（写死）

1. **手算向量**（下表全部逐字进测试）：
   - A 单日一点价：`H=L=C=10.00, u=0.5` → `mass=0.5, avg_cost=10.00,
     cost_deviation=0, profit_ratio=1.0, concentration=0`，`change_20=NaN`。
   - B 两日（次日 `u=1.0`、三角 `[9,10,11]`）：`mass=1.0, avg_cost=10.00（|Δ|≤1e-9）,
     cost_deviation=0, profit_ratio=0.5（|Δ|≤1e-9，分价收盘价下 CDF 精确）,
     concentration=0.0685（|Δ|≤2e-3；连续解 `(q95−q05)/20 = 0.06838…`，
     分格中点造成 +1.2e-4）`。
   - C 跨缺失 bar（D0 一点价 10, u=0.5；D1 全 NaN；D2 一点价 12, u=0.5）：
     D1 全 NaN 且状态不变；D2 `mass=0.75, avg_cost=11.333…（|Δ|≤1e-9）,
     cost_deviation=0.0588235…（|Δ|≤1e-9）, profit_ratio=1.0,
     concentration=0.09095（|Δ|≤1e-3；两个点质量分别在 9.995/11.995 的中点）`。
   - D 常量序列（三角 `[9,10,11]`、`u=1.0` 连续 22 日）：第 21 行（0 基 20）
     `concentration_change_20=0`；第 20 行（0 基 19）=NaN。
   - E 自适应 step：单日 `[10,40]`、close 20（于是 mode=(10+40+20)/3=23.333…）、
     `u=1.0`、`max_bins_per_day=100`（强制 step=30 分）→ `mass=1.0`、
     `profit_ratio=0.25005`（|Δ|≤1e-9；手推：收盘所在 bin 覆盖 `[19.8,20.1)`，
     均分后 `profit = CDF(19.8) + (2/3)(CDF(20.1)−CDF(19.8)) = (0.2401+2×0.255025)/3`；
     连续解 0.25，粗 step 引入 +5e-5）、`avg_cost=24.4444…`、`cost_deviation=−0.1818…`、
     `concentration=0.4149151`（|Δ|≤2e-3；连续解 0.414943，粗 step 引入 −2.8e-5）。
2. **独立 oracle**：解析混合口径（按日权重 `w_i = u_i ∏_{i<j≤t}(1−u_j)`、连续三角 CDF
   与二分位点，不建价格格）对 60 日**整分报价**合成面板逐日对账；容差
   `mass ≤ 1e-12`、`avg_cost ≤ 1e-9`、`profit_ratio ≤ 1e-9`、
   `concentration ≤ 2e-3`（价格带 8–15 元，tick 恒 0.01）。
3. **前缀==全量**：120 日 × 3 列，前 80 行与全长逐值 `atol=1e-12`。
4. **未来污染**：第 61 行起把高低收改成极端值、换手改成随机值，前 60 行逐值不变
   （`atol=1e-12`）。
5. **变异自证**（每条注入后测试必须真红，再按动手前的内存副本还原）：
   M1 `(1−u)`→`(1+u)`；M2 换手率前移一日；M3 `cost_deviation` 取负；
   M4 分位 `0.05/0.95`→`0.01/0.99`；M5 缺失 bar 重置状态。
6. **注册表契约**：四枚 alpha 被自动发现、id 合法、元数据字段齐全；面板缺
   `val:turnover_rate` 时 `Registry.compute` 抛 `SkipAlpha`；任一依赖 NaN 的行被
   registry 掩成 NaN；因子输出与引擎直算逐值相等。
7. **中文词表**：`wiki/alpha-library/i18n.zh.json` 为四枚新 alpha 的 `nickname` 与
   `notes` 补齐 `en == 注册表原文` 的 `zh` 译文；`test_alpha_library_translations.py` 绿。
8. **门禁**：factors 测试套件、注册表套件、后端全量套件的本片新增红为 0；恒红门先证
   「本片 0 贡献」再报告，不调阈值、不修门、不清白名单。
9. **许可证/出处**：notes 与档案写明「按公开定义自研、未搬第三方代码、不调用 cyq_* 端点」。

## 7. 风险与限制（明写，不藏）

- 三角分布与「典型价作众数」是公开的常见建模假设，不是唯一口径；换手率若来自不同
  流通口径，质量收敛速度会变。
- 空初始状态使早期 `mass < 1`；所有指标是比值，故位置/离散度/获利比例不受缩放影响，
  `mass` 单独暴露供自查。
- 离散化误差 ≤ 0.5 tick；单日振幅超过 20.47 元时当日 tick 自适应变粗。
- 缺失 bar「状态不动」是建模（无交易即筹码不动），不是数据修补。
- `turnover_rate` 为百分数，zoo 适配层统一 `/100`；信号层参数名用
  `turnover_fraction` 防错。

## 8. 「Bar Replay 五步自查」的后端等价物

本片是后端纯函数，没有前端图表，故按同一精神给出五步等价证据：

1. **只用已收盘数据**：每个 `t` 的状态只含 `≤ t` 的合法 bar；第 3.7 节三条 + 判据 3/4。
2. **信号不重绘**：前缀==全量 ⇒ 任何时刻截断重算，历史行不变。
3. **窗口不越界**：`rolling(min_periods=window)` 与 `shift(window)` 均为严格满窗。
4. **自喂检查**：`mean_prev` 显式 `shift(1)`，当日换手不进门槛。
5. **变异可证**：判据 5 的五条注入全部真红。

## 9. 执行期偏差（2026-10-28，冻结后追加）

判据 7 与 9 的原写法要求四枚 alpha 带 `notes`/`nickname` 并在
`wiki/alpha-library/i18n.zh.json` 补中文条目。执行时实测该文件与
`test_alpha_library_translations.py` 同属上游所有（`git ls-tree upstream/main`
在册），而 `tools/test_wiki_drift.py::test_no_fork_commit_touches_an_upstream_owned_file`
禁止 fork 提交改动 `wiki/**`——两者不可同时满足。裁定：

- 四枚 alpha 的 `notes` 与 `nickname` 留空（注册表 482 枚中 271 枚无 notes、
  345 枚无 nickname，属既有合法形态），`wiki/alpha-library/i18n.zh.json`
  保持上游字节不变；
- 出处与方向说明（「按公开定义自研、未搬第三方代码、不调用 cyq_* 端点」、
  集中度是 dispersion 方向）移入 `agent/src/factors/zoo/chip/` 的模块 docstring，
  由 `test_chip_registry.py::test_zoo_docstring_records_provenance` 钉住；
- 判据 7 的实质（不能出现「有英文无中文」的漂移）仍由既有
  `test_alpha_library_translations.py` 保证：新 alpha 不带文本，故无待译项；
- 代价：alpha 库页面这四枚不显示中文 notes/nickname。若要补，须等上游把该表
  移出 `wiki/**` 或提供 fork 覆盖机制，不能在本片以改门或改白名单解决。
