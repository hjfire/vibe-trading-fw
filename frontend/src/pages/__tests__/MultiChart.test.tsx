/**
 * The multi-timeframe grid (local custom): four cells, four periods, one clock.
 *
 * What this file can and cannot show, stated up front because the difference
 * decides how much to trust the rest of it.
 *
 * The fake chart below models the library's *consequences*, not just its call
 * list: `setBarSpace` re-derives the visible range, `setOffsetRightDistance`
 * converts the pixels it is handed into a bar count at the spacing in force,
 * `scrollToTimestamp` is `scrollByDistance` underneath, and `$zoom` / `$scroll`
 * are the wheel and the drag — the two gestures the page listens to. That is what
 * lets an assertion ask "did that peer end up looking at the same span of time"
 * instead of "was it called with something". What no fake can show is that the
 * real `_adjustVisibleRange` agrees with this arithmetic; that is the browser
 * pass. `lib/__tests__/mtfSync.test.ts` is where the arithmetic itself is pinned.
 *
 * The six that would hurt most if they broke:
 * - a page landing treated as a gesture. `onVisibleRangeChange` fires from
 *   `_adjustVisibleRange` (dist 13568), which runs on every data arrival, so
 *   listening to it lets the first feed to land drag the other three onto its own
 *   window — and the real feeds are wildly uneven (a thousand daily bars against
 *   five days of minutes). Found live, not here; see "does not treat a landing
 *   page as a gesture".
 * - a crosshair keyed off `event.timestamp`. The store hands subscribers the
 *   *parameter it received* (dist 14093), and the mouse path builds `{x, y,
 *   paneId}` (2547) — the resolved `timestamp` exists only on the store's own
 *   `_crosshair`, so a handler that reads it off the event never fires. This one
 *   was invisible for exactly the reason this file exists: the first version of
 *   `$mouseMove` below emitted the enriched object, and all 32 tests stayed green
 *   while the browser synced nothing.
 * - a crosshair that travels as a *timestamp* instead of a pixel: the store
 *   resolves `cr.x` alone and falls through to `dataList.length - 1`, so the peer
 *   snaps to its newest bar and all four look synchronised while none is;
 * - the echo loop: aligning a peer ends in `onScroll`, which washes straight back
 *   into the source unless the re-entrancy gate drops it;
 * - a peer that cannot align (no bars yet, or none inside the window) has to keep
 *   its own view rather than zoom to "zero bars in window", which reads as blank;
 * - a stale session must not leave a minute cell on a symbol with no minute
 *   source, and the user has to be *told* the cell was moved.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DataLoader, KLineData, Period, SymbolInfo } from "klinecharts";

import { MultiChart, blockedAny, intervalsForSymbol, readSession, CELL_COUNT } from "../MultiChart";
import { intervalToPeriod } from "@/lib/marketApi";
import { barTimestamps, coarseBarSpanMs, countWithin, windowOfIndices } from "@/lib/mtfSync";

const SESSION_KEY = "multi-chart.session.v1";
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
/** Monday 2026-09-07 09:30 Beijing is day 0 of the *daily* history; every period
 *  is generated backwards from the same newest day, because four cells whose
 *  feeds end on four different dates would make "did they line up" unanswerable. */
const DAY_START = Date.parse("2026-09-07T09:30:00+08:00");
const LAST_DAY = 999;
/** The price pane's width the fake reports. jsdom itself answers 0, which is a
 *  meaningful input (`rangePlan` reads it as "leave this peer alone"), and one
 *  test sets it that way on purpose. */
const PANE_WIDTH = 1000;
/** How many handler invocations one fan-out may cause before the fake refuses.
 *  A user gesture costs four (the source plus three gated echoes), so anything
 *  near this number is an oscillation, not a fan-out. */
const ECHO_CAP = 60;

/**
 * Where each period's bars sit inside one A-share session, in minutes after
 * 09:30 (330 is the 15:00 close).
 *
 * The minute series are close-stamped because that is what the loaders emit —
 * the hourly cells of a session read 10:30, 11:30, 14:00, 15:00. The daily bar
 * is *not* stamped at its own close: read off the live grid on 2026-10-06 a
 * daily bar arrives as `2026-09-30T00:00:00Z`, a whole session before the first
 * minute bar of that date. So the four feeds do not end on one instant, and the
 * fixture must not pretend they do — "every period has a bar at 15:00" is
 * exactly the fiction that let a window ending on a daily bar look aligned while
 * it cut the intraday cells off at the start of the day.
 */
const SESSION_OFFSETS: Record<string, number[]> = {
  "1D": [-570],
  "1m": Array.from({ length: 240 }, (_, k) => (k < 120 ? k + 1 : 150 + (k - 119))),
  "5m": Array.from({ length: 48 }, (_, k) => (k < 24 ? (k + 1) * 5 : 210 + (k - 23) * 5)),
  "15m": [15, 30, 45, 60, 75, 90, 105, 120, 225, 240, 255, 270, 285, 300, 315, 330],
  "30m": [30, 60, 90, 120, 240, 270, 300, 330],
  "60m": [60, 120, 270, 330],
};

/** Days of history per period, sized so each feed answers just over two pages. */
const HISTORY_DAYS: Record<string, number> = {
  "1D": 1000,
  "1m": 5,
  "5m": 21,
  "15m": 63,
  "30m": 125,
  "60m": 250,
};

function barsOf(interval: string): KLineData[] {
  const offsets = SESSION_OFFSETS[interval] ?? SESSION_OFFSETS["1D"];
  const days = HISTORY_DAYS[interval] ?? 20;
  const out: KLineData[] = [];
  for (let d = LAST_DAY - days + 1; d <= LAST_DAY; d++) {
    for (const off of offsets) {
      const close = 100 + d * 0.5;
      out.push({
        timestamp: DAY_START + d * DAY + off * MINUTE,
        open: close,
        high: close,
        low: close,
        close,
        volume: 1000 + d,
      } as KLineData);
    }
  }
  return out;
}

/** The newest `count` bars strictly older than `before` (all of them when there
 *  is none) — the shape `/market/kline` has, with no `after` parameter. */
function backendPage(interval: string, before: number | null, count: number): KLineData[] {
  const all = barsOf(interval);
  let upto = all.length;
  if (before !== null && before !== undefined) {
    const at = all.findIndex((b) => b.timestamp >= before);
    if (at >= 0) upto = at;
  }
  return all.slice(Math.max(0, upto - count), upto);
}

