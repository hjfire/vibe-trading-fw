import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  candidateFromSymbol,
  createSearchSequence,
  isRoutableSymbol,
  marketLabel,
  searchSymbols,
  typeLabel,
  type SymbolCandidate,
  type SymbolSearchResponse,
} from "../symbolSearch";

/** Client contract for GET /market/symbols (local custom ㉓).
 *
 *  fetch is stubbed, so this pins the request shape and the response-shaping
 *  rules the combobox relies on — including the one that keeps a stale, wide
 *  answer from painting over a narrower one. */

/** Minimal stand-in for the subset of a Response searchSymbols touches. */
interface FakeResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

function jsonResponse(body: unknown, status = 200): FakeResponse {
  return { ok: status < 400, status, json: () => Promise.resolve(body) };
}

const okBody = (results: SymbolCandidate[]): SymbolSearchResponse => ({
  status: "ok",
  ready: true,
  count: results.length,
  results,
});

const row = (symbol: string): SymbolCandidate => ({
  symbol,
  name: `name-of-${symbol}`,
  market: "SH",
  type: "equity",
});

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(jsonResponse(okBody([])));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function lastUrl(): URL {
  const calls = fetchMock.mock.calls;
  const call = calls[calls.length - 1]?.[0] as string;
  return new URL(call, "http://localhost");
}

describe("searchSymbols", () => {
  it("sends the query and limit as query params", async () => {
    fetchMock.mockResolvedValue(jsonResponse(okBody([row("600519.SH")])));

    const out = await searchSymbols("茅台", 5);

    const url = lastUrl();
    expect(url.pathname).toBe("/market/symbols");
    expect(url.searchParams.get("q")).toBe("茅台");
    expect(url.searchParams.get("limit")).toBe("5");
    expect(out.results[0].symbol).toBe("600519.SH");
  });

  it("treats a warming roster as an empty, non-throwing answer", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ status: "warming", ready: false, results: [], count: 0, building: true }),
    );

    const out = await searchSymbols("600");

    expect(out.ready).toBe(false);
    expect(out.building).toBe(true);
    expect(out.results).toEqual([]);
  });

  it("defaults a malformed body to 'ready with nothing to show'", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: "ok" }));

    const out = await searchSymbols("zzz");

    expect(out.ready).toBe(true);
    expect(out.results).toEqual([]);
  });

  it("throws on a server error so the caller can fall back to a plain input", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ detail: "boom" }, 500));

    await expect(searchSymbols("600")).rejects.toThrow("boom");
  });
});

describe("createSearchSequence", () => {
  /** Answers are gated by the test, so response ordering is fully controlled. */
  function gatedFetch() {
    const gates: { resolve: (v: FakeResponse) => void; reject: (e: Error) => void }[] = [];
    const fn = vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
      let resolve!: (v: FakeResponse) => void;
      let reject!: (e: Error) => void;
      const promise = new Promise<FakeResponse>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      // A real aborted fetch rejects with AbortError; mirror that, or the
      // "superseded request" path is never exercised.
      init?.signal?.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
      gates.push({ resolve, reject });
      return promise;
    });
    vi.stubGlobal("fetch", fn);
    return { fn, gates };
  }

  it("drops the older answer when a newer keystroke supersedes it", async () => {
    const { gates } = gatedFetch();
    const seq = createSearchSequence();

    const first = seq.run("600");
    const second = seq.run("600519");

    gates[1].resolve(jsonResponse(okBody([row("600519.SH")])));

    // The narrower query wins; the wider one was aborted and paints nothing.
    await expect(second).resolves.toMatchObject({ results: [{ symbol: "600519.SH" }] });
    await expect(first).resolves.toBeNull();
    expect(gates[0]).toBeDefined();
  });

  it("resolves a cancelled run to null instead of rejecting into .catch()", async () => {
    const { fn, gates } = gatedFetch();
    const seq = createSearchSequence();

    const pending = seq.run("600");
    seq.cancel();

    const signal = (fn.mock.calls[0][1] as { signal: AbortSignal }).signal;
    expect(signal.aborted).toBe(true);
    await expect(pending).resolves.toBeNull();
    gates[0].resolve(jsonResponse(okBody([]))); // late answer is ignored
  });
});

describe("candidateFromSymbol", () => {
  it("derives the venue badge from the suffix and leaves the name blank", () => {
    expect(candidateFromSymbol(" 600519.sh ")).toEqual({
      symbol: "600519.SH",
      name: "",
      market: "SH",
      type: "",
    });
  });

  it("keeps a suffix-less pair (crypto / FX) as-is with no market", () => {
    const c = candidateFromSymbol("BTC-USDT");
    expect(c.symbol).toBe("BTC-USDT");
    expect(c.market).toBe("");
  });
});

describe("labels", () => {
  it("names the venues the roster serves and passes unknown ones through", () => {
    expect(marketLabel("SH")).toBe("沪");
    expect(marketLabel("US")).toBe("美");
    expect(marketLabel("FO")).toBe("FO");
    expect(typeLabel("etf")).toBe("ETF");
    expect(typeLabel("warrant")).toBe("warrant");
  });
});

describe("isRoutableSymbol", () => {
  // Browser-side mirror of symbol_roster._is_chartable, plus the pair syntax
  // the roster deliberately does not carry. It decides whether Enter commits
  // the typed text or defers to the suggestion list.
  it.each([
    ["600519.SH", true],
    ["920000.BJ", true],
    ["00700.HK", true],
    ["BRK.B.US", true],
    ["  aapl.us ", true],
    ["BTC-USDT", true],
    ["EUR_USD", true],
  ] as const)("%s is routable as it stands", (text, expected) => {
    expect(isRoutableSymbol(text)).toBe(expected);
  });

  it.each([
    ["00700"], // a Hong Kong code with no venue: the bug Enter used to commit
    ["600"],
    ["AAPL"],
    ["SH600519"],
    ["贵州茅台"],
    ["BTCUSD"],
    [""],
  ])("%s is not, so the picker should decide", (text) => {
    expect(isRoutableSymbol(text)).toBe(false);
  });
});
