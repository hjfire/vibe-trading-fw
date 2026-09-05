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
import { MISC, assertUnsupported, isDecorativeName } from "./pineMath";
import { OrderSim, estimateTick } from "./pineOrders";
import {
  NA,
  NAMED_ONLY,
  argAt,
  asNum,
  asStr,
  flagArg,
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
  type PlotStyle,
  type V,
} from "./pineTypes";

/** Hard caps: a pasted script must never freeze the chart tab. */
const HIST_CAP = 40000;
const OP_LIMIT = 2.5e7;
const LOOP_CAP = 5000;

/** Sources selectable through `input.source()`. */
const SOURCE_KEYS = ["close", "open", "high", "low", "volume", "hl2", "hlc3", "ohlc4"];

const SERIES_NAMES = new Set([
  "open", "high", "low", "close", "volume", "hl2", "hlc3", "ohlc4", "time", "timenow",
]);

/** Bare reads that are enum values rather than functions (`color.red`, …). */
const ENUM_NS =
  /^(color|location|plot|plotstyle|shape|circle|double|arrow|label|flag|square|cross|xcross|hline|order|position|trend|scale|text|chart|price_range|switch|syminfo|timeframe|duration|efl|format|ticksize|strategy|session|input|math|alert|display|size|barmerge|fontface|xloc|embed)\./;

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

  private readonly params: number[];
  private readonly opLimit: number;
  private readonly tick: number;
  private readonly strict: boolean;

  /** User-defined functions, keyed by name (`f(x) => …`). */
  private readonly fns = new Map<string, FnStmt>();
  /**
   * Current variable scope. "" is the script's global scope; a call site of a
   * user function gets `f<cid>`, because in Pine each call site keeps its own
   * history for the locals inside the body.
   */
  private scope = "";
  private fnDepth = 0;
  /** Value of the last statement run, which is how a block body returns. */
  private lastValue: V = NA;

  private bi = -1;
  private ctxCid = 0;
  private ops = 0;
  private histCap = HIST_CAP;
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

  constructor(src: string, private readonly bars: PineBars, opts: PineRunOptions = {}) {
    this.stmts = parsePine(src);
    // Hoist function definitions: real scripts open with `if … f(...)` before
    // the `f(x) =>` line, and per-bar execution must not depend on order.
    for (const s of this.stmts) if (s.k === "fn") this.fns.set(s.name, s);
    this.params = opts.params ?? [];
    this.opLimit = opts.opLimit ?? OP_LIMIT;
    this.strict = !!opts.strict;
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
        return self.bars.list.length;
      },
      bars,
      val: (e: Expr) => self.val(e),
      state: <T extends object>(init: () => T, sub = "") => {
        const key = `${self.ctxCid}#${sub}`;
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
    const s = this.lookup(name);
    if (!s) throw new PineError(`未定义的变量 "${name}"，无法取历史值`);
    const idx = s.hist.length - k;
    return idx < 0 ? NA : s.hist[idx];
  }

  private builtinAt(name: string, i: number): V {
    const b = this.bars;
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
        return (b.high[i] + b.low[i] * 2) / 3;
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
        const value = this.val(s.value);
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
        this.write(this.vkey(s.name), value, false);
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
        for (const inner of s.body) this.exec(inner);
      }
    } finally {
      if (saved) this.env.set(key, saved);
      else this.env.delete(key);
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
  private callFn(fn: FnStmt, args: Arg[], cid: number): V {
    if (this.fnDepth >= FN_DEPTH_CAP) {
      throw new PineError(`函数 "${fn.name}" 递归超过 ${FN_DEPTH_CAP} 层，请检查是否无限递归`);
    }
    const outer = this.scope;
    const bound: V[] = [];
    for (let i = 0; i < fn.params.length; i++) {
      const hit = argAt(args, i, fn.params[i].name);
      bound.push(hit ? this.val(hit) : fn.params[i].def ? this.val(fn.params[i].def as Expr) : NA);
    }
    this.fnDepth += 1;
    let out: V = NA;
    try {
      this.scope = `f${cid}`;
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
        this.ctxCid = e.cid;
        const out = this.dispatch(e);
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
        return e.op === "-" ? -v : v;
      }
      case "tern": {
        // `na ? a : b` is na in Pine — a blank plot, not the else branch.
        const cond = asNum(this.val(e.c));
        if (Number.isNaN(cond)) return NA;
        return cond !== 0 ? this.val(e.a) : this.val(e.b);
      }
    }
  }

  private readIdx(base: Expr, k: number): V {
    if (k === 0) return this.val(base);
    if (base.k === "id") return this.readBack(base.name, k);
    if (base.k === "call") {
      const s = this.env.get("f:" + base.cid);
      if (!s) {
        // First read is also the first execution of that call site.
        this.ctxCid = base.cid;
        const fresh = this.dispatch(base);
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
        return this.bars.list.length - 1;
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
          return this.bi === this.bars.list.length - 1 ? 1 : 0;
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
    if (ENUM_NS.test(name)) return sentinel(name);
    if (SERIES_NAMES.has(name)) return this.builtinAt(name, this.bi);
    if (this.lookup(name)) return this.readSeries(name);
    // Zero-arg builtins are sometimes read as plain names (`timenow`, `timeframe.period`).
    const fn = MISC[name];
    if (fn) return fn([], this.ctx);
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
    if (Number.isNaN(x) || Number.isNaN(y)) return NA;
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
      default:
        throw new PineError(`不支持的运算符 "${op}"`);
    }
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
        this.warn("fill() 的渐变填充暂未渲染，只显示两条边界线");
        return nothing;
      case "bgcolor":
        this.warn("bgcolor() 背景色暂未渲染");
        return nothing;
      case "barcolor":
        this.warn("barcolor() K线着色暂未渲染");
        return nothing;
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
      if (handled) return handled;
    }
    if (name.startsWith("ta.")) {
      const fn = TA[name.slice(3)];
      if (!fn) throw new PineError(`暂不支持 ${name}()。可用的 ta.* 函数：${availableTa()}`);
      return fn(args, this.ctx);
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
    if (this.lookup(head)) {
      this.warn(`${name}() 作用于对象变量 "${head}"，本实现不支持该调用，已忽略`);
      return nothing;
    }
    assertUnsupported(name);
    throw new PineError(`未实现的函数 "${name}()"。可用：ta.* / math.* / str.* / input.* / plot*`);
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

  /* ----------------------------------------------------------------- inputs */

  private doInput(name: string, args: Arg[], cid: number): V {
    const c = this.ctx;
    const suffix = name === "input" ? "" : name.slice("input.".length);
    const defExpr = argAt(args, 0, "defval", "value", "source", "initial", "defvalue");
    const titleExpr = argAt(args, 1, "title", "label", "name");
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
      if (suffix === "source" || (this.target || "").toLowerCase() === "source") {
        input.kind = "source";
        input.def = -1;
        input.options = SOURCE_KEYS.slice();
      } else if (suffix === "bool") {
        input.kind = "bool";
        input.def = defExpr && isTrue(this.val(defExpr)) ? 1 : 0;
        input.min = 0;
        input.max = 1;
        input.step = 1;
      } else if (suffix === "string" || suffix === "session" || suffix === "symbol" || suffix === "time") {
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
        return (b.high[i] + b.low[i] * 2) / 3;
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
      warnings: this.warns.slice(),
      bars: this.bi < 0 ? 0 : this.bi + 1,
    };
    if (this.precision !== undefined) result.precision = this.precision;
    if (this.kind === "strategy") result.report = this.sim.report();
    return result;
  }
}

/** Run already-parsed Pine source against bars. */
export function runPine(src: string, bars: PineBars, opts?: PineRunOptions): PineResult {
  return new PineRuntime(src, bars, opts).run();
}

export type { PineRunOptions as RunOptions };
