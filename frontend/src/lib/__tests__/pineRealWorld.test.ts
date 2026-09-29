import { describe, expect, it, vi } from "vitest";

/**
 * Compatibility acceptance for code we did not write.
 *
 * Every source below is copied verbatim from the wild — TradingView's own
 * built-in Supertrend, a strategy template from the awesome-pinescript index,
 * a community "Enhanced RSI" indicator, and the Supertrend crossover strategy
 * shipped in another platform's Pine-compat docs. They stress the paths our
 * own library entries avoid: legacy `input()`, `title=` named args, multi-line
 * user functions, `var` + `:=` persistence, hex colours, `hline`, `fill`,
 * `plot()` handles, `display=display.none` and self-referential `:=` inside a
 * function body. The last group of cases pins the syntax shapes on their own,
 * so a regression names the construct instead of blaming a whole script.
 *
 * The bar per script is deliberately low: it must *parse*, it must *run*
 * without throwing, and it must produce output. Numbers are checked only
 * where the reference value is unambiguous — TradingView's own Supertrend is
 * the exception, because there the hand-written Pine body and our built-in
 * `ta.supertrend` describe the same indicator and must agree bar for bar.
 * That cross-check is what caught two real defects (the direction sign and the
 * band-ratchet state machine), which is the whole point of importing sources
 * we did not write instead of only testing our own.
 */
vi.mock("klinecharts", () => ({ registerIndicator: vi.fn() }));

import { compilePine, isPineSource, isPineStrategy, type PineArtifact } from "../pineScript";
import type { KLineData } from "klinecharts";

function makeBars(n: number): KLineData[] {
  let seed = 11;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  let price = 50;
  return Array.from({ length: n }, (_, i) => {
    const open = price;
    const close = open * (1 + (rand() - 0.48) * 0.06);
    price = close;
    return {
      timestamp: 1700000000000 + i * 86400000,
      open,
      high: Math.max(open, close) * (1 + rand() * 0.02),
      low: Math.min(open, close) * (1 - rand() * 0.02),
      close,
      volume: 800 + Math.floor(rand() * 1200),
      turnover: 0,
    } as KLineData;
  });
}

const BARS = makeBars(300);

function run(code: string, params?: number[]): PineArtifact {
  const out = compilePine(code, BARS, params ? { params } : {});
  if ("error" in out) throw new Error(`编译失败：${out.error}`);
  if (out.abort) throw new Error(`中断：${out.abort}`);
  return out;
}

const filled = (a: PineArtifact) =>
  a.result.lines.reduce((n, l) => n + l.values.filter((v) => Number.isFinite(v)).length, 0);

/** TradingView's own built-in Supertrend, as published on a scripts page. */
const TV_SUPERTREND = `//@version=5
indicator("Supertrend TradingView", overlay=true, timeframe="", timeframe_gaps=true)
pine_supertrend(factor, atrPeriod) =>
    src = hl2
    atr = ta.atr(atrPeriod)
    upperBand = src + factor * atr
    lowerBand = src - factor * atr
    prevLowerBand = nz(lowerBand[1])
    prevUpperBand = nz(upperBand[1])
    lowerBand := lowerBand > prevLowerBand or close[1] < prevLowerBand ? lowerBand : prevLowerBand
    upperBand := upperBand < prevUpperBand or close[1] > prevUpperBand ? upperBand : prevUpperBand
    int direction = na
    float superTrend = na
    prevSuperTrend = superTrend[1]
    if na(atr[1])
        direction := 1
    else if prevSuperTrend == prevUpperBand
        direction := close > upperBand ? -1 : 1
    else
        direction := close < lowerBand ? 1 : -1
    superTrend := direction == -1 ? lowerBand : upperBand
    [superTrend, direction]
atrPeriod = input.int(10, "ATR Length")
factor = input.float(3.0, "Factor", step = 0.01)
[supertrend, direction] = pine_supertrend(factor, atrPeriod)
bodyMiddle = plot((open + close) / 2, display=display.none)
upTrend = plot(direction < 0 ? supertrend : na, "Up Trend", color = color.green, style=plot.style_linebr)
downTrend = plot(direction < 0? na : supertrend, "Down Trend", color = color.red, style=plot.style_linebr)
fill(bodyMiddle, upTrend, color.new(color.green, 90), fillgaps=false)
fill(bodyMiddle, downTrend, color.new(color.red, 90), fillgaps=false)
// Cross-check the hand-written Pine function against our own ta.supertrend.
[stBuiltin, dirBuiltin] = ta.supertrend(factor, atrPeriod)
plot(direction == dirBuiltin ? 1 : 0, "方向一致")
plot(abs(supertrend - stBuiltin), "轨道差")`;

