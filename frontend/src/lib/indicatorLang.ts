import { registerIndicator, type Chart, type KLineData } from "klinecharts";

/**
 * Mini formula language for user-written indicators (local custom ⑩).
 *
 * Written as a tokenizer + recursive-descent parser + tree-walking evaluator,
 * NOT `new Function`/eval: the app ships a hard CSP (`script-src 'self'`, see
 * agent/src/api/security.py) that forbids runtime compilation, so an eval-based
 * engine works in the vite dev server but is blocked dead in production mode
 * (verified end-to-end 2026-09-04). An interpreter also gives line-numbered
 * error messages and — having no loop constructs at all — cannot hang.
 *
 * Surface syntax (Pine-flavoured, array/vector semantics):
 *
 *   fast = ema(close, P[0]);          // assignments, `;` terminated
 *   return { EMA_F: fast };           // or a bare array
 *
 *   Series    open high low close volume hl2 hlc3
 *   Params    P (number[]), e.g. P[0]
 *   Ops       + - * / %  > < >= <= == !=  and or not  ?:   ()
 *   Vectors   arithmetic broadcasts element-wise; a scalar meets a series by
 *             stretching to that series' length (so `return { LINE: 70 }`
 *             draws a flat line)
 *   Helpers   ma sma ema rma stdev dev sum cumsum hh ll ref change roc cross
 *             nz where abs max min avg sqrt pow log log10 round floor ceil
 *             sign na() len
 *
 * Outputs are number arrays aligned with the bar list; NaN (and ±Infinity)
 * render as gaps. Comments: `//`, `#` to end of line, and `/* ... * /` blocks.
 */

export type FormulaRows = Record<string, number | undefined>;

type NumArray = number[];

/** A value inside the language: a scalar or a series of scalars. */
type Val = number | NumArray;

const NAN = Number.NaN;

/** User-facing failure with a position already baked into the message. */
export class FormulaError extends Error {}

/* ------------------------------------------------------------------ series
 * Rolling helpers are exported (and unit-tested) as plain array functions. */

/** Replace NaN/undefined with 0 (useful for gain/loss style sequences). */
export function nz(x: NumArray): NumArray {
  return x.map((v) => (Number.isFinite(v) ? v : 0));
}

/** Simple moving average over window n (a NaN inside the window yields NaN). */
export function ma(x: NumArray, n: number): NumArray {
  const out = new Array<NumArray[number]>(x.length).fill(NAN);
  if (n <= 0) return out;
  for (let i = n - 1; i < x.length; i++) {
    let acc = 0;
    let ok = true;
    for (let j = i - n + 1; j <= i; j++) {
      if (Number.isNaN(x[j])) { ok = false; break }
      acc += x[j];
    }
    if (ok) out[i] = acc / n;
  }
  return out;
}

/** Exponential moving average, seeded with the first value (fast warm-up).
 *  NaN inputs carry the previous value forward instead of poisoning. */
