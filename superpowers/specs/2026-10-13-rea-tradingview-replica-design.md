# 用 REA 取证驱动的 TradingView 复刻 — 设计文档

**日期**：2026-10-13　**底座**：`morluto/rea`（npm 包 `rea-agents`，MIT）　**实现期分支**：届时新建 `feat/rea-tv-replica`（本设计文档暂落在当前分支，不动工作树里那份在途改动）

---

## 0. 白话版（先说清我们在干什么）

TradingView 的界面不能直接搬——它的代码是它的财产。但**它界面上每一个按钮点下去会发生什么**，是可以看的。

REA 这个工具专门干「看」这件事：它挂到一个真实浏览器的调试端口上，把页面加载了哪些脚本、脚本里请求了哪些地址、某个元素上挂了哪些事件监听器、屏幕当前长什么样，变成一份份带编号的结构化「证据」。

所以这份计划的骨架是：

> **REA 负责取证 → 证据变成规格条目 → 规格条目和本仓现状对账 → 缺口一片一片自己实现 → 每片过本仓既有的门禁。**

实现面（代码）100% 我们自己写。REA 不生成代码，它生成证据；证据只回答「应该是什么样」。

## 1. 范围裁定：这份文档是什么、不是什么

| 是 | 不是 |
|---|---|
| 用 REA 的**观察面**产出 TradingView 的行为规格 | 不是把 `rea-agents` 加进项目依赖（它只在开发期用，运行时零依赖，不进 `package.json`） |
| 复刻**交互与视觉行为** | 不是抓 TradingView 的数据：行情链路仍是本仓自己的（akshare／新浪／腾讯＋后端对齐逻辑），TV 的私有端点一个都不接 |
| 在本仓 `frontend/` 上增量补齐 | 不是新建一个独立前端项目（见 §3 裁定 2） |
| 沿用本仓六片式的验收纪律（六道门＋活体＋未来函数自查） | 不是「能跑就行」的原型；每条规格都要落成可执行判据 |

明确**不复刻**（架构性不可达，写下来是为了以后不再反复讨论）：TradingView 账号体系的云同步、社区／帖子／想法流、指标商店的远端目录与后端、服务端 screener、broker 直连下单、专有行情（含交易所深度／逐笔）。这些不是「还没做」，是「不在复刻范围内」。

---

## 2. 底座事实（2026-10-13 在本机现读，不是抄 README）

这一节是整份计划的地基，所以每条都是今天在这台机器上跑出来的，附读数。

### 2.1 版本与 Node 门槛

```
npx -y rea-agents@latest --version     # rea@6.4.0
engines: { node: "^22.19.0 || ^24.11.0 || >=26.0.0" }
node -v                                # v22.16.0  ← 低于要求
which node                              # /c/Program Files/nodejs/node
npm -v                                  # 10.9.2
```

`npx -y rea-agents@latest doctor` 的实测判决：`healthy: false`，八条 scope_checks 里唯一卡我们的是

```
- name: node
  ok: false
  classification: missing_dependency
  detail: 22.16.0
  remediation: "Install Node.js 22.x (>=22.19), 24.x (>=24.11), or 26+."
```

其余 `ok: false` 的都是 hopper／ghidra／ida（原生二进制逆向引擎，Web 面用不到）和 `skill:identity`／`registration:codex`／`registration:vscode`（这些报红的含义只是「你没跑过 `rea setup`」，是我们**故意**不跑，见 §3 裁定 3）。

**实测结论**：Node 22.16 下 `npx` 只发 `EBADENGINE` 警告，REA 的 **Web 取证命令照样跑通并返回 rc=0**（见 2.3）。所以「Node 版本不够」目前**不是**拦路石；`doctor` 报不健康 ≠ 命令不可用。但它是后续遇到怪问题时第一个要排除的变量。

### 2.2 浏览器依赖：只有 Edge，且有一个坑

本机无 Chrome／Chromium，可用的是 Edge 155：

```
C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe
```

REA 的整个 Web 面靠 **loopback CDP**（Chrome DevTools Protocol 调试端口）。实测有效的启动配方：

```bash
"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  --headless=new --remote-debugging-port=9222 \
  --user-data-dir="$TEMP/rea-cdp-profile" \
  --disable-extensions --disable-sync --no-first-run --no-default-browser-check \
  "http://目标地址/"
```

坑（今天踩到的）：**不能靠 CDP 的 `PUT /json/new?url=` 开新标签**——Edge 155 接受请求并回了一个 target id，但目标页停在 `about:blank`，URL 没生效。所以要让 REA 分析某个页面，就把该 URL 作为**命令行参数**交给 Edge 起进程。

挂上之后的读数：

```bash
npx -y rea-agents@latest list-browser-targets http://127.0.0.1:9222
#   browser.product: Edg/155.0.4283.45   protocol_version: "1.3"   js_version: 15.5.9.4
#   targets: []          ← 当时只有 edge:// 与扩展页
#   excluded: { unsupported_url: 2, non_page: 1 }
#   evidence_id: ev_d4bfa2c2e732e929622e0770a4ca9785b53552baadf63436b5c0d4778e522a18
```

