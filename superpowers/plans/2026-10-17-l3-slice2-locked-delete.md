# L3 第二片：锁定的画线不可删（TV-DW-05 后半个键）— 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让图上已有的那枚 `lock` 标志在**删除**这一侧长出效力——用户发起的五个删除入口（右键／清单行删除／清除／撤销／删除待恢复）都删不动锁定的画线，并由一枚持久级开关 `pro-chart.delete_locked.v1` 决定这道规则开不开，出厂默认关（＝锁定受保护）。

**Architecture:** 规则本体是 `frontend/src/lib/chartDrawings.ts` 里两枚不碰库的纯函数（`canDeleteDrawing` 四行真值表 ＋ `partitionDeletable` 批量分拣）加一枚归属谓词 `isLockedUserDrawing`；右键那一路经库的公开否决面（`overlay.onRightClick` 里调 `preventDefault()`）由 `makeDrawingEvents` 挂上，其余四路都在库外面自己判——公开 API 上没有否决位。开关的存储形状逐字照本仓已有的磁吸偏好键，读取一律走 ref，因为同一 task 里连点两次会摊到同一份过期闭包快照上。

**Tech Stack:** React 19 ＋ TypeScript ＋ vitest（jsdom）＋ klinecharts v10.0.3（只有 dist，无 TS 源；本页只用测试替身，不改库）。活体那两趟用 REA（`rea-agents`，CDP 单趟）＋ 一枚仓外 scratch 的原始 CDP 客户端（Node 24 自带 `fetch`/`WebSocket`）。不加依赖。

**Spec:** `superpowers/specs/2026-10-16-l3-slice2-locked-delete-veto-design.md`（本计划是它的论证；§3.1 的五个入口表、§3.2 的豁免线表、§4 的键与 UI 规则、§5 的两条实现约束、§6 的两枚纯函数与三件变异自证、§8 的验收序都在那份里。冲突一律以 spec 为准，然后在这里登记裁定。）

---

## Global Constraints

- 不改 `frontend/package.json`／`pyproject.toml`，不装任何依赖，不跑 `rea setup`，不注册 REA 的 MCP。
- 不动 `tools/**`、`.github/**`、`.gitignore`、`wiki/**`（上游拥有）。**本片只读 `tools/forensics_audit.py`，一个字都不写。**
- **域名与键名红线**：`frontend/src/**` 里不许出现 `tradingview.com`，也不许出现对方那枚键名 `tradingview.toggle_delete_locked_linetools`——`tools/forensics_audit.py` 对 `frontend/src` 扫主机串并与白名单做集合等式。本仓那枚新键的名字是自己起的 `pro-chart.delete_locked.v1`；对方键名只属于取证文档面（`forensics/`）。
- 提交一律带 pathspec ＋ `-s`（上游 DCO），一次一个面；`docs/` 被 `.gitignore:125` 忽略，故 `docs/**` 新增件要 `git add -f`。
- 前端命令的工作目录＝`frontend/`；Python 门的工作目录＝仓库根，且一律 `python -X utf8`（中文输出，GBK 会炸）。
- `tools/test_forensics_spec.py` 没有 `__main__`：必须 `python -X utf8 -m pytest tools/test_forensics_spec.py -q`，直接 `python 文件.py -q` 会以 rc=0 零输出**假绿**（第①片实测踩过）。
- 判据写法：活体／像素类只写**等值关系**与**对照关系**，不写期望常量。文档里不写「本文件 N 行／本片共 N 笔／门命中 N 条」这类自指读数；引用行号一律现读，条目序号一律现读（`grep -o '[①-⑦⑧⑨]' | tail -1` 那种），**不要把号钉死**。
- 档案面（仓库根 `项目档案.md`）永远是本片**最后一笔**提交。它是 CRLF 工作树且 `git check-attr text eol` 两个值都 unspecified ⇒ 改动只能在 bytes 层做；数 CR 只用 `tr -cd '\r' < 项目档案.md | wc -c`（`grep -c $'\r'` 在本机读不出 CR，2026-10-16 实测）。
- **合回 `main` 与推 `origin` 各需要用户单独点头**，本片不含这两步；Task 7 结束后停在分支上报告。
- 规格边界（每份产出都要带上）：**scope 归属照 L1 的读数，行为面是本仓自拟**——L1 的 TV-DW-05 那一格自陈「键名↔界面行为＝推断，值面未读」。本片不声称对方那枚键在界面上是正是反、默认是什么。
- 本片不碰行情读数、不产任何指标信号 ⇒ Bar Replay 那五步未来函数自查**不适用**（这是裁掉的，不是忘了；Task 6 Step 6 要写这一句并走「画线不漂移」自查代替）。

## 2026-10-17 执行席追加更正：活体现场由 vite dev 改到后端服务的生产构建（原句保留，不删）

Task 1 与 Task 6 正文里每一处 `http://localhost:5899/pro-chart`（探活、Edge 起始 URL、REA 场景的 `start_url`、`veto.mjs`／`regress.mjs` 的 `BASE`）**一律按 `http://localhost:<后端现读端口>/pro-chart` 执行**，vite dev 不再充当活体现场。

- **触发读数**：Task 1 首趟在 dev 下跑不起来——`?d=` 第一方导入的那条锁定线从未落到**活着的**图表实例（活图 `getOverlays()` 为 0，而存储桶里 1 条、`清单 · 1`、`parkedCount` 0），三腿第一步就起不来，判决只能记「无判决力」。收集式 fiber 扫描只找到一枚图表候选且它 `bars=500`／DOM 在文档内，排除「绑到了旧实例」；把线先种进桶再整页重载的反向对照同样不落，排除「桶内容不对」。机制站点：`ProChart.tsx:1383` 的单槽门 `bars.length > 0 && drawingsKeyRef.current !== key` 配上 `:1490-1501` 的卸载钩子只 `dispose` 不清槽 ⇒ 第二枚图表实例挂载时那道门自己合不上。dev 下 effect 双跑（StrictMode）是触发条件，生产构建不双跑。
- **裁定**：现场换成**后端服务的生产构建**，判据、三腿形状、偏移表、`exit 2` 语义一字不变。准备动作三条：① `frontend/` 下 `npm run build`（`frontend/dist` 若是旧产物，读数归属的就是旧树）；② `python agent/api_server.py --port <现读>` 起后端，日志里 `[prod] Frontend served from …\frontend\dist` 那行才算现场成立；③ **asset 指纹对账**——`curl -s http://127.0.0.1:<p>/pro-chart | grep -o 'assets/index-[^"]*\.js'` 必须等于 `grep -o 'assets/index-[^"]*\.js' frontend/dist/index.html` 里那一枚，因为 SPA 兜底会把任何路径都答成 `200 + HTML`，光看状态码是在探一个旧进程。
- **不在本片**：那个 dev 侧恢复缺陷（以及它的下游后果——恢复没跑而页面以为有 1 条画线，下一次换周期时 `bankDrawings` 交回空列表，那条线在 dev 下被静默清掉）不改任何仓内代码去治，登记后另行处置。**不许**为了让 dev 现场跑通而调整页面代码——那是范围重定。
- **代价**：Task 6 每改一轮 `frontend/src/**` 都要重跑一次 `npm run build` 才能取活体读数（它本来就要跑这道门）；本计划正文里那些 dev URL 留着当历史读数，读的时候记得这条更正。


## 2026-10-17 控制席追加更正（二）：主机红线的真规则是**集合等式**，不是「`frontend/src` 一处不许出现」

上面 Global Constraints 那句「`frontend/src/**` 里不许出现 `tradingview.com`」**写法过严，与 `tools/forensics_audit.py` 的实际判据不符**（原句保留，不删）。真规则现读该文件 `audit_tv_host_allowlist`（本席现读起于 `:618`）：扫 `frontend/src` 下 `TV_SCAN_SUFFIXES` 那些扩展名，取「文件正文小写比较后含 `tradingview.com`」的**文件集合**，与 `TV_HOST_ALLOWLIST` 五枚（`components/chat/PineScriptViewer.tsx`／`lib/__tests__/scriptExchange.test.ts`／`lib/pineLang.ts`／`lib/scriptLibrary.ts`／`pages/TVChart.tsx`）做**集合等式**——`新增` 与 `消失` 两个方向都算违规（后者措辞是「白名单该同步收紧」）。另有两条独立的尺：`s3.tradingview` 只许出现在 `frontend/src/pages/TVChart.tsx`，且那文件里两枚逐字主机子式不许被改。⇒ 本片合规判据收窄成两条：① 本片碰过的 `chartDrawings.ts`／`ProChart.tsx`／两份测试都不许长出 `tradingview.com`（它们不在白名单里，新增即红）；② 对方键名 `tradingview.toggle_delete_locked_linetools` 只属于 `forensics/`。**任何一方都不许「顺手清掉」那五枚既存命中**——那会让集合等式右倾、把门跑红；本片也明令不改 `tools/forensics_audit.py`。

## 2026-10-17 控制席追加更正（三）：Task 7 Step 5 第一笔的 pathspec 少一份文件（评审席发现，原句保留）

`bb56c6a8` 给 Step 2 加的「补引用＋翻 `用途`」两半同笔那条，落到 Step 5 的命令面上是**接不住的**：第一笔 pathspec 只有 `forensics/gap-matrix.md forensics/spec/drawings.md`，而 `用途` 那一行住在 `forensics/l0/self-dw05-lock-veto.md`。带 pathspec 的提交（本仓规矩：脏树上禁用裸 `git commit`）会把改 `用途` 那行**永远留在工作树**，于是 `bb56c6a8` 自己禁的「长期挂 `基线`」照样成真。⇒ Step 5 第一笔的 `git add` 与 pathspec 都要加上那第三份文件；Task 7 简报按本节重抽。

## 2026-10-17 控制席追加更正（四）：中间提交可以 tsc 红，但从本条起「改签名」与「改它的消费者」必须同笔（Task 4 评审席判定，控制席裁定）

盘面事实（控制席自己 `git show` 双证，非席位自述）：`807a8b36` 那棵树 lib 已声明必填 `allowDeleteLocked: () => boolean` 而页面零命中该键；`4eee3cab` 那棵树 lib 的 `removeLatestDrawing` 已是两参而页面仍单参调用。两笔**单独 checkout 都过不了 `tsc -b`**；分支顶端绿（控制席现跑 `tsc -b` exit 0、两文件 186 passed、全量 2375）。成因是 Task 3/4 Step 8 明文要求的拆分（lib 一笔、页面一笔），不是执行席走偏。

**裁定＝接受现状，不重写历史；规则即刻生效于 Task 5/6/7，不追溯已落笔。** 判据三条：① 今天可证的伤害为零——本仓没有任何按笔跑的关卡（`.github/**` 本片禁改，门只在分支顶端跑），也没有任何步骤 checkout 中间提交（Task 6 简报现读零处 `checkout`／`git show`，活体只打 HEAD 构建出来的 prod）；② 这四枚 SHA 已被三处文本与一枚评审包文件名当数据引用，squash 会当场造出本片最严禁的**陈旧引用面**；③ 双向代价不对称——现在就 squash 若判错，代价是一次便宜的重写（reflog 兜住）；若本条规则写错方向、后面继续拆，代价是整片 bisect 报废＋一次多笔重写。

因此**未来的拆分规则**：面拆分只许用于**没有接口差**的东西（实现与它的针、码与文档）。一处改了导出函数的形参／返回形状／必填钩子，消费者必须进同一笔——哪怕那意味着一笔同时碰 `lib` 与 `pages`，也比留一棵编译不过的中间树便宜。红笔名单要点名进 Task 7 的档案面（`807a8b36`、`4eee3cab`），让将来真要 bisect 的人知道起点在哪。

## 2026-10-17 控制席追加更正（五）：Task 4 的文案面漏了「归属」那一问 ⇒ 落进 Task 5 的 Step 5b（评审席 plan-mandated Important-1）

Task 4 评审席判**规格 ✅／质量批准**，两条 Important 都带 plan-mandated 标签，第一条是本片自己的口径漏：简报 Step 3 立起来的那句「用行上的 `locked` 会把 Pine 那种 `lock:true` 的装饰也一并拦下」只落到了**拦截面**，删除按钮的 `title` 沿用行级 `locked`。控制席现读复核成立：`describeDrawing`（`chartDrawings.ts:905-910`）不按 `toolOf` 滤⇒Pine 四装饰在清单里有行且 `locked` 为 true，而 `removeDrawing` 问归属、点下去删得动 ⇒ 那句 `title` 对这几行是假话。⇒ 修一行＋一根针，写进 Task 5 Step 5b（Task 5 本来就在改同一枚测试文件，且它的 M2 变异正好是这根针的判别力来源）。

第二条 Important（`bucket`／`disabled`／`reload` 在本文件被复制成第三份）**裁定为接受、不重构**：简报以 `noUnusedLocals` 为由要求 describe 内重声明，但把三枚 helper 上提到文件作用域同样不违规——那要改动三枚既有 describe 的体，diff 与本片无关且会把 Task 4/5 的针坐标全推走。登记为已知形状：本文件此后**同名 helper 有多份**，读针的人要先认准 describe。Step 5c 只收三处小账（本片自己写旧的引用行号改按名引用、`every()` 的空集合真空真补一条计数、`bucket()` 的 `?? []` 把「键没了」抹平那一档改强），不开修复席。

## 2026-10-17 控制席追加更正（六）：Task 6 的三件执行期写实与一句措辞限定（活体席登记，控制席复核坐标后落这里）

其一，**简报 Step 3 那段 `clickByLabel("画线清单")` 按字面跑会自己拆自己的台**：`drawPanelOpen` 的初值来自 `loadPanelVisibility().drawings`（`frontend/src/lib/chartPanels.ts:46`，键不存在时回落默认四枚全 false ⇒ 一次性 profile 进页面时面板是**关**的），而行内删除按钮与暂存条都在 `{drawPanelOpen && ( … )}`（`frontend/src/pages/ProChart.tsx:3167`）里面；那枚按钮是 toggle 不是「打开」，同一趟里点第二次会把它关掉，ON 态的入口 2 读成 `NO_ROW_BUTTON`、入口 5 读成 `NO_PARKED_STRIP`。执行席按简报那句括号里的意图（「面板得先开着」）实现为「先读 `aria-pressed`，只在 false 时点」，并把 before/after 打进 log。⇒ **这是可达性写实，十格判据一格没松**；本仓「toggle 第二次点击是 close」那枚旧坑在此处又出现了一次，写活体脚本的人按本条改口，别再抄无脑点一次。

其二，**Edge 的 `--start-url` 不保证生效**：第一趟 `/json/list` 里的 page 是 `edge://sync-confirmation-dialog/` 与 NTP，没有 `/pro-chart` ⇒ `connect("/pro-chart")` 首跑抛 `no page containing /pro-chart`；第二趟同一条命令自己好了。执行席的出路是新写一枚**仓外一次性**脚本连浏览器级 CDP 端点（`/json/version` 的 `webSocketDebuggerUrl`）打 `Target.createTarget` 开页，`cdp.mjs` 一字未改（控制席现读 mtime 14:29 早于本趟 18:20）。⇒ 下一片的活体席照这个形状预备兜底，别把它当「网络/后端没起」。

其三，**「提示条的坐标」在简报注释里已经漂**：现读 `ProChart.tsx:3046-3050` 是那枚 `<span className={cn("text-xs", …)}>`，`drawNotice.text` 在 `:3049-3050`（简报写的 `2953-2968`／`:2958` 作废）。脚本本来按 class＋文案取，所以代码不用改——但**读数的人要用「三元链」而不是「有没有一句 text-xs」判「无提示」**：`已画 N 条 · 随标的与周期保存…` 这一句只可能在 `drawNotice === null` 时渲染，所以它出现在 ON 态正是「没有拦截提示」的实证。

其四，**「两态差集恰好等于锁定线在不在」这句在撤销那一路要加限定**：一次撤销只删一条，开关只决定**删哪一条**——关着时跳过锁定线删掉没锁那条（图上余 `{L}`），开着时删掉最新那条＝锁定线（余 `{F}`）。⇒ 表格那两格分别就是这两个期望、读数逐格符合，但成立的方式是「锁定线的去留是唯一被规则改变的那一格」，不是字面的「图上余集只差一枚 `L`」。

## 2026-10-17 控制席追加更正（七）：Task 7 简报里四枚「命令接不住」的占位符与一处自相矛盾，给定值如下（执行席别再猜）

1. **矩阵格新增块的圈内序号**：Step 2 那段追加文本开头写 `<现读下一枚圆圈号>`、内部四枚却写死 `②③④⑤`。本格是**单物理行、圈号跨块唯一**（既有那句「本格⑤里那句」就依赖它），两套编号混用从此歧义。⇒ 当趟现读 `gap-matrix.md:86` 的圈号末位是 `⑦`、`grep -co '[⑧⑨⑩⑪⑫]'`＝0 ⇒ **新块五枚内部标记用 `⑧⑨⑩⑪⑫`**，简报里那四个 `②③④⑤` 只按「第 2…5 项」的位置读，落笔时换号。执行席落笔前自己再确认一次 ⑧-⑫ 仍是 0 命中。
2. **「`grep -n "L0 依据"` 在本计划正文里无输出」这句已经过时**：它记的是 `87bd946d` 那一站；`bb56c6a8` 把那一步补进来之后，本计划自己就是它的命中。⇒ 重跑拿到**非空不是失败**；L0 记录「偏差」节那条带日期追加更正要按「那句话在它被写下的那一站是真话」来写，原句不删。
3. **基座号（简报两处占位、正文从未记过）**：Step 3 的「基座 `<现读 git log --oneline -1 的短号>`」在落档案那一刻读到的是文档面第一笔，不是基座；Step 6 的「计划开头记录的基座短号」在计划里查无此号。⇒ **给定 `BASE = 390bdd59`**（本片实现计划那一笔；Task 1-5 的归属证明与 `git diff --name-only` 交集证据都以它做起点，换号等于换树）。分支在 `390bdd59` 之前另有六笔（`fce89e4f`／`9e990ea4`／`28523a04`／`a36a61d8`／`f0f1b53d`／`f31112db`＝探针席与设计席的文档面，加一枚与本片无关的趋势线 fix），merge-base＝`1337c535`。§7.26 标题按 §7.25 的形状写 `基座 `390bdd59``，并在「这一节管什么」那条里用一句话记明「分支起点之前另有六笔，不在本片记账范围」。
4. **矩阵行与 L1 行的列位**：两行 `awk -F'|'` 都读 **NF＝7**（＝5 个数据列，判据是「改前后 NF 相等且＝7」，不是简报那句「6 根竖线」当成 NF 目标）。矩阵追加进**末列（说明列）**；L1 那行的带日期小句进**第 4 列（判据列）**末、`self-dw05-lock-veto.md` 进**第 6 列（`L0 依据` 列）**末，形状照该列既有那两枚的顿号分隔。
5. **改档前两枚读档门的基线**（控制席当趟自跑，`forensics audit: clean` rc=0／`test_forensics_spec.py` 166 passed rc=0）：执行席改完若读到非 0，那是自己改红的，别当成「本机恒红那一族」。

