# L0：自家页「画线清单」入口按钮的开关态（TV-CI-07 的执行半）

- 命令：npx -y rea-agents@latest capture-browser-scenario '{"browser":{"mode":"connect","cdp_endpoint":"http://127.0.0.1:9222","target_id":"24A40B21CF0B1F687F8501A7033793E9"},"start_url":{"url":"http://localhost:5899/pro-chart"},"actions":[{"step_id":"s1","action":"click","locator":{"kind":"role","role":"button","name":"画线清单"}}],"storage":{"cookies":[],"local_storage":[],"session_storage":[]},"secrets":[],"capture":{"after_each_step":[],"at_end":["url","accessibility"],"events":[],"network":{"request_body":false,"response_body":false,"header_values":false}}}' --filter-output evidence_id,normalized_result --token-limit 150000
- 命令（诊断趟，2026-10-14 终席追加）：上面那条 `命令：` 是 run1／run2 那两趟**逐字相同**的命令（本记录的主键就是它）；下面这一段是同日第三趟＝**同一趟内连点同一枚按钮两次＋`capture.after_each_step:["accessibility"]`** 的诊断趟。它的逐字命令行现在被 L1 的 TV-CI-07 判据格引用为「自家页侧的验收命令」（`docs/forensics/spec/chart-interaction.md:24`，那一格只把 `target_id` 换成当趟由 `list-browser-targets` 现读的 `<tid>` 占位，其余逐字不动），两处互为凭据：那一格指回本记录取实测读数，本记录指回那一格取判据形状。主键 `ev_c21cfd73a0eff996a0665cb0e45f793cac14019ce191743c052b6e09a1017fa4`＝本席 `sed -n '1p' ci07-diag.out` 的现读值；本席现量的留档尺寸＝`ci07-diag.cmd` 730 字节／`ci07-diag.out` 18,646 字节（行数＝在 `/tmp/rea-t11b` 里跑 `wc -l ci07-diag.out`，本席 2026-10-14 复核读数 **153**；此处初稿写的是「154 行」，属转抄错误，按只追加纪律标废不删），与上面「留档」那条记的 18,646 字节同值。命令形制与 run1／run2 的差别只有三处：`actions` 从一步变两步（两步 locator 逐字相同）、`capture.after_each_step` 由空数组变 `["accessibility"]`、`capture.at_end` 由 `["url","accessibility"]` 变 `["url"]`；**没有** `--allowed-origins`（那把旗标在场景命令上被拒，见下面第四枚摘录）。逐字：

    ```text
    npx -y rea-agents@latest capture-browser-scenario '{"browser":{"mode":"connect","cdp_endpoint":"http://127.0.0.1:9222","target_id":"24A40B21CF0B1F687F8501A7033793E9"},"start_url":{"url":"http://localhost:5899/pro-chart"},"actions":[{"step_id":"s1","action":"click","locator":{"kind":"role","role":"button","name":"画线清单"}},{"step_id":"s2","action":"click","locator":{"kind":"role","role":"button","name":"画线清单"}}],"storage":{"cookies":[],"local_storage":[],"session_storage":[]},"secrets":[],"capture":{"after_each_step":["accessibility"],"at_end":["url"],"events":[],"network":{"request_body":false,"response_body":false,"header_values":false}}}' --filter-output evidence_id,normalized_result --token-limit 150000
    ```

