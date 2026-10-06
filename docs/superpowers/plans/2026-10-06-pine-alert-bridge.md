# Pine 脚本告警桥（alertcondition / alert）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 Pine 脚本里的 `alertcondition()` / `alert()` 第一次真正生效——前端逐根算出条件序列，能静态翻译的落成后端告警规则（无人值守、走既有 IM 投递），不能翻译的指名道姓拒绝。

**Architecture:** 三层且互相独立：`pineRuntime` 记录逐根 bool（图表自己怎么判）→ 新增纯函数 `pineAlertRules.ts` 静态翻译（后端将怎么判）→ `workbench/AlertsTab.tsx` 把两者并排呈现并一键建规则。后端 `agent/src/alerts/**` 与 `alerts_routes.py` **一行不改**，规则只通过既有 `POST /alerts/rules` 创建。验收主张只有一条：一份夹具、两个消费者，前端引擎的逐根序列与后端 `evaluate_condition` 逐前缀判定**逐根相等**。

**Tech Stack:** TypeScript + React 19 + Vite + vitest + @testing-library/react（前端）；Python 3.11 + pytest + pandas（后端对账腿）；klinecharts 10.0.3（图表宿主）。

**Spec:** `docs/superpowers/specs/2026-10-06-pine-alert-bridge-design.md`（本文所有判据的来源，执行者必读；本文与它冲突时以它为准并停下来报告，不要自行取舍）

## Global Constraints

每个 Task 的要求都隐含包含本节全部条目，逐条都是硬约束，值取自 spec 原文。

- 后端**零改动**：不得修改 `agent/src/alerts/**`、`agent/src/api/alerts_routes.py`、`agent/src/tools/technical_indicator_tool.py`。新增的只有一个 Python 测试文件。
- 不可译必须显式拒绝，**绝不静默放宽**：`>=`/`<=` 不得译成 `>`/`<`；`and`/`or`/`not` 不得只取一半；`ta.cross` 不得只当 `crossUp`。拒绝项在 UI 上没有「还是要一下」的入口。
- 后端条件语法是封闭集（spec F3）：`nonEmpty/truthy/gt/lt/crossUp/crossDown/rising/falling` × `{op, lhs, rhs?, value?}`。翻译器产出的 `op` 只允许这 8 个值。
- 后端指标**只吃 close**（spec F6，`agent/src/alerts/conditions.py:284-420`）：`sma/ema/rsi` 的源参数不是 `close` 就不可译。
- 后端周期名册没有 `1W`/`1M`（spec F10，`alerts_routes.py:51` vs `frontend/src/lib/marketApi.ts:18`）：图表在周月线时该条 alertcondition 直接拒绝。
- `freq=` 参数**不求值、不映射**（spec §1 非目标）。`message` 只作展示与规则标题来源，不进后端、不做 `{{...}}` 占位符替换（spec §1）。
- `alert()` 的语义是「执行到达即命中」（TV 语义），不是「第一个参数为真」；`alertcondition()` 的语义是「它的 `condition` 参数为真」，与它被嵌套在哪一层 `if` 里无关。na / NaN 一律记 `false`（spec §5.1）。
- 未来函数禁令（用户级长期约束）：判定只用已收盘数据；`crossUp` 读 `prev/last` 两根已收盘值。任何"最新一根未收盘就出信号"的写法都不允许。
- 文案直接写中文字面量，沿用 workbench 既有做法（`IndicatorEditor.tsx:57-63`）；**不动九份 locale 文件**，不引入 `useText()`。
- 上游归属：本计划所有新建/修改路径对 `upstream/main` 的 `ls-tree` 计数必须为 0（spec F17 已实测为 0）。若某步要求改动计数非 0 的路径，停下报告——那是上游文件，`frontend/src/lib` 整目录混有 38 个上游文件，逐路径判定不可省略。
- Git 纪律：每笔提交带 `-s`（`git commit -s`，当场带，事后补签会打断 repowiki 的 `verified_at` 祖先链）；提交一律用显式 pathspec，禁止 `git add -A` 与裸 `git commit`；脏树上禁止 `git checkout --`。
- 门禁基线：`WIKI_STALE_MAX=439` 不得放宽（开工实测 `HEAD=1efc1cc1` 上 `stale --format count` = 443，门本片开工前已红，属 M5 次片在报的活，不解决也不掩盖）。`bash tools/ci_grep_gates.sh` 长期红一条命中 `./.qoder/` 开头路径，那是上游脚本的口径缺陷，**明令不修**。
- 夹具纪律：`__fixtures__/pineAlertBridge/*.json` 由 `PINE_ALERT_FIXTURE_EMIT=1` 显式生成一次后提交入库，正常运行全程只读；任何测试运行都不得写被跟踪文件（本仓有 oracle 生成器覆写事故）。
- 读不到就 raise，不许 skip：对账两腿的夹具目录缺失、`cases` 为空、长度不匹配一律抛错，并断言「实际比了几条 case、几根前缀」。

## 文件划分（先定死，再切任务）

| 面 | 路径 | 责任 | Task |
|---|---|---|---|
| 改 | `frontend/src/lib/pineTypes.ts` | `PineAlertSeries` 类型 ＋ `PineResult.alerts?` 字段 | 1 |
| 改 | `frontend/src/lib/pineMath.ts:550` | 从 `isDecorativeName` 白名单摘掉 `alert`/`alertcondition` | 1 |
| 改 | `frontend/src/lib/pineRuntime.ts` | `doAlert()` 逐根记录 ＋ dispatch 两个 case ＋ build 装配 | 1 |
| 改 | `frontend/src/lib/__tests__/pineIndicatorWire.test.ts:155-162` | 旧「警告含 alertcondition」快照改为断言 `alerts` 形状 | 1 |
| 新 | `frontend/src/lib/pineAlertRules.ts` | 纯静态翻译器：源码 → `PineAlertPlan[]` | 2 |
| 新 | `frontend/src/lib/__tests__/pineAlertRules.test.ts` | 语法表逐行 ＋ 拒绝枚举逐条 | 2 |
| 新 | `frontend/src/lib/__tests__/__fixtures__/pineAlertBridge/*.json` | 对账夹具（code/bars/cases） | 3 |
| 新 | `frontend/src/lib/__tests__/pineAlertBridge.test.ts` | TS 对账腿 ＋ EMIT 生成器 ＋ 反假绿三闸 | 3 |
| 新 | `agent/tests/test_alerts_pine_reconciliation.py` | Python 对账腿（逐前缀 `evaluate_condition`） | 4 |
| 新 | `frontend/src/components/charts/workbench/AlertsTab.tsx` | 呈现 ＋ 建规则，唯一有副作用的一层 | 5 |
| 改 | `frontend/src/components/charts/workbench/types.ts:24` | `TabKey` 加 `"alerts"` | 5 |
| 改 | `frontend/src/components/charts/IndicatorEditor.tsx` | 第 6 个页签 ＋ `symbol`/`interval`/`adjust` 可选 props | 5 |
| 改 | `frontend/src/pages/ProChart.tsx:2030-2038` | 传三个 props | 5 |
| 新 | `frontend/src/components/charts/__tests__/PineAlertsTab.test.tsx` | 页签行为与不可覆盖拒绝的组件测试 | 5 |
| 新 | `frontend/src/lib/__tests__/pineAlertCorpus.test.ts` | 语料覆盖率 N/M 守卫 | 6 |

---

### Task 1: 运行时记录逐根 bool 序列（让 spec F1 的 no-op 消失）

**Files:**
- Modify: `frontend/src/lib/pineTypes.ts`（在 `PineMarker`（`:134-144`）之后加类型；`PineResult`（`:274-305`）加字段）
- Modify: `frontend/src/lib/pineMath.ts:547-551`
- Modify: `frontend/src/lib/pineRuntime.ts`（dispatch 的 `case "alertcondition"/"alert"` 在 `:1521-1524`；`ensureMarker` 的分配范式在 `:1775-1805`；`build()` 在 `:2350-2372`）
- Test: `frontend/src/lib/__tests__/pineAlertSeries.test.ts`（新建）
- Modify: `frontend/src/lib/__tests__/pineIndicatorWire.test.ts:155-162`

**Interfaces:**
- Consumes：`argAt(args, index, ...names): Expr | undefined`、`strArg(args, c, index, def, ...names): string`、`isTrue(v): boolean`（三者都在 `pineTypes.ts:81/104/60`）；`this.val(expr)`、`this.bi`、`this.bars.list.length`、`this.warn(msg)`、`sentinel("void")`（`pineRuntime.ts` 私有成员，同类内可用）。
- Produces：`PineAlertSeries`（字段见下）与 `PineResult.alerts?: PineAlertSeries[]`。**Task 2/3/5 都依赖这两个名字，逐字使用。**

```ts
// pineTypes.ts —— 紧跟 PineMarker 之后
export interface PineAlertSeries {
  /** 产生这条序列的 `alertcondition()` / `alert()` 调用所在行（1 起）。 */
  line: number;
  fn: "alertcondition" | "alert";
  /** `title=` 的字面量；缺失时为空串，由 UI 退化成 `alertcondition@L{line}`。 */
  title: string;
  /** `message=`（或 alert 的消息）字面量。只用于展示，绝不进后端规则（spec §1）。 */
  message: string;
  /** 逐根判定，长度 = 图表 bar 数。na/NaN 记 false；alert() 记「执行到达」。 */
  hits: boolean[];
}
```

`PineResult` 里加（放在 `lowerTfMs?` 之前，与之同级语义）：

```ts
  /**
   * Captured `alertcondition()`/`alert()` verdicts, one entry per call site
   * (keyed by the parser's `cid`, so two identical titles stay two series).
   * Absent when the script declares none — never an empty array, so a caller
   * can tell "no alerts in this script" from "not yet run".
   */
  alerts?: PineAlertSeries[];
```

