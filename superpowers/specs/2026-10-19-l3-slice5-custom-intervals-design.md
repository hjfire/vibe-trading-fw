# L3 第⑤片设计：服务端「自定义倍数档位」的取数面

**日期**：2026-10-19　**分支**：`feat/l3-slice5-custom-intervals`　**L2 行**：`forensics/gap-matrix.md` 的 TV-CI-01

## 1. 这一片要解决什么

本仓的周期取数只能服务八个拼写：`_MINUTE_PERIODS`（`agent/src/api/market_routes.py:54`）的五档分钟、
`1D`、以及 `_AGG_DAILY_PER_BAR`（同文件 `:68`）的 `1W`／`1M`。研究场景里最常见的需求——「3 分钟」「2 小时」
「3 个月」——今天全部得到一句点名式报错（`:774` 那一支 400，`agent/src/api/udf_routes.py:514` 那一句
`unsupported resolution`）。本条错误消息本身写得诚实（「a silent round to the nearest neighbour would draw
monthly bars on a `3M` request and look like data」，见 `udf_routes.py:86-94` 的注释），但它挡住的是一整类
真实可用的档位。

本片把这一类放开：**任何能被「已可服务的基档 ×整数倍」表达的档位，都由基档再折叠出来**，绝不向数据源要一个
新拼写。折叠不是取巧，它是本仓既有的、被测试钉住的做法——周线与月线就是这么来的（`_fetch_calendar_bars`，
同文件 `:519`），理由在那条函数的 docstring 里逐条写着：覆盖率（Yahoo 链根本没有周线）、复权口径唯一（数据源
自己的周线骑在它自己的复权基数上）、分页精确（折叠根的时间戳取组内首根，`before` 游标恒落在组边界）。
这三条对新的倍数档位同样成立，所以本片不新取数据源，只把「按自然周月折叠」推广成「按倍数折叠」。

## 2. 三族语义（每一族都写明是本仓自拟还是对方凭据）

**取证边界先立起来**：批次 A 对对方周期面的唯一读数是 `forensics/l0/tv-a5-intervals.md`，它记的是**目录 DOM**
（39 枚 row、7 枚 level=1、32 枚 level=2、六类名），**没有任何一条**记录对方某个自定义档位的折叠语义。因此
本节三族语义全部是**本仓自拟规格**，不是复刻主张；L2 那一格的判据是 DOM 形状，本片不碰它（见 §5）。

### 2.1 分钟族：会话内序号折叠

目标分钟数 `R`（`R` 不在 `_MINUTE_PERIODS` 的取值里）选基档 `B` = 能整除 `R` 的最大可服务分钟档，`k = R / B`。
**会失败的只有拼写本身**：`R` 不是正整数（`2.5m`／`0m`／`-5m`）→ 不可表达 → 照旧报错；不引入「向上取整到最近
邻」那种会把数据画错的做法。`1m` 恒可整除任何正整数分钟，所以 `7m` 这类质数档是**可服务的**（`B=1m`、`k=7`）
——这不是一句顺手放宽，它是「基档 × 整数倍」这条模型本身的推论，也是本节那条大 k 少返风险的来源。

分组锚点 = **该基档根在其交易会话内的序号 ÷ k 取整**，跨会话绝不合并。这条是本案最容易做错的地方，两条判据
钉住它：

- A 股 60 分一天四根，收盘戳逐字是 10:30／11:30／14:00／15:00。**这条读数的凭据只在项目记忆 `chart-timeshare`
  那条第四节（600519.SH 那趟活体），不在仓内 L0**——本席 `grep -rln "10:30" forensics/l0/` 现读 0 命中，所以
  它是一条**自拟规格的理由**，不写成复刻主张。按它的形状看：若按「UTC 分钟 floor ÷ 2」分 120 分，10:30 与
  11:30 会被拆开、11:30 会与 14:00 并成一根——**把午休两端缝在一起**，画出世界上不存在的 K 线。按会话内序号分
  则得 [10:30,11:30] 与 [14:00,15:00] 两根，与任何券商的 2 小时图同形。
- 分时（`session=latest`）那条通道与此无关：它已在 `:649`／`:656` 那一对 `if session == "latest"` 里分别对
  「合并自周月」「日线本身就是一天一根」拒绝。本片要新增的三族都落不进这两句话，所以这条拒绝必须扩到全部
  折叠族——`kind != "native"` 且 `k > 1` 时点名报错，而不是让 `:656` 那句「already are one day each」对 2D
  说一句假话。

