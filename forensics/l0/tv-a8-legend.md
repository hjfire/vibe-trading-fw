# L0：TV 图表页对象树与数据窗口面板的展开态（面 A8）

- 命令：npx -y rea-agents@latest capture-browser-scenario '{"browser":{"mode":"connect","cdp_endpoint":"http://127.0.0.1:9222","target_id":"AC6AD9CF5DC2168A150D7D28FA487F1B"},"start_url":{"url":"https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL"},"actions":[{"step_id":"s1","action":"click","locator":{"kind":"role","role":"button","name":"Object tree and data window"}},{"step_id":"s2","action":"wait_for_timeout","duration_ms":1500}],"storage":{"cookies":[],"local_storage":[],"session_storage":[]},"secrets":[],"capture":{"after_each_step":[],"at_end":["url","accessibility"],"events":[],"network":{"request_body":false,"response_body":false,"header_values":false}}}' --token-limit 100000
- evidence_id：ev_a2586fe4d3cd4341353feb1e7f10ab7bfb365d24de46339e159e66d3ff54d437
- 浏览器：Chromium 155.0.4283.45（本趟 stdout 第 56-61 行 browser 块自带这形读数：mode connect／process_ownership external／cleanup disconnected-external／product Chromium／version 155.0.4283.45；第 201-205 行 environment 的 id 为 Chromium@155.0.4283.45、platform 与 architecture 是 unknown。本面 stdout 不带 Edg 形产品串——Edg/155.0.4283.45、protocol_version "1.3"、js_version 15.5.9.4 是同一现场挂载趟 `targets-1.txt:25-29` 的读数，两趟现场同一个我方 PID 30280，出处在此写明而非默默借用）
- 目标 URL：https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL（parameters.start_url 回声第 15-17 行；at_end 的 url 工件第 171-177 行同值；s2 的 before_url 148-152 与 after_url 153-157 逐字段相同 ⇒ 点开面板没换页、没换路由）
- 留档（仓外临时件，会随清理消失）：C:\Users\fire\AppData\Local\Temp\rea-t10c\a8.txt（**被本记录引用的正式趟＝第二次正式跑**，208 行／11,812 字节；第 170 行是 at_end accessibility 的单行文本串）；同目录 a8.cmd（本记录 命令： 的逐字命令行，第二次正式跑执行前 tee 覆盖落档）、a8-count.txt（--token-count 读数＝3,153。这份留档只有 5 字节＝那个数字本身，count 趟的 stdout 全文与命令行都没落盘 ⇒ 读不到它自己的 `steps[].status`／`elapsed_ms`，**「它把侧栏面板点开了」是强推断而不是读数**，推断链见下面「读数含义」的 toggle 那一段与 `forensics/batch-A-playbook.md` §3③）、a8-firsttrip-closed.txt／a8-firsttrip-closed.cmd（第一次正式跑，键 ev_8c88d265524afee3f386cbeb02ea717fd8961a73d071776e6b537fd219d9ca70，当趟读到的是面板**关闭**态；另存不删、本记录不引用它的行号）、discover.cmd／discover.txt（枚举趟，主键 ev_ba280ca2dc3ab88359551bcc1868687099a6731826804f5002eb4c98cab748d2）、targets-1.txt（挂载趟）、precheck.txt 与 precheck-reg-internet-settings.txt（预检与注册表现读）
- 观察条件：Edge --headless=new（我方 PID 30280，netstat 现读）＋ --remote-debugging-port=9222 ＋ 专属新建 profile 目录 rea-cdp-profile-t10c ＋ --proxy-server=http://127.0.0.1:7897（当次 reg query 现读 ProxyEnable=0x1／ProxyServer=127.0.0.1:7897；预检裸连腿 http_code=000 且 curl 退出码 28，代理腿＝200）；URL 走 Edge 命令行参数；一趟一个打开动作：仅 click 一枚 role:button／name:"Object tree and data window"（定位名逐字取自本机枚举趟 discover.txt:124），随后 wait_for_timeout 1500ms；这枚按钮是**开关型**控件——本席第一趟正式跑恰好落在「面板已被 count 趟点开」的态上（**两处都是推断，不是读数**：①「是 count 趟点的」——count 趟 stdout 未留档；②「点之前是已开态」——只能由开关语义**反推**，盘上没有 click 之前的树读数：两趟留档里 s1 步的 accessibility 工件都是 `state: not_requested`（复算 `cd "$TEMP/rea-t10c" && for f in a8.txt a8-firsttrip-closed.txt; do printf '%s ' "$f"; sed -n '130p' "$f"; done`，两行读数逐字 `a8.txt           state: not_requested`／`a8-firsttrip-closed.txt           state: not_requested`；别把两个文件名一起喂给 `sed -n '130p'`——不带 `-s` 时行号跨文件连续计数，只会打印出一行），只有 s2 步第 166 行是 `state: captured`，而 s2 的读数排在 click 之后。口径详见「读数含义」的 toggle 那一段）；同一次 click 把它关掉了（那次是真实观察，留档 a8-firsttrip-closed.txt）；第二次跑落在关闭态上，click 打开面板，本记录引用第二次；未切 tab、未点按面板内任何按钮、未 fill、未提交、未登录、未保存、未交易、未派发 Escape；未改 UA、未禁用优化；视口 1280×720（第 19-22 行 environment 回声，我方窗口几何）；一次一面——本条只有 A8；闸门 --token-limit 100000（count 读数 3,153 是下界），全文 truncated 标记计数 0
- 完整性：顶层 completeness.status=incomplete（第 194 行）；equality_eligible: false（195）；missing_sections[1]: events（196）——批次清单 §4 的解释：本趟没开事件记录（capture.events: []，第 48 行），不是页面上没有事件；truncated_sections: []（197）。步骤级（s2 工件 completeness，182-186 行）：status: complete、equality_eligible: true、missing_sections: []。本记录 完整性： 抄顶层，两层都写明。第 163-164 行 dom 工件 state: not_requested ⇒ 本面未采 dom；第 198 行 limitations[7]、第 206 行顶层 limitations[9]
- 用途：规格
- 取证时间：2026-10-13T23:14:27+08:00（＝**第二次正式跑那趟的落盘 mtime**，复算命令与属性在「读数含义」的「时间戳复算」一段里逐字给出：`stat -c %y a8.txt`＝`2026-10-13 23:14:27.390920500 +0800`、python `os.stat('a8.txt').st_mtime` 格式化到秒＝23:14:27，两条同值。盘上可复算的只有**文件时间戳**这一类，它们记的是「写文件」不是「跑命令」，而写文件晚于跑命令 ⇒ **两趟的执行时刻都不可复算**：场景趟 stdout 里没有绝对时间戳键，只有 duration_ms 5074（第 70 行）与逐步 elapsed_ms。第一次正式跑（读到关闭态那趟）没有任何可引的时间读数——同目录 a8-firsttrip-closed.txt 的 mtime 与 st_ctime 现值都是 23:14:11，那是**另存（复制）时刻**（复制动作把新文件的时刻写进了这两个属性），不是那次执行的完成时刻，本记录不据它给第一次跑定时间，也不把 a8.txt 的 st_ctime 23:08:21 早于其 mtime 23:14:27 这一先后读成任何一趟的执行时刻。引用时间戳的坑（写明才不串味）：Windows 上 python 的 `os.stat().st_ctime` 是**创建时刻**，不是 Unix 语义的 inode-change——同一份 a8.txt，Git Bash `stat -c %z a8.txt` 给 23:14:27、python `st_ctime` 给 23:08:21，两个读数都真实但语义不同，引用时只准用**本条写明的那条命令的那一个属性值**）

