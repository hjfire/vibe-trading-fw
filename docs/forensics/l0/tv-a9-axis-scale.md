# L0：TV 图表页刻度与轴的像素面（面 A9）

- 命令：npx -y rea-agents@latest capture-web-screenshot http://127.0.0.1:9222 162F72C6F52A032716B333A93738AEC8 --allowed-origins https://www.tradingview.com --filter-output evidence_id,normalized_result --token-limit 150000
- evidence_id：ev_1ca1a62b385a43a45a5223597a62970a60c5e4f6e2c5d77aaa3413ab7b3cc976
- 浏览器：Edg/155.0.4283.45（protocol_version "1.3"，js_version 15.5.9.4，revision 537.36 (@50f24ef2aa5369a074b8888b7db82d9c0652d642)；本趟 stdout 第 3-8 行自带 browser 块，与同一现场的挂载趟 `targets-3.txt:16-20` 逐字相符，该趟 `targets[1]` 行的 `target_id` 就是本条 命令： 的入参（`targets-3.txt:22`））
- 目标 URL：https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL
- 留档（仓外临时件，会随清理消失）：`C:\Users\fire\AppData\Local\Temp\rea-t10b\a9.txt`（正式趟整份 stdout，39 行／301,831 字节，其中**第 21 行 `data_base64` 单行就占 300,417 字节＝图像本体，一个字都不进仓**）；同目录 `a9.cmd`（逐字命令行，216 字节）、`a9-count.txt`（`--token-count` 读数＝62,017）
- 观察条件：Edge `--headless=new` ＋ `--remote-debugging-port=9222` ＋ 专属 profile 目录 `%TEMP%\rea-cdp-profile-t10b` ＋ `--proxy-server="http://127.0.0.1:7897"`（当次 `reg query` 现读：`ProxyEnable=0x1`／`ProxyServer=127.0.0.1:7897`；裸连那一腿当次实测 `http_code=000`／`curl` 退出码 28 连接失败，带代理那一腿＝200）；URL 走 Edge 命令行参数；未点按、未滚动、未派发事件、未登录、未改 UA、未禁用优化；观察窗＝当次可见视口 746×483（第 15-16 行，是**浏览器窗口几何**，不是对页面上任何元素的尺寸测量）；提供方自陈不滚动、不执行 JS、不越当前视口（第 39 行 `limitations[2]` 原文）；一次一面——本条只有 A9 这一个像素面，作为对比基线的那趟在 `tv-a15-pixel-baseline.md`
- 完整性：completeness.status=complete_within_window（第 23 行照抄）；conditions[1]=complete_within_window（24）；policy_filtered_sections／attach_limited_sections／truncated_sections／unavailable_sections／excluded 五项全是空列表（25-29）；dropped_events 七类＋total 计数全为 0（30-38）；全文 `grep -c '[truncated'`＝0 ⇒ `--token-limit 150000` 这一闸门没切到这趟载荷（count 读数 62,017 是下界，按批次清单 §7 的口径放大后才跑正式趟）
- 用途：基线
- 取证时间：2026-10-13T22:40:24+08:00（留档落盘 mtime；同一 stdout 第 13 行 `captured_at` 写作 `2026-10-13T14:40:24.921Z`，即 UTC）

## 摘录（逐字，未改写）

从 39 行／301,831 字节的留档里按行号切出的**分段**（行号见「读数含义」开头），分段之间用一行 `...` 标注被略过的部分。**第 21 行 `data_base64`（图像本体，300,417 字节）故意不转录**——批次清单 §2 的像素红线：像素证据只准落 `sha256`＋`bytes`＋`media_type` 三键。第 7 行 `user_agent`（我方浏览器的 UA 串）与像素无关，也一并不转录，只说明它存在于第 7 行。格式是 REA 默认的 toon 缩进文本，围栏标 `text`。

