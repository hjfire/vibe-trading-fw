import { beforeEach, describe, expect, it, vi } from "vitest";

// 库的 `registerIndicator` 改的是全局表；桩掉它，既不让真库起来，又能把注册对象抓下来逐键判。
// 形状照 `lib/__tests__/timeShare.test.ts:5-8`。
const registered: Array<Record<string, unknown>> = [];
vi.mock("klinecharts", () => ({
  registerIndicator: (spec: Record<string, unknown>) => registered.push(spec),
}));

import { CANDLE_COLORS } from "../chartPalette";
import {
  CANDLE_HIDDEN,
  HA_PRICE_KEYS_FOR_TEST,
  HEIKIN_ASHI_NAME,
  HEIKIN_ASHI_PREFS_KEY,
  HEIKIN_ASHI_SHORT_NAME,
  ensureHeikinAshiIndicator,
  heikinAshiActive,
  loadHeikinAshi,
  saveHeikinAshi,
} from "../heikinAshiChart";
import { heikinAshi, type HaRow } from "../heikinAshi";

/**
 * 库绑定层（推荐清单第④片，spec §二/§七·2）。这里断言的五件事每一条都能让方案「做完了但静默不对」：
 *
 * - `series:"price"` 与 `figures` 只有 `high`/`low`：轴折叠面就是 `figures[].key` 的集合
 *   （`YAxisImp.createRangeImp`，dist 1045-1056）。两键已是完整包络（`haHigh ≥ {haOpen,haClose}`、
 *   `haLow ≤ {haOpen,haClose}`），多声明开/收只多两行图例，不多护一寸轴。
 * - 每个 figure 都有 `type`：缺 `type` 的图元被 `prepareIndicatorFigures` 丢掉（dist 3081-3125）。
 * - result 只含四个价格键：像素量混进来会被当价格折进 y 轴。
 * - `draw` 返回 `true`：返回 false 会让库把默认图元再画一遍。
 * - `createTooltipDataSource` 出四价一行、行名写「平均K线」：变换值绝不进蜡烛图例（spec §五）。
 *
 * 在这个五件下面还有一层边：`draw` 的几何夹子（gapBar 0 与 1 各自那一支、平盘那根的零高影线、
 * 可视区左界为负时的起点）和 `createTooltipDataSource` 缺省光标的下标由哪条数组给——
 * 那几条钉的是「今天这条路径读起来对」之外的相邻分支，各自都点了名能杀掉哪个变异。
 */

function bar(open: number, high: number, low: number, close: number, i = 0) {
  return { timestamp: 1_700_000_000_000 + i * 86_400_000, open, high, low, close, volume: 1 };
}

/** spec §二·4 的缺口向量：第二根真实 high 只有 2，haHigh 却是 15。 */
const GAP_BARS = [bar(10, 20, 10, 20, 0), bar(1, 2, 1, 2, 1)];

function spec(): Record<string, unknown> {
  ensureHeikinAshiIndicator();
  expect(registered).toHaveLength(1);
  return registered[0];
}

type FakeRect = { x: number; y: number; w: number; h: number; color: string };

/**
 * 假 ctx／假 chart：`draw` 拿到的是裸 CanvasRenderingContext2D 和 chart 组件，全部自己造。
 * rows 用 `HaRow[]` 而不是 `Record<string, unknown>[]`——`HaRow` 是 interface，
 * 没有隐式索引签名，喂 `heikinAshi()` 的真行会撞 TS2345；而生产里 `indicator.result` 本来就是
 * `HaRow[]`，这样写反而更贴。
 */
function drawFixture(
  rows: HaRow[],
  visible = { realFrom: 0, realTo: rows.length },
  barSpace = { bar: 8, halfBar: 4, gapBar: 5, halfGapBar: 2 },
) {
  const rects: FakeRect[] = [];
  const ctx = {
    fillStyle: "",
    fillRect(x: number, y: number, w: number, h: number) {
      rects.push({ x, y, w, h, color: ctx.fillStyle });
    },
  } as unknown as CanvasRenderingContext2D & { fillStyle: string };
  // x: 每根 8px，从 20 起。y: 价格越高像素越小（100 - price），把「像素是现算的」变成交付判据。
  const chart = {
    getVisibleRange: () => ({ from: visible.realFrom, to: visible.realTo, realFrom: visible.realFrom, realTo: visible.realTo }),
    getBarSpace: () => barSpace,
    getDataList: () => rows,
  };
  const indicator = { result: rows };
  const out = (
    spec().draw as (p: unknown) => boolean
  )({ ctx, chart, indicator, xAxis: { convertToPixel: (i: number) => 20 + i * 8 }, yAxis: { convertToPixel: (p: number) => 100 - p } });
  return { rects, out };
}

