# L0：TV 周期目录展开态（本趟整张目录批量 `[disabled]`）（面 D1）

- 命令：npx -y rea-agents@latest capture-browser-scenario '{"browser":{"mode":"connect","cdp_endpoint":"http://127.0.0.1:9222","target_id":"F8C74D44F97CE231B2B173860B31632F"},"start_url":{"url":"https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL"},"actions":[{"step_id":"s1","action":"click","locator":{"kind":"role","role":"button","name":"1 day"}},{"step_id":"s2","action":"wait_for_timeout","duration_ms":1500}],"storage":{"cookies":[],"local_storage":[],"session_storage":[]},"secrets":[],"capture":{"after_each_step":[],"at_end":["accessibility","url"],"events":[],"network":{"request_body":false,"response_body":false,"header_values":false}}}' --token-limit 100000
- evidence_id：ev_cfebd3d03088b358e1a6cea1844591a8f4d07ee76775915a023ee70d1b47c913
- 浏览器：本趟 stdout 的 browser 块（第 65-70 行）自带形读数 mode connect／process_ownership external／cleanup disconnected-external／product Chromium／version **155.0.4283.62**；第 224-228 行 environment 的 id 为 `Chromium@155.0.4283.62`、platform 与 architecture 都是 unknown、isolation none。⇒ 挂载的是我方自起的 headless Edge，提供方按 CDP 报成 Chromium；platform/architecture 两枚 unknown 是提供方自陈（顶层 limitations 末条 `Browser host platform and architecture were not observed.`），不是我方没设
- 目标 URL：https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL（parameters.start_url 回声第 15-17 行；at_end 的 url 工件第 190-196 行同值；三步的 before_url 与 after_url 六块（95-99／100-104／131-135／136-140／167-171／172-176）逐字段相同，`query_parameter_names[1]: symbol`、`redacted: false` ⇒ **只点了一枚打开按钮，URL 一位没动**，本面不是导航面）
- 观察条件：Edge `--headless=new`（我方 PID **14976**，`%TEMP%\rea-slice6-t0\edge-launch.log` 顶行现读 `DevTools listening on ws://127.0.0.1:9222/devtools/browser/8d8cadee-6779-47ab-8b4e-7b4547821392`）＋ `--remote-debugging-port=9222` ＋ 专属新建 profile `%TEMP%\rea-slice6-t0\cdp-profile` ＋ `--proxy-server=http://127.0.0.1:7897`（当次 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` 现读 ProxyEnable=0x1／ProxyServer=127.0.0.1:7897）；target_id `F8C74D44F97CE231B2B173860B31632F` 由 `list_browser_targets` 现读后代入，与同 profile 的 A17／A17b／A18 三趟是**同一个页面会话**（本记录下面「同会话的前后趟」一节把这条当成主证据用）；视口 1280×720、device_scale_factor 1、locale en-US、timezone UTC、color_scheme light、reduced_motion reduce、service_workers block（第 18-27 行 environment 回声）——这七枚是**我方传进命令行的声明**，`mode: connect` 下提供方不保证挂载后页面的 context 与它一致（顶层 limitations 逐字 `CDP attachment cannot recover pre-attach events or guarantee launch-time context options.`）；那支 headless Edge 的命令行当场从在飞进程读回（`Get-CimInstance Win32_Process -Filter "ProcessId=14976"` 的 CommandLine）逐字含 `--headless=new --remote-debugging-port=9222 --user-data-dir=C:\Users\fire\AppData\Local\Temp\rea-slice6-t0\cdp-profile --proxy-server=http://127.0.0.1:7897 --window-size=1280,720 --no-first-run --no-default-browser-check`，没有 `--disable-extensions`／`--disable-sync`；**一趟一个打开动作**（合 `forensics/batch-A-playbook.md` §5①）：s1 click 一枚 role:button／name `1 day`，s2 wait_for_timeout 1500ms；未 fill、未 select_option、未 check／uncheck、未点档位行（**没有换档**）、未点 `Add custom interval`、未派发 Escape、未提交、未登录、未交易、未改 UA；闸门 --token-limit 100000，全文 `truncated` 标记计数 0
- 完整性：顶层 completeness.status=incomplete（第 216-220 行）、equality_eligible: false（218）、missing_sections[1]: events（219）、truncated_sections: []（220）——本趟 `capture.events: []`（命令行里逐字），不是页面上没有事件。步骤级三步（scenario_start／s1／s2）的 completeness **逐枚**都是 status: complete、equality_eligible: true、missing_sections: []、truncated_sections: []（120-124、156-160、201-205），三枚 status: completed 且 error: null（125-126、161-162、206-207）。第 222 行 confidence: observed、第 223 行 authority: controlled-replay。本记录 完整性： 抄顶层，两层都写明
- 用途：规格
- 取证时间：2026-10-22T12:59:40+08:00（留档 `d1.txt` 落盘 mtime；场景趟 stdout 无绝对时间戳键，只有 duration_ms **17602**（第 89 行）与逐步 elapsed_ms 10785／5006／1572（94、130、166））

