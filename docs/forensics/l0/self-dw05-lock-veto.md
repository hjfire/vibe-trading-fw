# L0：自家页——锁定的画线在右键这一路能否被 `preventDefault()` 拦下

- 命令：npx -y rea-agents@latest capture-browser-scenario '{"browser":{"mode":"connect","cdp_endpoint":"http://127.0.0.1:9222","target_id":"A1D199BBF29B8DF551A28D35970491F6"},"start_url":{"url":"http://localhost:8000/pro-chart?d=jeyJ2IjoyLCJkIjpbeyJuYW1lIjoiaG9yaXpvbnRhbFN0cmFpZ2h0TGluZSIsInBhbmVJZCI6ImNhbmRsZV9wYW5lIiwicG9pbnRzIjpbeyJ0aW1lc3RhbXAiOjQxMDI0NDQ4MDAwMDAsInZhbHVlIjoxNzAwfV0sImxvY2siOnRydWV9XX0"},"actions":[{"step_id":"s1","action":"wait_for_timeout","duration_ms":9000}],"storage":{"cookies":[],"local_storage":[],"session_storage":[]},"secrets":[],"capture":{"after_each_step":[],"at_end":["url","accessibility"],"events":[],"network":{"request_body":false,"response_body":false,"header_values":false}}}' --filter-output evidence_id,normalized_result --token-limit 150000
- evidence_id：ev_42e006f9ee93fcd6a2fef26a0ff038673a1696fe88f8d53012bf999bd417f227
- 浏览器：Chromium 155.0.4283.45（主键趟 stdout 第 4-8 行 browser 块逐字：`mode: connect`／`process_ownership: external`／`cleanup: disconnected-external`／`product: Chromium`／`version: 155.0.4283.45`）；宿主与现场＝本机 Edge `--headless=new`（`C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`，`--no-proxy-server`，`--remote-debugging-port=9222`，`--user-data-dir` 在 `C:/Users/fire/AppData/Local/Temp/rea-l3t1/edge-profile-1d`，`--window-size=1100,800`，起始 URL `http://localhost:8000/pro-chart`）。`netstat -ano | grep ":9222" | grep LISTENING` 现读 `TCP 127.0.0.1:9222 0.0.0.0:0 LISTENING 19020`，`tasklist //FI "PID eq 19020" //FO CSV //NH` 逐字 `"msedge.exe","19020","Console","4","186,988 K"`。同一端点 `curl -s http://127.0.0.1:9222/json/version` 回声 `   "Browser": "Edg/155.0.4283.45"` ⇒ 场景命令的 `product: Chromium` ＋ 独立 `version` 与 CDP 直读的 `Edg/155.0.4283.45` 同属一枚浏览器（Edge 155.0.4283.45），不是两枚。`target_id` 本席现读 `A1D199BBF29B8DF551A28D35970491F6`（`normalized_result.targets[1]` 只有这一枚 page，url＝`http://localhost:8000/pro-chart`，origin＝`http://localhost:8000`；`excluded: disallowed_origin: 0 / unsupported_url: 1 / non_page: 1`）——本趟新起的浏览器进程，不沿用任何旧记录里那枚号。工具版本 `rea-agents@latest --version` 现读 **6.5.0**；`list-browser-targets` 在 6.5.0 下只收**位置参数** endpoint，简报 Step 3 那条 JSON 形状 `{"browser":{...,"cdp_endpoint":...}}` 本席逐字跑过一次，rc=1，回执 `path[1]: cdp_endpoint / reason: invalid_value / message: Invalid CDP endpoint URL`（留档 `C:/Users/fire/AppData/Local/Temp/rea-l3t1/targets-1d.txt` 的第一版），改成位置参数 `list-browser-targets "http://127.0.0.1:9222"` 后 rc=0 并读到上面那枚 target_id——那是旗标形状漂移，不是 CDP 没通（同端点 `/json/version` 直读 200）。与第①片记录里那句同种漂移的读数是同一族，本席没有复算旧记录那枚号。
- 目标 URL：http://localhost:8000/pro-chart ——**自家后端服务的生产构建（`frontend/dist` 由 `agent/api_server.py` 挂载），不是 tradingview.com**；主键趟 stdout 第 10 行 `start_origin: "http://localhost:8000"` 回声同一枚 origin，第 25 行 step 0 的 before_url＝`http://localhost:8000/pro-chart`、第 29-30 行 after_url 多带 `?d=` 与上面「现场与归属」那节逐字记下的那枚 `LOCKED` 串（`query_parameter_names` 在 stdout 里 5 次命中、那枚 `d` 由页面自己的解码器消费），第 66 行 `s1` 收尾的 after_url 回到不带码的同一串＝导入把码吃掉了、没有换路由。活体现场不是 vite dev：本席全程**没起** dev server，`netstat -ano | grep ":5899" | grep -c LISTENING` 起现场时与收现场时都读 **0**。
- 观察条件：主键趟只有 `goto_start` 一次导航＋一步 `wait_for_timeout`（9000ms），**一次 click 都没有、一次 fill 都没有**；第二通道只派发脚本自己的 `Input.dispatchMouseEvent` 三连（`mouseMoved` → `mousePressed{button:"right",clickCount:1}` → `mouseReleased`）与 `Runtime.evaluate`／`Page.navigate`，同样未点按任何 DOM 元素、未登录、未保存、未下单、未交易、未切 tab；只访问 `localhost`／`127.0.0.1`（页面 origin `http://localhost:8000`，CDP 端点 `http://127.0.0.1:9222`）；`--user-data-dir` 是 `C:/Users/fire/AppData/Local/Temp/rea-l3t1/edge-profile-1d`＝本趟一次性 profile，不碰任何真实浏览器数据，脚本 `boot()` 里那句 `localStorage.removeItem("pro-chart.drawings.v1")` 清的是这枚一次性 profile 自己的画线桶；主键趟场景 JSON 的 `storage` 三段逐字 `"cookies":[],"local_storage":[],"session_storage":[]`＝**未请求任何 storage 读数**（stdout 第 38／40／42／44／46／48／74／76／91／93 行都写 `state: not_requested`，只有第 78 行 accessibility 与第 84 行 url 两件是 `state: captured`）；除本记录署名的两条通道外没有任何其它驱动，**没有改任何仓内代码**（守卫尚未写＝读的是改动前的页面）。
- 完整性：两层且不同值，本键抄顶层并解释缺席面——顶层（stdout 第 106-109 行）`status: incomplete`／`equality_eligible: false`／`missing_sections[1]: events`／`truncated_sections: []`，而 `events` 缺席是这条场景命令自己把 `capture.events` 声明成空数组的结果，**不是页面没事件**（第 101-104 行 `events: retained: 0 / dropped: 0 / items: []`，第 17 行 `event_families: []`）；步骤级两趟都在（第 50-53 行与第 95-98 行各一份 `status: complete`／`equality_eligible: true`／`missing_sections: []`／`truncated_sections: []`）；全文 `grep -c 'parse_failures'`＝**0**，故无需解释该键；accessibility 工件第 78-81 行 `state: captured`／`sha256: 656d40e7dd6150d61e0183a2476ca4e9c5fbe3907d3745a05360aa58241c4581`／`bytes: 5523`；`--filter-output evidence_id,normalized_result` ＋ `--token-limit 150000` 之下那棵可达树整行随 stdout 落盘（第 82 行，单行转义串），stdout 9,949 字节、stderr 0 字节、rc=0。
- 状态：活体否决成立——A（未挂回调）删得动、B（挂而不拦）删得动且 hits==1、C（挂且 `preventDefault()`）删不动且 hits==1；三腿齐、两枚 hits 都对得上 ⇒ 本趟有判决力。

