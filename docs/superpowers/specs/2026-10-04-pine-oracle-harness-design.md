# Pine 引擎正确性护栏设计（前缀不变式 ＋ 跨实现数值 oracle）

**日期：** 2026-10-04　**分支：** `feat/pine-oracle-harness`（基座 `518d793f` = `main`）
**批准人：** 用户（chat 内「方案通过」，含 §9 两项裁定）
**测量坐标：** 本文所有行号/ sha/ 计数在 `@2a50023d`（`sync/upstream-2026-10` 末梢）实测；`frontend/` 整树在该坐标与 `main` 逐字节相同（`git diff --quiet main sync/upstream-2026-10 -- frontend/` 返回真，`pineTa.ts` blob 两侧同为 `d1105d1961679369509c0d653daa6db862c837b6`），故行号对本分支同样成立。

## 1. 目标与非目标

**目标。** 给自研 Pine 引擎装两道**会红**的门，把「指标算得对」从口头判断变成机器判据：

- **判据一（无未来函数）**：对同一脚本，引擎在 `bars[:N]` 上算出的值序列，必须与在完整序列上算出的前 `N` 项逐位相等。这就是「信号不重绘」的定义式，且比人眼逐根回放更强——它遍历所有 `N`。
- **判据二（跨实现对账）**：同一批 bar、同一套参数，引擎值必须与一套**独立编写的 numpy 参考实现**在给定容差内相等；参考实现自己再被**可手算的闭式点值**与**外部公布值**钉住。

**非目标（本轮明确不做）。**

- 不做 Bar Replay 交互控件（用户裁定：判据＋机制＋首批函数优先）。
- 不引入 `ta-lib` / `pandas-ta` / `MyTT` 为运行时依赖（本机 `talib` 编译是已知坑；用户「改动严格限定在项目范围内」）。
- 不碰真实 A 股行情数据（会把上游同步轮 §6 的口径问题——`frame_caliber` / `additive_conversion`——拖进本轮，范围即散）。
- 不改 `项目档案.md` 之外的任何 README 文档面，不碰 `UPSTREAM_OWNED` 四前缀。

## 2. 现状：本轮建立在其上的既有事实（逐条实测）

