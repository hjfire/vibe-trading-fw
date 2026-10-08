import { describe, expect, it } from "vitest";

import { HA_PRICE_KEYS, heikinAshi } from "../heikinAshi";

/**
 * Heikin-Ashi 的算术（推荐清单第④片，spec §二·4/§六/§七·1）。
 *
 * 手算向量是这条公式唯一的可复核形态：每一个期望值都能用四则运算在纸上重算，
 * 所以实现写错方向（比如把 `haOpen` 接成当根的 `(O+C)/2`）不会靠「换一组数也自洽」
 * 混过去。缺口向量 `[(10,20,10,20),(1,2,1,2)]` 是 spec §二·4 的样本，它的存在理由
 * 是库的 y 轴折叠——第二根真实 high 只有 2，而 `haHigh` 是 15。
 *
 * 但 spec 的那组样本（连同下面三条价向量与 40 根语料）都是**退化**的：每根都满足
 * `O+C == H+L`，于是首根的三种候选值 `(O+C)/2`、`(O+H+L+C)/4`、`(H+L)/2` 撞成同一个数，
 * 播种公式选错了也判不出来。补的非对称向量 `[(10,20,6,8),…]` 三种候选是 9 / 11 / 13，
 * 互不相同，`haOpen₀` 被钉死在 9 —— 只有 `(O₀+C₀)/2` 交得出这个数（spec §六 首根播种）。
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

  it("非对称向量：首根三种候选播种值互不相同，haOpen₀ 只能是 (O₀+C₀)/2", () => {
    const bars = [bar(10, 20, 6, 8), bar(14, 18, 12, 16), bar(10, 12, 4, 8)];
    const [b0, b1, b2] = bars;
    // 先钉这组向量本身有效：三种候选首根值两两不等（9 / 11 / 13），否则它和退化向量同病。
    const candidates = [
      (b0.open + b0.close) / 2,
      (b0.open + b0.high + b0.low + b0.close) / 4,
      (b0.high + b0.low) / 2,
    ];
    expect(candidates).toEqual([9, 11, 13]);
    expect(new Set(candidates).size).toBe(3);

    const rows = heikinAshi(bars);
    expect(rows).toEqual([
      { open: 9, high: 20, low: 6, close: 11 },
      { open: 10, high: 18, low: 10, close: 15 },
      { open: 12.5, high: 12.5, low: 4, close: 8.5 },
    ]);
    // 首根只认 `(O+C)/2 = 9`：接成 `haClose` 的实现交 11、接成 `(H+L)/2` 的交 13，都在这一行红。
    expect(rows[0].open).toBe(9);
    // `haLow = min(L, haOpen, haClose)` 真正咬到的地方：第二根 haOpen=10 落在真实 low=12 之下，
    // 写成 `low: l` 的实现交的是 12。
    expect(rows[1].low).toBe(10);
    expect(rows[1].low!).toBeLessThan(b1.low);
    // 镜像：第三根的 haOpen=12.5（由第二根 HA 递推而来）抬在真实 high=12 之上，
    // 写成 `high: h` 的实现交的是 12。
    expect(rows[2].high).toBe(12.5);
    expect(rows[2].high!).toBeGreaterThan(b2.high);
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
    const rows = heikinAshi(PREFIX_BARS);
    // 非真空性由这两行给出：循环比对的是 40 行，而每行确实带齐四键，
    // 于是内层键循环跑满 40×4 次。实现若对每根返回 `{}`，`Object.keys(row)` 是空集，
    // 下面那条逐键断言一次都不执行，整条测试会真空绿。
    expect(PREFIX_BARS).toHaveLength(TOTAL);
    expect(rows).toHaveLength(TOTAL);
    for (const row of rows) {
      const keys = Object.keys(row);
      expect(keys).toHaveLength(4);
      for (const key of keys) expect(allowed.has(key)).toBe(true);
    }
  });

  it("语料 40 行逐根钉值：HA 包络与 haClose 公式，不靠前缀比对", () => {
    const rows = heikinAshi(PREFIX_BARS);
    expect(rows).toHaveLength(TOTAL);
    for (let i = 0; i < TOTAL; i++) {
      const b = PREFIX_BARS[i];
      const row = rows[i];
      // spec §二·5b：`haHigh = max(H, haOpen, haClose) ≥ {haOpen, haClose}`、
      // `haLow = min(L, haOpen, haClose) ≤ {haOpen, haClose}` —— 轴只声明高低两键的理由。
      // 这两条在本语料里真咬得到：实测 40 行中 8 行 `haLow < low`、3 行 `haHigh > high`，
      // 所以 `low: l`／`high: h` 这种实现会在越界那一行当场红，而不是靠上一条的相等自洽。
      expect(row.high!).toBeGreaterThanOrEqual(Math.max(row.open!, row.close!));
      expect(row.low!).toBeLessThanOrEqual(Math.min(row.open!, row.close!));
      // `haClose = (O+H+L+C)/4`（spec §二·4）：与实现同序求值，逐比特比。
      // 语料自身钉不住首根播种（`makeBars` 令 `H+L == O+C` 恒成立，三个候选值撞在一起），
      // 播种由上面那条非对称向量钉；这里钉的是每根都算得对的那一半。
      expect(row.close!).toBe((b.open + b.high + b.low + b.close) / 4);
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
  const keySet = new Set(HA_PRICE_KEYS);
  // `probes` 只数了一个静态边界的循环，它本身证不了非真空：实现若对每根返回 `{}`，
  // 前缀与全量都是 `{}` 对 `{}`，逐根 JSON 比对照样全等，两条测试一起绿。
  // 所以这里再记两个数——基准行数（`full.length`）与「带齐白名单四键的行数」（`complete`）——
  // 让「比对确实发生在一个有四价行的集合上」成为这个文件证得了的事。
  let complete = 0;
  for (const row of full) {
    const keys = Object.keys(row);
    if (keys.length === keySet.size && keys.every((k) => keySet.has(k))) complete += 1;
  }

  let worst = 0;
  let probes = 0;
  let compared = 0;
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
    let firstDiff = -1;
    for (let i = 0; i < n; i++) {
      compared += 1;
      if (JSON.stringify(prefix[i]) !== JSON.stringify(expected[i])) {
        diff += 1;
        if (firstDiff === -1) firstDiff = i;
      }
    }
    worst = Math.max(worst, diff);
    if (diff > 0 && firstMismatch === null) {
      // 打印的是**第一个**差异行（下标 `firstDiff`）。上一版在这里写的是
      // `第 ${diff} 根` ＋ `prefix[n-1]`/`expected[n-1]`，即「差异个数」当索引、
      // 又固定打印最后一行，两条字符串常常长得一模一样，读的人看不出红在哪。
      firstMismatch =
        `n=${n} 共 ${diff} 根不同，首个差异下标 ${firstDiff}：` +
        `prefix[${firstDiff}]=${JSON.stringify(prefix[firstDiff])} full[${firstDiff}]=${JSON.stringify(expected[firstDiff])}`;
    }
  }

  it(`全部 ${TOTAL} 个前缀都比对到了（探针数本身要被断言，不许空集合真空通过）`, () => {
    expect(probes).toBe(TOTAL);
    // 探针计数的另一半：比到的必须是「有内容」的行。
    expect(PREFIX_BARS).toHaveLength(TOTAL);
    expect(full).toHaveLength(TOTAL);
    expect(complete).toBe(TOTAL);
    // 逐根比对的次数：1+2+…+40 = 820，静态可复算，证明确实比了 820 次而不是 0 次。
    expect(compared).toBe((TOTAL * (TOTAL + 1)) / 2);
  });

  it("每个前缀的输出都等于全量输出的同长前缀", () => {
    expect(firstMismatch).toBeNull();
    expect(worst).toBe(0);
  });
});
