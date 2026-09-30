import { describe, it, expect } from "vitest";
import { compilePine } from "../pineScript";
import type { KLineData } from "klinecharts";

/**
 * Numeric cross-validation for the two real Pine built-ins added to close the
 * corpus runtime_abort backlog: `ta.valuewhen(condition, source, occurrence)`
 * and `offset(series, n)`. Bars are fully deterministic (close = 100 + i, open
 * one tick lower) so every expected value is hand-computed — NOT "it stopped
 * erroring". The last group proves `offset()` equals the same series read as a
 * history reference, i.e. the merge is faithful.
 */

const N = 40;
const bars: KLineData[] = Array.from({ length: N }, (_, i) => {
  const close = 100 + i;
  const open = close - 0.5;
  return {
    timestamp: 1700000000000 + i * 86_400_000,
    open,
    high: close + 1,
    low: open - 1,
    close,
    volume: 1000 + i,
    turnover: 0,
  } as KLineData;
});
/** Reference: close on bar i is exactly 100 + i. */
const closeAt = (i: number): number => (i < 0 ? NaN : 100 + i);

/** All plot lines in declaration order (throws on compile/run failure). */
function allLines(src: string): number[][] {
  const out = compilePine(src, bars, {});
  if ("error" in out) throw new Error(`编译失败：${out.error}`);
  if (out.abort) throw new Error(`运行中断：${out.abort}`);
  return out.result.lines.map((l) => l.values.map((v) => (typeof v === "number" ? v : NaN)));
}
/** First plot line, or [] when the script yields no finite series at all. */
function firstLine(src: string): number[] {
  return allLines(src)[0] ?? [];
}
/** Whether any plot line carries at least one finite value. */
function produced(src: string): boolean {
  return allLines(src).some((s) => s.some((v) => Number.isFinite(v)));
}

function last(src: string): number {
  const s = firstLine(src);
  for (let i = s.length - 1; i >= 0; i--) if (Number.isFinite(s[i])) return s[i];
  return NaN;
}

describe("ta.valuewhen(condition, source, occurrence)", () => {
  it("occurrence 0/1/2 read the last three true bars' source", () => {
    // close > open is true on EVERY bar, so the last three occurrences are the
    // last three bars: 100+39, 100+38, 100+37.
    expect(last("plot(ta.valuewhen(close > open, close, 0))")).toBeCloseTo(closeAt(N - 1), 8);
    expect(last("plot(valuewhen(close > open, close, 1))")).toBeCloseTo(closeAt(N - 2), 8);
    expect(last("plot(valuewhen(close > open, close, 2))")).toBeCloseTo(closeAt(N - 3), 8);
  });

  it("returns the source frozen at the single true bar (bare + ta. form agree)", () => {
    // condition true only on bar_index == 5 → valuewhen freezes close[5] there.
    const l = firstLine("c = bar_index == 5\nplot(ta.valuewhen(c, close, 0))\n");
    expect(l[4]).toBeNaN(); // before the first occurrence
    expect(l[5]).toBeCloseTo(closeAt(5), 8); // the true bar itself
    expect(l[N - 1]).toBeCloseTo(closeAt(5), 8); // stays frozen afterwards
    // occurrence 1 needs a second true bar that never comes → na everywhere,
    // which the engine renders as no finite output at all.
    expect(produced("c = bar_index == 5\nplot(valuewhen(c, close, 1))\n")).toBe(false);
  });

  it("occurrence indexes a periodic condition back through its firings", () => {
    // true on even bars (…,36,38). On the last bar 39 the most recent true bar
    // is 38, then 36, then 34.
    expect(last("plot(valuewhen(bar_index % 2 == 0, close, 0))")).toBeCloseTo(closeAt(38), 8);
    expect(last("plot(valuewhen(bar_index % 2 == 0, close, 1))")).toBeCloseTo(closeAt(36), 8);
    expect(last("plot(valuewhen(bar_index % 2 == 0, close, 2))")).toBeCloseTo(closeAt(34), 8);
  });
});

describe("offset(series, n)", () => {
  it("offset(close, n) is the value of close n bars ago; n=0 is identity", () => {
    expect(last("plot(offset(close, 0))")).toBeCloseTo(closeAt(N - 1), 8);
    expect(last("plot(offset(close, 3))")).toBeCloseTo(closeAt(N - 1 - 3), 8);
    expect(last("plot(offset(close, 8))")).toBeCloseTo(closeAt(N - 1 - 8), 8);
  });

  it("reads warm-up (n bars before enough history) as na", () => {
    // offset(close, 5) is na for bars 0..4, then close[i-5].
    const l = firstLine("plot(offset(close, 5))");
    expect(l[4]).toBeNaN();
    expect(l[5]).toBeCloseTo(closeAt(0), 8);
  });

  it("only shifts right: a negative offset is out of range (no finite output)", () => {
    expect(produced("plot(offset(close, -2))")).toBe(false);
  });

  it("offset of a moving average equals that same series read as a delay (faithful)", () => {
    // s = sma(close,5); d = offset(s,8). d[i] must equal s[i-8] bar for bar.
    const [s, d] = allLines("plot(ta.sma(close, 5))\nplot(offset(ta.sma(close, 5), 8))\n");
    for (let i = 0; i < N; i++) {
      const expectVal = i - 8 >= 0 ? s[i - 8] : NaN;
      expect(Object.is(d[i], expectVal) || Math.abs(d[i] - expectVal) < 1e-9).toBe(true);
    }
  });
});
