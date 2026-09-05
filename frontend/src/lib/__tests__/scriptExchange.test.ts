import { describe, expect, it } from "vitest";

import {
  SHARE_LINK_SOFT_LIMIT,
  createShareLink,
  fromBundleJson,
  fromPineFile,
  gzipSupported,
  importAny,
  newScriptId,
  readShareLink,
  toBundle,
  toPineFile,
  type ScriptCard,
} from "../scriptExchange";

/** A real-world shaped Pine indicator, pragma and all. */
const MACD_PINE = `//@version=5
indicator("MACD 柱", overlay=false)
fast = input.int(12, "快线")
slow = input.int(26, "慢线")
[mLine, sLine, _h] = ta.macd(close, fast, slow, 9)
plot(mLine, "MACD", color=color.new(color.teal, 0))
plot(sLine, "信号", color=color.new(color.orange, 0))
plot(mLine - sLine, "柱", style=plot.style_histogram)
hline(0, "零轴")
`;

/** A cross MA strategy, the other half of what users copy from tv.com/scripts. */
const XA_STRATEGY = `//@version=5
strategy("双均线策略", overlay=true, initial_capital=100000, default_qty_type=strategy.percent_of_equity, default_qty_value=100)
maFast = ta.sma(close, 5)
maSlow = ta.sma(close, 20)
if ta.crossover(maFast, maSlow)
    strategy.entry("Long", strategy.long)
if ta.crossunder(maFast, maSlow)
    strategy.close("Long")
`;

const VECTOR_FORMULA = `MA5:MA(CLOSE,5);
MA20:MA(CLOSE,20);
DIF:(CLOSE-REF(CLOSE,20))/REF(CLOSE,20)*100;`;

function card(over: Partial<ScriptCard> = {}): ScriptCard {
  return {
    id: newScriptId(),
    dialect: "pine",
    name: "MACD 柱",
    code: MACD_PINE,
    display: "pane",
    params: [12, 26],
    ...over,
  };
}

/** A `j` payload, byte-safe for non-ASCII text (btoa alone is Latin-1 only). */
function plainJson(obj: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `j${btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")}`;
}

/* ------------------------------------------------------------- .pine file */

describe(".pine 文本容器", () => {
  it("导出头是注释，源码原样保留（贴回 TV 仍可编译）", () => {
    const file = toPineFile(card({ category: "趋势", description: "带零轴", origin: "https://cn.tradingview.com/scripts/x/" }));
    const head = file.split("\n\n")[0];
    expect(head).toContain("//> name: MACD 柱");
    expect(head).toContain("//> params: 12,26");
    expect(head).toContain("//> category: 趋势");
    expect(head).toContain("//> origin: https://cn.tradingview.com/scripts/x/");
    // Every header line is a comment, so the body is untouched Pine.
    for (const line of head.split("\n")) expect(line.startsWith("//>")).toBe(true);
    expect(file).toContain(MACD_PINE.trim());
  });

  it("往返保住名字/参数/分类/展示位置", () => {
    const original = card({ display: "overlay", params: [9, 21] });
    const back = fromPineFile(toPineFile(original));
    expect(back.name).toBe(original.name);
    expect(back.dialect).toBe("pine");
    expect(back.display).toBe("overlay");
    expect(back.params).toEqual([9, 21]);
    expect(back.code).toBe(MACD_PINE.trim());
    expect(back.id).not.toBe(original.id);
  });

  it("空参数列表不会掺一个 0 进来", () => {
    // Number("") === 0, and a [0] param would override every input.int() default.
    const back = fromPineFile(toPineFile(card({ params: [] })));
    expect(back.params).toEqual([]);
  });

  it("导入裸源码：不吞掉 //@version，标题取自 indicator()", () => {
    const imported = fromPineFile(XA_STRATEGY);
    expect(imported.dialect).toBe("pine");
    expect(imported.name).toBe("双均线策略");
    expect(imported.display).toBe("overlay");
    expect(imported.code.startsWith("//@version=5")).toBe(true);
    expect(imported.code).toContain("strategy.entry");
  });

  it("向量公式靠 //> dialect 区分，不会被误判成 Pine", () => {
    const file = `//> name: 均线组\n//> dialect: vector\n//> display: pane\n\n${VECTOR_FORMULA}`;
    const imported = fromPineFile(file);
    expect(imported.dialect).toBe("vector");
    expect(imported.display).toBe("pane");
    expect(imported.name).toBe("均线组");
    expect(imported.code).toBe(VECTOR_FORMULA.trim());
  });

  it("无 //> 头且无标题时退回文件名", () => {
    const imported = fromPineFile("MA(CLOSE,5)\n", "我的公式");
    expect(imported.name).toBe("我的公式");
    expect(imported.dialect).toBe("vector");
  });

  it("CRLF 与首行元数据混排也能解析", () => {
    const imported = fromPineFile(`//> name: 策略甲\r\n//> display: overlay\r\n\r\n${XA_STRATEGY.replace(/\n/g, "\r\n")}`);
    expect(imported.name).toBe("策略甲");
    expect(imported.display).toBe("overlay");
    expect(imported.code).toContain("ta.crossover");
  });
});

