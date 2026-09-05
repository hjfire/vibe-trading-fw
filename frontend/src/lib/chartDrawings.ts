import type { Chart } from "klinecharts";

/**
 * Drawing tools: what the toolbar offers, and how to make it survive a reload
 * (local custom ⑭).
 *
 * Two things here are not obvious from the library:
 *
 * 1. `createOverlay(name)` already defaults to `candle_pane`, but it computes a
 *    point's **value from whichever pane received the mouse event**. With the
 *    main chart squeezed to a few pixels (see `paneLayout.ts`), clicks land on
 *    a sub pane and the stored value is on the volume axis — a "price line" at
 *    52 874 on a 1 300 price chart, i.e. a line nobody can see. So the pane is
 *    stated explicitly and the main chart is kept big enough to hit.
 *
 * 2. An overlay that is still being drawn shows up in `getOverlays()` with
 *    zero points (`isDrawing()` on the runtime instance, `currentStep >= 0`).
 *    Serializing those would persist half-finished drawings, and there is no
 *    public "cancel drawing" call — the way out is `removeOverlay({ id })`,
 *    which also drops the tool's waiting state.
 *
 * 3. The chart is editable after the fact and none of it reports back on its
 *    own: dragging a line rewrites `overlay.points` in place
 *    (`pressedMouseMoveEvent`, dist 8632-8654) and right-clicking one deletes it
 *    (`_figureMouseRightClickEvent` -> `removeOverlay`, dist 8774-8790). Both
 *    end in a callback (`onPressedMoveEnd` / `onRemoved`), so a drawing that was
 *    moved or deleted without those hooks wired keeps its **pre-edit** copy in
 *    storage — the line jumps back, or comes from the dead on the next reload.
 *    `removeOverlay` fires `onRemoved` *before* splicing the overlay out of the
 *    pane (dist 14467 vs 14475-14478), which is why the callback hands the id
 *    back to the caller instead of trusting `getOverlays()`.
 */

/** The pane every draw tool is pinned to. */
export const MAIN_PANE_ID = "candle_pane";

export interface DrawTool {
  label: string;
  /** A KLineChart v10 built-in overlay name (see `getSupportedOverlays()`). */
  name: string;
  /** Clicks the user has to make; drives the hint text. */
  clicks: number;
}

export const DRAW_TOOLS: DrawTool[] = [
  { label: "趋势线", name: "segment", clicks: 2 },
  { label: "射线", name: "rayLine", clicks: 2 },
  { label: "水平线", name: "horizontalStraightLine", clicks: 1 },
  { label: "价格线", name: "priceLine", clicks: 1 },
  { label: "斐波那契", name: "fibonacciLine", clicks: 2 },
  { label: "画笔", name: "brush", clicks: -1 }, // freehand: drag, double-click to finish
];

export function toolOf(name: string): DrawTool | undefined {
  return DRAW_TOOLS.find((t) => t.name === name);
}

/** Hint text for an armed tool; `-1` means freehand. */
export function drawHint(tool: DrawTool): string {
  if (tool.clicks < 0) return `「${tool.label}」：在主图上按住拖动，松开即完成（Esc 取消）`;
  return `「${tool.label}」：在主图上点击 ${tool.clicks} 个落点（Esc 取消，点同一按钮可退出）`;
}

export interface StoredPoint {
  timestamp?: number;
  value?: number;
}

export interface StoredDrawing {
  name: string;
  paneId: string;
  points: StoredPoint[];
}

/** Minimal surface these helpers need, so tests can hand in a fake chart. */
export type OverlayHost = Pick<Chart, "getOverlays" | "createOverlay" | "removeOverlay">;

interface OverlayLike {
  id?: string;
  name?: string;
  paneId?: string;
  points?: StoredPoint[];
  currentStep?: number;
  isDrawing?: () => boolean;
}

/** True while the user is still placing points. */
export function isInProgress(overlay: unknown): boolean {
  const o = overlay as OverlayLike | null | undefined;
  if (!o) return false;
  if (typeof o.isDrawing === "function") return o.isDrawing() === true;
  // A finished overlay sits at currentStep -1; anything >= 0 is mid-draw.
  return typeof o.currentStep === "number" && o.currentStep >= 0;
}

function hasCoordinates(p: StoredPoint | null | undefined): p is StoredPoint {
  return !!p && typeof p.timestamp === "number";
}

/**
 * Drop what cannot be re-created: half-drawn overlays, anonymous names, and
 * points with no timestamp (a raw `dataIndex` would point at a different bar
 * after the next page of history is prepended).
 *
 * `excludeId` covers the `onRemoved` case, where the overlay being deleted is
 * still in `getOverlays()` while the callback runs.
 */
export function serializeDrawings(overlays: readonly unknown[], excludeId?: string | null): StoredDrawing[] {
  const out: StoredDrawing[] = [];
  for (const raw of overlays) {
    if (isInProgress(raw)) continue;
    const o = raw as OverlayLike;
    if (!o || typeof o.name !== "string" || !o.name) continue;
    if (excludeId && o.id === excludeId) continue;
    const points = (o.points ?? []).filter(hasCoordinates).map((p) => ({
      ...(typeof p.timestamp === "number" ? { timestamp: p.timestamp } : {}),
      ...(typeof p.value === "number" ? { value: p.value } : {}),
    }));
    if (points.length === 0) continue;
    out.push({ name: o.name, paneId: o.paneId ?? MAIN_PANE_ID, points });
  }
  return out;
}

