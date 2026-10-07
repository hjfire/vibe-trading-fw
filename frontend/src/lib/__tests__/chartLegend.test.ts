import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_LEGEND_PREFS,
  LEGEND_PREFS_KEY,
  RULE_OPTIONS,
  legendStyles,
  legendTemplate,
  loadLegendPrefs,
  normalizeLegendPrefs,
  saveLegendPrefs,
} from "../chartLegend";

/**
 * Legend preferences (推荐清单第③片 C).
 *
 * What is being guarded, in one line each: the defaults must equal the library's
 * own (§二.8) so a user who never opens the panel sees the same picture; the
 * fragment must not carry a single colour key, or it fights `chartStyles`' red-up
 * 主题面; and the reader must survive a dirty file by answering defaults,
 * because it runs before the first paint.
 *
 * The library facts quoted here were read out of `node_modules/klinecharts/dist/
 * index.esm.js` before this file was written: the six default rows at 11524-11531,
 * `candle.tooltip.showRule: 'always'` at 11485, `indicator.tooltip.showRule:
 * 'always'` at 11623, `priceMark.{high,low,last,last.line,last.text}.show: true`
 * at 11397-11466, and `setTooltipOptions` — 0 hits in both the bundle and the
 * .d.ts.
 */

const LIB_TEMPLATE = [
  { title: "time", value: "{time}" },
  { title: "open", value: "{open}" },
  { title: "high", value: "{high}" },
  { title: "low", value: "{low}" },
  { title: "close", value: "{close}" },
  { title: "volume", value: "{volume}" },
];

/**
 * The value-bearing paths the fragment may write, fixed by the plan: 只产
 * `show` / `showRule` / `template` 三类键. Task 7 spreads this object into
 * `chartStyles`, and `chartStyles` is re-pushed whole on every theme flip, so a
 * key that is not on this list is a key nobody asked for — a colour, a
 * `showType`, an `extendTexts` timer would all ride in silently and nothing else
 * in this slice would notice.
 */
const FRAGMENT_PATHS = [
  "candle.priceMark.high.show",
  "candle.priceMark.last.line.show",
  "candle.priceMark.last.show",
  "candle.priceMark.last.text.show",
  "candle.priceMark.low.show",
  "candle.tooltip.legend.template",
  "candle.tooltip.showRule",
  "indicator.tooltip.showRule",
];

/** Arrays are values here (the template rows), not structure to walk into. */
function leafPaths(node: unknown, trail: string[] = []): string[] {
  if (Array.isArray(node) || node === null || typeof node !== "object") return [trail.join(".")];
  return Object.entries(node as Record<string, unknown>)
    .flatMap(([key, value]) => leafPaths(value, [...trail, key]))
    .sort();
}

beforeEach(() => localStorage.clear());

describe("默认值等于库默认", () => {
  it("always / always / 涨幅关 / 高低开 / 最新价开", () => {
    expect(DEFAULT_LEGEND_PREFS).toEqual({
      candleRule: "always",
      indicatorRule: "always",
      showChange: false,
      highLowMark: true,
      lastPriceLine: true,
    });
  });

  it("默认模板与库的六行逐键相等，且顺序一致", () => {
    expect(legendTemplate(DEFAULT_LEGEND_PREFS)).toEqual(LIB_TEMPLATE);
  });

  it("勾上涨幅是七行，新增行落在 volume 之后", () => {
    const rows = legendTemplate({ ...DEFAULT_LEGEND_PREFS, showChange: true });
    expect(rows).toHaveLength(7);
    expect(rows[6]).toEqual({ title: "change", value: "{change}" });
    expect(rows.slice(0, 6)).toEqual(LIB_TEMPLATE);
  });
});

