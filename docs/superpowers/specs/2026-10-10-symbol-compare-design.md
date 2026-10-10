# 第⑥片 多标的叠加对比（同 pane、独立标尺）设计

**分支** `feat/symbol-compare`（基座 `990c237d`）｜**日期** 2026-10-10｜**形态** 单人主控 + 真实浏览器活体取证

---

## 一、这片要解决什么，以及盘面证据

`/pro-chart` 是**单标的**图。业界标准图表（下称 TV）的 Compare 功能族——把第二个标的画到同一张图上看相对强弱——在本仓是**结构性空白**，不是"有但没接"：

- 工具栏第一行只有主标的的输入框、加载、加自选与六个预设；第二行是分时／平均K线／量分布／八个周期／回放／指标公式／副图指标／画线／磁吸／清单／导出导入／图例。**没有任何一个入口能把第二个标的带到图上**（`frontend/src/pages/ProChart.tsx:2276` 起整段渲染面）。
- 状态面：`symbol` 是单值 `string`（`frontend/src/pages/ProChart.tsx:471`），`chart.setSymbol({ ticker: symbol, … })` 两处调用点各只喂一个标的（`frontend/src/pages/ProChart.tsx:1319`、`frontend/src/pages/ProChart.tsx:1714`）；左侧自选列表 `onPick={applySymbol}` 的语义是**替换**（`frontend/src/pages/ProChart.tsx:2935`、`frontend/src/pages/ProChart.tsx:1703`）。
- 取数面：`fetchKline` 一次一个 symbol（`frontend/src/lib/marketApi.ts:226`），全仓四个调用点都是单标的（`frontend/src/pages/ProChart.tsx:1166`、`frontend/src/components/charts/ChartCell.tsx:172`、`frontend/src/lib/screener.ts:196`、`frontend/src/lib/indicatorLang.ts:1120`，最后一个是**同标的低周期**，不是第二标的）。
- `pages/Compare.tsx` 名字像但不是——它比的是回测 run 与指标，不画行情。
- **后端不需要新端点**：`/api/udf/history` 与 `/market/kline` 都只收单标的（`agent/src/api/udf_routes.py:766-779`、`agent/src/api/market_routes.py:765`），唯一收多 symbol 的是 `/market/quote`（`market_routes.py:800`，只回最新价）与 `/correlation`（`agent/src/api/system_routes.py:274`，回的是相关系数矩阵，不是可画的 OHLCV）。⇒ 叠加 = 前端**再调一次** `/api/udf/history`，自己按时间戳对齐。

对齐这件事仓内**没有**现成件可复用，这条也是取证结论，别照抄错：`frontend/src/lib/mtfSync.ts` 对齐的是「同一标的、四个周期」的视口与光标（`frontend/src/lib/mtfSync.ts:4-10` 自述），它内部那个通用二分 `lowerBound` **没有导出**（`frontend/src/lib/mtfSync.ts:112`，全 `frontend/src` grep 只命中 `mtfSync.ts` 自己文件的 4 处，外加测试文件里的一句注释 `frontend/src/lib/__tests__/mtfSync.test.ts:182`，没有任何导入点）。可导出的只有 `barTimestamps`/`barEndOf`/`countWithin`/`coarseBarSpanMs`/`createApplyGate` 这类原语。唯一成型的跨标的时间戳对齐配方在**后端**：`agent/backtest/correlation.py:156-186`（normalize 到日 → 取收益率 → inner-join → 全 NaN 行丢弃 → 交集空则显式报错并打出每个标的的日期区间）。本片不搬它的 inner-join（那会让对比线在主图已有根上出现空洞），搬它另一条更基本的口径：`agent/backtest/loaders/akshare_loader.py:246-253` 的**只 ffill、拒绝 bfill**，原文理由（`agent/backtest/loaders/akshare_loader.py:249-251`）是「a back fill would quote a bar a factor the market had not issued yet, which is the future-information leak」——回填等于给市场尚未发布的 bar 报价，那是未来信息泄漏。

## 二、通道裁定：走 `createIndicator({paneId:'candle_pane', yAxisId})` 的公开多轴通道

第⑤片（VPVR）为了画一个库不支持的图元，最后走了 indicator 的 `draw` + 裸 `ctx.fillRect`。**本片不走那条**，因为这个 build 里有一个当时没读到的公开通道：**一个 pane 可以有多根 y 轴，且指标可以被指派到其中任意一根**。以下坐标全部是本次亲自读到的 `frontend/node_modules/klinecharts/dist/index.esm.js`（UMD 恒 +5）。

1. **给指标传 `yAxisId` 就会自己长出那根轴**：`ChartImp.prototype.createIndicator`（`index.esm.js:15263`）在 `index.esm.js:15273` 尊重调用方传入的 `yAxisId`（只有缺省才回落到该 pane 的默认轴 id），随后 `index.esm.js:15282` 调 `_createOrUseIndicatorYAxis(pane, yAxisId)`；那个函数（`index.esm.js:15241`）在 `index.esm.js:15243-15245` 发现轴不存在就 `pane.createOrOverrideYAxis({...getLayoutOptions().yAxis, id: yAxisId})` **建出来**，在 `index.esm.js:15247-15249` 若它是 manual 就把 manual **摘掉**。
2. **摘掉 manual 之后它才是一把真独立的尺**：`YAxisImp.prototype._shouldUseCandleData`（`index.esm.js:980-983`）= `isInCandle() && (isDefaultYAxis(id) || isManualYAxis(id))`。它为假时，`createRangeImp` 不再把主图蜡烛的 high/low 折进来（`index.esm.js:1028` 的 `shouldCompareHighLow` 由它决定），该轴量程只由**绑在它上面的指标**的 `figures[].key` 数值决定（`index.esm.js:1045-1056`）。
   - 反过来也是一条要避开的坑：**显式调 `createYAxis` 会把轴标成 manual**（`index.esm.js:15483`），而 `_shouldUseCandleData()` 对 manual 轴为真 ⇒ 一把刚建出来、还没挂指标的空尺会**先把主图蜡烛撑进自己的量程**。所以本片**不调** `createYAxis`，只让 `createIndicator` 顺手建轴（`index.esm.js:15244` 那条路径不设 manual）。