`excluded` 那两个计数是**好的设计**而不是故障：REA 只列 HTTP(S) 页面，`edge://`／`chrome-extension://` 天生不进取证范围。

参数写法上还有一个实测点：`--allowed-origins` 要**裸值**，不接受 JSON 数组字面量。

```bash
--allowed-origins http://127.0.0.1:8077     # 通
--allowed-origins '["http://127.0.0.1:8077"]'  # 拒：invalid_request / invalid_input
```

### 2.3 主链跑通的证据（对本地中立页面，不碰任何第三方站点）

为了不给计划留虚构前提，今天在自己机器上起了一个静态服务（`python -m http.server 8077`）托管三文件小页面（HTML 引一个 ES module，模块里 `fetch("/data.json")` 并定义一个 `class ChartEngine`），然后跑：

```bash
npx -y rea-agents@latest analyze-web-bundle http://127.0.0.1:9222 <targetId> --observation-ms 1500
```

读数（逐键）：

```
capture:  scripts_observed: 1   scripts_analyzed: 1
          source_artifacts[1]: sha256=7b49ff45ee5269e8367a7e00a428f0295f23593a3072c35302fd0c5cefef37c3, bytes=312
observations.chunks.nodes[1]: url="http://127.0.0.1:8077/app.js"
observations.endpoints[1]:  value=/data.json   mechanism="call:fetch"   location={line:4, column:0}
completeness: status=complete  parsed_scripts=1  parse_failures=0  visited_ast_nodes=83
confidence: observed    authority: external-service
evidence_id: ev_f9cdf315400d660c50e11abc8c7d14b9ccd1665416e45b0c8e63f5dbd8ee90aa
```

这就是本计划的**核心能力证明**：一条命令，页面加载的脚本、脚本的字节指纹、脚本里发起的请求地址连同它在源码里的行列位置，全部变成带 `evidence_id` 的结构化证据。把目标从「我的小页面」换成「TradingView 的图表页」，同一套动作就能把它的脚本面、端点面、路由面摸出来。

另外两个可用读数（同一趟）：`inspect-web-page` 产出的 JSON Evidence 载荷 7,617 字符，`evidence_id: ev_7a22c91623c1836abe9ab851fe57c7f707eb3bd8833bda1a4b5254a344e358fc`。

### 2.4 本机不可用的两条路（这条最重要，决定架构）

今天撞到、且**换目录／换卷／换旗标都试过了**的两个失效：

**① REA 读不了任何本地文件。** 所有「吃一个磁盘路径」的命令都报 `ESTALE`：

```
rea inspect-evidence-bundle  <刚写出的 json>  → "The JSON input file could not be read (ESTALE)"
rea export-web-scripts       <capture json> <outdir> → "Selected capture could not be read (ESTALE)"
```

不是路径问题（TEMP 不是 junction：`islink: False`，`realpath` 与 `normpath` 相同），不是卷问题（C: 与 E: 都试了），不是等待时间问题（sleep 3 再犯同样错）。

**② `analyze-javascript-application`（本地目录／JS 应用静态重建）在本机确定性失败。**

```
error: JavaScript application analysis failed
code: artifact_operation_failed   category: integrity_mismatch
detail: "Directory entry changed before open: a.js"
```

分三步隔离过：喂本仓 `frontend/src/lib` → 报 `lib/alertsApi.ts`；把它**整份复制到 TEMP 干净目录** → 照样报同一文件；只复制 LF 行尾的文件（排除 CRLF 干扰）→ 照样报；最后喂一个**我自己刚创建的两文件小程序**（`a.js`＋`b.js`，外加一份 `package.json`）→ 报 `Directory entry changed before open: a.js`，即永远在**清单里的第一个文件**上翻车。REA 自己给的解法 `--integrity-policy record-and-continue` **不生效**（该策略显然在完整性预检之后才起作用）。

**这两条合起来的架构含义**（写死，别绕）：

- 证据的**产生**只能走 CDP 单趟命令（`analyze-web-bundle` / `inspect-web-page` / `inspect-web-event-listeners` / `capture-web-screenshot` / `observe-web-execution` …），一条命令一个观察面，读数直接从 stdout 取。
- 证据的**留存**不能指望 REA 的文件通道（`export-web-scripts`、`evidence-export`、`inspect-evidence-bundle` 全部落盘不可用）。所以由**我**把 stdout 的 Evidence 关键块逐字摘进仓库内的 markdown 规格，并保留 `evidence_id`＋`sha256`＋命令＋观察时间，作为可回溯凭据。
- 需要「把对方脚本落到磁盘再慢慢读」的深挖（`export-web-scripts` → `analyze-javascript-application` → `recover-javascript-sources`）在本机**当前不可用**。若要做，得先解决环境（把 Node 升到 ≥22.19 是最可能的解药，但那是项目外动作 ⇒ §9 需你批准项）。
- 内联 JSON 参数是通的：`rea build-reconstruction-obligation-ledger '{"obligations":[]}'` 走到了 schema 校验并回报缺哪三个键（`evidence_bundle`(object)／`reviewed_obligations`(array)／`manifest`(object)），说明「小载荷走 argv」可行；Windows 的命令行上限约 32,767 字符，所以这条只对**小** Evidence 成立。

