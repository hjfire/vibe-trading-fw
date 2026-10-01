---
page: "modules/pine-engine/overview.md"
sources:
  - "frontend/src/lib/pineScript.ts"
  - "frontend/src/lib/pineLang.ts"
  - "frontend/src/lib/pineRuntime.ts"
  - "frontend/src/lib/pineTypes.ts"
  - "agent/src/skills/pine-script/SKILL.md"
verified_at: "b19b657845bde24ef6d737eea2c24287a4031c3c"
anchors: open
vouch: applied-only
---
# Pine 兼容引擎总览

前端自研的 TradingView Pine v5/v6 兼容层：导入 `.pine` 源码，按 Pine 的「逐根 K 线」语义求值，把线、标记与参考线画进 KLineChart v10（`pineScript.ts` 的 `toArtifact` 只从 `result.lines`/`markers`/`hlines` 生成图表 figure），策略成交不画进图表——它们作为 `PineReport.trades` 报告表格单独呈现（`workbench/ReportTab.tsx`）。同时把「脚本自己算出的策略报告」与「后端回测口径」严格分开。本模块是知识树里唯一一页 Pine——导出快照里没有它，正文只写 `frontend/src/lib/pine*.ts` 与其 `__tests__` 里读得到的事实。

## 1. 它是什么、不是什么

- **是**独立于自有 DSL 的第二套执行内核，两者共存：`pineLang.ts` 的词法器对缩进/换行敏感，产出 AST；`pineRuntime.ts` 逐 bar 求值。自有 mini 语言在 `indicatorLang.ts`，向量式、`P[0]` 指「第一个参数」；Pine 里 `close[1]` 指「上一根 K 线的 close」，语义不可互换，故两套求值器各留各的（`pineLang.ts` 头注）。
- **不是**翻译器。把 Pine 翻成自有 DSL 的方案已被否决：`var` 的 persist、历史缓冲、命名输入绑定在翻译途中易丢，且翻成 JS 再 `eval` 撞生产 CSP。
- **不是**后端能力。`artifacts/strategy.pine` 是 LLM 生成的**文本**，`agent/src/skills/pine-script/SKILL.md` 写明方向是 Python→Pine（供展示/导出）；后端内核只吃 Python `signal_engine.py`，没有 Pine 解释器。

## 2. 为什么必须是解释器

生产 CSP 是 `script-src 'self'`，`eval` 与 `new Function` 被禁——这条被 `agent/tests/test_sse_ticket_and_headers.py` 锁死。`pineScript.ts`、`pineLang.ts` 与 `indicatorLang.ts` 的头注都点名同一事实：任何「运行时把源码编译成可执行物」的做法都会在 dev 能跑、prod 直接死。逐 bar 解释器同时满足语义等价与 CSP，是唯一被接受的执行模型。

## 3. 模块清单（13 个源文件，合计 7,879 行）

| 层 | 文件 | 职责 |
|---|---|---|
| 词法/语法 | `pineLang.ts` | v5/v6 词法器 + 递归下降解析器（缩进块、命名参数、`x[n]` 历史下标、tuple 解构、双向续行） |
| 类型与值 | `pineTypes.ts` | 共享 `V` 值模型、na 工具、Arg 访问器、`PineLine`/`PineMarker`/`PineTrade`/`PineReport`/`PineDrawing` |
| 求值 | `pineRuntime.ts` | 逐 bar 执行器、变量历史缓冲、`var` persist、输出收集、`ENUM_NS` 常量白名单 |
| 对外 API | `pineScript.ts` | `compilePine(code, dataList, opts?) → PineArtifact \| PineFailure`、`toArtifact`、`isPineStrategy`、`validatePine` |
| 内置 | `pineTa.ts`、`pineMath.ts` | `ta.*` 状态机与 `math.*`/`str.*`/casts 等纯函数表 |
| 复合值 | `pineArray.ts`、`pineMap.ts`、`pineMatrix.ts` | `array.*`/`map.*`/`matrix.*` 命名空间（复用 `V[]` 的原地可变引用对象） |
| 交易与绘图 | `pineOrders.ts`、`pineDrawings.ts` | `strategy.*` 撮合模拟；`pineDrawings.ts` 把 `line`/`label`/`box`/`fill`/`table` 等绘图原语注册成 KLineChart overlay（`plot` 线不走这里，由 `pineScript.toArtifact` 直接产 chart figures） |
| 多周期 | `pineResample.ts` | `request.security` 与 `timeframe.*` 的时间戳聚合 |
| 桥接 | `pineSignal.ts` | 把策略的逐根持仓列导出给后端 SignalEngine 的查找引擎 |

细节见 `modules/pine-engine/` 其余四面；对外入口以 `pineScript.ts` 为唯一被 UI 直接调用的执行入口（UI 侧另有组件只从 `pineTypes.ts` 取类型，如 `workbench/ReportTab.tsx` 的 `PineReport`）。
