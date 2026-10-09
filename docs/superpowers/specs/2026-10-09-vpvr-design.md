# 第⑤片 VPVR（成交量分布图）实现设计

**Goal**：`/pro-chart` 工具栏加一个「量分布」开关——把**可视区**内的成交量按价格分档，在价格 pane 内画一张横向直方图，高亮 POC 那一档与 70% 价值区（VAH/VAL），数值读在图例那一行。**数据面与价格轴都不动**：`dataList`、价格标尺、画线锚点、`pro-chart.drawings.v1`、分享码、`/multi-chart` 全部零影响。

**分支基座**：`main`（含第④片 Heikin-Ashi，`fcd55f69`）。库 `klinecharts@10.0.3`，未打补丁。

---

## 〇、本片推翻了档案给第⑤片预留的通道裁定

`项目档案.md` 在两处写着 VPVR 要走 overlay 自绘图元：`:1821`「需要自绘图元，按上面那条更正走 overlay 七类通道而不是 indicator 通道」、`:1866`「`registerFigure` 是公开口，不挤 indicator 那四类（`line/bar/circle/text`，没有 rect）」。

本轮实测把这条作废，三条证据：

1. **indicator 的 `draw` 本来就能拿到裸 ctx 与整 pane 的几何**——`IndicatorView.prototype.drawImp`（`frontend/node_modules/klinecharts/dist/index.esm.js:8028`）在 `:8052` 把 `{ ctx, chart, indicator, bounding, xAxis, yAxis }` 原样交给 `indicator.draw`，`:8062` 是 `if (!isCover)` ⇒ 返回 `true` 即整体接管该指标在这一帧的绘制。「没有 rect 图元」这个限制属于**图元声明**那条路，不属于 `draw` 里的 `ctx.fillRect`。第④片就是用这条路画实体矩形的。
2. **走 overlay 就进了画线的落盘通道**。`frontend/src/lib/chartDrawings.ts:400-412` 的 `serializeDrawings` 只有四道闸（进行中／有 name／非 excludeId／至少一个带 `timestamp` 的落点），**没有 `toolOf` 工具名白名单**——所以一个「有名字、落点带时间戳」的 VPVR overlay 会被原样写进 `pro-chart.drawings.v1`（写侧三处扫描点：`ProChart.tsx:1044`、`:1794`、`:615`），而读侧 `frontend/src/lib/drawingExchange.ts:121` `if (!toolOf(name)) return { reason: … 不是可复现的画线工具 }` 会把它扔掉。后果是**写侧收、读侧扔**：每次 reload 静默删一条，且画线清单面板多出一行 label 退化成原始 name 的假画线。与之对照，磁吸的两条批量通道都有白名单（`chartDrawings.ts:1069`、`:1118`），说明「没有白名单」是 `serializeDrawings` 这一侧的特点而不是全局约定。
3. **indicator 通道结构上碰不到画线面**。它只出现在 `chart.getIndicators()` 里；`getOverlays()` 永远没有它，于是落盘与分享码不可能误写。第④片 `HEIKIN_ASHI` 就是这条判据的存活先例（`ProChartHeikinAshi.test.tsx` 已钉「切 HA 期间 `overrideOverlay` 零新增、种子线锚点分毫未动」）。

⇒ 档案这两句在本片落档时（§十一）要按实测更正，并把「为什么不走 registerFigure」这条记进 [[chart-drawing-landing-and-figure-channel]]。

---

## 一、范围

**做**：分档纯算术、价值区纯算术、库绑定层（注册＋`draw`＋图例行）、页面接线（偏好 state／挂卸／工具栏按钮／分时互斥）、三份测试、活体验收与 Bar Replay 自查、落档。

**不做（逐条给理由，不是"以后再说"）**：

- **不做参数面板**（行数、宽度、比例都可配置）。出厂三常量写死（§四/§五/§六）。加面板＝新增一组偏好键＋一整套读写归一化，与「先看东西对不对」无关。
- **不显示总量数字**。前端成交量是**无量纲裸数**：单位是在**回测仓库那一层**按 `(source, market)` 判定并作为 provenance 存下来的（`agent/backtest/warehouse/sync.py:761-763` 从 loader 类属性取 `volume_units`、`:852-863` 判 `market -> volume_unit`、`:888-892` 写入），**不进 `/history` 的列**——那条路由只发 `t/o/h/l/c/v`（`agent/src/api/udf_routes.py:451-458`）；`frontend/src/lib/marketApi.ts:174-185` 映射成 `volume: … ?? 0`。而「同源换 endpoint 单位就变」在本仓是有档可依的事（`项目档案.md:625`：akshare 的 `stock_zh_a_hist` 是**手**、`stock_zh_a_daily` 是**股**）。把没有单位的数印到图上会读成「手」或「股」，是造假精度。直方图的**形状**才是本片的产物，POC/VAH/VAL 三个数是价格，有单位。
- **不做时间轴分布**（TPO／市场轮廓）。那是另一条通道（时间轴、x 方向），与本片的 y 方向分布无共享代码。
- **不进 `/multi-chart` 格子**，与第④片同规：`ChartCell.tsx` 是独立的一套接线，接它要另开一轮替身与判据。
- **不进分享码**：`drawingExchange.ts:336-351` 的画线分享体只吃 `StoredDrawing[]`；指标侧本片不参与序列化。
- **不做 Pine 侧 `ta.volume_profile()`**：显示层与数据层分离，与第④片对 `ta.heikinashi()` 的取舍一致。
- **不给价格轴加任何键、不改 `chartStyles`**。两条既有钉挡着：`ProChartHeikinAshi.test.tsx:641-644` 断言被推送样式的 `indicator` 子树**恰只有一个键** `["tooltip"]`；`:636` 用 `getByLabelText` 精确查 `指标图例显示规则（含主图 MA／均价）` 这串字面量，改名就红。

---

## 二、本轮实测的库事实（坐标全部本轮重读，不继承上一片）

