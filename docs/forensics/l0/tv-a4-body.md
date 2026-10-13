# L0：TV 图表页 `body` 节点的原生监听器可达性探针（面 A4／a4-body，**对照组**）

- 命令：npx -y rea-agents@latest inspect-web-event-listeners http://127.0.0.1:9222 162F72C6F52A032716B333A93738AEC8 --allowed-origins https://www.tradingview.com "body" --filter-output evidence_id,normalized_result.selected_node,normalized_result.listeners --token-limit 500
- evidence_id：ev_491a7d40156ec727b117a222045f9bb7c365375555894796a8ba2cfba6a7c247
- 浏览器：Edg/155.0.4283.45（protocol_version "1.3"，js_version 15.5.9.4，revision 537.36 (@50f24ef2aa5369a074b8888b7db82d9c0652d642)，本趟 stdout 被 `--filter-output` 收到只剩 `selected_node`／`listeners`，没有 browser 块 ⇒ 取自**同一现场的挂载趟** `targets-2.txt:16-20`；该趟 `targets[1]` 行的 `target_id` 即本条 命令： 的入参（`targets-2.txt:22`））
- 目标 URL：https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL
- 留档（仓外临时件，会随清理消失）：`C:\Users\fire\AppData\Local\Temp\rea-t10b\a4-body.txt`（正式趟整份 stdout，7 行／193 字节，八枚里最小的一份）；同目录 `a4-body.cmd`（逐字命令行，267 字节）、`a4-body-count.txt`（`--token-count` 读数＝52，与 a4-canvas 并列最低）
- 观察条件：Edge `--headless=new` ＋ `--remote-debugging-port=9222` ＋ 专属 profile 目录 `%TEMP%\rea-cdp-profile-t10b` ＋ `--proxy-server="http://127.0.0.1:7897"`（当次 `reg query` 现读：`ProxyEnable=0x1`／`ProxyServer=127.0.0.1:7897`）；URL 走 Edge 命令行参数；未点按、未派发事件、未登录、未改 UA；selector 实参 `body` 是我方入参，这一枚在八枚里的角色是**对照组**（`document.body` 是唯一确定单命中的节点，用它来判「空读数」到底有多普遍）；一次一面；`--token-limit 500` 体积闸门，第 7 行即末行、无 `[truncated` 标记
- 完整性：本面 stdout 里**没有 completeness 块**（A4 形状，八份留档复验 `grep -c completeness`＝0）⇒ 无 `status` 可抄；不给解析计数类键
- 用途：基线
- 取证时间：2026-10-13T22:39:31+08:00（留档落盘 mtime；本面 stdout 无时间戳键）

## 摘录（逐字，未改写）

整份 stdout 就是下面 7 行（193 字节），全录、无省略。围栏标 `text`。

```text
evidence_id: ev_491a7d40156ec727b117a222045f9bb7c365375555894796a8ba2cfba6a7c247
normalized_result:
  selected_node:
    selector: body
    match: found
    backend_node_id: 50
  listeners: []
```

## 读数含义

**留档行号（`grep -n` 可反查，文件＝`%TEMP%\rea-t10b\a4-body.txt`）**：`evidence_id` 第 1 行；`normalized_result` 第 2 行；`selected_node` 块 3-6（`selector` 4、`match` 5、`backend_node_id` 6）；`listeners` 第 7 行（末行）。主键 `sed -n '1p' a4-body.txt` 当场取，与摘录首行同值同趟。

- **本面撑得住的结论**：`body` 命中（第 5 行 `found`、句柄 50），说明挂载与查询链路本身是通的——**这一枚把「八枚全空是因为命令没跑起来／target 挂了」这个解释排掉了**（其余七枚里七枚 `found`、一枚 `not_found`，都在同一 target 上拿到读数，`rc` 全 0）。
- **对照组的真正价值（这是本记录要留给 T9 的那句）**：`document.body` 这种确定单命中的节点也读到 `listeners: []`（第 7 行）。结合七枚 `match: found` 全部为空这一形状，**可以**写成判据级口径的那一半是：「A4 的原生监听器枚举面在本次 TV 现场上整体给空读数」；**不可以**写成的是：「TV 的组件都没有事件绑定」，也不可以写成「对方确实不给 body 挂监听器」。空读数的成因候选（事件挂在框架合成层／委托层、监听器在另一个执行世界里注册、提供方在 CDP 侧枚举受限）本面一个都没有区分键，所以「为什么空」在本面**没有证据面**，只能记成上面那句范围陈述。⇒ 批次清单 §1 原本指望 A4 回答「那一处挂的是 `pointerdown` 还是 `click`」，本席在对方真实页上**答不了这一问**；这一条要在 L1 里落成「该判据待 ② 交互面或后续复跑」，而不是落成「TV 无原生监听器」。
- **本面撑不住的其它结论**：body 上的属性、样式、尺寸、子节点数量一律读不到（本面只有三字段）；「页面是否渲染完成」也读不到——`found` 只证明节点存在，不证明其内容状态（页面非空白的旁证在挂载趟的 `title` 字段与 A1 那面的 `dom.total_nodes`，那是另外两趟的读数，本面不据以下结论）。
- **selector 回显形状**：实参 `body` 回显就是 `body`（第 4 行 `selector: body`，标签选择器不加引号），与 a4-canvas 那枚同形；带引号的属性选择器那五枚回显会去掉内层引号。⇒ `命令：` 里的实参写法与 `selected_node.selector` 的回显是两件事，逐字实参见 `a4-body.cmd`。
- **合规自证**：过滤键止步于 `selected_node,listeners`；留档上 `source`／`text`／`sha256`／`producer_hash` 四个词 `grep -ci` 全为 0。
