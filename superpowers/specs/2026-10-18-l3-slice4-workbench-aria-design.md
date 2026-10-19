# L3 第④片：脚本工作台的页签与浮层自陈无障碍角色（TV-CI-05 主 ＋ TV-CI-04 附）设计

**日期**：2026-10-18　**分支**：`feat/l3-slice4-workbench-aria`　**基座**：`main` 末端（号一律现读 `git log --oneline -1`，本片从第③片合入推送后的那笔开）

**一句话**：让「ƒ 脚本工作台」这层抽屉在无障碍树里**自陈**它本来就在做的事——它是一个 dialog、它顶层是一族 tab、当前那页是 selected 的唯一一枚、右上角那枚 X 有关闭它的可达名。

---

## 0. 这一片在漏斗里的位置

三层各有一句现读的话要说，全部由本席 2026-10-18 当场打开文件核对，不是转述：

- **L2 判态**：`forensics/gap-matrix.md:92` 的 **TV-CI-04** 判 `部分`，第三列 `frontend/src/components/charts/IndicatorEditor.tsx:250`；`:93` 的 **TV-CI-05** 判 `部分`，第三列同一文件 `:65`。两行的说明列都写到了名字级的缺项：CI-04 那行「骨架里也有那一枚关闭按钮（同文件 257 行起），但它没有可达名（无 aria-label，内容只有 X 图标）」「骨架没有 role=dialog 也没有 aria-modal」；CI-05 那行「tab 是普通按钮，没有 tablist／tab／aria-selected」「没有『selected 态唯一』的暴露」。（**2026-10-19 控制席追加，原文不删**——本行通篇是**入片前**的 L2 判态，而矩阵在本片落地后被 `0353065f` 回灌过，故本行与现版矩阵同树并存时可当场判假。本席 2026-10-19 现读 `forensics/gap-matrix.md`（按 `awk -F'|'` 切列，状态列＝第 2 格、实现坐标＝第 3 格；**2026-10-19 最终评审 M-3 把编号口径写死**——行首那枚竖线使 `awk` 的 `$1` 成为空场，按它的编号状态＝`$3`、实现坐标＝`$4`；本行下面那两枚「第 3 列」与「状态列＝第 2 格」都按**不计行首空场的逻辑列号**说，两套编号对同一格的读数不差，缺的是交代。坐标现读：`awk -F'|' 'NR==92{print $3, $4}' forensics/gap-matrix.md`（同一把尺换 `NR==93` 取第二行））：第 92 行 TV-CI-04 状态列 `部分`、第 3 列 `frontend/src/components/charts/IndicatorEditor.tsx:253`；第 93 行 TV-CI-05 状态列 `已有`、第 3 列 `:271`。⇒ 本行那句「`:93` 判 `部分`、第三列 `:65`」与「`:92` 第三列 `:250`」四枚读数一律读作**前态**：`:65` 是 `const TABS` 声明行（形状证据，不是无障碍证据），`:250` 是遮罩行，本片落地后 dialog 挂在抽屉 `:253`、tablist 挂在 `:271`。CI-04 仍 `部分` 的残留面只剩顶层搜索框那一件（三级标题那件在修复轮里被活体读数推翻，见矩阵第 92 行说明列与档案 §7.28）。）
- **L1 规格句**：`forensics/spec/chart-interaction.md:21`（CI-04）＝「指标入口按钮打开的是一个 role: dialog 的浮层（不是新页面），骨架含一枚关闭按钮、一个搜索框与列表区标题三件控件」；`:22`（CI-05）＝「指标对话框顶层是五个 tab，默认落在 `Indicators` 页（selected 态唯一），其余四页各自的内容本批未读取」。
- **L0 证据面**：`forensics/l0/tv-a7-indicator-dialog.md:108-117` 那十行是这一片的全部依据，逐字形状＝`- dialog "…":` → `- button "Close menu"` → `- searchbox "Search"` → `- tablist:` → 五枚 `tab "…"`（第一枚带 `[selected]`）→ `- heading "…" [level=3]`。同一份记录的 `:139` 那行把可结论范围写死了：**只打开，未往搜索框填任何东西、未切换 tab、未提交、未登录、未添加任何指标、未派发 Escape**。（**2026-10-18 执行期更正，原文不删**——这四字护的是本括注之前那句 `:139` 原句，它逐字仍在原位；不护括注自身历轮的措辞，那部分历轮改写过，取回坐标是紧邻前版 `git show 8cba0f78:superpowers/specs/2026-10-18-l3-slice4-workbench-aria-design.md` 第 15 行（本文件的 `git show` **按行**只在第 15 行命中一枚；**按枚**当场 `grep -o -F` 现读 3 枚，其中一枚就是本括注这处自指；`:100` 以后 0 枚，故别往文件末尾找）。这一句的坐标应为 `:8`，不是 `:139`——`:139` 现读讲的是「本面撑得住的结论（对话框有哪几页、每页有哪些控件名）」，不含那句动作纪律。同形错指在本文件有**两处**（`:15` 与 `:47`），`:47` 已由计划 `追加更正（二）` 平账，`:15` 由本括注平账；`df22faa7` 那一版只钉 `:47` 并写下「四处里只有 spec 这一处是坐标错指」，那枚枚举漏了本行，完备性断言因此过窄为假，见计划 `追加更正（四）`。本行既有的「逐字形状」四字指的是 `:108-117` 那十行的形状，**不指**下面这串动作纪律——故上一句「本行不自称逐字」按整行读为过实（本行确实带「逐字形状」四字），归属＝控制席本轮措辞过实，由本句改正——头半「本行不自称逐字」以「」逐字引回（口径按**行**记：`grep -c -F` 现读 1 行；本行把这串引回两趟，故按枚＝2，别拿本行的字面当尺去数枚），尾半随本句改写、不在跟踪面（旧文取 `git show 90d5c3a1:superpowers/specs/2026-10-18-l3-slice4-workbench-aria-design.md` 第 15 行，本句不复抄那半串——复抄会亲手把「跟踪面 0 命中」这枚读数染成非 0，这一味已由计划 `追加更正（四）` 的 `searchbox` 条目（那条在 `:611`，它给这味的字面名作「自己喂自己那把尺」）命名过）；顺带补一枚口径限定：那串「逐字形状＝…」里的长名字是 `…` 略写形，整串不可 `grep -F`，逐枚复算请开 L0 `:108-117` 当场取。）（**2026-10-19 R=5 收窄复评后控制席追加，原文不删**——上面那句把取回坐标称作「紧邻前版」并点名 `8cba0f78`，这枚限定词在落笔当时就是假的，不是后来漂的：该句由 `6f3ff582` 写进本行，而它落笔时本行真正的紧邻前版是 `52b3983f`，`8cba0f78` 是隔一版。两版第 15 行是不同字面（本席 2026-10-19 现跑同一行 `wc -c`＝`8cba0f78` 1540／`52b3983f` 2188 字节），且本窗吃掉的那半（上一版那句指向不存在节号的旧文指针）只存在于 `52b3983f` ⇒ 照 `8cba0f78` 那枚坐标取回的是隔一版的措辞，不是被吃掉的这半。真正紧邻前版的可复制坐标＝`git show 52b3983f:superpowers/specs/2026-10-18-l3-slice4-workbench-aria-design.md` 第 15 行，本句不复抄取回的字面。本句把自己的账一并算进去：加上本句这枚坐标后，那条命令名在本文件**按行**＝1（仍全在第 15 行内）、**按枚**＝4（上面那句报的「3 枚」是本次追加之前的读数，与计划 `追加更正（六）` 病灶甲同型，原文留在原处由本句改正，别拿它当现读）、`:100` 以后＝0。⇒ 新口令：**「上一版／紧邻前版」这类相对版本词每改一版就过期一次，要么写成绝对坐标，要么把相隔几版一起标出来**。）
- **本仓现状**（逐字开过，全部现读）：`IndicatorEditor.tsx:65-72` 是 `const TABS: { key: TabKey; label: string }[] = [` 加六枚条目（编辑器／脚本库／导入导出／策略报告／条件筛选／脚本告警）；`:91` 逐字 `  const [tab, setTab] = useState<TabKey>("editor");`；`:108` 逐字 `  if (!open) return null;`（关态整棵树不存在）；`:250` 遮罩 `<div className="fixed inset-0 z-40 bg-black/30" onClick={onClose}>`；`:251-254` 抽屉（`absolute right-0 top-0 ... w-[34rem]`，`onClick={(e) => e.stopPropagation()}`）；`:256` 标题 `<span className="text-sm font-semibold">ƒ 脚本工作台</span>`；`:257-263` 关闭按钮（体内只有 `<X size={14} />`）；`:266-283` 页签条（六枚普通 `<button>` ＋ 尾部一枚「N/M 已挂载」`<span>`）；`:285` 起是页身容器，`:301` 起六段 `{tab === "…" && (<XTab … />})`——**页身按选中枚挂载**，不是全量常驻。

