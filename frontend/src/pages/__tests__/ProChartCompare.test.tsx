import { StrictMode } from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  COMPARE_PREFS_KEY,
  clearCompareSeries,
  getCompareSeries,
  setActiveCompareKey,
} from "@/lib/symbolCompareChart";
import { HEIKIN_ASHI_PREFS_KEY } from "@/lib/heikinAshiChart";
import { VPVR_PREFS_KEY } from "@/lib/vpvrChart";
import { ProChart } from "../ProChart";

/**
 * 第⑥片（多标的叠加对比）的页面接线面（spec §十 的 ②b/③/⑥ 三条）。
 *
 * 替身的形状照 `ProChartVpvr.test.tsx`（同一套录制桶＋`ask()`＋`seed()`），本片只多三格：
 * `h.axes`（轴表，跟着 create/remove 变）、`h.createdYAxis`（`createYAxis` 的调用录制，
 * §十·① 那根"不建 manual 轴"的结构钉）、`h.fetchCalls`／`h.cmpBars`（对比取数的分流与观察）。
 * 库行号一律指 `dist/index.esm.js`（UMD 恒 +5，别在一句话里混用两个坐标）。
 */

/** 蜡烛 pane 出厂那根默认轴的 id——替身里的"默认轴"就是它，`COMPARE_AXIS_ID` 之外只有它。 */
const DEFAULT_AXIS_ID = "candle-pane-default";

const h = vi.hoisted(() => ({
  styles: [] as Array<Record<string, unknown>>,
  initStyles: [] as Array<Record<string, unknown>>,
  indicators: [] as Array<{ name: string; paneId: string; id: string; yAxisId?: string }>,
  created: [] as Array<Record<string, unknown>>,
  removed: [] as Array<{ name?: string; id?: string; paneId?: string }>,
  overridden: [] as unknown[],
  removedOverlays: [] as Array<Record<string, unknown>>,
  overlays: [] as Array<{
    id: string;
    name: string;
    paneId: string;
    points: Array<{ timestamp: number; value: number }>;
  }>,
  list: [] as Array<Record<string, unknown>>,
  resets: 0,
  loader: null as null | {
    getBars: (p: {
      type: string;
      timestamp: number | null;
      period: unknown;
      symbol: { ticker: string };
      callback: (data: unknown[], more?: unknown) => void;
    }) => void | Promise<void>;
  },
  // 本片新增的三格。
  axes: [] as string[],
  createdYAxis: [] as unknown[],
  fetchCalls: [] as Array<Record<string, unknown>>,
  cmpBars: [] as Array<{ timestamp: number; close: number }>,
  cmpError: null as string | null,
}));

function ask(): void {
  if (!h.loader) throw new Error("页面没有装 DataLoader");
  void Promise.resolve(
    h.loader.getBars({
      type: "init",
      timestamp: null,
      period: { type: "day", span: 1 },
      symbol: { ticker: "600519.SH" },
      callback: () => undefined,
    }),
  ).catch(() => undefined);
}

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

function seed(count = 6): void {
  h.list = Array.from({ length: count }, (_, i) => barOf(i));
}

const cmpCreates = () =>
  h.created.filter((c) => (c as { name?: string }).name === "SYMBOL_COMPARE");
const cmpLive = () => h.indicators.filter((i) => i.name === "SYMBOL_COMPARE");
const haLive = () => h.indicators.filter((i) => i.name === "HEIKIN_ASHI");
const vpLive = () => h.indicators.filter((i) => i.name === "VPVR");

/**
 * `ChartImp._removeOrphanYAxes` 的六行镜像（`index.esm.js:15217-15240`）：既不是默认轴、
 * 又没有指标绑着、又**不是 manual** 的轴被删。
 *
 * **判的是声明与调用面，不是库**：替身按库那条规则摊轴表，于是「页面对轴的用法」——
 * 只经 `createIndicator` 建轴、`createYAxis` 一次都不调、删指标即删轴——在本文件里读得到。
 * 把这三行抄成常量 `["candle-pane-default"]` 就等于把本片最重要的那条不变量交成空集断言
 * （本仓登记的假绿第一种）。
 */
function sweepAxes(): void {
  const used = new Set<string>([DEFAULT_AXIS_ID]);
  for (const ind of h.indicators) used.add(ind.yAxisId ?? DEFAULT_AXIS_ID);
  h.axes = h.axes.filter((id) => used.has(id));
}

