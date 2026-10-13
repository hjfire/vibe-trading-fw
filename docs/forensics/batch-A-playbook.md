# 批次 A：TV 图表页观察（P1）

这份清单在第一次对 `tradingview.com` 发起抓取**之前**写成并提交，里面不含任何抓取结果。
spec §9 第 4 条要求「第一次实抓前先报打算抓哪几面」；2026-10-13 用户已逐条点头四件事
（跑哪几面／拿不到的面／只读纪律／`--include-*` 旗标取舍），本文件就是那份点头的落地口径。
**改动批次内容（加面、换面、换旗标）要重新问一次**，沿用它不等于授权扩大它。

**2026-10-13 晚的第二次点头**，它落在这些地方：§1 表里六行带「② 」前缀的新面（A3／A5／A7／A8／A9／A15）、
§1 末尾关于 `click` 定位的那句、§2 末尾的 `at_end` 取舍、§4 的「场景完整性两层」与 `limitations` 两条、
§5 整节的三档改写、§6 的闸门措辞、§7 的产物清单。**§3 与 §5 里小节内编号用的 ①②③ 不是这个前缀**，
别把它们读成批次内容变更；除此之外批次内容没变。
- 扩面：«全扩：A3＋A5＋A7＋A8（推荐）» ⇒ 四个交互复捕面进入批次 A（§1、§5①）。
- 动作纪律：«允许：只做打开类动作（推荐）»，其约束原文是「只点自己触发的 UI，不登录／不保存／不交易，
  见 429 或验证码立刻停手并记不可取证」⇒ §6 的闸门从「GET only」改成这一句。
- 像素面：«纳入，但只落 sha256＋bytes＋media_type（推荐）» ⇒ ② A9／A15 进入批次 A，且像素证据有专门红线（§2、§5③）。

---

## 0. 怎么挂上去（这一步决定后面所有面）

REA 只能挂到**启动时就带了调试端口**的浏览器上；已经在跑的窗口挂不进去。所以每一趟都是
我们自己起一个无头 Edge，URL 作为**命令行参数**交给这一趟进程：

```bash
python -m http.server 8077 --bind 127.0.0.1 --directory tools/rea_probe_site   # 仅 P0 探针页用
"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new \
  --remote-debugging-port=9222 --user-data-dir="$TEMP/rea-cdp-profile" \
  --proxy-server="http://127.0.0.1:<当次读到的系统代理端口>" \
  --disable-extensions --disable-sync --no-first-run --no-default-browser-check \
  "https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL"
npx -y rea-agents@latest list-browser-targets http://127.0.0.1:9222            # 取 target_id
```

**这一行的 `--proxy-server` 是 2026-10-13 晚现读补的，不是可选装饰。** 当时实测：`curl` 直连
`https://www.tradingview.com/chart/` 是 `http_code=000` ＋ `Recv failure: Connection was reset`（TLS 阶段被 RST），
注册表 `ProxyEnable=0x1`／`ProxyServer=127.0.0.1:7897`，带 `--proxy http://127.0.0.1:7897` 重发＝**200**；
而备忘里那个老端口 10808 当时已经拒连。⇒ **每次跑之前先 `reg query` 现读那两个键，把读到的端口传进 Edge，
不要把端口当常量抄**。`npx` 这一侧不吃代理也能解析 6.4.0（走的是国内镜像缓存），别把两件事混起来查。
若现读到的结果是「`ProxyEnable=0` 而直连又被 RST」⇒ 按 §6 判**环境未就绪**、如实停手，
**不去翻别的端口、不想办法绕**（这就是「不伪装、不规避」的落点）。

（2026-10-13 夜，批次 A 第二趟现场复测：裸连那一腿仍然是 `http_code=000`，但 `curl` 的失败文本换了一形——
当次读到的是**退出码 28 连接超时**，没有 `Recv failure: Connection was reset` 那句（**仓内可反查**：
`docs/forensics/l0/tv-a9-axis-scale.md` 的 `- 观察条件：` 那一行就写着「`curl` 退出码 28 连接失败」；
同一现场的预检原始件留档在 `%TEMP%\rea-t10b\precheck.txt`，属仓外、随清理消失。
↑ 这里原先标的是「席位一报告 §8 第 6 条」，那是**错坐标**——那一行讲的是「不能写像素差 x%」，
而报告住在 `.superpowers/` 那种 git 忽略的 scratch 里，本来就不该当仓内坐标引；2026-10-13 深夜
独立评审复核（N4）时换成上面这两条，旧那句作废）。两形的判决一样：**带代理那一腿＝200 ⇒ 真答案是给 Edge 带 `--proxy-server`**，
不是判网络全灭。⇒ 往上那句「又被 RST」当**其中一形**读，别把它当唯一形状去比对；预检要记的是
「裸连的 `http_code` 与退出码」这两件事，不是某个固定错误串。）

（2026-10-13 深夜，交互面席位把上面那句「先 `reg query` 现读那两个键」落实时撞到的：**键路径不在惯常那个位置**。
`reg query "HKCU\Environment" //v ProxyEnable` 与 `//v ProxyServer` 本机都报「系统找不到指定的注册表项或值」，
真实位置是 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings`（`ProxyEnable` 是 `REG_DWORD`、
`ProxyServer` 是 `REG_SZ`）。逐字两条：

```bash
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" //v ProxyEnable
reg query "HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings" //v ProxyServer
```

读到值不等于该用它：还要看 `ProxyEnable` 是不是 `0x1`（当次读到 `0x1`／`127.0.0.1:7897`，
留档 `%TEMP%\rea-t10c\precheck-reg-internet-settings.txt`）。↑ 上面那句「现读那两个键」当**没写路径的初版**读。）

收尾**只按 `netstat -ano` 取到的那两个 Windows PID** `taskkill`，然后删 `$TEMP/rea-cdp-profile`。
**绝不按镜像名杀 `msedge.exe`**——机器上同时开着人工使用的真实 Edge 窗口。

三条挂载口径（每条都是现读命令帮助或实跑留档得到的，留档在 `%TEMP%\rea-t7\`、`rea-t8*.txt`、
`rea-t9-enum*.txt`，都是仓外临时件、会随清理消失，所以读数写在正文里）：

- `list-browser-targets` 报的键是 **`target_id`**（不是 `targetId`），尽管 `--help` 的实参名写着 `targetId`。
- 四个单趟 CDP 命令（`inspect-web-page`／`analyze-web-bundle`／`inspect-web-event-listeners`／
  `capture-web-screenshot`）**都有** `--allowed-origins <array>`，帮助原文 *Optional exact-origin filter*。
  「Optional」不等于「无所谓」：`analyze-web-bundle` 的帮助第一行自陈 *defaulting to the selected target origin*，
  而 `inspect-web-page` 自己的 `limitations` 第 4 条写着「没有 allowed source URL 的脚本与控制台事件会被排除，
  因为它们的出处证明不了」。⇒ 本清单里这四条命令**全部显式带上** `--allowed-origins https://www.tradingview.com`，
  按 README §4 第 2 条写成**裸值**（`'["…"]'` 那种 JSON 数组字面量会被拒 `invalid_request`）。