export function ema(x: NumArray, n: number): NumArray {
  const out = new Array<NumArray[number]>(x.length).fill(NAN);
  if (n <= 0) return out;
  const k = 2 / (n + 1);
  let prev = NAN;
  for (let i = 0; i < x.length; i++) {
    if (!Number.isNaN(x[i])) prev = Number.isNaN(prev) ? x[i] : x[i] * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** Wilder's smoothing (RMA) — the basis of classic RSI/ATR. NaN-carry-safe. */
export function rma(x: NumArray, n: number): NumArray {
  const out = new Array<NumArray[number]>(x.length).fill(NAN);
  if (n <= 0) return out;
  let prev = NAN;
  for (let i = 0; i < x.length; i++) {
    if (Number.isNaN(x[i])) { out[i] = prev; continue }
    if (Number.isNaN(prev) && i < n - 1) continue;
    if (Number.isNaN(prev)) {
      let acc = 0;
      let ok = true;
      for (let j = 0; j <= i; j++) {
        if (Number.isNaN(x[j])) { ok = false; break }
        acc += x[j];
      }
      prev = ok ? acc / n : NAN;
    } else {
      prev = (prev * (n - 1) + x[i]) / n;
    }
    out[i] = prev;
  }
  return out;
}

/** Sample standard deviation over window n. */
export function stdev(x: NumArray, n: number): NumArray {
  const out = new Array<NumArray[number]>(x.length).fill(NAN);
  if (n < 2) return out;
  for (let i = n - 1; i < x.length; i++) {
    let mean = 0;
    for (let j = i - n + 1; j <= i; j++) mean += x[j];
    mean /= n;
    let sq = 0;
    for (let j = i - n + 1; j <= i; j++) sq += (x[j] - mean) ** 2;
    out[i] = Math.sqrt(sq / (n - 1));
  }
  return out;
}

/** Mean absolute deviation over window n (the exact CCI denominator). */
export function dev(x: NumArray, n: number): NumArray {
  const out = new Array<NumArray[number]>(x.length).fill(NAN);
  if (n <= 0) return out;
  for (let i = n - 1; i < x.length; i++) {
    let mean = 0;
    let ok = true;
    for (let j = i - n + 1; j <= i; j++) {
      if (Number.isNaN(x[j])) { ok = false; break }
      mean += x[j];
    }
    if (!ok) continue;
    mean /= n;
    let acc = 0;
    for (let j = i - n + 1; j <= i; j++) acc += Math.abs(x[j] - mean);
    out[i] = acc / n;
  }
  return out;
}

/** Rolling sum over window n (NaN in the window yields NaN). */
export function sum(x: NumArray, n: number): NumArray {
  const out = new Array<NumArray[number]>(x.length).fill(NAN);
  if (n <= 0) return out;
  for (let i = n - 1; i < x.length; i++) {
    let acc = 0;
    let ok = true;
    for (let j = i - n + 1; j <= i; j++) {
      if (Number.isNaN(x[j])) { ok = false; break }
      acc += x[j];
    }
    if (ok) out[i] = acc;
  }
  return out;
}

/** Running total from the first bar (NaN inputs are skipped, not carried). */
export function cumsum(x: NumArray): NumArray {
  const out = new Array<NumArray[number]>(x.length).fill(NAN);
  let acc = 0;
  let started = false;
  for (let i = 0; i < x.length; i++) {
    if (!Number.isNaN(x[i])) { acc += x[i]; started = true; }
    if (started) out[i] = acc;
  }
  return out;
}

/** Rolling highest value (lookback includes the current bar; NaN inputs skipped). */
export function hh(x: NumArray, n: number): NumArray {
  const out = new Array<NumArray[number]>(x.length).fill(NAN);
  for (let i = 0; i < x.length; i++) {
    let best = NAN;
    for (let j = Math.max(0, i - n + 1); j <= i; j++) {
      if (Number.isNaN(x[j])) continue;
      if (Number.isNaN(best) || x[j] > best) best = x[j];
    }
    out[i] = best;
  }
  return out;
}

/** Rolling lowest value (lookback includes the current bar; NaN inputs skipped). */
export function ll(x: NumArray, n: number): NumArray {
  const out = new Array<NumArray[number]>(x.length).fill(NAN);
  for (let i = 0; i < x.length; i++) {
    let best = NAN;
    for (let j = Math.max(0, i - n + 1); j <= i; j++) {
      if (Number.isNaN(x[j])) continue;
      if (Number.isNaN(best) || x[j] < best) best = x[j];
    }
    out[i] = best;
  }
  return out;
}

/** Value of x n bars ago. */
export function ref(x: NumArray, n: number): NumArray {
  const out = new Array<NumArray[number]>(x.length).fill(NAN);
  for (let i = n; i < x.length; i++) out[i] = x[i - n];
  return out;
}

/** Bar-over-bar difference. */
export function change(x: NumArray): NumArray {
  return ref(x, 1).map((prev, i) => (Number.isNaN(prev) ? NAN : x[i] - prev));
}

/** Rate of change (%) over n bars. */
export function roc(x: NumArray, n: number): NumArray {
  return x.map((v, i) => {
    const prev = x[i - n];
    return i >= n && prev ? ((v / prev - 1) * 100) : NAN;
  });
}

/** 1 where `a` crossed above `b` on this bar, -1 below, else 0. */
export function cross(a: NumArray, b: NumArray): NumArray {
  return a.map((av, i) => {
    const bv = b[i];
    const ap = a[i - 1];
    const bp = b[i - 1];
    if (i === 0 || [av, bv, ap, bp].some(Number.isNaN)) return 0;
    if (ap <= bp && av > bv) return 1;
    if (ap >= bp && av < bv) return -1;
    return 0;
  });
}

/* ---------------------------------------------------------------- tokenizer */

interface Token {
  kind: "num" | "ident" | "str" | "op" | "punc" | "eof";
  value: string;
  line: number;
}

const PUNCT = new Set(["(", ")", "[", "]", "{", "}", ",", ":", ";", "?"]);
const MULTI_OPS = ["==", "!=", ">=", "<=", "&&", "||"];
const IDENT_RE = /^[A-Za-z_\u4e00-\u9fa5][A-Za-z0-9_\u4e00-\u9fa5]*/;
const NUM_RE = /^(\d[\d_]*(\.\d[\d_]*)?|\.\d[\d_]*)([eE][+-]?\d+)?/;

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  let line = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === "\n") { line++; i++; continue; }
    if (c === " " || c === "\t" || c === "\r") { i++; continue; }
    if ((c === "/" && src[i + 1] === "/") || c === "#") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) throw new FormulaError(`第 ${line} 行：注释没有闭合（缺少 */）`);
      for (let j = i; j < end; j++) if (src[j] === "\n") line++;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const startLine = line;
      let j = i + 1;
      let value = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\") { value += src[j + 1] ?? ""; j += 2; continue; }
        if (src[j] === "\n") break;
        value += src[j++];
      }
      if (src[j] !== c) throw new FormulaError(`第 ${startLine} 行：字符串没有闭合`);
      out.push({ kind: "str", value, line: startLine });
      i = j + 1;
      continue;
    }
    const num = NUM_RE.test(c) ? NUM_RE.exec(src.slice(i)) : null;
    if (num) {
      out.push({ kind: "num", value: num[0].replace(/_/g, ""), line });
      i += num[0].length;
      continue;
    }
    const name = IDENT_RE.exec(src.slice(i));
    if (name) {
      out.push({ kind: "ident", value: name[0], line });
      i += name[0].length;
      continue;
    }
    const op = MULTI_OPS.find((o) => src.startsWith(o, i));
    if (op) {
      out.push({ kind: "op", value: op, line });
      i += op.length;
      continue;
    }
    if (PUNCT.has(c)) {
      out.push({ kind: "punc", value: c, line });
      i++;
      continue;
    }
    if ("+-*/%<>!?=".includes(c)) {
      out.push({ kind: "op", value: c, line });
      i++;
      continue;
    }
    throw new FormulaError(`第 ${line} 行：无法识别的字符 "${c}"`);
  }
  out.push({ kind: "eof", value: "", line });
  return out;
}

