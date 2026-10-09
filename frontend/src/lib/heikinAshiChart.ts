import { registerIndicator, type Chart, type KLineData, type XAxis, type YAxis } from "klinecharts";

import { CANDLE_COLORS } from "./chartPalette";
import { heikinAshi, type HaRow } from "./heikinAshi";

/**
 * Heikin-Ashi 的库绑定层（推荐清单第④片，spec §三.A/§四）。
 *
 * 走的是三条**已核实**的库通道，都读自未打补丁的 `klinecharts@10.0.3`：
 *
 * 1. `IndicatorView.prototype.drawImp`（`dist/index.esm.js:8028`）问完 `indicator.draw` 之后
 *    `if (!isCover) { …默认图元… }` ⇒ **返回 `true` 就是整体接管这一根 pane 上该指标的绘制**。
 *    返回 false 会把库的折线一起画出来（重复绘制），所以返回值本身是判据。
 * 2. `YAxisImp.prototype.createRangeImp`（`:984`，折叠在 `:1045-1056`）把该 y 轴上每个指标的
 *    每个 `figures[].key` 的数值当**价格**并进 min/max ⇒ HA 高低挂在 figure key 上就免裁切
 *    （缺口向量：某根真实 high=2 而 haHigh=15）。反过来，像素量绝不能进 result。
 * 3. `candle.bar` 的九个颜色键（`CandleBarColor` = 3 填充 + 3 边框 + 3 影线）是藏原生蜡烛的唯一
 *    杠杆；`candle.type` 那个键归分时开关所有，抢它会破坏 `chartStyles` 的顺序契约
 *    （`ProChart.tsx:294-298`），`priceMark` 整棵子树归图例偏好所有（`chartLegend.ts:109-115`），
 *    HA 侧不写它。
 *
 * 图例只出一行「平均K线 开/高/低/收」：`figures` 声明两键（高低）就够包络轴，而
 * `createTooltipDataSource` 返回的 `legends` 会**整段替换**由 figures 生成的默认行
 * （`IndicatorTooltipView.getIndicatorTooltipData`，`dist:7241-7334`），所以行数由这一支决定，
 * 不由 figures 决定。变换值进不了蜡烛图例（库的 `candle.tooltip.legend.template` 回调只收到
 * 真实 `KLineData`），spec §五 的裁定是让它就待在指标自己那一行，行名写明是平均K线。
 */

export const HEIKIN_ASHI_NAME = "HEIKIN_ASHI";
export const HEIKIN_ASHI_SHORT_NAME = "平均K线";

/** 布尔偏好的最省键形，照磁吸 `pro-chart.magnet.v1`（`chartDrawings.ts:1028`）。 */
export const HEIKIN_ASHI_PREFS_KEY = "pro-chart.heikin-ashi.v1";

/**
 * 藏原生蜡烛＝把 `CandleBarColor` 的九个颜色键全推 `transparent`。
 *
 * 恰好九个，一个不多一个不少：`compareRule` 不是颜色键（它决定用哪个比较价选色，留着不改），
 * `type`/`area`/`priceMark`/`tooltip` 都不在这棵子树里。测试逐键钉这个集合，因为**少推一个
 * 就漏出一根真蜡烛**——而漏出来的是半根，肉眼会在切换时看到「有东西在动」。
 */
export const CANDLE_HIDDEN = Object.freeze({
  upColor: "transparent",
  downColor: "transparent",
  noChangeColor: "transparent",
  upBorderColor: "transparent",
  downBorderColor: "transparent",
  noChangeBorderColor: "transparent",
  upWickColor: "transparent",
  downWickColor: "transparent",
  noChangeWickColor: "transparent",
} as const);

/**
 * HA 是否真的在图上。单一谓词，样式侧和挂卸侧都问它——本仓刚把周期合法性的三个谓词搬进
 * `lib/chartView.ts` 做成同样的「单一判据两处同读」（commit 3d06fafd），这里照同一个形状。
 * 分时是面积线（`candle.type === "area"`），上面没有蜡烛可换，所以分时一律压掉。
 */
export function heikinAshiActive(haOn: boolean, timeShare: boolean): boolean {
  return haOn && !timeShare;
}

/** 默认关；除 `"1"` 之外的一切（含手改的垃圾值、storage 抛错）都读成关。 */
export function loadHeikinAshi(): boolean {
  try {
    return localStorage.getItem(HEIKIN_ASHI_PREFS_KEY) === "1";
  } catch {
    return false;
  }
}

/**
 * 未偏离默认不落盘（`chartLegend.ts:153-166` 的写侧纪律）：关的时候删键，而不是写 `"0"`。
 * 写 `"0"` 会把「今天默认是关」冻进每个用户的 storage，将来若改默认值就再也传不下去。
 */
