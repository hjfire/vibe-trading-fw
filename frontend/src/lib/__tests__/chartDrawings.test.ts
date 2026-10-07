import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSupportedOverlays } from "klinecharts";

import {
  ALL_PANES_PRESENT,
  DEFAULT_DRAWING_STYLE,
  DRAW_TOOLS,
  MAIN_PANE_ID,
  MAX_DRAWING_TEXT,
  applyDrawingFlags,
  applyDrawingStyle,
  applyDrawingText,
  applyMagnetMode,
  cancelInProgress,
  clampDrawingsToLastBar,
  clampPointsToLastBar,
  describeDrawing,
  drawingsBucket,
  drawHint,
  formatBarTime,
  isInProgress,
  isDefaultStyle,
  isRestorablePaneId,
  lastBarTimestamp,
  listDrawings,
  loadDrawingStyle,
  loadDrawings,
  loadMagnet,
  makeDrawingEvents,
  normalizeDrawingStyle,
  normalizeDrawingText,
  overlayStylesOf,
  paneIndicator,
  reanchorOverlay,
  removeLatestDrawing,
  restoreDrawings,
  saveDrawingStyle,
  saveDrawings,
  saveMagnet,
  serializeDrawings,
  styleOfOverlay,
  toolCreateExtras,
  toolOf,
  withAlpha,
  type DrawingStyle,
  type MagnetMode,
  type StoredDrawing,
} from "../chartDrawings";

/**
 * Drawing semantics + per-chart persistence (local custom ⑭).
 *
 * The measured failure this guards: a "价格线" drawn on 贵州茅台 (~1300) came
 * back with `value: 52874.25` — a volume-axis number — because the click had
 * landed on a squeezed volume pane, and the library derives a point's value
 * from the pane that received the event. Hence: state the pane, and never
 * persist a point the chart cannot place again.
 */

const KEY = "pro-chart.drawings.v1";

interface FakeOverlay {
  id: string;
  name: string;
  paneId: string;
  // `dataIndex` is part of the shape because a Pine 画的线 anchors by bar index,
  // not by timestamp (§二.6) — the 磁吸 batch test has to build one without a
  // cast, or the double would hide the very field the filter keys off.
  points: Array<{ timestamp?: number; value?: number; dataIndex?: number }>;
  currentStep: number;
  drawing?: boolean;
  isDrawing?: () => boolean;
  styles?: Record<string, unknown>;
  lock?: boolean;
  visible?: boolean;
  // `extendData` is what `simpleAnnotation` prints (dist 12466-12478); the
  // library default is undefined, `OverlayImp`'s constructor does not seed it.
  extendData?: unknown;
  // `mode` is the magnet key: 'normal' | 'weak_magnet' | 'strong_magnet'
  // (dist 8248, `KD:988`). A live instance always carries it.
  mode?: string;
  // Asked for by `toolCreateExtras`; false in the constructor (dist 8245).
  needDefaultPointFigure?: boolean;
  onDrawEnd?: (e: unknown) => void;
  onRemoved?: (e: unknown) => void;
  onPressedMoveEnd?: (e: unknown) => void;
  onSelected?: (e: unknown) => void;
  onDeselected?: (e: unknown) => void;
}

function overlay(patch: Partial<FakeOverlay> & { id: string }): FakeOverlay {
  const o: FakeOverlay = {
    name: "priceLine",
    paneId: MAIN_PANE_ID,
    points: [{ timestamp: 1_700_000_000_000, value: 1300 }],
    currentStep: -1,
    // `OverlayImp`'s constructor seeds all four before merging what the caller
    // passed (dist 8235-8248 vs `override()` at 8275), so a live instance always
    // carries them. `needDefaultPointFigure` belongs in the list for the same
    // reason `lock`/`visible` do: this suite reads instances back *after*
    // `overrideOverlay`, and a double that leaves it `undefined` cannot tell
    // "the override left it alone" from "it was never seeded" — `false` is the
    // only value a real overlay answers with.
    lock: false,
    visible: true,
    mode: "normal",
    needDefaultPointFigure: false,
    ...patch,
  };
  // The runtime instance has `isDrawing()`; the typed `Overlay` does not, so
  // both shapes have to work (see `isInProgress`).
  o.isDrawing = () => o.drawing === true;
  return o;
}

function fakeChart(overlays: FakeOverlay[] = []) {
  return {
    overlays,
    // Same filter semantics as `StoreImp.getOverlaysByFilter`: only `id` is ever
    // used here, and a missing one means "no constraint".
    getOverlays: vi.fn((filter?: { id?: string | null }) =>
      filter === undefined || filter.id === undefined || filter.id === null
        ? overlays
        : overlays.filter((o) => o.id === filter.id),
    ),
    createOverlay: vi.fn((value: unknown) => {
      const v = value as {
        name?: string;
        paneId?: string;
        points?: FakeOverlay["points"];
        styles?: Record<string, unknown>;
        lock?: boolean;
        visible?: boolean;
        mode?: string;
        extendData?: unknown;
        needDefaultPointFigure?: boolean;
        onDrawEnd?: (e: unknown) => void;
        onRemoved?: (e: unknown) => void;
        onPressedMoveEnd?: (e: unknown) => void;
        onSelected?: (e: unknown) => void;
        onDeselected?: (e: unknown) => void;
      };
      overlays.push(
        overlay({
          id: `o${overlays.length}`,
          name: v.name ?? "",
          paneId: v.paneId ?? "",
          points: v.points ?? [],
          styles: v.styles,
          ...(typeof v.lock === "boolean" ? { lock: v.lock } : {}),
          ...(typeof v.visible === "boolean" ? { visible: v.visible } : {}),
          ...(typeof v.mode === "string" ? { mode: v.mode } : {}),
          ...("extendData" in v ? { extendData: v.extendData } : {}),
          ...("needDefaultPointFigure" in v ? { needDefaultPointFigure: v.needDefaultPointFigure } : {}),
          onDrawEnd: v.onDrawEnd,
          onRemoved: v.onRemoved,
          onPressedMoveEnd: v.onPressedMoveEnd,
          onSelected: v.onSelected,
          onDeselected: v.onDeselected,
        }),
      );
      return `o${overlays.length - 1}`;
    }),
    removeOverlay: vi.fn((filter?: { id?: string }) => {
      if (!filter?.id) {
        overlays.length = 0;
        return;
      }
      const i = overlays.findIndex((o) => o.id === filter.id);
      if (i >= 0) overlays.splice(i, 1);
    }),
    // `overrideOverlay` filters through `getOverlaysByFilter` (dist 14285-14298)
    // and merges into the instance the same way `OverlayImp.override` does
    // (dist 8288-8291). The filter semantics are the sharp edge: `isValid` only
    // rejects null/undefined, so a *missing* id matches every overlay on the
    // chart, while an empty string matches none. Both are wrong answers here.
    overrideOverlay: vi.fn((override: unknown) => {
      const v = override as {
        id?: string;
        styles?: Record<string, unknown>;
        points?: FakeOverlay["points"];
        lock?: boolean;
        visible?: boolean;
        mode?: string;
        extendData?: unknown;
        needDefaultPointFigure?: boolean;
      };
      const targets =
        v.id === undefined || v.id === null
          ? overlays.slice()
          : overlays.filter((o) => o.id === v.id);
      if (targets.length === 0) return false;
      let draw = false;
      for (const target of targets) {
        const prevStyles = target.styles;
        const prevVisible = target.visible;
        const prevExtendData = target.extendData;
        const prevPoints = JSON.stringify(target.points);
        // `OverlayImp.override` merges everything except id/name/currentStep,
        // and handles styles/points on their own branches (dist 8277-8306).
        if ("lock" in v) target.lock = v.lock;
        if ("visible" in v) target.visible = v.visible;
        if ("mode" in v) target.mode = v.mode;
        if ("extendData" in v) target.extendData = v.extendData;
        // 席 A 的 M-2：这一句是本套件里 `needDefaultPointFigure` 唯一的写侧建模。
        // 没有它，`"批量磁吸只写 mode，别的一个键都不动"` 里那两行读回就是**恒过**
        // —— 替身把没建模的键直接丢了，于是"没被改动"这句话永远为真，批量 pass
        // 真送出 `needDefaultPointFigure` 也照测不出。库那边它是会被 merge 的：
        // `OverlayImp.override` 的排除表只有 `id/name/currentStep/points/styles`
        // （dist 8280），所以 `merge(this, others)` 会带上这一个 ⇒ 照这个语义建模。
        if ("needDefaultPointFigure" in v) target.needDefaultPointFigure = v.needDefaultPointFigure;
        if (v.styles) target.styles = { ...(target.styles ?? {}), ...v.styles };
        if (v.points) target.points = v.points.slice();
        // `shouldUpdate()` repaints for a visible/points/styles change, for
        // `extendData` and for zLevel sorts — never for `lock` or `mode` alone
        // (dist 8314-8318). That is why `applyDrawingFlags` verifies by reading
        // the instance back, and why a magnet change cannot use the answer.
        draw =
          draw ||
          prevVisible !== target.visible ||
          prevStyles !== target.styles ||
          prevExtendData !== target.extendData ||
          prevPoints !== JSON.stringify(target.points);
      }
      return draw;
    }),
  };
}