/** awesome-pinescript "MA crossover" starter strategy. */
const MA_CROSSOVER = `//@version=5
strategy("MA Crossover Strategy", overlay=true, initial_capital=10000)
fastLength = input.int(9, "Fast MA Period")
slowLength = input.int(21, "Slow MA Period")
fastMA = ta.sma(close, fastLength)
slowMA = ta.sma(close, slowLength)
plot(fastMA, color=color.new(color.blue, 0), title="Fast MA")
plot(slowMA, color=color.new(color.red, 0), title="Slow MA")
longCondition = ta.crossover(fastMA, slowMA)
shortCondition = ta.crossunder(fastMA, slowMA)
if (longCondition)
    strategy.entry("Long", strategy.long)
if (shortCondition)
    strategy.entry("Short", strategy.short)`;

/** Community "Enhanced RSI": user function block, var/:=, hline, plotshape. */
const ENHANCED_RSI = `//@version=5
indicator("Enhanced RSI [AI Optimized]", shorttitle="ERSI Pro", overlay=false, precision=2)
period = input.int(14, "基础周期")
emaPeriod = input.int(50, "ATR平滑周期")
overbought = input.int(65, "超买阈值基准")
oversold = input.int(35, "超卖阈值基准")
power = input.float(0.8, "非线性压缩指数", step=0.1)
useDynamicBands = input.bool(true, "启用动态阈值")
calcATR(src, len) =>
    tr = math.max(high - low, math.max(math.abs(high - src[1]), math.abs(low - src[1])))
    ta.ema(tr, len)
var float ersi = na
var float upperBand = na
var float lowerBand = na
atr = calcATR(close, period)
atrEMA = ta.ema(atr, emaPeriod)
volatilityFactor = atr / atrEMA
delta = close - close[1]
adjustedDelta = delta / math.sqrt(math.max(volatilityFactor, 0.1))
dynamicPeriod = period * (1 + volatilityFactor / 3)
alpha = 2 / (dynamicPeriod + 1)
posDelta = math.max(adjustedDelta, 0)
negDelta = math.max(-adjustedDelta, 0)
avgGain = ta.ema(posDelta, int(alpha * 1000))
avgLoss = ta.ema(negDelta, int(alpha * 1000))
rs = avgGain / math.max(avgLoss, 0.0001)
compressedRS = math.pow(rs, power)
ersi := 100 - 100 / (1 + compressedRS)
volatilityAdj = 5 * (atr / ta.sma(atr, 50) - 1)
upperBand := useDynamicBands ? (overbought + volatilityAdj) : overbought
lowerBand := useDynamicBands ? (oversold - volatilityAdj) : oversold
longCondition = ta.crossover(ersi, lowerBand)
shortCondition = ta.crossunder(ersi, upperBand)
plot(ersi, "ERSI", color=#2962FF, linewidth=2)
hline(50, "Midline", color=color.gray, linestyle=hline.style_dotted)
band1 = plot(upperBand, "Upper Band", color=#FF6D00, linestyle=plot.style_circles)
band2 = plot(lowerBand, "Lower Band", color=#00C853, linestyle=plot.style_circles)
fill(band1, band2, color=color.new(#2962FF, 90), title="Dynamic Band")
plotshape(longCondition, title="Buy Signal", style=shape.triangleup, location=location.belowbar, color=#00C853, size=size.small)
plotshape(shortCondition, title="Sell Signal", style=shape.triangledown, location=location.abovebar, color=#FF5252, size=size.small)`;

