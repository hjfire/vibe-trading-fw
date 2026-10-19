# Heikin-Ashi（平均K线）显示层 实现计划（推荐清单第 ④ 片）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `/pro-chart` 主图上加一个「平均K线」开关：开＝主图按 Heikin-Ashi 重画蜡烛（只改像素），关＝原样；真实四价、图例、磁吸、画线锚点、Pine 求值全部继续读真实价。

**Architecture:** 三个文件、三条通道。`lib/heikinAshi.ts` 是纯数学（`heikinAshi(bars) -> HaRow[]`，不 import 任何库）。`lib/heikinAshiChart.ts` 是库绑定层：把数学注册成挂在 `candle_pane` 上的自定义指标，用指标模板的 `draw` 自己画实体＋影线并**返回 `true`**（klinecharts 见到 `true` 就整段跳过默认图元），用 `figures: [{key:"high"},{key:"low"}]` 让库把 HA 高低折进 y 轴范围（`YAxisImp.createRangeImp`，缺口不裁切），用 `createTooltipDataSource` 输出 HA 四价那一行图例，再导出把 `candle.bar` 九个色键推成 `transparent` 的常量。`pages/ProChart.tsx` 只做三件事：把 `ha` 作为**第四个必填形参**接进唯一样式合成点 `chartStyles` 并进主题 effect 依赖数组、用一个 effect 挂/卸指标、放一个工具栏按钮。

**Tech Stack:** React 19 + TypeScript（`strict: true`）+ Vite + Vitest（jsdom）+ Tailwind；图表库 klinecharts **10.0.3，未打补丁**（本计划不允许修改 `node_modules`）。

**Spec:** `superpowers/specs/2026-10-08-heikin-ashi-design.md` — 本计划是从它出发的论证，冲突时以 spec 为准。spec 的 §二 是逐条从 bundle 读出来的库事实（带坐标），§五 是真值边界表，§七 是验收判据。

**基线：** 分支 `feat/heikin-ashi`，起点 `main` = `f32ece61`，spec 提交 = `f6443a89`。开工前 `npx tsc --noEmit -p tsconfig.json` 必须 rc=0。

## Global Constraints

每一条都约束所有 Task，值逐字取自 spec 与本仓既有纪律：

- **不 patch 库、不加依赖、不新增环境变量、不新增 locale 键**（面向用户的文案硬编码中文，与本仓 `均价: ` / `磁吸` 同做法）。
- **不改 `candle.type` 的归属**：`type` 那个键属于分时开关（`ProChart.tsx:285`）；HA 隐藏原生蜡烛只动 `candle.bar` 的九个颜色键，`candle.type` 保持 `candle_solid`。
- **不写 `candle.priceMark`**：那棵子树归图例偏好面板所有（`lib/chartLegend.ts:109-115`），HA 侧写它会静默覆盖用户的「高低价标记」开关。开着 HA 时高低点标记继续标**真实**高低。
- **像素量绝不能进 `calc` 的返回值**：`YAxisImp.createRangeImp`（`dist/index.esm.js:1045-1056`）把每个 `figures[].key` 的数值当价格折进 y 轴 min/max；result 里只允许 `{open,high,low,close}` 四个价格语义的键，几何一律在 `draw` 里现算。
- **样式只有一个合成点**：任何新样式偏好必须同时进 `chartStyles` 的形参表和主题 effect（`ProChart.tsx:1272-1274`）的依赖数组；漏进依赖数组的后果是文件里已写死的历史故障（切主题冲掉偏好，「开关像坏了」）。
- **`figures[].type` 实践必填**（`prepareIndicatorFigures`，`dist:3081-3125` 只认 `line|bar|circle|text`）；本仓在 `timeShare.ts:309-312` 已把它写成注释纪律。
- **颜色只从 `lib/chartPalette.ts` 的 `CANDLE_COLORS` 取**（红涨 `#ef5350`、绿跌 `#26a69a`、平 `#888888`，A 股惯例），不许在 HA 侧另定义一套。
- **禁用未来函数**：HA 只用当根四价与上一根的 HA 值；交付必须附 §八 的 Bar Replay 五步自查（Task 6）。
- **时间戳一律毫秒**（本片不新增时间逻辑，但若测试造 bar，`timestamp` 用毫秒）。
- **默认态逐像素不变**：偏好默认关；`saveHeikinAshi(false)` 删键而不是写 `"0"`（照 `chartLegend.ts:81-93` 的「未偏离默认不落盘」纪律）。
- **提交一律 `git commit -s`（DCO）并显式带 pathspec**；**永不** `git add -A` / `git add .`。本仓脏树是常态（别人的面可能已 staged），`git commit` 不带 pathspec 会吞掉它们。
- **`docs/` 被 `.gitignore:125` 忽略** ⇒ 计划与 spec 的提交要 `git add -f`。
- **不改上游拥有的文件**（`.gitignore`、`tools/ci_grep_gates.sh`、`.github/workflows/test.yml`、`wiki/**`）。
- **不为让门禁变绿去调阈值或改档案**；两条本地恒红门（`tools/wiki_freshness_gate.sh`、`tools/ci_grep_gates.sh`）交付时先证本片 0 贡献再报告。
- **实现席不得再派子代理**（不派 helper，不派 reviewer；评审由控制方下发）。
- **`/multi-chart` 不在本片范围**：格子有独立样式链（`components/charts/ChartCell.tsx:58-97`，`:65` 硬编码 `candle_solid`），不许顺手改。

## 文件结构

| 文件 | 动作 | 职责 |
|---|---|---|
| `frontend/src/lib/heikinAshi.ts` | 新建 | 纯数学：`heikinAshi(bars: readonly unknown[]): HaRow[]`，na 行输出 `{}` 并断开链；无 klinecharts 依赖 |
| `frontend/src/lib/__tests__/heikinAshi.test.ts` | 新建 | 数学单测：四组手算向量、na/空/单根、缺口向量、40 根前缀不变量 harness（带 `probes` 断言） |
| `frontend/src/lib/heikinAshiChart.ts` | 新建 | 库绑定：`HEIKIN_ASHI_NAME`／`HEIKIN_ASHI_SHORT_NAME`、`ensureHeikinAshiIndicator()` 注册守卫、`calc`／`draw`／`createTooltipDataSource`、`CANDLE_HIDDEN` 九色、`heikinAshiActive(haOn, timeShare)` 单一谓词、`load/saveHeikinAshi` |
| `frontend/src/lib/__tests__/heikinAshiChart.test.ts` | 新建 | 模板单测：`vi.mock("klinecharts")` 捕获注册对象＋假 ctx 录制 `fillRect`＋假 chart 提供可视区 |
| `frontend/src/pages/ProChart.tsx` | 修改 | `chartStyles` 第四形参、主题 effect 依赖、`init` 点、`syncHeikinAshi`、挂卸 effect、`toggleHeikinAshi`、工具栏按钮 |
| `frontend/src/pages/__tests__/ProChartHeikinAshi.test.tsx` | 新建 | 页面接线：样式推送、九色×切主题、指标挂卸×分时互斥、真值边界钉 |
| `repowiki/项目档案.md` | 修改 | §7.18 落档（Task 7） |

Task 顺序是依赖顺序：T1 数学 → T2 库绑定 → T3 样式链 → T4 挂卸＋按钮 → T5 真值钉＋全量门禁 → T6 活体验收＋未来函数自查 → T7 落档＋记忆＋整支评审。

---

## Task 1: `lib/heikinAshi.ts` 纯数学＋手算向量＋前缀不变量

**Files:**
- Create: `frontend/src/lib/heikinAshi.ts`
- Test: `frontend/src/lib/__tests__/heikinAshi.test.ts`

**spec §七·3（回放一致性）在这一层落**：页面 harness 的图表替身把 `registerIndicator` 桩掉了，库的 `calc` 在页面测试里根本不会跑，所以「回放游标推进后 HA 输出必等于全量同长前缀」这句话的可执行形式就是本 Task 的前缀不变量 harness（对同样的 bar 数组、逐 `n=1..40` 判）＋既有 `pages/__tests__/ProChartReplay.test.tsx` 已经钉住的「回放喂进去的是前缀」。两条合起来覆盖，Task 6 Step 6 再给一遍活体证据；本计划**不**为它另造一个页面测试（那需要一个会跑 calc 的替身，等于重写半个库）。

**Interfaces:**
- Consumes: 无（不 import klinecharts，不 import 仓内任何模块）
- Produces:
  - `export interface HaRow { open?: number; high?: number; low?: number; close?: number }`
  - `export function heikinAshi(bars: readonly unknown[]): HaRow[]`
  - `export const HA_PRICE_KEYS: readonly string[]`（= `["open","high","low","close"]`，T2 的白名单测试要用它，别在两个文件里各写一遍字面量）

- [ ] **Step 1: 写失败的测试**

创建 `frontend/src/lib/__tests__/heikinAshi.test.ts`，全文如下：

```ts
import { describe, expect, it } from "vitest";

import { HA_PRICE_KEYS, heikinAshi } from "../heikinAshi";

/**
 * Heikin-Ashi 的算术（推荐清单第④片，spec §二·4/§六/§七·1）。
 *
 * 手算向量是这条公式唯一的可复核形态：每一个期望值都能用四则运算在纸上重算，
 * 所以实现写错方向（比如把 `haOpen` 接成当根的 `(O+C)/2`）不会靠「换一组数也自洽」
 * 混过去。缺口向量 `[(10,20,10,20),(1,2,1,2)]` 是 spec §二·4 的样本，它的存在理由
 * 是库的 y 轴折叠——第二根真实 high 只有 2，而 `haHigh` 是 15。
 */

function bar(open: number, high: number, low: number, close: number) {
  return { timestamp: 0, open, high, low, close, volume: 1 };
}

describe("heikinAshi", () => {
  it("空表返回空表", () => {
    expect(heikinAshi([])).toEqual([]);
  });

  it("单根：haOpen 用 (O+C)/2 播种，高低由当根极值决定", () => {
    expect(heikinAshi([bar(10, 12, 9, 11)])).toEqual([
      { open: 10.5, high: 12, low: 9, close: 10.5 },
    ]);
  });

  it("三根连续：haOpen 接上一根的 (haOpen+haClose)/2", () => {
    expect(
      heikinAshi([bar(10, 12, 9, 11), bar(11, 13, 10, 12), bar(12, 14, 11, 13)]),
    ).toEqual([
      { open: 10.5, high: 12, low: 9, close: 10.5 },
      { open: 10.5, high: 13, low: 10, close: 11.5 },
      { open: 11.0, high: 14, low: 11, close: 12.5 },
    ]);
  });

  it("缺口向量：第二根 haHigh=15 而真实 high=2 —— y 轴折叠存在的理由", () => {
    const rows = heikinAshi([bar(10, 20, 10, 20), bar(1, 2, 1, 2)]);
    expect(rows).toEqual([
      { open: 15, high: 20, low: 10, close: 15 },
      { open: 15, high: 15, low: 1, close: 1.5 },
    ]);
    // 断言的是「变换值越出真实区间」这件事本身：Task 2 的轴折叠白名单钉就是为它服务的。
    expect(rows[1].high).toBe(15);
    expect(rows[1].high!).toBeGreaterThan(2);
  });

  it("非有限价输出无键空行并断开链，下一根重新播种", () => {
    const rows = heikinAshi([bar(10, 12, 9, 11), { open: 5, high: 6, low: 4, close: NaN }, bar(1, 2, 0.5, 1.5)]);
    expect(Object.keys(rows[1])).toEqual([]);
    // 第三根不继承 na 行：照首根播种 (O+C)/2 = 1.25。
    expect(rows[2]).toEqual({ open: 1.25, high: 2, low: 0.5, close: 1.25 });
  });

  it("null/undefined/非对象样本各出一行无键，长度永远等于输入长度", () => {
    const rows = heikinAshi([null, undefined, 42, "x", {}, bar(1, 2, 0.5, 1.5)]);
    expect(rows).toHaveLength(6);
    expect(rows.slice(0, 5).every((r) => Object.keys(r).length === 0)).toBe(true);
    expect(rows[5]).toEqual({ open: 1.25, high: 2, low: 0.5, close: 1.25 });
  });

  it("结果里只有四个价格键——像素量混进来就直接失败", () => {
    const allowed = new Set(HA_PRICE_KEYS);
    for (const row of heikinAshi(PREFIX_BARS)) {
      for (const key of Object.keys(row)) expect(allowed.has(key)).toBe(true);
    }
  });
});

/**
 * 前缀不变量（spec §七·1，形状照 `lib/__tests__/pinePrefixInvariance.test.ts`）：
 * `heikinAshi(bars.slice(0, n))` 必等于 `heikinAshi(bars).slice(0, n)`。
 *
 * 这条是「没有未来函数」的可复算证据，也是 Bar Replay 的前提——回放喂进图的永远是
 * 前缀（`lib/barReplay.ts`），前缀与全量逐根相同才说明游标在第 k 根看到的那根实体
 * 不会因为后面来了新 bar 而变形。`probes` 是探针计数：0 个探针的循环会真空通过，
 * 所以它本身必须被断言。
 */

const DAY = 86_400_000;
const TOTAL = 40;
const START = Date.parse("2026-01-05T00:00:00+08:00");

/** 确定性 LCG：不许用 `Math.random()`，否则「红的那次」无法复算。 */
function makeBars(count: number) {
  let seed = 20261008;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  return Array.from({ length: count }, (_, i) => {
    const a = 100 + 20 * rnd();
    const b = 100 + 20 * rnd();
    const open = a;
    const close = b;
    const span = 1 + 5 * rnd();
    return {
      timestamp: START + i * DAY,
      open,
      high: Math.max(open, close) + span,
      low: Math.min(open, close) - span,
      close,
      volume: 1,
    };
  });
}

const PREFIX_BARS = makeBars(TOTAL);

describe("heikinAshi 前缀不变量（无未来函数）", () => {
  const full = heikinAshi(PREFIX_BARS);
  let worst = 0;
  let probes = 0;
  let firstMismatch: string | null = null;

  for (let n = 1; n <= TOTAL; n++) {
    const prefix = heikinAshi(PREFIX_BARS.slice(0, n));
    probes += 1;
    if (prefix.length !== n) {
      firstMismatch ??= `n=${n} 长度 ${prefix.length} ≠ ${n}`;
      continue;
    }
    const expected = full.slice(0, n);
    let diff = 0;
    for (let i = 0; i < n; i++) {
      if (JSON.stringify(prefix[i]) !== JSON.stringify(expected[i])) diff += 1;
    }
    worst = Math.max(worst, diff);
    if (diff > 0 && firstMismatch === null) {
      firstMismatch = `n=${n} 第 ${diff} 根起不同：prefix=${JSON.stringify(prefix[n - 1])} full=${JSON.stringify(expected[n - 1])}`;
    }
  }

  it(`全部 ${TOTAL} 个前缀都比对到了（探针数本身要被断言，不许空集合真空通过）`, () => {
    expect(probes).toBe(TOTAL);
  });

  it("每个前缀的输出都等于全量输出的同长前缀", () => {
    expect(firstMismatch).toBeNull();
    expect(worst).toBe(0);
  });
});
```

