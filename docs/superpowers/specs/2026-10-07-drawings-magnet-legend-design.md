# 画线扩展 · 磁吸 · 图例 设计（推荐清单第 ③ 片）

**日期：** 2026-10-07
**状态：** 已裁定，待实现
**范围：** 对比 TradingView 后给出的推荐顺序里的第 ③ 项。①（Pine `alertcondition()`/`alert()` 告警桥）已交付于 §7.13，
②（Bar Replay 逐根回放）已交付于 §7.14 并合入 `main`。本片只做**交互层**的看盘补齐，不碰数据面、不碰后端。

## 一、要解决的问题

TradingView 上用户每天在用、而本项目缺一整块的三个面：

1. **工具不够。** 画线工具栏只有 6 件（趋势线/射线/水平线/价格线/斐波那契/画笔）。TV 里被高频使用的
   直线、垂直时间线、水平线段/射线、平行线、价格通道、带文字的标注，一件都没有。
2. **画不准。** 落点的价格是鼠标 y 的连续投影，画一条"前高"要肉眼对齐：差一个像素就偏 0.01，两条线看着
   一样高其实不等。TV 的 Magnet 把落点吸到那一根 K 线的 OHLC 四个价上。
3. **看不见 / 关不掉。** 图例（左上角 时间/开/高/低/收/量 六行）、高点与低点标记、最新价虚线、副图指标
   图例，全部是库默认值：既不能改成"跟随光标"，也不能整体隐藏，更不能加一行涨幅或成交额。

**成功判据（一句话）：** 这三件事都能在 klinecharts 10.0.3 的**公开 API 面**上完成——不改库、不 patch、
不自绘 canvas；并且**默认态逐像素不变**：没有动过任何新偏好的用户，升级后看到的图与今天完全一致。

## 二、决定性事实（盘面核实，带坐标）

坐标约定：`KC` = `frontend/node_modules/klinecharts/dist/index.esm.js`，`KD` = 同目录 `index.d.ts`，
`FE` = `frontend/src`。库版本 `frontend/node_modules/klinecharts/package.json:3` = **10.0.3**；
`frontend/package.json` 里没有 `patch-package`、没有 `postinstall`、仓库根没有 `patches/` 目录
⇒ 下面所有"库内事实"是上游原始行为，不是本仓改过的行为。

### 1. 库里已经有 16 个画线模板，我们只挂了 6 个

`KC:12796` 的 `extensions` 数组逐名列出全部内置模板（`registerOverlay` 与 `getSupportedOverlays`
在 `KC:12800` / `KC:12812`）：`fibonacciLine, horizontalRayLine, horizontalSegment,
horizontalStraightLine, parallelStraightLine, priceChannelLine, priceLine, rayLine, segment,
straightLine, verticalRayLine, verticalSegment, verticalStraightLine, simpleAnnotation, simpleTag,
brush`。本仓的可见面是 `FE/lib/chartDrawings.ts:115-122` 的 `DRAW_TOOLS`（只有 6 条）。
**其余 10 个不需要注册**，`createOverlay({name})` 直接认。各模板的 `totalStep` 实测：

| 名字 | `totalStep` | 落点数 = `clicks` | 定义处 |
|---|---|---|---|
| `straightLine` 直线 | 3 | 2 | `KC:12594` |
| `verticalStraightLine` 垂直线 | 2 | 1 | `KC:12755` |
| `horizontalRayLine` 水平射线 | 3 | 2 | `KC:12053` |
| `horizontalSegment` 水平线段 | 3 | 2 | `KC:12098` |
| `parallelStraightLine` 平行线 | 4 | 3 | `KC:12258` |
| `priceChannelLine` 价格通道 | 4 | 3 | `KC:12288` |
| `simpleAnnotation` 标注 | 2 | 1 | `KC:12466` |

现有表的约定与之一致（`segment` 2 点、`priceLine` 1 点），`drawHint`（`FE/lib/chartDrawings.ts:129-135`）
按 `clicks` 生成提示文案、`clicks < 0` 表示画笔，所以新增行**不改**这个函数。

### 2. 旧记忆里的"图元只有 line/bar/circle/text"只对了一半，本片据此纠正

