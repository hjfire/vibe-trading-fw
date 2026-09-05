/**
 * Drawing exchange: the file and link formats for chart drawings
 * (local custom ⑱).
 *
 * A drawing is chart data, not a script — it only means something next to the
 * bars it was drawn on. So the container carries the symbol/interval it came
 * from as a **label** (the receiving end decides where to drop it), and every
 * entry is rebuilt from scratch instead of copied:
 *
 * - a point without a `timestamp` is dropped: a bare `dataIndex` lands on a
 *   different bar once the next page of history is prepended (see ⑭);
 * - `paneId` is kept only when it names a pane the receiving chart can rebuild
 *   — the main chart or one of this app's `sub:` panes (⑲). Anything else, the
 *   library's random `indicator_pane_…` included, is sent to the main pane:
 *   price values on a volume axis is the exact bug ⑭ fixed, and a line saved
 *   against a pane id that will never exist again is worse than a plain one;
 * - tool names outside `DRAW_TOOLS` are refused, because `createOverlay` takes
 *   any string and a typo would bank a drawing that can never be restored;
 * - objects are rebuilt key by key, so a hostile file cannot smuggle
 *   `__proto__` or unexpected keys into the overlay template.
 *
 * The link codec is the one scripts already use (`scriptExchange`): `g` +
 * base64url(gzip(json)) when the runtime can gzip, `j` + base64url(json)
 * otherwise. A 200-point brush line is a few kilobytes of JSON, so compression
 * is what keeps a "share my markings" link inside the usual URL comfort limit.
 */

import {
  MAIN_PANE_ID,
  MAX_DRAWINGS_PER_BUCKET,
  drawingsBucket,
  isRestorablePaneId,
  normalizeDrawingStyle,
  toolOf,
  type StoredDrawing,
  type StoredPoint,
} from "./chartDrawings";
import {
  SHARE_LINK_SOFT_LIMIT,
  decodeSharePayload,
  encodeSharePayload,
  extractPayload,
  shareCodeMessage,
  shareUrl,
  type ShareLink,
} from "./scriptExchange";

export const DRAWING_BUNDLE_KIND = "vibe-trading.drawings";
export const DRAWING_BUNDLE_VERSION = 1;

/** Query key for a drawing link; `s` is already taken by script shares. */
export const DRAWING_SHARE_QUERY_KEY = "d";

export interface DrawingBundleSource {
  /** "" when the exporter did not say. */
  symbol: string;
  interval: string;
  exportedAt: string;
  count: number;
}

export interface DrawingBundle {
  kind: typeof DRAWING_BUNDLE_KIND;
  version: typeof DRAWING_BUNDLE_VERSION;
  from: DrawingBundleSource;
  drawings: StoredDrawing[];
}

export interface ExchangeMeta {
  symbol?: string;
  interval?: string;
  /** Injectable so exports are reproducible in tests. */
  now?: Date;
}

/* ---------------------------------------------------------------- the entry */

type ReadOutcome = { drawing: StoredDrawing } | { reason: string };

function readPoint(raw: unknown): StoredPoint | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const p = raw as Record<string, unknown>;
  const timestamp = p.timestamp;
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return null;
  const value = p.value;
  return typeof value === "number" && Number.isFinite(value) ? { timestamp, value } : { timestamp };
}

/**
 * Validate and rebuild one drawing. `index` only feeds the human reason, so a
 * skipped entry can be pointed at in the UI instead of vanishing silently.
 */
function readDrawing(raw: unknown, index: number): ReadOutcome {
  const at = `第 ${index + 1} 条`;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { reason: `${at}：不是一个对象` };
  const o = raw as Record<string, unknown>;
  const name = typeof o.name === "string" ? o.name.trim() : "";
  if (!name) return { reason: `${at}：缺少画线工具名` };
  if (!toolOf(name)) return { reason: `${at}：${name} 不是可复现的画线工具` };
  if (!Array.isArray(o.points)) return { reason: `${at}：points 应为数组` };
  const points: StoredPoint[] = [];
  for (const p of o.points) {
    const point = readPoint(p);
    if (point) points.push(point);
  }
  if (points.length === 0) return { reason: `${at}：没有落在某根 K 线上的落点` };
  const style = normalizeDrawingStyle(o.style);
  const wanted = typeof o.paneId === "string" ? o.paneId.trim() : "";
  const paneId = isRestorablePaneId(wanted) ? wanted : MAIN_PANE_ID;
  return {
    drawing: {
      name,
      paneId,
      points,
      ...(style ? { style } : {}),
      ...(o.lock === true ? { lock: true } : {}),
      ...(o.hidden === true ? { hidden: true } : {}),
    },
  };
}

