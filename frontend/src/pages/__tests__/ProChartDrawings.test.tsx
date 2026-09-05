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
 *      leaking from one chart onto another),
 *   4. the per-drawing style the toolbar picks is what the library is told to
 *      paint (⑯) — on the overlay instance, not through the global stylesheet.
 *
 * jsdom cannot paint a canvas, so the fake chart below reproduces the library's
 * observable contract: pane options, overlay lifecycle (`isDrawing()` ->
 * `onDrawEnd`), the post-hoc edits (drag = `onPressedMoveEnd`, right-click =
 * `onRemoved` fired *before* the splice), the click-selection pair
 * (`onDeselected` then `onSelected`) and `setSymbol` re-running the DataLoader.
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
  // `overlay.styles`, the per-drawing fragment the toolbar writes (⑯).
  styles?: Record<string, unknown>;
  // Event callbacks the component handed to `createOverlay`; the library keeps
  // them on the instance and calls them for the rest of the overlay's life.
  onDrawEnd?: () => void;
  onRemoved?: (e: { overlay: FakeOverlay }) => void;
  onPressedMoveEnd?: () => void;
  onSelected?: (e: { overlay: FakeOverlay }) => void;
  onDeselected?: (e: { overlay: FakeOverlay }) => void;
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
  overrideOverlay: Mock;
  getOverlays: Mock;
  getPaneOptions: Mock;
  setPaneOptions: Mock;
  getDataList: Mock;
  getSymbol: Mock;
  setDataLoader: Mock;
}

/** A drawing overlay's event bundle as the component passes it to the library. */
type OverlayEvents = Pick<
  FakeOverlay,
  "onDrawEnd" | "onRemoved" | "onPressedMoveEnd" | "onSelected" | "onDeselected"
>;

const DAY = 86_400_000;
const START = 1_700_000_000_000;
const HOST_HEIGHT = 360; // `.min-h-[360px]`, the size that used to leave 29px

const h = vi.hoisted(() => ({
  ticker: "600519.SH",
  list: [] as Bar[],
  overlays: [] as FakeOverlay[],
  panes: [] as FakePane[],
  chart: null as FakeChart | null,
  // Which overlay currently owns the click, so a re-click can deselect the old
  // one before selecting the new one (the library's order, dist 14543-14549).
  clicked: null as string | null,
  // The workbench is mocked out, but the prop it is handed (`refreshIndCount`)
  // is the only way a pane set changes without a remount — keep it callable.
  indProps: null as null | { onChartIndicatorsChanged?: () => void },
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
    if (overlay?.onDrawEnd) overlay.onDrawEnd();
    else if (arg && typeof arg !== "string") arg.onDrawEnd?.();
  });
}

/** Right-click delete: `onRemoved` fires while the overlay is still listed. */
function rightClickDelete(id: string): void {
  act(() => {
    void h.chart?.removeOverlay({ id });
  });
}

/** Grab the line body and drop it somewhere else: points change in place. */
function dragDrawing(id: string, value: number): void {
  const overlay = h.overlays.find((o) => o.id === id);
  if (!overlay) throw new Error(`no overlay ${id} to drag`);
  act(() => {
    overlay.points = overlay.points.map((p) => ({ ...p, value }));
    overlay.onPressedMoveEnd?.();
  });
}

/**
 * Left-click a finished drawing. The library deselects the previous one before
 * selecting this one, and clicking the same line twice fires nothing at all
 * (dist 14543-14549) — the toolbar's "which line?" answer depends on that.
 */
function clickOverlay(id: string): void {
  const overlay = h.overlays.find((o) => o.id === id);
  if (!overlay) throw new Error(`no overlay ${id} to click`);
  if (h.clicked === id) return;
  act(() => {
    const prev = h.clicked ? h.overlays.find((o) => o.id === h.clicked) : null;
    prev?.onDeselected?.({ overlay: prev });
    h.clicked = id;
    overlay.onSelected?.({ overlay });
  });
}

