# L0：TV 图表页像素基线（面 A15）

- 命令：npx -y rea-agents@latest capture-web-screenshot http://127.0.0.1:9222 162F72C6F52A032716B333A93738AEC8 --allowed-origins https://www.tradingview.com --filter-output evidence_id,normalized_result --token-limit 150000
- evidence_id：ev_1f8ffe80a2d8738bb026395c5422ca69722ce9a0e45d847be13ed3370b2c891e
- 浏览器：Edg/155.0.4283.45（protocol_version "1.3"，js_version 15.5.9.4，revision 537.36 (@50f24ef2aa5369a074b8888b7db82d9c0652d642)；本趟 stdout 第 3-8 行自带 browser 块，与同一现场的挂载趟 `targets-3.txt:16-20` 逐字相符，该趟 `targets[1]` 行的 `target_id` 就是本条 命令： 的入参（`targets-3.txt:22`））
- 目标 URL：https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL
- 留档（仓外临时件，会随清理消失）：`C:\Users\fire\AppData\Local\Temp\rea-t10b\a15.txt`（正式趟整份 stdout，39 行／310,371 字节，其中**第 21 行 `data_base64` 单行占 308,957 字节＝图像本体，不进仓**）；同目录 `a15.cmd`（逐字命令行，216 字节）、`a15-count.txt`（`--token-count` 读数＝64,348）
- 观察条件：与 A9 **同一条命令、同一 target、同一现场**的**另起一趟**（批次清单 §1 对 A15 的定义就是「同 A9，另起一趟作为后续对比的基线 id」）；Edge `--headless=new` ＋ 9222 ＋ 专属 profile 目录 `%TEMP%\rea-cdp-profile-t10b` ＋ 当次 `reg query` 现读到的系统代理 `http://127.0.0.1:7897`；未点按、未滚动、未登录、未改 UA；视口几何 746×483（第 15-16 行）；两趟相隔 **5.184 秒**（本趟 `captured_at` 14:40:30.105Z vs A9 那趟 14:40:24.921Z，第 13 行）；一次一面——本条只有这一趟基线，被它对照的那趟在 `tv-a9-axis-scale.md`
- 完整性：completeness.status=complete_within_window（第 23 行照抄）；conditions[1]=complete_within_window（24）；policy_filtered_sections／attach_limited_sections／truncated_sections／unavailable_sections／excluded 全为空列表（25-29）；dropped_events 七类＋total 计数全 0（30-38）；`grep -c '[truncated'`＝0 ⇒ 150,000 的闸门没切到这趟载荷（count 读数 64,348 为下界）
- 用途：基线
- 取证时间：2026-10-13T22:40:30+08:00（留档落盘 mtime；同一 stdout 第 13 行 `captured_at` 写作 `2026-10-13T14:40:30.105Z`，即 UTC）

## 摘录（逐字，未改写）

从 39 行／310,371 字节的留档（`a15.txt`）按行号切出的**分段**；**第 21 行 `data_base64`（图像本体，308,957 字节）故意不转录**，第 7 行 `user_agent` 同样不转录（只说明其存在），第 30-37 行的七条 `dropped_events` 计数行以 `...` 略过。像素证据只落三键（§2 红线）。围栏标 `text`（toon 缩进文本）。

```text
evidence_id: ev_1f8ffe80a2d8738bb026395c5422ca69722ce9a0e45d847be13ed3370b2c891e
normalized_result:
  browser:
    product: Edg/155.0.4283.45
    protocol_version: "1.3"
    revision: 537.36 (@50f24ef2aa5369a074b8888b7db82d9c0652d642)
...
    js_version: 15.5.9.4
  target:
    target_id: 162F72C6F52A032716B333A93738AEC8
    url: "https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL"
    origin: "https://www.tradingview.com"
  captured_at: "2026-10-13T14:40:30.105Z"
  viewport:
    width: 746
    height: 483
  artifact:
    sha256: 52e92a8a4ca1fb39831f5b0529aff7845b6532f26bf143f0b174f95e863a82b3
    bytes: 231704
    media_type: image/png
...
  completeness:
    status: complete_within_window
    conditions[1]: complete_within_window
    policy_filtered_sections: []
    attach_limited_sections: []
    truncated_sections: []
    unavailable_sections: []
    excluded: []
    dropped_events:
...
      total: 0
  limitations[2]: "The screenshot contains the visible viewport, including on-screen content.","REA does not scroll, evaluate JavaScript, or capture beyond the current viewport."
```