- [ ] **Step 1: 写失败测试**

新建 `frontend/src/lib/__tests__/pineAlertSeries.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { KLineData } from "klinecharts";
import { runPine, toBars } from "@/lib/pineRuntime";
import type { PineBars } from "@/lib/pineTypes";

/** 60 根有涨有跌的确定序列，够跑 ema(5) 且不会全单边。 */
function bars(n = 60): PineBars {
  const list: KLineData[] = [];
  for (let i = 0; i < n; i++) {
    const close = 100 + 6 * Math.sin(i / 3) + i * 0.05;
    list.push({
      timestamp: 1700000000000 + i * 86400000,
      open: close - 0.4,
      high: close + 1,
      low: close - 1,
      close,
      volume: 1000 + (i % 5) * 400,
    } as KLineData);
  }
  return toBars(list);
}

const SRC = [
  '//@version=5',
  'indicator("告警", overlay=false)',
  'up = ta.ema(close, 5) > ta.ema(close, 20)',
  'alertcondition(up, "上穿", "msg-up")',
  'alertcondition(ta.crossover(ta.ema(close,5), ta.ema(close,20)), title="金叉", message="msg-cross")',
  'if ta.rsi(close, 14) > 95',
  '    alert("贵了", alert.freq_once_per_bar_close)',
].join("\n");

const run = () => runPine(SRC, bars());

it("两条 alertcondition + 一条 alert = 三条序列", () => {
  const r = run();
  expect(r.alerts?.length).toBe(3);
  expect(r.alerts?.map((a) => a.fn)).toEqual(["alertcondition", "alertcondition", "alert"]);
});

it("title / message / line 从字面量取，命名参数与位置参数同等", () => {
  const r = run();
  expect(r.alerts?.[0]).toMatchObject({ title: "上穿", message: "msg-up", line: 4 });
  expect(r.alerts?.[1]).toMatchObject({ title: "金叉", message: "msg-cross", line: 5 });
});

it("hits 长度等于 bar 数，且 alertcondition 与脚本自身 bool 序列逐根一致", () => {
  const r = run();
  const n = r.bars;
  const a = r.alerts?.[0];
  expect(a?.hits.length).toBe(n);
  // up = ema5 > ema20 与 plot 出来的同一条线一致：拿 lines 当第二意见。
  const upLine = r.lines.find((l) => l.name === "");
  expect(a?.hits.filter((h) => h).length).toBeGreaterThan(0);
  expect(a?.hits.filter((h) => h).length).toBeLessThan(n);
  if (upLine) {
    for (let i = 0; i < n; i++) expect(a!.hits[i]).toBe(upLine.values[i] > 0.5);
  }
});

it("na 不是命中：前 20 根的 rsi 门槛 alert 不得提前为真", () => {
  const r = run();
  const alertSeries = r.alerts?.[2];
  expect(alertSeries?.fn).toBe("alert");
  // 到达即命中，所以前 14 根 RSI 还是 na ⇒ 整段必须 false。
  for (let i = 0; i < 14; i++) expect(alertSeries!.hits[i]).toBe(false);
});

it("没有 alert 声明的脚本不产出 alerts 字段（不是空数组）", () => {
  const r = runPine('//@version=5\nindicator("x")\nplot(close)\n', bars());
  expect(r.alerts).toBeUndefined();
});

it("不再警告「不起作用」", () => {
  const r = run();
  expect(r.warnings.join(" ")).not.toContain("不起作用");
});
```

- [ ] **Step 2: 跑测试确认失败**

Run（在 `frontend/` 下）：`npx vitest run src/lib/__tests__/pineAlertSeries.test.ts`
Expected: FAIL —— `r.alerts?.length` 为 `undefined`，`expect(3)` 收到 `undefined`；最后一条用例 FAIL（警告里仍有「不起作用」）。

- [ ] **Step 3: 加类型**

`pineTypes.ts`：按 Interfaces 段插入 `PineAlertSeries`（`PineMarker` 之后）与 `PineResult.alerts?`（`:304` 的 `lowerTfMs?` 之前）。

- [ ] **Step 4: 白名单摘名**

`pineMath.ts:550` 由

```ts
    /^(alert|alertcondition|syntax\.functions)$/.test(name)
```

改为（`alert`/`alertcondition` 从"永不为数值的装饰名"里摘掉，`syntax.functions` 保留）：

```ts
    /^(syntax\.functions)$/.test(name)
```

- [ ] **Step 5: 运行时记录**

`pineRuntime.ts`，在 `doShape`（`:1812`）之前加两个私有成员与方法，并在类字段区（`this.markers` 声明附近）加：

```ts
  private readonly alerts: PineAlertSeries[] = [];
  private readonly alertByCid = new Map<number, PineAlertSeries>();

  /** One call site = one series, keyed by the parser's cid (two identical
   *  titles are two series, spec §5.3). Arrays are pre-sized like markers. */
  private ensureAlert(cid: number, fn: "alertcondition" | "alert", line: number, title: string, message: string): PineAlertSeries {
    const hit = this.alertByCid.get(cid);
    if (hit) return hit;
    const s: PineAlertSeries = {
      line,
      fn,
      title,
      message,
      hits: new Array<boolean>(this.bars.list.length).fill(false),
    };
    this.alerts.push(s);
    this.alertByCid.set(cid, s);
    return s;
  }

  /**
   * `alertcondition(condition, title, message, freq)` → per-bar condition arg.
   * `alert(message, freq)` → "execution reached this call on this bar" (TV
   * semantics: it fires from inside the `if` that guards it, so the guard is
   * the condition and there is nothing to evaluate here). `freq=` is never
   * evaluated (spec §1 non-goal) — leaving it unevaluated also keeps
   * `alert.freq_*` constants out of the value path.
   */
  private doAlert(node: Extract<Expr, { k: "call" }>): V {
    const args = node.args;
    const c = this.ctx;
    const isCondition = node.name === "alertcondition";
    const s = this.ensureAlert(
      node.cid,
      node.name,
      node.line,
      strArg(args, c, isCondition ? 1 : 2, "", "title"),
      strArg(args, c, isCondition ? 2 : 0, "", "message"),
    );
    if (isCondition) {
      const cond = argAt(args, 0, "condition", "series");
      s.hits[this.bi] = cond !== undefined && isTrue(this.val(cond));
    } else {
      s.hits[this.bi] = strArg(args, c, 0, "", "message") !== "";
    }
    return sentinel("void");
  }
```

dispatch 里把（`:1521-1524`）

```ts
      case "alertcondition":
      case "alert":
        this.warn(`${name}() 提醒在前端不起作用，已忽略`);
        return nothing;
```

替换为：

```ts
      case "alertcondition":
      case "alert":
        return this.doAlert(node);
```

若 `nothing` 变量在改完后没有其他使用者，把它一起删掉（不要留下未使用变量，`tsc --noEmit` 在 `noUnusedLocals` 下会红）。`build()`（`:2350`）在 `if (this.lowerTfSeen.size)` 那行之前加：

```ts
    if (this.alerts.length) result.alerts = this.alerts.slice();
```

`pineRuntime.ts` 顶部从 `@/lib/pineTypes` 的 import 里补 `PineAlertSeries`（值类型 import 用 `import type`）。同文件若已 `import type { … }` 一组名字，加进去即可。确认 `Expr`/`V`/`sentinel`/`strArg`/`argAt`/`isTrue` 都在既有 import 内（`doShape` 已经用了它们，所以只可能缺 `PineAlertSeries`）。

- [ ] **Step 6: 跑测试确认通过**

Run：`npx vitest run src/lib/__tests__/pineAlertSeries.test.ts`
Expected: PASS 7 条。若「lines 当第二意见」那条因 plot 未声明而 `upLine` 为 undefined，属预期分支（`if (upLine)` 跳过），不是假绿：真正断言是 hits 有 true 也有 false。

- [ ] **Step 7: 更正旧的 no-op 快照**

`frontend/src/lib/__tests__/pineIndicatorWire.test.ts:155-162` 现在断言警告文本包含 `alertcondition`。把 `expect(notes.join(" ")).toContain("alertcondition")` 改为断言序列真的产出了：

```ts
    expect((out.result.alerts ?? []).map((a) => a.title)).toContain("t");
    expect(out.result.alerts?.[0]?.hits.some(Boolean)).toBe(true);
```

（`notes`/`warnings` 那条仍可比照保留，但断言方向反过来：`expect(notes.join(" ")).not.toContain("不起作用")`。）先只改这一处，跑 `npx vitest run src/lib/__tests__/pineIndicatorWire.test.ts` 确认绿。

- [ ] **Step 8: 全量前端门禁＋提交**

Run（`frontend/`）：`npx tsc --noEmit && npx vitest run`
Expected: tsc 静默；vitest 全绿，文件数比开工基线 +1。

```bash
git add frontend/src/lib/pineTypes.ts frontend/src/lib/pineMath.ts frontend/src/lib/pineRuntime.ts \
        frontend/src/lib/__tests__/pineAlertSeries.test.ts frontend/src/lib/__tests__/pineIndicatorWire.test.ts
git commit -s -m "feat(pineRuntime): alertcondition/alert 逐根记录为 PineResult.alerts"
```

（`git add` 必须带显式 pathspec；仓库可能有他人 staged 面。）

---

### Task 2: 静态翻译器 `pineAlertRules.ts`

**Files:**
- Create: `frontend/src/lib/pineAlertRules.ts`
- Test: `frontend/src/lib/__tests__/pineAlertRules.test.ts`

**Interfaces:**
- Consumes：`parsePine(src): Stmt[]`（`pineLang.ts:1303`）、`Expr`/`Stmt`/`Arg`（`pineLang.ts:245-330`）、`AlertRuleDraft`/`AlertCondition`（`alertsApi.ts:70-75/179`，**只用 `import type`**，纯模块不得触发 fetch）。
- Produces（Task 3/5/6 逐字依赖）：

