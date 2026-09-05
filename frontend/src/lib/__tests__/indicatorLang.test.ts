import { describe, expect, it, vi } from "vitest";

// indicatorLang pulls `registerIndicator` in as a value; stub the whole module
// so the tests never touch the real chart library (and stay DOM-free).
vi.mock("klinecharts", () => ({ registerIndicator: vi.fn() }));

import {
  compileFormula,
  cross,
  ema,
  hh,
  ll,
  ma,
  normalizeRows,
  applyUserIndicator,
  rma,
  ref,
  roc,
  stdev,
  sum,
  change,
  nz,
} from "../indicatorLang";
import type { ApplySpec } from "../indicatorLang";
import { FORMULA_TEMPLATES } from "../indicatorTemplates";
import type { KLineData } from "klinecharts";

/** Deterministic random walk so numeric expectations are reproducible. */
function makeBars(n: number): KLineData[] {
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  let price = 100;
  return Array.from({ length: n }, (_, i) => {
    const open = price;
    const close = open * (1 + (rand() - 0.48) * 0.04);
    price = close;
    return {
      timestamp: 1700000000000 + i * 86400000,
      open,
      high: Math.max(open, close) * (1 + rand() * 0.01),
      low: Math.min(open, close) * (1 - rand() * 0.01),
      close,
      volume: 1000 + Math.floor(rand() * 500),
      turnover: 0,
    } as KLineData;
  });
}

const closes = (bars: KLineData[]) => bars.map((b) => b.close);

const last = (a: number[]) => a[a.length - 1];

describe("formula helpers", () => {
  const x = [1, 2, 3, 4, 5, 6];

  it("ma averages the window and NaN-pads the head", () => {
    expect(ma(x, 3).slice(0, 2)).toEqual([NaN, NaN]);
    expect(ma(x, 3)).toEqual([NaN, NaN, 2, 3, 4, 5]);
  });

  it("sum/hh/ll cover the rolling extremes", () => {
    expect(sum(x, 2)).toEqual([NaN, 3, 5, 7, 9, 11]);
    expect(hh([1, 5, 2, 9, 3], 2)).toEqual([1, 5, 5, 9, 9]);
    expect(ll([4, 1, 3, 0, 2], 2)).toEqual([4, 1, 1, 0, 0]);
  });

  it("ema seeds on the first bar and follows the classic k = 2/(n+1) recursion", () => {
    expect(ema([1, 1, 1, 1], 3)).toEqual([1, 1, 1, 1]);
    // n=2 -> k=2/3: 1, 2*(2/3)+1*(1/3), 3*(2/3)+(5/3)*(1/3), ...
    [1, 5 / 3, 23 / 9, 95 / 27].forEach((v, i) => {
      expect(ema([1, 2, 3, 4], 2)[i]).toBeCloseTo(v, 10);
    });
  });

  it("rma matches Wilder smoothing on a constant series", () => {
    expect(last(rma([2, 2, 2, 2, 2, 2], 3))).toBeCloseTo(2, 10);
  });

  it("stdev is the population (biased) standard deviation, as TradingView defaults to", () => {
    // Textbook set: mean 5, Σ(x-µ)² = 32 → σ = √(32/8) = 2 exactly.
    // Pine's `ta.stdev(source, length, biased)` documents biased = true by
    // default, and TA-Lib / KLineChart's built-in BOLL divide by n too, so the
    // bands in this app only line up when we do the same (÷ n-1 inflated every
    // band by √(n/(n-1)) ≈ 2.6% at n = 20).
    expect(last(stdev([2, 4, 4, 4, 5, 5, 7, 9], 8))).toBeCloseTo(2, 10);
    // The sample estimate stays reachable as σ·√(n/(n-1)).
    expect(2 * Math.sqrt(8 / 7)).toBeCloseTo(2.13809, 4);
  });

  it("ref / change / roc shift correctly", () => {
    expect(ref(x, 2)).toEqual([NaN, NaN, 1, 2, 3, 4]);
    expect(change(x)).toEqual([NaN, 1, 1, 1, 1, 1]);
    expect(roc([100, 110, 121], 1)[2]).toBeCloseTo(10, 10);
  });

  it("cross flags golden (+1) and death (-1) crosses only on the event bar", () => {
    const a = [1, 3, 5, 5, 3, 1];
    const b = [4, 4, 4, 2, 2, 2];
    expect(cross(a, b)).toEqual([0, 0, 1, 0, 0, -1]);
  });

  it("nz repairs NaN holes for gain/loss style sequences", () => {
    expect(nz([NaN, 1, NaN, -2])).toEqual([0, 1, 0, -2]);
  });

  it("a NaN inside an ma window yields NaN rather than a poisoned average", () => {
    // window=2 over [1, NaN, 3, 4]: the two windows holding the NaN are gaps,
    // the clean [3, 4] window still averages normally.
    expect(ma([1, NaN, 3, 4], 2)).toEqual([NaN, NaN, NaN, 3.5]);
  });
});

