# L0：自家页「ƒ 脚本工作台」抽屉的无障碍自陈（TV-CI-04／TV-CI-05 的自家侧执行半）

- 命令：npx -y rea-agents@latest capture-browser-scenario '{"browser":{"mode":"connect","cdp_endpoint":"http://127.0.0.1:9222","target_id":"43768E494B4032AA633753D6AF7EBA7A"},"start_url":{"url":"http://localhost:5899/pro-chart"},"actions":[{"step_id":"s1","action":"click","locator":{"kind":"role","role":"button","name":"ƒ 指标公式"}},{"step_id":"s2","action":"click","locator":{"kind":"role","role":"tab","name":"脚本库"}},{"step_id":"s3","action":"click","locator":{"kind":"role","role":"button","name":"关闭脚本工作台"}}],"storage":{"cookies":[],"local_storage":[],"session_storage":[]},"secrets":[],"capture":{"after_each_step":["accessibility"],"at_end":["url"],"events":[],"network":{"request_body":false,"response_body":false,"header_values":false}}}' --filter-output evidence_id,normalized_result --token-limit 150000
- evidence_id：ev_02726672ce7a29856dcf5c1a5b8969173b52e791b62d62245bd320e92e1a6a73
- 浏览器：当趟 stdout 第 3-8 行 browser 块逐字：mode connect／process_ownership external／cleanup disconnected-external／product Chromium／version 155.0.4283.62。同一枚现场在身份趟 `probes/p1.cmd`／`p1.out`（rc=0，2,214 字节；逐字命令行＝`npx -y rea-agents@latest list-browser-targets http://127.0.0.1:9222 --token-limit 150000`，注意它吃的是**裸 endpoint 位置参**，不是场景那种 JSON 对象形，见第六枚第(1)件）里给的是 `product: Edg/155.0.4283.62`＋`protocol_version: "1.3"`＋`revision: 537.36 (@aa3a7406ba8c53a83536df539f07124d73c899bd)`——两种形读数同属本机那枚 headless Edge 155.0.4283.62，别当成两个浏览器（`self-ci07-panel-toggle.md` 的 浏览器： 记过同一型差别，本记录照它口径）。宿主＝`--headless=new --remote-debugging-port=9222`＋独立 `--user-data-dir`＋`--proxy-server` 起的 Edge，CDP `/json/version` 直读回 `Edg/155.0.4283.62`
- 目标 URL：http://localhost:5899/pro-chart（**自家 dev server，host 逐字 `localhost`，不是对方页面**；本记录刻意不在任何键值里写对方域名字面，免得 `tools/forensics_audit.py:52`／`:175` 那句「活树实测 2 份自家页记录带这句免责声明」的计数当场过期——那两行注释只数「写了该字面的记录」，本记录不写就不动它）。tB 逐字命令行里的 `start_url` 就是这一串；stdout 第 10 行 `start_origin: "http://localhost:5899"` 回声同一 origin，四步的 before_url／after_url 全是 `http://localhost:5899/pro-chart`（第 33-42／73-82／113-122／153-162 行）⇒ 三次 click 一次没换路由
- 观察条件：三趟（本记录主键趟 tB／关态前置趟 tA2／键鼠趟 tC）跑在**同一枚 target**（`43768E494B4032AA633753D6AF7EBA7A`，`probes/p1.out` 的 `targets[3]` 第二行逐字把它认在 `http://localhost:5899/pro-chart`、title `Vibe-Trading — vibe trading with your professional financial agent team`）、同一 Edge 现场、不 reload、不重启浏览器；被观测的实现＝`frontend` 树等于提交 `4063dbe0`（现读 `git show -s --format=%ci 4063dbe0`＝`2026-10-19 03:45:34 +0800`；三趟落盘 mtime 都在它之后；当时 HEAD 已是其后唯一一笔 `5dfe06ff`，而 `git diff --stat 4063dbe0 5dfe06ff -- frontend` 是**空**（那笔只动 `docs/`）⇒ dev server 供的 `frontend` 树与 `4063dbe0` 逐字同一份；本席复现时 `git status --porcelain -- frontend`＝0 行）。tB 只做三步：click 入口按钮、click「脚本库」页签、click「关闭脚本工作台」；tC 三步＝click 入口、对 dialog 按 `Escape`、对关闭按钮按 `Tab`；tA2 一步＝`wait_for_timeout 3000`，零次点击。**没有** fill／select／check、没登录、没保存脚本、没挂指标、没交易。`storage` 三段逐字 `"cookies":[],"local_storage":[],"session_storage":[]` ⇒ 未请求任何 storage 读数；`secrets` 空数组
- 完整性：两层且不同值，本记录 完整性： 抄顶层并解释缺席面——顶层（tB 第 202-206 行）`status: incomplete`／`equality_eligible: false`／`missing_sections[1]: events`／`truncated_sections: []`，而 `events` 缺席是场景 JSON 自己把 `capture.events` 声明成空数组的结果，**不是页面上没有事件**；四步逐步（第 62-66／102-106／142-146／187-191 行）全 `status: complete`／`equality_eligible: true`／`missing_sections: []`／`truncated_sections: []`。另：`--filter-output` 按主键同趟口径写成 `evidence_id,normalized_result`（只点 `normalized_result` 会把顶层 `evidence_id` 一起滤掉，见下面「限制」第(4)件）
- 用途：规格
- 取证时间：tA2 落盘 mtime `2026-10-19 04:02:18.993255900 +0800`、tB `04:03:29.390924700 +0800`、tC `04:05:44.899340700 +0800`、逐字复跑趟 p9 `04:18:28.817130600 +0800`（复算 `stat -c '%n %y %s' tA2.out tB.out tC.out probes/p9.out`；场景 stdout 里**没有绝对时间戳键**，只有 `duration_ms` 与逐步 `elapsed_ms`，所以这四个时刻记的是「写文件」不是「跑命令」，趟间隔只能由 mtime 上界读；p9 与 tC 之间隔了 13 分钟，那 13 分钟里跑的是九枚探针，见「留档」）
- 留档（仓外临时件，会随系统清理消失）：`C:/Users/fire/AppData/Local/Temp/rea-slice4-live/` 下 `tA2.cmd`（599 字节）／`tA2.out`（10,283 字节／123 行）、主键趟 `tB.cmd`（834）／`tB.out`（35,809／207 行）、键鼠趟 `tC.cmd`（873）／`tC.out`（33,467／207 行）、逐字复跑趟 `probes/p9.cmd`（599）／`p9.out`（12,577，`diff tA2.cmd probes/p9.cmd` rc=0）、形状探针 `probes/p1..p6.cmd`／`.out`（p1 身份趟、p2 `--schema`、p3..p6 是第六枚那四件）、`probes/q1..q3.cmd`／`.out`（q1＝`tA.cmd` 逐字相同的带过滤键失败趟、q2 `--llms` 17,217、q3 `--version` 6 字节）、同一失败条件不带过滤键的 `tA.cmd`（600）／`tA.out`（0）与 `tA-nofilter.cmd`（554）／`tA-nofilter.out`（455，第七枚全文）、`llms.txt`（80,223 字节，逐命令参数表）、运行器与两份逐字命令清单 `probes.sh`／`probes.txt`／`probes2.txt`。三趟主键趟与各复跑趟的 `.cmd` 与 `.out` 同趟成对，主键一律取该份 `.out` 第 1 行