vi.mock("klinecharts", () => ({
  registerIndicator: vi.fn(),
  getSupportedLocales: () => ["en-US", "zh-CN"],
  registerLocale: vi.fn(),
  dispose: vi.fn(),
  init: (_host: unknown, options?: { styles?: Record<string, unknown> }) => {
    h.initStyles.push(options?.styles ?? {});
    return {
      getSymbol: () => ({ ticker: "600519.SH", pricePrecision: 2, volumePrecision: 0 }),
      getDataList: () => h.list,
      getIndicators: (filter?: { name?: string; id?: string; paneId?: string }) =>
        h.indicators.filter((ind) => {
          if (filter?.name !== undefined && ind.name !== filter.name) return false;
          if (filter?.id !== undefined && ind.id !== filter.id) return false;
          if (filter?.paneId !== undefined && ind.paneId !== filter.paneId) return false;
          return true;
        }),
      createIndicator: (
        value: { name: string; paneId?: string; yAxisId?: string },
        isStack?: boolean,
      ) => {
        h.created.push({ ...(value as Record<string, unknown>), isStack });
        const paneId = value.paneId ?? `sub:${value.name}`;
        if (!isStack) h.indicators = h.indicators.filter((ind) => ind.paneId !== paneId);
        h.indicators.push({
          name: value.name,
          paneId,
          id: `i${h.indicators.length}`,
          // 库在 `ChartImp.createIndicator`（`index.esm.js:15273`）尊重传入的 `yAxisId`，
          // 缺省才回落到该 pane 的默认轴 id ⇒ 记的是**页面真传的那一格**。
          yAxisId: value.yAxisId ?? DEFAULT_AXIS_ID,
        });
        // `_createOrUseIndicatorYAxis`（`index.esm.js:15241-15249`）：轴不存在就建出来，
        // 且这条路径**不设 manual**。
        if (value.yAxisId && !h.axes.includes(value.yAxisId)) h.axes.push(value.yAxisId);
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
        // 库只在真删掉东西时才扫孤儿轴（`ChartImp.removeIndicator` 的 `if (removed)`，
        // `index.esm.js:15326`）⇒ 这里同形，否则「关掉后回到恰 1 根轴」会被一次空删也扫一遍。
        if (h.indicators.length < before) sweepAxes();
        return h.indicators.length < before;
      },
      // §十·① 的结构钉：真库 `ChartImp.createYAxis` 会给轴打 manual（`index.esm.js:15483`），
      // 而 manual 轴把主图蜡烛撑进自己的量程（`:980-983`）且不被孤儿回收（`:15234`）。
      // 页面一次都不该调它——吞掉调用（`vi.fn()` 不带录制）就等于没这根钉。
      // **替身只录调用、不摆轴，而这一格读不出东西不是偷懒**：库的指标挂载路径会把已存在轴上
      // 的 manual 标记取消（`_createOrUseIndicatorYAxis`，`index.esm.js:15245-15248`），于是
      // 「先 `createYAxis` 再 `createIndicator`」这种用法得到的轴表与压根不调它时逐字相同 ⇒
      // 轴表那两格对这条用法没有牙，见证只有下面那格的调用计数。
      createYAxis: (yAxis: unknown) => {
        h.createdYAxis.push(yAxis);
        return "manual-axis";
      },
      removeYAxis: () => false,
      getYAxes: (filter?: { paneId?: string; id?: string; name?: string }) =>
        h.axes
          .filter((id) => filter?.id === undefined || filter.id === id)
          .map((id) => ({ id })),
      getOverlays: () => h.overlays,
      getPaneOptions: () => [{ id: "candle_pane", height: 300, minHeight: 30, state: "normal" }],
      setPaneOptions: vi.fn(),
      setDataLoader: (loader: typeof h.loader) => {
        h.loader = loader;
      },
      setSymbol: () => ask(),
      setPeriod: () => ask(),
      resetData: () => {
        h.resets++;
        return ask();
      },
      setStyles: (s: Record<string, unknown>) => h.styles.push(s),
      resize: vi.fn(),
      createOverlay: (o: Record<string, unknown>) => {
        const id = `o${h.overlays.length + 1}`;
        h.overlays.push({ ...o, id } as unknown as (typeof h.overlays)[number]);
        return id;
      },
      removeOverlay: (filter?: Record<string, unknown>) => {
        h.removedOverlays.push(filter ?? {});
        return true;
      },
      overrideOverlay: (o: unknown) => {
        h.overridden.push(o);
        return true;
      },
      getOffsetRightDistance: () => 0,
      setOffsetRightDistance: vi.fn(),
      getBarSpace: () => ({ bar: 8, halfBar: 4, gapBar: 5, halfGapBar: 2 }),
      setBarSpace: vi.fn(),
      scrollToRealTime: vi.fn(),
      getVisibleRange: () => ({
        from: 0,
        to: h.list.length,
        realFrom: 0,
        realTo: h.list.length,
      }),
      getDom: () => undefined,
    };
  },
}));

