import type { Chart } from "klinecharts";
import { isSubPaneId, subPaneNameOf } from "./paneLayout";

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
 *
 * 4. Per-drawing colour is `overlay.styles`, a **deep partial** of the global
 *    `styles.overlay` (d.ts 1122). Figure styles are resolved as
 *    `{ ...defaultStyles[type], ...overlay.styles?.[type], ...figure.styles }`
 *    (dist 8955), so the overlay fragment only wins where the overlay template
 *    itself does not pin the same key — none of the six tools we expose does
 *    (`brush` adds `lineCap/lineJoin` only, dist 11944-11960). Defaults are
 *    `line: { color: '#1677FF', size: 1, style: 'solid' }` (dist 11774-11780).
 *    Changing a drawing that already exists is `overrideOverlay({ id, styles })`
 *    (d.ts 978): it goes through `getOverlaysByFilter` (dist 14285-14298), whose
 *    `isValid` only rejects null/undefined — a filter **without** an id matches
 *    every drawing on the chart, so the id is not optional. Same family of
 *    footgun as `removeIndicator`.
 *
 * 5. Two per-drawing flags make the list usable, and both are read straight off
 *    the overlay instance (d.ts 1073 / 1077): `lock` is honoured by
 *    `_figureMouseDownEvent` (dist 8731-8734) so the line stops following the
 *    mouse — but *only* there: clicking to select (8746) and right-click delete
 *    (8774) ignore it — and `visible: false` is honoured by `OverlayView.drawImp`
 *    (dist 8895-8899), which skips the overlay *before* its figures are handed
 *    to the event tree, so a hidden line is neither painted nor clickable.
 *    Neither flag is a style, so `overrideOverlay` accepts them as top-level keys
 *    (`override()` merges everything except id/name/currentStep/points/styles,
 *    dist 8280-8281) — but `shouldUpdate()` (dist 8314-8318) watches
 *    zLevel/points/visible/extendData/styles and **not `lock`**, so a lock-only
 *    change repaints nothing and `overrideOverlay` answers `false` even though it
 *    worked. Trust the instance, not the return value.
 *
 * 6. A drawing belongs to a **pane**, and ⑲ made that address worth storing.
 *    The first click re-homes the overlay (`updateProgressOverlayInfo`,
 *    dist 8508-8510, which also overrides the instance's `paneId`), so a tool
 *    armed against `candle_pane` still ends up on whichever pane the user hit
 *    first — which is the TradingView gesture and costs nothing to support. What
 *    it used to cost was the reload: sub panes were named by
 *    `createId('indicator_pane_')` (dist 15271), i.e. random per mount, so the
 *    stored id named a pane that no longer existed and `createOverlay` quietly
 *    redirected the line to the main chart at the old pane's scale. Stable pane
 *    ids (`paneLayout.subPaneIdOf`) plus `isRestorablePaneId` below are the fix;
 *    a line whose pane is genuinely absent is *parked* rather than redirected.
 */

/** The pane every draw tool starts on; a first click can move it (see ⑲). */
export const MAIN_PANE_ID = "candle_pane";

/**
 * A `paneId` a stored drawing can be given back to.
 *
 * `createOverlay` does not complain about an unknown pane — it rewrites the
 * overlay onto the candle pane and keeps the value the file carried
 * (`paneLayout.ts` quotes the lines), so accepting a stale or invented id is
 * how a saved volume-scale line ends up on the price axis. Only the main chart
 * and this app's own `sub:` panes pass.
 */
export function isRestorablePaneId(paneId: string): boolean {
  return paneId === MAIN_PANE_ID || isSubPaneId(paneId);
}

/** Which indicator a sub-pane id names, or "" for the main chart. */
export function paneIndicator(paneId: string): string {
  return paneId === MAIN_PANE_ID ? "" : subPaneNameOf(paneId);
}

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
  // ⑲: the first click decides the pane, so "main chart" would be a lie — and
  // saying nothing would leave the sub-pane gesture undiscoverable.
  if (tool.clicks < 0) return `「${tool.label}」：在主图或任一副图上按住拖动，松开即完成（Esc 取消）`;
  return `「${tool.label}」：点击 ${tool.clicks} 个落点，第一个落点在主图还是副图，这条线就归谁（Esc 取消，点同一按钮可退出）`;
}

