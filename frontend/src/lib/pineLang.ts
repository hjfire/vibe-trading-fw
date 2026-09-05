/**
 * Pine Script (TradingView) front-end: lexer + parser.
 *
 * This is the compatibility layer that lets a script copied from
 * https://cn.tradingview.com/scripts/ run here unchanged. It is deliberately a
 * separate engine from the mini formula language in indicatorLang.ts, because
 * the two have incompatible semantics:
 *
 *   - Pine executes the whole script **once per bar**, and `close[1]` means
 *     "one bar back". The mini language is vector-based, where `P[0]` means
 *     "the first parameter". Translating one into the other is not sound, so
 *     each dialect keeps its own evaluator.
 *   - Pine statements end at the newline and blocks are indentation-based,
 *     hence this lexer emits newline tokens and tracks each line's column.
 *   - Like the mini language, nothing here is `eval`'d: production ships a hard
 *     CSP (`script-src 'self'`) that forbids runtime compilation.
 *
 * Supported subset (see pineRuntime.ts for the built-in library):
 *   indicator()/study()/strategy() headers, `x = expr`, `x := expr`, `var x =`,
 *   `[a, b] = f(...)`, if/else if/else blocks, bounded for-loops, ternaries,
 *   `and/or/not`, comparison ops incl. `<>`, historical refs `x[n]`,
 *   namespaced calls `ta.rsi(...)`, named arguments `length=14`,
 *   user functions `f(x, y = 2) => expr` and `f(x) =>` + an indented block,
 *   strings/bools/na, plot()/plotshape()/plotchar()/hline()/fill()/bgcolor().
 *
 * Rejected with an actionable message rather than silently mis-compiling:
 *   `while`, `switch`, `type`, arrays,
 *   maps, `request.*`/`security()` multi-timeframe work (handled by runtime).
 */

export class PineError extends Error {}

export type TokKind = "num" | "ident" | "str" | "op" | "nl" | "eof";

export interface Tok {
  kind: TokKind;
  value: string;
  line: number;
  /** Column of the token; the first token of a line carries that line's indent. */
  col: number;
}

const IDENT_START = /[A-Za-z_\u4e00-\u9fa5]/;
const IDENT_BODY = /[A-Za-z0-9_\u4e00-\u9fa5]/;
const NUM_RE = /^(\d[\d_]*(\.\d[\d_]*)?|\.\d[\d_]*)([eE][+-]?\d+)?/;
/** TradingView colour literals: `#rrggbb`, optionally with alpha `#rrggbbaa`. */
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})(?![0-9a-fA-F])/;
/** Multi-char operators, longest first so `>=` never lexes as `>` + `=`. */
const OPS_MULTI = [":=", "==", "!=", "<>", ">=", "<=", "&&", "||", "=>", "+=", "-="];
const OPS_SINGLE = "+-*/%^<>=,()[]{}:?.!~";
/** A trailing operator/comma means the statement continues on the next line. */
const CONTINUE_END = new Set([
  "=", ":=", "+", "-", "*", "/", "%", "^", "<", ">", "<=", ">=", "==", "!=", "<>",
  "and", "or", "not", "to", "by", "?", ":", ",", "(", "[",
]);