- `capture-browser-scenario`（§5① 那四个面用它）**不挂** URL 命令行参数、也**不吃** `--allowed-origins`：
  它只吃一个入参 `inputJson`，帮助原文 *"Inline browser scenario JSON or JSON file path"* ⇒ 给内联 JSON 就绕开了
  本机一切「吃磁盘路径」的坏道。`browser.mode: connect` 只需 `cdp_endpoint`＋`target_id`（**不需要** `executable_path`，
  那是会撞 ESTALE 的 `launch` 模式）。实测该趟回报 `browser{mode: connect, process_ownership: external,
  cleanup: disconnected-external, product: Chromium, version: 155.0.4283.45}` ⇒ 它只**断开**连接，不会关掉我们起的 Edge。

## 1. 打算跑的面

目标页：`https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL`（公开、匿名可访问、无需登录）。

| 面 | 命令（`--filter-output`／`--token-limit` 是收口口径的一部分，照抄） | 取什么 | 开关 |
|---|---|---|---|
| A1 页面骨架 | `inspect-web-page http://127.0.0.1:9222 <tid> --allowed-origins https://www.tradingview.com --observation-ms 1500 --include-accessibility-text --include-json-body-shapes --include-websocket-shapes --filter-output evidence_id,normalized_result` | DOM 分段与节点形状、`accessibility.nodes` 里同一 `parent_id` 下的 `role: button` 群、`network`／`websocket` 的**形状** | 三把旗标，理由见 §2 |
| A2 脚本与端点 | `analyze-web-bundle http://127.0.0.1:9222 <tid> --allowed-origins https://www.tradingview.com --observation-ms 2000 --filter-output evidence_id,normalized_result.observations` | `endpoints[]`（它有哪些数据需求）／`chunks.nodes`+`edges`（模块图）／`routes` | 该命令不吃 `--include-*` |
| A4 元素事件面（**每条 selector 一趟，一份 L0**） | `inspect-web-event-listeners http://127.0.0.1:9222 <tid> --allowed-origins https://www.tradingview.com "<selector>" --filter-output evidence_id,normalized_result.selected_node,normalized_result.listeners` | 那一处挂的是 `pointerdown` 还是 `click` 等原生监听器＋回调的 `url`/`line_number`/`column_number` | 不适用；**过滤键必须写到 `listeners` 为止**，见 §3② |
| A16 存储键面（**与 A1 分趟**） | `inspect-web-page http://127.0.0.1:9222 <tid> --allowed-origins https://www.tradingview.com --observation-ms 1500 --include-storage-keys --include-storage-fingerprints --filter-output evidence_id,normalized_result` | 对方把图元／布局／偏好存成哪些**键名**与**内容指纹**（不含值） | 两把 storage 旗标 |
| ② A3 画线工具目录 | `capture-browser-scenario '<JSON：click 打开画线工具条 → wait_for_timeout → at_end: accessibility>' --token-limit <见 §3③>` | 展开后的工具**类别数与语义**（`role`＋`name`，不是图标形状）；对账本仓 13 件 | §5① 的模板 |
| ② A5 周期与分辨率菜单 | 同上，`click` 落在周期切换那处 | 周期档位全集（可达文本里的 `name` 清单）；对账本仓 8 档 | 同上 |
| ② A7 指标对话框＋样式页 | 同上，`click` 落在指标搜索那处（**只打开，不填、不提交**） | 对话框有哪几页／每页有哪些字段名（`role`＋`name`） | 同上 |
| ② A8 图例／数据窗口 | 同上，`click` 落在图例展开那处，`at_end: ["url","accessibility"]` | 图例每行显示哪几个字段、顺序如何 | 同上 |
| ② A9 刻度与轴（像素） | `capture-web-screenshot http://127.0.0.1:9222 <tid> --allowed-origins https://www.tradingview.com --filter-output evidence_id,normalized_result` | **像素本体**只落 `sha256`＋`bytes`＋`media_type`（§2 的像素红线；同趟的结构键照常转录，形状基准 `l0/tv-a9-axis-scale.md`） | 无 `--include-*` |
| ② A15 像素基线 | 同 A9，另起一趟作为后续对比的基线 id | 同上（像素本体那三键）；「像不像」这一版只能读到「字节变了没变」，见 §5③ | 同上 |

A16 与 A3／A5／A7／A8／A9／A15 都不在计划里，是本批次按用户点头新增／扩充的面。
**A16 为什么必须与 A1 分趟**：两份 L0 若共用一个 `evidence_id`，「一面一记录」的 1:1 关系就只剩摘录切块在维持，
而 GC7 立法要捕的正是这种混面（混进来的证据在 L1 拆不干净）。旧版这里写「与 A1 同一条命令，摘录只切 `storage` 块」，
2026-10-13 晚改口为**另跑一趟只开两把 storage 旗标**——代价是多一趟，换来的是两份记录各有主键。

A4 的 selector 候选（**我方假设，不是观察结论**）：图表 canvas 容器、工具栏容器、价格轴、时间轴、图例区。
② 交互面的 `click` 目标候选同样是**我方假设**；定位优先写 `{"kind":"role","role":"button","name":"…"}`
而不是 `css`——`css` 选择器会把对方的 class 命名逐字抄进 L0，而 `role`＋`name` 是可达语义层，
正好也是判据要引用的东西（裁定 1 第 1 条：不搬对方的表达层）。

## 2. 旗标与采集面取舍

`inspect-web-page --help` 里有七个 `--include-*`，默认**全关**（现读逐条为 `--include-accessibility-text`／
`--include-console-text`／`--include-json-body-shapes`／`--include-websocket-shapes`／`--include-script-sources`／
`--include-storage-keys`／`--include-storage-fingerprints`）。对本地中立页开哪个都不犯规；
对 `tradingview.com` 就是合规问题，按 spec 裁定 1 的三条硬线逐条等下来：

- **`--include-accessibility-text`＝开**。产出只摘**功能名**（按钮／菜单项的 `role`＋`name`），
  用来回答「工具栏到底有几组、分别是哪一类」。**不许**把整段 `accessibility.nodes` 成批入库，
  更不许把我方界面文案写成对方的措辞——文案属表达层，硬线 1 不碰。
