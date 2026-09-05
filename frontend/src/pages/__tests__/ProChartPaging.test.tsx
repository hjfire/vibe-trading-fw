import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProChart } from "../ProChart";

/**
 * Paging contract of /pro-chart, driven through the real component (⑬).
 *
 * The report from the user was: press and drag the main chart and it jumps back
 * to where it started, and will not settle. That is not a mouse-handling bug —
 * the DataLoader answered a `backward` request (which KLineChart v10 uses for
 * *newer* bars) with *older* bars, the library appended them, shifted the view
 * by the number of bars it received, and asked again forever.
 *
 * A jsdom test cannot exercise the library's canvas panning, so it reproduces
 * the part that actually broke: the request/response contract. `fakeChart`
 * below re-implements `StoreImp._addData` + the edge triggers verbatim (see
 * `klinePaging.ts` for the source line numbers), so if the component ever
 * answers a direction with the wrong slice of data, the loop and the view shift
 * show up here instead of on the user's screen.
 */

const DAY = 86_400_000;
const START = 1_600_000_000_000;
const PAGE = 500;
const TOTAL = 4000;

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

/** Everything the harness needs to inspect after the run. */
const h = vi.hoisted(() => ({
  list: [] as Array<{ timestamp: number }>,
  more: { forward: false, backward: false },
  viewShift: 0,
  requests: [] as Array<{ type: string; before: string | null; bars: number }>,
  inFlight: 0,
  /** Which direction the chart asked for; read by the fake backend to label a request. */
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

/** `StoreImp._addData`, restricted to the two paging directions. */
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
  if (type === "init") {
    h.list = data as Array<{ timestamp: number }>;
  } else if (type === "forward") {
    h.list = [...(data as Array<{ timestamp: number }>), ...h.list]; // prepended
  } else if (type === "backward") {
    h.list = [...h.list, ...(data as Array<{ timestamp: number }>)]; // appended
    h.viewShift -= data.length; // ...and the library moves the view
  }
  if (type !== "backward") h.more.forward = real.forward;
  if (type !== "forward") h.more.backward = real.backward;
}

function runLoad(type: "init" | "forward" | "backward"): void {
  if (!h.loader) return;
  const oldest = h.list.length ? h.list[0].timestamp : null;
  const newest = h.list.length ? h.list[h.list.length - 1].timestamp : null;
  // Exactly what _processDataLoad passes as `timestamp`.
  const timestamp = type === "backward" ? newest : oldest;
  h.inFlight += 1;
  h.askedType = type;
  const done = () => {
    h.inFlight -= 1;
  };
  // `done` waits for getBars itself to settle, not just for the callback, so the
  // `setStatus` that runs after the callback is still inside the act() pump.
  void Promise.resolve(
    h.loader.getBars({
      type,
      timestamp,
      period: { type: "day", span: 1 },
      symbol: { ticker: "600519.SH" },
      callback: (data, more) => {
        addData(data, type, more);
      },
    }),
  )
    .catch(() => undefined)
    .finally(done);
}

vi.mock("klinecharts", () => ({
  registerIndicator: vi.fn(),
  getSupportedLocales: () => ["en-US", "zh-CN"],
  dispose: vi.fn(),
  init: () => ({
    getSymbol: () => ({ ticker: "600519.SH" }),
    getDataList: () => h.list,
    setDataLoader: (loader: typeof h.loader) => {
      h.loader = loader;
    },
    // setSymbol/setPeriod trigger resetData -> an init load in the real chart.
    setSymbol: () => runLoad("init"),
    setPeriod: () => runLoad("init"),
    setStyles: vi.fn(),
    resize: vi.fn(),
    createIndicator: vi.fn(),
    createOverlay: vi.fn(),
    removeOverlay: vi.fn(),
    removeIndicator: vi.fn(),
    getIndicators: () => [],
    // The drawings swap (⑭) reads the overlay list and the pane options on
    // every load, so the paging harness has to answer both.
    getOverlays: () => [],
    getPaneOptions: () => [],
    setPaneOptions: vi.fn(),
    getOffsetRightDistance: () => 0,
    getBarSpace: () => ({ bar: 8, halfBar: 4, gapBar: 5, halfGapBar: 2 }),
  }),
}));

vi.mock("@/lib/marketApi", () => ({
  INTERVALS: [{ key: "1D", label: "日K" }],
  periodToInterval: () => "1D",
  fetchKline: async (params: { before?: number | null; count?: number }) => {
    const before = params.before ?? null;
    const pool = before === null ? ALL_BARS : ALL_BARS.filter((b) => b.timestamp < before);
    const bars = pool.slice(-(params.count ?? PAGE));
    h.requests.push({
      type: h.askedType,
      before: before === null ? null : new Date(before).toISOString().slice(0, 10),
      bars: bars.length,
    });
    return { bars, source: "fake", symbol: "600519.SH", interval: "1D", ok: true };
  },
}));

vi.mock("@/components/charts/WatchList", () => ({ default: () => null }));
vi.mock("@/components/charts/IndicatorEditor", () => ({ default: () => null }));

/** Pumps the chart's edge triggers until nothing wants more data. */
async function settle(limit = 40): Promise<void> {
  for (let round = 0; round < limit; round++) {
    while (h.inFlight > 0) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
    if (!h.more.forward && !h.more.backward) return;
    // dist 13598-13603: `from === 0` prefers forward, else the right edge.
    await act(async () => {
      runLoad(h.more.forward ? "forward" : "backward");
    });
  }
  throw new Error(`分页没有停止：已发出 ${h.requests.length} 次请求`);
}

function audit() {
  const seen = new Set<number>();
  let duplicates = 0;
  let outOfOrder = 0;
  for (let i = 0; i < h.list.length; i++) {
    const ts = h.list[i].timestamp;
    if (seen.has(ts)) duplicates += 1;
    seen.add(ts);
    if (i > 0 && ts < h.list[i - 1].timestamp) outOfOrder += 1;
  }
  return { duplicates, outOfOrder };
}

beforeEach(() => {
  h.list = [];
  h.more = { forward: false, backward: false };
  h.viewShift = 0;
  h.requests = [];
  h.inFlight = 0;
  h.askedType = "";
  h.loader = null;
  localStorage.clear();
});

describe("/pro-chart 数据分页", () => {
  it("翻页到起点后自己停止，且不重复、不挪动视图", async () => {
    render(<ProChart />);
    await settle();

    expect(h.list.length).toBe(TOTAL); // whole history, no invented bars
    expect(audit()).toEqual({ duplicates: 0, outOfOrder: 0 });
    expect(h.viewShift).toBe(0); // a data load never moved the viewport
    expect(h.more).toEqual({ forward: false, backward: false });
    // 4000 bars / 500 per page + one closing page that comes back empty.
    expect(h.requests.length).toBeLessThanOrEqual(10);
  });

  it("每次翻页都问得更早，绝不重复问同一个窗口", async () => {
    render(<ProChart />);
    await settle();

    const befores = h.requests
      .map((r) => r.before)
      .filter((b): b is string => b !== null);
    expect(befores.length).toBeGreaterThan(1);
    const stamps = befores.map((b) => Date.parse(b + "T00:00:00Z"));
    for (let i = 1; i < stamps.length; i++) {
      expect(stamps[i]).toBeLessThan(stamps[i - 1]);
    }
    expect(new Set(befores).size).toBe(befores.length);
    // The newest page is only ever asked for by an init load (mount does one
    // reset per setSymbol/setPeriod). A paging request that falls back to
    // `before = null` is the old bug re-fetching the block it already holds.
    const latest = h.requests.filter((r) => r.before === null);
    expect(latest.length).toBeGreaterThan(0);
    expect(latest.every((r) => r.type === "init")).toBe(true);
    expect(h.requests.some((r) => r.type === "forward")).toBe(true);
  });

  it("右边缘不再反复请求“更新的数据”（旧缺陷：每轮复制一份最新页）", async () => {
    render(<ProChart />);
    await settle();
    // A chart sitting on its newest bar must not keep paging to the right.
    expect(h.more.backward).toBe(false);
    const before = h.requests.length;
    await act(async () => {
      runLoad("backward");
    });
    await settle();
    expect(h.requests.length).toBe(before + 1);
    expect(h.list.length).toBe(TOTAL); // and it appended nothing
    expect(h.viewShift).toBe(0);
  });
});