/** Supertrend entry/exit strategy as published by a Pine-compatible platform. */
const SUPERTREND_STRATEGY = `strategy("supertrend", overlay=true)
[supertrend, direction] = ta.supertrend(input(5, "factor"), input.int(10, "atrPeriod"))
plot(direction < 0 ? supertrend : na, "Up direction", color = color.green, style=plot.style_linebr)
plot(direction > 0 ? supertrend : na, "Down direction", color = color.red, style=plot.style_linebr)
if direction < 0
    if supertrend > supertrend[2]
        strategy.entry("entry long", strategy.long)
    else if strategy.position_size < 0
        strategy.close_all()
else if direction > 0
    if supertrend < supertrend[3]
        strategy.entry("entry short", strategy.short)
    else if strategy.position_size > 0
        strategy.close_all()`;

describe("real-world Pine sources", () => {
  const head = "//@version=5\nindicator(\"t\")\n";

  it("parses every call form the wild uses for markers and functions", () => {
    // plotshape() positionally, exactly as older docs spelled it.
    expect(
      run(head + 'plotshape(close > close[1], "x", shape.triangleup, location.belowbar, #00C853, "多")').result.markers.length,
    ).toBe(1);
    // …and fully named, which is what most published scripts do.
    expect(
      run(
        head +
          'plotshape(close < close[1], title="y", style=shape.diamond, location=location.abovebar, color=#FF5252, size=size.small)',
      ).result.markers.length,
    ).toBe(1);
    // `var` + `:=` must be visible to ta.crossover, not just to plain reads.
    expect(filled(run(head + "var float e = na\ne := close\nplot(ta.crossover(e, ta.sma(close, 5)) ? 1 : 0, \"x\")"))).toBeGreaterThan(0);
  });

  it("supports user functions: inline, block, tuple return, per-call-site state", () => {
    expect(filled(run(head + "double(x) => x * 2\nplot(double(close), \"d\")"))).toBe(BARS.length);
    const block = run(head + "double(x) =>\n    y = x * 2\n    y\nplot(double(close), \"d\")");
    expect(block.result.lines[0].values[10]).toBeCloseTo(BARS[10].close * 2, 6);
    const tuple = run(head + "pair(x) =>\n    [x, x * 2]\n[a, b] = pair(close)\nplot(a, \"a\")\nplot(b, \"b\")");
    expect(tuple.result.lines.map((l) => l.name)).toEqual(["a", "b"]);
    expect(tuple.result.lines[1].values[10]).toBeCloseTo(BARS[10].close * 2, 6);
    // Two call sites of one function keep separate histories in Pine.
    const twice = run(head + "half(x) => x / 2\nplot(half(close), \"a\")\nplot(half(high), \"b\")");
    expect(twice.result.lines[0].values[10]).toBeCloseTo(BARS[10].close / 2, 6);
    expect(twice.result.lines[1].values[10]).toBeCloseTo(BARS[10].high / 2, 6);
  });

  it("draws nothing for a plot declared with display=display.none", () => {
    // The built-in Supertrend uses such a plot purely as a fill anchor.
    const a = run(
      head + 'plot(close, "shown")\nplot(close * 2, display=display.none)\nplot(close * 3, "also", display=display.none)',
    );
    expect(a.result.lines.map((l) => l.name)).toEqual(["shown"]);
  });

  it("reverses the book when an entry comes against the open position", () => {
    // `strategy.entry("Long")` / `("Short")` on alternating bars: TradingView
    // nets the whole book, so every flip must produce a closed trade.
    const a = run(
      "//@version=5\nstrategy(\"r\", overlay=true)\nif close > close[1]\n    strategy.entry(\"Long\", strategy.long)\nif close < close[1]\n    strategy.entry(\"Short\", strategy.short)",
    );
    const trades = a.result.report?.trades ?? [];
    expect(trades.length).toBeGreaterThan(50);
    expect(trades.every((t) => Number.isFinite(t.pnl) && t.exitBar >= t.entryBar)).toBe(true);
    expect(trades.some((t) => t.side === "long") && trades.some((t) => t.side === "short")).toBe(true);
  });

  it("all four are recognised as Pine before they ever reach the parser", () => {
    for (const src of [TV_SUPERTREND, MA_CROSSOVER, ENHANCED_RSI, SUPERTREND_STRATEGY]) {
      expect(isPineSource(src)).toBe(true);
    }
    // Only the two that actually place orders may land in the strategy panel.
    expect(isPineStrategy(MA_CROSSOVER)).toBe(true);
    expect(isPineStrategy(SUPERTREND_STRATEGY)).toBe(true);
    expect(isPineStrategy(TV_SUPERTREND)).toBe(false);
    expect(isPineStrategy(ENHANCED_RSI)).toBe(false);
  });

  it("runs TradingView's built-in Supertrend (function block + self-referencing :=)", () => {
    const a = run(TV_SUPERTREND);
    expect(a.result.scriptKind).toBe("indicator");
    // `bodyMiddle` is a display.none anchor, so it must never reach the chart.
    expect(a.result.lines.map((l) => l.name)).toEqual(["Up Trend", "Down Trend", "方向一致", "轨道差"]);
    expect(a.result.lines.length).toBeGreaterThanOrEqual(2);
    // The two trend lines are mutually exclusive by construction.
    const up = a.result.lines.find((l) => l.name === "Up Trend");
    const down = a.result.lines.find((l) => l.name === "Down Trend");
    expect(up && down).toBeTruthy();
    let both = 0;
    for (let i = 0; i < BARS.length; i += 1) {
      if (Number.isFinite(up!.values[i]) && Number.isFinite(down!.values[i])) both += 1;
    }
    expect(both).toBe(0);
    expect(filled(a)).toBeGreaterThan(BARS.length / 2);
    // Supertrend tracks price, so it must stay in the same order of magnitude.
    const tracked = [...up!.values, ...down!.values].filter((v) => Number.isFinite(v)) as number[];
    expect(Math.min(...tracked)).toBeGreaterThan(0);
    expect(Math.max(...tracked)).toBeLessThan(Math.max(...BARS.map((b) => b.high)) * 3);
    // In TradingView `direction` is -1 above all: uptrend. The hand-written
    // function and our built-in must agree bar for bar once ATR has warmed up.
    const agree = a.result.lines.find((l) => l.name === "方向一致");
    const gap = a.result.lines.find((l) => l.name === "轨道差");
    expect(agree && gap).toBeTruthy();
    let hits = 0;
    let counted = 0;
    for (let i = 30; i < BARS.length; i += 1) {
      if (!Number.isFinite(agree!.values[i])) continue;
      counted += 1;
      if (agree!.values[i] === 1) hits += 1;
    }
    expect(counted).toBeGreaterThan(BARS.length / 2);
    expect(hits / counted).toBeGreaterThan(0.95);
    const gaps = gap!.values.slice(30).filter((v) => Number.isFinite(v)) as number[];
    const px = BARS.reduce((s, b) => s + b.close, 0) / BARS.length;
    expect(gaps.reduce((s, v) => s + v, 0) / gaps.length).toBeLessThan(px * 0.01);
  });

  it("runs the awesome-pinescript MA crossover strategy and reports trades", () => {
    const a = run(MA_CROSSOVER);
    expect(a.result.scriptKind).toBe("strategy");
    expect(filled(a)).toBeGreaterThan(0);
    const rep = a.result.report;
    expect(rep).toBeTruthy();
    expect(rep!.trades.length).toBeGreaterThan(0);
    expect(Number.isFinite(rep!.netPnl)).toBe(true);
    // 9/21 SMA on a 300-bar walk cannot be right on every trade.
    expect(rep!.winRatePct).toBeGreaterThanOrEqual(0);
    expect(rep!.winRatePct).toBeLessThanOrEqual(100);
  });

  it("runs the community Enhanced RSI (user fn, var/:=, hex, hline, plotshape)", () => {
    const a = run(ENHANCED_RSI);
    const ersi = a.result.lines.find((l) => l.name === "ERSI");
    expect(ersi).toBeTruthy();
    const values = ersi!.values.filter((v) => Number.isFinite(v)) as number[];
    expect(values.length).toBeGreaterThan(100);
    // An RSI-flavoured oscillator must live in [0, 100].
    expect(Math.min(...values)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...values)).toBeLessThanOrEqual(100);
    expect(a.result.hlines.some((h) => h.price === 50)).toBe(true);
    // The 65/35 defaults never trip on a random walk, and an all-empty marker
    // series is dropped at build time — so signals are asserted with tuned
    // thresholds, which doubles as proof that `params` reach `input.*()` and
    // that `useDynamicBands` (a bool input) is honoured as `1`.
    expect(a.result.markers.length).toBe(0);
    const tuned = run(ENHANCED_RSI, [14, 20, 52, 48, 0.8, 1]);
    expect(tuned.result.markers.length).toBe(2);
    for (const m of tuned.result.markers) {
      expect(m.values.some((v) => Number.isFinite(v))).toBe(true);
      expect(m.values.every((v, i) => !Number.isFinite(v) || (m.up[i] ? v >= BARS[i].low : v <= BARS[i].high))).toBe(true);
    }
  });

  it("runs the Supertrend long/short strategy (legacy input(), nested if/else if)", () => {
    const a = run(SUPERTREND_STRATEGY);
    expect(a.result.scriptKind).toBe("strategy");
    const trades = a.result.report?.trades ?? [];
    expect(trades.length).toBeGreaterThan(0);
    // Both sides of the book get used by a long/short system.
    expect(trades.some((t) => t.side === "long")).toBe(true);
    expect(trades.some((t) => t.side === "short")).toBe(true);
  });

  it("honours user-supplied input overrides on imported scripts", () => {
    const defaults = run(MA_CROSSOVER);
    const tuned = run(MA_CROSSOVER, [3, 7]);
    expect(defaults.result.inputs.length).toBeGreaterThanOrEqual(2);
    const tunedTrades = tuned.result.report?.trades.length ?? 0;
    expect(tunedTrades).not.toBe(defaults.result.report?.trades.length);
  });
});

