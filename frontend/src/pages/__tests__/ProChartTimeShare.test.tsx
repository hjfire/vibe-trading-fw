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
import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DataLoader, KLineData } from "klinecharts";

import { ProChart } from "../ProChart";
import { TIME_SHARE_COUNT, BAR_SPACE_LIMIT, DEFAULT_CANDLE_BAR_SPACE, DEFAULT_CANDLE_OFFSET_RIGHT, getChangeBase, setChangeBase } from "@/lib/timeShare";
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
  /**
   * The newest chart's pane list (㉛). `removeIndicator` destroying a strip is
   * only half of "the height came back"; this is the other half, and it is what
   * a test asserts when it wants to know what the chart still holds.
   */
  panes: [] as Array<{ id: string; height: number; minHeight: number; state: string }>,
  nextId: 0,
  requests: [] as Array<Record<string, unknown>>,
  loader: null as DataLoader | null,
  inFlight: 0,
  /** What the fake backend hands back, and what it claims about yesterday. */
  payload: [] as KLineData[],
  prevClose: null as number | null,
  sessionDate: "",
  /**
   * The zoom, the right offset and the scroll, kept as state rather than as a
   * call log (㉘). `setBarSpace` is the whole of "does one trading day fit on
   * screen", and a fake that only recorded that it was called would pass while
   * the page fitted nothing at all.
   */
  barSpace: 8,
  spaceCalls: [] as number[],
  /**
   * The right margin, held the way the library holds it — as a *bar count*
   * (`_lastBarRightSideDiffBarCount`), converted from the pixels it was handed
   * using the spacing in force at that instant (㉙, dist 13694). Storing the
   * pixels instead would have let `setOffsetRightDistance` run *before*
   * `setBarSpace` and still read back as applied, which is the order that shipped
   * the half-empty pane: `setBarSpace` never revisits that bar count (dist
   * 13666-13681), so the margin comes out scaled by the ratio of the spacings.
   */
  offsetRightBars: 5.25,
  /**
   * Margin applications as an ordered log, each tagged with the zoom that was in
   * force when it landed. State alone cannot prove the order: the page fits twice
   * on a session restored onto 分时, and a second application at the settled zoom
   * quietly repairs what the first one skewed.
   */
  offsetCalls: [] as Array<{ distance: number; atSpace: number }>,
  scrolled: 0,
  /** Width the fake reports for the price pane's main widget; 0 = jsdom. */
  domWidth: 0,
  /** How many times `init` ran, so a StrictMode remount is observable. */
  inits: 0,
  /** `setPaneOptions` calls tagged by which mount made them (㉘, see below). */
  paneCalls: [] as Array<{ init: number; id: string; height: number | undefined }>,
  /** What the 昨收 base was at the instant bars were delivered to the chart. */
  basesAtDelivery: [] as Array<number | null>,
  /**
   * Every write the page made to the library's locale table. Deliberately NOT
   * cleared by `beforeEach`: `registerLocale` patches a global once per page load
   * (㉙), so an accumulator that survives the file is what lets any mount here
   * answer "did the page ever call it" — which is the wiring half of the rule.
   */
  localePatches: [] as Array<{ tag: string; patch: Record<string, string> }>,
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

