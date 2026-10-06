# Bar Replay（历史回放）设计

**日期：** 2026-10-06
**状态：** 已裁定，待实现
**范围：** 推荐功能清单里的第 ② 项（①Pine 脚本告警桥已交付于 §7.13）

## 一、要解决的问题

用户要能"假装今天就是历史上某一天"：把图表裁到某个时点，然后逐根或自动向前推进，用肉眼确认某个指标、
某个 Pine 脚本在那一天到底看到了什么、信号到底会不会重绘。

本仓已有两条腿从**数值**上证伪未来函数（Pine 语料 harness 的逐根对账、`alertcondition` 桥的
"只喂前 k 根 vs 喂全量"跨实现对账），但都要求写代码。缺的是一个**交互层**的自查工具：不改脚本、
不开控制台，直接把图退回到那天再一帧帧放。这条设计补的就是这个欠项，也是用户长期约束
「交易指标禁用未来函数……交付必附 Bar Replay 自查步骤」里那个"Bar Replay 自查"第一次有了字面实现。

**成功判据（一句话）：** 回放态下，图表数据里物理不存在 cursor 之后的 bar，因此任何指标——包括我们
无法改内部实现的 klinecharts 内置指标——都不可能读到未来数据。

## 二、决定性事实（全部盘面核实，带坐标）

1. **klinecharts v10 没有 `applyNewData`/`parseNewData`。** `Chart` 的 `Store` 接口面
   （`frontend/node_modules/klinecharts/dist/index.d.ts:959-990`）里与数据有关的只有
   `getDataList`（:965）、`setDataLoader`（:975）、`resetData`（:990）。⇒ 换可见窗口的唯一合法通道
   是**回答一次 `init` 类型的 `getBars`**。
2. **`init` 是整表替换**：`StoreImp.prototype._addData`（`klinecharts/dist/index.esm.js:13439`）的
   `case 'init'` 做 `_clearData(); this._dataList = data;` 并写入两个 `more` 旗，然后
   `setOffsetRightDistance(this._offsetRightDistance)`。`_clearData` 清掉 `_crosshair` 与可见区间，
   **不碰 overlays**（画线在别的 store 里）。
3. **`setOffsetRightDistance` 会重算 `_lastBarRightSideDiffBarCount = offsetRightDistance / barSpace`**
   （dist 里该函数本体）⇒ 每次 `init` 之后，视图自动落在"最新一根（也就是回放游标）停在右边固定
   留白处"。**这正是回放要的几何，不需要我们每步手工滚动。**
4. **`chart.resetData()` 就是重新发起一次 `init`**：`StoreImp.prototype.resetData`（:13652）做
   `_processDataUnsubscribe(); _loading=false; _processDataLoad('init')`，`ChartImp.resetData`（:15253）
   转发到它。本仓**没有任何一处定义 `subscribeBar`/`unsubscribeBar`**（grep `src/` 零命中），
   所以每步一次 init 不会重复注册推送订阅。
5. **库要未来的 bar 只有一个触发点**：`_adjustVisibleRange` 末尾（:13598-13603）
   `from === 0 && more.forward` 与 `to === totalBarCount && more.backward`。⇒ **回放态把
   `more.backward` 钉成 `false`，未来数据就物理进不来**。这是整个功能的闸门，不靠 UI 禁用按钮。
6. **`_processDataLoad` 有 `_loading` 互斥**（:13607：`if (!this._loading && …)`）⇒ 回放步进期间若有一次
   网络请求在飞，`resetData()` 会被静默丢弃。设计上要求**回放态的 `init` 与 `forward` 都从缓存同步回答**，
   不许 await 网络（见第六节）。
7. **Pine 副图自动跟随截断**：`applyPineIndicator`（`frontend/src/lib/indicatorLang.ts:1006-1071`）
   的 `calc` 收到的就是库的 dataList，klinecharts 在 dataList 变化时重算 ⇒ 我们不需要为 Pine 额外做游标。
   内置 19 个副图指标同样在库内部按 dataList 逐根算（`subIndicators.ts:52-72` 白名单，`calc` 不由我们提供）。
8. **全量 bar 的唯一存放处是 `chart.getDataList()`**，页面没有 app 侧副本（`ProChart.tsx:878/1037/1230/1463`
   都是就地读它）。⇒ 回放必须自己持有一份缓存，这是本设计新增的唯一状态。
