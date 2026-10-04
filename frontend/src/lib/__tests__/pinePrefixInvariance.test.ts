import { describe, expect, it } from "vitest";

import { BARS_VARIANTS, loadBars, runScript, sliceBars } from "./pineOracleFixtures";

/**
 * Gate 1 — prefix invariance, the machine-checked definition of "no repainting":
 * the engine's value series on bars[:N] must equal the first N entries of the
 * series it produces on the full array, for every N we probe. NaN matches NaN
 * (a warm-up blank that turns into a number on a longer array is a repaint).
 *
 * These scripts are hand-written and independent of the oracle batches on purpose:
 * gate 1 must keep working if a reference batch is restructured, and comparing the
 * engine against itself needs no fixtures beyond the bars.
 */

const SCRIPTS: Record<string, string> = {
  sma: "//@version=5\nindicator(\"p\")\nplot(ta.sma(close, 5), title=\"sma\")",
  ema: "//@version=5\nindicator(\"p\")\nplot(ta.ema(close, 5), title=\"ema\")",
  rma: "//@version=5\nindicator(\"p\")\nplot(ta.rma(close, 5), title=\"rma\")",
  stdev: "//@version=5\nindicator(\"p\")\nplot(ta.stdev(close, 5), title=\"stdev\")",
  // The biased flag is Pine's third argument and defaults to true (population);
  // the sample branch is a separate code path and must be prefix-checked too.
  stdev_sample:
    "//@version=5\nindicator(\"p\")\nplot(ta.stdev(close, 5, false), title=\"stdev_sample\")",
  // Stateful and reversal-prone: the best repainting candidate in the batch, and
  // the one gate 2 does not cover (spec §11 R-C), so gate 1 carries it alone.
  // Explicit v5 call form: `ta.sar` bare is a Pine v3/v4 idiom this engine only
  // answers through LEGACY_SERIES, and that path is gated `ver <= 4`
  // (`pineRuntime.ts:94-100`, `:1169`), so under `//@version=5` it aborts as an
  // undefined variable. The three arguments are the engine's own defaults
  // (`pineTa.ts:716-719`), so this is the same recursion, spelled honestly.
  sar: "//@version=5\nindicator(\"p\")\nplot(ta.sar(0.02, 0.02, 0.2), title=\"sar\")",
};

/** Compare two series with NaN-equals-NaN; report the worst relative divergence. */
function comparePrefix(
  prefix: number[],
  reference: number[],
): { checked: number; maxRelDiff: number; mismatch: string | null } {
  let checked = 0;
  let maxRelDiff = 0;
  for (let i = 0; i < prefix.length; i += 1) {
    const x = prefix[i];
    const y = reference[i];
    checked += 1;
    if (Number.isNaN(x) && Number.isNaN(y)) continue;
    if (Number.isNaN(x) !== Number.isNaN(y)) {
      return { checked, maxRelDiff, mismatch: `index ${i}: na-vs-value ${x} / ${y}` };
    }
    const scale = Math.max(Math.abs(y), 1e-9);
    const diff = Math.abs(x - y) / scale;
    if (diff > maxRelDiff) maxRelDiff = diff;
  }
  return { checked, maxRelDiff, mismatch: null };
}

describe("prefix invariance (no-lookahead gate)", () => {
  /** How many lines each script must plot. A dropped or renamed `title=` would
   * otherwise shrink the comparison set silently and the gate would still be green. */
  const LINE_COUNT: Record<string, number> = { sma: 1, ema: 1, rma: 1, stdev: 1, stdev_sample: 1, sar: 1 };

  for (const variant of BARS_VARIANTS) {
    const full = loadBars(variant);
    const L = full.close.length;
    for (const [name, src] of Object.entries(SCRIPTS)) {
      it(`${name} on ${variant}: no plotted value moves when bars are appended`, () => {
        const reference = runScript(src, full);
        const lineNames = Object.keys(reference);
        expect(lineNames.length, `${name} plotted lines`).toBe(LINE_COUNT[name]);
        // Every line of the script, not just the first: a multi-output script
        // (supertrend's band + direction, macd's triple) repaints per output.
        for (const lineName of lineNames) {
          let probes = 0;
          let worst = 0;
          for (let n = 16; n < L; n += 8) {
            const prefix = runScript(src, sliceBars(full, n));
            const { mismatch, maxRelDiff } = comparePrefix(
              prefix[lineName],
              reference[lineName].slice(0, n),
            );
            expect(mismatch, `${lineName} N=${n}`).toBeNull();
            worst = Math.max(worst, maxRelDiff);
            probes += 1;
          }
          // A gate that probed nothing would pass: pin the probe count to the bar
          // count so shortening the fixture cannot silently hollow the test out.
          expect(probes, `${lineName} probes`).toBe(Math.ceil((L - 16) / 8));
          // Exact, not "within a tolerance": a causal recursion replays the same
          // operations in the same order, so any movement is a repaint, not noise.
          expect(worst, `${lineName} worst`).toBe(0);
        }
      });
    }
  }

  it("the fixtures are the length the gate's probe math assumes", () => {
    for (const variant of BARS_VARIANTS) {
      const L = loadBars(variant).close.length;
      expect(L, variant).toBe(variant === "bars_intraday_vwap" ? 40 : 120);
    }
  });
});

describe("a Pine source in this engine cannot address a future bar", () => {
  /**
   * TradingView's idiom for "the next bar" is a NEGATIVE history offset, `close[-1]`.
   * The engine makes that impossible in two places, and both are load-bearing for
   * every claim gate 1 makes: `readIdx` floors the offset with
   * `Math.max(0, Math.trunc(k))` (`pineRuntime.ts:957`), and `readBack` answers any
   * `k <= 0` with the CURRENT bar (`pineRuntime.ts:429`). So `close[-1]` reads the
   * same value as `close`, never bar+1.
   *
   * This is pinned because no other `pine*.test.ts` exercises a negative offset at
   * all (checked by grep on 2026-10-04 across the pine suites), and the `indicatorLang`
   * suite that does test `close[-1]` is a DIFFERENT evaluator — it asserts NaN there,
   * which is not this runtime's behaviour. An unpinned floor is a floor someone can
   * "tidy away" in an unrelated refactor, and gate 1 would then be guarding nothing.
   */
  it("close[-1] is the current bar, not the bar after it", () => {
    const bars = loadBars("bars_daily_trend");
    const head = "//@version=5\nindicator(\"p\")\n";
    const fwd = runScript(head + 'plot(ta.sma(close[-1], 5), title="f")', bars).f;
    const cur = runScript(head + 'plot(ta.sma(close, 5), title="c")', bars).c;
    const { checked, mismatch } = comparePrefix(fwd, cur);
    expect(checked).toBe(bars.close.length);
    expect(mismatch, `close[-1] diverged from close: ${mismatch}`).toBeNull();
  });
});