| 事实 | 坐标 | 对本设计的意义 |
|---|---|---|
| `runPine(src: string, bars: PineBars, opts?: PineRunOptions): PineResult` | `frontend/src/lib/pineRuntime.ts:2376` | 纯函数、bar 数组入参 ⇒ 切片即得前缀判据，无需改引擎 |
| `PineRunOptions = { params, opLimit, strict, lowerBars }` | `pineRuntime.ts:176-189` | `lowerBars` 是 MTF 类输出的豁免来源 |
| `this.tick = estimateTick(bars)`；`OrderSim(bars, this.tick, …)`——tick 从**传进来的那条序列**估（定义 `pineOrders.ts:86-96`，扫描上限 `Math.min(bars.list.length, 500)` 在 `:88`） | 调用点 `pineRuntime.ts:344`；定义 `pineOrders.ts:86-96` | 切片改变 tick ⇒ 价格档相关输出**合法地**变，必须分类豁免。首批每份夹具 120 根 bar < 500，故切片长度就是扫描长度，豁免理由在夹具上真实成立 |
| `PineBars = { list, open, high, low, close, volume, time }`，`toBars(list)` | `pineTypes.ts:308-328` | fixture 的列定义照此 |
| `PineResult.lines[i] = { name, values: number[], style, offset }` | `pineTypes.ts:122-132`、`:284` | `values` 就是可比对序列；`na` 表示为 `NaN` |
| `compilePine(code, bars, opts)`，`artifact()/produced()/lastPlotted()` helper | `pineScript.ts:177`；`__tests__/pineBuiltins.test.ts:90/96/103`，`makeBars` 在 `:64` | 新门沿用同一读取姿势，不发明第二套 harness |
| `ta.*` 分派表 **74** 个函数 | `pineTa.ts`，`^  <name>: (args` 计数实测 74 | 覆盖全集；本轮首批 12（其中 11 个进判据二）|
| 12 个被测函数的表位置 | sma`:267` ema`:269` rma`:271` stdev`:457` atr`:542` rsi`:547` stoch`:596` macd`:622` bb`:635` supertrend`:674` sar`:716` vwap`:960` | 参考实现的语义以这些行为准绳（读它，不猜它） |
| 已有闭式点值断言的先例 | `pineBuiltins.test.ts:18`（percentrank）`:35`（linreg）`:48`（percentile_nearest_rank） | 「手算值 + `toBeCloseTo(x, 10)`」是本仓既有写法 |
| TradingView 官方 Supertrend 脚本已入仓并带方向语义注释 | `__tests__/pineRealWorld.test.ts:65`、`:238`、`:258` | 判据二的外部锚点，白捡 |
| 语料 harness 自我声明「**NOT a gate**」，语料缺失时整组 skip | `__tests__/pineCorpusReport.test.ts` 注释块 + `:27-28` | 「不真空通过」纪律有先例；但 oracle fixture 进 git，缺失**必须 fail 不许 skip** |
| 上游 vitest 收集面 | 根 `pyproject.toml` 无关；`frontend/vitest.config.ts` `include: ["src/**/__tests__/**/*.test.{ts,tsx}"]`，`.github/workflows/test.yml` 跑 vitest | 新增测试文件自动进 CI，**零上游文件改动** |
| Python 侧收集面 | 根 `pyproject.toml:276-277` `testpaths=["agent/tests"]` `pythonpath=["agent"]` | `agent/pine_oracle/` 可直接 `import pine_oracle.x`，不必改配置 |
| fork 自有工作流的 Python 收集面 | `.github/workflows/repowiki-freshness.yml:85`（且 `:65-67` 只装 pytest） | 该工作流**没有 numpy** ⇒ provenance 门只挂全量套件，不挂这条面 |
| `frontend/.gitignore:9-10` 只点名 `corpus/`、`corpus-v6/` | 实测 | 新建 `__fixtures__/pine_oracle/` 默认可入库 |
| 本机 `core.autocrlf=true`；Git-for-Windows `sed` 会无条件剥掉 CRLF 的行尾 CR | 已入账机器事实（R-46） | ⇒ sha 必须显式定义在「LF 归一后的字节」上，而不是靠偶然 |
| numpy 2.4.6 / CPython 3.11.9；`npm run test:run` = `vitest run` | 实测 | 版本与命令原文 |

## 3. 架构

四个新单元，各自单一职责、可独立理解与测试：

| 单元 | 位置 | 只做一件事 | 依赖 |
|---|---|---|---|
| **schema** | `agent/pine_oracle/schema.py` | fixture 的列名、`na` 编码、换行归一、sha256 计算、容差档位、豁免分类这些**契约常量与编解码** | stdlib |
| **bar 生成器** | `agent/pine_oracle/bars.py` | 整数 LCG → 三组形态（单调/震荡/含跳空）日线 ＋ 一组日内线，写出 `bars_*.csv` | stdlib（不依赖 numpy，保证任何机器可重现） |
| **参考实现** | `agent/pine_oracle/reference.py` | 11 个 `ta.*` 的纯 numpy 独立实现（首批入选 12 个，`sar` 依 R-C 不进对账，见 §11 更正三），输入 6 个 `float64` 数组，输出 `dict[str, np.ndarray]` | numpy |
| **生成器 CLI** | `agent/pine_oracle/emit_fixtures.py` | bars × reference → 写 CSV + `manifest.json`（每函数容差档、豁免类、sha256、生成坐标） | stdlib + 上述三个 |

两道门：

- **JS 门**（vitest，被上游 `test.yml` 自动收集，**运行时零 Python**）
  - `frontend/src/lib/__tests__/pinePrefixInvariance.test.ts` — 判据一
  - `frontend/src/lib/__tests__/pineTaOracle.test.ts` — 判据二（引擎值 vs `manifest` 声明容差下的 fixture 参考值）
- **Python 门**（`agent/tests/pine_oracle/`）
  - `test_pine_oracle_provenance.py` — 参考实现重算 ⇒ 与已提交 fixture **逐字节相同**（防人手改 CSV 当真值）
  - `test_pine_oracle_authoritative.py` — 参考实现自己 vs 闭式点值/外部公布值（这是 D 双重正证的第二重）

