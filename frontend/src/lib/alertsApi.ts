import { authHeaders } from "@/lib/apiAuth";

/**
 * Thin client for the `/alerts` routes (local custom ㉑).
 *
 * Kept in its own module rather than added to the upstream `api.ts`, so daily
 * GitHub syncs never conflict — the same convention `marketApi.ts` set.
 *
 * The shapes below mirror `agent/src/api/alerts_routes.py` field for field. That
 * file is the contract; when it changes, change this one with it.
 */

export type AlertKind = "market" | "position" | "account" | "event";
export type AlertRuleState = "inactive" | "pending" | "firing" | "resolved" | "error";
export type AlertSeverity = "info" | "warning" | "critical";
export type AlertDeliveryStatus = "pending" | "sent" | "failed" | "skipped";

export const ALERT_KINDS: AlertKind[] = ["market", "position", "account", "event"];
export const ALERT_INTERVALS = ["1m", "5m", "15m", "30m", "60m", "1D"] as const;
export const ALERT_ADJUSTS = ["none", "qfq", "hfq"] as const;
export const ALERT_SEVERITIES: AlertSeverity[] = ["info", "warning", "critical"];

/** Operators from `CONDITION_OPS` in `src/alerts/models.py`. */
export const CONDITION_OPS = [
  "nonEmpty",
  "truthy",
  "gt",
  "lt",
  "crossUp",
  "crossDown",
  "rising",
  "falling",
] as const;

export type ConditionOp = (typeof CONDITION_OPS)[number];

/** Operators that compare against something; the rest are unary. */
export const RELATIONAL_OPS: readonly string[] = ["gt", "lt", "crossUp", "crossDown"];

/**
 * Series the engine can resolve, grouped the way the composer presents them.
 * The names are the screener's grammar (`rsi:14`), so a rule written here is
 * readable in a chat message and in the backtest screener without translation.
 */
export const SERIES_GROUPS: { group: string; items: string[] }[] = [
  { group: "bars", items: ["close", "open", "high", "low", "volume", "change_pct"] },
  {
    group: "indicators",
    items: [
      "sma:20",
      "ema:20",
      "rsi:14",
      "macd_line",
      "macd_signal",
      "macd_hist",
      "bb_upper",
      "bb_middle",
      "bb_lower",
    ],
  },
  { group: "position", items: ["pnl_pct", "position_value", "quantity", "cost_price", "market_price"] },
  { group: "account", items: ["equity_usd", "equity_cny", "drawdown_pct"] },
  { group: "event", items: ["event_value", "event_price", "event_change_pct"] },
];

/** Repeat-gap presets offered in the composer, in the backend's duration grammar. */
export const DURATION_PRESETS = ["", "1m", "5m", "15m", "30m", "1h", "4h", "12h", "24h"] as const;

export interface AlertCondition {
  op: string;
  lhs: string;
  rhs?: string | null;
  value?: number | null;
}

export interface AlertRuleRow {
  id: string;
  kind: AlertKind;
  title: string;
  symbol: string;
  interval: string;
  count: number;
  adjust: string;
  condition: Partial<AlertCondition>;
  for_bars: number;
  realert_ms: number;
  exponential_realert_ms: number;
  severity: AlertSeverity;
  send_resolved: boolean;
  session_only: boolean;
  poll_interval_ms: number;
  targets: string[];
  channel: string | null;
  target: string | null;
  enabled: boolean;
  state: AlertRuleState;
  pending_hits: number;
  fired_count: number;
  last_value: number | null;
  last_reason: string;
  last_error: string | null;
  last_checked_at: number | null;
  last_notify_ms: number | null;
  muted_until: number;
  created_at: number;
  updated_at: number;
  webhook_configured: boolean;
  webhook_url: string | null;
  /** Present only in the create response of an event rule; never readable again. */
  webhook_secret?: string;
}