| # | 事实 | 坐标 | 对本片意味着 |
|---|---|---|---|
| 1 | `IndicatorView.prototype.drawImp` 取 `bounding = widget.getBounding()`（本 pane 主 widget 的包围盒），逐个指标调 `indicator.draw({ctx, chart, indicator, bounding, xAxis, yAxis})`，`isCover` 为真则**跳过**默认图元通道。**调 `draw` 只有两道门**：`:8042` `indicator.visible`（默认真）与 `:8050` `indicator.draw !== null`——**都不看 `result.length` 或 `figures.length`** | `dist:8028`／`:8031-8034`／`:8042`／`:8050`／`:8052`／`:8062` | 直方图的几何源＝`bounding.width/height` ＋ `yAxis.convertToPixel(price)`，不需要 `xAxis`；且**空声明（`figures: []`＋`result: []`）的指标 `draw` 仍被调**——方案 A 不是空想，这一格是它能不能存在的前提 |
| 2 | `YAxisImp.prototype.createRangeImp` 只把 `result[dataIndex][figure.key]` 里 `isNumber` 的值并进 min/max | `dist:984`，折叠体 `:1045-1056`（`:1045` `indicators.forEach` ⇄ `:1056` 收尾） | **`figures: []` ⇒ 折叠循环空转 ⇒ 价格轴只来自蜡烛高低价**（本片的承重判据） |
| 3 | `shouldCompareHighLow = (shouldUseCandleData && !isArea) \|\| (!inCandle && shouldOhlc)`，`shouldOhlc` 默认 `false`（`dist:3158`） | `dist:1028` | 挂在 `candle_pane` 的指标不会替蜡烛做高低比对；本片不碰这个键 |
| 4 | `createTooltipDataSource` 的实参是 `{chart, indicator, crosshair, bounding, xAxis, yAxis}`；返回的 `legends` **整段替换**由 figures 生成的默认行。**且替换前库会对每格 `value.text` 跑一遍 `decimalFold.format(thousandsSeparator.format(...))`**（`:7329-7331`，只对「像数」的格跑；千分位默认 `sign: ','`，见下一行） | `dist:7241`（getIndicatorTooltipData）／`:7293-7299`（实参）／`:7329-7331`（数值格式化）／`:7334`（`tooltipData.legends` 覆写） | 图例那行 POC/VAH/VAL 由我们自己给，且它**能拿到 `chart`** ⇒ 可就地按可视区重算。**代价**：图例画在 canvas 上，DOM 读不到那串字，而单测里 `createTooltipDataSource` 直接调出来的 `"1234.56"` 也不是屏幕字形（≥1000 时屏幕上带逗号）。⇒ §八/§九 的活体判据分两层：**值**从 `getIndicators({name:'VPVR'})[0].createTooltipDataSource({chart})` 读（`index.d.ts:776` 的 `Indicator` 公开挂着这个回调），**字形**用库自己的 `getThousandsSeparator()`／`getDecimalFold()`（`index.d.ts:955/957`）复现 `:7329-7331` 那一层，两串都登记。 |
| 4b | 千分位符号是 store 的出厂默认，不是样式里能漏出来的东西：`_thousandsSeparator = { sign: ',' }` | `dist:13094-13096`；`formatThousands` 只在 `sign.length === 0` 时短路（`:773-783`） | 本仓 `frontend/src/` 全仓 grep 无任何 `thousandsSeparator` 覆写（Task 3 修复轮当场核过）⇒ 这一层格式化**必然生效**，不能靠「也许我们把它关了」省掉 |
| 5 | 每帧只有一处清屏，且清的是整块 canvas 后 `save/scale/try` | `dist:9145` | 同 pane 上多个指标的 `draw` 是**叠加**关系：HA 与 VPVR 共挂时互不擦除 |
| 6 | `IndicatorImp` 默认 `series: 'normal'`、`figures: []`；`series` 的唯一用途是 `_synchronizeIndicatorSeriesPrecision` 里 `'price' → pricePrecision` | `dist:3155-3163`／`:14215-14230` | `series: "price"` 只影响精度同步，不引入轴折叠；写它是为了让 `precision` 跟随 symbol 的 2 位小数 |
| 7 | `StoreImp.prototype.addIndicator` 的 de-dup 用带 id 的过滤匹配不上 ⇒ `createIndicator(value, true)` 永远追加 | 第④片已实测并在 `ProChart.tsx:974-999` 的注释里写明 | VPVR 的挂卸照 `syncHeikinAshi` 的「先删后挂＋`live.length === 0` 才创」形状抄 |
| 8 | 图元注册表七类、`registerFigure` 是公开口且**仓内零调用者** | `getSupportedFigures()` 实测七类；仓内 grep 无 caller | 走这条路要自己管 overlay 生命周期，且撞 §〇 第 2 条的落盘污染 |

仓内三条配套事实：成交量键名恒为 `volume`、键恒在但值可为 `0`（`marketApi.ts:183` ＋ `market_routes.py:175-176` 整列补 `0.0`，先例判据见 `timeShare.ts:171-186` 的「零量前缀退化成收盘价算术均值」）；分时是 `candle.type === 'area'`（`ProChart.tsx:295`），HA 用 `heikinAshiActive(haOn, timeShare) = haOn && !timeShare` 压掉（`heikinAshiChart.ts:59-61`）；`syncPriceOverlay` 只删 `MA`/`AVG_PRICE`/`PREV_CLOSE`（`ProChart.tsx:954-972`）、`syncSubPanes` 的清扫显式跳过 `paneId === MAIN_PANE_ID`（`:775`）⇒ 挂在主图价格 pane 的 VPVR 既不会被顺手带走，也不会被副图选择器吃掉。

---

## 三、通道裁定

**方案 A（选定）**：`registerIndicator({ figures: [], calc: () => [], draw })`，直方图在 `draw` 里按**当前可视区**现算现画。
优点：价格轴结构上动不了（§二·2 的两把钥匙）；不碰画线面；每帧重算＝滚动/缩放时分布自动跟着可视区走，这正是 VPVR 的产品语义（TV 的 "Visible Range"）；纯算术与库解耦，可单测。
代价：`draw` 每帧跑一遍分档（100 档 × 可视 N 根，N 最大约几千，量级 10^5 的加减；帧时本片未实测，登记为已知代价 §十二·1）；`indicator.result` 是空的，所以**库自带的按 figures 生成的图例什么都没有**，数字必须由 `createTooltipDataSource` 给。

**方案 B（否决）**：overlay ＋ `registerFigure` 自绘 rect 图元。否决理由＝§〇 第 2 条的落盘污染，另加三条：VPVR 不是用户画的线（没有可拖的锚点、不该被选中/删除/导出）；overlay 的重锚与磁吸语义会误伤它；第④片刚钉死「切 HA 期间 `overrideOverlay` 零新增」，再往 overlay 面塞一个计算态会削弱那条判据的所指。