## 本面读到的形状

`capture.after_each_step: []`（第 46 行）＋ `at_end[2]: accessibility,url`（第 47 行）⇒ 本趟**只有一枚**可达树工件，挂在最后一步 s2 之后（第 184-189 行：state captured／sha256 `3ba7ce8fa3d67467f01dbbf5cd5a7ce0480fb39118176ee881a69c3518c5b6e3`／bytes **10,126**／text 单行转义在第 189 行）。s1（开菜单那一刻）之后**没有**独立的树——与 A17b 那趟的 `after_each_step:["accessibility"]` 形状相反，两趟不能互相替补，见 A18 记录的同名交代。

围栏＝未转义副本 `trees/d1-0.tree` 的第 151-166 行（目录头部与 Ticks 组前两枚档位行），原缩进照抄，行内报价正文不转录：

```text
  - treegrid:
    - row "Add custom interval" [level=1]:
      - gridcell "Add custom interval…"
    - separator
    - row "Ticks" [expanded] [level=1]:
      - gridcell "Ticks"
    - menu
    - rowgroup "Ticks":
      - row "1 tick" [disabled] [level=2]:
        - gridcell "1 tick" [disabled]
        - gridcell "Add to favorites" [disabled]:
          - button "Add to favorites" [disabled]
      - row "10 ticks" [disabled] [level=2]:
        - gridcell "10 ticks" [disabled]
        - gridcell "Add to favorites" [disabled]:
          - button "Add to favorites" [disabled]
```

第二枚围栏＝同一副本第 267-278 行（Days 组头与它头两枚档位行）——这一组是本面最关键的一处对照，**同一棵树里、同样四种角色位置，`[disabled]` 一位都不在**：

```text
    - row "Days" [expanded] [level=1]:
      - gridcell "Days"
    - menu
    - rowgroup "Days":
      - row "1 day" [level=2] [selected]:
        - gridcell "1 day"
        - gridcell "Add to favorites":
          - button "Add to favorites"
      - row "1 week" [level=2]:
        - gridcell "1 week"
        - gridcell "Add to favorites":
          - button "Add to favorites"
```

⇒ 读到的形状三条，都能在围栏上手指点出来：(i) 分组行（`Ticks`／`Seconds`／`Minutes`／`Hours`／`Days`／`Ranges`）恒带 `[expanded]`，且组行自己**从不**带 `[disabled]`，`- menu` 与 `- rowgroup "组名"` 紧贴在组行之后；(ii) 档位行是 `[level=2]`、被包在 `rowgroup` 里，而 `Add custom interval` 那枚是 `[level=1]`、**不在**任何 rowgroup 内，它后面紧跟一枚 `- separator`；(iii) 当前档位 `[selected]` 恰一枚、落在 `1 day` 那行，且**只有**这一行同时带 `[level=2] [selected]`。

## 本面的承重读数：`[disabled]` 的批量出现与其按族分布

未转义副本 `trees/d1-0.tree` 上按 needle 计数（`grep -c -F` 整串匹配，或用 `grep -c -E` 带 role 前缀；树原文是单行转义，必须先还原才数得出形状，还原式与字节对账见「读数含义」）：

