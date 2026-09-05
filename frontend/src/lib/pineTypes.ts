/**
 * Shared value/output types for the Pine Script compatibility layer.
 *
 * Execution model (why this file exists separately from indicatorLang.ts):
 * a Pine script runs **once per bar** and every expression evaluates to a
 * scalar at the current bar. Series history is not an array you index into —
 * `close[1]` means "close one bar ago" and is served from each variable's
 * history buffer. So the runtime deals in scalars, not vectors.
 *
 * Value domain:
 *   number   — int/float, and NaN for Pine's `na`
 *   string   — text, plus `@`-prefixed sentinels for enums/colors the renderer
 *              does not fully support (kept so scripts still compile)
 *   V[]      — a tuple (`[macd, signal, hist] = ta.macd(...)`)
 */

import type { KLineData } from "klinecharts";
import type { Arg, Expr } from "./pineLang";

export type { Arg, Expr } from "./pineLang";

/**
 * Slot passed to `argAt`/`numArg` when a value may only come from a named
 * argument (`overlay=true`, `minval=…`) and never positionally.
 */
export const NAMED_ONLY = 99;

export type V = number | string | V[];

export const NA = Number.NaN;

/** `na` in Pine: NaN for numbers, empty for arrays. */
export function isNa(v: V): boolean {
  if (typeof v === "number") return Number.isNaN(v);
  if (Array.isArray(v)) return false;
  return v === "";
}

/** Numeric view of a value: bools/na/enums collapse to a number. */
export function asNum(v: V): number {
  if (typeof v === "number") return v;
  if (Array.isArray(v)) return v.length > 0 ? asNum(v[v.length - 1] as number) : NA;
  if (typeof v === "string") {
    if (v.startsWith("@")) return NA;
    const n = Number(v);
    return Number.isFinite(n) ? n : NA;
  }
  return NA;
}

/** Text view, used for plot titles built with string concatenation. */
export function asStr(v: V): string {
  if (typeof v === "string") return v.startsWith("@") ? v.slice(1) : v;
  if (Array.isArray(v)) return v.map(asStr).join(", ");
  if (Number.isNaN(v)) return "NaN";
  // Pine prints integers without a trailing .0
  return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6);
}

export function isTrue(v: V): boolean {
  const n = asNum(v);
  return !Number.isNaN(n) && n !== 0;
}

export function isSentinel(v: V, want: string): boolean {
  return typeof v === "string" && v === `@${want}`;
}

/** Sentinel for enum-ish arguments (location.abovebar, color.red, …). */
export function sentinel(name: string): string {
  return `@${name}`;
}

/* ------------------------------------------------------- argument accessors */

export function positional(args: Arg[]): Arg[] {
  return args.filter((a) => !a.name);
}

/** Named argument, falling back to the given positional slot. */
export function argAt(args: Arg[], index: number, ...names: string[]): Expr | undefined {
  for (const n of names) {
    const hit = args.find((a) => a.name === n);
    if (hit) return hit.value;
  }
  const pos = positional(args);
  return pos.length > index ? pos[index].value : undefined;
}

/** Numeric argument with a default (window lengths, multipliers, …). */
export function numArg(
  args: Arg[],
  c: { val(e: Expr): V },
  index: number,
  def: number,
  ...names: string[]
): number {
  const e = argAt(args, index, ...names);
  if (!e) return def;
  const n = asNum(c.val(e));
  return Number.isNaN(n) ? def : n;
}

export function strArg(
  args: Arg[],
  c: { val(e: Expr): V },
  index: number,
  def: string,
  ...names: string[]
): string {
  const e = argAt(args, index, ...names);
  if (!e) return def;
  const v = c.val(e);
  const s = asStr(v);
  return s === "" ? def : s;
}

/* ------------------------------------------------------------ output model */

export type PlotStyle = "line" | "bar" | "circle";

export interface PineLine {
  /** Display name, taken from the plot's `title` argument. */
  name: string;
  values: number[];
  style: PlotStyle;
  /** Baseline for bar-style plots (histograms sit on 0). */
  baseValue?: number;
  color?: string;
  /** Pine `offset`, in bars; shifts the plotted value right/left. */
  offset: number;
}

export interface PineMarker {
  name: string;
  /** Price at the marked bar, NaN where the shape is off. */
  values: number[];
  /** Text drawn for plotchar/plotshape (▲/▼ style labels). */
  texts: string[];
  /** true = drawn above the bar (green), false = below (red). */
  up: boolean[];
  /** Colour the script asked for, when it gave one. */
  color?: string;
}

export interface PineInput {
  /** Bound variable name, so the formula can keep referring to it. */
  varName: string;
  label: string;
  kind: "int" | "float" | "bool" | "source" | "other";
  def: number;
  min?: number;
  max?: number;
  step?: number;
  /** Options for string inputs (not editable yet, kept for round-trips). */
  options?: string[];
  group?: string;
}