describe("样式片段", () => {
  it("只产 show / showRule / template 三类键，一个颜色键都不写", () => {
    const json = JSON.stringify(legendStyles({ ...DEFAULT_LEGEND_PREFS, showChange: true }));
    expect(json).not.toMatch(/[Cc]olor/);
    expect(json).not.toMatch(/[Uu]p|[Dd]own/);
  });

  it("片段的可写路径逐条钉死，叶键只许三类", () => {
    for (const prefs of [
      DEFAULT_LEGEND_PREFS,
      { ...DEFAULT_LEGEND_PREFS, showChange: true, candleRule: "none", highLowMark: false },
    ] as const) {
      const paths = leafPaths(legendStyles(prefs));
      expect(paths).toEqual(FRAGMENT_PATHS);
      expect([...new Set(paths.map((path) => path.split(".").pop()))].sort()).toEqual(["show", "showRule", "template"]);
    }
  });

  it("三态与两个开关各归其位", () => {
    const s = legendStyles({
      candleRule: "follow_cross",
      indicatorRule: "none",
      showChange: true,
      highLowMark: false,
      lastPriceLine: false,
    });
    expect(s.candle.tooltip.showRule).toBe("follow_cross");
    expect(s.indicator.tooltip.showRule).toBe("none");
    expect(s.candle.priceMark.high.show).toBe(false);
    expect(s.candle.priceMark.low.show).toBe(false);
    // One preference drives all three last-price keys: TV hides line *and* tag,
    // and a lone tag left on the axis is not a thing a user asks for.
    expect(s.candle.priceMark.last).toEqual({ show: false, line: { show: false }, text: { show: false } });
    expect(s.candle.tooltip.legend.template).toHaveLength(7);
  });

  it("默认态下片段全是库默认的那几个值", () => {
    const s = legendStyles(DEFAULT_LEGEND_PREFS);
    expect(s.candle.tooltip.showRule).toBe("always");
    expect(s.indicator.tooltip.showRule).toBe("always");
    expect(s.candle.priceMark.high.show).toBe(true);
    expect(s.candle.priceMark.low.show).toBe(true);
    expect(s.candle.priceMark.last).toEqual({ show: true, line: { show: true }, text: { show: true } });
  });
});

describe("读偏好：脏值回默认，不抛", () => {
  it("读不到就是默认，且不写回", () => {
    expect(loadLegendPrefs()).toEqual(DEFAULT_LEGEND_PREFS);
    expect(localStorage.getItem(LEGEND_PREFS_KEY)).toBeNull();
  });

  it("非 JSON／数组／未知 showRule／字符串布尔／缺键／多余的成交额键都回默认", () => {
    /** `[stored value, what the reader must answer]` — the dirty file never wins. */
    const cases: Array<[string, typeof DEFAULT_LEGEND_PREFS]> = [
      ["{not json", DEFAULT_LEGEND_PREFS],
      ["[]", DEFAULT_LEGEND_PREFS],
      ["null", DEFAULT_LEGEND_PREFS],
      [JSON.stringify({ candleRule: "sometimes" }), DEFAULT_LEGEND_PREFS],
      [JSON.stringify({ showChange: "true" }), DEFAULT_LEGEND_PREFS],
      [JSON.stringify({ highLowMark: 1 }), DEFAULT_LEGEND_PREFS],
      // 缺其余键 → 其余回默认；这一条是唯一带着合法键的脏值。
      [JSON.stringify({ candleRule: "none" }), { ...DEFAULT_LEGEND_PREFS, candleRule: "none" }],
      // 被否掉的那行（§二.12：数据面根本没有 turnover）
      [JSON.stringify({ ...DEFAULT_LEGEND_PREFS, showTurnover: true }), DEFAULT_LEGEND_PREFS],
    ];
    for (const [raw, expected] of cases) {
      localStorage.setItem(LEGEND_PREFS_KEY, raw);
      expect(loadLegendPrefs(), raw).not.toHaveProperty("showTurnover");
      expect(loadLegendPrefs(), raw).toEqual(expected);
    }
    localStorage.setItem(LEGEND_PREFS_KEY, JSON.stringify({ ...DEFAULT_LEGEND_PREFS, candleRule: "none" }));
    expect(loadLegendPrefs().candleRule).toBe("none");
    localStorage.setItem(LEGEND_PREFS_KEY, JSON.stringify({ ...DEFAULT_LEGEND_PREFS, showChange: "true" }));
    expect(loadLegendPrefs().showChange).toBe(false);
  });

  it("normalizeLegendPrefs 逐键取值，多余的键不带出去", () => {
    const p = normalizeLegendPrefs({ candleRule: "none", extra: 1 });
    expect(Object.keys(p).sort()).toEqual(["candleRule", "highLowMark", "indicatorRule", "lastPriceLine", "showChange"]);
    expect(p.candleRule).toBe("none");
  });

  it("存进去再读出来一致", () => {
    const p = { candleRule: "follow_cross", indicatorRule: "none", showChange: true, highLowMark: false, lastPriceLine: true } as const;
    saveLegendPrefs(p);
    expect(loadLegendPrefs()).toEqual(p);
  });

  it("下拉选项就是库的 TooltipShowRule 三值", () => {
    expect(RULE_OPTIONS.map((o) => o.value)).toEqual(["always", "follow_cross", "none"]);
  });
});