**方案 C（否决）**：新建一个副 pane 画竖直方向的分布（价格轴换到副 pane）。否决理由：VPVR 的价值就在「分布与当前价位的重叠关系」，换 pane 就失去了这个对照；而且副 pane 的 `paneId` 在本仓是随机漂移的（见 [[chart-subpane-paneid-and-height-layout]]：主图曾被挤到 29px），新增 pane 要把高度布局与 `isRestorablePaneId` 白名单一起动，范围远超一片。

---

## 四、纯算术层 `frontend/src/lib/volumeProfile.ts`

**零 klinecharts import**（与 `heikinAshi.ts` 同规；导入库的代价在测试里表现为必须 mock 整个模块）。

```ts
export interface ProfileBar {          // 只声明真用到的三格（不含 open/close，摊派用不上）
  high: number;
  low: number;
  volume: number;
}
export interface ProfileRow {
  low: number;      // 本档价格下界（含）
  high: number;     // 本档价格上界（不含；最后一档含）
  volume: number;
}
export interface VolumeProfile {
  rows: ProfileRow[];       // 长度恒为 rows 参数；下标 0 ＝ 最低价档
  pocIndex: number;         // 量最大那一档的下标；全零时为 0
  totalVolume: number;
  spanLow: number;          // 分档域＝可视片自身的最小 low
  spanHigh: number;         // 与最大 high
}
export const VPVR_ROWS = 100;
// `rows` 缺省＝`VPVR_ROWS`；传值只影响档数，不改变其余任何口径。
export function volumeProfile(bars: readonly ProfileBar[], rows?: number): VolumeProfile;
```

**分档域**：`spanLow = min(low)`、`spanHigh = max(high)`，取自**传入的那一段**（调用方负责切可视区，本函数不看索引、不看时间）。`rowHeight = (spanHigh - spanLow) / rows`。

**量摊派**（这是本片唯一有产品含义的算法选择，两条候选里选后者）：

- 候选一「典型价单档」：整根的 `volume` 进 `((o+h+l+c)/3)` 那一档。简单，但一根宽幅 K 线只留一格墨，100 档配 500 根会稀疏得读不出形状。
- **选定「区间按价格重叠比例摊派」**：一根覆盖 `[low, high]`，它与第 j 档的重叠长度 `overlap_j = max(0, min(high, row.high) - max(low, row.low))`，进档量 `= volume × overlap_j / (high - low)`。
  - `high === low`（一字线/单点）：**整量进包含该价的那一档**，不做除法（分母为 0）。库自己也在内置 **EMV** 指标里对同一形状单独立了分支（`dist:3978` `name: 'EMV'`，其 `calc` 内 `dist:3998` `if (volume === 0 || high - low === 0)` ⇄ `:4002` 否则才做 `volume / … / (high - low)` 的除法）。
  - `volume === 0`：不进任何档（省掉整圈除法），且**不算异常**——`timeShare.ts:171-186` 已把零量当真实分支处理。
  - 档位归属的边界口径：`j = floor((price - spanLow) / rowHeight)`，末档右闭；`price === spanHigh` 必须落进最后一档（浮点上界），实现要 `Math.min(rows - 1, j)` 钳一次，并**用一根 `high === spanHigh` 的根把它钉住**（§九）。

**退化情形（全部定义，不留 `NaN`）**：

| 输入 | 输出 |
|---|---|
| `bars` 为空 | `rows` 全零档（`low/high` 都取 `0`）、`pocIndex: 0`、`totalVolume: 0`、`spanLow/spanHigh: 0` |
| `spanHigh === spanLow`（所有根同一价，含只有一根一字线） | 第 0 档吃**全部量**，其余档零；`rowHeight` 记 0；不出现除零 |
| 全部 `volume === 0` | 各档按形状摊派后仍为 0（`totalVolume: 0`）；POC 见下条 |

**POC 的 tie-break（必须写死并可测）**：下标从 0 升序扫，`if (rows[j].volume > best) { best = rows[j].volume; pocIndex = j }` ⇒ **并列时取较低价那一档**（先到的赢）。`totalVolume === 0` 时 `pocIndex` 仍是 0，但**绘制层不画任何东西**（§六），图例读 `"-"`。

**确定性**：同输入必同输出（无 `Date.now`、无随机、无外部状态）。这条本身不是判据，它是 §八 反未来函数针能成立的前提。

---

## 五、价值区 `volumeProfile.ts` 内的第二个导出

经典口径（Volume Profile Value Area）：从 POC 出发，**每步比较相邻的上一档与下一档的量，吃掉较大的那一侧**，直到累计量 ≥ `ratio × totalVolume`。

```ts
export const VPVR_VALUE_AREA_RATIO = 0.7;
export interface ValueArea { lowIndex: number; highIndex: number; coverage: number }
// `ratio` 缺省＝`VPVR_VALUE_AREA_RATIO`；调用方（绑定层）不传，留参数只为了那根
// 「比例可调」的测试能喂 0.0 / 1.0 两个边界而不必改常量。
export function valueAreaOf(profile: VolumeProfile, ratio?: number): ValueArea;
```

- 返回下标闭区间：`[lowIndex, highIndex]` **含 POC 档自己**。
- `coverage = 区间累计 / totalVolume`；`totalVolume === 0` ⇒ `{ lowIndex: 0, highIndex: 0, coverage: 0 }`。
- **tie-break**：`up.volume >= down.volume` 时先吃**上侧**（高价方向）。与 §四 的 POC 口径故意相反（POC 并列取低，VA 扩展并列取高），两条都必须在测试里各有一根针，否则实现者随手一写就把它们统一成同一个方向。
- 单侧越界（`lowIndex` 已到 0 或 `highIndex` 已到末档）⇒ 只剩另一侧可吃；两侧都到头而 coverage 仍未达标 ⇒ 就地收摊（返回全区间）。这是**可达**情形（极端集中的分布＋高档数），不是防御性代码。
- 派生的价格边界：`VAL = rows[lowIndex].low`、`VAH = rows[highIndex].high`、`POC 价 = (rows[pocIndex].low + rows[pocIndex].high) / 2`。这三个数是图例那一行的内容。

---

## 六、绑定层 `frontend/src/lib/vpvrChart.ts`