export interface PineTrade {
  side: "long" | "short";
  entryBar: number;
  entryTime: number;
  entryPrice: number;
  exitBar: number;
  exitTime: number;
  exitPrice: number;
  qty: number;
  pnl: number;
  /** What closed it: signal / stop / limit / end. */
  reason: string;
  /** Percent return of the position (signed by direction). */
  retPct: number;
}

export interface PineReport {
  initialCapital: number;
  commissionPct: number;
  slippagePct: number;
  defaultQtyType: "fixed" | "percent_of_equity";
  defaultQtyValue: number;
  ordersOnClose: boolean;
  /** Equity sampled per bar, index-aligned with the bar list. */
  equity: number[];
  trades: PineTrade[];
  openSide: "long" | "short" | "flat";
  openEntries: number;
  netPnl: number;
  netPnlPct: number;
  /** Mark-to-market of what is still open (equity curve minus realised). */
  unrealizedPnl: number;
  /** Total return on the equity curve, unrealised included. */
  returnPct: number;
  /** Trade stats for the TV-style report panel. */
  closedCount: number;
  winCount: number;
  winRatePct: number;
  grossProfit: number;
  grossLoss: number;
  profitFactor: number;
  maxRunUp: number;
  maxDrawdownPct: number;
  buyHoldPct: number;
  avgWin: number;
  avgLoss: number;
}

export interface PineResult {
  /** "indicator" | "strategy" from the header call. */
  scriptKind: "indicator" | "strategy";
  title: string;
  /** Header `overlay=` — plot on the price pane when true. */
  overlay: boolean;
  /** Price format hint from `format=` (inherit/price/volume…). */
  format: string;
  precision?: number;
  inputs: PineInput[];
  lines: PineLine[];
  markers: PineMarker[];
  hlines: { price: number; title: string; color?: string; style?: string }[];
  report?: PineReport;
  /** Honest list of what was skipped — never silently swallowed. */
  warnings: string[];
  /** Number of bars the script actually walked. */
  bars: number;
}

/** Bar data the runtime needs beyond OHLCV. */
export interface PineBars {
  list: KLineData[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
  time: number[];
}

export function toBars(list: KLineData[]): PineBars {
  return {
    list,
    open: list.map((b) => b.open),
    high: list.map((b) => b.high),
    low: list.map((b) => b.low),
    close: list.map((b) => b.close),
    volume: list.map((b) => b.volume ?? 0),
    time: list.map((b) => b.timestamp ?? 0),
  };
}

/**
 * What a built-in function may ask the interpreter for: read the current bar,
 * evaluate a sub-expression, and own a mutable state slot per call site
 * (`ta.ema` is recursive, so the slot IS the function's memory).
 */
export interface BuiltinCtx {
  /** Current bar index. */
  bi: number;
  /** Total bars in the loaded range. */
  len: number;
  bars: PineBars;
  val(e: Expr): V;
  /** Mutable state for this call site; `sub` splits it into named drawers. */
  state<T extends object>(init: () => T, sub?: string): T;
  warn(msg: string): void;
}

export type Builtin = (args: Arg[], c: BuiltinCtx) => V;

/** Boolean argument (`absolute=true`, `show=...`), by name or position. */
export function flagArg(
  args: Arg[],
  c: { val(e: Expr): V },
  index: number,
  def = false,
  ...names: string[]
): boolean {
  const e = argAt(args, index, ...names);
  return e ? isTrue(c.val(e)) : def;
}

/* ------------------------------------------------------------- color table */

/**
 * Pine color constants mapped to CSS so imported TradingView scripts keep
 * their intent on screen. `color.new(base, transp)` returns the base hue.
 */
export const PINE_COLORS: Record<string, string> = {
  red: "#ef5350",
  maroon: "#8b1a1a",
  dark_red: "#7f1d1d",
  green: "#26a69a",
  lime: "#00c853",
  teal: "#00897b",
  blue: "#2962ff",
  navy: "#0d1b4c",
  orange: "#ff9800",
  yellow: "#ffeb3b",
  white: "#ffffff",
  black: "#000000",
  gray: "#9e9e9e",
  grey: "#9e9e9e",
  purple: "#9c27b0",
  fuchsia: "#e91e63",
  aqua: "#00bcd4",
  olive: "#808000",
  silver: "#c0c0c0",
  new: "",
  transparent: "",
};

/** Resolve a `color.*` sentinel or a literal "#rrggbb" to CSS. */
export function resolveColor(v: V | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v === "number") return undefined;
  if (Array.isArray(v)) return undefined;
  if (!v.startsWith("@color.")) return v.startsWith("#") ? v : undefined;
  const key = v.slice("@color.".length).split(".")[0];
  const hit = PINE_COLORS[key];
  return hit === undefined ? undefined : hit || undefined;
}
