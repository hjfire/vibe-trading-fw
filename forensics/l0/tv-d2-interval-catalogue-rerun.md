# L0：TV 周期目录展开态的逐字复跑（同一枚命令行读到目录零 `[disabled]`）（面 D2）

- 命令：npx -y rea-agents@latest capture-browser-scenario '{"browser":{"mode":"connect","cdp_endpoint":"http://127.0.0.1:9222","target_id":"F8C74D44F97CE231B2B173860B31632F"},"start_url":{"url":"https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL"},"actions":[{"step_id":"s1","action":"click","locator":{"kind":"role","role":"button","name":"1 day"}},{"step_id":"s2","action":"wait_for_timeout","duration_ms":1500}],"storage":{"cookies":[],"local_storage":[],"session_storage":[]},"secrets":[],"capture":{"after_each_step":[],"at_end":["accessibility","url"],"events":[],"network":{"request_body":false,"response_body":false,"header_values":false}}}' --token-limit 100000
- evidence_id：ev_cacf888a45bef156f0ad517e103f578f988130ab26f729dd7ff716c11adf97e2
- 浏览器：本趟 stdout 的 browser 块（第 65-70 行）mode connect／process_ownership external／cleanup disconnected-external／product Chromium／version **155.0.4283.62**；第 224-228 行 environment 的 id `Chromium@155.0.4283.62`、platform 与 architecture 都是 unknown、isolation none。与 D1 那趟逐字段同值（同一台 Edge、同一个 target）
- 目标 URL：https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL（parameters.start_url 回声第 15-17 行；at_end 的 url 工件第 190-196 行同值；三步 before_url／after_url 六块（95-99／100-104／131-135／136-140／167-171／172-176）逐字段相同 ⇒ 点完那一枚打开按钮仍是同一个 URL、同一个 query 面）
- 观察条件：与 D1 同一现场（Edge `--headless=new` PID **14976**、`--remote-debugging-port=9222`、profile `%TEMP%\rea-slice6-t0\cdp-profile`、`--proxy-server=http://127.0.0.1:7897`、target_id `F8C74D44F97CE231B2B173860B31632F`），差别只有**时刻**（本趟 14:05:14，D1 是 12:59:40）；命令行与 D1 **逐字相同**（`d2.cmd` 与 `d1.cmd` 除文件名外无差，两字节大小都是 668），因此两趟的 `scenario_sha256` 同值（第 62 行 `91759c5fdb9efc09c7e1d4116ad23af82960e6d97a973365a132c0f8d8d6d53b`）；视口 1280×720、device_scale_factor 1、locale en-US、timezone UTC、color_scheme light、reduced_motion reduce、service_workers block（第 18-27 行回声）——这七枚是**我方传进命令行的声明**，`mode: connect` 下提供方不保证挂载后页面 context 与它一致（顶层 limitations 逐字 `CDP attachment cannot recover pre-attach events or guarantee launch-time context options.`）；**一趟一个打开动作**：s1 click role:button／name `1 day`，s2 wait_for_timeout 1500ms；未 fill、未 select_option、未 check／uncheck、未点档位行（没换档）、未点 `Add custom interval`、未派发 Escape、未提交、未登录、未交易；闸门 --token-limit 100000，全文 `truncated` 标记计数 0
- 完整性：顶层 completeness.status=incomplete（216-220）、equality_eligible: false（218）、missing_sections[1]: events（219）、truncated_sections: []（220）——`capture.events: []` 是命令行里逐字选的，不是页面上没有事件。步骤级三步逐枚 complete／equality_eligible: true／missing_sections: []／truncated_sections: []（120-124、156-160、201-205），三枚 status: completed 且 error: null（125-126、161-162、206-207）。第 222 行 confidence: observed、第 223 行 authority: controlled-replay
- 用途：规格
- 取证时间：2026-10-22T14:05:14+08:00（留档 `d2.txt` 落盘 mtime；stdout 只有 duration_ms **7322**（第 89 行）与逐步 elapsed_ms 2763／2579／1621（94、130、166））

## 本面读到的形状

`capture.after_each_step: []`（第 46 行）＋ `at_end[2]: accessibility,url`（第 47 行）⇒ 本趟同样**只有一枚**可达树工件，挂在 s2 之后（第 184-189 行：state captured／sha256 `cc689afdf3132ba5abcd171d21773265ae258975ef63c55e19213278156f4c61`／bytes **14,267**／text 单行转义在第 189 行）。

围栏＝未转义副本 `trees/d2-0.tree` 第 282-297 行，与 D1 记录第一枚围栏**同一位置、同一段形状**，差别只在 `[disabled]` 一位都不在（原缩进照抄，行内报价正文不转录）：

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

第二枚围栏＝同一副本第 344-349 行。这一段是本面独有的正面读数：**已在列表里的档位**（`2 minutes`）多出一枚 `Remove` 格子，且它排在「名字格子」与「收藏格子」**之间**，行自己仍是 `[level=2]`、不带任何状态位：

```text
      - row "2 minutes" [level=2]:
        - gridcell "2 minutes"
        - gridcell "Remove":
          - button "Remove"
        - gridcell "Add to favorites":
          - button "Add to favorites"
```

⇒ `Remove` 那一格是**插在中间**的第三枚格子，不是把收藏格子换成删除格子（同一行里两枚都在）。全树 `gridcell "Remove"` 恰 **2** 枚，配 `catalog-base1.txt`／`catalog-base2.txt` 的 DOM 读数（`remove-interval-button` 只在 `2 minutes` 与 `10 minutes` 两行，见 A17 记录「第二通道」）一致；本面的行号分别在 346 与 360。

