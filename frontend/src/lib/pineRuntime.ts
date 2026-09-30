/**
 * Per-bar interpreter for the Pine Script compatibility layer.
 *
 * The execution model mirrors TradingView: the statement list runs once per
 * bar and every expression yields a scalar *at the current bar*. History is not
 * an array you index into — each variable and each call site keeps a rolling
 * buffer of finalized values, and `x[2]` reads two bars back.
 *
 * Split of responsibilities in the Pine layer:
 *   pineLang.ts    text → AST (nothing numeric happens there)
 *   pineRuntime.ts this file: bar loop, variables, plotting, inputs, orders
 *   pineTa.ts      `ta.*` state machines (recursive indicators need a slot)
 *   pineMath.ts    `math.*` / `str.*` / casts / dates / colors (pure helpers)
 *
 * Honesty rule: a name that would change the numbers and is not implemented is
 * a hard error listing what *is* available; only decorative APIs (label, box,
 * table, request.*, colors…) degrade to no-ops, and each downgrade is recorded
 * in `PineResult.warnings` so the UI can show it instead of hiding it.
 */

import { PineError, parsePine, type Arg, type Expr, type Stmt } from "./pineLang";
import { TA } from "./pineTa";
import { MISC, assertUnsupported, isDecorativeName, resolveBareConstant } from "./pineMath";
import { ARRAY_CTOR, ARRAY_METHODS, ARRAY_OPS } from "./pineArray";
import { MAP_CTOR, MAP_OPS } from "./pineMap";
import { MATRIX_CTOR, MATRIX_OPS } from "./pineMatrix";
import { OrderSim, estimateTick } from "./pineOrders";
import { inferTimeframeMs, resampleUp, tfToMs } from "./pineResample";
import {
  NA,
  NAMED_ONLY,
  argAt,
  asNum,
  asStr,
  flagArg,
  isNa,
  isTrue,
  numArg,
  resolveColor,
  sentinel,
  strArg,
  type BuiltinCtx,
  type PineBars,
  type PineInput,
  type PineLine,
  type PineMarker,
  type PineResult,
  type PineDrawing,
  type PlotStyle,
  type V,
} from "./pineTypes";

/**
 * Clause match for `switch subj`: numbers compare by value (so `na` never
 * matches — NaN !== NaN, mirroring Pine), anything else by string form (covers
 * string cases and `@`-sentinel colours/enums).
 */
function switchEq(a: V, b: V): boolean {
  if (typeof a === "number" && typeof b === "number") return a === b;
  return asStr(a) === asStr(b);
}

/** Hard caps: a pasted script must never freeze the chart tab. */
const HIST_CAP = 40000;
const OP_LIMIT = 2.5e7;
const LOOP_CAP = 5000;
/** Ceiling on live drawing objects, so a per-bar `.new` without `.delete`
 *  cannot grow the overlay list without bound. */
const DRAW_CAP = 4000;

/**
 * Thrown by `break`/`continue` and caught by the nearest enclosing loop. It is
 * a control signal, not an error, so it must never reach the per-bar catch in
 * runBody (which would turn it into an abort).
 */
class ControlFlow {
  constructor(readonly kind: "break" | "continue") {}
}

/** Sources selectable through `input.source()`. */
const SOURCE_KEYS = ["close", "open", "high", "low", "volume", "hl2", "hlc3", "hlcc4", "ohlc4"];

const SERIES_NAMES = new Set([
  "open", "high", "low", "close", "volume", "hl2", "hlc3", "hlcc4", "ohlc4", "time", "timenow",
]);

/**
 * v3/v4 series built-ins that became `ta.*` functions in v5 (per TradingView's
 * v4→v5 migration guide). Community scripts still read them as bare names, so
 * for `ver <= 4` an undefined bare identifier resolves through the matching
 * `ta.*` state machine. User variables of the same name win (this is consulted
 * only after scope lookup fails), and v5/v6 never see these as globals.
 */
const LEGACY_SERIES: Record<string, string> = {
  accdist: "ad",
  pvt: "pvt",
  obv: "obv",
  nvi: "nvi",
  pvi: "pvi",
};

/**
 * A live Pine drawing object (label/line/box/table), keyed by its handle.
 * Coordinates are bar indices / axis prices; `na` becomes `undefined` so the
 * renderer knows that axis was never placed. Mutated in place by the `set_*`
 * family; `.deleted` objects are dropped when the result is built.
 */
interface DrawObj {
  type: "label" | "line" | "box" | "table";
  x?: number;
  y?: number;
  x2?: number;
  y2?: number;
  text?: string;
  bg?: string;
  fg?: string;
  color?: string;
  width?: number;
  dashed?: boolean;
  corner?: number;
  cells?: Map<string, { text: string; bg?: string; fg?: string }>;
  deleted?: boolean;
}

/**
 * Date builtins readable through history (`year[1]`, `month[2]`, …). Values
 * match the pineMath zero-arg functions so `year == year[0]` holds; dayofweek
 * is 1=Sunday..7=Saturday. Not in SERIES_NAMES so a user variable that happens
 * to be named `year` is still read as the variable on a bare access.
 */
const DATE_FIELD: Record<string, (d: Date) => number> = {
  year: (d) => d.getUTCFullYear(),
  month: (d) => d.getUTCMonth() + 1,
  dayofmonth: (d) => d.getUTCDate(),
  dayofweek: (d) => d.getUTCDay() + 1,
  hour: (d) => d.getUTCHours(),
  minute: (d) => d.getUTCMinutes(),
  second: (d) => d.getUTCSeconds(),
};

/** Bare reads that are enum values rather than functions (`color.red`, …).
 *  Drawing-style constants are flat identifiers whose dot is part of the name
 *  (`line.style_solid`, `box.line_solid`, `label.style_label_down`,
 *  `extend.right`, `table.position_top_left`), so those namespaces must be
 *  listed here too — otherwise a plain read throws "undeclared identifier"
 *  and aborts a whole order-block / FVG indicator that only passed a style
 *  constant. Their `*.new` / `*.set_*` CALLS are routed separately (runDrawing),
 *  so widening this set turns those crashes into the harmless sentinel the
 *  drawing recorder already understands. */
const ENUM_NS =
  /^(color|location|plot|plotstyle|shape|circle|double|arrow|label|flag|square|cross|xcross|hline|order|position|trend|scale|text|chart|price_range|switch|syminfo|timeframe|duration|efl|format|ticksize|strategy|session|input|math|alert|display|size|barmerge|fontface|xloc|embed|line|linefill|box|table|extend)\./;

/** Memoized `ta.*` name list for error messages. */
let TA_LIST = "";
function availableTa(): string {
  if (!TA_LIST) TA_LIST = Object.keys(TA).slice(0, 40).join(" ");
  return TA_LIST;
}

interface Series {
  /** Finalized values, oldest first (one entry per bar already run). */
  hist: V[];
  /** Value for the bar being executed. */
  cur: V;
  /** Written during the current bar (non-`var` reads outside that are na). */
  live: boolean;
  /** `var x = …` keeps its value across bars. */
  persist: boolean;
}

type FnStmt = Extract<Stmt, { k: "fn" }>;

/** Recursion guard for user functions — Pine has none, so we must. */
const FN_DEPTH_CAP = 16;

export interface PineRunOptions {
  /** Override values by input order (matches `PineResult.inputs`). */
  params?: number[];
  /** Statement-evaluation budget; an overrun becomes a readable error. */
  opLimit?: number;
  /** Re-throw script errors instead of reporting them as warnings. */
  strict?: boolean;
  /**
   * Bars FINER than the chart, enabling `request.security_lower_tf`. Without
   * it there is no way to synthesize sub-bar detail, so that call returns an
   * empty array (scripts guard it with `array.size(..) > 0`).
   */
  lowerBars?: PineBars;
}

function numOrUndef(x: number): number | undefined {
  return Number.isFinite(x) ? x : undefined;
}

export class PineRuntime {
  private readonly stmts: Stmt[];
  private readonly ctx: BuiltinCtx;
  private readonly states = new Map<string, object>();
  private readonly env = new Map<string, Series>();

  private readonly lines: PineLine[] = [];
  private readonly lineByCid = new Map<number, PineLine>();
  private readonly markers: PineMarker[] = [];
  private readonly markerByCid = new Map<number, PineMarker>();
  private readonly hlines: { price: number; title: string; color?: string; style?: string }[] = [];
  private readonly hlineSeen = new Set<string>();
  private readonly inputs: PineInput[] = [];
  private readonly inputByCid = new Map<number, number>();
  private readonly warns: string[] = [];
  private readonly warnSeen = new Set<string>();
  /**
   * Drawing primitives that are per-bar background/candle colours, indexed by
   * bar. `bgcolor`/`barcolor` are called once per bar (often under a condition,
   * so a bar may be unset → transparent). Merged into runs at `build()`.
   */
  private readonly bgColor: (string | undefined)[] = [];
  private readonly bgAlpha: number[] = [];
  private readonly barColor: (string | undefined)[] = [];
  private readonly barAlpha: number[] = [];
  /**
   * Live `label`/`line`/`box`/`table` objects by handle id. Pine creates these
   * once (usually a `var`) and mutates them through `label.set_*` etc, so the
   * final visible state is whatever the last bar left them in — hence a single
   * instance-level store, never reset per bar.
   */
  private readonly drawObjs = new Map<number, DrawObj>();
  private drawIdSeq = 1;
  private drawCapWarned = false;
  /**
   * `fill(plot1, plot2, color)` references — the pair of plot cids to shade
   * between, recorded once per pair. The polygon is built at `build()` from the
   * two lines' finished value arrays (a per-bar call can't see the whole series).
   */
  private readonly fills: { cidA: number; cidB: number; color: string; alpha: number }[] = [];
  private readonly fillSeen = new Set<string>();
  /** Resolutions requested by `request.security_lower_tf`, for the mount layer. */
  private readonly lowerTfSeen = new Set<number>();

  private readonly params: number[];
  private readonly opLimit: number;
  private readonly tick: number;
  private readonly strict: boolean;

  /** User-defined functions, keyed by name (`f(x) => …`). */
  private readonly fns = new Map<string, FnStmt>();
  /** Registered UDT (`type Name`) field layouts, name → field names in order. */
  private readonly types = new Map<string, string[]>();
  /** UDT methods, typeName → methodName → definition. `obj.m(...)` looks the
   *  receiver's type up here and runs `m` with the record bound as `this`. */
  private readonly typeMethods = new Map<string, Map<string, FnStmt>>();
  /**
   * Current variable scope. "" is the script's global scope; a call site of a
   * user function gets `f<cid>`, because in Pine each call site keeps its own
   * history for the locals inside the body.
   */
  private scope = "";
  private fnDepth = 0;
  /**
   * Chain of user-function call-site ids the current evaluation runs inside
   * ("" at global scope, `f<cid>` one level in, `<outer>>f<cid>` nested). A
   * builtin's rolling state is keyed by its *body* AST cid, which is shared by
   * every invocation of the function it lives in — so a helper called twice
   * (e.g. `_median(x)` for both the centre and the MAD) would silently share
   * one window. TradingView keeps rolling state per call site, so we fold this
   * path into the state key to give each invocation its own.
   */
  private callPath = "";
  /** Value of the last statement run, which is how a block body returns. */
  private lastValue: V = NA;