const h = vi.hoisted(() => ({
  charts: [] as Array<Record<string, unknown>>,
  requests: [] as Array<Record<string, unknown>>,
  /** `fetchKline` rejects for this interval, simulating one dead cell. */
  failInterval: null as string | null,
  inFlight: 0,
  paneWidth: 1000,
  /** Times one of the page's *movement* handlers ran (gated echoes included), so
   *  a fan-out is counted, not just observed. */
  busEvents: 0,
  /** Events refused because the cap ran out: a non-zero number here *is* the
   *  oscillation, and every sync test asserts it stayed at zero. */
  echoOverflow: 0,
  /** Every write to a chart, tagged with which chart, so call *order* is
   *  observable and not just call presence. */
  applyLog: [] as Array<{ chart: number; call: string; value: unknown }>,
  localePatches: [] as Array<{ tag: string; patch: Record<string, string> }>,
}));

/** The fake's state plus the few methods the tests drive it with. The page's own
 *  calls are declared loosely: this object is the double, and what the page sees
 *  of it is the real `Chart` type. */
interface FakeChart {
  id: number;
  symbol: SymbolInfo | null;
  period: Period | null;
  list: KLineData[];
  loader: DataLoader | null;
  loading: boolean;
  disposed: boolean;
  barSpace: number;
  /** The right margin as the store holds it — a *bar count* (dist 13694). */
  offsetRightBars: number;
  /** Index parked at the right edge of the data area; -1 is the newest bar. */
  anchorIndex: number;
  subs: Map<string, Set<(data?: unknown) => void>>;
  cursorIndex: number | null;
  pixelsAsked: Array<Record<string, unknown>>;
  actions: Array<{ type: string; data: unknown }>;
  subscribed: string[];
  unsubscribed: string[];
  indicators: string[];
  spaceCalls: number[];
  offsetCalls: Array<{ distance: number; atSpace: number }>;
  scrolls: Array<{ timestamp: number; animationDuration: number }>;
  resizes: number;
  styles: unknown[];
  setBarSpace(space: number): void;
  setOffsetRightDistance(distance: number): void;
  scrollToTimestamp(timestamp: number, animationDuration?: number): void;
  /** A pointer landing on this chart: the fake's stand-in for a gesture jsdom
   *  cannot make, going through the same path the store's mouse handler does. */
  $mouseMove(timestamp: number): void;
  /** The pointer leaving: nothing reaches a subscriber, only the element. */
  $mouseLeave(): void;
  /** The pointer steps off the candles but stays inside the chart. */
  $mouseLeavePane(): void;
  /** The library's own paging trigger (`_adjustVisibleRange`, dist 13598). */
  $page(type: "forward" | "backward"): void;
  /** A wheel gesture: `StoreImp._zoom` — the spacing moves, then `onZoom`. */
  $zoom(scale: number): void;
  /** A drag gesture: `StoreImp.scroll` — the anchor moves, then `onScroll`. */
  $scroll(distance: number): void;
  /** This chart's window in absolute time, through the page's own translation. */
  $window(): { from: number; to: number } | null;}

function asFake(chart: unknown): FakeChart {
  return chart as FakeChart;
}

function gapPx(c: FakeChart): number {
  return c.offsetRightBars * c.barSpace;
}

/** How many of this chart's own bars fit in the pane, the data area being what is
 *  left of the right margin. The epsilon is the fake's rounding tolerance, not a
 *  library behaviour: `fitOffsetRight` hands back a sub-pixel remainder, so
 *  `barSpace * barCount` only equals the width up to float error. */
function barsInView(c: FakeChart): number {
  return Math.max(1, Math.floor((h.paneWidth - gapPx(c)) / c.barSpace + 1e-9));
}

function rangeOf(c: FakeChart): { from: number; to: number } {
  const last = Math.max(0, c.list.length - 1);
  const anchor = c.anchorIndex < 0 ? last : Math.min(Math.max(0, c.anchorIndex), last);
  return { from: Math.max(0, anchor - barsInView(c) + 1), to: anchor };
}

/** The fake's versions of `dataIndexToCoordinate` / `coordinateToDataIndex`, which
 *  is what makes the crosshair round trip mean something. */
function pixelOfIndex(c: FakeChart, index: number): number {
  return (index - rangeOf(c).from) * c.barSpace + c.barSpace / 2;
}

function indexOfPixel(c: FakeChart, x: number): number {
  const raw = Math.round((x - c.barSpace / 2) / c.barSpace) + rangeOf(c).from;
  return Math.min(Math.max(0, raw), Math.max(0, c.list.length - 1));
}

/** The last bar of `ts` that falls inside `win` — the instant a peer's right
 *  edge should land on, since a window ending on a coarse bar ends at a moment
 *  no fine bar owns. */
function lastBarWithin(ts: number[], win: { from: number; to: number }): number | undefined {
  return ts.filter((t) => t >= win.from && t <= win.to).at(-1);
}

function nearestIndex(c: FakeChart, timestamp: number): number {
  let best = 0;
  let bestGap = Infinity;
  for (let i = 0; i < c.list.length; i++) {
    const gap = Math.abs(c.list[i].timestamp - timestamp);
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  }
  return best;
}

function emit(c: FakeChart, type: "onVisibleRangeChange" | "onZoom" | "onScroll"): void {
  const callbacks = [...(c.subs.get(type) ?? [])];
  if (!callbacks.length) return;
  if (h.busEvents >= ECHO_CAP) {
    h.echoOverflow += callbacks.length;
    return;
  }
  for (const cb of callbacks) {
    h.busEvents += 1;
    cb();
  }
}

/** The store re-derives its visible range on every movement *and* on every data
 *  arrival (dist 13568) — but that event is not what the page listens to any
 *  more, so a landing page counts as an emission with no subscriber. */
function emitRange(c: FakeChart): void {
  emit(c, "onVisibleRangeChange");
}

function log(c: FakeChart, call: string, value: unknown): void {
  h.applyLog.push({ chart: c.id, call, value });
}

/** `StoreImp.resetData` (dist 13652) clears the in-flight flag and re-asks, so a
 *  period written right after a symbol still gets its load; paging, which comes
 *  from `_adjustVisibleRange`, respects `_loading` and waits (dist 13607). */
