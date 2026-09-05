/**
 * Pane height budget for the pro chart (local custom ⑭).
 *
 * KLineChart lays panes out in one very specific way — `ChartImp._layout`
 * (klinecharts/dist/index.esm.js, 14787-14830):
 *
 *   remaining = chartHeight - xAxisHeight - separatorCount * separatorSize
 *   every pane except the main one takes `max(minHeight, height)` (14812)
 *   candle_pane is the *flexible* pane and gets **whatever is left** (14822)
 *
 * The default pane option is `height: 100`, so every sub-indicator pane added
 * costs the main chart a flat 100px. Measured on a 360px-tall chart with
 * VOL + MACD + two saved custom indicators, the main chart came out **29px
 * tall** — which is why the drawing tools looked dead: a click meant for the
 * price chart landed on a volume pane instead, and the library happily stored
 * a volume-scale value (52 874 on a 1 300 price chart) as the drawn "price
 * line", i.e. an invisible line on a pane the user never meant to draw on.
 *
 * So the sub panes must be sized *from* the available height instead of
 * charging the main chart a flat 100px each. This module is that budget, as a
 * pure function so the arithmetic can be pinned without a canvas.
 */

/** The x-axis pane auto-sizes; ~26px in practice (measured, 2026-09-05). */
export const DEFAULT_X_AXIS_HEIGHT = 26;
/** `styles.separator.size` default — the drag handle between two panes. */
export const DEFAULT_SEPARATOR_SIZE = 1;

export interface PaneLayoutInput {
  /** CSS pixels available to the chart (the host element's client height). */
  chartHeight: number;
  /** Sub-indicator pane ids: everything except the main chart and the x axis. */
  subPaneIds: readonly string[];
  xAxisHeight?: number;
  separatorSize?: number;
  /** The main chart should never fall below this share of the usable height. */
  mainMinFraction?: number;
  /** ...and never below this many pixels, whichever is larger. The chart host
   * is `min-h-[360px]`, so 180 is the floor at that smallest supported size. */
  mainMinPx?: number;
  /** A sub pane needs this much to be worth showing at all. */
  subMinPx?: number;
  /** No point making VOL 300px tall on a 4K monitor. */
  subMaxPx?: number;
}

export interface PanePlan {
  /** Height handed to each sub pane. */
  subPaneHeight: number;
  /** Height left for the main chart. */
  mainHeight: number;
  /** `setPaneOptions` payload per sub pane, ready to apply. */
  assignments: Record<string, number>;
  /** True when even the smallest sub panes would eat the main chart's floor. */
  starved: boolean;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi);

/** Pane ids that are *not* the main chart or the axis strip. */
export function subPaneIdsOf(panes: readonly { id?: string }[]): string[] {
  return panes
    .map((p) => p.id ?? "")
    .filter((id) => id.length > 0 && id !== "candle_pane" && id !== "x_axis_pane");
}

export function planPaneHeights(input: PaneLayoutInput): PanePlan {
  const {
    chartHeight,
    subPaneIds,
    xAxisHeight = DEFAULT_X_AXIS_HEIGHT,
    separatorSize = DEFAULT_SEPARATOR_SIZE,
    mainMinFraction = 0.55,
    mainMinPx = 180,
    subMinPx = 44,
    subMaxPx = 120,
  } = input;

  // One separator per boundary: main|sub, then sub|sub.
  const separators = Math.max(subPaneIds.length, 0);
  const usable = Math.max(0, Math.floor(chartHeight) - xAxisHeight - separators * separatorSize);
  const mainFloor = Math.max(mainMinPx, Math.floor(usable * mainMinFraction));
  const budget = Math.max(0, usable - mainFloor);
  const count = subPaneIds.length;

  // Share what the main chart can spare, but never below a readable floor:
  // an unreadable VOL strip is worse than a scrollable page.
  const share = count > 0 ? Math.floor(budget / count) : subMaxPx;
  const subPaneHeight = clamp(share, subMinPx, subMaxPx);
  const mainHeight = Math.max(0, usable - subPaneHeight * count);

  const assignments: Record<string, number> = {};
  for (const id of subPaneIds) assignments[id] = subPaneHeight;

  return {
    subPaneHeight,
    mainHeight,
    assignments,
    starved: count > 0 && mainHeight < mainFloor,
  };
}
