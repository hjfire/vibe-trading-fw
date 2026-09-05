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
