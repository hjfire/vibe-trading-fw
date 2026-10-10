# 第⑥片 多标的叠加对比（Compare）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `/pro-chart` 上把第二个标的的收盘价按时间戳对齐叠到主图蜡烛 pane 上，走它自己那根右侧 y 轴，不进主图价格轴。

**Architecture:** 三件套——`lib/symbolCompare.ts`（纯对齐，ffill-not-bfill，缺口交 `null`）、`lib/symbolCompareChart.ts`（库绑定面：注册 `SYMBOL_COMPARE` 指标 + 偏好读写 + 会话级 store）、`pages/ProChart.tsx`（取数 effect、`syncCompare` 挂卸、工具栏输入框＋开关）。通道是 `createIndicator({paneId, yAxisId}, true)` 的公开多轴通道：库自己把那根轴建出来（非 manual），删指标顺手回收它。

**Tech Stack:** React 18 + TypeScript + klinecharts@10.0.3（未打补丁）+ Vitest/jsdom + Tailwind 类名字符串。

**Spec:** `docs/superpowers/specs/2026-10-10-symbol-compare-design.md` —— 本计划从它论证；任何冲突按「spec 是权威、计划是它的论证」裁定，并在计划里就地登记。

## Global Constraints

逐条约束每一个任务（值取自 spec，勿改写）：

- 不新增依赖；不 patch 库；不新增环境变量；不新增 locale 键；**不写任何样式键**、不碰 `chartStyles` 合成点；不动 `/multi-chart`／`ChartCell.tsx`；不动后端一行。
- 文案硬编码中文。按钮 `title` 五支的**字面量与判别顺序**是 spec §七 的定稿，逐字照抄，不许"顺手改得更准"。
- 交易指标禁用未来函数：只用已收盘数据、信号不重绘；交付必附 Bar Replay 五步自查。
- 时间戳一律**毫秒**。
- 不为不可达场景加校验（spec §三 末条、§四 第二格都按这条裁掉过分支，别再长回来）。
- 替身只交实现**真被读的那几格**；替身必须建模副作用（`createIndicator` 影响指标表与轴表），否则计数针结构性不可红。
- 判据按**条目名**引用（「§十·②b 重挂面」），不要在测试或注释里钉本计划的行号；基线数（测试条数、门计数）由执行席当场测，不引用本文档数字。
- 提交一律 `git commit -s`（DCO）＋**显式 pathspec**，并且**永远先 `git add -- <同一批显式路径>` 再 commit**：`git commit -- <path>` 只对**已跟踪**文件生效，本片前三个任务交付的都是新建文件，不 `git add` 会得到 `pathspec ... did not match any file(s) known to git`。pathspec 要保留是因为裸 `git commit` 会吞掉并发写手 staged 的面。`docs/` 被 `.gitignore` 忽略 ⇒ 新档案要 `git add -f`，已跟踪的档案用 `git commit -m ... -- <path>`。
- 树上另有三个并发写手的脏文件（`frontend/public/usage-guide.md`、`frontend/src/lib/__tests__/chartDrawings.test.ts`、`frontend/src/lib/chartDrawings.ts`）：**不碰、不 stash、不 commit**，一切提交带 pathspec。
- 门禁：`cd frontend && npx tsc --noEmit -p tsconfig.json`、`npx vitest run`（全量）、`npx vite build` 三者 rc=0；`cd` 仓库根后 `python -X utf8 -m pytest tools/test_wiki_drift.py -q`；`bash tools/ci_grep_gates.sh`。两道本地恒红门（wiki 水位门、grep 门 b）**先证本片贡献归属再报告，不许调阈值、不许改档案让门变绿**。新写的一切件不复述门自己打印的那句 FAIL 文案。
- 库坐标一律指 `frontend/node_modules/klinecharts/dist/index.esm.js`（UMD 恒 +5，不在一句话里混用两个坐标）。

---

## File Structure

| 文件 | 动作 | 责任 |
|---|---|---|
| `frontend/src/lib/symbolCompare.ts` | 新建 | 唯一的纯函数：把对比序列的 close 按时间戳对齐到主图时间轴（spec §三） |
| `frontend/src/lib/__tests__/symbolCompare.test.ts` | 新建 | §十·② 纯函数面（手算向量＋前缀不变量＋三根毒针） |
| `frontend/src/lib/symbolCompareChart.ts` | 新建 | 库绑定面：常量、`compareActive`、偏好读写、会话级 store、`registerIndicator`（spec §四、§二·7/8） |
| `frontend/src/lib/__tests__/symbolCompareChart.test.ts` | 新建 | §十·① 声明面（含 `figures[0].type` 逐字钉）＋谓词真值表＋偏好＋store |
| `frontend/src/pages/ProChart.tsx` | 修改 | 取数 effect、`syncCompare`、挂卸 effect、`clickCompare`、工具栏输入框＋按钮＋来源小字（spec §五/§六/§七） |
| `frontend/src/pages/__tests__/ProChartCompare.test.tsx` | 新建 | §十·②b 重挂面、③ 卸载面、⑥ 文案面＋共挂/分时/空图/StrictMode 回归 |
| `repowiki/项目档案.md` | 修改（T6） | §7.20 落档（CRLF ⇒ bytes 层追加） |

任务切分依据：T1/T2 各自是可独立评审的纯件（无页面耦合），T3 是唯一碰页面的件（三处接线互相依赖、拆开会留下半成品），T4 是「证明 T1–T3 的针真有牙＋全量门禁」的验收件，T5 是只有活体能答的判据，T6 是档案与记忆。

---

### Task 1: `lib/symbolCompare.ts` —— 时间戳对齐纯函数

**Files:**
- Create: `frontend/src/lib/symbolCompare.ts`
- Test: `frontend/src/lib/__tests__/symbolCompare.test.ts`

**Interfaces:**
- Consumes: 无（本片第一个文件，不 import 仓内任何东西）
- Produces:
  - `export interface CompareBar { timestamp: number; close: number }`
  - `export function alignCloseToTimestamps(mainTimestamps: readonly number[], compare: readonly CompareBar[]): (number | null)[]`
  - 语义（spec §三）：第 `i` 项 = 对比序列里**最后一个 `timestamp <= mainTimestamps[i]`** 的根的 `close`；连最早那根都比它晚 ⇒ `null`。输出长度恒等于 `mainTimestamps.length`。

- [ ] **Step 1: 写失败的测试**

新建 `frontend/src/lib/__tests__/symbolCompare.test.ts`。样本域用日线钟点（`1_700_000_000_000` 起、步长 `86_400_000`），期望值全部可手算——不要为了「好写」改成随机数或小时步长，那会让前缀不变量那条针读不出 carry 语义。

```ts
import { describe, expect, it } from "vitest";

import { alignCloseToTimestamps, type CompareBar } from "../symbolCompare";

/**
 * 第⑥片（多标的叠加对比）的纯对齐面（spec §三）。
 *
 * 域钉成「日线钟点」是有原因的：主图与对比标的都是日线时，时间戳是交易日标签的
 * naive 午夜（`agent/src/api/market_routes.py` 的 `_bars_from_frame`，spec §一 引过），
 * 所以「主图第 i 根 vs 对比第 j 根」的所有形状都能用 `D(k)` 手写出来。
 */
const D = (i: number): number => 1_700_000_000_000 + i * 86_400_000;
const MAIN5 = [D(0), D(1), D(2), D(3), D(4)];

const bar = (i: number, close: number): CompareBar => ({ timestamp: D(i), close });

describe("alignCloseToTimestamps", () => {
  it("carry-forward：缺口取上一个已知价，绝不取后一个", () => {
    // 对比只有第 1、3 两根有价：主图第 0 根早于对比首根 ⇒ null（拒绝 bfill），
    // 第 2 根 carry 第 1 根，第 4 根 carry 第 3 根。
    expect(alignCloseToTimestamps(MAIN5, [bar(1, 10), bar(3, 12)])).toEqual([null, 10, 10, 12, 12]);
  });

  it("拒绝 bfill：主图首根早于对比首根时是 null，不是第一个已知值", () => {
    expect(alignCloseToTimestamps([D(0)], [bar(2, 5)])).toEqual([null]);
    expect(alignCloseToTimestamps(MAIN5, [bar(3, 7)])).toEqual([null, null, null, 7, 7]);
  });

  it("并列取等号那侧（`<=` 而非 `<`）", () => {
    // 主图第 2 根与对比第 2 根时间戳**完全相等** ⇒ 必须取到 7。
    // 把实现里的 `<=` 改成 `<` 这一条就红——那正是 §十·② 的第一根毒针。
    expect(alignCloseToTimestamps([D(2)], [bar(2, 7)])).toEqual([7]);
  });

  it("坏值整根跳过：0／负数／NaN 都不进游标，后面的好价格不被截断", () => {
    // §三 的判据是「非有限**或**非正」两半，所以这里三种都喂：
    // 后端缺列补的是 `0`（有限！），只挡非有限的过滤器会把它原样放行。
    const series = [bar(0, 8), bar(1, 0), bar(2, Number.NaN), bar(3, -5), bar(4, 9)];
    expect(alignCloseToTimestamps(MAIN5, series)).toEqual([8, 8, 8, 8, 9]);
  });

  it("同一时间戳重复时取最后一根的价", () => {
    const dup: CompareBar[] = [
      { timestamp: D(2), close: 10 },
      { timestamp: D(2), close: 11 },
    ];
    expect(alignCloseToTimestamps([D(2), D(3)], dup)).toEqual([11, 11]);
  });

  it("两侧为空都是合法输入，长度恒等于主图长度", () => {
    expect(alignCloseToTimestamps([], [])).toEqual([]);
    expect(alignCloseToTimestamps(MAIN5, [])).toEqual([null, null, null, null, null]);
    expect(alignCloseToTimestamps([], [bar(0, 1)])).toEqual([]);
    expect(alignCloseToTimestamps(MAIN5, [bar(0, 1)])).toHaveLength(MAIN5.length);
  });

  it("前缀不变量：对任意 k，align(ts.slice(0,k)) === align(ts).slice(0,k)", () => {
    // 这一条就是「没有未来函数」在纯函数面的判据形态（第④片同款）。逐根独立 ⇒
    // 主图右边多了什么根，绝不改左边任何一项。
    const full = alignCloseToTimestamps(MAIN5, [bar(1, 10), bar(3, 12)]);
    for (let k = 0; k <= MAIN5.length; k++) {
      expect(alignCloseToTimestamps(MAIN5.slice(0, k), [bar(1, 10), bar(3, 12)])).toEqual(full.slice(0, k));
    }
  });

  it("主图尾部加一根不改前面任何一项（增量交付的等价形状）", () => {
    const a = alignCloseToTimestamps(MAIN5, [bar(2, 20)]);
    const b = alignCloseToTimestamps([...MAIN5, D(5), D(6)], [bar(2, 20)]);
    expect(b.slice(0, MAIN5.length)).toEqual(a);
    expect(b).toEqual([null, null, 20, 20, 20, 20, 20]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/symbolCompare.test.ts`
Expected: FAIL —— 无法解析 `../symbolCompare`（模块不存在）。把失败原文（剥 ANSI 后）抄进报告。

- [ ] **Step 3: 写最小实现**

新建 `frontend/src/lib/symbolCompare.ts`：

