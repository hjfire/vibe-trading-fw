# L0：自家页「画布上已有一条图元」渲染态的像素等值（TV-DW-07 的执行半）

- 命令：npx -y rea-agents@latest capture-web-screenshot http://127.0.0.1:9222 24A40B21CF0B1F687F8501A7033793E9 --allowed-origins http://localhost:5899 --filter-output evidence_id,normalized_result --token-limit 150000
- evidence_id：ev_3ad78f0ba6766c1d1e0135444e4fbeb71f4c0fd887f65a02e0fd93861cb6d28d
- 浏览器：Edg/155.0.4283.45（当趟 stdout 第 3-8 行 browser 块逐字：product Edg/155.0.4283.45／protocol_version "1.3"／revision 537.36 (@50f24ef2aa5369a074b8888b7db82d9c0652d642)／js_version 15.5.9.4／user_agent 串里同时含 HeadlessChrome/155.0.0.0 与 Edg/155.0.0.0）；宿主＝本机 Edge，绝对路径 `C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`（`msedge.exe` 不在本机 PATH 上，裸名起不来），旗标 `--headless=new --no-proxy-server --remote-debugging-port=9222 --window-size=1100,800` ＋ 仓外专属 profile 目录；CDP 监听 PID 由 netstat 现读＝39724
- 目标 URL：http://localhost:5899/pro-chart（**自家 dev server，不是 tradingview.com**；当趟 stdout 第 9-12 行 target 块回声同一 url 与 origin http://localhost:5899）
- 观察条件：本记录 vouches 的第一趟＝run1（stdout 第 13 行 `captured_at: "2026-10-13T20:49:30.280Z"`），对端趟＝run2（第 13 行 `captured_at: "2026-10-13T20:49:43.213Z"`，相隔 12.933 秒），两趟命令行**逐字相同**（复算 `diff dw07-run1.cmd dw07-run2.cmd`＝rc 0）、同一 target、同一浏览器现场、未重启、未 reload；视口两趟逐字相同 width 1066／height 703（第 14-16 行，比 `--window-size` 小的那圈是 Edge 自己的边框账）；画布上那一条图元由**本仓第一方的 `?d=` 画线分享链接导入**（一条 `水平线`，paneId `candle_pane`，落点给在未来区由 `clampDrawingsToLastBar` 吸回最新一根），导入趟 `ev_7ad6adae1f0642139e57d67bbaca740c3fba52b37c9af911a03f4930cf6793a2` 同趟读到 `button \"画线清单\": 清单 · 1`（计数从 `· 0` 变 `· 1`）且工具条 `[disabled]` 出现次数由 8 降到 3（复算 `grep -o '\[disabled\]' setup-probe.out | wc -l`＝8 与 `… setup-draw.out | wc -l`＝3）；数据面除了 vite 还起了本仓自己的 API（`frontend/vite.config.ts:26` 的 `apiTarget`，本机 127.0.0.1:8000），因为只起 vite 时同一页面的可达树逐字是「无法加载会话。」「无法连接 API 服务。请检查后端是否已启动，以及网络连接是否正常。」（探趟 `ev_17e40f236aee11371e6955d841a10f81eeb99ed5525cc3eeb26367ef68627056`）——没有 K 线就没有「已有一条图元」这个渲染态；未点按任何按钮、未 fill、未滚动（`limitations[2]` 第 39 行自陈 REA 不滚动、不执行 JS）、未登录、未保存、未交易
- 完整性：completeness.status=complete_within_window（第 22-38 行那一块）；conditions[1] 同值；policy_filtered_sections／attach_limited_sections／truncated_sections／unavailable_sections／excluded 五把都是空列表；dropped_events 七个分项加 total 八个计数器全为 0 ⇒ 150000 的体积闸门没有截掉 `artifact` 块（本记录 完整性： 抄的就是这一趟这一块，run2 同一块逐字相同）
- 用途：规格
- 取证时间：run1 于 2026-10-14 04:49:30＋0800、run2 于 04:49:43＋0800（两趟 stdout 第 13 行的 `captured_at` 是 UTC 形 20:49:30.280Z／20:49:43.213Z；留档落盘 mtime 复算 `stat -c %y dw07-run1.out`＝`2026-10-14 04:49:30.314542300 +0800`、`… dw07-run2.out`＝`2026-10-14 04:49:43.244909200 +0800`，与 `captured_at` 同秒 ⇒ 这一面的文件时刻与执行时刻只差写入延迟，不像 `tv-a8-legend.md` 那面只能拿到「另存时刻」）
- 留档（仓外临时件，会随系统清理消失）：`C:/Users/fire/AppData/Local/Temp/rea-t11b/` 下 `dw07-run1.cmd`／`dw07-run1.out`（215,954 字节）、`dw07-run2.cmd`／`dw07-run2.out`（215,954 字节）、前置导入趟 `setup-draw.cmd`／`setup-draw.out`、零画线对照趟 `setup-probe.cmd`／`setup-probe.out`、词表复探 `vocab-probe.txt`；dev server 与浏览器的现场日志同侧 `/tmp/rea-t11b-vite.log`／`rea-t11b-edge.log`／`rea-t11b-backend.log`；可达树基线 `/tmp/rea-t11b-a11y.txt`（249,612 字节，`--include-accessibility-text`）

