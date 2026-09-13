import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Check,
  Copy,
  Database,
  FolderOpen,
  Loader2,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
} from "lucide-react";
import { cn } from "@/lib/utils";
import {
  formatBytes,
  formatCount,
  warehouseApi,
  WarehouseApiError,
  type WarehouseAuditReport,
  type WarehouseStatus,
} from "@/lib/warehouseApi";

/**
 * The local bar warehouse, as a page (local custom ㊱).
 *
 * Read-only on purpose. Filling the store is a minutes-long, rate-limited,
 * credentialed job that belongs to the CLI; what the browser is good at is
 * answering "what do I have, can I trust it, what do I run next" — so that is
 * all this page can ask the server. The command lines shown here are the ones
 * the backend produced, and the backend's are pinned against the real parser.
 */

const iconButtonClass =
  "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60";

/**
 * Translation helper for this page.
 *
 * The locale catalogues are upstream files, so none of these keys exist in them
 * yet: every string carries an English default and joins the catalogues in the
 * translation pass that owns those files, rather than in a feature branch that
 * would conflict with every sync. Same arrangement as the Alerts page.
 */
function useText() {
  const { t } = useTranslation();
  return (key: string, defaultValue: string, options?: Record<string, string | number>): string =>
    String(t(key as never, { defaultValue, ...(options ?? {}) }));
}