```text
evidence_id: ev_1ca1a62b385a43a45a5223597a62970a60c5e4f6e2c5d77aaa3413ab7b3cc976
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
  captured_at: "2026-10-13T14:40:24.921Z"
  viewport:
    width: 746
    height: 483
  artifact:
    sha256: 4abcd9a55eb4caa16fa2028f355bd18ac42e827957452407dd5464922bf71f9c
    bytes: 225300
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

**留档行号（`grep -n` 可反查，文件＝`%TEMP%\rea-t10b\a9.txt`）**：`evidence_id` 第 1 行；`normalized_result` 第 2 行；browser 块 3-8（`product` 4／`protocol_version` 5／`revision` 6／未转录的 `user_agent` 7／`js_version` 8）；target 块 9-12（`target_id` 10／`url` 11／`origin` 12）；`captured_at` 13；viewport 块 14-16（`width` 15／`height` 16）；artifact 块 17-21（`sha256` 18／`bytes` 19／`media_type` 20／**`data_base64` 21＝图像本体，不进仓**）；completeness 块 22-38（`status` 23／`conditions[1]` 24／五个空列表 25-29／`dropped_events` 30-38）；`limitations[2]` 第 39 行＝文件末行。摘录里两处 `...` 分别略过第 7 行与第 21 行、以及第 30-37 行的七条 `dropped_events` 计数行。主键 `sed -n '1p' a9.txt` 当场取，与摘录首行同值同趟。

- **本面撑得住的结论（只有这一级）**：`capture-web-screenshot` 在真实 TV 图表页上单趟可用，并给出**可比对的像素指纹**——`sha256` 4abcd9a5…71f9c、`bytes` 225,300、`media_type` `image/png`（第 18-20 行），且当次视口几何是 746×483（第 15-16 行）。⇒ 「这一处存在可截取、可指纹化的视口像素」有证据面；批次清单 §1 给 A9 设定的产物形状（三键）就是上面这三行。
- **本面撑不住的结论（写清，否则 L1 会越界）**：
  - **「刻度与轴长什么样」本面一个字都没答**。面名叫「刻度与轴」，但本趟的产出只有整视口的像素指纹——没有刻度档位、轴标签文本、字号、颜色、坐标位置的任何一个读数（stdout 里根本没有这些键）。⇒ 判据类型「像素」的条目在这一版**只能引到 `sha256`／`bytes` 级**，写不出「价格轴有 N 档刻度」这类句子；那种句子要靠 ② 交互面的可达名读数或后续修好环境后的对比工具，不该由本面承担。
  - 「图里是不是空白页」本面证不了：本体不进仓，`bytes` 大不等于内容正确。页面非空白的旁证在另外两趟（挂载趟 `targets-3.txt:22` 的 `title` 字段报了当次报价标题，按 A1 记录同一口径其值不转录；`tv-a1-page.md` 那趟的 `dom.total_nodes`），本面不据此下结论。
  - 「截图像素差多少」不能写：`compare-web-screenshots` 吃磁盘路径 ⇒ 本机 ESTALE 坏路（批次清单 §5③），本面只有单趟读数。
  - 「视口 746×483 说明了对方布局」——不说明。那是我方起的 headless 窗口几何，不是对方的尺寸声明。
- **闸门与体积的实测形状**：`--token-count` 报 62,017（`a9-count.txt:1`），正式趟按 §7「count 是下界」放大到 150,000 后整份 39 行落到第 39 行 `limitations[2]` 结束、无 `[truncated` 标记 ⇒ 收口成功。这一面也是本批次**唯一两份大留档**之一：整份 stdout 始终重定向进文件，终端只回读 `grep -n` 定位后的行切片（第 21 行单行 300,417 字节，打进终端就是自我 DoS）。
- **合规自证**：进仓的只有三键指纹与结构键名；`data_base64` 留在 `%TEMP%\rea-t10b\a9.txt` 第 21 行（仓外、随清理消失），本体一个字节都不进仓，也不进本记录的摘录（§2 像素红线＋裁定 1 表达层那条）。
