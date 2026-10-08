import { act, render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { publishThemeChange } from "@/lib/theme-store";
import { CANDLE_COLORS } from "@/lib/chartPalette";
import { HEIKIN_ASHI_PREFS_KEY } from "@/lib/heikinAshiChart";
import { ProChart } from "../ProChart";

// 只有 `act`/`render`：`fireEvent`/`screen` 是点击类判据（工具栏按钮那一片）的活，
// 现在写进来就是一份未使用声明——`tsconfig` 的 `noUnusedLocals` 会当场判红，页面的
// import 面同理（见 `ProChart.tsx` 那条只此三项的 import）。

/**
 * Heikin-Ashi 的页面接线（推荐清单第④片，spec §二·6/§七·4/§七·5）。
 *
 * 两条主判据：
 * 1. 样式只有一个合成点。`chartStyles` 整个对象会被主题 effect 在每次换主题时重推，
 *    所以「九色透明」这个状态如果没同时进形参表和依赖数组，切主题就会把真蜡烛刷回来——
 *    本文件里那条切主题的测试就是这个历史故障的形状（同 `ProChartLegend.test.tsx:150`）。
 * 2. HA 只改像素。开与关都不许动 `getDataList()` 的内容、不许动蜡烛图例模板、
 *    不许写 `candle.priceMark`（那是图例偏好的子树）。
 */

const h = vi.hoisted(() => ({
  styles: [] as Array<Record<string, unknown>>,
  indicators: [] as Array<{ name: string; paneId: string; id: string }>,
  created: [] as Array<Record<string, unknown>>,
  // 每次 `overrideOverlay` 收到的是什么。第⑤片的真值边界钉用它判「切 HA 不该重锚画线」，
  // 所以判据是「切换前后这个数组没长」，不是「它等于空」。
  overridden: [] as unknown[],
  list: [] as Array<Record<string, unknown>>,
  loader: null as null | {
    getBars: (p: {
      type: string;
      timestamp: number | null;
      period: unknown;
      symbol: { ticker: string };
      callback: (data: unknown[], more?: unknown) => void;
    }) => void | Promise<void>;
  },
}));

/**
 * 页面唯一的数据入口。替身只驱动 `init`：本片不分页，但 `init` 必须真的被回答一次，
 * 因为 `setBarCount`（`ProChart.tsx:1112`）只在那一次发生，而按钮的 disabled 判据读它。
 */
function ask(): void {
  if (!h.loader) throw new Error("页面没有装 DataLoader");
  void Promise.resolve(
    h.loader.getBars({
      type: "init",
      timestamp: null,
      period: { type: "day", span: 1 },
      symbol: { ticker: "600519.SH" },
      // 库会把答案装进 store；替身的 store 就是 `h.list`，已经在那儿了。
      callback: () => undefined,
    }),
  ).catch(() => undefined);
}

function styleAt(i: number): Record<string, unknown> {
  return h.styles[i];
}

const pushCount = () => h.styles.length;

function barOf(i: number): Record<string, unknown> {
  return {
    timestamp: 1_700_000_000_000 + i * 86_400_000,
    open: 100 + i,
    high: 105 + i,
    low: 95 + i,
    close: 102 + i,
    volume: 1000 + i,
  };
}

/**
 * 摆好 `h.list` 再 render：`ask()` 会把这份数组原样交回页面，`barCount` 因此离开 0。
 * 同步函数不是偷懒——数据是在 render 的 init effect 里被替身主动要走的，先摆好就行；
 * 一个 `await` 反而会把「页面装 loader」和「页面问数据」两次副作用拆成两个宏任务，
 * 让样式推送的下标读起来比测试作者预期的多一格。
 */
function seed(count = 6): void {
  h.list = Array.from({ length: count }, (_, i) => barOf(i));
}

/** `candle.bar` as the i-th push carried it. */
function barColors(i: number): Record<string, unknown> {
  return (styleAt(i) as { candle?: { bar?: Record<string, unknown> } }).candle?.bar ?? {};
}

function candleType(i: number): unknown {
  return (styleAt(i) as { candle?: { type?: string } }).candle?.type;
}

function priceMark(i: number): unknown {
  return (styleAt(i) as { candle?: { priceMark?: unknown } }).candle?.priceMark;
}

function tooltipTemplate(i: number): unknown[] {
  return (styleAt(i) as { candle: { tooltip: { legend: { template: unknown[] } } } }).candle.tooltip.legend.template;
}

vi.mock("klinecharts", () => ({
  registerIndicator: vi.fn(),
  getSupportedLocales: () => ["en-US", "zh-CN"],
  registerLocale: vi.fn(),
  dispose: vi.fn(),
  init: () => ({
    getSymbol: () => ({ ticker: "600519.SH", pricePrecision: 2, volumePrecision: 0 }),
    getDataList: () => h.list,
    // 有状态版本：第④片的挂卸判据要能回答「图上现在有哪些指标」。
    getIndicators: (filter?: { name?: string; id?: string; paneId?: string }) =>
      h.indicators.filter((ind) => {
        if (filter?.name !== undefined && ind.name !== filter.name) return false;
        if (filter?.id !== undefined && ind.id !== filter.id) return false;
        if (filter?.paneId !== undefined && ind.paneId !== filter.paneId) return false;
        return true;
      }),
    createIndicator: (value: { name: string; paneId?: string }) => {
      h.created.push(value as Record<string, unknown>);
      h.indicators.push({ name: value.name, paneId: value.paneId ?? `sub:${value.name}`, id: `i${h.indicators.length}` });
      return true;
    },
    removeIndicator: (filter: { name?: string; id?: string; paneId?: string }) => {
      const before = h.indicators.length;
      h.indicators = h.indicators.filter(
        (ind) =>
          (filter?.name === undefined || ind.name !== filter.name) &&
          (filter?.id === undefined || ind.id !== filter.id) &&
          (filter?.paneId === undefined || ind.paneId !== filter.paneId),
      );
      return h.indicators.length < before;
    },
    getOverlays: () => [],
    getPaneOptions: () => [{ id: "candle_pane", height: 300, minHeight: 30, state: "normal" }],
    setPaneOptions: vi.fn(),
    // 装 loader 的那一格是整份替身的关键：不接，页面就没地方要数据，`barCount` 停在 0。
    setDataLoader: (loader: typeof h.loader) => {
      h.loader = loader;
    },
    // 真实库里 `setSymbol`/`setPeriod`/`resetData` 各自触发一次 `init` 取数
    // （StoreImp.resetData, dist 13652）。分时切换走 `setPeriod`，所以三个都得问。
    setSymbol: () => ask(),
    setPeriod: () => ask(),
    resetData: () => ask(),
    setStyles: (s: Record<string, unknown>) => h.styles.push(s),
    resize: vi.fn(),
    createOverlay: vi.fn(),
    removeOverlay: vi.fn(),
    // 录制版：第⑤片的「切 HA 不重锚画线」判据读的是这个数组的长度增量。
    overrideOverlay: (o: unknown) => {
      h.overridden.push(o);
      return true;
    },
    getOffsetRightDistance: () => 0,
    setOffsetRightDistance: vi.fn(),
    getBarSpace: () => ({ bar: 8, halfBar: 4, gapBar: 5, halfGapBar: 2 }),
    setBarSpace: vi.fn(),
    scrollToRealTime: vi.fn(),
    // `to`/`realTo` 是排他的（klinecharts 游标契约），所以直接给数据长度。
    getVisibleRange: () => ({
      from: 0,
      to: h.list.length,
      realFrom: 0,
      realTo: h.list.length,
    }),
    // jsdom 里没有真的盒子：`fitSessionToWidth` 读到 `undefined` 宽度就走它自己
    // 那句「leave the zoom alone」（`ProChart.tsx:891`），这正是本片要的分支。
    getDom: () => undefined,
  }),
}));

vi.mock("@/lib/marketApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/marketApi")>();
  return {
    ...actual,
    fetchKline: async (params: { before?: number | null }) => ({
      bars: params.before == null ? h.list : [],
      source: "fake",
      symbol: "600519.SH",
      interval: "1D",
      ok: true,
    }),
  };
});