## 承重读数：目录行 `[disabled]` 全批为 0

`[disabled]` 全树 **2** 枚，逐字都在第 19-20 行 `- button [disabled]`（第一枚 toolbar 里 `Bar replay` 之后那两枚无名按钮，与 D1／A17b／A18／C1 四面同位置同值），目录里**零**枚。目录的结构量与 D1 逐枚相等：`- row "` **39**、`[level=1]` **7**、`[level=2]` **32**、`gridcell` **73**、`rowgroup` **6**、`- menu` **6**、`button "Add to favorites"` **32**、`gridcell "Remove"` **2**、`[selected]` **1**（第 402 行 `- row "1 day" [level=2] [selected]:`）、`dialog` **0**、`listbox` **0**、`option ` **0**。`- separator` 本面 15 枚 vs D1 的 14 枚——那一枚落在目录之外的自选列表块里，见下节。

⇒ 与 D1 合起来读：同一枚命令行、同一个 target，两趟之间**唯一**翻面的就是目录行／格子／按钮上那批 `[disabled]`（D1 有 26 行＋54 格＋28 有名按钮，D2 全 0），而目录的形状量（39／73／7／32／6／6／32／2／selected 1）一位没动。

## 本面比 D1 多出的 131 行全在目录之外（交代，否则上表会被读成「目录变胖了」）

`difflib.SequenceMatcher`（两侧先 `.replace('\r\n','\n')` 再逐行对齐）读数：D1 副本 315 行、D2 副本 446 行；唯一的大插入是 D1 第 99 行那一枚折叠形的自选列表文本行（`Indices S SPX N NDQ …` 一整行）在 D2 摊开成 105 行带真实报价的列表项（D2 第 126-230 行），再加 D2 独有的 symbol-profile／community／公司简介等块。目录之下的差集全是对齐的 16／24／36／16／16 行小段，形状正是「D1 带 `[disabled]`、D2 不带」。⇒ **两趟的差＝会话态填充度＋`[disabled]` 那一批瞬时属性**；本面不能解释 `[disabled]` 为什么翻面，也不做解释（候选「载入未完成」缺独立就绪凭据、候选「按订阅档族禁用」被本面 0 枚直接顶住，两条都不升级）。

## 读数含义

**留档行号（`grep -n` 可反查；文件＝`%TEMP%\rea-slice6-t0\d2.txt`，24,121 字节／232 行）**：`evidence_id` 第 1 行；parameters 回声 browser 11-14、start_url 15-17、environment 18-27、actions[2] 28-39（s1 的 locator 31-34、s2 的 duration_ms 39）、capture 45-61（`after_each_step: []` 第 46 行、`at_end[2]` 第 47 行）、`scenario_sha256` 第 62 行；normalized_result browser 64-70、scenario 71-88、`duration_ms: 7322` 第 89 行；steps[3] 表头行 90，scenario_start 步 91-127（elapsed 94＝2763，completeness 120-124，status／error 125-126），s1 步 128-163（elapsed 130＝2579，completeness 156-160，status／error 161-162），s2 步 164-207（elapsed 166＝1621，artifacts 179，accessibility 184-189（sha 187、bytes 188＝**14,267**、树文本单行 189），url 工件 190-196，completeness 201-205，status／error 206-207）；events 208-215（retained 0／dropped 0）；顶层 completeness 216-220；limitations[9] 行 221；confidence 222、authority 223、environment 224-228、顶层 limitations[11] 行 229；relationship_coverage 230、locations／evidence_links 231-232。

主键 `sed -n '1p' d2.txt` 当场取，与本记录 `evidence_id：` 同值同趟。逐字命令行在 `%TEMP%\rea-slice6-t0\d2.cmd`（668 字节，本记录 命令： 与它逐字相同）。

未转义副本 `trees/d2-0.tree` 与 D1 那份由同一支 `split-trees.py` 写出（还原第 189 行的 `\n` 与 `\"`；`write_text` 在 Windows 默认写 CRLF）。**字节对账**：`wc -c` = 14,712，`tr -cd '\r' | wc -c` = 445，14,712 − 445 = **14,267** ＝ stdout 第 188 行的 artifact bytes。行数按 `grep -c '' d2-0.tree` = 446（`wc -l` 报 445，末行无换行符少一）。needle 一律 `grep -c -F -e '…'` 或 `grep -c -E -e '…'`。

提供方自陈（第 221 行 limitations[9] 与第 229 行顶层 limitations[11]，与本面判据相关的三条逐字子串）：`Event sequence records provider receipt order; simultaneous browser causality is not inferred.`、`Artifact identity is unavailable for this observation.`、`CDP attachment cannot recover pre-attach events or guarantee launch-time context options.`

## 本片用法（本记录能被谁引用）

本面是 D1 那 110 枚 `[disabled]` 的**反证趟**：没有本面，D1 只能读成「TV 的目录长这样」。两趟合起来（再加 C1 那枚冷 profile 趟）支撑 L1 的 TV-CI-11——「档位行是否 `[disabled]`」不许当可用性判据。本面另外单独供一条正面形状：**「该档位已在列表里」由行内多出一枚 `Remove` 格子表达，且它与收藏格子同行共存**（围栏第二段，`gridcell "Remove"` 全树 2 枚），这条也写进 TV-CI-11 那一格的判据里，因为它同样只在可达树层可读。
