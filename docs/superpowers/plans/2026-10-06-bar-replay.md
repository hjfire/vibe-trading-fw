# Bar Replay（历史回放）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `/pro-chart` 主图加一挡历史回放：把图表裁到某个时点，逐根或自动向前推进，用肉眼验证指标与 Pine 脚本不重绘、不偷看未来数据。

**Architecture:** 截断式。新增一份纯函数模块 `lib/barReplay.ts`（游标算术与谓词），页面持有一份"进入回放时图上有什么"的缓存，回放期间 DataLoader 只回答缓存前缀、两旗全 false、零网络请求；每次步进 = 改游标时间戳 + `chart.resetData()`（v10 没有 `applyNewData`，`init` 是换可见窗口的唯一通道）。工具条拆成独立的 `ReplayBar.tsx`，ProChart 只做接线。

**Tech Stack:** React 19 + TypeScript + Vite + Vitest（jsdom）+ klinecharts 10.0.3 + Tailwind。

**Spec:** `docs/superpowers/specs/2026-10-06-bar-replay-design.md`（本计划的每条判据都从它论证，实现前先读它第二、五、六节）

## Global Constraints

- 只改前端。`agent/**` 与 `repowiki/**` 本片零改动（`git diff --name-only <base>..HEAD -- agent repowiki` 必须是空）。
- 不新增依赖、不新增环境变量、不动 `ProChart.tsx` 之外的既有页面文件（`MultiChart.tsx`/`ChartCell.tsx` 不在范围内）。
- 页面文案沿用 ProChart 现有的硬编码中文（与工具条其余按钮一致），**不新增 locale 键**。
- 时间戳在本页一律以**毫秒**流动；UDF 的秒→毫秒换算只发生在 `marketApi.ts` 内部，任何新代码不得再乘除 1000。
- 唯一不变量（第五节）：回放态下任一时刻 `chart.getDataList()` 等于 `cache.slice(0, indexAtOrBefore(cache, cursorTs) + 1)`。
- 回放态**零网络请求**（第六节）：`init` 同步答缓存，`forward`/`backward` 一律空答并各自计数。
- 交易指标禁用未来函数：交付必须附第十二节那五步 Bar Replay 自查，且第 6 个任务的 harness 要真跑过。
- 每个任务结束时 `cd frontend && npx tsc --noEmit` 必须静默；提交一律带 pathspec（工作树可能是脏的）。

## File Structure

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `frontend/src/lib/barReplay.ts` | 新建 | 纯函数：游标身份、窗口切片、步进夹紧、倍速表、未来画线谓词、`REPLAY_MORE` |
| `frontend/src/lib/__tests__/barReplay.test.ts` | 新建 | 上述纯函数的全部判据 |
| `frontend/src/components/charts/ReplayBar.tsx` | 新建 | 受展示组件：进入/退出、单步、播放/暂停、倍速、日期、游标读数；不含任何 chart 实例 |
| `frontend/src/components/charts/__tests__/ReplayBar.test.tsx` | 新建 | 组件渲染与回调判据（含 disabled 原因、读数文案） |
| `frontend/src/pages/ProChart.tsx` | 修改 | 回放缓存与游标的 state/ref、DataLoader 回放分支、进入/退出/步进、播放循环、未来画线隐藏 |
| `frontend/src/pages/__tests__/ProChartReplay.test.tsx` | 新建 | 结构不变量：可见 bar ≤ 游标读数那一天、`more` 两旗 false、forward/backward 各被答一次空答、`fetchKline` 调用数=0 |
| `frontend/src/pages/__tests__/ProChartReplayDrawings.test.tsx` | 新建 | 未来画线隐藏/还原，含「全程没写过画线存储」那条 |
| `frontend/src/lib/__tests__/pineNoLookahead.test.ts` | 新建 | 「前缀 == 全量的前缀」重绘守卫 harness |

**不新建 `lib/useReplay.ts`**：回放的接线留在页面里（spec 第四节的理由）。页面级测试的既有路子是
`render(<ProChart />)` ＋ 照 `_addData` 建模的 chart 替身（`ProChartPaging.test.tsx` 就是这么抓住真缺陷的），
抽一层 hook 只会多一面要维护的接线，并把"工具条到 `resetData()` 这条线通没通"留在覆盖之外。

---

### Task 1: `lib/barReplay.ts` 纯函数

**Files:**
- Create: `frontend/src/lib/barReplay.ts`
- Test: `frontend/src/lib/__tests__/barReplay.test.ts`

**Interfaces:**
- Consumes: 无（不 import 本仓任何模块，只 type-import klinecharts）
- Produces: `Stamped`、`ReplaySpeed`、`REPLAY_MORE`、`DEFAULT_REPLAY_BACK`、`paceMs`、`indexAtOrBefore`、`replayWindow`、`cursorBar`、`stepCursor`、`isReplayExhausted`、`cursorFromView`、`isFutureDrawing`、`replayReadout`

- [ ] **Step 1: 写失败测试**

创建 `frontend/src/lib/__tests__/barReplay.test.ts`：

```ts
import { describe, expect, it } from "vitest";

import {
  DEFAULT_REPLAY_BACK,
  REPLAY_MORE,
  cursorBar,
  cursorFromView,
  indexAtOrBefore,
  isFutureDrawing,
  isReplayExhausted,
  paceMs,
  replayReadout,
  replayWindow,
  stepCursor,
} from "../barReplay";

/** Ten daily bars, one per 86 400 000 ms starting at the unix epoch. */
const DAY = 86_400_000;
const bars = (n: number) => Array.from({ length: n }, (_, i) => ({ timestamp: i * DAY, close: i }));
const TEN = bars(10);

describe("indexAtOrBefore", () => {
  it("命中精确的 bar 戳", () => {
    expect(indexAtOrBefore(TEN, 4 * DAY)).toBe(4);
  });
  it("落在两根之间取更早那根（回放里绝不许取未来）", () => {
    expect(indexAtOrBefore(TEN, 4 * DAY + 1)).toBe(4);
    expect(indexAtOrBefore(TEN, 5 * DAY - 1)).toBe(4);
  });
  it("早于首根返回 -1，晚于末根返回末根", () => {
    expect(indexAtOrBefore(TEN, -1)).toBe(-1);
    expect(indexAtOrBefore(TEN, 99 * DAY)).toBe(9);
  });
  it("空表返回 -1", () => {
    expect(indexAtOrBefore([], 0)).toBe(-1);
  });
});

describe("replayWindow", () => {
  it("cursor 为 null 时交回全量（退出回放）", () => {
    expect(replayWindow(TEN, null)).toEqual(TEN);
  });
  it("只含 ≤ cursor 的前缀，且含 cursor 那一根", () => {
    expect(replayWindow(TEN, 3 * DAY).map((b) => b.timestamp)).toEqual([0, DAY, 2 * DAY, 3 * DAY]);
  });
  it("cursor 早于首根时是空表，不是全表", () => {
    expect(replayWindow(TEN, -1)).toEqual([]);
  });
});

describe("stepCursor", () => {
  it("向右一根", () => {
    expect(stepCursor(TEN, 3 * DAY, 1)).toBe(4 * DAY);
  });
  it("向左 250 根不足时停在首根", () => {
    expect(stepCursor(TEN, 2 * DAY, -250)).toBe(0);
  });
  it("末根再向右停在末根，不越界", () => {
    expect(stepCursor(TEN, 9 * DAY, 1)).toBe(9 * DAY);
  });
  it("游标指向已被裁掉的戳（换周期后可能发生）时落回最近的一根", () => {
    expect(stepCursor(TEN, 4 * DAY + 1, 1)).toBe(5 * DAY);
  });
  it("空表原样返回，不抛", () => {
    expect(stepCursor([], 5 * DAY, 1)).toBe(5 * DAY);
  });
});

describe("isReplayExhausted", () => {
  it("末根为真，其余为假，空表为假", () => {
    expect(isReplayExhausted(TEN, 9 * DAY)).toBe(true);
    expect(isReplayExhausted(TEN, 8 * DAY)).toBe(false);
    expect(isReplayExhausted([], 0)).toBe(false);
  });
});

describe("cursorFromView", () => {
  it("下标钳进表内（库可能给出越界值）", () => {
    expect(cursorFromView(TEN, 3)).toBe(3 * DAY);
    expect(cursorFromView(TEN, 99)).toBe(9 * DAY);
    expect(cursorFromView(TEN, -5)).toBe(0);
  });
  it("空表返回 null", () => {
    expect(cursorFromView([], 0)).toBeNull();
  });
});

describe("isFutureDrawing", () => {
  it("任一锚点在游标之后即为未来画线", () => {
    expect(isFutureDrawing([{ timestamp: DAY }, { timestamp: 5 * DAY }], 3 * DAY)).toBe(true);
    expect(isFutureDrawing([{ timestamp: DAY }, { timestamp: 3 * DAY }], 3 * DAY)).toBe(false);
  });
  it("裸 dataIndex 锚点没有位置意义上的时间，不算未来", () => {
    expect(isFutureDrawing([{ value: 12 }], 3 * DAY)).toBe(false);
  });
  it("容忍 null/undefined 锚点（半途落点的线）", () => {
    expect(isFutureDrawing([null, undefined, { timestamp: 9 * DAY }], 3 * DAY)).toBe(true);
  });
});

describe("paceMs / REPLAY_MORE / cursorBar", () => {
  it("四档倍速单调不增，1× 是一秒一根", () => {
    expect(paceMs("1")).toBe(1000);
    expect(paceMs("0.5")).toBeGreaterThan(paceMs("1"));
    expect(paceMs("4")).toBeLessThan(paceMs("1"));
  });
  it("两旗都钉死 —— 这是回放的未来数据硬闸", () => {
    expect(REPLAY_MORE).toEqual({ forward: false, backward: false });
  });
  it("cursorBar 返回游标所在那根，游标早于首根时 null", () => {
    expect(cursorBar(TEN, 2 * DAY)?.timestamp).toBe(2 * DAY);
    expect(cursorBar(TEN, -1)).toBeNull();
  });
});

describe("replayReadout", () => {
  it("读数含第几根/共几根/剩余根数，游标不在表内时按落位的那根计", () => {
    expect(replayReadout(TEN, 4 * DAY)).toEqual({ shown: 5, total: 10, remaining: 5, index: 4 });
    expect(replayReadout(TEN, 4 * DAY + 1)).toEqual({ shown: 5, total: 10, remaining: 5, index: 4 });
  });
  it("空表读数全 0，不出现 NaN 或 -1", () => {
    expect(replayReadout([], 0)).toEqual({ shown: 0, total: 0, remaining: 0, index: -1 });
  });
  it("DEFAULT_REPLAY_BACK 是 250（日线约一年）", () => {
    expect(DEFAULT_REPLAY_BACK).toBe(250);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/barReplay.test.ts`
