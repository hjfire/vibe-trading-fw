/**
 * Minute-bar availability on the pro chart, now that FutuOpenD serves intraday
 * bars for every market it lists rather than A-shares only.
 *
 * Three things are pinned here, and the third is the one that already
 * regressed once:
 *
 * 1. which symbols get an enabled minute-interval row in the directory at all;
 * 2. that session restore keeps a HK/US intraday interval instead of forcing it
 *    back to daily. Before the routing changed, `readSession` carried its own
 *    copy of the A-share-only rule, so a shared "Tencent, 5-minute" link
 *    rendered and then reloads as a daily chart with nothing on screen to say
 *    why.
 * 3. that **the click answers**. The rule is asked in four places (the 目录行的
 *    disabled, the click handler, the repair on symbol switch, session
 *    restore). Relaxing only the first produced a button that lit up and did
 *    nothing: `pickInterval` kept its own `/\.(SH|SZ)$/` guard, so every HK/US
 *    minute click was swallowed. A test that only reads the predicate cannot
 *    see that, so the block below mounts the page and clicks a real row in
 *    the directory.
 * 4. that 分时 (㉖) is the *same* rule, not a copy of it: the line is 1-minute
 *    data, so anything that cannot serve minute bars cannot show it either. The
 *    wiring of the view itself lives in `ProChartTimeShare.test.tsx`; what lives
 *    here is the gate, so a fourth caller cannot drift from the first three.
 * 5. that 周线 / 月线 (㉜) are gated like 日线 and *not* like the minute rows,
 *    because the server folds them out of the same daily answer — and that
 *    clicking one really asks the route for `interval=1W`, so the candles on
 *    screen and the bars on the wire cannot be two different periods.
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
  registerLocale: () => {},
  version: () => "test",
}));

// Neither side panel is part of this contract, and both reach for the network.
vi.mock("@/components/charts/WatchList", () => ({ default: () => null }));
vi.mock("@/components/charts/IndicatorEditor", () => ({ default: () => null }));

const SESSION_KEY = "pro-chart.session.v1";

function seedSession(symbol: string, interval: string): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ symbol, interval }));
}

/** 目录是浮层。工具栏里唯一一枚自陈 haspopup=menu 的按钮就是周期入口——
 *  按属性定位而不是按可达名，因为它的名字随当前档位变。 */
const periodTrigger = (): HTMLElement => {
  const candidates = screen
    .getAllByRole("button")
    .filter((b) => b.getAttribute("aria-haspopup") === "menu");
  expect(candidates).toHaveLength(1);
  return candidates[0];
};

const optionOf = (label: string): HTMLButtonElement =>
  screen.getByRole("option", { name: label }) as HTMLButtonElement;

/** 幂等地把目录打开：已经开着就一步都不做。
 *  写成无条件点入口的话，凡是「先开目录读一行、再选一行」的调用点都会在第二次点入口时
 *  把目录关掉，于是 `optionOf` 数不到东西——那是 helper 自己的坑，不是被测实现的缺陷。 */
async function openPeriodMenu(): Promise<void> {
  if (periodTrigger().getAttribute("aria-expanded") === "true") return;
  await act(async () => {
    fireEvent.click(periodTrigger());
  });
}

