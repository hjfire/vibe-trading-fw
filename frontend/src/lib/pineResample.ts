/**
 * Multi-timeframe (MTF) primitives for the Pine compatibility layer.
 *
 * Two independent, dependency-free jobs live here, both keyed off bar
 * timestamps so the interpreter no longer has to pretend the chart is daily:
 *
 *   1. `inferTimeframeMs` / `periodStringFromMs` — recover the chart's real
 *      base period from its own data, feeding the `timeframe.*` builtins.
 *   2. `resampleUp` — roll finer chart bars into coarser ones so
 *      `request.security(sym, tf, expr)` can evaluate `expr` over a
 *      higher-timeframe series.
 *
 * The aggregation rules follow the two mature open-source references we are
 * matching: backtrader's `Resampler` (OHLCV merge: open=first / high=max /
 * low=min / close=last / volume=sum) and QuantConnect Lean's consolidators
 * (buckets close on calendar edges, so we floor each bar's timestamp onto the
 * target period). TradingView aligns HTF buckets to *session* boundaries
 * rather than a UTC epoch floor; that difference is a documented, accepted
 * approximation here (see `resampleUp`), not a silent one.
 */

import type { KLineData } from "klinecharts";
import type { PineBars } from "./pineTypes";

export const SEC_MS = 1000;
export const MIN_MS = 60_000;
export const HOUR_MS = 3_600_000;
export const DAY_MS = 86_400_000;
export const WEEK_MS = 604_800_000;

/**
 * The chart's base period in milliseconds: the *median* of consecutive
 * positive timestamp deltas. Median (not mean) so an irregular gap — a
 * weekend hole, a missing session, a duplicate timestamp — cannot drag the
 * estimate off the true bar spacing. Falls back to daily when there are too
 * few bars or no positive deltas to work with (a single-bar or flat-timestamp
 * feed), which preserves the pre-MTF behaviour for degenerate inputs.
 */
export function inferTimeframeMs(bars: PineBars): number {
  const t = bars.time;
  const deltas: number[] = [];
  for (let i = 1; i < t.length; i++) {
    const d = t[i] - t[i - 1];
    if (d > 0) deltas.push(d);
  }
  if (deltas.length === 0) return DAY_MS;
  deltas.sort((a, b) => a - b);
  const mid = deltas.length >> 1;
  const median =
    deltas.length % 2 ? deltas[mid] : (deltas[mid - 1] + deltas[mid]) / 2;
  return Math.max(SEC_MS, Math.round(median));
}

/**
 * A Pine-style `timeframe.period` string for a given period, chosen so
 * `timeframe.in_seconds(period)` round-trips: intraday periods are expressed
 * in whole minutes (TV writes a 1-hour chart as "60"), seconds get an `S`
 * suffix, and calendar periods collapse to `D` / `W` / `M` counts. Monthly is
 * approximated as 30-day blocks — there is no way to name a month from a
 * millisecond count alone, and no test depends on the exact label.
 */
export function periodStringFromMs(ms: number): string {
  if (ms >= DAY_MS) {
    if (ms >= 30 * DAY_MS) {
      const k = Math.round(ms / (30 * DAY_MS));
      return k === 1 ? "M" : `${k}M`;
    }
    if (ms >= WEEK_MS) {
      const k = Math.round(ms / WEEK_MS);
      return k === 1 ? "W" : `${k}W`;
    }
    const k = Math.round(ms / DAY_MS);
    return k === 1 ? "D" : `${k}D`;
  }
  if (ms >= MIN_MS) {
    const k = Math.round(ms / MIN_MS);
    return `${k}`; // minutes, no suffix (TV convention)
  }
  return `${Math.round(ms / SEC_MS)}S`;
}

