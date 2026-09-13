import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatBytes, warehouseApi, WarehouseApiError } from "../warehouseApi";

/**
 * Transport-layer tests for the warehouse client (local custom ㊱).
 *
 * The page tests cover rendering; what only this layer can prove is that a
 * control on the page becomes a query parameter the server actually reads, and
 * that a server-side error arrives as its own words rather than "request
 * failed". Both are claims the UI cannot verify from its own mock.
 */

function reply(body: unknown, status = 200, contentType = "application/json"): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": contentType }),
    json: async () => body,
  } as unknown as Response;
}

const requested: string[] = [];
const queued: Response[] = [];

/** Queue the body the next `fetch` should answer with. */
function serverReturns(body: unknown, status = 200) {
  queued.push(reply(body, status));
}

/** Queue a body the client must not try to read as JSON. */
function serverReturnsRaw(text: string, status = 200, contentType = "text/html; charset=utf-8") {
  queued.push({
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({ "content-type": contentType }),
    json: async () => {
      throw new SyntaxError(`Unexpected token '<', "${text}"... is not valid JSON`);
    },
    text: async () => text,
  } as unknown as Response);
}

function lastUrl(): string {
  return String(requested[requested.length - 1]);
}

beforeEach(() => {
  requested.length = 0;
  queued.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) => {
      requested.push(String(input));
      const next = queued.shift();
      // Failing here names the missing stub instead of surfacing as a
      // "cannot read json of undefined" somewhere inside the client.
      if (!next) throw new Error(`no response queued for ${String(input)}`);
      return next;
    }),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("audit query building", () => {
  it("asks for the default interval without stuffing the URL full", async () => {
    serverReturns({ status: "ok", clean: true });

    await warehouseApi.audit();

    expect(lastUrl()).toBe("/api/warehouse/audit");
  });

  it("passes interval and min_gap through", async () => {
    serverReturns({ status: "ok", clean: true });

    await warehouseApi.audit({ interval: "1m", minGap: 5 });

    expect(lastUrl()).toContain("interval=1m");
    expect(lastUrl()).toContain("min_gap=5");
  });

  it("sends gaps=false as a real value, not as an absent one", async () => {
    // The server default is true, so a client that drops "false" would turn the
    // skip-the-halt-scan control into a no-op that still looks checked.
    serverReturns({ status: "ok", clean: true });

    await warehouseApi.audit({ gaps: false });

    expect(lastUrl()).toContain("gaps=false");
  });

  it("sends the symbol narrowing verbatim", async () => {
    serverReturns({ status: "ok", clean: true });

    await warehouseApi.audit({ symbols: "600519.SH,000001.SZ" });

    expect(lastUrl()).toContain("symbols=600519.SH%2C000001.SZ");
  });
});

describe("error surface", () => {
  it("carries the server's own explanation", async () => {
    // The 409 body is "warehouse at ... declares schema_version=99" — the one
    // sentence that tells the operator to upgrade instead of re-syncing.
    serverReturns({ status: "error", error: "declares schema_version=99" }, 409);

    await expect(warehouseApi.status()).rejects.toThrow(/schema_version=99/);
  });

  it("keeps the status code, so a caller can branch on it", async () => {
    serverReturns({ status: "error", error: "no '5m' bars stored" }, 400);

    let caught: unknown;
    try {
      await warehouseApi.audit({ interval: "5m" });
    } catch (exc) {
      caught = exc;
    }

    expect(caught).toBeInstanceOf(WarehouseApiError);
    expect((caught as WarehouseApiError).status).toBe(400);
    expect((caught as WarehouseApiError).message).toContain("no '5m' bars stored");
  });

  it("names the API key when the server refuses", async () => {
    serverReturns({ detail: "unauthorized" }, 401);

    await expect(warehouseApi.status()).rejects.toThrow(/API key/);
  });

  it("survives a body that is not JSON", async () => {
    queued.push({
      ok: false,
      status: 502,
      headers: new Headers({ "content-type": "application/json" }),
      json: async () => {
        throw new Error("not json");
      },
    } as unknown as Response);

    const caught = (await warehouseApi.status().catch((exc: unknown) => exc)) as WarehouseApiError;

    expect(caught).toBeInstanceOf(WarehouseApiError);
    expect(caught.status).toBe(502);
    expect(caught.message).toContain("502");
  });

  it("reads an HTML answer as the missing route it is, not as a parse error", async () => {
    // What actually happened on first contact with a real server: the SPA
    // handler answers every unmatched path with index.html and status 200, so
    // `res.ok` is true and `res.json()` throws a SyntaxError that names neither
    // the path nor the reason. A bare "Unexpected token '<'" is the bug this
    // case exists to keep fixed.
    serverReturnsRaw("<!doctype html><html><head>…", 200);

    const caught = (await warehouseApi.status().catch((exc: unknown) => exc)) as WarehouseApiError;

    expect(caught).toBeInstanceOf(WarehouseApiError);
    expect(caught.name).toBe("WarehouseApiError");
    expect(caught.message).toContain("/api/warehouse/status");
    expect(caught.message).toMatch(/not JSON/);
    expect(caught.message).toMatch(/restart/i);
    expect(caught.message).toContain("text/html");
  });

  it("says the same thing when a proxy hands back a page with 401", async () => {
    serverReturnsRaw("<!doctype html>login", 401);

    await expect(warehouseApi.status()).rejects.toThrow(/not JSON/);
  });
});

describe("formatBytes", () => {
  it("matches the CLI's reading", () => {
    expect(formatBytes(0)).toBe("0B");
    expect(formatBytes(999)).toBe("999B");
    expect(formatBytes(1024)).toBe("1.0KB");
    expect(formatBytes(58_720_256)).toBe("56.0MB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0GB");
    expect(formatBytes(5 * 1024 ** 4)).toBe("5.0TB");
  });
});
