/**
 * `map.*` for the Pine compatibility layer.
 *
 * Like arrays, Pine maps are *mutable reference objects*: `var m =
 * map.new<string, float>()` creates one and `map.put(m, k, v)` mutates that same
 * object so the next bar still sees it. We reuse the existing `V[]` value type
 * rather than widen the `V` union (which would ripple through every
 * `Array.isArray` / `asNum` / `asStr` branch in the interpreter): a map is an
 * **interleaved** `[k0, v0, k1, v1, …]` array, and `readSeries` already hands
 * the live array back by reference, so in-place mutation persists exactly as it
 * does for arrays.
 *
 * Scope note: every real corpus script calls maps **free-form**
 * (`map.put(m, k, v)`). Method-form (`m.put(k, v)`) is deliberately not routed —
 * a map and an array are both `V[]`, and `get`/`size`/`clear`/`remove` exist in
 * both libraries, so a bare `x.get(...)` cannot be disambiguated by shape. Free-
 * form dispatches by the `map.`/`array.` prefix and stays unambiguous.
 */

import { NA, asStr, sentinel, type BuiltinCtx, type V } from "./pineTypes";

const VOID = sentinel("void");

/** A Pine map operation: (interleaved entries, params) → value. */
export type MapOp = (m: V[], p: V[], c: BuiltinCtx) => V;

/** Value equality for keys: numbers compare exactly (na never matches), text by string. */
function keyEq(a: V, b: V): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b;
  return asStr(a) === asStr(b);
}

/** Index of the entry whose key matches `k`, or -1. */
function findKey(m: V[], k: V): number {
  for (let i = 0; i < m.length; i += 2) if (keyEq(m[i] as V, k)) return i;
  return -1;
}

export const MAP_OPS: Record<string, MapOp> = {
  size: (m) => m.length / 2,
  get: (m, p) => {
    const i = findKey(m, p[0] as V);
    return i < 0 ? NA : (m[i + 1] as V);
  },
  // `map.get(m, k, default)` — Pine returns the default when the key is absent.
  getdefault: (m, p) => {
    const i = findKey(m, p[0] as V);
    return i < 0 ? (p[1] ?? NA) : (m[i + 1] as V);
  },
  put: (m, p) => {
    const k = p[0] as V;
    const v = p[1] ?? NA;
    const i = findKey(m, k);
    if (i < 0) {
      m.push(k, v);
    } else {
      m[i + 1] = v;
    }
    return VOID;
  },
  // `remove` deletes in place and returns void (Pine's return value is unused).
  remove: (m, p) => {
    const i = findKey(m, p[0] as V);
    if (i >= 0) m.splice(i, 2);
    return VOID;
  },
  contains: (m, p) => (findKey(m, p[0] as V) >= 0 ? 1 : 0),
  keys: (m) => m.filter((_, i) => i % 2 === 0),
  values: (m) => m.filter((_, i) => i % 2 === 1),
  clear: (m) => {
    m.length = 0;
    return VOID;
  },
};

/**
 * Constructors. `map.new()` / the generic `map.new<key, value>()` (stripped by
 * the parser) both arrive as plain `new` and yield an empty map. The typed
 * forms (`map.new_string_float()`, …) exist in Pine but are rare; they build an
 * empty map too. `map.new(keys, values)` pairs two arrays when given.
 */
export const MAP_CTOR: Record<string, (p: V[]) => V[]> = {
  new: (p) => pairArgs(p),
  new_int: (p) => pairArgs(p),
  new_float: (p) => pairArgs(p),
  new_string: (p) => pairArgs(p),
  new_bool: (p) => pairArgs(p),
  new_time: (p) => pairArgs(p),
  new_color: (p) => pairArgs(p),
  new_datetime: (p) => pairArgs(p),
};

/** `map.new()` → []; `map.new(keys[], values[])` → interleaved pairs. */
function pairArgs(p: V[]): V[] {
  const keys = p[0];
  const vals = p[1];
  if (!Array.isArray(keys) || !Array.isArray(vals)) return [];
  const out: V[] = [];
  for (let i = 0; i < Math.min(keys.length, vals.length); i += 1) {
    out.push(keys[i] as V, vals[i] as V);
  }
  return out;
}

/** Bare method names for the free-form `map.<op>` dispatch. */
export const MAP_METHODS = new Set([...Object.keys(MAP_OPS), ...Object.keys(MAP_CTOR)]);