/** A full A-share session of minute bars, for the fit-to-width assertions. */
function sessionBarsOf(n: number): KLineData[] {
  return Array.from({ length: n }, (_, i) => minuteBar(i, 440 + (i % 5) * 0.4));
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
        // Captured *inside* the delivery: the 昨收 line's `calc` runs here, so a
        // base written after this call would not reach the line until some later
        // data event that 分时 never gets (no paging, no push).
        h.basesAtDelivery.push(getChangeBase());
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
  init: () => {
    h.inits += 1;
    // One pane list *per chart instance*, because that is what the library hands
    // out: a fresh chart's sub panes start at its own default 100px, which is the
    // whole reason the StrictMode remount below needs the budget re-applied.
    const panes: Array<{ id: string; height: number; minHeight: number; state: string }> = [
      { id: "candle_pane", height: 300, minHeight: 30, state: "normal" },
    ];
    // ...and the same for the indicators mounted on it (㉛). A disposed chart's
    // panes die with it, so a second `init` must not look at the first chart's
    // VOL/MACD and conclude they are already drawn — that is precisely the
    // StrictMode case the budget test below measures. `h.mounted` / `h.panes`
    // track the *newest* instance, which is the only one a test drives.
    const mounted: Array<{ id: string; name: string; paneId: string }> = [];
    h.mounted = mounted;
    h.panes = panes;
    return {
    getSymbol: () => ({ ticker: h.ticker, pricePrecision: 2, volumePrecision: 0 }),
    getDataList: () => h.list,
    getIndicators: (filter?: { id?: string; name?: string; paneId?: string }) =>
      mounted.filter((ind) => matchesFilter(ind, filter)).map((ind) => ({ ...ind })),
    getOverlays: () => [],
    // Both shapes, like the real one (dist 15587-15594): no argument lists every
    // pane, an id answers that pane or `null`. `syncSubPanes` and ⑲'s `paneLookup`
    // read the second form, so a fake that always answered with the whole list
    // would let the page believe every strip is still on screen.
    getPaneOptions: (id?: string) =>
      id === undefined || id === null
        ? panes.map((p) => ({ ...p }))
        : panes.find((p) => p.id === id) ?? null,
    getBarSpace: () => ({ bar: h.barSpace, halfBar: h.barSpace / 2, gapBar: h.barSpace, halfGapBar: h.barSpace / 2 }),
    // Dist 13710: the pixel form is derived from the bar count on the way out, so
    // a test that reads it is reading what the chart is drawing.
    getOffsetRightDistance: () => Math.max(0, h.offsetRightBars * h.barSpace),
    setOffsetRightDistance: (distance: number) => {
      h.offsetRightBars = distance / h.barSpace;
      h.offsetCalls.push({ distance, atSpace: h.barSpace });
    },
    // Mirrors `StoreImp.setBarSpace` (dist 13666) closely enough to matter: it
    // stores the value and re-derives nothing, so the width it was computed
    // against is the page's business, not the library's.
    setBarSpace: (space: number) => {
      h.barSpace = space;
      h.spaceCalls.push(space);
    },
    scrollToRealTime: () => {
      h.scrolled += 1;
    },
    getDom: (_paneId?: string, position?: string) =>
      position === "main" || position === undefined
        ? { getBoundingClientRect: () => ({ width: h.domWidth, height: 200 }) }
        : null,
    applyOptions: () => {},
    setStyles: (s: { candle?: { type?: string } }) => {
      h.styles.push(s);
    },
    setPaneOptions: (o: { id?: string; height?: number }) => {
      const pane = panes.find((p) => p.id === o.id);
      if (pane && typeof o.height === "number") pane.height = o.height;
      h.paneCalls.push({ init: h.inits, id: o.id ?? "", height: o.height });
      return true;
    },
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
      mounted.push({ id: `${value.name}_${h.nextId}`, name: value.name, paneId: value.paneId ?? "" });
      // A named pane the chart does not hold yet appears at the library's own
      // default height (100px) — the number `applyPaneLayout` exists to correct.
      if (value.paneId && !panes.some((p) => p.id === value.paneId)) {
        panes.push({ id: value.paneId, height: 100, minHeight: 30, state: "normal" });
      }
      return value.name;
    },
    removeIndicator: (filter: { id?: string; name?: string; paneId?: string } | undefined) => {
      const before = mounted.length;
      const doomed = mounted.filter((ind) => matchesFilter(ind, filter));
      for (let i = mounted.length - 1; i >= 0; i--) {
        if (matchesFilter(mounted[i], filter)) mounted.splice(i, 1);
      }
      // Dist 15330-15347: `ChartImp.removeIndicator` destroys a sub pane that is
      // left without an indicator. A fake that kept the pane would let
      // `applyPaneLayout` hand height to strips the real chart has already
      // dropped, so a "closing a sub chart frees the height" test would pass on
      // a chart that never freed anything.
      for (const paneId of [...new Set(doomed.map((i) => i.paneId))]) {
        if (paneId === "candle_pane" || paneId === "x_axis_pane") continue;
        if (mounted.some((ind) => ind.paneId === paneId)) continue;
        const at = panes.findIndex((p) => p.id === paneId);
        if (at > -1) panes.splice(at, 1);
      }
      if (filter?.name) h.indicators.push({ op: "remove", name: filter.name });
      return mounted.length !== before;
    },
    createOverlay: () => null,
    removeOverlay: () => true,
    overrideOverlay: () => true,
    };
  },
  dispose: () => {},
  registerIndicator: () => {},
  registerOverlay: () => {},
  getSupportedLocales: () => ["en-US", "zh-CN"],
  // Patched, not asserted here: `ensurePeriodUnitLabels` is once per page load,
  // so the suite that owns that rule drives it in `klineLocale.test.ts`.
  registerLocale: (tag: string, ls: Record<string, string>) => {
    h.localePatches.push({ tag, patch: ls });
  },
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
 * `StoreImp.getIndicatorsByFilter` (dist 14176): `paneId` narrows to that pane
 * *first*, then an id in the filter matches on id **alone**, otherwise a name
 * matches by name, and an empty filter matches everything. Reproduced rather
 * than approximated because both of the first clauses decide real bugs: the
 * `paneId` clause is what a sub-pane swap is scoped by (㉡), and the id clause
 * is why `createIndicator(x, true)` appends a duplicate instead of noticing the
 * copy already mounted.
 */
