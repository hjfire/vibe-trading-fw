import { beforeEach, describe, expect, it, vi } from "vitest";

// 库的 `registerIndicator` 改的是全局表；桩掉它，既不让真库起来，又能把注册对象抓下来逐键判。
// 形状照 `lib/__tests__/heikinAshiChart.test.ts:6-8`（那行又照 `timeShare.test.ts:5-8`）。
const registered: Array<Record<string, unknown>> = [];
vi.mock("klinecharts", () => ({
  registerIndicator: (spec: Record<string, unknown>) => registered.push(spec),
}));

import {
  ensureVpvrIndicator,
  profileOfChart,
  saveVpvr,
  loadVpvr,
  vpvrActive,
  VPVR_COLOR_BASE,
  VPVR_COLOR_POC,
  VPVR_COLOR_VALUE_AREA,
  VPVR_MAX_WIDTH_RATIO,
  VPVR_NAME,
  VPVR_PREFS_KEY,
  VPVR_SHORT_NAME,
} from "../vpvrChart";
import { VPVR_ROWS } from "../volumeProfile";

type Rect = { x: number; y: number; w: number; h: number; color: unknown };

/**
 * 样本域 `[100, 200]` 配出厂 100 档 ⇒ 档宽恰为 **1 个价格单位**，期望矩形可以逐格写死，
 * 不需要给生产函数开测试旋钮（spec §六：`profileOfChart` 不带 `rows`）。
 *
 * 域靠**最后那根零量根**撑开：三根有量的根只占域中一小段，把它们自己的极值当域就得到
 * 3 个价格单位配 100 档（档宽 0.03），期望值立刻不可手算。零量根是真实形状——loader 缺
 * `volume` 列时后端整列补 `0.0`（`agent/src/api/market_routes.py:175-176`），而它在摊派
 * 循环里被 `volume === 0` 那一支跳过，不进任何档，所以 `totalVolume` 仍是 220。
 *
 * 摊派结果（Task 1 的同一公式）：第 49 档 60、第 50 档 100、第 51 档 60，其余 0。
 * `totalVolume = 220`、`pocIndex = 50`；价值区 target = 154，acc 从 100 起，
 * up(60) 与 down(60) **并列取上** ⇒ `{lowIndex: 50, highIndex: 51}`。
 * ⇒ POC 档正好是价值区的**下端点**，颜色归属那条针因此有杀伤力（不构造就会归错）。
 */
const BARS = [
  { timestamp: 1_700_000_000_000, low: 149, high: 150, volume: 60 },
  { timestamp: 1_700_086_400_000, low: 150, high: 151, volume: 100 },
  { timestamp: 1_700_172_800_000, low: 151, high: 152, volume: 60 },
  // 域锚根：零量、跨 [100, 200]，只负责把档宽钉成 1 个价格单位，不贡献任何档量。
  { timestamp: 1_700_259_200_000, low: 100, high: 200, volume: 0 },
];

function spec(): Record<string, unknown> {
  // 调用点自足：`registered` 是 `vi.mock` 里的模块级数组，用例之间不重置，谁先跑谁注册。
  // 让它自己走一遍幂等守卫（`ensureVpvrIndicator` 靠模块布尔挡重复注册），
  // 于是「上一条测试有没有先跑」不再是判据的一部分。
  ensureVpvrIndicator();
  expect(registered).toHaveLength(1);
  return registered[0];
}

/**
 * 假 chart **只交 `getDataList`／`getVisibleRange` 这两格**：替身多给一个成员，
 * 就等于替实现者兜住它误读的那一格（本仓登记的替身失真第五种）。
 */
function chartFixture(list = BARS) {
  return {
    getDataList: () => list,
    getVisibleRange: () => ({ from: 0, to: list.length, realFrom: 0, realTo: list.length }),
  };
}

function drawFixture(list = BARS, toPixel = (p: number) => 300 - 2 * p, width = 200) {
  const rects: Rect[] = [];
  const ctx = {
    fillStyle: "",
    fillRect(x: number, y: number, w: number, h: number) {
      rects.push({ x, y, w, h, color: ctx.fillStyle });
    },
  };
  const out = (spec().draw as (p: unknown) => boolean)({
    ctx,
    bounding: { width, height: 100 },
    chart: chartFixture(list),
    yAxis: { convertToPixel: toPixel },
  });
  return { rects, out };
}

/**
 * `createRangeImp` 折叠体的六行镜像（`dist:984` ⇄ `:1045-1056`）：只把
 * `result[dataIndex][figure.key]` 里 `isNumber` 的值当价格。判「本指标声明能并进
 * 轴的价格集合是空集」。**判的是声明，不是库**——实地判据在 Task 6 的活体读数。
 */
