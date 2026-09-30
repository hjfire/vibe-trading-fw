/**
 * The period table behind the toolbar (local custom ㉜: 周线 / 月线).
 *
 * `IntervalKey` is used by the chart page (which period to draw), by the paging
 * loader (which interval to ask the route for), by session restore and by the
 * drawing buckets. Two of those directions are one lookup table, and a coarse
 * button that draws weekly candles while fetching daily bars is exactly the kind
 * of split this file exists to make impossible.
 */
import { describe, expect, it } from "vitest";

import {
  INTERVALS,
  INTERVAL_MS,
  intervalToPeriod,
  isCalendarInterval,
  periodToInterval,
  pickLowerInterval,
  type IntervalKey,
} from "../marketApi";
import { tfToMs } from "../pineResample";

const ALL_KEYS: IntervalKey[] = ["1m", "5m", "15m", "30m", "60m", "1D", "1W", "1M"];

describe("the toolbar's period list", () => {
  it("offers the five minute periods, then daily, weekly and monthly", () => {
    expect(INTERVALS.map((i) => i.key)).toEqual(ALL_KEYS);
    expect(INTERVALS.map((i) => i.label)).toEqual([
      "1分",
      "5分",
      "15分",
      "30分",
      "60分",
      "日线",
      "周线",
      "月线",
    ]);
  });
});

describe("key <-> KLineChart period", () => {
  it.each(ALL_KEYS)("round-trips %s back to itself", (key) => {
    expect(periodToInterval(intervalToPeriod(key))).toBe(key);
  });

  it("names the three coarse periods the way the library spells them", () => {
    // The library picks its axis/tooltip date format off these type names, so a
    // weekly chart drawn as `{type:"day"}` would quietly date-label every bar
    // one trading day apart.
    expect(intervalToPeriod("1D")).toEqual({ type: "day", span: 1 });
    expect(intervalToPeriod("1W")).toEqual({ type: "week", span: 1 });
    expect(intervalToPeriod("1M")).toEqual({ type: "month", span: 1 });
  });

  it("keeps 60分 a minute period, which is what the route's 60m spelling means", () => {
    expect(intervalToPeriod("60m")).toEqual({ type: "minute", span: 60 });
  });

  it("degrades a period with no button here to daily, not to 1-minute", () => {
    // `{type:"year", span:1}` used to fall through to the minute span map, where
    // `span: 1` means 1m — a yearly period asking for minute bars.
    expect(periodToInterval({ type: "year", span: 1 })).toBe("1D");
    expect(periodToInterval({ type: "second", span: 30 })).toBe("1D");
    expect(periodToInterval({ type: "hour", span: 4 })).toBe("1D");
  });
});

describe("isCalendarInterval", () => {
  it("is true for daily and coarser only", () => {
    for (const key of ["1D", "1W", "1M"]) expect(isCalendarInterval(key as IntervalKey)).toBe(true);
    for (const key of ["1m", "5m", "15m", "30m", "60m"])
      expect(isCalendarInterval(key as IntervalKey)).toBe(false);
  });

  it("matches what the backend folds out of its own daily bars", () => {
    // The server's `_AGG_DAILY_PER_BAR` holds exactly these two keys; anything
    // else the frontend calls "calendar" would be answered by the plain daily
    // path and arrive as daily bars.
    const coarse = INTERVALS.filter((i) => isCalendarInterval(i.key)).map((i) => i.key);
    expect(coarse).toEqual(["1D", "1W", "1M"]);
  });
});

describe("pickLowerInterval (request.security_lower_tf feed)", () => {
  it("orders the period table finest to coarsest", () => {
    const keys = Object.keys(INTERVAL_MS) as IntervalKey[];
    for (let i = 1; i < keys.length; i++) {
      expect(INTERVAL_MS[keys[i]]).toBeGreaterThan(INTERVAL_MS[keys[i - 1]]);
    }
  });

  it("gives a daily chart its 1-minute floor when the script names no timeframe", () => {
    expect(pickLowerInterval("1D")).toBe("1m");
    expect(pickLowerInterval("1W")).toBe("1m");
  });

  it("honours a lower timeframe the script actually asked for", () => {
    expect(pickLowerInterval("1D", tfToMs("60"))).toBe("60m");
    expect(pickLowerInterval("1D", tfToMs("15"))).toBe("15m");
    expect(pickLowerInterval("1W", tfToMs("D"))).toBe("1D");
    expect(pickLowerInterval("60m", tfToMs("5"))).toBe("5m");
  });

  it("snaps an unsupported request to the nearest fetchable lower period", () => {
    // 90 minutes has no button; the nearest available below a daily chart is
    // the 60m key, not the 30m one.
    expect(pickLowerInterval("1D", 90 * 60_000)).toBe("60m");
  });

  it("returns null when there is nothing lower to fetch", () => {
    expect(pickLowerInterval("1m")).toBeNull(); // already the finest
    expect(pickLowerInterval("5m", tfToMs("1D"))).toBeNull(); // asked coarser than the chart
    expect(pickLowerInterval("60m", tfToMs("60"))).toBeNull(); // same as the chart
  });
});