beforeEach(() => {
  localStorage.clear();
});

describe("注册守卫", () => {
  it("重复调用只注册一次", () => {
    ensureHeikinAshiIndicator();
    const after = registered.length;
    ensureHeikinAshiIndicator();
    ensureHeikinAshiIndicator();
    expect(registered).toHaveLength(after);
    expect(after).toBe(1);
  });
});

describe("注册对象形状", () => {
  it("名字、短名、series、precision 都对", () => {
    const s = spec();
    expect(s.name).toBe(HEIKIN_ASHI_NAME);
    expect(s.shortName).toBe(HEIKIN_ASHI_SHORT_NAME);
    expect(s.series).toBe("price");
    expect(s.precision).toBe(2);
  });

  it("figures 恰为 high/low 两键，且每个都带 type", () => {
    const figures = spec().figures as Array<{ key: string; type?: string; title?: string }>;
    expect(figures.map((f) => f.key)).toEqual(["high", "low"]);
    for (const f of figures) {
      expect(typeof f.type).toBe("string");
      expect(f.type).toBe("line");
      expect(typeof f.title).toBe("string");
    }
  });

  it("两键包络成立：HA 高低把开收夹在中间，所以开收不需要当 figure 声明", () => {
    for (const row of heikinAshi(GAP_BARS)) {
      if (row.open === undefined || row.high === undefined) continue;
      expect(row.high).toBeGreaterThanOrEqual(row.open);
      expect(row.high).toBeGreaterThanOrEqual(row.close!);
      expect(row.low).toBeLessThanOrEqual(row.open);
      expect(row.low).toBeLessThanOrEqual(row.close!);
    }
  });
});

describe("calc", () => {
  it("result 只允许四个价格键（像素混入即失败）", () => {
    const allowed = new Set([...HA_PRICE_KEYS_FOR_TEST]);
    const rows = (spec().calc as (d: unknown[]) => Array<Record<string, unknown>>)(
      Array.from({ length: 12 }, (_, i) => bar(100 + i, 105 + i, 95 + i, 102 + i, i)),
    );
    expect(rows).toHaveLength(12);
    for (const row of rows) for (const key of Object.keys(row)) expect(allowed.has(key)).toBe(true);
  });

  it("缺口向量：第二根 result 的 high 是 15，而该根真实 high 是 2", () => {
    const rows = (spec().calc as (d: unknown[]) => Array<Record<string, number | undefined>>)(GAP_BARS);
    expect(rows[1].high).toBe(15);
    expect(GAP_BARS[1].high).toBe(2);
    expect(rows[1].low).toBe(1);
    expect(rows[1].open).toBe(15);
    expect(rows[1].close).toBe(1.5);
  });

  it("calc 就是委托给纯数学，不是另算一遍", () => {
    const bars = Array.from({ length: 8 }, (_, i) => bar(10 + i, 20 + i, 5 + i, 15 + i, i));
    const rows = (spec().calc as (d: unknown[]) => unknown[])(bars);
    expect(rows).toEqual(heikinAshi(bars));
  });
});