Expected: FAIL，`Failed to resolve import "../barReplay"`（模块还不存在）

- [ ] **Step 3: 写实现**

创建 `frontend/src/lib/barReplay.ts`：

```ts
/**
 * Bar Replay 的游标算术（纯函数）。
 *
 * 回放的设计判据是"图表物理上不存在游标之后的 bar"（见
 * docs/superpowers/specs/2026-10-06-bar-replay-design.md 第三节），所以这里没有一个函数
 * 需要 chart 实例：它们只做一件事——把"已加载的 bar + 一个时间戳"折成"该显示哪一段"。
 *
 * 游标的身份是 timestamp 而不是下标。下标在这张图上会被换周期（自然周月折叠）、改副图
 * 触发的 re-init、退出回放后的 forward 分页 prepend 三件事移动；本仓有过同型事故
 * （副图 paneId 随机漂移），能用稳定身份就不用位置身份。
 */

/** Anything that carries a bar timestamp. `KLineData` and stored drawing points both do. */
export interface Stamped {
  timestamp: number;
}

/**
 * What the DataLoader answers for `more` while a replay owns the chart: both flags dead.
 *
 * `backward: false` is the future-data gate — the library only ever asks for newer bars at
 * `to === totalBarCount && more.backward` (dist 13601). `forward: false` is not about
 * direction, it is about a race: the window here is a *prefix*, so `from === 0` is true
 * whenever the whole prefix fits the viewport, which would fire an automatic request whose
 * in-flight `_loading` flag (dist 13607) silently drops the user's next step. Looking further
 * back is not what replay is for — see spec §6.
 */
export const REPLAY_MORE = { forward: false, backward: false } as const;

/** Where the cursor lands on entry: about a trading year of daily bars back. */
export const DEFAULT_REPLAY_BACK = 250;

/** The speeds the toolbar offers, as ms per bar. A lookup, not a computation. */
const PACE: Record<ReplaySpeed, number> = { "0.5": 2000, "1": 1000, "2": 500, "4": 250 };

export type ReplaySpeed = "0.5" | "1" | "2" | "4";

export function paceMs(speed: ReplaySpeed): number {
  return PACE[speed];
}

/** Index of the last bar at or before `ts`; -1 when every bar is later than the cursor. */
export function indexAtOrBefore(bars: readonly Stamped[], ts: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].timestamp <= ts) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** The bar the cursor sits on, or null when the cursor names a time before any bar. */
export function cursorBar<T extends Stamped>(bars: readonly T[], cursorTs: number): T | null {
  const i = indexAtOrBefore(bars, cursorTs);
  return i < 0 ? null : bars[i];
}

/**
 * The bars a replay may show: every bar at or before the cursor. `null` means replay is off
 * and the whole loaded range belongs on screen.
 */
export function replayWindow<T extends Stamped>(bars: readonly T[], cursorTs: number | null): T[] {
  if (cursorTs === null) return [...bars];
  const i = indexAtOrBefore(bars, cursorTs);
  return i < 0 ? [] : bars.slice(0, i + 1);
}

/** Move the cursor by `n` bars (negative = back in time), clamped to the loaded range. */
export function stepCursor(bars: readonly Stamped[], cursorTs: number, n: number): number {
  if (bars.length === 0) return cursorTs;
  // A cursor that names no bar any more re-lands on the nearest one instead of running off
  // the end — that is what a period switch or a re-entry after paging can leave behind.
  const at = Math.min(Math.max(indexAtOrBefore(bars, cursorTs), 0), bars.length - 1);
  return bars[Math.min(Math.max(at + n, 0), bars.length - 1)].timestamp;
}

/** True once the cursor sits on the newest loaded bar: playing has nowhere to go. */
export function isReplayExhausted(bars: readonly Stamped[], cursorTs: number): boolean {
  return bars.length > 0 && cursorTs >= bars[bars.length - 1].timestamp;
}

/** "Start from the right edge of the view": fold a library-visible index into a cursor. */
export function cursorFromView(bars: readonly Stamped[], visibleTo: number): number | null {
  if (bars.length === 0) return null;
  return bars[Math.min(Math.max(Math.trunc(visibleTo), 0), bars.length - 1)].timestamp;
}

/**
 * A drawing is "in the future" when any of its anchors sits after the cursor. Showing one
 * during replay would be a visual lookahead: the whole point of the mode is that the user is
 * standing on `cursorTs`.
 *
 * An anchor carrying a bare `dataIndex` instead of a timestamp has no position in time to
 * compare against, so it never counts as future — same rule `hasCoordinates` uses in
 * `chartDrawings.ts`, applied in the other direction.
 */
export function isFutureDrawing(
  points: readonly (Partial<Stamped> | null | undefined)[],
  cursorTs: number,
): boolean {
  return points.some((p) => typeof p?.timestamp === "number" && p.timestamp > cursorTs);
}

export interface ReplayReadout {
  /** Bars on screen right now. */
  shown: number;
  /** Bars loaded when replay was entered. */
  total: number;
  /** Bars still to be replayed before the newest one. */
  remaining: number;
  /** Cursor index, -1 when the cursor precedes the range. */
  index: number;
}

/** The numbers the toolbar reads out. Kept here so the wording and the math cannot drift. */
export function replayReadout(bars: readonly Stamped[], cursorTs: number): ReplayReadout {
  const index = indexAtOrBefore(bars, cursorTs);
  const shown = index + 1;
  return { shown, total: bars.length, remaining: Math.max(bars.length - shown, 0), index };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd frontend && npx vitest run src/lib/__tests__/barReplay.test.ts`
Expected: `22 passed`（若用例数与此不符，按实际数登记，不要改判据凑数）

- [ ] **Step 5: 类型检查并提交**

```bash
cd frontend && npx tsc --noEmit
git add -- frontend/src/lib/barReplay.ts frontend/src/lib/__tests__/barReplay.test.ts
git commit -s -m "feat(barReplay): 游标算术纯函数——时间戳立身份、两旗钉死、读数与数学同源" -- frontend/src/lib/barReplay.ts frontend/src/lib/__tests__/barReplay.test.ts
```

---

### Task 2: `ReplayBar.tsx` 工具条组件

**Files:**
- Create: `frontend/src/components/charts/ReplayBar.tsx`
- Test: `frontend/src/components/charts/__tests__/ReplayBar.test.tsx`

**Interfaces:**
- Consumes: `ReplaySpeed`、`ReplayReadout`（Task 1）
- Produces: `ReplayBar`（受展示组件，props 见下）、`SPEEDS`

- [ ] **Step 1: 写失败测试**

创建 `frontend/src/components/charts/__tests__/ReplayBar.test.tsx`：

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ReplayBar } from "../ReplayBar";

const idle = {
  active: false,
  disabled: false,
  reason: null,
  playing: false,
  speed: "1" as const,
  readout: null,
  cursorLabel: null,
};

