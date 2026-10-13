# L0：TV 图表页 `[role="menu"]` 节点的原生监听器可达性探针（面 A4／a4-rolemenu，**not_found**）

- 命令：npx -y rea-agents@latest inspect-web-event-listeners http://127.0.0.1:9222 162F72C6F52A032716B333A93738AEC8 --allowed-origins https://www.tradingview.com "[role="menu"]" --filter-output evidence_id,normalized_result.selected_node,normalized_result.listeners --token-limit 500
- evidence_id：ev_a908bc8e5aa89e1cfb4b1776d3cb5df57eee257f62947f5c26666f3403221013
- 浏览器：Edg/155.0.4283.45（protocol_version "1.3"，js_version 15.5.9.4，revision 537.36 (@50f24ef2aa5369a074b8888b7db82d9c0652d642)，本趟 stdout 被 `--filter-output` 收到只剩 `selected_node`／`listeners`，没有 browser 块 ⇒ 取自**同一现场的挂载趟** `targets-2.txt:16-20`；该趟 `targets[1]` 行的 `target_id` 即本条 命令： 的入参（`targets-2.txt:22`））
- 目标 URL：https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL
- 留档（仓外临时件，会随清理消失）：`C:\Users\fire\AppData\Local\Temp\rea-t10b\a4-rolemenu.txt`（正式趟整份 stdout，7 行／208 字节，是八枚 A4 里最大的一份）；同目录 `a4-rolemenu.cmd`（逐字命令行，276 字节）、`a4-rolemenu-count.txt`（`--token-count` 读数＝59，八枚里最高，与「未命中也照样有读数」这一形状一致）
- 观察条件：Edge `--headless=new` ＋ `--remote-debugging-port=9222` ＋ 专属 profile 目录 `%TEMP%\rea-cdp-profile-t10b` ＋ `--proxy-server="http://127.0.0.1:7897"`（当次 `reg query` 现读：`ProxyEnable=0x1`／`ProxyServer=127.0.0.1:7897`）；URL 走 Edge 命令行参数；**未做任何点按**，所以本趟的观察条件是「菜单从未被打开过」的静态页；selector 实参 `[role="menu"]` 是我方入参；一次一面；`--token-limit 500` 体积闸门，第 7 行即末行、无 `[truncated` 标记
- 完整性：本面 stdout 里**没有 completeness 块**（A4 形状，八份留档复验 `grep -c completeness`＝0）⇒ 无 `status` 可抄；**注意这一面是 `not_found` 而 `rc` 仍是 0、不报错**，命令成功与「没找到」是两件事，本记录的 完整性： 与其余七枚同一形状
- 用途：基线
- 取证时间：2026-10-13T22:37:14+08:00（留档落盘 mtime；本面 stdout 无时间戳键）

## 摘录（逐字，未改写）

整份 stdout 就是下面 7 行（208 字节），全录、无省略。围栏标 `text`（REA 默认 toon 缩进文本）。

```text
evidence_id: ev_a908bc8e5aa89e1cfb4b1776d3cb5df57eee257f62947f5c26666f3403221013
normalized_result:
  selected_node:
    selector: "[role=menu]"
    match: not_found
    backend_node_id: null
  listeners: []
```

## 读数含义

**留档行号（`grep -n` 可反查，文件＝`%TEMP%\rea-t10b\a4-rolemenu.txt`）**：`evidence_id` 第 1 行；`normalized_result` 第 2 行；`selected_node` 块 3-6（`selector` 4、`match` 5、`backend_node_id` 6＝`null`）；`listeners` 第 7 行（末行）。主键 `sed -n '1p' a4-rolemenu.txt` 当场取，与摘录首行同值同趟。

- **这一枚是八枚里唯一的 `not_found`，它照样是一份证据（不是「不可取证」）**：命令成功、有主键、有整份 stdout 读数 ⇒ 按批次清单 §7「未命中的也各占一份，如实记 `not_found`」落档。这一面撑得住的结论只有一句：**在当次现场、当次静态页状态下，`[role="menu"]` 这一写法在对方页面上没命中**（第 5 行），且没命中时 `backend_node_id` 给的是 `null`（第 6 行）而不是缺键 ⇒ 「命中与否」与「命中的句柄」这两个字段是**可分的**，这正是 §4 要求写进记录规则的那件事：少了 `selected_node` 就分不清「selector 没命中」与「命中但零监听器」，本面与其余七面对照把它钉住了。
- **本面撑不住的结论（三条）**：
  - **不许**读成「TV 没有菜单」或「TV 不用 `role=menu`」。头号成因是我方观察条件本身：菜单类节点通常是**点开之后**才挂进 DOM，而本席按纪律一个点按都没做（简报明列本席无需点按动作）。⇒ 「菜单在页面上存在吗」这句话在本面既证不成也证否不了，它要靠 ② 交互面自己的记录（A5／A7 那类点开后的可达名读数）才谈得上。
  - 也不排除**写法造成**：`role="menu"` 只是我方假设的一种命名，对方可能用别的角色值或容器写法（批次清单 §4「空面要先排除写法导致再读成没有」的口径同样适用于 `not_found`）。本面对此没有读数。
  - 不许把它写成「A1 确认过没有 menu」：A1 那面的角色分布里确实也没有 `menu` 这一项，但那是**另一趟**的无障碍树枚举，与本面的 DOM selector 查询不是同一证据；两趟各有各的主键，混引就是 §7 末尾要防的那种混面。
- `listeners: []`（第 7 行）在 `not_found` 之下的读法：它是「没有可挂的节点」的必然结果，**不携带**任何关于监听器枚举面的信息。⇒ 这一枚不能进「原生监听器为空」那一族结论（那七枚 `match: found` 而 `listeners: []` 的才有那个语境）。
- **selector 回显形状**：实参 `[role="menu"]` 回显为 `"[role=menu]"`（第 4 行，内层引号被去掉），与 a4-toolbar 那枚同形；`命令：` 那一行仍是我实际交出去的实参（逐字见 `a4-rolemenu.cmd`）。
- **合规自证**：过滤键止步于 `selected_node,listeners`；留档上 `source`／`text`／`sha256`／`producer_hash` 四个词 `grep -ci` 全为 0；本面连节点都没命中，谈不上对方表达层内容。