## 摘录（逐字，未改写）

形状口径（引用本记录读数必须带上）：可达树在 stdout 里是**单行转义串**（项间字面 `\n`、引号字面 `\"`），所以下面围栏里每一枚都是**同一行里的连续片段**，标签一律写在围栏**上方**；数出现次数用 `grep -o -F`，不是 `grep -c` 行数那把尺（一整行的树在 `grep -c` 下永远至多 1）。

第一枚＝tB `step_id: s1`（树在 stdout 第 95 行，工件第 90-94 行 `state: captured`／sha256 `b8e2ad939d8dfbe37732c18cce20d741452578518e843d2ec6a47ea48112358b`／`bytes: 7550`）里那棵树的抽屉子树，整段在 tB 里命中 **1** 次：

```text
    - dialog \"ƒ 脚本工作台\":\n      - text: ƒ 脚本工作台\n      - button \"关闭脚本工作台\"\n      - tablist:\n        - tab \"编辑器\" [selected]\n        - tab \"脚本库\"\n        - tab \"导入导出\"\n        - tab \"策略报告\"\n        - tab \"条件筛选\"\n        - tab \"脚本告警\"\n      - text: 0/0 已挂载
```

同一段在 tC 里命中 **3** 次（三步各一棵，见第四枚），在 tA2 里 **0** 次，在逐字复跑趟 p9 里 **1** 次。