会话归属由 `_MINUTE_WALL_CLOCK_ZONE`（`market_routes.py:144`，基档收盘戳换回交易所墙上日期）决定，与
`_split_latest_session`（`:597`）同一条时区通道，不新建第二把尺。这条锚不需要处理 24/7 连续会话：分钟历史
只服务 `_FUTU_MINUTE_SUFFIXES`（`:92`，只有 SH／SZ／HK／US），本仓没有 crypto 的分钟通道，所以每一根基档分钟根
必然落在一个有界的交易会话里。OHLCV 规则逐字沿用 `_merge_to_calendar`（`:494`）那四条：开＝组内首根开，
收＝组内末根收，高／低＝组内极值，量＝求和；折叠根时间戳＝**组内首根**的时间戳，这样 `before` 游标仍是组边界。

可得深度不由本片放宽：基档分钟历史受 `_MINUTE_WINDOW_CAP_DAYS = 12`（`:101`）约束，所以 `k` 越大，一页能填
的折叠根越少。请求 500 根 120 分而基档只有 12 天，返回的根数就少于 500——**如实少返**，不许用重复根或插值补齐。

> **2026-10-20 修复轮坐标复测（Task 2 落地造成的漂移）**：本条只更新坐标与引用，上文任何一句判断都不改。
>
> （一）本节末「OHLCV 规则逐字沿用 `_merge_to_calendar`（`:494`）那四条」现在指错了地方。那四条规则
> （开＝组内首根开、收＝组内末根收、高／低＝组内极值、量＝求和，时间戳取组内首根）自 Task 2 起住在
> `agent/src/api/interval_spec.py:341-347`（`fold_by_keys` 函数体；跨度由下面（四）2026-10-22 复算，本条 2026-10-20 落笔时读作 `:284-287`、Block B 的（三）读作 `:295-301`，两枚都是当时的现读值，函数体上方只有 docstring 在长），而 `market_routes.py:494` 已经落进
> `_merge_to_calendar` 委托语句之上的 docstring 里——那里是转述，不是规则本体。委托那一行现在在
> `market_routes.py:497`。指错行的引用同样是缺陷，即使散文说得对，所以在此改口。
>
> （二）Task 2 在 `market_routes.py:48` 插了一行 import，又删掉 `_calendar_group_key` 那 21 行、把合并循环
> 换成一行委托（`market_routes.py:497`），于是本文其余 `market_routes.py` 坐标整体漂移。评审给的概览是
> 「`:48` 以下 +2、旧合并区之后 −19」，本席没有照这个加减法抄，而是逐格 `grep -n` 在改动后的树上现读——
> 于是抓到概览盖不住的一格：`_merge_to_calendar` 自己从 `:494` 落到 `:473`，是 **−21** 不是 −19，因为它的
> def 就站在被删掉的那段里。下列每一格都是现读值：
>
> | 符号 | 原文坐标 | 现读坐标 |
> | --- | --- | --- |
> | `_MAX_BARS` | `:52` | `:54` |
> | `_MINUTE_PERIODS` | `:54` | `:56` |
> | `_AGG_DAILY_PER_BAR` | `:68` | `:70` |
> | `_FUTU_MINUTE_SUFFIXES` | `:92` | `:94` |
> | `_MINUTE_WINDOW_CAP_DAYS` | `:101` | `:103` |
> | `_MINUTE_WALL_CLOCK_ZONE` | `:144` | `:146` |
> | `_merge_to_calendar` | `:494` | `:473`（委托语句 `:497`；规则本体已迁至 `interval_spec.py:341-347`，本格 2026-10-22 复算，见下面（四）） |
> | `_fetch_calendar_bars` | `:519` | `:500` |
> | `{source}+{interval}` 那枚 source 后缀 | `:564` | `:563`（该形状已由 Task 3 扩成 `f"{source}+{label or interval}"`；分钟族那条后缀在 `:702`） |
> | `_split_latest_session` | `:597` | `:596` |
> | `_kline_sync` | `:631` | `:639` |
> | `session=latest` 拒绝第一句（合并自周月） | `:649` | `:710`（`if session == "latest"` 那支的文案在 `:712-713`，逐字 `merged from daily ones, which are one day each already`） |
> | `session=latest` 拒绝第二句（`already are one day each`） | `:656` | `:717`（文案逐字 `daily bars already are one day each` 在 `:720`） |
> | 返回体 `payload` 三键区 | `:662-668` | `:723-729` |
> | `interval` 的 `Query(description=...)` | `:766` | `:827`（`description=` 的文案跨 `:829-833`，Task 3 把它从一行改写成一条规则） |
> | 档位不合法那支 400（`if interval not in …`） | `:774` | `:842`（守卫拼写已被 Task 3 换成 `if interval_spec.parse_interval(interval) is None:`，400 应答体在 `:843-845`） |
>
> （三）Task 3 的四处靶子按现读坐标重述一遍，免得上文的历史行号被当成待改坐标：if/elif/else 那条分派链起于
> `_kline_sync`（`:612`，三分支分别在 `:619`／`:629`／`:636`）；`session=latest` × 折叠族的拒绝要扩的那一对
> 是 `:630` 与 `:637`；放开档位要动的 400 分支在 `:755`；OpenAPI 说明书那枚 `interval` 的
> `Query(description=...)` 在 `:747`。本文其余坐标不吃这次漂移：所有 `udf_routes.py` 与 `test_udf_routes.py`
> 的引用（`:481`／`:95`／`:118`／`:475`／`:568`／`:514`／`:86-94`／`:205`／`:309`／`:333`，以及测试里的
> `:525`／`:555-562`）——Task 2 没碰那两个文件（`git diff --name-only 41c75b0c..69c57c5c` 现读只有五枚：
> `interval_spec.py`／`market_routes.py`／两枚测试／本文），所以此处只声明「未被本次改动波及」，它们自身是否
> 仍准由 Task 4 复测。
>
> （四）**2026-10-22 收尾波复算本表**：上面「现读坐标」那一列是 2026-10-20 Task 2 落地当场读的，之后
> `market_routes.py` 又被两笔推走一次——`6a45489f`（Task 3 接线，`git show --numstat` 现读该笔对这枚文件
> 是 `74 17`，hunk 从 `@@ -498,9 +498,14 @@` 起就有六处）与 `cd54c517`（把被删掉的会话对齐辅助换成注释，现读
> `31 5`，唯一那处增行 hunk 是 `@@ -654,9 +654,37 @@`）。本席按内容重钉了受影响的九格（`{source}+…`
> 后缀 `:545`→`:563`、`_split_latest_session` `:578`→`:596`、`_kline_sync` `:612`→`:639`、两枚
> `session=latest` 拒绝句 `:630`→`:710` 与 `:637`→`:717`、`payload` 三键区 `:643-649`→`:723-729`、
> `Query(description=...)` `:747`→`:827`、400 那支 `:755`→`:842`、以及 `_merge_to_calendar` 那格里
> 指向 `interval_spec.py` 的规则本体跨度 `:284-287`→`:341-347`），其余七格（`_MAX_BARS`／
> `_MINUTE_PERIODS`／`_AGG_DAILY_PER_BAR`／`_FUTU_MINUTE_SUFFIXES`／`_MINUTE_WINDOW_CAP_DAYS`／
> `_MINUTE_WALL_CLOCK_ZONE`／`_fetch_calendar_bars`）复算后与旧读一致，故原样留着。「原文坐标」那一列
> 是本文落笔时的样子，一字未动。上面（三）那条 Task 3 靶子清单读作**待改坐标的前态**，今天
> `_kline_sync` 的分派链已是四支（`:656`／`:703`／`:709`／`:716`），不再是三分支。

