/**
 * Static translation of a Pine script's `alertcondition()` / `alert()` calls into
 * the backend alert kernel's single-comparison grammar.
 *
 * Why a translator and not a series export: the backend recomputes its own
 * numbers on its own poll, so a translated rule keeps firing with the tab
 * closed. What it cannot do is express anything outside the closed roster of
 * eight operators over the named series — and the honest answer for everything
 * else is a refusal that names the sub-expression. Narrowing `>=` to `>`, or
 * `a or b` to `a`, would be a silently wrong alert, which is worse than none.
 *
 * Pure: re-parses the source with `parsePine` (the compiled artifact carries no
 * AST), touches no DOM, no network, no interpreter.
 */

import { parsePine, type Arg, type Expr, type Stmt } from "./pineLang";
import type { AlertCondition, AlertRuleDraft } from "./alertsApi";

/** `alerts_routes.py` — the backend has no weekly/monthly interval. */
export const BACKEND_INTERVALS = ["1m", "5m", "15m", "30m", "60m", "1D"] as const;

/** `models.py` CONDITION_OPS, verbatim. */
const OPS = ["nonEmpty", "truthy", "gt", "lt", "crossUp", "crossDown", "rising", "falling"] as const;
export type PineOp = (typeof OPS)[number];

/** Raw bar fields `resolve_series` reads straight off the bars. */
const BAR_SERIES = new Set(["close", "open", "high", "low", "volume"]);

/** Indicator calls the backend exposes, mapped to its `fn` spelling. Close only. */
const INDICATOR_CALLS: Record<string, string> = {
  sma: "sma",
  "ta.sma": "sma",
  ema: "ema",
  "ta.ema": "ema",
  rsi: "rsi",
  "ta.rsi": "rsi",
};

/** Tuple-returning calls whose members the backend fixes at default parameters. */
const TUPLE_MEMBERS: Record<string, string[]> = {
  "ta.macd": ["macd_line", "macd_signal", "macd_hist"],
  macd: ["macd_line", "macd_signal", "macd_hist"],
  "ta.bb": ["bb_upper", "bb_middle", "bb_lower"],
  bb: ["bb_upper", "bb_middle", "bb_lower"],
};

/** `x > x[1]` and `ta.change(x) > 0` both mean "this series rose". */
const CHANGE_CALLS = new Set(["change", "ta.change"]);

export interface PineAlertPlan {
  line: number;
  fn: "alertcondition" | "alert";
  title: string;
  message: string;
  status: "native" | "refused";
  /** Only when native: the backend condition, inside the 8-operator closed set. */
  condition?: AlertCondition;
  /** Only when native: a draft ready to send to the rules endpoint. */
  draft?: AlertRuleDraft;
  /** Only when refused: Chinese explanation + suggestion, shown verbatim. */
  reason?: string;
  /** Translation distortions (input defaults substituted, …) in either state. */
  notes: string[];
}

export interface TranslateOptions {
  symbol: string;
  /** Chart interval key, in `marketApi`'s `IntervalKey` vocabulary. */
  interval: string;
  adjust?: string;
  targets?: string[];
}