## 判态与交付边界（先说死，免得拿升态当判据）

本片只落 TV-DW-05 那一格的「锁定线可否删除」这一半。**另一半（收藏画线工具栏可见性）的前提控件在本仓不存在**（本仓「收藏」只有标的 watchlist，见 `frontend/src/components/charts/WatchList.tsx:91`）。⇒ Task 7 写矩阵格时判态句必须是**「本格仍 `部分`，只剩收藏画线工具栏那一半没做」**，不许升 `已有`。

## 一处对 spec 的裁定（执行前必读）

spec §3.2 最后一行说 Pine 脚本画的线「`lock` 结构上不会是 `true`」。**这句在现读代码里是假的**：`frontend/src/lib/pineDrawings.ts:374` 逐字是

```ts
    return { name, paneId, groupId, lock: true, zLevel, points, extendData };
```

同文件头部注 19 也自陈「every drawing is `lock`ed + `ignoreEvent`」。后果：清除／撤销／暂存丢弃若只问 `lock`，开关关着时脚本层会被「跳过」，而今天的无参 `chart.removeOverlay()` 是把它们一起删掉的 ⇒ 那是一条本片不该造出的行为差。

**Ruling：规则只作用于「用户自己的画线」，判据形状＝`lock === true` 且 `toolOf(name)` 命中工具注册表**（与 `applyMagnetMode` 用的同一枚归属过滤，`chartDrawings.ts:1069`）。这样：Pine 的 `lock: true` 装饰在批量删除里照旧被删（＝现状），右键那一路本来就因为 `ignoreEvent` 打不到它（`checkOverlayFigureEvent`，dist 8223-8230）。代价：多一枚谓词、多两根针。**并要在 Task 2 给 spec 那句写一条带日期的追加更正（原句一字不删）**——这是本仓「盖章范围超出实际所做工」那枚旧病灶的正面处置。

---

## 文件结构（谁负责什么）

| 文件 | 本片里它的职责 |
|---|---|
| `frontend/src/lib/chartDrawings.ts` | 规则本体（两枚纯函数＋一枚归属谓词）、偏好键读写、`makeDrawingEvents` 的右键否决守卫、批量删除的图侧封装 |
| `frontend/src/lib/__tests__/chartDrawings.test.ts` | 上述每一项的针；替身 `overlay()`／`fakeChart()` 要认 `onRightClick` |
| `frontend/src/pages/ProChart.tsx` | 五个用户入口的接线、开关状态与 ref、工具栏按钮、四处文案 |
| `frontend/src/pages/__tests__/ProChartDrawings.test.tsx` | 页面级针；替身 `rightClickDelete()` 必须照抄库的否决顺序（本片的关键改造） |
| `forensics/l0/self-dw05-lock-veto.md` | Task 1 的活体否决读数（新建） |
| `forensics/gap-matrix.md`、`forensics/spec/drawings.md` | Task 7 带日期追加（各一行的行内追加） |
| `项目档案.md` | Task 7 最后一笔 |
| 仓外 scratch：`$TEMP/rea-l3t1/cdp.mjs`、`veto.mjs`、`regress.mjs` | 原始 CDP 客户端与两批活体脚本；**不进仓库**，L0 里按绝对路径登记并注明会随系统清理消失 |

---

### Task 1：活体先还探针欠的账（不落任何仓内代码）

**Files:**
- Create（仓外）：`$TEMP/rea-l3t1/cdp.mjs`、`$TEMP/rea-l3t1/veto.mjs`
- Create：`forensics/l0/self-dw05-lock-veto.md`
- Modify：无仓内代码

**Interfaces:**
- Consumes: 当前分支的 HEAD 树（守卫还没写，本趟读的是**改动前**的页面——这正是探针欠的那笔账）
- Produces: spec §7 那组静态判据的活体读数；一份门合法的 L0；以及一条硬闸门——**若 `preventDefault()` 在活体上拦不住删除，本片停止，回来改设计**（spec §8 第 1 步：它是唯一能让后续任务全白写的失败模式）。

**判据形状（三腿对照，缺一腿就读不出因果）**

| 腿 | 页面上挂了什么 `onRightClick` | 期望 | 这一腿挡掉哪种假说 |
|---|---|---|---|
| A | 什么都没挂 | 右键**删得动** | 「手势/坐标根本没落到库里」 |
| B | 挂回调，**只计数不拦** | 右键**删得动**，且计数 == 1 | 「挂了回调这件事本身就让它活下来」（即 C 的活下来不是否决的功劳） |
| C | 挂回调 **并调 `preventDefault()`** | 右键**删不动**，且计数 == 1 | ——这是本片的判据本体 |

只写 A 与 C 是不够的：那样「C 活下来」有两种解释。**A 先跑并负责定坐标**（扫偏移直到真的删掉，赢了的那个 `dy` 就是 B／C 用的坐标）；B、C 若在同一坐标下没读到期望形状，按 Step 7 分诊，不下结论。

- [ ] **Step 1：记账起点**

```bash
cd "E:/Vibe-Trading-main/Vibe-Trading-main"
git rev-parse --abbrev-ref HEAD
git rev-parse --short HEAD
git status --porcelain
```

三行逐字进报告。工作树除 `.superpowers/`（本技能自己的 git-ignored scratch）外应当干净；不干净就如实写「dev server 走工作树，本趟读数含未提交的 X」——这句决定读数的归属边界。

- [ ] **Step 2：起两个进程（日志落仓外）**

```bash
mkdir -p "$TEMP/rea-l3t1"
cd "E:/Vibe-Trading-main/Vibe-Trading-main/agent"
python api_server.py > "$TEMP/rea-l3t1/backend-start.txt" 2>&1 &
cd "E:/Vibe-Trading-main/Vibe-Trading-main/frontend"
npm run dev > "$TEMP/rea-l3t1/frontend-start.txt" 2>&1 &
```

后端必须起：只起 vite 时 `/pro-chart` 的可达树带「无法连接 API 服务」，画布上没有 K 线，锁定线也恢复不出来。**端口要当场开那一行确认还在**（`frontend/vite.config.ts` 的 `apiTarget` 与 `port`），别抄本文写的数字。探活（数字来自上一行现读）：

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8000/health
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:5899/pro-chart
```

- [ ] **Step 3：起 headless Edge，取 CDP 现场的 PID 与 target_id**

只访问 `localhost`，所以带 `--no-proxy-server`（这是自家页既有 L0 记录的形状；`msedge.exe` 不在 PATH 上，必须写绝对路径）：

```bash
"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  --headless=new --no-proxy-server --remote-debugging-port=9222 \
  --user-data-dir="$TEMP/rea-l3t1/edge-profile" --window-size=1100,800 \
  "http://localhost:5899/pro-chart" > "$TEMP/rea-l3t1/edge-start.txt" 2>&1 &
netstat -ano | grep ":9222" | grep LISTENING
npx -y rea-agents@latest list-browser-targets '{"browser":{"mode":"connect","cdp_endpoint":"http://127.0.0.1:9222"}}' | tee "$TEMP/rea-l3t1/targets.txt"
```

PID 从 `netstat` 现读，核身只用 `tasklist //FI "PID eq <号>"` 读一次。**红线**：任何清理只按这个 PID 走，绝不按镜像名杀 `msedge.exe`（用户明确要求过）。`target_id` 取这一趟现读值，不许沿用旧记录里那枚号（浏览器进程一换即作废）。

`--user-data-dir` 指在 `$TEMP` 下＝一次性 profile：本趟往 localStorage 里种什么都不会碰到用户真实浏览器数据，这条要写进 L0 的 `观察条件`。

- [ ] **Step 4：生成两条分享码并**逐字**自证**

锁定那条的 `?d=` 码要能被自家解码器认出来，所以现场生成、现场回读，不要信任何文档里抄的串：

```bash
node -e '
const b64u = (s) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const un = (s) => Buffer.from(s.replace(/-/g,"+").replace(/_/g,"/"), "base64").toString("utf8");
const base = { name: "horizontalStraightLine", paneId: "candle_pane", points: [{ timestamp: 4102444800000, value: 1700 }] };
const code = JSON.stringify({ v: 2, d: [base] });
const locked = "j" + b64u(JSON.stringify({ v: 2, d: [{ ...base, lock: true }] }));
console.log("LOCKED", locked);
console.log("BACK  ", un(locked.slice(1)));
' | tee "$TEMP/rea-l3t1/code.txt"
```

判据：`BACK` 那一行逐字含 `"lock":true`，且 `name`/`paneId` 与 `LOCKED` 解码前一致。这两个串里 `LOCKED` 是本趟 `start_url` 用的码；它证明的是「第一方导入通道能把锁定态带进图」，与 `forensics/l0/self-dw05-panel-session.md` 第①片那趟用的是同一条通道（那枚码逐字没有 `lock`，本枚多了 `,"lock":true`——把两串 `diff` 一下贴进报告，形状差异应当**只有**这一处）。

- [ ] **Step 5：REA 导入趟（这是 L0 的 `命令：` 主键与 `evidence_id` 来源）**

`<tid>` 换成 Step 3 现读值，`<LOCKED>` 换成 Step 4 现读值。命令逐字**先 `tee` 成 `$TEMP/rea-l3t1/setup.cmd` 再执行**（命令行本身要留档是取证纪律的一部分）：

```bash
cd "$TEMP/rea-l3t1"
npx -y rea-agents@latest capture-browser-scenario '{"browser":{"mode":"connect","cdp_endpoint":"http://127.0.0.1:9222","target_id":"<tid>"},"start_url":{"url":"http://localhost:5899/pro-chart?d=<LOCKED>"},"actions":[{"step_id":"s1","action":"wait_for_timeout","duration_ms":9000}],"storage":{"cookies":[],"local_storage":[],"session_storage":[]},"secrets":[],"capture":{"after_each_step":[],"at_end":["url","accessibility"],"events":[],"network":{"request_body":false,"response_body":false,"header_values":false}}}' --filter-output evidence_id,normalized_result --token-limit 150000 > setup.out
sed -n '1p' setup.out
```

`sed -n '1p'` 那一行就是 `evidence_id`，**同趟**取，不抄别的趟。判据：该趟可达树里那枚按钮的可达名含 `清单 · 1` 且**不带** `disabled`（计数用 `grep -o` 数，读数进报告）。

这一趟**只**负责「锁定线经第一方通道进来了、并且活在清单上」；删除否决由 Step 6 的原始 CDP 腿负责，两条通道在 L0 里分别署名。

- [ ] **Step 6：写 CDP 客户端与三腿脚本（仓外）**

`$TEMP/rea-l3t1/cdp.mjs`——Task 6 复用同一份，所以它是模块不是脚本：

```js
// 原始 CDP 客户端：只用到 Node 24 自带的 fetch / WebSocket，不装任何依赖。
const HTTP = "http://127.0.0.1:9222";
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function connect(urlPart) {
  const list = await (await fetch(`${HTTP}/json/list`)).json();
  const page = list.find((t) => t.type === "page" && String(t.url).includes(urlPart));
  if (!page) throw new Error(`no page containing ${urlPart}; urls=${JSON.stringify(list.map((t) => t.url))}`);
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let mid = 0;
  const pending = new Map();
  ws.onmessage = (m) => {
    const d = JSON.parse(m.data);
    if (d.id && pending.has(d.id)) { pending.get(d.id)(d); pending.delete(d.id); }
  };
  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++mid;
      pending.set(id, (d) => (d.error ? rej(new Error(`${method}: ${JSON.stringify(d.error)}`)) : res(d.result)));
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send("Page.enable");
  await send("Runtime.enable");
  const ev = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`page threw: ${JSON.stringify(r.exceptionDetails).slice(0, 500)}`);
    return r.result.value;
  };
  const click = async (type, x, y, button) => {
    await send("Input.dispatchMouseEvent", { type, x, y, button, clickCount: type === "mousePressed" ? 1 : 0 });
  };
  return {
    send,
    ev,
    sleep,
    async rightClickAt(x, y) {
      await click("mouseMoved", x, y, "none");
      await sleep(120);
      await click("mousePressed", x, y, "right");
      await click("mouseReleased", x, y, "right");
      await sleep(200);
    },
    async go(url) {
      await send("Page.navigate", { url });
      await sleep(500);
    },
    close: () => ws.close(),
  };
}

/**
 * React fiber 全树扫描取图表实例。旧手法「在 `[tabindex]` 容器上找 fiber 键」会随
 * build 漂（本项目实测过那个容器 `Object.keys(el)` 为空），所以扫全文档再 BFS
 * `hook.memoizedState`，用方法探针认实例。
 */
export const FIND_CHART = `(() => {
  const els = Array.from(document.querySelectorAll("*"));
  const keyed = els.find((e) => Object.keys(e).some((k) => k.startsWith("__reactFiber$")));
  if (!keyed) return "NO_FIBER";
  const k = Object.keys(keyed).find((x) => x.startsWith("__reactFiber$"));
  let f = keyed[k];
  while (f.return) f = f.return;
  const seen = new Set();
  const q = [f];
  while (q.length) {
    const n = q.shift();
    if (!n || seen.has(n)) continue;
    seen.add(n);
    let h = n.memoizedState;
    for (let i = 0; h && i < 60; i++, h = h.next) {
      for (const cand of [h.memoizedState, h.memoizedState && h.memoizedState.current]) {
        if (cand && typeof cand.getOverlays === "function" && typeof cand.getDataList === "function") {
          window.__c = cand;
          return "OK";
        }
      }
    }
    if (n.child) q.push(n.child);
    if (n.sibling) q.push(n.sibling);
  }
  return "NO_CHART";
})()`;
```

`$TEMP/rea-l3t1/veto.mjs`：

```js
import { connect, FIND_CHART, sleep } from "./cdp.mjs";

const BASE = "http://localhost:5899/pro-chart"; // 端口现读，与计划 Step 2 的探活值对齐
const CODE = process.argv[2];
if (!CODE) throw new Error("usage: node veto.mjs <j... 分享码>");
const out = [];
const log = (...a) => { const s = a.join(" | "); out.push(s); console.log(s); };

const b = await connect("/pro-chart");

/** 导一次、拿到实例、等锁定线真的上图（恢复发生在 API 数据落地之后）。 */
async function boot(tag) {
  // 先清掉上一趟留下的画线桶，再带码进页面：`boot` 的判据是「图上恰好一条、且它锁着」，
  // 桶里有残留就永远等不到这个形状。profile 是本趟一次性起的，清它不碰任何真实数据。
  await b.go(BASE);
  await b.ev(`(() => { localStorage.removeItem("pro-chart.drawings.v1"); return Object.keys(localStorage).join(",") || "EMPTY"; })()`);
  await b.go(`${BASE}?d=${CODE}`);
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    const r = await b.ev(`(() => {
      if (!window.__c || typeof window.__c.getOverlays !== "function") {
        const found = (${FIND_CHART});
        if (found !== "OK") return "chart-not-found: " + found;
      }
      const list = window.__c.getOverlays();
      const locked = list.filter((o) => o.lock === true);
      return locked.length === 1 && list.length === 1 ? "ready " + list.length : "waiting " + list.length + "/" + locked.length;
    })()`);
    if (String(r).startsWith("ready")) { log(tag, "boot", r); return; }
    if (i === 59) throw new Error(`${tag}: locked line never landed on the chart — last ${r}`);
  }
}

const ids = () => b.ev(`window.__c.getOverlays().map((o) => o.id + (o.lock === true ? "=locked" : "=free")).join(",") || "NONE"`);

/** 把这条锁定线搬到蜡烛面板的正中央，并回传该点的视口坐标（搬了之后再量，坐标才自洽）。 */
async function aim(tag) {
  const g = JSON.parse(await b.ev(`(() => {
    const c = window.__c;
    const el = c.getDom("candle_pane", "main");
    const r = el.getBoundingClientRect();
    const p = c.convertFromPixel({ x: r.width / 2, y: r.height / 2 }, { paneId: "candle_pane" });
    if (!p || typeof p.value !== "number" || typeof p.timestamp !== "number") {
      return JSON.stringify({ err: "convertFromPixel gave " + JSON.stringify(p) });
    }
    const o = c.getOverlays().filter((x) => x.lock === true)[0];
    if (!o) return JSON.stringify({ err: "no locked overlay to aim" });
    c.overrideOverlay({ id: o.id, points: [{ timestamp: p.timestamp, value: p.value }] });
    const back = c.convertToPixel({ timestamp: p.timestamp, value: p.value }, { paneId: "candle_pane" });
    if (!back || typeof back.y !== "number") return JSON.stringify({ err: "convertToPixel gave " + JSON.stringify(back) });
    return JSON.stringify({ id: o.id, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + back.y), value: p.value, ts: p.timestamp });
  })()`));
  if (g.err) throw new Error(`${tag}: ${g.err}`);
  log(tag, "aimed", `id=${g.id} x=${g.x} y=${g.y} value=${g.value}`);
  return g;
}

/** 事后挂回调：走的是公开 `overrideOverlay`，库的 `OverlayImp.override` 不排除函数键。 */
const attach = (prevent) => `(() => {
  const c = window.__c;
  const o = c.getOverlays().filter((x) => x.lock === true)[0];
  if (!o) return "NO_TARGET";
  window.__vetoHits = 0;
  c.overrideOverlay({
    id: o.id,
    onRightClick: (e) => {
      window.__vetoHits = (window.__vetoHits || 0) + 1;
      window.__sawPreventDefault = typeof e.preventDefault === "function";
      window.__sawLockedOverlay = !!(e.overlay && e.overlay.lock === true);
      ${prevent ? "e.preventDefault();" : "void 0;"}
    },
  });
  const after = c.getOverlays().filter((x) => x.id === o.id)[0];
  return o.id + " " + typeof (after && after.onRightClick);
})()`;

// 腿 A：什么都不挂，扫 y 偏移直到真删——这一步同时定住 B/C 用的坐标。
const OFFSETS = [0, -2, 2, -4, 4, -6, 6, -8, 8, -12, 12];
let win = null;
for (const dy of OFFSETS) {
  await boot("A");
  const g = await aim("A");
  await b.rightClickAt(g.x, g.y + dy);
  const after = await ids();
  log("A", `dy=${dy}`, after);
  if (after === "NONE") { win = { dy, x: g.x, y: g.y }; break; }
}
if (!win) {
  log("VERDICT", "BLIND", "腿 A 扫遍偏移都没删 ⇒ 手势没落到库里，本趟对否决**没有任何**判决力");
  console.log(out.join("\n"));
  b.close();
  process.exit(2);
}
log("A", "won", `dy=${win.dy}`);

// 腿 B：挂回调但不否决 ⇒ 必须照删，且计数为 1（否则 C 的活下来不是 preventDefault 的功劳）。
await boot("B");
await aim("B");
log("B", "attach", String(await b.ev(attach(false))));
await b.rightClickAt(win.x, win.y + win.dy);
log("B", "after", await ids(), "hits=" + (await b.ev(`window.__vetoHits`)),
  "sawPreventDefault=" + (await b.ev(`!!window.__sawPreventDefault`)),
  "sawLockedOverlay=" + (await b.ev(`!!window.__sawLockedOverlay`)));

// 腿 C：挂回调并 preventDefault ⇒ 必须删不动，且计数为 1。
await boot("C");
await aim("C");
log("C", "attach", String(await b.ev(attach(true))));
await b.rightClickAt(win.x, win.y + win.dy);
log("C", "after", await ids(), "hits=" + (await b.ev(`window.__vetoHits`)));

// 读数以逐行 log 为准；三腿的形状判决在报告里按这三行下：
log("SHAPE", "A=deleted", "B=deleted+hit1", "C=survived+hit1");
console.log(out.join("\n"));
b.close();
```

