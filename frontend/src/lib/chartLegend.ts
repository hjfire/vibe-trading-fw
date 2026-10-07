import type { TooltipLegend, TooltipShowRule } from "klinecharts";

/**
 * Legend preferences: the switches the library already has and this app never
 * exposed (推荐清单第③片 C).
 *
 * Two things about v10 are load-bearing here, and both were measured before this
 * file existed (see the spec's §二.7/§二.8/§二.12):
 *
 * 1. There is **no `setTooltipOptions`** — grep answers 0 in `index.d.ts` and in
 *    the bundle. `setStyles` is the only public lever on the legend, so this
 *    module's job is to produce *one* fragment shape, and `ProChart.chartStyles`
 *    is the only place allowed to fold it into the theme object. The theme
 *    effect pushes that whole object on every dark-mode flip; leaving these prefs
 *    out of its dependency list is how the last slice painted candles back over
 *    a 分时 line.
 * 2. `StoreImp.setStyles` deep-merges (`dist 13309-13322`) but **replaces** the
 *    `candle.tooltip.legend.template` array wholesale. So pushing the same prefs
 *    twice is idempotent and rows cannot duplicate — but a partial template
 *    would silently drop the library's rows, which is why `legendTemplate`
 *    returns the full list every time.
 *
 * No colour key is ever written from here: `{change}` takes its colour from
 * `candle.priceMark.last` (dist 7687), which this page's theme owns.
 * There is also no turnover row: the data pipeline never carries the field
 * (spec §二.12), so that row would print `n/a` forever — a claim, not a gap.
 */

export interface LegendPrefs {
  /** The 时间/开/高/低/收/量 block on the main chart. */
  candleRule: TooltipShowRule;
  /**
   * Every indicator legend row — including the ones drawn on the **candle**
   * pane, because the library gates all of them through one key,
   * `indicator.tooltip.showRule` (dist 7055-7062 read, 7238-7239 as the gate
   * itself). `IndicatorTooltipView.drawIndicatorTooltip` is called from the
   * candle widget's own draw path too (dist 7399-7405), and this page does put
   * indicators on the main pane (`createIndicator({paneId: MAIN_PANE_ID})`), so
   * picking 隐藏 takes the main chart's MA rows away with them. The name says
   * 指标图例, not 副图, for exactly that reason.
   */
  indicatorRule: TooltipShowRule;
  /** The extra `{change}` row. Default off — it is the one row that *adds* pixels. */
  showChange: boolean;
  /** The high/low price marks. Library default on. */
  highLowMark: boolean;
  /** Last price: line and tag together (one preference, three style keys). */
  lastPriceLine: boolean;
}

/** Every value below is the library's own default (spec §二.8), so a user who
 * never opens the 图例 panel gets the same picture as before this file.
 *
 * Frozen because it is exported: the deviation filter below and `legendStyles`
 * both read from it, and a consumer that mutated it in place would silently
 * repaint the page for everyone else on the same tab. The module only ever hands
 * out copies (`{ ...d }`), so freezing costs nothing. */
export const DEFAULT_LEGEND_PREFS: Readonly<LegendPrefs> = Object.freeze({
  candleRule: "always",
  indicatorRule: "always",
  showChange: false,
  highLowMark: true,
  lastPriceLine: true,
});

export const LEGEND_PREFS_KEY = "pro-chart.legend.v1";

/** The three states the panel offers, in the order the user reads them. */
export const RULE_OPTIONS: ReadonlyArray<{ value: TooltipShowRule; label: string }> = [
  { value: "always", label: "总是" },
  { value: "follow_cross", label: "跟随光标" },
  { value: "none", label: "隐藏" },
];

/** The library's own six rows (`dist 11524-11531`), plus the optional 涨幅 one. */
export function legendTemplate(p: LegendPrefs): TooltipLegend[] {
  const rows: TooltipLegend[] = [
    { title: "time", value: "{time}" },
    { title: "open", value: "{open}" },
    { title: "high", value: "{high}" },
    { title: "low", value: "{low}" },
    { title: "close", value: "{close}" },
    { title: "volume", value: "{volume}" },
  ];
  // Titles are *keys*, not Chinese: the library runs them through `i18n` again
  // (dist 7678) and zh_CN already carries `change: '涨幅：'` (dist 6973). Hardcoding
  // 中文 would print a Chinese row on an English UI.
  if (p.showChange) rows.push({ title: "change", value: "{change}" });
  return rows;
}

