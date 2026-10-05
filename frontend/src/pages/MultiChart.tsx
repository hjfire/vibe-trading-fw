import { useEffect, useMemo, useRef, useState } from "react";
import type { Chart, Crosshair, Nullable, Point } from "klinecharts";
import { Link2, Link2Off } from "lucide-react";
import { useThemeDark } from "@/lib/theme-store";
import { INTERVALS, type IntervalKey } from "@/lib/marketApi";
import { intervalAllowed, repairInterval } from "@/lib/chartView";
import { MAIN_PANE_ID } from "@/lib/chartDrawings";
import { ChartCell } from "@/components/charts/ChartCell";
import SymbolCombobox from "@/components/common/SymbolCombobox";
import {
  barEndOf,
  barTimestamps,
  CLEAR_CROSSHAIR,
  coarseBarSpanMs,
  createApplyGate,
  crosshairPayload,
  rangePlan,
  windowOfIndices,
} from "@/lib/mtfSync";

/**
 * Multi-timeframe watch (local custom).
 *
 * Four charts of the same symbol at four periods, lined up on the clock. The
 * arithmetic that makes the alignment mean anything is in `lib/mtfSync.ts` and
 * tested there; this file is the shell — what is on screen, what persists, and
 * which callbacks are wired to which chart.
 *
 * It is a separate page rather than a mode of /pro-chart on purpose. ProChart
 * assumes "one chart per page" in six places (`hostRef`, `chartRef`,
 * `syncSubPanes`, `drawingsKey`, `readSession`, the pane-height budget); turning
 * those into arrays would put 314 existing page tests at risk to serve a view
 * that does not need drawings, 分时 or the user indicator shelf at all.
 */

const SESSION_KEY = "multi-chart.session.v1";

/** Four cells, arranged 2x2. */
export const CELL_COUNT = 4;

/** What a fresh page shows: one daily anchor and three intraday levels below it. */
export const DEFAULT_INTERVALS: IntervalKey[] = ["1D", "60m", "15m", "5m"];

const DEFAULT_SYMBOL = "600519.SH";

export interface MultiChartSession {
  symbol: string;
  intervals: IntervalKey[];
  sync: boolean;
  /**
   * Whether a cell had to be pushed off the period it asked for. Deliberately
   * not a persisted field: it is derived from what was stored, and the repaired
   * `intervals` are what gets written back — so the *repaired* list can never
   * answer "was anything blocked" (it is clean by construction), which is what
   * made the one-line explanation unreachable until it was read off the request
   * instead.
   */
  blocked: boolean;
}

const isIntervalKey = (v: unknown): v is IntervalKey =>
  typeof v === "string" && INTERVALS.some((i) => i.key === v);

/**
 * The stored view, repaired rather than trusted (same posture as ProChart's
 * `readSession`): minute bars do not exist for every instrument, a hand-edited
 * bucket is possible, and a short `intervals` array would leave the grid with
 * holes to render around.
 */
export function readSession(): MultiChartSession {
  const fallback: MultiChartSession = {
    symbol: DEFAULT_SYMBOL,
    intervals: [...DEFAULT_INTERVALS],
    sync: true,
    blocked: false,
  };
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return fallback;
    const obj: unknown = JSON.parse(raw);
    if (!obj || typeof obj !== "object") return fallback;
    const { symbol, intervals, sync } = obj as {
      symbol?: unknown;
      intervals?: unknown;
      sync?: unknown;
    };
    const nextSymbol =
      typeof symbol === "string" && symbol.trim() ? symbol.trim().toUpperCase() : DEFAULT_SYMBOL;
    const list = Array.isArray(intervals) ? intervals : [];
    // Fill by position, repairing as we go, so a stored array of the wrong
    // length still yields exactly CELL_COUNT usable periods. `asked` is what the
    // session *wanted*, before any repair — the only thing the notice can be
    // judged against.
    const asked = Array.from(
      { length: CELL_COUNT },
      (_, i) => (isIntervalKey(list[i]) ? list[i] : DEFAULT_INTERVALS[i]),
    );
    return {
      symbol: nextSymbol,
      intervals: asked.map((iv) => repairInterval(nextSymbol, iv)),
      sync: sync !== false,
      blocked: blockedAny(nextSymbol, asked),
    };
  } catch {
    return fallback;
  }
}

