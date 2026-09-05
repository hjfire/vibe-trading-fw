import type { KLineData } from "klinecharts";
import { compileFormula, detectDialect, normalizeRows } from "./indicatorLang";
import { compilePine } from "./pineScript";
import { fetchKline, type IntervalKey } from "./marketApi";

/**
 * Condition screener (local custom ⑪): run one script over a pool of symbols
 * and report which ones satisfy a rule on the newest bar.
 *
 * The screener owns no language of its own — a condition *is* a workbench
 * script, Pine or vector, evaluated by the same engines that draw it on the
 * chart. That keeps "what I see on the candles" and "what I screen for" the
 * same source text, which is the whole point of the compatibility layer.
 *
 * Only the pure half lives here (`scriptSeries`, `applyRule`, `screenOne`);
 * `screenPool` adds the fetch fan-out, and the UI can hand in its own bar
 * loader, which is also how the tests stay offline.
 */

const NA = Number.NaN;

/** What has to be true on the newest bar for a symbol to pass. */
export type ScreenerRule =
  | "nonEmpty"
  | "truthy"
  | "gt"
  | "lt"
  | "crossUp"
  | "crossDown"
  | "rising"
  | "falling";

export interface RuleInfo {
  key: ScreenerRule;
  label: string;
  /** Output lines the rule needs to be meaningful. */
  arity: 1 | 2;
  /** Whether the threshold input applies. */
  usesThreshold: boolean;
  hint: string;
}

export const SCREENER_RULES: RuleInfo[] = [
  { key: "nonEmpty", label: "有信号（第一条线不为空）", arity: 1, usesThreshold: false, hint: "配合 plot(cond ? close : na) 这类只在触发当天出值的脚本" },
  { key: "truthy", label: "条件成立（第一条线 > 0）", arity: 1, usesThreshold: false, hint: "脚本输出 1/0 真值，如 cross(...) 或 cond ? 1 : 0" },
  { key: "gt", label: "第一条线 > 阈值", arity: 1, usesThreshold: true, hint: "如收盘价站上某条均线后再比数值" },
  { key: "lt", label: "第一条线 < 阈值", arity: 1, usesThreshold: true, hint: "超卖、低于支撑一类" },
  { key: "crossUp", label: "第一条线上穿第二条线", arity: 2, usesThreshold: false, hint: "脚本需按顺序 plot 两条线（快线在前）" },
  { key: "crossDown", label: "第一条线下穿第二条线", arity: 2, usesThreshold: false, hint: "脚本需按顺序 plot 两条线（快线在前）" },
  { key: "rising", label: "第一条线较上一根上升", arity: 1, usesThreshold: false, hint: "斜率转正，如 RSI/均线抬头" },
  { key: "falling", label: "第一条线较上一根下降", arity: 1, usesThreshold: false, hint: "斜率转负，如均线或 RSI 拐头向下" },
];

export function ruleInfo(rule: ScreenerRule): RuleInfo {
  return SCREENER_RULES.find((r) => r.key === rule) ?? SCREENER_RULES[0];
}

/** One output line, sampled at the two newest bars. */
export interface ScreenSeries {
  name: string;
  last: number;
  prev: number;
}

export interface ScreenRow {
  symbol: string;
  hit: boolean;
  /** Why it passed / failed. Empty for a pass unless there is nothing to say. */
  reason: string;
  close: number;
  changePct: number;
  series: ScreenSeries[];
  bars: number;
  interval: IntervalKey;
}

const finite = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : NA);

/** How many bars one screen fetches: enough for long windows, cheap enough to fan out. */
export const SCREEN_BARS = 300;

/**
 * Run a script over bars and return its plotted lines in drawing order.
 * An `error` here is the script's own verdict on this symbol, not a crash.
 */