```ts
export const VPVR_NAME = "VPVR";
export const VPVR_SHORT_NAME = "量分布";
export const VPVR_PREFS_KEY = "pro-chart.vpvr.v1";
export function vpvrActive(on: boolean, timeShare: boolean): boolean;  // on && !timeShare
export function loadVpvr(): boolean;   // 只把 "1" 读成开；异常/垃圾值读成关
export function saveVpvr(on: boolean): void;  // 关时 removeItem，不写 "0"
export function vpvrDraw(params): boolean;
export function vpvrTooltipDataSource(params): { name; calcParamsText; features; legends };
export function ensureVpvrIndicator(): void;
// 可视区切片 → `VolumeProfile` 的**唯一**实现，`vpvrDraw` 与 `vpvrTooltipDataSource` 都调它
// （各写一遍就是本仓禁止的重复逻辑）。**不带 `rows` 旋钮**：生产侧只有出厂 100 档这一个
// 事实，而几何测试要手算期望矩形也不需要小网格——把样本域摆成「宽度＝档数」
// （`[100, 200]` × 100 档 ⇒ 档宽恰为 1 个价格单位），期望值就能逐格写死。
export function profileOfChart(chart): VolumeProfile;
```

**形状声明**（承重，逐条钉）：`figures: []`、`calc: () => []`、`series: "price"`、`precision: 2`、`shouldOhlc: false`；`zLevel` **不写**（库 `IndicatorImp` 构造器已给 0，`dist:3161`，写它等于声明一个默认值）。

**两个回调各读哪几格实参**（绑定层的形参面，写成结构化类型以便单测直接喂假对象，照 `heikinAshiChart.ts:110-132` 的 R11 口径**不要本地收窄**）：
`vpvrDraw` 读 `{ ctx, bounding, chart, yAxis }`，其中 `chart` 只取 `Pick<Chart, "getDataList" | "getVisibleRange">`——**不需要 `xAxis`**（横向位置由 `bounding.width` 给）、也不需要 `getBarSpace`（档高度来自价格像素，不来自 bar 宽）。
`vpvrTooltipDataSource` 读 `{ chart }`（`Pick<Chart, "getDataList" | "getVisibleRange">`），不读 `crosshair`：分布不随光标变，所以上一片那条「`dataIndex` 缺省回退」在这里没有对应物。
§二·2 说价格轴只折 `figures[].key`；本片**两把钥匙都不交**——`figures` 空 ⇒ 折叠循环没有 key 可读，`result` 空 ⇒ 即便将来有人加了 key 也读不到数。测试要**同时**钉这两格（§九），并把库那条折叠规则在测试里写成六行镜像 helper，断言「本指标声明能并进轴的价格集合是空集」——诚实标注：这一格判的是**两把钥匙都在**，库行为的实地判据在 §八 活体那一步（`getYAxes()[0].getRange()` 开前事后逐字相同）。

**几何**（`vpvrDraw`）：

```
slice = chart.getDataList().slice(from, to)      // from = max(0, realFrom)，to = min(realTo, length)
profile = volumeProfile(slice, VPVR_ROWS); area = valueAreaOf(profile)
maxLen = bounding.width * 0.35                   // POC/最大档占 35%，其余按比例
for j, row of profile.rows:
  if row.volume <= 0 continue                    // 零档一根都不画（含 totalVolume === 0 的整张图）
  len = maxLen * (row.volume / maxRowVolume)     // maxRowVolume = rows 里的最大值
  yTop = yAxis.convertToPixel(row.high); yBottom = yAxis.convertToPixel(row.low)
  h = Math.max(1, yBottom - yTop)                // 亚像素档也要看得见（末档/远缩）
  ctx.fillStyle = j === pocIndex ? POC : (lowIndex<=j<=highIndex ? VA : BASE)
  ctx.fillRect(bounding.width - len, yTop, len, h)
return true
```

- **右锚向左生长**，`x ∈ [bounding.width - len, bounding.width]`。
- 颜色三枚，半透明 so 蜡烛仍在底下读得出来：`BASE = "rgba(66, 165, 245, 0.22)"`、`VA = "rgba(66, 165, 245, 0.38)"`、`POC = "rgba(255, 167, 38, 0.55)"`。**不读 `chart.getStyles()`**、不随主题变——与第④片 `colorsOf` 同一个取舍（读常量而不是现样式，`heikinAshiChart.ts` 的既记 Minor），理由是三枚都带 alpha，暗/亮底上都可读，而接主题要把它们塞进 `chartStyles`，撞上 §一 那两条既有钉。
- **`return true` 要，但理由要说准**（本轮读 `drawImp` 才知道的）：`isCover` 为真时跳过的是 `:8063` 起那段 `eachChildren` 逐根遍历；而本片 `figures: []`，`prepareIndicatorFigures` 交回空数组，**即使返回 `false` 也不会多画任何东西**——所以返回 `true` 换到的是「省掉每根一次的空遍历」＋「与第④片同一契约（`haDraw` 的返回值本身就是它的接管声明）」，**不是**「防止重复绘制」。测试仍钉 `=== true`，注释不许把它写成防重复（那是上一片的情形，不是本片的）。
- 不做任何缓存/记忆化：每帧重算，键多一个就多一份状态，而 §九 有一根针要验「滚动到同一可视区必然得到同一张图」，靠的就是「无状态」。

**图例那一行**（`vpvrTooltipDataSource`）：三行 `POC: `／`VAH: `／`VAL: `，值 `toFixed(2)`；`totalVolume === 0` ⇒ 三格都 `"-"`。`legends` 会整段替换 figures 生成的默认行（§二·4），而 figures 是空的，所以这一行就是 VPVR 在图上的全部文字。标题用中文字面量、不走 i18n，与 `haTooltipDataSource` 同例（库只对**蜡烛**图例的 title 再跑一次 i18n，`dist:7678`）。
它需要 `chart` 来取可视区——实参里有（§二·4 `dist:7294`），照用；下标类回退问题在这里不存在，因为分布不依赖 `crosshair`。

**注册守卫**：模块布尔 `registered`，与 `ensureHeikinAshiIndicator`（`heikinAshiChart.ts:226-244`）、`ensureTimeShareIndicator`（`timeShare.ts:314-325`）同写法。

---

## 七、页面接线（`ProChart.tsx`）

抄第④片那套已验收的形状，五处：