```ts
/**
 * 第⑥片（多标的叠加对比）唯一的纯函数：把对比标的的收盘对齐到主图时间轴。
 *
 * 口径抄后端那条已被验证过的规则，不自己发明：
 * `agent/backtest/loaders/akshare_loader.py` 的**只 ffill、拒绝 bfill**——原文理由是
 * 「a back fill would quote a bar a factor the market had not issued yet, which is the
 * future-information leak」。回填（拿右边的价填左边）在这里同样是未来函数：
 * 回放游标往前走时线会重绘。
 *
 * 停牌／休市期间线**平着走**（carry 的定义就是"最近已知价"），这是语义不是缺陷；
 * 不设"超过 N 天就断线"的参数（spec §三）。
 *
 * 输出里的 `null` 直接交给库，不需要适配层：`null` 在 `line` 图元上是双向缺口
 * 且不被桥接、不掉基线，在那根独立轴的量程上被 `isNumber` 跳过（spec §二·8）。
 * 「主图有 bar、对比还没有价」的左段因此是真的没有线。
 */
export interface CompareBar {
  timestamp: number;
  close: number;
}

/**
 * 两个入参都按时间戳升序（主图 `dataList` 天然升序；对比序列来自同一条 loader 通路）。
 *
 * `cursor` 单调右移 ⇒ O(n + m)，且**逐根独立**：第 `i` 项只读 `mainTimestamps[i]`
 * 与 `usable`，不读别的输出项。前缀不变量（§十·②）就是这条独立性的读数形态。
 *
 * 坏值判据 `Number.isFinite(close) && close > 0` 两半都不能省（spec §十二 R11）：
 * 缺列时 `marketApi.columnsToBars` 补的是 `0` 而不是 null，`0` 过得了 `isFinite`，
 * 而它在库的 `isValid`/`isNumber` 两道上都是合法数值 ⇒ 会真画出一条 0 线并把那根
 * 独立轴的量程拽到 0。「跳过」= 整根不进游标（连时间戳一起丢），**不是**「到了那根
 * 交 `null`」——后者会让一根坏 bar 把后面的好价格一起截断。
 */
export function alignCloseToTimestamps(
  mainTimestamps: readonly number[],
  compare: readonly CompareBar[],
): (number | null)[] {
  const usable = compare.filter((bar) => Number.isFinite(bar.close) && bar.close > 0);
  const out: (number | null)[] = [];
  let cursor = -1;
  for (const ts of mainTimestamps) {
    while (cursor + 1 < usable.length && usable[cursor + 1].timestamp <= ts) {
      cursor += 1;
    }
    out.push(cursor >= 0 ? usable[cursor].close : null);
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd frontend && npx vitest run src/lib/__tests__/symbolCompare.test.ts`
Expected: PASS（条数当场读，不预言；本任务 Step 1 的代码块里是 8 支 `it`）。

- [ ] **Step 5: 类型门**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.json` → rc=0。

- [ ] **Step 6: 提交**

```bash
git add -- frontend/src/lib/symbolCompare.ts frontend/src/lib/__tests__/symbolCompare.test.ts
git commit -s -m "feat(compare): lib/symbolCompare 时间戳对齐——ffill-not-bfill、坏值整根跳过、前缀不变量" -- frontend/src/lib/symbolCompare.ts frontend/src/lib/__tests__/symbolCompare.test.ts
```

---

### Task 2: `lib/symbolCompareChart.ts` —— 库绑定面（注册＋偏好＋store）

**Files:**
- Create: `frontend/src/lib/symbolCompareChart.ts`
- Test: `frontend/src/lib/__tests__/symbolCompareChart.test.ts`

**Interfaces:**
- Consumes: `alignCloseToTimestamps`、`CompareBar`（Task 1 的逐字签名）
- Produces（Task 3 全靠这些名字）:
  - `SYMBOL_COMPARE_NAME = "SYMBOL_COMPARE"`、`SYMBOL_COMPARE_SHORT_NAME = "对比"`、`COMPARE_AXIS_ID = "pro-chart-compare-y"`、`COMPARE_FIGURE_KEY = "cmp"`、`COMPARE_FIGURE_TITLE = "对比收盘"`、`COMPARE_PREFS_KEY = "pro-chart.compare.v1"`、`COMPARE_BARS = 2000`
  - `compareActive(on: boolean, timeShare: boolean, ready: boolean): boolean`
  - `loadCompare(): string` / `saveCompare(symbol: string): void` / `compareKey(symbol: string, interval: string): string`
  - `setCompareSeries(key: string, bars: readonly CompareBar[]): void` / `getCompareSeries(key: string): readonly CompareBar[]` / `clearCompareSeries(): void` / `setActiveCompareKey(key: string): void`
  - `compareRows(mainTimestamps: readonly number[], series: readonly CompareBar[]): CompareRow[]`、`export interface`-等价的 `CompareRow`
  - `ensureCompareIndicator(): void`

- [ ] **Step 1: 写失败的测试**

新建 `frontend/src/lib/__tests__/symbolCompareChart.test.ts`。桩的形状照 `lib/__tests__/vpvrChart.test.ts:6-13`（`registerIndicator` 改的是全局表 ⇒ 桩掉它、把注册对象抓下来逐键判）。

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

// 同 `vpvrChart.test.ts` 的理由：`registerIndicator` 改的是库的全局表，桩掉它既不让真库
// 起来，又能把注册对象抓下来逐键判。
const registered: Array<Record<string, unknown>> = [];
vi.mock("klinecharts", () => ({
  registerIndicator: (spec: Record<string, unknown>) => registered.push(spec),
}));

import {
  COMPARE_AXIS_ID,
  COMPARE_BARS,
  COMPARE_FIGURE_KEY,
  COMPARE_FIGURE_TITLE,
  COMPARE_PREFS_KEY,
  SYMBOL_COMPARE_NAME,
  SYMBOL_COMPARE_SHORT_NAME,
  compareActive,
  compareKey,
  compareRows,
  ensureCompareIndicator,
  getCompareSeries,
  clearCompareSeries,
  loadCompare,
  saveCompare,
  setActiveCompareKey,
  setCompareSeries,
} from "../symbolCompareChart";
import type { CompareBar } from "../symbolCompare";

const D = (i: number): number => 1_700_000_000_000 + i * 86_400_000;
const bar = (i: number, close: number): CompareBar => ({ timestamp: D(i), close });

/**
 * 调用点自足（照第⑤片）：`registered` 是 `vi.mock` 里的模块级数组，用例之间不重置，
 * 谁先跑谁注册。让 `spec()` 自己走一遍幂等守卫，「上一条测试有没有先跑」就不是判据的一部分。
 */
function spec(): Record<string, unknown> {
  ensureCompareIndicator();
  expect(registered).toHaveLength(1);
  return registered[0];
}

beforeEach(() => {
  localStorage.clear();
  clearCompareSeries();
  setActiveCompareKey("");
});

describe("常量与偏好键", () => {
  it("七枚常量逐字钉（它们是页面、测试与库三方共用的唯一权威）", () => {
    expect(SYMBOL_COMPARE_NAME).toBe("SYMBOL_COMPARE");
    expect(SYMBOL_COMPARE_SHORT_NAME).toBe("对比");
    expect(COMPARE_AXIS_ID).toBe("pro-chart-compare-y");
    expect(COMPARE_FIGURE_KEY).toBe("cmp");
    expect(COMPARE_FIGURE_TITLE).toBe("对比收盘");
    expect(COMPARE_PREFS_KEY).toBe("pro-chart.compare.v1");
    expect(COMPARE_BARS).toBe(2000);
  });

  it("compareKey 将标的与周期拼成一个键（键含周期不含主标的）", () => {
    expect(compareKey("600036.SH", "1D")).toBe("600036.SH|1D");
  });

  it("loadCompare 缺键读空串，存的串原样读回（值就是已应用标的）", () => {
    expect(loadCompare()).toBe("");
    localStorage.setItem(COMPARE_PREFS_KEY, "600036.SH");
    expect(loadCompare()).toBe("600036.SH");
  });

  it("saveCompare(\"\") 删键而不是写空串（未偏离默认不落盘）", () => {
    saveCompare("600036.SH");
    expect(localStorage.getItem(COMPARE_PREFS_KEY)).toBe("600036.SH");
    saveCompare("");
    expect(localStorage.getItem(COMPARE_PREFS_KEY)).toBeNull();
  });

  it("storage 被禁时读成空串、写时不抛（两个 catch 分支各有输入）", () => {
    // idiom 照 `vpvrChart.test.ts` 里那两条（`vi.spyOn(Storage.prototype, …)`），
    // 收尾靠 vitest 配置里的 `restoreMocks: true`，不手写 finally。
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(loadCompare()).toBe("");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(() => saveCompare("600036.SH")).not.toThrow();
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(() => saveCompare("")).not.toThrow();
  });
});

describe("视图谓词", () => {
  it("compareActive 的八行真值表：分时与未就绪都能单独压掉", () => {
    expect(compareActive(true, false, true)).toBe(true);
    expect(compareActive(true, false, false)).toBe(false);
    expect(compareActive(true, true, true)).toBe(false);
    expect(compareActive(true, true, false)).toBe(false);
    expect(compareActive(false, false, true)).toBe(false);
    expect(compareActive(false, false, false)).toBe(false);
    expect(compareActive(false, true, true)).toBe(false);
    expect(compareActive(false, true, false)).toBe(false);
  });
});

describe("store 与行形状", () => {
  it("未知键交出空数组（不是 undefined——calc 那一路要直接 .filter/.map）", () => {
    expect(getCompareSeries("NOPE|1D")).toEqual([]);
  });

  it("clearCompareSeries 把桶清空", () => {
    setCompareSeries("600036.SH|1D", [bar(0, 10)]);
    expect(getCompareSeries("600036.SH|1D")).toEqual([{ timestamp: D(0), close: 10 }]);
    clearCompareSeries();
    expect(getCompareSeries("600036.SH|1D")).toEqual([]);
  });

  it("compareRows 行数恒等于主图长度，缺口是 null 不是 0", () => {
    const rows = compareRows([D(0), D(1), D(2)], [bar(1, 7)]);
    expect(rows).toHaveLength(3);
    expect(rows).toEqual([{ cmp: null }, { cmp: 7 }, { cmp: 7 }]);
  });
});

describe("注册守卫与声明", () => {
  it("重复调用只注册一次", () => {
    ensureCompareIndicator();
    const after = registered.length;
    ensureCompareIndicator();
    ensureCompareIndicator();
    expect(registered).toHaveLength(after);
  });

  it("figures 恰一条且 `type` 逐字是 line（§十·① 那根唯一的牙）", () => {
    const s = spec();
    const figures = s.figures as Array<Record<string, unknown>>;
    expect(figures).toHaveLength(1);
    expect(figures[0].key).toBe(COMPARE_FIGURE_KEY);
    expect(figures[0].title).toBe(COMPARE_FIGURE_TITLE);
    // `prepareIndicatorFigures` 用 `isValid(figure.type)` 决定这条 figure 进不进渲染清单
    // （`index.esm.js:3128`）⇒ 省略 `type` 会得到一条**静默不画**的线，而且图例行也一起没了，
    // 这种失效在 jsdom 与活体像素上都读不出来，只能钉声明。
    expect(figures[0].type).toBe("line");
    // 不写 `styles`：本片零样式键（Global Constraints），指标样式桶那一格由库的默认值管。
    expect("styles" in (figures[0] as Record<string, unknown>)).toBe(false);
  });

  it("其余声明逐格钉，且不声明 draw／tooltip／轴", () => {
    const s = spec();
    expect(s.name).toBe(SYMBOL_COMPARE_NAME);
    expect(s.shortName).toBe(SYMBOL_COMPARE_SHORT_NAME);
    expect(s.series).toBe("price");
    expect(s.precision).toBe(2);
    expect(s.shouldOhlc).toBe(false);
    // 图例走库自己的 figures 通道（`index.esm.js:7272-7285`，`isString(figure.title)` 才 push），
    // 自己写 draw／createTooltipDataSource 就是第二条权威。
    expect("draw" in s).toBe(false);
    expect("createTooltipDataSource" in s).toBe(false);
    // 轴归属**只能在创建时定**：注册面 `IndicatorTemplate` 把 `paneId`/`yAxisId` Omit 掉了
    // （`index.d.ts:870`）。这一格是「别顺手在注册里写轴」的门。
    expect("yAxisId" in s).toBe(false);
    expect("paneId" in s).toBe(false);
    // 这两格与上面两格不同：`IndicatorTemplate` 只 Omit 了 `result|paneId|yAxisId`
    // （`index.d.ts:870`），`styles`（`:844`）与 `calcParams` **没被 Omit** ⇒ 在注册里写样式
    // 或写参数能过 `tsc`。Global Constraints 那两条（不写任何样式键／`calc` 不走 `calcParams`）
    // 只有在这里落针才是机器门，否则就只是注释。
    expect("styles" in s).toBe(false);
    expect("calcParams" in s).toBe(false);
    expect(typeof s.calc).toBe("function");
  });

  it("calc 读 activeKey 那一条序列，行数与主图对齐", () => {
    ensureCompareIndicator();
    const key = compareKey("600036.SH", "1D");
    setCompareSeries(key, [bar(1, 10), bar(3, 12)]);
    setActiveCompareKey(key);
    const calc = spec().calc as (d: Array<{ timestamp: number }>) => Array<Record<string, unknown>>;
    const dataList = [0, 1, 2, 3, 4].map((i) => ({ timestamp: D(i) }));
    expect(calc(dataList)).toEqual([
      { cmp: null },
      { cmp: 10 },
      { cmp: 10 },
      { cmp: 12 },
      { cmp: 12 },
    ]);
    // 阳性对照（本仓登记的假绿第一种）：换了空序列后同一条 calc 必须交出全 null，
    // 否则「calc 真读了 store」这件事没被证明——写死返回值也能过上一条。
    setActiveCompareKey(compareKey("BTC-USDT", "1D"));
    expect(calc(dataList)).toEqual([
      { cmp: null },
      { cmp: null },
      { cmp: null },
      { cmp: null },
      { cmp: null },
    ]);
  });

  it("分页加根后同一份 store 重新算出更长的行（§四 那条「必须算在 calc 里」）", () => {
    ensureCompareIndicator();
    const key = compareKey("600036.SH", "1D");
    setCompareSeries(key, [bar(1, 10)]);
    setActiveCompareKey(key);
    const calc = spec().calc as (d: Array<{ timestamp: number }>) => Array<Record<string, unknown>>;
    const three = calc([0, 1, 2].map((i) => ({ timestamp: D(i) })));
    const five = calc([0, 1, 2, 3, 4].map((i) => ({ timestamp: D(i) })));
    expect(three).toHaveLength(3);
    expect(five).toHaveLength(5);
    expect(five.slice(0, 3)).toEqual(three);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/symbolCompareChart.test.ts`
