import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  dispose,
  init,
  type Chart,
  type DataLoader,
  type KLineData,
  type Nullable,
} from "klinecharts";
import i18n from "@/i18n";
import {
  fetchKline,
  intervalToPeriod,
  INTERVALS,
  type IntervalKey,
} from "@/lib/marketApi";
import { boundsOf, pagingBefore, shapeResponse } from "@/lib/klinePaging";
import { CANDLE_COLORS } from "@/lib/chartPalette";
import { chartLocale, ensurePeriodUnitLabels } from "@/lib/klineLocale";
import { MAIN_PANE_ID } from "@/lib/chartDrawings";
import { planPaneHeights, subPaneIdOf } from "@/lib/paneLayout";

/**
 * One candlestick chart on one period — a cell of the /multi-chart grid.
 *
 * Deliberately far smaller than /pro-chart: no drawings, no 分时, and one sub
 * pane rather than a pane set. Those are the three things that make ProChart.tsx
 * assume "one chart per page" in six places (`hostRef`, `chartRef`,
 * `syncSubPanes`, `drawingsKey`, `readSession`, the pane-height budget), and
 * rather than fan all of them out to arrays, the grid simply builds four of
 * these and lets the page own the rules about which periods and which
 * indicators a cell may show.
 *
 * The cell does *not* decide whether its period is servable for the symbol.
 * `intervalAllowed` is the page's question to ask once, in one place, so a cell
 * is handed a period it can only accept.
 *
 * Two things it does own, because only it holds a chart:
 *
 * * the live tail. v10 has no `updateData` — `grep -c updateData dist/index.esm.js`
 *   is 0 — and the only supported push door is `DataLoader.subscribeBar`, which
 *   `StoreImp._processDataLoad` (dist 13613-13626) asks for after every `init`
 *   page lands. What comes back goes through `_addData`'s single-bar branch
 *   (13480-13502), so a live read can only ever *patch or append* the newest
 *   bar: older is dropped without a word. That is also why this is not a
 *   lookahead problem — the grid shows bars, not signals, and it never rewrites
 *   a bar the feed no longer reports.
 * * the height its one strip costs the candles. A pane charges the flexible
 *   candle pane a flat `layoutOptions.pane.height` (100px, and `createIndicator`
 *   builds a missing pane from it at dist 15277-15281), which is how the single
 *   chart page once ended up with a 29px candle chart. `planPaneHeights` is
 *   already the repo's answer; the cell reads its own chart's container height
 *   — `getDom()`, the node the library measures and observes (dist 14680, 14689)
 *   — because that is the box the layout is done against.
 */

/** Bars per page, same figure as /pro-chart so the two pages page back equally. */
const PAGE = 500;

/** How often a cell re-reads its newest bar. 5s is the figure the UDF datafeed
 *  already ships for "live updates without a push channel" (`udfDatafeed.ts`),
 *  so the grid asks the same questions at the same rate as the rest of the app. */
export const LIVE_POLL_MS = 5_000;

/** The live read takes the newest bar *and* the one before it, so the cell's
 *  header can still print a change percentage without a second request. */
const LIVE_TAIL = 2;

/** Everything `_addData` compares when it decides a bar is the same bar. */
function sameBar(a: KLineData, b: KLineData): boolean {
  return (
    a.timestamp === b.timestamp &&
    a.open === b.open &&
    a.high === b.high &&
    a.low === b.low &&
    a.close === b.close &&
    a.volume === b.volume
  );
}

export interface ChartCellProps {
  symbol: string;
  interval: IntervalKey;
  dark: boolean;
  /** The sub-indicator strip this cell shows, or `null` for none (local custom
   *  ㉛'s shape, narrowed to one pane per cell — the grid is four charts tall, so
   *  a pane *set* here would spend height the candles need). Chosen by the page,
   *  which owns what persists; applied here, which owns the chart. */
  subName?: string | null;
  /** Hands the live chart to the page's sync bus; `null` when the cell unmounts. */
  onChart?: (chart: Nullable<Chart>) => void;
  /** Rendered at the right of the cell's header — the page puts its pickers
   *  here rather than giving the cell a callback it would only forward, because
   *  which periods are allowed and which indicators are on the shelf are
   *  page-level questions. */
  headerRight?: ReactNode;
}