**信任链（本设计的核心，必须写清）**：JS 门信 fixture；fixture 的可信度来自 Python 的确定性重算（有人改 CSV 即红）；参考实现的可信度来自闭式点值与外部锚（参考实现自己算错即红）。任何一环都不许用「引擎也这么算」当证据。

## 4. 判据一：前缀不变式

```
对 bars 长度 L 与每个 N ∈ {16, 24, 32, …, L}：
  runPine(src, bars[:N]) 的每条 line.values，必须与 runPine(src, bars)[:N] 逐位相等
```

- `NaN` 与 `NaN` 视为相等（warm-up 段的 `na` 也必须对位，否则「前缀期偷偷出数」逃过判据）。
- 输出序列按 line 的 `name` 对齐，不按序号——`plot()` 数量随脚本分支变化，序号对齐会假绿。

**豁免分类（写进 `manifest.json` 的 `exemption` 键，逐 line 归类，默认 `strict`）：**

| 类 | 允许什么 | 允许理由（须引用 §2 坐标） |
|---|---|---|
| `strict` | 什么都不允许，必须逐位等 | 默认。首批 12 个函数的所有 line 全部先按 `strict` 要求 |
| `tick_guarded` | 价格档相关输出可不同——**不保证只落在末棒**：tick 是每次 run 的一个标量，切片改变它就可能改动切片内任意一根的取整（执行期实测：定义 `pineOrders.ts:86-96`，扫描上限 `Math.min(len, 500)` 在 `:88`，调用点 `pineRuntime.ts:344`） | 切片改变 tick ⇒ 价格档相关输出**合法地**变；真启用本档前必须先量出受影响下标集，不许拿「末棒」当默认形状；只给 `strategy.*`/价格档相关输出 |
| `mtf_guarded` | 末棒的 HTF 聚合可不同，带宽 = 1 个 HTF 周期 | `PineRunOptions.lowerBars`（`:188`）与部分成交 HTF 棒；**首批无函数使用，但 schema 先占位**，避免日后现编 |

分类结果本身要守卫：`test_pine_oracle_provenance.py` 断言「判据二 18 条 line 全是 `strict`」，任何未来把函数挪出 `strict` 的改动都必须同时改这条断言——挪档要留痕，不许静默。

## 5. 判据二：跨实现对账与容差

- **bar 由 fixture 提供，JS 侧绝不重新生成。** 浮点在 JS/Python 里的运算次序一旦不同，bar 本身就差最后一位，对账立刻失去意义。故 `bars_*.csv` 是唯一真相。
- 数值列一律用 Python `repr(float)`（最短可往返十进制）写出；JS 用 `Number()` 解析。往返性由 provenance 测试实测断言。
- `na` 编码 = **空字段**（`manifest.json` 里 `na_encoding: "empty"`）；不许出现 `NaN`/`nan`/`NULL` 字面量混写——两侧对空值的不同表示是本项目最典型的静默假绿来源。
- **sha256 定义在「LF 归一后的字节」上**：`sha256(content.replace(b"\r\n", b"\n"))`。显式归一而非偶然归一（§2 R-46）。
- 容差**分档、每函数在 manifest 里各定一档，只准调严不准放宽**（沿用 `WIKI_STALE_MAX` 那条纪律）：
  - `exact` = 0（排名/计数/整型类：`supertrend` 的 `direction` 取 ±1）
  - `tight` = 1e-12（一次成型类：`sma`、`stdev` 的两个分支、`bb` 的三条线）
  - `loose` = 1e-9（迭代累积类：`ema` `rma` `rsi` `atr` `macd` `stoch` `supertrend` `vwap`）
  - 参照系：上一轮 calibers 用 `REL_TOL = 1e-10`（`agent/tests/test_upstream_sync_calibers.py:65`），实测余量 9.6×——本轮按函数分档而非再套一个万能数。

## 6. 首批 12 个函数与各自要守住的「已知分歧陷阱」