function startLoad(c: FakeChart, type: "init" | "forward" | "backward"): void {
  if (type !== "init" && c.loading) return;
  if (!c.loader || !c.symbol || !c.period) return;
  c.loading = true;
  h.inFlight += 1;
  const finish = () => {
    c.loading = false;
    h.inFlight = Math.max(0, h.inFlight - 1);
  };
  const timestamp =
    type === "forward"
      ? (c.list[0]?.timestamp ?? null)
      : (c.list[c.list.length - 1]?.timestamp ?? null);
  void Promise.resolve(
    c.loader.getBars({
      type,
      timestamp,
      // The library hands the period it holds, which is what the cell derives the
      // request interval from — a literal here would let the wiring pass while the
      // period it just set was never used.
      period: c.period as never,
      symbol: c.symbol as never,
      callback: (data, more) => {
        const bars = (Array.isArray(data) ? data : [data]) as KLineData[];
        if (type === "forward") c.list = [...bars, ...c.list];
        else if (type === "backward") c.list = [...c.list, ...bars];
        else {
          c.list = bars;
          c.anchorIndex = -1;
        }
        void more;
        // `_addData` re-derives the visible range, and that fires the store's
        // range event — which is the one thing the page no longer subscribes to.
        // Landing a page is not a gesture, and counting these emissions is how a
        // test shows the bus stayed quiet while four feeds of different depth
        // filled up.
        emitRange(c);
      },
    }),
  )
    // The cell writes its own header state *after* the callback (last price,
    // source, error), so the in-flight counter the tests wait on tracks the whole
    // `getBars`, not just the data hand-off. Released here, `settle()` returned
    // while those `setState` calls were still queued and React logged them as
    // happening outside `act`.
    .then(finish, finish);
}

