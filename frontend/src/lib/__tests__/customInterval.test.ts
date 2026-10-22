import { describe, expect, it } from "vitest";

import {
  BUILTIN_SPECS,
  CUSTOM_UNITS,
  draftToSpec,
  isCustomSpec,
  parseSpec,
  specLabel,
  specMs,
  specPeriodShape,
  validateDraft,
} from "../customInterval";
import type { IntervalUnit, SpecUnit } from "../customInterval";
import { INTERVALS } from "../marketApi";

const AGREED_OK = ["5m", "7m", "120m", "240m", "999m", "2D", "3W", "4M", "12M", "1m", "1D", "1W", "1M"];
const AGREED_REJECT = ["", " ", "abc", "m", "0m", "-5m", "2.5m", "1d", "120X", "1S", "1tick", "2h", "M", "D"];
const FRONTEND_ONLY_REJECT = ["1000m", "1441m", "367D", "400W", "500M"];
const BUILTIN = ["1m", "5m", "15m", "30m", "60m", "1D", "1W", "1M"];

/** 把已解析的串还原成对话框持有的草案（`m` 若是 60 的倍数优先报小时）。 */
const parseSpecToDraft = (p: { unit: SpecUnit; n: number }): { unit: IntervalUnit; n: number } =>
  p.unit === "m" && p.n % 60 === 0 && p.n >= 60 ? { unit: "hour", n: p.n / 60 } : { unit: unitOfParsed(p), n: p.n };
const unitOfParsed = (p: { unit: string }): IntervalUnit =>
  p.unit === "m" ? "minute" : p.unit === "D" ? "day" : p.unit === "W" ? "week" : "month";

describe("前后端文法对账（Python 侧同名样本表：agent/tests/test_interval_spec_frontend_align.py）", () => {
  it("文法合法的串，前端也认，并且能原样拼回去", () => {
    for (const text of AGREED_OK) {
      const parsed = parseSpec(text);
      expect(parsed, text).not.toBeNull();
      expect(draftToSpec(parseSpecToDraft(parsed!)), text).toBe(text);
    }
  });
  it("文法非法的串一律不认，且不抛", () => {
    for (const text of AGREED_REJECT) expect(parseSpec(text), text).toBeNull();
  });
  it("服务端收、前端越界拒：validateDraft 给原因，parseSpec 照旧收", () => {
    for (const text of FRONTEND_ONLY_REJECT) {
      const parsed = parseSpec(text);
      expect(parsed, text).not.toBeNull();
      const verdict = validateDraft({ unit: unitOfParsed(parsed!), n: parsed!.n });
      expect(verdict.ok, text).toBe(false);
      if (!verdict.ok) expect(verdict.reason.length, text).toBeGreaterThan(0);
    }
  });
});

describe("单位表与标签", () => {
  it("五档，顺序固定，区间档家族没有取数面所以不在这里（2026-10-22 评审改口：原名写了对面的档位名，违全局约束）", () => {
    expect(CUSTOM_UNITS.map((u) => u.unit)).toEqual(["minute", "hour", "day", "week", "month"]);
    expect(CUSTOM_UNITS.map((u) => u.label)).toEqual(["分钟", "小时", "日", "周", "月"]);
  });
  it("小时编译成分钟，不产 `2H`——服务端折叠文法只认 m/D/W/M", () => {
    expect(draftToSpec({ unit: "hour", n: 2 })).toBe("120m");
    expect(draftToSpec({ unit: "hour", n: 1 })).toBe("60m");
    expect(draftToSpec({ unit: "minute", n: 7 })).toBe("7m");
    expect(draftToSpec({ unit: "day", n: 2 })).toBe("2D");
    expect(draftToSpec({ unit: "week", n: 2 })).toBe("2W");
    expect(draftToSpec({ unit: "month", n: 3 })).toBe("3M");
  });
  it("标签：满小时报小时，其余报分钟；日历一律「N单位」", () => {
    expect(specLabel("120m")).toBe("2小时");
    expect(specLabel("240m")).toBe("4小时");
    expect(specLabel("7m")).toBe("7分");
    expect(specLabel("90m")).toBe("90分");
    expect(specLabel("2D")).toBe("2日");
    expect(specLabel("3W")).toBe("3周");
    expect(specLabel("12M")).toBe("12月");
    expect(specLabel("2h")).toBeNull();
  });
  it("与内置八档的标签一个都不撞", () => {
    const builtinLabels = ["1分", "5分", "15分", "30分", "60分", "日线", "周线", "月线"];
    for (const text of ["120m", "7m", "2D", "3W", "12M"]) {
      expect(builtinLabels, text).not.toContain(specLabel(text));
    }
  });
  it("内置八档表与 `marketApi.ts` 的 `INTERVALS` 键表同集合：谁漂了这枚就红", () => {
    expect([...BUILTIN_SPECS].sort()).toEqual(INTERVALS.map((item) => item.key).sort());
  });
});