- **`--include-script-sources`＝禁开**，写死在本清单里当禁止项。它把对方 JS 的**源码文本**带进
  stdout，直接撞硬线 1。
- **`--include-console-text`＝不开**（这一面没有判据需求，开了只是把对方措辞带回来）。
- **`--include-json-body-shapes`／`--include-websocket-shapes`＝开，只落形状不落值。**
  判据里引用「它有这个字段」可以，落任何字段值或样本数据不行（硬线 3 同一口径）。
- **`--include-storage-keys`（help 原文 *without values*）／`--include-storage-fingerprints`＝开。**
  键名与「内容派生哈希」是证据，不是内容本身；这一面正是 P3 对账画线持久化最想要的。

本机预检实测（2026-10-13，自家探针页，留档 `%TEMP%\rea-t7\a1-flags-on.txt:23`）：
把六段里能开的四段结构旗标＋无障碍文本**全开**（只留 `--include-console-text`／`--include-script-sources`
不动），`completeness.policy_filtered_sections` 从 6 项收缩到 **2 项**（`console_text,script_sources`）。

**这一趟是「旗标↔段落」的对照实验，不是批次 A 任何一面的预期读数。** §1 的 A1 只开三把（无障碍文本＋
两个 shape），A16 只开两把 storage——所以它们各自那趟的项数**必然大于 2**，那是口径不同，不是缺陷。
判据：段落全表是那六项（逐字 `accessibility,console_text,json_body_shapes,script_sources,storage_keys,websocket_shapes`，
见 `docs/forensics/l0/probe-skeleton.md:42` 的 `policy_filtered_sections[6]`），当次列表＝全表减去
这一趟开掉的旗标所对应的段落；`--include-storage-fingerprints` 到底让哪一段消失**还没验过**，
所以 A16 那趟以当次 stdout 为准照抄，别预填项数。

**② 交互复捕的 `at_end` 取舍**（`capture.at_end` 的值域是现读逼出来的 6 个：
`screenshot,dom,accessibility,url,history,storage`）：

- **`accessibility`＝开**。与 A1 那把旗标同形的读数面，只摘 `role`＋`name`。
  - **转录行数的计法（2026-10-14 追加，起因是本批 a3／a5 两份记录里「23 行」与「40 行」两种口径混过）**：
    记录里写「共 N 行」一律指**围栏自身的行数**（含 `- treegrid:`／`- dialog "…":` 那种容器行），
    因为「40 行上限」量的就是落进仓的文本行数。要另给「条目行数」必须两个数同写并各配一条复算命令
    （一条按围栏数行、一条按 `- row ` 数条目行；两条逐字的 `awk` 管道已经写在那两份记录里，
    形状基准 `docs/forensics/l0/tv-a3-draw-menu.md`「本面行数与增行数的复算」与 `tv-a5-intervals.md` 第二段引言）。
- **`url`＝开**。`before_url`／`after_url` 本身就是「点完有没有换页／换路由」的读数（含 `query_parameter_names`）。
- **`screenshot`＝开，但 L0 里像素本体只准落三键**：`sha256`＋`bytes`＋`media_type`。
  实测形状 `screenshot{state: captured, value: {sha256, bytes: 9727, media_type: image/png, data_base64: …}}`
  ——`data_base64` 是**图像本体**，一个字都不许进仓库（裁定 1 的表达层那条）。
  **这条红线的管辖范围是「像素本体」，不是「整份 stdout」**：同一趟里的结构键——`browser`／`target`／
  `viewport`（我方窗口几何）／`captured_at`／`completeness`／`limitations`——是工具自己的读数，
  照样逐字转录并带留档行号。形状基准＝`docs/forensics/l0/tv-a9-axis-scale.md`（39 行留档只略过三段——
  第 7 行 `user_agent`（我方浏览器的 UA 串，与像素无关）、第 21 行 `data_base64`（图像本体）、
  第 31-37 行那七条 `dropped_events` 计数（保留第 30 行键名与第 38 行 `total: 0`），其余逐字在栏，
  每段都给了可 `grep -n` 反查的行号）。
  别把「只落三键」读成「一份像素记录只准有三行」——那样 `--token-limit` 有没有切到载荷、
  视口是谁的几何这类口径就没处可写了。
- **`dom`＝允许跑，正文一个字不进仓**。实测留档（`%TEMP%\rea-t8-capdom.txt`）里 `dom.value.text` 就是**整段页面 HTML 正文**
  （探针页那趟 `bytes: 475`，逐字含 `<!DOCTYPE html>` 与我们自己写的按钮文案）。自家页面无害，
  对 `tradingview.com` 跑同一条命令带回来的就是对方的标记正文。⇒ L0 里 `dom` 最多落
  `state`＋`sha256`＋`bytes`，**不许**落 `text`。
- **`history`／`storage`＝不开**。前者本批次没有判据需求；后者是 A16 那一面（由 `--include-storage-*` 那趟拿，
  不要在同一趟里混第二个面）。

## 3. 三条必须写死的口径（都是实测撞出来的）

**① `--filter-output normalized_result` 会把顶层 `evidence_id` 一起滤掉。**
一份 L0 的主键就是 `evidence_id`，所以过滤键一律写成 `evidence_id,<真正要读的键>`；
摘录与主键必须**同一趟**拿到，不许拿另一趟的 id 凑。

**② A4 会默认内联回调所在脚本的**源码文本**，不需要任何 `--include-*` 就会带出来。**
探针页实测：`inspect-web-event-listeners ... "#probe-chart"` 不限流那份 5,361 字节，其中
`normalized_result.sources[].source.text` 是**整个脚本的逐字正文**（连同 `sha256`/`producer_hash`）。
⇒ 对 `tradingview.com` 跑 A4 时，`--filter-output` 必须止步于
`normalized_result.selected_node,normalized_result.listeners`。
同一命令加这条过滤后本机实测 **511 字节**，`pointerdown`／`location.url`／`line_number`／`column_number`
全在，而 `text`、`sha256`、`producer_hash` **零命中**。这是硬线 1 在 A4 这一面的唯一守法，
写进记录规则而不是靠自觉。

