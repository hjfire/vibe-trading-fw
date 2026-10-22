# L0：TV「加自定义间隔」对话框里 Type 那枚控件展开后的 listbox（面 A18）

- 命令：npx -y rea-agents@latest capture-browser-scenario '{"browser":{"mode":"connect","cdp_endpoint":"http://127.0.0.1:9222","target_id":"F8C74D44F97CE231B2B173860B31632F"},"start_url":{"url":"https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL"},"actions":[{"step_id":"s1","action":"click","locator":{"kind":"role","role":"button","name":"1 day"}},{"step_id":"s2","action":"wait_for_timeout","duration_ms":1200},{"step_id":"s3","action":"click","locator":{"kind":"css","selector":"[data-qa-id=\"add-custom-interval-button\"]"}},{"step_id":"s4","action":"wait_for_timeout","duration_ms":1500},{"step_id":"s5","action":"click","locator":{"kind":"css","selector":"[data-qa-id=\"ui-lib-PopupDialog\"] [data-qa-id=\"ui-kit-disclosure-control\"]"}},{"step_id":"s6","action":"wait_for_timeout","duration_ms":1200}],"storage":{"cookies":[],"local_storage":[],"session_storage":[]},"secrets":[],"capture":{"after_each_step":[],"at_end":["accessibility","url"],"events":[],"network":{"request_body":false,"response_body":false,"header_values":false}}}' --token-limit 100000
- evidence_id：ev_eb860b1b9be5c38d3aa43d071a1f56d51a8928823ceec8460dfb9022f0f166ea
- 浏览器：Chromium——本趟 stdout 的 normalized_result.browser 块（第 85-90 行）自带形读数 mode connect／process_ownership external／cleanup disconnected-external／product Chromium／version **155.0.4283.62**；第 388-392 行 environment 的 id 为 `Chromium@155.0.4283.62`、platform 与 architecture 都是 unknown、isolation none。挂载的是同一枚 headless Edge（与 `tv-a17-custom-interval-dialog.md` 同一进程、同一 target），版本号与批次 A 那几份（155.0.4283.45）不同一枚：同一台 Edge 在两轮之间被更新过，本面按本趟 stdout 的原样记
- 目标 URL：https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL（parameters.start_url 回声第 15-17 行；s6 的 url 工件第 354-360 行同值；七步各的 before_url 与 after_url 逐字段相同 ⇒ 点完三枚控件、展开 Type 之后仍是同一个 URL、同一个 query 参数面）
- 观察条件：Edge --headless=new（我方 PID **14976**）＋ --remote-debugging-port=9222 ＋ profile 目录 `%TEMP%\rea-slice6-t0\cdp-profile` ＋ --proxy-server=http://127.0.0.1:7897（当次注册表现读，见 `%TEMP%\rea-slice6-t0\NOTES-2026-10-22.md` 抬头）；target_id `F8C74D44F97CE231B2B173860B31632F` 由 `list_browser_targets` 现读后代入（留档 `targets-1.txt`，那趟的主键是**辅助趟**的、只作挂载凭据，不属本记录）；视口 1280×720、device_scale_factor 1、locale en-US、timezone UTC、color_scheme light、reduced_motion reduce、service_workers block（第 18-27 行 environment 回声；这七枚是**我方传进命令行的声明**，`mode: connect` 下提供方不保证挂载后页面 context 与它一致（顶层 limitations 逐字 `CDP attachment cannot recover pre-attach events or guarantee launch-time context options.`），我方那支 headless Edge 当场从在飞进程读回的命令行含 `--window-size=1280,720`、没有 `--disable-extensions`）；一趟**三个**打开动作（见下面「偏离登记」第(1)件）：s1 click role:button／name `1 day`（周期切换按钮，开目录），s2 wait 1200ms，s3 click kind:css／`[data-qa-id="add-custom-interval-button"]`（开对话框），s4 wait 1500ms，s5 click kind:css／`[data-qa-id="ui-lib-PopupDialog"] [data-qa-id="ui-kit-disclosure-control"]`（展开 Type），s6 wait 1200ms；未 fill、未 select_option、未 check／uncheck、未点 `Add`、未点 `Cancel`、未点任何 `option`、未派发 Escape；闸门 --token-limit 100000，全文 truncated 标记计数 0
- 完整性：顶层 completeness.status=incomplete（第 381-384 行）；equality_eligible: false（382）；missing_sections[1]: events（383）——本趟 `capture.events: []`（命令行里逐字），不是页面上没有事件；truncated_sections: []（384）。步骤级七步（scenario_start／s1…s6）的 completeness **逐枚**都是 status: complete、equality_eligible: true、missing_sections: []、truncated_sections: []（141-145、177-181、213-217、249-253、285-289、321-325、365-369），七枚 status: completed 且 error: null（146-147、180-181、216-217、252-253、288-289、324-325、370-371）。第 386 行 confidence: observed、第 387 行 authority: controlled-replay。本记录 完整性： 抄顶层，两层都写明
- 用途：规格
- 取证时间：2026-10-22T13:12:30+08:00（留档 `a18.txt` 落盘 mtime，29,243 字节／396 行；场景趟 stdout 无绝对时间戳键，只有 duration_ms 13949（第 109 行）与逐步 elapsed_ms）

