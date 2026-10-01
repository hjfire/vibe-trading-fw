---
page: "modules/pine-engine/tech-stack.md"
sources:
  - "frontend/src/lib/pineTypes.ts"
  - "frontend/src/lib/pineArray.ts"
  - "frontend/src/lib/pineMap.ts"
  - "frontend/src/lib/pineMatrix.ts"
  - "frontend/src/lib/pineDrawings.ts"
  - "frontend/src/pages/ProChart.tsx"
verified_at: "b19b657845bde24ef6d737eea2c24287a4031c3c"
anchors: open
vouch: applied-only
---
# Pine 兼容引擎技术栈

## 1. 运行时与依赖

纯前端 TypeScript 模块（`frontend/src/lib/pine*.ts`），唯一的图形外部依赖是 `klinecharts`（v10）；`pineTypes.ts` 与 `pineScript.ts` 只从它 import 类型与 `KLineData`。**没有任何第三方 Pine 库、也没有 Pine→JS 转译器**——运行时把源码编译成可执行物会撞生产 CSP（见第 5 节），所以整套求值都是自研的逐 bar 解释器。

## 2. 值模型 `V`

`pineTypes.ts` 把 Pine 的值域收敛成一个窄并集 `V = number | string | V[]`：数字覆盖 int/float，Pine 的 `na` 就是 `Number.NaN`（`NA`/`isNa`）；字符串承载文本，外加 `@` 前缀的哨兵（`sentinel()`）表示渲染层未完全支持的枚举/颜色，好让脚本仍能编译；`V[]` 表 tuple（`[macd, signal, hist] = ta.macd(...)`）。`asNum`/`asStr` 是数字/文本两种视图，bool 与 na 在前者塌成数值、整数在后者不带 `.0`。

## 3. 复合值：array / map / matrix 复用 `V[]`

三者都是 **mutable reference object**，靠的是「`readSeries` 把活动 `V[]` 按引用交回、下一根 bar 仍看到同一对象」，因此不必拓宽 `V` 并集、也不必另立对象模型（`pineArray.ts`/`pineMap.ts`/`pineMatrix.ts` 头注）。map 是**交错**数组 `[k0,v0,k1,v1,…]`，matrix 是「行 `V[]` 的 `V[]`」。作用域上：真实语料脚本一律 free-form 调用（`array.push(buf,v)`、`map.put(m,k,v)`、`matrix.set(m,r,c,v)`），map/matrix 的方法形式（`m.get(...)`）刻意不路由——array/map/matrix 都是 `V[]`，光看形状无法消歧，靠前缀 `array.`/`map.`/`matrix.` 才不歧义。

## 4. KLineChart v10 图形能力与已知偏差

`pineTypes.PlotStyle` 只取图表确用的三型：`line`/`bar`/`circle`（`pineScript.toArtifact` 把 plot 线拍成 line/bar、把标记拍成 circle）。装饰通道 `bgcolor`/`barcolor`/`label`/`box`/`line`/`table`/`fill` 不写成 indicator `text` figure，而是 `pineDrawings.ts` 用 `registerOverlay` 注册成 KLineChart overlay——因为 indicator 的 text 原语共用一个 `figure.key` 会丢位，而 overlay 图元按自身像素坐标定位；且全程 CSP-safe（无 `eval`/`new Function`，只用文档化的 `registerOverlay` 回调）。诚实记录的偏差：v10 overlay 画在恒于蜡烛之上的独立层，蜡烛体也无逐根上色钩子，故 `bgcolor` 近似成顶部淡色（alpha 封顶）、`barcolor` 用同色柱体+影线重绘近似——真背景层要换核心蜡烛层，对生产图表是禁区。所有 overlay 都 `lock`ed+`ignoreEvent`，用户拖不动也删不掉。

## 5. `.pine` 载体与生产 CSP

导入/导出有四种载体（`scriptExchange.ts`，在 `ProChart.tsx` 侧接上工具面）：**单文件 `.pine`** 用 `//>` 头注释携带元数据（保留源码可读性）；**JSON 集合** 带完整元数据；**分享链接** 是 `?s=` 后跟 base64url 的负载，运行时能 gzip 就压（`g` 前缀）、否则退回 plain JSON（`j` 前缀），超过软上限会提示；**粘贴导入** 由 `pineLang.looksLikePine` 嗅探 `//@version`/头调用/`ta.` 等命名空间自动定 dialect。这一切的硬约束是生产 `Content-Security-Policy: script-src 'self'`，`eval`/`new Function` 被禁、并由 `agent/tests/test_sse_ticket_and_headers.py` 钉死——它正是引擎选择逐 bar 解释器、拒绝转译的根本原因。
