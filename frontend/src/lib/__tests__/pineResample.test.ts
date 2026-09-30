import { describe, expect, it, vi } from "vitest";

/**
 * Multi-timeframe foundation: chart-period inference and higher-timeframe
 * resampling. These are the primitives `request.security` builds on, so they
 * are pinned here directly (against hand-computed aggregates) rather than only
 * through the interpreter — a wrong OHLC merge or a lookahead off-by-one would
 * silently poison every downstream MTF indicator otherwise.
 */
vi.mock("klinecharts", () => ({ registerIndicator: vi.fn() }));

import { compilePine } from "../pineScript";
import { inferTimeframeMs, periodStringFromMs, resampleUp, tfToMs } from "../pineResample";
import { toBars } from "../pineTypes";
import type { KLineData } from "klinecharts";

const SEC = 1000;
const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const WEEK = 604_800_000;

/** Synthetic bars with a fixed step and a simple rising price. */
function bars(n: number, stepMs: number, startMs = 0): KLineData[] {
  return Array.from({ length: n }, (_, i) => {
    const p = 10 + i;
    return {
      timestamp: startMs + i * stepMs,
      open: p,
      high: p + 1,
      low: p - 1,
      close: p + 0.5,
      volume: 100 + i,
      turnover: 0,
    } as KLineData;
  });
}

describe("chart timeframe inference", () => {
  it("recovers the median inter-bar spacing", () => {
    expect(inferTimeframeMs(toBars(bars(50, MIN)))).toBe(MIN);
    expect(inferTimeframeMs(toBars(bars(50, DAY)))).toBe(DAY);
    expect(inferTimeframeMs(toBars(bars(50, WEEK)))).toBe(WEEK);
  });

  it("is robust to a single irregular gap (weekend hole)", () => {
    const b = bars(30, DAY);
    // Punch a 5-day gap in the middle; the median must still be one day.
    for (let i = 15; i < 30; i++) b[i].timestamp += 4 * DAY;
    expect(inferTimeframeMs(toBars(b))).toBe(DAY);
  });

  it("falls back to daily for degenerate feeds", () => {
    expect(inferTimeframeMs(toBars(bars(1, MIN)))).toBe(DAY);
    expect(inferTimeframeMs(toBars([]))).toBe(DAY);
  });

  it("round-trips a period string through tfToMs", () => {
    expect(tfToMs(periodStringFromMs(MIN))).toBe(MIN);
    expect(tfToMs(periodStringFromMs(HOUR))).toBe(HOUR); // "60" => 60 minutes
    expect(tfToMs(periodStringFromMs(DAY))).toBe(DAY); // "D"
    expect(tfToMs(periodStringFromMs(WEEK))).toBe(WEEK); // "W"
  });

  it("parses TradingView timeframe strings with the documented units", () => {
    expect(tfToMs("1")).toBe(MIN);
    expect(tfToMs("15")).toBe(15 * MIN);
    expect(tfToMs("1S")).toBe(SEC);
    expect(tfToMs("1H")).toBe(HOUR);
    expect(tfToMs("1D")).toBe(DAY);
    expect(tfToMs("D")).toBe(DAY);
    expect(tfToMs("W")).toBe(WEEK);
    expect(tfToMs("240")).toBe(4 * HOUR);
    expect(tfToMs("gibberish")).toBeNaN();
  });
});

describe("higher-timeframe resampling", () => {
  it("merges minute bars into hours with backtrader OHLCV rules", () => {
    // 120 minute bars starting exactly at an hour boundary => two full hours.
    const src = toBars(bars(120, MIN, 1 * HOUR));
    const r = resampleUp(src, HOUR)!;
    expect(r).not.toBeNull();
    expect(r.htf.list.length).toBe(2);
    // hour 0 = chart bars [0..59]: open = first open, close = last close,
    // high = max, low = min, volume = sum.
    expect(r.htf.open[0]).toBe(src.open[0]);
    expect(r.htf.close[0]).toBe(src.close[59]);
    expect(r.htf.high[0]).toBe(src.high[59]); // price rises, so last bar is highest
    expect(r.htf.low[0]).toBe(src.low[0]); // first bar is lowest
    const volSum = src.volume.slice(0, 60).reduce((a, b) => a + b, 0);
    expect(r.htf.volume[0]).toBeCloseTo(volSum, 6);
    // Bucket time is the aligned hour start.
    expect(r.htf.time[0]).toBe(1 * HOUR);
    expect(r.htf.time[1]).toBe(2 * HOUR);
    // chart->htf mapping splits at the hour edge.
    expect(r.chartToHtf[0]).toBe(0);
    expect(r.chartToHtf[59]).toBe(0);
    expect(r.chartToHtf[60]).toBe(1);
    expect(r.chartToHtf[119]).toBe(1);
  });

  it("does not mutate the source chart bars when aggregating", () => {
    const src = toBars(bars(24, HOUR, 0));
    const before = src.list[0].close;
    resampleUp(src, DAY);
    expect(src.list[0].close).toBe(before);
  });

  it("returns null when the request is not a rollup", () => {
    const src = toBars(bars(30, DAY));
    expect(resampleUp(src, DAY)).toBeNull(); // same timeframe
    expect(resampleUp(src, HOUR)).toBeNull(); // finer than chart
    expect(resampleUp(toBars([]), WEEK)).toBeNull(); // no data
  });
});

describe("timeframe.* builtins see the inferred chart period", () => {
  const head = "//@version=5\nindicator(\"tf\")\n";
  const line = (a: ReturnType<typeof compilePine>, n: string) =>
    "result" in a ? a.result.lines.find((l) => l.name === n) : undefined;

  it("reports intraday flags for a minute chart", () => {
    const out = compilePine(
      head + 'plot(timeframe.isintraday, "intraday")\nplot(timeframe.isdaily, "daily")',
      bars(80, MIN),
    );
    expect("result" in out).toBe(true);
    expect(line(out, "intraday")!.values[0]).toBe(1);
    expect(line(out, "daily")!.values[0]).toBe(0);
  });

  it("still reports daily for a daily chart", () => {
    const out = compilePine(
      head + 'plot(timeframe.isdaily, "daily")\nplot(timeframe.isintraday, "intraday")',
      bars(80, DAY),
    );
    expect(line(out, "daily")!.values[0]).toBe(1);
    expect(line(out, "intraday")!.values[0]).toBe(0);
  });
});
