# L3 第⑥片：自定义周期档 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `/chart` 单图页把「单位＋数值 → 一条新的周期档 → 图上真的按这个倍数出 K 线」做成用户可见的闭环，并按 TV-CI-09／10 的凭据复刻对话框与单位弹层的可达结构。

**Architecture:** 一枚纯模块持有自定义档文法与换算（`lib/customInterval.ts`），`lib/marketApi.ts` 把「内置八档的表」与「自定义串的推导」合流成唯一出入口（`resolutionOf`／`intervalMsOf`／`intervalToPeriod`／`periodToInterval`），对话框与目录是两个受展示组件，页面（`ProChart.tsx`）持有自定义档清单与选中态。取数只有一条通道：自定义档走与内置行逐字相同的 `pickInterval → setView → fetchKline` 路径。

**Tech Stack:** React 18 ＋ TypeScript ＋ Vitest ＋ @testing-library/react；后端 FastAPI ＋ pytest（本片不改后端语义，只加一枚对账测试）。

**Spec:** `superpowers/specs/2026-10-22-l3-slice6-custom-interval-dialog-design.md`（提交 `e0b1349d`）——本计划按它论证，冲突时以 spec 为准。

## Global Constraints

- 类型加宽只加一层：`IntervalKey` 那八枚**不动**（`INTERVALS`、分时、screener 靠它穷举）；新加的是 `AnyInterval = string` 与守卫 `isBuiltinInterval`。
- 内置八档的三件套输出（`resolutionOf`／`intervalMsOf`／`intervalToPeriod`）必须与既有的 `RESOLUTION_BY_INTERVAL`／`INTERVAL_MS`／`CALENDAR_PERIODS` 逐字节同值——`frontend/src/lib/__tests__/udfTransport.test.ts:113` 那枚「八档 exhaustive 钉」与 `frontend/src/lib/__tests__/marketApiPeriods.test.ts:43,50-56` 的往返钉**一枚都不许改口**，它们红了就说明加宽顺手改了内置拼写。
- 数值边界（`1..999`；分钟/小时换算后 ≤ `1440`；日/周/月倍数 ≤ `366`）是本仓自己的规则，注释与测试里都不许写成「对面的规则」（凭据里没有，spec §4）。
- 不复刻 doubled 可达名、不做 `aria-modal`／焦点陷阱、不做两层 treegrid、不做收藏列、不做 `range` 档（Type 弹层五档），只接 `/chart`，不碰 `/multi-chart` 的格子取数。
- `frontend/src/**` 里不写对面的控件名／档位名／键值；目录与对话框文案全用自家中文；九语言 locale 不为本片新开通道（周期目录本来就是硬编码中文）。
- 改签名与改消费者**必须在同一笔提交里**（分两笔中间态 `tsc -b` 必红）；测试文件里 import 了不消费会吃 TS6133。
- 提交一律 `git commit -s` ＋显式 pathspec，绝不 `git add -A`／`.`／`-a`；暂存后 `git status --porcelain` 复核。
- 取证动作边界：自动化活体只允许打开类动作（`goto`／`click`／`wait_for*`，`press` 只许 Escape）；`fill` 禁用 ⇒ spec §8 第 4～5 步不许用 REA 跑。
- 交易指标禁未来函数：本片不引入任何前视通道；自定义档的折叠锚点完全复用第⑤片服务端已钉的 `calendar_group_key`。

---

### Task 1：`lib/customInterval.ts` 纯模块（文法 · 边界 · 换算）＋后端文法对账

**Files:**
- Create: `frontend/src/lib/customInterval.ts`
- Create: `frontend/src/lib/__tests__/customInterval.test.ts`
- Create: `agent/tests/test_interval_spec_frontend_align.py`
- Modify: 无（本笔不碰任何消费者）

**Interfaces:**
- Consumes: 无（零依赖，只 import type 自己）
- Produces:
  - `type IntervalUnit = "minute" | "hour" | "day" | "week" | "month"`
  - `const CUSTOM_UNITS: readonly { unit: IntervalUnit; label: string }[]`（顺序＝分钟／小时／日／周／月）
  - `type CustomIntervalDraft = { unit: IntervalUnit; n: number | null }`
  - `function validateDraft(draft: CustomIntervalDraft): { ok: true; spec: string } | { ok: false; reason: string }`
  - `function draftToSpec(draft: CustomIntervalDraft & { n: number }): string`（2026-10-22 预检改口：原写 `Exclude<CustomIntervalDraft, { n: null }>`，`CustomIntervalDraft` 是单一对象类型不是联合，`Exclude` 分配后原样返回、`null` 剥不掉，strict 下实现体编不过）
  - `function parseSpec(text: string): { unit: "m" | "D" | "W" | "M"; n: number } | null`
  - `function isCustomSpec(text: string): boolean`（合法**自定义**档＝文法合法 ∧ 非内置八档 ∧ 过**跨度**那把尺。2026-10-22 Task 2 修复轮改口：原写「文法合法**且**不是内置八档之一」，那把尺里没有 `1..999`／分钟≤`1440`／日周月≤`366`，于是 `normalizeInterval("9999m")` 放行、对话框的「加入」却拒收同一枚数 ⇒ 边界收进谓词，只此一处拼写；下方代码块同批改。**同日 Task 3 Step 0 二次改口**：那一轮实现用「委托 `validateDraft`」取得边界，把只管手打数的 `1..999` 也套到了串上，而串里那个数**已经是折算后的跨度**（小时档 `n=17..24` 造的 `1020m…1440m` 因此「发得出、收不下」）⇒ 委托撤销，两侧改共用的 `durationOk` 一处拼写，spec §4 同日补「两把尺的分界」那条。Task 1 那五枚既存针（`120m`／`2D` 真、八枚内置假、`0m`／`2h` 假）与 I-2 四枚（`999m`／`366D` 真、`367D`／`9999m` 假）逐枚推演仍绿，`1000m` 那枚按跨度翻面为真；执行席必须当场跑过）
  - `function specLabel(text: string): string | null`
  - `function specMs(text: string): number | null`
  - `function specPeriodShape(text: string): { type: "minute" | "day" | "week" | "month"; span: number } | null`

- [ ] **Step 1：先写后端那一半对账表（它定义「什么算合法」），跑起来看它红**

Create `agent/tests/test_interval_spec_frontend_align.py`。样本表分三桶，**逐字**写在 Python 里；桶名与成员就是判据：

```python
"""前端自定义档文法的对账针：前端只许产出服务端认得的拼写。

两枚测试（这份 ＋ `frontend/src/lib/__tests__/customInterval.test.ts`）各自逐字
抄一遍同一批串，谁也不 import 谁——共享夹具会让「前后端对齐」退化成自证。
"""

import pytest

from src.api.interval_spec import parse_interval

#: 文法桶：两侧都必须接受。前端产出的每一条都得落在这里。
AGREED_OK = ["5m", "7m", "120m", "240m", "999m", "2D", "3W", "4M", "12M", "1m", "1D", "1W", "1M"]
#: 文法桶：两侧都必须拒绝。
AGREED_REJECT = ["", " ", "abc", "m", "0m", "-5m", "2.5m", "1d", "120X", "1S", "1tick", "2h", "M", "D"]
#: 边界桶：服务端受、前端拒。前端多出的那把尺是本仓自己的规则（spec §4），
#: 这一桶**只登记差异**，不许被当成「前后端不一致」的缺陷，也不许拿它推对面。
FRONTEND_ONLY_REJECT = ["1000m", "1441m", "367D", "400W", "500M"]


@pytest.mark.parametrize("text", AGREED_OK)
def test_agreed_ok_round_trips_as_itself(text):
    assert parse_interval(text) is not None, text
    assert parse_interval(text).interval == text, text


@pytest.mark.parametrize("text", AGREED_REJECT)
def test_agreed_reject_is_refused(text):
    assert parse_interval(text) is None, text


@pytest.mark.parametrize("text", FRONTEND_ONLY_REJECT)
def test_frontend_cap_is_stricter_than_the_server(text):
    """登记在册的那把额外的尺：服务端收，前端不收。改了这里要先改前端。"""
    assert parse_interval(text) is not None, text
```

Run: `cd agent && python -m pytest tests/test_interval_spec_frontend_align.py -q`
Expected: PASS（服务端第⑤片已把这些形状落地；若 `12M`／`999m` 里某条红，那是**本计划写错了样本表**，按 `parse_interval` 的真实读数改样本，不改服务端）。

- [ ] **Step 2：写前端单测（RED）**

Create `frontend/src/lib/__tests__/customInterval.test.ts`，三桶样本表**逐字抄 Step 1 那两份 Python 清单**（AGREED_OK／AGREED_REJECT／FRONTEND_ONLY_REJECT 同名同成员），再写：

```ts
import { describe, expect, it } from "vitest";

import {
  CUSTOM_UNITS,
  draftToSpec,
  isCustomSpec,
  parseSpec,
  specLabel,
  specMs,
  specPeriodShape,
  validateDraft,
} from "../customInterval";

const AGREED_OK = ["5m", "7m", "120m", "240m", "999m", "2D", "3W", "4M", "12M", "1m", "1D", "1W", "1M"];
const AGREED_REJECT = ["", " ", "abc", "m", "0m", "-5m", "2.5m", "1d", "120X", "1S", "1tick", "2h", "M", "D"];
const FRONTEND_ONLY_REJECT = ["1000m", "1441m", "367D", "400W", "500M"];
const BUILTIN = ["1m", "5m", "15m", "30m", "60m", "1D", "1W", "1M"];

describe("前后端文法对账（Python 侧同名样本表：agent/tests/test_interval_spec_frontend_align.py）", () => {
  it("文法合法的串，前端也认，并且能原样拼回去", () => {
    for (const text of AGREED_OK) {
      expect(parseSpec(text), text).not.toBeNull();
      if (!BUILTIN.includes(text)) expect(draftToSpec(parseSpecToDraft(text)), text).toBe(text);
    }
  });
  it("文法非法的串一律不认，且不抛", () => {
    for (const text of AGREED_REJECT) expect(parseSpec(text), text).toBeNull();
  });
  it("服务端收、前端越界拒：validateDraft 给原因，parseSpec 照旧收", () => {
    for (const text of FRONTEND_ONLY_REJECT) {
      const parsed = parseSpec(text);
      expect(parsed, text).not.toBeNull();
      const verdict = validateDraft({ unit: unitOfParsed(parsed!), n: parsed!.n });
      expect(verdict.ok, text).toBe(false);
      if (!verdict.ok) expect(verdict.reason.length, text).toBeGreaterThan(0);
    }
  });
});
```

补两枚测试内私有的小助手（写在同一文件顶部，不进生产码）：

```ts
/** 把已解析的串还原成对话框持有的草案（`m` 若是 60 的倍数优先报小时）。 */
const parseSpecToDraft = (p: { unit: "m" | "D" | "W" | "M"; n: number }): { unit: string; n: number } =>
  p.unit === "m" && p.n % 60 === 0 && p.n >= 60 ? { unit: "hour", n: p.n / 60 } : { unit: p.unit, n: p.n };
const unitOfParsed = (p: { unit: string }): "minute" | "hour" | "day" | "week" | "month" =>
  p.unit === "m" ? "minute" : p.unit === "D" ? "day" : p.unit === "W" ? "week" : "month";
```

再加结构与换算四组钉（逐条给期望，不留「类似上面」）：

```ts
describe("单位表与标签", () => {
  it("五档，顺序固定，区间档家族没有取数面所以不在这里（2026-10-22 评审改口：原名写了对面的档位名，违全局约束）", () => {
    expect(CUSTOM_UNITS.map((u) => u.unit)).toEqual(["minute", "hour", "day", "week", "month"]);
    expect(CUSTOM_UNITS.map((u) => u.label)).toEqual(["分钟", "小时", "日", "周", "月"]);
  });
  it("小时编译成分钟，不产 `2H`——服务端折叠文法只认 m/D/W/M", () => {
    expect(draftToSpec({ unit: "hour", n: 2 })).toBe("120m");
    expect(draftToSpec({ unit: "hour", n: 1 })).toBe("60m");
    expect(draftToSpec({ unit: "minute", n: 7 })).toBe("7m");
    expect(draftToSpec({ unit: "day", n: 2 })).toBe("2D");
    expect(draftToSpec({ unit: "week", n: 2 })).toBe("2W");
    expect(draftToSpec({ unit: "month", n: 3 })).toBe("3M");
  });
  it("标签：满小时报小时，其余报分钟；日历一律「N单位」", () => {
    expect(specLabel("120m")).toBe("2小时");
    expect(specLabel("240m")).toBe("4小时");
    expect(specLabel("7m")).toBe("7分");
    expect(specLabel("90m")).toBe("90分");
    expect(specLabel("2D")).toBe("2日");
    expect(specLabel("3W")).toBe("3周");
    expect(specLabel("12M")).toBe("12月");
    expect(specLabel("2h")).toBeNull();
  });
  it("与内置八档的标签一个都不撞", () => {
    const builtinLabels = ["1分", "5分", "15分", "30分", "60分", "日线", "周线", "月线"];
    for (const text of ["120m", "7m", "2D", "3W", "12M"]) {
      expect(builtinLabels, text).not.toContain(specLabel(text));
    }
  });
});

describe("换算", () => {
  it("ms：分钟道 60_000 起步，日 86_400_000，周 604_800_000，月沿用本仓 30 日口径", () => {
    expect(specMs("7m")).toBe(7 * 60_000);
    expect(specMs("120m")).toBe(120 * 60_000);
    expect(specMs("2D")).toBe(2 * 86_400_000);
    expect(specMs("3W")).toBe(3 * 604_800_000);
    expect(specMs("2M")).toBe(2 * 30 * 86_400_000);
    expect(specMs("1tick")).toBeNull();
  });
  it("Period 形状：分钟进 minute 道，日历各回各家，span 就是倍数", () => {
    expect(specPeriodShape("120m")).toEqual({ type: "minute", span: 120 });
    expect(specPeriodShape("2D")).toEqual({ type: "day", span: 2 });
    expect(specPeriodShape("2W")).toEqual({ type: "week", span: 2 });
    expect(specPeriodShape("3M")).toEqual({ type: "month", span: 3 });
    expect(specPeriodShape("")).toBeNull();
  });
  it("isCustomSpec：文法合法且不是内置八档才算自定义档", () => {
    expect(isCustomSpec("120m")).toBe(true);
    expect(isCustomSpec("2D")).toBe(true);
    for (const text of BUILTIN) expect(isCustomSpec(text), text).toBe(false);
    expect(isCustomSpec("0m")).toBe(false);
    expect(isCustomSpec("2h")).toBe(false);
  });
});

describe("加入按钮的 enabled 判据（本仓规则，不是对面的初态）", () => {
  it("空值／非整数／越界都给可见原因，不返回裸 false", () => {
    expect(validateDraft({ unit: "minute", n: null }).ok).toBe(false);
    expect(validateDraft({ unit: "minute", n: 0 }).ok).toBe(false);
    expect(validateDraft({ unit: "hour", n: 25 }).ok).toBe(false); // 1500 分 > 一天
    expect(validateDraft({ unit: "day", n: 367 }).ok).toBe(false);
    expect(validateDraft({ unit: "minute", n: 1.5 }).ok).toBe(false);
    for (const bad of [validateDraft({ unit: "minute", n: null }), validateDraft({ unit: "hour", n: 25 })]) {
      if (!bad.ok) expect(bad.reason.length).toBeGreaterThan(0);
    }
  });
  it("合法草案给出 spec 串", () => {
    expect(validateDraft({ unit: "hour", n: 2 })).toEqual({ ok: true, spec: "120m" });
    expect(validateDraft({ unit: "week", n: 2 })).toEqual({ ok: true, spec: "2W" });
  });
});
```

