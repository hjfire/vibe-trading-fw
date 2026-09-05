import { useEffect, useRef, useState } from "react";
import { init, dispose, type Chart, type KLineData, type DataLoader, type Nullable } from "klinecharts";
import i18n from "@/i18n";
import { useThemeDark } from "@/lib/theme-store";
import { cn } from "@/lib/utils";
import { fetchKline, periodToInterval, INTERVALS, type IntervalKey } from "@/lib/marketApi";
import { boundsOf, pagingBefore, shapeResponse } from "@/lib/klinePaging";
import { planPaneHeights, subPaneIdsOf } from "@/lib/paneLayout";
import {
  DRAW_TOOLS,
  MAIN_PANE_ID,
  cancelInProgress,
  drawHint,
  loadDrawings,
  removeLatestDrawing,
  restoreDrawings,
  saveDrawings,
  serializeDrawings,
  toolOf,
} from "@/lib/chartDrawings";
import { chartLocale } from "@/lib/klineLocale";
import WatchList from "@/components/charts/WatchList";
import IndicatorEditor from "@/components/charts/IndicatorEditor";
import { applyUserIndicator } from "@/lib/indicatorLang";
import { loadUserIndicators } from "@/lib/indicatorStore";
import { readShareLink, SHARE_QUERY_KEY } from "@/lib/scriptExchange";
import { cardToDraft, type WorkbenchSeed } from "@/components/charts/workbench/types";

/**
 * Phase-A pro chart: open-source KLineChart (Apache-2.0) wired to this project's
 * own /market/kline route, so the drawing tools + indicators run on the same
 * data the backtest layer uses — not TradingView's public servers.
 * Accessible at /pro-chart. Kept self-contained (its own route) to survive
 * daily upstream syncs with zero conflicts.
 */

const DEFAULT_SYMBOL = "600519.SH";
const PAGE = 500;
const WATCH_KEY = "pro-chart.watchlist.v1";
const SESSION_KEY = "pro-chart.session.v1";

const PRESETS = [
  { label: "贵州茅台", symbol: "600519.SH" },
  { label: "平安银行", symbol: "000001.SZ" },
  { label: "宁德时代", symbol: "300750.SZ" },
  { label: "腾讯", symbol: "0700.HK" },
  { label: "AAPL", symbol: "AAPL.US" },
  { label: "BTC/USDT", symbol: "BTC-USDT" },
];

// Drawing tools live in `chartDrawings.ts` next to the rules they depend on
// (which pane they belong to, how many clicks they need, what gets persisted).

function periodFor(interval: IntervalKey): { type: "day" | "minute"; span: number } {
  if (interval === "1D") return { type: "day", span: 1 };
  return { type: "minute", span: parseInt(interval, 10) };
}

/** Last viewed symbol + interval (local custom ⑪): the chart should reopen
 * where it was left. A stale pair is repaired, not trusted — minute bars only
 * exist for A-shares, so restoring "5M" onto AAPL would fail the first request. */
function readSession(): { symbol: string; interval: IntervalKey } {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return { symbol: DEFAULT_SYMBOL, interval: "1D" };
    const obj: unknown = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return { symbol: DEFAULT_SYMBOL, interval: "1D" };
    const { symbol, interval } = obj as { symbol?: unknown; interval?: unknown };
    const next =
      typeof symbol === "string" && symbol.trim() ? symbol.trim().toUpperCase() : DEFAULT_SYMBOL;
    const span = INTERVALS.some((i) => i.key === interval) ? (interval as IntervalKey) : "1D";
    const aShare = /\.(SH|SZ)$/.test(next);
    return { symbol: next, interval: span === "1D" || aShare ? span : "1D" };
  } catch {
    return { symbol: DEFAULT_SYMBOL, interval: "1D" };
  }
}