**③ `--filter-output` 的下标键路径不生效。**
实测 `--filter-output normalized_result.steps[1].artifacts.screenshot` 回报 `steps: []` 且 `rc=0`——**静默空**，
不报错。帮助自己的示例写的是 `a[0,3]` 那种形状，本清单**没有**验证过它。
⇒ 场景记录（§5① 那四个面）的正式一趟按这个配方收口：先 `--token-count` 量大小，再用
`--token-limit <量到的那个数>` 跑正式一趟，**整份 stdout 落到仓外留档**，`证据：` 只从留档里切；
`命令：` 逐字抄正式那一趟（含 `--token-limit`，校验器 `_command_hygiene` 要看到它）。
切出来的每一行都要能在留档里 `grep -n` 到行号，写进记录。

（**2026-10-13 深夜现读：`--token-count` 那一趟不是零副作用的预检。**
证据是现场态漂移：A8 那一面跑完 count 趟之后，第一趟正式跑读到的是侧栏面板**关闭**态，而场景里只有一个
`click` 的打开动作（`docs/forensics/l0/tv-a8-legend.md`「读数含义」记了这第二趟方向相反的真实读数，
另存件 `%TEMP%\rea-t10c\a8-firsttrip-closed.txt`）。⇒ **强推断：count 趟把那枚开关按钮真点了一次**，
且这个态经当次 profile 目录持久化**跨趟存续**，改变了正式趟读到的现场。
**为什么说推断而不是读数**：本批四面的 count 趟各自只留了 token 数（`<面>-count.txt` 各 5 字节＝
5,707／6,166／4,546／3,153），**stdout 没留档**，所以看不到 count 趟自己的 `steps[].status`／`elapsed_ms`
⇒「它执行了 click」这条**没有直接读数**，只有 A8 那一面被漂移反证；A3／A5／A7 三面的 count 趟
有没有点着，本批无法判定（它们的 170 行树里带侧栏残留，见那三份记录的披露）。
⇒ **下一批跑带 `click` 的场景面时，把 count 趟的 stdout 也 `tee` 进 `<面>-count.txt`**，让这条从推断升级为读数。

⇒ 上面「先 `--token-count` 量大小，再跑正式一趟」这句只对**不产生页内副作用**的面成立
（A1／A2／A4／A9／A15 那类单次读取的面照旧）。对 §5① 这种带 `click` 的场景面，**count 趟按「可能真点了一次」对待**：
要么把它的读数与副作用一起留档，要么把易被开关的面放到**最后**跑。两趟的 `evidence_id` 不同，
`命令：` 与主键只能取自正式那一趟（§7）。）

（**2026-10-14 追正：上面「这个态经当次 profile 目录持久化」是机制名，本批没有它的读数。**
四面场景 JSON 的 `storage` 段逐字是 `"cookies":[],"local_storage":[],"session_storage":[]`＝**未请求任何
storage 读数**（逐字见那四份记录的 `命令：` 行）。⇒ 能落的只有现象：「上一趟留下的态活到了下一趟，
改变了正式趟读到的现场」；**存续载体（localStorage／IndexedDB／profile 目录，哪一个）本批未读**，不许指名。
已把 `tv-a3-draw-menu.md`:169／`tv-a5-intervals.md`:186／`tv-a7-indicator-dialog.md`:145／`tv-a8-legend.md`:140
四处的「经 localStorage 持久化」改成现象形并各标「存续载体未读」。下一批要坐实载体，就在场景的 `storage`
段里请求 `local_storage` 的**键名**枚举（键名级读数的形状与它的限制见 `docs/forensics/l0/tv-a16-storage.md`
「本面撑得住的结论」条——注意那趟记过 `fingerprints_complete: false`）。）

`--token-limit` 只当**体积闸门**用，别当「反正能截出我要的东西」：探针页 A4 整份约 1,477 tokens，
限 400 的那份把 `    - type:` 切在半截，`pointerdown` 零命中。每面**先不限流跑一次**确认目标键在、
有多大，再决定收口口径。

## 4. 判据写法上的硬限制（决定 L1 能写什么）

- A1 的 `dom` 段**只给属性名，不给属性值**（探针页留档里 `grep toolbar` 零命中，而页面上写的就是
  `<div id="toolbar">`；节点形状是 `attribute_names[3]: id,width,height`）。
  ⇒ 从 A1 只能指认**标签与角色级**事实（有几枚 `CANVAS`、`accessibility.nodes` 里同一 `parent_id`
  下有几个 `role: button`）。「某个 id 存在」这句话**没有**属性值级的证据面，L1 里不许写；
  「这一格挂着一个叫 `id` 的属性」是**有**证据面的。
- A4 的选择器是**入参**（「我告诉它看哪」），不是观察（「我看到了什么」）。
  落地判据只看 A4 自己那份输出：实测未命中的 selector 报 `selected_node.match: not_found`＋
  `backend_node_id: null`＋`listeners: []`，**rc 仍是 0、不报错**。
  ⇒ `not_found` 就如实记「这条 selector 在对方页面上没命中」，不许写成「A1 确认过」。
- **空面要先排除「写法导致」再读成「没有」**。A2 的 `endpoints[]` 若为空，头号嫌疑是 `--allowed-origins` 的写法
  （仓内 `docs/forensics/l0/probe-bundle.md` 把这条列为**未验证**的猜测留给后续复跑判定；本批次已按 §0 一律显式带裸值）。
  ⇒ 读法：先看当次 stdout 里的 `excluded`／`disallowed_origin` 计数，再决定能不能写「对方没有这个面」。
  `--include-json-body-shapes` 那一面同理——它**预计为空**，原因不是命令失败：
  REA 自己写明「Observation starts when REA attaches; prior network and console activity is unavailable」，
  而我们是一趟命令挂上去、页面早就加载完了。探针页实测 `--observation-ms 1500` 下
  `network.requests: []`、`prior_activity_available: false`。空就记空，数据需求那一面由 A2 的静态分析负责。
- `完整性：` 逐面照抄当次 stdout，一个值套不了三面（A1＝`policy_filtered`；A2＝`complete`＋
  `parse_failures: 0`；A4＝**整个 completeness 块不存在**）。
  另注意校验器那条**散文级**规则：正文任意处出现 `parse_failures` 字样，`完整性：` 里就得有它
  （`tools/forensics_audit.py` 的 `_audit_l0`）。
- **② 场景记录的完整性有两层，抄顶层那一份并解释它**：探针页实测顶层
  `completeness{status: incomplete, equality_eligible: false, missing_sections[1]: events}`，
  而**逐步**工件那一份是 `status: complete`、`missing_sections: []`。
  ⇒ `完整性：` 写顶层（`incomplete`），并写明「`missing_sections: events`＝本趟没开事件记录（`capture.events: []`），
  不是页面上没有事件」。