第二枚＝tB `step_id: s2`（`step_id` 第 110 行、树第 135 行、工件第 130-134 行 sha256 `add55492a435cf35072d6a80c7a25f218ed05730578c669614514bf37b757143`／`bytes: 11930`）里 selected 换了页：

```text
        - tab \"编辑器\"\n        - tab \"脚本库\" [selected]
```

第三枚＝同一棵 tB 里入口按钮的两种形态，两行都是逐字片段。第一行＝s1 与 s2（各带 `[pressed]`，tB 命中 **2**、tC 命中 **3**、p9 命中 **1**、tA2 命中 **0**）；第二行＝s3 点关闭之后与 tA2 的关态前置（tB 命中 **1**、tA2 命中 **1**、tC 与 p9 命中 **0**）：

```text
    - button \"ƒ 指标公式\" [pressed]\n    - button \"副图指标\"
    - button \"ƒ 指标公式\"\n    - button \"副图指标\"
```

第四枚＝键鼠趟 tC 里那三次采到的工件逐字（stdout 第 90-94／130-134／170-174 行）。s1 是 click、s2 是 `press Escape`、s3 是 `press Tab`，三枚 sha256 与 `bytes` **完全同值**，且与主键趟 tB 的 s1 工件同值：

```text
            sha256: b8e2ad939d8dfbe37732c18cce20d741452578518e843d2ec6a47ea48112358b
            bytes: 7550
```

第五枚＝四步动作自身的逐字骨架（tC stdout 第 29-32、69-72、109-112、149-152 行；`action: press` 两枚是本仓第一次在这套工具上按下键，`key` 见上面 `tC.cmd`）：

```text
    - step_index: 0
      step_id: scenario_start
      action: goto_start
      elapsed_ms: 1034
    - step_index: 1
      step_id: s1
      action: click
      elapsed_ms: 223
    - step_index: 2
      step_id: s2
      action: press
      elapsed_ms: 28
    - step_index: 3
      step_id: s3
      action: press
      elapsed_ms: 76
```

第六枚＝四枚形状探针的 rc=1 信封全文（逐字命令行同目录 `p3.cmd`／`p4.cmd`／`p5.cmd`／`p6.cmd`，都不带 `--filter-output`）。第(1)件 `p3.out`：`list-browser-targets` 不吃场景那种 JSON 对象形，只吃裸 endpoint 位置参；第(2)件 `p4.out`：动作词表九枚，**没有** `press_key`；第(3)件 `p5.out`：`press` 必带 `key`；第(4)件 `p6.out`：capture 词表六枚，**没有 focus**。

```text
error: Browser observation failed
code: invalid_request
category: invalid_input
message: Analysis input is invalid. Check the arguments and try again.
retryable: true
remediation:
  action: Correct the listed arguments and retry.
details:
  operation: list_browser_targets
  issues[1]:
    - path[1]: cdp_endpoint
      reason: invalid_value
      message: Invalid CDP endpoint URL
```

```text
details:
  operation: capture_browser_scenario
  issues[1]:
    - path[3]: actions,0,action
      reason: invalid_value
      expected[9]: goto,click,fill,press,select_option,check,uncheck,wait_for,wait_for_timeout
```

```text
details:
  operation: capture_browser_scenario
  issues[1]:
    - path[3]: actions,0,key
      reason: missing_argument
      expected: string
```

```text
details:
  operation: capture_browser_scenario
  issues[1]:
    - path[3]: capture,at_end,0
      reason: invalid_value
      expected[6]: screenshot,dom,accessibility,url,history,storage
```