describe("ReplayBar", () => {
  it("非回放态只有一个「回放」入口，没有步进/播放按钮", () => {
    render(<ReplayBar {...idle} onStart={vi.fn()} onStop={vi.fn()} onStep={vi.fn()} onTogglePlay={vi.fn()} onSpeed={vi.fn()} onPickDate={vi.fn()} />);
    expect(screen.getByRole("button", { name: "回放" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "播放" })).toBeNull();
    expect(screen.queryByRole("button", { name: "退出回放" })).toBeNull();
  });

  it("disabled 时原因进 title，且点击不回调", () => {
    const onStart = vi.fn();
    render(<ReplayBar {...idle} disabled reason="分时只有一节 session，没有可回放的历史" onStart={onStart} onStop={vi.fn()} onStep={vi.fn()} onTogglePlay={vi.fn()} onSpeed={vi.fn()} onPickDate={vi.fn()} />);
    const btn = screen.getByRole("button", { name: "回放" });
    expect(btn.getAttribute("title")).toContain("分时");
    fireEvent.click(btn);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("回放态露读数、步进、播放与退出，读数写的是「第 k/N 根 · 剩 M 根」", () => {
    render(
      <ReplayBar
        active
        disabled={false}
        reason={null}
        playing={false}
        speed="2"
        readout={{ shown: 251, total: 501, remaining: 250, index: 250 }}
        cursorLabel="2025-09-30"
        onStart={vi.fn()}
        onStop={vi.fn()}
        onStep={vi.fn()}
        onTogglePlay={vi.fn()}
        onSpeed={vi.fn()}
        onPickDate={vi.fn()}
      />,
    );
    expect(screen.getByText(/2025-09-30/)).toBeTruthy();
    expect(screen.getByText(/第 251\/501 根/)).toBeTruthy();
    expect(screen.getByText(/剩 250 根/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "退出回放" })).toBeTruthy();
  });

  it("单步按钮各推一根、快退十根", () => {
    const onStep = vi.fn();
    render(<ReplayBar {...idle} active readout={{ shown: 3, total: 9, remaining: 6, index: 2 }} onStop={vi.fn()} onStart={vi.fn()} onStep={onStep} onTogglePlay={vi.fn()} onSpeed={vi.fn()} onPickDate={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "后一根" }));
    fireEvent.click(screen.getByRole("button", { name: "前一根" }));
    fireEvent.click(screen.getByRole("button", { name: "快退 10 根" }));
    expect(onStep.mock.calls.map((c) => c[0])).toEqual([1, -1, -10]);
  });

  it("播放中按钮文字变「暂停」，再点回「播放」", () => {
    const onTogglePlay = vi.fn();
    const { rerender } = render(<ReplayBar {...idle} active onStop={vi.fn()} onStart={vi.fn()} onStep={vi.fn()} onTogglePlay={onTogglePlay} onSpeed={vi.fn()} onPickDate={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "播放" }));
    expect(onTogglePlay).toHaveBeenCalledTimes(1);
    rerender(<ReplayBar {...idle} active playing onStop={vi.fn()} onStart={vi.fn()} onStep={vi.fn()} onTogglePlay={onTogglePlay} onSpeed={vi.fn()} onPickDate={vi.fn()} />);
    expect(screen.getByRole("button", { name: "暂停" })).toBeTruthy();
  });

  it("到达末根时播放按钮 disabled，退出仍可用", () => {
    const onStop = vi.fn();
    render(
      <ReplayBar
        active
        disabled={false}
        reason={null}
        playing={false}
        speed="1"
        readout={{ shown: 9, total: 9, remaining: 0, index: 8 }}
        cursorLabel="2026-10-06"
        onStart={vi.fn()}
        onStop={onStop}
        onStep={vi.fn()}
        onTogglePlay={vi.fn()}
        onSpeed={vi.fn()}
        onPickDate={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "播放" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "退出回放" }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("日期输入提交 ISO 串，空值不回调", () => {
    const onPickDate = vi.fn();
    render(<ReplayBar {...idle} active onStop={vi.fn()} onStart={vi.fn()} onStep={vi.fn()} onTogglePlay={vi.fn()} onSpeed={vi.fn()} onPickDate={onPickDate} />);
    const box = screen.getByLabelText("回放起点日期");
    fireEvent.change(box, { target: { value: "2025-01-08" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onPickDate).toHaveBeenCalledWith("2025-01-08");
    fireEvent.change(box, { target: { value: "" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onPickDate).toHaveBeenCalledTimes(1);
  });

  it("倍速四档都在，切换回调带档位", () => {
    const onSpeed = vi.fn();
    render(<ReplayBar {...idle} active onStop={vi.fn()} onStart={vi.fn()} onStep={vi.fn()} onTogglePlay={vi.fn()} onSpeed={onSpeed} onPickDate={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "4×" }));
    expect(onSpeed).toHaveBeenCalledWith("4");
  });

  it("起点两个入口：默认回退与从视图右端", () => {
    const onStart = vi.fn();
    render(<ReplayBar {...idle} onStart={onStart} onStop={vi.fn()} onStep={vi.fn()} onTogglePlay={vi.fn()} onSpeed={vi.fn()} onPickDate={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "回放" }));
    expect(onStart).toHaveBeenCalledWith("default");
    render(<ReplayBar {...idle} active={false} disabled={false} reason={null} playing={false} speed="1" readout={null} cursorLabel={null} onStart={onStart} onStop={vi.fn()} onStep={vi.fn()} onTogglePlay={vi.fn()} onSpeed={vi.fn()} onPickDate={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("button", { name: "从视图右端开始" }).at(-1)!);
    expect(onStart).toHaveBeenLastCalledWith("viewEdge");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/components/charts/__tests__/ReplayBar.test.tsx`
Expected: FAIL，`Failed to resolve import "../ReplayBar"`

- [ ] **Step 3: 写实现**

创建 `frontend/src/components/charts/ReplayBar.tsx`：

```tsx
import { useState, type KeyboardEvent } from "react";

import type { ReplayReadout, ReplaySpeed } from "@/lib/barReplay";
import { cn } from "@/lib/utils";

/**
 * The replay toolbar row. Purely presentational on purpose: it never touches the chart
 * instance, so the readout wording is testable without a canvas and the page keeps the only
 * copy of the cursor state.
 *
 * Deliberately absent: a vertical cursor line drawn as an overlay. `serializeDrawings
 * (chart.getOverlays())` banks every overlay on the chart by no name filter
 * (ProChart.tsx:844), so a replay marker would be written into the user's drawing bucket,
 * survive exit, come back on reload, and travel in the `.json`/`?d=` export. The truncated
 * window already says where "now" is — the newest bar on screen *is* the cursor.
 */

const SPEEDS: readonly ReplaySpeed[] = ["0.5", "1", "2", "4"];

const BTN = "rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40";

export interface ReplayBarProps {
  active: boolean;
  disabled: boolean;
  /** Why the entry button cannot be used; shown as its title when disabled. */
  reason: string | null;
  playing: boolean;
  speed: ReplaySpeed;
  readout: ReplayReadout | null;
  /** The cursor formatted as a date, or null before entry. */
  cursorLabel: string | null;
  onStart: (mode: "default" | "viewEdge") => void;
  onStop: () => void;
  onStep: (n: number) => void;
  onTogglePlay: () => void;
  onSpeed: (s: ReplaySpeed) => void;
  onPickDate: (iso: string) => void;
}

export function ReplayBar({
  active,
  disabled,
  reason,
  playing,
  speed,
  readout,
  cursorLabel,
  onStart,
  onStop,
  onStep,
  onTogglePlay,
  onSpeed,
  onPickDate,
}: ReplayBarProps) {
  const [date, setDate] = useState("");
  const sendDate = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    if (date) onPickDate(date);
  };

  if (!active) {
    return (
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className={BTN}
          disabled={disabled}
          title={disabled ? (reason ?? "当前视图不能回放") : "把图表裁到历史某一刻，逐根向前推进"}
          onClick={() => onStart("default")}
        >
          回放
        </button>
        <button
          type="button"
          className={BTN}
          disabled={disabled}
          title={disabled ? (reason ?? "当前视图不能回放") : "从当前视图最右那根开始回放"}
          onClick={() => onStart("viewEdge")}
        >
          从视图右端开始
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button type="button" className={BTN} onClick={() => onStep(-10)} title="向左 10 根（Backspace）">
        快退 10 根
      </button>
      <button type="button" className={BTN} onClick={() => onStep(-1)} title="向左一根（←）">
        前一根
      </button>
      <button type="button" className={BTN} onClick={onTogglePlay} disabled={!!readout && readout.remaining === 0}>
        {playing ? "暂停" : "播放"}
      </button>
      <button type="button" className={BTN} onClick={() => onStep(1)} title="向右一根（→）">
        后一根
      </button>
      <button type="button" className={BTN} onClick={() => onStep(10)} title="向右 10 根">
        快进 10 根
      </button>
      {SPEEDS.map((s) => (
        <button
          type="button"
          key={s}
          className={cn(BTN, s === speed && "bg-muted font-medium")}
          onClick={() => onSpeed(s)}
          title={`${s}× ＝ 每根 ${s === "0.5" ? 2000 : s === "1" ? 1000 : s === "2" ? 500 : 250} ms`}
        >
          {s}×
        </button>
      ))}
      <label className="ml-1 text-xs text-muted-foreground" htmlFor="replay-start-date">
        起点
      </label>
      <input
        id="replay-start-date"
        aria-label="回放起点日期"
        type="date"
        className="rounded-md border bg-transparent px-2 py-1 text-xs"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        onKeyDown={sendDate}
      />
      <span className="text-xs text-muted-foreground">
        回放中{cursorLabel ? ` ${cursorLabel}` : ""}
        {readout ? ` · 第 ${readout.shown}/${readout.total} 根 · 剩 ${readout.remaining} 根` : ""}
      </span>
      <button type="button" className={BTN} onClick={onStop} title="交回完整已加载区间，恢复正常分页">
        退出回放
      </button>
    </div>
  );
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd frontend && npx vitest run src/components/charts/__tests__/ReplayBar.test.tsx`
Expected: 全部通过（9 例）。若 `cn` 的导入路径不对，先看 `ProChart.tsx` 顶部的 `cn` import 行照抄，不要自己造。

- [ ] **Step 5: 提交**

```bash
cd frontend && npx tsc --noEmit
git add -- frontend/src/components/charts/ReplayBar.tsx frontend/src/components/charts/__tests__/ReplayBar.test.tsx
git commit -s -m "feat(barReplay): 回放工具条组件——读数/步进/倍速/起点，游标竖线为何不做写进文件头" -- frontend/src/components/charts/ReplayBar.tsx frontend/src/components/charts/__tests__/ReplayBar.test.tsx
```

---

### Task 3: ProChart 接线——缓存、游标、DataLoader 回放分支

**Files:**
- Modify: `frontend/src/pages/ProChart.tsx` 四处（行号按 `dd84eb1a` 的工作树）
  - `:453` 之后（`anchorNoteRef` 那组 ref 下面）加回放会话 ref ＋ 渲染镜像 state
  - `:865` `getBars` 体的第一行（`const iv = periodToInterval(period)` 之前）加回放分支
  - `:1092` `setView` 体的前几行加身份变更收口（三个调用点全覆盖：`:1158` 换标的、`:1184` 换周期、`:1193` 切分时）
  - `:1695` 那条 `<div className="mx-2 h-5 w-px bg-border" />` 分隔线之后挂 `<ReplayBar />`
- Test: Create `frontend/src/pages/__tests__/ProChartReplay.test.tsx`

**Interfaces:**
- Consumes: Task 1 全部导出（含本任务补的 `cursorFromDatePick` / `formatReplayDate`）、Task 2 的 `ReplayBar`
- Produces（页面内部，不外抛）：`replayRef`＝唯一权威、`replay`＝工具条渲染镜像、
  `syncReplayUi()`、`enterReplay(mode)`、`exitReplay()`、`dropReplay()`、`replayStep(n)`、`pickReplayDate(iso)`

**必须先读的上下文（不要跳过）：** spec 第二、五、六、七节；`ProChart.tsx:864-935`（DataLoader 现状）；
`ProChart.tsx:1091-1146`（`setView` 是所有周期／分时切换的唯一收口，`applySymbol` 也走它）；
**`frontend/src/pages/__tests__/ProChartPaging.test.tsx` 全文**——本任务的测试是它的姊妹篇，
`vi.mock("klinecharts")` 与 `vi.mock("@/lib/marketApi")` 两块替身**照抄它的，不要另起一套**（它照
`StoreImp._addData` 建模，正是"拖一下跳回原位"那个真缺陷的捕获器）。

**四条设计裁定，写代码前先认：**

1. **DataLoader 的闭包只认 ref。** `dataLoader` 在建图时创建一次（`:864`），它看到的 `state` 停在
   那一刻；页面已有的解法就是 `viewRef` / `drawingsKeyRef` 那一族。回放沿用同一形状：
   `replayRef.current` 是唯一权威，`setReplay(...)` 只是给 `<ReplayBar />` 渲染用的镜像。
2. **镜像只有一个写入口。** `syncReplayUi()` 不接参数，它自己从 `replayRef.current` 现算
   `active / cursorTs / playing / readout`。任何"改游标"的代码写完 ref 就调它一次——
   ref 与 UI 不可能漂移，闭包里的旧值也不可能被当现值用（Task 4 的播放循环正是靠这条）。
3. **会话只有一个对象，状态由字段组合表示。** `cursorTs !== null` ⇔ 回放中；
   `cursorTs === null && bars.length > 0` ⇔ 退出后"一次性交回 cache"还没被消费。不引入第三个布尔旗。
4. **退出用一次性交回，不重新拉取**（spec 第七节末条）。身份变更（换周期／换标的／切分时）一律
   `dropReplay()` 丢弃 cache 且**不调 `resetData()`**——那些调用点下一行就是 `setPeriod`／`setSymbol`，
   库自己会 reload；这里再多打一次 `resetData()` 等于每次换周期发两次请求，会把
   `ProChartPaging.test.tsx` 的请求数断言跑红。

- [ ] **Step 1: 写失败测试**

创建 `frontend/src/pages/__tests__/ProChartReplay.test.tsx`：

```tsx
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProChart } from "../ProChart";

/**
 * Bar Replay's data path, driven through the real /pro-chart component (spec §11).
 *
 * Two things make this more than a rendering check:
 *
 * - The chart double re-implements `StoreImp._addData` and `resetData` faithfully, so
 *   `resetData()` really re-fires an `init` getBars (dist 13652 -> 13621). A double that only
 *   stored the array would let a replay that never repaints the chart pass.
 * - Every assertion is read from outside the page: the toolbar's printed date, and the
 *   recorder on the mock. The cursor is not "whatever the component says it is" — it is the
 *   calendar day the readout shows, and the loaded range is whatever `fetchKline` was asked
 *   for. That is what stops the invariant check from being the same function checking itself.
 */

const DAY = 86_400_000;
// Midnight UTC, so bar N is exactly START + N days in any CI timezone.
const START = Date.UTC(2020, 0, 1);
const PAGE = 500;
const TOTAL = 1200;
// Where DEFAULT_REPLAY_BACK = 250 lands: index 949, 950 bars on screen.
const ENTRY_LEN = TOTAL - 250;

interface Bar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const ALL_BARS: Bar[] = Array.from({ length: TOTAL }, (_, i) => ({
  timestamp: START + i * DAY,
  open: 1,
  high: 1,
  low: 1,
  close: 1,
  volume: 1,
}));

interface Answer {
  type: string;
  bars: number;
  forward: boolean;
  backward: boolean;
}

const h = vi.hoisted(() => ({
  list: [] as Array<{ timestamp: number }>,
  more: { forward: false, backward: false },
  // Every fetchKline the page made. "Length frozen" == "replay issued no request".
  requests: [] as Array<{ type: string; before: string | null }>,
  // Every callback the page handed back, whatever direction it was asked for.
  answers: [] as Answer[],
  overlays: [] as Array<Record<string, unknown>>,
  overrides: [] as Array<{ id?: string; visible?: boolean }>,
  inFlight: 0,
  askedType: "",
  // getVisibleRange().to, set per test to drive "start from the view edge".
  visibleTo: 0,
  loader: null as null | {
    getBars: (p: {
      type: string;
      timestamp: number | null;
      period: { type: string; span: number };
      symbol: { ticker: string };
      callback: (data: unknown[], more?: unknown) => void;
    }) => void | Promise<void>;
  },
}));

/** `StoreImp._addData`, the same three cases `ProChartPaging.test.tsx` models. */
function addData(data: unknown[], type: string, more: unknown): void {
  const real = { forward: false, backward: false };
  if (typeof more === "boolean") {
    real.forward = more;
    real.backward = more;
  } else if (more && typeof more === "object") {
    const m = more as { forward?: boolean; backward?: boolean };
    real.forward = m.forward ?? false;
    real.backward = m.backward ?? false;
  }
  const bars = data as Array<{ timestamp: number }>;
  if (type === "init") h.list = bars;
  else if (type === "forward") h.list = [...bars, ...h.list];
  else if (type === "backward") h.list = [...h.list, ...bars];
  if (type !== "backward") h.more.forward = real.forward;
  if (type !== "forward") h.more.backward = real.backward;
}

/**
 * What `_processDataLoad(type)` does: take the timestamp out of the list the store already
 * has, set `_loading`, call `getBars`. The callback clears `_loading` inside the library, so
 * `inFlight` drops there too — that ordering is the race spec §6 reason 3 is about.
 */
function ask(type: "init" | "forward" | "backward"): void {
  if (!h.loader) throw new Error("页面没有装 DataLoader");
  const oldest = h.list.length ? h.list[0].timestamp : null;
  const newest = h.list.length ? h.list[h.list.length - 1].timestamp : null;
  const timestamp = type === "backward" ? newest : type === "forward" ? oldest : null;
  h.inFlight += 1;
  h.askedType = type;
  void Promise.resolve(
    h.loader.getBars({
      type,
      timestamp,
      period: { type: "day", span: 1 },
      symbol: { ticker: "600519.SH" },
      callback: (data, more) => {
        const m = (more ?? {}) as { forward?: boolean; backward?: boolean };
        h.answers.push({
          type,
          bars: data.length,
          forward: m.forward ?? false,
          backward: m.backward ?? false,
        });
        addData(data, type, more);
        h.inFlight -= 1;
      },
    }),
  ).catch(() => {
    h.inFlight -= 1;
  });
}

vi.mock("klinecharts", () => ({
  registerIndicator: vi.fn(),
  getSupportedLocales: () => ["en-US", "zh-CN"],
  registerLocale: vi.fn(),
  dispose: vi.fn(),
  init: () => ({
    getSymbol: () => ({ ticker: "600519.SH" }),
    getPeriod: () => ({ type: "day", span: 1 }),
    getDataList: () => h.list,
    setDataLoader: (loader: typeof h.loader) => {
      h.loader = loader;
    },
    // StoreImp.resetData (dist 13652) = unsubscribe, _loading = false, one `init` load.
    // Modelling it is the point: a step that forgets to re-ask has nowhere to show up.
    resetData: () => ask("init"),
    setSymbol: () => ask("init"),
    setPeriod: () => ask("init"),
    setStyles: vi.fn(),
    resize: vi.fn(),
    createIndicator: vi.fn(),
    createOverlay: vi.fn(),
    removeOverlay: vi.fn(),
    removeIndicator: vi.fn(),
    getIndicators: () => [],
    getOverlays: () => h.overlays,
    getPaneOptions: () => [],
    setPaneOptions: vi.fn(),
    getOffsetRightDistance: () => 0,
    setOffsetRightDistance: vi.fn(),
    getBarSpace: () => ({ bar: 8, halfBar: 4, gapBar: 5, halfGapBar: 2 }),
    setBarSpace: vi.fn(),
    getVisibleRange: () => ({ from: 0, to: h.visibleTo, realFrom: 0, realTo: h.visibleTo }),
    overrideOverlay: (o: { id?: string; visible?: boolean }) => {
      h.overrides.push({ id: o.id, visible: o.visible });
      return true;
    },
  }),
}));

vi.mock("@/lib/marketApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/marketApi")>();
  return {
    ...actual,
    fetchKline: async (params: { before?: number | null; count?: number }) => {
      const before = params.before ?? null;
      const pool = before === null ? ALL_BARS : ALL_BARS.filter((b) => b.timestamp < before);
      const bars = pool.slice(-(params.count ?? PAGE));
      h.requests.push({
        type: h.askedType,
        before: before === null ? null : new Date(before).toISOString().slice(0, 10),
      });
      return { bars, source: "fake", symbol: "600519.SH", interval: "1D", ok: true };
    },
  };
});

vi.mock("@/components/charts/WatchList", () => ({ default: () => null }));
vi.mock("@/components/charts/IndicatorEditor", () => ({ default: () => null }));

/** Pumps the library's edge triggers until nothing wants more data. */
async function settle(limit = 40): Promise<void> {
  for (let round = 0; round < limit; round++) {
    while (h.inFlight > 0) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
    if (!h.more.forward && !h.more.backward) return;
    await act(async () => {
      ask(h.more.forward ? "forward" : "backward");
    });
  }
  throw new Error(`分页没有停止：已发出 ${h.requests.length} 次请求`);
}

const buttonOf = (name: string): HTMLButtonElement =>
  screen.getByRole("button", { name }) as HTMLButtonElement;

const click = async (name: string): Promise<void> => {
  await act(async () => {
    fireEvent.click(buttonOf(name));
  });
};

/** The calendar day the toolbar prints for the cursor — the outside-the-page anchor. */
function readoutDayEnd(): number {
  const text = screen.getByTestId("replay-readout").textContent ?? "";
  const m = /(\d{4}-\d{2}-\d{2})/.exec(text);
  if (!m) throw new Error(`读数里没有游标日期：${JSON.stringify(text)}`);
  // End of that UTC day: a bar stamped at any hour of its trading day falls inside it.
  return Date.parse(`${m[1]}T23:59:59.999Z`);
}

/** The prefix of the loaded range a cursor day allows, computed WITHOUT the lib helpers. */
const allowedByDay = (dayEnd: number): number[] =>
  ALL_BARS.filter((b) => b.timestamp <= dayEnd).map((b) => b.timestamp);

const visible = (): number[] => h.list.map((b) => b.timestamp);

async function mountLoaded(): Promise<void> {
  render(<ProChart />);
  await settle();
  expect(h.list.length).toBe(TOTAL); // the whole fake history is on the chart
}

beforeEach(() => {
  h.list = [];
  h.more = { forward: false, backward: false };
  h.requests = [];
  h.answers = [];
  h.overlays = [];
  h.overrides = [];
  h.inFlight = 0;
  h.askedType = "";
  h.visibleTo = TOTAL;
  h.loader = null;
  localStorage.clear();
});

describe("/pro-chart 回放的数据通路", () => {
  it("进入回放：只留前缀，右端就是游标，读数说的是同一件事", async () => {
    await mountLoaded();
    const before = h.requests.length;
    await click("回放");

    expect(visible()).toEqual(ALL_BARS.slice(0, ENTRY_LEN).map((b) => b.timestamp));
    // The independent anchor: what the toolbar *says*, not what the list ends with.
    expect(visible()).toEqual(allowedByDay(readoutDayEnd()));
    expect(screen.getByText(`第 ${ENTRY_LEN}/${TOTAL} 根`)).toBeTruthy();
    expect(screen.getByText("剩 250 根")).toBeTruthy();
    // Entry is answered out of the snapshot, so it costs no request.
    expect(h.requests.length).toBe(before);
  });

  it("不变量：每一步 dataList 恒等于「按游标日允许的那段前缀」", async () => {
    await mountLoaded();
    await click("回放");
    for (const name of ["后一根", "后一根", "前一根", "快进 10 根", "前一根"]) {
      await click(name);
      const dayEnd = readoutDayEnd();
      const list = visible();
      expect(list).toEqual(allowedByDay(dayEnd));
      expect(list.length).toBeGreaterThan(0);
      expect(list[list.length - 1]).toBeLessThanOrEqual(dayEnd);
    }
  });

  it("两端夹紧：到首根／末根后再步一次，游标不动也不越界", async () => {
    await mountLoaded();
    await click("回放");
    for (let i = 0; i < ENTRY_LEN + 5; i++) await click("前一根");
    expect(visible()).toEqual([ALL_BARS[0].timestamp]);
    expect(screen.getByText("第 1/1200 根")).toBeTruthy();

    for (let i = 0; i < TOTAL + 5; i++) await click("后一根");
    expect(visible()).toEqual(ALL_BARS.map((b) => b.timestamp));
    expect(screen.getByText("第 1200/1200 根")).toBeTruthy();
  });

  it("回放全程零网络请求——最硬的那条（含退出后的一次性交回）", async () => {
    await mountLoaded();
    const before = h.requests.length;
    await click("回放");
    for (let i = 0; i < 30; i++) await click("后一根");
    // The library does ask on its own, from the left-edge trigger `from === 0 && more.forward`;
    // answering it from the page is what keeps `_loading` from eating the next step.
    await act(async () => {
      ask("forward");
      ask("backward");
    });
    await click("退出回放");
    expect(h.requests.length).toBe(before);
    // And the handback put the whole loaded range back without one.
    expect(h.list.length).toBe(TOTAL);
  });

  it("forward / backward 各收到一次空答、两旗全 false（反真空通过：先数被问过几次）", async () => {
    await mountLoaded();
    await click("回放");
    await act(async () => {
      ask("forward");
      ask("backward");
    });
    const directional = h.answers.filter((a) => a.type === "forward" || a.type === "backward");
    expect(directional.length).toBe(2);
    expect(directional.filter((a) => a.type === "forward").length).toBe(1);
    expect(directional.filter((a) => a.type === "backward").length).toBe(1);
    for (const a of directional) {
      expect(a.bars).toBe(0);
      expect({ forward: a.forward, backward: a.backward }).toEqual({ forward: false, backward: false });
    }
  });

  it("init 答出去的每一根都 ≤ 游标，两旗都 false", async () => {
    await mountLoaded();
    await click("回放");
    const dayEnd = readoutDayEnd();
    const inits = h.answers.filter((a) => a.type === "init");
    expect(inits.length).toBeGreaterThan(0);
    const last = inits[inits.length - 1];
    expect(last.bars).toBeGreaterThan(0);
    expect(last.forward).toBe(false);
    expect(last.backward).toBe(false);
    expect(h.list.every((b) => b.timestamp <= dayEnd)).toBe(true);
  });

  it("「从视图右端开始」把库的可见下标折成游标", async () => {
    await mountLoaded();
    h.visibleTo = 1000;
    await click("从视图右端开始");
    expect(visible()).toEqual(allowedByDay(readoutDayEnd()));
    expect(h.list.length).toBe(1000);
  });

  it("换周期与切分时一律退出回放（cache 的数据身份变了）", async () => {
    await mountLoaded();
    await click("回放");
    expect(screen.queryByRole("button", { name: "退出回放" })).toBeTruthy();
    await click("60分");
    expect(screen.queryByRole("button", { name: "退出回放" })).toBeNull();
    // 分钟线可以回放：spec 第七节只禁分时。回放的仍是"已加载的那段分钟 bar"。
    expect(buttonOf("回放").hasAttribute("disabled")).toBe(false);
    await click("日线");
    await click("回放");
    await click("分时");
    expect(screen.queryByRole("button", { name: "退出回放" })).toBeNull();
  });

  it("分时态进不去：按钮 disabled、原因在 title、读数根本不存在", async () => {
    await mountLoaded();
    await click("分时");
    const btn = buttonOf("回放");
    expect(btn.hasAttribute("disabled")).toBe(true);
    expect(btn.getAttribute("title")).toContain("分时");
    expect(screen.queryByTestId("replay-readout")).toBeNull();
  });

  it("日期框输入的日期落回同一根（往返）", async () => {
    await mountLoaded();
    await click("回放");
    const target = ALL_BARS[500];
    const iso = new Date(target.timestamp).toISOString().slice(0, 10);
    const box = screen.getByLabelText("回放起点日期") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(box, { target: { value: iso } });
      fireEvent.keyDown(box, { key: "Enter" });
    });
    expect(visible()).toEqual(allowedByDay(readoutDayEnd()));
    expect(h.list[h.list.length - 1].timestamp).toBe(target.timestamp);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd frontend && npx vitest run src/pages/__tests__/ProChartReplay.test.tsx`
Expected: 全红，第一条的红是"找不到 `回放` 按钮"（`ReplayBar` 还没挂进工具条）。若红在 `settle()`
的请求数上，说明替身照抄时漏了成员，先补齐再继续——不要改测试的期望值。

- [ ] **Step 3: 补两个纯函数（写进 Task 1 的模块）**

`frontend/src/lib/barReplay.ts` 追加：

```ts
/**
 * The toolbar's cursor date. Deliberately the browser's own calendar day: the readout and the
 * date box only have to agree with *each other*, and a bar stamped at the exchange's 15:00
 * falls on that same day for a CN-hosted browser either way. This is a coordinate, not i18n
 * copy, so it is built by hand instead of `toLocaleDateString` (which would vary by locale).
 */
export function formatReplayDate(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * The date box's `YYYY-MM-DD` as a cursor: the last bar whose day is at or before it.
 *
 * End of the UTC day, not midnight — A-share daily bars are stamped at the session close
 * (15:00 CST = 07:00 UTC), so that day's own midnight would resolve to the *previous* trading
 * day. See the `ops-market-data-timezone-fallback` note on why stamps are exchange-local.
 */
export function cursorFromDatePick(bars: readonly Stamped[], iso: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const dayEnd = Date.parse(`${iso}T23:59:59.999Z`);
  if (Number.isNaN(dayEnd)) return null;
  const i = indexAtOrBefore(bars, dayEnd);
  return i < 0 ? null : bars[i].timestamp;
}
```

`frontend/src/lib/__tests__/barReplay.test.ts` 追加一组（放在 `replayReadout` 那组后面）：

```ts
describe("formatReplayDate / cursorFromDatePick", () => {
  // Daily bars stamped at the exchange's 15:00 CST, i.e. 07:00 UTC.
  const daily = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ timestamp: Date.UTC(2020, 0, 1 + i) + 7 * 3_600_000 }));

  it("15:00 CST 的日线 bar 挑同日不落到前一天", () => {
    const bars = daily(5);
    expect(cursorFromDatePick(bars, "1970-01-01")).toBeNull();
    expect(cursorFromDatePick(bars, "2020-01-01")).toBe(bars[0].timestamp);
    expect(cursorFromDatePick(bars, "2020-01-03")).toBe(bars[2].timestamp);
    expect(cursorFromDatePick(bars, "2030-01-01")).toBe(bars[4].timestamp);
  });

  it("非法串返回 null，不抛", () => {
    const bars = daily(3);
    expect(cursorFromDatePick(bars, "2020-1-1")).toBeNull();
    expect(cursorFromDatePick(bars, "not-a-date")).toBeNull();
  });

  it("读数与日期框互为反函数：显示的那天输回去必须落回同一根", () => {
    const bars = daily(6);
    for (const b of bars) {
      expect(cursorFromDatePick(bars, formatReplayDate(b.timestamp))).toBe(b.timestamp);
    }
  });
});
```

> 往返那条就是这个入口的全部风险：工具条显示的日期输回去落在别的根上，用户就会说"跳到前一天去了"。
> 它在 UTC 与 UTC+8 下都成立（bar 在 07:00 UTC，本地钟点要么 07:00 要么 15:00，同一天）。

- [ ] **Step 4: 页面接线**

模块作用域（跟 `PAGE` 等常量放一起）：

```ts
/** Replay session state. `cursorTs === null` means the chart is live; a non-empty `bars` with
 *  a null cursor is the one-shot post-exit handback waiting to be answered. */
interface ReplaySession {
  bars: KLineData[];
  cursorTs: number | null;
  /** Task 4 owns this flag; everything else only ever clears it. */
  playing: boolean;
}

const IDLE_REPLAY: ReplaySession = { bars: [], cursorTs: null, playing: false };
```

`ProChart` 组件内，`:453` 之后：

```tsx
  // --- Bar Replay（本地定制 ㊺）-----------------------------------------------------------
  // The DataLoader closure is built once per chart (`:864`), so it can only read the ref;
  // `replay` is the mirror the toolbar renders. `syncReplayUi` is the only writer of the
  // mirror, and it derives everything from the ref — the two cannot drift, and a stale
  // closure can never pass an old cursor or `playing` flag forward (Task 4's loop depends
  // on this). See spec §5 for why the cursor is a timestamp.
  const replayRef = useRef<ReplaySession>(IDLE_REPLAY);
  const [replay, setReplay] = useState<{
    active: boolean;
    cursorTs: number | null;
    playing: boolean;
    readout: ReplayReadout | null;
  }>({ active: false, cursorTs: null, playing: false, readout: null });
  const [replaySpeed, setReplaySpeed] = useState<ReplaySpeed>("1");
```

同一层缩进、放在 `setView` 之前：

```tsx
  const syncReplayUi = () => {
    const r = replayRef.current;
    setReplay({
      active: r.cursorTs !== null,
      cursorTs: r.cursorTs,
      playing: r.playing,
      readout: r.cursorTs === null ? null : replayReadout(r.bars, r.cursorTs),
    });
  };

  const enterReplay = (mode: "default" | "viewEdge") => {
    const chart = chartRef.current;
    if (!chart || viewRef.current.timeShare) return;
    // The snapshot *is* the replay universe. Paging in more history is what exiting is for
    // (spec §6 reason 3); a replay that quietly fetched more would move the left edge under
    // the cursor, and the loaded-range readout would be lying.
    const bars = chart.getDataList().slice();
    if (bars.length === 0) return;
    const last = bars[bars.length - 1].timestamp;
    const cursorTs =
      mode === "viewEdge"
        ? (cursorFromView(bars, chart.getVisibleRange().to) ?? last)
        : stepCursor(bars, last, -DEFAULT_REPLAY_BACK);
    replayRef.current = { bars, cursorTs, playing: false };
    syncReplayUi();
    chart.resetData();
  };

  /** Hand the pre-replay range back without a request: one `init` answered from the cache. */
  const exitReplay = () => {
    const chart = chartRef.current;
    const r = replayRef.current;
    if (r.cursorTs === null || !chart) return;
    replayRef.current = { bars: r.bars, cursorTs: null, playing: false };
    syncReplayUi();
    chart.resetData();
  };

  /**
   * Identity changed (period / symbol / 分时): drop the cache rather than hand it back — those
   * bars belong to the outgoing view. No `resetData()` either: every caller is one line from
   * `setPeriod`/`setSymbol`, which reload by themselves, and a second load per switch is what
   * `ProChartPaging.test.tsx` counts.
   */
  const dropReplay = () => {
    const r = replayRef.current;
    if (r.cursorTs === null && r.bars.length === 0) return;
    replayRef.current = IDLE_REPLAY;
    syncReplayUi();
  };

  /** Move the cursor and let the chart re-ask; a `resetData()` per step is the only way to
   *  swap the visible window in v10 (there is no `applyNewData`). */
  const replayStep = (n: number) => {
    const chart = chartRef.current;
    const r = replayRef.current;
    if (!chart || r.cursorTs === null || r.bars.length === 0) return;
    const next = stepCursor(r.bars, r.cursorTs, n);
    if (next === r.cursorTs) return; // already at an end: do not re-init the chart for nothing
    // Playing stops by itself at the newest bar (spec §7), so the flag is recomputed here
    // rather than trusted from whatever render the caller closed over.
    const playing = r.playing && !isReplayExhausted(r.bars, next);
    replayRef.current = { bars: r.bars, cursorTs: next, playing };
    syncReplayUi();
    chart.resetData();
  };

  const pickReplayDate = (iso: string) => {
    const chart = chartRef.current;
    const r = replayRef.current;
    if (!chart || r.cursorTs === null) return;
    const next = cursorFromDatePick(r.bars, iso);
    if (next === null || next === r.cursorTs) return;
    const playing = r.playing && !isReplayExhausted(r.bars, next);
    replayRef.current = { bars: r.bars, cursorTs: next, playing };
    syncReplayUi();
    chart.resetData();
  };
```

DataLoader 分支——`getBars` 体的最前面，`:866`（`const iv = ...`）之前：

```ts
        // Bar Replay owns the chart while it is on: every answer comes out of the snapshot
        // taken at entry, both `more` flags are dead, and no request leaves the page. The gate
        // is structural, not cosmetic — the library reaches for newer bars only at
        // `to === totalBarCount && more.backward` (dist 13601), so `backward: false` makes the
        // future unreachable rather than merely hidden. `forward: false` kills the automatic
        // left-edge request whose in-flight `_loading` (dist 13607) would silently drop the
        // user's next step. See spec §6.
        const session = replayRef.current;
        if (session.cursorTs !== null) {
          callback(type === "init" ? replayWindow(session.bars, session.cursorTs) : [], REPLAY_MORE);
          return;
        }
        if (type === "init" && session.bars.length > 0) {
          // One-shot handback after 退出回放: the pre-replay range goes back on screen with no
          // fetch. `more` matches what a normal `init` answer carries (`shapeResponse` gives
          // forward-only), so paging semantics resume unchanged from there.
          replayRef.current = IDLE_REPLAY;
          callback(session.bars, { forward: true, backward: false });
          return;
        }
```

`setView` 体（`:1092` 的 `const chart = chartRef.current;` 之后）：

```ts
    // A period / 分时 switch changes what the bars *are*, so the replay window cannot follow
    // it (spec §7). `applySymbol` reaches this same line before its `setSymbol`.
    dropReplay();
```

JSX 挂载点（`:1695` 那条分隔线之后，`ƒ 指标公式` 按钮之前）：

```tsx
        <ReplayBar
          active={replay.active}
          disabled={timeShare}
          reason={timeShare ? "分时只有一节 session，没有可回放的历史" : null}
          playing={replay.playing}
          speed={replaySpeed}
          readout={replay.readout}
          cursorLabel={replay.cursorTs === null ? null : formatReplayDate(replay.cursorTs)}
          onStart={enterReplay}
          onStop={exitReplay}
          onStep={replayStep}
          onTogglePlay={toggleReplayPlay}
          onSpeed={setReplaySpeed}
          onPickDate={pickReplayDate}
        />
```

`toggleReplayPlay` 到 Task 4 才有实现。本任务先写：

```tsx
  // Task 4 replaces this with the setTimeout playback loop.
  const toggleReplayPlay = () => undefined;
```

**不要**在这里提前把播放循环一起写了：步进与播放的判据不同（前者测"窗口是否只含过去"，后者测
"计时与自动停"），合在一起做会让"回放全程零请求"那条断言失去独立性。

Task 2 的组件还要补一处：读数那个 `<span>` 加上 `data-testid="replay-readout"`（上面 Step 1 的测试
靠它取日期）。改 `ReplayBar.tsx` 里
`<span className="text-xs text-muted-foreground">回放中…` 为
`<span data-testid="replay-readout" className="text-xs text-muted-foreground">`，并在
`ReplayBar.test.tsx` 里补一条 `expect(screen.getByTestId("replay-readout").textContent).toContain("2025-09-30")`。

- [ ] **Step 5: 跑测试到绿**

Run: `cd frontend && npx vitest run src/pages/__tests__/ProChartReplay.test.tsx src/lib/__tests__/barReplay.test.ts`
Expected: 全通过。跑完立刻跑姊妹文件，确认这次接线没把分页契约改掉：
`npx vitest run src/pages/__tests__/ProChartPaging.test.tsx src/lib/__tests__/klinePaging.test.ts`
Expected: `ProChartPaging` 仍 3 例全绿（它数请求；"交回 cache"若多打一个请求，这里必红）。
再 `cd frontend && npx tsc --noEmit` 静默。

- [ ] **Step 6: 变异复验（证明门真的会红）**

依次三个探针，每次跑完还原，**都不提交**：
① 把 `REPLAY_MORE` 的 `backward` 改成 `true` ⇒ "forward / backward 各收到一次空答"必红（两旗不再全 false）。
② 把回放分支的 `type === "init" ? replayWindow(...) : []` 改成"不分 type一律答 `replayWindow`" ⇒
   同一条必红（forward 收到了一段前缀而不是空答）。
③ 注释掉 `dropReplay()` 那一行 ⇒ "换周期与切分时一律退出回放"必红。
本仓纪律：新门先用假实现证明可红，再断真实现下的绿（`verify-mutation-probe-blindness`）。

- [ ] **Step 7: 提交**

```bash
cd frontend && npx tsc --noEmit
git add -- frontend/src/lib/barReplay.ts frontend/src/lib/__tests__/barReplay.test.ts frontend/src/components/charts/ReplayBar.tsx frontend/src/components/charts/__tests__/ReplayBar.test.tsx frontend/src/pages/ProChart.tsx frontend/src/pages/__tests__/ProChartReplay.test.tsx
git commit -s -m "feat(barReplay): ProChart 接线——快照即回放全集、回放态零请求、退出一次性交回 cache" -- frontend/src/lib/barReplay.ts frontend/src/lib/__tests__/barReplay.test.ts frontend/src/components/charts/ReplayBar.tsx frontend/src/components/charts/__tests__/ReplayBar.test.tsx frontend/src/pages/ProChart.tsx frontend/src/pages/__tests__/ProChartReplay.test.tsx
```

---

### Task 4: 自动播放循环

**Files:**
- Modify: `frontend/src/pages/ProChart.tsx`（把 `toggleReplayPlay` 的占位换成实现 ＋ 一个 effect ＋ 一个 visibility 监听）
- Test: Modify `frontend/src/pages/__tests__/ProChartReplay.test.tsx`（追加一个 `describe`）

**Interfaces:**
- Consumes: Task 1 的 `paceMs` / `isReplayExhausted`、Task 3 的 `replayRef`（含 `playing` 字段）与 `syncReplayUi`
- Produces: `toggleReplayPlay()`；`replay.playing` 为真时 `<ReplayBar />` 的按钮文字变「暂停」

- [ ] **Step 1: 追加失败测试**

在 `ProChartReplay.test.tsx` 末尾追加（**注意**：`mountLoaded()` 里 `settle()` 依赖真实定时器，
所以每台测试都是"先挂载、再 `vi.useFakeTimers()`"，收尾 `vi.useRealTimers()`）：

```tsx
describe("/pro-chart 自动播放", () => {
  it("1× 就是一秒一根：推进 3500 ms 恰好走 3 根", async () => {
    await mountLoaded();
    await click("回放");
    const start = h.list.length;
    await click("播放");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    expect(h.list.length).toBe(start + 3);
    expect(visible()).toEqual(allowedByDay(readoutDayEnd()));
    vi.useRealTimers();
  });

  it("倍速查表：4× 时同样的 3500 ms 走 14 根", async () => {
    await mountLoaded();
    await click("回放");
    const start = h.list.length;
    await click("4×");
    await click("播放");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3500);
    });
    expect(h.list.length).toBe(start + 14);
    vi.useRealTimers();
  });

  it("到达末根自己停：playing 回 false，再推进也不动", async () => {
    await mountLoaded();
    await click("从视图右端开始"); // 游标已在末根
    const btn = buttonOf("播放");
    expect(btn.hasAttribute("disabled")).toBe(true);
    await click("前一根");
    await click("播放");
    const reached = h.list.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DAY * 1000); // 远超走完剩余根数所需
    });
    expect(h.list.length).toBe(reached); // 停在末根，不再动
    expect(screen.getByRole("button", { name: "播放" })).toBeTruthy();
    vi.useRealTimers();
  });

  it("切到后台就暂停，切回来保持暂停（不补跑一堆帧）", async () => {
    await mountLoaded();
    await click("回放");
    await click("播放");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2500);
    });
    const at = h.list.length;
    const spy = vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(h.list.length).toBe(at); // 暂停生效
    spy.mockRestore();
    await act(async () => {
      document.dispatchEvent(new Event("visibilitychange"));
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(h.list.length).toBe(at); // 回来了也不自动续播
    expect(screen.getByRole("button", { name: "播放" })).toBeTruthy();
    vi.useRealTimers();
  });

  it("播放中每个步进仍是一次 init、零请求", async () => {
    await mountLoaded();
    const before = h.requests.length;
    await click("回放");
    await click("播放");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(h.requests.length).toBe(before);
    vi.useRealTimers();
  });
});
```

Run: `npx vitest run src/pages/__tests__/ProChartReplay.test.tsx`
Expected: 新增 5 例全红（`播放` 点了不动——`toggleReplayPlay` 还是 `() => undefined`）。

- [ ] **Step 2: 实现播放循环**

把 Task 3 的占位换成：

```tsx
  // Playback is a `setTimeout` chain, not `setInterval`: one step's `resetData()` costs a
  // variable amount of time, and a fixed interval would stack in-flight steps on top of each
  // other. Not `requestAnimationFrame` either — a background tab does not run rAF at all, and
  // leaving this playing unattended is the point of the feature (spec §7).
  useEffect(() => {
    if (!replay.playing) return;
    let timer: number | null = null;
    const tick = () => {
      timer = null;
      const r = replayRef.current;
      if (r.cursorTs === null) return;
      if (isReplayExhausted(r.bars, r.cursorTs)) {
        replayRef.current = { ...r, playing: false };
        syncReplayUi();
        return;
      }
      replayStep(1);
      timer = window.setTimeout(tick, paceMs(replaySpeed));
    };
    timer = window.setTimeout(tick, paceMs(replaySpeed));
    return () => {
      if (timer !== null) window.clearTimeout(timer);
    };
    // `replaySpeed` in the deps means a mid-play speed change takes effect on the next tick
    // by restarting the countdown, which is what the toolbar's click looks like.
  }, [replay.playing, replaySpeed]);

  const toggleReplayPlay = () => {
    const r = replayRef.current;
    if (r.playing) {
      replayRef.current = { ...r, playing: false };
      syncReplayUi();
      return;
    }
    // Nothing to play if the cursor is already on the newest loaded bar.
    if (r.cursorTs === null || isReplayExhausted(r.bars, r.cursorTs)) return;
    replayRef.current = { ...r, playing: true };
    syncReplayUi();
  };
