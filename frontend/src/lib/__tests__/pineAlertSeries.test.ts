import { describe, it, expect } from "vitest";
import { compilePine } from "../pineScript";
import { isDecorativeName } from "../pineMath";
import type { KLineData } from "klinecharts";

/**
 * `alertcondition()` / `alert()` must produce a per-bar boolean series instead of
 * being warned away. The bridge (pineAlertRules) translates the Pine condition
 * into a backend rule, and the only way to prove that rule means the same thing
 * is to compare it against what the interpreter itself decided on EVERY bar — so
 * the interpreter has to record those decisions.
 *
 * Bars are fully deterministic (close = 100 + i, volume spikes on every third
 * bar) so each expected hit array is hand-computed from the condition, not
 * copied out of a run.
 */

const N = 24;
const bars: KLineData[] = Array.from({ length: N }, (_, i) => {
  const close = 100 + i;
  const open = close - 0.5;
  return {
    timestamp: 1700000000000 + i * 86_400_000,
    open,
    high: close + 1,
    low: open - 1,
    close,
    volume: i % 3 === 0 ? 500 : 100,
    turnover: 0,
  } as KLineData;
});

/** Compile and return `result.alerts`, throwing on any compile/run failure. */
function alertsOf(src: string) {
  const out = compilePine(src, bars, {});
  if ("error" in out) throw new Error(`编译失败：${out.error}`);
  if (out.abort) throw new Error(`运行中断：${out.abort}`);
  return out.result.alerts;
}

/** Run `src` and return its warnings joined, to prove nothing is swallowed. */
function warningsOf(src: string): string {
  const out = compilePine(src, bars, {});
  if ("error" in out) throw new Error(`编译失败：${out.error}`);
  return out.result.warnings.join(" | ");
}

const HEAD = '//@version=5\nindicator("AL")\n';

describe("alertcondition() per-bar boolean series", () => {
  it("records one entry with title/message and a hit per bar", () => {
    const a = alertsOf(`${HEAD}alertcondition(close > 105, "高价", "close above 105")\nplot(close)\n`);
    expect(a).toBeDefined();
    expect(a).toHaveLength(1);
    expect(a![0].fn).toBe("alertcondition");
    expect(a![0].title).toBe("高价");
    expect(a![0].message).toBe("close above 105");
    expect(a![0].line).toBe(3);
    // close = 100 + i, so `close > 105` first holds at i = 6.
    expect(a![0].hits).toHaveLength(N);
    expect(a![0].hits).toEqual(Array.from({ length: N }, (_, i) => i >= 6));
  });

  it("reads named arguments (condition= / title= / message=)", () => {
    const a = alertsOf(
      `${HEAD}alertcondition(condition = close > 105, title = "T", message = "M")\n`,
    );
    expect(a![0].title).toBe("T");
    expect(a![0].message).toBe("M");
    expect(a![0].hits.filter((h) => h).length).toBe(N - 6);
  });

  it("keeps separate entries for separate call sites, in declaration order", () => {
    const a = alertsOf(
      `${HEAD}alertcondition(volume > 200, "放量", "vol spike")\n` +
        `alertcondition(close > 105, "高价", "price high")\n`,
    );
    expect(a).toHaveLength(2);
    expect(a![0].title).toBe("放量");
    expect(a![1].title).toBe("高价");
    // volume = 500 on every third bar (i % 3 === 0).
    expect(a![0].hits).toEqual(Array.from({ length: N }, (_, i) => i % 3 === 0));
    expect(a![1].hits).toEqual(Array.from({ length: N }, (_, i) => i >= 6));
  });

  it("evaluates the condition on every bar, not just the last one", () => {
    // `n` is persisted, so exactly the bar where it first reaches 1 must hit.
    const a = alertsOf(
      `${HEAD}var int n = 0\nif close > 105\n    n += 1\nalertcondition(n == 1, "首破", "first")\n`,
    );
    const trueIdx = a![0].hits.map((h, i) => (h ? i : -1)).filter((i) => i >= 0);
    expect(trueIdx).toEqual([6]);
  });

  it("gates `na` to false instead of erroring during indicator warm-up", () => {
    // ta.rsi(close, 14) is na for the leading bars; every later bar of an
    // all-rising series resolves to 100, i.e. > 30.
    const a = alertsOf(`${HEAD}alertcondition(ta.rsi(close, 14) > 30, "RSI", "hot")\n`);
    const hits = a![0].hits;
    expect(hits.every((h) => typeof h === "boolean")).toBe(true);
    expect(hits[0]).toBe(false);
    expect(hits[N - 1]).toBe(true);
    // Once warm-up clears the series must not flicker back to false.
    const firstTrue = hits.findIndex((h) => h);
    expect(firstTrue).toBeGreaterThan(0);
    expect(hits.slice(firstTrue).every((h) => h)).toBe(true);
    expect(warningsOf(`${HEAD}alertcondition(ta.rsi(close, 14) > 30, "RSI", "hot")\n`)).toBe("");
  });

  it("treats a falsy or na condition as no hit rather than a crash", () => {
    expect(alertsOf(`${HEAD}alertcondition(0, "零", "never")\n`)![0].hits).toEqual(
      new Array(N).fill(false),
    );
    expect(alertsOf(`${HEAD}alertcondition(na, "空", "never")\n`)![0].hits).toEqual(
      new Array(N).fill(false),
    );
  });
});

describe("alert() per-bar boolean series", () => {
  it("fires on every bar that carries a non-empty message", () => {
    const a = alertsOf(
      `${HEAD}alert(close > 105 ? "高价" : "", alert.freq_once_per_bar_close)\nplot(close)\n`,
    );
    expect(a).toHaveLength(1);
    expect(a![0].fn).toBe("alert");
    expect(a![0].message).toBe("高价");
    expect(a![0].line).toBe(3);
    expect(a![0].hits).toEqual(Array.from({ length: N }, (_, i) => i >= 6));
  });

  it("records a constant-message alert as an all-true series", () => {
    const a = alertsOf(`${HEAD}alert("always", alert.freq_once_per_bar)\n`);
    expect(a![0].title).toBe("");
    expect(a![0].hits).toEqual(new Array(N).fill(true));
  });
});

describe("alerts field discipline", () => {
  it("is absent (not an empty array) for a script with no alert declaration", () => {
    expect(alertsOf(`${HEAD}plot(close)\n`)).toBeUndefined();
  });

  it("no longer warns that alerts do nothing on the frontend", () => {
    const src = `${HEAD}alertcondition(close > 105, "t", "m")\nalert("m", alert.freq_all)\n`;
    const w = warningsOf(src);
    expect(w).not.toContain("不起作用");
    expect(w).not.toContain("已忽略");
  });

  it("takes only the alert names off the decorative whitelist", () => {
    // `label.new` &co. never reached the decorative fallback anyway (the drawing
    // channel handles them), so assert on the predicate itself.
    expect(isDecorativeName("alert")).toBe(false);
    expect(isDecorativeName("alertcondition")).toBe(false);
    expect(isDecorativeName("label.new")).toBe(true);
    expect(isDecorativeName("chart.bg_color")).toBe(true);
    expect(isDecorativeName("syntax.functions")).toBe(true);
  });
});