- **② provider 自陈 7 条 `limitations`**，对本批次有约束的是第一条与最后一条：
  「Event sequence records provider receipt order; simultaneous browser causality is not inferred.」
  ⇒ 场景记录里的顺序是**送达顺序**，不能写成因果；
  「CDP attachment cannot recover pre-attach events or guarantee launch-time context options.」
  ⇒ attach **之前**发生的网络／控制台活动仍然取不到，「没报」不等于「没有」（spec §2.4 的原意在这一条上依然成立）。

## 5. 交互面：三档说清（已实测机制／未验证／仍然不行）

顶部先写死：**把面从「跑不了」翻成「能跑」是批次内容变更**，按本文件前言要重新点头——
2026-10-13 晚已就这一件事点过（三个选项逐字抄在前言里），本节给的是「打算怎么跑」，不是「已经跑到了」。

**① 机制已被实测的：A3／A5／A7／A8** —— 从旧版的「不可取证」降为**待复跑**，**不写** `状态：不可取证`。

旧版这里写过一条错前提：「`capture-browser-scenario` 入参是磁盘文件路径，而本机一切吃路径的命令报 ESTALE」。
现在读到的帮助原文是 *"Inline browser scenario JSON or JSON file path"*（两种都行），
ESTALE 那条链**接不上**这张门。探针页实测（`%TEMP%\rea-t8-click.txt`，6,596 字节）：
`evidence_id ev_497acbd544027225a276811991e53b64a137cda560f206a7de51d6a10687572a`，`rc=0`，
三步（`goto_start`／`s1 click #probe-chart`／`s2 wait_for_timeout`）**全部** `status: completed`、`error: null`。
**点击之后还能同趟读出可达文本**这件事是**另一趟**证明的（`%TEMP%\rea-t8-capdom.txt`，`:43` 是
`at_end[3]: url,dom,accessibility`，`:124/:130` 两步工件 `state: captured`，`accessibility.bytes: 136`
逐字给出 `- button "Trend line"` 这一族 `role`＋`name`；同一留档 `:127` 的 `dom.bytes: 475` 就是 §2
那条红线说的那段 HTML 正文）。`rea-t8-click.txt` 那一趟 `at_end` 只有 `url`，它的 `dom`／`accessibility`
全是 `state: not_requested`——**别把两趟混成一条证据链**。

命令骨架（内联 JSON；`<…>` 是每面要替换的地方）：

```bash
npx -y rea-agents@latest capture-browser-scenario '{
  "browser":{"mode":"connect","cdp_endpoint":"http://127.0.0.1:9222","target_id":"<tid>"},
  "start_url":{"url":"https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL"},
  "actions":[
    {"step_id":"s1","action":"click","locator":{"kind":"role","role":"button","name":"<打开那件事的可达名>"}},
    {"step_id":"s2","action":"wait_for_timeout","duration_ms":1500}
  ],
  "storage":{"cookies":[],"local_storage":[],"session_storage":[]},
  "secrets":[],
  "capture":{"after_each_step":[],"at_end":["url","accessibility"],"events":[],
             "network":{"request_body":false,"response_body":false,"header_values":false}}
}' --token-limit <见 §3③>
```

**开关型控件要先固定基线（2026-10-13 深夜，A8 实测）。** TV 右侧 widget 面板那枚按钮是 **toggle**，不是单向打开：
同一枚 `click` 连跑两趟读到的是**相反**的两个态（本席第一趟落在已被 count 趟点开的态上 ⇒ 那一次 click 把它**关**了，
第二次跑落在关闭态上 ⇒ 读到**打开**）。⇒ 任何「点开某面板再读它里面有什么」的场景面，正式趟之前先跑一趟
**不点任何东西**的枚举趟（`actions` 只放 `wait_for_timeout`，`at_end` 带 `url,accessibility`）确认当次基线态，
并在 `观察条件：` 里写明本趟那次 click 之后面板是**开**还是**关**；读到意外态的那一趟**另存不删**，
把它当第二条方向相反的真实读数写进「读数含义」，别让主键与行号落到没被引用的那一趟上（§7）。

词表与形状（全部是「喂非法值逼工具自陈」现读来的，留档 `%TEMP%\rea-t8-enum.txt`、`rea-t9-enum2.txt`、
`rea-t9-enum3.txt`；三处都是 `code: invalid_request`／`category: invalid_input`／`details.issues[]` 的
`path`＋`reason: invalid_value`＋`expected[n]`）：

- `action` 9 值：`goto,click,fill,press,select_option,check,uncheck,wait_for,wait_for_timeout`。
- `locator.kind` 3 值：`test_id,role,css`；`kind: role` 下 `role` 14 值：
  `button,checkbox,combobox,dialog,link,listbox,menuitem,option,radio,slider,spinbutton,switch,tab,textbox`。
- `capture.at_end` 6 值：`screenshot,dom,accessibility,url,history,storage`（取舍见 §2）。
- 步骤自己的字段名是从 `parameters.actions[]` 的 **echo** 里现读的：`click` 带 `locator{kind,selector|role,name}`＋
  `button`＋`click_count`（实测 echo 出来是 `left`／`1`，其它取值一个都没测，见 §5②）；
  `wait_for_timeout` 的时长字段叫 **`duration_ms`**（不是 `timeout_ms`）。

三条坑（每条都实测过）：

- **Playwright strict mode**：selector 命中多个元素时该步 `status: failed`，`error` 逐字是
  `locator.click: Error: strict mode violation: locator('#toolbar button') resolved to 3 elements: …`，
  紧随的步骤变 `status: cancelled`、`error: not executed after an earlier action failure`
  （留档 `%TEMP%\rea-t7\scenario-run2.txt`，7,025 字节，顶层 `missing_sections[3]: action,events,url`）。
  ⇒ 一趟只放**一个**打开动作，且定位必须收到单元素。
- **不存在的 `role`／`name` 不会快速失败，而是把整趟挂住**：实测那趟（`%TEMP%\rea-t8-role.txt`）
  两分钟没有产出，被我中止后文件仍是 0 字节。⇒ **别把「探个名字在不在」的 miss 探针和真动作放同一趟**；
  要枚举名字，先用 A1／A8 的 `accessibility` 读数读回来，再决定点哪。
- **坏入参不挂**：`cdp_endpoint` 指向死端口也秒回 `invalid_request` ⇒ schema 校验跑在连浏览器**之前**。
  所以「逼枚举」这种探针不需要起现场。

动作纪律（用户选项原文「只做打开类动作」的落地，也写进 §6）：只用 `goto`／`click`／`wait_for`／
`wait_for_timeout`；`click` 只点「打开某物」的控件；`press` 只允许 `Escape`，用来关掉**我们自己点开**的面；
`fill`／`select_option`／`check`／`uncheck` 本批次**禁用**（它们改页面状态，其中 `fill` 会往对方表单里写内容）。

