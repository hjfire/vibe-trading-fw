import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { Chart, Nullable } from "klinecharts";
import { cn } from "@/lib/utils";
import { detectDialect } from "@/lib/indicatorLang";
import { compilePine } from "@/lib/pineScript";
import type { PineAlertSeries } from "@/lib/pineTypes";
import { BACKEND_INTERVALS, translatePineAlerts, type PineAlertPlan } from "@/lib/pineAlertRules";
import {
  ALERT_SEVERITIES,
  alertsApi,
  describeCondition,
  type AlertCondition,
  type AlertRuleRow,
  type AlertSeverity,
  type AlertTargetsResponse,
} from "@/lib/alertsApi";
import type { IntervalKey } from "@/lib/marketApi";
import { parseParams, type Draft } from "./types";

/**
 * Script alerts tab (local custom ⑪, the Pine alert bridge).
 *
 * Two independent readings of the same `alertcondition()` sit side by side: what
 * the static translator maps the condition to in the backend's closed grammar,
 * and what the interpreter actually decided bar by bar on these very candles.
 * A row is only creatable when the first exists; the second is the evidence the
 * translated rule means what the script says. Anything the grammar cannot hold
 * is refused with the sub-expression named — never narrowed.
 */

interface AlertsTabProps {
  draft: Draft;
  getChart: () => Nullable<Chart>;
  /** The chart's symbol in loader spelling (e.g. 600519.SH); the rule's symbol. */
  symbol: string;
  /** The chart's interval; rules on 1W/1M cannot be polled by the backend. */
  interval: IntervalKey;
  /** The chart's price-adjustment setting; the rule must read the same `close`. */
  adjust: string;
}

const SETTINGS_KEY = "pro-chart.pineAlerts.v1";
const RULE_PREFIX = "pine_";
/** Same budget as the editor's probe: a preview must never stall typing. */
const PROBE_BUDGET = 6e6;

interface AlertsSettings {
  forBars: number;
  severity: AlertSeverity;
  sendResolved: boolean;
  targets: string[];
}

const DEFAULT_SETTINGS: AlertsSettings = {
  forBars: 1,
  severity: "info",
  sendResolved: true,
  targets: [],
};

function readSettings(): AlertsSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const obj = JSON.parse(raw) as Partial<AlertsSettings>;
    const forBars = Number.isFinite(obj.forBars) ? Math.floor(Number(obj.forBars)) : 1;
    return {
      forBars: Math.min(1000, Math.max(1, forBars)),
      severity: ALERT_SEVERITIES.includes(obj.severity as AlertSeverity)
        ? (obj.severity as AlertSeverity)
        : "info",
      sendResolved: typeof obj.sendResolved === "boolean" ? obj.sendResolved : true,
      targets: Array.isArray(obj.targets) ? obj.targets.filter((t) => typeof t === "string") : [],
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

/** The backend compares `condition` fields field by field; so do we. */
function sameCondition(a: Partial<AlertCondition> | undefined, b: AlertCondition | undefined) {
  if (!a || !b) return false;
  const norm = (v: unknown) => (v === undefined || v === null ? "" : String(v));
  return (
    norm(a.op) === norm(b.op) &&
    norm(a.lhs) === norm(b.lhs) &&
    norm(a.rhs) === norm(b.rhs) &&
    norm(a.value) === norm(b.value)
  );
}

/** Bar indices the interpreter flagged, spelled out up to eight. */
function hitText(hits: boolean[]): string {
  const idx: number[] = [];
  for (let i = 0; i < hits.length; i++) if (hits[i]) idx.push(i);
  if (!idx.length) return "引擎命中 0 根";
  const shown = idx.slice(0, 8).join(", ");
  return `引擎命中 ${idx.length} 根：${shown}${idx.length > 8 ? ` …共 ${idx.length} 根` : ""}`;
}

/** One line per alert site: keyed on the source line both readers report. */
interface Row {
  line: number;
  plan: PineAlertPlan | null;
  series: PineAlertSeries | null;
}

function pairRows(plans: PineAlertPlan[], series: PineAlertSeries[]): Row[] {
  const left = new Map(series.map((s) => [s.line, s]));
  const rows: Row[] = plans.map((p) => ({ line: p.line, plan: p, series: left.get(p.line) ?? null }));
  for (const s of series) {
    if (!plans.some((p) => p.line === s.line)) rows.push({ line: s.line, plan: null, series: s });
  }
  return rows.sort((a, b) => a.line - b.line);
}

const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  info: "提示",
  warning: "警告",
  critical: "紧急",
};

