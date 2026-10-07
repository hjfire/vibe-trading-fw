import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { publishThemeChange } from "@/lib/theme-store";
import { DEFAULT_LEGEND_PREFS, LEGEND_PREFS_KEY } from "@/lib/chartLegend";
import { ProChart } from "../ProChart";

/**
 * Legend wiring (第③片 C). The regression this exists for is on the record
 * already: `chartStyles` is pushed whole through `setStyles` on every theme
 * flip, and when the 分时/candle choice lived outside that function, switching
 * themes quietly repainted it. Legend prefs join the same object, so they inherit
 * the same trap — hence "change a pref, *then* flip the theme, still there".
 */

const h = vi.hoisted(() => ({
  styles: [] as Array<Record<string, unknown>>,
  loader: null as null | {
    getBars: (p: {
      type: string;
      timestamp: number | null;
      period: unknown;
      symbol: { ticker: string };
      callback: (d: unknown[], m?: unknown) => void;
    }) => void | Promise<void>;
  },
}));

function styleAt(i: number): Record<string, unknown> {
  return h.styles[i];
}

/** `candle.tooltip.showRule` as the *i*-th pushed object carried it. */
function candleRule(i: number): unknown {
  const s = styleAt(i) as {
    candle?: { tooltip?: { showRule?: string }; type?: string };
  };
  return s.candle?.tooltip?.showRule;
}

function candleType(i: number): unknown {
  return (styleAt(i) as { candle?: { type?: string } }).candle?.type;
}

function tooltipTemplate(i: number): unknown[] {
  return (styleAt(i) as { candle: { tooltip: { legend: { template: unknown[] } } } }).candle.tooltip.legend
    .template;
}

/**
 * Only the legend fragment may be colour-free. The whole folded `chartStyles`
 * object legitimately writes `candle.bar.upColor/downColor/...`, `candle.area.lineColor`
 * and the grid/axis colours, so the library rule "图例样式片段里一个颜色键都不写"
 * binds the fragment subtrees this module owns — nothing else.
 */
function legendFragmentJson(i: number): string {
  const s = styleAt(i) as {
    candle?: { tooltip?: unknown; priceMark?: unknown };
    indicator?: { tooltip?: unknown };
  };
  return JSON.stringify([s.candle?.tooltip, s.candle?.priceMark, s.indicator?.tooltip]);
}

vi.mock("klinecharts", () => ({
  registerIndicator: vi.fn(),
  getSupportedLocales: () => ["en-US", "zh-CN"],
  registerLocale: vi.fn(),
  dispose: vi.fn(),
  init: () => ({
    getSymbol: () => ({ ticker: "600519.SH", pricePrecision: 2, volumePrecision: 0 }),
    getDataList: () => [],
    getIndicators: () => [],
    getOverlays: () => [],
    getPaneOptions: () => [{ id: "candle_pane", height: 300, minHeight: 30, state: "normal" }],
    setPaneOptions: vi.fn(),
    setDataLoader: (loader: typeof h.loader) => {
      h.loader = loader;
    },
    setSymbol: () => undefined,
    setPeriod: () => undefined,
    // The one recorded lever on the legend: v10 has no `setTooltipOptions`, so
    // `setStyles` is the only way a legend pref can reach the chart at all.
    setStyles: (s: Record<string, unknown>) => h.styles.push(s),
    resize: vi.fn(),
    createIndicator: vi.fn(),
    removeIndicator: vi.fn(),
    createOverlay: vi.fn(),
    removeOverlay: vi.fn(),
    overrideOverlay: vi.fn(),
    getOffsetRightDistance: () => 0,
    getBarSpace: () => ({ bar: 8, halfBar: 4, gapBar: 5, halfGapBar: 2 }),
  }),
}));

vi.mock("@/components/charts/WatchList", () => ({ default: () => null }));
vi.mock("@/components/charts/IndicatorEditor", () => ({ default: () => null }));

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const pushCount = () => h.styles.length;

