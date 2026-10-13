# L0：TV 图表页画线工具目录的展开态（面 A3）

- 命令：npx -y rea-agents@latest capture-browser-scenario '{"browser":{"mode":"connect","cdp_endpoint":"http://127.0.0.1:9222","target_id":"AC6AD9CF5DC2168A150D7D28FA487F1B"},"start_url":{"url":"https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL"},"actions":[{"step_id":"s1","action":"click","locator":{"kind":"role","role":"button","name":"Trend tools"}},{"step_id":"s2","action":"wait_for_timeout","duration_ms":1500}],"storage":{"cookies":[],"local_storage":[],"session_storage":[]},"secrets":[],"capture":{"after_each_step":[],"at_end":["url","accessibility"],"events":[],"network":{"request_body":false,"response_body":false,"header_values":false}}}' --token-limit 100000
- evidence_id：ev_8fa76e4388ea8d83ef71d2d45f3374b431bf861c48e7e3ef849adf1d9ed59a70
- 浏览器：Chromium 155.0.4283.45（本趟 stdout 第 56-61 行 browser 块自带这形读数：mode connect／process_ownership external／cleanup disconnected-external／product Chromium／version 155.0.4283.45；第 201-205 行 environment 的 id 为 Chromium@155.0.4283.45、platform 与 architecture 是 unknown。本面 stdout 不带 Edg 形产品串——Edg/155.0.4283.45、protocol_version "1.3"、js_version 15.5.9.4 是同一现场挂载趟 `targets-1.txt:25-29` 的读数，两趟现场同一个我方 PID 30280，出处在此写明而非默默借用）
- 目标 URL：https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL（parameters.start_url 回声第 15-17 行；at_end 的 url 工件第 171-177 行同值；s2 的 before_url 148-152 与 after_url 153-157 逐字段相同 ⇒ 点完没换页、没换路由）
- 留档（仓外临时件，会随清理消失）：C:\Users\fire\AppData\Local\Temp\rea-t10c\a3.txt（正式趟整份 stdout，208 行／16,390 字节；第 170 行是 at_end accessibility 的单行文本串）；同目录 a3.cmd（本记录 命令： 的逐字命令行，正式趟执行前先 tee 落档）、a3-count.txt（--token-count 读数＝5,707）、discover.cmd／discover.txt（枚举趟 162 行／15,033 字节，主键 ev_ba280ca2dc3ab88359551bcc1868687099a6731826804f5002eb4c98cab748d2——它只是取定位名的工作辅助，不落成 L0 记录、其键不是本面证据）、targets-1.txt（挂载趟，PID 与 target_id 读数）、precheck.txt 与 precheck-reg-internet-settings.txt（预检两腿与注册表现读）
- 观察条件：Edge --headless=new（我方 PID 30280，netstat 现读）＋ --remote-debugging-port=9222 ＋ 专属新建 profile 目录 rea-cdp-profile-t10c ＋ --proxy-server=http://127.0.0.1:7897（当次 reg query 现读 ProxyEnable=0x1／ProxyServer=127.0.0.1:7897；同场预检裸连腿 http_code=000 且 curl 退出码 28，代理腿＝200）；URL 走 Edge 命令行参数；一趟一个打开动作：仅 click 一枚 role:button／name:"Trend tools"（定位名逐字取自本机枚举趟 discover.txt:124 的可达文本读数，不是上一批的起点名），随后 wait_for_timeout 1500ms；未 fill、未提交、未登录、未保存、未交易、未派发 Escape（flyout 由下一趟的 goto_start 重载自然关闭）；未改 UA、未禁用优化；视口 1280×720（第 19-22 行 environment 回声，是我方窗口几何，不是对方布局声明）；一次一面——本条只有 A3；正式趟闸门 --token-limit 100000 按 count 读数 5,707 作下界大幅放宽，全文 truncated 标记计数 0
- 完整性：顶层 completeness.status=incomplete（第 194 行）；equality_eligible: false（195）；missing_sections[1]: events（196）——按批次清单 §4 的解释：这一项是**本趟没开事件记录**（capture.events: []，第 48 行），不是页面上没有事件；truncated_sections: []（197）。步骤级（s2 工件的 completeness，第 182-186 行）是另一层：status: complete、equality_eligible: true、missing_sections: []。本记录 完整性： 抄顶层那一层，两层形状都在此写明。第 163-164 行 dom 工件 state: not_requested ⇒ 本面根本没采 dom；第 198 行 provider 自陈 limitations[7]、第 206 行顶层 limitations[9]
- 用途：基线
- 取证时间：2026-10-13T23:07:07+08:00（留档 a3.txt 落盘 mtime；场景趟 stdout 不含绝对时间戳键，只有 duration_ms 4041（第 70 行）与逐步 elapsed_ms）

## 摘录（逐字，未改写）