vi.mock("klinecharts", () => ({
  init: () => {
    // The state fields carry their types explicitly: an object literal that starts
    // out `null` / `[]` is inferred as `null` / `never[]`, and every later write
    // then fails to type-check.
    // Two real nodes, because the bus hangs a `mouseleave` listener on one of
    // them — the store never announces a cleared cursor, so that is the only way
    // the page learns the pointer went away. They are separate elements for the
    // reason that decides which gesture clears: `getDom()` is the chart's own
    // container (dist 15048, where the library binds its clear at 14645 → 1860)
    // and `getDom(paneId, "main")` is the candle widget inside it (15039).
    // `mouseleave` does not bubble, so a listener on one never fires for the
    // other, and one of those two is a gesture that has not left the chart.
    const host = document.createElement("div");
    const mainWidget = document.createElement("div");
    host.appendChild(mainWidget);
    const rect = () =>
      ({
        width: h.paneWidth,
        height: 200,
        top: 0,
        left: 0,
        right: h.paneWidth,
        bottom: 200,
        x: 0,
        y: 0,
      }) as DOMRect;
    host.getBoundingClientRect = rect;
    mainWidget.getBoundingClientRect = rect;
    const c = {
      id: h.charts.length,
      symbol: null as SymbolInfo | null,
      period: null as Period | null,
      list: [] as KLineData[],
      loader: null as DataLoader | null,
      loading: false,
      disposed: false,
      // The library's own defaults: 10px a bar and an 80px right margin, which at
      // that spacing is 8 bars (dist 13056-13057).
      barSpace: 10,
      offsetRightBars: 8,
      anchorIndex: -1,
      subs: new Map<string, Set<(data?: unknown) => void>>(),
      cursorIndex: null as number | null,
      pixelsAsked: [] as Array<Record<string, unknown>>,
      actions: [] as Array<{ type: string; data: unknown }>,
      subscribed: [] as string[],
      unsubscribed: [] as string[],
      indicators: [] as string[],
      spaceCalls: [] as number[],
      offsetCalls: [] as Array<{ distance: number; atSpace: number }>,
      scrolls: [] as Array<{ timestamp: number; animationDuration: number }>,
      resizes: 0,
      styles: [] as unknown[],
      getSymbol: () => c.symbol,
      getPeriod: () => c.period,
      getDataList: () => c.list,
      getVisibleRange: () => rangeOf(c),
      getBarSpace: () => ({
        bar: c.barSpace,
        halfBar: c.barSpace / 2,
        gapBar: c.barSpace,
        halfGapBar: c.barSpace / 2,
      }),
      getOffsetRightDistance: () => c.offsetRightBars * c.barSpace,
      getIndicators: () => c.indicators.map((name: string) => ({ name, paneId: "candle_pane" })),
      getOverlays: () => [],
      getDom: (paneId?: string, position?: string) =>
        paneId === undefined ? host : position === "main" ? mainWidget : null,
      applyOptions: () => {},
      setStyles: (s: unknown) => {
        c.styles.push(s);
        return true;
      },
      resize: () => {
        c.resizes += 1;
      },
      createIndicator: (value: { name: string }) => {
        // Never idempotent, because the library is not (`ChartImp.createIndicator`
        // mints a fresh id, dist 15270), so a cell that re-ran this on every symbol
        // change would stack one legend row per change.
        c.indicators.push(value.name);
        return true;
      },
      removeIndicator: () => true,
      setDataLoader: (loader: DataLoader) => {
        c.loader = loader;
      },
      // Deliberately *not* de-duplicated by value: the library compares the object
      // it is handed by reference (dist 15083, 15093) and reloads on every new one,
      // so the only thing standing between a symbol switch and eight requests for a
      // four-cell grid is the cell's own guard. A fake that quietly refused the
      // repeat would hide that wiring entirely.
      setSymbol: (symbol: SymbolInfo) => {
        // Replaced, not merged: the store merges the precisions it holds, but no
        // assertion here reads them — only `getSymbol().ticker`, which is what the
        // cell's own guard compares against.
        c.symbol = symbol;
        startLoad(c, "init");
      },
      setPeriod: (period: Period) => {
        c.period = period;
        startLoad(c, "init");
      },
      setBarSpace: (space: number) => {
        // Outside the library's own window this returns without doing anything —
        // not clamping, so a plan that ignored the limits would silently fit
        // nothing (dist 13666).
        if (space < 1 || space > 50) return false;
        c.barSpace = space;
        c.spaceCalls.push(space);
        log(c, "setBarSpace", space);
        emitRange(c);
        return true;
      },
      setOffsetRightDistance: (distance: number) => {
        c.offsetRightBars = distance / c.barSpace;
        c.offsetCalls.push({ distance, atSpace: c.barSpace });
        log(c, "setOffsetRightDistance", distance);
        emitRange(c);
        return true;
      },
      scrollToTimestamp: (timestamp: number, animationDuration?: number) => {
        if (!c.list.length) return;
        const before = c.anchorIndex;
        c.anchorIndex = nearestIndex(c, timestamp);
        c.scrolls.push({ timestamp, animationDuration: animationDuration ?? 0 });
        log(c, "scrollToTimestamp", timestamp);
        // Unanimated, this is synchronous in the store (dist 15626) — and it is
        // `scrollByDistance` all the way down (15639 → 15613 → 13741), so it ends
        // in an `onScroll`, which is exactly the event the page now listens to.
        // A peer the page has just aligned therefore answers, and the gate has to
        // drop that answer.
        if (!animationDuration) {
          emit(c, "onVisibleRangeChange");
          if (c.anchorIndex !== before) emit(c, "onScroll");
        }
      },
      scrollToRealTime: () => {
        const before = c.anchorIndex;
        c.anchorIndex = -1;
        emit(c, "onVisibleRangeChange");
        if (c.anchorIndex !== before) emit(c, "onScroll");
      },
      convertToPixel: (point: Record<string, unknown>) => {
        c.pixelsAsked.push(point);
        if (!c.list.length || typeof point?.timestamp !== "number") return undefined;
        return { x: pixelOfIndex(c, nearestIndex(c, point.timestamp)), y: 0 };
      },
      /** The mirror of `convertToPixel`, and the only way an event carrying a
       *  pixel can be turned back into an instant. */
      convertFromPixel: (coordinates: Record<string, unknown>[]) => {
        const x = (Array.isArray(coordinates) ? coordinates[0] : coordinates)?.x as
          | number
          | undefined;
        if (!c.list.length || typeof x !== "number") return [{ timestamp: undefined }];
        const index = indexOfPixel(c, x);
        return [{ dataIndex: index, timestamp: c.list[index].timestamp }];
      },
      createOverlay: () => null,
      removeOverlay: () => true,
      overrideOverlay: () => true,
      subscribeAction: (type: string, cb: (data?: unknown) => void) => {
        c.subscribed.push(type);
        if (!c.subs.has(type)) c.subs.set(type, new Set());
        (c.subs.get(type) as Set<(data?: unknown) => void>).add(cb);
      },
      unsubscribeAction: (type: string, cb: (data?: unknown) => void) => {
        c.unsubscribed.push(type);
        c.subs.get(type)?.delete(cb);
      },
      executeAction: (type: string, data?: unknown) => {
        c.actions.push({ type, data });
        if (type === "onCrosshairChange") {
          // `StoreImp.setCrosshair` resolves the bar from `cr.x` and *nothing else*,
          // falling through to the newest bar when x is not a number — and
          // `ChartImp.executeAction` applies it with `notExecuteAction`, so a peer
          // cannot echo a crosshair back. Both halves are what the crosshair tests
          // below rest on. The third half: only a *nullish* payload reaches
          // `setCrosshair` as `{}` (dist 15740), because an object gets a
          // `paneId` filled in (15742) and therefore still draws.
          if (data === null || data === undefined) {
            c.cursorIndex = null;
            return;
          }
          const payload = data as { x?: number } | undefined;
          c.cursorIndex = c.list.length
            ? typeof payload?.x === "number"
              ? indexOfPixel(c, payload.x)
              : c.list.length - 1
            : null;
          return;
        }
        for (const cb of [...(c.subs.get(type) ?? [])]) cb(data);
      },
      $mouseMove: (timestamp: number) => {
        if (!c.list.length) return;
        const index = nearestIndex(c, timestamp);
        c.cursorIndex = index;
        // Exactly what a subscriber gets: `StoreImp.setCrosshair` builds the
        // resolved cursor into `this._crosshair` (dist 14090) but hands the
        // callback the *parameter it received* (14093), and the mouse path
        // builds `{x, y, paneId}` (2547). No `dataIndex`, no `timestamp` — a
        // fake that put them here lets the page read an instant the browser
        // never sends, which is how a timestamp-keyed bus passed every test
        // while syncing nothing on screen.
        const payload = { x: pixelOfIndex(c, index), y: 0, paneId: "candle_pane" };
        for (const cb of [...(c.subs.get("onCrosshairChange") ?? [])]) cb(payload);
      },
      /** `Event.mouseLeaveEvent` (dist 2519) calls `setCrosshair()` with no
       *  argument, and the notify at 14092 needs a `paneId` the cleared cursor no
       *  longer has — so the source's own subscribers hear *nothing* about a
       *  leave. Only the element sees it, which is why the page listens there: on
       *  the chart's own container, the node the library binds to. */
      $mouseLeave: () => {
        c.cursorIndex = null;
        host.dispatchEvent(new MouseEvent("mouseleave"));
      },
      /** Stepping off the candles onto the same chart's y-axis. The candle widget
       *  gets a `mouseleave`, which does not bubble, but the chart container does
       *  not — the pointer is still inside the chart, so the source keeps showing
       *  its cursor and the peers have to keep theirs. */
      $mouseLeavePane: () => {
        mainWidget.dispatchEvent(new MouseEvent("mouseleave"));
      },
      $page: (type: "forward" | "backward") => startLoad(c, type),
      /** The wheel. `StoreImp._zoom` (dist 14020-14035) lands the scale in
       *  `setBarSpace` and only then fires `onZoom`, and only when the spacing
       *  actually moved — hitting the library's [1,50] limit is silence. */
      $zoom: (scale: number) => {
        const before = c.barSpace;
        c.setBarSpace(Math.round(c.barSpace * (1 + scale) * 100) / 100);
        if (c.barSpace !== before) emit(c, "onZoom");
      },
      /** The drag. `StoreImp.scroll` (dist 13741-13759) converts the pixel
       *  distance to a bar count at the spacing then in force, re-derives the
       *  range, and fires `onScroll` only if something really moved. */
      $scroll: (distance: number) => {
        const last = Math.max(0, c.list.length - 1);
        const at = c.anchorIndex < 0 ? last : c.anchorIndex;
        const next = Math.min(last, Math.max(0, at - Math.round(distance / c.barSpace)));
        if (next === at) return;
        c.anchorIndex = next;
        emit(c, "onVisibleRangeChange");
        emit(c, "onScroll");
      },
      // The page's own translation, coarse extension included: reading a daily
      // cell's window without it would report the window the bus never sends.
      $window: () =>
        windowOfIndices(barTimestamps(c.list), rangeOf(c), coarseBarSpanMs(c.period)),
    };
    h.charts.push(c as unknown as Record<string, unknown>);
    return c;
  },
  dispose: (chart: unknown) => {
    asFake(chart).disposed = true;
  },
  registerIndicator: () => true,
  registerOverlay: () => true,
  getSupportedLocales: () => ["en-US", "zh-CN"],
  // Patched, not asserted: `ensurePeriodUnitLabels` runs before the first `init`,
  // and `klineLocale.test.ts` owns that rule.
  registerLocale: (tag: string, ls: Record<string, string>) => {
    h.localePatches.push({ tag, patch: ls });
  },
  version: () => "test",
}));

// Only `fetchKline` is replaced: `INTERVALS`, `intervalToPeriod` and
// `periodToInterval` stay real, because "which bars this cell ended up asking
// for" is the thing under test.
vi.mock("@/lib/marketApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/marketApi")>();
  return {
    ...actual,
    fetchKline: async (params: Record<string, unknown>) => {
      h.requests.push(params);
      const interval = String(params.interval);
      if (interval === h.failInterval) throw new Error(`no source for ${interval}`);
      return {
        status: "ok",
        symbol: params.symbol,
        interval,
        source: `fake:${interval}`,
        bars: backendPage(interval, (params.before as number | null) ?? null, Number(params.count)),
      };
    },
  };
});