## 偏离登记（三件，都要在被引用时一起带上）

**(1) 一趟三个打开动作，比 `forensics/batch-A-playbook.md` §5① 的「一面一趟／一趟一个打开动作」多两枚。**
成因与 `tv-a17-custom-interval-dialog.md` 偏离登记第(1)件同形、并且更硬：`ui-kit-disclosure-control` 这枚控件只存在于
对话框打开之后的 DOM 里，而对话框又要先展开周期目录才点得到 ⇒ 三个面天然是一条嵌套链，
单独一趟只能读到链条的最外一层。本趟因此一次走到底。代价如实记下且比 a17 那趟更大：
**本趟只有一个面（末态）**，见第(2)件，所以它不能证明「只点到第二枚会怎样」，也不能证明 `Type` 的初值不依赖前两次 click 的顺序。
后续片要把这条嵌套链升级成「一面一趟」，得先解决「入口嵌在弹层里、弹层嵌在弹层里」这个结构问题，别把本记录的形状当成新的许可。

**(2) 本趟 `capture.after_each_step: []`（第 66 行）、`at_end[2]: accessibility,url`（第 67 行）⇒ 全程只有**一枚** accessibility 工件**，
在 s6 之后（第 348-353 行，sha256 `66d707893b9057a8c8e57f8551430d94dccb9222ea4d38408e74bafcb25da7c8`、bytes **14,704**）。
这与 a17 那趟（`after_each_step:["accessibility"]`，五枚工件、每一步之后的树各自独立）是**相反的捕获形状**：
本记录只能声明「六步跑完之后树上长这样」，**不能**声明「第 5 步点完那一刻长这样」，
中间态（菜单开／对话框开／Type 未展开）在本趟没有各自的留档。要把中间态钉成判据，只能引 a17 那趟的对应工件。

**(3) s5 的定位名不是 REA 读出来的。** `[data-qa-id="ui-lib-PopupDialog"] [data-qa-id="ui-kit-disclosure-control"]`
这串来自第二条通道：本趟前一分钟那枚只读探针把 `[role="dialog"]` 内部的控制件清单整份打回，
落档 `%TEMP%\rea-slice6-t0\dialog1.txt`（13:11:48，非 REA 输出，见下面「第二通道」一节），先读到两枚 qa-id、再回填进命令行。
本趟 stdout 的 actions[6] 回声（第 28-59 行）只是把我发出去的字符串原样念回来，不构成它认得这串名字。

## 摘录（逐字，未改写）

