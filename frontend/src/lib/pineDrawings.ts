import { registerOverlay, type Chart, type KLineData, type OverlayFigure } from "klinecharts";
import type { PineDrawing } from "./pineTypes";

/**
 * Overlay rendering for the Pine drawing channel (2c).
 *
 * The interpreter records `bgcolor`/`barcolor`/`label`/`box`/`line`/`table` into
 * `PineResult.drawings` (bar-index / price space). Here those are turned into
 * KLineChart **overlays** — the object system, not indicator `text` figures,
 * because (memory aac3e542) the indicator text primitive shares one `figure.key`
 * for placement and content and loses its position, whereas an overlay figure is
 * positioned from its own pixel coordinate. Everything is registered once and
 * CSP-safe: no `eval`, no `new Function` — only the documented `registerOverlay`
 * template callback.
 *
 * Two honesty guarantees inherited from the recording layer and preserved here:
 *  - these overlays never feed the pass-rate `produced` metric (they are not a
 *    plot line or marker), and
 *  - every drawing is `lock`ed + `ignoreEvent`, so a script-owned decoration can
 *    never be dragged or deleted by the user and never joins the persisted
 *    drawing bank — it is re-derived from the script on every mount.
 */

/** Registered-overlay names, kept private so nothing else mounts them by hand. */
const NAME = {
  bg: "pineBg",
  bar: "pineBar",
  label: "pineLabel",
  line: "pineLine",
  box: "pineBox",
  table: "pineTable",
} as const;

/** Data handed to a template through `overlay.extendData`. */
interface BgData {
  color: string;
  alpha: number;
}
interface BarData {
  color: string;
  alpha: number;
}
interface LabelData {
  text: string;
  fg?: string;
  bg?: string;
}
interface LineData {
  color?: string;
  width?: number;
  dashed?: boolean;
}
interface BoxData {
  border?: string;
  bg?: string;
}
interface TableData {
  corner: number;
  cells: { row: number; col: number; text: string; bg?: string; fg?: string }[];
}

const FALLBACK = "#9e9e9e";