3. **主图默认价格轴结构上收不到对比序列**：轴收集数据的唯一口径是 `_getIndicatorsByYAxisIds()`（`index.esm.js:965-979`），它把本 pane 的指标按 `indicator.yAxisId ∈ {本轴 id} ∪ {本轴 manual 时再加默认轴 id}` 过滤（`index.esm.js:978`）。对比指标的 `yAxisId` 是我们的自定义常量 ⇒ 不在默认轴的集合里 ⇒ 主图轴量程**不可能**被它撑开。这是本片最重要的一条不变量，也是为什么"叠加一个价格完全不同尺的标的"在这个库里安全。
4. **卸载即自动回收，不需要自己管轴的生命周期**：`ChartImp.prototype.removeIndicator`（`index.esm.js:15323`）在 `index.esm.js:15327` 调 `_removeOrphanYAxes()`（`index.esm.js:15217-15240`），后者删掉「既不是默认轴、又没有指标绑着、又**不是 manual**」的轴（判据 `index.esm.js:15234`）。我们那根轴走完 `index.esm.js:15247-15249` 已经非 manual ⇒ **删指标就顺手删轴**。
   - 但这条是**有条件的**：`createYAxis` 建的 manual 轴**不会**被 `index.esm.js:15234` 回收（第三个条件正好把它挡住）。⇒ 若哪天有人"顺手"加了 `createYAxis`，切走对比就会**漏一根轴**。这条要落进判据（§十·③）。
   - `removeYAxis` 本身另有两道拒绝：蜡烛 pane 的默认轴删不掉（`index.esm.js:15505`）、仍被指标占用的轴删不掉（`index.esm.js:15509`）⇒ 真要显式删轴必须**先删指标再删轴**，顺序是硬约束。
5. **多轴布局是内建真功能，不是半成品**：`DrawPane.prototype.createOrOverrideYAxis`（`index.esm.js:10308`）按 `needWidget ?? true`（`index.esm.js:10313`）决定要不要给这根轴建控件（`index.esm.js:10324`），并且 `index.esm.js:10323` 只在 `_defaultYAxisId` **未设**时才认领 ⇒ 我们的轴不会抢走蜡烛 pane 的默认轴身份。宽度分配在 `ChartImp.prototype._layout` 里按 **左外／左内／右内／右外** 四列算（`index.esm.js:14856-14901`），`mainWidth` 减去左右外侧总宽（`index.esm.js:14914-14917`）。⇒ **加一根右外侧轴会从主图绘图区扣掉一条像素**，这是本片的可见代价，不是 bug。
   - 关掉之后会不会留下一条死空白？`removeYAxis` 触发的 layout 不带 `cacheYAxisWidth`（`index.esm.js:15528-15534`），而 `cacheYAxisWidth` 只在为 `true` 时把宽度取 `Math.max(缓存, 现算)`（`index.esm.js:14905-14908`）、且每次 `_layout` 跑完就把选项位复位（`index.esm.js:15003-15012`）⇒ 不带该位的那次 layout 会**按现存轴重算并把缓存覆盖成小值**（`index.esm.js:14909-14910` 无条件写回）。**结论：会缩回去**，但要活体读数背书（§十·④）。
6. **图例走库自己的指标块，不碰第③片的合成点**：`IndicatorTooltipView.prototype.getIndicatorTooltipData` 在 `index.esm.js:7272-7285` 遍历 figures，**`isString(figure.title)` 才 push 一行**（`index.esm.js:7273`），数值经 `formatPrecision(value, indicator.precision)`（`index.esm.js:7277`）；标题用 `indicator.shortName`（`index.esm.js:7249-7259`）。而蜡烛 pane 的 tooltip 会把**同 pane 所有指标**的行追在下面（`index.esm.js:7396-7401`、收集点 `index.esm.js:7062`）。⇒ 给对比指标一个 `title: "对比收盘"` 就自带读数行，**一行样式键都不必写**，`chartStyles` 那个唯一合成点不动。
   - 两个由 §二·8 的缺口送来的图例后果，都登记为**语义**不是缺陷：① 那几根（主图有 bar、对比还没有价）的格读的是库的 `tooltipStyles.legend.defaultValue`（`index.esm.js:7283` 的三元回退），出厂值 `'n/a'`（`index.esm.js:11523`，本仓唯一写 `candle.tooltip.legend` 的地方是 `frontend/src/lib/chartLegend.ts:107-108` 的那个 `template`，**没有**覆写这一格）；② `index.esm.js:7272` 那个 `eachFigures` 遍历的是 `prepareIndicatorFigures` 的产物 ⇒ 省略 `type` 时**连图例行也一起消失**，"静默不画"包含"静默不读"。