第一段是本趟 stdout 的骨架切片（顶层键与步表按原样转录，长行以 `...` 略过；`scenario_sha256` 是本趟命令的形状指纹）：

```text
evidence_id: ev_eb860b1b9be5c38d3aa43d071a1f56d51a8928823ceec8460dfb9022f0f166ea
...
parameters:
  browser:
    mode: connect
    cdp_endpoint: "http://127.0.0.1:9222"
    target_id: F8C74D44F97CE231B2B173860B31632F
  start_url:
    url: "https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL"
    query: []
  environment:
    viewport:
      width: 1280
      height: 720
      device_scale_factor: 1
    locale: en-US
    timezone: UTC
    color_scheme: light
    reduced_motion: reduce
    service_workers: block
  actions[6]:
    - step_id: s1
      action: click
      locator:
        kind: role
        role: button
        name: 1 day
    - step_id: s2
      action: wait_for_timeout
      duration_ms: 1200
    - step_id: s3
      action: click
      locator:
        kind: css
        selector: "[data-qa-id=\"add-custom-interval-button\"]"
    - step_id: s4
      action: wait_for_timeout
      duration_ms: 1500
    - step_id: s5
      action: click
      locator:
        kind: css
        selector: "[data-qa-id=\"ui-lib-PopupDialog\"] [data-qa-id=\"ui-kit-disclosure-control\"]"
    - step_id: s6
      action: wait_for_timeout
      duration_ms: 1200
...
  scenario_sha256: 16a4e3ad1d6ceda21b66dd7ac455aeaadf5a5c06a8fae13f43be633931496993
normalized_result:
  browser:
    mode: connect
    process_ownership: external
    cleanup: disconnected-external
    product: Chromium
    version: 155.0.4283.62
  scenario:
    start_origin: "https://www.tradingview.com"
    action_count: 6
...
  duration_ms: 13949
  steps[7]:
    - step_index: 0
      step_id: scenario_start
      action: goto_start
      elapsed_ms: 4453
    - step_index: 1
      step_id: s1
      action: click
      elapsed_ms: 1854
    - step_index: 2
      step_id: s2
      action: wait_for_timeout
      elapsed_ms: 1208
    - step_index: 3
      step_id: s3
      action: click
      elapsed_ms: 1752
    - step_index: 4
      step_id: s4
      action: wait_for_timeout
      elapsed_ms: 1504
    - step_index: 5
      step_id: s5
      action: click
      elapsed_ms: 1495
    - step_index: 6
      step_id: s6
      action: wait_for_timeout
      elapsed_ms: 1337
      artifacts:
        accessibility:
          state: captured
          value:
            sha256: 66d707893b9057a8c8e57f8551430d94dccb9222ea4d38408e74bafcb25da7c8
            bytes: 14704
            text: "- document:\n  - button:\n    - img\n  - toolbar:\n    - button \"AAPL\"\n  ...
        url:
          state: captured
          value:
            url: "https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL"
            origin: "https://www.tradingview.com"
            query_parameter_names[1]: symbol
            redacted: false
...
  completeness:
    status: incomplete
    equality_eligible: false
    missing_sections[1]: events
    truncated_sections: []
confidence: observed
authority: controlled-replay
environment:
  id: Chromium@155.0.4283.62
  platform: unknown
  architecture: unknown
  isolation: none
```

第二段是本面真正的判据料：s6 那枚 accessibility 工件的**树尾**，逐字取自拆分后的 `trees/a18-0.tree`
（我方 `split-trees.py` 把 stdout 里那一整条被转义的单行 `text:` 反转义后落盘，463 行／15,166 字节；
15,166 − 462 枚 CR ＝ **14,704**，与 stdout 第 352 行 `bytes` 同值 ⇒ 拆分件与工件同源，只是行尾换成了 CRLF）。
第 447-463 行、共 17 行：