/**
 * Which settings-row values the stored rule does not carry yet. Without this the
 * row would read 「已建，条件一致」 after the 连续满足根数 spinner moved, while the
 * backend still debounced with the old number — the panel would be claiming a
 * state only `send()` can change.
 */
function settingsDiff(rule: AlertRuleRow, s: AlertsSettings): string[] {
  const out: string[] = [];
  if (rule.for_bars !== s.forBars)
    out.push(`连续满足根数：后端 ${rule.for_bars} → 这里 ${s.forBars}`);
  if (rule.severity !== s.severity)
    out.push(`级别：后端 ${SEVERITY_LABEL[rule.severity]} → 这里 ${SEVERITY_LABEL[s.severity]}`);
  if (rule.send_resolved !== s.sendResolved)
    out.push(`恢复通知：后端 ${rule.send_resolved ? "开" : "关"} → 这里 ${s.sendResolved ? "开" : "关"}`);
  if (rule.targets.join("\u0000") !== s.targets.join("\u0000"))
    out.push(`推送目标：后端 ${rule.targets.length} 个 → 这里 ${s.targets.length} 个`);
  return out;
}

export default function AlertsTab({ draft, getChart, symbol, interval, adjust }: AlertsTabProps) {
  const [settings, setSettings] = useState<AlertsSettings>(readSettings);
  const [plans, setPlans] = useState<PineAlertPlan[]>([]);
  const [series, setSeries] = useState<PineAlertSeries[]>([]);
  const [runError, setRunError] = useState("");
  const [rules, setRules] = useState<AlertRuleRow[]>([]);
  const [destinations, setDestinations] = useState<AlertTargetsResponse>({ targets: [], channels: [] });
  const [pending, setPending] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; bad: boolean } | null>(null);
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  const dialect = detectDialect(draft.code);
  const intervalOk = (BACKEND_INTERVALS as readonly string[]).includes(interval);

  useEffect(() => {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      /* a convenience preset; quota failures are not fatal */
    }
  }, [settings]);

  const refresh = useCallback(async () => {
    try {
      const [rows, dest] = await Promise.all([
        alertsApi.listRules({ kind: "market", limit: 500 }),
        alertsApi.listTargets(),
      ]);
      setRules(Array.isArray(rows) ? rows : []);
      setDestinations(dest ?? { targets: [], channels: [] });
    } catch (e) {
      setNotice({ text: `读取后端规则失败：${e instanceof Error ? e.message : String(e)}`, bad: true });
    }
  }, []);

  useEffect(() => {
    if (dialect !== "pine") return;
    void refresh();
  }, [dialect, refresh]);

  // One run per source change: the interpreter answers "does this fire, and
  // where", the translator answers "can the backend be told at all". `getChart`
  // is a fresh closure on every host render, so it is held in a ref and kept out
  // of the deps — otherwise every keystroke would re-run the script.
  const getChartRef = useRef(getChart);
  getChartRef.current = getChart;
  const paramsRef = useRef(draft.paramsText);
  paramsRef.current = draft.paramsText;
  const paramsKey = draft.paramsText;
  useEffect(() => {
    if (dialect !== "pine") {
      setPlans([]);
      setSeries([]);
      return;
    }
    const timer = setTimeout(() => {
      const bars = getChartRef.current()?.getDataList() ?? [];
      if (!bars.length) {
        setPlans([]);
        setSeries([]);
        setRunError("");
        return;
      }
      const out = compilePine(draft.code, bars, {
        params: parseParams(paramsRef.current),
        opLimit: PROBE_BUDGET,
      });
      if ("error" in out || out.abort) {
        setSeries([]);
        setRunError(("error" in out ? out.error : out.abort) || "脚本没有跑完");
      } else {
        setSeries(out.result.alerts ?? []);
        setRunError("");
      }
      setPlans(translatePineAlerts(draft.code, { symbol, interval, adjust }));
      setPending(null);
    }, 450);
    return () => clearTimeout(timer);
  }, [dialect, draft.code, paramsKey, symbol, interval, adjust]);

  const rows = useMemo(() => pairRows(plans, series), [plans, series]);
  const liveIds = new Set(plans.map((p) => p.draft?.id).filter(Boolean) as string[]);
  const orphans = rules.filter((r) => r.id.startsWith(RULE_PREFIX) && r.symbol === symbol && !liveIds.has(r.id));

  if (dialect !== "pine") return null;

  const set = <K extends keyof AlertsSettings>(key: K, value: AlertsSettings[K]) =>
    setSettings((s) => ({ ...s, [key]: value }));

  const send = async (plan: PineAlertPlan) => {
    const base = plan.draft;
    if (!base) return;
    const body = {
      ...base,
      for_bars: settingsRef.current.forBars,
      severity: settingsRef.current.severity,
      send_resolved: settingsRef.current.sendResolved,
      targets: settingsRef.current.targets,
    };
    setBusy(body.id);
    try {
      const row = await alertsApi.createRule(body);
      // The panel cannot see VIBE_TRADING_ENABLE_SCHEDULER, and with it off the
      // poller loop never starts — so this must not promise a cadence it cannot
      // verify. Measured live: a created rule sat with last_checked_at=null until
      // something ticked the engine by hand.
      setNotice({
        text: `已写入后端规则「${body.title}」(${row?.id ?? body.id})；是否自动轮询由后端调度开关决定，未开启时可在告警页手动评估。`,
        bad: false,
      });
      setPending(null);
      await refresh();
    } catch (e) {
      setNotice({ text: `创建失败：${e instanceof Error ? e.message : String(e)}`, bad: true });
    } finally {
      setBusy(null);
    }
  };

  const removeOrphan = async (id: string) => {
    setBusy(`del:${id}`);
    try {
      await alertsApi.deleteRule(id);
      setNotice({ text: `已删除后端规则 ${id}`, bad: false });
      await refresh();
    } catch (e) {
      setNotice({ text: `删除失败：${e instanceof Error ? e.message : String(e)}`, bad: true });
    } finally {
      setBusy(null);
    }
  };

  const fieldClass =
    "mt-0.5 h-8 w-full rounded border bg-background px-2 text-xs outline-none focus:border-primary";

  return (
    <div className="space-y-3 text-sm">
      <div className="grid grid-cols-2 gap-2">
        <label className="block">
          <span className="text-[11px] text-muted-foreground">连续满足根数</span>
          <input
            type="number"
            min={1}
            max={1000}
            value={settings.forBars}
            onChange={(e) => {
              const n = Math.floor(Number(e.target.value));
              set("forBars", Number.isFinite(n) ? Math.min(1000, Math.max(1, n)) : 1);
            }}
            className={cn(fieldClass, "font-mono")}
          />
        </label>
        <label className="block">
          <span className="text-[11px] text-muted-foreground">级别</span>
          <select
            value={settings.severity}
            onChange={(e) => set("severity", e.target.value as AlertSeverity)}
            className={fieldClass}
          >
            {ALERT_SEVERITIES.map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABEL[s]}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div>
        <span className="text-[11px] text-muted-foreground">推送目标（可多选）</span>
        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1">
          {destinations.targets.map((t) => (
            <label key={t.ref} className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                className="h-3 w-3"
                checked={settings.targets.includes(t.ref)}
                onChange={(e) =>
                  set(
                    "targets",
                    e.target.checked
                      ? [...settings.targets, t.ref]
                      : settings.targets.filter((x) => x !== t.ref),
                  )
                }
              />
              {t.label} · {t.channel}
            </label>
          ))}
          {!destinations.targets.length && (
            <span className="text-[11px] text-muted-foreground">
              后端还没有注册目标（已启用通道：
              {destinations.channels.length ? destinations.channels.join(" / ") : "无"}），到告警页添加。
            </span>
          )}
        </div>
      </div>

      <label className="flex items-center gap-2 text-xs">
        <input
          type="checkbox"
          className="h-3 w-3"
          checked={settings.sendResolved}
          onChange={(e) => set("sendResolved", e.target.checked)}
        />
        条件回落时发送恢复通知
      </label>

      {!settings.targets.length && (
        <div className="rounded border border-amber-500/40 bg-amber-500/5 px-2 py-1.5 text-[11px] text-amber-600">
          未选择推送目标，规则只会记录不会通知
          <a href="/alerts" className="ml-1 underline">
            去告警页配置
          </a>
        </div>
      )}

      {!intervalOk && (
        <p className="text-[11px] leading-4 text-muted-foreground">
          图表当前周期后端不轮询，所以这一页没有任何可创建的规则；可用周期写在下面每条原因里。
        </p>
      )}

      {runError && (
        <p className="rounded border border-red-500/40 px-2 py-1.5 text-[11px] leading-4 text-red-500">
          脚本没能跑完：{runError}
        </p>
      )}

      {notice && (
        <p
          className={cn(
            "rounded border px-2 py-1.5 text-[11px] leading-4",
            notice.bad ? "border-red-500/40 text-red-500" : "border-primary/30 text-muted-foreground",
          )}
        >
          {notice.text}
        </p>
      )}

      {!rows.length && !runError && (
        <p className="text-[11px] leading-4 text-muted-foreground">
          这段脚本里没有 alertcondition() 或 alert()。写一条告警条件，这里才会列出可建的规则。
        </p>
      )}

      {rows.map((row) => {
        const plan = row.plan;
        const native = plan?.status === "native" ? plan : null;
        const existing = native ? rules.find((r) => r.id === native.draft?.id) : undefined;
        const condSame = !!existing && sameCondition(existing.condition, native?.condition);
        const diffs = existing ? settingsDiff(existing, settings) : [];
        const inSync = condSame && !diffs.length;
        const title = plan?.title || row.series?.title || `${plan?.fn ?? "alertcondition"}@L${row.line}`;
        return (
          <div key={`${row.line}:${title}`} className="space-y-1 rounded border px-2 py-1.5">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium">{title}</span>
              <span
                className={cn(
                  "shrink-0 rounded-full border px-1.5 text-[10px]",
                  native
                    ? "border-emerald-500/40 text-emerald-600"
                    : "border-amber-500/40 text-amber-600",
                )}
              >
                {plan ? (native ? "可译" : "不可译") : "未判定"}
              </span>
              <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                第 {row.line} 行
              </span>
            </div>

            {native && (
              <div className="font-mono text-[11px] text-foreground/90">
                {describeCondition(native.condition)}
              </div>
            )}
            {row.series && (
              <div className="text-[11px] text-muted-foreground">{hitText(row.series.hits)}</div>
            )}
            {plan?.reason && (
              <div className="text-[11px] leading-4 text-amber-600">{plan.reason}</div>
            )}
            {plan?.notes.map((n) => (
              <div key={n} className="text-[11px] leading-4 text-muted-foreground">
                说明：{n}
              </div>
            ))}
            {plan?.message && (
              <div className="text-[11px] leading-4 text-muted-foreground">
                提醒内容（不进后端，后端自己写文案）：{plan.message}
              </div>
            )}

            {native && (
              <div className="flex items-center gap-1.5">
                {inSync ? (
                  <button
                    type="button"
                    disabled
                    className="rounded border px-2 py-1 text-[11px] text-muted-foreground"
                  >
                    已建，条件一致
                  </button>
                ) : (
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => (existing ? setPending(native.draft?.id ?? null) : void send(native))}
                    className="rounded border border-primary/40 bg-primary/10 px-2 py-1 text-[11px] font-semibold text-primary disabled:opacity-50"
                  >
                    {existing ? "更新" : "创建"}
                  </button>
                )}
              </div>
            )}

            {pending && native && pending === native.draft?.id && (
              <div className="rounded border border-red-500/40 bg-red-500/5 px-2 py-1.5 text-[11px] leading-4 text-red-500">
                {condSame
                  ? `后端规则的条件一致，只有这一行的参数与它不同：${diffs.join("；")}。覆盖会按这里的值改写。`
                  : `后端这条规则的条件已被改成 ${describeCondition(existing?.condition)}，与本脚本译出的不同。覆盖会丢掉那个改动。`}
                <div className="mt-1 flex gap-1.5">
                  <button
                    type="button"
                    disabled={!!busy}
                    onClick={() => void send(native)}
                    className="rounded border border-red-500/50 px-2 py-0.5 font-semibold disabled:opacity-50"
                  >
                    确认覆盖
                  </button>
                  <button
                    type="button"
                    onClick={() => setPending(null)}
                    className="rounded border px-2 py-0.5 text-muted-foreground"
                  >
                    取消
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      {!!orphans.length && (
        <div className="space-y-1">
          <p className="text-[11px] text-muted-foreground">
            本标的上由脚本建出、但当前脚本已不再包含的后端规则：
          </p>
          {orphans.map((r) => (
            <div key={r.id} className="flex items-center gap-2 rounded border px-2 py-1 text-[11px]">
              <span className="truncate font-medium">{r.title || "（无标题）"}</span>
              <span className="shrink-0 font-mono text-muted-foreground">{r.id}</span>
              <button
                type="button"
                disabled={busy === `del:${r.id}`}
                onClick={() => void removeOrphan(r.id)}
                className="ml-auto shrink-0 rounded border border-red-500/40 px-2 py-0.5 text-red-500 disabled:opacity-50"
              >
                删除
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
