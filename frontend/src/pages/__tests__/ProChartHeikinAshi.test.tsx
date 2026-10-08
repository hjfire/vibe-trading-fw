import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { publishThemeChange } from "@/lib/theme-store";
import { CANDLE_COLORS } from "@/lib/chartPalette";
import { HEIKIN_ASHI_PREFS_KEY } from "@/lib/heikinAshiChart";
import { ProChart } from "../ProChart";

// `fireEvent`/`screen` 到本片（T4）才真有消费者：工具栏「平均K线」那颗按钮，以及为它
// 钉分时互斥而点的「分时」。上一片先把它们写进来就是一份未使用声明——`tsconfig` 的
// `noUnusedLocals` 会当场判红，页面的 import 面同理（那里一项都没有要先删后挂的名字）。

/**
 * Heikin-Ashi 的页面接线（推荐清单第④片，spec §二·6/§七·4/§七·5）。
 *
 * 两条主判据：
 * 1. 样式只有一个合成点。`chartStyles` 整个对象会被主题 effect 在每次换主题时重推，
 *    所以「九色透明」这个状态只要没进推送点的第四个实参，切主题就会把真蜡烛刷回来——
 *    本文件那条切主题的测试钉的是**第四个实参**（同 `ProChartLegend.test.tsx:150` 的形状）。
 *    **依赖数组**那一半归下面第二个 describe（T4「挂卸与互斥」）的第一条：那里只有 `haOn`
 *    在动，`dark`/`timeShare`/`legend` 一格都没变，所以把 `haOn` 从数组里摘掉，那一次点击
 *    就不会有任何 `setStyles`，最后一格仍是挂载时那份调色板色 ⇒ 判据当场红。
 * 2. HA 只改像素。开与关都不许动 `getDataList()` 的内容、不许动蜡烛图例模板、
 *    不许写 `candle.priceMark`（那是图例偏好的子树）。
 */

