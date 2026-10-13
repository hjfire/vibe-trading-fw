# 批次 A：TV 图表页观察（P1）

这份清单在第一次对 `tradingview.com` 发起抓取**之前**写成并提交，里面不含任何抓取结果。
spec §9 第 4 条要求「第一次实抓前先报打算抓哪几面」；2026-10-13 用户已逐条点头四件事
（跑哪几面／拿不到的面／只读纪律／`--include-*` 旗标取舍），本文件就是那份点头的落地口径。
**改动批次内容（加面、换面、换旗标）要重新问一次**，沿用它不等于授权扩大它。

## 0. 怎么挂上去（这一步决定后面所有面）

REA 只能挂到**启动时就带了调试端口**的浏览器上；已经在跑的窗口挂不进去。所以每一趟都是
我们自己起一个无头 Edge，URL 作为**命令行参数**交给这一趟进程：

```bash
python -m http.server 8077 --bind 127.0.0.1 --directory tools/rea_probe_site   # 仅 P0 探针页用
"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new \
  --remote-debugging-port=9222 --user-data-dir="$TEMP/rea-cdp-profile" \
  --disable-extensions --disable-sync --no-first-run --no-default-browser-check \
  "https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL"
npx -y rea-agents@latest list-browser-targets http://127.0.0.1:9222            # 取 target_id
```

收尾**只按 `netstat -ano` 取到的那两个 Windows PID** `taskkill`，然后删 `$TEMP/rea-cdp-profile`。
**绝不按镜像名杀 `msedge.exe`**——机器上同时开着人工使用的真实 Edge 窗口。

`list-browser-targets` 报的键是 **`target_id`**（不是 `targetId`），尽管 `--help` 的实参名写着 `targetId`。

## 1. 打算跑的面

目标页：`https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL`（公开、匿名可访问、无需登录）。

| 面 | 命令（`--filter-output` 是收口口径的一部分，照抄） | 取什么 | `--include-*` |
|---|---|---|---|
| A1 页面骨架 | `inspect-web-page http://127.0.0.1:9222 <tid> --observation-ms 1500 --include-accessibility-text --include-storage-keys --include-storage-fingerprints --include-json-body-shapes --include-websocket-shapes --filter-output evidence_id,normalized_result` | DOM 分段与节点形状、`accessibility.nodes` 里同一 `parent_id` 下的 `role: button` 群、`storage` 块 | 见 §2 |
| A2 脚本与端点 | `analyze-web-bundle http://127.0.0.1:9222 <tid> --observation-ms 2000 --filter-output evidence_id,normalized_result.observations` | `endpoints[]`（它有哪些数据需求）／`chunks.nodes`+`edges`（模块图）／`routes` | 该命令不吃这些旗标 |
| A4 元素事件面（**每条 selector 一趟，一份 L0**） | `inspect-web-event-listeners http://127.0.0.1:9222 <tid> "<selector>" --filter-output evidence_id,normalized_result.selected_node,normalized_result.listeners` | 那一处挂的是 `pointerdown` 还是 `click` 等原生监听器＋回调的 `url`/`line_number`/`column_number` | 不适用；**过滤键必须写到 `listeners` 为止**，见 §3 |
| A16 存储键面 | 与 A1 同一条命令，摘录只切 `storage` 块 | 对方把图元／布局／偏好存成哪些**键名**与**内容指纹**（不含值） | `--include-storage-keys --include-storage-fingerprints` |

A16 是本批次**新增**的一面，计划里没有。编号跳开 `A8` 是因为 spec §5 工单表的 `A8` 已经是
「图例／数据窗口」，那一面要页内交互（见 §5），两者不是同一面。

A4 的 selector 候选（**我方假设，不是观察结论**）：图表 canvas 容器、工具栏容器、价格轴、时间轴、图例区。

## 2. 旗标取舍（用户 2026-10-13 点头的那四条，逐条给理由）

`inspect-web-page --help` 里有七个 `--include-*`，默认**全关**。对本地探针页开哪个都不犯规；
对 `tradingview.com` 就是合规问题，按 spec 裁定 1 的三条硬线逐条等下来：

- **`--include-accessibility-text`＝开**。产出只摘**功能名**（按钮／菜单项的 `role`＋`name`），
  用来回答「工具栏到底有几组、分别是哪一类」。**不许**把整段 `accessibility.nodes` 成批入库，
  更不许把我方界面文案写成对方的措辞——文案属表达层，硬线 1 不碰。
- **`--include-script-sources`＝禁开**，写死在本清单里当禁止项。它把对方 JS 的**源码文本**带进
  stdout，直接撞硬线 1。
- **`--include-json-body-shapes`／`--include-websocket-shapes`＝开，只落形状不落值。**
  判据里引用「它有这个字段」可以，落任何字段值或样本数据不行（硬线 3 同一口径）。
- **`--include-storage-keys`（help 原文 *without values*）／`--include-storage-fingerprints`＝开。**
  键名与「内容派生哈希」是证据，不是内容本身；这一面正是 P3 对账画线持久化最想要的。