#### 2.4.1 带日期追加（2026-10-13 晚，P0 收口后实测）：上面那句「小载荷走 argv」把一条更大的门打开了

本节的架构结论（证据只走 CDP 单趟命令＋stdout 摘录）**不变**；被否证的是一条**操作性推论**——
「要在页面上先做一次交互（点开工具条／下拉／对话框）才能看到的面，本机拿不到」。
现读留档（`$TEMP/rea-t8-*.txt`，本机自家探针页 `http://127.0.0.1:8077/`，未碰任何第三方站点）：

- `capture-browser-scenario` 的入参 `inputJson` 帮助原文是 **"Inline browser scenario JSON or JSON file path"** ⇒ 可以**只给内联 JSON**，不碰文件通道；
  `browser.mode: connect` 只需 `cdp_endpoint`＋`target_id`（**不需要 `executable_path`**，那才是会 ESTALE 的 `launch` 模式）。
  于是「交互 → 复捕」在一趟里就成立：`evidence_id ev_497acbd544027225a276811991e53b64a137cda560f206a7de51d6a10687572a`，
  `rc=0`，留档 `steps[3]` 的三步（`goto_start`／`s1 click #probe-chart`／`s2 wait_for_timeout`）**全部** `status: completed`、`error: null`
  （**2026-10-13 晚订正**：本行原先写成 `steps[1]{step_id: s1, …}`——TOON 的 `[n]` 是**条数**不是下标，而那一步的 `completed`
  一度是从另一份留档 `rea-t7/scenario-run2.txt` 的第 0 步 `goto_start` 误读过来的。同一动作在命中 3 个元素的
  `#toolbar button` 上其实是 `status: failed`＋`strict mode violation`，紧随的 `s2` 变 `cancelled`；
  「管道可用」与「一次点击成功落地」是两件事，支撑后者的只有换成单元素 selector 的这一次），
  `browser{mode: connect, process_ownership: external, cleanup: disconnected-external, product: Chromium, version: 155.0.4283.45}`。
- `capture.at_end` 是**枚举数组**，值域现读为 6 个：`screenshot,dom,accessibility,url,history,storage`
  （写本节初稿时只列了当次用到的 4 个，那是样本不是值域——2026-10-13 晚用非法值逼出 `expected[6]` 才补齐）。
  点完直接拿到改后的可达树：`accessibility.value.text` 逐字给出 `- button "Trend line"` 这一族 `role`＋`name`（`bytes: 136`），
  与 §5 里 A1 需要 `--include-accessibility-text` 才有的读数面同形 ⇒ **A3／A5／A7／A8 这类「未点开就不在可达文本里」的面从此有判据级证据**，
  §7 P1 那条「懒加载／虚拟 DOM」风险降级为「先跑一步 click，再读同趟工件」。
- 同法逼出的另外三张词表（都是 `code: invalid_request`／`details.issues[]` 里的 `expected[n]`，且 schema 校验跑在连浏览器**之前**，
  所以这类探针不需要起现场）：`action` 9 值 `goto,click,fill,press,select_option,check,uncheck,wait_for,wait_for_timeout`
  （**没有右键** ⇒ A6 仍然没有驱动手段）；`locator.kind` 3 值 `test_id,role,css`；`kind: role` 下 `role` 14 值
  `button,checkbox,combobox,dialog,link,listbox,menuitem,option,radio,slider,spinbutton,switch,tab,textbox`。
  ⇒ `role`＋`name` 定位是**合规上更好**的那一把：它不需要把对方的 class 命名抄进 L0，而它给的正是判据要引用的语义。
- 像素面同样可用：`at_end: ["screenshot"]` ⇒ `value{sha256, bytes, media_type: image/png, data_base64}`。
  **硬红线**：`data_base64` 绝不准进仓库（它是图像资产本体，撞裁定 1 的表达层那条），L0 里像素证据只落 `sha256`＋`bytes`＋`media_type`。
- **同样要红线的是 `dom`**（本条与上一条同批补上）：实测 `dom.value.text` 就是**整段页面 HTML 正文**
  （探针页那趟 `bytes: 475`，逐字含 `<!DOCTYPE html>` 与页面里的每个标签）。自家页面无害，
  对 `tradingview.com` 跑同一条命令带回来的就是**对方的标记正文**——裁定 1 第 1 条点名的正是「表达层／CSS／标记」。
  ⇒ 交互复捕默认只取 `accessibility`（与 A1 那把旗标同形）；`dom` 允许跑，但 L0 里最多落 `state`＋`sha256`＋`bytes`。