Expected: FAIL —— 无法解析 `../symbolCompareChart`。原文抄进报告。

- [ ] **Step 3: 写最小实现**

新建 `frontend/src/lib/symbolCompareChart.ts`：

```ts
import { registerIndicator, type KLineData } from "klinecharts";

import { alignCloseToTimestamps, type CompareBar } from "./symbolCompare";

/**
 * 多标的叠加对比的库绑定面（第⑥片，spec §四）。
 *
 * 通道是 `createIndicator({paneId, yAxisId}, true)` 的**公开多轴通道**，不是第⑤片那条
 * `draw` 自绘：`ChartImp.createIndicator` 尊重调用方给的 `yAxisId`（`index.esm.js:15273`），
 * 随后 `_createOrUseIndicatorYAxis`（`index.esm.js:15241`）把不存在的轴**自己建出来**，
 * 走这条路的轴不是 manual ⇒ `_shouldUseCandleData()` 为假（`index.esm.js:980-983`），
 * 它不折主图蜡烛的 high/low，量程只由绑在它上面的 figure 数值决定。
 *
 * 三件承重的事：
 *
 * 1. **绝不 `createYAxis`**：`ChartImp.createYAxis` 会把轴标成 manual（`index.esm.js:15483`），
 *    而 manual 轴对 `_shouldUseCandleData()` 为真 ⇒ 一把刚建出来、还没挂指标的空尺会先把
 *    主图蜡烛撑进自己的量程；孤儿回收又正好跳过 manual（`index.esm.js:15234`）⇒ 切走对比会**漏一根轴**。
 * 2. **「不进主图价格轴」是结构保证而不是约定**：轴取数的唯一口径 `_getIndicatorsByYAxisIds()`
 *    的判据集合以本轴 id 起步，**只有本轴是 manual 时**才并上默认轴 id（`index.esm.js:967-973`，
 *    过滤那行在 `:978`）⇒ 非 manual 的轴只认自己的 id，我们那条自定义 id 不在主图轴的集合里，
 *    主图轴量程**不可能**被对比序列撑开。这就是不走 `draw` 自绘的全部理由——自绘会把这件事
 *    退化成"我们自己不去读那把尺"。
 * 3. **卸载即自动回收**：`ChartImp.removeIndicator` 在真删掉东西时调 `_removeOrphanYAxes()`
 *    （`index.esm.js:15327`），非 manual、无指标绑定的轴被删 ⇒ 本页不拥有轴的生命周期。
 *
 * `figures[0].type: "line"` 是**承重声明不是样式**：`prepareIndicatorFigures` 用
 * `isValid(figure.type)` 决定 figure 进不进渲染清单（`index.esm.js:3128`），省略它就得到
 * 一条静默不画的线，而图例行也一起消失（`IndicatorTooltipView` 遍历的是同一份产物，
 * `index.esm.js:7272-7273`）。缺口的形状交给库的 `null` 语义（spec §二·8）：`null` 被
 * `isValid`（`:8095`）与 `isNumber`（`:8084-8091`）双双挡下 ⇒ 既不断到基线，也不进 min/max。
 */

export const SYMBOL_COMPARE_NAME = "SYMBOL_COMPARE";
export const SYMBOL_COMPARE_SHORT_NAME = "对比";

/** 自定义轴 id。**必须**是稳定字面量：`_createOrUseIndicatorYAxis` 按 id 找轴复用（`index.esm.js:15241-15245`），换个 id 就是每次挂载多铸一根尺；值由测试逐字钉住，改名会被读出来。 */
export const COMPARE_AXIS_ID = "pro-chart-compare-y";

export const COMPARE_FIGURE_KEY = "cmp";
export const COMPARE_FIGURE_TITLE = "对比收盘";

/** 布尔偏好的最省键形的**串版**：值就是已应用的对比标的，缺键即关（spec §十二 R9）。 */
export const COMPARE_PREFS_KEY = "pro-chart.compare.v1";

/**
 * 一次取满的深度上限。后端把 `countback` **静默钳**到 `_MAX_BARS = 2000`
 * （`agent/src/api/udf_routes.py:473-474`、`agent/src/api/market_routes.py:52`），
 * 传更大值只会得到 2000 且不回传截断标记（代价登记在 spec §十一·5）。
 */
export const COMPARE_BARS = 2000;

/** 一行的产物形状：只有一个键，键名就是 `COMPARE_FIGURE_KEY`。 */
export type CompareRow = { [key in typeof COMPARE_FIGURE_KEY]: number | null };

/**
 * 单一谓词：页面挂卸侧、`aria-pressed` 与 className 都读它，不再各写一遍
 * （形状照第⑤片 `vpvrActive`，但多第三格 `ready`）。
 * 分时是单日的分钟线，分钟时间戳跨市场不可比（spec §六 那两条钟点表项证据）；
 * `ready` 为假说的是「store 里还没有这条序列」，那时挂上去就是一条永远不存在的线（R10）。
 */
export function compareActive(on: boolean, timeShare: boolean, ready: boolean): boolean {
  return on && !timeShare && ready;
}

/** 缺键或 storage 抛 ⇒ 空串；存进去的串原样读回（不校验标的格式，那是取数侧的事）。 */
export function loadCompare(): string {
  try {
    return localStorage.getItem(COMPARE_PREFS_KEY) ?? "";
  } catch {
    return "";
  }
}

/** 未偏离默认不落盘：空标的**删键**，不写空串（第⑤片 `saveVpvr` 的写侧纪律）。 */
export function saveCompare(symbol: string): void {
  try {
    if (symbol === "") localStorage.removeItem(COMPARE_PREFS_KEY);
    else localStorage.setItem(COMPARE_PREFS_KEY, symbol);
  } catch {
    /* best effort */
  }
}

/**
 * store 的键。含**对比标的**与**周期**，不含主标的——主标的换了不影响这条序列，
 * 而周期换了必须重算（对齐是按主图时间戳做的）。键由页面派生，不从 store 里反查（spec §四）。
 */
export function compareKey(symbol: string, interval: string): string {
  return `${symbol}|${interval}`;
}

/**
 * 会话级 store：`calc` 有一半输入住在这里，所以「数据到了」必须由页面推一次重挂（R10）。
 * `bars.slice()` 是为了页面后续的 `setCmpSeries` 与这里交出的不是同一可变数组。
 */
const seriesByKey = new Map<string, CompareBar[]>();
let activeKey = "";

export function setCompareSeries(key: string, bars: readonly CompareBar[]): void {
  seriesByKey.set(key, bars.slice());
}

/** 未知键交出 `[]`：`calc` 那一路要直接喂给纯函数，不接受 undefined。交出去的是内部那个数组的**只读视图**——写入侧已经 `slice()` 复制过，读取侧不再复制，但也不许调用方改它。 */
export function getCompareSeries(key: string): readonly CompareBar[] {
  return seriesByKey.get(key) ?? [];
}

/** 整桶清空。生产侧不调（见计划里 P-7 的裁定）；它的消费者是页面测试的 `beforeEach`——模块 store 跨 `render` 存活，不清就是拿上一支交付的数据当本支取到的数据。 */
export function clearCompareSeries(): void {
  seriesByKey.clear();
}

/** 挂载前由 `syncCompare` 写一次；`calc` **只读这里**，不走 `calcParams`（spec §四）。 */
export function setActiveCompareKey(key: string): void {
  activeKey = key;
}

/** 对齐结果 → 库的逐根行形状。唯一实现：`calc` 与测试都调它，各写一遍就是重复逻辑。 */
export function compareRows(
  mainTimestamps: readonly number[],
  series: readonly CompareBar[],
): CompareRow[] {
  return alignCloseToTimestamps(mainTimestamps, series).map((close) => ({
    [COMPARE_FIGURE_KEY]: close,
  }));
}

/**
 * 注册守卫：`registerIndicator` 改的是全局表。模块布尔正是
 * `ensureHeikinAshiIndicator`／`ensureVpvrIndicator` 用的同一写法。
 *
 * `precision: 2` 是**继承本页已有的那一条精度约定**（`ProChart.tsx` 写死
 * `pricePrecision: 2`，而 `_synchronizeIndicatorSeriesPrecision` 会把 `series === "price"`
 * 的指标精度覆写成它，`index.esm.js:14215-14239`），不是自造"按数据估小数位"的第二套规则
 * （spec §十二 R6）。覆写整体包在 `if (isValid(this._symbol))` 里（`:14216`）⇒ 没设标的时
 * 声明的 `precision: 2` 原样生效，这一格不是"等着被覆写的占位值"。
 * 低价标的被显示成 `0.00` 是本页出厂就有的代价（§十一·2）。
 */
let registered = false;

export function ensureCompareIndicator(): void {
  if (registered) return;
  registered = true;
  registerIndicator({
    name: SYMBOL_COMPARE_NAME,
    shortName: SYMBOL_COMPARE_SHORT_NAME,
    precision: 2,
    series: "price",
    shouldOhlc: false,
    figures: [{ key: COMPARE_FIGURE_KEY, title: COMPARE_FIGURE_TITLE, type: "line" }],
    // 对齐**必须**算在 calc 里：`StoreImp._addData` 尾部每次分页都带全量 `_dataList`
    // 重跑所有指标（`index.esm.js:13501-13506`、`_calcIndicator` 传全量 `:14145`），
    // 而 `extendData` 不参与重算判定（`shouldUpdate` 里 `calc` 只由 `calcParams`/`figures`/`calc`
    // 三件事决定，`index.esm.js:3167-3168`）。把对齐结果当外部闭包常量喂进来，滚到边界加载后必然错位。
    calc: (dataList: KLineData[]) =>
      compareRows(
        dataList.map((bar) => bar.timestamp),
        getCompareSeries(activeKey),
      ),
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd frontend && npx vitest run src/lib/__tests__/symbolCompareChart.test.ts` → 全绿，条数当场读。

