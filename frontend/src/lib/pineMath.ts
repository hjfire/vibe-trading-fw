/**
 * Non-`ta` built-ins for the Pine compatibility layer: `math.*`, `str.*`,
 * type casts, date helpers, colors, and the un-prefixed aliases real scripts
 * still use (`abs(x)` shows up in plenty of v4/v5 ports).
 *
 * Keys are the **full dotted name** exactly as the lexer produces it, so the
 * runtime dispatches with a single lookup. Strings only matter for plot titles
 * and label text, so `str.*` returns plain JS strings instead of modelling
 * Pine's string type.
 *
 * Plotting (`plot`/`hline`/`fill`…), `input.*`, `strategy.*` and the built-in
 * variables (time/close/bar_index/…) live in pineRuntime.ts — they mutate the
 * interpreter's output state, which a pure function table cannot do.
 */

import { PineError, type Arg } from "./pineLang";
import {
  NA,
  asNum,
  asStr,
  numArg,
  resolveColor,
  sentinel,
  type Builtin,
  type BuiltinCtx,
  type V,
} from "./pineTypes";

/** Numeric view of argument slot `i` (evaluated lazily through the ctx). */
function n(args: Arg[], c: BuiltinCtx, i: number, def = NA): number {
  const a = args[i];
  if (!a) return def;
  return asNum(c.val(a.value));
}

function collect(args: Arg[], c: BuiltinCtx): number[] {
  return args.map((a) => asNum(c.val(a.value)));
}

function text(args: Arg[], c: BuiltinCtx, i: number, def = ""): string {
  const a = args[i];
  return a ? asStr(c.val(a.value)) : def;
}

const finite = (v: number): boolean => Number.isFinite(v);

function foldNums(args: Arg[], c: BuiltinCtx, f: (a: number, b: number) => number): number {
  const v = collect(args, c).filter(finite);
  if (!v.length) return NA;
  return v.reduce((a, b) => f(a, b));
}

function mean(v: number[]): number {
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : NA;
}

function moment(v: number[], k: (x: number, m: number) => number): number {
  if (v.length < 1) return NA;
  const m = mean(v);
  return v.reduce((a, b) => a + k(b, m), 0);
}

/** Date part of an explicit timestamp argument, else of the current bar. */
function datePart(args: Arg[], c: BuiltinCtx, pick: (d: Date) => number): number {
  const t = args.length ? n(args, c, 0) : c.bars.time[c.bi] ?? NA;
  if (Number.isNaN(t) || !Number.isFinite(t)) return NA;
  return pick(new Date(t));
}