function matchesFilter(
  ind: { id: string; name: string; paneId: string },
  filter?: { id?: string; name?: string; paneId?: string },
): boolean {
  if (!filter) return true;
  if (filter.paneId !== undefined && ind.paneId !== filter.paneId) return false;
  if (filter.id !== undefined) return ind.id === filter.id;
  if (filter.name !== undefined) return ind.name === filter.name;
  return true;
}

function mountedCount(name: string): number {
  return h.mounted.filter((ind) => ind.name === name).length;
}

/** The sub-chart indicators on the fake chart, in mount (i.e. display) order. */
function subPaneNames(): string[] {
  return h.mounted.filter((ind) => ind.paneId !== "candle_pane").map((ind) => ind.name);
}

/** The right margin in pixels, through the same derivation the chart uses. */
function offsetRightPx(): number {
  return Math.max(0, h.offsetRightBars * h.barSpace);
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
  h.panes = [];
  h.nextId = 0;
  h.requests = [];
  h.loader = null;
  h.inFlight = 0;
  h.payload = sessionBars();
  h.prevClose = 440;
  h.sessionDate = "2026-09-04";
  h.barSpace = 8;
  h.spaceCalls = [];
  h.offsetRightBars = 5.25;
  h.offsetCalls = [];
  h.scrolled = 0;
  h.domWidth = 0;
  h.inits = 0;
  h.paneCalls = [];
  h.basesAtDelivery = [];
  // Module state outlives the component: the 昨收 base is held in `timeShare.ts`,
  // so a test that ran after one with a base would otherwise inherit it.
  setChangeBase(null);
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
      expect(mountedCount("PREV_CLOSE")).toBe(1);
      expect(mountedCount("MA")).toBe(0);

      fireEvent.click(buttonOf("15分"));
      await settle();
      expect(mountedCount("MA")).toBe(1);
      expect(mountedCount("AVG_PRICE")).toBe(0);
      expect(mountedCount("PREV_CLOSE")).toBe(0);
    }
  });
});

/**
 * The heading over the 分时 (㉙).
 *
 * `09988.HK · 1` in the screenshot: the library builds that heading as
 * `{ticker} · {span}{i18n(period.type)}` and ships `minute: ''` in both of its
 * tables, so a minute period renders a bare number. The rule lives in
 * `klineLocale.ts`; what this file can prove is that the page hands it to the
 * library before it ever creates a chart.
 */
describe("the page registers the minute unit", () => {
  it("patches every locale the chart holds, with the unit and nothing else", async () => {
    seedSession("09988.HK", "1D", true);
    await mountChart();
    // The tags come from the fake's `getSupportedLocales`, so this also proves the
    // page asked the library rather than inventing one — an unknown tag is the
    // tooltip throw `chartLocale` exists to stop.
    expect(h.localePatches.map((p) => p.tag).sort()).toEqual(["en-US", "zh-CN"]);
    for (const { tag, patch } of h.localePatches) {
      expect(Object.keys(patch)).toEqual(["minute"]);
      expect(patch.minute.length).toBeGreaterThan(0);
      expect(patch.minute).toBe(tag.toLowerCase().startsWith("zh") ? "分钟" : "Min");
    }
  });
});

