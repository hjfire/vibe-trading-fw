# L0：TV「加自定义间隔」对话框的开态骨架（面 A17）

- 命令：npx -y rea-agents@latest capture-browser-scenario '{"browser":{"mode":"connect","cdp_endpoint":"http://127.0.0.1:9222","target_id":"F8C74D44F97CE231B2B173860B31632F"},"start_url":{"url":"https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL"},"actions":[{"step_id":"s1","action":"click","locator":{"kind":"role","role":"button","name":"1 day"}},{"step_id":"s2","action":"wait_for_timeout","duration_ms":1500},{"step_id":"s3","action":"click","locator":{"kind":"css","selector":"[data-qa-id=\"add-custom-interval-button\"]"}},{"step_id":"s4","action":"wait_for_timeout","duration_ms":2000}],"storage":{"cookies":[],"local_storage":[],"session_storage":[]},"secrets":[],"capture":{"after_each_step":["accessibility"],"at_end":["accessibility","url"],"events":[],"network":{"request_body":false,"response_body":false,"header_values":false}}}' --token-limit 100000
- evidence_id：ev_d3ab2e60b8a051e250811c922d9f00c2e475341bd136db402f4d72eab4b84831
- 浏览器：Chromium 155.0.4283.45 系现场挂载的我方 headless Edge，本趟 stdout 的 browser 块（第 76-80 行）自带形读数 mode connect／process_ownership external／cleanup disconnected-external／product Chromium／version **155.0.4283.62**；第 322-326 行 environment 的 id 为 `Chromium@155.0.4283.62`、platform 与 architecture 都是 unknown、isolation none。版本号与批次 A 那几份（155.0.4283.45）不同一枚：同一台 Edge 在两轮之间被更新过，本面按本趟 stdout 的原样记
- 目标 URL：https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL（parameters.start_url 回声第 15-17 行；at_end 的 url 工件第 288-294 行同值；s1／s2／s3／s4 各步的 before_url 与 after_url 两块（105-113、145-153、185-193、225-233 邻近与 265-274）逐字段相同 ⇒ 点完两枚控件、开完对话框之后仍是同一个 URL、同一个 query 参数面）
- 观察条件：Edge --headless=new（我方 PID **14976**，`edge-launch.log` 顶行 `DevTools listening on ws://127.0.0.1:9222/devtools/browser/8d8cadee-6779-47ab-8b4e-7b4547821392` 现读）＋ --remote-debugging-port=9222 ＋ 专属新建 profile 目录 `%TEMP%\rea-slice6-t0\cdp-profile` ＋ --proxy-server=http://127.0.0.1:7897（当次 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` 现读 ProxyEnable=0x1／ProxyServer=127.0.0.1:7897，见 `%TEMP%\rea-slice6-t0\NOTES-2026-10-22.md` 抬头）；target_id `F8C74D44F97CE231B2B173860B31632F` 由 `list_browser_targets` 现读后代入（留档 `%TEMP%\rea-slice6-t0\targets-1.txt`，该趟自己的主键 `ev_77796e0371cccbe72d09d619887acb5e06f051afe1c3f24d1c8a1633c2630f32` 是**辅助趟**的主键、只作挂载凭据，不属本记录）；视口 1280×720、device_scale_factor 1、locale en-US、timezone UTC、color_scheme light、reduced_motion reduce、service_workers block（第 18-27 行 environment 回声；这七枚是**我方传进命令行的声明**，`mode: connect` 下提供方不保证挂载后页面 context 与它一致（顶层 limitations 逐字 `CDP attachment cannot recover pre-attach events or guarantee launch-time context options.`），我方那支 headless Edge 当场从在飞进程读回的命令行含 `--window-size=1280,720`、没有 `--disable-extensions`）；一趟**两个**打开动作（见下面「偏离登记」第(1)件）：s1 click 一枚 role:button／name `1 day`（周期切换按钮），s2 wait_for_timeout 1500ms，s3 click 一枚 kind:css／selector `[data-qa-id="add-custom-interval-button"]`，s4 wait_for_timeout 2000ms；未 fill、未 select_option、未 check／uncheck、未点 `Add`、未点 `Cancel`、未派发 Escape、未提交、未登录、未交易、未改 UA、未禁用优化；闸门 --token-limit 100000，全文 truncated 标记计数 0
- 完整性：顶层 completeness.status=incomplete（第 314-318 行）；equality_eligible: false（315）；missing_sections[1]: events（316-317）——本趟 `capture.events: []`（命令行里逐字），不是页面上没有事件；truncated_sections: []（318）。步骤级五步（scenario_start／s1／s2／s3／s4）的 completeness **逐枚**都是 status: complete、equality_eligible: true、missing_sections: []、truncated_sections: []（134-138、174-178、214-218、254-258、299-303），五枚 status: completed 且 error: null（139-140、179-180、219-220、259-260、304-305）。第 320 行 confidence: observed、第 321 行 authority: controlled-replay。本记录 完整性： 抄顶层，两层都写明
- 用途：规格
- 取证时间：2026-10-22T13:09:51+08:00（留档 `a17b.txt` 落盘 mtime；场景趟 stdout 无绝对时间戳键，只有 duration_ms 13379（第 99 行）与逐步 elapsed_ms）