async function pickPeriod(label: string): Promise<void> {
  await openPeriodMenu();
  await act(async () => {
    fireEvent.click(optionOf(label));
  });
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
  it("moves the bars to 1-minute while the line is on, whatever the rows say", () => {
    expect(viewPeriod({ interval: "1D", timeShare: true })).toBe("1m");
    expect(viewPeriod({ interval: "1D", timeShare: false })).toBe("1D");
  });

  it("drops 分时 but not the interval when the symbol cannot serve minutes", () => {
    expect(viewForSymbol("BTC-USDT", "5m", true)).toEqual({ interval: "1D", timeShare: false });
  });

  it("carries both across a symbol switch where minute bars do exist", () => {
    expect(viewForSymbol("AAPL.US", "5m", true)).toEqual({ interval: "5m", timeShare: true });
  });

  it("uses one gate for the line and the 1分 row, because they are one rule", () => {
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

  // Weekly and monthly are folded out of the daily answer server-side, so the
  // symbols that can never show a minute chart can still show them — the
  // alternative was a per-source table of who serves "weekly", which is how
  // buttons that 400 get made.
  it.each(["1W", "1M"])("%s is allowed wherever daily is", (iv) => {
    for (const symbol of ["600519.SH", "0700.HK", "AAPL.US", "BTC-USDT", "SHEL.L", "^SPX"]) {
      expect(intervalAllowed(symbol, iv as "1W")).toBe(true);
    }
  });

  it("repairs only what the instrument cannot serve", () => {
    expect(repairInterval("0700.HK", "5m")).toBe("5m");
    expect(repairInterval("BTC-USDT", "5m")).toBe("1D");
    expect(repairInterval("BTC-USDT", "1D")).toBe("1D");
  });

  it("leaves a coarse period alone on a symbol with no minute source", () => {
    expect(repairInterval("BTC-USDT", "1W")).toBe("1W");
    expect(repairInterval("SHEL.L", "1M")).toBe("1M");
  });

  it("keeps a stored 月线 for BTC instead of snapping it back to 日线", () => {
    seedSession("BTC-USDT", "1M");
    expect(readSession().interval).toBe("1M");
  });

  it("keeps the weekly period underneath 分时, which is a view over minute bars", () => {
    // 分时 shows 1-minute bars, so the line needs the minute gate; the weekly
    // choice under it does not, and must survive the line being switched off.
    expect(viewForSymbol("BTC-USDT", "1W", true)).toEqual({ interval: "1W", timeShare: false });
    expect(viewForSymbol("600519.SH", "1W", true)).toEqual({ interval: "1W", timeShare: true });
    expect(viewPeriod({ interval: "1W", timeShare: true })).toBe("1m");
    expect(viewPeriod({ interval: "1W", timeShare: false })).toBe("1W");
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

  const disabledOf = (label: string): boolean => optionOf(label).disabled;

  it("clicking 5分 on 腾讯 pushes a 5-minute period onto the chart", async () => {
    seedSession("0700.HK", "1D");
    await mountChart();
    await openPeriodMenu();
    expect(disabledOf("5分")).toBe(false);
    await pickPeriod("5分");
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

  it("still greys out every minute row for BTC, so the refusal is visible", async () => {
    seedSession("BTC-USDT", "1D");
    await mountChart();
    await openPeriodMenu();
    for (const label of ["1分", "5分", "15分", "30分", "60分"]) {
      expect(disabledOf(label)).toBe(true);
    }
    expect(disabledOf("日线")).toBe(false);
    // ...while the two periods that need no intraday source stay clickable.
    expect(disabledOf("周线")).toBe(false);
    expect(disabledOf("月线")).toBe(false);
  });

  it("clicking 周线 pushes a weekly period onto the chart, not a daily one", async () => {
    seedSession("0700.HK", "1D");
    await mountChart();
    await pickPeriod("周线");
    expect(h.periods.at(-1)).toEqual({ type: "week", span: 1 });
    await pickPeriod("月线");
    expect(h.periods.at(-1)).toEqual({ type: "month", span: 1 });
  });

  it("入口按钮的可达名跟着当前档位走，换档后一起换", async () => {
    seedSession("0700.HK", "1D");
    await mountChart();
    expect(periodTrigger().textContent).toBe("日线");
    await pickPeriod("周线");
    expect(periodTrigger().textContent).toBe("周线");
  });

  it("目录里选中行的可达名与入口按钮同名（TV-CI-02 那一半句的形状）", async () => {
    seedSession("0700.HK", "1D");
    await mountChart();
    const name = periodTrigger().textContent;
    await openPeriodMenu();
    const row = optionOf("日线");
    expect(row.getAttribute("aria-selected")).toBe("true");
    expect(row.textContent).toBe(name);
  });

  it("点目录里的档位＝换档并且目录自己关闭", async () => {
    seedSession("0700.HK", "1D");
    await mountChart();
    await pickPeriod("60分");
    expect(h.periods.at(-1)).toEqual({ type: "minute", span: 60 });
    expect(screen.queryByRole("listbox")).toBeNull();
    // 收紧（Task 3 评审）：listbox 数不到也可能是目录的 role 被改名，
    // 关闭的另一半证据是入口自己说 expanded=false。原 promise 一字未删，只加这一根。
    expect(periodTrigger().getAttribute("aria-expanded")).toBe("false");
  });
});

// What the same click *asks the route for* is pinned in
// `ProChartTimeShare.test.tsx`: that file's klinecharts double keeps a real data
// loader and logs each request, while the fake above only records `setPeriod`,
// so asserting a URL here would pass without any request ever being made.
