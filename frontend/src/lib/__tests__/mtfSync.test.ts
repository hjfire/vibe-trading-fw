import { describe, expect, it } from "vitest";

import {
  barTimestamps,
  coarseBarSpanMs,
  countWithin,
  createApplyGate,
  crosshairPayload,
  rangePlan,
  windowOfIndices,
  type TimeWindow,
} from "../mtfSync";
import { BAR_SPACE_LIMIT } from "../timeShare";
import type { KLineData } from "klinecharts";

/**
 * Time-axis arithmetic for /multi-chart (four charts, four periods, one symbol).
 *
 * What these tests hold shut are the four ways a naive implementation looks
 * right and is not:
 *
 * 1. Broadcasting bar *indices*. `VisibleRange.from`/`.to` index into one
 *    chart's own data list, so index 300 on a daily chart and index 300 on a
 *    5-minute chart are years apart. Only the timestamp window travels.
 * 2. Broadcasting a *timestamp* for the crosshair. `StoreImp.setCrosshair`
 *    reads `cr.x` and nothing else; without an `x` it lands on
 *    `dataList.length - 1`, so the peer's cursor jumps to its newest bar and
 *    appears to be working while pointing at the wrong day. The same function
 *    runs the other way on the way in: it hands subscribers the *parameter it
 *    received* (dist 14093), which from the mouse path is `{x, y, paneId}` with
 *    no `timestamp` on it, so an incoming event has to be resolved back to an
 *    instant before it can be re-sent.
 * 3. Letting the echo through. `setBarSpace` fires `onVisibleRangeChange`
 *    synchronously (dist 13666 -> 13568), so an unguarded bus has B answer A's
 *    event by broadcasting its own.
 * 4. Treating a bar's stamp as the end of the time it covers. The daily feed
 *    stamps a bar at its own midnight while the minute feeds stamp at the close,
 *    so a window that ends on a daily bar ends *before* that day's session.
 *
 * The page's own chart tests mock `klinecharts` wholesale, so they can only
 * assert the calls made. These are the arithmetic those calls rest on.
 */

const MIN = 60_000;
const DAY = 86_400_000;
const START = 1_704_067_200_000; // 2024-01-01T00:00Z, a Monday

/** Ascending timestamps, `count` of them, `step` apart. */
function stamps(count: number, step = DAY, at = START): number[] {
  return Array.from({ length: count }, (_, i) => at + i * step);
}

function bar(timestamp: number): KLineData {
  return { timestamp, open: 1, high: 1, low: 1, close: 1 } as KLineData;
}

describe("barTimestamps", () => {
  it("只取时间戳，把 KLineData 留在图表那一侧", () => {
    expect(barTimestamps([bar(10), bar(20)])).toEqual([10, 20]);
    expect(barTimestamps([])).toEqual([]);
  });
});