## 偏离登记（两件，都要在被引用时一起带上）

**(1) 一趟两个打开动作，违反 `forensics/batch-A-playbook.md` §5① 的「一次一面／一趟一个打开动作」。**
成因不是手滑，是这一面的**形状**：`Add custom interval` 那枚控件只存在于周期目录展开之后的树里，
而展开目录本身就要一次 click ⇒ 单独一趟只能读到「菜单开着」，读不到对话框。本趟因此把
「开菜单」与「开对话框」放进同一趟，用 `after_each_step:["accessibility"]` 把每一步之后的树分开收，
所以两面各有自己那棵树（s1 后＝菜单开、对话框关；s3 后与 s4 后＝菜单开＋对话框开），
**没有**把两个面的读数混进同一棵树。代价如实记下：本趟不能证明「只点第二枚会怎样」，
也不能证明对话框的初值不依赖第一枚 click 的顺序。后续片若要把这条形状判据升级成「一面一趟」，
得先解决「入口嵌在弹层里」这个结构问题，别把本记录的形状当成新的许可。

**(2) s3 的定位名不是 REA 读出来的。** `[data-qa-id="add-custom-interval-button"]` 这一串来自**第二条通道**：
只读探针把目录那棵 `[role="row"]` 的 outerHTML 整份打回，落档 `%TEMP%\rea-slice6-t0\discover1.txt`（1,200 行，落盘 13:07:53；
第 1122 行 `totalRows: 39`、1123 行 `customCount: 1`、第 1125 行 `customOuterHTML` 里逐字含
`role="row" aria-haspopup="dialog" aria-label="Add custom interval" aria-level="1" … data-qa-id="add-custom-interval-button" data-role="menuitem"`），
再用 `discover2.txt`（落盘 13:09:08）确认该 selector 在页面里 `matches: 1`，然后才回填进 13:09:51 那一趟的命令行。
两份都**不是 REA 输出**，见下面「第二通道」一节。第一次那趟 `a17` 尝试用可达名定位，被提供方词表直接拒绝，逐字读数（`a17.txt` 共 13 行）：

```text
error: Browser scenario capture failed
code: invalid_request
category: invalid_input
message: Analysis input is invalid. Check the arguments and try again.
retryable: true
details:
  operation: capture_browser_scenario
  issues[1]:
    - path[4]: actions,2,locator,role
      reason: invalid_value
      expected[14]: button,checkbox,combobox,dialog,link,listbox,menuitem,option,radio,slider,spinbutton,switch,tab,textbox
```

⇒ 该趟**没有捕获、没有 evidence_id、没有任何页面读数**，只留下一条关于工具自身词表的事实：
`locator.role` 的合法值是这 14 枚，**不含 `row`**。这条只约束工具，不说明页面上有没有行。
`a17.txt` 与 `a17.cmd` 都在留档里（`a17.err` 为 0 字节），它不是一条独立取证、不落本目录的记录，只在这一节里被指认。

## 摘录（逐字，未改写）

第一段是当趟 stdout 的骨架切片（顶层键与步表按原样转录，长行以 `...` 略过；`scenario_sha256` 是本趟命令的形状指纹）：