/* -------------------------------------------------------------------- AST */

type Node =
  | { k: "num"; v: number }
  | { k: "id"; name: string; line: number }
  | { k: "obj"; entries: { key: string; value: Node }[] }
  | { k: "idx"; base: Node; index: Node; line: number }
  | { k: "call"; name: string; args: Node[]; line: number }
  | { k: "bin"; op: string; a: Node; b: Node }
  | { k: "un"; op: string; a: Node }
  | { k: "tern"; c: Node; a: Node; b: Node }
  | { k: "let"; name: string; value: Node; line: number }
  | { k: "return"; value: Node }
  | { k: "expr"; value: Node };

const RESERVED = new Set(["return", "true", "false", "and", "or", "not"]);

/* ------------------------------------------------------------------- parser */

class Parser {
  private pos = 0;
  constructor(private readonly tk: Token[]) {}

  private peek(): Token {
    return this.tk[this.pos];
  }

  private next(): Token {
    return this.tk[this.pos++];
  }

  private is(kind: Token["kind"], value?: string): boolean {
    const t = this.peek();
    return t.kind === kind && (value === undefined || t.value === value);
  }

  private eat(kind: Token["kind"], value: string): boolean {
    if (this.is(kind, value)) {
      this.pos++;
      return true;
    }
    return false;
  }

  private expect(kind: Token["kind"], value: string): Token {
    const t = this.peek();
    if (t.kind !== kind || t.value !== value) {
      throw new FormulaError(`第 ${t.line} 行：需要 "${value}"，实际是 "${t.value || "文件结尾"}"`);
    }
    this.pos++;
    return t;
  }