- [ ] **Step 2: 跑测试，确认它失败**

```
cd frontend && npx vitest run src/lib/__tests__/heikinAshi.test.ts 2>&1 | cat
```

期望：FAIL，报错形如 `Failed to resolve import "../heikinAshi"`（模块还不存在）。**必须真看到红**再进 Step 3；没看到红就实现，等于这一轮没有证据。

- [ ] **Step 3: 写最小实现**

创建 `frontend/src/lib/heikinAshi.ts`，全文如下：

```ts
/**
 * Heikin-Ashi 的算术（推荐清单第④片）。
 *
 * `haClose = (O+H+L+C)/4`；`haOpen` 首根播种 `(O+C)/2`，其后 `= (上一根 haOpen + 上一根 haClose)/2`；
 * `haHigh = max(H, haOpen, haClose)`；`haLow = min(L, haOpen, haClose)`。涨色判据用 HA 自己的
 * `haClose` 对 `haOpen`，不是真实收叠——这条在 `heikinAshiChart.ts` 的 `draw` 里读。
 *
 * 只有当根四价与上一根的 HA 值参与，所以它是因果的：前缀输出等于全量输出的同长前缀
 * （`__tests__/heikinAshi.test.ts` 逐 `n` 钉住）。Bar Replay 喂进来的永远是前缀，靠的就是这条。
 *
 * 这个文件一个字都不 import klinecharts：数学能被单测直接喂数组，而库绑定层（同目录
 * `heikinAshiChart.ts`）要 mock 掉 `registerIndicator` 才测得动。两件事分开，才有地方能
 * 在浏览器外判对错。
 */

export interface HaRow {
  open?: number;
  high?: number;
  low?: number;
  close?: number;
}

/**
 * The only keys a row may carry. Exported because `heikinAshiChart.ts`'s test asserts the
 * same whitelist against the value handed to the library: `YAxisImp.createRangeImp` folds
 * every `figures[].key` of every indicator on the pane into the y-axis min/max as a *price*,
 * so a pixel number in here would repaint the price scale. Geometry belongs in `draw`.
 */
export const HA_PRICE_KEYS = ["open", "high", "low", "close"] as const;

function price(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function heikinAshi(bars: readonly unknown[]): HaRow[] {
  const out: HaRow[] = [];
  let prev: { open: number; close: number } | null = null;
  for (const raw of bars) {
    const b = (raw ?? {}) as Record<string, unknown>;
    const [o, h, l, c] = [b.open, b.high, b.low, b.close];
    if (!price(o) || !price(h) || !price(l) || !price(c)) {
      // na：无键行，不是空数组——`timeShare.ts` 的 `prevCloseSeries` 已经证明库吃得下这个形状，
      // 而库的轴折叠只认 `isNumber(value)`，无键行自然跳过。链也在这里断开：下一根重新播种，
      // 不拿一个不存在的 HA 值去平均。
      prev = null;
      out.push({});
      continue;
    }
    const close = (o + h + l + c) / 4;
    const open = prev === null ? (o + c) / 2 : (prev.open + prev.close) / 2;
    out.push({
      open,
      high: Math.max(h, open, close),
      low: Math.min(l, open, close),
      close,
    });
    prev = { open, close };
  }
  return out;
}
```

- [ ] **Step 4: 跑测试，确认全绿**

```
cd frontend && npx vitest run src/lib/__tests__/heikinAshi.test.ts 2>&1 | cat
```

期望：PASS，`Test Files 1 passed`、本文件 9 个 `it` 全过。若「三根连续」那条红，先手算 `(10.5+10.5)/2`，不要调期望值去迁就实现。

- [ ] **Step 5: 类型门**

```
cd frontend && npx tsc --noEmit -p tsconfig.json; echo "rc=$?"
```

期望：`rc=0`。

- [ ] **Step 6: 提交**

```
git add -- frontend/src/lib/heikinAshi.ts frontend/src/lib/__tests__/heikinAshi.test.ts
git commit -s -m "$(cat <<'EOF'
feat(heikinAshi): 第④片第一步——纯数学与因果性证据

heikinAshi() 只用当根四价与上一根的 HA 值，前缀不变量逐 n=1..40 钉住，
这是 Bar Replay 喂前缀时那根实体不变形的理由。na 行输出无键对象并断开链，
照 timeShare.ts prevCloseSeries 的先例；四个价格键的白名单是导出的，
下一步的库绑定测试要用同一个集合去挡「像素混进 result」。
EOF
)" -- frontend/src/lib/heikinAshi.ts frontend/src/lib/__tests__/heikinAshi.test.ts
git status --porcelain | head
```

期望：一笔新提交，`git status` 里**别人的面还在原处**（本片只该少这两条路径）。

---

## Task 2: `lib/heikinAshiChart.ts` 库绑定（注册守卫／draw／图例／九色／偏好）

**Files:**
- Create: `frontend/src/lib/heikinAshiChart.ts`
- Test: `frontend/src/lib/__tests__/heikinAshiChart.test.ts`

**Interfaces:**
- Consumes: `heikinAshi(bars)`、`HaRow`、`HA_PRICE_KEYS`（Task 1）；`CANDLE_COLORS`（`lib/chartPalette.ts:10-14`）
- Produces（`ProChart.tsx` 与测试都按这些名字用）：
  - `export const HEIKIN_ASHI_NAME = "HEIKIN_ASHI"`
  - `export const HEIKIN_ASHI_SHORT_NAME = "平均K线"`
  - `export const HEIKIN_ASHI_PREFS_KEY = "pro-chart.heikin-ashi.v1"`
  - `export const CANDLE_HIDDEN: Readonly<Record<string, string>>`（恰好九个键，值全为 `"transparent"`）
  - `export function heikinAshiActive(haOn: boolean, timeShare: boolean): boolean`
  - `export function loadHeikinAshi(): boolean` / `export function saveHeikinAshi(on: boolean): void`
  - `export function ensureHeikinAshiIndicator(): void`
  - `export function isHaRow(row: HaRow | undefined): row is Required<HaRow>`、`export function haDraw(params): boolean`、`export function haTooltipDataSource(params)` — 这三个是注册对象的三条回调，单独导出是为了让单测能直接喂假 ctx／假 chart 而不必先扒注册表（扒也要做，见 Step 1 的 `spec()`）
  - `export { HA_PRICE_KEYS as HA_PRICE_KEYS_FOR_TEST } from "./heikinAshi"`（白名单只写一遍）

- [ ] **Step 1: 写失败的测试**

创建 `frontend/src/lib/__tests__/heikinAshiChart.test.ts`，全文如下：

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

// 库的 `registerIndicator` 改的是全局表；桩掉它，既不让真库起来，又能把注册对象抓下来逐键判。
// 形状照 `lib/__tests__/timeShare.test.ts:5-8`。
const registered: Array<Record<string, unknown>> = [];
vi.mock("klinecharts", () => ({
  registerIndicator: (spec: Record<string, unknown>) => registered.push(spec),
}));

import { CANDLE_COLORS } from "../chartPalette";
import {
  CANDLE_HIDDEN,
  HA_PRICE_KEYS_FOR_TEST,
  HEIKIN_ASHI_NAME,
  HEIKIN_ASHI_PREFS_KEY,
  HEIKIN_ASHI_SHORT_NAME,
  ensureHeikinAshiIndicator,
  heikinAshiActive,
  loadHeikinAshi,
  saveHeikinAshi,
} from "../heikinAshiChart";
import { heikinAshi } from "../heikinAshi";

/**
 * 库绑定层（推荐清单第④片，spec §二/§七·2）。这里断言的五件事每一条都能让方案「做完了但静默不对」：
 *
 * - `series:"price"` 与 `figures` 只有 `high`/`low`：轴折叠面就是 `figures[].key` 的集合
 *   （`YAxisImp.createRangeImp`，dist 1045-1056）。两键已是完整包络（`haHigh ≥ {haOpen,haClose}`、
 *   `haLow ≤ {haOpen,haClose}`），多声明开/收只多两行图例，不多护一寸轴。
 * - 每个 figure 都有 `type`：缺 `type` 的图元被 `prepareIndicatorFigures` 丢掉（dist 3081-3125）。
 * - result 只含四个价格键：像素量混进来会被当价格折进 y 轴。
 * - `draw` 返回 `true`：返回 false 会让库把默认图元再画一遍。
 * - `createTooltipDataSource` 出四价一行、行名写「平均K线」：变换值绝不进蜡烛图例（spec §五）。
 */

function bar(open: number, high: number, low: number, close: number, i = 0) {
  return { timestamp: 1_700_000_000_000 + i * 86_400_000, open, high, low, close, volume: 1 };
}

/** spec §二·4 的缺口向量：第二根真实 high 只有 2，haHigh 却是 15。 */
const GAP_BARS = [bar(10, 20, 10, 20, 0), bar(1, 2, 1, 2, 1)];

function spec(): Record<string, unknown> {
  ensureHeikinAshiIndicator();
  expect(registered).toHaveLength(1);
  return registered[0];
}

type FakeRect = { x: number; y: number; w: number; h: number; color: string };

/** 假 ctx／假 chart：`draw` 拿到的是裸 CanvasRenderingContext2D 和 chart 组件，全部自己造。 */
function drawFixture(rows: Array<Record<string, unknown>>, visible = { realFrom: 0, realTo: rows.length }) {
  const rects: FakeRect[] = [];
  const ctx = {
    fillStyle: "",
    fillRect(x: number, y: number, w: number, h: number) {
      rects.push({ x, y, w, h, color: ctx.fillStyle });
    },
  } as unknown as CanvasRenderingContext2D & { fillStyle: string };
  // x: 每根 8px，从 20 起。y: 价格越高像素越小（100 - price），把「像素是现算的」变成交付判据。
  const chart = {
    getVisibleRange: () => ({ from: visible.realFrom, to: visible.realTo, realFrom: visible.realFrom, realTo: visible.realTo }),
    getBarSpace: () => ({ bar: 8, halfBar: 4, gapBar: 5, halfGapBar: 2 }),
    getDataList: () => rows,
  };
  const indicator = { result: rows };
  const out = (
    spec().draw as (p: unknown) => boolean
  )({ ctx, chart, indicator, xAxis: { convertToPixel: (i: number) => 20 + i * 8 }, yAxis: { convertToPixel: (p: number) => 100 - p } });
  return { rects, out };
}

beforeEach(() => {
  localStorage.clear();
});

describe("注册守卫", () => {
  it("重复调用只注册一次", () => {
    ensureHeikinAshiIndicator();
    const after = registered.length;
    ensureHeikinAshiIndicator();
    ensureHeikinAshiIndicator();
    expect(registered).toHaveLength(after);
    expect(after).toBe(1);
  });
});

