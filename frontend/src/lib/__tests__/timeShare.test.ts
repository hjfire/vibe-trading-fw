import { beforeEach, describe, expect, it, vi } from "vitest";

// `timeShare` pulls `registerIndicator` in as a value; stub the chart library so
// the suite never boots a real one (and the captured spec can be inspected).
const registered: Array<Record<string, unknown>> = [];
vi.mock("klinecharts", () => ({
  registerIndicator: (spec: Record<string, unknown>) => registered.push(spec),
}));

import {
  AVG_PRICE_NAME,
  BAR_SPACE_LIMIT,
  PREV_CLOSE_NAME,
  TIME_SHARE_COUNT,
  TIME_SHARE_INTERVAL,
  averagePriceSeries,
  changeRatio,
  changeTone,
  ensureTimeShareIndicator,
  fitBarSpace,
  fitOffsetRight,
  formatChangePct,
  getChangeBase,
  prevCloseSeries,
  setChangeBase,
} from "../timeShare";
import type { KLineData } from "klinecharts";

/**
 * The arithmetic behind the 分时 view (local custom ㉖).
 *
 * What the user sees as wrong if any of this is off: a second line that does not
 * track the price line, a change badge that reads +0.00% on a day that opened
 * far from yesterday's close, or a 均价 line pinned to zero before volume
 * arrives — which also drags the price axis down with it.
 */

function bar(close: number, volume?: number): KLineData {
  return { timestamp: 0, open: close, high: close, low: close, close, volume } as KLineData;
}

describe("averagePriceSeries", () => {
  it("weights each close by its own volume", () => {
    // Hand-computed: (10*1 + 11*3) / (1+3) = 43/4 = 10.75, *not* the 10.5 a
    // plain mean of the two closes would print.
    const rows = averagePriceSeries([bar(10, 1), bar(11, 3)]);
    expect(rows[0].avg).toBeCloseTo(10, 10);
    expect(rows[1].avg).toBeCloseTo(10.75, 10);
  });

  it("equals the plain mean when every bar trades the same size", () => {
    const bars = [1, 2, 3, 4].map((c) => bar(c, 100));
    const rows = averagePriceSeries(bars);
    expect(rows.map((r) => r.avg)).toEqual([1, 1.5, 2, 2.5]);
  });

  it("does not pin the line to zero while volume is still missing", () => {
    // A pre-open bar carries a price and no volume. Dividing 0/0 would put the
    // 均价 at zero, and the price axis is autoscaled off these values.
    const rows = averagePriceSeries([bar(50, 0), bar(52, 0), bar(54, 8)]);
    expect(rows[0].avg).toBeCloseTo(50, 10);
    expect(rows[1].avg).toBeCloseTo(51, 10);
    // Once real volume exists it takes over the weighting completely.
    expect(rows[2].avg).toBeCloseTo(54, 10);
  });

  it("treats an absent volume the same as a zero one", () => {
    const rows = averagePriceSeries([bar(20), bar(22, 5)]);
    expect(rows[0].avg).toBeCloseTo(20, 10);
    expect(rows[1].avg).toBeCloseTo(22, 10);
  });

  it("skips a bar with no price instead of poisoning every later point", () => {
    const rows = averagePriceSeries([bar(10, 1), bar(Number.NaN, 1), bar(12, 1)]);
    expect(rows[1].avg).toBeUndefined();
    expect(rows[2].avg).toBeCloseTo((10 + 12) / 2, 10);
  });

  it("starts summing at the first bar of the list, which is why the server slices", () => {
    // The contract `session=latest` buys: the list is one session, so "from the
    // start of the list" *is* "from the open". Splice the same session out of a
    // two-day list and the tail of the average moves — this is the number a
    // browser-side slice would have to get right, and the reason it does not.
    const day1 = [bar(100, 1), bar(100, 1)];
    const day2 = [bar(200, 1), bar(200, 1)];
    const alone = averagePriceSeries(day2);
    const together = averagePriceSeries([...day1, ...day2]);
    // The open of day two: clean on its own, dragged back to yesterday's level
    // when the list still carries it (400/3 at the open, 600/4 one bar later).
    expect(alone[0].avg).toBeCloseTo(200, 10);
    expect(together[2].avg).toBeCloseTo(400 / 3, 10);
    expect(alone[1].avg).toBeCloseTo(200, 10);
    expect(together[3].avg).toBeCloseTo(150, 10);
  });

  it("answers an empty list with an empty list", () => {
    expect(averagePriceSeries([])).toEqual([]);
  });
});