/** Clicked off the drawings: the library drops the selection. */
function clickBlank(): void {
  const prev = h.clicked ? h.overlays.find((o) => o.id === h.clicked) : null;
  if (!prev) return;
  act(() => {
    prev.onDeselected?.({ overlay: prev });
    h.clicked = null;
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
          styles?: Record<string, unknown>;
        } & OverlayEvents;
        const placed = Array.isArray(v.points) && v.points.length > 0;
        const overlay = makeOverlay({
          name: v.name ?? "",
          paneId: v.paneId || "candle_pane",
          points: placed ? [...(v.points as Array<Record<string, number>>)] : [],
          currentStep: placed ? -1 : 1,
          drawing: !placed,
          styles: v.styles,
          onDrawEnd: v.onDrawEnd,
          onRemoved: v.onRemoved,
          onPressedMoveEnd: v.onPressedMoveEnd,
          onSelected: v.onSelected,
          onDeselected: v.onDeselected,
        });
        h.overlays.push(overlay);
        return overlay.id;
      }),
      // Mirrors `StoreImp.overrideOverlay` -> `getOverlaysByFilter` (dist
      // 14285-14298) plus `OverlayImp.override` (dist 8288-8291): `isValid` only
      // rejects null/undefined, so a filter without an id restyles **every**
      // overlay on the chart. That is the footgun `applyDrawingStyle` refuses.
      overrideOverlay: vi.fn((override: unknown) => {
        const v = override as { id?: string; styles?: Record<string, unknown> };
        const targets =
          v.id === undefined || v.id === null ? h.overlays.slice() : h.overlays.filter((o) => o.id === v.id);
        if (targets.length === 0) return false;
        for (const target of targets) {
          target.styles = { ...(target.styles ?? {}), ...(v.styles ?? {}) };
        }
        return true;
      }),
      removeOverlay: vi.fn((filter?: { id?: string }) => {
        // Mirrors StoreImp.removeOverlay: callback first, splice after — which
        // is why a snapshot taken inside onRemoved has to exclude the id.
        const doomed = filter?.id ? h.overlays.filter((o) => o.id === filter.id) : h.overlays.slice();
        for (const overlay of doomed) overlay.onRemoved?.({ overlay });
        h.overlays = filter?.id ? h.overlays.filter((o) => o.id !== filter.id) : [];
        return doomed.length > 0;
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
vi.mock("@/components/charts/IndicatorEditor", () => ({
  default: (props: { onChartIndicatorsChanged?: () => void }) => {
    h.indProps = props;
    return null;
  },
}));

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
const STYLE_KEY = "pro-chart.drawStyle.v1";
const readBuckets = (): Record<string, unknown> =>
  JSON.parse(localStorage.getItem(DRAWING_KEY) ?? "{}");
const readStylePref = (): Record<string, unknown> =>
  JSON.parse(localStorage.getItem(STYLE_KEY) ?? "{}");

beforeEach(() => {
  localStorage.clear();
  seq = 0;
  h.ticker = "600519.SH";
  h.list = [];
  h.overlays = [];
  h.loader = null;
  h.chart = null;
  h.clicked = null;
  h.indProps = null;
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

/**
 * Post-hoc edits (local custom ⑮). KLineChart lets the user drag a finished line
 * and delete one with a right-click, and neither gesture touches our storage on
 * its own — the measured symptom being a deleted line coming back on reload, or a
 * moved one snapping back. Both go through `makeDrawingEvents`.
 */
describe("/pro-chart 画线的拖动与删除", () => {
  it("右键删掉的线不会在刷新后复活", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "价格线" }));
    finishDrawing({ timestamp: START + 8 * DAY, value: 1311.5 });
    await flush();
    const id = h.overlays[0].id;
    expect((readBuckets()["600519.SH|1D"] as Array<{ name: string }>).length).toBe(1);

    rightClickDelete(id);
    await flush();

    expect(h.overlays.length).toBe(0);
    expect(readBuckets()["600519.SH|1D"]).toBeUndefined();
    expect(screen.getByText("画线随标的与周期保存")).toBeTruthy();
  });

  it("从存储恢复的线同样同步删除", async () => {
    localStorage.setItem(
      DRAWING_KEY,
      JSON.stringify({
        "600519.SH|1D": [{ name: "priceLine", paneId: "candle_pane", points: [{ timestamp: START, value: 1300 }] }],
      }),
    );
    await mountChart();
    await flush();
    expect(h.overlays.length).toBe(1);

    // Without the events on the restore path only this session's drawings stay
    // in sync, and a restored line is back after a reload.
    rightClickDelete(h.overlays[0].id);
    await flush();
    expect(readBuckets()["600519.SH|1D"]).toBeUndefined();
  });

  it("拖动改位后存的是新位置", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "水平线" }));
    finishDrawing({ timestamp: START + 2 * DAY, value: 1290 });
    await flush();
    const id = h.overlays[0].id;

    dragDrawing(id, 1345.6);
    await flush();

    const bucket = readBuckets()["600519.SH|1D"] as Array<{ points: Array<{ value?: number }> }>;
    expect(bucket[0].points[0].value).toBe(1345.6);
  });

  it("画到一半被删掉时工具不卡在激活态", async () => {
    await mountChart();
    const button = screen.getByRole("button", { name: "射线" });
    fireEvent.click(button);
    const stuck = h.overlays[h.overlays.length - 1];
    expect(button.className).toContain("ring-1");

    // The library deletes the overlay a right-click lands on, in-progress or
    // not; a lit button with no overlay behind it eats every later click.
    rightClickDelete(stuck.id);
    await flush();
    expect(h.overlays.length).toBe(0);
    expect(screen.getByRole("button", { name: "射线" }).className).not.toContain("ring-1");
  });
});