describe("注册对象形状", () => {
  it("名字、短名、series、precision 都对", () => {
    const s = spec();
    expect(s.name).toBe(HEIKIN_ASHI_NAME);
    expect(s.shortName).toBe(HEIKIN_ASHI_SHORT_NAME);
    expect(s.series).toBe("price");
    expect(s.precision).toBe(2);
  });

  it("figures 恰为 high/low 两键，且每个都带 type", () => {
    const figures = spec().figures as Array<{ key: string; type?: string; title?: string }>;
    expect(figures.map((f) => f.key)).toEqual(["high", "low"]);
    for (const f of figures) {
      expect(typeof f.type).toBe("string");
      expect(f.type).toBe("line");
      expect(typeof f.title).toBe("string");
    }
  });

  it("两键包络成立：HA 高低把开收夹在中间，所以开收不需要当 figure 声明", () => {
    for (const row of heikinAshi(GAP_BARS)) {
      if (row.open === undefined || row.high === undefined) continue;
      expect(row.high).toBeGreaterThanOrEqual(row.open);
      expect(row.high).toBeGreaterThanOrEqual(row.close!);
      expect(row.low).toBeLessThanOrEqual(row.open);
      expect(row.low).toBeLessThanOrEqual(row.close!);
    }
  });
});

describe("calc", () => {
  it("result 只允许四个价格键（像素混入即失败）", () => {
    const allowed = new Set([...HA_PRICE_KEYS_FOR_TEST]);
    const rows = (spec().calc as (d: unknown[]) => Array<Record<string, unknown>>)(
      Array.from({ length: 12 }, (_, i) => bar(100 + i, 105 + i, 95 + i, 102 + i, i)),
    );
    expect(rows).toHaveLength(12);
    for (const row of rows) for (const key of Object.keys(row)) expect(allowed.has(key)).toBe(true);
  });

  it("缺口向量：第二根 result 的 high 是 15，而该根真实 high 是 2", () => {
    const rows = (spec().calc as (d: unknown[]) => Array<Record<string, number | undefined>>)(GAP_BARS);
    expect(rows[1].high).toBe(15);
    expect(GAP_BARS[1].high).toBe(2);
    expect(rows[1].low).toBe(1);
    expect(rows[1].open).toBe(15);
    expect(rows[1].close).toBe(1.5);
  });

  it("calc 就是委托给纯数学，不是另算一遍", () => {
    const bars = Array.from({ length: 8 }, (_, i) => bar(10 + i, 20 + i, 5 + i, 15 + i, i));
    const rows = (spec().calc as (d: unknown[]) => unknown[])(bars);
    expect(rows).toEqual(heikinAshi(bars));
  });
});

describe("draw", () => {
  const rows = heikinAshi([bar(10, 12, 9, 11, 0), bar(11, 13, 10, 12, 1), bar(12, 14, 11, 13, 2)]);

  it("返回 true —— 这是「整体接管绘制」的判据，false 会让默认图元再画一遍", () => {
    expect(drawFixture(rows).out).toBe(true);
  });

  it("每根画一个影线＋一个实体，几何从 yAxis 现算", () => {
    // 第 0 行 = {open:10.5, high:12, low:9, close:10.5}（平盘判据：close === open ⇒ 无变色）
    // 第 1 行 = {open:10.5, high:13, low:10, close:11.5}（涨：close > open ⇒ up 色）
    const { rects } = drawFixture(rows.slice(0, 2), { realFrom: 0, realTo: 2 });
    expect(rects).toHaveLength(4);
    // 影线：x = 20，宽 1，y = min(priceY) = y(high) = 100-12 = 88，高 = y(low)-y(high) = (100-9)-88 = 3
    expect(rects[0]).toEqual({ x: 20, y: 88, w: 1, h: 3, color: CANDLE_COLORS.noChange });
    // 实体：priceY 升序 = [88, 89.5, 89.5, 91] ⇒ y = priceY[1] = 89.5，
    // 高 = Math.max(1, priceY[2]-priceY[1]) = max(1, 0) = 1（平盘那根只有一像素，库同此形），
    // x = 20 - halfGapBar = 18，宽 = gapBar + correction（gapBar 5 是奇数 ⇒ correction 0）
    expect(rects[1]).toEqual({ x: 18, y: 89.5, w: 5, h: 1, color: CANDLE_COLORS.noChange });
    // 第 1 行 priceY 升序 = [87, 88.5, 89.5, 90] ⇒ 影线 y=87 高 3，实体 y=88.5 高 1，x 前进一根 8px
    expect(rects[2]).toEqual({ x: 28, y: 87, w: 1, h: 3, color: CANDLE_COLORS.up });
    expect(rects[3]).toEqual({ x: 26, y: 88.5, w: 5, h: 1, color: CANDLE_COLORS.up });
  });

  it("偶数 gapBar 才加那 1px correction（库的判据是 % 2 === 0，与直觉相反）", () => {
    const even = {
      rects: [] as FakeRect[],
      ctx: {
        fillStyle: "",
        fillRect(x: number, y: number, w: number, h: number) {
          even.rects.push({ x, y, w, h, color: even.ctx.fillStyle });
        },
      } as unknown as CanvasRenderingContext2D & { fillStyle: string },
    };
    const s = spec();
    (s.draw as (p: unknown) => boolean)({
      ctx: even.ctx,
      chart: {
        getVisibleRange: () => ({ from: 0, to: 1, realFrom: 0, realTo: 1 }),
        getBarSpace: () => ({ bar: 8, halfBar: 4, gapBar: 6, halfGapBar: 3 }),
        getDataList: () => [rows[0]],
      },
      indicator: { result: rows },
      xAxis: { convertToPixel: (i: number) => 20 + i * 8 },
      yAxis: { convertToPixel: (p: number) => 100 - p },
    });
    expect(even.rects[1].w).toBe(7); // gapBar 6 偶数 ⇒ 6 + 1
    expect(even.rects[1].x).toBe(17); // 20 - halfGapBar 3
  });

  it("跌色按 HA 自己的 close/open，不看真实收叠", () => {
    // 第二根真实四价 (9,10,8,9)：haClose = 36/4 = 9 < haOpen = (10.5+10.5)/2 = 10.5 ⇒ 跌。
    // 注意真实 close 9 与上一根真实 close 11 比也是跌，但判据取的是 HA 开收这一对。
    const down = heikinAshi([bar(10, 12, 9, 11, 0), bar(9, 10, 8, 9, 1)])[1];
    expect(down.open).toBe(10.5);
    expect(down.close).toBe(9);
    const { rects } = drawFixture([down], { realFrom: 0, realTo: 1 });
    expect(rects).toHaveLength(2);
    expect(rects[0].color).toBe(CANDLE_COLORS.down);
    expect(rects[1].color).toBe(CANDLE_COLORS.down);
  });

  it("只画可视区，且 na 行一根都不画", () => {
    const partial = drawFixture(rows, { realFrom: 1, realTo: 2 });
    expect(partial.rects).toHaveLength(2);
    expect(partial.rects[0].x).toBe(28); // dataIndex 1 ⇒ 20 + 1*8
    const naOnly = drawFixture([{}, {}, {}], { realFrom: 0, realTo: 3 });
    expect(naOnly.rects).toHaveLength(0);
    expect(naOnly.out).toBe(true);
  });

  it("可视区右界超过 result 长度时不越界", () => {
    const { rects, out } = drawFixture(rows, { realFrom: 0, realTo: 99 });
    expect(out).toBe(true);
    expect(rects).toHaveLength(6);
  });
});

describe("createTooltipDataSource", () => {
  function legends(index: number | undefined, rows = heikinAshi(GAP_BARS)) {
    const s = spec();
    return (
      s.createTooltipDataSource as (p: unknown) => {
        name: string;
        calcParamsText: string;
        features: unknown[];
        legends: Array<{ title: string; value: string }>;
      }
    )({
      chart: { getDataList: () => rows },
      indicator: { result: rows },
      crosshair: index === undefined ? {} : { dataIndex: index },
    });
  }

  it("行名写「平均K线」，四价四格，值保留两位", () => {
    const data = legends(1);
    expect(data.name).toBe(HEIKIN_ASHI_SHORT_NAME);
    expect(data.calcParamsText).toBe("");
    expect(data.features).toEqual([]);
    expect(data.legends.map((l) => l.title)).toEqual(["开: ", "高: ", "低: ", "收: "]);
    expect(data.legends.map((l) => l.value)).toEqual(["15.00", "15.00", "1.00", "1.50"]);
  });

  it("没有十字光标时读最后一根；越界或 na 读「-」而不是编一个数", () => {
    expect(legends(undefined).legends.map((l) => l.value)).toEqual(["15.00", "15.00", "1.00", "1.50"]);
    const na = legends(0, [{ open: 1, high: 2, low: 0.5 }]);
    expect(na.legends.map((l) => l.value)).toEqual(["1.00", "2.00", "0.50", "-"]);
    expect(legends(99).legends.map((l) => l.value)).toEqual(["-", "-", "-", "-"]);
  });
});