function chartStyles(dark: boolean) {
  // A-share convention: red = up, green = down. Candle colors live under
  // `candle.bar` in v10 (`.area` is for area/line charts).
  return {
    grid: { horizontal: { color: dark ? "#1f2733" : "#f0f0f0" }, vertical: { color: dark ? "#1f2733" : "#f0f0f0" } },
    candle: {
      type: "candle_solid" as const,
      bar: {
        upColor: "#ef5350",
        downColor: "#26a69a",
        noChangeColor: "#888888",
        upBorderColor: "#ef5350",
        downBorderColor: "#26a69a",
        noChangeBorderColor: "#888888",
        upWickColor: "#ef5350",
        downWickColor: "#26a69a",
        noChangeWickColor: "#888888",
      },
    },
    xAxis: { axisLine: { color: dark ? "#4a4a4a" : "#ccc" }, tickText: { color: dark ? "#aaa" : "#666" } },
    yAxis: { axisLine: { color: dark ? "#4a4a4a" : "#ccc" }, tickText: { color: dark ? "#aaa" : "#666" } },
  };
}

/**
 * A `?s=` share payload is captured at module scope on purpose.
 *
 * React StrictMode mounts this page twice in development: the first mount used
 * to read the query, clean the URL and then get unmounted before the decode
 * resolved, so the second mount found nothing to import and the deep link
 * failed silently — it worked in production only because there is one mount.
 * Living outside the component lets whichever mount finish the job, exactly
 * once, and a later remount (back to this page) must not re-import.
 */
function readShareQuery(): string {
  try {
    return new URLSearchParams(window.location.search).get(SHARE_QUERY_KEY) ?? "";
  } catch {
    return "";
  }
}

let pendingShare = readShareQuery();
let pendingShareTask: ReturnType<typeof readShareLink> | null = null;
let shareHandled = false;

/** Starts the decode on the first call; a second call reuses the same task. */
function takeShareTask(): ReturnType<typeof readShareLink> | null {
  if (pendingShare && !pendingShareTask) {
    const code = pendingShare;
    pendingShare = "";
    pendingShareTask = readShareLink(code).then((out) => {
      shareHandled = true;
      return out;
    });
  }
  return shareHandled ? null : pendingShareTask;
}

/** The query must not survive the load, or a refresh re-imports the script. */
function stripShareQuery(): void {
  try {
    const query = new URLSearchParams(window.location.search);
    if (!query.has(SHARE_QUERY_KEY)) return;
    query.delete(SHARE_QUERY_KEY);
    const rest = query.toString();
    window.history.replaceState(
      {},
      "",
      `${window.location.pathname}${rest ? `?${rest}` : ""}${window.location.hash}`,
    );
  } catch {
    /* no history API (jsdom): the import still lands, only the URL stays dirty */
  }
}

