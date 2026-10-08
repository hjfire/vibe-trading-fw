# Heikin-Ashi（平均K线）显示层 设计（推荐清单第 ④ 片）

**日期：** 2026-10-08
**状态：** 已裁定，待实现
**基线：** `main` = `f32ece61`（①②③ 片已全部合入并推送，CI 九条腿全绿）
**范围：** 对比 TradingView 后推荐顺序里的第 ④ 项。①（Pine 告警桥）§7.13、②（Bar Replay）§7.14、
③（画线＋磁吸＋图例）§7.15 已交付。本片只做**主图蜡烛的显示层变换**：数据面、后端、下单面一律不碰。

## 一、要解决的问题

TV 的图表类型选择器里，`Heikin Ashi` 是使用率最高的一档：它把每根 K 线换成
`haClose=(O+H+L+C)/4`、`haOpen=(上一根 haOpen+上一根 haClose)/2` 的平滑蜡烛，用来
**滤掉单根噪音、把趋势段读成连续色块**。本项目主图只有库内置的六种 `CandleType`
（实体/空心/ohlc 刻度/面积），没有任何形式的 HA：

- 读趋势要肉眼在噪音里找段；
- 想验证策略文本里的 `heikinashi` 语义，图上没有可对照的画法；
- 与 ② 片 Bar Replay 配合时，逐根走出来的噪音蜡烛比 TV 更难读。

本片把 HA 做成**一个开关**：开＝主图改画平均K线，关＝原样。核心裁定是
**它只改像素，不改数据**（理由见§三、§五）。

## 二、决定性事实（本轮盘面核实，带坐标）

1. **库里没有 heikinashi 蜡烛类型。** `CandleType` 是闭联合六值：
   `"candle_solid" | "candle_stroke" | "candle_up_stroke" | "candle_down_stroke" | "ohlc" | "area"`
   （`frontend/node_modules/klinecharts/dist/index.d.ts:409`）。全库 `grep -o "heikin"` 零命中
   ⇒ 想要 HA 只能自己画，不能靠改 `candle.type` 实现。

2. **指标可以完全接管主图绘制。** `IndicatorView.prototype.drawImp`
   （`dist/index.esm.js:8028`）对每个可见指标先问 `indicator.draw`，
   **返回 `true` 即 `isCover`，默认图元绘制整段跳过**。仓内此前从没用过 `draw:`
   （grep `draw:` 在 `frontend/src/**` 零命中）——这是本片要走的新通道，也是库的公开通道。

3. **y 轴范围会把主图指标的 figure 数值并进去。** `YAxisImp.prototype.createRangeImp`
   （`dist/index.esm.js:984`）先按可见区间取真实 `data.high/data.low`，随后
   **对每个指标的每个 `figure.key` 取 `result[dataIndex][figure.key]`，是数字就 `min/max` 并入**。
   本仓已在昨收线的注释里引用过同一机制（`frontend/src/lib/timeShare.ts:331-335`：
   "a registered indicator on the price pane participates in the pane's y-range"）。
   ⇒ **HA 的四价作 figure key，画再高/再低都不会被裁掉**；反过来是一条硬约束：
   **像素量绝不能进 `result`**（会被当价格折进 y 轴，价格标尺当场被像素数污染）。

4. **缺口边界样本（这就是必须依赖上面第 3 条的原因）。** 实测两组 bar：

   ```
   bars = [(10,20,10,20), (1,2,1,2)]        # (O,H,L,C)
   ha   = [(15.0,20,10,15.0), (15.0,15.0,1,1.5)]
   ```

   第二根真实区间是 `[1,2]`，但它的 `haOpen` 继承上一根的 `15` ⇒ `haHigh=15`。
   若上一根已被滚出可视区，只按真实价算轴范围就会把 HA 实体画到**顶边之外**。

5. **`figures[].type` 是实践必填，不是类型必填。** `prepareIndicatorFigures`
   （`dist/index.esm.js:3081`）只在 `isValid(figure.type)` 时保留图元；缺 `type`
   会让线**和图例**一起消失而公式照算。本仓已在 `timeShare.ts:309-312` 记下同一个坑。