9. **画线的两处 clamp 各有各的触发条件**，回放态下行为不同，必须分开说：
   - `clampDrawingsToLastBar`（`chartDrawings.ts:470`）在页面上只有两个调用点，且都裹在
     `if (bars.length > 0 && drawingsKeyRef.current !== key)`（`ProChart.tsx:961`，key＝`ticker|interval`）
     里面，另一处在导入路径（:1467）。**回放不换标的也不换周期 ⇒ 这条路径不会被触发**，
     已存的"未来画线"不会被吸到游标上、也不会被 `degenerate` 判成重合而删掉。
   - `anchorDrawing`（`ProChart.tsx:1226`）在用户落笔时读 `lastBarTimestamp(chart.getDataList())`，
     回放态下那个值就是游标 ⇒ **回放中新画的线会被吸到游标那根上并入库**。这是正确行为
     （"今天就是这一天"，最新 K 线右侧的空白本来就不该有落点），退出回放后也不会回退。

## 三、三个候选与裁定

- **A 截断式（采纳）**：图表永远只持有 `cache.slice(0, idx+1)`。内置指标、Pine、图例、y 轴、
  最后一根标记、`more.backward` 触发条件全部自动只见过去 ⇒ 无未来函数是**结构性**的，不靠约定。
  代价：要自己持缓存、要让位视图几何（事实 3 表明代价近零）。
- **B 遮罩式（否决）**：数据全在，未来区置灰，游标之后不画。硬伤：**内置 19 个指标在 klinecharts 内部
  按整条 dataList 算**（事实 7），我们拿不到它们的输入，置灰区里的 MA 值会实实在在画进已回放区域
  ⇒ 用它做"不重绘"自查会得出**假阴性**（看起来不重绘，其实算过未来）。这条判据单独就足以否掉 B。
- **C 独立页（否决）**：新开 `/bar-replay`，不碰 `ProChart.tsx`。回归面最小，但用户在盘面上看的就是
  ProChart，回放要复用它已有的画线、副图选择、指标工作台联动，另起一页等于把这些全丢一遍。
  `MultiChart`/`ChartCell` 明确**不在本片范围**（多图同时回放是另一件事）。

## 四、分层

```
frontend/src/lib/barReplay.ts        纯函数，无 React、无 chart 实例
  ├─ indexAtOrBefore(bars, ts)        二分：≤ ts 的最后一根下标（-1 表示没有）
  ├─ replayWindow(bars, cursorTs)     不变量左半边：bars.slice(0, idx+1)
  ├─ stepCursor(bars, cursorTs, n)    ±n 根，钉在 [首根, 末根] 两端，越界夹紧
  ├─ cursorFromView(bars, visibleTo)  "从视图右端开始"：把库的可见下标折成游标
  ├─ REPLAY_MORE                      ⇒ { forward: false, backward: false }，两旗都钉死（第六节）
  ├─ isReplayExhausted(bars, cursorTs) 游标已在最后一根 ⇒ 播放自动停
  ├─ paceMs(speed)                    倍速表，纯查表
  ├─ isFutureDrawing(points, cursorTs) 任一锚点 ts > cursor 即为未来画线
  └─ 类型 ReplayState { active, cursorTs, total, shown }

frontend/src/pages/ProChart.tsx      只做三件事：持 cache、答 DataLoader、驱动 resetData
frontend/src/components/charts/ReplayBar.tsx  工具条那一排（新文件，避免继续喂大 ProChart）
```

理由：本仓图表侧的既有分层就是"纯数学在 `lib/`、接线在页面"（`klinePaging.ts`、`mtfSync.ts`、
`paneLayout.ts`、`chartView.ts` 全是这个形状），且 `ProChart.tsx` 已经 1700+ 行——工具条拆出去，
ProChart 只多一个 `<ReplayBar />` 挂载点和 ref 接线。

## 五、游标身份：timestamp，不是 index

游标存**毫秒时间戳**。每一步、每次分页、每次渲染都用 `indexAtOrBefore` 现算下标。

原因三层：① 游标要在工具条上显示成日期、要被日期输入框设定，它的天然身份就是时间，不是位置；
② 会移动下标的操作确实存在——回放中途换周期（自然周月折叠，`chartView` 那条契约）、改副图触发
re-init、退出回放后 `forward` 分页在头部 prepend（事实 5 的另一半）；本设计**裁定这三处一律退出回放**
（见第七、九节），所以位置身份不是"能用"，而是"要靠退出兜底才能对"，那不如一步到位；
③ 本仓有过同型事故（副图 `paneId` 随机漂移），能用稳定身份就不要用位置身份。

**唯一不变量：**

```
回放态下，任一时刻：chart.getDataList() === replayCache.slice(0, indexAtOrBefore(replayCache, cursorTs) + 1)
```

这条要有一个专门的守卫测试，在"进入回放 / 单步 / 播放若干步 / 步进到两端 / 退出"之后各断一次。
它同时是"未来数据进不来"的另一种写法：右边界的下标由 cursorTs 唯一决定。

