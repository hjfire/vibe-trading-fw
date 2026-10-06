import { describe, expect, it } from "vitest";
import { BACKEND_INTERVALS, pineRuleId, translatePineAlerts } from "../pineAlertRules";

/**
 * The translator's contract is "native only when the backend can say exactly
 * this, otherwise a refusal that names the sub-expression". Every `refused`
 * case below is as load-bearing as a `native` one: a silently narrowed
 * translation (`>=` -> `>`, `a or b` -> `a`) is a wrong alert, which is worse
 * than no alert.
 */

const wrap = (body: string) => `//@version=5\nindicator("t")\n${body}`;
const OPT = { symbol: "600519.SH", interval: "1D" };
const one = (body: string, opt = OPT) => translatePineAlerts(wrap(body), opt)[0];

describe("可译语法表（spec §6）", () => {
  it("close > 常量 ⇒ gt + value", () => {
    expect(one('alertcondition(close > 1700, "A", "")')).toMatchObject({
      status: "native",
      condition: { op: "gt", lhs: "close", rhs: null, value: 1700 },
    });
  });

  it("ta.crossover(ema5, ema20) ⇒ crossUp + 双序列", () => {
    expect(one('alertcondition(ta.crossover(ta.ema(close,5), ta.ema(close,20)), "A", "")')).toMatchObject({
      status: "native",
      condition: { op: "crossUp", lhs: "ema:5", rhs: "ema:20", value: null },
    });
  });

  it("命名参数 condition= 与位置参数同等", () => {
    expect(one('alertcondition(condition = close < ta.sma(close, 20), title = "A")')).toMatchObject({
      status: "native",
      condition: { op: "lt", lhs: "close", rhs: "sma:20" },
    });
  });

  it("标识符多跳展开（longSignal → crossover → ema）", () => {
    const src =
      'fast = ta.ema(close, 5)\nslow = ta.ema(close, 20)\nok = ta.crossover(fast, slow)\nalertcondition(ok, "A", "")';
    expect(one(src)).toMatchObject({
      status: "native",
      condition: { op: "crossUp", lhs: "ema:5", rhs: "ema:20" },
    });
  });

  it("volume > volume[1] ⇒ rising volume", () => {
    expect(one('alertcondition(volume > volume[1], "A", "")')).toMatchObject({
      status: "native",
      condition: { op: "rising", lhs: "volume" },
    });
  });

  it("ta.change(x) < 0 ⇒ falling x", () => {
    expect(one('alertcondition(ta.change(close) < 0, "A", "")')).toMatchObject({
      status: "native",
      condition: { op: "falling", lhs: "close" },
    });
  });

  it("rsi 常量门槛 ⇒ lt rsi:14 30", () => {
    expect(one('alertcondition(ta.rsi(close, 14) < 30, "A", "")')).toMatchObject({
      status: "native",
      condition: { op: "lt", lhs: "rsi:14", rhs: null, value: 30 },
    });
  });

  it("ta.macd 默认参数的 tuple 解构 ⇒ macd_line/macd_signal", () => {
    const src = '[m, s, h] = ta.macd(close)\nalertcondition(m > s, "A", "")';
    expect(one(src)).toMatchObject({
      status: "native",
      condition: { op: "gt", lhs: "macd_line", rhs: "macd_signal" },
    });
  });

  it("顶层 alert(cond, msg) 与单语句 if 体内的 alert(msg) 同等处理", () => {
    expect(
      one('alert(ta.ema(close,5) > ta.ema(close,20), "贵", alert.freq_all)').condition?.op,
    ).toBe("gt");
    const guarded = 'if ta.rsi(close,14) > 70\n    alert("贵了")';
    expect(one(guarded)).toMatchObject({
      status: "native",
      condition: { op: "gt", lhs: "rsi:14", value: 70 },
    });
  });

  it("input.int 默认值代入 ⇒ 常量 value ＋ 一条 notes", () => {
    const src = 'lvl = input.int(1700, "水平")\nalertcondition(close > lvl, "A", "")';
    const p = one(src);
    expect(p).toMatchObject({
      status: "native",
      condition: { op: "gt", lhs: "close", value: 1700 },
    });
    expect(p.notes.join(" ")).toContain("input");
  });

  it("draft 带得上后端要求的 id/kind/symbol/interval/count", () => {
    const p = one('alertcondition(close > 1700, "A", "m")');
    expect(p.draft).toMatchObject({
      kind: "market",
      symbol: "600519.SH",
      interval: "1D",
      title: "A",
      for_bars: 1,
      enabled: true,
    });
    expect(p.draft!.id).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
    expect(p.draft!.count).toBeGreaterThanOrEqual(320);
    expect(p.draft!.count).toBeLessThanOrEqual(2000);
  });
});

