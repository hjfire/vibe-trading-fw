import { registerIndicator, type KLineData } from "klinecharts";

import { alignCloseToTimestamps, type CompareBar } from "./symbolCompare";

/**
 * 多标的叠加对比的库绑定面（第⑥片，spec §四）。
 *
 * 通道是 `createIndicator({paneId, yAxisId}, true)` 的**公开多轴通道**，不是第⑤片那条
 * `draw` 自绘：`ChartImp.createIndicator` 尊重调用方给的 `yAxisId`（`index.esm.js:15273`），
 * 随后 `_createOrUseIndicatorYAxis`（`index.esm.js:15241`）把不存在的轴**自己建出来**，
 * 走这条路的轴不是 manual ⇒ `_shouldUseCandleData()` 为假（`index.esm.js:980-983`），
 * 它不折主图蜡烛的 high/low，量程只由绑在它上面的 figure 数值决定。
 *
 * 三件承重的事：
 *
 * 1. **绝不 `createYAxis`**：`ChartImp.createYAxis` 会把轴标成 manual（`index.esm.js:15483`），
 *    而 manual 轴对 `_shouldUseCandleData()` 为真 ⇒ 一把刚建出来、还没挂指标的空尺会先把
 *    主图蜡烛撑进自己的量程；孤儿回收又正好跳过 manual（`index.esm.js:15234`）⇒ 切走对比会**漏一根轴**。
 * 2. **「不进主图价格轴」是结构保证而不是约定**：轴取数的唯一口径 `_getIndicatorsByYAxisIds()`
 *    的判据集合以本轴 id 起步，**只有本轴是 manual 时**才并上默认轴 id（`index.esm.js:967-973`，
 *    过滤那行在 `:978`）⇒ 非 manual 的轴只认自己的 id，我们那条自定义 id 不在主图轴的集合里，
 *    主图轴量程**不可能**被对比序列撑开。这就是不走 `draw` 自绘的全部理由——自绘会把这件事
 *    退化成"我们自己不去读那把尺"。
 * 3. **卸载即自动回收**：`ChartImp.removeIndicator` 在真删掉东西时调 `_removeOrphanYAxes()`
 *    （`index.esm.js:15327`），非 manual、无指标绑定的轴被删 ⇒ 本页不拥有轴的生命周期。
 *
 * `figures[0].type: "line"` 是**承重声明不是样式**：`prepareIndicatorFigures` 用
 * `isValid(figure.type)` 决定 figure 进不进渲染清单（`index.esm.js:3128`），省略它就得到
 * 一条静默不画的线，而图例行也一起消失（`IndicatorTooltipView` 遍历的是同一份产物，
 * `index.esm.js:7272-7273`）。缺口的形状交给库的 `null` 语义（spec §二·8）：`null` 被
 * `isValid`（`:8095`）与 `isNumber`（`:8084-8091`）双双挡下 ⇒ 既不断到基线，也不进 min/max。
 */

export const SYMBOL_COMPARE_NAME = "SYMBOL_COMPARE";
export const SYMBOL_COMPARE_SHORT_NAME = "对比";

/** 自定义轴 id。**必须**是稳定字面量：`_createOrUseIndicatorYAxis` 按 id 找轴复用（`index.esm.js:15241-15245`），换个 id 就是每次挂载多铸一根尺；值由测试逐字钉住，改名会被读出来。 */
export const COMPARE_AXIS_ID = "pro-chart-compare-y";

export const COMPARE_FIGURE_KEY = "cmp";
export const COMPARE_FIGURE_TITLE = "对比收盘";

/** 布尔偏好的最省键形的**串版**：值就是已应用的对比标的，缺键即关（spec §十二 R9）。 */
export const COMPARE_PREFS_KEY = "pro-chart.compare.v1";

/**
 * 一次取满的深度上限。后端把 `countback` **静默钳**到 `_MAX_BARS = 2000`
 * （`agent/src/api/udf_routes.py:473-474`、`agent/src/api/market_routes.py:52`），
 * 传更大值只会得到 2000 且不回传截断标记（代价登记在 spec §十一·5）。
 */
export const COMPARE_BARS = 2000;

/** 一行的产物形状：只有一个键，键名就是 `COMPARE_FIGURE_KEY`。 */
export type CompareRow = { [key in typeof COMPARE_FIGURE_KEY]: number | null };

/**
 * 单一谓词：页面挂卸侧、`aria-pressed` 与 className 都读它，不再各写一遍
 * （形状照第⑤片 `vpvrActive`，但多第三格 `ready`）。
 * 分时是单日的分钟线，分钟时间戳跨市场不可比（spec §六 那两条钟点表项证据）；
 * `ready` 为假说的是「store 里还没有这条序列」，那时挂上去就是一条永远不存在的线（R10）。
 */
export function compareActive(on: boolean, timeShare: boolean, ready: boolean): boolean {
  return on && !timeShare && ready;
}

