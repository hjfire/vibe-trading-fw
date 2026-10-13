# 差距矩阵（L2）：批次 A 的规格条目 ↔ 本仓实现面

这一层的唯一问题是一句话：**这条规格在本仓有没有对应实现**。它把 L1（`docs/forensics/spec/`）的每一条
条目号拿到本仓 `frontend/src` 与 `tools/` 对照一遍，四态判：`已有`／`部分`／`缺`／`不可复刻`。

口径（写死在这里，别让下一席猜）：

- 状态列判的是**本仓有没有这段实现**，不是「取证那一趟跑没跑」。L1 里 TV-DW-07／TV-CI-07 的判据列明写了
  「本席未跑这两趟（只读席不起浏览器）」，那是执行归属（T10／T11 门禁趟），不是 L1 缺陷，也不构成这里的 `缺`。
  （2026-10-14 追加：这两格后来都由活体席跑掉了，执行读数写在两行自己以及 L1 两格的追加子句里；上面这句作为**口径**
  继续有效——它说的仍然是「状态列不跟着执行归属走」，而 DW-07 那一行的升态判的是实现产出的像素被实测等值坐实这件事，
  不是「跑过一趟」这件事。）
- `已有`／`部分` 的第三列只有一个 `路径:行号`，由校验器验「在仓库根之内、不在 docs/forensics 之下、文件存在、
  行号不越界」；「那一行指的是不是那回事」它判不了，所以每一条本席都 `sed -n '<行号>p'` 亲眼开过，
  读数逐字贴在 `.superpowers/sdd/2026-10-13-rea-forensics-p0-p1/task-10-report.md`。
- `缺` 的第三列以 `未找到：` 开头，后面是给下一席复制粘贴就能复跑的 needle；每条本席当场跑过、当场 0 命中。
- 优先级列本片全写 `-`：排期属 P3，本片不替它决定。
- 判不准／证据不够的宁可降级成 `部分` 或 `缺`，并把降级理由写进说明列——这些行在报告里另立一节。
- 三条批次 A 带过来的限制照走：像素类条目只写等值形状，不写期望常量也不写像素差；A4 那一族八枚 `listeners`
  全空（含 `body` 对照组）只证「枚举面可用」，任何一行都不许推成「TV 那处没有事件绑定」；A1 的 `dom` 段只给
  属性名不给值，所以本矩阵没有任何一行拿 id／class 属性值当凭据。
- A12（Pine 编辑器）与 A13（告警对话框）是判据缺口、结构上没有 `evidence_id`，L1 未为它们立条目 ⇒
  本矩阵也没有它们的行（出现了就是「凭空条目」）；它们的成因（需登录＋裁定 1 不做登录绕过）在 L1 的边界小节里。
- 条目号一列是从两张 L1 表的第一列**抄**的（`eba67683` 之后那版），本席数出 15 条，与校验器的
  「有 N 条规格条目」同一把尺；没有自拟、合并或省略。

