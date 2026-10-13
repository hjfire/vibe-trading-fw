# 规格：画线与图元（批次 A 的 L0 → L1）

面归属：这一份收「画线与图元」相关的条目——画线工具目录、图元管理面板（对象树）、图元偏好的存储键形状、
画布层的可指认性、图元渲染的像素验收形状。周期切换／指标对话框／面板开关交互在
[`chart-interaction.md`](chart-interaction.md)，同一条目号不在两份表里重复。

判据列只有两种形状（是本批证据面逼出来的，理由记在 `docs/forensics/batch-A-playbook.md` §8）：

- **仓内复算型**：一条不带管道的 `grep -c` 打在 `docs/forensics/l0/tv-*.md` 的逐字转录上，数出记录里已写明
  的那个数。三个月后另一个人不需要网络、不需要 `%TEMP%` 留档（那些是仓外临时件，按记录自己写的会随清理消失），
  只靠仓内文件就能跑出同一个数。
- **本机重跑型**：同一条命令在**自家页面**（本机 dev server／探针页）连跑两趟，断言的是两趟读数之间的
  **等值关系**，不是某个跨现场可复现的常量。像素面条目只能用这一型（§8（b）第 1 条）。

转录块的行数口径按 `batch-A-playbook.md` §2②（2026-10-14 追加）读：**「共 N 行」指围栏自身行数（含容器行）**。
本表的判据一律只数**条目行**，不复述围栏自身行数；要复算围栏自身行数的那两条 `awk` 管道已写在各记录
（形状基准 `tv-a3-draw-menu.md`「本面行数与增行数的复算」），别把两个口径混起来。

本表面刻意不写这几类句子（越界清单，逐条理由见 §8）：「A8 那趟 `--token-count` 执行了什么」（强推断，
count 趟 stdout 未留档）、「面板开关状态存在 localStorage 里」（存续载体本批未读，四面场景 JSON 的 `storage`
段逐字是 `"cookies":[],"local_storage":[],"session_storage":[]`＝未请求任何 storage 读数，只准写现象）、
「TV 那处没有事件绑定」（`listeners: []` 是枚举面空读数）、「按某个 id／class 属性值指认元素」
（A1 的 `dom` 段只给属性名）、「画线工具总共就这 17 件」（本批只点了 `Trend tools` 一个目录）。

