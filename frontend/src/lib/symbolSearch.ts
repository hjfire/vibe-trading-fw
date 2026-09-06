import { authHeaders } from "@/lib/apiAuth";

/** Client for GET /market/symbols — the local code/name roster behind the
 *  symbol picker. Its own module (like marketApi.ts, not the upstream api.ts)
 *  so daily upstream syncs never conflict over it.
 *
 *  The roster lives server-side and is searched there: it is ~32k instruments,
 *  far too large to ship to the browser per keystroke, and the server answers a
 *  scan of it in ~25 ms from memory. */

export interface SymbolCandidate {
  symbol: string;
  name: string;
  market: string;
  type: string;
}

export interface SymbolSearchResponse {
  status: "ok" | "warming" | "error";
  ready: boolean;
  results: SymbolCandidate[];
  count: number;
  /** True while the server is building the roster for the first time. */
  building?: boolean;
  error?: string;
}

/** Venues the roster can currently serve, for the badge next to a row. */
const MARKET_LABELS: Record<string, string> = {
  SH: "沪",
  SZ: "深",
  BJ: "京",
  HK: "港",
  US: "美",
};

export function marketLabel(market: string): string {
  return MARKET_LABELS[market] ?? market;
}

export function typeLabel(type: string): string {
  const map: Record<string, string> = { equity: "股票", etf: "ETF", index: "指数" };
  return map[type] ?? type;
}

/**
 * Wrap a bare symbol as a candidate, for the empty-input state.
 *
 * The caller usually holds only a symbol string (a watchlist row, the chart's
 * current instrument) and has no display name for it, so `name`/`type` stay
 * empty and the combobox renders whatever it has.
 */
export function candidateFromSymbol(symbol: string): SymbolCandidate {
  const upper = symbol.trim().toUpperCase();
  const tail = upper.includes(".") ? upper.slice(upper.lastIndexOf(".") + 1) : "";
  return { symbol: upper, name: "", market: tail, type: "" };
}

/** The symbol grammar every loader in this project already understands — the
 *  browser-side mirror of the backend's `_is_chartable` in symbol_roster.py,
 *  pinned case by case in __tests__/symbolSearch.test.ts. */
const CHARTABLE_RE = /^(?:\d{6}\.(?:SH|SZ|BJ)|[A-Z][A-Z0-9.&\-]{0,9}\.US|\d{1,5}\.HK)$/;

/**
 * Whether *text* can be routed as it stands, so a picker should not
 * second-guess it.
 *
 * A bare `00700` cannot: it is a Hong Kong code missing its venue, so it only
 * resolves by walking the whole loader fallback chain (measured
 * `_provenance.source = backtest:loader_fallback_chain`) and it is the form the
 * session, the watchlist and an alert rule then go on storing. A `BTC-USDT`
 * can, because crypto and FX pairs use `-`/`_`, are not in the roster at all,
 * and every consumer already parses them. So this answers "is the typed text
 * already an instrument?", which is what decides whether Enter commits it or
 * takes the best suggestion instead.
 */
export function isRoutableSymbol(text: string): boolean {
  const trimmed = text.trim().toUpperCase();
  if (!trimmed) return false;
  return trimmed.includes("-") || trimmed.includes("_") || CHARTABLE_RE.test(trimmed);
}

/**
 * Ask the backend what the user probably means.
 *
 * An unavailable roster is not surfaced as a throw: it returns an empty list
 * with `ready: false`, because the caller is a text input that must keep
 * working when nothing can be suggested.
 */
export async function searchSymbols(
  query: string,
  limit = 10,
  signal?: AbortSignal,
): Promise<SymbolSearchResponse> {
  const q = new URLSearchParams();
  q.set("q", query);
  q.set("limit", String(limit));
  const res = await fetch(`/market/symbols?${q.toString()}`, {
    headers: authHeaders(),
    signal,
  });
  const body = (await res.json().catch(() => ({}))) as Partial<SymbolSearchResponse> & {
    detail?: string;
  };
  if (!res.ok) {
    throw new Error(body.error || body.detail || `HTTP ${res.status}`);
  }
  return {
    status: body.status ?? "ok",
    ready: body.ready ?? true,
    count: body.count ?? 0,
    building: body.building,
    results: Array.isArray(body.results) ? body.results : [],
  };
}

/**
 * Ask the server to re-pull the roster (Beijing list, new listings).
 *
 * Fire-and-forget by contract: the route warms on a background thread and
 * returns as soon as it has handed the job over, so a 17-20 s rebuild never
 * blocks this promise.
 */
export async function refreshSymbolRoster(): Promise<SymbolSearchResponse> {
  const res = await fetch("/market/symbols?refresh=true&limit=1", { headers: authHeaders() });
  return (await res.json()) as SymbolSearchResponse;
}

/**
 * Keep only the newest in-flight search, aborting the one before it.
 *
 * Without this, typing "600519" can land the "600" response after the
 * "600519" one and repaint a stale, wider candidate list on top of the
 * user's more precise input.
 */
export function createSearchSequence(): {
  run: (query: string, limit?: number) => Promise<SymbolSearchResponse | null>;
  cancel: () => void;
} {
  let current: AbortController | null = null;
  return {
    async run(query: string, limit = 10) {
      current?.abort();
      const controller = new AbortController();
      current = controller;
      try {
        const out = await searchSymbols(query, limit, controller.signal);
        // A resolved-but-superseded response must not paint either.
        return controller.signal.aborted ? null : out;
      } catch (e) {
        if ((e as Error).name === "AbortError") return null;
        throw e;
      } finally {
        if (current === controller) current = null;
      }
    },
    cancel() {
      current?.abort();
      current = null;
    },
  };
}
