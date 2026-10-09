import { describe, expect, it } from "vitest";

import { volumeProfile, VPVR_ROWS, type ProfileBar } from "../volumeProfile";

/**
 * 手算向量（spec §九 第一条）。域 `[100, 104]`、4 档 ⇒ 档宽恰为 1。
 *
 * 逐根摊派（`进档量 = volume × 重叠 / (high - low)`）：
 *   A [100,102] 100 ⇒ 第 0 档 50、第 1 档 50
 *   B [102,104] 200 ⇒ 第 2 档 100、第 3 档 100（第 3 档右闭）
 *   C [101,103] 120 ⇒ 第 1 档 60、第 2 档 60
 *   D [104,104]  50 ⇒ 一字线，`floor` 给 4 ⇒ 钳进第 3 档
 * ⇒ 档位 `[50, 110, 160, 150]`、`totalVolume = 470`、`pocIndex = 2`。
 */
const VECTOR: ProfileBar[] = [
  { high: 102, low: 100, volume: 100 },
  { high: 104, low: 102, volume: 200 },
  { high: 103, low: 101, volume: 120 },
  { high: 104, low: 104, volume: 50 },
];

describe("volumeProfile 摊派", () => {
  it("手算向量：逐档、POC、总量、域极值、档边界全对上", () => {
    const p = volumeProfile(VECTOR, 4);
    expect(p.rows.map((r) => r.volume)).toEqual([50, 110, 160, 150]);
    expect(p.totalVolume).toBe(470);
    expect(p.pocIndex).toBe(2);
    expect(p.spanLow).toBe(100);
    expect(p.spanHigh).toBe(104);
    // 第 0..2 档是左闭右开的 1 宽格；末档右闭 ⇒ 它的 `high` 就是 `spanHigh`。
    expect(p.rows.map((r) => r.low)).toEqual([100, 101, 102, 103]);
    expect(p.rows.map((r) => r.high)).toEqual([101, 102, 103, 104]);
  });

  it("缺省档数是出厂的 100", () => {
    expect(volumeProfile(VECTOR).rows).toHaveLength(VPVR_ROWS);
  });

  it("一字线整量进包含该价的那一档，且不造出 NaN／Infinity", () => {
    // `high === low` 时摊派分母为 0——这是本片唯一造得出 `NaN` 的地方，所以它单独一条。
    const p = volumeProfile([{ high: 101, low: 101, volume: 7 }, ...VECTOR], 4);
    // 101 是第 1 档 `[101,102)` 的下界（下界含）⇒ 进第 1 档。
    expect(p.rows[1].volume).toBe(117);
    for (const row of p.rows) {
      expect(Number.isFinite(row.volume)).toBe(true);
    }
    expect(p.totalVolume).toBe(477);
  });

  it("末档右闭：`high === spanHigh` 的根钳进最后一档，一格量都不丢", () => {
    const p = volumeProfile(
      [
        { high: 104, low: 104, volume: 7 },
        { high: 100, low: 100, volume: 3 },
      ],
      4,
    );
    expect(p.rows.map((r) => r.volume)).toEqual([3, 0, 0, 7]);
    expect(p.rows[3].high).toBe(104);
    expect(p.totalVolume).toBe(10);
  });

  it("POC 并列取下（与价值区扩展的并列取上相反）", () => {
    // 域 [100,102]、2 档、档宽 1：两根各吃满一档 ⇒ 两档同量。
    const p = volumeProfile(
      [
        { high: 101, low: 100, volume: 10 },
        { high: 102, low: 101, volume: 10 },
      ],
      2,
    );
    expect(p.rows.map((r) => r.volume)).toEqual([10, 10]);
    expect(p.pocIndex).toBe(0);
  });

  it("摊派不丢量也不造量：逐档之和 === totalVolume（相对界，不是绝对位数）", () => {
    // 60 根、档宽不整除（域宽 12 / 100 档 = 0.12，二进制里不可精确表示）——浮点累加必然有噪声。
    // 这条同时钉住 §四 的钳位与摊派系数：漏一档或少一档都是 **O(一档的量)** 的错，
    // 而噪声是 O(总量 × 1e-14) 量级，两者差十个数量级，所以判相对界足够有杀伤力。
    // 为什么不用 `toBeCloseTo(…, 9)`：那是 5e-10 的**绝对**界，而本机 V8 实测 `rows = 100`
    // 时累加噪声 2.36e-9（实现席 2026-10-09 诊断），会被绝对位数随样本量级一起漂掉。
    const bars: ProfileBar[] = Array.from({ length: 60 }, (_, i) => ({
      low: 100 + (i % 10),
      high: 100 + (i % 10) + 3,
      volume: 1_000 + i,
    }));
    for (const rows of [2, 7, 8, VPVR_ROWS]) {
      const p = volumeProfile(bars, rows);
      const sum = p.rows.reduce((acc, r) => acc + r.volume, 0);
      expect(Math.abs(sum - p.totalVolume) / p.totalVolume).toBeLessThan(1e-11);
    }
  });
});