- 四条限制，别当成万能：① `--filter-output` 的**下标键路径不生效**（`normalized_result.steps[1].artifacts.screenshot` 返 `steps: []` 且 `rc=0` ⇒ 静默空，只能整份落盘再本地切；帮助自己的示例写的是 `a[0,3]` 那种形状，**未验证**）；
  ② 该 provider 自己的 `limitations` 里有「CDP attachment cannot recover pre-attach events」，所以**attach 之前**发生的事件仍然取不到，
  「没报」不等于「没有」（§2.4 的原意在这一条上依然成立）；
  ③ Playwright **strict mode**：selector 命中多个元素时该步 `status: failed` 并逐字枚举候选，紧随的步骤变 `cancelled`
  （留档 `rea-t7/scenario-run2.txt`，7,025 字节，顶层 `missing_sections[3]: action,events,url`）⇒ 一趟只放一个打开动作、定位必须收到单元素；
  ④ **不存在的 `role`／`name` 不快速失败，而是把整趟挂住**（实测两分钟零产出后中止，留档停在 0 字节）
  ⇒ 别把「探个名字在不在」的 miss 探针和真动作放同一趟。
- 需要**登录**才能看到的面（指标模板云同步、多布局保存等）与一切吃磁盘路径的命令（`export-web-scripts`／`inspect-evidence-bundle`／`compare-web-captures`）
  **不受本次实测影响**，仍是不可用。

### 2.5 输出控制（内存只有 2GB，且证据会很大）

REA 的全局旗标里，本计划会常态使用的四个：

```
--format <toon|json|yaml|md|jsonl>   # 人读用 toon（默认），机读用 json
--token-limit <n>                    # 截载荷（注意：错误信息也会被截，排障时先别加）
--filter-output <keys>               # 只取要的键路径，如 normalized_result.endpoints
--token-count                        # 先量大小再决定要不要读
```

TradingView 的 bundle 是 MB 级的，**绝不允许**整包 dump 进会话；所有取证的命令模板都必须带 `--filter-output` 或 `--token-limit`。

---

## 3. 三条前置裁定

按长期授权（「写好规划后全程按推荐进行推进」）我先按推荐值钉死；任何一条你一句话就能推翻，推翻后本文件相应节要改。

### 裁定 1 — 合规边界（这是硬约束，不是建议）

REA 自己的免责声明（README 原文）：

> "REA is for lawful research, education, interoperability, software preservation, and analysis of software you own or are authorized to examine."

由此定三条硬线：

1. **产出只能是「规格＋证据」。** 不拷贝 TradingView 的源码、图标、字体、配色表、CSS、以及任何**表达层**内容。UI 文案自己写（比如 TV 叫 "Crosshair"，我们叫「十字光标」，不逐字搬它的多语言包）。工具名、面板结构、交互结果属于**功能与行为**，可以复刻；表达与资产属于**版权财产**，不碰。
2. **实现必须从规格出发，不引用任何 TV 代码。** 每片实现走 TDD：先按规格写失败测试，再写实现。允许参考的第三方源码仅限已有开源依赖（klinecharts v10）与本仓自有代码。
3. **TradingView 的接口不作为运行时依赖。** 观察阶段会看到 TV 的请求地址（就像 2.3 里看到 `/data.json`），这些地址**只作为「它有这样的数据需求」的证据**记录进规格，绝不写进本仓任何请求代码。数据一律来自本仓自有链路。

补充自我约束：观察对象是公开页面的公开产物，不做登录绕过、不碰付费墙、不做反爬规避（不伪装 UA、不改指纹、不打重试风暴）；一次一个观察面，间隔人工节奏；若站点出现「请勿自动化访问」的信号（验证码／429／前端反调试），**停手并把该观察面标为不可取证**，而不是想办法绕过。

### 裁定 2 — 目标形态：本仓 `frontend/` 增量，不是独立新项目

理由（按强度排）：

1. 本仓的图表面**已经是**一套完整的 TradingView 等价实现的一部分：`pages/ProChart.tsx`（3,257 行）、19 个内置副图指标（`lib/subIndicators.ts`，实测条目数 19）、13 件画线工具（`lib/chartDrawings.ts:131`）、自研 Pine 引擎（`lib/pine*.ts`，含 `request.security` 多周期）、Bar Replay、四视图、VPVR、Heikin-Ashi、多标的叠加对比、画线导出／导入／分享码。另起炉灶＝把这六片的交付作废。
2. 本仓早就为这件事留了判词。`pages/TVChart.tsx:8-13` 原文：
   > "Phase-C trial page: embed TradingView's free Advanced Chart widget. Purpose is ONLY to validate the "pro chart" interaction (drawing tools, indicators, multi-timeframe) before we invest in the KLineChart build-out. NOTE: the widget loads data from TradingView's public servers; anything typed into it is visible to TradingView, and private/backtest data cannot be displayed here."
   
   也就是说：**「验证完交互就切回自研开源图表」是本项目既定的路线**，本计划是这条路线的自然下一步——把「靠人肉点 widget 验证」升级成「靠 REA 系统化取证」。