## 现场与归属（本记录所有读数的边界）

活体现场＝**后端服务的生产构建**（2026-10-17 执行席追加更正，落在 `docs/superpowers/plans/2026-10-17-l3-slice2-locked-delete.md:29-39`），三条准备动作的读数逐字如下：

1. **先 `npm run build`**：`frontend/` 下 `npm run build` ⇒ `✓ built in 3.19s`，产物 `frontend/dist/index.html` mtime 现读 `2026-10-17 15:31:48.739334600 +0800`（当场新）；构建输出里那枚同名 chunk 逐字 `dist/assets/index-DCC1ULv_.js 265.14 kB │ gzip:  86.68 kB`。
2. **认 `[prod]` 那行**：起法 `cd E:/Vibe-Trading-main/Vibe-Trading-main/agent && python api_server.py --host 127.0.0.1 --port 8000`（日志 `C:/Users/fire/AppData/Local/Temp/rea-l3t1/backend-1d.txt`）。该文件第 4 行逐字 `[prod] Frontend served from E:\Vibe-Trading-main\Vibe-Trading-main\frontend\dist`，第 1 行 `INFO:     Started server process [29168]`。探活 `curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8000/health`＝**200**、`http://localhost:8000/pro-chart`＝**200**；`netstat -ano | grep ":8000" | grep LISTENING`＝`TCP 127.0.0.1:8000 0.0.0.0:0 LISTENING 29168`（＝日志里那枚号）。端口是当场开出来的，不是抄简报数字：`frontend/vite.config.ts:26` 现读 `const apiTarget = env.VITE_API_URL || "http://127.0.0.1:8000";`、`:43` 现读 `port: 5899,`（那枚 5899 是 dev 端口，本席未起）。
3. **asset 指纹对账**（防「SPA 兜底把任何路径都答成 200＋HTML」）：`curl -s http://127.0.0.1:8000/pro-chart | grep -o 'assets/index-[^"]*\.js'`＝**`assets/index-DCC1ULv_.js`**，`grep -o 'assets/index-[^"]*\.js' frontend/dist/index.html`＝**`assets/index-DCC1ULv_.js`**——两串**逐字相同** ⇒ 服务里的 index 与本席刚构建的那棵是同一份，不是在探旧进程或历史缓存。