describe("九色与谓词与偏好", () => {
  it("CANDLE_HIDDEN 恰好九个键，全是 transparent，不含 compareRule/type", () => {
    expect(Object.keys(CANDLE_HIDDEN)).toHaveLength(9);
    for (const v of Object.values(CANDLE_HIDDEN)) expect(v).toBe("transparent");
    expect(CANDLE_HIDDEN).not.toHaveProperty("type");
    expect(CANDLE_HIDDEN).not.toHaveProperty("compareRule");
    expect(Object.keys(CANDLE_HIDDEN).sort()).toEqual(
      [
        "downBorderColor",
        "downColor",
        "downWickColor",
        "noChangeBorderColor",
        "noChangeColor",
        "noChangeWickColor",
        "upBorderColor",
        "upColor",
        "upWickColor",
      ].sort(),
    );
  });

  it("heikinAshiActive：分时压掉 HA，其余三种组合按开关", () => {
    expect(heikinAshiActive(false, false)).toBe(false);
    expect(heikinAshiActive(true, false)).toBe(true);
    expect(heikinAshiActive(false, true)).toBe(false);
    expect(heikinAshiActive(true, true)).toBe(false);
  });

  it("默认关；开＝落 \"1\"；再关＝删键（未偏离默认不落盘）", () => {
    expect(loadHeikinAshi()).toBe(false);
    saveHeikinAshi(true);
    expect(localStorage.getItem(HEIKIN_ASHI_PREFS_KEY)).toBe("1");
    expect(loadHeikinAshi()).toBe(true);
    saveHeikinAshi(false);
    expect(localStorage.getItem(HEIKIN_ASHI_PREFS_KEY)).toBeNull();
    // 手改的垃圾值读回默认，不抛。
    localStorage.setItem(HEIKIN_ASHI_PREFS_KEY, "yes");
    expect(loadHeikinAshi()).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试，确认它失败**

```
cd frontend && npx vitest run src/lib/__tests__/heikinAshiChart.test.ts 2>&1 | cat
```

期望：FAIL，`Failed to resolve import "../heikinAshiChart"`。

- [ ] **Step 3: 写实现**

创建 `frontend/src/lib/heikinAshiChart.ts`，全文如下：

```ts
import { registerIndicator, type Chart, type KLineData, type XAxis, type YAxis } from "klinecharts";

import { CANDLE_COLORS } from "./chartPalette";
import { heikinAshi, type HaRow } from "./heikinAshi";

/**
 * Heikin-Ashi 的库绑定层（推荐清单第④片，spec §三.A/§四）。
 *
 * 走的是三条**已核实**的库通道，都读自未打补丁的 `klinecharts@10.0.3`：
 *
 * 1. `IndicatorView.prototype.drawImp`（`dist/index.esm.js:8028`）问完 `indicator.draw` 之后
 *    `if (!isCover) { …默认图元… }` ⇒ **返回 `true` 就是整体接管这一根 pane 上该指标的绘制**。
 *    返回 false 会把库的折线一起画出来（重复绘制），所以返回值本身是判据。
 * 2. `YAxisImp.prototype.createRangeImp`（`:984`，折叠在 `:1045-1056`）把该 y 轴上每个指标的
 *    每个 `figures[].key` 的数值当**价格**并进 min/max ⇒ HA 高低挂在 figure key 上就免裁切
 *    （缺口向量：某根真实 high=2 而 haHigh=15）。反过来，像素量绝不能进 result。
 * 3. `candle.bar` 的九个颜色键（`CandleBarColor` = 3 填充 + 3 边框 + 3 影线）是藏原生蜡烛的唯一
 *    杠杆；`candle.type` 那个键归分时开关所有，抢它会破坏 `chartStyles` 的顺序契约
 *    （`ProChart.tsx:294-298`），`priceMark` 整棵子树归图例偏好所有（`chartLegend.ts:109-115`），
 *    HA 侧不写它。
 *
 * 图例只出一行「平均K线 开/高/低/收」：`figures` 声明两键（高低）就够包络轴，而
 * `createTooltipDataSource` 返回的 `legends` 会**整段替换**由 figures 生成的默认行
 * （`IndicatorTooltipView.getIndicatorTooltipData`，`dist:7241-7334`），所以行数由这一支决定，
 * 不由 figures 决定。变换值进不了蜡烛图例（库的 `candle.tooltip.legend.template` 回调只收到
 * 真实 `KLineData`），spec §五 的裁定是让它就待在指标自己那一行，行名写明是平均K线。
 */

export const HEIKIN_ASHI_NAME = "HEIKIN_ASHI";
export const HEIKIN_ASHI_SHORT_NAME = "平均K线";

/** 布尔偏好的最省键形，照磁吸 `pro-chart.magnet.v1`（`chartDrawings.ts:1028`）。 */
export const HEIKIN_ASHI_PREFS_KEY = "pro-chart.heikin-ashi.v1";

/**
 * 藏原生蜡烛＝把 `CandleBarColor` 的九个颜色键全推 `transparent`。
 *
 * 恰好九个，一个不多一个不少：`compareRule` 不是颜色键（它决定用哪个比较价选色，留着不改），
 * `type`/`area`/`priceMark`/`tooltip` 都不在这棵子树里。测试逐键钉这个集合，因为**少推一个
 * 就漏出一根真蜡烛**——而漏出来的是半根，肉眼会在切换时看到「有东西在动」。
 */
export const CANDLE_HIDDEN = Object.freeze({
  upColor: "transparent",
  downColor: "transparent",
  noChangeColor: "transparent",
  upBorderColor: "transparent",
  downBorderColor: "transparent",
  noChangeBorderColor: "transparent",
  upWickColor: "transparent",
  downWickColor: "transparent",
  noChangeWickColor: "transparent",
} as const);

/**
 * HA 是否真的在图上。单一谓词，样式侧和挂卸侧都问它——本仓刚把周期合法性的三个谓词搬进
 * `lib/chartView.ts` 做成同样的「单一判据两处同读」（commit 3d06fafd），这里照同一个形状。
 * 分时是面积线（`candle.type === "area"`），上面没有蜡烛可换，所以分时一律压掉。
 */
export function heikinAshiActive(haOn: boolean, timeShare: boolean): boolean {
  return haOn && !timeShare;
}

/** 默认关；除 `"1"` 之外的一切（含手改的垃圾值、storage 抛错）都读成关。 */
export function loadHeikinAshi(): boolean {
  try {
    return localStorage.getItem(HEIKIN_ASHI_PREFS_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * 未偏离默认不落盘（`chartLegend.ts:81-93` 的写侧纪律）：关的时候删键，而不是写 `"0"`。
 * 写 `"0"` 会把「今天默认是关」冻进每个用户的 storage，将来若改默认值就再也传不下去。
 */
export function saveHeikinAshi(on: boolean): void {
  try {
    if (on) localStorage.setItem(HEIKIN_ASHI_PREFS_KEY, "1");
    else localStorage.removeItem(HEIKIN_ASHI_PREFS_KEY);
  } catch {
    /* best effort */
  }
}

/** `calc` 的行只允许这四个键；导给测试当白名单，别在两个文件里各写一遍字面量。 */
export { HA_PRICE_KEYS as HA_PRICE_KEYS_FOR_TEST } from "./heikinAshi";

type CompleteHaRow = Required<HaRow>;

export function isHaRow(row: HaRow | undefined): row is CompleteHaRow {
  return (
    row !== undefined &&
    typeof row.open === "number" &&
    typeof row.high === "number" &&
    typeof row.low === "number" &&
    typeof row.close === "number"
  );
}

/** `draw`／`createTooltipDataSource` 的形参面，写成结构化类型以便单测直接喂假对象。 */
interface DrawCtx {
  fillStyle: string;
  fillRect(x: number, y: number, w: number, h: number): void;
}

interface DrawParams {
  ctx: DrawCtx;
  chart: Pick<Chart, "getVisibleRange" | "getBarSpace" | "getDataList">;
  indicator: { result: HaRow[] };
  xAxis: Pick<XAxis, "convertToPixel">;
  yAxis: Pick<YAxis, "convertToPixel">;
}

interface TooltipParams {
  chart: Pick<Chart, "getDataList">;
  indicator: { result: HaRow[] };
  crosshair: { dataIndex?: number };
}

/**
 * 涨色判据用 **HA 自己**的开收，不用真实收叠——这是 Heikin-Ashi 的定义（spec §二·7），
 * 也正是「趋势段读成连续色块」的来源。本仓 `CANDLE_COLORS` 里边框色与填充色同值
 * （`chartPalette.ts:10-14` 每对都相等），所以库的 `stroke_fill` 实体在我们这里退化成
 * 一次 `fillRect`； palette 若哪天把边框色拆开，这一行要补 `strokeRect`。
 */
function colorsOf(row: CompleteHaRow): { body: string; wick: string } {
  if (row.close > row.open) return { body: CANDLE_COLORS.up, wick: CANDLE_COLORS.up };
  if (row.close < row.open) return { body: CANDLE_COLORS.down, wick: CANDLE_COLORS.down };
  return { body: CANDLE_COLORS.noChange, wick: CANDLE_COLORS.noChange };
}

/**
 * 一根 HA 实体＝影线（1px 宽，从最高像素到最低像素）＋实体（从 max(y(open),y(close)) 起）。
 *
 * 几何逐键镜像库自己的 `CandleBarView`：`priceY = [y(open), y(close), y(high), y(low)]` 升序排
 * （`dist:6562-6565`）、`correction = barSpace.gapBar % 2 === 0 ? 1 : 0`（`:6568`，注意是**偶数**加 1）、
 * 影线 `{x, y: priceY[0], width: 1, height: priceY[3] - priceY[0]}`、实体
 * `{x: x - halfGapBar, y: priceY[1], width: gapBar + correction, height: Math.max(1, priceY[2] - priceY[1])}`
 * （`_createSolidBar`，`:6652-6677`）。x 用 `xAxis.convertToPixel(dataIndex)`，它正是库算
 * `visibleRangeDataList[i].x` 用的同一个 `StoreImp.dataIndexToCoordinate`（`:10993-10995` ⇄ `:13577`）
 * ⇒ 与网格、十字光标逐像素对齐。
 */
export function haDraw({ ctx, chart, indicator, xAxis, yAxis }: DrawParams): boolean {
  const { realFrom, realTo } = chart.getVisibleRange();
  const barSpace = chart.getBarSpace();
  const result = indicator.result;
  const correction = barSpace.gapBar % 2 === 0 ? 1 : 0;
  const from = Math.max(0, realFrom);
  // `realTo` 是排他的（库自己的循环 `for (i = realFrom; i < realTo; i++)`，`:13574`），
  // 再与 result 长度取小：右侧留白区里有像素但没有数据。
  const to = Math.min(realTo, result.length);
  for (let i = from; i < to; i++) {
    const row = result[i];
    if (!isHaRow(row)) continue;
    const x = xAxis.convertToPixel(i);
    const priceY = [
      yAxis.convertToPixel(row.open),
      yAxis.convertToPixel(row.close),
      yAxis.convertToPixel(row.high),
      yAxis.convertToPixel(row.low),
    ].sort((a, b) => a - b);
    const colors = colorsOf(row);
    ctx.fillStyle = colors.wick;
    ctx.fillRect(x, priceY[0], 1, priceY[3] - priceY[0]);
    ctx.fillStyle = colors.body;
    ctx.fillRect(x - barSpace.halfGapBar, priceY[1], barSpace.gapBar + correction, Math.max(1, priceY[2] - priceY[1]));
  }
  return true;
}

function fmt(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "-";
}

/**
 * 一行四价。`crosshair.dataIndex` 缺省时读最后一根（图例在光标离开图上时也要有数），
 * 越界／na 读 `"-"` 而不是编一个数。标题用中文字面量是本仓既有做法：指标图例行不走 i18n
 * （库只对**蜡烛**图例的 title 再跑一次 `i18n`，`dist:7678`），`均价: ` 同例。
 */
export function haTooltipDataSource({ chart, indicator, crosshair }: TooltipParams) {
  const result = indicator.result;
  const index = typeof crosshair.dataIndex === "number" ? crosshair.dataIndex : chart.getDataList().length - 1;
  const row = result[index];
  return {
    name: HEIKIN_ASHI_SHORT_NAME,
    calcParamsText: "",
    features: [] as never[],
    legends: [
      { title: "开: ", value: fmt(row?.open) },
      { title: "高: ", value: fmt(row?.high) },
      { title: "低: ", value: fmt(row?.low) },
      { title: "收: ", value: fmt(row?.close) },
    ],
  };
}

/**
 * 注册守卫：`registerIndicator` 改的是全局表，每次切换都注册会在图表活着的时候反复覆写。
 * 模块布尔正是 `ensureTimeShareIndicator`（`timeShare.ts:314-325`）用的同一写法，也让点击处
 * 和挂载处都不需要知道对方是否已经注册过。
 *
 * `figures[].type` 是实践必需而不是类型必需（`prepareIndicatorFigures` 只保留
 * `isValid(figure.type)` 的图元，`dist:3081-3125`）——本仓在 `timeShare.ts:309-312` 记过同一个坑。
 * 两键都带 `title`：`createTooltipDataSource` 覆写图例行，但万一那条回调不生效，退化的两行
 * 也该被读成「高/低」而不是无名数。
 */
let registered = false;

export function ensureHeikinAshiIndicator(): void {
  if (registered) return;
  registered = true;
  registerIndicator<HaRow>({
    name: HEIKIN_ASHI_NAME,
    shortName: HEIKIN_ASHI_SHORT_NAME,
    precision: 2,
    series: "price",
    figures: [
      { key: "high", title: "高: ", type: "line" as const },
      { key: "low", title: "低: ", type: "line" as const },
    ],
    calc: (dataList: KLineData[]) => heikinAshi(dataList),
    draw: (params) => haDraw(params as unknown as DrawParams),
    createTooltipDataSource: (params) => haTooltipDataSource(params as unknown as TooltipParams),
  });
}
```

- [ ] **Step 4: 跑测试，确认全绿**

```
cd frontend && npx vitest run src/lib/__tests__/heikinAshiChart.test.ts 2>&1 | cat
```

期望：PASS。若「每根画一个影线＋一个实体」那条红的只是 `y`/`h` 的小数位，先手算 `100 - 10.5`，**不要**改期望值去迁就实现。

- [ ] **Step 5: 类型门**

```
cd frontend && npx tsc --noEmit -p tsconfig.json; echo "rc=$?"
```

期望：`rc=0`。若 `registerIndicator<HaRow>` 的 `draw`/`createTooltipDataSource` 形参与库类型不吻合，允许保留 `as unknown as` 转换（**不许**为此改 `node_modules`，也不许把 `DrawParams` 换成 `any`）。

- [ ] **Step 6: 提交**

```
git add -- frontend/src/lib/heikinAshiChart.ts frontend/src/lib/__tests__/heikinAshiChart.test.ts
git commit -s -m "$(cat <<'EOF'
feat(heikinAshi): 库绑定层——draw 接管绘制、figure 键折轴、九色藏真蜡烛

三条通道都从 10.0.3 未打补丁的 bundle 里核实过坐标：IndicatorView.drawImp 见
isCover 跳过默认图元，YAxisImp.createRangeImp 把 figures[].key 当价格折进 min/max
（所以 HA 高低挂在 figure 上免裁切，而像素量绝不能进 result），CandleBarColor 的
九个颜色键是藏原生蜡烛的唯一杠杆。几何逐键镜像 CandleBarView._createSolidBar，
含 gapBar % 2 === 0 才加 1 的那条 correction。图例走 createTooltipDataSource 一整行
四价，行名写「平均K线」——变换值不进蜡烛图例。
EOF
)" -- frontend/src/lib/heikinAshiChart.ts frontend/src/lib/__tests__/heikinAshiChart.test.ts
```

---

## Task 3: `chartStyles` 第四形参＋九色切换＋主题依赖数组

**Files:**
- Modify: `frontend/src/pages/ProChart.tsx`（`chartStyles` `:277-332`；`init` 推送点 `:1010`；主题 effect `:1272-1274`）
- Test: `frontend/src/pages/__tests__/ProChartHeikinAshi.test.tsx`（新建）

**Interfaces:**
- Consumes: `CANDLE_HIDDEN`、`heikinAshiActive`、`loadHeikinAshi`（Task 2）、`CANDLE_COLORS`（既有）
- Produces: `chartStyles(dark: boolean, timeShare = false, legend: LegendPrefs, ha: boolean)` — **第四个形参不给默认值**，两处推送点必须传（同 `legend` 不给默认的既有理由，见 `:273-276`）

- [ ] **Step 1: 写失败的测试**

创建 `frontend/src/pages/__tests__/ProChartHeikinAshi.test.tsx`。图表替身**以 `pages/__tests__/ProChartReplay.test.tsx:145-182` 为底**抄——那份今天真的驱动 `init` 数据，说明它覆盖了「页面 init effect ＋ 数据回调」之后会调的整张方法面（`getDom`/`setBarSpace`/`setOffsetRightDistance`/`scrollToRealTime`/`getVisibleRange`/`resetData` 都在里面）。**不要**抄 legend 那份：它 `setDataLoader: () => undefined`，页面装不上 loader，`barCount` 就永远停在 0（`setBarCount` 只在 `ProChart.tsx:1112` 的 `init` 答案里发生），平均K线按钮于是永远 `disabled`，本片所有点击类判据会对着一个点不动的按钮假绿。相对那份改三处：`setStyles` 换成录制版、指标三兄弟（`getIndicators`/`createIndicator`/`removeIndicator`）换成下面给出的**有状态**版本、`overrideOverlay` 换成往 `h.overridden` 里记一笔的版本。全文：

```tsx
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { publishThemeChange } from "@/lib/theme-store";
import { CANDLE_COLORS } from "@/lib/chartPalette";
import { HEIKIN_ASHI_PREFS_KEY } from "@/lib/heikinAshiChart";
import { ProChart } from "../ProChart";

/**
 * Heikin-Ashi 的页面接线（推荐清单第④片，spec §二·6/§七·4/§七·5）。
 *
 * 两条主判据：
 * 1. 样式只有一个合成点。`chartStyles` 整个对象会被主题 effect 在每次换主题时重推，
 *    所以「九色透明」这个状态如果没同时进形参表和依赖数组，切主题就会把真蜡烛刷回来——
 *    本文件里那条切主题的测试就是这个历史故障的形状（同 `ProChartLegend.test.tsx:150`）。
 * 2. HA 只改像素。开与关都不许动 `getDataList()` 的内容、不许动蜡烛图例模板、
 *    不许写 `candle.priceMark`（那是图例偏好的子树）。
 */

const h = vi.hoisted(() => ({
  styles: [] as Array<Record<string, unknown>>,
  indicators: [] as Array<{ name: string; paneId: string; id: string }>,
  created: [] as Array<Record<string, unknown>>,
  // 每次 `overrideOverlay` 收到的是什么。第⑤片的真值边界钉用它判「切 HA 不该重锚画线」，
  // 所以判据是「切换前后这个数组没长」，不是「它等于空」。
  overridden: [] as unknown[],
  list: [] as Array<Record<string, unknown>>,
  loader: null as null | {
    getBars: (p: {
      type: string;
      timestamp: number | null;
      period: unknown;
      symbol: { ticker: string };
      callback: (data: unknown[], more?: unknown) => void;
    }) => void | Promise<void>;
  },
}));

/**
 * 页面唯一的数据入口。替身只驱动 `init`：本片不分页，但 `init` 必须真的被回答一次，
 * 因为 `setBarCount`（`ProChart.tsx:1112`）只在那一次发生，而按钮的 disabled 判据读它。
 */
function ask(): void {
  if (!h.loader) throw new Error("页面没有装 DataLoader");
  void Promise.resolve(
    h.loader.getBars({
      type: "init",
      timestamp: null,
      period: { type: "day", span: 1 },
      symbol: { ticker: "600519.SH" },
      // 库会把答案装进 store；替身的 store 就是 `h.list`，已经在那儿了。
      callback: () => undefined,
    }),
  ).catch(() => undefined);
}

function styleAt(i: number): Record<string, unknown> {
  return h.styles[i];
}

const lastStyle = () => styleAt(h.styles.length - 1);
const pushCount = () => h.styles.length;

function barOf(i: number): Record<string, unknown> {
  return {
    timestamp: 1_700_000_000_000 + i * 86_400_000,
    open: 100 + i,
    high: 105 + i,
    low: 95 + i,
    close: 102 + i,
    volume: 1000 + i,
  };
}

/**
 * 摆好 `h.list` 再 render：`ask()` 会把这份数组原样交回页面，`barCount` 因此离开 0。
 * 同步函数不是偷懒——数据是在 render 的 init effect 里被替身主动要走的，先摆好就行；
 * 一个 `await` 反而会把「页面装 loader」和「页面问数据」两次副作用拆成两个宏任务，
 * 让样式推送的下标读起来比测试作者预期的多一格。
 */
function seed(count = 6): void {
  h.list = Array.from({ length: count }, (_, i) => barOf(i));
}

/** `candle.bar` as the i-th push carried it. */
function barColors(i: number): Record<string, unknown> {
  return (styleAt(i) as { candle?: { bar?: Record<string, unknown> } }).candle?.bar ?? {};
}

function candleType(i: number): unknown {
  return (styleAt(i) as { candle?: { type?: string } }).candle?.type;
}

function priceMark(i: number): unknown {
  return (styleAt(i) as { candle?: { priceMark?: unknown } }).candle?.priceMark;
}

function tooltipTemplate(i: number): unknown[] {
  return (styleAt(i) as { candle: { tooltip: { legend: { template: unknown[] } } } }).candle.tooltip.legend.template;
}

vi.mock("klinecharts", () => ({
  registerIndicator: vi.fn(),
  getSupportedLocales: () => ["en-US", "zh-CN"],
  registerLocale: vi.fn(),
  dispose: vi.fn(),
  init: () => ({
    getSymbol: () => ({ ticker: "600519.SH", pricePrecision: 2, volumePrecision: 0 }),
    getDataList: () => h.list,
    // 有状态版本：第④片的挂卸判据要能回答「图上现在有哪些指标」。
    getIndicators: (filter?: { name?: string; id?: string; paneId?: string }) =>
      h.indicators.filter((ind) => {
        if (filter?.name !== undefined && ind.name !== filter.name) return false;
        if (filter?.id !== undefined && ind.id !== filter.id) return false;
        if (filter?.paneId !== undefined && ind.paneId !== filter.paneId) return false;
        return true;
      }),
    createIndicator: (value: { name: string; paneId?: string }) => {
      h.created.push(value as Record<string, unknown>);
      h.indicators.push({ name: value.name, paneId: value.paneId ?? `sub:${value.name}`, id: `i${h.indicators.length}` });
      return true;
    },
    removeIndicator: (filter: { name?: string; id?: string; paneId?: string }) => {
      const before = h.indicators.length;
      h.indicators = h.indicators.filter(
        (ind) =>
          (filter?.name === undefined || ind.name !== filter.name) &&
          (filter?.id === undefined || ind.id !== filter.id) &&
          (filter?.paneId === undefined || ind.paneId !== filter.paneId),
      );
      return h.indicators.length < before;
    },
    getOverlays: () => [],
    getPaneOptions: () => [{ id: "candle_pane", height: 300, minHeight: 30, state: "normal" }],
    setPaneOptions: vi.fn(),
    // 装 loader 的那一格是整份替身的关键：不接，页面就没地方要数据，`barCount` 停在 0。
    setDataLoader: (loader: typeof h.loader) => {
      h.loader = loader;
    },
    // 真实库里 `setSymbol`/`setPeriod`/`resetData` 各自触发一次 `init` 取数
    // （StoreImp.resetData, dist 13652）。分时切换走 `setPeriod`，所以三个都得问。
    setSymbol: () => ask(),
    setPeriod: () => ask(),
    resetData: () => ask(),
    setStyles: (s: Record<string, unknown>) => h.styles.push(s),
    resize: vi.fn(),
    createOverlay: vi.fn(),
    removeOverlay: vi.fn(),
    // 录制版：第⑤片的「切 HA 不重锚画线」判据读的是这个数组的长度增量。
    overrideOverlay: (o: unknown) => {
      h.overridden.push(o);
      return true;
    },
    getOffsetRightDistance: () => 0,
    setOffsetRightDistance: vi.fn(),
    getBarSpace: () => ({ bar: 8, halfBar: 4, gapBar: 5, halfGapBar: 2 }),
    setBarSpace: vi.fn(),
    scrollToRealTime: vi.fn(),
    // `to`/`realTo` 是排他的（klinecharts 游标契约），所以直接给数据长度。
    getVisibleRange: () => ({
      from: 0,
      to: h.list.length,
      realFrom: 0,
      realTo: h.list.length,
    }),
    // jsdom 里没有真的盒子：`fitSessionToWidth` 读到 `undefined` 宽度就走它自己
    // 那句「leave the zoom alone」（`ProChart.tsx:891`），这正是本片要的分支。
    getDom: () => undefined,
  }),
}));

vi.mock("@/lib/marketApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/marketApi")>();
  return {
    ...actual,
    fetchKline: async (params: { before?: number | null }) => ({
      bars: params.before == null ? h.list : [],
      source: "fake",
      symbol: "600519.SH",
      interval: "1D",
      ok: true,
    }),
  };
});

vi.mock("@/components/charts/WatchList", () => ({ default: () => null }));
vi.mock("@/components/charts/IndicatorEditor", () => ({ default: () => null }));

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const NINE_BAR_KEYS = [
  "upColor",
  "downColor",
  "noChangeColor",
  "upBorderColor",
  "downBorderColor",
  "noChangeBorderColor",
  "upWickColor",
  "downWickColor",
  "noChangeWickColor",
] as const;

beforeEach(() => {
  h.styles = [];
  h.indicators = [];
  h.created = [];
  h.overridden = [];
  h.loader = null;
  // 默认就带上 bar：真实使用里图上有数据，按钮的 `barCount > 0` 判据不该替测试挡路。
  // 要空图的那条自己 `h.list = []` 再 render（第⑤片那条就是）。
  seed();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

describe("/pro-chart 平均K线的样式链", () => {
  it("默认关：九色是调色板值，type 是 candle_solid，一个 transparent 都不写", async () => {
    render(<ProChart />);
    await flush();
    const last = pushCount() - 1;
    const colors = barColors(last);
    expect(Object.keys(colors)).toHaveLength(9);
    for (const key of NINE_BAR_KEYS) expect(colors[key]).not.toBe("transparent");
    expect(colors.upColor).toBe(CANDLE_COLORS.up);
    expect(colors.downWickColor).toBe(CANDLE_COLORS.down);
    expect(candleType(last)).toBe("candle_solid");
  });

  it("偏好开：首次推送就九色全透明，type 仍是 candle_solid", async () => {
    localStorage.setItem(HEIKIN_ASHI_PREFS_KEY, "1");
    render(<ProChart />);
    await flush();
    const last = pushCount() - 1;
    for (const key of NINE_BAR_KEYS) expect(barColors(last)[key]).toBe("transparent");
    // `type` 归分时开关所有。HA 抢它＝破坏 chartStyles:294-298 的顺序契约。
    expect(candleType(last)).toBe("candle_solid");
  });

  it("开着 HA 切主题：九色仍透明，type 仍 candle_solid（漏依赖数组就红）", async () => {
    localStorage.setItem(HEIKIN_ASHI_PREFS_KEY, "1");
    render(<ProChart />);
    await flush();
    const before = pushCount();

    act(() => {
      document.documentElement.classList.add("dark");
      publishThemeChange();
    });
    await flush();

    expect(pushCount()).toBeGreaterThan(before);
    const last = pushCount() - 1;
    for (const key of NINE_BAR_KEYS) expect(barColors(last)[key]).toBe("transparent");
    expect(candleType(last)).toBe("candle_solid");
    // 同一次推送里两半都在：主题重推的是整个 chartStyles 对象。
    expect(last).toBeGreaterThanOrEqual(1);
  });

  it("HA 不写 priceMark（那棵子树归图例偏好所有），也不动蜡烛图例模板", async () => {
    localStorage.setItem(HEIKIN_ASHI_PREFS_KEY, "1");
    render(<ProChart />);
    await flush();
    const last = pushCount() - 1;
    // 图例偏好默认 highLowMark/lastPriceLine 都开 ⇒ priceMark 仍是片段给的那棵，
    // HA 侧写它就是把用户开关静默覆盖。
    expect(priceMark(last)).toEqual({
      high: { show: true },
      low: { show: true },
      last: { show: true, line: { show: true }, text: { show: true } },
    });
    expect(JSON.stringify(tooltipTemplate(last))).toBe(
      JSON.stringify([
        { title: "time", value: "{time}" },
        { title: "open", value: "{open}" },
        { title: "high", value: "{high}" },
        { title: "low", value: "{low}" },
        { title: "close", value: "{close}" },
        { title: "volume", value: "{volume}" },
      ]),
    );
  });
});
```

- [ ] **Step 2: 跑测试，确认它失败**

```
cd frontend && npx vitest run src/pages/__tests__/ProChartHeikinAshi.test.tsx 2>&1 | cat
```

期望：FAIL。第 2、3 条红在「九色仍是调色板值」（`chartStyles` 还不认 `ha`），第 4 条今天可能就绿——绿的那条要留作回归钉，不许删。

- [ ] **Step 3: 改 `chartStyles`**

在 `frontend/src/pages/ProChart.tsx` 的 import 区（紧接 `@/lib/chartLegend` 那段之后，`:108-113`）加：

```ts
import { CANDLE_HIDDEN, heikinAshiActive, loadHeikinAshi } from "@/lib/heikinAshiChart";
```

**只这三个。** `tsconfig.json` 开了 `noUnusedLocals: true`，把 Task 4 才用到的
`HEIKIN_ASHI_NAME`/`ensureHeikinAshiIndicator`/`saveHeikinAshi` 提前写进来，`tsc` 就在这一格红；
`HEIKIN_ASHI_PREFS_KEY` 页面**永远不 import**（键名只被 `load/saveHeikinAshi` 内部使用，页面只认这两个函数）——
测试文件才需要它，因为测试要在偏好那一格上直接摆值。

把 `chartStyles` 的签名与 `bar` 那块改成（`:273-276` 那段注释保留，把它的理由扩到 `ha`）：

```ts
// `legend` and `ha` have deliberately no default: every push site already passes
// both, and a defaulted trailing param would let a future `chartStyles(dark, timeShare)`
// compile, pass tsc, and silently strand the preference — the exact regression this
// function exists to prevent. For `ha` the stranded state is worse than a missing row:
// the nine transparent colours and the mounted indicator would disagree, and the chart
// would show real candles painted invisible (or the reverse).
function chartStyles(dark: boolean, timeShare = false, legend: LegendPrefs, ha: boolean) {
  // A-share convention: red = up, green = down. Candle colors live under
  // `candle.bar` in v10 (`.area` is for area/line charts).
  //
  // The type lives *here*, not at the toggle, because the theme effect below
  // pushes this whole object through `setStyles` on every theme change: while
  // the choice was made anywhere else, switching themes painted the candles back
  // over a 分时 line and the toggle looked like it had stopped working.
  const type: CandleType = timeShare ? "area" : "candle_solid";
  // `heikinAshiActive` is the same predicate the mount effect asks, so the two
  // channels (styles and indicator lifecycle) cannot drift: an HA that is painted
  // but not mounted would show nine invisible rectangles and nothing else.
  const haShown = heikinAshiActive(ha, timeShare);
  // The legend fragment is composed *here*, the single style-composition point
  // (spec §三.C): v10 has no `setTooltipOptions`, and the theme effect below
  // re-pushes this whole object, so a preference living anywhere outside this
  // function is painted back out by the next dark-mode flip.
  const legendFragment = legendStyles(legend);
  return {
    grid: { horizontal: { color: dark ? "#1f2733" : "#f0f0f0" }, vertical: { color: dark ? "#1f2733" : "#f0f0f0" } },
    candle: {
      // Fragment first, this function's own keys after: the fragment only ever
      // writes `tooltip`/`priceMark`, `candle` here writes `type`/`bar`/`area`,
      // so the two subtrees cannot collide whichever way they are spread — and
      // keeping this order is what stops a future fragment key from stealing
      // `type` away from the 分时 toggle.
      ...legendFragment.candle,
      type,
      // Hiding the native candles is *only* these nine colour keys (`CandleBarColor`).
      // `priceMark` is left alone on purpose: 高低价标记／最新价 keep measuring real
      // prices while the bodies are transformed, which is a true reading, not leftovers.
      bar: haShown
        ? CANDLE_HIDDEN
        : {
            upColor: CANDLE_COLORS.up,
            downColor: CANDLE_COLORS.down,
            noChangeColor: CANDLE_COLORS.noChange,
            upBorderColor: CANDLE_COLORS.up,
            downBorderColor: CANDLE_COLORS.down,
            noChangeBorderColor: CANDLE_COLORS.noChange,
            upWickColor: CANDLE_COLORS.up,
            downWickColor: CANDLE_COLORS.down,
            noChangeWickColor: CANDLE_COLORS.noChange,
          },
      area: {
        lineSize: 1.5,
        lineColor: TIME_SHARE_LINE,
        // The minute *closes*, joined up — which is what a broker's 分时 line
        // is. Naming it here rather than trusting the library default keeps the
        // claim checkable: `high`/`low` would draw a plausible, wrong shape.
        value: "close",
        smooth: false,
        // Faint, so the 均价 line stays readable on top of the fill.
        backgroundColor: [
          { offset: 0, color: `${TIME_SHARE_LINE}33` },
          { offset: 1, color: `${TIME_SHARE_LINE}05` },
        ],
      },
    },
    // Sub-pane indicator legends ride the same object for the same reason.
    indicator: legendFragment.indicator,
    xAxis: { axisLine: { color: dark ? "#4a4a4a" : "#ccc" }, tickText: { color: dark ? "#aaa" : "#666" } },
    yAxis: { axisLine: { color: dark ? "#4a4a4a" : "#ccc" }, tickText: { color: dark ? "#aaa" : "#666" } },
  };
}
```

- [ ] **Step 4: 加状态、改两处推送点**

状态紧挨 legend 那两行（`:527-532` 之后）：

```ts
  // Heikin-Ashi（第④片）：一个视图偏好，默认关，未偏离不落盘。`haRef` 的原因与
  // `legendRef`/`magnetRef` 同——同一个 task 里连点两次，都摊到同一份过期快照上，
  // 第二次就会撤销第一次。
  const [haOn, setHaOn] = useState(() => loadHeikinAshi());
  const haRef = useRef(haOn);
```

`init` 点（`:1010`）：

```ts
      // `legend`/`haOn` here are the mount values, which is the right value: this effect
      // runs once per mount, and every later change goes through the theme effect below.
      styles: chartStyles(dark, session.timeShare, legend, haOn),
```

主题 effect（`:1265-1274`）：

```ts
  // Theme switch → restyle in place. Also the only writer of the candle/line
  // choice, so `timeShare` is a dependency: leaving it out let a theme change
  // repaint a 分时 line as candles. `legend` joins that list for the same reason
  // and by the same mechanism — the legend has no other lever in v10 (there is
  // no `setTooltipOptions`), so this effect is what puts a legend preference on
  // the chart, and leaving `legend` out would strand every panel control.
  // `haOn` joins for the third time the same reason: the nine transparent colours
  // ARE the switch on the styles side, and a colour set left out of this list is
  // a preference the next dark-mode flip paints back.
  useEffect(() => {
    chartRef.current?.setStyles(chartStyles(dark, timeShare, legend, haOn));
  }, [dark, timeShare, legend, haOn]);
```

- [ ] **Step 5: 跑测试，确认全绿**

```
cd frontend && npx vitest run src/pages/__tests__/ProChartHeikinAshi.test.tsx 2>&1 | cat
```

期望：PASS（4 条）。若「默认关」那条红在 `Object.keys(colors)` 长度，检查 `bar` 块是否被 spread 成了两个对象。

- [ ] **Step 6: 类型门＋既有图例回归**

```
cd frontend && npx tsc --noEmit -p tsconfig.json; echo "rc=$?"
npx vitest run src/pages/__tests__/ProChartLegend.test.tsx src/pages/__tests__/ProChartReplay.test.tsx 2>&1 | cat
```

期望：`rc=0`，两个既有文件全绿（`chartStyles` 多了必填形参，任何漏改的调用点会在 tsc 就红）。

- [ ] **Step 7: 提交**

```
git add -- frontend/src/pages/ProChart.tsx frontend/src/pages/__tests__/ProChartHeikinAshi.test.tsx
git commit -s -m "$(cat <<'EOF'
feat(heikinAshi): chartStyles 第四形参接九色，并进主题依赖数组

隐藏原生蜡烛只有 candle.bar 那九个颜色键这一条通道，而 chartStyles 是整个对象被主题
effect 重推的唯一合成点——所以「HA 开着」这个状态不进形参表就是进不了图，不进依赖数组
就是下一次切主题把真蜡烛刷回来（分时那一片已经为同款故障付过一次）。priceMark 一个字
不写：高低价标记／最新价继续标真实价，那棵子树归图例偏好面板所有。
EOF
)" -- frontend/src/pages/ProChart.tsx frontend/src/pages/__tests__/ProChartHeikinAshi.test.tsx
```

---

## Task 4: 指标挂卸 effect ＋ 工具栏按钮（含分时互斥与 disabled 理由）

**Files:**
- Modify: `frontend/src/pages/ProChart.tsx`（`syncPriceOverlay` 之后 `:945`；`toggleMagnet` 之后 `:1816`；工具栏分时按钮之后 `:2190`）
- Test: `frontend/src/pages/__tests__/ProChartHeikinAshi.test.tsx`（追加一个 `describe`）

**Interfaces:**
- Consumes: `HEIKIN_ASHI_NAME`、`ensureHeikinAshiIndicator`、`heikinAshiActive`、`saveHeikinAshi`（Task 2）、`MAIN_PANE_ID`（`chartDrawings.ts:92`）、`barCount`（`:577`，`setBarCount` 只在 `:1112` 的 `type === "init"` 处发生）、`intervalAllowed`（`lib/chartView.ts:34-36`）
- Produces: `syncHeikinAshi(chart, on)`、`toggleHeikinAshi()`，以及文案为「平均K线」的工具栏按钮（`aria-label="平均K线"`、`aria-pressed`）

- [ ] **Step 1: 追加失败的测试**

在 `ProChartHeikinAshi.test.tsx` 末尾追加：

```tsx
describe("/pro-chart 平均K线的挂卸与互斥", () => {
  // `beforeEach` 已经 `seed()` 过，bar 是有的；`h.created` 之所以在点之前清一次，
  // 是因为 init 那一路 `syncPriceOverlay`/`syncSubPanes` 已经创建过 MA／VOL／MACD
  // （`ProChart.tsx:1228,1234`），计数判据要数的是「这次点按钮创建了几个」。
  // `h.indicators` 与 `h.styles` **不许**清：它们是「主图现在载着什么」的唯一真相，
  // 清掉就把「挂 HA 不吃掉 MA」那条钉成了假绿。
  const haCreates = () => h.created.filter((c) => (c as { name?: string }).name === "HEIKIN_ASHI");

  it("点一次：先删后挂到 candle_pane，并创建的是 HEIKIN_ASHI", async () => {
    render(<ProChart />);
    await flush();
    h.created = [];
    fireEvent.click(screen.getByRole("button", { name: "平均K线" }));
    await flush();
    expect(haCreates()).toHaveLength(1);
    expect(haCreates()[0]).toMatchObject({ name: "HEIKIN_ASHI", paneId: "candle_pane" });
    expect(h.indicators.find((i) => i.name === "HEIKIN_ASHI")?.paneId).toBe("candle_pane");
    for (const key of NINE_BAR_KEYS) expect(barColors(pushCount() - 1)[key]).toBe("transparent");
    expect(localStorage.getItem(HEIKIN_ASHI_PREFS_KEY)).toBe("1");
    expect(screen.getByRole("button", { name: "平均K线" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("连点两次回到原样：指标卸掉、九色恢复、键被删", async () => {
    render(<ProChart />);
    await flush();
    const button = screen.getByRole("button", { name: "平均K线" });
    fireEvent.click(button);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "平均K线" }));
    await flush();
    expect(h.indicators.find((i) => i.name === "HEIKIN_ASHI")).toBeUndefined();
    for (const key of NINE_BAR_KEYS) expect(barColors(pushCount() - 1)[key]).not.toBe("transparent");
    expect(localStorage.getItem(HEIKIN_ASHI_PREFS_KEY)).toBeNull();
    expect(screen.getByRole("button", { name: "平均K线" }).getAttribute("aria-pressed")).toBe("false");
    // 卸载 HA 不能顺手把主图的 MA 也带走（removeIndicator 的过滤面只有 name）。
    expect(h.indicators.some((i) => i.name === "MA")).toBe(true);
  });

  it("反复开关不堆叠：HEIKIN_ASHI 在 created 里出现的次数等于按的次数", async () => {
    render(<ProChart />);
    await flush();
    h.created = [];
    for (let i = 0; i < 3; i++) {
      fireEvent.click(screen.getByRole("button", { name: "平均K线" }));
      await flush();
      fireEvent.click(screen.getByRole("button", { name: "平均K线" }));
      await flush();
    }
    expect(haCreates()).toHaveLength(3);
    expect(h.indicators.filter((i) => i.name === "HEIKIN_ASHI")).toHaveLength(0);
  });

  it("开着 HA 进分时：指标卸掉、九色恢复、type 变 area；回 K 线又自己回来", async () => {
    localStorage.setItem(HEIKIN_ASHI_PREFS_KEY, "1");
    render(<ProChart />);
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "分时" }));
    });
    await flush();
    expect(h.indicators.find((i) => i.name === "HEIKIN_ASHI")).toBeUndefined();
    const last = pushCount() - 1;
    for (const key of NINE_BAR_KEYS) expect(barColors(last)[key]).not.toBe("transparent");
    expect(candleType(last)).toBe("area");
    // 分时那一行的按钮 pressed 必是 false：图上是面积线，说 true 就是骗。
    expect(screen.getByRole("button", { name: "平均K线" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "平均K线" }).getAttribute("title")).toContain("分时是面积线");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "分时" }));
    });
    await flush();
    expect(h.indicators.find((i) => i.name === "HEIKIN_ASHI")?.paneId).toBe("candle_pane");
    for (const key of NINE_BAR_KEYS) expect(barColors(pushCount() - 1)[key]).toBe("transparent");
    expect(candleType(pushCount() - 1)).toBe("candle_solid");
    // 偏好没被分时改写：回到 K 线 HA 自己回来了，键还在。
    expect(localStorage.getItem(HEIKIN_ASHI_PREFS_KEY)).toBe("1");
  });

  it("图上没有 bar 时按钮 disabled 且 reason 说实话；HA 不会被挂上", async () => {
    localStorage.setItem(HEIKIN_ASHI_PREFS_KEY, "1");
    h.list = []; // 覆盖 `beforeEach` 的 seed：这条要的就是空图
    render(<ProChart />);
    await flush();
    const button = screen.getByRole("button", { name: "平均K线" });
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toContain("图上还没有数据");
    h.created = [];
    fireEvent.click(button);
    await flush();
    expect(haCreates()).toHaveLength(0);
  });

  it("挂 HA 不吃掉 MA：主图价格覆盖层那一条还在（syncPriceOverlay 的领地不被侵犯）", async () => {
    render(<ProChart />);
    await flush();
    h.created = [];
    fireEvent.click(screen.getByRole("button", { name: "平均K线" }));
    await flush();
    expect(h.indicators.some((i) => i.name === "MA")).toBe(true);
    expect(h.indicators.some((i) => i.name === "HEIKIN_ASHI")).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试，确认它失败**

```
cd frontend && npx vitest run src/pages/__tests__/ProChartHeikinAshi.test.tsx 2>&1 | cat
```

期望：新增 6 条全红，报错含 `Unable to find an accessible element with the role "button" and name "平均K线"`。

- [ ] **Step 3: 加 `syncHeikinAshi`**

先把 Task 3 那行 import 扩成三个新名字（`MAIN_PANE_ID` 页面已在用，不必新增）：

```ts
import {
  CANDLE_HIDDEN,
  HEIKIN_ASHI_NAME,
  ensureHeikinAshiIndicator,
  heikinAshiActive,
  loadHeikinAshi,
  saveHeikinAshi,
} from "@/lib/heikinAshiChart";
```

紧接 `syncPriceOverlay` 之后（`:945` 之后）：

```ts
  /**
   * Put the Heikin-Ashi overlay on the price pane, or take it off (第④片).
   *
   * Same先删后挂 shape as `syncPriceOverlay` for the same reason (`:915-925`):
   * `createIndicator(value, true)` always appends — `ChartImp.createIndicator` (dist 15270)
   * mints a fresh `create.id` before `StoreImp.addIndicator` (dist 14150) de-dups, and a
   * filter carrying an id matches on id alone (dist 14179) — so "is it already up?" cannot
   * be answered by the library and a second copy means a second legend row.
   *
   * Unmounting is `removeIndicator({ name })` even when nothing is mounted: `ChartImp.removeIndicator`
   * (dist 15323) only does work `if (removed)`, and the orphan-pane sweep explicitly skips the
   * candle pane (dist 15335-15341), so a no-match call cannot take the main chart down.
   */
  const syncHeikinAshi = (chart: Nullable<Chart>, on: boolean) => {
    if (!chart) return;
    if (!on) {
      chart.removeIndicator({ name: HEIKIN_ASHI_NAME });
      return;
    }
    ensureHeikinAshiIndicator();
    const live = chart.getIndicators({ name: HEIKIN_ASHI_NAME });
    live.slice(1).forEach((extra) => chart.removeIndicator({ id: extra.id }));
    if (live.length === 0) {
      chart.createIndicator({ name: HEIKIN_ASHI_NAME, paneId: MAIN_PANE_ID }, true);
    }
  };
```

- [ ] **Step 4: 加挂卸 effect**

紧接主题 effect（Task 3 改过的那条）之后：

```ts
  // HA 的指标挂载与九色是同一个开关的两条通道：图上的实体是指标画的，真蜡烛是被
  // 那九个透明色藏起来的。走 effect 而不是走点击处，是为了让「进分时」也把它卸下来——
  // 与 `timeShare` 进主题 effect 的理由一模一样。
  useEffect(() => {
    syncHeikinAshi(chartRef.current, heikinAshiActive(haOn, timeShare));
  }, [haOn, timeShare]);
```

- [ ] **Step 5: 加 `toggleHeikinAshi`**

紧接 `toggleMagnet`（`:1816` 之后）：

```ts
  /**
   * Flip 平均K线。Nothing else has to happen here: `haOn` is in the theme effect's
   * dependency list (nine colours) *and* in the mount effect's (indicator), so the two
   * channels both move from the same state change. Unlike `toggleMagnet` there is no
   * live object to re-apply — a magnet is a property of drawings that already exist,
   * an HA is a repaint.
   */
  const toggleHeikinAshi = () => {
    const next = !haRef.current;
    haRef.current = next;
    setHaOn(next);
    saveHeikinAshi(next);
  };
```

- [ ] **Step 6: 加工具栏按钮**

插在分时按钮那个 `</button>`（`:2190`）之后、`{INTERVALS.map(` 之前——它是视图开关，和分时同一个组、同一个 `disabled` 语言：

```tsx
          <button
            disabled={timeShare || barCount === 0}
            aria-label="平均K线"
            aria-pressed={heikinAshiActive(haOn, timeShare)}
            title={
              timeShare
                ? "分时是面积线，没有蜡烛可换成平均K线"
                : barCount === 0
                  ? "图上还没有数据，先等 K 线加载出来"
                  : haOn
                    ? "平均K线已开：主图按 Heikin-Ashi 重画，滤掉单根噪音把趋势段读成连续色块。只改像素——图例、磁吸落点、画线价位、下单读数都还是真实价（再点切回真实蜡烛）"
                    : "平均K线已关：点开把主图换成 Heikin-Ashi 平滑蜡烛（haClose=(O+H+L+C)/4，haOpen 接上一根），真实四价一个字节都不改"
            }
            className={cn(
              "rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40",
              heikinAshiActive(haOn, timeShare) && "bg-muted font-medium ring-1 ring-primary",
            )}
            onClick={toggleHeikinAshi}
          >
            平均K线
          </button>
```

- [ ] **Step 7: 跑测试，确认全绿**

```
cd frontend && npx vitest run src/pages/__tests__/ProChartHeikinAshi.test.tsx 2>&1 | cat
```

期望：PASS（10 条）。

- [ ] **Step 8: 类型门＋相邻回归**

```
cd frontend && npx tsc --noEmit -p tsconfig.json; echo "rc=$?"
npx vitest run src/pages/__tests__/ src/lib/__tests__/heikinAshi 2>&1 | cat
```

期望：`rc=0`，页面测试目录全绿（`ProChartDrawings`/`ProChartPaging`/`ProChartReplay` 用的是各自的替身，不受本页改动影响；若有红，先读红的那条断言指向哪个键，别改判据）。

- [ ] **Step 9: 提交**

```
git add -- frontend/src/pages/ProChart.tsx frontend/src/pages/__tests__/ProChartHeikinAshi.test.tsx
git commit -s -m "$(cat <<'EOF'
feat(heikinAshi): 指标挂卸 effect＋工具栏「平均K线」按钮与分时互斥

挂载与九色是同一个开关的两条通道，都走 effect 而不是点击处，这样进分时也会把它卸下来
——与 timeShare 进主题依赖数组同一个理由。先删后挂照 syncPriceOverlay：createIndicator
非幂等，堆一份就多一行图例。按钮的 disabled 判据与 reason 照 ReplayBar 那一处（分时／
无 bar 两种理由），aria-pressed 读的是 heikinAshiActive 而不是 haOn——分时上显示已开是骗人。
EOF
)" -- frontend/src/pages/ProChart.tsx frontend/src/pages/__tests__/ProChartHeikinAshi.test.tsx
```

---

## Task 5: 真值边界钉＋全量门禁

**Files:**
- Test: `frontend/src/pages/__tests__/ProChartHeikinAshi.test.tsx`（追加）
- Modify: 仅当断言暴露缺陷时才动 `frontend/src/lib/heikinAshiChart.ts`／`ProChart.tsx`

**Interfaces:**
- Consumes: 前四个 Task 的全部产出
- Produces: spec §七·4 的边界钉（数据面未被改写、磁吸与画线未被触碰）＋六道门的读数

- [ ] **Step 1: 追加真值边界测试**

```tsx
describe("/pro-chart 平均K线的真值边界（spec §五/§七·4）", () => {
  // 这一片不另造 `seed`：`beforeEach` 已经 `seed()`，数据面在 render 之前就摆好了。
  // 每条测试自己 `render(<ProChart />)` + `await flush()`——init 那一路的样式推送、
  // `syncPriceOverlay` 挂 MA、`syncSubPanes` 挂副图都会发生，边界钉要判的就是
  // 「在这条真实路径上再开一次 HA，那些东西没有被碰」。

  it("开 HA 前后 getDataList() 的内容与身份都没变：像素改写不落数据面", async () => {
    render(<ProChart />);
    await flush();
    const before = h.list;
    const snapshot = JSON.stringify(before);

    fireEvent.click(screen.getByRole("button", { name: "平均K线" }));
    await flush();

    expect(JSON.stringify(h.list)).toBe(snapshot);
    expect(h.list).toBe(before); // 同引用——没有 map 出来的副本，也没有原地覆写
    // 真实四价仍是真实四价（第 3 根 close 102+3）。
    expect(h.list[3]).toMatchObject({ open: 103, high: 108, low: 98, close: 105 });
    // 而且开的这一格确实生效了，否则「数据没变」是空话。
    for (const key of NINE_BAR_KEYS) expect(barColors(pushCount() - 1)[key]).toBe("transparent");
  });

  it("开一次、关一次都不新增画线重写：overrideOverlay 的计数不变", async () => {
    // 磁吸落点读的是 kline 数据自己的 high/low（dist 8823-8836），HA 不动数据面 ⇒ 不动落点。
    // 这一条钉的是「切换开关不会把用户已画的线重锚或重写」。
    // 断的是**增量**而不是 0：init 那一路 `restoreDrawings` 本来就可能重写若干次
    // （`ProChart.tsx:1182`），把它当 0 判是在钉替身，不是钉页面。
    render(<ProChart />);
    await flush();
    const before = h.overridden.length;

    fireEvent.click(screen.getByRole("button", { name: "平均K线" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "平均K线" }));
    await flush();

    expect(h.overridden).toHaveLength(before);
  });

  it("蜡烛图例那一行的六个占位符在开着 HA 时仍是真实价占位符", async () => {
    localStorage.setItem(HEIKIN_ASHI_PREFS_KEY, "1");
    render(<ProChart />);
    await flush();
    const last = pushCount() - 1;
    const rows = tooltipTemplate(last) as Array<{ title: string; value: string }>;
    expect(rows.map((r) => r.value)).toEqual(["{time}", "{open}", "{high}", "{low}", "{close}", "{volume}"]);
    // 变换值想上蜡烛图例得自己塞 template，而 template 是被 legendStyles 片段整体替换的
    // 那一条通道（spec §二·7／记忆 chart-legend-style-single-composition）。
    expect(JSON.stringify(rows)).not.toContain("平均");
  });

  it("指标图例规则仍由图例偏好说话：HA 那一行跟着「隐藏指标图例」消失，不是新写一条通道", async () => {
    render(<ProChart />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "图例" }));
    // label 原文就是带括号这一串（`ProChart.tsx:2509`）；写成「指标图例显示规则」会
    // `Unable to find label` ——那是替身替测试编了个不存在的控件名。
    fireEvent.change(screen.getByLabelText("指标图例显示规则（含主图 MA／均价）"), { target: { value: "none" } });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "平均K线" }));
    await flush();
    const last = pushCount() - 1;
    expect((styleAt(last) as { indicator: { tooltip: { showRule: string } } }).indicator.tooltip.showRule).toBe("none");
    // HA 只写 bar 的九色，indicator 那棵子树仍归片段。
    expect((styleAt(last) as { indicator: Record<string, unknown> }).indicator).toHaveProperty("tooltip");
    expect(Object.keys((styleAt(last) as { indicator: Record<string, unknown> }).indicator)).toEqual(["tooltip"]);
  });
});
```

- [ ] **Step 2: 跑测试**

```
cd frontend && npx vitest run src/pages/__tests__/ProChartHeikinAshi.test.tsx 2>&1 | cat
```

期望：PASS（14 条）。**这四条任何一条红都说明边界漏了**，红在 `h.list` 引用变化＝某处把 dataList 摊平了；红在 `overrideOverlay`＝切换处不该重锚画线。修实现，不修期望。

- [ ] **Step 3: 变异探针（判据是不是活的）**

依次把每处「实现」毒一次，每毒一次跑一次测试，跑完立刻还原。三根针：

```
# 针 A：draw 改成返回 false（库会把默认图元再画一遍）
#   heikinAshiChart.ts: `  return true;` → `  return false;`
cd frontend && npx vitest run src/lib/__tests__/heikinAshiChart.test.ts 2>&1 | cat
# 期望：红在「返回 true —— 这是整体接管绘制的判据」

