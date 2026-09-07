import { authHeaders } from "@/lib/apiAuth";
import type { KLineData, Period } from "klinecharts";

/** Thin client for the /market/kline route added in Phase-A. Kept in its own
 *  module (not the upstream `api.ts`) so daily upstream syncs never conflict. */

export type IntervalKey = "1m" | "5m" | "15m" | "30m" | "60m" | "1D";

export const INTERVALS: { label: string; key: IntervalKey }[] = [
  { label: "1分", key: "1m" },
  { label: "5分", key: "5m" },
  { label: "15分", key: "15m" },
  { label: "30分", key: "30m" },
  { label: "60分", key: "60m" },
  { label: "日线", key: "1D" },
];

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
  if (period.type === "day" || period.type === "week" || period.type === "month") {
    return "1D";
  }
  const span = period.span;
  const map: Record<number, IntervalKey> = { 1: "1m", 5: "5m", 15: "15m", 30: "30m", 60: "60m" };
  return map[span] ?? "1D";
}

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
  q.set("interval", params.interval);
  q.set("count", String(params.count ?? 500));
  q.set("adjust", params.adjust ?? "qfq");
  if (params.before) q.set("before", String(params.before));
  if (params.session) q.set("session", params.session);
  const res = await fetch(`/market/kline?${q.toString()}`, {
    headers: authHeaders(),
    signal: params.signal,
  });
  const body = (await res.json().catch(() => ({}))) as Partial<KlineResponse> & { detail?: string };
  if (!res.ok) {
    throw new Error(body.error || body.detail || `HTTP ${res.status}`);
  }
  return {
    status: body.status ?? "ok",
    symbol: body.symbol ?? params.symbol,
    interval: body.interval ?? params.interval,
    source: body.source ?? "",
    bars: Array.isArray(body.bars) ? body.bars : [],
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