> **2026-10-20 Task 3 追加（本设计自己的一条论证是假的，外加担保范围收窄）**：本条只更正设计的
> 论证与引用，不改动上文任何一句历史散文，也不新增任何复刻主张——它谈的是「本仓为什么这样定」，
> 不是「对方这样画」。
>
> （一）`:38` 那句「若按『UTC 分钟 floor ÷ 2』分 120 分，10:30 与 11:30 会被拆开、11:30 会与
> 14:00 并成一根——把午休两端缝在一起」**在 `Asia/Shanghai` 是假的**。上海是 +8＝480 分钟，
> 480 % (2 × 60) == 0，floor 的桶界正好落在会话边界上，它对同一组四根 60 分给出的正是
> [10:30, 11:30] 与 [14:00, 15:00]，与序号锚点**逐字节同形**——Task 2 的
> `agent/tests/test_market_kline_custom_intervals.py:175` 那枚针的注释已经把这件事写明。锚点与
> floor 真正分道的条件是**时区偏移不是 k × base 的整数倍**，证人就是同文件 `:193` 那枚
> `Asia/Kolkata` 针（+5:30＝330 分钟，330 % 120 == 90 ⇒ floor 给三根、锚点给两根）。这次更正**不**
> 推翻本片的规格：锚点仍然是规格，因为它的答复与服务器坐在哪个钟上无关，而 floor 的答复有关；被
> 更正的只是那枚用来「演示 floor 会画错」的例子——它挑了一个判别不出来的钟。
>
> （二）`:33` 那句「跨会话绝不合并」的担保范围按实现读：锚点保证的是**不跨日／不跨会话边界**，
> 分组是「同一会话内连续 k 根」，于是 `k` 不整除上午那一段时组会跨过午休。今天经 `parse_interval`
> 就可达的两枚：`90m`（＝30m × 3）把 11:30／13:30／14:00 焊成一根，`45m`（＝15m × 3）把 11:15／
> 11:30 与下午第一根 13:15 焊成一根（收盘戳按本仓那四个 60 分戳同一套「期末标注」约定推出，本席在
> 改动后的树上现算得这两组）。裁定为**已知行为**：既不为此造一条认午休的锚（那要本仓没有的交易所
> 会话表），也不在闸门处拒绝这些乘数（仓内没有拒绝它们的凭据，凭空造一条就是给本项目添一枚它守不住
> 的规格）。落点：`agent/src/api/interval_spec.py:238-263` 的 docstring 已把担保范围改成上面这一句、
> 点名这两枚乘数，并把（一）里那句 floor 的假例证从注释里一并改口；
> `agent/tests/test_market_kline_custom_intervals.py:238` 那枚针把 `90m` 的跨午休焊根**作为已知行为**
> 钉住，防止后来者把它读成事故。
>
> （三）上一条 amend 的第（一）项与表格把 OHLCV 四条规则引用为 `interval_spec.py:284-287`，那四行
> 只覆盖高／低／收／量四行；「开＝组内首根开」与「时戳＝组内首根」出自同一函数体的
> `merged.append(dict(bar))`，诚实的区间必须从那一行起算。本席不回头改那条历史 amend，只登记现读值：
> 按 `47766dd3` 的树该区间是 `:281-287`，而 Task 3 在其上方净增 14 行 docstring（本次追加的（二）那
> 两段），所以**提交后的树**里它是 `interval_spec.py:295-301`（`merged.append(dict(bar))` 在 `:295`、
> 量在 `:301`；`fold_by_keys` 的 def 在 `:276`，长度守卫在 `:288-289`）。