1. `const [vpOn, setVpOn] = useState(() => loadVpvr());` ＋ `const vpRef = useRef(vpOn);`（`haOn` 同形，`:554-559`）。唯一写者是 `toggleVpvr`，照 `toggleHeikinAshi`（`:1892-1897`）：翻 ref → `setVpOn` → `saveVpvr`。
2. `syncVpvr(chart, on)`：照 `syncHeikinAshi`（`:974-999`）逐行同形——`on` 假只 `removeIndicator({ name: VPVR_NAME })`；真则 `ensureVpvrIndicator()` → `getIndicators({ name: VPVR_NAME })` → `live.slice(1).forEach(extra => removeIndicator({ id: extra.id }))` → `live.length === 0` 才 `createIndicator({ name: VPVR_NAME, paneId: MAIN_PANE_ID }, true)`（第二实参 `isStack` 必填真，否则 `StoreImp.addIndicator` 会把同 pane 的 HA/MA 一起卸掉——这条语义第④片探针 F 已实测）。
3. `useEffect(() => syncVpvr(chartRef.current, vpvrActive(vpOn, timeShare)), [vpOn, timeShare])`，紧挨 HA 那个 effect（`:1331-1341`），注释照抄那条的「不列 `chartRef.current` 与 `syncVpvr` 的理由」。
4. 工具栏按钮紧跟「平均K线」（`:2272-2299` 之后）：`aria-label="量分布"`、`disabled={timeShare || barCount === 0}`（**故意不用** `vpvrActive`，理由与 HA 那条注释同：开关关着时按钮不该天天灰）、`aria-pressed={vpvrActive(vpOn, timeShare)}`、reason 三分支文案——分时那句改成 `"分时是面积线，分档量能要按高低价摊派，这里没有可摊的区间"`，零数据那句照抄，另两句按 `vpOn` 说「已开／已关」。
5. **`chartStyles` 一处都不改**（§一 末条）。VPVR 不需要样式：它不藏任何东西、不改图例模板、不改价格轴。HA 需要九色是因为它要替换蜡烛绘制；VPVR 是**叠加**，没有需要覆写的样式键。

**与 HA 的相互关系（要钉，不是要假设）**：两个指标同挂 `candle_pane`，`indicators.forEach` 按挂载顺序各画各的，每帧只清屏一次（§二·5）⇒ 叠加成立。判据落在测试侧（HA 在位时挂 VPVR，两者都仍只有一份实例、`createIndicator` 的 `isStack` 都为真）与活体侧（§八 第 3 步）。反向也钉：卸 VPVR 不动 HA，卸 HA 不动 VPVR。

---

## 八、未来函数边界与验收

**边界**：VPVR 是显示层，不产出信号；但它读的是「可视区里有哪些根」，所以两条要自证——

1. **只用已收盘数据**：`slice` 来自 `chart.getDataList()`，回放态下库把 `dataList` 截到游标（第②片的既有事实），所以游标之后的根**不在数组里**，摊派不到。
2. **不重绘历史**：本片的「不重绘」含义与 HA 不同——VPVR 的定义就是随可视区变。可证的不变量是「**同一可视区 ⇒ 同一张分布**」与「**分布不吸收被喂进去的那批根之外的任何量**」。后一条由**三件**成立，缺一件都不算证过：① `volumeProfile` 是纯函数，除了参数没有别的面拿得到数据（零 import、无模块级状态）——§九 那根下毒针的三件套判它的确定性/无跨调用状态/不改调用方数组；② **喂进去的是哪些根**由 `profileOfChart` 的切片唯一决定——§九 里 `profileOfChart` 那条假 chart 逐索引针判它（纯函数判不了这一条，切片不在它的签名里）；③ 回放态下库把 `getDataList()` 截到游标，游标之后的根根本不在数组里（第②片既有事实）。

**Bar Replay 五步自查**（spec 交付必附，本仓纪律）：

1. 进回放（游标在中段），记录 `getDataList().length = N`、可见区索引 `realFrom/realTo`；
2. 读图例三格 POC/VAH/VAL，与**页内独立 oracle**（按 §四/§五 重算的那套，`window.__vp`，喂与 `profileOfChart` 同一口径的可视区切片）比对，判据是**三个 `.toFixed(2)` 字符串逐字相等**，**不是**数值容差：图例本身已量化到分，一个真 bug 换掉的是**档下标**（差一整格价格），而不是小数末位；两侧循环形状不同（oracle 用「先造边界数组、逐档 `min/max` 求重叠」，生产用游标 `while`），最后一位必不相等，写绝对位数容差只会把针在无辜算术上判红。实测量级也否掉了绝对界——A 股档位量在 `1e6`～`1e9`，`1e-9` 那种界在这里从来不可满足。**比对口径分两层（先定死，别到执行席发明）**：屏幕上那串字在 canvas 里，DOM 读不到 ⇒ 「值」那一层从公开口读回来——`getIndicators({name:'VPVR'})[0].createTooltipDataSource({chart})` 的三个 `value` 串与 oracle **逐字相等**；「字形」那一层由库自己那两枚函数复现（`:7329-7331` 跑的就是 `decimalFold.format(thousandsSeparator.format(text))`，`getThousandsSeparator().sign` 出厂 `,`、`getDecimalFold().threshold` 出厂 3，本仓无覆写），对每格算出「原始串 → 格式化串」并**两串都登记**，价格 ≥ 1000 时带逗号的那串是**预期**不是缺陷（`"-"` 那格不过 `isNumber` 那道门，原样留着）。若哪天改成从带逗号的串回解数值再比，必须**先剥分组符再 `Number()`**——`parseFloat("1,234.56")` 会截成 `1`，那是个真陷阱。不等时按两条落点规则裁决（写在计划里，不留给执行席当场发明）：相对差 `< 1e-9` ⇒ 四舍五入落点；`POC` 对得上而 `VAH`/`VAL` 恰差一格且 oracle 的覆盖率离 70% 门槛在相对 `1e-9` 内 ⇒ 70% 落点分歧。两者都不是缺陷，都要把读数登记进台账；「屏幕上真有没有这一行」只有可读截图才判得了，拿不到截图就登记「未判」，不许拿读数冒充；
3. `后一根` ×6 ⇒ 判据是**「每步重读切片、重跑第 2 条的逐字比对」**。这里**不能**断言 `totalVolume` 单调不减：分布域取的是**可视区自身**的极值，回放步进让库自动右滚时 `realFrom` 会前移，最早那几根掉出窗口，`totalVolume` 就**可以**下降——那不是缺陷而是本片的定义（§十二·4）。要读单调性只能读「`realFrom` 未动的相邻两帧之间」，且它不是交付判据。**同样不能判「逐档与 oracle 相等」**：档量只活在 `vpvrDraw` 那一帧的局部变量里，`getIndicators()[0].result` 在 §六 那两把钥匙（`calc` 返回 `[]`）下恒空，页内没有任何面读得到它们——第一版把这条写成「逐档对 `1e-9`」，是指了一个不存在的读数口。逐档级的「不吸收被喂进去的那批根之外的量」按 §八·2 那三件分头判（纯函数面归 §九 下毒针三件套，切片面归 §九 `profileOfChart` 的逐索引针，回放截断是库的既有事实），三件都比页内读数强；
4. `前一根` ×1 ⇒ 末根消失，oracle 用短前缀重算，逐字比得上（不许留「已经画过的那一档还带着未来的量」）；
5. `退出回放` ⇒ 全量切片下三格逐字相等；VPVR 实例仍恰好一份；`getYAxes()[0].getRange()` 与 VPVR 开前**逐字相同**（这条就是 §六 那两把钥匙的实地判据）。

