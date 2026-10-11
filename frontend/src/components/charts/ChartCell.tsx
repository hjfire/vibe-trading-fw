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
import {
  applyUserIndicator,
  indicatorName,
  removeUserIndicator,
  type ApplySpec,
} from "@/lib/indicatorLang";

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
 *   `StoreImp._processDataLoad` (dist 13605) asks for after every `init` page
 *   lands (arming site 13619-13626). What comes back goes through `_addData`'s
 *   single-bar branch (13482-13499), so a live read can only ever *patch or
 *   append* the newest bar: older is dropped without a word. That is also why
 *   this is not a lookahead problem — the grid shows bars, not signals, and it
 *   never rewrites a bar the feed no longer reports.
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

/** The columns that make a tail read worth writing. `_addData` matches the tail by
 *  timestamp alone (dist 13486, 13495), so this is the cell's own 「nothing moved」
 *  test: a column the feed starts sending (`udf_routes.py:452-457` →
 *  `marketApi.ts:177-184`) has to be added here too, or a bar that only changes
 *  there is never written and the header never sees it. */
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

/** What the page asked this cell to draw: one of the built-in sub indicators, or
 *  one of the workbench's saved formulas. A script is carried as the spec
 *  `applyUserIndicator` takes, because that is the same object /pro-chart hands
 *  it — one mount implementation, two pages. */
export type CellSub =
  | { kind: "builtin"; name: string }
  | { kind: "script"; script: ApplySpec };

/** What a strip *is*, as far as the cell's bookkeeping cares: the two kinds get
 *  separate keys so a built-in and a script can never look like the same request. */
function subKeyOf(sub: CellSub | null | undefined): string {
  if (!sub) return "";
  return sub.kind === "builtin" ? `b:${sub.name}` : `s:${sub.script.id}`;
}

