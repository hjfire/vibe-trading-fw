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
  // 主图那一趟的错误旗。`cmpError` 是一枚**全局**旗（每一趟都抛），所以它造不出「同一次挂载里
  // 一趟成功、另一趟失败」的形状；这一格只让 `symbol === "600519.SH"` 那一路抛，专供
  // 「换周期的 `init` 失败 ⇒ 库把 `dataList` 清空」那一格（seat-3 的 S3-1）。
  mainError: null as string | null,
  // 对比那一趟的**手动闸门**：非 null 时 `fetchKline` 必须先等它 resolve 才交回数。
  // 「取数在飞」那一格在别处读不出来——替身交回的是立刻起跳的 promise，`await flush()` 一到就
  // 结清了，于是 `cmpStatus.loading` 为真的那一支永远只被「已落地」的那几支盖住（摘掉它不会有
  // 任何东西变红）。同步读 DOM 能撞进那一格，但代价是一支带 `act(...)` 警告的用例。
  cmpHold: null as Promise<void> | null,
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
        // `_createOrUseIndicatorYAxis` 全体（`index.esm.js:15241-15252`）：轴不存在就建出来，
        // 且这条路径**不设 manual**（`:15247-15248` 只把已存在的 manual 标记取消）。
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
      // **替身只录调用、不摆轴，而这一格读不出东西不是偷懒**：两种先后都被库自己中和——
      // `createYAxis` 在前时，指标挂载路径会把已存在轴上的 manual 标记取消
      // （`_createOrUseIndicatorYAxis`，`index.esm.js:15247-15248`；`createIndicator` 在 `:15282`
      // 调它、`:15283` 接着扫孤儿轴）；`createYAxis` 在后时，它遇已存在轴直接早退、根本不打
      // manual（`:15479-15480`）⇒ 轴表那两格对这条用法没有牙，见证只有下面那格的调用计数。
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
        // 抛出去的那一路照的是页面上真实存在的一种结局：`getBars` 的 catch 交回 `callback([], false)`，
        // 而库的 `case 'init'` 收到空数组就是 `_clearData()`（`index.esm.js:13454-13456`）⇒ 屏上的
        // 根数落地了，页面 state 里那一格（`barCount`）若只跟成功路径写就会留下上一答的正数。
        if (h.mainError !== null) throw new Error(h.mainError);
        return {
          bars: params.before == null ? h.list : [],
          source: "fake-main",
          symbol: "600519.SH",
          interval: "1D",
        };
      }
      // 闸门在错误之前：错误那一支自己不带在飞态的题（它要的是"结清之后"的形状）。
      if (h.cmpHold !== null) await h.cmpHold;
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

/** 目录是浮层。工具栏里唯一一枚自陈 haspopup=menu 的按钮就是周期入口——
 *  按属性定位而不是按可达名，因为它的名字随当前档位变。 */
const periodTrigger = (): HTMLElement => {
  const candidates = screen
    .getAllByRole("button")
    .filter((b) => b.getAttribute("aria-haspopup") === "menu");
  expect(candidates).toHaveLength(1);
  return candidates[0];
};

const optionOf = (label: string): HTMLButtonElement =>
  screen.getByRole("option", { name: label }) as HTMLButtonElement;

/** 幂等地把目录打开：已经开着就一步都不做。
 *  写成无条件点入口的话，凡是「先开目录读一行、再选一行」的调用点都会在第二次点入口时
 *  把目录关掉，于是 `optionOf` 数不到东西——那是 helper 自己的坑，不是被测实现的缺陷。 */
async function openPeriodMenu(): Promise<void> {
  if (periodTrigger().getAttribute("aria-expanded") === "true") return;
  await act(async () => {
    fireEvent.click(periodTrigger());
  });
}