选这 12 个是因为它们是**语义分歧的高发地**，判据能真抓到 bug，而不是刷绿。`pineTa.ts` 行号见 §2。

| 函数 | 陷阱（参考实现与引擎必须在同一侧才算对账） | 点值锚 |
|---|---|---|
| `sma` | warm-up：`bar_index < n-1` 为 `na`，不是 0 | 手算 |
| `ema` | **Pine/TV 从首棒出数、`prev = src[0]` 播种**（`pineTa.ts:134-145`），与 TA-Lib 的「SMA 播种 + 前 n-1 根 na」是两套约定；参考实现若照 TA-Lib 约定写，warm-up 段整段错位而尾部看起来收敛 | 手算 `[1..5],n=3` → 1, 1.5, 2.25, 3.125, 4.0625（α=0.5 从 src[0]=1 起） |
| `rma` | Wilder：`alpha=1/n`，**与 `ema` 不同侧**——引擎的 rma 走 `full(st,n)` 门控，首值在 `n-1` 处以 SMA 播种（`pineTa.ts:147-170`）。同一引擎内两条不同的播种约定，用一条统一规则写参考实现必错 | 手算 `[1..5],n=3` → na,na, 2, 8/3, 31/9 |
| `stdev` | **Pine 的 `ta.stdev` 默认 `biased=true` = 总体标准差（ddof=0）**（`pineTa.ts:186-199`，第三参 `biased` 默认 1）。 folklore 常说「Pine 用样本」，照它写参考实现即错；`ta.stdev(x,n,false)` 才是样本。两条线都要对账，把这条分歧钉成证据而不是传言。另注：`ta.dev`/`ta.deviation` 是**平均绝对偏差**，不是样本标准差 | 总体 `[3,4,5]` = 0.816496580927726；样本 = 1；两侧各按各自档位落点 |
| `rsi` | `rma` 之上的 change/na 语义；`dn==0` → **`up==0` 时 50，否则 100**（`pineTa.ts:554-555`），`up==0` 且 `dn!=0` 由公式自然给 0；warm-up 首值在**下标 n-1**——`changeStep` 在 bar 0 给 NA（`:226-230`），但 `:551-552` 把 NA 折成 `0` 喂进两路 rma，于是 Wilder 播种窗里含这个 0（设计初稿记成「下标 n」，见 §11 更正四） | `[1..5],n=3` → na,na,100,100,100（参考实现 2026-10-04 实跑读数） |
| `atr` | `tr` 首棒只能用 `high-low`（`pineTa.ts:536` 的 `pc = i>0 ? close[i-1] : close[i]`）；`atr` = `rma(tr,n)`，故首值同样有 `full()` 门控 | 手算三棒 |
| `bb` | 返回三元组，`deviation = coef * ta.stdev(...)`，因此**跟着 `biased` 走总体**（`pineTa.ts:635-642` 调 `stdStep` 未传 biased）；它是 ddof 陷阱的放大器 | 由 basis±coef·dev 手算 |
| `macd` | `macd_line = ema(fast) − ema(slow)`，**signal 是对 macd_line 的 ema**，不是对 source；三个输出**从 bar 0 就有值**（ema 无 warm-up），且 `hist = line − signal` 恒等 | 常源序列三值恒 0；斜坡上 `signal < line`（对 source 取 ema 会远大于 line） |
| `stoch` | 分母 `highest(high,n) − lowest(low,n)` 为 0 → `na`；引擎有四元组形态（返回平滑 K，第 5 参 `smoothK`）与三元组形态（返回 `[K,D]`）两种重载，**`ta.stoch(c,h,l,5,3,3)` 是平滑 K 不是 D**（`pineTa.ts:596-618`）；D 只能在 Pine 侧用 `ta.sma(k, n)` 显式求 | 单调上涨序列（`high==low==close`）的 raw K：**bar 0 走 `hh==ll` 那条 na，从 bar 1 起恒 100**——`highest`/`lowest` 没有满窗门控，所以 bar 0 的空是「分母为 0」而不是 warm-up 缺口（§11 更正四）|
| `supertrend` | final band 的「只朝一个方向收紧」规则；`direction` 在 TV 口径里**上涨为 −1**；`src = hl2`（TV 公布脚本如此，`pineRealWorld.test.ts:67`；TA-Lib 用 hlc3，抄它即错）；冷启动 `na(atr[1])` 时 direction 取 **1**，不是「按 close 与 src 比大小」 | 已有 TV 官方脚本入仓（`pineRealWorld.test.ts:65`）＋ 该文件 `:258` 的方向注释 |
| `sar` | 加速因子累积极与封顶、反转日的 `af`/`ep` 重置次序；引擎在 `i<2` 有自己的初始化支路且**从 bar 0 出数** | **本轮判据二不覆盖**：SAR 无单一公开规范（初始化与反转次序各家实现不同），独立参考实现只能表达「另一种意见」，红了也无法判定谁错——见 §11 更正三。判据一照覆盖 |
| `vwap` | **引擎无会话锚定**：`ta.vwap` 在整条载入区间上累加（`pineTa.ts:960-971`，源码注释自己写明 TV 锚在 session 起点并对此发 warning），且不接受 `session` 参数 | 累加式手算两个 session 边界值；会话锚定的缺失作为**已知偏差**入 backlog，不伪装成已通过的门 |

