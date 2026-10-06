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
 *    banks the *whole* overlay list with no name filter (`ProChart.tsx:912` `bankDrawings`), so
 *    a single bank fired mid-replay would persist `visible: false` as the user's own hidden
 *    line, and it would still be hidden after exit, after a reload, and in the `.json` / `?d=`
 *    export.
 *
 * The chart double is `ProChartReplay.test.tsx`'s (the data path is not this file's subject, but
 * entering replay *is* a data-path action, so the double has to answer like the library). Three
 * differences only: `getOverlays()` hands back real overlay shapes, `overrideOverlay` applies to
 * those instances *and* records the call, and `chartDrawings.saveDrawings` is counted.
 *
 * Why a separate file rather than more cases in `ProChartReplay.test.tsx`: that file's double
 * would now have to carry the overlay shape too, and the fifteen data-path cases would start
 * trembling whenever a drawing fixture changed. Each file owns the double it asserts against.
 */

const DAY = 86_400_000;
// Midnight UTC, so bar N is exactly START + N days in any CI timezone.
const START = Date.UTC(2020, 0, 1);
const PAGE = 500;
const TOTAL = 1200;

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

/** Two lines fully in the past, one reaching 200 bars past the entry cursor. */
// `enterReplay` takes `stepCursor(bars, last, -DEFAULT_REPLAY_BACK)`, i.e. index 949 of 1200.
const ENTRY_CURSOR = ALL_BARS[TOTAL - 251].timestamp; // stepCursor(..., -250) from the newest
const OVERLAYS = [
  {
    id: "past-1",
    name: "segment",
    points: [{ timestamp: ALL_BARS[10].timestamp }, { timestamp: ALL_BARS[20].timestamp }],
  },
  { id: "past-2", name: "priceLine", points: [{ timestamp: ALL_BARS[300].timestamp }] },
  {
    id: "future",
    name: "segment",
    points: [{ timestamp: ALL_BARS[900].timestamp }, { timestamp: ALL_BARS[1000].timestamp }],
  },
];

type OverlayState = { id: string; name: string; visible?: boolean; points: Array<{ timestamp?: number }> };

const h = vi.hoisted(() => ({
  list: [] as Array<{ timestamp: number }>,
  more: { forward: false, backward: false },
  requests: [] as string[],
  overlays: [] as Array<{ id: string; name: string; visible?: boolean; points: Array<{ timestamp?: number }> }>,
  overrides: [] as Array<{ id?: string; visible?: boolean }>,
  saved: 0,
  // The buckets `saveDrawings` was handed, so a test can read what *would* have been stored
  // instead of only how often (contract 2 above is about the content, not the call count).
  banked: [] as Array<{ symbol: string; interval: string; drawings: Array<Record<string, unknown>> }>,
  inFlight: 0,
  askedType: "",
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

/** `StoreImp._addData`, the same three cases `ProChartReplay.test.tsx` models. */
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
 * `inFlight` drops there too.
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
    // The overlays the page is allowed to see, in the shape `getOverlays()` really answers
    // (`{ id, name, paneId, points, visible, … }`) — `applyFutureDrawings` reads `points` and
    // `visible` off them, and `serializeDrawings` reads the same two.
    getOverlays: () => h.overlays,
    getPaneOptions: () => [],
    setPaneOptions: vi.fn(),
    getOffsetRightDistance: () => 0,
    setOffsetRightDistance: vi.fn(),
    getBarSpace: () => ({ bar: 8, halfBar: 4, gapBar: 5, halfGapBar: 2 }),
    setBarSpace: vi.fn(),
    getVisibleRange: () => ({ from: 0, to: h.list.length, realFrom: 0, realTo: h.list.length }),
    // `StoreImp.overrideOverlay` -> `getOverlaysByFilter` (dist 14285-14298): no id means the
    // filter matches *every* overlay, so that is modelled too rather than assumed away.
    //
    // The answer is deliberately `false` even though the change is applied: this repo's recorded
    // experience of a flag-only override is exactly that asymmetry, and the note at the top of
    // `chartDrawings.ts` (⑤, "Trust the instance, not the return value") is the standing rule.
    // A page that gated its bookkeeping on that boolean therefore cannot pass here.
    overrideOverlay: (o: { id?: string; visible?: boolean }) => {
      h.overrides.push({ id: o.id, visible: o.visible });
      const targets = o.id === undefined || o.id === null ? h.overlays : h.overlays.filter((x) => x.id === o.id);
      for (const target of targets) {
        if ("visible" in o) target.visible = o.visible;
      }
      return false;
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
      h.requests.push(h.askedType);
      return { bars, source: "fake", symbol: "600519.SH", interval: "1D", ok: true };
    },
  };
});