vi.mock("@/lib/marketApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/marketApi")>();
  return {
    ...actual,
    fetchKline: async (params: Record<string, unknown>) => {
      h.fetchCalls.push(params);
      if (params.symbol === "600519.SH") {
        // 主图那一趟：`before` 为空才交全量，与第⑤片那份替身同形（分页交空数组）。
        return {
          bars: params.before == null ? h.list : [],
          source: "fake-main",
          symbol: "600519.SH",
          interval: "1D",
        };
      }
      if (h.cmpError !== null) throw new Error(h.cmpError);
      return {
        // `.slice()` 不是礼貌性复制：交回**同一个数组对象**会让「页面不重排」那根针假绿——
        // 页面若就地 `data.bars.sort(…)`/`reverse()`，期望值 `h.cmpBars` 跟着一起被改，两侧永远相等。
        bars: h.cmpBars.slice(),
        source: "fake-cmp",
        symbol: params.symbol,
        interval: params.interval,
      };
    },
  };
});

vi.mock("@/components/charts/WatchList", () => ({ default: () => null }));
vi.mock("@/components/charts/IndicatorEditor", () => ({ default: () => null }));

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const D = (i: number): number => 1_700_000_000_000 + i * 86_400_000;

// 参照点写在「按钮的 disabled 判据」那一句的旁边：`getByRole` 交回的是 `HTMLElement`，
// 它身上没有 `disabled` 这一格，所以这里把它收成 `HTMLButtonElement`——被钉的期望值
// （`expect(button().disabled).toBe(true)`）一字未动，变的只是取回元素的那枚类型标注，
// 为的是过 `tsc --noEmit`（`noUnusedLocals` 那类严格门同向）。
const button = (): HTMLButtonElement =>
  screen.getByRole("button", { name: "对比" }) as HTMLButtonElement;
const field = () => screen.getByRole("textbox", { name: "对比标的" });

/** 把标的填进对比输入框（只填不点：`cmpInput` 与 `cmpSymbol` 的分工就是「填了」与「应用了」）。 */
function typeCompare(symbol: string): void {
  fireEvent.change(field(), { target: { value: symbol } });
}

// 样式面的读数口**原样照第⑤片文件**搬过来：下面那四条真值边界件里的「样式面零影响」读的就是
// 这几格，期望值一格都不许改，所以读法也不许改。`initStyles` 是建图那一次推送（`init` 的
// `styles` 选项）唯一的出口，`styles` 是主题 effect 的 `setStyles` 录制，两个推送点各有各的钉子。
function styleAt(i: number): Record<string, unknown> {
  return h.styles[i];
}

const pushCount = () => h.styles.length;

/** `candle.bar` as the i-th `setStyles` push carried it. */
function barColors(i: number): Record<string, unknown> {
  return (styleAt(i) as { candle?: { bar?: Record<string, unknown> } }).candle?.bar ?? {};
}

/** `candle.bar` as the **建图推送点**（`init` 的 `styles` 选项）carried it. */
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
  h.removedOverlays = [];
  h.resets = 0;
  h.loader = null;
  h.axes = [DEFAULT_AXIS_ID];
  h.createdYAxis = [];
  h.fetchCalls = [];
  h.cmpError = null;
  // 对比序列**有内容**（替身失真第一种：不建模副作用之外，还有"把候选集交成空集"）：
  // ready 门读的 `bars.length > 0` 若靠默认空数组，未就绪那一支永远只由 key 不等撑起。
  // 主图 seed 6 根（D0..D5），这里给 D1/D3 ⇒ 对齐后 [null,10,10,12,12,12]，非 null 有 5 格。
  h.cmpBars = [
    { timestamp: D(1), close: 10 },
    { timestamp: D(3), close: 12 },
  ];
  seed();
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
  // 模块 store 跨 `render` 存活：上一支用例交付进桶的序列若不清，本支就可能在页面自己
  // 还没取到数时读到它——这正是 `clearCompareSeries()` 在**生产侧**没有调用者的原因：
  // 页面自己清就会把挂卸 effect 正在读的桶掏空，得到一条永远不存在的线。
  // `setActiveCompareKey("")` 同理，`calc` 读的就是这一格。
  clearCompareSeries();
  setActiveCompareKey("");
  document.documentElement.classList.remove("dark");
});