**读数归属的树**（本席自己复验过，不抄控制席的数）：分支 `feat/l3-slice2-locked-delete`，动笔前 `git rev-parse --short HEAD`＝`40d0876c`，`git status --porcelain` 逐字只有 `?? .superpowers/`（本技能自己的 git-ignored scratch）⇒ 工作树除被忽略件外干净。`git diff --stat 8346c4ce HEAD -- frontend/src` **无输出**（＝0 个文件），`git rev-parse 8346c4ce:frontend/src/lib/chartDrawings.ts` 与 `git rev-parse HEAD:frontend/src/lib/chartDrawings.ts` 都＝`0cc2d19be38102412e7399c748ed8e91d6e049de`（同一枚 blob＝逐字节相同）。所以：**被测的 `frontend/src/**` 与当前 HEAD 同一棵树**，且本席 `npm run build` 与两次读数都在这棵树上、期间没有任何仓内改动；守卫代码尚未写＝读的是**改动前**的页面。

**锁定分享码（现场生成、现场回读，逐字自证）**：`node` 现算现解，留档 `C:/Users/fire/AppData/Local/Temp/rea-l3t1/code-1d.txt`：

```text
LOCKED jeyJ2IjoyLCJkIjpbeyJuYW1lIjoiaG9yaXpvbnRhbFN0cmFpZ2h0TGluZSIsInBhbmVJZCI6ImNhbmRsZV9wYW5lIiwicG9pbnRzIjpbeyJ0aW1lc3RhbXAiOjQxMDI0NDQ4MDAwMDAsInZhbHVlIjoxNzAwfV0sImxvY2siOnRydWV9XX0
BACK   {"v":2,"d":[{"name":"horizontalStraightLine","paneId":"candle_pane","points":[{"timestamp":4102444800000,"value":1700}],"lock":true}]}
PLAIN  {"v":2,"d":[{"name":"horizontalStraightLine","paneId":"candle_pane","points":[{"timestamp":4102444800000,"value":1700}]}]}
```

判据核对：`BACK`（＝`LOCKED` 去掉首字符 `j` 后经 base64url 解回）逐字含 **`"lock":true`**，`name`／`paneId`／`points` 与编码前的 `base` 一致；`BACK` 与未锁态 `PLAIN` 逐字符 `diff` 得到的差异**只有** `,"lock":true` 一处（本席量法＝`python` 取两串做最长公共前缀／后缀，读得 `BACK` 134 字符、`PLAIN` 122 字符、公共前缀 **119**、公共后缀 **3**、`BACK` 中间多出来的那一段逐字 `,"lock":true`（12 字符，`PLAIN` 同位为空）；串本身留档在 `code-1d.txt`）。第一方导入通道由 `?d=` 承担，与第①片 `self-dw05-panel-session.md` 那趟同一条通道、同一个 `base`，差别只有那一处 `lock`。

## 主键趟（REA 单趟）看到什么