3. 交付纪律在本仓是现成的（六道门＋活体取证＋档案落档），新项目要重建这套护栏。

被否方案与代价：**(a) 独立新 repo** — 丢弃既有六片、要重搭门禁与 i18n 九语言面，唯一好处是干净，不值。**(b) 继续用 TV widget 凑** — 违背上面那段注释自己的判词，且 widget 无法显示我们的私密／回测数据，功能天花板死。

### 裁定 3 — 不产生项目外副作用

本仓纪律是「改动严格限定在项目范围内」，REA 恰好有几种会碰全局的姿势，全部**不用**：

| 动作 | 用不用 | 原因 |
|---|---|---|
| `npx -y rea-agents@latest <cmd>` | ✅ 唯一入口 | 一次性，不写项目外配置（npm 缓存除外） |
| `rea setup` | ❌ | 会往 agent 配置里注册 MCP server、写工作流说明、还会装 Hopper |
| `rea mcp add` / `rea install` | ❌ | 改全局配置 |
| `npm install --global rea-agents` | ❌ | 动全局 Node 工具链 |
| `rea update` | ❌ | 自升级＝不可审的变更面 |
| 升 Node 到 ≥22.19、加杀软白名单 | ⏸ 需要时先问 | 都是项目外动作 |

取证产物只落仓库内：`forensics/`（规格与证据摘录）。浏览器 profile 落 `$TEMP`，用完删。

---

## 4. 方法论：五级漏斗

```
L0 观察  → L1 规格  → L2 差距  → L3 分片实现  → L4 验收
   ↑________________________________________________|___ L4 判据回打 L1（规格不可验证 ⇒ 退回重写）
```

| 级 | 输入 | 动作 | 工件 | 完成判据 |
|---|---|---|---|---|
| **L0 观察** | 目标页面＋CDP 端口 | 一条 REA 命令一个面（§5 工单） | 命令原文＋stdout 的 Evidence 关键块（含 `evidence_id`、`sha256`、观察时间、浏览器版本） | 该面的证据**非空且完整度达标**（`completeness.status` 可读；`parse_failures` 有值就要解释） |
| **L1 规格** | L0 证据 | 把证据翻成条目：`TV-<面>-<序>` | `forensics/spec/<面>.md` 的条目表 | **每条条目自带一个可执行判据**（DOM 断言／状态断言／像素断言三选一）。写不出判据的条目不算条目 |
| **L2 差距** | L1 规格＋§6 现状基线 | 三态对账：`已有`／`部分`／`缺`（＋`不可复刻`） | 差距矩阵（一条规格一行，带本仓 `file:line` 或「未找到＋搜过的 needle」 | 每个 `已有` 都要能指到代码坐标；每个 `未找到` 的 needle 要能复跑 |
| **L3 分片** | L2 里挑一条/一簇 | 走本仓六片式：spec → plan → TDD → 门禁 → 活体 → 档案 | 一片一个可验收表面 | 六道门全绿＋活体读数＋变异自证（摘掉机制必须有针变红） |
| **L4 验收** | 一片的产物 | 门禁＋活体＋未来函数自查＋证据回溯检查 | 档案一节（`项目档案.md`，一轮一节） | 「规格条目 X ⇒ 实现 Y ⇒ 判据 Z 已通过」三段可指认 |

**纪律的一条红线**：L1 的规格条目**不许**写成「TV 有一个工具栏」这种描述。要写成「工具栏里有 13 类画线工具，其中斐波那契需要两点确定垂直范围、拖动中点可整体平移，属性面板可改线宽与透明度」这种**可拿测试打的**句子。

> **2026-10-13 更正（工件落位）**：本节表格里 L1 的工件原先写作 `forensics/tv-<面>-spec.md`（平铺），P1 那节原先写作 `tv-drawings-spec.md`。
> 现统一为**按层分目录**：`forensics/l0/<面>.md`／`forensics/spec/<面>.md`／`forensics/gap-matrix.md`，模板放 `forensics/_templates/`。
> 为什么改：校验器 `tools/forensics_audit.py` 要按目录区分三层工件（平铺时 `gap-matrix.md` 会被 `tv-*-spec.md` 的 glob 误纳，
> 而「按精确文件名豁免样例件 `_example.md`」这条规则也需要一个确定的所在目录）；分片计划 P0/P1 的文件布局表与已落地的判据都按分目录写。
> 这一改动不动漏斗的语义，只动路径。判据仍以「每条规格自带一个可执行判据」为准。

## 5. 取证工单（playbook：15 个观察面 × 命令 × 期望字段）

统一前置（每个批次开头跑一次）：

```bash
npx -y rea-agents@latest doctor                       # 记下 node detail
"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new \
  --remote-debugging-port=9222 --user-data-dir="$TEMP/rea-cdp-profile" \
  --disable-extensions --disable-sync --no-first-run --no-default-browser-check "<目标页 URL>"
npx -y rea-agents@latest list-browser-targets http://127.0.0.1:9222   # 取 targetId
```