- [ ] **Step 5: 类型门**

Run: `cd frontend && npx tsc --noEmit -p tsconfig.json` → rc=0。
若 `CompareRow` 的映射类型与 `registerIndicator<D>` 的推断打架，**不要**加 `as` 兜住：`IndicatorFigure.key` 在类型面就是裸 `string`（`index.d.ts:738-745`），打架说明声明写歪了，按报错改声明。

- [ ] **Step 6: 提交**

```bash
git commit -s -m "feat(compare): lib/symbolCompareChart 走公开多轴通道——注册带 type:line、会话级 store、串形偏好键" -- frontend/src/lib/symbolCompareChart.ts frontend/src/lib/__tests__/symbolCompareChart.test.ts
```

---

### Task 3: `ProChart.tsx` 接线 + `ProChartCompare.test.tsx`

**Files:**
- Modify: `frontend/src/pages/ProChart.tsx`（六处：import 块、模块级在飞集合、state 块、`syncCompare`、两个 effect、`clickCompare`、工具栏 JSX）
- Test: `frontend/src/pages/__tests__/ProChartCompare.test.tsx`

**Interfaces:**
- Consumes: Task 2 的全部导出名；页面已有的 `MAIN_PANE_ID`、`Nullable<Chart>`、`fetchKline`、`IntervalKey`、`barCount`、`timeShare`、`interval`、`status.source`、`cn`。
- Produces: 无下游（本片最后一个代码件）。

**先读再接（执行席必做的取证，不要凭本节文字下刀）**：`ProChart.tsx` 里 `syncVpvr` 的函数体、VPVR 的挂卸 effect（含那条 eslint-disable 的四条理由）、`toggleVpvr`、state 块里 `vpOn`/`vpRef` 那一格、工具栏「量分布」那颗按钮的完整 JSX、`import { ... } from "@/lib/vpvrChart"` 那一块。插入位置全部**照这些既有件的后邻**定位，别按行号定位（行号会漂）。

- [ ] **Step 1: 写失败的测试**

新建 `frontend/src/pages/__tests__/ProChartCompare.test.tsx`。harness 照抄 `__tests__/ProChartVpvr.test.tsx` 的替身（同一套 `h` 桶、`ask()`、`barOf()`、`seed()`、`flush()`、`vi.mock("@/lib/marketApi", importOriginal)`），**只加本片需要的三格**：

1. `h.axes: string[]` —— 蜡烛 pane 现存的 y 轴 id 列表，`createIndicator`/`removeIndicator` 会改它（替身必须建模副作用，本仓登记的替身失真第一种）。
2. `h.createdYAxis: unknown[]` —— `createYAxis` 的调用录制（`vi.fn` 也行；判据是「零调用」，但**必须真录**，吞掉调用就变成结构上不可红）。
3. `h.fetchCalls: Array<Record<string, unknown>>` + `h.cmpBars: CompareBar[]` —— 取数分流与在飞观察。

替身里轴的建/拆是 `_removeOrphanYAxes`（`index.esm.js:15217-15240`）的**六行镜像**，注释要写明「判的是声明与调用面，不是库」（同款口径见 `vpvrChart.test.ts` 的 `foldedPrices`）。

```tsx
import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { COMPARE_PREFS_KEY, clearCompareSeries, setActiveCompareKey } from "@/lib/symbolCompareChart";
import { HEIKIN_ASHI_PREFS_KEY } from "@/lib/heikinAshiChart";
import { VPVR_PREFS_KEY } from "@/lib/vpvrChart";
import { ProChart } from "../ProChart";

/**
 * 第⑥片（多标的叠加对比）的页面接线面（spec §十 的 ②b/③/⑥ 三条）。
 *
 * 替身的形状照 `ProChartVpvr.test.tsx`（同一套录制桶＋`ask()`＋`seed()`），本片只多三格：
 * `h.axes`（轴表，跟着 create/remove 变）、`h.createdYAxis`（`createYAxis` 的调用录制，
 * §十·① 那根"不建 manual 轴"的结构钉）、`h.fetchCalls`／`h.cmpBars`（对比取数的分流与观察）。
 * 库行号一律指 `dist/index.esm.js`（UMD 恒 +5，别在一句话里混用两个坐标）。
 */

/** 蜡烛 pane 出厂那根默认轴的 id——替身里的"默认轴"就是它，`COMPARE_AXIS_ID` 之外只有它。 */
const DEFAULT_AXIS_ID = "candle-pane-default";

const h = vi.hoisted(() => ({
  styles: [] as Array<Record<string, unknown>>,
  initStyles: [] as Array<Record<string, unknown>>,
  indicators: [] as Array<{ name: string; paneId: string; id: string; yAxisId?: string }>,
  created: [] as Array<Record<string, unknown>>,
  removed: [] as Array<{ name?: string; id?: string; paneId?: string }>,
  overridden: [] as unknown[],
  removedOverlays: [] as Array<Record<string, unknown>>,
  overlays: [] as Array<{
    id: string;
    name: string;
    paneId: string;
    points: Array<{ timestamp: number; value: number }>;
  }>,
  list: [] as Array<Record<string, unknown>>,
  resets: 0,
  loader: null as null | {
    getBars: (p: {
      type: string;
      timestamp: number | null;
      period: unknown;
      symbol: { ticker: string };
      callback: (data: unknown[], more?: unknown) => void;
    }) => void | Promise<void>;
  },
  // 本片新增的三格。
  axes: [] as string[],
  createdYAxis: [] as unknown[],
  fetchCalls: [] as Array<Record<string, unknown>>,
  cmpBars: [] as Array<{ timestamp: number; close: number }>,
  cmpError: null as string | null,
}));

function ask(): void {
  if (!h.loader) throw new Error("页面没有装 DataLoader");
  void Promise.resolve(
    h.loader.getBars({
      type: "init",
      timestamp: null,
      period: { type: "day", span: 1 },
      symbol: { ticker: "600519.SH" },
      callback: () => undefined,
    }),
  ).catch(() => undefined);
}

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

function seed(count = 6): void {
  h.list = Array.from({ length: count }, (_, i) => barOf(i));
}

const cmpCreates = () =>
  h.created.filter((c) => (c as { name?: string }).name === "SYMBOL_COMPARE");
const cmpLive = () => h.indicators.filter((i) => i.name === "SYMBOL_COMPARE");
const haLive = () => h.indicators.filter((i) => i.name === "HEIKIN_ASHI");
const vpLive = () => h.indicators.filter((i) => i.name === "VPVR");

/**
 * `ChartImp._removeOrphanYAxes` 的六行镜像（`index.esm.js:15217-15240`）：既不是默认轴、
 * 又没有指标绑着、又**不是 manual** 的轴被删。
 *
 * **判的是声明与调用面，不是库**：替身按库那条规则摊轴表，于是「页面对轴的用法」——
 * 只经 `createIndicator` 建轴、`createYAxis` 一次都不调、删指标即删轴——在本文件里读得到。
 * 把这三行抄成常量 `["candle-pane-default"]` 就等于把本片最重要的那条不变量交成空集断言
 * （本仓登记的假绿第一种）。
 */
function sweepAxes(): void {
  const used = new Set<string>([DEFAULT_AXIS_ID]);
  for (const ind of h.indicators) used.add(ind.yAxisId ?? DEFAULT_AXIS_ID);
  h.axes = h.axes.filter((id) => used.has(id));
}

vi.mock("klinecharts", () => ({
  registerIndicator: vi.fn(),
  getSupportedLocales: () => ["en-US", "zh-CN"],
  registerLocale: vi.fn(),
  dispose: vi.fn(),
  init: (_host: unknown, options?: { styles?: Record<string, unknown> }) => {
    h.initStyles.push(options?.styles ?? {});
    return {
      getSymbol: () => ({ ticker: "600519.SH", pricePrecision: 2, volumePrecision: 0 }),
      getDataList: () => h.list,
      getIndicators: (filter?: { name?: string; id?: string; paneId?: string }) =>
        h.indicators.filter((ind) => {
          if (filter?.name !== undefined && ind.name !== filter.name) return false;
          if (filter?.id !== undefined && ind.id !== filter.id) return false;
          if (filter?.paneId !== undefined && ind.paneId !== filter.paneId) return false;
          return true;
        }),
      createIndicator: (
        value: { name: string; paneId?: string; yAxisId?: string },
        isStack?: boolean,
      ) => {
        h.created.push({ ...(value as Record<string, unknown>), isStack });
        const paneId = value.paneId ?? `sub:${value.name}`;
        if (!isStack) h.indicators = h.indicators.filter((ind) => ind.paneId !== paneId);
        h.indicators.push({
          name: value.name,
          paneId,
          id: `i${h.indicators.length}`,
          // 库在 `ChartImp.createIndicator`（`index.esm.js:15273`）尊重传入的 `yAxisId`，
          // 缺省才回落到该 pane 的默认轴 id ⇒ 记的是**页面真传的那一格**。
          yAxisId: value.yAxisId ?? DEFAULT_AXIS_ID,
        });
        // `_createOrUseIndicatorYAxis`（`index.esm.js:15241-15249`）：轴不存在就建出来，
        // 且这条路径**不设 manual**。
        if (value.yAxisId && !h.axes.includes(value.yAxisId)) h.axes.push(value.yAxisId);
        return true;
      },
      removeIndicator: (filter: { name?: string; id?: string; paneId?: string }) => {
        h.removed.push({ ...filter });
        const before = h.indicators.length;
        h.indicators = h.indicators.filter(
          (ind) =>
            (filter?.name === undefined || ind.name !== filter.name) &&
            (filter?.id === undefined || ind.id !== filter.id) &&
            (filter?.paneId === undefined || ind.paneId !== filter.paneId),
        );
        // 库只在真删掉东西时才扫孤儿轴（`ChartImp.removeIndicator` 的 `if (removed)`，
        // `index.esm.js:15326`）⇒ 这里同形，否则「关掉后回到恰 1 根轴」会被一次空删也扫一遍。
        if (h.indicators.length < before) sweepAxes();
        return h.indicators.length < before;
      },
      // §十·① 的结构钉：真库 `ChartImp.createYAxis` 会给轴打 manual（`index.esm.js:15483`），
      // 而 manual 轴把主图蜡烛撑进自己的量程（`:980-983`）且不被孤儿回收（`:15234`）。
      // 页面一次都不该调它——吞掉调用（`vi.fn()` 不带录制）就等于没这根钉。
      createYAxis: (yAxis: unknown) => {
        h.createdYAxis.push(yAxis);
        return "manual-axis";
      },
      removeYAxis: () => false,
      getYAxes: (filter?: { paneId?: string; id?: string; name?: string }) =>
        h.axes
          .filter((id) => filter?.id === undefined || filter.id === id)
          .map((id) => ({ id })),
      getOverlays: () => h.overlays,
      getPaneOptions: () => [{ id: "candle_pane", height: 300, minHeight: 30, state: "normal" }],
      setPaneOptions: vi.fn(),
      setDataLoader: (loader: typeof h.loader) => {
        h.loader = loader;
      },
      setSymbol: () => ask(),
      setPeriod: () => ask(),
      resetData: () => {
        h.resets++;
        return ask();
      },
      setStyles: (s: Record<string, unknown>) => h.styles.push(s),
      resize: vi.fn(),
      createOverlay: (o: Record<string, unknown>) => {
        const id = `o${h.overlays.length + 1}`;
        h.overlays.push({ ...o, id } as unknown as (typeof h.overlays)[number]);
        return id;
      },
      removeOverlay: (filter?: Record<string, unknown>) => {
        h.removedOverlays.push(filter ?? {});
        return true;
      },
      overrideOverlay: (o: unknown) => {
        h.overridden.push(o);
        return true;
      },
      getOffsetRightDistance: () => 0,
      setOffsetRightDistance: vi.fn(),
      getBarSpace: () => ({ bar: 8, halfBar: 4, gapBar: 5, halfGapBar: 2 }),
      setBarSpace: vi.fn(),
      scrollToRealTime: vi.fn(),
      getVisibleRange: () => ({
        from: 0,
        to: h.list.length,
        realFrom: 0,
        realTo: h.list.length,
      }),
      getDom: () => undefined,
    };
  },
}));

vi.mock("@/lib/marketApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/marketApi")>();
  return {
    ...actual,
    fetchKline: async (params: Record<string, unknown>) => {
      h.fetchCalls.push(params);
      if (params.symbol === "600519.SH") {
        // 主图那一趟：`before` 为空才交全量，与第⑤片那份替身同形（分页交空数组）。
        return {
          bars: params.before == null ? h.list : [],
          source: "fake-main",
          symbol: "600519.SH",
          interval: "1D",
        };
      }
      if (h.cmpError !== null) throw new Error(h.cmpError);
      return {
        bars: h.cmpBars,
        source: "fake-cmp",
        symbol: params.symbol,
        interval: params.interval,
      };
    },
  };
});

vi.mock("@/components/charts/WatchList", () => ({ default: () => null }));
vi.mock("@/components/charts/IndicatorEditor", () => ({ default: () => null }));

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const D = (i: number): number => 1_700_000_000_000 + i * 86_400_000;

const button = () => screen.getByRole("button", { name: "对比" });
const field = () => screen.getByRole("textbox", { name: "对比标的" });

/** 把标的填进对比输入框（只填不点：`cmpInput` 与 `cmpSymbol` 的分工就是「填了」与「应用了」）。 */
function typeCompare(symbol: string): void {
  fireEvent.change(field(), { target: { value: symbol } });
}

beforeEach(() => {
  h.styles = [];
  h.initStyles = [];
  h.indicators = [];
  h.created = [];
  h.removed = [];
  h.overridden = [];
  h.removedOverlays = [];
  h.resets = 0;
  h.loader = null;
  h.axes = [DEFAULT_AXIS_ID];
  h.createdYAxis = [];
  h.fetchCalls = [];
  h.cmpError = null;
  // 对比序列**有内容**（替身失真第一种：不建模副作用之外，还有"把候选集交成空集"）：
  // ready 门读的 `bars.length > 0` 若靠默认空数组，未就绪那一支永远只由 key 不等撑起。
  // 主图 seed 6 根（D0..D5），这里给 D1/D3 ⇒ 对齐后 [null,10,10,12,12,12]，非 null 有 5 格。
  h.cmpBars = [
    { timestamp: D(1), close: 10 },
    { timestamp: D(3), close: 12 },
  ];
  seed();
  const seedAnchor = h.list[h.list.length - 1] as { timestamp: number };
  h.overlays = [
    {
      id: "d1",
      name: "horizontalStraightLine",
      paneId: "candle_pane",
      points: [{ timestamp: seedAnchor.timestamp, value: 1234.5 }],
    },
  ];
  localStorage.clear();
  // 模块 store 跨 `render` 存活：上一支用例交付进桶的序列若不清，本支就可能在页面自己
  // 还没取到数时读到它（P-7 裁的正是这条——`clearCompareSeries()` 的生产侧调用被否了，
  // 它的消费者就是这里）。`setActiveCompareKey("")` 同理，`calc` 读的就是这一格。
  clearCompareSeries();
  setActiveCompareKey("");
  document.documentElement.classList.remove("dark");
});
```