  private bi = -1;
  private ctxCid = 0;
  /**
   * The bar array the *expression evaluator* currently reads (builtins, ta.*,
   * history). Identical to `bars` except while a `request.security` call runs
   * its expression across a higher-timeframe series, when it is temporarily
   * swapped to the resampled bars. Statement/plot building always runs on the
   * chart `bars`, so only the pure-evaluation reads go through this.
   */
  private activeBars: PineBars;
  /** Cache of `request.security` higher-timeframe series, keyed by call site. */
  private readonly secCache = new Map<
    string,
    { chartToHtf: Int32Array; subs: V[][]; tuple: boolean }
  >();
  /** Guards against a nested request.security re-entering the swap path. */
  private inSecurity = false;
  /** Optional finer-than-chart bars backing `request.security_lower_tf`. */
  private readonly lowerBars: PineBars | undefined;
  /** Per-call-site cache of the lower-timeframe series + chart-bar slice bounds. */
  private readonly ltfCache = new Map<
    string,
    { lowerSeries: V[]; bounds: { s: number; e: number }[] }
  >();
  private ops = 0;
  private histCap = HIST_CAP;
  /**
   * vkey set of names currently mid-declaration. Lets `float x = f(x[1])` — the
   * recursive-series idiom (Ehlers filters) — read its own prior-bar history as
   * na on bar 0 instead of aborting on "undefined". Cleared as soon as the
   * initializer finishes; a bare offset-0 self-reference still aborts, matching
   * TradingView, because only `readBack` (history) consults this set.
   */
  private readonly pending = new Set<string>();
  /** Per-bar memo so a bare legacy series (`accdist`/`pvt`/…) advances its
   *  accumulator once per bar even when read many times in the same bar. */
  private readonly legacyMemo = new Map<string, number>();
  /** Stable synthetic call-site id per legacy name so its `ta.*` rolling state
   *  key is identical across bars (the accumulator must not reset). */
  private readonly legacyCids = new Map<string, number>();
  private legacyCidSeq = 1_000_000;
  /** Variable the interpreter is assigning into, for auto-generated titles. */
  private target: string | null = null;

  /* header */
  private kind: "indicator" | "strategy" = "indicator";
  private title = "";
  private overlay = false;
  private format = "inherit";
  private precision: number | undefined;
  private headerSeen = false;
  private legacyOrders: { expr: Expr; dir: 1 | -1 }[] = [];

  /* order simulation (only active for strategy() scripts) */
  private readonly sim: OrderSim;

  /** `//@version=N` dialect number. Drives the v6 "booleans cannot be na" rule
   *  in `binary()`; defaults to a modern 5 when the header is absent so pre-v6
   *  na-propagation (warmup blanking) is preserved for unversioned snippets. */
  private readonly ver: number;

  constructor(src: string, private readonly bars: PineBars, opts: PineRunOptions = {}) {
    this.activeBars = this.bars;
    const m = /@version\s*=\s*(\d+)/.exec(src);
    this.ver = m ? Number(m[1]) : 5;
    this.stmts = parsePine(src);
    // Hoist function definitions: real scripts open with `if … f(...)` before
    // the `f(x) =>` line, and per-bar execution must not depend on order.
    for (const s of this.stmts) if (s.k === "fn") this.fns.set(s.name, s);
    this.params = opts.params ?? [];
    this.opLimit = opts.opLimit ?? OP_LIMIT;
    this.strict = !!opts.strict;
    this.lowerBars = opts.lowerBars;
    this.tick = estimateTick(bars);
    this.sim = new OrderSim(
      bars,
      this.tick,
      (m) => this.warn(m),
      (bar, name, up, price) => this.markTrade(bar, name, up, price),
    );
    const self = this;
    this.ctx = {
      get bi() {
        return self.bi;
      },
      get len() {
        return self.activeBars.list.length;
      },
      get bars() {
        return self.activeBars;
      },
      val: (e: Expr) => self.val(e),
      state: <T extends object>(init: () => T, sub = "") => {
        const key = `${self.ctxCid}@${self.callPath}#${sub}`;
        let hit = this.states.get(key) as T | undefined;
        if (!hit) {
          hit = init();
          this.states.set(key, hit);
        }
        return hit;
      },
      warn: (m: string) => self.warn(m),
    };
  }

  /* ------------------------------------------------------------ diagnostics */

  private warn(msg: string): void {
    if (this.warnSeen.has(msg)) return;
    this.warnSeen.add(msg);
    if (this.warns.length < 40) this.warns.push(msg);
  }

  /* ------------------------------------------------------------- series I/O */

  /** Key of a variable in the current scope (globals keep the bare `v:name`). */
  private vkey(name: string): string {
    return this.scope ? `v:${this.scope}:${name}` : `v:${name}`;
  }

  /** Scope lookup with the walk-out-to-global fallback Pine does. */
  private lookup(name: string): Series | undefined {
    const hit = this.env.get(this.vkey(name));
    if (hit) return hit;
    return this.scope ? this.env.get(`v:${name}`) : undefined;
  }

  private slot(key: string, persist: boolean): Series {
    let s = this.env.get(key);
    if (!s) {
      s = { hist: [], cur: NA, live: false, persist };
      this.env.set(key, s);
    } else if (persist) {
      s.persist = true;
    }
    return s;
  }

  private write(key: string, value: V, persist: boolean): void {
    const s = this.slot(key, persist);
    s.cur = value;
    s.live = true;
  }

  private declaredNames(): string {
    const names = [...this.env.keys()]
      .filter((k) => k.startsWith("v:") && !k.slice(2).includes(":"))
      .map((k) => k.slice(2));
    return names.length ? names.slice(0, 12).join("、") : "无";
  }

  private readSeries(name: string): V {
    if (SERIES_NAMES.has(name)) return this.builtinAt(name, this.bi);
    const s = this.lookup(name);
    if (!s) throw new PineError(`未定义的变量 "${name}"。已声明的变量：${this.declaredNames()}`);
    return s.live || s.persist ? s.cur : NA;
  }

  private readBack(name: string, k: number): V {
    if (k <= 0) return this.readSeries(name);
    if (SERIES_NAMES.has(name)) {
      const i = this.bi - k;
      return i < 0 ? NA : this.builtinAt(name, i);
    }
    // Date builtins are zero-arg functions, but scripts still ask for their
    // history (`year[1]`, `dayofweek[back]`). Derive the value from the target
    // bar's own timestamp rather than throwing — this path used to abort.
    if (DATE_FIELD[name]) {
      const i = this.bi - k;
      if (i < 0) return NA;
      const t = this.activeBars.time[i];
      return Number.isFinite(t) ? DATE_FIELD[name](new Date(t)) : NA;
    }
    const s = this.lookup(name);
    if (!s) {
      // Reading a series' own history inside its own declaration (`float x = f(x[1])`)
      // is na on the first bar, not an undefined-variable abort.
      if (this.pending.has(this.vkey(name))) return NA;
      throw new PineError(`未定义的变量 "${name}"，无法取历史值`);
    }
    const idx = s.hist.length - k;
    return idx < 0 ? NA : s.hist[idx];
  }

  private builtinAt(name: string, i: number): V {
    const b = this.activeBars;
    if (i < 0 || i >= b.list.length) return NA;
    switch (name) {
      case "open":
        return b.open[i];
      case "high":
        return b.high[i];
      case "low":
        return b.low[i];
      case "close":
        return b.close[i];
      case "volume":
        return b.volume[i];
      case "hl2":
        return (b.high[i] + b.low[i]) / 2;
      case "hlc3":
        return (b.high[i] + b.low[i] + b.close[i]) / 3;
      case "hlcc4":
        return (b.high[i] + b.low[i] + b.close[i] + b.close[i]) / 4;
      case "ohlc4":
        return (b.open[i] + b.high[i] + b.low[i] + b.close[i]) / 4;
      case "timenow":
        return b.time[b.list.length - 1] ?? NA;
      default:
        return b.time[i];
    }
  }

  /* -------------------------------------------------------------- bar loop */

  run(): PineResult {
    const len = this.bars.list.length;
    for (let i = 0; i < len; i++) {
      this.bi = i;
      this.scope = "";
      this.beginBar();
      if (!this.runBody(this.stmts)) break;
      this.endBar();
    }
    return this.build();
  }

  /** @returns false when the script aborted and the bar loop should stop. */
  private runBody(body: Stmt[]): boolean {
    try {
      for (const s of body) this.exec(s);
      return true;
    } catch (err) {
      if (err instanceof ControlFlow) {
        // A break/continue that escaped every loop is a script bug, not a
        // feature gap; report it plainly instead of the generic abort text.
        err = new PineError(`${err.kind} 只能用在循环内部`);
      }
      const msg = err instanceof Error ? err.message : String(err);
      if (!this.warnSeen.has(msg)) {
        this.warns.unshift(`第 ${this.bi + 1} 根K线处中断：${msg}`);
        this.warnSeen.add(msg);
      }
      if (this.strict) throw err instanceof Error ? err : new PineError(msg);
      return false;
    }
  }

  private beginBar(): void {
    this.legacyMemo.clear();
    for (const s of this.env.values()) {
      if (s.persist) continue;
      s.cur = NA;
      s.live = false;
    }
    if (this.kind === "strategy") this.sim.beginBar(this.bi);
  }

  private endBar(): void {
    for (const s of this.env.values()) {
      s.hist.push(s.persist || s.live ? s.cur : NA);
      if (s.hist.length > this.histCap) s.hist.shift();
    }
    if (this.kind === "strategy") this.sim.endBar(this.bi);
  }

  /* ------------------------------------------------------------- statements */

  private budget(): void {
    if (++this.ops > this.opLimit) {
      throw new PineError(
        `脚本计算量超过上限（约 ${Math.round(this.opLimit / 1e6)}M 次求值），请减少循环或缩短回看周期`,
      );
    }
  }

  private exec(s: Stmt): void {
    this.budget();
    switch (s.k) {
      case "fn": {
        // Definitions are hoisted in the constructor; a nested one still gets
        // registered the first bar its block runs.
        this.fns.set(s.name, s);
        this.lastValue = sentinel("void");
        return;
      }
      case "decl": {
        const prev = this.target;
        this.target = s.names[0];
        // Allow the initializer to read the declared series' own history
        // (`float ji = f(ji[1])`) as na before the slot exists on bar 0.
        for (const n of s.names) this.pending.add(this.vkey(n));
        let value: V;
        try {
          value = this.val(s.value);
        } finally {
          for (const n of s.names) this.pending.delete(this.vkey(n));
        }
        this.target = prev;
        this.lastValue = value;
        for (let i = 0; i < s.names.length; i++) {
          const key = this.vkey(s.names[i]);
          if (s.persist && this.bi > 0 && this.env.has(key)) continue;
          const one =
            s.names.length === 1
              ? value
              : Array.isArray(value)
                ? (value[i] ?? NA)
                : NA;
          this.write(key, one, s.persist);
        }
        return;
      }
      case "assign": {
        const prev = this.target;
        this.target = s.name;
        const value = this.val(s.value);
        this.target = prev;
        this.lastValue = value;
        // `obj.field := v` for a UDT record mutates the record **in place**. Pine
        // passes records by reference, so the write must be visible through every
        // alias (the caller's record, a reassignment target, a method receiver) —
        // a standalone `obj.field` slot would only be readable under that exact
        // dotted name and break once the record is passed to another function.
        // A dotted name whose base is not a record keeps the legacy slot write.
        const dot = s.name.indexOf(".");
        if (dot > 0 && this.setUdtField(s.name.slice(0, dot), s.name.slice(dot + 1), value)) return;
        this.write(this.vkey(s.name), value, false);
        return;
      }
      case "type": {
        // A record type declaration: register the field layout once. The value
        // model is a positional `V[]` tagged with `@udt:<name>`, built by `.new`.
        this.types.set(s.name, s.fieldNames);
        if (s.methods && s.methods.length) {
          const m = new Map<string, FnStmt>();
          for (const fn of s.methods) m.set(fn.name, fn);
          this.typeMethods.set(s.name, m);
        }
        this.lastValue = sentinel("void");
        return;
      }
      case "expr": {
        const value = this.val(s.value);
        this.lastValue = value;
        return;
      }
      case "if": {
        for (const arm of s.arms) {
          if (isTrue(this.val(arm.cond))) {
            for (const inner of arm.body) this.exec(inner);
            return;
          }
        }
        if (s.elseBody) for (const inner of s.elseBody) this.exec(inner);
        return;
      }
      case "for":
        this.execFor(s);
        return;
      case "forin":
        this.execForIn(s);
        return;
      case "while":
        this.execWhile(s);
        return;
      case "break":
        throw new ControlFlow("break");
      case "continue":
        throw new ControlFlow("continue");
    }
  }