7. **精度不新增规则**：那根轴的刻度文本精度在非蜡烛路径取 `Math.max(precision, indicator.precision)`（`index.esm.js:1160-1175`，实际分支 `index.esm.js:1167-1175`）；同时 `StoreImp.prototype._synchronizeIndicatorSeriesPrecision`（`index.esm.js:14215-14241`）会把 `series === "price"` 的指标精度**覆写成主标的的 `pricePrecision`**（`index.esm.js:14221`），且整个覆写包在 `if (isValid(this._symbol))` 里（`index.esm.js:14216`）。本页出厂就是 `pricePrecision: 2`（`frontend/src/pages/ProChart.tsx:1319`、`frontend/src/pages/ProChart.tsx:1714`）。⇒ 裁定：对比指标声明 `series: "price"` ＋ `precision: 2`，**继承本页已有的那一条精度约定**，不自造"根据数据估小数位"的第二套规则；代价（低价标的会被显示成 `0.00`）作为**本页既有**限制登记在 §十一·2，不是本片引入的。
   - 同一支 `createOptimalTicks` 在 `index.esm.js:1188` 对每格刻度文本跑 `decimalFold.format(thousandsSeparator.format(v))`，而千分位默认 `sign: ','` 且本仓没有任何覆写点（第⑤片 `lib/vpvrChart.ts` 文件头末段记过同一条）⇒ 对比轴上 ≥1000 的刻度与图例读数一样带逗号，是**预期**不是缺陷。

8. **`figures[].type` 必须写，且 `null` 在折线上是真缺口**（这条决定 §三 的输出形状能不能直接用）：
   - `type` 是**分发钥匙**：`prepareIndicatorFigures`（`index.esm.js:3081-3133`）只对 `'text'|'circle'|'bar'|'line'` 四个 case 设 `defaultFigureStyles`，随后 `index.esm.js:3128` 用 `isValid(figure.type)` 决定这条 figure 进不进渲染清单。`isValid`（`index.esm.js:213-215`）＝「非 null 且非 undefined」⇒ **省略 `type` 会静默丢掉整条 figure**（线一条都不画，且不报错；图例那行也一起没了，见 §二·6 的②）。所以 §四 那句 `type: "line"` 是承重的，不是样式。
   - `null` 的一侧是**双向**缺口：`IndicatorView.drawImp` 的 figure 分支被 `index.esm.js:8095` 的 `isValid(currentData[figure.key])` 挡（null ⇒ 整根跳过），而 `line` 那一支（`index.esm.js:8133-8146`）额外要求**当前与下一根都有像素**（`index.esm.js:8137`），坐标只在 `isNumber(value)` 时才写入（`index.esm.js:8084-8091`，`isNumber`＝`typeof number && Number.isFinite`，`index.esm.js:210-212`）。⇒ 第 `i` 项为 `null` 会同时吃掉 `(i-1→i)` 与 `(i→i+1)` 两段。
   - 缺口**不会被桥接**：线段先按 figureIndex 汇聚进 `lines`（`index.esm.js:8134-8135`），再由 `index.esm.js:8161-8190` 合并成折线，合并条件是上一折线的**末点与当前折线的起点逐坐标相等**（`index.esm.js:8174-8175`）⇒ 中间断了就得到两条独立折线，而不是一条跨过缺口的长线。
   - 缺口**不会掉到基线**：`baseValue`/`yAxis.getRange().from` 那套只属于 `'rect'|'bar'` 分支（`index.esm.js:8114-8131`），`line` 分支不读它 ⇒ `null` 绝不会画出一条落到 0 的线。
   - 同一条 `isNumber` 门也守在那根独立轴的量程上（`index.esm.js:1049-1055`）⇒ `null` 不进 min/max，缺口的存在不会把对比轴拽宽。这也是 §三 为什么「非有限值必须交 `null`、绝不能交 `0`」：`0` 在 `isValid` 与 `isNumber` 两道门上**都是合法数值**，会真画出来并把量程拽到 0。

**公开类型面已核对**（本片所有活体读数都走 `frontend/node_modules/klinecharts/dist/index.d.ts` 里有声明的方法，不碰未导出的内部件）：`createIndicator` `index.d.ts:1163`、`getIndicators` `index.d.ts:1164`、`createYAxis`/`removeYAxis`/`getYAxes` `index.d.ts:1168-1170`（`getYAxes` 的 `filter` 是**必填**形参，`index.d.ts:1154-1158` 只有 `paneId`/`id`/`name` 三个键）、`Axis.getRange()` `index.d.ts:672`、`YAxis extends Axis, Required<YAxisTemplate>` `index.d.ts:681-685` ⇒ 每根轴都带可读的 `id`，"哪根是默认轴"用 `id !== COMPARE_AXIS_ID` 判，不靠数组下标。绘图区宽度与轴控件的宽度用 `getSize(paneId, position)` `index.d.ts:1162`，`DomPosition = "root" | "main" | "yAxis"` `index.d.ts:1148`，返回的就是带 `width` 的 `Bounding` `index.d.ts:52-59`。

**轴归属只能在创建时定，注册时定不了**：注册面 `IndicatorTemplate` 把 `paneId`/`yAxisId` 一起 Omit 掉了（`index.d.ts:870`，`registerIndicator` 收的就是它，`index.d.ts:1232`），而创建面 `IndicatorCreate` 只 Omit `result`（`index.d.ts:871`）⇒ `createIndicator({name, paneId, yAxisId})` 传轴是**类型允许的公开用法**，不需要 any-cast，也不属于 patch 库。另两条公开形状：`IndicatorSeries = "normal" | "price" | "volume"`（`index.d.ts:714`，本片用 `"price"`）与 `IndicatorFigure` 的 `key` 必填、`title`/`type` 可选（`index.d.ts:738-745`）⇒ §四 那份 figures 声明能通过 `tsc`。

**为什么不用 `draw` 自绘**：`draw` 拿到的是裸 ctx，像素得自己算；一旦自绘，"不进主图轴"这件事就退化成"我们自己不去读那把尺"的**约定**，而不是 `index.esm.js:978` 那个集合过滤给的**结构保证**。本片要的正是结构保证。
**为什么不用 overlay**：第⑤片 §7.19 那条裁定继续成立——`serializeDrawings`／`restoreDrawings` 都不问工具名（`frontend/src/lib/chartDrawings.ts:400-412`、`frontend/src/lib/chartDrawings.ts:620`），只有导入／分享码那侧有 `toolOf` 白名单（`frontend/src/lib/drawingExchange.ts:121`）；把一条"序列"塞进画线落盘面会在每次 reload 重建进画线清单。