describe("windowOfIndices", () => {
  it("两端下标换算成绝对时间窗口", () => {
    const ts = stamps(10);
    expect(windowOfIndices(ts, { from: 2, to: 5 })).toEqual({
      from: ts[2],
      to: ts[5],
    });
  });

  it("空列表没有窗口可报，返回 null 而不是拿 ts[0] 凑", () => {
    expect(windowOfIndices([], { from: 0, to: 0 })).toBeNull();
  });

  it("右侧留白会把下标顶到列表外，要夹回来", () => {
    // `VisibleRange` can report indices past the ends while the offset-right
    // gap is on screen; unclamped this reads `ts[99]` === undefined and the
    // window becomes { from: undefined, to: undefined }.
    const ts = stamps(6);
    expect(windowOfIndices(ts, { from: -3, to: 99 })).toEqual({
      from: ts[0],
      to: ts[5],
    });
  });

  it("倒挂的区间不是一个窗口", () => {
    expect(windowOfIndices(stamps(5), { from: 4, to: 1 })).toBeNull();
  });

  it("只有一根可见时也成立（窗口零宽，不是缺失）", () => {
    const ts = stamps(5);
    expect(windowOfIndices(ts, { from: 2, to: 2 })).toEqual({ from: ts[2], to: ts[2] });
  });

  it("给了周期跨度就把右端推到那根bar的收盘", () => {
    // The live daily feed stamps a bar at its own midnight, so a window that
    // ends on it contains none of that day's session and the minute cells get
    // cut off at the open. Measured 2026-10-06: three peers of one daily window
    // landed at 03:30Z / 02:00Z / 01:40Z — three times of the same day, none of
    // them its close.
    const ts = stamps(10);
    expect(windowOfIndices(ts, { from: 2, to: 5 }, DAY)).toEqual({
      from: ts[2],
      to: ts[6] - 1,
    });
  });

  it("延伸既不越过下一根，也不小于自己的跨度", () => {
    // A gap in the source's own series is the ceiling: whatever comes next is
    // where this bar stops claiming to cover.
    const ts = [START, START + DAY, START + 3 * DAY]; // a weekend in the middle
    // One day's bar with the next one a day away: the span decides, and the
    // weekend gap stays outside the window.
    expect(windowOfIndices(ts, { from: 1, to: 1 }, DAY)!.to).toBe(START + 2 * DAY);
    // A three-day bar whose next bar is only one day away: the neighbour
    // decides, or Friday's window would swallow Monday's session.
    expect(windowOfIndices(ts, { from: 1, to: 1 }, 3 * DAY)!.to).toBe(START + 3 * DAY - 1);
  });

  it("最后一根没有下一根可参照，就按跨度算", () => {
    const ts = stamps(4);
    expect(windowOfIndices(ts, { from: 0, to: 3 }, DAY)!.to).toBe(ts[3] + DAY);
  });

  it("不传跨度就不延伸（分钟图本来就按收盘打戳）", () => {
    const ts = stamps(4);
    expect(windowOfIndices(ts, { from: 0, to: 3 }, null)!.to).toBe(ts[3]);
    expect(windowOfIndices(ts, { from: 0, to: 3 })!.to).toBe(ts[3]);
  });
});

describe("coarseBarSpanMs", () => {
  const period = (type: string, span: number) => ({ type, span }) as Parameters<
    typeof coarseBarSpanMs
  >[0];

  it("日/周/月各按自己的自然长度，分钟不给", () => {
    expect(coarseBarSpanMs(period("day", 1))).toBe(DAY);
    expect(coarseBarSpanMs(period("day", 3))).toBe(3 * DAY);
    expect(coarseBarSpanMs(period("week", 1))).toBe(7 * DAY);
    expect(coarseBarSpanMs(period("month", 1))).toBe(31 * DAY);
    // Every loader here stamps a minute bar at its close, so extending one would
    // claim time that has not happened yet.
    expect(coarseBarSpanMs(period("minute", 5))).toBeNull();
    expect(coarseBarSpanMs(period("hour", 1))).toBeNull();
  });

  it("还没拿到周期的图不延伸", () => {
    expect(coarseBarSpanMs(null)).toBeNull();
    expect(coarseBarSpanMs(undefined)).toBeNull();
  });
});

