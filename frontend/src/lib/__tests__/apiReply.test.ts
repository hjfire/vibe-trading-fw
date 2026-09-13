import { describe, expect, it } from "vitest";
import { contentTypeOf, isJsonReply, nonJsonReplyMessage } from "../apiReply";

/**
 * The shared "that is not JSON" answer (local custom ㊱).
 *
 * Both custom clients route through this text, so the causes are pinned here
 * rather than in whichever page happened to fail first.
 */

function response(status = 200, contentType = "text/html; charset=utf-8"): Response {
  return new Response("<!doctype html>", { status, headers: { "content-type": contentType } });
}

describe("isJsonReply", () => {
  it("accepts the spellings the backend actually uses", () => {
    expect(isJsonReply(response(200, "application/json"))).toBe(true);
    expect(isJsonReply(response(200, "application/json; charset=utf-8"))).toBe(true);
    expect(isJsonReply(response(200, "application/problem+json"))).toBe(true);
  });

  it("rejects the shell and a reply that says nothing", () => {
    expect(isJsonReply(response())).toBe(false);
    expect(
      isJsonReply({ status: 200, headers: new Headers() } as unknown as Response),
    ).toBe(false);
    expect(contentTypeOf({ status: 200, headers: new Headers() } as unknown as Response)).toBe(
      "unknown",
    );
  });
});

describe("nonJsonReplyMessage", () => {
  it("names the path, the status and what came back", () => {
    const message = nonJsonReplyMessage("/alerts/rules", response(200, "text/html; charset=utf-8"));

    expect(message).toContain("/alerts/rules");
    expect(message).toContain("HTTP 200");
    expect(message).toContain("text/html; charset=utf-8");
    // Never the parse error: that string is what sent three rounds of this
    // project chasing a "bad JSON body" that was really a routing failure.
    expect(message).not.toMatch(/Unexpected token/);
  });

  it("lists every cause that has actually produced this screen, with its action", () => {
    const message = nonJsonReplyMessage("/api/warehouse/status", response());

    // 1. /alerts called with no proxy entry, 2. a server process older than its
    // own routes, 3. a cached shell replayed after the server was fixed.
    expect(message).toMatch(/PROXY_PATHS in vite\.config\.ts/);
    expect(message).toMatch(/predates the route \(restart it\)/);
    expect(message).toMatch(/cached copy of that page \(hard-reload with Ctrl\+Shift\+R\)/);
  });
});