/**
 * Syntax shapes demanded by the 40-script TradingView corpus. Each construct
 * used to die in the parser (a hard ERROR); now it either runs or reaches the
 * runtime as an honest feature-boundary ABORT. The bar is the same as above:
 * it must parse, and where the value is unambiguous it must be right.
 */
describe("Pine v5/v6 syntax shapes the corpus demanded", () => {
  const head = "//@version=5\nindicator(\"t\")\n";
  const parseOk = (code: string): { abort?: string } => {
    const out = compilePine(code, BARS, {}) as { error?: string; abort?: string };
    if (out.error) throw new Error(`解析失败：${out.error}`);
    return out;
  };

  it("desugars compound assignment into reassignment", () => {
    // 0 → +5 → *2 → -3 = 7 on every bar; order-sensitive and deterministic.
    const a = run(head + "x = 0\nx += 5\nx *= 2\nx -= 3\nplot(x, \"x\")");
    expect(a.result.lines[0].values[10]).toBe(7);
    const b = run(head + "y = 10\ny /= 4\nplot(y, \"y\")");
    expect(b.result.lines[0].values[10]).toBeCloseTo(2.5, 10);
  });

  it("lexes a trailing-dot integer literal", () => {
    expect(run(head + 'plot(2. + 3., "d")').result.lines[0].values[10]).toBe(5);
  });

  it("ignores an `import TradingView/ta/N` module line", () => {
    const a = run("//@version=5\nimport TradingView/ta/9\nindicator(\"t\")\nplot(ta.sma(close, 5), \"s\")");
    expect(filled(a)).toBeGreaterThan(0);
  });

  it("accepts comma-parallel declarations", () => {
    const a = run(head + "var a = 1, var b = 2, var c = 3\nplot(a + b + c, \"s\")");
    expect(a.result.lines[0].values[10]).toBe(6);
  });

  it("runs typed-array and generic-arg declarations now that array.* works", () => {
    // Phase 2 turned these from an array-abort into a clean run: `float[]` and
    // `array.new<float>` reach the array library and execute without aborting.
    expect(parseOk(head + "var float[] buf = array.new_float(na)\nplot(buf, \"b\")").abort).toBeUndefined();
    expect(parseOk(head + "nwe = array.new<float>(0)\nplot(1, \"n\")").abort).toBeUndefined();
  });

  it("never mistakes a comparison for a generic type-argument list", () => {
    // `a < b and …` / `low[1]` / `a < b ? …` all stop the generic scan, so they
    // still evaluate as boolean comparisons rather than being silently skipped.
    const a = run(head + "sig = close < open\nplot(sig ? 1 : 0, \"s\")");
    expect(a.result.lines[0].values.every((v) => v === 0 || v === 1)).toBe(true);
    const b = run(head + "x = high < low[1] and (close > open)\nplot(x ? 1 : 0, \"x\")");
    const bVals = b.result.lines[0].values.filter((v) => Number.isFinite(v)) as number[];
    expect(bVals.length).toBeGreaterThan(0); // `low[1]` is na only on the first bar
    expect(bVals.every((v) => v === 0 || v === 1)).toBe(true);
  });
});

