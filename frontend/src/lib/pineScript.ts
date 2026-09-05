/**
 * Public entry point of the Pine Script compatibility layer.
 *
 * The layer is split so that each file has one job:
 *
 *   pineLang.ts     text → AST (tokenizer + recursive-descent parser)
 *   pineRuntime.ts  per-bar interpreter (variables, plotting, inputs)
 *   pineOrders.ts   `strategy()` fill simulation and the report numbers
 *   pineTa/pineMath function tables (`ta.*`, `math.*`, `str.*`, casts…)
 *   pineScript.ts   this file — the only module the UI talks to
 *
 * Why an interpreter instead of transpiling Pine to JavaScript: the production
 * build serves `Content-Security-Policy: script-src 'self'`, which forbids
 * `eval`/`new Function` outright (locked by an upstream test), so anything that
 * compiles source text at runtime would work in dev and die in production.
 *
 * Output contract: `PineArtifact.figures` + `.rows` are aligned with the chart's
 * bar list, which is exactly what a KLineChart indicator's `calc` has to return.
 */

import type { KLineData } from "klinecharts";
import { parsePine } from "./pineLang";
import { runPine, type RunOptions } from "./pineRuntime";
import { toBars, type PineLine, type PineMarker, type PineResult } from "./pineTypes";

export type { PineInput, PineLine, PineMarker, PineReport, PineResult } from "./pineTypes";
export { looksLikePine as isPineSource, PineError } from "./pineLang";

/** One row of indicator output; `undefined` renders as a gap. */
export type PineRows = Record<string, number | undefined>;

/** How a figure is drawn — the subset of KLineChart figure types we use. */
export type PineFigureType = "line" | "bar" | "circle";

export interface PineFigure {
  key: string;
  title: string;
  type: PineFigureType;
  /** Baseline for bar figures (histograms sit on 0). */
  baseValue?: number;
  /** CSS colour resolved from `color.*`, when the script asked for one. */
  color?: string;
  /** True for `hline()` reference lines, so the chart can dash them. */
  reference?: boolean;
  /** Set when a reference line asked for a solid line instead of a dash. */
  solid?: boolean;
}

export interface PineArtifact {
  /** Full interpreter output (inputs, report, warnings…). */
  result: PineResult;
  /** Figures in drawing order: plots, then shapes, then reference lines. */
  figures: PineFigure[];
  /** Row per bar, keyed by `figure.key`; NaN values are stored as undefined. */
  rows: PineRows[];
  /**
   * Set when the script threw part-way through: every bar after that point is
   * missing, so the caller must treat the run as failed rather than plot it.
   */
  abort?: string;
  error?: undefined;
}

export interface PineFailure {
  error: string;
}

/** Parse only: a readable message, or null when the source is syntactically fine. */
export function validatePine(code: string): string | null {
  try {
    parsePine(code);
    return null;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** Default parameter values, in the order the script declared its inputs. */
export function pineDefaults(result: PineResult): number[] {
  return result.inputs.map((inp) => (Number.isFinite(inp.def) ? inp.def : 0));
}

/**
 * Does this Pine source trade, or does it just draw?
 *
 * Header-side judgment for callers that never ran the script (a saved row on a
 * chart that has not recalculated yet, so no artifact exists). Once a run has
 * happened, `result.scriptKind` is the authoritative answer — this sniff only
 * decides what to offer *before* one, so trading statements count as much as
 * the `strategy()` header itself. Comments are stripped first: documenting a
 * ported script with `// strategy.entry(...)` must not fake a report.
 */
export function isPineStrategy(code: string): boolean {
  const body = code
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  return /^\s*strategy\s*\(/m.test(body) || /(^|[^\w.])strategy\.(entry|close|exit)\b/.test(body);
}

/** Colour shared by every marked bar of one `plotshape()` family. */
function markerColor(m: PineMarker): string | undefined {
  let up = 0;
  let down = 0;
  for (let i = 0; i < m.values.length; i++) {
    if (Number.isNaN(m.values[i])) continue;
    if (m.up[i]) up++;
    else down++;
  }
  if (up && !down) return "#26a69a";
  if (down && !up) return "#ef5350";
  return undefined;
}

/**
 * Flatten the interpreter output into chart figures + bar-aligned rows.
 * `len` is the chart's bar count: a script that aborted early still gets one
 * row per bar, because KLineChart indexes rows by bar position.
 */
export function toArtifact(result: PineResult, len = result.bars): PineArtifact {
  const n = Math.max(0, len);
  const figures: PineFigure[] = [];
  const rows: PineRows[] = [];
  for (let i = 0; i < n; i++) rows.push({});

  const put = (key: string, series: number[]) => {
    for (let i = 0; i < n; i++) {
      const v = series[i];
      rows[i][key] = typeof v === "number" && Number.isFinite(v) ? v : undefined;
    }
  };

  result.lines.forEach((line: PineLine, i) => {
    const key = `p${i}`;
    figures.push({
      key,
      title: line.name,
      type: line.style,
      baseValue: line.style === "bar" ? (line.baseValue ?? 0) : undefined,
      color: line.color,
    });
    put(key, line.values);
  });

  result.markers.forEach((m: PineMarker, i) => {
    const key = `s${i}`;
    // The script's own colour wins; otherwise green/red follows the side it sits on.
    figures.push({ key, title: m.name, type: "circle", color: m.color ?? markerColor(m) });
    put(key, m.values);
  });

  // A reference line is drawn as a flat series: same look as TradingView, and
  // it keeps its title in the legend where the reader expects it.
  result.hlines.forEach((h, i) => {
    const key = `h${i}`;
    figures.push({
      key,
      title: h.title || `参考线 ${h.price}`,
      type: "line",
      reference: true,
      solid: h.style === "solid",
      color: h.color,
    });
    for (let j = 0; j < n; j++) rows[j][key] = h.price;
  });

  return { result, figures, rows };
}

/**
 * Run Pine source against a bar list.
 *
 * Returns either an artifact ready for the chart or a one-line `error`; a
 * script that aborts mid-way is reported through `warnings`, never silently.
 */
export function compilePine(
  code: string,
  dataList: KLineData[],
  opts: RunOptions = {},
): PineArtifact | PineFailure {
  if (!dataList.length) return { error: "没有K线数据，无法运行脚本" };
  try {
    const artifact = toArtifact(runPine(code, toBars(dataList), opts), dataList.length);
    if (artifact.result.bars < dataList.length) {
      // The interpreter stopped early; say so in its words, not ours.
      artifact.abort =
        artifact.result.warnings.find((w) => w.includes("中断")) ??
        `脚本在第 ${artifact.result.bars} 根K线后停止`;
    }
    return artifact;
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}
