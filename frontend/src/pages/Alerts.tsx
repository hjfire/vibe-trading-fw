import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  BellRing,
  Copy,
  Loader2,
  Pause,
  Pencil,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Send,
  Trash2,
  Zap,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { formatIntervalMs } from "@/lib/cadence";
import {
  ALERT_ADJUSTS,
  ALERT_INTERVALS,
  ALERT_KINDS,
  ALERT_SEVERITIES,
  AlertApiError,
  CONDITION_OPS,
  DURATION_PRESETS,
  EMPTY_ALERT_RULE_FORM,
  RELATIONAL_OPS,
  SERIES_GROUPS,
  alertsApi,
  describeCondition,
  describeTargets,
  deliveryTone,
  draftFromForm,
  formFromRule,
  severityTone,
  stateTone,
  trimNumber,
  validateAlertRuleForm,
  webhookUrl,
  type AlertDryRunReport,
  type AlertIncidentRow,
  type AlertKind,
  type AlertRuleForm,
  type AlertRuleRow,
  type AlertRunReport,
  type AlertSeverity,
  type AlertTargetsResponse,
  type Tone,
} from "@/lib/alertsApi";

const fieldClass =
  "w-full rounded-md border bg-background px-3 py-2 text-sm outline-none transition focus:border-primary focus:ring-2 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60";
const labelClass = "text-sm font-medium";
const hintClass = "text-xs text-muted-foreground";
const iconButtonClass =
  "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60";

/** Rules are measured by the server's own poller; this only refreshes what the
 *  page shows. A slow poll must not feel frozen, a fast one must not churn. */
const POLL_MS = 20_000;

const ERROR_MESSAGES: Record<string, string> = {
  required: "This field is required",
  invalid_id: "Use letters, digits, “-” or “_”, up to 128 characters",
  out_of_range: "Out of range",
  not_a_number: "Not a number",
  needs_partner: "This operator compares against a series or a fixed level",
  needs_channel: "Pick a channel for this address",
  needs_target: "Fill in the address for this channel",
  event_no_resolution: "An inbound event has no “back to normal” to announce",
  invalid_secret: "8-128 characters of letters, digits, “-” or “_”",
  shorter_than_realert: "The ceiling must not be shorter than the repeat gap",
};

/**
 * Translation helper for this page.
 *
 * The locale catalogues are upstream files, so none of these keys exist in them
 * yet: every string carries an English default and joins the catalogues in the
 * translation pass that owns those files, rather than in a feature branch that
 * would conflict with every sync.
 */
function useText() {
  const { t } = useTranslation();
  return (key: string, defaultValue: string, options?: Record<string, string | number>): string =>
    String(t(key as never, { defaultValue, ...(options ?? {}) }));
}

function Pill({ label, tone }: { label: string; tone: Tone }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded px-2 py-0.5 text-xs font-medium",
        tone === "success" && "bg-success/10 text-success",
        tone === "danger" && "bg-danger/10 text-danger",
        tone === "warning" && "bg-warning/10 text-warning",
        tone === "neutral" && "bg-muted text-muted-foreground",
      )}
    >
      {label}
    </span>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className={labelClass}>
        {label}
      </label>
      {children}
      {error ? (
        <p className="text-xs text-danger">{error}</p>
      ) : hint ? (
        <p className={hintClass}>{hint}</p>
      ) : null}
    </div>
  );
}

function formatInstant(ms: number | null, locale: string): string {
  if (!ms) return "—";
  try {
    return new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(
      new Date(ms),
    );
  } catch {
    return new Date(ms).toISOString();
  }
}