Run: `cd frontend && npx vitest run src/lib/__tests__/customInterval.test.ts`
Expected: FAIL —— `Failed to resolve import "../customInterval"`（模块还不存在）。**这条红必须真跑出来再往下写**；红过之后在本笔提交信息里带上红的读数。

- [ ] **Step 3：写实现（GREEN）**

Create `frontend/src/lib/customInterval.ts`：

```ts
/**
 * 自定义周期档的文法与换算——前端唯一持有这把尺的地方。
 *
 * 文法不是这里发明的：它是服务端 `agent/src/api/interval_spec.py` 的 `_FOLDED_RE`
 * （`^(\d+)([mDWM])$`）加内置八档。两侧对账由两份逐字同表的测试钉住（本文件那条
 * 与 `agent/tests/test_interval_spec_frontend_align.py`），共享夹具是假的对齐，
 * 所以谁也不 import 谁。
 *
 * 边界（`1..999`、分钟侧封顶一天、日历侧封顶一年）是本仓自己的规则：服务端对 `k`
 * 不设上限，只按 `_MAX_BARS` 少返，一个 `500m` 名义合法却只会拿到远少于请求根数的
 * 图。这里把它挡住是为了不让用户按一个必败的按钮，**不是**对面也这么判。
 */

export type IntervalUnit = "minute" | "hour" | "day" | "week" | "month";

export const CUSTOM_UNITS: readonly { unit: IntervalUnit; label: string }[] = [
  { unit: "minute", label: "分钟" },
  { unit: "hour", label: "小时" },
  { unit: "day", label: "日" },
  { unit: "week", label: "周" },
  { unit: "month", label: "月" },
];

export type CustomIntervalDraft = { unit: IntervalUnit; n: number | null };

type SpecUnit = "m" | "D" | "W" | "M";

const MAX_COUNT = 999;
const MINUTES_PER_DAY = 1440;
const MAX_CALENDAR_MULTIPLE = 366;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
/** 月＝30 日，沿用 `marketApi.ts` 的 `INTERVAL_MS` 口径。服务端折叠用的是
 *  `MONTH_SECONDS = 31 日`，那是为「少返」故意取宽的近似，两处用途不同；
 *  统一它会改掉既有分页行为，所以这里保留差异并让它互相指认。 */
const MONTH_MS = 30 * DAY_MS;

/** 只有内置八档的拼写会走表；自定义串的推导全在 `parseSpec`／`draftToSpec`。 */
const BUILTIN_SPECS = new Set(["1m", "5m", "15m", "30m", "60m", "1D", "1W", "1M"]);

const SPEC_RE = /^(\d+)([mDWM])$/;

export function parseSpec(text: string): { unit: SpecUnit; n: number } | null {
  const m = SPEC_RE.exec((text ?? "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n <= 0) return null; // `0m`／前导零之外的非整数都由正则挡掉
  return { unit: m[2] as SpecUnit, n };
}

export function isCustomSpec(text: string): boolean {
  // 这枚委托是 2026-10-22 Task 2 修复轮的落地形状，已被 Task 3 Step 0（N-1 裁定）撤销：
  // 门侧串里那个数**已经是折算后的跨度**，委托会把手打数上限 `1..999` 套到跨度上。
  // 最终形状只在 Task 3 Step 0 写一遍，这里不重复。
  const shape = specPeriodShape(text);
  return shape !== null && validateDraft({ unit: shape.type, n: shape.span }).ok;
}

export function draftToSpec(draft: { unit: IntervalUnit; n: number }): string {
  if (draft.unit === "hour") return `${draft.n * 60}m`;
  if (draft.unit === "minute") return `${draft.n}m`;
  const unit: SpecUnit = draft.unit === "day" ? "D" : draft.unit === "week" ? "W" : "M";
  return `${draft.n}${unit}`;
}

export function validateDraft(draft: CustomIntervalDraft): { ok: true; spec: string } | { ok: false; reason: string } {
  const n = draft.n;
  if (n === null || Number.isNaN(n)) return { ok: false, reason: "还没有填数值" };
  if (!Number.isInteger(n)) return { ok: false, reason: "数值只能是整数" };
  if (n < 1) return { ok: false, reason: "数值至少是 1" };
  if (n > MAX_COUNT) return { ok: false, reason: `数值最多 ${MAX_COUNT}` };
  const minutes = draft.unit === "hour" ? n * 60 : draft.unit === "minute" ? n : 0;
  if (minutes > MINUTES_PER_DAY) return { ok: false, reason: "分钟档的一档不能跨过多于一天" };
  if (draft.unit !== "minute" && draft.unit !== "hour" && n > MAX_CALENDAR_MULTIPLE) {
    return { ok: false, reason: `日／周／月的倍数最多 ${MAX_CALENDAR_MULTIPLE}` };
  }
  const spec = draftToSpec({ unit: draft.unit, n });
  if (BUILTIN_SPECS.has(spec)) return { ok: false, reason: "这一档目录里已经有了（它就是内置档）" };
  return { ok: true, spec };
}

export function specLabel(text: string): string | null {
  const parsed = parseSpec(text);
  if (!parsed) return null;
  if (parsed.unit !== "m") {
    const unit = parsed.unit === "D" ? "日" : parsed.unit === "W" ? "周" : "月";
    return `${parsed.n}${unit}`;
  }
  if (parsed.n >= 60 && parsed.n % 60 === 0) return `${parsed.n / 60}小时`;
  return `${parsed.n}分`;
}

export function specMs(text: string): number | null {
  const parsed = parseSpec(text);
  if (!parsed) return null;
  if (parsed.unit === "m") return parsed.n * MINUTE_MS;
  if (parsed.unit === "D") return parsed.n * DAY_MS;
  if (parsed.unit === "W") return parsed.n * WEEK_MS;
  return parsed.n * MONTH_MS;
}

export function specPeriodShape(text: string): { type: "minute" | "day" | "week" | "month"; span: number } | null {
  const parsed = parseSpec(text);
  if (!parsed) return null;
  const type = parsed.unit === "m" ? "minute" : parsed.unit === "D" ? "day" : parsed.unit === "W" ? "week" : "month";
  return { type, span: parsed.n };
}
```

Run: `cd frontend && npx vitest run src/lib/__tests__/customInterval.test.ts`
Expected: PASS。若「文法合法的串」那枚红在 `draftToSpec(parseSpecToDraft("1m"))` 之类的内置串上——内置串**不进** `isCustomSpec`，但 `AGREED_OK` 里含内置拼写，所以那枚针的 `if (!BUILTIN.includes(text))` 分支就是为这条摆的，别去改生产码迁就它。

- [ ] **Step 4：`tsc` 与本笔自证，然后提交**

```bash
cd frontend && npx tsc -b              # 期望：0 错
cd agent && python -m pytest tests/test_interval_spec_frontend_align.py -q   # 期望：全绿
git add -- frontend/src/lib/customInterval.ts frontend/src/lib/__tests__/customInterval.test.ts agent/tests/test_interval_spec_frontend_align.py
git status --porcelain                  # 复核：只有这三枚
git commit -s -m "feat(l3-slice6): lib/customInterval.ts 文法与换算＋前后端两份同表对账"
```

---

### Task 2：`marketApi.ts`／`chartView.ts` 类型加宽（消费者同笔）

**Files:**
- Modify: `frontend/src/lib/marketApi.ts`（286 行；动 `:18` 之后、`:52`、`:57`、`:81`、`:101`、`:126-141`、`:197-207`、`:226-240`）
- Modify: `frontend/src/lib/chartView.ts:1,34-40`
- Modify: `frontend/src/lib/indicatorLang.ts:1102-1122`
- Modify: `forensics/gap-matrix.md:100`（TV-CI-11 那行把 `chartView.ts:34` 的**整行原文逐字**当证据引着；本片既换掉那行的参数类型、又可能因为往 doc 注释里加一句而使函数往下漂一两行 ⇒ 坐标与引文两处都要按落地后的盘面重钉。判态 `部分` 与其余文字一字不动，Task 7 才动判态。）
- Modify: `forensics/gap-matrix.md` 第 90 行（TV-CI-01）与第 91 行（TV-CI-02）的**说明列**（2026-10-22 执行期补：本笔在 `marketApi.ts` 头部加了一枚 import、又在 `IntervalKey` 之后新开了一个 `AnyInterval` 声明块，这两处插入把该文件里所有被按号引用的行都推走了——动手前现读 `git show HEAD:frontend/src/lib/marketApi.ts | grep -n ""` 的三枚号是 `:18`（`export type IntervalKey`）／`:20`（`export const INTERVALS`）／`:26`（`{ label: "日线", key: "1D" }` 那一行），矩阵第 90 行引前两枚、第 91 行引第三枚，第 73 行那条第①片 T6 的「不漂清单」也把 `marketApi.ts:18`／`:20` 记在案。落地后**逐枚按内容重钉**：姿势＝`grep -n -F '<文档引用的那句逐字文本>' frontend/src/lib/marketApi.ts` 取新号，再 `sed -n '<新号>p'` 读出原文与引用句核对；**号一律你自己现取，别抄任何消息里写好的数字**（第①片那条「不漂」说的是「那一片的 diff 没碰这个文件」，不是「这个文件的号永远不动」——本笔就是碰了，所以那两枚号今天必须搬，这是同一套口径的延续，不是改写历史）。第 90 行那格的说明列末尾要落一句**带日期、落在原地**的追加，交代三件事：其一，新号与旧号各是什么、为什么搬（一枚 import ＋一个声明块）；其二，第 73 行那条「不漂清单」里 `marketApi.ts` 那两枚号自此对本文件失效（照第①片 ④ 那条的规矩：追加声明，不原地覆盖它）；其三，第 109 行那条 2026-10-14 的说明举例写着 `marketApi.ts:20`，它讲的是「这枚号只住在说明列、不在坐标列」这个**归属**，不是行号读数，所以那一行一个字都不改，只在本笔追加里交代它今天读作新号。**行数守恒**：`forensics/gap-matrix.md` 本文件动手前后 `wc -l` 必须同值（第 91／92／98／100 行是被 Task 4 与本笔按**行号**点名的，插一行就把它们全推走）；只许在既有行内改号与追加句子。EOL 照该文件原象（CRLF）守，改完复数 `CR == LF == 行数`、裸 CR／裸 LF 为 0。
- Modify: `frontend/src/pages/__tests__/MultiChart.test.tsx:59,766`（2026-10-22 执行期补，这是「消费者同笔」在**测试面**的落点：`:766` 那行 `type IntervalKey = Parameters<typeof intervalToPeriod>[0];` 是把「入参类型」当窄类型用，`intervalToPeriod` 一加宽它就变成 `string`，于是 `:936,937,939` 三处把 `IntervalKey[]` 递给 `intervalsForSymbol(…, readonly IntervalKey[])` 当场 TS2345。改法＝**删掉那行派生别名**，把 `type IntervalKey` 并进 `:59` 已有的那枚 `import { intervalToPeriod } from "@/lib/marketApi"`，其余一字不动。别给别名加 casts、也别把 `intervalsForSymbol` 换宽。）
- Test: `frontend/src/lib/__tests__/marketApiCustom.test.ts`（新）＋ 2026-10-22 Task 2 修复轮连带面（评审席两枚 Important，控制席裁定现做，见台账裁定二／三）：**其一（I-2）** Modify `frontend/src/lib/customInterval.ts`——把 `isCustomSpec` 的函数体换成委托 `validateDraft`（正文与上面 Task 1 代码块逐字同形、行数守恒＝四行不动其它行），文件头那段边界注释里「这里把它挡住是为了不让用户按一个必败的按钮」要补一句：同一把尺现在也管 URL／会话读进来的串（`normalizeInterval` 走它），对话框拒收的数门也不收；`MAX_COUNT`／`MINUTES_PER_DAY`／`MAX_CALENDAR_MULTIPLE` 三枚数**一处不重抄**。**`frontend/src/lib/marketApi.ts` 本笔一字不动**——`:155` 那行调的还是同名谓词，这样上一笔刚按内容重钉的矩阵三枚说明列号（`:19`／`:24`／`:30`）不会二次漂移；若发现 `marketApi.ts` 非改不可，先停下报告，别顺手插行。`customInterval.test.ts` 补越界针：`isCustomSpec("999m")` 真／`("1000m")` 假／`("366D")` 真／`("367D")` 假／`("9999m")` 假，外加 `marketApiCustom.test.ts` 里 `normalizeInterval("9999m")` 与 `("5000D")` 各退 `"1D"`。Task 1 那五枚既存针（`customInterval.test.ts:100-105`）改完必须逐枚仍绿——它们红说明委托把内置判定或 `0m`／`2h` 那两半弄坏了，不许改针迁就实现。**其二（I-1）** `marketApiCustom.test.ts` 补四枚退化出口针，让第 6 片的变异探针有处可红：`intervalMsOf("120m")`／`("2D")` 断自定义侧真的在算（左边写手算的字面量 `120 * 60_000`／`2 * 86_400_000`，**不许**拿 `specMs(...)` 当右边——被测函数自己算出的期望值是一枚天生恒绿的针），`intervalMsOf("2d")` 退 `INTERVAL_MS["1D"]`、`intervalToPeriod("2d")` 退 `{ type: "day", span: 1 }` 断坏串侧那两枝（`marketApi.ts:149`／`:86`）确实落在文档说的退化档上。**提交仍一笔带 pathspec，只列三份：`customInterval.ts`＋两枚测试文件**（本计划与控制席的台账由控制席另笔提交，修复席不碰 `superpowers/**` 与 `.superpowers/**`），EOL 照各文件原象（`customInterval.ts`／测试＝CRLF，本计划＝LF），三门（focused 两套＋`tsc -b`）＋全量 vitest 读数按原样贴、不许删那 3 行 `__dirname` 告警。**（同日 Task 3 Step 0 的 N-1 裁定撤销本节那枚「委托 `validateDraft`」写法——它把只管手打数的 `1..999` 套到了折算跨度上；本节 I-2 的判据「越界的合法文法串不算合法自定义档」仍然成立，只是「越界」按跨度取，故 `("1000m")` 那枚针翻面为真。）**
- 不许动：`frontend/src/lib/__tests__/udfTransport.test.ts:113`、`frontend/src/lib/__tests__/marketApiPeriods.test.ts:43,50-64`

