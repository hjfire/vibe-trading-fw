# 多周期看盘（Multi-Chart）设计

日期：2026-10-05 · 状态：已与用户确认 · 分期：本文 §5

## 1. 目标与形态

在同一屏并排 2×2 四张 K 线图，展示同一标的的四个不同时间周期，四张图的十字光标与
时间窗口互相对齐。参考范式来自开源项目 [hyperscalper](https://github.com/jestersimpps/hyperscalper)
（`app/[address]/[symbol]/multi-chart/` ＋ `MultiTimeframeChart.tsx`，同步多图表网格）。

调研中被否决的两个形态：`lightweight-charts-mtf` 的「主图右侧叠 HTF 蜡烛列」——klinecharts
的画线通道只有 line/bar/circle/text 四类图元，画不出蜡烛；以及「副图放一张多周期共振表」——
复用面最好但没有「多张图」的观感。

## 2. 为什么落在呈现层

后端与引擎侧的多周期能力已经存在，本功能不新建数据层：

- `agent/src/api/market_routes.py` 的 `GET /market/kline` 单 interval 服务 8 个周期；周/月线由
  日线在内存按自然周月折叠（`_merge_to_calendar`）。**一次请求 = 一个周期**，四格即四次并行请求。
- `frontend/src/lib/pineResample.ts`（`resampleUp` / `tfToMs` / `inferTimeframeMs`）与
  `pineRuntime.ts` 的 `evalOnBars` 已实现 Pine 侧跨周期求值，有 17 个用例。
- 缺的只是「呈现层同时持有多个周期」：`ProChart` 的 `ChartView = { interval, timeShare }` 是单值、
  全页只有一个 `init()`、`readSession` 与 `drawingsKey` 都以「一图一周期」为前提。

## 3. 文件划分

| 面 | 路径 | 职责 |
|---|---|---|
| 新 | `pages/MultiChart.tsx` | 页面壳：标的选择、2×2 网格、逐格周期下拉、会话持久化 |
| 新 | `components/charts/ChartCell.tsx` | 一个 klinecharts 实例 ＋ 一个周期 ＋ 自己的 DataLoader |
| 新 | `lib/mtfSync.ts` | 联动纯函数层：下标↔时间戳、窗口→barSpace、回环闸门 |
| 新 | `lib/chartView.ts` | 从 ProChart 搬来的三个纯谓词 |
| 改 | `pages/ProChart.tsx` | 仅改为 import ＋ re-export 上述三谓词 |
| 改 | `router.tsx`、`components/layout/Layout.tsx`、9 份 locale | `/multi-chart` 路由与导航 |

**复用而不复制的规则**：`marketApi`（`fetchKline` / `intervalToPeriod` / `periodToInterval`）、
`klinePaging`（`boundsOf` / `pagingBefore` / `shapeResponse`）、`timeShare`（`fitBarSpace` /
`fitOffsetRight`）、以及 `intervalAllowed` 这条「周期对标的可用性」单一谓词。

`intervalAllowed` 目前住在 `ProChart.tsx:158`。新页面要用它，从页面文件 import 会把 2069 行
拉进 MultiChart 的 chunk；复制一份则违反本仓库已经吃过教训的单一规则原则（同一规则四处判断只
收敛两处，曾做出「按钮看着可点、点击完全无效」）。故做 25 行纯函数搬迁，ProChart re-export 使其
现有 4 个测试文件的导入路径不变。

## 4. 联动算法

klinecharts 10.0.3 公开 API 直接支持两个方向，不需要私有字段。

### 4.1 十字光标

`A.subscribeAction("onCrosshairChange")` → 取 `timestamp` → 对每个 B：
`x = B.convertToPixel({ timestamp }, { paneId }).x` → `B.executeAction("onCrosshairChange", { x, paneId })`。

必须走 `convertToPixel` 的原因：dist 的 `StoreImp.setCrosshair` 只用 `cr.x` 反推柱子下标
（`coordinateToDataIndex(cr.x)`）；`x` 不是数字时走 `else` 分支落到 `_dataList.length - 1`，
即直接传 `{ timestamp }` 会让对端十字光标跳到最新一根。

回环由库自己断开：`ChartImp.executeAction` 对 `onCrosshairChange` 走的是
`setCrosshair(crosshair, { notExecuteAction: true })`，不会再触发对端事件。

### 4.2 缩放／滚动（时间窗口）

只监听 `onVisibleRangeChange`。dist 里 `setBarSpace`／`scrollByDistance`／zoom 最终都汇聚到
该事件（13568 / 13758 / 14033），分别监听 `onZoom` ＋ `onScroll` 会把同一个动作应用两次。

1. 源图 A：`A.getDataList()` 把 `getVisibleRange()` 的 `from`/`to` 下标换算成两个时间戳，
   得到与周期无关的**绝对时间窗口**。
2. 目标 B：二分 B 的 dataList 数出落在该窗口内的柱子数 `n`。
3. 套用：`fitBarSpace(B宽, n)` → `setBarSpace` → `setOffsetRightDistance(fitOffsetRight(...))`
   → `scrollToTimestamp(to, 0)`。顺序是 load-bearing 的，`timeShare.ts` 已记录「先设 offset
   再 zoom 会按两种 spacing 的比例算错间距」。
4. `fitBarSpace` 返回 `null` 时跳过该格：库的 `setBarSpace` 越界是**静默 return 不 clamp**
   （区间 [1, 50]），jsdom 与真实窄屏都走这条路。

回环**库不帮忙断**：第 3 步会再触发 B 的 `onVisibleRangeChange` 弹回 A。总线带一个 `applying`
计数闸门，应用对端事件期间丢弃自身产生的事件。这是 `mtfSync.ts` 里唯一必须单测的状态机。

## 5. 分期

1. `lib/chartView.ts` 搬迁 ＋ ProChart re-export（跑既有 ProChart 用例确认零回归）
2. `ChartCell` ＋ `mtfSync` 纯函数（含单测）
3. `MultiChart` 2×2 网格，四格独立不联动
4. 十字光标联动
5. 时间窗口联动 ＋ 闸门
6. 路由／导航／九语 locale 齐平
7. 全量门禁 ＋ 活体验收

## 6. 验证策略与其局限

现有前端测试整体 `vi.mock("klinecharts")`（`ProChartTimeShare.test.tsx:156`），断言的是**我们
发出的调用序列**。因此「四张图真的对齐了吗」这件事单元测试永远测不出来，必须开浏览器活体验证：
十字光标移到日线图确认分钟图竖线落在同一时刻；缩放后读四格 `getVisibleRange()` 换算出的时间窗口
是否一致。canvas 类取证手法（后台标签页 rAF 不跑、需前台读数）见记忆条目 chart-canvas-browser-forensics。

门禁面：`tsc --noEmit`、`vite build`、全量 `vitest`、`i18n.test.ts` 键数与插值 parity、
`apiProxyCoverage.test.ts`（`/market` 已在 `vite.config.ts:23`，预计无需新增前缀）。

## 7. 明确不做

- 不动后端（四格各自请求现有单周期端点）。
- 不搬 ProChart 的画线、分时、指标配置面到新页面——新格只画蜡烛＋默认均线。
- 不做 KlinePanel 大重构（用户已否掉该选项）。
- 不做范式 A 的蜡烛叠加。
