/**
 * `matrix.*` for the Pine compatibility layer.
 *
 * Pine matrices are *mutable reference objects* just like arrays and maps:
 * `var m = matrix.new<float>(rows, cols)` creates one and `matrix.set(m, r, c, v)`
 * mutates that same object so the next bar — and every alias that holds the same
 * reference (a function parameter, a reassignment target) — still sees it.
 *
 * Value model: a matrix is a `V[]` of **row** `V[]`s — `[ [r0c0, r0c1, …],
 * [r1c0, …], … ]`. We reuse the existing `V[]` value type rather than widen the
 * `V` union (which would ripple through every `Array.isArray` / `asNum` / `asStr`
 * branch), and `readSeries` hands the live array back by reference, so in-place
 * mutation of an inner row persists exactly as it does for arrays/maps. `rows` is
 * the outer length, `columns` the first row's length.
 *
 * Scope note: every real corpus script calls matrices **free-form**
 * (`matrix.set(m, r, c, v)`). Method-form (`m.set(r, c, v)`) is deliberately not
 * routed — a matrix, an array and a map are all `V[]`, so a bare `x.get(...)`
 * cannot be disambiguated by shape. Free-form dispatches by the `matrix.` prefix
 * and stays unambiguous.
 */

import { NA, asNum, sentinel, type BuiltinCtx, type V } from "./pineTypes";

const VOID = sentinel("void");

/** A Pine matrix operation: (matrix rows, params) → value. */
export type MatrixOp = (m: V[], p: V[], c: BuiltinCtx) => V;

/** Coerce a row/column index to a non-negative integer, or -1 when invalid. */
function idx(v: V | undefined): number {
  const n = asNum(v ?? NA);
  return Number.isNaN(n) || n < 0 ? -1 : Math.trunc(n);
}

/** Is `v` a matrix value (an array whose elements are arrays)? */
function isMatrix(v: V): v is V[] {
  return Array.isArray(v) && v.every((row) => Array.isArray(row));
}

/** Read one cell, or NA when out of bounds. */
function cell(m: V[], r: number, c: number): V {
  const row = m[r];
  if (!Array.isArray(row)) return NA;
  return (row[c] ?? NA) as V;
}

export const MATRIX_OPS: Record<string, MatrixOp> = {
  rows: (m) => m.length,
  columns: (m) => (m.length ? ((m[0] as V[]).length) : 0),
  get: (m, p) => {
    const r = idx(p[0]);
    const c = idx(p[1]);
    return r < 0 || c < 0 ? NA : cell(m, r, c);
  },
  set: (m, p) => {
    const r = idx(p[0]);
    const c = idx(p[1]);
    if (r < 0 || c < 0) return VOID;
    const row = m[r];
    if (Array.isArray(row)) row[c] = p[2] ?? NA;
    return VOID;
  },
  // `matrix.copy` builds an independent deep copy so later `matrix.set` on the
  // source (or the copy) does not leak through the shared reference.
  copy: (m) => m.map((row) => (Array.isArray(row) ? [...row] : row)) as V[],
  // `matrix.sort`/`matrix.floor`/etc. are rare and unused by the corpus; only the
  // seven functions real v6 scripts call are implemented (the corpus harness
  // reports any missing one honestly instead of silently no-op'ing).
  mult: (a, p) => {
    const b = p[0];
    if (!isMatrix(a) || !isMatrix(b)) return NA;
    const aRows = a.length;
    const aCols = aRows ? (a[0] as V[]).length : 0;
    const bRows = (b as V[]).length;
    const bCols = bRows ? ((b as V[])[0] as V[]).length : 0;
    // Matrix multiplication needs matching inner dimensions; Pine raises an
    // error there. We surface NA (an empty result) so the caller's downstream
    // math propagates na rather than throwing mid-backtest.
    if (aCols !== bRows) return NA;
    const out: V[] = [];
    for (let i = 0; i < aRows; i++) {
      const rowA = a[i] as V[];
      const row: V[] = [];
      for (let j = 0; j < bCols; j++) {
        let sum = 0;
        let na = false;
        for (let k = 0; k < aCols; k++) {
          const x = asNum(rowA[k] as V);
          const y = asNum(((b as V[])[k] as V[])[j] as V);
          if (Number.isNaN(x) || Number.isNaN(y)) {
            na = true;
            break;
          }
          sum += x * y;
        }
        row.push(na ? NA : sum);
      }
      out.push(row);
    }
    return out;
  },
};

/**
 * Constructors. `matrix.new()` / the generic `matrix.new<float>()` (generics
 * stripped by the parser) both arrive as plain `new`. `matrix.new(rows, cols)`
 * fills with na; `matrix.new(rows, cols, initial)` fills every cell with
 * `initial`. The typed shorthands (`matrix.new_float()`, …) build the same
 * empty/initialised matrix.
 */
function buildNew(p: V[]): V[] {
  const rows = idx(p[0]);
  const cols = idx(p[1]);
  if (rows < 0 || cols < 0) return [];
  const init = p.length >= 3 ? p[2] : NA;
  const out: V[] = [];
  for (let r = 0; r < rows; r++) {
    const row: V[] = [];
    for (let c = 0; c < cols; c++) row.push(init as V);
    out.push(row);
  }
  return out;
}

export const MATRIX_CTOR: Record<string, (p: V[]) => V[]> = {
  new: buildNew,
  new_int: buildNew,
  new_float: buildNew,
  new_bool: buildNew,
  new_string: buildNew,
  new_color: buildNew,
  new_time: buildNew,
  new_datetime: buildNew,
};

/** Bare method names for the free-form `matrix.<op>` dispatch. */
export const MATRIX_METHODS = new Set([...Object.keys(MATRIX_OPS), ...Object.keys(MATRIX_CTOR)]);