export function tokenizePine(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  let col = 0;
  let depth = 0;
  const push = (kind: TokKind, value: string, atCol: number) =>
    out.push({ kind, value, line, col: atCol });

  while (i < src.length) {
    const c = src[i];
    if (c === "\n") {
      // Inside brackets a newline is plain whitespace; after a trailing
      // operator the statement continues, so no newline token either.
      const last = out[out.length - 1];
      // A trailing operator, comma or open bracket means the statement runs on.
      const continues = !!last && (last.kind === "op" || last.kind === "ident") &&
        CONTINUE_END.has(last.value);
      if (depth === 0 && !continues) push("nl", "\n", 0);
      line++;
      i++;
      col = 0;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      col += c === "\t" ? 4 - (col % 4) : 1;
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      if (end < 0) throw new PineError(`第 ${line} 行：注释没有闭合（缺少 */）`);
      for (let j = i; j < end; j++) if (src[j] === "\n") line++;
      i = end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      const startLine = line;
      const startCol = col;
      let j = i + 1;
      let value = "";
      while (j < src.length && src[j] !== c && src[j] !== "\n") {
        if (src[j] === "\\") { value += src[j + 1] ?? ""; j += 2; col += 2; continue; }
        value += src[j++];
        col++;
      }
      if (src[j] !== c) throw new PineError(`第 ${startLine} 行：字符串没有闭合`);
      push("str", value, startCol);
      col++;
      i = j + 1;
      continue;
    }
    if (c === "$") {
      // String interpolation (`"avg=" + str.tostring(x)` is the common form;
      // `$var` inline interpolation is rewritten to a plain identifier read).
      const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i + 1));
      if (!name) throw new PineError(`第 ${line} 行：无法识别的字符 "$"`);
      push("ident", name[0], col);
      col += 1 + name[0].length;
      i += 1 + name[0].length;
      continue;
    }
    if (c === "#") {
      // Hex colour literal, as TradingView's editor writes them (#2962ff, #ff000080).
      const hit = HEX_COLOR_RE.exec(src.slice(i));
      if (!hit) throw new PineError(`第 ${line} 行：无法识别的字符 "#"，颜色需写成 #rrggbb 或 #rrggbbaa`);
      push("str", hit[0], col);
      col += hit[0].length;
      i += hit[0].length;
      continue;
    }
    const num = NUM_RE.exec(src.slice(i));
    if (num && /\d|\./.test(c)) {
      // Reject `1.5foo`-style glue only loosely: numbers may be followed by `.`
      // only when it is not another digit run (handled by IDENT lexing).
      push("num", num[0].replace(/_/g, ""), col);
      col += num[0].length;
      i += num[0].length;
      continue;
    }
    if (IDENT_START.test(c)) {
      let j = i;
      while (j < src.length && (IDENT_BODY.test(src[j]) || (src[j] === "." && j + 1 < src.length && IDENT_BODY.test(src[j + 1])))) j++;
      const name = src.slice(i, j);
      push("ident", name, col);
      col += name.length;
      i = j;
      continue;
    }
    const multi = OPS_MULTI.find((o) => src.startsWith(o, i));
    if (multi) {
      if (multi === "+=" || multi === "-=") {
        throw new PineError(`第 ${line} 行：不支持 "${multi}" 复合赋值，请写成 x := x ${multi === "+=" ? "+" : "-"} y`);
      }
      push("op", multi, col);
      col += multi.length;
      i += multi.length;
      continue;
    }
    if (c === "(" || c === "[") depth++;
    if (c === ")" || c === "]") depth = Math.max(0, depth - 1);
    if (OPS_SINGLE.includes(c)) {
      push("op", c, col);
      col++;
      i++;
      continue;
    }
    throw new PineError(`第 ${line} 行：无法识别的字符 "${c}"`);
  }
  out.push({ kind: "eof", value: "", line, col });
  return out;
}

/* ---------------------------------------------------------------------- AST */

export interface Arg {
  /** Named argument (`length=14`), absent for positional ones. */
  name?: string;
  value: Expr;
}

export type Expr =
  | { k: "num"; v: number; line: number }
  | { k: "str"; v: string; line: number }
  | { k: "id"; name: string; line: number }
  | { k: "arr"; items: Expr[]; line: number }
  | { k: "idx"; base: Expr; off: Expr; line: number }
  | { k: "call"; name: string; args: Arg[]; line: number; cid: number }
  | { k: "bin"; op: string; a: Expr; b: Expr; line: number }
  | { k: "un"; op: string; a: Expr; line: number }
  | { k: "tern"; c: Expr; a: Expr; b: Expr; line: number };

export type Stmt =
  | { k: "decl"; names: string[]; value: Expr; persist: boolean; line: number }
  | { k: "assign"; name: string; value: Expr; line: number }
  | { k: "expr"; value: Expr; line: number }
  | { k: "if"; arms: { cond: Expr; body: Stmt[] }[]; elseBody: Stmt[] | null; line: number }
  | { k: "for"; varName: string; from: Expr; to: Expr; step: Expr | null; body: Stmt[]; line: number }
  | {
      k: "fn";
      name: string;
      params: { name: string; def: Expr | null }[];
      /** Inline form (`=> expr`) is a single expression; block form is statements. */
      body: Expr | Stmt[];
      line: number;
    };

/** Names that may prefix a declaration as a type annotation. */
const TYPE_WORDS = new Set([
  "int", "float", "bool", "string", "color", "time", "series", "simple", "const",
  "input", "temporary", "expr", "manual", "managed",
]);

/** Statement keywords that are never variable names. */
const KEYWORDS = new Set(["if", "else", "for", "to", "by", "while", "switch", "var", "type"]);