type IntervalKey = Parameters<typeof intervalToPeriod>[0];

/** The cell showing `interval`, found by the period it pushed onto the chart
 *  rather than by creation order, so a test that reorders the grid still means
 *  what it says. */
function chart(interval: IntervalKey): FakeChart {
  const want = intervalToPeriod(interval);
  const found = h.charts.find(
    (c) => asFake(c).period?.type === want.type && asFake(c).period?.span === want.span,
  );
  if (!found) throw new Error(`no chart holds ${interval}`);
  return asFake(found);
}

async function settle(): Promise<void> {
  for (let round = 0; round < 40 && h.inFlight > 0; round++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0));
    });
  }
}

function seed(stored: unknown): void {
  localStorage.setItem(SESSION_KEY, typeof stored === "string" ? stored : JSON.stringify(stored));
}

async function mount(): Promise<void> {
  render(<MultiChart />);
  await settle();
}

/** `cell` is 1-based, matching the number the page puts in the aria-label, so a
 *  test that says "the second cell" cannot accidentally mean the first one. */
function selectOf(cell: number): HTMLSelectElement {
  return screen.getByLabelText(`第 ${cell} 格周期`) as HTMLSelectElement;
}

/** Put one chart in a known zoom: 20 bars of data in the pane, no right margin.
 *  Called before the counters are cleared, so each sync test starts from the same
 *  view instead of from whatever the four landing pages happened to leave. */
function zoomedOut(c: FakeChart): void {
  c.setBarSpace(20);
  c.setOffsetRightDistance(0);
}

/** Forget the fan-out that got us here; a test then measures only its own gesture. */
function freshCounters(): void {
  h.busEvents = 0;
  h.echoOverflow = 0;
  h.applyLog = [];
}

/** The three writes one peer received, in order, since `freshCounters`. */
function appliedTo(c: FakeChart): string[] {
  return h.applyLog.filter((e) => e.chart === c.id).map((e) => e.call);
}

const PEERS: IntervalKey[] = ["60m", "15m", "5m"];

beforeEach(() => {
  localStorage.clear();
  h.charts = [];
  h.requests = [];
  h.failInterval = null;
  h.inFlight = 0;
  h.paneWidth = PANE_WIDTH;
  h.busEvents = 0;
  h.echoOverflow = 0;
  h.applyLog = [];
});

describe("the stored view", () => {
  it("defaults to one daily anchor and three intraday levels", () => {
    localStorage.removeItem(SESSION_KEY);
    expect(readSession()).toEqual({
      symbol: "600519.SH",
      intervals: ["1D", "60m", "15m", "5m"],
      sync: true,
      blocked: false,
    });
  });

  it("drops the minute cells a symbol cannot serve, and says so", () => {
    seed({ symbol: "btcusdt", intervals: ["1D", "60m", "15m", "5m"], sync: true });
    const s = readSession();
    expect(s.symbol).toBe("BTCUSDT");
    expect(s.intervals).toEqual(["1D", "1D", "1D", "1D"]);
    // Read off what was *asked for*. Judging the repaired list — which is what this
    // did first — always answers "nothing was blocked", and then the page's
    // explanation is unreachable prose.
    expect(s.blocked).toBe(true);
  });

  it("fills a short or corrupt intervals array up to four usable periods", () => {
    // Filled *by position* from the defaults, so a stored array of the wrong
    // length still yields four cells and keeps the ones the user did name.
    seed({ symbol: "0700.HK", intervals: ["15m"] });
    expect(readSession().intervals).toEqual(["15m", "60m", "15m", "5m"]);
    seed({ symbol: "0700.HK", intervals: ["nope", "1W", 7, null] });
    expect(readSession().intervals).toEqual(["1D", "1W", "15m", "5m"]);
    // A position that names a period the symbol cannot serve is repaired, not
    // dropped, so the grid never ends up with a hole in it.
    seed({ symbol: "AAPL.US", intervals: ["1W", "1m", "15m"] });
    expect(readSession().intervals).toEqual(["1W", "1m", "15m", "5m"]);
    expect(readSession().blocked).toBe(false);
    seed({ symbol: "EURUSD", intervals: ["1D", "1m"] });
    expect(readSession().intervals).toEqual(["1D", "1D", "1D", "1D"]);
    expect(readSession().blocked).toBe(true);
  });

  it("survives garbage in the slot instead of taking the page down", () => {
    for (const junk of ["", "{", "null", "[]", '"x"', '{"intervals":42}']) {
      seed(junk);
      expect(readSession().intervals).toHaveLength(CELL_COUNT);
    }
  });

  it("keeps the link on unless it was switched off", () => {
    seed({ symbol: "0700.HK", intervals: ["1D"], sync: false });
    expect(readSession().sync).toBe(false);
    seed({ symbol: "0700.HK", intervals: ["1D"], sync: "off" });
    expect(readSession().sync).toBe(true);
  });

  it("re-checks every cell when the symbol changes", () => {
    const current: IntervalKey[] = ["1D", "60m", "15m", "5m"];
    expect(intervalsForSymbol("AAPL.US", current)).toEqual(["1D", "60m", "15m", "5m"]);
    expect(intervalsForSymbol("EURUSD", current)).toEqual(["1D", "1D", "1D", "1D"]);
    // A longer list still yields exactly four, and a shorter one no holes.
    expect(intervalsForSymbol("EURUSD", [...current, "1W"])).toHaveLength(CELL_COUNT);
    expect(intervalsForSymbol("AAPL.US", ["1D"])).toHaveLength(CELL_COUNT);
  });

  it("only calls a period blocked when the symbol truly cannot serve it", () => {
    expect(blockedAny("600519.SH", ["60m"])).toBe(false);
    expect(blockedAny("600519.SH", ["1W"])).toBe(false);
    expect(blockedAny("XAUUSD", ["1D", "5m"])).toBe(true);
    expect(blockedAny("XAUUSD", ["1D", "1W", "1M"])).toBe(false);
  });
});