/** Public single-entry form: the cleaned drawing, or null when unusable. */
export function sanitizeStoredDrawing(raw: unknown): StoredDrawing | null {
  const out = readDrawing(raw, 0);
  return "drawing" in out ? out.drawing : null;
}

/* ------------------------------------------------------------------- files */

function cleanAll(drawings: readonly StoredDrawing[]): StoredDrawing[] {
  const list: StoredDrawing[] = [];
  for (const d of drawings) {
    const out = readDrawing(d, list.length);
    if ("drawing" in out) list.push(out.drawing);
  }
  return list;
}

/** A pretty, diff-friendly `.json` document, ready to drop in a repo or a chat. */
export function exportDrawingsJson(drawings: readonly StoredDrawing[], meta: ExchangeMeta = {}): string {
  const list = cleanAll(drawings);
  const bundle: DrawingBundle = {
    kind: DRAWING_BUNDLE_KIND,
    version: DRAWING_BUNDLE_VERSION,
    from: {
      symbol: meta.symbol ?? "",
      interval: meta.interval ?? "",
      exportedAt: (meta.now ?? new Date()).toISOString(),
      count: list.length,
    },
    drawings: list,
  };
  return JSON.stringify(bundle, null, 2);
}

export interface DrawingsImport {
  ok: true;
  drawings: StoredDrawing[];
  /** One line per rejected entry, so nothing fails silently. */
  skipped: string[];
  /** `symbol|interval` the file claims to come from; "" when it does not say. */
  from: string;
}

export interface DrawingsFailure {
  ok: false;
  error: string;
}

export type DrawingsOutcome = DrawingsImport | DrawingsFailure;

function collect(list: readonly unknown[], from: string): DrawingsImport {
  const drawings: StoredDrawing[] = [];
  const skipped: string[] = [];
  list.forEach((raw, i) => {
    const out = readDrawing(raw, i);
    if ("drawing" in out) drawings.push(out.drawing);
    else skipped.push(out.reason);
  });
  if (drawings.length > MAX_DRAWINGS_PER_BUCKET) {
    const drop = drawings.length - MAX_DRAWINGS_PER_BUCKET;
    drawings.splice(0, drop);
    skipped.push(`超过 ${MAX_DRAWINGS_PER_BUCKET} 条上限，最早的 ${drop} 条已丢弃`);
  }
  return { drawings, from, ok: true, skipped };
}

/** Bundle envelope, bare array, or a hand-made single drawing. */
function resolveList(parsed: unknown): readonly unknown[] | null {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if ("drawings" in o) return Array.isArray(o.drawings) ? o.drawings : null;
  return [parsed];
}

function sourceLabel(parsed: unknown): string {
  const from = (parsed as { from?: unknown } | null)?.from;
  if (!from || typeof from !== "object") return "";
  const o = from as { symbol?: unknown; interval?: unknown };
  const symbol = typeof o.symbol === "string" ? o.symbol.trim() : "";
  const interval = typeof o.interval === "string" ? o.interval.trim() : "";
  if (symbol && interval) return drawingsBucket(symbol, interval);
  return symbol;
}

/** Parse a `.json` drawing file. Never throws: bad input comes back as `error`. */
export function importDrawingsJson(raw: string): DrawingsOutcome {
  const trimmed = raw.trim();
  if (!trimmed) return { ok: false, error: "内容是空的" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (e) {
    return { ok: false, error: `不是合法的 JSON：${e instanceof Error ? e.message : String(e)}` };
  }
  const list = resolveList(parsed);
  if (!list) return { ok: false, error: "文件里没有画线：既不是数组，也没有 drawings" };
  return collect(list, sourceLabel(parsed));
}

/** `vt-drawings-<symbol>-<interval>-<yyyymmdd>.json`, safe as a filename. */
export function drawingsFileName(symbol: string, interval: string, now = new Date()): string {
  const slug = (s: string) => (s.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "") || "chart");
  const p2 = (n: number) => String(n).padStart(2, "0");
  const day = `${now.getFullYear()}${p2(now.getMonth() + 1)}${p2(now.getDate())}`;
  return `vt-drawings-${slug(symbol)}-${slug(interval)}-${day}.json`;
}