**Interfaces:**
- Consumes: Task 1 的 `isCustomSpec`／`specMs`／`specPeriodShape`／`parseSpec`
- Produces:
  - `type AnyInterval = string`，`function isBuiltinInterval(x: string): x is IntervalKey`
  - `function resolutionOf(interval: AnyInterval): string`
  - `function intervalMsOf(interval: AnyInterval): number`
  - `function normalizeInterval(text: unknown): AnyInterval`（坏串 → `"1D"`）
  - `intervalToPeriod(key: AnyInterval): Period`、`periodToInterval(period: Period): AnyInterval`、`isCalendarInterval(key: AnyInterval): boolean`、`fetchKline({ interval: AnyInterval … })`
  - `chartView.intervalAllowed(symbol: string, interval: AnyInterval): boolean`、`repairInterval<T extends AnyInterval>(symbol: string, interval: T): T | "1D"`（2026-10-22 预检改口：原来写的 `…(interval: AnyInterval): AnyInterval` 会把 `ProChart.tsx` 的 `ChartView.interval`、`PeriodPicker` 的 `active`／`onPick`、`MultiChart` 的 `IntervalKey[]` 全部拖红，而那些加宽属于 Task 4／Task 5 的范围，不是「消费者同笔」；泛型让**拿着窄类型 `IntervalKey` 的调用方（`MultiChart`、screener，靠八档穷举）零改动**，让 `ProChart` 在 Task 5 把状态换宽时自动接上。全局约束要求 `IntervalKey` 那八枚不动，这个签名就是用来保它的——`MultiChart.tsx:123,147,373` 三处把 `repairInterval` 的结果塞进 `IntervalKey[]`，`screener.ts:74,192,208,259` 的 `interval` 也仍是窄类型。）

- [ ] **Step 1：写红的针**

Create `frontend/src/lib/__tests__/marketApiCustom.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import {
  INTERVAL_MS,
  RESOLUTION_BY_INTERVAL,
  intervalMsOf,
  intervalToPeriod,
  isBuiltinInterval,
  isCalendarInterval,
  normalizeInterval,
  periodToInterval,
  resolutionOf,
  type IntervalKey,
} from "../marketApi";
import { intervalAllowed } from "../chartView";

const BUILTIN = ["1m", "5m", "15m", "30m", "60m", "1D", "1W", "1M"] as IntervalKey[];

describe("内置八档在加宽后逐字节不变", () => {
  it("resolutionOf 就是那张旧表", () => {
    for (const key of BUILTIN) expect(resolutionOf(key), key).toBe(RESOLUTION_BY_INTERVAL[key]);
  });
  it("intervalMsOf 就是那张旧表", () => {
    for (const key of BUILTIN) expect(intervalMsOf(key), key).toBe(INTERVAL_MS[key]);
  });
  it("intervalToPeriod 与 periodToInterval 的往返仍成立", () => {
    for (const key of BUILTIN) expect(periodToInterval(intervalToPeriod(key)), key).toBe(key);
  });
});

describe("自定义档走同一条出入口", () => {
  it("自定义串的 resolution 就是它的 market 拼写（服务端 parse_resolution 认它）", () => {
    expect(resolutionOf("120m")).toBe("120m");
    expect(resolutionOf("2D")).toBe("2D");
    expect(resolutionOf("3W")).toBe("3W");
  });
  it("Period 带 span——图上的时间轴标签跟真实倍数一致", () => {
    expect(intervalToPeriod("120m")).toEqual({ type: "minute", span: 120 });
    expect(intervalToPeriod("2D")).toEqual({ type: "day", span: 2 });
    expect(intervalToPeriod("3M")).toEqual({ type: "month", span: 3 });
  });
  it("periodToInterval 反向造串：minute span 不在表里就拼回去，日历按倍数拼", () => {
    expect(periodToInterval({ type: "minute", span: 120 })).toBe("120m");
    expect(periodToInterval({ type: "day", span: 2 })).toBe("2D");
    expect(periodToInterval({ type: "week", span: 2 })).toBe("2W");
    // 这三枚既有针的形状不许被本片改掉（marketApiPeriods.test.ts 里也各钉一遍）
    expect(periodToInterval({ type: "year", span: 1 })).toBe("1D");
    expect(periodToInterval({ type: "second", span: 30 })).toBe("1D");
    expect(periodToInterval({ type: "hour", span: 4 })).toBe("1D");
  });
  it("月线与月倍数都不落回分钟道——大小写是这条线的唯一分界", () => {
    expect(intervalToPeriod("1M")).toEqual({ type: "month", span: 1 });
    expect(intervalToPeriod("2M")).toEqual({ type: "month", span: 2 });
    expect(intervalToPeriod("2m")).toEqual({ type: "minute", span: 2 });
  });
});

describe("车道判定与坏串", () => {
  it("isCalendarInterval 认日历道自定义串（它们不需要分钟源）", () => {
    expect(isCalendarInterval("2D")).toBe(true);
    expect(isCalendarInterval("3W")).toBe(true);
    expect(isCalendarInterval("12M")).toBe(true);
    expect(isCalendarInterval("120m")).toBe(false);
    // 坏串不许自称日历道（2026-10-22 预检加：原写法 `parseSpec(key)?.unit !== "m"` 对
    // null 读成 undefined !== "m" ＝ true，这两枚就是拦它的面包屑，缺了它 Step 2 的改文没有针）
    expect(isCalendarInterval("2d"), "大小写错了就是坏串").toBe(false);
    expect(isCalendarInterval(""), "空串").toBe(false);
    for (const key of BUILTIN) expect(isCalendarInterval(key), key).toBe(key === "1D" || key === "1W" || key === "1M");
  });
  it("BTC 这类没有分钟源的标的：日倍数可答、分钟倍数不可答", () => {
    expect(intervalAllowed("BTCUSDT", "2D")).toBe(true);
    expect(intervalAllowed("BTCUSDT", "120m")).toBe(false);
    // 2026-10-22 执行期改口：原写 `.SH000300` 是一枚拼法错的样本——`canMinuteBars` 的逐字
    // 正则 `/\.(SH|SZ|HK|US)$/i` 只认**后缀**，本仓指数拼法是 `000300.SH`，前缀拼法判 false，
    // 那枚针在这条线上结构上不可能为真。换成仓内既有测试用的 A 股代码，断的仍是同一件事。
    expect(intervalAllowed("600519.SH", "120m")).toBe(true);
  });
  it("normalizeInterval：内置原样、自定义原样、坏串退 1D，绝不静默接受", () => {
    expect(normalizeInterval("1D")).toBe("1D");
    expect(normalizeInterval("2W")).toBe("2W");
    for (const bad of ["", "2d", "1tick", "0m", "2.5m", null, undefined, 42, {}]) {
      expect(normalizeInterval(bad), String(bad)).toBe("1D");
    }
  });
  it("isBuiltinInterval 只对八档为真", () => {
    for (const key of BUILTIN) expect(isBuiltinInterval(key), key).toBe(true);
    expect(isBuiltinInterval("2D")).toBe(false);
    expect(isBuiltinInterval("")).toBe(false);
  });
});
```

Run: `cd frontend && npx vitest run src/lib/__tests__/marketApiCustom.test.ts`
Expected: FAIL —— `resolutionOf` 等尚未导出（`does not provide an export named 'resolutionOf'`）。

- [ ] **Step 2：加宽 `marketApi.ts`**

`AnyInterval` 那两行贴在 `:18` 的 `IntervalKey` 之后，`isBuiltinInterval` 那三行贴在 `INTERVALS`（`:20-29`）之后，并保留 `RESOLUTION_BY_INTERVAL`／`INTERVAL_MS` 两张表**原样不动**（`:113` 那枚 exhaustive 钉靠它们活着）：

```ts
/** 目录里可能出现的所有周期拼写：八档内置 ∪ 合法自定义串。 */
export type AnyInterval = string;

export function isBuiltinInterval(value: string): value is IntervalKey {
  return INTERVALS.some((item) => item.key === value);
}
```

守卫必须**从 `INTERVALS` 那张建表派生**（放在 `INTERVALS` 之后，不在它之前——`const` 初始化按求值顺序跑），2026-10-22 预检改口：原写法在这里再硬抄一遍八枚串，就成了本仓第五份内置表，而 `INTERVALS` 自己就是那八枚的所在地；派生之后「谁漂了」这个问题在这条线上不存在，八档穷举仍由 `INTERVALS` 单一持有。

四处改口（每处都要留一句「为什么不是查表」）：

1. `isCalendarInterval(key: AnyInterval)`：**内置串走原表，非内置只有「单位是 `D`/`W`/`M`」才算日历道**。落点逐字如下（2026-10-22 预检修文——原写法 `parseSpec(key)?.unit !== "m"` 让一枚坏串（`parseSpec` 给 null）读成 `undefined !== "m"` ＝ true，于是垃圾串自称不需要分钟源，正是 TV-CI-11 那行红线要拦的形状）：

```ts
export function isCalendarInterval(key: AnyInterval): boolean {
  if (isBuiltinInterval(key)) return CALENDAR_PERIODS.some((c) => c.key === key);
  const shape = specPeriodShape(key);
  return shape !== null && shape.type !== "minute";
}
```

2. `intervalToPeriod(key: AnyInterval): Period`：先按旧逻辑判内置（`CALENDAR_PERIODS.find` ＋ `parseInt`），不落在内置时用 `specPeriodShape`；`specPeriodShape` 给 null（坏串）时退回 `{ type: "day", span: 1 }`，与本文件既有的「degrade to the one period every instrument can serve」同调。
3. `periodToInterval(period: Period): AnyInterval`：`minute` 道先查旧 `map`，**只留一条** `return map[period.span] ?? \`${period.span}m\`;`——不在表里的那些（`7`，以及所有 `span > 60` 的倍数档如 `120`）都由 `??` 这一支拼出来。calendar 三型把 `span` 带进串（`span === 1` 时仍产 `1D`/`1W`/`1M`，与 `marketApiPeriods.test.ts:43` 的往返钉一致）；`second`/`hour`/`year` 照旧 `"1D"`。
   （2026-10-22 执行期改口：本条旧文写的是「`span > 60` **或**不在表里 ⇒ `f"{span}m"`」，第 2 席据此落成两条语句，多出的那枚 `if (period.span > 60) return \`${period.span}m\`;` 是一根**摘掉必然等价**的死枝——`map` 那五枚键最大就是 `60`，凡 `> 60` 者必不在表里，`??` 已经接住。本仓的判据见「冗余双守卫 ⇒ 单点摘除必然等价」那条：Task 6 的变异席若在这行注入，得到的「测不出红」不是 HARNESS-BLIND，而是那段码根本没有可达语义，白占一枚名额。注释两行照留，只需把「`span > 60`」从「另有一条语句拦它」的口气改成「`??` 也负责 `> 60` 的倍数档」。这一处改口是**行数 −1**（少一条语句），而 `marketApi.ts` 里被文档按号引用的三枚号（`:19`／`:24`／`:30`，见 Files）全在这条之前 ⇒ 不会把 Files 那批号再推走。）