describe("mounting the grid", () => {
  it("asks for one page per cell, at that cell's period", async () => {
    await mount();
    // One request per cell, not two. The library will not load until it has both a
    // symbol and a period, and the cell must not re-ask for a period the chart
    // already holds — an unguarded setSymbol + setPeriod pair costs eight.
    expect(h.requests).toHaveLength(CELL_COUNT);
    expect(h.requests.map((r) => r.interval)).toEqual(["1D", "60m", "15m", "5m"]);
    expect(h.requests.map((r) => r.symbol)).toEqual(Array(CELL_COUNT).fill("600519.SH"));
    expect(new Set(h.requests.map((r) => r.count))).toEqual(new Set([500]));
    expect(new Set(h.requests.map((r) => r.before))).toEqual(new Set([null]));
  });

  it("draws four cells, four period names and the sync affordance", async () => {
    await mount();
    for (const label of ["日线", "60分", "15分", "5分"]) {
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    expect(screen.getByRole("button", { name: /联动开/ })).toBeTruthy();
    expect(screen.queryByText(/没有分钟级数据源/)).toBeNull();
  });

  it("puts exactly one MA on each chart", async () => {
    await mount();
    expect(h.charts).toHaveLength(CELL_COUNT);
    for (const c of h.charts) expect(asFake(c).indicators).toEqual(["MA"]);
  });

  it("names the cells a stale session had to move", async () => {
    seed({ symbol: "XAUUSD", intervals: ["1D", "60m", "15m", "5m"], sync: true });
    await mount();
    expect(screen.getByText(/没有分钟级数据源/).textContent).toContain("XAUUSD");
    expect(h.requests.every((r) => r.interval === "1D")).toBe(true);
    expect(h.charts).toHaveLength(CELL_COUNT);
    // Four daily cells look identical, so the picker has to say which is which.
    expect(selectOf(1).value).toBe("1D");
  });

  it("pages one cell back through the paging contract", async () => {
    await mount();
    const daily = chart("1D");
    const oldest = daily.list[0].timestamp;
    // The trigger, not the assertion: `getBars` sets the cell's own loading state
    // before its first await, so the call that starts a page belongs inside `act`
    // for the same reason a click does.
    act(() => {
      daily.$page("forward");
    });
    await settle();
    const dailyRequests = h.requests.filter((r) => r.interval === "1D");
    // `forward` means *older*: the cap that goes out is the oldest bar held.
    expect(dailyRequests.at(-1)?.before).toBe(oldest);
    expect(daily.list[0].timestamp).toBeLessThan(oldest);
    // And nothing it already had comes back, which is what made the first version
    // of this page loop.
    expect(new Set(daily.list.map((b) => b.timestamp)).size).toBe(daily.list.length);
  });

  it("keeps a cell that failed to load apart from the rest", async () => {
    h.failInterval = "5m";
    await mount();
    const five = chart("5m");
    expect(five.list).toHaveLength(0);
    expect(screen.getAllByText("取数失败").length).toBe(1);
    expect(screen.getAllByText("fake:60m").length).toBe(1);
  });

  it("survives a storage it cannot write to", async () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    await mount();
    expect(h.charts).toHaveLength(CELL_COUNT);
    expect(chart("1D").list.length).toBeGreaterThan(0);
  });
});

describe("the crosshair", () => {
  it("moves each peer to its own bar for the source's instant", async () => {
    await mount();
    const daily = chart("1D");
    // A bar near the newest so it is inside the pane, and still nowhere near the
    // newest bar of a peer whose spacing differs — "the last bar" is the wrong
    // answer the store gives if it is handed a payload without an x.
    const stamp = daily.list[daily.list.length - 4].timestamp;
    // What travels is the *end* of that daily bar, not its stamp: the stamp is
    // midnight, and a peer resolving midnight lands on a different session.
    const end = stamp + DAY - 1;
    daily.$mouseMove(stamp);

    for (const interval of PEERS) {
      const peer = chart(interval);
      expect(peer.cursorIndex).not.toBeNull();
      expect(peer.cursorIndex).toBe(nearestIndex(peer, end));
      expect(peer.cursorIndex).not.toBe(peer.list.length - 1);
    }
  });

  it("clears the peers when the pointer leaves the source", async () => {
    await mount();
    const daily = chart("1D");
    daily.$mouseMove(daily.list[daily.list.length - 4].timestamp);
    for (const interval of PEERS) expect(chart(interval).cursorIndex).not.toBeNull();

    // The store clears its own cursor without telling anyone (dist 14092 needs a
    // `paneId`, and a cleared crosshair has none), so this is the element's own
    // `mouseleave`. And the instruction has to be a nullish one: `{}` gets a
    // `paneId` filled in and still draws, parked on the peer's newest bar.
    daily.$mouseLeave();
    for (const interval of PEERS) {
      const peer = chart(interval);
      expect(peer.actions.at(-1)).toEqual({ type: "onCrosshairChange", data: null });
      expect(peer.cursorIndex).toBeNull();
    }
  });

  it("keeps the peers when the pointer only leaves the candles", async () => {
    // Which element the clear hangs off is the whole difference. `mouseleave`
    // does not bubble, so a listener on the candle widget fires for a step onto
    // the same chart's y-axis — a gesture the library does not treat as leaving,
    // so the source is still showing its cursor while the peers went blank. Read
    // live 2026-10-06 on the widget arm: three peers blanked on that step.
    await mount();
    const daily = chart("1D");
    daily.$mouseMove(daily.list[daily.list.length - 4].timestamp);
    for (const interval of PEERS) expect(chart(interval).cursorIndex).not.toBeNull();

    daily.$mouseLeavePane();
    for (const interval of PEERS) {
      const peer = chart(interval);
      expect(peer.actions).toHaveLength(1); // still only the move, no clear
      expect(peer.cursorIndex).not.toBeNull();
    }
  });

  it("sends a pixel and never a bare timestamp", async () => {
    await mount();
    const daily = chart("1D");
    const stamp = daily.list[daily.list.length - 4].timestamp;
    daily.$mouseMove(stamp);

    for (const c of h.charts.map(asFake)) {
      if (c.id === daily.id) continue;
      expect(c.actions).toEqual([{ type: "onCrosshairChange", data: { x: expect.any(Number), paneId: "candle_pane" } }]);
      // Asked to convert the *instant*, once per peer: an x copied from the source
      // would land on a different bar in a peer whose spacing differs.
      expect(c.pixelsAsked).toEqual([{ timestamp: stamp + DAY - 1 }]);
    }
  });

  it("leaves a peer with nothing to draw alone", async () => {
    h.failInterval = "5m";
    await mount();
    chart("1D").$mouseMove(chart("1D").list.at(-1)!.timestamp);
    const five = chart("5m");
    expect(five.pixelsAsked).toHaveLength(1); // asked, but there were no bars
    expect(five.actions).toHaveLength(0);
    expect(five.cursorIndex).toBeNull();
    // A peer that does have data still moved.
    expect(chart("15m").cursorIndex).not.toBeNull();
  });

  it("does nothing at all when the link is off", async () => {
    seed({ symbol: "600519.SH", intervals: ["1D", "60m", "15m", "5m"], sync: false });
    await mount();
    expect(h.busEvents).toBe(0); // the four landing pages found no subscribers
    const daily = chart("1D");
    daily.$mouseMove(daily.list.at(-1)!.timestamp);
    for (const c of h.charts.map(asFake)) {
      expect(c.actions).toHaveLength(0);
      expect(c.pixelsAsked).toHaveLength(0);
    }
  });
});

