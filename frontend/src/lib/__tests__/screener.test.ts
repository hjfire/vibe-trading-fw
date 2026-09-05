import { describe, expect, it } from "vitest";
import type { KLineData } from "klinecharts";

import {
  SCREENER_RULES,
  applyRule,
  formatScreenValue,
  screenOne,
  screenPool,
  scriptSeries,
  sortRows,
  type BarLoader,
  type ScreenRow,
} from "../screener";

/**
 * Screener semantics (local custom ⑪). The pure half only: what a script
 * yields per symbol, what a rule decides, and how a pool is walked.
 */

const MA2_PINE = `//@version=5
indicator("双均线", overlay=true)
fast = ta.sma(close, 3)
slow = ta.sma(close, 6)
plot(fast, "快线")
plot(slow, "慢线")`;

/** Only fires on bars whose close beats the previous one. */
const GAP_PINE = `//@version=5
indicator("上涨出信号", overlay=false)
up = close > close[1]
plot(up ? close : na, "信号")`;

const MA_VECTOR = `fast = ma(close, P[0]);
slow = ma(close, P[1]);
return { 快线: fast, 慢线: slow };`;

function ramp(n: number, start = 100, step = 1): KLineData[] {
  return Array.from({ length: n }, (_, i) => {
    const close = start + step * i;
    return {
      timestamp: 1700000000000 + i * 86400000,
      open: close,
      high: close + 0.5,
      low: close - 0.5,
      close,
      volume: 1000,
      turnover: 0,
    } as KLineData;
  });
}

/** Up for the first half, down from there — a line with values *and* a fresh gap. */
function hill(n = 20): KLineData[] {
  const half = Math.floor(n / 2);
  const closes = Array.from({ length: n }, (_, i) => (i <= half ? 100 + i : 100 + half - (i - half)));
  return closes.map((close, i) => ({
    timestamp: 1700000000000 + i * 86400000,
    open: close,
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: 1000,
    turnover: 0,
  })) as KLineData[];
}

/** Flat until a single decisive bar, so the cross lands on the newest bar. */
function stepBars(dir: 1 | -1, n = 120): KLineData[] {
  const closes = Array.from({ length: n }, (_, i) => (i === n - 1 ? 100 + dir * 6 : 100));
  return closes.map((close, i) => ({
    timestamp: 1700000000000 + i * 86400000,
    open: close,
    high: close + 0.5,
    low: close - 0.5,
    close,
    volume: 1000,
    turnover: 0,
  })) as KLineData[];
}

const lastOf = (bars: KLineData[], n: number) =>
  bars.slice(-n).reduce((acc, b) => acc + b.close, 0) / n;

describe("scriptSeries", () => {
  it("reads Pine output lines in drawing order, sampled at the newest bars", () => {
    const bars = ramp(30);
    const { series, error } = scriptSeries(MA2_PINE, bars);
    expect(error).toBe("");
    expect(series.map((s) => s.name)).toEqual(["快线", "慢线"]);
    expect(series[0].last).toBeCloseTo(lastOf(bars, 3), 8);
    expect(series[1].last).toBeCloseTo(lastOf(bars, 6), 8);
    // prev is one bar earlier, not the same value twice.
    expect(series[0].prev).toBeCloseTo((bars[26].close + bars[27].close + bars[28].close) / 3, 8);
  });

  it("runs the vector language through the same door", () => {
    const bars = ramp(30);
    const { series, error } = scriptSeries(MA_VECTOR, bars, [3, 6]);
    expect(error).toBe("");
    expect(series.map((s) => s.name)).toEqual(["快线", "慢线"]);
    expect(series[0].last).toBeCloseTo(lastOf(bars, 3), 8);
  });

  it("keeps NaN gaps as NaN instead of inventing a zero", () => {
    // The signal fires on the rising half and stops on the falling bar, so the
    // line exists but the newest value does not.
    const { series, error } = scriptSeries(GAP_PINE, hill(20));
    expect(error).toBe("");
    expect(series).toHaveLength(1);
    expect(series[0].last).toBeNaN();
    expect(applyRule("nonEmpty", series).hit).toBe(false);
  });

  it("reports a script that has nothing to compare", () => {
    const { series, error } = scriptSeries('//@version=5\nindicator("只画图")\nplotshape(close > close[1], "标记", shape.triangleup)', ramp(20));
    expect(series).toHaveLength(0);
    expect(error).toMatch(/没有输出线/);
  });

  it("reports a syntax error rather than throwing", () => {
    expect(scriptSeries('indicator("坏脚本"\nplot(close', ramp(10)).error).toBeTruthy();
  });

  it("reports a vector formula that returns nothing", () => {
    expect(scriptSeries("close + 1;", ramp(10)).error).toMatch(/return/);
  });
});