describe("拒绝枚举（绝不静默放宽，spec §6/§9）", () => {
  it(">= 没有对应算子", () => {
    const p = one('alertcondition(close >= 1700, "A", "")');
    expect(p.status).toBe("refused");
    expect(p.reason).toContain(">=");
    expect(p.condition).toBeUndefined();
  });

  it("and / or / not 一律拒绝", () => {
    for (const body of [
      'alertcondition(close > 1 and volume > 1000, "A", "")',
      'alertcondition(close > 1 or volume > 1000, "A", "")',
      'alertcondition(not (close > 1), "A", "")',
    ]) {
      expect(one(body).status).toBe("refused");
    }
  });

  it("ta.cross 是双向穿越", () => {
    expect(
      one('alertcondition(ta.cross(ta.ema(close,5), ta.ema(close,20)), "A", "")').status,
    ).toBe("refused");
  });

  it("指标源不是 close 就不可译（后端只吃 close）", () => {
    const p = one('alertcondition(ta.ema(volume, 5) > 100, "A", "")');
    expect(p.status).toBe("refused");
    expect(p.reason).toContain("close");
  });

  it("ta.macd 带周期参数 ⇒ 与后端默认值不同，拒绝", () => {
    expect(one('[m, s, h] = ta.macd(close, 8, 21, 5)\nalertcondition(m > s, "A", "")').status).toBe(
      "refused",
    );
  });

  it("名册外的序列点名它", () => {
    const p = one('alertcondition(ta.atr(14) > 1, "A", "")');
    expect(p.status).toBe("refused");
    expect(p.reason).toContain("atr");
  });

  it("周月线周期后端不支持，点名周期", () => {
    const p = one('alertcondition(close > 1, "A", "")', { ...OPT, interval: "1W" });
    expect(p.status).toBe("refused");
    expect(p.reason).toContain("1W");
  });

  it("裸 bool：能展开成单个比较就译，展开不出的状态机就拒绝", () => {
    // `flag` derefs to one comparison, which IS the backend grammar.
    expect(one('flag = close > 1\nalertcondition(flag, "A", "")')).toMatchObject({
      status: "native",
      condition: { op: "gt", lhs: "close", value: 1 },
    });
    // A `var` reassigned inside `if` has no single-expression meaning.
    const state = 'var bool armed = false\nif close > 1\n    armed := true\nalertcondition(armed, "A", "")';
    expect(one(state).status).toBe("refused");
  });

  it("名册内数值序列作条件 ⇒ truthy", () => {
    expect(one('alertcondition(volume, "A", "")').condition).toMatchObject({
      op: "truthy",
      lhs: "volume",
    });
  });

  it("alert() 被 if 门住但体内不止一条语句 ⇒ 拒绝", () => {
    expect(one('if close > 1\n    plot(close)\n    alert("x")').status).toBe("refused");
  });

  it("顶层 alert() 没有条件 ⇒ 拒绝（每根都触发不是规则）", () => {
    expect(one('alert("always", alert.freq_all)').status).toBe("refused");
  });

  it("循环体内的 alert ⇒ 拒绝", () => {
    expect(one('for i = 0 to 3\n    alertcondition(close > i, "A", "")').status).toBe("refused");
  });

  it("alertcondition 被 if 门住 ⇒ 拒绝（等于 and）", () => {
    const p = one('if close > 1\n    alertcondition(volume > 1000, "A", "")');
    expect(p.status).toBe("refused");
    expect(p.reason).toContain("and");
  });

  it("else 分支里的 alert ⇒ 拒绝（条件要取反）", () => {
    expect(one('if close > 1\n    plot(close)\nelse\n    alertcondition(volume > 1000, "A", "")').status).toBe(
      "refused",
    );
  });

  it("解析失败原样带回，绝不返回空数组冒充「没有告警条件」", () => {
    const rows = translatePineAlerts('indicator("x"\nalertcondition(close >, ', OPT);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("refused");
    expect((rows[0].reason ?? "").length).toBeGreaterThan(0);
  });

  it("脚本里没有 alert 声明 ⇒ 空数组（与上一条方向相反，两者都必须成立）", () => {
    expect(translatePineAlerts('//@version=5\nindicator("x")\nplot(close)\n', OPT)).toEqual([]);
  });
});

describe("规则 id 稳定性", () => {
  it("同符号同行同条件 ⇒ 同 id，换符号 ⇒ 不同 id", () => {
    const c = { op: "gt", lhs: "close", rhs: null, value: 1700 };
    const a = pineRuleId("600519.SH", 3, c);
    expect(pineRuleId("600519.SH", 3, c)).toBe(a);
    expect(pineRuleId("000001.SZ", 3, c)).not.toBe(a);
    expect(pineRuleId("600519.SH", 4, c)).not.toBe(a);
    expect(a).toMatch(/^[A-Za-z0-9_-]{1,128}$/);
  });

  it("后端周期名册逐字为 6 项", () => {
    expect(BACKEND_INTERVALS).toEqual(["1m", "5m", "15m", "30m", "60m", "1D"]);
  });
});