第一段是当趟 stdout 的骨架切片（行号见「读数含义」），格式是 REA 默认的 toon 缩进文本，不是 JSON，围栏标 text。第二段是 at_end accessibility 读数里**与 A3 这一面有关的条目**：留档里整棵可达文本树是第 170 行的**单行**转义串（项间为字面 `\n`、引号为字面 `\"`），下面按可读形转录（名字本体逐字未改；用 `grep -F 名字本体 a3.txt` 命中第 170 行）。转录只落 role＋name 与步骤状态；树里的报价／时刻等 `text:` 正文与快捷键提示文字一律不入库，`dom` 正文本面未采集。

```text
evidence_id: ev_8fa76e4388ea8d83ef71d2d45f3374b431bf861c48e7e3ef849adf1d9ed59a70
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
        name: Trend tools
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
  duration_ms: 4041
  steps[3]:
    - step_index: 0
      step_id: scenario_start
      action: goto_start
      elapsed_ms: 2318
...
      status: completed
      error: null
    - step_index: 1
      step_id: s1
      action: click
      elapsed_ms: 144
...
      status: completed
      error: null
    - step_index: 2
      step_id: s2
      action: wait_for_timeout
      elapsed_ms: 1563
...
      artifacts:
        screenshot:
          state: not_requested
        dom:
          state: not_requested
        accessibility:
          state: captured
          value:
            sha256: c0f2d5a7bd71437c981e79b272f187ff9eb243a1843537622f5868a5c219ea90
            bytes: 8599
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

第二段：第 170 行 accessibility 串里与画线目录有关的条目（点开后新增；**这块围栏实测 24 行＝容器行 `- treegrid:` 1 行＋条目行 23 行**——「23」是不含容器行的条目行数，「24」是围栏自身的行数，两个数指的是同一块围栏，复算命令见「读数含义」的「本面行数与增行数的复算」；按 24 行计也仍在 40 行上限之内）——

```text
- treegrid:
  - row "Lines":
    - gridcell "Lines"
  - row "Trendline":
  - row "Ray":
  - row "Info line":
  - row "Extended line":
  - row "Trend angle":
  - row "Horizontal line":
  - row "Horizontal ray":
  - row "Vertical line":
  - row "Crossline":
  - row "Channels":
    - gridcell "Channels"
  - row "Parallel channel":
  - row "Regression trend":
  - row "Flat top/bottom":
  - row "Disjoint channel":
  - row "Pitchforks":
    - gridcell "Pitchforks"
  - row "Pitchfork":
  - row "Schiff pitchfork":
  - row "Modified Schiff pitchfork":
  - row "Inside pitchfork":
```

提供方自陈（第 198 行 limitations[7] 中与本面判据相关的两条，逐字子串）：`Event sequence records provider receipt order; simultaneous browser causality is not inferred.` 与 `CDP attachment cannot recover pre-attach events or guarantee launch-time context options.`

## 读数含义

**留档行号（`grep -n` 可反查，文件＝`%TEMP%\rea-t10c\a3.txt`）**：`evidence_id` 第 1 行；parameters 回声的 browser 块 11-14、start_url 15-17、environment 18-27、actions 28-39（locator 31-34，name 行 34）、storage 40-43、secrets 44、capture 45-52（at_end 行 47、events 行 48、三个 network 旗标 49-52）、scenario_sha256 行 53；normalized_result 的 browser 块 56-61、scenario 62-69（action_count 行 64）、duration_ms 行 70；steps[3] 表头行 71，scenario_start 步 72-107（status／error 在 106-107），s1 步 108-143（elapsed_ms 行 111，before_url 112-116、after_url 117-121，status／error 142-143），s2 步 144-188（elapsed_ms 行 147，before_url 148-152、after_url 153-157，accessibility 工件 165-170（state 行 166、sha256 行 168、bytes 行 169、文本单行 170），url 工件 171-177，步骤级 completeness 182-186，status／error 187-188）；events 189-192；顶层 completeness 193-197；limitations[7] 行 198；confidence／authority／environment 199-205；limitations[9] 行 206；locations／evidence_links 207-208。主键 `sed -n '1p' a3.txt` 当场取，与摘录首行同值同趟。定位名 `"Trend tools"` 逐字出自本机枚举趟 `discover.txt:124`（该整棵树也是单行；`grep -Fn 'Trend tools' discover.txt` 命中第 124 行）。

**本面行数与增行数的复算（只读，2026-10-14 在本机复跑；「136 行增行」与「围栏 24 行／条目行 23 行」这四个数只由下面两条命令支撑）**：

增行＝本趟第 170 行树相对基线 `discover.txt:124` 树的多集合差（`Counter(本趟) - Counter(基线)`），本面取 `a3.txt` 那一枚＝136：

```bash
cd "$TEMP/rea-t10c" && PYTHONIOENCODING=utf-8 python -X utf8 -c "
from collections import Counter
def T(fn,n): return open(fn,encoding='utf-8').read().split(chr(10))[n-1].split(chr(92)+'n')
b=Counter(T('discover.txt',124))
for f in ['a3.txt','a5.txt','a7.txt','a8.txt','a8-firsttrip-closed.txt']:
    print(f, sum((Counter(T(f,170))-b).values()))"