> **2026-10-22 收尾波追加（分钟族「翻页不重绘」的承重换过地方了：上文 §1 `:17` 那句「分页精确」与本节那枚锚点的散文，一部分还写在一条已被删除的对齐步骤上，一部分压根没写新承重）**：本条只改口承重的归属、登记一枚残留限制，上文任何一句历史散文一字不删，也不新增任何复刻主张。
>
> （一）**分钟族的跨页一致由取数尺寸保证，不靠任何对齐步骤**。§1 `:17` 把「分页精确（折叠根的时间戳取组内首根，`before` 游标恒落在组边界）」列为折叠的三条理由之一——那三条对日线族与周月族逐字成立（`market_routes.py:479-483` 的 `_merge_to_calendar` docstring 与 `interval_spec.py:329-332` 的 `fold_by_keys` docstring 都这么写着，规则本体今天在 `interval_spec.py:341-347`，上面 Block B 的（三）所记 `:295-301` 是它那棵树的现读值）；**对分钟族不成立**：`_session_position_keys` 的序号从**被递进来的那个列表的头**起算，`interval_spec.py:283-286` 逐字写着 "the positions are counted from the head of **the list that was handed in** — two pages of one symbol, cut at different ``before``, each count their own positions and draw two grids. So agreement across pages is not something this function can hand out: it is a property of the caller's fetch size."。今天替本页付账的是 `market_routes.py:686-687`——`spec.k > 1` 时在 `count * spec.k + spec.k - 1` 之上再加一整日 `_MINUTE_BARS_PER_DAY[spec.base]`，于是被切开头那一会话折叠出来的组恒落在 `:702` 那句 `folded[-count:]` 的丢弃侧（因果写全在 `:657-668` 那段注释里）。所以 §1 `:17` 那三条理由该按族读：第三条对分钟族是**买来的**，不是「取组内首根时戳」自带出来的。
>
> （二）**窗口取不满（`len(bars) < ask`）时，最早那根的会话位置不可判——登记为残留限制、本片无针覆盖，不许写成已解决**：源被自己的历史深度截断时，窗口从源历史开头那处（可能正好在会话中间）铺开，最左一根确实可能是被切会话的第 N 根，那一会话的格就偏在整会话格之外。代码里两处点名而不修：`market_routes.py:680-685`（"Residual limit, registered rather than fixed"）与 `interval_spec.py:300-309`（"The limit that size does **not** buy, and no pin of this slice covers"）。这三枚既存的分钟族针钉的是**别的性质**，都不覆盖这一件（`agent/tests/test_market_kline_custom_intervals.py` 现读 def 行：`:650` 钉两页在重叠区间逐根一致、`:713` 钉满窗服务的是整会话格的后缀、`:760` 钉短窗口「不丢根、不裁页、保住首会话头」——最后一枚恰恰只保证「没裁」，不保证「左缘可判」）。§4 第 2 步那条「§2.2 分页确定性（同一标的两次不同 `before` 取到的重叠区间逐根相等）」因此按族读：分钟族那半边的判据落在尺寸上，取不满这一页的形状本片不判。
>
> （三）**本节实现中途引入过一枚对齐辅助，实测不动任何一页服务数据因而删除**：实现波曾加过 `interval_spec.session_aligned`（把分钟窗口的左边缘对齐到会话头），收尾波按差分扫描判它「永不生效」，依「永不生效的钳位就删」的既有先例删掉（提交 `cd54c517`；那笔说明里记着扫描的逐字读数 `served pages compared: 2304 — differences: 0`——**本席没有复跑那趟扫描**，只核了删除后的盘面：`git grep -n session_aligned` 现读 0 命中、rc=1）。`zone` 参数留下，仍被 `fold_bars` 用着（`market_routes.py:701`）。于是本文上文任何把跨页一致归给「对齐窗口左边缘」这种读法的句子一律作废，承重是上面（一）那枚余量。