  private execFor(s: Extract<Stmt, { k: "for" }>): void {
    const from = Math.trunc(asNum(this.val(s.from)));
    const to = Math.trunc(asNum(this.val(s.to)));
    if (Number.isNaN(from) || Number.isNaN(to)) {
      this.warn("for 循环的边界不是数字，已跳过该循环");
      return;
    }
    const stepRaw = s.step ? Math.trunc(asNum(this.val(s.step))) : 0;
    const step = stepRaw !== 0 ? stepRaw : to >= from ? 1 : -1;
    const key = this.vkey(s.varName);
    const saved = this.env.get(key);
    this.env.set(key, { hist: [], cur: NA, live: true, persist: true });
    let guard = 0;
    try {
      for (let k = from; step > 0 ? k <= to : k >= to; k += step) {
        if (++guard > LOOP_CAP) {
          this.warn(`for 循环超过 ${LOOP_CAP} 次迭代，已截断`);
          break;
        }
        (this.env.get(key) as Series).cur = k;
        let stop = false;
        for (const inner of s.body) {
          try {
            this.exec(inner);
          } catch (e) {
            if (e instanceof ControlFlow) {
              stop = e.kind === "break";
              break;
            }
            throw e;
          }
        }
        if (stop) break;
      }
    } finally {
      if (saved) this.env.set(key, saved);
      else this.env.delete(key);
    }
  }

  /** `for x in arr` — bind each element to the loop var and run the body. */
  private execForIn(s: Extract<Stmt, { k: "forin" }>): void {
    const src = this.val(s.source);
    if (!Array.isArray(src)) {
      this.warn("for...in 需要数组，已跳过该循环");
      return;
    }
    const key = this.vkey(s.varName);
    const saved = this.env.get(key);
    this.env.set(key, { hist: [], cur: NA, live: true, persist: true });
    let guard = 0;
    try {
      for (const el of src) {
        if (++guard > LOOP_CAP) {
          this.warn(`for...in 超过 ${LOOP_CAP} 次迭代，已截断`);
          break;
        }
        (this.env.get(key) as Series).cur = el;
        let stop = false;
        for (const inner of s.body) {
          try {
            this.exec(inner);
          } catch (e) {
            if (e instanceof ControlFlow) {
              stop = e.kind === "break";
              break;
            }
            throw e;
          }
        }
        if (stop) break;
      }
    } finally {
      if (saved) this.env.set(key, saved);
      else this.env.delete(key);
    }
  }

  /**
   * `while cond` — re-evaluate the guard every iteration. Pine has no
   * host-side step limit, so a script that never flips its condition would
   * hang the bar loop; LOOP_CAP truncates it with a warning, matching `for`.
   * break/continue are caught here exactly as in execFor.
   */
  private execWhile(s: Extract<Stmt, { k: "while" }>): void {
    let guard = 0;
    for (;;) {
      if (!isTrue(this.val(s.cond))) return;
      if (++guard > LOOP_CAP) {
        this.warn(`while 循环超过 ${LOOP_CAP} 次迭代，已截断`);
        return;
      }
      let stop = false;
      for (const inner of s.body) {
        try {
          this.exec(inner);
        } catch (e) {
          if (e instanceof ControlFlow) {
            stop = e.kind === "break";
            break;
          }
          throw e;
        }
      }
      if (stop) return;
    }
  }

  /* ------------------------------------------------------- user functions */

  /**
   * Run a `f(a, b) => …` body for the current bar.
   *
   * Pine semantics that matter here:
   *   - arguments are bound in the **caller's** scope (they are series values
   *     at this bar, not deferred expressions);
   *   - the body's locals belong to the **call site**, so `x[1]` inside the
   *     function reads what that same call site computed on the previous bar;
   *   - a block body returns the value of its last statement.
   */
  /**
   * Build a UDT record: a `V[]` whose first slot is the `@udt:<type>` tag and
   * whose remaining slots are field values in declaration order. Positional
   * args fill fields left-to-right; named args (`Type.new(f1=x)`) land by name.
   */
  private buildUdt(typeName: string, args: Arg[]): V {
    const fields = this.types.get(typeName) ?? [];
    const values: V[] = fields.map(() => NA);
    let pos = 0;
    for (const a of args) {
      const v = this.val(a.value);
      if (a.name) {
        const i = fields.indexOf(a.name);
        if (i >= 0) values[i] = v;
      } else {
        if (pos < values.length) values[pos] = v;
        pos++;
      }
    }
    return [sentinel(`udt:${typeName}`), ...values];
  }

  /**
   * `obj.field := v` for a UDT record: locate the base's record (a `V[]` tagged
   * `@udt:<type>`) and write the field slot in place. Returns true when a record
   * field was mutated (the caller then skips the standalone-slot write), false
   * when the base is not a record so the assignment is a normal variable store.
   */
  private setUdtField(base: string, field: string, value: V): boolean {
    if (!this.lookup(base)) return false;
    const rec = this.readSeries(base);
    if (!Array.isArray(rec) || typeof rec[0] !== "string" || !rec[0].startsWith("@udt:")) return false;
    const fields = this.types.get(rec[0].slice("@udt:".length));
    if (!fields) return false;
    const idx = fields.indexOf(field);
    if (idx < 0) return false;
    (rec as V[])[idx + 1] = value;
    return true;
  }

  private callFn(fn: FnStmt, args: Arg[], cid: number): V {
    if (this.fnDepth >= FN_DEPTH_CAP) {
      throw new PineError(`函数 "${fn.name}" 递归超过 ${FN_DEPTH_CAP} 层，请检查是否无限递归`);
    }
    const outer = this.scope;
    const outerPath = this.callPath;
    const bound: V[] = [];
    for (let i = 0; i < fn.params.length; i++) {
      const hit = argAt(args, i, fn.params[i].name);
      bound.push(hit ? this.val(hit) : fn.params[i].def ? this.val(fn.params[i].def as Expr) : NA);
    }
    this.fnDepth += 1;
    let out: V = NA;
    try {
      this.scope = `f${cid}`;
      this.callPath = outerPath ? `${outerPath}>f${cid}` : `f${cid}`;
      for (let i = 0; i < fn.params.length; i++) this.write(this.vkey(fn.params[i].name), bound[i], false);
      if (!Array.isArray(fn.body)) {
        out = this.val(fn.body);
      } else {
        for (const st of fn.body) {
          this.lastValue = NA;
          this.exec(st);
          out = this.lastValue;
        }
      }
    } finally {
      this.scope = outer;
      this.callPath = outerPath;
      this.fnDepth -= 1;
    }
    return out;
  }

  /** The live `@udt:`-tagged record held by a variable, or undefined when the
   *  name is not declared or its value is not a record. */
  private udtReceiver(name: string): V[] | undefined {
    const s = this.lookup(name);
    if (!s) return undefined;
    const v = s.cur;
    if (Array.isArray(v) && typeof v[0] === "string" && v[0].startsWith("@udt:")) return v as V[];
    return undefined;
  }

  /**
   * Run a UDT method with the record as the implicit receiver. The record is
   * bound as `this` (so `this.field` reads/writes reuse the existing @udt
   * accessors) and every field name is bound to its current value (so a bare
   * `field` inside the body resolves to the receiver). After the body, fields
   * that were reassigned locally are written back into the shared record so
   * `x := x + 1` style methods persist; declared params are excluded from the
   * write-back so a same-named parameter never corrupts a field slot.
   */
  private callMethod(fn: FnStmt, rec: V[], args: Arg[], cid: number): V {
    if (this.fnDepth >= FN_DEPTH_CAP) {
      throw new PineError(`方法 "${fn.name}" 递归超过 ${FN_DEPTH_CAP} 层，请检查是否无限递归`);
    }
    const outer = this.scope;
    const outerPath = this.callPath;
    const typeName = String(rec[0]).slice("@udt:".length);
    const fields = this.types.get(typeName) ?? [];
    const bound: V[] = [];
    for (let i = 0; i < fn.params.length; i++) {
      const hit = argAt(args, i, fn.params[i].name);
      bound.push(hit ? this.val(hit) : fn.params[i].def ? this.val(fn.params[i].def as Expr) : NA);
    }
    const params = new Set(fn.params.map((p) => p.name));
    this.fnDepth += 1;
    let out: V = NA;
    try {
      this.scope = `f${cid}`;
      this.callPath = outerPath ? `${outerPath}>f${cid}` : `f${cid}`;
      this.write(this.vkey("this"), rec, false);
      for (let i = 0; i < fields.length; i++) this.write(this.vkey(fields[i]), (rec as V[])[i + 1], false);
      for (let i = 0; i < fn.params.length; i++) this.write(this.vkey(fn.params[i].name), bound[i], false);
      if (!Array.isArray(fn.body)) {
        out = this.val(fn.body);
      } else {
        for (const st of fn.body) {
          this.lastValue = NA;
          this.exec(st);
          out = this.lastValue;
        }
      }
      for (let i = 0; i < fields.length; i++) {
        if (params.has(fields[i])) continue;
        const s = this.lookup(fields[i]);
        if (s && s.live) (rec as V[])[i + 1] = s.cur;
      }
    } finally {
      this.scope = outer;
      this.callPath = outerPath;
      this.fnDepth -= 1;
    }
    return out;
  }

  /* ------------------------------------------------------------ expressions */

