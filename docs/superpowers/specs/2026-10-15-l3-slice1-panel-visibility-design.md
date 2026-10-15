# L3 第一片：图表面板开关的会话级持久化 — 设计文档

**日期**：2026-10-15　**分支**：`feat/l3-panel-visibility`（基座 `92087084`）
**在漏斗里的位置**：五级漏斗的 L3（`docs/superpowers/specs/2026-10-13-rea-tradingview-replica-design.md` §4 与 §7 的 P4）——
从 L2 差距矩阵里挑**最小可验收**的一条开片，走完整六片式（本仓 spec → 实现计划 → TDD 先红 → 六道门 → 活体取证 → 变异自证 → 档案落档）。

## 0. 白话版

图表面下方那四个面板——画线清单、副图指标选单、图例、指标工作台——现在是组件里的四个 `useState(false)`。
用户把它们点开，刷新一下就全关上。这一片让「开没开」活过一次刷新，并且补一根测试针，钉住「点开这四个面板不会改地址栏」。

## 1. 这片是什么、不是什么

- **是**：一个 `frontend/src/lib/chartPanels.ts` 纯模块（读写一个会话级键）＋ `ProChart.tsx` 的四枚初值与一个写点＋测试。
- **不是**：不是新页面、不是后端、不是库的私有面。不加依赖、不改 `package.json`、不动 `tools/**` 与任何 workflow。
- **不碰** `frontend/src/lib/chartDrawings.ts` 与它的测试：这两枚此刻是别的席未提交的活（工作树 ` M`），撞上去会让两边的读数互相作废。

## 2. 规格来源（两条 L1 条目，判据我自己复跑过）

| 条目 | L1 原文给的读数 | 我 2026-10-15 在仓库根复跑 |
|---|---|---|
| TV-DW-05（矩阵现判 `缺`） | 对方的键名清单里，`session_storage_keys[4]` 那一行四个名字含 `ChartFavoriteDrawingToolbarWidget.visible`；`local_storage_keys[20]` 那一行含 `tradingview.toggle_delete_locked_linetools` | `grep -c '^    session_storage_keys\[4\]: widgetbar.layout-settings,ChartFavoriteDrawingToolbarWidget.visible,chartPageGrid.maximizedPanel,symbol-lists.activeList' docs/forensics/l0/tv-a16-storage.md` → rc=0、`1`；`grep -c '^    local_storage_keys\[20\]:.*tradingview.toggle_delete_locked_linetools' docs/forensics/l0/tv-a16-storage.md` → rc=0、`1` |
| TV-CI-06（矩阵现判 `部分`） | 四个打开动作在本仓不写 URL，但「没有任何测试针钉这件事」是它停在 `部分` 的唯一驱动理由 | `grep -n -e useNavigate -e "navigate(" -e pushState frontend/src/pages/ProChart.tsx` → rc=1、0 命中（命题为真，缺的是针） |

**这一片的规格只取 DW-05 的前半个键。** 为什么：

- L1 的 TV-DW-05 那一格在 2026-10-14 终席已把话说死——「这两个键分别承载工具栏可见性与锁定删除开关的偏好」＝**据键名推断**，
  值面未读、键名↔行为的映射没有任何连接读数。所以本仓能照的只有**scope 归属**（那枚可见性键在 session 那一行，不在 local 那一行），
  行为面（刷新保持、新标签回默认）是**本仓自拟**的规格。这句边界必须跟着这片的所有产出走，档案里也要写。
- 后半个键（锁定线可否删除）落在**这片做不了**的那一类，理由写在 §6。

## 3. 现状（本仓这一侧，全部现读）

- 四枚状态：`frontend/src/pages/ProChart.tsx` 的 527 `indPanelOpen`、548 `subPanelOpen`、561 `drawPanelOpen`、591 `legendPanelOpen`，四枚都是 `useState(false)`。
- 改动它们的地方：2283 `setDrawPanelOpen((open) => !open)`、2768 与 2889 两个 `(v) => !v` 翻转、3245 遮罩 `onClose` 关掉工作台、
  763 与 1608 两处 `setIndPanelOpen(true)`（1608 那一处是 `?s=` 分享链接由 URL 反向打开面板，不是本条规格管的方向，矩阵 CI-06 已经交代过）。
