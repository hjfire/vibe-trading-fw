import { describe, expect, it, vi } from "vitest";

/**
 * Track B2a — the headless signal export contract.
 *
 * The production backtest never runs Pine; it reads the artifact these
 * functions emit. So this file pins what the artifact *is*: a per-bar held
 * direction (`+1/-1/0`) index-aligned with the bar timestamps, labelled with
 * the interval + wall-clock zone the backend needs to rebuild its own index,
 * and honestly empty (an error, not a zero-filled file) when the script is not
 * a strategy. Multi-timeframe must survive the trip: a script that consumed
 * `request.security_lower_tf` records `lowerTfMs` in the meta, and an HTF gate
 * has to change the emitted series, not just the drawing.
 *
 * Pure functions over `compilePine` — no chart, no network — so the same code
 * path a headless Node producer will run is the one under test here.
 */
vi.mock("klinecharts", () => ({ registerIndicator: vi.fn() }));

import { compilePine } from "../pineScript";
import { toBars } from "../pineTypes";
import {
  PINE_SIGNAL_SCHEMA,
  buildPineSignal,
  signalsFromArtifact,
  type PineSignalArtifact,
} from "../pineSignal";
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
      timestamp: 1700000000000 + i * 86_400_000,
      open,
      high: Math.max(open, close) * 1.01,
      low: Math.min(open, close) * 0.99,
      close,
      volume: 1000,
      turnover: 0,
    } as KLineData;
  });
}

const BARS = makeBars(300);

const LONG_FLAT = [
  '//@version=5',
  'strategy("longflat", overlay=true)',
  'fast = ta.sma(close, 5)',
  'longOk = close > fast',
  'if longOk',
  '    strategy.entry("L", strategy.long)',
  'if not longOk',
  '    strategy.close("L")',
].join("\n");

const LONG_SHORT = [
  '//@version=5',
  'strategy("longshort", overlay=true)',
  'fast = ta.sma(close, 5)',
  'if close > fast',
  '    strategy.entry("L", strategy.long)',
  'if close < fast',
  '    strategy.entry("S", strategy.short)',
].join("\n");

const INDICATOR = ['//@version=5', 'indicator("notastrategy")', 'plot(close)'].join("\n");

const HTF_GATED = [
  '//@version=5',
  'strategy("htf", overlay=true)',
  'fast = ta.sma(close, 5)',
  'htfClose = request.security(syminfo.tickerid, "W", close)',
  'htfSma = request.security(syminfo.tickerid, "W", ta.sma(close, 3))',
  'longOk = close > fast and htfClose > htfSma',
  'if longOk',
  '    strategy.entry("L", strategy.long)',
  'if not longOk',
  '    strategy.close("L")',
].join("\n");

const LTF_GATED = [
  '//@version=5',
  'strategy("ltf", overlay=true)',
  'sub = request.security_lower_tf(syminfo.tickerid, "1", close)',
  'fast = ta.sma(close, 5)',
  'longOk = close > fast and array.size(sub) >= 3',
  'if longOk',
  '    strategy.entry("L", strategy.long)',
  'if not longOk',
  '    strategy.close("L")',
].join("\n");

type LowerBars = ReturnType<typeof toBars>;

interface ExportOpts {
  lowerBars?: LowerBars;
  symbol?: string;
  interval?: string;
  wallClockZone?: string | null;
}

function exportSignal(code: string, opts: ExportOpts = {}): PineSignalArtifact {
  const out = buildPineSignal(code, BARS, {
    symbol: opts.symbol ?? "700.HK",
    interval: opts.interval ?? "1D",
    wallClockZone: opts.wallClockZone ?? null,
    lowerBars: opts.lowerBars,
  });
  if ("error" in out) throw new Error(`导出失败：${out.error}`);
  return out.signal;
}

describe("Pine strategy -> signal artifact (B2a)", () => {
  it("exports the held direction, index-aligned with the bar timestamps", () => {
    const sig = exportSignal(LONG_FLAT);
    expect(sig.schema).toBe(PINE_SIGNAL_SCHEMA);
    expect(sig.engine).toBe("pine-ts");
    expect(sig.symbol).toBe("700.HK");
    expect(sig.interval).toBe("1D");
    // One signal per bar walked, every value a clean -1/0/+1 direction.
    expect(sig.signals.length).toBe(sig.timestamps.length);
    expect(sig.signals.length).toBeGreaterThan(0);
    for (const s of sig.signals) expect([-1, 0, 1]).toContain(s);
    // Timestamps are the chart's own epoch-ms, in order.
    expect(sig.timestamps[0]).toBe(BARS[0].timestamp);
    for (let i = 1; i < sig.timestamps.length; i++) {
      expect(sig.timestamps[i]).toBe(BARS[i].timestamp);
    }
    // A long/flat strategy goes long somewhere but never shorts.
    expect(sig.signals).toContain(1);
    expect(sig.signals).not.toContain(-1);
  });

  it("the exported series is exactly the engine's per-bar held positions", () => {
    // Serialization must be a faithful copy of `PineReport.positions`, not a
    // re-derivation — the backend contract depends on that identity.
    const compiled = compilePine(LONG_FLAT, BARS, {});
    if ("error" in compiled || !compiled.result.report) throw new Error("compile failed");
    const sig = signalsFromArtifact(compiled, BARS, { symbol: "700.HK", interval: "1D" });
    if ("error" in sig) throw new Error("export failed");
    expect(sig.signals).toEqual(compiled.result.report.positions);
  });

  it("a long/short book carries both directions", () => {
    const sig = exportSignal(LONG_SHORT);
    expect(sig.signals).toContain(1);
    expect(sig.signals).toContain(-1);
  });

  it("refuses to export a non-strategy script instead of writing an empty file", () => {
    const out = buildPineSignal(INDICATOR, BARS, { symbol: "700.HK", interval: "1D" });
    expect("error" in out).toBe(true);
    if ("error" in out) expect(out.error).toMatch(/strategy/);
  });

  it("carries the intraday wall-clock zone so the backend can rebuild its index", () => {
    const sig = exportSignal(LONG_FLAT, { interval: "1m", wallClockZone: "Asia/Shanghai" });
    expect(sig.interval).toBe("1m");
    expect(sig.wallClockZone).toBe("Asia/Shanghai");
  });

  it("an HTF gate changes the emitted series, so MTF is not decorative", () => {
    const base = exportSignal(LONG_FLAT).signals;
    const htf = exportSignal(HTF_GATED).signals;
    expect(htf).not.toEqual(base);
  });

  it("records lowerTfMs and degrades honestly when sub-bars are unfed", () => {
    const unfed = exportSignal(LTF_GATED);
    // No lowerBars: the `>= 3` gate never opens, so the whole book stays flat.
    expect(unfed.meta.lowerTfMs).toEqual([60_000]);
    expect(unfed.signals.every((s) => s === 0)).toBe(true);

    // Feed three 1-minute sub-bars inside every daily bar and the gate opens.
    const lowerBars = toBars(
      BARS.flatMap((b) => [
        { ...b, timestamp: b.timestamp } as KLineData,
        { ...b, timestamp: b.timestamp + 60_000 } as KLineData,
        { ...b, timestamp: b.timestamp + 120_000 } as KLineData,
      ]),
    );
    const fed = exportSignal(LTF_GATED, { lowerBars });
    expect(fed.signals).toContain(1);
  });
});