| 条目号 | 状态 | 本仓坐标或搜索记录 | 优先级 | 说明 |
|---|---|---|---|---|
| TV-DW-01 | 部分 | frontend/src/pages/ProChart.tsx:2778 | - | 那一行是 `{DRAW_TOOLS.map((t) => (` ——本仓的画线目录是工具条里平铺出来的一排按钮（目录数组＝`frontend/src/lib/chartDrawings.ts:131` 的 DRAW_TOOLS，本席现读 13 枚条目行）。有「扁平＋可达名到名字级」这一半（可达名是中文：趋势线／射线／平行线／价格通道／标注…），没有 20 行 row 条目、没有 3 行自带同名 gridcell 的分组行、没有 Lines／Channels／Pitchforks 三个分组，工具集也按 klinecharts 的 overlay 名划分、与对方 Trend tools 那个目录不同集。本行不拿 A1 的 dom 段（只给属性名）指认任何元素。 |
| TV-DW-02 | 部分 | frontend/src/pages/ProChart.tsx:3060 | - | 那一行是 `{drawPanelOpen && (` ——图元集合的管理面板有，入口就是 TV-CI-07 那枚开关，但形状不同：面板体是工具条下方的整宽滚动条（同一行往下是 `max-h-[132px]` 那个 div），不是右侧面板；面板里只有一列画线行，没有两页 tablist、没有 Object tree 与 Data window 之分（本席现跑 `grep -rn --include=*.tsx -e tablist -e 'role="tab"' frontend/src/pages/ProChart.tsx frontend/src/components/charts`＝0 命中、rc=1；仓内别处确有这种写法——`grep -rln -e tablist -e 'role="tab"' frontend/src` 命中 `WelcomeScreen.tsx`／`RunDetail.tsx`／`RunDetail.test.tsx`，所以本行只宣称图表面这一片没有，不假装全仓皆空）。「默认落在哪一页」在本仓没有对应物。 |
| TV-DW-03 | 缺 | 未找到：对象树工具条那四个动作（建组／克隆复制／移动／管理布局图元）的任何一个 —— 复跑命令 `grep -rn --include=*.ts --include=*.tsx -e 对象树 -e 克隆 -e 建组 frontend/src`（本席 2026-10-14 跑＝0 命中，rc=1） | - | 本仓清单给的不是那四个动作：行内是 选中／画线文字／锁定／隐藏／删除（`frontend/src/pages/ProChart.tsx` 的 3077／3114／3158／3167／3176），面板级是 清除／导出／链接／导入（同一文件的**可达名行** 2822／2847／2856／2865——2856 逐字 `aria-label="复制画线分享链接"`、2865 逐字 `aria-label="导入画线文件"`；本席第一版引的 2858／2866 是这两枚钮自己的 disabled／title 属性行，指的是属性不是名字，四枚不同类，2026-10-14 换掉）——没有建组、没有克隆复制、没有把线移到别处、没有管理布局图元。disabled 态在本仓存在但挂在别的按钮上（如 2836 那枚「清单」在无画线时 disabled），不构成本条的对应物，所以本行也不写「三枚带 disabled」。 |
| TV-DW-04 | 部分 | frontend/src/pages/ProChart.tsx:182 | - | 那一行是 `const SESSION_KEY = "pro-chart.session.v1";` ——「图表状态落 localStorage」这条通道有，「样式／周期／品种三项各成独立键名」的形状没有：品种＋周期＋分时三项合存在这一个键的 JSON 值里（写点＝同文件 792 行 `localStorage.setItem(SESSION_KEY, JSON.stringify({ symbol, interval, timeShare }))`），画线样式另有一键（`frontend/src/lib/chartDrawings.ts` 的 STYLE_KEY），主题走全局键。本行不写「本仓已有同名键」，也不据 tv-a16 那趟外推任何值面：那份记录是键名级、`fingerprints_complete: false`、`values_redacted: true`，「有没有一个装三项合并值的键」这一问在批次 A 两边都没有证据面。 |
| TV-DW-05 | 缺 | 未找到：收藏画线工具栏可见性偏好与「锁定线可否删除」持久开关 —— 复跑命令 `grep -rn --include=*.ts --include=*.tsx -e deleteLocked -e 收藏画线 -e 锁定删除 frontend/src`（本席 2026-10-14 跑＝0 命中，rc=1） | - | 本仓的「收藏」只有标的 watchlist（`frontend/src/components/charts/WatchList.tsx:91` 那句「点图表栏的 ★ 收藏当前标的」），没有收藏画线工具栏；清单面板的可见性是组件内 useState（`frontend/src/pages/ProChart.tsx:561`），刷新即回默认，没有任何会话级存储；锁与删是两个互不干涉的行内动作，且 `frontend/src/lib/chartDrawings.ts` 顶部第 5 条自陈右键删除不读 lock ⇒ 既没有那个开关，也没有治理它的持久级偏好键。两条都不许读成「本仓已有同名键」。 |
| TV-DW-06 | 部分 | frontend/src/pages/ProChart.tsx:3238 | - | 那一行是图表容器 `<div ref={hostRef} …>`，画布由 klinecharts 在同文件 1218 行的 `init(hostRef.current, {` 里于运行时产出——本仓源里没有 canvas 标签字面量，产品页的绘制层因此只有挂载点这一处仓内落点，「按 canvas 这一标签写法命中＋取回 CDP 后端句柄」在仓内没有静态凭据，本席也没跑那一趟（按上面的口径这不算 `缺`，但也不够判 `已有`）。探针页那一枚 canvas（`tools/rea_probe_site/index.html:14`）是 harness 面，不拿来当产品页的实现面。dom 段只给属性名不给值是取证工具的性质，本矩阵不据它发任何「已有」。 |
| TV-DW-07 | 已有 | frontend/src/pages/ProChart.tsx:1398 | - | 那一行是 `const report = restoreDrawings(`（图表 init 里把存过的画线放回画布的调用点；另有 2234 行 `chart.createOverlay({` 是手画路径）——等值判据的前置「画布上已有一条图元的渲染态」在本仓指得出来。自家页的两把锚本席现开过：`frontend/vite.config.ts:43` 逐字 `port: 5899,`、`frontend/src/router.tsx:89` 逐字 `{ path: "/pro-chart", element: wrap(ProChart) },`。两趟 `sha256` 与 `bytes` 逐项等值那一半本席未跑（只读席不起浏览器），故不判 `已有`；按批次 A 的证据面，本行也不写期望常量、不写像素差 x%。（2026-10-14 活体趟追加——上面「故不判 `已有`」的理由已被执行推翻，本行据此升态，原句按纪律原地保留：自家页同命令两趟的 `sha256`／`bytes` 逐字等值跑成了（两趟 stdout 全文 diff 只差 `evidence_id` 与 `captured_at` 那两行），凭据 `docs/forensics/l0/self-dw07-pixel-equality.md`，L1 的 TV-DW-07 那一行已把它写进 `L0 依据` 列。状态列判的仍是「本仓有没有这段实现」，升态凭据是「本仓实现产出的像素在两趟同命令下逐字等值」被自家页实测坐实；前置那一条图元由本仓第一方的 `?d=` 分享链接导入达成，不是鼠标落点（鼠标落点在现行工具词汇表下不可表达，L1 那一格已记）。引用本行必须带上的限制：现场是日线、收盘时段、清单面板关着的静止态，「没有活动元素在抢帧」是顺序推断，本行不对「有实时通道写入时还等不等值」作任何断言。） |
| TV-CI-01 | 缺 | 未找到：两层 treegrid 周期目录与自定义档位入口 —— 复跑命令 `grep -rn --include=*.ts --include=*.tsx -e treegrid -e "Add custom interval" frontend/src`（本席 2026-10-14 跑＝0 命中，rc=1） | - | 本仓的周期与分辨率面是工具条上 8 枚即时按钮（目录数组＝`frontend/src/lib/marketApi.ts:20` 的 INTERVALS，本席现读 8 枚条目行；渲染点＝`frontend/src/pages/ProChart.tsx:2698`）：没有 level=1 与 level=2 两级、没有 Ticks／Seconds／Minutes／Hours／Days／Ranges 六类分组、没有 Add custom interval 那一行；档位集合也不同集（本仓最细到 1分，无 tick 与秒级；前端侧凭据＝`frontend/src/lib/marketApi.ts:18` 那行 `IntervalKey` 的类型联合里没有秒级与 tick 档，本席 2026-10-14 现开）。这是形状与内容两样都不在，不是「跑没跑」的问题。 |
| TV-CI-02 | 部分 | frontend/src/pages/ProChart.tsx:2716 | - | 那一行是 `periodActive(i.key) && "bg-muted font-medium",` ——当前档位有标记，但走的是 CSS 类（谓词在同文件 2492 行 `const periodActive = (key) => !timeShare && interval === key;`），不是无障碍 selected 态：本席在 `frontend/src/pages/ProChart.tsx` 与 `frontend/src/components/charts` 里搜 aria-selected＝0 命中（仓内 aria-selected 只活在聊天／筛选等别的页）。而且本仓没有「目录行」与「主工具栏那枚周期按钮」两个元素——按钮自己就是目录，「两处可达名同名到名字级」这一形状没有对应物。 |
| TV-CI-03 | 缺 | 未找到：周期按钮自陈弹层入口 —— 复跑命令 `grep -rn --include=*.tsx -e aria-haspopup frontend/src/pages/ProChart.tsx frontend/src/components/charts`（本席 2026-10-14 跑＝0 命中，rc=1） | - | 本仓点周期按钮是即时换档，不是弹层入口：`frontend/src/pages/ProChart.tsx:1930` 的 `pickInterval` 直接 setView 并 setPeriod，没有目录浮层、没有 hasPopup／menu 语义。生产标记里唯一一枚 aria-haspopup 在聊天输入区（`frontend/src/components/chat/Composer.tsx:331`），与图表无关，不构成本条对应物。（2026-10-14 评审 M-1 改口：第一版写的是「仓内唯一一枚」，而按属性名扫 `frontend/src` 会得到 **两行**命中——第二行是 `frontend/src/components/layout/__tests__/Layout.test.tsx:151` 的 `.not.toHaveAttribute("aria-haspopup")` 否定断言，它是测试而不是标记。下一席复跑时看到 2 行不代表本行错了。） |
| TV-CI-04 | 部分 | frontend/src/components/charts/IndicatorEditor.tsx:250 | - | 那一行是指标工作台浮层的遮罩 `<div className="fixed inset-0 z-40 bg-black/30" onClick={onClose}>` ——打开的确实是浮层而不是新页面（右侧 34rem 抽屉，点遮罩即关），骨架里也有那一枚关闭按钮（同文件 257 行起），但它没有可达名（无 aria-label，内容只有 X 图标）。骨架没有 role=dialog 也没有 aria-modal（本席 grep 该文件＝0 命中；仓内这种写法只出现在别处，如 `frontend/src/components/chat/PineScriptViewer.tsx:52`），顶层既没有搜索框也没有列表区三级标题——搜索框在「脚本库」那一页里（`frontend/src/components/charts/workbench/LibraryTab.tsx:52`）。三件控件只对上一件半。 |
| TV-CI-05 | 部分 | frontend/src/components/charts/IndicatorEditor.tsx:65 | - | 那一行是 `const TABS: { key: TabKey; label: string }[] = [` ——顶层多页 tab 这一形状有，枚数与默认页不同：本仓 6 页（编辑器／脚本库／导入导出／策略报告／条件筛选／脚本告警），默认落 editor（同文件 91 行 `useState<TabKey>("editor")`，另有 104 行由分享链接 seed 切页），不是 5 页、也没有「selected 态唯一」的暴露——tab 是普通按钮，没有 tablist／tab／aria-selected（本席现跑 `grep -rn --include=*.tsx -e tablist -e 'role="tab"' frontend/src/pages/ProChart.tsx frontend/src/components/charts`＝0 命中、`grep -rn --include=*.tsx -e aria-selected frontend/src/pages/ProChart.tsx frontend/src/components/charts`＝0 命中，两条 rc 均为 1）。其余几页里有什么本批未读取，这一限制不影响本行判定：本行只判顶层形状。 |
| TV-CI-06 | 部分 | frontend/src/pages/ProChart.tsx:527 | - | 那一行是 `const [indPanelOpen, setIndPanelOpen] = useState(false);` ——四个打开面（工作台／副图指标／清单／图例）在本仓都是组件内 useState，没有 navigate 也没有 pushState，所以「打开动作对 URL 净变化为零」这一半在本仓成立。判 `部分` 而不判 `已有` 的**唯一**驱动理由：它是顺带结果而不是被断言的性质——本仓没有任何测试针钉「四个打开动作前后 `window.location` 不变」。另记三件现读，免得下一席把两件事混起来：(a) 本仓确实有写 URL 的动作，但它**不是**本条那四个打开动作：`stripQueryKey`（`frontend/src/pages/ProChart.tsx:415`，写点＝同文件 421 行 `window.history.replaceState(`）的两个调用点在 1598／2466 行，两处都在 mount 态 `useEffect` 里（本席现开：1598 逐字 `stripQueryKey(SHARE_QUERY_KEY);`、2466 逐字 `stripQueryKey(DRAWING_SHARE_QUERY_KEY);`）⇒「本仓 URL 会被写」不构成对本条的降级；(b) 四个打开动作在本仓不写 URL：本席现跑 `grep -n -e useNavigate -e "navigate(" -e pushState frontend/src/pages/ProChart.tsx`＝0 命中、rc=1；(c) 与本条规格句真正不同形的在**反方向**——`?s=` 被消费后 `frontend/src/pages/ProChart.tsx:1608` 的 `setIndPanelOpen(true)` 会由 URL 打开工作台（本仓图表面用的 query 参数名是 `s`／`d`，见 `frontend/src/lib/scriptExchange.ts:218` 与 `frontend/src/lib/drawingExchange.ts:74`），而规格句只管「打开动作对 URL 的净变化」，不管 URL 反过来驱动面板。至于「参数名仍只有 `symbol`」，那是**对方** URL 的 L0 读数（`docs/forensics/l0/tv-a7-indicator-dialog.md:88` 逐字 `query_parameter_names[1]: symbol`），不是本仓的达标线——2026-10-14 评审把这一句从降级理由里摘掉。 |
| TV-CI-07 | 已有 | frontend/src/pages/ProChart.tsx:2830 | - | 那一行是 `aria-pressed={drawPanelOpen}` ——右侧（本仓是下方）面板那枚入口按钮是开关而不是单向打开：pressed 绑的就是面板状态，onClick 走 toggleDrawPanel（同文件 2283 行 `setDrawPanelOpen((open) => !open);`），开与关在同一条翻转里，pressed 跟着翻。同族另两枚：副图指标（2764 行）、图例（2887 行）。差异如实记着：本仓这枚按钮在无画线时 disabled（2836 行）；对方那一侧本席只读到「`docs/forensics/l0/tv-a8-legend.md:108` 那一行自陈 `[pressed]`、没带 disabled 标记」，而该记录的 disabled 计数只圈工具条那四枚（108 行逐字 `- button "Object tree and data window" [pressed]`）⇒ 这里不写「对方那枚常开」这种断言，只写读数。「连续两趟读到相反面板态」那一半本席未跑（只读席不起浏览器，控制席 2026-10-14 追加第(2)条裁定这不算缺），执行归门禁趟。**另记两件**（2026-10-14 评审 I-3）：其一，L1 本条判据列**原先**写着「这枚入口按钮属 L3 要建的东西，本批自家页上还没有」（那半句已由控制席 2026-10-14 就地更正，L1 现文本以「原句……为假」的形式留着）（`docs/forensics/spec/chart-interaction.md` 的 TV-CI-07 那一行——按条目号指，别按行号指，那张表还会被改），这与本行读数**不相合**——本仓这枚开关已经在：`frontend/src/pages/ProChart.tsx` 2824 行起那枚 button，2829 逐字 `aria-label="画线清单"`、2830 逐字 `aria-pressed={drawPanelOpen}`、2837 逐字 `onClick={toggleDrawPanel}`，P3 别按「要新建它」排期。其二，执行后果：这枚开关在无画线时 disabled（2836），门禁趟要读到 pressed 翻转，**必须先在画布上落一条画线**，否则那一次 click 打不动。（2026-10-14 活体趟追加两件，读数都在 `docs/forensics/l0/self-ci07-panel-toggle.md`，L1 的 TV-CI-07 那一行已把它写进 `L0 依据` 列。其一，那一次画线的前置实测为真：零画线时这枚按钮 `states` 里逐字带 `disabled,true`，导入一条图元后 `disabled` 消失、可达名变成 `button "画线清单": 清单 · 1`。其二，「连续两趟读到相反面板态」那一半在自家页**不成立**——两趟那枚按钮都带 `[pressed]`（各趟带 1、不带 0），判因是这条命令每趟开头强制一次 `goto_start` 导航、而面板初值不持久（同文件 561 行逐字 `const [drawPanelOpen, setDrawPanelOpen] = useState(false);`），于是两趟必然同相；这是**形状**问题不是**实现**问题，本行的 `已有` 不因此降态，也不因此升格成「实现有缺陷」。开关本身有同趟执行读数：在同一条场景命令里连点两次、把可达树收到 `after_each_step`，第一步那棵带 `[pressed]`、第二步那棵不带 ⇒ 本仓这枚按钮确实在打开／关闭之间翻转并自陈 pressed。验收形状已由控制席按此裁定改掉，见 L1 那一格的第(3)件。） |
| TV-CI-08 | 部分 | tools/rea_probe_site/app.js:5 | - | 那一行是 `canvas.addEventListener("pointerdown", (event) => this.pick(event));` ——本仓为枚举面备的可指认目标在这行：探针页画布上有一个真监听器，A4 那一族的 harness 趟用它读到过 `selected_node.match=found` 与非空 listeners（那份留档写的是 `docs/forensics/l0/probe-events.md`，用途＝harness；本行的坐标只指仓内实现，不拿漏斗文档自证）。判 `部分` 的两条理由：其一，枚举工具本身（inspect-web-event-listeners 与 CDP 现场）不在本仓，仓内没有这段实现可指；其二，产品页 /pro-chart 的画布由 klinecharts 运行时生成，本批没有对它命中的读数。红线照批次 A 走：八枚 `listeners` 全空（含 body 对照组）只证枚举面可用，任何一行都不许推成「TV 那处没有事件绑定」，也不许用 `[role="menu"]` 的 not_found 推「对方没有菜单」。 |

