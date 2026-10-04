/**
 * Fixture readers for the Pine oracle gates.
 *
 * Nothing here regenerates bars: the committed CSV is the single truth, because
 * re-deriving the same float array in JS with a different operation order would
 * make the bars themselves differ in the last bit and void the comparison.
 * The gate must fail — never skip — when a fixture is missing: these files are
 * committed, so their absence is an incident, not a local-only corpus.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { KLineData } from "klinecharts";

import { compilePine } from "../pineScript";
import { toBars, type PineBars } from "../pineTypes";

export const BARS_VARIANTS = [
  "bars_daily_trend",
  "bars_daily_oscillating",
  "bars_daily_gapped",
  "bars_intraday_vwap",
] as const;

export const TIER_VALUE: Record<string, number> = { exact: 0, tight: 1e-12, loose: 1e-9 };

// Resolved from this module's location, not process.cwd(): vitest's cwd depends on how
// it was invoked, and a relative path would read a missing directory as "no data".
// `__dirname` rather than `import.meta.url`: this suite runs under the config's
// `environment: "jsdom"`, where vitest rewrites import.meta.url to an http URL and
// fileURLToPath() throws "The URL must be of scheme file" at module load — the same
// constraint `src/pages/__tests__/Help.test.tsx:112-115` documents and
// `src/__tests__/viteProxy.test.ts` already works around. Both forms resolve against
// this file, so the gate is cwd-independent either way.
const DIR = resolve(__dirname, "__fixtures__/pine_oracle");

function readCsv(path: string): string[][] {
  // LF is pinned by the fixture dir's .gitattributes; accept CRLF anyway so a
  // hand-checkout on a core.autocrlf=true box cannot be mistaken for a value bug.
  const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  return text.split("\n").filter((l) => l.length > 0).map((l) => l.split(","));
}

export interface OracleAnchor {
  name: string;
  value: string;
  source: string;
  retrieved_at: string;
}

export interface OracleManifest {
  tolerance_tier: Record<string, string>;
  exemption: Record<string, string>;
  scripts: Record<string, string>;
  lines: Record<string, string[]>;
  external_anchors: OracleAnchor[];
  files: Record<string, string>;
  na_encoding: string;
  line_ending: string;
  seed: Record<string, number>;
  shape: Record<string, string>;
  period: Record<string, number>;
}

export function loadManifest(): OracleManifest {
  return JSON.parse(readFileSync(`${DIR}/manifest.json`, "utf8")) as OracleManifest;
}

function columnsOf(name: string): { header: string[][][0]; rows: string[][] } {
  const rows = readCsv(`${DIR}/${name}.csv`);
  return { header: rows[0], rows: rows.slice(1) };
}

export function loadBars(name: string): PineBars {
  const { header, rows } = columnsOf(name);
  const col = (key: string) => header.indexOf(key);
  const list: KLineData[] = rows.map((r) => ({
    timestamp: Number(r[col("time")]),
    open: Number(r[col("open")]),
    high: Number(r[col("high")]),
    low: Number(r[col("low")]),
    close: Number(r[col("close")]),
    volume: Number(r[col("volume")]),
  }));
  return toBars(list);
}

/** The ``session`` column when the variant carries one; ``null`` when it does not. */
export function loadSession(name: string): number[] | null {
  const { header, rows } = columnsOf(name);
  const at = header.indexOf("session");
  if (at < 0) return null;
  return rows.map((r) => Number(r[at]));
}

/** ``values/<line>@<variant>.csv`` → expected series; an empty field is Pine ``na``. */
export function expectedColumn(line: string, variant: string): number[] {
  const rows = readCsv(`${DIR}/values/${line}@${variant}.csv`);
  return rows.slice(1).map((r) => (r[1] === "" ? NaN : Number(r[1])));
}

/** Every plotted line's value series, keyed by line name — never by plot order. */
export function runScript(src: string, bars: PineBars): Record<string, number[]> {
  const out = compilePine(src, bars.list, {});
  if ("error" in out) throw new Error(`编译失败：${out.error}`);
  if (out.abort) throw new Error(`运行中断：${out.abort}`);
  const byName: Record<string, number[]> = {};
  for (const line of out.result.lines) {
    if (byName[line.name]) {
      throw new Error(`重复的 line 名 ${line.name}：夹具按名对齐，重名会把两条线读成一条`);
    }
    byName[line.name] = line.values;
  }
  return byName;
}

/** Slice a PineBars array down to its first ``n`` bars (gate 1's prefix probe). */
export function sliceBars(bars: PineBars, n: number): PineBars {
  const cut = (a: number[]) => a.slice(0, n);
  return {
    list: bars.list.slice(0, n),
    open: cut(bars.open),
    high: cut(bars.high),
    low: cut(bars.low),
    close: cut(bars.close),
    volume: cut(bars.volume),
    time: cut(bars.time),
  };
}