```

**为什么循环体只读 ref、不读 `replay` state**：effect 的闭包停在 `[replay.playing, replaySpeed]`
那一次渲染，此后 `replay.cursorTs` 永远是旧值；游标、`playing`、`bars` 一律从 `replayRef.current`
现取。这正是 Task 3 第 2 条裁定（镜像只有一个写入口、且从 ref 现算）要买的东西。

**为什么暂停不写在 `tick` 里**：`visibilitychange` 要在"用户根本没点暂停"的情况下也停下来，
而停下这件事只有一种写法——把 ref 的 `playing` 置 false 后 `syncReplayUi()`，让 effect 的 cleanup
去清那个还没触发的 timer。别在 `tick` 里加 `if (hidden) return`，那会让按钮文字仍是「播放」。

组件内再加一个 effect（放在上面那个之后）：

```tsx
  // A hidden tab is a tab nobody is watching: pause, and *stay* paused when they come back, so
  // the chart shows where it stopped instead of bursting through the catch-up frames.
  useEffect(() => {
    const onHide = () => {
      const r = replayRef.current;
      if (document.visibilityState !== "hidden" || !r.playing) return;
      replayRef.current = { ...r, playing: false };
      syncReplayUi();
    };
    document.addEventListener("visibilitychange", onHide);
    return () => document.removeEventListener("visibilitychange", onHide);
  }, []);
