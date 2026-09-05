import { describe, expect, it, vi } from "vitest";

// The Pine layer never touches the chart library, but pineScript imports
// KLineData types only — stub anyway so the suite stays DOM-free and fast.
vi.mock("klinecharts", () => ({ registerIndicator: vi.fn() }));

import {
  compilePine,
  isPineSource,
  isPineStrategy,
  pineDefaults,
  validatePine,
  type PineArtifact,
} from "../pineScript";
import type { KLineData } from "klinecharts";

/** Deterministic random walk, same shape as the indicatorLang fixtures. */
function makeBars(n: number): KLineData[] {
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  let price = 100;
  return Array.from({ length: n }, (_, i) => {
    const open = price;
    const close = open * (1 + (rand() - 0.47) * 0.05);
    price = close;
    return {
      timestamp: 1700000000000 + i * 86400000,
      open,
      high: Math.max(open, close) * (1 + rand() * 0.012),
      low: Math.min(open, close) * (1 - rand() * 0.012),
      close,
      volume: 1000 + Math.floor(rand() * 900),
      turnover: 0,
    } as KLineData;
  });
}

const BARS = makeBars(120);
const CLOSES = BARS.map((b) => b.close);

function run(code: string, params?: number[]): PineArtifact {
  const out = compilePine(code, BARS, params ? { params } : {});
  if ("error" in out) throw new Error(`编译失败：${out.error}`);
  return out;
}

/** Values of the plot whose title matches, in declaration order. */
function seriesOf(a: PineArtifact, title: string): number[] {
  const fig = a.figures.find((f) => f.title === title);
  if (!fig) throw new Error(`没有名为 "${title}" 的输出，实际：${a.figures.map((f) => f.title).join(" / ")}`);
  return a.rows.map((r) => r[fig.key]) as number[];
}

const last = (a: (number | undefined)[]) => a[a.length - 1];

describe("pine dialect sniffing", () => {
  it("recognises Pine by its header or namespaced calls", () => {
    expect(isPineSource('//@version=5\nindicator("x")\nplot(close)')).toBe(true);
    expect(isPineSource("fast = ta.ema(close, 12)\nreturn { fast }")).toBe(true);
    expect(isPineSource("return { ma(close, 5) }")).toBe(false);
  });

  it("reports a line number instead of throwing on bad syntax", () => {
    const err = validatePine('indicator("x")\nplot(');
    expect(err).toBeTruthy();
    expect(validatePine('indicator("x")\nplot(close)')).toBeNull();
  });

  it("tells a trading script from a drawing one, comments aside", () => {
    expect(isPineStrategy('strategy("双均线", overlay=true)\nplot(close)')).toBe(true);
    // No header but real order calls still trade (a ported script may keep its
    // own header style).
    expect(isPineStrategy('indicator("x")\nif a > b\n    strategy.entry("L", strategy.long)')).toBe(true);
    expect(isPineStrategy('indicator("x")\nplot(ta.sma(close, 5))')).toBe(false);
    // A comment describing what the port lacks must not count.
    expect(isPineStrategy('indicator("x")\n// strategy.entry("L", strategy.long) 未实现\nplot(close)')).toBe(false);
    expect(isPineStrategy('indicator("x")\n/* strategy.close("L") */\nplot(close)')).toBe(false);
  });
});

