import { describe, expect, it } from "vitest";

import {
  MAIN_PANE_ID,
  MAX_DRAWINGS_PER_BUCKET,
  type StoredDrawing,
} from "../chartDrawings";
import {
  DRAWING_BUNDLE_KIND,
  DRAWING_SHARE_QUERY_KEY,
  createDrawingsShareLink,
  drawingsFileName,
  drawingKey,
  exportDrawingsJson,
  importDrawingsJson,
  mergeDrawings,
  readDrawingsShareLink,
  sanitizeStoredDrawing,
  type DrawingsImport,
} from "../drawingExchange";
import { gzipSupported, readShareLink } from "../scriptExchange";

/**
 * Drawing files and drawing links (local custom ⑱).
 *
 * What this guards: a `.json` written by one machine must come back byte-for-byte
 * equivalent on another, an unusable entry must be *reported* rather than vanish,
 * and nothing an importer builds may reach the overlay template untouched —
 * a wrong `paneId` alone is enough to put a price line on the volume axis (⑭).
 */

const T0 = 1_700_000_000_000;

function drawing(patch: Partial<StoredDrawing> = {}): StoredDrawing {
  return {
    name: "priceLine",
    paneId: MAIN_PANE_ID,
    points: [{ timestamp: T0, value: 1300 }],
    ...patch,
  };
}

function okImport(raw: string): DrawingsImport {
  const out = importDrawingsJson(raw);
  if (!out.ok) throw new Error(`import failed: ${out.error}`);
  return out;
}

function failure(out: ReturnType<typeof importDrawingsJson>): { error: string } {
  if (out.ok) throw new Error("expected a failure");
  return out;
}

/* ------------------------------------------------------------------- files */