**② 仍未验证的：A6 右键上下文菜单** —— 动作词表里**没有右键**；留档里出现过 `button: left` 与 `click_count: 1`
两个字段，但它们的其他取值一个都没测过。⇒ 记「**未验证**」，不写「不可取证」，也不用左键硬凑一个「等价于右键」的读数。
A14 快捷键同理：`press` 在纪律上只用于 `Escape`，所以「键盘可达路径清单」这一面本批次不跑。

**③ 与交互无关、仍然不行的**：

- **A12 Pine 编辑器／A13 告警对话框**：要登录才能看到 ⇒ 撞裁定 1「不做登录绕过」。
  这两面各写一份 `状态：不可取证` 的 L0，`原因：` 逐字写「需登录，按裁定 1 不做登录绕过」，
  `命令：` 写清打算跑哪一条（校验器要求不可取证的记录也要有 `命令：` 与 `原因：`，且命令同样受 §3 的体积闸门约束）。
- **两个像素面之间没有「对比」读数**：`compare-web-screenshots` 吃的是 `<a.json> <b.json>` 磁盘路径 ⇒ ESTALE 那条坏路。
  ⇒ A9／A15 只有**单趟** `capture-web-screenshot` 可用；「像不像」这一版只能读到「同一位置重跑，`sha256`／`bytes` 变了没变」，
  像素差值等环境（Node ≥22.19 那条项目外动作）修好再说，别在 L1 里写「像素差异 x%」这种判据。
- **一切吃磁盘路径的 REA 命令**（`export-web-scripts`／`inspect-evidence-bundle`／`compare-web-captures`）：
  证据只留在 stdout，由我摘录。

## 6. 闸门与停手条件

- 只读公开页面 **＋ 只做打开类动作**（用户 2026-10-13 晚选项原文
  «允许：只做打开类动作（推荐）»，约束「只点自己触发的 UI，不登录／不保存／不交易，见 429 或验证码立刻停手并记不可取证」）。
  具体禁令：不提交任何表单，不点保存／新建布局／下单／关注／分享，不登录，不绕过检测，不伪装 UA，不改指纹，不重试撞限流。
- 出现空白页／空 `targets`／请求被拒／429／验证码 ⇒ **就地停手**，把该面标为不可取证，
  不想办法绕（spec §10 对策原话）。交互面还多一条：**同一趟里 `status: failed` 之后别补动作重跑**，
  先把那一趟的失败留档记成证据。
- 跑之前先探一次连通性（`curl` 裸跑一次＋带 `--proxy <现读到的系统代理端口>` 再跑一次，两次读数都记下来）。
  本机诊断顺序照旧：**代理端口拒连时先不带 `--proxy` 重发，再判网络全灭**；2026-10-13 晚新增的相反腿是
  「直连被 RST 而带代理＝200」⇒ 那一次的真答案是给 Edge 带 `--proxy-server`（见 §0），不是判网络全灭。
- 一次一面，一面一趟一份 L0（所以 A16 与 A1 分趟，见 §1）；`--filter-output` 或 `--token-limit` 必带（校验器会查这条）。
- 只用 stdout，摘录进仓库；**不落地任何第三方脚本、源码文本、HTML 正文或图像本体**（§2 那三条红线）。
- 节奏：先只跑 A1 一趟验证可达与可挂（这趟就按 §0 带上 `--allowed-origins`），若被挡就回来报告；
  确认拿到证据再跑 A2／A4×5／A16／A9／A15，最后跑四个交互面 A3／A5／A7／A8——
  它们各自单独一趟，每趟只放一个打开动作。

## 7. 预期产物

`docs/forensics/l0/` 下：`tv-a1-page.md`、`tv-a2-bundle.md`、`tv-a16-storage.md`、
`tv-a4-<selector>.md` × N（未命中的也各占一份，如实记 `not_found`）、
② `tv-a3-draw-menu.md`、`tv-a5-intervals.md`、`tv-a7-indicator-dialog.md`、`tv-a8-legend.md`、
② `tv-a9-axis-scale.md`、`tv-a15-pixel-baseline.md`（这两份的像素证据只有 `sha256`＋`bytes`＋`media_type`）、
③ `tv-a12-pine-editor.md`、`tv-a13-alert-dialog.md`（`状态：不可取证`）。
加 `docs/forensics/spec/` 下的条目表与 `docs/forensics/gap-matrix.md` 的行。

**用途这一格分两步填**：新落成的 TV 记录先写 `用途：基线`——孤证规则（`tools/forensics_audit.py` 里
「没被任何规格条目引用、又没标 `harness`／`基线`」就报）只豁免那两种用途，而批次 A 落成时
`docs/forensics/spec/` 里还没有引用它们的条目，直接写 `规格` 会把门判红。
T9 把它们逐条引用进条目表之后，再把 `用途：` 改成 `规格`——这一改是被引用逼出来的，不是放宽规则。
（`harness`／`基线` 里的 `harness` 是 P0 那三份探针记录的用途，批次 A 不用它。）
② 那四个交互面的条目**必须**引它们自己的记录（一趟一个 `evidence_id`），不许引 A1 那份凑数。

**留档里必须多一份 `<面>.cmd`，`evidence_id` 必须从留档第一行当场取**（2026-10-13 夜，控制器复核 A1／A16
两份记录时补的口径）。两处实测错：A1 的摘录与行号来自闸门放宽后的第二趟 `a1-full.txt`，主键却抄成了
被 `--token-limit` 切在半截的第一趟（`a1-truncated.txt` 的 `ev_2a7703ec…`）；A16 的主键
`ev_8e37f921…` 在 `rea-t10/` 目录里 **0 份留档命中**，而它的行号读数全部落在 `a16.txt` 上。
两处的根因同一个：**stdout 留了档，命令行没留**。于是写档的人只能凭记忆或终端回显去补 `命令：`
与主键，一补就补到别的趟上。往后的每一趟：

- 正式那一趟执行前，把**逐字命令行** `tee` 进 `$TEMP/rea-t10/<面>.cmd`（同一个面重跑就覆盖，
  被闸门切掉的失败趟另存 `<面>-truncated.cmd`，两趟的键不同，混用就是上面那个错）。
- 写 `evidence_id：` 之前先 `sed -n '1p' <该面的留档>`，把取到的那串**逐字**落进记录；
  摘录首行与 `- 证据：`／`- evidence_id：` 必须同值、同趟。
