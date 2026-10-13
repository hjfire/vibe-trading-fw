# L0：TV 图表页指标对话框的展开态（面 A7）

- 命令：npx -y rea-agents@latest capture-browser-scenario '{"browser":{"mode":"connect","cdp_endpoint":"http://127.0.0.1:9222","target_id":"AC6AD9CF5DC2168A150D7D28FA487F1B"},"start_url":{"url":"https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL"},"actions":[{"step_id":"s1","action":"click","locator":{"kind":"role","role":"button","name":"Indicators, metrics, and strategies"}},{"step_id":"s2","action":"wait_for_timeout","duration_ms":1500}],"storage":{"cookies":[],"local_storage":[],"session_storage":[]},"secrets":[],"capture":{"after_each_step":[],"at_end":["url","accessibility"],"events":[],"network":{"request_body":false,"response_body":false,"header_values":false}}}' --token-limit 100000
- evidence_id：ev_2a1fbb5acb6ca4e0e03776896a78fd3978c725c1a70129e1e64de8ad64415b99
- 浏览器：Chromium 155.0.4283.45（本趟 stdout 第 56-61 行 browser 块自带这形读数：mode connect／process_ownership external／cleanup disconnected-external／product Chromium／version 155.0.4283.45；第 201-205 行 environment 的 id 为 Chromium@155.0.4283.45、platform 与 architecture 是 unknown。本面 stdout 不带 Edg 形产品串——Edg/155.0.4283.45、protocol_version "1.3"、js_version 15.5.9.4 是同一现场挂载趟 `targets-1.txt:25-29` 的读数，两趟现场同一个我方 PID 30280，出处在此写明而非默默借用）
- 目标 URL：https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL（parameters.start_url 回声第 15-17 行；at_end 的 url 工件第 171-177 行同值；s2 的 before_url 148-152 与 after_url 153-157 逐字段相同 ⇒ 点开对话框没换页、没换路由——它是对话框不是新页面）
- 留档（仓外临时件，会随清理消失）：C:\Users\fire\AppData\Local\Temp\rea-t10c\a7.txt（正式趟整份 stdout，208 行／12,963 字节；第 170 行是 at_end accessibility 的单行文本串）；同目录 a7.cmd（本记录 命令： 的逐字命令行，正式趟执行前先 tee 落档）、a7-count.txt（--token-count 读数＝4,546）、discover.cmd／discover.txt（枚举趟，主键 ev_ba280ca2dc3ab88359551bcc1868687099a6731826804f5002eb4c98cab748d2——取定位名的工作辅助，不落成 L0 记录）、targets-1.txt（挂载趟）、precheck.txt 与 precheck-reg-internet-settings.txt（预检与注册表现读）
- 观察条件：Edge --headless=new（我方 PID 30280，netstat 现读）＋ --remote-debugging-port=9222 ＋ 专属新建 profile 目录 rea-cdp-profile-t10c ＋ --proxy-server=http://127.0.0.1:7897（当次 reg query 现读 ProxyEnable=0x1／ProxyServer=127.0.0.1:7897；预检裸连腿 http_code=000 且 curl 退出码 28，代理腿＝200）；URL 走 Edge 命令行参数；一趟一个打开动作：仅 click 一枚 role:button／name:"Indicators, metrics, and strategies"（定位名逐字取自本机枚举趟 discover.txt:124），随后 wait_for_timeout 1500ms；**只打开，未往搜索框填任何东西、未切换 tab、未提交、未登录、未添加任何指标**、未派发 Escape；未改 UA、未禁用优化；视口 1280×720（第 19-22 行 environment 回声，我方窗口几何）；一次一面——本条只有 A7；闸门 --token-limit 100000（count 读数 4,546 是下界），全文 truncated 标记计数 0
- 完整性：顶层 completeness.status=incomplete（第 194 行）；equality_eligible: false（195）；missing_sections[1]: events（196）——批次清单 §4 的解释：本趟没开事件记录（capture.events: []，第 48 行），不是页面上没有事件；truncated_sections: []（197）。步骤级（s2 工件 completeness，182-186 行）：status: complete、equality_eligible: true、missing_sections: []。本记录 完整性： 抄顶层，两层都写明。第 163-164 行 dom 工件 state: not_requested ⇒ 本面未采 dom；第 198 行 limitations[7]、第 206 行顶层 limitations[9]
- 用途：基线
- 取证时间：2026-10-13T23:08:05+08:00（留档 a7.txt 落盘 mtime；场景趟 stdout 无绝对时间戳键，只有 duration_ms 6571（第 70 行）与逐步 elapsed_ms）

