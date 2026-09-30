import { describe, expect, it, vi } from "vitest";

/**
 * Phase 5b MTF -> strategy backtest (Track B1).
 *
 * The Pine engine runs a full order simulator (`PineReport.equity` / `.trades`)
 * on the *same* bars the script is evaluated against, and `request.security`
 * resamples those bars in place. So multi-timeframe should not be a drawing
 * flourish — an HTF gate or a lower-timeframe count has to actually change
 * which trades fire. These cases pin exactly that: same base signal, then the
 * same signal wrapped in an MTF condition, and the report must move.
 *
 * `security_lower_tf` is fed through the `lowerBars` option, the same channel
 * the browser producer fills; leaving it unfed must degrade honestly (the array
 * reads size 0, the gate never opens, no trades) rather than crash or fabricate.
 */
vi.mock("klinecharts", () => ({ registerIndicator: vi.fn() }));

import { compilePine, type PineArtifact } from "../pineScript";
import { toBars } from "../pineTypes";
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

function report(code: string, opts?: { lowerBars?: ReturnType<typeof toBars> }): PineArtifact {
  const out = compilePine(code, BARS, opts ?? {});
  if ("error" in out) throw new Error(`编译失败：${out.error}`);
  if (out.abort) throw new Error(`中断：${out.abort}`);
  return out;
}

const BASE = [
  '//@version=5',
  'strategy("base", overlay=true)',
  'fast = ta.sma(close, 5)',
  'longOk = close > fast',
  'if longOk',
  '    strategy.entry("L", strategy.long)',
  'if not longOk',
  '    strategy.close("L")',
].join("\n");

const HTF_GATED = [
  '//@version=5',
  'strategy("htf", overlay=true)',
  'fast = ta.sma(close, 5)',
  // Weekly trend confirmation: resample the daily chart up to weekly in place.
  'htfClose = request.security(syminfo.tickerid, "W", close)',
  'htfSma = request.security(syminfo.tickerid, "W", ta.sma(close, 3))',
  'longOk = close > fast and htfClose > htfSma',
  'if longOk',
  '    strategy.entry("L", strategy.long)',
  'if not longOk',
  '    strategy.close("L")',
].join("\n");

describe("request.security (HTF) drives the strategy simulator", () => {
  it("the base signal trades at all", () => {
    const rep = report(BASE).result.report;
    expect(rep).toBeTruthy();
    expect(rep!.trades.length).toBeGreaterThan(0);
  });

  it("an HTF gate changes which trades fire (not decorative)", () => {
    const baseRep = report(BASE).result.report!;
    const htfRep = report(HTF_GATED).result.report!;
    // The confirmation blocks entries, so strictly fewer round-trips survive.
    expect(htfRep.trades.length).toBeLessThan(baseRep.trades.length);
    // And the realised outcome is different bar-for-bar, proving the HTF value
    // actually reached the order logic rather than just being plotted.
    expect(htfRep.netPnl).not.toBeCloseTo(baseRep.netPnl, 6);
    expect(htfRep.equity.length).toBe(baseRep.equity.length);
  });
});

const LTF_GATED = [
  '//@version=5',
  'strategy("ltf", overlay=true)',
  'sub = request.security_lower_tf(syminfo.tickerid, "1", close)',
  'fast = ta.sma(close, 5)',
  // Only open when there are real sub-bars to count (>= 3 inside each day).
  'longOk = close > fast and array.size(sub) >= 3',
  'if longOk',
  '    strategy.entry("L", strategy.long)',
  'if not longOk',
  '    strategy.close("L")',
].join("\n");

describe("request.security_lower_tf feeds the strategy simulator via lowerBars", () => {
  it("degrades to no trades when the sub-bar channel is unfed", () => {
    const rep = report(LTF_GATED).result.report!;
    // array.size(sub) is 0 everywhere, so the gate never opens — honest blank,
    // not a crash and not a fabricated fill.
    expect(rep.trades.length).toBe(0);
  });

  it("opens the gate once real sub-bars are injected, matching the base signal", () => {
    // Three one-minute sub-bars live inside every daily chart bar.
    const lowerBars = toBars(
      BARS.flatMap((b) => [
        { ...b, timestamp: b.timestamp } as KLineData,
        { ...b, timestamp: b.timestamp + 60_000 } as KLineData,
        { ...b, timestamp: b.timestamp + 120_000 } as KLineData,
      ]),
    );
    const rep = report(LTF_GATED, { lowerBars }).result.report!;
    // With sub-bars present the `>= 3` guard holds, so the strategy behaves
    // exactly like the ungated base: same trade count and realised P&L.
    expect(rep.trades.length).toBeGreaterThan(0);
    const baseRep = report(BASE).result.report!;
    expect(rep.trades.length).toBe(baseRep.trades.length);
    expect(rep.netPnl).toBeCloseTo(baseRep.netPnl, 6);
  });
});
