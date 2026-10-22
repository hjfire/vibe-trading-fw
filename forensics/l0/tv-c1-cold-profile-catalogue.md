# L0：TV 周期目录展开态（全新 profile 冷启动）（面 C1）

- 命令：npx -y rea-agents@latest capture-browser-scenario '{"browser":{"mode":"connect","cdp_endpoint":"http://127.0.0.1:9223","target_id":"C5BCC8D9FC3468401FB74730008A0057"},"start_url":{"url":"https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL"},"actions":[{"step_id":"s1","action":"click","locator":{"kind":"role","role":"button","name":"1 day"}},{"step_id":"s2","action":"wait_for_timeout","duration_ms":1500}],"storage":{"cookies":[],"local_storage":[],"session_storage":[]},"secrets":[],"capture":{"after_each_step":[],"at_end":["accessibility","url"],"events":[],"network":{"request_body":false,"response_body":false,"header_values":false}}}' --token-limit 100000
- evidence_id：ev_230a99ebb5e40f9aa518bb95405a3009de82a165bb34d0d193c0b2d83e534fb8
- 浏览器：本趟 stdout 的 browser 块（第 65-70 行）mode connect／process_ownership external／cleanup disconnected-external／product Chromium／version **155.0.4283.62**；第 224-228 行 environment 的 id `Chromium@155.0.4283.62`、platform 与 architecture 都是 unknown、isolation none。**这枚 id 说的是提供方按 CDP 报出来的产品名，不是我方起的那枚可执行文件**：`%TEMP%\rea-slice6-cold\targets1.txt`（同端口的 `list_browser_targets` 趟，辅助趟主键 `ev_5d34be61f631639ed2beba4c80a3769c904b7481c7b859866a169a13a543f060`）第 13-18 行报 product `Edg/155.0.4283.62`、user_agent 里带 `HeadlessChrome/155.0.0.0 … Edg/155.0.0.0`，`/json/version` 现读同值。⇒ 挂载的是 **headless Edge**，提供方按 Chromium 报；两个名字都在这份记录里，别只引用一枚
- 目标 URL：https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL（parameters.start_url 回声第 15-17 行；at_end 的 url 工件第 190-196 行同值；三步 before_url／after_url 六块（95-99／100-104／131-135／136-140／167-171／172-176）逐字段相同 ⇒ 只点了一枚打开按钮，URL 一位没动）
- 观察条件：**另一个浏览器、另一个 profile**（这是本面存在的理由）。冷启动现场逐字（2026-10-22 当场从在飞进程读回，`Get-CimInstance Win32_Process -Filter "ProcessId=34512"` 的 `CommandLine`，PID 34512 由 `netstat -ano` 现读 127.0.0.1:9223 LISTENING 那行取得）：`"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" --headless=new --remote-debugging-port=9223 --user-data-dir=C:/Users/fire/AppData/Local/Temp/rea-slice6-cold/profile --disable-extensions --disable-sync --no-first-run --proxy-server=http://127.0.0.1:7897 https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL`；落盘只有 `%TEMP%\rea-slice6-cold\edge-cold.log` 一行 `DevTools listening on ws://127.0.0.1:9223/devtools/browser/43c36742-25af-4f3b-9e19-42b43c9b3426`（browser id 与 `/json/version` 现读逐字相同），**这支启动命令行当时没有 tee 成文件**，上面那串是事后从活进程命令行读回的，不是留档件；`--user-data-dir` 指一个本次新建的空目录（`profile/` 现读存在），⇒ 与 D1／D2／A17b／A18 那四趟所用的 `127.0.0.1:9222`／PID **14976**／`rea-slice6-t0\cdp-profile`（那枚命令行同样现读得到：`--headless=new --remote-debugging-port=9222 --user-data-dir=C:\Users\fire\AppData\Local\Temp\rea-slice6-t0\cdp-profile --proxy-server=http://127.0.0.1:7897 --window-size=1280,720 --no-first-run --no-default-browser-check …`）是**两个进程、两套 profile、两个端口**。target_id `C5BCC8D9FC3468401FB74730008A0057` 由 `list_browser_targets` 现读代入（`targets1.txt` 第 20-21 行那枚 page target，title `AAPL 343.99 ▲ +1.32%`）；命令行里的 environment 七枚（视口 1280×720、device_scale_factor 1、locale en-US、timezone UTC、color_scheme light、reduced_motion reduce、service_workers block，第 18-27 行回声）是**我方传进去的声明**，`mode: connect` 下提供方不能保证挂载后页面的 context 选项与它一致（顶层 limitations 逐字 `CDP attachment cannot recover pre-attach events or guarantee launch-time context options.`），且冷启动那支根本没有 `--window-size`；**一趟一个打开动作**：s1 click role:button／name `1 day`，s2 wait_for_timeout 1500ms；未 fill、未 select_option、未 check／uncheck、未点档位行（没换档）、未点 `Add custom interval`、未派发 Escape、未提交、未登录、未交易；闸门 --token-limit 100000，全文 `truncated` 标记计数 0
- 完整性：顶层 completeness.status=incomplete（216-220）、equality_eligible: false（218）、missing_sections[1]: events（219）、truncated_sections: []（220）——`capture.events: []` 命令行里逐字选的。步骤级三步逐枚 complete／equality_eligible: true／missing_sections: []／truncated_sections: []（120-124、156-160、201-205），三枚 status: completed 且 error: null（125-126、161-162、206-207）。第 222 行 confidence: observed、第 223 行 authority: controlled-replay
- 用途：规格
- 取证时间：2026-10-22T14:13:33+08:00（留档 `c1.txt` 落盘 mtime；stdout 只有 duration_ms **8153**（第 89 行）与逐步 elapsed_ms 2189／3767／1880（94、130、166））