  parseProgram(): Node[] {
    const body: Node[] = [];
    while (!this.is("eof")) body.push(this.parseStatement());
    if (body.length === 0) throw new FormulaError("公式是空的");
    return body;
  }

  private parseStatement(): Node {
    if (this.eat("ident", "return")) {
      const value = this.parseExpr();
      this.eat("punc", ";");
      return { k: "return", value };
    }
    // `name = expr` (but not `name == expr`)
    if (this.is("ident") && this.tk[this.pos + 1]?.kind === "op" && this.tk[this.pos + 1].value === "=") {
      const name = this.next().value;
      this.next(); // consume "="
      const value = this.parseExpr();
      this.eat("punc", ";");
      return { k: "let", name, value, line: this.tk[this.pos].line };
    }
    const expr = this.parseExpr();
    this.eat("punc", ";");
    return { k: "expr", value: expr };
  }

  private parseExpr(): Node {
    return this.parseTernary();
  }

  private parseTernary(): Node {
    const c = this.parseOr();
    if (!this.eat("punc", "?")) return c;
    const a = this.parseTernary();
    this.expect("punc", ":");
    const b = this.parseTernary();
    return { k: "tern", c, a, b };
  }

  private parseBinary(ops: string[], next: () => Node): Node {
    let a = next();
    while (this.is("op") && ops.includes(this.peek().value)) {
      const op = this.next().value;
      a = { k: "bin", op, a, b: next() };
    }
    return a;
  }

  private parseOr(): Node {
    const wordOps = ["or", "||"];
    let a = this.parseAnd();
    while (this.isWordOp(wordOps)) {
      this.next();
      a = { k: "bin", op: "or", a, b: this.parseAnd() };
    }
    return a;
  }

  private parseAnd(): Node {
    const wordOps = ["and", "&&"];
    let a = this.parseComparison();
    while (this.isWordOp(wordOps)) {
      this.next();
      a = { k: "bin", op: "and", a, b: this.parseComparison() };
    }
    return a;
  }

  private isWordOp(ops: string[]): boolean {
    const t = this.peek();
    return (t.kind === "op" && ops.includes(t.value)) || (t.kind === "ident" && ops.includes(t.value));
  }

  private parseComparison(): Node {
    return this.parseBinary([">", "<", ">=", "<=", "==", "!="], this.parseAdditive.bind(this));
  }

  private parseAdditive(): Node {
    return this.parseBinary(["+", "-"], this.parseMultiplicative.bind(this));
  }

  private parseMultiplicative(): Node {
    return this.parseBinary(["*", "/", "%"], this.parseUnary.bind(this));
  }