describe("applyRule", () => {
  const up = [
    { name: "快线", last: 105, prev: 100 },
    { name: "慢线", last: 101, prev: 101 },
  ];
  const down = [
    { name: "快线", last: 95, prev: 100 },
    { name: "慢线", last: 99, prev: 98 },
  ];

  it("detects crosses in both directions", () => {
    expect(applyRule("crossUp", up).hit).toBe(true);
    expect(applyRule("crossDown", up).hit).toBe(false);
    expect(applyRule("crossDown", down).hit).toBe(true);
    expect(applyRule("crossUp", down).hit).toBe(false);
  });

  it("explains a miss in the script's own terms", () => {
    const out = applyRule("crossUp", down);
    expect(out.reason).toContain("快线");
    expect(out.reason).toContain("慢线");
  });

  it("asks for a second line when the rule needs one", () => {
    const out = applyRule("crossUp", [up[0]]);
    expect(out.hit).toBe(false);
    expect(out.reason).toMatch(/两条输出线/);
  });

  it("handles thresholds, truth and gaps", () => {
    const one = [{ name: "RSI", last: 71.5, prev: 60 }];
    expect(applyRule("gt", one, 70).hit).toBe(true);
    expect(applyRule("gt", one, 72).hit).toBe(false);
    expect(applyRule("lt", one, 72).hit).toBe(true);
    expect(applyRule("truthy", one).hit).toBe(true);
    expect(applyRule("rising", one).hit).toBe(true);
    expect(applyRule("falling", one).hit).toBe(false);
    const gap = [{ name: "信号", last: NaN, prev: NaN }];
    expect(applyRule("nonEmpty", gap).hit).toBe(false);
    expect(applyRule("truthy", gap).hit).toBe(false);
    expect(applyRule("gt", gap, 0).hit).toBe(false);
    expect(applyRule("rising", gap).hit).toBe(false);
  });
});

describe("screenOne", () => {
  it("reports the newest price next to the condition values", async () => {
    const row = await screenOne({
      symbol: "600519.SH",
      code: MA2_PINE,
      rule: "crossUp",
      interval: "1D",
      loadBars: async () => stepBars(1),
    });
    expect(row.hit).toBe(true);
    expect(row.close).toBe(106);
    expect(row.changePct).toBeCloseTo(6, 8);
    expect(row.bars).toBe(120);
  });

  it("does not pretend when there are too few bars", async () => {
    const row = await screenOne({
      symbol: "NEW.SH",
      code: MA2_PINE,
      rule: "nonEmpty",
      interval: "1D",
      loadBars: async () => ramp(1),
    });
    expect(row.hit).toBe(false);
    expect(row.reason).toMatch(/K线不足/);
  });

  it("turns a data failure into a row, not a rejected scan", async () => {
    const row = await screenOne({
      symbol: "GHOST.US",
      code: MA2_PINE,
      rule: "nonEmpty",
      interval: "1D",
      loadBars: async () => {
        throw new Error("404 symbol not found");
      },
    });
    expect(row.hit).toBe(false);
    expect(row.reason).toMatch(/行情获取失败.*404/);
  });
});

describe("screenPool", () => {
  it("walks the pool, deduplicates and reports progress as rows land", async () => {
    const seen: string[] = [];
    const progress: number[] = [];
    const loadBars: BarLoader = async (symbol) => {
      seen.push(symbol);
      return symbol === "AAA.SH" ? stepBars(1) : stepBars(-1);
    };
    const rows = await screenPool({
      symbols: ["aaa.sh", "BBB.SH", "BBB.SH", "  "],
      code: MA2_PINE,
      rule: "crossUp",
      interval: "1D",
      loadBars,
      onRow: (_row, done) => progress.push(done),
    });
    expect(seen.sort()).toEqual(["AAA.SH", "BBB.SH"]);
    expect(rows).toHaveLength(2);
    expect(progress).toEqual([1, 2]);
    expect(rows.find((r) => r.symbol === "AAA.SH")?.hit).toBe(true);
    expect(rows.find((r) => r.symbol === "BBB.SH")?.hit).toBe(false);
  });

  it("stops handing out work once the scan is cancelled", async () => {
    const ac = new AbortController();
    let started = 0;
    const rows = await screenPool({
      symbols: Array.from({ length: 12 }, (_, i) => `S${i}.SH`),
      code: MA2_PINE,
      rule: "nonEmpty",
      interval: "1D",
      concurrency: 2,
      loadBars: async () => {
        started++;
        if (started >= 2) ac.abort();
        return ramp(10);
      },
      signal: ac.signal,
    });
    expect(rows.length).toBeLessThan(12);
    expect(started).toBeLessThan(6);
  });
});

describe("sortRows", () => {
  const row = (symbol: string, hit: boolean, last: number): ScreenRow => ({
    symbol,
    hit,
    reason: "",
    close: 10,
    changePct: 0,
    series: [{ name: "x", last, prev: last }],
    bars: 10,
    interval: "1D",
  });

  it("puts hits first, strongest value on top, gaps at the end", () => {
    const sorted = sortRows([row("C.SH", false, 999), row("A.SH", true, 5), row("B.SH", true, 9), row("D.SH", true, NaN)]);
    expect(sorted.map((r) => r.symbol)).toEqual(["B.SH", "A.SH", "D.SH", "C.SH"]);
  });

  it("does not reorder the caller's array", () => {
    const input = [row("B", true, 9), row("A", true, 1)];
    sortRows(input);
    expect(input[0].symbol).toBe("B");
  });
});

describe("formatScreenValue", () => {
  it("keeps prices readable and gaps visible", () => {
    expect(formatScreenValue(NaN)).toBe("—");
    expect(formatScreenValue(1735.2)).toBe("1735");
    expect(formatScreenValue(42.156)).toBe("42.16");
    expect(formatScreenValue(0.1234)).toBe("0.123");
  });
});

/** The rule list drives the tab's dropdown, so it must stay unambiguous. */
describe("rule set", () => {
  it("has one entry per key, each with a label and a hint", () => {
    const keys = new Set(SCREENER_RULES.map((r) => r.key));
    expect(keys.size).toBe(SCREENER_RULES.length);
    for (const r of SCREENER_RULES) {
      expect(r.label.length).toBeGreaterThan(1);
      expect(r.hint.length).toBeGreaterThan(4);
    }
  });
});