/**
 * One trading day has to fit in the pane (㉘→㉙).
 *
 * Reported as "分时显示不正常". The cause is not the line style: `candle.type:
 * "area"` changes the drawing while the zoom stays at whatever it was (the
 * library's default is 10px a bar), so a 331-bar HK session in a 376px pane
 * showed 15:22-16:00 and the rest of the day lived behind a drag. Measured on
 * the live page, and it is the open upstream request klinecharts/KLineChart#790
 * — the library has no example, so the fit had to be written down here.
 *
 * The fit has a second half, which ㉘ missed: the zoom is capped at 50px a bar,
 * so a young session cannot always fill a wide pane, and where the leftover goes
 * is a decision. "Where does the session start" is the assertion that catches it,
 * and it only bites mid-session — see the 09:33 case below.
 *
 * `h.domWidth` is what makes this testable at all: jsdom says 0 for everything,
 * which the page reads as "cannot answer" and acts on by changing nothing.
 */
describe("分时 fills the pane with the session", () => {
  it("sets the zoom and spends only the rounding slack on the right", async () => {
    h.domWidth = 375;
    h.payload = sessionBarsOf(240);
    seedSession("600519.SH", "1D");
    await mountChart();
    expect(h.barSpace).toBe(8); // candles are nobody's business

    fireEvent.click(buttonOf("分时"));
    await settle();
    // 375 / 240 = 1.5625, floored to 1.56 so the session ends inside the pane.
    expect(h.barSpace).toBe(1.56);
    // Not 0: 240 bars of 1.56px is 374.4px and the pane is 375px. That 0.6px is
    // the floor's slack, and it now belongs to the right of the session instead
    // of being silently clipped off its start.
    expect(offsetRightPx()).toBeCloseTo(0.6, 6);
    expect(h.barSpace * 240 + offsetRightPx()).toBeCloseTo(375, 6);
    expect(h.scrolled).toBeGreaterThan(0);
  });

  it("starts a session that is too young to fill the pane at the left edge", async () => {
    // ㉙, the report that ㉘'s check could not see: a 09:33 screenshot of 09988.HK
    // with 13 bars in a 922px panel. 922 / 13 wants 71px a bar, the library caps
    // it at 50 (`barSpaceLimit.max`, dist 13667 — and it is init-only, so there is
    // no raising it at runtime), so the session can only ever be 650px wide. The
    // 272px left over must be the minutes the day has not traded yet, not a gap
    // before the opening bell.
    h.domWidth = 922;
    h.payload = sessionBarsOf(13);
    seedSession("09988.HK", "1D", true);
    await mountChart();
    expect(h.barSpace).toBe(BAR_SPACE_LIMIT.max);
    expect(offsetRightPx()).toBeCloseTo(272, 6);
    // The invariant, and the one that names the bug: session + margin is the pane,
    // so there is nothing left to sit to the left of 09:30.
    expect(h.barSpace * 13 + offsetRightPx()).toBeCloseTo(922, 6);
    // And it was applied at the new zoom, not the old one: the fake stores the
    // margin as a bar count exactly as the library does, so an offset set *before*
    // `setBarSpace` would read back as 272 / 8 bars = 1360px here.
    expect(h.offsetCalls.at(-1)?.distance).toBeCloseTo(272, 6);
    expect(h.offsetRightBars).toBeCloseTo(5.44, 6);
    // Every margin was applied *at* the zoom it was derived from. This is the
    // order ㉙ shipped wrong, and it is invisible in the end state above.
    for (const call of h.offsetCalls) {
      expect(call.atSpace).toBe(BAR_SPACE_LIMIT.max);
    }
  });

  it("fits again when the host is resized", async () => {
    // The fit is a property of the width, so a width change invalidates it; a
    // split-screen resize that left the zoom alone shrank the line back into a
    // corner of the pane.
    h.domWidth = 375;
    h.payload = sessionBarsOf(240);
    seedSession("600519.SH", "1D", true);
    await mountChart();
    expect(h.barSpace).toBe(1.56);

    h.domWidth = 750;
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    await settle();
    expect(h.barSpace).toBe(3.12);
  });

  it("gives the candles their own zoom back when 分时 ends", async () => {
    h.domWidth = 375;
    h.payload = sessionBarsOf(240);
    seedSession("600519.SH", "1D");
    await mountChart();

    fireEvent.click(buttonOf("分时"));
    await settle();
    expect(h.barSpace).toBe(1.56);

    fireEvent.click(buttonOf("15分"));
    await settle();
    // Not 1.56: a K-line chart of 500 daily bars at 1.5px a bar is the same
    // complaint arriving on the other side of the toggle.
    expect(h.barSpace).toBe(8);
  });

  it("does not hand the candles a margin that was measured at the line's zoom", async () => {
    // The other half of the borrow. A wide pane and a young session: `fitBarSpace`
    // stops at 50px, so 13 bars take 650 of the 1920 and the remaining 1270 gets
    // parked on the right — as a *bar count* (25.4), because that is how the store
    // holds it (dist 13694). Return the zoom alone and the K-line chart opens with
    // 25.4 bars of gap after the newest daily bar.
    h.domWidth = 1920;
    h.payload = sessionBarsOf(13);
    seedSession("600519.SH", "1D");
    await mountChart();

    fireEvent.click(buttonOf("分时"));
    await settle();
    expect(h.barSpace).toBe(BAR_SPACE_LIMIT.max);
    expect(offsetRightPx()).toBeCloseTo(1270, 6);

    fireEvent.click(buttonOf("15分"));
    await settle();
    expect(h.barSpace).toBe(8);
    expect(offsetRightPx()).toBe(42); // 5.25 bars, exactly what the candles had
  });

  it("leaves the zoom alone for a host that reports no width", async () => {
    h.payload = sessionBarsOf(240);
    seedSession("600519.SH", "1D");
    await mountChart();
    fireEvent.click(buttonOf("分时"));
    await settle();
    expect(h.spaceCalls).toEqual([]);
    expect(h.offsetCalls).toEqual([]); // the margin is part of the same answer
    expect(h.barSpace).toBe(8);
  });

  it("hands the default zoom back when the page opened on 分时", async () => {
    // This one came out of the live check, not from reading the code: a session
    // restored onto 分时 never had a candle view to borrow a zoom from, so
    // leaving it had nothing saved to put back — and kept the 1.1px the line
    // needed, handing the user 176 daily bars squeezed into a strip.
    h.domWidth = 375;
    h.payload = sessionBarsOf(240);
    seedSession("600519.SH", "1D", true);
    await mountChart();
    expect(h.barSpace).toBe(1.56); // fitted for the restored session

    fireEvent.click(buttonOf("15分"));
    await settle();
    expect(h.barSpace).toBe(DEFAULT_CANDLE_BAR_SPACE);
    expect(offsetRightPx()).toBe(DEFAULT_CANDLE_OFFSET_RIGHT); // the margin too
  });
});