| needle | 次数 |
|---|---|
| `[disabled]`（全树） | **110** |
| `- row "X" [disabled] [level=2]` | 26 |
| `- gridcell "X" [disabled]` | 54 |
| `- button "Add to favorites" [disabled]` | 26 |
| `- button "Remove" [disabled]` | 2 |
| `- button [disabled]`（无名，工具栏） | 2 |

五枚 26＋54＋26＋2＋2 = **110**，加得回去，无残项。26 枚 disabled 的档位行按族恰好是 Ticks 4／Seconds 6／Minutes 8／Hours 4／Ranges 4；`grep -o -E 'row "[^"]*" \[level=2\]'` 只吐出六枚不带 `[disabled]` 的行名，逐字 `1 day`／`1 week`／`1 month`／`3 months`／`6 months`／`12 months`＝Days 组全体。⇒ **本趟的读数形状是「除 Days 组之外，整张目录的每一个 role 位（行、两枚或三枚格子、行内按钮）都带 `[disabled]`」**。

同一趟的结构总量（与 D2／C1／A17b／A18 各面逐枚同值，见下表）：`- row "` **39**、`[level=1]` **7**、`[level=2]` **32**、`gridcell` **73**、`rowgroup` **6**、`- menu` **6**、`button "Add to favorites"` **32**（全树，不分 disabled）、`gridcell "Remove"` **2**、`[selected]` **1**、`dialog` **0**、`listbox` **0**、`option ` **0**。

## 同会话的前后趟：同一个 `scenario_sha256`，`[disabled]` 从 110 翻到 2

**命令行逐字相同**（`%TEMP%\rea-slice6-t0\d2.cmd` 与 `d1.cmd` 除文件名外无差），因此场景指纹也相同：两趟的 `scenario_sha256` 都是第 62 行 `91759c5fdb9efc09c7e1d4116ad23af82960e6d97a973365a132c0f8d8d6d53b`。同一 target、同一 profile、同一页面会话，只换了时间：

| 面 | 落盘 | 树 bytes | `[disabled]` | 目录行的 disabled | `dialog` | rows／gridcells |
|---|---|---|---|---|---|---|
| D1（本面） | 12:59:40 | 10,126 | **110** | 26 | 0 | 39／73 |
| D2（逐字重跑） | 14:05:14 | 14,267 | **2** | **0** | 0 | 39／73 |
| A17b 末步 | 13:09:51 | 14,269 | 3 | 0 | 1 | 39／73 |
| A18 末步 | 13:12:30 | 14,704 | 3 | 0 | 1 | 39／73 |
| C1（冷 profile） | 14:13:33 | 9,351 | 3 | **0** | 0 | 39／73 |

D2 只有第 19-20 行那两枚无名工具栏 `- button [disabled]`（与目录无关，五枚面里都在），目录行一枚不带。⇒ **「档位行是否 `[disabled]`」在同一枚命令行下会整批翻面，它不是档位的固有属性**。D1 的 `1 day [selected]` 在第 271 行，D2 的在第 402 行，C1 的在第 286 行——同形不同号，因为 D2 比 D1 多 131 行、那 131 行全在目录之外（见下节）。

**本面不能解释这次翻面，也不许解释。** 两条本机候选都**没有**直接读数支撑：「载入未完成的瞬时态」需要一枚本趟没有的独立就绪凭据；「按族禁用（Days 之外的族要更高订阅档）」被 D2 同一命令行读到 0 枚直接反证其恒真性。另外，D1 与 D2 的树里 `This website uses cookies` 都**在**（各 1 枚，`- log:` 都 21 枚），而 A17b 那趟没有 cookie 层却仍读到 3 枚 ⇒ cookie 遮挡**不是**区分因子，这条排除是本面读出来的，别把它留给下一片重新猜。

## D1 与 D2 的 131 行差额落在目录之外（本面必须交代，否则上表会被读成「树变过」）

`difflib.SequenceMatcher`（两侧先 `.replace('\r\n','\n')`）逐段对齐：D1 副本 315 行、D2 副本 446 行，插入只有一大段——`d1[99]` 那一行 `- text: Indices S SPX N NDQ D DJI V VIX D DXY Stocks A AAPL …`（自选列表的**折叠**单行形）在 D2 里摊成 105 行带真实报价的列表项，加上 D2 独有的行情概览／社区／公司简介等块。目录那棵 `- treegrid:` 之下的差集全是对齐的 16／24／36／16／16 行小段，形状正是「D1 带 `[disabled]`、D2 不带」。⇒ 结构性读数（39／73／7／32／6／6／32／2）五枚面全等，两趟差的只有会话态填充度与 `[disabled]` 这一批瞬时属性。