describe("/pro-chart 多标的叠加对比", () => {
  it("填标的再点一次：挂到 candle_pane、走自定义轴、isStack 为真，且不调 createYAxis", async () => {
    // 这一支故意把对比序列种成**降序**（D3 在 D1 前面）：「页面不重排」那根针若喂升序样本，
    // 页面加一次升序 `.sort()` 就是 no-op，针永远绿。升序由生产者保证（`sort_index()`），
    // 页面这一半的职责是**原样透传**，所以这里要的正是"乱序进来也必须乱序进 store"。
    h.cmpBars = [
      { timestamp: D(3), close: 12 },
      { timestamp: D(1), close: 10 },
    ];
    // 点击**之前**抄一份时间戳：替身交回的是 `h.cmpBars.slice()`（见 harness 那格的理由），
    // 页面就地重排改不到 `h.cmpBars`，但快照把这层保护也钉住，不依赖实现细节。
    const fetched = h.cmpBars.map((b) => b.timestamp);
    render(<ProChart />);
    await flush();
    typeCompare("600036.SH");
    h.created = [];
    fireEvent.click(button());
    await flush();
    expect(cmpCreates()).toHaveLength(1);
    expect(cmpCreates()[0]).toMatchObject({
      name: "SYMBOL_COMPARE",
      paneId: "candle_pane",
      yAxisId: "pro-chart-compare-y",
      isStack: true,
    });
    expect(cmpLive()).toHaveLength(1);
    // §二·4 的另一半：轴由 createIndicator 顺手建出来 ⇒ 蜡烛 pane 现在是 2 根轴。
    expect(h.axes).toEqual([DEFAULT_AXIS_ID, "pro-chart-compare-y"]);
    // §十·① 的结构钉：调了它就得到一把 manual 轴，蜡烛会被撑进新尺（R1）。
    expect(h.createdYAxis).toHaveLength(0);
    expect(localStorage.getItem(COMPARE_PREFS_KEY)).toBe("600036.SH");
    expect(button().getAttribute("aria-pressed")).toBe("true");
    // 独立一趟（§五）：对比是**单独一次** `fetchKline`，不与主序列同批；深度 2000 是
    // spec §十一·5 登记的代价（后端把 `countback` 静默钳在 2000）。这里写**字面量**而不是
    // import `COMPARE_BARS`：常量已经被 T2 的「七枚常量逐字钉」钉过一次，测试面再钉一次线值，
    // 常量被改时两处同时红才是想要的耦合——同一条理由也决定了轴 id 在这份文件里是字面量。
    // `toMatchObject` 而不是 `toEqual`：记录的是页面传进去的那一整格参数，还带一个 `signal`。
    const cmpCalls = h.fetchCalls.filter((c) => c.symbol === "600036.SH");
    expect(cmpCalls).toHaveLength(1);
    expect(cmpCalls[0]).toMatchObject({ interval: "1D", count: 2000 });
    // 升序契约里**页面这一半**（T1 评审的裁定）：页面不重排取数回来的顺序——喂进 store 的数组
    // 必须与 `fetchKline` 交出的逐根同序。纯件按 spec §三 不校验 ⇒ 将来页面加一次
    // `.sort()`/`.reverse()`，线会「提前冻住」且不报任何错，这一根是它唯一的读数位置。
    expect(getCompareSeries("600036.SH|1D").map((b) => b.timestamp)).toEqual(fetched);
  });

  it("数据到达前一次都不挂；到达那一轮必须挂上（§十·②b / R10）", async () => {
    // 第一轮让对比取数交回**空数组**（`no_data` 的真实形状，`marketApi.ts:260`）：store 里
    // 那个键有内容位但 bars 为空 ⇒ ready 为假。未就绪不挂是 §六 那枚谓词第三格的定义。
    h.cmpBars = [];
    render(<ProChart />);
    await flush();
    typeCompare("600036.SH");
    fireEvent.click(button());
    await flush();
    // 挂了就是那条线永远不存在（R10 的失效形状）——所以这一支要判「一次都不挂」。
    expect(cmpLive()).toHaveLength(0);
    expect(cmpCreates()).toHaveLength(0);
    // 第二轮：序列换成有内容的，再换一次周期 ⇒ `cmpKey` 变、重取、承载序列的那格 state
    // 换身份 ⇒ 挂卸 effect 必须重跑并真挂上。依赖数组只写 `cmpOn`/`timeShare`/key 的实现
    // 到不了这一步（它压根不会因为数据到达而重跑）。
    h.cmpBars = [
      { timestamp: D(1), close: 10 },
      { timestamp: D(3), close: 12 },
    ];
    fireEvent.click(screen.getByRole("button", { name: "周线" }));
    await flush();
    expect(cmpLive()).toHaveLength(1);
    // 「挂上之后 `calc` 交出的行里有非 null 值」这半条不在本文件判——页面替身的
    // `registerIndicator` 是 `vi.fn()`，`calc` 不在这里跑。它落在 T2 的
    // 「calc 读 activeKey 那一条序列」那根针上（同一条 §十·②b，两个判据面）。
  });

  it("连点两次回到原样：指标卸掉、轴恰好回到 1 根、键被删而会话内的标的还在（§十·③）", async () => {
    render(<ProChart />);
    await flush();
    typeCompare("600036.SH");
    fireEvent.click(button());
    await flush();
    expect(cmpLive()).toHaveLength(1);
    // 来源小字跟着**已取回的那一趟**走：数据到家才印，线关掉就一起收掉（同一行印着
    // 「对 fake-cmp」，而那个标的此刻不在图上）。
    expect(screen.queryByText(/对 fake-cmp/)).not.toBeNull();
    fireEvent.click(button());
    await flush();
    expect(cmpLive()).toHaveLength(0);
    expect(screen.queryByText(/对 fake-cmp/)).toBeNull();
    // 孤儿回收（`index.esm.js:15234` 那一支）判得到：漏一根轴就是这里多一根。
    expect(h.axes).toEqual([DEFAULT_AXIS_ID]);
    expect(localStorage.getItem(COMPARE_PREFS_KEY)).toBeNull();
    // §四 会话内不清：关掉再点一次不用重敲。
    expect(field().getAttribute("value")).toBe("600036.SH");
    expect(button().getAttribute("aria-pressed")).toBe("false");
  });

  it("已挂上之后删空输入框：开关不会被自己锁死，第二次点击仍然关得掉线", async () => {
    // 这一支钉的是 `disabled` 的**第三个**条件为什么必须问两格。只问「输入框是空的」会得到
    // 一个自锁的开关：线已经挂在图上、`aria-pressed` 已经是 `true`，用户全选删掉输入框之后
    // 按钮变死，而第二次点击是把线关掉的唯一入口（`saveCompare("")` 那条路走不到）。
    // 已应用标的还在 ⇒ 必须还能点；点下去 ⇒ 线真的被卸、键真的被删。
    render(<ProChart />);
    await flush();
    typeCompare("600036.SH");
    fireEvent.click(button());
    await flush();
    expect(cmpLive()).toHaveLength(1);
    typeCompare("");
    expect(button().disabled).toBe(false);
    fireEvent.click(button());
    await flush();
    expect(cmpLive()).toHaveLength(0);
    expect(localStorage.getItem(COMPARE_PREFS_KEY)).toBeNull();
  });

  it("关掉再开：来源小字跟着线一起回来（门加在渲染侧，不加在状态侧）", async () => {
    // 这一支钉的是「门加在渲染侧，不加在状态侧」这个形状，也是它唯一的牙：若把关掉那一下写成
    // `setCmpStatus({ loading: false, error: null, source: "" })`，最后一格就红——关→开
    // **不重新取数**（取数 effect 的依赖是 `[cmpSymbol, interval, timeShare]`，这一路一格没动），
    // 被清掉的 `source` 没有任何东西会把它写回来，于是这行小字在会话余下时间里再也不出现，
    // 而对比线挂得好好的。渲染侧的 `cmpOn` 门得到的是同一句诚实话，且不丢信息。
    render(<ProChart />);
    await flush();
    typeCompare("600036.SH");
    fireEvent.click(button());
    await flush();
    expect(screen.queryByText(/对 fake-cmp/)).not.toBeNull();
    fireEvent.click(button());
    await flush();
    expect(cmpLive()).toHaveLength(0);
    expect(screen.queryByText(/对 fake-cmp/)).toBeNull();
    fireEvent.click(button());
    await flush();
    expect(cmpLive()).toHaveLength(1);
    expect(screen.queryByText(/对 fake-cmp/)).not.toBeNull();
  });

  it("五支 title 逐字钉，且第 3 支排在 4/5 之前才读得到（§十·⑥ / §七 的判别顺序）", async () => {
    render(<ProChart />);
    await flush();
    // 支 2：没有已应用标的。
    expect(button().getAttribute("title")).toBe(
      "先在左边输入对比标的（如 600036.SH 或 BTC-USDT），点它才叠到主图",
    );
    typeCompare("600036.SH");
    fireEvent.click(button());
    await flush();
    // 支 4：已开（cmpSymbol 就是刚应用的串）。
    expect(button().getAttribute("title")).toBe(
      "对比已开：把可视区间同一把时间轴上的 600036.SH 收盘画成折线，用它自己那根右侧标尺，不进主图价格轴（再点切回）",
    );
    // 支 3：已开但数据未就绪。制造它要**换一次周期**——`cmpSymbol` 与 `interval` 都没变的
    // 那一轮根本不会重取，`cmpSeries` 仍是上一轮的旧身份，ready 还是真。换周期令键变、
    // 重取、交回空数组 ⇒ 这一格才是「开关亮着而 ready 为假」。
    // 这一支排在 4/5 之前才读得到（§七 明写顺序是设计的一部分）：写成 `cmpOn ? 已开 : …`
    // 在前、未就绪在后，这条针就永远绿——而那正是"把进行中说成已完成"的形状。
    h.cmpBars = [];
    fireEvent.click(screen.getByRole("button", { name: "周线" }));
    await flush();
    expect(button().getAttribute("title")).toBe("对比标的的数据还没到位，原因看输入框那行的提示");
    // 支 5：已关。`cmpSymbol` 会话内还在，所以这句话里带得出那个标的。
    h.cmpBars = [
      { timestamp: D(1), close: 10 },
      { timestamp: D(3), close: 12 },
    ];
    fireEvent.click(button());
    await flush();
    expect(button().getAttribute("title")).toBe(
      "对比已关：点开把 600036.SH 的收盘叠到主图，走独立标尺、不改主图价格轴",
    );
    // 支 1：分时态（排在最前，靠的是同一句三元的第一支）。
    fireEvent.click(screen.getByRole("button", { name: "分时" }));
    await flush();
    expect(button().getAttribute("title")).toBe(
      "跨市场的分钟时刻不在同一把尺上，分时视图看不了对比，先切回蜡烛",
    );
    expect(button().getAttribute("aria-pressed")).toBe("false");
  });

  it("分时态不取数、不挂；回 K 线自己挂回来且键还在原地", async () => {
    localStorage.setItem(COMPARE_PREFS_KEY, "600036.SH");
    localStorage.setItem(VPVR_PREFS_KEY, "1");
    localStorage.setItem(HEIKIN_ASHI_PREFS_KEY, "1");
    render(<ProChart />);
    await flush();
    // 挂载那一趟（K 线态、键里有标的）本来就发得出一次取数，那是 §五 的本分不是本支的题；
    // 把这一格清零，下面那句 `toHaveLength(0)` 判的才是它要判的那件事：**进分时之后一次都不发**。
    h.fetchCalls = [];
    fireEvent.click(screen.getByRole("button", { name: "分时" }));
    await flush();
    expect(cmpLive()).toHaveLength(0);
    expect(h.fetchCalls.filter((c) => c.symbol === "600036.SH")).toHaveLength(0);
    expect(localStorage.getItem(COMPARE_PREFS_KEY)).toBe("600036.SH");
    fireEvent.click(screen.getByRole("button", { name: "分时" }));
    await flush();
    // 三件共存：谁也没吃掉谁（`isStack` 为假的话这里只剩对比一份）。
    expect(cmpLive()).toHaveLength(1);
    expect(haLive()).toHaveLength(1);
    expect(vpLive()).toHaveLength(1);
  });

  it("StrictMode 双挂载：请求可能发两次，但数据必须到（R13）", async () => {
    // 预置偏好而不是现场点按钮：双挂载发生在挂载那一刻，取数 effect 的 cleanup
    // （`abort()` + `compareInflight.delete(key)`）只有在这一趟里才走得到。
    localStorage.setItem(COMPARE_PREFS_KEY, "600036.SH");
    render(
      <StrictMode>
        <ProChart />
      </StrictMode>,
    );
    await flush();
    // 第二趟 flush：取数落地只保证 promise 到家，挂卸 effect 要在它触发的再一次
    // commit 里才跑（`cmpSeries` 换身份那一轮，见 §四 / R10）。
    await flush();
    expect(cmpLive()).toHaveLength(1);
  });

  it("错误臂：输入框 title 带那句「原因：」，且不挂任何东西、不砸主图", async () => {
    h.cmpError = "FutuOpenD 未应答";
    render(<ProChart />);
    await flush();
    typeCompare("600036.SH");
    fireEvent.click(button());
    await flush();
    expect(cmpLive()).toHaveLength(0);
    expect(field().getAttribute("title")).toContain("原因：FutuOpenD 未应答");
    expect(button().getAttribute("aria-pressed")).toBe("false");
    // 失败只丢叠加层（§五）：主图的数据面与指标面一格没动。
    expect(h.indicators.some((i) => i.name === "MA")).toBe(true);
    // 关掉要把这一趟的说法一起收掉：输入框 `title` 的错误那一支问的是 `cmpOn && error`。
    // 而收的方式是**藏起渲染**而不是清零状态——清零会让同一标的再点开时（那一拍不重新取数）
    // 连这句原话一起永久失去。
    fireEvent.click(button());
    await flush();
    expect(field().getAttribute("title")).not.toContain("原因：");
  });

  it("空图：按钮 disabled 且理由说实话（不声称画得上线）", async () => {
    h.list = [];
    render(<ProChart />);
    await flush();
    typeCompare("600036.SH");
    expect(button().disabled).toBe(true);
    expect(cmpLive()).toHaveLength(0);
  });
});

