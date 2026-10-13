# L0：TV 图表页周期与分辨率菜单的展开态（面 A5）

- 命令：npx -y rea-agents@latest capture-browser-scenario '{"browser":{"mode":"connect","cdp_endpoint":"http://127.0.0.1:9222","target_id":"AC6AD9CF5DC2168A150D7D28FA487F1B"},"start_url":{"url":"https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL"},"actions":[{"step_id":"s1","action":"click","locator":{"kind":"role","role":"button","name":"1 day"}},{"step_id":"s2","action":"wait_for_timeout","duration_ms":1500}],"storage":{"cookies":[],"local_storage":[],"session_storage":[]},"secrets":[],"capture":{"after_each_step":[],"at_end":["url","accessibility"],"events":[],"network":{"request_body":false,"response_body":false,"header_values":false}}}' --token-limit 100000
- evidence_id：ev_b9a6851ee5882a8b46efe0a6b36bd92d9e9d6bf454c42b70d30baa7ee3ea36ca
- 浏览器：Chromium 155.0.4283.45（本趟 stdout 第 56-61 行 browser 块自带这形读数：mode connect／process_ownership external／cleanup disconnected-external／product Chromium／version 155.0.4283.45；第 201-205 行 environment 的 id 为 Chromium@155.0.4283.45、platform 与 architecture 是 unknown。本面 stdout 不带 Edg 形产品串——Edg/155.0.4283.45、protocol_version "1.3"、js_version 15.5.9.4 是同一现场挂载趟 `targets-1.txt:25-29` 的读数，两趟现场同一个我方 PID 30280，出处在此写明而非默默借用）
- 目标 URL：https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL（parameters.start_url 回声第 15-17 行；at_end 的 url 工件第 171-177 行同值；s2 的 before_url 148-152 与 after_url 153-157 逐字段相同 ⇒ 点完没换页、没换路由）
- 留档（仓外临时件，会随清理消失）：C:\Users\fire\AppData\Local\Temp\rea-t10c\a5.txt（正式趟整份 stdout，208 行／17,713 字节；第 170 行是 at_end accessibility 的单行文本串）；同目录 a5.cmd（本记录 命令： 的逐字命令行，正式趟执行前先 tee 落档）、a5-count.txt（--token-count 读数＝6,166）、discover.cmd／discover.txt（枚举趟 162 行／15,033 字节，主键 ev_ba280ca2dc3ab88359551bcc1868687099a6731826804f5002eb4c98cab748d2——取定位名的工作辅助，不落成 L0 记录）、targets-1.txt（挂载趟）、precheck.txt 与 precheck-reg-internet-settings.txt（预检与注册表现读）
- 观察条件：Edge --headless=new（我方 PID 30280，netstat 现读）＋ --remote-debugging-port=9222 ＋ 专属新建 profile 目录 rea-cdp-profile-t10c ＋ --proxy-server=http://127.0.0.1:7897（当次 reg query 现读 ProxyEnable=0x1／ProxyServer=127.0.0.1:7897；预检裸连腿 http_code=000 且 curl 退出码 28，代理腿＝200）；URL 走 Edge 命令行参数；一趟一个打开动作：仅 click 一枚 role:button／name:"1 day"（周期切换按钮；定位名逐字取自本机枚举趟 discover.txt:124 的可达文本读数——A1 那份记录也指认过这枚按钮带 hasPopup,menu，本面是它点开后的读数），随后 wait_for_timeout 1500ms；未点选任何周期行、未 fill、未提交、未登录、未保存、未交易、未派发 Escape；未改 UA、未禁用优化；视口 1280×720（第 19-22 行 environment 回声，我方窗口几何）；一次一面——本条只有 A5；闸门 --token-limit 100000（count 读数 6,166 是下界），全文 truncated 标记计数 0
- 完整性：顶层 completeness.status=incomplete（第 194 行）；equality_eligible: false（195）；missing_sections[1]: events（196）——批次清单 §4 的解释：本趟没开事件记录（capture.events: []，第 48 行），不是页面上没有事件；truncated_sections: []（197）。步骤级（s2 工件 completeness，182-186 行）：status: complete、equality_eligible: true、missing_sections: []。本记录 完整性： 抄顶层，两层都写明。第 163-164 行 dom 工件 state: not_requested ⇒ 本面未采 dom；第 198 行 limitations[7]、第 206 行顶层 limitations[9]
- 用途：规格
- 取证时间：2026-10-13T23:07:36+08:00（留档 a5.txt 落盘 mtime；场景趟 stdout 无绝对时间戳键，只有 duration_ms 4490（第 70 行）与逐步 elapsed_ms）