（上面这段 harness 之后紧接**八个** `it`，代码块里给全；另有四条按条目名从第⑤片文件搬来的真值边界件，见本任务末尾那条说明。`render(<ProChart />)` 与 `flush()` 的配法照第⑤片文件原样；`StrictMode` 那一支也照它——第⑤片用的是**显式 `<StrictMode>` 包裹**（`ProChartVpvr.test.tsx` 里「StrictMode 的第二次挂载不追加第二个 VPVR」那一支），不是 testing-library 的选项，所以 `import { StrictMode } from "react";` 必须在第一行。）

八个用例，逐个给出判据与逐字期望：

```tsx
describe("/pro-chart 多标的叠加对比", () => {
  it("填标的再点一次：挂到 candle_pane、走自定义轴、isStack 为真，且不调 createYAxis", async () => {
    render(<ProChart />);
    await flush();
    typeCompare("600036.SH");
    h.created = [];
    fireEvent.click(button());
    await flush();
    expect(cmpCreates()).toHaveLength(1);
    expect(cmpCreates()[0]).toMatchObject({
      name: "SYMBOL_COMPARE",
      paneId: "candle_pane",
      yAxisId: "pro-chart-compare-y",
      isStack: true,
    });
    expect(cmpLive()).toHaveLength(1);
    // §二·4 的另一半：轴由 createIndicator 顺手建出来 ⇒ 蜡烛 pane 现在是 2 根轴。
    expect(h.axes).toEqual([DEFAULT_AXIS_ID, "pro-chart-compare-y"]);
    // §十·① 的结构钉：调了它就得到一把 manual 轴，蜡烛会被撑进新尺（R1）。
    expect(h.createdYAxis).toHaveLength(0);
    expect(localStorage.getItem(COMPARE_PREFS_KEY)).toBe("600036.SH");
    expect(button().getAttribute("aria-pressed")).toBe("true");
  });

  it("数据到达前一次都不挂；到达那一轮必须挂上（§十·②b / R10）", async () => {
    // 第一轮让对比取数交回**空数组**（`no_data` 的真实形状，`marketApi.ts:260`）：store 里
    // 那个键有内容位但 bars 为空 ⇒ ready 为假。未就绪不挂是 §六 那枚谓词第三格的定义。
    h.cmpBars = [];
    render(<ProChart />);
    await flush();
    typeCompare("600036.SH");
    fireEvent.click(button());
    await flush();
    // 挂了就是那条线永远不存在（R10 的失效形状）——所以这一支要判「一次都不挂」。
    expect(cmpLive()).toHaveLength(0);
    expect(cmpCreates()).toHaveLength(0);
    // 第二轮：序列换成有内容的，再换一次周期 ⇒ `cmpKey` 变、重取、承载序列的那格 state
    // 换身份 ⇒ 挂卸 effect 必须重跑并真挂上。依赖数组只写 `cmpOn`/`timeShare`/key 的实现
    // 到不了这一步（它压根不会因为数据到达而重跑）。
    h.cmpBars = [
      { timestamp: D(1), close: 10 },
      { timestamp: D(3), close: 12 },
    ];
    fireEvent.click(screen.getByRole("button", { name: "周线" }));
    await flush();
    expect(cmpLive()).toHaveLength(1);
    // 「挂上之后 `calc` 交出的行里有非 null 值」这半条不在本文件判——页面替身的
    // `registerIndicator` 是 `vi.fn()`，`calc` 不在这里跑。它落在 T2 的
    // 「calc 读 activeKey 那一条序列」那根针上（同一条 §十·②b，两个判据面）。
  });

  it("连点两次回到原样：指标卸掉、轴恰好回到 1 根、键被删而会话内的标的还在（§十·③）", async () => {
    render(<ProChart />);
    await flush();
    typeCompare("600036.SH");
    fireEvent.click(button());
    await flush();
    expect(cmpLive()).toHaveLength(1);
    fireEvent.click(button());
    await flush();
    expect(cmpLive()).toHaveLength(0);
    // 孤儿回收（`index.esm.js:15234` 那一支）判得到：漏一根轴就是这里多一根。
    expect(h.axes).toEqual([DEFAULT_AXIS_ID]);
    expect(localStorage.getItem(COMPARE_PREFS_KEY)).toBeNull();
    // §四 会话内不清：关掉再点一次不用重敲。
    expect(field().getAttribute("value")).toBe("600036.SH");
    expect(button().getAttribute("aria-pressed")).toBe("false");
  });

  it("五支 title 逐字钉，且第 3 支排在 4/5 之前才读得到（§十·⑥ / §七 的判别顺序）", async () => {
    render(<ProChart />);
    await flush();
    // 支 2：没有已应用标的。
    expect(button().getAttribute("title")).toBe(
      "先在左边输入对比标的（如 600036.SH 或 BTC-USDT），点它才叠到主图",
    );
    typeCompare("600036.SH");
    fireEvent.click(button());
    await flush();
    // 支 4：已开（cmpSymbol 就是刚应用的串）。
    expect(button().getAttribute("title")).toBe(
      "对比已开：把可视区间同一把时间轴上的 600036.SH 收盘画成折线，用它自己那根右侧标尺，不进主图价格轴（再点切回）",
    );
    // 支 3：已开但数据未就绪。制造它要**换一次周期**——`cmpSymbol` 与 `interval` 都没变的
    // 那一轮根本不会重取，`cmpSeries` 仍是上一轮的旧身份，ready 还是真。换周期令键变、
    // 重取、交回空数组 ⇒ 这一格才是「开关亮着而 ready 为假」。
    // 这一支排在 4/5 之前才读得到（§七 明写顺序是设计的一部分）：写成 `cmpOn ? 已开 : …`
    // 在前、未就绪在后，这条针就永远绿——而那正是"把进行中说成已完成"的形状。
    h.cmpBars = [];
    fireEvent.click(screen.getByRole("button", { name: "周线" }));
    await flush();
    expect(button().getAttribute("title")).toBe("对比标的的数据还没到位，原因看输入框那行的提示");
    // 支 5：已关。`cmpSymbol` 会话内还在，所以这句话里带得出那个标的。
    h.cmpBars = [
      { timestamp: D(1), close: 10 },
      { timestamp: D(3), close: 12 },
    ];
    fireEvent.click(button());
    await flush();
    expect(button().getAttribute("title")).toBe(
      "对比已关：点开把 600036.SH 的收盘叠到主图，走独立标尺、不改主图价格轴",
    );
    // 支 1：分时态（排在最前，靠的是同一句三元的第一支）。
    fireEvent.click(screen.getByRole("button", { name: "分时" }));
    await flush();
    expect(button().getAttribute("title")).toBe(
      "跨市场的分钟时刻不在同一把尺上，分时视图看不了对比，先切回蜡烛",
    );
    expect(button().getAttribute("aria-pressed")).toBe("false");
  });

  it("分时态不取数、不挂；回 K 线自己挂回来且键还在原地", async () => {
    localStorage.setItem(COMPARE_PREFS_KEY, "600036.SH");
    localStorage.setItem(VPVR_PREFS_KEY, "1");
    localStorage.setItem(HEIKIN_ASHI_PREFS_KEY, "1");
    render(<ProChart />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "分时" }));
    await flush();
    expect(cmpLive()).toHaveLength(0);
    expect(h.fetchCalls.filter((c) => c.symbol === "600036.SH")).toHaveLength(0);
    expect(localStorage.getItem(COMPARE_PREFS_KEY)).toBe("600036.SH");
    fireEvent.click(screen.getByRole("button", { name: "分时" }));
    await flush();
    // 三件共存：谁也没吃掉谁（`isStack` 为假的话这里只剩对比一份）。
    expect(cmpLive()).toHaveLength(1);
    expect(haLive()).toHaveLength(1);
    expect(vpLive()).toHaveLength(1);
  });

  it("StrictMode 双挂载：请求可能发两次，但数据必须到（R13）", async () => {
    // 预置偏好而不是现场点按钮：双挂载发生在挂载那一刻，取数 effect 的 cleanup
    // （`abort()` + `compareInflight.delete(key)`）只有在这一趟里才走得到。
    localStorage.setItem(COMPARE_PREFS_KEY, "600036.SH");
    render(
      <StrictMode>
        <ProChart />
      </StrictMode>,
    );
    await flush();
    // 第二趟 flush：取数落地只保证 promise 到家，挂卸 effect 要在它触发的再一次
    // commit 里才跑（`cmpSeries` 换身份那一轮，见 §四 / R10）。
    await flush();
    expect(cmpLive()).toHaveLength(1);
  });

  it("错误臂：输入框 title 带那句「原因：」，且不挂任何东西、不砸主图", async () => {
    h.cmpError = "FutuOpenD 未应答";
    render(<ProChart />);
    await flush();
    typeCompare("600036.SH");
    fireEvent.click(button());
    await flush();
    expect(cmpLive()).toHaveLength(0);
    expect(field().getAttribute("title")).toContain("原因：FutuOpenD 未应答");
    expect(button().getAttribute("aria-pressed")).toBe("false");
    // 失败只丢叠加层（§五）：主图的数据面与指标面一格没动。
    expect(h.indicators.some((i) => i.name === "MA")).toBe(true);
  });

  it("空图：按钮 disabled 且理由说实话（不声称画得上线）", async () => {
    h.list = [];
    render(<ProChart />);
    await flush();
    typeCompare("600036.SH");
    expect(button().disabled).toBe(true);
    expect(cmpLive()).toHaveLength(0);
  });
});
```