- 键名惯例：`pro-chart.<thing>.v1`——`WATCH_KEY`(同文件 181)、`SESSION_KEY`(182)、`MAGNET_KEY`(`lib/chartDrawings.ts:1028`)、`LEGEND_PREFS_KEY`(`lib/chartLegend.ts:66`)。
- 偏好读法惯例：`load*()` 在 `useState` 初值里惰性调用，内部 `try/catch` 且失败回落默认（`loadMagnet` 是最小的一枚，`readSession` 是带字段级校验的一枚）。
- `grep -rn sessionStorage frontend/src/lib` → rc=1、0 命中；`ProChart.tsx` 里那一串只出现在 621 行的一句**注释**里，
  而同文件 281 行 `readSession` 实读的是 `localStorage.getItem(SESSION_KEY)`。⇒ 那句注释的括号措辞与代码不符，
  本片只把它的**措辞**改准（同一行内替换，不挪行号），不改 `readSession` 的行为。

## 4. 设计

### 4.1 模块

`frontend/src/lib/chartPanels.ts`，一个导出类型、一个键名常量、两个函数：

```ts
export interface PanelVisibility {
  workbench: boolean;   // 指标工作台（indPanelOpen）
  subIndicator: boolean; // 副图指标选单（subPanelOpen）
  drawings: boolean;     // 画线清单（drawPanelOpen）
  legend: boolean;       // 图例（legendPanelOpen）
}
export const PANELS_KEY = "pro-chart.panels.v1";
export function loadPanelVisibility(): PanelVisibility;
export function savePanelVisibility(v: PanelVisibility): void;
```

- **载体＝`sessionStorage`**，不是 `localStorage`。这是这片唯一一处「跟本仓惯例不一样」的选择，理由就是 §2 那条读数：
  那枚可见性键在对方的 **session** 清单里。会话级意味着关标签即回默认，这正是对方的形状；本仓其余偏好（磁吸、图例、样式）
  是持久级，因为它们对应的键在对方 `local_storage_keys` 那一行。
- **四枚合一个键、一个 JSON 值**，不是一枚面板一个键。理由：机制完全同形，拆四枚键只多三次 try/catch；
  而且 DW-04 已经证明「对方把一个界面态拆成多枚独立键名」不是必须复刻的不变量（本仓刻意保持合并值，见 §6）。
- **读＝逐键严格判定**：`obj[field] === true` 才真，其余（缺键、`"true"` 字符串、`1`、坏 JSON、存储被禁）一律回落默认
  `{ workbench: false, subIndicator: false, drawings: false, legend: false }`。和 `readSession` 那句「strict `=== true`, so a
  corrupted or hand-edited bucket cannot turn the chart into a line nobody asked for」同一条纪律。
- **写＝只落偏差，全 false 就删键**（与 `lib/chartLegend.ts:167` 的 `saveLegendPrefs` 同规：现读那段注释
  「未偏离默认的键一律不落盘」＋`if (Object.keys(deviated).length === 0) { removeItem; return; }`）。
  于是盘上的形状是 `{"drawings":true}` 这种**只含为真的键**，不是一枚全量四键的快照。
  为什么跟本仓最近的先例而不是跟 `SESSION_KEY`（那枚是无条件整体写）：图例与 Heikin-Ashi 这两枚是**同族**（界面偏好，读侧从默认补齐），
  `SESSION_KEY` 装的是「上次看的标的与周期」——那本来就没有「默认」可回落。同族照同族。
  带来一条要说清的性质：首挂载时若盘上是**坏值**（load 判成全 false），合成点会把那枚键**删掉**——自愈，
  且 §5(2) 给它一根明写的针，免得下一个人把它当意外。
- **写不合并，整体替换**：`JSON.stringify(偏差对象)`；任何异常（隐私模式、配额）静默吞掉——持久化是便利，不该让一次点击报错。