⇒ 两格判态都是真的：本仓这层抽屉在无障碍树里目前只表现为「一堆按钮」，它是不是浮层、哪一页是当前页、右上角那枚钮关的是什么，全都靠视觉，机器读不出来。

---

## 1. 判态：本片只买两格，且只有一格升

**TV-CI-05 升 `已有`**：`role="tablist"` 一枚、`role="tab"` 六枚、`aria-selected` 恰一枚为 `true`。规格句那三条计数（`tablist:`＝1／`tab "`＝5／`[selected]`＝1）里，本仓对上的形状是 1／6／1——**枚数 6≠5 不是缺失**：本仓六页是自研脚本工作台页集合（含 Pine 告警桥与条件筛选两页对方没有的），对应方的 `Strategies`／`Profiles`／`Patterns`／`Options` 四页在 L0 里连内容都没读。本行判的是「顶层多页 tab ＋ selected 唯一暴露」这一形状，形状落满。

**TV-CI-04 仍 `部分`，理由要改写**：本片落下 `role="dialog"` ＋ `aria-modal="true"` ＋ 关闭按钮可达名，把矩阵现文那句「没有 role=dialog 也没有 aria-modal」「它没有可达名」两条销掉；剩下的半是**顶层搜索框**与**列表区三级标题**。本席 2026-10-18 现读这两半的本仓形状：搜索面确实有，但既不在顶层、也不是 `searchbox` 角色——`frontend/src/components/charts/workbench/LibraryTab.tsx:49` 起那枚 `<input>`（`:52` 是它的 `placeholder` 行）**没有 `type` 属性**（默认 `type="text"` ⇒ a11y 角色是 `textbox`），且它在「脚本库」这一页里面，不在对话框顶层；列表区那枚 level-3 标题本仓没有对应物。（**2026-10-18 执行期更正，原文不删**：「列表区那枚 level-3 标题本仓没有对应物」**写下时即为假**。本席现读 `frontend/src/components/charts/workbench/EditorTab.tsx:286`「我的指标（勾选 = 显示在图上）」与 `:332`「内置公式（本地语言，一行 return 即可）」两枚无条件 `<h3>`，正是列表区标题；活体复跑同一把尺 `[role="dialog"] h2, [role="dialog"] h3` 在「编辑器」页读到 3 枚、「导入导出」页 2 枚、其余四页各 0 枚。原句之所以读成「没有对应物」，是把「停在脚本库页那一瞬的零枚」当成了整个浮层的形状——页身按选中挂载，一把尺扫不出分布）。真缺的只剩**顶层搜索框**一件，判态 `部分` 不动。这两半本片**不做**，因为做不出证据（见裁定四）也不属于本片的规格句范围。（顺手把 `type` 改 `"search"` 只能对上半的一半——角色变对、位置照旧，且会带进浏览器原生的清除按钮行为，属另一件事。）