## 读数含义

**留档行号（`grep -n` 可反查；文件＝`%TEMP%\rea-slice6-t0\d1.txt`，19,783 字节／232 行）**：`evidence_id` 第 1 行；parameters 回声 browser 11-14、start_url 15-17、environment 18-27、actions[2] 28-39（s1 的 locator 31-34、s2 的 duration_ms 39）、capture 45-61（`after_each_step: []` 第 46 行、`at_end[2]` 第 47 行）、`scenario_sha256` 第 62 行；normalized_result browser 64-70、scenario 71-88（`action_count: 2`）、`duration_ms: 17602` 第 89 行；steps[3] 表头行 90，scenario_start 步 91-127（elapsed 行 94＝10785，completeness 120-124，status／error 125-126），s1 步 128-163（elapsed 行 130＝5006，completeness 156-160，status／error 161-162），s2 步 164-207（elapsed 行 166＝1572，artifacts 179，accessibility 184-189（sha 187、bytes 188＝**10,126**、树文本单行 189），url 工件 190-196，completeness 201-205，status／error 206-207）；events 208-215（retained 0／dropped 0，与 `capture.events: []` 同形）；顶层 completeness 216-220；limitations[9] 行 221；confidence 222、authority 223、environment 224-228、顶层 limitations[11] 行 229；relationship_coverage 230、locations／evidence_links 231-232（两枚都是空集）。

主键 `sed -n '1p' d1.txt` 当场取，与本记录 `evidence_id：` 同值同趟。逐字命令行在 `%TEMP%\rea-slice6-t0\d1.cmd`（668 字节，本记录 命令： 与它逐字相同）。

未转义副本 `trees/d1-0.tree` 由 `%TEMP%\rea-slice6-cold\split-trees.py` 写出（把第 189 行那枚 `text:` 载荷的 `\n` 与 `\"` 还原后落盘；该脚本按 `write_text` 默认换行在 Windows 上写 CRLF）。**字节对账**：`wc -c d1-0.tree` = 10,440，`tr -cd '\r' | wc -c` = 314，10,440 − 314 = **10,126** ＝ stdout 第 188 行的 artifact bytes ⇒ 副本与工件同源无增删。行数：`grep -c '' d1-0.tree` = 315，`wc -l` 报 314（末行无换行符，少一）——本记录所有行号按 `grep -c ''` 那把尺数。needle 一律 `grep -c -F -e '…'`（Git Bash 下 `grep -cF` 会被当选项吞掉）或 `grep -c -E -e '…'`。

提供方自陈（第 221 行 limitations[9] 与第 229 行顶层 limitations[11]，与本面判据相关的三条逐字子串）：`Event sequence records provider receipt order; simultaneous browser causality is not inferred.`、`Artifact identity is unavailable for this observation.`、`CDP attachment cannot recover pre-attach events or guarantee launch-time context options.`。第三条与「同一个 `scenario_sha256` 两趟读数翻面」直接相邻：挂载趟不能回溯挂载之前的页面状态，所以 D1 那 110 枚到底对应页面上哪一段真实时间，本记录**不声称知道**。

## 本片用法（本记录能被谁引用）

本面对外提供的是一条**反向**规则——`[disabled]` 不许当「档位可用性」的凭据（该规则由 D1＋D2＋C1 三趟共同支撑，规格句与判据落在 L1 的 TV-CI-11 那格，其 `L0 依据` 指本文件与那两份）。本面另外能供正面读数的只有目录的**嵌套形状**（分组行 `[expanded]`＋`menu`＋同名 `rowgroup`、`Add custom interval` 是 level=1 且游离在 rowgroup 之外、`[selected]` 恰一枚），因为这三条在 12:59／13:09／13:12／14:05／14:13 五个时刻、热与冷两种 profile 下逐枚同值。
