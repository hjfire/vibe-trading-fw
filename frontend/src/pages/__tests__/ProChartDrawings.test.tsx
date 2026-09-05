import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";

import { ProChart } from "../ProChart";
import { planPaneHeights, subPaneIdOf } from "@/lib/paneLayout";
import { createDrawingsShareLink, exportDrawingsJson, readDrawingsShareLink } from "@/lib/drawingExchange";
import { DRAW_TOOLS } from "@/lib/chartDrawings";

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
 *      paint (⑯) — on the overlay instance, not through the global stylesheet,
 *   5. the drawing list is a read of the chart, not a parallel bookkeeping: the
 *      rows, the "已画 N 条" number and the stored bucket always agree (⑰).
 *
 * jsdom cannot paint a canvas, so the fake chart below reproduces the library's
 * observable contract: pane options, overlay lifecycle (`isDrawing()` ->
 * `onDrawEnd`), the post-hoc edits (drag = `onPressedMoveEnd`, right-click =
 * `onRemoved` fired *before* the splice), the click-selection pair
 * (`onDeselected` then `onSelected`) and `setSymbol` re-running the DataLoader.
 * The id filter and the repaint answer of `overrideOverlay` are mirrored too,
 * because both are load-bearing for ⑯/⑰ (see the fake below).
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
  // The two list-panel flags (⑰): `OverlayImp` starts both at the library
  // default (dist 8240-8242) before merging what the caller passed.
  lock?: boolean;
  visible?: boolean;
  // Event callbacks the component handed to `createOverlay`; the library keeps
  // them on the instance and calls them for the rest of the overlay's life.
  // `onDrawEnd`/`onPressedMoveEnd` take the same `{ chart, overlay }` payload the
  // real event tree hands out (dist 8599 / 8606) — ⑳ reads the overlay from it.
  onDrawEnd?: (e?: unknown) => void;
  onRemoved?: (e: { overlay: FakeOverlay }) => void;
  onPressedMoveEnd?: (e?: unknown) => void;
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
// The sub-pane addresses ⑲ hands the built-ins. They are the whole point of
// that change: a drawing stored against one of these is findable again after a
// reload, which a library-generated `indicator_pane_…` id never is.
const SUB_VOL = subPaneIdOf("VOL");
const SUB_MACD = subPaneIdOf("MACD");

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
    lock: false,
    visible: true,
    ...patch,
    isDrawing: () => o.drawing,
  };
  return o;
}