跑法（在 `frontend/` 之外，别在仓库根跑，避免 cwd 归属混淆）：

```bash
cd "$TEMP/rea-l3t1"
node veto.mjs "<LOCKED>" 2>&1 | tee veto.out
```

- [ ] **Step 7：分诊，而不是下结论**

| 读数 | 判 | 下一步 |
|---|---|---|
| A 没删掉（退出码 2） | 本趟**无判决力** | 不是「库没有否决面」的证据。先查 rAF/绘制是否出帧（图元事件在绘制阶段注册，没画就没有命中）、查 `hit` 落在 CANVAS 还是被 React 面板吞掉、加大偏移表；修不好就整片判 `不可取证` 并按 Step 9 的降级写记录 |
| B 没删掉 | 「挂了回调就活下来」成立 ⇒ C 的形状不是否决的功劳 | 查 `window.__vetoHits`；若为 1 且没删，说明库那边有别的路径拦了，回来重读 dist 8774-8789 并把这一条报给用户改设计 |
| B 删掉了但 hits 不是 1 | 回调没被调 ⇒ 删掉是别的东西干的 | 查 attach 回来的 `typeof` 是不是 `function` |
| C 活下来且 hits == 1 | **否决成立** | 进 Step 8，然后放行 Task 2 |
| C 被删 | **否决不成立** | **本片停止**（spec §8 第 1 步）。回来改设计，不要往下写代码 |

- [ ] **Step 8：落 `forensics/l0/self-dw05-lock-veto.md`**

形状逐字照同目录 `self-dw05-panel-session.md`。六个必填键在最前，键名逐字取自 `tools/forensics_audit.py` 的 `L0_REQUIRED_KEYS`（`命令`／`evidence_id`／`浏览器`／`目标 URL`／`观察条件`／`完整性`，冒号是**全角** `：`，见同文件 `KEY_LINE`）。骨架：

```markdown
# L0：自家页——锁定的画线在右键这一路能否被 `preventDefault()` 拦下

- 命令：npx -y rea-agents@latest capture-browser-scenario '{…Step 5 实际跑出去那条，逐字…}' --filter-output evidence_id,normalized_result --token-limit 150000
- evidence_id：ev_<当趟 `sed -n '1p' setup.out` 现读>
- 浏览器：<抄该趟 stdout 的 browser 块；场景命令给 `product: Chromium` ＋ 独立 `version`，与本趟 headless Edge 同属一个浏览器，别写成两个>
- 目标 URL：http://localhost:5899/pro-chart ——**自家 dev server，不是 tradingview.com**（值里必须带 scheme，`_is_tv_page_record` 按 host 判）
- 观察条件：除 Step 6 脚本派发的 `Input.dispatchMouseEvent` 与按钮 click 外未点按别的元素；未 fill、未登录、未保存、未交易；`--user-data-dir` 是 `$TEMP/rea-l3t1/edge-profile`，一次性 profile，不碰任何真实浏览器数据；`storage` 三段全空＝未请求任何 storage 读数
- 完整性：`events` 缺席是场景自己声明空数组的结果，不是页面没事件；`parse_failures` 若非空要在这里解释

## 主键趟（REA 单趟）看到什么

<Step 5 的 `grep -o` 计数：`清单 · 1` 出现几次、那枚按钮带不带 `disabled`>

## 第二通道（不是 REA）：原始 CDP 三腿

`rea@<现读版本>` 的 `--help` 子命令面里**没有**任何一条能在 canvas 坐标上派发手势、也没有执行页内 JS 的口（本趟逐字跑过 `npx -y rea-agents@latest --help` 并把子命令清单贴在下面），所以「真点一次右键」只能走 CDP 客户端。这一节的读数来自仓外脚本 `<绝对路径>/veto.mjs`＋`cdp.mjs`（scratch，会随系统清理消失，复算以本节的三条命令形状为准）：

- `Runtime.evaluate` 经 React fiber 全树扫描取图表实例（探针是 `typeof cand.getOverlays === "function" && typeof cand.getDataList === "function"`）
- `Input.dispatchMouseEvent` 三连：`mouseMoved` → `mousePressed{button:"right",clickCount:1}` → `mouseReleased`
- 否决经公开 `overrideOverlay({id, onRightClick})` 挂上，**没有改任何仓内代码**

<veto.out 的 A／B／C 三段逐字贴进来，含 `aimed` 行的坐标与 `attach` 行的 `typeof`>

## 判据（三腿对照，缺一腿读不出因果）

| 腿 | 挂了什么 | 读数 |
|---|---|---|
| A | 未挂回调 | <被删／未删>，赢的偏移 dy=<现读> |
| B | 回调只计数 | <被删>，hits=<现读> |
| C | 回调并 `preventDefault()` | <存活>，hits=<现读> |

## REA 子命令面（为什么这一路必须走 CDP）

<`npx -y rea-agents@latest --help` 的子命令清单逐字，只列名字那一段即可>

- 用途：规格
```

**登记一条裁定**（写进这一节末尾）：L0 的定义在 `forensics/README.md` 是「一条 REA 单趟 CDP 命令 ＋ 一个观察面 ＋ 一份记录」，本记录的判决读数落在第二通道上——`命令：` 与 `evidence_id` 是真 REA 趟，但 A／B／C 三条不是。**若评审席判这不够格，出路是整条降为 `状态：不可取证` ＋ 一段散文说明 REA 表达不了 canvas 落点，而不是拿 jsdom 读数冒充活体**（既有形状见 `_audit_l0` 的 `UNCAPTURABLE` 分支）。

- [ ] **Step 9：清场**

```bash
taskkill //PID <Step 3 现读的三个号> //T //F   # Edge / python / node，一个一个来
for p in 9222 5899 8000; do echo -n "$p "; netstat -ano | grep ":$p" | grep -c LISTENING; done
```

三个计数都该是 0（`TIME_WAIT` 残行属内核记账，无监听者，不算没停干净）。

- [ ] **Step 10：复跑吃 L0 的两枚门 ＋ 提交**

新记录进了 `forensics/l0/`，`forensics_audit.py` 会扫它，所以这步不是可选项：

```bash
cd "E:/Vibe-Trading-main/Vibe-Trading-main"
python -X utf8 tools/forensics_audit.py
python -X utf8 -m pytest tools/test_forensics_spec.py -q
```

两枚都要绿（本机那两枚恒红门不在这里，见 Task 5）。绿了再提交：

```bash
git add -f forensics/l0/self-dw05-lock-veto.md
git commit -s -m "$(cat <<'MSG'
docs(forensics): L3② 活体右键删除否决三腿读数落 L0

探针那笔欠账——`preventDefault` 拦住删除从没在活体上点过——由 TV-DW-05
这一片的验收序第 1 步还掉。三腿对照（未挂回调／挂而不拦／挂且拦）是为了
让「活下来」只有一个解释：否决，而不是「挂了回调」这件事本身。
MSG
)" -- forensics/l0/self-dw05-lock-veto.md
```

**报告要求**：状态、提交号、`veto.out` 的 A／B／C 三行原文、以及一句明确判决（否决成立／不成立／无判决力）。不成立时**不要**继续 Task 2。

---

### Task 2：规则本体——两枚纯函数、一枚归属谓词、偏好键

**Files:**
- Modify: `frontend/src/lib/chartDrawings.ts`（在 `applyDrawingFlags`（`:754`）同区加规则，在磁吸偏好键（`:1026-1045`）同区加键）
- Test: `frontend/src/lib/__tests__/chartDrawings.test.ts`
- Modify: `superpowers/specs/2026-10-16-l3-slice2-locked-delete-veto-design.md`（§3.2 那句 Pine `lock` 的带日期更正）

**Interfaces:**
- Consumes: 已有的 `toolOf`（`chartDrawings.ts:147`）、`OverlayLike`（`:367`）
- Produces（Task 3／4 逐字按这些名字与签名调）：
  - `canDeleteDrawing(locked: boolean, allowDeleteLocked: boolean): boolean`
  - `isLockedUserDrawing(overlay: unknown): boolean`——**图上的实例与存储条目都吃**（两者都有 `name` 与 `lock`）
  - `partitionDeletable<T>(entries: readonly T[], allowDeleteLocked: boolean, lockedOf: (entry: T) => boolean): { deletable: T[]; kept: T[] }`
  - `loadAllowDeleteLocked(): boolean` / `saveAllowDeleteLocked(on: boolean): void`
  - `removeDeletableDrawings(chart: OverlayHost, allowDeleteLocked: boolean): number`（返回**被跳过**的条数，给清除那一路的文案用）

- [ ] **Step 1：写失败测试**（追加到 `chartDrawings.test.ts` 末尾，`describe` 自拟为 `"锁定线的删除规则"`）

```ts
describe("锁定线的删除规则", () => {
  it("canDeleteDrawing：四行真值表，只有「锁着且不允许删锁定线」这一行挡住", () => {
    expect(canDeleteDrawing(false, false)).toBe(true);
    expect(canDeleteDrawing(false, true)).toBe(true);
    expect(canDeleteDrawing(true, true)).toBe(true);
    expect(canDeleteDrawing(true, false)).toBe(false);
  });

  it("isLockedUserDrawing：只认「用户自己的工具 ＋ 锁着」，Pine 那种 lock:true 不算", () => {
    expect(isLockedUserDrawing(overlay({ id: "a", name: "priceLine", lock: true }))).toBe(true);
    expect(isLockedUserDrawing(overlay({ id: "b", name: "priceLine", lock: false }))).toBe(false);
    // `pineDrawings.ts:374` 逐字交 `lock: true`，名字（`pineBg`，现读 `:40` 的 `NAME` 表）
    // 又不在 `DRAW_TOOLS` 里 ⇒ 规则不许碰它。
    expect(isLockedUserDrawing(overlay({ id: "c", name: "pineBg", lock: true }))).toBe(false);
    // 存储条目形状（`StoredDrawing`）也吃：暂存桶那一摊就是它。
    expect(isLockedUserDrawing({ name: "priceLine", paneId: MAIN_PANE_ID, points: [], lock: true })).toBe(true);
    expect(isLockedUserDrawing({ name: "pineBg", paneId: "sub:MACD", points: [], lock: true })).toBe(false);
    expect(isLockedUserDrawing(undefined)).toBe(false);
    expect(isLockedUserDrawing(null)).toBe(false);
  });

  it("partitionDeletable：保持原序，开关开着时 kept 必为空，不改变入参", () => {
    const rows = [
      { id: "1", lock: true },
      { id: "2", lock: false },
      { id: "3", lock: true },
    ];
    const lockedOf = (r: { lock: boolean }) => r.lock;
    expect(partitionDeletable(rows, false, lockedOf)).toEqual({
      deletable: [{ id: "2", lock: false }],
      kept: [{ id: "1", lock: true }, { id: "3", lock: true }],
    });
    expect(partitionDeletable(rows, true, lockedOf)).toEqual({ deletable: rows, kept: [] });
    expect(partitionDeletable([], false, lockedOf)).toEqual({ deletable: [], kept: [] });
    // 空集合会造出真空通过（本仓记过的假绿形状），所以「非空输入也确实被分了」要单独钉。
    expect(partitionDeletable(rows, false, () => true)).toEqual({ deletable: [], kept: rows });
    expect(rows).toHaveLength(3);
  });

  it("偏好键：读侧只有逐字 \"1\" 算允许，写侧 true/false 各写 \"1\"/\"0\"，两侧都不许抛", () => {
    expect(loadAllowDeleteLocked()).toBe(false);
    localStorage.setItem("pro-chart.delete_locked.v1", "1");
    expect(loadAllowDeleteLocked()).toBe(true);
    localStorage.setItem("pro-chart.delete_locked.v1", "yes");
    expect(loadAllowDeleteLocked()).toBe(false);
    saveAllowDeleteLocked(true);
    expect(localStorage.getItem("pro-chart.delete_locked.v1")).toBe("1");
    saveAllowDeleteLocked(false);
    expect(localStorage.getItem("pro-chart.delete_locked.v1")).toBe("0");

    const boom = () => {
      throw new Error("quota");
    };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(boom);
    expect(loadAllowDeleteLocked()).toBe(false);
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(boom);
    expect(() => saveAllowDeleteLocked(true)).not.toThrow();
    vi.restoreAllMocks();
  });
});
```

`import` 那一块（文件顶部第 29 行起）把这些名字都加进去：`canDeleteDrawing`、`isLockedUserDrawing`、`partitionDeletable`、`loadAllowDeleteLocked`、`saveAllowDeleteLocked`（按字母序插进既有列表，别贴在最末尾）。

- [ ] **Step 2：跑一次，确认它红在「导不到这几枚」上**

```bash
cd "E:/Vibe-Trading-main/Vibe-Trading-main/frontend"
npx vitest run src/lib/__tests__/chartDrawings.test.ts
```

期望：新 `describe` 红（`SyntaxError: does not provide an exported named 'canDeleteDrawing'` 那一类），**既有测试全绿**。既有测试若跟着红，是新代码串改了共享面，先修形状再往下。

- [ ] **Step 3：实现（最小）**

插在 `applyDrawingFlags` 之后（现读 `chartDrawings.ts` 里 `applyDrawingFlags` 函数结束的那一行之后）：

```ts
/**
 * 整片的裁判：一条线能不能被「用户发起的删除」删掉。四行真值表，只有一行挡。
 * `locked` 已经由调用方算好（是 `isLockedUserDrawing` 的结果，不是裸 `lock`），
 * 所以这里不再问归属——归属只有一处判断点。
 */
export function canDeleteDrawing(locked: boolean, allowDeleteLocked: boolean): boolean {
  return !locked || allowDeleteLocked;
}

/**
 * 「这条**用户的**线正锁着」——规则的唯一归属判断点。
 *
 * 必须问 `toolOf(name)`（同一枚过滤在 `applyMagnetMode` 里已经站了整一片），
 * 因为 `pineDrawings.ts:374` 交的就是 `lock: true`：只问 `lock` 会让「清除」
 * 跳过脚本画的层，而今天的无参 `removeOverlay()` 是把它们一起删掉的——那是一条
 * 没人要求的行为差。
 *
 * 图上的实例（`OverlayLike`）与存储条目（`StoredDrawing`）都吃这一个谓词：
 * 两边都带 `name` 与 `lock`，暂存桶那一摊走的就是后者。
 */
export function isLockedUserDrawing(overlay: unknown): boolean {
  const o = overlay as OverlayLike | null | undefined;
  if (!o || o.lock !== true) return false;
  return !!toolOf(o.name ?? "");
}

/**
 * §3.1 的三个批量入口（清除、撤销、暂存丢弃）共用这一枚分拣。
 * 顺序不动：撤销 = `deletable` 的最后一条，不再写第二套挑选逻辑。
 */
export function partitionDeletable<T>(
  entries: readonly T[],
  allowDeleteLocked: boolean,
  lockedOf: (entry: T) => boolean,
): { deletable: T[]; kept: T[] } {
  const deletable: T[] = [];
  const kept: T[] = [];
  for (const entry of entries) {
    (canDeleteDrawing(lockedOf(entry), allowDeleteLocked) ? deletable : kept).push(entry);
  }
  return { deletable, kept };
}
```

插在磁吸那枚键之后（现读 `saveMagnet` 函数结束行之后）：

```ts
/**
 * 锁定的画线到底删不删得掉（L3 第②片，TV-DW-05 后半个键的本仓对应物）。
 * 形状逐字照磁吸那枚键——**照的是存储形状与严格读判，不是返回类型**：磁吸交回
 * `MagnetMode`，这一枚交回 `boolean`。默认 false＝锁定受保护：`lock` 这个标志
 * 已经存在一整片了而此前什么都不挡，若默认「允许删除」，上线当天没人能观察到
 * 这道规则，功能等于零。
 */
const DELETE_LOCKED_KEY = "pro-chart.delete_locked.v1";

/** 读不到、读坏、被外部写脏，一律按 false（只有逐字 "1" 算允许删锁定线）。 */
export function loadAllowDeleteLocked(): boolean {
  try {
    return localStorage.getItem(DELETE_LOCKED_KEY) === "1";
  } catch {
    return false;
  }
}

export function saveAllowDeleteLocked(on: boolean): void {
  try {
    localStorage.setItem(DELETE_LOCKED_KEY, on ? "1" : "0");
  } catch {
    /* best effort */
  }
}
```

批量删除的图侧封装，插在 `removeLatestDrawing` 之后（现读该函数结束行）：

