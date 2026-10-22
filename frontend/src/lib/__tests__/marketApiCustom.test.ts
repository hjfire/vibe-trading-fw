import { describe, expect, it } from "vitest";

import {
  INTERVAL_MS,
  RESOLUTION_BY_INTERVAL,
  intervalMsOf,
  intervalToPeriod,
  isBuiltinInterval,
  isCalendarInterval,
  normalizeInterval,
  periodToInterval,
  resolutionOf,
  type IntervalKey,
} from "../marketApi";
import { intervalAllowed } from "../chartView";

const BUILTIN = ["1m", "5m", "15m", "30m", "60m", "1D", "1W", "1M"] as IntervalKey[];

describe("内置八档在加宽后逐字节不变", () => {
  it("resolutionOf 就是那张旧表", () => {
    for (const key of BUILTIN) expect(resolutionOf(key), key).toBe(RESOLUTION_BY_INTERVAL[key]);
  });
  it("intervalMsOf 就是那张旧表", () => {
    for (const key of BUILTIN) expect(intervalMsOf(key), key).toBe(INTERVAL_MS[key]);
  });
  it("intervalToPeriod 与 periodToInterval 的往返仍成立", () => {
    for (const key of BUILTIN) expect(periodToInterval(intervalToPeriod(key)), key).toBe(key);
  });
});

describe("自定义档走同一条出入口", () => {
  it("自定义串的 resolution 就是它的 market 拼写（服务端 parse_resolution 认它）", () => {
    expect(resolutionOf("120m")).toBe("120m");
    expect(resolutionOf("2D")).toBe("2D");
    expect(resolutionOf("3W")).toBe("3W");
  });
  it("Period 带 span——图上的时间轴标签跟真实倍数一致", () => {
    expect(intervalToPeriod("120m")).toEqual({ type: "minute", span: 120 });
    expect(intervalToPeriod("2D")).toEqual({ type: "day", span: 2 });
    expect(intervalToPeriod("3M")).toEqual({ type: "month", span: 3 });
  });
  it("periodToInterval 反向造串：minute span 不在表里就拼回去，日历按倍数拼", () => {
    expect(periodToInterval({ type: "minute", span: 120 })).toBe("120m");
    expect(periodToInterval({ type: "day", span: 2 })).toBe("2D");
    expect(periodToInterval({ type: "week", span: 2 })).toBe("2W");
    // 这三枚既有针的形状不许被本片改掉（marketApiPeriods.test.ts 里也各钉一遍）
    expect(periodToInterval({ type: "year", span: 1 })).toBe("1D");
    expect(periodToInterval({ type: "second", span: 30 })).toBe("1D");
    expect(periodToInterval({ type: "hour", span: 4 })).toBe("1D");
  });
  it("月线与月倍数都不落回分钟道——大小写是这条线的唯一分界", () => {
    expect(intervalToPeriod("1M")).toEqual({ type: "month", span: 1 });
    expect(intervalToPeriod("2M")).toEqual({ type: "month", span: 2 });
    expect(intervalToPeriod("2m")).toEqual({ type: "minute", span: 2 });
  });
});

describe("车道判定与坏串", () => {
  it("isCalendarInterval 认日历道自定义串（它们不需要分钟源）", () => {
    expect(isCalendarInterval("2D")).toBe(true);
    expect(isCalendarInterval("3W")).toBe(true);
    expect(isCalendarInterval("12M")).toBe(true);
    expect(isCalendarInterval("120m")).toBe(false);
    // 坏串不许自称日历道（2026-10-22 预检加：原写法 `parseSpec(key)?.unit !== "m"` 对
    // null 读成 undefined !== "m" ＝ true，这两枚就是拦它的面包屑，缺了它 Step 2 的改文没有针）
    expect(isCalendarInterval("2d"), "大小写错了就是坏串").toBe(false);
    expect(isCalendarInterval(""), "空串").toBe(false);
    for (const key of BUILTIN) expect(isCalendarInterval(key), key).toBe(key === "1D" || key === "1W" || key === "1M");
  });
  it("BTC 这类没有分钟源的标的：日倍数可答、分钟倍数不可答", () => {
    expect(intervalAllowed("BTCUSDT", "2D")).toBe(true);
    expect(intervalAllowed("BTCUSDT", "120m")).toBe(false);
    // 2026-10-22 执行期改口：原写 `.SH000300` 是一枚拼法错的样本——`canMinuteBars` 的逐字
    // 正则 `/\.(SH|SZ|HK|US)$/i` 只认**后缀**，本仓指数拼法是 `000300.SH`，前缀拼法判 false，
    // 那枚针在这条线上结构上不可能为真。换成仓内既有测试用的 A 股代码，断的仍是同一件事。
    expect(intervalAllowed("600519.SH", "120m")).toBe(true);
  });
  it("normalizeInterval：内置原样、自定义原样、坏串退 1D，绝不静默接受", () => {
    expect(normalizeInterval("1D")).toBe("1D");
    expect(normalizeInterval("2W")).toBe("2W");
    for (const bad of ["", "2d", "1tick", "0m", "2.5m", null, undefined, 42, {}]) {
      expect(normalizeInterval(bad), String(bad)).toBe("1D");
    }
  });
  it("isBuiltinInterval 只对八档为真", () => {
    for (const key of BUILTIN) expect(isBuiltinInterval(key), key).toBe(true);
    expect(isBuiltinInterval("2D")).toBe(false);
    expect(isBuiltinInterval("")).toBe(false);
  });
});