第七枚＝`wait_for_timeout` 的时长键（`tA-nofilter.cmd`／`tA-nofilter.out`，455 字节，全文）——本仓旧记录写的 `milliseconds` 在 6.7.0 上已经两头都错：

```text
error: Browser scenario capture failed
code: invalid_request
category: invalid_input
message: Analysis input is invalid. Check the arguments and try again.
retryable: true
remediation:
  action: Correct the listed arguments and retry.
details:
  operation: capture_browser_scenario
  issues[2]:
    - path[3]: actions,0,duration_ms
      reason: missing_argument
      expected: number
    - path[3]: actions,0,milliseconds
      reason: unknown_argument
```

## 判据与复算

主键趟 tB 的判据形状＝**同一趟之内**按步收树（`capture.after_each_step:["accessibility"]`），不依赖跨趟互补——那件事在这枚入口上不成立：`ProChart.tsx:536` 逐字 `const [indPanelOpen, setIndPanelOpen] = useState(() => loadPanelVisibility().workbench);` 的初值走的是**会话级**持久（`frontend/src/lib/chartPanels.ts:57` 的 `savePanelVisibility` 写 `sessionStorage`，`ProChart.tsx:820-827` 那个 effect 是唯一的写者），所以同一枚 target 里逐字相同的命令复跑会翻面，见下面「判因」第二件。

```bash
cd "C:/Users/fire/AppData/Local/Temp/rea-slice4-live"
# 单行转义串里的片段一律用「单引号包 needle」的 grep -o -F 形：`\n` 与 `\"` 在单引号里就是文件里那两个字节
SNAP='    - dialog \"ƒ 脚本工作台\":\n      - text: ƒ 脚本工作台\n      - button \"关闭脚本工作台\"\n      - tablist:\n        - tab \"编辑器\" [selected]\n        - tab \"脚本库\"\n        - tab \"导入导出\"\n        - tab \"策略报告\"\n        - tab \"条件筛选\"\n        - tab \"脚本告警\"\n      - text: 0/0 已挂载'
grep -c 'step_id: s1' tB.out                                    # 1（另有 scenario_start 一步）
grep -o -F "$SNAP" tB.out | wc -l                               # 1
grep -o -F "$SNAP" tC.out | wc -l                               # 3
grep -o -F "$SNAP" tA2.out | wc -l                              # 0
grep -o -F "$SNAP" probes/p9.out | wc -l                        # 1（会话位还开着，见判因第二件）
grep -o -F 'dialog \"ƒ 脚本工作台\"' tB.out | wc -l              # 2（s1、s2；s3 归零）
grep -o -F 'dialog \"ƒ 脚本工作台\"' tC.out | wc -l              # 3
grep -o -F 'dialog \"ƒ 脚本工作台\"' probes/p9.out | wc -l       # 1
grep -o -F 'dialog \"ƒ 脚本工作台\"' tA2.out | wc -l             # 0（关态前置）
grep -o -F 'tablist' tB.out | wc -l                             # 2（同上，两棵开态树各一枚）
grep -o -F 'tablist' tC.out | wc -l                            # 3；p9 为 1
grep -o -F 'tab \"' tB.out | wc -l                              # 12（两棵开态树 × 六枚）
grep -o -F '[selected]' tB.out | wc -l                          # 2（每棵树恰一枚）
grep -o -F '[selected]' tC.out | wc -l                          # 3；p9 为 1；tA2 为 0
grep -o -F 'tab \"编辑器\" [selected]' tB.out | wc -l             # 1（落在 s1）
grep -o -F 'tab \"脚本库\" [selected]' tB.out | wc -l             # 1（落在 s2）
grep -o -F 'button \"ƒ 指标公式\" [pressed]' tB.out | wc -l        # 2
grep -o -F 'button \"ƒ 指标公式\" [pressed]' tC.out | wc -l        # 3（Escape 与 Tab 之后仍在）
grep -o -F 'button \"ƒ 指标公式\" [pressed]' probes/p9.out | wc -l # 1
grep -o -F 'button \"ƒ 指标公式\" [pressed]' tA2.out | wc -l       # 0
grep -o -F 'button \"ƒ 指标公式\"\n    - button' tB.out | wc -l   # 1（s3 关之后的那棵树）
grep -o -F 'button \"ƒ 指标公式\"\n    - button' tA2.out | wc -l  # 1；tC 与 p9 为 0
grep -o -F 'button \"关闭脚本工作台\"' tB.out | wc -l              # 2；tC 为 3、p9 为 1、tA2 为 0
grep -o -F '[focused]' tB.out | wc -l                           # 0；tA2／tC 同为 0
grep -o -F '[checked]' tB.out | wc -l                           # 1；[disabled] 为 36
grep -c -F 'b8e2ad939d8dfbe37732c18cce20d741452578518e843d2ec6a47ea48112358b' tC.out   # 3
grep -o -F 'bytes: 5418' tA2.out | wc -l                        # 1（关态那棵树的大小）
diff tA2.cmd probes/p9.cmd; echo $?                              # 0 ⇒ 复跑趟命令与 tA2 逐字相同
diff tA.cmd probes/q1.cmd; echo $?                                # 0 ⇒ 限制(4) 那两份 0 字节的趟同源
```

2026-10-19 现读（上面每一把尺本席都跑过，值写在右侧注释里，全为实测非推算）：tB 四棵树里 `dialog`／`tablist` 各 2 枚（开态两步各一枚，`s3` 点关闭后归零）、`tab` 12 枚＝两棵开态树 × 六枚、`[selected]` 2 枚＝每棵恰一枚且分别从「编辑器」走到「脚本库」；tA2 那棵关态树里这三枚计数全 0、入口按钮不带 `[pressed]`；tC 三棵开态树工件 sha256 逐字同值。可达名「ƒ 脚本工作台」由 `aria-labelledby` 解析这一半，在这套尺上的形状是：树里同时逐字有 `dialog \"ƒ 脚本工作台\"` 与标题那枚 `- text: ƒ 脚本工作台`（第一枚围栏里相邻两行），且**没有**任何直填的 aria-label 字面可读——工具给的是解析后的名字，不是属性来源，所以「名字由标题解析」这一步的证据在仓内针（`ScriptWorkbench.test.tsx:385` 按可达名查、`:382` 那条 `it` 的名字逐字写着「可达名由标题节点解析」）与 `IndicatorEditor.tsx:312` 的 `aria-labelledby="swb-title"`，不在本面。

