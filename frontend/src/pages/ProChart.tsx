import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import { init, dispose, type Chart, type KLineData, type DataLoader, type Nullable } from "klinecharts";
import i18n from "@/i18n";
import { useThemeDark } from "@/lib/theme-store";
import { cn } from "@/lib/utils";
import { fetchKline, periodToInterval, INTERVALS, type IntervalKey } from "@/lib/marketApi";
import { boundsOf, pagingBefore, shapeResponse } from "@/lib/klinePaging";
import { isSubPaneId, planPaneHeights, subPaneIdOf, subPaneIdsOf } from "@/lib/paneLayout";
import {
  DRAWING_COLORS,
  DRAWING_SIZES,
  DRAW_TOOLS,
  MAIN_PANE_ID,
  applyDrawingFlags,
  applyDrawingStyle,
  cancelInProgress,
  clampDrawingsToLastBar,
  drawingsBucket,
  drawHint,
  isInProgress,
  isRestorablePaneId,
  lastBarTimestamp,
  listDrawings,
  loadDrawingStyle,
  loadDrawings,
  makeDrawingEvents,
  overlayStylesOf,
  paneIndicator,
  reanchorOverlay,
  removeLatestDrawing,
  restoreDrawings,
  saveDrawingStyle,
  saveDrawings,
  serializeDrawings,
  toolOf,
  type DrawingFlags,
  type DrawingRow,
  type DrawingStyle,
  type PaneLookup,
  type StoredDrawing,
} from "@/lib/chartDrawings";
import {
  DRAWING_SHARE_QUERY_KEY,
  createDrawingsShareLink,
  drawingsFileName,
  exportDrawingsJson,
  importDrawingsJson,
  mergeDrawings,
  readDrawingsShareLink,
} from "@/lib/drawingExchange";
import { chartLocale } from "@/lib/klineLocale";
import WatchList from "@/components/charts/WatchList";
import IndicatorEditor from "@/components/charts/IndicatorEditor";
import { applyUserIndicator, indicatorName } from "@/lib/indicatorLang";
import { loadUserIndicators } from "@/lib/indicatorStore";
import { readShareLink, SHARE_QUERY_KEY } from "@/lib/scriptExchange";
import { copyText, downloadText } from "@/components/charts/workbench/types";
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
function readQueryKey(key: string): string {
  try {
    return new URLSearchParams(window.location.search).get(key) ?? "";
  } catch {
    return "";
  }
}