/* ---------------------------------------------------------------- bundle */

describe("JSON 脚本包", () => {
  it("多脚本打包后逐个还原，inputs 保留", () => {
    const withInputs = card({
      inputs: [{ varName: "fast", label: "快线", kind: "int", def: 12, min: 1, max: 200, step: 1 }],
    });
    const bundle = toBundle([withInputs, card({ id: "b", name: "第二个", code: XA_STRATEGY, display: "overlay" })]);
    const { cards, errors } = fromBundleJson(bundle);
    expect(errors).toEqual([]);
    expect(cards).toHaveLength(2);
    expect(cards[0].inputs).toEqual(withInputs.inputs);
    expect(cards[0].params).toEqual([12, 26]);
    expect(cards[1].name).toBe("第二个");
    expect(cards[1].display).toBe("overlay");
  });

  it("兼容裸数组与单对象", () => {
    expect(fromBundleJson(JSON.stringify([card(), card({ id: "z" })])).cards).toHaveLength(2);
    const single = fromBundleJson(JSON.stringify(card()));
    expect(single.cards).toHaveLength(1);
    expect(single.errors).toEqual([]);
  });

  it("坏条目只丢自己，好条目照常导入", () => {
    const raw = JSON.stringify({
      format: "vibe-trading.scripts",
      version: 1,
      items: [{ name: "缺代码" }, card(), 42],
    });
    const { cards, errors } = fromBundleJson(raw);
    expect(cards).toHaveLength(1);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toContain("第 1 条");
    expect(errors[1]).toContain("第 3 条");
  });

  it("非法 JSON / 空包给出可读错误", () => {
    expect(fromBundleJson("{ nope").cards).toEqual([]);
    expect(fromBundleJson("{ nope").errors[0]).toContain("JSON");
    const empty = fromBundleJson('{"format":"vibe-trading.scripts","version":1,"items":[]}');
    expect(empty.cards).toEqual([]);
    expect(empty.errors).toEqual(["文件里没有可导入的脚本"]);
  });
});

describe("importAny 嗅探容器类型", () => {
  it("JSON、.pine、空内容三条路", () => {
    expect(importAny(toBundle([card(), card({ id: "2" })])).cards).toHaveLength(2);
    const pine = importAny(XA_STRATEGY, "双均线.pine");
    expect(pine.errors).toEqual([]);
    expect(pine.cards[0].name).toBe("双均线策略");
    expect(importAny("   ").errors).toEqual(["内容是空的"]);
    expect(importAny("// 只有注释，没有正文").errors).toEqual(["文件里没有脚本正文"]);
  });

  it("散文不是脚本", () => {
    const prose = importAny("今天天气不错，适合研究一下均线");
    expect(prose.cards).toHaveLength(0);
    expect(prose.errors.join("")).toContain("不是脚本代码");
  });
});

/* ----------------------------------------------------------- share links */