### 4.2 接线（`ProChart.tsx`）

- 四枚初值改成 `useState(() => loadPanelVisibility().drawings)` 这一形（惰性初值，与 580 `loadMagnet()`、590 `loadLegendPrefs()` 同形；**同一行内替换，不增行**）。
- **写＝唯一合成点**：一个 `useEffect` 盯住四枚布尔，变化即 `savePanelVisibility({ workbench, subIndicator, drawings, legend })`，
  落点就在现成的两枚同类 effect 后面（781 行的 `WATCH_KEY`、790 行的 `SESSION_KEY`——同一个形状：`try { setItem(key, JSON.stringify(…)) } catch { /* 静默 */ }`＋值依赖数组）。
  不在六七个 `set*` 调用点上分散写——分散写漏一个点就是「这个面板的记忆半真半假」，而那正是本仓图例那一章记过的同型坑
  （多个写入点 ⇒ 必须并到一个合成点）。合成点只写不读，读只发生在初值，方向单一。
- StrictMode 下初值会双读、effect 会双跑，但写的是同一个值，幂等。
- **首挂载写不写盘由 §4.1 那条偏差编码决定**：没开过任何面板 ⇒ 合成点跑到 `removeItem`，键始终不存在；这条性质是刻意的（同族先例如此），
  所以 §5(2) 有一根「未动过 ⇒ 键为 `null`」的针守着它，别让人日后把它「修」成无条件写。

### 4.3 坐标漂移：这片不去躲它，而是当场重钉

实现必然在 `ProChart.tsx` 里增行（1 行 import ＋ 1 枚 effect ≈ 7 行，合计约 +8）。增行会让仓内文档按行号钉住的那批读数**静默指错**，
所以先把范围现读出来（2026-10-15 在仓库根跑 `grep -roE "ProChart\.tsx:[0-9]+" docs tools`）：

| 落点 | 命中的行号 | 是不是门禁验得过 |
|---|---|---|
| `docs/forensics/gap-matrix.md` **第三列**（`本仓坐标或搜索记录`） | 182／527／1398／2716／2778／2830／3060／3238（8 枚） | 是——`tools/forensics_audit.py:402-436` 对 `已有／部分` 行强制 `file:line`，并查「仓库根之内、不在 `docs/forensics/**`、文件存在、行号在 `1..n` 之内」 |
| `docs/forensics/gap-matrix.md` **说明列**（散文里的现读号） | 561／415／2698／1930／1608 等，另有大量「NNNN 行」写法不带文件名、本把 grep 数不到 | 否——校验器不读说明列 |
| `docs/forensics/spec/chart-interaction.md` | 561（2 枚）／2830 | 否——校验器不扫 L1 散文 |
| `docs/forensics/l0/self-ci07-panel-toggle.md` | 561 | 否 |

**关键事实是校验器判不出漂移**：文件只会长，`1..n` 恒成立，所以摘掉 8 枚锚里的任何一枚都不会让门变红，门会绿着把「2830 是 `aria-pressed={drawPanelOpen}`」指到别的那一行去。
这条静默通道只能靠人重钉，故这片把它列成一条任务，判据是**按内容重钉**而不是按 ±N 平移：每枚锚先在改后的文件里 `grep -n` 它记录的逐字文本，取新行号，再 `sed -n '<新号>p'` 开一次确认文本对得上。

为什么不选「行数中性」的接线来躲它（三个候选都权衡过）：

- **(B) 纯函数塞进 `lib/chartView.ts`**，再把 `ProChart.tsx:237` 那行单行 import 原地扩写——省 1 行，但 effect 那 7 行省不掉；
  代价是把面板可见性塞进一个装周期档位合法性的模块，`chartView.ts` 的 41 行里没有一个字讲面板。
- **(C) 写穿型 hook**（`src/hooks/` 里包一层 `useState`，setter 顺手落盘）——写点由构造唯一，很干净；但合成点从此看不见
  （要读 hook 才知道盘在哪），且六个 `set*` 调用点里 `setIndPanelOpen(true)` 这类直写只要漏挂一层包装就静默不持久，
  而本仓的同类面（`:781`／`:790`）用的就是 effect 合成点。为省 8 行去换一条本仓没有先例的通道，不值。