4. `fetchKline` 的 `interval` 参数类型换成 `AnyInterval`，`:239` 换成 `q.set("resolution", resolutionOf(params.interval))`；新导出 `resolutionOf`／`intervalMsOf`／`normalizeInterval`：

```ts
/** 内置查表；自定义串的 market 拼写同时就是 UDF resolution（`2D`／`120m`／`3W`
 *  都被服务端 `parse_resolution` 认），所以这里没有字符串 munging——`1M`（月）
 *  被 lower 成 `1m`（一分钟）就是这条线上的旧事故。 */
export function resolutionOf(interval: AnyInterval): string {
  return isBuiltinInterval(interval) ? RESOLUTION_BY_INTERVAL[interval] : interval;
}

export function intervalMsOf(interval: AnyInterval): number {
  if (isBuiltinInterval(interval)) return INTERVAL_MS[interval];
  return specMs(interval) ?? INTERVAL_MS["1D"];
}

/** 会话与 URL 里读出来的串都要过这道门：坏串退 `1D`，不静默带着它去取数。 */
export function normalizeInterval(value: unknown): AnyInterval {
  if (typeof value !== "string") return "1D";
  return isBuiltinInterval(value) || isCustomSpec(value) ? value : "1D";
}
```

5. `pickLowerInterval(chartKey: IntervalKey, …)` **签名不动**（它是 Pine MTF 的下层档选择器，只在内置档之间挑），`INTERVAL_MS[k]` 那几处本来就是内置键，不用换。

- [ ] **Step 3：`chartView.ts` 与 `indicatorLang.ts` 的消费者同笔改口**

`chartView.ts:1` 的 import 换成 `isCalendarInterval, type AnyInterval`（`type IntervalKey` 要一起摘掉——换完它在这份文件里再无消费者，`noUnusedLocals` 会当场红）；`:34` 的 `intervalAllowed(symbol, interval: AnyInterval): boolean` 只换参数，`:39` 的 `repairInterval` 按上面 Produces 那枚泛型签名落成：

```ts
export function repairInterval<T extends AnyInterval>(symbol: string, interval: T): T | "1D" {
  return intervalAllowed(symbol, interval) ? interval : "1D";
}
```

`intervalAllowed` 那段既有 doc 注释里再补一句：「自定义档按它的单位落车道：`m` 要分钟源，`D`/`W`/`M` 不需要——这条判据的来源是 `interval_spec` 的折叠基档，不是任何 disabled 标记」。**这一句就是 TV-CI-11 红线在码里的落点**，Task 6 有针指着它。加这句会让 `intervalAllowed` 与 `repairInterval` 各往下漂（漂几行＝你加了几行），所以 Files 里那条 `forensics/gap-matrix.md:100` 必须同笔重钉：坐标号改成漂后的那一号，引文改成新行的**逐字**内容。

`indicatorLang.ts:1102` 之后（`:1105` 之前）插入守卫并把 `:1111` 的 `INTERVAL_MS[lowerIv]` 换成 `intervalMsOf(lowerIv)`。

**插入形状（2026-10-22 预检钉死）**：`:1102` 那一行**本来就是** `const chartIv = periodToInterval(period);`，已经在位。要新落的只有下面这四行——把「注释三行＋`if` 一枚」插在 `:1102` 与「A single lowerBars series…」那两行注释之间。整段照抄下面这份会**重复声明 `chartIv`**（TS2451），类型门当场红：

```ts
  // 自定义周期时 MTF 不挑下层档：`pickLowerInterval` 只在内置八档之间选，
  // 拿「最近的内置细档」冒充会让脚本画的不是它请求的那条时间轴。走早已存在
  // 的降级路径——不传 lowerBars，builtin 退化成空数组。
  if (!isBuiltinInterval(chartIv)) return;
```

`feedLowerBars` 的返回类型是 `Promise<void>`，早退写成裸 `return;` 即成立；`isBuiltinInterval` 是类型谓词，`chartIv` 在这行之后窄回 `IntervalKey`，`:1105` 的 `pickLowerInterval(chartIv, …)` 才继续编译得过。**页面源文件（`ProChart.tsx`／`MultiChart.tsx`／`PeriodPicker.tsx`／`ChartCell.tsx`）一枚都不许动**——「消费者同笔」在本笔的全部内容就是这三份 lib 文件加 Files 里点名的那两枚测试/证据文件（`MultiChart.test.tsx` 的派生别名、`gap-matrix.md:100` 的引文重钉）。

- [ ] **Step 4：全绿＋提交**

```bash
cd frontend && npx vitest run src/lib/__tests__/marketApiCustom.test.ts src/lib/__tests__/marketApiPeriods.test.ts src/lib/__tests__/udfTransport.test.ts
# 期望：三套全绿，后两枚一枚针都没改
cd frontend && npx tsc -b && npx vitest run   # 全量：0 错、全绿
git add -- frontend/src/lib/marketApi.ts frontend/src/lib/chartView.ts frontend/src/lib/indicatorLang.ts frontend/src/lib/__tests__/marketApiCustom.test.ts frontend/src/pages/__tests__/MultiChart.test.tsx forensics/gap-matrix.md
git status --porcelain && git commit -s -m "feat(l3-slice6): marketApi/chartView 类型加宽到 AnyInterval，消费者同笔改口"
```

若全量 vitest 里有页面测试（`ProChart`／`ChartCell`）因签名加宽而红，**不许**顺手改页面逻辑：那是类型位置的可赋值性变化，报错应是 TS 的而非断言的；断言红就停下报告，别改期望值迁就。

提交前还要取两枚守恒读数并写进报告：其一 `wc -l forensics/gap-matrix.md` 动手前后同值（上面 Files 那条行数守恒的判据）；其二把 `marketApi.ts` 里那三枚被引用号的新号（用 `grep -n -F` 现取）与矩阵第 90／91 行改完后写进去的号**并排读一遍**，两两相等才算重钉成立——门只判行号在文件行数范围内，门绿不代表那一行写着它该写的东西。

---

### Task 3：`CustomIntervalDialog.tsx`（对话框本体，TV-CI-09／10 的形状）

**Files:**
- Create: `frontend/src/components/charts/CustomIntervalDialog.tsx`
- Create: `frontend/src/components/charts/__tests__/CustomIntervalDialog.test.tsx`
- Modify（Step 0 的 N-1 裁定件）: `frontend/src/lib/customInterval.ts` ＋ `frontend/src/lib/__tests__/customInterval.test.ts`
- 参照（不修改）：`frontend/src/components/charts/PeriodPicker.tsx:36-55` 的 Escape／外点关闭写法

**Interfaces:**
- Consumes: `CUSTOM_UNITS`／`validateDraft`／`specLabel`／`IntervalUnit`（Task 1）
- Produces:
  ```ts
  export type CustomIntervalDialogProps = {
    /** 目录里已有的串（内置八档 ∪ 已添加的自定义档），用来判「这一档已在目录里」。 */
    existing: readonly string[];
    onCancel: () => void;
    onAdd: (spec: string) => void;
  };
  export function CustomIntervalDialog(props: CustomIntervalDialogProps); // 2026-10-22 执行期改口：不写返回类型标注——本仓 `@types/react` 19 没有全局 `JSX` 命名空间，`JSX.Element` 吃 TS2503（原计划此处写的是 `: JSX.Element | null`）
  ```

- [ ] **Step 0：边界尺归一（2026-10-22 Task 2 收窄复评的 N-1 裁定，本任务先做，单独一笔提交）**

**洞的形状**：Task 2 修复轮把 `isCustomSpec` 改成委托 `validateDraft`（`customInterval.ts:54-57`），于是串侧那道门把**手打的数**上限 `MAX_COUNT`（`:30`＝999）也套到了串里那个数上。但 `validateDraft` 判的是**草案**：小时档 `n=17..24` 经 `draftToSpec`（`:59-64`）折算成 `1020m…1440m`，手打数 ≤999、折算跨度 ≤1440（`:71-73`）两边都放行，造出来的串回到门侧就被 `1200 > 999` 拒收⇒对话框发得出、`normalizeInterval` 与 Task 5 的会话过滤收不下，刷新后被静默退成 `1D`。今天 `validateDraft` 还没有生产调用方，所以本笔不红；**Step 1 起的对话框就是那枚消费者**，故修复归本任务而不在 Task 2 的返工里顺手改（改 `:71` 会动到未点名的既有判据，复评席明说「本笔不该顺手改」）。

**裁定的读法依据**：spec §4 那句「`n` 必须是 `1..999` 的整数，且单位是分钟/小时时 `60·n`（小时）或 `n`（分钟）不得超过 `1440`」管的是两件事——**用户手打的数**与**折算后的跨度**，各自一把尺。委托写法把前者也套到了后者上。⇒ 归一后的形状：**跨度判据只有一处拼写，两侧都按折算后的串判**；`MAX_COUNT` 退回它本来只管的那件事（手打的数值）。

```ts
/** 折算后的跨度上限——对话框（`validateDraft`，先过 `mintedShape`）与门（`isCustomSpec`，
 *  串里那个数就已经是跨度）共用这一处拼写。N-1（2026-10-22）：两侧各写一遍就会漏出
 *  「对话框发得出、门收不下」的串，那串在会话里被静默退成 `1D`。 */
function durationOk(minted: { unit: SpecUnit; n: number }): boolean {
  return minted.unit === "m" ? minted.n <= MINUTES_PER_DAY : minted.n <= MAX_CALENDAR_MULTIPLE;
}

/** 草案 → 折算后的串形状。`draftToSpec` 用它拼字面量，`validateDraft` 用它判跨度。 */
function mintedShape(draft: { unit: IntervalUnit; n: number }): { unit: SpecUnit; n: number } {
  if (draft.unit === "hour") return { unit: "m", n: draft.n * 60 };
  if (draft.unit === "minute") return { unit: "m", n: draft.n };
  return { unit: draft.unit === "day" ? "D" : draft.unit === "week" ? "W" : "M", n: draft.n };
}
```

三处改动照下面落，其余函数一字不动，`marketApi.ts` 本步一字不动：

1. `draftToSpec`（`:59-64`）函数体换成两行：`const minted = mintedShape(draft);` 再 `` return `${minted.n}${minted.unit}`; ``——拼写仍由这一处对外持有，`mintedShape` 是它的唯一实现者。
2. `validateDraft`（`:66-80`）保留手打数那几枚判据（`null`／`NaN`／非整数／`<1`／`>MAX_COUNT`），把 `:72-76` 的两段跨度判据换成**一次** `durationOk(mintedShape({ unit: draft.unit, n }))`，原因文案按折算后的单位分岔：`m` 给「分钟档的一档不能跨过多于一天」，`D`／`W`／`M` 给「日／周／月的倍数最多 366」。内置重复判定与返回形状不变。
3. `isCustomSpec`（`:54-57`）不再委托 `validateDraft`——门侧收到的串里没有「单位」这一层，委托等于把手打数上限套到跨度上。改成 `parseSpec` → 非内置 → `durationOk(parsed)` 三步（`parseSpec` 已拒 `0m` 与坏文法）。**不许**新增第二枚 `MAX_COUNT` 式判据，也不许在 `normalizeInterval` 里就地补尺。

文件头那段边界注释（`:9-13`）末句「两扇门共用下面 `validateDraft` 那一处拼写」要改成按 `durationOk` 说（手打数一把尺、跨度一把尺，跨度只有这一处）；同一笔把 `customInterval.test.ts:100` 那枚 `it` 标题的「文法合法且不是内置八档才算自定义档」补全成含跨度的说法（复评 N-2）。

针面（`customInterval.test.ts`，只动 `:107-115` 那一枚 `it` 与文件里新增一枚）：

- `:111` 那枚 `isCustomSpec("1000m")` 假**翻面为真**，注释理由改成「`1000m` 是跨度界内的合法文法串，门按跨度判它」；`999m` 真／`366D` 真／`367D` 假／`9999m` 假四枚**一字不动**（`9999 > 1440`，I-2 那半仍然成立）。**（2026-10-22 第 3 轮评审改口：本行原写「`1000m` 是小时档折算出来的合法跨度」不实——小时档 `n=17` 折算出来的是 `1020m`，`1000` 不是 60 的倍数，任何草案都发不出 `1000m`，它只是「跨度 ≤ 1440」的合法文法串。这句错同时落在注释与那枚 `expect` 的消息串上，Task 3 修复轮件四两件一起改；行号 `:111` 是写作时的读数，执行期已在 `:113`。）**
- 新增一枚**往返针**（复评席点名的「无论哪种修法都该配一枚往返针」）：遍历 `CUSTOM_UNITS` 五枚单位 × `n` 从 1 到 999，凡 `validateDraft` 给 `ok:true` 的 `spec` 必须 `isCustomSpec(spec) === true`。写成循环针，别逐枚枚举那八枚串——要钉的是「发得出就收得下」这条性质，不是那八枚的名字。
- `marketApiCustom.test.ts` 里 Task 2 修复轮那两枚越界退化针（`normalizeInterval("9999m")`／`("5000D")` 各退 `"1D"`）**必须仍绿、不许翻面**——翻面就是把 I-2 拆回去。

```bash
cd frontend && npx vitest run src/lib/__tests__/customInterval.test.ts src/lib/__tests__/marketApiCustom.test.ts src/lib/__tests__/marketApiPeriods.test.ts src/lib/__tests__/udfTransport.test.ts && npx tsc -b
# 期望：四套全绿＋0 错
git add -- frontend/src/lib/customInterval.ts frontend/src/lib/__tests__/customInterval.test.ts
git commit -s -m "fix(l3-slice6): 边界尺归一——跨度只判一处，手打数上限退回只管手打的数"
```