/** The library calls `onDrawEnd` when the last point lands; tests do the same. */
function finishDrawing(at: { timestamp: number; value: number }) {
  const calls = h.chart?.createOverlay.mock.calls ?? [];
  const arg = calls[calls.length - 1]?.[0] as { onDrawEnd?: (e?: unknown) => void } | string | undefined;
  const overlay = h.overlays[h.overlays.length - 1];
  if (overlay) {
    overlay.points = [at];
    overlay.drawing = false;
    overlay.currentStep = -1;
  }
  act(() => {
    const event = { overlay };
    if (overlay?.onDrawEnd) overlay.onDrawEnd(event);
    else if (arg && typeof arg !== "string") arg.onDrawEnd?.(event);
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
    overlay.onPressedMoveEnd?.({ overlay });
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
      // A `createIndicator` for a pane that is not on screen adds it under the
      // id it was handed (dist 15271: `indicator.paneId ?? createId(...)`); an id
      // that already exists stacks onto that pane instead of adding a second one.
      createIndicator: vi.fn((value: unknown) => {
        const v = (typeof value === "string" ? { name: value } : value) as {
          name?: string;
          paneId?: string;
        };
        const id = v?.paneId || (v?.name ? `pane_${v.name}` : "");
        if (!id) return null;
        if (!h.panes.some((p) => p.id === id)) {
          // The library default: `height: 100`, which is the whole problem.
          h.panes.push({ id, height: 100, minHeight: 30, state: "normal" });
        }
        return id;
      }),
      // v10 footgun: a *string* filter is read as an empty filter and removes
      // every indicator on the chart. The assertions below keep us honest.
      removeIndicator: vi.fn(),
      // v10 has both shapes: no argument lists every pane, an id answers that one
      // pane or `null` (dist 15587-15594). The second form is the existence probe
      // ⑲ reads before it will put a drawing back on a pane.
      getPaneOptions: vi.fn((id?: string) => {
        if (id === undefined || id === null) return h.panes.map((p) => ({ ...p }));
        const pane = h.panes.find((p) => p.id === id);
        return pane ? { ...pane } : null;
      }),
      setPaneOptions: vi.fn((options: { id?: string; height?: number }) => {
        const pane = h.panes.find((p) => p.id === options.id);
        if (pane && typeof options.height === "number") {
          pane.height = Math.max(pane.minHeight, options.height);
        }
      }),
      getOverlays: vi.fn((filter?: { id?: string | null }) =>
        filter === undefined || filter.id === undefined || filter.id === null
          ? h.overlays.slice()
          : h.overlays.filter((o) => o.id === filter.id),
      ),
      createOverlay: vi.fn((value: unknown) => {
        const v = (typeof value === "string" ? { name: value } : (value ?? {})) as {
          name?: string;
          paneId?: string;
          points?: Array<Record<string, number>>;
          styles?: Record<string, unknown>;
          lock?: boolean;
          visible?: boolean;
        } & OverlayEvents;
        const placed = Array.isArray(v.points) && v.points.length > 0;
        const overlay = makeOverlay({
          name: v.name ?? "",
          paneId: v.paneId || "candle_pane",
          points: placed ? [...(v.points as Array<Record<string, number>>)] : [],
          currentStep: placed ? -1 : 1,
          drawing: !placed,
          styles: v.styles,
          ...(typeof v.lock === "boolean" ? { lock: v.lock } : {}),
          ...(typeof v.visible === "boolean" ? { visible: v.visible } : {}),
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
        const v = override as {
          id?: string;
          points?: Array<Record<string, number>>;
          styles?: Record<string, unknown>;
          lock?: boolean;
          visible?: boolean;
        };
        const targets =
          v.id === undefined || v.id === null ? h.overlays.slice() : h.overlays.filter((o) => o.id === v.id);
        if (targets.length === 0) return false;
        let draw = false;
        for (const target of targets) {
          const prevStyles = target.styles;
          const prevVisible = target.visible;
          const prevPoints = JSON.stringify(target.points);
          // `override()` merges every key except id/name/currentStep/points/
          // styles (dist 8280-8281), which is how `lock`/`visible` get set.
          if ("lock" in v) target.lock = v.lock;
          if ("visible" in v) target.visible = v.visible;
          if (v.styles) target.styles = { ...(target.styles ?? {}), ...v.styles };
          // `points` is the one key `override()` does NOT blind-merge: it has its
          // own branch that replaces them wholesale and marks the drawing
          // finished (dist 8292-8306) — the seam ⑳ uses to move a line without
          // removing and re-creating it.
          if (Array.isArray(v.points) && v.points.length > 0) {
            target.points = v.points.map((p) => ({ ...p }));
            target.currentStep = -1;
            target.drawing = false;
          }
          // `shouldUpdate()` repaints for styles/visible/points/zLevel but never
          // for `lock` alone (dist 8314-8318) — hence the read-back in
          // `applyDrawingFlags`.
          draw =
            draw ||
            prevVisible !== target.visible ||
            prevStyles !== target.styles ||
            prevPoints !== JSON.stringify(target.points);
        }
        return draw;
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

    const plan = planPaneHeights({ chartHeight: HOST_HEIGHT, subPaneIds: [SUB_VOL, SUB_MACD] });
    const heights = paneHeights();
    expect(heights[SUB_VOL]).toBe(plan.subPaneHeight);
    expect(heights[SUB_MACD]).toBe(plan.subPaneHeight);
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

    expect(h.chart?.createIndicator).toHaveBeenCalledWith({
      name: "UCI_t9",
      paneId: subPaneIdOf("UCI_t9"),
    });
    const plan = planPaneHeights({
      chartHeight: HOST_HEIGHT,
      subPaneIds: [SUB_VOL, SUB_MACD, subPaneIdOf("UCI_t9")],
    });
    const heights = paneHeights();
    expect(heights[subPaneIdOf("UCI_t9")]).toBe(plan.subPaneHeight);
    expect(heights[SUB_VOL]).toBe(plan.subPaneHeight); // the old panes shrank too
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
  it("按钮点亮工具，并从主图起步", async () => {
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
    // Arming starts on the main chart, but the first click re-homes the overlay
    // (dist 8508-8510), so the hint must not promise the main chart (⑲).
    expect(screen.getByText(/第一个落点在主图还是副图/)).toBeTruthy();
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
      subPaneIds: [SUB_VOL, SUB_MACD, subPaneIdOf("UCI_t1"), subPaneIdOf("UCI_t2")],
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
    const vol = h.panes.find((p) => p.id === SUB_VOL);
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
    expect(paneHeights()[SUB_VOL]).toBe(130);

    // A pane actually appearing is a different story: the budget has to re-run.
    h.chart?.createIndicator({ name: "FOO" });
    act(() => {
      h.indProps?.onChartIndicatorsChanged?.();
    });
    await flush();
    const plan = planPaneHeights({
      chartHeight: HOST_HEIGHT,
      subPaneIds: [SUB_VOL, SUB_MACD, "pane_FOO"],
    });
    expect(h.chart?.setPaneOptions).toHaveBeenCalledWith({ id: "pane_FOO", height: plan.subPaneHeight });
    expect(paneHeights().pane_FOO).toBe(plan.subPaneHeight);
  });
});

describe("/pro-chart 画线清单", () => {
  /** Draw one price line the same way a user does; returns its overlay id. */
  async function drawOne(value = 1302.5, day = 6): Promise<string> {
    fireEvent.click(screen.getByRole("button", { name: "价格线" }));
    finishDrawing({ timestamp: START + day * DAY, value });
    await flush();
    return h.overlays[h.overlays.length - 1].id;
  }

  const stored = (): Array<Record<string, unknown>> =>
    (readBuckets()["600519.SH|1D"] ?? []) as Array<Record<string, unknown>>;
  const isDisabled = (name: string): boolean =>
    (screen.getByRole("button", { name }) as HTMLButtonElement).disabled;

  it("没有画线时清单按钮不开", async () => {
    await mountChart();
    expect(isDisabled("画线清单")).toBe(true);
    expect(screen.queryByText(/当前标的与周期上还没有画线/)).toBeNull();
  });

  it("清单里每一条都叫得出工具、位置和价格", async () => {
    await mountChart();
    const id = await drawOne(1302.5);
    fireEvent.click(screen.getByRole("button", { name: "画线清单" }));
    await flush();

    const row = screen.getByRole("button", { name: `选中画线 ${id}` });
    expect(row.textContent).toContain("价格线");
    expect(row.textContent).toContain("1302.5");
    // The toolbar number and the hint come off the same read of the chart, so
    // one cannot lie while the other tells the truth (the ⑮ lesson).
    expect(row.textContent).not.toContain("已锁定");
    expect(screen.getByRole("button", { name: "画线清单" }).textContent).toBe("清单 · 1");
    expect(screen.getByText(/已画 1 条/)).toBeTruthy();
  });

  it("从清单选中一条，点颜色改的是这条", async () => {
    await mountChart();
    const id = await drawOne();
    fireEvent.click(screen.getByRole("button", { name: "画线清单" }));
    await flush();
    h.chart?.overrideOverlay.mockClear();

    fireEvent.click(screen.getByRole("button", { name: `选中画线 ${id}` }));
    await flush();
    expect(screen.getByText(/已选中一条线/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "画线颜色 红" }));
    await flush();
    expect(h.chart?.overrideOverlay).toHaveBeenCalledTimes(1);
    expect(h.chart?.overrideOverlay).toHaveBeenCalledWith(expect.objectContaining({ id }));
    expect(stored()[0].style).toEqual({ color: "#F23645", size: 1, dashed: false });

    // Clicking the same row again is the "clicked blank canvas" of this panel.
    fireEvent.click(screen.getByRole("button", { name: `选中画线 ${id}` }));
    await flush();
    expect(screen.getByText(/已画 1 条/)).toBeTruthy();
  });

  it("锁定只作用这一条，并且写进存储", async () => {
    await mountChart();
    const a = await drawOne(1300, 3);
    const b = await drawOne(1310, 4);
    fireEvent.click(screen.getByRole("button", { name: "画线清单" }));
    await flush();

    fireEvent.click(screen.getByRole("button", { name: `锁定画线 ${a}` }));
    await flush();
    expect(h.overlays.find((o) => o.id === a)?.lock).toBe(true);
    expect(h.overlays.find((o) => o.id === b)?.lock).toBe(false);
    expect(stored()[0]).toMatchObject({ lock: true });
    expect(stored()[1]).not.toHaveProperty("lock");
    // The control says what it will do next, so the state is readable twice over.
    expect(screen.getByRole("button", { name: `锁定画线 ${a}` }).textContent).toBe("解锁");
    expect(screen.getByText("已锁定")).toBeTruthy();
  });

  it("隐藏只是图上不画，线仍在清单与存储里", async () => {
    await mountChart();
    const id = await drawOne();
    fireEvent.click(screen.getByRole("button", { name: "画线清单" }));
    await flush();

    fireEvent.click(screen.getByRole("button", { name: `隐藏画线 ${id}` }));
    await flush();
    expect(h.overlays.find((o) => o.id === id)?.visible).toBe(false);
    expect(screen.getByText(/已画 1 条/)).toBeTruthy();
    expect(stored()[0]).toMatchObject({ hidden: true });
    expect(screen.getByRole("button", { name: `隐藏画线 ${id}` }).textContent).toBe("显示");

    fireEvent.click(screen.getByRole("button", { name: `隐藏画线 ${id}` }));
    await flush();
    expect(h.overlays.find((o) => o.id === id)?.visible).toBe(true);
    expect(stored()[0]).not.toHaveProperty("hidden");
  });

  it("清单里删除走 onRemoved：存储、条数、选中一起干净", async () => {
    await mountChart();
    const a = await drawOne(1300, 3);
    const b = await drawOne(1310, 4);
    fireEvent.click(screen.getByRole("button", { name: "画线清单" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: `选中画线 ${b}` }));
    await flush();

    fireEvent.click(screen.getByRole("button", { name: `删除画线 ${a}` }));
    await flush();
    expect(h.overlays.map((o) => o.id)).toEqual([b]);
    // The button counts what is left; the hint line is busy reporting the
    // selection that survived, which is the other half of the same read.
    expect(screen.getByRole("button", { name: "画线清单" }).textContent).toBe("清单 · 1");
    expect(stored()).toHaveLength(1);
    // Deleting another line must not throw away the selection.
    expect(screen.getByText(/已选中一条线/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: `删除画线 ${b}` }));
    await flush();
    expect(screen.getByText("画线随标的与周期保存")).toBeTruthy();
    // The bucket for this symbol is gone (the map keeps the key, empty).
    expect(readBuckets()["600519.SH|1D"]).toBeUndefined();
    expect(isDisabled("画线清单")).toBe(true);
  });

  it("锁定与隐藏的线刷新后仍是锁定与隐藏", async () => {
    localStorage.setItem(
      DRAWING_KEY,
      JSON.stringify({
        "600519.SH|1D": [
          {
            name: "priceLine",
            paneId: "candle_pane",
            points: [{ timestamp: START, value: 1300 }],
            lock: true,
          },
          {
            name: "segment",
            paneId: "candle_pane",
            points: [{ timestamp: START, value: 1300 }, { timestamp: START + DAY, value: 1320 }],
            hidden: true,
          },
        ],
      }),
    );
    await mountChart();
    await flush();

    // Restored through `createOverlay`, not patched afterwards: a line that
    // comes back unlocked can be dragged away before the first click lands.
    const calls = h.chart?.createOverlay.mock.calls ?? [];
    expect(calls[0]?.[0]).toMatchObject({ lock: true });
    expect(calls[1]?.[0]).toMatchObject({ visible: false });

    fireEvent.click(screen.getByRole("button", { name: "画线清单" }));
    await flush();
    expect(screen.getByText("已锁定")).toBeTruthy();
    expect(screen.getByText("已隐藏")).toBeTruthy();
    // Touching a line re-banks the whole set, so a flag that came out of storage
    // has to survive the trip back into it.
    fireEvent.click(screen.getByRole("button", { name: `锁定画线 ${h.overlays[1].id}` }));
    await flush();
    expect(stored().map((d) => ({ lock: d.lock === true, hidden: d.hidden === true }))).toEqual([
      { lock: true, hidden: false },
      { lock: true, hidden: true },
    ]);
  });

  it("换标的时清单跟着换，不会把上一个标的的线留在屏幕上", async () => {
    await mountChart();
    await drawOne();
    fireEvent.click(screen.getByRole("button", { name: "画线清单" }));
    await flush();
    expect(screen.getAllByRole("button", { name: /^选中画线/ })).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "AAPL" }));
    await flush();
    expect(h.overlays).toHaveLength(0);
    expect(screen.queryByRole("button", { name: /^选中画线/ })).toBeNull();
    // The panel stays open but has nothing to show, and the button locks itself.
    expect(screen.getByText("当前标的与周期上还没有画线")).toBeTruthy();
    expect(isDisabled("画线清单")).toBe(true);
    expect(screen.queryByText(/已画/)).toBeNull();
    // The bucket of the symbol we left is untouched.
    expect(readBuckets()["600519.SH|1D"]).toHaveLength(1);
  });
});

