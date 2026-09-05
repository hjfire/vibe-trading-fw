import { useEffect, useRef, useState } from "react";
import { init, dispose, type Chart, type KLineData, type DataLoader, type Nullable } from "klinecharts";
import i18n from "@/i18n";
import { useThemeDark } from "@/lib/theme-store";
import { cn } from "@/lib/utils";
import { fetchKline, periodToInterval, INTERVALS, type IntervalKey } from "@/lib/marketApi";
import { boundsOf, pagingBefore, shapeResponse } from "@/lib/klinePaging";
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

// KLineChart v10 built-in overlay names exposed as one-click draw tools.
const DRAW_TOOLS: { label: string; name: string }[] = [
  { label: "趋势线", name: "segment" },
  { label: "射线", name: "rayLine" },
  { label: "水平线", name: "horizontalStraightLine" },
  { label: "斐波那契", name: "fibonacciLine" },
  { label: "价格线", name: "priceLine" },
  { label: "画笔", name: "brush" },
];

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
  const refreshIndCount = () =>
    setIndCount(loadUserIndicators().filter((x) => x.enabled).length);
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

    const onResize = () => chart.resize();
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
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

  const startDraw = (name: string) => chartRef.current?.createOverlay(name);
  const clearDraw = () => chartRef.current?.removeOverlay();

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
              className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
              onClick={() => startDraw(t.name)}
            >
              {t.label}
            </button>
          ))}
          <button className="rounded-md border px-2 py-1 text-xs hover:bg-muted" onClick={clearDraw}>
            清除
          </button>
        </div>
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
        数据来自本项目自有行情链路（日线走 loader 回退链，A股分钟线走 akshare 新浪接口）；红涨绿跌。滚轮缩放、拖拽平移、左侧工具栏画线，指标 MA/VOL/MACD 内置。
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
