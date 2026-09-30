import { describe, it, expect } from "vitest";
import { compilePine } from "../pineScript";
import type { KLineData } from "klinecharts";

/**
 * Numeric proof for bidirectional line-continuation in the lexer.
 *
 * The change suppresses a newline when the NEXT line opens with an operator
 * (`? : + - * / % ^ < > == != <> and or to by`) so a wrapped expression joins
 * the already precedence-tested binary/ternary parser. The correctness contract
 * is therefore exact: a folded expression must yield the SAME plotted series,
 * bar for bar, as the identical expression written on one line. That equality —
 * not "it compiles" — is what these tests check. The last group proves the
 * merge is faithful, not a loosening: identifier-led statements stay separate
 * and genuine junk still errors.
 */

const bars: KLineData[] = (() => {
  let seed = 11;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  let price = 100;
  return Array.from({ length: 50 }, (_, i) => {
    const open = price;
    const close = open * (1 + (rand() - 0.48) * 0.06);
    price = close;
    return {
      timestamp: 1700000000000 + i * 86_400_000,
      open,
      high: Math.max(open, close) * 1.01,
      low: Math.min(open, close) * 0.99,
      close,
      volume: 1000 + Math.floor(rand() * 500),
      turnover: 0,
    } as KLineData;
  });
})();

/** Full finite series of the first plot line (throws on compile/run failure). */
function series(src: string): (number | null)[] {
  const out = compilePine(src, bars, {});
  if ("error" in out) throw new Error(`编译失败：${out.error}`);
  if (out.abort) throw new Error(`运行中断：${out.abort}`);
  return out.result.lines[0]?.values ?? [];
}

/** Scalar last value of the first plot line. */
function last(src: string): number {
  const s = series(src);
  for (let i = s.length - 1; i >= 0; i--) {
    const v = s[i];
    if (typeof v === "number" && Number.isFinite(v)) return v;
  }
  return NaN;
}

describe("folded expression == single-line expression (byte-identical series)", () => {
  it("arithmetic wrapped with the operator at each line start keeps precedence", () => {
    const inline = "q = 2 + 3 * 4 - 10 / 5\nplot(q)\n";
    const folded = "q = 2\n  + 3 * 4\n  - 10 / 5\nplot(q)\n";
    expect(last(inline)).toBeCloseTo(12, 10); // 2 + 12 - 2
    expect(series(folded)).toEqual(series(inline));
  });

  it("ternary split across ? / : lines matches the inline ternary", () => {
    const inline = "x = close > open ? 1 : 0\nplot(x)\n";
    const folded = "x = close > open\n   ? 1\n   : 0\nplot(x)\n";
    expect(series(folded)).toEqual(series(inline));
    // a different-looking fold (operator end-of-line on the prior rule) also agrees
    const trailing = "x = close > open ?\n   1 :\n   0\nplot(x)\n";
    expect(series(trailing)).toEqual(series(inline));
  });

  it("logical and/or wrapped to line start matches inline", () => {
    const inline = "f = close > open and volume > 1200\nplot(f ? 1 : 0)\n";
    const folded = "f = close > open\n   and volume > 1200\nplot(f ? 1 : 0)\n";
    expect(series(folded)).toEqual(series(inline));
  });

  it("mixed multiplicative/parenthesis wrap (digital-filter shape) agrees", () => {
    const inline =
      "y = (high + low) / 2 * close - (high - low) / (open + 1)\nplot(y)\n";
    const folded =
      "y = (high + low) / 2\n   * close\n   - (high - low)\n   / (open + 1)\nplot(y)\n";
    expect(series(folded)).toEqual(series(inline));
  });

  it("function-body return wrapped across lines matches inline", () => {
    const inline = "f(x) => x > 0 ? x : -x\nplot(f(close - 100))\n";
    const folded = "f(x) =>\n   x > 0\n   ? x\n   : -x\nplot(f(close - 100))\n";
    expect(series(folded)).toEqual(series(inline));
  });

  it("comment and blank lines between wrapped segments still merge", () => {
    const inline = "x = 2 + 3\nplot(x)\n";
    const folded = "x = 2\n  // add the tail\n  + 3\nplot(x)\n";
    expect(last(folded)).toBeCloseTo(5, 10);
    expect(series(folded)).toEqual(series(inline));
  });
});

describe("faithful, not a loosening", () => {
  it("an identifier-led next line is a separate statement, not a continuation", () => {
    // If `y` were wrongly merged onto `x = 5`, this would fail to compile.
    expect(last("x = 5\ny = x + 1\nplot(y)\n")).toBeCloseTo(6, 10);
  });

  it("an assignment-led next line does not continue the previous expression", () => {
    expect(last("a = 1\nb := 2\nplot(a + b)\n")).toBeCloseTo(3, 10);
  });

  it("genuine junk on a line still errors (endOfStmt is not bypassed)", () => {
    const out = compilePine("x = 5 6\nplot(x)\n", bars, {});
    expect("error" in out ? true : Boolean(out.abort)).toBe(true);
  });

  it("a block body that opens with an identifier is not swallowed", () => {
    const src =
      "cond = close > open\nif cond\n  signal = 1\nplot(signal)\n";
    expect(() => series(src)).not.toThrow();
  });
});