/** Prefixes that only introduce a user-defined function. */
const FN_KEYWORDS = new Set(["def", "function"]);

export class PineParser {
  private pos = 0;
  private cid = 0;

  constructor(private readonly tk: Tok[]) {}

  private peek(): Tok {
    return this.tk[this.pos];
  }

  private next(): Tok {
    return this.tk[this.pos++];
  }

  /** Skip newline tokens; returns the next meaningful token. */
  private skipNl(): Tok {
    while (this.peek().kind === "nl") this.pos++;
    return this.peek();
  }

  private isOp(v: string, at = 0): boolean {
    const t = this.tk[this.pos + at];
    return !!t && t.kind === "op" && t.value === v;
  }

  private isIdent(v: string): boolean {
    const t = this.peek();
    return t.kind === "ident" && t.value === v;
  }

  private eatOp(v: string): boolean {
    if (this.isOp(v)) {
      this.pos++;
      return true;
    }
    return false;
  }

  private expectOp(v: string): Tok {
    if (!this.isOp(v)) {
      const t = this.peek();
      throw new PineError(`第 ${t.line} 行：需要 "${v}"，实际是 "${t.value || "文件结尾"}"`);
    }
    return this.next();
  }

  /** Consume the rest of a logical line (Pine needs no semicolon). */
  private endOfStmt(): void {
    const t = this.peek();
    if (t.kind === "eof" || t.kind === "nl") return;
    throw new PineError(`第 ${t.line} 行：该行末尾有多余内容 "${t.value}"`);
  }

  parseProgram(): Stmt[] {
    const body = this.parseStatements(0);
    if (body.length === 0) throw new PineError("脚本是空的");
    return body;
  }

  /**
   * Collect statements whose indent equals `want` (a block body). Nested
   * deeper indents only occur right after `if`/`for`, which parse their own
   * body, so anything else is a hard error rather than a silent mis-parse.
   */
  private parseStatements(want: number): Stmt[] {
    const body: Stmt[] = [];
    for (;;) {
      const t = this.skipNl();
      if (t.kind === "eof") break;
      if (t.col < want) break;
      if (t.col > want) {
        throw new PineError(
          `第 ${t.line} 行：缩进不一致（这里应为 ${want} 列，实际 ${t.col} 列）`,
        );
      }
      const stmt = this.parseStatement();
      if (stmt) body.push(stmt);
    }
    return body;
  }

  /** Indent of the next meaningful token (also its own line start). */
  private indentHere(): number {
    return this.skipNl().col;
  }

  /**
   * `f(a, b) =>` — the arrow only ever follows a parameter list, so a lookahead
   * for `ident ( … ) =>` is enough to tell a function definition apart from a
   * call or a declaration.
   */
  private looksLikeFnDef(): boolean {
    const tk = this.tk;
    let p = this.pos;
    const head = tk[p];
    if (head?.kind === "ident" && FN_KEYWORDS.has(head.value)) p += 1;
    if (tk[p]?.kind !== "ident") return false;
    p += 1;
    if (tk[p]?.kind !== "op" || tk[p].value !== "(") return false;
    p += 1;
    let depth = 1;
    while (p < tk.length && depth > 0) {
      const t = tk[p];
      if (t.kind === "eof") return false;
      // Newlines cannot appear inside the parameter list (the lexer suppresses
      // them while brackets are open), so a stray `nl` means a malformed head.
      if (t.kind === "nl") return false;
      if (t.kind === "op" && (t.value === "(" || t.value === "[" || t.value === "{")) depth += 1;
      else if (t.kind === "op" && (t.value === ")" || t.value === "]" || t.value === "}")) depth -= 1;
      p += 1;
    }
    return depth === 0 && tk[p]?.kind === "op" && tk[p].value === "=>";
  }

  /** `[a, b] =` — the `=` after the closing bracket decides decl vs literal. */
  private looksLikeTupleDecl(): boolean {
    const tk = this.tk;
    let p = this.pos + 1;
    let depth = 1;
    while (p < tk.length && depth > 0) {
      const t = tk[p];
      if (t.kind === "eof" || t.kind === "nl") return false;
      if (t.kind === "op" && (t.value === "(" || t.value === "[" || t.value === "{")) depth += 1;
      else if (t.kind === "op" && (t.value === ")" || t.value === "]" || t.value === "}")) depth -= 1;
      p += 1;
    }
    return depth === 0 && tk[p]?.kind === "op" && tk[p].value === "=";
  }