export function saveHeikinAshi(on: boolean): void {
  try {
    if (on) localStorage.setItem(HEIKIN_ASHI_PREFS_KEY, "1");
    else localStorage.removeItem(HEIKIN_ASHI_PREFS_KEY);
  } catch {
    /* best effort */
  }
}

/** `calc` 的行只允许这四个键；导给测试当白名单，别在两个文件里各写一遍字面量。 */
export { HA_PRICE_KEYS as HA_PRICE_KEYS_FOR_TEST } from "./heikinAshi";

type CompleteHaRow = Required<HaRow>;

/**
 * 「这一根拿得出四价吗」——只管四键齐全 vs `{}`（na 行）。
 *
 * 与 `fmt` 的分工要说清：`fmt` 走的是**更严**的 `Number.isFinite` 口径，因为它对着的是要写给
 * 用户看的一格文本，NaN／Infinity 都得读成 `"-"`；`isHaRow` 对着的是绘制，它要区分的只有
 * 「calc 这一根交出了四个数」还是「交出了 `{}`（na 行，链条断掉那一根）」。`heikinAshi()`
 * 的算术吃的是真实四价，交不出 NaN 行，所以这里不需要再造一道 `Number.isFinite` 的滤网——
 * 为不可达的场景加校验是本仓禁止的，行为因此不改。
 */
export function isHaRow(row: HaRow | undefined): row is CompleteHaRow {
  return (
    row !== undefined &&
    typeof row.open === "number" &&
    typeof row.high === "number" &&
    typeof row.low === "number" &&
    typeof row.close === "number"
  );
}

/** `draw`／`createTooltipDataSource` 的形参面，写成结构化类型以便单测直接喂假对象。 */
interface DrawCtx {
  // 取库自己的口径，不是 `string`：本地收窄成 `string` 之后，`registerIndicator` 交进来的那份
  // `ctx`（`fillStyle: string | CanvasGradient | CanvasPattern`）就装不进来，于是两处调用点
  // 只能靠 `as unknown as` 全量重断言（R11）。放宽这一格，cast 就没有存在的理由了。
  fillStyle: CanvasRenderingContext2D["fillStyle"];
  fillRect(x: number, y: number, w: number, h: number): void;
}

interface DrawParams {
  ctx: DrawCtx;
  // 只列 `haDraw` 真读的两格：它不碰 `getDataList`，HA 是像素层的改写者（spec §三.A）。
  chart: Pick<Chart, "getVisibleRange" | "getBarSpace">;
  indicator: { result: HaRow[] };
  xAxis: Pick<XAxis, "convertToPixel">;
  yAxis: Pick<YAxis, "convertToPixel">;
}

interface TooltipParams {
  // 没有 `chart` 这一格：Task 5 的缺省光标修复之后 `haTooltipDataSource` 只读
  // `{ indicator, crosshair }`，下标由 `indicator.result` 自己的长度给（见那里那段注释）。
  indicator: { result: HaRow[] };
  crosshair: { dataIndex?: number };
}

/**
 * 涨色判据用 **HA 自己**的开收，不用真实收叠——这是 Heikin-Ashi 的定义（spec §二·7），
 * 也正是「趋势段读成连续色块」的来源。本仓把边框色与影线色都映射到同一支
 * `CANDLE_COLORS.up/down/noChange`（`ProChart.tsx:302-310`、`ChartCell.tsx:70-75` 三对同值），
 * 所以库的 `stroke_fill` 实体在我们这里退化成一次 `fillRect`；palette 若哪天把边框色拆开，
 * 这一行要补 `strokeRect`。
 */
function colorsOf(row: CompleteHaRow): { body: string; wick: string } {
  if (row.close > row.open) return { body: CANDLE_COLORS.up, wick: CANDLE_COLORS.up };
  if (row.close < row.open) return { body: CANDLE_COLORS.down, wick: CANDLE_COLORS.down };
  return { body: CANDLE_COLORS.noChange, wick: CANDLE_COLORS.noChange };
}

/**
 * 一根 HA 实体＝影线（1px 宽，从最高像素到最低像素）＋实体（从 max(y(open),y(close)) 起）。
 *
 * 几何逐键镜像库自己的 `CandleBarView`：`priceY = [y(open), y(close), y(high), y(low)]` 升序排
 * （`dist:6562-6565`）、`correction = barSpace.gapBar % 2 === 0 ? 1 : 0`（`:6566`，注意是**偶数**加 1）、
 * 影线 `{x, y: priceY[0], width: 1, height: priceY[3] - priceY[0]}`、实体
 * `{x: x - halfGapBar, y: priceY[1], width: gapBar + correction, height: Math.max(1, priceY[2] - priceY[1])}`
 * （`_createSolidBar`，`:6652-6677`）。x 用 `xAxis.convertToPixel(dataIndex)`，它正是库算
 * `visibleRangeDataList[i].x` 用的同一个 `StoreImp.dataIndexToCoordinate`（`:10995` ⇄ `:13576`）
 * ⇒ 与网格、十字光标逐像素对齐。
 */