自证（先证这枚往返针能红）：把 `durationOk` 里的 `MINUTES_PER_DAY` 临时换成 `MAX_COUNT`，应当**恰**红往返针与 `1000m` 那枚；还原只从动手前的内存副本写回，改完复跑并取 sha256 与动手前对账。Step 0 全绿提交后，再进 Step 1。

- [ ] **Step 1：写红的针（C 组，逐枚对 spec §6 那张表）**

```tsx
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CustomIntervalDialog, type CustomIntervalDialogProps } from "../CustomIntervalDialog";

const renderDialog = (props: Partial<CustomIntervalDialogProps> = {}) => {
  const onCancel = vi.fn();
  const onAdd = vi.fn();
  render(<CustomIntervalDialog existing={["1m", "5m", "15m", "30m", "60m", "1D", "1W", "1M"]} onCancel={onCancel} onAdd={onAdd} {...props} />);
  return { onCancel, onAdd };
};
const typeButton = () => screen.getByRole("button", { name: "分钟" });
const addButton = () => screen.getByRole("button", { name: "加入" }) as HTMLButtonElement;
```

九枚针（名字照抄，别合并）：

| 针 | 断言 |
| --- | --- |
| C-1 | `screen.getAllByRole("dialog")` 长度 1 |
| C-2 | 关闭／单位按钮／数值框／取消／加入五件各 `getByRole` 拿得到，且 `getByRole("button", { name: "关闭" })` 只有一枚 |
| C-3 | 对话框存在时，测试自己 render 的宿主目录节点仍在 `document` 里（宿主用 `data-testid="directory"` 的一枚空 div，断 `querySelector` 非 null）——钉「dialog 与目录共存、不摘目录」 |
| C-4 | 关态：`queryByRole("listbox")` 为 null 且 `typeButton().getAttribute("aria-expanded") === "false"`；点开：listbox 恰 1 枚、`within(listbox).getAllByRole("option")` 长 5、`aria-selected="true"` 恰一枚、`aria-expanded === "true"` |
| C-5 | 空输入 ⇒ `addButton().disabled === true`；填 `2`（单位分钟）⇒ 变 false；点加入 ⇒ `onAdd` 收到 `"2m"` |
| C-6 | Escape（`fireEvent.keyDown(document, { key: "Escape" })`）⇒ `onCancel` 调 1 次 |
| C-7 | 展开态与关态里，单位按钮的可达名都**只含一次**「分钟」：`expect(typeButton().textContent).toBe("分钟")`，再断 `screen.queryByRole("button", { name: "分钟 分钟" })` 为 null |
| C-8 | 选「小时」后填 `25` ⇒ 加入 disabled，且 screen 上出现越界原因文本（`/一天/`）；换回「分钟」后同样的 25 ⇒ 加入 enabled（证明边界按单位走） |
| C-9 | 单位改「日」后 `onAdd` 收到 `"2D"`（数值仍是 2）⇒ 钉「单位与数值合成 market 拼写」这一件事 |

外加一枚：`existing` 传 `["2D", ...八档]` 时填日/2 ⇒ 加入 disabled 且原因含「已经有了」字样。

Run: `cd frontend && npx vitest run src/components/charts/__tests__/CustomIntervalDialog.test.tsx` → FAIL（模块不存在）。

- [ ] **Step 2：实现**

结构（**全部中文案，不写对面任何控件名**）：根 `div role="dialog"` ＋ `aria-label="添加自定义周期"`；一行标签「单位」＋按钮（`aria-haspopup="listbox"`、`aria-expanded`）＋条件渲染的 `ul role="listbox"`（每枚 `li role="option"` ＋ `aria-selected`）；一行标签「数值」＋ `input type="number"`（`min={1}`、`max` 按单位算、`value` 受控、`onChange` 里 `Number.isFinite ? Number(v) : null`，空串 ⇒ `null`）；原因文本一行（`aria-live="polite"`，只在 disabled 且有原因时出现）；底部「取消」／「加入」。加入按钮 `disabled={!verdict.ok || inExisting}`，`onClick` 里 `onAdd(verdict.ok ? verdict.spec : "")` 之前再算一次 `validateDraft`（不在 effect 里缓存结论）。Escape 挂 `useEffect` 的 `keydown`（照 `PeriodPicker.tsx:43-48`，`preventDefault` ＋ 归还焦点由**调用方**负责，组件只管回调）。重复档判定用 `existing.includes(spec)`。

- [ ] **Step 3：绿＋提交**

```bash
cd frontend && npx vitest run src/components/charts/__tests__/CustomIntervalDialog.test.tsx
cd frontend && npx tsc -b && npx vitest run src/components/charts
git add -- frontend/src/components/charts/CustomIntervalDialog.tsx frontend/src/components/charts/__tests__/CustomIntervalDialog.test.tsx
git commit -s -m "feat(l3-slice6): 自定义周期对话框（role=dialog ＋ 五档单位弹层，按 TV-CI-09/10 的形状）"
```

---

### Task 4：`PeriodPicker.tsx` 目录加自定义行、入口行与移除按钮

> **2026-10-22 第 4 轮预检：本任务拆成 4a／4b 两席，并修掉本节自身的四处洞（控制席裁定）。下面这段是本任务的权威口径，与后文冲突处以本节为准。**
>
> **P-1（任务边界切在接口中间）⇒ 新增 Task 4a。** 本节把 `PeriodOption.key` 加宽到 `AnyInterval`，`onPick` 就必须跟着加宽；参数是反变的（`strictFunctionTypes`），所以 `ProChart.tsx:1961` 的 `const pickInterval = (iv: IntervalKey) =>` 从此当不了 `onPick`，`npx tsc -b` 会在 `ProChart.tsx:2833` 那行红。原计划把这条类型链整个留在 Task 5 Step 2 第 1～3 项，于是 Task 4 自己合不到绿。
> - **Task 4a＝把 ProChart 的周期状态链从 `IntervalKey` 加宽到 `AnyInterval`：只做类型面、行为零变化、每处改动都必须行内改字（行数守恒）。** 行数守恒在这里是硬约束不是偏好：`grep -rno "ProChart\.tsx:[0-9]\+" forensics/ frontend/src agent/src` 现读＝**85 处命中**（控制席 2026-10-22 读数，席上要自己重取），插一行就把这些按号引用的坐标整体推走一位，而 L2 坐标门只判「行号在不在文件行数范围内」、不判那一行写的是什么——门会照样绿。`AnyInterval` 因此并进既有那行 `type IntervalKey,`（同一物理行里写两枚 specifier，与 `ProChart.tsx:1` 的 `useState, type ChangeEvent` 同形），不开新行。
> - **4a 的改动点（逐枚按符号现读定位，行号只是写作时读数）：** `ChartView.interval`（写作时在 `:257`）、`viewPeriod` 返回类型（`:262`）、`viewForSymbol` 的 `interval` 参数（`:275`）、`useState<IntervalKey>`（`:517`）、`pickInterval` 参数（`:1961`）、`periodActiveKey` 标注（`:2608`）；再加 `PeriodPicker.tsx` 的两处——它的 `type IntervalKey` import 行改成同时带入 `AnyInterval`（仍是同一行）与 `active: IntervalKey | null` → `AnyInterval | null`（`PeriodPickerProps` 里那行）。**`PeriodOption.key`／`onPick` 不在 4a**，那是 4b 的接口面。`readSession` 里 `"1D" as IntervalKey`（`:288`）与 `interval as IntervalKey`（`:301`）在 4a 保持原样：窄值赋给宽槽位合法，Task 5 Step 2 第 2 项会把 `:301` 换成 `normalizeInterval`。判据＝`npx tsc -b` 绿 ＋ 两份文件 `wc -l` 前后一字不差 ＋ 既有套件零改口全绿（行为没变，任何一枚针改口都是 4a 越界的证据）。

> - **（2026-10-22 4a 首席 BLOCKED 换来的两处补全，控制席已盘面核实）**
>   ①**第 10 枚消费点在告警支路上**：`viewPeriod` 加宽后 `ProChart.tsx:3402` 那行 `interval={viewPeriod({ interval, timeShare })}` 喂的是 `IndicatorEditor`，而它的 props 写着 `interval?: IntervalKey`（`IndicatorEditor.tsx:61`，import 在 `:15`），再往下 `AlertsTab.tsx:37` 同样窄。⇒ 4a 要把这两枚 props 也加宽到 `AnyInterval`，并把各自那行 `import type { IntervalKey }` 原地换成 `AnyInterval`（`IntervalKey` 在这两份文件里再无别处使用，所以是换不是加，仍不开新行）。运行时面本来就有闸：`AlertsTab.tsx:156` 拿 `BACKEND_INTERVALS` 白名单算 `intervalOk`，`:361` 在 `!intervalOk` 时给可见提示，`translatePineAlerts` 那一侧的 `TranslateOptions.interval` 早就是 `string`——**这条支路对「档位是不是内置」的判据本来就取自白名单而不是取自类型**，所以加宽不带来任何新行为。`ScreenerTab.tsx:50`／`screener.ts`／`ChartCell.tsx:108` 那三处窄类型**不动**：筛选台与四格图走的是页面自带的窄链（Task 2 已裁过），本片的自定义档不进那两个入口。
>   ②**改类型必须顺着注释一起改**：`ProChart.tsx:2605-2606` 那两行注释写着「every IntervalKey is in INTERVALS, so the find always answers」，而 `:517` 加宽后这句话对新状态**不再成立**（自定义串不在 `INTERVALS` 里，`?? interval` 那半从「类型必需」变成「真的会走到」）。⇒ 同笔把这两行注释按现状改口，行数守恒（两行还两行）。
>   ②′**（2026-10-23 4a 评审席 I-1，控制席 `sed -n`／`grep -n` 现读核实）上面那句「变成「真的会走到」」写下时即为假**：`c873dc7a` 落完时 `interval` 的写手还全在 `INTERVALS` 门内——`:517` 来自 `readSession`（`:301` 逐字仍是 `INTERVALS.some((i) => i.key === interval)`），`setInterval` 全文只有一枚调用（`:1906`，在 `setView` 体内），而 `setView` 只有三处调用（`:1940` `viewForSymbol`、`:1966` `pickInterval`、`:1975` `pickTimeShare`），`pickInterval` 的唯一入口是 `:2833` `onPick={pickInterval}` 而 `PeriodPicker.tsx:22` 的 `onPick` 那行逐字还是 `(key: IntervalKey) => void`，`periodOptions`（`:2585`）只 `INTERVALS.map` ⇒ 那半句此刻执行不到。⇒ 已落地的注释写成条件句（`a custom spec string would show the raw spec`），不用「now」；Task 5 让自定义串真能进来时，那两行注释还要按当时的现状再改口一次（同笔、两行还两行）。
>
> **P-2（针的一半天生恒真）**：Step 1 里「内置行没有移除按钮」原写 `within(getByRole("option", { name: "日线" })).queryByRole("button")` 为 null——在选定的行形状下它**恒为 null**：移除按钮是 option 的**兄弟**不是后代，内置行与自定义行都读得到 null，这半枚谁都拒不掉。行形状也不能反过来定：既存 `PeriodPicker.test.tsx:107`／`:115` 断的是 `row.textContent` 逐字等于档位名，把移除按钮嵌进 option 会同时破那两枚针、还写出非法 HTML（button 嵌 button）。⇒ 改判成按可达名点名：`queryByRole("button", { name: /^移除 日线$/ })` 为 null，且自定义行那枚 `getByRole("button", { name: /^移除 / })` 非 null——顺带钉住 `aria-label={`移除 ${option.label}`}` 的拼法。
>
> **P-3（简报指向盘面不存在的东西）**：Step 2 说入口行「摆在 listbox 之后但在弹层容器之内」，而当前 DOM 没有第二个容器——`{open && ( <div id role="listbox"> … ) }` 里 listbox 就是浮层本体。⇒ 裁定：新开一枚外层面板 `div` 承接定位与外观类（`absolute left-0 top-full z-50 mt-1 min-w-full rounded-md border bg-background py-1 shadow-lg`），listbox 那枚 `div` 保留 `id="pro-chart-period-menu"`／`role`／`aria-label` 三件、类名交给外层；入口按钮摆在 listbox **之后**、面板之内。id 留在 listbox 是硬要求：既存 `:68-74` 那枚针断的是 `aria-controls === menu.id` 且 `document.getElementById(menu.id) === menu`。
>
> **P-4（不可达守卫，与上一轮 M-4 同族）**：Step 2 给移除按钮写的 `onMouseDown={(e) => e.stopPropagation()}` 与 `onClick` 里那半句 `e.stopPropagation()` 在本组件内没有任何可观察后果——兄弟之间不冒泡，而 `document` 上那枚外点监听只看 `wrapRef.contains(target)`，移除按钮就在 `wrapRef` 里，触发不了关目录。⇒ 两处都不写；「按移除不选中那档」由 Step 1 的 `expect(onPick).not.toHaveBeenCalled()` 钉，它覆盖的正是同一种失效形状。
>
> **P-5（ARIA 树里多出来的一层）**：行容器那枚 `div` 夹在 `role="listbox"` 与 `role="option"` 之间，按 ARIA 不是 listbox 的合法被拥有元素⇒ 容器写 `role="none"`，让 option 在无障碍树里仍直接归 listbox 所有。移除按钮自己带 `button` 角色、留在 listbox 之下是自家裁定（它既不能嵌进 option——见 P-2——又没有别的合法位置），这条要在注释里写明是裁定不是对面证据。
>
> **Task 4b＝原 Task 4 的全部其余内容**（目录行结构、移除按钮、入口行、五枚新针、`ScriptWorkbench.test.tsx:437` 注释重钉、`PeriodPicker.tsx` 十一枚坐标按内容重钉），外加一条它自己**不碰** `ProChart.tsx` 的约束：4a 已经把页面侧类型链加宽，`onPick={pickInterval}` 与 `active={periodActiveKey}` 在 4b 落地时照旧编译。