**相邻的 TV-CI-01 不动、不顺手升。** 那一格要的是两层 treegrid（7 个 level=1 行＋32 个 level-2 行＋六类分组），与本片毫无交集。**TV-CI-06／07** 也不动。

判据到哪儿就写到哪儿：本片买 CI-05 的形状升格、买 CI-04 的理由改写，不多承诺任何一条。

---

## 2. 四条裁定（没有现成答案，由本席定，写在这里当约束）

**裁定一：`role="dialog"` 落在抽屉（`:251`）而不是遮罩（`:250`），遮罩补 `role="presentation"`。**
遮罩是一整屏 `fixed inset-0` 的点击捕手，把 dialog 挂它身上等于宣称「半透明黑幕是对话框的内容区」；抽屉才是那个 34rem 的面板。本仓已经有现成形状可抄——`frontend/src/components/portfolio/ConnectionCenter.tsx:132` 遮罩带 `role="presentation"`、`:133` 抽屉带 `role="dialog" aria-modal="true" aria-labelledby="connection-center-title"`，且它同样是右侧抽屉＋`border-l`＋`shadow`＋体内 `:136` 那枚 `<button … aria-label={t("portfolio.connections.close")}>` 包 `<X />`。本片照这个形状做，不新造第三种。

**裁定二：不发 `aria-controls`、不加 `role="tabpanel"`。**
`aria-controls` 必须指向**当时存在**的 id。本仓页身是「选中才挂载」（`:301` 起六段条件渲染），于是只有两种写法：① 逐 tab 各发一枚 id ⇒ 五枚永远悬空（当前只有一枚对应的元素在树里）；② 六页全挂载、非选中页隐藏 ⇒ 现有测试立刻塌（同一页内同名控件会在树里出现两份，`getByRole` 多命中即报），而且各 tab 组件的挂载副作用（读图、编译脚本）会从「进页才做」变成「开台全做」，这是行为改动不是无障碍改动。而 L0 `:111-117` 里 `tablist:` 之外根本没有 tabpanel 的证据——对方的列表区标题是 tablist 的**兄弟**，不是被 tab 控制的 panel。仓内两枚现成 tablist（`frontend/src/pages/RunDetail.tsx:391`、`frontend/src/components/chat/WelcomeScreen.tsx:324-332`）也一律不发 `aria-controls`。CI-05 的三条判据数的是 `tablist`／`tab`／`selected`，panel 不在判据里。（**2026-10-19 最终评审 I-2 追加，原句不删**——上面「于是只有两种写法」是**假二分**，漏掉的第三种＝**条件发**：只在选中那枚 tab 上发 `aria-controls`、指向当时存在的那一枚面板 id，悬空问题根本不出现。本仓两枚现成形状都在跟踪面、且各有自己的针：`frontend/src/components/charts/PeriodPicker.tsx:65` 是条件式（open 为真才发那枚 id，否则交 undefined），配套 `frontend/src/components/charts/__tests__/PeriodPicker.test.tsx:77` 那条 it 与 `:83` 那句 `getAttribute` 为 null 的断言钉住「不留悬空 IDREF」；`frontend/src/components/chat/WelcomeScreen.tsx:346` 是页身只挂一枚 tabpanel（内容由 `:328-344` 那六枚 tab 的 activeCategory 决定，只渲染选中那一页），它直接否证原句那条「必须六页全挂载」的隐含前提。所以本条判为**论证缺陷、不是实现缺陷**：代码忠实执行了裁定，裁定把可达形状说成了不存在。公平起见记下原句里成立的那半——「也一律不发 `aria-controls`」本席 2026-10-19 复跑为真（`grep -rn "aria-controls" frontend/src`：`RunDetail.tsx` 零枚，`WelcomeScreen.tsx` 只有 `:290` 那枚目录开关、不在 tab 上）。本片仍不发，但理由从「不可达」换成**范围**：条件发要同时给六段页身补 id 与 `aria-labelledby`，属另一片。回归钉那半由修复轮收窄辖域——原针数的是整棵抽屉里 `aria-controls` 的枚数，比本裁定所要钉的 tab→panel 关联宽（抽屉里任何一页将来正当加一枚可折叠区都会误红它），现改成逐枚 tab 断言不带该属性。详计划 `追加更正（八）`。）
**代价写明**：读屏用户切页时不会自动把焦点送进内容区。这一条本片不解决，留作后续片（那需要页身常驻＋隐藏的新结构，属另一片范围）。