```

原始读数逐字：`a3.txt 136`／`a5.txt 182`／`a7.txt 30`／`a8.txt 16`／`a8-firsttrip-closed.txt 6`。口径两条：把留档里那一行转义树按字面 `\n` 切开成行集合后再算多集合差（重复行按重数计，被基线吃掉的重数不计）；这个计数**含侧栏残留行与瞬时 `text:` 行**（报价／时刻那种），它们只影响这个增行数，一律不进摘录。

转录条目的两个行数——第二段围栏（文件里第 2 个 `text` 围栏）本身 24 行、其中容器行 1 行：

```bash
cd "E:/Vibe-Trading-main/Vibe-Trading-main" && awk '/^```text$/{c++; f=1; next} /^```$/{f=0} f&&c==2' docs/forensics/l0/tv-a3-draw-menu.md | wc -l
cd "E:/Vibe-Trading-main/Vibe-Trading-main" && awk '/^```text$/{c++; f=1; next} /^```$/{f=0} f&&c==2' docs/forensics/l0/tv-a3-draw-menu.md | grep -c 'treegrid'
```

原始读数逐字：第一条＝`24`，第二条＝`1` ⇒ 围栏 24 行＝容器行 `- treegrid:` 1 行＋条目行 23 行，摘录转录的是那 23 行条目行（3 个分组行＋17 个工具行＋3 行 `gridcell`）。

- **本面撑得住的结论（名字与结构级）**：`Trend tools` 这枚按钮点开的是一个 **treegrid 形态的目录**，自陈 **3 个分组行（Lines／Channels／Pitchforks）与 17 个工具行**——Lines 组 9 项（Trendline／Ray／Info line／Extended line／Trend angle／Horizontal line／Horizontal ray／Vertical line／Crossline）、Channels 组 4 项（Parallel channel／Regression trend／Flat top/bottom／Disjoint channel）、Pitchforks 组 4 项（Pitchfork／Schiff pitchfork／Modified Schiff pitchfork／Inside pitchfork）。每个工具行带一枚 `Add to favorites` 按钮，条目行名里带 `Click here to learn more` 的学习入口按钮——这两类是**行内动作**，本面只指认其存在，未点按。定位单元素命中（s1 completed、elapsed_ms 144、无 strict mode violation）。⇒ 对账本仓画线件数／类别的判据，L1 可引用「它有这个类别形状」这一级。
- **本面撑不住的结论**：
  - 「画线工具**总共**就这 17 件」——不成立。枚举趟基线树里主工具栏另有 `Fib retracement`、`Gann and Fibonacci tools`、`XABCD pattern`、`Patterns`、`Brush`、`Geometric shapes`、`Text`、`Annotation tools`、`Icon` 等**独立分组按钮**（discover.txt:124 可读），本面只点了 Trend tools 这一个目录，其它目录各自的展开态没有本面证据。
  - 任何图标形状、配色、CSS 类名、快捷键文字的值——红线：`dom` 未采集（state: not_requested），树里 `text:` 项的成段正文不入库；本面给的是 role＋name 级。
  - 「flyout 会不会遮挡／怎么关闭」——本趟没派发 Escape，也没观察关闭过程；只证明了 1500ms 时点开态稳定可读。
- **现场污染披露（重要，报告里同文写了一份）**：本趟是同一浏览器现场的第 6 次场景动作；先前 A8 的 count 趟点开的 widget-bar 侧栏面板经 localStorage 持久化，**残留在本趟第 170 行的树里**（`tab "Object tree"` 等几项）。那些项**不是** A3 点开的新增，上面第二段摘录已把它们剔除；A3 的增行判据是与本机枚举趟的基线树做**多集合差**：**136 行＝本趟第 170 行树相对基线 `discover.txt:124` 树新增的行数**，按多集合差（`Counter(本趟) - Counter(基线)`）算。这个计数**含侧栏残留行与瞬时 `text:` 行**（报价／时刻那种），它们只影响计数、**不进摘录**；摘录另计「本面转录条目行 23 行」（同一块围栏 24 行，含容器行 `- treegrid:` 1 行）。两个口径的复算命令与原始读数逐字见下面「本面行数与增行数的复算」。
- **动作纪律自证**：本趟只有 `goto_start`＋一枚「打开」click＋一次 wait_for_timeout；`fill`／`select_option`／`check`／`uncheck` 未使用；没有第二次 click；cookie 弹窗的按钮未点按（它全程都在树里，属对方合规控件，与打开类动作纪律无涉）。
- **体积闸门形状（与批次清单 §7 同形）**：count 趟读数 5,707 是**下界**，正式趟放到 100,000 后整份 208 行落到第 208 行 `evidence_links: []` 结束、`grep -c '[truncated'`＝0。摘录按行号切片，第 170 行单行实测 9,270 字节，从不整行打进终端。