// Only the storage write is counted; the read/serialize side stays the real thing, because
// contract 2 is about what the real `serializeDrawings` would have put in the bucket.
vi.mock("@/lib/chartDrawings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/chartDrawings")>();
  return {
    ...actual,
    saveDrawings: (symbol: string, interval: string, drawings: readonly Record<string, unknown>[]) => {
      h.saved += 1;
      h.banked.push({ symbol, interval, drawings: drawings.slice() });
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

/** The overlay instance behind an id — the state the library actually holds. */
const inst = (id: string): OverlayState | undefined => h.overlays.find((o) => o.id === id);

async function mountLoaded() {
  const view = render(<ProChart />);
  await settle();
  expect(h.list.length).toBe(TOTAL); // the whole fake history is on the chart
  return view;
}

/** A fresh copy per test: `overrideOverlay` mutates the instances it is aimed at. */
const freshOverlays = (): OverlayState[] =>
  OVERLAYS.map((o) => ({ ...o, points: o.points.map((p) => ({ ...p })) }));

beforeEach(() => {
  h.list = [];
  h.more = { forward: false, backward: false };
  h.requests = [];
  h.overlays = freshOverlays();
  h.overrides = [];
  h.saved = 0;
  h.banked = [];
  h.inFlight = 0;
  h.askedType = "";
  h.loader = null;
  localStorage.clear();
});

describe("/pro-chart 回放中的画线", () => {
  it("进入回放：只有锚点越过游标的那条被隐藏", async () => {
    await mountLoaded();
    // Non-vacuity of the fixture: this really is the line the entry cursor sits behind.
    expect(ALL_BARS[1000].timestamp).toBeGreaterThan(ENTRY_CURSOR);
    h.overrides = [];
    await click("回放");
    expect(h.overrides.map((o) => [o.id, o.visible])).toEqual([["future", false]]);
    // The instance, not the call: `overrideOverlay`'s answer is not a verdict (see the double).
    expect(inst("future")?.visible).toBe(false);
    expect(inst("past-1")?.visible).not.toBe(false);
    expect(inst("past-2")?.visible).not.toBe(false);
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
    // And the chart is left holding the line in the state the cursor allows.
    expect(inst("future")?.visible).toBe(true);
  });

  it("退出回放：全部还原可见", async () => {
    await mountLoaded();
    await click("回放");
    h.overrides = [];
    await click("退出回放");
    expect(h.overrides.map((o) => [o.id, o.visible])).toEqual([["future", true]]);
    expect(inst("future")?.visible).toBe(true);
  });

  it("全程没有写过画线存储（最重要的一条）", async () => {
    await mountLoaded();
    h.saved = 0;
    await click("回放");
    for (let i = 0; i < 20; i++) await click("后一根");
    await click("退出回放");
    expect(h.saved).toBe(0);
  });

  // The identity-change exit (spec §7): 换周期 goes through `dropReplay`, which forgets the
  // bookkeeping — so the hides have to be put back *before* that, while the overlay list on the
  // chart is still the outgoing view's. Otherwise the outgoing bucket's bank (or the reload of
  // that symbol later) is left holding a `hidden: true` the user never chose.
  it("换周期那一途：隐过的线在记账清掉之前放回原样", async () => {
    await mountLoaded();
    await click("回放");
    expect(inst("future")?.visible).toBe(false);
    h.overrides = [];
    await click("60分");
    expect(h.overrides.map((o) => [o.id, o.visible])).toEqual([["future", true]]);
    expect(inst("future")?.visible).toBe(true);
    expect(inst("past-1")?.visible).not.toBe(false);
  });

  it("用户自己手动隐藏的线不许被点亮：只还原自己隐过的", async () => {
    await mountLoaded();
    // 一条锚点在未来、但用户已经手动隐藏的线
    const userHidden = {
      id: "mine",
      name: "priceLine",
      visible: false,
      points: [{ timestamp: ALL_BARS[1100].timestamp }],
    };
    h.overlays = [...freshOverlays(), userHidden];
    await click("回放");
    // Not even poked on the way in: hiding a line that is already hidden is a no-op, and the
    // bookkeeping has to stay empty so the exit below has nothing to light up.
    expect(h.overrides.some((o) => o.id === "mine")).toBe(false);
    h.overrides = [];
    await click("退出回放");
    // `mine` 被隐过一次（进入时它就是未来线），但退出时不该被点亮
    expect(h.overrides.some((o) => o.id === "mine" && o.visible === true)).toBe(false);
    expect(inst("mine")?.visible).toBe(false);
  });

  // The storage half of contract 2, which the count above cannot see: a bank that fires *while*
  // a hide is in effect is legitimate page behaviour — leaving the route runs the teardown bank,
  // dragging a still-visible line runs the edit bank. What must never happen is that the hide
  // rides along into that write, because the stored copy is what the next reload restores.
  it("退出前卸载：落库的那份不带回放隐的痕", async () => {
    const view = await mountLoaded();
    await click("回放");
    expect(inst("future")?.visible).toBe(false);
    await act(async () => {
      view.unmount();
    });
    // The teardown really did bank (that is `ProChartDrawings.test.tsx`'s contract, not a bug).
    expect(h.saved).toBeGreaterThan(0);
    const banked = h.banked[h.banked.length - 1];
    const line = banked.drawings.find((d) =>
      (d.points as Array<{ timestamp?: number }> | undefined)?.some(
        (p) => p.timestamp === ALL_BARS[1000].timestamp,
      ),
    );
    expect(line).toBeTruthy();
    // `serializeDrawings` writes `hidden: true` for an instance at `visible: false`; a stored
    // `hidden` here is the transient hide becoming the user's own choice.
    expect(line?.hidden).toBeUndefined();
    // …and it was fixed on the snapshot copy, not by un-hiding the chart as a side effect.
    expect(h.overrides.some((o) => o.visible === true)).toBe(false);
  });
});