## 摘录（逐字，未改写）

第一段是当趟（第二次正式跑）stdout 的骨架切片。第二段是 at_end accessibility 读数里与本面有关的条目——留档里整棵树是第 170 行的**单行**转义串（项间字面 `\n`、引号字面 `\"`），下面按可读形转录（名字本体逐字未改，`grep -F 名字本体 a8.txt` 命中第 170 行）；面板内对象行的合串文本与瞬时报价正文按 §2 红线不转录。图例区控件（Hide indicator legend 等）在枚举基线树里就已存在、非本面点开所得，只在「读数含义」指认。

```text
evidence_id: ev_a2586fe4d3cd4341353feb1e7f10ab7bfb365d24de46339e159e66d3ff54d437
...
  browser:
    mode: connect
    cdp_endpoint: "http://127.0.0.1:9222"
    target_id: AC6AD9CF5DC2168A150D7D28FA487F1B
  start_url:
    url: "https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL"
    query: []
...
  actions[2]:
    - step_id: s1
      action: click
      locator:
        kind: role
        role: button
        name: Object tree and data window
      button: left
      click_count: 1
    - step_id: s2
      action: wait_for_timeout
      duration_ms: 1500
...
    at_end[2]: url,accessibility
...
  browser:
    mode: connect
    process_ownership: external
    cleanup: disconnected-external
    product: Chromium
    version: 155.0.4283.45
  scenario:
    start_origin: "https://www.tradingview.com"
    action_count: 2
  duration_ms: 5074
  steps[3]:
    - step_index: 0
      step_id: scenario_start
      action: goto_start
      elapsed_ms: 2122
...
      status: completed
      error: null
    - step_index: 1
      step_id: s1
      action: click
      elapsed_ms: 1377
...
      status: completed
      error: null
    - step_index: 2
      step_id: s2
      action: wait_for_timeout
      elapsed_ms: 1558
...
      artifacts:
        screenshot:
          state: not_requested
        dom:
          state: not_requested
        accessibility:
          state: captured
          value:
            sha256: 63edc48e1a81b8729b187a7177c5d33d3fe46f8841a78e6a0cdc74582890ff74
            bytes: 4305
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
...
  completeness:
    status: incomplete
    equality_eligible: false
    missing_sections[1]: events
    truncated_sections: []
```