主键趟负责的是「**锁定线经第一方通道进来了、并且活在清单上**」这一环，删除否决由下一节那三条腿负责，两条通道在本记录里分别署名。逐字计数（`grep -o` 数，留档 `C:/Users/fire/AppData/Local/Temp/rea-l3t1/setup-1d.cmd`／`setup-1d.out`／`setup-1d.err`；`.cmd` 782 字节、`tr -cd '\r' | wc -c`＝0、执行形状＝`bash setup-1d.cmd > setup-1d.out 2> setup-1d.err`，rc=0）：

- `grep -o '清单 · 1' setup-1d.out | wc -l`＝**1**，`grep -o '清单 · 2'`＝**0** ⇒ 那枚按钮的可达名逐字 ` - button \"画线清单\": 清单 · 1`（第 82 行树内，`grep -o 'button \\"画线清单\\"[^\\]\{0,20\}' | sort -u` 只回这一串）——一条锁定线经 `?d=` 落到清单上，计数为 1，不是第①片踩过的那个 2。
- `grep -o 'button \\"画线清单\\" \[disabled\]'`＝**0** ⇒ 该按钮**不带** `disabled`。全树 `disabled` 另有三枚，都不是它：`button \"刷新报价\" [disabled]`／`button \"对比\" [disabled]`／`button \"添加\" [disabled]`。
- 一条如实登记：那棵树的 `main` 段里有 ` - text: 1 处画线落点在最新 K 线右侧的空白里，已吸回最后一根`——码里的 `timestamp` 是 2000-01-01，页面按自家 `reanchor` 把它吸到了最后一根 K 线。本判据不受它影响（`boot` 只问「图上恰好一条、且它锁着」；下一节 `aim()` 又把它搬到蜡烛面板正中再量坐标），但它证明**导入通道确实落到了活图**、不只是写进了桶。

## 第二通道（不是 REA）：原始 CDP 三腿

`rea-agents@latest` 6.5.0 的 `--help` 子命令面（153 枚，逐字清单见最下面一节）里**没有**任何一条能在 canvas 坐标上派发手势，也没有执行页内 JS 的口——与本记录判据有关的几枚逐字描述是 `capture-browser-scenario  Run one bounded Playwright browser scenario and return Evidence`（动作词汇表是 locator 级的，落不到「画布上第 x,y 个像素」）、`inspect-web-page  Passively inspect one page through CDP, defaulting to its current origin`、`observe-web-execution  Observe precise page execution; resets counters and temporarily disables optimization`、`observe-javascript-runtime  Passively observe one exact Node/Electron Inspector target`（那枚 `--help` 里带 `javascript` 的运行时口全是 Node/Electron Inspector 一侧，不是页内 `Runtime.evaluate`）⇒「真点一次右键」只能走 CDP 客户端。这一节读数来自仓外脚本 `C:/Users/fire/AppData/Local/Temp/rea-l3t1/veto-1d.mjs` ＋ `C:/Users/fire/AppData/Local/Temp/rea-l3t1/cdp-1d.mjs`（scratch，会随系统清理消失，复算以本节的三条命令形状与 `cdp.mjs` 的探针形状为准）：

- `Runtime.evaluate` 经 React fiber 全树扫描取图表实例（探针是 `typeof cand.getOverlays === "function" && typeof cand.getDataList === "function"`，扫全文档再 BFS `hook.memoizedState`）
- `Input.dispatchMouseEvent` 三连：`mouseMoved` → `mousePressed{button:"right",clickCount:1}` → `mouseReleased`
- 否决经公开 `overrideOverlay({id, onRightClick})` 挂上，**没有改任何仓内代码**
- 跑法：`cd "C:/Users/fire/AppData/Local/Temp/rea-l3t1" && node veto-1d.mjs "<上面那枚 LOCKED 串>" 2>&1 | tee veto-1d.out` ⇒ **rc=0**，stdout 留档 `veto-1d.out`（26 行＝脚本每行 `log()` 即时打印一次、结尾再整体打印一次，所以整段出现两遍；下面贴第一遍，逐字未改）

```text
A | boot | ready 1
A | aimed | id=overlay_1792222546270_1 x=746 y=433 value=1300.4249999999997
A | dy=0 | NONE
A | won | dy=0
B | boot | ready 1
B | aimed | id=overlay_1792222549124_1 x=746 y=433 value=1300.4249999999997
B | attach | overlay_1792222549124_1 function
B | after | NONE | hits=1 | sawPreventDefault=true | sawLockedOverlay=true
C | boot | ready 1
C | aimed | id=overlay_1792222552164_1 x=746 y=433 value=1300.4249999999997
C | attach | overlay_1792222552164_1 function
C | after | overlay_1792222552164_1=locked | hits=1
SHAPE | A=deleted | B=deleted+hit1 | C=survived+hit1
```

