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
  - `function draftToSpec(draft: Exclude<CustomIntervalDraft, { n: null }>): string`
  - `function parseSpec(text: string): { unit: "m" | "D" | "W" | "M"; n: number } | null`
  - `function isCustomSpec(text: string): boolean`（文法合法**且**不是内置八档之一）
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
def test_agreed_ok_round_trips_as_itself(self, text):
    assert parse_interval(text) is not None, text
    assert parse_interval(text).interval == text, text


@pytest.mark.parametrize("text", AGREED_REJECT)
def test_agreed_reject_is_refused(self, text):
    assert parse_interval(text) is None, text


@pytest.mark.parametrize("text", FRONTEND_ONLY_REJECT)
def test_frontend_cap_is_stricter_than_the_server(self, text):
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
  it("五档，顺序固定，range 家族没有取数面所以不在这里", () => {
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
  const parsed = parseSpec(text);
  return parsed !== null && !BUILTIN_SPECS.has(`${parsed.n}${parsed.unit}`);
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
- Test: `frontend/src/lib/__tests__/marketApiCustom.test.ts`（新）
- 不许动：`frontend/src/lib/__tests__/udfTransport.test.ts:113`、`frontend/src/lib/__tests__/marketApiPeriods.test.ts:43,50-64`

**Interfaces:**
- Consumes: Task 1 的 `isCustomSpec`／`specMs`／`specPeriodShape`／`parseSpec`
- Produces:
  - `type AnyInterval = string`，`function isBuiltinInterval(x: string): x is IntervalKey`
  - `function resolutionOf(interval: AnyInterval): string`
  - `function intervalMsOf(interval: AnyInterval): number`
  - `function normalizeInterval(text: unknown): AnyInterval`（坏串 → `"1D"`）
  - `intervalToPeriod(key: AnyInterval): Period`、`periodToInterval(period: Period): AnyInterval`、`isCalendarInterval(key: AnyInterval): boolean`、`fetchKline({ interval: AnyInterval … })`
  - `chartView.intervalAllowed(symbol: string, interval: AnyInterval): boolean`、`repairInterval(symbol, interval: AnyInterval): AnyInterval`

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
    for (const key of BUILTIN) expect(isCalendarInterval(key), key).toBe(key === "1D" || key === "1W" || key === "1M");
  });
  it("BTC 这类没有分钟源的标的：日倍数可答、分钟倍数不可答", () => {
    expect(intervalAllowed("BTCUSDT", "2D")).toBe(true);
    expect(intervalAllowed("BTCUSDT", "120m")).toBe(false);
    expect(intervalAllowed(".SH000300", "120m")).toBe(true);
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

在 `:18` 的 `IntervalKey` 之后追加，并保留 `RESOLUTION_BY_INTERVAL`／`INTERVAL_MS` 两张表**原样不动**（`:113` 那枚 exhaustive 钉靠它们活着）：

```ts
/** 目录里可能出现的所有周期拼写：八档内置 ∪ 合法自定义串。 */
export type AnyInterval = string;

const BUILTIN_KEYS = new Set<string>(["1m", "5m", "15m", "30m", "60m", "1D", "1W", "1M"]);

export function isBuiltinInterval(value: string): value is IntervalKey {
  return BUILTIN_KEYS.has(value);
}
```

四处改口（每处都要留一句「为什么不是查表」）：

1. `isCalendarInterval(key: AnyInterval)`：`CALENDAR_PERIODS.some(...)` 之后接 `|| parseSpecCustom(key)?.unit !== "m"` 形状的判定——**实现用** `customInterval` 的 `parseSpec`，`D`/`W`/`M` 归日历道，分钟道为 false；内置串走原表。
2. `intervalToPeriod(key: AnyInterval): Period`：先按旧逻辑判内置（`CALENDAR_PERIODS.find` ＋ `parseInt`），不落在内置时用 `specPeriodShape`；`specPeriodShape` 给 null（坏串）时退回 `{ type: "day", span: 1 }`，与本文件既有的「degrade to the one period every instrument can serve」同调。
3. `periodToInterval(period: Period): AnyInterval`：`minute` 道先查旧 `map`，`span > 60` 或不在表里 ⇒ `f"{span}m"`；calendar 三型把 `span` 带进串（`span === 1` 时仍产 `1D`/`1W`/`1M`，与 `marketApiPeriods.test.ts:43` 的往返钉一致）；`second`/`hour`/`year` 照旧 `"1D"`。
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

`chartView.ts:1` 的 import 换成 `isCalendarInterval, type AnyInterval`；`:34`／`:39` 两个函数的 `interval` 参数换成 `AnyInterval`，并在注释里补一句「自定义档按它的单位落车道：`m` 要分钟源，`D`/`W`/`M` 不需要——这条判据的来源是 `interval_spec` 的折叠基档，不是任何 disabled 标记」。**这一句就是 TV-CI-11 红线在码里的落点**，Task 6 有针指着它。

`indicatorLang.ts:1102` 之后（`:1105` 之前）插入守卫并把 `:1111` 的 `INTERVAL_MS[lowerIv]` 换成 `intervalMsOf(lowerIv)`：

```ts
  // 自定义周期时 MTF 不挑下层档：`pickLowerInterval` 只在内置八档之间选，
  // 拿「最近的内置细档」冒充会让脚本画的不是它请求的那条时间轴。走早已存在
  // 的降级路径——不传 lowerBars，builtin 退化成空数组。
  const chartIv = periodToInterval(period);
  if (!isBuiltinInterval(chartIv)) return;
```

- [ ] **Step 4：全绿＋提交**

```bash
cd frontend && npx vitest run src/lib/__tests__/marketApiCustom.test.ts src/lib/__tests__/marketApiPeriods.test.ts src/lib/__tests__/udfTransport.test.ts
# 期望：三套全绿，后两枚一枚针都没改
cd frontend && npx tsc -b && npx vitest run   # 全量：0 错、全绿
git add -- frontend/src/lib/marketApi.ts frontend/src/lib/chartView.ts frontend/src/lib/indicatorLang.ts frontend/src/lib/__tests__/marketApiCustom.test.ts
git status --porcelain && git commit -s -m "feat(l3-slice6): marketApi/chartView 类型加宽到 AnyInterval，消费者同笔改口"
```

若全量 vitest 里有页面测试（`ProChart`／`ChartCell`）因签名加宽而红，**不许**顺手改页面逻辑：那是类型位置的可赋值性变化，报错应是 TS 的而非断言的；断言红就停下报告，别改期望值迁就。

---

### Task 3：`CustomIntervalDialog.tsx`（对话框本体，TV-CI-09／10 的形状）

**Files:**
- Create: `frontend/src/components/charts/CustomIntervalDialog.tsx`
- Create: `frontend/src/components/charts/__tests__/CustomIntervalDialog.test.tsx`
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
  export function CustomIntervalDialog(props: CustomIntervalDialogProps): JSX.Element | null;
  ```

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
4. `periodOptions`：`INTERVALS.map(...)` 之后 `concat(customIntervals.map((key) => ({ key, label: specLabel(key) ?? key, disabled: !intervalAllowed(symbol, key), custom: true, title: `自定义档：${key} 由基档折叠而成（服务端负责折叠），点「移除」可以从目录里删掉这一档`, onRemove: () => removeCustomInterval(key) })))`。
5. `addCustomInterval(spec)`：去重后 append、`pickInterval(spec)`、关对话框。`removeCustomInterval(spec)`：从清单里摘掉；**若摘的正是当前周期**，`setView({ interval: "1D", timeShare: false }, true)`，否则只改清单不动当前周期（这就是「按删除不会先换档」那枚针的落点）。
6. `:810` 写会话时带上 `customIntervals`。
7. 分时互斥：分时按钮的 `disabled` 条件加 `|| !isBuiltinInterval(interval)`，`title` 在自定义档时逐字给 `分时只画当日 1 分钟线；当前档位 ${interval} 是折叠档，分时不能与折叠档同时（服务端会拒绝 session=latest）`（这句就是 Step 1 那枚针 `stringContaining("分时不能与折叠档同时")` 的落点，两处必须同串）；`pickTimeShare()` 里同条件早退。
8. 对话框渲染：`{customDialogOpen && <CustomIntervalDialog existing={[...INTERVALS.map(i => i.key), ...customIntervals]} onCancel={close} onAdd={addCustomInterval} />}`，与目录**同时**存在与否的裁定：打开对话框时把目录 `open` 关掉（目录那层浮层与对话框叠两层浮层没有凭据，也没有可用形状），但**目录组件本身不卸载**——C-3 那枚针在组件层钉的是这个。这条要在代码注释里写明是「自家裁定，对面的证据只到共存为止」。
9. MTF：Task 2 已在 `indicatorLang` 侧挡住；页面里 `:1283` `periodToInterval(period)` 的返回值已是 `AnyInterval`，透传给 `fetchKline` 即可。

- [ ] **Step 3：绿＋提交**

```bash
cd frontend && npx tsc -b
cd frontend && npx vitest run          # 全量。会话 schema 多一个键会打破整对象比对：`ProChartMinuteBars.test.tsx` 从 `../ProChart` 直接 import `readSession`（:37），三处整对象 `toEqual` 在 :156／:197／:202，随本片连带改口。`MultiChart.test.tsx` 的 `readSession` 是 `../MultiChart` 自己的函数，不受影响，别去改它
git add -- frontend/src/pages/ProChart.tsx frontend/src/pages/__tests__/ProChartCustomInterval.test.tsx frontend/src/pages/__tests__/ProChartMinuteBars.test.tsx
git status --porcelain && git commit -s -m "feat(l3-slice6): ProChart 接线——自定义档进目录、会话持久化、分时互斥"
```

---

### Task 6：红线针（E 组）＋变异自证十一枚＋六道门

**Files:**
- Modify: `frontend/src/components/charts/__tests__/PeriodPicker.test.tsx`（E 组两枚）
- Create: `frontend/src/pages/__tests__/ProChartCustomIntervalRedline.test.tsx`（E 组页面半枚就住这里，与 Task 5 的 `ProChartCustomInterval.test.tsx` 分开：前者钉「disabled 只由 `intervalAllowed` 决定」这类形状，后者钉功能闭环）
- 无生产码改动（除非变异自证揪出真缺陷——那就改，并在报告里单列）

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
