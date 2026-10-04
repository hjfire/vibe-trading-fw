# oracle 覆盖台账

判据一 = 前缀不变式（`frontend/src/lib/__tests__/pinePrefixInvariance.test.ts`）——信号不重绘。判据二 = 跨实现数值对账（`pineTaOracle.test.ts` 读 `values/`）——每条 line 与 Python 参考实现逐位对账。

名单与档位由 `agent/pine_oracle/coverage.py` 和 `manifest.json` 生成（`PYTHONPATH=agent python -X utf8 -m pine_oracle.emit_coverage`），**不要手改本文件**。

行号取自**当前工作树**的 `pineTa.ts`（共 74 个 `ta.*` 分派键），只作定位用。两个头不是一回事，别混读：上面的行号属于**当前工作树**，而 `manifest.json` 里的 `head_sha = 9f208048` 是**夹具生成头**——它不产出这些行号；`pineTa.ts` 前移而夹具未重生成时，行号跟工作树、这个头跟夹具。

## 已覆盖（12 / 74）

| ta.* | 判据一 | 判据二 | manifest line | 备注 |
|---|---|---|---|---|
| `atr` | ✗ | ✓ | `atr` |  |
| `bb` | ✗ | ✓ | `bb_basis`, `bb_upper`, `bb_lower` |  |
| `ema` | ✓ | ✓ | `ema` |  |
| `macd` | ✗ | ✓ | `macd`, `macd_signal`, `macd_hist` |  |
| `rma` | ✓ | ✓ | `rma` |  |
| `rsi` | ✗ | ✓ | `rsi` |  |
| `sar` | ✓ | ✗（R-C） | — | 只由判据一兜住：numpy 里的 SAR 参考实现等于把被测代码抄一遍，不是第二证人（spec §11 R-C） |
| `sma` | ✓ | ✓ | `sma` |  |
| `stdev` | ✓ | ✓ | `stdev`, `stdev_sample` |  |
| `stoch` | ✗ | ✓ | `stoch_k`, `stoch_d` |  |
| `supertrend` | ✓ | ✓ | `supertrend`, `st_direction` |  |
| `vwap` | ✓ | ✓ | `vwap` | 无会话锚定，见下方「已知偏离」 |

## 采纳引擎／TV 约定（7 处，逐字取自 manifest 的 `convention`）

每一行都是「参考实现刻意跟着引擎约定走」的记录：**它让判据二可跑，但它本身不是判据二的证据**——这些约定的独立正证是各自的手算点值测试；外部锚点本轮只提供口径约定（`EXTERNAL_ANCHORS.md`，第三方取数 0 条，两条锚点都是 in-repo 的符号口径而非点值）。