## 三、纯函数面（`frontend/src/lib/symbolCompare.ts`）

只有一个导出：

```
alignCloseToTimestamps(mainTimestamps: readonly number[], compare: readonly {timestamp: number, close: number}[]): (number | null)[]
```

语义：对第 `i` 根主图 bar，取对比序列里**最后一个 `timestamp <= mainTimestamps[i]`** 的根的 `close`；若连最早那根都比它晚 ⇒ `null`。

必须写进实现的三条口径，每条都有针：

1. **只向前看，绝不回填**（`agent/backtest/loaders/akshare_loader.py:246-253` 的那条 ffill-not-bfill 口径）。针：构造「主图首根早于对比首根」的向量，断言那几项是 `null` 而不是第一个已知值。
2. **并列取等号那侧**（`<=` 而非 `<`）。针：主图某根与对比某根时间戳**完全相等**时，必须取到那根的 close；把它改成 `<` 要能变红。
3. **逐根独立**：输出第 `i` 项只依赖 `mainTimestamps[i]` 与 `compare`，不依赖其它主图根。这条给出**前缀不变量**——对任意 `k`，`align(mainTs.slice(0,k)) === align(mainTs).slice(0,k)`。它是"没有未来函数"在纯函数面的判据形态，和第④片同款。

停牌／休市期间对比线会**平着走**（carry forward 的定义就是"最近已知价"），这是语义不是缺陷；跨多久都照 carry，**不设**"超过 N 天就断线"的参数（那是给假想的精确性加复杂度）。

`(number | null)[]` 这个形状**可以直接交给库**，不需要任何适配层——依据是 §二·8：`null` 在 `line` 图元上是双向缺口且不桥接、不掉基线，在那根独立轴的量程上被 `isNumber` 跳过。所以「主图已收盘、对比标的还没开盘」的左侧那段是真的没有线，而不是一条 0 线或一条被拉平的线。

输入契约：两个数组都按时间戳升序。`compare` 里 `close` **非有限或非正**（`> 0` 不成立）的根**跳过**（不进游标）。"非正"这一半不是可省的修饰：后端缺列时填的是 `0`（`frontend/src/lib/marketApi.ts:179-183`）而非 null，而 `0` 是**有限**的——只挡「非有限」的过滤器会把 0 原样放行，于是 §二·8 末尾那条就生效了：0 在 `isValid` 与 `isNumber` 两道门上**都是合法数值**，会真画出来并把那根独立轴的量程拽到 0。所以判据必须写成 `Number.isFinite(b.close) && b.close > 0`，这是本片**特有**的一条防御性判据，要专门一针。注意「跳过」的口径是**整根不进游标**（连时间戳一起丢），不是"到了那根就交 `null`"：后者会让一根坏 bar 把后面的好价格一起截断。代价登记在 §十二 R11（`close` 为负的标的会被整根当坏值——本池是股票/ETF/指数，为负不可达）。

## 四、库绑定面（`frontend/src/lib/symbolCompareChart.ts`）

