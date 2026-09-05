import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DEFAULT_DRAWING_STYLE,
  DRAW_TOOLS,
  MAIN_PANE_ID,
  applyDrawingFlags,
  applyDrawingStyle,
  cancelInProgress,
  describeDrawing,
  drawingsBucket,
  drawHint,
  formatBarTime,
  isInProgress,
  isDefaultStyle,
  listDrawings,
  loadDrawingStyle,
  loadDrawings,
  makeDrawingEvents,
  normalizeDrawingStyle,
  overlayStylesOf,
  removeLatestDrawing,
  restoreDrawings,
  saveDrawingStyle,
  saveDrawings,
  serializeDrawings,
  styleOfOverlay,
  toolOf,
  withAlpha,
  type DrawingStyle,
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
  points: Array<{ timestamp?: number; value?: number }>;
  currentStep: number;
  drawing?: boolean;
  isDrawing?: () => boolean;
  styles?: Record<string, unknown>;
  lock?: boolean;
  visible?: boolean;
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
    // `OverlayImp`'s constructor sets both before merging what the caller
    // passed (dist 8240-8275), so a live instance always has them.
    lock: false,
    visible: true,
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
        const prevPoints = JSON.stringify(target.points);
        // `OverlayImp.override` merges everything except id/name/currentStep,
        // and handles styles/points on their own branches (dist 8277-8306).
        if ("lock" in v) target.lock = v.lock;
        if ("visible" in v) target.visible = v.visible;
        if (v.styles) target.styles = { ...(target.styles ?? {}), ...v.styles };
        if (v.points) target.points = v.points.slice();
        // `shouldUpdate()` repaints for a visible/points/styles change and for
        // zLevel sorts — never for `lock` alone (dist 8314-8318). That is why
        // `applyDrawingFlags` verifies by reading the instance back.
        draw =
          draw ||
          prevVisible !== target.visible ||
          prevStyles !== target.styles ||
          prevPoints !== JSON.stringify(target.points);
      }
      return draw;
    }),
  };
}

beforeEach(() => {
  localStorage.clear();
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
    expect(restoreDrawings(chart as never, stored)).toBe(2);
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
    expect(restoreDrawings(chart as never, [stored[0]], events)).toBe(1);
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
      ]),
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
    expect(restoreDrawings(fresh as never, stored)).toBe(2);
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