export const MISC: Record<string, Builtin> = {
  /* ------------------------------------------------------------- math.* */
  "math.abs": (args, c) => Math.abs(n(args, c, 0)),
  "math.ceil": (args, c) => Math.ceil(n(args, c, 0)),
  "math.floor": (args, c) => Math.floor(n(args, c, 0)),
  "math.sign": (args, c) => {
    const x = n(args, c, 0);
    return Number.isNaN(x) ? NA : Math.sign(x);
  },
  "math.sqrt": (args, c) => {
    const x = n(args, c, 0);
    return x >= 0 ? Math.sqrt(x) : NA;
  },
  "math.cbrt": (args, c) => Math.cbrt(n(args, c, 0)),
  "math.exp": (args, c) => Math.exp(n(args, c, 0)),
  "math.pow": (args, c) => Math.pow(n(args, c, 0), n(args, c, 1, 1)),
  "math.log": (args, c) => {
    const x = n(args, c, 0);
    if (!(x > 0)) return NA;
    if (args.length > 1) {
      const b = n(args, c, 1, Math.E);
      return b > 0 && b !== 1 ? Math.log(x) / Math.log(b) : NA;
    }
    return Math.log(x);
  },
  "math.log10": (args, c) => {
    const x = n(args, c, 0);
    return x > 0 ? Math.log10(x) : NA;
  },
  "math.log2": (args, c) => {
    const x = n(args, c, 0);
    return x > 0 ? Math.log2(x) : NA;
  },
  "math.round": (args, c) => {
    const x = n(args, c, 0);
    const d = Math.trunc(numArg(args, c, 1, 0, "digits"));
    const p = 10 ** d;
    return Math.round(x * p) / p;
  },
  "math.round_to_mintick": (args, c) => n(args, c, 0),
  "math.round_to_minmove": (args, c) => n(args, c, 0),
  "math.min": (args, c) => foldNums(args, c, Math.min),
  "math.max": (args, c) => foldNums(args, c, Math.max),
  "math.avg": (args, c) => mean(collect(args, c).filter(finite)),
  "math.sum": (args, c) => {
    const v = collect(args, c).filter(finite);
    return v.length ? v.reduce((a, b) => a + b, 0) : NA;
  },
  "math.dev": (args, c) => {
    const v = collect(args, c).filter(finite);
    return v.length ? moment(v, (x, m) => Math.abs(x - m)) / v.length : NA;
  },
  "math.variance": (args, c) => {
    const v = collect(args, c).filter(finite);
    return v.length > 1 ? moment(v, (x, m) => (x - m) ** 2) / (v.length - 1) : NA;
  },
  "math.stdev": (args, c) => {
    const s = asNum(MISC["math.variance"](args, c));
    return Number.isNaN(s) ? NA : Math.sqrt(s);
  },
  "math.std": (args, c) => MISC["math.stdev"](args, c),
  "math.corr": (args, c) => {
    const all = collect(args, c);
    const half = Math.floor(all.length / 2);
    const xs = all.slice(0, half);
    const ys = all.slice(half, half * 2);
    if (xs.length < 2 || xs.length !== ys.length) return NA;
    const mx = mean(xs);
    const my = mean(ys);
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < xs.length; i++) {
      const u = xs[i] - mx;
      const v = ys[i] - my;
      num += u * v;
      dx += u * u;
      dy += v * v;
    }
    return dx === 0 || dy === 0 ? NA : num / Math.sqrt(dx * dy);
  },
  "math.tostep": (args, c) => {
    const x = n(args, c, 0);
    const step = n(args, c, 1, 1);
    return step === 0 ? NA : Math.round(x / step) * step;
  },
  "math.closest": (args, c) => {
    const x = n(args, c, 0);
    const rest = collect(args.slice(1), c);
    if (!rest.length) return NA;
    return rest.reduce((best, v) => (Math.abs(v - x) < Math.abs(best - x) ? v : best), rest[0]);
  },
  "math.gcd": (args, c) => {
    let a = Math.abs(Math.trunc(n(args, c, 0)));
    let b = Math.abs(Math.trunc(n(args, c, 1, 0)));
    while (b) {
      const t = a % b;
      a = b;
      b = t;
    }
    return a;
  },
  "math.fib": (args, c) => {
    const k = Math.abs(Math.trunc(n(args, c, 0)));
    let a = 0;
    let b = 1;
    for (let i = 0; i < k; i++) {
      const t = a + b;
      a = b;
      b = t;
    }
    return a;
  },
  "math.todegrees": (args, c) => (n(args, c, 0) * 180) / Math.PI,
  "math.toradians": (args, c) => (n(args, c, 0) * Math.PI) / 180,
  "math.pi": () => Math.PI,
  "math.e": () => Math.E,
  "math.random": (_args, c) => {
    c.warn("math.random() 每次重算都会变化，已固定返回 0.5");
    return 0.5;
  },

  /* --------------------------------------------------------- type casts */
  int: (args, c) => Math.trunc(n(args, c, 0)),
  float: (args, c) => n(args, c, 0),
  bool: (args, c) => (n(args, c, 0) !== 0 ? 1 : 0),
  na: (args, c) => (args.length === 0 || Number.isNaN(n(args, c, 0)) ? 1 : 0),
  nz: (args, c) => {
    const v = args[0] ? c.val(args[0].value) : NA;
    return Number.isNaN(asNum(v)) ? (args[1] ? c.val(args[1].value) : 0) : v;
  },
  fixnan: (args, c) => {
    const v = c.val(args[0].value);
    const st = c.state(() => ({ last: NA as V }));
    if (Number.isNaN(asNum(v))) return st.last;
    st.last = v;
    return v;
  },
  flip: (args, c) => (n(args, c, 0) === 0 ? 1 : 0),
  iff: (args, c) => {
    // iff(cond, a, b) — the function form of the ternary, still seen in ports.
    const cond = n(args, c, 0);
    const slot = !Number.isNaN(cond) && cond !== 0 ? 1 : 2;
    return args[slot] ? c.val(args[slot].value) : NA;
  },
  iif: (args, c) => MISC.iff(args, c),
  tonumber: (args, c) => {
    const v = Number(text(args, c, 0));
    return Number.isFinite(v) ? v : NA;
  },
  tostring: (args, c) => asStr(args[0] ? c.val(args[0].value) : NA),
  char: (args, c) => String.fromCharCode(Math.trunc(n(args, c, 0))),
  chr: (args, c) => String.fromCharCode(Math.trunc(n(args, c, 0))),
  asc: (args, c) => text(args, c, 0).charCodeAt(0) ?? NA,

  /* ------------------------------------------------------------ str.* */
  "str.tostring": (args, c) => asStr(args[0] ? c.val(args[0].value) : NA),
  "str.concat": (args, c) => args.map((a) => asStr(c.val(a.value))).join(""),
  "str.length": (args, c) => text(args, c, 0).length,
  "str.contains": (args, c) => (text(args, c, 0).includes(text(args, c, 1)) ? 1 : 0),
  "str.startswith": (args, c) => (text(args, c, 0).startsWith(text(args, c, 1)) ? 1 : 0),
  "str.endswith": (args, c) => (text(args, c, 0).endsWith(text(args, c, 1)) ? 1 : 0),
  "str.substring": (args, c) => {
    const s = text(args, c, 0);
    const from = Math.max(0, Math.trunc(numArg(args, c, 1, 0, "start")));
    const to = Math.max(from, Math.trunc(numArg(args, c, 2, s.length, "end")));
    return s.slice(from, to);
  },
  "str.replace": (args, c) => {
    const s = text(args, c, 0);
    const from = text(args, c, 1);
    const to = text(args, c, 2, "");
    return from ? s.split(from).join(to) : s;
  },
  "str.replace_all": (args, c) => MISC["str.replace"](args, c),
  "str.replace_closest": (args, c) => MISC["str.replace"](args, c),
  "str.upper": (args, c) => text(args, c, 0).toUpperCase(),
  "str.lower": (args, c) => text(args, c, 0).toLowerCase(),
  "str.trim": (args, c) => text(args, c, 0).trim(),
  "str.split": () => [],
  "str.join": () => "",
  "str.match": () => "",
  "str.pos": (args, c) => text(args, c, 0).indexOf(text(args, c, 1)),
  "str.tonumber": (args, c) => MISC.tonumber(args, c),
  "str.tointeger": (args, c) => Math.trunc(asNum(MISC.tonumber(args, c))),
  "str.format": (args, c) => text(args, c, 0),
  "str.format_time": (args, c) => text(args, c, 0),

  /* ---------------------------- un-prefixed aliases (registered below) --- */
  /** `sum(x, n)` rolls a window; `sum(a, b, …)` folds scalars. */
  sum: (args, c) => {
    if (args.length === 2) {
      const x = n(args, c, 0);
      const keep = Math.max(1, Math.trunc(n(args, c, 1, 1)));
      const st = c.state(() => ({ win: [] as number[] }));
      st.win.push(Number.isNaN(x) ? 0 : x);
      if (st.win.length > keep) st.win.shift();
      return st.win.length >= keep ? st.win.reduce((a, b) => a + b, 0) : NA;
    }
    return MISC["math.sum"](args, c);
  },
  highest: (args, c) => foldNums(args, c, Math.max),
  lowest: (args, c) => foldNums(args, c, Math.min),
  "price.min": (args, c) => foldNums(args, c, Math.min),
  "price.max": (args, c) => foldNums(args, c, Math.max),
  // Bare `min/max/avg` are also called without a namespace in older ports.
  min: (args, c) => foldNums(args, c, Math.min),
  max: (args, c) => foldNums(args, c, Math.max),

  /* ----------------------------------------------------------- colors */
  // Transparency is dropped, but the base colour must survive as the value it
  // already is (a `@color.x` sentinel or a `#rrggbb` literal) — flattening it to
  // text here made `color.new(color.green, 90)` render the palette default.
  "color.new": (args, c) => (args[0] ? c.val(args[0].value) : sentinel("color.gray")),
  "color.rgb": () => sentinel("color.custom"),
  "color.tir": () => sentinel("color.custom"),
  "color.from_gradient": (_args, c) => {
    c.warn("color.from_gradient() 只影响配色，已用灰色替代");
    return sentinel("color.gray");
  },
  "color.aqua": () => sentinel("color.aqua"),
  "color.black": () => sentinel("color.black"),
  "color.blue": () => sentinel("color.blue"),
  "color.fuchsia": () => sentinel("color.fuchsia"),
  "color.gray": () => sentinel("color.gray"),
  "color.grey": () => sentinel("color.gray"),
  "color.green": () => sentinel("color.green"),
  "color.lime": () => sentinel("color.lime"),
  "color.maroon": () => sentinel("color.maroon"),
  "color.navy": () => sentinel("color.navy"),
  "color.olive": () => sentinel("color.olive"),
  "color.orange": () => sentinel("color.orange"),
  "color.purple": () => sentinel("color.purple"),
  "color.red": () => sentinel("color.red"),
  "color.silver": () => sentinel("color.silver"),
  "color.teal": () => sentinel("color.teal"),
  "color.white": () => sentinel("color.white"),
  "color.yellow": () => sentinel("color.yellow"),
  "color.transparent": () => sentinel("color.transparent"),
  /** Resolve a color argument to CSS (used by the renderer, not by scripts). */
  "color.resolve": (args, c) => resolveColor(args[0] ? c.val(args[0].value) : undefined) ?? "",

  /* ------------------------------------------------------- date & time */
  dayofmonth: (args, c) => datePart(args, c, (d) => d.getUTCDate()),
  dayofweek: (args, c) => datePart(args, c, (d) => (d.getUTCDay() === 0 ? 7 : d.getUTCDay() + 1)),
  month: (args, c) => datePart(args, c, (d) => d.getUTCMonth() + 1),
  year: (args, c) => datePart(args, c, (d) => d.getUTCFullYear()),
  hour: (args, c) => datePart(args, c, (d) => d.getUTCHours()),
  minute: (args, c) => datePart(args, c, (d) => d.getUTCMinutes()),
  second: (args, c) => datePart(args, c, (d) => d.getUTCSeconds()),
  weeks: (args, c) => n(args, c, 0) * 604800000,
  days: (args, c) => n(args, c, 0) * 86400000,
  hours: (args, c) => n(args, c, 0) * 3600000,
  minutes: (args, c) => n(args, c, 0) * 60000,
  seconds: (args, c) => n(args, c, 0) * 1000,
  milliseconds: (args, c) => n(args, c, 0),
  timestamp: (args, c) => {
    const y = Math.trunc(numArg(args, c, 0, 1970, "year"));
    const mo = Math.trunc(numArg(args, c, 1, 1, "month")) - 1;
    const d = Math.trunc(numArg(args, c, 2, 1, "dayofmonth", "dayofmonth ", "day"));
    const h = Math.trunc(numArg(args, c, 3, 0, "hour"));
    const mi = Math.trunc(numArg(args, c, 4, 0, "minute"));
    const s = Math.trunc(numArg(args, c, 5, 0, "second"));
    return Date.UTC(y, mo, d, h, mi, s);
  },
  "timeframe.in_seconds": (args, c) => {
    const tf = text(args, c, 0, "D");
    const m = /^(\d+)([MWDH])?$/.exec(tf.toUpperCase());
    if (!m) return NA;
    const k = Number(m[1]);
    const unit = (m[2] ?? "D") as "M" | "W" | "D" | "H";
    const per: Record<string, number> = { M: 60000, H: 3600000, D: 86400000, W: 604800000 };
    return k * per[unit];
  },
  "timeframe.change": () => 0,
  "timeframe.isseconds": () => 1,
  "timeframe.isminutes": () => 0,
  "timeframe.isdaily": () => 1,
  "timeframe.isweekly": () => 0,
  "timeframe.ismonthly": () => 0,
  "timeframe.isintraday": () => 0,
  "timeframe.period": () => "D",
  "timeframe.multiplier": () => "1",
  "timeframe.offset": () => "GMT+8",

  /* --------------------------------------------- tolerated but no numeric value */
  "str.tohex": (args, c) => Math.trunc(n(args, c, 0)).toString(16),
  "timenow": (_args, c) => c.bars.time[c.len - 1] ?? Date.now(),
  "tostring_all": (args, c) => asStr(args[0] ? c.val(args[0].value) : NA),
};