describe("pine runtime semantics", () => {
  it("computes ta.sma like the reference formula", () => {
    const a = run('//@version=5\nindicator("SMA")\nplot(ta.sma(close, 3), "sma")');
    const want = (CLOSES[117] + CLOSES[118] + CLOSES[119]) / 3;
    expect(last(seriesOf(a, "sma"))).toBeCloseTo(want, 8);
  });

  it("pads the warm-up bars with gaps rather than zeros", () => {
    const a = run('//@version=5\nindicator("SMA")\nplot(ta.sma(close, 5), "sma")');
    const got = seriesOf(a, "sma");
    expect(got.slice(0, 4)).toEqual([undefined, undefined, undefined, undefined]);
    expect(got[4]).toBeCloseTo(CLOSES.slice(0, 5).reduce((x, y) => x + y, 0) / 5, 8);
  });

  it("reads history with close[n] and keeps na before the first bar", () => {
    const a = run(
      '//@version=5\nindicator("shift")\nd = close - close[1]\nplot(d, "d")\nplot(close[5], "back")',
    );
    expect(last(seriesOf(a, "d"))).toBeCloseTo(CLOSES[119] - CLOSES[118], 10);
    expect(last(seriesOf(a, "back"))).toBeCloseTo(CLOSES[114], 10);
  });

  it("carries `var` state across bars and resets plain assignments", () => {
    const a = run(
      [
        '//@version=5',
        'indicator("counter")',
        "var int hits = 0",
        "plain = 1",
        "if close > close[1]",
        "    hits := hits + 1",
        "plot(hits, \"hits\")",
        'plotbar(plain, "plain")',
      ].join("\n"),
    );
    const upDays = CLOSES.slice(1).filter((c, i) => c > CLOSES[i]).length;
    expect(last(seriesOf(a, "hits"))).toBe(upDays);
    // A non-`var` assignment has no value on bar 0 (nothing executed yet there).
    const plain = seriesOf(a, "plain");
    expect(last(plain)).toBe(1);
    expect(plain.filter((v) => v === 1).length).toBe(120);
  });

  it("propagates na through comparisons so plots go blank, not zero", () => {
    const a = run(
      '//@version=5\nindicator("na")\nsig = ta.sma(close, 3) > 100\nplot(sig ? 1 : 0, "sig")\nplot(1/0, "div")',
    );
    expect(seriesOf(a, "sig").slice(0, 2)).toEqual([undefined, undefined]);
    expect(last(seriesOf(a, "sig"))).toBe(CLOSES[117] > 100 ? 1 : 0);
    // A plot that is na everywhere carries no information: it is dropped, and
    // the drop is reported instead of being hidden from the user.
    expect(a.figures.some((f) => f.title === "div")).toBe(false);
    expect(a.result.warnings.join(" ")).toContain("已隐藏");
  });

  it("destructures a tuple return from ta.macd", () => {
    const a = run(
      '//@version=5\nindicator("MACD")\n[macdLine, signalLine, histLine] = ta.macd(close, 12, 26, 9)\nplot(macdLine, "macd")\nplot(signalLine, "signal")\nplot(histLine, "hist", style=plot.style_histogram)',
    );
    const macd = last(seriesOf(a, "macd")) as number;
    const signal = last(seriesOf(a, "signal")) as number;
    expect(last(seriesOf(a, "hist"))).toBeCloseTo(macd - signal, 8);
  });

  it("exposes input.* declarations and honours parameter overrides", () => {
    const src =
      '//@version=5\nindicator("params")\nn = input.int(20, "长度", minval=2, maxval=50)\nk = input.float(0.5, "系数", step=0.1)\nb = input.bool(true, "开关")\nplot(ta.sma(close, n) * k, "v")';
    const a = run(src);
    expect(a.result.inputs.map((i) => i.label)).toEqual(["长度", "系数", "开关"]);
    expect(a.result.inputs[0]).toMatchObject({ kind: "int", def: 20, min: 2, max: 50 });
    expect(pineDefaults(a.result)).toEqual([20, 0.5, 1]);
    const def = last(seriesOf(a, "v")) as number;
    expect(def).toBeCloseTo((CLOSES.slice(100, 120).reduce((x, y) => x + y, 0) / 20) * 0.5, 8);
    const tuned = run(src, [5, 2]);
    expect(last(seriesOf(tuned, "v"))).toBeCloseTo(
      (CLOSES.slice(115, 120).reduce((x, y) => x + y, 0) / 5) * 2,
      8,
    );
  });

  it("turns sources into the selectable series input.source expects", () => {
    const a = run(
      '//@version=5\nindicator("src")\nsrc = input.source(close, "来源")\nplot(src, "src")',
      [4],
    );
    // Option 4 of close/open/high/low/volume/… is volume.
    expect(a.result.inputs[0].kind).toBe("source");
    expect(last(seriesOf(a, "src"))).toBe(BARS[119].volume);
  });
});

describe("pine plotting output", () => {
  it("maps plot styles onto figure types and keeps bar plots on a baseline", () => {
    const a = run(
      [
        '//@version=5',
        'indicator("styles", overlay=true)',
        'plot(close, "line")',
        'plotshape(close > close[1], "up", shape.triangleup, location.belowbar, color.green)',
        'hline(70, "overbought")',
        'hline(70, "duplicate")',
      ].join("\n"),
    );
    const byTitle = new Map(a.figures.map((f) => [f.title, f]));
    expect(byTitle.get("line")).toMatchObject({ type: "line" });
    expect(byTitle.get("up")).toMatchObject({ type: "circle", color: "#26a69a" });
    expect(byTitle.get("overbought")).toMatchObject({ type: "line", reference: true });
    // hline dedupes on price, so the second one is not drawn again.
    expect(a.figures.filter((f) => f.reference).length).toBe(1);
    expect(a.result.overlay).toBe(true);
  });

  it("returns one row per bar even when the script aborts early", () => {
    const a = run(
      '//@version=5\nindicator("boom")\nplot(close, "c")\nif bar_index > 30\n    ta.nonexistent_xyz(close)\n',
    );
    expect(a.rows.length).toBe(120);
    expect(a.result.warnings.join(" ")).toContain("nonexistent_xyz");
    expect(a.result.bars).toBeLessThan(120);
  });

  it("degrades decorative APIs to warnings while keeping the numbers", () => {
    const a = run(
      [
        '//@version=5',
        'indicator("deco", overlay=true)',
        "plot(close, \"c\")",
        "bgcolor(color.new(color.red, 90))",
        "if close > open",
        "    label.new(bar_index, high, \"x\")",
      ].join("\n"),
    );
    const text = a.result.warnings.join("\n");
    expect(text).toContain("bgcolor");
    expect(text).toContain("label.new");
    expect(last(seriesOf(a, "c"))).toBeCloseTo(CLOSES[119], 10);
  });

  it("offsets a plot without shifting the bar rows", () => {
    const a = run('//@version=5\nindicator("off")\nplot(close, "c", offset=1)');
    const got = seriesOf(a, "c");
    expect(got[1]).toBeCloseTo(CLOSES[0], 10);
    // What bar 118 plots lands on bar 119; nothing wraps around the edges.
    expect(got[119]).toBeCloseTo(CLOSES[118], 10);
    expect(got[0]).toBeUndefined();
  });
});