  val(e: Expr): V {
    this.budget();
    switch (e.k) {
      case "num":
        return e.v;
      case "str":
        return e.v;
      case "arr":
        return e.items.map((x) => this.val(x));
      case "id":
        return this.readIdent(e.name);
      case "idx": {
        const k = asNum(this.val(e.off));
        return this.readIdx(e.base, Number.isNaN(k) ? 0 : Math.max(0, Math.trunc(k)));
      }
      case "call": {
        // A builtin's rolling state is keyed by ctxCid, but evaluating its
        // arguments can dispatch nested calls that clobber ctxCid. Save the
        // call-site id and restore it after dispatch so `c.state()` inside the
        // outer builtin still resolves to *this* call site, not the last nested
        // one (e.g. ta.rma(math.max(ta.change(close), 0), n)).
        const savedCid = this.ctxCid;
        this.ctxCid = e.cid;
        const out = this.dispatch(e);
        this.ctxCid = savedCid;
        this.write("f:" + e.cid, out, false);
        return out;
      }
      case "bin":
        return this.binary(e.op, e.a, e.b);
      case "un": {
        if (e.op === "not") {
          const v = asNum(this.val(e.a));
          return Number.isNaN(v) ? NA : v === 0 ? 1 : 0;
        }
        const v = asNum(this.val(e.a));
        if (e.op === "~") return Number.isNaN(v) ? NA : ~Math.trunc(v);
        return e.op === "-" ? -v : v;
      }
      case "tern": {
        // `na ? a : b` is na in Pine — a blank plot, not the else branch. This
        // warmup blanking is load-bearing for pre-v6 scripts (`rsi > 70 ? 1 : 0`
        // must not draw 0 while rsi is na). v6 changed the *comparison*, not the
        // ternary: see `binary()`, where `na > x` yields false so this sees a
        // real false and takes the else branch.
        const cond = asNum(this.val(e.c));
        if (Number.isNaN(cond)) return NA;
        return cond !== 0 ? this.val(e.a) : this.val(e.b);
      }
      case "switch": {
        // `switch subj` compares each clause test to the subject; a bare
        // `switch` treats each test as a boolean guard. First match wins, else
        // the `=> default` clause, else na.
        const subj = e.subject === null ? undefined : this.val(e.subject);
        let body: Expr | Stmt[] | null = null;
        for (const cse of e.cases) {
          const v = this.val(cse.test);
          const hit = subj === undefined ? isTrue(v) : switchEq(subj, v);
          if (hit) {
            body = cse.body;
            break;
          }
        }
        if (body === null) body = e.defaultBody;
        if (body === null) return NA;
        return Array.isArray(body) ? this.runBlock(body) : this.val(body);
      }
      case "ifexpr": {
        // `if cond` as a value: first arm whose guard is true yields its body
        // (an inline expression or an indented block), else the trailing
        // `else` body, else na. A na guard counts as false (Pine semantics).
        for (const arm of e.arms) {
          if (isTrue(this.val(arm.cond))) {
            return Array.isArray(arm.body) ? this.runBlock(arm.body) : this.val(arm.body);
          }
        }
        if (e.elseBody === null) return NA;
        return Array.isArray(e.elseBody) ? this.runBlock(e.elseBody) : this.val(e.elseBody);
      }
    }
  }

  /** Run a statement block and return its last value (switch / if-expression bodies). */
  private runBlock(body: Stmt[]): V {
    let out: V = NA;
    for (const st of body) {
      this.lastValue = NA;
      this.exec(st);
      out = this.lastValue;
    }
    return out;
  }

  private readIdx(base: Expr, k: number): V {
    if (k === 0) return this.val(base);
    if (base.k === "id") return this.readBack(base.name, k);
    if (base.k === "call") {
      const s = this.env.get("f:" + base.cid);
      if (!s) {
        // First read is also the first execution of that call site.
        const savedCid = this.ctxCid;
        this.ctxCid = base.cid;
        const fresh = this.dispatch(base);
        this.ctxCid = savedCid;
        this.write("f:" + base.cid, fresh, false);
        return fresh;
      }
      const idx = s.hist.length - k;
      return idx < 0 ? NA : s.hist[idx];
    }
    if (base.k === "num" || base.k === "str" || base.k === "arr") return NA;
    throw new PineError("只支持对变量、内置序列和函数调用取历史值（例如 close[1]、x[2]）");
  }

  private readIdent(name: string): V {
    switch (name) {
      case "true":
        return 1;
      case "false":
        return 0;
      case "na":
      case "null":
        return NA;
      case "bar_index":
      case "barindex":
        return this.bi;
      case "last_bar_index":
        return this.activeBars.list.length - 1;
      case "math.pi":
        return Math.PI;
      case "math.e":
        return Math.E;
      case "math.nan":
      case "float.na":
      case "int.na":
        return NA;
    }
    const strategy = this.sim.readVar(name);
    if (strategy !== undefined) return strategy;
    if (name.startsWith("barstate.")) {
      switch (name) {
        case "barstate.islast":
          return this.bi === this.activeBars.list.length - 1 ? 1 : 0;
        case "barstate.isfirst":
          return this.bi === 0 ? 1 : 0;
        case "barstate.isconfirmed":
        case "barstate.issincelast":
        case "barstate.history":
          return 1;
        default:
          return 0;
      }
    }
    if (ENUM_NS.test(name)) {
      // `timeframe.*` are zero-arg builtins (period / isdaily / in_seconds …),
      // not enum constants like color.red or barmerge.lookahead_on that the
      // guard below is meant for. Resolve them through MISC so a bare
      // `timeframe.isintraday` yields a real 0/1 instead of a sentinel string.
      const tf = MISC[name];
      if (name.startsWith("timeframe.") && tf) return tf([], this.ctx);
      return sentinel(name);
    }
    if (SERIES_NAMES.has(name)) return this.builtinAt(name, this.bi);
    if (this.lookup(name)) return this.readSeries(name);
    // Zero-arg builtins are sometimes read as plain names (`timenow`, `timeframe.period`).
    const fn = MISC[name];
    if (fn) return fn([], this.ctx);
    // UDT field access: `featureSeries.f1` arrives as one dotted ident. If the
    // base is a `@udt:`-tagged record, resolve the field by declared order.
    const dot = name.indexOf(".");
    if (dot > 0) {
      const base = name.slice(0, dot);
      const field = name.slice(dot + 1);
      if (this.lookup(base)) {
        const rec = this.readSeries(base);
        if (Array.isArray(rec) && typeof rec[0] === "string" && rec[0].startsWith("@udt:")) {
          const fields = this.types.get(rec[0].slice("@udt:".length));
          if (fields) {
            const idx = fields.indexOf(field);
            return idx >= 0 ? (rec as V[])[idx + 1] : NA;
          }
        }
        // A declared base whose value is `na` makes `base.field` na, not an
        // undeclared abort. Real order-block / FVG / swing indicators read a
        // record off a still-growing array (`s = array.get(arr, i); s.isHigh`),
        // so on the early bars `s` is legitimately na — TradingView yields na
        // there, and only a genuinely unknown base (a real typo'd name, or a
        // non-object value) should still throw honestly below.
        if (isNa(rec)) return NA;
      }
    }
    // Bare v2/v3 constants (unprefixed colour names, short style/location
    // keywords, `dayofweek.monday`, …) resolve to their enum sentinel. Checked
    // last so a real user variable of the same name (looked up above) still wins
    // and a genuinely undefined name still throws honestly.
    const bareConst = resolveBareConstant(name);
    if (bareConst !== undefined) return bareConst;
    // Legacy pre-v5 bare names: `n` was the v3 bar-index (replaced by bar_index
    // in v4), and `accdist`/`pvt`/`obv`/`nvi`/`pvi` were bare series built-ins
    // (moved under `ta.` in v5). Consulted last so a real user variable of the
    // same name still wins; gated by version so v5/v6 keep honest aborts.
    if (this.ver <= 3 && name === "n") return this.bi;
    if (this.ver <= 4) {
      const taKey = LEGACY_SERIES[name];
      if (taKey) {
        const memo = this.legacyMemo.get(name);
        if (memo !== undefined) return memo;
        let cid = this.legacyCids.get(name);
        if (cid === undefined) {
          cid = this.legacyCidSeq++;
          this.legacyCids.set(name, cid);
        }
        const savedCid = this.ctxCid;
        this.ctxCid = cid;
        const v = asNum(TA[taKey]([], this.ctx));
        this.ctxCid = savedCid;
        this.legacyMemo.set(name, v);
        return v;
      }
    }
    throw new PineError(`未定义的变量 "${name}"。已声明的变量：${this.declaredNames()}`);
  }

  private binary(op: string, ea: Expr, eb: Expr): V {
    if (op === "and" || op === "or") {
      const a = asNum(this.val(ea));
      if (op === "and" && !Number.isNaN(a) && a === 0) return 0;
      if (op === "or" && !Number.isNaN(a) && a !== 0) return 1;
      const b = asNum(this.val(eb));
      if (Number.isNaN(a) || Number.isNaN(b)) return NA;
      return b === 0 ? 0 : 1;
    }
    const a = this.val(ea);
    const b = this.val(eb);
    const aText = typeof a === "string" && !a.startsWith("@");
    const bText = typeof b === "string" && !b.startsWith("@");
    if (aText || bText) {
      if (op === "+") return asStr(a) + asStr(b);
      if (op === "==") return asStr(a) === asStr(b) ? 1 : 0;
      if (op === "!=") return asStr(a) === asStr(b) ? 0 : 1;
      return NA;
    }
    const x = asNum(a);
    const y = asNum(b);
    // Comparisons against na stay na, so a plot goes blank instead of drawing 0.
    if (Number.isNaN(x) || Number.isNaN(y)) {
      // v6 "booleans cannot be na": a comparison with an unknown operand is a
      // definite false/true, not na, so warmup bars resolve through the ternary
      // instead of blanking (Chande momentum's `diff > 0 ? diff : 0.0` at bar 0
      // must yield 0.0, not na, or a `var` accumulator poisons forever). This is
      // scoped to v6 so pre-v6 warmup blanking is untouched; arithmetic is n/a.
      if (this.ver >= 6) {
        switch (op) {
          case ">":
          case "<":
          case ">=":
          case "<=":
          case "==":
            return 0;
          case "!=":
          case "<>":
            return 1;
        }
      }
      return NA;
    }
    switch (op) {
      case "+":
        return x + y;
      case "-":
        return x - y;
      case "*":
        return x * y;
      case "/":
        return y === 0 ? NA : x / y;
      case "%":
        return y === 0 ? NA : x - y * Math.floor(x / y);
      case "^":
        return Math.pow(x, y);
      case ">":
        return x > y ? 1 : 0;
      case "<":
        return x < y ? 1 : 0;
      case ">=":
        return x >= y ? 1 : 0;
      case "<=":
        return x <= y ? 1 : 0;
      case "==":
        return x === y ? 1 : 0;
      case "!=":
        return x !== y ? 1 : 0;
      // Bitwise operators act on integer operands (Pine truncates to int).
      // JS bitwise is 32-bit signed; sufficient for index/bit-level uses.
      case "&":
        return Math.trunc(x) & Math.trunc(y);
      case "|":
        return Math.trunc(x) | Math.trunc(y);
      case "<<":
        return Math.trunc(x) << Math.trunc(y);
      case ">>":
        return Math.trunc(x) >> Math.trunc(y);
      default:
        throw new PineError(`不支持的运算符 "${op}"`);
    }
  }

  /* ------------------------------------------------- multi-timeframe (MTF) */

  /**
   * Evaluate `expr` independently on every bar of `htf`, returning one value
   * per higher-timeframe bar. Reuses the real `val()` / `ta.*` machinery by
   * pointing the evaluator's bar cursor at `htf` for the duration: ta.*
   * recursion stays correct because each source call site carries a distinct
   * cid, and scalar user variables resolve to their chart-frame value. The
   * interpreter's cursor is always restored, so the surrounding chart bar is
   * untouched.
   */
  private evalOnBars(expr: Expr, htf: PineBars): V[] {
    const savedBars = this.activeBars;
    const savedBi = this.bi;
    const savedIn = this.inSecurity;
    this.activeBars = htf;
    this.inSecurity = true;
    const out: V[] = new Array(htf.list.length);
    try {
      for (let i = 0; i < htf.list.length; i++) {
        this.bi = i;
        out[i] = this.val(expr);
      }
    } finally {
      this.activeBars = savedBars;
      this.bi = savedBi;
      this.inSecurity = savedIn;
    }
    return out;
  }