beforeEach(() => {
  localStorage.clear();
});

/** 去掉所有合法代理对后还剩代理位，就是串里有个"半个人字符"（孤立代理）。 */
function hasLoneSurrogate(s: string): boolean {
  return /[\uD800-\uDFFF]/.test(s.replace(/[\uD800-\uDBFF][\uDC00-\uDFFF]/g, ""));
}

/**
 * 第③片 A：七件库内置模板挂上工具栏。名字这一条不抄表——直接问库要注册表，
 * 于是「升级后某模板改名」是测试变红，而不是用户画不出线。
 */
describe("新增工具与建线附加键", () => {
  it("每件工具的名字都是库里真实存在的内置模板", () => {
    const supported = getSupportedOverlays();
    for (const t of DRAW_TOOLS) {
      expect(supported, `${t.name} 不在 klinecharts 内置模板里`).toContain(t.name);
    }
  });

  it("13 件工具，落点数与库的 totalStep 逐行相等", () => {
    expect(DRAW_TOOLS.map((t) => t.name)).toEqual([
      "segment",
      "rayLine",
      "horizontalStraightLine",
      "priceLine",
      "fibonacciLine",
      "brush",
      "straightLine",
      "verticalStraightLine",
      "horizontalSegment",
      "horizontalRayLine",
      "parallelStraightLine",
      "priceChannelLine",
      "simpleAnnotation",
    ]);
    // `totalStep`（spec §二.1 表）减一就是落点数；`brush` 是拖动，-1。
    const clicks: Record<string, number> = {
      segment: 2,
      rayLine: 2,
      horizontalStraightLine: 1,
      priceLine: 1,
      fibonacciLine: 2,
      brush: -1,
      straightLine: 2,
      verticalStraightLine: 1,
      horizontalSegment: 2,
      horizontalRayLine: 2,
      parallelStraightLine: 3,
      priceChannelLine: 3,
      simpleAnnotation: 1,
    };
    for (const t of DRAW_TOOLS) expect(t.clicks, t.name).toBe(clicks[t.name]);
  });

  it("只有垂直线是纯时间的，只有标注带文字", () => {
    expect(toolOf("verticalStraightLine")?.dim).toBe("time");
    expect(toolOf("simpleAnnotation")?.hasText).toBe(true);
    for (const t of DRAW_TOOLS) {
      if (t.name === "verticalStraightLine" || t.name === "simpleAnnotation") continue;
      expect(t.dim, t.name).toBeUndefined();
      expect(t.hasText, t.name).toBeUndefined();
    }
  });

  it("toolCreateExtras 只给带文字的线补默认锚点图元", () => {
    expect(toolCreateExtras("simpleAnnotation")).toEqual({ needDefaultPointFigure: true });
    expect(toolCreateExtras("priceLine")).toEqual({});
    expect(toolCreateExtras("nope")).toEqual({});
  });

  it("垂直线的清单行不印价位，价格线照旧", () => {
    const ts = 1_700_000_000_000;
    const v = describeDrawing(
      overlay({ id: "v", name: "verticalStraightLine", points: [{ timestamp: ts, value: 1300 }] }),
    );
    expect(v?.detail).toBe(formatBarTime(ts));
    expect(v?.detail).not.toContain("价位");
    const p = describeDrawing(overlay({ id: "p", name: "priceLine", points: [{ timestamp: ts, value: 1300 }] }));
    expect(p?.detail).toContain("价位 1300");
  });
});

describe("tool metadata", () => {
  it("offers a distinct built-in overlay per button", () => {
    const names = DRAW_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names).toContain("priceLine");
    for (const t of DRAW_TOOLS) {
      expect(t.label.length).toBeGreaterThan(0);
      expect(t.clicks).not.toBe(0); // -1 is freehand, never "no clicks"
      expect(toolOf(t.name)).toBe(t);
    }
    expect(toolOf("nope")).toBeUndefined();
  });

  it("the hint tells the user how many clicks and how to quit", () => {
    const line = drawHint(toolOf("segment")!);
    expect(line).toContain("趋势线");
    expect(line).toContain("2");
    expect(line).toContain("Esc");
    expect(drawHint(toolOf("brush")!)).toContain("按住拖动");
  });
});

describe("isInProgress", () => {
  it("trusts the runtime flag first", () => {
    expect(isInProgress(overlay({ id: "a", drawing: true, currentStep: -1 }))).toBe(true);
    expect(isInProgress(overlay({ id: "a", drawing: false, currentStep: 1 }))).toBe(false);
  });

  it("falls back to the step counter on plain serialized data", () => {
    const plain = { id: "a", currentStep: 1 };
    expect(isInProgress(plain)).toBe(true);
    expect(isInProgress({ id: "a", currentStep: -1 })).toBe(false);
    expect(isInProgress({ id: "a" })).toBe(false);
    expect(isInProgress(null)).toBe(false);
    expect(isInProgress(undefined)).toBe(false);
  });
});

describe("serializeDrawings", () => {
  it("drops what cannot be re-created", () => {
    const list = [
      overlay({ id: "half", drawing: true, points: [] }),
      overlay({ id: "named" }),
      overlay({ id: "noname", name: "" }),
      overlay({ id: "nops", points: [] }),
      overlay({ id: "idx", points: [{ value: 1200 }] }), // dataIndex only
    ];
    expect(serializeDrawings(list).map((d) => d.name)).toEqual(["priceLine"]);
    expect(serializeDrawings(list)[0]).toEqual({
      name: "priceLine",
      paneId: MAIN_PANE_ID,
      points: [{ timestamp: 1_700_000_000_000, value: 1300 }],
    });
  });

  it("keeps a point that has a timestamp but no value", () => {
    const out = serializeDrawings([overlay({ id: "a", points: [{ timestamp: 5 }] })]);
    expect(out[0].points).toEqual([{ timestamp: 5 }]);
  });

  it("survives junk input", () => {
    expect(serializeDrawings([])).toEqual([]);
    expect(serializeDrawings([null, undefined, 3, "x", {}])).toEqual([]);
  });

  it("can leave one overlay out of the snapshot", () => {
    // `removeOverlay` fires `onRemoved` before the overlay is spliced out of the
    // pane, so "save what is on the chart right now" would keep saving the line
    // the user just deleted — and it would come back on the next reload.
    const list = [
      overlay({ id: "keep" }),
      overlay({ id: "gone", points: [{ timestamp: 5, value: 99 }] }),
    ];
    expect(serializeDrawings(list, "gone").map((d) => d.points[0].value)).toEqual([1300]);
    expect(serializeDrawings(list).map((d) => d.points[0].value)).toEqual([1300, 99]);
    expect(serializeDrawings(list, null)).toHaveLength(2);
  });
});

describe("makeDrawingEvents", () => {
  it("reports every edit, with the removed id to exclude", () => {
    const changes: Array<string | null> = [];
    const ended: number[] = [];
    const removed: unknown[] = [];
    const events = makeDrawingEvents({
      onChanged: (id) => {
        changes.push(id);
      },
      onDrawEnd: () => {
        ended.push(1);
      },
      onRemoved: (overlay) => {
        removed.push(overlay);
      },
    });

    events.onDrawEnd({});
    events.onPressedMoveEnd({});
    events.onRemoved({ overlay: { id: "gone" } });

    // A finished line and a moved line both bank as-is; a deleted one banks the
    // set minus itself.
    expect(changes).toEqual([null, null, "gone"]);
    expect(ended).toEqual([1]);
    expect(removed).toEqual([{ id: "gone" }]);
  });

  it("tolerates an event payload without an overlay", () => {
    const changes: Array<string | null> = [];
    const events = makeDrawingEvents({ onChanged: (id) => { changes.push(id); } });
    expect(() => events.onRemoved({})).not.toThrow();
    expect(() => events.onRemoved(undefined as never)).not.toThrow();
    expect(changes).toEqual([null, null]);
  });

  it("forwards selection both ways", () => {
    // The toolbar needs this to answer "which line does this colour apply to?".
    const picked: Array<string | null> = [];
    const idOf = (o: unknown) => (o as { id?: string } | null | undefined)?.id ?? null;
    const events = makeDrawingEvents({
      onChanged: () => undefined,
      onSelected: (o) => picked.push(idOf(o)),
      onDeselected: (o) => picked.push(idOf(o)),
    });
    events.onSelected({ overlay: { id: "a" } });
    events.onDeselected({ overlay: { id: "a" } });
    events.onSelected({});
    expect(picked).toEqual(["a", "a", null]);
  });
});