第二段：第 170 行 accessibility 串里与本面有关的条目（点开后新增的面板骨架，共 8 行）——

```text
- button "Object tree and data window" [pressed]
- tablist:
  - tab "Object tree" [selected]
  - tab "Data window"
  - button "Create a group of drawings" [disabled]
  - button "Clone, Copy" [disabled]
  - button "Move to" [disabled]
  - button "Manage layout drawings"
```

提供方自陈（第 198 行 limitations[7] 中与本面判据相关的两条，逐字子串）：`Event sequence records provider receipt order; simultaneous browser causality is not inferred.` 与 `CDP attachment cannot recover pre-attach events or guarantee launch-time context options.`

## 读数含义

**留档行号（`grep -n` 可反查，文件＝`%TEMP%\rea-t10c\a8.txt`）**：`evidence_id` 第 1 行；parameters 回声 browser 11-14、start_url 15-17、environment 18-27、actions 28-39（locator 31-34，name 行 34）、capture 45-52（at_end 行 47）、scenario_sha256 行 53；normalized_result browser 56-61、scenario 62-69、duration_ms 行 70；steps[3] 表头行 71，scenario_start 步 72-107（elapsed 行 75＝2122，status／error 106-107），s1 步 108-143（elapsed 行 111＝1377，status／error 142-143），s2 步 144-188（elapsed 行 147，before_url 148-152、after_url 153-157，accessibility 工件 165-170（state 166、sha256 168、bytes 169＝4,305、树文本单行 170），url 工件 171-177，步骤级 completeness 182-186，status／error 187-188）；events 189-192；顶层 completeness 193-197；limitations[7] 行 198；environment 199-205；limitations[9] 行 206；locations／evidence_links 207-208。主键 `sed -n '1p' a8.txt` 当场取，与摘录首行同值同趟。定位名 `Object tree and data window` 逐字出自本机枚举趟 `discover.txt:124`（`grep -Fn 'Object tree and data window' discover.txt` 命中第 124 行）。

**时间戳复算（本记录 取证时间： 那一行唯一的可复算依据；只读，2026-10-14 在本机复跑）**：

```bash
cd "$TEMP/rea-t10c"
PYTHONIOENCODING=utf-8 python -X utf8 -c "
import os,time
for f in ['a8.txt','a8-firsttrip-closed.txt']:
    s=os.stat(f)
    print(f,'mtime',time.strftime('%H:%M:%S',time.localtime(s.st_mtime)),
             'st_ctime',time.strftime('%H:%M:%S',time.localtime(s.st_ctime)))"
stat -c '%y | %z' a8.txt a8-firsttrip-closed.txt
```

原始读数逐字：`a8.txt mtime 23:14:27 st_ctime 23:08:21`／`a8-firsttrip-closed.txt mtime 23:14:11 st_ctime 23:14:11`；`stat -c %y a8.txt`＝`2026-10-13 23:14:27.390920500 +0800`（`%z` 同值）、`stat -c %y a8-firsttrip-closed.txt`＝`2026-10-13 23:14:11.084323900 +0800`。三个读数各自的语义：a8.txt 的 mtime＝第二次正式跑的**落盘时刻**（本记录 取证时间： 抄的就是它，属性＝`st_mtime`／`stat %y`）；a8-firsttrip-closed.txt 的 23:14:11＝**另存（复制）时刻**，不是第一次跑的完成时刻；a8.txt 的 `st_ctime` 23:08:21＝Windows 语义下的**文件创建时刻**，与 `stat -c %z` 给的同名属性读数不同（23:14:27），两者都对但一个读作创建、一个读作 inode-change，本记录不在这两个值之间做任何换算或排序。