export interface ChartCellProps {
  symbol: string;
  interval: IntervalKey;
  dark: boolean;
  /** The strip this cell shows, or `null` for none (local custom ㉛'s shape,
   *  narrowed to one pane per cell — the grid is four charts tall, so a pane
   *  *set* here would spend height the candles need). Chosen by the page, which
   *  owns what persists and what the shelf offers; applied here, which owns the
   *  chart. A script the shelf saved onto the candles (`kind: "overlay"`, or a
   *  Pine `overlay=true` header) is stacked on the bars and costs no strip. */
  sub?: CellSub | null;
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

export function ChartCell({ symbol, interval, dark, sub, onChart, headerRight }: ChartCellProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<Nullable<Chart>>(null);
  const mountedRef = useRef(true);
  const darkRef = useRef(dark);
  const symbolRef = useRef(symbol);
  const intervalRef = useRef(interval);
  const onChartRef = useRef(onChart);
  /** The page's current pick, kept fresh for the one reader that cannot take it as
   *  an argument: `syncHeader` lives inside the mount effect's `[]` closure. */
  const subPropRef = useRef<CellSub | null | undefined>(sub);
  /** The one strip this cell owns, and the chart it was built on. The chart is
   *  part of the identity rather than a detail: React's StrictMode double mount
   *  hands the cell a brand-new chart whose panes are back at the library's
   *  defaults, and a ref keyed on the indicator name alone would still remember
   *  the strip as applied. `scriptId` is what says how to take it *off* again —
   *  see `syncStrip`. */
  const subRef = useRef<{ chart: Chart; key: string; paneId: string; scriptId: string | null } | null>(
    null,
  );
  const [status, setStatus] = useState<CellStatus>({
    loading: true,
    error: null,
    source: null,
  });
  const [last, setLast] = useState<{ close: number; changePct: number } | null>(null);
  /** Why the last script the page asked for is not on the chart, or `null` when
   *  nothing is wrong. A formula that computes no numbers mounts *nothing*
   *  (`applyUserIndicator` returns the reason instead of an empty pane), so
   *  without this the cell would just look like a picker that does nothing. */
  const [subError, setSubError] = useState<string | null>(null);

  darkRef.current = dark;
  symbolRef.current = symbol;
  intervalRef.current = interval;
  onChartRef.current = onChart;
  // The mount effect's `[]` deps freeze everything it reads, so the bars-arrival
  // retry below has to reach the page's current pick through a ref that every
  // render refreshes.
  subPropRef.current = sub;

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
    // Skip a height the pane already holds. `setPaneOptions` re-measures and
    // relayouts on every write (dist 15425, 15459-15467), so re-issuing the same
    // number costs a layout for nothing — an idempotence gate, not an oscillator
    // guard: the library's ResizeObserver watches its own container (14689),
    // whose client height a pane-height write does not move, and `_scheduleResize`
    // bails whenever the cached bounding still matches (14637).
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
   * Built-ins are removed by pane address, scripts by indicator name. That is not
   * two styles for the sake of it: a script the store puts on the candles (saved
   * as `kind: "overlay"`, or a Pine script whose own `overlay=true` header wins —
   * `applyPineIndicator`) has no `sub:` pane at all, so removing the address it
   * never took would leave it drawing on the bars under a picker that says 无.
   * `removeUserIndicator` goes by name, which reaches both landing sites, and it
   * also clears the script's Pine decorations, which a pane-address removal would
   * strand. Neither removal can reach the main-pane MA: the only names this
   * function removes are a `sub:` pane's own indicator and `UCI_`-prefixed
   * scripts.
   */
  const syncStrip = (chart: Chart, sub: CellSub | null | undefined) => {
    const key = subKeyOf(sub);
    const current = subRef.current?.chart === chart ? subRef.current : null;
    if (current?.key === key) {
      // Same strip: re-fit rather than re-create. Re-creating would stack a
      // second copy of the indicator on the pane it is already on.
      applyStripLayout(chart);
      return;
    }
    // A user formula is trial-computed against `chart.getDataList()` and refused
    // when that trial yields no numbers, so asking for one before this chart's first
    // page lands would report a failure the user did not cause — every restored
    // session asks before the data arrives. The bars are read *off the chart the
    // strip is being put on*, not from a per-cell flag: React's development double
    // mount leaves the cell holding the survivor's chart while the discarded one's
    // page still lands, and a flag that page flips authorizes a formula against an
    // empty chart that then never gets retried (its own arrival is an identical
    // write). `syncHeader` runs this again when the bars really do show up. A
    // built-in needs no such wait: the library re-runs its `calc` on its own when
    // the store fills.
    if (sub?.kind === "script" && chart.getDataList().length === 0) return;
    if (current) {
      if (current.scriptId !== null) removeUserIndicator(chart, current.scriptId);
      else chart.removeIndicator({ paneId: current.paneId });
    }

    let strip: { paneId: string; scriptId: string | null } | null = null;
    let error: string | null = null;
    if (sub?.kind === "builtin") {
      const paneId = subPaneIdOf(sub.name);
      chart.createIndicator({ name: sub.name, paneId });
      strip = { paneId, scriptId: null };
    } else if (sub) {
      const failed = applyUserIndicator(chart, sub.script);
      if (failed) error = failed;
      else strip = { paneId: subPaneIdOf(indicatorName(sub.script.id)), scriptId: sub.script.id };
    }
    subRef.current = strip === null ? null : { chart, key, ...strip };
    setSubError(error);
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
      const data = chart.getDataList();
      const tail = data.slice(-2);
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
      // The bars a deferred script was waiting for. Asking again is the only way
      // that script can arrive: the pick has not changed since the attempt, so no
      // dependency of the strip effect moves, and an effect that already ran cannot
      // re-run on the strength of data appearing.
      //
      // Gated on *this effect instance's* liveness rather than `mountedRef`, for the
      // same reason `subscribeBar` is: the discarded chart of React's double mount
      // reaches here, and mounting a strip on a disposed chart would hand `subRef` an
      // address the surviving chart does not have.
      if (alive) syncStrip(chart, subPropRef.current);
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
        // re-run every mounted indicator's calculation (dist 13505-13506; with no
        // indicator mounted the library lays out synchronously instead,
        // 13508-13515), which on a closed market is four charts recomputing for
        // nothing, forever. Neither branch re-measures pane heights, so a tail
        // write can never undo the height budget above.
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
       * lands (dist 13619-13626), handing over the callback that writes into the
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
      // `dispose()` does *not* close the live channel: `resetData` (dist
      // 13652-13657) is the only caller of `_processDataUnsubscribe` (13643), and
      // neither `ChartImp.destroy` (15793-15813) nor `StoreImp.destroy`
      // (14590-14597) reaches it — so this is the only thing between a
      // navigated-away grid and a timer writing into a destroyed chart for the
      // rest of the session.
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
  //
  // Only the *pick* is a dependency. A script the page asked for before this
  // chart's first page landed defers itself inside `syncStrip`, and the bars'
  // arrival is handled by `syncHeader` — not by a second state flag here, which
  // cannot tell whose bars it was told about.
  const subKey = subKeyOf(sub);
  useEffect(() => {
    const chart = chartRef.current;
    if (chart) syncStrip(chart, sub);
  }, [subKey]);

  // A fresh object each time, and that is load-bearing for the retry button:
  // `ChartImp.setSymbol` / `setPeriod` compare by *reference* before reloading
  // (dist 15084, 15093), so re-arming the same period still re-fetches.
  //
  // The same reference rule is why the period write is guarded here: a symbol
  // switch arrives at this effect with the period unchanged, and an unguarded
  // `setSymbol` + `setPeriod` pair reloads twice per cell — eight requests for a
  // grid of four, on feeds where minute bars are metered per symbol per week.
  // `_processDataLoad` (dist 13608) needs *both* a symbol and a period to load
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
        {subError !== null && (
          <span
            className="max-w-[45%] shrink truncate text-amber-600 dark:text-amber-500"
            title={subError}
          >
            {subError}
          </span>
        )}
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