**裁定三：可达名一律用本仓自己的中文，逐字「关闭脚本工作台」；不新建 i18n 键。**
对应方那枚叫 `Close menu`（L0 `:109`）、对话框名与五个 tab 名全是英文——**一个字都不进 `frontend/src/**`**（禁抄对方档位名／键值的红线同样适用于控件名）。对话框的可达名走 `aria-labelledby` 指向 `:256` 那枚标题（正文逐字 `ƒ 脚本工作台`），不另造 `aria-label`，免得两份名字打架。为什么不用 `t()`：本文件全篇硬编中文（`:66-71` 的 TABS label、`:256` 的标题、`:281` 的「已挂载」），加一枚 locale 键等于在同一层里开第二套文案口径；九语言补齐属另一件事，不在本片范围。

**裁定四：键盘 roving tabindex、Escape 关闭、焦点陷阱与焦点归还，本片全不做。**
L0 那份记录 `:139` 明写**未派发 Escape、未切换 tab**，`completeness.status=incomplete`、`missing_sections` 含 `events` ⇒ 「按 Escape 会关」「左右键在 tab 间移动」这两件事在证据面上一片空白。（**2026-10-18 执行期更正，原文不删**：引用的两件事逐字确在 L0，但**行号指错**——`:139` 讲的是对话框里有哪几页、哪些控件名，不含这句动作纪律；逐字在 `:8`，可 `grep -c -F` 的形是 `只打开，未往搜索框填任何东西、未切换 tab、未提交、未登录、未添加任何指标**、未派发 Escape`（L0 原句那串前后各带一枚 markdown 强调符，本行引号从「只打开」起、只带得住尾部那一枚，照抄才还得起这笔账；复评 N-2：上一版抹平强调符却自称逐字，与矩阵两行同味），另有 `:30`／`:38`／`:56`／`:63`／`:70` 五枚 `action:` 全是 `goto_start`／`click`／`wait_for_timeout`、零枚 `press_key`。内容不动，只把坐标改对。本条裁定照旧成立。）给一片没有读数的行为写实现，等于替对方页面编造规格；且 CI-04／05 两条规格句里没有任何一条提到键鼠行为。（仓内确有现成对照：`frontend/src/components/chat/__tests__/PineScriptViewer.test.tsx:21` 那一族针钉的是 Escape 与焦点，那是**本仓自研对话框**的既有主张，不是从对方页取证来的，两者不要混谈。）