- 注册名 `SYMBOL_COMPARE`，`shortName` 「对比」；`figures: [{key: "cmp", title: "对比收盘", type: "line"}]`（**不写 `styles`**；`type` 是 §二·8 那条分发钥匙，删掉它就得到一条静默不画的线）；`calc` 从本模块的会话级 store 取当前 key 的对比序列，`calc(dataList)` 用 `dataList` 的时间戳现算——**必须算在 `calc` 里**，因为任何一次分页加根都会带着**新的全量** `_dataList` 把所有指标全量重跑（`StoreImp.prototype._addData` 尾部 `index.esm.js:13501-13506`、`_calcIndicator` 传全量 `index.esm.js:14145`），而 `extendData` **不参与**重算判定（默认 `shouldUpdate` 里 `calc` 只由 `calcParams`/`figures`/`calc` 三件事决定，`index.esm.js:3167-3168`；`extendData` 只进 `draw` 那一档 `index.esm.js:3181`）。把对齐结果当外部闭包常量喂进来，滚到边界加载后必然错位。
- `calc` 的返回形状是 `{cmp: number | null}` 逐根一行，且**行数必须恰等于 `dataList.length`**：`createRangeImp` 与 `drawImp` 都按**绝对下标**取行（`index.esm.js:1048` `result[dataIndex] ?? {}`、`index.esm.js:8072-8074` 同形），少一行就等于在尾部静默丢一根。时间戳这一格不需要额外的非有限值分支——`columnsToBars` 的 `timestamp` 是 `sec * 1000`（`frontend/src/lib/marketApi.ts:178`），缺的是**整列**（`data.t ?? []`，`marketApi.ts:175`）而不是列里的 `null`，所以「主图时间戳不可用」在这一层不是一个可达的形状，不给它写校验。
- `paneId` 用现成常量 `MAIN_PANE_ID`（`frontend/src/lib/chartDrawings.ts:92`，值就是 `"candle_pane"`；`ProChart.tsx:63` 已经把它 import 进来了），不新造第二个字面量；`yAxisId: COMPARE_AXIS_ID`（模块导出的稳定常量字符串）。挂载只走 `createIndicator`，**不碰 `createYAxis`**（理由见 §二·2/4）。
- store：`setCompareSeries(key, bars)` / `getCompareSeries(key)` / `clearCompareSeries()`，key = **`${对比标的}|${周期}`**（不是主标的——主标的换了不影响这条序列，而周期换了必须重算，因为对齐是按主图时间戳做的）。`calc` 读的 `dataList` 是**主标的**的根，store 存的是**对比标的**的根，两边靠时间戳接；这个方向差异就是 §三 那条对齐定义本身，别在命名上把它抹平。`syncCompare(chart, active, key)` 挂载前先把收到的 `key` 记成 store 的 `activeKey`（`setActiveCompareKey(key)`），`calc` **只读 `activeKey`** ⇒ 不给指标传参：参数一旦走 `calcParams`，就撞上 `index.esm.js:3168` 那条 `JSON.stringify` 比较，等于把同一份状态存两处。`key` 由页面派生（见 §五），不从 store 里反查——反查就把"当前该用哪条序列"这个决定同时放到了两处。
- `syncCompare(chart, active, key)` 走第④⑤片同一套**先删后挂**，但**触发面比它们宽**：切对比标的、切周期、以及**对比序列本身到达**（首次取数成功，或失败/清空）这三种都必须重挂。第三种是新出现的——第④⑤片挂的是同一个 `dataList` 上的纯变换，而本片的 `calc` 读的是外部 store：`createIndicator` 只在挂载那一刻跑一次 `calc`，之后只有 `dataList` 变化（分页、`setPeriod`、`setSymbol`）会带着全量重跑它（`index.esm.js:13501-13506`）。若挂上去时 store 还是空的（按钮先点亮、数据后到），不重挂就得到一条**永远不存在**的线，而它只能在活体上被发现。⇒ 页面那条挂卸 effect 的依赖数组里必须有一格「随对比数据变身份」的东西（把承载序列的那份 state 本身列进去即可），不能只列 `cmpOn`/`timeShare`/key。
- **`syncCompare` 定义在 `frontend/src/pages/ProChart.tsx`，不在本模块**（§四 标题里的"库绑定面"只交三样东西：注册 + 偏好读写 + 会话级 store）。理由是本片既有分工：`syncHeikinAshi`（`frontend/src/pages/ProChart.tsx:999-1011`）与 `syncVpvr`（`frontend/src/pages/ProChart.tsx:1031-1043`）都长在页面里，而 `heikinAshiChart.ts`／`vpvrChart.ts` 都不 import `Chart` 类型——挂卸要读的是页面的 `chartRef`，把它搬进 lib 只会多出一条跨模块的 chart 句柄参数。因此本模块导出的挂载期输入只有三个纯件：`ensureCompareIndicator()`、`COMPARE_AXIS_ID`、`setActiveCompareKey(key)`，`syncCompare` 在页面里把它们串起来（先 `setActiveCompareKey`，再 `createIndicator`）。
- 偏好键 `pro-chart.compare.v1`，**值就是已应用的对比标的字符串**：`loadCompare(): string`（键缺失或 storage 抛 ⇒ `""`），`saveCompare(sym)` 非空时 `setItem(key, sym)`、空串时 `removeItem(key)`（未偏离默认不落盘，同 `frontend/src/lib/vpvrChart.ts:89-90` 的写侧纪律）。**开关态不另开第二个键**——「关」在这页的语义就是"没有对比标的"，所以缺键读出来即关，两者不可能各说一套；代价是关掉再打开会忘掉那个标的，因此 `cmpSymbol` 在**会话内**留着（关掉只删键、不清 `cmpSymbol`），同一趟浏览里再点一次不用重敲。读写形态照 `frontend/src/lib/vpvrChart.ts:53`、`frontend/src/lib/vpvrChart.ts:80`、`frontend/src/lib/vpvrChart.ts:89-90`。

## 五、取数面（`ProChart.tsx`）

- 一次 `fetchKline({symbol: cmpSymbol, interval, count: COMPARE_BARS, signal})`，`COMPARE_BARS = 2000`：后端把 `countback` **静默钳**到 `_MAX_BARS = 2000`（`agent/src/api/udf_routes.py:473-474`、`agent/src/api/market_routes.py:52`），所以 2000 就是一次取满的深度上限；不传 `before`（要最新窗口），不传 `session`。
- **必须继续走 `fetchKline`**，不许手写 `fetch`：鉴权头（`frontend/src/lib/marketApi.ts:244-247` → `frontend/src/lib/apiAuth.ts:18-21`）、秒↔毫秒的唯一换算位（`marketApi.ts:177-184`）、以及「HTTP 200 里装 `s:"error"`」这条协议怪癖（`marketApi.ts:252-259`）都在它里面各只有一份。桌面宿主另有覆盖式注入（`desktop/electron/src/main.ts:88-98`），但那**不能**当作"漏带头也没事"的依据——浏览器侧没有它。
- 独立 `try/catch`，**绝不**与主序列 `Promise.all`：失败只丢叠加层并把原因显示出来（降级形状与 `indicatorLang.ts:1124-1127` 的静默降级不同，这里**要**报，因为那条 errmsg 是用户区分「重启 OpenD」和「查不存在的网络故障」的唯一线索——`marketApi.ts:253-257` 原文理由）。`no_data` 是 `bars: []` 不是错误（`marketApi.ts:260`）。
- 并发就是 1，不引池；`AbortSignal` 在重切／卸载／换周期时 abort，并按 key 去重防 StrictMode 双挂载重复请求。仓内已有同款形状可照抄：模块级 `Set` 在请求前 `has(key)` 就 `return`、否则 `add(key)`、`finally` 里 `delete(key)`（`frontend/src/lib/indicatorLang.ts:1116-1118` 与 `frontend/src/lib/indicatorLang.ts:1128`）。**照抄时要补一笔**：那件是 calc 路径、没有 effect cleanup，本片有 ⇒ cleanup 里 abort 的同一行必须把键也删掉（R13），否则 StrictMode 的第二次挂载会跳过一次已经作废的请求。**不要**拿 `frontend/src/lib/mtfSync.ts:240-253` 的 `createApplyGate` 当这个闸——它是同步重入深度闸（`depth += 1`／`finally { depth -= 1 }`），拦不住跨两次挂载的异步在飞请求。
- **计量风险已读实**：`/history` 这条路上**没有**任何按 symbol 的计数器、没有 429、没有内存缓存或 TTL（`agent/api_server.py:183-185` 三个 middleware 都不是限流器；唯一的 `_SlidingWindowRateLimiter` 只挂两条相关系数路（`/correlation` 与 `/correlation/regime`），`agent/src/api/system_routes.py:62-129`、`agent/src/api/system_routes.py:288`、`agent/src/api/system_routes.py:332`）。真正的串行化在上游：所有 akshare/Sina 调用被 `_sina_lock` + `_run_sina` 钉在**同一条复用工线程**上（`agent/src/api/market_routes.py:103-129`），loader 链本身也明确不是线程安全的（`agent/src/api/market_routes.py:723-733`）。⇒ 第二个请求最多**等**第一个，不会打爆，也不会变快。
- **复权口径必须诚实**：日/周/月线的 `adjust` 是**死参数**——`_kline_sync`（`market_routes.py:631-661`）只把它透给分钟线（`agent/src/api/market_routes.py:639`、`agent/src/api/market_routes.py:646`），`1W/1M` 走 `_fetch_calendar_bars(symbol, interval, count, before)`（`agent/src/api/market_routes.py:654`）、`1D` 走 `_fetch_daily(symbol, count, before)`（`agent/src/api/market_routes.py:661`），**签名里没有这个参数**。日线实际口径由服务它的 loader 决定，且 `split_dividend_additive` 与 `split_dividend` **不是同一把尺**（`agent/backtest/loaders/registry.py:308-357`、`agent/backtest/loaders/registry.py:386-391`），而 `caliber` **完全不回传**（`agent/src/api/udf_routes.py:589` 只回 `source`；`frontend/src` grep `caliber` = 0）。⇒ 裁定：两个标的共用 `fetchKline` 的同一个默认 `adjust`（`marketApi.ts:94`、`marketApi.ts:241`），**不给对比标的单独选复权档**；把两个 `source` 字符串显示在按钮旁边（`frontend/src/lib/marketApi.ts:265` 真回传的东西，不是我们造的精度）。

