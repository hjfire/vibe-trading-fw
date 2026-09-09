/**
 * The 分时 view on the pro chart (local custom ㉖): one trading session of
 * 1-minute bars drawn as a line, with a 均价 overlay and a 昨收 badge.
 *
 * Everything here is asserted through what the outside world received — the
 * period pushed onto the chart, the styles pushed onto it, the indicators
 * mounted, and the parameters that went out over the wire. Not one of these
 * tests reads a predicate and calls it done: entry 46 in 项目档案.md is exactly
 * about a rule that was correct in isolation and never wired to the click.
 *
 * The four that would hurt most if they broke:
 * - the request must carry `session=latest`, or the chart draws five days of
 *   minute closes as one long line;
 * - a scroll-back must not reach the network, because the Futu allowance is
 *   per symbol per seven days and 800 minute bars is a whole day of it;
 * - the theme effect must not repaint the line as candles (it owns `candle.type`);
 * - switching to a symbol with no minute source must drop 分时, or the next
 *   request is a 400 on a view the user can still see lit up.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DataLoader, KLineData } from "klinecharts";

import { ProChart } from "../ProChart";
import { TIME_SHARE_COUNT } from "@/lib/timeShare";
import { publishThemeChange } from "@/lib/theme-store";

const SESSION_KEY = "pro-chart.session.v1";
const MINUTE = 60_000;
/** Friday 2026-09-04 09:30 Beijing, five minutes of it. */
const OPEN = Date.parse("2026-09-04T09:30:00+08:00");

const h = vi.hoisted(() => ({
  ticker: "600519.SH",
  period: { type: "day", span: 1 },
  list: [] as KLineData[],
  periods: [] as Array<{ type: string; span: number }>,
  styles: [] as Array<{ candle?: { type?: string } }>,
  indicators: [] as Array<{ op: "create" | "remove"; name: string; paneId?: string }>,
  /**
   * What is mounted on the fake chart right now. The legend the user sees is one
   * row per entry here (klinecharts dist 7485 iterates the pane's indicators), so
   * this is the observable behind the 2026-09-09 report of twenty stacked
   * `MA(5,10,30,60)` rows. Kept in sync by the create/remove fakes below, which
   * copy the library's filter semantics rather than the convenient one.
   */
  mounted: [] as Array<{ id: string; name: string; paneId: string }>,
  nextId: 0,
  requests: [] as Array<Record<string, unknown>>,
  loader: null as DataLoader | null,
  inFlight: 0,
  /** What the fake backend hands back, and what it claims about yesterday. */
  payload: [] as KLineData[],
  prevClose: null as number | null,
  sessionDate: "",
}));

/** One minute bar, ascending, the way /market/kline answers. */
function minuteBar(i: number, close: number): KLineData {
  return {
    timestamp: OPEN + i * MINUTE,
    open: close,
    high: close,
    low: close,
    close,
    volume: 100 + i,
  } as KLineData;
}

function sessionBars(): KLineData[] {
  return [440.1, 441, 442, 443, 444.4].map((close, i) => minuteBar(i, close));
}

function runLoad(type: "init" | "forward"): void {
  const loader = h.loader;
  if (!loader) return;
  h.inFlight += 1;
  void Promise.resolve(
    loader.getBars({
      type,
      timestamp: type === "forward" ? (h.list[0]?.timestamp ?? null) : null,
      // The real library hands the period it currently holds, which is what
      // `periodToInterval` derives the request interval from. Passing a literal
      // here would let the wiring pass while the period it set was never used.
      period: h.period as never,
      symbol: { ticker: h.ticker, pricePrecision: 2, volumePrecision: 0 },
      callback: (data, more) => {
        const bars = (Array.isArray(data) ? data : [data]) as KLineData[];
        if (type === "init") h.list = bars;
        else h.list = [...bars, ...h.list];
        h.inFlight -= 1;
      },
    }),
  ).catch(() => {
    h.inFlight -= 1;
  });
}

