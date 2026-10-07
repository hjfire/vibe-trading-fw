/**
 * Bar Replay 的游标算术（纯函数）。
 *
 * 回放的设计判据是"图表物理上不存在游标之后的 bar"（见
 * docs/superpowers/specs/2026-10-06-bar-replay-design.md 第三节），所以这里没有一个函数
 * 需要 chart 实例：它们只做一件事——把"已加载的 bar + 一个时间戳"折成"该显示哪一段"。
 *
 * 游标的身份是 timestamp 而不是下标。下标在这张图上会被换周期（自然周月折叠）、改副图
 * 触发的 re-init、退出回放后的 forward 分页 prepend 三件事移动；本仓有过同型事故
 * （副图 paneId 随机漂移），能用稳定身份就不用位置身份。
 */

/** Anything that carries a bar timestamp. `KLineData` and stored drawing points both do. */
export interface Stamped {
  timestamp: number;
}

/**
 * What the DataLoader answers for `more` while a replay owns the chart: both flags dead.
 *
 * `backward: false` is the future-data gate — the library only ever asks for newer bars at
 * `to === totalBarCount && more.backward` (dist 13601). `forward: false` is not about
 * direction, it is about a race: the window here is a *prefix*, so `from === 0` is true
 * whenever the whole prefix fits the viewport, which would fire an automatic request whose
 * in-flight `_loading` flag (dist 13607) silently drops the user's next step. Looking further
 * back is not what replay is for — see spec §6.
 */
export const REPLAY_MORE = { forward: false, backward: false } as const;

/** Where the cursor lands on entry: about a trading year of daily bars back. */
export const DEFAULT_REPLAY_BACK = 250;

/** The speeds the toolbar offers, as ms per bar. A lookup, not a computation. */
const PACE: Record<ReplaySpeed, number> = { "0.5": 2000, "1": 1000, "2": 500, "4": 250 };

export type ReplaySpeed = "0.5" | "1" | "2" | "4";

export function paceMs(speed: ReplaySpeed): number {
  return PACE[speed];
}

/** Index of the last bar at or before `ts`; -1 when every bar is later than the cursor. */
export function indexAtOrBefore(bars: readonly Stamped[], ts: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].timestamp <= ts) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

/** The bar the cursor sits on, or null when the cursor names a time before any bar. */
export function cursorBar<T extends Stamped>(bars: readonly T[], cursorTs: number): T | null {
  const i = indexAtOrBefore(bars, cursorTs);
  return i < 0 ? null : bars[i];
}

/**
 * The bars a replay may show: every bar at or before the cursor. `null` means replay is off
 * and the whole loaded range belongs on screen.
 */
export function replayWindow<T extends Stamped>(bars: readonly T[], cursorTs: number | null): T[] {
  if (cursorTs === null) return [...bars];
  const i = indexAtOrBefore(bars, cursorTs);
  return i < 0 ? [] : bars.slice(0, i + 1);
}

/** Move the cursor by `n` bars (negative = back in time), clamped to the loaded range. */
export function stepCursor(bars: readonly Stamped[], cursorTs: number, n: number): number {
  if (bars.length === 0) return cursorTs;
  const last = bars.length - 1;
  // A cursor that names no bar any more re-lands on the nearest one instead of running off
  // the end — that is what a period switch or a re-entry after paging can leave behind.
  const at = Math.min(Math.max(indexAtOrBefore(bars, cursorTs), 0), last);
  if (n === 0) return bars[at].timestamp;
  const dir = n > 0 ? 1 : -1;
  let i = Math.min(Math.max(at + n, 0), last);
  // `indexAtOrBefore` resolves a duplicated timestamp to its LAST occurrence, so a plain
  // `at + n` can land back on the instant the cursor already holds — and a control that hands
  // back the cursor's own value is a permanent no-op (`applyReplayCursor` skips the repaint).
  // Keep walking the same way until the landing bar names a different instant, but never past
  // an end: at a real end the unchanged answer is the contract, not a stall.
  while (i !== at && bars[i].timestamp === cursorTs) {
    const next = i + dir;
    if (next < 0 || next > last) break;
    i = next;
  }
  return bars[i].timestamp;
}

/** True once the cursor sits on the newest loaded bar: playing has nowhere to go. */
export function isReplayExhausted(bars: readonly Stamped[], cursorTs: number): boolean {
  return bars.length > 0 && cursorTs >= bars[bars.length - 1].timestamp;
}

/** "Start from the right edge of the view": fold a library-visible index into a cursor. */
export function cursorFromView(bars: readonly Stamped[], visibleTo: number): number | null {
  if (bars.length === 0) return null;
  return bars[Math.min(Math.max(Math.trunc(visibleTo), 0), bars.length - 1)].timestamp;
}

/**
 * A drawing is "in the future" when any of its anchors sits after the cursor. Showing one
 * during replay would be a visual lookahead: the whole point of the mode is that the user is
 * standing on `cursorTs`.
 *
 * An anchor carrying a bare `dataIndex` instead of a timestamp has no position in time to
 * compare against, so it never counts as future — same rule `hasCoordinates` uses in
 * `chartDrawings.ts`, applied in the other direction.
 */
export function isFutureDrawing(
  points: readonly ({ timestamp?: number; value?: number } | null | undefined)[],
  cursorTs: number,
): boolean {
  return points.some((p) => typeof p?.timestamp === "number" && p.timestamp > cursorTs);
}

export interface ReplayReadout {
  /** Bars on screen right now. */
  shown: number;
  /** Bars loaded when replay was entered. */
  total: number;
  /** Bars still to be replayed before the newest one. */
  remaining: number;
  /** Cursor index, -1 when the cursor precedes the range. */
  index: number;
}

/** The numbers the toolbar reads out. Kept here so the wording and the math cannot drift. */
export function replayReadout(bars: readonly Stamped[], cursorTs: number): ReplayReadout {
  const index = indexAtOrBefore(bars, cursorTs);
  const shown = index + 1;
  return { shown, total: bars.length, remaining: Math.max(bars.length - shown, 0), index };
}

/**
 * The toolbar's cursor date. Deliberately the browser's own calendar day: the readout and the
 * date box only have to agree with *each other*, and a bar stamped at the exchange's 15:00
 * falls on that same day for a CN-hosted browser either way. This is a coordinate, not i18n
 * copy, so it is built by hand instead of `toLocaleDateString` (which would vary by locale).
 */
export function formatReplayDate(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * The date box's `YYYY-MM-DD` as a cursor: the last bar whose day is at or before it.
 *
 * End of the UTC day, not midnight — A-share daily bars are stamped at the session close
 * (15:00 CST = 07:00 UTC), so that day's own midnight would resolve to the *previous* trading
 * day. See the `ops-market-data-timezone-fallback` note on why stamps are exchange-local.
 */
export function cursorFromDatePick(bars: readonly Stamped[], iso: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
  const dayEnd = Date.parse(`${iso}T23:59:59.999Z`);
  if (Number.isNaN(dayEnd)) return null;
  const i = indexAtOrBefore(bars, dayEnd);
  return i < 0 ? null : bars[i].timestamp;
}