- 收口时跑一次机械核对：`grep -l '^evidence_id: ev_xxx$' <留档>` 要么命中要么别写这条记录。
  校验器只查主键的**形状**（`ev_<64 hex>`），查不出「键与摘录不同源」——这一层只能靠留档反查。

## 8. 批次 A → L1 规格条目表：本批落地的条数偏差与三类判据边界（2026-10-14 追加）

> 追加前的 HEAD：`528883bd`（`git rev-parse --short HEAD` 的当次读数）。本节**只追加在文件末尾**，
> §1–§7 的正文与其中的带日期更正块一个字未动。两表落点：`docs/forensics/spec/drawings.md`（7 条）、
> `docs/forensics/spec/chart-interaction.md`（8 条）。本节写的是「为什么是这个形状」，不是第三批的口径。

**(a) 条数偏差：本批为什么不是「每面 ≥20」**

- spec §7 那句「每面 ≥20 条」的基数是当时排定的六个面（A1–A6）。批次 A 真正落档的是 19 份记录，
  能喂给这两个规格面的只有 16 份：A3、A8、A16（画线与图元）＋ A1、A4（八枚单 selector 命令）、A5、A7（图表交互）
  ＋ A9、A15（像素）。
- 进不了表的，按形状分三类：`tv-a2-bundle.md` 是 bundle 侧的三枚 `call:n.get` 端点形状，不属这两个面，
  它保持 `- 用途：基线`；`probe-bundle.md`／`probe-events.md`／`probe-skeleton.md` 是 `- 用途：harness`；
  `tv-a12-pine-editor.md`／`tv-a13-alert-dialog.md` 是 `- 状态：不可取证`（原因逐字：需登录，按裁定 1 不做登录绕过；
  两份都写明「本席未执行这一条」）⇒ 没有 `evidence_id`、没有 stdout、没有逐字摘录。
- 于是本批不按「每面 ≥20」收，按 spec §12 的降级口径给下限：**两张表合计 ≥12 条**。实测 **15 条**（7＋8）。
  凑不满的那部分没编——被砍掉的候选连理由一起记在（c）。
- 门 1（`python -X utf8 tools/forensics_audit.py`）当前唯一的红就是这条口径差，原文（逐字，RC=1）：
  `有 15 条规格条目但 docs/forensics/gap-matrix.md 不存在`（`tools/forensics_audit.py:407` 那句模板）。
  缺口矩阵是 L2（T10）的产物，本批**不建**，也不许为了让门变绿去建。

**(b) 三类判据边界：本批证据形状导致的**

1. **像素面只能写指纹等值**。A9／A15 两趟的产出逐字只有 `captured_at`／`width`／`height`／
   `artifact` 下的 `sha256`＋`bytes`＋`media_type`（图像本体 `data_base64` 按批次清单 §2 的像素红线不入库），
   且 `compare`／`similarity` 这两次对比本批从未发生 ⇒ 判据形状只能到「同 target、同视口、同一条命令连跑两趟，
   两趟的 `sha256` 与 `bytes` 逐项相等」这一级（TV-DW-07）。写不成「像素差 < x%」「相似度 ≥ y」
   「同尺度族 ⇒ 像素全等」，也写不成期望常量：A9 与 A15 同命令同 target 同 746×483 视口、`captured_at` 相隔
   5.184 秒，字节分别是 225300 与 231704（差 6404）——这两份记录本身就是「常量不可期望」的证据。
2. **A4 面只能证明枚举面可用**。八枚 `inspect-web-event-listeners` 里七枚 `match: found`＋非空
   `backend_node_id`、一枚 `match: not_found`＋`backend_node_id: null`，而八份的 `listeners: []` **全为空读数**
   （连对照组 `body` 都空，见各记录的 limitations）⇒ 能立的只有「selector 写法命中／未命中可分，再加上未命中那一枚
   的记录散文自陈『命令成功』」（TV-CI-08）。此处原文作「rc 恒 0」，2026-10-14 修复轮按 M-5 收回：八份 A4 转录里
   数不出任何 rc／returncode 字段，而「命令成功」这句自陈只在 `tv-a4-rolemenu.md` 一份里数得出（＝2，其余七份各＝0），
   所以成功口径只到记录自陈级、不写成字段级常量。「空数组」不等于「无监听器」，而本面真正的核心问题「画线手势绑在哪个节点」**一份读数都没有**。
   另注：校验器不会替你挡这一步——`_resolve_l0` 只认落点，`l0/` 下的真文件都能被引用；把空手面写进表是
   **内容层**的空手（判据里没有可数的读数），门 1 查不出来，只能靠写句子的人自己守。
3. **A12、A13 是判据缺口，不是弱证据**。两份记录自己就写了这条边界（`- 本面在 L1 里的位置：判据缺口`），
   且 `tools/forensics_audit.py:27-30` 那段注释说明给不可取证记录编条目撞的是「写不出判据不算条目」。
   它们进 L2 时只能落成「本批次未取证，成因＝登录门前置＋裁定 1 不绕过」；也不许拿 A4 那枚 `[role="menu"]`
   的 `not_found` 去推「告警对话框不存在」（另一枚 selector、另一趟、另一主键）。

**(c) 被砍掉的候选句子与砍掉的理由（本批不立条目的，逐条）**

> 计数口径先写清（2026-10-14 修复轮补）：本节落地 **11 条 bullet**（复算：`sed -n '/^\*\*(c)/,/^\*\*(d)/p'
> docs/forensics/batch-A-playbook.md | grep -c '^- '`＝11），实现席报告 `.superpowers/sdd/2026-10-13-rea-
> forensics-p0-p1/task-9-report.md` §5 报的是 **12 条候选**。差的 1 条不是漏记：报告第 11 条「像素差 6404 字节
> ⇒ 验收阈值可定成 < N%」「同尺度族则像素全等」没落成 bullet，它写在上面（b）第 1 条里（逐字见那句「写不成
> 『像素差 < x%』『相似度 ≥ y』『同尺度族 ⇒ 像素全等』」）。另：报告第 1／4／9 条各自在一句里带两枚候选句
> （活树计数＋hasPopup 总数／Data window 表头＋切页消失／三键值＋visible 值），本节照同样写法各占一条 bullet
> ⇒ 「数 bullet」与「数候选句」是两个口径，台账从此分开写，不再拿其中一个当另一个。

- 「主工具栏有 6 枚工具条／96 枚按钮／20 个 CANVAS／4,232 个节点」「带 hasPopup 的按钮共 9 枚」——这些是
  `%TEMP%` 留档上的**活树计数**，仓内转录只切了分段；留档按记录自己的说法会随清理消失，三个月后数不出来。