/** "#rrggbb" + alpha → "rgba(r,g,b,a)"; anything else passes through. */
function withAlpha(hex: string | undefined, alpha: number): string {
  if (!hex) return FALLBACK;
  const a = Math.max(0, Math.min(1, alpha));
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const n = parseInt(m[1], 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

/**
 * Anchor one drawing point in `dataIndex`/value space. `dataIndex` is the bar
 * index the interpreter already worked in, and the chart resolves x from it
 * directly, so no bar→timestamp conversion is needed (and it survives a scroll).
 */
function pt(bar: number, value: number) {
  return { dataIndex: Math.max(0, Math.round(bar)), value };
}

let registered = false;

/** Register the six Pine overlay templates once per process. Idempotent. */
function ensureRegistered(): void {
  if (registered) return;
  registered = true;

  registerOverlay({
    name: NAME.bg,
    totalStep: 3,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, bounding, overlay }) => {
      if (coordinates.length < 2) return [];
      const d = overlay.extendData as BgData;
      const x0 = Math.min(coordinates[0].x, coordinates[1].x);
      const x1 = Math.max(coordinates[0].x, coordinates[1].x);
      return [
        {
          type: "rect",
          ignoreEvent: true,
          attrs: { x: x0, y: 0, width: Math.max(1, x1 - x0), height: bounding.height },
          styles: { style: "fill", color: withAlpha(d.color, d.alpha) },
        },
      ];
    },
  });

  registerOverlay({
    name: NAME.bar,
    totalStep: 3,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, overlay }) => {
      if (coordinates.length < 2) return [];
      const d = overlay.extendData as BarData;
      // A recoloured candle reads as a thick vertical spine over its range.
      return [
        {
          type: "line",
          ignoreEvent: true,
          attrs: { coordinates: [coordinates[0], coordinates[1]] },
          styles: { style: "solid", size: 3, color: withAlpha(d.color, d.alpha) },
        },
      ];
    },
  });

  registerOverlay({
    name: NAME.label,
    totalStep: 2,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, overlay }) => {
      if (coordinates.length < 1) return [];
      const d = overlay.extendData as LabelData;
      if (!d.text) return [];
      return [
        {
          type: "text",
          ignoreEvent: true,
          attrs: { x: coordinates[0].x, y: coordinates[0].y, text: d.text, align: "center", baseline: "middle" },
          styles: {
            style: d.bg ? "fill" : "none",
            color: d.fg ?? "#ffffff",
            backgroundColor: d.bg ?? "transparent",
            size: 11,
            paddingLeft: 3,
            paddingTop: 2,
            paddingRight: 3,
            paddingBottom: 2,
          },
        },
      ];
    },
  });

  registerOverlay({
    name: NAME.line,
    totalStep: 3,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, overlay }) => {
      if (coordinates.length < 2) return [];
      const d = overlay.extendData as LineData;
      return [
        {
          type: "line",
          ignoreEvent: true,
          attrs: { coordinates: [coordinates[0], coordinates[1]] },
          styles: {
            style: d.dashed ? "dashed" : "solid",
            size: d.width && d.width > 0 ? d.width : 1,
            color: d.color ?? FALLBACK,
            dashedValue: d.dashed ? [4, 4] : [1, 0],
          },
        },
      ];
    },
  });

  registerOverlay({
    name: NAME.box,
    totalStep: 3,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ coordinates, overlay }) => {
      if (coordinates.length < 2) return [];
      const d = overlay.extendData as BoxData;
      const x = Math.min(coordinates[0].x, coordinates[1].x);
      const y = Math.min(coordinates[0].y, coordinates[1].y);
      return [
        {
          type: "rect",
          ignoreEvent: true,
          attrs: { x, y, width: Math.max(1, Math.abs(coordinates[1].x - coordinates[0].x)), height: Math.max(1, Math.abs(coordinates[1].y - coordinates[0].y)) },
          styles: {
            style: d.bg ? "stroke_fill" : "stroke",
            color: d.bg ?? "transparent",
            borderColor: d.border ?? FALLBACK,
            borderSize: 1,
          },
        },
      ];
    },
  });

  registerOverlay({
    name: NAME.table,
    totalStep: 2,
    needDefaultPointFigure: false,
    needDefaultXAxisFigure: false,
    needDefaultYAxisFigure: false,
    createPointFigures: ({ bounding, overlay }) => buildTableFigures(overlay.extendData as TableData, bounding.width, bounding.height),
  });
}

const CELL_W = 72;
const CELL_H = 22;

/** Pine `position.*` corner codes → an origin in the pane box (pixel space). */
function tableOrigin(corner: number, w: number, h: number, tw: number, th: number) {
  // The `position` enum is not a single monotonic index (top_*/middle_*/bottom_*
  // blocks of three). Rather than pin every value, bucket it: higher corners sit
  // lower, and the odd/even spread left/right. Decorative grid placement.
  const bottom = corner >= 6;
  const right = corner === 3 || corner === 6 || corner === 9 || corner % 3 === 0;
  const centerCol = corner === 2 || corner === 5 || corner === 8;
  const x = centerCol ? (w - tw) / 2 : right ? w - tw - 4 : 4;
  const y = bottom ? h - th - 4 : (h - th) / 2;
  return { x: Math.max(2, x), y: Math.max(2, y) };
}

/** Lay a table's cells out as a corner-anchored rect+text grid (pixel space). */
function buildTableFigures(d: TableData, paneW: number, paneH: number): OverlayFigure[] {
  if (!d.cells || d.cells.length === 0) return [];
  const cols = d.cells.reduce((m, c) => Math.max(m, c.col + 1), 0);
  const rows = d.cells.reduce((m, c) => Math.max(m, c.row + 1), 0);
  const { x: ox, y: oy } = tableOrigin(d.corner, paneW, paneH, cols * CELL_W, rows * CELL_H);
  const figures: OverlayFigure[] = [];
  const texts: { x: number; y: number; text: string; baseline: string }[] = [];
  for (const c of d.cells) {
    const cx = ox + c.col * CELL_W;
    const cy = oy + c.row * CELL_H;
    figures.push({
      type: "rect",
      ignoreEvent: true,
      attrs: { x: cx, y: cy, width: CELL_W, height: CELL_H },
      styles: { style: "fill", color: c.bg ?? "#1e222d" },
    });
    if (c.text) texts.push({ x: cx + 4, y: cy + CELL_H / 2, text: c.text, baseline: "middle" });
  }
  if (texts.length) {
    figures.push({ type: "text", ignoreEvent: true, attrs: texts, styles: { style: "none", color: "#d1d4dc", size: 11 } });
  }
  return figures;
}