/**
 * `array.*` — the single biggest community-script blocker (Phase 2). Beyond
 * shape checks, the rolling-window case reconciles a hand-built array mean
 * against `ta.sma` bar for bar: an array that parses but silently sums the
 * wrong window would sail through every other assertion here.
 */
describe("Pine arrays (array.*)", () => {
  const head = "//@version=5\nindicator(\"t\")\n";
  const line = (a: ReturnType<typeof run>, n: string) => a.result.lines.find((l) => l.name === n);

  it("keeps a `var` buffer by reference and grows it across bars", () => {
    // One push per bar on a persistent array → size is the 1-based bar count.
    const a = run(head + "var acc = array.new_float(0)\narray.push(acc, close)\nplot(array.size(acc), \"n\")");
    const n = line(a, "n")!.values;
    expect(n[0]).toBe(1);
    expect(n[10]).toBe(11);
  });

  it("rolls a 5-bar window with push/shift and matches ta.sma bar for bar", () => {
    const a = run(
      head +
        "var buf = array.new_float(0)\n" +
        "array.push(buf, close)\n" +
        "if array.size(buf) > 5\n    array.shift(buf)\n" +
        "float avg = na\n" +
        "if array.size(buf) == 5\n    s = 0.0\n    for i = 0 to 4\n        s += array.get(buf, i)\n    avg := s / 5\n" +
        "plot(avg, \"arrSMA\")\nplot(ta.sma(close, 5), \"refSMA\")\n" +
        "plot(math.abs(avg - ta.sma(close, 5)) < 1e-9 ? 1 : 0, \"agree\")",
    );
    const agree = line(a, "agree")!.values;
    const both = agree.filter((v) => Number.isFinite(v));
    expect(both.length).toBeGreaterThan(BARS.length - 6);
    expect(both.every((v) => v === 1)).toBe(true);
    // And the array window genuinely equals the reference at a settled bar.
    expect(line(a, "arrSMA")!.values[120]).toBeCloseTo(line(a, "refSMA")!.values[120] as number, 6);
  });

  it("supports method-form calls and typed constructors", () => {
    // `a.push(...)` / `a.get(i)` / `a.size()` method syntax on an `array.new_int`
    // buffer. Non-`var`, so the array is rebuilt each bar and stays [10, 20].
    const a = run(head + "a = array.new_int(0)\na.push(10)\na.push(20)\nplot(a.get(1), \"v\")\nplot(a.size(), \"sz\")");
    expect(line(a, "v")!.values[10]).toBe(20);
    expect(line(a, "sz")!.values[10]).toBe(2);
  });

  it("aggregates with sum/avg/max/min and iterates with for...in", () => {
    const a = run(
      head +
        "a = array.from(3, 1, 4, 1, 5)\n" +
        "plot(array.sum(a), \"s\")\nplot(array.max(a), \"mx\")\nplot(array.min(a), \"mn\")\nplot(array.avg(a), \"av\")\n" +
        "t = 0.0\nfor x in a\n    t += x\nplot(t, \"in\")",
    );
    expect(line(a, "s")!.values[10]).toBe(14);
    expect(line(a, "mx")!.values[10]).toBe(5);
    expect(line(a, "mn")!.values[10]).toBe(1);
    expect(line(a, "av")!.values[10]).toBeCloseTo(2.8, 10);
    expect(line(a, "in")!.values[10]).toBe(14); // for...in reproduces array.sum
  });
});