beforeEach(() => {
  h.styles = [];
  h.loader = null;
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

describe("/pro-chart 图例偏好", () => {
  it("面板五项都在，默认值逐项等于库默认", async () => {
    render(<ProChart />);
    await flush();
    const open = screen.getByRole("button", { name: "图例" });
    expect(open.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(open);
    expect(screen.getByRole("button", { name: "图例" }).getAttribute("aria-pressed")).toBe("true");

    expect((screen.getByLabelText("主图图例显示规则") as HTMLSelectElement).value).toBe(
      DEFAULT_LEGEND_PREFS.candleRule,
    );
    expect((screen.getByLabelText("副图图例显示规则") as HTMLSelectElement).value).toBe(
      DEFAULT_LEGEND_PREFS.indicatorRule,
    );
    expect((screen.getByLabelText("涨幅行") as HTMLInputElement).checked).toBe(DEFAULT_LEGEND_PREFS.showChange);
    expect(screen.getByRole("button", { name: "高低标记" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "最新价线" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("改一项就 push 一次含新值的样式，并把偏好写进存储", async () => {
    render(<ProChart />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "图例" }));
    const before = pushCount();

    fireEvent.change(screen.getByLabelText("主图图例显示规则"), { target: { value: "follow_cross" } });
    await flush();

    const s = styleAt(pushCount() - 1);
    expect((s as { candle: { tooltip: { showRule: string } } }).candle.tooltip.showRule).toBe("follow_cross");
    expect(pushCount()).toBeGreaterThan(before);
    expect(JSON.parse(localStorage.getItem(LEGEND_PREFS_KEY) ?? "{}")).toMatchObject({
      candleRule: "follow_cross",
    });
  });

  it("改完图例再切主题，偏好还在，candle.type 也还在（历史冲掉回归点）", async () => {
    render(<ProChart />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "图例" }));
    fireEvent.change(screen.getByLabelText("主图图例显示规则"), { target: { value: "none" } });
    await flush();
    expect(candleRule(pushCount() - 1)).toBe("none");

    act(() => {
      document.documentElement.classList.add("dark");
      publishThemeChange();
    });
    await flush();

    const last = pushCount() - 1;
    expect(candleRule(last)).toBe("none");
    // The other half of the same trap: the theme push must not lose the candle
    // type either (that is the bug the 分时 slice already paid for).
    expect(candleType(last)).toBe("candle_solid");
    expect(candleRule(last - 1)).toBe("none");
  });

  it("涨幅行勾上后模板多出第 7 行，取消又回到 6 行", async () => {
    render(<ProChart />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "图例" }));
    const box = screen.getByLabelText("涨幅行");
    fireEvent.click(box);
    await flush();
    expect(tooltipTemplate(pushCount() - 1)).toHaveLength(7);
    fireEvent.click(screen.getByLabelText("涨幅行"));
    await flush();
    expect(tooltipTemplate(pushCount() - 1)).toHaveLength(6);
  });

  it("两个开关各自落到 priceMark 的对应键，图例片段里没有颜色键", async () => {
    render(<ProChart />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "图例" }));
    fireEvent.click(screen.getByRole("button", { name: "最新价线" }));
    await flush();
    const last = pushCount() - 1;
    const mark = (styleAt(last) as { candle: { priceMark: Record<string, unknown> } }).candle.priceMark;
    expect(mark.last).toEqual({ show: false, line: { show: false }, text: { show: false } });
    expect(legendFragmentJson(last)).not.toMatch(/[Cc]olor/);
    // Scoping proof, not decoration: the page's own candle colours are still in
    // the very same pushed object, so the fragment-level check above is the
    // discriminating one and a whole-object check could never pass.
    expect(JSON.stringify((styleAt(last) as { candle: { bar: Record<string, string> } }).candle.bar)).toMatch(
      /upColor/,
    );
    fireEvent.click(screen.getByRole("button", { name: "高低标记" }));
    await flush();
    const m2 = (styleAt(pushCount() - 1) as {
      candle: { priceMark: Record<string, { show: boolean }> };
    }).candle.priceMark;
    expect(m2.high.show).toBe(false);
    expect(m2.low.show).toBe(false);
  });

  it("没动过偏好的用户：首屏样式对象里图例三项等于库默认", async () => {
    render(<ProChart />);
    await flush();
    expect(candleRule(0)).toBe("always");
    const s = styleAt(0) as {
      indicator?: { tooltip?: { showRule?: string } };
      candle?: { priceMark?: Record<string, unknown> };
    };
    expect(s.indicator?.tooltip?.showRule).toBe("always");
    expect(s.candle?.priceMark?.last).toEqual({ show: true, line: { show: true }, text: { show: true } });
    // `setStyles` REPLACES the template (`StoreImp.setStyles` special-cases
    // `candle.tooltip.legend.template`), so a push carrying a short template
    // deletes legend rows for the user. The first screen must hand over the
    // library's full six rows even when nothing was ever changed.
    expect(tooltipTemplate(0)).toHaveLength(6);
    expect(localStorage.getItem(LEGEND_PREFS_KEY)).toBeNull(); // 偏好不落盘，除非用户改过
  });

  it("连改两项，存储里两个偏差都在（patchLegend 传的是合成后的整体）", async () => {
    render(<ProChart />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "图例" }));
    fireEvent.change(screen.getByLabelText("主图图例显示规则"), { target: { value: "none" } });
    await flush();
    fireEvent.change(screen.getByLabelText("副图图例显示规则"), { target: { value: "follow_cross" } });
    await flush();

    const stored = JSON.parse(localStorage.getItem(LEGEND_PREFS_KEY) ?? "{}");
    expect(stored).toMatchObject({ candleRule: "none", indicatorRule: "follow_cross" });
    // And the second change did not paint the first one back out of the chart.
    expect(candleRule(pushCount() - 1)).toBe("none");
    expect((styleAt(pushCount() - 1) as { indicator: { tooltip: { showRule: string } } }).indicator.tooltip.showRule).toBe(
      "follow_cross",
    );
  });

  it("改回全默认会把键删掉，页面对图例存储只有 saveLegendPrefs 这一个写者", async () => {
    render(<ProChart />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "图例" }));
    fireEvent.click(screen.getByLabelText("涨幅行"));
    await flush();
    expect(JSON.parse(localStorage.getItem(LEGEND_PREFS_KEY) ?? "{}")).toMatchObject({ showChange: true });
    fireEvent.click(screen.getByLabelText("涨幅行"));
    await flush();
    expect(localStorage.getItem(LEGEND_PREFS_KEY)).toBeNull();
  });
});
