import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { ProChart } from "../ProChart";
import { planPaneHeights } from "@/lib/paneLayout";

/**
 * Drawing + pane-layout wiring of /pro-chart, driven through the real component
 * (local custom ⑭).
 *
 * The report was “画线功能无法使用”. The drawing code was not broken; the main
 * chart was 29px tall, so a click aimed at a candle landed on the volume pane
 * and the library stored a volume-scale value as the drawn "price line" — the
 * line was real and invisible. These tests pin the three things that make the
 * tools usable again:
 *
 *   1. the sub panes are sized from the available height, so the main chart
 *      keeps the majority of it (and gets re-budgeted when indicators come and
 *      go),
 *   2. a tool is armed with an explicit `paneId`, plus real activation state,
 *      Esc-out, undo and clear,
 *   3. drawings are banked per `symbol|interval` instead of being lost (or
 *      leaking from one chart onto another).
 *
 * jsdom cannot paint a canvas, so the fake chart below reproduces the library's
 * observable contract: pane options, overlay lifecycle (`isDrawing()` ->
 * `onDrawEnd`), and `setSymbol` re-running the DataLoader.
 */

interface Bar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface FakeOverlay {
  id: string;
  name: string;
  paneId: string;
  points: Array<Record<string, number>>;
  currentStep: number;
  drawing: boolean;
  isDrawing: () => boolean;
}

interface FakePane {
  id: string;
  height: number;
  minHeight: number;
  state: string;
}

interface FakeChart {
  setSymbol: Mock;
  setPeriod: Mock;
  setStyles: Mock;
  resize: Mock;
  createIndicator: Mock;
  removeIndicator: Mock;
  getIndicators: Mock;
  createOverlay: Mock;
  removeOverlay: Mock;
  getOverlays: Mock;
  getPaneOptions: Mock;
  setPaneOptions: Mock;
  getDataList: Mock;
  getSymbol: Mock;
  setDataLoader: Mock;
}

const DAY = 86_400_000;
const START = 1_700_000_000_000;
const HOST_HEIGHT = 360; // `.min-h-[360px]`, the size that used to leave 29px