  private parseUnary(): Node {
    const t = this.peek();
    if (t.kind === "op" && (t.value === "-" || t.value === "+")) {
      this.next();
      return { k: "un", op: t.value, a: this.parseUnary() };
    }
    if ((t.kind === "ident" && t.value === "not") || (t.kind === "op" && t.value === "!")) {
      this.next();
      return { k: "un", op: "not", a: this.parseUnary() };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Node {
    let base = this.parsePrimary();
    while (this.is("punc", "[")) {
      this.next();
      const index = this.parseExpr();
      this.expect("punc", "]");
      base = { k: "idx", base, index, line: this.tk[this.pos].line };
    }
    return base;
  }

  private parsePrimary(): Node {
    const t = this.peek();
    if (t.kind === "num") {
      this.next();
      const v = Number(t.value);
      if (!Number.isFinite(v)) throw new FormulaError(`第 ${t.line} 行：数字 "${t.value}" 不合法`);
      return { k: "num", v };
    }
    if (t.kind === "punc" && t.value === "(") {
      this.next();
      const inner = this.parseExpr();
      this.expect("punc", ")");
      return inner;
    }
    if (t.kind === "punc" && t.value === "{") return this.parseObject();
    if (t.kind === "ident") {
      if (t.value === "true" || t.value === "false") {
        this.next();
        return { k: "num", v: t.value === "true" ? 1 : 0 };
      }
      this.next();
      if (RESERVED.has(t.value)) throw new FormulaError(`第 ${t.line} 行："${t.value}" 是保留字`);
      if (this.is("punc", "(")) {
        this.next();
        const args: Node[] = [];
        if (!this.is("punc", ")")) {
          do {
            args.push(this.parseExpr());
          } while (this.eat("punc", ","));
        }
        this.expect("punc", ")");
        return { k: "call", name: t.value, args, line: t.line };
      }
      return { k: "id", name: t.value, line: t.line };
    }
    throw new FormulaError(`第 ${t.line} 行：意外的内容 "${t.value || "文件结尾"}"`);
  }

  private keyName(): string {
    const t = this.peek();
    if (t.kind === "str" || t.kind === "ident") {
      this.next();
      return t.value;
    }
    throw new FormulaError(`第 ${t.line} 行：对象键名应为标识符或字符串`);
  }

  private parseObject(): Node {
    this.expect("punc", "{");
    const entries: { key: string; value: Node }[] = [];
    if (!this.is("punc", "}")) {
      do {
        const key = this.keyName();
        this.expect("punc", ":");
        entries.push({ key, value: this.parseExpr() });
      } while (this.eat("punc", ","));
    }
    this.expect("punc", "}");
    return { k: "obj", entries };
  }
}

/* -------------------------------------------------------------- broadcasting */

function isArr(v: Val): v is NumArray {
  return Array.isArray(v);
}

function scalar(v: Val): number {
  return isArr(v) ? (v[v.length - 1] ?? NAN) : v;
}

function length(v: Val, fallback: number): number {
  return isArr(v) ? v.length : fallback;
}

/** Stretch a value to a series of `len` (scalars become flat lines). */
function series(v: Val, len: number): NumArray {
  if (!isArr(v)) return new Array(len).fill(v);
  if (v.length === len) return v;
  if (v.length > len) return v.slice(0, len);
  return v.concat(new Array(len - v.length).fill(NAN));
}

/** Element-wise combine, broadcasting whichever side is scalar. */
function zip(a: Val, b: Val, f: (x: number, y: number) => number): Val {
  const len = Math.max(isArr(a) ? a.length : 0, isArr(b) ? b.length : 0);
  if (len === 0) return f(scalar(a), scalar(b));
  const A = series(a, len);
  const B = series(b, len);
  const out = new Array<number>(len);
  for (let i = 0; i < len; i++) out[i] = f(A[i], B[i]);
  return out;
}

function each(v: Val, f: (x: number) => number): Val {
  return isArr(v) ? v.map(f) : f(v);
}

function truthy(x: number): boolean {
  return x !== 0 && !Number.isNaN(x);
}

/* ----------------------------------------------------------------- builtins */

interface Ctx {
  /** Bar count of the chart the formula runs against. */
  len: number;
}

type Builtin = (args: Val[], ctx: Ctx) => Val;

const arity = (args: Val[], min: number, max: number, name: string): void => {
  if (args.length < min || args.length > max) {
    throw new FormulaError(`${name}() 需要 ${min}${max > min ? `~${max}` : ""} 个参数，实际给了 ${args.length} 个`);
  }
};

/** Rolling functions take a series + a (scalar) window. */
function windowed(
  name: string,
  fn: (x: NumArray, n: number) => NumArray,
  minArgs = 2,
  defN?: number,
): Builtin {
  return (args, ctx) => {
    arity(args, defN === undefined ? minArgs : minArgs - 1, minArgs, name);
    const x = series(args[0], ctx.len);
    const n = args.length > 1 ? Math.round(scalar(args[1])) : (defN as number);
    return fn(x, n);
  };
}

const pointwise: Builtin = (args, ctx) => {
  if (args.length === 0) throw new FormulaError("where() 需要 3 个参数");
  const cond = series(args[0], ctx.len);
  const then = series(args[1] ?? NAN, ctx.len);
  const other = series(args[2] ?? NAN, ctx.len);
  return cond.map((c, i) => (truthy(c) ? then[i] : other[i]));
};

const fold =
  (name: string, f: (a: number, b: number) => number): Builtin =>
  (args) => {
    if (args.length === 0) throw new FormulaError(`${name}() 至少需要 1 个参数`);
    return args.reduce((acc, v) => zip(acc, v, f));
  };

const variadic =
  (name: string, f: (nums: number[]) => number): Builtin =>
  (args, ctx) => {
    if (args.length === 0) throw new FormulaError(`${name}() 至少需要 1 个参数`);
    const cols = args.map((a) => series(a, ctx.len));
    return cols[0].map((_, i) => f(cols.map((c) => c[i])));
  };

const BUILTINS: Record<string, Builtin> = {
  ma: windowed("ma", ma),
  sma: windowed("sma", ma),
  ema: windowed("ema", ema),
  rma: windowed("rma", rma),
  stdev: windowed("stdev", stdev),
  dev: windowed("dev", dev),
  sum: windowed("sum", sum),
  hh: windowed("hh", hh),
  ll: windowed("ll", ll),
  ref: windowed("ref", ref),
  change: (args, ctx) => {
    arity(args, 1, 1, "change");
    return change(series(args[0], ctx.len));
  },
  roc: windowed("roc", roc),
  cross: (args, ctx) => {
    arity(args, 2, 2, "cross");
    const a = series(args[0], ctx.len);
    const b = series(args[1], ctx.len);
    return cross(a, b);
  },
  nz: (args, ctx) => {
    arity(args, 1, 2, "nz");
    const x = series(args[0], ctx.len);
    if (args.length === 1) return nz(x);
    const filler = scalar(args[1]);
    return x.map((v) => (Number.isFinite(v) ? v : filler));
  },
  cumsum: (args, ctx) => {
    arity(args, 1, 1, "cumsum");
    return cumsum(series(args[0], ctx.len));
  },
  abs: (args) => {
    arity(args, 1, 1, "abs");
    return each(args[0], Math.abs);
  },
  sqrt: (args) => {
    arity(args, 1, 1, "sqrt");
    return each(args[0], (x) => (x >= 0 ? Math.sqrt(x) : NAN));
  },
  log: (args) => {
    arity(args, 1, 1, "log");
    return each(args[0], (x) => (x > 0 ? Math.log(x) : NAN));
  },
  log10: (args) => {
    arity(args, 1, 1, "log10");
    return each(args[0], (x) => (x > 0 ? Math.log10(x) : NAN));
  },
  pow: fold("pow", Math.pow),
  max: fold("max", Math.max),
  min: fold("min", Math.min),
  avg: variadic("avg", (xs) => xs.reduce((a, b) => a + b, 0) / xs.length),
  round: (args) => {
    arity(args, 1, 2, "round");
    const digits = args.length > 1 ? scalar(args[1]) : 0;
    const p = 10 ** digits;
    return each(args[0], (x) => Math.round(x * p) / p);
  },
  floor: (args) => {
    arity(args, 1, 1, "floor");
    return each(args[0], Math.floor);
  },
  ceil: (args) => {
    arity(args, 1, 1, "ceil");
    return each(args[0], Math.ceil);
  },
  sign: (args) => {
    arity(args, 1, 1, "sign");
    return each(args[0], (x) => (Number.isNaN(x) ? NAN : Math.sign(x)));
  },
  where: pointwise,
  na: () => NAN,
  len: (args, ctx) => {
    arity(args, 1, 1, "len");
    return length(args[0], ctx.len);
  },
};

/* ---------------------------------------------------------------- evaluator */

interface Bindings {
  /** Named series supplied by the chart (open/high/low/close/volume/hl2/hlc3/P). */
  vars: Map<string, Val>;
  ctx: Ctx;
}

function evalNode(node: Node, env: Bindings): Val {
  switch (node.k) {
    case "num":
      return node.v;
    case "id": {
      if (node.name === "true") return 1;
      if (node.name === "false") return 0;
      const hit = env.vars.get(node.name);
      if (hit === undefined) {
        throw new FormulaError(
          `第 ${node.line} 行：未知变量 "${node.name}"（可用：open high low close volume hl2 hlc3 P 以及你自己赋值的名字）`,
        );
      }
      return hit;
    }
    case "obj": {
      // An object literal of series is only meaningful as a return value;
      // keep its shape and evaluate each entry. Scalars are stretched to the
      // bar length so `return { 轴: 0 }` is a flat reference line everywhere.
      const out: Record<string, Val> = {};
      for (const e of node.entries) out[e.key] = series(evalNode(e.value, env), env.ctx.len);
      return out as unknown as Val;
    }
    case "idx": {
      const base = evalNode(node.base, env);
      const idx = evalNode(node.index, env);
      if (!isArr(base)) {
        const what = node.base.k === "id" ? `"${node.base.name}"` : "这个表达式";
        throw new FormulaError(`第 ${node.line} 行：${what} 不是数组，不能用 [下标] 取值`);
      }
      if (isArr(idx)) return idx.map((i) => base[Math.trunc(i)] ?? NAN);
      const at = Math.trunc(idx);
      return Number.isNaN(at) ? NAN : (base[at] ?? NAN);
    }
    case "call": {
      const fn = BUILTINS[node.name];
      if (!fn) {
        throw new FormulaError(
          `第 ${node.line} 行：未知函数 "${node.name}()"（可用：${Object.keys(BUILTINS).join(" ")}）`,
        );
      }
      return fn(node.args.map((a) => evalNode(a, env)), env.ctx);
    }
    case "un": {
      const v = evalNode(node.a, env);
      if (node.op === "-") return each(v, (x) => -x);
      if (node.op === "+") return v;
      return each(v, (x) => (truthy(x) ? 0 : 1));
    }
    case "bin": {
      const a = evalNode(node.a, env);
      const b = evalNode(node.b, env);
      switch (node.op) {
        case "+": return zip(a, b, (x, y) => x + y);
        case "-": return zip(a, b, (x, y) => x - y);
        case "*": return zip(a, b, (x, y) => x * y);
        case "/": return zip(a, b, (x, y) => x / y);
        case "%": return zip(a, b, (x, y) => x % y);
        case ">": return zip(a, b, (x, y) => (x > y ? 1 : 0));
        case "<": return zip(a, b, (x, y) => (x < y ? 1 : 0));
        case ">=": return zip(a, b, (x, y) => (x >= y ? 1 : 0));
        case "<=": return zip(a, b, (x, y) => (x <= y ? 1 : 0));
        case "==": return zip(a, b, (x, y) => (x === y ? 1 : 0));
        case "!=": return zip(a, b, (x, y) => (x !== y ? 1 : 0));
        case "and":
          return zip(a, b, (x, y) => (truthy(x) && truthy(y) ? 1 : 0));
        case "or":
          return zip(a, b, (x, y) => (truthy(x) || truthy(y) ? 1 : 0));
        default:
          throw new FormulaError(`不支持的运算符 "${node.op}"`);
      }
    }
    case "tern": {
      const c = evalNode(node.c, env);
      if (!isArr(c)) return truthy(c) ? evalNode(node.a, env) : evalNode(node.b, env);
      const yes = evalNode(node.a, env);
      const no = evalNode(node.b, env);
      return pointwise([c, yes, no], env.ctx);
    }
    case "let": {
      const value = evalNode(node.value, env);
      env.vars.set(node.name, value);
      return value;
    }
    case "return":
    case "expr":
      return evalNode(node.value, env);
    default:
      throw new FormulaError("公式结构无法识别");
  }
}

/** Run a parsed program; the value of the last `return` wins. */
function runProgram(body: Node[], env: Bindings): Val {
  let result: Val = NAN;
  let returned = false;
  for (const stmt of body) {
    const value = evalNode(stmt, env);
    if (stmt.k === "return") {
      result = value;
      returned = true;
    }
  }
  if (!returned) throw new FormulaError("公式必须有一行 return（返回数组或 { 名称: 数组 }）");
  return result;
}

/* ------------------------------------------------------------------- public */

export interface CompiledFormula {
  /** Invoke with the bar series + params; returns the raw formula result. */
  run: (bars: KLineData[], params: number[]) => unknown;
  error?: undefined;
}

export interface CompileError {
  error: string;
}

/** Parse (and thereby validate) a formula; returns either {run} or {error}. */
export function compileFormula(code: string): CompiledFormula | CompileError {
  try {
    const body = new Parser(tokenize(code)).parseProgram();
    return {
      run: (bars, params) => {
        const close = bars.map((b) => b.close);
        const high = bars.map((b) => b.high);
        const low = bars.map((b) => b.low);
        const env: Bindings = {
          ctx: { len: bars.length },
          vars: new Map<string, Val>([
            ["open", bars.map((b) => b.open)],
            ["high", high],
            ["low", low],
            ["close", close],
            ["volume", bars.map((b) => b.volume ?? 0)],
            ["hl2", high.map((h, i) => (h + low[i]) / 2)],
            ["hlc3", high.map((h, i) => (h + low[i] + close[i]) / 3)],
            ["P", params.map((p) => Number(p))],
          ]),
        };
        return runProgram(body, env);
      },
    };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** Normalize a formula result to row objects aligned with the bar list. */
export function normalizeRows(
  result: unknown,
  len: number,
): { rows: FormulaRows[]; keys: string[]; error?: string } {
  let entries: [string, NumArray][] = [];
  if (Array.isArray(result)) {
    entries = [["v1", result as NumArray]];
  } else if (result && typeof result === "object") {
    const wanted = Object.entries(result as Record<string, unknown>).filter(
      ([, v]) => typeof v === "number" || Array.isArray(v),
    );
    if (wanted.length === 0) return { rows: [], keys: [], error: "公式没有返回任何数值数组" };
    entries = wanted.map(([k, v]) => [k, series(v as Val, len)]);
  } else {
    return { rows: [], keys: [], error: "公式必须返回数组或 { 名称: 数组 } 对象" };
  }
  if (entries.length === 0) return { rows: [], keys: [], error: "公式没有返回任何数值数组" };
  const keys = entries.map(([k]) => k);
  const rows: FormulaRows[] = [];
  for (let i = 0; i < len; i++) {
    const row: FormulaRows = {};
    for (const [k, arr] of entries) {
      const v = arr[i];
      row[k] = typeof v === "number" && Number.isFinite(v) ? v : undefined;
    }
    rows.push(row);
  }
  return { rows, keys };
}

/** Stable KLineChart indicator name for a user formula. */
export function indicatorName(id: string): string {
  return `UCI_${id}`;
}

export interface ApplySpec {
  id: string;
  label: string;
  code: string;
  params: number[];
  kind: "overlay" | "pane";
}

/**
 * Compile + register a user formula with KLineChart and mount it on the chart
 * (overlay → candle pane on the price axis; pane → its own sub-chart).
 * Returns null on success, or the human-readable error (nothing is mounted
 * in that case).
 *
 * Trial-computes against the chart's current bars first, so a broken formula
 * surfaces as panel feedback instead of an empty indicator.
 */
export function applyUserIndicator(chart: Chart, spec: ApplySpec): string | null {
  const compiled = compileFormula(spec.code);
  if ("error" in compiled) return `语法错误：${compiled.error}`;
  const bars = chart.getDataList();
  let rows: FormulaRows[];
  let keys: string[];
  try {
    const out = compiled.run(bars, spec.params);
    const norm = normalizeRows(out, bars.length);
    if (norm.error) return norm.error;
    rows = norm.rows;
    keys = norm.keys;
  } catch (e) {
    return `运行错误：${e instanceof Error ? e.message : String(e)}`;
  }
  if (!rows.some((r) => Object.values(r).some((v) => v !== undefined))) {
    return "公式在现有数据上没有产生任何数值（检查参数/返回值）";
  }
  const name = indicatorName(spec.id);
  const code = spec.code;
  const defaultParams = spec.params;
  registerIndicator({
    name,
    shortName: spec.label || name,
    precision: 4,
    series: spec.kind === "overlay" ? "price" : "normal",
    calcParams: spec.params,
    figures: keys.map((k) => ({ key: k, title: k })),
    calc: (dataList, indicator) => {
      try {
        const c = compileFormula(code);
        if ("error" in c) return dataList.map(() => ({}));
        const p = (indicator.calcParams ?? defaultParams).map((v) => Number(v));
        return normalizeRows(c.run(dataList, p), dataList.length).rows;
      } catch {
        return dataList.map(() => ({}));
      }
    },
  });
  // Re-mount so a re-registered (edited) formula recomputes cleanly.
  chart.removeIndicator({ name });
  if (spec.kind === "overlay") {
    chart.createIndicator({ name, paneId: "candle_pane" }, true);
  } else {
    chart.createIndicator({ name });
  }
  return null;
}

/** Remove a user formula from the chart (registration itself stays harmlessly). */
export function removeUserIndicator(chart: Chart, id: string): void {
  chart.removeIndicator({ name: indicatorName(id) });
}

/** Function names surfaced in the editor cheat sheet. */
export const FORMULA_FUNCTIONS = Object.keys(BUILTINS);
