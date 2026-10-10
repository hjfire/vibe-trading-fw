import { describe, expect, it } from "vitest";

import { alignCloseToTimestamps, type CompareBar } from "../symbolCompare";

/**
 * 第⑥片（多标的叠加对比）的纯对齐面（spec §三）。
 *
 * 域钉成「日线钟点」是有原因的：主图与对比标的都是日线时，时间戳是交易日标签的
 * naive 午夜（`agent/src/api/market_routes.py` 的 `_bars_from_frame`，spec §一 引过），
 * 所以「主图第 i 根 vs 对比第 j 根」的所有形状都能用 `D(k)` 手写出来。
 */
const D = (i: number): number => 1_700_000_000_000 + i * 86_400_000;
const MAIN5 = [D(0), D(1), D(2), D(3), D(4)];

const bar = (i: number, close: number): CompareBar => ({ timestamp: D(i), close });

describe("alignCloseToTimestamps", () => {
  it("carry-forward：缺口取上一个已知价，绝不取后一个", () => {
    // 对比只有第 1、3 两根有价：主图第 0 根早于对比首根 ⇒ null（拒绝 bfill），
    // 第 2 根 carry 第 1 根，第 4 根 carry 第 3 根。
    expect(alignCloseToTimestamps(MAIN5, [bar(1, 10), bar(3, 12)])).toEqual([null, 10, 10, 12, 12]);
  });

  it("拒绝 bfill：主图首根早于对比首根时是 null，不是第一个已知值", () => {
    expect(alignCloseToTimestamps([D(0)], [bar(2, 5)])).toEqual([null]);
    expect(alignCloseToTimestamps(MAIN5, [bar(3, 7)])).toEqual([null, null, null, 7, 7]);
  });

  it("并列取等号那侧（`<=` 而非 `<`）", () => {
    // 主图第 2 根与对比第 2 根时间戳**完全相等** ⇒ 必须取到 7。
    // 把实现里的 `<=` 改成 `<` 这一条就红——那正是 §十·② 的第一根毒针。
    expect(alignCloseToTimestamps([D(2)], [bar(2, 7)])).toEqual([7]);
  });

  it("坏值整根跳过：0／负数／NaN 都不进游标，后面的好价格不被截断", () => {
    // §三 的判据是「非有限**或**非正」两半，所以这里三种都喂：
    // 后端缺列补的是 `0`（有限！），只挡非有限的过滤器会把它原样放行。
    const series = [bar(0, 8), bar(1, 0), bar(2, Number.NaN), bar(3, -5), bar(4, 9)];
    expect(alignCloseToTimestamps(MAIN5, series)).toEqual([8, 8, 8, 8, 9]);
  });

  it("同一时间戳重复时取最后一根的价", () => {
    const dup: CompareBar[] = [
      { timestamp: D(2), close: 10 },
      { timestamp: D(2), close: 11 },
    ];
    expect(alignCloseToTimestamps([D(2), D(3)], dup)).toEqual([11, 11]);
  });

  it("两侧为空都是合法输入，长度恒等于主图长度", () => {
    expect(alignCloseToTimestamps([], [])).toEqual([]);
    expect(alignCloseToTimestamps(MAIN5, [])).toEqual([null, null, null, null, null]);
    expect(alignCloseToTimestamps([], [bar(0, 1)])).toEqual([]);
    expect(alignCloseToTimestamps(MAIN5, [bar(0, 1)])).toHaveLength(MAIN5.length);
  });

  it("前缀不变量：对任意 k，align(ts.slice(0,k)) === align(ts).slice(0,k)", () => {
    // 这一条就是「没有未来函数」在纯函数面的判据形态（第④片同款）。逐根独立 ⇒
    // 主图右边多了什么根，绝不改左边任何一项。
    const full = alignCloseToTimestamps(MAIN5, [bar(1, 10), bar(3, 12)]);
    for (let k = 0; k <= MAIN5.length; k++) {
      expect(alignCloseToTimestamps(MAIN5.slice(0, k), [bar(1, 10), bar(3, 12)])).toEqual(full.slice(0, k));
    }
  });

  it("主图尾部加一根不改前面任何一项（增量交付的等价形状）", () => {
    const a = alignCloseToTimestamps(MAIN5, [bar(2, 20)]);
    const b = alignCloseToTimestamps([...MAIN5, D(5), D(6)], [bar(2, 20)]);
    expect(b.slice(0, MAIN5.length)).toEqual(a);
    expect(b).toEqual([null, null, 20, 20, 20, 20, 20]);
  });
});