describe("compileFormula", () => {
  it("reports syntax errors instead of throwing", () => {
    const out = compileFormula("return { a: ma(close, })");
    expect("error" in out).toBe(true);
  });

  it("exposes series, params and the function library", () => {
    const compiled = compileFormula("return { m: ma(close, P[0]) };");
    if ("error" in compiled) throw new Error("should compile");
    const bars = makeBars(30);
    const rows = compiled.run(bars, [5]) as Record<string, number[]>;
    expect(rows.m).toHaveLength(30);
    expect(rows.m[4]).toBeCloseTo(ma(closes(bars), 5)[4], 10);
  });
});

describe("formula language", () => {
  const bars = makeBars(40);

  const run = (code: string, params: number[] = []): unknown => {
    const compiled = compileFormula(code);
    if ("error" in compiled) throw new Error(compiled.error);
    return compiled.run(bars, params);
  };

  it("runs sequential assignments", () => {
    const out = run("a = close * 2; b = a + 1; return b;") as number[];
    expect(out[3]).toBeCloseTo(bars[3].close * 2 + 1, 10);
  });

  it("broadcasts scalars against series and keeps object keys as lines", () => {
    const out = run("return { LEVEL: 70, DELTA: close - open };") as Record<string, number[]>;
    expect(out.LEVEL).toHaveLength(bars.length);
    expect(out.LEVEL[7]).toBe(70);
    expect(out.DELTA[2]).toBeCloseTo(bars[2].close - bars[2].open, 10);
  });

  it("supports comparisons, ternary, where and logical words", () => {
    const out = run(
      "up = close > open; a = up ? 1 : -1; b = where(up and true, 2, 3); return { T: a, W: b };",
    ) as { T: number[]; W: number[] };
    bars.forEach((bar, i) => {
      expect(out.T[i]).toBe(bar.close > bar.open ? 1 : -1);
      expect(out.W[i]).toBe(bar.close > bar.open ? 2 : 3);
    });
  });

  it("indexes series and params with [] and tolerates out-of-range as NaN", () => {
    const out = run("return { A: close[0], B: P[1], C: close[-1], D: open[9999] };", [1, 2]) as {
      A: number[];
      B: number[];
      C: number[];
      D: number[];
    };
    expect(out.A[0]).toBeCloseTo(bars[0].close, 10);
    expect(out.B[0]).toBe(2);
    expect(out.C.every(Number.isNaN)).toBe(true);
    expect(out.D.every(Number.isNaN)).toBe(true);
  });

  it("skips comments in all three spellings", () => {
    const out = run("// c\n# h\n/* block\nline */\nreturn close;") as number[];
    expect(out).toHaveLength(bars.length);
  });

  it("allows Chinese names for variables and output lines", () => {
    const out = run("均价 = ma(close, 3); return { 均线: 均价 };") as Record<string, number[]>;
    expect(out.均线[2]).toBeCloseTo(ma(closes(bars), 3)[2], 10);
  });

  // Parse-time failures: compileFormula() itself reports them.
  it.each([
    ["return @@;", /无法识别的字符/],
    ["return { a: 1", /需要|意外的内容/],
    ["a = ;", /意外的内容/],
    ["return;", /意外的内容/],
    ["", /公式是空的/],
    ["/* unclosed", /注释没有闭合/],
    ["return 'abc;", /字符串没有闭合/],
    ["while (true) { x = 1; }", /需要|意外的内容/],
    ["= 5;", /意外的内容/],
  ])("rejects %p at parse time", (code, pattern) => {
    const out = compileFormula(code);
    const msg = "error" in out ? out.error : undefined;
    expect(msg).toBeDefined();
    expect(msg).toMatch(pattern);
  });

  // Evaluation-time failures: they only surface once the formula runs, so
  // applyUserIndicator() must catch them and hand the text back to the UI.
  it.each([
    ["return unknown_series;", /第 1 行：未知变量 "unknown_series"/],
    ["return nosuch(close);", /未知函数 "nosuch\(\)"/],
    ["return ma(close);", /ma\(\) 需要 2 个参数/],
    ["return close +;", /意外的内容/],
  ])("rejects %p when applied", (code, pattern) => {
    const chart = {
      getDataList: () => bars,
      createIndicator: vi.fn(),
      removeIndicator: vi.fn(),
    };
    const err = applyUserIndicator(chart as never, {
      id: `rt${code.length}`,
      label: "x",
      code,
      params: [],
      kind: "pane",
    });
    expect(err).toMatch(pattern);
    expect(chart.createIndicator).not.toHaveBeenCalled();
  });

  it("never loops forever: the language has no loop constructs", () => {
    // `while` / `for` are not keywords: they can only parse as unknown
    // *function* calls, which fail at evaluation instead of looping.
    expect("error" in compileFormula("while (true) { x = 1; }")).toBe(true);
    const out = compileFormula("for(1); return close;");
    if ("error" in out) throw new Error(`should parse, got ${out.error}`);
    expect(() => out.run(bars, [])).toThrow(/未知函数/);
  });

  it("reports the line number of a bad token", () => {
    const out = compileFormula("a = ma(close, 3);\nreturn a +;");
    const msg = "error" in out ? out.error : undefined;
    expect(msg).toMatch(/第 2 行/);
  });

  it("surfaces an unknown variable as a runtime error when applied", () => {
    const chart = {
      getDataList: () => bars,
      createIndicator: vi.fn(),
      removeIndicator: vi.fn(),
    };
    const err = applyUserIndicator(chart as never, {
      id: "rt1",
      label: "x",
      code: "return nosuchseries;",
      params: [],
      kind: "pane",
    });
    expect(err).toMatch(/运行错误：第 1 行：未知变量/);
    expect(chart.createIndicator).not.toHaveBeenCalled();
  });
});