describe("volumeProfile 退化", () => {
  it("空输入：档数照给、全零档、极值取 0，不抛也不 NaN", () => {
    const p = volumeProfile([], 4);
    expect(p.rows).toHaveLength(4);
    for (const row of p.rows) expect(row).toEqual({ low: 0, high: 0, volume: 0 });
    expect(p.pocIndex).toBe(0);
    expect(p.totalVolume).toBe(0);
    expect(p.spanLow).toBe(0);
    expect(p.spanHigh).toBe(0);
  });

  it("域塌成一个点（`spanHigh === spanLow`）：全部量进第 0 档，档宽记 0", () => {
    const p = volumeProfile(
      [
        { high: 101, low: 101, volume: 10 },
        { high: 101, low: 101, volume: 20 },
        { high: 101, low: 101, volume: 30 },
      ],
      4,
    );
    expect(p.rows.map((r) => r.volume)).toEqual([60, 0, 0, 0]);
    for (const row of p.rows) {
      expect(row.low).toBe(101);
      expect(row.high).toBe(101);
    }
    expect(p.pocIndex).toBe(0);
    expect(p.totalVolume).toBe(60);
  });

  it("全零量：各档为 0、`totalVolume` 为 0、`pocIndex` 仍是 0（绘制侧另有不画的规矩）", () => {
    const p = volumeProfile(
      [
        // 顺序**刻意**不让撑满域的那根排在 `bars[0]`：实现是先用 `bars[0]` 播种极值再无条件扫描
        // （`volumeProfile.ts:48-53`），若第一根就是 `[100,104]`，那「在极值循环里加一句
        // `if (volume === 0) continue`」这种缺陷也能得到 100/104 ⇒ 针被夹具自己喂绿。
        { high: 103, low: 101, volume: 0 },
        { high: 104, low: 100, volume: 0 },
      ],
      4,
    );
    expect(p.totalVolume).toBe(0);
    expect(p.rows.every((r) => r.volume === 0)).toBe(true);
    expect(p.pocIndex).toBe(0);
    // 零量根**照旧参与域扫描**（极值循环在 `volume === 0` 那一支的 `continue` 之前）——
    // Task 3 的几何夹具靠一根零量锚根把域撑成 `[100,200]`、把档宽钉成 1，
    // 这条要是漂了那批逐格写死的矩形就全错，所以它必须在这里入库，不能只活在验收当天的 scratch 里。
    expect(p.spanLow).toBe(100);
    expect(p.spanHigh).toBe(104);
  });
});

