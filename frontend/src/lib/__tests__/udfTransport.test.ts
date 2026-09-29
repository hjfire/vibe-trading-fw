import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  columnsToBars,
  fetchKline,
  RESOLUTION_BY_INTERVAL,
  type IntervalKey,
} from "../marketApi";
import {
  normaliseTime,
  quoteToBar,
  UdfDatafeed,
  type HistoryBar,
  type LibrarySymbolInfo,
} from "../udfDatafeed";

/** The chart's transport is the TradingView UDF protocol (local custom ㊶).
 *
 *  Both halves of that switch are pinned here: `fetchKline` keeps the page's
 *  millisecond / row-wise contract while the wire speaks seconds and columns,
 *  and `UdfDatafeed` speaks the protocol natively for a licensed Advanced Charts
 *  build. Every assertion is about a unit or a parameter spelling, because those
 *  are the two things a protocol adapter gets wrong quietly — a chart with a
 *  1970 axis or a monthly button that fetches one-minute bars.
 */

interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function jsonResponse(body: unknown, status = 200): FakeResponse {
  return { ok: status < 400, status, json: () => Promise.resolve(body) };
}

const DAY = 86400;
const T0 = 1789689600; // 2026-09-14 00:00:00 UTC, unix seconds

/** A `/history` answer for `n` daily bars starting at `T0`, protocol-shaped. */
function okHistory(n: number, start = T0) {
  return {
    s: "ok",
    t: Array.from({ length: n }, (_, i) => start + i * DAY),
    o: Array.from({ length: n }, (_, i) => 10 + i),
    h: Array.from({ length: n }, (_, i) => 11 + i),
    l: Array.from({ length: n }, (_, i) => 9 + i),
    c: Array.from({ length: n }, (_, i) => 10.5 + i),
    v: Array.from({ length: n }, () => 1000),
    source: "futu:opend",
  };
}