| # | 观察面 | 命令 | 要取的字段 / 期望产出 |
|---|---|---|---|
| A1 | 页面骨架与可达文本 | `rea inspect-web-page http://127.0.0.1:9222 <tid> --filter-output normalized_result` | 面板分区、按钮清单（规格：工具栏到底有几组） |
| A2 | 脚本与端点面 | `rea analyze-web-bundle http://127.0.0.1:9222 <tid> --observation-ms 1500 --filter-output normalized_result.observations` | `endpoints[]`（有哪些数据需求）／`chunks.edges`（模块图）／`routes` |
| A3 | 画线工具目录 | `rea inspect-web-page … --filter-output normalized_result` ＋ 手动展开绘图工具条后复捕 | 工具**类别数与语义**（不是图标形状）；对账本仓 13 件 |
| A4 | 元素事件面 | `rea inspect-web-event-listeners http://127.0.0.1:9222 <tid> "<css selector>"` | 该元素挂了哪几类原生监听器＋源码位置 ⇒ 回答「TV 这里用的是 pointerdown 还是 click」 |
| A5 | 周期与分辨率菜单 | A1＋A4 在点开下拉后复捕 | 支持的周期档位全集；对账本仓 8 档 |
| A6 | 右键上下文菜单 | A4 落在 canvas 上的 selector | 菜单项清单 ⇒ 本仓缺哪些项 |
| A7 | 指标对话框＋样式页 | A1 在打开对话框后复捕 | 指标搜索／参数／样式三个页的字段清单 |
| A8 | 图例／数据窗口（值表） | A1＋`capture-web-screenshot` | 图例每行显示哪几个字段、顺序如何 |
| A9 | 刻度与轴 | `capture-web-screenshot` ＋ `compare-web-screenshots` | 价格轴／时间轴刻度密度、对数轴入口 |
| A10 | 自选列表 | A1 | 行内字段（最后价／涨跌／改名／拖序），对账本仓 `WatchList.tsx`（当前**手动刷新不轮询**） |
| A11 | 多布局与模板 | A1 | 「新建布局／模板」可选项 ⇒ 本仓**未找到**（见 §6） |
| A12 | Pine 编辑器与输出窗格 | A1＋A4 | 编辑器有哪些按钮／错误提示形态；输出窗格 tab 清单 |
| A13 | 告警对话框 | A1 | 触发条件可组合的维度；对账 `lib/pineAlertRules.ts` 的 native/refused 边界 |
| A14 | 快捷键 | `observe-web-session http://127.0.0.1:9222 <tid>`（人工按键一段） | 键盘可达路径清单 |
| A15 | 像素基线 | `capture-web-screenshot http://127.0.0.1:9222 <tid>` ＋ `compare-web-screenshots <a.json> <b.json>` | 版面比例（不是配色复制），供「像不像」有客观读数 |

工单使用规则：

- **一次一面**，一面一份 L0 记录。混面捕的证据在 L1 里拆不干净。
- `observe-web-execution` 会 **reset 计数器并临时关掉优化**（它自己的 limitations 里写了），所以用它取到的读数必须在规格里标注「观察时已禁用优化」——这会让 TV 的动画与节流行为偏离真实用户所见。
- `discover-webmcp-tools` 今天顺手可跑，但它声明的是**页面自报**的工具，REA 自己也标注「untrusted，never registered or invoked as an REA tool」⇒ 只能当线索，不进规格。
- 版本漂移：`compare-web-captures <beforeJson> <afterJson>` 用来在 TV 改版后指出「规格哪几条的依据变了」。注意这两个入参是**文件路径**，本机受 §2.4 的 `ESTALE` 限制 ⇒ 漂移监测作为「环境修复后才启用」的能力，短期改用「同一 selector 重捕＋人工 diff 摘要」。

## 6. 现状基线（本仓今天有什么——差距矩阵的右半边）

下面每一条都是本设计轮**自己核过**的（子代理给的坐标有出入时以我复测为准）：