/**
 * Drawing styles (local custom ⑯).
 *
 * Per-drawing colour lives in `overlay.styles`, a deep partial of the global
 * `styles.overlay` (d.ts 1122) that is merged *under* the figure template's own
 * styles (dist 8955) — hence the assertions below look at the instance, not at
 * `chart.setStyles`. Restyling a line that already exists is `overrideOverlay`,
 * which filters by id, so the toolbar has to know what the user clicked; that
 * knowledge only comes from `onSelected`/`onDeselected` (dist 8687-8702).
 */
describe("/pro-chart 画线样式", () => {
  it("点颜色再画，线带上这个颜色", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "画线颜色 红" }));
    fireEvent.click(screen.getByRole("button", { name: "价格线" }));

    const arg = h.chart?.createOverlay.mock.calls.at(-1)?.[0] as {
      name: string;
      styles: { line: Record<string, unknown>; text: Record<string, unknown> };
    };
    expect(arg.name).toBe("priceLine");
    expect(arg.styles.line).toMatchObject({ color: "#F23645", size: 1, style: "solid" });
    // A red line with the library's blue price tag reads as a bug, so the
    // label follows the colour too.
    expect(arg.styles.text.backgroundColor).toBe("#F23645");
  });

  it("线宽和虚线同样落到 line 片段上", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "画线粗细 2px" }));
    fireEvent.click(screen.getByRole("button", { name: "虚线" }));
    fireEvent.click(screen.getByRole("button", { name: "趋势线" }));

    const arg = h.chart?.createOverlay.mock.calls.at(-1)?.[0] as {
      styles: { line: Record<string, unknown> };
    };
    expect(arg.styles.line).toMatchObject({ size: 2, style: "dashed" });
    expect(screen.getByRole("button", { name: "虚线" }).textContent).toBe("虚线");
  });

  it("同一轮里的两次样式选择都算数", async () => {
    // Two clicks that land before React re-renders: a `pickStyle` composing onto
    // the render closure lets the second one drop the first (measured in prod,
    // where 2px survived and 虚线 did not), so the patches have to chain off the
    // newest requested style.
    await mountChart();
    const raw = (name: string) =>
      screen.getByRole("button", { name }).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    raw("画线粗细 2px");
    raw("虚线");
    await flush();

    expect(readStylePref()).toEqual({ color: "#1677FF", size: 2, dashed: true });

    fireEvent.click(screen.getByRole("button", { name: "价格线" }));
    const arg = h.chart?.createOverlay.mock.calls.at(-1)?.[0] as {
      styles: { line: Record<string, unknown> };
    };
    expect(arg.styles.line).toMatchObject({ size: 2, style: "dashed" });
  });

  it("选中一条线后点颜色，改的是这条线", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "价格线" }));
    finishDrawing({ timestamp: START + 6 * DAY, value: 1302.5 });
    await flush();
    const id = h.overlays[0].id;
    // Drawn with the library default: nothing of ours was painted over it.
    expect((readBuckets()["600519.SH|1D"] as Array<Record<string, unknown>>)[0]).not.toHaveProperty("style");

    clickOverlay(id);
    await flush();
    expect(screen.getByText(/已选中一条线/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "画线颜色 绿" }));
    await flush();

    expect(h.chart?.overrideOverlay).toHaveBeenCalledWith(
      expect.objectContaining({
        id,
        styles: expect.objectContaining({ line: expect.objectContaining({ color: "#089981" }) }),
      }),
    );
    // And it is the *stored* look, not a one-frame repaint: the colour rides
    // along in the bucket, so a reload restores green.
    expect(readBuckets()["600519.SH|1D"]).toEqual([
      {
        name: "priceLine",
        paneId: "candle_pane",
        points: [{ timestamp: START + 6 * DAY, value: 1302.5 }],
        style: { color: "#089981", size: 1, dashed: false },
      },
    ]);
  });

  it("没选中线时点颜色不碰图上任何东西", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "价格线" }));
    finishDrawing({ timestamp: START + 7 * DAY, value: 1300 });
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "画线颜色 橙" }));
    await flush();

    // `overrideOverlay` with an id-less filter would recolour the whole chart.
    expect(h.chart?.overrideOverlay).not.toHaveBeenCalled();
    expect((readBuckets()["600519.SH|1D"] as Array<Record<string, unknown>>)[0]).not.toHaveProperty("style");
    // The choice is kept for the next line instead.
    expect(readStylePref()).toEqual({ color: "#FF9800", size: 1, dashed: false });
  });

  it("每一次 override 都指名道姓", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "水平线" }));
    finishDrawing({ timestamp: START + DAY, value: 1295 });
    await flush();
    clickOverlay(h.overlays[0].id);
    fireEvent.click(screen.getByRole("button", { name: "画线颜色 紫" }));
    fireEvent.click(screen.getByRole("button", { name: "画线粗细 3px" }));
    await flush();

    expect(h.chart?.overrideOverlay).toHaveBeenCalledTimes(2);
    for (const call of h.chart?.overrideOverlay.mock.calls ?? []) {
      expect((call[0] as { id?: string }).id).toBe(h.overlays[0].id);
    }
  });

  it("带样式的线从存储恢复时仍是那个样式", async () => {
    localStorage.setItem(
      DRAWING_KEY,
      JSON.stringify({
        "600519.SH|1D": [
          {
            name: "segment",
            paneId: "candle_pane",
            points: [{ timestamp: START, value: 1300 }, { timestamp: START + DAY, value: 1320 }],
            style: { color: "#F23645", size: 2, dashed: true },
          },
        ],
      }),
    );
    await mountChart();
    await flush();

    const arg = h.chart?.createOverlay.mock.calls.at(-1)?.[0] as { styles: { line: unknown } };
    expect(arg.styles.line).toMatchObject({ color: "#F23645", size: 2, style: "dashed" });
    // Reload must not lose it a second time: re-serialising reads the same style.
    expect(h.overlays[0].styles).toBeTruthy();
    expect(screen.getByText(/已画 1 条/)).toBeTruthy();
  });

  it("删除或点空白都会取消选中，之后点颜色不再改线", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "价格线" }));
    finishDrawing({ timestamp: START + 4 * DAY, value: 1301 });
    await flush();
    const id = h.overlays[0].id;
    clickOverlay(id);
    await flush();
    expect(screen.getByText(/已选中一条线/)).toBeTruthy();

    clickBlank();
    await flush();
    expect(screen.getByText(/已画 1 条/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "画线颜色 红" }));
    await flush();
    expect(h.chart?.overrideOverlay).not.toHaveBeenCalled();

    // Deleting the selected line has to drop the marker as well, or the next
    // colour click would override an overlay that no longer exists.
    clickOverlay(id);
    await flush();
    rightClickDelete(id);
    await flush();
    expect(screen.getByText("画线随标的与周期保存")).toBeTruthy();
  });

  it("默认的蓝不写盘，坏掉的偏好也不崩", async () => {
    // Hand-edited / stale storage must fall back to the library default rather
    // than arm an unusable colour.
    localStorage.setItem(STYLE_KEY, JSON.stringify({ color: "not-a-colour", size: 99, dashed: "yes" }));
    await mountChart();
    expect(screen.getByRole("button", { name: "画线颜色 蓝" }).className).toContain("ring-1");

    fireEvent.click(screen.getByRole("button", { name: "价格线" }));
    finishDrawing({ timestamp: START + 9 * DAY, value: 1303 });
    await flush();
    // An absent `style` means "whatever the library defaults to", which keeps
    // old buckets honest if the default ever moves.
    expect(Object.keys((readBuckets()["600519.SH|1D"] as Array<Record<string, unknown>>)[0])).toEqual([
      "name",
      "paneId",
      "points",
    ]);
  });

  it("上次的选择在重新打开后还在", async () => {
    localStorage.setItem(STYLE_KEY, JSON.stringify({ color: "#F23645", size: 2, dashed: true }));
    await mountChart();

    expect(screen.getByRole("button", { name: "画线颜色 红" }).className).toContain("ring-1");
    expect(screen.getByRole("button", { name: "画线颜色 蓝" }).className).not.toContain("ring-1");
    expect(screen.getByRole("button", { name: "画线粗细 2px" }).className).toContain("ring-1");
    expect(screen.getByRole("button", { name: "虚线" }).className).toContain("ring-1");
  });

  it("换标的不清掉颜色偏好，但各标的的线各是各的", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "画线颜色 红" }));
    fireEvent.click(screen.getByRole("button", { name: "价格线" }));
    finishDrawing({ timestamp: START + 11 * DAY, value: 1306 });
    await flush();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "AAPL" }));
    });
    await flush();

    expect(h.overlays.length).toBe(0);
    expect(readStylePref()).toMatchObject({ color: "#F23645" });
    expect((readBuckets()["600519.SH|1D"] as Array<Record<string, unknown>>)[0]).toHaveProperty("style");
    expect(screen.getByRole("button", { name: "画线颜色 红" }).className).toContain("ring-1");
  });
});

