import { authHeaders } from "@/lib/apiAuth";
import type { KLineData, Period, PeriodType } from "klinecharts";

/** Thin client for the chart's bar feed. Kept in its own module (not the
 *  upstream `api.ts`) so daily upstream syncs never conflict.
 *
 *  It speaks the TradingView **UDF** protocol (`/api/udf/history`), which is why
 *  the translation layer below exists: the page thinks in KLineChart's units
 *  (epoch **milliseconds**, `interval=1m`, row-wise bars) and the protocol
 *  thinks in its own (epoch **seconds**, `resolution=1`, column-wise arrays).
 *  Both ends of that difference have bitten charts before — a seconds/ms mixup
 *  puts the axis at 1970 — so the conversion is done in this one function and
 *  nowhere else in the codebase. `agent/src/api/udf_routes.py` serves the same
 *  bars as the old `/market/kline` route (it calls `_kline_sync` directly);
 *  only the wire format changed, which is what makes the switch safe.
 */

export type IntervalKey = "1m" | "5m" | "15m" | "30m" | "60m" | "1D" | "1W" | "1M";

export const INTERVALS: { label: string; key: IntervalKey }[] = [
  { label: "1分", key: "1m" },
  { label: "5分", key: "5m" },
  { label: "15分", key: "15m" },
  { label: "30分", key: "30m" },
  { label: "60分", key: "60m" },
  { label: "日线", key: "1D" },
  { label: "周线", key: "1W" },
  { label: "月线", key: "1M" },
];

/**
 * Daily-and-coarser periods, and what KLineChart calls each of them.
 *
 * One table for both directions of the translation on purpose (local custom ㉜):
 * the key -> period mapping sat in the chart page and the period -> key mapping
 * in this file, which is precisely how a third coarse button could end up
 * drawing weekly candles while asking the backend for daily bars. 项目档案.md
 * entry 46 is the same story told about one rule spelled four times.
 *
 * The server builds `1W`/`1M` by folding its own daily bars (see
 * `_AGG_DAILY_PER_BAR` in market_routes.py), so nothing here depends on a source
 * that speaks "weekly" — and nothing does, which is why coverage is every symbol
 * the daily button covers.
 */
const CALENDAR_PERIODS: { key: IntervalKey; type: PeriodType }[] = [
  { key: "1D", type: "day" },
  { key: "1W", type: "week" },
  { key: "1M", type: "month" },
];

/** Daily-or-coarser: these need no intraday source, so every symbol can show them. */
export function isCalendarInterval(key: IntervalKey): boolean {
  return CALENDAR_PERIODS.some((c) => c.key === key);
}

/** The period object `chart.setPeriod` wants for a toolbar key. */
export function intervalToPeriod(key: IntervalKey): Period {
  const calendar = CALENDAR_PERIODS.find((c) => c.key === key);
  if (calendar) return { type: calendar.type, span: 1 };
  return { type: "minute", span: parseInt(key, 10) };
}

export interface KlineResponse {
  status: string;
  symbol: string;
  interval: string;
  source: string;
  bars: KLineData[];
  /** ISO day of the newest bar, exchange calendar. Only with `session=latest`. */
  session_date?: string;
  /** Close of the session before the one returned, or null when the fetch
   *  window did not reach back that far. Only with `session=latest`. */
  prev_close?: number | null;
  error?: string;
}

/** UDF spellings of this page's interval keys (`/config.supported_resolutions`).
 *  The protocol names intraday bars by bare minutes and calendar bars by a unit
 *  letter, so the table is the whole translation — no string munging, because
 *  munging is how `1M` (monthly) becomes `1m` (one minute). */
export const RESOLUTION_BY_INTERVAL: Record<IntervalKey, string> = {
  "1m": "1",
  "5m": "5",
  "15m": "15",
  "30m": "30",
  "60m": "60",
  "1D": "D",
  "1W": "W",
  "1M": "M",
};

/** The columnar part of a `/history` answer, protocol-shaped. */
export interface UdfHistoryColumns {
  /** Bar times, unix **seconds** — the protocol's unit, not the page's. */
  t?: number[];
  o?: number[];
  h?: number[];
  l?: number[];
  c?: number[];
  v?: number[];
}

/** One `/api/udf/history` answer, in the protocol's own shape. */
export interface UdfHistoryResponse extends UdfHistoryColumns {
  s: "ok" | "error" | "no_data" | string;
  errmsg?: string;
  /** Only with `s: "no_data"`: seconds of the newest bar further back. */
  nextTime?: number;
  session_date?: string;
  prev_close?: number | null;
  source?: string;
}

