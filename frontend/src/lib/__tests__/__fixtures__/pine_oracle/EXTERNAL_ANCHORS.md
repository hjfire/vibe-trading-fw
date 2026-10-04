# 外部锚点台账（Task 6 · 批次三取证）

这份文件是 `manifest.json` 里 `external_anchors` 那张表的来源与凭据：表里的每一条都必须能在这里
指回一段**被真实读到的文本**，反之这里记录「取不到」的条目一律不进 manifest。
机器可读的那四个键（`name` / `value` / `source` / `retrieved_at`，全为字符串）定义在
`frontend/src/lib/__tests__/pineOracleFixtures.ts:51-56` 的 `OracleAnchor`，由
`agent/pine_oracle/emit_fixtures.py` 的 `EXTERNAL_ANCHORS` 写出（Task 3 已把 plumbing 建好：
`emit_fixtures.py` 写键、`schema.py:68/:97` 要求它是**可以是空的 list**、JS 侧声明为
`OracleAnchor[]`——本任务只往里填真条目，不新建管道）。

## 取数结果（诚实读数）

**本轮没有取到任何第三方网页上的数值。** 本机网络对以下抓取全部失败（原文错误抄在下一节），
而 brief 与控制器裁定都要求「取不到就不许造数」，所以这张表里只有**仓内文本**两条：

| 断言名 | 数值 | 出处 URL | 取回日期 | 与本项目哪条点值测试同调 |
| --- | --- | --- | --- | --- |
| `st_direction_uptrend_sign` | `-1` | 仓内文本：`frontend/src/lib/__tests__/pineRealWorld.test.ts:65-93`（TradingView 官方 Supertrend 正文，逐字入仓；`:83` `direction := close > upperBand ? -1 : 1`，`:86` `superTrend := direction == -1 ? lowerBand : upperBand`） | 2026-10-04 | `test_reference_batch3.py::test_direction_minus_one_is_the_uptrend_not_the_folklore_one`、`ENGINE_CONVENTION["st_direction"]`、判据二 `st_direction` 的 `exact` 档位 |
| `vwap_source_and_anchor_range` | `hlc3` | 仓内文本：`frontend/src/lib/scriptLibrary.ts:154-165`（本 fork 自带的「累计 VWAP」库脚本；`:165` `v = ta.vwap(hlc3)` 是全仓唯一活着的 `ta.vwap` 用法，始终带显式 source；`:160` 描述写明「按整段区间累计（TV 为逐日锚定）」） | 2026-10-04 | `ENGINE_CONVENTION["vwap"]`、`test_vwap_session_argument_reanchors_and_is_not_the_engines_reading`；会话锚定差本身按裁定记为 **COVERAGE.md 的 backlog**，不是判引擎对错的门 |

两条都是**口径锚点**（约定：方向符号、默认 source 与锚定范围），不是点值锚点：
它们把「本参考实现采用的是哪一路公开文本」钉住，不给任何浮点数作对照。
尤其第一条——参考实现与引擎都抄自同一段仓内 TV 正文，所以判据二在这里证明的是
**本 fork 的转写忠实**，不是「TV 的算法被独立复核」（test 文件模块 docstring 写的是同一句话）。

## 放弃的条目（未取到，已放弃）