5b. **图例行数由 `figures` 决定，不是由 `draw` 决定。** 主图每个挂载实例按 figure 出一行
   （`ProChart.tsx:921-923` 记的"一次点击堆出一墙 `MA(5,10,30,60)`"就是同一机制的另一面），
   而 `IndicatorView.drawImp` 接管绘制（第 2 条）**并不会**接管 tooltip 行。
   ⇒ HA 只声明 **`high`/`low` 两个** figure（够折 y 轴，见下），四价读数由
   `createTooltipDataSource` 合成**一行**输出。
   为什么两键就够：`haHigh = max(H, haOpen, haClose) ≥ {haOpen, haClose}`，
   `haLow = min(L, haOpen, haClose) ≤ {haOpen, haClose}` ⇒ 高低价天然包络开收，
   再声明开/收两个键只会多两行图例，不会多护一寸轴范围。

6. **主图样式只有一个合成点。** `chartStyles(dark, timeShare, legend)`
   （`frontend/src/pages/ProChart.tsx:277-332`）；`:285` 定 `candle.type`，
   `:290` 合成 legend 片段，`:294-298` 写明顺序契约（**片段先摊、本函数自己的键在后**，
   因为片段只写 `tooltip`/`priceMark`，本函数写 `type`/`bar`/`area`，两棵子树不撞）。
   推送点只有两处：`init({styles})`（`:1010`，effect 依赖 `[]`）与主题 effect
   （`:1272-1274`，`setStyles(chartStyles(...))`，依赖 `[dark, timeShare, legend]`）。
   ⇒ **HA 的开关必须同时进 `chartStyles` 形参表和这个依赖数组**；漏进依赖数组的后果
   是文件里已写死的历史故障（切主题把上一个状态冲掉，"开关像坏了"）。

7. **隐藏原生蜡烛的通道是 `candle.bar` 的六个色键。** `CandleBarColor`
   （`index.d.ts`）含 `upColor/downColor/noChangeColor` ＋ `upBorderColor/downBorderColor/noChangeBorderColor`
   ＋ `upWickColor/downWickColor/noChangeWickColor`；仓内在 `ProChart.tsx:301-311` 已经
   从 `lib/chartPalette.ts:10-14` 的 `CANDLE_COLORS`（红涨绿跌）取色。
   ⇒ HA 开启时把这九色推成 `transparent`，`candle.type` **保持 `candle_solid` 不动**
   （`type` 那个键是分时开关的，抢它会破坏第 6 条的顺序契约）。
   **`priceMark` 一侧一个字都不写**：那棵子树归图例偏好面板所有
   （`chartLegend.ts:109-115` 按 `p.highLowMark` 写 high/low、按 `p.lastPriceLine` 写 last 三键），
   HA 侧写 `priceMark` 会静默覆盖用户自己的"高低价标记"开关——正是 `:294-298` 那条
   顺序注释警告的越权。开着 HA 时高低点标记继续标**真实**高低，这是诚实读数不是残留。

8. **主图 paneId 是 `"candle_pane"` 字面量，已有常量。** `MAIN_PANE_ID`
   （`frontend/src/lib/chartDrawings.ts:92`）。防重复堆叠的现成写法是
   `syncPriceOverlay`（`ProChart.tsx:927-945`：先 `removeIndicator({name})` 再在
   `live.length === 0` 时 `createIndicator({name, paneId: MAIN_PANE_ID}, true)`，
   多个同名时保留第一个删余）。`createIndicator` 非幂等的原因记在 `:915-925`。

9. **布尔偏好的最省先例是磁吸。** 键形 `pro-chart.<feature>.v1`
   （`chartDrawings.ts:1028` `MAGNET_KEY = "pro-chart.magnet.v1"`，读写在 `:1026-1045`），
   `lib/storage.ts` 只有 `safeGet/Set/Remove`，**没有键表也没有版本迁移**，
   唯一升版先例是 `indicatorStore.ts:13`（注释解释弃用，不写迁移码）。

