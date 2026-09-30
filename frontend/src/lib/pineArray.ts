/**
 * `array.*` for the Pine compatibility layer.
 *
 * Pine arrays are *mutable reference objects*: `var float[] buf =
 * array.new_float()` creates one, and `array.push(buf, v)` changes that same
 * object so the next bar still sees it. The interpreter already stores every
 * variable as a scalar or a `V[]`, and `readSeries` hands back the live `V[]`
 * object by reference — so an array is just a `V[]` whose contents we mutate in
 * place, no separate object model required.
 *
 * Two call shapes reach here (both routed by pineRuntime):
 *   - free form  `array.push(buf, v)`  → self comes from the first value;
 *   - method form `buf.push(v)`         → self is the variable the call hangs on.
 * Constructors (`array.new_float(...)` / the generic `array.new<float>(...)`)
 * are free-form only and never carry a self.
 */

import { NA, asNum, asStr, sentinel, type BuiltinCtx, type V } from "./pineTypes";

const VOID = sentinel("void");

/** A Pine array operation: (target, params) → value. */
export type ArrayOp = (arr: V[], p: V[], c: BuiltinCtx) => V;

/** Truncated integer index; NaN/na → -1 so callers can treat it as "off-range". */
function idx(v: V | undefined): number {
  const k = Math.trunc(asNum(v as V));
  return Number.isNaN(k) ? -1 : k;
}

/** Value equality: numbers compare exactly (na never matches), text by string. */
function eq(a: V, b: V): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b;
  return asStr(a) === asStr(b);
}

/** The finite numeric view of an array, for the aggregating helpers. */
function nums(arr: V[]): number[] {
  const out: number[] = [];
  for (const v of arr) {
    const n = asNum(v);
    if (Number.isFinite(n)) out.push(n);
  }
  return out;
}

function median(sorted: number[]): number {
  const n = sorted.length;
  if (!n) return NA;
  const s = [...sorted].sort((a, b) => a - b);
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
}