  /**
   * Whether `e` reads a user-declared variable or calls a user function.
   * Scalars (length parameters) are correct under MTF — they just resolve to
   * their chart-frame value — but a variable that is itself a series is only
   * approximated, since we do not re-run its definition on the other
   * timeframe. Used purely to warn honestly, never to change the result.
   */
  private referencesUserVar(e: Expr): boolean {
    const walkExpr = (n: Expr): boolean => {
      switch (n.k) {
        case "num":
        case "str":
          return false;
        case "id":
          return this.lookup(n.name) !== undefined;
        case "arr":
          return n.items.some(walkExpr);
        case "idx":
          return walkExpr(n.base) || (n.off ? walkExpr(n.off) : false);
        case "call":
          if (this.fns.has(n.name)) return true;
          return n.args.some((a) => walkExpr(a.value));
        case "bin":
          return walkExpr(n.a) || walkExpr(n.b);
        case "un":
          return walkExpr(n.a);
        case "tern":
          return walkExpr(n.a) || walkExpr(n.b) || walkExpr(n.c);
        case "switch": {
          if (n.subject && walkExpr(n.subject)) return true;
          const bodyBad = (b: Expr | Stmt[]) => Array.isArray(b) || walkExpr(b);
          if (n.cases.some((c) => walkExpr(c.test) || bodyBad(c.body))) return true;
          return n.defaultBody ? bodyBad(n.defaultBody) : false;
        }
        case "ifexpr": {
          const bodyBad = (b: Expr | Stmt[]) => Array.isArray(b) || walkExpr(b);
          if (n.arms.some((a) => walkExpr(a.cond) || bodyBad(a.body))) return true;
          return n.elseBody ? bodyBad(n.elseBody) : false;
        }
        default:
          return true;
      }
    };
    return walkExpr(e);
  }

  /**
   * `request.security(symbol, timeframe, expression[, gaps, lookahead, …])`:
   * evaluate `expression` on a higher timeframe and read it back onto the
   * chart, aligned to the last completed HTF bar (or the forming one under
   * `lookahead=barmerge.lookahead_on`). The per-call-site HTF series is
   * computed once and cached. Cross-symbol requests are computed on the
   * chart's own instrument (single-instrument runtime).
   */
  private doSecurity(node: Extract<Expr, { k: "call" }>): V {
    const args = node.args;
    const exExpr = argAt(args, 2, "expression");
    if (!exExpr) return NA;
    const evalOnChart = () => this.val(exExpr);

    const tfExpr = argAt(args, 1, "timeframe");
    const tfStr = tfExpr ? asStr(this.val(tfExpr)) : "";
    const targetMs = tfToMs(tfStr);
    // A nested request.security (inside a higher-timeframe expression) or an
    // unparseable timeframe can't be resampled — evaluate on the chart frame.
    if (this.inSecurity || !Number.isFinite(targetMs)) return evalOnChart();

    const laExpr = argAt(args, 4, "lookahead");
    const lookahead = laExpr ? asStr(this.val(laExpr)).includes("lookahead_on") : false;

    const tuple = exExpr.k === "arr";
    const parts = tuple ? (exExpr as Extract<Expr, { k: "arr" }>).items : [exExpr];
    const key = `${node.cid}#${tfStr}#${tuple ? "t" + parts.length : "s"}`;

    let cached = this.secCache.get(key);
    if (!cached) {
      const rs = resampleUp(this.bars, targetMs);
      if (!rs) return evalOnChart(); // same / lower timeframe, not a rollup
      if (this.referencesUserVar(exExpr)) {
        this.warn(
          "request.security 表达式引用了用户变量：标量（如长度参数）结果正确，若该变量本身是序列则为近似值（未在其定义周期上重跑）。",
        );
      }
      try {
        const subs = parts.map((p) => this.evalOnBars(p, rs.htf));
        cached = { chartToHtf: rs.chartToHtf, subs, tuple };
        this.secCache.set(key, cached);
      } catch (err) {
        // A cross-timeframe re-evaluation must never be *worse* than the old
        // decorative no-op: on any failure fall back to the chart-frame value
        // and report honestly rather than aborting the whole script.
        this.warn(
          `request.security 跨周期求值失败，退回当前周期近似：${err instanceof Error ? err.message : String(err)}`,
        );
        return evalOnChart();
      }
    }

    const h = cached.chartToHtf[this.bi] ?? 0;
    const src = lookahead ? h : h - 1; // lookahead_off: last completed HTF bar
    const pick = (s: V[]): V => (src < 0 || src >= s.length ? NA : s[src]);
    if (cached.tuple) return cached.subs.map(pick);
    return pick(cached.subs[0]);
  }

  /**
   * `request.security_lower_tf(symbol, timeframe, expression)`: the array of
   * `expression` values taken from every sub-bar that falls inside the current
   * chart bar. Requires finer-than-chart bars supplied via `RunOptions.lowerBars`
   * — real sub-bar detail cannot be synthesized from the chart. Without them,
   * returns an empty array (TradingView's own guard idiom `array.size(x) > 0`
   * then skips cleanly), which is an honest degrade rather than a fabricated
   * intra-bar path.
   */
  private doSecurityLowerTf(node: Extract<Expr, { k: "call" }>): V {
    // Record the resolution the script asked for even when we have no sub-bars
    // to serve it: the mount layer reads `lowerTfMs` to decide whether (and at
    // what period) to fetch `lowerBars` and re-run the script.
    const tfExpr = argAt(node.args, 1, "timeframe");
    if (tfExpr) {
      const ms = tfToMs(asStr(this.val(tfExpr)));
      if (Number.isFinite(ms)) this.lowerTfSeen.add(ms);
    }
    const exExpr = argAt(node.args, 2, "expression");
    if (!exExpr) return [];
    if (!this.lowerBars || this.lowerBars.list.length === 0) {
      this.warn(
        "request.security_lower_tf 需要比图表更细的子K线数据（RunOptions.lowerBars）；未提供时返回空数组。",
      );
      return [];
    }
    const key = `${node.cid}`;
    let c = this.ltfCache.get(key);
    if (!c) {
      try {
        // Evaluate the expression across the whole sub-bar series once, then
        // slice the window that belongs to each chart bar (both ascending in
        // time, so a single forward scan finds every boundary).
        const lowerSeries = this.evalOnBars(exExpr, this.lowerBars);
        const chartMs = inferTimeframeMs(this.bars);
        const bounds: { s: number; e: number }[] = new Array(this.bars.list.length);
        let j = 0;
        for (let bi = 0; bi < this.bars.list.length; bi++) {
          const t0 = this.bars.time[bi];
          const t1 = t0 + chartMs;
          while (j < this.lowerBars.list.length && this.lowerBars.time[j] < t0) j++;
          const s = j;
          while (j < this.lowerBars.list.length && this.lowerBars.time[j] < t1) j++;
          bounds[bi] = { s, e: j };
        }
        c = { lowerSeries, bounds };
        this.ltfCache.set(key, c);
      } catch (err) {
        this.warn(
          `request.security_lower_tf 求值失败，返回空数组：${err instanceof Error ? err.message : String(err)}`,
        );
        return [];
      }
    }
    const bnd = c.bounds[this.bi];
    const out: V[] = [];
    for (let k = bnd.s; k < bnd.e; k++) out.push(c.lowerSeries[k]);
    return out;
  }

  /* --------------------------------------------------------------- dispatch */

  private dispatch(node: Extract<Expr, { k: "call" }>): V {
    const name = node.name;
    const args = node.args;
    const nothing = sentinel("void");

    // User functions win over the builtin table: an imported script that
    // defines `rsi_len(...)`-style helpers must call its own code.
    const user = this.fns.get(name);
    if (user) return this.callFn(user, args, node.cid);

    // Multi-timeframe requests are resolved against resampled higher-timeframe
    // bars, so they must be intercepted before the generic routing (and the
    // `request.*` decorative no-op) below.
    if (name === "request.security") return this.doSecurity(node);
    if (name === "request.security_lower_tf") return this.doSecurityLowerTf(node);
    // Legacy v2/v3 `security(tickerid, period, expression)` has the SAME first
    // three positional arguments as `request.security`, so route it to the one
    // cross-timeframe implementation rather than duplicating the semantics.
    if (name === "security") return this.doSecurity(node);

    switch (name) {
      case "indicator":
      case "study":
      case "strategy":
        return this.header(name, args);
      case "plot":
      case "plotstepline":
        return this.doPlot(args, node.cid, "line");
      case "plotbar":
      case "plotcolumn":
      case "plotarrow":
        return this.doPlot(args, node.cid, "bar");
      case "plotshape":
        return this.doShape(args, node.cid, false);
      case "plotchar":
        return this.doShape(args, node.cid, true);
      case "plotcandle":
        return this.doCandle(args, node.cid);
      case "hline":
        return this.doHline(args);
      case "fill":
        return this.doFill(args);
      case "bgcolor":
        return this.doBgColor(args);
      case "barcolor":
        return this.doBarColor(args);
      case "alertcondition":
      case "alert":
        this.warn(`${name}() 提醒在前端不起作用，已忽略`);
        return nothing;
      case "source":
        return args.length ? this.val(args[0].value) : NA;
    }
    if (name.startsWith("input")) return this.doInput(name, args, node.cid);
    if (name.startsWith("strategy.")) {
      const handled = this.sim.call(name, args, this.ctx);
      // sim.call returns `undefined` only to say "not mine"; a real result can
      // legitimately be falsy (a trade-list accessor yielding na/0), so test
      // for undefined rather than truthiness or those values fall through and
      // get mis-reported as an unimplemented function.
      if (handled !== undefined) return handled;
    }
    if (name.startsWith("ta.")) {
      const fn = TA[name.slice(3)];
      if (!fn) throw new PineError(`暂不支持 ${name}()。可用的 ta.* 函数：${availableTa()}`);
      return fn(args, this.ctx);
    }
    // Free-form array call `array.push(buf, v)`; the target array comes first.
    // A UDT constructor (`FeatureSeries.new(...)`) when the prefix is a
    // registered `type`. Guarded by types.has so `map.new`/`array.new_float`
    // (not user types) fall through to their own branches below.
    if (name.endsWith(".new")) {
      const typeName = name.slice(0, -".new".length);
      if (this.types.has(typeName)) return this.buildUdt(typeName, args);
    }
    if (name.startsWith("array.")) return this.runArray(name.slice("array.".length), args, null);
    // Free-form map call `map.put(m, k, v)`; the target map (an interleaved
    // `V[]`) comes first. Method-form is intentionally not routed (see pineMap).
    if (name.startsWith("map.")) return this.runMap(name.slice("map.".length), args);
        // Free-form matrix call `matrix.set(m, r, c, v)`; the target matrix (an
        // array-of-row `V[]`) comes first. Method-form is intentionally not routed
        // (see pineMatrix).
        if (name.startsWith("matrix.")) return this.runMatrix(name.slice("matrix.".length), args);
    // Drawing primitives that carry a persistent object handle (created once,
    // mutated through set_*, drawn on the final state). Intercepted before the
    // decorative no-op so label/box/line/table actually reach the `drawings`
    // channel; still returns a value that never feeds `produced`.
    if (
      name.startsWith("label.") ||
      name.startsWith("box.") ||
      name.startsWith("line.") ||
      name.startsWith("table.")
    ) {
      return this.runDrawing(name, args);
    }
    const misc = MISC[name];
    if (misc) return misc(args, this.ctx);
    if (!name.includes(".")) {
      const bare = TA[name];
      if (bare) {
        this.warn(`${name}() 已按 ta.${name}() 解析`);
        return bare(args, this.ctx);
      }
    }
    if (isDecorativeName(name)) {
      this.warn(`${name}() 属于绘图/交互 API，不影响数值，已忽略`);
      return nothing;
    }
    // Method-style calls on a tracked variable (`lbl.set_text(…)`) can only be
    // no-ops here; say so instead of guessing a type for the name.
    const head = name.split(".")[0];
    // A real UDT method call `obj.area()` on a `@udt:` record binds the record
    // as the implicit receiver and runs the registered body. This must precede
    // the array-method / object-var fallbacks so a genuine method is never
    // silently warned away.
    if (head && !head.includes(".")) {
      const method2 = name.slice(head.length + 1);
      if (method2 && !method2.includes(".")) {
        const rec = this.udtReceiver(head);
        if (rec) {
          const mfn = this.typeMethods.get(String(rec[0]).slice("@udt:".length))?.get(method2);
          if (mfn) return this.callMethod(mfn, rec, args, node.cid);
        }
      }
    }
    // `buf.push(v)` / `arr.size()` on an array variable route to the array
    // library with the variable's live array as the target. Only a value that
    // really is a `V[]` counts, so decorative object vars still warn below.
    const method = name.slice(head.length + 1);
    if (method && !method.includes(".") && !head.includes(".") && ARRAY_METHODS.has(method)) {
      const s = this.lookup(head);
      const self = s ? s.cur : undefined;
      if (Array.isArray(self)) return this.runArray(method, args, self);
    }
    if (this.lookup(head)) {
      this.warn(`${name}() 作用于对象变量 "${head}"，本实现不支持该调用，已忽略`);
      return nothing;
    }
    assertUnsupported(name);
    throw new PineError(`未实现的函数 "${name}()"。可用：ta.* / math.* / str.* / input.* / plot*`);
  }

