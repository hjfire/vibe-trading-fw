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
// A trailing dot is a valid integer literal in Pine (`result += 1.`); the
// optional fraction group lets `\d+\.` match while `.5` stays with the second
// alternative.
const NUM_RE = /^(\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)([eE][+-]?\d+)?/;
/** TradingView colour literals: `#rrggbb`, optionally with alpha `#rrggbbaa`. */
const HEX_COLOR_RE = /^#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6})(?![0-9a-fA-F])/;
/** Multi-char operators, longest first so `>=` never lexes as `>` + `=`. */
const OPS_MULTI = [":=", "==", "!=", "<>", ">=", "<=", "&&", "||", "=>", "+=", "-=", "*=", "/=", "%="];
const OPS_SINGLE = "+-*/%^<>=,()[]{}:?.!~";
/** `x op= y` is Pine shorthand for `x := x op y`. */
const COMPOUND_OPS = new Set(["+=", "-=", "*=", "/=", "%="]);
/** A trailing operator/comma means the statement continues on the next line. */
const CONTINUE_END = new Set([
  "=", ":=", "+", "-", "*", "/", "%", "^", "<", ">", "<=", ">=", "==", "!=", "<>",
  "and", "or", "not", "to", "by", "?", ":", ",", "(", "[",
]);
/**
 * A *leading* operator on the next line also continues the statement. Pine's
 * implicit-wrap rule is bidirectional (TV: put the operator at the end of the
 * line *or* the start of the next), and no valid Pine statement begins with one
 * of these, so an over-indented operator line can only be a continuation. The
 * assignment ops (`=`, `:=`, `=>`) are deliberately absent — those start a new
 * binding, never a wrapped operand.
 */
const CONTINUE_START = new Set([
  "+", "-", "*", "/", "%", "^", "?", ":", "<", ">", "<=", ">=", "==", "!=", "<>",
  "and", "or", "to", "by",
]);