const symbolInfo: LibrarySymbolInfo = {
  name: "600519.SH",
  ticker: "600519.SH",
  description: "贵州茅台",
  type: "stock",
  exchange: "SSE",
  session: "0930-1130,1300-1500",
  timezone: "Asia/Shanghai",
  pricescale: 100,
  minmov: 1,
  volume_precision: 0,
  has_intraday: true,
  has_daily: true,
  supported_resolutions: ["1", "D"],
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.removeItem("vibe_trading_api_auth_key");
  fetchMock = vi.fn().mockResolvedValue(jsonResponse(okHistory(2)));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** The URL of one call: `index` counts up, no index means the most recent. */
function callUrl(index?: number): URL {
  const calls = fetchMock.mock.calls;
  const at = index ?? calls.length - 1;
  return new URL(String(calls[at]?.[0]), "http://localhost");
}

/** `onNoDataCallback`'s message is optional; the promise resolving it is not. */
const collectNoData = (resolve: (message: string) => void) => (message?: string) =>
  resolve(message ?? "");

// --------------------------------------------------------------------------- //
// fetchKline: the page's contract, the protocol's wire
// --------------------------------------------------------------------------- //

describe("fetchKline over /api/udf/history", () => {
  it("asks the protocol endpoint with resolution and countback, not interval and count", async () => {
    await fetchKline({ symbol: "600519.SH", interval: "1D", count: 300 });
    const url = callUrl();
    expect(url.pathname).toBe("/api/udf/history");
    expect(url.searchParams.get("resolution")).toBe("D");
    expect(url.searchParams.get("countback")).toBe("300");
    expect(url.searchParams.get("interval")).toBeNull();
    expect(url.searchParams.get("count")).toBeNull();
  });

  it("maps every toolbar key to the resolution the feed advertises", async () => {
    const expected: Record<IntervalKey, string> = {
      "1m": "1", "5m": "5", "15m": "15", "30m": "30", "60m": "60",
      "1D": "D", "1W": "W", "1M": "M",
    };
    expect(RESOLUTION_BY_INTERVAL).toEqual(expected);
    for (const [interval, resolution] of Object.entries(expected)) {
      fetchMock.mockResolvedValueOnce(jsonResponse(okHistory(1)));
      await fetchKline({ symbol: "600519.SH", interval: interval as IntervalKey });
      expect(callUrl().searchParams.get("resolution")).toBe(resolution);
    }
  });

  it("turns the millisecond paging cursor into the exclusive second-boundary `to`", async () => {
    await fetchKline({ symbol: "600519.SH", interval: "1D", before: T0 * 1000 });
    expect(callUrl().searchParams.get("to")).toBe(String(T0));
    expect(callUrl().searchParams.get("before")).toBeNull();
  });

  it("sends no `to` on the first page, which is how the server reads 'up to now'", async () => {
    await fetchKline({ symbol: "600519.SH", interval: "1D", before: null });
    expect(callUrl().searchParams.has("to")).toBe(false);
  });

  it("hands KLineChart millisecond bars back from the columnar seconds answer", async () => {
    const res = await fetchKline({ symbol: "600519.SH", interval: "1D" });
    expect(res.bars.map((b) => b.timestamp)).toEqual([T0 * 1000, (T0 + DAY) * 1000]);
    expect(res.bars[0]).toMatchObject({ open: 10, high: 11, low: 9, close: 10.5, volume: 1000 });
    expect(res.source).toBe("futu:opend");
    expect(res.status).toBe("ok");
  });

  it("passes the 分时 session view through and keeps its extra fields", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        s: "ok",
        t: [T0, T0 + 60],
        o: [10, 10], h: [10, 10], l: [10, 10], c: [10, 10], v: [1, 1],
        session_date: "2026-09-14",
        prev_close: 9.8,
        source: "futu:opend",
      }),
    );
    const res = await fetchKline({ symbol: "600519.SH", interval: "1m", session: "latest" });
    expect(callUrl().searchParams.get("session")).toBe("latest");
    expect(res.session_date).toBe("2026-09-14");
    expect(res.prev_close).toBe(9.8);
  });

  it("reports a missing session and prev_close instead of inventing them", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ s: "ok", t: [T0], o: [10], h: [10], l: [10], c: [10], v: [1] }),
    );
    const res = await fetchKline({ symbol: "600519.SH", interval: "1m", session: "latest" });
    // `prev_close: null` is the honest "the window did not reach yesterday"; a
    // normalised 0 would print +1000.00% on the 分时 badge.
    expect(res.prev_close).toBeNull();
    expect(res.session_date).toBeUndefined();
  });

  it("treats an empty session_date as absent, not as a blank badge", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ s: "ok", t: [T0], o: [10], h: [10], l: [10], c: [10], v: [1], session_date: "", prev_close: 9.8 }),
    );
    const res = await fetchKline({ symbol: "600519.SH", interval: "1m", session: "latest" });
    expect(res.session_date).toBeUndefined();
    expect(res.prev_close).toBe(9.8);
  });

  it("reads no_data as an empty page so paging stops, and not as an error", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ s: "no_data", nextTime: T0 - DAY }));
    const res = await fetchKline({ symbol: "600519.SH", interval: "1D", before: (T0 - 40 * DAY) * 1000 });
    expect(res.bars).toEqual([]);
    expect(res.status).toBe("no_data");
  });

  it("throws the server's own reason when the protocol answers 200 with s=error", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ s: "error", errmsg: "sina minute bars have no path for 0700.HK" }),
    );
    await expect(fetchKline({ symbol: "0700.HK", interval: "1m" })).rejects.toThrow(
      "sina minute bars have no path for 0700.HK",
    );
  });

  it("still honours an HTTP failure and its status code", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ detail: "Not Found" }, 404));
    await expect(fetchKline({ symbol: "?", interval: "1D" })).rejects.toThrow("Not Found");
  });

  it("keeps the adjust extension on the wire", async () => {
    await fetchKline({ symbol: "600519.SH", interval: "1D", adjust: "hfq" });
    expect(callUrl().searchParams.get("adjust")).toBe("hfq");
  });
});