**Files:**
- Modify: `frontend/src/components/charts/PeriodPicker.tsx`（109 行；`PeriodOption` 加两字段，行结构见 Step 2）
- Modify: `frontend/src/components/charts/__tests__/PeriodPicker.test.tsx`（**只加 describe 块，既有 21 枚针一字不改**）
- Modify（注释面，行数会变所以必须跟着改）: `frontend/src/components/charts/__tests__/ScriptWorkbench.test.tsx:437` 那条注释按号引用 `PeriodPicker.tsx:65` 的「open 才发 aria-controls」——Step 3 里按**内容**重钉（`grep -n 'aria-controls' PeriodPicker.tsx` 现读），不许留旧号
- Modify（三层文档坐标）: 本任务一改 `PeriodPicker.tsx` 的行数，`forensics/gap-matrix.md` 里所有 `PeriodPicker.tsx:<行>` 坐标都会漂（现读十一枚，见 Step 4 的清单）。Step 4 逐枚按内容重钉——**门禁只判行号在不在范围内，不判那一行的内容**，门全绿时坐标可以指着无关代码

**Interfaces:**
- Consumes: `PeriodOption`（既有）
- Produces:
  ```ts
  export type PeriodOption = {
    key: AnyInterval;          // 原来是 IntervalKey
    label: string;
    title: string;
    disabled: boolean;
    /** 自定义档才有；内置行没有移除按钮。 */
    onRemove?: () => void;
    custom?: boolean;
  };
  export type PeriodPickerProps = { …; onAddCustom?: () => void; };
  ```

- [ ] **Step 1：红的针**（五枚）

在 `PeriodPicker.test.tsx` 末尾追加 `describe("自定义档行与添加入口", …)`：

- 「options 里带 `custom: true` 的行有移除按钮，内置行没有」：`getAllByRole("button", { name: /^移除/ })` 长度＝自定义行数；且 `within(screen.getByRole("option", { name: "日线" })).queryByRole("button")` 为 null。
- 「按移除不会选中那档」：`renderPicker` 传两行（一内置一自定义），点开目录，按自定义行上的「移除」 ⇒ `onPick` **没有**被调用（`expect(onPick).not.toHaveBeenCalled()`）且 `onRemove` 调 1 次。
- 「目录行仍是 `role=option` 一视同仁，入口行不是」：`getAllByRole("option")` 长度＝内置行数＋自定义行数（**不含**「添加自定义周期…」那枚——Step 2 裁定它是普通 `button`，不进 `role=option`），且 `getAllByRole("option")` 每一枚都带 `aria-selected` 属性（`toHaveAttribute`）。
- 「`onAddCustom` 给了就有入口行，按它 ⇒ `onAddCustom` 调 1 次、`onPick` 不调」。
- 「没给 `onAddCustom` 就没有入口」（页面级复用性针，`MultiChart` 那侧不需要入口，见 spec §2「不做」）。

Run → FAIL。

- [ ] **Step 2：实现**

行容器改成 `div`（`flex items-center`）包两枚 button：选档那枚继续带 `role="option"` ＋ `aria-selected` ＋ `disabled` ＋ `title`（与 `:86-103` 逐字同属性，只是外面套了容器）；移除那枚 `type="button"`、`aria-label={`移除 ${option.label}`}`、`title="从周期目录里移除这一档"`、`onMouseDown={(e) => e.stopPropagation()}`、`onClick={(e) => { e.stopPropagation(); option.onRemove?.(); }}`。`role="listbox"` 的容器不变（`aria-selected` 的父级查找依赖它）。入口行：**不是** option——它是一枚普通 `button`（`role` 不给），名字「添加自定义周期…」，摆在 listbox 之后但在弹层容器之内，`onClick` 只调 `onAddCustom`；这样第③片那 21 枚针里的 `getAllByRole("option")` 计数不因入口行而漂移（这是裁定，写进注释）。

- [ ] **Step 3：绿＋提交**

```bash
cd frontend && npx vitest run src/components/charts/__tests__/PeriodPicker.test.tsx   # 26 枚左右全绿，既有 21 枚未改口
cd frontend && npx tsc -b
```

- [ ] **Step 4：坐标重钉（行数变了，这步不许跳）**

```bash
grep -rn "PeriodPicker\.tsx:[0-9]" forensics/ frontend/src --include='*.md' --include='*.tsx'   # 每枚命中都要 `sed -n '<N>p'` 现读，对不上就按内容重钉
python tools/forensics_audit.py; python -m pytest tools/test_forensics_spec.py -q              # 三层咬合两门
```

本计划写作席 `grep -rno "PeriodPicker\.tsx:[0-9]\+" forensics/ frontend/src` 的现读清单：`forensics/gap-matrix.md` 第 91 行（TV-CI-02）钉 `:29／:66／:78／:85／:90／:99`，第 92 行（TV-CI-03）钉 `:63／:80`，第 98 行（TV-CI-09）钉 `:81`，第 100 行（TV-CI-11）钉 `:91`；`forensics/spec/` 下**零命中**（所以别去改 spec 面）；码内注释一处 `ScriptWorkbench.test.tsx:437` 钉 `:65`。这十一枚都要随本任务的行数改动重钉。**门只判行号在文件行数范围内，不判那一行写的是什么**，所以这一步的判据是「逐枚 `sed -n '<N>p'` 读出原文、与文档引用的句子一致」，不是「门绿了」。

```bash
git add -- frontend/src/components/charts/PeriodPicker.tsx frontend/src/components/charts/__tests__/PeriodPicker.test.tsx frontend/src/components/charts/__tests__/ScriptWorkbench.test.tsx forensics/gap-matrix.md
git commit -s -m "feat(l3-slice6): 周期目录支持自定义档行（移除按钮并排不嵌套）与添加入口"
```

---

### Task 5：`ProChart.tsx` 接线（清单 · 会话 · 分时互斥）

**Files:**
- Modify: `frontend/src/pages/ProChart.tsx`（坐标由实现席当场 `grep -n` 取，本计划只给**符号名**与要改的行为）
- Create: `frontend/src/pages/__tests__/ProChartCustomInterval.test.tsx`（D 组针的新家；仓内**没有** `ProChartPeriods.test.tsx`，别去找）
- Modify: `frontend/src/pages/__tests__/ProChartMinuteBars.test.tsx`（从 `../ProChart` import `readSession`，:156／:197／:202 三处整对象 `toEqual` 随会话加键连带改口）
- 回归面（当场数，别只改一处）：`frontend/src/pages/__tests__/` 下 11 份渲染 `ProChart` 的页面测试（`grep -rln "ProChart" frontend/src/pages/__tests__` 现读），其中 7 份含「分时」字样
- 参照：`ProChart.tsx:190`（`SESSION_KEY`）、`:262`（`viewPeriod`）、`:287`（`readSession`）、`:810`（写会话）、`:1877-1927`（`setView`）、`:1961-1966`（`pickInterval`）、`:2585-2608`（`periodOptions`）

**Interfaces:**
- Consumes: `AnyInterval`／`normalizeInterval`／`intervalAllowed`（Task 2）、`PeriodOption.onRemove`／`onAddCustom`（Task 4）、`CustomIntervalDialog`（Task 3）、`specLabel`／`validateDraft`（Task 1）
- Produces: 会话 schema 多一个键 `customIntervals: string[]`（写在 `:810` 那个 `JSON.stringify` 里），`readSession()` 返回 `customIntervals`

- [ ] **Step 1：红的针（D 组）**

- 「加入后目录出现新行且当前周期是它」：渲染页面（沿用既有页面测试的替身），点开目录 → 按「添加自定义周期…」→ 在对话框里点单位「小时」、`fireEvent.change` 数值为 `2`（**测试里用 fireEvent，不是 fill，动作边界只管活体取证**）→ 按加入 → 断目录里出现 `role="option"` 名字「2小时」且 `aria-selected="true"`；断 `fetchKline` 替身被调用时 `resolution` 参数为 `"120m"`（`vi.mock` 掉 `@/lib/marketApi` 的 `fetchKline`，或断 `globalThis.fetch` 的 URL 里 `searchParams.get("resolution") === "120m"`，两种姿势选页面测试既有那种）。
- 「坏串不进目录」：`readSession` 的替身返回 `interval: "2d"` ⇒ 当前周期显示为「日线」，且目录里没有「2d」。
- 「自定义档时分时按钮 disabled 且 title 指名服务端那条拒绝」：先加一档 `2小时`，再读分时按钮的 `disabled` 与 `title`（title 里要有「分时不能与折叠档同时」这一句，不含「不支持」字样）。
- 「按移除后当前周期不是被移除那档，且不产生新的取数请求」：移除前记录 fetch 调用次数，按「移除」⇒ 次数不变、当前周期回到前一档（`1D`）。
- 「会话往返」：加入 `2W` → 断 `localStorage.setItem` 的 payload 里 `customIntervals: ["2W"]`；用该 payload 重新 `readSession()` ⇒ 目录里有「2周」。
- 「内置档路径零变化」：**仓内既有页面测试里没有数目录行数的针**（本计划写作席 `grep -rn 'getAllByRole("option"' frontend/src/pages/__tests__` 只在 `RunDetail.test.tsx` 命中，与周期无关），所以这条要在本任务的新文件里自己钉：默认态（无自定义档）`getAllByRole("option")` 恰 8 枚，名字逐字等于 `INTERVALS` 的八个 label。

- [ ] **Step 2：实现**

1. 状态：`const [customIntervals, setCustomIntervals] = useState<string[]>(session.customIntervals)`；`interval` 的 `useState<IntervalKey>` 改成 `useState<AnyInterval>`（`:517`）。
2. `viewPeriod` 返回类型 `AnyInterval`；`readSession` 的 `:301` 那行换成 `normalizeInterval(parsed.interval)`，并新增 `customIntervals: Array.isArray(parsed.customIntervals) ? parsed.customIntervals.filter(isCustomSpec).filter(unique) : []`（**filter 用 `isCustomSpec`，不是 `normalizeInterval`**：会话里躺着一枚 `1D` 当自定义档是脏数据，丢掉而不是显示两行同名）。
3. `pickInterval(iv: AnyInterval)` 守卫不变（`intervalAllowed` 已加宽）。
   - **（2026-10-22 第 4 轮预检改口）本项与前两项的类型半已经在 Task 4a 落地**：`ChartView.interval`／`viewPeriod`／`viewForSymbol`／`useState`／`pickInterval`／`periodActiveKey`／`PeriodPickerProps.active` 都已是 `AnyInterval`，且是行内改字（`ProChart.tsx` 行数未变）。Task 5 在这里只剩行为面：会话多一个 `customIntervals` 键、`readSession` 的 `normalizeInterval` 与 `isCustomSpec` 过滤、`periodOptions` 拼自定义行、增删与分时互斥。
4. `periodOptions`：`INTERVALS.map(...)` 之后 `concat(customIntervals.map((key) => ({ key, label: specLabel(key) ?? key, disabled: !intervalAllowed(symbol, key), custom: true, title: `自定义档：${key} 由基档折叠而成（服务端负责折叠），点「移除」可以从目录里删掉这一档`, onRemove: () => removeCustomInterval(key) })))`。
   - **（2026-10-23 第 4 轮预检补，Task 4a 评审席 I-2）入口按钮的名字必须跟着目录走**：`periodTriggerLabel` 现在逐字是 `INTERVALS.find((i) => i.key === interval)?.label ?? interval`，而上面第 4 项给自定义行定的名字是 `specLabel(key) ?? key` ⇒ 选中 `120m` 那一行读「2小时」、按钮读 `120m`，这正好拆掉 `forensics/gap-matrix.md` TV-CI-02 那格钉的「入口按钮的可达名逐字等于选中行的可达名」（组件级针 `PeriodPicker.test.tsx:110` 比的是 props 传进去的字，救不了页面级；`ProChartTimeShare.test.tsx` 那腿只跑内置档）。⇒ 改法一句：`periodTriggerLabel` 从**拼好的目录**里取——`const periodTriggerLabel = periodOptions.find((o) => o.key === interval)?.label ?? interval;`（`periodOptions` 是 `useMemo`，声明在这句之前；执行席按符号现读核对顺序，别按这里的号）。分时态不在这条的适用面里：`active===null` 时没有行声称被选中，按钮照旧报档位名。**针**：页面级补一枚「选中自定义档时周期按钮的可达名逐字等于那行的可达名」，两边都从 `specLabel` 取，不许一边拿串一边拿名；同笔把 `:2605-2606` 那两行注释按新现状改口（两行还两行）。