describe("normalizeRows", () => {
  it("wraps a bare array as v1 and keeps non-finite values as gaps", () => {
    const { rows, keys, error } = normalizeRows([1, NaN, 3], 3);
    expect(error).toBeUndefined();
    expect(keys).toEqual(["v1"]);
    expect(rows).toEqual([{ v1: 1 }, { v1: undefined }, { v1: 3 }]);
  });

  it("pads short and truncates long series to the bar count", () => {
    expect(normalizeRows([1, 2], 4).rows).toHaveLength(4);
    expect(normalizeRows([1, 2, 3, 4, 5], 2).rows).toHaveLength(2);
  });

  it("broadcasts scalar entries inside an object result", () => {
    const { rows, keys } = normalizeRows({ flat: 5, line: [1, 2] }, 3);
    expect(keys).toEqual(["flat", "line"]);
    expect(rows).toEqual([{ flat: 5, line: 1 }, { flat: 5, line: 2 }, { flat: 5, line: undefined }]);
  });

  it("drops Infinity so a divide-by-zero plots as a gap", () => {
    expect(normalizeRows([1, Infinity, -Infinity], 3).rows).toEqual([
      { v1: 1 },
      { v1: undefined },
      { v1: undefined },
    ]);
  });

  it("rejects scalars and objects without numbers", () => {
    expect(normalizeRows(42, 3).error).toBeTruthy();
    expect(normalizeRows({ a: "x" }, 3).error).toBeTruthy();
  });
});