  /**
   * Shared body for both array call shapes. `self === null` is the free form
   * `array.<op>(arr, …)` (target is the first value); a non-null `self` is the
   * method form `arr.<op>(…)`. Constructors never carry a target.
   */
  private runArray(method: string, args: Arg[], self: V[] | null): V {
    const vals = args.map((a) => this.val(a.value));
    if (ARRAY_CTOR[method]) return ARRAY_CTOR[method](vals);
    let arr: V[];
    let p: V[];
    if (self !== null) {
      arr = self;
      p = vals;
    } else {
      const first = vals[0];
      if (!Array.isArray(first)) {
        throw new PineError(`array.${method}() 的第一个参数必须是数组变量`);
      }
      arr = first;
      p = vals.slice(1);
    }
    const fn = ARRAY_OPS[method];
    if (!fn) {
      throw new PineError(`暂不支持 array.${method}()。可用：${Object.keys(ARRAY_OPS).join(" ")}`);
    }
    return fn(arr, p, this.ctx);
  }

  /**
   * Free-form `map.<op>(m, …)` only: the target map is the first value (an
   * interleaved `[k0, v0, …]` `V[]`); a constructor (`map.new`/`map.new<k, v>`,
   * generics already stripped by the parser) takes no target.
   */
  private runMap(method: string, args: Arg[]): V {
    const vals = args.map((a) => this.val(a.value));
    if (MAP_CTOR[method]) return MAP_CTOR[method](vals);
    const fn = MAP_OPS[method];
    if (!fn) {
      throw new PineError(`暂不支持 map.${method}()。可用：${Object.keys(MAP_OPS).join(" ")}`);
    }
    const first = vals[0];
    if (!Array.isArray(first)) {
      throw new PineError(`map.${method}() 的第一个参数必须是 map 变量`);
    }
    return fn(first, vals.slice(1), this.ctx);
  }

  /**
   * Free-form `matrix.<op>(m, …)` only: the target matrix is the first value (an
   * array-of-row `V[]`); a constructor (`matrix.new`/`matrix.new<float>`, generics
   * already stripped by the parser) takes no target. `matrix.mult(a, b)` passes
   * both matrices positionally — `a` is the target, `b` the first param.
   */
  private runMatrix(method: string, args: Arg[]): V {
    const vals = args.map((a) => this.val(a.value));
    if (MATRIX_CTOR[method]) return MATRIX_CTOR[method](vals);
    const fn = MATRIX_OPS[method];
    if (!fn) {
      throw new PineError(`暂不支持 matrix.${method}()。可用：${Object.keys(MATRIX_OPS).join(" ")}`);
    }
    const first = vals[0];
    // An uninitialized matrix field (`matrix<float> l9 = na`) is na, not a matrix
    // value; return na so the caller's math propagates rather than aborting.
    if (!Array.isArray(first)) return NA;
    return fn(first, vals.slice(1), this.ctx);
  }

  /* ------------------------------------------------------------ header call */

  private header(name: string, args: Arg[]): V {
    const c = this.ctx;
    if (!this.headerSeen) {
      this.headerSeen = true;
      this.kind = name === "strategy" ? "strategy" : "indicator";
      this.title = strArg(args, c, 0, this.kind === "strategy" ? "Pine 策略" : "Pine 指标", "title", "Name");
      // TradingView defaults a strategy onto the price chart and an indicator
      // into its own pane; an explicit `overlay=` overrides either way.
      this.overlay = flagArg(args, c, NAMED_ONLY, this.kind === "strategy", "overlay");
      const fmt = strArg(args, c, NAMED_ONLY, "", "format");
      if (fmt) this.format = fmt;
      if (this.format === "price" || this.format === "mintick") this.overlay = true;
      const prec = numArg(args, c, NAMED_ONLY, NA, "precision");
      this.precision = Number.isNaN(prec) ? undefined : prec;
      const back = numArg(args, c, NAMED_ONLY, NA, "max_bars_back");
      if (!Number.isNaN(back) && back > 0) this.histCap = Math.min(HIST_CAP, Math.trunc(back));
      if (this.kind === "strategy") this.sim.configure(args, this.ctx);
      else if (flagArg(args, c, NAMED_ONLY, false, "ohlc4")) this.overlay = true;
      for (const key of ["buy", "sell", "short", "cover"] as const) {
        const hit = args.find((a) => a.name === key);
        if (!hit) continue;
        const dir: 1 | -1 = key === "buy" || key === "cover" ? 1 : -1;
        this.legacyOrders.push({ expr: hit.value, dir });
      }
    }
    for (const o of this.legacyOrders) {
      if (isTrue(this.val(o.expr))) this.sim.legacySignal(o.dir);
    }
    return sentinel("void");
  }

  /* --------------------------------------------------------------- plotting */

  private displayName(raw: string): string {
    const base = raw.trim() || `系列${this.lines.length + 1}`;
    if (!this.lines.some((l) => l.name === base)) return base;
    let n = 2;
    while (this.lines.some((l) => l.name === `${base} (${n})`)) n++;
    return `${base} (${n})`;
  }

  private styleOf(args: Arg[], index = 4): PlotStyle {
    // `plot(series, title, color, linewidth, style, …)`; named `style=` wins.
    const style = strArg(args, this.ctx, index, "", "style");
    if (style.includes("circles") || style.includes("cross")) return "circle";
    if (style.includes("column") || style.includes("histogram") || style.includes("bar")) return "bar";
    return "line";
  }

  private ensureLine(cid: number, title: string, args: Arg[], force?: PlotStyle): PineLine {
    const hit = this.lineByCid.get(cid);
    if (hit) return hit;
    const style = force ?? this.styleOf(args);
    const colorExpr = argAt(args, 2, "color");
    const line: PineLine = {
      name: this.displayName(title),
      values: new Array<number>(this.bars.list.length).fill(NA),
      style,
      baseValue: style === "bar" ? 0 : undefined,
      color: colorExpr ? resolveColor(this.val(colorExpr)) : undefined,
      offset: 0,
    };
    this.lines.push(line);
    this.lineByCid.set(cid, line);
    return line;
  }

  private doPlot(args: Arg[], cid: number, force?: PlotStyle): V {
    const c = this.ctx;
    // `display=display.none` is a real plot (imported scripts use it as a fill
    // anchor or as a value carrier), it just draws nothing.
    if (strArg(args, c, NAMED_ONLY, "", "display").includes("none")) {
      const series = argAt(args, 0, "series", "value", "y");
      if (series) this.val(series);
      return sentinel(`plot:${cid}`);
    }
    const series = argAt(args, 0, "series", "value", "y");
    const value = series ? asNum(this.val(series)) : NA;
    const line = this.ensureLine(cid, strArg(args, c, 1, "", "title"), args, force);
    // `plot(series, title, color, linewidth, style, trackprice, histbase, offset)`
    const offset = Math.trunc(numArg(args, c, 7, 0, "offset"));
    line.offset = offset;
    const at = this.bi + offset;
    if (at >= 0 && at < line.values.length) line.values[at] = value;
    return sentinel(`plot:${cid}`);
  }

  private ensureMarker(cid: number, title: string, color?: string): PineMarker {
    const hit = this.markerByCid.get(cid);
    if (hit) return hit;
    const n = this.bars.list.length;
    const m: PineMarker = {
      name: title.trim() || `标记${this.markers.length + 1}`,
      values: new Array<number>(n).fill(NA),
      texts: new Array<string>(n).fill(""),
      up: new Array<boolean>(n).fill(true),
    };
    if (color) m.color = color;
    this.markers.push(m);
    this.markerByCid.set(cid, m);
    return m;
  }

  private tradeMarker(name: string): PineMarker {
    const hit = this.markers.find((m) => m.name === name);
    if (hit) return hit;
    const n = this.bars.list.length;
    const m: PineMarker = {
      name,
      values: new Array<number>(n).fill(NA),
      texts: new Array<string>(n).fill(""),
      up: new Array<boolean>(n).fill(true),
    };
    this.markers.push(m);
    return m;
  }

  /** Fill dot reported by the order simulator. */
  private markTrade(i: number, name: string, up: boolean, price: number): void {
    const m = this.tradeMarker(name);
    if (!m.color) m.color = up ? "#26a69a" : "#ef5350";
    m.values[i] = price;
    m.up[i] = up;
    m.texts[i] = up ? "B" : "S";
  }

  private doShape(args: Arg[], cid: number, isChar: boolean): V {
    const c = this.ctx;
    const series = argAt(args, 0, "series", "condition");
    // plotshape(series, title, style, location, color, text, …)
    // plotchar(series, title, char, location, color, …)
    const colorExpr = argAt(args, 4, "color");
    const marker = this.ensureMarker(
      cid,
      strArg(args, c, 1, "", "title"),
      colorExpr ? resolveColor(this.val(colorExpr)) : undefined,
    );
    if (!series || !isTrue(this.val(series))) return sentinel(`plot:${cid}`);
    const loc = strArg(args, c, 3, "", "location");
    const shape = isChar ? "" : strArg(args, c, 2, "", "style", "shape");
    const text = isChar ? strArg(args, c, 2, "", "char") : strArg(args, c, 5, "", "text");
    const b = this.bars;
    const hi = b.high[this.bi];
    const lo = b.low[this.bi];
    // `shape.triangledown` implies below the bar even without location.belowbar.
    const up = !loc.includes("below") && !shape.includes("down");
    let price: number;
    if (loc.includes("absolute")) price = asNum(this.val(series));
    else if (loc.includes("relative")) {
      const t = asNum(this.val(series));
      price = Number.isNaN(t) ? hi : lo + Math.min(1, Math.max(0, t)) * (hi - lo);
    } else price = up ? hi : lo;
    marker.values[this.bi] = price;
    marker.texts[this.bi] = text || (up ? "▲" : "▼");
    marker.up[this.bi] = up;
    return sentinel(`plot:${cid}`);
  }