export function scriptSeries(
  code: string,
  bars: KLineData[],
  params: number[] = [],
): { series: ScreenSeries[]; error: string } {
  const arrays: { name: string; values: number[] }[] = [];
  if (detectDialect(code) === "pine") {
    const out = compilePine(code, bars, { params });
    if ("error" in out) return { series: [], error: out.error || "Pine 编译失败" };
    if (out.abort) return { series: [], error: out.abort };
    for (const line of out.result.lines) arrays.push({ name: line.name, values: line.values });
  } else {
    const compiled = compileFormula(code);
    if ("error" in compiled) return { series: [], error: compiled.error ?? "公式编译失败" };
    let result: unknown;
    try {
      result = compiled.run(bars, params);
    } catch (e) {
      return { series: [], error: e instanceof Error ? e.message : String(e) };
    }
    const norm = normalizeRows(result, bars.length);
    if (norm.error) return { series: [], error: norm.error };
    for (const key of norm.keys) arrays.push({ name: key, values: norm.rows.map((r) => finite(r[key])) });
  }

  const usable = arrays.filter((a) => a.values.some((v) => Number.isFinite(v)));
  if (usable.length === 0) {
    return { series: [], error: "脚本在该标的上没有输出线：筛选需要至少一条 plot/return 的数值线" };
  }
  return {
    series: usable.map((a) => ({
      name: a.name,
      last: a.values[a.values.length - 1] ?? NA,
      prev: a.values.length > 1 ? a.values[a.values.length - 2] ?? NA : NA,
    })),
    error: "",
  };
}

/** Judge the newest bar against a rule. */
export function applyRule(
  rule: ScreenerRule,
  series: ScreenSeries[],
  threshold = 0,
): { hit: boolean; reason: string } {
  const info = ruleInfo(rule);
  const a = series[0];
  const b = series[1];
  if (!a) return { hit: false, reason: "没有输出线" };
  if (info.arity === 2 && !b) return { hit: false, reason: "该条件需要两条输出线，这个脚本只有一条" };

  const shown = (v: number): string => (Number.isFinite(v) ? v.toFixed(4).replace(/\.?0+$/, "") : "空");
  const both = (...vals: number[]): boolean => vals.every((v) => Number.isFinite(v));

  let hit = false;
  switch (rule) {
    case "nonEmpty":
      hit = Number.isFinite(a.last);
      break;
    case "truthy":
      hit = both(a.last) && a.last > 0;
      break;
    case "gt":
      hit = both(a.last) && a.last > threshold;
      break;
    case "lt":
      hit = both(a.last) && a.last < threshold;
      break;
    case "crossUp":
      hit = both(a.prev, a.last, b!.prev, b!.last) && a.prev <= b!.prev && a.last > b!.last;
      break;
    case "crossDown":
      hit = both(a.prev, a.last, b!.prev, b!.last) && a.prev >= b!.prev && a.last < b!.last;
      break;
    case "rising":
      hit = both(a.prev, a.last) && a.last > a.prev;
      break;
    case "falling":
      hit = both(a.prev, a.last) && a.last < a.prev;
      break;
  }

  if (hit) return { hit: true, reason: "" };
  switch (rule) {
    case "nonEmpty":
      return { hit: false, reason: "最后一根没有值" };
    case "truthy":
      return { hit: false, reason: `${a.name} = ${shown(a.last)}，不为真` };
    case "gt":
      return { hit: false, reason: `${a.name} = ${shown(a.last)} ≤ ${shown(threshold)}` };
    case "lt":
      return { hit: false, reason: `${a.name} = ${shown(a.last)} ≥ ${shown(threshold)}` };
    case "crossUp":
      return { hit: false, reason: `${a.name} 未在最后一根上穿 ${b!.name}` };
    case "crossDown":
      return { hit: false, reason: `${a.name} 未在最后一根下穿 ${b!.name}` };
    case "rising":
      return { hit: false, reason: `${a.name} 未上升（${shown(a.prev)} → ${shown(a.last)}）` };
    default:
      return { hit: false, reason: `${a.name} 未下降（${shown(a.prev)} → ${shown(a.last)}）` };
  }
}

/** Bars for one symbol. Overridable so the caller (and tests) own the source. */
export type BarLoader = (
  symbol: string,
  opts: { interval: IntervalKey; count: number },
) => Promise<KLineData[]>;

export const fetchBars: BarLoader = async (symbol, { interval, count }) => {
  const res = await fetchKline({ symbol, interval, count });
  return res.bars as KLineData[];
};