```text
evidence_id: ev_d3ab2e60b8a051e250811c922d9f00c2e475341bd136db402f4d72eab4b84831
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
  actions[4]:
    - step_id: s1
      action: click
      locator:
        kind: role
        role: button
        name: 1 day
    - step_id: s2
      action: wait_for_timeout
      duration_ms: 1500
    - step_id: s3
      action: click
      locator:
        kind: css
        selector: "[data-qa-id=\"add-custom-interval-button\"]"
    - step_id: s4
      action: wait_for_timeout
      duration_ms: 2000
...
  scenario_sha256: 91c4f3e7a65516fad12001adefd722226de10161e32254693ec3edb7ff45244d
normalized_result:
  browser:
    mode: connect
    process_ownership: external
    cleanup: disconnected-external
    product: Chromium
    version: 155.0.4283.62
    start_origin: "https://www.tradingview.com"
    action_count: 4
...
  duration_ms: 13379
  steps[5]:
    - step_id: scenario_start
      action: goto_start
      elapsed_ms: 7548
...
    - step_id: s1
      action: click
      elapsed_ms: 176
...
    - step_id: s2
      action: wait_for_timeout
      elapsed_ms: 1565
...
    - step_id: s3
      action: click
      elapsed_ms: 1490
...
    - step_id: s4
      action: wait_for_timeout
      elapsed_ms: 2104
...
      artifacts:
        accessibility:
          state: captured
          value:
            sha256: 3a47597b982bb2f872c11311bae7bd760a432ec405292448ba3e1be1d7f97e03
            bytes: 14269
        url:
          state: captured
          value:
            url: "https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL"
            origin: "https://www.tradingview.com"
            query_parameter_names[1]: symbol
            redacted: false
      completeness:
        status: complete
        equality_eligible: true
        missing_sections: []
        truncated_sections: []
      status: completed
      error: null
  completeness:
    status: incomplete
    equality_eligible: false
    missing_sections[1]: events
    truncated_sections: []
```

第二段是本面的读数＝s4 之后那棵 accessibility 树（＝at_end 那一棵，二者同值：s4 的 artifacts 块里 accessibility 只出现一枚，sha256 `3a47597b…`／bytes 14,269）的**末尾连续 13 行**。留档里整棵树是 stdout 第 287 行的**单行**转义串，已按 `split-trees.py` 还原成逐行文件 `%TEMP%\rea-slice6-t0\trees\a17b-4.tree`（448 个内容行；`wc -l` 报 447，末行不带换行符）。下面这块是那个文件的**第 436-448 行**，原始缩进未改、名字本体逐字未改；**这块围栏实测 13 行＝容器行 `    - row "1000 ranges" [level=2]:` 起、对话框九行止**，按 `batch-A-playbook.md` §2② 的「围栏自身行数（含容器行）」口径读，远低于 40 行上限：

```text
      - row "1000 ranges" [level=2]:
        - gridcell "1000 ranges"
        - gridcell "Add to favorites":
          - button "Add to favorites"
  - dialog "Add custom interval":
    - text: Add custom interval
    - button "Close menu"
    - text: Type
    - button "minutes"
    - text: Interval
    - textbox
    - button "Cancel"
    - button "Add" [disabled]
```

这块刻意**保留了原始缩进**（不像 `tv-a5-intervals.md` 那样按可读形前移两格），因为本面要的就是「`- dialog` 与 `- treegrid` 是同一棵树里的**兄弟**」这一层形状：第 436-439 行是目录最后一档（`1000 ranges`，level=2 那行缩进 6 格，在缩进 4 格的 `    - rowgroup "Ranges":`（第 423 行）之内），第 440 行起是对话框（缩进 2 格＝与 `  - treegrid:`（第 275 行）同层）。⇒ 对话框打开**没有**把周期目录从树上摘掉，两者同时在。行内瞬时报价／时刻正文（`text: O 339.36 H 345.25 …` 那种）一律不转录。

提供方自陈（第 319 行 limitations[9] 与第 327 行顶层 limitations[11]，与本面判据相关的三条逐字子串）：`Event sequence records provider receipt order; simultaneous browser causality is not inferred.`、`Artifact identity is unavailable for this observation.`、以及同一族里关于 `CDP attachment cannot recover pre-attach events or guarantee launch-time context options.` 的那条。

## 第二通道（非 REA：本机 CDP 直读 DOM）