# 针 B：九色少推一个键（露出半根真蜡烛）
#   CANDLE_HIDDEN 里删掉 `noChangeWickColor`
cd frontend && npx vitest run src/lib/__tests__/heikinAshiChart.test.ts 2>&1 | cat
# 期望：红在「恰好九个键」那条

# 针 C：像素混进 result
#   heikinAshi.ts 的正常分支里加 `bodyTop: 0`
cd frontend && npx vitest run src/lib/__tests__/heikinAshi.test.ts src/lib/__tests__/heikinAshiChart.test.ts 2>&1 | cat
# 期望：两个文件都红在白名单键那条

# 针 D：主题 effect 漏掉 haOn
#   ProChart.tsx: `}, [dark, timeShare, legend, haOn]);` → `}, [dark, timeShare, legend]);`
cd frontend && npx vitest run src/pages/__tests__/ProChartHeikinAshi.test.tsx 2>&1 | cat
# 期望：红在「开着 HA 切主题」
```

还原用 `git checkout -- <path>` **只在树干净时安全**；本仓脏树是常态，改用 Edit 手工还原并 `git diff --stat` 确认改动面为空（记忆 `verify-mutation-probe-blindness` 记着这条纪律）。四根针的判定结果（哪条红、红的消息原文一行）逐条记进台账。

- [ ] **Step 4: 全量门禁**

```
cd frontend && npx tsc --noEmit -p tsconfig.json; echo "tsc rc=$?"
npx vitest run 2>&1 | tail -30
npm run build 2>&1 | tail -15
```

期望：`tsc rc=0`；vitest `Test Files ... passed`、0 failed；build 以 `✓ built` 收尾。把三条的读数原文抄进台账（不许写「全绿」两个字交差）。

```
cd /e/Vibe-Trading-main/Vibe-Trading-main
python -X utf8 -m pytest tools/test_wiki_drift.py -q 2>&1 | tail -5
bash tools/wiki_freshness_gate.sh 2>&1 | tail -12
bash tools/ci_grep_gates.sh 2>&1 | tail -12
```

期望：wiki 套件全部 pass/skip、0 fail。后两条是**本地恒红门**：交付前必须证本片 0 贡献——

```
git diff --name-only main...HEAD | cat                      # 只该有 heikinAshi*、ProChart.tsx、两个测试、spec/plan
git diff main...HEAD -- repowiki | wc -l                     # 期望 0（本片没动档案）
grep -c "verified_at" <(git diff main...HEAD)               # 期望 0
```

三个读数进台账；水位门超阈值与 grep 门命中若与这三条读数矛盾，先重跑再说。

- [ ] **Step 5: 提交（若 Step 1–4 暴露了实现缺陷）**

```
git status --porcelain | head
git add -- frontend/src/pages/__tests__/ProChartHeikinAshi.test.tsx frontend/src/lib/heikinAshiChart.ts
git commit -s -m "$(cat <<'EOF'
test(heikinAshi): 真值边界钉——数据面引用不变、画线通道未被触碰