describe("the time window", () => {
  it("lands every peer on the source's span, applied once each", async () => {
    await mount();
    const daily = chart("1D");
    zoomedOut(daily);
    freshCounters();
    const spaceBefore = new Map(PEERS.map((iv) => [iv, chart(iv).spaceCalls.length]));

    act(() => {
      daily.$zoom(1.5); // 20px a bar becomes 50, so the source shows twenty days
    });

    const win = daily.$window()!;
    expect(win).not.toBeNull();
    expect(daily.barSpace).toBe(50);
    for (const interval of PEERS) {
      const peer = chart(interval);
      // One application, in the order the fit requires: zoom, then the margin
      // (which the store converts at the spacing then in force), then the scroll.
      expect(appliedTo(peer)).toEqual([
        "setBarSpace",
        "setOffsetRightDistance",
        "scrollToTimestamp",
      ]);
      expect(peer.spaceCalls.length).toBe((spaceBefore.get(interval) ?? 0) + 1);
      expect(peer.offsetCalls.at(-1)?.atSpace).toBe(peer.barSpace);
      const got = peer.$window()!;
      const stamps = barTimestamps(peer.list);
      const inside = stamps.filter((t) => t >= win.from && t <= win.to);
      expect(inside.length).toBeGreaterThan(0);
      // Right edges agree to the resolution each feed can express: a peer ends on
      // *its own* last bar inside the source's window. Not on `win.to` — a window
      // that ends on a daily bar ends at an instant no minute bar owns, and
      // `scrollToTimestamp` resolves by nearest, which would hand the peer a bar
      // of the following session instead of the last one of this day.
      expect(got.to).toBe(lastBarWithin(stamps, win));
      expect(got.from).toBeGreaterThanOrEqual(win.from);
      // And it holds precisely the bars of its own that fall in that span.
      expect(countWithin(stamps, got)).toBe(inside.length);
    }
    // The gesture itself, plus one `onScroll` from each of the three peers the
    // page just aligned — `scrollToTimestamp` is `scrollByDistance` underneath, so
    // being told is also, to the library, scrolling. Every echo is dropped by the
    // gate. More than this and the peers were answering each other.
    expect(h.busEvents).toBe(4);
    expect(h.echoOverflow).toBe(0);
  });

  it("follows a scroll sideways, not only a zoom", async () => {
    await mount();
    const daily = chart("1D");
    zoomedOut(daily);
    freshCounters();

    // Dragged left by 50px a bar × 7 bars: the anchor leaves the newest bar.
    const target = daily.list[daily.list.length - 8].timestamp;
    act(() => {
      daily.$scroll(7 * 20);
    });

    const win = daily.$window()!;
    // The bar the source was dragged onto sits at its own right edge, and the
    // window reaches to the *end* of that bar rather than to its stamp — the
    // stamp is a whole session before the day's first minute bar.
    expect(win.to).toBe(target + DAY - 1);
    for (const interval of PEERS) {
      const peer = chart(interval);
      expect(appliedTo(peer)).toEqual([
        "setBarSpace",
        "setOffsetRightDistance",
        "scrollToTimestamp",
      ]);
      expect(peer.$window()!.to).toBe(lastBarWithin(barTimestamps(peer.list), win));
      expect(peer.scrolls.at(-1)?.animationDuration).toBe(0);
    }
    expect(h.busEvents).toBe(4);
    expect(h.echoOverflow).toBe(0);
  });

  it("does not treat a landing page as a gesture", async () => {
    await mount();
    // The feeds have very different depth (a thousand daily bars against five
    // days of minutes), so a broadcast caused by data arrival drags the other
    // three onto the arrival order's window. Measured live on /multi-chart on
    // 2026-10-05, that left the daily cell at the library's 50px maximum with
    // four bars in it before the user had touched anything.
    expect(h.busEvents).toBe(0);
    expect(h.echoOverflow).toBe(0);
    for (const c of h.charts.map(asFake)) {
      expect(appliedTo(c)).toEqual([]);
      // Each cell still on the library's own defaults: 10px a bar and the 8
      // empty columns of `DEFAULT_OFFSET_RIGHT_DISTANCE`.
      expect(c.barSpace).toBe(10);
      expect(c.offsetRightBars).toBe(8);
    }
    // A cell reloading is data arrival too, so it does not re-broadcast.
    fireEvent.change(selectOf(2), { target: { value: "30m" } });
    await settle();
    expect(h.busEvents).toBe(0);
    expect(appliedTo(chart("1D"))).toEqual([]);
  });

  it("keeps a peer that cannot follow on its own view", async () => {
    await mount();
    const daily = chart("1D");
    zoomedOut(daily);
    freshCounters();

    // Drag the source back until the *whole* day under its right edge predates
    // the oldest bar the 15-minute cell holds. The hourly cell reaches further
    // back, so it can follow; the two finer cells cannot, and zooming a peer to
    // "zero bars in window" would leave it blank — so it keeps what it had.
    const cutoff = chart("15m").list[0].timestamp;
    // `+ DAY` because the window now ends at the end of the bar it lands on: the
    // day whose stamp is the last thing inside the window still has its whole
    // session inside it, and a peer with bars there is obliged to follow.
    const targetIdx = daily.list.filter((b) => b.timestamp + DAY <= cutoff).length - 1;
    expect(targetIdx).toBeGreaterThan(0);
    act(() => {
      daily.$scroll((daily.list.length - 1 - targetIdx) * daily.barSpace);
    });
    const win = daily.$window()!;
    expect(countWithin(barTimestamps(chart("5m").list), win)).toBe(0);
    expect(countWithin(barTimestamps(chart("15m").list), win)).toBe(0);
    expect(countWithin(barTimestamps(chart("60m").list), win)).toBeGreaterThan(0);
    for (const interval of ["15m", "5m"] as const) {
      expect(appliedTo(chart(interval))).toEqual([]);
    }
    expect(appliedTo(chart("60m"))).toEqual([
      "setBarSpace",
      "setOffsetRightDistance",
      "scrollToTimestamp",
    ]);
    expect(h.echoOverflow).toBe(0);
  });

  it("propagates nothing from a cell whose data never arrived", async () => {
    h.failInterval = "1D";
    await mount();
    freshCounters();
    const empty = chart("1D");
    act(() => {
      empty.$zoom(1);
    });
    // No window of its own to broadcast, so no peer is touched — and the live
    // peers keep their own views rather than jumping to the oldest bar.
    expect(appliedTo(chart("60m"))).toEqual([]);
    expect(appliedTo(chart("5m"))).toEqual([]);
  });

  it("leaves the zoom alone where the pane has no measurable width", async () => {
    h.paneWidth = 0;
    await mount();
    freshCounters();
    const daily = chart("1D");
    act(() => {
      daily.$zoom(1);
    });
    for (const c of h.charts.map(asFake)) {
      if (c.id === daily.id) continue;
      expect(c.spaceCalls).toHaveLength(0);
    }
    expect(h.echoOverflow).toBe(0);
  });

  it("toggles with the link button, both ways", async () => {
    await mount();
    const daily = chart("1D");
    fireEvent.click(screen.getByRole("button", { name: /联动开/ }));
    expect(screen.getByRole("button", { name: /联动关/ })).toBeTruthy();
    freshCounters();
    act(() => {
      daily.$zoom(1);
    });
    expect(h.busEvents).toBe(0); // nothing is subscribed to tell
    for (const c of h.charts.map(asFake)) {
      if (c.id === daily.id) continue;
      expect(appliedTo(c)).toEqual([]);
    }
    // Back on: the same gesture moves the grid again.
    fireEvent.click(screen.getByRole("button", { name: /联动关/ }));
    freshCounters();
    act(() => {
      daily.$scroll(4 * daily.barSpace);
    });
    expect(h.busEvents).toBe(4);
    expect(h.echoOverflow).toBe(0);
  });

  it("unsubscribes every action from every chart on unmount", async () => {
    const view = render(<MultiChart />);
    await settle();
    expect(h.charts.every((c) => asFake(c).subscribed.length === 3)).toBe(true);
    expect(h.charts.every((c) => asFake(c).unsubscribed.length === 0)).toBe(true);
    view.unmount();
    // A dead chart with a live subscription is a leak and a crash waiting for the
    // next gesture, so this is the whole teardown claim.
    for (const c of h.charts.map(asFake)) {
      expect(c.unsubscribed).toHaveLength(3);
      expect(c.subs.get("onZoom")?.size ?? 0).toBe(0);
      expect(c.subs.get("onScroll")?.size ?? 0).toBe(0);
      expect(c.subs.get("onCrosshairChange")?.size ?? 0).toBe(0);
      expect(c.disposed).toBe(true);
    }
    freshCounters();
    act(() => {
      chart("1D").$zoom(1);
    });
    expect(h.busEvents).toBe(0);
  });

  it("still syncs a cell whose period changed", async () => {
    await mount();
    fireEvent.change(selectOf(3), { target: { value: "30m" } });
    await settle();
    const half = chart("30m");
    expect(h.requests.filter((r) => r.interval === "30m")).toHaveLength(1);
    expect(h.charts).toHaveLength(CELL_COUNT); // the cell moved, it was not rebuilt
    expect(h.charts.map(asFake).filter((c) => c.disposed)).toHaveLength(0);
    const daily = chart("1D");
    zoomedOut(daily);
    freshCounters();
    act(() => {
      daily.$zoom(1.5);
    });
    expect(appliedTo(half)).toEqual([
      "setBarSpace",
      "setOffsetRightDistance",
      "scrollToTimestamp",
    ]);
    expect(h.echoOverflow).toBe(0);
  });
});