5. `addCustomInterval(spec)`：去重后 append、`pickInterval(spec)`、关对话框。`removeCustomInterval(spec)`：从清单里摘掉；**若摘的正是当前周期**，`setView({ interval: "1D", timeShare: false }, true)`，否则只改清单不动当前周期（这就是「按删除不会先换档」那枚针的落点）。
6. `:810` 写会话时带上 `customIntervals`。
7. 分时互斥：分时按钮的 `disabled` 条件加 `|| !isBuiltinInterval(interval)`，`title` 在自定义档时逐字给 `分时只画当日 1 分钟线；当前档位 ${interval} 是折叠档，分时不能与折叠档同时（服务端会拒绝 session=latest）`（这句就是 Step 1 那枚针 `stringContaining("分时不能与折叠档同时")` 的落点，两处必须同串）；`pickTimeShare()` 里同条件早退。
8. 对话框渲染：`{customDialogOpen && <CustomIntervalDialog existing={[...INTERVALS.map(i => i.key), ...customIntervals]} onCancel={close} onAdd={addCustomInterval} />}`，与目录**同时**存在与否的裁定：打开对话框时把目录 `open` 关掉（目录那层浮层与对话框叠两层浮层没有凭据，也没有可用形状），但**目录组件本身不卸载**——C-3 那枚针在组件层钉的是这个。这条要在代码注释里写明是「自家裁定，对面的证据只到共存为止」。
   - **叠层监听器的落地细则（2026-10-22 第 3 轮评审补，Task 3 的 M-5）**：`CustomIntervalDialog` 在 `document` 上挂了 `mousedown`／`keydown` 两枚监听（本组件 `useEffect` 里那一对，行号随改动会漂，按符号找），`PeriodPicker` 的浮层也在 `document` 上挂自己的外点／Escape。页面接线时按「对话框开 ⇒ 目录的 `open` 先关」这一条走，就能保证同一趟里 `document` 上只有一套监听在关东西；**针摆在这里**（D 组补一枚）：目录开着时点「添加自定义周期…」⇒ 一趟点击之后对话框是开着的（不是「开了又被目录的外点监听在同一趟里关掉」），且此后按一次 Escape 只关对话框、焦点回到周期按钮。若页面实现改成两套浮层真同时挂着，这枚针就是那条歧路的报警器。
9. MTF：Task 2 已在 `indicatorLang` 侧挡住；页面里 `:1283` `periodToInterval(period)` 的返回值已是 `AnyInterval`，透传给 `fetchKline` 即可。

> **（2026-10-23 控制席 Task 5 预检补，八枚，全部盘面现读取证）**
> ①**`readSession` 的返回类型标注要跟着长**：现读 `export function readSession(): ChartView & { symbol: string } {`。上面第 2 项要往返回对象里塞 `customIntervals`，而标注里没有 ⇒ `tsc` 红在缺／多余字面量属性。⇒ 同笔把那行标注改成 `ChartView & { symbol: string; customIntervals: string[] }`（行内改字，不插行）。
> ②**写会话那枚 `useEffect` 的依赖数组漏不得**：现读那句是 `JSON.stringify({ symbol, interval, timeShare })`，尾行 `}, [symbol, interval, timeShare]);`。第 6 项只说「带上 `customIntervals`」⇒ payload 与**依赖数组**两处都要带上，只改前者时「移除一档而摘的不是当前周期」那一路根本不重跑 effect，会话里那档留在盘上；「加入」那腿恰好顺带改了 `interval`，会把这洞掩盖掉。⇒ 针补一枚：按「移除」（摘非当前档）之后 `localStorage.setItem` 的 payload 不再含那串。
> ③**`.filter(unique)` 里的 `unique` 盘面不存在**：`grep -rn "export function unique\|const unique" frontend/src/lib/` 零命中，那是本计划写作席造的假符号（与 Task 4 的 P-3 同型）。⇒ 裁定：就地用 `Array.from(new Set(...))` 去重，**不**新开 helper——`addCustomInterval` 已经有「去重后 append」，两处共用一枚 `unique` 反倒是多一份真理。
> ④**import 面要长**：`isBuiltinInterval`／`normalizeInterval`（都在 `lib/marketApi.ts`）与 `specLabel`／`isCustomSpec`（都在 `lib/customInterval.ts`）四枚**都不在** `ProChart.tsx` 现有 import 里（现读页面只从 `@/lib/chartView` 拿 `intervalAllowed, repairInterval`）⇒ 本任务要扩 `@/lib/marketApi` 那枚 import 块并新增 `@/lib/customInterval` 一行。另两枚已核不撞：`CustomIntervalDialogProps.existing` 是 `readonly string[]`，所以第 8 项那句「内置八档＋自定义串」拼进去合法；`setView(view, reload)` 的第二参数必填，第 5 项那句 `setView({...}, true)` 与签名一致。
> ⑤**归 Task 5 的文案连带（Task 2 的 parked ③）**：`lib/chartView.ts` 里那句点名「四格图、筛选台」的注释——`screener.ts` 走的是自带窄类型、根本不调 `repairInterval`，所以那句话对筛选台说的比代码做的多。本任务动了页面侧的档位语义，同笔按**符号**现读该注释并按现状改口（行数守恒）；`lib/**` 其余一字不动。
> ⑥**分时互斥必须落在 `viewForSymbol` 这个共享谓词里，不能只落在按钮上**（控制席 2026-10-23 盘面现读，`ProChart.tsx:273-282`）：那函数现在逐字是
> ```ts
>   return {
>     interval: repairInterval(symbol, interval),
>     timeShare: timeShare && intervalAllowed(symbol, TIME_SHARE_INTERVAL),
>   };
> ```
> 而 `intervalAllowed`（`lib/chartView.ts:37`）只看 symbol（`isCalendarInterval(interval) || canMinuteBars(symbol)`），**从不问这一档是不是内置**——`"120m"` 在分钟源上返回 `true`。今天不出事，只因为 `readSession` 在钳位那行把档位压回内置八档（现读逐字 `const span = INTERVALS.some((i) => i.key === interval) ? (interval as IntervalKey) : "1D";`）；上面第 2 项正是用 `normalizeInterval(parsed.interval)` 换掉那行，而 `normalizeInterval` **接受合法自定义串** ⇒ 会话里躺着 `{interval: "120m", timeShare: true}` 时，恢复出来就是「折叠档 ＋ 分时同时开」，把第 7 项要立的互斥从背后拆掉。第 7 项那三件（按钮 `disabled`、`title`、`pickTimeShare` 早退）全是**点击面**的门，管不到这条没有按钮参与的路径，而且它红不了任何既存针。⇒ 裁定：互斥门加在共享谓词里，两个入口（会话恢复那处、换 symbol 那处）自动继承——`timeShare: timeShare && intervalAllowed(symbol, TIME_SHARE_INTERVAL) && isBuiltinInterval(interval)`（行内改字，一行还一行；`isBuiltinInterval` 已在 ④ 的 import 扩列里，不新增符号）。`readSession` 的钳位改回「先 `normalizeInterval` 再交给 `viewForSymbol`」，别在钳位里偷偷保留八档假设——那会让自定义档根本进不了目录，与本任务的目标对撞。**针补一枚（D 组）**：喂进一坨 `interval` 是合法自定义串且 `timeShare: true` 的会话 ⇒ 恢复后 `timeShare` 为 `false`，且当前周期仍是那档（目录里那行 `aria-selected="true"`）。
> ⑦**`periodOptions` 那枚 `useMemo` 的依赖数组同样漏不得**（控制席 2026-10-23 现读 `ProChart.tsx:2585-2604`，尾行逐字 `    [symbol],`）：上面第 4 项要往那工厂里 `concat` 自定义行，而依赖只有 `[symbol]` ⇒ `customIntervals` 变了工厂**根本不重跑**，加入的那档不会出现在目录里、移除的那档也不会消失；同笔按第 4 项下那条改口句（`periodTriggerLabel` 从 `periodOptions` 取）会连带失效——目录里没有那行，`find` 落空走 `?? interval`，按钮念的是裸串 `120m`，正好把 TV-CI-02「按钮可达名逐字等于选中行可达名」再拆一遍，而且**这次是 `tsc` 全绿、六门全绿的静默错**。⇒ 依赖数组要带上 `customIntervals`（那枚工厂并不读 `interval`，别顺手把它加进依赖白送一次全目录重建）。另：`addCustomInterval`／`removeCustomInterval` 两枚处理函数声明在 `periodOptions` **之前**，别让 memo 工厂的闭包去引用还没初始化的 `const`。
> ⑧**「打开对话框时把目录 `open` 先关」这句只能落在组件里**（第 8 项与那条叠层细则的执行面；控制席现读否证了页面侧姿势）：`open` 是 `PeriodPicker` 的**内部状态**——现读 `PeriodPickerProps` 只有 `options`／`triggerLabel`／`active`／`onPick`／`onAddCustom` 五枚，没有任何受控开关，页面**拿不到**它；而入口行那枚 `onClick` 现读逐字是 `onClick={onAddCustom}`，既不关目录也不动焦点。⇒ 若照计划字面去写「页面把目录关掉」，执行席只剩两条路：给 4b 刚收口的组件新加一枚 prop，或把 `open` 抬成受控——两条都要动那批按号引用的坐标。裁定：**改在入口行那一处 `onClick`，行内改字、行数守恒**——`onClick={() => { setOpen(false); triggerRef.current?.focus(); onAddCustom(); }}`（`triggerRef` 组件里现读已有；`{open && (` 那一层只管浮层，trigger 常驻 DOM，所以关目录不会把焦点打进 `body`）。**焦点面**：`CustomIntervalDialog` 整份不碰焦点（现读 `grep -n "focus" frontend/src/components/charts/CustomIntervalDialog.tsx` 零命中；它没有焦点陷阱，那是 Task 3 按「对面没有锁焦点的凭据」定的），所以入口点击时把焦点压回周期按钮，对话框整段开着期间焦点就住在按钮上、关掉之后仍在 ⇒ 第 8 项那枚针「此后按一次 Escape 只关对话框、焦点回到周期按钮」**不需要页面侧任何管道**；这也正是这条必须在组件里做的原因——页面既不认识那枚 trigger，也没有句柄。⇒ 组件级针补一枚（追加在测试文件末尾，别插进既存区）：点入口 ⇒ `onAddCustom` 恰一次、目录关（`queryByRole("listbox")` 为空）、`document.activeElement` 是那枚周期按钮。这条与「移除之后目录保持开着」两不相犯：**入口是「换一层浮层」，移除是「就地改清单」**，两枚处理器天生不同，别给它们加同一个开关。

- [ ] **Step 3：绿＋提交**

```bash
cd frontend && npx tsc -b
cd frontend && npx vitest run          # 全量。会话 schema 多一个键会打破整对象比对：`ProChartMinuteBars.test.tsx` 从 `../ProChart` 直接 import `readSession`（:37），三处整对象 `toEqual` 在 :156／:197／:202，随本片连带改口。`MultiChart.test.tsx` 的 `readSession` 是 `../MultiChart` 自己的函数，不受影响，别去改它
git add -- frontend/src/pages/ProChart.tsx frontend/src/pages/__tests__/ProChartCustomInterval.test.tsx frontend/src/pages/__tests__/ProChartMinuteBars.test.tsx
git status --porcelain && git commit -s -m "feat(l3-slice6): ProChart 接线——自定义档进目录、会话持久化、分时互斥"
```

- [ ] **Step 4：坐标重钉（这笔在 `ProChart.tsx` 里插了行，这步不许跳）**

Task 5 不是行中性任务：新增状态、增删处理函数、对话框渲染都要插行 ⇒ `ProChart.tsx` 的行数必变。按号引用的 `ProChart.tsx:<N>` 坐标会整片漂，而三层咬合那把「实现坐标」门**只判行号在文件行数范围内、不判那一行写的是什么**⇒ 门全绿时坐标可以指着无关代码。写作席现读：`grep -rno "ProChart\.tsx:[0-9]\+" forensics/`＝`forensics/gap-matrix.md` 32 枚、`forensics/spec/chart-interaction.md` 4 枚；`frontend/src` 与 `agent/src` 的码内注释另有几十枚（`ProChartHeikinAshi.test.tsx`／`ProChartPanels.test.tsx`／`lib/vpvrChart.ts`／`lib/heikinAshiChart.ts` 等）——分母一律自己当场取。

逐枚姿势：`sed -n '<N>p'` 读出那一行，与引用它的那句话比对；对不上就按**内容**重钉新号，不许拿「整体前移 k 行」平移（插入点前后的号不同动）。判据是「逐枚读出原文与引用句一致」，不是「门绿了」。

- **同笔必改的一处逐字引用（2026-10-23 复评席的新 Minor，控制席盘面核实）**：`forensics/gap-matrix.md` 第 91 行（TV-CI-02）的口径句逐字写着「页面把当前档位那一项的中文 label 原样喂进来：`frontend/src/pages/ProChart.tsx:2607` 逐字 `const periodTriggerLabel = INTERVALS.find((i) => i.key === interval)?.label ?? interval;`，于 :2831 以 `triggerLabel={periodTriggerLabel}` 传入」。Step 2 第 4 项下那条 2026-10-23 补条目把那行改成从 `periodOptions` 取，而 `:2831` 这枚号也随插行漂 ⇒ 本格的新号与新逐字串必须与代码同笔改口；否则矩阵对外说的话与树不符，而两把门谁都看不见。
- **裸 `:NN` 散文号（2026-10-23 控制席裁定，源自 Task 4b 报告 §8.1，控制席已盘面复核）**：正则分母 `PeriodPicker\.tsx:[0-9]\+` 看不见 `forensics/gap-matrix.md` 里写成「（:63）」这种**不带文件名前缀**的散文号，而 4b 只重钉了带前缀那批 ⇒ 同一物理行里现在两代号并存。判据按**引用它的那句是不是带日期的读数块**分两支，不许一刀切：
  - 句子在「（本席 2026-10-18 …现读）」这类括号之内，或明写「它是**当时为真**的读数」「旧文一字不删」⇒ **裸号照旧不动**。那是 bytes 层历史证据，改号等于同时破「带日期读数逐字保住」与「原句一字不删」两条本文件惯例。同型地，第 92 行那句「`sed -n` 现读，该文件仍 109 行」说的是 2026-10-18 那趟读数时的文件，**今天仍然为真**，不许改成 155。
  - 句子不带日期、对外说的是**当下形状** ⇒ 裸号按**内容**重钉，一句话里不许并存两代号。控制席现读的那枚样板（号要自己重取）：「形状说全：…浮层那枚 `id`（`PeriodPicker.tsx:95`）只随 :78 的 `{open && (` 在开态进 DOM」——前半已随 4b 钉到 155 行时代，后半那枚裸号还留在 109 行时代。
  - 分母自己当场取（控制席 2026-10-23 在第 91／92 两行数到 15 枚裸号，这个数只是线索，不是证据），报告里逐枚列「裸号 → 引用句摘 → 属不属于带日期读数块 → 留／改 → 改后号与 `sed -n '<新号>p'` 原文」。