`getSupportedFigures`（`KC:6255`，导出在 `KC:15936`，声明 `KD:1205`）背后的注册表实测 7 个：
`line`(`KC:5391`)、`arc`(`5479`)、`circle`(`5584`)、`rect`(`5683`)、`path`(`6042`)、`polygon`(`6129`)、
`text`(`6229`)；`OverlayFigure.type` 是自由字符串（`KD:1019-1025`），`registerFigure` 公开可用
（`KC:6258` / `KD:1206`）。**`bar` 不是图元类型**。四元限制只适用于 indicator 的逐-bar figure 通道。
本仓已经在 overlay 通道里用 `rect`/`polygon`（`FE/lib/pineDrawings.ts:138`、`:298`）。
⇒ 结论：自定义图形（矩形、椭圆的 `path`）在本片之后是**可行**的，不再是库能力边界；本片仍不做，见第八节。

### 3. 磁吸是库自带、本仓一行没用

- 类型：`OverlayMode = "normal" | "weak_magnet" | "strong_magnet"`（`KD:988`），实例字段
  `mode` / `modeSensitivity`（`KD:1106`、`KD:1110`）。默认值 `mode='normal'`、`modeSensitivity=8`
  （`KC:8248`、`KC:8249`）。
- 实现：`KC:8814` 的 `coordinateToPointValueFlag()` 分支里，`KC:8817` 是
  `if (o.mode !== 'normal' && paneId === PaneIdConstants.CANDLE && isNumber(point.dataIndex))`
  ⇒ 取该根 K 线数据（`KC:8818` 的 `getDataByDataIndex`），按 `value` 落在 `high` 上方 / `low` 下方 / 实体内外四个分支吸附到 **high / low / max(open,close) /
  min(open,close)**；`weak_magnet` 只在 `modeSensitivity` 像素带内吸（`KC:8822`、`KC:8835`），`strong_magnet` 无条件吸。
- **硬闸门：只在蜡烛 pane 生效**（`paneId === PaneIdConstants.CANDLE`，`KC:8817`）。副图上的线**永远不会**磁吸，
  这不是我们能绕的，也不该绕（副图的 y 是 MACD 量级，吸到 OHLC 才是错的）。
- x 方向不需要磁吸：步进式画线的 `dataIndex` 本来就由 `xAxis.convertFromPixel` 取整到根（`KC:8806-8812`），
  只有 `drawingMode==='continuous'`（画笔）才用 `coordinateToFloatIndex` 保留亚根位置（`KC:8800-8804`）。
- 全仓 `FE/src` 对 `magnet` **零命中** ⇒ 这是纯新增，没有旧行为要兼容。

### 4. `overrideOverlay` 能改哪些键，以及"返回值不是判决"的适用范围

`OverlayImp.override`（`KC:8277-8307`）把 `id/name/currentStep/points/styles` 之外的所有键交给
`merge(this, others)`（`KC:8281`）⇒ **`mode`、`modeSensitivity`、`lock`、`visible`、`zLevel`、
`fixedZLevel`、`needDefaultPointFigure`、`extendData` 都能原地改**，id 不变。
但 `shouldUpdate()`（`KC:8314-8318`）只比较 `zLevel / points / visible / extendData / styles`
⇒ **只改 `mode` 或 `lock` 时不重绘，`overrideOverlay` 返回 `false`，而改动其实已经生效**。
本仓已经把这条写进 `FE/lib/chartDrawings.ts:47-60`（当时是 `lock`）；本片把它**推广到 `mode`**：
磁吸开关绝不能用返回值判成败，要读实例或读自己的偏好。

### 5. 标注（`simpleAnnotation`）的文字来自 `extendData`，但它的图元全都不接受事件

- 模板体 `KC:12466-12516`：`text = isValid(overlay.extendData) ? (isFunction ? overlay.extendData(overlay) : overlay.extendData) : ''`，
  画三段图元（竖线 + 箭头 `polygon` + `text`），**三段都带 `ignoreEvent: true`**。
- `OverlayImp` 构造里 `needDefaultPointFigure = false`（`KC:8245`）⇒ 若不另外处理，标注画完就是**惰性对象**：
  点不中、拖不动、右键删不掉。可行的补偿是在 `createOverlay` 时传 `needDefaultPointFigure: true`
  （该键在 `OverlayCreate` 面上，`KD:1145` 的类型定义即 `Overlay` 去掉 `drawingMode/currentStep/totalStep/*Figures`），
  让库画默认锚点图元来接事件；删除与选中另外走清单面板。
