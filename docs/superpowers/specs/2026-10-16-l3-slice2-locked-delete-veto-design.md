# L3 第②片：锁定的画线不可删（TV-DW-05 后半个键）设计

**日期**：2026-10-16　**分支**：`feat/l3-slice2-locked-delete`　**基座**：第①片末端＋三笔文档更正＋一笔画线工具修复（号一律现读 `git log --oneline`）

**一句话**：给图上「锁定」那一枚已有标志补上删除侧的效力——锁定的画线不再被任何用户发起的删除动作删掉，并由一项持久级开关决定这件事。

---

## 0. 这一片在漏斗里的位置，以及它为什么现在能做

L2 矩阵 `docs/forensics/gap-matrix.md` 的 **TV-DW-05** 那一格装着对方的两枚键名（L1 那一格 `docs/forensics/spec/drawings.md` 逐字登记）：会话级的 `ChartFavoriteDrawingToolbarWidget.visible`，与持久级的 `tradingview.toggle_delete_locked_linetools`。第①片落了前者的本仓对应物（四枚图表面板开关的会话级可见性键），后者当时被写进排除项，理由是「库没有『删除前否决』的公开钩子」。

**那个理由是假的**，2026-10-16 的可行性探针席已把它推翻，并在矩阵格／本 spec §6／第①片实现计划／档案 §7.25 四面做了带日期追加更正（原句一字不删）。推翻凭的是同一份发布物里的公开否决面，逐字坐标见下面的 §7。⇒ 本片是实现片，不再欠可行性问题；欠的只有「活体真点一次右键」这一笔，排在验收序第一步。

---

## 1. 判态：本片之后本格仍 `部分`

这条先说死，免得实现完拿升态当交付判据。

TV-DW-05 那格的两半里，本片只落「锁定线可否删除」那一半。另一半「收藏画线工具栏可见性」的**前提控件在本仓根本不存在**——本仓没有收藏画线工具栏（「收藏」只有标的 watchlist，见 `frontend/src/components/charts/WatchList.tsx:91`），矩阵格那句现读已登记过这件事。给一个不存在的控件做可见性开关不是本片范围，也不是「顺手补一下」。

⇒ 判态句要写成：**「只剩收藏画线工具栏那一半没做」**，而不是升 `已有`。这是本仓「盖章范围超出实际所做工」那枚旧病灶的正面处置：判据撑到哪儿就写到哪儿。

---

## 2. 三条自拟边界（必须原样出现在矩阵格与本 spec 里）

1. **键值面从未读过**。L1 那一格只到键名级（对方的 `local_storage_keys[20]` 那一行含这个名字），键名↔界面行为的映射本身就是**据键名推断**。
2. 因此「**开关打开＝允许删除锁定的画线**」这套语义是**本仓自拟规格**，不是对对方页面的复刻主张。本片不声称对方那个键在界面上是正是反、默认是什么——那些都没读过。
3. scope 归属照 L1 写：这一枚属**持久级**（localStorage），与第①片那四枚会话级键不同形；这个不同形是**照登记的 scope 走**，不是本片选的。

---

## 3. 规则：入口清单与一条豁免线

一条规则，五个用户入口，一类永不受约束的程序化删除。

### 3.1 受规则约束（用户发起的删除）