const h = vi.hoisted(() => ({
  styles: [] as Array<Record<string, unknown>>,
  // `init` 第二个入参里的 `styles` 选项，单独一格：那是 **init 推送点**
  // （`ProChart.tsx:1062`）唯一的出口，真机上首屏第一份样式就是它。不接住它，那一次调用
  // 就把合成好的对象丢进黑洞，`chartStyles(dark, session.timeShare, legend, false)` 写错
  // 也一个字都不会红。与 `styles`（`setStyles` 的录制，只有主题 effect `:1328` 那一处会写）
  // 分开记，两个推送点各有各的钉子，下标不会互相顶掉。
  initStyles: [] as Array<Record<string, unknown>>,
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
 * 因为 `setBarCount`（`ProChart.tsx:1164`）只在那一次发生，而按钮的 disabled 判据读它。
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

/** `candle.bar` as the i-th `setStyles` push carried it. */
function barColors(i: number): Record<string, unknown> {
  return (styleAt(i) as { candle?: { bar?: Record<string, unknown> } }).candle?.bar ?? {};
}

/** `candle.bar` as the **init 推送点**（`init` 的 `styles` 选项，`ProChart.tsx:1062`）carried it. */
function initBarColors(): Record<string, unknown> {
  return (h.initStyles[0] as { candle?: { bar?: Record<string, unknown> } } | undefined)?.candle?.bar ?? {};
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
  // 接住 `init` 的 `styles` 选项再交回同一张方法面：那是 **init 推送点**
  // （`ProChart.tsx:1062`）唯一的出口。不接，页面在那儿合成好的对象就被替身扔掉，
  // `chartStyles(dark, session.timeShare, legend, false)` 写错也不会红（见 `h.initStyles`）。
  init: (_host: unknown, options?: { styles?: Record<string, unknown> }) => {
    h.initStyles.push(options?.styles ?? {});
    return {
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
      // 那句「leave the zoom alone」（`ProChart.tsx:918`），这正是本片要的分支。
      getDom: () => undefined,
    };
  },
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
  h.initStyles = [];
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

  it("偏好开：首屏两处推送点都九色全透明（init 选项＋setStyles 第 0 格），type 仍是 candle_solid", async () => {
    localStorage.setItem(HEIKIN_ASHI_PREFS_KEY, "1");
    render(<ProChart />);
    await flush();
    // 首屏有两个合成点，各钉一次——只读 `last` 的话 init 点没人管：
    // - `init` 的 `styles` 选项（`ProChart.tsx:1062`）＝真机落到图上的第一份样式；
    // - 主题 effect（`:1328`，本页唯一的 `setStyles` 出口）挂载那一次＝`h.styles[0]`，
    //   挂载时它也正是 `last`（首屏只有这一次 `setStyles`）。
    const last = pushCount() - 1;
    const initColors = initBarColors();
    for (const key of NINE_BAR_KEYS) {
      expect(initColors[key]).toBe("transparent");
      expect(barColors(last)[key]).toBe("transparent");
    }
    // `type` 归分时开关所有。HA 抢它＝破坏 chartStyles:294-298 的顺序契约。
    expect(candleType(last)).toBe("candle_solid");
  });

  // 这条钉的是**主题推送点（`ProChart.tsx:1328` 那一行 `setStyles`）的第四个实参**：换主题时
  // 页面把整个 `chartStyles` 重推一遍，重推那一次的 `candle.bar` 必须仍是九色透明（那一格
  // 写成常量，调色板值就当场把真蜡烛刷回图上，而挂载着的 HA 指标还在画它的平滑蜡烛）。
  // 这条自己钉不到**依赖数组 `:1329`**：叫醒它的是 `dark`，闭包拿到的已经是当前 `haOn`
  // ⇒ 单看这条，把 `:1329` 里的 `haOn` 删掉仍绿。那一格的钉子由下面 T4 那组的第一条负责
  // ——那里只动 `haOn`，`dark`/`timeShare`/`legend` 一格都没变。
  it("开着 HA 切主题：主题重推那一次的第四个实参仍九色透明，type 仍 candle_solid", async () => {
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
    // 两半在**同一个**被推送的对象里：主题重推的是整个 `chartStyles`，不是各推一半的
    // 两次调用。`toMatchObject` 读的是 `last` 那一格本身，所以任何一半漏了都会红
    // （原来那句 `last >= 1` 只是把上一条 `pushCount() > before` 重说一遍，永远红不了）。
    expect(styleAt(last)).toMatchObject({
      candle: { bar: { upColor: "transparent" }, priceMark: { last: { show: true } } },
    });
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

describe("/pro-chart 平均K线的挂卸与互斥", () => {
  // `beforeEach` 已经 `seed()` 过，bar 是有的；`h.created` 之所以在点之前清一次，
  // 是因为 init 那一路 `syncPriceOverlay`/`syncSubPanes` 已经创建过 MA／VOL／MACD
  // （`ProChart.tsx:1280,1286`），计数判据要数的是「这次点按钮创建了几个」。
  // `h.indicators` 与 `h.styles` **不许**清：它们是「主图现在载着什么」的唯一真相，
  // 清掉就把「挂 HA 不吃掉 MA」那条钉成了假绿。
  const haCreates = () => h.created.filter((c) => (c as { name?: string }).name === "HEIKIN_ASHI");

  it("点一次：先删后挂到 candle_pane，并创建的是 HEIKIN_ASHI", async () => {
    render(<ProChart />);
    await flush();
    h.created = [];
    fireEvent.click(screen.getByRole("button", { name: "平均K线" }));
    await flush();
    expect(haCreates()).toHaveLength(1);
    expect(haCreates()[0]).toMatchObject({ name: "HEIKIN_ASHI", paneId: "candle_pane" });
    expect(h.indicators.find((i) => i.name === "HEIKIN_ASHI")?.paneId).toBe("candle_pane");
    for (const key of NINE_BAR_KEYS) expect(barColors(pushCount() - 1)[key]).toBe("transparent");
    expect(localStorage.getItem(HEIKIN_ASHI_PREFS_KEY)).toBe("1");
    expect(screen.getByRole("button", { name: "平均K线" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("连点两次回到原样：指标卸掉、九色恢复、键被删", async () => {
    render(<ProChart />);
    await flush();
    const button = screen.getByRole("button", { name: "平均K线" });
    fireEvent.click(button);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "平均K线" }));
    await flush();
    expect(h.indicators.find((i) => i.name === "HEIKIN_ASHI")).toBeUndefined();
    for (const key of NINE_BAR_KEYS) expect(barColors(pushCount() - 1)[key]).not.toBe("transparent");
    expect(localStorage.getItem(HEIKIN_ASHI_PREFS_KEY)).toBeNull();
    expect(screen.getByRole("button", { name: "平均K线" }).getAttribute("aria-pressed")).toBe("false");
    // 卸载 HA 不能顺手把主图的 MA 也带走（removeIndicator 的过滤面只有 name）。
    expect(h.indicators.some((i) => i.name === "MA")).toBe(true);
  });

  it("反复开关不堆叠：HEIKIN_ASHI 在 created 里出现的次数等于按的次数", async () => {
    render(<ProChart />);
    await flush();
    h.created = [];
    for (let i = 0; i < 3; i++) {
      fireEvent.click(screen.getByRole("button", { name: "平均K线" }));
      await flush();
      fireEvent.click(screen.getByRole("button", { name: "平均K线" }));
      await flush();
    }
    expect(haCreates()).toHaveLength(3);
    expect(h.indicators.filter((i) => i.name === "HEIKIN_ASHI")).toHaveLength(0);
  });

  it("开着 HA 进分时：指标卸掉、九色恢复、type 变 area；回 K 线又自己回来", async () => {
    localStorage.setItem(HEIKIN_ASHI_PREFS_KEY, "1");
    render(<ProChart />);
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "分时" }));
    });
    await flush();
    expect(h.indicators.find((i) => i.name === "HEIKIN_ASHI")).toBeUndefined();
    const last = pushCount() - 1;
    for (const key of NINE_BAR_KEYS) expect(barColors(last)[key]).not.toBe("transparent");
    expect(candleType(last)).toBe("area");
    // 分时那一行的按钮 pressed 必是 false：图上是面积线，说 true 就是骗。
    expect(screen.getByRole("button", { name: "平均K线" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "平均K线" }).getAttribute("title")).toContain("分时是面积线");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "分时" }));
    });
    await flush();
    expect(h.indicators.find((i) => i.name === "HEIKIN_ASHI")?.paneId).toBe("candle_pane");
    for (const key of NINE_BAR_KEYS) expect(barColors(pushCount() - 1)[key]).toBe("transparent");
    expect(candleType(pushCount() - 1)).toBe("candle_solid");
    // 偏好没被分时改写：回到 K 线 HA 自己回来了，键还在。
    expect(localStorage.getItem(HEIKIN_ASHI_PREFS_KEY)).toBe("1");
  });

  it("空图表时按钮 disabled（affordance 本身就是判据），HA 仍按偏好挂上", async () => {
    localStorage.setItem(HEIKIN_ASHI_PREFS_KEY, "1");
    h.list = []; // 覆盖 `beforeEach` 的 seed：这条要的就是空图
    render(<ProChart />);
    await flush();
    const button = screen.getByRole("button", { name: "平均K线" }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute("title")).toContain("图上还没有数据");
    // 原来这里 `h.created = []` 再点一次、断 `haCreates()` 长度为 0，已经删掉：`disabled` 一成立
    // jsdom 和真浏览器都不派发事件，那句永远绿——同一个理由写在 `ProChartReplay.test.tsx:560-563`。
    // 而挂载 effect（`ProChart.tsx:1334-1341`）读 `[haOn, timeShare]`、没有 barCount 门：挂载是视图
    // 偏好，与数据条数无关 ⇒ 偏好开＋零根 bar 时 HA 在挂载那一次就上了图，且先删后挂保证恰好一份。
    // 这条的可杀处：给 effect 加上 `barCount > 0` 门、或把 `syncHeikinAshi` 的创建分支摘掉（挂载那一次就
    // 不会再有任何 `HEIKIN_ASHI` 实例）⇒ 长度不是 1；上一条则可把 `disabled` 的门改成只看 `timeShare`。
    // 一句实话（不是 TODO）：此刻这颗灰按钮的 `aria-pressed` 读起来是「已开」，数据到了才可点。
    expect(h.indicators.filter((i) => i.name === "HEIKIN_ASHI")).toHaveLength(1);
  });

  it("挂 HA 不吃掉 MA：主图价格覆盖层那一条还在（syncPriceOverlay 的领地不被侵犯）", async () => {
    render(<ProChart />);
    await flush();
    h.created = [];
    fireEvent.click(screen.getByRole("button", { name: "平均K线" }));
    await flush();
    expect(h.indicators.some((i) => i.name === "MA")).toBe(true);
    expect(h.indicators.some((i) => i.name === "HEIKIN_ASHI")).toBe(true);
  });
});