**裁定四追加（2026-10-19，最终整支评审 I-1；原句一字不动，改的是它的范围）**：原句把四件事打包成「全不做」，其中焦点那两件与本片自己落下的东西不自洽——`aria-modal="true"` 是写给读屏软件的一句承诺，声明了却不搬焦点、不设陷阱、不归还，比不声明更难自处。先把面数清（本席 2026-10-19 现读 `grep -rn 'aria-modal' frontend/src --include=*.tsx`，源码面共**五枚**声明，评审席那句「同仓另两枚都做了全套」数少了两枚）：除本片这枚之外是 `chat/PineScriptViewer.tsx:53`、`common/ConfirmDialog.tsx:94`、`portfolio/PortfolioSourceEditor.tsx:94`、`portfolio/ConnectionCenter.tsx:133`；前两枚做了「记 focus＋搬焦点＋归还」全套（`PineScriptViewer.tsx:17-18`／`:27`，`ConfirmDialog.tsx:47`／`:66-75`／`:80`，且两枚都接 Escape），`PortfolioSourceEditor.tsx:42-44` 只在 `window` 上接 Escape、不搬不还，`ConnectionCenter.tsx` 一件没做（尺＝`grep -c -e activeElement -e previouslyFocused -e '\.focus()'`，本席现读＝**0**，它唯一的 `focus` 字形住在 CSS 类名里）。⇒ 焦点三件（进抽屉聚焦关闭钮、Tab／Shift+Tab 在 dialog 内首尾环回、关闭或卸载时归还）转入本片并已落地（`4063dbe0`）；**Escape 与键盘 roving tabindex 仍不做**，理由与原句同一条：L0 对 Escape 零读数，而这棵抽屉里装着 Pine 公式草稿，全局 Escape→close 会让正在写公式的人在不自知的情况下丢草稿——「不替对方编造规格」这半句在 Escape 这一件上照旧成立。环回处理器刻意挂在 `role="dialog"` 那枚 div 的 `onKeyDown` 上，不挂 `document`／`window`：抽屉不在树上的时候，别人家的按键不该由这里接管。**本片新增的书面承诺因此＝「焦点进得来、出不去、关得掉、关完回到原处」，不含 Escape。** 焦点效果依赖数组只放 `open`：宿主 `pages/ProChart.tsx` 传下来的 `onClose={() => setIndPanelOpen(false)}` 每轮渲染换新函数身份，写进依赖就等于每轮重渲染重放一遍「记 focus → 抢焦点」，正在抽屉里打字会被偷走；这一半边由本片新增的第四枚焦点针钉住（`ScriptWorkbench.test.tsx` 里那条 it，名含「记 focus 只跟 open 走，不跟 onClose 走」——行号本席不钉，那枚文件这一片动了两轮）。EOL 不变量续读：2026-10-19 现读 `tr -cd '\r' < frontend/src/components/charts/IndicatorEditor.tsx | wc -c`＝**416**、`wc -l` 同值 ⇒ 上面那条「CR＝行数」仍成立（原句那枚 349 是 2026-10-18 的前态，按只追加纪律不动）。