## 摘录（逐字，未改写）

第一段是当趟 stdout 的骨架切片（注意 parameters 回声里第 34 行把含逗号的 name 加了引号，逐字转录）。第二段是 at_end accessibility 读数里与 A7 有关的条目——留档里整棵树是第 170 行的**单行**转义串（项间字面 `\n`、引号字面 `\"`），下面按可读形转录（名字本体逐字未改，`grep -F 名字本体 a7.txt` 命中第 170 行）。对话框内那条内置指标名称的**成段清单文本**与左侧分类的合串 text 行按 §2 红线**不入库**，只在「读数含义」指认其存在与行号。

```text
evidence_id: ev_2a1fbb5acb6ca4e0e03776896a78fd3978c725c1a70129e1e64de8ad64415b99
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
        name: "Indicators, metrics, and strategies"
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
  duration_ms: 6571
  steps[3]:
    - step_index: 0
      step_id: scenario_start
      action: goto_start
      elapsed_ms: 4794
...
      status: completed
      error: null
    - step_index: 1
      step_id: s1
      action: click
      elapsed_ms: 204
...
      status: completed
      error: null
    - step_index: 2
      step_id: s2
      action: wait_for_timeout
      elapsed_ms: 1557
...
      artifacts:
        screenshot:
          state: not_requested
        dom:
          state: not_requested
        accessibility:
          state: captured
          value:
            sha256: 0ee5dec1cfd89068678c29ea58e6ec46692e673e9935102a356ce859175d1c2b
            bytes: 5416
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

第二段：第 170 行 accessibility 串里与指标对话框有关的条目（点开后新增的对话框骨架，role＋name 级，共 10 行）——

```text
- dialog "Indicators, metrics, and strategies":
  - button "Close menu"
  - searchbox "Search"
  - tablist:
    - tab "Indicators" [selected]
    - tab "Strategies"
    - tab "Profiles"
    - tab "Patterns"
    - tab "Options"
  - heading "Script name" [level=3]
```

提供方自陈（第 198 行 limitations[7] 中与本面判据相关的两条，逐字子串）：`Event sequence records provider receipt order; simultaneous browser causality is not inferred.` 与 `CDP attachment cannot recover pre-attach events or guarantee launch-time context options.`

## 读数含义

**留档行号（`grep -n` 可反查，文件＝`%TEMP%\rea-t10c\a7.txt`）**：`evidence_id` 第 1 行；parameters 回声 browser 11-14、start_url 15-17、environment 18-27、actions 28-39（locator 31-34，带引号的 name 行 34）、capture 45-52（at_end 行 47）、scenario_sha256 行 53；normalized_result browser 56-61、scenario 62-69、duration_ms 行 70；steps[3] 表头行 71，scenario_start 步 72-107（elapsed 行 75＝4794，status／error 106-107），s1 步 108-143（elapsed 行 111＝204，status／error 142-143），s2 步 144-188（elapsed 行 147，before_url 148-152、after_url 153-157，accessibility 工件 165-170（state 166、sha256 168、bytes 169＝5,416、树文本单行 170），url 工件 171-177，步骤级 completeness 182-186，status／error 187-188）；events 189-192；顶层 completeness 193-197；limitations[7] 行 198；environment 199-205；limitations[9] 行 206；locations／evidence_links 207-208。主键 `sed -n '1p' a7.txt` 当场取，与摘录首行同值同趟。定位名 `Indicators, metrics, and strategies` 逐字出自本机枚举趟 `discover.txt:124`（`grep -Fn 'Indicators, metrics, and strategies' discover.txt` 命中第 124 行）。

**本面增行数的复算（只读，2026-10-14 在本机复跑；「30 行」这一个数只由下面这条命令支撑）**：增行＝本趟第 170 行树相对基线 `discover.txt:124` 树的多集合差（`Counter(本趟) - Counter(基线)`），本面取 `a7.txt` 那一枚＝30。

```bash
cd "$TEMP/rea-t10c" && PYTHONIOENCODING=utf-8 python -X utf8 -c "
from collections import Counter
def T(fn,n): return open(fn,encoding='utf-8').read().split(chr(10))[n-1].split(chr(92)+'n')
b=Counter(T('discover.txt',124))
for f in ['a3.txt','a5.txt','a7.txt','a8.txt','a8-firsttrip-closed.txt']:
    print(f, sum((Counter(T(f,170))-b).values()))"