export function Alerts() {
  const text = useText();
  const { i18n } = useTranslation();
  const locale = i18n.language;

  const [rules, setRules] = useState<AlertRuleRow[]>([]);
  const [incidents, setIncidents] = useState<AlertIncidentRow[]>([]);
  const [destinations, setDestinations] = useState<AlertTargetsResponse>({ targets: [], channels: [] });
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [form, setForm] = useState<AlertRuleForm>(EMPTY_ALERT_RULE_FORM);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [verdicts, setVerdicts] = useState<Record<string, AlertDryRunReport>>({});
  const [runReport, setRunReport] = useState<AlertRunReport | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The plaintext webhook secret exists only in this response; keep it in state
  // so a refresh does not pretend it can be read again.
  const [reveal, setReveal] = useState<{ ruleId: string; url: string } | null>(null);

  const refreshSeq = useRef(0);
  const refreshController = useRef<AbortController | null>(null);

  const refresh = useCallback(async () => {
    refreshController.current?.abort();
    const controller = new AbortController();
    refreshController.current = controller;
    const seq = ++refreshSeq.current;
    try {
      const [ruleRows, incidentRows] = await Promise.all([
        alertsApi.listRules({ signal: controller.signal }),
        alertsApi.listIncidents({ limit: 30, signal: controller.signal }),
      ]);
      if (seq !== refreshSeq.current) return;
      setRules(ruleRows);
      setIncidents(incidentRows);
      setListError(null);
    } catch (error) {
      if (seq !== refreshSeq.current || controller.signal.aborted) return;
      setListError(error instanceof AlertApiError || error instanceof Error ? error.message : String(error));
    } finally {
      if (seq === refreshSeq.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => {
      refreshSeq.current++; // invalidate any in-flight response
      refreshController.current?.abort();
      clearInterval(timer);
    };
  }, [refresh]);

  // Destinations change only when an operator edits the channel config, so one
  // read on mount is enough; the composer must not go blank because a poll lost
  // a selection.
  useEffect(() => {
    const controller = new AbortController();
    void alertsApi
      .listTargets()
      .then(setDestinations)
      .catch(() => {
        /* the composer falls back to the inline channel/address pair */
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (pendingDelete === null) return;
    const timer = setTimeout(() => setPendingDelete(null), 5_000);
    return () => clearTimeout(timer);
  }, [pendingDelete]);

  function update<K extends keyof AlertRuleForm>(key: K, value: AlertRuleForm[K]) {
    setForm((prev) => {
      const next = { ...prev, [key]: value };
      // An inbound event has no "back to normal" edge to announce, and the
      // recovery checkbox is disabled for that kind. Clearing the promise here
      // is what keeps the form from reporting an error on a field the operator
      // has no way to touch.
      if (key === "kind" && value === "event") next.sendResolved = false;
      return next;
    });
  }

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const problems = validateAlertRuleForm(form);
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;
    setSaving(true);
    setNotice(null);
    const draft = draftFromForm(form);
    try {
      // POST is an upsert on the server, so either verb would work; sending PUT
      // for a rule the list already has is what makes "edit this" fail loudly if
      // the rule was deleted in another tab instead of silently re-creating it.
      const exists = rules.some((row) => row.id === draft.id);
      const stored = exists
        ? await alertsApi.updateRule(draft.id, draft)
        : await alertsApi.createRule(draft);
      // A create of an event rule is the only moment the webhook secret exists
      // as text; show it now or the operator has to delete and re-create.
      if (stored.webhook_secret) {
        setReveal({
          ruleId: stored.id,
          url: webhookUrl(window.location.origin, stored.id, stored.webhook_secret),
        });
      }
      setNotice(text("alerts.saved", "Saved {{rule}}", { rule: stored.id }));
      setForm(EMPTY_ALERT_RULE_FORM);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  }

  async function runAction<T>(
    ruleId: string,
    action: () => Promise<T>,
    message: string | ((result: T) => string),
  ) {
    setBusyId(ruleId);
    setNotice(null);
    try {
      const result = await action();
      // The message may be written after the reply, because for some calls what
      // happened is in the body, not in the status code.
      setNotice(typeof message === "function" ? message(result) : message);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(null);
    }
  }

  async function probeRule(ruleId: string) {
    setBusyId(ruleId);
    try {
      const report = await alertsApi.dryRun(ruleId);
      setVerdicts((prev) => ({ ...prev, [ruleId]: report }));
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(null);
    }
  }

  async function evaluateAll(deliver: boolean) {
    setBusyId("__run__");
    setNotice(null);
    try {
      const report = await alertsApi.runNow({ deliver });
      setRunReport(report);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(null);
    }
  }

  function kindLabel(kind: AlertKind): string {
    return text(`alerts.kind_${kind}`, kind);
  }

  function stateLabel(state: string): string {
    return text(`alerts.state_${state}`, state);
  }

  function severityLabel(severity: string): string {
    return text(`alerts.severity_${severity}`, severity);
  }

  function deliveryLabel(status: string): string {
    return text(`alerts.delivery_${status}`, status);
  }

  const relational = RELATIONAL_OPS.includes(form.op);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="flex flex-wrap items-center gap-3">
        <BellRing className="h-6 w-6 text-primary" aria-hidden />
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold">{text("alerts.title", "Alerts")}</h1>
          <p className={hintClass}>
            {text("alerts.subtitle", "Price, position and account conditions that notify you wherever you already read messages.")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => void evaluateAll(false)}
            disabled={busyId !== null}
            className={iconButtonClass}
          >
            {busyId === "__run__" ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden />
            )}
            {text("alerts.evaluateNow", "Evaluate now")}
          </button>
          <button
            type="button"
            onClick={() => void evaluateAll(true)}
            disabled={busyId !== null}
            className={cn(iconButtonClass, "border-primary/40 text-primary")}
          >
            <Send className="h-3.5 w-3.5" aria-hidden />
            {text("alerts.evaluateAndPush", "Evaluate & push")}
          </button>
        </div>
      </header>

      {runReport && (
        <p className={cn(hintClass, "rounded-md border bg-card px-3 py-2 text-sm")}>
          {text(
            "alerts.runReport",
            "Measured {{measured}} · fired {{fired}} · resolved {{resolved}} · pushed {{delivered}} · errors {{errors}} · skipped {{skipped}}",
            {
              measured: runReport.evaluated,
              fired: runReport.fired,
              resolved: runReport.resolved,
              delivered: runReport.delivered,
              errors: runReport.errors,
              skipped: runReport.skipped,
            },
          )}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded-md border bg-card px-3 py-2 text-sm">
          {notice}
        </p>
      )}
      {listError && rules.length === 0 && (
        <p role="alert" className="text-sm text-danger">
          {listError}
        </p>
      )}

      {reveal && (
        <section className="space-y-2 rounded-lg border border-primary/40 bg-card p-4">
          <h2 className="text-sm font-semibold">
            {text("alerts.webhookRevealTitle", "Webhook URL for {{rule}}", { rule: reveal.ruleId })}
          </h2>
          <p className={hintClass}>
            {text(
              "alerts.webhookRevealHint",
              "Paste this into TradingView's alert “Webhook URL”. The secret is stored only as a hash, so this is the one chance to copy it.",
            )}
          </p>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1 text-xs">{reveal.url}</code>
            <button
              type="button"
              className={iconButtonClass}
              onClick={() => void navigator.clipboard?.writeText(reveal.url)}
            >
              <Copy className="h-3.5 w-3.5" aria-hidden />
              {text("alerts.copy", "Copy")}
            </button>
            <button type="button" className={iconButtonClass} onClick={() => setReveal(null)}>
              {text("alerts.dismiss", "Dismiss")}
            </button>
          </div>
        </section>
      )}

      <form onSubmit={handleSubmit} className="space-y-4 rounded-lg border bg-card p-4">
        <h2 className="text-sm font-semibold">{text("alerts.composerTitle", "New rule")}</h2>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field id="alert-id" label={text("alerts.idLabel", "Rule id")} error={errors.id && text(`alerts.errors.${errors.id}`, ERROR_MESSAGES[errors.id] ?? errors.id)}>
            <input
              id="alert-id"
              required
              value={form.id}
              onChange={(e) => update("id", e.target.value)}
              placeholder="moutai-breakout"
              className={cn(fieldClass, "font-mono")}
            />
          </Field>

          <Field id="alert-kind" label={text("alerts.kindLabel", "Watches")}>
            <select
              id="alert-kind"
              value={form.kind}
              onChange={(e) => update("kind", e.target.value as AlertKind)}
              className={fieldClass}
            >
              {ALERT_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {kindLabel(kind)}
                </option>
              ))}
            </select>
          </Field>

          <Field
            id="alert-symbol"
            label={text("alerts.symbolLabel", "Symbol")}
            error={errors.symbol ? text(`alerts.errors.${errors.symbol}`, ERROR_MESSAGES[errors.symbol] ?? errors.symbol) : undefined}
            hint={text("alerts.symbolHint", "Canonical form: 600519.SH, AAPL.US, BTC-USDT")}
          >
            <input
              id="alert-symbol"
              value={form.symbol}
              onChange={(e) => update("symbol", e.target.value)}
              placeholder="600519.SH"
              className={cn(fieldClass, "font-mono")}
            />
          </Field>

          <Field id="alert-title" label={text("alerts.titleLabel", "Label")} hint={text("alerts.titleHint", "Shown in the pushed message")}>
            <input
              id="alert-title"
              value={form.title}
              onChange={(e) => update("title", e.target.value)}
              placeholder={text("alerts.titlePlaceholder", "Moutai breaks 1700")}
              className={fieldClass}
            />
          </Field>
        </div>

        {form.kind !== "event" && (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field
              id="alert-op"
              label={text("alerts.opLabel", "Condition")}
              error={errors.op ? text(`alerts.errors.${errors.op}`, ERROR_MESSAGES[errors.op] ?? errors.op) : undefined}
            >
              <select
                id="alert-op"
                value={form.op}
                onChange={(e) => update("op", e.target.value)}
                className={fieldClass}
              >
                {CONDITION_OPS.map((op) => (
                  <option key={op} value={op}>
                    {text(`alerts.ops.${op}`, op)}
                  </option>
                ))}
              </select>
            </Field>

            <Field
              id="alert-lhs"
              label={text("alerts.seriesLabel", "Series")}
              error={errors.lhs ? text(`alerts.errors.${errors.lhs}`, ERROR_MESSAGES[errors.lhs] ?? errors.lhs) : undefined}
            >
              <select
                id="alert-lhs"
                value={form.lhs}
                onChange={(e) => update("lhs", e.target.value)}
                className={cn(fieldClass, "font-mono")}
              >
                {SERIES_GROUPS.map((section) => (
                  <optgroup key={section.group} label={text(`alerts.seriesGroup_${section.group}`, section.group)}>
                    {section.items.map((name) => (
                      <option key={name} value={name}>
                        {name}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            </Field>

            {relational && (
              <Field
                id="alert-value"
                label={text("alerts.valueLabel", "Level")}
                error={
                  errors.value
                    ? text(
                        `alerts.errors.${errors.value}`,
                        ERROR_MESSAGES[errors.value] ?? errors.value,
                      )
                    : undefined
                }
                hint={text("alerts.valueHint", "A fixed level, or leave blank and set a series below")}
              >
                <input
                  id="alert-value"
                  type="number"
                  step="any"
                  value={form.value}
                  onChange={(e) => update("value", e.target.value)}
                  placeholder="1700"
                  className={cn(fieldClass, "font-mono")}
                />
              </Field>
            )}

            {relational && (
              <Field
                id="alert-rhs"
                label={text("alerts.rhsLabel", "Against series")}
                hint={text("alerts.rhsHint", "Optional. Example: sma:20 for a golden cross")}
              >
                <input
                  id="alert-rhs"
                  value={form.rhs}
                  onChange={(e) => update("rhs", e.target.value)}
                  placeholder="sma:20"
                  className={cn(fieldClass, "font-mono")}
                />
              </Field>
            )}

            <Field
              id="alert-interval"
              label={text("alerts.intervalLabel", "Bar interval")}
              hint={text("alerts.adjustLabel", "Price adjustment on daily bars")}
            >
              <div className="flex gap-2">
                <select
                  id="alert-interval"
                  value={form.interval}
                  onChange={(e) => update("interval", e.target.value)}
                  className={fieldClass}
                >
                  {ALERT_INTERVALS.map((interval) => (
                    <option key={interval} value={interval}>
                      {interval}
                    </option>
                  ))}
                </select>
                <select
                  aria-label={text("alerts.adjustLabel", "Price adjustment")}
                  value={form.adjust}
                  onChange={(e) => update("adjust", e.target.value)}
                  className={fieldClass}
                >
                  {ALERT_ADJUSTS.map((adjust) => (
                    <option key={adjust} value={adjust}>
                      {adjust}
                    </option>
                  ))}
                </select>
              </div>
            </Field>

            <Field
              id="alert-count"
              label={text("alerts.countLabel", "Bars pulled")}
              error={errors.count ? text(`alerts.errors.${errors.count}`, ERROR_MESSAGES[errors.count] ?? errors.count) : undefined}
              hint={text("alerts.countHint", "An indicator period needs bars behind it")}
            >
              <input
                id="alert-count"
                type="number"
                min={2}
                max={2000}
                value={form.count}
                onChange={(e) => update("count", e.target.value)}
                className={cn(fieldClass, "font-mono")}
              />
            </Field>
          </div>
        )}

        {form.kind === "event" && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              id="alert-secret"
              label={text("alerts.secretLabel", "Webhook secret")}
              error={
                errors.webhookSecret
                  ? text(
                      `alerts.errors.${errors.webhookSecret}`,
                      ERROR_MESSAGES[errors.webhookSecret] ?? errors.webhookSecret,
                    )
                  : undefined
              }
              hint={text("alerts.secretHint", "Blank generates one and shows it once")}
            >
              <input
                id="alert-secret"
                value={form.webhookSecret}
                onChange={(e) => update("webhookSecret", e.target.value)}
                placeholder={text("alerts.secretPlaceholder", "auto-generated")}
                className={cn(fieldClass, "font-mono")}
              />
            </Field>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field
            id="alert-forbars"
            label={text("alerts.forBarsLabel", "Consecutive hits")}
            error={errors.forBars ? text(`alerts.errors.${errors.forBars}`, ERROR_MESSAGES[errors.forBars] ?? errors.forBars) : undefined}
            hint={text("alerts.forBarsHint", "Debounce: how many readings must agree")}
          >
            <input
              id="alert-forbars"
              type="number"
              min={1}
              max={1000}
              value={form.forBars}
              onChange={(e) => update("forBars", e.target.value)}
              className={cn(fieldClass, "font-mono")}
            />
          </Field>

          <Field id="alert-poll" label={text("alerts.pollLabel", "Measure every")}>
            <select
              id="alert-poll"
              value={form.pollInterval}
              onChange={(e) => update("pollInterval", e.target.value)}
              className={fieldClass}
            >
              {DURATION_PRESETS.filter((preset) => preset !== "").map((preset) => (
                <option key={preset} value={preset}>
                  {preset}
                </option>
              ))}
            </select>
          </Field>

          <Field id="alert-realert" label={text("alerts.realertLabel", "Repeat gap")}>
            <select
              id="alert-realert"
              value={form.realert}
              onChange={(e) => update("realert", e.target.value)}
              className={fieldClass}
            >
              {DURATION_PRESETS.map((preset) => (
                <option key={preset} value={preset}>
                  {preset === "" ? text("alerts.realertOnce", "Once per episode") : preset}
                </option>
              ))}
            </select>
          </Field>

          <Field
            id="alert-exponential"
            label={text("alerts.ceilingLabel", "Repeat ceiling")}
            error={
              errors.exponentialRealert
                ? text(
                    `alerts.errors.${errors.exponentialRealert}`,
                    ERROR_MESSAGES[errors.exponentialRealert] ?? errors.exponentialRealert,
                  )
                : undefined
            }
            hint={text("alerts.ceilingHint", "Doubles the gap up to this bound")}
          >
            <select
              id="alert-exponential"
              value={form.exponentialRealert}
              onChange={(e) => update("exponentialRealert", e.target.value)}
              className={fieldClass}
            >
              {DURATION_PRESETS.map((preset) => (
                <option key={preset} value={preset}>
                  {preset === "" ? text("alerts.ceilingOff", "Off") : preset}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="grid gap-4 sm:grid-cols-3">
          <Field id="alert-severity" label={text("alerts.severityLabel", "Severity")} hint={text("alerts.severityHint", "A hotter rule about the same symbol mutes the quieter ones")}>
            <select
              id="alert-severity"
              value={form.severity}
              onChange={(e) => update("severity", e.target.value as AlertSeverity)}
              className={fieldClass}
            >
              {ALERT_SEVERITIES.map((severity) => (
                <option key={severity} value={severity}>
                  {severityLabel(severity)}
                </option>
              ))}
            </select>
          </Field>

          <Field
            id="alert-channel"
            label={text("alerts.channelLabel", "Fallback channel")}
            error={errors.channel ? text(`alerts.errors.${errors.channel}`, ERROR_MESSAGES[errors.channel] ?? errors.channel) : undefined}
            hint={text("alerts.channelHint", "Used only when no destination is picked below")}
          >
            <div className="flex gap-2">
              <select
                id="alert-channel"
                value={form.channel}
                onChange={(e) => update("channel", e.target.value)}
                className={fieldClass}
              >
                <option value="">{text("alerts.channelNone", "None")}</option>
                {destinations.channels.map((channel) => (
                  <option key={channel} value={channel}>
                    {channel}
                  </option>
                ))}
              </select>
              <input
                aria-label={text("alerts.targetLabel", "Address")}
                value={form.target}
                onChange={(e) => update("target", e.target.value)}
                placeholder="-100123"
                className={cn(fieldClass, "font-mono")}
              />
            </div>
          </Field>

          <Field
            id="alert-targets"
            label={text("alerts.targetsLabel", "Destinations")}
            hint={text("alerts.targetsHint", "Registered targets survive a chat id changing")}
          >
            <select
              id="alert-targets"
              multiple
              size={3}
              value={form.targets}
              onChange={(e) =>
                update(
                  "targets",
                  Array.from(e.currentTarget.selectedOptions, (option) => option.value),
                )
              }
              className={fieldClass}
            >
              {destinations.targets.map((target) => (
                <option key={target.ref} value={target.ref}>
                  {target.label} · {target.channel}
                </option>
              ))}
            </select>
          </Field>
        </div>

        <div className="flex flex-wrap items-center gap-5">
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.sessionOnly}
              onChange={(e) => update("sessionOnly", e.target.checked)}
            />
            {text("alerts.sessionOnly", "Only while the market is open")}
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.sendResolved}
              disabled={form.kind === "event"}
              onChange={(e) => update("sendResolved", e.target.checked)}
            />
            {text("alerts.sendResolved", "Announce the recovery")}
          </label>
          {errors.sendResolved && (
            <p role="alert" className="text-xs text-danger">
              {text(
                `alerts.errors.${errors.sendResolved}`,
                ERROR_MESSAGES[errors.sendResolved] ?? errors.sendResolved,
              )}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            ) : (
              <Plus className="h-4 w-4" aria-hidden />
            )}
            {text("alerts.create", "Save rule")}
          </button>
          <p className={hintClass}>
            {/* Same switch the scheduled runs gate on, and said the same way:
                naming the flag is the only honest hint when the loop is off. */}
            {text(
              "alerts.pollerHint",
              "Rules are measured only when the server is started with VIBE_TRADING_ENABLE_SCHEDULER enabled; otherwise use Evaluate now. Saving a rule wakes the loop immediately.",
            )}
          </p>
        </div>
      </form>

      <section aria-label={text("alerts.listTitle", "Rules")} className="rounded-lg border bg-card">
        {loading ? (
          <div className="flex items-center justify-center gap-2 p-8 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            {text("alerts.loading", "Loading rules…")}
          </div>
        ) : rules.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            {text("alerts.empty", "No alert rules yet. Add a condition above and it will be measured on its own interval.")}
          </p>
        ) : (
          <ul className="divide-y">
            {rules.map((rule) => {
              const verdict = verdicts[rule.id];
              const targets = describeTargets(rule);
              const busy = busyId === rule.id;
              return (
                <li key={rule.id} className="space-y-2 p-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <Pill label={stateLabel(rule.state)} tone={stateTone(rule.state)} />
                    <Pill label={severityLabel(rule.severity)} tone={severityTone(rule.severity)} />
                    <span className="font-medium">{rule.title || rule.id}</span>
                    <span className={hintClass}>{kindLabel(rule.kind)}</span>
                    {!rule.enabled && <Pill label={text("alerts.paused", "paused")} tone="neutral" />}
                  </div>

                  <div className={cn(hintClass, "flex flex-wrap items-center gap-x-2 gap-y-1 font-mono")}>
                    <span>{describeCondition(rule.condition) || text("alerts.inboundOnly", "inbound webhook")}</span>
                    {rule.symbol && <span>· {rule.symbol}</span>}
                    <span>· {rule.interval}</span>
                    <span>· {text("alerts.everyN", "every {{ms}}", { ms: formatIntervalMs(rule.poll_interval_ms) })}</span>
                    {rule.for_bars > 1 && (
                      <span>· {text("alerts.afterHits", "after {{n}} hits", { n: rule.for_bars })}</span>
                    )}
                    {rule.realert_ms > 0 && (
                      <span>· {text("alerts.repeatGap", "repeat ≥ {{ms}}", { ms: formatIntervalMs(rule.realert_ms) })}</span>
                    )}
                    {rule.session_only && <span>· {text("alerts.sessionOnlyShort", "session only")}</span>}
                  </div>

                  <div className={cn(hintClass, "space-y-0.5")}>
                    <p>
                      {text("alerts.lastChecked", "Last checked {{when}}", {
                        when: formatInstant(rule.last_checked_at, locale),
                      })}
                      {rule.last_value !== null && ` · ${text("alerts.lastValue", "value {{value}}", { value: trimNumber(rule.last_value) })}`}
                      {rule.fired_count > 0 &&
                        ` · ${text("alerts.firedN", "fired {{n}} times", { n: rule.fired_count })}`}
                      {rule.muted_until > 0 &&
                        ` · ${text("alerts.mutedUntil", "quiet until {{when}}", {
                          when: formatInstant(rule.muted_until, locale),
                        })}`}
                    </p>
                    {rule.last_reason && <p>{rule.last_reason}</p>}
                    {rule.last_error && <p className="text-danger">{rule.last_error}</p>}
                    <p>
                      {targets
                        ? text("alerts.pushesTo", "pushes to {{targets}}", { targets })
                        : text("alerts.logOnly", "records without pushing")}
                    </p>
                    {rule.kind === "event" && (
                      <p>
                        {rule.webhook_configured
                          ? text("alerts.webhookReady", "Webhook is armed (the secret is stored hashed)")
                          : text("alerts.webhookMissing", "No webhook secret")}
                      </p>
                    )}
                  </div>

                  {verdict && (
                    <div className="rounded-md border bg-background p-3 text-xs">
                      <p className="font-medium">
                        {verdict.error
                          ? verdict.error
                          : `${verdict.hit ? text("alerts.verdictHit", "condition holds") : text("alerts.verdictMiss", "condition does not hold")} · ${verdict.reason}`}
                      </p>
                      <p className={hintClass}>
                        {text(
                          "alerts.verdictAction",
                          "{{action}} · would notify {{notify}} · next state {{next}}",
                          {
                            action: verdict.action,
                            notify: verdict.would_notify
                              ? text("alerts.yes", "yes")
                              : text("alerts.no", "no"),
                            next: verdict.next_state,
                          },
                        )}
                      </p>
                      <p className={hintClass}>
                        {text(
                          "alerts.verdictData",
                          "{{bars}} bars · {{positions}} positions · market {{open}}",
                          {
                            bars: verdict.bars,
                            positions: verdict.positions,
                            open: verdict.market_open
                              ? text("alerts.open", "open")
                              : text("alerts.closed", "closed"),
                          },
                        )}
                      </p>
                    </div>
                  )}

                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void runAction(
                          rule.id,
                          () => alertsApi.setEnabled(rule.id, !rule.enabled),
                          rule.enabled
                            ? text("alerts.pausedToast", "Paused {{rule}}", { rule: rule.id })
                            : text("alerts.resumedToast", "Resumed {{rule}}", { rule: rule.id }),
                        )
                      }
                      className={iconButtonClass}
                    >
                      {rule.enabled ? <Pause className="h-3.5 w-3.5" aria-hidden /> : <Play className="h-3.5 w-3.5" aria-hidden />}
                      {rule.enabled
                        ? text("alerts.pause", "Pause alert rule")
                        : text("alerts.resume", "Resume alert rule")}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void probeRule(rule.id)}
                      className={iconButtonClass}
                    >
                      {busy ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden />
                      ) : (
                        <Zap className="h-3.5 w-3.5" aria-hidden />
                      )}
                      {text("alerts.dryRun", "Test condition")}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void runAction(
                          rule.id,
                          () => alertsApi.testSend(rule.id),
                          // A 200 here only means the server tried: "sent",
                          // "failed" and "no_target" all come back OK, so the
                          // banner has to read the verdict, not the HTTP status.
                          (report) =>
                            report.status === "sent"
                              ? text("alerts.testSent", "Test push sent for {{rule}} · {{n}} addresses", {
                                  rule: rule.id,
                                  n: report.addresses,
                                })
                              : text("alerts.testNotSent", "Nothing arrived: {{detail}}", {
                                  detail: report.error || report.status,
                                }),
                        )
                      }
                      className={iconButtonClass}
                    >
                      <Send className="h-3.5 w-3.5" aria-hidden />
                      {text("alerts.testSend", "Send test")}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void runAction(
                          rule.id,
                          () => alertsApi.resetRule(rule.id),
                          text("alerts.resetToast", "Reset {{rule}}", { rule: rule.id }),
                        )
                      }
                      className={iconButtonClass}
                    >
                      <RotateCcw className="h-3.5 w-3.5" aria-hidden />
                      {text("alerts.reset", "Reset episode")}
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setForm(formFromRule(rule));
                        setErrors({});
                        setNotice(
                          text(
                            "alerts.editing",
                            "Editing {{rule}}. Saving replaces the rule and keeps its history.",
                            { rule: rule.id },
                          ),
                        );
                      }}
                      className={iconButtonClass}
                    >
                      <Pencil className="h-3.5 w-3.5" aria-hidden />
                      {text("alerts.edit", "Edit")}
                    </button>
                    {pendingDelete === rule.id ? (
                      <button
                        type="button"
                        onClick={() => {
                          setPendingDelete(null);
                          void runAction(
                            rule.id,
                            () => alertsApi.deleteRule(rule.id),
                            text("alerts.deletedToast", "Deleted {{rule}}. Its history stays.", { rule: rule.id }),
                          );
                        }}
                        className={cn(iconButtonClass, "border-danger text-danger")}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        {text("alerts.confirmDelete", "Confirm delete")}
                      </button>
                    ) : (
                      <button
                        type="button"
                        aria-label={text("alerts.deleteAria", "Delete alert rule {{rule}}", { rule: rule.id })}
                        onClick={() => setPendingDelete(rule.id)}
                        className={cn(iconButtonClass, "hover:text-danger")}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                        {text("alerts.delete", "Delete")}
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <section aria-label={text("alerts.timelineTitle", "Notification history")} className="rounded-lg border bg-card">
        <div className="flex items-center justify-between border-b px-4 py-3">
          <h2 className="text-sm font-semibold">{text("alerts.timelineTitle", "Notification history")}</h2>
          <span className={hintClass}>
            {text("alerts.timelineHint", "Every firing is written before it is pushed, so a channel outage still leaves a trace.")}
          </span>
        </div>
        {incidents.length === 0 ? (
          <p className="p-8 text-center text-sm text-muted-foreground">
            {text("alerts.timelineEmpty", "Nothing has fired yet.")}
          </p>
        ) : (
          <ul className="divide-y">
            {incidents.map((incident) => (
              <li key={incident.id} className="flex flex-wrap items-start gap-2 p-4 text-sm">
                <Pill label={stateLabel(incident.state)} tone={stateTone(incident.state)} />
                <Pill
                  label={deliveryLabel(incident.delivery_status)}
                  tone={deliveryTone(incident.delivery_status)}
                />
                <div className="min-w-0 flex-1 space-y-0.5">
                  <p className="font-medium">
                    {incident.rule_title || incident.rule_id}
                    {incident.symbol && <span className={cn(hintClass, "ms-2 font-mono")}>{incident.symbol}</span>}
                  </p>
                  <p className={hintClass}>
                    {incident.reason}
                    {incident.value !== null && ` · ${trimNumber(incident.value)}`}
                  </p>
                  {incident.delivery_error && (
                    <p className="text-xs text-danger">
                      {incident.delivery_error}
                      {incident.delivery_attempts > 0 &&
                        ` (${text("alerts.attempts", "{{n}} attempts", { n: incident.delivery_attempts })})`}
                    </p>
                  )}
                </div>
                <span className={cn(hintClass, "shrink-0 font-mono")}>
                  {formatInstant(incident.at_ms, locale)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