| line | 采纳了什么、另一套约定会给什么（含源码坐标） |
|---|---|
| `ema` | seeded on src[0] with no na warm-up; TA-Lib SMA-seeds at n-1 (pineTa.ts:134-145) |
| `macd` | all three outputs are dense from bar 0 because the underlying emas are; TA-Lib would leave the first slow-1 bars na (pineTa.ts:622-632) |
| `rsi` | bar-0 change enters both rma streams as 0, so the first value is at n-1 and the seed window includes that 0; na-propagation would start at n (pineTa.ts:550-552) |
| `st_direction` | -1 is the UPTREND and the plotted line is the lower band; the folklore '+1 = up' reading is inverted (pineTa.ts:707-712) |
| `stoch_k` | highest/lowest have no full-window gate, so %K exists from the first bar whose partial window has hh!=ll (on the ramp fixture that is bar 1, and bar 0 is na only via the hh==ll rule, not via warm-up); a strict n-bar warm-up leaves n-1 bars na (pineTa.ts:212-224) |
| `supertrend` | cold start takes direction +1 (`if na(atr[1]) direction := 1`), and on the first bar — where upperBand[1]/lowerBand[1]/close[1] are all missing — THIS implementation guards the previous band with a NaN guard, the reading the engine also takes (pineTa.ts:700-713). Pine's own nz()/na behaviour through that warm-up is NOT ANCHORED (EXTERNAL_ANCHORS.md logs the fetch as 未取到，已放弃), so the guard is a choice, not a fact about Pine: taking the body's nz() literally answers bar 0 differently — on all four committed shapes it differs from the supertrend CSVs at index 0 alone (0.0 where the CSV is empty), 8 na against the 9 committed, and it answers +/-1 through the whole ATR warm-up where both sides of the gate leave na, so st_direction would carry 0 na against the 9 committed (TV body pineRealWorld.test.ts:65-93; readings recomputed in ta_supertrend's docstring) |
| `vwap` | takes no session argument and accumulates over the whole loaded range; that TradingView re-anchors each session is cited, not established — the only source in reach is this repo's own pre-existing assertion scriptLibrary.ts:160 「按整段区间累计（TV 为逐日锚定）」, and TradingView's documentation for it was NOT retrieved (EXTERNAL_ANCHORS.md), so the difference is a backlog entry in COVERAGE.md rather than a passing gate (pineTa.ts:960-970). The Pine text passes hlc3 EXPLICITLY: that is the engine's own default source for an argument-less call (pineTa.ts:963), while a bare `ta.vwap` never reaches the ta.* dispatcher — that branch is on the call path only (pineRuntime.ts:1537-1541) — and reads as an undefined variable (measured: 未定义的变量 "ta.vwap", task-6 report Step 7) |

## 判据二的见证物性质（11 个函数、18 条 line 的当场读数）

下表是 18 条 line 在四份 bar（bars_daily_trend、bars_daily_oscillating、bars_daily_gapped、bars_intraday_vwap）上**抄录**的相对残差区间（抄写坐标：`coverage.py` 的注释——HEAD `575d3382`、2026-10-04 当场复跑），取自 `pineTaOracle.test.ts:148` 的 `[oracle]` 打印（72 行 = 18 line × 4 bar 集），**不是**从 CSV 里反推的第二个数。它按裁定 Ruling H 回答一个门回答不了的问题：
（数值按 Python 的 `:.3e` 排版，零写作 `0.000e+00`；控制台是 JS 的 `toExponential(3)`，同一读数写作 `0.000e+0`——同值不同形，逐条数值已当场复核一致，见 task-7-report.md。）
**恒零的线只核对语义（播种位置、总体/样本式选择、`PERIOD` 接线、line 名↔`title=`），不核对算术形式**——两条独立实现逐位相同，更可能说明参考实现照抄了引擎的运算顺序，而不是两套算术在容差内各自成立。非零残差才是「两套不同算术落进同一档位」的那种见证。

| line | 档位 | worst 下界 | worst 上界 | 距档位地板的余量 | 见证物性质 |
|---|---|---|---|---|---|
| `atr` | `loose` | 0.000e+00 | 0.000e+00 | —（恒零，无余量可言） | 零残差＝只核对语义 |
| `bb_basis` | `tight` | 9.337e-16 | 5.797e-15 | 172.5× | 非零残差＝独立算术见证 |
| `bb_lower` | `tight` | 9.394e-16 | 6.132e-15 | 163.1× | 非零残差＝独立算术见证 |
| `bb_upper` | `tight` | 9.280e-16 | 5.496e-15 | 182.0× | 非零残差＝独立算术见证 |
| `ema` | `loose` | 0.000e+00 | 0.000e+00 | —（恒零，无余量可言） | 零残差＝只核对语义 |
| `macd` | `loose` | 0.000e+00 | 0.000e+00 | —（恒零，无余量可言） | 零残差＝只核对语义 |
| `macd_hist` | `loose` | 0.000e+00 | 0.000e+00 | —（恒零，无余量可言） | 零残差＝只核对语义 |
| `macd_signal` | `loose` | 0.000e+00 | 0.000e+00 | —（恒零，无余量可言） | 零残差＝只核对语义 |
| `rma` | `loose` | 0.000e+00 | 0.000e+00 | —（恒零，无余量可言） | 零残差＝只核对语义 |
| `rsi` | `loose` | 0.000e+00 | 0.000e+00 | —（恒零，无余量可言） | 零残差＝只核对语义 |
| `sma` | `tight` | 9.337e-16 | 5.797e-15 | 172.5× | 非零残差＝独立算术见证 |
| `st_direction` | `exact` | 0.000e+00 | 0.000e+00 | —（恒零，无余量可言） | 零残差＝只核对语义 |
| `stdev` | `tight` | 0.000e+00 | 0.000e+00 | —（恒零，无余量可言） | 零残差＝只核对语义 |
| `stdev_sample` | `tight` | 0.000e+00 | 0.000e+00 | —（恒零，无余量可言） | 零残差＝只核对语义 |
| `stoch_d` | `loose` | 0.000e+00 | 0.000e+00 | —（恒零，无余量可言） | 零残差＝只核对语义 |
| `stoch_k` | `loose` | 0.000e+00 | 0.000e+00 | —（恒零，无余量可言） | 零残差＝只核对语义 |
| `supertrend` | `loose` | 0.000e+00 | 0.000e+00 | —（恒零，无余量可言） | 零残差＝只核对语义 |
| `vwap` | `loose` | 0.000e+00 | 0.000e+00 | —（恒零，无余量可言） | 零残差＝只核对语义 |

读数分档（14 恒零 / 4 非零，18 条合计）：恒零者的判据二通过=**语义见证**，非零者的判据二通过=**独立算术见证**。本表不是门——门是 `pineTaOracle.test.ts` 当场断言 `worst ≤ 档位`；本表记录的是「这条门在这条线上到底见证了什么」。`test_coverage_ledger.py::test_the_witness_table_names_every_priced_line_within_its_own_tier` 钉住三件事：行数=18、每行 4 个读数、每个读数落在该线 manifest 档位的地板之内（档位被人改了而没重测 ⇒ 这条红）。

这些读数是**手抄进 `coverage.MEASURED_WORST` 的字面量**，上面那条门只把它们钉在各自档位的地板之内、不钉它们与判据二当场输出的等值；整文档等值门比的是「文档 ↔ `render()`」，而 `render()` 吃的正是这份手抄数，所以它锁住的是渲染、不是数。等值由一条默认跳过的慢门守：`test_coverage_ledger.py::test_the_recorded_readings_are_what_the_gate_prints_today`（子进程重跑判据二、逐格比对 72 个 `[oracle]` 读数；`PINE_ORACLE_REMEASURE=1` 才跑，以免拖慢默认基线）。**本生成器自己不复跑判据二。**

## 已知偏离，记为 backlog 而不是通过的门

- `vwap`：引擎按整段加载区间累积 hlc3×volume，不接受 session 参；TradingView 每个会话重新锚定累计量。本项目**不**把这条当成已通过——参考实现照引擎的口径写（`ref_batch_3` 收下并忽略 `session` 列），会话锚定的缺失留作功能 backlog。
- `sar`：判据二不覆盖，理由见上表的备注行。
- **容差地板表 `TIER_FLOOR` 是人工棘轮，机器只守住它的一半**：它抄在`agent/tests/pine_oracle/test_pine_oracle_provenance.py`，本轮新增的等值钉（`test_the_floor_table_is_the_tier_table_the_generator_derives`）拒的是「单独挪地板表」；把「地板表 ＋ `emit_fixtures` 的 `EXACT_LINES`/`TIGHT_LINES` ＋ 入库 `manifest.json` ＋ 重生本台账」**四处一起改松**仍然没有任何门红（评审轮针 c 在 `32fe0754` 实测：119 Python ＋ 118 JS 零红），而注释里那句「放宽需要书面裁定」在代码里没有执法点。⇒ 放宽容差今天仍是四次看得见的编辑、不是一道红；这条盲区在此显式登记，不写成已封闭。
- **na carry / poison / reseed 在 Pine 侧未锚定**：输入出现 `na` 时，批次一/二的参考实现是**永久中毒**（`reference.py` 模块 docstring 自记的 DEVIATION），引擎是按窗口重播（`pineTa.ts:46-55`、`:134-145`、`:147-170`），而 Pine 自己走哪一条**没有取到第三方原文**（`EXTERNAL_ANCHORS.md`「放弃的条目」）。判据二在这条上仍然全绿**不是**因为两边规则一致，而是因为四份夹具的输入里**一个 `na` 都没有**（实测 `high`/`low`/`close` 全长有限、`bars_*.csv` 无空字段、`ta_tr` 无 nan）⇒ na 边界从没被这条门走到；它记为 backlog，不记为通过。
- **`supertrend` warm-up 段的 `nz()`／na 条件语义同样未锚定**（Task 6 新登记）：第一棒没有 `upperBand[1]`/`lowerBand[1]`/`close[1]` 时，字面 `nz(na)` 读法与 NaN-guard 读法在 bar 0 给出的线不同（四份夹具上只在 index 0 不同，`supertrend` 的 na 计数 8 对 9）。本实现与引擎同取 NaN-guard（`pineTa.ts:700-713`），在取到原文之前**两种读法都不许写成 Pine 的规则**。

## 待补 backlog（按字母序）

| ta.* | 引擎表行号 |
|---|---|
| `ac` | `788` |
| `adxr` | `864` |
| `alma` | `345` |
| `ao` | `778` |
| `barssince` | `517` |
| `bbw` | `645` |
| `cci` | `558` |
| `change` | `366` |
| `change_log` | `368` |
| `cmf` | `922` |
| `cmo` | `826` |
| `corr` | `485` |
| `cross` | `515` |
| `crossover` | `513` |
| `crossunder` | `514` |
| `cum` | `396` |
| `dev` | `466` |
| `deviation` | `465` |
| `dmi` | `843` |
| `dpo` | `797` |
| `eom` | `933` |
| `force` | `986` |
| `highest` | `438` |
| `highestbars` | `453` |
| `hma` | `297` |
| `kc` | `654` |
| `kst` | `809` |
| `linreg` | `418` |
| `lowest` | `445` |
| `lowestbars` | `454` |
| `ma` | `268` |
| `massi` | `945` |
| `median` | `473` |
| `mfi` | `567` |
| `mom` | `405` |
| `nvi` | `957` |
| `obv` | `875` |
| `percentile_nearest_rank` | `425` |
| `percentrank` | `416` |
| `pivot_high` | `1009` |
| `pivot_low` | `1010` |
| `pivot_point` | `1012` |
| `pivothigh` | `1005` |
| `pivotlow` | `1006` |
| `pvi` | `958` |
| `pvt` | `889` |
| `roc` | `414` |
| `std` | `464` |
| `sum` | `402` |
| `swma` | `315` |
| `tema` | `334` |
| `tma` | `306` |
| `tr` | `532` |
| `trix` | `972` |
| `tsi` | `765` |
| `valuewhen` | `385` |
| `var` | `467` |
| `variance` | `471` |
| `vwma` | `274` |
| `wma` | `270` |
| `wpr` | `587` |
| `zma` | `323` |