- **(D) re-export 桶**——纯粹为绕门禁做形状表演，不做。

所以结论是：**漂移是实现 L3 任何一片的固有代价，不是这一片的选择造成的**（矩阵自己的口径也写着「按条目号指，别按行号指，那张表还会被改」）。
处置方式＝第三列 8 枚按内容重钉 ＋ 给说明列补**一条带日期的追加子句**（写明本片在 `ProChart.tsx` 实际增了几行——这个数由实现席当场数，本文不预先填——第三列已按内容重钉、
说明列里 2026-10-14 那批现读号按既有口径保留不改写），而不是去原地覆盖历史读数。

## 5. 判据与验收

1. **纯函数单测**（`frontend/src/lib/__tests__/chartPanels.test.ts`）五态：①键不存在 ⇒ 全 false；②写一枚为真再读回 ⇒ 只有那枚真、且盘上 JSON 只含该键；
   ③坏 JSON／缺键／非 `true` 值回落默认；④**先让键存在**（先写 `{"drawings":true}`）再写回全 false ⇒ 键被 `removeItem` 删掉（`getItem` 得 `null`）——不先建键就断言 `null`，
   那根针在「从来没写过」的世界里也绿，属本仓记过的空集合真空通过；⑤`sessionStorage` 抛异常时 load 回落、save 不抛。
2. **页面级针**（`frontend/src/pages/__tests__/ProChartPanels.test.tsx`，测试替身形状照 `ProChartLegend.test.tsx` 直接 render `ProChart`）：
   - **前置（不然「四个动作」这句话在 jsdom 里点不动）**：`画线清单` 那枚按钮在 `drawCount === 0 && parkedCount === 0` 时 `disabled`
     （现读 `ProChart.tsx:2836`），所以本测试在挂载前往 `localStorage` 塞一枚 `pro-chart.drawings.v1` 桶、里面放一条 `priceLine`，
     让它经 `restoreDrawings` 回到画布——这条配方仓内已有先例，逐字形状抄 `ProChartDrawings.test.tsx:1124-1145`（该文件把这种桶叫 `DRAWING_KEY`）。
     另三枚不带 disabled，直接点得动：`副图指标`（现读 2763 有 `aria-label`）、`图例`（2886 有 `aria-label`），
     而**工作台入口那枚没有 `aria-label`**（现读 2750-2756：只有 `title="编写/管理自定义指标公式（保存在本地）"`，可达名来自文本 `ƒ 指标公式`），
     所以测试里取它要用 `getByRole("button", { name: /指标公式/ })`，别按 `aria-label` 找——按 label 找会在「夹具没做对」和「机制坏了」之间给出假红。
     同文件 3229 那枚「去修正」也走 `openFormulaPanel`，但它是错误横幅里的补救入口，不属于本条那「四个打开动作」。
   - 点 `画线清单` 开关 → `sessionStorage` 的 `pro-chart.panels.v1` 读出来逐键等于 `{"drawings":true}`
     （四枚各点一次，各断言自己那一枚；偏差编码 ⇒ 键里**只有**那一枚为真的键）；
   - **未动过 ⇒ 键不存在**：干净挂载、一次都不点，`sessionStorage.getItem(PANELS_KEY)` 为 `null`（守 §4.1 那条偏差编码，
     也顺手证明合成点没在首挂载把默认值刷上盘）；
   - **关掉也要落盘**：把工作台点开后经遮罩 `onClose`（现读 `ProChart.tsx:3245`）关掉 → 那枚键**回到 `null`**。
     这根针存在的理由是 §5(3) 的变异②——只在 toggle 里写、漏掉 `onClose` 那类「非翻转的关闭路径」，没有它就照不出来；
   - 带着这条会话记录重新挂载 → 四枚开关都读得到 `aria-pressed="true"`（这就是「活过一次刷新」在 jsdom 里的等价物；
     jsdom 的 `sessionStorage` 在同一测试文件内跨挂载共享，`beforeEach` 里显式清，否则第二根针会读到第一根留下的值）；
   - **严格判定＋自愈**：预置 `{"drawings":"yes"}` 再挂载 → 那枚开关读不到 pressed（truthy 但非 `true` 不算开），
     且首挂载后那枚键被删成 `null`（§4.1 说的坏值自愈，写成针而不是留在注释里）；
   - **URL 不变性**（CI-06 要的那根针）：四个打开动作各点一次，逐次断言 `window.location.href` 与动作前逐字相同。
   - **链接优先**（§7 那条风险）：先塞 `{"workbench":false}`，再经 `?s=` 分享链接挂载，断言工作台被打开**且**会话键被写成 `workbench:true`。