function foldedPrices(
  figures: Array<{ key: string }>,
  result: Array<Record<string, unknown>>,
  len: number,
): number[] {
  const prices: number[] = [];
  for (let i = 0; i < len; i++) {
    const row = result[i];
    for (const figure of figures) {
      const value = row?.[figure.key];
      if (typeof value === "number") prices.push(value);
    }
  }
  return prices;
}

beforeEach(() => {
  localStorage.clear();
});

describe("注册守卫与声明", () => {
  it("重复调用只注册一次", () => {
    ensureVpvrIndicator();
    const after = registered.length;
    ensureVpvrIndicator();
    ensureVpvrIndicator();
    expect(registered).toHaveLength(after);
  });

  it("名字、两把钥匙、精度与 series 逐格钉", () => {
    ensureVpvrIndicator();
    const s = spec();
    expect(s.name).toBe(VPVR_NAME);
    expect(s.shortName).toBe(VPVR_SHORT_NAME);
    // 第一把钥匙：声明里没有 key 可折。
    expect(s.figures).toEqual([]);
    // 第二把钥匙：result 里根本没有行。返回 `[]` 而不是 `undefined`——库会把
    // `indicator.result` 当数组使。
    const calc = s.calc as (d: unknown[], i: unknown) => unknown[];
    expect(calc(BARS, {})).toEqual([]);
    expect(s.series).toBe("price");
    expect(s.precision).toBe(2);
    expect(s.shouldOhlc).toBe(false);
    // 不声明 zLevel：库的 `IndicatorImp` 构造器已给 0（`dist:3161`）。这一格同时是
    // 「别顺手加」的门——加了就改的是绘制次序，而本片没有任何需要改次序的东西。
    expect("zLevel" in s).toBe(false);
    expect(typeof s.draw).toBe("function");
    expect(typeof s.createTooltipDataSource).toBe("function");
  });

  it("两把钥匙合起来 ⇒ 能折进价格轴的集合是空集（镜像折叠）", () => {
    ensureVpvrIndicator();
    const s = spec();
    const figures = s.figures as Array<{ key: string }>;
    const result = (s.calc as (d: unknown[], i: unknown) => Array<Record<string, unknown>>)(BARS, {});
    expect(figuredPricesLengthGuard(figures, result, BARS.length)).toBe(0);
    // 阳性对照：镜像 helper 自己得是能红的。空集合断言配一个非空样本，否则
    // 「helper 写错 ⇒ 永远返回空数组」这条假绿会被当成通过（本仓登记的假绿第一种）。
    expect(foldedPrices([{ key: "volume" }], [{ volume: 5 }], 1)).toEqual([5]);
  });

  it("对外常量逐个钉字面量——参照点不从被测模块来", () => {
    // 别的用例拿导入的常量当期望值，改值这一类变异就两侧一起动、永远绿。
    // 这七格把「值」本身钉住：字面量写死在这里，参照点是档案（spec §六 的三枚色与键名）。
    expect(VPVR_NAME).toBe("VPVR");
    expect(VPVR_SHORT_NAME).toBe("量分布");
    expect(VPVR_PREFS_KEY).toBe("pro-chart.vpvr.v1");
    expect(VPVR_COLOR_BASE).toBe("rgba(66, 165, 245, 0.22)");
    expect(VPVR_COLOR_VALUE_AREA).toBe("rgba(66, 165, 245, 0.38)");
    expect(VPVR_COLOR_POC).toBe("rgba(255, 167, 38, 0.55)");
    expect(VPVR_MAX_WIDTH_RATIO).toBe(0.35);
  });
});

/** 把「空集」写成显式判据，而不是靠 `toEqual([])` 的形状蒙对。 */
function figuredPricesLengthGuard(
  figures: Array<{ key: string }>,
  result: Array<Record<string, unknown>>,
  len: number,
): number {
  return foldedPrices(figures, result, len).length;
}