```

- [ ] **Step 3: 跑绿**

Run: `cd frontend && npx vitest run src/pages/__tests__/ProChartReplay.test.tsx`
Expected: 全通过（Task 3 的 10 例 ＋ 本任务 5 例）。
若 fake timers 把页面别的定时器一起冻住导致**别的**文件变红，先确认 `vi.useRealTimers()` 在每条用例
尾部都跑到了（本文件的 fake timer 只在 `describe` 内部按需开，不放在全局 `beforeEach`）。
**不要**为了绕开它就 mock 掉无关模块。

- [ ] **Step 4: 变异复验**

① 把 `paceMs(replaySpeed)` 硬编码成 `1000` ⇒ "4× 走 14 根"必红。
② 删掉 `tick` 里的 `isReplayExhausted` 分支 ⇒ "到达末根自己停"必红（会一直重复末根的 `resetData`）。
③ 把 visibility 那个 effect 的 `syncReplayUi()` 去掉 ⇒ "切到后台就暂停"必红。
每次都还原，不提交。

- [ ] **Step 5: 提交**

```bash
cd frontend && npx tsc --noEmit
git add -- frontend/src/pages/ProChart.tsx frontend/src/pages/__tests__/ProChartReplay.test.tsx
git commit -s -m "feat(barReplay): 自动播放——setTimeout 链而非 rAF，倍速查表，末根自停，后台暂停不续播" -- frontend/src/pages/ProChart.tsx frontend/src/pages/__tests__/ProChartReplay.test.tsx
```

---

### Task 5: 未来画线隐藏与还原

**Files:**
- Modify: `frontend/src/pages/ProChart.tsx`（`applyFutureDrawings` ＋ 四个调用点）
- Test: Create `frontend/src/pages/__tests__/ProChartReplayDrawings.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `isFutureDrawing`、`chart.getOverlays()`、`chart.overrideOverlay({ id, visible })`
- Produces: `applyFutureDrawings(chart, cursorTs | null)`（页面内部）