export function ProChart() {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<Nullable<Chart>>(null);
  const [session] = useState(readSession);
  const [symbol, setSymbol] = useState(session.symbol);
  const [input, setInput] = useState(session.symbol);
  const [interval, setInterval] = useState<IntervalKey>(session.interval);
  const [status, setStatus] = useState<{ loading: boolean; error: string | null; source: string }>({
    loading: false,
    error: null,
    source: "",
  });
  const dark = useThemeDark();
  // Indicator-formula workbench (local custom ⑩).
  const [indPanelOpen, setIndPanelOpen] = useState(false);
  const [indCount, setIndCount] = useState(() => loadUserIndicators().filter((x) => x.enabled).length);
  // Which chart instances have already had the saved indicators replayed.
  // Per-instance on purpose: React StrictMode mounts this effect twice in dev,
  // and a single boolean would be consumed by the first (already disposed)
  // chart, leaving the live chart blank of user indicators (e2e 2026-09-04).
  const restoredChartsRef = useRef<WeakSet<Chart>>(new WeakSet());
  // Restore-time formula failures, kept in their own state: the backward page
  // load KLineChart fires right after startup resets status.error and would
  // swallow the message within a second (e2e 2026-09-04).
  const [formulaError, setFormulaError] = useState<string | null>(null);
  // A script handed over by a share link (local custom ⑪); the workbench
  // opens with it loaded into the editor, never mounted unseen.
  const [scriptSeed, setScriptSeed] = useState<WorkbenchSeed | null>(null);
  // Drawing (local custom ⑭): which tool is armed, and how many finished
  // drawings the chart holds. The count drives the undo/clear buttons and the
  // "画线已随标的保存" note, so it must be read back from the chart rather than
  // trusted from the click handler (the user can also delete a line with the
  // right-click menu).
  const [drawTool, setDrawTool] = useState<string | null>(null);
  const [drawCount, setDrawCount] = useState(0);
  // Which `symbol|interval` the on-chart drawings belong to; a change means the
  // set has to be swapped for that chart's own.
  const drawingsKeyRef = useRef<string>("");
  const refreshDrawCount = (chart: Chart) => setDrawCount(chart.getOverlays().filter((o) => !(o as { isDrawing?: () => boolean }).isDrawing?.()).length);
  // Bumps on every workbench notification, so the pane rebudget below re-runs
  // even when the enabled count is unchanged (swapping one custom indicator for
  // another keeps the number but moves the panes around).
  const [layoutTick, setLayoutTick] = useState(0);
  const refreshIndCount = () => {
    setIndCount(loadUserIndicators().filter((x) => x.enabled).length);
    setLayoutTick((t) => t + 1);
  };
  // Both entry points behave the same: the banner is a restore-time notice,
  // and once the workbench is open each row reports its own state there.
  const openFormulaPanel = () => {
    setFormulaError(null);
    setIndPanelOpen(true);
  };
  // Minute bars are served only for .SH/.SZ A-shares (see market_routes.py);
  // greying out the buttons for other symbols avoids a guaranteed 400.
  const canMinute = /\.(SH|SZ)$/.test(symbol);

  // Watchlist (step ②): persisted in localStorage, defaults to the presets.
  const [watch, setWatch] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(WATCH_KEY);
      if (raw) {
        const arr: unknown = JSON.parse(raw);
        if (Array.isArray(arr)) {
          return arr.filter((x): x is string => typeof x === "string" && x.length > 0);
        }
      }
    } catch {
      /* corrupted storage -> fall back to defaults */
    }
    return PRESETS.map((p) => p.symbol);
  });
  useEffect(() => {
    try {
      localStorage.setItem(WATCH_KEY, JSON.stringify(watch));
    } catch {
      /* quota errors are non-fatal for a convenience list */
    }
  }, [watch]);

  // Remember where the chart was left (local custom ⑪).
  useEffect(() => {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ symbol, interval }));
    } catch {
      /* quota errors are non-fatal for a convenience feature */
    }
  }, [symbol, interval]);

  /**
   * Size the sub panes so the main chart keeps a usable height (⑬→⑭).
   *
   * The library gives every non-main pane its fixed `height` (default 100) and
   * hands the *remainder* to candle_pane, so each indicator added used to cost
   * the price chart a flat 100px — with VOL + MACD + two saved custom
   * indicators on a 360px chart the main chart measured **29px**, and a click
   * aimed at a candle landed on the volume pane (the drawing was then stored at
   * a volume-axis value and became invisible). `planPaneHeights` mirrors the
   * library's own arithmetic; see `paneLayout.ts` for the source lines.
   */
  const applyPaneLayout = (chart: Chart) => {
    const chartHeight = hostRef.current?.clientHeight ?? 0;
    if (chartHeight <= 0) return; // jsdom / detached host: nothing to budget
    const options = chart.getPaneOptions();
    const list = Array.isArray(options) ? options : [];
    // A pane the user maximized owns the whole chart on purpose; rebudgeting it
    // would fight the gesture (the library only honours `height` for `normal`).
    const normal = list.filter((p) => (p.state ?? "normal") === "normal");
    const plan = planPaneHeights({ chartHeight, subPaneIds: subPaneIdsOf(normal) });
    for (const pane of normal) {
      const want = plan.assignments[pane.id];
      if (want === undefined) continue;
      // Skip near-equal values: `setPaneOptions` relayouts, the relayout is what
      // the ResizeObserver reports, and without this guard the two ping-pong.
      if (Math.abs((pane.height ?? 0) - want) < 2) continue;
      chart.setPaneOptions({ id: pane.id, height: want });
    }
  };

  // Create/destroy the chart once per mount.
  useEffect(() => {
    if (!hostRef.current) return;
    const chart = init(hostRef.current, {
      // Must be a tag KLineChart ships: an unknown one makes its tooltip throw
      // on every redraw (see `chartLocale`).
      locale: chartLocale(i18n.language),
      timezone: "Asia/Shanghai",
      styles: chartStyles(dark),
    });
    if (!chart) return;
    chartRef.current = chart;

    const dataLoader: DataLoader = {
      getBars: async ({ type, timestamp, period, callback }) => {
        const iv = periodToInterval(period);
        // `type` is not a scroll direction, and reading it as one broke panning:
        // in KLineChart v10 `forward` asks for OLDER bars (the library prepends
        // them) and `backward` asks for NEWER ones (it appends them *and shifts
        // the view by the length it got`). Answering a `backward` with older
        // data therefore re-delivered the same block forever and snapped the
        // chart back under the mouse. See `klinePaging.ts` for the source lines.
        // Timestamps flow end-to-end in milliseconds (KLineChart's unit); the
        // backend `before` filter is likewise epoch-ms — no unit conversion.
        const bounds = boundsOf(chart.getDataList());
        const before = pagingBefore(type, timestamp ?? null, bounds);
        if (type !== "backward") setStatus((s) => ({ ...s, loading: true, error: null }));
        try {
          const res = await fetchKline({ symbol: chart.getSymbol()?.ticker ?? symbol, interval: iv, count: PAGE, before });
          const page = shapeResponse(type, res.bars as KLineData[], bounds, PAGE);
          const bars = page.bars;
          callback(bars, page.more);
          setStatus({ loading: false, error: null, source: res.source });
          // Re-mount persisted user indicators once real data exists (their
          // formulas trial-compute against the current bars on apply).
          if (
            chartRef.current === chart &&
            bars.length > 0 &&
            !restoredChartsRef.current.has(chart)
          ) {
            restoredChartsRef.current.add(chart);
            const problems: string[] = [];
            for (const it of loadUserIndicators()) {
              if (!it.enabled) continue;
              try {
                const err = applyUserIndicator(chart, it);
                if (err) problems.push(`「${it.label}」${err}`);
              } catch (e) {
                problems.push(`「${it.label}」${e instanceof Error ? e.message : String(e)}`);
              }
            }
            // A saved formula that no longer computes must not fail silently.
            setFormulaError(problems.length > 0 ? problems.join("；") : null);
            // New panes just appeared; re-budget before they eat the main chart.
            applyPaneLayout(chart);
          }
          // Drawings belong to a chart, not to a page view (⑭): when the loaded
          // symbol/period changes, bank the old set and put the new one up.
          const ticker = chart.getSymbol()?.ticker ?? symbol;
          const key = `${ticker}|${iv}`;
          if (bars.length > 0 && drawingsKeyRef.current !== key) {
            const prev = drawingsKeyRef.current;
            if (prev) {
              const [ps, pi] = prev.split("|");
              saveDrawings(ps, pi, serializeDrawings(chart.getOverlays()));
            }
            chart.removeOverlay();
            restoreDrawings(chart, loadDrawings(ticker, iv));
            drawingsKeyRef.current = key;
            refreshDrawCount(chart);
          }
        } catch (e) {
          callback([], false);
          setStatus({ loading: false, error: e instanceof Error ? e.message : String(e), source: "" });
        }
      },
    };
    chart.setDataLoader(dataLoader);
    chart.setSymbol({ ticker: symbol, pricePrecision: 2, volumePrecision: 0 });
    chart.setPeriod(periodFor(interval));
    chart.createIndicator({ name: "MA", paneId: "candle_pane" }, true);
    chart.createIndicator({ name: "VOL" });
    chart.createIndicator({ name: "MACD" });
    applyPaneLayout(chart);

    const onResize = () => {
      chart.resize();
      applyPaneLayout(chart);
    };
    window.addEventListener("resize", onResize);
    // The host is a `flex-1` box, so its height changes without a window resize
    // (side panel opening, workbench toggling) — watch the element itself.
    let observer: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined" && hostRef.current) {
      observer = new ResizeObserver(onResize);
      observer.observe(hostRef.current);
    }
    return () => {
      window.removeEventListener("resize", onResize);
      observer?.disconnect();
      // Bank the drawings made since the last swap, then let the chart go.
      const key = drawingsKeyRef.current;
      if (key) {
        const [ps, pi] = key.split("|");
        saveDrawings(ps, pi, serializeDrawings(chart.getOverlays()));
      }
      dispose(chart);
      chartRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Theme switch → restyle in place.
  useEffect(() => {
    chartRef.current?.setStyles(chartStyles(dark));
  }, [dark]);

  // TradingView shares by URL, so `?s=` opens the workbench with the script
  // decoded into the editor (see `takeShareTask` for the double-mount catch).
  useEffect(() => {
    const task = takeShareTask();
    stripShareQuery();
    if (!task) return;
    let alive = true;
    void task.then((out) => {
      if (!alive) return;
      if (!out.ok) {
        setFormulaError(`分享链接无效：${out.error}`);
        return;
      }
      setScriptSeed({ draft: cardToDraft(out.card), tab: "editor" });
      setIndPanelOpen(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const applySymbol = (s: string) => {
    setInput(s);
    setSymbol(s);
    const chart = chartRef.current;
    // Minute bars only exist for A-shares: repair the period *before* setSymbol
    // fires its reload, or the first request after the switch is a guaranteed 400.
    const next = interval !== "1D" && !/\.(SH|SZ)$/.test(s) ? "1D" : interval;
    if (next !== interval) {
      setInterval(next);
      chart?.setPeriod(periodFor(next));
    }
    chart?.setSymbol({ ticker: s, pricePrecision: 2, volumePrecision: 0 });
  };

  const loadSymbol = () => {
    const s = input.trim().toUpperCase();
    if (!s) return;
    applySymbol(s);
  };

  const addToWatch = () => {
    if (!watch.includes(symbol)) setWatch([...watch, symbol]);
  };

  const pickInterval = (iv: IntervalKey) => {
    if (iv !== "1D" && !/\.(SH|SZ)$/.test(symbol)) return; // guarded, button also disabled
    setInterval(iv);
    chartRef.current?.setPeriod(periodFor(iv));
  };

  // Panes come and go from the workbench without any chart event to hook, so
  // rebudget the layout whenever the enabled-indicator set changes.
  useEffect(() => {
    const chart = chartRef.current;
    if (chart) applyPaneLayout(chart);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indCount, layoutTick]);

  const syncDrawings = (chart: Chart) => {
    const key = drawingsKeyRef.current || `${symbol}|${interval}`;
    const [s, i] = key.split("|");
    saveDrawings(s, i, serializeDrawings(chart.getOverlays()));
    refreshDrawCount(chart);
  };

  /**
   * Arm a draw tool. The button doubles as the exit: clicking the armed tool
   * again (or Esc) drops the half-drawn overlay instead of leaving the chart
   * swallowing clicks waiting for a second point.
   */
  const armTool = (name: string) => {
    const chart = chartRef.current;
    if (!chart) return;
    if (drawTool === name) {
      setDrawTool(null);
      cancelInProgress(chart);
      return;
    }
    cancelInProgress(chart);
    setDrawTool(name);
    chart.createOverlay({
      name,
      paneId: MAIN_PANE_ID,
      // The highlight follows the chart, not the click: it clears when the
      // drawing is finished, wherever that happens.
      onDrawEnd: () => {
        setDrawTool(null);
        syncDrawings(chart);
      },
    });
  };

  const undoDraw = () => {
    const chart = chartRef.current;
    if (!chart) return;
    cancelInProgress(chart);
    if (removeLatestDrawing(chart)) syncDrawings(chart);
    setDrawTool(null);
  };

  const clearDraw = () => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.removeOverlay();
    setDrawTool(null);
    syncDrawings(chart);
  };

  const armedTool = toolOf(drawTool ?? "");

  // Esc abandons the tool in hand. The half-drawn overlay has to go with the
  // highlight, or the chart keeps eating clicks waiting for the next point.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const chart = chartRef.current;
      if (chart) cancelInProgress(chart);
      setDrawTool(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="flex h-[calc(100vh-0px)] flex-col gap-3 p-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="text-lg font-semibold">专业图表 · KLineChart</div>
        <input
          className="w-48 rounded-md border bg-background px-2 py-1 text-sm"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && loadSymbol()}
          placeholder="600519.SH / AAPL.US / BTC-USDT"
        />
        <button className="rounded-md border px-3 py-1 text-sm hover:bg-muted" onClick={loadSymbol}>
          加载
        </button>
        <button
          className={cn(
            "rounded-md border px-2 py-1 text-xs hover:bg-muted",
            watch.includes(symbol) && "text-primary",
          )}
          title={watch.includes(symbol) ? "已在自选列表" : "把当前标的加入自选"}
          onClick={addToWatch}
        >
          {watch.includes(symbol) ? "★ 已自选" : "☆ 加自选"}
        </button>
        <div className="flex gap-1">
          {PRESETS.map((p) => (
            <button
              key={p.symbol}
              className={cn(
                "rounded-md border px-2 py-1 text-xs hover:bg-muted",
                symbol === p.symbol && "bg-muted font-medium",
              )}
              onClick={() => applySymbol(p.symbol)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1">
          {INTERVALS.map((i) => {
            const disabled = i.key !== "1D" && !canMinute;
            return (
              <button
                key={i.key}
                disabled={disabled}
                title={disabled ? "分钟线仅支持 A股（.SH/.SZ）" : undefined}
                className={cn(
                  "rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40",
                  interval === i.key && "bg-muted font-medium",
                )}
                onClick={() => pickInterval(i.key)}
              >
                {i.label}
              </button>
            );
          })}
        </div>
        <div className="mx-2 h-5 w-px bg-border" />
        <button
          className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
          title="编写/管理自定义指标公式（保存在本地）"
          onClick={openFormulaPanel}
        >
          ƒ 指标公式{indCount > 0 ? ` · ${indCount}` : ""}
        </button>
        <span className="text-xs text-muted-foreground">画线:</span>
        <div className="flex gap-1">
          {DRAW_TOOLS.map((t) => (
            <button
              key={t.name}
              className={cn(
                "rounded-md border px-2 py-1 text-xs hover:bg-muted",
                drawTool === t.name && "bg-muted font-medium ring-1 ring-primary",
              )}
              title={drawHint(t)}
              onClick={() => armTool(t.name)}
            >
              {t.label}
            </button>
          ))}
          <button
            className="rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
            title="撤销最近一条画线"
            disabled={drawCount === 0 && drawTool === null}
            onClick={undoDraw}
          >
            撤销
          </button>
          <button
            className="rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40"
            title="清除当前标的与周期上的全部画线"
            disabled={drawCount === 0 && drawTool === null}
            onClick={clearDraw}
          >
            清除
          </button>
        </div>
        <span className="text-xs text-muted-foreground">
          {armedTool
            ? drawHint(armedTool)
            : drawCount > 0
              ? `已画 ${drawCount} 条 · 随标的与周期保存`
              : "画线随标的与周期保存"}
        </span>
        <div className="ml-auto text-xs text-muted-foreground">
          {status.loading ? "加载中…" : status.error ? <span className="text-red-500">{status.error}</span> : status.source || ""}
        </div>
      </div>

      {formulaError && (
        <div className="text-xs text-red-500">
          已保存的指标公式未能加载：{formulaError}
          <button
            type="button"
            className="ml-2 underline hover:no-underline"
            onClick={openFormulaPanel}
          >
            去修正
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1 gap-3">
        <WatchList symbols={watch} active={symbol} onPick={applySymbol} onChange={setWatch} />
        <div ref={hostRef} className="min-h-[360px] flex-1 rounded-lg border" />
      </div>
      <div className="text-xs text-muted-foreground">
        数据来自本项目自有行情链路（日线走 loader 回退链，A股分钟线走 akshare 新浪接口）；红涨绿跌。滚轮缩放、拖拽平移，上方「画线」工具栏在主图上落点，指标 MA/VOL/MACD 内置。
      </div>
      <IndicatorEditor
        open={indPanelOpen}
        onClose={() => setIndPanelOpen(false)}
        getChart={() => chartRef.current}
        onChartIndicatorsChanged={refreshIndCount}
        seed={scriptSeed}
        symbols={watch}
        onPickSymbol={applySymbol}
      />
    </div>
  );
}