- 「画线工具总共 17 件」——本批只点开了 `Trend tools` 一个目录；`tv-a3-draw-menu.md` 正文另列的
  `Fib retracement`／`Gann and Fibonacci tools`／`XABCD pattern`／`Patterns`／`Brush`／`Geometric shapes`／
  `Text`／`Annotation tools`／`Icon` 等目录没有各自的展开记录，写成总量是外推。
- 「图例每行显示 `OHLC4`／`Volume` 等字段、顺序是……」——A8 点开的是右侧 widget 面板而不是图例，
  图例行文本在 stdout 里是 `text:` 合串（红线不入库）。
- 「切到 `Data window` 页后表头是……」「切页后 `Object tree` 从树里消失」——都要第二次 click，
  §5① 的纪律是一趟一个打开动作。
- 「面板开关状态存在 localStorage 里」——§3③ 的带日期更正：四面场景 JSON 的 `storage` 段逐字是
  `"cookies":[],"local_storage":[],"session_storage":[]`＝未请求任何 storage 读数，载体**未读到**，
  只准写「上一趟留下的态活到了下一趟」这一现象（TV-CI-07 就是这么写的）。
- 「`--token-count` 那一趟把侧栏按钮真点了一次」——同一处更正标的是**强推断，不是读数**：count 趟的 stdout
  没留档，每份 count 文件只有 5 字节（只够放那个 token 数）⇒ 任何判据都不许依赖「count 趟执行了什么」。
- 「click 前后 URL 也没变」——四面的 s1 `before_url`／`after_url` 两块只在正文里给了留档行号，
  没进逐字转录；TV-CI-06 因此只断言「at_end 的 url ＝ 该趟 start_url 回声」。
- 「`[role="menu"]` 没命中，所以对方没有那个菜单」——静态页、未点按状态下的一趟读数，且 selector 写法导致的
  未命中没被排除（§4 的空手面先排除写法问题）。
- 「样式／周期／symbol 三个键里存的是……」「`ChartFavoriteDrawingToolbarWidget.visible` 的值是 true」——
  A16 是本批**唯一**一份键名级证据，那一趟自陈 `fingerprints_complete: false` 且 `values_redacted: true`，
  值一律没落；引用它必须带上这条限制（TV-DW-04／TV-DW-05 都带了）。
- 「有 searchbox ⇒ 指标可按关键字过滤」——本批未 `fill`，没有任何搜索行为读数。
- A12／A13 的任何句子——本席未执行，见（b）第 3 条。

**(d) 判据写法两型与两条口径**

- **仓内复算型**（本批**纯仓内复算 13 条**）：一条 `grep -c` 打在 `docs/forensics/l0/tv-*.md` 的逐字转录上，数出记录里
  已写明的那个数；不碰网络、不依赖 `%TEMP%`。另两条不按这一型计——**TV-DW-07 与 TV-CI-07 各是混合型**（一半仓内锚、
  一半本机重跑），2026-10-14 修复轮把原先那句「本批 14 条」收回：14 是把 TV-CI-07 按仓内那一半计了一次，
  而它的重跑半和 TV-DW-07 整条一样没在本批跑过。
- **本机重跑型**（本批 **2 条含本机重跑半**：TV-DW-07 全条、TV-CI-07 后一半；**两趟本批均未跑**——写条目的两席都是
  只读席、不起浏览器，执行落在 T10／T11 的门禁趟，「本席未跑」的标记写在两格的判据列里）：同一条命令在自家页连跑两趟，
  断言的是**两趟读数之间的等值关系**，不声明任何跨现场可复现的常量。
- **表里不许出现 shell 管道，也不许出现带竖线的正则**：`tools/forensics_audit.py` 的 `_table()` 按 `|` 切列，判据里一个
  管道就把五行表的一行切成 6 格，报的是「列数不是 5」（2026-10-14 修复轮实测：本席把一条 `grep -rn 'A\|B'` 写进
  TV-CI-08 那一格，门 1 立刻报「有 1 行的列数不是 5」＋条目数掉成 14，改回不带竖线的写法后复原）。
  判据的锚定形状**不是**「全部整行锚定」——那是上一版台账写成的全称，为假。按下面三条命令在两张表上当场提取复算：
  ```bash
  grep -hoE "grep -c '[^']*'" docs/forensics/spec/drawings.md docs/forensics/spec/chart-interaction.md \
    | sed "s/^grep -c '//;s/'$//" > /tmp/pats.txt
  wc -l < /tmp/pats.txt          # 62（本修复轮落定后的读数；上一版两张表＝42）
  grep -c '^\^' /tmp/pats.txt    # 42（上一版＝33）
  grep -v '^\^' /tmp/pats.txt | wc -l   # 20（上一版＝9）
  ```
  ⇒ 本修复轮的两张表：**62 条提取到的 `grep -c` 里 42 条以 `^` 整行锚定，其余 20 条数属性串／同名串**
  （例 `[selected]`、`"name":"1 day"`、`"Ticks" \[expanded\] \[level=1\]`、`命令成功`），它们同样不带管道；
  上一版（提交 `4a5aceb6`）同口径读数是 42 条／33 锚定／9 属性串，控制席与评审席各跑过一遍，本处按修复轮当场数改写。
  另有两条 glob 型（`tv-a4-*.md` 那两条）与一条四面并列的 url 计数不在上面正则的 `＝N` 抓取形状内，逐条手跑：
  `grep -c '^    match: found' docs/forensics/l0/tv-a4-*.md` 七份各＝1、`tv-a4-rolemenu.md`＝0；
  `grep -c '^  listeners: \[\]' docs/forensics/l0/tv-a4-*.md` 八份各＝1；四面 url 计数各＝2。
  锚定同时把正文里的散文重复排除在计数外。
- **行数口径**沿用 §2②：「共 N 行」＝围栏自身行数（含容器行）。条目格里只数**条目行**，不复述围栏自身行数；
  要复算围栏自身行数的那两条 `awk` 管道留在各记录自己的复算段里（形状基准 `tv-a3-draw-menu.md`）。
- **L0 用途回标**：16 份被引用的记录 `- 用途：` 由 `基线` 改为 `规格`——`tv-a1-page`、`tv-a3-draw-menu`、
  八份 `tv-a4-*`、`tv-a5-intervals`、`tv-a7-indicator-dialog`、`tv-a8-legend`、`tv-a9-axis-scale`、
  `tv-a15-pixel-baseline`、`tv-a16-storage`；`tv-a2-bundle.md` 保持 `基线`（两张表都没引用它）；
  A12／A13 无 `- 用途：` 键（不可取证），不回标。每份都只改了那一行，摘录一个字节没动。