describe("changeRatio", () => {
  it("measures against yesterday's close, not the previous bar", () => {
    expect(changeRatio(110, 100)).toBeCloseTo(0.1, 10);
    expect(changeRatio(90, 100)).toBeCloseTo(-0.1, 10);
  });

  it("returns null rather than 0 when there is no previous session", () => {
    // A new listing or a too-small fetch window leaves `prev_close` null on the
    // wire. Reporting 0 would draw "+0.00%" — a plausible, wrong number.
    expect(changeRatio(100, null)).toBeNull();
    expect(changeRatio(100, undefined)).toBeNull();
    expect(changeRatio(100, 0)).toBeNull();
    expect(changeRatio(undefined, 100)).toBeNull();
    expect(changeRatio(Number.NaN, 100)).toBeNull();
  });
});

describe("formatChangePct", () => {
  it("carries the sign, which is how a broker prints it", () => {
    expect(formatChangePct(0.012_345)).toBe("+1.23%");
    expect(formatChangePct(-0.005)).toBe("-0.50%");
    expect(formatChangePct(0)).toBe("0.00%");
  });

  it("says it does not know instead of printing a number", () => {
    expect(formatChangePct(null)).toBe("昨收未知");
    expect(formatChangePct(Number.NaN)).toBe("昨收未知");
  });
});

describe("changeTone", () => {
  it("maps the ratio onto the A-share up/down/flat colors", () => {
    expect(changeTone(0.02)).toBe("up");
    expect(changeTone(-0.02)).toBe("down");
    expect(changeTone(0)).toBe("flat");
    expect(changeTone(null)).toBe("flat");
  });
});

describe("the 分时 fetch shape", () => {
  it("is built on 1-minute bars", () => {
    expect(TIME_SHARE_INTERVAL).toBe("1m");
  });

  it("asks for more than one session, so yesterday's last bar is reachable", () => {
    // HK/US sessions run 390 minutes; the server needs one bar *beyond* that to
    // report prev_close, so a request sized to exactly a day is always blank.
    expect(TIME_SHARE_COUNT).toBeGreaterThan(400);
  });
});

describe("ensureTimeShareIndicator", () => {
  beforeEach(() => {
    registered.length = 0;
    vi.resetModules();
  });

  /** Re-import the module so the registration guard starts from `false`. */
  async function freshEnsure() {
    const mod = await import("../timeShare");
    mod.ensureTimeShareIndicator();
    mod.ensureTimeShareIndicator();
  }

  it("registers the overlay exactly once, however many times it is asked", async () => {
    await freshEnsure();
    expect(registered).toHaveLength(1);
  });

  it("declares a price-scale line, or it is drawn on the wrong axis", async () => {
    await freshEnsure();
    const spec = registered[0];
    expect(spec.name).toBe(AVG_PRICE_NAME);
    expect(spec.series).toBe("price");
  });

  it("gives the figure a `type`, without which KLineChart drops the line", async () => {
    await freshEnsure();
    // prepareIndicatorFigures() keeps a figure only when isValid(figure.type),
    // so a missing type means: computes fine, draws nothing, legend empty.
    const figures = registered[0].figures as Array<Record<string, unknown>>;
    expect(figures.map((f) => f.key)).toEqual(["avg"]);
    expect(figures[0].type).toBe("line");
  });

  it("computes through averagePriceSeries when the chart feeds it bars", async () => {
    await freshEnsure();
    const calc = registered[0].calc as (bars: KLineData[]) => Array<{ avg?: number }>;
    expect(calc([bar(10, 1), bar(20, 3)])[1].avg).toBeCloseTo(17.5, 10);
  });
});