function readShareQuery(): string {
  return readQueryKey(SHARE_QUERY_KEY);
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
function stripQueryKey(key: string): void {
  try {
    const query = new URLSearchParams(window.location.search);
    if (!query.has(key)) return;
    query.delete(key);
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

/**
 * A `?d=` drawing link is captured at module scope for the same StrictMode
 * reason as `?s=`, but it lands in *storage* instead of in a panel: the chart's
 * own restore path reads that bucket as soon as bars exist, so a decode that
 * resolves before the first load does not have to race the chart.
 */
let pendingDrawLink = readQueryKey(DRAWING_SHARE_QUERY_KEY);
let pendingDrawTask: ReturnType<typeof readDrawingsShareLink> | null = null;
let drawLinkHandled = false;

function takeDrawLinkTask(): ReturnType<typeof readDrawingsShareLink> | null {
  if (pendingDrawLink && !pendingDrawTask) {
    const code = pendingDrawLink;
    pendingDrawLink = "";
    pendingDrawTask = readDrawingsShareLink(code).then((out) => {
      drawLinkHandled = true;
      return out;
    });
  }
  return drawLinkHandled ? null : pendingDrawTask;
}

/**
 * Sub panes are worth naming (⑲): the library's own id is random per mount, so
 * a drawing stored against it has nowhere to live on the next load. The two
 * built-ins below are the sub panes mounted at startup; user formulas get a
 * pane id from the same helper inside `indicatorLang.applyUserIndicator`. (MA
 * is not here: it is an overlay and shares the main pane.)
 */
const SUB_PANE_LABELS: Record<string, string> = {
  VOL: "成交量",
  MACD: "MACD",
};

/** What a pane id should read like next to a drawing (⑲). */
function paneDisplayName(paneId: string, userLabels: ReadonlyMap<string, string>): string {
  if (paneId === MAIN_PANE_ID) return "主图";
  if (!isRestorablePaneId(paneId)) return "已关闭的副图";
  const name = paneIndicator(paneId);
  return SUB_PANE_LABELS[name] ?? userLabels.get(name) ?? name;
}

/** Distinct panes a parked set is waiting for, in first-seen order. */
function parkedPanesOf(
  list: readonly StoredDrawing[],
  userLabels: ReadonlyMap<string, string>,
): string[] {
  const seen = new Set<string>();
  for (const d of list) seen.add(paneDisplayName(d.paneId, userLabels));
  return [...seen];
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
  // trusted from the click handler: the library deletes a line on right-click
  // and rewrites its points when the user drags one (⑮, see chartDrawings.ts).
  const [drawTool, setDrawTool] = useState<string | null>(null);
  const [drawCount, setDrawCount] = useState(0);
  // The same set, as rows (local custom ⑰). One read of the chart feeds both the
  // count and the list, so the toolbar number can never disagree with what the
  // panel shows — the lesson ⑮ had to learn the hard way.
  const [drawRows, setDrawRows] = useState<DrawingRow[]>([]);
  const [drawPanelOpen, setDrawPanelOpen] = useState(false);
  // Exchange feedback (local custom ⑱): one line, shown in the hint slot, with
  // the per-entry skip reasons parked in `detail` (the tooltip) so the toolbar
  // does not turn into a log. `shareFallback` only earns its rows when the
  // clipboard says no, which is the normal answer inside a sandboxed iframe.
  const [drawNotice, setDrawNotice] = useState<{ bad?: boolean; detail?: string; text: string } | null>(null);
  const [shareFallback, setShareFallback] = useState<string | null>(null);
  const drawFileRef = useRef<HTMLInputElement | null>(null);
  // Style of the *next* drawing (local custom ⑯), remembered across symbols.
  const [drawStyle, setDrawStyle] = useState<DrawingStyle>(() => loadDrawingStyle());
  // Mirror of the newest requested style. `pickStyle` composes onto this instead
  // of onto `drawStyle`, because two style clicks that land before React
  // re-renders (a scripted pair, or a click racing a re-render) would otherwise
  // both read the same stale closure and the second would silently undo the
  // first — measured that way in prod, where 虚线 + 2px in one task kept only
  // the width.
  const drawStyleRef = useRef<DrawingStyle>(drawStyle);
  // Overlay id the user clicked on the canvas: while one is picked, a style
  // click restyles that line too. The library reports it through
  // `onSelected`/`onDeselected` (dist 8687-8702); nothing else exposes it.
  const [selectedDraw, setSelectedDraw] = useState<string | null>(null);
  // Which `symbol|interval` the on-chart drawings belong to; a change means the
  // set has to be swapped for that chart's own.
  const drawingsKeyRef = useRef<string>("");
  // Syncing is muted while the swap block clears one chart's set and puts up
  // another's: each removal fires `onRemoved`, and banking that mid-swap would
  // overwrite the bucket that was just carefully saved.
  const drawingsMutedRef = useRef(false);
  // Parked drawings (⑲): lines whose pane is not on the chart — the indicator
  // behind `sub:MACD` is switched off, or the id predates stable panes entirely.
  // They are in storage but have no overlay, so every write of the bucket has to
  // carry them along or the next edit silently deletes them.
  const parkedRef = useRef<StoredDrawing[]>([]);
  // A note about the edit that is being banked right now (⑳). It cannot be set
  // from inside the anchor pass: `syncDrawings` clears every note on its way to
  // storage, and that runs after. So the pass files it here and `onSettled` puts
  // it up once the bank is done.
  const anchorNoteRef = useRef<{ bad?: boolean; text: string } | null>(null);
  const [parked, setParked] = useState<StoredDrawing[]>([]);
  const replaceParked = (list: readonly StoredDrawing[]) => {
    parkedRef.current = list.slice();
    setParked(list.slice());
  };
  // Warn-on-starvation (⑮): what the budget ended up giving the main chart.
  const [paneStarved, setPaneStarved] = useState<{ main: number; sub: number } | null>(null);
  // `excludeId` again covers the `onRemoved` callback, which runs while the
  // deleted overlay is still listed: without it the count says "已画 1 条" on an
  // empty chart until the next event happens to come along.
  const refreshDrawCount = (chart: Chart, excludeId: string | null = null) => {
    const rows = listDrawings(chart).filter((r) => r.id !== excludeId);
    setDrawRows(rows);
    setDrawCount(rows.length);
  };
  // Bumps on every workbench notification, so the pane rebudget below re-runs
  // even when the enabled count is unchanged (swapping one custom indicator for
  // another keeps the number but moves the panes around).
  const [layoutTick, setLayoutTick] = useState(0);
  // Indicator name → workbench label, so a parked drawing can say which sub pane
  // it is waiting for. Re-read when the workbench reports a change
  // (`layoutTick`), the only thing that can rename or add a formula on this page.
  const userLabels = useMemo(() => {
    const map = new Map<string, string>();
    for (const u of loadUserIndicators()) if (u.label) map.set(indicatorName(u.id), u.label);
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indCount, layoutTick]);
  // Last `chartHeight|sub pane ids` the budget was applied for; see
  // `applyPaneLayout` for why anything else must not trigger a rebudget.
  const layoutSigRef = useRef("");
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
    const ids = subPaneIdsOf(normal);
    // Separator dragging (`pane.dragEnabled`, default on) rewrites a pane's
    // height with nothing else about the chart changed. Re-running the budget on
    // every tick would quietly undo that gesture, so only a new pane set or a
    // new chart height counts as "the numbers no longer add up".
    const signature = `${chartHeight}|${ids.join(",")}`;
    if (signature === layoutSigRef.current) return;
    layoutSigRef.current = signature;
    const plan = planPaneHeights({ chartHeight, subPaneIds: ids });
    setPaneStarved(plan.starved ? { main: plan.mainHeight, sub: plan.subPaneHeight } : null);
    for (const pane of normal) {
      const want = plan.assignments[pane.id];
      if (want === undefined) continue;
      // Skip near-equal values: `setPaneOptions` relayouts, the relayout is what
      // the ResizeObserver reports, and without this guard the two ping-pong.
      if (Math.abs((pane.height ?? 0) - want) < 2) continue;
      chart.setPaneOptions({ id: pane.id, height: want });
    }
  };

  /**
   * Is this pane on the chart right now? `getPaneOptions(id)` answers `null` for
   * a pane the chart does not hold, which is the only way to tell "the MACD pane
   * is closed" apart from "draw it wherever" (⑲) — and guessing wrong is exactly
   * the invisible-line bug `chartDrawings.restoreDrawings` parks against.
   */
  const paneLookup = (chart: Chart): PaneLookup => (paneId: string) => {
    try {
      return chart.getPaneOptions(paneId) != null;
    } catch {
      // A host that cannot answer gets the one safe answer: the main chart.
      return paneId === MAIN_PANE_ID;
    }
  };

  /**
   * Write the bucket: the lines on the chart plus the ones parked off it (⑲).
   * Parked first, because `saveDrawings` keeps the tail when a bucket overflows
   * and a line nobody can see is the one worth sacrificing — and because every
   * other write path would otherwise delete them by omission.
   */
  const bankDrawings = (chart: Chart, s: string, i: string, excludeId: string | null = null) => {
    saveDrawings(s, i, [...parkedRef.current, ...serializeDrawings(chart.getOverlays(), excludeId)]);
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
              // `parkedRef` still holds the *outgoing* bucket's waiting lines at
              // this point, which is exactly the set this call must preserve.
              bankDrawings(chart, ps, pi);
            }
            // The teardown below fires `onRemoved` on every old overlay; those
            // callbacks must not bank against the key that is about to change.
            drawingsMutedRef.current = true;
            let repaired: { moved: number; dropped: number } | null = null;
            try {
              chart.removeOverlay();
              const stored = loadDrawings(ticker, iv);
              // A line drawn before ⑳ can still hold an anchor in the blank gap
              // right of the newest bar, which the library is only too happy to
              // extrapolate into a trading time that never existed. Straighten
              // the bucket out once, before it splits into "on the chart" and
              // "parked", so all three copies start from the same geometry.
              const lastTs = lastBarTimestamp(bars);
              const fixed =
                lastTs === undefined
                  ? { drawings: stored, moved: 0, dropped: 0 }
                  : clampDrawingsToLastBar(stored, lastTs);
              if (fixed.moved > 0 || fixed.dropped > 0) {
                saveDrawings(ticker, iv, fixed.drawings);
                repaired = { moved: fixed.moved, dropped: fixed.dropped };
              }
              const report = restoreDrawings(
                chart,
                fixed.drawings,
                drawingEvents(),
                paneLookup(chart),
              );
              replaceParked(report.parked);
            } finally {
              drawingsMutedRef.current = false;
            }
            if (repaired) {
              const bits = [`${repaired.moved} 处画线落点在最新 K 线右侧的空白里，已吸回最后一根`];
              if (repaired.dropped > 0) bits.push(`${repaired.dropped} 条吸回后重合成了一个点，已删除`);
              setDrawNotice({ bad: repaired.dropped > 0, text: bits.join("；") });
            }
            drawingsKeyRef.current = key;
            // The overlay that was selected belongs to the chart we just tore
            // down; keeping its id would point the next colour click at nothing.
            setSelectedDraw(null);
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
    // Named panes, so a drawing on the volume strip can find it again after a
    // reload (⑲); the library's own ids are random per mount.
    chart.createIndicator({ name: "VOL", paneId: subPaneIdOf("VOL") });
    chart.createIndicator({ name: "MACD", paneId: subPaneIdOf("MACD") });
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
        bankDrawings(chart, ps, pi);
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
    stripQueryKey(SHARE_QUERY_KEY);
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
    setDrawNotice(null);
    setShareFallback(null);
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
    setDrawNotice(null);
    setInterval(iv);
    chartRef.current?.setPeriod(periodFor(iv));
  };

  // Panes come and go from the workbench without any chart event to hook, so
  // rebudget the layout whenever the enabled-indicator set changes — and hand
  // back the drawings a newly opened sub pane has waiting for it (⑲).
  useEffect(() => {
    const chart = chartRef.current;
    if (chart) {
      applyPaneLayout(chart);
      parkOrphans(chart);
      flushParked(chart);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indCount, layoutTick]);

  const syncDrawings = (chart: Chart, excludeId: string | null = null) => {
    if (drawingsMutedRef.current) return;
    // Any live edit makes the previous import/export note stale (⑱).
    setDrawNotice(null);
    const key = drawingsKeyRef.current || `${symbol}|${interval}`;
    const [s, i] = key.split("|");
    bankDrawings(chart, s, i, excludeId);
    refreshDrawCount(chart, excludeId);
  };

  /**
   * The blank gap right of the newest bar is clickable, and a click there is not
   * rejected — the library extrapolates the timestamp into a trading time the data
   * never had, so the line hangs past the last candle, its label names a date that
   * does not exist, and the next bar slides it left (⑳). Every anchor that landed
   * out there is pulled back onto the newest bar; a multi-point line that
   * collapses onto one bar has no honest place left to sit, so it goes.
   */
  const anchorDrawing = (overlay: unknown) => {
    const chart = chartRef.current;
    if (!chart) return;
    const lastTs = lastBarTimestamp(chart.getDataList());
    // No bars yet means no idea where the edge is; leave the line alone.
    if (lastTs === undefined) return;
    const report = reanchorOverlay(chart, overlay, lastTs);
    if (report.dropped.length > 0) {
      anchorNoteRef.current = {
        bad: true,
        text: "这条线的落点全在最新 K 线右侧的空白里，吸回来会重合成一个点，已放弃",
      };
    } else if (report.moved > 0) {
      anchorNoteRef.current = { text: "落点在最新 K 线右侧的空白里，已吸回最后一根 K 线" };
    }
  };

  /** Files the note about this very edit, after the bank has cleared the old one. */
  const settleAnchorNote = () => {
    const note = anchorNoteRef.current;
    if (!note) return;
    anchorNoteRef.current = null;
    setDrawNotice(note);
  };

  /**
   * Events every drawing carries — the ones armed here and the ones restored
   * from storage. `onDrawEnd` clears the highlight, `onChanged` banks the set
   * (minus a just-removed overlay, which the library deletes *after* the
   * callback), and `onRemoved` of a half-drawn overlay also releases the armed
   * tool: the right-click delete can empty the chart under a lit button.
   */
  const drawingEvents = () =>
    makeDrawingEvents({
      onChanged: (excludeId) => {
        const chart = chartRef.current;
        if (chart) syncDrawings(chart, excludeId);
      },
      onDrawEnd: () => setDrawTool(null),
      onRemoved: (overlay) => {
        const id = (overlay as { id?: string } | null | undefined)?.id ?? null;
        if (id) setSelectedDraw((cur) => (cur === id ? null : cur));
        if (isInProgress(overlay)) setDrawTool(null);
      },
      onSelected: (overlay) => {
        setSelectedDraw((overlay as { id?: string } | null | undefined)?.id ?? null);
      },
      onDeselected: (overlay) => {
        const id = (overlay as { id?: string } | null | undefined)?.id ?? null;
        // Guarded by id because the library deselects the old line *before*
        // selecting the new one (dist 14543-14549); an unguarded `null` there
        // would throw away the selection the user just made.
        if (id) setSelectedDraw((cur) => (cur === id ? null : cur));
      },
      onAnchor: anchorDrawing,
      onSettled: settleAnchorNote,
    });

  /**
   * Everything this bucket holds, on the chart or not (⑲). Exporting the live
   * lines only would hand over half a drawing set and then watch the parked half
   * vanish on the next edit.
   */
  const allDrawings = (chart: Chart): StoredDrawing[] => [
    ...parkedRef.current,
    ...serializeDrawings(chart.getOverlays()),
  ];

  /**
   * A sub pane just disappeared under its drawings (⑲). The library leaves those
   * overlay instances on the chart pointing at a pane that is gone — invisible,
   * still counted, and not even parked, so `清单 · N` would stop matching the
   * lines the user can see (the ⑰ contract). Take them off the chart and hand
   * them to the same parking lot `restoreDrawings` uses, so re-enabling the
   * formula puts them back on their own pane.
   */
  const parkOrphans = (chart: Chart) => {
    const paneExists = paneLookup(chart);
    const overlays = (chart.getOverlays() ?? []) as { id?: string; paneId?: string }[];
    const dead = overlays.filter((o) => isSubPaneId(o.paneId ?? "") && !paneExists(o.paneId!));
    if (dead.length === 0) return;
    // A half-drawn line has nothing worth keeping; removing it unmuted lets the
    // library's own `onRemoved` put out the armed-tool highlight.
    const salvage = dead.filter((o) => !isInProgress(o));
    const unfinished = dead.filter((o) => isInProgress(o));
    const waiting = serializeDrawings(salvage);
    drawingsMutedRef.current = true;
    try {
      for (const o of salvage) if (o.id) chart.removeOverlay({ id: o.id });
    } finally {
      drawingsMutedRef.current = false;
    }
    replaceParked([...parkedRef.current, ...waiting]);
    for (const o of unfinished) if (o.id) chart.removeOverlay({ id: o.id });
    syncDrawings(chart);
  };

  /**
   * A sub pane just appeared — put back what was waiting for it (⑲). Parked
   * drawings are re-run through `restoreDrawings` rather than created here, so a
   * pane that shows up and vanishes again in the same tick parks them straight
   * back instead of losing them.
   */
  const flushParked = (chart: Chart) => {
    const waiting = parkedRef.current;
    if (waiting.length === 0) return;
    const report = restoreDrawings(chart, waiting, drawingEvents(), paneLookup(chart));
    if (report.applied.length === 0) return;
    replaceParked(report.parked);
    syncDrawings(chart);
  };

  /** Throw away the waiting lines — the only way out of a pane that is gone. */
  const discardParked = () => {
    replaceParked([]);
    const chart = chartRef.current;
    if (chart) syncDrawings(chart);
  };

  /**
   * Arm a draw tool. The button doubles as the exit: clicking the armed tool
   * again (or Esc) drops the half-drawn overlay instead of leaving the chart
   * swallowing clicks waiting for a second point.
   */
  const armTool = (name: string) => {
    const chart = chartRef.current;
    if (!chart) return;
    setDrawNotice(null);
    if (drawTool === name) {
      setDrawTool(null);
      cancelInProgress(chart);
      return;
    }
    cancelInProgress(chart);
    setDrawTool(name);
    // The starting pane, not the final one: `updateProgressOverlayInfo` re-homes
    // the overlay to whichever pane takes the first click (dist 8508-8510), and
    // that is the sub-pane gesture ⑲ is built on — arming a tool does not have
    // to know yet where the user means to draw.
    chart.createOverlay({
      name,
      paneId: MAIN_PANE_ID,
      styles: overlayStylesOf(drawStyleRef.current),
      ...drawingEvents(),
    });
  };

  /**
   * Choose a style. It always sets what the *next* line looks like; if the user
   * clicked a line first, that one is restyled in place (⑯).
   */
  const pickStyle = (patch: Partial<DrawingStyle>) => {
    const next: DrawingStyle = { ...drawStyleRef.current, ...patch };
    drawStyleRef.current = next;
    setDrawStyle(next);
    saveDrawingStyle(next);
    const chart = chartRef.current;
    if (!chart || !selectedDraw) return;
    if (applyDrawingStyle(chart, selectedDraw, next)) syncDrawings(chart);
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
    // "全部画线" means the parked ones too (⑲) — they belong to this bucket, and
    // leaving them behind would resurrect lines the user just asked to clear.
    replaceParked([]);
    setDrawTool(null);
    syncDrawings(chart);
  };

  /**
   * Open/close the drawing list (⑰). The strip takes height away from the chart,
   * so the pane budget has to run again; bumping `layoutTick` is what does that,
   * and by the time its effect fires the new layout is already on screen, so
   * `applyPaneLayout` measures the shrunk host.
   */
  const toggleDrawPanel = () => {
    setDrawPanelOpen((open) => !open);
    setLayoutTick((t) => t + 1);
  };

  /** Lock / hide one line, then bank it — see `applyDrawingFlags` for why the
   * library's return value is not the thing to trust. */
  const flagDrawing = (id: string, flags: DrawingFlags) => {
    const chart = chartRef.current;
    if (!chart) return;
    if (applyDrawingFlags(chart, id, flags)) syncDrawings(chart);
  };

  /**
   * Delete one line through the chart, so `onRemoved` runs the same way a
   * right-click delete runs it (⑮): selection and storage are cleaned by that
   * callback, not by this handler.
   */
  const removeDrawing = (id: string) => {
    const chart = chartRef.current;
    if (!chart) return;
    chart.removeOverlay({ id });
    syncDrawings(chart);
  };

  /**
   * Aim the style toolbar at a row. There is no public "select this overlay" in
   * v10 — canvas clicks are the only thing that lights a line up there — so a
   * list pick deliberately re-targets the next colour/width click rather than
   * pretending to highlight the chart.
   */
  const focusDrawing = (id: string) => {
    setSelectedDraw((cur) => (cur === id ? null : id));
  };

  /**
   * Merge imported drawings into the bucket the user is looking at, then put
   * them on screen if that bucket is what the chart holds. Restoring through
   * `restoreDrawings` (not a hand-rolled `createOverlay`) is what keeps an
   * imported line editable and bankable like a drawn one — the events come with
   * it (⑮) — and `mergeDrawings` is what makes importing the same file twice a
   * no-op instead of a doubled chart (⑱).
   */
  const ingestDrawings = (incoming: readonly StoredDrawing[], from: string, skipped: readonly string[] = []) => {
    const key = drawingsBucket(symbol, interval);
    // A file can anchor its lines on bars this chart does not have — another
    // symbol, another period, or plain future-zone click coordinates (⑳). Pull
    // them onto the newest bar *before* the merge, so the dedup comparison and
    // what ends up on screen agree on the same geometry.
    const live = chartRef.current;
    const lastTs = live ? lastBarTimestamp(live.getDataList()) : undefined;
    const fixed =
      lastTs === undefined
        ? { drawings: [...incoming], moved: 0, dropped: 0 }
        : clampDrawingsToLastBar(incoming, lastTs);
    const merged = mergeDrawings(loadDrawings(symbol, interval), fixed.drawings);
    if (merged.added === 0) {
      const bits = [
        incoming.length === 0 ? "没有可导入的画线" : `${incoming.length} 条画线都已经在 ${key} 上了`,
      ];
      if (fixed.dropped > 0) bits.push(`${fixed.dropped} 条落点全部越界，吸回后重合成一个点，已放弃`);
      setDrawNotice({ bad: incoming.length === 0, detail: skipped.join("；"), text: bits.join("；") });
      return;
    }
    saveDrawings(symbol, interval, merged.drawings);
    const chart = chartRef.current;
    let waiting = 0;
    // A bucket the chart is not showing yet needs no live update: the swap in
    // `getBars` reads it from storage the moment it becomes current.
    if (chart && drawingsKeyRef.current === key) {
      const report = restoreDrawings(chart, merged.fresh, drawingEvents(), paneLookup(chart));
      if (report.parked.length > 0) replaceParked([...parkedRef.current, ...report.parked]);
      waiting = report.parked.length;
      refreshDrawCount(chart);
    }
    const bits = [`导入 ${merged.added} 条画线到 ${key}`];
    if (merged.duplicates) bits.push(`重复 ${merged.duplicates} 条未加`);
    if (skipped.length) bits.push(`跳过 ${skipped.length} 条`);
    if (fixed.moved > 0) bits.push(`${fixed.moved} 处落点不在本图的 K 线上，已吸回最后一根`);
    if (fixed.dropped > 0) bits.push(`${fixed.dropped} 条吸回后重合成一个点，未导入`);
    // ⑲: a file from a MACD study is useless on a chart that closed MACD, but it
    // is not *lost* — say where it is instead of letting it silently not appear.
    if (waiting) bits.push(`${waiting} 条在等副图开启`);
    if (from && from !== key) bits.push(`文件来自 ${from}`);
    setDrawNotice({ detail: skipped.join("；"), text: bits.join("；") });
  };

  const exportDrawingsFile = () => {
    const chart = chartRef.current;
    if (!chart) return;
    const list = allDrawings(chart);
    if (list.length === 0) {
      setDrawNotice({ bad: true, text: `当前标的与周期（${symbol} · ${interval}）上没有画线` });
      return;
    }
    const name = drawingsFileName(symbol, interval);
    if (downloadText(name, exportDrawingsJson(list, { symbol, interval }), "application/json")) {
      setDrawNotice({ text: `已导出 ${list.length} 条画线到 ${name}` });
    } else {
      setDrawNotice({ bad: true, text: "这个浏览器不给直接下载，改用「分享链接」或换浏览器" });
    }
  };

  const shareDrawingsLink = async () => {
    const chart = chartRef.current;
    if (!chart) return;
    const list = allDrawings(chart);
    if (list.length === 0) {
      setDrawNotice({ bad: true, text: `当前标的与周期（${symbol} · ${interval}）上没有画线` });
      return;
    }
    try {
      const link = await createDrawingsShareLink(list, { symbol, interval });
      setShareFallback(link.url);
      const copied = await copyText(link.url);
      setDrawNotice({
        bad: !copied,
        text: copied
          ? `分享链接已复制（${link.length} 字符，${link.codec === "g" ? "gzip" : "明文"}）`
          : "剪贴板用不了，请手动选中下方链接复制",
        detail: link.verbose ? `链接 ${link.length} 字符偏长，部分聊天工具会截断，建议改用文件` : undefined,
      });
    } catch (e) {
      setDrawNotice({ bad: true, text: `生成分享链接失败：${e instanceof Error ? e.message : String(e)}` });
    }
  };

  const onDrawingFilePicked = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset first: picking the same file twice has to fire `change` again.
    e.target.value = "";
    if (!file) return;
    let raw = "";
    try {
      raw = await file.text();
    } catch {
      setDrawNotice({ bad: true, text: `读不动 ${file.name}` });
      return;
    }
    const out = importDrawingsJson(raw);
    if (!out.ok) {
      setDrawNotice({ bad: true, text: `${file.name}：${out.error}` });
      return;
    }
    ingestDrawings(out.drawings, out.from, out.skipped);
  };

  // `?d=` opens the chart with somebody else's markings merged in (⑱).
  useEffect(() => {
    const task = takeDrawLinkTask();
    stripQueryKey(DRAWING_SHARE_QUERY_KEY);
    if (!task) return;
    let alive = true;
    void task.then((out) => {
      if (!alive) return;
      if (!out.ok) {
        setDrawNotice({ bad: true, text: `画线分享链接无效：${out.error}` });
        return;
      }
      ingestDrawings(out.drawings, out.from, out.skipped);
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const armedTool = toolOf(drawTool ?? "");
  const parkedCount = parked.length;
  const parkedBits = parkedCount > 0 ? parkedPanesOf(parked, userLabels).join("、") : "";

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
            title="清除当前标的与周期上的全部画线（含在等副图开启的）"
            disabled={drawCount === 0 && parkedCount === 0 && drawTool === null}
            onClick={clearDraw}
          >
            清除
          </button>
          <button
            className={cn(
              "rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40",
              drawPanelOpen && "bg-muted font-medium ring-1 ring-primary",
            )}
            aria-label="画线清单"
            aria-pressed={drawPanelOpen}
            title={
              drawCount === 0 && parkedCount === 0
                ? "暂无画线可管理"
                : `列出全部画线：逐条选中、锁定、隐藏、删除${parkedCount ? `（另 ${parkedCount} 条在等副图）` : ""}`
            }
            disabled={drawCount === 0 && parkedCount === 0}
            onClick={toggleDrawPanel}
          >
            清单 · {drawCount}
            {parkedCount > 0 ? `+${parkedCount}` : ""}
          </button>
          {/* Exchange (⑱): a file is the archive, the link is the quick hand-off.
              导入 stays clickable on an empty chart — that is exactly when it is
              needed, and it merges into the current 标的与周期. */}
          <button
            className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
            aria-label="导出画线文件"
            title={`把当前 ${drawCount + parkedCount} 条画线导出为 .json（含颜色线宽、锁定/隐藏与归属面板）`}
            disabled={drawCount === 0 && parkedCount === 0}
            onClick={exportDrawingsFile}
          >
            导出
          </button>
          <button
            className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
            aria-label="复制画线分享链接"
            title="把当前画线压进一条链接（?d=），对方打开即导入到他的标的与周期"
            disabled={drawCount === 0 && parkedCount === 0}
            onClick={() => void shareDrawingsLink()}
          >
            链接
          </button>
          <button
            className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
            aria-label="导入画线文件"
            title="选择 .json 画线文件，合并进当前标的与周期（重复的线不会叠加）"
            onClick={() => drawFileRef.current?.click()}
          >
            导入
          </button>
          <input
            ref={drawFileRef}
            type="file"
            accept=".json,application/json"
            aria-label="画线文件"
            className="hidden"
            onChange={(e) => void onDrawingFilePicked(e)}
          />
        </div>
        {/* Style of the next drawing; with a line selected it restyles that one too (⑯). */}
        <div className="flex items-center gap-1">
          {DRAWING_COLORS.map((c) => (
            <button
              key={c.value}
              type="button"
              aria-label={`画线颜色 ${c.label}`}
              title={`${c.label}色${selectedDraw ? "（同时改掉选中的线）" : "（新画的线）"}`}
              className={cn(
                "h-5 w-5 shrink-0 rounded-full border border-black/10 dark:border-white/25",
                drawStyle.color === c.value && "ring-1 ring-primary",
              )}
              style={{ backgroundColor: c.value }}
              onClick={() => pickStyle({ color: c.value })}
            />
          ))}
          <span className="mx-1 h-4 w-px bg-border" />
          {DRAWING_SIZES.map((s) => (
            <button
              key={s}
              type="button"
              aria-label={`画线粗细 ${s}px`}
              title={`线宽 ${s}px`}
              className={cn(
                "rounded-md border px-2 py-1 text-xs hover:bg-muted",
                drawStyle.size === s && "bg-muted font-medium ring-1 ring-primary",
              )}
              onClick={() => pickStyle({ size: s })}
            >
              {s}px
            </button>
          ))}
          <button
            type="button"
            aria-label="虚线"
            title={drawStyle.dashed ? "改成实线" : "改成虚线"}
            className={cn(
              "rounded-md border px-2 py-1 text-xs hover:bg-muted",
              drawStyle.dashed && "bg-muted font-medium ring-1 ring-primary",
            )}
            onClick={() => pickStyle({ dashed: !drawStyle.dashed })}
          >
            {drawStyle.dashed ? "虚线" : "实线"}
          </button>
        </div>
        <span
          className={cn("text-xs", drawNotice?.bad ? "text-red-500" : "text-muted-foreground")}
          title={drawNotice?.detail || (parkedCount > 0 ? `在等副图：${parkedBits}` : undefined)}
        >
          {drawNotice
            ? drawNotice.text
            : armedTool
              ? drawHint(armedTool)
              : selectedDraw
                ? "已选中一条线 — 点颜色/线宽就改这条（点空白处取消）"
                : drawCount > 0
                  ? `已画 ${drawCount} 条 · 随标的与周期保存，单击选中、拖动可改位，右键点线删除${parkedCount > 0 ? ` · 另 ${parkedCount} 条在等 ${parkedBits}` : ""}`
                  : parkedCount > 0
                    ? `${parkedCount} 条画线在等 ${parkedBits} — 开启对应指标即回到图上`
                    : "画线随标的与周期保存"}
        </span>
        {shareFallback && (
          <input
            readOnly
            value={shareFallback}
            aria-label="画线分享链接"
            title="选中后 Ctrl+C 复制；这条链接打开后会把画线导入到当时的标的与周期"
            onFocus={(e) => e.target.select()}
            className="w-64 rounded-md border bg-background px-2 py-1 text-[11px] text-muted-foreground"
          />
        )}
        {paneStarved && (
          <span
            className="text-xs text-amber-600 dark:text-amber-500"
            title={`副图各占 ${paneStarved.sub}px 后，主图只剩 ${paneStarved.main}px：关闭部分指标可换回可读性`}
          >
            副图过多，主图仅 {paneStarved.main}px — 关闭部分指标可恢复
          </span>
        )}
        <div className="ml-auto text-xs text-muted-foreground">
          {status.loading ? "加载中…" : status.error ? <span className="text-red-500">{status.error}</span> : status.source || ""}
        </div>
      </div>

      {drawPanelOpen && (
        <div className="max-h-[132px] shrink-0 overflow-y-auto rounded-lg border bg-background">
          {drawRows.length === 0 ? (
            <div className="px-3 py-2 text-xs text-muted-foreground">
              {parkedCount > 0 ? "图上暂无画线 — 下面这些在等副图开启" : "当前标的与周期上还没有画线"}
            </div>
          ) : (
            drawRows.map((row) => (
              <div
                key={row.id}
                className={cn(
                  "flex items-center gap-2 border-b px-2 py-1 text-xs last:border-b-0",
                  row.hidden && "opacity-60",
                )}
              >
                <button
                  type="button"
                  aria-label={`选中画线 ${row.id}`}
                  title={selectedDraw === row.id ? "已选中 — 再点一次取消" : "选中这条，点颜色/线宽就改它"}
                  className={cn(
                    "flex min-w-0 flex-1 items-center gap-2 rounded-md px-1 py-0.5 text-left hover:bg-muted",
                    selectedDraw === row.id && "bg-muted ring-1 ring-primary",
                  )}
                  onClick={() => focusDrawing(row.id)}
                >
                  <span
                    aria-hidden
                    className="h-3 w-3 shrink-0 rounded-full border border-black/10 dark:border-white/25"
                    style={{ backgroundColor: row.style.color }}
                  />
                  <span className="shrink-0 font-medium">{row.label}</span>
                  {row.paneId !== MAIN_PANE_ID && (
                    <span
                      className="shrink-0 rounded border px-1 text-[10px] text-muted-foreground"
                      title={`这条线落在「${paneDisplayName(row.paneId, userLabels)}」副图上；关闭该指标会把它暂存，重开即放回同一面板`}
                    >
                      {paneDisplayName(row.paneId, userLabels)}
                    </span>
                  )}
                  <span className="truncate text-muted-foreground">{row.detail}</span>
                  {row.pointCount > 2 && <span className="shrink-0 text-muted-foreground">{row.pointCount} 点</span>}
                  {row.locked && <span className="shrink-0 text-muted-foreground">已锁定</span>}
                  {row.hidden && <span className="shrink-0 text-muted-foreground">已隐藏</span>}
                </button>
                <button
                  type="button"
                  aria-label={`锁定画线 ${row.id}`}
                  title={row.locked ? "解锁后可拖动改位" : "锁定后拖不动这条线（右键仍可删）"}
                  className="shrink-0 rounded-md border px-2 py-0.5 hover:bg-muted"
                  onClick={() => flagDrawing(row.id, { lock: !row.locked })}
                >
                  {row.locked ? "解锁" : "锁定"}
                </button>
                <button
                  type="button"
                  aria-label={`隐藏画线 ${row.id}`}
                  title={row.hidden ? "重新画上这条线" : "隐藏后图上不画、也点不到，只能从这里找回"}
                  className="shrink-0 rounded-md border px-2 py-0.5 hover:bg-muted"
                  onClick={() => flagDrawing(row.id, { hidden: !row.hidden })}
                >
                  {row.hidden ? "显示" : "隐藏"}
                </button>
                <button
                  type="button"
                  aria-label={`删除画线 ${row.id}`}
                  title="删除这条线"
                  className="shrink-0 rounded-md border px-2 py-0.5 hover:bg-muted"
                  onClick={() => removeDrawing(row.id)}
                >
                  删除
                </button>
              </div>
            ))
          )}
          {parkedCount > 0 && (
            <div className="flex items-center gap-2 border-t bg-muted/40 px-2 py-1 text-xs text-muted-foreground">
              <span
                className="min-w-0 flex-1 truncate"
                title={`这些线画在 ${parkedBits} 上，而该副图当前是关闭的；开启对应指标会自动放回原面板（不会回到主图）`}
              >
                {parkedCount} 条在等副图 · {parkedBits} — 开启对应指标即回到图上
              </span>
              <button
                type="button"
                aria-label="删除待恢复的画线"
                title="删除这些在等副图的线（它们不在图上，只能从这里删）"
                className="shrink-0 rounded-md border px-2 py-0.5 hover:bg-muted"
                onClick={discardParked}
              >
                删除
              </button>
            </div>
          )}
        </div>
      )}

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
        数据来自本项目自有行情链路（日线走 loader 回退链，A股分钟线走 akshare 新浪接口）；红涨绿跌。滚轮缩放、拖拽平移，上方「画线」工具栏可在主图或任一副图上落点（第一个落点在哪条面板，这条线就归谁；画好的线单击选中、可改颜色线宽，拖动改位，右键点击删除，「清单」里可逐条锁定/隐藏/删除并标注归属副图），副图被关闭时它的线会暂存在清单尾部、重开指标即回到原面板，「导出/链接/导入」把画线带走或接过来（.json 与 ?d= 链接都含样式、锁定隐藏与归属面板），副图高度可拖分隔条微调，指标 MA/VOL/MACD 内置。
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
