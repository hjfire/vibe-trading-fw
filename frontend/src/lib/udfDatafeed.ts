/**
 * TradingView **Datafeed API** adapter over this project's UDF endpoints.
 *
 * Read this file's role precisely, because the honest version is narrower than
 * "we replaced the chart":
 *
 * * The renderer shipped on `/pro-chart` is **KLineChart v10** (Apache-2.0), and
 *   it stays. TradingView's Advanced Charts (formerly "Charting Library") is
 *   free to register for but proprietary: it is not on npm, its licence forbids
 *   redistributing it, and nothing in this repository may vendor it in. So the
 *   widget itself cannot be a dependency here.
 * * What *can* be open source is the contract on both sides of it, and that is
 *   what this pair is: the server speaks UDF (`agent/src/api/udf_routes.py`,
 *   mounted at `/api/udf`) and this module implements the client half of the
 *   published `Datafeed` interface. Point a licensed Advanced Charts build at it
 *   — either `new TradingView.widget({ container_id, datafeed: new UdfDatafeed(), ... })`
 *   for a custom feed, or `datafeed_url: "<origin>/api/udf"` to use the library's
 *   own `UDFCompatibleDatafeed` and skip this file entirely — and every candle
 *   it draws is the same FutuOpenD bar the KLineChart page draws, because both
 *   come out of `market_routes._kline_sync`.
 *
 * The interfaces below are declared locally rather than imported from
 * `datafeeds-api.d.ts`: that file ships inside the proprietary download, so
 * importing it would make this module un-buildable here. The shapes follow the
 * published documentation, and the unit conversions are the same ones
 * `marketApi.ts` applies for KLineChart — one rule, one place per direction.
 *
 * Real-time, per the protocol: UDF has no push channel. The library's own
 * adapter re-reads a feed on a timer (`updateFrequency`), so `subscribeBars`
 * polls `/quotes` — one batched FutuOpenD snapshot per tick of the timer — and
 * turns the session's running OHLC into the live bar. That is the standard's
 * "pull/pulse" model, not a private WebSocket protocol we invented.
 */

import { authHeaders } from "@/lib/apiAuth";
import type { UdfHistoryColumns } from "@/lib/marketApi";

/** Everything below `/api/udf` is fixed by the protocol; the prefix is not. */
export const DEFAULT_UDF_BASE = "/api/udf";

/** Bar times and `nextTime` are unix **seconds** in this protocol. */
const SECONDS_CEILING = 1e11;

/** One element of a `/quotes` answer, as the protocol sends it. */
export interface QuoteTile {
  s?: string;
  n?: string;
  v?: Record<string, number | string> | null;
}

/**
 * `onReady` payload minus the fields this adapter forwards verbatim from
 * `/config`. A library that never received `supported_resolutions` draws no
 * resolution buttons at all, so that key is mandatory even on the happy path.
 */
export interface DatafeedConfig {
  supported_resolutions: string[];
  exchanges: { value: string; name: string; desc?: string }[];
  symbolsTypes: { name: string; value: string }[];
}

export interface LibrarySymbolInfo {
  name: string;
  ticker: string;
  description: string;
  type: string;
  exchange: string;
  session: string;
  timezone: string;
  pricescale: number;
  minmov: number;
  volume_precision: number;
  has_intraday: boolean;
  has_daily: boolean;
  supported_resolutions: string[];
}

/** The bar object `onTick` / `onRealtimeCallback` expects: seconds, not ms. */
export interface HistoryBar {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface PeriodParams {
  /** unix seconds of the leftmost bar the chart wants. */
  from: number;
  /** unix seconds of the rightmost bar, not inclusive. */
  to: number;
  /** Bars ending at `to`; wins over `from` when the library sends it. */
  countBack?: number;
  /** True on the first load of a symbol, false on a scroll-back page. */
  initialData?: boolean;
}

export interface UdfDatafeedOptions {
  /** Mount point of the UDF endpoints. */
  baseUrl?: string;
  /** `subscribeBars` poll interval; the protocol has nothing to push. */
  updateFrequencyMs?: number;
}

type Callback = (payload: unknown) => void;

/** How many times one `getBars` call may hop back over an empty window. */
const MAX_EMPTY_WINDOW_HOPS = 3;

/** `GET /config`, kept so `onReady` and the resolution offer share one source. */
async function getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(url, { headers: authHeaders(), signal });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return (await res.json()) as T;
}

function withBase(baseUrl: string, path: string, params: Record<string, string | number | undefined>) {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") q.set(key, String(value));
  }
  const query = q.toString();
  return `${baseUrl}${path}${query ? `?${query}` : ""}`;
}