/** FNV-1a, 32-bit, hex. Identity only — never a security boundary. */
export function fnv1aHex(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/**
 * Deterministic, so re-creating the same alert updates instead of duplicating,
 * and symbol-participating, so one `alertcondition` on two symbols does not
 * overwrite itself. Grammar-safe for the backend's rule-id pattern.
 */
export function pineRuleId(symbol: string, line: number, cond: AlertCondition): string {
  const canon = `${cond.op}|${cond.lhs}|${cond.rhs ?? ""}|${cond.value ?? ""}`;
  return `pine-${fnv1aHex(`${symbol}|${line}|${canon}`)}-L${line}`
    .replace(/-/g, "_")
    .slice(0, 128);
}

/** An operand resolves to a roster series name or a numeric literal. */
type Operand = { series: string } | { constant: number };

/** Script-wide bindings: every site shares the top-level scope. */
interface Scope {
  /** `x = <expr>` — one-name declarations and assignments. */
  env: Map<string, Expr>;
  /** `[m, s, h] = ta.macd(close)` at default params: name → backend member. */
  tuple: Map<string, string>;
  /** Same destructuring at NON-default params: name → source spelling. */
  poisoned: Map<string, string>;
}

interface Ctx {
  scope: Scope;
  notes: string[];
}

/** A refusal carries its reason verbatim to the UI. */
class Refuse extends Error {}

/** Approximate re-print of an AST node, so refusals can name what they reject. */
function spelling(e: Expr): string {
  switch (e.k) {
    case "num":
      return String(e.v);
    case "str":
      return JSON.stringify(e.v);
    case "id":
      return e.name;
    case "arr":
      return `[${e.items.map(spelling).join(", ")}]`;
    case "idx":
      return `${spelling(e.base)}[${spelling(e.off)}]`;
    case "call":
      return `${e.name}(${e.args.map((a) => `${a.name ? `${a.name}=` : ""}${spelling(a.value)}`).join(", ")})`;
    case "methcall":
      return `${spelling(e.obj)}.${e.name}()`;
    case "meth":
      return `${spelling(e.obj)}.${e.name}`;
    case "bin":
      return `${spelling(e.a)} ${e.op} ${spelling(e.b)}`;
    case "un":
      return `${e.op}(${spelling(e.a)})`;
    case "tern":
      return `${spelling(e.c)} ? ${spelling(e.a)} : ${spelling(e.b)}`;
    case "switch":
      return "switch 表达式";
    case "ifexpr":
      return "if 表达式";
    default:
      return "表达式";
  }
}

/** Positional-then-named argument lookup, the same order the runtime uses. */
function argExpr(args: Arg[], index: number, ...names: string[]): Expr | undefined {
  for (const n of names) {
    const hit = args.find((a) => a.name === n);
    if (hit) return hit.value;
  }
  const pos = args.filter((a) => !a.name);
  return pos.length > index ? pos[index].value : undefined;
}

/** A string literal argument, or "" when it is dynamic. */
function litStr(args: Arg[], index: number, name: string): string {
  const e = argExpr(args, index, name);
  return e && e.k === "str" ? e.v : "";
}

/** Operand that must be a series (the backend's two-sided operators take no constant). */
function seriesOperand(e: Expr, ctx: Ctx, seen: ReadonlySet<string>): string {
  const o = operand(e, ctx, seen);
  if ("series" in o) return o.series;
  throw new Refuse(`${spelling(e)} 是常量，而后端这一侧要的是序列`);
}

/**
 * Resolve one expression to a backend series name or a constant. Cycle-safe
 * (`seen`), scope-honest (only top-level declarations are visible), and closed
 * under the roster: anything outside it refuses with the source spelling.
 */
function operand(e: Expr, ctx: Ctx, seen: ReadonlySet<string>): Operand {
  if (e.k === "num") return { constant: e.v };
  if (e.k === "id") {
    if (BAR_SERIES.has(e.name)) return { series: e.name };
    const member = ctx.scope.tuple.get(e.name);
    if (member) return { series: member };
    const bad = ctx.scope.poisoned.get(e.name);
    if (bad) {
      throw new Refuse(
        `变量 ${e.name} 来自 ${bad}，它带了非默认周期参数，而后端的 macd/bb 成员固定用出厂参数，两边数值不同`,
      );
    }
    const bound = ctx.scope.env.get(e.name);
    if (bound) {
      if (seen.has(e.name)) throw new Refuse(`变量 ${e.name} 自引用，静态翻译无法展开`);
      return operand(bound, ctx, new Set([...seen, e.name]));
    }
    throw new Refuse(`条件引用了无法静态解析的变量 ${e.name}（只认全局作用域的声明）`);
  }
  if (e.k === "call") {
    const fn = INDICATOR_CALLS[e.name];
    if (fn) {
      const src = argExpr(e.args, 0, "source");
      if (!src || src.k !== "id" || src.name !== "close") {
        throw new Refuse(
          `后端指标只在 close 上计算，${spelling(e)} 的源${src ? `是 ${spelling(src)}` : "缺失"}`,
        );
      }
      const len = argExpr(e.args, 1, "length");
      // An omitted length takes the Pine default, which is also what the
      // backend assumes when the series name carries no `:N`.
      if (!len) return { series: `${fn}:14` };
      if (len.k !== "num" || !Number.isInteger(len.v) || len.v < 1 || len.v > 500) {
        throw new Refuse(`${spelling(e)} 的周期必须是 1..500 的整数常量`);
      }
      return { series: `${fn}:${len.v}` };
    }
    if (e.name.startsWith("input")) {
      const def = argExpr(e.args, 0, "defval");
      if (!def || def.k !== "num") {
        throw new Refuse(`${spelling(e)} 的默认值不是数字常量，代不进规则`);
      }
      ctx.notes.push(
        `条件里的 ${spelling(e)} 代入了 input 默认值 ${def.v}；改脚本滑块不会改已建好的规则`,
      );
      return { constant: def.v };
    }
    throw new Refuse(`无法把 ${spelling(e)} 映射到后端序列名`);
  }
  if (e.k === "idx") {
    throw new Refuse(`${spelling(e)} 的历史引用只有「与上一根比较」这一种写法可译`);
  }
  throw new Refuse(`无法把 ${spelling(e)} 映射到后端序列名`);
}

/** `x > x[1]`: the right side must be the very same series read one bar back. */
function previousBarRhs(a: Expr, b: Expr, ctx: Ctx): string | null {
  if (b.k !== "idx") return null;
  if (b.off.k !== "num" || b.off.v !== 1) {
    throw new Refuse(`${spelling(b)} 的偏移必须是 1，其它偏移后端没有对应算子`);
  }
  if (spelling(a) !== spelling(b.base)) return null;
  return seriesOperand(b.base, ctx, new Set());
}

/** `ta.change(x) < 0`: the left side is a change call over one roster series. */
function changeLhs(a: Expr, ctx: Ctx): string | null {
  if (a.k !== "call" || !CHANGE_CALLS.has(a.name)) return null;
  const inner = argExpr(a.args, 0, "series", "source");
  if (!inner) throw new Refuse(`${spelling(a)} 缺少序列实参`);
  return seriesOperand(inner, ctx, new Set());
}

type CmpOp = ">" | "<";

function compare(op: CmpOp, a: Expr, b: Expr, e: Expr, ctx: Ctx): AlertCondition {
  const trend = op === ">" ? "rising" : "falling";
  const prev = previousBarRhs(a, b, ctx);
  if (prev) return { op: trend, lhs: prev, rhs: null, value: null };
  const chg = changeLhs(a, ctx);
  if (chg) {
    if (b.k !== "num" || b.v !== 0) {
      throw new Refuse(
        `${spelling(e)} 只能和 0 比；和别的数比是「变化量阈值」，后端没有这个算子`,
      );
    }
    return { op: trend, lhs: chg, rhs: null, value: null };
  }
  const lhs = operand(a, ctx, new Set());
  const rhs = operand(b, ctx, new Set());
  const strict = op === ">" ? "gt" : "lt";
  if ("series" in lhs && "constant" in rhs) {
    return { op: strict, lhs: lhs.series, rhs: null, value: rhs.constant };
  }
  if ("constant" in lhs && "series" in rhs) {
    // `1700 < close` says the same thing as `close > 1700`; flip, don't widen.
    return { op: strict === "gt" ? "lt" : "gt", lhs: rhs.series, rhs: null, value: lhs.constant };
  }
  if ("series" in lhs && "series" in rhs) {
    return { op: strict, lhs: lhs.series, rhs: rhs.series, value: null };
  }
  throw new Refuse(`${spelling(e)} 两侧都是常量，没有可监听的序列`);
}

/**
 * Follow `x = …` bindings down to the expression a condition actually is, so the
 * idiomatic `longSignal = ta.crossover(fast, slow)` + `alertcondition(longSignal)`
 * pair classifies the same as the call written inline. Stops at bar fields, at
 * names with no top-level binding, and on revisit (a reassigned `var` would
 * otherwise loop).
 */
function deref(e: Expr, ctx: Ctx): Expr {
  const seen = new Set<string>();
  let cur = e;
  while (cur.k === "id" && !seen.has(cur.name) && !BAR_SERIES.has(cur.name)) {
    const bound = ctx.scope.env.get(cur.name);
    if (!bound || ctx.scope.tuple.has(cur.name) || ctx.scope.poisoned.has(cur.name)) break;
    seen.add(cur.name);
    cur = bound;
  }
  return cur;
}

/** One comparison or one crossing — the whole backend grammar, no combinations. */
function toCondition(e: Expr, ctx: Ctx): AlertCondition {
  const cond = singleCondition(deref(e, ctx), ctx);
  if (!(OPS as readonly string[]).includes(cond.op)) {
    throw new Refuse(`内部错误：算子 ${cond.op} 不在后端封闭集里`);
  }
  return cond;
}

function singleCondition(e: Expr, ctx: Ctx): AlertCondition {
  if (e.k === "bin") {
    if (e.op === ">=" || e.op === "<=") {
      const narrower = e.op === ">=" ? ">" : "<";
      throw new Refuse(
        `${e.op} 在后端没有对应算子（CONDITION_OPS 只有 gt/lt），把它译成 ${narrower} 就是少一个等号`,
      );
    }
    if (e.op === "and" || e.op === "or") {
      throw new Refuse(`后端单条件语法没有布尔组合（这里是 ${e.op}）；拆成两条规则，在告警页分别建`);
    }
    if (e.op === "==" || e.op === "!=") {
      throw new Refuse(`${e.op} 没有对应算子；区间判断请两侧各建一条 gt/lt 规则`);
    }
    if (e.op === ">" || e.op === "<") return compare(e.op as CmpOp, e.a, e.b, e, ctx);
    throw new Refuse(`运算符 ${e.op} 没有对应的后端算子`);
  }
  if (e.k === "un") {
    throw new Refuse(`后端单条件语法没有 ${e.op} 取反；请把取反后的比较直接写成条件`);
  }
  if (e.k === "tern" || e.k === "switch" || e.k === "ifexpr") {
    throw new Refuse(`${spelling(e)} 是分支表达式，后端单条件语法没有分支`);
  }
  if (e.k === "call") {
    const crossing: PineOp | null | undefined =
      e.name === "ta.crossover" || e.name === "crossover"
        ? "crossUp"
        : e.name === "ta.crossunder" || e.name === "crossunder"
          ? "crossDown"
          : e.name === "ta.cross" || e.name === "cross"
            ? null
            : undefined;
    if (crossing === null) {
      throw new Refuse(`ta.cross 是双向穿越，单条条件表达不了；建议建成两条规则（crossUp ＋ crossDown）`);
    }
    if (crossing) {
      const a = argExpr(e.args, 0, "series1", "long", "fast");
      const b = argExpr(e.args, 1, "series2", "short", "slow");
      if (!a || !b) throw new Refuse(`${spelling(e)} 需要两个序列实参`);
      return {
        op: crossing,
        lhs: seriesOperand(a, ctx, new Set()),
        rhs: seriesOperand(b, ctx, new Set()),
        value: null,
      };
    }
    if (CHANGE_CALLS.has(e.name)) {
      throw new Refuse(
        `${spelling(e)} 单独作条件只是「变化量非零」；请写成 ${e.name}(…) > 0 或 < 0`,
      );
    }
  }
  const o = operand(e, ctx, new Set());
  if ("series" in o) return { op: "truthy", lhs: o.series, rhs: null, value: null };
  throw new Refuse(`条件 ${spelling(e)} 是个常量，永远同一个结果，不值得建规则`);
}

/** One alert call site, with the `if` guards that enclose it. */
interface Site {
  fn: "alertcondition" | "alert";
  args: Arg[];
  line: number;
  guards: { cond: Expr; singleton: boolean }[];
  /** Reached through a loop or a user-function body. */
  scoped: boolean;
  /** Reached through an `else` branch, whose condition we would have to negate. */
  inElse: boolean;
}

function alertSite(s: Stmt): Site | null {
  if (s.k !== "expr" || s.value.k !== "call") return null;
  const name = s.value.name;
  if (name !== "alertcondition" && name !== "alert") return null;
  return { fn: name, args: s.value.args, line: s.value.line, guards: [], scoped: false, inElse: false };
}

function collectAlerts(
  stmts: Stmt[],
  out: Site[],
  guards: { cond: Expr; singleton: boolean }[] = [],
  flags = { scoped: false, inElse: false },
): void {
  for (const s of stmts) {
    const site = alertSite(s);
    if (site) {
      out.push({ ...site, guards, ...flags });
      continue;
    }
    if (s.k === "if") {
      for (const arm of s.arms) {
        collectAlerts(arm.body, out, [...guards, { cond: arm.cond, singleton: arm.body.length === 1 }], flags);
      }
      if (s.elseBody) collectAlerts(s.elseBody, out, guards, { ...flags, inElse: true });
      continue;
    }
    if (s.k === "for" || s.k === "forin" || s.k === "while") {
      collectAlerts(s.body, out, guards, { ...flags, scoped: true });
      continue;
    }
    if (s.k === "fn" && Array.isArray(s.body)) {
      collectAlerts(s.body, out, guards, { ...flags, scoped: true });
    }
  }
}

/** Top-level `x = …` bindings, plus `[m, s, h] = ta.macd(close)` member maps. */
function buildScope(stmts: Stmt[]): Scope {
  const scope: Scope = { env: new Map(), tuple: new Map(), poisoned: new Map() };
  for (const s of stmts) {
    if (s.k === "assign") {
      scope.env.set(s.name, s.value);
      continue;
    }
    if (s.k !== "decl") continue;
    if (s.names.length === 1) {
      scope.env.set(s.names[0], s.value);
      continue;
    }
    // Multi-name decl: only a tuple call at default params is translatable.
    if (s.value.k !== "call") continue;
    const members = TUPLE_MEMBERS[s.value.name];
    if (!members) continue;
    const positional = s.value.args.filter((a) => !a.name).length;
    const extraNamed = s.value.args.filter((a) => a.name && a.name !== "source").length;
    s.names.forEach((name, i) => {
      const member = members[i];
      if (!member) return;
      if (positional > 1 || extraNamed > 0) scope.poisoned.set(name, spelling(s.value));
      else scope.tuple.set(name, member);
    });
  }
  return scope;
}

/** `validate_rule` wants count in 2..2000; cover the longest period plus warm-up. */
function pineCount(cond: AlertCondition): number {
  let max = 0;
  for (const name of [cond.lhs, cond.rhs ?? ""]) {
    const m = /:(\d+)$/.exec(name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return Math.min(2000, Math.max(320, max + 60));
}

/** The condition behind one site, plus the argument slot its text sits in. */
function siteCondition(site: Site): { cond: Expr; messageIdx: number } {
  if (site.fn === "alertcondition") {
    if (site.scoped) throw new Refuse(`第 ${site.line} 行的 alertcondition 在循环/函数体内，静态翻译不覆盖`);
    if (site.inElse) throw new Refuse(`第 ${site.line} 行的 alertcondition 在 else 分支里，else 的条件要取反才能表达`);
    if (site.guards.length) {
      throw new Refuse(
        `第 ${site.line} 行的 alertcondition 被 if 门住，等于两个条件做 and，后端单条件语法没有布尔组合`,
      );
    }
    const cond = argExpr(site.args, 0, "condition", "series");
    if (!cond) throw new Refuse(`第 ${site.line} 行的 alertcondition 缺少 condition 实参`);
    return { cond, messageIdx: 2 };
  }
  if (site.scoped) throw new Refuse(`第 ${site.line} 行的 alert() 在循环/函数体内，静态翻译不覆盖`);
  if (site.inElse) throw new Refuse(`第 ${site.line} 行的 alert() 在 else 分支里，else 的条件要取反才能表达`);
  if (site.guards.length > 1) {
    throw new Refuse(
      `第 ${site.line} 行的 alert() 被 ${site.guards.length} 层 if 门住，等于多层 and，后端单条件语法没有布尔组合`,
    );
  }
  const only = site.guards[0];
  if (only) {
    if (!only.singleton) {
      throw new Refuse(`第 ${site.line} 行的 alert() 所在 if 体内不止它一条语句，无法确定这条告警对应哪个分支`);
    }
    return { cond: only.cond, messageIdx: 0 };
  }
  const first = argExpr(site.args, 0, "message");
  // `alert(<bool expr>, "…", freq)` — the guard is the first argument, the text
  // the second. A literal message alone means the call fires on every bar.
  if (first && first.k !== "str" && first.k !== "num") return { cond: first, messageIdx: 1 };
  throw new Refuse(`第 ${site.line} 行的顶层 alert() 每根K线都触发，那不是规则，是刷屏`);
}

function planFor(site: Site, scope: Scope, opts: TranslateOptions): PineAlertPlan {
  const ctx: Ctx = { scope, notes: [] };
  const title = site.fn === "alertcondition" ? litStr(site.args, 1, "title") : "";
  const base = { line: site.line, fn: site.fn, title, notes: ctx.notes };
  const refuse = (reason: string, message: string): PineAlertPlan => ({
    ...base,
    message,
    status: "refused",
    reason,
  });
  // Refusals that happen before we can read the site's text fall back to the
  // alertcondition slot, which is the only layout that carries a message= arg.
  let messageIdx = site.fn === "alertcondition" ? 2 : 0;
  if (!BACKEND_INTERVALS.includes(opts.interval as (typeof BACKEND_INTERVALS)[number])) {
    return refuse(
      `后端轮询不支持 ${opts.interval} 周期（可用：${BACKEND_INTERVALS.join(" / ")}）；换到这些周期再建，或改用 TradingView 出站告警`,
      litStr(site.args, messageIdx, "message"),
    );
  }
  try {
    const { cond: condExpr, messageIdx: condMessageIdx } = siteCondition(site);
    messageIdx = condMessageIdx;
    const message = litStr(site.args, condMessageIdx, "message");
    const cond = toCondition(condExpr, ctx);
    const draft: AlertRuleDraft = {
      id: pineRuleId(opts.symbol, site.line, cond),
      kind: "market",
      title: title || `${site.fn}@L${site.line}`,
      symbol: opts.symbol,
      interval: opts.interval,
      count: pineCount(cond),
      adjust: opts.adjust ?? "qfq",
      condition: cond,
      for_bars: 1,
      severity: "info",
      send_resolved: true,
      session_only: false,
      targets: opts.targets ?? [],
      enabled: true,
    };
    return { ...base, message, status: "native", condition: cond, draft };
  } catch (err) {
    if (err instanceof Refuse) return refuse(err.message, litStr(site.args, messageIdx, "message"));
    throw err;
  }
}

export function translatePineAlerts(code: string, opts: TranslateOptions): PineAlertPlan[] {
  let stmts: Stmt[];
  try {
    stmts = parsePine(code);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [
      {
        line: 0,
        fn: "alertcondition",
        title: "",
        message: "",
        status: "refused",
        reason: `语法解析失败：${msg}`,
        notes: [],
      },
    ];
  }
  const sites: Site[] = [];
  collectAlerts(stmts, sites);
  const scope = buildScope(stmts);
  return sites.map((site) => planFor(site, scope, opts));
}