## 六、DataLoader 的三态契约

`getBars` 开头读一次 `replayRef.current`，之后分三条路：

| 分支 | 非回放（现状，不改） | 回放态 |
| --- | --- | --- |
| `init` | 网络拉最新 `PAGE` 根 | **同步**答 `replayWindow(cache, cursorTs)`，`more = { forward: false, backward: false }` |
| `forward` | 网络拉更早，`shapeResponse` 去重 | **一律 `callback([], {forward:false, backward:false})`**，并 `blockedForward += 1` |
| `backward` | 网络拉更新并过滤 | **一律 `callback([], {forward:false, backward:false})`**，并 `blockedBackward += 1` |

**回放态整条 DataLoader 零网络请求**，这是本设计对第六节的收紧，理由有三条，第三条才是决定性的：

1. 库要更早 bar 的触发点是 `from === 0 && more.forward`（事实 5）。回放窗口是**前缀**，
   `from === 0` 恒真于"整段前缀都装得进视口"的时刻（游标停在很早、bar 数少于视口容量），
   那会**自动**发一次 forward 请求。
2. 而 `_processDataLoad` 有 `_loading` 互斥（事实 6）⇒ 这次自动请求在飞期间，用户的单步
   `resetData()` **被静默丢弃**。表现就是"按了不动"，而且只在特定缩放下出现，是最难复现的那类缺陷。
3. 往更早看**不是回放的语义**。要看更多历史就退出回放、滚够了再进——cache 就是"进入回放那一刻
   图上有什么"，它有边界是诚实的，工具条如实显示"回放区间＝已加载的 N 根"。

两道闸门而非一道：`more.backward=false` 使 backward 本不该被调用（事实 5），页面仍然接住它。
守卫测试要断 `blockedBackward > 0`／`blockedForward > 0` 才算兜底真被踩过——本仓有
"扫全仓的守卫在空集合上真空通过"的前科。再加一条最硬的结构断言：**回放期间
`fetchKline` 的调用次数为 0**（spy 计数），它一旦成立，上面整类竞态就不存在。


## 七、进入 / 退出 / 播放

- **进入**：`bars = chart.getDataList()` 快照进 cache。`bars.length === 0` 或分时态 → 按钮 disabled
  并说明原因（分时只有一节 session、且 `forward` 本来就直接空答，见 `ProChart.tsx:880-887`，
  进回放会立刻没数据）。初始游标＝`stepCursor(bars, last, -DEFAULT_BACK)`，`DEFAULT_BACK = 250`
  （日线约一年），不足 250 根就停在首根并如实显示。
- **起点可选两处**：日期输入框（按 `indexAtOrBefore` 落到最近的一根，比目标晚的那根不存在），
  以及"从视图右端开始"＝`cursorFromView(bars, chart.getVisibleRange().to)`。**不用十字光标位置**：
  klinecharts 的 `onCrosshairChange` 广播的形参里根本没有 `timestamp`（`mtfSync.ts` 那边要靠
  `convertFromPixel` 反解），为一个入口再引入那条契约不值。
- **单步**：`cursorTs = stepCursor(...)` → `chart.resetData()`。播放中每次只走一根，不做插值。
- **播放**：`setTimeout` 链，**不用 `requestAnimationFrame`**（本仓已知：后台标签页 rAF 不跑，
  而"挂机回放"正是这功能的典型用法）；倍速表 `paceMs`＝`{0.5:2000, 1:1000, 2:500, 4:250}` ms/根，
  纯查表，测试直接对表断言。`document.visibilityState === 'hidden'` 时自动暂停并在恢复时保持暂停
  （用户回来要看到停在哪儿，不是补跑一堆帧）。游标到达末根自动停、按钮回到"播放"。
- **退出**：`cursorTs = null`、`more.backward` 恢复原语义、`chart.resetData()` 一次把 cache 交回
  （cache 可能因 `forward` 分页比进入时更长，交回它比交回旧快照更诚实）。

## 八、画线与未来区

回放态把"任一锚点 `ts > cursorTs`"的画线（`isFutureDrawing`）经 `overrideOverlay({ visible: false })`
隐藏，退出时按原样还原（`visible` 是被 `overrideOverlay` honoured 的字段——
`chartDrawings.ts:48-57` 已核实 `lock` 不是、`visible` 是）。理由与第二节 B 方案同构：回放里显示
"未来才画的线"就是视觉上的未来函数。

隐藏集合存在 ref 里，不写存储（第九节已论证那条路径不触发），退出回放时逐条 `visible: true` 还原。
游标推进过程中，一条线从"未来"变"过去"要在**下一次** `resetData` 之后自然显形：判据只用当前 cursorTs，
不缓存上一次的结论。