- evidence_id：ev_99229678637217cd1e8e29b9c3d610a91c90e860c79e9e6a35fde9e1799fa3d3
- 浏览器：Chromium 155.0.4283.45（当趟 stdout 第 3-8 行 browser 块逐字：mode connect／process_ownership external／cleanup disconnected-external／product Chromium／version 155.0.4283.45）；宿主与现场与 `self-dw07-pixel-equality.md` 同一趟浏览器（本机 Edge --headless=new，CDP 9222，target_id 24A40B21CF0B1F687F8501A7033793E9，全程未重启）。口径差别要记着：场景命令的 browser 块给的是 `product: Chromium` ＋ 独立的 `version`，而单趟 CDP 命令给的是 `product: Edg/155.0.4283.45`，两种形读数同属 Edge 155.0.4283.45，别当成两个浏览器
- 目标 URL：http://localhost:5899/pro-chart（**自家 dev server，不是 tradingview.com**；第 10 行 `scenario.start_origin` 回声 http://localhost:5899，第 23-32 行 step 0 的 before_url 与 after_url 同值 ⇒ 开头那次导航没换页；第 64-68 行 click 步的 after_url 仍是同一串 ⇒ 这一次点击没换路由）
- 观察条件：本记录 vouches 的第一趟＝run1（第 17 行 `duration_ms: 3343`，click 步第 58 行 `elapsed_ms: 2931`），对端趟＝run2（`duration_ms: 3383`、click 步 `elapsed_ms: 2928`），两趟命令行**逐字相同**（复算 `diff ci07-run1.cmd ci07-run2.cmd`＝rc 0）、同一浏览器现场、不 reload、不重启；前置＝画布上已有一条导入的 `水平线`（导入趟 `ev_7ad6adae1f0642139e57d67bbaca740c3fba52b37c9af911a03f4930cf6793a2` 同趟读到 `button \"画线清单\": 清单 · 1`，即按钮已解禁且面板关着），零画线时这枚按钮逐字带 `[disabled]`（对照趟 `ev_12967cfc096da2f058360cdf7dbeb1d73d2b23edcc19d4081ad5814a7550911e`，复算 `grep -c 'button \\"画线清单\\" \[disabled\]' setup-probe.out`＝1），所以没有那条画线这一步 click 打不动；除这一次 click 外未点按别的元素、未 fill、未切 tab、未登录、未保存、未交易；`storage` 三段逐字 `"cookies":[],"local_storage":[],"session_storage":[]` ⇒ 未请求任何 storage 读数
- 完整性：两层且不同值，本记录 完整性： 抄顶层并解释缺席面——顶层（第 104-108 行）`status: incomplete`／`equality_eligible: false`／`missing_sections[1]: events`／`truncated_sections: []`，而 `events` 缺席是本场景 JSON 自己把 `capture.events` 声明成空数组的结果，**不是页面上没有事件**；步骤级（click 步第 93-97 行）`status: complete`／`equality_eligible: true`／`missing_sections: []`／`truncated_sections: []`，其 accessibility 工件第 76-80 行 `state: captured`／`bytes: 5829`；另：`--filter-output` 按主键同趟口径写成 `evidence_id,normalized_result`（只点 `normalized_result` 会把顶层 `evidence_id` 一起滤掉）
- 用途：规格
- 取证时间：run1 落盘 mtime `2026-10-14 04:51:12.887403300 +0800`、run2 `04:51:30.061058500 +0800`、诊断趟 `04:52:17.973642800 +0800`（复算 `stat -c %y ci07-run1.out` 等三条；场景趟 stdout 里**没有绝对时间戳键**，只有 `duration_ms` 与逐步 `elapsed_ms`，所以这三个时刻记的是「写文件」不是「跑命令」，两趟的执行间隔只能由 mtime 上界读）
- 留档（仓外临时件，会随系统清理消失）：`C:/Users/fire/AppData/Local/Temp/rea-t11b/` 下 `ci07-run1.cmd`／`ci07-run1.out`（9,827 字节）、`ci07-run2.cmd`／`ci07-run2.out`（9,827 字节）、诊断趟 `ci07-diag.cmd`／`ci07-diag.out`（18,646 字节）、按规格原文照跑的两条失败趟 `ci07-as-written.cmd`／`.out` 与 `ci07-nocapture.cmd`／`.out`、前置导入趟 `setup-draw.cmd`／`.out`、零画线对照趟 `setup-probe.cmd`／`.out`

## 摘录（逐字，未改写）

第一段＝run1 stdout 的第 1 行与 click 步骨架（第 55-58、76-80、93-98 行）。可达树在留档里是第 81 行的**单行**转义串（项间字面 `\n`、引号字面 `\"`），下面第 81 行只截到本面判据那一枚按钮为止。