脚本相对简报正文的唯一改动是第 3 行的现场端口（`const BASE = "http://localhost:8000/pro-chart";`，原为 5899）与 import 指到同目录那枚 `cdp-1d.mjs`；偏移表 `const OFFSETS = [0, -2, 2, -4, 4, -6, 6, -8, 8, -12, 12];`、三腿、判据、`exit 2` 分支逐字未动，`cdp.mjs` 一字未改（`connect("/pro-chart")` 按子串找页，换端口后仍命中）。A 只是第一发（`dy=0`）就中了，所以「为让 A 赢而放宽手势」这枚假绿面不成立。

## 判据（三腿对照，缺一腿读不出因果）

| 腿 | 挂了什么 | 读数 |
|---|---|---|
| A | 未挂回调 | **被删**（`ids()` 回 `NONE`），赢的偏移 `dy=0`、坐标 `x=746 y=433` |
| B | 回调只计数不拦 | **被删**（`NONE`），hits=**1**，`sawPreventDefault=true`、`sawLockedOverlay=true`，`attach` 回 `… function` |
| C | 回调并 `preventDefault()` | **存活**（`overlay_1792222552164_1=locked`，仍锁着），hits=**1**，`attach` 回 `… function` |

三条 `boot | ready 1` 意味着经 `?d=` 导入的锁定线在生产构建里**真的落到了活着的 chart 实例**（`getOverlays()` 长度 1 且 `lock === true`）；`aimed` 的 `value=1300.4249999999997` 来自 `convertFromPixel` 的真实价轴刻度 ⇒ 画布上有 K 线（不是空图）。判决落在简报 Step 6 三选一的第一支：**否决成立**——「C 活下来」只剩一个解释（`preventDefault`），因为 B 在**同一坐标**、同一挂法、只差那一句调用之下被删了且 hits 也是 1。

## 与前席（`task-1c-report.md`）读数的对照

本席**自己重跑**了全部三条腿与 REA 主键趟，没有沿用前席任何读数。异同：形状全同——A 在 `dy=0` 赢、坐标同为 `x=746 y=433`、`value` 同为 `1300.4249999999997`、B 被删且 `hits=1`／两枚 `saw*=true`、C 存活且 `hits=1`、`veto` rc=0；不同只在会漂的那几枚——图元 id 的毫秒号（前席 `overlay_1792221852762_1`／`_1856355_1`／`_1861302_1`，本席 `overlay_1792222546270_1`／`_2549124_1`／`_2552164_1`，id 每次恢复重新生成，第①片记录里已经记过同一现象）、Edge PID（5884 → 19020）、后端 PID（20456 → 29168）、`target_id`（`3529A6D1423FE1C15031B38603A27761` → `A1D199BBF29B8DF551A28D35970491F6`）。前席那趟**没有 REA 主键趟、因此没有当趟 `evidence_id`**（它自己 concern 2 登记的缺口）；本席把那一趟补在 prod 现场上，主键即上面那枚。asset 指纹两串与前席同值（`assets/index-DCC1ULv_.js`）＝代码树未动的旁证，与本席第一节那组 `git diff --stat`／blob 复验同向。

## REA 子命令面（为什么这一路必须走 CDP）

`npx -y rea-agents@latest --help` 在 6.5.0 下的 `Commands:` 段，只列名字那一段，逐字 153 枚（留档 `C:/Users/fire/AppData/Local/Temp/rea-l3t1/subcommands-1d.txt`）：

