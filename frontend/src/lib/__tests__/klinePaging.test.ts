import { describe, expect, it } from "vitest";

import { boundsOf, pagingBefore, shapeResponse } from "../klinePaging";
import type { KLineData } from "klinecharts";

/**
 * Paging contract tests for /pro-chart (local custom ⑬).
 *
 * The user-visible bug: pressing the mouse on the main chart and dragging
 * snapped the view back to where it started, over and over, and would not
 * settle. Root cause was a direction mix-up in the `DataLoader` — KLineChart
 * v10's `forward` means "older bars" and `backward` means "newer bars", the
 * opposite of how they read — so every `backward` request was answered with a
 * block of bars the chart already had, appended to its right, and the library
 * shifts the view by the length it is given (`_startLastBarRightSideDiffBarCount
 * -= data.length`).
 *
 * So these tests do not just check the helpers: they replay the library's own
 * `_addData` / trigger rules against a fake backend, once with today's code and
 * once with the old one, and require the old behaviour to still loop and the
 * new behaviour to terminate on clean, duplicate-free, unmoved data.
 */

const DAY = 86_400_000;
const START = 1_600_000_000_000;
const PAGE = 500;

function bar(timestamp: number): KLineData {
  return { timestamp, open: 1, high: 1, low: 1, close: 1, volume: 1 } as KLineData;
}

/** Ascending daily bars, `count` of them, the way /market/kline answers. */
function makeServer(total: number) {
  const all = Array.from({ length: total }, (_, i) => bar(START + i * DAY));
  return (before: number | null): KLineData[] => {
    const pool = before === null ? all : all.filter((b) => b.timestamp < before);
    return pool.slice(-PAGE);
  };
}

interface FakeStore {
  list: KLineData[];
  more: { forward: boolean; backward: boolean };
  /** Bars the library shifted the view by; 0 while paging stays honest. */
  viewShift: number;
  requests: number;
}

/** Mirrors `StoreImp._addData` + `_processDataLoad` for the fixed code. */
function loadOnce(store: FakeStore, type: "forward" | "backward", fetchPage: (b: number | null) => KLineData[]) {
  const bounds = boundsOf(store.list);
  const timestamp = type === "backward" ? bounds.newest : bounds.oldest;
  store.requests++;
  const page = shapeResponse(type, fetchPage(pagingBefore(type, timestamp, bounds)), bounds, PAGE);
  if (type === "forward") {
    store.list = [...page.bars, ...store.list]; // 13473: prepends
    store.more.forward = page.more.forward;
  } else {
    store.list = [...store.list, ...page.bars]; // 13464: appends
    store.viewShift -= page.bars.length; // 13468: ...and moves the view
    store.more.backward = page.more.backward;
  }
  return page.bars.length;
}

/** The trigger rules at dist 13598-13603, driven until nothing wants more. */
function runUntilIdle(store: FakeStore, fetchPage: (b: number | null) => KLineData[], maxRounds = 400) {
  for (let round = 0; ; round++) {
    if (round > maxRounds) throw new Error(`分页没有停止：已请求 ${store.requests} 次`);
    // A chart panned to the left edge asks forward, otherwise the right edge
    // asks backward; both are "the edge is visible" checks.
    if (store.more.forward) loadOnce(store, "forward", fetchPage);
    else if (store.more.backward) loadOnce(store, "backward", fetchPage);
    else break;
  }
  return store;
}

function freshStore(): FakeStore {
  return { list: [], more: { forward: false, backward: false }, viewShift: 0, requests: 0 };
}

function audit(list: KLineData[]) {
  const seen = new Set<number>();
  let duplicates = 0;
  let outOfOrder = 0;
  for (let i = 0; i < list.length; i++) {
    if (seen.has(list[i].timestamp)) duplicates++;
    seen.add(list[i].timestamp);
    if (i > 0 && list[i].timestamp < list[i - 1].timestamp) outOfOrder++;
  }
  return { duplicates, outOfOrder };
}

describe("boundsOf / pagingBefore", () => {
  it("reads the ends of an ascending list", () => {
    expect(boundsOf([])).toEqual({ oldest: null, newest: null });
    const list = [bar(START), bar(START + DAY), bar(START + 2 * DAY)];
    expect(boundsOf(list)).toEqual({ oldest: START, newest: START + 2 * DAY });
  });

  it("only `forward` (older bars) gets a `before` cap", () => {
    const bounds = { oldest: START, newest: START + 9 * DAY };
    // `backward` carries the *newest* timestamp and expects newer bars; sending
    // it as `before` is exactly the mistake that redelivered the newest block.
    expect(pagingBefore("backward", START + 9 * DAY, bounds)).toBeNull();
    expect(pagingBefore("forward", START, bounds)).toBe(START);
    expect(pagingBefore("init", null, bounds)).toBeNull();
    // A missing timestamp still pages from the loaded edge instead of restarting.
    expect(pagingBefore("forward", null, bounds)).toBe(START);
  });
});