describe("profileOfChart", () => {
  it("切的是可视区那一段，不是整个 dataList", () => {
    ensureVpvrIndicator();
    const list = [
      ...BARS,
      { timestamp: 9, low: 300, high: 320, volume: 900 },
      { timestamp: 10, low: 400, high: 410, volume: 900 },
    ];
    const chart = {
      getDataList: () => list,
      getVisibleRange: () => ({ from: 0, to: list.length, realFrom: 0, realTo: BARS.length }),
    };
    const p = profileOfChart(chart);
    // 域取在域里的 `[100, 200]`（含那根零量锚根），而不是被截掉的 `[300, 410]` 那两根；
    // `totalVolume` 220 同理——两根 900 量的根没进来。
    expect(p.spanHigh).toBe(200);
    expect(p.spanLow).toBe(100);
    expect(p.totalVolume).toBe(220);
  });

  it("`realFrom` 大于 0 时左边那几根不进切片（左边缘针）", () => {
    // 这条同时钉两个变异体，因为库里 `from` 与 `realFrom` 真的会分家
    // （`dist:13566`：右侧有留白时 `realFrom` 由 `_lastBarRightSideDiffBarCount` 另算）：
    // ① `const from = 0`（把左边缘焊死）——被 `realFrom > 0` 杀；
    // ② 解构读的是 `from` 那一格（写成 `const { from: realFrom } = …`）——被 `from ≠ realFrom` 杀。
    // 原有三条 fixture 的 `from` 与 `realFrom` 恒等（0/0、0/0、-8/-8），所以两者此前都过。
    // 不调 `ensureVpvrIndicator()`：`profileOfChart` 是直接导出的纯函数，不经过注册表。
    const dropped = [
      { timestamp: 0, low: 100, high: 110, volume: 500 },
      { timestamp: 1, low: 100, high: 110, volume: 500 },
    ];
    const list = [...dropped, ...BARS];
    const chart = {
      getDataList: () => list,
      getVisibleRange: () => ({ from: 0, to: list.length, realFrom: 2, realTo: list.length }),
    };
    const p = profileOfChart(chart);
    // 判据是 `totalVolume` 而不是极值：被掉的这两根价格落在 `[100, 110]`，本来就在
    // `BARS` 撑出的域 `[100, 200]` 之内 ⇒ 混进来 `spanLow`／`spanHigh` 察觉不到，
    // 只有总量从 220 变 1220。左边缘差一根也红（`BARS[0]` 带 60 量）。
    expect(p.totalVolume).toBe(220);
    expect(p.spanLow).toBe(100);
    expect(p.spanHigh).toBe(200);
  });

  it("`realTo` 越过数据长度时按长度截（右侧留白区有像素没有数据）", () => {
    const chart = {
      getDataList: () => BARS,
      getVisibleRange: () => ({ from: 0, to: 500, realFrom: 0, realTo: 500 }),
    };
    expect(profileOfChart(chart).totalVolume).toBe(220);
  });

  it("`realFrom` 为负时按 0 起", () => {
    const chart = {
      getDataList: () => BARS,
      getVisibleRange: () => ({ from: -8, to: 3, realFrom: -8, realTo: 3 }),
    };
    expect(profileOfChart(chart).totalVolume).toBe(220);
  });

  it("档数是出厂 100", () => {
    expect(profileOfChart(chartFixture()).rows).toHaveLength(VPVR_ROWS);
  });

  it("零量根进得来、摊不进任何档", () => {
    const chart = chartFixture([{ timestamp: 1, low: 100, high: 120, volume: 0 }]);
    expect(profileOfChart(chart).totalVolume).toBe(0);
  });
});

describe("vpvrDraw 几何", () => {
  it("三根非零档逐格相等：右锚、宽度比例、像素高度、颜色归属", () => {
    ensureVpvrIndicator();
    const { rects, out } = drawFixture();
    expect(out).toBe(true);
    // bounding.width=200 ⇒ maxLen=70；最大档（100）吃满 70，两根 60 各 42。
    // toPixel = 300-2p ⇒ 档宽 1 个价格单位 = 2px；y 取档的**上界**（价格越高像素越小）。
    expect(rects).toEqual([
      { x: 158, y: 0, w: 42, h: 2, color: VPVR_COLOR_BASE },
      { x: 130, y: -2, w: 70, h: 2, color: VPVR_COLOR_POC },
      { x: 158, y: -4, w: 42, h: 2, color: VPVR_COLOR_VALUE_AREA },
    ]);
  });

  it("POC 同时是价值区端点时读 POC 色（三枚色的优先级）", () => {
    // 上面那条 fixture 里 pocIndex=50 恰是 lowIndex=50 ⇒ 顺序若写成「先判价值区」
    // 这一档就会被涂成 VA 色，POC 那一格在视觉上消失。
    const { rects } = drawFixture();
    expect(rects[1].color).toBe(VPVR_COLOR_POC);
    expect(rects[1].x).toBe(130);
  });

  it("亚像素档高被 Math.max(1, …) 抬成 1 个像素", () => {
    // toPixel 比例 0.25 ⇒ 档宽 1 个价格单位 = 0.25px，不抬就看不见（末档/远缩那一路）。
    const { rects } = drawFixture(BARS, (p) => 100 - p * 0.25);
    expect(rects.map((r) => r.h)).toEqual([1, 1, 1]);
    expect(rects.map((r) => r.y)).toEqual([62.5, 62.25, 62]);
  });

  it("空可视区：返回 true 且一根都不画", () => {
    ensureVpvrIndicator();
    const { rects, out } = drawFixture([]);
    expect(out).toBe(true);
    expect(rects).toEqual([]);
  });

  it("全零量：返回 true 且一根都不画（`totalVolume` 为 0 不等于有形状）", () => {
    const { rects, out } = drawFixture([
      { timestamp: 1, low: 149, high: 150, volume: 0 },
      { timestamp: 2, low: 150, high: 151, volume: 0 },
    ]);
    expect(out).toBe(true);
    expect(rects).toEqual([]);
  });

  it("最大档恒等于 `bounding.width × 0.35`，换宽度就换比例", () => {
    // 同表达式逐位相等，不用绝对小数位容差（本仓口径）。左侧 `x` 是右锚的直接推论。
    const { rects } = drawFixture(BARS, (p) => 300 - 2 * p, 400);
    expect(rects[1].w).toBe(400 * VPVR_MAX_WIDTH_RATIO);
    expect(rects[1].x).toBe(400 - 400 * VPVR_MAX_WIDTH_RATIO);
  });
});