describe("columnsToBars", () => {
  it("pads a short column with zeros rather than producing undefined candles", () => {
    const bars = columnsToBars({ t: [T0, T0 + DAY], o: [1], c: [2, 3] });
    expect(bars[1]).toMatchObject({ timestamp: (T0 + DAY) * 1000, open: 0, close: 3 });
  });

  it("answers an empty or missing column set with no bars", () => {
    expect(columnsToBars({})).toEqual([]);
    expect(columnsToBars({ t: [], o: [], c: [] })).toEqual([]);
  });
});

// --------------------------------------------------------------------------- //
// UdfDatafeed: the protocol natively (seconds stay seconds)
// --------------------------------------------------------------------------- //

describe("UdfDatafeed", () => {
  it("onReady forwards the resolution offer, exchanges and symbol types", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        supported_resolutions: ["1", "D"],
        exchanges: [{ value: "SSE", name: "SSE", desc: "" }],
        symbolsTypes: [{ name: "股票", value: "stock" }],
      }),
    );
    const payload = await new Promise<Record<string, unknown>>((resolve) => {
      new UdfDatafeed().onReady(resolve as (p: unknown) => void);
    });
    expect(callUrl().pathname).toBe("/api/udf/config");
    expect(payload).toEqual({
      supported_resolutions: ["1", "D"],
      exchanges: [{ value: "SSE", name: "SSE", desc: "" }],
      symbolsTypes: [{ name: "股票", value: "stock" }],
    });
  });

  it("onReady reports a broken config to the library instead of throwing", async () => {
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    const payload = await new Promise<Record<string, unknown>>((resolve) => {
      new UdfDatafeed().onReady(resolve as (p: unknown) => void);
    });
    expect(payload.error).toContain("offline");
  });

  it("resolveSymbol keeps the ticker the history route parses", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ ...symbolInfo, ticker: "" }));
    const info = await new Promise<LibrarySymbolInfo>((resolve) =>
      new UdfDatafeed().resolveSymbol("600519.SH", resolve, () => {}),
    );
    expect(callUrl().searchParams.get("symbol")).toBe("600519.SH");
    expect(info.ticker).toBe("600519.SH");
  });

  it("resolveSymbol says so when the symbol cannot be resolved", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ s: "error", errmsg: "unknown" }, 404));
    const message = await new Promise<string>((resolve) =>
      new UdfDatafeed().resolveSymbol("NOPE", () => {}, resolve),
    );
    expect(message).toContain("Cannot resolve symbol NOPE");
  });

  it("getBars sends countback only on the initial load", async () => {
    const feed = new UdfDatafeed();
    const collect = (params: { countBack?: number; from: number; to: number; initialData?: boolean }) =>
      new Promise<HistoryBar[]>((resolve, reject) =>
        feed.getBars(symbolInfo, "D", params, (bars) => resolve(bars), reject),
      );

    await collect({ countBack: 120, from: T0, to: T0 + DAY, initialData: true });
    expect(callUrl().searchParams.get("countback")).toBe("120");
    expect(callUrl().searchParams.has("from")).toBe(false);

    await collect({ from: T0 - 10 * DAY, to: T0, initialData: false });
    expect(callUrl().searchParams.get("from")).toBe(String(T0 - 10 * DAY));
    expect(callUrl().searchParams.get("to")).toBe(String(T0));
    expect(callUrl().searchParams.has("countback")).toBe(false);
  });

  it("getBars hands the library bars whose time is in seconds", async () => {
    const bars = await new Promise<HistoryBar[]>((resolve, reject) =>
      new UdfDatafeed().getBars(
        symbolInfo,
        "D",
        { countBack: 2, from: T0, to: T0 + 2 * DAY, initialData: true },
        resolve,
        (message?: string) => reject(new Error(message ?? "no data")),
      ),
    );
    expect(bars.map((b) => b.time)).toEqual([T0, T0 + DAY]);
    expect(bars[0].close).toBe(10.5);
  });

  it("getBars pages back over an empty window when the feed gives a cursor", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ s: "no_data", nextTime: T0 - DAY }))
      .mockResolvedValueOnce(jsonResponse(okHistory(1, T0 - DAY)));
    const bars = await new Promise<HistoryBar[]>((resolve, reject) =>
      new UdfDatafeed().getBars(
        symbolInfo,
        "D",
        { from: T0, to: T0 + 5 * DAY },
        resolve,
        (message?: string) => reject(new Error(message ?? "no data")),
      ),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bars.map((b) => b.time)).toEqual([T0 - DAY]);
    // The retry is anchored on the cursor: `to` is exclusive, so the bar the
    // cursor names is still inside the window that gets asked for next.
    expect(callUrl(1).searchParams.get("to")).toBe(String(T0 - DAY + 1));
    expect(callUrl(1).searchParams.get("from")).toBe(String(T0 - DAY - 5 * DAY));
  });

  it("getBars stops paging when the cursor runs out", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ s: "no_data", nextTime: T0 - DAY }));
    const message = await new Promise<string>((resolve) =>
      new UdfDatafeed().getBars(symbolInfo, "D", { from: T0, to: T0 + DAY }, () => {}, collectNoData(resolve)),
    );
    expect(message).toBe("No more history");
    // Bounded, so a feed that always answers with a cursor cannot spin here.
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it("getBars reports no history when the window is empty with nothing behind it", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ s: "no_data" }));
    const message = await new Promise<string>((resolve) =>
      new UdfDatafeed().getBars(symbolInfo, "D", { from: T0, to: T0 + DAY }, () => {}, collectNoData(resolve)),
    );
    expect(message).toBe("No more history");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("getBars forwards the feed's error text rather than a blank chart", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ s: "error", errmsg: "gateway is off" }));
    const message = await new Promise<string>((resolve) =>
      new UdfDatafeed().getBars(symbolInfo, "D", { from: T0, to: T0 + DAY }, () => {}, collectNoData(resolve)),
    );
    expect(message).toBe("gateway is off");
  });

  it("searchSymbols reads the bare array and listExchanges the cached config", async () => {
    const feed = new UdfDatafeed();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ supported_resolutions: ["D"], exchanges: [{ value: "SSE", name: "SSE" }], symbolsTypes: [] }),
    );
    await new Promise((resolve) => feed.onReady(resolve));
    const exchanges = await new Promise<unknown>((resolve) => feed.listExchanges(resolve));
    expect(exchanges).toEqual([{ value: "SSE", name: "SSE" }]);

    fetchMock.mockResolvedValueOnce(jsonResponse([{ symbol: "600519.SH", exchange: "SSE", type: "stock" }]));
    const results = await new Promise<unknown[]>((resolve) =>
      feed.searchSymbols("600", "SSE", "stock", resolve),
    );
    expect(results).toHaveLength(1);
    expect(callUrl(1).pathname).toBe("/api/udf/search");
    expect(callUrl(1).searchParams.get("query")).toBe("600");
    expect(callUrl(1).searchParams.get("exchange")).toBe("SSE");
  });

  it("listSymbols answers an empty set because group requests are not advertised", async () => {
    const payload = await new Promise<Record<string, unknown>>((resolve) =>
      new UdfDatafeed().listSymbols("SSE", resolve as (p: unknown) => void),
    );
    expect(payload).toEqual({ s: "ok", d: {} });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("subscribeBars polls the live channel and only emits a moved bar", async () => {
    vi.useFakeTimers();
    const quote = (price: number, time: number) =>
      jsonResponse({
        s: "ok",
        d: [{ s: "ok", n: "600519.SH", v: { lp: price, update_time: time, open_price: 10, high_price: price, low_price: 9, volume: 5 } }],
      });
    fetchMock.mockResolvedValue(quote(11, T0 + 60));
    const ticks: HistoryBar[] = [];
    const feed = new UdfDatafeed({ updateFrequencyMs: 1000 });
    feed.subscribeBars(symbolInfo, "1", (bar) => ticks.push(bar), "guid-1", () => {});

    await vi.advanceTimersByTimeAsync(0);
    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toMatchObject({ time: T0 + 60, open: 10, close: 11, volume: 5 });
    expect(callUrl().pathname).toBe("/api/udf/quotes");
    expect(callUrl().searchParams.get("symbols")).toBe("600519.SH");

    // Same minute, a different print: the forming candle moves but the bar does
    // not, and re-delivering it would make the chart look like history replay.
    fetchMock.mockResolvedValueOnce(quote(11, T0 + 60));
    await vi.advanceTimersByTimeAsync(1000);
    expect(ticks).toHaveLength(1);

    fetchMock.mockResolvedValueOnce(quote(12, T0 + 120));
    await vi.advanceTimersByTimeAsync(1000);
    expect(ticks).toHaveLength(2);
    expect(ticks[1].close).toBe(12);

    feed.unsubscribeBars("guid-1");
    await vi.advanceTimersByTimeAsync(3000);
    expect(ticks).toHaveLength(2);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("subscribeBars never stacks a second poll on the same listener", async () => {
    vi.useFakeTimers();
    const feed = new UdfDatafeed({ updateFrequencyMs: 1000 });
    feed.subscribeBars(symbolInfo, "1", () => {}, "guid-2", () => {});
    feed.subscribeBars(symbolInfo, "1", () => {}, "guid-2", () => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("unsubscribeBars tolerates a guid it never handed out", () => {
    expect(() => new UdfDatafeed().unsubscribeBars("ghost")).not.toThrow();
  });

  it("getMarks answers an empty list, matching supports_marks: false", async () => {
    const marks = await new Promise<unknown[]>((resolve) =>
      new UdfDatafeed().getMarks("600519.SH", 0, 1, (payload) => resolve(payload as unknown[])),
    );
    expect(marks).toEqual([]);
  });
});

describe("protocol helpers", () => {
  it("normaliseTime accepts either unit the documentation prints", () => {
    expect(normaliseTime(T0)).toBe(T0);
    expect(normaliseTime(T0 * 1000)).toBe(T0);
    expect(normaliseTime(undefined)).toBeNull();
    expect(normaliseTime(0)).toBeNull();
    expect(normaliseTime(-5)).toBeNull();
  });

  it("quoteToBar reads the running session OHLC as the live candle", () => {
    expect(
      quoteToBar({
        s: "ok",
        n: "600519.SH",
        v: { lp: 11, update_time: T0, open_price: 10, high_price: 12, low_price: 9, volume: 5 },
      }),
    ).toEqual({ time: T0, open: 10, high: 12, low: 9, close: 11, volume: 5 });
  });

  it("quoteToBar falls back to the last price for the fields the fallback chain has no answer for", () => {
    const bar = quoteToBar({ s: "ok", n: "600519.SH", v: { lp: 11, update_time: T0 } });
    expect(bar).toEqual({ time: T0, open: 11, high: 11, low: 11, close: 11, volume: 0 });
  });

  it("quoteToBar refuses to invent a candle for a failed or timeless row", () => {
    expect(quoteToBar({ s: "error", n: "X", v: null })).toBeNull();
    expect(quoteToBar({ s: "ok", n: "X", v: { lp: 11 } })).toBeNull();
    expect(quoteToBar(null)).toBeNull();
  });
});
