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

/**
 * Engine vs reference, bar by bar. ``engine`` is the raw ``Record`` lookup, so a line the
 * engine never emitted arrives as ``undefined`` — it must NOT be defaulted to ``[]`` here.
 * An empty array walks the whole reference with ``got === undefined``, and
 * ``Number.isNaN(undefined)`` is ``false``, so every bar took the "engine has a number"
 * branch: ``Math.abs(undefined - ref)`` is ``NaN``, ``NaN > worst`` is ``false``, ``worst``
 * stayed at ``0``, ``checked`` counted every index — so all four assertions the gate had
 * before this fix passed on a line that does not exist (finding I1; the ``ema`` line has
 * zero warm-up na, so it never even hit the ``reference is na`` early return).
 *
 * ``where`` names ``batch/line@variant`` in every red message, because "some comparison
 * failed" is not actionable when four bar variants run the same five lines.
 */
function worstRelative(
  engine: number[] | undefined,
  reference: number[],
  where: string,
): Reading {
  if (engine === undefined) {
    return {
      checked: 0,
      naCount: 0,
      worst: 0,
      mismatch: `${where}: 引擎没有输出这条线（series 不存在），${reference.length} 个下标无一可比`,
    };
  }
  // Length reconciliation before any indexing: a truncated series otherwise leaves the
  // missing tail unvisited while `checked + naCount` still equals `expected.length`, and
  // the key-set guard cannot see it (the engine allocates series by `bars.list.length`,
  // `pineRuntime.ts:1742`, so shortening happens without changing the line's name).
  if (engine.length !== reference.length) {
    return {
      checked: 0,
      naCount: 0,
      worst: 0,
      mismatch: `${where}: 序列长度不一致 engine=${engine.length} reference=${reference.length}`,
    };
  }
  let worst = 0;
  let checked = 0;
  let naCount = 0;
  for (let i = 0; i < reference.length; i += 1) {
    const ref = reference[i];
    // Declared as `number | undefined` rather than inferred: an array hole or a sparse
    // series reads as `undefined` at runtime while TypeScript still calls it `number`,
    // and the comparison below is the point of the exercise, not an artefact.
    const got: number | undefined = engine[i];
    if (got === undefined) {
      return {
        checked,
        naCount,
        worst,
        mismatch: `${where}: index ${i}: 引擎在该下标没有值（undefined），参考为 ${ref}`,
      };
    }
    if (Number.isNaN(ref)) {
      if (!Number.isNaN(got)) {
        return { checked, naCount, worst, mismatch: `${where}: index ${i}: reference is na, engine gave ${got}` };
      }
      naCount += 1;
      continue;
    }
    if (Number.isNaN(got)) {
      return { checked, naCount, worst, mismatch: `${where}: index ${i}: engine is na, reference has ${ref}` };
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
        // No `?? []`: a missing line is a finding, not an empty series (see worstRelative).
        const { checked, naCount, worst, mismatch } = worstRelative(
          engine[line],
          expected,
          `${batch}/${line}@${variant}`,
        );
        const tier = TIER_VALUE[manifest.tolerance_tier[line]];
        it(`${line} on ${variant}: matches the numpy reference within ${manifest.tolerance_tier[line]}`, () => {
          // Two different reds, kept apart on purpose: an all-na reference column means
          // the fixture stopped carrying information, a missing engine line means the
          // script did not plot it — neither may read as agreement.
          expect(expected.some((v) => !Number.isNaN(v))).toBe(true);
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
