/**
 * Minute-bar availability on the pro chart, now that FutuOpenD serves intraday
 * bars for every market it lists rather than A-shares only.
 *
 * Three things are pinned here, and the third is the one that already
 * regressed once:
 *
 * 1. which symbols get an enabled minute-interval button at all;
 * 2. that session restore keeps a HK/US intraday interval instead of forcing it
 *    back to daily. Before the routing changed, `readSession` carried its own
 *    copy of the A-share-only rule, so a shared "Tencent, 5-minute" link
 *    rendered and then reloads as a daily chart with nothing on screen to say
 *    why.
 * 3. that **the click answers**. The rule is asked in four places (the buttons'
 *    disabled state, the click handler, the repair on symbol switch, session
 *    restore). Relaxing only the first produced a button that lit up and did
 *    nothing: `pickInterval` kept its own `/\.(SH|SZ)$/` guard, so every HK/US
 *    minute click was swallowed. A test that only reads the predicate cannot
 *    see that, so the block below mounts the page and clicks the real button.
 * 4. that 分时 (㉖) is the *same* rule, not a copy of it: the line is 1-minute
 *    data, so anything that cannot serve minute bars cannot show it either. The
 *    wiring of the view itself lives in `ProChartTimeShare.test.tsx`; what lives
 *    here is the gate, so a fourth caller cannot drift from the first three.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  ProChart,
  canMinuteBars,
  intervalAllowed,
  readSession,
  repairInterval,
  viewForSymbol,
  viewPeriod,
} from "../ProChart";

const h = vi.hoisted(() => ({
  ticker: "600519.SH",
  periods: [] as Array<{ type: string; span: number }>,
}));

// klinecharts touches the DOM the moment a chart is built. The fake records the
// one call that decides what the user sees: which period the chart was handed.
vi.mock("klinecharts", () => ({
  init: () => ({
    getSymbol: () => ({ ticker: h.ticker, pricePrecision: 2, volumePrecision: 0 }),
    getDataList: () => [],
    getIndicators: () => [],
    getOverlays: () => [],
    getPaneOptions: () => [{ id: "candle_pane", height: 300, minHeight: 30, state: "normal" }],
    getBarSpace: () => ({ bar: 8, halfBar: 4, gapBar: 5, halfGapBar: 2 }),
    getOffsetRightDistance: () => 0,
    applyOptions: () => {},
    setStyles: () => {},
    setPaneOptions: () => true,
    resize: () => {},
    setDataLoader: () => {},
    setSymbol: (s: { ticker: string }) => {
      h.ticker = s.ticker;
    },
    setPeriod: (p: { type: string; span: number }) => {
      h.periods.push(p);
    },
    createIndicator: () => true,
    removeIndicator: () => true,
    createOverlay: () => null,
    removeOverlay: () => true,
    overrideOverlay: () => true,
  }),
  dispose: () => {},
  registerIndicator: () => {},
  registerOverlay: () => {},
  getSupportedLocales: () => ["en-US", "zh-CN"],
  version: () => "test",
}));

// Neither side panel is part of this contract, and both reach for the network.
vi.mock("@/components/charts/WatchList", () => ({ default: () => null }));
vi.mock("@/components/charts/IndicatorEditor", () => ({ default: () => null }));

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
    expect(readSession()).toEqual({ symbol: "600519.SH", interval: "5m", timeShare: false });
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

  // 分时 (㉖) is stored beside the interval but is not one: `interval` stays the
  // user's K-line choice across a line view, so a reload does not silently
  // drop them onto 1-minute candles.
  it("restores 分时, and keeps the K-line choice underneath it", () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ symbol: "700.HK", interval: "15m", timeShare: true }));
    expect(readSession()).toEqual({ symbol: "700.HK", interval: "15m", timeShare: true });
  });

  it("drops 分时 for a symbol with no minute source, same as the button does", () => {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ symbol: "BTC-USDT", interval: "1D", timeShare: true }));
    expect(readSession()).toEqual({ symbol: "BTC-USDT", interval: "1D", timeShare: false });
  });

  it("treats anything but a true flag as off", () => {
    for (const value of [1, "true", null, {}]) {
      localStorage.setItem(
        SESSION_KEY,
        JSON.stringify({ symbol: "700.HK", interval: "1D", timeShare: value }),
      );
      expect(readSession().timeShare).toBe(false);
    }
  });
});

describe("viewForSymbol / viewPeriod", () => {
  it("moves the bars to 1-minute while the line is on, whatever the buttons say", () => {
    expect(viewPeriod({ interval: "1D", timeShare: true })).toBe("1m");
    expect(viewPeriod({ interval: "1D", timeShare: false })).toBe("1D");
  });

  it("drops 分时 but not the interval when the symbol cannot serve minutes", () => {
    expect(viewForSymbol("BTC-USDT", "5m", true)).toEqual({ interval: "1D", timeShare: false });
  });

  it("carries both across a symbol switch where minute bars do exist", () => {
    expect(viewForSymbol("AAPL.US", "5m", true)).toEqual({ interval: "5m", timeShare: true });
  });

  it("uses one gate for the line and the 1分 button, because they are one rule", () => {
    for (const symbol of ["600519.SH", "000001.SZ", "0700.HK", "AAPL.US", "BTC-USDT", "SHEL.L"]) {
      expect(viewForSymbol(symbol, "1D", true).timeShare).toBe(intervalAllowed(symbol, "1m"));
    }
  });
});

describe("intervalAllowed / repairInterval", () => {
  it.each(["1m", "5m", "15m", "30m", "60m"])("%s is allowed on each of the four markets", (iv) => {
    for (const symbol of ["600519.SH", "000001.SZ", "0700.HK", "AAPL.US"]) {
      expect(intervalAllowed(symbol, iv as "5m")).toBe(true);
    }
  });

  it("allows daily everywhere, including symbols with no minute source", () => {
    for (const symbol of ["BTC-USDT", "SHEL.L", "^SPX", "600519.SH"]) {
      expect(intervalAllowed(symbol, "1D")).toBe(true);
    }
  });

  it("repairs only what the instrument cannot serve", () => {
    expect(repairInterval("0700.HK", "5m")).toBe("5m");
    expect(repairInterval("BTC-USDT", "5m")).toBe("1D");
    expect(repairInterval("BTC-USDT", "1D")).toBe("1D");
  });
});

describe("the toolbar answers the click (the rule used to be spelled four times)", () => {
  beforeEach(() => {
    localStorage.clear();
    h.periods = [];
    h.ticker = "0700.HK";
  });

  async function mountChart(): Promise<void> {
    // `applyPaneLayout` budgets pane heights from the host's height, which jsdom
    // reports as 0 for an unstyled div.
    vi.spyOn(window.HTMLElement.prototype, "clientHeight", "get").mockReturnValue(360);
    render(<ProChart />);
    await act(async () => {
      await Promise.resolve();
    });
  }

  const disabledOf = (name: string): boolean =>
    (screen.getByRole("button", { name }) as HTMLButtonElement).disabled;

  it("clicking 5分 on 腾讯 pushes a 5-minute period onto the chart", async () => {
    seedSession("0700.HK", "1D");
    await mountChart();
    expect(disabledOf("5分")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "5分" }));
    expect(h.periods.at(-1)).toEqual({ type: "minute", span: 5 });
  });

  it("keeps the minute period when switching 腾讯 -> AAPL, both servable", async () => {
    seedSession("0700.HK", "5m");
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "AAPL" }));
    // The old copy of the rule snapped this to daily, so the user could never
    // look at a US intraday chart for longer than one click.
    expect(h.periods.some((p) => p.type === "day")).toBe(false);
  });

  it("repairs to daily when switching to a symbol with no minute source", async () => {
    seedSession("0700.HK", "5m");
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "BTC/USDT" }));
    expect(h.periods.at(-1)).toEqual({ type: "day", span: 1 });
  });

  it("still greys out every minute button for BTC, so the refusal is visible", async () => {
    seedSession("BTC-USDT", "1D");
    await mountChart();
    for (const label of ["1分", "5分", "15分", "30分", "60分"]) {
      expect(disabledOf(label)).toBe(true);
    }
    expect(disabledOf("日线")).toBe(false);
  });
});