## 九、不做的事

**图内游标竖线**（设计初稿里有，实现前撤掉，理由是盘面的）：本仓画线入库走
`serializeDrawings(chart.getOverlays())`（`ProChart.tsx:844`，另有 :1292/:1312 两处），
**整份 overlay 列表不按名字过滤**。所以只要把游标做成一个 `registerOverlay` 画件，它就会
被 bank 进用户的画线桶、退出回放后仍在、下次重载复活、跟着 `.json` 与 `?d=` 分享码导出。
绕开它的代价（改 `chartDrawings.ts` 的入库过滤＝动一套 59 例的既有门）明显大于收益，
而截断式本身已经把"现在"表达得很清楚：**最右那根就是游标**，右侧只有固定留白。
游标读数改由工具条承担（日期＋第 k/N 根＋剩余根数）。

其余不做：回放中下单/模拟成交、多图表同时回放、回放会话导出或分享、`subscribeBar` 实时推送接入
回放态、游标中途换标的或换周期（**一律直接退出回放**：cache 的数据身份变了，重解析游标要新拉数据，
换来的只有竞态和"看起来还在回放其实数据是旧的"）、回放区间的统计报告。

## 十、"不重绘"的可执行定义

新增一个 harness（与 `pineAlertCorpus.test.ts` 同族，走真实语料目录）：

> 对每个能跑通的脚本、每个探针长度 `k`：
> `compilePine(src, bars.slice(0, k))` 得到的每一条 line 值、每个 marker、每条 hline、每个 drawing，
> 与 `compilePine(src, bars)` 的**前 k 项**逐项相等（`na` 位置也算）。

这就是 Bar Replay 的数学定义，也是它反过来给引擎挣到的东西：一条永久性的 Pine 引擎未来函数回归门。
`request.security` 多周期那一类要单独处理——HTF 序列在引擎里是预建的数组（`pineTypes.ts:333-341`
的 `PineBars`），截断输入 bar 时 HTF 侧是否同步裁要**先实测再定断言**：若它按宿主游标切换而读到未来
HTF bar，那是引擎缺陷，要在本表里如实标红并单独立项，**不许把该脚本从 harness 里摘出去**。

## 十一、测试与回归面

- `frontend/src/lib/__tests__/barReplay.test.ts`——纯函数：二分（含"游标早于首根"“落在两根之间”）、
  `stepCursor` 两端夹紧、`replayWindow` 与不变量、`paceMs` 查表、`isFutureDrawing` 多空锚点。
- `frontend/src/pages/__tests__/ProChartReplay.test.tsx`——**结构不变量**测试：用带 spy 的 chart 替身，
  断 (a) 回放态每次 `getBars` 答出去的 bar 的 `timestamp` 全部 `≤ cursorTs`；(b) 三个分支答出去的
  `more` 两个旗都是 `false`；(c) 有人问 `backward` 或 `forward` 时对应 `blocked*` 计数 > 0；
  (d) 回放全程 `fetchKline` 调用数为 **0**（spy 计数，这条最硬）；(e) 步进到首根/末根再步进一次，
  游标不动且不越界。**替身必须按库真实行为建模**：`resetData()` 要真的再回调一次
  `getBars({type:'init'})`，否则会重演"替身全绿而功能不动"那一类。
- `pineReplayNoLookahead.test.ts`——第十节那条 harness。
- 既有回归面（改动会碰到）：`ProChartPaging`(3)、`klinePaging`(9)、`ProChartDrawings`(59)、
  `chartDrawings`(56)、`indicatorLang`(31)、`pineIndicatorWire`(15)、`subIndicators`(20)。
- 活体验收：真实浏览器（vite dev + 后端 8000，600519.SH 日线）走"进入 → 单步 20 根 → 播放 →
  游标读数 → 未来画线隐藏 → 退出还原 → 换标的自动退出"，React fiber 取实例读 `getDataList()`
  的右端与 cursor 比对（canvas 取证手法见 Repo Wiki 那条）。

## 十二、未来函数自查步骤（交付时必须附）

1. 打开 `/pro-chart`，选日线，画一条线或放一个 Pine 副图；
2. 点「回放」，游标落在约一年前；
3. 单步/播放推进，盯住指标第一次出值的根——它必须出现在"数据刚好够算出它"的那一根，且**出现后不再改变**；
4. 把游标停在一根上，退出回放，看同一根上的值与回放里看到的**逐位相同**；
5. 若第 3 步出现"值先画出来又改掉"或"提前 N 根出值"，即判为重绘缺陷，按脚本名登记，不改判据。