日内 fixture：30 分钟 bar，A 股时段 09:30–11:30 / 13:00–15:00，跨 5 个交易日 ⇒ 每天 8 根、共 40 根，边界可手核。`session` 作为**独立列**写进 CSV，它的用途不是给引擎喂锚点（引擎不接受该参数），而是让参考实现能表达「按会话重锚」这一 TV 语义、并让门能断言「引擎在整条区间上是累加的」——两者之差正是 §6 vwap 那一行登记的已知偏差。日线 fixture 三种形态各 120 根（单调 / 震荡 / 含跳空），LCG 种子固定写入 `manifest.json`，`makeBars` 里那条「wick 必须独立，否则极值类永不触发」的教训（`pineCorpusReport.test.ts` 注释）在日线形态里必须保留。**每个批次的脚本在全部四种 bar 上都跑一遍**（含日内），因为「同一参考实现在三种市场形态上都与引擎一致」比「每个函数挑一种形态」强得多，而生成成本是同一条循环的迭代次数。

## 7. 外部锚点的诚实边界

用户选的是 D（A＋C 双重正证）。能做到的「外部」有两类，**必须分开命名，不许混称权威**：

1. **闭式可手算值**：小整数序列，人拿计算器可独立复核。这是「与引擎无关的第二条路」，但推导仍出自本项目——记作「手算可复核」，不记作「外部权威」。
2. **外部公布值**：第三方文档/参考实现公布的示例数值，逐条带 URL ＋ 取回日期写进 `manifest.json` 的 `external_anchors[]`；以及已在仓的 TradingView 官方 Supertrend 脚本（`pineRealWorld.test.ts:65`）这类真外部文本。**数值与算法事实不构成受版权保护的表达，本设计只引数字、不拷它的代码、不装它的包。**

取不到可核验的外部公布值时，**该条断言就不写**——绝不允许为了满足清单而造数（本项目的既有事故类型：把线索冒充实测、把推导数冒充实测数）。

## 8. 门禁与验收（DoD）

每条都要实测读数 ＋ 提交坐标，逐条落在收口提交里：

