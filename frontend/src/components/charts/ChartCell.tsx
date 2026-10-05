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

/**
 * One candlestick chart on one period — a cell of the /multi-chart grid.
 *
 * Deliberately far smaller than /pro-chart: no drawings, no 分时, no user
 * indicator shelf. Those are the three things that make ProChart.tsx assume
 * "one chart per page" in six places (`hostRef`, `chartRef`, `syncSubPanes`,
 * `drawingsKey`, `readSession`, the pane-height budget), and rather than fan
 * all of them out to arrays, the grid simply builds four of these and lets the
 * page own the rules about which periods may appear.
 *
 * The cell does *not* decide whether its period is servable for the symbol.
 * `intervalAllowed` is the page's question to ask once, in one place, so a cell
 * is handed a period it can only accept.
 */

/** Bars per page, same figure as /pro-chart so the two pages page back equally. */
const PAGE = 500;

export interface ChartCellProps {
  symbol: string;
  interval: IntervalKey;
  dark: boolean;
  /** Hands the live chart to the page's sync bus; `null` when the cell unmounts. */
  onChart?: (chart: Nullable<Chart>) => void;
  /** Rendered at the right of the cell's header — the page puts its period
   *  picker here rather than giving the cell a callback it would only forward,
   *  because which periods are allowed is a page-level question. */
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

export function ChartCell({ symbol, interval, dark, onChart, headerRight }: ChartCellProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<Nullable<Chart>>(null);
  const mountedRef = useRef(true);
  const darkRef = useRef(dark);
  const symbolRef = useRef(symbol);
  const intervalRef = useRef(interval);
  const onChartRef = useRef(onChart);
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
    // Before `init`, so the first tooltip of the first cell already reads
    // 60分钟 instead of 60 — same reason /pro-chart does it, see klineLocale.
    ensurePeriodUnitLabels();
    const chart = init(host, {
      locale: chartLocale(i18n.language),
      timezone: "Asia/Shanghai",
      styles: cellStyles(darkRef.current),
    });
    if (!chart) return;
    chartRef.current = chart;
    // `createIndicator` always appends (`StoreImp.addIndicator`), so this runs
    // exactly once per chart instance, not on every symbol or period change.
    chart.createIndicator({ name: "MA", paneId: MAIN_PANE_ID }, true);
    onChartRef.current?.(chart);

    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    // The cell is a grid child, so its box changes when a neighbour's period
    // dropdown opens or the window reflows — neither of which fires a window
    // resize.
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(onResize);
      observer.observe(host);
    }

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
          const list = chart.getDataList();
          const tail = list.slice(-2);
          setLast(
            tail.length === 2
              ? {
                  close: Number(tail[1].close),
                  changePct:
                    Number(tail[0].close) === 0
                      ? 0
                      : ((Number(tail[1].close) - Number(tail[0].close)) /
                          Number(tail[0].close)) *
                        100,
                }
              : null,
          );
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
    };
    chart.setDataLoader(dataLoader);

    return () => {
      mountedRef.current = false;
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