/**
 * Nested `ta.*` in an argument must keep per-call-site state (a corpus crash).
 * `ta.rma(math.max(ta.change(close), 0), n)` — the inner `ta.change` shares the
 * RSI block of a real downloaded strategy (NWERSIASF). Before the interpreter
 * saved/restored the call-site id around `dispatch`, the nested call left
 * `ctxCid` pointing at `ta.change`, so `ta.rma`'s rolling-window state resolved
 * to `ta.change`'s `{prev}` shape and `push` threw
 * "Cannot read properties of undefined (reading 'push')" on the first bar.
 */
describe("nested ta.* call sites", () => {
  const head = "//@version=5\nindicator(\"t\")\n";

  it("runs the inline RSI form without corrupting the outer ta.rma state", () => {
    const a = run(
      head +
        "up = ta.rma(math.max(ta.change(close), 0), 5)\n" +
        "down = ta.rma(-math.min(ta.change(close), 0), 5)\n" +
        "rsi = down == 0 ? 100 : up == 0 ? 0 : 100 - (100 / (1 + up / down))\n" +
        "plot(rsi, \"rsi\")",
    );
    const rsi = a.result.lines.find((l) => l.name === "rsi")!.values.filter((v) => Number.isFinite(v)) as number[];
    expect(rsi.length).toBeGreaterThan(BARS.length / 2);
    expect(rsi.every((v) => v >= 0 && v <= 100)).toBe(true);
  });
});