最后再补**一条真值边界件**，做法是**原样搬第⑤片文件里那四条 `it`**（按条目名去找，不要按行号）：

- 「开→关来回：数据面没被重建、也没被就地改写（两侧都量）」
- 「分布不写画线面：锚点分毫未动、`overrideOverlay` 一次不多」
- 「画线落盘面逐字节不动：`pro-chart.drawings.v1` 开前事后相同」
- 「样式面零影响：`indicator` 子树仍恰是 …」

搬运时只改三处：触发方式换成 `typeCompare("600036.SH")` + 点「对比」两次（开→关）；`beforeEach` 里那条种进 `h.overlays` 的画线**照旧保留**（候选集交成空集就是本仓登记的假绿第一种）；偏好键断言里 `VPVR_PREFS_KEY`/`"1"` 换成 `COMPARE_PREFS_KEY`/标的串。**期望值一格都不许改**——那四条是已验收件的判据，本片只是把触发源从 VPVR 换成对比。搬完把它们的条目名各自改成对比口径（「切换不重建数据面」等），别留下「VPVR」字样的假归属。

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/pages/__tests__/ProChartCompare.test.tsx`
Expected: FAIL（找不到「对比」按钮 / `textbox` 不存在）。原文抄进报告。

- [ ] **Step 3: 页面接线（六处）**

**① import**——插在 `} from "@/lib/vpvrChart";` 之后：

```tsx
import { alignCloseToTimestamps } from "@/lib/symbolCompare";
import type { CompareBar } from "@/lib/symbolCompare";
import {
  COMPARE_AXIS_ID,
  COMPARE_BARS,
  SYMBOL_COMPARE_NAME,
  compareActive,
  compareKey,
  ensureCompareIndicator,
  loadCompare,
  saveCompare,
  setActiveCompareKey,
  setCompareSeries,
} from "@/lib/symbolCompareChart";
```

（`alignCloseToTimestamps` 页面**不**直接调——它经 store 间接进 `calc`。若 `tsc` 报未使用，就删掉这一行，不要留悬空 import；本条留给执行席自查，因为画线面那条 `pro-chart.drawings.v1` 判据不需要它。）

**② 模块级在飞集合**——插在 `export function ProChart()` 之前：

```tsx
/**
 * 对比取数的在飞键集合（spec §十二 R13）。StrictMode 双挂载去重照 `indicatorLang.ts` 里
 * 那条低周期取数的形状（判键→加键→`finally` 删键），但那条是 calc 路径、**没有 effect
 * cleanup**，照搬到 effect 里就漏一件事：cleanup 里 abort 的同一行必须把键也删掉，否则
 * 第二次挂载看见键还在 ⇒ 跳过，而第一次的请求已被自己 abort 掉、永远不会交付。
 * 代价（登记在 R13）：dev 下一次挂载会发两个请求，第二个完成、第一个被取消。
 */
const compareInflight = new Set<string>();
```

**③ state**——紧跟 `vpOn`/`vpRef` 那一格之后：

```tsx
  // 对比（第⑥片）：`cmpOn` 不是布尔偏好而是「开关态」这一格，键里存的是**已应用的标的串**
  // （spec §十二 R9：开关与标的存两处必然长出"键说开着、标的却是空"的第三种状态）。
  // `cmpSymbol` 是会话内当前标的：关掉只删键、不清它（§四），同一趟浏览再点一次不用重敲。
  // `cmpInput` 是输入框里**未提交**的原文——「填了」与「应用了」是两个状态，五支 title 的
  // 第 2/3 支分的就是这一刀。
  const [cmpSymbol, setCmpSymbol] = useState(() => loadCompare());
  const [cmpInput, setCmpInput] = useState(() => loadCompare());
  const [cmpOn, setCmpOn] = useState(() => loadCompare() !== "");
  // ref 镜像的理由与 `haRef`/`vpRef` 完全相同：同一个 task 里连点两次都摊到同一份过期的
  // 闭包快照上，第二次就会撤销第一次。
  const cmpRef = useRef(cmpOn);
  const [cmpStatus, setCmpStatus] = useState<{
    loading: boolean;
    error: string | null;
    source: string;
  }>({ loading: false, error: null, source: "" });
  // 取回来的序列，连同它属于哪个 key —— `cmpSeries.key === cmpKey && bars.length > 0`
  // 就是 §六 那枚谓词第三格 `ready` 的定义。state 身份本身还是挂卸 effect 的依赖（R10）。
  const [cmpSeries, setCmpSeries] = useState<{ key: string; bars: CompareBar[] } | null>(null);
```

派生量（放在 `barCount` 之后、任何读它的 handler 之前）：

```tsx
  // 键由页面派生（spec §四）：不从 store 里反查——反查就把"当前该用哪条序列"这个决定
  // 同时放到两处。
  const cmpKey = cmpSymbol === "" ? "" : compareKey(cmpSymbol, interval);
  const cmpReady =
    cmpSeries !== null && cmpSeries.key === cmpKey && cmpSeries.bars.length > 0;
```

**④ 取数 effect**——放在主图那条 dataLoader 相关 effect 之后、主题 effect 之前（与其它 effect 同级即可，位置只影响阅读顺序不影响执行）：

```tsx
  // 对比标的取数（spec §五）。三格依赖就够：**`cmpSeries` 绝不能再列进这里**——它由本条
  // effect 自己写，列进依赖就是「交付→重跑→再交付」的无限循环。
  useEffect(() => {
    if (cmpSymbol === "" || timeShare) return;
    const key = compareKey(cmpSymbol, interval);
    if (compareInflight.has(key)) return;
    compareInflight.add(key);
    const controller = new AbortController();
    setCmpStatus({ loading: true, error: null, source: "" });
    // 独立一趟，绝不与主序列 `Promise.all`（§五）：失败只丢叠加层并把原因显示出来。
    fetchKline({ symbol: cmpSymbol, interval, count: COMPARE_BARS, signal: controller.signal })
      .then((data) => {
        if (controller.signal.aborted) return;
        const bars = data.bars.map((b) => ({ timestamp: b.timestamp, close: b.close }));
        // 先写 store，再换 state 身份：挂卸 effect 是在 commit 之后跑的，它一跑就要求
        // `calc` 读得到这条序列。反过来的顺序读不出差别，但写在这里是因为它是唯一的因果方向。
        setCompareSeries(key, bars);
        setCmpSeries({ key, bars });
        setCmpStatus({ loading: false, error: null, source: data.source });
      })
      .catch((e: unknown) => {
        // 被自己 abort 掉的那一趟不是事实，不该印出来（StrictMode 的第二次挂载会 abort 第一次）。
        if (controller.signal.aborted) return;
        setCmpStatus({
          loading: false,
          error: e instanceof Error ? e.message : String(e),
          source: "",
        });
      })
      .finally(() => {
        compareInflight.delete(key);
      });
    return () => {
      // 两件事一起做（R13）：abort 掉在飞的这一趟，并把键腾出来让下一次挂载真发一次。
      controller.abort();
      compareInflight.delete(key);
    };
  }, [cmpSymbol, interval, timeShare]);
```

**⑤ `syncCompare` + 挂卸 effect**——`syncCompare` 紧跟 `syncVpvr` 之后：

```tsx
  /**
   * Put the compare line on the price pane with its own right-hand scale, or take it off
   * (第⑥片). 先删后挂与 `syncVpvr` 同源，但**无条件**：那边的 `live.length === 0` 夹挡的是
   * 「多出一行图例」，而这里重挂本身是 `calc` 重跑的唯一通道（spec §四 的宽触发面 / R10），
   * 夹住它就等于把"数据后到"那一格判成永远不成立。
   *
   * 也不拥有轴的生命周期：`ChartImp.removeIndicator` 在真删掉东西时扫孤儿轴
   * （`index.esm.js:15327` ⇄ 15217-15240），而 `createIndicator` 会把缺的那根建出来
   * （`:15241-15249`，这条路径不设 manual）⇒ 一次删挂恰好是一次「拆了尺再铸一把新的」。
   * `createYAxis` 一次都不调（它会把轴标成 manual，`index.esm.js:15483`）。
   *
   * `isStack` 为真与第⑤片同理由：真库 `addIndicator(create, isStack)` 在假值时先清整格
   * 指标，那会吃掉 MA／HA／VPVR。
   */
  const syncCompare = (chart: Nullable<Chart>, active: boolean, key: string) => {
    if (!chart) return;
    chart.removeIndicator({ name: SYMBOL_COMPARE_NAME });
    if (!active) return;
    ensureCompareIndicator();
    // 挂载前先把"当前该用哪条序列"记进 store；`calc` 只读这一格，不走 `calcParams`
    // （走参数就撞上 `shouldUpdate` 里那条 JSON.stringify 比较，同一份状态存两处）。
    setActiveCompareKey(key);
    chart.createIndicator(
      { name: SYMBOL_COMPARE_NAME, paneId: MAIN_PANE_ID, yAxisId: COMPARE_AXIS_ID },
      true,
    );
  };