  private parseFn(indent: number): Stmt {
    const head = this.peek();
    if (head.kind === "ident" && FN_KEYWORDS.has(head.value)) this.next();
    const nameTok = this.peek();
    if (nameTok.kind !== "ident") {
      throw new PineError(`第 ${nameTok.line} 行：函数名只能是标识符`);
    }
    this.next();
    this.expectOp("(");
    const params: { name: string; def: Expr | null }[] = [];
    if (!this.isOp(")")) {
      do {
        this.skipNl();
        this.dropTypeWords();
        const pt = this.peek();
        if (pt.kind !== "ident") {
          throw new PineError(`第 ${pt.line} 行：函数参数只能是名字（可带默认值，如 f(len = 14)）`);
        }
        this.next();
        const def = this.eatOp("=") ? this.parseExpr() : null;
        params.push({ name: pt.value, def });
      } while (this.eatOp(","));
    }
    this.expectOp(")");
    this.expectOp("=>");
    const rest = this.peek();
    if (rest.kind === "nl" || rest.kind === "eof") {
      // Block form: the value of the last statement is the return value.
      return { k: "fn", name: nameTok.value, params, body: this.parseChildBlock(indent), line: nameTok.line };
    }
    const body = this.parseExpr();
    this.endOfStmt();
    return { k: "fn", name: nameTok.value, params, body, line: nameTok.line };
  }

  /** Body of if/for: strictly deeper than the header statement. */
  private parseChildBlock(parentIndent: number): Stmt[] {
    const first = this.skipNl();
    if (first.kind === "eof") throw new PineError("缺少 if/for 语句体（需要缩进的下一行）");
    if (first.col <= parentIndent) {
      throw new PineError(`第 ${first.line} 行：if/for 语句体必须比 "${first.col}" 更缩进（应大于 ${parentIndent} 列）`);
    }
    return this.parseStatements(first.col);
  }

  private parseStatement(): Stmt | null {
    const head = this.peek();
    const indent = this.indentHere();
    const t = this.peek();

    if (t.kind === "ident" && (t.value === "while" || t.value === "switch" || t.value === "type" || t.value === "export" || t.value === "import")) {
      throw new PineError(`第 ${t.line} 行：暂不支持 "${t.value}" 语法，请改写为 if/三元表达式`);
    }
    if (this.looksLikeFnDef()) return this.parseFn(indent);
    if (t.kind === "ident" && t.value === "if") return this.parseIf(indent);
    if (t.kind === "ident" && t.value === "else") {
      throw new PineError(`第 ${head.line} 行："else" 必须紧跟在 "if" 块之后`);
    }
    if (t.kind === "ident" && t.value === "for") return this.parseFor(indent);

    // `var` / type annotations are optional prefixes of a declaration.
    let persist = false;
    if (t.kind === "ident" && t.value === "var") {
      this.next();
      persist = true;
      this.dropTypeWords();
    } else {
      this.dropTypeWords();
    }

    const cur = this.peek();
    // Tuple declaration: `[a, b] = expr`. A bare `[a, b]` is an array literal
    // instead — that is how a function body returns two values in Pine v6.
    if (cur.kind === "op" && cur.value === "[" && this.looksLikeTupleDecl()) {
      const line = cur.line;
      this.next();
      const names: string[] = [];
      do {
        const n = this.peek();
        if (n.kind !== "ident") throw new PineError(`第 ${n.line} 行：解构赋值只支持变量名`);
        // A trailing `_` placeholder (`[_, b] = ...`) is still a real binding.
        this.next();
        names.push(n.value);
      } while (this.eatOp(","));
      this.expectOp("]");
      this.expectOp("=");
      const value = this.parseExpr();
      this.endOfStmt();
      return { k: "decl", names, value, persist, line };
    }

    if (cur.kind === "ident") {
      const after = this.tk[this.pos + 1];
      if (after?.kind === "op" && after.value === "=") {
        const name = this.next().value;
        this.next(); // "="
        const value = this.parseExpr();
        this.endOfStmt();
        return { k: "decl", names: [name], value, persist, line: cur.line };
      }
      if (after?.kind === "op" && after.value === ":=") {
        const name = this.next().value;
        this.next(); // ":="
        const value = this.parseExpr();
        this.endOfStmt();
        return { k: "assign", name, value, line: cur.line };
      }
    }

    const expr = this.parseExpr();
    this.endOfStmt();
    // `name(...)` on its own line is a statement (plot/strategy/fill/...).
    return { k: "expr", value: expr, line: expr.line };
  }

