import type { Crosshair, KLineData, Period } from "klinecharts";
import { fitBarSpace, fitOffsetRight } from "./timeShare";

/**
 * Time-axis plumbing for the multi-chart page (four charts, four periods, one
 * symbol). Kept as pure functions over `number[]` timestamps rather than over
 * chart objects so the arithmetic can be tested without a canvas: the page's
 * chart tests mock `klinecharts` wholesale, which means they can only ever
 * assert the calls made, never that two charts really lined up.
 */

/** An absolute span of wall-clock time in epoch ms — the one thing every period
 *  agrees on, which is why the window, not the bar index, is what crosses
 *  between charts. `VisibleRange.from`/`.to` are indices into *that chart's*
 *  data list, and a 5-minute chart and a daily chart disagree utterly about
 *  what index 300 means. */
export interface TimeWindow {
  from: number;
  to: number;
}

/** Ascending timestamps of a chart's bars, read from `chart.getDataList()`. */
export function barTimestamps(bars: readonly Pick<KLineData, "timestamp">[]): number[] {
  return bars.map((b) => b.timestamp);
}

/**
 * The window a chart is showing, from its visible-range indices.
 *
 * `null` means "this chart cannot define a window yet" — no bars, or indices
 * that land entirely outside the list. The caller must skip the *whole*
 * propagation, not clamp to the nearest bar: a cell whose fetch has not landed
 * has no opinion to broadcast, and answering with `ts[0]` would teleport the
 * other three to the oldest bar in the dataset.
 *
 * `from`/`to` are clamped because `VisibleRange` legitimately reports indices
 * past the ends while the offset-right gap is on screen (`realFrom`/`realTo`
 * are the unclamped pair, dist 13560).
 *
 * `barSpanMs` extends the right edge to the *end* of the last bar. Pass it when
 * the source's period stamps its bars at their start (see `coarseBarSpanMs`):
 * the daily feed here stamps 2026-09-30 at `00:00Z`, so a window ending on that
 * bar contains none of that day's session, and the minute cells fitted to it
 * cut off mid-morning. Measured live 2026-10-06 on the default grid: the three
 * peers of a daily window ending 09-30T00:00Z landed at 03:30Z, 02:00Z and
 * 01:40Z — three different times of the same day, none of them its close.
 * The extension is capped by the source's own next bar, so a Friday bar cannot
 * reach into Monday and a month cannot reach into the next month.
 */
export function windowOfIndices(
  ts: readonly number[],
  range: { from: number; to: number },
  barSpanMs: number | null = null,
): TimeWindow | null {
  if (ts.length === 0) return null;
  const from = Math.max(0, Math.min(Math.trunc(range.from), ts.length - 1));
  const to = Math.max(0, Math.min(Math.trunc(range.to), ts.length - 1));
  if (from > to) return null;
  const end = barEndOf(ts, to, barSpanMs);
  if (end === undefined) return null;
  return { from: ts[from], to: end };
}

const DAY_MS = 86_400_000;

/**
 * Where the bar at `index` stops covering time: `barSpanMs` past its own stamp,
 * but never past the next bar of the same series.
 *
 * `barSpanMs` is `null` for a period whose bars are already stamped at their
 * close, which is the whole of the minute family here — extending one would
 * claim minutes that have not happened yet.
 */
export function barEndOf(
  ts: readonly number[],
  index: number,
  barSpanMs: number | null,
): number | undefined {
  const at = ts[index];
  if (at === undefined) return undefined;
  if (barSpanMs === null || barSpanMs <= 0) return at;
  const next = ts[index + 1];
  return Math.min(at + barSpanMs, next === undefined ? at + barSpanMs : next - 1);
}

/**
 * How far past its own stamp a bar of this period reaches, or `null` when the
 * stamp is already the bar's close.
 *
 * Not a convention the library imposes — it is what these loaders emit. Daily
 * bars arrive as naive midnights treated as UTC, while every minute bar is
 * stamped at the end of its span (the hourly cells of a session read 10:30,
 * 11:30, 14:00, 15:00 Beijing). So the coarse periods need the extension and
 * the fine ones must not get it, or a five-minute window would claim an hour
 * that has not happened yet.
 */
export function coarseBarSpanMs(period: Period | null | undefined): number | null {
  if (!period) return null;
  switch (period.type) {
    case "day":
      return period.span * DAY_MS;
    case "week":
      return period.span * 7 * DAY_MS;
    case "month":
      return period.span * 31 * DAY_MS;
    default:
      return null;
  }
}