1. `npx vitest run src/lib/__tests__/pinePrefixInvariance.test.ts` 全绿；判据二的 18 条 line 在 manifest 里全部为 `strict`。判据一的探针脚本集合随批次增长（Task 3 起 6 条，Task 6 起 8 条），每条都在**全部四种 bar 形态**上比对**该脚本的每一条 line**。
2. `npx vitest run src/lib/__tests__/pineTaOracle.test.ts` 全绿，**11 个函数 × 18 条 line × 4 种 bar 形态**逐对给出最大相对误差实测值（不是只报 pass）。`sar` 不在判据二覆盖内（§6 该行与 §11 更正三），它只受判据一约束，这条边界必须在 `COVERAGE.md` 里点名。
3. `python -X utf8 -m pytest agent/tests/pine_oracle -q` 全绿；含确定性重算（逐字节相同）与点值两组。
4. **fixture 缺失必须红**：临时把 `__fixtures__/pine_oracle/` 改名，两条 JS 门必须 fail（不许 skip）；恢复后再绿。这一条是变异探针，防止「空集合真空通过」。
5. **判据一有可红性**：两条探针都要跑。**其一**（比较器正证）：临时加一条用例，喂给 `comparePrefix` 一个手工的未来函数形态（`close[i+1]`），必须判为 mismatch。**其二**（引擎级注入，本条按 §11 更正五改写）：在 `pineRuntime.ts` 上同时去掉序列下标的两处钳位（`:957` 的 `Math.max(0, Math.trunc(k))` 与 `:429` 的 `k <= 0`），让 `close[-1]` 真读到下一根棒，前缀不变式与「`close[-1] ≡ close`」那条下限守卫必须红；然后按字节还原（**两根针都要唯一 needle** ＋ `finally` 还原 ＋ 前后 sha256）。只改一处是**等价变异**——2026-10-04 实测两轮读数逐字节相同，字节改了而代码路径没走到。
6. **oracle 有可红性**：把某 fixture 的一个数改一位十进制，provenance 门必须红。
7. 全量：`python -X utf8 -m pytest -q`（沿用既有基线，**新增红 0**）；`npm run test:run` 同前端口径。
8. `git diff --name-only main...HEAD` 里**不得出现**上游程序文件；`-k upstream_owned` 面保持 1 passed。
9. `项目档案.md` 落一条本轮收口记录（带全部坐标与实测数），CR 计数保持 0。

## 9. 两项裁定（已采纳，留此以便追责与回退）

- **R-A 基座**：从 `main`（`518d793f`）开 `feat/pine-oracle-harness`，不与未收口的 `sync/upstream-2026-10` 叠加。依据：同步轮 68 个改动文件里 `frontend/` 为 **0**（`agent` 59 + `tools` 1 + `docs` 1 + 7 个 README），且 `frontend/` 两分支逐字节相同 ⇒ 叠加无收益，只有把同步轮的 10 个在账红点拖进本轮的成本。**代价**：同步轮落入 `main` 后本分支需 rebase 一次；冲突面预期只在 `项目档案.md`（双方都在尾部追加），解法是两侧都留。
- **R-B 外部锚**：采纳 §7 第 2 类（引第三方公布的数值并注明出处），但**零依赖、零代码拷贝**。若某函数取不到可核验数值，退回只用第 1 类并在 manifest 里记 `external_anchors: []`——空数组是诚实的读数，不是失败。

## 10. 风险登记

| 风险 | 触发形态 | 缓解 |
|---|---|---|
| `na` 编码两侧不一致 | 一侧空字段、一侧 `NaN` 字面量，错值被当成「都对」 | §5 单一规则 ＋ schema 编解码是唯一出入口 ＋ DoD 6 |
| CRLF 让 sha 永远对不上 | `core.autocrlf=true`，检出即换行改写 | §5 显式 LF 归一后再哈希 ＋ `.gitattributes` 对本目录钉 `text eol=lf`（新文件，不改上游规则文件） |
| 参考实现「抄」了引擎 | 两边同错，对账自证清白 | 纪律：参考实现**只读 bar 数组与公式**，读 `pineTa.ts` 只为确认参数默认值与 `na` 规则；review 时逐函数问「这条 if 来自 Pine 文档还是来自引擎代码」。**本设计的 §6 表格因此是「引擎实测行为」而非「Pine 官方文档口径」**——两处已知不同之处（`vwap` 无会话锚、`ta.stdev` 的 `biased` 第三参）在表格里各占一行，写成待裁定的偏差而不是答案 |
| tick/MTF 豁免被滥用 | 有 bug 的输出被挪进 `guarded` 就永远绿 | §4 挪档需同步改 provenance 断言 ＋ manifest 归类进 git diff 可见 |
| 日内 session 锚定与引擎的会话判定不一致 | **已实测：引擎根本没有会话锚定**（`pineTa.ts:960-971` 整段累加，源码注释自己承认与 TV 不同并发 warning） | 判据二对 `vwap` 断言的是**累加语义**（两侧同式），不假装验了会话锚；「缺会话锚定」作为已知偏差写进 `COVERAGE.md` 的 backlog，改引擎与否是独立决定 |