/**
 * Drawings that leave and enter the chart (local custom ⑱).
 *
 * The three things this pins: an import lands in the bucket the user is looking
 * at and *on the chart itself* (not only in storage, which is the mistake a
 * "just write the file" implementation makes), the same file twice is a no-op,
 * and everything the list can do — colour, width, lock, hide — travels in the
 * file and in the link, because a shared drawing that loses its lock is back to
 * being draggable noise.
 */
describe("/pro-chart 画线导出、导入与分享链接", () => {
  const fileInput = () => screen.getByLabelText("画线文件") as HTMLInputElement;
  const storedHere = (): Array<Record<string, unknown>> =>
    (readBuckets()["600519.SH|1D"] ?? []) as Array<Record<string, unknown>>;
  const disabled = (name: string): boolean =>
    (screen.getByRole("button", { name }) as HTMLButtonElement).disabled;

  /** A file from *another* chart, to prove the label is carried but ignored. */
  function sampleFile(): string {
    return exportDrawingsJson(
      [
        {
          name: "priceLine",
          paneId: "candle_pane",
          points: [{ timestamp: START, value: 1300 }],
          style: { color: "#F23645", size: 2, dashed: true },
          lock: true,
        },
        {
          name: "segment",
          paneId: "candle_pane",
          points: [
            { timestamp: START, value: 1290 },
            { timestamp: START + DAY, value: 1320 },
          ],
          hidden: true,
        },
      ],
      { symbol: "000001.SZ", interval: "1D" },
    );
  }

  async function pickJson(raw: string, name = "drawings.json"): Promise<void> {
    fireEvent.change(fileInput(), { target: { files: [new File([raw], name, { type: "application/json" })] } });
    await flush();
  }

  it("导出不需要选中：当前标的所有画线（含锁定隐藏）写进一个 JSON", async () => {
    await mountChart();
    expect(disabled("导出画线文件")).toBe(true);
    expect(disabled("导入画线文件")).toBe(false); // an empty chart is exactly when you need it

    fireEvent.click(screen.getByRole("button", { name: "价格线" }));
    finishDrawing({ timestamp: START + 3 * DAY, value: 1301.5 });
    await flush();
    const id = h.overlays[h.overlays.length - 1].id;
    fireEvent.click(screen.getByRole("button", { name: "画线清单" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: `锁定画线 ${id}` }));
    await flush();

    let blob: Blob | null = null;
    const realCreate = URL.createObjectURL;
    const realRevoke = URL.revokeObjectURL;
    URL.createObjectURL = ((b: Blob) => {
      blob = b;
      return "blob:fake";
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
    try {
      fireEvent.click(screen.getByRole("button", { name: "导出画线文件" }));
      await flush();
    } finally {
      URL.createObjectURL = realCreate;
      URL.revokeObjectURL = realRevoke;
    }
    expect(blob).toBeTruthy();
    const parsed = JSON.parse(await (blob as unknown as Blob).text()) as {
      drawings: Array<Record<string, unknown>>;
      from: Record<string, unknown>;
      kind: string;
    };
    expect(parsed.kind).toBe("vibe-trading.drawings");
    expect(parsed.drawings).toEqual([
      {
        name: "priceLine",
        paneId: "candle_pane",
        points: [{ timestamp: START + 3 * DAY, value: 1301.5 }],
        lock: true,
      },
    ]);
    expect(Object.keys(parsed.from).sort()).toEqual(["count", "exportedAt", "interval", "symbol"]);
    expect(parsed.from.count).toBe(1);
    expect(screen.getByText(/已导出 1 条画线到 vt-drawings-600519\.SH-1D-\d{8}\.json/)).toBeTruthy();
  });

  it("下载能力不可用的环境里改为提示，不崩", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "价格线" }));
    finishDrawing({ timestamp: START, value: 1300 });
    await flush();
    const real = URL.createObjectURL;
    URL.createObjectURL = (() => {
      throw new Error("not implemented");
    }) as typeof URL.createObjectURL;
    try {
      fireEvent.click(screen.getByRole("button", { name: "导出画线文件" }));
      await flush();
    } finally {
      URL.createObjectURL = real;
    }
    const note = screen.getByText(/不给直接下载/);
    expect(note.className).toContain("text-red-500");
    // The line itself is untouched by the failed export.
    expect(h.overlays).toHaveLength(1);
  });

  it("导入：落盘、上图，样式与锁定隐藏跟着文件走", async () => {
    await mountChart();
    await pickJson(sampleFile());

    expect(h.overlays).toHaveLength(2);
    expect(h.overlays[0].lock).toBe(true);
    expect((h.overlays[0].styles?.line as Record<string, unknown>).color).toBe("#F23645");
    expect(h.overlays[1].visible).toBe(false);
    // The imported lines are editable, so they must carry the events too (⑮).
    expect(typeof h.overlays[0].onPressedMoveEnd).toBe("function");
    expect(storedHere()).toHaveLength(2);
    // The file came from another symbol: it lands on the current bucket, and says so.
    expect(screen.getByText(/导入 2 条画线到 600519\.SH\|1D/)).toBeTruthy();
    expect(screen.getByText(/文件来自 000001\.SZ\|1D/)).toBeTruthy();
  });

  it("已有画线时导入是合并，不是覆盖", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "价格线" }));
    finishDrawing({ timestamp: START + 7 * DAY, value: 1288 });
    await flush();
    expect(storedHere()).toHaveLength(1);

    await pickJson(sampleFile());
    expect(h.overlays).toHaveLength(3);
    const rows = storedHere();
    expect(rows).toHaveLength(3);
    // The line that was already there keeps its place and its own look.
    expect(rows[0].points).toEqual([{ timestamp: START + 7 * DAY, value: 1288 }]);
    expect(rows[0].lock).toBeUndefined();
    expect(screen.getByText(/导入 2 条画线到 600519\.SH\|1D/)).toBeTruthy();
  });

  it("同一份文件再导入一次不叠加", async () => {
    await mountChart();
    await pickJson(sampleFile());
    expect(h.overlays).toHaveLength(2);

    await pickJson(sampleFile());
    expect(h.overlays).toHaveLength(2);
    expect(storedHere()).toHaveLength(2);
    expect(screen.getByText(/2 条画线都已经在 600519\.SH\|1D 上了/)).toBeTruthy();
  });

  it("导入的线可以接着画、接着改，改完仍落回同一个桶", async () => {
    await mountChart();
    await pickJson(sampleFile());
    const id = h.overlays[1].id;
    dragDrawing(id, 1400);
    await flush();
    const moved = storedHere().find((d) => (d.points as Array<Record<string, number>>)[0]?.value === 1400);
    expect(moved).toBeTruthy();
    expect(screen.getByText(/已画 2 条/)).toBeTruthy();
  });

  it("坏文件整批报错，混合文件逐条跳过", async () => {
    await mountChart();
    await pickJson("{oops", "bad.json");
    expect(h.overlays).toHaveLength(0);
    const note = screen.getByText(/bad\.json：不是合法的 JSON/);
    expect(note.className).toContain("text-red-500");

    await pickJson(
      JSON.stringify({
        drawings: [
          { name: "priceLine", points: [{ value: 1200 }] },
          { name: "priceLine", points: [{ timestamp: START, value: 1300 }] },
        ],
      }),
      "mix.json",
    );
    expect(h.overlays).toHaveLength(1);
    expect(screen.getByText(/导入 1 条画线.*跳过 1 条/)).toBeTruthy();
    // The reason of each skipped entry is in the tooltip, not in the toolbar.
    expect(screen.getByText(/导入 1 条画线.*/).getAttribute("title")).toBe("第 1 条：没有落在某根 K 线上的落点");
  });

  it("提示让位给下一次画线动作", async () => {
    await mountChart();
    await pickJson(sampleFile());
    expect(screen.getByText(/导入 2 条/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "趋势线" }));
    await flush();
    expect(screen.queryByText(/导入 2 条/)).toBeNull();
    expect(screen.getByText(/第一个落点在主图还是副图/)).toBeTruthy();
  });

  it("剪贴板用不了时把链接摊在界面上，不假装成功", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "价格线" }));
    finishDrawing({ timestamp: START, value: 1300 });
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "复制画线分享链接" }));
    await flush();
    expect(screen.getByText(/剪贴板用不了/)).toBeTruthy();
    const box = screen.getByLabelText("画线分享链接") as HTMLInputElement;
    expect(box.readOnly).toBe(true);
    expect(box.value).toContain("?d=");
  });

  it("链接里带得全样式与锁定，读回来还是那条线", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "画线颜色 红" }));
    fireEvent.click(screen.getByRole("button", { name: "价格线" }));
    finishDrawing({ timestamp: START, value: 1300 });
    await flush();
    const id = h.overlays[h.overlays.length - 1].id;
    fireEvent.click(screen.getByRole("button", { name: "画线清单" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: `锁定画线 ${id}` }));
    await flush();

    let copied = "";
    const realClipboard = navigator.clipboard;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: (text: string) => ((copied = text), Promise.resolve()) },
    });
    try {
      fireEvent.click(screen.getByRole("button", { name: "复制画线分享链接" }));
      await flush();
    } finally {
      Object.defineProperty(navigator, "clipboard", { configurable: true, value: realClipboard });
    }
    expect(screen.getByText(/分享链接已复制/)).toBeTruthy();
    expect(copied).toContain("?d=");

    const back = await readDrawingsShareLink(copied);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.drawings).toEqual([
      {
        name: "priceLine",
        paneId: "candle_pane",
        points: [{ timestamp: START, value: 1300 }],
        style: { color: "#F23645", size: 1, dashed: false },
        lock: true,
      },
    ]);
    expect(back.from).toBe("600519.SH|1D");
  });

  it("?d= 链接打开即导入到当前标的与周期", async () => {
    // The share code is captured at module scope, so this exercises a freshly
    // imported component with the query in place — the same thing a browser does
    // when somebody pastes the link into an address bar.
    const link = await createDrawingsShareLink(
      [
        {
          name: "priceLine",
          paneId: "candle_pane",
          points: [{ timestamp: START, value: 1300 }],
          lock: true,
        },
      ],
      { symbol: "600519.SH", interval: "1D" },
      "http://localhost:3000/pro-chart",
    );
    const search = link.url.slice(link.url.indexOf("?"));
    const real = window.location;
    let redefined = true;
    try {
      Object.defineProperty(window, "location", { configurable: true, value: new URL(`http://localhost:3000${search}`) });
    } catch {
      redefined = false;
    }
    expect(redefined, "jsdom 不允许换掉 location：该路径改由 prod 实测覆盖").toBe(true);
    vi.resetModules();
    try {
      const { ProChart: WithLink } = await import("../ProChart");
      vi.spyOn(window.HTMLElement.prototype, "clientHeight", "get").mockReturnValue(HOST_HEIGHT);
      render(<WithLink />);
      await flush();
      expect(h.overlays).toHaveLength(1);
      expect(h.overlays[0].lock).toBe(true);
      expect(storedHere()).toHaveLength(1);
      expect(screen.getByText(/导入 1 条画线到 600519\.SH\|1D/)).toBeTruthy();
    } finally {
      Object.defineProperty(window, "location", { configurable: true, value: real });
    }
  });

  it("画线工具全在工具栏上，导出导入一个不少", async () => {
    await mountChart();
    for (const t of DRAW_TOOLS) {
      expect(screen.getByRole("button", { name: t.label })).toBeTruthy();
    }
    expect(screen.getByLabelText("导入画线文件")).toBeTruthy();
    // The file picker is a real file input, so a drag-drop-less browser still works.
    expect(fileInput().type).toBe("file");
    expect(fileInput().accept).toContain(".json");
  });
});