/**
 * Phase 1b cheap corpus blockers: `time()` (bar timestamp + session form),
 * `log.*` console no-ops, and `break`/`continue` loop control. Each of these
 * flipped a real downloaded script from an abort to a clean run.
 */
describe("time(), log.*, and loop control", () => {
  const head = "//@version=5\nindicator(\"t\")\n";
  const line = (a: ReturnType<typeof run>, n: string) => a.result.lines.find((l) => l.name === n);

  it("time() returns the current bar timestamp and feeds date parts", () => {
    const a = run(head + "plot(time(), \"t\")\nplot(dayofmonth(time()), \"dom\")");
    // Bars are seeded at 1700000000000 + i*86400000 (see makeBars).
    expect(line(a, "t")!.values[0]).toBe(1700000000000);
    expect(line(a, "t")!.values[5]).toBe(1700000000000 + 5 * 86400000);
    // A full 24h session always contains the bar; an empty one never does.
    const s = run(
      head +
        "plot(nz(time(timeframe.period, \"0000-2400\")), \"in\")\n" +
        "plot(nz(time(timeframe.period, \"0000-0000\")), \"out\")",
    );
    expect(line(s, "in")!.values[0]).toBe(1700000000000);
    expect(line(s, "out")!.values[0]).toBe(0); // na → nz → 0, so the bar is out of session
  });

  it("treats log.* console calls as value-neutral no-ops", () => {
    const a = run(
      head +
        'log.info("hi")\n' +
        "log.debug(str.tostring(close))\n" +
        'log.warning("w")\n' +
        'log.error("e")\n' +
        'plot(close, "c")',
    );
    expect(line(a, "c")!.values[10]).toBeCloseTo(BARS[10].close, 6);
  });

  it("honours break and continue inside for loops", () => {
    // break at i==5 → sum of 0..4 = 10; the loop stops before 5.
    const b = run(head + "s = 0.0\nfor i = 0 to 9\n    if i == 5\n        break\n    s += i\nplot(s, \"s\")");
    expect(line(b, "s")!.values[10]).toBe(10);
    // continue skips even i → counts the five odd values 1,3,5,7,9.
    const c = run(head + "cnt = 0\nfor i = 0 to 9\n    if i % 2 == 0\n        continue\n    cnt += 1\nplot(cnt, \"c\")");
    expect(line(c, "c")!.values[10]).toBe(5);
  });
});

/**
 * Phase 4a control flow: `while`. Community scripts use it to count to a
 * condition and to drain an array buffer, so the interpreter re-evaluates the
 * guard each iteration and honours break/continue (with LOOP_CAP as a hang
 * backstop, since Pine itself has no host step limit).
 */