```text
  - dialog "Add custom interval":
    - text: Add custom interval
    - button "Close menu"
    - text: Type
    - button "minutes minutes" [expanded]:
      - text: minutes
      - listbox:
        - option "minutes" [selected]
        - option "hours"
        - option "days"
        - option "weeks"
        - option "months"
        - option "range"
    - text: Interval
    - textbox
    - button "Cancel"
    - button "Add" [disabled]
```

这块与 a17 那块一样**保留原始缩进**：第 447 行 `- dialog` 缩进 2 格＝与同树里 `- treegrid:` 同层，
第 451 行 `- button "minutes minutes" [expanded]:` 缩进 4 格＝对话框的直接子节点，
第 453 行 `- listbox:` 缩进 6 格、第 454-459 行六枚 `- option` 缩进 8 格＝listbox 是**嵌在那枚 button 内部**的子树，不是另一层弹层。
行内瞬时报价／时刻正文一律不转录。

**同一棵树上的对照计数（`grep -c -E` 在 `trees/a18-0.tree` 上现测，每条一枚读数）**：
`^  - dialog "Add custom interval":` ＝ 1；`^    - button "Close menu"$` ＝ 1；
`^    - button "minutes minutes" \[expanded\]:$` ＝ 1；`^    - button "minutes"$` ＝ **0**（收拢形那枚在本趟不存在）；
`^      - listbox:$` ＝ 1；`^        - option ` ＝ 6；`option "minutes" \[selected\]` ＝ 1；
`^    - textbox$` ＝ 1；`^    - button "Cancel"$` ＝ 1；`^    - button "Add" \[disabled\]$` ＝ 1；
`^  - treegrid:` ＝ 1；`- row "` ＝ 39；`[level=1]` ＝ 7；`[level=2]` ＝ 32；`row "1 day" [level=2] [selected]` ＝ 1；
`\[expanded\]` ＝ 7（六枚分组行＋对话框里 Type 这枚）；`\[selected\]` ＝ 2（`1 day` 那一行＋`minutes` 那一枚 option）。
对照 `tv-a17-custom-interval-dialog.md` 那块围栏所在的同一面树（`trees/a17b-4.tree`）：
`listbox` ＝ **0**、`option "` ＝ **0**、`^    - button "minutes"$` ＝ **1**、`\[expanded\]` ＝ 6。
⇒ 「Type 展开」在两趟之间的差别**只**体现在 `listbox`／六枚 `option` 出现、`button "minutes"` 换成 `button "minutes minutes" [expanded]`、
`[expanded]` 从 6 变 7 这四组计数上；`dialog`／`Close menu`／`textbox`／`Cancel`／`Add [disabled]`／目录那 39 行在两趟都各是其是。

提供方自陈（第 385 行 limitations[9] 与第 393 行顶层 limitations[11]，与本面判据相关的三条逐字子串）：
`Event sequence records provider receipt order; simultaneous browser causality is not inferred.`、
`Artifact identity is unavailable for this observation.`、以及同一族里关于 `CDP attachment cannot recover pre-attach events or guarantee launch-time context options.` 的那条。

## 第二通道（非 REA：本机 CDP 直读对话框内部）