- `shouldUpdate` 看 `extendData`（`KC:8316`）⇒ 改文字会重绘，`overrideOverlay({id, extendData})` 是有效通道。

### 6. Pine 画的线与用户画的线，天然靠"点有没有 timestamp"分开

`serializeDrawings`（`FE/lib/chartDrawings.ts:305-330`）只保留 `hasCoordinates` 的点，而 `hasCoordinates`
要求 `typeof p.timestamp === "number"`（`:293-295`）；Pine 的 overlay 走 `dataIndex`
（`FE/lib/pineDrawings.ts:373` 的 `toCreate(name, points: {dataIndex, value}[], extendData, zLevel, groupId, paneId)`）
⇒ Pine 线**根本进不了**存储快照。这条不是巧合，是本片新增工具时的判据：
**新工具必须进 `DRAW_TOOLS`**，因为导入白名单 `toolOf(name)`（`FE/lib/drawingExchange.ts:99`）
是唯一把外来线挡在外面的地方；反过来，任何"按名字遍历 `getOverlays()` 再批量 override"的新代码
都必须先用 `toolOf` 过滤，否则会摸到 Pine 的线。

### 7. 样式只有一个入口，且 `setStyles` 是深合并、`legend.template` 数组整体替换

- 本仓唯一的样式通道：`chartStyles(dark, timeShare)`（`FE/pages/ProChart.tsx:257-299`），
  用在 `init`（`:955`）与主题 effect（`:1213-1215`，`setStyles(chartStyles(...))`）。那个文件里写着一条
  已发生的回归：**开关放别处，换主题就会把分时线盖回蜡烛**——因为整份对象是被 `setStyles` 重推的。
  ⇒ 图例偏好**必须并进 `chartStyles`**，并成为该 effect 的依赖项，否则"改图例后切主题"会把设置冲掉。
- 库侧 `StoreImp.setStyles`（`KC:13309-13322`）做 `merge(this._styles, styles)`（`KC:13319`）**深合并**，
  并特判 `candle.tooltip.legend.template` 是数组时**整体替换**（`KC:13320-13322`）
  ⇒ 重复推同一份偏好是幂等的，图例行增删不会有"合并追加"的重复行问题。

### 8. 图例相关默认值（决定"默认态不变"这条判据）

| 面 | 默认值 | 坐标 |
|---|---|---|
| `candle.tooltip.showRule` | `'always'` | `KC:11485` |
| `candle.tooltip.showType` | `'standard'` | `KC:11486` |
| `candle.tooltip.legend.template` | 6 行：time/open/high/low/close/volume | `KC:11524-11531` |
| `candle.priceMark.show` / `high.show` / `low.show` | 三者 `true` | `KC:11444-11447`、`KC:11397-11404` |
| `candle.priceMark.last.show` / `last.line.show` / `last.text.show` | 三者 `true` | `KC:11448-11449`、`KC:11455`、`KC:11461` |
| `indicator.tooltip.showRule` | `'always'` | `KC:11623` |
| 类型面 | `TooltipShowRule = "always"\|"follow_cross"\|"none"`（`KD:292`）、`CandlePriceMarkStyle`（`KD:389-394`）、`IndicatorStyle.tooltip`（`KD:446`）、`setStyles`（`KD:946`） | |
| 标题多语言 | 标题走 `i18n(text, locale)`，未命中回退原文（`KC:7006-7009`）；zh_CN 已有 `time/open/high/low/close/volume/turnover/change` 八个键（`KC:6965-6975`） | |

⇒ 新增"涨幅/成交额"两行**免费拿到中文标题**；本仓的 locale 由 `FE/lib/klineLocale.ts:15-27` 的
`chartLocale()` 解析成库真支持的标签（未知标签会让库在每次重绘时抛错，这是旧坑）。
**v10 里没有 `setTooltipOptions`**：`grep -c setTooltipOptions` 对 `index.d.ts` 与 `index.esm.js` 都是 **0**。
⇒ 图例的唯一公开杠杆就是 `setStyles`，任何"能拿到 legend 专用 API"的设想都不成立。

### 9. 持久化与交换面（新增字段要动哪里）