describe("/pro-chart 多标的叠加对比的真值边界（spec §八）", () => {
  // 这四条**原样搬**自第⑤片文件 `ProChartVpvr.test.tsx` 的同名件：期望值一格没改，只把触发源
  // 从「量分布」换成「对比」（先 `typeCompare` 再点开关），并把条目名改成对比口径。
  // 判的仍是那件事：一个新图层不许碰数据面／画线面／样式面。

  it("对比开→关来回：数据面没被重建、也没被就地改写（两侧都量）", async () => {
    render(<ProChart />);
    await flush();
    const snapshot = JSON.stringify(h.list);
    const resets = h.resets;

    typeCompare("600036.SH");
    fireEvent.click(button());
    await flush();
    // 「只量开的那一次」是第④片 R12 的教训：卸的一路（`removeIndicator({name})`）
    // 要是顺手重建了 data，只在开的一侧读不出来。
    // 两半各有各的牙，且都是**当场测得出**的形状：`h.resets` 判「有没有走 `resetData()` 重建」
    // （针：`chart.resetData()` 一句就红），`snapshot` 判「有没有把已有 bar 的值改掉」
    // （针：`chart.getDataList()[0].volume = 0` 就红）。数组**身份**判不了——替身里没有任何
    // 合法通道能换掉 `h.list`（`ask()` 的 callback 是 `() => undefined`，真库 `resetData()` 不吃数组），
    // 一条 `expect(h.list).toBe(before)` 是恒绿的，所以这一版把它换成了计数。
    expect(h.resets).toBe(resets);
    expect(JSON.stringify(h.list)).toBe(snapshot);

    fireEvent.click(button());
    await flush();
    expect(h.resets).toBe(resets);
    expect(JSON.stringify(h.list)).toBe(snapshot);
  });

  it("对比不写画线面：锚点分毫未动、`overrideOverlay` 一次不多", async () => {
    render(<ProChart />);
    await flush();
    const anchor = JSON.stringify(h.overlays[0].points);
    const overrides = h.overridden.length;
    // M5（第⑤片补牙）：删线那一路。判据是「没长」而不是「等于空」——挂载那一路自己就调过一次
    // 整面清（换标的/换周期时页面会 `chart.removeOverlay()`），所以基线取在挂载之后。
    const removals = h.removedOverlays.length;
    // M6（第⑤片补牙）：整只桶的逐字节快照，同样取在挂载之后（`restoreDrawings` 有权往桶里放线）。
    // 整桶快照一次判掉名字、条数与顺序，不赌某个名字 ⇒ 一条自绘的 `segment`／`priceLine` 读得到。
    const bucket = JSON.stringify(h.overlays);
    // 三支点击（开→关→开）的形状照第⑤片那一支：两侧都走一遍，`isStack` 与叠放次序都判得到。
    typeCompare("600036.SH");
    for (let i = 0; i < 3; i++) {
      fireEvent.click(button());
      await flush();
    }
    // 判据是「相等」不是「长度增量为 0」——候选集（`beforeEach` 种的那条线）在，
    // 但重锚会把 points 换掉，所以两条都得判（第④片 R13 的形状）。
    expect(JSON.stringify(h.overlays[0].points)).toBe(anchor);
    expect(h.overridden.length).toBe(overrides);
    expect(h.removedOverlays.length).toBe(removals);
    expect(JSON.stringify(h.overlays)).toBe(bucket);
  });

  it("对比不碰画线落盘面：`pro-chart.drawings.v1` 开前事后相同", async () => {
    // 候选集（第④片 R13 的形状）：`beforeEach` 清了 localStorage，而挂载那一路只在
    // 「桶里有画线」时才读它、且只有吸回越界锚点时才回写——空桶时这一格从头到尾是 `null`，
    // `null` 等于 `null` 就是一条结构性不可红的针。所以先按页面自己的格式
    // （`chartDrawings.ts` 的 `BucketMap`：键 `标的|周期`，值是 `StoredDrawing[]`）种一条
    // 真线进去，`afterMount` 才是**有内容的字节**，「开前事后相同」才判得出东西被改。
    // 锚点从**当次喂进去的数据**里取（M1），不是把 `barOf()` 的公式在测试体里抄一遍。
    const lastTs = (h.list[h.list.length - 1] as { timestamp: number }).timestamp;
    localStorage.setItem(
      "pro-chart.drawings.v1",
      JSON.stringify({
        "600519.SH|1D": [
          {
            name: "horizontalStraightLine",
            paneId: "candle_pane",
            points: [{ timestamp: lastTs, value: 1234.5 }],
          },
        ],
      }),
    );
    render(<ProChart />);
    await flush();
    // I1（第⑤片补牙）：基线取在**挂载之后、点击之前**，而不是「开之后」。起点仍是「挂载之后」
    // 而不是「render 之前」：挂载那一路本来就有权吸回越界锚点并回写，那是这条管之外的事。
    // 这条只管一件事：开／关对比不是任何一次 `saveDrawings` 的理由——所以两侧各与挂载态比一次。
    const afterMount = localStorage.getItem("pro-chart.drawings.v1");
    // 候选集自检（第④片最贵教训的形状）：这一格没内容，下面两条比较就是空转。
    expect(afterMount).not.toBeNull();
    typeCompare("600036.SH");
    fireEvent.click(button());
    await flush();
    // 「开」的一侧：与挂载态逐字节比。
    expect(localStorage.getItem("pro-chart.drawings.v1")).toBe(afterMount);
    fireEvent.click(button());
    await flush();
    // 「关」的一侧：也与挂载态比，不是与「开之后」比。
    expect(localStorage.getItem("pro-chart.drawings.v1")).toBe(afterMount);
  });

  it("样式面零影响：`indicator` 子树仍恰是 [\"tooltip\"]，九色不因对比变化", async () => {
    render(<ProChart />);
    await flush();
    // F3（第⑤片补牙）：先抓一次**推送次数**。下面那两行读的是「最后一格里有什么」，而「挂对比不推
    // 新格」这半句没有任何断言读它——不推新格时 `before === last`，那是同一个值自比。
    const pushesBefore = pushCount();
    const before = pushesBefore - 1;
    const keysBefore = Object.keys((styleAt(before) as { indicator: Record<string, unknown> }).indicator);
    const barBefore = JSON.stringify(barColors(before));

    typeCompare("600036.SH");
    fireEvent.click(button());
    await flush();
    // 挂对比不是一次样式事件：它不该推新格（`pushesBefore` 这一句判的就是这个）。
    // 页面**不读 `chartStyles` 的合成点**、也不写任何样式键，这是本片硬约束的结构半边。
    expect(pushCount()).toBe(pushesBefore);
    const last = pushCount() - 1;
    expect(Object.keys((styleAt(last) as { indicator: Record<string, unknown> }).indicator)).toEqual(keysBefore);
    expect(Object.keys((styleAt(last) as { indicator: Record<string, unknown> }).indicator)).toEqual(["tooltip"]);
    expect(JSON.stringify(barColors(last))).toBe(barBefore);
    for (const key of NINE_BAR_KEYS) expect(barColors(last)[key]).not.toBe("transparent");
    expect(candleType(last)).toBe("candle_solid");
    expect(priceMark(last)).toBeDefined();
    // 另两格的读数口，各钉一次——它们是「对比不写样式」的另一半：
    // ① 建图推送点（`init` 的 `styles` 选项）也得是真蜡烛九色。叠一条线不是把蜡烛藏起来的
    //    理由；那九格被写成 `transparent` 时第④片会红，但「对比没脏样式」得由本片自己判住。
    for (const key of NINE_BAR_KEYS) expect(initBarColors()[key]).not.toBe("transparent");
    // ② 主图图例模板仍是蜡烛那六格。对比的读数走的是它自己指标的 figure（`symbolCompareChart.ts`
    //    的 `figures[0]`），不是往 `candle.tooltip.legend.template` 后面追加第七行——
    //    追加了就是对比线脏了图例面。
    expect(tooltipTemplate(last)).toHaveLength(6);
    // 卸的一侧再数一次次数：第④片 R12 的教训是「只在开的一侧读，卸的那一路顺手推了一格就读不出来」。
    // 第⑤片针 H4b 实测过这一格（给卸的一支加一句「现活着才 `setStyles`」⇒ 次数那句红）。
    fireEvent.click(button());
    await flush();
    expect(pushCount()).toBe(pushesBefore);
  });
});