/** The style fragment this module owns — keys only, no colours. */
export interface LegendStyleFragment {
  candle: {
    tooltip: { showRule: TooltipShowRule; legend: { template: TooltipLegend[] } };
    priceMark: {
      high: { show: boolean };
      low: { show: boolean };
      last: { show: boolean; line: { show: boolean }; text: { show: boolean } };
    };
  };
  indicator: { tooltip: { showRule: TooltipShowRule } };
}

export function legendStyles(p: LegendPrefs): LegendStyleFragment {
  return {
    candle: {
      tooltip: { showRule: p.candleRule, legend: { template: legendTemplate(p) } },
      priceMark: {
        high: { show: p.highLowMark },
        low: { show: p.highLowMark },
        // One preference, three keys: 最新价 off means the line *and* the axis
        // tag go, because a lone tag is not a thing anybody asks for.
        last: { show: p.lastPriceLine, line: { show: p.lastPriceLine }, text: { show: p.lastPriceLine } },
      },
    },
    indicator: { tooltip: { showRule: p.indicatorRule } },
  };
}

function rule(raw: unknown, fallback: TooltipShowRule): TooltipShowRule {
  return RULE_OPTIONS.some((o) => o.value === raw) ? (raw as TooltipShowRule) : fallback;
}

function flag(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

/** Key by key, defaults for anything unrecognised; never throws, never writes. */
export function normalizeLegendPrefs(raw: unknown): LegendPrefs {
  const d = DEFAULT_LEGEND_PREFS;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...d };
  const o = raw as Record<string, unknown>;
  return {
    candleRule: rule(o.candleRule, d.candleRule),
    indicatorRule: rule(o.indicatorRule, d.indicatorRule),
    showChange: flag(o.showChange, d.showChange),
    highLowMark: flag(o.highLowMark, d.highLowMark),
    lastPriceLine: flag(o.lastPriceLine, d.lastPriceLine),
  };
}

export function loadLegendPrefs(): LegendPrefs {
  try {
    const raw = localStorage.getItem(LEGEND_PREFS_KEY);
    if (!raw) return { ...DEFAULT_LEGEND_PREFS };
    return normalizeLegendPrefs(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_LEGEND_PREFS };
  }
}

/**
 * 未偏离默认的键一律不落盘（Global Constraint「默认态逐像素不变」的写侧）。
 *
 * Writing the whole object would freeze today's library defaults into user
 * storage: the day klinecharts changes a default, every user who ever flipped
 * one switch keeps the old value and no upgrade can reach them. So only
 * deviations are persisted, and an all-defaults write deletes the key instead —
 * which also makes the constraint true for the *second* case, not just for users
 * who never touched the panel.
 *
 * Normalizing first is the same discipline as `load*` (`<select>` gives strings,
 * a stale cast gives anything): junk never reaches storage, and a value the
 * reader would answer as a default cannot be written as a deviation.
 */
export function saveLegendPrefs(p: LegendPrefs): void {
  try {
    const next = normalizeLegendPrefs(p);
    const deviated: Partial<LegendPrefs> = {};
    if (next.candleRule !== DEFAULT_LEGEND_PREFS.candleRule) deviated.candleRule = next.candleRule;
    if (next.indicatorRule !== DEFAULT_LEGEND_PREFS.indicatorRule) deviated.indicatorRule = next.indicatorRule;
    if (next.showChange !== DEFAULT_LEGEND_PREFS.showChange) deviated.showChange = next.showChange;
    if (next.highLowMark !== DEFAULT_LEGEND_PREFS.highLowMark) deviated.highLowMark = next.highLowMark;
    if (next.lastPriceLine !== DEFAULT_LEGEND_PREFS.lastPriceLine) deviated.lastPriceLine = next.lastPriceLine;
    if (Object.keys(deviated).length === 0) {
      localStorage.removeItem(LEGEND_PREFS_KEY);
      return;
    }
    localStorage.setItem(LEGEND_PREFS_KEY, JSON.stringify(deviated));
  } catch {
    /* best effort */
  }
}
