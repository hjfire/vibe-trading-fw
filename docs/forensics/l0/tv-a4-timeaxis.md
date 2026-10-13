# L0：TV 图表页 `[class*="time"]`（时间轴候选）节点的原生监听器可达性探针（面 A4／a4-timeaxis）

- 命令：npx -y rea-agents@latest inspect-web-event-listeners http://127.0.0.1:9222 162F72C6F52A032716B333A93738AEC8 --allowed-origins https://www.tradingview.com "[class*="time"]" --filter-output evidence_id,normalized_result.selected_node,normalized_result.listeners --token-limit 500
- evidence_id：ev_a24cf7b6df68ee9682746ed04d8573a419ae5026001b4145ef0811f2e4ce11c8
- 浏览器：Edg/155.0.4283.45（protocol_version "1.3"，js_version 15.5.9.4，revision 537.36 (@50f24ef2aa5369a074b8888b7db82d9c0652d642)，本趟 stdout 被 `--filter-output` 收到只剩 `selected_node`／`listeners`，没有 browser 块 ⇒ 取自**同一现场的挂载趟** `targets-2.txt:16-20`；该趟 `targets[1]` 行的 `target_id` 即本条 命令： 的入参（`targets-2.txt:22`））
- 目标 URL：https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL
- 留档（仓外临时件，会随清理消失）：`C:\Users\fire\AppData\Local\Temp\rea-t10b\a4-timeaxis.txt`（正式趟整份 stdout，7 行／205 字节）；同目录 `a4-timeaxis.cmd`（逐字命令行，278 字节）、`a4-timeaxis-count.txt`（`--token-count` 读数＝58）
- 观察条件：Edge `--headless=new` ＋ `--remote-debugging-port=9222` ＋ 专属 profile 目录 `%TEMP%\rea-cdp-profile-t10b` ＋ `--proxy-server="http://127.0.0.1:7897"`（当次 `reg query` 现读：`ProxyEnable=0x1`／`ProxyServer=127.0.0.1:7897`）；URL 走 Edge 命令行参数；未点按、未派发事件、未登录、未改 UA；selector 实参 `[class*="time"]` 是子串匹配的我方入参，`time` 这一段是我方对「时间轴」的押注，不是从对方页面读来的 class 值；一次一面；`--token-limit 500` 体积闸门，第 7 行即末行、无 `[truncated` 标记
- 完整性：本面 stdout 里**没有 completeness 块**（A4 形状，八份留档复验 `grep -c completeness`＝0）⇒ 无 `status` 可抄；不给解析计数类键
- 用途：基线
- 取证时间：2026-10-13T22:39:21+08:00（留档落盘 mtime；本面 stdout 无时间戳键）

## 摘录（逐字，未改写）

整份 stdout 就是下面 7 行（205 字节），全录、无省略。围栏标 `text`。

```text
evidence_id: ev_a24cf7b6df68ee9682746ed04d8573a419ae5026001b4145ef0811f2e4ce11c8
normalized_result:
  selected_node:
    selector: "[class*=time]"
    match: found
    backend_node_id: 124
  listeners: []
```

## 读数含义

**留档行号（`grep -n` 可反查，文件＝`%TEMP%\rea-t10b\a4-timeaxis.txt`）**：`evidence_id` 第 1 行；`normalized_result` 第 2 行；`selected_node` 块 3-6（`selector` 4、`match` 5、`backend_node_id` 6）；`listeners` 第 7 行（末行）。主键 `sed -n '1p' a4-timeaxis.txt` 当场取，与摘录首行同值同趟。

- **本面撑得住的结论**：页面上存在 class 含 `time` 子串的节点且可被 A4 指到（第 5 行 `match: found`、第 6 行句柄数值 124）；三趟读到的句柄**数值**互不相同（本趟 124，a4-legend 那趟 122、a4-priceaxis 那趟 85——复算：`cd "$TEMP/rea-t10b" && grep -n backend_node_id a4-timeaxis.txt a4-legend.txt a4-priceaxis.txt`，原始读数逐字 `a4-timeaxis.txt:6:    backend_node_id: 124`／`a4-legend.txt:6:    backend_node_id: 122`／`a4-priceaxis.txt:6:    backend_node_id: 85`）。但 CDP `backend_node_id` 是**会话内句柄**，这三枚来自三趟各跑一次、各自主键的三次会话 ⇒ **跨 session 不保证可比**：既不据此断言它们命中的是三个不同节点，也不据此排序（本面也没有「句柄大小＝文档顺序」这类语义键；同批 `tv-a4-rolemenu.md` 那条「两趟各有各的主键」的口径就是禁止把跨趟读数拼成存在性结论）。本面撑住的只有「按这个写法，本趟读到 found＋句柄 124」这一句。
- **本面撑不住的结论**：
  - 「命中的那枚就是时间轴」——子串匹配命中任何 class 带 `time` 的元素都可能（周期按钮、时间戳显示、datetime 类名都算），本面无位置／尺寸键。⇒ 「时间轴组件」这句在本面没有证据面。
  - 「命中几枚」——无基数键，读不到。
  - 「时间轴／周期切换处挂的是哪种原生监听器」——`listeners: []`（第 7 行）为空，本面答不了。空读数的正确读法与 a4-priceaxis.md 那条相同：**枚举为空 ≠ 没有事件绑定**，只是原生监听器枚举面拿不到；这一面撑住的只有「按这个写法读数为空」这一句。
  - 对方的 class 命名值——本面不提供，也不该提供（stdout 里只有我方 selector 的回显）。
- **selector 回显形状**：实参 `[class*="time"]` 回显为 `"[class*=time]"`（第 4 行，去内层引号），与其余属性选择器那几枚同形；逐字实参见 `a4-timeaxis.cmd`。
- **合规自证**：过滤键止步于 `selected_node,listeners`；留档上 `source`／`text`／`sha256`／`producer_hash` 四个词 `grep -ci` 全为 0。
