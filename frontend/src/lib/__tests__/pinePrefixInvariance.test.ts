import { describe, expect, it } from "vitest";

import { BARS_VARIANTS, loadBars, runScript, sliceBars } from "./pineOracleFixtures";

/**
 * Gate 1 — prefix invariance, the machine-checked definition of "no repainting":
 * the engine's value series on bars[:N] must equal the first N entries of the
 * series it produces on the full array, for every N we probe. NaN matches NaN
 * (a warm-up blank that turns into a number on a longer array is a repaint).
 *
 * Two things beyond the comparison itself keep that sentence honest: a prefix run
 * must return EXACTLY N values (I-2 — a longer one was leaking past the comparator),
 * and the compared line must actually carry values (I-1 — an all-`na` line matches
 * itself forever, so the warm-up blanks are pinned to an exact count).
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
  // Both outputs of one Pine call: the band AND the sign. A repainting sign flip is
  // the failure mode the oracle cannot see (the reference carries the same convention).
  supertrend:
    "//@version=5\nindicator(\"p\")\n[band, dir] = ta.supertrend(3.0, 10)\nplot(band, title=\"supertrend\")\nplot(dir, title=\"st_direction\")",
  // The cumulative branch: appending bars must extend the running sums, not rebase them.
  // `hlc3` is spelled out because a bare `ta.vwap` never reaches the ta.* dispatcher
  // (that branch is on the CALL path, `pineRuntime.ts:1537-1541`); the engine's own
  // default source for an argument-less call is hlc3 (`pineTa.ts:963`), so this is the
  // same series the oracle batch plots, written where this runtime can actually read it.
  vwap: "//@version=5\nindicator(\"p\")\nplot(ta.vwap(hlc3), title=\"vwap\")",
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
  /** Which lines each script must plot, by NAME (sorted for the comparison).
   * Names, not a count (M-4): an untitled or renamed `plot()` is still exactly ONE
   * line, so `lineNames.length === 1` stays green while the series actually being
   * compared changes identity — this pin is what makes "逐 line 比对" mean a fixed
   * set of series. It mirrors gate 2's alignment against `manifest.lines`. Adding a
   * plot must therefore be a deliberate edit here, never an accident in a script. */
  const EXPECTED_LINES: Record<string, string[]> = {
    sma: ["sma"],
    ema: ["ema"],
    rma: ["rma"],
    stdev: ["stdev"],
    stdev_sample: ["stdev_sample"],
    sar: ["sar"],
    supertrend: ["st_direction", "supertrend"],
    vwap: ["vwap"],
  };

  /** How many `na` entries each script's full-series line carries, exactly — the
   * warm-up blanks of a length-5 sma/rma/stdev (4 bars), against ema and sar, which
   * this engine answers from bar 0 (0 blanks), supertrend's two lines (9 blanks each:
   * its ATR is `rma(tr, 10)`, which this engine seeds at index 9 — `pineTa.ts:683`,
   * and BOTH outputs stay na through that warm-up because it returns `[NA, NA]` at
   * `:694` before the bands are stored), and vwap (0 blanks, the running pv/v ratio
   * exists from bar 0 on these fixtures, whose volumes are all positive — `:969`'s
   * `st.v === 0 ? NA` branch is never taken here). These are measured readings; the
   * evidence that they can go red is in `task-3-report.md`, 「Fix round 1」.
   *
   * The warm-up count is THIS ENGINE's rule, stated as a fixture fact, not as Pine
   * semantics: what Pine itself does across an na boundary (carry, poison or reseed)
   * is still an open external-anchor question (`EXTERNAL_ANCHORS.md`).
   *
   * This is the strict form of "a compared line must have something to compare"
   * (I-1): NaN matches NaN, so a line whose values are blank compares equal to
   * itself forever, and every other pin in this gate — names, probes, `worst`, the
   * fixture length — stays green on it. The floor below states that defect in its
   * own words; the exact count above also catches a bar set quietly losing data. */
  const EXPECTED_NA: Record<string, number> = {
    sma: 4,
    ema: 0,
    rma: 4,
    stdev: 4,
    stdev_sample: 4,
    sar: 0,
    supertrend: 9,
    vwap: 0,
  };

  function naCount(values: number[]): number {
    return values.filter((v) => Number.isNaN(v)).length;
  }

  for (const variant of BARS_VARIANTS) {
    const full = loadBars(variant);
    const L = full.close.length;
    for (const [name, src] of Object.entries(SCRIPTS)) {
      it(`${name} on ${variant}: no plotted value moves when bars are appended`, () => {
        const reference = runScript(src, full);
        const lineNames = Object.keys(reference).sort();
        expect(lineNames, `${name} plotted lines`).toEqual(EXPECTED_LINES[name]);
        // Every line of the script, not just the first: a multi-output script
        // (supertrend's band + direction, macd's triple) repaints per output.
        for (const lineName of lineNames) {
          expect(reference[lineName].length, `${lineName} full-series length`).toBe(L);
          expect(naCount(reference[lineName]), `${lineName} full-series na`).toBe(
            EXPECTED_NA[name],
          );
          expect(
            reference[lineName].length - naCount(reference[lineName]),
            `${lineName} comparable points on the full series`,
          ).toBeGreaterThan(0);
          let probes = 0;
          let worst = 0;
          for (let n = 16; n < L; n += 8) {
            const prefix = runScript(src, sliceBars(full, n));
            // A prefix run must return EXACTLY n values (I-2). `comparePrefix` walks
            // `prefix.length`, and past `n` the reference entry is `undefined`:
            // `Number.isNaN(undefined)` is false, so the na-vs-value branch is
            // skipped, `scale` is NaN, `diff` is NaN and `NaN > maxRelDiff` is
            // false — an over-length tail used to be dropped in silence, which is
            // precisely the shape of a look-ahead leak. The under-length direction
            // already throws (`runScript` + `pineScript.ts:185-188`), so this was the
            // one unguarded half. `?.` keeps a line dropped by the prefix run an
            // assertion rather than a TypeError.
            expect(prefix[lineName]?.length, `${lineName} N=${n} length`).toBe(n);
            const { mismatch, maxRelDiff } = comparePrefix(
              prefix[lineName],
              reference[lineName].slice(0, n),
            );
            expect(mismatch, `${lineName} N=${n}`).toBeNull();
            worst = Math.max(worst, maxRelDiff);
            probes += 1;
          }
          // Loop-edit canary (M-3). This pins the COUNT of iterations, so weakening
          // the walk (`n += 8` → `n += 16`, 7 vs 13) or narrowing its range goes red
          // here. Shortening the FIXTURE is not this pin's job and never was: for
          // L > 16 both sides of this expression derive from L, so a shorter CSV
          // stays green here and is caught by the literal length assertion below.
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
   * `k <= 0` with the CURRENT bar (`pineRuntime.ts:430`, the `if` itself — `:429` is
   * only its signature line). So `close[-1]` reads the same value as `close`, never
   * bar+1.
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