async function pickPeriod(label: string): Promise<void> {
  await openPeriodMenu();
  await act(async () => {
    fireEvent.click(optionOf(label));
  });
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
  h.mainError = null;
  h.cmpHold = null;
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
  // Panel visibility is a `sessionStorage` key now (L3 第①片) and jsdom hands a whole
  // file one session store. No pin here flips one of those four switches today, so this
  // clear is preventive: the day one does, the file stops depending on its run order.
  sessionStorage.clear();
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
    await pickPeriod("周线");
    await flush();
    expect(cmpLive()).toHaveLength(1);
    // 「挂上之后 `calc` 交出的行里有非 null 值」这半条不在本文件判——页面替身的
    // `registerIndicator` 是 `vi.fn()`，`calc` 不在这里跑。它落在 T2 的
    // 「calc 读 activeKey 那一条序列」那根针上（同一条 §十·②b，两个判据面）。
  });

  it("对比交回 0 根却带着 source：小字只许说主图那半句", async () => {
    // `marketApi.ts:260`/`:265` 的形状：`s:"ok"` 时 `columnsToBars` 交空数组、`source` 照抄后端那格
    // ⇒ `cmpStatus.source` 非空而 `cmpReady` 为假（`ProChart.tsx:758-759` 问的是 `bars.length > 0`）。
    // 那一屏按钮说的是「数据还没到位」，正下方若还在讲「对 fake-cmp」，两句话互相打脸。
    h.cmpBars = [];
    render(<ProChart />);
    await flush();
    typeCompare("600036.SH");
    fireEvent.click(button());
    await flush();
    expect(cmpLive()).toHaveLength(0);
    expect(screen.getByText(/来源：主/).textContent).not.toContain("对 fake-cmp");
    // 「还没到位」是**进行中**的说法，而这一格取数早就结清了（`loading` 假、`error` 空），
    // 后半句还把用户指到输入框那一行——那一行走的是 `error !== null` 的门，那里没有原因可看
    // （整支评审 F-3）。终态空结果有它自己那一支。
    expect(button().getAttribute("title")).toBe(
      "对比此刻画不出线：可视区间里没有可用的收盘价（对比侧结果为空，或主图还没有蜡烛）",
    );
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

  it("关掉那一下：一条请求都不许多发", async () => {
    // 依赖数组里有 `cmpOn`（同一标的原地重试的唯一入口），守卫里就必须同样读它：只加依赖不加
    // 守卫的话，「关掉」那一次重跑会穿过 `cmpSymbol`/`timeShare` 两格（会话内不清，见 §四）。
    // **但这一支挡不住摘掉 `!cmpOn`**：健康态里 `cmpReady` 为真，重跑先撞它的早退（变异复证 P1
    // 摘掉守卫，22 支全绿）。这一支钉的是「关掉之后线没了、数也没多」这件事本身，`!cmpOn` 那一格
    // 的见证在下面那支失败态里。
    render(<ProChart />);
    await flush();
    typeCompare("600036.SH");
    fireEvent.click(button());
    await flush();
    expect(h.fetchCalls.filter((c) => c.symbol === "600036.SH")).toHaveLength(1);
    fireEvent.click(button());
    await flush();
    expect(h.fetchCalls.filter((c) => c.symbol === "600036.SH")).toHaveLength(1);
    expect(cmpLive()).toHaveLength(0);
  });

  it("取数失败之后关掉：一条都不许多发（`!cmpOn` 那一格唯一的见证）", async () => {
    // 只有**失败那一趟**把 `cmpReady` 打成假，穿过守卫的才只剩 `!cmpOn`：那一格被摘掉时，关掉的
    // 那一下会真的补发一趟——用户已经把线关了，页面还在为他看不见的那条线取数，并把
    // `cmpStatus.loading` 拨回真（整支评审 F-10 说的正是这一格）。
    h.cmpError = "FutuOpenD 未应答";
    render(<ProChart />);
    await flush();
    typeCompare("600036.SH");
    fireEvent.click(button());
    await flush();
    const before = h.fetchCalls.filter((c) => c.symbol === "600036.SH").length;
    expect(before).toBe(1);
    h.cmpError = null; // 网关回来了，但这一支不重取，只看关掉那一下发不发
    fireEvent.click(button());
    await flush();
    expect(h.fetchCalls.filter((c) => c.symbol === "600036.SH")).toHaveLength(before);
    expect(cmpLive()).toHaveLength(0);
  });

  it("健康态关掉再点开：不许重发，小字靠留在会话里的那一趟回来", async () => {
    // 这一支是「关掉不清 `cmpStatus`」那条改判的**前提**，不是它的重复：重开那一下依赖真的变了
    // （`cmpOn`），所以必须靠 `cmpReady` 早退把它挡住——挡住之后线照样立刻有（序列本来就在模块
    // store 里），而那行小字靠的是**没有被动过**的 `cmpStatus.source`。要是这里放行去重取，
    // 「关→开不重新取数」这句话连同下面那支的牙一起就没了（整支评审 F-9）。
    render(<ProChart />);
    await flush();
    typeCompare("600036.SH");
    fireEvent.click(button());
    await flush();
    fireEvent.click(button());
    await flush();
    fireEvent.click(button());
    await flush();
    expect(h.fetchCalls.filter((c) => c.symbol === "600036.SH")).toHaveLength(1);
    expect(cmpLive()).toHaveLength(1);
    expect(screen.queryByText(/对 fake-cmp/)).not.toBeNull();
  });

  it("主图 0 根而对比已取到数：开关不许说开着，小字也不许说「对」", async () => {
    // `cmpReady` 量的是「store 里这条序列非空」，可画不可画还要看主图有没有根：`calc` 对空
    // `dataList` 交 0 行 ⇒ 线必然不存在（`marketApi` 那侧对比取数照样成功）。这一格原来三句
    // 谎同时成立——`aria-pressed="true"`、亮环、小字印「对 fake-cmp」——而**这颗按钮就是关掉
    // 对比的唯一 actor，此刻还被 `barCount === 0` 禁着**（整支评审 F-2）。
    // 偏好恢复而不是现场点按钮：现场点会被 `disabled` 吞掉，`cmpOn` 全程为假就测不到这一格。
    localStorage.setItem(COMPARE_PREFS_KEY, "600036.SH");
    h.list = [];
    render(<ProChart />);
    await flush();
    await flush();
    // 这一格**不**断挂载面：挂卸问的是 `compareActive`，`barCount` 不在它的谓词里，指标照旧挂着；
    // 而「线上没有线」这件事由数据保证——`calc` 对空 `dataList` 交 0 行，一条都不画。把
    // `cmpLive()` 钉成 0 会把「读数为假时必须不挂」钉成契约，而那是两条独立的事，将来谁想
    // 顺手让挂载也看 `barCount`，都会被这根没有用户价值的针挡回去。
    expect(button().getAttribute("aria-pressed")).toBe("false");
    const row = screen.getByText(/来源：主/);
    expect(row.textContent).not.toContain("对 fake-cmp");
    expect(button().getAttribute("title")).toBe(
      "对比此刻画不出线：可视区间里没有可用的收盘价（对比侧结果为空，或主图还没有蜡烛）",
    );
  });

  it("换周期那一趟 init 取数失败：库清空 dataList，开关与小字必须跟着落地", async () => {
    // seat-3 的 S3-1。`cmpShown` 的第二格读的是 `barCount`，而它原先**只在成功路径**里写
    // （`ProChart.tsx` 的 `if (type === "init") setBarCount(bars.length)`）：换周期／换标的那一趟以
    // `init` 起跑、以异常收尾时，页面的 catch 交回 `callback([], false)`，库的 `case 'init'` 收到空
    // 数组就是 `_clearData()`（`index.esm.js:13454-13456`）⇒ 屏上一根不剩，state 里却留着上一答的
    // 6 根 ⇒ 按钮 `aria-pressed="true"`、亮环、小字「· 对 X」、title 走「已开」那支，而那一刻一条线
    // 都画不出来（`calc` 读到空 `dataList` 交 0 行）。与「主图 0 根」那支同族，区别在根数是**从 N
    // 掉到 0** 的——那一支从起点就是 0，所以它挡不住这一格。
    render(<ProChart />);
    await flush();
    typeCompare("600036.SH");
    fireEvent.click(button());
    await flush();
    // 前置：先把「开着且画得出线」读实，否则下面四句在任何一屏都绿（候选集交成空集那类假绿）。
    expect(button().getAttribute("aria-pressed")).toBe("true");
    h.mainError = "FutuOpenD 未应答";
    await pickPeriod("周线");
    await flush();
    expect(button().getAttribute("aria-pressed")).toBe("false");
    expect(button().getAttribute("title")).toBe(
      "对比此刻画不出线：可视区间里没有可用的收盘价（对比侧结果为空，或主图还没有蜡烛）",
    );
    expect(screen.queryByText(/对 fake-cmp/)).toBeNull();
    // 主图那半句跟着 `status.source` 一起落地（失败路径把 `source` 写成 ""，那是 §五 的本分）。
    expect(screen.getByText(/来源：主/).textContent).toBe("来源：主 -");
  });

  it("A 成功 → B 失败 → 回到 A：陈旧那一趟的读数不许跨键说话", async () => {
    // seat-3 的 S3-2（本轮新格子直接造出来的那一格）。`cmpStatus` 记的是**一趟**的读数，`cmpKey`／
    // `cmpReady` 记的是**当前这把键**，而取数守卫里那句 `|| cmpReady` 早退恰好挡住了唯一能把陈旧
    // 读数冲掉的通路（重取）。于是「打错一个代码、再打回正确的」这一句最自然的手势上三句话同时假：
    // title 走「上一趟取数失败」那支（真话那支读不到）、那句「把它关掉再点开就重取」是一句可证明的
    // 空转（关掉撞 `!cmpOn`、再点开撞 `cmpReady`，没有任何一趟会清掉 `error`）、失败把 `source` 写成
    // "" ⇒ 一条**正在显示**的线，它的来源小字整行消失。
    // 判据的前提是回到 A 那一趟**没有**重发（早退），所以这里先数请求条数——否则实现改成"回来就重取"
    // 也能把这三句挣绿，而那正是计划行 11 与「健康态关掉再点开」两支反对的形状。
    render(<ProChart />);
    await flush();
    typeCompare("600036.SH");
    fireEvent.click(button());
    await flush();
    expect(button().getAttribute("title")).toContain("对比已开");
    h.cmpError = "913011:未寻得该标的";
    typeCompare("000001.SZ");
    fireEvent.click(button());
    await flush();
    // B 那一趟：当前键就是 B，且真有一趟失败过 ⇒ 这一格说「上一趟取数失败」是真话。
    expect(field().getAttribute("title")).toContain("原因：913011");
    // 而那一行小字此刻**不说话**：当前这把键（B）没有任何交付过的序列，A 那一趟的来源串不属于它
    // ——这是 `cmpSource` 里那枚键判据唯一的读数面（摘掉键判据，整行会带着 A 的来源重新出现）。
    expect(screen.queryByText(/来源：主/)).toBeNull();
    h.cmpError = null;
    typeCompare("600036.SH");
    fireEvent.click(button());
    await flush();
    expect(h.fetchCalls.filter((c) => c.symbol === "600036.SH")).toHaveLength(1);
    expect(cmpLive()).toHaveLength(1);
    expect(button().getAttribute("title")).toBe(
      "对比已开：把可视区间同一把时间轴上的 600036.SH 收盘画成折线，用它自己那根右侧标尺，不进主图价格轴（再点切回）",
    );
    expect(field().getAttribute("title")).not.toContain("原因：");
    expect(screen.getByText(/来源：主/).textContent).toContain("对 fake-cmp");
  });

  it("关掉再开：来源小字跟着线一起回来（门加在渲染侧，不加在状态侧）", async () => {
    // 这一支钉的是「门加在渲染侧，不加在状态侧」这个形状，它有**两枚**可摘的牙：①把来源行外层那枚
    // `cmpOn` 门摘掉 ⇒ 本支红（变异 q4）；②把关掉那一下改成「往状态侧清 `source`」⇒ 本支与
    // 「健康态关掉再点开」那支一起红（变异 q9，红 2）。形状搬过家之后旧的那版反事实已表达不出伤害：
    // 第 1 轮的修法 `setCmpStatus({ loading: false, error: null, source: "" })` 里根本没有 `source`
    // 这一格了（它随 S3-2 搬进 `cmpSeries`），照直译清一遍 `cmpStatus` 是 25 全绿（变异 q10）——
    // 别把行 11 那格当本形的见证。清掉的为什么补不回来：关→开**不重新取数**（重开那一轮被守卫里
    // `cmpOn` 之后的 `cmpReady` 早退挡住：上一趟成功过，序列本来就在 store 里，重取只会把已经在
    // 线上的东西再取一遍），于是那行小字在会话余下时间里再也不出现，而对比线挂得好好的。
    // 渲染侧的门得到的是同一句诚实话，且不丢信息。
    render(<ProChart />);
    await flush();
    typeCompare("600036.SH");
    fireEvent.click(button());
    await flush();
    expect(screen.queryByText(/对 fake-cmp/)).not.toBeNull();
    // 基线：整行在。下面关闭那一拍的 `toBeNull()` 若单独存在，读者会以为它测的是「· 对」那半句
    // ——那是上一句的题。这两格一起把**外层那枚 `cmpOn` 门**钉住：seat-3 实测只摘它 ⇒ 23 全绿，
    // 因为全套件没有任何一句判过这一整行的出现与消失（第四处显示面，零见证）。
    expect(screen.queryByText(/来源：主/)).not.toBeNull();
    fireEvent.click(button());
    await flush();
    expect(cmpLive()).toHaveLength(0);
    expect(screen.queryByText(/对 fake-cmp/)).toBeNull();
    expect(screen.queryByText(/来源：主/)).toBeNull();
    fireEvent.click(button());
    await flush();
    expect(cmpLive()).toHaveLength(1);
    expect(screen.queryByText(/对 fake-cmp/)).not.toBeNull();
    expect(screen.queryByText(/来源：主/)).not.toBeNull();
  });

  it("取数在飞那一句说「还没回来」，落地之后换成「已开」那一句（支 3 → 支 6）", async () => {
    // 原形状里「在飞」与「结果为空」共用一支，两格都说"还没到位"——分成两支之后每一支都要有
    // 东西钉着，否则摘掉 `loading` 那一格没有任何东西变红。闸门是这里唯一的取证手段：替身交回
    // 的 promise 一到 `await flush()` 就结清，不按住它就只能读到结清之后的那一支。
    let release!: () => void;
    h.cmpHold = new Promise<void>((r) => {
      release = r;
    });
    render(<ProChart />);
    await flush();
    typeCompare("600036.SH");
    fireEvent.click(button());
    await flush();
    expect(button().getAttribute("title")).toBe(
      "对比标的正在取数：这一趟还没回来，图上此刻没有对比线",
    );
    expect(cmpLive()).toHaveLength(0);
    release();
    await flush();
    expect(button().getAttribute("title")).toBe(
      "对比已开：把可视区间同一把时间轴上的 600036.SH 收盘画成折线，用它自己那根右侧标尺，不进主图价格轴（再点切回）",
    );
    expect(cmpLive()).toHaveLength(1);
  });

  it("七支 title 逐字钉，且「画不出线」那几支排在「已开」之前才读得到（§十·⑥ / §七 的判别顺序）", async () => {
    render(<ProChart />);
    await flush();
    // 支 2：没有已应用标的。
    expect(button().getAttribute("title")).toBe(
      "先在左边输入对比标的（如 600036.SH 或 BTC-USDT），点它才叠到主图",
    );
    typeCompare("600036.SH");
    fireEvent.click(button());
    await flush();
    // 支 6：已开（cmpSymbol 就是刚应用的串）。
    expect(button().getAttribute("title")).toBe(
      "对比已开：把可视区间同一把时间轴上的 600036.SH 收盘画成折线，用它自己那根右侧标尺，不进主图价格轴（再点切回）",
    );
    // 支 5：开着的、取数也结清了，但画不出线。制造它要**换一次周期**——`cmpSymbol` 与 `interval`
    // 都没变的那一轮被 `cmpReady` 早退挡掉了（那是「关→开不重取」的同一条判据），换周期令键变、
    // 重取、交回空数组 ⇒ 这一格才是「开关不亮而 cmpOn 为真」。
    // 顺序是设计的一部分（§七）：把这一支挪到「已开」之后，这条针就永远绿——而那一格说的是
    // "把进行中说成已完成"的那句「画成折线」，图上此刻根本没有折线。
    h.cmpBars = [];
    await pickPeriod("周线");
    await flush();
    expect(button().getAttribute("title")).toBe(
      "对比此刻画不出线：可视区间里没有可用的收盘价（对比侧结果为空，或主图还没有蜡烛）",
    );
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

  it("输入框非错误态的默认 title 逐字钉", async () => {
    // §七 只规定了错误那一支要带「原因：」，§十·⑥ 只逐字钉了按钮那五支——输入框的另一支
    // 一直没有针，改坏它不会有任何东西变红。
    render(<ProChart />);
    await flush();
    expect(field().getAttribute("title")).toBe(
      "叠到主图的第二个标的：走它自己那根右侧标尺，不进主图价格轴。输入完整代码后点右边的「对比」",
    );
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

  it("分时态：线不画，小字里「对 X」那半句跟着一起收掉", async () => {
    localStorage.setItem(COMPARE_PREFS_KEY, "600036.SH");
    render(<ProChart />);
    await flush();
    await flush();
    expect(screen.getByText(/来源：主/).textContent).toContain("对 fake-cmp");
    fireEvent.click(screen.getByRole("button", { name: "分时" }));
    await flush();
    // `compareActive` 第一格之外，`timeShare` 本身就让它为假 ⇒ 这一屏没有对比线，
    // 而那一行小字的外层门只问 `cmpOn`——所以要说实话的是「· 对 X」那半句，不是整行。
    expect(cmpLive()).toHaveLength(0);
    const row = screen.getByText(/来源：主/);
    expect(row.textContent).not.toContain("对 fake-cmp");
    expect(row.textContent).toContain("主 fake-main");
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
    // 按钮那句问的是「上一趟失败」这一格，不是笼统的「还没到位」：那一格里根本没有请求在飞
    // （`:finally` 已经结清），而它原先的后半句把用户指到输入框那一行——那一行此刻确实有原因，
    // 但只有失败这一支指过去才算指对了地方（整支评审 F-3）。
    expect(button().getAttribute("title")).toBe(
      "对比标的上一趟取数失败：原因看左边输入框那行的提示，把它关掉再点开就重取",
    );
    expect(button().getAttribute("aria-pressed")).toBe("false");
    // 失败只丢叠加层（§五）：主图的数据面与指标面一格没动。
    expect(h.indicators.some((i) => i.name === "MA")).toBe(true);
    // 关掉要把这一趟的说法一起收掉：输入框 `title` 的错误那一支问的是 `cmpOn && error`。
    // 而收的方式是**藏起渲染**而不是清零状态——清零会把这句原话连同再点开时该回来的东西一起弄丢。
    fireEvent.click(button());
    await flush();
    expect(field().getAttribute("title")).not.toContain("原因：");
  });

  it("同标的取数失败之后关掉再点开：必须重新发一趟", async () => {
    // 那句「原因：<errmsg 原文>」是给用户的行动依据（spec §五：区分"重启 OpenD"与网络故障）。
    // 原形状里 `cmpOn` 不在取数依赖里，重启网关之后页面上**不存在**同标的原地重试——只能换周期
    // 或换标的，而两者都会改可视区间与已挂指标，代价比"再点一次"大得多。现在 `cmpOn` 在依赖里，
    // 而上一趟失败过 ⇒ `cmpReady` 为假 ⇒ 早退不成立 ⇒ 真的重发。摘掉依赖里那一格 `cmpOn`，
    // 下面那句 `toBeGreaterThan` 立刻红（这一支是它唯一的牙）。
    h.cmpError = "FutuOpenD 未应答";
    render(<ProChart />);
    await flush();
    typeCompare("600036.SH");
    fireEvent.click(button());
    await flush();
    expect(field().getAttribute("title")).toContain("原因：FutuOpenD 未应答");
    const before = h.fetchCalls.filter((c) => c.symbol === "600036.SH").length;
    expect(before).toBe(1);
    h.cmpError = null; // 用户照那句话把网关回来了
    fireEvent.click(button());
    await flush();
    fireEvent.click(button());
    await flush();
    expect(h.fetchCalls.filter((c) => c.symbol === "600036.SH").length).toBeGreaterThan(before);
    expect(cmpLive()).toHaveLength(1);
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
