# L0：TV 图表页 `[role="log"]`（图例／数据窗口区）节点的原生监听器可达性探针（面 A4／a4-legend）

- 命令：npx -y rea-agents@latest inspect-web-event-listeners http://127.0.0.1:9222 162F72C6F52A032716B333A93738AEC8 --allowed-origins https://www.tradingview.com "[role="log"]" --filter-output evidence_id,normalized_result.selected_node,normalized_result.listeners --token-limit 500
- evidence_id：ev_79da0430426b0ca73d12d17e784bc21913c4d02fa6438225b6851515188dd3f3
- 浏览器：Edg/155.0.4283.45（protocol_version "1.3"，js_version 15.5.9.4，revision 537.36 (@50f24ef2aa5369a074b8888b7db82d9c0652d642)，本趟 stdout 被 `--filter-output` 收到只剩 `selected_node`／`listeners`，没有 browser 块 ⇒ 取自**同一现场的挂载趟** `targets-2.txt:16-20`；该趟 `targets[1]` 行的 `target_id` 即本条 命令： 的入参（`targets-2.txt:22`））
- 目标 URL：https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL
- 留档（仓外临时件，会随清理消失）：`C:\Users\fire\AppData\Local\Temp\rea-t10b\a4-legend.txt`（正式趟整份 stdout，7 行／202 字节）；同目录 `a4-legend.cmd`（逐字命令行，275 字节）、`a4-legend-count.txt`（`--token-count` 读数＝57）
- 观察条件：Edge `--headless=new` ＋ `--remote-debugging-port=9222` ＋ 专属 profile 目录 `%TEMP%\rea-cdp-profile-t10b` ＋ `--proxy-server="http://127.0.0.1:7897"`（当次 `reg query` 现读：`ProxyEnable=0x1`／`ProxyServer=127.0.0.1:7897`）；URL 走 Edge 命令行参数；未点按、未展开图例、未派发事件、未登录、未改 UA；selector 实参 `[role="log"]` 是我方入参——把「图例／数据窗口那一区」押在 `role=log` 上是**我方假设**；一次一面；`--token-limit 500` 体积闸门，第 7 行即末行、无 `[truncated` 标记
- 完整性：本面 stdout 里**没有 completeness 块**（A4 形状，八份留档复验 `grep -c completeness`＝0）⇒ 无 `status` 值可抄，本键记「这一面不给完整性读数」；也不给解析计数类键
- 用途：规格
- 取证时间：2026-10-13T22:39:11+08:00（留档落盘 mtime；本面 stdout 无时间戳键）

## 摘录（逐字，未改写）

整份 stdout 就是下面 7 行（202 字节），全录、无省略。围栏标 `text`。

```text
evidence_id: ev_79da0430426b0ca73d12d17e784bc21913c4d02fa6438225b6851515188dd3f3
normalized_result:
  selected_node:
    selector: "[role=log]"
    match: found
    backend_node_id: 122
  listeners: []
```

## 读数含义

**留档行号（`grep -n` 可反查，文件＝`%TEMP%\rea-t10b\a4-legend.txt`）**：`evidence_id` 第 1 行；`normalized_result` 第 2 行；`selected_node` 块 3-6（`selector` 4、`match` 5、`backend_node_id` 6）；`listeners` 第 7 行（末行）。主键 `sed -n '1p' a4-legend.txt` 当场取，与摘录首行同值同趟。

- **本面撑得住的结论**：`[role="log"]` 这一写法在该页**命中**（第 5 行），命中节点有后端句柄 122（第 6 行）⇒ 对方页面上存在带 `role="log"` 属性的节点，且 A4 的事件面指得到它。这与 `tv-a1-page.md` 那面的角色分布（同一现场的另一趟里 `log` 角色 20 枚）是**互补而不同源**的两个读数：A1 报「无障碍树里有这些角色节点」，本面报「按 DOM 属性查询能命中并拿到句柄」；两份主键不同，判据要分别引自己那份。
- **本面撑不住的结论**：
  - 「命中的这枚就是图例区」——读不到。`role=log` 在对方页上不止一处（A1 那面的计数是另一趟的读数），本面只给单个 `selected_node`、无命中基数与位置键 ⇒ 把 backend_node_id 122 认成图例本体是**我方假设**。
  - 「图例行是怎么刷新的」——读不到：`listeners: []`（第 7 行）是原生监听器枚举为空，**不等于**图例没有更新机制；TV 的行情推送更可能走非 DOM 事件的路径，而那一层在本面没有证据面（ websocket 形状在 A1 那面是「attach 时机造成的空」，见 `tv-a1-page.md`）。
  - 「图例每行显示哪几个字段、顺序如何」——本面完全不提供，那是 ② A8 交互面自己记录的内容（一趟一个主键，不许拿本份凑数，批次清单 §7 末尾那句）。
- **selector 回显形状**：实参 `[role="log"]` 回显为 `"[role=log]"`（第 4 行，去内层引号），与 toolbar／rolemenu 两枚同形；逐字实参看 `a4-legend.cmd`。
- **合规自证**：过滤键止步于 `selected_node,listeners`，留档上 `source`／`text`／`sha256`／`producer_hash` 四个词 `grep -ci` 全为 0 ⇒ 回调脚本正文没进留档。本记录里的 `role=log` 是我方 selector 的匹配写法（无障碍角色名，可达语义层），不是对方的 class 命名值或界面文案。
