import { authHeaders } from "@/lib/apiAuth";
import { isJsonReply, nonJsonReplyMessage } from "@/lib/apiReply";

/**
 * Thin client for the `/api/warehouse/*` routes (local custom ㊱).
 *
 * Kept in its own module rather than added to the upstream `api.ts`, so daily
 * GitHub syncs never conflict — the convention `marketApi.ts` and `alertsApi.ts`
 * set.
 *
 * The shapes below mirror `agent/src/api/warehouse_routes.py` field for field.
 * That file is the contract; when it changes, change this one with it.
 */

export interface WarehouseIntervalRow {
  interval: string;
  /** Partition grain on disk: "year" for daily bars, "year,month" for minutes. */
  grain: string;
  symbols: number;
  rows: number;
  first: string | null;
  last: string | null;
  markets: string[];
  asset_classes: string[];
  sources: string[];
  partitions: number;
  bytes: number;
}

export interface WarehouseTotals {
  symbols: number;
  rows: number;
  partitions: number;
  bytes: number;
  first: string | null;
  last: string | null;
}

export interface WarehouseStatus {
  status: string;
  /** Whether the loader switch is on, i.e. whether backtests may read the store. */
  enabled: boolean;
  enable_env_var: string;
  root: string;
  root_exists: boolean;
  has_data: boolean;
  intervals: WarehouseIntervalRow[];
  totals: WarehouseTotals;
  /** Universes with a stored point-in-time roster (e.g. `csi300`). */
  universes: string[];
  manifest: {
    schema_version?: number | null;
    created_at?: string | null;
    updated_at?: string | null;
    sources?: Record<string, unknown> | null;
  };
  /** Copy-pasteable next steps, already valid for the packaged CLI. */
  commands: {
    fill: string;
    fill_symbols: string;
    inventory: string;
    health: string;
  };
}

export interface WarehouseIssueRow {
  code: string;
  severity: "error" | "warn" | string;
  rows: number;
  detail: string;
}

export interface WarehouseGapRow {
  symbol: string;
  market: string;
  start: string;
  end: string;
  sessions: number;
  neighbors: string;
}

export interface WarehouseCoverageRow {
  symbol: string;
  market: string;
  asset_class: string;
  first: string;
  last: string;
  rows: number;
  sources: string[];
}

export interface WarehouseAuditReport {
  status: string;
  interval: string;
  root: string;
  symbols: number;
  rows: number;
  first: string | null;
  last: string | null;
  partitions: number;
  /** No stored row is impossible. Suspected halts never flip this. */
  clean: boolean;
  issues: WarehouseIssueRow[];
  gaps: WarehouseGapRow[];
  gaps_total: number;
  coverage: WarehouseCoverageRow[];
  coverage_total: number;
}

export interface AuditParams {
  interval?: string;
  minGap?: number;
  gaps?: boolean;
  symbols?: string;
  signal?: AbortSignal;
}

export class WarehouseApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "WarehouseApiError";
    this.status = status;
  }
}

function nonJsonError(path: string, res: Response): WarehouseApiError {
  // The *why* lives in `apiReply.ts`, next to the identical check the other
  // local-custom clients run, because this endpoint has now failed three
  // different ways under one message.
  return new WarehouseApiError(nonJsonReplyMessage(path, res), res.status);
}

async function errorFrom(path: string, res: Response): Promise<WarehouseApiError> {
  let detail = `request failed (${res.status})`;
  if (!isJsonReply(res)) return nonJsonError(path, res);
  try {
    const body = (await res.json()) as { error?: unknown; detail?: unknown };
    detail = String(body.error || body.detail || detail);
  } catch {
    /* a body that is not JSON still has a status, which is enough */
  }
  if (res.status === 401 || res.status === 403) {
    detail = `${detail} (the server needs the API key configured in Settings)`;
  }
  return new WarehouseApiError(detail, res.status);
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    // A cached reply is a second opinion nobody asked for. When the route is
    // missing this endpoint used to be handed index.html carrying ETag and
    // Last-Modified but no Cache-Control, so the browser kept that wrong answer
    // for hours and the page went on failing *after* the server was fixed.
    cache: "no-store",
    ...init,
    headers: { "Content-Type": "application/json", ...authHeaders(), ...(init?.headers ?? {}) },
  });
  if (!res.ok) throw await errorFrom(path, res);
  if (!isJsonReply(res)) throw nonJsonError(path, res);
  return (await res.json()) as T;
}

function qs(params: Record<string, string | number | boolean | undefined>): string {
  const q = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) q.set(key, String(value));
  }
  const text = q.toString();
  return text ? `?${text}` : "";
}

export const warehouseApi = {
  status: (signal?: AbortSignal) =>
    call<WarehouseStatus>("/api/warehouse/status", { signal }),

  audit: (params: AuditParams = {}) =>
    call<WarehouseAuditReport>(
      `/api/warehouse/audit${qs({
        interval: params.interval,
        min_gap: params.minGap,
        // Explicit "false" has to survive the query build, or the toggle is a
        // control that does nothing once the server default is true.
        gaps: params.gaps === undefined ? undefined : params.gaps ? "true" : "false",
        symbols: params.symbols,
      })}`,
      { signal: params.signal },
    ),
};

/** Bytes to a human string, matching the CLI's `_human_bytes` reading. */
export function formatBytes(count: number): string {
  let size = Number(count || 0);
  const units = ["B", "KB", "MB", "GB", "TB"];
  for (const unit of units) {
    if (size < 1024 || unit === "TB") {
      return unit === "B" ? `${size.toFixed(0)}B` : `${size.toFixed(1)}${unit}`;
    }
    size /= 1024;
  }
  return `${size.toFixed(1)}TB`;
}

export function formatCount(value: number): string {
  return Number(value || 0).toLocaleString("en-US");
}