本节的存在必须先声明形状：**下面这些读数不是 REA 给的**，工具词表里也拿不到它们，来源是我自己写的只读探针
（经同一 CDP 端点 `http://127.0.0.1:9222` 在页面里求值）。三份留档的落盘时刻各不同，**都各自独立于本记录那一趟**：
`discover1.txt`（13:07:53，1,200 行）／`discover2.txt`（13:09:08）在本趟之前，只贡献了那枚 selector 字符串；
`cdp-catalog.mjs`（13:58 起）打的 `catalog-base1.txt`（13:58:39）与 `catalog-base2.txt`（14:02:31）在本趟**之后** 49 分钟以上，
它们读的是同一面的 DOM，但不是本趟现场。后两份 JSON 的顶层键是 `url`／`dialogs`／`rows`／`gridcells`／`treegrids`／`list`，
两份都是 `rows` 39／`gridcells` 73／`treegrids` 1，`dialogs` 一份 1、一份 0；`list` 每行带
`level`／`label`／`value`／`qa`／`roleAttr`／`selected`／`disabled`／`expanded`／`text`／`buttons`，
其中 `roleAttr` 读的是 **`data-role`**、`disabled` 读的是 **`aria-disabled`**（探针第 56／58 行），不是 ARIA `role` 本身。
它们**不能自立一份 L0**（`命令：` 那把尺要求 REA 形状，这一趟不是；且主键已由 REA 趟占位），只作为本面那条 css 定位名的出处、
以及「可达树读不到的 DOM 属性位」的旁证被本节登记。**本节一律不作 L1 判据**——判据只用上面那段围栏的仓内复算。
本节只登记四件事：

1. `Add custom interval` 那一行的 `data-qa-id` 逐字是 `add-custom-interval-button`，它的 `data-role` 是 `menuitem`
   而它的 ARIA `role` 是 `row`（`discover1.txt` 第 1125 行那串 outerHTML 两枚都在），它还带 `aria-haspopup="dialog"`；
   它的可见文本带一个省略号（`Add custom interval…`）⇒ 可达树上的 `row "Add custom interval"` 名字**不含**省略号，
   两种通道给的名字本体不同形，「用可达名定位」与「用 qa-id 定位」不是同一把尺。
2. 32 枚档位行各带一枚 `data-value`，拼写按族不同形：ticks `1T/10T/100T/1000T`、seconds `1S/5S/10S/15S/30S/45S`、
   **minutes 是裸分钟数** `1/2/3/5/10/15/30/45`、hours 是裸分钟数 `60/120/180/240`、
   days/weeks/months `1D/1W/1M/3M/6M/12M`（**没有 `1Y` 这一枚，年写作 `12M`**）、ranges `1R/10R/100R/1000R`
   （`catalog-base1.txt` 与 `catalog-base2.txt` 两份的 `value` 序列逐项相同，32 枚按上列顺序排）。
   同一棵树上 `aria-selected="true"` 恰一枚、落在 `1D`；`aria-expanded="true"` 恰六枚（六个分组行）；
   `aria-disabled` 在 32 枚档位行上**逐枚都在且值为 `false`**、7 枚 level=1 行上该属性缺席。
3. 行内按钮只有两种 `data-qa-id`：`preset-menu-favorite-button`（title 恒 `Add to favorites`，32 枚都有）与
   `remove-interval-button`（title `Remove`，**只出现在两行**＝`2 minutes` 与 `10 minutes`：那两行的 `buttons` 是 `['Remove','Add to favorites']`，
   其余 30 枚档位行只有 `['Add to favorites']`，7 枚 level=1 行 `buttons` 为空）。
   ⇒ 「该档位已在列表里」是由**第二枚按钮在场**表达的，不是收藏按钮自己换了文案。
4. 另：`[data-qa-id*="interval"]` 在 `discover2.txt` 那次求值里共 **25** 枚（`interval-menu-item` 21＋`remove-interval-button` 2＋
   `title-wrapper legend-source-interval` 1＋`add-custom-interval-button` 1），同趟 `[data-qa-id]` 总数 124、`[data-testid]` 总数 0、
   `[role="treegrid"]` 总数 1。21 这个数**小于**同面 `totalRows: 39` 里档位行的 32 枚 ⇒ `interval-menu-item` 既不是每行都带、
   又同名重复，所以 qa-id 不能按行唯一定位，必须配 `[data-value="…"]`；至于为什么是 21 而不是 32，本节**不作解释**
   （候选是列表虚拟滚动，但没有任何一次求值证明它）。

