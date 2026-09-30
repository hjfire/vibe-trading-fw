import { describe, it, expect } from "vitest";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { compilePine } from "../pineScript";
import type { KLineData } from "klinecharts";

/**
 * Community-corpus pass-rate measurement (Track A2).
 *
 * This is NOT a gate — it is a measurement over real scripts we did not write,
 * so the pass-rate is reported honestly rather than pinned to green. It reads
 * the corpus downloaded by frontend/scripts/corpus/fetchPineCorpus.mjs; when
 * that local-only corpus is absent (e.g. in CI) the whole suite skips instead
 * of vacuously passing over an empty set (the two false-green traps).
 *
 * Each script is classified into exactly one outcome — compile_error /
 * runtime_abort / no_output / ok — and every failure is attributed to the Pine
 * constructs it uses, so the output doubles as a prioritised engine backlog.
 */

const CORPUS_DIR = resolve(process.cwd(), "src/lib/__tests__/__fixtures__/corpus");
const MANIFEST = resolve(process.cwd(), "scripts/corpus/pine-community.manifest.json");

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
      volume: 800 + Math.floor(rand() * 1200),
      turnover: 0,
    } as KLineData;
  });
}

const BARS = makeBars(300);

/** Regexes keyed by a stable construct label; used to bucket failures. */
const CONSTRUCTS: Array<[string, RegExp]> = [
  ["version3", /\/\/\s*@version=3/],
  ["version4", /\/\/\s*@version=4/],
  ["study_header", /^\s*study\s*\(/m],
  ["input_defval", /\bdefval\s*=/],
  ["input_type", /\btype\s*=\s*(integer|source|float|bool|string)/],
  ["user_function", /=>/],
  ["reassignment", /:=/],
  ["var_decl", /^\s*var\s+/m],
  ["hex_color", /#[0-9a-fA-F]{6}/],
  ["transp", /\btransp\s*=/],
  ["linewidth", /\blinewidth\s*=/],
  ["fill", /\bfill\s*\(/],
  ["hline", /\bhline\s*\(/],
  ["plotshape", /\bplot(shape|char|arrow|text)\s*\(/],
  ["array_api", /\barray\./],
  ["for_loop", /^\s*for\b/m],
  ["request_security", /\brequest\.security/],
  ["title_named_arg", /\btitle\s*=/],
  ["nz", /\bnz\s*\(/],
  ["input_source", /\binput\s*\([^)]*\btype\s*=\s*source/],
];

type Outcome = "ok" | "compile_error" | "runtime_abort" | "no_output";

/** Normalise an error line so identical root causes bucket together: keep the
 *  leading message, drop bar indices / coordinates that vary run to run. */
function reasonOf(msg: string): string {
  return msg.replace(/bar\s+\d+/gi, "bar N").replace(/\d+/g, "N").slice(0, 140).trim();
}

function classify(src: string): { outcome: Outcome; constructs: string[]; reason: string } {
  const constructs = CONSTRUCTS.filter(([, re]) => re.test(src)).map(([k]) => k);
  let outcome: Outcome;
  let reason = "";
  try {
    const out = compilePine(src, BARS, {});
    if ("error" in out) {
      outcome = "compile_error";
      reason = reasonOf(out.error ?? "");
    } else if (out.abort) {
      outcome = "runtime_abort";
      reason = reasonOf(out.abort ?? "");
    } else {
      const produced =
        out.result.lines.some((l) => l.values.some((v) => Number.isFinite(v))) ||
        out.result.markers.length > 0 ||
        out.result.hlines.length > 0;
      outcome = produced ? "ok" : "no_output";
    }
  } catch (e) {
    outcome = "runtime_abort";
    reason = reasonOf((e as Error).message ?? String(e));
  }
  return { outcome, constructs, reason };
}

const corpusReady = existsSync(CORPUS_DIR) && existsSync(MANIFEST);
const suite = corpusReady ? describe : describe.skip;

suite("community Pine corpus pass-rate (measurement)", () => {
  it("tallies outcomes + failure constructs across the real corpus", () => {
    const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { files: string[] };
    const tally: Record<Outcome, number> = { ok: 0, compile_error: 0, runtime_abort: 0, no_output: 0 };
    // Per-construct: [times seen, times it appeared in a failing script].
    const stats = new Map<string, { seen: number; failed: number }>();
    const reasons = new Map<string, number>();
    const failures: Array<{ file: string; outcome: Outcome; constructs: string[]; reason: string }> = [];
    const okFiles: string[] = [];

    let measured = 0;
    for (const rel of manifest.files) {
      const abs = resolve(CORPUS_DIR, rel);
      if (!existsSync(abs)) continue;
      measured++;
      const src = readFileSync(abs, "utf8");
      const { outcome, constructs, reason } = classify(src);
      tally[outcome]++;
      for (const c of constructs) {
        const s = stats.get(c) ?? { seen: 0, failed: 0 };
        s.seen++;
        if (outcome !== "ok") s.failed++;
        stats.set(c, s);
      }
      if (outcome !== "ok") {
        reasons.set(reason || outcome, (reasons.get(reason || outcome) ?? 0) + 1);
        failures.push({ file: rel, outcome, constructs, reason });
      } else {
        okFiles.push(rel);
      }
    }

    expect(measured).toBeGreaterThan(0); // never claim a rate over an empty set
    const passRate = (tally.ok / measured) * 100;

    // Rank constructs by how often they co-occur with a failure — the backlog.
    const byFailure = [...stats.entries()]
      .map(([c, s]) => ({ construct: c, seen: s.seen, failed: s.failed }))
      .filter((r) => r.failed > 0)
      .sort((a, b) => b.failed - a.failed);

    const topReasons = [...reasons.entries()]
      .map(([reason, n]) => ({ reason, n }))
      .sort((a, b) => b.n - a.n)
      .slice(0, 15);

    const report = {
      corpus: manifest.files.length,
      measured,
      outcomeCounts: tally,
      passRatePct: Math.round(passRate * 10) / 10,
      failureConstructs: byFailure,
      topReasons,
      okFiles,
      failures: failures.slice(0, 250),
    };
    process.stdout.write(
      `${JSON.stringify({
        measured,
        outcomeCounts: tally,
        passRatePct: report.passRatePct,
        topReasons,
      })}\n`,
    );
    // Full report lands next to the corpus (local-only, gitignored).
    writeFileSync(resolve(CORPUS_DIR, "_pass-rate.json"), JSON.stringify(report, null, 2), "utf8");
  });
});