/**
 * Bare aliases for the `math.*` family. Assigned after the table literal so we
 * never read `MISC` during its own initialization.
 */
const MATH_ALIASES: Record<string, string> = {
  abs: "math.abs",
  ceil: "math.ceil",
  floor: "math.floor",
  round: "math.round",
  sign: "math.sign",
  sqrt: "math.sqrt",
  exp: "math.exp",
  pow: "math.pow",
  log: "math.log",
  log10: "math.log10",
  log2: "math.log2",
  avg: "math.avg",
  stdev: "math.stdev",
  variance: "math.variance",
  dev: "math.dev",
};
for (const [alias, target] of Object.entries(MATH_ALIASES)) {
  MISC[alias] = MISC[target];
}

/** Names that exist only as decorative no-ops (never numeric). */
export function isDecorativeName(name: string): boolean {
  return (
    /^(label|line|box|table|marker|sprite|chart|request|strategy\.risk|strategy\.allow_entry|indicator\.overrides)\./.test(name) ||
    /^(alert|alertcondition|syntax\.functions)$/.test(name)
  );
}

/** Reject names we knowingly do not model, with a reason instead of na silence. */
export function assertUnsupported(name: string): void {
  const hard: Record<string, string> = {
    array: "Pine 数组（array.*）暂未支持，请把累计逻辑改写成滚动函数",
    matrix: "Pine matrix 暂未支持",
    map: "Pine map 暂未支持",
    udt: "自定义类型（type）暂未支持",
  };
  const prefix = name.split(".")[0];
  if (hard[prefix]) throw new PineError(hard[prefix]);
}