/** First index whose timestamp is `>= target` (lower bound). */
function lowerBound(ts: readonly number[], target: number): number {
  let lo = 0;
  let hi = ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ts[mid] < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** How many of `ts` fall inside `win`, inclusive at both ends. */
export function countWithin(ts: readonly number[], win: TimeWindow): number {
  if (ts.length === 0 || win.to < win.from) return 0;
  return Math.max(0, lowerBound(ts, win.to + 1) - lowerBound(ts, win.from));
}

/**
 * What to hand a peer chart so it shows the same window.
 *
 * Three calls, and the order is load-bearing for the same reason `分时` fits
 * work: `setOffsetRightDistance` converts the pixels it receives into a bar
 * count using whatever spacing is current (dist 13694), and `setBarSpace` never
 * recomputes it (dist 13666-13681) — offsetting before zooming skews the gap by
 * the ratio of the two spacings.
 *
 * `null` when the peer holds no bar inside the window. That happens for real:
 * ask for 1-minute bars over a window that only daily data covers and the
 * intersection can be empty, and a five-minute chart of a symbol with 200 bars
 * of history cannot follow a daily chart scrolled back ten years. Zooming to
 * "zero bars in window" would read as a blank pane, so the peer keeps its own
 * view and only the panes that *can* align do.
 */
export interface RangePlan {
  barSpace: number;
  offsetRight: number;
  /** One of *this peer's own* bar stamps: the last one inside the window. */
  anchor: number;
}

export function rangePlan(
  ts: readonly number[],
  contentWidth: number,
  win: TimeWindow,
): RangePlan | null {
  const barCount = countWithin(ts, win);
  if (barCount === 0) return null;
  const barSpace = fitBarSpace(contentWidth, barCount);
  if (barSpace === null) return null; // detached host / jsdom: leave the zoom alone
  return {
    barSpace,
    offsetRight: fitOffsetRight(contentWidth, barSpace, barCount),
    // The peer's last bar inside the window, not `win.to`. `scrollToTimestamp`
    // resolves through `binarySearchNearest` (dist 15640), so an anchor that is
    // not a bar of its own lands on whichever side is *closer* — and a window
    // extended to the end of a coarse bar (see `windowOfIndices`) always ends
    // between two. Handing it the instant instead of a bar would pull a peer a
    // full session past the source on a Friday, or leave it a session short.
    anchor: ts[lowerBound(ts, win.to + 1) - 1],
  };
}

/**
 * The payload for a peer's crosshair.
 *
 * A timestamp cannot be sent. `StoreImp.setCrosshair` derives the bar from
 * `cr.x` alone (`coordinateToDataIndex(cr.x)`) and, when `x` is not a number,
 * falls through to `dataList.length - 1` — so handing it `{ timestamp }` snaps
 * the peer's cursor to its newest bar instead of moving it to the source's.
 * The caller therefore converts twice: the source's own event x back to an
 * instant (`convertFromPixel`), then that instant forward to each peer's pixel
 * (`convertToPixel`).
 *
 * `null` when that conversion produced nothing, which it does for a peer with
 * no data.
 */
export interface CrosshairPayload {
  x: number;
  paneId: string;
}

export function crosshairPayload(x: number | undefined, paneId: string): CrosshairPayload | null {
  if (typeof x !== "number" || !Number.isFinite(x)) return null;
  return { x, paneId };
}

/**
 * The instruction that *removes* a peer's cursor.
 *
 * An empty payload cannot. `ChartImp.executeAction` fills in a missing `paneId`
 * with the candle pane (dist 15742), and `setCrosshair` then resolves the bar
 * from a missing `x` as `dataList.length - 1` — so `{}` snaps the peer to its
 * newest bar instead of clearing it. Only a nullish payload gets past the
 * `isValid` gate at 15740 and reaches `setCrosshair(null)`, which is exactly how
 * the library clears its *own* cursor on mouseleave (dist 2519) — an event it
 * never announces, since the notify at 14092 requires a `paneId` the cleared
 * crosshair no longer has. The caller therefore watches the element and sends
 * this on its behalf. With no `paneId` left on the store `CrosshairLineView`
 * draws nothing (dist 7868).
 *
 * The declared parameter type is `Crosshair`, which every field optional — the
 * runtime contract is the one that matters here, hence the cast lives at the
 * single place it is used rather than being repeated by each caller.
 */
export const CLEAR_CROSSHAIR = null as unknown as Crosshair;

/**
 * Re-entrancy gate.
 *
 * The crosshair needs none — `ChartImp.executeAction` calls
 * `setCrosshair(..., { notExecuteAction: true })`, so the library itself stops
 * the echo. The visible range does: `setBarSpace` runs `_adjustVisibleRange()`
 * synchronously (dist 13666) and that fires `onVisibleRangeChange` (13568), and
 * `scrollToTimestamp` with no animation scrolls synchronously too (15626).
 * Without this gate B answers A's event by broadcasting its own, A answers that
 * by broadcasting again, and the pair oscillates.
 *
 * A counter, not a boolean, because one event from A applies to *three* peers
 * and each application re-enters the handler; the outermost `run` owns the
 * reset. A throwing peer must not leave the gate latched either, hence the
 * `finally`.
 */
export interface ApplyGate {
  isApplying: () => boolean;
  /** Run `fn` with the gate closed, dropping events the application itself causes. */
  run: (fn: () => void) => void;
}

export function createApplyGate(): ApplyGate {
  let depth = 0;
  return {
    isApplying: () => depth > 0,
    run: (fn) => {
      depth += 1;
      try {
        fn();
      } finally {
        depth -= 1;
      }
    },
  };
}