## 读数含义

**留档行号（`grep -n` 可反查，文件＝`%TEMP%\rea-t10b\a15.txt`）**：结构与 A9 那份逐行同构：`evidence_id` 1；browser 3-8（未转录的 `user_agent` 7）；target 9-12；`captured_at` 13；viewport 14-16；artifact 17-21（`sha256` 18／`bytes` 19／`media_type` 20／`data_base64` 21）；completeness 22-38；`limitations[2]` 39＝末行。主键 `sed -n '1p' a15.txt` 当场取，与摘录首行同值同趟。

- **本面最有价值的一句读数是两趟的对照**：A9 那趟 `sha256` 4abcd9a5…71f9c／`bytes` 225,300，本趟 `sha256` 52e92a8a…82b3／`bytes` 231,704——**同一 target、同一命令、同一视口几何、相隔 5.184 秒，两个指纹不同、字节数差 6,404**。⇒ 这就是批次清单 §5③ 说的「像不像这一版只能读到字节变了没变」的第一对实测样本，且它的读数是**「变了」**。
- **由此能写进 L1 的口径（与不能写的）**：
  - 能写：「像素面的判据在这一版只能是**指纹等值**形状（`sha256` 与 `bytes` 两个可比对值），不能是**期望常量**形状」——因为「同位置重跑字节稳定」这个假设被本席这两趟直接否证；任何把某个 `sha256` 值写死的判据在对方页上都不可复现。
  - 不能写：「像素差异是 x%」——没有对比读数（`compare-web-screenshots` 吃磁盘路径 ⇒ 本机 ESTALE 坏路，§5③），两趟之间也没有差分键。
  - 不能写：「字节变了是因为行情数字在动／光标在闪／懒加载补完了」——归因**没有证据面**。两趟 `captured_at` 只差 5.184 秒，页面自陈不滚动不越视口（第 39 行 `limitations[2]`），提供方没给任何「什么变了」的键。旁证只有一条、且属另外两趟：挂载趟 `targets.txt:22` 与 `targets-3.txt:22` 的 `title` 字段值在两次阅读之间不同（该字段是当次报价标题，按 A1 记录同一口径不转录其值）⇒ 「当次会话内页面内容确实在变」有读数，但它与本趟字节差之间的因果是我方推测，不许写成结论。
- **本面撑不住的结论（同 A9，再列一遍免得后续席误用）**：刻度档位、轴标签文本、字号、配色、坐标位置——stdout 里一个都没有；「图像非空白」本面也证不了（本体不进仓）；「746×483 是对方要求的尺寸」不成立（那是我方 headless 窗口几何）。
- **闸门形状**：`--token-count` 报 64,348（`a15-count.txt:1`，比 A9 那趟的 62,017 高 2,331，与两趟字节数同向）⇒ 正式趟按 §7 的「下界」口径放大到 150,000，整份落到第 39 行、无 `[truncated` 标记。
- **基线 id 的用途**：这一趟的价值就在**它自己有独立主键**（`ev_1f8ffe80…c891e`，与 A9 的 `ev_1ca1a62b…b3cc976` 不同趟不同键）。后续席若在同位置重跑，可与这两把逐一比对，读到的仍然是「指纹变没变」而不是「像不像」。
- **合规自证**：进仓只有三键指纹＋结构键名＋两趟的 `captured_at`；`data_base64` 留在 `%TEMP%\rea-t10b\a15.txt` 第 21 行（仓外，随清理消失），图像本体一字节都不进仓。