export interface AlertIncidentRow {
  id: string;
  rule_id: string;
  rule_title: string;
  symbol: string;
  kind: AlertKind;
  state: AlertRuleState;
  severity: AlertSeverity;
  value: number | null;
  reason: string;
  at_ms: number;
  delivery_status: AlertDeliveryStatus | string;
  delivery_error: string | null;
  delivery_attempts: number;
  provider_message_id: string | null;
  delivery_updated_at: number | null;
}

export interface AlertTargetRef {
  ref: string;
  label: string;
  channel: string;
}

export interface AlertTargetsResponse {
  targets: AlertTargetRef[];
  channels: string[];
}

export interface AlertRunReport {
  status: string;
  evaluated: number;
  fired: number;
  resolved: number;
  suppressed: number;
  errors: number;
  skipped: number;
  delivered: number;
  incidents: string[];
}

export interface AlertDryRunReport {
  status: string;
  rule_id: string;
  hit: boolean;
  reason: string;
  note: string;
  error: string | null;
  value: number | null;
  bars: number;
  positions: number;
  market_open: boolean;
  would_notify: boolean;
  action: string;
  next_state: string;
}

export interface AlertTestSendReport {
  status: "sent" | "failed" | "no_target" | string;
  addresses: number;
  error?: string;
  provider_message_id?: string | null;
}

/** What the composer sends. Mirrors `AlertRuleRequest`. */
export interface AlertRuleDraft {
  id: string;
  kind: AlertKind;
  title?: string;
  symbol?: string;
  interval?: string;
  count?: number;
  adjust?: string;
  condition?: AlertCondition | null;
  for_bars?: number;
  realert?: string | null;
  exponential_realert?: string | null;
  severity?: AlertSeverity;
  send_resolved?: boolean;
  session_only?: boolean;
  poll_interval?: string | null;
  targets?: string[];
  channel?: string | null;
  target?: string | null;
  webhook_secret?: string | null;
  enabled?: boolean;
}

export class AlertApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "AlertApiError";
    this.status = status;
  }
}

/** Turn a failed response into the message the operator should see. */
async function errorFrom(res: Response): Promise<AlertApiError> {
  let detail = `HTTP ${res.status}`;
  try {
    const body = (await res.json()) as { detail?: unknown; message?: unknown; error?: unknown };
    detail = String(body.detail || body.message || body.error || detail);
  } catch {
    /* a body that is not JSON still has a status, which is enough */
  }
  if (res.status === 401 || res.status === 403) {
    detail = `${detail} (the server needs the API key configured in Settings)`;
  }
  return new AlertApiError(detail, res.status);
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...authHeaders(), ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw await errorFrom(res);
  const text = await res.text();
  return (text ? JSON.parse(text) : null) as T;
}

function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") q.set(key, String(value));
  }
  const text = q.toString();
  return text ? `?${text}` : "";
}

export interface ListRulesParams {
  kind?: AlertKind | "";
  enabled?: boolean;
  limit?: number;
  signal?: AbortSignal;
}

export interface ListIncidentsParams {
  ruleId?: string;
  state?: string;
  deliveryStatus?: string;
  limit?: number;
  signal?: AbortSignal;
}