describe("restoreDrawings / cancelInProgress / removeLatestDrawing", () => {
  const stored: StoredDrawing[] = [
    { name: "segment", paneId: "candle_pane", points: [{ timestamp: 1, value: 10 }, { timestamp: 2, value: 20 }] },
    { name: "priceLine", paneId: "", points: [{ timestamp: 3, value: 30 }] },
    { name: "empty", paneId: "candle_pane", points: [] },
    { name: "", paneId: "candle_pane", points: [{ timestamp: 4, value: 40 }] },
  ];

  it("re-creates the usable drawings and pins the pane", () => {
    const chart = fakeChart([]);
    expect(restoreDrawings(chart as never, stored).applied.length).toBe(2);
    expect(chart.createOverlay).toHaveBeenCalledTimes(2);
    // The blank paneId must not become "draw it wherever the mouse lands".
    expect(chart.createOverlay.mock.calls[1][0]).toEqual({
      name: "priceLine",
      paneId: MAIN_PANE_ID,
      points: [{ timestamp: 3, value: 30 }],
    });
  });

  it("restored drawings carry the same events as drawn ones", () => {
    // Otherwise only the lines made in this session stay in sync with storage:
    // delete a *restored* line and it is back after a reload.
    const chart = fakeChart([]);
    const events = makeDrawingEvents({ onChanged: () => undefined });
    expect(restoreDrawings(chart as never, [stored[0]], events).applied.length).toBe(1);
    expect(chart.createOverlay.mock.calls[0][0]).toMatchObject({
      name: "segment",
      onDrawEnd: expect.any(Function),
      onRemoved: expect.any(Function),
      onPressedMoveEnd: expect.any(Function),
    });
  });

  it("cancels only the half-drawn overlays", () => {
    const chart = fakeChart([
      overlay({ id: "done" }),
      overlay({ id: "stuck", drawing: true, points: [] }),
    ]);
    expect(cancelInProgress(chart as never)).toBe(1);
    expect(chart.removeOverlay).toHaveBeenCalledWith({ id: "stuck" });
    expect(chart.overlays.map((o) => o.id)).toEqual(["done"]);
  });

  it("undoes the newest finished drawing, and says so", () => {
    const chart = fakeChart([
      overlay({ id: "first" }),
      overlay({ id: "second", name: "segment" }),
      overlay({ id: "stuck", drawing: true, points: [] }),
    ]);
    expect(removeLatestDrawing(chart as never)).toBe("second");
    expect(chart.overlays.map((o) => o.id)).toEqual(["first", "stuck"]);
    // Half-drawn overlays are not undo targets: with only those left there is
    // nothing to take back, and nothing gets removed.
    expect(removeLatestDrawing(chart as never)).toBe("first");
    expect(removeLatestDrawing(chart as never)).toBe(null);
    expect(chart.overlays.map((o) => o.id)).toEqual(["stuck"]);
  });
});