- 画线存储：键 `pro-chart.drawings.v1`（`FE/lib/chartDrawings.ts:750`），桶 `symbol|interval`（`:755-757`），
  上限 200/60（`:752-753`）；记录形状 `StoredDrawing{name,paneId,points,style?,lock?,hidden?}`（`:255-265`），
  写手 `FE/pages/ProChart.tsx:939-941`（`bankDrawings`）、`:1124`、`:1858`。
- 交换：`FE/lib/drawingExchange.ts` — kind `vibe-trading.drawings`（`:48`）、`DRAWING_BUNDLE_VERSION = 1`（`:49`）、
  逐条 `readDrawing`（`:94-118`：工具白名单 `:99`、paneId 白名单 `:109`、逐键重建 `:110-119`）、
  200 上限截断（`:180-184`）、合并去重 `mergeDrawings`（`:253-281`）、分享链接键 `d`（`:52`）。
  **读侧完全不校验 `version`**（`resolveList` `:184-191` 只看 `drawings`），而 `readDrawing` 是逐键重建
  ⇒ 未知键被丢掉、老文件在新版能读、新文件在老版会静默丢字段。
- 回放那条线（`FE/pages/ProChart.tsx:926-931` 的 `hideFree`，注释在 `:911-925` 说明它为什么存在）规定：
  **任何读进副本的路径都必须先去掉
  回放造成的瞬时 `visible:false`**，否则"未来线被隐藏"会被写成用户自己的隐藏偏好。本片新增的任何
  "读 overlay 再落盘"都走同一条 `hideFree`。

### 10. 清单面板与工具栏的可扩展位置

工具栏画线段 `FE/pages/ProChart.tsx:2125-2210`（`DRAW_TOOLS.map` 生成按钮 `:2126-2138`、撤销/清除/清单
`:2139-2172`、导出/导入/链接 `:2176-2209`、颜色/线宽/线型 `:2212-2255`）；清单面板体 `:2313-2405`
（行内按钮：选中 `:2330`、锁定 `:2359`、隐藏 `:2368`、删除 `:2377`、待恢复项整体删除 `:2399`）。
处理器：`armTool:1732-1752`、`pickStyle:1759`、
`undoDraw:1769`、`clearDraw:1777`、`toggleDrawPanel:1794`、`flagDrawing:1801`、`removeDrawing:1812`、
`focusDrawing:1825`。`describeDrawing`（`FE/lib/chartDrawings.ts:676-710`）的 `label` 是
`toolOf(name)?.label ?? name` ⇒ 新工具的行标签免费，但**它的 `detail` 会把 `value` 印成"价位"**，
对只有 x 意义的垂直线是句假话，得改。

## 三、方案裁定

### A. 工具扩展：新增 7 件，全部是库内置模板

按 §二.1 的表格往 `DRAW_TOOLS` 追加：`straightLine` 直线、`verticalStraightLine` 垂直线、
`horizontalSegment` 水平线段、`horizontalRayLine` 水平射线、`parallelStraightLine` 平行线、
`priceChannelLine` 价格通道、`simpleAnnotation` 标注。追加在表尾即可：工具栏按钮与清单标签都由这张表驱动
（`ProChart.tsx:2126` 的 `DRAW_TOOLS.map`、`describeDrawing` 的 `toolOf(name)?.label`），没有一处依赖顺序。

`DrawTool`（`FE/lib/chartDrawings.ts:107-113`）加两个可选字段，一次定形、A 与 D 共用：

```ts
export interface DrawTool {
  label: string;
  name: string;
  clicks: number;
  /** 落点的 `value` 有没有价格含义：垂直线只有时间轴，标它"价位"是句假话。缺省按 "both"。 */
  dim?: "time" | "price" | "both";
  /** 这条线的文字来自 `extendData`，清单要给它一个输入框。 */
  hasText?: boolean;
}
```

`verticalStraightLine` 是 `dim: "time"`，`simpleAnnotation` 是 `hasText: true`，其余不写（保持缺省语义）。
`describeDrawing`（`FE/lib/chartDrawings.ts:676-710`）读 `dim`：`"time"` 的行只印时间，不印"价位"；
`"price"` 预留给以后的纯价格轴工具，本片没有用户。两个建线入口（`armTool` 与 `restoreDrawings`）
共用一个 `toolCreateExtras(name): Partial<OverlayCreate>`，它产出 `{ needDefaultPointFigure: true }`
（当且仅当 `hasText`）——**这条实现只能有一份**，理由是 §二.6 那条同源纪律：入口不一致就会有一边的线
恢复出来点不中。