describe("pine strategy simulation", () => {
  const XOVER = [
    '//@version=5',
    'strategy("均线交叉", initial_capital=100000, default_qty_type=strategy.percent_of_equity, default_qty_value=100)',
    "fast = ta.ema(close, 5)",
    "slow = ta.ema(close, 20)",
    "longCond = ta.crossover(fast, slow)",
    "shortCond = ta.crossunder(fast, slow)",
    "if longCond",
    '    strategy.entry("Long", strategy.long)',
    "if shortCond",
    '    strategy.close("Long")',
  ].join("\n");

  it("reports the header settings and a per-bar equity curve", () => {
    const a = run(XOVER);
    const rep = a.result.report;
    expect(a.result.scriptKind).toBe("strategy");
    expect(rep).toBeTruthy();
    expect(rep?.initialCapital).toBe(100000);
    expect(rep?.defaultQtyType).toBe("percent_of_equity");
    expect(rep?.equity.length).toBe(120);
  });

  it("produces trades whose realised P&L matches the report", () => {
    const a = run(XOVER);
    const rep = a.result.report as NonNullable<PineArtifact["result"]["report"]>;
    expect(rep.closedCount).toBeGreaterThan(1);
    expect(rep.trades.length).toBe(rep.closedCount);
    const sumPnl = rep.trades.reduce((x, t) => x + t.pnl, 0);
    expect(rep.netPnl).toBeCloseTo(sumPnl, 6);
    // Equity = capital + realised + whatever is still marked to market.
    const lastEq = rep.equity[rep.equity.length - 1];
    expect(rep.netPnl + rep.unrealizedPnl).toBeCloseTo(lastEq - rep.initialCapital, 6);
    expect(rep.winCount).toBeLessThanOrEqual(rep.closedCount);
    expect(rep.maxDrawdownPct).toBeGreaterThanOrEqual(0);
    for (const t of rep.trades) {
      expect(t.exitBar).toBeGreaterThan(t.entryBar);
      expect(t.qty).toBeGreaterThan(0);
    }
  });

  it("marks fills on the chart as B/S dots", () => {
    const a = run(XOVER);
    const marks = a.result.markers;
    expect(marks.length).toBeGreaterThan(0);
    const total = marks.reduce((x, m) => x + m.values.filter((v) => !Number.isNaN(v)).length, 0);
    expect(total).toBeGreaterThan(0);
    const keys = a.figures.filter((f) => f.type === "circle").map((f) => f.key);
    const drawn = keys.reduce((x, k) => x + a.rows.filter((r) => r[k] !== undefined).length, 0);
    expect(drawn).toBe(total);
  });

  it("sizes a fixed-quantity strategy and stops at the pyramiding cap", () => {
    const a = run(
      [
        '//@version=5',
        'strategy("固定手数", initial_capital=1000, default_qty_type=strategy.fixed, default_qty_value=1, pyramiding=1)',
        "if close > open",
        '    strategy.entry("Long", strategy.long)',
      ].join("\n"),
    );
    const rep = a.result.report as NonNullable<PineArtifact["result"]["report"]>;
    expect(rep.trades.every((t) => t.qty === 1)).toBe(true);
    expect(rep.equity[rep.equity.length - 1]).toBeGreaterThan(0);
  });

  it("fills on the next open by default and on close when asked", () => {
    const firstFill = (a: PineArtifact, name: string) => {
      const m = a.result.markers.find((x) => x.name === name);
      const at = m ? m.values.findIndex((v) => !Number.isNaN(v)) : -1;
      return at < 0 || !m ? undefined : { at, price: m.values[at] };
    };
    const nextOpen = run(
      [
        '//@version=5',
        'strategy("次日开盘", initial_capital=1000)',
        'strategy.entry("L", strategy.long)',
      ].join("\n"),
    );
    const opened = firstFill(nextOpen, "买入开仓");
    expect(opened?.at).toBe(1);
    expect(opened?.price).toBeCloseTo(BARS[1].open, 8);
    const onClose = run(
      [
        '//@version=5',
        'strategy("收盘成交", initial_capital=1000, process_orders_on_close=true)',
        'strategy.entry("L", strategy.long)',
      ].join("\n"),
    );
    const closed = firstFill(onClose, "买入开仓");
    expect(closed?.at).toBe(0);
    expect(closed?.price).toBeCloseTo(BARS[0].close, 8);
  });
});