describe("the 昨收 line is fed before the bars are", () => {
  it("knows yesterday by the time the chart computes the overlays", async () => {
    // The order is the whole test: the 昨收 line's `calc` runs inside the
    // delivery, and 分时 gets no later data event to catch up on (no paging, no
    // push), so a base written after `callback` draws nothing.
    h.prevClose = 440;
    seedSession("0700.HK", "1D");
    await mountChart();
    fireEvent.click(buttonOf("分时"));
    await settle();
    expect(h.basesAtDelivery.at(-1)).toBe(440);
    expect(mountedCount("PREV_CLOSE")).toBe(1);
  });

  it("stays empty when the server did not reach yesterday", async () => {
    h.prevClose = null;
    seedSession("0700.HK", "1D");
    await mountChart();
    fireEvent.click(buttonOf("分时"));
    await settle();
    // No line at an invented level: the badge says 昨收未知 and the chart agrees.
    expect(h.basesAtDelivery.at(-1)).toBeNull();
    expect(screen.getByTestId("time-share-badge").textContent).toContain("昨收未知");
  });
});

/**
 * The height budget under React's double mount (㉘).
 *
 * `applyPaneLayout` guards against undoing a separator drag by remembering the
 * last `chartHeight|pane ids` it budgeted. A ref survives a StrictMode remount;
 * the chart inside it does not — the second mount gets a fresh chart whose
 * panes are back at the library's defaults, and a guard that only compares the
 * string returns early. Measured on the dev page 2026-09-05: a 358px host with a
 * 130px main chart and two 100px sub panes, where the plan said 180/75/75. The
 * production build mounts once and never showed it, which is how it shipped.
 */
