/**
 * Headless export of a Pine **strategy** into a time-aligned signal artifact the
 * production backtest can consume without re-implementing Pine.
 *
 * Why a file of its own (not folded into indicatorLang.ts): the mount layer is
 * browser-bound (it registers a KLineChart indicator and fetches sub-bars over
 * the network). The export path below is pure — it only needs the Pine engine
 * (`compilePine`, which takes bars + options and returns a result) — so the
 * same semantics run in the browser, in a vitest harness, or in a headless Node
 * producer. Single semantic source stays the TypeScript engine; the backend only
 * ever reads the emitted series, never the Pine source.
 *
 * What is exported is the strategy's **held direction per bar** (`+1/-1/0`,
 * `PineReport.positions`), not an equity curve: the backend re-executes fills
 * under its own market rules (T+1, price limits, next-bar-open), so the bridge
 * hands over *what the strategy wanted to hold*, and the backend decides *how it
 * got filled*. The lookup engine forward-shifts this held series by one bar so
 * the backend's fixed `shift(1)` reproduces the same entry/exit timing.
 *
 * Timestamps are the chart's own epoch-ms (whatever convention the bars came in
 * with). `interval` + `wallClockZone` tell the backend how to turn them back
 * into the loader's timezone-naive index: daily labels round-trip by identity,
 * intraday wall-clocks need the market zone localised then stripped.
 */

import type { KLineData } from "klinecharts";
import { compilePine, type PineArtifact } from "./pineScript";
import type { RunOptions } from "./pineRuntime";

/** Bumped whenever the on-disk shape changes, so a stale artifact is rejected. */
export const PINE_SIGNAL_SCHEMA = 1;

export interface PineSignalArtifact {
  schema: number;
  /** Which engine produced it — the backend contract is engine-agnostic but this aids debugging. */
  engine: "pine-ts";
  /** Symbol the signals are for, in the loader's own spelling (e.g. `700.HK`). */
  symbol: string;
  /** Backtest interval, matching the loader's `_INTERVAL_MAP` key (e.g. `1D`, `1m`). */
  interval: string;
  /**
   * IANA zone the intraday wall-clock is written in (`Asia/Shanghai`,
   * `America/New_York`), or `null` for daily/weekly/monthly bars whose timestamp
   * is a trading-day label. Mirrors `market_routes._MINUTE_WALL_CLOCK_ZONE`.
   */
  wallClockZone: string | null;
  /** Epoch-ms per bar, index-aligned with `signals`. */
  timestamps: number[];
  /** Held direction per bar: `+1` long, `-1` short, `0` flat. */
  signals: number[];
  meta: {
    scriptKind: string;
    title: string;
    /** Bars the script actually walked (may be < timestamps for an aborted run). */
    bars: number;
    /** Sub-timeframe resolutions the script consumed via `request.security_lower_tf`, if any. */
    lowerTfMs?: number[];
    netPnlPct?: number;
    returnPct?: number;
    /** Non-empty when the run aborted or the engine warned — never silently dropped. */
    notes: string[];
    generatedAt: string;
  };
}

export interface PineSignalFailure {
  error: string;
}

/** How to label the emitted artifact; the bars themselves carry the timestamps. */
export interface SignalExportOptions {
  symbol: string;
  interval: string;
  wallClockZone?: string | null;
}

function isFailure(x: PineSignalArtifact | PineSignalFailure): x is PineSignalFailure {
  return "error" in x;
}

/**
 * Turn a compiled strategy artifact into the export artifact. Fails honestly
 * (never emits an empty/misleading file) when the script is not a `strategy` or
 * walked no bars. `timestamps` are truncated to the walked length so the two
 * arrays stay index-aligned even on an early abort.
 */
export function signalsFromArtifact(
  artifact: PineArtifact,
  bars: KLineData[],
  opts: SignalExportOptions,
): PineSignalArtifact | PineSignalFailure {
  const rep = artifact.result.report;
  if (!rep) {
    return { error: "只有 strategy 脚本能导出持仓信号（当前脚本未声明 strategy()）" };
  }
  const positions = rep.positions ?? [];
  if (positions.length === 0) {
    return { error: "策略没有产生任何逐根持仓信号" };
  }
  const timestamps = bars.slice(0, positions.length).map((b) => b.timestamp ?? 0);
  const notes = artifact.abort
    ? [artifact.abort, ...artifact.result.warnings]
    : artifact.result.warnings.slice();
  return {
    schema: PINE_SIGNAL_SCHEMA,
    engine: "pine-ts",
    symbol: opts.symbol,
    interval: opts.interval,
    wallClockZone: opts.wallClockZone ?? null,
    timestamps,
    signals: positions.slice(),
    meta: {
      scriptKind: artifact.result.scriptKind,
      title: artifact.result.title,
      bars: artifact.result.bars,
      lowerTfMs: artifact.result.lowerTfMs,
      netPnlPct: rep.netPnlPct,
      returnPct: rep.returnPct,
      notes,
      generatedAt: new Date().toISOString(),
    },
  };
}

/**
 * Headless producer: compile + run a Pine strategy over `bars` (optionally with
 * `lowerBars` so `request.security_lower_tf` is served, exactly as the browser
 * mount layer injects them) and emit the export artifact in one call. Pure and
 * synchronous — safe to drive from a Node entry or a test with pre-fetched bars.
 */
export function buildPineSignal(
  code: string,
  bars: KLineData[],
  opts: RunOptions & SignalExportOptions,
): { artifact: PineArtifact; signal: PineSignalArtifact } | PineSignalFailure {
  const compiled = compilePine(code, bars, opts);
  if ("error" in compiled) return { error: compiled.error ?? "Pine 脚本编译失败" };
  const signal = signalsFromArtifact(compiled, bars, opts);
  if (isFailure(signal)) return signal;
  return { artifact: compiled, signal };
}