## 这一层没有回答的问题（交给 P3 排期时别当成已答）

- 说明列里的行号是本席 2026-10-14 现读的，`frontend/src` 的三条 ` M`（`frontend/public/usage-guide.md`、
  `frontend/src/lib/chartDrawings.ts`、`frontend/src/lib/__tests__/chartDrawings.test.ts`）是别席未提交的活，
  它们一旦被提交就会让引用到该文件的读数搬家——本矩阵**坐标列**（第三列）因此只落在 ProChart.tsx、
  IndicatorEditor.tsx 与 `tools/rea_probe_site/app.js` 这三枚本席可见的干净文件上（现读
  `git status --porcelain -- frontend/src/pages/ProChart.tsx frontend/src/components/charts/IndicatorEditor.tsx tools/rea_probe_site/app.js`
  无输出）；`marketApi.ts:20`、画线目录的条数与 `chartDrawings.ts:131` 的行号只写在**说明列**里，并带「本席现读」四个字
  （2026-10-14 评审 M-5：第一版把 marketApi.ts 也写进了「坐标列」那一句，而它一次都没出现在第三列——
  判据现读 `awk -F"|" '/^\| TV-/{print $4}' docs/forensics/gap-matrix.md | grep -c marketApi`＝0。
  这条命令**只数以 `| TV-` 开头的行的第三列**，所以它数不到写下它自己的这一行；
  第一版那条（拿竖线包坐标去全文件数）已被摘掉——它会把打印它自己的那一行算进去，现复读＝1，
  形状上叫「锚自指」：判据的输入里含着写下这条判据的那一行）。
- 「部分」不等于「不用做」，「已有」也不等于「不用测」：TV-CI-07 那行的等值／互补两趟、TV-DW-07 那行的两趟
  像素等值，仍然要由带浏览器的门禁趟跑一次才算验收。
  （2026-10-14 更正：这一句在本日已经被执行追上了——DW-07 的两趟等值成立，CI-07 的「跨两趟互补」不成立且形状
  已按裁定换成「同一趟内连点两次＋`after_each_step`」。所以「才算验收」的对象不再是本批的一个缺口，而是 L4
  门禁趟要跑的那条命令形状；本行留着原文是因为它还管着下一片：**没跑过的判据不许当成跑过的**。）
- A12／A13 两面在本矩阵里没有行（见开头那条），P3 若要排它们，得先重开一个能落 `evidence_id` 的取证面。