---

## 3. 改动面（五处，全在 `frontend/src/components/charts/IndicatorEditor.tsx`）

该文件工作树是 **CRLF**（2026-10-18 现读 `tr -cd '\r' < frontend/src/components/charts/IndicatorEditor.tsx | wc -c` ＝ 349，与行数相等）。改动必须是**行内加属性**，不得把任何一行换成 LF-only，改完复跑同一把尺仍应为 CR＝行数。

1. **`:250` 遮罩**：加 `role="presentation"`。
2. **`:251-254` 抽屉**：加 `role="dialog"`、`aria-modal="true"`、`aria-labelledby="swb-title"`。
3. **`:256` 标题**：加 `id="swb-title"`。
4. **`:257-263` 关闭按钮**：加 `aria-label="关闭脚本工作台"`。
5. **`:266-283` 页签条**：六枚 `<button>` 各加 `role="tab"` 与 `aria-selected={tab === t.key}`；页签条本体由「一枚 div 里同时装 6 枚 tab 与 1 枚 `已挂载` span」**改为** `role="tablist"` 的 div 只装六枚 tab、span 作它的兄弟（照 `RunDetail.tsx:391` 与 `:408` 的现成分居形状）。
   **为什么必须分居**：`tablist` 的 required owned elements 是 `tab`；把「N/M 已挂载」那枚计数 span 留在 tablist 里，等于让无障碍树宣称多一个不是 tab 的孩子——`aria-selected` 数得对，但结构是脏的。span 移出去后视觉不变（同一 flex 容器、`ml-auto self-center` 照旧）。

本片**不碰**：`:91` 的默认页、`:104` 的分享链接切页、`:301+` 六段条件渲染、六个 `workbench/*Tab.tsx`、以及任何取数／挂载／编译逻辑。纯显示层属性面。

---

## 4. 测试面

### 4.1 连带改口（role 变更的必然结果，不是顺手清理）

