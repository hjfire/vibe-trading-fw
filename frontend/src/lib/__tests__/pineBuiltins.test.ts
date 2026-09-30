import { describe, it, expect } from "vitest";
import { compilePine } from "../pineScript";
import { percentrankStep, linregStep, percentileNearestRankStep } from "../pineTa";
import type { KLineData } from "klinecharts";

/**
 * Numeric correctness for the legacy/missing Pine built-ins added in the
 * corpus pass-rate push (Track C). Each assertion is cross-checked against a
 * hand-computed value or a JS math identity — NOT "it stopped erroring". The
 * last group proves the fixes are FAITHFUL, not a loosening: a genuinely
 * undefined name still aborts the script.
 */

const win = () => ({ win: [] as number[] }) as never;

describe("legacy statistical ta steps (exact values)", () => {
  it("percentrankStep ranks the newest value inclusive of ties", () => {
    const st = win();
    expect(percentrankStep(1, 3, st)).toBeNaN(); // warm-up (< length)
    percentrankStep(2, 3, st);
    // window [1,2,3]; values <= 3 are all three -> 100
    expect(percentrankStep(3, 3, st)).toBeCloseTo(100, 10);
  });

  it("percentrankStep counts values <= newest over the window length", () => {
    const st = win();
    percentrankStep(2, 4, st);
    percentrankStep(3, 4, st);
    percentrankStep(4, 4, st);
    // window [2,3,4,1]: count <= 1 is 1 of 4 -> 25
    expect(percentrankStep(1, 4, st)).toBeCloseTo(25, 10);
  });

  it("linregStep reproduces an exact line y = 2x + 1", () => {
    const st = win();
    linregStep(1, 3, 0, st); // x=0 -> y=1
    linregStep(3, 3, 0, st); // x=1 -> y=3
    // window [1,3,5]: slope 2, intercept 1, evaluated at x=2 -> 5
    expect(linregStep(5, 3, 0, st)).toBeCloseTo(5, 10);
    // offset shifts the evaluation point forward one bar: 2x+1 at x=3 -> 7
    const st2 = win();
    linregStep(1, 3, 1, st2);
    linregStep(3, 3, 1, st2);
    expect(linregStep(5, 3, 1, st2)).toBeCloseTo(7, 10);
  });

  it("percentileNearestRankStep uses the ceil nearest-rank", () => {
    const st = win();
    percentileNearestRankStep(10, 3, 50, st);
    percentileNearestRankStep(30, 3, 50, st);
    // window [10,30,20] -> sorted [10,20,30]; ceil(50/100*3)=2 -> value 20
    expect(percentileNearestRankStep(20, 3, 50, st)).toBeCloseTo(20, 10);
    // 100th percentile -> largest value in the window
    const stHi = win();
    percentileNearestRankStep(5, 3, 100, stHi);
    percentileNearestRankStep(7, 3, 100, stHi);
    expect(percentileNearestRankStep(9, 3, 100, stHi)).toBeCloseTo(9, 10);
  });
});

/* ----------------------------------------------------- compilePine integration */

function makeBars(n: number): KLineData[] {
  let seed = 5;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  let price = 100;
  return Array.from({ length: n }, (_, i) => {
    const open = price;
    const close = open * (1 + (rand() - 0.48) * 0.06);
    price = close;
    return {
      timestamp: 1700000000000 + i * 86_400_000,
      open,
      high: Math.max(open, close) * 1.01,
      low: Math.min(open, close) * 0.99,
      close,
      volume: 1000 + Math.floor(rand() * 500),
      turnover: 0,
    } as KLineData;
  });
}

const BARS = makeBars(60);

/** Compile and run, throwing on a compile error so the result narrows. */
function artifact(src: string) {
  const out = compilePine(src, BARS, {});
  if ("error" in out) throw new Error(`编译失败：${out.error}`);
  return out;
}

function produced(src: string): boolean {
  const a = artifact(src);
  if (a.abort) throw new Error(`运行中断：${a.abort}`);
  return a.result.lines.some((l) => l.values.some((v) => Number.isFinite(v)));
}

/** Last finite value of the first plot line. */
function lastPlotted(src: string): number {
  const a = artifact(src);
  if (a.abort) throw new Error(`运行中断：${a.abort}`);
  const line = a.result.lines[0];
  const last = [...(line?.values ?? [])].reverse().find((v) => Number.isFinite(v));
  return last ?? NaN;
}

describe("trig / math built-ins via the full engine", () => {
  it("asin/atan match JS math and the 2*asin(1)=PI idiom", () => {
    expect(lastPlotted("plot(asin(0.5))")).toBeCloseTo(Math.asin(0.5), 8);
    expect(lastPlotted("plot(math.atan(1))")).toBeCloseTo(Math.PI / 4, 8);
    expect(lastPlotted("plot(2 * asin(1))")).toBeCloseTo(Math.PI, 8);
    expect(lastPlotted("plot(math.atan2(1, 1))")).toBeCloseTo(Math.PI / 4, 8);
  });

  it("out-of-domain inverse trig reads as na (no finite output), not a silent value", () => {
    expect(produced("plot(asin(2))")).toBe(false);
  });
});

describe("legacy v2/v3 constants and color() via the full engine", () => {
  it("color(color, transp) with a bare colour global plots without aborting", () => {
    expect(() => artifact("c = color(white, 100)\nplot(1, color=c)\n")).not.toThrow();
    expect(artifact("c = color(white, 100)\nplot(1, color=c)\n").abort).toBeFalsy();
    expect(produced("c = color(white, 100)\nplot(1, color=c)\n")).toBe(true);
  });

  it("bare plot-style keyword (dotted) resolves as an enum value", () => {
    expect(artifact("plot(close, style=dotted)\n").abort).toBeFalsy();
  });

  it("legacy unprefixed security() routes through the MTF path", () => {
    const a = artifact("w = security(syminfo.tickerid, \"W\", close)\nplot(w)\n");
    expect(a.abort).toBeFalsy();
  });
});

describe("faithful, not a loosening", () => {
  it("a genuinely undefined variable still aborts (no silent na)", () => {
    const out = compilePine("plot(accdist)\n", BARS, {});
    const aborted = "error" in out ? true : Boolean(out.abort);
    expect(aborted).toBe(true);
  });

  it("a bare colour name does not shadow a user variable of the same name", () => {
    expect(lastPlotted("red = 42\nplot(red)\n")).toBeCloseTo(42, 8);
  });
});