```ts
export type PineOp = "nonEmpty" | "truthy" | "gt" | "lt" | "crossUp" | "crossDown" | "rising" | "falling";
export interface PineAlertPlan {
  line: number;
  fn: "alertcondition" | "alert";
  title: string;
  message: string;
  status: "native" | "refused";
  /** 仅 native：后端条件（8 算子封闭集）。 */
  condition?: AlertCondition;
  /** 仅 native：可直接 POST 的草稿（不含 title 之外的 UI 默认值以外的猜测）。 */
  draft?: AlertRuleDraft;
  /** 仅 refused：中文说明＋建议，UI 原文显示。 */
  reason?: string;
  /** 翻译过程中的失真标注（input 默认值代入等），两态都可能非空。 */
  notes: string[];
}
export interface TranslateOptions {
  symbol: string;
  /** 图表周期键（marketApi 的 IntervalKey 词汇）。 */
  interval: string;
  adjust?: string;
  targets?: string[];
  /** 引擎逐根真值（Task 5 把 Task 1 的 hits 传进来并排显示）。 */
  hits?: number[];
}
export function translatePineAlerts(code: string, opts: TranslateOptions): PineAlertPlan[];
export function pineRuleId(symbol: string, line: number, cond: AlertCondition): string;
export function fnv1aHex(text: string): string;
export const BACKEND_INTERVALS: readonly string[]; // ["1m","5m","15m","30m","60m","1D"]
```

- [ ] **Step 1: 写失败测试（语法表逐行 ＋ 拒绝逐条，一张表一个用例）**

新建 `frontend/src/lib/__tests__/pineAlertRules.test.ts`。头部与工具：

```ts
import { describe, expect, it } from "vitest";
import { translatePineAlerts, pineRuleId, fnv1aHex, BACKEND_INTERVALS } from "@/lib/pineAlertRules";

const wrap = (body: string) => `//@version=5\nindicator("t")\n${body}`;
const OPT = { symbol: "600519.SH", interval: "1D" };
const one = (body: string, opt = OPT) => translatePineAlerts(wrap(body), opt)[0];

describe("可译语法表（spec §6）", () => {
  it("close > 常量 ⇒ gt + value", () => {
    expect(one('alertcondition(close > 1700, "A", "")')).toMatchObject({
      status: "native",
      condition: { op: "gt", lhs: "close", rhs: null, value: 1700 },
    });
  });
  it("ta.crossover(ema5, ema20) ⇒ crossUp + 双序列", () => {
    expect(one('alertcondition(ta.crossover(ta.ema(close,5), ta.ema(close,20)), "A", "")')).toMatchObject({
      status: "native",
      condition: { op: "crossUp", lhs: "ema:5", rhs: "ema:20", value: null },
    });
  });
  it("命名参数 condition= 与位置参数同等", () => {
    expect(one('alertcondition(condition = close < ta.sma(close, 20), title = "A")')).toMatchObject({
      status: "native",
      condition: { op: "lt", lhs: "close", rhs: "sma:20" },
    });
  });
  it("标识符多跳展开（longSignal → crossover → ema）", () => {
    const src = 'fast = ta.ema(close, 5)\nslow = ta.ema(close, 20)\nok = ta.crossover(fast, slow)\nalertcondition(ok, "A", "")';
    expect(one(src)).toMatchObject({ status: "native", condition: { op: "crossUp", lhs: "ema:5", rhs: "ema:20" } });
  });
  it("volume > volume[1] ⇒ rising volume", () => {
    expect(one('alertcondition(volume > volume[1], "A", "")')).toMatchObject({
      status: "native",
      condition: { op: "rising", lhs: "volume" },
    });
  });
  it("ta.change(x) < 0 ⇒ falling x", () => {
    expect(one('alertcondition(ta.change(close) < 0, "A", "")')).toMatchObject({
      status: "native",
      condition: { op: "falling", lhs: "close" },
    });
  });
  it("rsi 常量门槛 ⇒ lt rsi:14 30", () => {
    expect(one('alertcondition(ta.rsi(close, 14) < 30, "A", "")')).toMatchObject({
      status: "native",
      condition: { op: "lt", lhs: "rsi:14", value: 30 },
    });
  });
  it("ta.macd 默认参数的 tuple 解构 ⇒ macd_line/macd_signal", () => {
    const src = '[m, s, h] = ta.macd(close)\nalertcondition(m > s, "A", "")';
    expect(one(src)).toMatchObject({ status: "native", condition: { op: "gt", lhs: "macd_line", rhs: "macd_signal" } });
  });
  it("顶层 alert(cond, msg) 与单语句 if 体内的 alert(msg) 同等处理", () => {
    expect(one('alert(ta.ema(close,5) > ta.ema(close,20), "贵", alert.freq_all)').condition?.op).toBe("gt");
    const guarded = 'if ta.rsi(close,14) > 70\n    alert("贵了")';
    expect(one(guarded)).toMatchObject({ status: "native", condition: { op: "gt", lhs: "rsi:14", value: 70 } });
  });
  it("input.int 默认值代入 ⇒ 常量 value ＋ 一条 notes", () => {
    const src = 'lvl = input.int(1700, "水平")\nalertcondition(close > lvl, "A", "")';
    const p = one(src);
    expect(p).toMatchObject({ status: "native", condition: { op: "gt", lhs: "close", value: 1700 } });
    expect(p.notes.join(" ")).toContain("input");
  });
});