/**
 * Drawings that live on a sub pane (local custom ⑲).
 *
 * Drawing on MACD was always possible — the library re-homes an overlay to
 * whichever pane takes the first click (dist 8508-8510). What was missing is an
 * address that survives a reload: `createIndicator` without a paneId invents
 * `indicator_pane_<Date.now()>_<n>` (dist 15271), so a line stored against a sub
 * pane comes back looking for an id that no longer exists, and `createOverlay`
 * answers that by quietly moving it onto the candle pane (dist 15364-15367)
 * while keeping its MACD-scale value — the invisible line ⑭ was filed for,
 * arriving out of storage. Hence two things are pinned below: the panes are
 * named by us, and a line whose pane is not on the chart is *parked* (listed,
 * exported, still in storage) instead of being handed to the library to guess
 * with.
 */
describe("/pro-chart 副图上的画线", () => {
  const MAIN = "candle_pane";
  const bucketOf = (key = "600519.SH|1D"): Array<Record<string, unknown>> =>
    (readBuckets()[key] ?? []) as Array<Record<string, unknown>>;
  const seed = (drawings: Array<Record<string, unknown>>) =>
    localStorage.setItem(DRAWING_KEY, JSON.stringify({ "600519.SH|1D": drawings }));
  const disabled = (name: string): boolean =>
    (screen.getByRole("button", { name }) as HTMLButtonElement).disabled;
  /** Turns a pane off the way the workbench does: it stops existing (dist 15323-15358). */
  const closePane = (id: string) => {
    const i = h.panes.findIndex((p) => p.id === id);
    if (i >= 0) h.panes.splice(i, 1);
  };

  /** Leave the symbol and come back: the path that re-runs the restore. */
  async function reload(): Promise<void> {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "AAPL" }));
    });
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "贵州茅台" }));
    });
    await flush();
  }

  /** The blob `导出` builds, without a real download. */
  async function captureExport(): Promise<{ drawings: Array<Record<string, unknown>> }> {
    let blob: Blob | null = null;
    const realCreate = URL.createObjectURL;
    const realRevoke = URL.revokeObjectURL;
    URL.createObjectURL = ((b: Blob) => {
      blob = b;
      return "blob:fake";
    }) as typeof URL.createObjectURL;
    URL.revokeObjectURL = (() => undefined) as typeof URL.revokeObjectURL;
    try {
      fireEvent.click(screen.getByRole("button", { name: "导出画线文件" }));
      await flush();
    } finally {
      URL.createObjectURL = realCreate;
      URL.revokeObjectURL = realRevoke;
    }
    expect(blob).toBeTruthy();
    return JSON.parse(await (blob as unknown as Blob).text()) as {
      drawings: Array<Record<string, unknown>>;
    };
  }

  it("存在 sub:MACD 上的线，开机画回 sub:MACD，清单说得出它归哪个面板", async () => {
    seed([{ name: "priceLine", paneId: SUB_MACD, points: [{ timestamp: START, value: -0.42 }] }]);
    await mountChart();

    expect(h.overlays).toHaveLength(1);
    expect(h.overlays[0].paneId).toBe(SUB_MACD);
    fireEvent.click(screen.getByRole("button", { name: "画线清单" }));
    await flush();
    // -0.42 is an oscillator value; calling it 价位 is the same lie in reporting
    // form, and the row has to say which pane it belongs to.
    expect(screen.getByText(/值 -0\.42/)).toBeTruthy();
    expect(screen.queryByText(/价位/)).toBeNull();
    expect(screen.getByText("MACD")).toBeTruthy();
  });

  it("在副图上画一条线，存的是副图地址，刷新后仍在同一个副图", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "价格线" }));
    const drawn = h.overlays[h.overlays.length - 1];
    // The armed tool starts on the main chart; the first click re-homes it.
    drawn.paneId = SUB_MACD;
    finishDrawing({ timestamp: START + DAY, value: -0.42 });
    await flush();
    expect(bucketOf()[0].paneId).toBe(SUB_MACD);

    await reload();
    expect(h.overlays).toHaveLength(1);
    expect(h.overlays[0].paneId).toBe(SUB_MACD);
    expect(h.overlays[0].points).toEqual([{ timestamp: START + DAY, value: -0.42 }]);
  });

  it("副图关了就不上图：暂存、可导出、改其它线也不丢，重开回到原面板", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "价格线" }));
    h.overlays[h.overlays.length - 1].paneId = SUB_MACD;
    finishDrawing({ timestamp: START + DAY, value: -0.42 });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "水平线" }));
    finishDrawing({ timestamp: START + 2 * DAY, value: 1290 });
    await flush();
    expect(h.overlays).toHaveLength(2);

    closePane(SUB_MACD);
    await reload();

    // Exactly one line on the chart, and it is the main-chart one: the MACD line
    // is not quietly re-homed, which is the bug this whole block exists for.
    expect(h.overlays.map((o) => o.paneId)).toEqual([MAIN]);
    expect(screen.getByText(/在等 MACD/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "画线清单" }).textContent).toBe("清单 · 1+1");
    expect(bucketOf().map((d) => d.paneId).sort()).toEqual([MAIN, SUB_MACD]);

    // An edit on the live line re-banks the whole bucket, so the parked line has
    // to ride along — otherwise touching one line deletes another one's storage.
    dragDrawing(h.overlays[0].id, 1299);
    await flush();
    expect(bucketOf().map((d) => d.paneId).sort()).toEqual([MAIN, SUB_MACD]);
    expect(screen.getByText(/另 1 条在等 MACD/)).toBeTruthy();
    // And the export is the full set, not the half that happens to be visible.
    expect((await captureExport()).drawings.map((d) => d.paneId).sort()).toEqual([MAIN, SUB_MACD]);

    // MACD comes back: the waiting line goes home, and it is still one line.
    h.chart?.createIndicator({ name: "MACD", paneId: SUB_MACD });
    act(() => {
      h.indProps?.onChartIndicatorsChanged?.();
    });
    await flush();
    expect(h.overlays.map((o) => o.paneId).sort()).toEqual([MAIN, SUB_MACD]);
    expect(screen.getByRole("button", { name: "画线清单" }).textContent).toBe("清单 · 2");
    expect(bucketOf()).toHaveLength(2);
  });

  it("关掉副图指标（不刷新）：线当场进暂存，不会留下看不见的第三条", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "价格线" }));
    h.overlays[h.overlays.length - 1].paneId = SUB_MACD;
    finishDrawing({ timestamp: START + DAY, value: -0.42 });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "水平线" }));
    finishDrawing({ timestamp: START + 2 * DAY, value: 1290 });
    await flush();
    expect(h.overlays).toHaveLength(2);

    // The workbench switches the indicator off: the pane stops existing, and the
    // library leaves the overlay instance on the chart with nothing under it.
    // Un-handled, `清单 · 2` would then describe one line nobody can see or
    // reach — the ⑰ contract (list length == lines on screen) breaks.
    closePane(SUB_MACD);
    act(() => {
      h.indProps?.onChartIndicatorsChanged?.();
    });
    await flush();

    expect(h.overlays.map((o) => o.paneId)).toEqual([MAIN]);
    expect(screen.getByRole("button", { name: "画线清单" }).textContent).toBe("清单 · 1+1");
    expect(screen.getByText(/在等 MACD/)).toBeTruthy();
    expect(bucketOf().map((d) => d.paneId).sort()).toEqual([MAIN, SUB_MACD]);

    // Re-opening the formula puts that line back on its own pane.
    h.chart?.createIndicator({ name: "MACD", paneId: SUB_MACD });
    act(() => {
      h.indProps?.onChartIndicatorsChanged?.();
    });
    await flush();
    expect(h.overlays.map((o) => o.paneId).sort()).toEqual([MAIN, SUB_MACD]);
    expect(screen.getByRole("button", { name: "画线清单" }).textContent).toBe("清单 · 2");
  });

  it("旧随机面板地址上的线：说清它回不来，并给一个删除入口", async () => {
    seed([
      {
        name: "priceLine",
        paneId: "indicator_pane_1725507123456_4",
        points: [{ timestamp: START, value: 52_874 }],
      },
    ]);
    await mountChart();

    // Not drawn: a pane id this app did not issue is unreachable, and painting it
    // on the main chart at a volume-scale value is precisely ⑭.
    expect(h.overlays).toHaveLength(0);
    expect(screen.getByText(/1 条画线在等 已关闭的副图/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "画线清单" }));
    await flush();
    expect(screen.getByText("1 条在等副图 · 已关闭的副图 — 开启对应指标即回到图上")).toBeTruthy();
    expect(disabled("导出画线文件")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "删除待恢复的画线" }));
    await flush();
    expect(bucketOf()).toHaveLength(0);
    expect(screen.getByText("画线随标的与周期保存")).toBeTruthy();
    expect(disabled("画线清单")).toBe(true);
  });
});