```text
evidence_id: ev_99229678637217cd1e8e29b9c3d610a91c90e860c79e9e6a35fde9e1799fa3d3
...
    - step_index: 1
      step_id: s1
      action: click
      elapsed_ms: 2931
...
        accessibility:
          state: captured
          value:
            sha256: c8bf9ad66d458f913a2f279f6539c6890600bd0b56ca812931329aceda029e34
            bytes: 5829
...
      completeness:
        status: complete
        equality_eligible: true
        missing_sections: []
        truncated_sections: []
      status: completed
      error: null
```

第二枚：那枚按钮在两趟里的逐字形态（各趟 accessibility 单行串里的片段，`grep -F` 可命中同一行）。围栏里两行**都是逐字片段、没有前缀**：第一行＝run1 stdout 第 81 行里的片段，第二行＝run2 stdout 第 81 行里的片段（两行逐字相同，这个「相同」本身就是本面「跨两趟同相」的读数）。形状更正（2026-10-14 终席）：这两行原先写成 `run1 第 81 行： - button \"画线清单\" [pressed]: 清单 · 1` 那种「中文标签＋空格＋片段」的**同一行**形状，后来者按整行 `grep -F` 会得 0 命中、把有源的摘录误判成无源；标签已移到围栏上方，围栏内容与移走之前逐字相同。

```text
 - button \"画线清单\" [pressed]: 清单 · 1
 - button \"画线清单\" [pressed]: 清单 · 1
```

第三枚：诊断趟（同一条命令里连点两次、树收到 `after_each_step:["accessibility"]`，主键 `ev_c21cfd73a0eff996a0665cb0e45f793cac14019ce191743c052b6e09a1017fa4`，逐字命令行见上面「命令（诊断趟）」那段）里那两次点击之后的同一枚按钮。围栏里两行同样**只有逐字片段**：第一行＝`step_id: s1` 那棵树（该 `step_id` 在 stdout 第 60 行，片段落在第 85 行）、第二行＝`step_id: s2` 那棵树（`step_id` 第 100 行）；`step_id: scenario_start` 在第 20 行。同一形状的前缀问题与移法同上枚，不重复一遍。

```text
 - button \"画线清单\" [pressed]: 清单 · 1
 - button \"画线清单\": 清单 · 1
```

第四枚：按 L1 规格原文那条命令照跑的两条失败趟（stdout 全文）：

```text
code: UNKNOWN
message: "Unknown flag: --allowed-origins"
```

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
  issues[1]:
    - path[2]: browser,target_id
      reason: missing_argument
      expected: string