- **本面撑得住的结论（面板有哪两页、面板上有哪些控件名）**：`Object tree and data window` 按钮点开右侧 widget 面板后：该按钮自陈 **[pressed]**；面板顶部是 **tablist 两页**——`Object tree`（selected）与 `Data window`；对象树工具条有四枚按钮 `Create a group of drawings`／`Clone, Copy`／`Move to`（三枚 [disabled]）与 `Manage layout drawings`（未 disabled）。⇒ 「图例／数据窗口这一面的入口是 widget 面板、它有两页、默认落在 Object tree 页、工具条四按钮且其中三枚在无选中对象时禁用」到名字级有证据面——三枚 disabled 正是「未选中图元时不可用」这一交互约束的可达文本证据。
- **toggle 语义是本席现场读到两趟的真实形状**：第一次正式跑 click 之后读到的是**关闭**态，「它点之前是已开」是据开关语义**反推**的，不是读数（两趟的 s1 步 accessibility 工件都 `not_requested`，复算见本条「观察条件」那行），而本席在它之前跑过的动作里没有第二枚 widget 面板按钮——A3／A5／A7 三面的场景各点 `Trend tools`／`1 day`／`Indicators, metrics, and strategies`（逐字见那三份记录的 `命令：`），三面正式趟第 170 行的树里又已经带着面板打开态残留（复算：`cd "$TEMP/rea-t10c" && for f in discover.txt a3.txt a5.txt a7.txt a8-firsttrip-closed.txt a8.txt; do printf '%s: ' $f; grep -o 'tab \\"Object tree\\"' $f | wc -l; done`，原始读数逐字 `discover.txt: 0`／`a3.txt: 1`／`a5.txt: 1`／`a7.txt: 1`／`a8-firsttrip-closed.txt: 0`／`a8.txt: 1`）⇒ **强推断：是 A8 自己的 count 趟把那枚开关按钮点了一次。这是推断，不是读数**——count 趟 stdout 未留档（`a8-count.txt` 5 字节只有 token 数），看不到它自己的 `steps[].status`；同一口径与理由记在 `forensics/batch-A-playbook.md` §3③（那里另立了「下一批把 count 趟 stdout 一起 `tee` 留档，让它从推断升级为读数」的规矩）。状态跨趟存续这一**现象**是本席读到的（count 趟之后、正式趟之前它仍在盘上），但**存续载体未读**——本记录 `命令：` 的 `storage` 段是 `"local_storage":[]`＝未请求任何 storage 读数，所以这里只记现象、不指名机制（原句「经 localStorage 类持久化」作废）；第一次正式跑在「已开」态上点同枚按钮 ⇒ 读到**关闭**态（增行仅 6 行瞬时价格类文本、无 tablist；键 ev_8c88d265…，留档 a8-firsttrip-closed.txt）；第二次跑在「已关」态上点 ⇒ 读到**打开**态（本记录）。两次都是 completed、error null。⇒ 「这枚按钮是开关不是单向打开」这句话有两趟方向相反的读数支持；本记录的主键与全部行号只来自第二次那趟。
- **本面撑不住的结论**：
  - 「图例每行显示哪几个字段、顺序如何」——图例（legend）是图表区控件，本面点开的是右侧 widget 面板；图例行文本（OHLC 报价合串等）是 `text:` 正文，红线不入库；图例区的按钮（Hide indicator legend 等）在**枚举基线**里就存在，本面没有点开它，也没有对它做任何读数。批次清单 §1 给 A8 的取物口径「图例展开那处」在本页的可达形状就是这个 widget 面板——「Data window 页里表格有哪几列」需要**第二次 click 切页**，本席纪律不允许，故**未读取**。
  - 「Object tree 里列出的对象集合」——面板树内的对象行是合串 `text:`（含瞬时行情值），未转录；匿名会话、未画任何图元时树里有什么，本面只指认到工具按钮级。
  - 三枚 [disabled] 的解禁条件——本面没做选中操作（禁点其它控件），只能写「观察到 disabled 态」，不能写「因为没选中所以 disabled」这种因果（limitations 首条：送达顺序不证因果）。
- **现场状态与 A3／A5／A7 的关系（污染闭环的交代）**：本席四面跑序是 count×4（其中只 A8 那一趟由现场态漂移**推**得它点着了那枚开关；A3／A5／A7 三面的 count 趟有没有点着，本批无法判定——三面留档各 5 字节只有 token 数）→ a3 → a5 → a7 → a8 第一趟（关掉）→ a8 第二趟（打开）。A3／A5／A7 正式趟的第 170 行树里因此都带着 widget 面板的打开态残留——那三面的记录已各自剔除、并写明增行是与 discover 基线做差的结果；本面（A8 第二趟）的树与面板打开态是**本趟 click 的直接结果**，摘录的就是它。
- **动作纪律自证**：goto_start＋一枚打开类 click＋wait_for_timeout；未切 tab、未点面板内按钮、未 fill、未提交、未登录；cookie 弹窗未点按。
- **体积闸门形状**：count 读数 3,153 是下界；正式趟 100,000 闸门下 208 行收全、无 truncated 标记；本面 accessibility 工件 bytes＝4,305（四面里最小——面板打开时右侧其余 widget 文本合串变短，不构成内容缺失判据，以步骤级 completeness status: complete 为准）。