| # | 入口 | 现读坐标 | 本片处理 |
|---|---|---|---|
| 1 | 库的右键点线删除 | 守卫挂在 `frontend/src/lib/chartDrawings.ts:476` 的 `makeDrawingEvents` | 新增 `onRightClick`：`locked && !allowDeleteLocked` ⇒ 调 `preventDefault()` |
| 2 | 清单行「删除」按钮 | `frontend/src/pages/ProChart.tsx:2348`（调用点 `:3194`） | 公开 API 上没有否决位，调用前自己判：受保护 ⇒ 不调 `chart.removeOverlay({ id })` |
| 3 | 工具栏「清空」 | `frontend/src/pages/ProChart.tsx:2279` | 改为**跳过锁定条**：受保护时不再走无参 `chart.removeOverlay()`（`:2282`）整图清，改成逐条删可删的那些；同处的暂存桶清空（`replaceParked([])`）同样保留锁定条 |
| 4 | 工具栏「撤销」 | `frontend/src/pages/ProChart.tsx:2271` → `frontend/src/lib/chartDrawings.ts:921` `removeLatestDrawing` | 取「最近一条**可删**的」，锁定条跳过 |
| 5 | 清单尾部「删除待恢复的画线」（整桶丢弃） | `frontend/src/pages/ProChart.tsx:2112` `discardParked` | 保留暂存桶里的锁定条（`StoredDrawing.lock` 会随存储往返，见 `frontend/src/lib/chartDrawings.ts:422` 与 `:677`） |

**为什么 3／4／5 也要管**：只拦右键与单条按钮的话，一条锁定线仍会被「清空」一键带走，锁定就成了装饰。规则要成立，必须覆盖用户发起的**全部**删除面。

### 3.2 豁免线（程序化删除，永不被规则拦）

| 现读坐标 | 是什么 | 为什么必须放行 |
|---|---|---|
| `frontend/src/pages/ProChart.tsx:1396` | 切标的／切周期的整图清（在 `drawingsMutedRef` 静音里） | 拦下它会把锁定线**粘到另一个标的上**；这是数据归属维护，不是用户删线 |
| `frontend/src/pages/ProChart.tsx:2087`、`:2092` | 进出回放的收纳与半成品丢弃 | 同上，且它删的是要被 parked 接手的同一批线 |
| `frontend/src/lib/chartDrawings.ts:714` | `reanchorOverlay` 的退化丢弃（锚点被吸回后重合成一个点） | 线已经画不出来了，留着只会让清单出现一条图上没有的行 |
| `frontend/src/lib/chartDrawings.ts:911` | `cancelInProgress` | 画到一半的线拿不到锁定标志（锁定开关只长在清单行上） |
| `frontend/src/lib/pineDrawings.ts:357` | 脚本层的按 groupId 清除 | Pine 画的线不是用户的画线，`lock` 结构上不会是 `true`；守卫读的是逐条 `lock`，天然放行 |

> **2026-10-17 实现席更正（原句保留，不删）**：本表最后一行那句「Pine 画的线不是用户的画线，`lock` 结构上不会是 `true`」**在现读代码里是假的**——`frontend/src/lib/pineDrawings.ts:374` 逐字是 `return { name, paneId, groupId, lock: true, zLevel, points, extendData };`，同文件头部注 19 也自陈每条都 `lock`ed。豁免本身仍然成立（`clearPineDrawings` 走 `{ groupId }`，守卫读的是逐条状态；右键那一路又被 `figure.ignoreEvent` 结构性挡掉，`checkOverlayFigureEvent` 在 dist 8223-8230），但**判据形状要收窄一层**：规则只作用于「`lock === true` 且 `toolOf(name)` 命中注册表」的用户画线，与 `applyMagnetMode` 用的同一枚归属过滤。不这么做的话，「清除」改走逐条删之后会**跳过脚本层**，而今天的无参 `removeOverlay()` 是把它们一起删的——一条没人要求的行为差。计划与本片的 `isLockedUserDrawing` 就是这条更正的落点。

**豁免线不是注释，是针**：每条豁免都要有一根「摘掉守卫后它会红」的针。最承重的是 `:1396`——判据形状＝锁定一条线 → 切标的 → 再切回来，锁定线**不**跨标的存活（跨了就是 bug），而在同一标的内切回来仍按存储复现。

### 3.3 开关**开**时＝现状；默认是**关**，所以默认手感会变