/* ------------------------------------------------------------------- merge */

/**
 * Identity of a line: pane + tool + geometry. Colour, width and the lock/hide
 * flags are **not** part of it — restyling and re-importing must not double up.
 * The pane *is* (⑲): the same two points on the price chart and on MACD are two
 * different lines, and collapsing them would drop one of them on import.
 */
export function drawingKey(d: StoredDrawing): string {
  return `${d.paneId || MAIN_PANE_ID}|${d.name}|${d.points.map((p) => `${p.timestamp}:${p.value ?? ""}`).join(",")}`;
}

export interface DrawingMerge {
  added: number;
  /** Entries dropped because that exact line is already on the chart. */
  duplicates: number;
  /** Existing first, then the new ones — the order the chart restores in. */
  drawings: StoredDrawing[];
  /** Only the accepted incoming ones, in file order: what a live chart has to add. */
  fresh: StoredDrawing[];
}

/** Import is idempotent: running it twice on the same chart adds nothing. */
export function mergeDrawings(
  existing: readonly StoredDrawing[],
  incoming: readonly StoredDrawing[],
): DrawingMerge {
  const seen = new Set<string>();
  const drawings: StoredDrawing[] = [];
  /** The accepted incoming entries; `null` while the existing set seeds `seen`. */
  const fresh: StoredDrawing[] = [];
  const keep = (list: readonly StoredDrawing[], collect: StoredDrawing[] | null) => {
    let added = 0;
    let duplicates = 0;
    for (const d of list) {
      if (!d || typeof d.name !== "string" || !Array.isArray(d.points)) continue;
      const key = drawingKey(d);
      if (seen.has(key)) {
        duplicates += 1;
        continue;
      }
      seen.add(key);
      drawings.push(d);
      collect?.push(d);
      added += 1;
    }
    return { added, duplicates };
  };
  keep(existing, null);
  const accepted = keep(incoming, fresh);
  return { added: accepted.added, drawings, duplicates: accepted.duplicates, fresh };
}

/* ------------------------------------------------------------- share links */

interface ShareBody {
  v: number;
  d: unknown;
  f?: string;
}

/** Encode the current markings into a URL that reopens them. */
export async function createDrawingsShareLink(
  drawings: readonly StoredDrawing[],
  meta: ExchangeMeta = {},
  base = `${window.location.origin}${window.location.pathname}`,
): Promise<ShareLink> {
  const list = cleanAll(drawings);
  const from = meta.symbol && meta.interval ? drawingsBucket(meta.symbol, meta.interval) : "";
  const body: ShareBody = { v: DRAWING_BUNDLE_VERSION, d: list, ...(from ? { f: from } : {}) };
  const payload = await encodeSharePayload(body);
  const url = shareUrl(base, DRAWING_SHARE_QUERY_KEY, payload);
  return {
    url,
    length: url.length,
    verbose: url.length > SHARE_LINK_SOFT_LIMIT,
    codec: payload[0] === "g" ? "g" : "j",
  };
}

function shareBody(parsed: unknown): unknown {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return parsed;
  const d = (parsed as { d?: unknown }).d;
  return d === undefined ? parsed : d;
}

/** Read a drawing link, a bare query string, or just the payload. */
export async function readDrawingsShareLink(input: string): Promise<DrawingsOutcome> {
  const payload = extractPayload(input, DRAWING_SHARE_QUERY_KEY);
  if (!payload) return { ok: false, error: "链接里没有画线分享码" };
  let parsed: unknown;
  try {
    parsed = await decodeSharePayload(payload);
  } catch (e) {
    return { ok: false, error: shareCodeMessage(e) };
  }
  const list = resolveList(shareBody(parsed));
  if (!list) return { ok: false, error: "分享码里没有画线" };
  const from = typeof (parsed as ShareBody | null)?.f === "string" ? ((parsed as ShareBody).f as string) : "";
  return collect(list, from);
}