**为什么单独一个文件**：`ProChartReplay.test.tsx` 的替身要给 `getOverlays` 喂真形状
（`{ id, points, name, paneId }`），而数据通路那 15 例不该跟着画线替身的形状一起抖。

**必须先读**：`chartDrawings.ts:20-45`（`serializeDrawings` 把 `points` 原样收下来）、
`chartDrawings.ts:48-57`（文件头那条 `visible` 能被 `overrideOverlay` 生效、`lock` 不行的注释）、
`ProChart.tsx:844`（`bankDrawings` 读 `serializeDrawings(chart.getOverlays())`，**不按名字过滤**）。

- [ ] **Step 1: 写失败测试**

创建 `frontend/src/pages/__tests__/ProChartReplayDrawings.test.tsx`，替身块照
`ProChartReplay.test.tsx` 抄，只把 `getOverlays` 换成返回下面这三条线，并让 `saveDrawings`／
`loadDrawings` 走 spy：

```tsx
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProChart } from "../ProChart";

/**
 * Drawings during replay (spec §8).
 *
 * Two contracts, and the second one is the reason this file exists:
 *
 * 1. A line with any anchor after the cursor is a visual lookahead — hide it while the cursor
 *    is behind it, show it again once the replay reaches it.
 * 2. Hiding and restoring must never touch storage. `serializeDrawings(chart.getOverlays())`
 *    banks the *whole* overlay list with no name filter (ProChart.tsx:844), so a single bank
 *    fired mid-replay would persist `visible: false` as the user's own hidden line, and it
 *    would still be hidden after exit, after a reload, and in the `.json` / `?d=` export.
 */

const DAY = 86_400_000;
const START = Date.UTC(2020, 0, 1);
const PAGE = 500;
const TOTAL = 1200;

interface Bar { timestamp: number; open: number; high: number; low: number; close: number; volume: number }

const ALL_BARS: Bar[] = Array.from({ length: TOTAL }, (_, i) => ({
  timestamp: START + i * DAY, open: 1, high: 1, low: 1, close: 1, volume: 1,
}));

/** Two lines fully in the past, one reaching 200 bars past the entry cursor. */
const ENTRY_CURSOR = ALL_BARS[TOTAL - 251].timestamp; // stepCursor(..., -250) from the newest
const OVERLAYS = [
  { id: "past-1", name: "segment", points: [{ timestamp: ALL_BARS[10].timestamp }, { timestamp: ALL_BARS[20].timestamp }] },
  { id: "past-2", name: "priceLine", points: [{ timestamp: ALL_BARS[300].timestamp }] },
  { id: "future", name: "segment", points: [{ timestamp: ALL_BARS[900].timestamp }, { timestamp: ALL_BARS[1000].timestamp }] },
];

const h = vi.hoisted(() => ({
  list: [] as Array<{ timestamp: number }>,
  more: { forward: false, backward: false },
  requests: [] as string[],
  overlays: [] as Array<{ id: string; name: string; visible?: boolean; points: Array<{ timestamp?: number }> }>,
  overrides: [] as Array<{ id?: string; visible?: boolean }>,
  saved: 0,
  inFlight: 0,
  askedType: "",
  loader: null as null | {
    getBars: (p: {
      type: string; timestamp: number | null;
      period: { type: string; span: number }; symbol: { ticker: string };
      callback: (data: unknown[], more?: unknown) => void;
    }) => void | Promise<void>;
  },
}));

// addData / ask / settle / buttonOf / click：与 ProChartReplay.test.tsx 同名同体，逐字抄过来。
// 差异只有三处：getOverlays 返回上面那三条、overrideOverlay 往 h.overrides 记一笔、
// chartDrawings 的 saveDrawings 被 mock 成 () => { h.saved += 1; }。
```