const h = vi.hoisted(() => ({
  ticker: "600519.SH",
  list: [] as Bar[],
  overlays: [] as FakeOverlay[],
  panes: [] as FakePane[],
  chart: null as FakeChart | null,
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

let seq = 0;

function makeOverlay(patch: Partial<FakeOverlay>): FakeOverlay {
  const o: FakeOverlay = {
    id: `o${(seq += 1)}`,
    name: "",
    paneId: "candle_pane",
    points: [],
    currentStep: 1,
    drawing: true,
    ...patch,
    isDrawing: () => o.drawing,
  };
  return o;
}

/** The library calls `onDrawEnd` when the last point lands; tests do the same. */
function finishDrawing(at: { timestamp: number; value: number }) {
  const calls = h.chart?.createOverlay.mock.calls ?? [];
  const arg = calls[calls.length - 1]?.[0] as { onDrawEnd?: () => void } | string | undefined;
  const overlay = h.overlays[h.overlays.length - 1];
  if (overlay) {
    overlay.points = [at];
    overlay.drawing = false;
    overlay.currentStep = -1;
  }
  act(() => {
    if (arg && typeof arg !== "string") arg.onDrawEnd?.();
  });
}

function paneHeights(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const p of h.panes) out[p.id] = p.height;
  return out;
}

vi.mock("klinecharts", () => ({
  registerIndicator: vi.fn(),
  getSupportedLocales: () => ["en-US", "zh-CN"],
  dispose: vi.fn(),
  init: () => {
    const chart = {
      getSymbol: vi.fn(() => ({ ticker: h.ticker, pricePrecision: 2, volumePrecision: 0 })),
      getDataList: vi.fn(() => h.list),
      getIndicators: vi.fn(() => []),
      setDataLoader: vi.fn((loader: typeof h.loader) => {
        h.loader = loader;
      }),
      setSymbol: vi.fn((symbol: { ticker: string }) => {
        h.ticker = symbol.ticker;
        runLoad();
      }),
      setPeriod: vi.fn(() => undefined),
      setStyles: vi.fn(),
      resize: vi.fn(),
      // A pane-less createIndicator creates a sub pane; a paneId stacks instead.
      createIndicator: vi.fn((value: unknown) => {
        const v = (typeof value === "string" ? { name: value } : value) as {
          name?: string;
          paneId?: string;
        };
        if (!v?.paneId && v?.name) {
          const id = `pane_${v.name}`;
          if (!h.panes.some((p) => p.id === id)) {
            // The library default: `height: 100`, which is the whole problem.
            h.panes.push({ id, height: 100, minHeight: 30, state: "normal" });
          }
          return id;
        }
        return v?.name ?? null;
      }),
      // v10 footgun: a *string* filter is read as an empty filter and removes
      // every indicator on the chart. The assertions below keep us honest.
      removeIndicator: vi.fn(),
      getPaneOptions: vi.fn(() => h.panes.map((p) => ({ ...p }))),
      setPaneOptions: vi.fn((options: { id?: string; height?: number }) => {
        const pane = h.panes.find((p) => p.id === options.id);
        if (pane && typeof options.height === "number") {
          pane.height = Math.max(pane.minHeight, options.height);
        }
      }),
      getOverlays: vi.fn(() => h.overlays.slice()),
      createOverlay: vi.fn((value: unknown) => {
        const v = (typeof value === "string" ? { name: value } : (value ?? {})) as {
          name?: string;
          paneId?: string;
          points?: Array<Record<string, number>>;
        };
        const placed = Array.isArray(v.points) && v.points.length > 0;
        const overlay = makeOverlay({
          name: v.name ?? "",
          paneId: v.paneId || "candle_pane",
          points: placed ? [...(v.points as Array<Record<string, number>>)] : [],
          currentStep: placed ? -1 : 1,
          drawing: !placed,
        });
        h.overlays.push(overlay);
        return overlay.id;
      }),
      removeOverlay: vi.fn((filter?: { id?: string }) => {
        if (!filter?.id) {
          h.overlays = [];
          return true;
        }
        const before = h.overlays.length;
        h.overlays = h.overlays.filter((o) => o.id !== filter.id);
        return h.overlays.length !== before;
      }),
    } as unknown as FakeChart;
    h.chart = chart;
    return chart;
  },
}));

function runLoad(): void {
  if (!h.loader) return;
  const oldest = h.list.length ? h.list[0].timestamp : null;
  void h.loader.getBars({
    type: "init",
    timestamp: oldest,
    period: { type: "day", span: 1 },
    symbol: { ticker: h.ticker },
    callback: (data, more) => {
      const bars = data as Bar[];
      h.list = bars;
      void more;
    },
  });
}

vi.mock("@/lib/marketApi", () => ({
  INTERVALS: [{ key: "1D", label: "日K" }],
  periodToInterval: () => "1D",
  fetchKline: async () => {
    const bars = Array.from({ length: 200 }, (_, i): Bar => ({
      timestamp: START + i * DAY,
      open: 1300,
      high: 1310,
      low: 1290,
      close: 1305,
      volume: 52_874,
    }));
    return { bars, source: "fake", symbol: h.ticker, interval: "1D", ok: true };
  },
}));

vi.mock("@/components/charts/WatchList", () => ({ default: () => null }));
vi.mock("@/components/charts/IndicatorEditor", () => ({ default: () => null }));

/** Lets the async loader (and the state it sets) settle. */
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mountChart(): Promise<void> {
  // `min-h-[360px]` is the size that used to leave the main chart 29px; jsdom
  // reports 0 for an unstyled div, which would skip the budget entirely.
  vi.spyOn(window.HTMLElement.prototype, "clientHeight", "get").mockReturnValue(HOST_HEIGHT);
  render(<ProChart />);
  await flush();
}

const DRAWING_KEY = "pro-chart.drawings.v1";
const readBuckets = (): Record<string, unknown> =>
  JSON.parse(localStorage.getItem(DRAWING_KEY) ?? "{}");

beforeEach(() => {
  localStorage.clear();
  seq = 0;
  h.ticker = "600519.SH";
  h.list = [];
  h.overlays = [];
  h.loader = null;
  h.chart = null;
  h.panes = [
    { id: "candle_pane", height: 29, minHeight: 30, state: "normal" },
    { id: "x_axis_pane", height: 26, minHeight: 30, state: "normal" },
  ];
});

describe("/pro-chart 面板高度（画线可用性前提）", () => {
  it("mount 后副图不再按 100px 吃掉主图", async () => {
    await mountChart();

    const plan = planPaneHeights({ chartHeight: HOST_HEIGHT, subPaneIds: ["pane_VOL", "pane_MACD"] });
    const heights = paneHeights();
    expect(heights.pane_VOL).toBe(plan.subPaneHeight);
    expect(heights.pane_MACD).toBe(plan.subPaneHeight);
    expect(plan.subPaneHeight).toBeLessThan(100);
    // The main chart is the flexible pane: it is never handed a fixed height,
    // it simply stops being squeezed.
    expect(h.chart?.setPaneOptions.mock.calls.some((c) => (c[0] as { id?: string }).id === "candle_pane")).toBe(false);
    expect(plan.mainHeight).toBeGreaterThan(HOST_HEIGHT * 0.45);
  });

  it("恢复用户副图指标后重新分配高度", async () => {
    localStorage.setItem(
      "pro-chart.userIndicators.v2",
      JSON.stringify([
        { id: "t9", label: "测试", kind: "pane", params: [5], code: "return { M: ma(close, P[0]) };", enabled: true },
      ]),
    );
    await mountChart();

    expect(h.chart?.createIndicator).toHaveBeenCalledWith({ name: "UCI_t9" });
    const plan = planPaneHeights({
      chartHeight: HOST_HEIGHT,
      subPaneIds: ["pane_VOL", "pane_MACD", "pane_UCI_t9"],
    });
    const heights = paneHeights();
    expect(heights.pane_UCI_t9).toBe(plan.subPaneHeight);
    expect(heights.pane_VOL).toBe(plan.subPaneHeight); // the old panes shrank too
    expect(plan.mainHeight).toBeGreaterThan(HOST_HEIGHT * 0.45);
  });

  it("删掉指标时不会误伤其它指标（库的字符串过滤 footgun）", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "价格线" }));
    await flush();
    expect(h.chart?.removeIndicator.mock.calls.every((c) => typeof c[0] !== "string")).toBe(true);
  });
});