| 条目号 | 规格句 | 判据 | 判据类型 | L0 依据 |
|---|---|---|---|---|
| TV-DW-01 | 趋势类画线目录是一棵两层 treegrid：3 个分组行（Lines／Channels／Pitchforks）下挂 17 个工具行，工具行的可达名逐字到名字级（Trendline／Parallel channel／Schiff pitchfork 等） | 在 `docs/forensics/l0/tv-a3-draw-menu.md` 上跑三条只读计数：`grep -c '^  - row "' docs/forensics/l0/tv-a3-draw-menu.md`＝20（分组行＋工具行合计）、`grep -c '^    - gridcell' docs/forensics/l0/tv-a3-draw-menu.md`＝3（只有分组行自带同名 gridcell）、`grep -c '^- treegrid:' docs/forensics/l0/tv-a3-draw-menu.md`＝1 ⇒ 20−3＝17 个工具行、3 个分组行；gridcell 枚数与分组行枚数必须相等，这是「两层」这一形状在仓内唯一数得出的读数 | DOM | tv-a3-draw-menu.md |
| TV-DW-02 | 图元集合的管理入口是一枚右侧面板开关，面板顶部是两页 tablist，默认落在 `Object tree` 页；`Data window` 页的表头本批未读取 | 在 `docs/forensics/l0/tv-a8-legend.md` 上：`grep -c '^  - tab ' docs/forensics/l0/tv-a8-legend.md`＝2、`grep -c 'tab "Object tree" \[selected\]' docs/forensics/l0/tv-a8-legend.md`＝1、`grep -c '^- tablist:' docs/forensics/l0/tv-a8-legend.md`＝1；「Data window 页里表格有哪几列」需要第二次 click 切页，本批纪律（一趟一个打开动作）没跑 ⇒ 本条只撑到「两页＋默认页」这一级，不许外推列名 | DOM | tv-a8-legend.md |
| TV-DW-03 | 对象树工具条给图元集合提供四个动作入口（建组／克隆复制／移动／管理布局图元），本批观察到其中三枚带 disabled 态 | 在 `docs/forensics/l0/tv-a8-legend.md` 上：`grep -c '^  - button .*disabled' docs/forensics/l0/tv-a8-legend.md`＝3、`grep -c '^  - button ' docs/forensics/l0/tv-a8-legend.md`＝4（工具条四枚，面板开关那枚是第 5 枚、缩进不同故不在这一格）；限制：本面没做任何选中操作，只能写「观察到 disabled 态」，**不许**写成「因为没选中所以 disabled」（provider limitations 首条：送达顺序不证因果） | 状态 | tv-a8-legend.md |
| TV-DW-04 | 样式／周期／品种三项图表状态在对方 localStorage 里各占一个独立键名，而不是合并存在一个布局值里 | 同一条只读计数：`grep -c '^    local_storage_keys\[20\]:.*tradingview\.editchart\.model\.style,.*editchart\.model\.interval,.*editchart\.model\.symbol' docs/forensics/l0/tv-a16-storage.md`＝1（三个键名逐字落在同一行键名清单上）；限制（引用本份记录必须带上）：这是本批**唯一**一份键名级证据，且那一趟自陈 `fingerprints_complete: false`（摘录第 56 行）与 `values_redacted: true` ⇒ 只到键名级；「键里存的是什么值」「画线对象本身存在哪儿」都不许由本条外推 | 状态 | tv-a16-storage.md |
| TV-DW-05 | 收藏画线工具栏的可见性是一项会话级偏好，「锁定线条删除」开关是持久级偏好，两者在对方存储里各自独立成键 | 在 `docs/forensics/l0/tv-a16-storage.md` 上两条计数各＝1：`grep -c '^    session_storage_keys\[4\]: widgetbar.layout-settings,ChartFavoriteDrawingToolbarWidget.visible,chartPageGrid.maximizedPanel,symbol-lists.activeList' docs/forensics/l0/tv-a16-storage.md`＝1（可见性键在 session_storage 那一行）与 `grep -c '^    local_storage_keys\[20\]:.*tradingview.toggle_delete_locked_linetools' docs/forensics/l0/tv-a16-storage.md`＝1（删除开关键在 local_storage 那一行）；限制同 TV-DW-04（键名级、`fingerprints_complete: false`、值一律未落，「那个 visible 键的值是 true 还是 false」本批读不到） | 状态 | tv-a16-storage.md |
| TV-DW-06 | 图元的绘制层可被 `canvas` 这一标签写法指到并取回 CDP 后端句柄，而同趟 `dom` 段只给属性名不给属性值 ⇒ 画布层的判据只能走「标签写法命中＋后端句柄」，走不了「按 id／class 属性值指认」 | 在 `docs/forensics/l0/tv-a4-canvas.md` 上：`grep -c '^    match: found' docs/forensics/l0/tv-a4-canvas.md`＝1、`grep -c '^    backend_node_id: 89' docs/forensics/l0/tv-a4-canvas.md`＝1、`grep -c '^    selector: canvas' docs/forensics/l0/tv-a4-canvas.md`＝1（回显与实参同形）；在 `docs/forensics/l0/tv-a1-page.md` 上：`grep -c '^        node_name: CANVAS' docs/forensics/l0/tv-a1-page.md`＝1、`grep -c '^        attribute_names\[5\]: data-name' docs/forensics/l0/tv-a1-page.md`＝1；限制：命中的是**哪一枚**画布本批没有基数读数（`tv-a1-page.md` 正文记的「20 个 CANVAS」是那趟 `%TEMP%` 留档上的活树计数，留档会随清理消失、仓内数不出来，故本批不据以立判据），且 `listeners: []` 是枚举面空读数，**不等于**「画布不响应事件」 | DOM | tv-a4-canvas.md、tv-a1-page.md |
| TV-DW-07 | 图元渲染后的整页像素验收只能写成等值判据：同一 target、同一视口、同一条 `capture-web-screenshot` 连跑两趟，`normalized_result.artifact` 的 `sha256` 与 `bytes` 逐项相等；**不许**写期望常量，**不许**写像素差 x% | 对自家静止图表页（本机 dev server，同 target 同 746×483 视口）连跑两趟 `capture-web-screenshot http://127.0.0.1:9222 <tid> --allowed-origins <本仓 origin> --filter-output evidence_id,normalized_result --token-limit 150000`，断言两趟过滤输出的 `artifact` 块下 `sha256` 与 `bytes` 两把键逐字相等（这两把键在仓内记录里的形状见 `docs/forensics/l0/tv-a9-axis-scale.md` 摘录的 `  artifact:`／`    sha256:`／`    bytes:` 三行；相等就成立，不等就查自家渲染的 nondeterminism，**不许**放宽判据）；「期望常量形状不可用」这一半在仓内可复算：`grep -c '^    bytes: 225300' docs/forensics/l0/tv-a9-axis-scale.md`＝1 与 `grep -c '^    bytes: 231704' docs/forensics/l0/tv-a15-pixel-baseline.md`＝1，两趟同命令同 target 同视口、`captured_at` 相隔 5.184 秒、字节差 6404 | 像素 | tv-a9-axis-scale.md、tv-a15-pixel-baseline.md |

## 本面在本批的证据边界

- 「画线工具**总共**有几件」不是本批的判据面：`tv-a3-draw-menu.md` 正文写明枚举基线里主工具栏另有
  `Fib retracement`／`Gann and Fibonacci tools`／`XABCD pattern`／`Patterns`／`Brush`／`Geometric shapes`／
  `Text`／`Annotation tools`／`Icon` 等独立分组按钮，而那些目录各自的展开态没有各自的记录。TV-DW-01 的
  「17」只指 `Trend tools` 这一个目录被点开后转录到的工具行。
- 工具行内的行内动作（`Add to favorites`／`Click here to learn more`）只在记录的正文里被指认、未进逐字转录，
  仓内数不出来 ⇒ 没立条目（理由与其余候选一并写在 `batch-A-playbook.md` §8（c））。
- Pine 编辑器（A12）是**判据缺口**：需登录、按裁定 1 不做登录绕过，本席未跑该命令，结构上没有 `evidence_id`，
  条目引用不到它。它进 L2 时只能落成「本批次未取证，成因＝登录门前置＋裁定 1」。