/**
 * Columnar `/history` arrays into the array of bars the library expects.
 *
 * `time` stays in **seconds**: unlike KLineChart, the TradingView widget wants
 * the protocol's own unit here, and converting to ms is what makes the axis
 * jump to 1970. The column *type* is shared with `marketApi.ts` on purpose — one
 * place describes what `/history` sends, two places only differ in which unit
 * their target library asks for.
 */
export function columnsToBars(response: UdfHistoryColumns): HistoryBar[] {
  const times = response.t ?? [];
  const at = (column?: number[], index = 0): number => column?.[index] ?? 0;
  return times.map((sec, i) => ({
    time: sec,
    open: at(response.o, i),
    high: at(response.h, i),
    low: at(response.l, i),
    close: at(response.c, i),
    volume: at(response.v, i),
  }));
}

/**
 * `/history` answers `nextTime` in seconds; TradingView's own documentation
 * prints a millisecond value in one of its examples and seconds in another, so
 * a feed written from either one can arrive. Normalising on magnitude — not on
 * a flag — is the only reading that works for both, and it cannot misfire until
 * the year 5138.
 */
export function normaliseTime(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return value >= SECONDS_CEILING ? Math.floor(value / 1000) : Math.floor(value);
}

/** One `/quotes` tile into the live bar `subscribeBars` pushes. */
export function quoteToBar(tile: QuoteTile | null | undefined): HistoryBar | null {
  const value = tile?.v;
  if (!value || tile.s !== "ok") return null;
  const time = Number(value.update_time ?? 0);
  const close = Number(value.lp ?? 0);
  if (!time || !Number.isFinite(close) || close <= 0) return null;
  // A session's running OHLC is exactly the forming candle the library wants;
  // `open`/`high`/`low` are absent on a row that came off the daily fallback
  // chain, and inventing them from `lp` would draw a bar that never happened.
  return {
    time,
    open: Number(value.open_price ?? close),
    high: Number(value.high_price ?? close),
    low: Number(value.low_price ?? close),
    close,
    volume: Number(value.volume ?? 0),
  };
}

/**
 * Minimal `Datafeed` implementation for TradingView Advanced Charts.
 *
 * Only the methods a chart actually calls are here (`onReady`, `resolveSymbol`,
 * `getBars`, `subscribeBars`, `unsubscribeBars`, `searchSymbols`,
 * `listExchanges`, `listSymbols`, `getMarks`); the optional rest of the
 * interface (brokers, depth-of-market, studies) stays unimplemented because the
 * feed has no data behind it, and a stub that answers "ok" with nothing is how a
 * widget ends up offering a feature that shows an empty panel.
 */
export class UdfDatafeed {
  private readonly baseUrl: string;
  private readonly updateFrequencyMs: number;
  private readonly polls = new Map<string, ReturnType<typeof setInterval>>();
  private config: DatafeedConfig | null = null;

  constructor(options: UdfDatafeedOptions = {}) {
    this.baseUrl = options.baseUrl ?? DEFAULT_UDF_BASE;
    this.updateFrequencyMs = options.updateFrequencyMs ?? 5000;
  }

  private url(path: string, params: Record<string, string | number | undefined>) {
    return withBase(this.baseUrl, path, params);
  }

  onReady(readyCallback: Callback): void {
    getJson<Record<string, unknown>>(this.url("/config", {}))
      .then((config) => {
        this.config = {
          supported_resolutions: (config.supported_resolutions as string[]) ?? ["D"],
          exchanges: (config.exchanges as DatafeedConfig["exchanges"]) ?? [],
          symbolsTypes: (config.symbolsTypes as DatafeedConfig["symbolsTypes"]) ?? [],
        };
        readyCallback(this.config);
      })
      .catch((error: Error) => {
        // The library reads `error` and shows a banner; throwing here instead
        // would leave the widget spinning without ever saying why.
        readyCallback({ error: `Datafeed config failed: ${error.message}` });
      });
  }

  resolveSymbol(
    symbolName: string,
    onSymbolResolved: (info: LibrarySymbolInfo) => void,
    onResolveError: (message: string) => void,
  ): void {
    getJson<LibrarySymbolInfo>(this.url("/symbols", { symbol: symbolName }))
      .then((info) => {
        // `ticker` has to survive the round trip: the library sends it back on
        // every later /history and /quotes call, and the server's canonical form
        // is what those routes parse.
        onSymbolResolved({ ...info, ticker: info.ticker || info.name });
      })
      .catch((error: Error) => onResolveError(`Cannot resolve symbol ${symbolName}: ${error.message}`));
  }

