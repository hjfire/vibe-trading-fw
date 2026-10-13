# L0：TV 图表页 `[class*="price"]`（价格轴候选）节点的原生监听器可达性探针（面 A4／a4-priceaxis）

- 命令：npx -y rea-agents@latest inspect-web-event-listeners http://127.0.0.1:9222 162F72C6F52A032716B333A93738AEC8 --allowed-origins https://www.tradingview.com "[class*="price"]" --filter-output evidence_id,normalized_result.selected_node,normalized_result.listeners --token-limit 500
- evidence_id：ev_7f90f22de990174de6fb3a07615f01c9c34f9c3257df963086a3e28b62b56d61
- 浏览器：Edg/155.0.4283.45（protocol_version "1.3"，js_version 15.5.9.4，revision 537.36 (@50f24ef2aa5369a074b8888b7db82d9c0652d642)，本趟 stdout 被 `--filter-output` 收到只剩 `selected_node`／`listeners`，没有 browser 块 ⇒ 取自**同一现场的挂载趟** `targets-2.txt:16-20`；该趟 `targets[1]` 行的 `target_id` 即本条 命令： 的入参（`targets-2.txt:22`））
- 目标 URL：https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL
- 留档（仓外临时件，会随清理消失）：`C:\Users\fire\AppData\Local\Temp\rea-t10b\a4-priceaxis.txt`（正式趟整份 stdout，7 行／205 字节）；同目录 `a4-priceaxis.cmd`（逐字命令行，279 字节）、`a4-priceaxis-count.txt`（`--token-count` 读数＝58）
- 观察条件：Edge `--headless=new` ＋ `--remote-debugging-port=9222` ＋ 专属 profile 目录 `%TEMP%\rea-cdp-profile-t10b` ＋ `--proxy-server="http://127.0.0.1:7897"`（当次 `reg query` 现读：`ProxyEnable=0x1`／`ProxyServer=127.0.0.1:7897`）；URL 走 Edge 命令行参数；未点按、未派发事件、未登录、未改 UA；selector 实参 `[class*="price"]` 是**子串匹配**的我方入参：`price` 这个子串是我方对「价格轴」的押注，不是从对方页面上读来的 class 值；一次一面；`--token-limit 500` 体积闸门，第 7 行即末行、无 `[truncated` 标记
- 完整性：本面 stdout 里**没有 completeness 块**（A4 形状，八份留档复验 `grep -c completeness`＝0）⇒ 无 `status` 可抄；不给解析计数类键
- 用途：规格
- 取证时间：2026-10-13T22:39:16+08:00（留档落盘 mtime；本面 stdout 无时间戳键）

## 摘录（逐字，未改写）

整份 stdout 就是下面 7 行（205 字节），全录、无省略。围栏标 `text`。

```text
evidence_id: ev_7f90f22de990174de6fb3a07615f01c9c34f9c3257df963086a3e28b62b56d61
normalized_result:
  selected_node:
    selector: "[class*=price]"
    match: found
    backend_node_id: 85
  listeners: []
```

## 读数含义

**留档行号（`grep -n` 可反查，文件＝`%TEMP%\rea-t10b\a4-priceaxis.txt`）**：`evidence_id` 第 1 行；`normalized_result` 第 2 行；`selected_node` 块 3-6（`selector` 4、`match` 5、`backend_node_id` 6）；`listeners` 第 7 行（末行）。主键 `sed -n '1p' a4-priceaxis.txt` 当场取，与摘录首行同值同趟。

- **本面撑得住的结论**：页面上**存在 class 属性里含 `price` 子串的节点**，且 A4 的事件面指得到它（第 5 行 `found`、第 6 行句柄 85）⇒ 「对方在 class 命名里用了含 price 这一段」这一句有证据面（注意：证据只到「含这个子串的 class 存在」为止）。
- **本面撑不住的结论（四条）**：
  - 「命中的那枚就是价格轴」——读不到。子串匹配可能命中任何 class 里带 `price` 的元素（图例里的最新价、报价条、按钮都可能），本面无位置／尺寸／层级键。⇒ L1 里「价格轴组件」这句要靠 ② 交互面或像素面的**各自记录**去撑，本面只给「这处可指认」。
  - 「它有几枚命中」——读不到：本面 stdout 没有基数键，命中的是哪一枚也不报，所以「class 含 price 的节点共 N 个」这句话在本面**没有**证据面。
  - 「价格轴挂的是 `pointerdown` 还是 `click`」——**本面答不了**：`listeners: []`（第 7 行）是空读数。批次清单 §1 原本指望这一面回答「那一处挂的是哪种原生监听器」，本席在 TV 真实页上八枚全部读到空列表 ⇒ 这一面的预期读数在对方页面上没有兑现（读法见下一条，别把它写成结论的反面）。
  - 「对方的 class 命名是什么」——本面**不提供**，而且这是好事：stdout 里没有属性值，只有我方 selector 的回显。⇒ 落进仓的 `price` 这个词是我方自己写的匹配串，不是抄来的 class 值（合规口径见最后一条）。
- **`listeners: []` 的正确读法（八枚共用，写死在这里）**：原生监听器枚举面给出空列表，**不等于**该节点没有事件绑定。现代前端把事件挂在合成层／委托层／框架运行时上是常态，而这一面只看原生 DOM 监听器；本面也没有「枚举失败」与「枚举到零」的区分键。⇒ 能写的只有「按 `[class*="price"]` 命中的那处节点，原生监听器枚举读数为空」；不能写「价格轴无事件绑定」「价格轴不用 pointerdown」。**「没报」≠「没有」**（批次清单 §4 那条口径在本面复验）。
- **selector 回显形状**：实参 `[class*="price"]` 回显为 `"[class*=price]"`（第 4 行，属性选择器里内层引号被提供方去掉），与 toolbar／rolemenu／legend 三枚同形；逐字实参见 `a4-priceaxis.cmd`。
- **合规自证**：过滤键止步于 `selected_node,listeners`，留档上 `source`／`text`／`sha256`／`producer_hash` 四个词 `grep -ci` 全为 0。