describe("画线文件导出", () => {
  it("信封完整：kind/版本/来源/计数与内容一致", () => {
    const json = exportDrawingsJson([drawing(), drawing({ name: "segment", points: [{ timestamp: T0, value: 10 }, { timestamp: T0 + 86_400_000, value: 20 }] })], {
      symbol: "600519.SH",
      interval: "1D",
      now: new Date(Date.UTC(2026, 8, 5, 12, 0, 0)),
    });
    const parsed = JSON.parse(json) as Record<string, any>;
    expect(parsed.kind).toBe(DRAWING_BUNDLE_KIND);
    expect(parsed.version).toBe(1);
    expect(parsed.from).toEqual({
      symbol: "600519.SH",
      interval: "1D",
      exportedAt: "2026-09-05T12:00:00.000Z",
      count: 2,
    });
    expect(parsed.drawings).toHaveLength(2);
    // Pretty-printed so a bundle can live in a repo and be reviewed.
    expect(json.split("\n")[1]).toMatch(/^\s{2}"/);
  });

  it("导出不合法的东西也不写进文件（计数与内容同步）", () => {
    const json = exportDrawingsJson([
      drawing(),
      // Cast on purpose: this is what a caller hand-assembling a list can pass.
      { name: "priceLine", paneId: MAIN_PANE_ID, points: [{ value: 1200 }] } as unknown as StoredDrawing,
      { name: "mysteryTool", paneId: MAIN_PANE_ID, points: [{ timestamp: T0 }] } as unknown as StoredDrawing,
    ]);
    const parsed = JSON.parse(json) as { drawings: unknown[]; from: { count: number } };
    expect(parsed.drawings).toHaveLength(1);
    expect(parsed.from.count).toBe(1);
  });

  it("导出再导入完全无损（样式、锁定、隐藏跟着文件走）", () => {
    const source: StoredDrawing[] = [
      drawing({ style: { color: "#F23645", size: 3, dashed: true }, lock: true }),
      drawing({ name: "fibonacciLine", points: [{ timestamp: T0, value: 100 }, { timestamp: T0 + 1, value: 90 }], hidden: true }),
      drawing({ name: "brush", points: [{ timestamp: T0, value: 1 }, { timestamp: T0 + 1, value: 2 }] }),
    ];
    const back = okImport(exportDrawingsJson(source, { symbol: "600519.SH", interval: "5m" }));
    expect(back.drawings).toEqual(source);
    expect(back.skipped).toEqual([]);
    expect(back.from).toBe("600519.SH|5m");
  });
});

describe("画线文件导入", () => {
  it("接受信封、裸数组与单个对象三种形态", () => {
    const one = drawing();
    const forms = [JSON.stringify({ kind: DRAWING_BUNDLE_KIND, version: 1, drawings: [one] }), JSON.stringify([one]), JSON.stringify(one)];
    for (const raw of forms) {
      const out = okImport(raw);
      expect(out.drawings).toEqual([one]);
    }
  });

  it("坏内容整批报错，不抛异常", () => {
    expect(importDrawingsJson("")).toEqual({ ok: false, error: "内容是空的" });
    expect(importDrawingsJson("   ").ok).toBe(false);
    expect(failure(importDrawingsJson("{not json")).error).toMatch(/不是合法的 JSON/);
    expect(importDrawingsJson('"600519.SH"')).toEqual({ ok: false, error: "文件里没有画线：既不是数组，也没有 drawings" });
    expect(importDrawingsJson(JSON.stringify({ drawings: "nope" }))).toEqual({
      ok: false,
      error: "文件里没有画线：既不是数组，也没有 drawings",
    });
  });

  it("逐条给出可读原因，好的一条不漏", () => {
    const out = okImport(
      JSON.stringify({
        drawings: [
          drawing(),
          { paneId: MAIN_PANE_ID, points: [{ timestamp: T0 }] },
          { name: "trendLine", paneId: MAIN_PANE_ID, points: [{ timestamp: T0 }] },
          { name: "priceLine" },
          { name: "priceLine", paneId: MAIN_PANE_ID, points: "nope" },
          { name: "priceLine", paneId: MAIN_PANE_ID, points: [{ value: 1200 }, null, 3] },
          null,
        ],
      }),
    );
    expect(out.drawings).toHaveLength(1);
    expect(out.skipped).toEqual([
      "第 2 条：缺少画线工具名",
      "第 3 条：trendLine 不是可复现的画线工具",
      "第 4 条：points 应为数组",
      "第 5 条：points 应为数组",
      "第 6 条：没有落在某根 K 线上的落点",
      "第 7 条：不是一个对象",
    ]);
  });

  it("importDrawingsJson 永不抛：结构怪异一律走 error 或 skipped", () => {
    for (const raw of ["[]", "[1,2,3]", "[]", "{\"kind\":1}", "[[]]", "null"]) {
      expect(() => importDrawingsJson(raw)).not.toThrow();
    }
    expect(okImport("[1,2,3]").drawings).toEqual([]);
  });

  it("落点只保留时间戳与价位，多余键一概不带入", () => {
    const out = okImport(
      JSON.stringify([
        {
          name: "segment",
          paneId: MAIN_PANE_ID,
          points: [{ timestamp: T0, value: 10, dataIndex: 7, extra: "x" }],
          note: "hello",
        },
      ]),
    );
    expect(out.drawings).toEqual([{ name: "segment", paneId: MAIN_PANE_ID, points: [{ timestamp: T0, value: 10 }] }]);
  });

  it("副图 paneId 被改写回主图（价位不能落在成交量轴上）", () => {
    const out = okImport(
      JSON.stringify([
        { name: "priceLine", paneId: "indicator_pane_volume_1", points: [{ timestamp: T0, value: 52874 }] },
        { name: "priceLine", points: [{ timestamp: T0, value: 1300 }] },
      ]),
    );
    expect(out.drawings.map((d) => d.paneId)).toEqual([MAIN_PANE_ID, MAIN_PANE_ID]);
  });

  it("样式归一：十六进制大写、线宽夹进 1..6、非法颜色整条丢弃", () => {
    const out = okImport(
      JSON.stringify([
        drawing({ style: { color: "#f23645", size: 99, dashed: true } }),
        drawing({ name: "segment", points: [{ timestamp: T0 }, { timestamp: T0 + 1 }], style: { color: "red", size: 2, dashed: false } }),
      ]),
    );
    expect(out.drawings[0].style).toEqual({ color: "#F23645", size: 6, dashed: true });
    expect(out.drawings[1].style).toBeUndefined();
  });

  it("布尔旗标只在为真时出现，且只认 true", () => {
    const out = okImport(
      JSON.stringify([
        drawing({ lock: false, hidden: undefined } as unknown as Partial<StoredDrawing> as StoredDrawing),
        { name: "priceLine", paneId: MAIN_PANE_ID, points: [{ timestamp: T0 }], lock: "yes", hidden: 1 },
        { name: "priceLine", paneId: MAIN_PANE_ID, points: [{ timestamp: T0 }], lock: true, hidden: true },
      ]),
    );
    expect(Object.keys(out.drawings[0])).toEqual(["name", "paneId", "points"]);
    expect(Object.keys(out.drawings[1])).toEqual(["name", "paneId", "points"]);
    expect(out.drawings[2]).toEqual({
      name: "priceLine",
      paneId: MAIN_PANE_ID,
      points: [{ timestamp: T0 }],
      lock: true,
      hidden: true,
    });
  });

  it("恶意 JSON 污染不了原型，也不塞进多余键", () => {
    const raw = '{"__proto__":{"polluted":true},"drawings":[{"name":"priceLine","paneId":"y","points":[{"timestamp":1}],"constructor":"x"}]}';
    const out = okImport(raw);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(out.drawings).toEqual([{ name: "priceLine", paneId: MAIN_PANE_ID, points: [{ timestamp: 1 }] }]);
    expect(Object.keys(out.drawings[0])).toEqual(["name", "paneId", "points"]);
  });

  it("超过桶上限时留最新的，并说明丢了几条", () => {
    const many = Array.from({ length: MAX_DRAWINGS_PER_BUCKET + 50 }, (_, i) => ({
      name: "priceLine",
      paneId: MAIN_PANE_ID,
      points: [{ timestamp: T0 + i }],
    }));
    const out = okImport(JSON.stringify(many));
    expect(out.drawings).toHaveLength(MAX_DRAWINGS_PER_BUCKET);
    expect(out.drawings[0].points[0].timestamp).toBe(T0 + 50);
    expect(out.skipped).toEqual([`超过 ${MAX_DRAWINGS_PER_BUCKET} 条上限，最早的 50 条已丢弃`]);
  });

  it("from 只在标的与周期齐备时才当来源，缺一个就留空", () => {
    expect(okImport(JSON.stringify({ from: { symbol: "600519.SH", interval: "1D" }, drawings: [] })).from).toBe("600519.SH|1D");
    expect(okImport(JSON.stringify({ from: { symbol: "600519.SH" }, drawings: [] })).from).toBe("600519.SH");
    expect(okImport(JSON.stringify({ from: { interval: "1D" }, drawings: [] })).from).toBe("");
    expect(okImport(JSON.stringify({ from: "600519.SH|1D", drawings: [] })).from).toBe("");
  });
});

describe("sanitizeStoredDrawing", () => {
  it("单条清洗：合法给对象，非法给 null", () => {
    expect(sanitizeStoredDrawing(drawing())).toEqual(drawing());
    expect(sanitizeStoredDrawing({ name: "segment", points: [{ timestamp: T0 }] })).toEqual({
      name: "segment",
      paneId: MAIN_PANE_ID,
      points: [{ timestamp: T0 }],
    });
    for (const bad of [null, undefined, 0, "priceLine", [], {}, { name: "priceLine" }, { name: "priceLine", points: [] }]) {
      expect(sanitizeStoredDrawing(bad)).toBeNull();
    }
  });
});

/* ------------------------------------------------------------------ merge */

describe("导入合并", () => {
  it("同一几何图形只算一条，改色改锁不算新线", () => {
    const existing = [drawing(), drawing({ name: "segment", points: [{ timestamp: T0, value: 1 }, { timestamp: T0 + 1, value: 2 }] })];
    const incoming = [
      drawing({ style: { color: "#F23645", size: 3, dashed: false }, lock: true }),
      drawing({ name: "segment", points: [{ timestamp: T0, value: 1 }, { timestamp: T0 + 1, value: 2 }], hidden: true }),
      drawing({ name: "rayLine", points: [{ timestamp: T0 + 9, value: 5 }] }),
    ];
    const merged = mergeDrawings(existing, incoming);
    expect(merged.added).toBe(1);
    expect(merged.duplicates).toBe(2);
    expect(merged.drawings).toHaveLength(3);
    // `fresh` is what a live chart has to add: only the accepted incoming ones.
    expect(merged.fresh).toEqual([incoming[2]]);
    // Existing first, and existing keeps its own look.
    expect(merged.drawings[0].style).toBeUndefined();
    expect(merged.drawings[2].name).toBe("rayLine");
  });

  it("反复导入同一个文件是幂等的", () => {
    const raw = exportDrawingsJson([drawing(), drawing({ name: "segment" })], { symbol: "X", interval: "1D" });
    const first = mergeDrawings([], okImport(raw).drawings);
    const second = mergeDrawings(first.drawings, okImport(raw).drawings);
    expect(first.added).toBe(2);
    expect(first.fresh).toHaveLength(2);
    expect(second.added).toBe(0);
    expect(second.fresh).toEqual([]);
    expect(second.duplicates).toBe(2);
    expect(second.drawings).toHaveLength(2);
  });

  it("点顺序与价位都参与签名", () => {
    const a = drawing({ name: "segment", points: [{ timestamp: T0, value: 1 }, { timestamp: T0 + 1, value: 2 }] });
    const b = drawing({ name: "segment", points: [{ timestamp: T0 + 1, value: 2 }, { timestamp: T0, value: 1 }] });
    const c = drawing({ name: "segment", points: [{ timestamp: T0, value: 1 }, { timestamp: T0 + 1, value: 3 }] });
    expect(drawingKey(a)).not.toBe(drawingKey(b));
    expect(drawingKey(a)).not.toBe(drawingKey(c));
    expect(mergeDrawings([a], [b, c]).added).toBe(2);
  });

  it("列表里已有的重复条目会被压掉", () => {
    const merged = mergeDrawings([drawing(), drawing()], [drawing()]);
    expect(merged.drawings).toHaveLength(1);
  });

  it("残缺条目不参与合并", () => {
    const junk = [null, { name: "priceLine" }, { points: [] }] as unknown as StoredDrawing[];
    expect(mergeDrawings(junk, junk).drawings).toEqual([]);
  });
});

/* ------------------------------------------------------------ share links */

describe("画线分享链接", () => {
  const source: StoredDrawing[] = [
    drawing({ style: { color: "#089981", size: 2, dashed: true }, lock: true }),
    drawing({ name: "fibonacciLine", points: [{ timestamp: T0, value: 100 }, { timestamp: T0 + 86_400_000, value: 80 }], hidden: true }),
  ];

  it("链接能原样读回，并带来来源标记", async () => {
    const link = await createDrawingsShareLink(source, { symbol: "600519.SH", interval: "1D" }, "https://x.test/pro-chart");
    expect(link.url.startsWith(`https://x.test/pro-chart?${DRAWING_SHARE_QUERY_KEY}=`)).toBe(true);
    expect(link.codec).toBe(gzipSupported() ? "g" : "j");
    const back = await readDrawingsShareLink(link.url);
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.drawings).toEqual(source);
    expect(back.from).toBe("600519.SH|1D");
    expect(back.skipped).toEqual([]);
  });

  it("接受整串 URL、裸 query 与纯分享码", async () => {
    const payload = (await createDrawingsShareLink(source, {}, "https://x.test/pro-chart")).url.split("?d=")[1];
    expect(payload).toBeTruthy();
    for (const input of [`https://x.test/pro-chart?d=${payload}`, `?d=${payload}`, payload]) {
      const back = await readDrawingsShareLink(input);
      expect(back.ok && back.drawings).toEqual(source);
    }
  });

  it("默认基址就是当前页面", async () => {
    const link = await createDrawingsShareLink([drawing()]);
    expect(link.url.startsWith(`${window.location.origin}${window.location.pathname}?d=`)).toBe(true);
  });

  it("链接基址上原有的查询与锚点被丢掉，不会串味", async () => {
    const link = await createDrawingsShareLink([drawing()], {}, "https://x.test/pro-chart?s=abc#/deep");
    expect(link.url).toMatch(/^https:\/\/x\.test\/pro-chart\?d=[^?#]+$/);
  });

  it("垃圾条目在编码前就被剔除", async () => {
    const link = await createDrawingsShareLink(
      [drawing(), { name: "nope", paneId: MAIN_PANE_ID, points: [{ timestamp: T0 }] } as unknown as StoredDrawing],
      {},
      "https://x.test/pro-chart",
    );
    const back = await readDrawingsShareLink(link.url);
    expect(back.ok && back.drawings).toEqual([drawing()]);
  });

  it("脚本分享链接不会被当成画线链接（两个 key 互不串味）", async () => {
    const scriptLink = "https://x.test/pro-chart?s=j" + btoa(JSON.stringify({ v: 1, c: { name: "macd", code: "x" } }));
    expect(await readDrawingsShareLink(scriptLink)).toEqual({ ok: false, error: "链接里没有画线分享码" });
    // And the other way round: a drawing link is not a script link either.
    const drawingLink = (await createDrawingsShareLink([drawing()], {}, "https://x.test/pro-chart")).url;
    const asScript = await readShareLink(drawingLink);
    expect(asScript.ok).toBe(false);
  });

  it("坏链接逐类报错，不抛异常", async () => {
    const reason = async (input: string) => {
      const out = await readDrawingsShareLink(input);
      expect(out.ok).toBe(false);
      return out.ok ? "" : out.error;
    };
    expect(await reason("https://example.com/pro-chart")).toBe("链接里没有画线分享码");
    expect(await reason("?d=")).toBe("链接里没有画线分享码");
    expect(await reason(`?${DRAWING_SHARE_QUERY_KEY}=q123`)).toBe("无法识别的分享码前缀");
    expect(await reason("?d=g!!!!")).toBe("分享码不是合法的 base64");
    // The `?d=` auto-open hands over the bare query value: a chopped code still
    // has to name the broken step, not claim the link held nothing (⑱).
    expect(await reason("j!!!!notbase64!!!!")).toBe("分享码不是合法的 base64");
    expect(await reason("got a link for you")).toBe("链接里没有画线分享码");
    expect(await reason("https://x.test/pro-chart?s=jQwA")).toBe("链接里没有画线分享码");
    expect(await reason(`?d=j${btoa("not json at all")}`)).toBe("分享码内容不是合法 JSON");
    expect(await reason(`?d=j${btoa('"600519.SH"')}`)).toBe("分享码里没有画线");
    // A decodable but useless body: reported per entry, not as a bald error.
    const junk = await readDrawingsShareLink(`?d=j${btoa(JSON.stringify([1, 2]))}`);
    expect(junk.ok).toBe(true);
    if (!junk.ok) return;
    expect(junk.drawings).toEqual([]);
    expect(junk.skipped).toEqual(["第 1 条：不是一个对象", "第 2 条：不是一个对象"]);
  });

  it("长画线在支持 gzip 时明显短于裸 JSON", async () => {
    const brush: StoredDrawing = {
      name: "brush",
      paneId: MAIN_PANE_ID,
      points: Array.from({ length: 400 }, (_, i) => ({ timestamp: T0 + i * 60_000, value: 1300 + Math.sin(i / 7) })),
    };
    const link = await createDrawingsShareLink([brush], {}, "https://x.test/pro-chart");
    const raw = JSON.stringify([brush]).length;
    if (gzipSupported()) expect(link.length).toBeLessThan(raw / 2);
    const back = await readDrawingsShareLink(link.url);
    expect(back.ok && back.drawings[0].points).toHaveLength(400);
  });
});

/* ---------------------------------------------------------------- filename */

describe("导出文件名", () => {
  it("带上标的、周期与日期", () => {
    expect(drawingsFileName("600519.SH", "1D", new Date(2026, 8, 5))).toBe("vt-drawings-600519.SH-1D-20260905.json");
  });

  it("非法字符换成下划线，空串退回 chart", () => {
    expect(drawingsFileName("BTC/USDT", "4h", new Date(2026, 0, 2))).toBe("vt-drawings-BTC_USDT-4h-20260102.json");
    expect(drawingsFileName("", "", new Date(2026, 0, 2))).toBe("vt-drawings-chart-chart-20260102.json");
    expect(drawingsFileName("  ", "1D", new Date(2026, 0, 2))).toBe("vt-drawings-chart-1D-20260102.json");
    expect(drawingsFileName("a b", "4h", new Date(2026, 0, 2))).toBe("vt-drawings-a_b-4h-20260102.json");
  });
});