```

## 判据与复算

判据要的是「同一条 click 在连续两趟里读到**相反**的面板态」。留档在仓外 `C:/Users/fire/AppData/Local/Temp/rea-t11b/`，可复跑：

```bash
cd "C:/Users/fire/AppData/Local/Temp/rea-t11b"
diff ci07-run1.cmd ci07-run2.cmd                                        # rc=0 ⇒ 两趟命令逐字相同
grep -c 'button \\"画线清单\\" \[pressed\]' ci07-run1.out                # 1
grep -c 'button \\"画线清单\\":' ci07-run1.out                           # 0
grep -c 'button \\"画线清单\\" \[pressed\]' ci07-run2.out                # 1
grep -c 'button \\"画线清单\\":' ci07-run2.out                          # 0
grep -c 'button \\"画线清单\\" \[pressed\]' ci07-diag.out                # 1
grep -c 'button \\"画线清单\\":' ci07-diag.out                          # 1
diff ci07-run1.out ci07-run2.out | grep -c '^[<>]'                      # 12
```

2026-10-14 现读：两趟都带 `[pressed]`、都不带「无 pressed」那一面 ⇒ **「跨两趟互补」这一半在自家页实测不成立**。两趟 stdout 全文只差 12 行，逐字是 `evidence_id`（各 1 行）、`duration_ms`（17 行）、两处 `elapsed_ms`（22、58 行）、accessibility 工件自身的 `sha256`（79 行），以及那棵树自己那一行（81 行）——树差的 20 个字节本席定位过：五处各 5 字节，就是清单行里那条图元的 id 后缀（run1 `overlay_1791924672349_1` 对 run2 `overlay_1791924689803_1`，恢复时重新生成的毫秒号），与开关态无关。

## 判因（这一条不是「实现缺」，是命令形状结构性挡住）

不是 disabled（前置画线在两趟里都在，`清单 · 1`）、不是可达树没带 pressed（`[pressed]` 明文在树里）、也不是面板状态有第二个来源——**是场景命令自己每趟开头都做一次导航**：两趟 stdout 都逐字有第 19-21 行 `step_index: 0`／`step_id: scenario_start`／`action: goto_start`（run1 `elapsed_ms: 394`、run2 `436`），而 `start_url` 是必填（去掉它的那趟报 `missing_argument`）、`browser.mode` 只有 `launch,connect` 两个取值 ⇒ 没有任何一种场景形状能跳过这趟开头导航。面板开关这一位在源码里是非持久初始值：`frontend/src/pages/ProChart.tsx:561` 逐字 `const [drawPanelOpen, setDrawPanelOpen] = useState(false);`，于是每一趟都从「关」起步、被这一次 click 打开、at_end 读到「开＋pressed」，两趟必然同相。

这两把必填与那把词表由控制席 2026-10-14 用死端口独立复跑过（`cdp_endpoint` 指向 `http://127.0.0.1:9`，全程没起浏览器），stdout 的 `details.issues[3]` 逐字是 `path[2]: browser,mode / reason: invalid_value / expected[2]: launch,connect`＋`path[1]: start_url / reason: missing_argument / expected: object`＋`path[1]: actions / reason: missing_argument / expected: array`，留档 `rea-t11b/mode-probe2.cmd`／`mode-probe2.out`。同一条命令加上 `--filter-output evidence_id,normalized_result` 时 rc 仍是 1 而 stdout 是 **0 字节**（留档 `rea-t11b/mode-probe.cmd`／`mode-probe.out`）——错误信封会被过滤键整份滤空，所以逼词表那一趟不许带 `--filter-output`（本记录第四枚摘录那两条 rc=1 的正文之所以读得到，是因为它们逐字照原文、没带过滤键）。

**开关本身是好的，这一句有实测支撑、不是从源码推的**：诊断趟在同一条命令里连点同一枚按钮两次并把树收到 `after_each_step:["accessibility"]`，第一次点击后带 `[pressed]`、第二次点击后不带（整趟两个形态各 1 次）⇒ 本仓实现确实让这枚按钮在打开／关闭之间翻转并自陈 pressed。拿不到的只是「跨两趟互补」，那件事在当前工具形状下结构上不可得。

## 限制

- 「点击之前面板是关着的」在两趟里是**推断**（由开头那次 `goto_start` ＋ `useState(false)` 的初始值），不是读数：`at_end` 只在 click 之后采一次，click 之前没有同趟的树。诊断趟里 click 之前那棵树是有的（step 0 的 accessibility 工件 `bytes: 1560`），但它 1560 字节对 click 后 5829 字节的差是**页面还没 hydrate 完**（那棵小树的头两行逐字是 `link \"Skip to main content\"` 而非中文形，且整棵树里没有出现 `画线清单` 四次中的任何一次），所以本记录不拿它当「点之前的面板态」读。
- 规格原文那条命令**不可执行**（第四枚摘录的两条 rc=1 读数）：`--allowed-origins` 不是场景命令的旗标（它的 Global Options 只有 `--filter-output`／`--format`／`--full-output`／`--help`／`--llms`／`--schema`／`--token-count`／`--token-limit`／`--token-offset`），而 `mode:"connect"` 下 `browser.target_id` 是必填。本记录的 命令： 是补齐这两处最小修正后的形状，除 `target_id` 与删掉被拒的旗标外还补了 `capture.at_end:["url","accessibility"]`（原文没写 `capture` 段，不补就拿不到树），`actions` 那一步的 locator 与 `--token-limit 150000` 逐字照原文。
- 空读数与 `not_found` 没被升级成结论；两趟同相、诊断趟互补，都是照实报的原始读数。本记录不指认那条画线靠什么活到下一趟（`storage` 三段全空＝未请求）。