## 11. 对本设计的六处更正（前五处出自 2026-10-04 写计划后的自检，第六处出自执行期 Task 1）

设计获批后按 writing-plans 的自检逐条回查 `pineTa.ts`，发现 §6 有四行**把 Pine 的口径记反了**。它们不是文字问题：照原样实现，判据二会在第一批就红，而红的原因是参考实现错，不是引擎错——这种红会把人推向「放宽容差」或「改引擎迁就」两个都错的方向。四处均已就地改在 §6，并在此留痕。**第五处改的不是 §6 而是 §8 的第 5 条**（可红性探针的字面形态在本仓不可执行），它同样是被实跑逼出来的，一并列在下表：

| # | 原设计说 | 实测（坐标） | 影响 |
|---|---|---|---|
| 更正一 | `ema` 首值取 `sma(src,n)` 在 `n-1` 播种；`stdev` 用样本 `ddof=1`；`bb` 的 dev 是样本 | `emaStep` 在 `pineTa.ts:134-145`：`prev = src`（首棒即出数，无 warm-up）。`stdStep`（`:186-199`）第三参 `biased` 默认 true = **总体** ddof=0，`ta.stdev(x,n,false)` 才是样本；`bb`（`:635-642`）调 `stdStep` 未传该参，故跟总体 | 播种约定与 ddof 方向双双反转。`rma`（`:147-170`）反而是 SMA 播种 + `full()` 门控——**同一引擎内 ema 与 rma 不同侧**，这才是本轮真正的那条陷阱 |
| 更正二 | `vwap` 的 session 锚定可由判据二对账 | `pineTa.ts:960-971` 无 `session` 参数、整段累加，源码注释自陈与 TV 不同 | `ta_vwap` 参考实现改为「按传入 price/volume 累加」，会话锚定缺失转入 backlog 登记；`session` 列保留，用途改为「让参考实现能表达 TV 语义、并让门能量出两者之差」 |
| 更正三 | 首批 12 个函数全部进判据二 | `sar` 的初始化与反转次序**没有单一公开规范**（引擎 `:716-745` 自带 `i<2` 支路），独立参考实现只能表达「另一种意见」 | **R-C 裁定**：`sar` 只受判据一约束，判据二不覆盖，并在 `COVERAGE.md` 点名这条边界。理由是「一条红了无法解释的门不是门」——宁可少一道，不要造一道需要裁定的 |
| 更正四 | `rsi` 的 warm-up 首值在下标 `n`（`na,na,na,100,100`）；`stoch` 的单调上涨 raw K「恒 100（非 na）」 | `pineTa.ts:550-552`：`changeStep` 在 bar 0 给 NA，rsi 立刻把 NA 折成 `0` 喂进 `up`/`dn` 两路 rma，播种窗因此含这个 0 ⇒ 首值在 **n-1**；`highestStep`/`lowestStep`（`:212-222`）无 `full()` 门 ⇒ ramp 上 bar 0 的 na 来自 `hh==ll`，不是 warm-up。两条都由参考实现 2026-10-04 实跑确认（`[1..5],n=3` → `na,na,100,100,100`；ramp → `na,100,100,100,100`） | §6 那两行的锚点已按实跑读数改写。这一处的意义在于**方向**：若照设计稿写参考实现，`rsi` 会在前 n 根整段错位而对尾部收敛——正是本轮最想让门抓住、又最容易被「宽容差」掩盖的那类错 |
| 更正五 | §8 第 5 条：「把某函数改成用 `bars[b+1]` 的未来函数形态，前缀不变式必须红」 | 本仓的 `ta.*` 是逐棒 stateful step，步骤函数**拿不到 bar 数组**，那句按字面无法执行。可达的注入点是序列下标求值：`readIdx` 的 `Math.max(0, Math.trunc(k))`（`pineRuntime.ts:957`）与 `readBack` 的 `k <= 0` 钳位（`:429`）——TV 的「下一根棒」写法 `close[-1]` 正是从这里被夹回当前棒的。2026-10-04 实跑：只改 `:429` 时两轮读数逐字节相同（**等价变异**，`:957` 先把负数夹掉了）；两处同改后 `ta.sma(close[-1],5)` 与 `ta.sma(close,5)` 在 60 根棒上差异 `[4..59]`，前缀(40) 对完整(60) 差异 `[39]`（那一次的差异只暴露在末棒，但这是这一组针脚的形状，不是通则——见更正六）。顺带实测：这个下限**此前无任何 `pine*.test.ts` 覆盖**（`indicatorLang.test.ts:163` 是另一套求值器，那里 `close[-1]` 断言为 `NaN`） | §8 第 5 条已按两条探针改写（比较器正证 ＋ 双针引擎级注入），并新增一条永久守卫「`close[-1] ≡ close`」——「无未来函数」这句话从此有机器保证，而不是只靠判据一的绿。判据一的期望条数各 +1（25→26、33→34） |
| 更正六（执行期，Task 1 实现者实测发现） | §2 与 §4 把 tick 豁免写成「`estimateTick` 从**整条序列**估」（坐标 `pineRuntime.ts:344-349`）、把 `tick_guarded` 的可红形状写成「仅**末棒**可不同」 | `estimateTick` 的定义不在 `pineRuntime.ts`——那是调用点（`:344`），定义在 `pineOrders.ts:86-96`，其 `:88` 的 `Math.min(bars.list.length, 500)` 把扫描面截在 500 根。坐标写错是真的；「仅末棒」是无证据的加严：tick 是一次 run 的一个标量，切片改变它并不保证只动末棒（更正五那次注入恰好只动末棒，是那一组针脚的形状，不是通则） | §2/§4 两处坐标已就地改对并补上 500 根上限；`tick_guarded` 的容许形状改为「价格档相关输出可不同，启用前必须先量出受影响下标集」。首批 18 条 line 全是 `strict`、无一使用本档，所以**没有任何断言因此变松**——本轮判据读数不受影响；改的是日后真要用这一档时会不会拿一个没证过的形状当默认 |

