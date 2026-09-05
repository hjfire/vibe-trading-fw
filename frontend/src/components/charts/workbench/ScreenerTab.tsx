import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Chart, Nullable } from "klinecharts";
import { cn } from "@/lib/utils";
import { INTERVALS, type IntervalKey } from "@/lib/marketApi";
import {
  SCREENER_RULES,
  SCREEN_BARS,
  formatScreenValue,
  ruleInfo,
  screenPool,
  scriptSeries,
  sortRows,
  type BarLoader,
  type ScreenerRule,
  type ScreenRow,
} from "@/lib/screener";
import type { UserIndicator } from "@/lib/indicatorStore";
import { parseParams, type Draft } from "./types";

/**
 * Condition screener tab (local custom ⑪): one script, a whole pool of symbols.
 *
 * The condition is any workbench script — a saved indicator, the library entry
 * just applied, or the draft still being typed in the editor — so screening
 * asks of a symbol exactly what the chart asks of the one on screen. Nothing
 * is mounted here; the scripts are evaluated off-screen against real bars.
 */

interface ScreenerTabProps {
  /** The host watchlist, which is the default pool. */
  symbols: string[];
  /** Saved scripts; usable as conditions without being mounted. */
  items: UserIndicator[];
  /** The live editor draft, offered as a candidate too. */
  draft: Draft;
  /** Current chart, used to pre-flight the condition against real bars. */
  getChart: () => Nullable<Chart>;
  /** Open a result on the chart. */
  onPickSymbol: (symbol: string) => void;
  /** Data source seam (tests screen without a network). */
  loadBars?: BarLoader;
}

const SETTINGS_KEY = "pro-chart.screener.v1";

interface ScreenerSettings {
  condition: string;
  rule: ScreenerRule;
  threshold: number;
  interval: IntervalKey;
  pool: "watch" | "custom";
  custom: string;
  hitsOnly: boolean;
}

const DEFAULT_SETTINGS: ScreenerSettings = {
  condition: "",
  rule: "crossUp",
  threshold: 0,
  interval: "1D",
  pool: "watch",
  custom: "",
  hitsOnly: false,
};