- **Step 4 的分母随「本片截至派席时真正改过行数的文件」取全**，不许照抄上面写好的任何一张清单：`grep -rno "ProChart\.tsx:[0-9]\+" forensics/ frontend/src agent/src`、`grep -rno "PeriodPicker\.tsx:[0-9]\+" forensics/ frontend/src agent/src` 与裸号那条式子都要现跑——若 Task 4b 因评审返工再次改动 `PeriodPicker.tsx` 行数，它那批号也会再漂一次，本步是唯一的收口处。
- **矩阵第 100 行（TV-CI-11）那句「未找到」由本笔转为对外假话，同笔带日期登记**（2026-10-23 控制席裁定，源自 Task 4b 报告 §9 顾虑 3，控制席已 `sed -n '100p'` 现读）：那格里逐字写着「未找到：目录行上『已在列表里／移出』那枚第三格……⇒ 本仓目录没有收藏与移出概念」，而 `ca78a320` 起 `PeriodPicker.tsx` 已有「移除」按钮，本任务又把 `onRemove` 接到页面——那句话从对外读法上不再为真。裁定：**判态 `部分` 不动、`L0 依据` 不断**（收藏格子确实仍没有，宿主持久化仍没有，第 7 片 Step 3 才动判态），但要在**同一物理行内**追加一句带日期的登记，写明本席现读的三件：那枚按钮的 `aria-label` 拼法与其行号、`onRemove` 消费点的行号、复跑命令的新命中数（`grep -rn --include=*.tsx -e "Remove" -e 移出 -e 移除 frontend/src/components/charts/PeriodPicker.tsx` 现跑）。行中性：只在行内追加，矩阵前后 `wc -l` 一字不差（控制席 2026-10-23 现读 125 行，席上自己重取，别拿这个数当证据）。
- **矩阵复跑命中数登记的归属（2026-10-23 控制席裁定，源自 Task 4b 评审席 Important 1／2）**：那两枚发现都落在 `forensics/gap-matrix.md` 的第 91／92／98／100 四个物理行上，而本任务与 4b 修复轮会先后碰同一批单元。切法按**谁改得动**：4b 修复轮只收 91／92 里那些**不带文件名前缀的裸 `:NN`**（它们指 `PeriodPicker.tsx`，而 4b 之后没人再动那个文件的行数）；**不带日期的复跑命中数**（`移除`／`Remove`／`aria-disabled` 那几把尺在 91／98／100 三行里的「同跑＝0 命中」「命中 6 行」一类断言）连同第 100 行那句「未找到」的登记一律归本步——因为本步还要在同一格里改 `periodTriggerLabel` 的逐字串并换 `onRemove` 的宿主坐标，两笔合成一笔比两席各改一半稳。执行本步时：那些命中数**当场 `grep -c` 自取**，不许引用别处写好的数；登记写成行内带日期子句，旧读数逐字保住，矩阵前后 `wc -l` 一字不差。
- 两门：`python tools/forensics_audit.py`、`python -m pytest tools/test_forensics_spec.py -q`；报告里把 `grep -rn "ProChart\.tsx:[0-9]" forensics/ frontend/src agent/src` 的命中逐枚列成「号→重钉后的号→引用句摘」的清单（枚数当场数）。
- 文档面单独一笔盖章提交，pathspec 只列被改的 `forensics/**` 与码内注释文件；码面那笔（Step 3）已经先行，别让两面的改动混在同一笔里。

---

### Task 6：红线针（E 组）＋变异自证十一枚＋六道门

**Files:**
- Modify: `frontend/src/components/charts/__tests__/PeriodPicker.test.tsx`（E 组两枚）
- Create: `frontend/src/pages/__tests__/ProChartCustomIntervalRedline.test.tsx`（E 组页面半枚就住这里，与 Task 5 的 `ProChartCustomInterval.test.tsx` 分开：前者钉「disabled 只由 `intervalAllowed` 决定」这类形状，后者钉功能闭环）
- 无生产码改动（除非变异自证揪出真缺陷——那就改，并在报告里单列）
- **（2026-10-23 从 Task 4a 评审席登记来的两枚文案候选，复评时逐条裁定）**①`AlertsTab.tsx` 头上那句「rules on 1W/1M cannot be polled by the backend」只举了内置两例，而自定义折叠档同样被 `BACKEND_INTERVALS` 白名单拒在服务端之外（判据在 `AlertsTab.tsx` 的 `intervalOk` 那一行）——那句话不是假的，但对外举的例子不全。②`frontend/src/lib/pineAlertRules.ts` 里写在 `interval: string` 头上的那句「in `marketApi`'s `IntervalKey` vocabulary」，自定义档真能走到它（Task 5 之后）就不准了。两枚都是**注释面**，与本节上一条「无生产码改动」不冲突（注释不是码）；改则行数守恒，不改要在报告里写明为什么不改。两枚的 `file:line` 一律当场 `grep -n` 现读，别引用这里写的号。

> **（2026-10-23 控制席归口）Task 1／2／3／4a 各轮评审判「不进当轮返工、归 Task 6」的条目一共这些枚**——它们此前只活在台账里，而执行席只读本节，所以逐条搬进计划。**每枚要么落地、要么在报告里写明不改的理由**，`file:line` 一律当场 `grep -n` 现读，别引用这里写的符号下面的任何号：
> - **文案复评组**：`marketApi.ts` 里 `AnyInterval` 那句 doc 把「八档 ∪ 合法自定义串」说得过头（它的底层就是 `string`）；同文件 `normalizeInterval` 那句只写「坏串退 `1D`」，没说越界串也退；`customInterval.ts` 头上那句「本文件那条」实际指的是测试文件而不是本文件；同文件 `FRONTEND_ONLY_REJECT` 桶含 `1000m`，「前端越界拒」四个字的对外读法容易被当成「`isCustomSpec` 那道门也拒」，而按跨度判之后 `1000m` 已翻真 ⇒ 补半句归口（说的是手打数那把尺）。
> - **针面补形组**：`periodToInterval` 拿到非整数 span 时那枚 `??` 出口能铸出 `0m`／`NaNm`（无门）⇒ 补针；`chartView.ts` 里 TV-CI-11 那句红线被拆在同一处两行注释里 ⇒ 逐字针**不许**写成单行 `toContain`；`indicatorLang.ts` 那枚守卫自定义档提前 return 后另一枝永不执行 ⇒ 用假 chart 替身 `getPeriod: () => ({ type: "minute", span: 120 })` 补形；`CustomIntervalDialog.test.tsx` 那枚只把 `min` 钉成字面 `"1"`、没有跨源腿 ⇒ 决定补不补并写明理由；`onAdd("")` 那半分支按当前计划不可达且无针 ⇒ 变异面按名清。
> - **死针与合表组**：`customInterval.test.ts` 里那半枚「反向」针是恒绿死行（它前面那行已无条件断 `ok === true`，而 `ok: true` 分支没有 `reason` 字段），替代活写法 `expect(custom, "7m").toEqual({ ok: true, spec: "7m" })`；内置表三份（`INTERVALS` 键表／`INTERVAL_MS`／测试内 `builtinLabels`）今天单独漂移仍不红 ⇒ 按 spec §9 的口径决定合不合表，不合要写明。
> - **复跑组**：`cd agent && python -m pytest tests/test_interval_spec_frontend_align.py -q`（跨语言对账表，Task 1 修复轮只动 TS 面时按条件豁免过）；每枚加宽 helper 的自定义侧／坏串侧各补一枚注入，按 helper 清点，别只跑 spec §9 那十一枚。
> **门读数顺序**：本节 Step 3 那句「G5 会因 L2 新增坐标（Task 7）而需要先跑一次『缺→部分』的改口」按盘面纠正——Task 6 **不动** `forensics/gap-matrix.md` 的判态行（TV-CI-09／10／11 的「缺→部分」是 Task 7 Step 3 的活），所以 Task 6 这趟 `python tools/forensics_audit.py` 应当在矩阵现状上直接绿；若它红，红的是本任务自己引入的坐标，不是顺序。

- [ ] **Step 1：E 组针**

- 「目录行的 `disabled` 位只由 `intervalAllowed` 决定」：在 `PeriodPicker.test.tsx` 里用同一组 options 渲染两次，只改 `disabled` 字段，断言可达结构（`option` 枚数、`aria-selected`、移除按钮枚数）不变而 `button[disabled]` 枚数随之变——即「组件不从 label／custom 标记推定可用性」。
- 页面侧：把 `intervalAllowed` 在本页的可观察后果钉住——BTC 标的下自定义分钟档 `disabled === true`、`2D` 档 `disabled === false`，且**没有**任何一行因为「对面那侧曾见过 disabled」而摆位（注释里指 `forensics/spec/chart-interaction.md` 的 TV-CI-11，不复述它的数）。

- [ ] **Step 2：变异自证（spec §9 的 M-1…M-11）**

每枚注入 → 记下红的针名；判 HARNESS-BLIND 的要在报告里单列并补针或写明限制。Windows 侧调用纪律照 `verify-mutation-probe-windows-harness` 那条：还原只从动手前的**内存副本**写回，别用 `git checkout --`，改完看全树 diff。

- [ ] **Step 3：六道门＋恒红门归属**

```bash
cd frontend && npx tsc -b; npx vitest run; npx vite build
python tools/test_wiki_drift.py -q; python tools/forensics_audit.py; python -m pytest tools/test_forensics_spec.py -q
bash tools/wiki_freshness_gate.sh; bash tools/ci_grep_gates.sh | sed -r 's/\x1b\[[0-9;]*m//g'
```

G7／G8`[gate b]` 若仍红：按「本片 0 贡献」归档，判据要**同树 before/after**（本片动了 `frontend/**`，所以 before 读数必须在同一棵树上、动手之前取，并留成未跟踪文件）。G5 会因 L2 新增坐标（Task 7）而需要先跑一次「缺→部分」的改口——顺序按 spec §10。

- [ ] **Step 4：提交**（测试面单独一笔）

---

### Task 7：活体验收（受限）＋三层回灌＋档案＋整支评审

- [ ] **Step 1：活体（只做打开类动作）**

prod 构建＋后端真进程（asset 指纹对账：服务里的 `assets/index-*.js` 与本地 dist 那枚同名）。自动可跑到第 3 步（spec §8）：目录浮层出现 → 对话框出现且目录节点同时在 DOM → 单位 listbox 出现、option 枚数 5、`aria-selected` 恰一枚。**第 4～5 步要 `fill`**：由控制席本人手工完成一次（加入 `120m`、读到 `resolution=120m` 的真实响应与根数对比），登记为「人做的、非 REA 取证面」，**不进 L0**；这条限制在档案 §7.31 里写明。
- [ ] **Step 2：未来函数自查五步**（前缀不变量 ＋ Bar Replay 游标在自定义档上不跳未来根）
- [ ] **Step 3：L2 回灌**：TV-CI-09／10 由「缺」→「部分」，列 3 填自家 `frontend/src/components/charts/…:行`（**改过 `frontend/**` 之后按内容逐枚重钉行号**，不引用 Task 写作时的号）；TV-CI-11 列 3 换成本片新坐标。三格 `L0 依据` 不许断（G5 的孤儿规则）。
- [ ] **Step 4：档案 §7.31**（bytes 层追加，断 `CR==LF==CRLF`、裸 CR/裸 LF 为 0，数 CR 只用 `tr -cd '\r' | wc -c`）
- [ ] **Step 5：记忆更正**（`chart-timeshare-and-coarse-period.md` 补「前端自定义档闭环」一面；`feedback-auto-proceed-standing-approval.md` 若动作边界有变要重述）
- [ ] **Step 6：整支评审**（`superpowers:requesting-code-review`）→ 修复波 → 收窄复评 → `superpowers:finishing-a-development-branch`（推荐路径：纯快进合入本地 main 并推 origin/main，随后匿名复读外部 CI）

---

## 自检（写计划的人自己跑一遍）

- **Spec 覆盖**：§2「做」的七项 ↔ T1-T7 全覆盖；「不做」五条在 Global Constraints 或各任务里逐条落为「不许做」；§4 的边界在 T1 的 `FRONTEND_ONLY_REJECT` 桶与 `validateDraft` 针里；§5 的三条结构约束分别在 T2（车道）、T2 Step 3（MTF 降级）、T5 Step 2-7（分时）；§6 那张表的七把尺 ↔ C-1…C-9；§7 六组针 ↔ T1/T2/T3/T4/T5/T6；§8 八步 ↔ T7（前 3 步自动、后 5 步人工登记）；§9 十一枚变异 ↔ T6 Step 2；§10 门禁与文档面 ↔ T6 Step 3 ＋ T7 Step 3-4。
- **占位符**：无未落实的待定处。写作稿里原本有一处尖括号包的文件名占位和一处「若无此文件则新建」的说法，本轮已收口为实名 `ProChartCustomInterval.test.tsx`（已确认仓内不存在此名，它是新建的家）。文中所有坐标都是写作席当场读数，执行时若已漂，按 `plan-text-red-at-execution` 与 `ops-staged-multiface-commit-needs-pathspec` 的纪律**现读重钉，不许把本计划里的号当证据**。
- **类型一致性**：`AnyInterval`（T2 定义，T4/T5 消费）、`PeriodOption.custom`/`onRemove`（T4 定义，T5 消费）、`specLabel`/`validateDraft`/`isCustomSpec`（T1 定义，T2/T3/T5 消费）三处签名与 Task 1/2/4 的 Produces 一致。