describe("/pro-chart 面板预算的边界", () => {
  it("副图多到主图不可读时给出提示", async () => {
    localStorage.setItem(
      "pro-chart.userIndicators.v2",
      JSON.stringify([
        { id: "t1", label: "一", kind: "pane", params: [5], code: "return { M: ma(close, P[0]) };", enabled: true },
        { id: "t2", label: "二", kind: "pane", params: [5], code: "return { M: ma(close, P[0]) };", enabled: true },
      ]),
    );
    await mountChart();

    const plan = planPaneHeights({
      chartHeight: HOST_HEIGHT,
      subPaneIds: ["pane_VOL", "pane_MACD", "pane_UCI_t1", "pane_UCI_t2"],
    });
    expect(plan.starved).toBe(true);
    expect(screen.getByText(`副图过多，主图仅 ${plan.mainHeight}px — 关闭部分指标可恢复`)).toBeTruthy();
  });

  it("主图够用就不报警", async () => {
    await mountChart();
    expect(screen.queryByText(/副图过多/)).toBeNull();
  });

  it("手拖副图高度不被无关的重排抹掉", async () => {
    await mountChart();
    const vol = h.panes.find((p) => p.id === "pane_VOL");
    if (!vol) throw new Error("VOL pane missing");
    // Separator dragging rewrites the height inside the library; nothing else
    // about the chart changed.
    vol.height = 130;
    h.chart?.setPaneOptions.mockClear();

    act(() => {
      h.indProps?.onChartIndicatorsChanged?.();
    });
    await flush();
    expect(h.chart?.setPaneOptions).not.toHaveBeenCalled();
    expect(paneHeights().pane_VOL).toBe(130);

    // A pane actually appearing is a different story: the budget has to re-run.
    h.chart?.createIndicator({ name: "FOO" });
    act(() => {
      h.indProps?.onChartIndicatorsChanged?.();
    });
    await flush();
    const plan = planPaneHeights({
      chartHeight: HOST_HEIGHT,
      subPaneIds: ["pane_VOL", "pane_MACD", "pane_FOO"],
    });
    expect(h.chart?.setPaneOptions).toHaveBeenCalledWith({ id: "pane_FOO", height: plan.subPaneHeight });
    expect(paneHeights().pane_FOO).toBe(plan.subPaneHeight);
  });
});