spec §五 那条「HA 改像素不改数据」要能被测试判，否则只是文案。dataList 断的是同一个
引用（连 map 出来的副本都不许有），画线那条 overrideOverlay 一路单独记道，
指标图例规则仍由图例偏好那一棵子树说话。
EOF
)" -- frontend/src/pages/__tests__/ProChartHeikinAshi.test.tsx
```

（若 Step 1–4 没有暴露缺陷，这一笔只提交测试文件；pathspec 里就别带 `heikinAshiChart.ts`。）

---

## Task 6: 浏览器活体验收＋Bar Replay 五步未来函数自查

**Files:**
- 无源码改动；发现缺陷才改，改动另起一笔

**前置**：后端 8000 与前端 5899。`vite` 只监听 `[::1]` ⇒ 必须用 `http://localhost:5899`，写 `127.0.0.1` 连不上。

- [ ] **Step 1: 起服务**

```
cd /e/Vibe-Trading-main/Vibe-Trading-main && (curl -s -o /dev/null -w "backend %{http_code}\n" http://localhost:8000/docs || true)
cd frontend && npx vite --port 5899
```

后端没起来就报告「活体验收只能覆盖渲染，取数那一腿由既有测试覆盖」，不要静默跳这一项。

- [ ] **Step 2: 开页并记录基线截图**