## 判因

**第一件——焦点面结构性读不到，不是实现缺。** 两把尺各自独立都指到同一处：其一，`capture` 词表只有六枚（第六枚第(4)件：`expected[6]: screenshot,dom,accessibility,url,history,storage`），**没有** focus 这一档，`at_end:["focus"]` 直接 rc=1；其二，九棵树（tA2 1 棵＋tB 4 棵＋tC 4 棵，含每趟第 0 步 `scenario_start` 那棵小的）里 `[focused]` 命中 **0** 枚，而同样的方括号标记位上 `[pressed]`／`[selected]`／`[checked]`／`[disabled]` 都读得到（tB 全份：`[pressed]` 2、`[selected]` 2、`[checked]` 1、`[disabled]` 36）。⇒ 可达树反映的是 ARIA 语义位，不带 DOM 焦点。本仓那条「进抽屉把焦点送给关闭按钮／Tab 环回／关闭归还」的主张因此**不由本记录 vouch**，判据归 vitest 那四枚真断 `document.activeElement` 的针（`ScriptWorkbench.test.tsx:467`／`:473`／`:494`／`:525`，按 it 名可查）。这是负读数，本记录不把它升级成「焦点没动」。

**第二件——「起点态＝关」这句只在会话位为空时成立，同一枚 target 里会自己翻面。** 复跑趟 p9 用的是与 tA2 **逐字相同**的命令行（`diff tA2.cmd probes/p9.cmd` rc=0），tA2 读到 dialog 0／`[pressed]` 0，p9 读到 dialog **1**／`tablist` 1／`tab` 6／`[selected]` 1／`[pressed]` **1**——因为键鼠趟 tC 结束时抽屉是开着的，`savePanelVisibility` 把 `workbench` 写进 `sessionStorage`，而 p9 复用同一枚 target。⇒ 复算本记录第一把尺（tA2 的关态前置）之前必须先复位：在同一枚 target 里点一次「关闭脚本工作台」（四枚面板位全 false 时 `chartPanels.ts:63` 走 `removeItem`，否则 `:66` 写 `setItem`），或换一枚新 target。这与 `self-dw05-panel-session.md` 记的「初值改成会话级持久后，逐字相同的三趟读到 1/0/1 交替」是同一型现象，本记录只是把它落在自家这枚入口上；顺带一条实测形状：入口按钮**不是** toggle——`ProChart.tsx:779-782` 的 `openFormulaPanel` 只 `setIndPanelOpen(true)`，`:2866` 的 `onClick` 就是它，所以 p9 那次「已经开着」的状态下点击入口按钮也不会关掉它，关闭的唯一入口是抽屉里那枚「关闭脚本工作台」（tB `s3` 实测 dialog 归零）。