> 上面这段是**指针不是代码**：`addData` / `ask` / `settle` / `buttonOf` / `click` 五个函数与
> `vi.mock("klinecharts")`、`vi.mock("@/lib/marketApi")` 两块从 `ProChartReplay.test.tsx` 逐字复制，
> 只改 `getOverlays`（返回 `h.overlays`，初值 `OVERLAYS`）、`overrideOverlay`（记进 `h.overrides`）与新增
> `vi.mock("@/lib/chartDrawings", ...)`：`saveDrawings: () => { h.saved += 1; }`，其余成员
> （`loadDrawings`／`serializeDrawings`／`restoreDrawings`／`listDrawings`／`bankDrawings`）用
> `importOriginal` 拿真实现。
>
> **就按复制办，不抽公共替身模块。** 本仓已经各有一份：`ProChartPaging` / `ProChartTimeShare` /
> `ProChartDrawings` 三个页面测试各自自带 chart 双身，它们的判据互相独立。抽一份共用的要改动
> 既有文件，超出本片范围（Global Constraints 第 2 条），而且共用替身会让"某个测试改双身，另一个
> 跟着变红"这种耦合长出来——那正是这三个文件现在各带一份的理由。

用例（这部分是真代码，逐条写进去）：

```tsx
describe("/pro-chart 回放中的画线", () => {
  it("进入回放：只有锚点越过游标的那条被隐藏", async () => {
    await mountLoaded();
    h.overrides = [];
    await click("回放");
    expect(h.overrides.map((o) => [o.id, o.visible])).toEqual([["future", false]]);
  });

  it("游标推进到覆盖它之后：那条被还原成可见", async () => {
    await mountLoaded();
    await click("回放");
    h.overrides = [];
    // 快进 10 根 × 7 次：游标从第 949 根推到第 1019 根，越过这条线的第二个锚点（第 1000 根）。
    for (let i = 0; i < 7; i++) await click("快进 10 根");
    expect(h.overrides.filter((o) => o.id === "future" && o.visible === true).length).toBeGreaterThan(0);
    // 另外两条从头到尾没被碰过
    expect(h.overrides.some((o) => o.id === "past-1" || o.id === "past-2")).toBe(false);
  });

  it("退出回放：全部还原可见", async () => {
    await mountLoaded();
    await click("回放");
    h.overrides = [];
    await click("退出回放");
    expect(h.overrides.map((o) => [o.id, o.visible])).toEqual([["future", true]]);
  });

  it("全程没有写过画线存储（最重要的一条）", async () => {
    await mountLoaded();
    h.saved = 0;
    await click("回放");
    for (let i = 0; i < 20; i++) await click("后一根");
    await click("退出回放");
    expect(h.saved).toBe(0);
  });

  it("用户自己手动隐藏的线不许被点亮：只还原自己隐过的", async () => {
    await mountLoaded();
    // 一条锚点在未来、但用户已经手动隐藏的线
    const userHidden = { id: "mine", name: "priceLine", visible: false, points: [{ timestamp: ALL_BARS[1100].timestamp }] };
    h.overlays = [...OVERLAYS, userHidden];
    await click("回放");
    h.overrides = [];
    await click("退出回放");
    // `mine` 被隐过一次（进入时它就是未来线），但退出时不该被点亮
    expect(h.overrides.some((o) => o.id === "mine" && o.visible === true)).toBe(false);
  });
});
```