describe("/pro-chart 画线交互", () => {
  it("按钮点亮工具，并钉住主图 pane", async () => {
    await mountChart();
    const button = screen.getByRole("button", { name: "价格线" });
    fireEvent.click(button);

    // A bare `createOverlay("priceLine")` lets the library resolve the value on
    // whichever pane caught the click — the invisible-line bug.
    expect(typeof h.chart?.createOverlay.mock.calls.at(-1)?.[0]).toBe("object");
    expect(h.chart?.createOverlay.mock.calls.at(-1)?.[0]).toMatchObject({
      name: "priceLine",
      paneId: "candle_pane",
    });
    expect(button.className).toContain("ring-1");
    expect(screen.getByText(/在主图上点击 1 个落点/)).toBeTruthy();
  });

  it("再点一次退出，半成品不会留着吃点击", async () => {
    await mountChart();
    const button = screen.getByRole("button", { name: "趋势线" });
    fireEvent.click(button);
    const stuck = h.overlays[0];
    expect(stuck).toBeTruthy();

    fireEvent.click(button);
    expect(h.overlays.length).toBe(0);
    expect(h.chart?.removeOverlay).toHaveBeenCalledWith({ id: stuck.id });
    expect(button.className).not.toContain("ring-1");
    // Exiting must not queue a second overlay on top of the first.
    expect(h.chart?.createOverlay).toHaveBeenCalledTimes(1);
  });

  it("Esc 取消进行中的画线", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "斐波那契" }));
    const stuck = h.overlays[h.overlays.length - 1];
    expect(stuck.drawing).toBe(true);

    await act(async () => {
      fireEvent.keyDown(window, { key: "Escape" });
    });
    expect(h.overlays.some((o) => o.id === stuck.id)).toBe(false);
    expect(screen.getByRole("button", { name: "斐波那契" }).className).not.toContain("ring-1");
  });

  it("完成一条线后按标的落盘，撤销后清空", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "价格线" }));
    finishDrawing({ timestamp: START + 10 * DAY, value: 1304.02 });
    await flush();

    expect(readBuckets()["600519.SH|1D"]).toEqual([
      { name: "priceLine", paneId: "candle_pane", points: [{ timestamp: START + 10 * DAY, value: 1304.02 }] },
    ]);
    expect(screen.getByText(/已画 1 条/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await flush();
    expect(h.overlays.length).toBe(0);
    expect(readBuckets()["600519.SH|1D"]).toBeUndefined();
    expect(screen.getByText("画线随标的与周期保存")).toBeTruthy();
  });

  it("清除会连同存储一起清掉", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "水平线" }));
    finishDrawing({ timestamp: START + 3 * DAY, value: 1298.9 });
    await flush();
    expect(h.overlays.length).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "清除" }));
    await flush();
    expect(h.chart?.removeOverlay).toHaveBeenLastCalledWith();
    expect(h.overlays.length).toBe(0);
    expect(readBuckets()["600519.SH|1D"]).toBeUndefined();
  });

  it("画线跟着标的走：切走后回来，各自是各自的那一套", async () => {
    localStorage.setItem(
      DRAWING_KEY,
      JSON.stringify({
        "AAPL.US|1D": [{ name: "segment", paneId: "candle_pane", points: [{ timestamp: START, value: 200 }, { timestamp: START + DAY, value: 210 }] }],
      }),
    );
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "价格线" }));
    finishDrawing({ timestamp: START + 5 * DAY, value: 1300 });
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "AAPL" }));
    });
    await flush();

    // The茅台 line is banked under its own key, not left on the Apple chart...
    expect(readBuckets()["600519.SH|1D"]).toEqual([
      { name: "priceLine", paneId: "candle_pane", points: [{ timestamp: START + 5 * DAY, value: 1300 }] },
    ]);
    // ...and Apple's stored segment came back with its points intact.
    expect(h.overlays.length).toBe(1);
    expect(h.overlays[0]).toMatchObject({ name: "segment", drawing: false, points: [{ timestamp: START, value: 200 }, { timestamp: START + DAY, value: 210 }] });
    expect(screen.getByText(/已画 1 条/)).toBeTruthy();
  });
});
