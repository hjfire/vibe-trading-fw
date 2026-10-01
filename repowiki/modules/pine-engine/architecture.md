---
page: "modules/pine-engine/architecture.md"
sources:
  - "frontend/src/lib/pineLang.ts"
  - "frontend/src/lib/pineRuntime.ts"
  - "frontend/src/lib/pineScript.ts"
  - "frontend/src/lib/pineOrders.ts"
  - "frontend/src/lib/pineResample.ts"
  - "frontend/src/lib/pineSignal.ts"
  - "frontend/src/pages/ProChart.tsx"
verified_at: "b19b657845bde24ef6d737eea2c24287a4031c3c"
anchors: open
vouch: applied-only
---
# Pine 兼容引擎架构

## 1. 五层分工

数据自上而下穿过五层，每层只做一件事：

1. **词法/解析** — `pineLang.ts`：`tokenizePine` 发出换行符并按行记录列号（缩进块、双向续行都靠它），`parsePine` 递归下降产出 `Stmt[]`；`PineError` 只带可读信息。
2. **求值** — `pineRuntime.ts`：`runPine(src, bars, opts?) → PineResult`，逐 bar 跑语句表，维护变量历史、输入、输出收集与 `ENUM_NS` 常量识别。
3. **内置** — `pineTa.ts`（`ta.*` 状态机）与 `pineMath.ts`（`math.*`/`str.*`/casts/日期/颜色的纯函数表）。
4. **绘图 / 撮合** — `pineDrawings.ts`（把 `drawings` 变 KLineChart overlay）与 `pineOrders.ts`（`strategy.*` 成交模拟，独立于 bar 循环以便单测）。
5. **对外 API / 挂载** — `pineScript.ts` 是唯一被 UI 直接调用的模块；把结果落到图表的挂载点在 `indicatorLang.ts`（见第 5 节）。

## 2. 逐 bar 求值与历史缓冲

一个脚本「整段跑一遍 × 每根 K 线」，每个表达式在**当前 bar** 上取标量值。每个变量与每个调用点各自持有滚动缓冲：`pineRuntime.ts` 的 `Series` 记 `hist`（已定稿值，旧→新）、`cur`（本 bar 值）、`live`（本 bar 是否被写过）、`persist`（是否 `var`）。`x[2]` 读的是缓冲里两根之前，而非对某条线做数组下标。非 `var` 变量若在当前 bar 之外的语境被读，按 Pine 语义视为 na；`var x = …` 才跨 bar 保留。为防粘贴脚本冻住标签页，设了硬上限：`HIST_CAP=40000`、`OP_LIMIT=2.5e7`、`LOOP_CAP=5000`、`DRAW_CAP=4000`。递归内置（如 `ta.ema`）靠 `BuiltinCtx.state()` 拿到**按调用点**分配的槽，那个槽就是它的记忆。

## 3. 输入与命名参数的绑定

`input.*` 声明的输入按声明顺序收进 `PineResult.inputs`（每项 `PineInput` 带 `varName/label/kind/def/min/max/step`）。外部覆盖用 `PineRunOptions.params: number[]`，**按同一输入顺序**逐位对齐，不是以 id 为键的字典。调用点的命名参数（`overlay=true`、`length=14`）走另一条路：`argAt` 先按名命中、再回落到位置槽，`numArg`/`strArg`/`flagArg` 在其上加默认值；`NAMED_ONLY = 99` 是「此槽只认名字、绝不按位置取」的哨兵。`pineScript.pineDefaults(result)` 把输入的 `def` 拍平成默认数组。

## 4. 前 / 后端边界

Pine 只在浏览器求值。要走后端市场引擎，`pineSignal.ts` 导出的是策略的**逐根持仓方向** `PineReport.positions`（`+1`/`-1`/`0`，即已成交后的「持有态」），而非权益曲线：查找引擎把它**前移一根**以还原「每根收盘时做的决定」，后端再按自家规则（T+1、涨跌停、次开成交）重放成交。产物 `PineSignalArtifact` 带 `engine: "pine-ts"` 与 `PINE_SIGNAL_SCHEMA`（形状一变即自增，旧 artifact 直接被拒）。后端从不读 Pine 源码；`artifacts/strategy.pine` 则是 `SKILL.md` 里由 Python→Pine 生成的展示/导出文本，与此路径无关。

## 5. 图表集成点

挂载在 `indicatorLang.ts` 的 `applyPineIndicator`：先 `compilePine` 试跑一遍学习 plots/inputs/overlay 意图，再 `registerIndicator` 注册一个 `calc` 会在数据或参数变化时重跑脚本的 KLineChart 指标；`overlay` 落 `candle_pane`，否则落命名副图面板。`pineScript.toArtifact` 把结果拍平为按 bar 对齐的 `figures`+`rows`：`plot` 线→`type:"line"`/`"bar"`，`plotshape`/`plotchar` 标记→`type:"circle"`（`pineScript.ts`），其文本标签 `▲`/`▼` 在 `pineRuntime.ts` 按方向写入 `marker.texts`；`bgcolor`/`label`/`box`/`line` 等装饰走 `pineDrawings.ts` 的 `registerOverlay`（对象系统，非 `text` figure），且永不计入 `produced` 指标。宿主页 `ProChart.tsx` 负责把这些接上工具面：它 import `applyUserIndicator`、`IndicatorEditor` 与分享链接读取（`readShareLink`/`SHARE_QUERY_KEY`），是图表侧的装配点。