### 2.2 日线乘数（`2D`／`3D`…）

按**交易日标签的绝对日序**（`ts_ms // 86_400_000`，日线戳本来就是「交易日标签的 UTC 零点」，所以这一除直接
还原标签、不吃任何时区表，见 `_calendar_group_key` 的 docstring——原文坐标 `:472-486`，该函数已随折叠面迁入
`agent/src/api/interval_spec.py` 并去掉前导下划线，本席 2026-10-22 现读作 `calendar_group_key` 的 `:191-205`，
而日线这一除的本体今天另住在同文件 `_day_ordinal` 的 `:229-234`）÷ k 取整分组。锚在绝对日序上而不是「取到的序列里的第几根」，
否则同一支标的两次分页会给出两套分组，翻页时图会重绘——这是 L0 记录之外本片唯一能静态判死的正确性。日线族
没有分钟族那个跨午休问题：缺交易日只是让某组少一两根（长假后的 `2D` 组可能只有一根），如实少合，不补根。

### 2.3 周／月乘数（`2W`／`3M`…）

把 `_calendar_group_key` 的返回值从 `(iso_year, iso_week)`／`(year, month)` 换成一个**绝对序号**再做除法：
周用「该 ISO 周的周一距 1970-01-05（ISO 纪元第一个周一）的整周数」，月用 `year * 12 + (month - 1)`。
用绝对序号而不是 `iso_week // k`，是因为后者会在跨年处撞车（`(2026,53)` 与 `(2027,1)` 同除后可能同组也可能
不同组，取决于 k 与年份；这两个数 2026-10-22 之前写的是 `(2026,1)` 与 `(2025,53)`，后一枚构造不出来，见本节末那条带日期更正），而现有 docstring 已经为这件事写过一条「bare week number would collide with week 1
of next year」；本片把同一个理由接到乘数上。`1W`／`1M` 是 k=1 的退化情形，**必须与今天逐字同形**——这条由
「摘掉乘数分支后既有 `test_market_kline_coarse.py` 全绿」来判，而不是靠新针。

> **2026-10-19 计划落笔时裁定**：本节引用的 `_calendar_group_key` docstring（原文
> `market_routes.py:472-486`）随折叠面迁入 `agent/src/api/interval_spec.py`，**同行不逐字**（这半句由 2026-10-22 收尾波按现读降级，原写的是「逐字同行」，四处差异逐条列在下一段那条同日追加的更正里）；
> `market_routes` 里那份已不存在，不留别名（这半句今天仍真：`grep -n "calendar_group_key" agent/src/api/market_routes.py` 现读 0 命中）。