export function tokenizePine(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  let line = 1;
  let col = 0;
  let depth = 0;
  const push = (kind: TokKind, value: string, atCol: number) =>
    out.push({ kind, value, line, col: atCol });

  /**
   * Pure lookahead (never mutates `i`/`line`): the operator/keyword that opens
   * the next non-blank, non-comment line, or "" at EOF. Used only to decide
   * whether a newline is a wrapped-continuation boundary.
   */
  const nextLineStartOperator = (from: number): string => {
    let j = from;
    for (;;) {
      while (j < src.length && (src[j] === " " || src[j] === "\t" || src[j] === "\r" || src[j] === "\n")) j++;
      if (j >= src.length) return "";
      if (src[j] === "/" && src[j + 1] === "/") { while (j < src.length && src[j] !== "\n") j++; continue; }
      if (src[j] === "/" && src[j + 1] === "*") { const e = src.indexOf("*/", j + 2); if (e < 0) return ""; j = e + 2; continue; }
      break;
    }
    const multi = OPS_MULTI.find((op) => src.startsWith(op, j));
    if (multi) return multi;
    const word = /^[A-Za-z_]\w*/.exec(src.slice(j));
    if (word) return word[0]; // ident/keyword: only and/or/not/to/by can be in CONTINUE_START
    return OPS_SINGLE.includes(src[j]) ? src[j] : "";
  };

  while (i < src.length) {
    const c = src[i];
    if (c === "\n") {
      // Inside brackets a newline is plain whitespace; a statement also wraps
      // when the previous line ends with an operator (`CONTINUE_END`) or the
      // next line begins with one (`CONTINUE_START`). Suppressing the newline
      // keeps the wrapped operands on one logical line so the precedence-tested
      // expression parser sees the identical token stream as the single-line
      // form -- that equivalence is what makes the merge numerically safe.
      const last = out[out.length - 1];
      const trailingContinues = !!last && (last.kind === "op" || last.kind === "ident") &&
        CONTINUE_END.has(last.value);
      const leadingContinues = CONTINUE_START.has(nextLineStartOperator(i + 1));
      if (depth === 0 && !trailingContinues && !leadingContinues) push("nl", "\n", 0);
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
  | { k: "tern"; c: Expr; a: Expr; b: Expr; line: number }
  | {
      k: "switch";
      /** `switch x` → subject present (clauses compare to it); bare `switch` → null (clauses are bool guards). */
      subject: Expr | null;
      cases: { test: Expr; body: Expr | Stmt[] }[];
      /** The `=> body` clause with no test (evaluated when nothing matched). */
      defaultBody: Expr | Stmt[] | null;
      line: number;
    }
  | {
      k: "ifexpr";
      /** `if cond` / `else if cond` arms; each body is an inline `then` expr or an indented block. */
      arms: { cond: Expr; body: Expr | Stmt[] }[];
      elseBody: Expr | Stmt[] | null;
      line: number;
    };

export type Stmt =
  | { k: "decl"; names: string[]; value: Expr; persist: boolean; line: number }
  | { k: "assign"; name: string; value: Expr; line: number }
  | { k: "expr"; value: Expr; line: number }
  | { k: "type"; name: string; fieldNames: string[]; line: number }
  | { k: "if"; arms: { cond: Expr; body: Stmt[] }[]; elseBody: Stmt[] | null; line: number }
  | { k: "for"; varName: string; from: Expr; to: Expr; step: Expr | null; body: Stmt[]; line: number }
  | { k: "forin"; varName: string; source: Expr; body: Stmt[]; line: number }
  | { k: "while"; cond: Expr; body: Stmt[]; line: number }
  | { k: "break"; line: number }
  | { k: "continue"; line: number }
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
  // Pine's drawing/table object types. `var table infoTb = table.new(...)` and
  // `line ln = line.new(...)` put these in type position; without them the
  // parser eats `table`/`line` as the variable name and reports the real name
  // (`infoTb`/`ln`) as trailing junk. dropTypeWords only consumes a word when
  // the *next* token is an identifier, so `table.new(...)` (followed by `.`) and
  // a bare `table` reference are never mistaken for a type annotation.
  "table", "line", "label", "box", "polyline", "matrix", "array", "map",
]);

/** Statement keywords that are never variable names. */
const KEYWORDS = new Set(["if", "else", "for", "to", "by", "while", "switch", "var", "type"]);

/**
 * Contextual (soft) keywords. `type` is a real keyword only at the head of a
 * `type Name` declaration (handled in parseStatement); everywhere else Pine
 * lets it be an ordinary identifier — e.g. a parameter named `type`. Everything
 * else in KEYWORDS is reserved outright.
 */
const SOFT_KEYWORDS = new Set(["type"]);

/** Prefixes that only introduce a user-defined function. */
const FN_KEYWORDS = new Set(["def", "function"]);

export class PineParser {
  private pos = 0;
  private cid = 0;
  /**
   * Indent of the statement currently being parsed (set in parseStatement). An
   * if-expression on an assignment RHS (`x = if …`) uses it as the reference
   * column: its bodies must indent past it and its `else` clauses realign to it.
   */
  private stmtIndent = 0;

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
      if (Array.isArray(stmt)) body.push(...stmt);
      else if (stmt) body.push(stmt);
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
        // A parameter is `[Type] name [= default]`. dropTypeWords handles the
        // built-in / generic type prefixes; a USER type (`FeatureSeries fs`),
        // which the parser cannot know in advance, shows up as an identifier
        // followed by another identifier — drop it as an annotation too.
        while (this.peek().kind === "ident" && this.tk[this.pos + 1]?.kind === "ident") this.next();
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

  private parseStatement(): Stmt | Stmt[] | null {
    const head = this.peek();
    const indent = this.indentHere();
    this.stmtIndent = indent;
    const t = this.peek();

    // A UDT declaration `type Name` + indented field lines. `type` followed by
    // an identifier is a record type; anything else stays rejected.
    if (t.kind === "ident" && t.value === "type" && this.tk[this.pos + 1]?.kind === "ident") {
      return this.parseType(indent);
    }
    if (t.kind === "ident" && t.value === "export") {
      throw new PineError(`第 ${t.line} 行：暂不支持 "export" 语法，请改写为 if/三元表达式`);
    }
    // `import TradingView/ta/9` is a v5/v6 module import. The ta.* library is
    // already global here, so the import line is a no-op: consume and skip it.
    if (t.kind === "ident" && t.value === "import") {
      for (;;) {
        const s = this.peek();
        if (s.kind === "nl" || s.kind === "eof") break;
        this.next();
      }
      return null;
    }
    if (this.looksLikeFnDef()) return this.parseFn(indent);
    if (t.kind === "ident" && t.value === "if") return this.parseIf(indent);
    if (t.kind === "ident" && t.value === "else") {
      throw new PineError(`第 ${head.line} 行："else" 必须紧跟在 "if" 块之后`);
    }
    if (t.kind === "ident" && t.value === "for") return this.parseFor(indent);
    if (t.kind === "ident" && t.value === "while") return this.parseWhile(indent);
    // A bare `switch` statement (a function block body whose value is the
    // switch result). The RHS form `x = switch …` is handled inside parseExpr.
    if (t.kind === "ident" && t.value === "switch") {
      return { k: "expr", value: this.parseSwitch(), line: t.line };
    }
    // Loop-control statements. They carry no expression; the runtime signals a
    // break/continue by throwing a control-flow marker that execFor catches.
    if (t.kind === "ident" && (t.value === "break" || t.value === "continue")) {
      const line = t.line;
      const isBreak = t.value === "break";
      this.next();
      this.endOfStmt();
      return isBreak ? { k: "break", line } : { k: "continue", line };
    }

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
        // `a = 1` and the comma-parallel form `var a = 0, var b = 0.0, ...`.
        const decls: Stmt[] = [];
        for (;;) {
          const nm = this.peek();
          if (nm.kind !== "ident") break;
          this.next(); // name
          this.expectOp("=");
          const value = this.parseExpr();
          decls.push({ k: "decl", names: [nm.value], value, persist, line: nm.line });
          if (this.isOp(",")) {
            this.next(); // ","
            this.skipNl();
            if (this.isIdent("var")) { this.next(); persist = true; }
            this.dropTypeWords();
            continue;
          }
          break;
        }
        this.endOfStmt();
        return decls.length === 1 ? decls[0] : decls;
      }
      if (after?.kind === "op" && COMPOUND_OPS.has(after.value)) {
        // `cnt += 1` desugars to `cnt := cnt + 1` (reassignment semantics).
        const name = this.next().value;
        const opTok = this.next(); // "+=" etc
        const core = opTok.value.slice(0, -1); // "+=" -> "+"
        const rhs = this.parseExpr();
        this.endOfStmt();
        const value: Expr = { k: "bin", op: core, a: { k: "id", name, line: cur.line }, b: rhs, line: cur.line };
        return { k: "assign", name, value, line: cur.line };
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
    // `float x =`, `const float x =`, `series int i =` … and the array-typed
    // form `float[] buffer =` / `int[] idx =` (Pine's typed-array declaration),
    // plus the generic form `array<float> buf` / `map<int, MyUDT> m`.
    for (;;) {
      const t = this.peek();
      if (!(t.kind === "ident" && TYPE_WORDS.has(t.value))) break;
      let p = this.pos + 1;
      let kind: "none" | "array" | "generic" = "none";
      if (
        this.tk[p]?.kind === "op" && this.tk[p].value === "[" &&
        this.tk[p + 1]?.kind === "op" && this.tk[p + 1].value === "]"
      ) {
        p += 2;
        kind = "array";
      } else {
        const g = this.genericEnd(p);
        if (g !== null) { p = g; kind = "generic"; }
      }
      const nxt = this.tk[p];
      if (nxt && nxt.kind === "ident") {
        this.next(); // type word
        if (kind === "array") { this.next(); this.next(); } // [ ]
        else if (kind === "generic") { this.pos = p; } // jump past <...>
        continue;
      }
      break;
    }
  }

  /**
   * If tokens starting at `from` (which must be a `<`) form a generic type
   * argument list (`<int>`, `<string, float>`, `<map<int, float>>`), return the
   * index just past the closing `>`; otherwise null. Only type tokens (`ident`,
   * `,`, `.`, `[`, `]`, nested `< >`) are allowed, and `and`/`or`/`not`/keywords
   * are rejected — that keeps a comparison (`a < b and ...`) out of the fast
   * path, so `<` followed by non-type content is left for the relational parser.
   */
  private genericEnd(from: number): number | null {
    if (this.tk[from]?.kind !== "op" || this.tk[from].value !== "<") return null;
    let depth = 0;
    for (let p = from; p < this.tk.length; p++) {
      const t = this.tk[p];
      if (t.kind === "op" && t.value === "<") { depth++; continue; }
      if (t.kind === "op" && t.value === ">") { depth--; if (depth === 0) return p + 1; continue; }
      if (t.kind === "nl" || t.kind === "eof") return null;
      if (t.kind === "ident") {
        if (KEYWORDS.has(t.value) || t.value === "and" || t.value === "or" || t.value === "not") return null;
        continue;
      }
      if (t.kind === "op" && (t.value === "," || t.value === "." || t.value === "[" || t.value === "]")) continue;
      return null;
    }
    return null;
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

  /* --------------------------------------------------------------- switch */

  /**
   * `switch [subject]` followed by indented `case => body` clauses (and an
   * optional `=> default` clause). The subject is optional: a bare `switch`
   * makes each clause a boolean guard. A clause body is either an inline
   * expression on the arrow line or an indented block (whose value is its last
   * statement). Clauses are collected while their first token stays at the
   * column of the first clause; the switch ends on any dedent — matching how
   * TradingView writes switch both as a statement and as an assignment RHS.
   */
  private parseSwitch(): Expr {
    const line = this.next().line; // consume "switch"
    let subject: Expr | null = null;
    const h = this.peek();
    if (!(h.kind === "nl" || h.kind === "eof")) subject = this.parseExpr();
    const cases: { test: Expr; body: Expr | Stmt[] }[] = [];
    let defaultBody: Expr | Stmt[] | null = null;
    let caseIndent = -1;
    for (;;) {
      const ahead = this.peekMeaningful(this.pos); // pure lookahead, no advance
      if (ahead.tok.kind === "eof") break;
      if (caseIndent < 0) caseIndent = ahead.tok.col;
      else if (ahead.tok.col !== caseIndent) break;
      this.pos = ahead.at; // jump onto the clause token (past newlines)
      if (this.isOp("=>")) {
        this.next();
        defaultBody = this.parseSwitchBody(caseIndent);
        continue;
      }
      const test = this.parseExpr();
      this.expectOp("=>");
      cases.push({ test, body: this.parseSwitchBody(caseIndent) });
    }
    // A block body leaves `this.pos` on the dedented next statement (its
    // newlines already consumed). Rewind onto that newline so an enclosing
    // `x = switch …` declaration still sees a line break in endOfStmt().
    const cur = this.peek();
    if (cur.kind !== "nl" && cur.kind !== "eof" && this.tk[this.pos - 1]?.kind === "nl") this.pos--;
    return { k: "switch", subject, cases, defaultBody, line };
  }

  /** Clause body: an inline expression, or an indented block of statements. */
  private parseSwitchBody(caseIndent: number): Expr | Stmt[] {
    const t = this.peek();
    if (!(t.kind === "nl" || t.kind === "eof")) return this.parseExpr();
    const first = this.skipNl();
    if (first.kind === "eof" || first.col <= caseIndent) {
      // Empty clause body: back off so the token stays for the next clause /
      // dedent handling, and yield `na`.
      this.pos--;
      return { k: "num", v: NaN, line: first.line };
    }
    return this.parseStatements(first.col);
  }

  /** Next non-newline token at/after `from`, WITHOUT moving this.pos. */
  private peekMeaningful(from: number): { tok: Tok; at: number } {
    let p = from;
    while (this.tk[p]?.kind === "nl") p++;
    return { tok: this.tk[p], at: p };
  }

  /* ---------------------------------------------------------- if-expression */

  /**
   * `if cond` used as a VALUE (an assignment RHS or a return expression), which
   * Pine allows alongside the statement form. Each arm's body is an indented
   * block (value = its last statement) or, defensively, an inline expression;
   * `else if` / a trailing `else` arms realign to the enclosing statement's
   * indent (this.stmtIndent). Mirrors parseSwitch's pure-lookahead + rewind so
   * an enclosing `x = if …` declaration still sees its line break.
   */
  private parseIfExpr(): Expr {
    const line = this.next().line; // consume "if"
    const base = this.stmtIndent; // column the bodies outdent from / `else` aligns to
    const arms: { cond: Expr; body: Expr | Stmt[] }[] = [];
    let elseBody: Expr | Stmt[] | null = null;
    for (;;) {
      const cond = this.parseExpr();
      arms.push({ cond, body: this.parseIfExprBody(base) });
      const ahead = this.peekMeaningful(this.pos);
      if (ahead.tok.kind === "ident" && ahead.tok.value === "else" && ahead.tok.col >= base) {
        this.pos = ahead.at; // jump onto the `else` (past newlines)
        this.next(); // consume "else"
        const nt = this.peek();
        if (nt.kind === "ident" && nt.value === "if") {
          this.next(); // consume "if"; the loop parses its cond + body
          continue;
        }
        elseBody = this.parseIfExprBody(base);
        break;
      }
      break;
    }
    // A block body leaves `this.pos` on the dedented next statement (newlines
    // already consumed). Rewind onto that newline so an enclosing `x = if …`
    // declaration still sees a line break in endOfStmt().
    const cur = this.peek();
    if (cur.kind !== "nl" && cur.kind !== "eof" && this.tk[this.pos - 1]?.kind === "nl") this.pos--;
    return { k: "ifexpr", arms, elseBody, line };
  }

  /** If-expression arm body: an indented block of statements, or an inline value. */
  private parseIfExprBody(base: number): Expr | Stmt[] {
    const t = this.peek();
    if (!(t.kind === "nl" || t.kind === "eof")) return this.parseExpr();
    const first = this.skipNl();
    if (first.kind === "eof" || first.col <= base) {
      this.pos--; // empty body: leave the dedented token for the caller
      return { k: "num", v: NaN, line: first.line };
    }
    return this.parseStatements(first.col);
  }

  /**
   * `type Name` + an indented block of `<Type> field` lines. Field value TYPES
   * are compile-time annotations; the runtime record is positional (fields in
   * declaration order), so we only need the field NAMES and their order.
   */
  private parseType(indent: number): Stmt {
    const line = this.next().line; // "type"
    const nameTok = this.next(); // Type name
    if (nameTok.kind !== "ident") {
      throw new PineError(`第 ${line} 行："type" 后应接类型名`);
    }
    this.endOfStmt();
    const fieldNames: string[] = [];
    for (;;) {
      const first = this.skipNl();
      if (first.kind === "eof" || first.col <= indent) break;
      // Consume the whole field line; the LAST identifier is the field name
      // (`array<float> f1` → f1, `float f2` → f2). Generics never reach here.
      let lastIdent = "";
      for (;;) {
        const tk = this.peek();
        if (tk.kind === "nl" || tk.kind === "eof") break;
        if (tk.kind === "ident") lastIdent = tk.value;
        this.next();
      }
      if (lastIdent) fieldNames.push(lastIdent);
    }
    return { k: "type", name: nameTok.value, fieldNames, line };
  }

  /** `while cond` + an indented block — mirrors parseFor's body handling. */
  private parseWhile(indent: number): Stmt {
    const line = this.next().line; // "while"
    const cond = this.parseExpr();
    const body = this.parseChildBlock(indent);
    return { k: "while", cond, body, line };
  }

  private parseFor(indent: number): Stmt {
    const line = this.next().line; // "for"
    const v = this.peek();
    if (v.kind !== "ident") throw new PineError(`第 ${line} 行：for 需要循环变量名`);
    this.next();
    // `for x in arr` (Pine v6 array iteration) — distinct from the numeric
    // `for i = from to [by]` form handled below.
    if (this.isIdent("in")) {
      this.next(); // "in"
      const source = this.parseExpr();
      const body = this.parseChildBlock(indent);
      return { k: "forin", varName: v.value, source, body, line };
    }
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
    if (t.kind === "ident" && t.value === "switch") return this.parseSwitch();
    if (t.kind === "ident" && t.value === "if") return this.parseIfExpr();
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
      if (KEYWORDS.has(t.value) && !SOFT_KEYWORDS.has(t.value)) {
        throw new PineError(`第 ${t.line} 行："${t.value}" 是关键字，不能这样使用`);
      }
      this.next();
      // Generic type arguments on a builtin call (`array.new<float>(0)`,
      // `map.new<string, float>()`) are compile-time only; skip the `<...>` so
      // the call parses to its plain name (array/map support is a runtime
      // concern for later phases). Only skipped when the list is immediately
      // followed by `(`, so a comparison `a < b` is never mistaken for one.
      if (this.isOp("<")) {
        const g = this.genericEnd(this.pos);
        if (g !== null && this.tk[g]?.kind === "op" && this.tk[g].value === "(") this.pos = g;
      }
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
