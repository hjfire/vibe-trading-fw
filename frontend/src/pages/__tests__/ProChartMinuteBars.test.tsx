/**
 * Minute-bar availability on the pro chart, now that FutuOpenD serves intraday
 * bars for every market it lists rather than A-shares only.
 *
 * Two things are pinned here, and the second is the one that regresses quietly:
 *
 * 1. which symbols get an enabled minute-interval button at all;
 * 2. that session restore keeps a HK/US intraday interval instead of forcing it
 *    back to daily. Before the routing changed, `readSession` carried its own
 *    copy of the A-share-only rule, so a shared "Tencent, 5-minute" link
 *    rendered and then reloads as a daily chart with nothing on screen to say
 *    why. A single shared predicate is the fix; this test is the tripwire that
 *    keeps the copies from coming back.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { canMinuteBars, readSession } from "../ProChart";

// klinecharts touches the DOM the moment a chart is built; importing the page
// must not require a canvas.
vi.mock("klinecharts", () => ({
  init: () => ({
    applyOptions: () => {},
    createIndicator: () => true,
    dispose: () => {},
    getSymbol: () => null,
    setStyles: () => {},
  }),
  dispose: () => {},
  registerIndicator: () => {},
  registerOverlay: () => {},
  version: () => "test",
}));

const SESSION_KEY = "pro-chart.session.v1";

function seedSession(symbol: string, interval: string): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ symbol, interval }));
}

describe("canMinuteBars", () => {
  it.each(["600519.SH", "000001.SZ", "700.HK", "AAPL.US"])("serves %s", (symbol) => {
    expect(canMinuteBars(symbol)).toBe(true);
  });

  it("is case-insensitive, because the route upper-cases the symbol", () => {
    expect(canMinuteBars("aapl.us")).toBe(true);
    expect(canMinuteBars("700.hk")).toBe(true);
  });

  // These have no minute source on either side of the fall-through: Futu does
  // not list them and Sina is an A-share API.
  it.each(["BTC-USDT", "SHEL.L", "^SPX", "EURUSD", "GLD.F"])(
    "has no minute source for %s",
    (symbol) => {
      expect(canMinuteBars(symbol)).toBe(false);
    },
  );

  it("does not match a market-looking suffix that is not one of the four", () => {
    expect(canMinuteBars("700.HKS")).toBe(false);
    expect(canMinuteBars("AAPL.UX")).toBe(false);
  });
});

describe("readSession preserves the interval the symbol can actually serve", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("keeps 5m for an A-share", () => {
    seedSession("600519.SH", "5m");
    expect(readSession()).toEqual({ symbol: "600519.SH", interval: "5m" });
  });

  it("keeps 5m for HK, which the old A-share-only rule forced onto 1D", () => {
    seedSession("700.HK", "5m");
    expect(readSession().interval).toBe("5m");
  });

  it("keeps 1m for US equities", () => {
    seedSession("AAPL.US", "1m");
    expect(readSession().interval).toBe("1m");
  });

  it("still repairs an interval BTC cannot serve", () => {
    seedSession("BTC-USDT", "15m");
    expect(readSession().interval).toBe("1D");
  });

  it("upper-cases a restored symbol, so a typed lowercase code survives the trip", () => {
    seedSession("aapl.us", "30m");
    const session = readSession();
    expect(session.symbol).toBe("AAPL.US");
    expect(session.interval).toBe("30m");
  });

  it("falls back to the default pair when nothing was stored", () => {
    const session = readSession();
    expect(session.symbol).toBe("600519.SH");
    expect(session.interval).toBe("1D");
  });

  it("rejects an interval that is not on the toolbar", () => {
    seedSession("700.HK", "4h");
    expect(readSession().interval).toBe("1D");
  });
});