## 六、视图互斥与共存

- **分时态必须卸下载入**：分时是单日的**分钟**线，而分钟时间戳跨市场不可比——`agent/src/api/market_routes.py:132-149` 的 `_MINUTE_WALL_CLOCK_ZONE` 只有 SH／SZ／HK／US 四个表项，分时那条 `session=latest` 分支遇到无表项后缀直接抛 `ValueError`（`agent/src/api/market_routes.py:669-676`，注释写明「有分钟通路、无钟点表项」才走到这里），加密根本没有表项。日线侧可比是因为两边都是「交易日标签的 naive 午夜」（`agent/src/api/market_routes.py:186-199` + `agent/src/api/udf_routes.py:41-43`）。⇒ 复用第⑤片那对 `xxxActive(on, timeShare)` 纯谓词的形状，新增 `compareActive(on, timeShare, ready)`。
- **与 HA／VPVR 共存**：三者都是蜡烛 pane 的指标，量程各归各（`index.esm.js:978` 的集合过滤保证互不串）。回归面要能证明"再加一个对比"不动主图默认轴量程（§十·④）。
- **Bar Replay**：回放游标是库层面的 `dataList` 截断，`calc` 只看到前缀 ⇒ 天然不重绘；但**不许**在回放中触发对比取数（回放态输入框仍可改，取数走正常路径）。五步自查见 §十·⑤。

## 七、UI 与文案（硬编码中文，不新增 locale 键）

工具栏第二行「量分布」之后加：一个对比标的输入框（placeholder `对比标的`）＋ 一个「对比」按钮 ＋ 一个只在有值时出现的数据源小字（两个 `source`）。

按钮 `title` 五支，**逐字钉**（判据见 §十·⑥）：

1. 分时态：`跨市场的分钟时刻不在同一把尺上，分时视图看不了对比，先切回蜡烛`
2. 没有已应用标的：`先在左边输入对比标的（如 600036.SH 或 BTC-USDT），点它才叠到主图`
3. 数据未就绪（loading 与 error 共用）：`对比标的的数据还没到位，原因看输入框那行的提示`
4. 已开：`对比已开：把可视区间同一把时间轴上的 <cmp> 收盘画成折线，用它自己那根右侧标尺，不进主图价格轴（再点切回）`
5. 已关：`对比已关：点开把 <cmp> 的收盘叠到主图，走独立标尺、不改主图价格轴`

输入框 `title`：失败时是 `原因：<errmsg 原文>`（errmsg 由后端自己给，见 §五），否则是那句定稿说明。

五支的**判别顺序**是设计的一部分，不是实现细节：分时 → 没有已应用标的 → **已开但数据未就绪**（`cmpOn && (loading || error || !ready)`）→ 已开 → 已关。第 3 支必须排在 4/5 **之前**——它排在后面就永远读不到，因为「已开但没数据」这一格里 `cmpOn` 已经为真；那正是本片唯一会把"进行中"说成"已完成"的形状。`aria-pressed` 与 className 走 `compareActive(cmpOn, timeShare, cmpReady)` 这**一枚**谓词（未就绪时按钮不亮，说的是"图上现在没有对比线"这件事实），而 `title` 的第 4/5 支问的是裸 `cmpOn`（偏好态），与第④⑤片那两颗按钮「三处表达式三种问法」的分工同形。

## 八、不做的事（范围钉）

不新增依赖；不 patch 库；不新增环境变量；不新增 locale 键；**不写任何样式键**、不碰 `chartStyles` 合成点；不动 `multi-chart`／`ChartCell.tsx`；不动后端一行；不做「百分比归一轴」（那是第二条通道，见 §十一·6）；不做对比标的的实时推送；不做多标的（先做一个，`N>1` 的轴排布与量程语义本片不裁决）。