/**
 * The gap right of the newest candle is clickable, and the library does not say
 * no: `timestampToDataIndex` extrapolates a timestamp past the last bar (dist
 * 13839-13841), so a click out there invents a trading time the data never had.
 * The line then hangs past the last candle, its axis label names a date that does
 * not exist, and the next real bar slides it left — the "显示完全不对" ⑳ was filed
 * for. What is pinned below is that every anchor ends up on a bar that exists,
 * in the storage copy as well as on the chart, whichever door the line came in
 * through: drawn, dragged, loaded, or imported.
 */
describe("/pro-chart 落点必须在真实存在的 K 线上", () => {
  // `fetchKline` above returns 200 daily bars from START.
  const LAST = START + 199 * DAY;
  const bucketOf = (): Array<Record<string, unknown>> =>
    (readBuckets()["600519.SH|1D"] ?? []) as Array<Record<string, unknown>>;
  const pointsOf = (row: Record<string, unknown> | undefined) => row?.points as Array<Record<string, number>>;
  const pickJson = async (raw: string): Promise<void> => {
    fireEvent.change(screen.getByLabelText("画线文件"), {
      target: { files: [new File([raw], "future.json", { type: "application/json" })] },
    });
    await flush();
  };

  /** Land a multi-point tool in one go, the way the library's last click does. */
  function finishWith(points: Array<Record<string, number>>): FakeOverlay {
    const line = h.overlays[h.overlays.length - 1];
    act(() => {
      line.points = points.map((p) => ({ ...p }));
      line.drawing = false;
      line.currentStep = -1;
      line.onDrawEnd?.({ overlay: line });
    });
    return line;
  }

  it("画在未来区：落点吸回最后一根，存的也是吸回后的", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "价格线" }));
    // Arming is a `createOverlay` too; count from after it, so the assertion
    // below is about the repair, not about the tool.
    const created = h.chart?.createOverlay.mock.calls.length ?? 0;
    finishDrawing({ timestamp: START + 260 * DAY, value: 1304.02 });
    await flush();

    const line = h.overlays[h.overlays.length - 1];
    expect(line.points).toEqual([{ timestamp: LAST, value: 1304.02 }]);
    // Moved in place, not recycled: the id survives, so the ⑯ selection and the
    // ⑰ row ids still point at this line.
    expect(h.chart?.overrideOverlay).toHaveBeenCalledWith({
      id: line.id,
      points: [{ timestamp: LAST, value: 1304.02 }],
    });
    expect(h.chart?.createOverlay.mock.calls.length).toBe(created);
    expect(bucketOf()).toEqual([
      { name: "priceLine", paneId: "candle_pane", points: [{ timestamp: LAST, value: 1304.02 }] },
    ]);
    expect(screen.getByText(/已吸回最后一根 K 线/)).toBeTruthy();
  });

  it("整条两点线都画在未来区：吸回后会重合成一个点，宁可放弃", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "趋势线" }));
    const line = finishWith([
      { timestamp: START + 300 * DAY, value: 1300 },
      { timestamp: START + 305 * DAY, value: 1320 },
    ]);
    await flush();

    expect(h.overlays.some((o) => o.id === line.id)).toBe(false);
    expect(bucketOf()).toHaveLength(0);
    expect(screen.getByText(/重合成一个点，已放弃/)).toBeTruthy();
  });

  it("拖线进未来区：松手时被拉回来，另一个落点留在原处", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "趋势线" }));
    const line = finishWith([
      { timestamp: START + 10 * DAY, value: 1300 },
      { timestamp: START + 20 * DAY, value: 1310 },
    ]);
    await flush();
    expect(line.points).toEqual([
      { timestamp: START + 10 * DAY, value: 1300 },
      { timestamp: START + 20 * DAY, value: 1310 },
    ]);

    act(() => {
      line.points = [
        { timestamp: START + 10 * DAY, value: 1400 },
        { timestamp: START + 300 * DAY, value: 1410 },
      ];
      line.onPressedMoveEnd?.({ overlay: line });
    });
    await flush();

    expect(line.points).toEqual([
      { timestamp: START + 10 * DAY, value: 1400 },
      { timestamp: LAST, value: 1410 },
    ]);
    expect(pointsOf(bucketOf()[0])).toEqual(line.points);
    expect(screen.getByText(/已吸回最后一根 K 线/)).toBeTruthy();
  });

  it("存量数据里的未来区落点：载入时就修好，不等到下次编辑", async () => {
    localStorage.setItem(
      DRAWING_KEY,
      JSON.stringify({
        "600519.SH|1D": [
          { name: "priceLine", paneId: "candle_pane", points: [{ timestamp: START + 400 * DAY, value: 1290 }] },
        ],
      }),
    );
    await mountChart();

    expect(h.overlays).toHaveLength(1);
    expect(h.overlays[0].points).toEqual([{ timestamp: LAST, value: 1290 }]);
    expect(pointsOf(bucketOf()[0])).toEqual([{ timestamp: LAST, value: 1290 }]);
    expect(screen.getByText(/处画线落点在最新 K 线右侧的空白里/)).toBeTruthy();
  });

  it("存量数据里整条越界的两点线：载入时被删掉，不再占清单", async () => {
    localStorage.setItem(
      DRAWING_KEY,
      JSON.stringify({
        "600519.SH|1D": [
          {
            name: "segment",
            paneId: "candle_pane",
            points: [
              { timestamp: START + 300 * DAY, value: 1300 },
              { timestamp: START + 305 * DAY, value: 1320 },
            ],
          },
          { name: "priceLine", paneId: "candle_pane", points: [{ timestamp: START + 300 * DAY, value: 1290 }] },
        ],
      }),
    );
    await mountChart();

    expect(h.overlays).toHaveLength(1);
    expect(h.overlays[0].name).toBe("priceLine");
    expect(bucketOf()).toHaveLength(1);
    expect(screen.getByText(/1 条吸回后重合成了一个点，已删除/)).toBeTruthy();
  });

  it("导入的文件落在未来区：先吸回最后一根再上图", async () => {
    await mountChart();
    await pickJson(
      exportDrawingsJson(
        [{ name: "priceLine", paneId: "candle_pane", points: [{ timestamp: START + 500 * DAY, value: 1300 }] }],
        { symbol: "600519.SH", interval: "1D" },
      ),
    );

    expect(h.overlays).toHaveLength(1);
    expect(h.overlays[0].points).toEqual([{ timestamp: LAST, value: 1300 }]);
    expect(pointsOf(bucketOf()[0])).toEqual([{ timestamp: LAST, value: 1300 }]);
    expect(screen.getByText(/1 处落点不在本图的 K 线上，已吸回最后一根/)).toBeTruthy();
  });

  it("数据还没到：不去动任何已有落点", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "价格线" }));
    finishDrawing({ timestamp: START + 260 * DAY, value: 1304.02 });
    await flush();
    const line = h.overlays[h.overlays.length - 1];
    expect(line.points).toEqual([{ timestamp: LAST, value: 1304.02 }]);

    // The chart lost its data (a symbol switch mid-flight): an empty list must
    // not be read as "every anchor is out of bounds", which would flatten the
    // line onto bar zero.
    h.list = [];
    act(() => {
      line.points = [{ timestamp: START + 260 * DAY, value: 1304.02 }];
      line.onPressedMoveEnd?.({ overlay: line });
    });
    await flush();
    expect(line.points).toEqual([{ timestamp: START + 260 * DAY, value: 1304.02 }]);
  });
});
