import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  DRAW_TOOLS,
  MAIN_PANE_ID,
  cancelInProgress,
  drawingsBucket,
  drawHint,
  isInProgress,
  loadDrawings,
  removeLatestDrawing,
  restoreDrawings,
  saveDrawings,
  serializeDrawings,
  toolOf,
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
}

function overlay(patch: Partial<FakeOverlay> & { id: string }): FakeOverlay {
  const o: FakeOverlay = {
    name: "priceLine",
    paneId: MAIN_PANE_ID,
    points: [{ timestamp: 1_700_000_000_000, value: 1300 }],
    currentStep: -1,
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
    getOverlays: vi.fn(() => overlays),
    createOverlay: vi.fn((value: unknown) => {
      const v = value as { name?: string; paneId?: string; points?: FakeOverlay["points"] };
      overlays.push(
        overlay({ id: `o${overlays.length}`, name: v.name ?? "", paneId: v.paneId ?? "", points: v.points ?? [] }),
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