每步同时读：`getIndicators({name:'VPVR'}).length === 1`、`getIndicators({name:'HEIKIN_ASHI'}).length` 与进入前相同、`getDataList()` 的**引用与 JSON 快照**在开关前后相同、`localStorage['pro-chart.drawings.v1']` 逐字节相同。

**活体的现实约束**（预先登记，不假装能拿到拿不到的东西）：本环境的内置浏览器可能再次丢掉可见表面（第④片实测），`take_screenshot` 会恒报 `NATIVE_BROWSER_VIEWPORT_UNAVAILABLE`，且 `rAF` 停摆时 `getRange()` 读到的是**陈旧值**（已记入 [[chart-canvas-browser-forensics]]）。⇒ 轴读数必须在能出帧时取；拿不到帧就按「未判」登记，不许把状态读数写成截图级判据。

---

## 九、测试判据（每份都要「能红」）

`frontend/src/lib/__tests__/volumeProfile.test.ts`（纯算术，无 mock）：

- **手算向量**（先写期望值，再写实现）：4 根小样本、`rows = 4`、每根 `[low, high]` 恰好跨两档 ⇒ 逐档 `volume` **精确相等**（夹具选成域宽 4、每根 `high − low = 2`，摊派系数只能是「除以 2」⇒ 二进制精确，所以计划用 `toEqual` 逐格钉死而不是写容差；写容差就等于放弃了这条针的一半杀伤力）；
- **一字线** `high === low` ⇒ 整量进包含该价的那一档，且**不产生 `Infinity`/`NaN`**（摊派分母为 0 是唯一造得出 `NaN` 的地方）；
- **末档右闭**：一根 `high === spanHigh` ⇒ 钳进最后一档；
- **POC 并列取下**：两档同量 ⇒ `pocIndex` 是下标小的那个；
- **价值区**：手工构造的集中分布 ⇒ `lowIndex/highIndex/coverage` 逐格；再加一根「两侧等量时先吃上侧」的针；「单侧到头」的针（POC 在第 0 档）；
- **反未来函数下毒针（三件一起才算立住）**：① `volumeProfile(all.slice(0, k))` 的期望**逐格写死**（域、逐档量、总量、`pocIndex` 全用字面值）；② 在 `all` 的 `k` 之后追加一根荒谬巨量（`volume: 1e12`、`high/low` 远超域）得到 `all2`，`volumeProfile(all2.slice(0, k))` 与 ① **整体 `toEqual` 相等**；③ **阳性对照**：`volumeProfile(all2)`（真把毒根喂进去）的域与总量必须改掉。
  为什么非要这三件：`all2.slice(0, k)` 与 `all.slice(0, k)` **逐元素相同，只换了数组对象**，所以第一版把它写成「两条互比 ⇒ 前缀不吃后缀」时，针判的其实是「无跨调用状态、对同一批根给出同一结果」——两侧一起错也照样绿。字面参照点（①）把它撑成有牙的等值判据，阳性对照（③）证明毒根不是 inert 输入（本仓 [[verify-scan-guard-false-green]] 的「空集合真空通过」同型失效）。**再加一行回读**：前两次调用喂的都是 `slice()` 出来的临时数组，实现若就地改写传入数组（`sort`／写脏某根），只有把调用方自己留着的那个数组读回来才抓得住——`all2` 的域与总量对元素顺序不敏感，代替不了这一行。**判据边界要写进注释**：「切片本身取对没有」不属一个纯函数的判据面，它归 §九 里 `profileOfChart` 那条假 chart 逐索引针——那里才决定喂进哪些根。`all2` 的 `pocIndex` **不许钉**：`1e12` 摊到各档彼此等值，最大档由真实根零头决定，钉它等于把判据交给末位舍入；
- **退化三条**：空输入／`spanHigh === spanLow`／全零量。全零量那条**同时钉「零量根照旧参与域扫描」**（极值循环在 `volume === 0` 的 `continue` 之前 ⇒ `spanLow/spanHigh` 仍是真实极值），且夹具的两根**顺序刻意不让撑满域的那根排在 `bars[0]`**——实现是 `bars[0]` 播种极值再无条件扫描，若第一根就是全域，「在极值循环里加一句 `if (volume === 0) continue`」这种缺陷也照样得到同一组极值，针就被夹具自己喂绿。这条不是锦上添花：几何夹具靠一根零量锚根把域撑成 `[100,200]`、把档宽钉成 1 个价格单位，期望矩形才逐格写死得住——它一旦漂出，那批写死的矩形会整体错位，所以判据必须入库，不能只活在验收当天的 scratch 里；
- **前缀单调**：`totalVolume(profile_k)` 随 `k` 不减，且 `sum(rows.volume)` 与 `totalVolume` 在**相对**误差 `1e-11` 内相等（摊派不丢量、不造量——这条同时钉住 §四 的钳位与摊派系数）。判相对界而不是绝对位数：档宽 `域宽 / rows` 在二进制里通常不精确（出厂 100 档配域宽 12 ⇒ 0.12），累加噪声随样本量级漂，而结构性漏档是 O(一档的量)——两者差十个数量级，绝对位数界反而会把针在无辜代码上判红（本轮实现席在 `rows = 100` 实测噪声 2.36e-9，`toBeCloseTo(…, 9)`＝5e-10 的绝对界当场红）。