/** What a drawing looks like: only the three things the toolbar exposes. */
export interface DrawingStyle {
  /** CSS colour shared by the line, its handles and its value label. */
  color: string;
  /** Line width in px. */
  size: number;
  /** Dashed instead of solid. */
  dashed: boolean;
}

/**
 * What the library draws with when an overlay carries no `styles` of its own,
 * i.e. `Color.BLUE` (dist 11371). Keeping it here means "default" is never
 * stored, so an old drawing stays in sync if the library ever changes its mind.
 */
export const DEFAULT_DRAWING_STYLE: DrawingStyle = { color: "#1677FF", size: 1, dashed: false };

export const DRAWING_COLORS: ReadonlyArray<{ label: string; value: string }> = [
  { label: "蓝", value: "#1677FF" },
  { label: "红", value: "#F23645" },
  { label: "绿", value: "#089981" },
  { label: "橙", value: "#FF9800" },
  { label: "紫", value: "#B45BF7" },
];

export const DRAWING_SIZES: ReadonlyArray<number> = [1, 2, 3];

const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

/** `#rgb`/`#rrggbb` -> `rgba(r, g, b, a)`; anything else is passed through. */
export function withAlpha(hex: string, alpha: number): string {
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return hex;
  const digits = m[1].length === 3 ? m[1].split("").map((c) => c + c).join("") : m[1];
  const n = parseInt(digits, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function isDefaultStyle(s: DrawingStyle): boolean {
  return s.color === DEFAULT_DRAWING_STYLE.color && s.size === DEFAULT_DRAWING_STYLE.size && !s.dashed;
}

/** Coerce anything readable into a style; returns null when it is unusable. */
export function normalizeDrawingStyle(value: unknown): DrawingStyle | null {
  if (!value || typeof value !== "object") return null;
  const v = value as { color?: unknown; size?: unknown; dashed?: unknown };
  if (typeof v.color !== "string" || !HEX_COLOR_RE.test(v.color)) return null;
  const size = typeof v.size === "number" && Number.isFinite(v.size) ? Math.min(6, Math.max(1, Math.round(v.size))) : DEFAULT_DRAWING_STYLE.size;
  return { color: v.color.toUpperCase(), size, dashed: v.dashed === true };
}

/**
 * The subset of `styles.overlay` we ever write. The index signature is not
 * decoration: `OverlayStyle` carries one (d.ts 494), and `DeepPartial` keeps it,
 * so a narrow interface without it is refused by `createOverlay`/`overrideOverlay`.
 */
export interface OverlayStyleFragment {
  line?: { color?: string; size?: number; style?: "solid" | "dashed"; dashedValue?: number[] };
  point?: { color?: string; borderColor?: string; activeColor?: string; activeBorderColor?: string };
  text?: { color?: string; borderColor?: string; backgroundColor?: string };
  [key: string]: unknown;
}

/**
 * The `overlay.styles` fragment for a style. Line, handles and the value label
 * all follow the chosen colour, because a red line with a blue price tag (the
 * library default, dist 11744-11761) reads as a bug.
 */
export function overlayStylesOf(style: DrawingStyle): OverlayStyleFragment {
  return {
    line: {
      color: style.color,
      size: style.size,
      style: style.dashed ? "dashed" : "solid",
      dashedValue: [4, 2],
    },
    point: {
      color: style.color,
      borderColor: withAlpha(style.color, 0.35),
      activeColor: style.color,
      activeBorderColor: withAlpha(style.color, 0.35),
    },
    text: {
      color: "#FFFFFF",
      borderColor: style.color,
      backgroundColor: style.color,
    },
  };
}

interface StyleFragment {
  line?: { color?: unknown; size?: unknown; style?: unknown };
}

/**
 * Read the style back off an overlay instance, so a restyled line survives a
 * reload. Returns undefined for the untouched default (keeps storage clean) and
 * for anything structurally odd (a template may store styles elsewhere).
 */
export function styleOfOverlay(overlay: unknown): DrawingStyle | undefined {
  const line = (overlay as { styles?: StyleFragment | null } | null | undefined)?.styles?.line;
  if (!line) return undefined;
  const color = typeof line.color === "string" && HEX_COLOR_RE.test(line.color) ? line.color.toUpperCase() : null;
  const size =
    typeof line.size === "number" && Number.isFinite(line.size) ? Math.min(6, Math.max(1, Math.round(line.size))) : null;
  if (color === null && size === null) return undefined;
  const style: DrawingStyle = {
    color: color ?? DEFAULT_DRAWING_STYLE.color,
    size: size ?? DEFAULT_DRAWING_STYLE.size,
    dashed: line.style === "dashed",
  };
  return isDefaultStyle(style) ? undefined : style;
}

export interface StoredPoint {
  timestamp?: number;
  value?: number;
}

export interface StoredDrawing {
  name: string;
  paneId: string;
  points: StoredPoint[];
  /** Absent means "whatever the library defaults to". */
  style?: DrawingStyle;
  /** Absent means the line is still draggable (see header note 5). */
  lock?: true;
  /** Absent means the line is visible. */
  hidden?: true;
}

/** Minimal surface these helpers need, so tests can hand in a fake chart. */
export type OverlayHost = Pick<
  Chart,
  "getOverlays" | "createOverlay" | "removeOverlay" | "overrideOverlay"
>;

interface OverlayLike {
  id?: string;
  name?: string;
  paneId?: string;
  points?: StoredPoint[];
  currentStep?: number;
  isDrawing?: () => boolean;
  lock?: boolean;
  visible?: boolean;
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
    const style = styleOfOverlay(o);
    out.push({
      name: o.name,
      paneId: o.paneId ?? MAIN_PANE_ID,
      points,
      ...(style ? { style } : {}),
      // Flags are only written when they deviate from the library default, so a
      // plain line keeps costing exactly what it costed before ⑰.
      ...(o.lock === true ? { lock: true as const } : {}),
      ...(o.visible === false ? { hidden: true as const } : {}),
    });
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
  /**
   * A drawing was clicked / lost the click. The library fires these from
   * `_processOverlaySelectedEvent` / `...Deselected...` (dist 8687-8702), which
   * is the only way to learn what the user is pointing at — the toolbar needs
   * it to answer "which line should this colour apply to?".
   *
   * Switching lines fires `onDeselected`(old) **then** `onSelected`(new), and
   * clicking the same line again fires neither (dist 14543-14549); an empty
   * click on the chart deselects. Callers must therefore clear the marker by
   * id, not unconditionally.
   */
  onSelected?: (overlay: unknown) => void;
  onDeselected?: (overlay: unknown) => void;
}

/** Payload shape the library passes to the overlay event callbacks. */
interface OverlayEventArg {
  overlay?: unknown;
}

export function makeDrawingEvents(
  hooks: DrawingEvents,
): Record<
  "onDrawEnd" | "onRemoved" | "onPressedMoveEnd" | "onSelected" | "onDeselected",
  (e: OverlayEventArg) => void
> {
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
    onSelected: (e) => hooks.onSelected?.(e?.overlay),
    onDeselected: (e) => hooks.onDeselected?.(e?.overlay),
  };
}

/** Asks whether a pane is on the chart right now (`chart.getPaneOptions(id)`). */
export type PaneLookup = (paneId: string) => boolean;

/**
 * Assume every pane exists. Used when the caller has no way to look — a chart
 * stub in a test, or a host that predates `getPaneOptions`.
 */
export const ALL_PANES_PRESENT: PaneLookup = () => true;

export interface RestoreReport {
  /** Drawings that got an overlay, in the order they were handed over. */
  applied: StoredDrawing[];
  /**
   * Drawings kept off the chart because their pane is not on it (⑲).
   *
   * The alternative is what the library does for you: `createOverlay` rewrites
   * an unknown `paneId` onto the candle pane (dist 15364-15367) and leaves the
   * value alone, so a MACD line at 0.35 becomes a price line at ¥0.35 — glued to
   * the bottom of a ¥1300 chart, i.e. the invisible drawing ⑭ was reported for.
   * Parking keeps the line in storage and out of the picture until the indicator
   * comes back.
   */
  parked: StoredDrawing[];
}

/** Re-create stored drawings; reports what landed and what is waiting for a pane. */
export function restoreDrawings(
  chart: OverlayHost,
  drawings: readonly StoredDrawing[],
  events?: ReturnType<typeof makeDrawingEvents>,
  paneExists: PaneLookup = ALL_PANES_PRESENT,
): RestoreReport {
  const applied: StoredDrawing[] = [];
  const parked: StoredDrawing[] = [];
  for (const d of drawings) {
    if (!d || typeof d.name !== "string" || !d.name) continue;
    const points = (d.points ?? []).filter(hasCoordinates);
    if (points.length === 0) continue;
    const paneId = d.paneId || MAIN_PANE_ID;
    if (!isRestorablePaneId(paneId) || !paneExists(paneId)) {
      parked.push({ ...d, paneId });
      continue;
    }
    // Restored drawings are editable too, so they carry the same events as a
    // tool-drawn one — otherwise only the drawings made *this session* stay in
    // sync, and a restored line that gets deleted comes back on reload.
    const id = chart.createOverlay({
      name: d.name,
      paneId,
      points,
      ...(d.style ? { styles: overlayStylesOf(d.style) } : {}),
      ...(d.lock ? { lock: true } : {}),
      ...(d.hidden ? { visible: false } : {}),
      ...events,
    });
    if (id) applied.push({ ...d, paneId });
    else parked.push({ ...d, paneId });
  }
  return { applied, parked };
}

/**
 * Restyle a drawing that already exists.
 *
 * `id` is mandatory by construction. `overrideOverlay` filters through
 * `getOverlaysByFilter`, which treats a *missing* id as "no constraint" and
 * therefore matches **every** overlay (dist 14289-14297) — one click would
 * repaint the whole chart in a single colour. An empty string is the mirror
 * image: it matches nothing, so the call silently does nothing. Both are wrong
 * answers, and neither is worth distinguishing, so they are refused together.
 */
export function applyDrawingStyle(chart: OverlayHost, id: string, style: DrawingStyle): boolean {
  if (!id) return false;
  return chart.overrideOverlay({ id, styles: overlayStylesOf(style) });
}

/** What the list panel can flip on a line, without touching its look. */
export interface DrawingFlags {
  lock?: boolean;
  hidden?: boolean;
}

/**
 * Lock or hide one drawing (local custom ⑰).
 *
 * `id` is mandatory for the same reason as `applyDrawingStyle`: without it
 * `getOverlaysByFilter` matches every overlay and one click would grey out the
 * whole chart. The library's own answer is not usable as a verdict here — see
 * header note 5 — so the instance is read back and compared.
 */
export function applyDrawingFlags(chart: OverlayHost, id: string, flags: DrawingFlags): boolean {
  if (!id) return false;
  const override: Record<string, unknown> = { id };
  if (typeof flags.lock === "boolean") override.lock = flags.lock;
  if (typeof flags.hidden === "boolean") override.visible = !flags.hidden;
  if (Object.keys(override).length < 2) return false; // nothing asked for
  chart.overrideOverlay(override);
  const current = chart.getOverlays({ id })[0] as OverlayLike | undefined;
  if (!current) return false;
  if (typeof flags.lock === "boolean" && (current.lock === true) !== flags.lock) return false;
  if (typeof flags.hidden === "boolean" && (current.visible === false) !== flags.hidden) return false;
  return true;
}

/** One row of the drawing list: everything needed to name, aim at and clean up a line. */
export interface DrawingRow {
  id: string;
  /** The KLineChart overlay name, e.g. `priceLine`. */
  name: string;
  /** Toolbar label, or the raw name for a tool we do not ship. */
  label: string;
  style: DrawingStyle;
  locked: boolean;
  hidden: boolean;
  /** Where the line lives; its scale is what `detail` reports (⑲). */
  paneId: string;
  /** Where the line sits: bar time(s) and/or the pane's own value. Empty when unknown. */
  detail: string;
  /** How many points the line is made of (brush can be in the hundreds). */
  pointCount: number;
}

function numbers(points: readonly StoredPoint[], key: keyof StoredPoint): number[] {
  const out: number[] = [];
  for (const p of points) {
    const v = p?.[key];
    if (typeof v === "number" && Number.isFinite(v)) out.push(v);
  }
  return out;
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/**
 * `MM-DD`, plus `HH:mm` when the bar is not a session open. Daily bars arrive
 * at local midnight (the chart runs on Asia/Shanghai), and printing `00:00`
 * next to them reads like a bug in a list meant to be scanned at a glance.
 */
export function formatBarTime(ms: number): string {
  const t = ms < 1e12 ? ms * 1000 : ms;
  const d = new Date(t);
  const day = `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  return d.getHours() === 0 && d.getMinutes() === 0 ? day : `${day} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function formatPrice(v: number): string {
  return String(Number(v.toFixed(2)));
}

/** A one-line description of where a drawing is; null when it is not a drawing. */
export function describeDrawing(overlay: unknown): DrawingRow | null {
  const o = overlay as OverlayLike | null | undefined;
  if (!o || typeof o.id !== "string" || !o.id) return null;
  if (isInProgress(o)) return null;
  const name = typeof o.name === "string" ? o.name : "";
  if (!name) return null;
  const points = Array.isArray(o.points) ? o.points : [];
  const paneId = typeof o.paneId === "string" && o.paneId ? o.paneId : MAIN_PANE_ID;
  const stamps = numbers(points, "timestamp");
  const values = numbers(points, "value");
  const bits: string[] = [];
  if (stamps.length > 0) {
    const first = formatBarTime(stamps[0]);
    const last = formatBarTime(stamps[stamps.length - 1]);
    bits.push(first === last ? first : `${first} → ${last}`);
  }
  if (values.length > 0) {
    // "价位" on a MACD pane is the same lie as the invisible line: the number is
    // real and the reader's unit is wrong (⑭, again, in the reporting half).
    const unit = paneId === MAIN_PANE_ID ? "价位" : "值";
    const first = formatPrice(values[0]);
    bits.push(values.length === 1 ? `${unit} ${first}` : `${first} → ${formatPrice(values[values.length - 1])}`);
  }
  return {
    id: o.id,
    name,
    label: toolOf(name)?.label ?? name,
    style: styleOfOverlay(o) ?? { ...DEFAULT_DRAWING_STYLE },
    locked: o.lock === true,
    hidden: o.visible === false,
    paneId,
    detail: bits.join(" · "),
    pointCount: points.length,
  };
}

/**
 * Every finished drawing, in chart order (the order the library hit-tests, so
 * the newest line is listed last and is also the one 撤销 takes). Half-drawn
 * overlays are left out: they have no coordinates yet and cannot be restored.
 */
export function listDrawings(chart: OverlayHost): DrawingRow[] {
  const rows: DrawingRow[] = [];
  for (const raw of chart.getOverlays()) {
    const row = describeDrawing(raw);
    if (row) rows.push(row);
  }
  return rows;
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
/** What one symbol+interval bucket can hold; importers use the same ceiling. */
export const MAX_DRAWINGS_PER_BUCKET = 200;
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
    const list = drawings.slice(-MAX_DRAWINGS_PER_BUCKET);
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

// ---------------------------------------------------------------------------
// The last used style is a preference, not chart data: it follows the user
// across symbols, while each drawing keeps its own copy in the bucket above.
// ---------------------------------------------------------------------------

const STYLE_KEY = "pro-chart.drawStyle.v1";

export function loadDrawingStyle(): DrawingStyle {
  try {
    const raw = localStorage.getItem(STYLE_KEY);
    if (!raw) return { ...DEFAULT_DRAWING_STYLE };
    const parsed: unknown = JSON.parse(raw);
    return normalizeDrawingStyle(parsed) ?? { ...DEFAULT_DRAWING_STYLE };
  } catch {
    return { ...DEFAULT_DRAWING_STYLE };
  }
}

export function saveDrawingStyle(style: DrawingStyle): void {
  try {
    localStorage.setItem(STYLE_KEY, JSON.stringify(style));
  } catch {
    /* best effort */
  }
}