3. **变异自证**：摘掉机制必须有针变红，三处各配一根指定的针——①把四枚初值改回 `useState(false)` ⇒ 「带记录重新挂载读到 pressed」红；
   ②把写点从合成 effect 改成只在 toggle 里写、漏掉遮罩那条 `onClose` ⇒ 「关掉也要落盘」红；③把 `=== true` 放宽成 truthy ⇒ 「严格判定」红（纯函数单测里那态同时红，两处都记）。
   报告要逐处写明「哪一根针红了」，不接受「全绿所以有效」。
4. **坐标重钉**（§4.3 那条静默通道的验收）：`gap-matrix.md` 第三列那 8 枚 `ProChart.tsx:<行号>` 全部按内容重钉，
   报告里逐枚贴「记录的逐字文本 → 新行号 → `sed -n '<新号>p'` 的开行读数」；说明列不动历史读数，只加一条带日期的追加子句。
5. **六道门**：`npx tsc -b`／`npx vitest run`／`npm run build`／`pytest tools/test_wiki_drift.py tools/test_wiki_qmind.py`／`python -X utf8 tools/forensics_audit.py`／`python -X utf8 -m pytest tools/test_forensics_spec.py -q`，外加两道本地恒红的 shell 门（水位与 grep）——恒红要先证本片 0 贡献再报告。
6. **活体取证（L4）**：起 dev server（5899）＋本仓 API（8000），用 `npx -y rea-agents@latest` 的可达树读 `画线清单` 那枚开关的 `[pressed]`，
   并跑一次刷新后复读。**判据只写等值关系，不写常量**（批次 A 的口径）。
   前置（矩阵 TV-CI-07 那行实测过，不照做就打不动那枚开关）：零画线时 `画线清单` 那枚按钮 `states` 里逐字带 `disabled,true`，
   必须先走本仓第一方的 `?d=` 分享链接**导入**一条图元（鼠标落点在现行工具词汇表下不可表达），导入后 `disabled` 消失、
   可达名变成 `button "画线清单": 清单 · 1`。这一条也是这一趟「点得动」的唯一凭据。
   这一趟同时是对 CI-07 那条「跨两趟同相」根因的检验：面板初值一旦持久，两趟之间的差别就变成可表达的了——这是**待验的假设**，
   跑出来不符就如实登记，不放宽判据。同趟内连点两次＋`after_each_step` 那条形状照旧留着，两个形状各证各的。
7. **未来函数自查**：本片不产任何指标信号（纯界面态），所以不跑 Bar Replay 五步；这句话本身就是范围声明，不是省略。

## 6. 明确排除（都是裁掉过的，不是忘了）