describe("a StrictMode remount still gets its pane budget", () => {
  it("re-applies the budget for the second chart instance", async () => {
    seedSession("0700.HK", "1D");
    vi.spyOn(window.HTMLElement.prototype, "clientHeight", "get").mockReturnValue(360);
    render(
      <StrictMode>
        <ProChart />
      </StrictMode>,
    );
    await settle();
    expect(h.inits).toBe(2);
    for (const init of [1, 2]) {
      expect(h.paneCalls.some((c) => c.init === init)).toBe(true);
    }
    // The budget, not merely *a* call: 360px of host leaves 75px per sub pane,
    // and a chart that answered with its own default 100 is the squashed main
    // chart this file's sibling entries keep filing.
    for (const id of ["sub:VOL", "sub:MACD"]) {
      expect(h.paneCalls.filter((c) => c.init === 2 && c.id === id).map((c) => c.height)).toEqual([75]);
    }
  });

  it("does not rebudget the same instance twice for one layout", async () => {
    // The other half of the guard: the ResizeObserver fires on every side-panel
    // toggle, and re-running the budget would fight a separator drag.
    seedSession("0700.HK", "1D");
    await mountChart();
    const after = h.paneCalls.length;
    act(() => {
      window.dispatchEvent(new Event("resize"));
    });
    await settle();
    expect(h.paneCalls.length).toBe(after);
  });
});

/**
 * Which sub charts sit under the price pane (local custom ㉛).
 *
 * The ask was three things — take 分时 from Futu OpenD, show 成交量 on its sub
 * chart, and let the user add or change indicators — and the first two are
 * settled elsewhere (the route assertions at the top of this file; the default
 * set below). What these tests guard is the *editing*, and above all the
 * boundary the editor must not cross: `syncPriceOverlay` owns 均价 / 昨收 / MA on
 * the main pane, and the workbench owns the user's own formulas. A
 * `syncSubPanes` written as "remove everything not wanted" would pass a test
 * that only looks at VOL and MACD, and would quietly eat somebody's script.
 *
 * Everything is driven through the toolbar, and every expectation is what the
 * chart ends up holding (`subPaneNames()`) or what landed in `localStorage` —
 * not a call log, because "the page called createIndicator" is true even when
 * the pane opened on top of another one.
 */