Run: `npx vitest run src/pages/__tests__/ProChartReplayDrawings.test.tsx`
Expected: 全红（没有 `applyFutureDrawings`，`h.overrides` 恒空）。

- [ ] **Step 2: 实现**

`ProChart.tsx`，组件内：

```tsx
  // Overlays this page hid *itself*, so leaving replay can put them back without touching a
  // line the user hid by hand (`chartDrawings` stores `visible`, and `overrideOverlay` does
  // honour it — unlike `lock`; see the header note there).
  const hiddenByReplayRef = useRef<Set<string>>(new Set());

  /**
   * Hide the drawings that reach past the cursor. `null` cursor means replay is off: restore
   * everything this function hid and nothing else.
   *
   * Nothing here writes storage. The bank path (`serializeDrawings(chart.getOverlays())`)
   * takes the whole overlay list with no name filter, so a bank fired mid-hide would persist
   * `visible: false` as the user's own hidden line — surviving exit, reload and export.
   */
  const applyFutureDrawings = (chart: Chart, cursorTs: number | null) => {
    const overlays = chart.getOverlays() as Array<{
      id?: string;
      visible?: boolean;
      points?: Array<{ timestamp?: number }>;
    }>;
    for (const o of overlays) {
      if (typeof o.id !== "string") continue;
      const future = cursorTs !== null && isFutureDrawing(o.points ?? [], cursorTs);
      // A line the user hid by hand (`visible: false` on the instance, d.ts 1077) must not
      // enter the bookkeeping: hiding it again is a no-op, but the matching restore on exit
      // would light it up and overwrite a deliberate choice.
      if (future && !hiddenByReplayRef.current.has(o.id) && o.visible !== false) {
        chart.overrideOverlay({ id: o.id, visible: false });
        hiddenByReplayRef.current.add(o.id);
      } else if (!future && hiddenByReplayRef.current.has(o.id)) {
        chart.overrideOverlay({ id: o.id, visible: true });
        hiddenByReplayRef.current.delete(o.id);
      }
    }
  };
```

四个调用点（每处一行）：

```tsx
    // enterReplay：写完 replayRef 与 syncReplayUi 之后、chart.resetData() 之前
    applyFutureDrawings(chart, cursorTs);

    // replayStep：改完游标之后、chart.resetData() 之前
    applyFutureDrawings(chart, next);

    // pickReplayDate：同上，用 next

    // exitReplay：chart.resetData() 之前
    applyFutureDrawings(chart, null);
```

`dropReplay()` 也要收尾——身份变更时那张图马上要被换掉，`getOverlays()` 的内容不再是同一批线，
所以只清记账、不去还原：

```tsx
    // The outgoing view's overlays are about to be swapped for another symbol's set; there is
    // nothing left to restore, and restoring against the *new* list would light up a line the
    // user hid by hand.
    hiddenByReplayRef.current.clear();
```

放在 `dropReplay()` 的 `replayRef.current = IDLE_REPLAY;` 之后。

- [ ] **Step 3: 跑绿**

Run: `cd frontend && npx vitest run src/pages/__tests__/ProChartReplayDrawings.test.tsx src/pages/__tests__/ProChartReplay.test.tsx`
Expected: 全通过。再跑既有画线面确认没碰坏：
`npx vitest run src/pages/__tests__/ProChartDrawings.test.tsx src/lib/__tests__/chartDrawings.test.ts`
Expected: 两文件仍全绿（用例数以实际运行为准，登记进提交说明）。

- [ ] **Step 4: 变异复验**

① 把 `hiddenByReplayRef` 换成"退出时无条件把所有 overlay 设 `visible:true`" ⇒
   "用户自己手动隐藏的线不许被点亮"必红。
② 把 `applyFutureDrawings` 里两个分支的判断反一下（`future` 时还原） ⇒ 第一条必红。
③ 在 `applyFutureDrawings` 末尾加一行 `bankDrawings(chart, symbol, interval)` ⇒
   "全程没有写过画线存储"必红（这条探针专门用来证明那条判据不是空话，用完即撤）。

- [ ] **Step 5: 提交**

```bash
cd frontend && npx tsc --noEmit
git add -- frontend/src/pages/ProChart.tsx frontend/src/pages/__tests__/ProChartReplayDrawings.test.tsx
git commit -s -m "feat(barReplay): 回放期隐藏越界画线——只还原自己隐过的、全程不写画线存储" -- frontend/src/pages/ProChart.tsx frontend/src/pages/__tests__/ProChartReplayDrawings.test.tsx
```

---

### Task 6: 「前缀 == 全量」重绘守卫 harness

**Files:** Create `frontend/src/lib/__tests__/pineNoLookahead.test.ts`
**Interfaces:** Consumes `compilePine`（`lib/pineScript.ts:177`）、语料目录（同 `pineAlertCorpus.test.ts` 的 `CORPUS_DIR` 解析法）

- [ ] **Step 1:** 写 harness 骨架：合成一段 300 根、含趋势与跳空的确定 bar 序列；对每个脚本、每个 `k ∈ {60, 120, 180, 240, 299}` 断 `compilePine(src, bars.slice(0,k))` 的每条 line / 每个 marker / 每条 hline / 每个 drawing 与 `compilePine(src, bars)` 的**前 k 项**逐项相等（`na` 位置也算）。
- [ ] **Step 2:** **canary 先行**：故意在断言里把"前 k 项"写成"前 k+1 项"或把某条 line 末位改一个值，确认门会红（本仓纪律：新门先用假期望值证明可红，再改回真值）。
- [ ] **Step 3:** 跑真实语料，打印 `[no-lookahead] scripts=N passed=M mismatched=K crashed=C` + top-10 差异说明。
- [ ] **Step 4:** `request.security` 多周期单独一档：先实测 HTF 序列在输入 bar 截断时是否同步裁（`pineTypes.ts:333-341` 的 `PineBars` 是预建数组）。**若读到未来 HTF bar，那是引擎缺陷：如实标红并单独立项，不许把该脚本从 harness 里摘出去。** 若确实同步，就在该档加下限断言。
- [ ] **Step 5:** 定下限：`crashed === 0`、非 MTF 档 `mismatched === 0`（0 容差——这条不是覆盖率指标，是正确性判据）；MTF 档按 Step 4 的实测结果定，并把"为什么是这个数"写进文件头。
- [ ] **Step 6:** 提交（含 harness 文件与实测读数在提交说明里）。

---

### Task 7: 全量门禁 + 浏览器活体验收

- [ ] **Step 1:** `cd frontend && npx tsc --noEmit`；`npx vitest run`；`npx vite build`（记录文件数/例数/构建耗时，逐字写进提交说明）。
- [ ] **Step 2:** `python -X utf8 -m pytest tools/test_wiki_drift.py -q`、`python -X utf8 tools/wiki_drift.py stale --format count`、`bash tools/wiki_freshness_gate.sh`、`bash tools/ci_grep_gates.sh`。水位门预期仍 rc=1（443 > 439，继承自 `1efc1cc1`），**不许动 `WIKI_STALE_MAX`**（只降不升）。
- [ ] **Step 3:** 起 dev server（8000 后端已在跑则不要重启、不要杀），真实浏览器打开 `/pro-chart`，600519.SH 日线：进入回放 → 单步 20 根 → 播放 → 读数与 `chart.getDataList()` 右端逐位比对（React fiber 取实例）→ 确认内置 MA 与一个 Pine 副图只画到游标 → 确认未来画线隐藏、退出还原 → 换标的自动退出。取证手法见 Repo Wiki 的 canvas 条目（后台标签页 rAF 不跑、`setTimeout` 钳 1 s）。
- [ ] **Step 4:** 用 spec 第十二节那五步做未来函数自查，逐步记录实际观察值；发现任何"先画出来又改掉"按脚本名登记为缺陷，不改判据。
- [ ] **Step 5:** 缺陷若修，回到对应任务补测试（红→绿→变异复验）后再收口。

---

### Task 8: 落档 §7.14

- [ ] **Step 1:** 找坐标、盘交付形状（`git log`/`git diff --numstat <base>..HEAD`、逐文件 `git cat-file -e upstream/main:<f>` 判 fork-only）。
- [ ] **Step 2:** 按 `项目档案.md` 一轮一节的配方在 **bytes 层按 CRLF** 追加 §7.14（工作树纯 CRLF、blob LF、根目录无 `.gitattributes`），断言"旧内容前缀逐字节保留"＋CR 数 == LF 数＋lone LF == 0。
- [ ] **Step 3:** 复跑 `tools/test_wiki_drift.py` 与 `tools/wiki_freshness_gate.sh`（改档案必须复跑读它的门），轮内读数只写进那笔提交说明，不署成基座坐标。
- [ ] **Step 4:** `git add -- 项目档案.md && git commit -s -m "docs(archive): §7.14 Bar Replay 落档——截断式窗口的盘面证据＋零网络结构断言" -- 项目档案.md`，pathspec 必带。