describe("draw", () => {
  const rows = heikinAshi([bar(10, 12, 9, 11, 0), bar(11, 13, 10, 12, 1), bar(12, 14, 11, 13, 2)]);

  it("返回 true —— 这是「整体接管绘制」的判据，false 会让默认图元再画一遍", () => {
    expect(drawFixture(rows).out).toBe(true);
  });

  it("每根画一个影线＋一个实体，几何从 yAxis 现算", () => {
    // 第 0 行 = {open:10.5, high:12, low:9, close:10.5}（平盘判据：close === open ⇒ 无变色）
    // 第 1 行 = {open:10.5, high:13, low:10, close:11.5}（涨：close > open ⇒ up 色）
    const { rects } = drawFixture(rows.slice(0, 2), { realFrom: 0, realTo: 2 });
    expect(rects).toHaveLength(4);
    // 影线：x = 20，宽 1，y = min(priceY) = y(high) = 100-12 = 88，高 = y(low)-y(high) = (100-9)-88 = 3
    expect(rects[0]).toEqual({ x: 20, y: 88, w: 1, h: 3, color: CANDLE_COLORS.noChange });
    // 实体：priceY 升序 = [88, 89.5, 89.5, 91] ⇒ y = priceY[1] = 89.5，
    // 高 = Math.max(1, priceY[2]-priceY[1]) = max(1, 0) = 1（平盘那根只有一像素，库同此形），
    // x = 20 - halfGapBar = 18，宽 = gapBar + correction（gapBar 5 是奇数 ⇒ correction 0）
    expect(rects[1]).toEqual({ x: 18, y: 89.5, w: 5, h: 1, color: CANDLE_COLORS.noChange });
    // 第 1 行 priceY 升序 = [87, 88.5, 89.5, 90] ⇒ 影线 y=87 高 3，实体 y=88.5 高 1，x 前进一根 8px
    expect(rects[2]).toEqual({ x: 28, y: 87, w: 1, h: 3, color: CANDLE_COLORS.up });
    expect(rects[3]).toEqual({ x: 26, y: 88.5, w: 5, h: 1, color: CANDLE_COLORS.up });
  });

  it("偶数 gapBar 才加那 1px correction（库的判据是 % 2 === 0，与直觉相反）", () => {
    const even = {
      rects: [] as FakeRect[],
      ctx: {
        fillStyle: "",
        fillRect(x: number, y: number, w: number, h: number) {
          even.rects.push({ x, y, w, h, color: even.ctx.fillStyle });
        },
      } as unknown as CanvasRenderingContext2D & { fillStyle: string },
    };
    const s = spec();
    (s.draw as (p: unknown) => boolean)({
      ctx: even.ctx,
      chart: {
        getVisibleRange: () => ({ from: 0, to: 1, realFrom: 0, realTo: 1 }),
        getBarSpace: () => ({ bar: 8, halfBar: 4, gapBar: 6, halfGapBar: 3 }),
        getDataList: () => [rows[0]],
      },
      indicator: { result: rows },
      xAxis: { convertToPixel: (i: number) => 20 + i * 8 },
      yAxis: { convertToPixel: (p: number) => 100 - p },
    });
    expect(even.rects[1].w).toBe(7); // gapBar 6 偶数 ⇒ 6 + 1
    expect(even.rects[1].x).toBe(17); // 20 - halfGapBar 3
  });

  it("跌色按 HA 自己的 close/open，不看真实收叠", () => {
    // 第二根真实四价 (9,10,8,9)：haClose = 36/4 = 9 < haOpen = (10.5+10.5)/2 = 10.5 ⇒ 跌。
    // 注意真实 close 9 与上一根真实 close 11 比也是跌，但判据取的是 HA 开收这一对。
    const down = heikinAshi([bar(10, 12, 9, 11, 0), bar(9, 10, 8, 9, 1)])[1];
    expect(down.open).toBe(10.5);
    expect(down.close).toBe(9);
    const { rects } = drawFixture([down], { realFrom: 0, realTo: 1 });
    expect(rects).toHaveLength(2);
    expect(rects[0].color).toBe(CANDLE_COLORS.down);
    expect(rects[1].color).toBe(CANDLE_COLORS.down);
  });

  it("只画可视区，且 na 行一根都不画", () => {
    const partial = drawFixture(rows, { realFrom: 1, realTo: 2 });
    expect(partial.rects).toHaveLength(2);
    expect(partial.rects[0].x).toBe(28); // dataIndex 1 ⇒ 20 + 1*8
    const naOnly = drawFixture([{}, {}, {}], { realFrom: 0, realTo: 3 });
    expect(naOnly.rects).toHaveLength(0);
    expect(naOnly.out).toBe(true);
  });

  it("可视区右界超过 result 长度时不越界", () => {
    const { rects, out } = drawFixture(rows, { realFrom: 0, realTo: 99 });
    expect(out).toBe(true);
    expect(rects).toHaveLength(6);
  });

  it("gapBar 0 与 gapBar 1 都得到宽 1 的实体，走的是两支", () => {
    // `correction = gapBar % 2 === 0 ? 1 : 0`（库 `dist:6566`，偶数那一支才加 1，与直觉相反）。
    // 两个下标分开摆就是为了让它们走不同的支：gapBar 0 是「偶数加 1」⇒ 0 + 1，
    // gapBar 1 是「奇数不加」⇒ 1 + 0。写成常量 0 会红在 0 那一格，写成常量 1 或把判据
    // 反成 `% 2 === 1` 会红在 1 那一格——两支都有人管。
    const zero = drawFixture([rows[0]], { realFrom: 0, realTo: 1 }, { bar: 0, halfBar: 0, gapBar: 0, halfGapBar: 0 });
    expect(zero.rects[1].w).toBe(1);
    const one = drawFixture([rows[0]], { realFrom: 0, realTo: 1 }, { bar: 1, halfBar: 0, gapBar: 1, halfGapBar: 0 });
    expect(one.rects[1].w).toBe(1);
  });

  it("一根平到底（四个 HA 价重合）：影线高度是 0，实体高度仍被 Math.max(1, …) 托住", () => {
    // `priceY[3] - priceY[0] === 0` 那一格：影线就是那句减法，零高 `fillRect` 画不出东西，
    // 库的 `_createSolidBar`（`dist:6652-6677`）同此形——给影线也补一个 `Math.max(1, …)`
    // 就把这条平盘根画出一截不该存在的芯。实体那一侧必须仍是 `Math.max(1, …)`，
    // 不然平盘那根在图上彻底消失（去掉它红在 rects[1].h）。
    const flat = drawFixture([{ open: 7, high: 7, low: 7, close: 7 }], { realFrom: 0, realTo: 1 });
    expect(flat.rects).toHaveLength(2);
    expect(flat.rects[0]).toEqual({ x: 20, y: 93, w: 1, h: 0, color: CANDLE_COLORS.noChange });
    expect(flat.rects[1]).toEqual({ x: 18, y: 93, w: 5, h: 1, color: CANDLE_COLORS.noChange });
  });

  it("可视区左界为负（向左拖过零界）：画的仍是可视区那两根，从 dataIndex 0 起", () => {
    // 一句实话：`Math.max(0, realFrom)` 是**纯冗余**，不是分岔。库的循环对负下标是惰性的——
    // `result[-3]` 是 `undefined`，`isHaRow` 先 `continue` 掉了，所以把这一夹整个删掉今天
    // 一个像素都不变（负下标越不出 result 的实体范围，也产生不出矩形）。这一条不替那个夹子
    // 求存，也不该被当成「留着它将来有用」的依据；它钉的是范围起点这头的真值：夹子写错成
    // `Math.max(1, …)` 会少画最左边那一根（x 序列变成 [28, 26]）、写成 `realTo` 会一根不画、
    // 写成 `Math.abs(realFrom)` 会从 [20, 18, 28, 26] 变成空——三种都只有这一条看得见
    // （`Math.abs` 那一种其余测试全绿，因为正常路径的起点本来就是 0）。
    const { rects, out } = drawFixture(rows, { realFrom: -3, realTo: 2 });
    expect(out).toBe(true);
    expect(rects.map((r) => r.x)).toEqual([20, 18, 28, 26]);
  });
});