- **`tradingview.toggle_delete_locked_linetools`（DW-05 的后半个键）**。要做它得拦在库自己的右键删除上——
  `lib/chartDrawings.ts` 头部第 5 条自陈 `lock` 只被 `_figureMouseDownEvent`  honour，选中（8746）与右键删（8774）都无视它；
  库没有「删除前否决」的公开钩子，能走的是 `onRemoved` 之后把那条线救回来，而那会换 id、动清单与存储，
  可行性本身是一个独立的 spike 问题，且 `chartDrawings.ts` 正被别的席改。⇒ 留下一片，先做可行性探针。
  **【2026-10-16 第②片可行性探针席更正】上面这四行里那句「库没有「删除前否决」的公开钩子」**是假的**，原句一字不删。
  同一席现读 `klinecharts@10.0.3` 的发布物（该包只有 dist，无 TS 源）：`dist/index.esm.js:8774` 起 `_figureMouseRightClickEvent`，
  :8779 立 `prevented_3` 旗标、:8780 把 `preventDefault` 连同 `{chart, overlay, figure}` 交给 `overlay.onRightClick`、
  :8783 `if (!prevented_3)` 才在 :8784 调 `removeOverlay(overlay)` ⇒ 公开否决钩子存在，且正好挂在要拦的那条入口上；
  能逐实例挂＝`OverlayImp` 构造 :8275 `this.override(overlay)` ＋ `override` :8280-8281 `merge(this, others)`，而 `merge` :157 对函数是赋值（`isObject` :207 只认 `typeof 'object'`）；
  类型面齐＝`index.d.ts:1041`（`Overlay` 继承 `OverlayEventCollection`）→ `:1145`（`OverlayCreate`）→ `:978`（`createOverlay`／`overrideOverlay` 都收），
  `preventDefault?: () => void` 声明在 `MouseTouchEvent` `:546-550`、经 `OverlayEvent` `:1034` 继承到，不必 cast。
  上面引的两枚 dist 坐标（选中 8746、右键删 8774）**本身没漂**，`chartDrawings.ts` 头部第 5 条那句「`lock` 只被 `_figureMouseDownEvent` honour」（现读 :8732-8734）也仍然成立——
  假的只是从它们推出来的「所以没有否决钩子」。⇒ 这条排除的**理由**被推翻，排除这个动作反而提前结束：第②片应当实现它，形状＝一枚读 `overlay.lock` 的共享 `onRightClick` 守卫（挂在四条入口收敛后的那个 create 漏斗＋`restoreDrawings` 两处），
  自家清单删除按钮那次 `chart.removeOverlay({ id })`（`pages/ProChart.tsx:2351`）另在按钮层判 `lock` 后不调它（公开 API 上没有否决位）。
  两条边界登记：库里根本没有键盘删除（默认热键表只有 `scrollLeft/scrollRight/zoomIn/zoomOut` 四枚，:2132-2137），本仓图上也未绑 Delete 键，所以要拦的入口只有右键＋自家按钮两处；
  且以上全是**静态源码判据**，`preventDefault` 拦住删除**没有在活体上点过**，第②片第一步要起 dev server 真点一次右键。逐字锚与更细的判据见 `docs/forensics/gap-matrix.md` 的 TV-DW-05 格（2026-10-16 第②片那段更正）。
- **DW-04 的「样式／周期／品种三项各成独立键名」**。本仓是一个键装三项（`SESSION_KEY`，写点 792 行）。
  拆键要迁移动已存在的用户会话值，而 L1 那一格自己写了「有没有一个装三项合并值的键，在本批没有证据面」——
  拿一条没有证据面的形状去做破坏性迁移，不符合本仓「只接纳能被数值对账 harness 验证的改进」的取向。⇒ 不跟，并把它记成**刻意分歧**。
- 四枚之外的面板态、滚动位置、缩放比例等「更完整的图表状态持久化」。

## 7. 风险