describe("vpvrTooltipDataSource", () => {
  function legend(list = BARS) {
    const ds = (spec().createTooltipDataSource as (p: unknown) => {
      name: string;
      calcParamsText: string;
      features: unknown[];
      legends: Array<{ title: string; value: string }>;
    })({ chart: chartFixture(list) });
    return ds;
  }

  it("三行 POC/VAH/VAL，读的是档界而不是档中点（POC 除外）", () => {
    ensureVpvrIndicator();
    const ds = legend();
    expect(ds.name).toBe(VPVR_SHORT_NAME);
    expect(ds.calcParamsText).toBe("");
    expect(ds.features).toEqual([]);
    expect(ds.legends).toEqual([
      { title: "POC: ", value: "150.50" }, // rows[50] = [150,151] 的中点
      { title: "VAH: ", value: "152.00" }, // rows[highIndex=51].high
      { title: "VAL: ", value: "150.00" }, // rows[lowIndex=50].low
    ]);
  });

  it("totalVolume === 0 ⇒ 三格都读 \"-\"，不编一个数出来", () => {
    ensureVpvrIndicator();
    const ds = legend([{ timestamp: 1, low: 100, high: 101, volume: 0 }]);
    expect(ds.legends.map((l) => l.value)).toEqual(["-", "-", "-"]);
  });

  it("空可视区同样读 \"-\"", () => {
    ensureVpvrIndicator();
    expect(legend([]).legends.map((l) => l.value)).toEqual(["-", "-", "-"]);
  });
});

describe("偏好与互斥", () => {
  it("`vpvrActive` 真值表四格：分时把开关压掉", () => {
    expect(vpvrActive(true, false)).toBe(true);
    expect(vpvrActive(true, true)).toBe(false);
    expect(vpvrActive(false, false)).toBe(false);
    expect(vpvrActive(false, true)).toBe(false);
  });

  it("`loadVpvr` 只把 \"1\" 读成开，垃圾值读成关", () => {
    expect(loadVpvr()).toBe(false);
    localStorage.setItem(VPVR_PREFS_KEY, "0");
    expect(loadVpvr()).toBe(false);
    localStorage.setItem(VPVR_PREFS_KEY, "yes");
    expect(loadVpvr()).toBe(false);
    localStorage.setItem(VPVR_PREFS_KEY, "1");
    expect(loadVpvr()).toBe(true);
  });

  it("storage 被禁时读成关、写时不抛（两个 catch 分支各有输入）", () => {
    // 隐私模式／第三方 cookie 被挡时 `localStorage` 的存取直接抛。idiom 照
    // `apiAuth.test.ts` 里那两条（`vi.spyOn(Storage.prototype, …)`），
    // 收尾靠 vitest 配置里的 `restoreMocks: true`，不手写 finally。
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(loadVpvr()).toBe(false);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(() => saveVpvr(true)).not.toThrow();
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(() => saveVpvr(false)).not.toThrow();
  });

  it("`saveVpvr(false)` 删键而不是写 \"0\"（未偏离默认不落盘）", () => {
    saveVpvr(true);
    expect(localStorage.getItem(VPVR_PREFS_KEY)).toBe("1");
    saveVpvr(false);
    expect(localStorage.getItem(VPVR_PREFS_KEY)).toBeNull();
  });
});
