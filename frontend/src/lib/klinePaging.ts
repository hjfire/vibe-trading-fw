import type { DataLoadType, KLineData } from "klinecharts";

/**
 * Paging contract for KLineChart v10's `DataLoader` (local custom ⑬).
 *
 * The library's two direction names are the opposite of the plain-English
 * intuition, and reading them literally is what made the main chart snap back
 * under the mouse. Straight from `StoreImp` in
 * `klinecharts/dist/index.esm.js`:
 *
 * | call | `params.timestamp` | what `_addData` does with the answer |
 * | --- | --- | --- |
 * | `_processDataLoad("forward")` (13635) | `dataList[0].timestamp` — the **oldest** bar | `data.concat(dataList)` → **prepends**, view untouched (13473) |
 * | `_processDataLoad("backward")` (13631) | `dataList.at(-1).timestamp` — the **newest** bar | `dataList.concat(data)` → **appends**, and `_startLastBarRightSideDiffBarCount -= data.length` (13464-13468) → **moves the view** |
 *
 * So `forward` = fetch **older** bars for the left edge, `backward` = fetch
 * **newer** bars for the right edge. The triggers (13598-13603) are
 * `from === 0 && more.forward` and `to === totalBarCount && more.backward`, and
 * a freshly opened chart is exactly at the right edge — so a `backward` answer
 * that is really *older* data (which is what the first version of this page
 * returned) hands the library a duplicate block, it shifts the view by that
 * block's length, `more.backward` is still true, and the same request fires
 * again: the "拖一下就跳回原位、而且停不下来" loop, 500 duplicate bars per
 * round trip. `shapeResponse` refuses to hand back anything the chart already
 * has, which turns that class of bug into an empty answer plus a stop flag.
 */

/**
 * The `type` values a `getBars` call can arrive with. `"update"` is part of the
 * library's union but never reaches `getBars` (it is the label `_addData` uses
 * for bars pushed through `subscribeBar`), so it is handled like `init`.
 */
export type LoadDirection = DataLoadType;

/** Timestamp bounds of the bars the chart currently holds (epoch ms). */
export interface DataBounds {
  oldest: number | null;
  newest: number | null;
}

/** Bounds of an ascending bar list, which is what KLineChart stores. */
export function boundsOf(bars: readonly { timestamp: number }[]): DataBounds {
  return bars.length
    ? { oldest: bars[0].timestamp, newest: bars[bars.length - 1].timestamp }
    : { oldest: null, newest: null };
}

/**
 * The `before` cap to send to `/market/kline` (epoch ms, strictly older than).
 * `null` means "the newest page", which is what `init` wants and also what we
 * ask for when the chart requests newer bars — the backend has no `after`
 * parameter, so the fresh ones are filtered out client side.
 */
export function pagingBefore(
  type: LoadDirection,
  timestamp: number | null,
  bounds: DataBounds,
): number | null {
  if (type === "forward") return timestamp ?? bounds.oldest ?? null;
  return null;
}

export interface PagedResponse {
  /** Bars safe to hand to `callback` for this direction. */
  bars: KLineData[];
  /** `more` flags; the library reads `forward` for a forward answer and
   * `backward` for a backward one and ignores the other (13465/13474). */
  more: { forward: boolean; backward: boolean };
}

/**
 * Filter a fetched page down to bars the chart does not already have, and
 * derive the "there is more in this direction" flag from what actually
 * survived. A page that overlaps what is loaded is not a hard error — it just
 * yields nothing new, and the flag then stops the library from asking again.
 */
export function shapeResponse(
  type: LoadDirection,
  bars: readonly KLineData[],
  bounds: DataBounds,
  pageSize: number,
): PagedResponse {
  if (type === "backward") {
    // Narrow before the closure: TypeScript will not re-check `bounds.newest`
    // from inside the filter callback.
    const newest = bounds.newest;
    const fresh = newest === null ? [...bars] : bars.filter((b) => b.timestamp > newest);
    return { bars: fresh, more: { forward: false, backward: fresh.length >= pageSize } };
  }
  // `init` (and the unreachable `update`) clears or replaces the list, so only
  // a forward answer has to be trimmed.
  const oldest = bounds.oldest;
  const fresh =
    type === "forward" && oldest !== null
      ? bars.filter((b) => b.timestamp < oldest)
      : [...bars];
  return { bars: fresh, more: { forward: fresh.length >= pageSize, backward: false } };
}
