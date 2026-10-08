import { describe, expect, it } from "vitest";

import { HA_PRICE_KEYS, heikinAshi } from "../heikinAshi";

/**
 * Heikin-Ashi 的算术（推荐清单第④片，spec §二·4/§六/§七·1）。
 *
 * 手算向量是这条公式唯一的可复核形态：每一个期望值都能用四则运算在纸上重算，
 * 所以实现写错方向（比如把 `haOpen` 接成当根的 `(O+C)/2`）不会靠「换一组数也自洽」
 * 混过去。缺口向量 `[(10,20,10,20),(1,2,1,2)]` 是 spec §二·4 的样本，它的存在理由
 * 是库的 y 轴折叠——第二根真实 high 只有 2，而 `haHigh` 是 15。
 */

function bar(open: number, high: number, low: number, close: number) {
  return { timestamp: 0, open, high, low, close, volume: 1 };
}

describe("heikinAshi", () => {
  it("空表返回空表", () => {
    expect(heikinAshi([])).toEqual([]);
  });

  it("单根：haOpen 用 (O+C)/2 播种，高低由当根极值决定", () => {
    expect(heikinAshi([bar(10, 12, 9, 11)])).toEqual([
      { open: 10.5, high: 12, low: 9, close: 10.5 },
    ]);
  });

  it("三根连续：haOpen 接上一根的 (haOpen+haClose)/2", () => {
    expect(
      heikinAshi([bar(10, 12, 9, 11), bar(11, 13, 10, 12), bar(12, 14, 11, 13)]),
    ).toEqual([
      { open: 10.5, high: 12, low: 9, close: 10.5 },
      { open: 10.5, high: 13, low: 10, close: 11.5 },
      { open: 11.0, high: 14, low: 11, close: 12.5 },
    ]);
  });

  it("缺口向量：第二根 haHigh=15 而真实 high=2 —— y 轴折叠存在的理由", () => {
    const rows = heikinAshi([bar(10, 20, 10, 20), bar(1, 2, 1, 2)]);
    expect(rows).toEqual([
      { open: 15, high: 20, low: 10, close: 15 },
      { open: 15, high: 15, low: 1, close: 1.5 },
    ]);
    // 断言的是「变换值越出真实区间」这件事本身：Task 2 的轴折叠白名单钉就是为它服务的。
    expect(rows[1].high).toBe(15);
    expect(rows[1].high!).toBeGreaterThan(2);
  });

  it("非有限价输出无键空行并断开链，下一根重新播种", () => {
    const rows = heikinAshi([bar(10, 12, 9, 11), { open: 5, high: 6, low: 4, close: NaN }, bar(1, 2, 0.5, 1.5)]);
    expect(Object.keys(rows[1])).toEqual([]);
    // 第三根不继承 na 行：照首根播种 (O+C)/2 = 1.25。
    expect(rows[2]).toEqual({ open: 1.25, high: 2, low: 0.5, close: 1.25 });
  });

  it("null/undefined/非对象样本各出一行无键，长度永远等于输入长度", () => {
    const rows = heikinAshi([null, undefined, 42, "x", {}, bar(1, 2, 0.5, 1.5)]);
    expect(rows).toHaveLength(6);
    expect(rows.slice(0, 5).every((r) => Object.keys(r).length === 0)).toBe(true);
    expect(rows[5]).toEqual({ open: 1.25, high: 2, low: 0.5, close: 1.25 });
  });

  it("结果里只有四个价格键——像素量混进来就直接失败", () => {
    const allowed = new Set(HA_PRICE_KEYS);
    for (const row of heikinAshi(PREFIX_BARS)) {
      for (const key of Object.keys(row)) expect(allowed.has(key)).toBe(true);
    }
  });
});

/**
 * 前缀不变量（spec §七·1，形状照 `lib/__tests__/pinePrefixInvariance.test.ts`）：
 * `heikinAshi(bars.slice(0, n))` 必等于 `heikinAshi(bars).slice(0, n)`。
 *
 * 这条是「没有未来函数」的可复算证据，也是 Bar Replay 的前提——回放喂进图的永远是
 * 前缀（`lib/barReplay.ts`），前缀与全量逐根相同才说明游标在第 k 根看到的那根实体
 * 不会因为后面来了新 bar 而变形。`probes` 是探针计数：0 个探针的循环会真空通过，
 * 所以它本身必须被断言。
 */

const DAY = 86_400_000;
const TOTAL = 40;
const START = Date.parse("2026-01-05T00:00:00+08:00");

/** 确定性 LCG：不许用 `Math.random()`，否则「红的那次」无法复算。 */
function makeBars(count: number) {
  let seed = 20261008;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  return Array.from({ length: count }, (_, i) => {
    const a = 100 + 20 * rnd();
    const b = 100 + 20 * rnd();
    const open = a;
    const close = b;
    const span = 1 + 5 * rnd();
    return {
      timestamp: START + i * DAY,
      open,
      high: Math.max(open, close) + span,
      low: Math.min(open, close) - span,
      close,
      volume: 1,
    };
  });
}

const PREFIX_BARS = makeBars(TOTAL);

describe("heikinAshi 前缀不变量（无未来函数）", () => {
  const full = heikinAshi(PREFIX_BARS);
  let worst = 0;
  let probes = 0;
  let firstMismatch: string | null = null;

  for (let n = 1; n <= TOTAL; n++) {
    const prefix = heikinAshi(PREFIX_BARS.slice(0, n));
    probes += 1;
    if (prefix.length !== n) {
      firstMismatch ??= `n=${n} 长度 ${prefix.length} ≠ ${n}`;
      continue;
    }
    const expected = full.slice(0, n);
    let diff = 0;
    for (let i = 0; i < n; i++) {
      if (JSON.stringify(prefix[i]) !== JSON.stringify(expected[i])) diff += 1;
    }
    worst = Math.max(worst, diff);
    if (diff > 0 && firstMismatch === null) {
      firstMismatch = `n=${n} 第 ${diff} 根起不同：prefix=${JSON.stringify(prefix[n - 1])} full=${JSON.stringify(expected[n - 1])}`;
    }
  }

  it(`全部 ${TOTAL} 个前缀都比对到了（探针数本身要被断言，不许空集合真空通过）`, () => {
    expect(probes).toBe(TOTAL);
  });

  it("每个前缀的输出都等于全量输出的同长前缀", () => {
    expect(firstMismatch).toBeNull();
    expect(worst).toBe(0);
  });
});