```ts
/**
 * 删掉图上除「受保护的锁定线」以外的一切，返回**被跳过**的条数。
 *
 * 走逐条 `{ id }` 而不是无参整体清，是因为那道整体清没有可插否决的地方；
 * `StoreImp.removeOverlay` 对被指名的实例会先 `onRemoved` 再 splice，且当它
 * `isDrawing()` 时顺手把 `_progressOverlayInfo` 置空（dist 14457-14475），
 * 所以画到一半那条也在这一趟里出清，不必先调 `cancelInProgress`。
 */
export function removeDeletableDrawings(chart: OverlayHost, allowDeleteLocked: boolean): number {
  const { deletable, kept } = partitionDeletable(
    chart.getOverlays() as OverlayLike[],
    allowDeleteLocked,
    isLockedUserDrawing,
  );
  for (const o of deletable) if (o.id) chart.removeOverlay({ id: o.id });
  return kept.length;
}
```

`kept.length` 就是「被跳过的条数」——`partitionDeletable` 已经把全量分成互补的两堆，这里不必再验一次分组是否完整：那道自证在 Task 2 Step 1 的四行真值表与分组针里已经跑过，函数里再数一遍就是「算了一遍又用不上」的形状。

- [ ] **Step 4：跑测试确认绿，再跑一次全量单测面**

```bash
npx vitest run src/lib/__tests__/chartDrawings.test.ts
npx tsc -b
```

期望：`npx vitest run` 全绿且输出干净（无 console 噪音）；`npx tsc -b` 无输出。

- [ ] **Step 5：给 spec 那句写带日期追加更正（原句一字不删）**

在 `superpowers/specs/2026-10-16-l3-slice2-locked-delete-veto-design.md` 的 §3.2 表格之后追加一小段：

```markdown
> **2026-10-17 实现席更正（原句保留，不删）**：本表最后一行那句「Pine 画的线不是用户的画线，`lock` 结构上不会是 `true`」**在现读代码里是假的**——`frontend/src/lib/pineDrawings.ts:374` 逐字是 `return { name, paneId, groupId, lock: true, zLevel, points, extendData };`，同文件头部注 19 也自陈每条都 `lock`ed。豁免本身仍然成立（`clearPineDrawings` 走 `{ groupId }`，守卫读的是逐条状态；右键那一路又被 `figure.ignoreEvent` 结构性挡掉，`checkOverlayFigureEvent` 在 dist 8223-8230），但**判据形状要收窄一层**：规则只作用于「`lock === true` 且 `toolOf(name)` 命中注册表」的用户画线，与 `applyMagnetMode` 用的同一枚归属过滤。不这么做的话，「清除」改走逐条删之后会**跳过脚本层**，而今天的无参 `removeOverlay()` 是把它们一起删的——一条没人要求的行为差。计划与本片的 `isLockedUserDrawing` 就是这条更正的落点。
```

- [ ] **Step 6：两个面分两笔提交**

```bash
cd "E:/Vibe-Trading-main/Vibe-Trading-main"
git add -- frontend/src/lib/chartDrawings.ts frontend/src/lib/__tests__/chartDrawings.test.ts
git commit -s -m "$(cat <<'MSG'
feat(frontend): 锁定线可否删除的规则本体与偏好键（L3 第②片）

裁判是一枚四行真值表，批量入口共用一枚分拣，归属只问一处——
`lock === true` 且名字在工具注册表里，因为 pineDrawings 交的就是
lock:true，只问 lock 会让「清除」跳过脚本画的层。
MSG
)" -- frontend/src/lib/chartDrawings.ts frontend/src/lib/__tests__/chartDrawings.test.ts
git add -f superpowers/specs/2026-10-16-l3-slice2-locked-delete-veto-design.md
git commit -s -m "$(cat <<'MSG'
docs(spec): 第②片 §3.2 那句「Pine 的 lock 结构上不会是 true」带日期更正

原句一字不删。豁免仍成立，判据形状要收窄成「lock 且归属为用户工具」，
后果与落点都写进同一段。
MSG
)" -- superpowers/specs/2026-10-16-l3-slice2-locked-delete-veto-design.md
```

---

### Task 3：右键那一路的否决守卫（＋两套测试替身先长出手）

**Files:**
- Modify: `frontend/src/lib/chartDrawings.ts`（`DrawingEvents` `:437`、`OverlayEventArg` `:472`、`makeDrawingEvents` `:476`）
- Modify: `frontend/src/lib/__tests__/chartDrawings.test.ts`（替身认 `onRightClick` ＋ 所有 `makeDrawingEvents(...)` 调用点补键）
- Modify: `frontend/src/pages/__tests__/ProChartDrawings.test.tsx`（替身 `rightClickDelete` 照抄库的否决顺序）
- Modify: `frontend/src/pages/ProChart.tsx`（状态＋ref＋`drawingEvents()` 补一枚键——**本任务不加按钮、不改四个入口**）

**Interfaces:**
- Consumes: Task 2 的 `canDeleteDrawing` / `isLockedUserDrawing` / `loadAllowDeleteLocked`
- Produces:
  - `DrawingEvents.allowDeleteLocked: () => boolean`（**必填**，不是可选）
  - `makeDrawingEvents(...)` 返回值多一个键 `"onRightClick"`
  - `OverlayEventArg` 多 `preventDefault?: () => void`
  - 页面上一对 `allowDeleteLocked` / `allowDeleteLockedRef`（Task 4 的按钮与四个入口都读 ref）

**为什么 `allowDeleteLocked` 是必填**：可选意味着漏传也能编译过，而漏传的默认值只能二选一——恒拦（用户没有任何办法删掉锁定线）或恒放（规则整片不存在）。必填让「漏接线」变成编译错误。代价：本仓 6 枚 lib 调用点＋1 枚页面调用点都要同时补键，所以本任务把这七处一起做掉。

- [ ] **Step 1：先改 lib 替身，再写失败的守卫测试**

`chartDrawings.test.ts` 的 `FakeOverlay` 事件回调那一段（现读：`onDrawEnd?: (e: unknown) => void;` 起的那一簇）加一行：

```ts
  onRightClick?: (e: { overlay: FakeOverlay; preventDefault: () => void }) => void;
```

同文件 `fakeChart()` 里 `createOverlay` 的参数类型加：

```ts
        onRightClick?: (e: unknown) => void;
```

并在 `overlay({...})` 的显式按键列表里（现读：`onDrawEnd: v.onDrawEnd,` 那一簇）加：

```ts
          onRightClick: v.onRightClick,
```

守卫测试（追加到 Task 2 那个 `describe` 里，或者新开 `describe("右键删除前的否决")`——同一个文件，测试名要能单独认出来）：

```ts
  it("锁着的用户画线：默认（不允许删锁定线）时守卫调用 preventDefault", () => {
    let prevented = 0;
    const events = makeDrawingEvents({ onChanged: () => {}, allowDeleteLocked: () => false });
    events.onRightClick({
      overlay: overlay({ id: "a", name: "priceLine", lock: true }),
      preventDefault: () => { prevented += 1; },
    });
    expect(prevented).toBe(1);
  });

  it("开关打开＝现状：锁着的线也放行", () => {
    let prevented = 0;
    const events = makeDrawingEvents({ onChanged: () => {}, allowDeleteLocked: () => true });
    events.onRightClick({
      overlay: overlay({ id: "a", name: "priceLine", lock: true }),
      preventDefault: () => { prevented += 1; },
    });
    expect(prevented).toBe(0);
  });

  it("没锁的线永远放行，与开关无关", () => {
    for (const allow of [false, true]) {
      let prevented = 0;
      const events = makeDrawingEvents({ onChanged: () => {}, allowDeleteLocked: () => allow });
      events.onRightClick({
        overlay: overlay({ id: "b", name: "priceLine", lock: false }),
        preventDefault: () => { prevented += 1; },
      });
      expect(prevented).toBe(0);
    }
  });

  it("Pine 那种 lock:true 不归规则管（归属针）", () => {
    let prevented = 0;
    const events = makeDrawingEvents({ onChanged: () => {}, allowDeleteLocked: () => false });
    events.onRightClick({
      overlay: overlay({ id: "c", name: "pineBg", lock: true }),
      preventDefault: () => { prevented += 1; },
    });
    expect(prevented).toBe(0);
  });

  it("入参没有 preventDefault 时不许抛——降级落在「开关开＝现状」那一侧", () => {
    const events = makeDrawingEvents({ onChanged: () => {}, allowDeleteLocked: () => false });
    expect(() => events.onRightClick({ overlay: overlay({ id: "d", name: "priceLine", lock: true }) })).not.toThrow();
  });

  it("守卫读的是**点击那一刻**的开关：翻转后，早先创建的实例照样改口（spec §5.1）", () => {
    const box = { allow: false };
    const events = makeDrawingEvents({ onChanged: () => {}, allowDeleteLocked: () => box.allow });
    const target = overlay({ id: "e", name: "priceLine", lock: true });
    let prevented = 0;
    const fire = () => events.onRightClick({ overlay: target, preventDefault: () => { prevented += 1; } });

    fire();
    expect(prevented).toBe(1); // 出厂默认：拦

    box.allow = true;
    prevented = 0;
    fire();
    expect(prevented).toBe(0); // 翻转之后：**同一枚 bundle、同一个实例**，放行

    box.allow = false;
    fire();
    expect(prevented).toBe(1); // 再翻回去，拦（`prevented` 在上面清零过一次，所以这里还是 1 而不是 2）
  });

  it("事件包带的键就是那六枚，右键这一枚必须在内", () => {
    const events = makeDrawingEvents({ onChanged: () => {}, allowDeleteLocked: () => false });
    expect(Object.keys(events).sort()).toEqual([
      "onDeselected",
      "onDrawEnd",
      "onPressedMoveEnd",
      "onRemoved",
      "onRightClick",
      "onSelected",
    ]);
  });
```

- [ ] **Step 2：跑红**

```bash
npx vitest run src/lib/__tests__/chartDrawings.test.ts
```

期望新针红（`onRightClick` 不是函数／`prevented` 为 0），既有的那条「六枚键」针也红（少一枚）。若整文件加载失败（`allowDeleteLocked` 是必填，测试里传了但类型还没有）——那正是本步要的失败形状。

- [ ] **Step 3：实现守卫**

`DrawingEvents` 末尾（现读 `onSettled?: () => void;` 之后）加：

```ts
  /**
   * 「锁定的线允许不允许删」——**点击那一刻**读，不是创建时读（spec §5.1）。
   * 必填：漏传只能二选一，恒拦（用户删不掉锁定线且无法关）或恒放（规则不存在）。
   */
  allowDeleteLocked: () => boolean;
```

`OverlayEventArg`（现读 `:472`）整块换成：

```ts
/**
 * Payload shape the library passes to the overlay event callbacks.
 * `preventDefault` only exists on the right-click path, where using it makes
 * `OverlayView` skip its own `removeOverlay` call (dist 8779-8784) — it is the
 * whole veto surface, and it is optional because the doubles and the other five
 * callbacks never carry it.
 */
interface OverlayEventArg {
  overlay?: unknown;
  preventDefault?: () => void;
}
```

`makeDrawingEvents` 的返回类型并集加 `"onRightClick"`（现读 `:478-481` 那个 `Record<...>`），并在 return 对象里 `onDeselected` 之后加：

```ts
    // The library reads the veto off the instance at right-click time and only
    // calls `removeOverlay` when `preventDefault` went unused (dist 8774-8789),
    // so this is the delete-before-happens hook §7 said the library had all
    // along. `?.` on `preventDefault` is load-bearing: a double that omits it
    // degrades to "not prevented", i.e. exactly the 开关开＝现状 side of §3.3.
    onRightClick: (e) => {
      if (!canDeleteDrawing(isLockedUserDrawing(e?.overlay), hooks.allowDeleteLocked())) e?.preventDefault?.();
    },
```

- [ ] **Step 4：补那七处调用点，然后跑绿**

现读调用点（不要把号抄进报告，号会漂）：

```bash
grep -n "makeDrawingEvents(" src/lib/__tests__/chartDrawings.test.ts src/lib/chartDrawings.ts src/pages/ProChart.tsx
```

每一处 `makeDrawingEvents({ ... })` 的入参对象里补一个键。测试里默认写 `allowDeleteLocked: () => false`；`ProChart.tsx` 的 `drawingEvents()`（现读 `:2024` 那个 `makeDrawingEvents({`）写：

```ts
      allowDeleteLocked: () => allowDeleteLockedRef.current,
```

页面状态与 ref（插在磁吸那一对之后，现读 `const magnetRef = useRef<MagnetMode>(magnet);` 之后）：

```ts
  // 锁定的线删不删得掉（第②片）：默认关＝受保护。`allowDeleteLockedRef` 镜像的是
  // 「点击那一刻」的真值——守卫活在**画线实例**上，一条线创建时捕获的闭包会一直
  // 读到它出生那天，翻转开关就对该页已有的一切线无效（spec §5.1，Task 3 的翻转针
  // 就是钉这一条）。同一个 task 里连点两次摊到同一份过期快照，理由同 `magnetRef`。
  const [allowDeleteLocked, setAllowDeleteLocked] = useState(() => loadAllowDeleteLocked());
  const allowDeleteLockedRef = useRef(allowDeleteLocked);
```

`import` 块（现读 `:59-99`）加三枚：`isInProgress` 那一片里按字母序插 `isLockedUserDrawing`、`loadAllowDeleteLocked`。

```bash
npx vitest run src/lib/__tests__/chartDrawings.test.ts
npx tsc -b
```

期望：全绿、tsc 无输出。此时 `ProChartDrawings.test.tsx` **还没跑**——它要 Step 5 的替身改造。

- [ ] **Step 5：改页面替身——`rightClickDelete` 必须照抄库的否决顺序**

今天的替身（现读 `ProChartDrawings.test.tsx` 里 `/** Right-click delete: `onRemoved` fires while the overlay is still listed. */` 那一块）直接调 `removeOverlay`，绕过了库真正的两道闸（先问回调、未被否决才删）。**这就是本片必须先改替身的原因**：不改，锁定线在测试里根本删不掉也不用掉，否决结构性不可测。

`FakeOverlay` 的事件回调簇（现读 `onDeselected?: …` 之后）加：

```ts
  // 第②片：库在右键这一路把 `{chart, overlay, figure, ...event, preventDefault}`
  // 交给 `overlay.onRightClick`，只有回调没用 `preventDefault` 才继续删（dist
  // 8774-8789）。没有这一枚，「锁定线删不掉」这条规则在测试里无法表达。
  onRightClick?: (e: { overlay: FakeOverlay; preventDefault: () => void }) => void;
```

`OverlayEvents` 那枚 `Pick<...>`（现读 `:110-113`）加一项 `"onRightClick"`。`createOverlay` 的 `v` 类型（现读那串 `needDefaultPointFigure?: boolean;` 之后）加：

```ts
          onRightClick?: (e: { overlay: FakeOverlay; preventDefault: () => void }) => void;
```

`createOverlay` 里 `makeOverlay({...})` 的显式按键（现读 `onDeselected: v.onDeselected,` 之后）加：

```ts
          onRightClick: v.onRightClick,
```

`rightClickDelete` 整块换成：

```ts
/**
 * Right-click a line body. Mirrors `OverlayView._figureMouseRightClickEvent`
 * (dist 8774-8789): the library hands `overlay.onRightClick` an event object
 * carrying a `preventDefault` it owns, and only reaches
 * `StoreImp.removeOverlay`—which fires `onRemoved` *before* splicing—when the
 * callback did not use it. The old double skipped straight to the removal, so
 * the veto was structurally untestable here.
 *
 * A missing id is an error, not a no-op: a pin that aims at an already-deleted
 * overlay would otherwise pass on an empty target set (the empty-collection
 * false green this repo has been bitten by before).
 */
function rightClickDelete(id: string): void {
  act(() => {
    const overlay = h.overlays.find((o) => o.id === id);
    if (!overlay) throw new Error(`no overlay ${id} to right-click`);
    let prevented = false;
    overlay.onRightClick?.({ overlay, preventDefault: () => { prevented = true; } });
    if (prevented) return;
    void h.chart?.removeOverlay({ id });
  });
}
```

- [ ] **Step 6：页面针——默认拦下、翻转放行（同一入口成对两半，各自可红）**

先加偏好键常量（现读 `const MAGNET_KEY = "pro-chart.magnet.v1";` 之后）：

```ts
// 第②片：锁定的线删不删得掉，一枚持久级布尔键，出厂不在盘上（默认＝保护）。
const DELETE_LOCKED_KEY = "pro-chart.delete_locked.v1";
```

追加一个 `describe("/pro-chart 锁定线的删除否决", ...)`，形状照 `describe("/pro-chart 画线的拖动与删除")` 里既有的那几针（`mountChart()` ＋ 点工具 ＋ `finishDrawing(...)` ＋ `flush()`）。**本 Task 只写右键这一路，且它必须在本 Task 就绿**——清单行删除、开关按钮那两半是 Task 4 的接线，那时再往同一 describe 里追加针；把 Task 4 的断言提前写进来会让 Task 3 带着红提交，本仓的纪律是每笔提交门全绿。helper 的归属（谁声明、谁用）见 Task 4 Step 6 那张表；本 Task 的针只用文件作用域的东西（`h`／`mountChart`／`flush`／`finishDrawing`／`rightClickDelete`／`readBuckets`／`DELETE_LOCKED_KEY`），describe 头部**不声明任何 helper**。

```ts
  it("锁着的线：右键点它删不掉，图与存储都不动；解锁后同一条右键照删（默认态两半）", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "价格线" }));
    finishDrawing({ timestamp: START + 6 * DAY, value: 1302.5 });
    await flush();
    const id = h.overlays[0].id;

    // 锁定它——锁定开关只长在清单行上，所以先开面板。那枚按钮两态都用同一个
    // aria-label（现读 `ProChart.tsx:3173`，正文才是「锁定／解锁」），所以再点
    // 一次就是解锁。
    fireEvent.click(screen.getByRole("button", { name: "画线清单" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: `锁定画线 ${id}` }));
    await flush();
    expect(h.overlays[0].lock).toBe(true);
    expect(localStorage.getItem(DELETE_LOCKED_KEY)).toBeNull(); // 默认态不落盘

    rightClickDelete(id);
    await flush();
    expect(h.overlays.map((o) => o.id)).toEqual([id]); // 右键拦下
    expect((readBuckets()["600519.SH|1D"] as unknown[])).toHaveLength(1); // 存储也没动

    // 成对另一半：同一入口、同一次运行，没锁的线照删。它证明拦下这条线的是
    // `lock` 这一问，而不是替身或守卫把右键整条路弄哑了——只有前半的运行读不出
    // 这两种的区别。
    fireEvent.click(screen.getByRole("button", { name: `锁定画线 ${id}` }));
    await flush();
    expect(h.overlays[0].lock).toBe(false);
    rightClickDelete(id);
    await flush();
    expect(h.overlays).toHaveLength(0);
    // 桶键整个消失而不是留一条空数组：`saveDrawings` 在 list 为空时 `delete`
    // 掉这一格（现读 `chartDrawings.ts:979`，函数名与那句注释在 `:973-974`），
    // 本文件既有针也是这么钉的（现读 `ProChartDrawings.test.tsx:591`／`:667`
    // 的 `toBeUndefined()`）。
    expect(readBuckets()["600519.SH|1D"]).toBeUndefined();
  });
```