  private doCandle(args: Arg[], cid: number): V {
    this.warn("plotcandle() 以收盘价折线显示（前端不支持四价蜡烛图元）");
    const closeArg = argAt(args, 3, "close");
    const line = this.ensureLine(cid, strArg(args, this.ctx, 4, "", "title") || "plotcandle", [], "line");
    line.values[this.bi] = closeArg ? asNum(this.val(closeArg)) : NA;
    return sentinel(`plot:${cid}`);
  }

  private doHline(args: Arg[]): V {
    const c = this.ctx;
    const priceExpr = argAt(args, 0, "price");
    const price = priceExpr ? asNum(this.val(priceExpr)) : NA;
    if (Number.isNaN(price)) return sentinel("void");
    const key = price.toFixed(8);
    if (!this.hlineSeen.has(key)) {
      this.hlineSeen.add(key);
      // hline(price, title, color, linestyle, …)
      const colorExpr = argAt(args, 2, "color");
      const style = strArg(args, c, 3, "", "linestyle");
      this.hlines.push({
        price,
        title: strArg(args, c, 1, "", "title"),
        color: colorExpr ? resolveColor(this.val(colorExpr)) : undefined,
        style: style.includes("solid") ? "solid" : style ? "dashed" : undefined,
      });
    }
    return sentinel("void");
  }

  /* --------------------------------------------------------------- drawings */

  /** Resolve a colour argument to CSS; `transparent`/unresolved → undefined. */
  private colArg(args: Arg[], index: number, ...names: string[]): string | undefined {
    const e = argAt(args, index, ...names);
    if (!e) return undefined;
    return resolveColor(this.val(e)) || undefined;
  }

  /** A coordinate argument as a bar index / price; `na`/absent → undefined. */
  private coordArg(args: Arg[], index: number, ...names: string[]): number | undefined {
    const e = argAt(args, index, ...names);
    if (!e) return undefined;
    const n = asNum(this.val(e));
    return Number.isNaN(n) ? undefined : n;
  }