## 摘录（逐字，未改写）

两段都来自各自趟的 stdout。第 21 行那个 `data_base64:` 载荷（整份 215,954 字节的绝大部分）按像素红线**不转录、不入库**，本记录只落 `state`／`sha256`／`bytes`／`media_type`。

第一段＝run1 的第 1、9-20 行：

```text
evidence_id: ev_3ad78f0ba6766c1d1e0135444e4fbeb71f4c0fd887f65a02e0fd93861cb6d28d
...
  target:
    target_id: 24A40B21CF0B1F687F8501A7033793E9
    url: "http://localhost:5899/pro-chart"
    origin: "http://localhost:5899"
  captured_at: "2026-10-13T20:49:30.280Z"
  viewport:
    width: 1066
    height: 703
  artifact:
    sha256: 83a9738b1bbc158f929e4e1695780adfebb0386e3fb333d95bd21589f59c7ba0
    bytes: 160914
    media_type: image/png
```

第二段＝run2 的同一批行号：

```text
evidence_id: ev_f42ce52fcdb64b3ac65be85803a51abed29ff26bfd0813ae6dbc9913f4ca8f17
...
  target:
    target_id: 24A40B21CF0B1F687F8501A7033793E9
    url: "http://localhost:5899/pro-chart"
    origin: "http://localhost:5899"
  captured_at: "2026-10-13T20:49:43.213Z"
  viewport:
    width: 1066
    height: 703
  artifact:
    sha256: 83a9738b1bbc158f929e4e1695780adfebb0386e3fb333d95bd21589f59c7ba0
    bytes: 160914
    media_type: image/png
```

run1 的 completeness 块（第 22-38 行，run2 同块逐字相同）：

```text
  completeness:
    status: complete_within_window
    conditions[1]: complete_within_window
    policy_filtered_sections: []
    attach_limited_sections: []
    truncated_sections: []
    unavailable_sections: []
    excluded: []
    dropped_events:
      scripts: 0
      network_requests: 0
      console_events: 0
      websocket_connections: 0
      websocket_frames: 0
      webmcp_tools: 0
      timeline_events: 0
      total: 0
```

## 判据与复算

这条记录支持的判据是**两趟之间的关系**，不是任何常量：同一 target、同一视口、同一条 `capture-web-screenshot`，`normalized_result.artifact` 的 `sha256` 与 `bytes` 逐项相等。留档在仓外 `C:/Users/fire/AppData/Local/Temp/rea-t11b/`，可复跑（留档随系统清理消失，消失后本节的读数只能由重跑复现）：