```text
address-to-file-offset
analyze
analyze-javascript-application
analyze-web-bundle
annotate-native-function
build-reconstruction-obligation-ledger
capabilities
capture-adb-screen
capture-browser-scenario
capture-electron-scenario
capture-native-ui-scenario
capture-process
capture-web-screenshot
collect-adb-bugreport
compare
compare-application-versions
compare-javascript-export-shapes
compare-managed-members
compare-process-captures
compare-source-to-bundle
compare-wasm-interfaces
compare-web-captures
compare-web-screenshots
cutter-command
debug-with-gdb
debug-with-rizin
decode-android-resources
decode-interface-builder
decode-signal-recording
decompile
decompile-jeb-item
demangle-swift
discover-webmcp-tools
doctor
evaluate-reconstruction-coverage
evidence-export
evidence-import
execute-rizin-command
export-web-scripts
extract-artifact
extract-firmware
function
identify-flutter-build
import-managed-reconstruction
import-reference-source
inspect
inspect-adb-client
inspect-adb-device
inspect-adb-display
inspect-adb-package
inspect-adb-window
inspect-analysis-view
inspect-android-class
inspect-android-method
inspect-android-package
inspect-apktool-client
inspect-artifact
inspect-asset-catalog
inspect-binary-layout
inspect-dart-aot
inspect-electron-fuses
inspect-electron-page
inspect-evidence-bundle
inspect-evm-interface
inspect-firmware-regions
inspect-go-binary
inspect-jeb-client
inspect-keyed-archive
inspect-macho
inspect-managed-artifact
inspect-managed-members
inspect-managed-native-boundaries
inspect-native-api
inspect-native-data-type
inspect-native-dispatch-metadata
inspect-native-instruction
inspect-native-load-image
inspect-packet-capture
inspect-packet-fields
inspect-pcap-capture
inspect-pcap-client
inspect-pe-resources
inspect-plist
inspect-recorded-crash
inspect-rust-binary
inspect-signal-decoders
inspect-signature
inspect-sqlite-database
inspect-wasm-artifact
inspect-web-event-listeners
inspect-web-network-capture
inspect-web-page
inspect-with-objdump
install-adb-package
instructions
instrument-with-frida
list-adb-devices
list-adb-directory
list-adb-features
list-adb-packages
list-adb-processes
list-adb-services
list-architectures
list-browser-targets
list-cutter-sessions
list-electron-targets
list-frida-devices
list-frida-processes
list-javascript-runtime-targets
list-jeb-units
list-objdump-architectures
observe-javascript-runtime
observe-native-calls
observe-native-ui
observe-web-execution
observe-web-session
open-jeb-project
project-android-application-graph
project-apple-application-graph
project-harmony-application-graph
project-managed-application-graph
providers
pull-adb-file
pull-adb-package
push-adb-file
read-adb-logcat
read-adb-setting
read-bytes
reconcile-javascript-runtime
recover-javascript-sources
resolve-adb-packages
resolve-native-call-targets
search
search-android-classes
search-bytes
setup
start-adb-activity
start-adb-app
stop-adb-app
trace
trace-android-references
trace-application-feature
trace-dylib-resolution
trace-javascript-semantics
trace-native-ui-action
trace-native-values
trace-web-module-imports
trace-web-source-location
uninstall
uninstall-adb-package
update
verify-managed-native-boundaries
xrefs
```

## 登记一条裁定

L0 的定义在 `docs/forensics/README.md` 是「一条 REA 单趟 CDP 命令 ＋ 一个观察面 ＋ 一份记录」。本记录的判决读数落在**第二通道**（原始 CDP 三腿）上——`命令：` 与 `evidence_id` 是真 REA 趟（prod 现场、当趟自取），但 A／B／C 三条不是。理由已经写在上面那一节：REA 的 `capture-browser-scenario` 词汇表是 locator 级的，指不到 canvas 上那枚像素落点，而删除否决恰恰只有「在图的坐标上真点一次右键」才读得出。**若评审席判这不够格，出路是整条降为 `状态：不可取证` ＋ 一段散文说明 REA 表达不了 canvas 落点，而不是拿 jsdom 读数冒充活体**（既有形状见 `tools/forensics_audit.py` 的 `_audit_l0` 里 `UNCAPTURABLE` 那一支）；本席按简报把两枚通道都署名、并让 REA 趟负责「锁定线经第一方通道进来了」这一半，没有拿静态判据充当活体。

## 偏差（如实登记，不放宽判据）