| TradingView 概念 | 本仓现状 | 坐标／证据 |
|---|---|---|
| 主力图表页 | 有，klinecharts v10 | `frontend/src/pages/ProChart.tsx`（3,257 行） |
| 副图指标目录 | 有 19 个内置 | `frontend/src/lib/subIndicators.ts`（`BUILTIN_SUB_INDICATORS` 实测 19 条） |
| 画线工具 | 有 13 件（趋势线／射线／线段／水平线／价格线／斐波／画笔／垂直线／水平线段／水平射线／平行线／价格通道／标注） | `frontend/src/lib/chartDrawings.ts:131`（`DRAW_TOOLS`） |
| 自定义脚本（Pine＋向量公式） | 有，货架 32 条内置模板＋用户脚本 | `frontend/src/lib/scriptLibrary.ts`（`id: "lib-…"` 实测 32 条）、`lib/indicatorStore.ts` |
| 多周期取数（MTF） | 有（`request.security`／`security_lower_tf`） | Pine 运行时侧 |
| 逐根回放 | 有 | `frontend/src/lib/barReplay.ts` |
| 多格视图 | 有 2×2 四视图，每格可挂内置副图或脚本 | `pages/MultiChart.tsx`、`components/charts/ChartCell.tsx` |
| 显示层变换 | Heikin-Ashi、VPVR、多标的叠加对比 | `lib/heikinAshiChart.ts`／`lib/vpvrChart.ts`／`lib/symbolCompareChart.ts` |
| 自选列表 | 有，**手动刷新不轮询**。逐字（该句在注释里跨两行折行，上半在 9、下半在 10）：「rows refresh on mount, on list change, and via the manual button — no ／ polling, to keep upstream data sources gentle.」 | `components/charts/WatchList.tsx:7-10` |
| 画线／脚本交换 | 有（分享码 `?d=`／`s=`） | `lib/drawingExchange.ts`／`lib/scriptExchange.ts` |
| 提醒 | 有（4 类 kind，Pine 告警桥 native/refused 两态） | `pages/Alerts.tsx`、`lib/pineAlertRules.ts` |
| 选股器 | 有（本地规则式） | `lib/screener.ts` |
| 页面 | 18 个 | `frontend/src/pages/*.tsx` 实测 18 |

**候选缺口**（子代理报「未找到」，我在 §5 工单里把它们挂到了对应观察面，实现前会逐条自己复跑 needle）：图表布局模板／多套 saved layout；图表实时流刷新（与自选「不轮询」是同一条取舍，需要裁定）；深度图／足迹／逐笔；市场热力图；财经日历；账号级云同步与社区（⇒ 已判为不可复刻）。

## 7. 路线图（P0–P6，一片一阶段，可中断可续）

### P0　取证骨架（1 轮）
- **做什么**：建 `forensics/`；定三份模板——`_l0-capture.md`（命令原文＋stdout 摘录＋`evidence_id`＋时间＋浏览器版本）、`_spec-entry.md`（条目号／句子／判据／对应 L0）、`_gap-matrix.md`（三态＋本仓坐标）；在仓库内**只加文档模板**，不加依赖。
- **判据**：对本地中立页（`python -m http.server` 起的小页面）走完 A1＋A2 并产出 1 条能被测试打的规格条目。这一步同时是 §2.4 结论的复验。
- **停止条件**：若 A1/A2 出现 §2.4 那类环境拒绝，就地记为「需环境修复」，不往下堆。

### P1　TV 观察批次 A：画线＋图表交互（1–2 轮）
- 工单 A1–A6。产出 `forensics/spec/drawings.md`、`forensics/spec/chart-interaction.md`（以及它们各自引用的 `forensics/l0/tv-*.md`）。
- 判据：规格条目 ≥20 且每条带判据；每条 L0 有 `evidence_id`。
- 风险：工具条是懒加载／虚拟 DOM，未点开就不在可达文本里 ⇒ 用 A4 的事件面交叉确认，不靠「看到就算」。

### P2　我方能力图（对称取证，1 轮）
- 原计划用 `analyze-javascript-application` 分析本仓源码 ⇒ **本机该路径不可用（§2.4）**。改为**对称法**：把 `http://localhost:5899/pro-chart`（我们自己的 dev server）当目标，跑与 P1 **完全相同**的命令集，得到我方页面的 bundle 结构与事件面。两边同命令 ⇒ 差异才有意义。
- 判据：同一 selector 上，TV 侧与本仓侧的事件类别能并排成表。

### P3　对账与优先级（1 轮）
- 产出差距矩阵：每条规格一行 → `已有`／`部分`／`缺`／`不可复刻`，各带证据坐标。
- 优先级函数（钉死，避免以后每次争论）：`优先级 = 用户可感知度 × 判据可自动化度 ÷ 触碰库私有面的深度`。分「需动 klinecharts 私有属性」的一律降级（本仓六片的经验：私有面改动是回归主源）。
- `build-reconstruction-obligation-ledger` 只在载荷能塞进 argv（约 32k 字符）时用；否则手写矩阵，不硬凑工具。

### P4　第一个实现片（2–4 轮）
- 从 P3 的 `缺` 里挑**最小可验收**的一条开片，走完整六片式：本仓 spec → 实现计划 → TDD（先红）→ 六道门 → 活体取证 → 变异自证 → 档案落档一节。
- 候选（按当前判断，最终以 P3 矩阵为准）：① 图表布局模板（纯前端持久化，不碰库私有面，判据好写）；② 自选列表实时刷新（要先裁定「 gentle upstream」这条既有取舍是否让路）。

### P5　循环批次 B/C…
- P1→P4 的重复，每批一个主题（指标对话框／图例与值表／告警／Pine 编辑器）。每批结束回 L2 更新矩阵。

### P6　漂移监测（环境修复后启用）
- TV 改版重捕＋`compare-web-captures` 指回失效规格条目。受 §2.4 限制，短期靠人工 diff。

## 8. 验收标准（沿用本仓六道门，一条不加一条不减）