几何与持久化**零改动**：这 7 件的落点都是 `{timestamp, value}`，`serializeDrawings` / `restoreDrawings`
/ `clampPointsToLastBar` 四入口 / 导入白名单全部按名字无关的方式工作。唯一需要特殊照顾的是标注（见 D）。

### B. 磁吸：一个开关，值为 `strong_magnet`

- 偏好形状：`type MagnetMode = "normal" | "strong_magnet"`，存在 `pro-chart.magnet.v1`，值 `"1"`/`"0"`，
  默认 `"0"`（关）⇒ **默认态与今天逐像素、逐落点一致**。
- 为什么选 `strong_magnet` 而不是 `weak_magnet`：TV 的 Magnet 语义就是"落点即 OHLC"，`weak_magnet` 需要用户
  理解 `modeSensitivity` 像素带才能解释"为什么这次没吸上"。本项目没有给这个带做 UI 的地方，
  所以不做三态，`modeSensitivity` 保持库默认 8 不写死、不暴露。
- 作用面三处，一个实现（照 `overlayStylesOf` 的单一实现惯例）：
  1. `armTool` 建线时带上 `mode`；
  2. `restoreDrawings` 从存储恢复时带上同一个 `mode`（新增一个可选参数，默认 `"normal"`，旧调用点不改语义）；
  3. 切换开关时，把当前图上**属于 `DRAW_TOOLS` 的**已完成线逐条 `overrideOverlay({id, mode})` 改到位。
     第 3 处必须：(a) 先 `toolOf(name)` 过滤（§二.6 ⇒ 不摸 Pine 的线），(b) 跳过 `isInProgress`，
     (c) **不看返回值**判成败（§二.4）。
- 文档与提示必须写明：**副图上的线不受磁吸**（库闸门）。工具栏按钮的 `title` 里直接写这句，不藏到 wiki。
- 磁吸只改 `value`，落点的 `timestamp` 不变 ⇒ 与档案 ⑳ 的四入口 clamp 无冲突；回放态下磁吸取的是
  游标那根的 OHLC，仍是已收盘数据，不引入未来值。

### C. 图例：把库已有但不可达的开关做成偏好

新增 `FE/lib/chartLegend.ts`（纯函数 + 存储读写，可单测）：

```ts
export interface LegendPrefs {
  candleRule: TooltipShowRule;      // 默认 "always"
  indicatorRule: TooltipShowRule;   // 默认 "always"
  showChange: boolean;              // 涨幅行，默认 false
  showTurnover: boolean;            // 成交额行，默认 false
  highLowMark: boolean;             // 高/低价位标记，默认 true（= 库默认）
  lastPriceLine: boolean;           // 最新价虚线，默认 true（= 库默认）
}
export const DEFAULT_LEGEND_PREFS: LegendPrefs;         // 逐项等于 §二.8 表里的库默认
/** 只含 show / showRule / template 四类键的样式片段，形状由本函数唯一决定。 */
export type LegendStyleFragment = {
  candle: { tooltip: { showRule: TooltipShowRule; legend: { template: TooltipLegend[] } };
            priceMark: { high: { show: boolean }; low: { show: boolean };
                         last: { show: boolean; line: { show: boolean }; text: { show: boolean } } } };
  indicator: { tooltip: { showRule: TooltipShowRule } };
};
export function legendStyles(p: LegendPrefs): LegendStyleFragment;
export function legendTemplate(p: LegendPrefs): TooltipLegend[];  // 6 行 + 可选 2 行，顺序固定
export function loadLegendPrefs(): LegendPrefs;         // 逐键校验 + 回默认，读不到不抛
export function saveLegendPrefs(p: LegendPrefs): void;
```

- `legendStyles` 只写 `show` / `showRule` / `template` 这三类键，**绝不写颜色**，避免与
  `chartStyles` 的红涨绿跌主题面打架。