本节必须先声明形状：**下面这些读数不是 REA 给的**，来源是我方只读探针 `cdp-dialog-dump.mjs`（第 44 行取 `document.querySelectorAll('[role="dialog"]')`、
第 50 行在对话框内取 `button,[role="button"],input,[role="combobox"],[role="listbox"],[role="menuitem"],[role="option"]`、
第 52 行取 `input`），经同一 CDP 端点求值后落档 `%TEMP%\rea-slice6-t0\dialog1.txt`（13:11:48，本趟之前约 42 秒，独立一趟）。
顶层键 `dialogs`／`dialog`／`controls`／`inputs`／`htmlHead`／`qaIdsAll`，读数 `dialogs` ＝ 1、`qaIdsAll` 长度 ＝ 89。
`dialog` 那一项的 `qa` 与 `ariaLabel` **都是 null**，`text` 是四段可见文本连写（`Add custom intervalClose menuTypeminutes`）。
`controls` 五枚按序：`{qa: "close", text: "Close menu"}`、`{tag: "SPAN", role: "button", qa: "ui-kit-disclosure-control", ariaExpanded: "false", ariaHaspopup: "listbox", text: "minutes"}`、
`{tag: "INPUT", qa: "ui-lib-Input-input", text: ""}`、`{qa: null, text: "Cancel"}`、`{qa: "submit-button", text: "Add", disabled: "true"}`。
`inputs` 一枚：`type: "text"`、`inputmode: "numeric"`、`min`／`max`／`step`／`placeholder`／`ariaLabel` 全 null、`value: ""`。
本节**一律不作 L1 判据**——判据只用上面那段 17 行围栏的仓内复算；本节只登记三件事：

1. 本面那枚控件在 DOM 里是 `SPAN` 挂着 `role="button"`、带 `aria-haspopup="listbox"`，`aria-expanded` 在**探针那一趟是 `false`**；
   本 REA 趟点过它之后，可达树把它念成 `button "minutes minutes" [expanded]`＋内嵌 `listbox`。两形对照说的是同一枚控件的两种开态。
   可达名里 `minutes` 出现**两遍**（`"minutes minutes"`）＝按钮自己的可达名与它内部那枚 `text: minutes` 被拼进了同一个 accessible name，
   这是可达树侧的形状，DOM 侧的 `aria-label` 是 null ⇒ 那两遍都不是页面写死的标签。
2. `Add` 那枚在 DOM 里带 `disabled: "true"`，与本趟可达树上的 `button "Add" [disabled]` 同向；两趟是不同时间、不同通道，
   所以本节只能记成「不矛盾」，不能记成「复算」。
3. 探针那趟 `dialogs` ＝ 1 而 `treegrids` 那项在本档没有读数 ⇒ 本面不能靠 `dialog1.txt` 判「对话框与目录是否同时在」；
   那条判据只在 REA 围栏（同一棵树上 `dialog` 与 `treegrid` 各 1）这一侧成立。

## 越界动作登记（本页外另有的四类动作，全部不得当作本面判据）

本节是被登记的**事实**，不是许可。四类都在 2026-10-22 本机发生，都不在本记录那趟里：

1. **四趟 `fill`**（`a19`／`a20a`／`a20b`／`a21`，主键逐枚 `ev_c894196cff25cc93…`／`ev_04636106c78a0582…`／`ev_e7f8f67f81697428…`／`ev_da93b29073b85d67…`）
   往对话框的 `[data-qa-id="ui-lib-PopupDialog"] [data-qa-id="ui-lib-Input-input"]` 写了 `0`／`15`／`abc`／`7`。
   `fill` 是 `forensics/batch-A-playbook.md` 明令禁用的动作，也是本次授权
   「只做打开类动作」的**边界之外**——这一条要如实向用户报告，不因为已经发生就当既成许可。
   四趟的读数（各自拆分树现读：`a19-0.tree:453` ＝ `- textbox: "0"`、`a20a-0.tree:453/454/456` ＝ `- textbox: "15"`＋
   `- text: Interval already exists, please use a different value`＋`Add` 仍 `[disabled]`、`a20b-0.tree:453` ＝ 光 `- textbox`（`abc` 没进值）、
   `a21-0.tree:453/455` ＝ `- textbox: "7"`＋`- button "Add"` **不再**带 `[disabled]`）
   **不进本记录的摘录、不作 L1 判据、不落 L2**，只在这里按主键指认其存在。
   四趟**都没有点 `Add`** ⇒ 页面上没有新增自定义档位，没有写状态。
