import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import { compilePine } from "../pineScript";
import type { KLineData } from "klinecharts";

/**
 * Community-corpus regression (Track A3).
 *
 * An 18-file slice of the real third-party scripts under
 * __fixtures__/corpus-smoke/ — TradingView open-source indicators authored by
 * others (see that folder's NOTICE), copied verbatim. Unlike the bulk corpus
 * (local-only, measured by pineCorpusReport), these are committed and this IS a
 * gate: every script here parses, runs without aborting, and produces output on
 * the current engine. If a future change breaks any of them the build goes red
 * with the offending file named — the durable form of "acceptance with code we
 * did not write" from the compatibility lessons.
 *
 * Numbers are deliberately not asserted (that is TradingView's job and the
 * resample/supertrend cross-checks elsewhere); this pins *compatibility*, not
 * market-correctness.
 */

const SMOKE_DIR = resolve(process.cwd(), "src/lib/__tests__/__fixtures__/corpus-smoke");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(abs));
    else if (entry.name.endsWith(".pine")) out.push(abs);
  }
  return out.sort();
}

function makeBars(n: number): KLineData[] {
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  let price = 100;
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
      volume: 1000 + Math.floor(rand() * 500),
      turnover: 0,
    } as KLineData;
  });
}

const BARS = makeBars(300);
const files = walk(SMOKE_DIR);

describe("community corpus smoke regression (real third-party scripts)", () => {
  it("has a committed slice to run against", () => {
    expect(files.length).toBeGreaterThanOrEqual(18);
  });

  for (const abs of files) {
    const rel = abs.slice(SMOKE_DIR.length + 1).replace(/\\/g, "/");
    it(`compiles, runs and emits output: ${rel}`, () => {
      const src = readFileSync(abs, "utf8");
      const out = compilePine(src, BARS, {});
      if ("error" in out) throw new Error(`${rel} 编译失败：${out.error}`);
      if (out.abort) throw new Error(`${rel} 运行中断：${out.abort}`);
      const produced =
        out.result.lines.some((l) => l.values.some((v) => Number.isFinite(v))) ||
        out.result.markers.length > 0 ||
        out.result.hlines.length > 0;
      expect(produced, `${rel} 没有产出任何有效输出`).toBe(true);
    });
  }
});