describe("分享链接", () => {
  it("一条策略能塞进一个 URL，且往返无损", async () => {
    const link = await createShareLink(card({ code: XA_STRATEGY, display: "overlay", name: "双均线策略" }), "https://example.com/chart");
    expect(link.url.startsWith("https://example.com/chart?s=")).toBe(true);
    expect(link.verbose).toBe(link.length > SHARE_LINK_SOFT_LIMIT);
    expect(["g", "j"]).toContain(link.codec);
    const decoded = await readShareLink(link.url);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.card.name).toBe("双均线策略");
    expect(decoded.card.dialect).toBe("pine");
    expect(decoded.card.display).toBe("overlay");
    expect(decoded.card.code).toBe(XA_STRATEGY.trim());
    expect(decoded.card.id).toMatch(/^s/);
  });

  it("带中文与参数表单的脚本同样无损", async () => {
    const source = card({
      inputs: [{ varName: "fast", label: "快线长度", kind: "int", def: 12, min: 1, max: 200, step: 1 }],
      params: [8, 21],
      description: "含中文说明，检验 UTF-8 字节安全",
    });
    const decoded = await readShareLink((await createShareLink(source)).url);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.card.code).toBe(MACD_PINE.trim());
    expect(decoded.card.params).toEqual([8, 21]);
    expect(decoded.card.inputs?.[0]?.label).toBe("快线长度");
    expect(decoded.card.description).toBe("含中文说明，检验 UTF-8 字节安全");
  });

  it("支持 gzip 时真的压缩，不支持时降级明文", async () => {
    const code = (MACD_PINE + XA_STRATEGY).repeat(6);
    const link = await createShareLink(card({ code }));
    expect(link.codec).toBe(gzipSupported() ? "g" : "j");
    if (link.codec === "g") expect(link.length).toBeLessThan(Math.round(code.length * 0.9));
    const decoded = await readShareLink(link.url);
    expect(decoded.ok && decoded.card.code === code.trim()).toBe(true);
  });

  it("同一链接反复导入不会撞 id", async () => {
    const url = (await createShareLink(card())).url;
    const a = await readShareLink(url);
    const b = await readShareLink(url);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.card.id).not.toBe(b.card.id);
  });

  it("接受整串 URL、裸 query 与纯分享码三种输入", async () => {
    const payload = (await createShareLink(card())).url.split("?s=")[1];
    expect(payload).toBeTruthy();
    for (const input of [`https://x.test/?s=${payload}`, `?s=${payload}`, payload]) {
      const decoded = await readShareLink(input);
      expect(decoded.ok).toBe(true);
    }
  });

  it("无 gzip 环境下用 j 前缀也能读回来", async () => {
    const payload = plainJson({
      v: 1,
      c: { id: "", dialect: "pine", name: "明文链接", code: XA_STRATEGY.trim(), display: "overlay", params: [] },
    });
    const decoded = await readShareLink(`https://x.test/?s=${payload}`);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.card.name).toBe("明文链接");
    expect(decoded.card.code).toContain("strategy.entry");
  });

  it("坏链接逐类报错，不抛异常", async () => {
    const reason = async (input: string) => {
      const out = await readShareLink(input);
      expect(out.ok).toBe(false);
      return out.ok ? "" : out.error;
    };
    expect(await reason("https://example.com/chart")).toBe("链接里没有分享码");
    expect(await reason("q123")).toBe("链接里没有分享码");
    expect(await reason("?s=g!!!!")).toBe("分享码不是合法的 base64");
    expect(await reason(`?s=j${btoa("not json at all")}`)).toBe("分享码内容不是合法 JSON");
    // The auto-open path hands the decoder the bare query value, so a code some
    // chat client chopped has to still say which step broke (⑱).
    expect(await reason("j!!!!notbase64!!!!")).toBe("分享码不是合法的 base64");
    // ... while pasted prose or a stub too short to be a code is still "no code
    // in here", not a code that happens to be broken.
    expect(await reason("good morning everyone")).toBe("链接里没有分享码");
    expect(await reason("g!!")).toBe("链接里没有分享码");
    expect(await reason("http://x.test/pro-chart?s=g!!!!")).toBe("分享码不是合法的 base64");
    const emptyObj = plainJson({ v: 1, c: { name: "没有代码" } });
    expect(await reason(`?s=${emptyObj}`)).toBe("分享码里没有可运行的脚本");
  });
});