describe("built-in templates", () => {
  const bars = makeBars(400);

  it.each(FORMULA_TEMPLATES.map((t) => [t.key, t.kind] as const))(
    "%s (%s) compiles and yields finite values at the tail",
    (key) => {
      const tpl = FORMULA_TEMPLATES.find((t) => t.key === key)!;
      const compiled = compileFormula(tpl.code);
      if ("error" in compiled) throw new Error(`${key}: ${compiled.error}`);
      const { rows, error } = normalizeRows(compiled.run(bars, tpl.params), bars.length);
      expect(error).toBeUndefined();
      expect(rows).toHaveLength(bars.length);
      const tail = rows[rows.length - 1];
      const values = Object.values(tail);
      expect(values.length).toBeGreaterThan(0);
      for (const v of values) expect(Number.isFinite(v as number)).toBe(true);
      // Every line must warm up somewhere inside the series, never all-NaN.
      for (const k of Object.keys(rows[0])) {
        expect(rows.some((r) => r[k] !== undefined)).toBe(true);
      }
    },
  );

  it("RSI stays in 0..100 and matches an independent Wilder reference", () => {
    const tpl = FORMULA_TEMPLATES.find((t) => t.key === "rsi")!;
    const compiled = compileFormula(tpl.code);
    if ("error" in compiled) throw new Error(compiled.error);
    const rsi = (compiled.run(bars, tpl.params) as { RSI: number[] }).RSI;

    // Reference: classic Wilder RSI computed directly from the closes.
    const n = tpl.params[0];
    const c = closes(bars);
    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 1; i <= n; i++) {
      const d = c[i] - c[i - 1];
      avgGain += Math.max(d, 0);
      avgLoss += Math.max(-d, 0);
    }
    avgGain /= n;
    avgLoss /= n;
    for (let i = n + 1; i < c.length; i++) {
      const d = c[i] - c[i - 1];
      avgGain = (avgGain * (n - 1) + Math.max(d, 0)) / n;
      avgLoss = (avgLoss * (n - 1) + Math.max(-d, 0)) / n;
    }
    const reference = 100 - 100 / (1 + avgGain / avgLoss);
    expect(rsi[rsi.length - 1]).toBeCloseTo(reference, 6);
    expect(rsi.filter((v) => Number.isFinite(v)).every((v) => v >= 0 && v <= 100)).toBe(true);
  });

  it("BOLL upper >= mid >= lower wherever all three are defined", () => {
    const tpl = FORMULA_TEMPLATES.find((t) => t.key === "boll")!;
    const compiled = compileFormula(tpl.code);
    if ("error" in compiled) throw new Error(compiled.error);
    const r = compiled.run(bars, tpl.params) as { UP: number[]; MID: number[]; LOW: number[] };
    for (let i = 0; i < bars.length; i++) {
      if (Number.isFinite(r.UP[i])) {
        expect(r.UP[i]).toBeGreaterThanOrEqual(r.MID[i]);
        expect(r.MID[i]).toBeGreaterThanOrEqual(r.LOW[i]);
      }
    }
  });

  it("Donchian high/low bracket the close", () => {
    const tpl = FORMULA_TEMPLATES.find((t) => t.key === "donchian")!;
    const compiled = compileFormula(tpl.code);
    if ("error" in compiled) throw new Error(compiled.error);
    const r = compiled.run(bars, tpl.params) as { UP: number[]; LOW: number[] };
    for (let i = tpl.params[0] - 1; i < bars.length; i++) {
      expect(r.UP[i]).toBeGreaterThanOrEqual(bars[i].close);
      expect(r.LOW[i]).toBeLessThanOrEqual(bars[i].close);
    }
  });
});

describe("applyUserIndicator", () => {
  const bars = makeBars(60);

  const fakeChart = () => ({
    getDataList: () => bars,
    createIndicator: vi.fn(),
    removeIndicator: vi.fn(),
  });

  it("mounts a valid formula on the candle pane for overlays", () => {
    const chart = fakeChart();
    const err = applyUserIndicator(chart as never, {
      id: "t1",
      label: "测试",
      code: "return { M: ma(close, P[0]) };",
      params: [5],
      kind: "overlay",
    });
    expect(err).toBeNull();
    expect(chart.removeIndicator).toHaveBeenCalledWith({ name: "UCI_t1" });
    expect(chart.createIndicator).toHaveBeenCalledWith(
      { name: "UCI_t1", paneId: "candle_pane" },
      true,
    );
  });

  // ⑲: a pane-mounted formula must get the *stable* pane id too. Without it the
  // library invents `indicator_pane_<Date.now()>_<n>` on every mount, so any
  // drawing stored against that pane has a dead address after a reload — and
  // `createOverlay` would silently move it onto the candle pane instead.
  it("mounts a sub-chart pane on a stable paneId", () => {
    const chart = fakeChart();
    expect(
      applyUserIndicator(chart as never, {
        id: "t2",
        label: "副图",
        code: "return close;",
        params: [],
        kind: "pane",
      }),
    ).toBeNull();
    expect(chart.createIndicator).toHaveBeenCalledWith({ name: "UCI_t2", paneId: "sub:UCI_t2" });
  });

  it("surfaces syntax, runtime and empty-output errors without mounting", () => {
    const chart = fakeChart();
    const base = { id: "t3", label: "x", params: [], kind: "pane" } satisfies Omit<
      ApplySpec,
      "code"
    >;
    const withCode = (code: string): ApplySpec => ({ ...base, code });
    expect(
      applyUserIndicator(chart as never, withCode("return {{")),
    ).toMatch(/语法错误/);
    expect(
      applyUserIndicator(chart as never, withCode("return mystery_series;")),
    ).toMatch(/运行错误/);
    expect(applyUserIndicator(chart as never, withCode("return 42;"))).toMatch(
      /数组/,
    );
    expect(
      applyUserIndicator(chart as never, withCode("return ma(close, 9999);")),
    ).toMatch(/没有产生任何数值/);
    expect(chart.createIndicator).not.toHaveBeenCalled();
  });
});
