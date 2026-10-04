import { describe, expect, it } from "vitest";

import {
  BARS_VARIANTS,
  TIER_VALUE,
  expectedColumn,
  loadBars,
  loadManifest,
  runScript,
  type OracleManifest,
} from "./pineOracleFixtures";

/**
 * Gate 2 — cross-implementation reconciliation. The reference series here come
 * from ``agent/pine_oracle/reference.py`` (independent numpy code, pinned by
 * hand-derivable closed forms), never from the engine. A pass therefore means
 * "two separately-written implementations agree to within the declared tier".
 */

/** The bar count each variant is generated with; a shorter fixture would silently
 * shrink the comparison instead of failing. */
const BAR_COUNT: Record<string, number> = {
  bars_daily_trend: 120,
  bars_daily_oscillating: 120,
  bars_daily_gapped: 120,
  bars_intraday_vwap: 40,
};

interface Reading {
  checked: number;
  naCount: number;
  worst: number;
  mismatch: string | null;
}

function worstRelative(engine: number[], reference: number[]): Reading {
  let worst = 0;
  let checked = 0;
  let naCount = 0;
  for (let i = 0; i < reference.length; i += 1) {
    const ref = reference[i];
    const got = engine[i];
    if (Number.isNaN(ref)) {
      if (!Number.isNaN(got)) {
        return { checked, naCount, worst, mismatch: `index ${i}: reference is na, engine gave ${got}` };
      }
      naCount += 1;
      continue;
    }
    if (Number.isNaN(got)) {
      return { checked, naCount, worst, mismatch: `index ${i}: engine is na, reference has ${ref}` };
    }
    checked += 1;
    const diff = Math.abs(got - ref) / Math.max(Math.abs(ref), 1e-9);
    if (diff > worst) worst = diff;
  }
  return { checked, naCount, worst, mismatch: null };
}

describe("pine ta.* cross-implementation oracle", () => {
  const manifest: OracleManifest = loadManifest();

  for (const batch of Object.keys(manifest.scripts)) {
    const lineNames = manifest.lines[batch];
    const src = manifest.scripts[batch];

    for (const variant of BARS_VARIANTS) {
      const bars = loadBars(variant);
      const engine = runScript(src, bars);

      // A stray/renamed/missing plot() must not be able to hide behind "the lines we
      // knew about matched": compare the whole key set, in both directions.
      it(`${batch} on ${variant}: the script plots exactly the declared lines`, () => {
        expect([...Object.keys(engine)].sort()).toEqual([...lineNames].sort());
        expect(bars.close.length).toBe(BAR_COUNT[variant]);
      });

      for (const line of lineNames) {
        const expected = expectedColumn(line, variant);
        const { checked, naCount, worst, mismatch } = worstRelative(engine[line] ?? [], expected);
        const tier = TIER_VALUE[manifest.tolerance_tier[line]];
        it(`${line} on ${variant}: matches the numpy reference within ${manifest.tolerance_tier[line]}`, () => {
          expect(mismatch).toBeNull();
          // Every index is either compared or na on both sides — nothing skipped.
          expect(checked + naCount).toBe(expected.length);
          expect(checked).toBeGreaterThan(0);
          expect(worst).toBeLessThanOrEqual(tier);
        });
        // The reading the DoD asks for: one number per (line, variant), printed, not a
        // boolean. Assertions stay above; this line only reports.
        console.info(`[oracle] ${batch}/${line}@${variant} worst=${worst.toExponential(3)} na=${naCount} checked=${checked}`);
      }
    }
  }
});