`frontend/src/lib/__tests__/vpvrChart.test.ts`（`vi.mock("klinecharts")` 只给 `registerIndicator: (spec) => pushed.push(spec)`，照 `heikinAshiChart.test.ts:6-8`）：

- 声明逐格钉（按条目名钉，不数格数）：`figures` **是空数组**、`calc(喂真实 bar)` **返回 `[]`**（不是 `undefined`）、`series === "price"`、`precision === 2`、`shouldOhlc === false`、**没有 `zLevel` 键**（§六：不声明，让库的构造器默认生效；这条针同时是「实现者别顺手加」的门）、`draw`/`createTooltipDataSource` 都在；
- §六 那个「镜像折叠」helper：把本指标声明的 `figures[].key` 集合喂给 min/max 折叠，断言得到的价格集合为空 ⇒ 轴只能来自蜡烛高低价；
- **`profileOfChart` 的假 chart 逐索引针（左右两边缘都要有，这是 §八·2 第三件的全部承载点）**：切片口径是 `[Math.max(0, realFrom), Math.min(realTo, dataList.length))`，四条各判一格——① 右边缘截断（`realTo` 落在中段 ⇒ 之后的根不进域与总量）；② `realTo` 越过 `dataList.length` 时按长度截（右侧留白有像素没数据）；③ **左边缘**：`realFrom > 0` 时左边那几根不进切片，且这条的 fixture 必须让 **`from ≠ realFrom`** 同时成立。理由不是假想：库在 `dist:13566` 明写右侧有留白（`_lastBarRightSideDiffBarCount > 0`）时 `realFrom` 另算，与 `from` **真的分家** ⇒ 「读错那一格」是页面上走得到的错，而 `const from = 0`（焊死左边缘）是它的近亲变异。判据选 `totalVolume` 而不是极值，因为被掉的根要选成价格**落在域内**——否则 `spanLow/spanHigh` 会替总量分担判决，两侧一起错也能绿；④ `realFrom` 为负时按 0 起（这一条单独存在挡不住 ①②的变异，`from` 与 `realFrom` 在这里恒等，所以它不能替代 ③）。首版计划只写了 ①②④，缺 ③——两条变异体（`const from = 0` 与「解构读错那一格」）都能全绿通过，这是计划的缺口，Task 3 修复轮补上；
- `vpvrDraw` 的几何：假 ctx 录制 `fillRect`（模板抄 `heikinAshiChart.test.ts:61-84` 的 `drawFixture`，但**喂的是假 chart 的 `getDataList`/`getVisibleRange` 而不是 `indicator.result`**，且假 chart **只交这两格**——喂多出来的成员等于替身替实现者兜底，实现误读 `xAxis` 时这条针要能红）。样本域摆成 `[100, 200]` 配出厂 100 档 ⇒ 档宽恰为 1 个价格单位，期望**矩形列表逐格写死**（右锚 `x = bounding.width - len`、最大档 `len = bounding.width * 0.35`、零档不出现）；另开一条 `convertToPixel: (p) => 100 - p * 0.25` 的小比例 fixture，档高 0.25px 被 `Math.max(1, …)` 抬成 1，这条就是亚像素那格的针。像素映射选成整数倍（`300 - 2*p`），所有期望值都是二进制精确数，`toEqual` 不用容差。**换宽度那两条同理**：期望写成与生产**同一表达式**（`bounding.width * VPVR_MAX_WIDTH_RATIO`、`bounding.width - 同一表达式`）配 `toBe`，而不是绝对小数位容差——首版计划在那里写了 `toBeCloseTo(…, 10)`，与本条自相矛盾（本仓口径：不用绝对位数界），Task 3 修复轮按本条收口；两侧同算同一表达式时浮点落点必然一致，`400*0.35 === 140` 当场核过。
- 三枚颜色的归属：POC 档取 POC 色、价值区档取 VA 色、其余取 BASE 色——**用档量刻意造出「POC 同时是价值区端点」**，否则这条针会被上一格吃掉（本仓 [[verify-mutation-probe-blindness]] 的归属教训）；
- `vpvrDraw` 恒返回 `true`；空可视区返回 `true` 且**一根都不画**；
- `vpvrTooltipDataSource`：正常三行 ＋ `totalVolume === 0` 三格 `"-"`；
- 偏好四条：`loadVpvr` 只认 `"1"`、垃圾值关、**`getItem` 抛起来时读成关**（三个态各有输入，标题提了「抛错」就得有一步真把 `getItem` 桩成抛——本仓登记过的「标题 overclaim」形状；idiom 照 `apiAuth.test.ts` 的 `vi.spyOn(Storage.prototype, "getItem")`，收尾靠 vitest 配置的 `restoreMocks: true`）；`saveVpvr(false)` **删键**不写 `"0"`、**且 `setItem`/`removeItem` 抛时不往上抛**（`saveVpvr` 的 catch 分支同样要有输入，否则那格会烂）；`vpvrActive` 真值表四格。
- **对外常量的字面参照点**：`VPVR_NAME`／`VPVR_SHORT_NAME`／`VPVR_PREFS_KEY`／三枚色／`VPVR_MAX_WIDTH_RATIO` 逐个钉**字面量**。其余用例的期望值全部来自同一个被测模块导进来的常量 ⇒ 「常量被改值」这类变异两侧一起动、永远绿（本仓 [[verify-mutation-probe-blindness]] 的「两侧一起错」型），所以参照点必须有一处不从被测模块来。
- **用例之间不许有顺序依赖**：抓注册对象的 `spec()` helper 自己调一次幂等的 `ensureVpvrIndicator()`，不靠「上一条测试已经注册过」——否则删掉或乱序任何一条，后面的红得莫名其妙。

`frontend/src/pages/__tests__/ProChartVpvr.test.tsx`（替身形状抄 `ProChartHeikinAshi.test.tsx`，注意 `vi.mock("klinecharts")` 是**整模块替换**、只导了 5 个成员，本片不需要新成员）：