简报 Step 8 的骨架末行与本片控制席的红线都写着 `用途：规格`，而本片正文写的另一条要求是「两枚吃 L0 的门都要绿」。**这两条在现读的规则下不能同时成立**，本席两条都当场量过，逐字读数（仓库根、`python -X utf8`）：那一行写成 `- 用途：规格` 时 `tools/forensics_audit.py` 读 **rc=1**，唯一一条违规句逐字 `l0/self-dw05-lock-veto.md: 没有被任何规格条目引用，也没标 用途：harness 或 用途：基线`，同形状的失败带进 `tools/test_forensics_spec.py::test_live_forensics_tree_is_clean` ⇒ 那一趟该套件的 pytest **rc=1**；那一行改成 `- 用途：基线`（**只改这一行，正文一字未动**）后同一对命令读 `forensics audit: clean`／rc=0 与 同一趟 pytest **rc=0**。成因不是本席放宽，是**引用面还不存在**：孤证规则（`tools/forensics_audit.py:534-540`）的 `cited` 只从 `docs/forensics/spec/*.md` 那几张表的 `L0 依据` 列收集，本席现读 `grep -c "lock-veto" docs/forensics/spec/drawings.md`＝**0**，而 `grep -n "L0 依据" docs/superpowers/plans/2026-10-17-l3-slice2-locked-delete.md` **无输出**＝本片七个任务里没有任何一步要把这份记录写进规格表的 `L0 依据` 列（`docs/forensics/gap-matrix.md:86` 那一大段提到过本记录的**路径**，但矩阵是 L2，不进 `cited`）。所以按仓内既有口径落 `基线`：`docs/forensics/batch-A-playbook.md:389-392`（本席 `sed -n '388,394p'` 现读到该段）写的正是「新落成的 **TV** 记录先写 `用途：基线`——孤证规则……只豁免那两种用途」＋「把它们逐条引用进条目表之后，再把 `用途：` 改成 `规格`——这一改是被引用逼出来的」；该段字面主语是「TV 记录」／「批次 A」，把它套在自家页记录上是**按同一规则的推广**（`tools/forensics_audit.py:534-540` 那六行按 `l0/` 全目录判、结构上没有 host 分支），这一层限定照第①片 `self-dw05-panel-session.md` 偏差 5 的 F6 子句同一口径登记，而那一格本身就是同一枚坑的既成先例。**翻回 `规格` 的前置动作**＝把本记录补进 `docs/forensics/spec/drawings.md` 的 TV-DW-05 那一格（或 `chart-interaction.md` 相应格）的 `L0 依据` 列；本席无权动那张表（提交面红线只许这一份文件），故不冒充。**这一格只关引用拓扑，与本记录上面所有读数无关**，尤其不影响判决那一行：A 删得动／B 删得动且 hits==1／C 删不动且 hits==1。

（**2026-10-17 第②片落档席带日期追加更正——上面那段原句一字不删**：本记录上面那句「`grep -n "L0 依据" docs/superpowers/plans/2026-10-17-l3-slice2-locked-delete.md` **无输出**＝本片七个任务里没有任何一步要把这份记录写进规格表的 `L0 依据` 列」，**在它被写下的那一站是真话**——它记的是 `87bd946d` 那一趟的盘面，当时那份计划正文确实一处都没提 `L0 依据`。后来 `bb56c6a8` 把「把本记录补进 TV-DW-05 的 `L0 依据` 列＋同笔翻 `用途`」这一步显式写进了 Task 7 Step 2，所以今天（2026-10-17 落档席复跑同一条命令）拿到的是**非空**命中，**非空不是失败**，而是引用面已经存在这件事本身。同段上面还有一枚 `grep -c "lock-veto" docs/forensics/spec/drawings.md`＝**0**，同样是那一趟的点时读数：落档席本次把 `self-dw05-lock-veto.md` 追加进那一行的 `L0 依据` 列之后，这条命令在**当前树**上照例不再为零——两处都不改写、只按本条 append-only 承载。**本笔正是那段里写明的「翻回 `规格` 的前置动作」的执行**：`docs/forensics/spec/drawings.md` 的 TV-DW-05 那一行 `L0 依据` 列末已按既有顿号形状追加 `self-dw05-lock-veto.md`，同笔把本记录末行的 `用途：基线` 翻成 `用途：规格`——两半必须同一笔提交，拆开任何一半都让孤证门在中间那一站红一次（要么「标了规格却没被引用」，要么「引用了规格条目却仍挂旁证」）。为什么不能长期挂 `基线` 也在那段写过了：这份记录本来就是 TV-DW-05 后半个键的验收凭据，挂旁证是把地基记成附注。本次翻面**不改动上面任何一条判决读数**，也不动 `命令：`／`evidence_id` 那两枚真 REA 趟的署名；登记一条边界：那枚「第二通道（原始 CDP 三腿）」的降级出路仍然挂着——若评审席判它不够格，处置是整条降 `状态：不可取证`，不是拿 jsdom 读数冒充活体。本段两条门的判定读数只落台账，不写回本记录，以免自指。）

- 用途：规格