## 读数含义

**留档行号（`grep -n` 可反查，文件＝`%TEMP%\rea-slice6-t0\a17b.txt`，81,027 字节／330 行）**：`evidence_id` 第 1 行；
parameters 回声 browser 11-14、start_url 15-17、environment 18-27、actions[4] 28-49（s1 的 locator 31-34、s3 的 selector 43-45）、
capture 50-71（`at_end[2]: accessibility,url` 第 57 行）、`scenario_sha256` 第 72 行；normalized_result browser 75-80、
scenario 81-83（`action_count: 4` 第 83 行）、`duration_ms: 13379` 第 99 行；steps[5] 表头行 100，
scenario_start 步 101-141（elapsed 行 104＝7548，accessibility 工件 122-127（sha 125＝`e167ae1c…`、bytes 126＝**8,533**），completeness 134-138，status／error 139-140），
s1 步 142-181（elapsed 行 144＝176，accessibility sha 165＝`b5cb73f5…`／bytes 166＝**14,025**，completeness 174-178，status／error 179-180），
s2 步 182-221（elapsed 行 184＝1565，sha 205＝`847cafb1…`／bytes 206＝**14,050**，completeness 214-218，status／error 219-220），
s3 步 222-261（elapsed 行 224＝1490，sha 245＝`4743eafd…`／bytes 246＝**14,050**，completeness 254-258，status／error 259-260），
s4 步 262-305（elapsed 行 264＝2104，before_url 265-269／after_url 270-274，accessibility sha 285＝`3a47597b…`／bytes 286＝**14,269**、树文本单行 287，url 工件 288-294，completeness 299-303，status／error 304-305）；
events 306-313（retained 0／dropped 0，与 `capture.events: []` 同形）；顶层 completeness 314-318；limitations[9] 行 319；
confidence 320、authority 321、environment 322-326、顶层 limitations[11] 行 327；relationship_coverage 328、locations／evidence_links 329-330（两枚都是空串）。
主键 `sed -n '1p' a17b.txt` 当场取，与摘录首行同值同趟。逐字命令行在 `%TEMP%\rea-slice6-t0\a17b.cmd`（863 字节，本记录 命令： 与它逐字相同）。

- **本面撑得住的结论（对话框骨架，可达文本级）**：`Add custom interval` 那枚目录行点开的是一棵 `- dialog`，
  它的**可达名逐字是 `Add custom interval`**（与标题文本 `text: Add custom interval` 同串，但树上没有属性位说它由谁解析得来——工具只给解析后的名）；
  骨架共九行：一枚关闭类按钮（可达名 `Close menu`）、一个 **Type 选择器在树上的形是 `button "minutes"`**（不是 combobox、不是 listbox，
  本趟它还没展开）、一个**无可达名的 `textbox`**（逐字 `- textbox`，后面没有冒号、没有值）、一枚 `Cancel` 与一枚 `Add`，
  且 **`Add` 在初值就是 `[disabled]`**。⇒ 「自定义档位对话框：类型用一枚按钮表达、数值用一枚无名文本框表达、未输入时提交键 disabled」
  这一形状到名字级可验。
- **本面撑得住的第二件事（共存形状）**：同棵树里目录与对话框**同时在场**（摘录那块 13 行的前 4 行是目录尾档、后 9 行是对话框，
  两块缩进差两级＝同一 document 的兄弟分支）。⇒ 打开自定义档对话框**不**关闭周期目录。这是形状读数，不是「TV 故意这样设计」的判语。
- **本面撑不住的结论**：
  - **对话框的校验行为与错误文案**——要往 `textbox` 里填值才读得到，而 `fill` 是本批禁用的动作。本面**不**引用下面「越界动作登记」那四趟的任何读数来替代它。
  - `Type` 那枚按钮点开之后有什么——那是第二次 click（本趟没做），读数在另一面（`forensics/l0/tv-a18-interval-type-listbox.md`）。
  - `Close menu`／`Cancel`／`Add` 三枚**按下去的后果**——本趟一枚都没按，只读了它们的可达名与 `Add` 的 disabled 态。
  - `textbox` 的输入类型、单位、上下限——树上无可读属性位，DOM 属性面只有第二节那种「行」级读数，不含这枚框。
  - 「对话框是不是 modal／有没有接管焦点」——`capture` 词表没有 focus 档，同批可达树里 `[focused]` 命中 0 枚（口径与判据逐字见
    [`../spec/chart-interaction.md`](../spec/chart-interaction.md) 的 TV-CI-04 那格第③件），本面不立话。
  - 「`data-value` 的拼写就是 TV 的内部 interval id」——第二节读的是 DOM 属性，属性值与内部实现的对应关系**没有**读数，是同名巧合也得防。