/**
 * Parse a TradingView timeframe string into milliseconds. Used by
 * `request.security` to size its higher-timeframe buckets. Kept separate from
 * the public `timeframe.in_seconds` builtin (whose bare-number-means-days
 * legacy parsing several existing tests rely on) precisely so this one can be
 * correct: bare digits are *minutes*, `S`/`H`/`D`/`W`/`M` are the suffixes TV
 * uses, and a bare `M` / `1M` is monthly (approximated at 30 days).
 * Returns NaN for anything unrecognised so callers can fall back honestly.
 */
export function tfToMs(tf: string): number {
  const s = (tf ?? "").trim().toUpperCase();
  const num = /^(\d*)([A-Z]*)$/.exec(s);
  if (!num || (!num[1] && !num[2])) return NaN;
  const k = num[1] ? Number(num[1]) : 1; // "D" == "1D"
  if (!(k > 0)) return NaN;
  switch (num[2]) {
    case "":
      return k * MIN_MS; // bare number = minutes
    case "S":
      return k * SEC_MS;
    case "H":
      return k * HOUR_MS;
    case "D":
      return k * DAY_MS;
    case "W":
      return k * WEEK_MS;
    case "M":
      return k * 30 * DAY_MS; // monthly (approximation)
    default:
      return NaN;
  }
}

/** Result of rolling chart bars up to a higher timeframe. */
export interface Resampled {
  /** The aggregated higher-timeframe series. */
  htf: PineBars;
  /** For each chart bar, the index of the HTF bucket it fell into. */
  chartToHtf: Int32Array;
}

/**
 * Roll the chart's bars up into `targetMs` buckets. Returns `null` when the
 * request is not actually a rollup — `targetMs` must be strictly larger than
 * the inferred chart period and there must be bars to work with; equal or
 * finer timeframes are the same-timeframe passthrough / lower-timeframe case,
 * handled elsewhere.
 *
 * Bucket membership is decided by `floor(timestamp / targetMs)`, so buckets
 * align to target-period edges measured from the UTC epoch. For intraday
 * periods (minutes/hours) that is exactly TV's boundary; for daily/weekly it
 * can be offset by the session timezone, which is the accepted approximation
 * noted in this module's header.
 */
export function resampleUp(bars: PineBars, targetMs: number): Resampled | null {
  const chartMs = inferTimeframeMs(bars);
  if (!(targetMs > chartMs) || bars.list.length === 0) return null;

  const list: KLineData[] = [];
  const open: number[] = [];
  const high: number[] = [];
  const low: number[] = [];
  const close: number[] = [];
  const volume: number[] = [];
  const time: number[] = [];
  const chartToHtf = new Int32Array(bars.list.length);

  let curBucket = NaN;
  for (let i = 0; i < bars.list.length; i++) {
    const bucket = Math.floor(bars.time[i] / targetMs);
    if (bucket !== curBucket) {
      curBucket = bucket;
      const bi = list.length;
      // Clone the source bar so mutating the HTF aggregate never writes back
      // into the chart's own KLineData objects.
      list.push({ ...bars.list[i], timestamp: bucket * targetMs });
      open.push(bars.open[i]);
      high.push(bars.high[i]);
      low.push(bars.low[i]);
      close.push(bars.close[i]);
      volume.push(bars.volume[i]);
      time.push(bucket * targetMs);
      chartToHtf[i] = bi;
    } else {
      const j = list.length - 1;
      // backtrader OHLCV merge: high/low widen, close/volume take the running
      // last; open stays at the bucket's first bar.
      if (bars.high[i] > high[j]) high[j] = bars.high[i];
      if (bars.low[i] < low[j]) low[j] = bars.low[i];
      close[j] = bars.close[i];
      volume[j] += bars.volume[i];
      const agg = list[j];
      agg.high = high[j];
      agg.low = low[j];
      agg.close = close[j];
      agg.volume = volume[j];
      chartToHtf[i] = j;
    }
  }

  return {
    htf: { list, open, high, low, close, volume, time },
    chartToHtf,
  };
}