- 点一次 ⇒ `h.indicators` 里**恰好一份** `VPVR`，且 `h.created` 第二实参 `isStack` 为真；
- 反复开关不堆叠（`created` 里 `VPVR` 次数＝按的次数）；StrictMode 双挂载去重分支可达（照 HA `:533-543` 那条）；
- **与 HA 共挂**：HA 已开时按 VPVR ⇒ 两个名字各一份，卸 VPVR ⇒ HA 那份还在、`overrideOverlay` 零新增（候选集就是 HA 那片种下的那条真带 `points` 的线，别把种子清空——它是那条针的意义）；
- 分时互斥：进分时 ⇒ VPVR 卸、`aria-pressed="false"`、reason 含「面积线」；回蜡烛 ⇒ 自动挂回且偏好键仍在；
- **数据面与画线面零影响**：开关前后 `getDataList()` 引用等值 ＋ `JSON.stringify` 快照等值（两侧都量，「开」和「开→关」各一次，抄第④片 R12 的形状）；`h.overlays[0].points[0]` 逐字未变；`h.overridden` 穿越前后相等；
- 样式面零影响：`h.styles` 最后一次推送与 VPVR 无关——断言 `Object.keys(...).indicator` 仍**恰等于 `["tooltip"]`**，`candle.bar` 九键未因 VPVR 变化（这条是防「将来有人图省事给 VPVR 加样式键」）；
- 空图：`barCount === 0` ⇒ 按钮 `disabled` 且 reason 说「先等 K 线加载出来」；**不**声称「空图时不会挂指标」（第④片 R9 的教训：effect 无 `barCount` 门，灰按钮在 jsdom 与浏览器一样不派发事件，那条针永远绿）。

**变异自证（交付门槛，不是可选项）**：至少四根针，每根「恰 N 条红 ＋ 红的 `file:line` 归属写明」——① `figures` 从 `[]` 改成 `[{ key: "volume", type: "bar" }]` 而 `calc` 仍交空数组 ⇒ **只有声明钉该红，镜像折叠那条必须仍然绿**：两把钥匙判的是合取，第二把还挡着，这正是要「两把」而不是「一把」的理由。要证镜像 helper 自己有杀伤力，得再注入一次——`figures` 加 key **且** `calc` 返回 `[{ volume: 123.4 }]` ⇒ 那条红；反向只改 `calc`（`figures` 仍空）⇒ 那条仍绿。三次注入（单改 figures／双改／单改 calc）合起来才把「两把钥匙」写成可判活的针；② 摊派系数分母从 `(high - low)` 改成 `1` ⇒ 手算向量红；③ POC 扫描的 `>` 改成 `>=` ⇒ 并列取低那条红；④ `ctx.fillRect` 的 x 从 `bounding.width - len` 改成 `0` ⇒ 右锚那条红。注入一律 `cp` 备份/还原、禁用 `git checkout --`，还原后 `git hash-object` ＋ `git status --porcelain` 双校验。

---

## 十、门禁

`frontend/`：`npx tsc --noEmit -p tsconfig.json` ⇒ `rc=0`；focused 三份全绿；全量 `npx vitest run`（本机内存常只剩 2GB，OOM 就照实写「未跑」并只报聚焦，**不许删用例换绿**）；`npx vite build`。
仓根：`python -X utf8 -m pytest tools/test_wiki_drift.py -q`；`bash tools/wiki_freshness_gate.sh`；`bash tools/ci_grep_gates.sh`——**分开跑，不用 `&&` 串**（本仓登记过：装饰性打印抛错会把门静默吃掉）。
两处本地恒红（水位 `443 (threshold 439)`、gate b 命中 3 处全在非跟踪面）是**继承红**；本片只报「本片 0 贡献」的三项独立证据（阈值是 `tools/wiki_freshness_gate.sh:16` 预存常量、本片 diff 不进 `tools/`、`.qoder/repowiki` 内 `vpvr` 引用数 0），**不调阈值、不改门、不动上游拥有的文件**。
退出码单独读（`cmd > /dev/null 2>&1; echo rc=$?`）——`cmd | tail -3; echo rc=$?` 取到的是 `tail` 的码，本仓登记过的成因⑤。

---

## 十一、落档与记忆更正

- 档案 `项目档案.md` 新增一节（§7.19），必含三条：本片的通道裁定与 §〇 那三条证据（含 `serializeDrawings` 无白名单这条硬事实）、两把钥匙（`figures: []` ＋ `result: []`）的判据与它的**边界**（jsdom 侧判声明，实地判轴）、以及 100 档/35%/70% 三个出厂常量的出处。档案是**纯 CRLF 工作树**，必须 bytes 层改；改完复跑 §十 那三道档案门，复跑读数**只落台账不回灌档案**（否则自指）。档案里**不写**本片提交笔数、行数、`HEAD=` 之类自指读数。
- 记忆更正三条：`chart-drawing-landing-and-figure-channel` 补「VPVR 不走 overlay 通道，因为 `serializeDrawings` 没有工具名白名单」；`chart-klinecharts-indicator-draw-and-axis` 补「`figures: []` ＋ `result: []` ＝ 结构上不改价格轴，与第④片『把值挂 key 上免裁切』是同一规则的用法两面」；`ops-delivered-features-and-comparisons` 补第⑤片交付面与终态。
- 交付报告随片出，含 §九 四根变异针的运行输出与 §八 五步自查逐格读数。

---

## 十二、已知代价（写在前面，不留给评审去发现）

1. **每帧重算分布**。100 档 × 可视若干百根，帧时应在亚毫秒级，但这是**未实测的推断**；活体那一步要读一次「连续拖动 30 帧有没有掉帧」。若真掉帧，正解是加「键＝(from,to,spanLow,spanHigh,totalVolume) 的单槽缓存」，而不是把计算挪进 `calc`（`calc` 拿不到可视区）。
2. **颜色不跟主题**。三枚半透明色在暗/亮底上都可读，但**没有实测亮色主题下的对比度**——活体第 4 步补一次肉眼/像素读数，读不到就登记未判。
3. **POC 价的口径是档中点**（`(row.low + row.high)/2`），不是真实成交均价。档数 100 时误差上界约 `span/200`，图例读到 2 位小数在小价位品种上会看到这个近似。这是分档直方图的固有精度，不是 bug。
4. **分档域取自可视区自身的极值**，所以「同一根 K 线在两个不同可视窗口里落在不同档」是正常行为；VPVR 的分布因此**不可跨窗口比对**，也不落盘。
5. `volume` 的**单位**前端拿不到（§一 那条），所以纵轴的相对形状可信、绝对数字不可解释——本片因此只把「量」画成长度，不把量印成文字。
