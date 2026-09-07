import { beforeEach, describe, expect, it, vi } from "vitest";

// `timeShare` pulls `registerIndicator` in as a value; stub the chart library so
// the suite never boots a real one (and the captured spec can be inspected).
const registered: Array<Record<string, unknown>> = [];
vi.mock("klinecharts", () => ({
  registerIndicator: (spec: Record<string, unknown>) => registered.push(spec),
}));

import {
  AVG_PRICE_NAME,
  TIME_SHARE_COUNT,
  TIME_SHARE_INTERVAL,
  averagePriceSeries,
  changeRatio,
  changeTone,
  ensureTimeShareIndicator,
  formatChangePct,
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