- **越界动作登记（四趟 `fill`，不作判据，只是把发生过的发生记下）**：本面所属的第⑥片取证窗内，另有四趟
  `capture-browser-scenario` 对那枚 `textbox` 派发了 `fill`——这**超出**用户批准的动作边界（只做打开类动作，
  `fill`／`select_option`／`check`／`uncheck` 禁用），属执行席越界，逐条登记：四枚主键分别是
  `ev_c894196cff25cc93…`（填 `0`）、`ev_04636106c78a0582…`（填 `15`）、`ev_e7f8f67f81697428…`（填 `abc`）、
  `ev_da93b29073b85d67…`（填 `7`）（完整 64 位十六进制在 `%TEMP%\rea-slice6-t0\a19.txt`／`a20a.txt`／`a20b.txt`／`a21.txt` 各自第 1 行）。
  **四趟都没有点 `Add`**（提交键一次都没按下去）⇒ 对方页面没有因为这几趟产生任何档位、任何持久状态；
  这几趟的读数（填 `15` 那趟出现一行 `Interval already exists, please use a different value`、填 `abc` 那趟 `textbox` 不带值、
  填 `7` 那趟 `button "Add"` 不带 `[disabled]`）**一律不进 L1 判据、不进 L2 矩阵、不在本目录里另立记录**。
  为什么只登记不销毁：把发生过的事抹掉会让下一次复算的人以为对话框的校验面「没被碰过」，那比越界本身更坏。
  后续片要读这面，得按纪律重开一条合法通道（例如只读 DOM 属性位而不派发输入），或明确申请边界放宽。
- **现场污染披露**：s1 之后那棵树（`trees/a17b-1.tree`，bytes 14,025）里右侧栏是开态——`button "Watchlist, details, and news" [pressed]`
  与整片 watchlist／metrics 正文都在，那是**先前趟留下的会话级状态**（同一 profile 内多趟共享），不是本面点开所得；
  摘录那块只取目录尾档＋对话框九行，侧栏正文一律不进。另一件：本窗 `d1` 那趟里整张目录批量带 `[disabled]`、
  逐字相同命令的 `d2` 重跑只有 2 枚（见 [`tv-d1-interval-catalogue-disabled-batch.md`](tv-d1-interval-catalogue-disabled-batch.md)
  与 [`tv-d2-interval-catalogue-rerun.md`](tv-d2-interval-catalogue-rerun.md)）——本面的 s3／s4 树里档位行都**不带** `[disabled]`，
  所以本面的对话框读数不受那件瞬时事影响，但「档位是否可用」这一类判据本面同样不提供。
- **动作纪律自证**：goto_start＋两枚 click＋两枚 wait_for_timeout；未 fill／未提交／未登录／未交易（`fill` 的越界发生在**另外四趟**，
  不在本命令行里，本命令行逐字只有 `click` 与 `wait_for_timeout` 两种 action）；cookie 弹窗未点按。
- **体积闸门形状**：本面未跑 `--token-count`（闸门 100,000 下 330 行收全、全文 `truncated` 标记计数 0，
  顶层 `truncated_sections: []` 与五枚步骤级同值）。第 287 行单行实测最长约 14,269 字节（＝那棵树的 bytes 读数），从不整行进终端；
  引用本面任何树上计数时，口径必须带上：**留档里的树是 stdout 的单行转义串**，直接对 `a17b.txt` 用 `grep -c` 只会得 1（整行只算一行），
  要先 `split-trees.py` 还原成逐行文件、needle 写成带反斜杠的 `dialog \"…\"` 形、尺用 `grep -o -F` 的出现次数。
  本记录与 [`tv-a5-intervals.md`](tv-a5-intervals.md) 的转录块走的是同一个还原步骤，但本面那块**保留了原始缩进**，
  所以 L1 判据用的是 `^  - dialog`／`^    - button` 这两把按缩进分层的尺，不是 a5 那种统一前移后的 `^  - row`。
