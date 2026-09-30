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

/** Full value series of the `li`-th plot line. */
function lineValues(src: string, li = 0): number[] {
  const a = artifact(src);
  if (a.abort) throw new Error(`运行中断：${a.abort}`);
  return a.result.lines[li]?.values ?? [];
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

/* ---------------------------------------------- corpus pass-rate push (Track D) */

const H4 = "//@version=4\nstudy(\"t\")\n";
const HIGH = BARS.map((b) => b.high);
const LOW = BARS.map((b) => b.low);
const CLOSE = BARS.map((b) => b.close);
const rollMax = (arr: number[], n: number) =>
  arr.map((_, i) => Math.max(...arr.slice(Math.max(0, i - n + 1), i + 1)));
const rollMin = (arr: number[], n: number) =>
  arr.map((_, i) => Math.min(...arr.slice(Math.max(0, i - n + 1), i + 1)));
const eqSeries = (a: number[], b: number[]) => {
  expect(a.length).toBe(b.length);
  for (let i = 0; i < a.length; i++) {
    if (Number.isNaN(a[i]) || Number.isNaN(b[i])) expect(a[i]).toBe(b[i]);
    else expect(a[i]).toBeCloseTo(b[i], 10);
  }
};

describe("highest / lowest (缺陷 A)", () => {
  it("one-arg highest(length) uses high and equals the two-arg form", () => {
    const n = 5;
    const one = lineValues(`${H4}plot(highest(${n}))`);
    const two = lineValues(`${H4}plot(highest(high, ${n}))`);
    eqSeries(one, two);
    eqSeries(one, rollMax(HIGH, n));
  });

  it("one-arg lowest(length) uses low; two-arg takes the given source", () => {
    const n = 5;
    eqSeries(lineValues(`${H4}plot(lowest(${n}))`), rollMin(LOW, n));
    eqSeries(lineValues(`${H4}plot(lowest(close, ${n}))`), rollMin(CLOSE, n));
  });
});

describe("highestbars / lowestbars (缺陷 F — same one-arg overload as highest/lowest)", () => {
  // halftrend.pine (a pinned smoke-gate script) leans on ta.highestbars(len) /
  // ta.lowestbars(len); before the fix those read `len` as the source and a flat
  // 14 window, silently corrupting its derived line while still plotting finite.
  it("one-arg highestbars(length) uses high and equals the two-arg form", () => {
    const n = 5;
    eqSeries(
      lineValues(`${H4}plot(ta.highestbars(${n}))`),
      lineValues(`${H4}plot(ta.highestbars(high, ${n}))`),
    );
    eqSeries(
      lineValues(`${H4}plot(ta.lowestbars(${n}))`),
      lineValues(`${H4}plot(ta.lowestbars(low, ${n}))`),
    );
  });

  it("the returned offset is the bars-ago index of the window peak (ties -> most recent)", () => {
    const n = 5;
    const exp = HIGH.map((_, i) => {
      const start = Math.max(0, i - n + 1);
      let best = -Infinity;
      let at = start;
      for (let j = start; j <= i; j++)
        if (HIGH[j] >= best) {
          best = HIGH[j];
          at = j;
        }
      return at - i; // <= 0
    });
    eqSeries(lineValues(`${H4}plot(ta.highestbars(${n}))`), exp);
  });
});

describe("comma statement separator (缺陷 G — v5/v6 same-line statements)", () => {
  // mihakralj v6 corpus leans on `a += x, b += y` / `a := x, b := y` / two call
  // statements sharing a line. Before the fix every such line was a compile
  // error (`endOfStmt` choked on the top-level comma); now each segment runs as
  // its own statement. Asserted on concrete last-bar values, not "it parses".
  const H6 = "//@version=6\nindicator(\"t\")\n";

  it("compound assignments split by a comma both apply (y += 3, y += 4 -> 7)", () => {
    const src = `${H6}var float y = 0.0\nif barstate.islast\n    y += 3.0, y += 4.0\nplot(y)\n`;
    expect(lastPlotted(src)).toBeCloseTo(7, 10);
  });

  it("a `:=` reassignment and a compound share one line (z := 2, z += 5 -> 7)", () => {
    const src = `${H6}var float z = 0.0\nif barstate.islast\n    z := 2.0, z += 5.0\nplot(z)\n`;
    expect(lastPlotted(src)).toBeCloseTo(7, 10);
  });

  it("comma-separated call statements each become a plot line", () => {
    const a = artifact(`${H6}x = 1.0, w = x + 1.0\nplot(x), plot(w)\n`);
    expect(a.result.lines.length).toBe(2);
    expect(a.result.lines[0].values[0]).toBeCloseTo(1, 10);
    expect(a.result.lines[1].values[0]).toBeCloseTo(2, 10);
  });

  it("the apo `var x = a, var y = b` form (with the source's missing comma added) compiles", () => {
    // apo.pine itself is left honestly red: line 18 omits a comma between two
    // `var` decls (`= na var float ...`), which is not valid Pine. This is the
    // corrected form, proving the engine handles the well-formed comma-var list.
    const a = artifact(`${H6}var bool warmup = true, var float result = warmup ? 9.0 : na\nplot(result)\n`);
    expect(a.abort ?? "").toBe("");
    expect(lastPlotted(`${H6}var bool warmup = true, var float result = warmup ? 9.0 : na\nplot(result)\n`)).toBeCloseTo(9, 10);
  });
});

describe("input() kind detection (缺陷 B / C / E)", () => {
  it("type=input.source binds to the live series, not a bar-0 pinned constant", () => {
    const s = lineValues(`${H4}src = input(defval = close, type = input.source, title = "S")\nplot(src)`);
    // Must equal close per bar (varies), not be the constant close[0].
    expect(s[10]).toBeCloseTo(CLOSE[10], 8);
    expect(Math.abs(s[10] - CLOSE[0])).toBeGreaterThan(1e-6);
    eqSeries(s, CLOSE);
  });

  it("numeric enum (type=input.integer + numeric options) stays a number", () => {
    const p = lineValues(
      `${H4}poles = input(defval = 4, type = input.integer, options = [1, 2, 3, 4], title = "P")\nplot(poles)`,
    );
    expect(p.every((v) => v === 4)).toBe(true); // finite numeric 4, not na/string
  });

  it("bare string enum (defval + string options) resolves as a string for ==", () => {
    const q = lineValues(
      `${H4}m = input(defval = "SMA", options = ["EMA", "SMA", "LM"], title = "M")\nplot(m == "SMA" ? 1 : 0)`,
    );
    expect(q.every((v) => v === 1)).toBe(true);
  });
});

describe("stateful builtins keep per-call-site history (缺陷 D)", () => {
  // A helper wrapping a rolling builtin, called twice on different sources, must
  // behave exactly like two independent direct calls — before the fix both calls
  // shared one window keyed by the helper body's AST node, silently cross-
  // polluting (and blanking scripts like hampel_filter via na cascades).
  const pnr = (src: number[], n: number) => {
    const w = [...src];
    return w.map((_, i) => {
      if (i < n - 1) return NaN;
      const win = w.slice(i - n + 1, i + 1);
      const s = [...win].sort((a, b) => a - b);
      return s[Math.max(0, Math.min(s.length - 1, Math.ceil(0.5 * s.length) - 1))];
    });
  };
  it("_m(close) and _m(high) each equal their direct call, and differ from each other", () => {
    const n = 14;
    const two = lineValues(
      `${H4}_m(x, k) => percentile_nearest_rank(x, k, 50)\na = _m(close, ${n})\nb = _m(high, ${n})\nplot(a)\nplot(b)`,
    );
    const oneA = lineValues(`${H4}_m(x, k) => percentile_nearest_rank(x, k, 50)\nplot(_m(close, ${n}))`);
    const oneB = lineValues(`${H4}_m(x, k) => percentile_nearest_rank(x, k, 50)\nplot(_m(high, ${n}))`);
    const second = lineValues(
      `${H4}_m(x, k) => percentile_nearest_rank(x, k, 50)\na = _m(close, ${n})\nb = _m(high, ${n})\nplot(a)\nplot(b)`,
      1,
    );
    eqSeries(two, oneA); // site 1 (close) == its own single call
    eqSeries(second, oneB); // site 2 (high) == its own single call
    const direct = pnr(CLOSE, n);
    eqSeries(two, direct); // and matches a hand-computed median window
  });
});

describe("ta.sum (缺陷 H — documented rolling sum whose primitive already existed)", () => {
  // sumStep was already internal (used by MFI/Chande) but never surfaced as
  // ta.sum, so Theil's U / WMAPE / WRMSE aborted. ta.sum(source, length) is the
  // rolling sum with the same full-window warmup as ta.sma (na until length).
  const rollSum = (arr: number[], n: number) =>
    arr.map((_, i) => (i < n - 1 ? NaN : arr.slice(i - n + 1, i + 1).reduce((a, b) => a + b, 0)));

  it("ta.sum(close, 5) equals the hand-computed rolling window sum", () => {
    eqSeries(lineValues(`${H4}plot(ta.sum(close, 5))`), rollSum(CLOSE, 5));
  });

  it("ta.sum equals ta.sma * length on the same source (cross-builtin check)", () => {
    const n = 7;
    eqSeries(
      lineValues(`${H4}plot(ta.sum(high, ${n}))`),
      lineValues(`${H4}plot(ta.sma(high, ${n}) * ${n})`),
    );
  });
});

describe("array.fill (缺陷 I — whole-array seed and ranged fill)", () => {
  const H6 = "//@version=6\nindicator(\"t\")\n";

  it("array.fill(buf, value) with no indices primes every element (RGMA/ZLEMA idiom)", () => {
    // Four na slots overwritten each bar with the live close, so array.sum is
    // 4*close per bar — proves the fill used the current-bar value AND hit all
    // four positions, not just index 0.
    const s = lineValues(
      `${H6}var a = array.new_float(4, na)\narray.fill(a, close)\nplot(array.sum(a))\n`,
    );
    eqSeries(s, CLOSE.map((c) => 4 * c));
  });

  it("array.fill honors index_from / index_to as an exclusive run", () => {
    // [0,0,0] -> fill indices [1,3) with 1.0 -> [0,1,1]; sum = 2, every bar.
    const src = `${H6}var a = array.new_float(3, 0.0)\narray.fill(a, 1.0, 1, 3)\nplot(array.sum(a))\n`;
    expect(lastPlotted(src)).toBeCloseTo(2, 10);
  });
});

describe("array.join (缺陷 J — concatenate elements to a string, separator between only)", () => {
  const H6 = "//@version=6\nindicator(\"t\")\n";

  it("joins a string array with the separator only between elements", () => {
    // "x-y-z": separator sits between, never leading or trailing.
    const src = `${H6}a = array.from("x", "y", "z")\nplot(array.join(a, "-") == "x-y-z" ? 1 : 0)\n`;
    expect(lastPlotted(src)).toBe(1);
  });

  it("empty separator concatenates with no gap (default form)", () => {
    const src = `${H6}a = array.from("ab", "cd")\nplot(array.join(a, "") == "abcd" ? 1 : 0)\n`;
    expect(lastPlotted(src)).toBe(1);
  });

  it("numeric elements render as Pine strings (integer without .0)", () => {
    const src = `${H6}a = array.from(1, 2, 3)\nplot(array.join(a, ",") == "1,2,3" ? 1 : 0)\n`;
    expect(lastPlotted(src)).toBe(1);
  });

  it("honors index_from / index_to as an exclusive joined subset", () => {
    // ["1","2","3","4"] -> join [1,3) with "" -> "2" + "3" = "23".
    const full = `${H6}a = array.from("1", "2", "3", "4")\n`;
    expect(lastPlotted(`${full}plot(array.join(a, "", 1, 3) == "23" ? 1 : 0)\n`)).toBe(1);
    // index_to omitted (na) runs to the end: join [2,end) with "+" -> "3+4".
    expect(lastPlotted(`${full}plot(array.join(a, "+", 2) == "3+4" ? 1 : 0)\n`)).toBe(1);
  });
});

describe("bitwise operators (缺陷 K — & | << >> ~, fft.pine radix-2)", () => {
  const H6 = "//@version=6\nindicator(\"t\")\n";
  // Assert on the boolean RESULT of a concrete equality, so each case pins the
  // exact integer the operator produces (not "it parses").
  const one = (expr: string) => lastPlotted(`${H6}plot((${expr}) ? 1 : 0)\n`);

  it("AND / OR yield exact integers", () => {
    expect(one("(6 & 3) == 2")).toBe(1); // 110 & 011 = 010
    expect(one("(6 | 3) == 7")).toBe(1); // 110 | 011 = 111
  });

  it("left / right shift moves bits", () => {
    expect(one("(5 << 2) == 20")).toBe(1);
    expect(one("(20 >> 2) == 5")).toBe(1);
  });

  it("unary bitwise NOT is -(n+1)", () => {
    expect(one("(~5) == -6")).toBe(1);
  });

  it("precedence: additive binds tighter than shift (2 << 1 + 1 = 8, not 5)", () => {
    expect(one("2 << 1 + 1 == 8")).toBe(1);
  });

  it("precedence: comparison binds tighter than bitwise AND (2 & 1 == 1 = 0)", () => {
    // C-like: & is looser than ==, so this is 2 & (1 == 1) = 2 & 1 = 0, not the
    // (2 & 1) == 1 = 1 a too-tight & would give.
    expect(one("(2 & 1 == 1) == 0")).toBe(1);
  });

  it("bitReverse loop reproduces the radix-2 permutation (1, bits=3 -> 4)", () => {
    // Same body as fft.pine's helper, written in the valid Pine head form
    // (`name(params) =>`, no C-style return-type prefix): r := (r << 1) | (x & 1).
    const src =
      `${H6}bitReverse(x, bits) =>\n` +
      `    int r = 0\n` +
      `    for i = 0 to bits - 1\n` +
      `        r := (r << 1) | (x & 1)\n` +
      `        x := x >> 1\n` +
      `    r\n` +
      `plot(bitReverse(1, 3) == 4 ? 1 : 0)\n`;
    expect(lastPlotted(src)).toBe(1); // 001 -> 100
  });
});