## 本面读到的形状

`capture.after_each_step: []`（第 46 行）＋ `at_end[2]: accessibility,url`（第 47 行）⇒ 本趟只有一枚可达树工件，挂在 s2 之后（第 184-189 行：state captured／sha256 `4d00d21a75ea5653f88096e7b4df4d31099a7c63b146c90c2b506c6ff9ae2776`／bytes **9,351**／text 单行转义在第 189 行）。

围栏＝未转义副本 `%TEMP%\rea-slice6-cold\trees\c1-0.tree` 第 166-181 行，与 D2 记录第一枚围栏逐字同形（`[disabled]` 零枚），原缩进照抄、行内报价正文不转录：

```text
  - treegrid:
    - row "Add custom interval" [level=1]:
      - gridcell "Add custom interval…"
    - separator
    - row "Ticks" [expanded] [level=1]:
      - gridcell "Ticks"
    - menu
    - rowgroup "Ticks":
      - row "1 tick" [level=2]:
        - gridcell "1 tick"
        - gridcell "Add to favorites":
          - button "Add to favorites"
      - row "10 ticks" [level=2]:
        - gridcell "10 ticks"
        - gridcell "Add to favorites":
          - button "Add to favorites"
```

第二枚围栏＝同一副本第 282-289 行（Days 组头与当前档位行）：

```text
    - row "Days" [expanded] [level=1]:
      - gridcell "Days"
    - menu
    - rowgroup "Days":
      - row "1 day" [level=2] [selected]:
        - gridcell "1 day"
        - gridcell "Add to favorites":
          - button "Add to favorites"
```

## 承重读数：冷 profile 下目录行仍零 `[disabled]`，且「已在列表里」的两枚档位与热会话同值

| needle | C1（冷） | D2（热，逐字命令行相同） | D1（热，同一命令行） |
|---|---|---|---|
| `[disabled]` 全树 | **3** | 2 | 110 |
| 目录行的 `[disabled]` | **0** | 0 | 26 |
| `- row "` | 39 | 39 | 39 |
| `[level=1]`／`[level=2]` | 7／32 | 7／32 | 7／32 |
| `gridcell` | 73 | 73 | 73 |
| `rowgroup`／`- menu` | 6／6 | 6／6 | 6／6 |
| `button "Add to favorites"` | 32 | 32 | 32 |
| `gridcell "Remove"` | **2** | 2 | 2 |
| `[selected]` | 1（第 286 行） | 1（第 402 行） | 1（第 271 行） |
| `dialog`／`listbox`／`option ` | 0／0／0 | 0／0／0 | 0／0／0 |
| `- separator` | 14 | 15 | 14 |
| `This website uses cookies` | 1 | 1 | 1 |

C1 那 3 枚 `[disabled]` 逐枚是：第 19-20 行两枚无名 `- button [disabled]`（第一枚 toolbar，`Bar replay` 之后的 separator 之后，五枚面都在同一位置）＋第 114 行 `- button "There are currently no metrics for this symbol" [disabled]`（自选列表块，D1／D2 树里没有这一枚，属于会话态差异，不是目录差异）。⇒ **目录里一枚都没有。**