> **2026-10-22 收尾波追加（把上段那句「逐字同行」按现读降到位，再把 §2.3 例子里那枚构造不出来的 ISO 周换掉）**：本条只登记现读差异，上段历史散文一字不删，不新增任何复刻主张。
>
> （一）迁址后的那份 docstring 与原文**行数相同、字面不同**，所以「逐字同行」降为「同行不逐字」。凭据＝两侧同长各 15 行的逐字比对：`git show 69c57c5c^:agent/src/api/market_routes.py` 的 `:472-486` 对 `agent/src/api/interval_spec.py` 的 `:191-205` 跑 `diff -u`，本席现读 **一处 hunk、−9 行／＋9 行**（块内第 4-9 与 12-14 行位移），两侧 `wc -l` 各 **15** ⇒ 「同行」这半句仍真。把差异按段落拼回原形再比，字面改动只有两枚符号，且全是**纯插入**（没有任何一处删除）：
> 1. `_bars_from_frame` → `market_routes._bars_from_frame`（迁出该模块后按裸名找不回，故加模块限定），连同它两侧的反引号由单升双；
> 2. `timeShare.ts` 的行内代码记号同理由单反引号升成双反引号；
> 合起来＝5 处插入（一枚 `market_routes.` 前缀＋四枚补上的反引号：整块反引号由 16 枚升到 20 枚）；第三段（ISO 周编号那段，块内第 11-14 行，第 10 行是它与上一段之间的空行）拼回后与新文**逐字相同**，位移纯粹来自重新断行。
> 另记一条**在 docstring 之外**的差：函数本身从 `_calendar_group_key` 改成公开的 `calendar_group_key`（`interval_spec.py:190`），本文 §2.2/§2.3 里凡按旧名写的那两处指的就是这枚函数，本席不改符号名，只在此登记。
>
> （二）§2.3 那个撞车例子原写 `(2026,1)` 与 `(2025,53)`——**后一枚构造不出来**：`python -c "import datetime as d; d.date.fromisocalendar(2025,53,1)"` 现读抛 `ValueError: Invalid week: 53`，而 `date(2025,12,29).isocalendar()` 已经是 `(2026, 1, 1)`，所以那两枚数在 ISO 历上既不存在、也谈不上相邻。本席把它换成 `(2026,53)`（周一 `2026-12-28`）与 `(2027,1)`（周一 `2027-01-04`）：两枚都可被 `date.fromisocalendar` 构造且时间上紧邻，于是裸周号除 k 的两种失效当场可算——`53 // 2 == 26` 而 `1 // 2 == 0`（紧邻却分家），`(2026,1)` 与 `(2027,1)` 的 `1 // 2` 同为 `0`（相隔 52 周却同桶）。2015–2031 里真有第 53 周的年份本席逐枚探得 **2015／2020／2026**（配方＝对每个 `y` 试 `date.fromisocalendar(y,53,1)` 并接 `except ValueError`；把这条直接写进列表推导会在第一枚没有 53 周的年份整条抛掉，名单一个都取不到）。同一枚失效形状今天也写在代码侧的 `interval_spec.py:216-217`（`calendar_group_ordinal` 的 docstring 仍举着 `(2025, 53)`）——那是注释面、不在本席这九件之内，此处只登记不代改。

## 3. 接口与落点

新增一个纯模块 `agent/src/api/interval_spec.py`：

```python
@dataclass(frozen=True)
class IntervalSpec:
    kind: str          # "native" | "minute-fold" | "daily-fold" | "calendar-fold"
    base: str          # 交给既有取数通道的拼写："5m" / "1D"
    k: int             # 折叠倍数；native 恒为 1
    unit: str          # calendar-fold 才用："week" | "month"；其余 ""
```

- `parse_interval(text: str) -> IntervalSpec | None` 与 `parse_resolution(text: str) -> IntervalSpec | None`
  （后者吃 UDF 裸分钟拼写：`"1"`、`"120"`、`"2D"`、`"3M"`）。不可表达 → `None`，由调用方决定报错文案。
- `fold_bars(bars, spec) -> list[dict]` 纯函数，无 IO，是全部数值对账针的落点。
- 两处接线各只做「解析→按 kind 走基档通道→fold」：`_kline_sync`（`market_routes.py:631` 那条 if/elif/else）
  与 `history_payload`（`udf_routes.py:481`）。`_RESOLUTION_TO_INTERVAL`（`:95`）与 `_RESOLUTION_SECONDS`
  （`:118`）两张表**改成交给 spec 派生**。这不是顺手清理，而是本片自己会踩的坑：查 `_RESOLUTION_SECONDS`
  时带 `86400` 默认值的**静默兜底有两枚**——`:475`（`_bar_count` 估根数）与 `:568`（`history_payload` 的窗口
  过滤宽度）。一条 `120` 分请求今天到不了这里（`:512` 先报错），但折叠族一旦放开，它会按「一根＝一天」去算
  窗口：`_bar_count` 少取一个数量级的根，`:568` 又把窗口拉宽到 86400 秒、把不该进窗的根放进来。两枚都必须改吃
  spec 派生的秒数，且**兜底留着但只对 native 拼写成立**——一条表外拼写绝不该静默通过。
  > **2026-10-20 执行期 amend（Task 4 落点改口；主键由控制席当场 `grep -rn` 现读，全 `agent/` 排除 `__pycache__`）**：
  > 上面「两张表**改成交给 spec 派生**」按盘面收成了更强的一形——**两张表删除**。开工前复测是：
  > `_RESOLUTION_TO_INTERVAL` 的唯一读者是 `udf_routes.py:509`，`_RESOLUTION_SECONDS` 的两枚读者是 `:475` 与 `:568`，
  > 这三处一旦改吃 `parse_resolution`／`bar_seconds(spec)`，两张表**读者归零**；留着一张没人读的派生字典＋一枚整字典针，
  > 与本片在 `alerts_routes.py:51` 照出来的同一种病（词表长在别处、解析器说另一套）。本段给自己的用途写得很明白——
  > 「这不是顺手清理，而是本片自己会踩的坑：两枚 `86400` 静默兜底」——兜底消失即用途满足。
  > 「一条表外拼写绝不该静默通过」**没有松动**：表外拼写在 `history_payload` 入口就按名字被拒，拒绝文案点名那条规则
  > （含 `multiplier` 一词与 `'2.5'` 那枚带引号的拼写）。两枚针的 claim 逐字留在测试里（十二枚拼写、十二个宽度仍以字面量
  > 整字典对账），只是等号左边从「读 src 里那张表」换成「当场对 `interval_spec` 求值」。