`allowDeleteLocked === true`（开关打开＝「锁定线可删」）时，五个入口的行为与本片之前**逐字相同**。这条判据的价值不是「本片无风险」——出厂默认是关（§4），上线当天锁定线就删不掉，**手感确实变了**，那正是 §4 要的效果。它的价值在于把整片的行为差压成一道开关：回归针可以成对写，同一入口开＝现状形状、关＝拦下，两半各自可红，「规则本体是唯一的行为差」才有读数。

---

## 4. 偏好键与 UI

**形状逐字照本仓已有的那枚磁吸偏好键**（`frontend/src/lib/chartDrawings.ts:1028` `const MAGNET_KEY = "pro-chart.magnet.v1";`、`:1031` `loadMagnet`、`:1039` `saveMagnet`）：

- 键名：`pro-chart.delete_locked.v1`
- 值：`"1"` / `"0"`；** Anything but the stored "1" is off**——照 `loadMagnet` 的既有口径，读不到、读坏、被外部写脏一律按 `false`（＝锁定受保护）
- **默认 `false`＝锁定受保护**。默认值的方向不是审美：`lock` 这个标志已经存在一整片了，它此前什么都不挡；本片给它效力，若默认「允许删除」，那上线当天没有任何用户能观察到这道规则，功能等于零。
- 读写各自 `try/catch`、写侧 best-effort（照 `saveMagnet`）。
  - 沿用的是磁吸那枚键的**存储形状与严格读判**，不是它的返回类型：`loadMagnet` 交回 `MagnetMode`（`"normal" | "strong_magnet"`，`:1026`），本片这枚交回 `boolean`。别把联合类型抄过来。
- UI：画线工具栏里一枚按钮，形状照 `frontend/src/pages/ProChart.tsx:2806-2822` 的磁吸按钮——`aria-label` ＋ `aria-pressed` ＋ 双态 `title`（开／关各一句解释），文案**硬编码中文**。
  - 这条是**跟着同一条工具栏的既有惯例**：磁吸、撤销、清空、清单的文案全在 `ProChart.tsx` 里写死中文，一份都不在 `src/i18n/locales/*.json` 里。本片不进 locale，否则同一个工具条上两种文案通道，比现状更糟。
  - `aria-pressed` 与 `title` 的真值面要说「**允许删除**」而不是「保护」——按下＝允许＝现状手感，未按下（出厂默认）＝受保护。这枚开关天然带负负得正的坑：按钮文案写成肯定句「锁定线可删」，别写成「锁定线保护」再把值取反。

按钮文案里要说清**它管什么**：不只右键，而是清单行删除、清空、撤销、暂存丢弃四处一起（§3.1 的表就是给用户看的范围）。

---

## 5. 两条会被踩的实现约束

### 5.1 守卫必须在**点击那一刻**读偏好，不能在创建时捕获布尔

`makeDrawingEvents` 的返回对象会被 `...events` 摊进 `createOverlay`（`frontend/src/lib/chartDrawings.ts:680`，`restoreDrawings` 与 `ProChart.tsx:2253` 都走这一条），**回调一旦落到 overlay 实例上就活到那条线被删为止**。如果闭包里捕获的是当时的布尔值，用户后来翻开关，先前创建的线仍按旧偏好办事——表现为「我已经打开允许删除了，这条老线还是删不掉」。

⇒ 守卫闭包读 **ref**（本仓已有这个形状：`magnetRef`／`haRef`／`vpRef` 全都是为同一个病存在的），或在 `onRightClick` 触发时现读 `loadDeleteLocked()`。两种里选前者，理由与 `ProChart.tsx:582-588` 那段注释相同：同一个 task 里连点两次，渲染闭包上的旧快照会互相覆盖。

**针**：画一条线并锁定 → 在开关关着的状态下创建守卫 → 翻开关 → 不重新画线，右键那条**已存在的**线 ⇒ 立刻可删。这一根针只有把「翻转后旧实例也生效」写成断言才存在，别用「重新画一条」代替。

### 5.2 入参类型要带 `preventDefault`