export const ARRAY_OPS: Record<string, ArrayOp> = {
  size: (arr) => arr.length,
  get: (arr, p) => {
    const i = idx(p[0]);
    return i >= 0 && i < arr.length ? arr[i] : NA;
  },
  set: (arr, p) => {
    const i = idx(p[0]);
    if (i >= 0 && i < arr.length) arr[i] = p[1] ?? NA;
    return VOID;
  },
  // `array.fill(a, value, index_from?, index_to?)` — set a run of elements to a
  // single value. With no indices it fills the whole array (the seeding idiom
  // RGMA / ZLEMA / Stoch use: `array.fill(buf, source)` to prime every stage at
  // once); `index_from` (default 0) and `index_to` (default na → through the end,
  // exclusive) narrow the run. Mutates in place and returns void, like `set`.
  fill: (arr, p) => {
    const value = (p.length >= 1 ? p[0] : NA) as V;
    const from = p.length >= 2 ? Math.max(0, idx(p[1])) : 0;
    const toRaw = p.length >= 3 ? idx(p[2]) : -1;
    const to = toRaw < 0 ? arr.length : Math.min(toRaw, arr.length);
    for (let i = from; i < to; i += 1) arr[i] = value;
    return VOID;
  },
  push: (arr, p) => {
    arr.push(p[0] ?? NA);
    return VOID;
  },
  unshift: (arr, p) => {
    arr.unshift(p[0] ?? NA);
    return VOID;
  },
  pop: (arr) => (arr.length ? (arr.pop() as V) : NA),
  shift: (arr) => (arr.length ? (arr.shift() as V) : NA),
  // `remove` returns a NEW array with the element gone; the source is untouched.
  remove: (arr, p) => {
    const i = idx(p[0]);
    return i < 0 ? arr.slice() : arr.filter((_, k) => k !== i);
  },
  // `remove_at` deletes in place and returns void.
  remove_at: (arr, p) => {
    const i = idx(p[0]);
    if (i >= 0 && i < arr.length) arr.splice(i, 1);
    return VOID;
  },
  insert: (arr, p) => {
    const i = idx(p[0]);
    arr.splice(i < 0 ? arr.length : Math.min(i, arr.length), 0, p[1] ?? NA);
    return VOID;
  },
  clear: (arr) => {
    arr.length = 0;
    return VOID;
  },
  first: (arr) => (arr.length ? arr[0] : NA),
  last: (arr) => (arr.length ? arr[arr.length - 1] : NA),
  includes: (arr, p) => (arr.some((x) => eq(x, p[0] as V)) ? 1 : 0),
  indexof: (arr, p) => {
    const i = arr.findIndex((x) => eq(x, p[0] as V));
    return i < 0 ? NA : i;
  },
  last_indexof: (arr, p) => {
    for (let i = arr.length - 1; i >= 0; i -= 1) if (eq(arr[i], p[0] as V)) return i;
    return NA;
  },
  reverse: (arr) => {
    arr.reverse();
    return VOID;
  },
  // `sort` returns a NEW sorted array (Pine does not sort in place).
  sort: (arr, p) => {
    const descending = typeof p[0] === "string" && p[0].includes("descending");
    const sign = descending ? -1 : 1;
    const numeric = nums(arr).length === arr.length && arr.length > 0;
    const copy = arr.slice();
    copy.sort((a, b) => (numeric ? (asNum(a) - asNum(b)) * sign : (asStr(a) < asStr(b) ? -1 : asStr(a) > asStr(b) ? 1 : 0) * sign));
    return copy;
  },
  slice: (arr, p) => {
    const s = Math.max(0, idx(p[0]));
    const eRaw = p.length > 1 ? idx(p[1]) : arr.length;
    const e = eRaw < 0 ? arr.length : Math.min(eRaw, arr.length);
    return arr.slice(s, Math.max(s, e));
  },
  concat: (arr, p) => (Array.isArray(p[0]) ? arr.concat(p[0] as V[]) : arr.slice()),
  copy: (arr) => arr.slice(),
  sum: (arr) => {
    const v = nums(arr);
    return v.length ? v.reduce((a, b) => a + b, 0) : NA;
  },
  avg: (arr) => {
    const v = nums(arr);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NA;
  },
  max: (arr) => {
    const v = nums(arr);
    return v.length ? Math.max(...v) : NA;
  },
  min: (arr) => {
    const v = nums(arr);
    return v.length ? Math.min(...v) : NA;
  },
  median: (arr) => median(nums(arr)),
  stdev: (arr) => {
    const v = nums(arr);
    if (v.length < 2) return NA;
    const m = v.reduce((a, b) => a + b, 0) / v.length;
    return Math.sqrt(v.reduce((a, b) => a + (b - m) * (b - m), 0) / (v.length - 1));
  },
};

/**
 * Constructors: `array.new[_type](_size=0, _value=default)`. The first argument
 * is always the size, so `array.new_float(1)` yields `[na]`, not a one-element
 * array holding 1. Generic `array.new<float>(…)` reaches here as plain `new`.
 */
export const ARRAY_CTOR: Record<string, (p: V[]) => V[]> = {
  new: makeCtor(NA),
  // `array.from(a, b, c)` builds an array from its arguments directly.
  from: (p) => p.slice(),
  new_float: makeCtor(NA),
  new_int: makeCtor(NA),
  new_time: makeCtor(NA),
  new_datetime: makeCtor(NA),
  new_color: makeCtor(NA),
  new_bool: makeCtor(0),
  new_string: makeCtor(""),
  // Deprecated per-type constructors for drawing handles (`array.new_line()`
  // in older scripts): they hold opaque ids, so an na-filled array is enough.
  new_line: makeCtor(NA),
  new_box: makeCtor(NA),
  new_label: makeCtor(NA),
};

function makeCtor(valueDefault: V): (p: V[]) => V[] {
  return (p) => {
    const size = idx(p[0]);
    const val = p.length >= 2 ? p[1] : valueDefault;
    return Array.from({ length: size > 0 ? size : 0 }, () => val as V);
  };
}

/** Bare method names accepted in the `arr.method(...)` call form. */
export const ARRAY_METHODS = new Set([...Object.keys(ARRAY_OPS), ...Object.keys(ARRAY_CTOR)]);