- 合成点唯一：`chartStyles(dark, timeShare, legend = DEFAULT_LEGEND_PREFS)` 内部把 `legendStyles(legend)`
  并进它自己的 `candle` / 追加 `indicator`，返回一份完整对象；`init`（`:955`）与主题 effect（`:1214`）
  都传当前偏好，effect 的依赖数组加 `legend`。**这一条是本片最容易写错的地方**（§二.7 记录的那次
  "换主题把分时盖回蜡烛"就是同一个坑），所以要有针对性测试，见 §六.5。
- UI：工具栏加一个「图例」按钮（`aria-pressed`），点开一个与画线清单同款的小面板，六项控件：
  主图数值图例三态、副图指标图例三态、涨幅勾选、成交额勾选、高低标记开关、最新价线开关。
  文案沿用现有硬编码中文面（`i18n.test.ts` 不覆盖 ProChart 画线文案，本片不扩大该面）。
- 默认值等于库默认 ⇒ 不改偏好的用户看到的东西不变；`showChange`/`showTurnover` 是唯一会**增行**的两项，
  默认关。

### D. 标注的文字：一个字段 + 一个输入框

- `StoredDrawing` 加可选 `text?: string`（仅 `simpleAnnotation` 有意义）。
- `serializeDrawings` 对 `toolOf(name)?.hasText === true` 的工具读 `extendData`（字符串才收，函数不收）；
  `restoreDrawings` 建线时传回 `extendData: d.text`，并因 §二.5 的补偿对这类工具传
  `needDefaultPointFigure: true`（判据同样来自 `DrawTool` 表，两个入口共用一个 `toolCreateExtras(name)`）。
  文字长度上限 40 个字符，超出截断并在清单行上以 `title` 说明。
- 清单行：`hasText` 的行多渲染一个 `<input aria-label="画线文字 {id}">`；`onChange` 走
  `overrideOverlay({id, extendData})`（§二.4 ⇒ `extendData` 在 `shouldUpdate` 里，会重绘），随后照常
  `syncDrawings` 落盘。删除仍走清单的删除按钮（它的自定义图元 `ignoreEvent`，图上右键删不掉，这是库行为）。
- 交换：`readDrawing` 白名单逐键重建处加 `text`（只接受 `typeof === "string"`，截到 40），
  `DRAWING_BUNDLE_VERSION` 1 → 2。**读侧不校验 version**（§二.9）⇒ bump 只是自我描述，老文件照常导入；
  新文件被老版本读时 `text` 被逐键重建丢掉，标注线本身仍可复现（只是无文字），不产生错误。

## 四、状态与数据流

```
localStorage                         React state (ProChart)         klinecharts
pro-chart.magnet.v1   "1"/"0"  ──┐                              ┌─ createOverlay({..., mode})   新线
                                  ├─ magnetOn (useState+Ref) ──┤─ restoreDrawings(..., mode)   恢复
pro-chart.legend.v1   JSON     ──┤                              ├─ overrideOverlay({id, mode})  切换时改已有
                                  └─ legend (useState) ────────┤
                                  chartStyles(dark,timeShare,legend) ─ init styles / setStyles 主题&偏好
pro-chart.drawings.v1 (形状 +text) ─ serializeDrawings(hideFree(...)) / restoreDrawings
```

- 与现有偏好同一套读法：`loadX()` 在 mount 前同步读、失败回默认、不抛（照 `loadDrawings`、
  `saveDrawingStyle` 的写法）。
- 回放、切标的、切周期都不额外写这两个新键；`pro-chart.drawings.v1` 的写路径一条都不新增。

## 五、错误处理与边界

1. **存储读不到/脏值**：`loadMagnet`/`loadLegendPrefs` 逐键校验，任何不认识的 `showRule` 字符串、
   非布尔项一律回默认，不抛、不写回。
2. **`overrideOverlay` 返回 `false` 不代表失败**（只改 `mode`）：新代码不许拿它当判决；改完要同步偏好、
   落盘照旧，靠下一次渲染读实例确认。
3. **不碰 Pine 的线**：任何批量 override 先 `toolOf(name)` 过滤；测试里放一条 Pine 形状（只有 `dataIndex`）
   的假 overlay，断言它没被摸到。