describe("副图指标 (㉛)", () => {
  const SUB_SETS_KEY = "pro-chart.subIndicators.v1";
  const USER_IND_KEY = "pro-chart.userIndicators.v2";

  /** Seed one saved formula; `enabled: false` means it is written but not on the chart. */
  function seedScript(id: string, enabled: boolean): void {
    localStorage.setItem(
      USER_IND_KEY,
      JSON.stringify([
        { id, label: `脚本${id}`, kind: "pane", params: [], code: "return { D: close };", enabled },
      ]),
    );
  }

  function savedSets(): Record<string, string[]> {
    const raw = localStorage.getItem(SUB_SETS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
  }

  async function openPicker(): Promise<void> {
    fireEvent.click(buttonOf("副图指标"));
    await settle();
  }

  it("分时 只挂成交量，退回 K 线又把 MACD 铺回来", async () => {
    seedSession("0700.HK", "1D");
    await mountChart();
    expect(subPaneNames()).toEqual(["VOL", "MACD"]);

    fireEvent.click(buttonOf("分时"));
    await settle();
    expect(subPaneNames()).toEqual(["VOL"]);

    // The other way, from state rather than from the default: the K 线 list was
    // never rewritten by the 分时 view, so MACD comes back where it was.
    fireEvent.click(buttonOf("分时"));
    await settle();
    expect(subPaneNames()).toEqual(["VOL", "MACD"]);
    // Reading a default is not an edit — nothing should have been banked.
    expect(localStorage.getItem(SUB_SETS_KEY)).toBeNull();
  });

  it("a session restored straight into 分时 opens with one sub chart", async () => {
    seedSession("0700.HK", "1m", true);
    await mountChart();
    expect(lastCandleType()).toBe("area");
    expect(subPaneNames()).toEqual(["VOL"]);
  });

  it("挑一个指标只多一条副图，已有的那条不动", async () => {
    seedSession("0700.HK", "1D");
    await mountChart();
    await openPicker();

    fireEvent.click(buttonOf("副图指标 RSI"));
    await settle();
    expect(subPaneNames()).toEqual(["VOL", "MACD", "RSI"]);
    expect(savedSets()).toEqual({ kline: ["VOL", "MACD", "RSI"], timeShare: ["VOL"] });
    // Already-mounted entries leave the catalogue, so a double click cannot
    // append a second copy — `createIndicator` never refuses one (㉘).
    expect(buttonOf("副图指标 RSI").disabled).toBe(true);
    expect(buttonOf("副图指标 成交量").disabled).toBe(true);

    fireEvent.click(buttonOf("关闭副图 MACD"));
    await settle();
    expect(subPaneNames()).toEqual(["VOL", "RSI"]);
    expect(savedSets().kline).toEqual(["VOL", "RSI"]);
  });

  it("关掉的那条副图，换个标的也不会自己活过来", async () => {
    seedSession("0700.HK", "1D");
    await mountChart();
    await openPicker();
    fireEvent.click(buttonOf("关闭副图 MACD"));
    await settle();
    expect(subPaneNames()).toEqual(["VOL"]);

    // A symbol switch re-runs the view wiring. "Is MACD already up?" has to be
    // read off the pane it would live on — the library destroys that pane when
    // the strip closes — or a chart that is asked to show the wanted set quietly
    // pushes back the one the user just turned off.
    fireEvent.click(buttonOf("AAPL"));
    await settle();
    expect(subPaneNames()).toEqual(["VOL"]);
    expect(h.panes.map((p) => p.id)).toEqual(["candle_pane", "sub:VOL"]);
  });

  it("「换」一步关掉旧的、把新的画在最后一条上", async () => {
    seedSession("0700.HK", "1D");
    await mountChart();
    await openPicker();

    fireEvent.click(buttonOf("更换副图 VOL"));
    await settle();
    // Armed: the catalogue now replaces instead of appending, so even a full
    // pane set can be edited without closing anything first.
    expect(screen.getByText(/替换「成交量」为/)).toBeTruthy();

    fireEvent.click(buttonOf("副图指标 KDJ"));
    await settle();
    // Not `sub:VOL` running KDJ — the id is derived from the indicator so a
    // drawing parked on a closed strip cannot end up labelled with the wrong
    // owner (⑲). The new strip therefore lands at the end.
    expect(subPaneNames()).toEqual(["MACD", "KDJ"]);
    expect(h.indicators.filter((i) => i.op === "create" && i.name === "KDJ").at(-1)?.paneId).toBe("sub:KDJ");
    expect(savedSets().kline).toEqual(["MACD", "KDJ"]);
  });

  it("取消「换」之后，同一个点击变回追加", async () => {
    seedSession("0700.HK", "1D");
    await mountChart();
    await openPicker();

    fireEvent.click(buttonOf("更换副图 MACD"));
    await settle();
    fireEvent.click(buttonOf("取消替换"));
    await settle();
    fireEvent.click(buttonOf("副图指标 WR"));
    await settle();
    expect(subPaneNames()).toEqual(["VOL", "MACD", "WR"]);
  });

  it("恢复默认 只重置当前视图的那一套", async () => {
    seedSession("0700.HK", "1D");
    await mountChart();
    await openPicker();
    fireEvent.click(buttonOf("副图指标 RSI"));
    await settle();
    fireEvent.click(buttonOf("副图指标 BIAS"));
    await settle();
    expect(subPaneNames()).toEqual(["VOL", "MACD", "RSI", "BIAS"]);

    fireEvent.click(buttonOf("恢复默认副图"));
    await settle();
    expect(subPaneNames()).toEqual(["VOL", "MACD"]);
    // The 分时 list was never the one being edited.
    expect(savedSets()).toEqual({ kline: ["VOL", "MACD"], timeShare: ["VOL"] });
  });

  it("关掉全部副图，剩下的高度回到主图", async () => {
    seedSession("0700.HK", "1D");
    await mountChart();
    await openPicker();
    fireEvent.click(buttonOf("关闭副图 VOL"));
    await settle();
    fireEvent.click(buttonOf("关闭副图 MACD"));
    await settle();

    expect(subPaneNames()).toEqual([]);
    // An emptied list is a choice, so it must persist as `[]` and not fall back.
    expect(savedSets()).toEqual({ kline: [], timeShare: ["VOL"] });
    // The strips are gone from the chart — the only way the main chart gets their
    // height back, since `ChartImp._layout` hands candle_pane the remainder.
    expect(h.panes.map((p) => p.id)).toEqual(["candle_pane"]);
    // And the redistribution that led there is real: one 360px host gives two sub
    // panes 75px each and a lone one 120px (`subMaxPx`). A page that left a
    // closed strip on the chart would stop at the first number.
    expect(h.paneCalls.filter((c) => c.id === "sub:MACD").map((c) => c.height)).toEqual([75, 120]);
  });

  it("副图挂到上限之后，目录不再给加", async () => {
    seedSession("0700.HK", "1D");
    await mountChart();
    await openPicker();
    for (const name of ["RSI", "KDJ", "WR", "BIAS"]) {
      fireEvent.click(buttonOf(`副图指标 ${name}`));
      await settle();
    }
    expect(subPaneNames()).toHaveLength(6);
    expect(screen.getByText(/6\/6 个副图/)).toBeTruthy();
    expect(buttonOf("副图指标 CCI").disabled).toBe(true);
    // 换 is still available at the cap: it frees a strip in the same click.
    fireEvent.click(buttonOf("更换副图 BIAS"));
    await settle();
    expect(buttonOf("副图指标 CCI").disabled).toBe(false);
    fireEvent.click(buttonOf("副图指标 CCI"));
    await settle();
    expect(subPaneNames()).toEqual(["VOL", "MACD", "RSI", "KDJ", "WR", "CCI"]);
  });

  it("换副图不吃用户的脚本，脚本也能从这一排开关", async () => {
    seedScript("a1", true);
    seedSession("0700.HK", "1D");
    await mountChart();
    // The workbench mounts its own panes after the first bars arrive.
    expect(subPaneNames()).toEqual(["VOL", "MACD", "UCI_a1"]);

    fireEvent.click(buttonOf("分时"));
    await settle();
    // MACD closed, VOL kept, the script untouched — and it is still a sub pane
    // the picker never lists, because it is not a built-in name.
    expect(subPaneNames()).toEqual(["VOL", "UCI_a1"]);

    fireEvent.click(buttonOf("分时"));
    await settle();
    // MACD comes back, but at the end — closing a strip releases its address and
    // re-opening it appends, the same cost `withReplaced` pays for the same
    // reason. What matters here is that `UCI_a1` was never touched.
    expect(subPaneNames()).toEqual(["VOL", "UCI_a1", "MACD"]);

    await openPicker();
    expect(screen.queryByText(/当前没有副图/)).toBeNull();
    fireEvent.click(buttonOf("自定义脚本 脚本a1"));
    await settle();
    expect(subPaneNames()).toEqual(["VOL", "MACD"]);
    // The switch itself has to say so, or the row reads as a script still on the
    // chart that merely failed to draw.
    expect(buttonOf("自定义脚本 脚本a1").textContent).toContain("· 关");
    // The built-in list was never edited, so it stays unwritten — the toggle
    // must not bank a pane set it only looked at.
    expect(localStorage.getItem(SUB_SETS_KEY)).toBeNull();
    // The switch flipped in storage too, or the pane would reappear on reload.
    expect(JSON.parse(localStorage.getItem(USER_IND_KEY) ?? "[]")[0].enabled).toBe(false);
  });

  it("分时 自己那一套副图与 K 线各记各的", async () => {
    seedSession("0700.HK", "1m", true);
    await mountChart();
    await openPicker();
    fireEvent.click(buttonOf("副图指标 MACD"));
    await settle();
    expect(subPaneNames()).toEqual(["VOL", "MACD"]);
    expect(savedSets()).toEqual({ kline: ["VOL", "MACD"], timeShare: ["VOL", "MACD"] });

    fireEvent.click(buttonOf("分时"));
    await settle();
    expect(subPaneNames()).toEqual(["VOL", "MACD"]);
    // …and the candles answer to their own list, which happens to agree here —
    // the point is the click landed on the 分时 set, not on both.
    expect(savedSets().kline).toEqual(["VOL", "MACD"]);
  });

  it("副图数量进了工具条的按钮，面板关掉也说得清", async () => {
    seedSession("0700.HK", "1D");
    await mountChart();
    expect(screen.getByRole("button", { name: "副图指标" }).textContent).toBe("副图指标 · 2");
    await openPicker();
    fireEvent.click(buttonOf("关闭副图 VOL"));
    await settle();
    fireEvent.click(buttonOf("关闭副图 MACD"));
    await settle();
    expect(screen.getByRole("button", { name: "副图指标" }).textContent).toBe("副图指标 · 0");
  });
});