describe("the per-cell period picker", () => {
  it("moves one cell without disturbing the other three", async () => {
    await mount();
    fireEvent.change(selectOf(2), { target: { value: "1m" } });
    await settle();
    expect(chart("1m").period).toEqual({ type: "minute", span: 1 });
    expect(chart("1D").period).toEqual({ type: "day", span: 1 });
    expect(chart("15m").period).toEqual({ type: "minute", span: 15 });
    expect(chart("5m").period).toEqual({ type: "minute", span: 5 });
    // Only the moved cell re-read.
    expect(h.requests.filter((r) => r.interval === "1m")).toHaveLength(1);
    expect(h.requests.filter((r) => r.interval === "60m")).toHaveLength(1);
  });

  it("greys out the periods this symbol cannot serve", async () => {
    seed({ symbol: "XAUUSD", intervals: ["1D", "1D", "1D", "1D"], sync: true });
    await mount();
    const blocked = Array.from(selectOf(1).options)
      .filter((o) => o.disabled)
      .map((o) => o.value);
    expect(blocked).toEqual(["1m", "5m", "15m", "30m", "60m"]);
  });

  it("refuses a blocked period even when one is set programmatically", async () => {
    seed({ symbol: "XAUUSD", intervals: ["1D", "1D", "1D", "1D"], sync: true });
    await mount();
    fireEvent.change(selectOf(1), { target: { value: "5m" } });
    await settle();
    expect(h.requests.some((r) => r.interval === "5m")).toBe(false);
    expect(selectOf(1).value).toBe("1D");
  });

  it("switching symbol re-asks every cell and repairs what it must", async () => {
    await mount();
    const before = h.requests.length;
    const input = screen.getByLabelText("多周期看盘标的") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "EURUSD" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await settle();
    const switched = h.requests.slice(before);
    // Nothing may ever ask this symbol for minute bars, and every cell has to end
    // up on a period it can actually serve.
    expect(new Set(switched.map((r) => r.symbol))).toEqual(new Set(["EURUSD"]));
    expect(new Set(switched.map((r) => r.interval))).toEqual(new Set(["1D"]));
    expect(screen.getByText(/没有分钟级数据源/).textContent).toContain("EURUSD");
    expect(screen.getAllByText("日线").length).toBeGreaterThanOrEqual(4);
    // The three cells that had to move cost two requests each: the library reloads
    // on every write, and a repair is a symbol write *and* a period write. Both ask
    // for the same intended pair, so the second is redundant traffic rather than
    // wrong data — which is the trade the cell makes deliberately.
    expect(switched).toHaveLength(1 + PEERS.length * 2);
    expect(chart("1D")).toBeTruthy();
    expect(() => chart("60m")).toThrow();
  });

  it("reloads one cell at the same period when the user asks it to", async () => {
    h.failInterval = "5m";
    await mount();
    const before = h.requests.filter((r) => r.interval === "5m").length;
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    await settle();
    // The retry has to survive the library's reference check, not be swallowed by
    // it: same period, fresh object, so it really re-reads.
    expect(h.requests.filter((r) => r.interval === "5m").length).toBe(before + 1);
  });
});