vi.mock("@/components/charts/WatchList", () => ({ default: () => null }));
vi.mock("@/components/charts/IndicatorEditor", () => ({ default: () => null }));

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const NINE_BAR_KEYS = [
  "upColor",
  "downColor",
  "noChangeColor",
  "upBorderColor",
  "downBorderColor",
  "noChangeBorderColor",
  "upWickColor",
  "downWickColor",
  "noChangeWickColor",
] as const;

beforeEach(() => {
  h.styles = [];
  h.indicators = [];
  h.created = [];
  h.overridden = [];
  h.loader = null;
  // 默认就带上 bar：真实使用里图上有数据，按钮的 `barCount > 0` 判据不该替测试挡路。
  // 要空图的那条自己 `h.list = []` 再 render（第⑤片那条就是）。
  seed();
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

describe("/pro-chart 平均K线的样式链", () => {
  it("默认关：九色是调色板值，type 是 candle_solid，一个 transparent 都不写", async () => {
    render(<ProChart />);
    await flush();
    const last = pushCount() - 1;
    const colors = barColors(last);
    expect(Object.keys(colors)).toHaveLength(9);
    for (const key of NINE_BAR_KEYS) expect(colors[key]).not.toBe("transparent");
    expect(colors.upColor).toBe(CANDLE_COLORS.up);
    expect(colors.downWickColor).toBe(CANDLE_COLORS.down);
    expect(candleType(last)).toBe("candle_solid");
  });

  it("偏好开：首次推送就九色全透明，type 仍是 candle_solid", async () => {
    localStorage.setItem(HEIKIN_ASHI_PREFS_KEY, "1");
    render(<ProChart />);
    await flush();
    const last = pushCount() - 1;
    for (const key of NINE_BAR_KEYS) expect(barColors(last)[key]).toBe("transparent");
    // `type` 归分时开关所有。HA 抢它＝破坏 chartStyles:294-298 的顺序契约。
    expect(candleType(last)).toBe("candle_solid");
  });

  it("开着 HA 切主题：九色仍透明，type 仍 candle_solid（漏依赖数组就红）", async () => {
    localStorage.setItem(HEIKIN_ASHI_PREFS_KEY, "1");
    render(<ProChart />);
    await flush();
    const before = pushCount();

    act(() => {
      document.documentElement.classList.add("dark");
      publishThemeChange();
    });
    await flush();

    expect(pushCount()).toBeGreaterThan(before);
    const last = pushCount() - 1;
    for (const key of NINE_BAR_KEYS) expect(barColors(last)[key]).toBe("transparent");
    expect(candleType(last)).toBe("candle_solid");
    // 同一次推送里两半都在：主题重推的是整个 chartStyles 对象。
    expect(last).toBeGreaterThanOrEqual(1);
  });

  it("HA 不写 priceMark（那棵子树归图例偏好所有），也不动蜡烛图例模板", async () => {
    localStorage.setItem(HEIKIN_ASHI_PREFS_KEY, "1");
    render(<ProChart />);
    await flush();
    const last = pushCount() - 1;
    // 图例偏好默认 highLowMark/lastPriceLine 都开 ⇒ priceMark 仍是片段给的那棵，
    // HA 侧写它就是把用户开关静默覆盖。
    expect(priceMark(last)).toEqual({
      high: { show: true },
      low: { show: true },
      last: { show: true, line: { show: true }, text: { show: true } },
    });
    expect(JSON.stringify(tooltipTemplate(last))).toBe(
      JSON.stringify([
        { title: "time", value: "{time}" },
        { title: "open", value: "{open}" },
        { title: "high", value: "{high}" },
        { title: "low", value: "{low}" },
        { title: "close", value: "{close}" },
        { title: "volume", value: "{volume}" },
      ]),
    );
  });
});
