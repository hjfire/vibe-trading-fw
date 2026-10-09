import { registerIndicator, type Chart, type KLineData, type YAxis } from "klinecharts";

import { valueAreaOf, volumeProfile, VPVR_ROWS, type ProfileBar, type VolumeProfile } from "./volumeProfile";

/**
 * VPVR 的库绑定层（推荐清单第⑤片，spec §三/§六）。
 *
 * 走的是 `registerIndicator` 的 `draw` 通道，不是档案原先给第⑤片预留的
 * overlay/`registerFigure` 通道（spec §〇 三条证据，其中 `serializeDrawings`
 * 没有工具名白名单、走 overlay 会往 `pro-chart.drawings.v1` 写一条读侧认不出的假画线，
 * 是决定性那条）。
 *
 * 三件承重的事：
 *
 * 1. **声明是空的**：`figures: []` 且 `calc: () => []`。`YAxisImp.createRangeImp`
 *    （`dist:984`，折叠体 `:1045-1056`）只把 `result[dataIndex][figure.key]` 里的数值
 *    当价格折进 min/max ⇒ 两把钥匙都不交，价格轴就结构上动不了。这不是「不需要轴」的
 *    侥幸：第④片是靠**把** HA 高低挂到 figure key 上免掉裁切，同一条规则的用法两面。
 * 2. **`draw` 照样会被调**：`IndicatorView.drawImp` 的门只有 `indicator.visible`
 *    （`:8042`）与 `indicator.draw !== null`（`:8050`），都不看 result／figures 的长度。
 * 3. **`return true` 的理由要说准**：本片 figures 为空，返回 `false` 也**不会**多画
 *    任何东西（`prepareIndicatorFigures` 交回空数组）。`true` 换到的是省掉
 *    `eachChildren` 的逐根空遍历，以及与 `haDraw` 同一份契约——不是「防止重复绘制」。
 *
 * 图例只有本指标自己那一行（POC/VAH/VAL）：`createTooltipDataSource` 返回的 `legends`
 * 整段替换由 figures 生成的默认行（`IndicatorTooltipView.getIndicatorTooltipData`，
 * `dist:7241` ⇄ `:7321`），而 figures 本来就是空的。
 */

export const VPVR_NAME = "VPVR";
export const VPVR_SHORT_NAME = "量分布";

/** 布尔偏好的最省键形，照磁吸 `pro-chart.magnet.v1` 与第④片 `pro-chart.heikin-ashi.v1`。 */
export const VPVR_PREFS_KEY = "pro-chart.vpvr.v1";

/**
 * 三枚半透明色：底下的蜡烛要读得出来，所以不是实心。不读 `chart.getStyles()`、
 * 不随主题变——与第④片 `colorsOf` 同一个取舍（接主题要动 `chartStyles`，
 * 而那片有两张既有钉挡着，spec §一 末条）。
 */
export const VPVR_COLOR_BASE = "rgba(66, 165, 245, 0.22)";
export const VPVR_COLOR_VALUE_AREA = "rgba(66, 165, 245, 0.38)";
export const VPVR_COLOR_POC = "rgba(255, 167, 38, 0.55)";

/** 最大档占 pane 宽度的比例（右锚向左生长的上限）。 */
export const VPVR_MAX_WIDTH_RATIO = 0.35;

/**
 * VPVR 是否真的在图上。单一谓词，样式侧与挂卸侧同读（本仓 `lib/chartView.ts`
 * commit 3d06fafd 的同一个形状）。分时是面积线（`candle.type === "area"`），
 * 没有 `[low, high]` 区间可摊 ⇒ 一律压掉。
 */
export function vpvrActive(on: boolean, timeShare: boolean): boolean {
  return on && !timeShare;
}

/** 默认关；`"1"` 之外的一切（含手改的垃圾值、storage 抛错）都读成关。 */
export function loadVpvr(): boolean {
  try {
    return localStorage.getItem(VPVR_PREFS_KEY) === "1";
  } catch {
    return false;
  }
}

/** 未偏离默认不落盘：关的时候**删键**，不写 `"0"`（`chartLegend.ts:153-166` 的写侧纪律）。 */
export function saveVpvr(on: boolean): void {
  try {
    if (on) localStorage.setItem(VPVR_PREFS_KEY, "1");
    else localStorage.removeItem(VPVR_PREFS_KEY);
  } catch {
    /* best effort */
  }
}

/**
 * 本片只用到 chart 的这两格；写成结构化类型让单测能交最小替身。
 *
 * `getDataList` 的返回格交的是「真被读的三格」而不是整个 `KLineData[]`：库把
 * `open`/`close` 也定成必填（`dist/index.d.ts:97-105`），而 `ProfileBar` 读的就是
 * `high`/`low`/`volume` 这三格——替身按 `Pick<Chart, "getDataList" | "getVisibleRange">`
 * 写会交不出开收两格（TS2345），按这三格写则真 `Chart` 仍结构上可赋进来（`KLineData`
 * 是它的超集），Task 4 那边传的仍是库的 `Chart`。
 */
type ChartView = {
  getDataList: () => ReadonlyArray<Pick<KLineData, "high" | "low" | "volume">>;
  getVisibleRange: Chart["getVisibleRange"];
};

/**
 * 可视区切片 → 分布，**唯一实现**（`vpvrDraw` 与 `vpvrTooltipDataSource` 都调它；
 * 各写一遍就是本仓禁止的重复逻辑）。
 *
 * `realTo` 是排他的（库自己的循环 `for (i = realFrom; i < realTo; i++)`），再与
 * `dataList.length` 取小：右侧留白区里有像素但没有数据。`bar.volume ?? 0` 是**类型要求**
 * （`KLineData.volume?: number`，`dist/index.d.ts:97-105`），不是防御。
 */
