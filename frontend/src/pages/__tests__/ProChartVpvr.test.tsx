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
 * 本片要钉的面：
 * 1. 挂卸：先删后挂到 `candle_pane`、`isStack` 为真（真库 `addIndicator(create, isStack)`
 *    在假值时先清整格指标，共挂那条判的就是这一参没丢）；反复开关不堆叠，
 *    StrictMode 的第二次挂载不追加第二份——`syncVpvr` 的 `live.length === 0` 那一夹
 *    是多出一行图例的唯一挡板。
 * 2. 偏好键：开写 `"1"`，关**删键**（不是写 `"0"`，`chartLegend.ts` 的写侧纪律），
 *    分时永不改写它——回 K 线指标自己挂回来、键还在原地。
 * 3. 分时互斥：进分时必须卸掉 VPVR（面积线没有 [low, high] 区间可摊），
 *    `aria-pressed` 当场变 false，`title` 说的是面积线那个理由。
 * 4. 与 HA 的关系：共挂两个名字各一份、谁也没吃掉谁；卸一边不动另一边。
 * 5. 真值边界（Task 5，spec §八）：开关前后数据面既没被重建（`resetData` 计数不变）也没被
 *    就地改写（内容快照不变）、画线面锚点与 `overrideOverlay` 都不动、`pro-chart.drawings.v1` 落盘面逐字节不动、样式面只读不写、
 *    空图时按钮 disabled 且理由说实话。
 *
 * 样式面本片零改动：不写任何样式键。这一张有**两处**判据——本文件的「样式面零影响」那条
 * 读 `Object.keys(...).indicator === ["tooltip"]` 与九色／图例模板，第④片文件自己那条同型钉
 * 在它落地后回归全绿。库行号一律指 `dist/index.esm.js`（`dist/umd/klinecharts.js` 是同一份代码的
 * 另一个打包，同一符号的行号恒比 esm 大 5——实测三对：`StoreImp.addIndicator` 14150/14155、
 * `StoreImp.removeIndicator` 14195/14200、`StoreImp.overrideOverlay` 14430/14435；
 * 别在一句话里混用两个坐标）。
 * 所以 harness 的 `h.styles`／`h.initStyles` 录制面原样带过来。
 */

const h = vi.hoisted(() => ({
  styles: [] as Array<Record<string, unknown>>,
  // `init` 第二个入参里的 `styles` 选项，单独一格：那是 **init 推送点**
  // （`ProChart.tsx:1106`）唯一的出口，真机上首屏第一份样式就是它。不接住它，那一次调用
  // 就把合成好的对象丢进黑洞，`chartStyles(dark, session.timeShare, legend, false)` 写错
  // 也一个字都不会红。与 `styles`（`setStyles` 的录制，只有主题 effect `:1372` 那一处会写）
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
  // `resetData()` 被叫过几次。替身里 `h.list` 换不掉（`ask()` 的 callback 是 `() => undefined`，
  // 真库那条通道也不接受新数组），所以「VPVR 有没有重建数据」只能问这个计数，问不了数组身份。
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
}));

/**
 * 页面唯一的数据入口。替身只驱动 `init`：本片不分页，但 `init` 必须真的被回答一次，
 * 因为 `setBarCount`（`ProChart.tsx:1208`）只在那一次发生，而按钮的 disabled 判据读它。
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

/**
 * 图上此刻活着几份 VPVR（M2：两个 describe 共用**这一个**问法）。
 *
 * 以前本文件有两把同义的尺：这一格与文件底部那个 `vpKept()`（`h.indicators.some(...)`）——
 * 同一件事两种问法，于是「开着 VPVR 切主题」那条把同一个事实钉了两遍。`vpKept()` 已经删掉；
 * `vpLive()` 从第一个 describe 提到模块作用域，因为两个 describe 都要读它。
 * `vpCreates`／`haLive` 只有第一个 describe 用，留在原地。
 */
const vpLive = () => h.indicators.filter((i) => i.name === "VPVR");

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