  /**
   * The library's history call. `onRealtimeCallback` receives the bar array and
   * `onNoDataCallback` is the "there is nothing further back" answer that stops
   * the chart asking again for the same empty window.
   *
   * A `no_data` that carries `nextTime` is neither: it says "this window is
   * empty, the data is further back". This hops the window of its own accord, up
   * to `MAX_EMPTY_WINDOW_HOPS` times, because a chart that stops at the first
   * holiday weekend looks exactly like a feed that has no history. The protocol
   * notes that a feed handling `countback` makes this path rare — which is why
   * the first load above sends it.
   */
  getBars(
    symbolInfo: LibrarySymbolInfo,
    resolution: string,
    periodParams: PeriodParams,
    onRealtimeCallback: (bars: HistoryBar[], meta?: { cacheMaxAge?: number }) => void,
    onNoDataCallback: (message?: string) => void,
  ): void {
    const base: Record<string, string | number | undefined> = {
      symbol: symbolInfo.ticker || symbolInfo.name,
      resolution,
    };
    const first: Record<string, string | number | undefined> =
      periodParams.countBack && periodParams.initialData !== false
        ? // `countback` beats `from` in the protocol, and it is the shape that
          // avoids asking for a range nobody traded. Only on the first load: a
          // scroll-back page must be a window, because the library's `countBack`
          // there is not a page size.
          { ...base, countback: periodParams.countBack }
        : { ...base, from: periodParams.from, to: periodParams.to };

    const span = Math.max(periodParams.to - periodParams.from, 1);
    const walk = (params: Record<string, string | number | undefined>, hops: number) => {
      getJson<Record<string, unknown>>(this.url("/history", params))
        .then((response) => {
          if (response.s === "ok") {
            onRealtimeCallback(columnsToBars(response as UdfHistoryColumns));
            return;
          }
          if (response.s === "no_data") {
            const nextTime = normaliseTime(response.nextTime as number | undefined);
            if (nextTime !== null && hops < MAX_EMPTY_WINDOW_HOPS) {
              walk({ ...base, from: nextTime - span, to: nextTime + 1 }, hops + 1);
              return;
            }
            onNoDataCallback("No more history");
            return;
          }
          onNoDataCallback(String(response.errmsg || "History request failed"));
        })
        .catch((error: Error) => onNoDataCallback(error.message));
    };
    walk(first, 0);
  }

  /**
   * Live updates without a push channel: re-read `/quotes` on a timer and hand
   * over the session's running bar when it moves.
   *
   * Only the newest bar is ever emitted, and only when its time changes — the
   * library patches the candle it already has, and replaying a closed bar would
   * make the chart look like it is redrawing history.
   *
   * `_onRestoreSubscriber` is part of the published signature and goes unused on
   * purpose: that callback exists for feeds whose subscription can drop out from
   * under the library. A poll that re-issues itself every tick has no such state
   * to restore, and calling it anyway would invite the library to stack a second
   * subscription on top of the live one.
   */
  subscribeBars(
    symbolInfo: LibrarySymbolInfo,
    _resolution: string,
    onTick: (bar: HistoryBar) => void,
    listenerGuid: string,
    _onRestoreSubscriber: (guid: string) => void,
  ): void {
    if (this.polls.has(listenerGuid)) return;
    const name = symbolInfo.ticker || symbolInfo.name;
    let lastTime: number | null = null;
    const poll = () => {
      getJson<Record<string, unknown>>(this.url("/quotes", { symbols: name }))
        .then((response) => {
          const rows = (response.d as QuoteTile[]) ?? [];
          const bar = quoteToBar(rows.find((row) => row.n === name) ?? rows[0] ?? null);
          if (!bar || bar.time === lastTime) return;
          lastTime = bar.time;
          onTick(bar);
        })
        .catch(() => {
          // A failed poll is not a dead chart: the next tick tries again, and
          // the candle the library already has stays on screen.
        });
    };
    poll();
    this.polls.set(listenerGuid, setInterval(poll, this.updateFrequencyMs));
  }

  unsubscribeBars(listenerGuid: string): void {
    const timer = this.polls.get(listenerGuid);
    if (!timer) return;
    clearInterval(timer);
    this.polls.delete(listenerGuid);
  }

  searchSymbols(
    userInput: string,
    exchange: string,
    symbolType: string,
    onSearchSetCompleted: (results: unknown[]) => void,
  ): void {
    getJson<unknown[]>(
      this.url("/search", { query: userInput, exchange, type: symbolType, limit: 20 }),
    )
      .then((rows) => onSearchSetCompleted(Array.isArray(rows) ? rows : []))
      .catch(() => onSearchSetCompleted([]));
  }

  listExchanges(callback: Callback): void {
    callback(this.config?.exchanges ?? []);
  }

  /**
   * Group listings. `/config` advertises `supports_group_request: false`, so a
   * stock widget uses `searchSymbols` instead and this answers an empty set
   * rather than pretending to be a listing source it is not.
   */
  listSymbols(_exchange: string, callback: Callback): void {
    callback({ s: "ok", d: {} });
  }

  getMarks(
    _symbol: string,
    _startDate: number,
    _endDate: number,
    callback: Callback,
  ): void {
    callback([]);
  }
}

export default UdfDatafeed;
