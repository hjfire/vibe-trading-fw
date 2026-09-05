import { describe, expect, it } from "vitest";

import {
  DEFAULT_SEPARATOR_SIZE,
  DEFAULT_X_AXIS_HEIGHT,
  isSubPaneId,
  planPaneHeights,
  subPaneIdOf,
  subPaneIdsOf,
  subPaneNameOf,
} from "../paneLayout";

/**
 * The pane budget behind “画线无法使用” (local custom ⑭) and the stable pane
 * addresses behind “副图也能画线” (local custom ⑲).
 *
 * These numbers are not invented: they are the measurements taken on
 * /pro-chart on 2026-09-05 (see `paneLayout.ts` for the library source lines),
 * so the regressions they guard are real ones.
 */

/** KLineChart's own arithmetic: every sub pane takes `max(minHeight, height)`,
 * the main chart gets the remainder. Used here to prove the old shape. */
function libraryLayout(chartHeight: number, subCount: number, paneHeight = 100): number {
  const usable =
    chartHeight - DEFAULT_X_AXIS_HEIGHT - subCount * DEFAULT_SEPARATOR_SIZE;
  return usable - subCount * paneHeight;
}

describe("subPaneIdsOf", () => {
  it("keeps only the sub-indicator panes", () => {
    const panes = [
      { id: "candle_pane" },
      { id: "pane_vol" },
      { id: "pane_macd" },
      { id: "x_axis_pane" },
      { id: "" },
      {},
    ];
    expect(subPaneIdsOf(panes)).toEqual(["pane_vol", "pane_macd"]);
  });
});