describe("换算", () => {
  it("ms：分钟道 60_000 起步，日 86_400_000，周 604_800_000，月沿用本仓 30 日口径", () => {
    expect(specMs("7m")).toBe(7 * 60_000);
    expect(specMs("120m")).toBe(120 * 60_000);
    expect(specMs("2D")).toBe(2 * 86_400_000);
    expect(specMs("3W")).toBe(3 * 604_800_000);
    expect(specMs("2M")).toBe(2 * 30 * 86_400_000);
    expect(specMs("1tick")).toBeNull();
  });
  it("Period 形状：分钟进 minute 道，日历各回各家，span 就是倍数", () => {
    expect(specPeriodShape("120m")).toEqual({ type: "minute", span: 120 });
    expect(specPeriodShape("2D")).toEqual({ type: "day", span: 2 });
    expect(specPeriodShape("2W")).toEqual({ type: "week", span: 2 });
    expect(specPeriodShape("3M")).toEqual({ type: "month", span: 3 });
    expect(specPeriodShape("")).toBeNull();
  });
  it("isCustomSpec：文法合法、不是内置八档、且折算后的跨度不越界才算自定义档", () => {
    expect(isCustomSpec("120m")).toBe(true);
    expect(isCustomSpec("2D")).toBe(true);
    for (const text of BUILTIN) expect(isCustomSpec(text), text).toBe(false);
    expect(isCustomSpec("0m")).toBe(false);
    expect(isCustomSpec("2h")).toBe(false);
  });
  it("isCustomSpec 也管本仓自己的数值边界：越界的合法文法串不算合法自定义档", () => {
    // 这五枚钉的是「对话框的加入按钮与 URL／会话那道门共用一把尺」——共用的是**跨度**
    // 那把尺（`durationOk` 的一处拼写），不是手打数那把：门侧收到的串里已经没有单位
    // 这一层，串中那个数就是折算后的跨度，所以 `1000m`（小时档 n=17 折算出来的）合法。
    // N-1（2026-10-22）撤销了「委托 validateDraft」的写法，这枚针的 `1000m` 因此翻面。
    expect(isCustomSpec("999m"), "999m 还在界内").toBe(true);
    expect(isCustomSpec("1000m"), "1000m 是小时档折算出来的合法跨度，门按跨度判它").toBe(true);
    expect(isCustomSpec("366D"), "366D 还在日历倍数界内").toBe(true);
    expect(isCustomSpec("367D"), "367D 越过日历倍数上限").toBe(false);
    expect(isCustomSpec("9999m"), "9999m 文法合法但本仓不收").toBe(false);
  });
});

describe("加入按钮的 enabled 判据（本仓规则，不是对面的初态）", () => {
  it("空值／非整数／越界都给可见原因，不返回裸 false", () => {
    expect(validateDraft({ unit: "minute", n: null }).ok).toBe(false);
    expect(validateDraft({ unit: "minute", n: 0 }).ok).toBe(false);
    expect(validateDraft({ unit: "hour", n: 25 }).ok).toBe(false); // 1500 分 > 一天
    expect(validateDraft({ unit: "day", n: 367 }).ok).toBe(false);
    expect(validateDraft({ unit: "minute", n: 1.5 }).ok).toBe(false);
    for (const bad of [validateDraft({ unit: "minute", n: null }), validateDraft({ unit: "hour", n: 25 })]) {
      if (!bad.ok) expect(bad.reason.length).toBeGreaterThan(0);
    }
    const builtin = validateDraft({ unit: "minute", n: 5 }); // → `5m`：内置档重复分支的可见原因
    expect(builtin.ok, "5m").toBe(false);
    if (!builtin.ok) expect(builtin.reason, "5m").toBe("这一档目录里已经有了（它就是内置档）");
    const custom = validateDraft({ unit: "minute", n: 7 }); // 反向：非内置档不许给同一句（防「恒拒」假通过）
    expect(custom.ok, "7m").toBe(true);
    if (!custom.ok) expect(custom.reason, "7m").not.toBe("这一档目录里已经有了（它就是内置档）");
  });
  it("合法草案给出 spec 串", () => {
    expect(validateDraft({ unit: "hour", n: 2 })).toEqual({ ok: true, spec: "120m" });
    expect(validateDraft({ unit: "week", n: 2 })).toEqual({ ok: true, spec: "2W" });
  });
  it("往返：对话框发得出的串，门（isCustomSpec）一律收得下（N-1 的往返针）", () => {
    // 钉的是性质，不是那八枚串的名字：五枚单位 × n 1..999 全遍历，凡 `validateDraft`
    // 判 ok:true 造出来的 spec 都必须被 `isCustomSpec` 认。ok:false 的草案直接跳过，
    // 不进断言分母——那是「手打数」那把尺的合法拒收，不是洞。
    const emitted: string[] = [];
    for (const { unit } of CUSTOM_UNITS) {
      for (let n = 1; n <= 999; n += 1) {
        const verdict = validateDraft({ unit, n });
        if (!verdict.ok) continue;
        emitted.push(verdict.spec);
        expect(isCustomSpec(verdict.spec), `${unit}/${n} → ${verdict.spec}`).toBe(true);
      }
    }
    // 最后两枚是这枚针的判别力所在：只断性质的话，把跨度尺收紧到 `MAX_COUNT` 会让
    // ok:true 的集合自己缩小，性质照样成立、针照样绿（豁免型针天生恒绿那一族）。
    // 这里钉的是「小时档确实发得出 1000 分钟以上的跨度」——正是 N-1 那个洞的形状。
    expect(emitted, "小时档 n=17 折算出来的跨度发得出，门也就得收得下").toContain("1020m");
    expect(emitted, "小时档 n=24 顶到一天，仍在界内").toContain("1440m");
  });
});