用 browser-use：`navigate_page` → `http://localhost:5899/pro-chart`，等 K 线出来，`take_screenshot` 存 `.superpowers/tmp/ha-01-candles.png`。判据：红涨绿跌的真实蜡烛，按钮条上「平均K线」是未按下态（`aria-pressed="false"`）。

- [ ] **Step 3: 开 HA，逐条判**

`take_snapshot` 拿按钮 ref → `click` → `wait_for` → `take_screenshot` 存 `.superpowers/tmp/ha-02-heikinashi.png`。四条都要看到：

1. 主图实体形状**变了**（对比两张图：连续同色段更多、单根噪音段被抹平），且实体与网格线/十字光标**逐像素对齐**（没有整体左右偏半根）；
2. 左上角蜡烛图例的 开/高/低/收 **仍是真实价**（把光标移到某根上，读数与 `evaluate_script` 里 `window` 无关——直接肉眼对比第 2 步那张图同一根的读数）；
3. 主图多出一行「平均K线」，四个值随光标换根而变；
4. y 轴标尺把最高/最低的**那根 HA 实体**包住了（不被裁顶）。若这一屏没有缺口样本，用 `evaluate_script` 在 console 里造不出来，就翻一段跳空缺口（如 `.SH` 日线跌停次日）再判——这一条正是 spec §二·4 的轴折叠存在的理由，**判不了要写「未判」而不是「已判」**。

