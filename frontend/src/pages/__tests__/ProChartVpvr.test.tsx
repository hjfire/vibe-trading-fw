import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { init as initChartMock } from "klinecharts";

import { publishThemeChange } from "@/lib/theme-store";
import { HEIKIN_ASHI_PREFS_KEY } from "@/lib/heikinAshiChart";
import { VPVR_PREFS_KEY } from "@/lib/vpvrChart";
import { ProChart } from "../ProChart";

// VPVR 的挂卸与按钮都落在页面上：`fireEvent`/`screen` 从第一行起就有消费者——
// 工具栏「量分布」那颗按钮，以及为钉分时互斥而点的「分时」、为钉共挂互不侵犯而点的
// 「平均K线」。

/**
 * 量分布 / VPVR 的页面接线（推荐清单第⑤片，spec §七 五处）。
 *
 * 本片要钉的四张面：
 * 1. 挂卸：先删后挂到 `candle_pane`、`isStack` 为真（真库 `addIndicator(create, isStack)`
 *    在假值时先清整格指标，共挂那条判的就是这一参没丢）；反复开关不堆叠，
 *    StrictMode 的第二次挂载不追加第二份——`syncVpvr` 的 `live.length === 0` 那一夹
 *    是多出一行图例的唯一挡板。
 * 2. 偏好键：开写 `"1"`，关**删键**（不是写 `"0"`，`chartLegend.ts` 的写侧纪律），
 *    分时永不改写它——回 K 线指标自己挂回来、键还在原地。
 * 3. 分时互斥：进分时必须卸掉 VPVR（面积线没有 [low, high] 区间可摊），
 *    `aria-pressed` 当场变 false，`title` 说的是面积线那个理由。
 * 4. 与 HA 的关系：共挂两个名字各一份、谁也没吃掉谁；卸一边不动另一边。
 *
 * 样式面本片零改动：不写任何样式键，「没脏样式」由第④片文件自身的样式钉
 * （`ProChartHeikinAshi.test.tsx`，`Object.keys(...).indicator === ["tooltip"]` 那条）
 * 在本片落地后回归全绿来判——所以 harness 的 `h.styles`／`h.initStyles` 录制面原样带过来。
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
  // `removeIndicator` 每次收到的过滤条件原样一份（Task 5 针牙②要读它）。「图上还剩几份」
  // 只判得出结果、判不出它是**按什么**卸的：按 `name` 卸会连页面那一份一起吃掉，按 `paneId`
  // 卸会连主图的 MA 一起吃掉，只有按 `{ id }` 卸才恰好是「切掉多出来的一份」。
  removed: [] as Array<{ name?: string; id?: string; paneId?: string }>,
  // 每次 `overrideOverlay` 收到的是什么。第④片的真值边界钉用它判「切 HA 不该重锚画线」，
  // 所以判据是「切换前后这个数组没长」，不是「它等于空」。
  overridden: [] as unknown[],
  // 图上现存的画线，**有内容**（R13）。以前下面那格 `getOverlays` 返回的是常量空集，
  // 于是「切 HA 不重锚画线」那条针在页面上任何一轮遍历里都没有候选——结构性不可红。
  // 现在 `beforeEach` 往里种一条真带 `points` 的线，那条针才真有杀伤力。
  overlays: [] as Array<{
    id: string;
    name: string;
    paneId: string;
    points: Array<{ timestamp: number; value: number }>;
  }>,
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
      createIndicator: (value: { name: string; paneId?: string }, isStack?: boolean) => {
        // `isStack`（库的第二参，`Chart.createIndicator(value, isStack)`）照旧记进
        // `h.created`——这一格的录制形状没变，既有 7 条读的就是它。
        h.created.push({ ...(value as Record<string, unknown>), isStack });
        const paneId = value.paneId ?? `sub:${value.name}`;
        // 针牙①：替身现在**吃**这一参了。真库 `StoreImp.addIndicator(create, isStack)`
        // （klinecharts 10.0.3，`dist/umd/klinecharts.js:14167`）在 `isStack` 为假时先
        // `removeIndicator({ paneId })` 把目标格上的每一个指标清掉再挂新的，而
        // `ChartImp.createIndicator`（同文件 :15279）在调用方没传时按 `false` 算。
        // 以前替身只记不吃 ⇒ 「页面把 `true` 写成假值」在 `h.indicators` 里读不出来，
        // 那根针是等价变异、永不红。现在假值会把同格的指标一起带走，共挂那条才真判得到。
        if (!isStack) h.indicators = h.indicators.filter((ind) => ind.paneId !== paneId);
        h.indicators.push({ name: value.name, paneId, id: `i${h.indicators.length}` });
        return true;
      },
      removeIndicator: (filter: { name?: string; id?: string; paneId?: string }) => {
        h.removed.push({ ...filter });
        const before = h.indicators.length;
        h.indicators = h.indicators.filter(
          (ind) =>
            (filter?.name === undefined || ind.name !== filter.name) &&
            (filter?.id === undefined || ind.id !== filter.id) &&
            (filter?.paneId === undefined || ind.paneId !== filter.paneId),
        );
        return h.indicators.length < before;
      },
      // 有状态版本（R13）：这一格以前是 `getOverlays: () => []`——返回常量空集，所以「切 HA
      // 期间不许重锚画线」那条计数针没有候选，页面无论怎么写画线面都永远绿。现在它交出
      // `beforeEach` 种下的那条线，判据才落到真东西上。
      getOverlays: () => h.overlays,
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
      // 录制版：第④片「切 HA 不重锚画线」那条判据读的是这个数组在两次穿越前后是否相等（不是长度增量：候选集补上以后，多录一次就是红）。
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
  h.removed = [];
  h.overridden = [];
  h.loader = null;
  // 默认就带上 bar：真实使用里图上有数据，按钮的 `barCount > 0` 判据不该替测试挡路。
  // 要空图的那条自己 `h.list = []` 再 render（第④片那条就是）。
  seed();
  // 种一条真带 `points` 的画线（R13）：锚点从**当次喂进去的** `h.list` 里取（最后一根），
  // 所以它是数据里真实存在的 timestamp，不是一个与图无关的数字字面量；`paneId` 给
  // `candle_pane`，那条线因此不归任何副图管，`parkOrphans` 不会把它卷进停放面。
  // 要空图的那条把 `h.list` 清空时不动这一格——线还留在图上，正如真实使用里换了数据
  // 也换不掉已画的线。
  const seedAnchor = h.list[h.list.length - 1] as { timestamp: number };
  h.overlays = [
    {
      id: "d1",
      name: "horizontalStraightLine",
      paneId: "candle_pane",
      points: [{ timestamp: seedAnchor.timestamp, value: 1234.5 }],
    },
  ];
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

describe("/pro-chart 量分布的挂卸与互斥", () => {
  // `h.created` 在点之前清一次：init 那一路 `syncPriceOverlay`（主图 `["MA"]`）／`syncSubPanes`
  // （副图 VOL／MACD）已经创建过指标，计数判据要数的是「这次点按钮创建了几个」。
  // `h.indicators` 与 `h.styles` **不许**清：它们是「主图现在载着什么」的唯一真相，
  // 清掉就把「挂 VPVR 不吃掉 MA／HA」那条钉成了假绿。
  const vpCreates = () => h.created.filter((c) => (c as { name?: string }).name === "VPVR");
  const vpLive = () => h.indicators.filter((i) => i.name === "VPVR");
  const haLive = () => h.indicators.filter((i) => i.name === "HEIKIN_ASHI");

  it("点一次：先删后挂到 candle_pane，创建的是 VPVR，且 isStack 为真", async () => {
    render(<ProChart />);
    await flush();
    h.created = [];
    fireEvent.click(screen.getByRole("button", { name: "量分布" }));
    await flush();
    expect(vpCreates()).toHaveLength(1);
    expect(vpCreates()[0]).toMatchObject({ name: "VPVR", paneId: "candle_pane", isStack: true });
    expect(vpLive()).toHaveLength(1);
    expect(vpLive()[0].paneId).toBe("candle_pane");
    expect(localStorage.getItem(VPVR_PREFS_KEY)).toBe("1");
    expect(screen.getByRole("button", { name: "量分布" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("连点两次回到原样：指标卸掉、键被删（不是写 \"0\"）", async () => {
    render(<ProChart />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "量分布" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "量分布" }));
    await flush();
    expect(vpLive()).toHaveLength(0);
    expect(localStorage.getItem(VPVR_PREFS_KEY)).toBeNull();
    expect(screen.getByRole("button", { name: "量分布" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("反复开关不堆叠：4 次按 ⇒ 2 次创建（关着的那两次不该 create），活着的始终是一份", async () => {
    render(<ProChart />);
    await flush();
    h.created = [];
    for (let i = 0; i < 4; i++) {
      fireEvent.click(screen.getByRole("button", { name: "量分布" }));
      await flush();
    }
    expect(vpCreates()).toHaveLength(2);
    expect(vpLive()).toHaveLength(0);
  });

  it("开着 HA 再开 VPVR：两个名字各一份，谁也没吃掉谁", async () => {
    localStorage.setItem(HEIKIN_ASHI_PREFS_KEY, "1");
    render(<ProChart />);
    await flush();
    expect(haLive()).toHaveLength(1);
    h.created = [];
    fireEvent.click(screen.getByRole("button", { name: "量分布" }));
    await flush();
    expect(vpLive()).toHaveLength(1);
    expect(haLive()).toHaveLength(1);
    // `isStack` 为假时 `StoreImp.addIndicator` 会先把整格指标卸掉再挂新的（第④片探针 F
    // 实测那条）⇒ 这一格为假的话，上面的 `haLive()` 就空了。两个指标的挂载次序因此
    // 不是「大概没事」，是被这一条判着的。
    expect(vpCreates()[0]).toMatchObject({ isStack: true });
  });

  it("卸 VPVR 不动 HA，卸 HA 不动 VPVR", async () => {
    localStorage.setItem(HEIKIN_ASHI_PREFS_KEY, "1");
    render(<ProChart />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "量分布" }));
    await flush();
    expect(vpLive()).toHaveLength(1);
    expect(haLive()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "量分布" }));
    await flush();
    expect(vpLive()).toHaveLength(0);
    expect(haLive()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "量分布" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "平均K线" }));
    await flush();
    expect(haLive()).toHaveLength(0);
    expect(vpLive()).toHaveLength(1);
  });

  it("开着 VPVR 进分时：指标卸掉、pressed 是 false、理由说面积线；回 K 线自己挂回", async () => {
    localStorage.setItem(VPVR_PREFS_KEY, "1");
    render(<ProChart />);
    await flush();
    expect(vpLive()).toHaveLength(1);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "分时" }));
    });
    await flush();
    expect(vpLive()).toHaveLength(0);
    expect(screen.getByRole("button", { name: "量分布" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "量分布" }).getAttribute("title")).toContain("面积线");

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "分时" }));
    });
    await flush();
    expect(vpLive()).toHaveLength(1);
    expect(vpLive()[0].paneId).toBe("candle_pane");
    // 偏好没被分时改写：回蜡烛自己回来了，键还在。
    expect(localStorage.getItem(VPVR_PREFS_KEY)).toBe("1");
  });

  it("StrictMode 的第二次挂载不追加第二个 VPVR：去重那一支是活的", async () => {
    // `main.tsx:29` 用 `React.StrictMode` 挂载：开发态每个 effect 跑两遍（挂→卸→挂）。
    // 第二遍的 `chartRef.current` 是新图表对象，而 `h.indicators` 里第一遍挂的那份还在
    // ⇒ 走的就是 `syncVpvr` 的 `live.length === 0` 那一夹。夹子摘掉就是主图多一个
    // VPVR、多一行图例（`createIndicator(value, true)` 永远是追加）。
    localStorage.setItem(VPVR_PREFS_KEY, "1");
    render(
      <StrictMode>
        <ProChart />
      </StrictMode>,
    );
    await flush();
    expect(vpLive()).toHaveLength(1);
  });

  // 针牙②：`syncVpvr` 的 `live.slice(1)` 那一支（`ProChart.tsx:1039`）在页面自己的状态机里
  // 到不了——全仓挂 VPVR 的入口只有那一处，而它只在 `live.length === 0` 时才走，所以「页面
  // 挂出来的那份图」里 VPVR 永远是 0 或 1 份，那条 `forEach` 是个空转（判据 F 打在上面永不红）。
  // 但第二份是**库侧真实存在**的起始态：`ChartImp.createIndicator`
  // （klinecharts 10.0.3，`dist/umd/klinecharts.js:15272`）先给 create 铸一把新 id，
  // `StoreImp.addIndicator`（同文件 :14157）再拿这把 id 去重，而带 id 的 filter 只按 id 匹配
  // （:14182）⇒ `isStack` 为真时它**永远追加**，看不见格上已有的那份。页面那段注释写的就是
  // 「the invariant holds from any starting state」⇒ 这一条钉的是那个起始态，不是页面造题的能力。
  // 种那两份走的是替身自己的 `createIndicator` recorder（页面挂 VPVR 用的是同一格、同一个
  // `paneId`、同一个 `isStack=true`，id 也由同一把 `i${length}` 铸），不是手写进 `h.indicators`
  // 的字面量；把两份切回一份的那一刀，是**用户点「量分布」**点出来的。
  it("格上已有两份时：点一次开关切回一份，多出来那份是按 `id` 卸的", async () => {
    render(<ProChart />);
    await flush();
    // 再要一个图表对象：`init` 的替身把方法面交回来、状态面是共享的 `h.indicators`，
    // 所以这两次 create 与页面那一次挂在同一张 `candle_pane` 上。
    const chart = initChartMock("vpvr-two-copies");
    if (!chart) throw new Error("替身的 init 没交出图表对象");
    chart.createIndicator({ name: "VPVR", paneId: "candle_pane" }, true);
    chart.createIndicator({ name: "VPVR", paneId: "candle_pane" }, true);
    // 候选集先钉住：没有这两份，下面全是空转（R13 同型的「结构性不可红」）。
    expect(vpLive()).toHaveLength(2);
    const firstId = vpLive()[0].id;
    const extraId = vpLive()[1].id;
    // 只数按钮这一次：种的那两份自己也是 `createIndicator` 的调用，全记在 `h.created` 里。
    h.created = [];
    h.removed = [];

    fireEvent.click(screen.getByRole("button", { name: "量分布" }));
    await flush();

    // 活着的是且只是一份，且是**先挂的那一份**（`slice(1)` 留头切尾）。
    expect(vpLive()).toHaveLength(1);
    expect(vpLive()[0].id).toBe(firstId);
    // 那一次 `removeIndicator` 收到的是且只是一条 `{ id }`，id 恰是多出来那一份的：
    // 按 `name` 卸会连留着的那份一起吃掉，按 `paneId` 卸会连主图的 MA 一起吃掉。
    expect(h.removed).toEqual([{ id: extraId }]);
    // 已有两份 ⇒ 不该再 create（`live.length === 0` 那一夹）。
    expect(vpCreates()).toHaveLength(0);
    // 这一刀没伤及邻格：主图的 MA 还在。
    expect(h.indicators.some((i) => i.name === "MA")).toBe(true);
    expect(localStorage.getItem(VPVR_PREFS_KEY)).toBe("1");
  });
});

describe("/pro-chart 量分布的真值边界（spec §八）", () => {
  // 不另造 `seed`：`beforeEach` 已经 `seed()`，数据面在 render 之前就摆好了。每条测试自己
  // `render(<ProChart />)` ＋ `await flush()`——init 那一路的样式推送、`syncPriceOverlay`
  // 挂 MA、`syncSubPanes` 挂副图都会发生，边界钉判的就是「在这条真实路径上再开一次
  // VPVR，那些东西没有被碰」。

  it("开→关来回：`getDataList()` 的内容与身份都没变（两侧都量）", async () => {
    render(<ProChart />);
    await flush();
    const before = h.list;
    const snapshot = JSON.stringify(before);

    fireEvent.click(screen.getByRole("button", { name: "量分布" }));
    await flush();
    // 「只量开的那一次」是第④片 R12 的教训：卸的一路（`removeIndicator({name})`）
    // 要是顺手重建了 data，只在开的一侧读不出来。
    expect(h.list).toBe(before);
    expect(JSON.stringify(h.list)).toBe(snapshot);

    fireEvent.click(screen.getByRole("button", { name: "量分布" }));
    await flush();
    expect(h.list).toBe(before);
    expect(JSON.stringify(h.list)).toBe(snapshot);
  });

  it("分布不写画线面：锚点分毫未动、`overrideOverlay` 一次不多", async () => {
    render(<ProChart />);
    await flush();
    const anchor = JSON.stringify(h.overlays[0].points);
    const overrides = h.overridden.length;
    for (let i = 0; i < 3; i++) {
      fireEvent.click(screen.getByRole("button", { name: "量分布" }));
      await flush();
    }
    // 判据是「相等」不是「长度增量为 0」——候选集（`beforeEach` 种的那条线）在，
    // 但重锚会把 points 换掉，所以两条都得判（第④片 R13 的形状）。
    expect(JSON.stringify(h.overlays[0].points)).toBe(anchor);
    expect(h.overridden.length).toBe(overrides);
    // 且 VPVR 没有以 overlay 的身份出现过（spec §〇 第 2 条：走 overlay 就会进落盘通道）。
    expect(h.overlays.some((o) => o.name === "VPVR")).toBe(false);
  });

  it("画线落盘面逐字节不动：`pro-chart.drawings.v1` 开前事后相同", async () => {
    // 候选集（第④片 R13 的形状）：`beforeEach` 清了 localStorage，而挂载那一路只在
    // 「桶里有画线」时才读它、且只有吸回越界锚点时才回写——空桶时这一格从头到尾是 `null`，
    // `null` 等于 `null` 就是一条结构性不可红的针。所以先按页面自己的格式
    // （`chartDrawings.ts` 的 `BucketMap`：键 `标的|周期`，值是 `StoredDrawing[]`）种一条
    // 真线进去，`mid` 才是**有内容的字节**，「开前事后相同」才判得出东西被改。
    localStorage.setItem(
      "pro-chart.drawings.v1",
      JSON.stringify({
        "600519.SH|1D": [
          {
            name: "horizontalStraightLine",
            paneId: "candle_pane",
            points: [{ timestamp: 1_700_000_000_000 + 5 * 86_400_000, value: 1234.5 }],
          },
        ],
      }),
    );
    render(<ProChart />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "量分布" }));
    await flush();
    const mid = localStorage.getItem("pro-chart.drawings.v1");
    // 候选集自检（第④片最贵教训的形状）：这一格没内容，上面那两条比较就是空转。
    expect(mid).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "量分布" }));
    await flush();
    expect(localStorage.getItem("pro-chart.drawings.v1")).toBe(mid);
  });

  it("样式面零影响：`indicator` 子树仍恰是 [\"tooltip\"]，九色不因 VPVR 变化", async () => {
    render(<ProChart />);
    await flush();
    const before = pushCount() - 1;
    const keysBefore = Object.keys((styleAt(before) as { indicator: Record<string, unknown> }).indicator);
    const barBefore = JSON.stringify(barColors(before));

    fireEvent.click(screen.getByRole("button", { name: "量分布" }));
    await flush();
    // 挂 VPVR 不是一次样式事件：它不该推新格。若页面推了，那一格必须仍然只带 tooltip。
    const last = pushCount() - 1;
    expect(Object.keys((styleAt(last) as { indicator: Record<string, unknown> }).indicator)).toEqual(keysBefore);
    expect(Object.keys((styleAt(last) as { indicator: Record<string, unknown> }).indicator)).toEqual(["tooltip"]);
    expect(JSON.stringify(barColors(last))).toBe(barBefore);
    for (const key of NINE_BAR_KEYS) expect(barColors(last)[key]).not.toBe("transparent");
    expect(candleType(last)).toBe("candle_solid");
    expect(priceMark(last)).toBeDefined();
    // 八格里另两格的读数口，各钉一次——它们是「VPVR 不写样式」的另一半：
    // ① init 推送点（`init` 的 `styles` 选项）也得是真蜡烛九色。挂分布不是把蜡烛藏起来的
    //    理由；那九格被写成 `transparent` 时第④片会红，但「VPVR 没脏样式」得由本片自己判住。
    for (const key of NINE_BAR_KEYS) expect(initBarColors()[key]).not.toBe("transparent");
    // ② 主图图例模板仍是蜡烛那六格。VPVR 的三行读数走的是它自己指标的
    //    `createTooltipDataSource`（`vpvrChart.ts`），不是往 `candle.tooltip.legend.template`
    //    后面追加第七行——追加了就是分布脏了图例面。
    expect(tooltipTemplate(last)).toHaveLength(6);
  });

  it("开着 VPVR 切主题：VPVR 实例不重挂、样式照常只由主题与图例说话", async () => {
    render(<ProChart />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "量分布" }));
    await flush();
    const created = h.created.length;
    // 切主题的姿势抄第④片那条（`documentElement` 加 `dark` ＋ `publishThemeChange()`，
    // 包在 `act` 里）——工具栏上没有「深色」这颗按钮，`getByRole` 会报找不到。
    act(() => {
      document.documentElement.classList.add("dark");
      publishThemeChange();
    });
    await flush();
    expect(vpKept()).toBe(true);
    // 主题 effect 推样式是它的本分；VPVR 不在这条链上，所以它不该因此被重挂。
    expect(h.created).toHaveLength(created);
    expect(h.indicators.filter((i) => i.name === "VPVR")).toHaveLength(1);
  });

  it("空图：按钮 disabled 且理由说「先等 K 线加载出来」（不声称不会挂指标）", async () => {
    // 第④片 R9 的教训：effect 里没有 `barCount` 门，灰按钮在 jsdom 与浏览器一样
    // 不派发事件 ⇒ 「空图时不会挂指标」那条针永远绿。所以这里只判按钮与其理由，
    // **不**写「`h.indicators` 里没有 VPVR」。
    h.list = [];
    localStorage.setItem(VPVR_PREFS_KEY, "1");
    render(<ProChart />);
    await flush();
    const button = screen.getByRole("button", { name: "量分布" });
    expect(button).toBeDisabled();
    expect(button.getAttribute("title")).toContain("先等 K 线加载出来");
  });
});

/** 本 describe 自己的小 helper：活着的 VPVR 还在主图上吗。 */
function vpKept(): boolean {
  return h.indicators.some((i) => i.name === "VPVR");
}