10. **分时判据与互斥按钮写法。** "当前是不是分时"读 `viewRef.current.timeShare`
    （`:888/:1038/:1352/:1538` 四处同读）；周期合法性谓词是
    `intervalAllowed(symbol, interval)`（`frontend/src/lib/chartView.ts:34-36`，
    `repairInterval` 在 `:39-41`）；工具栏的 `disabled`＋`reason` 形状照
    `ProChart.tsx:2225-2232`（分时/无 bar 两种理由），按钮本体形状照磁吸
    `:2284-2300`（`aria-pressed` ＋ 一句诚实 `title`）。

11. **HA 数学是因果的。** `haClose` 只用当根四价，`haOpen` 只用**上一根**的 HA 值，
    `haHigh/haLow` 只取当根 `H/L` 与当根 HA 开收的极值 ⇒ 前缀不变量成立。
    40 根随机序列实测 `ha(bars[:k]) === ha(bars)[:k]` 对 `k=1..40` 全等。
    现成 harness 是 `lib/__tests__/pinePrefixInvariance.test.ts`
    （`:129` 全量作 reference、`:145-146` 逐 `n` 跑前缀、`:156` 长度必 `=== n`、
    `:157-161` 与 `reference.slice(0,n)` 比且 mismatch 必 null、`:173` `worst===0`）。

12. **`/multi-chart` 的格子有独立样式链。** `components/charts/ChartCell.tsx:58-97`
    （`:65` 硬编码 `candle_solid`），与 ProChart 不共享 `chartStyles`
    ⇒ 本片不动多图页，HA 只在 `/pro-chart` 生效（§九）。

## 三、三个候选与裁定

**A. 显示层指标接管主图绘制（选）。** 注册一个挂在 `candle_pane` 上的指标：`calc` 产出
每根 `{open,high,low,close}` 四个**价格空间**的数，`draw` 用 `CANDLE_COLORS` 画实体＋影线并返回
`true` 接管绘制；同时把 `candle.bar` 九色推成 `transparent`。真实四价一个字节都不改。
代价：新增一条仓内没走过的 `draw:` 通道；九色与主题的交互要靠合成点纪律兜住。

**B. 在 DataLoader 出口把喂给图表的四价改写为 HA（否）。** 表面更"像 TV"（连 MA 都跟着变），
但它会同时污染**每一个下游读数**：图例、十字光标、最新价标记、磁吸落点、Pine `calc`、
画线价位、分享码/导入导出、回测下单量。而这些地方全都假定自己拿的是真实成交价
（§五逐条列了坐标）。把显示选择写进数据面，等于让一张图的读法去改写全仓的价格真值。

**C. 走 overlay 图元通道（`registerFigure`＋`registerOverlay`，⑤ VPVR 的路）（否）。**
overlay 是"用户落点＋事件命中"的可交互图元，按点数组存活；HA 是**随数据全长重算、
每帧重画、不可选中不可删除**的序列显示。用 overlay 表达它，就要为每根 bar 造一条
overlay 或维护一条全长折线型 overlay，并且必然落进画线存储的键空间（`pro-chart.drawings.*`），
与③片的交换面纠缠。`draw:` 是同类需求（分时面积线已经用 `series:"price"` 走指标通道）的正解。

## 四、分层

```
lib/heikinAshi.ts          纯数学：heikinAshi(bars) -> HaBar[]，无库依赖，可单测
lib/heikinAshiChart.ts     库绑定：名字常量、ensureHeikinAshiIndicator() 注册守卫、
                           calc／draw（实体＋影线，返回 true）／createTooltipDataSource（一行四价）、
                           颜色取 CANDLE_COLORS、CANDLE_HIDDEN 透明九色
pages/ProChart.tsx         chartStyles 增 `ha` 形参并写进主题 effect 依赖；
                           开关状态＋偏好读写＋挂卸指标；工具栏按钮与分时互斥 disable
```

状态流：`haOn`（`useState`，初值读 `pro-chart.heikin-ashi.v1`）
→ 一个 effect 按 `haOn && !timeShare` 决定 `createIndicator`/`removeIndicator`
→ `chartStyles(dark, timeShare, legend, haOn)` 决定九色是否透明
→ 写偏好只在用户点击处。