| 风险 | 处理 |
|---|---|
| jsdom 的 `sessionStorage` 与浏览器语义不同（例如跨挂载共享） | 单测里显式建夹具；活体趟是最终判据，jsdom 只证机制 |
| 会话级 ⇒ 用户以为「我开着的面板怎么又关了」 | 这是照对方 scope 选的，spec 与档案都要写清「关标签回默认」是设计而非 bug |
| `?s=` 那枚 URL 反向打开面板与持久化初值抢写序 | 现读两处 `setIndPanelOpen(true)`：763 在 `openFormulaPanel()` 里（工具栏入口，是一次用户动作），1608 在分享链接取数的 `.then()` 里（异步续体，**不在** mount effect 里）。⇒ 后者必然晚于初值与合成点首跑，后写者胜，行为是「链接优先」；并且这一次真会写进会话键（被链接打开＝下次刷新也记着开着）。页面级针钉这两条 |
| 档案与 L2 矩阵里大量 `file:line` 引用被本片挪号 | 不躲，见 §4.3：第三列 8 枚按内容重钉（`grep` 逐字文本取新号 → `sed -n` 开行确认），说明列保留 2026-10-14 的历史读数、只补一条带日期的追加子句。校验器对漂移是瞎的（`1..n` 恒成立），所以这条只能靠人做，已写进 §5(4) 当验收项 |
| 页面级针要先塞一条画线才点得动 `画线清单`，等于把本片的测试绑在别的席正在改的存储形状上 | 夹具只写一枚最小 `priceLine`（`name`/`paneId`/`points` 三键，抄 `ProChartDrawings.test.tsx:1124-1145` 的既有形状），不依赖 `chartDrawings.ts` 的任何新 API；该片若让桶形状变了，红的会是这条前置而机制三针仍绿——报告里要把这种红如实分成「前置坏」而不是「机制坏」 |

## 8. 本设计轮自查（占位符／矛盾／歧义／范围）

- 占位符：无 TBD／「后续补」；§5 的每条判据都给了可跑的命令或可断言的读数形状。唯一一处「此刻给不出的数」是 §4.3 那句增行数——它要等实现落地才存在，所以本文把它写成「由实现席当场数并写进追加子句」，而不是预先填一个数。
- 一致性：§2 说「只取 DW-05 前半个键」，§4 的键里确实只有可见性四枚，没有删除开关；§6 的两条排除各自给了理由，不与 §4 冲突。
- 歧义：「活过一次刷新」在 §5(2) 被换成 jsdom 里可断言的具体形状（带记录重新挂载读到 pressed），不留在口号层。
- 范围：单片单表面，够一份计划、够一次评审。
- **本轮改过两处**（都发生在实现之前、无人引用过旧文本，故原地改写而不是追加更正）：
  1. §4.2 原先只写「一个 useEffect 当合成点」，没交代它会挪号；发现这一点后先把四种接线形状权衡完（§4.3 的 (B)(C)(D)），
     裁定照本仓先例走 effect 合成点、把漂移当固有代价并配一条重钉任务（§5(4)）。理由＝(A) 与 `:781`／`:790` 两枚同类 effect 同形，
     而行中性方案省下的行数挡不住「任何实现都挪号」这件事。
  2. §4.1 的写侧第一版是「无条件整体写四枚布尔的快照」，理由写成「和 `SESSION_KEY` 同族」；现读 `lib/chartLegend.ts:143-180` 与
     `ProChartLegend.test.tsx:225`／`:255` 后改判——本仓最近的同族先例是**偏差编码＋全默认删键**（`saveLegendPrefs`），
     且 `:781`／`:790` 那两枚无条件写的装的不是「可回落默认的偏好」。改判连带把 §5(1) 从四态扩成五态、§5(2) 多加两根针
     （未动过 ⇒ 键为 `null`；坏值 ⇒ 首挂载删键）。台账里这条记成 `Ruling`。
- **本轮复跑／现读的读数**：§4.3 那张表来自 2026-10-15 在仓库根跑的 `grep -roE "ProChart\\.tsx:[0-9]+" docs tools`（命中分布在 `gap-matrix.md`／`spec/chart-interaction.md`／`l0/self-ci07-panel-toggle.md` 三份取证文档，加上 `docs/superpowers/` 里历片的旧 spec／plan——后者是历史记录，按既有口径不改写）；
  `tools/forensics_audit.py:402-436` 的坐标规则是现读那段 `v.append(...)`；`:2836` 的 disabled 谓词、`:3245` 的遮罩 `onClose`、2750-2756 那枚入口按钮没有 `aria-label`、
  `ProChartDrawings.test.tsx:1124-1145` 的桶夹具、`:781`／`:790` 两枚同类 effect 的形状——都是本轮 `sed -n` 开出来的，不是转述。