`role="tab"` 一旦落地，那六枚元素就不再是 `button` 角色，既有以 button 身份按页签名查的针**必红**。本席 2026-10-18 现读：全仓 `getByRole("button", { name: "<六个页签名之一>" })` 共 **10 处**，全部在 `frontend/src/components/charts/__tests__/ScriptWorkbench.test.tsx`，行号 `154／177／200／209／218／241／248／253／266／272`。逐处把 `"button"` 改 `"tab"`，name 与其余断言一字不动。
`src/pages/__tests__/` 与其余 charts 测试对该文件零命中（同一把尺现读），故页面级测试不动。

改口后必须**先复跑该套件确认仍绿**再进 4.2——这十处是「角色迁走」的证据，不是「行为改坏」的证据，两者要分得开。

### 4.2 新针（`ScriptWorkbench.test.tsx` 新增一个 describe「脚本工作台无障碍角色」）

- **P1 页签条结构**：`container.querySelectorAll('[role="tablist"]')` 长度 1；`getAllByRole("tab")` 长度 6；`aria-selected="true"` 的行**恰一枚**且可达名为 `编辑器`，其余五枚逐枚 `aria-selected="false"`；**再加一条结构针**：`document.querySelector('[role="tablist"]')!.children` 逐枚带 `role="tab"`（钉住「`已挂载` 那枚 span 已在 tablist 之外」）。
- **P2 selected 会跟着走且仍然唯一**：`fireEvent.click(getByRole("tab", { name: "脚本库" }))` 后 selected 唯一一枚且名字是 `脚本库`。这条同时钉住「tablist 内没有第二枚被误标 selected」。
- **P3 dialog 三件套**：`getByRole("dialog", { name: /脚本工作台/ })` 存在（可达名由 `aria-labelledby` 解析而来，不是 `aria-label` 直填）；`toHaveAttribute("aria-modal", "true")`；`getAttribute("aria-labelledby")` 取到的 id 在文档里 `getElementById` 非空、其 `textContent` 逐字 `ƒ 脚本工作台`。
- **P4 dialog 落在抽屉不在遮罩**：遮罩（`fixed inset-0` 那层）读得 `role="presentation"`，且**全树 `[role="dialog"]` 计数 1**、`container` 不含 dialog 之外的第二个 dialog。这条是裁定一的回归钉：摘掉 `role="presentation"`／把 dialog 挂回遮罩，必红。
- **P5 关闭按钮有可达名且真的关**：`getByRole("button", { name: "关闭脚本工作台" })` 恰一枚（`getAllByRole("button", { name: "关闭脚本工作台" })` 长度 1），点击后 `onClose` 被调用一次。测试需把 `open()` 的默认 `onClose={vi.fn()}` 换成可断言的 spy（`open({ onClose })` 已支持）。
- **P6 可达名走本仓中文口径**（禁抄红线的自动化，但**不写对方的字串**）：关闭按钮的 name 逐字 `toBe("关闭脚本工作台")`，并再加一条形状尺 `expect(name).toMatch(/^[\u4e00-\u9fff]+$/)`——纯 CJK 才过。这条钉的是「以后有人拿对方页面的英文控件名当 aria-label 抄进来」：抄进来必含拉丁字母，这把尺直接判红，而本仓既有的英文文案（如脚本库那页的说明文字）不落在按钮可达名上，不会被误伤。**为什么不在测试里写 `Close menu` 这类字串做反向断言**：那是把禁抄清单里的东西复制进被跟踪的源文件，用违反禁令的方式去执行禁令。

**不做**的承诺也要有针：P2 之后断言 `container.querySelectorAll('[aria-controls]').length === 0`（裁定二的形状是「不发 aria-controls」，将来若有人补发悬空引用，这条先报警）。

### 4.3 变异自证（每枚针各配一把「摘掉哪一行必红」）