function Pill({ label, tone }: { label: string; tone: "success" | "danger" | "warning" | "neutral" }) {
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

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="text-xs text-muted-foreground">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

function CommandLine({ command, label }: { command: string; label: string }) {
  const text = useText();
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      /* no clipboard permission (http, headless): the text is selectable anyway */
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  };

  return (
    <div className="flex items-center gap-2">
      <code className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 text-[12px]" title={command}>
        {command}
      </code>
      <button type="button" onClick={copy} className={iconButtonClass} aria-label={label}>
        {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
        {copied ? text("warehouse.copied", "Copied") : text("warehouse.copy", "Copy")}
      </button>
    </div>
  );
}

function AuditPanel({ report, text }: { report: WarehouseAuditReport; text: ReturnType<typeof useText> }) {
  const errorCount = report.issues.filter((issue) => issue.severity === "error").length;
  const warnCount = report.issues.length - errorCount;

  return (
    <section className="space-y-3 rounded-lg border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="text-sm font-semibold">{text("warehouse.auditTitle", "Health check")}</h2>
        <Pill
          label={report.clean ? text("warehouse.auditClean", "No impossible rows") : text("warehouse.auditDirty", "{{n}} defect group(s)", { n: errorCount })}
          tone={report.clean ? "success" : "danger"}
        />
        {report.gaps_total > 0 && (
          <Pill label={text("warehouse.auditHalts", "{{n}} suspected halt(s)", { n: report.gaps_total })} tone="warning" />
        )}
        {warnCount > 0 && (
          <Pill label={text("warehouse.auditWarnings", "{{n}} warning(s)", { n: warnCount })} tone="neutral" />
        )}
        <span className="ml-auto text-xs text-muted-foreground">
          {text("warehouse.auditScope", "{{interval}} · {{symbols}} symbol(s) · {{rows}} row(s)", {
            interval: report.interval,
            symbols: formatCount(report.symbols),
            rows: formatCount(report.rows),
          })}
        </span>
      </div>

      {report.issues.length === 0 ? (
        <p className="text-xs text-muted-foreground">{text("warehouse.auditNoIssues", "No row-level defects found.")}</p>
      ) : (
        <table className="w-full text-left text-xs">
          <thead className="text-muted-foreground">
            <tr>
              <th className="py-1 pr-3 font-medium">{text("warehouse.colFinding", "Finding")}</th>
              <th className="py-1 pr-3 font-medium">{text("warehouse.colSeverity", "Severity")}</th>
              <th className="py-1 pr-3 text-right font-medium">{text("warehouse.colRows", "Rows")}</th>
              <th className="py-1 font-medium">{text("warehouse.colDetail", "Detail")}</th>
            </tr>
          </thead>
          <tbody>
            {report.issues.map((issue) => (
              <tr key={issue.code} className="border-t">
                <td className="py-1 pr-3 font-mono">{issue.code}</td>
                <td className="py-1 pr-3">
                  <Pill label={issue.severity} tone={issue.severity === "error" ? "danger" : "warning"} />
                </td>
                <td className="py-1 pr-3 text-right tabular-nums">{formatCount(issue.rows)}</td>
                <td className="py-1 text-muted-foreground">{issue.detail}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {report.gaps.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-xs font-medium text-muted-foreground">
            {text("warehouse.haltTitle", "Suspected halts — a peer traded and this name did not")}
          </h3>
          <ul className="space-y-0.5 text-xs">
            {report.gaps.map((gap) => (
              <li key={`${gap.symbol}-${gap.start}`} className="flex flex-wrap gap-2">
                <span className="font-mono">{gap.symbol}</span>
                <span className="tabular-nums">{gap.sessions} sessions</span>
                <span className="text-muted-foreground">
                  {gap.start} .. {gap.end}
                </span>
                <span className="text-muted-foreground">({gap.neighbors})</span>
              </li>
            ))}
            {report.gaps_total > report.gaps.length && (
              <li className="text-muted-foreground">
                {text("warehouse.haltMore", "… {{n}} more", { n: report.gaps_total - report.gaps.length })}
              </li>
            )}
          </ul>
        </div>
      )}

      {report.coverage.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-xs font-medium text-muted-foreground">
            {text("warehouse.thinTitle", "Thinnest coverage ({{n}} of {{total}} symbols)", {
              n: report.coverage.length,
              total: formatCount(report.coverage_total),
            })}
          </h3>
          <ul className="grid gap-x-6 gap-y-0.5 text-xs sm:grid-cols-2 lg:grid-cols-3">
            {report.coverage.map((row) => (
              <li key={row.symbol} className="flex justify-between gap-2">
                <span className="font-mono">{row.symbol}</span>
                <span className="tabular-nums text-muted-foreground">
                  {formatCount(row.rows)} · {row.first}..{row.last}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

export function Warehouse() {
  const text = useText();
  const [status, setStatus] = useState<WarehouseStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [report, setReport] = useState<WarehouseAuditReport | null>(null);
  const [auditing, setAuditing] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [interval, setInterval] = useState<string>("1D");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const body = await warehouseApi.status();
      setStatus(body);
      // The stored interval list is the only truth about what can be audited, so
      // a selection that no longer exists falls back to the first one. Read via
      // the updater form: depending on `interval` here would refetch the whole
      // inventory every time the selection changes.
      setInterval((current) =>
        body.intervals.length && !body.intervals.some((row) => row.interval === current)
          ? body.intervals[0].interval
          : current,
      );
    } catch (exc) {
      setStatus(null);
      setError(exc instanceof WarehouseApiError ? exc.message : String(exc));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runAudit = async () => {
    setAuditing(true);
    setAuditError(null);
    try {
      setReport(await warehouseApi.audit({ interval }));
    } catch (exc) {
      setReport(null);
      setAuditError(exc instanceof WarehouseApiError ? exc.message : String(exc));
    } finally {
      setAuditing(false);
    }
  };

  const totals = status?.totals;
  const auditIntervals = status?.intervals ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-4">
      <header className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="flex items-center gap-2 text-xl font-semibold">
            <Database className="h-5 w-5" aria-hidden="true" />
            {text("warehouse.title", "Bar warehouse")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {text(
              "warehouse.subtitle",
              "Your own on-disk history: parquet partitions DuckDB can query directly, so a backtest or a factor run does not wait on an API quota.",
            )}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {auditIntervals.length > 1 && (
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className="max-md:hidden">{text("warehouse.auditInterval", "Audit interval")}</span>
              <select
                className="rounded-md border bg-background px-2 py-1.5 text-xs"
                value={interval}
                onChange={(event) => setInterval(event.target.value)}
              >
                {auditIntervals.map((row) => (
                  <option key={row.interval} value={row.interval}>
                    {row.interval}
                  </option>
                ))}
              </select>
            </label>
          )}
          <button type="button" onClick={runAudit} disabled={auditing || !status?.has_data} className={iconButtonClass}>
            {auditing ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {text("warehouse.auditButton", "Run health check")}
          </button>
          <button type="button" onClick={() => void load()} disabled={loading} className={iconButtonClass}>
            {loading ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
            )}
            {text("warehouse.refresh", "Refresh")}
          </button>
        </div>
      </header>

      {error && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/5 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
          <span className="min-w-0 break-words">{error}</span>
        </div>
      )}

      {status && !status.enabled && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-sm">
          <ShieldAlert className="h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
          <span>
            {text(
              "warehouse.disabledHint",
              "The read-path switch is off: backtests and factor runs will not look at this store yet. Inventory below is still real.",
            )}
          </span>
          <code className="rounded bg-muted px-1.5 py-0.5 text-[12px]">
            {status.enable_env_var}=true
          </code>
          <span className="text-xs text-muted-foreground">
            {text("warehouse.disabledWhere", "in agent/.env or ~/.vibe-trading/.env, then restart the server")}
          </span>
        </div>
      )}

      {status && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <FolderOpen className="h-3.5 w-3.5" aria-hidden="true" />
            <code className="min-w-0 break-all rounded bg-muted px-2 py-1 text-[12px]">{status.root}</code>
            <Pill
              label={status.root_exists ? text("warehouse.rootExists", "on disk") : text("warehouse.rootMissing", "not created yet")}
              tone={status.root_exists ? "success" : "neutral"}
            />
            {status.manifest.updated_at && (
              <span>{text("warehouse.lastWrite", "last written {{at}}", { at: String(status.manifest.updated_at) })}</span>
            )}
            {status.universes.length > 0 && (
              <span>{text("warehouse.rosters", "rosters: {{list}}", { list: status.universes.join(", ") })}</span>
            )}
          </div>

          {status.has_data ? (
            <>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
                <Stat label={text("warehouse.statRows", "Rows")} value={formatCount(totals?.rows ?? 0)} />
                <Stat label={text("warehouse.statSymbols", "Symbols")} value={formatCount(totals?.symbols ?? 0)} hint={text("warehouse.statSymbolsHint", "counted per interval")} />
                <Stat label={text("warehouse.statPartitions", "Partitions")} value={formatCount(totals?.partitions ?? 0)} />
                <Stat
                  label={text("warehouse.statSize", "On disk")}
                  value={formatBytes(totals?.bytes ?? 0)}
                  hint={text("warehouse.statSizeHint", "parquet, compressed")}
                />
                <Stat
                  label={text("warehouse.statSpan", "Span")}
                  value={totals?.first ? `${totals.first} → ${totals.last}` : "—"}
                />
              </div>

              <section className="overflow-x-auto rounded-lg border bg-card">
                <table className="w-full text-left text-xs">
                  <thead className="bg-muted/40 text-muted-foreground">
                    <tr>
                      <th className="px-3 py-2 font-medium">{text("warehouse.colInterval", "Interval")}</th>
                      <th className="px-3 py-2 font-medium">{text("warehouse.colGrain", "Partitioned by")}</th>
                      <th className="px-3 py-2 text-right font-medium">{text("warehouse.colSymbols", "Symbols")}</th>
                      <th className="px-3 py-2 text-right font-medium">{text("warehouse.colRows", "Rows")}</th>
                      <th className="px-3 py-2 font-medium">{text("warehouse.colSpan", "Span")}</th>
                      <th className="px-3 py-2 font-medium">{text("warehouse.colSources", "Sources / markets")}</th>
                      <th className="px-3 py-2 text-right font-medium">
                        {text("warehouse.colSize", "Size")}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {auditIntervals.map((row) => (
                      <tr key={row.interval} className="border-t">
                        <td className="px-3 py-1.5 font-mono">{row.interval}</td>
                        <td className="px-3 py-1.5 text-muted-foreground">{row.grain}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{formatCount(row.symbols)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{formatCount(row.rows)}</td>
                        <td className="px-3 py-1.5 tabular-nums text-muted-foreground">
                          {row.first} .. {row.last}
                        </td>
                        <td className="px-3 py-1.5 text-muted-foreground">
                          {/* One text node: "a / b" split across three makes the
                              cell unreadable to a screen reader reading the row. */}
                          {`${row.sources.join(", ")} / ${row.markets.join(", ")}`}
                        </td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{formatBytes(row.bytes)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            </>
          ) : (
            <section className="rounded-lg border border-dashed bg-card p-5">
              <h2 className="text-sm font-semibold">{text("warehouse.emptyTitle", "Nothing stored yet")}</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                {text(
                  "warehouse.emptyBody",
                  "The directory is created on the first sync. A universe sync also stores the point-in-time roster, which is what keeps a factor measured on csi300 honest about survivorship.",
                )}
              </p>
            </section>
          )}

          <section className="space-y-2 rounded-lg border bg-card p-4">
            <h2 className="text-sm font-semibold">{text("warehouse.commandsTitle", "From a terminal")}</h2>
            <p className="text-xs text-muted-foreground">
              {text("warehouse.commandsHint", "Syncing stays a command-line act: it is long-running and needs the data vendor's token in the server environment.")}
            </p>
            <CommandLine command={status.commands.fill} label={text("warehouse.copyFill", "Copy the backfill command")} />
            <CommandLine command={status.commands.health} label={text("warehouse.copyHealth", "Copy the audit command")} />
            <CommandLine command={status.commands.inventory} label={text("warehouse.copyInventory", "Copy the inventory command")} />
          </section>
        </>
      )}

      {auditError && (
        <div role="alert" className="flex items-start gap-2 rounded-lg border border-danger/40 bg-danger/5 p-3 text-sm">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden="true" />
          <span className="min-w-0 break-words">{auditError}</span>
        </div>
      )}

      {report && <AuditPanel report={report} text={text} />}
    </div>
  );
}