  /**
   * Normalise a drawing **x**-coordinate to a bar index so `PineResult.drawings`
   * really is in bar-index / price space (the contract `pineDrawings.ts` relies
   * on: it anchors each figure on `dataIndex`). Pine lets label/line/box x-args
   * be EITHER a `bar_index` (0..len-1, sometimes a fractional forward/back
   * offset) OR a `time` (epoch millis) — real community scripts routinely pass
   * `time`. A raw timestamp stored as `dataIndex` (~1.7e12) would land far past
   * the last bar and render invisibly, so fold any timestamp onto its nearest
   * bar. Bar indices never reach 1e9, so that threshold cleanly separates the
   * two without disturbing fractional `bar_index` offsets. Y is a price and is
   * left untouched.
   */
  private xToBar(n: number): number {
    if (n < 1e9) return n; // already a bar_index (possibly a fractional offset)
    const times = this.bars.time;
    const len = times.length;
    if (len === 0) return n;
    // Timestamps ascend with the bars: binary-search the closest one to `n`.
    let lo = 0;
    let hi = len - 1;
    let best = 0;
    let bestDiff = Math.abs((times[0] ?? 0) - n);
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const diff = Math.abs((times[mid] ?? 0) - n);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = mid;
      }
      if (n < (times[mid] ?? 0)) hi = mid - 1;
      else lo = mid + 1;
    }
    return best;
  }

  /** `bgcolor(color, title, transp)` — remember this bar's background. */
  private doBgColor(args: Arg[]): V {
    try {
      const col = this.colArg(args, 0, "color");
      if (col) {
        const transp = numArg(args, this.ctx, 2, 0, "transp");
        this.bgColor[this.bi] = col;
        this.bgAlpha[this.bi] = Math.max(0, Math.min(1, 1 - transp / 100));
      }
    } catch {
      // Decorative: an unreadable colour must never abort a numeric run.
    }
    return sentinel("void");
  }

  /** `barcolor(color, title, offset)` — remember this bar's candle colour. */
  private doBarColor(args: Arg[]): V {
    try {
      const col = this.colArg(args, 0, "color");
      if (col) {
        this.barColor[this.bi] = col;
        this.barAlpha[this.bi] = 1;
      }
    } catch {
      // Decorative; never break the run.
    }
    return sentinel("void");
  }

  /** Extract the plot id from a `plot()` sentinel reference (`@plot:<cid>`). */
  private plotCid(v: V): number | undefined {
    if (typeof v === "string" && v.startsWith("@plot:")) {
      const n = Number.parseInt(v.slice("@plot:".length), 10);
      return Number.isNaN(n) ? undefined : n;
    }
    return undefined;
  }

  /**
   * `fill(plot1, plot2, color, …)` — record the pair of plots to shade between.
   * The polygon is built at `build()` from the two lines' finished values, so a
   * per-bar call only registers the reference (and colour) once. Decorative: a
   * bad reference must never abort the numeric run.
   */
  private doFill(args: Arg[]): V {
    try {
      const a = argAt(args, 0, "plot1", "p1");
      const b = argAt(args, 1, "plot2", "p2");
      if (!a || !b) return sentinel("void");
      const cidA = this.plotCid(this.val(a));
      const cidB = this.plotCid(this.val(b));
      if (cidA === undefined || cidB === undefined) return sentinel("void");
      const key = cidA <= cidB ? `${cidA}:${cidB}` : `${cidB}:${cidA}`;
      if (this.fillSeen.has(key)) return sentinel("void");
      const col = this.colArg(args, 2, "color");
      if (!col) return sentinel("void");
      this.fillSeen.add(key);
      this.fills.push({ cidA, cidB, color: col, alpha: 1 });
    } catch {
      // Decorative; never abort the run over a fill.
    }
    return sentinel("void");
  }

  /**
   * Route a `label.*`/`box.*`/`line.*`/`table.*` call. `.new` mints a fresh
   * handle and returns it; every other method mutates the object its first
   * argument names. The handle is a plain integer, so storing it in a `var` or
   * an array and round-tripping through `set_*` works exactly like TradingView.
   */
  private runDrawing(name: string, args: Arg[]): V {
    // Drawing primitives are decorative: their arguments are only ever used to
    // place a shape, never to feed a value back into the numeric run. But now
    // that we *evaluate* those arguments (previously `isDecorativeName`
    // early-returned without touching them), a bad reference inside
    // `label.new(x=<undefined>, …)` would throw and `runBody` would turn it
    // into an abort — silently regressing a previously-ok script. Swallow every
    // such error so the drawing channel can never break the numeric run.
    try {
      const dot = name.indexOf(".");
      const head = name.slice(0, dot) as DrawObj["type"];
      const op = name.slice(dot + 1);
      if (op === "new") return this.createDraw(head, args);
      const hExpr = argAt(args, 0, "id");
      const handle = hExpr ? Math.trunc(asNum(this.val(hExpr))) : NaN;
      const obj = Number.isNaN(handle) ? undefined : this.drawObjs.get(handle);
      if (!obj || obj.deleted) return sentinel("void");
      this.applyDrawOp(obj, op, args);
      if (obj.deleted) this.drawObjs.delete(handle);
    } catch {
      // Decorative; never abort the run over a drawing.
    }
    return sentinel("void");
  }

  private createDraw(type: DrawObj["type"], args: Arg[]): V {
    if (this.drawObjs.size >= DRAW_CAP) {
      if (!this.drawCapWarned) {
        this.warn(`绘图对象超过 ${DRAW_CAP} 个上限，其余已忽略（可能是每根K线新建而未删除）`);
        this.drawCapWarned = true;
      }
      return sentinel("void");
    }
    const c = this.ctx;
    const o: DrawObj = { type };
    if (type === "label") {
      o.x = this.coordArg(args, 0, "x");
      o.y = this.coordArg(args, 1, "y");
      const t = argAt(args, 2, "text");
      o.text = t ? asStr(this.val(t)) : "";
      o.bg = this.colArg(args, 3, "color");
      o.fg = this.colArg(args, 4, "textcolor", "fg_color", "text_color");
    } else if (type === "line") {
      o.x = this.coordArg(args, 0, "x1");
      o.y = this.coordArg(args, 1, "y1");
      o.x2 = this.coordArg(args, 2, "x2");
      o.y2 = this.coordArg(args, 3, "y2");
      o.color = this.colArg(args, 6, "color");
      o.width = Math.trunc(numArg(args, c, 7, 1, "width"));
      const st = argAt(args, 8, "style");
      o.dashed = st ? /dash|dot/i.test(asStr(this.val(st))) : false;
    } else if (type === "box") {
      o.x = this.coordArg(args, 0, "left");
      o.y = this.coordArg(args, 1, "top");
      o.x2 = this.coordArg(args, 2, "right");
      o.y2 = this.coordArg(args, 3, "bottom");
      o.color = this.colArg(args, 4, "border_color");
      o.bg = this.colArg(args, 5, "bg_color");
    } else if (type === "table") {
      o.corner = Math.trunc(numArg(args, c, 2, 0, "position"));
      o.cells = new Map();
    }
    const id = this.drawIdSeq++;
    this.drawObjs.set(id, o);
    return id;
  }

  /** Apply one `set_*`/`delete`/`cell` mutation to a drawing object. */
  private applyDrawOp(o: DrawObj, op: string, args: Arg[]): void {
    const c = this.ctx;
    switch (op) {
      case "delete":
        o.deleted = true;
        return;
      case "set_text": {
        const e = argAt(args, 1, "text");
        if (e) o.text = asStr(this.val(e));
        return;
      }
      case "set_x":
      case "set_x1":
      case "set_left":
        o.x = this.coordArg(args, 1, "x", "x1", "left");
        return;
      case "set_y":
      case "set_y1":
      case "set_top":
        o.y = this.coordArg(args, 1, "y", "y1", "top");
        return;
      case "set_x2":
      case "set_right":
        o.x2 = this.coordArg(args, 1, "x2", "right");
        return;
      case "set_y2":
      case "set_bottom":
        o.y2 = this.coordArg(args, 1, "y2", "bottom");
        return;
      case "set_xy":
      case "set_xy1":
        o.x = this.coordArg(args, 1, "x", "x1");
        o.y = this.coordArg(args, 2, "y", "y1");
        return;
      case "set_xy2":
        o.x2 = this.coordArg(args, 1, "x2");
        o.y2 = this.coordArg(args, 2, "y2");
        return;
      case "set_color":
        if (o.type === "label") o.bg = this.colArg(args, 1, "color");
        else o.color = this.colArg(args, 1, "color");
        return;
      case "set_border_color":
        o.color = this.colArg(args, 1, "border_color");
        return;
      case "set_bg_color":
        o.bg = this.colArg(args, 1, "bg_color");
        return;
      case "set_text_color":
      case "set_textcolor":
        o.fg = this.colArg(args, 1, "text_color", "textcolor");
        return;
      case "set_width":
        o.width = Math.trunc(numArg(args, c, 1, o.width ?? 1, "width"));
        return;
      case "set_style": {
        const e = argAt(args, 1, "style");
        o.dashed = e ? /dash|dot/i.test(asStr(this.val(e))) : o.dashed;
        return;
      }
      case "cell": {
        if (!o.cells) return;
        const col = Math.trunc(numArg(args, c, 1, 0, "column"));
        const row = Math.trunc(numArg(args, c, 2, 0, "row"));
        const te = argAt(args, 3, "text");
        o.cells.set(`${row},${col}`, {
          text: te ? asStr(this.val(te)) : "",
          bg: this.colArg(args, 7, "bg_color"),
          fg: this.colArg(args, 4, "text_color"),
        });
        return;
      }
      default:
        // Unknown accessor (`label.get_text`, …): harmless read, ignore.
        return;
    }
  }

  /** Flatten per-bar colour arrays + live objects into the drawing channel. */
  private emitDrawings(): PineDrawing[] {
    const out: PineDrawing[] = [];
    // Merge consecutive bars that share a background colour into one rect run.
    for (let i = 0; i < this.bgColor.length; i++) {
      const col = this.bgColor[i];
      if (!col) continue;
      const a = this.bgAlpha[i];
      let j = i;
      while (j + 1 < this.bgColor.length && this.bgColor[j + 1] === col && this.bgAlpha[j + 1] === a) j++;
      out.push({ kind: "bg", color: col, alpha: a, startBar: i, endBar: j });
      i = j;
    }
    for (let b = 0; b < this.barColor.length; b++) {
      const col = this.barColor[b];
      if (col) out.push({ kind: "bar", color: col, alpha: this.barAlpha[b] ?? 1, bar: b });
    }
    for (const o of this.drawObjs.values()) {
      if (o.deleted) continue;
      if (o.type === "label") {
        if (o.x !== undefined && o.y !== undefined)
          out.push({ kind: "label", bar: Math.round(this.xToBar(o.x)), price: o.y, text: o.text ?? "", bg: o.bg, fg: o.fg });
      } else if (o.type === "line") {
        if (o.x !== undefined && o.y !== undefined && o.x2 !== undefined && o.y2 !== undefined)
          out.push({
            kind: "line",
            x1: Math.round(this.xToBar(o.x)),
            y1: o.y,
            x2: Math.round(this.xToBar(o.x2)),
            y2: o.y2,
            color: o.color,
            width: o.width,
            dashed: o.dashed,
          });
      } else if (o.type === "box") {
        if (o.x !== undefined && o.y !== undefined && o.x2 !== undefined && o.y2 !== undefined)
          out.push({
            kind: "box",
            x1: Math.round(this.xToBar(o.x)),
            y1: o.y,
            x2: Math.round(this.xToBar(o.x2)),
            y2: o.y2,
            border: o.color,
            bg: o.bg,
          });
      } else if (o.type === "table" && o.cells && o.cells.size) {
        const cells: { row: number; col: number; text: string; bg?: string; fg?: string }[] = [];
        for (const [k, v] of o.cells) {
          const [r, cl] = k.split(",");
          cells.push({ row: Number(r), col: Number(cl), text: v.text, bg: v.bg, fg: v.fg });
        }
        out.push({ kind: "table", corner: o.corner ?? 0, cells });
      }
    }
    // Fill bands between two plots, built from the finished line values. A bar is
    // only included when BOTH lines are finite there, so warmup `na` doesn't drag
    // the polygon to the axis.
    for (const f of this.fills) {
      const la = this.lineByCid.get(f.cidA);
      const lb = this.lineByCid.get(f.cidB);
      if (!la || !lb) continue;
      const n = Math.min(la.values.length, lb.values.length);
      const pts: { bar: number; top: number; bottom: number }[] = [];
      for (let i = 0; i < n; i++) {
        const va = la.values[i];
        const vb = lb.values[i];
        if (Number.isNaN(va) || Number.isNaN(vb)) continue;
        pts.push({ bar: i, top: va, bottom: vb });
      }
      if (pts.length >= 2) out.push({ kind: "fill", color: f.color, alpha: f.alpha, pts });
    }
    return out;
  }

  /* ----------------------------------------------------------------- inputs */

  private doInput(name: string, args: Arg[], cid: number): V {
    const c = this.ctx;
    const suffix = name === "input" ? "" : name.slice("input.".length);
    const defExpr = argAt(args, 0, "defval", "value", "source", "initial", "defvalue");
    const titleExpr = argAt(args, 1, "title", "label", "name");
    // v3/v4 declare a source input as `input(..., type=source, defval=close)` or
    // `type=input.source`, not the v5 `input.source()` method. Read the `type=`
    // argument so these bind to the live source series instead of falling into
    // the scalar branch (which pins the value to `defval`'s bar-0 number).
    const typeExpr = args.find((a) => a.name === "type")?.value;
    const typeHint = typeExpr && typeExpr.k === "id" ? typeExpr.name : "";
    // A bare `input(defval="SMA", options=["EMA","SMA",…])` (v3) is a string
    // enum even without the `input.string` suffix; without this it fell into
    // the scalar branch and `asNum("SMA")` pinned it to na. But `options=`
    // alone is *not* enough: numeric enums like
    // `input(type=input.integer, options=[1,2,3,4])` must stay in the scalar
    // (int/float) branch or their value degrades to a string and `plot(x)`
    // goes blank. The kind check below keys off the string-ness of type/defval/
    // options, not merely the presence of `options=`.
    const hasOptions = args.some((a) => a.name === "options");
    const isSourceInput =
      suffix === "source" ||
      typeHint === "source" ||
      typeHint.endsWith(".source") ||
      (this.target || "").toLowerCase() === "source";
    let idx = this.inputByCid.get(cid);
    if (idx === undefined) {
      idx = this.inputs.length;
      this.inputByCid.set(cid, idx);
      const label = titleExpr ? asStr(this.val(titleExpr)) : "";
      const input: PineInput = {
        varName: this.target || `${suffix || "input"}${idx + 1}`,
        label: label || this.target || `参数${idx + 1}`,
        kind: "float",
        def: 0,
        group: strArg(args, c, NAMED_ONLY, "", "group") || undefined,
      };
      const min = numOrUndef(numArg(args, c, NAMED_ONLY, NA, "minval"));
      const max = numOrUndef(numArg(args, c, NAMED_ONLY, NA, "maxval"));
      const step = numOrUndef(numArg(args, c, NAMED_ONLY, NA, "step"));
      // Decide string-vs-numeric enum from the *type hint* and the *string-ness*
      // of the defval / option list, so `type=input.integer` numeric enums stay
      // numbers while `input("SMA", options=[…])` string enums go to "other".
      const tn = typeHint.toLowerCase().replace(/^input\./, "");
      const typeIsNumeric = tn === "int" || tn === "integer" || tn === "float" || tn === "double";
      const typeIsString = tn === "string" || tn === "session" || tn === "symbol" || tn === "time";
      const optExprKind = args.find((a) => a.name === "options")?.value;
      const optListKind = optExprKind ? this.val(optExprKind) : [];
      const optsAreStrings =
        Array.isArray(optListKind) && optListKind.some((x) => typeof x === "string" && !x.startsWith("@"));
      const defIsString = !!defExpr && defExpr.k === "str";
      const isStringEnum =
        suffix === "string" ||
        suffix === "session" ||
        suffix === "symbol" ||
        suffix === "time" ||
        typeIsString ||
        (hasOptions && !typeIsNumeric && (optsAreStrings || defIsString));
      if (isSourceInput) {
        input.kind = "source";
        input.def = -1;
        input.options = SOURCE_KEYS.slice();
      } else if (suffix === "bool") {
        input.kind = "bool";
        input.def = defExpr && isTrue(this.val(defExpr)) ? 1 : 0;
        input.min = 0;
        input.max = 1;
        input.step = 1;
      } else if (isStringEnum) {
        const optExpr = args.find((a) => a.name === "options")?.value;
        const list = optExpr ? this.val(optExpr) : [];
        const opts = Array.isArray(list) ? list.map((x) => asStr(x)) : [];
        const want = defExpr ? asStr(this.val(defExpr)) : "";
        input.kind = "other";
        input.options = opts.length ? opts : [want];
        input.def = Math.max(0, input.options.indexOf(want));
      } else {
        const raw = defExpr ? asNum(this.val(defExpr)) : NA;
        input.kind = suffix === "int" || (suffix === "" && Number.isInteger(raw) && step === undefined) ? "int" : "float";
        input.def = input.kind === "int" ? Math.trunc(raw) : raw;
        input.min = min;
        input.max = max;
        input.step = step;
      }
      this.inputs.push(input);
    }
    const input = this.inputs[idx];
    const chosen = this.params[idx];
    if (input.kind === "source") {
      const sel = chosen === undefined ? input.def : chosen;
      if (sel >= 0 && sel < SOURCE_KEYS.length) return this.sourceAt(SOURCE_KEYS[sel], this.bi);
      return defExpr ? asNum(this.val(defExpr)) : this.bars.close[this.bi];
    }
    if (input.kind === "other") {
      const sel = Math.trunc(chosen === undefined ? input.def : chosen);
      const list = input.options ?? [];
      return list.length ? list[Math.min(Math.max(0, sel), list.length - 1)] : "";
    }
    const raw = chosen === undefined ? input.def : chosen;
    if (Number.isNaN(raw)) return NA;
    if (input.kind === "bool") return raw !== 0 ? 1 : 0;
    const lo = input.min ?? -Number.MAX_VALUE;
    const hi = input.max ?? Number.MAX_VALUE;
    const clamped = Math.min(hi, Math.max(lo, raw));
    return input.kind === "int" ? Math.trunc(clamped) : clamped;
  }

  private sourceAt(key: string, i: number): number {
    const b = this.bars;
    switch (key) {
      case "open":
        return b.open[i];
      case "high":
        return b.high[i];
      case "low":
        return b.low[i];
      case "volume":
        return b.volume[i];
      case "hl2":
        return (b.high[i] + b.low[i]) / 2;
      case "hlc3":
        return (b.high[i] + b.low[i] + b.close[i]) / 3;
      case "hlcc4":
        return (b.high[i] + b.low[i] + b.close[i] + b.close[i]) / 4;
      case "ohlc4":
        return (b.open[i] + b.high[i] + b.low[i] + b.close[i]) / 4;
      default:
        return b.close[i];
    }
  }

  /* -------------------------------------------------------------- reporting */

  private build(): PineResult {
    const keep = this.lines.filter((l) => l.values.some((v) => !Number.isNaN(v)));
    const dropped = this.lines.length - keep.length;
    if (dropped) this.warn(`${dropped} 条 plot 全区间无数据，已隐藏`);
    const result: PineResult = {
      scriptKind: this.kind,
      title: this.title || (this.kind === "strategy" ? "Pine 策略" : "Pine 指标"),
      overlay: this.overlay,
      format: this.format,
      precision: this.precision,
      inputs: this.inputs.slice(),
      lines: keep,
      markers: this.markers.filter((m) => m.values.some((v) => !Number.isNaN(v))),
      hlines: this.hlines.slice(),
      drawings: this.emitDrawings(),
      warnings: this.warns.slice(),
      bars: this.bi < 0 ? 0 : this.bi + 1,
    };
    if (this.precision !== undefined) result.precision = this.precision;
    if (this.lowerTfSeen.size) result.lowerTfMs = [...this.lowerTfSeen];
    if (this.kind === "strategy") result.report = this.sim.report();
    return result;
  }
}

/** Run already-parsed Pine source against bars. */
export function runPine(src: string, bars: PineBars, opts?: PineRunOptions): PineResult {
  return new PineRuntime(src, bars, opts).run();
}

export type { PineRunOptions as RunOptions };