  private dropTypeWords(): void {
    // `float x =`, `const float x =`, `series int i =` …
    for (;;) {
      const t = this.peek();
      const n = this.tk[this.pos + 1];
      if (t.kind === "ident" && TYPE_WORDS.has(t.value) && n?.kind === "ident") {
        this.next();
        continue;
      }
      break;
    }
  }

  private parseIf(indent: number): Stmt {
    const line = this.next().line; // "if"
    const arms: { cond: Expr; body: Stmt[] }[] = [];
    // No `eatOp("(")` here: `if (cond)` is just a parenthesised expression, and
    // swallowing the bracket without its partner used to derail the block parse.
    arms.push({ cond: this.parseExpr(), body: this.parseChildBlock(indent) });
    for (;;) {
      const t = this.skipNl();
      if (t.kind === "eof" || t.col < indent) break;
      if (t.kind !== "ident" || t.value !== "else") break;
      if (t.col !== indent) {
        throw new PineError(`第 ${t.line} 行："else" 必须与对应的 "if" 同级缩进`);
      }
      this.next();
      const nt = this.peek();
      if (nt.kind === "ident" && nt.value === "if") {
        this.next();
        arms.push({ cond: this.parseExpr(), body: this.parseChildBlock(indent) });
        continue;
      }
      const body = this.parseChildBlock(indent);
      return { k: "if", arms, elseBody: body, line };
    }
    return { k: "if", arms, elseBody: null, line };
  }

  private parseFor(indent: number): Stmt {
    const line = this.next().line; // "for"
    const v = this.peek();
    if (v.kind !== "ident") throw new PineError(`第 ${line} 行：for 需要循环变量名`);
    this.next();
    let from: Expr;
    let to: Expr;
    let step: Expr | null = null;
    if (this.eatOp("=")) {
      from = this.parseExpr();
    } else {
      // `for i = 1 to 10` is the normal form; `for _ = 0 to n` also appears.
      from = { k: "num", v: 0, line: v.line };
    }
    if (!this.isIdent("to")) throw new PineError(`第 ${v.line} 行：for 循环需要 "to"（形如 for i = 0 to 10）`);
    this.next();
    to = this.parseExpr();
    if (this.isIdent("by")) {
      this.next();
      step = this.parseExpr();
    }
    const body = this.parseChildBlock(indent);
    return { k: "for", varName: v.value, from, to, step, body, line };
  }

  /* ------------------------------------------------------------ expressions */

  private parseExpr(): Expr {
    return this.parseTernary();
  }

  private parseTernary(): Expr {
    const c = this.parseOr();
    if (!this.eatOp("?")) return c;
    const a = this.parseTernary();
    this.expectOp(":");
    const b = this.parseTernary();
    return { k: "tern", c, a, b, line: c.line };
  }

  private parseOr(): Expr {
    let a = this.parseAnd();
    for (;;) {
      const t = this.peek();
      if ((t.kind === "op" && (t.value === "||" || t.value === "or")) || (t.kind === "ident" && t.value === "or")) {
        this.next();
        a = { k: "bin", op: "or", a, b: this.parseAnd(), line: t.line };
        continue;
      }
      break;
    }
    return a;
  }

  private parseAnd(): Expr {
    let a = this.parseComparison();
    for (;;) {
      const t = this.peek();
      if ((t.kind === "op" && t.value === "&&") || (t.kind === "ident" && t.value === "and")) {
        this.next();
        a = { k: "bin", op: "and", a, b: this.parseComparison(), line: t.line };
        continue;
      }
      break;
    }
    return a;
  }

  private parseComparison(): Expr {
    const a = this.parseAdditive();
    const t = this.peek();
    if (t.kind === "op") {
      const raw = t.value;
      const op = raw === "<>" ? "!=" : raw;
      if ([">", "<", ">=", "<=", "==", "!="].includes(op)) {
        this.next();
        return { k: "bin", op, a, b: this.parseAdditive(), line: t.line };
      }
    }
    return a;
  }

  private parseAdditive(): Expr {
    let a = this.parseMultiplicative();
    for (;;) {
      const t = this.peek();
      if (t.kind === "op" && (t.value === "+" || t.value === "-")) {
        this.next();
        a = { k: "bin", op: t.value, a, b: this.parseMultiplicative(), line: t.line };
        continue;
      }
      break;
    }
    return a;
  }