4. **回放态**：磁吸与图例都不写画线存储；回放中新建的标注与别的画线一样只活在当期，退出回放的还原路径不变。
5. **垂直线的 x 也可能落在未来空白**：现有四入口 clamp 已经只管 `timestamp`，本片不改它；新工具不需要额外入口。
6. **工具名不在库里**：`createOverlay` 返回 `null` ⇒ `armTool` 已有路径不建线；但本片 7 个名字全部实测存在于
   `KC:12796`，不做防御分支（防的是不存在的东西）。
7. **上限**：新增工具不改 200/60 上限（`FE/lib/chartDrawings.ts:752-753`）。
8. **导入去重键必须认文字**：`drawingKey`（`FE/lib/drawingExchange.ts:238-240`）现由
   `paneId|name|points` 组成，不含 style 也不含新字段 ⇒ 同一根 K 线上两个"同点不同字"的标注会在导入时
   互相吞掉。裁定：**仅在 `d.text` 非空时追加 `|${d.text}`**，无文字的线键形一字不改（现有测试只断言
   "不同的线键不同"，没有钉死字符串：`drawingExchange.test.ts:303-319`）。

## 六、测试与验收

**先探红**（本仓纪律：任何新增判据必须先被证明能变红）：每条新测试先写、跑出预期的失败输出并留原文，
再实现；"去掉守卫就变绿/变红"的变异针要逐条注入。

1. `FE/lib/__tests__/chartDrawings.test.ts`（基线 56 条，§六.9 有取数命令）
   - 表：7 个新名字都在 `DRAW_TOOLS`，`clicks` 与 §二.1 的 `totalStep` 表格逐行相等（这条**钉住库坐标**，
     升级时若模板改动会立刻报）。
   - `describeDrawing`：垂直线行不出现"价位"、其余行照旧。
   - 标注：`serializeDrawings` 带 `text`；`extendData` 是函数时不崩、不写；`restoreDrawings` 对
     `hasText` 工具传 `needDefaultPointFigure: true` 与 `extendData`；`toolCreateExtras` 单一实现被两个入口共用。
   - 磁吸：`restoreDrawings(..., "strong_magnet")` 建出的 overlay 带该 `mode`；默认参数不写 `mode`。
2. `FE/lib/__tests__/chartLegend.test.ts`（新文件）
   - `DEFAULT_LEGEND_PREFS` 逐项等于库默认（`always`/`always`/false/false/true/true）。
   - `legendTemplate`：默认恰好 6 行、与库默认模板逐键相等；勾涨幅/成交额后为 7/8/9 行且顺序固定。
   - `legendStyles` 只产 `show`/`showRule`/`template` 三类键，**不含任何颜色键**（防与主题面打架）。
   - `loadLegendPrefs`：脏 JSON、未知 `showRule`、`"true"` 字符串、缺键 ⇒ 全部回默认且不抛。
3. `FE/lib/__tests__/drawingExchange.test.ts`（基线 31 条）
   - `text` 往返一致；>40 截断；`text` 非字符串被丢；version 写成 1/2/99/缺省都能导入（读侧不校验）。
   - `drawingKey`：同点同名的两个标注，`text` 不同 ⇒ 键不同（导入不互吞）；无 `text` 的线键形与改动前逐字相同
     （这条先跑一次"记录现键形"再实现，防止把全仓键形改掉）。
4. `FE/pages/__tests__/ProChartDrawings.test.tsx`（基线 59 条；替身 chart 必须**有状态**）
   - 「画线工具全在工具栏上」这条是 `DRAW_TOOLS.map` 驱动的 ⇒ 自动覆盖 13 件；额外断言磁吸/图例两个按钮存在、
     `aria-pressed` 随状态翻转。
   - 磁吸切换：已有线上 `overrideOverlay` 被以 `{id, mode}` 指名道姓调用，条数 == 属于 `DRAW_TOOLS` 的已完成线数，
     Pine 形状那条不在其中；且**不断言返回值**。
   - 标注文字：输入 → override `{id, extendData}` → 落盘 JSON 里 `text` 更新。
   - "每一次 override 都指名道姓"（`:788-802`）这条既有守卫必须继续为真，新代码若漏 id 会立刻红。
5. `FE/pages/__tests__/ProChartLegend.test.tsx`（新文件，主题冲掉偏好的历史回归点）
   - 改 `candleRule` 后 `setStyles` 收到含新 `showRule` 的对象；**再切主题**，第二次 `setStyles` 仍带该项
     （漏依赖就红）。
   - 分时态（`timeShare`）下同时检查 `candle.type` 仍是 `area`，证明图例合成没把蜡烛盖回分时。