1. `cd frontend && npx tsc -b` rc=0
2. `cd frontend && npx vitest run` rc=0（基线：**141 files / 2336 passed**，本设计轮未跑测试，此为上一片交付态读数；每片开工要**当场复测**基线，别引用这个数字当判据）
3. `cd frontend && npm run build` rc=0
4. `python -X utf8 -m pytest tools/test_wiki_drift.py tools/test_wiki_qmind.py -q`
5. `bash tools/wiki_freshness_gate.sh`（水位门，本地恒红是已知状态 ⇒ 要证「本片 0 贡献」而不是调阈值）
6. `bash tools/ci_grep_gates.sh`（同样本地恒红，命中在未跟踪忽略目录）

外加本仓两条不可让的取证纪律：
- **活体验收**：真实浏览器打开 dev server 取状态读数（不是截图看看）。
- **未来函数**：任何指标／信号交付必附 Bar Replay 五步自查；只用已收盘数据，信号不重绘。

## 9. 需要你点头才能做的事（现在不做，撞到再说）

| # | 动作 | 为什么必须先问 |
|---|---|---|
| 1 | 把 Node 从 22.16 升到 ≥22.19（或 24.x） | 项目外、动全局工具链；你定的纪律是「改动严格限定在项目范围内」。升完可能解锁 §2.4 两条坏掉的路径 |
| 2 | 跑 `rea setup` / 注册 REA 的 MCP server | 会改 agent 全局配置并写工作流说明，还可能装 Hopper |
| 3 | 给取证目录加杀毒白名单 | 动系统安全设置 |
| 4 | 对 tradingview.com 发起实际抓取批次 | 是对外部站点的网络行为；虽然只读公开页面、在既有联网授权内，但第一次真跑前我会先报打算抓哪几面 |
| 5 | 把 `feat/multi-chart-scripts`（`3db76605`＋`ef42355a`）合回 `main` 或推 `origin` | 上一片遗留，共享分支动作，等你一句话 |

## 10. 风险登记

| 风险 | 迹象 | 对策 |
|---|---|---|
| REA 读不了本地文件（ESTALE，已确认） | §2.4 | 架构上绕开（证据只走 stdout＋我摘录）；要文件通道先解决 Node／杀软 |
| TV 反自动化（headless 检测／429／反调试） | 页面空白、命令返回空 targets、请求被拒 | 降频、减小批次；出现即停并标「不可取证」，**不绕过** |
| 懒加载导致证据面不全 | `scripts_observed` 远小于页面实际功能 | 先人工点开面板再捕；用 A4 事件面交叉验证 |
| `observe-web-execution` 改变被测行为 | limitations 自报「临时禁用优化」 | 规格里标注观察条件；不与常规读数混用 |
| 证据体积 vs 2GB 内存／会话上下文 | 输出巨大、机器卡 | 强制 `--filter-output`／`--token-limit`；一次一面；产物落 `forensics/` 而不是留在会话里 |
| Windows argv 上限（约 32k 字符） | 多入参命令报 invalid_input | 大载荷不走 argv，改小批切分 |
| 版权／ToS | 表达层内容被搬进本仓 | 裁定 1 三条硬线；文案自拟；不接 TV 端点；不拷资产 |
| 「复刻目标在漂」 | TV 改版后规格失效 | P6；短期靠批次重捕 |
| 规格写成了散文 | L1 条目没有判据 | 漏斗表里写死：写不出判据不算条目；L2 逐行回打 L1 |

## 11. 交付物清单

- 本文件：`superpowers/specs/2026-10-13-rea-tradingview-replica-design.md`
- 后续：`forensics/`（L0 记录／规格条目表／差距矩阵）、每片一个 `superpowers/plans/2026-MM-DD-*.md`、每片一节 `项目档案.md`
- 明确**不产出**：`package.json` 新依赖、任何指向 tradingview.com 的运行时代码、`rea` 相关的仓库内配置文件

## 12. 本设计轮自查（占位符／矛盾／歧义／范围）

- **占位符**：无 TBD。§7 的「候选缺口」清单标明了来源与复跑要求，未冒充已判定结论。
- **一致性**：§2.4（文件通道坏）与 §5（漂移监测推迟）、§7（P2 改对称法）、§9（要 Node 才能解锁）互相咬合，无自相矛盾。§6 的「19／13／32／18」为本轮实测，与 §2 的实测读数同一来源。
- **歧义点已消除**：「复刻」限定为**行为与交互**复刻，不是资产与代码复刻；「用 REA」限定为**开发期取证**，不是运行时依赖；「目标形态」限定为**本仓增量**。
- **范围**：仍是单一计划能扛的量——因为 P1 只做两个观察面，后续批次是同一漏斗的重复，不是新的架构决定。若 P1 之后发现 TV 的取证面根本拿不到判据级证据（例如全站反自动化生效），本文档要升级为「只做 A1/A4 可达文本与事件面」的窄口径，这是计划内的降级，不是新项目。