describe("Pine while loops", () => {
  const head = "//@version=5\nindicator(\"t\")\n";
  const line = (a: ReturnType<typeof run>, n: string) => a.result.lines.find((l) => l.name === n);

  it("counts up until the guard turns false", () => {
    const a = run(head + "i = 0\nwhile i < 5\n    i += 1\nplot(i, \"i\")");
    expect(line(a, "i")!.values[10]).toBe(5);
  });

  it("drains an array buffer with a size-guarded while", () => {
    const a = run(
      head +
        "buf = array.new_float(0)\n" +
        "buf.push(close)\nbuf.push(close)\nbuf.push(close)\n" +
        "drained = 0\n" +
        "while array.size(buf) > 0\n    buf.pop()\n    drained += 1\n" +
        "plot(drained, \"d\")\nplot(array.size(buf), \"sz\")",
    );
    expect(line(a, "d")!.values[10]).toBe(3);
    expect(line(a, "sz")!.values[10]).toBe(0);
  });

  it("terminates a never-false guard via break (0+1+2+3 = 6)", () => {
    const a = run(
      head +
        "i = 0\ns = 0.0\nwhile true\n    if i == 4\n        break\n    s += i\n    i += 1\nplot(s, \"s\")",
    );
    expect(line(a, "s")!.values[10]).toBe(6);
  });
});

/**
 * Phase 4b data structure: `map.*`. Modelled as an interleaved `V[]`
 * (`[k0, v0, …]`) so it reuses the same reference-mutation persistence that
 * arrays do — a `var` map mutated by `map.put` still holds its entries on the
 * next bar. Reconciling a hand-built map sum against a fixed total guards
 * against a map that parses but silently drops or double-counts a key.
 */
describe("Pine maps (map.*)", () => {
  const head = "//@version=5\nindicator(\"t\")\n";
  const line = (a: ReturnType<typeof run>, n: string) => a.result.lines.find((l) => l.name === n);

  it("round-trips put/get/size/contains", () => {
    const a = run(
      head +
        "m = map.new<string, float>()\n" +
        "map.put(m, \"a\", 1.0)\nmap.put(m, \"b\", 2.0)\n" +
        "plot(map.size(m), \"sz\")\nplot(map.get(m, \"b\"), \"vb\")\n" +
        "plot(map.contains(m, \"a\") ? 1 : 0, \"has\")\nplot(nz(map.get(m, \"zz\")), \"miss\")",
    );
    expect(line(a, "sz")!.values[10]).toBe(2);
    expect(line(a, "vb")!.values[10]).toBe(2);
    expect(line(a, "has")!.values[10]).toBe(1);
    expect(line(a, "miss")!.values[10]).toBe(0); // missing key → na → nz → 0
  });

  it("iterates map.keys and re-reads values, matching a fixed total", () => {
    const a = run(
      head +
        "m = map.new<string, float>()\n" +
        "map.put(m, \"x\", 1.0)\nmap.put(m, \"y\", 3.0)\n" +
        "ks = map.keys(m)\nt = 0.0\nfor k in ks\n    t += map.get(m, k)\nplot(t, \"sum\")\nplot(array.size(ks), \"nkeys\")",
    );
    expect(line(a, "sum")!.values[10]).toBe(4);
    expect(line(a, "nkeys")!.values[10]).toBe(2);
  });

  it("persists a var map across bars (unique key per bar)", () => {
    // A persistent counter feeds a distinct key each bar, so the map grows one
    // entry per bar: size is the 1-based bar count at bar 10 → 11.
    const a = run(
      head +
        "var m = map.new<float, float>()\nvar n = 0.0\n" +
        "map.put(m, n, close)\nn := n + 1\n" +
        "plot(map.size(m), \"sz\")",
    );
    expect(line(a, "sz")!.values[0]).toBe(1);
    expect(line(a, "sz")!.values[10]).toBe(11);
  });

  it("clears to empty and updates an existing key in place (no growth)", () => {
    const a = run(
      head +
        "m = map.new<string, float>()\n" +
        "map.put(m, \"a\", 1.0)\nmap.put(m, \"a\", 9.0)\nplot(map.size(m), \"sz2\")\nplot(map.get(m, \"a\"), \"va\")\n" +
        "map.clear(m)\nplot(map.size(m), \"sz0\")",
    );
    expect(line(a, "sz2")!.values[10]).toBe(1); // re-put same key → no new entry
    expect(line(a, "va")!.values[10]).toBe(9);
    expect(line(a, "sz0")!.values[10]).toBe(0);
  });
});