describe("shapeResponse", () => {
  const bounds = { oldest: START + 10 * DAY, newest: START + 20 * DAY };
  const page = (from: number, n: number) => Array.from({ length: n }, (_, i) => bar(from + i * DAY));

  it("tells init there may be older data but never newer data", () => {
    const res = shapeResponse("init", page(START + 1 * DAY, PAGE), bounds, PAGE);
    expect(res.bars.length).toBe(PAGE);
    expect(res.more).toEqual({ forward: true, backward: false });
  });

  it("keeps only strictly older bars for a forward answer", () => {
    const res = shapeResponse("forward", page(START + 5 * DAY, 5), bounds, PAGE);
    expect(res.bars.map((b) => b.timestamp)).toEqual([START + 5 * DAY, START + 6 * DAY, START + 7 * DAY, START + 8 * DAY, START + 9 * DAY]);
    expect(res.more.backward).toBe(false);
  });

  it("an overlapping forward page yields nothing and stops the paging", () => {
    // What the old code handed back on every request: the newest block again.
    const res = shapeResponse("forward", page(START + 15 * DAY, PAGE), bounds, PAGE);
    expect(res.bars).toEqual([]);
    expect(res.more.forward).toBe(false);
  });

  it("a backward answer only ever contains bars newer than the newest", () => {
    const stale = shapeResponse("backward", page(START + 15 * DAY, 5), bounds, PAGE);
    expect(stale.bars).toEqual([]);
    expect(stale.more.backward).toBe(false);
    const fresh = shapeResponse("backward", page(START + 21 * DAY, 3), bounds, PAGE);
    expect(fresh.bars.length).toBe(3);
    expect(fresh.more.backward).toBe(false); // 3 < PAGE, so nothing more to pull
  });
});

describe("分页循环必须自己停止", () => {
  it("4000 根的标的从最新页开始，向前翻页到起点后停止", () => {
    const fetchPage = makeServer(4000);
    const store = freshStore();
    // Startup: the chart asks for the first page.
    const bounds = boundsOf(store.list);
    store.list = fetchPage(pagingBefore("init", null, bounds));
    store.more = shapeResponse("init", store.list, bounds, PAGE).more;
    store.requests = 1;

    runUntilIdle(store, fetchPage);

    expect(store.list.length).toBe(4000); // whole history, nothing invented
    expect(audit(store.list)).toEqual({ duplicates: 0, outOfOrder: 0 });
    expect(store.viewShift).toBe(0); // panning was never moved by a data load
    expect(store.requests).toBeLessThan(12); // 4000 / 500 + a closing empty page
    expect(store.more).toEqual({ forward: false, backward: false });
  });

  it("数据只有 500 根时不会反复请求（末页不足一页即停）", () => {
    const fetchPage = makeServer(500);
    const store = freshStore();
    const bounds = boundsOf(store.list);
    store.list = fetchPage(null);
    store.more = shapeResponse("init", store.list, bounds, PAGE).more;
    store.requests = 1;
    runUntilIdle(store, fetchPage);
    expect(store.list.length).toBe(500);
    expect(store.requests).toBeLessThanOrEqual(3);
    expect(audit(store.list)).toEqual({ duplicates: 0, outOfOrder: 0 });
  });

  it("回归钉：把 backward 当“更早数据”回答的旧写法会无限重复并挪动视图", () => {
    const fetchPage = makeServer(4000);
    const store = freshStore();
    store.list = fetchPage(null);
    // The old ProChart answer, verbatim: `{ backward: bars.length >= PAGE,
    // forward: false }` on init, and `before = timestamp` on "backward".
    store.more = { forward: false, backward: store.list.length >= PAGE };
    store.requests = 1;
    for (let round = 0; round < 30; round++) {
      if (!store.more.backward) break;
      const newest = store.list[store.list.length - 1].timestamp;
      const bars = fetchPage(newest); // before = newest ⇒ the same block back
      store.list = [...store.list, ...bars];
      store.viewShift -= bars.length;
      store.more = { forward: false, backward: bars.length >= PAGE };
      store.requests++;
    }
    const { duplicates } = audit(store.list);
    expect(duplicates).toBeGreaterThan(10_000); // 500 per round, 30 rounds
    expect(store.more.backward).toBe(true); // and it never asked to stop
    expect(store.viewShift).toBe(-30 * PAGE); // 15 000 bars of view displacement
    expect(store.requests).toBe(31);
  });
});
