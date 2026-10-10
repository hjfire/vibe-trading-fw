import { beforeEach, describe, expect, it, vi } from "vitest";

// 同 `vpvrChart.test.ts` 的理由：`registerIndicator` 改的是库的全局表，桩掉它既不让真库
// 起来，又能把注册对象抓下来逐键判。
const registered: Array<Record<string, unknown>> = [];
vi.mock("klinecharts", () => ({
  registerIndicator: (spec: Record<string, unknown>) => registered.push(spec),
}));

import {
  COMPARE_AXIS_ID,
  COMPARE_BARS,
  COMPARE_FIGURE_KEY,
  COMPARE_FIGURE_TITLE,
  COMPARE_PREFS_KEY,
  SYMBOL_COMPARE_NAME,
  SYMBOL_COMPARE_SHORT_NAME,
  compareActive,
  compareKey,
  compareRows,
  ensureCompareIndicator,
  getCompareSeries,
  clearCompareSeries,
  loadCompare,
  saveCompare,
  setActiveCompareKey,
  setCompareSeries,
} from "../symbolCompareChart";
import type { CompareBar } from "../symbolCompare";

const D = (i: number): number => 1_700_000_000_000 + i * 86_400_000;
const bar = (i: number, close: number): CompareBar => ({ timestamp: D(i), close });

/**
 * 调用点自足（照第⑤片）：`registered` 是 `vi.mock` 里的模块级数组，用例之间不重置，
 * 谁先跑谁注册。让 `spec()` 自己走一遍幂等守卫，「上一条测试有没有先跑」就不是判据的一部分。
 */
function spec(): Record<string, unknown> {
  ensureCompareIndicator();
  expect(registered).toHaveLength(1);
  return registered[0];
}

beforeEach(() => {
  localStorage.clear();
  clearCompareSeries();
  setActiveCompareKey("");
});

describe("常量与偏好键", () => {
  it("七枚常量逐字钉（它们是页面、测试与库三方共用的唯一权威）", () => {
    expect(SYMBOL_COMPARE_NAME).toBe("SYMBOL_COMPARE");
    expect(SYMBOL_COMPARE_SHORT_NAME).toBe("对比");
    expect(COMPARE_AXIS_ID).toBe("pro-chart-compare-y");
    expect(COMPARE_FIGURE_KEY).toBe("cmp");
    expect(COMPARE_FIGURE_TITLE).toBe("对比收盘");
    expect(COMPARE_PREFS_KEY).toBe("pro-chart.compare.v1");
    expect(COMPARE_BARS).toBe(2000);
  });

  it("compareKey 将标的与周期拼成一个键（键含周期不含主标的）", () => {
    expect(compareKey("600036.SH", "1D")).toBe("600036.SH|1D");
  });

  it("loadCompare 缺键读空串，存的串原样读回（值就是已应用标的）", () => {
    expect(loadCompare()).toBe("");
    localStorage.setItem(COMPARE_PREFS_KEY, "600036.SH");
    expect(loadCompare()).toBe("600036.SH");
  });

  it("saveCompare(\"\") 删键而不是写空串（未偏离默认不落盘）", () => {
    saveCompare("600036.SH");
    expect(localStorage.getItem(COMPARE_PREFS_KEY)).toBe("600036.SH");
    saveCompare("");
    expect(localStorage.getItem(COMPARE_PREFS_KEY)).toBeNull();
  });

  it("storage 被禁时读成空串、写时不抛（两个 catch 分支各有输入）", () => {
    // idiom 照 `vpvrChart.test.ts` 里那两条（`vi.spyOn(Storage.prototype, …)`），
    // 收尾靠 vitest 配置里的 `restoreMocks: true`，不手写 finally。
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(loadCompare()).toBe("");
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(() => saveCompare("600036.SH")).not.toThrow();
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new DOMException("blocked", "SecurityError");
    });
    expect(() => saveCompare("")).not.toThrow();
  });
});

describe("视图谓词", () => {
  it("compareActive 的八行真值表：分时与未就绪都能单独压掉", () => {
    expect(compareActive(true, false, true)).toBe(true);
    expect(compareActive(true, false, false)).toBe(false);
    expect(compareActive(true, true, true)).toBe(false);
    expect(compareActive(true, true, false)).toBe(false);
    expect(compareActive(false, false, true)).toBe(false);
    expect(compareActive(false, false, false)).toBe(false);
    expect(compareActive(false, true, true)).toBe(false);
    expect(compareActive(false, true, false)).toBe(false);
  });
});

describe("store 与行形状", () => {
  it("未知键交出空数组（不是 undefined——calc 那一路要直接 .filter/.map）", () => {
    expect(getCompareSeries("NOPE|1D")).toEqual([]);
  });

  it("clearCompareSeries 把桶清空", () => {
    setCompareSeries("600036.SH|1D", [bar(0, 10)]);
    expect(getCompareSeries("600036.SH|1D")).toEqual([{ timestamp: D(0), close: 10 }]);
    clearCompareSeries();
    expect(getCompareSeries("600036.SH|1D")).toEqual([]);
  });

  it("compareRows 行数恒等于主图长度，缺口是 null 不是 0", () => {
    const rows = compareRows([D(0), D(1), D(2)], [bar(1, 7)]);
    expect(rows).toHaveLength(3);
    expect(rows).toEqual([{ cmp: null }, { cmp: 7 }, { cmp: 7 }]);
  });
});