/** What the grid shows after `symbol` changes — every cell re-checked, not just
 *  the ones the user can see. */
export function intervalsForSymbol(
  symbol: string,
  current: readonly IntervalKey[],
): IntervalKey[] {
  return Array.from({ length: CELL_COUNT }, (_, i) =>
    repairInterval(symbol, current[i] ?? DEFAULT_INTERVALS[i]),
  );
}

export function MultiChart() {
  const dark = useThemeDark();
  const initial = useMemo(readSession, []);
  const [symbol, setSymbol] = useState(initial.symbol);
  const [draft, setDraft] = useState(initial.symbol);
  const [intervals, setIntervals] = useState<IntervalKey[]>(initial.intervals);
  const [sync, setSync] = useState(initial.sync);
  // Carried separately from `intervals`, because that list is repaired on the way
  // in and so no longer records that anything was repaired.
  const [blockedNotice, setBlockedNotice] = useState(initial.blocked);

  // The live charts, in cell order. State rather than a ref because the wiring
  // effect below has to re-run when a cell mounts or unmounts — a ref would
  // change invisibly and leave a dead subscription on a disposed chart.
  const [charts, setCharts] = useState<Array<Nullable<Chart>>>(
    Array.from({ length: CELL_COUNT }, () => null),
  );
  const chartSlots = useRef<Array<(c: Nullable<Chart>) => void>>([]);
  if (chartSlots.current.length === 0) {
    chartSlots.current = Array.from({ length: CELL_COUNT }, (_, i) => (chart: Nullable<Chart>) =>
      setCharts((prev) => {
        if (prev[i] === chart) return prev;
        const next = [...prev];
        next[i] = chart;
        return next;
      }),
    );
  }

  useEffect(() => {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ symbol, intervals, sync }));
    } catch {
      // Private mode / full quota: the page still works, it just reopens wide.
    }
  }, [symbol, intervals, sync]);

  /**
   * The sync bus.
   *
   * Three subscriptions per chart, and what is *not* subscribed matters as much
   * as what is:
   *
   * * movement triggers on `onZoom` / `onScroll`, never on
   *   `onVisibleRangeChange`. That one fires from `_adjustVisibleRange` (dist
   *   13568), which runs on every data arrival, every resize and every bar-space
   *   write — so it is not a gesture, and a page's first page of bars landing is
   *   the loudest event on the bus. Measured live on the default A-share grid
   *   (2026-10-05): the feeds are unequal depth (500 daily bars against 20 hourly
   *   ones), the 5-minute cell landed first, and its ~17-bar window was broadcast
   *   at the other three — the daily chart ended up at the library's 50px maximum
   *   showing four bars. Which page wins becomes a race, and nothing the user did
   *   caused it. `onZoom` (dist 14033) and `onScroll` (13758) only fire from the
   *   wheel and drag handlers, which is what "linked" is supposed to mean.
   * * the crosshair needs no guard — `ChartImp.executeAction` applies it with
   *   `setCrosshair(..., { notExecuteAction: true })`, so the peer cannot echo
   *   it back. What it cannot take is a timestamp: `setCrosshair` derives the
   *   bar from `cr.x` alone, so every peer gets its *own* pixel for that
   *   instant, computed by `convertToPixel`. And the incoming event carries no
   *   timestamp either, so the instant has to be recovered from the source's x
   *   first — see `onCrosshair`.
   * * the gate is still required, because the echo moved rather than disappeared:
   *   `scrollToTimestamp` → `scrollByDistance` → `StoreImp.scroll`, and that ends
   *   in `executeAction('onScroll')` (dist 15639 → 15613 → 13758). Applying a
   *   window to three peers therefore re-enters this handler three times.
   *   `setBarSpace` and `setOffsetRightDistance` no longer echo here, since
   *   nothing subscribes to the range event they cause.
   */
  useEffect(() => {
    const live = charts.filter((c): c is Chart => c !== null);
    if (!sync || live.length < 2) return;
    const gate = createApplyGate();
    const teardown: Array<() => void> = [];

    for (const source of live) {
      const onGesture = () => {
        if (gate.isApplying()) return;
        const stamps = barTimestamps(source.getDataList());
        const win = windowOfIndices(
          stamps,
          source.getVisibleRange(),
          coarseBarSpanMs(source.getPeriod()),
        );
        if (!win) return;
        gate.run(() => {
          for (const peer of live) {
            if (peer === source) continue;
            const width = peer.getDom(MAIN_PANE_ID, "main")?.getBoundingClientRect().width ?? 0;
            const plan = rangePlan(barTimestamps(peer.getDataList()), width, win);
            // `null` is this peer keeping its own view: no bar of it falls in
            // the window (a minute cell cannot follow a daily chart back ten
            // years), or the host has no measurable width.
            if (!plan) continue;
            peer.setBarSpace(plan.barSpace);
            peer.setOffsetRightDistance(plan.offsetRight);
            peer.scrollToTimestamp(plan.anchor, 0);
          }
        });
      };

      const onCrosshair = (data?: unknown) => {
        const x = (data as Crosshair | undefined)?.x;
        if (typeof x !== "number") return;
        // `data` has no `timestamp` on it. `StoreImp.setCrosshair` builds the
        // resolved cursor (bar, dataIndex, timestamp) into `this._crosshair`
        // (dist 14090) but hands subscribers the *parameter it received* (dist
        // 14093), and the mouse path builds `{x, y, paneId}` (dist 2547). Read
        // live 2026-10-06: the payload's `timestamp` is `undefined` on every
        // hover, so keying the fan-out off it silently syncs nothing.
        // `convertFromPixel` runs the same `coordinateToDataIndex` the store
        // itself just ran, so this is the bar the source is highlighting.
        const [hit] = source.convertFromPixel([{ x }], {
          paneId: MAIN_PANE_ID,
        }) as Partial<Point>[];
        if (typeof hit?.dataIndex !== "number") return;
        // Extended to where that bar stops covering time. A daily bar stamped at
        // its own midnight otherwise resolves, on a minute peer, to the *first*
        // minute of its day — the same skew the window takes pains to undo.
        const timestamp = barEndOf(
          barTimestamps(source.getDataList()),
          hit.dataIndex,
          coarseBarSpanMs(source.getPeriod()),
        );
        if (typeof timestamp !== "number") return;
        for (const peer of peers) {
          // `undefined` is a real answer: a peer whose first page has not landed
          // has no coordinate for this instant, and reading `.x` off it would take
          // the whole bus down with the pointer.
          const pixel = peer.convertToPixel({ timestamp }, { paneId: MAIN_PANE_ID }) as {
            x?: number;
          } | null;
          const payload = crosshairPayload(pixel?.x, MAIN_PANE_ID);
          if (payload) peer.executeAction("onCrosshairChange", payload);
        }
      };

      const peers = live.filter((peer) => peer !== source);
      const clearPeers = () => {
        for (const peer of peers) peer.executeAction("onCrosshairChange", CLEAR_CROSSHAIR);
      };

      source.subscribeAction("onZoom", onGesture);
      source.subscribeAction("onScroll", onGesture);
      source.subscribeAction("onCrosshairChange", onCrosshair);
      // The pointer leaving has to be watched for on the element itself. The
      // store's own mouseleave calls `setCrosshair()` with no argument, which
      // clears *its* cursor but never announces anything: the notify at dist
      // 14092 requires `isString(this._crosshair.paneId)`, and a cleared
      // crosshair has none. Read live 2026-10-06 — the source went blank and the
      // three peers stayed frozen on the last instant, which is worse than never
      // having synced at all.
      //
      // `getDom()` with no pane is the chart's own container (dist 15048), which
      // is the element the library binds its clear to (14645 → 1860). Not
      // `getDom(paneId, "main")`, the candle widget: `mouseleave` does not
      // bubble, so a listener there fires when the pointer steps off the candles
      // — onto the y-axis of the same chart — while the source still shows its
      // cursor. Measured live 2026-10-06: the widget arm blanked all three peers
      // on a gesture that never left the chart.
      const host = source.getDom();
      host?.addEventListener("mouseleave", clearPeers);
      teardown.push(() => {
        host?.removeEventListener("mouseleave", clearPeers);
        source.unsubscribeAction("onZoom", onGesture);
        source.unsubscribeAction("onScroll", onGesture);
        source.unsubscribeAction("onCrosshairChange", onCrosshair);
      });
    }
    return () => {
      for (const off of teardown) off();
    };
  }, [charts, sync]);

  const pickSymbol = (next: string) => {
    const cleaned = next.trim().toUpperCase();
    if (!cleaned) return;
    // The periods a cell may hold is a property of the instrument, not of the
    // last click, so a switch to a crypto pair has to drop the minute cells
    // that cannot be served. Both reads take `intervals` *before* the repair,
    // since the repaired list is by definition servable and reports nothing
    // blocked.
    setBlockedNotice(blockedAny(cleaned, intervals));
    setIntervals(intervalsForSymbol(cleaned, intervals));
    setSymbol(cleaned);
    setDraft(cleaned);
  };

  // Guarded as well as disabled: the options are greyed out by `intervalAllowed`,
  // but a programmatic change (`fireEvent`, an autofill, a future refactor that
  // drops the `disabled`) must not be able to put a period on a cell the symbol
  // cannot serve — the repo has already shipped that exact asymmetry once.
  const setCellInterval = (index: number, value: IntervalKey) =>
    setIntervals((current) => {
      const next = [...current];
      next[index] = repairInterval(symbol, value);
      return next;
    });

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        <div className="w-64 max-w-full">
          <SymbolCombobox
            value={draft}
            onChange={setDraft}
            onPick={pickSymbol}
            ariaLabel="多周期看盘标的"
            placeholder="600519.SH / 茅台 / AAPL"
            drop="down"
            limit={8}
          />
        </div>
        <button
          type="button"
          onClick={() => setSync((s) => !s)}
          className="flex items-center gap-1.5 rounded-md border border-black/15 px-2 py-1 text-xs hover:bg-black/5 dark:border-white/20 dark:hover:bg-white/10"
          title="四张图的十字光标与时间窗口互相对齐"
        >
          {sync ? <Link2 className="h-3.5 w-3.5" /> : <Link2Off className="h-3.5 w-3.5" />}
          {sync ? "联动开" : "联动关"}
        </button>
        <span className="text-[11px] text-black/45 dark:text-white/40">
          滚轮缩放或拖动任一图，其余对齐到同一段时间
        </span>
      </div>

      <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-2 gap-2">
        {intervals.map((interval, i) => (
          <ChartCell
            key={i}
            symbol={symbol}
            interval={interval}
            dark={dark}
            onChart={chartSlots.current[i]}
            headerRight={
              <select
                value={interval}
                onChange={(e) => setCellInterval(i, e.target.value as IntervalKey)}
                className="shrink-0 rounded border border-black/15 bg-transparent px-1 py-0.5 text-[11px] dark:border-white/20"
                aria-label={`第 ${i + 1} 格周期`}
              >
                {INTERVALS.map((o) => (
                  <option key={o.key} value={o.key} disabled={!intervalAllowed(symbol, o.key)}>
                    {o.label}
                  </option>
                ))}
              </select>
            }
          />
        ))}
      </div>

      {blockedNotice && (
        <div className="shrink-0 text-[11px] text-black/50 dark:text-white/45">
          {symbol} 没有分钟级数据源，分钟格已自动改回日线。
        </div>
      )}
    </div>
  );
}

/** Any cell asking for a period the symbol cannot serve? Judged against what was
 *  *asked for*, never against a repaired list — a repaired list is clean by
 *  construction, which is what made this question always answer "no" and the
 *  construction, which is what made the page's one-line explanation unreachable. */
export function blockedAny(symbol: string, intervals: readonly IntervalKey[]): boolean {
  return intervals.some((iv) => !intervalAllowed(symbol, iv));
}