| 想锚的口径 | 目标出处 | 结果 |
| --- | --- | --- |
| `supertrend` 方向口径的**第三方**表述 | tradingview.com help center `43000502040-supertrend-indicator` | 未取到，已放弃（`WebFetch` → `fetch failed`） |
| `rsi` 的 `down == 0` 分支（全涨 → 100、无涨无跌 → 50） | TA-Lib / 教科书对 `RSI` 在 `dn == 0` 时的公开定义 | 未取到，已放弃（ta-lib.org → `fetch failed`；搜索结果只有标题，无可抄原文） |
| `stdev` / `bb` 的 ddof（Pine 默认是总体式 ddof=0） | TA-Lib `STDEV` 文档、Stack Overflow「stdev() differences between talib and pine script versions」 | 未取到，已放弃（stackoverflow.com → `403 Forbidden`） |
| `atr` 的 Wilder 播种（首值 = 前 n 根 TR 均值） | Wilder 原著表述 / TA-Lib `ATR` 文档 | 未取到，已放弃（同上，抓取失败） |
| `vwap` 会话锚定的 TradingView 官方原文 | tradingview.com pine-script-docs / scripts 页 | 未取到，已放弃（`fetch failed`；改以仓内 `scriptLibrary.ts:160` 的中文表述记同一件事） |
| `supertrend` **warm-up 段**的 `nz()`／na 条件语义（第一棒没有 `upperBand[1]`/`lowerBand[1]`/`close[1]` 时，`nz(na)` 取 0 后三元走 `prev` 支，还是 na 把整个三元污染成 na） | tv-pine 文档（`Pine Script® v5 reference`／language manual 的 `nz()` 与 `na` 传播条目）、TradingView 支持页 `43000502040-supertrend-indicator` | 未取到，已放弃（tradingview.com 那条本机 `WebFetch` → `fetch failed`，原文错误见下一节；文档侧无其他可抄来源）。**这条是开口**：本实现与引擎在首棒同取 NaN-guard（`pineTa.ts:700-713`），字面 `nz()` 读法在 bar 0 给出的线不同（5 棒表上 `[0.0, 14.0, 12.0, 8.0, 8.0]` 对 `[11.0, 11.0, 11.0, 8.0, 8.0]`；四份夹具上只在 index 0 不同，`supertrend` na 计数 8 对 9），读数见 `ta_supertrend` docstring 与 task-6 报告「Fix round 1」——在取到原文之前，两种读法谁都不许写成 Pine 的规则 |
| Pine 自身对 **na carry/poison/reseed** 的行为 | Pine 文档对 `na` 传播的说明 | 未取到，已放弃。**这条仍然是开口**：批次一/二里「输入出现 na 时参考实现永久中毒」是本模块自记的 DEVIATION，引擎的规则是按窗口重播（`pineTa.ts:46-55`、`:134-145`、`:147-170`），而 Pine 自己怎么处理仍待外部锚点；本任务的 na 边界差异一律先怀疑参考实现的选择，不开引擎缺陷单 |

抓取失败的原文错误（2026-10-04 在本机实测，逐字）：

```
Error: Error during web fetch for "https://ta-lib.org_function/1269960422": fetch failed
Error: Error during web fetch for "https://gist.github.com/kdkiss/731e6288e2314a7e6f36383888e5bc40": fetch failed
Error: Error during web fetch for "https://en.wikipedia.org/wiki/Bollinger_bands": fetch failed
Error: Error during web fetch for "https://www.tradingview.com/support/solutions/43000502040-supertrend-indicator/": fetch failed
HTTP ERROR: Fetching https://stackoverflow.com/questions/65901574/... returned 403 Forbidden.
```

`WebSearch` 可用，但它只回标题与链接、不回可抄的正文，所以**不构成**取数凭据。

## 后续批次的补法（给 Task 7 与之后）

1. 换一台能出网的环境重跑 Step 8，把上表各条（Task 6 fix round 1 之后为 **7 条**）的**原文引句**抄进本文件，再往 `EXTERNAL_ANCHORS`
   里加条目；`value` 仍是字符串（例如 `"2.09"`），别写裸浮点。
2. 每加一条，同步在 `test_reference_batch3.py`（或对应批次测试）里落一条点值断言，
   让锚点与点值测试成对出现——孤立数字会被删掉而无人报警。
3. na-carry 那条一旦取到，才谈得上把批次一/二记录的 DEVIATION 改成 Pine 的规则；
   在那之前，判据二的 na 边界差异都按「参考实现的选择」处理。