## 九、门禁

`tsc --noEmit` rc=0、全量 `vitest run` rc=0（条数**由执行席当场测**，不引用本文档的任何数字）、`vite build` rc=0、`python -X utf8 -m pytest tools/test_wiki_drift.py -q`、水位门与 `ci_grep_gates.sh` 两道恒红门：**先证本片贡献归属再报告，不许调阈值、不许改档案让门变绿**。新写的一切件不复述门自己打印的那句 FAIL 文案。

## 十、验收判据

- **① jsdom 声明面**：`createIndicator` 被调时 `paneId === "candle_pane"`、`yAxisId === COMPARE_AXIS_ID`、`series === "price"`、`figures` 恰一条且带 `title`；`createYAxis` **零调用**（这条正是"不建 manual 轴"的结构钉）。注册对象那一侧另钉一格 `figures[0].type === "line"` **逐字** `toBe`——判的是 `registerIndicator` 收到的那份字面量（形状照第⑤片 `vpvrChart.test.ts` 钉 `precision` 的那格）：§二·8 说省略 `type` 会得到一条**静默不画**的线，而这种失效在 jsdom 与活体像素上都读不出来，只能钉声明。
- **② 纯函数面**：手算向量 + 前缀不变量 + 三根下毒针（`<=`、拒绝 bfill、坏值跳过——坏值按 §三 的判据是「非有限**或**非正」，所以针要同时喂 `0`／负数／`NaN`，只喂 `NaN` 的那支挡不住 R11 说的那半个）。
- **②b 重挂面**（§四 那条宽触发面的判据）：点亮开关、数据还没到手 ⇒ `compareActive` 为假、**一次都不挂**（§六 那枚谓词的第三个入参就是 ready，未就绪不挂是它的定义）；再把序列喂进 store 并让承载它的那格 state 变身份 ⇒ 这一次**必须**挂上，且挂载之后 `calc` 对同一份 `dataList` 交出的行里**有非 null 值**。**按 §十 起草时的原句这里写的是「先挂上一次、再 remove＋create 一次」——两处都改：ready 门使第一次不成立，而判据的牙没丢**：依赖数组只写 `cmpOn`/`timeShare`/key 的实现，在数据到达那一轮根本不会重跑，于是开关亮着而线永远不存在——正是 R10 的失效形状，这条针照样抓得住它。
- **③ 卸载面**：切走对比后 `chart.getIndicators()` 不含 `SYMBOL_COMPARE`，且 `getYAxes({paneId:'candle_pane'})` 回到**恰 1 根**轴（这条同时覆盖 §二·4 的孤儿回收与"没有漏轴"）。
- **④ 活体面**：开对比前后，`getYAxes({paneId:'candle_pane'})` 里 `id !== COMPARE_AXIS_ID` 那根（默认轴）的 `getRange()` **逐字相同**＝主图量程不受叠加影响的那条不变量；绘图区宽度用 `getSize("candle_pane", "main").width` 读，开了对比后**必然变小**（多了一条右外列，属预期），关掉要**回到开前的像素值**——这一条就是 §二·5「会不会留死空白」的活体背书，读数当场登记。新轴那把尺的读数有确定期望，**不是"等于 min/max"**：`createRangeImp` 的折叠域是 `getVisibleRangeDataList()`（`index.esm.js:1023`），所以它折的是**可视区**那些行的非 null 对齐 close（平移/缩放会变，属预期）；读完 min/max 之后还要过 `index.esm.js:1104-1107` 的留白率——那根轴由 `index.esm.js:15244` 从 `getLayoutOptions().yAxis` 摊出来，出厂 `gap: {top: 0.2, bottom: 0.1}`（`index.esm.js:13266-13269`），而率只在 `>= 1` 时才除高度（`index.esm.js:1096-1103`），两个出厂值都 <1 ⇒ 不除；线性轴下 `from`/`to` 就是 `realFrom`/`realTo` ⇒ 期望 **`from == min - 0.1*(max-min)`、`to == max + 0.2*(max-min)`**，`gap` 本身从 `axis.gap` 现读（`index.d.ts:666-685` 的 `Required<YAxisTemplate>` 带着它），不写死。若仍无可见表面（第⑤片遇过的情形），按同一降级形态：判据落在**公开读数**（`getRange()`/`getSize()`/`getIndicators()[0].result`）与库的调用面上，像素色值与"屏幕上真有没有那条线"登记为**未判**，不假称已验。
- **⑤ 未来函数自查**：Bar Replay 五步（进／`后一根`×6／`前一根`×1／退出）逐格对齐；对比序列的 `getRange()` 全程不因游标前进而引用游标右侧的根。
- **⑥ 文案面**：五支 title 逐字 `toBe`，参照点是页面字面量，不是测试自造的第二份权威。

## 十一、遗留（登记为限制，不是待修）

1. 只支持一个对比标的；`N>1` 时右侧列宽与 `index.esm.js:14890-14901` 的列序语义本片未读。
2. 低价标的（如 0.00x 的币）刻度与图例读数会被本页既有的 `pricePrecision: 2`（`frontend/src/pages/ProChart.tsx:1319`）压成 `0.00`——这是**本页出厂**就有的精度约定，本片继承而未新增第二套规则。
3. 对比序列的最后一根若是正在形成的当日 bar，**不会**实时刷新（无推送通道），线上会停一次；主图那侧有 `subscribeBar`，这是不对称的已知代价。
4. 两标的的日线复权口径可能不同尺（加法扣息 vs 乘法，`agent/backtest/loaders/registry.py:386-391`），UI 只能给出两个 `source` 字符串，无法证明可比性。
5. 取数深度上限 2000 根且不回传截断标记（`agent/src/api/udf_routes.py:473-474`）⇒ 主图滚得比 2000 根更早时，对比线左端从某根开始，其余为 `null`。
6. 「百分比归一轴」（TV 把整条轴切成 Percentage 的那种对比）没做，它是**第二条通道**：要么改轴的 `createRange`/`createTicks` 钩子（`index.esm.js:1066-1082`、`index.d.ts:658-659`），要么自绘标尺——都需要重读一遍轴内部，本片刻意不碰。