（这里没有「打开开关后右键删得动」那一半：那是 §3.3 的**开关成对**判据，长在按钮上，Task 4 Step 6 第一根针写它。lib 面 §5.1 的翻转针在 Task 3 Step 1 已经钉过——它比页面面更强的地方是不重新画线，只翻一次开关。）

- [ ] **Step 7：跑，然后按红名单分面提交**

```bash
cd "E:/Vibe-Trading-main/Vibe-Trading-main/frontend"
npx vitest run src/lib/__tests__/chartDrawings.test.ts
npx vitest run src/pages/__tests__/ProChartDrawings.test.tsx
npx tsc -b
```

Task 3 结束时**三面都必须绿**：lib 单测面、页面单测面、`npx tsc -b`。这枚开关的按钮还没接线，所以页面对 `allowDeleteLocked` 的贡献只有「state＋ref＋`drawingEvents()` 传 ref」三处，`allowDeleteLocked` 永远是 `false`——本 Task 的页面针因此只钉默认态两半（拦下／解锁后放行）。若 `npx tsc -b` 报 `allowDeleteLocked` 是必填而某处 `makeDrawingEvents(...)` 没给（现读调用点共七处：`chartDrawings.test.ts` 的 `:408`／`:433`／`:443`／`:479`／`:1021`／`:1037` 六处，加 `ProChart.tsx:2025`），那是 Step 4 的补参漏了一处，逐处补而不是把 hook 改成可选。

提交（lib 面一笔，替身＋页面最小接线一笔；Task 4 再补文案与四入口）：

```bash
git add -- frontend/src/lib/chartDrawings.ts frontend/src/lib/__tests__/chartDrawings.test.ts
git commit -s -m "$(cat <<'MSG'
feat(frontend): 右键删除前挂否决（onRightClick + 点击时读开关）（L3 第②片）

守卫活在本仓这一侧：库在 `overlay.onRightClick` 没用 preventDefault 时才删
（dist 8774-8789）。开关按「点击那一刻」读，所以真值走 ref——一条线的回调闭包
生在它创建那天，捕获布尔的话翻转开关对图上已有的线一根手指都碰不到。
MSG
)" -- frontend/src/lib/chartDrawings.ts frontend/src/lib/__tests__/chartDrawings.test.ts
git add -- frontend/src/pages/__tests__/ProChartDrawings.test.tsx frontend/src/pages/ProChart.tsx
git commit -s -m "$(cat <<'MSG'
test(frontend): 页面替身的右键删除照抄库的否决顺序，缺目标改抛（L3 第②片）

旧替身直接调 removeOverlay，绕过回调那一闸，「锁定线删不掉」在测试里结构性
不可见；指名不存在的 id 原来静默 no-op，会把针让给空集合。
MSG
)" -- frontend/src/pages/__tests__/ProChartDrawings.test.tsx frontend/src/pages/ProChart.tsx
```

---

### Task 4：其余四个用户入口 ＋ 工具栏开关 ＋ 四处文案

**Files:**
- Modify: `frontend/src/pages/ProChart.tsx`（`removeDrawing` `:2348`／`clearDraw` `:2279`／`undoDraw` `:2271`／`discardParked` `:2112`／工具栏 `:2806-2822` 之后／清单行 `:3171-3197`／`drawingEvents()` 已在上）
- Modify: `frontend/src/lib/chartDrawings.ts`（`removeLatestDrawing` `:921` 加第二参）
- Modify: `frontend/src/lib/__tests__/chartDrawings.test.ts`（`removeLatestDrawing` 调用点补参）
- Test: `frontend/src/pages/__tests__/ProChartDrawings.test.tsx`

**Interfaces:**
- Consumes: Task 2 的五枚导出＋Task 3 的 `allowDeleteLocked` state/ref
- Produces: `removeLatestDrawing(chart, allowDeleteLocked)` 新签名；按钮 `aria-label="锁定线可删"`

- [ ] **Step 1：`removeLatestDrawing` 加参（先写 lib 针）**

`chartDrawings.test.ts` 里现读 `grep -n "removeLatestDrawing(" src/lib/__tests__/chartDrawings.test.ts`，每一处补第二参（既有语义都是「开关关着」的默认面，但**锁不锁要看**，所以传 `false` 不改变既有期望；带锁定条的新针另写）：

```ts
  it("撤销取最近一条**可删**的：锁定的那条被跳过，指针往后退一格", () => {
    const a = overlay({ id: "o0", name: "priceLine" });
    const b = overlay({ id: "o1", name: "priceLine", lock: true });
    const chart = fakeChart([a, b]);
    expect(removeLatestDrawing(chart, false)).toBe("o0"); // 最新的是锁着的 ⇒ 跳过它
    expect(chart.overlays.map((o) => o.id)).toEqual(["o1"]);

    // 开关打开 ⇒ 现状：取最新的这条，正是它。
    const chart2 = fakeChart([overlay({ id: "p0", name: "priceLine" }), overlay({ id: "p1", name: "priceLine", lock: true })]);
    expect(removeLatestDrawing(chart2, true)).toBe("p1");
  });

  it("撤销面对「全被锁住」：返回 null，一根手指都不动（按钮不许装作删掉了什么）", () => {
    const chart = fakeChart([overlay({ id: "q0", name: "priceLine", lock: true })]);
    expect(removeLatestDrawing(chart, false)).toBeNull();
    expect(chart.overlays.map((o) => o.id)).toEqual(["q0"]);
    expect(chart.removeOverlay).not.toHaveBeenCalled();
  });
```

实现（整块替换 `:921` 那个函数）：

```ts
/**
 * Undo the most recent drawing the user is **allowed** to delete. Returns its id,
 * or null when nothing is deletable. §3.1 entry 4：撤销不另写一套挑选逻辑——
 * 它从 `partitionDeletable` 的 `deletable` 里取最后一条，与「清除」共用分拣。
 */
export function removeLatestDrawing(chart: OverlayHost, allowDeleteLocked: boolean): string | null {
  const done = chart.getOverlays().filter((o) => !isInProgress(o)) as OverlayLike[];
  const { deletable } = partitionDeletable(done, allowDeleteLocked, isLockedUserDrawing);
  const id = deletable[deletable.length - 1]?.id;
  if (!id) return null;
  chart.removeOverlay({ id });
  return id;
}
```

- [ ] **Step 2：工具栏开关（形状照磁吸按钮）**

`toggleAllowDeleteLocked`（插在 `toggleMagnet` 之后，现读该函数结束行）：

```ts
  /**
   * 翻转「锁定线可删」。这里没有任何**批量**动作要做：守卫是在右键那一刻从实例的
   * 回调里现读开关的（`makeDrawingEvents`），所以翻转不需要重新给每条线盖一遍东西
   * ——那正是磁吸必须重盖而这一枚不必的原因，`mode` 是库在落点瞬间读的，否决是库在
   * 删除瞬间问的。别照着 `toggleMagnet` 在这里加一轮 `overrideOverlay`。
   */
  const toggleAllowDeleteLocked = () => {
    const next = !allowDeleteLockedRef.current;
    allowDeleteLockedRef.current = next;
    setAllowDeleteLocked(next);
    saveAllowDeleteLocked(next);
  };
```

按钮（插在磁吸那枚 `</button>` 之后，现读 `:2822`；`title` 与 `aria-pressed` 的真值面说「允许删除」而不是「保护」——这枚开关天生带负负得正的坑）：

```tsx
          <button
            type="button"
            className={cn(
              "rounded-md border px-2 py-1 text-xs hover:bg-muted",
              allowDeleteLocked && "bg-muted font-medium ring-1 ring-primary",
            )}
            aria-label="锁定线可删"
            aria-pressed={allowDeleteLocked}
            title={
              allowDeleteLocked
                ? "已允许删除锁定线：右键、清单行的删除、清除、撤销、删除待恢复这五条路都能删掉锁着的线（和以前一样）"
                : "锁着的线删不掉：右键会被挡下，清单行的删除按不动它，清除与撤销跳过它，在等副图的锁定线也留着。要放行点这里，或先把那一条「解锁」"
            }
            onClick={toggleAllowDeleteLocked}
          >
            锁定线可删
          </button>
```

- [ ] **Step 3：清单行删除（入口 2）＋ 那句已经变成假的提示**

`removeDrawing`（现读 `:2348`）整块替换。**判的是图上的实例而不是 `drawRows`**：行上没有归属信息，而规则要问的是「这条用户的线锁着没」——用行上的 `locked` 会把 Pine 那种 `lock:true` 的装饰也一并拦下（今天的行删除按钮对它们本来是能按的）。

```ts
  /**
   * Delete one line through the chart, so `onRemoved` runs the same way a
   * right-click delete runs it (⑮): selection and storage are cleaned by that
   * callback, not by this handler.
   *
   * §3.1 entry 2 — the public API has no veto slot here (`Chart.removeOverlay`
   * just walks into `StoreImp.removeOverlay`), so the rule is checked **before**
   * the call, against the live instance. Not against `drawRows`: a row carries
   * `locked` but no ownership, and asking only "is it locked" would start
   * blocking list rows that are a script's layer, which today delete fine.
   */
  const removeDrawing = (id: string) => {
    const chart = chartRef.current;
    if (!chart) return;
    const [target] = chart.getOverlays({ id }) as unknown[];
    if (!canDeleteDrawing(isLockedUserDrawing(target), allowDeleteLockedRef.current)) {
      setDrawNotice({ bad: true, text: "这条线锁着，删不掉——先「解锁」，或打开「锁定线可删」" });
      return;
    }
    chart.removeOverlay({ id });
    syncDrawings(chart);
  };
```

`import` 块补 `canDeleteDrawing`。

清单一行的 `title`：删除按钮（现读 `:3189-3197`）的双态文案，**不加 `disabled`**——disabled 的按钮不给解释，提示文案才是解释的地方：

```tsx
                <button
                  type="button"
                  aria-label={`删除画线 ${row.id}`}
                  title={
                    row.locked && !allowDeleteLocked
                      ? "这条线锁着，删不掉——先「解锁」，或打开工具栏的「锁定线可删」"
                      : "删除这条线"
                  }
                  className="shrink-0 rounded-md border px-2 py-0.5 hover:bg-muted"
                  onClick={() => removeDrawing(row.id)}
                >
```

`className` 那行是现读 `:3193` 的逐字，**本片一个字都不改**，只动 `title`。

锁定按钮那句「右键仍可删」（现读 `:3174`）在默认态下从此是假话。三态改口：

```tsx
                  title={
                    row.locked
                      ? "解锁后可拖动改位"
                      : allowDeleteLocked
                        ? "锁定后拖不动这条线；「锁定线可删」开着，右键与删除照旧删得动"
                        : "锁定后拖不动这条线，右键点它也删不掉（打开「锁定线可删」可放行）"
                  }
```

（`/pro-chart` 的两枚既有 `title` 里，`grep -rn "右键仍可删\|锁定后拖不动\|解锁后可拖动改位" src/` 现读只命中 `ProChart.tsx:3174` 一处，测试文件零命中 ⇒ 这两句改口不会撞红任何既有针；上面两根新针钉的是**本片新写**的三态，不是复述旧文案。）

**同一行的那句通用提示（现读 `:2963-2964`，`已画 N 条 · … 右键点线删除`）本片刻意不动**——裁定登记在此，别让评审席当成漏改：那句说的是「右键＝删除这条通道存在」，不是「每条线都删得动」；逐条的承诺已经长在锁定那枚按钮的 `title` 与拦截提示里。把它改成条件句要在提示位上引入「有没有锁定的线 × 开关状态」两维，那是一片新的文案面，且与 §4「按钮文案要说清它管什么」的落点（工具栏开关）不是同一处。Task 6 的活体表按现读原文抄这一句，不改。

- [ ] **Step 4：清除（入口 3）**

`clearDraw`（现读 `:2279-2288`）整块替换。注意 `syncDrawings` 会 `setDrawNotice(null)`（现读 `:1977`），所以**提示必须在 sync 之后写**——`setDrawingText`（`:2323-2341`）就是这个顺序的既有先例。

```ts
  const clearDraw = () => {
    const chart = chartRef.current;
    if (!chart) return;
    const allow = allowDeleteLockedRef.current;
    // 逐条指名删，而不是无参整体清——整体清没有可插否决的地方（§3.1 入口 3）。
    const skippedOnChart = removeDeletableDrawings(chart, allow);
    // 暂存桶那摊同样保留锁定条（`StoredDrawing.lock` 随存储往返，见
    // chartDrawings.ts 的 serialize/restore 两侧）。parked 条目不在图上，
    // 「删」＝从桶里去掉，所以这里只取 `kept` 一堆。
    const { kept } = partitionDeletable(parkedRef.current, allow, isLockedUserDrawing);
    replaceParked(kept);
    setDrawTool(null);
    syncDrawings(chart);
    const skipped = skippedOnChart + kept.length;
    if (skipped > 0) {
      setDrawNotice({
        bad: true,
        text: `${skipped} 条锁着的线留着没删（要一起删就打开「锁定线可删」，或先「解锁」那几条）`,
      });
    }
  };
```

**只解绑 `kept`，不要写 `const { deletable, kept }` 再把 `deletable` 扔掉**：`frontend/tsconfig.json` 里 `noUnusedLocals: true`（现读 `:15`），那个未用的绑定本身就是一条编译错误；而「算了又不用」的形状也是本计划 Task 2 里批过的缺陷。`deletable` 删不掉的是 `partitionDeletable` 的契约（Task 2 定的一半，撤销那一路要用），不是这里的解绑。

`import` 块补 `removeDeletableDrawings`、`partitionDeletable`。开关开着的这一路：`skippedOnChart === 0`、`kept.length === 0` ⇒ **一条提示都不落**，与本片之前逐字同形（§3.3 的判据面）。

- [ ] **Step 5：撤销（入口 4）与暂存丢弃（入口 5）**

`undoDraw`（现读 `:2271-2277`）整块替换：

```ts
  const undoDraw = () => {
    const chart = chartRef.current;
    if (!chart) return;
    cancelInProgress(chart);
    const allow = allowDeleteLockedRef.current;
    if (removeLatestDrawing(chart, allow)) {
      syncDrawings(chart);
      const skipped = chart.getOverlays().filter((o) => !allow && isLockedUserDrawing(o)).length;
      if (skipped > 0) {
        setDrawNotice({ bad: true, text: `撤销跳过了 ${skipped} 条锁着的线（打开「锁定线可删」可一并删）` });
      }
      return;
    }
    // 什么都没删，但清单上有线 ⇒ 不是按钮坏了，是全被锁定挡着。不解释一次就会被当故障。
    if (drawCount > 0) {
      setDrawNotice({ bad: true, text: "最近的那些线锁着，撤销动不了它们（打开「锁定线可删」或先「解锁」）" });
    }
    setDrawTool(null);
  };
```

`discardParked`（现读 `:2111-2116`）整块替换：

```ts
  /**
   * Throw away the waiting lines — the only way out of a pane that is gone.
   * §3.1 入口 5：桶里锁定 those 留着；全被留下时给一句解释，否则「按了没反应」
   * 会被读成按钮坏了。
   */
  const discardParked = () => {
    const { kept } = partitionDeletable(parkedRef.current, allowDeleteLockedRef.current, isLockedUserDrawing);
    if (kept.length === parkedRef.current.length) {
      setDrawNotice({ bad: true, text: `${kept.length} 条在等副图的线都锁着，一条都没删（打开「锁定线可删」或先「解锁」）` });
      return;
    }
    replaceParked(kept);
    const chart = chartRef.current;
    if (chart) syncDrawings(chart);
    if (kept.length > 0) {
      setDrawNotice({ bad: true, text: `${kept.length} 条锁着的线留在等副图，其余已删` });
    }
  };
```

「空桶时 `kept.length === parked.length === 0` 会说出『0 条…一条都没删』」这一条**不构成场景**：那枚按钮整块长在 `{parkedCount > 0 && (...)}` 里（现读 `ProChart.tsx:3201`），桶空了就没有入口，所以这里不加防御分支（加了也永远不为真，还会把 `kept.length === 0` 这条正常路径的提示一起搅浑）。

- [ ] **Step 6：页面针（四入口 × 两态的形状，等副图那摊用既有的种盘手法）**

追加到 Task 3 那个 `describe` 里。**helper 的归属纪律**（它们全住在同一枚 describe 回调体内，但 `frontend/tsconfig.json` 的 `noUnusedLocals: true` 会让「声明了还没用」当场红，所以每枚 helper 必须**落在第一次用它的 Task**里声明）：

| helper | 声明在 | 被谁用 | 现读底本 |
|---|---|---|---|
| `DELETE_LOCKED_KEY` | Task 3 | Task 3 那根否决针＋本 Step 第一根针（读默认态不落盘／翻转后落 `"1"`） | Task 3 Step 6 |
| `disabled` | Task 4（本 Step 第一根针） | 本 Step 第一根针的「删除按钮没被禁用」一行 | `ProChartDrawings.test.tsx:1804-1805` |
| `bucket`、`reload` | Task 4（本 Step 末尾那块 describe 头部） | 本 Step 的清除／撤销／暂存丢弃三根 | `:1800-1801`、`:1822-1831` |
| `closePane` | Task 5 Step 2 | E2 那根收纳针 | `:1814-1821` |
| `finishWith` | Task 5 Step 3 | E3 那根退化丢弃针 | `:2012-2021` |