  private parseMultiplicative(): Expr {
    let a = this.parsePower();
    for (;;) {
      const t = this.peek();
      if (t.kind === "op" && (t.value === "*" || t.value === "/" || t.value === "%")) {
        this.next();
        a = { k: "bin", op: t.value, a, b: this.parsePower(), line: t.line };
        continue;
      }
      break;
    }
    return a;
  }

  /** `^` binds tighter than `*` and is right-associative, as in Pine. */
  private parsePower(): Expr {
    const a = this.parseUnary();
    if (this.isOp("^")) {
      this.next();
      return { k: "bin", op: "^", a, b: this.parsePower(), line: a.line };
    }
    return a;
  }

  private parseUnary(): Expr {
    const t = this.peek();
    if (t.kind === "op" && (t.value === "-" || t.value === "+" || t.value === "!")) {
      this.next();
      return { k: "un", op: t.value === "!" ? "not" : t.value, a: this.parseUnary(), line: t.line };
    }
    if (t.kind === "ident" && t.value === "not") {
      this.next();
      return { k: "un", op: "not", a: this.parseUnary(), line: t.line };
    }
    return this.parsePostfix();
  }

  private parsePostfix(): Expr {
    let base = this.parsePrimary();
    for (;;) {
      const t = this.peek();
      if (t.kind === "op" && t.value === "[") {
        this.next();
        const off = this.parseExpr();
        this.expectOp("]");
        base = { k: "idx", base, off, line: t.line };
        continue;
      }
      break;
    }
    return base;
  }

  private parsePrimary(): Expr {
    const t = this.peek();
    if (t.kind === "num") {
      this.next();
      const v = Number(t.value);
      if (!Number.isFinite(v)) throw new PineError(`第 ${t.line} 行：数字 "${t.value}" 不合法`);
      return { k: "num", v, line: t.line };
    }
    if (t.kind === "str") {
      this.next();
      return { k: "str", v: t.value, line: t.line };
    }
    if (t.kind === "op" && t.value === "(") {
      this.next();
      const inner = this.parseExpr();
      this.expectOp(")");
      return inner;
    }
    if (t.kind === "op" && t.value === "[") {
      // Array literal, only really used by `input.string(options=[…])` and
      // `input.int(options=[…])`; the runtime hands it back as a tuple.
      this.next();
      const items: Expr[] = [];
      if (!this.isOp("]")) {
        do {
          this.skipNl();
          items.push(this.parseExpr());
        } while (this.eatOp(","));
      }
      this.expectOp("]");
      return { k: "arr", items, line: t.line };
    }
    if (t.kind === "ident") {
      if (KEYWORDS.has(t.value)) {
        throw new PineError(`第 ${t.line} 行："${t.value}" 是关键字，不能这样使用`);
      }
      this.next();
      if (this.isOp("(")) {
        this.next();
        const args: Arg[] = [];
        if (!this.isOp(")")) {
          do {
            this.skipNl();
            const nt = this.peek();
            const nn = this.tk[this.pos + 1];
            if (nt.kind === "ident" && nn?.kind === "op" && nn.value === "=") {
              this.next();
              this.next();
              args.push({ name: nt.value, value: this.parseExpr() });
            } else {
              args.push({ value: this.parseExpr() });
            }
          } while (this.eatOp(","));
        }
        this.expectOp(")");
        return { k: "call", name: t.value, args, line: t.line, cid: this.cid++ };
      }
      return { k: "id", name: t.value, line: t.line };
    }
    throw new PineError(`第 ${t.line} 行：意外的内容 "${t.value || "文件结尾"}"`);
  }
}

/** Parse Pine source into statements; throws PineError with a line number. */
export function parsePine(src: string): Stmt[] {
  return new PineParser(tokenizePine(src)).parseProgram();
}

/**
 * Cheap dialect sniff: does this source look like TradingView Pine?
 * `//@version`, a header call, or any namespaced `ta.`/`input.` usage.
 */
export function looksLikePine(src: string): boolean {
  if (/\/\/\s*@version\s*=/.test(src)) return true;
  if (/^\s*(indicator|study|strategy)\s*\(/m.test(src)) return true;
  if (/\b(ta|math|input|plot|strategy|color|price_range|timeframe|request)\.[A-Za-z_]/.test(src)) return true;
  return false;
}