## 五、真值边界：HA 开着时，谁必须继续读真实价

| 读数 | 位置 | 开着 HA 时的值 |
|---|---|---|
| 左上角图例 开/高/低/收/涨跌 | `lib/chartLegend.ts:76-90`（模板由 `:105-119` 片段推入） | **真实价**，不动 |
| 主图新增一行「平均K线 开/高/低/收」 | `heikinAshiChart` 的 `createTooltipDataSource`（一行四值），`shortName: "平均K线"` | **HA 值**，行名直接写明是平均K线，不与真实价图例混读 |
| 高/低/最新价标记 `priceMark` | 库默认，本仓不改 | **真实价**（最后那根的尺，留真值比留变换值诚实） |
| 十字光标、磁吸落点 | `chartDrawings.ts:1020-1026` | **真实 OHLC 四价** |
| Pine 脚本 `calc`/`plotcandle` | `indicatorLang.ts:1031-1045/:1187-1196`、`pineDrawings.ts:162-165` | **真实四价** |
| 画线锚点与价位文案 | `chartDrawings.ts:339-342`（按 timestamp）、`:860-866` | **真实价**，且开关切换不重锚 |
| 分享码/导入导出 bundle | `drawingExchange.ts` | **不含 HA 状态**（偏好是本机视图态，不进交换面） |
| 分时均价与涨跌幅 | `timeShare.ts` `averagePriceSeries`/changeRatio | 分时下 HA 恒关（§六），不存在双读法 |

一句话：**HA 改像素，不改数据。** 这条边界要能被测试钉住（§七第 4 条）。

## 六、错误处理与边界

- **空列表 / 单根**：`heikinAshi([])` 返回 `[]`；单根的 `haOpen=(O+C)/2`（首根播种），
  此时 `haHigh/haLow` 由当根 `H/L` 与开收极值决定，必落在真实区间之内。
- **na/非数字**：任一价不是有限数 ⇒ 该根输出 `{}`（空对象），照 `timeShare.ts:296-299`
  的"未知基准返回无键行而不是空数组"先例；库的 range fold 只认 `isNumber`，空对象自然跳过。
- **颜色判定**：`haClose > haOpen` 涨色、`<` 跌色、`==` 无变色（照 `CANDLE_COLORS.noChange`）。
  A 股红涨绿跌，绝不在此处重定义颜色。
- **切换时机**：开→关 必须 `removeIndicator` 并恢复九色；关→开 必须先 `removeIndicator({name})`
  再 `createIndicator(..., true)`（第 8 条的先删后挂写法）。`removeIndicator` 找不到时不报错。
- **分时**：`timeShare` 为真时 HA **强制关**（面积图上没有蜡烛可换；分时视图的 `candle.type`
  是 `"area"`，第 6 条的 `type` 键归分时所有）。按钮 `disabled` ＋ `reason`
  "分时是面积线，没有蜡烛可换成平均K线"。
- **Bar Replay**：回放喂进去的永远是前缀（`barReplay.ts:69-73`），HA 按前缀重算 ⇒ 与真实
  历史一致，不需要任何特判；但**必须有测试证明**这条（§七第 3 条）。
- **零 bar / 后端未起**：按钮 `disabled`＋reason，照 `:2229-2231`。

## 七、测试与验收

1. **纯数学单测**（`lib/__tests__/heikinAshi.test.ts`）：
   - §二·4 的缺口向量逐值钉（`haOpen=15` 那根是 y 轴折叠存在的理由）；
   - 平盘/单根/空表/na 四种边界；
   - **前缀不变量**照 `pinePrefixInvariance.test.ts` 的形状：全量作 reference、
     逐 `n` 跑前缀、长度必 `=== n`、`mismatch` 必 `null`、`worst === 0`；
     探针数（`probes`）要断言"实际比了几个"，不许以空集合真空通过。