describe("拒绝枚举（绝不静默放宽，spec §6/§9）", () => {
  it(">= 没有对应算子", () => {
    const p = one('alertcondition(close >= 1700, "A", "")');
    expect(p.status).toBe("refused");
    expect(p.reason).toContain(">=");
    expect(p.condition).toBeUndefined();
  });
  it("and / or / not 一律拒绝", () => {
    for (const body of [
      'alertcondition(close > 1 and volume > 1000, "A", "")',
      'alertcondition(close > 1 or volume > 1000, "A", "")',
      'alertcondition(not (close > 1), "A", "")',
    ]) {
      expect(one(body).status).toBe("refused");
    }
  });
  it("ta.cross 是双向穿越", () => {
    expect(one('alertcondition(ta.cross(ta.ema(close,5), ta.ema(close,20)), "A", "")').status).toBe("refused");
  });
  it("指标源不是 close 就不可译（后端只吃 close）", () => {
    const p = one('alertcondition(ta.ema(volume, 5) > 100, "A", "")');
    expect(p.status).toBe("refused");
    expect(p.reason).toContain("close");
  });
  it("ta.macd 带周期参数 ⇒ 与后端默认值不同，拒绝", () => {
    expect(one('[m, s, h] = ta.macd(close, 8, 21, 5)\nalertcondition(m > s, "A", "")').status).toBe("refused");
  });
  it("名册外的序列点名它", () => {
    const p = one('alertcondition(ta.atr(14) > 1, "A", "")');
    expect(p.status).toBe("refused");
    expect(p.reason).toContain("atr");
  });
  it("周月线周期后端不支持，点名周期", () => {
    const p = one('alertcondition(close > 1, "A", "")', { ...OPT, interval: "1W" });
    expect(p.status).toBe("refused");
    expect(p.reason).toContain("1W");
  });
  it("裸 bool 来自脚本自定义比较 ⇒ 拒绝；名册内数值序列 ⇒ truthy", () => {
    expect(one('flag = close > 1\nalertcondition(flag, "A", "")').status).toBe("refused");
    expect(one('alertcondition(volume, "A", "")').condition).toMatchObject({ op: "truthy", lhs: "volume" });
  });
  it("alert() 被 if 门住但体内不止一条语句 ⇒ 拒绝", () => {
    expect(one('if close > 1\n    plot(close)\n    alert("x")').status).toBe("refused");
  });
  it("解析失败原样带回，绝不返回空数组冒充「没有告警条件」", () => {
    const rows = translatePineAlerts('indicator("x"\nalertcondition(close >, ', OPT);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("refused");
    expect((rows[0].reason ?? "").length).toBeGreaterThan(0);
  });
  it("脚本里没有 alert 声明 ⇒ 空数组（与上一条方向相反，两者都必须成立）", () => {
    expect(translatePineAlerts('//@version=5\nindicator("x")\nplot(close)\n', OPT)).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run：`npx vitest run src/lib/__tests__/pineAlertRules.test.ts`
Expected: FAIL —— `Cannot find module '@/lib/pineAlertRules'`（或等价的解析失败）。

- [ ] **Step 3: 写实现**

新建 `frontend/src/lib/pineAlertRules.ts`。下面是完整骨架，逐段都是必须实现的内容（不允许留 TODO）：

```ts
/**
 * Static translation of a Pine script's `alertcondition()` / `alert()` calls
 * into the backend alert kernel's single-comparison grammar (spec §6).
 *
 * Why a translator and not a series export: the backend recomputes its own
 * numbers on its own poll (`conditions.py:284-420`), so a translated rule keeps
 * firing with the tab closed. What it cannot do is express anything outside the
 * closed roster of 8 operators x the named series — and the honest answer for
 * everything else is a refusal that names the sub-expression, never a narrowed
 * translation (`>=` -> `>`, `a or b` -> `a` are both silent semantic changes).
 *
 * Pure: parses the source with `parsePine` (the artifact does not carry the AST,
 * spec F12), no DOM, no network, no engine. Task 3 pins the agreement between
 * what this module decides and what the interpreter actually computed.
 */

import { parsePine, type Arg, type Expr, type Stmt } from "./pineLang";
import type { AlertCondition, AlertRuleDraft } from "./alertsApi";

/** `alerts_routes.py:51` — the backend has no weekly/monthly interval. */
export const BACKEND_INTERVALS = ["1m", "5m", "15m", "30m", "60m", "1D"] as const;

/** `models.py:95-104` CONDITION_OPS, verbatim. */
const OPS = ["nonEmpty", "truthy", "gt", "lt", "crossUp", "crossDown", "rising", "falling"] as const;
type Op = (typeof OPS)[number];

/** Raw bar fields `resolve_series` reads straight off the bars. */
const BAR_SERIES = new Set(["close", "open", "high", "low", "volume"]);

/** Indicator calls mapped to the backend's `fn:period` spelling. Only close. */
const INDICATOR_CALLS: Record<string, string> = {
  sma: "sma", "ta.sma": "sma",
  ema: "ema", "ta.ema": "ema",
  rsi: "rsi", "ta.rsi": "rsi",
};

/** Tuple-returning calls the backend exposes at fixed default params. */
const TUPLE_MEMBERS: Record<string, string[]> = {
  "ta.macd": ["macd_line", "macd_signal", "macd_hist"],
  macd: ["macd_line", "macd_signal", "macd_hist"],
  "ta.bb": ["bb_upper", "bb_middle", "bb_lower"],
  bb: ["bb_upper", "bb_middle", "bb_lower"],
};

export type PineOp = Op;
/* … PineAlertPlan / TranslateOptions 按 Interfaces 段逐字声明 … */

/** FNV-1a, 32-bit, hex. Identity only — never a security boundary. */
export function fnv1aHex(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** Deterministic so re-creating the same alert updates instead of duplicating,
 *  and symbol-participating so the same alertcondition on two symbols does not
 *  overwrite itself. Grammar-safe for `RULE_ID_RE` / `SAFE_RULE_ID_RE`. */
export function pineRuleId(symbol: string, line: number, cond: AlertCondition): string {
  const canon = `${cond.op}|${cond.lhs}|${cond.rhs ?? ""}|${cond.value ?? ""}`;
  return `pine-${fnv1aHex(`${symbol}|${line}|${canon}`)}-L${line}`.replace(/-/g, "_").slice(0, 128);
}

/** operand = 名册内的序列名，或一个数字字面量。 */
type Operand = { series: string } | { constant: number };

interface Ctx {
  env: Map<string, Expr>;
  notes: string[];
  opts: TranslateOptions;
}

/** Refusals carry the reason verbatim to the UI. */
class Refuse extends Error {}

/**
 * Resolve one expression to a backend series name or a constant.
 * Cycle-safe (`seen`), scope-honest (only top-level decls are in `env`), and
 * closed under the roster: anything not in it raises Refuse with the source
 * spelling so the message can name it.
 */
function operand(e: Expr, ctx: Ctx, seen: ReadonlySet<string>): Operand { … }

/** Find alert call sites, carrying the `if` guards that enclose them. */
function collectAlerts(stmts: Stmt[], guards: Expr[], out: Site[]): void { … }

/** Translate one condition expression into a backend condition dict. */
function toCondition(e: Expr, ctx: Ctx): AlertCondition { … }

export function translatePineAlerts(code: string, opts: TranslateOptions): PineAlertPlan[] { … }
```

各段的**必须实现的行为**（Step 1 的用例逐条对应；这里是判据，不是可选说明）：

`operand()`：
- `{k:"num"}` → `{constant}`；`{k:"id"}` 且名字在 `BAR_SERIES` → `{series: name}`。
- `{k:"id"}` 且在 `ctx.env`：`seen.has(name)` → `throw new Refuse(...)`（循环引用）；否则递归展开，`seen` 加入该名字。**展开后仍解析不到 ⇒ `throw new Refuse("条件引用了无法静态解析的变量 ${name}（只认全局作用域的声明）")`。**
- `{k:"id"}` 且不在 `env` ⇒ 先试 `input.*` 路径？不——input 通过 decl 展开走；展开出的 expr 若是 `{k:"call", name: /^input\./}` ⇒ 取它的第 2 个参数（title）之后的默认值？本仓 `input.int(14, "周期", minval=1)` 的默认值是**第 1 个位置参数**。实现为：`name.startsWith("input")` 且第 1 个位置参数是 `{k:"num"}` → `{constant}`，并 `ctx.notes.push("条件里的 ${name} 用了 input 默认值；改滑块不会改规则")`。
- `{k:"call", name}` 在 `INDICATOR_CALLS`：源参数（第 1 个位置参数或 `source=`）必须是 `{k:"id", name:"close"}`，否则 `throw new Refuse("后端指标只在 close 上计算（conditions.py:284-420），${src} 不是 close")`；周期必须是 `{k:"num"}` 整数且 1..500（`_split_name:246` 的边界），否则拒绝。返回 `{series: `${fn}:${n}`}`。
- `{k:"call", name}` 在 `TUPLE_MEMBERS`：拒绝（tuple 变量本身不是可引用项）——真正的路径是 `collectAlerts` 之前把 `[m,s,h] = ta.macd(close)` 这类 decl 展开成 `m → {series: "macd_line"}`。**实现方式**：`buildEnv` 时识别 `decl.names.length > 1` 且 `value` 是 `TUPLE_MEMBERS` 里的调用且**没有任何周期实参**（有则 `throw new Refuse("…与后端默认参数不同…")`），把每个名字记进一张 `tupleMembers: Map<string, string>`，`operand` 遇到 `{k:"id"}` 时先查这张表。
- `{k:"idx"}`：只有在 `toCondition` 的 `x > x[1]` ⇒ rising 判式里作为右操作数出现时才允许（见下），其它位置拒绝。
- 其它 ⇒ `throw new Refuse("无法把 ${spelling(e)} 映射到后端序列名")`。`spelling(e)` 是一个 12 行的小函数，把 AST 反打回近似源码文本（`name(a, b)`、`a op b`、`x[n]`），用于 reason 文案——**这是必需实现**，否则拒绝信息只是「不行」而无从下手。

`toCondition()`：
- `bin(">", a, b)` → `{op:"gt", lhs:a series, rhs/value}`；`bin("<", …)` → `lt`。lhs 优先取序列侧；若两侧都是常量 ⇒ 拒绝。若一侧是常量则填 `value`，另一侧填 `lhs`（`rhs: null`）。
- `bin(">=", …)` / `bin("<=", …)` → `throw new Refuse(">= / <= 在后端没有对应算子（CONDITION_OPS 只有 gt/lt），把它译成 > 就是少一个等号")`。
- `bin(">", x, idx(x, 1))`（及 `<`）→ `{op:"rising"|"falling", lhs:x}`，`x` 必须先过 `operand`；offset 非字面 `1` ⇒ 拒绝。
- `bin(">", call("ta.change", x), num 0)`（及 `<`）→ `rising/falling`。
- `call("ta.crossover", a, b)` → `crossUp`；`call("ta.crossunder", a, b)` → `crossDown`；`call("ta.cross", …)` → 拒绝（`ta.cross 是双向穿越，单条条件表达不了；建议建成两条规则（crossUp + crossDown）`）。
- `{k:"id"}`/其它非 bin 表达式 ⇒ 先 `operand(e)`；成功则 `{op:"truthy", lhs}`（spec §6 说明后端 `truthy` = `last > 0`，`conditions.py:484`）。失败时如果 reason 里含 `and/or/not` 痕迹则换成专门文案：`bin("and"|"or")` 与 `{k:"un", op:"!"}` 各有专门拒绝文案（「后端单条件语法没有布尔组合；拆成两条规则，或在告警页分别建」）。
- 三元 / `ifexpr` / `switch` → 拒绝。
- 产出前过一遍 `OPS` 成员断言（不可能越界，但保留 `if (!OPS.includes(op)) throw`——防后来者加算子时漏改）。

`collectAlerts()`：递归 `Stmt`，维护 `guards: Expr[]`（`if` 语句进入时 push 该 arm 的 cond，只处理 `arms` 里 `body` 为 `Stmt[]` 的情形；`elseBody` 同样带一个"取反"的 guard？——**不做取反**，`else` 分支里的 alert 因为条件不可表达，直接标 `guards = []` 之外加一个标记，走到 `alert` 时 `throw new Refuse("else 分支的条件无法表达")`）。
- 命中 `call` 且 `name === "alertcondition"` → 记 `Site{kind:"alertcondition", args, line, guards}`。
- 命中 `name === "alert"` → `Site{kind:"alert", args, line, guards}`。
- `decl`/`assign` 的 value 里也可能藏 alert？Pine 不允许，不处理。
- `for`/`while`/`fn` 体内的 alert call：`guards` 之外再加 `scoped = true` ⇒ 拒绝（「条件在循环/自定义函数体内，静态翻译不覆盖」）。

`buildEnv()`：遍历顶层 `decl`（`names.length === 1` 时 `env.set(name, value)`）与 `assign`；`decl.persist`（`var`）不影响 env。**多名字非 tuple 的 decl ⇒ 跳过（不进 env）**，后续引用会因解析不到而拒绝。

`translatePineAlerts()`：
1. `try { stmts = parsePine(code) } catch (e) { return [{ line:0, fn:"alertcondition", title:"", message:"", status:"refused", reason:"语法解析失败：" + msg, notes: [] }] }`（spec §9：不吞异常、不返回空数组）。
2. `sites = []`；`collectAlerts(stmts, [], sites)`。
3. `opts.interval` 不在 `BACKEND_INTERVALS` ⇒ 每个 site 直接 `status:"refused"`，reason 含周期名与建议。
4. 对每个 site 按 kind 走 `toCondition`（`alert` 的 guard 规则：`guards.length === 1 && 该 if 的 body 恰好只有这一条语句` ⇒ 用 `guards[0]`；`0` ⇒ 拒绝（「顶层 `alert()` 每根都触发，无法作为规则」）；`>1` ⇒ 拒绝）。
5. `native` 时组 `draft`：

```ts
const draft: AlertRuleDraft = {
  id: pineRuleId(opts.symbol, site.line, cond),
  kind: "market",
  title: plan.title || `alertcondition@L${site.line}`,
  symbol: opts.symbol,
  interval: opts.interval,
  count: pineCount(cond),
  adjust: opts.adjust ?? "qfq",
  condition: cond,
  for_bars: 1,
  severity: "info",
  send_resolved: true,
  session_only: false,
  targets: opts.targets ?? [],
  enabled: true,
};
```

`pineCount(cond)` = `Math.min(2000, Math.max(320, maxPeriod(cond) + 60))`，`maxPeriod` 从 `lhs`/`rhs` 的 `:N` 里取（无则 0）。`validate_rule:233/235` 的 2/2000 边界由此恒满足。
6. 任一 site 抛 `Refuse` ⇒ 该行 `status:"refused", reason: err.message, notes`；**不抛给调用方**。

- [ ] **Step 4: 跑测试确认通过**

Run：`npx vitest run src/lib/__tests__/pineAlertRules.test.ts`
Expected: PASS 全部 20 条。逐条看一遍名字，任何一条被注释掉或 `.skip` 都算未完成。

- [ ] **Step 5: 类型面与全量门禁**

Run（`frontend/`）：`npx tsc --noEmit && npx vitest run`
Expected: 静默＋全绿。

- [ ] **Step 6: 提交**

```bash
git add frontend/src/lib/pineAlertRules.ts frontend/src/lib/__tests__/pineAlertRules.test.ts
git commit -s -m "feat(pineAlertRules): Pine 告警条件静态翻译到后端 8 算子封闭语法，不可译指名拒绝"
```

---

### Task 3: 对账夹具 ＋ TS 腿（前端引擎序列就是期望值本身）

**Files:**
- Create: `frontend/src/lib/__tests__/__fixtures__/pineAlertBridge/{ema-cross-up,rsi-below-30,close-under-sma,volume-rising}.json`
- Test: `frontend/src/lib/__tests__/pineAlertBridge.test.ts`

**Interfaces:**
- Consumes：Task 1 的 `PineResult.alerts`；Task 2 的 `translatePineAlerts`（用它产出 `condition`，夹具里的期望条件与 UI 用的是同一个函数——夹具因此也是翻译器的输出快照）。
- Produces：夹具 JSON schema（Task 4 逐字依赖）：

```jsonc
{
  "name": "ema-cross-up",
  "seed": 20261006,              // bars 的确定性来源，记录以便复现
  "code": "…",                  // 完整 Pine 源码
  "interval": "1D",
  "bars": [{"timestamp": 1700000000000, "open": 1, "high": 1, "low": 1, "close": 1, "volume": 1}], // 400 根，oldest first
  "cases": [{"condition": {"op": "crossUp", "lhs": "ema:5", "rhs": "ema:20", "value": null},
             "pineHits": [false, …],   // 长度 === bars.length
             "minPrefix": 120}]         // 预热/播种暂态闸门，见 spec §7
}
```

- [ ] **Step 1: 写失败测试（读取腿 ＋ 三闸，默认不写盘）**

新建 `frontend/src/lib/__tests__/pineAlertBridge.test.ts`：

```ts
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { KLineData } from "klinecharts";
import { compilePine } from "@/lib/pineScript";
import { translatePineAlerts } from "@/lib/pineAlertRules";

const DIR = fileURLToPath(new URL("__fixtures__/pineAlertBridge", import.meta.url));
const EMIT = process.env.PINE_ALERT_FIXTURE_EMIT === "1";

/** 确定性随机游走：有涨有跌，避开 RSI 单边段（spec §7 边界分歧）。 */
function walk(seed: number, n: number): KLineData[] {
  let s = seed >>> 0;
  const rnd = () => ((s = Math.imul(s, 1664525 + 0) + 1013904223 >>> 0) / 2 ** 32);
  let close = 100;
  const out: KLineData[] = [];
  for (let i = 0; i < n; i++) {
    close = Math.max(1, close * (1 + (rnd() - 0.48) * 0.02));
    const open = close * (1 + (rnd() - 0.5) * 0.004);
    out.push({
      timestamp: 1700000000000 + i * 86400000,
      open,
      high: Math.max(open, close) * 1.004,
      low: Math.min(open, close) * 0.996,
      close,
      volume: 1e5 * (1 + rnd()),
    } as KLineData);
  }
  return out;
}

const CASES: { name: string; seed: number; code: string; minPrefix: number }[] = [
  { name: "ema-cross-up", seed: 20261006, minPrefix: 120, code:
    '//@version=5\nindicator("对账-EMA")\nalertcondition(ta.crossover(ta.ema(close,5), ta.ema(close,20)), "EMA金叉", "")' },
  { name: "ema-cross-down", seed: 777001, minPrefix: 120, code:
    '//@version=5\nindicator("对账-EMA2")\nalertcondition(ta.crossunder(ta.ema(close,9), ta.ema(close,21)), "EMA死叉", "")' },
  { name: "rsi-under-30", seed: 4242, minPrefix: 120, code:
    '//@version=5\nindicator("对账-RSI")\nalertcondition(ta.rsi(close, 14) < 30, "RSI超卖", "")' },
  { name: "close-under-sma", seed: 90210, minPrefix: 120, code:
    '//@version=5\nindicator("对账-SMA")\nalertcondition(close < ta.sma(close, 20), "跌破均线", "")' },
  { name: "volume-rising", seed: 13579, minPrefix: 120, code:
    '//@version=5\nindicator("对账-VOL")\nalertcondition(volume > volume[1], "放量", "")' },
];

function build(c: (typeof CASES)[number]) {
  const bars = walk(c.seed, 400);
  const out = compilePine(c.code, bars, { opLimit: 6e7 });
  if ("error" in out) throw new Error(`${c.name}: 脚本编译失败 ${out.error}`);
  if (out.abort) throw new Error(`${c.name}: 脚本中断 ${out.abort}`);
  const plans = translatePineAlerts(c.code, { symbol: "BRIDGE.TEST", interval: "1D" });
  if (plans.length !== 1 || plans[0].status !== "native") {
    throw new Error(`${c.name}: 翻译器没有把它当可译条件（${plans[0]?.reason ?? "无条目"}）`);
  }
  const series = out.result.alerts?.[0];
  if (!series) throw new Error(`${c.name}: 引擎没产出 alerts`);
  // 三闸之一：期望序列必须同时含 true 与 false，且在 minPrefix 之后至少命中一次。
  const trueAfter = series.hits.slice(c.minPrefix).filter(Boolean).length;
  expect(series.hits.some(Boolean), `${c.name}: 全 false 序列会让对账 trivially 通过`).toBe(true);
  expect(series.hits.some((h) => !h), `${c.name}: 全 true 序列同样没有信息`).toBe(true);
  expect(trueAfter, `${c.name}: minPrefix 之后一次都没命中，说明比较区间没有信号`).toBeGreaterThan(0);
  return {
    name: c.name, seed: c.seed, code: c.code, interval: "1D",
    bars: bars.map((b) => ({ timestamp: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume })),
    cases: [{ condition: plans[0].condition, pineHits: series.hits, minPrefix: c.minPrefix }],
  };
}

if (EMIT) {
  it("EMIT=1 生成夹具（唯一允许写被跟踪文件的分支）", () => {
    expect(existsSync(DIR), `夹具目录不存在：${DIR}`).toBe(true);
    for (const c of CASES) {
      const json = JSON.stringify(build(c), null, 1);
      // 只在显式 EMIT 下写；正常运行（EMIT!==1）永不执行到这里。
      process.stdout.write(`emit ${c.name}.json ${json.length} bytes\n`);
    }
  });
}

if (!EMIT) {
  describe("对账夹具（TS 腿）", () => {
    it("夹具目录非空——读不到就 raise，不许 skip", () => {
      if (!existsSync(DIR)) throw new Error(`夹具目录不存在：${DIR}`);
      const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
      if (files.length < 4) throw new Error(`夹具只有 ${files.length} 份，少于 4 条首批要求`);
    });

    for (const c of CASES) {
      it(`${c.name}：引擎逐根序列 === 夹具 pineHits`, () => {
        const fx = JSON.parse(readFileSync(new URL(`${c.name}.json`, import.meta.url), "utf8"));
        expect(fx.bars.length, "bars 与 pineHits 必须等长").toBe(fx.cases[0].pineHits.length);
        const rows = fx.bars as KLineData[];
        const out = compilePine(fx.code, rows, { opLimit: 6e7 });
        if ("error" in out) throw new Error(`编译失败：${out.error}`);
        const hits = out.result.alerts?.[0]?.hits;
        expect(hits, "引擎没有产出 alerts").toBeDefined();
        expect(hits).toEqual(fx.cases[0].pineHits);
        // 翻译器今天的输出必须仍是夹具里那个 condition（夹具同时是翻译器的快照）。
        const plan = translatePineAlerts(fx.code, { symbol: "BRIDGE.TEST", interval: fx.interval })[0];
        expect(plan.status).toBe("native");
        expect(plan.condition).toEqual(fx.cases[0].condition);
        expect(fx.cases[0].pineHits.slice(fx.cases[0].minPrefix).some(Boolean)).toBe(true);
      });
    }
  });
}
```

- [ ] **Step 2: 跑测试确认失败**

Run：`npx vitest run src/lib/__tests__/pineAlertBridge.test.ts`
Expected: FAIL —— 抛「夹具目录不存在」或「夹具只有 0 份」。若报 `translatePineAlerts` 的产物与手写 CASES 不符，按报错逐条核对 §6 名册，**不要为了过测试改 CASES 的源码形状**。

- [ ] **Step 3: 建目录并用 EMIT 产出夹具**

```bash
mkdir -p frontend/src/lib/__tests__/__fixtures__/pineAlertBridge
# 在 frontend/ 下：先让 EMIT 分支打印每条 JSON 到 stdout，再落盘
PINE_ALERT_FIXTURE_EMIT=1 npx vitest run src/lib/__tests__/pineAlertBridge.test.ts
```

EMIT 分支默认只打印长度。落盘的正式做法：把上面的 `EMIT` 分支里的 `process.stdout.write` 临时换成 `writeFileSync(new URL(`${c.name}.json`, import.meta.url), json)`，跑一次，**立刻把那行改回 `process.stdout.write`**（正常 CI 里绝不允许写盘）。或者用 `.qoder/tmp` 下的一个一次性 `.mjs` 脚本产出（`node` 跑不了 TS，所以走 `npx vitest run` 更省事——推荐前者，改回后 `git diff` 必须显示测试文件里没有 `writeFileSync` 的活跃调用路径）。

Expected: 目录里 5 份 `*.json`，每份 `bars.length === 400`、`pineHits.length === 400`。

- [ ] **Step 4: 跑测试确认通过**

Run：`npx vitest run src/lib/__tests__/pineAlertBridge.test.ts`
Expected: PASS 6 条（1 条目录闸 ＋ 5 条 case）。

- [ ] **Step 5: 全量门禁＋提交**

Run（`frontend/`）：`npx tsc --noEmit && npx vitest run`
Expected: 静默＋全绿。

```bash
git add frontend/src/lib/__tests__/pineAlertBridge.test.ts \
        frontend/src/lib/__tests__/__fixtures__/pineAlertBridge
git commit -s --author="$(git config user.name) <$ (git config user.email)>" -m "test(pineAlertBridge): 对账夹具与 TS 腿（引擎逐根序列即期望值）"
```

（上一条里的 `--author` 是笔误示范，**不要照抄**——正常就是 `git commit -s -m`。执行者用：`git commit -s -m "test(pineAlertBridge): 对账夹具与 TS 腿"`。）

---

### Task 4: Python 对账腿（后端 `evaluate_condition` 逐前缀）

**Files:**
- Create: `agent/tests/test_alerts_pine_reconciliation.py`

**Interfaces:**
- Consumes：Task 3 的夹具 JSON（路径 `frontend/src/lib/__tests__/__fixtures__/pineAlertBridge/*.json`）；`src.alerts.conditions.EvalContext` / `evaluate_condition`（`conditions.py:63/432`，`agent/tests/conftest.py:15-18` 已把 `agent/` 挂上 `sys.path`，`pyproject.toml:285` 也有 `pythonpath = ["agent"]`）。
- Produces：无（终点消费者）。

- [ ] **Step 1: 写测试**

```python
"""Cross-implementation reconciliation for the Pine alert bridge (spec §7).

The Pine interpreter and the backend alert kernel are two independent
implementations of "does this condition hold on this bar". This test makes them
answer the same question on the same literal bars, prefix by prefix, so a
translation that means something different on the server cannot survive CI.

The bars arrive from the committed fixture, so both sides read identical
numbers — no regeneration, no tolerance. `minPrefix` skips the warm-up/seed
transient (backend `_compute_rsi` does not pass `adjust=False`, frontend
`rmaStep` SMA-seeds), which is also nowhere a real rule sits: production
evaluates on a `count`-bar window (default 320).
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, List

import pytest

from src.alerts.conditions import EvalContext, evaluate_condition

FIXTURE_DIR = (
    Path(__file__).resolve().parents[2]
    / "frontend" / "src" / "lib" / "__tests__" / "__fixtures__" / "pineAlertBridge"
)


def _fixtures() -> List[Dict[str, Any]]:
    """Load every bridge fixture, refusing to pretend an absent directory is empty."""
    if not FIXTURE_DIR.is_dir():
        raise AssertionError(f"fixture dir missing: {FIXTURE_DIR}")
    files = sorted(p for p in FIXTURE_DIR.glob("*.json"))
    if not files:
        raise AssertionError(f"no bridge fixtures under {FIXTURE_DIR}")
    return [json.loads(p.read_text(encoding="utf-8")) for p in files]


def _cases():
    for fx in _fixtures():
        for case in fx["cases"]:
            yield fx, case


@pytest.mark.parametrize("fx,case", list(_cases()), ids=[c[0]["name"] for c in _cases()])
def test_backend_agrees_with_pine_bar_by_bar(fx: Dict[str, Any], case: Dict[str, Any]) -> None:
    bars = fx["bars"]
    hits = case["pineHits"]
    min_prefix = int(case["minPrefix"])
    assert len(hits) == len(bars), f"{fx['name']}: pineHits/bars length mismatch"
    assert min_prefix >= 100, f"{fx['name']}: minPrefix must clear the seed transient"

    compared = 0
    for prefix in range(min_prefix, len(bars) + 1):
        ctx = EvalContext(symbol="BRIDGE.TEST", bars=bars[:prefix])
        res = evaluate_condition(case["condition"], ctx)
        assert res.error is None, (
            f"{fx['name']}: bar {prefix - 1} not measurable ({res.error}); a failure "
            f"is not a verdict, and comparing it as False would be a false green"
        )
        assert res.hit == hits[prefix - 1], (
            f"{fx['name']}: bar {prefix - 1} diverges "
            f"(backend={res.hit} pine={hits[prefix - 1]}, value={res.value})"
        )
        compared += 1
    assert compared >= 100, f"{fx['name']}: only {compared} prefixes compared"


def test_no_hit_before_min_prefix():
    """Before the warm-up gate the backend must never announce a hit (spec §7)."""
    total = 0
    for fx, case in _cases():
        hits = case["pineHits"]
        min_prefix = int(case["minPrefix"])
        for prefix in range(2, min_prefix):
            ctx = EvalContext(symbol="BRIDGE.TEST", bars=fx["bars"][:prefix])
            res = evaluate_condition(case["condition"], ctx)
            assert not res.hit, f"{fx['name']}: hit at prefix {prefix}, before the gate"
            total += 1
    assert total > 0, "checked no short prefixes at all"


def test_at_least_one_true_and_one_false_per_case():
    """Anti-false-green: an all-False series would satisfy the equality trivially."""
    for fx, case in _cases():
        hits = case["pineHits"]
        assert any(hits) and not all(hits), f"{fx['name']}: series carries no information"
        tail = hits[int(case["minPrefix"]):]
        assert any(tail), f"{fx['name']}: no hit inside the compared region"


def test_bridge_cases_are_never_empty():
    rows = list(_cases())
    assert len(rows) >= 4, f"only {len(rows)} bridge cases; spec §7 requires >= 4"
```

- [ ] **Step 2: 跑测试**

Run（仓库根）：`python -X utf8 -m pytest agent/tests/test_alerts_pine_reconciliation.py -q`
Expected: 先看到它**通过或诚实失败**。若失败信息是 `bar N diverges (backend=True pine=False)`，说明 §6 名册里那一行的两边语义确实不同 ⇒ 按 spec §7 的收口方向**把该序列从 `pineAlertRules.ts` 的名册里摘掉**（不是放宽容差、不是加大 minPrefix 蒙过去），并在 Task 2 的测试里把那条 case 改成拒绝断言。若摘掉后 CASES 少一条，把 `test_bridge_cases_are_never_empty` 的下限同步改小**是错的**——改成用另一条可译序列补上（如 `close > open` 的 `gt`）。

- [ ] **Step 3: 反证（证明这条腿是活的）**

临时把任一夹具的 `pineHits` 里某一根 `false` 改成 `true`（改内存副本，不落盘）：在测试文件里临时加 `hits[i] = not hits[i]`（i 取 compared 区间中点），跑一次，**必须红**且报出那一根的 bar 号。然后删掉那行。

Run：`python -X utf8 -m pytest agent/tests/test_alerts_pine_reconciliation.py -q`
Expected: 加行时 FAIL（点名 bar 号与两侧值），删行后 PASS。

- [ ] **Step 4: 提交**

```bash
git add agent/tests/test_alerts_pine_reconciliation.py
git commit -s -m "test(alerts): Pine 桥对账——后端 evaluate_condition 逐前缀等于引擎逐根序列"
```

---

### Task 5: `AlertsTab` 面板与 workbench 接线

**Files:**
- Create: `frontend/src/components/charts/workbench/AlertsTab.tsx`
- Create: `frontend/src/components/charts/__tests__/PineAlertsTab.test.tsx`
- Modify: `frontend/src/components/charts/workbench/types.ts:24`
- Modify: `frontend/src/components/charts/IndicatorEditor.tsx`（`TABS` `:57-63`、`IndicatorEditorProps` `:40-55`、渲染块 `:289-320`）
- Modify: `frontend/src/pages/ProChart.tsx:2030-2038`

**Interfaces:**
- Consumes：Task 2 的 `translatePineAlerts`/`PineAlertPlan`/`pineRuleId`/`BACKEND_INTERVALS`；Task 1 的 `PineResult.alerts`；`alertsApi`（`createRule`/`listRules`/`listTargets`/`describeCondition`，`alertsApi.ts:272-331/368`）；`IntervalKey`（`marketApi.ts:18`）；`compilePine`（`pineScript.ts:177`）。
- Produces：`AlertsTabProps`（Task 6 与后续页面无依赖，但 `IndicatorEditor` 的调用形状在此定死）：

```ts
interface AlertsTabProps {
  draft: Draft;
  getChart: () => Nullable<Chart>;
  /** 图表当前标的（loader 拼写，如 600519.SH），进规则 symbol。 */
  symbol: string;
  interval: IntervalKey;
  /** 图表当前复权档；进规则 adjust（spec §6：口径不一致 close 就不是同一个数）。 */
  adjust: string;
  /** 数据缝，与 ScreenerTab 同范式；测试不联网。 */
  loadBars?: BarLoader;
}
```

- [ ] **Step 1: 写失败测试**

```tsx
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { KLineData } from "klinecharts";

vi.mock("klinecharts", () => ({ registerIndicator: vi.fn() }));

import AlertsTab from "../workbench/AlertsTab";
import { EMPTY_DRAFT } from "../workbench/types";
import * as alertsApi from "@/lib/alertsApi";

const BARS = Array.from({ length: 300 }, (_, i) => {
  const close = 100 + 6 * Math.sin(i / 3) + i * 0.05;
  return { timestamp: 1700000000000 + i * 86400000, open: close, high: close + 1, low: close - 1, close, volume: 1000 + i } as KLineData;
});

const chart = { getDataList: () => BARS } as unknown as () => never;

const NATIVE = '//@version=5\nindicator("t")\nalertcondition(ta.crossover(ta.ema(close,5), ta.ema(close,20)), "EMA金叉", "")';
const REFUSED = '//@version=5\nindicator("t")\nalertcondition(close >= 1700, "越界", "")';

afterEach(() => vi.restoreAllMocks());

function renderTab(code: string) {
  return render(
    <AlertsTab draft={{ ...EMPTY_DRAFT, code }} getChart={chart as never} symbol="600519.SH" interval="1D" adjust="qfq" />,
  );
}

it("可译条目显示后端条件文案与引擎命中根号，并有创建按钮", async () => {
  vi.spyOn(alertsApi.alertsApi, "listTargets").mockResolvedValue({ targets: [], channels: ["napcat"] });
  vi.spyOn(alertsApi.alertsApi, "listRules").mockResolvedValue([]);
  renderTab(NATIVE);
  await waitFor(() => expect(screen.getByText("EMA金叉")).toBeInTheDocument());
  expect(screen.getByText(/上穿/)).toBeInTheDocument(); // describeCondition 的中文文案
  expect(screen.getByRole("button", { name: /创建|更新/ })).toBeEnabled();
});

it("不可译条目没有创建按钮，reason 原文可见", async () => {
  vi.spyOn(alertsApi.alertsApi, "listTargets").mockResolvedValue({ targets: [], channels: [] });
  vi.spyOn(alertsApi.alertsApi, "listRules").mockResolvedValue([]);
  renderTab(REFUSED);
  await waitFor(() => expect(screen.getByText("越界")).toBeInTheDocument());
  expect(screen.getByText(/>=/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /创建|更新/ })).toBeNull();
});

it("创建走 alertsApi.createRule，draft 带 symbol/interval/condition 与确定性 id", async () => {
  const create = vi.spyOn(alertsApi.alertsApi, "createRule").mockResolvedValue({ id: "pine_x", condition: { op: "crossUp" } } as never);
  vi.spyOn(alertsApi.alertsApi, "listTargets").mockResolvedValue({ targets: [], channels: [] });
  vi.spyOn(alertsApi.alertsApi, "listRules").mockResolvedValue([]);
  renderTab(NATIVE);
  fireEvent.click(await screen.findByRole("button", { name: /创建|更新/ }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  const draft = create.mock.calls[0][0];
  expect(draft).toMatchObject({ symbol: "600519.SH", interval: "1D", kind: "market", adjust: "qfq" });
  expect(draft.id).toMatch(/^pine_/);
  expect(draft.condition).toMatchObject({ op: "crossUp", lhs: "ema:5", rhs: "ema:20" });
});

it("周月线周期不给创建按钮（后端没有这两个周期）", async () => {
  vi.spyOn(alertsApi.alertsApi, "listTargets").mockResolvedValue({ targets: [], channels: [] });
  vi.spyOn(alertsApi.alertsApi, "listRules").mockResolvedValue([]);
  render(<AlertsTab draft={{ ...EMPTY_DRAFT, code: NATIVE }} getChart={chart as never} symbol="600519.SH" interval="1W" adjust="qfq" />);
  await waitFor(() => expect(screen.getByText("EMA金叉")).toBeInTheDocument());
  expect(screen.queryByRole("button", { name: /创建|更新/ })).toBeNull();
  expect(screen.getByText(/1W/)).toBeInTheDocument();
});

it("已有同 id 规则且条件被手改过 ⇒ 先确认再覆盖，不静默吃掉", async () => {
  // listRules 返回一条同 id、condition 不同的规则；点创建应先出现确认文案。
  …（实现者按 createRule 的 draft id 先算出来，再在 mock 的 listRules 里放一条同 id 不同 condition 的行）…
});
```

最后一条测试的正文由实现者按 Step 3 的实现补全（它是本 Task 的验收项之一，**不能删**）：断言「在未确认前 `createRule` 调用次数为 0，出现确认提示后点『确认覆盖』才为 1」。

- [ ] **Step 2: 跑测试确认失败**

Run：`npx vitest run src/components/charts/__tests__/PineAlertsTab.test.tsx`
Expected: FAIL —— 模块不存在。

- [ ] **Step 3: 实现面板**

`AlertsTab.tsx` 的结构要求（组件全文由实现者写，每条都是硬要求，不是建议）：

1. 取 `getChart()?.getDataList()`；非 Pine 方言（`detectDialect(draft.code) !== "pine"`）或 bars 为空时 `return null`，与 `EditorTab.tsx:83-88` 一致。
2. 与 `EditorTab` 同款 450ms debounce，一次 `compilePine(draft.code, bars, { opLimit: 6e6 })`；把 `out.result.alerts` 与 `translatePineAlerts(draft.code, {symbol, interval, adjust, targets})` 的产物**按 `line` 配对**（翻译器与引擎都给 `line`；配不上的条目——比如解析失败时翻译器的那条 `line:0`——单独成行显示）。
3. 每行显示：`title`（缺失退化 `alertcondition@L{line}`）｜状态徽标（可译 / 不可译）｜`describeCondition(plan.condition)`｜引擎命中根号列表（`hits` 里 true 的下标，最多列 8 个再跟「…共 N 根」）｜`message` 原文（标注「不进后端」）｜按钮。
4. 按钮文案：`listRules()` 里没有同 id ⇒ 「创建」；有同 id 且条件相同 ⇒ 「已建，条件一致」；有同 id 但条件不同 ⇒ 先 `window` 内置的二次确认（用面板内状态，不用 `confirm()`），文案含现有条件，确认后才 PUT。
5. 顶部设置行：推送目标（`listTargets()` 的 `targets`/`channels`，可多选）、`for_bars`、`severity`、`send_resolved`。默认值持久化 `localStorage["pro-chart.pineAlerts.v1"]`（同 `ScreenerTab.tsx:44` 范式）。**目标为空时**渲染一行警告：「未选择推送目标，规则只会记录不会通知」＋ `/alerts` 链接。
6. 底部「后端已有但本脚本已删除的 pine 规则」列表（用 id 前缀 `pine_` ＋ symbol 匹配），每行一个删除按钮（`alertsApi.deleteRule`）。
7. `interval` 不在 `BACKEND_INTERVALS` 时：整组按钮禁用，并在每行 reason 里带上周期名（spec §6）。
8. 所有文案中文字面量，不动 locale 文件。

`types.ts:24`：`export type TabKey = "editor" | "library" | "exchange" | "report" | "screener" | "alerts";`

`IndicatorEditor.tsx`：`IndicatorEditorProps` 加三个可选 `symbol?: string`（默认 `""`）、`interval?: IntervalKey`（默认 `"1D"`）、`adjust?: string`（默认 `"qfq"`）；`TABS` 在 `screener` 之后加 `{ key: "alerts", label: "脚本告警" }`；渲染块加

```tsx
          {tab === "alerts" && (
            <AlertsTab draft={draft} getChart={getChart} symbol={symbol} interval={interval} adjust={adjust} loadBars={loadBars} />
          )}
```

`ProChart.tsx:2030-2038` 的 `<IndicatorEditor …>` 里补 `symbol={symbol}`（用该页现有的当前标的状态名，实现前先 grep 确认真名——`applySymbol` 与 `intervalAllowed(symbol, …)` 的调用点会指出来）、`interval={view.interval}`、`adjust={当前复权状态}`。若 ProChart 里复权不在 state 而在 DataLoader 参数里，就传该处的值，**不要新增一个第二真相源**。

- [ ] **Step 4: 跑测试确认通过**

Run：`npx vitest run src/components/charts/__tests__/PineAlertsTab.test.tsx`
Expected: PASS 5 条。

- [ ] **Step 5: 全量门禁＋提交**

Run（`frontend/`）：`npx tsc --noEmit && npx vitest run && npx vite build`
Expected: 静默＋全绿＋构建成功（既有分包体积告警不算红）。

```bash
git add frontend/src/components/charts/workbench/AlertsTab.tsx \
        frontend/src/components/charts/__tests__/PineAlertsTab.test.tsx \
        frontend/src/components/charts/workbench/types.ts \
        frontend/src/components/charts/IndicatorEditor.tsx \
        frontend/src/pages/ProChart.tsx
git commit -s -m "feat(workbench): 脚本告警页签——翻译结果与引擎判定并排，一键建后端规则"
```

---

### Task 6: 语料覆盖率守卫、变异探针、门禁复跑与活体验收

**Files:**
- Create: `frontend/src/lib/__tests__/pineAlertCorpus.test.ts`

**Interfaces:**
- Consumes：Task 2 的 `translatePineAlerts`；仓库里的真实语料 `frontend/src/lib/__tests__/__fixtures__/corpus/**/*.pine`（已跟踪，只读）。
- Produces：一个数字——`N 条 alertcondition / M 条可译`，以及 reason 分布。

- [ ] **Step 1: 写守卫测试**

```ts
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { translatePineAlerts } from "@/lib/pineAlertRules";

const ROOT = fileURLToPath(new URL("__fixtures__/corpus", import.meta.url));

function pineFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = `${dir}/${name}`;
    if (statSync(p).isDirectory()) out.push(...pineFiles(p));
    else if (name.endsWith(".pine")) out.push(p);
  }
  return out;
}

it("语料里的 alertcondition 有可译的，且拒绝必须报得出原因", () => {
  const files = pineFiles(ROOT);
  if (files.length === 0) throw new Error(`语料目录为空：${ROOT}`);
  let total = 0;
  let native = 0;
  const reasons = new Map<string, number>();
  for (const f of files) {
    const code = readFileSync(f, "utf8");
    if (!code.includes("alertcondition")) continue;
    const plans = translatePineAlerts(code, { symbol: "600519.SH", interval: "1D" });
    for (const p of plans) {
      total += 1;
      if (p.status === "native") native += 1;
      else reasons.set(p.reason?.slice(0, 24) ?? "?", (reasons.get(p.reason?.slice(0, 24) ?? "?") ?? 0) + 1);
    }
  }
  process.stdout.write(`\n[bridge-coverage] alertcondition=${total} native=${native}\n`);
  for (const [r, n] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    process.stdout.write(`  ${n}× ${r}\n`);
  }
  expect(total, "语料里没有任何 alertcondition 被找到，说明遍历或匹配坏了").toBeGreaterThan(0);
  expect(native, "可译数为 0：翻译器被改哑了也不会红，必须有下限").toBeGreaterThan(0);
});
```

- [ ] **Step 2: 跑，记下真实 N/M**

Run：`npx vitest run src/lib/__tests__/pineAlertCorpus.test.ts`
Expected: PASS，stdout 打出 `[bridge-coverage] alertcondition=N native=M`。**把这两个数原样记进交付说明**（spec §11.5：覆盖率是量出来的，不是形容词）。若 `native === 0`，逐条看 reason 分布，判断是名册太窄（按 spec 接受）还是遍历/匹配坏了（必须修）。

- [ ] **Step 3: 变异探针（四处，逐处必须杀得掉）**

按 `verify-mutation-probe-windows-harness` 的调用细节（Windows：needle 大小写、CRLF、盘符），在 `.qoder/tmp/` 下一个一次性 `.mjs` 或直接手工改后 `git restore --worktree` 还原（**禁止 `git checkout --`**；且改前确认这些文件是干净的）：

| 针 | 改法 | 必须红的测试 |
|---|---|---|
| ① na 当命中 | `pineRuntime.ts` 里 `isTrue(this.val(cond))` → `!Number.isNaN(asNum(this.val(cond))) \|\| true` 之类恒真 | `pineAlertSeries.test.ts` 的「na 不是命中」 |
| ② `>=` 译成 `gt` | `pineAlertRules.ts` 去掉 `>=`/`<=` 的拒绝分支 | `pineAlertRules.test.ts` 的「>= 没有对应算子」 |
| ③ `and` 只取左半边 | `toCondition` 对 `bin("and")` 返回 `toCondition(a)` | `pineAlertRules.test.ts` 的 and/or/not 用例 |
| ④ 空 cases 被跳过 | Python 腿把 `raise AssertionError` 换成 `return []` | `test_alerts_pine_reconciliation.py::test_bridge_cases_are_never_empty` |
| ⑤ pineHits 全 false 也算过 | 对账腿删掉 `test_at_least_one_true_and_one_false_per_case` 后，TS 腿那条必须仍红（互备） | 两条腿之一 |

杀不掉的按三态裁定（HARNESS-BLIND 与等价变异成因）写清是哪一种、为什么，不许含糊成「大概有用」。

- [ ] **Step 4: 全量门禁复跑（每条都署坐标）**

```bash
# frontend/
npx tsc --noEmit
npx vitest run
npx vite build
# 仓库根
python -X utf8 -m pytest agent/tests/test_alerts_pine_reconciliation.py -q
python -X utf8 -m pytest tools/test_wiki_drift.py -q
bash tools/wiki_freshness_gate.sh; echo "gate rc=$?"
python -X utf8 tools/wiki_drift.py stale --format count
bash tools/ci_grep_gates.sh
git -c core.quotepath=off diff --name-only upstream/main...HEAD | grep -E '^(\.gitignore|tools/ci_grep_gates\.sh|\.github/workflows/test\.yml|wiki/)' || echo NONE
```

Expected：tsc 静默；vitest 全绿且文件数比基线 +4；wiki 套件绿；水位 = 443（与开工基线同值 ⇒ 本片没新欠账）或**更低**（更好）；`ci_grep_gates.sh` 只有 `./.qoder/` 命中的那条既有红；最后一条必须 `NONE`，且**先做 canary**（把过滤式里的一个已知 fork 新增路径 `tools/wiki_drift\.py` 换上，必须命中 1 条，否则这条 NONE 等于没测）。

- [ ] **Step 5: 活体验收＋未来函数自查**

启动（用户本机口径：后端 8000、前端 5899；`frontend/vite.config.ts` 的 `apiTarget` 出厂 8899 必改）：

```bash
# 仓库根，两个终端
python -m uvicorn agent.api_server:app --port 8000
cd frontend && npx vite --port 5899
```

浏览器进 `/pro-chart`，打开脚本工作台「脚本告警」页签，逐条取真读数：

1. 一条可译（EMA 金叉）：面板显示的引擎命中根号，与图上把该条件 `plot` 出来的标记位置一致；点创建，回 `/alerts` 页确认规则存在、`describe_condition` 文案是「收盘/EMA…」这条、状态列可见。
2. 一条不可译（`close >= 1700`）：无按钮、reason 原文。
3. 一条 `interval` 切到周线：整组禁用并点名 `1W`。
4. `POST /alerts/run?deliver=false`（或面板/告警页的等价入口）对新建规则出 dry-run 判定，`hit`/`reason`/`bars` 三个字段有值。
5. 未来函数自查：在同一条规则上 `POST /alerts/rules/{id}/dry-run`，把 `count` 改小到刚好覆盖某个历史命中根，确认后端报出的 `value` 与 `bars` 落在**已收盘那根**而不是在飞的那根；面板上「最新一根未收盘也可能被判定」这条风险如果存在，必须在 UI 里写明（后端 `poll_interval_ms` 默认 300s，取数走 loader 的已收盘序列）。

拿不到浏览器或后端起不来时，**明确说没测**，不要用类型检查和单测冒充活体验收（本仓纪律：交付端点必须探真实进程）。

- [ ] **Step 6: 提交守卫并登记档案**

```bash
git add frontend/src/lib/__tests__/pineAlertCorpus.test.ts
git commit -s -m "test(pineAlertRules): 语料覆盖率下限守卫（alertcondition 可译数不得静默归零）"
```

档案登记（可选但推荐）：仓库根 `项目档案.md` 新增 **§7.13**，按 `ops-repo-wiki-git-root-and-update` 的配方——CRLF 工作树在 **bytes 层追加**（纯追加，0 删除），登记内容含：三层结构、后端零改动、对账夹具与三闸、语料 N/M 真实读数、门禁读数（含水位前后两个数与坐标）。改完复跑：

```bash
python -X utf8 -m pytest tools/test_wiki_drift.py -q
python -X utf8 tools/wiki_drift.py stale --format count
bash tools/wiki_freshness_gate.sh; echo "rc=$?"
```

（交付态复跑只会落台账，档案面排最后一笔，见 `verify-self-referential-doc-readings`。）

---

## 自检（写完后跑过一遍）

- **spec 覆盖**：§5 运行时→Task 1；§6 语法表与拒绝→Task 2；§7 对账三闸与 minPrefix 暂态→Task 3/4；§8 面板八条硬要求→Task 5；§11.5 覆盖率、§11.6 活体、§11.7 变异探针→Task 6；§1 非目标（freq/message/复合语法/会话态）在 Global Constraints 与各任务代码注释里逐条重申为「不做」。spec §9 的「已有同 id 被手改 ⇒ 二次确认」是 Task 5 Step 1 最后一条测试，正文留待实现者补全——这是本计划唯一一处刻意留白，且它带着明确的断言要求，不是 TBD。
- **类型一致性**：`PineAlertSeries{line,fn,title,message,hits}` 在 Task 1 定义、Task 3 消费 `alerts?.[0].hits`、Task 5 消费 `line` 配对；`PineAlertPlan{line,fn,title,message,status,condition?,draft?,reason?,notes}` 在 Task 2 定义、Task 3 消费 `condition`、Task 5 消费全部；`pineRuleId` 的 `pine_…` 形状在 Task 2 定义、Task 5 的 id 前缀匹配与测试断言 `^pine_` 一致；夹具 schema（`name/seed/code/interval/bars/cases[{condition,pineHits,minPrefix}]`）在 Task 3 产出、Task 4 逐字读取。
- **占位符扫描**：Task 5 Step 3 是「组件全文由实现者写」＋ 8 条硬要求，属于结构性描述而非可抄代码——这是有意的（React 呈现层照抄 200 行 JSX 反而更容易与现有样式冲突），但每条要求都可判真假；其余每个代码步都给了可运行代码。Task 3 Step 5 的 `--author` 行是**故意保留的反例**并当场标注「不要照抄」，执行者按下面的更正提交。

**更正（自检时发现的一处自身错误，执行者按此做）**：Task 3 Step 5 给的 `git commit --author=…` 命令是错的且语法本身跑不通（`$ (git config user.email)` 带空格会被当成位置参数）。正确就是：

```bash
git add frontend/src/lib/__tests__/pineAlertBridge.test.ts \
        frontend/src/lib/__tests__/__fixtures__/pineAlertBridge
git commit -s -m "test(pineAlertBridge): 对账夹具与 TS 腿（引擎逐根序列即期望值）"
```