describe("createTooltipDataSource", () => {
  // `result` 单独一个入参：库把 `dataList` 与 `indicator.result` 分在两处更新
  // （`StoreImp.addIndicator` 里排的是 `_calcIndicator`，dist 14150），缺省光标的下标
  // 读的是哪一个，只有把两条长度拆开才判得出来。省略它＝两者同一个数组，即原有的全部用法。
  function legends(index: number | undefined, rows = heikinAshi(GAP_BARS), result = rows) {
    const s = spec();
    return (
      s.createTooltipDataSource as (p: unknown) => {
        name: string;
        calcParamsText: string;
        features: unknown[];
        legends: Array<{ title: string; value: string }>;
      }
    )({
      chart: { getDataList: () => rows },
      indicator: { result },
      crosshair: index === undefined ? {} : { dataIndex: index },
    });
  }

  it("行名写「平均K线」，四价四格，值保留两位", () => {
    const data = legends(1);
    expect(data.name).toBe(HEIKIN_ASHI_SHORT_NAME);
    expect(data.calcParamsText).toBe("");
    expect(data.features).toEqual([]);
    expect(data.legends.map((l) => l.title)).toEqual(["开: ", "高: ", "低: ", "收: "]);
    expect(data.legends.map((l) => l.value)).toEqual(["15.00", "15.00", "1.00", "1.50"]);
  });

  it("没有十字光标时读最后一根；越界或 na 读「-」而不是编一个数", () => {
    expect(legends(undefined).legends.map((l) => l.value)).toEqual(["15.00", "15.00", "1.00", "1.50"]);
    const na = legends(0, [{ open: 1, high: 2, low: 0.5 }]);
    expect(na.legends.map((l) => l.value)).toEqual(["1.00", "2.00", "0.50", "-"]);
    expect(legends(99).legends.map((l) => l.value)).toEqual(["-", "-", "-", "-"]);
  });

  it("result 落后 dataList 一格：缺省光标读的是 result 自己的末根，不是过界的四个「-」", () => {
    // 图上「光标离开」那一格读的是最后一根的 HA 四价，而最后一份算好的四价只存在于
    // `indicator.result` 里；按 `chart.getDataList().length - 1` 数下标，是在拿一条数组的
    // 长度去索引另一条更新时刻不同的数组——落后那一帧正好数过界，四格全读「-」，
    // 而 result[0] 明明有数。判据是这两条长度被拆开时读到谁。
    const all = heikinAshi(GAP_BARS);
    const lagged = all.slice(0, 1);
    expect(all).toHaveLength(2);
    expect(lagged).toHaveLength(1);
    // 第 0 行 = {open:15, high:20, low:10, close:15}（GAP_BARS 第一根 (10,20,10,20)）。
    expect(legends(undefined, all, lagged).legends.map((l) => l.value)).toEqual(["15.00", "20.00", "10.00", "15.00"]);
    // 有光标那一路不跟着动：下标照 cursor 走，那根还没算出来就读「-」。
    // 这一句钉的是「别把修复顺手扩到显式下标上」——给 `index` 也来一次 clamp 就当场红。
    expect(legends(1, all, lagged).legends.map((l) => l.value)).toEqual(["-", "-", "-", "-"]);
  });
});