/** `candle.bar` as the **init 推送点**（`init` 的 `styles` 选项，`ProChart.tsx:1106`）carried it. */
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
  // （`ProChart.tsx:1106`）唯一的出口。不接，页面在那儿合成好的对象就被替身扔掉，
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
        // （klinecharts 10.0.3，`dist/index.esm.js:14162-14164`）在 `isStack` 为假时先
        // `removeIndicator({ paneId })` 把目标格上的每一个指标清掉再挂新的，而
        // `ChartImp.createIndicator`（同文件 `:15274`）在调用方没传时按 `false` 算。
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
      // `resetData()` 在真库一个形参都不接（`ChartImp.prototype.resetData`，klinecharts 10.0.3，
      // `dist/index.esm.js:15253`；`:13652` 那个 `fn` 是**回调**，不是新数组）。所以这一格只能记账、
      // 不能换数组——数据面那条钉子判「VPVR 没有重建数据」读的就是 `h.resets`。
      resetData: () => {
        h.resets++;
        return ask();
      },
      setStyles: (s: Record<string, unknown>) => h.styles.push(s),
      resize: vi.fn(),
      // F1（补牙）：这一格以前是 `createOverlay: vi.fn()`——调用被吞掉、返回值是 `undefined`，
      // 而 `h.overlays` 唯一的写手是 `beforeEach` 种的那条线，于是「VPVR 没有以 overlay 的身份
      // 出现过」那条判据**结构上不可能红**：页面无论怎么走 overlay 通道都读不出来。真库
      // `ChartImp.createOverlay(value)`（klinecharts 10.0.3，`dist/index.esm.js:15359`）把那条
      // 交给 `addOverlays` 装进 store，非数组入参时返回铸出来的 id（`:15393-15396` 的 `ids[0]`），
      // 随后 `getOverlays()`（`:15398-15400`）就读得到它 ⇒ 替身照这个语义 append 回**同一个桶**，
      // 不新开一个桶：新开桶就等于承认「overlay 通道与画线面是两回事」，而 spec §〇 第 2 条怕的
      // 恰恰是它进的是同一个落盘通道。
      // 返回值给的是库的形状（一个真 id）而不是 `true`：页面 `createOverlay` 只有 `armTool`
      // （`ProChart.tsx:2003`）一处、不吃返回值，但 `chartDrawings.restoreDrawings:671-683` 吃
      // 它的真假来分「上图的」与「停放面的」——交回 `undefined` 会把每一张种进桶里的画线都停进
      // 停放面，交回 `true` 也不如交回一个像样的 id（针 H 之后这条链还在，别把它喂坏）。
      createOverlay: (o: Record<string, unknown>) => {
        const id = `o${h.overlays.length + 1}`;
        h.overlays.push({ ...o, id } as unknown as (typeof h.overlays)[number]);
        return id;
      },
      // `removeOverlay` 不补记：页面确实调它（`:1262` 整面清、`:1877`/`:1882` 停放面、`:2037` 清画线、
      // `:2106` 按 id），但本片没有任何一条判据读「overlay 少了哪条」。为没有判据的面加录制会把
      // `h.overlays[0]` 的下标语义改掉（「分布不写画线面」那条读的就是这一格的 `points`），
      // 那是拿死判据换活判据。
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
      // 那句「leave the zoom alone」（`ProChart.tsx:930`），这正是本片要的分支。
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
  h.resets = 0;
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
  // `vpLive()` 在模块作用域（见文件上半部），两个 describe 共用同一个问法（M2）。
  const vpCreates = () => h.created.filter((c) => (c as { name?: string }).name === "VPVR");
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
  // （klinecharts 10.0.3，`dist/index.esm.js:15270`）先给 create 铸一把新 id，
  // `StoreImp.addIndicator`（同文件 `:14150`，去重那一格是 `:14152`）再拿这把 id 去查，
  // 而带 id 的 filter 只按 id 匹配（`:14178-14180`）⇒ `isStack` 为真时它**永远追加**，
  // 看不见格上已有的那份。页面那段注释写的就是
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

  it("开→关来回：数据面没被重建、也没被就地改写（两侧都量）", async () => {
    render(<ProChart />);
    await flush();
    const snapshot = JSON.stringify(h.list);
    const resets = h.resets;

    fireEvent.click(screen.getByRole("button", { name: "量分布" }));
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

    fireEvent.click(screen.getByRole("button", { name: "量分布" }));
    await flush();
    expect(h.resets).toBe(resets);
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
    //
    // 锚点从**当次喂进去的数据**里取（M1）：这一格以前写的是 `1_700_000_000_000 + 5 * 86_400_000`,
    // 那是把 `barOf()` 的公式在测试体里抄了一遍，还隐式依赖 `seed()` 默认 6 根——数据面一动，
    // 这个字面量就与图无关了，而 `beforeEach` 种那条线时自己写过「锚点从当次喂进去的 `h.list`
    // 里取，不是一个与图无关的数字字面量」。这里读的是最后一根的真实 timestamp，所以种下去的线
    // 本来就落在最新那根上：挂载那一路（`clampDrawingsToLastBar`）不该吸回它，`mid` 判的确实是
    // 「开／关 VPVR 之后没人动过桶」，而不是「恰好没人重新吸盘」。
    // 读 `h.list` 要在 render 之前：它是 `beforeEach` 的 `seed()` 刚摆好的那一份。
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
    // 判据的起点是「挂载之后」，比的是两次点分布之间：挂载那一路本来就有权吸回越界锚点并回写
    // （`ProChart.tsx:1263` 读桶，`ProChart.tsx:1274` 的 `fixed.moved > 0 || fixed.dropped > 0` 才 `saveDrawings`），那是本片之外的事，
    // 不归这条管。这条只管一件事：开／关 VPVR 不是任何一次 `saveDrawings` 的理由。
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
    // F3（补牙）：先抓一次**推送次数**。下面那两行读的是「最后一格里有什么」，而「挂 VPVR 不推
    // 新格」这半句以前没有任何断言读它——不推新格时 `before === last`，那是同一个值自比（评审席
    // 这点说对了）。次数这条钉子只管**次数**，键集／九色／模板那几条管的是「推出来的那格里有什么」，
    // 两回事都留着。
    const pushesBefore = pushCount();
    const before = pushesBefore - 1;
    const keysBefore = Object.keys((styleAt(before) as { indicator: Record<string, unknown> }).indicator);
    const barBefore = JSON.stringify(barColors(before));

    fireEvent.click(screen.getByRole("button", { name: "量分布" }));
    await flush();
    // 挂 VPVR 不是一次样式事件：它不该推新格（`pushesBefore` 这一句判的就是这个）。
    // 若页面推了，那一格必须仍然只带 tooltip——那是下面几条管的事。
    expect(pushCount()).toBe(pushesBefore);
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
    // 主题 effect 推样式是它的本分；VPVR 不在这条链上，所以它不该因此被重挂。
    expect(h.created).toHaveLength(created);
    // M2：以前这里上面还压着一条 `expect(vpKept()).toBe(true)`，与这一条判的是同一个事实
    // （两个同义问法读同一个 `h.indicators`）。留**更强**的那一条：切主题后图上活的 VPVR
    // 不是一堆、也不止「还在」，而是恰好一份——`some()` 判不出重挂出来的第二份，这一条判得出。
    expect(vpLive()).toHaveLength(1);
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