describe("countWithin", () => {
  it("两端都算进（闭区间）", () => {
    const ts = stamps(10);
    const win: TimeWindow = { from: ts[2], to: ts[5] };
    expect(countWithin(ts, win)).toBe(4);
  });

  it("落在两根之间的窗口不产生半个", () => {
    // (ts[0], ts[3]) excludes both endpoints, so only ts[1] and ts[2] count.
    const ts = stamps(10); // daily
    const win: TimeWindow = { from: ts[0] + MIN, to: ts[3] - MIN };
    expect(countWithin(ts, win)).toBe(2);
  });

  it("完全不相交返回 0，不返回负数", () => {
    const ts = stamps(10);
    expect(countWithin(ts, { from: ts[9] + DAY, to: ts[9] + 10 * DAY })).toBe(0);
    expect(countWithin(ts, { from: ts[0] - 10 * DAY, to: ts[0] - DAY })).toBe(0);
    expect(countWithin([], { from: 0, to: 100 })).toBe(0);
  });

  it("倒挂窗口 0 根", () => {
    expect(countWithin(stamps(10), { from: 500, to: 100 })).toBe(0);
  });

  it("二分与逐个比对逐点一致（含正好压边界）", () => {
    // Guards the lowerBound rewrite: a half-open/closed slip here shows up only
    // when the target equals a bar's own timestamp.
    const ts = stamps(37, 5 * MIN);
    for (const [a, b] of [
      [0, 36],
      [5, 5],
      [1, 20],
      [12, 13],
      [30, 36],
    ] as const) {
      const win: TimeWindow = { from: ts[a], to: ts[b] };
      const brute = ts.filter((t) => t >= win.from && t <= win.to).length;
      expect(countWithin(ts, win)).toBe(brute);
    }
    // and a few off-grid targets
    for (const off of [ts[0] - 1, ts[0] + 1, ts[18] + 1, ts[36] + 1]) {
      const win: TimeWindow = { from: off, to: ts[36] };
      const brute = ts.filter((t) => t >= win.from && t <= win.to).length;
      expect(countWithin(ts, win)).toBe(brute);
    }
  });
});

describe("rangePlan", () => {
  const ts = stamps(10);
  const win: TimeWindow = { from: ts[0], to: ts[4] }; // 5 bars

  it("宽格摊到上限为止，剩下的像素给右侧", () => {
    // 5 bars in 500px wants 100px each, past the library's 50px ceiling, so the
    // spacing clamps and the unused pixels go to the right, not the left.
    const plan = rangePlan(ts, 500, win)!;
    expect(plan.barSpace).toBe(BAR_SPACE_LIMIT.max);
    expect(plan.offsetRight).toBe(500 - 50 * 5);
    expect(plan.anchor).toBe(ts[4]);
  });

  it("锚点是窗口的右端（新的一侧）", () => {
    expect(rangePlan(ts, 500, win)!.anchor).toBe(win.to);
  });

  it("窗口右端落在两根之间时，锚点是对端自己的最后一根", () => {
    // `ChartImp.scrollToTimestamp` resolves through `binarySearchNearest` (dist
    // 15640): an anchor that is not one of the peer's bars lands on whichever
    // side is *nearer*. A day-extended window ends one millisecond before the
    // peer's next bar, so sending the instant would drag the peer a whole
    // session past the source.
    const hourly = stamps(30, 3_600_000);
    const span: TimeWindow = { from: hourly[0], to: hourly[0] + DAY - 1 };
    expect(countWithin(hourly, span)).toBe(24);
    expect(rangePlan(hourly, 480, span)!.anchor).toBe(hourly[23]);
  });

  it("不相交的格子保留自己的视角，不生成计划", () => {
    // A 5-minute cell of a symbol with 200 bars of history genuinely cannot
    // follow a daily chart scrolled back years; zooming it to "0 bars" would
    // draw an empty pane, which reads as broken rather than as out-of-range.
    const far: TimeWindow = { from: ts[9] + 100 * DAY, to: ts[9] + 200 * DAY };
    expect(rangePlan(ts, 500, far)).toBeNull();
  });

  it("零宽窗口只要覆盖到一根就出计划", () => {
    const one: TimeWindow = { from: ts[3], to: ts[3] };
    const plan = rangePlan(ts, 400, one)!;
    expect(plan.barSpace).toBe(BAR_SPACE_LIMIT.max);
    expect(countWithin(ts, one)).toBe(1);
  });

  it("测不到宽度时不碰缩放（jsdom / 已卸载的格子）", () => {
    expect(rangePlan(ts, 0, win)).toBeNull();
    expect(rangePlan(ts, Number.NaN, win)).toBeNull();
  });

  it("窄格放不下时停在下限，不给出会被 setBarSpace 静默丢弃的值", () => {
    // `StoreImp.setBarSpace` returns without doing anything outside
    // [BAR_SPACE_LIMIT.min, max], so an unclamped plan would silently no-op.
    const many = stamps(200);
    const plan = rangePlan(many, 100, { from: many[0], to: many[199] })!;
    expect(countWithin(many, { from: many[0], to: many[199] })).toBe(200);
    expect(100 / 200).toBeLessThan(BAR_SPACE_LIMIT.min);
    expect(plan.barSpace).toBe(BAR_SPACE_LIMIT.min);
  });
});