库把 `preventDefault` 与 `{chart, overlay, figure}` **并进同一个入参对象**（`dist/index.esm.js:8780`）。本仓现有的 `OverlayEventArg`（`frontend/src/lib/chartDrawings.ts:472`）只有 `overlay?: unknown`，需要加 `preventDefault?: () => void`；`makeDrawingEvents` 返回值的键并集要加 `"onRightClick"`。调用点写 `e.preventDefault?.()`——**可选链是必须的**，测试替身不实现它时守卫只能不否决，而那种降级恰好落在 §3.3「开关开＝现状」的那一侧形状上。

类型面不缺：`Overlay` 继承 `OverlayEventCollection`（`dist/index.d.ts:1041`）⇒ `onRightClick` 进得了 `OverlayCreate`（`:1145`），`preventDefault?: () => void` 声明在 `MouseTouchEvent`（`:546`–`:550`）经 `OverlayEvent`（`:1034`）继承到 ⇒ **不需要 cast**。

---

## 6. 两枚纯函数（先写针再写码）

规则本体拆成两枚不碰库的纯函数，页面与守卫都只调它们：

1. `canDeleteDrawing(locked: boolean, allowDeleteLocked: boolean): boolean`
   —— 四行真值表。唯一一行 `locked && !allowDeleteLocked ⇒ false`，其余三行全 `true`。这是整片的裁判。
2. `partitionDeletable(entries: readonly T[], allowDeleteLocked: boolean, lockedOf: (e: T) => boolean): { deletable: T[]; kept: T[] }`
   —— 给 §3.1 的三个批量入口（清空、撤销、暂存丢弃）共用。**撤销不另写一套挑选逻辑**：撤销＝从 `deletable` 里取最后一条，`kept` 非空时按钮 title 要说「N 条被锁定跳过」，否则用户按了没反应会当成按钮坏了。

两枚都放 `frontend/src/lib/chartDrawings.ts`，与 `applyDrawingFlags`（`:754`）同区。理由：本仓画线的标志语义已经住在这儿，另起一个模块会让「lock 到底管什么」再次分家。

**变异自证**至少覆盖三枚：把 `canDeleteDrawing` 写成恒 `true`（必红：守卫针与批量针全掉）、把豁免线改成也判 lock（必红：切标的那根）、把 §5.1 的 ref 读法换成创建时捕获布尔（必红：翻转生效那根）。第三枚是本片最容易「测了个寂寞」的地方——它只有真翻转一次开关才有读数。

---

## 7. 库事实（发布物只有 dist，无 TS 源；以下全是静态读）

`klinecharts@10.0.3`，`frontend/node_modules/klinecharts/dist/index.esm.js`：

- `:8774` `OverlayView.prototype._figureMouseRightClickEvent = function (overlay, _figureType, _figureIndex, figure) {`
- `:8779` `var prevented_3 = false;`
- `:8780` 把 `preventDefault` 连同 `{chart, overlay, figure}` 喂给 `overlay.onRightClick`
- `:8783` `if (!prevented_3) {` → `:8784` `...getChartStore().removeOverlay(overlay);`
  ⇒ **右键删除有一枚公开的删除前否决**，回调里调一次 `preventDefault()` 就结构性地不删。