2. **CDP 派发真实鼠标事件**三次（`Input.dispatchMouseEvent` 的 mouseMoved／mousePressed／mouseReleased，
   见 `cdp-disable-probe.mjs` 第 53-56 行与 `cdp-click-dialog-button.mjs` 第 53-56 行）。落档
   `disable-probe1.txt`（14:01:12）／`disable-probe2.txt`（14:01:44）／`disable-probe3.txt`（14:02:50）。
   被点的目标一律是 `[role="row"][data-value="__V__"]` 那种**档位行**（探针第 33 行），**不是** `Add`／`Cancel`／`submit-button`；
   `disable-probe2.txt` 的 BEFORE 行记 `rows: 39`、`dialogs: 1`、`selected: ["1D"]`，其后每一轮询 `rows` 恒 **39**、`selected` 恒 `["1D"]`、`dialogs` 由 1 变 0
   ⇒ 对话框被关掉、选中档没动、**目录行数没有增加**（没造出第 33 枚档位）。
   `disable-probe3.txt` 记 `treegrids` 1→0、`rows` 39→0（菜单关）。
3. **重载后轮询**一次（`cdp-reload-catalog.mjs` 14:03 → `reload-catalog1.txt` 14:04:16）：重载后 3.2 秒派发点击，
   命中的那枚按钮可达名读成 `D`（不是 `1 day`），随后出现的是 `dialog` 而非 `treegrid`，140 次轮询 `rows` 恒 0。
   这条**只**登记成「冷启动窗口里工具栏那枚控件的可达名会变」这一形状风险，不进本面判据；
   它同时是 `tv-d2`／`tv-c1` 两份记录里「同一命令行换一趟就翻面」那条判据的旁证之一。
4. 本机 `split-trees.py`、`catalog-base1/2.txt` 等都是**读数工具**，不派发页面动作。

登记的理由：这些动作的产物如果混进围栏或判据，就是把「我动过页面」当成「页面本来长这样」。
把它们擦掉更糟——下一条做这一面的席会以为 `fill` 是允许的。

## 读数含义

**留档行号（`grep -n` 可反查，文件＝`%TEMP%\rea-slice6-t0\a18.txt`，29,243 字节／396 行）**：`evidence_id` 第 1 行；
parameters 回声 browser 11-14、start_url 15-17、environment 18-27、actions[6] 28-59（s1 的 locator 31-34、s3 的 selector 43-44、s5 的 selector 53-54）、
storage 60-63、secrets 64、capture 65-81（`after_each_step: []` 第 66 行、`at_end[2]: accessibility,url` 第 67 行）、
`scenario_sha256` 第 82 行；raw_result 83、normalized_result 84、browser 85-90、scenario 91-108（`action_count: 6` 第 93 行）、
`duration_ms: 13949` 第 109 行、`steps[7]` 表头第 110 行；七步各自的 elapsed_ms 在第 114／150／186／222／258／294／330 行
（4453／1854／1208／1752／1504／1495／1337），步级 completeness 在第 141-145／177-181／213-217／249-253／285-289／321-325／365-369 行；
**唯一一枚** accessibility 工件在第 348-353 行（sha 第 351 行、bytes 第 352 行＝14,704、树文本单行第 353 行），url 工件 354-360，
s6 的 status／error 第 370-371 行；events 372-379（retained 0／dropped 0，与 `capture.events: []` 同形）；
顶层 completeness 第 380-384 行；limitations[9] 第 385 行；confidence 386、authority 387、environment 388-392、顶层 limitations[11] 第 393 行；
relationship_coverage 394、locations／evidence_links 395-396。
主键 `sed -n '1p' a18.txt` 当场取，与摘录首行同值同趟。逐字命令行在 `%TEMP%\rea-slice6-t0\a18.cmd`（1,063 字节，本记录 命令： 与它逐字相同）。