两处冷会话独有的读数，本面只登记形状、不解释成因：(i) `gridcell "Remove"` 仍恰 2 枚，落在第 230 与 244 行，倒查它们各自的行名逐字是 `2 minutes`（第 228 行）与 `10 minutes`（第 242 行）——**与热会话完全同一组**；本命令行 `storage.local_storage: []`／`session_storage: []`／`cookies: []` 且用的是空 profile，所以「哪两档已在列表里」这件事在本面**不可能**来自我方携带的存储，但我方也没有读数说明它来自哪里（服务器侧默认值？新访客布局？），**不许升级成结论**。(ii) 第 113 行那枚折叠形的自选列表文本比 D1 的第 99 行多尾巴 ` A AAPL` 三个 token，且本面同样没有 D2 那种摊开的报价块 ⇒ 折叠／摊开这一维跟 `[disabled]` 一样会跨趟翻，不能当结构判据。

## 与热会话那四趟的关系（本面为什么单独成一份，而不是并入 D2）

一份 L0 只对应一条 REA 命令与一个观察面：本面的 `cdp_endpoint` 端口、target_id、profile 目录三枚都与 D1／D2／A17b／A18 不同，`scenario_sha256` 也不同一枚——第 62 行是 `878e7c5b668852d3c4aa71f974559f8e73f0e6a4db368361bf6f64a99b888a75`，而那四趟里 D1／D2 同为 `91759c5f…`（命令行逐字相同），A17b／A18 因 actions 与 capture 形状不同各有自己的指纹。⇒ 本面提供的是一条**独立的第二现场**：`[disabled]` 的批量出现不随 profile 复用，也不随会话年龄出现。D1 那 110 枚因此更明确地不能读成「TV 目录的固有属性」。

## 读数含义

**留档行号（`grep -n` 可反查；文件＝`%TEMP%\rea-slice6-cold\c1.txt`，19,034 字节／232 行）**：`evidence_id` 第 1 行；parameters 回声 browser 11-14（端口 9223 在第 13 行、target_id 第 14 行）、start_url 15-17、environment 18-27、actions[2] 28-39（s1 的 locator 31-34、s2 的 duration_ms 39）、capture 45-61（`after_each_step: []` 第 46 行、`at_end[2]` 第 47 行）、`scenario_sha256` 第 62 行；normalized_result browser 64-70、scenario 71-88、`duration_ms: 8153` 第 89 行；steps[3] 表头行 90，scenario_start 步 91-127（elapsed 94＝2189，completeness 120-124，status／error 125-126），s1 步 128-163（elapsed 130＝3767，completeness 156-160，status／error 161-162），s2 步 164-207（elapsed 166＝1880，artifacts 179，accessibility 184-189（sha 187、bytes 188＝**9,351**、树文本单行 189），url 工件 190-196，completeness 201-205，status／error 206-207）；events 208-215（retained 0／dropped 0）；顶层 completeness 216-220；limitations[9] 行 221；confidence 222、authority 223、environment 224-228、顶层 limitations[11] 行 229；relationship_coverage 230、locations／evidence_links 231-232。

主键 `sed -n '1p' c1.txt` 当场取，与本记录 `evidence_id：` 同值同趟。逐字命令行在 `%TEMP%\rea-slice6-cold\c1.cmd`（668 字节，本记录 命令： 与它逐字相同）。

未转义副本 `trees/c1-0.tree` 由本目录里的 `split-trees.py` 写出（还原第 189 行 `text:` 载荷的 `\n` 与 `\"`；`write_text` 在 Windows 默认写 CRLF）。**字节对账**：`wc -c` = 9,680，`tr -cd '\r' | wc -c` = 329，9,680 − 329 = **9,351** ＝ stdout 第 188 行的 artifact bytes。行数按 `grep -c '' c1-0.tree` = 330（`wc -l` 报 329，末行无换行符少一）。needle 一律 `grep -c -F -e '…'` 或 `grep -c -E -e '…'`。

提供方自陈（第 221 行 limitations[9] 与第 229 行顶层 limitations[11]，与本面判据相关的四条逐字子串）：`Artifact identity is unavailable for this observation.`、`CDP attachment cannot recover pre-attach events or guarantee launch-time context options.`、`Attached locale en-US applies to Intl formatting only; navigator.language(s) and Accept-Language remain caller-controlled. Use launch mode for matching page and request languages.`、`Browser host platform and architecture were not observed.`。第二与第四条在冷 profile 这一面上尤其承重：本面既没有挂载前的历史，也没有 host 平台读数，所以它只能证否（「这一趟没有 disabled」），不能独立立起任何「TV 在某条件下会……」的正面因果句。