/**
 * The zoom a session needs (㉘). The report this came out of: "分时 显示不正常" —
 * a 331-bar HK day drawn at the library's default 10px a bar, which leaves 37
 * minutes on screen and makes the rest a drag gesture. See klinecharts#790.
 */
describe("fitBarSpace", () => {
  it("spends the whole width on the session", () => {
    // 376px / 331 bars, rounded down to 2dp: 1.13, which keeps all 331 inside.
    expect(fitBarSpace(376, 331)).toBe(1.13);
    expect(fitBarSpace(376, 331)! * 331).toBeLessThanOrEqual(376);
  });

  it("rounds down, not to nearest, so no bar hangs off the right edge", () => {
    // 200 / 176 = 1.136…: the nearest 2dp value is 1.14, and 176 bars of that is
    // 200.6px — the last bar off the pane, which is the edge case worth naming
    // because floor and round only disagree on some widths.
    expect(fitBarSpace(200, 176)).toBe(1.13);
    expect(1.13 * 176).toBeLessThanOrEqual(200);
    expect(1.14 * 176).toBeGreaterThan(200);
  });

  it("clamps into the range the library accepts, because outside it the call is dropped", () => {
    // StoreImp.setBarSpace (dist 13666) returns early on an out-of-range value;
    // handing it 0.4 would have looked applied and changed nothing.
    expect(fitBarSpace(100, 331)).toBe(BAR_SPACE_LIMIT.min);
    expect(fitBarSpace(5000, 10)).toBe(BAR_SPACE_LIMIT.max);
  });

  it("leaves the zoom alone when the host cannot answer", () => {
    // jsdom reports 0 for an unstyled element, and 0 bars is a failed fetch.
    expect(fitBarSpace(0, 331)).toBeNull();
    expect(fitBarSpace(376, 0)).toBeNull();
    expect(fitBarSpace(Number.NaN, 331)).toBeNull();
    expect(fitBarSpace(-5, 331)).toBeNull();
  });
});

/**
 * Where the pixels a fitted session cannot use go (㉙). The same complaint as
 * `fitBarSpace`, one report later — "分时显示还是有问题" — but this screenshot was
 * taken at 09:33, with thirteen bars to draw in a 922px panel. ㉘ was checked
 * after the close against 331 bars, and at that width/bar ratio the 50px ceiling
 * is never reached, so the symptom could not have shown itself in that check.
 */
describe("fitOffsetRight", () => {
  it("keeps the leftover of a capped fit out of the left edge", () => {
    // 922 / 13 wants 71px a bar, the library refuses past 50, so 650px of pane is
    // actually drawing the session and 272px is spare. Given to the right, that
    // space is "minutes not yet traded"; given to the left, it is the half-empty
    // chart in the report.
    const space = fitBarSpace(922, 13)!;
    expect(space).toBe(BAR_SPACE_LIMIT.max);
    expect(fitOffsetRight(922, space, 13)).toBe(272);
  });

  it("is the exact value that puts bar 0 at half a bar from the left edge", () => {
    // StoreImp.dataIndexToCoordinate (dist 13885):
    //   x(i) = totalBarSpace - (dataCount + offset/barSpace - i - 0.5) * barSpace
    // so x(0) === barSpace / 2 only when offset === totalBarSpace - n * barSpace.
    const space = fitBarSpace(922, 13)!;
    const offset = fitOffsetRight(922, space, 13);
    expect(922 - (13 + offset / space - 0.5) * space).toBeCloseTo(space / 2, 6);
  });

  it("answers a rounded zero for a session that did fit", () => {
    // Past the close there are enough bars that the ceiling never bites, so the
    // only leftover is the 2dp floor in `fitBarSpace`. The check that matters is
    // that this fix cannot make a fitted day visibly move: 1.97px of a 376px pane.
    const space = fitBarSpace(376, 331)!;
    expect(fitOffsetRight(376, space, 331)).toBeLessThan(4);
    expect(fitOffsetRight(200, 1.13, 176)).toBeCloseTo(1.12, 6);
    expect(fitOffsetRight(400, 1, 400)).toBe(0);
  });

  it("never sends the opening bell off the left edge", () => {
    // The other end of the clamp: too many bars for the width pushes the spacing
    // up to the minimum, so the bars overshoot the pane. A negative remainder
    // here would shift the whole session left and cut off its start.
    expect(fitOffsetRight(100, fitBarSpace(100, 331)!, 331)).toBe(0);
  });

  it("answers 0 when the host cannot", () => {
    // Same "change nothing" contract as fitBarSpace's null, reached from the
    // other side: the caller has already bailed on a null spacing, so a zero
    // here only ever means "no leftover", never "wipe the offset the user set".
    expect(fitOffsetRight(0, 10, 13)).toBe(0);
    expect(fitOffsetRight(922, 0, 13)).toBe(0);
    expect(fitOffsetRight(922, 50, 0)).toBe(0);
    expect(fitOffsetRight(Number.NaN, 50, 13)).toBe(0);
  });
});