describe("planPaneHeights", () => {
  const host = 360; // `.min-h-[360px]` in ProChart, the measured failing case

  it("reproduces the reported failure: 3 sub panes left the main chart ~29px", () => {
    // Measured in the DOM on 2026-09-05 (candle_pane rect = 29px tall; the last
    // pixel went to the auto-sized x axis), four sub panes did not fit at all.
    expect(libraryLayout(host, 3)).toBeLessThan(40);
    expect(libraryLayout(host, 4)).toBeLessThan(0);
  });

  it("hands the main chart back the majority of the height", () => {
    const plan = planPaneHeights({ chartHeight: host, subPaneIds: ["a", "b", "c"] });
    const usable = host - DEFAULT_X_AXIS_HEIGHT - 3 * DEFAULT_SEPARATOR_SIZE;

    expect(plan.mainHeight).toBe(usable - 3 * plan.subPaneHeight);
    expect(plan.mainHeight).toBeGreaterThan(usable * 0.5);
    expect(plan.mainHeight).toBeGreaterThan(29);
    expect(plan.starved).toBe(false);
  });

  it("assigns one height per sub pane, and nothing to the main chart", () => {
    const plan = planPaneHeights({ chartHeight: host, subPaneIds: ["a", "b"] });
    expect(Object.keys(plan.assignments).sort()).toEqual(["a", "b"]);
    expect(plan.assignments.a).toBe(plan.subPaneHeight);
    expect(plan.assignments.b).toBe(plan.subPaneHeight);
  });

  it("gives up when there is nothing to take", () => {
    const plan = planPaneHeights({ chartHeight: host, subPaneIds: [] });
    expect(plan.assignments).toEqual({});
    expect(plan.starved).toBe(false);
    expect(plan.mainHeight).toBe(host - DEFAULT_X_AXIS_HEIGHT);
  });

  it("never returns a fractional or negative height", () => {
    for (const height of [200, 360, 421, 720, 1080]) {
      for (let n = 0; n < 6; n++) {
        const plan = planPaneHeights({ chartHeight: height, subPaneIds: Array.from({ length: n }, (_, i) => `p${i}`) });
        expect(Number.isInteger(plan.subPaneHeight)).toBe(true);
        expect(Number.isInteger(plan.mainHeight)).toBe(true);
        expect(plan.subPaneHeight).toBeGreaterThanOrEqual(0);
        expect(plan.mainHeight).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("shrinks sub panes instead of the main chart, but stays readable", () => {
    const plan = planPaneHeights({ chartHeight: 1080, subPaneIds: ["a"] });
    expect(plan.subPaneHeight).toBeLessThanOrEqual(120); // subMaxPx: no 300px VOL strip
    expect(plan.mainHeight).toBeGreaterThan(700);
    expect(plan.starved).toBe(false);
  });

  it("keeps a minimum height per sub pane and flags a starving chart", () => {
    const plan = planPaneHeights({ chartHeight: 360, subPaneIds: ["a", "b", "c", "d", "e", "f"] });
    expect(plan.subPaneHeight).toBe(44); // subMinPx, below this the pane is noise
    expect(plan.starved).toBe(true); // ...and the main chart pays for it
    expect(plan.mainHeight).toBeGreaterThan(0);
  });

  it("floors the main chart in pixels as well as by fraction", () => {
    // A short chart: 55% of usable would be under the 180px floor, so the
    // pixel floor is what decides how much the sub panes get.
    const plan = planPaneHeights({ chartHeight: 340, subPaneIds: ["a", "b"] });
    const usable = 340 - DEFAULT_X_AXIS_HEIGHT - 2 * DEFAULT_SEPARATOR_SIZE;
    expect(usable * 0.55).toBeLessThan(180);
    expect(plan.mainHeight).toBe(180);
    expect(plan.subPaneHeight).toBe(Math.floor((usable - 180) / 2));
    expect(plan.starved).toBe(false);
  });

  it("is deterministic, so callers can skip an unchanged relayout", () => {
    const input = { chartHeight: 500, subPaneIds: ["a", "b", "c"] };
    expect(planPaneHeights(input)).toEqual(planPaneHeights(input));
  });

  it("honours overrides for callers that restyle the chart", () => {
    const plan = planPaneHeights({
      chartHeight: 400,
      subPaneIds: ["a", "b"],
      xAxisHeight: 40,
      separatorSize: 6,
      mainMinFraction: 0.5,
      mainMinPx: 100,
      subMaxPx: 60,
    });
    const usable = 400 - 40 - 2 * 6;
    expect(plan.mainHeight + 2 * plan.subPaneHeight).toBe(usable);
    expect(plan.subPaneHeight).toBe(60);
  });
});

describe("sub-pane identity (local custom ⑲)", () => {
  it("re-issues the same address for the same indicator", () => {
    // The library would answer `indicator_pane_<Date.now()>_<n>` instead (dist
    // 15271 over dist 450-460), i.e. a different string on every mount, so a
    // drawing stored against it has no address to come back to. Pinning the
    // name → id map is what makes a sub-pane drawing survive a reload.
    expect(subPaneIdOf("VOL")).toBe("sub:VOL");
    expect(subPaneIdOf("MACD")).toBe("sub:MACD");
    expect(subPaneIdOf("UCI_t9")).toBe(subPaneIdOf("UCI_t9"));
  });

  it("flattens an awkward name instead of rejecting it", () => {
    expect(subPaneIdOf("rsi.d1/h4")).toBe("sub:rsi_d1_h4");
    expect(subPaneIdOf("__x__")).toBe("sub:x");
    // An empty name still has to produce a usable id, never the bare prefix:
    // `isSubPaneId("sub:")` is false, and a pane nobody can name cannot be
    // found again either.
    expect(subPaneIdOf("")).toBe("sub:pane");
    expect(subPaneIdOf("中文")).toBe("sub:pane");
    expect(isSubPaneId(subPaneIdOf(""))).toBe(true);
  });

  it("reads its own ids back, and nothing else", () => {
    expect(isSubPaneId("sub:MACD")).toBe(true);
    expect(isSubPaneId("sub:")).toBe(false);
    expect(isSubPaneId("candle_pane")).toBe(false);
    // The library's shape is deliberately not one of ours: a pane stored under
    // it is unreachable, and `createOverlay` would move such a drawing onto the
    // candle pane in silence (dist 15364-15367).
    expect(isSubPaneId("indicator_pane_1725507123456_4")).toBe(false);
    expect(subPaneNameOf("sub:UCI_t9")).toBe("UCI_t9");
    expect(subPaneNameOf("candle_pane")).toBe("candle_pane");
    for (const name of ["VOL", "MACD", "UCI_t9", "rsi.d1"]) {
      expect(subPaneNameOf(subPaneIdOf(name))).toBe(subPaneIdOf(name).slice("sub:".length));
    }
  });

  it("is a namespace the built-in ids cannot collide with", () => {
    for (const id of ["candle_pane", "x_axis_pane"]) {
      expect(isSubPaneId(id)).toBe(false);
      // `subPaneIdsOf` keeps them out of the height budget, and the prefix keeps
      // them out of the drawing addresses — two different questions, same answer.
      expect(subPaneIdsOf([{ id }])).toEqual([]);
    }
  });
});