- 回调可事后挂：`OverlayImp.prototype.override`（`:8280`–`:8281`）把除 `id/name/currentStep/points/styles` 之外的键全交给 `merge(this, others)`（`:157`），而 `isObject`（`:207`）只认 `typeof 'object'` ⇒ 函数键被赋值。本片**不需要**走这条路（走 `...events` 一条通道就够），登记它只是为了别让下一席以为挂不上。
- 库里**没有键盘删除**：默认热键表只有 `scrollLeft/scrollRight/zoomIn/zoomOut` 四枚（`:2132`–`:2137`）。⇒ 不存在「要拦 Delete 键」这件事。
- `lock` 只被 `_figureMouseDownEvent` honour（`:8732`–`:8733`），右键那条通篇不读 `lock` ⇒ 库自己**不会**挡，必须本仓挂守卫。这条与 `chartDrawings.ts` 头部第 5 条自陈一致，仍然成立。
- 全库 `removeOverlay` 三处命中：`:8784`（右键）／`:14459`（store 实现，先 `onRemoved` 后 splice）／`:15403`（`ChartImp` 转发）。⇒ 库自己的删除入口只有右键一条，其余都是本仓调用。
- 另一枚否决面 `figure.ignoreEvent`（`dist/index.d.ts:1024`，判定在 `:8223`–`:8230`）本片**不用**：它按图元/事件名生效，粒度不对，且双写两道否决会让「为什么没删」有两个答案。

---

## 8. 验收序

1. **活体先还探针欠的账**（不落任何代码）：起 dev server，画一条线 → 锁定 → 在页面上用 `overrideOverlay` 临时挂一枚 `onRightClick`（回调里 `preventDefault()`）→ 真点右键 → 读回 `getOverlays()` 条数。§7 整节是静态判据，这一步把它变成活体读数，并落一份 L0（`docs/forensics/l0/self-dw05-lock-veto.md`，格式照同目录既有自家页记录）。
   - 若这一针活体**没**拦住，本片停止，回来改设计——这是唯一能让后续任务白写的失败模式，所以它排第一。
2. TDD 实现：先 `canDeleteDrawing` 真值表四行 → 守卫 → 五个入口 → 豁免线。
3. 六道门：`npx tsc -b`／`npx vitest run`／`npm run build`／wiki 两面（`tools/test_wiki_drift.py`＋`tools/test_wiki_qmind.py`）／`python -X utf8 tools/forensics_audit.py`／`python -X utf8 -m pytest tools/test_forensics_spec.py -q`。
   - **注意**：`tools/test_forensics_spec.py` 没有 `__main__`，`python -X utf8 tools/test_forensics_spec.py -q` 会以 rc=0 零输出假绿，必须走 `-m pytest`（第①片实测踩过）。
   - 本机两枚恒红门（水位、grep）要按交集证据证明本片 0 贡献，不靠感觉。
4. 活体回归：五个入口逐个真点一遍（右键／清单行删除／清空／撤销／暂存丢弃），加上开关翻到「允许删除」再逐个点一遍——**两组都要点**，因为 §3.3 那条成对判据讲的是「开＝现状、关＝拦下」，只点一组读不出规则本体是唯一的行为差。
5. 未来函数自查：本片不碰行情读数，仍走一遍画线不漂移自查（锁定态与偏好翻转不该改几何）。
6. 文档面：矩阵格带日期追加（判态仍 `部分`＋新锚指 `chartDrawings.ts` 里新键的**当片产出**坐标，现读再写）→ 档案 §7.26 排**最后一笔**。

**工作树纪律**：本片全程 `git commit -s -- <path>` 分面提交；档案面永远最后一笔。

---

## 9. 明确排除（都是裁过的，不是忘了）

- **`ChartFavoriteDrawingToolbarWidget.visible` 那一半**。要先有那个控件才有可见性可管；本仓没有收藏画线工具栏。造它是一片新范围，不塞进本片。
- **`figure.ignoreEvent` 通道**（§7 末条）。粒度不对，双写否决会让「没删」有两个原因。
- **键盘删除**。库里根本没有这条（`:2132`–`:2137`），无从拦。
- **把锁定态做成「按标的」还是「按图」的迁移**。锁定线跨标的本来就不该存活（§3.2 第一行），本片正好把它钉成针。
- **右键菜单／删除确认弹窗**。库没有这个面，本仓也没有；规则只需「删不掉」，不需要「解释一次」。
- **文案进 9 份 locale**（§4）。同一条工具栏上的其它按钮全是硬编码中文，本片单独 i18n 会造出两种通道。