/** A stable group id so a script's overlays can be cleared as a unit. */
export function pineGroupId(id: string): string {
  return `pine:${id}`;
}

/** Drop every overlay this script owns (before a re-mount, and on removal). */
export function clearPineDrawings(chart: Chart, groupId: string): void {
  try {
    chart.removeOverlay({ groupId });
  } catch {
    // A chart without an overlay layer, or nothing to clear: nothing to do.
  }
}

interface OverlayCreateLite {
  name: string;
  paneId: string;
  groupId: string;
  lock: boolean;
  zLevel: number;
  points: { dataIndex: number; value: number }[];
  extendData: unknown;
}

function toCreate(name: string, points: { dataIndex: number; value: number }[], extendData: unknown, zLevel: number, groupId: string, paneId: string): OverlayCreateLite {
  return { name, paneId, groupId, lock: true, zLevel, points, extendData };
}

/**
 * Paint the recorded drawings onto `chart` under `groupId`, replacing whatever
 * the same script drew before. Bar indices map straight to `dataIndex`, so the
 * bars list is only consulted for a candle's high/low/close (bg / barcolor).
 * Drawings land in `paneId` — the pane the owning indicator occupies, since a
 * TradingView `bgcolor` fills that study's own pane, not always the candles.
 */
export function applyPineDrawings(
  chart: Chart,
  drawings: PineDrawing[],
  bars: readonly KLineData[],
  groupId: string,
  paneId: string,
): void {
  clearPineDrawings(chart, groupId);
  if (drawings.length === 0) return;
  // Best-effort rendering: the numeric indicator is already mounted by the time
  // we get here, so a chart without overlay support (or a test that stubs the
  // library) must degrade to "no shapes drawn", never break the mount.
  try {
    ensureRegistered();
  } catch {
    return;
  }

  const barAt = (i: number): KLineData | null => {
    if (bars.length === 0) return null;
    return bars[Math.max(0, Math.min(bars.length - 1, Math.round(i)))] ?? null;
  };

  const creates: OverlayCreateLite[] = [];
  for (const d of drawings) {
    if (d.kind === "bg") {
      const v0 = barAt(d.startBar)?.close ?? 0;
      const v1 = barAt(d.endBar)?.close ?? 0;
      creates.push(toCreate(NAME.bg, [pt(d.startBar, v0), pt(d.endBar, v1)], { color: d.color, alpha: d.alpha } satisfies BgData, 0, groupId, paneId));
    } else if (d.kind === "bar") {
      const bb = barAt(d.bar);
      if (!bb) continue;
      creates.push(toCreate(NAME.bar, [pt(d.bar, bb.high), pt(d.bar, bb.low)], { color: d.color, alpha: d.alpha } satisfies BarData, 1, groupId, paneId));
    } else if (d.kind === "label") {
      creates.push(toCreate(NAME.label, [pt(d.bar, d.price)], { text: d.text, fg: d.fg, bg: d.bg } satisfies LabelData, 3, groupId, paneId));
    } else if (d.kind === "line") {
      creates.push(toCreate(NAME.line, [pt(d.x1, d.y1), pt(d.x2, d.y2)], { color: d.color, width: d.width, dashed: d.dashed } satisfies LineData, 2, groupId, paneId));
    } else if (d.kind === "box") {
      creates.push(toCreate(NAME.box, [pt(d.x1, d.y1), pt(d.x2, d.y2)], { border: d.border, bg: d.bg } satisfies BoxData, 0, groupId, paneId));
    } else if (d.kind === "table") {
      // A corner-anchored overlay still needs one valid anchor point.
      creates.push(toCreate(NAME.table, [pt(0, barAt(0)?.close ?? 0)], { corner: d.corner, cells: d.cells } satisfies TableData, 4, groupId, paneId));
    }
  }

  for (const c of creates) {
    try {
      chart.createOverlay(c);
    } catch {
      // One bad shape must not break the rest of the drawings.
    }
  }
}