## 限制

- **(1) Escape 这一半有实测，但它测的是「没关」不是「不响应」**。tC 的 `s2` 对 dialog 按下 `Escape` 之后，树的工件 sha256 与 `s1` 逐字相同（第四枚）⇒ 至少「按 Escape 不会把抽屉从树上摘掉」在自家页是读数。反向那半句——「本仓刻意不实现 Escape 关闭」——是**实现选择＋仓内注释**（`IndicatorEditor.tsx:280-282` 写明理由：抽屉里装 Pine 公式草稿，全局 Escape→close 会让正在写公式的人在不自知的情况下丢稿），不是本面推出来的。对方页面有没有 Escape 读数仍然是一片空白（`tv-a7-indicator-dialog.md` 五枚 `action:` 零枚按键），本记录不给它补任何话。
- **(2) Tab 那一步不构成焦点判据**。tC `s3` 对关闭按钮按 `Tab`，树同样一字不变——但焦点根本不在树上（判因第一件），所以这枚读数既不能证环回、也不能证没环回，本记录只把它当「按下去了、树没动」报出来。
- **(3) `step_id: scenario_start` 那棵树不许当起点态读**。tB／tC 的第 0 步工件都是 2,360 字节（`tB.out`／`tC.out` 各自第 53 行 sha256 逐字相同 `b9207c1f10355ad3ef7e658ec3ff7c78525d70213e18c81cfbc4326069b42a92`、第 54 行 `bytes: 2360`；本行的「第 53／54 行」指那两份 stdout，不是本记录的行号——引本记录的行号一律写成下面那种「本记录第 17／25／42 行」形），比本记录上面逐字留档的开态工件小得多（tB `s1` `bytes: 7550`／tB `s2` `bytes: 11930`／tC 三步各 `7550`，见上面第 17／25／42 行），差的是页面还没 hydrate 完（那棵小树里连入口按钮都没有）。本席 2026-10-19 收尾复评（`e0441207`）一度把上一版那句「比同趟 s3 的 5,445 字节小得多」整截删掉，并写成「当趟 stdout 也已不在盘上，是不可复算的裸数」——**那半句改口本身是假的**，2026-10-19 同一收尾趟二次复评按第一方现读纠回：证据目录原样在盘（上面「判据与复算」那段第一行就 `cd` 进它），`grep -an 'bytes: ' tB.out` 现读第 54／94／134／174 行＝`2360`／`7550`／`11930`／`5445`，同尺 `tC.out` 第 54／94／134／174 行＝`2360`／`7550`／`7550`／`7550`；两趟第 53 行 sha256 逐字相同那一枚也在同一把尺下复读到。真病灶是上一版那句的主语张冠李戴：5,445 只属 tB（tB 的 `s3` 是点「关闭脚本工作台」之后那棵树），而 tC 的 `s3` 是按 Tab 那步、与 `s1` 同值 7,550（本记录第 38-42 行逐字认证），所以拿 5,445 当「两趟」共同的参照对 tC 不成立。该走的修法是按趟点名，不是把一枚可复算的读数删成裸数：tB 第 0 步的 2,360 对它自己的 s3＝5,445 与 s1＝7,550 都小得多，tC 第 0 步的 2,360 对它三棵树全 7,550 同样小得多——本记录里那句「比上面逐字留档的开态工件小得多」写的就是这个交集，不依赖 5,445。关态前置因此另开一趟 tA2（`wait_for_timeout 3000`，树 5,418 字节），并且受「判因」第二件那把会话位的限制。
- **(4) `--filter-output` 会把 rc=1 的错误信封滤成 0 字节**，本窗两次复现：`probes/q1.cmd`（与 `tA.cmd` 逐字相同，`diff tA.cmd probes/q1.cmd` rc=0，两份都 600 字节；带 `--filter-output evidence_id,normalized_result`）rc=1／stdout **0 字节**／stderr 0 字节，而同一条件不带过滤键的 `tA-nofilter.cmd`（554）／`.out`（455）才读得到第七枚那两句 `issues[2]`。⇒ 凡要逼词表／逼必填的探针趟，一律不许带过滤键（`self-ci07-panel-toggle.md` 的「判因」记过同型，这里是复现）。
- **(5) `--schema` 给不出场景 JSON 的词表**：`probes/p2.cmd`／`p2.out`（rc=0，190 字节）只返回 `{args:{properties:{inputJson:...}, required[1]: inputJson, additionalProperties: false}}`——注意它给的是**外层信封**（一个 `inputJson` 字符串参数），场景 JSON 内部的词表它一概不碰；动作与 capture 词表只能靠 rc=1 信封里的 `expected[N]` 反推（第六枚四件）。工具版本由 `probes/q3.cmd`／`q3.out` 直读 `6.7.0`（rc=0，6 字节）。
- **(6) 6.7.0 的形状漂移会让旧记录的逐字命令行被拒**，本窗实测四起：`list-browser-targets` 的 JSON 对象形（p3）、`action: press_key`（p4，现行是 `press` 且必带 `key`，p5）、`wait_for_timeout` 的 `milliseconds`（第七枚，现行 `duration_ms`）、`capture.at_end:["focus"]`（p6）。`self-ci07-panel-toggle.md`／`self-dw05-panel-session.md` 里那些逐字命令行若在今日复跑，会先撞上这四条里的某一条——那是尺换了，不是那些记录在说谎。
- **(7) 现场的三处留档缺口点名，不许读者自行补**：本记录那枚 target 是先经 CDP 的 `/json/new` 新建的（HTTP PUT，带 `url=` 查询参），**那一步的逐字命令行没有 tee 成 `.cmd`**；headless Edge 的启动行同样只在过程里用过、未留档；同目录那份 80,223 字节的逐命令参数表 `llms.txt` 也没有成对 `.cmd`（成对的是 `probes/q2.cmd`／`q2.out`，17,217 字节的命令索引）。target 身份因此由 `probes/p1.out`（同趟 `list-browser-targets`，rc=0）认，浏览器身份由 p1 的 browser 块与三趟的 browser 块互认。`inspect-web-page` 帮不上这件事：`--llms` 索引（`probes/q2.out` 第 98 行）里它的参数只有 `endpoint`＋`targetId`，选项全是被动观察（`--observationMs`／`--includeAccessibilityText` 等，细则在 `llms.txt` 第 1326-1350 行，本席按 `sed -n '1318,1360p' llms.txt` 现读过那节），**没有**在页面里执行脚本的入口，也没有 focus 面。
- **(8) 顶层 `equality_eligible: false` 是 `events` 被场景 JSON 自己声明成空数组的连带**，不是页面对比失败；本记录只把每一步的 `status: complete` 当可用采样的凭据。三趟里 `dialog`／`tablist`／`tab` 的出现次数全部按 `grep -o -F` 数（单行转义串），任何把它当 `grep -c -F` 行数复算的人会得到 1 而不是 12。
- **(9) 本记录不指认抽屉里那些页身内容**（六页各有什么控件）——tB `s2` 那棵 11,930 字节是「脚本库」页的读数，本面只取它的 `tab` 与 `[selected]` 两枚形状；其余内容留给各自的条目，不许从本记录外推。