interface CellStatus {
  loading: boolean;
  error: string | null;
  source: string | null;
}

function cellStyles(dark: boolean) {
  return {
    grid: {
      horizontal: { color: dark ? "#1f2733" : "#f0f0f0" },
      vertical: { color: dark ? "#1f2733" : "#f0f0f0" },
    },
    candle: {
      type: "candle_solid" as const,
      bar: {
        upColor: CANDLE_COLORS.up,
        downColor: CANDLE_COLORS.down,
        noChangeColor: CANDLE_COLORS.noChange,
        upBorderColor: CANDLE_COLORS.up,
        downBorderColor: CANDLE_COLORS.down,
        noChangeBorderColor: CANDLE_COLORS.noChange,
        upWickColor: CANDLE_COLORS.up,
        downWickColor: CANDLE_COLORS.down,
        noChangeWickColor: CANDLE_COLORS.noChange,
      },
      // Four charts make four legends, four price axes and four crosshair
      // bubbles out of what one chart spells once; the strips are what the grid
      // cannot afford.
      tooltip: { showRule: "none" as const },
    },
    xAxis: {
      axisLine: { color: dark ? "#4a4a4a" : "#ccc" },
      tickText: { color: dark ? "#aaa" : "#666", size: 10 },
    },
    yAxis: {
      axisLine: { color: dark ? "#4a4a4a" : "#ccc" },
      tickText: { color: dark ? "#aaa" : "#666", size: 10 },
      inside: true,
    },
    crosshair: {
      horizontal: { show: false },
      vertical: { show: true, line: { size: 1, style: "dashed" as const } },
    },
    separator: { size: 1, color: dark ? "#4a4a4a" : "#ccc", activeBackgroundColor: "transparent" },
  };
}