describe("crosshairPayload", () => {
  it("像素横坐标＋目标 pane", () => {
    expect(crosshairPayload(180, "candle_pane")).toEqual({ x: 180, paneId: "candle_pane" });
  });

  it("没有换算出 x 就不发，别把对端光标甩到最新一根", () => {
    // This is the whole reason `convertToPixel` is on the caller's side.
    expect(crosshairPayload(undefined, "candle_pane")).toBeNull();
    expect(crosshairPayload(Number.NaN, "candle_pane")).toBeNull();
    expect(crosshairPayload(Number.POSITIVE_INFINITY, "candle_pane")).toBeNull();
  });
});

describe("createApplyGate", () => {
  it("门外不处于应用中", () => {
    const gate = createApplyGate();
    expect(gate.isApplying()).toBe(false);
  });

  it("应用期间的事件被识别为回声", () => {
    const gate = createApplyGate();
    const seen: boolean[] = [];
    gate.run(() => {
      seen.push(gate.isApplying());
      gate.run(() => seen.push(gate.isApplying()));
    });
    expect(seen).toEqual([true, true]);
    expect(gate.isApplying()).toBe(false);
  });

  it("一次事件要喂三个对端，计数最外层才负责放行", () => {
    const gate = createApplyGate();
    gate.run(() => {
      for (let i = 0; i < 3; i += 1) {
        gate.run(() => {
          /* nested application */
        });
        expect(gate.isApplying()).toBe(true); // still inside the outer run
      }
    });
    expect(gate.isApplying()).toBe(false);
  });

  it("某个对端抛错不会把闸门永久闩住", () => {
    // A latched gate means the page stops syncing altogether after one bad
    // cell, with nothing on screen to say why.
    const gate = createApplyGate();
    expect(() =>
      gate.run(() => {
        throw new Error("peer blew up");
      }),
    ).toThrow("peer blew up");
    expect(gate.isApplying()).toBe(false);
  });
});

describe("四格对齐的语义", () => {
  it("日线图的窗口翻到分钟图上，覆盖的是同一段时间", () => {
    const daily = stamps(30); // 30 days
    const minute = stamps(30 * 24 * 60, MIN, daily[0]); // same span, minutely

    const win = windowOfIndices(daily, { from: 10, to: 12 })!;
    expect(win).toEqual({ from: daily[10], to: daily[12] });

    // Ten bars' worth of days on one side is 2881 minute bars on the other —
    // the property a user reads as "这两张图讲的是同一段时间".
    const n = countWithin(minute, win);
    expect(n).toBe(2 * 24 * 60 + 1);
    const covered = minute.filter((t) => t >= win.from && t <= win.to);
    expect(covered.length).toBe(n);
    expect(covered[0]).toBeGreaterThanOrEqual(win.from);
    expect(covered[covered.length - 1]).toBeLessThanOrEqual(win.to);
  });

  it("照搬下标会把对端带到完全错误的时段（这就是为什么传窗口）", () => {
    const daily = stamps(30);
    const minute = stamps(30 * 24 * 60, MIN, daily[0]);

    const range = { from: 10, to: 12 };
    const naiveWin = windowOfIndices(minute, range)!; // index-for-index copy
    const realWin = windowOfIndices(daily, range)!;

    // Ten daily bars in is ten *minutes* out on the copy — minutes apart from
    // the truth by design of the bug.
    expect(naiveWin.to - naiveWin.from).toBe(2 * MIN);
    expect(realWin.to - realWin.from).toBe(2 * DAY);
  });
});