/** Screen a single symbol against the script; never throws. */
export async function screenOne(
  opts: {
    symbol: string;
    code: string;
    params?: number[];
    rule: ScreenerRule;
    threshold?: number;
    interval: IntervalKey;
    count?: number;
    loadBars?: BarLoader;
  },
): Promise<ScreenRow> {
  const { symbol, code, rule, threshold = 0, interval } = opts;
  const count = opts.count ?? SCREEN_BARS;
  const params = opts.params ?? [];
  const base: ScreenRow = {
    symbol,
    hit: false,
    reason: "",
    close: NA,
    changePct: NA,
    series: [],
    bars: 0,
    interval,
  };
  let bars: KLineData[];
  try {
    bars = (await (opts.loadBars ?? fetchBars)(symbol, { interval, count })) ?? [];
  } catch (e) {
    return { ...base, reason: `行情获取失败：${e instanceof Error ? e.message : String(e)}` };
  }
  if (bars.length < 2) return { ...base, bars: bars.length, reason: "K线不足，无法判定" };

  const closes = bars.map((b) => b.close);
  const last = finite(closes[closes.length - 1]);
  const prev = finite(closes[closes.length - 2]);
  const changePct = Number.isFinite(last) && Number.isFinite(prev) && prev !== 0 ? ((last - prev) / prev) * 100 : NA;

  const { series, error } = scriptSeries(code, bars, params);
  if (error) return { ...base, bars: bars.length, close: last, changePct, reason: error };
  const verdict = applyRule(rule, series, threshold);
  return {
    ...base,
    bars: bars.length,
    close: last,
    changePct,
    series,
    hit: verdict.hit,
    reason: verdict.reason,
  };
}

export interface ScreenPoolOptions {
  symbols: string[];
  code: string;
  params?: number[];
  rule: ScreenerRule;
  threshold?: number;
  interval: IntervalKey;
  count?: number;
  /** Symbols fetched at a time; the data route is a local proxy, keep it modest. */
  concurrency?: number;
  loadBars?: BarLoader;
  /** Stop between requests; rows already in flight are dropped on the way out. */
  signal?: AbortSignal;
  /** Fired as each symbol lands, so the table fills in instead of waiting. */
  onRow?: (row: ScreenRow, done: number, total: number) => void;
}

const DEFAULT_CONCURRENCY = 4;

/** Screen a pool with a small worker fleet; results arrive in completion order. */
export async function screenPool(opts: ScreenPoolOptions): Promise<ScreenRow[]> {
  const symbols = [...new Set(opts.symbols.map((s) => s.trim().toUpperCase()).filter(Boolean))];
  const concurrency = Math.max(1, Math.min(opts.concurrency ?? DEFAULT_CONCURRENCY, 8));
  const rows: ScreenRow[] = [];
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      if (opts.signal?.aborted) return;
      const index = cursor++;
      if (index >= symbols.length) return;
      const row = await screenOne({
        symbol: symbols[index],
        code: opts.code,
        params: opts.params,
        rule: opts.rule,
        threshold: opts.threshold,
        interval: opts.interval,
        count: opts.count,
        loadBars: opts.loadBars,
      });
      if (opts.signal?.aborted) return;
      rows.push(row);
      opts.onRow?.(row, rows.length, symbols.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, symbols.length) }, worker));
  return rows;
}

/** Hits first, then the strongest condition value, then by symbol. */
export function sortRows(rows: ScreenRow[]): ScreenRow[] {
  const lead = (r: ScreenRow): number => (Number.isFinite(r.series[0]?.last) ? r.series[0].last : NA);
  return [...rows].sort((x, y) => {
    if (x.hit !== y.hit) return x.hit ? -1 : 1;
    const a = lead(x);
    const b = lead(y);
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b) return b - a;
    if (Number.isFinite(a) !== Number.isFinite(b)) return Number.isFinite(a) ? -1 : 1;
    return x.symbol.localeCompare(y.symbol);
  });
}

/** Tidy number for the results table: compact, no trailing-zero noise. */
export function formatScreenValue(v: number): string {
  if (!Number.isFinite(v)) return "—";
  const abs = Math.abs(v);
  if (abs >= 1000) return v.toFixed(0);
  if (abs >= 10) return v.toFixed(2);
  return v.toFixed(3);
}