`SUB_MACD`／`DRAWING_KEY`／`MAGNET_KEY`／`readBuckets`／`h`／`mountChart`／`flush`／`finishDrawing`／`rightClickDelete`／`FakeOverlay` 是文件作用域的（现读 `:122`／`:454`／`:458`／`:149-181` 等），跨 describe 直接可用，**不用**再声明。既有那三枚私有 helper（`seed`／`closePane`／`bucketOf`，现读 `:1802-1821`）住在 `describe("/pro-chart 副图上的画线")` 回调体里，跨 describe 抓不到——所以本计划一律按上表重新声明，形状逐字抄现读。`seed` 本计划没用到（暂存桶那根针直接 `localStorage.setItem`，见下面），所以**不声明**它。

第一根是 §3.3 的**开关成对**判据，也是 Task 3 Step 6 那句「清单行删除、开关按钮那两半是 Task 4 的接线」搬过来的东西——Task 3 里按钮还没长出来，提前钉它会让 Task 3 带着红提交。

```ts
  it("开关成对：默认态右键与清单行都拦下，翻开「锁定线可删」两条路照旧删得动", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "价格线" }));
    finishDrawing({ timestamp: START + 6 * DAY, value: 1302.5 });
    await flush();
    const id = h.overlays[0].id;
    fireEvent.click(screen.getByRole("button", { name: "画线清单" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: `锁定画线 ${id}` }));
    await flush();
    expect(h.overlays[0].lock).toBe(true);

    // 清单行的删除按钮**不带 disabled**（Task 4 Step 3 的裁定：disabled 的按钮不给
    // 解释，解释长在提示上）。所以它按得动、按了不删——这一行钉的就是「没被禁用」，
    // 下一行钉「按了没删掉」。两行分开才有判别力：只钉后者的话，按钮整个消失也照过。
    expect(disabled(`删除画线 ${id}`)).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: `删除画线 ${id}` }));
    await flush();
    expect(h.overlays.map((o) => o.id)).toEqual([id]);
    expect(screen.getByText("这条线锁着，删不掉——先「解锁」，或打开「锁定线可删」")).toBeTruthy();

    const flip = screen.getByRole("button", { name: "锁定线可删" });
    expect(flip.getAttribute("aria-pressed")).toBe("false"); // 出厂态＝保护
    expect(localStorage.getItem(DELETE_LOCKED_KEY)).toBeNull();

    fireEvent.click(flip);
    await flush();
    expect(flip.getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem(DELETE_LOCKED_KEY)).toBe("1");

    // 后半的承重在这儿：这条线是**翻转之前**就画好、就锁上的，它的 `onRightClick`
    // 闭包生在创建那天。守卫若在创建时捕获布尔，这一行会照样拦下——§5.1 之所以
    // 要求点击那一刻读 ref，就是为了这一根针能红。
    rightClickDelete(id);
    await flush();
    expect(h.overlays).toHaveLength(0);

    // 清单行那一路同样要放行；上面那条已被右键删掉，重画一条锁着的再走行删除。
    fireEvent.click(screen.getByRole("button", { name: "价格线" }));
    finishDrawing({ timestamp: START + 7 * DAY, value: 1310 });
    await flush();
    const again = h.overlays[0].id;
    fireEvent.click(screen.getByRole("button", { name: "画线清单" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: `锁定画线 ${again}` }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: `删除画线 ${again}` }));
    await flush();
    expect(h.overlays).toHaveLength(0);
    // 删成了就不该再说它删不掉：`removeDrawing` 删后走 `syncDrawings`，那里
    // `setDrawNotice(null)`（现读 `ProChart.tsx:1977`）把上一句提示冲掉。
    expect(screen.queryByText(/这条线锁着，删不掉/)).toBeNull();
  });
```

```ts
  it("清除：锁定条跳过、没锁的照删，并说一句「N 条锁着的留着没删」", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "水平线" }));
    finishDrawing({ timestamp: START + DAY, value: 1290 });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "价格线" }));
    finishDrawing({ timestamp: START + 2 * DAY, value: 1300 });
    await flush();
    const lockedId = h.overlays[1].id;
    fireEvent.click(screen.getByRole("button", { name: "画线清单" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: `锁定画线 ${lockedId}` }));
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "清除" }));
    await flush();
    expect(h.overlays.map((o) => o.id)).toEqual([lockedId]);
    expect(bucket().map((d) => (d as { name?: string }).name)).toEqual(["priceLine"]);
    expect(screen.getByText("1 条锁着的线留着没删（要一起删就打开「锁定线可删」，或先「解锁」那几条）")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "锁定线可删" }));
    await flush();
    // 上一条线要回来才能读「开＝现状」：清空后重新画两条。
    fireEvent.click(screen.getByRole("button", { name: "水平线" }));
    finishDrawing({ timestamp: START + 3 * DAY, value: 1295 });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "价格线" }));
    finishDrawing({ timestamp: START + 4 * DAY, value: 1305 });
    await flush();
    const lid = h.overlays[1].id;
    fireEvent.click(screen.getByRole("button", { name: "画线清单" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: `锁定画线 ${lid}` }));
    await flush();
    h.chart?.removeOverlay.mockClear(); // 下面要读「有没有无参整体清」，先抹掉前面那几次指名删

    fireEvent.click(screen.getByRole("button", { name: "清除" }));
    await flush();
    expect(h.overlays).toHaveLength(0); // 开＝现状：一条都不留
    // 逐条 `{ id }`，一次无参整体清都没有（`:1214` 那句裁定的可读数）。
    expect(h.chart?.removeOverlay.mock.calls.every((c) => c.length === 1 && !!c[0]?.id)).toBe(true);
    expect(screen.queryByText(/条锁着的线留着没删/)).toBeNull(); // 也不落提示
  });
```

```ts
  it("撤销跳过锁定的那条去删后面一条；全是锁着的就什么都不动，并说明原因", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "水平线" }));
    finishDrawing({ timestamp: START + DAY, value: 1290 });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "价格线" }));
    finishDrawing({ timestamp: START + 2 * DAY, value: 1300 });
    await flush();
    const lockedId = h.overlays[1].id;
    fireEvent.click(screen.getByRole("button", { name: "画线清单" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: `锁定画线 ${lockedId}` }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "画线清单" })); // 收面板，回到工具栏
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await flush();
    expect(h.overlays.map((o) => o.id)).toEqual([lockedId]); // 取的是「最近一条**可删**的」
    expect(screen.getByText(/撤销跳过了 1 条锁着的线/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await flush();
    expect(h.overlays.map((o) => o.id)).toEqual([lockedId]); // 全锁着 ⇒ 一动不动
    expect(screen.getByText(/最近的那些线锁着，撤销动不了它们/)).toBeTruthy();
  });
```

```ts
  it("删除待恢复的画线：锁定条留在桶里；开着开关就整桶清空（现状）", async () => {
    localStorage.setItem(
      DRAWING_KEY,
      JSON.stringify({
        "600519.SH|1D": [
          { name: "priceLine", paneId: "indicator_pane_1725507123456_4", points: [{ timestamp: START, value: 52874 }] },
          { name: "priceLine", paneId: "indicator_pane_1725507123456_5", points: [{ timestamp: START, value: 52875 }], lock: true },
        ],
      }),
    );
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "画线清单" }));
    await flush();
    expect(screen.getByText(/2 条在等副图/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "删除待恢复的画线" }));
    await flush();
    const left = bucket() as Array<Record<string, unknown>>;
    expect(left).toHaveLength(1);
    expect(left[0].lock).toBe(true); // 锁着的那条留在桶里
    expect(screen.getByText(/1 条锁着的线留在等副图，其余已删/)).toBeTruthy();

    // 全锁着 ⇒ 「按了没反应」必须有话。
    localStorage.setItem(
      DRAWING_KEY,
      JSON.stringify({
        "600519.SH|1D": [
          { name: "priceLine", paneId: "indicator_pane_1725507123456_6", points: [{ timestamp: START, value: 52876 }], lock: true },
        ],
      }),
    );
    await reload();
    fireEvent.click(screen.getByRole("button", { name: "画线清单" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "删除待恢复的画线" }));
    await flush();
    expect(bucket()).toHaveLength(1);
    expect(screen.getByText(/1 条在等副图的线都锁着，一条都没删/)).toBeTruthy();

    // 开＝现状：整桶清空。
    fireEvent.click(screen.getByRole("button", { name: "锁定线可删" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "删除待恢复的画线" }));
    await flush();
    expect(bucket()).toHaveLength(0);
  });
```

新 `describe` 头部要的 helper 三枚。先说清为什么要在本 describe 里**重新声明一份**而不是复用：`bucketOf`/`reload`/`disabled` 都住在既有的 `describe("/pro-chart 副图上的画线")` 回调体内部（现读 `:1798` 起，`:1800`/`:1804`/`:1822` 是它们的声明行），文件作用域拿不到；下面的写法逐字抄自那三行现读，只把 `bucketOf` 换了名（本 describe 只用一个键，名字短一点读得动）。

```ts
describe("/pro-chart 锁定线的删除否决", () => {
  const bucket = (key = "600519.SH|1D"): Array<Record<string, unknown>> =>
    (readBuckets()[key] ?? []) as Array<Record<string, unknown>>;
  const disabled = (name: string): boolean =>
    (screen.getByRole("button", { name }) as HTMLButtonElement).disabled;

  /** Leave the symbol and come back: the path that re-runs the restore. */
  async function reload(): Promise<void> {
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "AAPL" }));
    });
    await flush();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "贵州茅台" }));
    });
    await flush();
  }
```

`reload` 走「切走再切回」而不是 unmount/remount：这条正是既有三根针验证过的恢复路径（`:1822-1831` 的注释原话是 *"the path that re-runs the restore"*），换标的会让 `syncSymbol` 重跑一遍 `restoreDrawings`，暂存桶里的东西就是从那里回到图上的。

- [ ] **Step 7：跑绿 + 类型面**

```bash
npx vitest run src/lib/__tests__/chartDrawings.test.ts src/pages/__tests__/ProChartDrawings.test.tsx
npx tsc -b
```

期望：Task 3 遗留的两半（提示文案＋开关按钮）现在转绿，全文件绿，`tsc` 无输出。若既有某针红在 `removeLatestDrawing` 的调用形状，那是 Step 1 的补参没跑全——`grep -n "removeLatestDrawing(" src` 逐处对。

- [ ] **Step 8：提交（lib 签名一笔／页面接线一笔）**

```bash
git add -- frontend/src/lib/chartDrawings.ts frontend/src/lib/__tests__/chartDrawings.test.ts
git commit -s -m "$(cat <<'MSG'
feat(frontend): 撤销改为「最近一条可删的」，与清除共用同一枚分拣（L3 第②片）

不另写一套挑选逻辑：撤销 = 分拣后取 deletable 的最后一条；面对全锁的摊
返回 null，让页面上层有话可说。
MSG
)" -- frontend/src/lib/chartDrawings.ts frontend/src/lib/__tests__/chartDrawings.test.ts
git add -- frontend/src/pages/ProChart.tsx frontend/src/pages/__tests__/ProChartDrawings.test.tsx
git commit -s -m "$(cat <<'MSG'
feat(frontend): 清单删除/清除/撤销/删除待恢复四个入口都删不动锁定线，加工具栏开关

公开 API 上没有否决位，所以四路都在调用前自己判。开关默认关（锁定受保护），
打开时四路与本片之前逐字同形。清单锁定按钮那句「右键仍可删」在默认态下是
假话，一并改口。
MSG
)" -- frontend/src/pages/ProChart.tsx frontend/src/pages/__tests__/ProChartDrawings.test.tsx
```

---

### Task 5：五条豁免线针 ＋ 四件变异自证 ＋ 六道门

**Files:**
- Test: `frontend/src/pages/__tests__/ProChartDrawings.test.tsx`（五根豁免针＋E6 的文案针＋Step 5c 三处收口）
- Test: `frontend/src/lib/__tests__/chartDrawings.test.ts`（归属针的反面：Pine 被清除照删）
- Modify: `frontend/src/pages/ProChart.tsx`（**只** Step 5b 那一处 `title` 条件，一片一行）
- Modify: 无其他——针红就修实现，修不到就裁成缺陷登记

**Interfaces:**
- Consumes: Task 2-4 的全部产出
- Produces: spec §3.2「豁免线不是注释，是针」那句话的凭据；六道门读数

- [ ] **Step 1：E1 切标的／切周期（最承重的一根，`ProChart.tsx:1396` 那句整图清）**

判据形状＝spec §3.2 原话：锁定一条线 → 切标的 → 再切回来，锁定线**不**跨标的存活；在同一标的内切回周期按存储复现。

```ts
  it("豁免：切标的的整图清不读锁定态——锁定线不许粘到另一个标的上", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "价格线" }));
    finishDrawing({ timestamp: START + 6 * DAY, value: 1302.5 });
    await flush();
    const id = h.overlays[0].id;
    fireEvent.click(screen.getByRole("button", { name: "画线清单" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: `锁定画线 ${id}` }));
    await flush();

    fireEvent.click(screen.getByRole("button", { name: "AAPL" }));
    await flush();
    expect(h.overlays).toHaveLength(0); // 拦下这次清理＝把它粘到别的标的上，那才是 bug
    expect((readBuckets()["600519.SH|1D"] as Array<Record<string, unknown>>)[0].lock).toBe(true); // 离开的那个标的桶没动

    fireEvent.click(screen.getByRole("button", { name: "贵州茅台" }));
    await flush();
    expect(h.overlays).toHaveLength(1); // 切回来：按存储复现，仍带着锁定态
    expect(h.overlays[0].lock).toBe(true);
    rightClickDelete(h.overlays[0].id);
    await flush();
    expect(h.overlays).toHaveLength(1); // 复现出来的那条依然删不动
  });
```

- [ ] **Step 2：E2 副图消失时的收纳（`ProChart.tsx:2087`／`:2092`）**

```ts
  it("豁免：副图关掉时锁定条照样进暂存，不留在图上", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "价格线" }));
    h.overlays[h.overlays.length - 1].paneId = SUB_MACD;
    finishDrawing({ timestamp: START + DAY, value: -0.42 });
    await flush();
    const id = h.overlays[0].id;
    fireEvent.click(screen.getByRole("button", { name: "画线清单" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: `锁定画线 ${id}` }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "画线清单" }));
    await flush();

    closePane(SUB_MACD);
    act(() => {
      h.indProps?.onChartIndicatorsChanged?.();
    });
    await flush();
    expect(h.overlays).toHaveLength(0); // 收纳这次清理必须照样发生
    expect(screen.getByRole("button", { name: "画线清单" }).textContent).toBe("清单 · 0+1");
    expect((bucket()[0] as Record<string, unknown>).lock).toBe(true); // 进桶时带着锁定态
  });
```

本针的触发手法逐字抄既有那根 `it("副图关了就不上图…")`（现读 `:1928-1951`）：`closePane(SUB_MACD)` 之后 `act(() => h.indProps?.onChartIndicatorsChanged?.())`，收纳就在这一步发生。`SUB_MACD`（`:122`）与 `MAIN`… 的区别要看清：`SUB_MACD` 是**文件作用域**，本 describe 直接可用；`MAIN` 是 `describe("/pro-chart 副图上的画线")` 私有的（`:1799`），本针不需要它（断言用的是条数与 `清单 · 0+1` 那句，不是 paneId 等式）。`closePane` 是私有的，本 Task 在这里声明一份：

```tsx
  const closePane = (id: string, name = id.replace("sub:", "")) => {
    fireEvent.click(screen.getByRole("button", { name: "副图指标" }));
    fireEvent.click(screen.getByRole("button", { name: `关闭副图 ${name}` }));
    const i = h.panes.findIndex((p) => p.id === id);
    if (i >= 0) h.panes.splice(i, 1);
  };
```

（逐字抄现读 `:1814-1821`。`清单 · 0+1` 这句的格式有库外依据：按钮正文是 `清单 · {drawCount}{parkedCount > 0 ? "+" + parkedCount : ""}`，现读 `ProChart.tsx:2854-2855`；同处 `:2851` 那个 `disabled` 条件是「图上 0 条**且**暂存 0 条」，本针有 1 条在等副图，所以按钮不禁用、点得开。）

- [ ] **Step 3：E3 退化丢弃（`chartDrawings.ts:713-716`）**

本针抄的底是既有那根 `it("整条两点线都画在未来区：吸回后会重合成一个点，宁可放弃")`（现读 `ProChartDrawings.test.tsx:2047-2059`），它调的是同一个 `finishWith`（现读 `:2012-2021`，也是那枚 describe 私有的，本 describe 照 `bucketOf`/`reload` 的既有先例再声明一份——同一文件里 `bucketOf` 已经被两枚 describe 各自声明过，这是本文件的既有形状，不是我新造的）。**唯一增量**是进 `reanchorOverlay` 前把 `lock` 放到 `true`。

```tsx
  /** Land a multi-point tool in one go, the way the library's last click does. */
  function finishWith(points: Array<Record<string, number>>): FakeOverlay {
    const line = h.overlays[h.overlays.length - 1];
    act(() => {
      line.points = points.map((p) => ({ ...p }));
      line.drawing = false;
      line.currentStep = -1;
      line.onDrawEnd?.({ overlay: line });
    });
    return line;
  }

  it("豁免：吸回后退化成一点的锁定线照样被丢掉（退化丢弃这条路不问锁定开关）", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "趋势线" }));
    // `lock` 只能手放到实例上：清单行要到画完才出现，而本针要的正是「带着
    // lock 进 reanchor」这一趟。
    h.overlays[h.overlays.length - 1].lock = true;
    const line = finishWith([
      { timestamp: START + 300 * DAY, value: 1300 },
      { timestamp: START + 305 * DAY, value: 1320 },
    ]);
    await flush();

    expect(h.overlays.some((o) => o.id === line.id)).toBe(false);
    expect(bucket()).toHaveLength(0);
    expect(screen.getByText(/重合成一个点，已放弃/)).toBeTruthy();
  });
```

**判别力要说清，否则这根针是恒过的**：`reanchorOverlay` 那条 `chart.removeOverlay({ id })`（现读 `chartDrawings.ts:714`）本来就不问规则，所以「本片改动前／改动后」两态它都绿——它绿的不是这个。它对付的变异是**把豁免摘掉**：若将来有人让退化丢弃也走锁定守卫（§3.2 禁止的那种改口），这根线就会活下来，`some(...)` 那行当场红。而这条变异只有在线**真的锁着**时才拦得住它，所以 `lock = true` 那一行是这根针的全部判别力来源。Step 6 的 M4 就是照这个写的临时变异，跑完还原。

- [ ] **Step 4：E4 `cancelInProgress`（`chartDrawings.ts:911`）**