describe("volumeProfile 不看游标之后（spec §八 的算术形式）", () => {
  it("在 `k` 之后追加一根荒谬巨量，前 `k` 根的分布逐档不变", () => {
    const all: ProfileBar[] = Array.from({ length: 12 }, (_, i) => ({
      low: 100 + (i % 5) * 2,
      high: 100 + (i % 5) * 2 + 4,
      volume: 500 + i * 10,
    }));
    const k = 7;
    const prefix = volumeProfile(all.slice(0, k), 6);
    // 前缀的期望值**逐格写死**：7 根、域 [100,112]、6 档 ⇒ 档宽恰为 2（二进制精确），
    // 每根 `high - low` = 4 恰跨两档、各吃 1/2。
    //   档0 = 250+275 = 525   档1 = 250+255+275+280 = 1060   档2 = 255+260+280 = 795
    //   档3 = 260+265 = 525   档4 = 265+270 = 535            档5 = 270
    // 没有这几行字面值，下面那条「毒数组的切片与干净数组的切片相等」就是拿
    // `all.slice(0,7)` 与 `poisoned.slice(0,7)`（**内容逐元素相同、只换了数组对象**）互比，
    // 两侧一起错也照样绿。字面值把参照点钉死，等值那条才有意义。
    expect(prefix.spanLow).toBe(100);
    expect(prefix.spanHigh).toBe(112);
    expect(prefix.rows.map((r) => r.volume)).toEqual([525, 1060, 795, 525, 535, 270]);
    expect(prefix.totalVolume).toBe(3_710);
    expect(prefix.pocIndex).toBe(1);
    const poisoned: ProfileBar[] = [...all.slice(0, k), ...all.slice(k), { high: 9_999, low: -9_999, volume: 1e12 }];
    const fromPoisoned = volumeProfile(poisoned.slice(0, k), 6);
    expect(fromPoisoned).toEqual(prefix);
    // 这条**判的是什么**要说准：`poisoned.slice(0, k)` 与 `all.slice(0, k)` 内容相同，
    // 所以它判的是「无跨调用状态、对同一批根给出同一结果」——
    // 「切片本身取对没有」不在一个纯函数的判据面里，它归 Task 3 的 `profileOfChart`
    // （只有那里才决定喂进哪些根，判据是假 chart 逐索引那条）。
    // 阳性对照：毒根**确实有药**。把它真喂进去就必须改掉域与总量——否则上面那条相等
    // 可能只是在比一个对结果毫无影响力的输入（本仓 [[verify-scan-guard-false-green]] 的空集失效）。
    const full = volumeProfile(poisoned, 6);
    expect(full.spanLow).toBe(-9_999);
    expect(full.spanHigh).toBe(9_999);
    expect(full.totalVolume).toBe(1_000_000_006_660); // 1e12 ＋ 前 12 根的 6_660
    // 不钉 `full.pocIndex`：1e12 摊到 6 档上每档 `1e12/6` 完全等值，最大档由真实根的
    // 零头决定，那是浮点落点而不是判据——钉它就是把针交给最后一位舍入。
    // 回读**我们自己持有的**那个数组：前两次调用喂的是 `slice()` 出来的临时数组，
    // 实现若就地改写传入数组（`sort`／写脏某根），只有这一支抓得住——`full` 的域与总量
    // 对元素顺序不敏感，所以不读这一行，「不改调用方传入的数组」就只是注释里的声称。
    expect(poisoned.map((b) => b.volume)).toEqual([500, 510, 520, 530, 540, 550, 560, 570, 580, 590, 600, 610, 1e12]);
  });

  it("前缀单调：`totalVolume` 随 `k` 不减", () => {
    const all: ProfileBar[] = Array.from({ length: 20 }, (_, i) => ({
      low: 100 + (i % 4),
      high: 100 + (i % 4) + 2,
      volume: 100 + i,
    }));
    let prev = 0;
    for (let k = 1; k <= all.length; k++) {
      const total = volumeProfile(all.slice(0, k), 5).totalVolume;
      expect(total).toBeGreaterThanOrEqual(prev);
      prev = total;
    }
  });
});
