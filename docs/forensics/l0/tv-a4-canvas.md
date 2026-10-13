# L0：TV 图表页 `canvas` 节点的原生监听器可达性探针（面 A4／a4-canvas）

- 命令：npx -y rea-agents@latest inspect-web-event-listeners http://127.0.0.1:9222 162F72C6F52A032716B333A93738AEC8 --allowed-origins https://www.tradingview.com "canvas" --filter-output evidence_id,normalized_result.selected_node,normalized_result.listeners --token-limit 500
- evidence_id：ev_35835c564fa379c134808ebcc42b2eac34fb26800c2fe60c3646d80a0f757ded
- 浏览器：Edg/155.0.4283.45（protocol_version "1.3"，js_version 15.5.9.4，revision 537.36 (@50f24ef2aa5369a074b8888b7db82d9c0652d642)，本趟 stdout 被 `--filter-output` 收到只剩 `selected_node`／`listeners`，里面没有 browser 块 ⇒ 这四行取自**同一现场的挂载趟** `targets-2.txt:16-20`；该趟 `targets[1]` 那行报的 `target_id` 就是本条 命令： 的入参（`targets-2.txt:22`））
- 目标 URL：https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL
- 留档（仓外临时件，会随清理消失）：`C:\Users\fire\AppData\Local\Temp\rea-t10b\a4-canvas.txt`（正式趟整份 stdout，7 行／195 字节）；同目录 `a4-canvas.cmd`（上面那条 命令： 的逐字留档，269 字节）、`a4-canvas-count.txt`（`--token-count` 那一趟的读数＝52）
- 观察条件：Edge `--headless=new` ＋ `--remote-debugging-port=9222` ＋ 专属 profile 目录 `%TEMP%\rea-cdp-profile-t10b`（本次新建）＋ `--proxy-server="http://127.0.0.1:7897"`，端口是当次 `reg query` 现读到的值（`ProxyEnable=0x1`／`ProxyServer=127.0.0.1:7897`）；URL 作为 Edge 命令行参数交出；未点按任何元素、未派发事件、未登录、未改 UA、未禁用优化；selector 实参 `canvas` 是**我方入参**（「我告诉它看哪」），不是观察；一次一面——本条只有这一枚 selector，批次 A 的 A4 共八枚、各占一份记录（其余七枚见 `tv-a4-toolbar.md` 等）；`--token-limit 500` 是体积闸门（按批次清单 §7「count 是下界、不是目标数」的口径从 52 放大），正式趟第 7 行就是文件末行、全文无 `[truncated` 标记 ⇒ 闸门没切到这趟载荷
- 完整性：本面 stdout 里**没有 completeness 块**（批次清单 §4 写死的 A4 形状，本席在八份 A4 留档上逐一复验：`grep -c completeness` 均为 0）⇒ 没有 `status` 值可照抄，本键记的是「这一面的提供方不给完整性读数」这一事实；本面也不给解析计数类键，所以那类键的值无从解释
- 用途：规格
- 取证时间：2026-10-13T22:37:04+08:00（留档落盘 mtime；本面 stdout 里没有 `captured_at`／时间戳键，只有主键与 `selected_node`／`listeners` 两类读数）

## 摘录（逐字，未改写）

整份 stdout 就是下面 7 行（195 字节），全录、无省略，所以没有 `...` 分段行。格式是 REA 默认的 toon 缩进文本，不是 JSON，围栏标 `text`。

```text
evidence_id: ev_35835c564fa379c134808ebcc42b2eac34fb26800c2fe60c3646d80a0f757ded
normalized_result:
  selected_node:
    selector: canvas
    match: found
    backend_node_id: 89
  listeners: []
```

## 读数含义

**留档行号（`grep -n` 可反查，文件＝`%TEMP%\rea-t10b\a4-canvas.txt`）**：`evidence_id` 第 1 行；`normalized_result` 第 2 行；`selected_node` 块 3-6（`selector` 第 4 行、`match` 第 5 行、`backend_node_id` 第 6 行）；`listeners` 第 7 行（＝文件末行，`wc -l`＝7）。主键是写档前 `sed -n '1p' a4-canvas.txt` 当场取的，与摘录首行同值同趟。

- **本面撑得住的结论**：selector `canvas` 在该页**命中**（`match: found`，第 5 行），且命中节点拿到了 CDP 后端句柄（`backend_node_id: 89`，第 6 行）⇒ 「按这个写法能指到对方页面上的一处 canvas 节点」是有证据面的；`--filter-output` 三个点分路径全部有产出，说明 A4 的收口口径在这个写法组合下是有效的。
- **本面撑不住的结论（三条，都要写清）**：
  - `listeners: []`（第 7 行）**不等于**「那处节点没有事件绑定」。这一面报的是**原生监听器枚举**的读数，「枚举不到」与「确实为零」在 stdout 里同形（提供方没给区分键，本面也没有 `sources`／`listener_count` 之类可参照的键）。⇒ L1 里「图表画布不响应任何事件」这种句子在本面没有证据面，只能写成「按这一枚 selector 的原生监听器枚举读数为空」。
  - **命中的是哪一枚**读不到：`canvas` 这类 selector 在 TV 页上通常不止一枚（A1 那面的 `dom` 段就数出 20 个 `CANVAS` 节点），而本面 stdout 只给**单个** `selected_node`、没有命中基数键，也没有序号／坐标读数 ⇒ 「它是主图表那枚 canvas」是**我方假设**，本面证明不了，要靠判据引用它的记录在 L1 里另找依据。
  - 属性值级事实（class／id／尺寸）在本面一律读不到：本面只回 `selector` 回显、`match`、`backend_node_id` 三个字段，属性值面的读数规则同批次清单 §4 第一条与 `tv-a1-page.md`。
- **合规自证（批次清单 §2 红线／§3②）**：本面把过滤键止步于 `normalized_result.selected_node,normalized_result.listeners`，留档上 `grep -ci` 对 `source`／`text`／`sha256`／`producer_hash` 四个词**全为 0** ⇒ `inspect-web-event-listeners` 默认内联回调所在脚本源码正文那条路被这条过滤挡住了，对方脚本一个字都没进留档，也就没进仓。
- **selector 回显的形状**：`selected_node.selector`（第 4 行）写作 `canvas`，与实参一致；对带引号的实参本提供方会把内层引号去掉再回显（见 `tv-a4-toolbar.md` 那条对照），这一面对本枚无影响，记在这里免得后续席把它当成改写实参。