vi.mock("klinecharts", () => ({
  init: () => ({
    getSymbol: () => ({ ticker: h.ticker, pricePrecision: 2, volumePrecision: 0 }),
    getDataList: () => h.list,
    getIndicators: (filter?: { id?: string; name?: string; paneId?: string }) =>
      h.mounted.filter((ind) => matchesFilter(ind, filter)).map((ind) => ({ ...ind })),
    getOverlays: () => [],
    getPaneOptions: () => [{ id: "candle_pane", height: 300, minHeight: 30, state: "normal" }],
    getBarSpace: () => ({ bar: 8, halfBar: 4, gapBar: 5, halfGapBar: 2 }),
    getOffsetRightDistance: () => 0,
    applyOptions: () => {},
    setStyles: (s: { candle?: { type?: string } }) => {
      h.styles.push(s);
    },
    setPaneOptions: () => true,
    resize: () => {},
    setDataLoader: (loader: DataLoader) => {
      h.loader = loader;
    },
    setSymbol: (s: { ticker: string }) => {
      h.ticker = s.ticker;
      runLoad("init"); // resetData -> _processDataLoad('init')
    },
    setPeriod: (p: { type: string; span: number }) => {
      h.period = p;
      h.periods.push(p);
      runLoad("init");
    },
    createIndicator: (value: { name: string; paneId?: string }) => {
      h.indicators.push({ op: "create", name: value.name, paneId: value.paneId });
      // Deliberately *not* idempotent, because the library is not: `ChartImp.createIndicator`
      // mints a fresh id (dist 15270) and `StoreImp.addIndicator` then de-dups by
      // that id (dist 14152), so `isStack: true` always appends a second copy to
      // the pane. A fake that quietly refused the duplicate would have hidden the
      // stacking this file now pins.
      h.nextId += 1;
      h.mounted.push({ id: `${value.name}_${h.nextId}`, name: value.name, paneId: value.paneId ?? "" });
      return value.name;
    },
    removeIndicator: (filter: { id?: string; name?: string; paneId?: string } | undefined) => {
      const before = h.mounted.length;
      h.mounted = h.mounted.filter((ind) => !matchesFilter(ind, filter));
      if (filter?.name) h.indicators.push({ op: "remove", name: filter.name });
      return h.mounted.length !== before;
    },
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

// Only `fetchKline` is replaced: `INTERVALS` and `periodToInterval` stay real,
// because "which bars did the click end up asking for" is the thing under test.
vi.mock("@/lib/marketApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/marketApi")>();
  return {
    ...actual,
    fetchKline: async (params: Record<string, unknown>) => {
      h.requests.push(params);
      const line = params.session === "latest";
      return {
        status: "ok",
        symbol: params.symbol,
        interval: params.interval,
        source: line ? "fake:session" : "fake:daily",
        bars: line ? h.payload : [minuteBar(0, 440.1)],
        session_date: line ? h.sessionDate : undefined,
        prev_close: line ? h.prevClose : null,
      };
    },
  };
});

vi.mock("@/components/charts/WatchList", () => ({ default: () => null }));
vi.mock("@/components/charts/IndicatorEditor", () => ({ default: () => null }));

/**
 * `StoreImp.getIndicatorsByFilter` (dist 14176): an id in the filter matches on
 * id *alone*, otherwise a name matches by name, and an empty filter matches
 * everything. Reproduced rather than approximated because the whole bug turns
 * on the first clause.
 */
function matchesFilter(
  ind: { id: string; name: string; paneId: string },
  filter?: { id?: string; name?: string; paneId?: string },
): boolean {
  if (!filter) return true;
  if (filter.id !== undefined) return ind.id === filter.id;
  if (filter.name !== undefined) return ind.name === filter.name;
  return true;
}

function mountedCount(name: string): number {
  return h.mounted.filter((ind) => ind.name === name).length;
}

function seedSession(symbol: string, interval: string, timeShare = false): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ symbol, interval, timeShare }));
}