export function ChartCell({ symbol, interval, dark, subName, onChart, headerRight }: ChartCellProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<Nullable<Chart>>(null);
  const mountedRef = useRef(true);
  const darkRef = useRef(dark);
  const symbolRef = useRef(symbol);
  const intervalRef = useRef(interval);
  const onChartRef = useRef(onChart);
  /** The one strip this cell owns, and the chart it was built on. The chart is
   *  part of the identity rather than a detail: React's StrictMode double mount
   *  hands the cell a brand-new chart whose panes are back at the library's
   *  defaults, and a ref keyed on the indicator name alone would still remember
   *  the strip as applied. */
  const subRef = useRef<{ chart: Chart; name: string; paneId: string } | null>(null);
  const [status, setStatus] = useState<CellStatus>({
    loading: true,
    error: null,
    source: null,
  });
  const [last, setLast] = useState<{ close: number; changePct: number } | null>(null);

  darkRef.current = dark;
  symbolRef.current = symbol;
  intervalRef.current = interval;
  onChartRef.current = onChart;

  /**
   * Give the strip the height the budget says, and no more (local custom ⑭).
   *
   * The cell measures `chart.getDom()` rather than its own host div: that is the
   * node the library sizes itself against (dist 14680-14681) and observes
   * (14689), so it is the number the layout arithmetic is actually about.
   */
  const applyStripLayout = (chart: Chart) => {
    const strip = subRef.current;
    if (!strip || strip.chart !== chart) return;
    const chartHeight = chart.getDom()?.clientHeight ?? 0;
    if (chartHeight <= 0) return; // detached / jsdom host: nothing to budget
    // The list form rather than `getPaneOptions(id)`: that overload's declared
    // return is `Nullable<PaneOptions> | PaneOptions[]`, so the height reads off
    // this one need no cast. Same reason /pro-chart reads the list.
    const options = chart.getPaneOptions();
    const pane = (Array.isArray(options) ? options : []).find((p) => p.id === strip.paneId);
    if (!pane) return;
    const want = planPaneHeights({ chartHeight, subPaneIds: [strip.paneId] }).assignments[
      strip.paneId
    ];
    if (want === undefined) return;
    // Skip near-equal values: `setPaneOptions` relayouts, the relayout is what
    // the library's own ResizeObserver reports, and without this guard the two
    // ping-pong forever (same reason /pro-chart has it).
    if (Math.abs((pane.height ?? 0) - want) < 2) return;
    chart.setPaneOptions({ id: strip.paneId, height: want });
  };

  /**
   * Put the cell's chart into the one strip the page asked for (or out of it).
   *
   * Remove-then-create, because `createIndicator` always appends: picking KDJ
   * over VOL would otherwise leave two strips and their height charges, and the
   * pane VOL lived on cannot be left behind — `removeIndicator` destroys a pane
   * once its last indicator leaves (dist 15328-15347), which is what keeps the
   * candle chart from paying for an empty 100px strip.
   *
   * Only `sub:` panes are ever touched, so the cell cannot reach the main-pane
   * MA it mounts itself (or, on /pro-chart, anything else sharing a chart).
   */
  const syncStrip = (chart: Chart, name: string | null | undefined) => {
    const paneId = name ? subPaneIdOf(name) : null;
    const current = subRef.current?.chart === chart ? subRef.current : null;
    if (current?.paneId === paneId) {
      // Same strip: re-fit rather than re-create. Re-creating would stack a
      // second copy of the indicator on the pane it is already on.
      applyStripLayout(chart);
      return;
    }
    if (current) chart.removeIndicator({ paneId: current.paneId });
    subRef.current = paneId !== null && name ? { chart, name, paneId } : null;
    if (paneId !== null && name) chart.createIndicator({ name, paneId });
    applyStripLayout(chart);
  };

  // Create and destroy once per mount. The period and symbol arrive afterwards
  // through the effects below, which is what makes switching a cell's period a
  // data reload rather than a chart rebuild.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    // Re-armed on every mount: React StrictMode runs this effect twice in
    // development, and a cleanup that only ever sets the flag false would leave
    // the surviving chart unable to report loading, error or last price.
    mountedRef.current = true;
    // A fresh chart has no strips on it, whatever the previous one had.
    subRef.current = null;
    // Before `init`, so the first tooltip of the first cell already reads
    // 60分钟 instead of 60 — same reason /pro-chart does it, see klineLocale.
    ensurePeriodUnitLabels();
    const chart = init(host, {
      locale: chartLocale(i18n.language),
      timezone: "Asia/Shanghai",
      styles: cellStyles(darkRef.current),
    });
    if (!chart) return;
    // This effect's own liveness, deliberately *not* `mountedRef`. The component
    // stays mounted across React's development double mount, so by the time a
    // superseded chart's first page arrives `mountedRef.current` is true again —
    // and `subscribeBar` is called when the response lands, which can be after the
    // cleanup already ran. Measured in the browser 2026-10-11: navigating away
    // mid-load left polls running every five seconds for the rest of the session,
    // because the arming site outlived the chart it was armed for and the cleanup's
    // `stopLive()` had nothing to clear yet.
    let alive = true;
    chartRef.current = chart;
    // `createIndicator` always appends (`StoreImp.addIndicator`), so this runs
    // exactly once per chart instance, not on every symbol or period change.
    chart.createIndicator({ name: "MA", paneId: MAIN_PANE_ID }, true);
    onChartRef.current?.(chart);

    const onResize = () => {
      chart.resize();
      applyStripLayout(chart);
    };
    window.addEventListener("resize", onResize);
    // The cell is a grid child, so its box changes when a neighbour's period
    // dropdown opens or the window reflows — neither of which fires a window
    // resize.
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(onResize);
      observer.observe(host);
    }

    /**
     * The live channel's two pieces of state, and why neither is a stack.
     *
     * `subscribeBar` fires once per `init` landing, so the symbol+period double
     * write a repair performs asks twice for a channel. One slot — the second
     * subscription replaces the first — is what keeps a stale poll from pushing
     * the outgoing period's tail into a list the store just reset.
     *
     * `liveGen` is the stale-response guard: a poll reads `intervalRef` when it
     * asks and can land after the cell has moved on, and neither the interval
     * (which the *next* channel reuses) nor `mountedRef` (which stays true) sees
     * that. Bumping the generation on every teardown makes the in-flight one
     * belong to a channel that no longer exists.
     */
    let liveTimer: ReturnType<typeof setInterval> | null = null;
    let livePush: ((bar: KLineData) => void) | null = null;
    let liveGen = 0;

    const stopLive = () => {
      liveGen += 1;
      livePush = null;
      if (liveTimer !== null) {
        clearInterval(liveTimer);
        liveTimer = null;
      }
    };

    const syncHeader = () => {
      const tail = chart.getDataList().slice(-2);
      setLast(
        tail.length === 2
          ? {
              close: Number(tail[1].close),
              changePct:
                Number(tail[0].close) === 0
                  ? 0
                  : ((Number(tail[1].close) - Number(tail[0].close)) / Number(tail[0].close)) *
                    100,
            }
          : null,
      );
    };

    const pollLive = async () => {
      const gen = liveGen;
      const iv = intervalRef.current;
      const ticker = symbolRef.current;
      try {
        const res = await fetchKline({ symbol: ticker, interval: iv, count: LIVE_TAIL });
        // Drop a response whose channel is gone, or whose pair has moved on: the
        // store would accept an older tail as an append, and a chart would gain a
        // bar no screen can account for. `livePush` is already null for a retired
        // cell (`stopLive` in the cleanup), so this needs no liveness clause of its
        // own — measured: adding one changes nothing any test can see.
        if (gen !== liveGen || !livePush) return;
        const bars = res.bars as KLineData[];
        const tail = bars[bars.length - 1];
        if (!tail) return;
        const held = chart.getDataList();
        const lastHeld = held[held.length - 1];
        // Nothing moved: writing an identical bar would still replace it and
        // re-run every mounted indicator's calculation (dist 13505-13512), which
        // on a closed market is four charts recomputing for nothing, forever.
        if (lastHeld && sameBar(lastHeld, tail)) return;
        livePush(tail);
        syncHeader();
        // A live read that landed is the cell's most recent word on this feed: a
        // 「取数失败」 left up from the page load would be reporting a state the
        // chart is no longer in.
        setStatus((s) => ({ ...s, loading: false, error: null, source: res.source }));
      } catch {
        // A failed poll is not an event the cell reports. The bars already on
        // screen are still the last good read, the error overlay is the *page*
        // load's answer, and the next tick asks again.
      }
    };

    const dataLoader: DataLoader = {
      getBars: async ({ type, timestamp, callback }) => {
        // Answer what the page *intends*, not what the store handed in. A symbol
        // switch that also repairs a cell writes two resets in one commit, and the
        // first request still carries the outgoing period; asking for the current
        // pair makes both responses correct instead of letting a stale one land on
        // a chart that has moved on.
        const iv = intervalRef.current;
        const ticker = symbolRef.current;
        // `forward` = older bars, `backward` = newer ones. The names read the
        // other way; see klinePaging.ts for the library lines that prove it.
        const bounds = boundsOf(chart.getDataList());
        const before = pagingBefore(type, timestamp ?? null, bounds);
        if (type !== "backward" && mountedRef.current) {
          setStatus((s) => ({ ...s, loading: true, error: null }));
        }
        try {
          const res = await fetchKline({ symbol: ticker, interval: iv, count: PAGE, before });
          const page = shapeResponse(type, res.bars as KLineData[], bounds, PAGE);
          callback(page.bars, page.more);
          if (!mountedRef.current) return;
          syncHeader();
          setStatus({ loading: false, error: null, source: res.source });
        } catch (e) {
          // Stop the flag, or the library keeps asking for the page that failed
          // and the cell spins forever behind a message nobody can read.
          callback([], { forward: false, backward: false });
          if (mountedRef.current) {
            setStatus({
              loading: false,
              error: e instanceof Error ? e.message : String(e),
              source: null,
            });
          }
        }
      },
      /**
       * The live tail. `_processDataLoad` calls this right after an `init` page
       * lands (dist 13613-13626), handing over the callback that writes into the
       * store — so this is not a poll the cell may skip, it is the door the
       * library is already knocking on.
       *
       * No first read: the page that just landed *is* the freshest data there is,
       * so arming the interval and waiting a whole period costs four requests per
       * grid that would return bars the charts already hold.
       */
      subscribeBar: ({ callback }) => {
        stopLive();
        // A channel handed to a chart that has already been torn down is refused
        // here, at the arming site: nothing that runs later owns this timer, so a
        // poll armed for a dead chart can never be cleared.
        if (!alive) return;
        livePush = callback;
        liveTimer = setInterval(pollLive, LIVE_POLL_MS);
      },
      /** `StoreImp.resetData` closes the channel before it swaps the symbol or the
       *  period (13652 → 13643), so the tail of the outgoing pair can never be
       *  appended to the list the store is about to rebuild. */
      unsubscribeBar: () => {
        stopLive();
      },
    };
    chart.setDataLoader(dataLoader);

    return () => {
      mountedRef.current = false;
      alive = false;
      // `dispose()` does *not* close the live channel — only `resetData` calls
      // `unsubscribeBar` — so this is the only thing between a navigated-away
      // grid and a timer writing into a destroyed chart for the rest of the
      // session (dist 13641-13657, 15806-15815).
      stopLive();
      window.removeEventListener("resize", onResize);
      observer?.disconnect();
      onChartRef.current?.(null);
      dispose(chart);
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    chartRef.current?.setStyles(cellStyles(dark));
  }, [dark]);

  // The page owns which strip this cell shows; the cell owns putting it on the
  // chart. Runs after the mount effect above, so a restored session's strip lands
  // on a chart that already has its main-pane MA — which is the order the tests
  // read the indicator list in.
  useEffect(() => {
    const chart = chartRef.current;
    if (chart) syncStrip(chart, subName);
  }, [subName]);

  // A fresh object each time, and that is load-bearing for the retry button:
  // `ChartImp.setPeriod` / `setSymbol` compare by *reference* before reloading
  // (dist 15614, 15619), so re-arming the same period still re-fetches.
  //
  // The same reference rule is why the period write is guarded here: a symbol
  // switch arrives at this effect with the period unchanged, and an unguarded
  // `setSymbol` + `setPeriod` pair reloads twice per cell — eight requests for a
  // grid of four, on feeds where minute bars are metered per symbol per week.
  // `_processDataLoad` (dist 13607) needs *both* a symbol and a period to load
  // at all, so a fresh chart's first pass costs exactly one request anyway.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    if (chart.getSymbol()?.ticker !== symbol) chart.setSymbol({ ticker: symbol });
    const period = intervalToPeriod(interval);
    const held = chart.getPeriod();
    if (held?.type === period.type && held?.span === period.span) return;
    chart.setPeriod(period);
  }, [symbol, interval]);

  const reload = () => {
    const chart = chartRef.current;
    if (!chart) return;
    setStatus((s) => ({ ...s, loading: true, error: null }));
    chart.setPeriod(intervalToPeriod(interval));
  };

  const label = INTERVALS.find((i) => i.key === interval)?.label ?? interval;
  const up = (last?.changePct ?? 0) >= 0;

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden rounded-md border border-black/10 bg-white dark:border-white/10 dark:bg-[#12141a]">
      <div className="flex shrink-0 items-center gap-2 border-b border-black/10 px-2 py-1 text-[11px] leading-4 dark:border-white/10">
        <span className="font-semibold tabular-nums">{label}</span>
        {last !== null && (
          <span
            className="tabular-nums"
            style={{ color: up ? CANDLE_COLORS.up : CANDLE_COLORS.down }}
          >
            {last.close.toFixed(2)} {up ? "+" : ""}
            {last.changePct.toFixed(2)}%
          </span>
        )}
        <span className="ml-auto truncate text-black/45 dark:text-white/40">
          {status.error ? "取数失败" : (status.source ?? "")}
        </span>
        {headerRight}
      </div>

      <div className="relative min-h-0 flex-1">
        <div ref={hostRef} className="absolute inset-0" />
        {status.error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-white/85 text-xs dark:bg-[#12141a]/85">
            <span className="max-w-[90%] truncate text-black/60 dark:text-white/55">
              {status.error}
            </span>
            <button
              type="button"
              onClick={reload}
              className="rounded border border-black/15 px-2 py-0.5 hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
            >
              重试
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