describe("九色与谓词与偏好", () => {
  it("CANDLE_HIDDEN 恰好九个键，全是 transparent，不含 compareRule/type", () => {
    expect(Object.keys(CANDLE_HIDDEN)).toHaveLength(9);
    for (const v of Object.values(CANDLE_HIDDEN)) expect(v).toBe("transparent");
    expect(CANDLE_HIDDEN).not.toHaveProperty("type");
    expect(CANDLE_HIDDEN).not.toHaveProperty("compareRule");
    expect(Object.keys(CANDLE_HIDDEN).sort()).toEqual(
      [
        "downBorderColor",
        "downColor",
        "downWickColor",
        "noChangeBorderColor",
        "noChangeColor",
        "noChangeWickColor",
        "upBorderColor",
        "upColor",
        "upWickColor",
      ].sort(),
    );
  });

  it("heikinAshiActive：分时压掉 HA，其余三种组合按开关", () => {
    expect(heikinAshiActive(false, false)).toBe(false);
    expect(heikinAshiActive(true, false)).toBe(true);
    expect(heikinAshiActive(false, true)).toBe(false);
    expect(heikinAshiActive(true, true)).toBe(false);
  });

  it("默认关；开＝落 \"1\"；再关＝删键（未偏离默认不落盘）", () => {
    expect(loadHeikinAshi()).toBe(false);
    saveHeikinAshi(true);
    expect(localStorage.getItem(HEIKIN_ASHI_PREFS_KEY)).toBe("1");
    expect(loadHeikinAshi()).toBe(true);
    saveHeikinAshi(false);
    expect(localStorage.getItem(HEIKIN_ASHI_PREFS_KEY)).toBeNull();
    // 手改的垃圾值读回默认，不抛。
    localStorage.setItem(HEIKIN_ASHI_PREFS_KEY, "yes");
    expect(loadHeikinAshi()).toBe(false);
  });
});