## 十二、裁定台账

- **R1 通道**：`createIndicator({paneId:'candle_pane', yAxisId})`，不用 `createYAxis`、不用 `draw`、不用 overlay —— 理由：`index.esm.js:978` 的集合过滤给结构保证，而 `createYAxis` 的 manual 标记会把蜡烛撑进新尺（`index.esm.js:15483`+`index.esm.js:980-983`）且孤儿回收会跳过它（`index.esm.js:15234`）—— 错了代价：主图轴被污染或漏一根轴，两者都能被 §十·①③ 抓住。
- **R2 对齐**：ffill-not-bfill，逐根独立，`null` 表示"尚未有价" —— 理由：`akshare_loader.py:246-253` 的同一口径 —— 错了代价：未来函数，Bar Replay 会重绘。
- **R3 分时禁用** —— 理由：分钟时间戳跨市场不可比（`agent/src/api/market_routes.py:132-149`、`agent/src/api/market_routes.py:669-676`）—— 错了代价：叠出一条错位且无法解释的线。
- **R4 不给对比标的单独选复权档，只显示 `source`** —— 理由：日线 `adjust` 是死参数（`agent/src/api/market_routes.py:654`、`agent/src/api/market_routes.py:661`）且 caliber 不回传 —— 错了代价：印出不可比的两条尺还自称可比（造假精度）。
- **R5 失败要报、空不算失败** —— 理由：那条 errmsg 是用户排障的唯一线索（`marketApi.ts:253-257`），而 `no_data`→`bars: []` 是正常形状（`marketApi.ts:260`）—— 错了代价：静默吞掉一条能定位的错误。
- **R6 精度继承 `series:"price"` 不估小数位** —— 理由：本页已有唯一精度约定 `frontend/src/pages/ProChart.tsx:1319`，`index.esm.js:14221` 那条同步通道是库给的 —— 错了代价：多出一套没人维护的精度规则。
- **R7 对齐必须算在 `calc` 里** —— 理由：`index.esm.js:13501-13506`/`index.esm.js:14145` 每次加分页都全量重跑、`extendData` 不触发重算（`index.esm.js:3167-3168`、`index.esm.js:3181`）—— 错了代价：滚到边界加载后线整体错位，且只有活体能发现。
- **R8 缺口交给库的 `null` 语义，不自绘、不桥接** —— 理由：`index.esm.js:8095`+`index.esm.js:8137` 让 `null` 成为双向缺口，`index.esm.js:8174-8175` 保证缺口不被跨过，`index.esm.js:8114-8131` 那套 `baseValue` 只属于 `bar`/`rect` 所以不会掉到基线 —— 错了代价：若哪天改成"用前值桥接"或走 `draw` 自绘，「主图有 bar 而对比没有」会被画成一条不该存在的连线，而这条线在活体上和真数据无法区分。
- **R9 一个偏好键，值即已应用标的，缺键即关** —— 理由：这页「关」的语义就是没有对比标的，把开关与标的存两处必然出现"键说开着、标的却是空"的第三种状态 —— 错了代价：reload 后读出一个既无标的又亮着的开关，而 §七 的五支 title 没有一支描述那种形状。会话内 `cmpSymbol` 不清，代价只是"关掉再开要重敲"这一条，已写在 §四。
- **R10 对比数据到达要触发重挂** —— 理由：`calc` 只在挂载与 `dataList` 变化时跑（`index.esm.js:13501-13506`），而本片的输入有一半在 store 里 —— 错了代价：开关先点亮、数据后到时线永远不出现，且这条只能在活体上看见，所以配了 §十·②b 那条 jsdom 判据。
- **R11 坏值判据写成「非有限或非正」，并把它登记为代价** —— 理由：§三 要防的那个坏值是后端补的 `0`，而 `0` 有限，所以只挡非有限的过滤器挡不住它 —— 错了代价：漏掉"非正"这一半，后端缺列的对比标的会拖出一条 0 线并把独立轴量程拽到 0（§二·8 末条）；带上"非正"这一半的代价是真实负价标的（商品期货连续合约）会被整根当坏值丢弃，而 `/pro-chart` 的标的池是股票/ETF/指数，`close` 为负不是一个可达形状，所以按「不为不可达场景加校验」的口径这条判据不再细分。
- **R12 `syncCompare` 定义在页面，本模块只交注册＋偏好＋store** —— 理由：与第④⑤片既有分工一致（`syncHeikinAshi` `ProChart.tsx:999-1011`、`syncVpvr` `ProChart.tsx:1031-1043`，两个 lib 模块都不 import `Chart` 类型）—— 错了代价：把页面的 `chartRef` 搬进 lib 只是多出一条跨模块句柄参数，且 lib 面变得需要 chart 替身才能测。
- **R13 取数 effect 的 cleanup 里 abort 与删在飞键两件事都要做** —— 理由：§五 引的那个形状（`indicatorLang.ts:1116-1118` 判键、`indicatorLang.ts:1128` `finally` 删键）本身没有 effect cleanup，所以不带这个坑；照搬到 effect 里、只在 `finally` 删键，StrictMode 的第二次挂载会看见键还在 ⇒ 跳过，而第一次的请求已被自己 abort 掉、永远不会交付，于是对比数据到不了页面 —— 错了代价：dev 下一次挂载发出两个请求（第二个完成、第一个被取消；§五 已读实后端只是排队，不会打爆），换来的是「数据必然到手」。
