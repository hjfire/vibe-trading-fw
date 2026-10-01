---
page: "modules/pine-engine/conventions.md"
sources:
  - "frontend/src/lib/pineTa.ts"
  - "frontend/src/lib/pineMath.ts"
  - "frontend/src/lib/pineRuntime.ts"
  - "frontend/src/lib/pineLang.ts"
  - "frontend/src/lib/__tests__/pineBuiltins.test.ts"
  - "frontend/src/lib/__tests__/pineRealWorld.test.ts"
verified_at: "b19b657845bde24ef6d737eea2c24287a4031c3c"
anchors: open
vouch: applied-only
---
# Pine 兼容引擎编码规范

## 1. 一项新语言能力常常「四处同改」

新语言特性要按层落位，别只改一处：词法在 `pineLang.ts`（`OPS_MULTI`/`OPS_SINGLE`、`tokenizePine`、`parse*` 递归下降与优先级链）；求值/路由在 `pineRuntime.ts`（`ENUM_NS` 常量白名单、`LEGACY_SERIES` 的 v3/v4 裸名回退、`TA`/`MISC` 的分派）；实现在内置表 `pineTa.ts`/`pineMath.ts`；命名绘制/样式常量若命中，还得回 `pineRuntime.ts` 的 `ENUM_NS` 正则加一项。漏改 `ENUM_NS` 会让一次「只是传了个样式常量」的读取抛 undeclared identifier，把整个订单块/FVG 指标 bar 中途打断（`pineRuntime.ts` 注释）。

## 2. 内置归属：纯函数与改状态函数分家

`pineMath.ts` 只放纯 helper：`math.*`、`str.*`、casts、日期、颜色，键是词法器产出的**完整点号名**，单次查表分派。会改动解释器输出状态的东西**必须留在 `pineRuntime.ts`**——`plot`/`hline`/`fill`、`input.*`、`strategy.*` 与内建变量（time/close/bar_index…），因为「a pure function table cannot do」（`pineMath.ts` 头注）。`ta.*` 里有状态的指标（`ta.ema`/`ta.atr` 递归）写成**逐 bar 状态机步进**、靠调用点槽记忆，绝不塞进通用 MISC 表（`pineTa.ts` 头注）。往通用内置表里塞本该在 `pineTa.ts` 的实现是禁止的。

## 3. 改数值必配「精确钉值」单测，而非「不报错了」

新增/改动内置要配可反证的钉值用例：`pineBuiltins.test.ts` 逐条对 `percentrankStep`/`linregStep`/`percentileNearestRankStep` 等**手算值或 JS 数学恒等式**断言（明写 NOT "it stopped erroring"），并保留一组「真未定义名仍必须 abort」的用例，证明放宽的是兼容不是数值。`pineContinuation.test.ts` 的契约同样精确：折叠后的表达式必须与写成单行的同一表达式**逐根 bar 产出完全相同的线**，而非「能编译」。

## 4. 判据：「真缺口」还是「脚本自坏」

区分二者靠两条证据：是否是**已发布脚本** + 有无**权威签名**。`pineRealWorld.test.ts` 收录 TradingView 官方 Supertrend 等「非我写的」源码，其中 Supertrend 用手写 Pine 体与内置 `ta.supertrend` 交叉对账、要求逐根一致——正是这条抓出了两个真缺陷（方向符号、band-ratchet 状态机）。反之，社区脚本引用从未赋值的名字（如 `accdist`/`pvt` 一类）是**脚本自身损坏**，引擎正确报错、不桩化；而「脚本只画了装饰性 fill/box/bg」导致的 `no_output` 是测量口径、不是引擎缺陷，不为其放宽判定。

## 5. 被否决 / 刻意不实现清单

- **翻译器方案**：Pine 与自有 DSL 语义不可互换（`close[1]` 逐 bar vs `P[0]` 向量参数，`pineLang.ts` 头注），翻成 JS 再 `eval` 又撞 CSP，故否决。
- **LLM Pine→Python 反向路径**：单一语义源是这套 TS 引擎，绝不在 Python 重写 Pine；后端只读导出的持仓 series（`pineSignal.ts`），方向反了。
- **位运算 XOR `^^`**：不做。本引擎 `^` 是幂、TV 权威 `^^` 优先级未证实，臆造即投机。同理 `<<`/`>>` 刻意不并入 `OPS_MULTI`，只由解析器在表达式语境把相邻 `<`/`>` 重组成移位，以免嵌套泛型闭合 `array<map<int, float>>` 被误 lex（`pineLang.ts` 头注）。
- **装饰性基元**：`label`/`box`/`table`/`request.*` 等只降级为 no-op、记进 `PineResult.warnings`，既不参与数值、也绝不中断脚本（`pineRuntime.ts` 诚实规则；`pineBuiltins.test.ts` 的 "decorative … not counted, never aborting"）。
