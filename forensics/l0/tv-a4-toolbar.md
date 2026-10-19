# L0：TV 图表页 `[role="toolbar"]` 节点的原生监听器可达性探针（面 A4／a4-toolbar）

- 命令：npx -y rea-agents@latest inspect-web-event-listeners http://127.0.0.1:9222 162F72C6F52A032716B333A93738AEC8 --allowed-origins https://www.tradingview.com "[role="toolbar"]" --filter-output evidence_id,normalized_result.selected_node,normalized_result.listeners --token-limit 500
- evidence_id：ev_5712a2c2acb1055abea0744408cf6aff5dbc50dc2f92e6d46be686b33c8307db
- 浏览器：Edg/155.0.4283.45（protocol_version "1.3"，js_version 15.5.9.4，revision 537.36 (@50f24ef2aa5369a074b8888b7db82d9c0652d642)，本趟 stdout 被 `--filter-output` 收到只剩 `selected_node`／`listeners`，里面没有 browser 块 ⇒ 这四行取自**同一现场的挂载趟** `targets-2.txt:16-20`；该趟 `targets[1]` 那行报的 `target_id` 就是本条 命令： 的入参（`targets-2.txt:22`））
- 目标 URL：https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL
- 留档（仓外临时件，会随清理消失）：`C:\Users\fire\AppData\Local\Temp\rea-t10b\a4-toolbar.txt`（正式趟整份 stdout，7 行／205 字节）；同目录 `a4-toolbar.cmd`（上面那条 命令： 的逐字留档，279 字节）、`a4-toolbar-count.txt`（`--token-count` 读数＝58）
- 观察条件：Edge `--headless=new` ＋ `--remote-debugging-port=9222` ＋ 专属 profile 目录 `%TEMP%\rea-cdp-profile-t10b`（本次新建）＋ `--proxy-server="http://127.0.0.1:7897"`，端口是当次 `reg query` 现读到的值（`ProxyEnable=0x1`／`ProxyServer=127.0.0.1:7897`）；URL 作为 Edge 命令行参数交出；未点按、未展开任何工具条、未派发事件、未登录、未改 UA；selector 实参 `[role="toolbar"]`（无障碍角色属性匹配）是我方入参，不是观察；一次一面——本条只有这一枚，A4 其余七枚各占一份记录；`--token-limit 500` 是体积闸门（从当次 count 读数 58 按「count 是下界」口径放大），正式趟第 7 行即文件末行、无 `[truncated` 标记
- 完整性：本面 stdout 里**没有 completeness 块**（批次清单 §4 写死的 A4 形状，八份 A4 留档逐一复验 `grep -c completeness`＝0）⇒ 没有 `status` 值可照抄，本键记的是「这一面不给完整性读数」；本面也不给解析计数类键
- 用途：规格
- 取证时间：2026-10-13T22:37:09+08:00（留档落盘 mtime；本面 stdout 没有时间戳键）

## 摘录（逐字，未改写）

整份 stdout 就是下面 7 行（205 字节），全录、无省略。格式是 REA 默认的 toon 缩进文本，围栏标 `text`。

```text
evidence_id: ev_5712a2c2acb1055abea0744408cf6aff5dbc50dc2f92e6d46be686b33c8307db
normalized_result:
  selected_node:
    selector: "[role=toolbar]"
    match: found
    backend_node_id: 94
  listeners: []
```

## 读数含义

**留档行号（`grep -n` 可反查，文件＝`%TEMP%\rea-t10b\a4-toolbar.txt`）**：`evidence_id` 第 1 行；`normalized_result` 第 2 行；`selected_node` 块 3-6（`selector` 4、`match` 5、`backend_node_id` 6）；`listeners` 第 7 行（末行）。主键写档前 `sed -n '1p' a4-toolbar.txt` 当场取，与摘录首行同值同趟。

- **本面撑得住的结论**：`[role="toolbar"]` 这一写法在该页**命中**（第 5 行 `match: found`），命中节点有后端句柄（第 6 行 `backend_node_id: 94`）⇒ 对方页面上存在带 `role="toolbar"` 属性的节点，且这一处**可以被 A4 的事件面指到**。这一句比 A1 那面的 `role: toolbar` 计数更靠「属性」一侧：A1 的 `dom` 段只给属性名不给值，而本面证明的是「带这个 role 属性值的节点在 DOM 里可被查询命中」。
- **本面撑不住的结论**：
  - `listeners: []`（第 7 行）≠「工具条没有事件绑定」；原生监听器枚举面拿不到与确实为零同形，本面无区分键。⇒ 「工具条靠事件委托／靠框架合成事件」这类句子在本面既证不成也证否不了。
  - 命中的是六组工具栏里的哪一组，本面读不到：`tv-a1-page.md` 那面数出 6 枚 `role: toolbar` 无障碍节点，本面只给**单个** `selected_node`、无命中基数与顺序键 ⇒ 「第 94 号句柄就是画线工具条」是**我方假设**，本面没有证据面。
- **selector 回显形状（本枚给出的实测增量）**：实参 `[role="toolbar"]` 被提供方规范化回显成 `"[role=toolbar]"`（第 4 行）——**内层双引号被去掉、整体按 toon 的规则加了一层引号**。⇒ 记录里「实参」与「回显」两件事要分开看：`命令：` 那一行写的是我实际交出去的实参（`a4-toolbar.cmd` 逐字留档，引号原样保留），摘录第 4 行写的是对方回显；两者的差别是本工具的形状，不是我改了实参。
- **合规自证**：过滤键止步于 `selected_node,listeners`，留档上 `source`／`text`／`sha256`／`producer_hash` 四个词 `grep -ci` 全为 0 ⇒ 默认内联回调源码正文那条路被挡住。本记录提到的 `role="toolbar"` 是**属性名与属性值的匹配写法**（我方 selector 假设），不是对方的 class 命名或文案，符合批次清单 §1 末尾关于 `css` 与 `role`＋`name` 取舍的那段口径。