```

挂卸 effect 紧跟 VPVR 那条之后（**必须在建图那条 effect 之后声明**——同一次 commit 里 effect 按声明顺序执行，`chartRef.current` 到这一格才非空）：

```tsx
  // 对比的挂载触发面比 HA／VPVR **宽一格**：`cmpSeries` 本身进依赖数组。第④⑤片挂的是同一个
  // `dataList` 上的纯变换，本片有一半输入住在 store 里、而库不会因为 store 变了重跑 `calc`
  // （只有 `dataList` 变化才全量重跑）⇒ 数据后到时不重挂，就得到一条永远不存在的线（R10）。
  useEffect(() => {
    syncCompare(chartRef.current, compareActive(cmpOn, timeShare, cmpReady), cmpKey);
    // Not deps: `chartRef.current` is a ref the init effect owns (a chart object appearing is
    // not a state change it can react to), and `syncCompare` is a new function object every
    // render — listing either would re-run this 先删后挂 sweep on every render rather than only
    // when the switch, the view, the applied symbol/interval, or the delivered series moves.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cmpOn, timeShare, cmpKey, cmpSeries]);
```

**⑥ `clickCompare` + 工具栏 JSX**——`clickCompare` 放在 `toggleVpvr` 之后：

```tsx
  /**
   * 应用输入框里的标的，和／或翻开关。一次点击做完两件事，是因为 §七 的第 2 支告诉用户
   * 「点它才叠到主图」——这一行没有第二个「加载」按钮。
   * 关掉只删键、不清 `cmpSymbol`（§四：会话内留着，再点一次不用重敲）。
   */
  const clickCompare = () => {
    const typed = cmpInput.trim().toUpperCase();
    if (typed !== "" && typed !== cmpSymbol) {
      cmpRef.current = true;
      setCmpSymbol(typed);
      setCmpInput(typed);
      setCmpOn(true);
      saveCompare(typed);
      return;
    }
    const next = !cmpRef.current;
    cmpRef.current = next;
    setCmpOn(next);
    saveCompare(next ? cmpSymbol : "");
  };
```

JSX 插在「量分布」那颗 `</button>` 之后、`{INTERVALS.map((i) => {` 之前：

```tsx
          {/* 对比（第⑥片）：一个输入框＋一个开关。三处表达式三种问法与前两颗按钮同形——
              `disabled` 问三个原因（分时／空图／没填标的），`aria-pressed` 与 className 问
              `compareActive` 这一枚谓词（未就绪时不亮，说的是"图上现在没有对比线"这件事实），
              而 `title` 的五支按 §七 定稿的**顺序**问：分时 → 没有已应用标的 → 已开但数据
              未就绪 → 已开 → 已关。第 3 支必须排在 4/5 **之前**，它排在后面就永远读不到，
              而那一格正是本片唯一会把"进行中"说成"已完成"的形状。 */}
          <input
            value={cmpInput}
            onChange={(event) => setCmpInput(event.target.value)}
            placeholder="对比标的"
            aria-label="对比标的"
            spellCheck={false}
            autoComplete="off"
            title={
              cmpStatus.error !== null
                ? `原因：${cmpStatus.error}`
                : "叠到主图的第二个标的：走它自己那根右侧标尺，不进主图价格轴。输入完整代码后点右边的「对比」"
            }
            className="h-7 w-28 rounded-md border bg-background px-2 text-xs outline-none focus:ring-1 focus:ring-primary"
          />
          <button
            disabled={timeShare || barCount === 0 || cmpInput.trim() === ""}
            aria-label="对比"
            aria-pressed={compareActive(cmpOn, timeShare, cmpReady)}
            title={
              timeShare
                ? "跨市场的分钟时刻不在同一把尺上，分时视图看不了对比，先切回蜡烛"
                : cmpSymbol === ""
                  ? "先在左边输入对比标的（如 600036.SH 或 BTC-USDT），点它才叠到主图"
                  : cmpOn && (cmpStatus.loading || cmpStatus.error !== null || !cmpReady)
                    ? "对比标的的数据还没到位，原因看输入框那行的提示"
                    : cmpOn
                      ? `对比已开：把可视区间同一把时间轴上的 ${cmpSymbol} 收盘画成折线，用它自己那根右侧标尺，不进主图价格轴（再点切回）`
                      : `对比已关：点开把 ${cmpSymbol} 的收盘叠到主图，走独立标尺、不改主图价格轴`
            }
            className={cn(
              "rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40",
              compareActive(cmpOn, timeShare, cmpReady) && "bg-muted font-medium ring-1 ring-primary",
            )}
            onClick={clickCompare}
          >
            对比
          </button>
          {/* 复权口径不回传（spec §十二 R4：日线 `adjust` 是死参数、`caliber` 前端读不到），
              所以这里只给两个真的回传了的 `source` 串——不给「可比/不可比」的假结论。 */}
          {cmpStatus.source !== "" && (
            <span className="text-[10px] text-muted-foreground">
              来源：主 {status.source || "-"} · 对 {cmpStatus.source}
            </span>
          )}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd frontend && npx vitest run src/pages/__tests__/ProChartCompare.test.tsx` → 全绿（条数当场读）。

- [ ] **Step 5: 第④⑤片的页面回归不许红**

Run: `cd frontend && npx vitest run src/pages/__tests__/ProChartVpvr.test.tsx src/pages/__tests__/ProChartHeikinAshi.test.tsx`
Expected: 全绿。若 `aria-label="对比"` 与那两片里任何一条 `getByRole` 问法撞名，**改本文件的问法**（例如收窄成 `{ name: "对比", exact: true }`），不许改既有文件里的判据——它们是已验收件。

- [ ] **Step 6: 类型门＋提交**

```bash
cd frontend && npx tsc --noEmit -p tsconfig.json
git commit -s -m "feat(compare): ProChart 接线——独立一趟取数、宽触发面重挂、三写 handler 与五支 title" -- frontend/src/pages/ProChart.tsx frontend/src/pages/__tests__/ProChartCompare.test.tsx
```

---

### Task 4: 变异自证 + 全量门禁

这条任务不改任何功能代码，它改的是**信心**：把每根针故意毒一次，读它变红，再复原。未做自证的判据在报告里必须标成「未证伪」。

**Files:**
- 无新增文件；临时改 `frontend/src/lib/symbolCompare.ts`、`frontend/src/lib/symbolCompareChart.ts`、`frontend/src/pages/ProChart.tsx` 各若干次，每轮**用完立刻就地改回**（本仓禁用 `git checkout --` 还原，脏树上）。

**Interfaces:**
- Consumes: T1–T3 的全部针。
- Produces: 一份变异台账（写进报告文件，不进仓库）。

- [ ] **Step 1: 基线**

```bash
cd frontend && npx vitest run src/lib/__tests__/symbolCompare.test.ts src/lib/__tests__/symbolCompareChart.test.ts src/pages/__tests__/ProChartCompare.test.tsx
```
记下通过条数（当场读数，别引用本文档）。

- [ ] **Step 2: 逐针毒化（八针，每针一条台账记录：改了什么 → 哪几条红 → 复原）**

| # | 毒化 | 期望变红的那根针 |
|---|---|---|
| 1 | `symbolCompare.ts` 里 `<=` 改 `<` | 「并列取等号那侧」 |
| 2 | 把 `out.push(cursor >= 0 ? ... : null)` 的 `null` 改成 `usable[0]?.close ?? null`（= bfill） | 「拒绝 bfill」＋「前缀不变量」 |
| 3 | 坏值判据删掉 `&& bar.close > 0`（只挡非有限） | 「坏值整根跳过：0／负数／NaN」 |
| 4 | 坏值处理改成「到了那根交 `null`」（不整根跳过） | 「坏值整根跳过」的后半（9 那格被截断） |
| 5 | `symbolCompareChart.ts` 里 `type: "line"` 整格删掉 | 「figures 恰一条且 `type` 逐字是 line」 |
| 6 | `precision: 2` 改 `4` | 「其余声明逐格钉」 |
| 7 | 页面 `syncCompare` 加回 `live.length === 0` 那一夹（只在不存在的条件下创建） | 「数据到达前一次都不挂；到达那一轮必须挂上」 |
| 8 | 挂卸 effect 依赖数组删掉 `cmpSeries` | 「数据到达前一次都不挂；到达那一轮必须挂上」（R10 的失效形状） |
| 9 | 取数 effect 的 cleanup 只 `abort()`、不 `compareInflight.delete(key)` | 「StrictMode 双挂载：请求可能发两次，但数据必须到」（R13） |
| 10 | `createYAxis` 在 `syncCompare` 里被调一次（手动 `chart.createYAxis?.({ id: COMPARE_AXIS_ID })`） | 「…且不调 createYAxis」＋轴表那一格 |

若某一针**不红**，那不是测试没写好就是判据等价：先按本仓的三条成因（等价变异常因／候选集被交成空集／门自己吞了退出码）判因，登记 `HARNESS-BLIND` 并在报告里写清是哪一种，**不要**为了让它红去加一条无意义断言。

- [ ] **Step 3: 六道门全跑**

```bash
cd frontend && npx tsc --noEmit -p tsconfig.json
cd frontend && npx vitest run
cd frontend && npx vite build
python -X utf8 -m pytest tools/test_wiki_drift.py -q
bash tools/ci_grep_gates.sh
```
（vitest 输出剥 ANSI 再读；`--reporter=basic` 本仓不可用。）

两道本地恒红门（wiki 水位门、grep 门 b）**先证本片贡献归属再报告**：给出「本片新增/改动了哪些被扫文件、门报的那几条里哪几条落在本片」，不调阈值、不改档案。

- [ ] **Step 4: 提交（若自证过程中任何文件被改回后仍有实质修正）**

```bash
git status --short
git commit -s -m "test(compare): 变异自证八针＋六道门全跑" -- <本片实际改过的 pathspec>
```
`git status` 必须只剩那三个并发写手的脏文件（`frontend/public/usage-guide.md`、`frontend/src/lib/__tests__/chartDrawings.test.ts`、`frontend/src/lib/chartDrawings.ts`）。任何一片的还原残留都必须在提交前逐文件 `git diff -- <path>` 读干净。

---

### Task 5: 活体验收 + Bar Replay 五步

只有活体能答的判据（spec §十·④/⑤）。像素与"屏幕上真有没有那条线"若无可见表面就登记**未判**，不假称已验（第⑤片同款降级形态）。

**Files:** 无代码改动；读数与截图落到 `C:\Users\fire\vpvrtmp\`（仓库外），报告进 SDD workspace。

- [ ] **Step 1: 起服务**

```bash
# 终端 A（后端 8000，vite 代理出厂即指 8000）
cd /e/Vibe-Trading-main/Vibe-Trading-main && python -X utf8 agent/api_server.py --port 8000
# 终端 B（前端 5899）
cd /e/Vibe-Trading-main/Vibe-Trading-main/frontend && npx vite --port 5899
```
两端点都要**探真实进程**（本仓登记过 SPA 兜底把未注册路径答成 200+HTML）：`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/api/health` 与 `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5899/` 都得是 200，且后端那条的响应体是健康检查的形状而不是 index.html。

- [ ] **Step 2: 打开页面并取图表实例**

浏览器（`browser-use` MCP）进 `http://127.0.0.1:5899/pro-chart`，等主图有数据（`barCount` 那条状态行不再是「加载中…」）。

canvas 页面读不到 DOM，取实例走 fiber（本仓手法）：在 `[tabindex="1"]` 那个容器上找 `__reactFiber$` 键，沿 `return` 向上遍历 `hook.memoizedState` 链，用 `typeof v.getDataList === "function"` 识别出 chart 对象。**注意后台标签页 rAF 不跑**：所有需要绘制产物的读数之前先 `take_screenshot` 把标签页带到前台，或直接把"读数为陈旧值"当作已知失真登记下来重读。

- [ ] **Step 3: 页内独立 oracle（必须与生产不同形）**

把这段贴进 `evaluate_script`——它是**二板上界**写法（`lowerBound` 那支），与生产那条单游标 `while` 形状不同形，所以两边一致才算证据；照抄生产的游标实现等于自我确认。

```js
function cmpOracle(mainTs, series) {
  const usable = series.filter((b) => Number.isFinite(b.close) && b.close > 0);
  const upperBound = (ts) => {
    // 第一个 > ts 的下标；返回它减一就是"最后一个 <= ts"。与生产的单调游标是两种形。
    let lo = 0, hi = usable.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (usable[mid].timestamp <= ts) lo = mid + 1;
      else hi = mid;
    }
    return lo - 1;
  };
  return mainTs.map((ts) => {
    const j = upperBound(ts);
    return j >= 0 ? usable[j].close : null;
  });
}
```

（**粘进页面前先本地跑一次**——本仓踩过"手写参考实现里的下标读函数一抛就废了整轮取证"。让执行席在 node 里跑一遍 `cmpOracle([0,1,2],[{timestamp:1,close:5}])` 得 `[null,5,5]` 再继续。）

- [ ] **Step 4: 四组读数（每组都是开关前/后各读一次，读数原样抄进报告）**

1. **默认轴量程不变量**：`chart.getYAxes({paneId:"candle_pane"}).filter(a => a.id !== "pro-chart-compare-y").map(a => a.getRange())` 开对比前后**逐字相同**。这是 §十·④ 那条主图不受叠加影响的判据，也是整片通道的地基。
2. **新轴量程带留白**：对比轴 `getRange()` 的期望**不是 min/max**，而是
   `from == min - gap.bottom * (max - min)`、`to == max + gap.top * (max - min)`，
   其中 min/max 折的是**可视区**那些行的非 null 对齐 close（折叠域 `getVisibleRangeDataList()`，`index.esm.js:1023`；平移/缩放会变，属预期），`gap` 从 `axis.gap` **现读**（出厂 `{top: 0.2, bottom: 0.1}`，`index.esm.js:13266-13269`；率只在 `>= 1` 才除高度，`index.esm.js:1096-1103`，两个出厂值都 <1 ⇒ 不除）。把 `min`/`max`/`gap`/`from`/`to` 五个数都抄下来再判等式，**不要**只抄 from/to 然后宣布不符。
3. **绘图区宽度**：`chart.getSize("candle_pane", "main").width` 开对比后**必然变小**（多一条右外列，spec §二·5 的可见代价，不是 bug），关掉**回到开前的像素值**（这条就是"会不会留死空白"的活体背书）。
4. **结果逐格对账**：`chart.getIndicators({name:"SYMBOL_COMPARE"})[0].result.map(r => r.cmp)` 与 Step 3 的 `cmpOracle(chart.getDataList().map(d => d.timestamp), <页面上那条对比序列>)` **逐格相等**（长度也要相等）。轴读数要跨一个微任务再读（`await Promise.resolve()` 或 `new Promise(r => setTimeout(r, 0))`）。

再补两条调用面读数：`chart.createYAxis` 在整个开/关循环里**一次都没被调**（用 monkey-patch 计数：先 `const orig = chart.createYAxis.bind(chart); chart.createYAxis = (a) => { n++; return orig(a); }`）；`getYAxes({paneId:"candle_pane"})` 关掉后回到**恰 1 根**。

- [ ] **Step 5: Bar Replay 五步自查（未来函数闸）**

进回放 → `后一根`×6 → `前一根`×1 → 退出。每步抄一次对比轴 `getRange()` 与 `result.map(r => r.cmp)` 的长度。判据：游标前进过程中**绝不出现游标右侧的根的价格**（长度跟着 `dataList` 前缀走、`cmp` 尾部不提前出现未来值），退出回放后 `getRange()` 回到进入前的读数（不重绘）。

- [ ] **Step 6: 无可见表面时的降级形态**

若页面在取证时没有可见表面（第⑤片遇过：截图与绘制同死但状态读数仍可用），判据全部落在**公开读数**（`getRange()`/`getSize()`/`getIndicators()[0].result`）与库的调用面上，像素色值与"屏幕上真有没有那条线"登记为**未判**，不假称已验。报告里必须写哪一种形态发生了。

- [ ] **Step 7: 报告**

把四组读数、五步表、createYAxis 计数、以及「未判」清单一并写进 SDD workspace 的 T5 报告文件（不进仓库）。无代码改动 ⇒ 无提交；若活体读出一个真缺陷，回到 Step 4 记录的坐标写修复任务，不要在取证轮里顺手改。

---

### Task 6: 落档 §7.20 + 记忆 + 整支评审

**Files:**
- Modify: `repowiki/项目档案.md`（追加 §7.20 一节）
- Modify（记忆，仓库外）: `C:\Users\fire\.qoder-cn\projects\e--Vibe-Trading-main-Vibe-Trading-main\memory\ops-delivered-features-and-comparisons.md` ＋ 新的库约束条目
- 无代码改动

- [ ] **Step 1: 追加档案 §7.20**

`repowiki/项目档案.md` 的工作树是 **CRLF**（本仓地籍：只有 `repowiki/` 钉了 LF 的 blob），所以按「bytes 层追加」配方做：读 bytes、在尾部追加用 `\r\n` 连接、写回。追加内容照 §7.18／§7.19 那一节的形状：一片一节，含「通道裁定」「库坐标证据（指 `dist/index.esm.js`）」「判据落点（哪个测试文件答 §十 的哪条）」「活体读数（当场数值，含未判清单）」「遗留」。

两条硬纪律：
- **不写自指读数**（不写「本文件 N 行」「本节 M 笔」）；**不在档案里加总本片笔数**。
- 引用提交用 sha12 而不是"本轮"；档案里的历史读数**只追加更正子句、不原地覆盖**。

- [ ] **Step 2: 复跑 wiki 三道门**

```bash
python -X utf8 -m pytest tools/test_wiki_drift.py -q
python -X utf8 -m pytest tools/ -k "wiki" -q
bash tools/ci_grep_gates.sh
```
（改档案要复跑读档案路径的门——本仓登记过「门会读档案路径 ⇒ 改档案要复跑它，而交付态复跑只落台账」。）

- [ ] **Step 3: 提交档案**

```bash
git commit -s -m "docs(archive): §7.20 第⑥片多标的叠加对比落档（含通道翻案与活体读数坐标）" -- repowiki/项目档案.md
```

- [ ] **Step 4: 记忆更新**

- `ops-delivered-features-and-comparisons.md` 追加 ㊷：第⑥片已合进本地 main 的提交号（当场 `git log -1 --format=%h` 读，别写预言值）、未推送、通道裁定。
- klinecharts 那条库约束条目（`chart-klinecharts-indicator-draw-and-axis.md`）追加**公开多轴通道**：`createIndicator({paneId, yAxisId})` 建轴且非 manual、`_shouldUseCandleData` 三态、`removeIndicator` 的孤儿轴扫描只在真删时跑、`createYAxis` = manual 的两个后果。这是可复用的库事实，不是本次工作记录。

- [ ] **Step 5: 整支评审**

按 superpowers:requesting-code-review 派一次**全片范围**评审（BASE = 本分支基座 `990c237d`，HEAD = 本轮最后一笔）。评审席的三条取证协议写死在派发消息里（报告可以是整份编造，本仓登记过）：每条 finding 带 `file:line` 且该行必须存在、引用与符号必须当场 grep 到、判据不成立时要贴命令原文。

发现项按 SDD 的收口规则处理：一轮修复派单 + 一次 scoped re-review + 残留逐条裁定。

---

## spec 判据 ↔ 任务映射

| spec 条目 | 落在哪 |
|---|---|
| §三 对齐口径（ffill-not-bfill / `<=` / 逐根独立 / 坏值整根跳过） | T1 实现＋T1 测试「carry-forward」「拒绝 bfill」「并列取等号那侧」「坏值整根跳过」「前缀不变量」 |
| §二·8 `figures[].type` 承重 | T2 测试「figures 恰一条且 `type` 逐字是 line」＋T4 针 5 |
| §二·1/2/4 通道与轴生命周期 | T2 文件头三条承重注释、T3 `syncCompare` 注释、T3 测试「不调 createYAxis」＋轴表两格、T5 Step 4 createYAxis 计数 |
| §二·3 「不进主图价格轴」的结构保证 | T2 文件头第 2 条、T5 Step 4 读数 1（活体逐字相同） |
| §二·5 右外列代价与不死空白 | T5 Step 4 读数 3 |
| §二·6/7 图例与精度 | T2 注册声明（`title` 那一格 + `precision: 2`）＋T2 测试「其余声明逐格钉」 |
| §四 宽触发面 / R10 | T3 挂卸 effect 依赖数组含 `cmpSeries`、T3 测试「数据到达前一次都不挂；到达那一轮必须挂上」、T4 针 7/8 |
| §四 一个偏好键 / R9 | T2 `loadCompare`/`saveCompare` 三格测试、T3 测试「连点两次…键被删而会话内的标的还在」 |
| §五 独立一趟 / 必须走 fetchKline / R5 要报不要吞 | T3 取数 effect、T3 测试「错误臂」 |
| §五 去重与 R13 | T3 `compareInflight` cleanup、T3 测试「StrictMode 双挂载」、T4 针 9 |
| §五 R4 口径诚实（只显示两个 source） | T3 工具栏来源小字 |
| §六 分时互斥 | T2 `compareActive` 八行真值表、T3 测试「分时态不取数、不挂」 |
| §六 与 HA/VPVR 共存 | T3 测试「三件共存」 |
| §六 Bar Replay（回放中游标是 `dataList` 截断 ⇒ 不重绘；不许在回放中触发取数） | 取数 effect 依赖只有 `cmpSymbol`/`interval`/`timeShare`，回放游标碰不到它（T3 ④）；「不重绘」只有活体能答 ⇒ T5 Step 5 五步自查 |
| §七 五支 title 与判别顺序 | T3 JSX 那五支、T3 测试「五支 title 逐字钉」 |
| §八 不做的事 | Global Constraints（零样式键、不碰 chartStyles、不动后端、N=1） |
| §九 门禁 | T4 Step 3 六道门 |
| §十·①②②b③④⑤⑥ | 依次：T2 测试 / T1 测试 / T3 测试 / T3 测试 / T5 Step 4 / T5 Step 5 / T3 测试 |
| §十一 遗留 | T6 §7.20 的「遗留」一节原样登记（不缩成"待修"） |

## 本计划裁定（执行席遇到与本文打架时按这里）

- **P1 输入框用原生 `<input>` 而不是 `SymbolCombobox`** —— 理由：`SymbolCombobox` 不转发 `title`（`components/common/SymbolCombobox.tsx` 的 props 面里根本没有这一格，它只交 `ariaLabel`），而 §七 要求输入框 title 承载那句 `原因：<errmsg 原文>`；为这一格去扩一个共享组件的 props 属于越界（本片范围钉在它身上）。—— 错了代价：对比字段没有 type-ahead，用户要敲完整代码。已登记为片级代价。
- **P2 不给输入框加 Enter 提交** —— 理由：§七 的动线是「点它才叠到主图」，按钮是唯一的 actor；加 Enter 就是第二个入口，要第二份判据。
- **P3 取数 effect 的依赖数组不含 `cmpSeries`** —— 理由：`cmpSeries` 由这条 effect 自己写，列进去就是无限循环；`ready` 那一侧的重挂由挂卸 effect 负责（它的数组里有 `cmpSeries`）。—— 错了代价：请求风暴。
- **P4 `then`/`catch` 里都判 `controller.signal.aborted` 后再落 state** —— 理由：StrictMode 的第二次挂载会 abort 第一次，而 abort 抛的那条 DOMException 不是事实，印到输入框 title 上就是"把进行中说成失败"。这不是防御不可达场景：cleanup 与周期切换都会真走到这一支。
- **P5 `no_data` 走第 3 支 title** —— 理由：§七 第 3 支的条件是 `cmpOn && (loading || error || !ready)`，`bars: []` 使 `ready` 为假，所以它落进"未就绪"而不是"失败"，与 R5「空不算失败」一致。代价：那种情况下输入框 title 没有 `原因：` 那一行，而按钮话说的还是"数据还没到位"。登记为已知表面缺口，**不**为此扩第 6 支（五支是封闭清单，扩它就是自造第二份权威）。
- **P6 `barCount === 0` 不新增 title 分支** —— 理由同 P5（§七 是封闭五支）。形状：空图时按钮 `disabled`，title 说"已开/已关"。缺口登记进 T6 的遗留。
- **P7 替身里轴表建/拆是库规则的六行镜像，不是常量** —— 理由：把 `getYAxes` 交成常量空集或常量单元素，§十·③ 那根"漏一根轴"的针就结构性不可红（本仓登记的假绿第一种）。注释必须写明「判的是声明与调用面，不是库」。
- **P8 不加 `getSize` 到 jsdom 替身** —— 理由：页面代码一格都不读它；宽度判据属于 T5 活体。替身只交真被读的那几格。