```ts
  it("豁免：画到一半的线被 cancelInProgress 清掉，锁定开关碰不到它（锁定只长在清单行上）", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "射线" }));
    await flush();
    // 半成品：清单上还没有它的行，所以这一根结构上拿不到 `lock`——形状照现读
    // `ProChartDrawings.test.tsx:1245-1247`（点工具 → flush → 读 `drawing`）。
    expect(h.overlays.some((o) => o.drawing)).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "撤销" }));
    await flush();
    expect(h.overlays).toHaveLength(0);
  });
```

- [ ] **Step 5：E5 Pine 脚本层被清除照删（归属针的反面，`pineDrawings.ts:357` 区）**

lib 面写最省——不起页面，直接喂一条 Pine 形状的实例：

```ts
  it("清除：Pine 那种 lock:true 的装饰被逐条删掉，与今天的整体清同形", () => {
    const chart = fakeChart([
      overlay({ id: "u0", name: "priceLine", lock: true }),
      overlay({ id: "p0", name: "pineBg", lock: true }),
    ]);
    const skipped = removeDeletableDrawings(chart, false);
    expect(skipped).toBe(1); // 只有那条用户的锁定线被留下
    expect(chart.overlays.map((o) => o.id)).toEqual(["p0"]);
  });
```

（`pineBg` 这条走 `overlay()` 而不是手写对象字面量：lib 的 `FakeOverlay`（现读 `chartDrawings.test.ts:62-89`）没有 `groupId` 这一员，多写一个键在 `noUnusedLocals` 之外还要吃 excess-property 错误。）

页面面若能把 Pine 装饰挂上去就再加一根同形针；**做不到就如实登记「lib 面已判，页面面未覆」**，不假造。

- [ ] **Step 5b：E6 清单行删除按钮的 `title` 改问归属（Task 4 评审席的 plan-mandated 发现，控制席裁定落本片）**

盘面事实（控制席现读，行号按 `6b6de129` 终态，你要照抄前先自己读一遍）：`describeDrawing` 只滤「无 id／半成品／无 name」（`chartDrawings.ts:905-910`）⇒ 它**不按 `toolOf` 滤**；`listDrawings` 遍历 `chart.getOverlays()` 全部（`:964-971`）；`refreshDrawCount` 把结果原样塞进 `drawRows`（`ProChart.tsx:732-735`）。而 Pine 那四种装饰的名字是 `pineBg`/`pineBar`/`pineLabel`/`pineLine`（`pineDrawings.ts:39-43`），一律带 `lock: true` 落地（`:374`），且**都不在用户工具表里** ⇒ 它们在清单里有行、行上的 `locked` 是 true，可点删除又删得动。删除按钮现在的 `title` 问的是**行上的** `row.locked`（`ProChart.tsx:3289-3293`），`removeDrawing` 问的是**实例级归属**（`:2422`）⇒ 对这几行文案说「这条线锁着，删不掉」而实际删得动，正是本片规则单点要避免的那种差（拦截面改了归属、文案面漏了）。

改法一行，**不新增导出、不给 `DrawingRow` 加位**（那会把一次文案差扩成又一次「改签名＋改消费者」）：

```tsx
                  title={
                    canDeleteDrawing(
                      isLockedUserDrawing({ lock: row.locked, name: row.name }),
                      allowDeleteLocked
                    )
                      ? "删除这条线"
                      : "这条线锁着，删不掉——先「解锁」，或打开工具栏的「锁定线可删」"
                  }
```

`isLockedUserDrawing` 的形参是 `unknown` 且只读 `.lock`／`.name`（`chartDrawings.ts:808-812`），`DrawingRow` 这两员都在（`locked` 声明 `:860`、赋值 `:951`；`name` 同函数返回体里）⇒ 复用的是同一枚判断点。**不许**写成 `row.locked && !allowDeleteLocked && toolOf(row.name)` 那种在页面重拼合取式的样子——那才是真的规则分叉。清单那行的**锁定按钮**三态 `title` 不动：它说的是「拖不动」，对 `lock: true` 的 Pine 装饰成立。

针（页面面，一根）：清单里同时有一条用户锁定线与一条 Pine 形状的锁定条目时，前者的删除按钮 `title` 是拦下那句、后者逐字是「删除这条线」。Pine 那行怎么造由你当场定（把替身实例的 `name` 改成 `"pineBg"` 是最近的路，改完要确认 `drawRows` 里真有它、行也真带 `locked`）。**判别力必须靠 Step 6 的 M2 供**：M2 跑完这根针若不红，它就是恒绿的豁免型针，按缺陷登记而不是放行（本仓规则：豁免型针天生恒绿，判别力只能由变异给）。

- [ ] **Step 5c：三处 Task 4 评审收口（都在测试文件里，改完再跑 Step 6，否则变异记账对不上）**

1. **本片写进测试文件的三处引用行号已被本片自己推旧**（违反计划「引用行号一律现读」）：指向 `ProChart.tsx` 里 `setDrawNotice(null)` 那行的那处、指向既有三枚 helper 的那组「现读 `:1863`/`:1867`/`:1884`」、以及一枚**没带文件名**的裸 `:1214`。一律改成**按名引用**（「住在 `describe("/pro-chart 副图上的画线")` 回调体里的那三枚 helper」这种写法），不要把号改对了继续钉着——新针自己就会再把它推走。
2. `expect(...removeOverlay.mock.calls.every((c) => c.length === 1 && !!c[0]?.id)).toBe(true)` 在**空调用数组上是真空真**（本仓有前科的形状）：同一根针里补一句 `calls.length` 的期望值，数字由你当场从替身记录里读，别照抄本计划的任何数。
3. 暂存那根针末行用的是 `expect(bucket()).toHaveLength(0)`，而 `bucket()` 里那句 `?? []` 把「键整个消失」和「空数组」抹平了，同文件姊妹针用的是 `toBeUndefined()` ⇒ 这一档比姊妹针弱。改成能区分两者的判据（改完它仍要绿；不绿就说明桶其实还在，那是一条发现，如实登记）。

- [ ] **Step 6：四件变异自证（spec §6 点名三件，本计划补第四件 E3）**

每件：改→跑→记下**哪几枚针红**→还原。

```bash
cd "E:/Vibe-Trading-main/Vibe-Trading-main/frontend"
```

| # | 变异 | 必红的针 |
|---|---|---|
| M1 | `canDeleteDrawing` 写成 `return true;` | 守卫那几枚 lib 针（右键拦下／Pine 归属／翻转的两次拦）、页面的「锁着的线右键删不动」针、Task 4 的入口针、`removeLatestDrawing` 的两根、E5 |
| M2 | 把任一批量入口改成也判 Pine（`isLockedUserDrawing` 里去掉 `toolOf` 那一问，只留 `lock !== true` 反了的形式：`return o.lock === true;`） | Pine 归属针＋E5（这条正是裁定那一节的后果面；不红说明那两根针没判别力） |
| M3 | §5.1 的 ref 读法换成创建时捕获：`makeDrawingEvents` 里改判 `hooks.allowDeleteLocked` 的**返回值快照**（在函数体外 `const allow = hooks.allowDeleteLocked()`，守卫里用 `allow`） | 「翻转生效」那根针必须红；**若不红，那根针是恒真的，本片最容易被当成测过了的一处** |
| M4 | 把 E3 那条豁免摘掉（`reanchorOverlay` 的 drop 分支前临时插一句 `if (o.lock === true) return report;`） | E3「吸回后退化成一点的锁定线照样被丢掉」必须红。**这根变异是 M1-M3 之外补的**：spec §6 只点名三枚，§3.2 要求每条豁免都有一根「摘掉豁免会红」的针，而 E3 是唯一一条能用变异证的（其余四条走的是页面路径，M1 已经覆盖）。测完还原，别把这一句留在树里 |

还原后复跑：

```bash
npx vitest run src/lib/__tests__/chartDrawings.test.ts src/pages/__tests__/ProChartDrawings.test.tsx
```

- [ ] **Step 7：六道门全量**（spec §8 第 3 步那张清单；前端几枚在 `frontend/` 跑，Python／shell 几枚在仓库根跑）

```bash
cd "E:/Vibe-Trading-main/Vibe-Trading-main/frontend"
npx tsc -b
npx vitest run
npm run build
cd "E:/Vibe-Trading-main/Vibe-Trading-main"
python -X utf8 -m pytest tools/test_wiki_drift.py tools/test_wiki_qmind.py -q
python -X utf8 tools/forensics_audit.py
python -X utf8 -m pytest tools/test_forensics_spec.py -q
bash tools/wiki_freshness_gate.sh
bash tools/ci_grep_gates.sh
```

两枚本机恒红门（水位、grep 命中）要按**交集证据**证明本片 0 贡献，不靠感觉：`git diff --name-only <基座>..HEAD` 与那两枚红的判定集求交，空集才算归属成立，并把现读到的那条判定行贴出来（本片面只有 `frontend/src/**`、`forensics/**`、`superpowers/**`、`项目档案.md`）。

- [ ] **Step 8：读数只写进本片台账，不进被跟踪文档**（自指纪律）。

---

### Task 6：活体回归——五入口 × 两态，逐条真点

**Files:**
- Create（仓外）：`$TEMP/rea-l3t1/regress.mjs`（复用 Task 1 的 `cdp.mjs`）
- Modify：无——**本任务的产出是读数**。任何一条不符就进 Task 5 的修复轮形状（针复现→改实现→复跑），不在活体现场调代码。

- [ ] **Step 1：起现场**（同 Task 1 Step 2-3；PID／`target_id` 一律现读）
- [ ] **Step 2：造一条含锁定线的两线桶**

```bash
node -e '
const b64u = (s) => Buffer.from(s, "utf8").toString("base64").replace(/\+/g,"-").replace(/\//g,"_").replace(/=+$/,"");
const pts = (v) => [{ timestamp: 4102444800000, value: v }];
const d = [
  { name: "horizontalStraightLine", paneId: "candle_pane", points: pts(1700) },
  { name: "horizontalStraightLine", paneId: "candle_pane", points: pts(1500), lock: true },
];
const code = "j" + b64u(JSON.stringify({ v: 2, d }));
console.log(code);
console.log(JSON.stringify(JSON.parse(Buffer.from(code.slice(1).replace(/-/g,"+").replace(/_/g,"/"), "base64").toString("utf8"))));
' | tee "$TEMP/rea-l3t1/code2.txt"
```

判据：第二行回读逐字含一处 `"lock":true`、一处没有。
- [ ] **Step 3：写 `regress.mjs`**

形状：两态各跑一遍，每态先 `boot`（`?d=<code2>`），然后按入口逐条做，读 `getOverlays()` 的 `lock` 分布。**开关用 storage 设**（不靠点按钮，省一次状态依赖）：`localStorage.setItem("pro-chart.delete_locked.v1", want ? "1" : "0")` 之后再 `go(BASE)` 一次让它生效。四枚按钮入口用 `el.click()`（现读到 `aria-label`／文案），右键入口复用 Task 1 定住的坐标法（重新 `aim` 再点，rect 会随渲染位移）。

```js
import { connect, FIND_CHART, sleep } from "./cdp.mjs";

const BASE = "http://localhost:5899/pro-chart";
const CODE = process.argv[2];
if (!CODE) throw new Error("usage: node regress.mjs <j... 两线分享码>");
const log = (...a) => console.log(a.join(" | "));

const b = await connect("/pro-chart");
const lockMap = () =>
  b.ev(`(() => {
    const c = window.__c;
    if (!c || typeof c.getOverlays !== "function") return "NO_CHART";
    return c.getOverlays().map((o) => o.name + (o.lock === true ? "=L" : "=F")).join(",") || "NONE";
  })()`);
const clickByLabel = (label) =>
  b.ev(`(() => {
    const els = Array.from(document.querySelectorAll("button"));
    const hit = els.find((e) => (e.getAttribute("aria-label") || e.textContent || "").trim().startsWith(${JSON.stringify(label)}));
    if (!hit) return "NO_BUTTON";
    hit.click();
    return "clicked " + (hit.getAttribute("aria-label") || hit.textContent.trim());
  })()`);
/**
 * 提示条**没有稳定钩子可指**：它就是工具栏行末那枚 `<span className={cn("text-xs", …)}>`
 * （现读 `ProChart.tsx:2953-2968`，`drawNotice.text` 在 `:2958`），文案随状态在四五句之间换，
 * 仓里没有 `data-*` 键。所以读数按「哪几枚 text-xs 的 span 有话」取，并把原文整句照抄进
 * log——判决对着原文下，不按关键词命中数下。
 */
const noticeText = () => b.ev(`(() => {
  const spans = Array.from(document.querySelectorAll("span")).filter((s) => /text-xs/.test(String(s.className)) && s.textContent);
  const hit = spans.filter((s) => /(锁着|锁定线可删|已画|在等)/.test(s.textContent)).map((s) => s.textContent.trim());
  return hit.length ? hit.join(" ‖ ") : "NO_NOTICE";
})()`);

/** 把那条锁定线搬到蜡烛面板正中，并回传视口坐标（Task 1 的同一手法）。 */
const aim = () =>
  b.ev(`JSON.stringify((() => {
    const c = window.__c;
    const el = c.getDom("candle_pane", "main");
    const r = el.getBoundingClientRect();
    const p = c.convertFromPixel({ x: r.width / 2, y: r.height / 2 }, { paneId: "candle_pane" });
    const o = c.getOverlays().filter((x) => x.lock === true)[0];
    if (!o || typeof p.value !== "number" || typeof p.timestamp !== "number") return { err: "aim failed " + JSON.stringify(p) };
    c.overrideOverlay({ id: o.id, points: [{ timestamp: p.timestamp, value: p.value }] });
    const back = c.convertToPixel({ timestamp: p.timestamp, value: p.value }, { paneId: "candle_pane" });
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + back.y), id: o.id };
  })())`);

async function boot(allow) {
  await b.go(BASE);
  await sleep(1200);
  // 清掉上一腿留下的桶再带码进页面：清除／撤销那两条腿会把桶改写，下一趟 `?d=` 只是
  // 在残留上叠加，「一条锁着、一条没锁」这个形状就读不出唯一行为差了。profile 是本趟
  // 一次性起的，清它不碰真实数据。
  await b.ev(`localStorage.removeItem("pro-chart.drawings.v1")`);
  await b.ev(`localStorage.setItem("pro-chart.delete_locked.v1", ${allow ? '"1"' : '"0"'})`);
  await b.go(`${BASE}?d=${CODE}`);
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    await b.ev(`(${FIND_CHART})`);
    const m = String(await lockMap());
    const parts = m === "NONE" || m === "NO_CHART" ? [] : m.split(",");
    if (parts.length === 2 && parts.filter((s) => s.endsWith("=L")).length === 1) { log("boot", `allow=${allow}`, m); return; }
    if (i === 59) throw new Error(`allow=${allow}: the two lines never landed — last ${m}`);
  }
}

for (const allow of [false, true]) {
  const tag = allow ? "ON(现状)" : "OFF(保护)";

  // 入口 1：右键那条锁定线
  await boot(allow);
  let g = JSON.parse(await aim());
  if (g.err) throw new Error(g.err);
  await b.rightClickAt(g.x, g.y);
  log(tag, "1 右键", await lockMap());

  // 入口 2：清单行的删除按钮（面板得先开着）
  await boot(allow);
  g = JSON.parse(await aim());
  log(tag, "open 清单", String(await clickByLabel("画线清单")));
  await sleep(200);
  log(tag, "2 清单行删除", String(await b.ev(`(() => {
    const c = window.__c;
    const o = c.getOverlays().filter((x) => x.lock === true)[0];
    const btn = Array.from(document.querySelectorAll("button")).find((e) => (e.getAttribute("aria-label") || "").startsWith("删除画线 " + o.id));
    if (!btn) return "NO_ROW_BUTTON";
    btn.click();
    return "clicked";
  })()`)));
  await sleep(250);
  log(tag, "2 之后", await lockMap(), await noticeText());

  // 入口 4：撤销（最新的是那条锁定线 ⇒ 关着时应跳过去删前一条）
  await boot(allow);
  log(tag, "4 撤销", String(await clickByLabel("撤销")));
  await sleep(250);
  log(tag, "4 之后", await lockMap(), await noticeText());

  // 入口 3：清除
  await boot(allow);
  log(tag, "3 清除", String(await clickByLabel("清除")));
  await sleep(250);
  log(tag, "3 之后", await lockMap(), await noticeText());

  // 入口 5：暂存桶丢弃——用一次性 profile 直接种一个不可达面板地址（第一方桶格式，**由我方种盘**，记录里要署名）
  await b.go(BASE);
  await sleep(800);
  await b.ev(`(() => {
    const buckets = JSON.parse(localStorage.getItem("pro-chart.drawings.v1") || "{}");
    buckets["600519.SH|1D"] = [
      { name: "priceLine", paneId: "indicator_pane_probe_a", points: [{ timestamp: 1700000000000, value: 100 }] },
      { name: "priceLine", paneId: "indicator_pane_probe_b", points: [{ timestamp: 1700000000000, value: 101 }], lock: true },
    ];
    localStorage.setItem("pro-chart.drawings.v1", JSON.stringify(buckets));
    localStorage.setItem("pro-chart.delete_locked.v1", ${allow ? '"1"' : '"0"'});
    return "seeded";
  })()`);
  await b.go(BASE);
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    await b.ev(`(${FIND_CHART})`);
    if ((await b.ev(`document.body.innerText.includes("条在等副图")`)) === true) break;
  }
  log(tag, "5 暂存可见", String(await b.ev(`document.body.innerText.match(/\\d+ 条在等副图[^\\n]*/)?.[0] ?? "NO_PARKED_STRIP"`)));
  log(tag, "5 删除待恢复", String(await clickByLabel("删除待恢复的画线")));
  await sleep(300);
  log(tag, "5 之后桶", await b.ev(`(() => { const l = JSON.parse(localStorage.getItem("pro-chart.drawings.v1") || "{}")["600519.SH|1D"] || []; return l.map((d) => d.name + (d.lock === true ? "=L" : "=F")).join(",") || "EMPTY"; })()`));
}

b.close();
```

跑：

```bash
cd "$TEMP/rea-l3t1"
node regress.mjs "<CODE>" 2>&1 | tee regress.out
```

- [ ] **Step 4：判据（成对，缺一半就读不出「规则本体是唯一的行为差」）**

`regress.out` 的每一行按下表对号，**两态差集必须恰好等于「锁定线在不在」**：