- [ ] **Step 4: 切主题、切分时、来回切换**

```
document.documentElement.classList.add('dark')   // 或点主题按钮
```

判：切主题后仍是 HA（九色仍透明、那一行图例还在）；进分时 → 变面积线且 HA 那行消失；回 K 线 → HA 自动回来。刷新一次 → HA 还在（偏好落盘）。截图 `ha-03-theme.png`／`ha-04-timeshare.png`／`ha-05-back.png`。

- [ ] **Step 5: 画线不漂移**

关掉 HA（回到真蜡烛）→ 在某一根的高点画一条水平线 → 开 HA → 线的 y 位置**不动**（线锚在真实价位上）→ 十字光标移到线上，落点仍吸到那根的真实 OHLC。再画一条趋势线，开关 HA 各一次，确认 `pro-chart.drawings.*` 没被写入（`evaluate_script` 读 `localStorage` 键值前后 JSON 相同）。

- [ ] **Step 6: Bar Replay 五步自查（spec §八，交付必附）**

1. 进 Bar Replay，游标停在第 k 根，记录最后一根 HA 实体的四价读数（截图 `ha-06-replay-k.png`）；
2. 手动前进到 k+1，确认第 k 根的 HA 实体**形状与颜色都不再变**；
3. 跳到末尾，退出回放，确认全量视图里第 k 根与步骤 1 看到的完全一致（前缀==全量的活体面）；
4. 开着 HA 反复进出回放各一次，确认没有出现「之前画在将来区、退出后才消失」的图元；
5. 附 Task 1 那条前缀不变量测试的输出（`npx vitest run src/lib/__tests__/heikinAshi.test.ts` 的 40 个探针计数行）作为可复算的证据。

第 2 步是「重绘」缺陷唯一的活体判据：**没做到就写未做到**。

- [ ] **Step 7: 记台账**

把 Step 2–6 每条判据的**实际观察**（含截图路径与看到的数值）写进 `.superpowers/sdd/2026-10-08-heikin-ashi/progress.md`。

---

## Task 7: 落档 §7.18＋记忆更正＋整支评审

**Files:**
- Modify: `repowiki/项目档案.md`（追加 §7.18）
- Modify: 记忆 `chart-klinecharts-indicator-draw-and-axis.md` 与 `MEMORY.md` 索引行

- [ ] **Step 1: 写 §7.18**

`repowiki/项目档案.md` 是**纯 CRLF** 工作树（记忆 `ops-repo-wiki-git-root-and-update` 记着：要在 bytes 层追加，不能 `Read`→`Write` 整档重写）。追加内容包含且不限于：

- 标题：`### 7.18 推荐清单第④片：Heikin-Ashi 显示层（分支 feat/heikin-ashi）`
- 判据：三条库通道（`draw` 返回 true 接管绘制／`figures[].key` 折轴／`candle.bar` 九色藏真蜡烛）与各自的 dist 坐标；`correction = gapBar % 2 === 0 ? 1 : 0` 这条**与直觉相反**的细节；`indicator.lastValueMark.show` 出厂是 `false`，所以两键 figure 不会在价格轴上多挂两个 HA 值标签（本片不需要为此写样式）。
- 边界：HA 只改像素；图例／磁吸／画线／Pine／priceMark 全读真实价；分时强制关；不进分享码。
- 数字：Task 5 四根变异探针的判定结果、六道门的读数、活体验收四张截图的路径与观察。
- 下一步：⑤ VPVR（走 overlay 七类图元通道，`registerFigure` 是公开口）。

**不要在档案里加总本片笔数**，也不要写「本文件 N 行／HEAD=x」这类自指读数（记忆 `verify-self-referential-doc-readings`）。

- [ ] **Step 2: 复跑档案相关的两道门**

```
cd /e/Vibe-Trading-main/Vibe-Trading-main
python -X utf8 -m pytest tools/test_wiki_drift.py -q 2>&1 | tail -5
bash tools/wiki_freshness_gate.sh 2>&1 | tail -8
```

改了被跟踪的 `repowiki/` ⇒ 守卫套件会读它，必须复跑（交付态复跑只落台账，别把读数写回档案正文）。

- [ ] **Step 3: 提交并（经确认后）合回 main**

```
git add -- repowiki/项目档案.md
git commit -s -m "docs(archive): §7.18 第④片 Heikin-Ashi 显示层落档" -- repowiki/项目档案.md
git log --oneline main..HEAD | cat
```

`git diff | grep -c verified_at` 必须 0（档案那一轮一节不动元数据）。合并与推送属于跨分支动作：先报告分支上的提交清单，再按用户既有授权推进并逐笔说明。

- [ ] **Step 4: 记忆更正**

`projects/…/memory/chart-klinecharts-indicator-draw-and-axis.md` 要改两处、加一条：

1. 第 7 节把 `correction` 写成 `% 2 === 1 ? 1 : 0` 的话**改成** `% 2 === 0 ? 1 : 0`（本轮重读 `dist:6568` 得到的），并把「十个色键／六个色键」统一为**九个**（已在上一轮修正，检查是否仍一致）；
2. 新增一条：`indicator.lastValueMark.show` 出厂 `false`（`dist:11598`），所以「把变换值挂 figure key 上会在价格轴多两个标签」这条担忧在默认样式下不成立；一旦将来打开它，价格轴会出现 HA 高低标签，真值边界要重判；
3. `createTooltipDataSource` 返回的 `legends` **整段替换** figures 生成的默认行（`dist:7241-7334`），所以「行数由这一支决定，不由 figures 决定」——这条是 5b 那两条推论的机制来源。

索引行 `MEMORY.md` 同步改钩子。

- [ ] **Step 5: 最终整支评审**

按 `superpowers:subagent-driven-development` 的收尾：生成 `main...feat/heikin-ashi` 的 review package（`git log --oneline` + `git diff --stat` + `git diff -U10`，逐段落进一个 uniquely-named 文件），派一位评审席， inputs＝brief（本计划文件）＋spec＋review package＋Global Constraints。评审发现按 skill 的循环处理（≤3 轮 resume 原实现席，≥4 轮换更强力模型），load-bearing 缺陷修完才算完。评审席的 scratch 中间件不作证据（记忆 `verify-subagent-scratch-artifacts-not-evidence`）。

- [ ] **Step 6: 输出最终报告（中文）**

必须含：三条库通道的坐标证据、四根变异探针的判定、六道门读数、活体验收四张截图与观察、五步未来函数自查结果、明确未做的事（Pine `ta.heikinashi()`、`/multi-chart` 格子、VPVR）、以及分支/合并/推送的提交号。
