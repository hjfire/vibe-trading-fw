/**
 * Pane height budget and pane identity for the pro chart (local custom ⑭, ⑲).
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
 *
 * It also owns the *address* of a sub pane (`subPaneIdOf`), for the same reason:
 * the pane is where a drawing says it lives, and only this module knows how the
 * library names panes.
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

/* --------------------------------------------------------------------------
 * Stable sub-pane identity (local custom ⑲)
 * -------------------------------------------------------------------------- */

/**
 * `createIndicator` invents a pane id when the caller does not pass one:
 * `indicator.paneId ?? createId('indicator_pane_')` (dist 15271), and `createId`
 * counts up from `Date.now()` (dist 450-460). Measured in the browser, a MACD
 * pane came back as `indicator_pane_1725507123456_4` on one mount and
 * `..._7` on the next — a fresh random id every single time the page reloads.
 *
 * That is harmless while nothing remembers a pane id, and fatal as soon as
 * something does: a drawing banked against `indicator_pane_…4` has nowhere to
 * go on the next load, which is why ⑭/⑱ pinned every drawing to the main chart
 * and ⑱ kept forcing imported `paneId`s back to it. Drawing on a sub pane is
 * otherwise free — the first click re-homes the overlay through
 * `updateProgressOverlayInfo` (dist 8508-8510, which also overrides the
 * instance's own `paneId`) — so the only thing missing was an address that
 * survives a reload.
 *
 * Hence: pass the id in, derived from the indicator name, and it is the same
 * string on every mount. `sub:` is a namespace of our own, so a stored paneId is
 * easy to tell apart from a stray library-generated one (see
 * `chartDrawings.isRestorablePaneId`).
 */
export const SUB_PANE_PREFIX = "sub:";

/** Indicator names are identifiers; anything else is flattened, not rejected. */
const PANE_NAME_UNSAFE = /[^A-Za-z0-9_-]+/g;

/**
 * The pane a given indicator lives on. Collisions are possible in theory
 * (`"A B"` and `"A_B"` agree) and harmless in practice, because both sides of
 * the call site pass a KLineChart indicator name, which must be one word.
 */
export function subPaneIdOf(name: string): string {
  const slug = name.replace(PANE_NAME_UNSAFE, "_").replace(/^_+|_+$/g, "") || "pane";
  return `${SUB_PANE_PREFIX}${slug}`;
}

/** True for an id this module could have produced (and therefore re-issue). */
export function isSubPaneId(id: string): boolean {
  return id.startsWith(SUB_PANE_PREFIX) && id.length > SUB_PANE_PREFIX.length;
}

/**
 * The indicator name behind a sub-pane id (`sub:` stripped). Together with
 * `isSubPaneId` this is what answers "which indicator does a stored drawing
 * belong to?" — and a random `indicator_pane_…` id from an older session
 * deliberately fails that test: handing one to `createOverlay` makes the
 * library **silently** fall back to the candle pane (dist 15364-15367) while it
 * keeps the volume/MACD-scale value, i.e. the invisible line ⑭ was filed for,
 * reborn through a saved file. `chartDrawings.isRestorablePaneId` is the
 * predicate that keeps it out of the chart.
 */
export function subPaneNameOf(id: string): string {
  return isSubPaneId(id) ? id.slice(SUB_PANE_PREFIX.length) : id;
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