- `/config`（`udf_routes.py:205` 与 `:309`、`:333`）的报价面：`supported_resolutions` 仍只列**原生**拼写
  （原生集合就是折叠族的基档集合，报它即报全族）；`intraday_multipliers` 保持五枚原生基档不变。这条不是偷懒，
  是协议语义：库按「基档 ×倍数」自己发 `resolution=120`，服务端只要能吃下就行，把 1..n 全列进报价表反而造出
  一张需要长期维护的清单。判据写成一条**等式**：`/config` 报出去的每一个拼写，`/history` 都必须答得出（见 §4）。
- `market_routes.py:766` 那枚 `Query(description=...)` 逐字写着「1m/5m/15m/30m/60m, 1D, or 1W/1M」——它是
  OpenAPI 面给的人和机器读的那份说明书。集合放开后这一句必须同步改口，否则路由文档说的不是真话；`udf_routes.py`
  里 `:86-94` 那段「multipliers are **not** here」的注释同理，它会在本片结束时变成假话，必须一起改。

## 4. 验收序（顺序即判据，失败即停）

1. **纯函数先红**：`agent/tests/test_interval_spec.py` 钉解析表——`"120"`→`60m×2`、`"2D"`→`1D×2`、
   `"3M"`→`month×3`、`"7m"`→`1m×7`（这条钉的是「基档 × 整数倍」的推论，不是宽容）、
   `2.5m`／`0m`／`-5m`／`"abc"`＝`None`，以及 k=1 的原生拼写必须 `kind="native"`（否则 §2.3 那条同形判据
   失去落点）。
2. **折叠对账**：`agent/tests/test_market_kline_custom_intervals.py` — 手算向量的 OHLCV 等值、§2.1 那条
   反例（A 股 120 分跨午休不得合并）、§2.2 分页确定性（同一标的两次不同 `before` 取到的重叠区间逐根相等）、
   §2.3 跨年 ISO 周乘数、**前缀不变量**（只用前 N 根基档折叠 == 全量折叠的前缀；这条同时是未来函数探针），
   以及 k=1 与既有 `test_market_kline_coarse.py` 的同形（摘掉乘数分支必红）。
3. **路由面**：`/market/kline` 与 UDF `/history` 各钉「不可表达 → 400/`s:"error"` 且文案点名可服务集合」、
   「可表达 → `source` 后缀带折叠标识」（沿用 `:564` 那枚 `{source}+{interval}` 形状，让状态行说的是真话）、
   §2.1 那条 `session=latest` × `k > 1` 的拒绝（文案必须说清「折叠根跨天」，不许复用 `:656` 那句「already
   are one day each」），以及 §3 末那条文档面——从 FastAPI 的 route 对象读出 `:766` 的 description，断言它
   写的是一条「基档 × 正整数倍」的规则，而不是八枚字面量的死清单。
4. **报价等式**：一条参数化针遍历 `/config` 报出的每个拼写，断言 `/history` 不再回 `unsupported`；同一趟里
   断言两枚 `86400` 兜底（`:475`／`:568`）对表外拼写**不再可达**——做法是给 `parse_resolution` 返回的每条
   spec 断言一个非 None 的秒数，而不是去 grep 源码。
5. **活体探真进程**：不起 TestClient 交差了事——按 `verify-endpoint-live-probe` 那条戒律，起后端真进程，
   `curl` 打 `/market/kline?interval=120m` 与 `/api/udf/history?resolution=120`，读数（根数、首尾时间戳、
   `source` 串）逐字落到新的 L0 `forensics/l0/self-ci01-custom-fold-feed.md`（用途＝活体读数）。光看状态码
   不算数：同一趟里比对返回的 `t` 数组首尾与本地纯函数对同一基档的折叠结果。