/** Columnar UDF arrays -> KLineChart's row-wise bars, seconds -> milliseconds. */
export function columnsToBars(data: UdfHistoryColumns): KLineData[] {
  const times = data.t ?? [];
  const at = (column?: number[]) => column ?? [];
  return times.map((sec, i) => ({
    timestamp: sec * 1000,
    open: at(data.o)[i] ?? 0,
    high: at(data.h)[i] ?? 0,
    low: at(data.l)[i] ?? 0,
    close: at(data.c)[i] ?? 0,
    volume: at(data.v)[i] ?? 0,
  }));
}

export interface QuoteRow {
  symbol: string;
  ok: boolean;
  last?: number;
  change_pct?: number;
  timestamp?: number;
  error?: string;
}

/** Map a KLineChart Period back to the backend interval string. */
export function periodToInterval(period: Period): IntervalKey {
  const calendar = CALENDAR_PERIODS.find((c) => c.type === period.type);
  if (calendar) return calendar.key;
  if (period.type !== "minute") {
    // `second` / `hour` / `year` have no button on this page. Degrade to the one
    // period every instrument can serve rather than reading `span: 1` off a
    // yearly period and fetching 1-minute bars for it.
    return "1D";
  }
  const map: Record<number, IntervalKey> = { 1: "1m", 5: "5m", 15: "15m", 30: "30m", 60: "60m" };
  return map[period.span] ?? "1D";
}

/**
 * Fetch one page of bars over the UDF protocol.
 *
 * The signature is the old `/market/kline` one on purpose: the chart page, the
 * screener and four page tests all speak `interval` / `before` / `count` /
 * `bars`, and the only thing that changed is the wire. `before` (epoch ms,
 * strictly older) becomes `to` (epoch s, not inclusive); `count` becomes
 * `countback`, which the protocol defines as beating `from` — so paging stays a
 * single unambiguous request shape instead of a window the server might read
 * differently.
 *
 * `no_data` is not an error and not an empty page: it is "nothing in this
 * window, the nearest bar further back is at `nextTime`". Callers already treat
 * an empty `bars` as "stop paging", so it collapses here rather than inventing
 * a fourth status for one caller to re-expand.
 */
export async function fetchKline(params: {
  symbol: string;
  interval: IntervalKey;
  count?: number;
  adjust?: "none" | "qfq" | "hfq";
  before?: number | null;
  /** "latest" narrows a minute interval to its newest trading session and
   *  answers `session_date` + `prev_close` (the 分时 view). */
  session?: "" | "latest";
  signal?: AbortSignal;
}): Promise<KlineResponse> {
  const q = new URLSearchParams();
  q.set("symbol", params.symbol);
  q.set("resolution", RESOLUTION_BY_INTERVAL[params.interval]);
  q.set("countback", String(params.count ?? 500));
  q.set("adjust", params.adjust ?? "qfq");
  if (params.before) q.set("to", String(Math.floor(params.before / 1000)));
  if (params.session) q.set("session", params.session);
  const res = await fetch(`/api/udf/history?${q.toString()}`, {
    headers: authHeaders(),
    signal: params.signal,
  });
  const body = (await res.json().catch(() => ({}))) as Partial<UdfHistoryResponse> & { detail?: string };
  if (!res.ok) {
    throw new Error(body.errmsg || body.detail || `HTTP ${res.status}`);
  }
  if (body.s === "error") {
    // The protocol answers a broken request with HTTP 200 and `s: "error"`, so
    // the status code cannot be the only failure check here — and the message
    // is the data route's own ("sina minute bars have no path for 0700.HK…"),
    // which is the difference between the user restarting OpenD and hunting a
    // network problem that does not exist.
    throw new Error(body.errmsg || "history failed");
  }
  const bars = body.s === "ok" ? columnsToBars(body) : [];
  return {
    status: body.s ?? "ok",
    symbol: params.symbol,
    interval: params.interval,
    source: body.source ?? "",
    bars,
    // Both keys are only ever present on a `session=latest` answer, and
    // `prev_close: null` is that case's honest "I could not see yesterday" —
    // normalising a missing number to 0 here would print +0.00%.
    session_date: typeof body.session_date === "string" && body.session_date ? body.session_date : undefined,
    prev_close: typeof body.prev_close === "number" && Number.isFinite(body.prev_close) ? body.prev_close : null,
  };
}

/** Batch quotes for the watchlist (GET /market/quote). Per-symbol failures
 *  arrive as in-row ok=false entries, never as a thrown error. */
export async function fetchQuotes(symbols: string[]): Promise<QuoteRow[]> {
  const q = new URLSearchParams();
  q.set("symbols", symbols.join(","));
  const res = await fetch(`/market/quote?${q.toString()}`, { headers: authHeaders() });
  const body = (await res.json().catch(() => ({}))) as { quotes?: QuoteRow[]; error?: string; detail?: string };
  if (!res.ok) {
    throw new Error(body.error || body.detail || `HTTP ${res.status}`);
  }
  return Array.isArray(body.quotes) ? body.quotes : [];
}