6. 连带面（2026-10-07 逐文件实测）：`ProChartReplayDrawings.test.tsx` 8、`ProChartReplay.test.tsx` 25、
   `ProChartPaging.test.tsx` 3、`ProChartTimeShare.test.tsx` 46、`ProChartMinuteBars.test.tsx` 42、
   `MultiChart.test.tsx` 34、`paneLayout.test.ts` 15 不许变红；`MultiChart` 与画线替身若因 `DRAW_TOOLS`
   变长而计数，改测试的**期望来源**（用表长度而不是硬编码数），不放宽判据。
7. 门禁全量：`npx tsc --noEmit`、`npx vitest run`、`npx vite build`、后端 `pytest`（本片不动后端，
   仍要跑一次证明没连带）、`repowiki` 守卫套件与水位门（**不许抬 `WIKI_STALE_MAX`**）、
   `WorldQuant` 商标 grep 门。
8. 活体验收（browser-use MCP，`/pro-chart`）：13 件工具逐件画一条并刷新验证复现；磁吸开/关各画一条
   水平线，读 `getOverlays()` 的 `value` 断言它等于游标根的四个 OHLC 之一（关时一般不等）；
   副图上画线证明磁吸不生效；标注改文字→刷新→文字仍在；图例六项各切一遍并切主题复查。
9. **上面这些条数只是本轮读到的值，不是判据**。要当前值请在 `frontend/` 逐文件跑（ANSI 要先剥掉，
   否则锚点被色码吃掉）：

   ```bash
   npx vitest run <file> 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -o "Tests  *[0-9]* passed"
   ```

## 七、未来函数自查（交付必附）

本片全部改动都在"画什么/显示什么"这一层，取的数只有两类：overlay 落点（`timestamp`/`value`）与
`getDataByDataIndex(point.dataIndex)` 的 OHLC（`KC:8817-8818`）。磁吸读的 `dataIndex` 来自**已点击的那根**，
回放态下 `point.dataIndex` 不可能超过游标（库拿不到未来 bar：`backward:false` 已在 §7.14 钉死）。
交付时按规格 §12 跑五步并把每步实测值写进档案：

1. 进入回放，游标停在 T；
2. 开磁吸画一条水平线 ⇒ 落点值必须是 T 那根的 OHLC 之一，且**等于**全量态下把游标当最新根时的同一个值；
3. 退出回放、把周期切到更粗再切回，复查该线值未变；
4. 在同一天重画一条，与第 2 步那条逐值相等（不重绘）；
5. 记录：`serializeDrawings` 快照在该线创建前后除这一条以外零差异（证明回放路径没写存储）。

## 八、明确不做（已裁定，留档）

- **`verticalRayLine` / `verticalSegment`**：与 `verticalStraightLine` 同一判断轴，两种变体没人分得清，低价值。
- **`simpleTag`**：与 `simpleAnnotation` 只差箭头朝向，同屏出现只会让清单里两行看起来一样。
- **自定义图形工具（矩形/椭圆的 `rect`/`path`）**：第 2 节已经证明通道是开的，但 `registerOverlay` 必须早于
  `init`（`pineDrawings` 的模块加载顺序是先例），且要自带样式与事件面 ⇒ 与画线持久化同一个脆弱面，独立成片。
- **每条指标独立的图例开关**（`overrideIndicator({id, styles})`）：全局三态已覆盖绝大多数诉求，先要用户点头再谈。
- **z 序（置顶/置底）**：`zLevel` + `fixedZLevel` 实测可达（hover 抬升在 `KC:14508-14519`），但它与 Pine 叠层的
  绘制顺序同一条通道，动它要把 Pine 那侧一起验，风险不对称。
- **画笔平滑/亚根吸附**：`drawingMode==='continuous'` 走 `coordinateToFloatIndex`（`KC:8801-8805`），
  改它等于改画笔几何，与磁吸诉求无关。
- **九语言文案**：本片文案继续走 ProChart 现有硬编码中文面，与既有约定一致（`ops-new-page-i18n-locale-proxy`
  那条只在新增页面时才适用）。
