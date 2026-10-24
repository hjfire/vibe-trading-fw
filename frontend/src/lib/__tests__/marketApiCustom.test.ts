import { describe, expect, it } from "vitest";

import {
  INTERVALS,
  INTERVAL_MS,
  RESOLUTION_BY_INTERVAL,
  intervalMsOf,
  intervalToPeriod,
  isBuiltinInterval,
  isCalendarInterval,
  normalizeInterval,
  periodToInterval,
  resolutionOf,
} from "../marketApi";
import { intervalAllowed } from "../chartView";
import { isCustomSpec } from "../customInterval";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// 八枚键从 `INTERVALS` 派生，不在测试里抄第二份：抄的那份漂了不红，因为它只给自己出题
// （两张 `Record<IntervalKey, …>` 表由编译器钉死，报告 §4 那条合表裁定附 `tsc` 读数）。
const BUILTIN = INTERVALS.map((item) => item.key);

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
  it("intervalMsOf 对自定义串真的在按倍数算——既不查那八枚的表，也不悄悄退成 1D", () => {
    // 右边是手算的字面量：拿 `specMs("120m")` 当期望值等于让被测函数自己给自己出题。
    expect(intervalMsOf("120m")).toBe(120 * 60_000);
    expect(intervalMsOf("2D")).toBe(2 * 86_400_000);
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
    // 越界串：文法合法但超出本仓自己的数值边界（`1..999`、日／周／月倍数上限），
    // 对话框那把尺拒收，URL／会话这道门也必须拒收——放过去就是一条空图。
    expect(normalizeInterval("9999m"), "9999m 越界").toBe("1D");
    expect(normalizeInterval("5000D"), "5000D 越界").toBe("1D");
    for (const bad of ["", "2d", "1tick", "0m", "2.5m", null, undefined, 42, {}]) {
      expect(normalizeInterval(bad), String(bad)).toBe("1D");
    }
  });
  it("坏串在两枚退化出口落在文档承诺的档：1D 的跨度与 day/1 的 Period", () => {
    // `2d` 的错只在大小写：文法认的是 m/D/W/M。它两把 helper 都走退化出口，
    // 这两枚是 `marketApi.ts` 里那两枝（`?? INTERVAL_MS["1D"]`／`return { type: "day", span: 1 }`）唯一的针。
    expect(intervalMsOf("2d")).toBe(INTERVAL_MS["1D"]);
    expect(intervalToPeriod("2d")).toEqual({ type: "day", span: 1 });
  });
  it("isBuiltinInterval 只对八档为真", () => {
    for (const key of BUILTIN) expect(isBuiltinInterval(key), key).toBe(true);
    expect(isBuiltinInterval("2D")).toBe(false);
    expect(isBuiltinInterval("")).toBe(false);
  });
});

describe("加宽留下的两处形状（阶段 C 归口：针面补形组）", () => {
  it("periodToInterval 的分钟侧只有一条 `??` 出口，它不设门：非整数 span 原样铸进串里", () => {
    // 归口点名的形状：`map[period.span] ?? `${period.span}m`` 对 `span: 0`／`span: NaN`
    // 不拒绝、只拼字，于是铸出词表外的串。本页走不到它——页面自己的 Period 全部出自
    // `intervalToPeriod`（span 恒为正整数），其余由库给。所以这两枚钉的是**当下真的这么拼**
    // （哪天加门，先红在这里），不是「应该这么拼」；那枚 `??` 出口此前一枚针也没有。
    expect(periodToInterval({ type: "minute", span: 0 })).toBe("0m");
    expect(periodToInterval({ type: "minute", span: Number.NaN })).toBe("NaNm");
    // 渗漏出去的串进不了任何一道门：既不是内置八档，也不是合法自定义档，所以它冒充不了档位。
    for (const leaked of ["0m", "NaNm"]) {
      expect(isBuiltinInterval(leaked), leaked).toBe(false);
      expect(isCustomSpec(leaked), leaked).toBe(false);
    }
  });

  it("chartView.ts 里 TV-CI-11 那句红线仍是一句、仍拆在同一处的两行注释里", () => {
    // 逐字针**不许**写成单行 `toContain`：那句话被注释按行折断，单行断言只看得见半句，
    // 把后半句整行删掉都不会红。所以这里先按逐字取回第一行、再断第二行**紧跟**在它下面，
    // 最后把两行拼回去断那句完整的话。
    const src = readFileSync(resolve(process.cwd(), "src/lib/chartView.ts"), "utf8").replace(/\r\n/g, "\n");
    const lines = src.split("\n");
    const head = " * 自定义档按它的单位落车道：`m` 要分钟源，`D`/`W`/`M` 不需要——这条判据的来源是";
    const tail = " * `interval_spec` 的折叠基档，不是任何 disabled 标记。";
    const at = lines.indexOf(head);
    expect(at, "红线第一行逐字仍在 `chartView.ts`").toBeGreaterThanOrEqual(0);
    expect(lines[at + 1], "第二行必须紧跟第一行：句子住在两行里，挪开或删掉都算断").toBe(tail);
    expect(`${head}\n${tail}`).toContain("不是任何 disabled 标记。");
  });
});