async function settle(): Promise<void> {
  for (let round = 0; round < 20 && h.inFlight > 0; round++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

async function mountChart(): Promise<void> {
  // `applyPaneLayout` budgets pane heights from the host's height, which jsdom
  // reports as 0 for an unstyled div.
  vi.spyOn(window.HTMLElement.prototype, "clientHeight", "get").mockReturnValue(360);
  render(<ProChart />);
  await settle();
}

const buttonOf = (name: string): HTMLButtonElement =>
  screen.getByRole("button", { name }) as HTMLButtonElement;

/** The last `candle.type` the page pushed onto the chart. */
function lastCandleType(): string | undefined {
  return h.styles.at(-1)?.candle?.type;
}

function askedFor(session: "latest" | undefined): Record<string, unknown>[] {
  return h.requests.filter((r) => (r.session === "latest") === (session === "latest"));
}

/** Candle requests for a given period, which is how "did the view re-read at the
 * same period" gets told apart from "did nothing". */
function candleRequests(interval: string): Record<string, unknown>[] {
  return h.requests.filter((r) => r.session !== "latest" && r.interval === interval);
}

beforeEach(() => {
  localStorage.clear();
  document.documentElement.classList.remove("dark");
  h.ticker = "600519.SH";
  h.period = { type: "day", span: 1 };
  h.list = [];
  h.periods = [];
  h.styles = [];
  h.indicators = [];
  h.mounted = [];
  h.nextId = 0;
  h.requests = [];
  h.loader = null;
  h.inFlight = 0;
  h.payload = sessionBars();
  h.prevClose = 440;
  h.sessionDate = "2026-09-04";
});

describe("clicking 分时", () => {
  it("pushes a 1-minute period onto the chart and asks for one session", async () => {
    seedSession("0700.HK", "1D");
    await mountChart();
    fireEvent.click(buttonOf("分时"));
    await settle();

    expect(h.periods.at(-1)).toEqual({ type: "minute", span: 1 });
    // The whole view rests on these two parameters; without `session` the route
    // returns every minute bar it has and the "line" wanders across a week.
    expect(askedFor("latest")).toEqual([
      { symbol: "0700.HK", interval: "1m", count: TIME_SHARE_COUNT, before: null, session: "latest" },
    ]);
  });

  it("paints a line, not candles", async () => {
    seedSession("0700.HK", "1D");
    await mountChart();
    expect(lastCandleType()).toBe("candle_solid");
    fireEvent.click(buttonOf("分时"));
    await settle();
    expect(lastCandleType()).toBe("area");
  });

  it("swaps MA for the 均价 overlay on the price pane", async () => {
    seedSession("0700.HK", "1D");
    await mountChart();
    fireEvent.click(buttonOf("分时"));
    await settle();
    expect(h.indicators).toContainEqual({ op: "remove", name: "MA" });
    expect(h.indicators).toContainEqual({
      op: "create",
      name: "AVG_PRICE",
      paneId: "candle_pane",
    });
  });

  it("names the day, yesterday's close and the move against it", async () => {
    seedSession("0700.HK", "1D");
    await mountChart();
    fireEvent.click(buttonOf("分时"));
    await settle();
    // (444.4 - 440) / 440 = +1.00%, off the last close of the session.
    expect(screen.getByTestId("time-share-badge").textContent).toBe(
      "分时 2026-09-04 · 昨收 440.00 · +1.00%",
    );
  });

  it("says 昨收未知 instead of inventing a flat day", async () => {
    h.prevClose = null;
    seedSession("0700.HK", "1D");
    await mountChart();
    fireEvent.click(buttonOf("分时"));
    await settle();
    const badge = screen.getByTestId("time-share-badge").textContent ?? "";
    expect(badge).toBe("分时 2026-09-04 · 昨收未知");
    // The failure this pins: "+0.00%" is a plausible number for a day that
    // might have opened +5%.
    expect(badge).not.toContain("0.00%");
  });

  it("survives a theme switch, which owns the candle type", async () => {
    // The trap: the theme effect pushes the whole style object through
    // `setStyles`, and that object carries `candle.type`. Before the choice
    // moved into `chartStyles`, flipping the theme painted candles back over a
    // 分时 line with nothing on screen to say why it had "stopped working".
    seedSession("0700.HK", "1D");
    await mountChart();
    fireEvent.click(buttonOf("分时"));
    await settle();
    act(() => {
      document.documentElement.classList.add("dark");
      publishThemeChange();
    });
    await settle();
    expect(lastCandleType()).toBe("area");
  });

  it("is a toggle, and going round again re-fetches the session", async () => {
    // 分时 has no live feed behind it, so the only refresh path is leaving and
    // re-entering. The second click must therefore go back to candles rather
    // than quietly re-asking while the button still reads as a toggle.
    seedSession("0700.HK", "1D");
    await mountChart();
    fireEvent.click(buttonOf("分时"));
    await settle();
    const first = askedFor("latest").length;

    fireEvent.click(buttonOf("分时"));
    await settle();
    expect(lastCandleType()).toBe("candle_solid");
    expect(askedFor("latest").length).toBe(first);

    fireEvent.click(buttonOf("分时"));
    await settle();
    expect(askedFor("latest").length).toBe(first + 1);
  });
});

describe("分时 never pages backwards", () => {
  it("answers a scroll with nothing and does not reach the network", async () => {
    // One drag cost a fresh slice of the seven-day, per-symbol allowance if this
    // were wired like the candle chart, and 800 minute bars is a whole day of it.
    seedSession("0700.HK", "1D");
    await mountChart();
    fireEvent.click(buttonOf("分时"));
    await settle();
    const before = h.requests.length;
    const bars = h.list.length;
    await act(async () => {
      runLoad("forward");
    });
    await settle();
    expect(h.requests.length).toBe(before);
    expect(h.list.length).toBe(bars);
  });
});

describe("分时 and the period buttons are mutually exclusive", () => {
  it("a period click ends 分时 and puts candles back", async () => {
    seedSession("0700.HK", "5m");
    await mountChart();
    fireEvent.click(buttonOf("分时"));
    await settle();
    fireEvent.click(buttonOf("日线"));
    await settle();

    expect(h.periods.at(-1)).toEqual({ type: "day", span: 1 });
    expect(lastCandleType()).toBe("candle_solid");
    expect(h.indicators).toContainEqual({ op: "remove", name: "AVG_PRICE" });
    expect(h.indicators).toContainEqual({ op: "create", name: "MA", paneId: "candle_pane" });
    expect(screen.queryByTestId("time-share-badge")).toBeNull();
    // 分时 is not a period, so no period button may light up while it is on.
    // `bg-muted font-medium` is the active marker; `bg-muted` alone is also in
    // every button's `hover:bg-muted`.
    fireEvent.click(buttonOf("分时"));
    await settle();
    for (const label of ["1分", "5分", "15分", "30分", "60分", "日线"]) {
      expect(buttonOf(label).className).not.toContain("bg-muted font-medium");
    }
    expect(buttonOf("分时").className).toContain("bg-muted font-medium");
  });

  it("leaves the user's own period alone, so turning 分时 off goes back to it", async () => {
    seedSession("AAPL.US", "15m");
    await mountChart();
    fireEvent.click(buttonOf("分时"));
    await settle();
    expect(h.periods.at(-1)).toEqual({ type: "minute", span: 1 });
    fireEvent.click(buttonOf("分时"));
    await settle();
    // Not 1-minute candles: the click ended the line, it did not pick a period.
    expect(h.periods.at(-1)).toEqual({ type: "minute", span: 15 });
  });

  it("keeps 分时 across HK -> US, and drops it for a symbol with no minute source", async () => {
    seedSession("0700.HK", "1D");
    await mountChart();
    fireEvent.click(buttonOf("分时"));
    await settle();
    const sessionRequests = askedFor("latest").length;

    fireEvent.click(buttonOf("AAPL"));
    await settle();
    expect(askedFor("latest").length).toBe(sessionRequests + 1);
    expect(lastCandleType()).toBe("area");

    fireEvent.click(buttonOf("BTC/USDT"));
    await settle();
    // The line has to go *before* setSymbol reloads, or the first request for a
    // symbol with no minute source is a guaranteed 400.
    expect(h.periods.at(-1)).toEqual({ type: "day", span: 1 });
    expect(screen.queryByTestId("time-share-badge")).toBeNull();
    expect(askedFor("latest").length).toBe(sessionRequests + 1);
  });

  it("re-reads when the two views share a period, because nothing else changed", async () => {
    // The one case where the period is the same on both sides of the toggle:
    // 1-minute candles <-> 1-minute line. A reload keyed off "did the period
    // change" leaves the chart showing the other view's bars here.
    seedSession("0700.HK", "1m");
    await mountChart();
    expect(candleRequests("1m").length).toBe(1);

    fireEvent.click(buttonOf("分时"));
    await settle();
    expect(askedFor("latest").length).toBe(1);

    fireEvent.click(buttonOf("分时"));
    await settle();
    expect(candleRequests("1m").length).toBe(2);
  });

  it("is greyed out for a symbol that has no minute source at all", async () => {
    seedSession("BTC-USDT", "1D");
    await mountChart();
    expect(buttonOf("分时").disabled).toBe(true);
  });
});

describe("a session restored on 分时 comes back as a line", () => {
  it("opens at 1-minute with the line styles, not as candles", async () => {
    seedSession("600519.SH", "1D", true);
    await mountChart();
    expect(h.periods[0]).toEqual({ type: "minute", span: 1 });
    expect(lastCandleType()).toBe("area");
    expect(screen.getByTestId("time-share-badge").textContent).toContain("昨收 440.00");
  });

  it("is dropped when the stored symbol cannot serve minute bars", async () => {
    seedSession("BTC-USDT", "1D", true);
    await mountChart();
    expect(h.periods[0]).toEqual({ type: "day", span: 1 });
    expect(screen.queryByTestId("time-share-badge")).toBeNull();
  });
});

describe("the price pane carries one overlay, not one per click", () => {
  /**
   * Reported 2026-09-09: a wall of ~20 `MA(5,10,30,60)` rows down the main pane.
   * `syncPriceOverlay` runs on every period click, and klinecharts' `createIndicator
   * (value, true)` appends without noticing the copy already on the pane — its own
   * de-dup is keyed on the id it just minted (see the note on the fake above).
   *
   * This could not have been caught by the file it shipped in, because the fake
   * answered `getIndicators: () => []`: a page that asks "is it already mounted?"
   * only misbehaves against a store that can answer. So the assertion is on what
   * is mounted, which is exactly what the canvas turns into legend rows.
   */
  it("mounts MA once and leaves it there across five period changes", async () => {
    seedSession("09988.HK", "1D");
    await mountChart();
    expect(mountedCount("MA")).toBe(1);

    for (const label of ["5分", "15分", "30分", "60分", "日线"]) {
      fireEvent.click(buttonOf(label));
      await settle();
    }

    expect(mountedCount("MA")).toBe(1);
    expect(mountedCount("AVG_PRICE")).toBe(0);
  });

  it("collapses the copies an already-stacked pane comes in with", async () => {
    seedSession("09988.HK", "1D");
    await mountChart();
    // Stage the state the pre-fix page leaves behind: a second MA on the pane.
    h.mounted.push({ id: "MA_stacked", name: "MA", paneId: "candle_pane" });
    expect(mountedCount("MA")).toBe(2);

    fireEvent.click(buttonOf("5分"));
    await settle();
    expect(mountedCount("MA")).toBe(1);
  });

  it("keeps one 均价 line when 分时 is entered three times", async () => {
    seedSession("09988.HK", "1D");
    await mountChart();

    for (let round = 0; round < 3; round++) {
      fireEvent.click(buttonOf("分时"));
      await settle();
      expect(mountedCount("AVG_PRICE")).toBe(1);
      expect(mountedCount("MA")).toBe(0);

      fireEvent.click(buttonOf("15分"));
      await settle();
      expect(mountedCount("MA")).toBe(1);
      expect(mountedCount("AVG_PRICE")).toBe(0);
    }
  });
});
