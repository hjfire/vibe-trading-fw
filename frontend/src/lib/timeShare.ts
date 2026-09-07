import { registerIndicator } from "klinecharts";
import type { KLineData } from "klinecharts";
import type { IntervalKey } from "./marketApi";

/**
 * 分时 view (local custom ㉖): one trading day drawn as a line, not as candles.
 *
 * A 分时 chart is not a different data source — it is the *same* 1-minute bars
 * with three things changed: only the newest session is shown, the candles
 * become a line, and the y-reference is yesterday's close instead of the
 * previous bar. All three live here as plain functions so the chart page stays
 * a wiring file and the arithmetic stays testable without a DOM.
 *
 * The session slice happens on the server (`/market/kline?session=latest`), not
 * here, and that is a deliberate split rather than laziness: the minute sources
 * stamp their bars with the *exchange's* wall clock (see `_MINUTE_WALL_CLOCK_ZONE`
 * in market_routes.py), so grouping needs that same table. Copying it into the
 * browser would put a second copy of one rule in the codebase to drift — the
 * exact failure documented in 项目档案.md entry 46 — and a viewer-side fallback
 * of `new Date(ts).getDate()` splits a US session in half for anyone east of
 * Greenwich (09:30-16:10 New York is 21:30-04:10 Beijing).
 */

/** Which minute bar the 分时 line is built from. 1m is the broker convention. */
export const TIME_SHARE_INTERVAL: IntervalKey = "1m";

/**
 * Bars to ask for when entering 分时 mode.
 *
 * One session is 390 bars for HK/US (plus the A-share lunch break gap) and 240
 * for the mainland, so this is comfortably more than a day — on purpose. The
 * server walks back from the newest bar to the first bar of the current
 * exchange calendar day, and it needs at least one bar from the *previous* day
 * to report `prev_close`. A count of exactly 390 would therefore leave the
 * change-percentage strip blank every single time.
 */
export const TIME_SHARE_COUNT = 800;

/** Overlay name of the 均价 line; also the key `createIndicator` takes. */
export const AVG_PRICE_NAME = "AVG_PRICE";

/** One row of the 均价 overlay. `avg` is in price units, so `series: "price"`. */
export interface AvgPriceRow {
  avg?: number;
}

/**
 * Running average price of the session, bar by bar.
 *
 * `turnover / volume` is what brokers print, and it is what a tick feed gives
 * you. This route's bars carry no turnover — `_bars_from_frame` emits only
 * `timestamp/open/high/low/close/volume` — so the best available estimate is
 * `Σ(close × volume) / Σ(volume)`, a volume-weighted mean of the closes. It is
 * an approximation and it must be named 均价 rather than claimed as the exact
 * VWAP the exchange itself publishes.
 *
 * Two properties the caller relies on:
 *
 * - The sum starts at the *first bar of the list*, which is only correct
 *   because `session=latest` guarantees the list is exactly one session. Feed
 *   this a multi-day list and every point after day one is quietly wrong.
 * - When volume has not arrived yet (pre-open bars, or a source that fills
 *   `volume` with 0) the running VWAP would pin `avg` to 0 and drag the price
 *   axis down with it. Zero-volume prefixes therefore fall back to the plain
 *   mean of the closes so far, which keeps the two lines in the same units.
 */
export function averagePriceSeries(bars: readonly KLineData[]): AvgPriceRow[] {
  let priceVolume = 0;
  let volume = 0;
  let sumClose = 0;
  let priced = 0;
  return bars.map((bar) => {
    const close = Number(bar?.close);
    if (!Number.isFinite(close)) return {};
    const raw = Number(bar?.volume);
    const vol = Number.isFinite(raw) && raw > 0 ? raw : 0;
    priceVolume += close * vol;
    volume += vol;
    sumClose += close;
    priced += 1;
    return { avg: volume > 0 ? priceVolume / volume : sumClose / priced };
  });
}

/**
 * Fractional change of `last` against yesterday's close, or `null`.
 *
 * `null` is the honest answer when the server had no previous session inside the
 * window it fetched (holiday-straddling counts, a brand-new listing, or a
 * source that only ever returns one day). Callers must not turn that into
 * `0`: a chart that reads "+0.00%" on a day that opened +5% is worse than one
 * that says it does not know, because it looks like a working number.
 */
export function changeRatio(
  last: number | undefined | null,
  prevClose: number | undefined | null,
): number | null {
  if (typeof last !== "number" || !Number.isFinite(last)) return null;
  if (typeof prevClose !== "number" || !Number.isFinite(prevClose) || prevClose === 0) return null;
  return (last - prevClose) / prevClose;
}

/** Render a `changeRatio` for the status strip; `null` says so out loud. */
export function formatChangePct(ratio: number | null | undefined): string {
  if (typeof ratio !== "number" || !Number.isFinite(ratio)) return "昨收未知";
  const pct = ratio * 100;
  const sign = pct > 0 ? "+" : pct < 0 ? "-" : "";
  return `${sign}${Math.abs(pct).toFixed(2)}%`;
}

/** Up / down / flat against yesterday's close, in A-share color convention. */
export function changeTone(ratio: number | null | undefined): "up" | "down" | "flat" {
  if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio === 0) return "flat";
  return ratio > 0 ? "up" : "down";
}

/** What the server said about the session on screen, as the chart keeps it. */
export interface SessionInfo {
  /** ISO day of the newest bar, on the exchange's calendar; "" if unknown. */
  date: string;
  prevClose: number | null;
  last: number | null;
}

/**
 * The 分时 status-strip badge.
 *
 * Out of the JSX so the three fallbacks are testable without a chart: no answer
 * yet, an answer with no previous close, and a normal one. The middle case is
 * the one worth arguing about — `formatChangePct` already refuses to invent a
 * 0%, so the percentage slot is *omitted* rather than printed as "昨收未知" a
 * second time, and the tone stays neutral to match. A grey number and a red
 * word saying the same thing would read as a formatting bug.
 */
export function timeShareBadge(
  info: SessionInfo | null,
): { text: string; tone: "up" | "down" | "flat" } {
  if (!info) return { text: "分时", tone: "flat" };
  const ratio = changeRatio(info.last, info.prevClose);
  const bits = [`分时 ${info.date || "当日"}`];
  bits.push(info.prevClose === null ? "昨收未知" : `昨收 ${info.prevClose.toFixed(2)}`);
  if (ratio !== null) bits.push(formatChangePct(ratio));
  return { text: bits.join(" · "), tone: changeTone(ratio) };
}

let indicatorRegistered = false;

/**
 * Register the 均价 overlay once per page load.
 *
 * `registerIndicator` rewrites a global table, so calling it on every toggle
 * would re-register while charts are alive. The guard is module state, which is
 * also what makes it safe to call from the click handler and from the init
 * effect without either one having to know if the other already did.
 *
 * `figures[].type` is required in practice, not by the types: KLineChart's
 * `prepareIndicatorFigures()` keeps a figure only when `isValid(figure.type)`,
 * so a figure without one disappears from the line *and* the legend while the
 * formula still computes — the same trap `indicatorLang.ts` documents.
 */
export function ensureTimeShareIndicator(): void {
  if (indicatorRegistered) return;
  indicatorRegistered = true;
  registerIndicator({
    name: AVG_PRICE_NAME,
    shortName: "均价",
    precision: 2,
    series: "price",
    figures: [{ key: "avg", title: "均价: ", type: "line" as const }],
    calc: (dataList: KLineData[]) => averagePriceSeries(dataList),
  });
}