```bash
cd "C:/Users/fire/AppData/Local/Temp/rea-t11b"
diff dw07-run1.cmd dw07-run2.cmd                       # rc=0 ⇒ 两趟命令逐字相同
diff <(sed -n '17,20p' dw07-run1.out) <(sed -n '17,20p' dw07-run2.out)   # rc=0 ⇒ artifact 四行等值
grep -c '^    sha256: 83a9738b1bbc158f929e4e1695780adfebb0386e3fb333d95bd21589f59c7ba0$' dw07-run1.out   # 1
grep -c '^    sha256: 83a9738b1bbc158f929e4e1695780adfebb0386e3fb333d95bd21589f59c7ba0$' dw07-run2.out   # 1
grep -c '^    bytes: 160914$' dw07-run1.out            # 1
grep -c '^    bytes: 160914$' dw07-run2.out            # 1
diff dw07-run1.out dw07-run2.out | grep -c '^[<>]'     # 4 ⇒ 整份 stdout 只差两对行
```

2026-10-14 现读：五条 grep 计数都是 1，两个 `diff` 都 rc=0，整份 stdout 的差异只有 4 行，逐字就是 `evidence_id:` 与 `captured_at:` 各一对 ⇒ **等值判据在自家页成立**，判据没有放宽成「像素差 x%」，也没写成期望常量。

## 限制（不写清就会被读成别的东西）

- 「截图时面板是关着的、页面上没有报价在飞」这一句是**由执行顺序推断**的，不是截图趟自己的读数：`capture-web-screenshot` 的 stdout 里没有可达树（复算 `grep -c 'text:' dw07-run1.out`＝0），两趟截图都跑在同一场 CI-07 趟之前。能证的只有相邻趟：`setup-draw.out` 的 at_end 树里那枚按钮不带 `[pressed]`，`setup-draw.out`／`ci07-run1.out`／`ci07-run2.out` 三份树里都逐字带 `\"刷新报价\" [disabled]`。
- 等值是在**静止现场**拿到的：日线、收盘时段、无实时通道写入。「任何时候都等值」本记录不支持；对方那侧同一形状的两趟本来就不等值（`tv-a9-axis-scale.md` 与 `tv-a15-pixel-baseline.md` 的 `bytes` 差 6404），这正是判据要求「同 target、同视口、同一条命令、连跑两趟」而不是「与某个存档比」的原因。
- 导入趟那一条图元的 id 后缀（`overlay_<毫秒>_1`）在 CI-07 两趟之间是不同的（`overlay_1791924672349_1` 对 `overlay_1791924689803_1`，恢复时重新生成），本记录不指认画线靠什么活到下一趟——场景 JSON 的 `storage` 三段逐字是 `"cookies":[],"local_storage":[],"session_storage":[]`，即未请求任何 storage 读数。
- 页内**鼠标落点**在本机不可表达，所以图元是导入进来的：场景动作的 locator 只有 `kind: test_id,role,css` 三种，`kind:"role"` 的 `role` 取值表 14 项（`button,checkbox,combobox,dialog,link,listbox,menuitem,option,radio,slider,spinbutton,switch,tab,textbox`）**不含 canvas**，而自家页可达树里 14 枚 `role: Canvas` 的 `name` 逐字全是空串；`click` 也没有坐标偏移参数（带 `offset_x`／`offset_y`／`x`／`y`／`position` 的探针趟一口气报 5 条 `reason: unknown_argument`）。剩下唯一能指认 canvas 的通道是 CSS 选择器，而批次 A 的口径禁止拿它指认元素 ⇒ 本记录没有「点出来的画线」。
  这三条词表读数由控制席 2026-10-14 复跑过（留档 `vocab-probe.txt`，逐字 `expected[3]: test_id,role,css`、
  `expected[14]: button,checkbox,combobox,dialog,link,listbox,menuitem,option,radio,slider,spinbutton,switch,tab,textbox`、
  以及 `x`／`y`／`offset_x`／`offset_y`／`position` 五个 `reason: unknown_argument`）；探针不用起现场——非法入参的
  schema 校验跑在连浏览器之前，`cdp_endpoint` 指向死端口 127.0.0.1:9 也秒回这三条。