/** 缺键或 storage 抛 ⇒ 空串；存进去的串原样读回（不校验标的格式，那是取数侧的事）。 */
export function loadCompare(): string {
  try {
    return localStorage.getItem(COMPARE_PREFS_KEY) ?? "";
  } catch {
    return "";
  }
}

/** 未偏离默认不落盘：空标的**删键**，不写空串（第⑤片 `saveVpvr` 的写侧纪律）。 */
export function saveCompare(symbol: string): void {
  try {
    if (symbol === "") localStorage.removeItem(COMPARE_PREFS_KEY);
    else localStorage.setItem(COMPARE_PREFS_KEY, symbol);
  } catch {
    /* best effort */
  }
}

/**
 * store 的键。含**对比标的**与**周期**，不含主标的——主标的换了不影响这条序列，
 * 而周期换了必须重算（对齐是按主图时间戳做的）。键由页面派生，不从 store 里反查（spec §四）。
 */
export function compareKey(symbol: string, interval: string): string {
  return `${symbol}|${interval}`;
}

/**
 * 会话级 store：`calc` 有一半输入住在这里，所以「数据到了」必须由页面推一次重挂（R10）。
 * `bars.slice()` 是为了页面后续的 `setCmpSeries` 与这里交出的不是同一可变数组。
 */
const seriesByKey = new Map<string, CompareBar[]>();
let activeKey = "";

export function setCompareSeries(key: string, bars: readonly CompareBar[]): void {
  seriesByKey.set(key, bars.slice());
}

/** 未知键交出 `[]`：`calc` 那一路要直接喂给纯函数，不接受 undefined。交出去的是内部那个数组的**只读视图**——写入侧已经 `slice()` 复制过，读取侧不再复制，但也不许调用方改它。 */
export function getCompareSeries(key: string): readonly CompareBar[] {
  return seriesByKey.get(key) ?? [];
}

/** 整桶清空。生产侧不调——调它的只有那两份测试：本库 `symbolCompareChart.test.ts`（`beforeEach` 与专门钉它的那一支）和页面 `ProChartCompare.test.tsx` 的 `beforeEach`。模块 store 跨 `render` 存活，不清的话上一支交付进桶的序列会被下一支在页面自己还没取到数时读到。这一格是会话缓存的重置面。 */
export function clearCompareSeries(): void {
  seriesByKey.clear();
}

/** 挂载前由 `syncCompare` 写一次；`calc` **只读这里**，不走 `calcParams`（spec §四）。 */
export function setActiveCompareKey(key: string): void {
  activeKey = key;
}

/** 对齐结果 → 库的逐根行形状。唯一实现：`calc` 与测试都调它，各写一遍就是重复逻辑。 */
export function compareRows(
  mainTimestamps: readonly number[],
  series: readonly CompareBar[],
): CompareRow[] {
  return alignCloseToTimestamps(mainTimestamps, series).map((close) => ({
    [COMPARE_FIGURE_KEY]: close,
  }));
}

/**
 * 注册守卫：`registerIndicator` 改的是全局表。模块布尔正是
 * `ensureHeikinAshiIndicator`／`ensureVpvrIndicator` 用的同一写法。
 *
 * `precision: 2` 是**继承本页已有的那一条精度约定**（`ProChart.tsx` 写死
 * `pricePrecision: 2`，而 `_synchronizeIndicatorSeriesPrecision` 会把 `series === "price"`
 * 的指标精度覆写成它，`index.esm.js:14215-14241`），不是自造"按数据估小数位"的第二套规则
 * （spec §十二 R6）。低价标的被显示成 `0.00` 是本页出厂就有的代价（§十一·2）。
 * 覆写整体包在 `if (isValid(this._symbol))` 里（`:14216`）⇒ 没设标的时声明的 `precision: 2` 原样生效，
 * 这一格不是"等着被覆写的占位值"。
 */
let registered = false;

export function ensureCompareIndicator(): void {
  if (registered) return;
  registered = true;
  registerIndicator({
    name: SYMBOL_COMPARE_NAME,
    shortName: SYMBOL_COMPARE_SHORT_NAME,
    precision: 2,
    series: "price",
    shouldOhlc: false,
    figures: [{ key: COMPARE_FIGURE_KEY, title: COMPARE_FIGURE_TITLE, type: "line" }],
    // 对齐**必须**算在 calc 里：`StoreImp._addData` 尾部每次分页都带全量 `_dataList`
    // 重跑所有指标（`index.esm.js:13501-13506`、`_calcIndicator` 传全量 `:14145`），
    // 而 `extendData` 不参与重算判定（`shouldUpdate` 里 `calc` 只由 `calcParams`/`figures`/`calc`
    // 三件事决定，`index.esm.js:3167-3168`）。把对齐结果当外部闭包常量喂进来，滚到边界加载后必然错位。
    calc: (dataList: KLineData[]) =>
      compareRows(
        dataList.map((bar) => bar.timestamp),
        getCompareSeries(activeKey),
      ),
  });
}