describe("注册守卫与声明", () => {
  it("重复调用只注册一次", () => {
    ensureCompareIndicator();
    const after = registered.length;
    ensureCompareIndicator();
    ensureCompareIndicator();
    expect(registered).toHaveLength(after);
  });

  it("figures 恰一条且 `type` 逐字是 line（§十·① 那根唯一的牙）", () => {
    const s = spec();
    const figures = s.figures as Array<Record<string, unknown>>;
    expect(figures).toHaveLength(1);
    expect(figures[0].key).toBe(COMPARE_FIGURE_KEY);
    expect(figures[0].title).toBe(COMPARE_FIGURE_TITLE);
    // `prepareIndicatorFigures` 用 `isValid(figure.type)` 决定这条 figure 进不进渲染清单
    // （`index.esm.js:3128`）⇒ 省略 `type` 会得到一条**静默不画**的线，而且图例行也一起没了，
    // 这种失效在 jsdom 与活体像素上都读不出来，只能钉声明。
    expect(figures[0].type).toBe("line");
    // 不写 `styles`：本片零样式键（Global Constraints），指标样式桶那一格由库的默认值管。
    expect("styles" in (figures[0] as Record<string, unknown>)).toBe(false);
  });

  it("其余声明逐格钉，且不声明 draw／tooltip／轴", () => {
    const s = spec();
    expect(s.name).toBe(SYMBOL_COMPARE_NAME);
    expect(s.shortName).toBe(SYMBOL_COMPARE_SHORT_NAME);
    expect(s.series).toBe("price");
    expect(s.precision).toBe(2);
    expect(s.shouldOhlc).toBe(false);
    // 图例走库自己的 figures 通道（`index.esm.js:7272-7285`，`isString(figure.title)` 才 push），
    // 自己写 draw／createTooltipDataSource 就是第二条权威。
    expect("draw" in s).toBe(false);
    expect("createTooltipDataSource" in s).toBe(false);
    // 轴归属**只能在创建时定**：注册面 `IndicatorTemplate` 把 `paneId`/`yAxisId` Omit 掉了
    // （`index.d.ts:870`）。这一格是「别顺手在注册里写轴」的门。
    expect("yAxisId" in s).toBe(false);
    expect("paneId" in s).toBe(false);
    // 这两格与上面两格不同：`IndicatorTemplate` 只 Omit 了 `result|paneId|yAxisId`
    // （`index.d.ts:870`），`styles`（`:844`）与 `calcParams` **没被 Omit** ⇒ 在注册里写样式
    // 或写参数能过 `tsc`。Global Constraints 那两条（不写任何样式键／`calc` 不走 `calcParams`）
    // 只有在这里落针才是机器门，否则就只是注释。
    expect("styles" in s).toBe(false);
    expect("calcParams" in s).toBe(false);
    expect(typeof s.calc).toBe("function");
  });

  it("calc 读 activeKey 那一条序列，行数与主图对齐", () => {
    ensureCompareIndicator();
    const key = compareKey("600036.SH", "1D");
    setCompareSeries(key, [bar(1, 10), bar(3, 12)]);
    setActiveCompareKey(key);
    const calc = spec().calc as (d: Array<{ timestamp: number }>) => Array<Record<string, unknown>>;
    const dataList = [0, 1, 2, 3, 4].map((i) => ({ timestamp: D(i) }));
    expect(calc(dataList)).toEqual([
      { cmp: null },
      { cmp: 10 },
      { cmp: 10 },
      { cmp: 12 },
      { cmp: 12 },
    ]);
    // 阳性对照（本仓登记的假绿第一种）：换了空序列后同一条 calc 必须交出全 null，
    // 否则「calc 真读了 store」这件事没被证明——写死返回值也能过上一条。
    setActiveCompareKey(compareKey("BTC-USDT", "1D"));
    expect(calc(dataList)).toEqual([
      { cmp: null },
      { cmp: null },
      { cmp: null },
      { cmp: null },
      { cmp: null },
    ]);
  });

  it("分页加根后同一份 store 重新算出更长的行（§四 那条「必须算在 calc 里」）", () => {
    ensureCompareIndicator();
    const key = compareKey("600036.SH", "1D");
    setCompareSeries(key, [bar(1, 10)]);
    setActiveCompareKey(key);
    const calc = spec().calc as (d: Array<{ timestamp: number }>) => Array<Record<string, unknown>>;
    const three = calc([0, 1, 2].map((i) => ({ timestamp: D(i) })));
    const five = calc([0, 1, 2, 3, 4].map((i) => ({ timestamp: D(i) })));
    expect(three).toHaveLength(3);
    expect(five).toHaveLength(5);
    expect(five.slice(0, 3)).toEqual(three);
  });
});