describe("per-symbol persistence", () => {
  it("buckets by symbol and interval", () => {
    expect(drawingsBucket("600519.SH", "1D")).toBe("600519.SH|1D");
    const drawing: StoredDrawing = { name: "priceLine", paneId: MAIN_PANE_ID, points: [{ timestamp: 1, value: 2 }] };
    saveDrawings("600519.SH", "1D", [drawing]);
    saveDrawings("AAPL.US", "1D", []);
    expect(loadDrawings("600519.SH", "1D")).toEqual([drawing]);
    expect(loadDrawings("600519.SH", "5M")).toEqual([]);
    expect(Object.keys(JSON.parse(localStorage.getItem(KEY)!))).toEqual(["600519.SH|1D"]);
  });

  it("an empty set deletes the bucket instead of leaking keys", () => {
    const drawing: StoredDrawing = { name: "priceLine", paneId: MAIN_PANE_ID, points: [{ timestamp: 1, value: 2 }] };
    saveDrawings("600519.SH", "1D", [drawing]);
    saveDrawings("600519.SH", "1D", []);
    expect(localStorage.getItem(KEY)).toBe("{}");
    expect(loadDrawings("600519.SH", "1D")).toEqual([]);
  });

  it("caps one chart's drawings, keeping the newest", () => {
    const many = Array.from({ length: 250 }, (_, i): StoredDrawing => ({
      name: "priceLine",
      paneId: MAIN_PANE_ID,
      points: [{ timestamp: i, value: i }],
    }));
    saveDrawings("BTC-USDT", "1D", many);
    const back = loadDrawings("BTC-USDT", "1D");
    expect(back.length).toBe(200);
    expect(back[back.length - 1].points[0].timestamp).toBe(249);
  });

  it("caps the number of charts remembered", () => {
    for (let i = 0; i < 65; i++) {
      saveDrawings(`SYM${i}.US`, "1D", [
        { name: "priceLine", paneId: MAIN_PANE_ID, points: [{ timestamp: 1, value: 1 }] },
      ]);
    }
    const keys = Object.keys(JSON.parse(localStorage.getItem(KEY)!));
    expect(keys.length).toBe(60);
    expect(loadDrawings("SYM0.US", "1D")).toEqual([]);
    expect(loadDrawings("SYM64.US", "1D").length).toBe(1);
  });

  it("reads tolerate a corrupted or hostile cache", () => {
    localStorage.setItem(KEY, "{not json");
    expect(loadDrawings("600519.SH", "1D")).toEqual([]);
    localStorage.setItem(KEY, JSON.stringify([1, 2, 3]));
    expect(loadDrawings("600519.SH", "1D")).toEqual([]);
    localStorage.setItem(
      KEY,
      JSON.stringify({ "600519.SH|1D": [{ name: "ok", points: [{ timestamp: 1 }] }, null, { points: [] }] }),
    );
    // Entries need a name and a points array; the rest of the row is dropped on
    // the way back in, not repaired.
    expect(loadDrawings("600519.SH", "1D")).toEqual([{ name: "ok", points: [{ timestamp: 1 }] }]);
    localStorage.setItem(KEY, JSON.stringify({ "AAPL.US|1D": "nope" }));
    expect(loadDrawings("AAPL.US", "1D")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Per-drawing style (local custom ⑯).
//
// The library resolves a figure's styles as
// `{ ...defaultStyles[type], ...overlay.styles?.[type], ...figure.styles }`
// (dist 8955), so writing `overlay.styles` is what makes one line red while its
// neighbour stays blue - and every built-in tool we expose leaves `color` to the
// overlay fragment.
// ---------------------------------------------------------------------------

describe("drawing styles", () => {
  const red: DrawingStyle = { color: "#F23645", size: 2, dashed: true };

  it("colours the line, its handles and its value label together", () => {
    const frag = overlayStylesOf(red);
    expect(frag.line).toEqual({ color: "#F23645", size: 2, style: "dashed", dashedValue: [4, 2] });
    // A red line with a blue price tag reads as a bug: the default label is
    // white-on-blue (dist 11744-11761), so the background follows the colour.
    expect(frag.text).toEqual({ color: "#FFFFFF", borderColor: "#F23645", backgroundColor: "#F23645" });
    expect(frag.point).toMatchObject({ color: "#F23645", activeColor: "#F23645" });
    expect(overlayStylesOf({ ...red, dashed: false }).line).toMatchObject({ style: "solid" });
  });

  it("withAlpha turns hex into rgba and leaves other strings alone", () => {
    expect(withAlpha("#F23645", 0.35)).toBe("rgba(242, 54, 69, 0.35)");
    expect(withAlpha("#fff", 1)).toBe("rgba(255, 255, 255, 1)");
    expect(withAlpha("tomato", 0.5)).toBe("tomato");
  });

  it("reads the style back, and leaves the library default unstored", () => {
    expect(styleOfOverlay({ styles: overlayStylesOf(red) })).toEqual(red);
    expect(styleOfOverlay({ styles: overlayStylesOf(DEFAULT_DRAWING_STYLE) })).toBeUndefined();
    expect(styleOfOverlay(null)).toBeUndefined();
    expect(styleOfOverlay({})).toBeUndefined();
    expect(styleOfOverlay({ styles: { line: { color: "not-a-hex" } } })).toBeUndefined();
    // A width without a colour is still a deviation worth banking.
    expect(styleOfOverlay({ styles: { line: { size: 3 } } })).toEqual({
      color: DEFAULT_DRAWING_STYLE.color,
      size: 3,
      dashed: false,
    });
    expect(isDefaultStyle(DEFAULT_DRAWING_STYLE)).toBe(true);
    expect(isDefaultStyle(red)).toBe(false);
  });

  it("survives a save/reload round trip with its colour", () => {
    const chart = fakeChart([]);
    expect(
      restoreDrawings(chart as never, [
        { name: "priceLine", paneId: MAIN_PANE_ID, points: [{ timestamp: 1, value: 2 }], style: red },
      ]).applied.length,
    ).toBe(1);
    // createOverlay got the fragment, so the chart really draws it red...
    expect(chart.createOverlay.mock.calls[0][0]).toMatchObject({ styles: { line: { color: "#F23645", size: 2 } } });
    // ...and serializing the instance banks it again instead of the default.
    expect(serializeDrawings(chart.overlays)[0].style).toEqual(red);
  });

  it("a default-styled drawing stays free of a style key in storage", () => {
    const chart = fakeChart([]);
    restoreDrawings(chart as never, [
      { name: "priceLine", paneId: MAIN_PANE_ID, points: [{ timestamp: 1, value: 2 }] },
    ]);
    expect(serializeDrawings(chart.overlays)[0]).not.toHaveProperty("style");
  });

  it("restyles one overlay by id, never the whole chart", () => {
    const chart = fakeChart([overlay({ id: "a" }), overlay({ id: "b", name: "segment" })]);
    expect(applyDrawingStyle(chart as never, "b", red)).toBe(true);
    expect(chart.overrideOverlay).toHaveBeenCalledWith({ id: "b", styles: overlayStylesOf(red) });
    expect(chart.overlays.find((o) => o.id === "a")?.styles).toBeUndefined();
    expect(styleOfOverlay(chart.overlays.find((o) => o.id === "b"))).toEqual(red);
    // An empty id matches nothing (a silent no-op), and a missing one matches
    // *everything* — the chart would come back single-colour. Neither is an
    // answer, so the helper refuses both before reaching the library.
    expect(applyDrawingStyle(chart as never, "", red)).toBe(false);
    expect(applyDrawingStyle(chart as never, undefined as never, red)).toBe(false);
    expect(chart.overrideOverlay).not.toHaveBeenCalledWith({ styles: expect.anything() });
    expect(chart.overlays.find((o) => o.id === "a")?.styles).toBeUndefined();
  });

  it("normalizeDrawingStyle rejects junk and clamps the width", () => {
    expect(normalizeDrawingStyle(red)).toEqual(red);
    expect(normalizeDrawingStyle({ color: "#f23645", size: 99 })).toEqual({ color: "#F23645", size: 6, dashed: false });
    expect(normalizeDrawingStyle({ color: "red" })).toBeNull();
    expect(normalizeDrawingStyle({ color: "#F23645", size: "2" })).toEqual({ color: "#F23645", size: 1, dashed: false });
    expect(normalizeDrawingStyle(null)).toBeNull();
    expect(normalizeDrawingStyle("x")).toBeNull();
  });

  it("the last used style is its own preference, not chart data", () => {
    const STYLE_KEY = "pro-chart.drawStyle.v1";
    expect(loadDrawingStyle()).toEqual(DEFAULT_DRAWING_STYLE);
    saveDrawingStyle(red);
    expect(loadDrawingStyle()).toEqual(red);
    expect(Object.keys(JSON.parse(localStorage.getItem(STYLE_KEY)!))).toEqual(["color", "size", "dashed"]);
    localStorage.setItem(STYLE_KEY, "{oops");
    expect(loadDrawingStyle()).toEqual(DEFAULT_DRAWING_STYLE);
    localStorage.setItem(STYLE_KEY, JSON.stringify({ color: 7 }));
    expect(loadDrawingStyle()).toEqual(DEFAULT_DRAWING_STYLE);
    // And it does not leak into the per-symbol drawing buckets.
    expect(localStorage.getItem(KEY)).toBeNull();
  });
});

describe("drawing list and per-line flags (local custom ⑰)", () => {
  const red: DrawingStyle = { color: "#F23645", size: 2, dashed: false };
  // Built from local time so the expected strings hold in any timezone.
  const day = new Date(2026, 8, 2).getTime();
  const bar = new Date(2026, 8, 2, 10, 30).getTime();
  const later = new Date(2026, 8, 5, 14, 5).getTime();

  it("lists finished drawings in chart order", () => {
    const chart = fakeChart([
      overlay({ id: "a" }),
      overlay({ id: "b", name: "segment", drawing: true }),
      overlay({ id: "c", name: "brush", points: [{ timestamp: bar, value: 1 }] }),
    ]);
    expect(listDrawings(chart as never).map((r) => r.id)).toEqual(["a", "c"]);
  });

  it("names a row by its tool, its bars and its price", () => {
    const chart = fakeChart([
      overlay({ id: "a", points: [{ timestamp: bar, value: 1327.816 }] }),
      overlay({ id: "b", name: "segment", points: [{ timestamp: day, value: 1300 }, { timestamp: later, value: 1290.5 }] }),
      overlay({ id: "c", points: [{ value: 52874.25 }] }),
    ]);
    const rows = listDrawings(chart as never);
    expect(rows[0].label).toBe("价格线");
    expect(rows[0].detail).toBe("09-02 10:30 · 价位 1327.82");
    expect(rows[0].style).toEqual(DEFAULT_DRAWING_STYLE);
    expect(rows[1].label).toBe("趋势线");
    expect(rows[1].detail).toBe("09-02 → 09-05 14:05 · 1300 → 1290.5");
    expect(rows[1].pointCount).toBe(2);
    // A point with no timestamp (the one on the price axis) still gets named.
    expect(rows[2].detail).toBe("价位 52874.25");
  });

  it("a row carries the colour it was restyled to", () => {
    const chart = fakeChart([overlay({ id: "a" })]);
    applyDrawingStyle(chart as never, "a", red);
    const [row] = listDrawings(chart as never);
    expect(row.style).toEqual(red);
    expect(row.locked).toBe(false);
    expect(row.hidden).toBe(false);
  });

  it("lock lands even though the library says it repainted nothing", () => {
    const chart = fakeChart([overlay({ id: "a" }), overlay({ id: "b", name: "segment" })]);
    expect(applyDrawingFlags(chart as never, "a", { lock: true })).toBe(true);
    // `shouldUpdate()` does not watch `lock` (dist 8314-8318), so the library
    // answered "no redraw". Trusting that answer would drop the flag on the
    // floor — and never bank it.
    expect(chart.overrideOverlay.mock.results[0].value).toBe(false);
    expect(chart.overlays.find((o) => o.id === "a")?.lock).toBe(true);
    expect(chart.overlays.find((o) => o.id === "b")?.lock).toBe(false);
  });

  it("hiding flips `visible` and can be undone", () => {
    const chart = fakeChart([overlay({ id: "a" })]);
    expect(applyDrawingFlags(chart as never, "a", { hidden: true })).toBe(true);
    expect(chart.overrideOverlay).toHaveBeenLastCalledWith({ id: "a", visible: false });
    expect(chart.overlays[0].visible).toBe(false);
    // Hidden lines stay in the list — that is the only way back.
    expect(listDrawings(chart as never).map((r) => r.hidden)).toEqual([true]);
    expect(applyDrawingFlags(chart as never, "a", { hidden: false })).toBe(true);
    expect(chart.overlays[0].visible).toBe(true);
  });

  it("refuses to flag the whole chart", () => {
    const chart = fakeChart([overlay({ id: "a" }), overlay({ id: "b", name: "segment" })]);
    expect(applyDrawingFlags(chart as never, "", { lock: true })).toBe(false);
    expect(applyDrawingFlags(chart as never, "a", {})).toBe(false);
    expect(chart.overrideOverlay).not.toHaveBeenCalled();
    expect(chart.overlays.every((o) => o.lock === false)).toBe(true);
    // An id that is not on the chart is a no-op, not a success.
    expect(applyDrawingFlags(chart as never, "nope", { lock: true })).toBe(false);
    expect(chart.overlays.every((o) => o.lock === false)).toBe(true);
  });

  it("only a deviating flag costs storage, and both come back on reload", () => {
    const chart = fakeChart([overlay({ id: "a" }), overlay({ id: "b", name: "segment" })]);
    applyDrawingFlags(chart as never, "b", { lock: true, hidden: true });
    const stored = serializeDrawings(chart.overlays);
    expect(stored[0]).not.toHaveProperty("lock");
    expect(stored[0]).not.toHaveProperty("hidden");
    expect(stored[1]).toMatchObject({ name: "segment", lock: true, hidden: true });

    const fresh = fakeChart([]);
    expect(restoreDrawings(fresh as never, stored).applied.length).toBe(2);
    expect(fresh.overlays[0]).toMatchObject({ lock: false, visible: true });
    expect(fresh.overlays[1]).toMatchObject({ lock: true, visible: false });
    expect(serializeDrawings(fresh.overlays)).toEqual(stored);
  });

  it("a half-drawn overlay is neither a row nor storage", () => {
    const stuck = overlay({ id: "a", drawing: true, lock: true });
    expect(describeDrawing(stuck)).toBeNull();
    expect(serializeDrawings([stuck])).toEqual([]);
  });

  it("describeDrawing needs an id and a name to be listable", () => {
    expect(describeDrawing(null)).toBeNull();
    expect(describeDrawing({ name: "priceLine" })).toBeNull();
    expect(describeDrawing({ id: "a" })).toBeNull();
    // A tool the toolbar does not ship still gets a row, under its raw name.
    expect(describeDrawing({ id: "a", name: "mysteryTool" })?.label).toBe("mysteryTool");
  });

  it("formatBarTime keeps the clock only when the bar is not a session open", () => {
    expect(formatBarTime(day)).toBe("09-02");
    expect(formatBarTime(bar)).toBe("09-02 10:30");
    // Epoch seconds are understood too; the loader only ever hands back ms.
    expect(formatBarTime(Math.floor(day / 1000))).toBe("09-02");
  });
});

describe("sub-pane drawings (local custom ⑲)", () => {
  /** A drawing that lives on the MACD pane, not on the price chart. */
  const macdLine: StoredDrawing = {
    name: "priceLine",
    paneId: "sub:MACD",
    points: [{ timestamp: 1_700_000_000_000, value: -0.42 }],
  };
  /** Every `sub:` pane is closed; only the main chart is on screen. */
  const mainOnly = (id: string) => id === MAIN_PANE_ID;

  it("an address survives a reload only if this module issued it", () => {
    expect(isRestorablePaneId(MAIN_PANE_ID)).toBe(true);
    expect(isRestorablePaneId("sub:MACD")).toBe(true);
    // The library's own pane ids are random per mount (dist 15271 counting up
    // from Date.now(), dist 450-460), so a drawing stored against one has no
    // address to come back to — and `createOverlay` would quietly move it onto
    // the candle pane (dist 15364-15367) while keeping its MACD-scale value:
    // the invisible line ⑭ was filed for, reborn out of a saved file.
    expect(isRestorablePaneId("indicator_pane_1725507123456_4")).toBe(false);
    expect(isRestorablePaneId("")).toBe(false);
    expect(isRestorablePaneId("x_axis_pane")).toBe(false);
    expect(paneIndicator("sub:UCI_t2")).toBe("UCI_t2");
    expect(paneIndicator(MAIN_PANE_ID)).toBe("");
  });

  it("draws on the sub pane it was stored against while that pane is open", () => {
    const chart = fakeChart([]);
    const report = restoreDrawings(chart as never, [macdLine], undefined, (id) => id !== "x_axis_pane");
    expect(report.parked).toEqual([]);
    expect(report.applied).toEqual([macdLine]);
    expect(chart.createOverlay.mock.calls[0][0]).toMatchObject({ name: "priceLine", paneId: "sub:MACD" });
    expect(chart.overlays[0].paneId).toBe("sub:MACD");
  });

  it("parks a drawing whose pane is closed instead of letting the library re-home it", () => {
    const chart = fakeChart([]);
    const report = restoreDrawings(
      chart as never,
      [macdLine, { name: "segment", paneId: MAIN_PANE_ID, points: [{ timestamp: 1, value: 2 }] }],
      undefined,
      mainOnly,
    );
    // The refused line never reaches `createOverlay`: once the library has
    // re-homed it there is no trace left of where it used to live.
    expect(chart.createOverlay).toHaveBeenCalledTimes(1);
    expect(chart.overlays.map((o) => o.paneId)).toEqual([MAIN_PANE_ID]);
    expect(report.applied.map((d) => d.name)).toEqual(["segment"]);
    expect(report.parked).toEqual([macdLine]);
  });

  it("parks a dead id under its own name, and the default lookup parks nothing", () => {
    const chart = fakeChart([]);
    const legacy = { ...macdLine, paneId: "indicator_pane_1_2" };
    const report = restoreDrawings(chart as never, [legacy]);
    expect(chart.createOverlay).not.toHaveBeenCalled();
    expect(report.applied).toEqual([]);
    // Rewriting it to the main chart is the silent corruption being prevented,
    // so the parked copy keeps the unusable id and the UI can say "已关闭的副图".
    expect(report.parked).toEqual([legacy]);
    expect(ALL_PANES_PRESENT("anything-at-all")).toBe(true);
  });

  it("an overlay the library refused to create is parked, not lost", () => {
    // `createOverlay` answers "" for an unknown tool name (dist 15361). A caller
    // that only counted its input would then bank a smaller bucket over the top
    // of the real one, and the line would be gone after the next reload.
    const chart = fakeChart([]);
    chart.createOverlay.mockReturnValue("");
    const report = restoreDrawings(chart as never, [macdLine]);
    expect(report.applied).toEqual([]);
    expect(report.parked).toEqual([macdLine]);
  });

  it("a sub-pane row reports its number as a value, not a price", () => {
    const chart = fakeChart([
      overlay({ id: "a", paneId: "sub:MACD", points: [{ value: -0.42 }] }),
      overlay({ id: "b", points: [{ value: 52874.25 }] }),
    ]);
    const rows = listDrawings(chart as never);
    expect(rows[0].paneId).toBe("sub:MACD");
    expect(rows[0].detail).toBe("值 -0.42");
    expect(rows[1].paneId).toBe(MAIN_PANE_ID);
    expect(rows[1].detail).toBe("价位 52874.25");
    // A stored row with no pane (pre-⑲ data, or the axis strip) is the main chart.
    expect(describeDrawing({ id: "z", name: "priceLine", points: [] })?.paneId).toBe(MAIN_PANE_ID);
  });
});

/**
 * Anchors in the blank gap right of the newest bar (local custom ⑳).
 *
 * The library never refuses one: `StoreImp.timestampToDataIndex` takes a
 * timestamp past the last bar and extrapolates a data index from it (dist
 * 13839-13841), so the click that looked like "the right edge" is stored as a
 * trading time the series does not contain. The line hangs out past the last
 * candle, its x-axis label names a date nobody traded, and the next real bar
 * moves it left. These are the three answers the UI needs from the pure layer:
 * where the edge is, what to do with a point past it, and when the repair leaves
 * nothing worth keeping.
 */
describe("落点必须在真实存在的 K 线上", () => {
  const DAY = 86_400_000;
  const LAST = 1_700_000_000_000 + 100 * DAY;

  it("lastBarTimestamp 从尾部往前找，不猜", () => {
    expect(lastBarTimestamp([])).toBeUndefined();
    expect(lastBarTimestamp(null)).toBeUndefined();
    expect(lastBarTimestamp(undefined)).toBeUndefined();
    expect(lastBarTimestamp([{ timestamp: LAST - DAY }, { timestamp: LAST }])).toBe(LAST);
    expect(lastBarTimestamp([{ timestamp: LAST }, { timestamp: undefined }, {}])).toBe(LAST);
    expect(lastBarTimestamp([{ timestamp: Number.NaN }])).toBeUndefined();
  });

  it("越界的落点吸回最后一根，纵值一个都不改", () => {
    const r = clampPointsToLastBar(
      [
        { timestamp: LAST - DAY, value: 1300 },
        { timestamp: LAST, value: 1305 },
        { timestamp: LAST + 3 * DAY, value: 1310 },
      ],
      LAST,
    );
    expect(r.moved).toBe(1);
    expect(r.degenerate).toBe(false);
    expect(r.points).toEqual([
      { timestamp: LAST - DAY, value: 1300 },
      { timestamp: LAST, value: 1305 },
      { timestamp: LAST, value: 1310 },
    ]);
  });

  it("两点全越界：吸回来重合成一个点，判定为退化", () => {
    const r = clampPointsToLastBar(
      [
        { timestamp: LAST + DAY, value: 1300 },
        { timestamp: LAST + 5 * DAY, value: 1320 },
      ],
      LAST,
    );
    expect(r.moved).toBe(2);
    expect(r.degenerate).toBe(true);
  });

  it("单点工具永不退化：它活在纵值上，不靠宽度", () => {
    expect(clampPointsToLastBar([{ timestamp: LAST + 9 * DAY, value: 1290 }], LAST).degenerate).toBe(false);
  });

  it("没有时间戳的点不归它管", () => {
    const r = clampPointsToLastBar(
      [
        { value: 1300 },
        { timestamp: LAST + DAY, value: 1310 },
      ],
      LAST,
    );
    expect(r.points[0]).toEqual({ value: 1300 });
    expect(r.moved).toBe(1);
    expect(r.degenerate).toBe(false);
  });

  it("整桶汇总：越界的吸回，退化的丢下", () => {
    const out = clampDrawingsToLastBar(
      [
        { name: "priceLine", paneId: MAIN_PANE_ID, points: [{ timestamp: LAST + 2 * DAY, value: 1290 }] },
        {
          name: "segment",
          paneId: MAIN_PANE_ID,
          points: [
            { timestamp: LAST + DAY, value: 1300 },
            { timestamp: LAST + 4 * DAY, value: 1320 },
          ],
        },
      ],
      LAST,
    );
    expect(out.moved).toBe(3);
    expect(out.dropped).toBe(1);
    expect(out.drawings).toEqual([
      { name: "priceLine", paneId: MAIN_PANE_ID, points: [{ timestamp: LAST, value: 1290 }] },
    ]);
  });

  it("reanchorOverlay 原地改 points，不删不建", () => {
    const line = overlay({ id: "a", name: "segment", points: [{ timestamp: LAST + DAY, value: 1300 }] });
    const chart = fakeChart([line]);
    expect(reanchorOverlay(chart as never, line, LAST)).toEqual({ moved: 1, dropped: [] });
    expect(line.points).toEqual([{ timestamp: LAST, value: 1300 }]);
    expect(chart.overrideOverlay).toHaveBeenCalledWith({ id: "a", points: [{ timestamp: LAST, value: 1300 }] });
    expect(chart.removeOverlay).not.toHaveBeenCalled();
    expect(chart.createOverlay).not.toHaveBeenCalled();
  });

  it("没越界就一次覆盖都不发", () => {
    const line = overlay({ id: "a", points: [{ timestamp: LAST, value: 1300 }] });
    const chart = fakeChart([line]);
    expect(reanchorOverlay(chart as never, line, LAST)).toEqual({ moved: 0, dropped: [] });
    expect(chart.overrideOverlay).not.toHaveBeenCalled();
  });

  it("画到一半的线不动：最后一个落点由下一次点击决定", () => {
    const line = overlay({
      id: "a",
      drawing: true,
      currentStep: 1,
      points: [{ timestamp: LAST + 3 * DAY, value: 1300 }],
    });
    const chart = fakeChart([line]);
    expect(reanchorOverlay(chart as never, line, LAST)).toEqual({ moved: 0, dropped: [] });
    expect(chart.overrideOverlay).not.toHaveBeenCalled();
    expect(chart.removeOverlay).not.toHaveBeenCalled();
  });

  it("退化的线会被删掉并报名，没_id 的孤儿直接略过", () => {
    const bad = overlay({
      id: "bad",
      points: [
        { timestamp: LAST + DAY, value: 1300 },
        { timestamp: LAST + 2 * DAY, value: 1310 },
      ],
    });
    const chart = fakeChart([bad, overlay({ id: "", points: [{ timestamp: LAST + DAY, value: 1290 }] })]);
    expect(reanchorOverlay(chart as never, chart.overlays[1], LAST)).toEqual({ moved: 0, dropped: [] });
    expect(reanchorOverlay(chart as never, null, LAST)).toEqual({ moved: 0, dropped: [] });
    expect(reanchorOverlay(chart as never, bad, LAST)).toEqual({ moved: 0, dropped: ["bad"] });
    expect(chart.overlays.map((o) => o.id)).toEqual([""]);
  });

  it("事件顺序：先吸附，再落盘，最后才能报本次的提示", () => {
    const order: string[] = [];
    const events = makeDrawingEvents({
      onChanged: () => order.push("bank"),
      onDrawEnd: () => order.push("drawEnd"),
      onAnchor: () => order.push("anchor"),
      onSettled: () => order.push("settle"),
    });
    events.onDrawEnd({ overlay: { id: "a" } });
    expect(order).toEqual(["drawEnd", "anchor", "bank", "settle"]);

    order.length = 0;
    events.onPressedMoveEnd({ overlay: { id: "a" } });
    expect(order).toEqual(["anchor", "bank", "settle"]);
  });

  it("事件不带参数也不能炸（⑮ 起的裸调用）", () => {
    const anchor = vi.fn();
    const events = makeDrawingEvents({ onChanged: () => undefined, onAnchor: anchor });
    expect(() => events.onDrawEnd({})).not.toThrow();
    expect(() => events.onPressedMoveEnd({})).not.toThrow();
    // Called with `undefined`, not with a fake overlay: the handler has to cope.
    expect(anchor).toHaveBeenCalledTimes(2);
    expect(anchor).toHaveBeenCalledWith(undefined);
  });
});

/**
 * 第③片 D：标注的文字。`extendData` 是库给 `simpleAnnotation` 的文案通道
 * （dist 12466-12478），本仓要让它跟着线走。
 */
describe("标注文字的存储", () => {
  const ts = 1_700_000_000_000;
  const dot = [{ timestamp: ts, value: 1300 }];

  it("带文字的标注落盘带 text，空白文字与别的工具都不落盘", () => {
    const rows = serializeDrawings([
      overlay({ id: "a", name: "simpleAnnotation", points: dot, extendData: "前高" }),
      overlay({ id: "b", name: "simpleAnnotation", points: dot, extendData: "   " }),
      overlay({ id: "c", name: "priceLine", points: dot, extendData: "不该被读" }),
    ]);
    expect(rows.map((r) => r.text)).toEqual(["前高", undefined, undefined]);
    expect(rows[1]).not.toHaveProperty("text");
    expect(rows[2]).not.toHaveProperty("text");
  });

  it("extendData 是函数时不崩也不落盘", () => {
    const rows = serializeDrawings([
      overlay({ id: "a", name: "simpleAnnotation", points: dot, extendData: () => "x" }),
    ]);
    expect(rows[0]).not.toHaveProperty("text");
  });

  it("超长文字截到 40 个字符", () => {
    const long = "字".repeat(45);
    const rows = serializeDrawings([overlay({ id: "a", name: "simpleAnnotation", points: dot, extendData: long })]);
    expect(rows[0]?.text).toBe(long.slice(0, MAX_DRAWING_TEXT));
    expect(MAX_DRAWING_TEXT).toBe(40);
  });

  it("normalizeDrawingText 只认字符串、去空白、截断", () => {
    expect(normalizeDrawingText("  前高  ")).toBe("前高");
    expect(normalizeDrawingText("")).toBeUndefined();
    expect(normalizeDrawingText("   ")).toBeUndefined();
    expect(normalizeDrawingText(7)).toBeUndefined();
    expect(normalizeDrawingText(null)).toBeUndefined();
    expect(normalizeDrawingText(undefined)).toBeUndefined();
    expect(normalizeDrawingText("字".repeat(41))?.length).toBe(40);
  });

  // 义务 4（评审席）：上限数的是**字**（码点），不是 UTF-16 码元。`slice(0, 40)` 会把
  // 一个 emoji 从代理对中间切断，剩下的孤立高位代理被 `JSON.stringify` 原样落盘，
  // 读回来标注框里就是一个替换字符 —— 用户看到的是"我的标注炸了"。
  //
  // 席 A 的 M-4：这条原来还带一句
  // `expect(JSON.parse(JSON.stringify(cut))).toBe(cut)`，已删 —— 它**恒真**，判不
  // 了它声称要防的那个漂移。ES2019 的 well-formed `JSON.stringify` 会把孤立代理
  // 转义成 `\udXXX` 再原样读回，所以对任何字符串这条都成立（控制器在 `e3b63669`
  // 实测：`node -e "const lone='\uD83D'; JSON.parse(JSON.stringify(lone))===lone"`
  // → true）。留着它只会给人"落盘往返有覆盖"的错觉。
  // 这条用例的判别力全在 `hasLoneSurrogate`，所以这里给它补上**反向对照**：真切出
  // 半个 emoji 的时候那个函数必须说 yes —— 否则上面的 `false` 可以是被写死的。
  it("截断按码点切：emoji 不会被切成孤立代理对", () => {
    const cut = normalizeDrawingText("📈".repeat(41));
    expect(cut).toBe("📈".repeat(40));
    expect(Array.from(cut ?? "")).toHaveLength(MAX_DRAWING_TEXT);
    expect(hasLoneSurrogate(cut ?? "")).toBe(false);

    // 反向对照：按码元切的 `slice(0, 40)` 留下的就是这样一个串。
    const halfEmoji = `${"📈".repeat(39)}\uD83D`;
    expect(halfEmoji).not.toBe(cut);
    expect(hasLoneSurrogate(halfEmoji)).toBe(true);

    // 切点正好落在代理对中间的形状：前面 39 个 BMP 字符，第 40 个码元是半个 emoji。
    const mixed = normalizeDrawingText(`${"价".repeat(39)}📈📉`);
    expect(mixed).toBe(`${"价".repeat(39)}📈`);
    expect(hasLoneSurrogate(mixed ?? "")).toBe(false);
  });

  it("恢复把文字送回 extendData，并与建线共用 toolCreateExtras", () => {
    const chart = fakeChart();
    restoreDrawings(chart as never, [
      { name: "simpleAnnotation", paneId: MAIN_PANE_ID, points: dot, text: "前高" },
    ]);
    const arg = chart.createOverlay.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(arg.extendData).toBe("前高");
    expect(arg.needDefaultPointFigure).toBe(true);
  });

  // 席 A 的 I-1：`hasText` 闸门此前只在三条**读侧**有（`serializeDrawings`、
  // `describeDrawing`、`drawingKey`），两条**写侧**没有。桶条目是手改得了的，
  // 所以外来的一条 `priceLine` 能带上 `text`，被这侧原样送进 `extendData` ——
  // 而 `priceLine` 模板压根不读 `extendData`（全库只有 `simpleAnnotation` 12475-12482
  // 与 `simpleTag` 12565-12572 两个模板读它当文字），于是图上什么都没有，
  // 下一次序列化却把它当"用户写过字"。不变量在 `chartDrawings.ts` 的 `DrawTool.hasText`
  // 注释里已经写下：「the other twelve tools have no such channel」。
  // 键必须**不写**，不是写成空值 —— 写空值会让这条线在 `drawingKey` 那边换个签名。
  it("恢复只给 hasText 的工具写 extendData；别的工具连键都不带", () => {
    const off = fakeChart();
    restoreDrawings(off as never, [
      { name: "priceLine", paneId: MAIN_PANE_ID, points: dot, text: "前高" } as never,
    ]);
    const priceLineArg = off.createOverlay.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(priceLineArg).not.toHaveProperty("extendData");

    // 同一条里补正例：换成唯一 `hasText` 的工具，同样的文字必须照原样落键。
    const on = fakeChart();
    restoreDrawings(on as never, [
      { name: "simpleAnnotation", paneId: MAIN_PANE_ID, points: dot, text: "前高" },
    ]);
    const annotationArg = on.createOverlay.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(annotationArg.extendData).toBe("前高");
  });

  it("没落盘样式的标注恢复时是实线，价格线仍不落样式（§二.11 两半）", () => {
    const a = fakeChart();
    restoreDrawings(a as never, [{ name: "simpleAnnotation", paneId: MAIN_PANE_ID, points: dot }]);
    const argA = a.createOverlay.mock.calls.at(-1)?.[0] as { styles?: { line?: { style?: string } } };
    expect(argA.styles?.line?.style).toBe("solid");

    const b = fakeChart();
    restoreDrawings(b as never, [{ name: "priceLine", paneId: MAIN_PANE_ID, points: dot }]);
    const argB = b.createOverlay.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(argB).not.toHaveProperty("styles");
  });

  it("落盘了样式的标注仍用落盘的那份，不被默认片段盖掉", () => {
    const chart = fakeChart();
    restoreDrawings(chart as never, [
      { name: "simpleAnnotation", paneId: MAIN_PANE_ID, points: dot, style: { color: "#F23645", size: 2, dashed: true } },
    ]);
    const arg = chart.createOverlay.mock.calls.at(-1)?.[0] as { styles: { line: Record<string, unknown> } };
    expect(arg.styles.line).toMatchObject({ color: "#F23645", size: 2, style: "dashed" });
  });

  it("无文字的线一个键都不多写（默认态不落盘）", () => {
    const chart = fakeChart();
    restoreDrawings(chart as never, [{ name: "segment", paneId: MAIN_PANE_ID, points: dot }]);
    const arg = chart.createOverlay.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(arg).not.toHaveProperty("extendData");
    expect(arg).not.toHaveProperty("needDefaultPointFigure");
    expect(arg).not.toHaveProperty("styles");
  });

  // 义务 1（评审席）：`normalizeDrawingText` 在**两端**都要过。存储桶是可以手改的，
  // 改脏了的 `text`（超长、纯空白）若原样送去 `extendData`，恢复出的线就和落盘的
  // 不是同一份，下一次编辑还会把脏值重新落盘。
  it("恢复侧也过 normalize：超长截到上限，纯空白不落键", () => {
    const chart = fakeChart();
    restoreDrawings(chart as never, [
      { name: "simpleAnnotation", paneId: MAIN_PANE_ID, points: dot, text: "字".repeat(45) },
    ]);
    const long = chart.createOverlay.mock.calls.at(-1)?.[0] as { extendData?: string };
    expect(long.extendData).toBe("字".repeat(40));

    const blank = fakeChart();
    restoreDrawings(blank as never, [
      { name: "simpleAnnotation", paneId: MAIN_PANE_ID, points: dot, text: "   " },
    ]);
    const arg = blank.createOverlay.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(arg).not.toHaveProperty("extendData");
  });

  // 义务 3（评审席）：这条钉防的是 §二.11 那枚虚线针杀掉的同一种漂移——恢复侧一旦
  // 给非 `hasText` 的工具也补默认样式片段，落盘就会长出一个没人要的 `style` 键，
  // 并且从此再也删不掉。
  it("端到端幂等：落盘→恢复→落盘逐字节稳定，且不给别的工具长出 style 键", () => {
    const chart = fakeChart([
      overlay({ id: "a", name: "simpleAnnotation", points: dot, extendData: "前高" }),
      overlay({ id: "b", name: "simpleAnnotation", points: dot }),
      overlay({ id: "c", name: "priceLine", points: dot, extendData: "不该被读" }),
      overlay({ id: "d", name: "segment", points: [{ timestamp: ts, value: 1300 }, { timestamp: ts + 1, value: 1290 }] }),
      overlay({ id: "e", name: "fibonacciLine", points: dot, lock: true, visible: false }),
    ]);
    const first = serializeDrawings(chart.overlays);
    const restored = fakeChart();
    expect(restoreDrawings(restored as never, first).applied).toEqual(first);
    const second = serializeDrawings(restored.overlays);
    expect(second).toEqual(first);
    // 至少覆盖一件带文字的、一件不带文字的，否则这条钉是空的。
    expect(second.map((s) => s.name)).toEqual(["simpleAnnotation", "simpleAnnotation", "priceLine", "segment", "fibonacciLine"]);
    for (const s of second) {
      if (toolOf(s.name)?.hasText === true) continue;
      expect(s, s.name).not.toHaveProperty("style");
      expect(s, s.name).not.toHaveProperty("text");
    }
  });
});

/**
 * 第③片 D：`applyDrawingText` —— 清单行输入框（T4）要的那个"改完把读回的文字交回去"。
 */
describe("改掉一条标注的文字", () => {
  it("指名道姓地 override，并把读回的文字交回去", () => {
    const chart = fakeChart([
      overlay({ id: "a", name: "simpleAnnotation", points: [{ timestamp: 1_700_000_000_000, value: 1300 }], extendData: "前高" }),
    ]);
    expect(applyDrawingText(chart as never, "a", "前低")).toBe("前低");
    expect(chart.overrideOverlay.mock.calls).toEqual([[{ id: "a", extendData: "前低" }]]);
    expect(chart.overlays[0].extendData).toBe("前低");
  });

  it("清空文字回空串；id 空或线不存在都不动图", () => {
    const chart = fakeChart([overlay({ id: "a", name: "simpleAnnotation" })]);
    expect(applyDrawingText(chart as never, "a", "   ")).toBe("");
    expect(chart.overlays[0].extendData).toBe("");
    // 空 id 在库外就被拒；不存在的 id 只会在库里匹配不到。两条都不许改到图上。
    expect(applyDrawingText(chart as never, "", "x")).toBeNull();
    expect(applyDrawingText(chart as never, "zz", "x")).toBeNull();
    expect(chart.overlays.map((o) => o.extendData)).toEqual([""]);
  });

  it("超长输入截到上限再写进去", () => {
    const chart = fakeChart([overlay({ id: "a", name: "simpleAnnotation" })]);
    const out = applyDrawingText(chart as never, "a", "字".repeat(50));
    expect(out?.length).toBe(40);
    expect(chart.overlays[0].extendData).toBe("字".repeat(40));
  });

  // 义务 2（评审席）：`extendData` 是 `shouldUpdate()`（KC:8314-8318）里唯一被本片
  // 用到的键——替身按它记重绘账，之前没有用例走过那两条分支。
  it("改文字真的重绘（不同于 lock/magnet），同值再写一次不重绘", () => {
    const chart = fakeChart([overlay({ id: "a", name: "simpleAnnotation", extendData: "前高" })]);
    expect(applyDrawingText(chart as never, "a", "前低")).toBe("前低");
    expect(chart.overrideOverlay.mock.results[0].value).toBe(true);
    expect(applyDrawingText(chart as never, "a", "前低")).toBe("前低");
    expect(chart.overrideOverlay.mock.results[1].value).toBe(false);
    // 判决仍然是实例而不是布尔：没重绘不等于没改成。
    expect(chart.overlays[0].extendData).toBe("前低");
    expect(chart.overrideOverlay.mock.calls).toEqual([
      [{ id: "a", extendData: "前低" }],
      [{ id: "a", extendData: "前低" }],
    ]);
  });
});

/**
 * 第③片 D 的清单行（T4）：行只有在自己的工具确实带文字时才把文字交出去，
 * 页面那一侧按工具给不给输入框，`text` 是这个工具此刻说的话。
 */
describe("清单行带出标注文字", () => {
  it("hasText 工具的行带出 text，其余工具不带", () => {
    const dot = [{ timestamp: 1_700_000_000_000, value: 1300 }];
    const a = describeDrawing(overlay({ id: "a", name: "simpleAnnotation", points: dot, extendData: "前高" }));
    expect(a?.text).toBe("前高");
    const b = describeDrawing(overlay({ id: "b", name: "simpleAnnotation", points: dot }));
    expect(b).toBeTruthy();
    expect(b).not.toHaveProperty("text");
    const c = describeDrawing(overlay({ id: "c", name: "priceLine", points: dot, extendData: "不该出现" }));
    expect(c).not.toHaveProperty("text");
  });

  // 义务 2（T3 评审席）：输入框的闸门在**行源**这一侧——`applyDrawingText` 既不认
  // `isInProgress` 也不认 `hasText`，所以半成品与非 `hasText` 的工具必须压根拿不到行。
  it("画到一半的标注拿不到行，也就拿不到输入框", () => {
    const dot = [{ timestamp: 1_700_000_000_000, value: 1300 }];
    const half = overlay({ id: "h", name: "simpleAnnotation", points: dot, extendData: "还没画完", drawing: true });
    expect(describeDrawing(half)).toBeNull();
    const chart = fakeChart([
      overlay({ id: "done", name: "simpleAnnotation", points: dot, extendData: "前高" }),
      half,
    ]);
    expect(listDrawings(chart as never).map((r) => r.id)).toEqual(["done"]);
  });

  it("行读的是同一个 normalize：函数型 extendData 不进 JSX，超长截到上限", () => {
    const dot = [{ timestamp: 1_700_000_000_000, value: 1300 }];
    expect(
      describeDrawing(overlay({ id: "f", name: "simpleAnnotation", points: dot, extendData: () => "渲染回调" }))?.text,
    ).toBeUndefined();
    const row = describeDrawing(
      overlay({ id: "g", name: "simpleAnnotation", points: dot, extendData: `  ${"字".repeat(45)}  ` }),
    );
    expect(row?.text).toBe("字".repeat(40));
  });
});

/**
 * 第③片 B：磁吸。库里本来就有 `mode`，本仓一行没用过（全仓 grep magnet 零命中）。
 */
describe("磁吸", () => {
  const ts = 1_700_000_000_000;
  const dot = [{ timestamp: ts, value: 1300 }];

  /**
   * A Pine 画的线的名字：问库要注册表，取第一个工具栏没有的内置模板（§二.6）。
   * 不写死字符串是因为 `DRAW_TOOLS` 会涨——第 1 任务把 `straightLine` 挂上了工具栏，
   * 于是"名字不在表里"这个判据必须由表本身来给，否则这条钉哪天变成空钉都没人知道。
   */
  const pineName = () => getSupportedOverlays().find((n) => !toolOf(n)) ?? "simpleTag";

  it("偏好读写只有 1/0 两种值，脏值与读不到都回关", () => {
    expect(loadMagnet()).toBe("normal");
    saveMagnet(true);
    expect(localStorage.getItem("pro-chart.magnet.v1")).toBe("1");
    expect(loadMagnet()).toBe("strong_magnet");
    saveMagnet(false);
    expect(localStorage.getItem("pro-chart.magnet.v1")).toBe("0");
    localStorage.setItem("pro-chart.magnet.v1", "weak_magnet");
    expect(loadMagnet()).toBe("normal");
    localStorage.removeItem("pro-chart.magnet.v1");
    expect(loadMagnet()).toBe("normal");
  });

  it("toolCreateExtras 只在开的时候写 mode", () => {
    expect(toolCreateExtras("priceLine")).toEqual({});
    expect(toolCreateExtras("priceLine", "strong_magnet")).toEqual({ mode: "strong_magnet" });
    expect(toolCreateExtras("priceLine", "normal")).toEqual({});
    expect(toolCreateExtras("simpleAnnotation", "strong_magnet")).toEqual({
      needDefaultPointFigure: true,
      mode: "strong_magnet",
    });
  });

  it("恢复带上 mode，默认参数不写这个键", () => {
    const on = fakeChart();
    restoreDrawings(on as never, [{ name: "priceLine", paneId: MAIN_PANE_ID, points: dot }], undefined, undefined, "strong_magnet");
    expect(on.createOverlay.mock.calls.at(-1)?.[0]).toMatchObject({ mode: "strong_magnet" });

    const off = fakeChart();
    restoreDrawings(off as never, [{ name: "priceLine", paneId: MAIN_PANE_ID, points: dot }]);
    expect(off.createOverlay.mock.calls.at(-1)?.[0]).not.toHaveProperty("mode");
  });

  it("批量切换只碰用户自己的已完成线", () => {
    const name = pineName();
    expect(toolOf(name), `${name} 已经进了 DRAW_TOOLS，这条钉需要另一个非工具名`).toBeUndefined();
    const chart = fakeChart([
      overlay({ id: "a", name: "priceLine", points: dot }),
      overlay({ id: "b", name: "segment", points: [{ timestamp: ts, value: 1 }, { timestamp: ts + 1, value: 2 }] }),
      // Pine 画的线：名字不在 DRAW_TOOLS 里，落点只有 dataIndex（所以也进不了存储）。
      overlay({ id: "pine", name, points: [{ dataIndex: 3, value: 9 }], currentStep: -1 }),
      // 半成品的用户线：正在放第二个点，不该被改。
      overlay({ id: "c", name: "segment", points: dot, drawing: true, currentStep: 1 }),
    ]);
    const touched = applyMagnetMode(chart as never, "strong_magnet");
    expect(touched).toBe(2);
    const ids = chart.overrideOverlay.mock.calls.map((c) => (c[0] as { id?: string }).id);
    expect(ids.sort()).toEqual(["a", "b"]);
    expect(chart.overlays.find((o) => o.id === "pine")?.mode).not.toBe("strong_magnet");
  });

  it("每条 override 都指名道姓，且关掉也把 mode 写回去", () => {
    const chart = fakeChart([overlay({ id: "a", name: "priceLine", points: dot, mode: "strong_magnet" })]);
    applyMagnetMode(chart as never, "normal");
    expect(chart.overrideOverlay.mock.calls).toEqual([[{ id: "a", mode: "normal" }]]);
    // 判决只能是读实例：`mode` 不在 `shouldUpdate()` 的五个键里（dist 8314-8318），
    // 改成功了库也回 `false`——替身按这条建模，所以这里的 `false` 同时也是在钉替身。
    expect(chart.overrideOverlay.mock.results[0].value).toBe(false);
    expect(chart.overlays[0].mode).toBe("normal");
  });

  it("两态都按名字写进实例，第三种 weak_magnet 不在这个 app 的词表里", () => {
    // §三.B：`modeSensitivity` 像素带没有 UI，所以本仓的词表只有两态。这条的判决
    // 在 `tsc`——下面那行 @ts-expect-error 一旦失效就是 "Unused '@ts-expect-error'
    // directive"，词表被谁悄悄放宽了会当场报出来。
    // @ts-expect-error weak_magnet 不是 MagnetMode
    const weak: MagnetMode = "weak_magnet";
    expect(weak).toBe("weak_magnet"); // 运行时它只是个字符串，闸门在类型面

    const modes: MagnetMode[] = ["normal", "strong_magnet"];
    expect(modes).toHaveLength(2);
    for (const mode of modes) {
      const chart = fakeChart([overlay({ id: "a", name: "priceLine", points: dot, mode: "strong_magnet" })]);
      expect(applyMagnetMode(chart as never, mode)).toBe(1);
      expect(chart.overrideOverlay).toHaveBeenLastCalledWith({ id: "a", mode });
      expect(chart.overlays[0].mode).toBe(mode);
    }
  });

  // 义务 1（评审席，第 2 任务交下来的）：替身得把构造器种下的 `needDefaultPointFigure`
  // 种成真 `false`。批量磁吸之后要读实例，而 `undefined` 与 `false` 在
  // `expect(...).toBe(false)` 上不等价——没种的替身会让"没被改动"这句话永远成立。
  //
  // 席 A 的 M-2 补上的是**另一半**：种了初值还不够，`overrideOverlay` 也得会写它
  // （见上面那句建模），否则这两行读回仍然恒过 —— 键没建模 ⇒ 替身把它丢了 ⇒
  // "它没变"。现在两行都咬得动：变异针（让 `applyMagnetMode` 顺手送
  // `needDefaultPointFigure: false`）跑过，第二条会红。
  it("批量磁吸只写 mode，别的一个键都不动", () => {
    const chart = fakeChart([
      overlay({ id: "a", name: "simpleAnnotation", points: dot }),
      overlay({ id: "b", name: "simpleAnnotation", points: dot, needDefaultPointFigure: true }),
    ]);
    expect(applyMagnetMode(chart as never, "strong_magnet")).toBe(2);
    expect(chart.overlays[0].needDefaultPointFigure).toBe(false);
    expect(chart.overlays[1].needDefaultPointFigure).toBe(true);
    expect(chart.overlays.map((o) => o.mode)).toEqual(["strong_magnet", "strong_magnet"]);
    // 线还是那条线：id、points、样式片段都没被这次批量改写动过。
    expect(chart.overrideOverlay.mock.calls.every((c) => Object.keys(c[0] as object).length === 2)).toBe(true);
    expect(chart.removeOverlay).not.toHaveBeenCalled();
    expect(chart.createOverlay).not.toHaveBeenCalled();
  });

  it("空图与无 id 的孤儿都不报错，也不写盘", () => {
    expect(applyMagnetMode(fakeChart() as never, "strong_magnet")).toBe(0);
    const chart = fakeChart([overlay({ id: "", name: "priceLine", points: dot })]);
    expect(applyMagnetMode(chart as never, "strong_magnet")).toBe(0);
    expect(chart.overrideOverlay).not.toHaveBeenCalled();
    // 磁吸是偏好，不是画线数据：开它绝不该让存储桶长出一个键。
    expect(localStorage.getItem("pro-chart.drawings.v1")).toBeNull();
  });
});