2. **模板单测**（同文件内或 `heikinAshiChart.test.ts`）：用仓内既有的
   `vi.mock("klinecharts", () => ({ registerIndicator: (spec) => registered.push(spec) }))`
   捕获注册对象，断言五件事：
   - `series === "price"`；
   - **`figures` 恰为 `high`/`low` 两个键**（第 5b 条：两键已是完整包络，多声明开/收只多图例行、
     不多护一寸轴）——这条同时是"轴范围 ＝ 可视真实高低 ∪ HA 高低"的可测等价形式，
     因为 `createRangeImp` 的折叠面就是 `figures[].key` 的集合；
   - 每个 figure **都有 `type`**（第 5 条的坑：缺 `type` 的 figure 会同时从图和图例静默消失）；
   - `calc` 出的每行键**只允许** `{open,high,low,close}`（像素量混进 result 就直接失败——第 3 条硬约束），
     缺口向量里第二根的 `high === 15` 而真实 `high === 2`；
   - `draw` 在假 ctx 上**按传入区间每根画一个实体＋一根影线**，且**返回 `true`**
     （返回 false 会让默认图元跟着画一遍，是要钉的判据）；
     `createTooltipDataSource` 返回的 `legends` **恰一行**且含四价、行名写「平均K线」。
3. **回放一致性**：`pages/__tests__/ProChart*` 同型 harness 里，回放游标推进后
   `calc` 拿到的 `dataList` 是前缀，HA 输出必等于全量输出的同长前缀。
4. **真值边界钉**：开着 HA 时，图例模板、磁吸落点、画线锚点三处读到的仍是真实价
   （各自已有测试文件里加断言或新文件，判据是 `getDataList()` 未被改写）。
5. **样式合成点回归钉**：开 HA → `setStyles` 最后一推里九色透明**且** `type` 仍是
   `candle_solid`；再切主题 → 九色仍透明（漏依赖数组就红，形式照
   `pages/__tests__/ProChartLegend.test.tsx:150` 那条"改图例后切主题仍留存"）。
6. **门禁**：`npx tsc --noEmit`、`npx vitest run` 全量、`npm run build`、
   `python -X utf8 -m pytest tools/test_wiki_drift.py -q`、`bash tools/wiki_freshness_gate.sh`、
   `bash tools/ci_grep_gates.sh`（后两条是本地恒红门，交付时先证本片 0 贡献再报告）。
7. **浏览器活体验收**（`http://localhost:5899/pro-chart`）：开关前后截图对比、缺口样本下
   实体不被裁顶、切主题不冲掉、画线开关前后位置不动、十字光标读数仍是真实价。

## 八、未来函数自查（交付必附）

HA 只用当根四价与上一根 HA 值，**不引用任何未来数据**。交付时按本仓固定的五步走一遍：

1. 进 Bar Replay，游标停在第 `k` 根，记录最后一根 HA 实体的四价读数；
2. 手动前进到 `k+1`，确认第 `k` 根的 HA 实体**形状与颜色都不再改变**；
3. 跳到末尾，再退出回放，确认全量视图里第 `k` 根与步骤 1 看到的完全一致（前缀==全量的活体面）；
4. 开着 HA 反复进出回放各一次，确认没有出现"之前画在将来区、退出后才消失"的图元；
5. 附本报告§七·1 的前缀不变量测试输出，作为可复算的证据而不是口头保证。

## 九、明确不做（已裁定，留档）

- **Pine 引擎的 `ta.heikinashi()`**：本片是显示层，不改 `pineTa` 分派表。脚本要读 HA 数值
  是另一件事，需要 oracle 对账（④ 片的语料里 `heikinashi` 命中数为 0，不是紧迫需求）。
- **⑤ VPVR**：下一片，走 overlay 图元通道。
- **`/multi-chart` 格子支持 HA**：独立样式链（`ChartCell.tsx:58-97`），不在本片范围；
  要加也应是把 `chartStyles` 提成共享模块的独立一轮。
- **不改 `candle.type` 联合、不 patch 库、不加依赖、不新增 locale 键（硬编码中文）、不新增环境变量。**
- **HA 不进分享码/导入导出 bundle**：视图态偏好是本机设置，与磁吸同性质。