6. **八道门**：G1 tsc／G2 vitest／G3 build 本片零贡献但照跑；G4 wiki 套件、G5 `forensics_audit.py`、
   G6 `test_forensics_spec.py`、G7 水位门、G8 grep 门。两枚本机恒红门只交「本片跟踪面 0 贡献」的归属，
   不调阈值、不改门体、不清白名单既存命中。逐腿自打 rc，判据是 rc 汇总里每腿标签逐名点齐。

## 5. 明确排除

- **前端一字不动**：`IntervalKey` 是八枚字面量的联合类型（`frontend/src/lib/marketApi.ts:18`），仓内 76 处引用、
  16 个文件（本席当场 `grep -rn | wc -l` 现读；含 `chartView.ts:34` 的 `intervalAllowed` 单一谓词、画线分桶、
  会话键、回放与对比页）。把类型打开成「可含自定义档」是另一片的全部工作，混在本片里做必然留下「后端能服务、前端进不去」的半截态。下一片（第⑥片）做两级目录 UI ＋
  自定义档位入口，并让目录只报 `/config` 给出的可服务集合。
- **不升 L2 那一格的状态**：TV-CI-01 判据是「两层 treegrid 目录形状＋六类分组＋Add custom interval 那一行」，
  全是 DOM 面。本片产出的是后端取数能力，不是那个形状的任何对应物。拿它盖一个 `部分` 就是
  `verify-stamp-vouch-scope-overclaim` 那条病灶的重演。本片只在该格追加一条带日期的登记，写明「取数面先行、
  判据面未动、判态仍 `缺`」。
- 不做 tick／秒级档位（本仓没有秒级源，`IntervalKey` 的类型联合里也没有）。
- 不引入任何对方档位名／键名／控件名字面量进跟踪文件（域名与商标红线照旧，G8 的 `[gate b]` 既存命中一枚不清）。
- 不改 `_MINUTE_WINDOW_CAP_DAYS`、`_AGG_DAILY_CAP`、`_MAX_BARS` 任何一枚上限。
- 不动 `frontend/src/lib/pine*.ts`、不动回测引擎。

## 6. 风险与代价

- **折叠语义若与对方不同，本片不背**：本片没有对方语义的凭据，所以 §2 三族都标了自拟。代价是第⑥片的目录
  文案不能说「与对方同形」，只能说本仓形状。
- **分钟族在大 k 下可能取不满一页**：最坏的就是 `7m` 这种只能落在 `1m` 基档的档——基档需求是折叠根的 7 倍，
  再乘 `_MINUTE_BARS_PER_DAY["1m"]=390`，很容易顶到 `_MAX_BARS`（`market_routes.py:52`，2000）与 12 天窗口。
  判据是「不许补根」而不是「必须补足」。少返不是隐身：返回体本来就有 `bars`／`interval`／`source` 三枚键
  （`market_routes.py:662-668`），`len(bars) < count` 加上带折叠标识的 `source` 就是可见证据，本片不加新键。
- **改派生式会动到既有 UDF 针的两处读数**：`test_udf_routes.py:525` 那一组参数化用 `D`／`W`／`M` 三档验根数
  估算，而 `:568` 的窗口宽度同样吃 `_RESOLUTION_SECONDS`——月线那档的 31 天近似就活在这条针里（`:555-562` 的
  注释专门解释了它为什么宁可多含一根也不许少含）。改派生式后这两处必须逐字同读数：先跑基线留未跟踪件，再动。
  > **2026-10-20 执行期 amend**：这条风险按设计兑现了。执行席按计划先跑基线并把未跟踪件留在仓库外，动完再逐字比对；
  > `test_udf_history_and_market_kline_are_the_same_bars` 的 `D`／`W`／`M` 三档在改动前后同为通过，`M` 档那枚 31 天近似
  > 现在不来自 `udf_routes` 的表而来自 `interval_spec` 的月宽（经 `bar_seconds(spec)` 到达），`:555-562` 那段
  > 「宁可多含一根也不许少含」的理由逐字留着、解释的换成派生值。坐标按现读算：参数化那组在
  > `agent/tests/test_udf_routes.py:523-527`，窗口过滤那行改动前在 `agent/src/api/udf_routes.py:568`。
- **ISO 周纪元的边界算错**是最隐蔽的一种失效（只在跨年那几周红），所以 §4 第 2 步点名要一条跨年样本，
  且针里要有「k=1 时与今天同形」这条对照，否则整族周线都可能被悄悄改掉。