export function haDraw({ ctx, chart, indicator, xAxis, yAxis }: DrawParams): boolean {
  const { realFrom, realTo } = chart.getVisibleRange();
  const barSpace = chart.getBarSpace();
  const result = indicator.result;
  const correction = barSpace.gapBar % 2 === 0 ? 1 : 0;
  const from = Math.max(0, realFrom);
  // `realTo` 是排他的（库自己的循环 `for (i = realFrom; i < realTo; i++)`，`:13574`），
  // 再与 result 长度取小：右侧留白区里有像素但没有数据。
  const to = Math.min(realTo, result.length);
  for (let i = from; i < to; i++) {
    const row = result[i];
    if (!isHaRow(row)) continue;
    const x = xAxis.convertToPixel(i);
    const priceY = [
      yAxis.convertToPixel(row.open),
      yAxis.convertToPixel(row.close),
      yAxis.convertToPixel(row.high),
      yAxis.convertToPixel(row.low),
    ].sort((a, b) => a - b);
    const colors = colorsOf(row);
    ctx.fillStyle = colors.wick;
    ctx.fillRect(x, priceY[0], 1, priceY[3] - priceY[0]);
    ctx.fillStyle = colors.body;
    ctx.fillRect(x - barSpace.halfGapBar, priceY[1], barSpace.gapBar + correction, Math.max(1, priceY[2] - priceY[1]));
  }
  return true;
}

function fmt(value: number | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "-";
}

/**
 * 一行四价。`crosshair.dataIndex` 缺省时读**result 自己**的最后一根（图例在光标离开图上时也要有数），
 * 越界／na 读 `"-"` 而不是编一个数。缺省那一路不取 `chart.getDataList().length - 1`：
 * `dataList` 与 `indicator.result` 是两条更新时刻不同的数组（库把 calc 排成任务，
 * `StoreImp.addIndicator` → `_calcIndicator`，dist 14150），按 data 的长度去索引 result
 * 落后那一帧就正好过界，四格全读 `"-"`——一行四价读的是 HA 的值，下标就该由 HA 的值给。
 * 标题用中文字面量是本仓既有做法：指标图例行不走 i18n
 * （库只对**蜡烛**图例的 title 再跑一次 `i18n`，`dist:7678`），`均价: ` 同例。
 */
export function haTooltipDataSource({ indicator, crosshair }: TooltipParams) {
  const result = indicator.result;
  const index = typeof crosshair.dataIndex === "number" ? crosshair.dataIndex : result.length - 1;
  const row = result[index];
  return {
    name: HEIKIN_ASHI_SHORT_NAME,
    calcParamsText: "",
    features: [],
    legends: [
      { title: "开: ", value: fmt(row?.open) },
      { title: "高: ", value: fmt(row?.high) },
      { title: "低: ", value: fmt(row?.low) },
      { title: "收: ", value: fmt(row?.close) },
    ],
  };
}

/**
 * 注册守卫：`registerIndicator` 改的是全局表，每次切换都注册会在图表活着的时候反复覆写。
 * 模块布尔正是 `ensureTimeShareIndicator`（`timeShare.ts:314-325`）用的同一写法，也让点击处
 * 和挂载处都不需要知道对方是否已经注册过。
 *
 * `figures[].type` 是实践必需而不是类型必需（`prepareIndicatorFigures` 只保留
 * `isValid(figure.type)` 的图元，`dist:3081-3125`）——本仓在 `timeShare.ts:309-312` 记过同一个坑。
 * 两键都带 `title`：`createTooltipDataSource` 覆写图例行，但万一那条回调不生效，退化的两行
 * 也该被读成「高/低」而不是无名数。
 */
let registered = false;

export function ensureHeikinAshiIndicator(): void {
  if (registered) return;
  registered = true;
  registerIndicator<HaRow>({
    name: HEIKIN_ASHI_NAME,
    shortName: HEIKIN_ASHI_SHORT_NAME,
    precision: 2,
    series: "price",
    figures: [
      { key: "high", title: "高: ", type: "line" as const },
      { key: "low", title: "低: ", type: "line" as const },
    ],
    calc: (dataList: KLineData[]) => heikinAshi(dataList),
    draw: (params) => haDraw(params),
    createTooltipDataSource: (params) => haTooltipDataSource(params),
  });
}