```

原始读数逐字：`a3.txt 136`／`a5.txt 182`／`a7.txt 30`／`a8.txt 16`／`a8-firsttrip-closed.txt 6`。口径：把留档里那一行转义树按字面 `\n` 切开成行集合后再算多集合差（重复行按重数计，被基线吃掉的重数不计）；这个计数**含侧栏残留行与瞬时 `text:` 行**（报价／时刻那种），它们只影响这个增行数，一律不进摘录——本面转录的是另一件事：第二段围栏里那 10 行对话框骨架。

- **本面撑得住的结论（对话框有哪几页、每页有哪些控件名）**：这枚按钮打开的是一个 **role: dialog**（可达名与按钮同名），骨架含：关闭按钮 `Close menu` 一枚、搜索框 `searchbox "Search"`（存在性证据；本面**没有**往里填任何东西）、**tablist 五页**——`Indicators`（selected）／`Strategies`／`Profiles`／`Patterns`／`Options`——以及列表区标题 `heading "Script name"`（level 3）。⇒ 「指标对话框顶层有五页签、默认落在 Indicators 页、页内有搜索框与脚本名列表」这句话到名字级有证据面。
- **「样式页」这一半本面没读到（如实）**：批次清单 §1 给 A7 的取物口径是「对话框有哪几页／每页有哪些字段名」，其中**样式／属性配置页**是选中某个指标之后才出现的第二层页面——那是第二次 click（先选列表行、再开属性），违反「一趟一个打开动作」，本席未跑。⇒ 本记录只覆盖主对话框；「样式页字段名」**没有**本面证据，L1 不许据本面写它。
- **本面撑不住的结论**：
  - 内置指标清单的内容——第 170 行内有一段**成段的可达文本**（`Script name` 标题之后的单行合串，枚举了内置技术指标名，bytes 169＝5,416 的树里主要体积就是它）。按 §2 红线（成段 accessibility 文本不入库）与裁定 1（不搬对方表达层），本记录**不转录、不计数**，只指认它存在于第 170 行。
  - 搜索行为与结果（禁 fill）、Strategies／Profiles／Patterns／Options 四页各自内容（未切页）、登录态分区（Personal／Purchased 类是匿名会话下的可达名，背后数据未验证）。
  - 「对话框＝新路由／弹层可分享链接」——before_url 与 after_url 逐字段相同（148-157 行），它不换页。
- **现场污染披露**：同 A3／A5——本趟第 170 行树里残留先前 A8 count 趟持久化的 widget-bar 面板项（tab Object tree／Data window 等），非本面点开所得，摘录已剔除；本面增行的判据是与基线树做**多集合差**：**30 行＝本趟第 170 行树相对基线 `discover.txt:124` 树新增的行数**，按多集合差（`Counter(本趟) - Counter(基线)`）算。这个计数**含侧栏残留行与瞬时 `text:` 行**（报价／时刻那种），它们只影响计数、**不进摘录**；转录另计，本面转录的是那 10 行对话框骨架。复算命令与原始读数逐字见下面「本面增行数的复算」。
- **动作纪律自证**：goto_start＋一枚打开类 click＋wait_for_timeout；未填、未选、未提交、未登录、未添加指标到图表（列表行一个都没点）；cookie 弹窗未点按。
- **体积闸门形状**：count 读数 4,546 是下界；正式趟 100,000 闸门下 208 行收全、无 truncated 标记。本面 accessibility 工件 bytes＝5,416，比 A3／A5 那两趟小——因为对话框打开时右侧 widget／图例区文本被对话框遮挡收进同一行树，体积不构成「内容缺失」的读数，以步骤级 completeness status: complete 为准。