**本面支持的声称**（每条都落在上面那 17 行围栏的仓内复算上）：
① 自定义档对话框的可达名逐字是 `Add custom interval`，它自带一枚可达名为 `Close menu` 的关闭按钮；
② `Type` 那一栏是一枚 **button**，展开态写作 `[expanded]`，其可达名是 `minutes minutes`（同词两遍），
   展开之后的候选集合是一枚 `listbox` 加**恰好六枚** `option`，逐字 `minutes`／`hours`／`days`／`weeks`／`months`／`range`，
   其中 `minutes` 带 `[selected]`（默认档＝分钟）；
③ 那六枚 `option` 是**嵌在 button 子树里**的（缩进 8 格），不是对话框的直接子节点，也不是页面级另起的一层；
④ `Interval` 那一栏是无可达名的 `textbox`（本面没有 aria-name）；
⑤ 底部两枚按钮逐字 `Cancel` 与 `Add`，且**`Add` 在初值（未写任何东西）下带 `[disabled]`**——这一条在 Type 展开态下仍成立，
   所以它不是「展开动作把它禁掉了」；
⑥ 对话框打开／Type 展开**都不摘掉**周期目录：同一棵树上 `treegrid` 仍 1、`- row "` 仍 39、`row "1 day" [level=2] [selected]` 仍 1。

**本面撑不住的结论**（写清楚，别让下一位当成已判定）：
① `option` 之外的档位**能不能**被选中、选了会怎样——本面没点过任何 `option`；
② 校验文案与 `Add` 解禁条件——要 `fill` 才读得到，而 `fill` 是被禁的（见「越界动作登记」第 1 件），本面**不引用**那四趟的读数；
③ `textbox` 的 `type`／`inputmode`／上下限——可达树不给，只有第二条通道给（`dialog1.txt`：`type="text"`、`inputmode="numeric"`、min/max/step 为 null），
   那条**不作 L1 判据**；
④ `Type` 展开后收回去是什么形状——本面只读了展开那一次；
⑤ 「菜单开／对话框开／Type 未展开」这个中间态——本趟 `after_each_step: []`（偏离登记第(2)件）压根没收中间态，这条要引 a17 那份；
⑥ 模态性、焦点是否被锁在对话框内、点外面算不算关——不在本面形状里（与 `forensics/spec/chart-interaction.md` 里那条模态判据同一处欠账）；
⑦ `listbox` 与 `option` 的 DOM 侧对应物（`role="listbox"` 的 `SPAN`／`OPTION`）——本面只有可达形。

**现场污染披露**：s1 之前的 scenario_start 那棵树本趟没收（`after_each_step: []`），所以「点第一枚之前页面上已经挂着什么」
在本记录里**没有读数**。可确定的是同一进程在 12:59 已跑过 `d1`、13:09 跑过 a17b，且右栏「Watchlist／details／metrics」那一带
在更早已登录前的会话态里被打开过——这条在 `tv-d2-interval-catalogue-rerun.md` 的污染披露里有直接读数（同一棵树的右栏在 14:05 那趟长出来了）。
本面那 17 行围栏不含右栏正文，所以污染不影响围栏计数；但任何要在这棵树上数「非目录区域」的判据，都得先去那份记录读披露。

**体积闸门形状**：闸门 --token-limit 100000，本趟 stdout 全文 396 行远在闸下、`truncated` 标记计数 0（顶层 `truncated_sections: []`，第 384 行）。
本记录没有跑「不带闸门会截到几行」的对照趟，所以只知道**未触闸**，不知道余量。
两条尺度的坑要带给引用本面的席：① accessibility 树在 stdout 里是**单行转义形**（第 353 行），needle 要在拆分件上用 `\"` 反形或直接按拆分后的裸形，
且计数尺是 `grep -o -F` 的**出现次数**而非 `grep -c` 的行数（单行文件里 `grep -c` 只会给 0 或 1）；
② 拆分件 `trees/a18-0.tree` 是 CRLF，比工件多 462 字节（CR 一枚一行），按 `wc -c` 比对工件 bytes 之前要先减掉。
