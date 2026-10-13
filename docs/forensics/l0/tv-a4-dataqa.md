# L0：TV 图表页 `[data-qa-id]` 节点的原生监听器可达性探针（面 A4／a4-dataqa）

- 命令：npx -y rea-agents@latest inspect-web-event-listeners http://127.0.0.1:9222 162F72C6F52A032716B333A93738AEC8 --allowed-origins https://www.tradingview.com "[data-qa-id]" --filter-output evidence_id,normalized_result.selected_node,normalized_result.listeners --token-limit 500
- evidence_id：ev_04c415f4a4e9da30a01072df2a87954ff2abcdd71ff28ed0a8e580f1b4bdc2cd
- 浏览器：Edg/155.0.4283.45（protocol_version "1.3"，js_version 15.5.9.4，revision 537.36 (@50f24ef2aa5369a074b8888b7db82d9c0652d642)，本趟 stdout 被 `--filter-output` 收到只剩 `selected_node`／`listeners`，没有 browser 块 ⇒ 取自**同一现场的挂载趟** `targets-2.txt:16-20`；该趟 `targets[1]` 行的 `target_id` 即本条 命令： 的入参（`targets-2.txt:22`））
- 目标 URL：https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL
- 留档（仓外临时件，会随清理消失）：`C:\Users\fire\AppData\Local\Temp\rea-t10b\a4-dataqa.txt`（正式趟整份 stdout，7 行／203 字节）；同目录 `a4-dataqa.cmd`（逐字命令行，275 字节）、`a4-dataqa-count.txt`（`--token-count` 读数＝58）
- 观察条件：Edge `--headless=new` ＋ `--remote-debugging-port=9222` ＋ 专属 profile 目录 `%TEMP%\rea-cdp-profile-t10b` ＋ `--proxy-server="http://127.0.0.1:7897"`（当次 `reg query` 现读：`ProxyEnable=0x1`／`ProxyServer=127.0.0.1:7897`）；URL 走 Edge 命令行参数；未点按、未派发事件、未登录、未改 UA；selector 实参 `[data-qa-id]` 是**属性存在性**匹配的我方入参（押「对方有 QA 锚点属性体系」这一件事），只写属性名、不猜属性值；一次一面；`--token-limit 500` 体积闸门，第 7 行即末行、无 `[truncated` 标记
- 完整性：本面 stdout 里**没有 completeness 块**（A4 形状，八份留档复验 `grep -c completeness`＝0）⇒ 无 `status` 可抄；不给解析计数类键
- 用途：基线
- 取证时间：2026-10-13T22:39:26+08:00（留档落盘 mtime；本面 stdout 无时间戳键）

## 摘录（逐字，未改写）

整份 stdout 就是下面 7 行（203 字节），全录、无省略。围栏标 `text`。

```text
evidence_id: ev_04c415f4a4e9da30a01072df2a87954ff2abcdd71ff28ed0a8e580f1b4bdc2cd
normalized_result:
  selected_node:
    selector: "[data-qa-id]"
    match: found
    backend_node_id: 64
  listeners: []
```

## 读数含义

**留档行号（`grep -n` 可反查，文件＝`%TEMP%\rea-t10b\a4-dataqa.txt`）**：`evidence_id` 第 1 行；`normalized_result` 第 2 行；`selected_node` 块 3-6（`selector` 4、`match` 5、`backend_node_id` 6）；`listeners` 第 7 行（末行）。主键 `sed -n '1p' a4-dataqa.txt` 当场取，与摘录首行同值同趟。

- **本面撑得住的结论（对 T9 最有用的一句）**：对方页面上**存在带 `data-qa-id` 属性的节点**（第 5 行 `found`，第 6 行句柄 64）⇒ 「对方给自动化留了 QA 锚点属性」是有证据面的存在性判断。这一句的形状与 `tv-a1-page.md` 里「dom 段只给属性名」那条限制**互补**：A1 那面从整页枚举里报的属性名样本是 `data-name,aria-hidden,width,height,style`（同一留档另一趟的读数），而 `[data-qa-id]` 这一写法**在 DOM 查询侧命中了**——两趟各说各的，谁也不能替谁。（差异的成因本面读不到：A1 的 `attribute_names` 是逐节点样本、不是全页属性并集，所以「A1 没见过 data-qa-id」不成结论。）
- **本面撑不住的结论**：
  - `data-qa-id` 的**属性值**读不到（stdout 只有我方 selector 的回显与一个句柄号）⇒ 「对方的锚点命名规则是什么」「某个控件的 qa-id 叫什么」这两类句子在本面没有证据面，也不该有——属性值是对方表达层，落进仓就撞合规硬线 1。
  - **命中基数**读不到：这一枚 selector 几乎肯定命中多枚（QA 锚点通常是全站体系），而本面只报单枚 `selected_node`、无基数键 ⇒ 「有多少控件带 qa 锚点」这句本面答不了。
  - 「命中的是哪一处控件」读不到：句柄 64 不与任何语义标签绑定，把它认成某个具体按钮是我方假设。
  - 事件面照旧读不到：`listeners: []`（第 7 行）＝原生监听器枚举为空，**≠** 该节点没有事件绑定（八枚同一读法，见 `tv-a4-priceaxis.md` 那条展开）。
- **selector 回显形状**：`[data-qa-id]` 不含引号，回显与实参逐字相同（第 4 行）——这一枚因此是八枚里唯一「实参＝回显」的属性选择器，可用来对照 a4-toolbar／a4-rolemenu／a4-legend／两枚 `[class*=…]` 那五枚的**去内层引号**回显形状；差别在提供方，不在我方写法。
- **合规自证**：过滤键止步于 `selected_node,listeners`；留档上 `source`／`text`／`sha256`／`producer_hash` 四个词 `grep -ci` 全为 0。本记录只写属性**名**（我方 selector 的一部分），没有任何属性值。