| 注入 | 必红的针 |
|---|---|
| 摘 `role="tablist"` | P1 |
| 把 `aria-selected` 整式写死 `false`（六枚全 false）（**2026-10-19 最终评审 M-5 改口，原句不删**：本行原稿写的是「摘单枚 tab 的 `aria-selected`」，而那枚注入在变异脚本 `count == 1` 自护下做不出来——`aria-selected` 全仓只有一枚源表达式（在 `IndicatorEditor.tsx` 里，行号请当场 `grep -n` 现读，本行不钉号，免得被后续修复轮挪动），摘它等于六枚一起摘；实际跑的是 m3 写死 `false`、m4 写死 `true`，覆盖等价，字面承诺表达不出来。详计划 `追加更正（八）`） | P1（唯一性读不到 true）＋P2 |
| `aria-selected` 写死 `true`（六枚全 true） | P1 或 P2 的「恰一枚」 |
| 摘 `role="dialog"`／`aria-modal` | P3＋P4 |
| 把 `role="dialog"` 从抽屉挪到遮罩 | P4 |
| 摘 `aria-label="关闭脚本工作台"` | P5＋P6 |
| 把 span 移回 tablist 内 | P1 的「children 逐枚带 `role="tab"`」那一半 |
| 补发逐 tab 的悬空 `aria-controls` | 4.2 末那条零计数断言 |

按既有纪律：每枚新针都要亲眼看它红过一次（先注入再实现或反之，二选一但都要留 stdout），HARNESS-BLIND 的注入按旧法在报告里逐条记因。

---

## 5. 门禁与验收

六道门照旧全跑：`tsc -b`／`npx vitest run`（全量）／`vite build`／wiki 双套件 `pytest tools/test_wiki_drift.py tools/test_wiki_qmind.py`（**双文件一起跑**，单跑一枚读数不同）／`python -X utf8 tools/forensics_audit.py`／`pytest tools/test_forensics_spec.py`。两枚本机恒红门不调阈值不改门：`tools/wiki_freshness_gate.sh`（页数超阈值）与 `tools/ci_grep_gates.sh` 的 `[gate b]`，只出「本片 0 贡献」的交集归属证据。

活体验收（自家 `/pro-chart` 页面，浏览器实读，不许只看类型与单测）：打开脚本工作台后逐项读数——① `[role=tablist]` 计数 1；② `role=tab` 计数 6；③ `aria-selected=true` 计数 1 且名字与默认页一致；④ 点「脚本库」后 ③ 的名字换页、计数仍 1；⑤ `role=dialog` 计数 1、`aria-modal` 为 `true`、可达名含「脚本工作台」；⑥ 关闭按钮在 a11y 树里有名字；⑦ 关闭按钮点得到且真关；⑧ tablist 的 children 全带 `role=tab`（span 已在外）。

**未来函数豁免声明**：本片改动全是无障碍属性，不碰任何取数、序列计算与信号生成（§3 的「不碰」清单为凭），故不附 Bar Replay 五步自查——纪律那句「交付必附」挂的是会重绘的指标面，本片没有那样的面。这句话本身就是可核对的断言：`git diff --stat` 应只含 `IndicatorEditor.tsx` 与 `ScriptWorkbench.test.tsx` 两枚代码文件。

---

## 6. 归档与记忆

- `项目档案.md` **§7.28** 一节，bytes 层追加（该文件工作树整篇 CRLF，只能在字节层改；追加后复跑 CR＝LF 与读档门）。写：判态两格的现读前后、裁定二与裁定四的证据边界理由、连带十处改口的成因、活体八步读数、变异表逐条结果。
- 记忆条目：`chart-overlay-flags-lock-visible.md` 的「文案面同样要先问归属」这一族，本片新增一条**反向经验**——`role` 变更会把既有按名查 button 的针整批改掉，改口前先 `grep` 数出受影响处数并**先复跑确认绿**，把「角色迁走」与「行为改坏」分开。
- 若 §4.1 的十处读数与本片执行时不一致（有人并行动过该测试文件），以执行时现读为准并在档案里带日期登记差异，不引用本文档的数字。