本机预检实测（2026-10-13，自家探针页，留档在 `%TEMP%\rea-t7\`，仓外临时件会随清理消失，
所以这里把读数写在纸上）：四条结构旗标＋无障碍文本都打开后，
`completeness.policy_filtered_sections` 从 6 项收缩到 **2 项**（`console_text,script_sources`），
也就是 §2 这套取舍的效果就是「只留禁开的那两面被策略挡住」。

## 3. 两条必须写死的口径（都是实测撞出来的）

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

`--token-limit` 只当**体积闸门**用，别当「反正能截出我要的东西」：探针页 A4 整份约 1,477 tokens，
限 400 的那份把 `    - type:` 切在半截，`pointerdown` 零命中。每面**先不限流跑一次**确认目标键在、
有多大，再决定收口口径。

## 4. 判据写法上的硬限制（决定 L1 能写什么）

- A1 的 `dom` 段**只给属性名，不给属性值**（探针页留档里 `grep toolbar` 零命中，而页面上写的就是
  `<div id="toolbar">`；节点形状是 `attribute_names[3]: id,width,height`）。
  ⇒ 从 A1 只能指认**标签与角色级**事实（有几枚 `CANVAS`、`accessibility.nodes` 里同一 `parent_id`
  下有几个 `role: button`）。**「某个 id 存在」这句话没有证据面**，L1 里不许写。
- A4 的选择器是**入参**（「我告诉它看哪」），不是观察（「我看到了什么」）。
  落地判据只看 A4 自己那份输出：实测未命中的 selector 报 `selected_node.match: not_found`＋
  `backend_node_id: null`＋`listeners: []`，**rc 仍是 0、不报错**。
  ⇒ `not_found` 就如实记「这条 selector 在对方页面上没命中」，不许写成「A1 确认过」。
- `完整性：` 逐面照抄当次 stdout，一个值套不了三面（A1＝`policy_filtered`；A2＝`complete`＋
  `parse_failures: 0`；A4＝**整个 completeness 块不存在**）。
  另注意校验器那条**散文级**规则：正文任意处出现 `parse_failures` 字样，`完整性：` 里就得有它
  （`tools/forensics_audit.py` 的 `_audit_l0`）。
- `--include-json-body-shapes` 这一面**预计为空**，原因不是命令失败：REA 自己写明
  「Observation starts when REA attaches; prior network and console activity is unavailable」，
  而我们是一趟命令挂上去、页面早就加载完了。探针页实测 `--observation-ms 1500` 下
  `network.requests: []`、`prior_activity_available: false`。
  ⇒ 空就记空，别把它读成「对方没有 JSON 接口」；数据需求那一面由 A2 的静态分析负责
  （探针页 A2 就靠 `mechanism: "call:fetch"` 数出了 `endpoints[1] = /data.json`）。

## 5. 明说跑不了的面（不硬凑）

A3 展开画线工具条、A5 点开周期下拉、A6 右键菜单、A7 指标对话框、A8 图例／数据窗口、
A12 Pine 编辑器、A13 告警对话框——全都要**页内交互**。
本机能做交互的 `capture-browser-scenario` 入参是**磁盘文件路径**，而 spec §2.4 已实测
一切吃路径的 REA 命令在这台机器上报 `ESTALE`。

处置：这些面各写一份 `状态：不可取证` 的 L0（带 `命令：` 与 `原因：`），
**不在 L1 里给它们编条目**。这句话写在开工前，而不是等等不来证据时再解释。

## 6. 闸门与停手条件

- 只读公开页面，GET only；不登录、不绕过检测、不伪装 UA、不改指纹、不重试撞限流。
- 出现空白页／空 `targets`／请求被拒／429／验证码 ⇒ **就地停手**，把该面标为不可取证，
  不想办法绕（spec §10 对策原话）。
- 跑之前先探一次连通性；网络异常按既有诊断顺序：代理端口拒连时**先不带 `--proxy` 重发**，
  再判网络全灭。
- 一次一面，一面一趟一份 L0；`--filter-output` 或 `--token-limit` 必带（校验器会查这条）。
- 只用 stdout，摘录进仓库；**不落地任何第三方脚本、源码文本或资产**。
- 节奏（用户已点头）：先只跑 A1 一趟验证可达与可挂，若被挡就回来报告；确认拿到证据再跑
  A2／A4×5／A16。

## 7. 预期产物

`docs/forensics/l0/tv-a1-page.md`、`tv-a2-bundle.md`、`tv-a16-storage.md`、
`tv-a4-<selector>.md` × N（未命中的也各占一份，如实记 `not_found`），
加 `docs/forensics/spec/` 下的条目表与 `docs/forensics/gap-matrix.md` 的行。
这些记录的 `用途：` 填 `规格`（它们要被供应商页面的规格条目引用；填 `harness` 或 `基线`
才是 P0 那三份探针记录的用途）。