export const alertsApi = {
  listRules: (params: ListRulesParams = {}) =>
    call<AlertRuleRow[]>(
      `/alerts/rules${qs({ kind: params.kind, enabled: params.enabled, limit: params.limit })}`,
      { signal: params.signal },
    ),

  createRule: (draft: AlertRuleDraft) =>
    call<AlertRuleRow>("/alerts/rules", { method: "POST", body: JSON.stringify(draft) }),

  updateRule: (id: string, draft: AlertRuleDraft) =>
    call<AlertRuleRow>(`/alerts/rules/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify(draft),
    }),

  deleteRule: (id: string) =>
    call<{ status: string; id: string }>(`/alerts/rules/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }),

  setEnabled: (id: string, enabled: boolean) =>
    call<AlertRuleRow>(
      `/alerts/rules/${encodeURIComponent(id)}/enabled${qs({ enabled })}`,
      { method: "POST" },
    ),

  resetRule: (id: string) =>
    call<AlertRuleRow>(`/alerts/rules/${encodeURIComponent(id)}/reset`, { method: "POST" }),

  dryRun: (id: string) =>
    call<AlertDryRunReport>(`/alerts/rules/${encodeURIComponent(id)}/dry-run`, {
      method: "POST",
    }),

  testSend: (id: string) =>
    call<AlertTestSendReport>(`/alerts/rules/${encodeURIComponent(id)}/test-send`, {
      method: "POST",
    }),

  listIncidents: (params: ListIncidentsParams = {}) =>
    call<AlertIncidentRow[]>(
      `/alerts/incidents${qs({
        rule_id: params.ruleId,
        state: params.state,
        delivery_status: params.deliveryStatus,
        limit: params.limit,
      })}`,
      { signal: params.signal },
    ),

  listTargets: () => call<AlertTargetsResponse>("/alerts/targets"),

  /** Evaluate now. `deliver` defaults to false on purpose: pressing this in the
   *  UI answers "what does the engine see", it does not spam a group. */
  runNow: (opts: { deliver?: boolean; ruleId?: string } = {}) =>
    call<AlertRunReport>(`/alerts/run${qs({ deliver: opts.deliver ?? false, rule_id: opts.ruleId })}`, {
      method: "POST",
    }),
};

// ---------------------------------------------------------------------------
// Presentation helpers (pure, so they are unit-testable without a DOM)
// ---------------------------------------------------------------------------

const OP_GLYPHS: Record<string, string> = {
  nonEmpty: "≠ ∅",
  truthy: "truthy",
  gt: ">",
  lt: "<",
  crossUp: "↑",
  crossDown: "↓",
  rising: "↗",
  falling: "↘",
};

/**
 * Render a number the way the pushed messages do: never an exponent, never a
 * trailing zero. A rule level copied out of this page must read the same as the
 * number the engine compared, which a locale-grouped "1,712.5" would not.
 */
export function trimNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  const magnitude = Math.abs(value);
  const digits = magnitude >= 1000 ? 2 : magnitude >= 1 ? 4 : 8;
  const text = value.toFixed(digits);
  return text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
}

/**
 * A compact, locale-free rendering of a condition: `close ↑ 1700`, `rsi:14 > 70`.
 *
 * Symbols rather than words, because the rule's own series names are already
 * identifiers the user typed; translating them into eight locales would add a
 * vocabulary to maintain without adding information.
 */
export function describeCondition(
  condition: Partial<AlertCondition> | null | undefined,
): string {
  if (!condition) return "";
  const op = condition.op ?? "";
  if (!op) return "";
  const lhs = condition.lhs ?? "?";
  const value = condition.value;
  const partner = condition.rhs
    ? String(condition.rhs)
    : value !== undefined && value !== null
      ? trimNumber(Number(value))
      : "";
  if (RELATIONAL_OPS.includes(op)) return `${lhs} ${OP_GLYPHS[op] ?? op} ${partner}`.trim();
  return `${lhs} ${OP_GLYPHS[op] ?? op}`;
}

/** A one-line summary of where a rule pushes to, for the list rows. */
export function describeTargets(rule: Pick<AlertRuleRow, "targets" | "channel" | "target">): string {
  if (rule.targets.length) return rule.targets.join(", ");
  if (rule.channel && rule.target) return `${rule.channel}:${rule.target}`;
  return "";
}

export type Tone = "success" | "danger" | "warning" | "neutral";

export function stateTone(state: string): Tone {
  switch (state) {
    case "firing":
      return "danger";
    case "pending":
      return "warning";
    case "resolved":
      return "success";
    case "error":
      return "danger";
    default:
      return "neutral";
  }
}