/**
 * The event bundle to hand `createOverlay` so every drawing — freshly armed or
 * restored from storage — keeps the persisted copy in step with the chart.
 *
 * `onChanged` is called with the id to leave out of the snapshot (only the
 * removal path passes one; see the header note about `onRemoved` firing before
 * the splice).
 */
export interface DrawingEvents {
  /** Something on the chart changed in a way worth banking; id = just-deleted. */
  onChanged: (excludeId: string | null) => void;
  /** A drawing finished: the armed-tool highlight has to go with it. */
  onDrawEnd?: () => void;
  /** A drawing vanished; tells the caller so a stuck tool can be released. */
  onRemoved?: (overlay: unknown) => void;
}

/** Payload shape the library passes to the overlay event callbacks. */
interface OverlayEventArg {
  overlay?: unknown;
}

export function makeDrawingEvents(
  hooks: DrawingEvents,
): Record<"onDrawEnd" | "onRemoved" | "onPressedMoveEnd", (e: OverlayEventArg) => void> {
  return {
    onDrawEnd: () => {
      hooks.onDrawEnd?.();
      hooks.onChanged(null);
    },
    onRemoved: (e) => {
      const removed = e?.overlay as OverlayLike | undefined;
      hooks.onRemoved?.(removed);
      hooks.onChanged(removed?.id ?? null);
    },
    // Covers both gestures: grabbing the line body (whole overlay) and grabbing
    // one of its handles (a single point) both end here.
    onPressedMoveEnd: () => {
      hooks.onChanged(null);
    },
  };
}

/** Re-create stored drawings; returns how many landed. */
export function restoreDrawings(
  chart: OverlayHost,
  drawings: readonly StoredDrawing[],
  events?: ReturnType<typeof makeDrawingEvents>,
): number {
  let applied = 0;
  for (const d of drawings) {
    if (!d || typeof d.name !== "string" || !d.name) continue;
    const points = (d.points ?? []).filter(hasCoordinates);
    if (points.length === 0) continue;
    // Restored drawings are editable too, so they carry the same events as a
    // tool-drawn one — otherwise only the drawings made *this session* stay in
    // sync, and a restored line that gets deleted comes back on reload.
    const id = chart.createOverlay({ name: d.name, paneId: d.paneId || MAIN_PANE_ID, points, ...events });
    if (id) applied += 1;
  }
  return applied;
}

/** Abandon every half-drawn overlay. Returns how many were dropped. */
export function cancelInProgress(chart: OverlayHost): number {
  const stuck = chart.getOverlays().filter(isInProgress);
  for (const raw of stuck) {
    const id = (raw as OverlayLike).id;
    if (id) chart.removeOverlay({ id });
  }
  return stuck.length;
}

/** Undo the most recent completed drawing. Returns its id, or null. */
export function removeLatestDrawing(chart: OverlayHost): string | null {
  const done = chart.getOverlays().filter((o) => !isInProgress(o));
  const last = done[done.length - 1] as OverlayLike | undefined;
  const id = last?.id;
  if (!id) return null;
  chart.removeOverlay({ id });
  return id;
}

// ---------------------------------------------------------------------------
// Per-symbol persistence: drawings belong to a chart, not to a page view.
// ---------------------------------------------------------------------------

const BUCKET_KEY = "pro-chart.drawings.v1";
const MAX_PER_BUCKET = 200;
const MAX_BUCKETS = 60;

export function drawingsBucket(symbol: string, interval: string): string {
  return `${symbol}|${interval}`;
}

type BucketMap = Record<string, StoredDrawing[]>;

function readBuckets(): BucketMap {
  try {
    const raw = localStorage.getItem(BUCKET_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: BucketMap = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!Array.isArray(value)) continue;
      const list = value.filter(
        (d): d is StoredDrawing =>
          !!d &&
          typeof d === "object" &&
          typeof (d as StoredDrawing).name === "string" &&
          Array.isArray((d as StoredDrawing).points),
      );
      if (list.length > 0) out[key] = list;
    }
    return out;
  } catch {
    return {};
  }
}

export function loadDrawings(symbol: string, interval: string): StoredDrawing[] {
  return readBuckets()[drawingsBucket(symbol, interval)] ?? [];
}

/** Empty list removes the bucket, so a cleared chart does not leak keys. */
export function saveDrawings(symbol: string, interval: string, drawings: readonly StoredDrawing[]): void {
  try {
    const buckets = readBuckets();
    const key = drawingsBucket(symbol, interval);
    const list = drawings.slice(-MAX_PER_BUCKET);
    if (list.length === 0) delete buckets[key];
    else buckets[key] = list;
    const keys = Object.keys(buckets);
    // Oldest buckets go first; this is a convenience cache, not an archive.
    for (const old of keys.slice(0, Math.max(0, keys.length - MAX_BUCKETS))) delete buckets[old];
    localStorage.setItem(BUCKET_KEY, JSON.stringify(buckets));
  } catch {
    /* quota / private mode: drawings stay in memory for this session */
  }
}