## 摘录（逐字，未改写）

第一段是当趟 stdout 的骨架切片；第二段是 at_end accessibility 读数里与 A5 有关的条目——留档里整棵树是第 170 行的**单行**转义串（项间字面 `\n`、引号字面 `\"`），下面按可读形转录（名字本体逐字未改，`grep -F 名字本体 a5.txt` 命中第 170 行），**这块围栏实测 40 行＝容器行 `- treegrid:` 1 行＋档位条目行 39 行**（复算，2026-10-14 本机现跑：`cd "E:/Vibe-Trading-main/Vibe-Trading-main" && awk '/^```text$/{c++; f=1; next} /^```$/{f=0} f&&c==2' docs/forensics/l0/tv-a5-intervals.md | wc -l`＝`40`，同一条管道把尾段换成 `grep -c 'row '`＝`39`；「40」是围栏自身的行数、按它计正好触 40 行上限，「39」是条目行数、按它计还有 1 行余量）；行内动作按钮（Add to favorites）与瞬时报价／时刻正文一律不转录。

```text
evidence_id: ev_b9a6851ee5882a8b46efe0a6b36bd92d9e9d6bf454c42b70d30baa7ee3ea36ca
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
        name: 1 day
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
  duration_ms: 4490
  steps[3]:
    - step_index: 0
      step_id: scenario_start
      action: goto_start
      elapsed_ms: 1660
...
      status: completed
      error: null
    - step_index: 1
      step_id: s1
      action: click
      elapsed_ms: 1247
...
      status: completed
      error: null
    - step_index: 2
      step_id: s2
      action: wait_for_timeout
      elapsed_ms: 1569
...
      artifacts:
        screenshot:
          state: not_requested
        dom:
          state: not_requested
        accessibility:
          state: captured
          value:
            sha256: c7146400f930ab92b80d6ced4810de39ef6d1969cc3e8d4b25f4a0498d86915d
            bytes: 9759
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

第二段：第 170 行 accessibility 串里与周期菜单有关的条目（点开后新增，treegrid 全结构）——

```text
- treegrid:
  - row "Add custom interval" [level=1]:
  - row "Ticks" [expanded] [level=1]:
  - row "1 tick" [level=2]:
  - row "10 ticks" [level=2]:
  - row "100 ticks" [level=2]:
  - row "1000 ticks" [level=2]:
  - row "Seconds" [expanded] [level=1]:
  - row "1 second" [level=2]:
  - row "5 seconds" [level=2]:
  - row "10 seconds" [level=2]:
  - row "15 seconds" [level=2]:
  - row "30 seconds" [level=2]:
  - row "45 seconds" [level=2]:
  - row "Minutes" [expanded] [level=1]:
  - row "1 minute" [level=2]:
  - row "2 minutes" [level=2]:
  - row "3 minutes" [level=2]:
  - row "5 minutes" [level=2]:
  - row "10 minutes" [level=2]:
  - row "15 minutes" [level=2]:
  - row "30 minutes" [level=2]:
  - row "45 minutes" [level=2]:
  - row "Hours" [expanded] [level=1]:
  - row "1 hour" [level=2]:
  - row "2 hours" [level=2]:
  - row "3 hours" [level=2]:
  - row "4 hours" [level=2]:
  - row "Days" [expanded] [level=1]:
  - row "1 day" [level=2] [selected]:
  - row "1 week" [level=2]:
  - row "1 month" [level=2]:
  - row "3 months" [level=2]:
  - row "6 months" [level=2]:
  - row "12 months" [level=2]:
  - row "Ranges" [expanded] [level=1]:
  - row "1 range" [level=2]:
  - row "10 ranges" [level=2]:
  - row "100 ranges" [level=2]:
  - row "1000 ranges" [level=2]:
```

提供方自陈（第 198 行 limitations[7] 中与本面判据相关的两条，逐字子串）：`Event sequence records provider receipt order; simultaneous browser causality is not inferred.` 与 `CDP attachment cannot recover pre-attach events or guarantee launch-time context options.`

## 读数含义

**留档行号（`grep -n` 可反查，文件＝`%TEMP%\rea-t10c\a5.txt`）**：`evidence_id` 第 1 行；parameters 回声 browser 11-14、start_url 15-17、environment 18-27、actions 28-39（locator 31-34，name 行 34）、capture 45-52（at_end 行 47）；normalized_result browser 56-61、scenario 62-69、duration_ms 行 70；steps[3] 表头行 71，scenario_start 步 72-107（elapsed 行 75，status／error 106-107），s1 步 108-143（elapsed 行 111＝1247，status／error 142-143），s2 步 144-188（elapsed 行 147，before_url 148-152、after_url 153-157，accessibility 工件 165-170（state 166、sha256 168、bytes 169＝9,759、树文本单行 170），url 工件 171-177，步骤级 completeness 182-186，status／error 187-188）；events 189-192；顶层 completeness 193-197；limitations[7] 行 198；environment 199-205；limitations[9] 行 206；locations／evidence_links 207-208。主键 `sed -n '1p' a5.txt` 当场取，与摘录首行同值同趟。定位名 `1 day` 逐字出自本机枚举趟 `discover.txt:124`（`grep -Fn '1 day' discover.txt` 命中第 124 行）。

**本面两个数的复算（只读，2026-10-14 在本机复跑；「四面最慢」那句话与「增行 182」都只由这两条命令支撑）**：

四面 `click` 步耗时——本面第 111 行是 1247，四面里最慢的是 A8 的 1377，本面不是最慢：

```bash
cd "$TEMP/rea-t10c" && for f in a3.txt a5.txt a7.txt a8.txt; do printf '%s ' $f; sed -n '111p' $f; done
```

原始读数逐字：`a3.txt       elapsed_ms: 144`／`a5.txt       elapsed_ms: 1247`／`a7.txt       elapsed_ms: 204`／`a8.txt       elapsed_ms: 1377`。

本趟第 170 行树相对 discover 基线树的多集合差增行——本面取 `a5.txt` 那一枚＝182：

```bash
cd "$TEMP/rea-t10c" && PYTHONIOENCODING=utf-8 python -X utf8 -c "
from collections import Counter
def T(fn,n): return open(fn,encoding='utf-8').read().split(chr(10))[n-1].split(chr(92)+'n')
b=Counter(T('discover.txt',124))
for f in ['a3.txt','a5.txt','a7.txt','a8.txt','a8-firsttrip-closed.txt']:
    print(f, sum((Counter(T(f,170))-b).values()))"