export function severityTone(severity: string): Tone {
  if (severity === "critical") return "danger";
  if (severity === "warning") return "warning";
  return "neutral";
}

export function deliveryTone(status: string): Tone {
  switch (status) {
    case "sent":
      return "success";
    case "failed":
      return "danger";
    case "pending":
      return "warning";
    default:
      return "neutral";
  }
}

/**
 * The absolute URL to paste into TradingView's alert "Webhook URL" field.
 *
 * The backend hands back a relative URL because it does not know which host the
 * operator reaches it on; only the browser knows, and TradingView needs a
 * reachable one.
 */
export function webhookUrl(origin: string, ruleId: string, secret: string): string {
  const base = origin.endsWith("/") ? origin.slice(0, -1) : origin;
  return `${base}/alerts/webhook/${encodeURIComponent(ruleId)}?key=${encodeURIComponent(secret)}`;
}

// ---------------------------------------------------------------------------
// The composer's form model
// ---------------------------------------------------------------------------

/** Mirrors `_SAFE_RULE_ID_RE` in the routes: the same grammar the store and the
 *  delete path accept, so a form can never create a rule it cannot remove. */
export const RULE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
/** Mirrors `SECRET_RE` in `src/alerts/inbox.py`. */
export const WEBHOOK_SECRET_RE = /^[A-Za-z0-9_-]{8,128}$/;

/**
 * The composer's state, with every number kept as text.
 *
 * Numbers stay strings here on purpose: an input that owns a number cannot show
 * the intermediate state of "1." or an empty field while the operator types, and
 * rewriting the field on every keystroke is how a threshold ends up as 0.
 */
export interface AlertRuleForm {
  id: string;
  kind: AlertKind;
  title: string;
  symbol: string;
  interval: string;
  adjust: string;
  count: string;
  op: string;
  lhs: string;
  rhs: string;
  value: string;
  forBars: string;
  severity: AlertSeverity;
  realert: string;
  exponentialRealert: string;
  sendResolved: boolean;
  sessionOnly: boolean;
  pollInterval: string;
  targets: string[];
  channel: string;
  target: string;
  webhookSecret: string;
}

export const EMPTY_ALERT_RULE_FORM: AlertRuleForm = {
  id: "",
  kind: "market",
  title: "",
  symbol: "",
  interval: "1D",
  adjust: "qfq",
  count: "320",
  op: "crossUp",
  lhs: "close",
  rhs: "",
  value: "",
  forBars: "1",
  severity: "warning",
  realert: "",
  exponentialRealert: "",
  sendResolved: true,
  sessionOnly: false,
  pollInterval: "5m",
  targets: [],
  channel: "",
  target: "",
  webhookSecret: "",
};

const DURATION_MS: Record<string, number> = {
  "1m": 60_000,
  "5m": 300_000,
  "15m": 900_000,
  "30m": 1_800_000,
  "1h": 3_600_000,
  "4h": 14_400_000,
  "12h": 43_200_000,
  "24h": 86_400_000,
};

/** Map stored milliseconds back to the closest preset, or "" for "off". */
export function durationPreset(ms: number): string {
  if (!ms) return "";
  const hit = Object.entries(DURATION_MS).find(([, value]) => value === ms);
  return hit ? hit[0] : "";
}

/** Load a stored rule back into the composer for editing. */
export function formFromRule(rule: AlertRuleRow): AlertRuleForm {
  const condition = rule.condition ?? {};
  return {
    ...EMPTY_ALERT_RULE_FORM,
    id: rule.id,
    kind: rule.kind,
    title: rule.title,
    symbol: rule.symbol,
    interval: rule.interval,
    adjust: rule.adjust,
    count: String(rule.count),
    op: condition.op ?? "crossUp",
    lhs: condition.lhs ?? "close",
    rhs: condition.rhs ?? "",
    value: condition.value === undefined || condition.value === null ? "" : String(condition.value),
    forBars: String(rule.for_bars),
    severity: rule.severity,
    realert: durationPreset(rule.realert_ms),
    exponentialRealert: durationPreset(rule.exponential_realert_ms),
    sendResolved: rule.send_resolved,
    sessionOnly: rule.session_only,
    pollInterval: durationPreset(rule.poll_interval_ms) || "5m",
    targets: [...rule.targets],
    channel: rule.channel ?? "",
    target: rule.target ?? "",
    webhookSecret: "", // the plaintext is gone once handed out; blank keeps the hash
  };
}