function readSettings(): ScreenerSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const obj = JSON.parse(raw) as Partial<ScreenerSettings>;
    const rule = SCREENER_RULES.some((r) => r.key === obj.rule) ? (obj.rule as ScreenerRule) : DEFAULT_SETTINGS.rule;
    const interval = INTERVALS.some((i) => i.key === obj.interval) ? (obj.interval as IntervalKey) : "1D";
    return {
      ...DEFAULT_SETTINGS,
      ...obj,
      condition: typeof obj.condition === "string" ? obj.condition : "",
      rule,
      interval,
      threshold: Number.isFinite(obj.threshold) ? Number(obj.threshold) : 0,
      custom: typeof obj.custom === "string" ? obj.custom : "",
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** Split a pasted pool: commas, spaces or one code per line all count. */
export function parsePool(text: string): string[] {
  return [...new Set(text.split(/[,，;\s]+/).map((s) => s.trim().toUpperCase()).filter(Boolean))];
}

export default function ScreenerTab({ symbols, items, draft, getChart, onPickSymbol, loadBars }: ScreenerTabProps) {
  const [settings, setSettings] = useState<ScreenerSettings>(readSettings);
  const [rows, setRows] = useState<ScreenRow[]>([]);
  const [running, setRunning] = useState(false);
  const [message, setMessage] = useState("");
  const [check, setCheck] = useState<{ names: string[]; error: string } | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* a convenience preset; quota failures are not fatal */
    }
  }, [settings]);

  // A scan in flight must not outlive the tab it started in.
  useEffect(() => () => abortRef.current?.abort(), []);

  const set = <K extends keyof ScreenerSettings>(key: K, value: ScreenerSettings[K]) =>
    setSettings((s) => ({ ...s, [key]: value }));

  /** Saved scripts first, then the editor draft — the draft is never installed. */
  const conditions = useMemo(() => {
    const list = items.map((it) => ({
      key: it.id,
      label: it.label,
      code: it.code,
      params: it.params,
      saved: true,
    }));
    if (draft.code.trim()) {
      list.unshift({
        key: "__draft",
        label: `${draft.label.trim() || "未命名脚本"}（编辑器草稿）`,
        code: draft.code,
        params: parseParams(draft.paramsText),
        saved: false,
      });
    }
    return list;
  }, [items, draft]);

  const chosen =
    conditions.find((c) => c.key === settings.condition) ?? conditions[0] ?? null;
  const info = ruleInfo(settings.rule);

  // Pre-flight the condition on the bars already on screen: a rule that needs
  // two output lines is unwinnable with a one-line script, and finding that
  // out after six fetched symbols is a wasted scan. `getChart` is a fresh
  // closure on every host render, so it is held in a ref and kept out of the
  // deps — otherwise this would recompile the script on each keystroke.
  const getChartRef = useRef(getChart);
  getChartRef.current = getChart;
  const chosenCode = chosen?.code ?? "";
  const paramsKey = (chosen?.params ?? []).join(",");
  useEffect(() => {
    if (!chosenCode.trim()) {
      setCheck(null);
      return;
    }
    const bars = getChartRef.current()?.getDataList() ?? [];
    if (bars.length < 2) {
      setCheck(null);
      return;
    }
    const out = scriptSeries(chosenCode, bars.slice(-SCREEN_BARS), parseParams(paramsKey));
    setCheck(out.error ? { names: [], error: out.error } : { names: out.series.map((s) => s.name), error: "" });
    // Keyed on the source text and the parameters, which is all the pre-flight reads.
  }, [chosenCode, paramsKey]);

  const pool = settings.pool === "watch" ? symbols : parsePool(settings.custom);
  const tooFewLines = check !== null && !check.error && check.names.length < info.arity;

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setRunning(false);
  }, []);

  const run = async () => {
    if (!chosen) {
      setMessage("还没有可用的条件脚本：先在编辑器里写一段，或到「脚本库」应用一个指标。");
      return;
    }
    if (tooFewLines) {
      setMessage(`这个判定需要 ${info.arity} 条输出线，当前脚本只输出了 ${check?.names.length ?? 0} 条。`);
      return;
    }
    if (pool.length === 0) {
      setMessage("标的池是空的：自选池加几只，或切到自定义粘贴代码。");
      return;
    }
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setRows([]);
    setMessage("");
    setRunning(true);
    let failed = 0;
    try {
      const done = await screenPool({
        symbols: pool,
        code: chosen.code,
        params: chosen.params,
        rule: settings.rule,
        threshold: settings.threshold,
        interval: settings.interval,
        signal: ac.signal,
        loadBars,
        onRow: (row) => {
          if (row.reason.startsWith("行情获取失败")) failed++;
          setRows((prev) => sortRows([...prev, row]));
        },
      });
      if (!ac.signal.aborted) {
        const hits = done.filter((r) => r.hit).length;
        setMessage(
          `扫描完成：${done.length} 只，命中 ${hits} 只${failed ? `，${failed} 只取不到行情` : ""}。`,
        );
      } else {
        setMessage(`已停止，完成 ${done.length} 只。`);
      }
    } catch (e) {
      setMessage(`扫描中断：${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (abortRef.current === ac) {
        abortRef.current = null;
        setRunning(false);
      }
    }
  };

  const visible = settings.hitsOnly ? rows.filter((r) => r.hit) : rows;
  const hits = rows.filter((r) => r.hit).length;

  return (
    <div className="space-y-3 text-sm">
      <label className="block">
        <span className="text-[11px] text-muted-foreground">条件脚本（与图上画的是同一份代码）</span>
        <select
          value={chosen?.key ?? ""}
          onChange={(e) => set("condition", e.target.value)}
          className="mt-0.5 h-8 w-full rounded border bg-background px-2 text-xs outline-none focus:border-primary"
        >
          {conditions.length === 0 && <option value="">（还没有脚本）</option>}
          {conditions.map((c) => (
            <option key={c.key} value={c.key}>
              {c.label}
            </option>
          ))}
        </select>
      </label>

      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="text-[11px] text-muted-foreground">判定</span>
          <select
            value={settings.rule}
            onChange={(e) => set("rule", e.target.value as ScreenerRule)}
            className="mt-0.5 h-8 w-full rounded border bg-background px-2 text-xs outline-none focus:border-primary"
          >
            {SCREENER_RULES.map((r) => (
              <option key={r.key} value={r.key}>
                {r.label}
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="text-[11px] text-muted-foreground">周期</span>
          <select
            value={settings.interval}
            onChange={(e) => set("interval", e.target.value as IntervalKey)}
            className="mt-0.5 h-8 w-full rounded border bg-background px-2 text-xs outline-none focus:border-primary"
          >
            {INTERVALS.map((i) => (
              <option key={i.key} value={i.key}>
                {i.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {info.usesThreshold && (
        <label className="block">
          <span className="text-[11px] text-muted-foreground">阈值</span>
          <input
            type="number"
            value={settings.threshold}
            onChange={(e) => set("threshold", Number.isFinite(Number(e.target.value)) ? Number(e.target.value) : 0)}
            className="mt-0.5 h-8 w-full rounded border bg-background px-2 font-mono text-xs outline-none focus:border-primary"
          />
        </label>
      )}

      <p className="text-[11px] leading-4 text-muted-foreground">
        条件可以是已保存的脚本，也可以是编辑器里还没保存的草稿（先在「脚本库」点「编辑」载入一条也一样）。扫描不会改动图表，也不会新增指标。
      </p>

      <div className="flex flex-wrap gap-1.5 text-[11px]">
        <button
          type="button"
          onClick={() => set("pool", "watch")}
          className={settings.pool === "watch" ? "rounded-full border border-primary bg-primary/10 px-2 py-0.5 font-semibold" : "rounded-full border px-2 py-0.5 hover:bg-muted"}
        >
          自选池 {symbols.length}
        </button>
        <button
          type="button"
          onClick={() => set("pool", "custom")}
          className={settings.pool === "custom" ? "rounded-full border border-primary bg-primary/10 px-2 py-0.5 font-semibold" : "rounded-full border px-2 py-0.5 hover:bg-muted"}
        >
          自定义 {settings.pool === "custom" ? parsePool(settings.custom).length : 0}
        </button>
        <label className="ml-auto flex items-center gap-1 text-muted-foreground">
          <input
            type="checkbox"
            checked={settings.hitsOnly}
            onChange={(e) => set("hitsOnly", e.target.checked)}
            className="h-3 w-3"
          />
          仅看命中
        </label>
      </div>

      {settings.pool === "custom" && (
        <textarea
          value={settings.custom}
          onChange={(e) => set("custom", e.target.value)}
          rows={3}
          placeholder="粘贴代码，逗号或换行分隔，如 600519.SH, 000001.SZ"
          className="w-full rounded border bg-background p-2 font-mono text-[11px] leading-4 outline-none focus:border-primary"
        />
      )}

      {/* What the script actually emits, read off the bars already on screen. */}
      {check && (
        <p
          className={cn(
            "text-[11px] leading-4",
            check.error
              ? "text-amber-600 dark:text-amber-500"
              : tooFewLines
                ? "text-red-500"
                : "text-muted-foreground",
          )}
        >
          {check.error
            ? `预检失败：${check.error}`
            : `预检（当前标的）：输出 ${check.names.length} 条线—${check.names.slice(0, 4).join("、")}${
                check.names.length > 4 ? " …" : ""
              }${tooFewLines ? `；本判定需要 ${info.arity} 条，换个脚本或改判定` : ""}`}
        </p>
      )}

      <div className="flex items-center gap-2">
        {running ? (
          <button type="button" onClick={stop} className="rounded border px-2.5 py-1 text-xs hover:bg-muted">
            停止
          </button>
        ) : (
          <button
            type="button"
            disabled={tooFewLines}
            title={tooFewLines ? "输出线不够，这个判定不会命中" : undefined}
            onClick={() => void run()}
            className={
              tooFewLines
                ? "cursor-not-allowed rounded border px-2.5 py-1 text-xs text-muted-foreground opacity-50"
                : "rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
            }
          >
            开始扫描 {pool.length} 只
          </button>
        )}
        <span className="text-[11px] text-muted-foreground">
          {running ? `已完成 ${rows.length}/${pool.length}` : `每只取 ${SCREEN_BARS} 根K线，最多 4 路并发`}
        </span>
      </div>

      {message && <p className="text-[11px] leading-4 text-muted-foreground">{message}</p>}
      <p className="text-[11px] leading-4 text-muted-foreground" title={info.hint}>
        {info.hint}
        {info.arity === 2 ? "；脚本需要两条输出线。" : "。"} 分钟线只有 A股提供，跨市场请用日线。
      </p>

      {rows.length === 0 && !running && (
        <p className="text-xs text-muted-foreground">扫描结果会显示在这里，点代码可把图表切过去核对。</p>
      )}

      {visible.length > 0 && (
        <div className="overflow-hidden rounded border">
          <table className="w-full text-[11px]">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-1.5 py-1 text-left font-normal">代码</th>
                <th className="px-1.5 py-1 text-right font-normal">收盘</th>
                <th className="px-1.5 py-1 text-right font-normal">涨跌</th>
                <th className="px-1.5 py-1 text-right font-normal">条件值</th>
                <th className="px-1.5 py-1 text-left font-normal">判定</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr key={r.symbol} className="border-t">
                  <td className="px-1.5 py-1">
                    <button
                      type="button"
                      title="切换图表标的（工作台保持打开，点背景即可关窗看图）"
                      onClick={() => onPickSymbol(r.symbol)}
                      className="font-mono text-foreground underline-offset-2 hover:underline"
                    >
                      {r.symbol}
                    </button>
                    {r.hit && <span className="ml-1 rounded bg-primary/10 px-1 text-[10px] text-primary">命中</span>}
                  </td>
                  <td className="px-1.5 py-1 text-right font-mono">{formatScreenValue(r.close)}</td>
                  <td
                    className={`px-1.5 py-1 text-right font-mono ${
                      Number.isFinite(r.changePct) && r.changePct > 0
                        ? "text-red-500"
                        : Number.isFinite(r.changePct) && r.changePct < 0
                          ? "text-emerald-500"
                          : ""
                    }`}
                  >
                    {Number.isFinite(r.changePct) ? `${r.changePct >= 0 ? "+" : ""}${r.changePct.toFixed(2)}%` : "—"}
                  </td>
                  <td
                    className="max-w-[9rem] truncate px-1.5 py-1 text-right font-mono"
                    title={r.series.map((s) => `${s.name} ${formatScreenValue(s.last)}`).join(" / ")}
                  >
                    {r.series.length ? formatScreenValue(r.series[0].last) : "—"}
                  </td>
                  <td className="px-1.5 py-1 text-muted-foreground">{r.hit ? info.label : r.reason || "未命中"}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {settings.hitsOnly && (
            <p className="border-t px-1.5 py-1 text-[10px] text-muted-foreground">
              命中 {hits} 只 / 已扫描 {rows.length} 只
            </p>
          )}
        </div>
      )}
    </div>
  );
}