```

原始读数逐字：`a3.txt 136`／`a5.txt 182`／`a7.txt 30`／`a8.txt 16`／`a8-firsttrip-closed.txt 6`。口径：把留档里那一行转义树按字面 `\n` 切开成行集合，再算 `Counter(本趟) - Counter(基线)` 的多集合差（重复行按重数计，被基线吃掉的不计）；这个计数含侧栏残留行与瞬时 `text:` 行，只影响增行数，不改变任何转录名。

- **本面撑得住的结论（档位全集，可达文本级）**：周期切换按钮点开的是一个 treegrid 分辨率目录，**6 个分组共 32 个分辨率行**，另有首行 `Add custom interval`（level=1）：Ticks 4 行（1／10／100／1000 ticks）、Seconds 6 行（1／5／10／15／30／45 seconds）、Minutes 8 行（1／2／3／5／10／15／30／45 minutes）、Hours 4 行（1／2／3／4 hours）、Days 6 行（1 day／1 week／1 month／3 months／6 months／12 months）、Ranges 4 行（1／10／100／1000 ranges）。六个分组行都自陈 **[expanded]**，当前选中行是 `1 day`（`[selected]` 标记）——与主工具栏按钮名同名，即「按钮显示的就是选中档位」这一交互形状的可达文本证据。⇒ 对本仓 8 档周期的对账，L1 可以引用「对方档位目录的形状与命名到名字级」。
- **定位歧义的实测边界（strict mode 教训的复验）**：菜单展开后树里同时存在 `row "1 day"` 与 `button "1 day"`，但 click 发生在菜单打开**之前**——那一刻 `1 day` 只有工具栏一枚按钮，s1 completed、elapsed_ms 1247；本面只有耗时读数，**慢在哪一步没有键可读**（四面 `click` 步的 elapsed_ms 是 144／1247／204／1377，本面不是最慢，最慢是 A8 那趟的 1377；复算命令与原始读数逐字见「读数含义」的「本面两个数的复算」一段），无 strict mode violation。⇒ 「用档位名当定位名」在本页可命中，但它依赖「点击先于目录出现」这个顺序；L1 判据别把它写成「任何时候都单元素」。
- **本面撑不住的结论**：
  - 任何档位的**数值参数**（秒数映射、内部 interval id、是否支持 4 位自定义）——目录只给可达名，`dom` 未采集、`text:` 正文不入库。
  - `Add custom interval` 点开后的自定义对话框——那是第二个打开动作，本趟纪律不允许。
  - 「本仓的 8 档够不够」——那是 L2 差距矩阵的对账句，本面只提供对方档位清单。
  - 「默认展开组是页方的固定行为」——本趟只读到一个时点的展开态；分组 [expanded] 可能是会话持久状态（同一 profile 内多趟共享），limitations 首条的送达顺序口径同样适用于「谁先展开」。
- **现场污染披露**：同 A3——本趟第 170 行树里残留 widget-bar 面板的打开态项（`tab "Object tree"` 等），非本面点开所得，摘录已剔除；「那是先前 A8 的 count 趟点开的、它的态活到了本趟」是**推断，不是读数**（count 趟 stdout 未留档；**存续载体未读**——本记录 `命令：` 的 `storage` 段是 `"local_storage":[]`＝未请求任何 storage 读数，故不写「经 localStorage 持久化」），同一口径与排除链逐字见 `docs/forensics/l0/tv-a8-legend.md`「toggle 语义」条与 `docs/forensics/batch-A-playbook.md` §3③；本面增行的判据是与 discover 基线树做**多集合差**：**182 行＝本趟第 170 行树相对基线 `discover.txt:124` 树新增的行数**，按多集合差（`Counter(本趟) - Counter(基线)`）算。这个计数**含侧栏残留行与瞬时 `text:` 行**（报价／时刻那种），它们只影响计数、**不进摘录**；摘录另计「本面转录 40 行档位目录」。两个数的复算命令与原始读数逐字见下面「本面两个数的复算」。
- **动作纪律自证**：goto_start＋一枚打开类 click＋wait_for_timeout；未选档位（click 只落在**按钮本身**，菜单开着没点任何行）、未 fill／未提交／未登录；cookie 弹窗未点按。
- **体积闸门形状**：count 读数 6,166 是下界，正式趟 100,000 闸门下 208 行收全、无 truncated 标记；第 170 行单行实测 10,596 字节，从不整行进终端。