/**
 * Client-side mirror of `validate_rule` / `validate_condition`.
 *
 * The server answers these with a 422 anyway; checking them here is about which
 * field the operator's eye goes to, not about trust. Keys are field names.
 */
export function validateAlertRuleForm(form: AlertRuleForm): Record<string, string> {
  const errors: Record<string, string> = {};
  if (!form.id.trim()) {
    errors.id = "required";
  } else if (!RULE_ID_RE.test(form.id.trim())) {
    errors.id = "invalid_id";
  }

  if ((form.kind === "market" || form.kind === "position") && !form.symbol.trim()) {
    errors.symbol = "required";
  }

  const count = Number(form.count);
  if (!Number.isFinite(count) || count < 2 || count > 2000) errors.count = "out_of_range";
  const forBars = Number(form.forBars);
  if (!Number.isInteger(forBars) || forBars < 1 || forBars > 1000) errors.forBars = "out_of_range";

  if (form.kind !== "event") {
    if (!form.op) errors.op = "required";
    if (!form.lhs.trim()) errors.lhs = "required";
    if (RELATIONAL_OPS.includes(form.op) && !form.rhs.trim() && form.value.trim() === "") {
      errors.value = "needs_partner";
    }
    if (form.value.trim() !== "" && !Number.isFinite(Number(form.value))) {
      errors.value = "not_a_number";
    }
  }

  if (form.channel && !form.target.trim()) errors.target = "needs_channel";
  if (form.target.trim() && !form.channel) errors.channel = "needs_target";

  // The engine has no "back to normal" edge for an inbound event, so promising a
  // recovery notice for one is refused server-side; say so at the checkbox.
  if (form.kind === "event" && form.sendResolved) errors.sendResolved = "event_no_resolution";
  if (form.webhookSecret.trim() && !WEBHOOK_SECRET_RE.test(form.webhookSecret.trim())) {
    errors.webhookSecret = "invalid_secret";
  }
  if (
    form.realert &&
    form.exponentialRealert &&
    (DURATION_MS[form.exponentialRealert] ?? 0) < (DURATION_MS[form.realert] ?? 0)
  ) {
    errors.exponentialRealert = "shorter_than_realert";
  }
  return errors;
}

/** The request body the form stands for. Only call it with a valid form. */
export function draftFromForm(form: AlertRuleForm): AlertRuleDraft {
  const condition: AlertCondition = {
    op: form.op,
    lhs: form.lhs.trim(),
    rhs: form.rhs.trim() || null,
    value: form.value.trim() === "" ? null : Number(form.value),
  };
  return {
    id: form.id.trim(),
    kind: form.kind,
    title: form.title.trim(),
    symbol: form.symbol.trim(),
    interval: form.interval,
    count: Number(form.count),
    adjust: form.adjust,
    // An event rule carries no condition: the inbound alert *is* the fact, and
    // the webhook fills in event_value / event_price from the payload.
    condition: form.kind === "event" ? null : condition,
    for_bars: Number(form.forBars),
    realert: form.realert || null,
    exponential_realert: form.exponentialRealert || null,
    severity: form.severity,
    send_resolved: form.kind === "event" ? false : form.sendResolved,
    session_only: form.sessionOnly,
    poll_interval: form.pollInterval || null,
    targets: form.targets,
    channel: form.channel || null,
    target: form.target.trim() || null,
    webhook_secret: form.webhookSecret.trim() || null,
    enabled: true,
  };
}