describe("the 昨收 reference line", () => {
  beforeEach(() => {
    setChangeBase(null);
    registered.length = 0;
    vi.resetModules();
  });

  it("prints the same level on every bar", () => {
    setChangeBase(440);
    expect(prevCloseSeries([bar(441), bar(442), bar(443)])).toEqual([{ prev: 440 }, { prev: 440 }, { prev: 440 }]);
  });

  it("draws nothing when yesterday is unknown, instead of inventing a zero", () => {
    // `prev: 0` would pin a line to the bottom of the axis and read as "it
    // opened at nothing"; a row without the key is the honest blank.
    setChangeBase(null);
    expect(getChangeBase()).toBeNull();
    expect(prevCloseSeries([bar(441), bar(442)])).toEqual([{}, {}]);
    setChangeBase(0);
    expect(getChangeBase()).toBeNull();
    setChangeBase(Number.NaN);
    expect(getChangeBase()).toBeNull();
  });

  it("keeps a usable base out of the junk", () => {
    setChangeBase(435.4);
    expect(getChangeBase()).toBe(435.4);
    // An explicit base argument is what the pure helper takes; the module one is
    // only there for the registered `calc`, which gets no such parameter.
    expect(prevCloseSeries([bar(441)], 430)).toEqual([{ prev: 430 }]);
    expect(prevCloseSeries([bar(441)], null)).toEqual([{}]);
  });

  /** Re-import so the guard *and* the base start clean; both are module state. */
  async function freshModule() {
    const mod = await import("../timeShare");
    mod.ensurePrevCloseIndicator();
    mod.ensurePrevCloseIndicator();
    return mod;
  }

  it("registers once, on the price scale, with a typed figure", async () => {
    await freshModule();
    expect(registered).toHaveLength(1);
    const spec = registered[0];
    expect(spec.name).toBe(PREV_CLOSE_NAME);
    expect(spec.series).toBe("price");
    const figures = spec.figures as Array<Record<string, unknown>>;
    expect(figures.map((f) => f.key)).toEqual(["prev"]);
    expect(figures[0].type).toBe("line");
  });

  it("computes through prevCloseSeries against the base the loader set", async () => {
    const mod = await freshModule();
    const calc = registered[0].calc as (bars: KLineData[]) => Array<{ prev?: number }>;
    // The base has to come from the same module instance the `calc` closure
    // reads, which is the point of setting it in the loader rather than here.
    mod.setChangeBase(440);
    expect(calc([bar(441), bar(442)])).toEqual([{ prev: 440 }, { prev: 440 }]);
    mod.setChangeBase(null);
    expect(calc([bar(441)])).toEqual([{}]);
  });
});