顺带发现并已吸收的两条：`ta.stoch` 的六参重载是**平滑 K 不是 D**（`:596-618` 第 5 参 `smoothK`，第 6 参不消费），故 D 必须在 Pine 侧用 `ta.sma(k, n)` 显式求；`ta.supertrend` 的 `src` 是 `hl2`，与已入仓的 TV 官方脚本（`pineRealWorld.test.ts:67`）一致，而 TA-Lib 用 `hlc3`——抄后者即错。

判据二的覆盖因此从「12 函数」变为「11 函数 / 18 条 line」，判据一从「4 脚本」扩到「8 脚本 × 4 形态 × 全部 line」。这是范围收窄还是变强，取决于看哪个维度：数值对账少了一个函数，无前视判据多了一倍覆盖面。

**这四条更正共同暴露了一件事，因此本轮多加一个机制**：上表每一处「参考实现采纳引擎约定」都是一次**有方向的让步**——采纳了 `ema` 的首棒播种、`stdev` 的总体 ddof、`rsi` 的 n-1 首值、`stoch` 的偏窗、`supertrend` 的 `dir=-1=上涨`、`vwap` 的整段累加。让步本身是对的（本轮要测的是引擎自不自洽、有没有前视，不是引擎与教科书谁更像），但**默默让步就是自证清白**：参考实现跟着引擎走，门必然绿，而绿里没有任何信息。所以 `manifest.json` 多一个 `convention` 键，逐条写下「采纳了什么 ＋ 另一套约定会给什么 ＋ 源码坐标」，provenance 门把它的**键集合钉成精确名单**（多一条、少一条都红），`COVERAGE.md` 把它列成表。这些约定的独立正证因此不在判据二里，而在各自的手算点值测试与 §7 的外部锚点里——台账必须这样写，否则 7 条记录会被读成 7 条已通过的门。

同一处台账还登记两类「不许静默」：容差档位有**地板**（每条 line 首次实测出的档位是它最宽可停留在的位置，收紧自由、放宽必须留裁定行），豁免分类默认全 `strict`（挪出 `strict` 必须在档案里点名）。