| 入口 | OFF 期望 | ON 期望 |
|---|---|---|
| 1 右键 | 锁定线仍在（`=L` 还在） | 锁定线被删 |
| 2 清单行删除 | 仍在，且提示文案出现 | 被删，无提示 |
| 3 清除 | 没锁的那条走，锁定线留，提示「N 条锁着的线留着没删」 | 两条都走，无提示 |
| 4 撤销 | 删掉没锁的那条，锁定线留，提示「撤销跳过了 1 条」 | 删掉最新那条（=锁定线） |
| 5 删除待恢复 | 桶里只剩 `=L` | 桶空 |

不符就按 systematic-debugging 走：先定「哪一半红」，再用一根 jsdom 针复现（复现不出来＝替身失真，先修替身），最后才动实现。**不许**放宽表格任何一格。
- [ ] **Step 5：清场**（Task 1 Step 9 同法，只按现读 PID 停）。
- [ ] **Step 6：画线不漂移自查（spec §8 第 5 步的替代）**

判据：`lock` 与偏好翻转**不改几何**。活体读法——`await b.ev("JSON.stringify(window.__c.getOverlays().map(o => o.points))")` 在「翻转开关前后」「右键被拦下前后」两次取样，两次逐字相等；锁定态本身翻转（清单行那枚）前后 points 也相等。jsdom 侧 Task 4 的清除/撤销针已断言 `h.overlays` 的 id 集合变化，几何面在这里断。
另外登记一句：本片不读行情、不产信号 ⇒ Bar Replay 那五步**不适用**（裁掉，不是忘了）。
- [ ] **Step 7：把 `regress.out` 的关键行摘要登记进台账；若发现缺陷，走修复轮并在此登记带日期的追加子句（原句不删）。** 本任务默认不产生仓内提交。

---

### Task 7：文档面（矩阵格／L1 行／档案最后一笔）＋ 记忆 ＋ 最终整支评审

**Files:**
- Modify: `forensics/gap-matrix.md`（TV-DW-05 那一行，**单物理行**内追加）
- Modify: `forensics/spec/drawings.md`（TV-DW-05 那一行同样单行内追加）
- Modify: `项目档案.md`（仓库根，CRLF，bytes 层追加一节）
- Modify: 两份记忆（在仓库外）

- [ ] **Step 1：现读两枚「号」**

```bash
cd "E:/Vibe-Trading-main/Vibe-Trading-main"
grep -n "TV-DW-05" forensics/gap-matrix.md forensics/spec/drawings.md
awk 'NR==<现读行号>' forensics/gap-matrix.md | grep -o '[①-⓾]' | tail -1
grep -an '^### 7\.' 项目档案.md | tail -3
tr -cd '\r' < 项目档案.md | wc -c
```

矩阵格那一行的圆圈序号只按现读到的下一枚写（第①片那格末尾是 `⑦`，本片**不预测**是几）；档案新节号 = 现读最后一节 +1（基座上是 `### 7.25 …`，则本片 `### 7.26 …`）。矩阵行是 5 列 6 根竖线的单行⇒ 追加只能进**说明列**内部，且 `| ` 根数不许变；改完用 `awk -F'|' 'NR==<行号>{print NF}'` 复算，数字与改前一致才算没破表。

- [ ] **Step 2：矩阵格追加（判态句必须写死）**

追加内容（一行内，接在既有 `⑦` 之后、那一行的结尾竖线之前）：

```
【2026-10-17 L3 第②片实现席：<现读下一枚圆圈号> 本片落「锁定线可否删除」那一半，本格**仍判 `部分`**，判态句是「只剩收藏画线工具栏那一半没做」——那半的前提控件在本仓不存在（「收藏」只有标的 watchlist，`frontend/src/components/charts/WatchList.tsx:91` 现读），给不存在的控件做可见性开关不是本片范围。规则本体＝`canDeleteDrawing` 四行真值表（`frontend/src/lib/chartDrawings.ts:<现读>`）＋归属谓词 `isLockedUserDrawing`（同一处，理由见 `<现读>`），五个用户入口逐个接线（右键守卫 `makeDrawingEvents`／清单行删除／清除／撤销／暂存丢弃），偏好键 `pro-chart.delete_locked.v1` 默认 false＝锁定受保护，形状照磁吸那枚键。② 活体那笔欠账已在 Task 1 还掉：三腿对照（未挂回调被删／挂而不拦被删／挂且 `preventDefault` 存活）落在 `forensics/l0/self-dw05-lock-veto.md`，其中否决那一读的通道是原始 CDP 而非 REA（理由与该条 L0 里的登记都在那份记录里）。③ 三条自拟边界原样保留：键值面从未读过；「开关打开＝允许删除锁定线」是本仓自拟规格；scope 归属（持久级）照 L1 写。④ 对本仓 spec §3.2 的一处更正：Pine 的 overlay **就是** `lock: true`（`frontend/src/lib/pineDrawings.ts:374` 现读），所以规则必须问归属而不是只问 `lock`，否则「清除」会跳过脚本层——一条没人要求的行为差。⑤ 域名红线：本片对 `frontend/src` 新增的串只有自家键名 `pro-chart.delete_locked.v1` 与中文文案，对方键名 `tradingview.toggle_delete_locked_linetools` 只出现在取证文档面。】
```

L1 行（`forensics/spec/drawings.md` 的 TV-DW-05）追加一小句同样带日期、原句不删，内容固定为：**本片之后「键名↔界面行为」仍是推断，值面仍未读**；本仓实现的语义是自拟规格，不许被读成对方页面的复刻主张。

**同一步里还要收掉 Task 1 留下的一处偏差（2026-10-17 控制席裁定，执行席不得吃掉）**：那份 L0 记录现在写的是 `用途：基线` 而不是本计划 Task 1 要求的 `用途：规格`。原因是两道要求在基座那一站不能共存——`tools/forensics_audit.py` 的孤证规则是「`用途` 不属于 `harness`/`基线`/不可取证 ⇒ 必须被某条规格条目的 `L0 依据` 引用」，而本片七步里原本没有任何一步引用它（`grep -n "L0 依据"` 在本计划正文里无输出），写 `规格` 当场 rc=1。落档席按仓内既有口径选了 `基线` 并把推理写进记录的「偏差」一节，这是对的处置。⇒ 本步把引用补上并翻面，**两半必须在同一笔提交里落地**：

- 在那一格的 `L0 依据` 列末追加一枚引用，形状照该格既有那两枚的顿号分隔（现读 `grep -n "^| TV-DW-05 " forensics/spec/drawings.md` 那一行末段），追加的是 `self-dw05-lock-veto.md`。
- 同笔把该记录里 `grep -n "^- 用途" forensics/l0/self-dw05-lock-veto.md` 现读到的那一行从 `用途：基线` 改成 `用途：规格`。
- 同一笔还要给那份记录的「偏差」一节写**带日期追加更正（原句一字不删）**：那句「本片七个任务没有任何一步引用它」在 `87bd946d` 那一站是真话，但 `bb56c6a8` 已经把这一步补进了计划 ⇒ 现在它过时了，要按仓规追加而不是原地覆盖。同一节里若还留着「166 passed／1 failed, 165 passed」这类**门计数**读数，把它们改成 **rc 形状**（`rc=0`／`rc=1`）——条数会随后续任何一笔动作漂，计数写在被引用的文档里就是定时炸弹（见记忆「文档里的自指读数」）。
- 改完复跑 `python -X utf8 tools/forensics_audit.py` 与 `python -X utf8 -m pytest tools/test_forensics_spec.py -q`（两枚都吃 `forensics/`，这是本计划「改档案要复跑读档门」那条旧规矩的同一件事）。
- **不许**先把 `用途` 翻过去再补引用（中间那一站分支是红的，违反本仓「每笔提交门全绿」）；也**不许**让它长期挂 `基线`——这份记录本来就是 TV-DW-05 后半个键的验收凭据，挂旁证是把地基记成附注。

- [ ] **Step 3：档案 §<现读新号> 一节（bytes 层追加，CRLF）**

标题：

```
### 7.26 REA 复刻漏斗 L3 第②片：锁定的画线不可删（分支 `feat/l3-slice2-locked-delete`，基座 <现读 `git log --oneline -1` 的短号>，开工 2026-10-17；设计席＋探针席＋实现席＋评审席）
```

正文用既有那节的**粗体标签 bullet** 形状（现读 §7.25 的标签逐字抄结构），本片六条：

1. **这一节管什么**——TV-DW-05 那格的后半个键；判态仍 `部分`，判态句「只剩收藏画线工具栏那一半没做」。
2. **活体那笔账是怎么还的**——三腿对照为什么缺一腿就下不了结论；`preventDefault` 的效力与「挂了回调」的区分；否决读数走原始 CDP 通道这件事的登记与**降级出路**（判不够格就整条降 `不可取证`）。
3. **实现与判据的实测读数**——四行真值表／五个入口／五条豁免线各自那根针／三件变异各自红在哪枚／六道门（两枚恒红门的交集证据）／活体两态五入口表。数字一律现读，**本节不写本片共几笔提交**。
4. **一处对 spec 的更正与它的后果**——`pineDrawings.ts:374` 那句；判据形状从「只问 lock」收窄成「lock 且归属为用户工具」；为什么这正是本仓「盖章范围超出实际所做工」那枚旧病灶的正面处置。
5. **默认值方向的判据**——默认关＝上线当天手感真的变；`allow` 为 true 时五入口逐字同旧形状；为什么「开＝现状」那条成对针的价值不是「本片无风险」。
6. **刻意分歧与未尽项**——收藏画线工具栏那一半（前提控件不存在）；`figure.ignoreEvent` 通道被否；键盘删除库里根本没有；文案不进 9 份 locale；合回 `main` 与推 origin 各等一次单独点头。

追加写法（bytes 层，别用文本层，`newline=None` 会把 CRLF 翻译成 LF 并让 git 放弃归一化）：

```bash
cd "E:/Vibe-Trading-main/Vibe-Trading-main"
python -X utf8 - <<'PY'
from pathlib import Path
p = Path("项目档案.md")
b = p.read_bytes()
assert b.endswith(b"\r\n"), "档案不以 CRLF 行尾结束，先现读末尾再决定怎么接"
sec = (
    "\r\n### 7.26 ……（上面那节的正文，逐行以 \r\n 结尾）\r\n"
).encode("utf-8")
p.write_bytes(b + sec)
print(len(b), "->", p.stat().st_size)
PY
tr -cd '\r' < 项目档案.md | wc -c   # 与改前 + 本节行数一致
```

改完**复跑吃档案的那两枚门**（`forensics_audit.py` 与 `ci_grep_gates.sh` 都会扫到它；交付态的复跑读数只落台账，不写回档案——避免自指）。

- [ ] **Step 4：记忆更正（仓库外，两份）**

| 文件 | 动作 |
|---|---|
| `C:\Users\fire\.qoder-cn\projects\E--Vibe-Trading-main-Vibe-Trading-main\memory\chart-overlay-flags-lock-visible.md` | 追加：`lock` 在本仓现在**有**删除侧效力（五个用户入口＋`pro-chart.delete_locked.v1`，默认保护）；并留一句「库自身仍不读 `lock` 来拦右键，是本仓挂的 `onRightClick` 守卫」；顺带登记 Pine 的 `lock:true` 这个坑 |
| `...\memory\ops-delivered-features-and-comparisons.md` | 追加一行：L3 第②片的分支与提交坐标（号一律现读 `git log --oneline -3`），判态写明仍 `部分` |

两份都要同步 `MEMORY.md` 索引那一行（≤150 字符），并**逐字核对索引行里的旧数字**——记忆条目数请每次重新 `find -maxdepth 1 -name '*.md' | wc -l`，别引用文件里写的旧数。

- [ ] **Step 5：提交（文档三面分三笔，档案永远最后一笔）**

```bash
cd "E:/Vibe-Trading-main/Vibe-Trading-main"
git add -f forensics/gap-matrix.md forensics/spec/drawings.md forensics/l0/self-dw05-lock-veto.md
git commit -s -m "$(cat <<'MSG'
docs(matrix,spec,l0): TV-DW-05 追加第②片读数并给活体记录翻面

后半个键落地、活体那笔账还掉；前半的收藏画线工具栏在本仓没有那枚控件，
所以判态句写死成「只剩那一半没做」，不升态。Pine 的 lock:true 那个更正
一并挂在这一格。引用与 `用途：规格` 同笔——拆开任何一半都让孤证门红一站。
MSG
)" -- forensics/gap-matrix.md forensics/spec/drawings.md forensics/l0/self-dw05-lock-veto.md
git commit -s -m "$(cat <<'MSG'
docs(archive): §7.26 L3 第②片——锁定的画线不可删

三腿活体对照、五入口与五豁免、一处对 spec 的带日期更正，都在这一节。
MSG
)" -- 项目档案.md
```

（`项目档案.md` 已被跟踪，不需要 `-f`；`git status` 若在同一命令里显示别的未跟踪件，不要顺手 `git add -A`。）

- [ ] **Step 6：最终整支评审**

```bash
BASE=$(git rev-parse <计划开头记录的基座短号>)
git log --oneline ${BASE}..HEAD
git diff --stat ${BASE}..HEAD
```

派一枚整支评审席（`Agent`，`subagent_type: general-purpose`），简报里给：spec 路径、本计划路径、`BASE..HEAD` 的范围、六道门命令、以及**给它写死的三条取证协议**——(1) 每个引用坐标必须自己 `sed -n` 现读；(2) 判定的红／绿必须贴当趟 stdout；(3) 不许凭「测试长这样」的记忆下结论。评审面重点四问：替身 `rightClickDelete` 的新顺序是否与 dist 8774-8789 逐字同形；M3 那根翻转针的判别力（恒真风险最高）；`clearDraw` 从整体清改逐条删之后，半成品出清与 `_progressOverlayInfo` 那条链是否仍然成立；默认值方向带来的手感变化有没有被任何一处文案说反。

发现按 subagent-driven-development 的循环走：一修复席＋一次收窄复评＋残留逐条裁定。

- [ ] **Step 7：收尾报告（不含合并与推送）**

报告三件事：本片做了什么（五入口＋一开关）、判态为什么仍 `部分`、以及**两枚待点头项**——合回 `main`、推 `origin`。不自行执行。

## 2026-10-17 控制席追加更正（八）：spec §6 那句「按钮 title 要说『N 条被锁定跳过』」没被七个任务里的任何一步承接 ⇒ 最终评审判 plan-mandated，缺口由修复轮补（上面所有原句保留，不删）

1. **现场**：spec `superpowers/specs/2026-10-16-l3-slice2-locked-delete-veto-design.md:113` 对撤销那一条逐字写着「`kept` 非空时按钮 title 要说『N 条被锁定跳过』，否则用户按了没反应会当成按钮坏了」。本计划承接的是「点完之后那一行 `drawNotice` 把计数说出来」这一半；**「按钮 title」那一半在本计划正文里一个字都没出现**（Task 4 写入口接线、Task 5 写页面针，两步的文案清单里都没有撤销／清除那两枚工具栏按钮的 title）。于是执行席照计划实现，两片 title 全程静态，而默认态（保护）下全锁时这两枚按钮点了其实一条都不删 ⇒ **title 在说假话**，测试面对这两枚 title 零断言。
2. **判据性质**：这不是执行席漏做，是**计划对 spec 的覆盖缺口**。评审席判 `plan-mandated: 是`，控制席现读 spec 原文后接受该判定。处置分两半：代码面进修复轮（title 只在 `!allowDeleteLocked` 且该入口的锁定跳过数 > 0 时并入句子；撤销与清除的计数来源不同，各算各的；针逐字 `toBe`，并覆盖「开关翻开后 title 回落到旧句子」那一半），文档面就是本条。
3. **病灶命名**：这是「计划正文『逐字照抄』的执行期病灶」的**新形态**——前面七条追加更正治的都是「照抄时读错坐标／引用已过期／把门读数写进被门扫的文件」，本条治的是**「spec 的句子在计划里没有对应的 Step」**。逐字照抄只保护写了的那些字，不暴露没写的句子。配方往前置一步：计划写完，把 spec 里每一句带「必须／要说／不许／只能」的断言逐条指到某个任务的某个 Step；指不到 Step 的句子就是计划缺陷，别指望执行席或评审席替你补覆盖。
4. **同一枚修复轮的第二件**（登记性质不同，不是计划缺陷）：`frontend/src/lib/chartDrawings.ts` 里逐条删那段注释主张「画到一半那条也在这一趟里出清，不必先调 `cancelInProgress`」，其真库依据是 `StoreImp.removeOverlay` 在 `isDrawing()` 时把 `_progressOverlayInfo` 置空；本仓测试面（含页面替身）没建模那枚字段，也没有任何一根针钉住「半成品确实被这一趟带走」⇒ 计划要求「与库同形」的覆盖，同形的两半里缺了半成品那一半。修复轮补了一根纯 lib 针（桶里同时放已画完的没锁线、进行中的半成品、锁定那一条，断言只有锁定的留下），并让它对「删除循环加回 `&& !isInProgress(o)`」这枚变异必红。注释本身不改口。
5. **复评又抓到同类的第二枚缺口，且它撞在本计划自己的旧追加更正（五）那枚病灶上**：修复轮把 title 的计数写对了（问归属谓词），但三格 title 针**不辨归属**——把计数换成行上的裸 `locked` 这枚变异让整页针全绿（存活变异）。这正是追加更正（五）说过的那一类：拦截面改了归属、文案面漏了。差别在于上一回漏的是清单行的删除按钮、这一回漏的是批量入口的按钮，而针的写法也一样漏了判别力那一步。⇒ 控制席本人补了第四根针（图上同时放一条用户锁定线与一条 Pine 锁定装饰，钉两枚 title 都只报 1 条，并当场点「清除」验证那句数字是真话），变异红/还原绿两段由控制席当趟跑齐。**配方**：凡「文案问归属」的实现，配套针必须在「装饰也带 lock:true」的混合桶上跑；只在用户线上验的 title 针，对「退回裸 `locked`」这类变异天生失明。
6. **顺手改口的注释面**：本片新写的两枚测试注释把 Pine 装饰数成「四种」，而 `pineDrawings.ts` 的 `NAME` 表是七枚、`lock: true` 由 `toCreate` 统一交。判定与规则都没变（七枚都不在 `DRAW_TOOLS` 里，批量删除对它们一律不豁免），只是注释说了假话，已按现读改口。本计划 `:1756` 那句「Pine 那四种装饰的名字是 …」按仓规**原地不覆盖**，由本条承载更正。