export function profileOfChart(chart: ChartView): VolumeProfile {
  const dataList = chart.getDataList();
  const { realFrom, realTo } = chart.getVisibleRange();
  const from = Math.max(0, realFrom);
  const to = Math.min(realTo, dataList.length);
  const bars: ProfileBar[] = [];
  for (let i = from; i < to; i++) {
    const bar = dataList[i];
    bars.push({ high: bar.high, low: bar.low, volume: bar.volume ?? 0 });
  }
  return volumeProfile(bars, VPVR_ROWS);
}

interface DrawCtx {
  // 取库自己的口径而不是 `string`：本地收窄会把 `registerIndicator` 交进来的那份
  // `fillStyle: string | CanvasGradient | CanvasPattern` 挡在外面，调用点就只靠
  // `as unknown as` 全量重断言（第④片 R11 的教训）。
  fillStyle: CanvasRenderingContext2D["fillStyle"];
  fillRect(x: number, y: number, w: number, h: number): void;
}

interface DrawParams {
  ctx: DrawCtx;
  bounding: { width: number; height: number };
  chart: ChartView;
  // 不需要 `xAxis`：横向位置由 `bounding.width` 给（右锚）。不需要 `getBarSpace`：
  // 档高度来自价格像素，跟 bar 宽无关。
  yAxis: Pick<YAxis, "convertToPixel">;
}

interface TooltipParams {
  chart: ChartView;
}

/**
 * 一根档 = 一个矩形，右锚向左生长。
 *
 * `yTop` 取的是档的**上界价格**（`row.high`）——价格越高像素越小，所以它是矩形顶边；
 * `Math.max(1, yBottom - yTop)` 保证 100 档配窄 pane 时（每档不足 1px）仍看得见。
 * 零档一根都不画（含 `totalVolume === 0` 的整张图）：给它留一个矩形会把「没有分布」
 * 画成「一条平线」。
 */
export function vpvrDraw({ ctx, bounding, chart, yAxis }: DrawParams): boolean {
  const profile = profileOfChart(chart);
  const area = valueAreaOf(profile);
  const rows = profile.rows;

  let maxVolume = 0;
  for (const row of rows) {
    if (row.volume > maxVolume) maxVolume = row.volume;
  }
  if (maxVolume === 0) return true;

  const maxLen = bounding.width * VPVR_MAX_WIDTH_RATIO;
  for (let j = 0; j < rows.length; j++) {
    const row = rows[j];
    if (row.volume <= 0) continue;
    const len = maxLen * (row.volume / maxVolume);
    const yTop = yAxis.convertToPixel(row.high);
    const yBottom = yAxis.convertToPixel(row.low);
    // 优先级：POC 档 > 价值区档 > 基础档。POC 档**总是**价值区的成员（扩展从它出发），
    // 所以这一格顺序不是风格问题——反过来的话 POC 在图上就没有自己的颜色了。
    ctx.fillStyle =
      j === profile.pocIndex
        ? VPVR_COLOR_POC
        : j >= area.lowIndex && j <= area.highIndex
          ? VPVR_COLOR_VALUE_AREA
          : VPVR_COLOR_BASE;
    ctx.fillRect(bounding.width - len, yTop, len, Math.max(1, yBottom - yTop));
  }
  return true;
}

/**
 * 图例那一行：三个**价格**（POC 档中点、VAH 档上界、VAL 档下界），不是量。
 *
 * 量到不了文字这一层——前端的 `volume` 没有单位（spec §一）。`totalVolume === 0` 时
 * 三格都读 `"-"` 而不是算出 `0.00` 骗人：那是「没有分布」，不是「分布在 0」。
 * 标题用中文字面量、不走 i18n：库只对**蜡烛**图例的 title 再跑一次 `i18n`
 * （`dist:7678`），指标这一行走不到，`均价: ` 同例。
 */
export function vpvrTooltipDataSource({ chart }: TooltipParams) {
  const profile = profileOfChart(chart);
  const area = valueAreaOf(profile);
  const empty = profile.totalVolume === 0;
  const pocRow = profile.rows[profile.pocIndex];
  return {
    name: VPVR_SHORT_NAME,
    calcParamsText: "",
    features: [],
    legends: [
      { title: "POC: ", value: empty ? "-" : ((pocRow.low + pocRow.high) / 2).toFixed(2) },
      { title: "VAH: ", value: empty ? "-" : profile.rows[area.highIndex].high.toFixed(2) },
      { title: "VAL: ", value: empty ? "-" : profile.rows[area.lowIndex].low.toFixed(2) },
    ],
  };
}

/**
 * 注册守卫：`registerIndicator` 改的是全局表，每次切换都注册会在图表活着的时候反复覆写。
 * 模块布尔正是 `ensureHeikinAshiIndicator`（`heikinAshiChart.ts:226-244`）与
 * `ensureTimeShareIndicator`（`timeShare.ts:314-325`）用的同一写法。
 *
 * `calc: () => []` 与 `figures: []` 是承重的两把钥匙（见文件头第 1 条），
 * 不是「还没实现」的占位——分布是**绘制态**，由 `draw` 现算，不进 result。
 */
let registered = false;

export function ensureVpvrIndicator(): void {
  if (registered) return;
  registered = true;
  registerIndicator({
    name: VPVR_NAME,
    shortName: VPVR_SHORT_NAME,
    precision: 2,
    series: "price",
    shouldOhlc: false,
    figures: [],
    calc: () => [],
    draw: (params) => vpvrDraw(params),
    createTooltipDataSource: (params) => vpvrTooltipDataSource(params),
  });
}
