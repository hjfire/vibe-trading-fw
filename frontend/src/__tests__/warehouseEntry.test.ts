import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Findability guards for the warehouse page (local custom ㊱).
 *
 * The complaint that opened this feature was "找不到新功能" — the code existed,
 * the tests were green, and there was nowhere to click. A route or a nav slot
 * deleted later reproduces exactly that, and no behavioural test of the page
 * itself would notice. Same arrangement as `viteProxy.test.ts`: read the wiring
 * file and assert on it.
 */

const router = readFileSync(resolve(__dirname, "../router.tsx"), "utf-8");
const layout = readFileSync(resolve(__dirname, "../components/layout/Layout.tsx"), "utf-8");
const viteConfig = readFileSync(resolve(__dirname, "../../vite.config.ts"), "utf-8");

describe("the /warehouse page is reachable", () => {
  it("is routed", () => {
    expect(router).toContain('import("@/pages/Warehouse")');
    expect(router).toContain('{ path: "/warehouse", element: wrap(Warehouse) }');
  });

  it("is in the sidebar, and the sidebar is where a user looks", () => {
    expect(layout).toContain('to: "/warehouse"');
    // The label must be readable without a locale key landing first, or the nav
    // entry renders as the literal key string in every language.
    expect(layout).toMatch(/layout\.warehouse.*defaultValue/);
  });

  it("does not shadow an API prefix, so it needs no dev-proxy entry", () => {
    // /warehouse is SPA-only; the routes live under /api/, which is already in
    // PROXY_PATHS. If that ever changes, this assertion is the reminder that
    // vite.config.ts and helpers.py both have to know about the collision.
    expect(viteConfig).not.toContain('"/warehouse"');
    expect(router).toContain('path: "/warehouse"');
  });
});
