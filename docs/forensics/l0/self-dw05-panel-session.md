# L0：自家页四枚面板开关的会话级持久化——活过一次页面刷新的三趟读数（TV-DW-05 自家页侧的反事实检验）

- 命令：npx -y rea-agents@latest capture-browser-scenario '{"browser":{"mode":"connect","cdp_endpoint":"http://127.0.0.1:9222","target_id":"DA58D0F73F5042EF84BF7746C21E22FD"},"start_url":{"url":"http://localhost:5899/pro-chart"},"actions":[{"step_id":"s1","action":"click","locator":{"kind":"role","role":"button","name":"画线清单"}}],"storage":{"cookies":[],"local_storage":[],"session_storage":[]},"secrets":[],"capture":{"after_each_step":[],"at_end":["url","accessibility"],"events":[],"network":{"request_body":false,"response_body":false,"header_values":false}}}' --filter-output evidence_id,normalized_result --token-limit 150000
- 命令（三趟同形，run1／run2／run3）：上面那条 `命令：` 是本记录的主键趟＝run1。run2 与 run3 用的是**逐字相同**的另一条写法之外的同一命令体：先把这一行命令文本 `tee` 成 `run.cmd`，再 `for r in run1 run2 run3; do tee "$r.cmd" < run.cmd > /dev/null; done` 复制成三枚文件，实测 `wc -c run1.cmd run2.cmd run3.cmd`＝**633／633／633 字节**，`diff run1.cmd run2.cmd`＝**rc 0**、`diff run2.cmd run3.cmd`＝**rc 0**；三枚文件 `tr -cd '\r' | wc -c` 各＝**0**（纯 LF）。实际执行形状＝`bash $r.cmd | tee $r.out > /dev/null`，一个 `for` 循环按 run1→run2→run3 顺序串行跑，同一浏览器现场、不重启、不清 storage、三条 rc 全 0。
- 命令（前置导入趟）：主键趟之前必须先让画布上**已有一条图元**，否则那枚按钮 `[disabled]`、click 打不动（判因凭据见 `self-ci07-panel-toggle.md`）。零画线时该按钮的解禁只能走本仓第一方 `?d=` 分享链接——鼠标落点在现行 REA 词汇表里不可表达，没有「点出来一条线」这条路。逐字命令行（与 `rea-l3t5/setup-import.cmd` 同字节，766 字节／CR 计数 0）：

    ```text
    npx -y rea-agents@latest capture-browser-scenario '{"browser":{"mode":"connect","cdp_endpoint":"http://127.0.0.1:9222","target_id":"DA58D0F73F5042EF84BF7746C21E22FD"},"start_url":{"url":"http://localhost:5899/pro-chart?d=jeyJ2IjoyLCJkIjpbeyJuYW1lIjoiaG9yaXpvbnRhbFN0cmFpZ2h0TGluZSIsInBhbmVJZCI6ImNhbmRsZV9wYW5lIiwicG9pbnRzIjpbeyJ0aW1lc3RhbXAiOjQxMDI0NDQ4MDAwMDAsInZhbHVlIjoxNzAwfV19XX0"},"actions":[{"step_id":"s1","action":"wait_for_timeout","duration_ms":9000}],"storage":{"cookies":[],"local_storage":[],"session_storage":[]},"secrets":[],"capture":{"after_each_step":[],"at_end":["url","accessibility"],"events":[],"network":{"request_body":false,"response_body":false,"header_values":false}}}' --filter-output evidence_id,normalized_result --token-limit 150000
    ```

    形状取自 `self-ci07-panel-toggle.md` 的前置导入趟（留档 `rea-t11b/setup-draw.cmd`），改动三处照旧：`target_id` 换本趟现读值、`goto` 步换成 `start_url` 直接带码、加一步 `wait_for_timeout` 等 hydrate。该趟主键 `ev_f8a0c2b1dd98853aa731de2eff70e206e1927959f3cf4d174cf32dffa2dbefd6`；`?d=` 串本席复验过一次：首字符 `j` 是 codec 标记位（`frontend/src/lib/drawingExchange.ts:357` 判 `payload[0] === "g"` 才走 gzip，否则按明文 `j`），去掉首字符后 `urlsafe_b64decode` 逐字解得 `{"v":2,"d":[{"name":"horizontalStraightLine","paneId":"candle_pane","points":[{"timestamp":4102444800000,"value":1700}]}]}`。
- 命令（诊断趟）：run1／run2／run3 只在 click **之后**采树，所以「这一趟起步就是开着」在两趟计数里是推断。补的这一趟＝`actions` 两步（第一步 `wait_for_timeout` 9000ms、第二步那一次 `click`）＋`capture.after_each_step:["accessibility"]`＋`capture.at_end:["url"]`，逐字（与 `rea-l3t5/diag.cmd` 同字节，696 字节／CR 计数 0）：

    ```text
    npx -y rea-agents@latest capture-browser-scenario '{"browser":{"mode":"connect","cdp_endpoint":"http://127.0.0.1:9222","target_id":"DA58D0F73F5042EF84BF7746C21E22FD"},"start_url":{"url":"http://localhost:5899/pro-chart"},"actions":[{"step_id":"s1","action":"wait_for_timeout","duration_ms":9000},{"step_id":"s2","action":"click","locator":{"kind":"role","role":"button","name":"画线清单"}}],"storage":{"cookies":[],"local_storage":[],"session_storage":[]},"secrets":[],"capture":{"after_each_step":["accessibility"],"at_end":["url"],"events":[],"network":{"request_body":false,"response_body":false,"header_values":false}}}' --filter-output evidence_id,normalized_result --token-limit 150000
    ```

    该趟主键 `ev_29b551482876c77fe106adc35545fe28d5c18fe4972fe0e4f98032604a9e7d47`。与主键趟的形状差别只有三处：`actions` 一步变两步、`after_each_step` 由空数组变 `["accessibility"]`、`at_end` 由 `["url","accessibility"]` 变 `["url"]`；**没有** `--allowed-origins`（那把旗标在场景命令上被拒，读数见 `self-ci07-panel-toggle.md` 第四枚摘录）。
- evidence_id：ev_f8da23b1add5d1dd9395256b33e6e4f1abd113a1da59cf0bc886b462c99ba7fc
- 浏览器：Chromium 155.0.4283.45（run1 stdout 第 3-8 行 browser 块逐字：`mode: connect`／`process_ownership: external`／`cleanup: disconnected-external`／`product: Chromium`／`version: 155.0.4283.45`）；宿主与现场＝本机 Edge `--headless=new`（`C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe`，`--no-proxy-server`，CDP 9222，`--user-data-dir` 在 `rea-l3t5/edge-profile`，`--window-size=1100,800`，`netstat` 现读 PID 11540、`tasklist //FI "PID eq 11540"` 核身 msedge.exe，全程未重启），`target_id` 本趟现读 `DA58D0F73F5042EF84BF7746C21E22FD`（`list-browser-targets` 在导入趟之前与 run1 之前各读一次，两次同值，且 `excluded.unsupported_url: 1`、`targets[1]` 只有这一枚 page）。口径差别照旧要记着：场景命令的 browser 块给 `product: Chromium` ＋ 独立 `version`，单趟 CDP 那趟给 `product: Edg/155.0.4283.45`（stdout `browser.product` 行），两种形读数同属 Edge 155.0.4283.45，不是两个浏览器。工具版本 6.5.0 的 `list-browser-targets` 已改收**位置参数** endpoint（用法行写作 `rea list-browser-targets` 后面跟一个 endpoint 位置参数），旧的 JSON 形状 `{"browser":{...,"cdp_endpoint":...}}` 现在一律报 `path[1]: cdp_endpoint / reason: invalid_value / message: "Invalid CDP endpoint URL"`——那是旗标形状漂移，不是 CDP 没通（同一端点 `curl /json/version` 与 Node `fetch` 各读 200）。
- 目标 URL：http://localhost:5899/pro-chart（**自家 dev server，不是 tradingview.com**；run1 stdout 第 10 行 `scenario.start_origin` 回声 `http://localhost:5899`，第 24-33 行 step 0 的 before_url 与 after_url 同值＝开头那次 `goto_start` 没换页，第 60-69 行 click 步的 before_url／after_url 仍是同一串＝这一次点击没换路由，第 83-89 行 at_end 的 url 工件同一值；前置导入趟那一次 after_url 多带一个 `?d=`，`query_parameter_names[1]: d`）
- 观察条件：本记录 vouches 的主键趟＝run1（第 18 行 `duration_ms: 2036`、step 0 第 23 行 `elapsed_ms: 1382`、click 步第 59 行 `elapsed_ms: 634`），对端趟＝run2（`duration_ms: 2056`／click 步 `elapsed_ms: 588`）、run3（`duration_ms: 1773`／click 步 `elapsed_ms: 422`），三趟命令行**逐字相同**（`diff` 两次皆 rc 0）、同一浏览器现场、不重启、不清 storage、不 reload 之外的手动干预；前置＝画布上有导入进来的 `水平线`（前置趟 stdout 读到 `button \"画线清单\": 清单 · 2`，按钮已解禁且面板关着——**读数是 `清单 · 2` 不是 `清单 · 1`**，成因见下面「偏差」一节）；本记录四趟里点过的元素只有 `画线清单` 这一枚、总共四次 click（run1／run2／run3 各一次，诊断趟一次），除这些 click 外未点按别的元素、未 fill、未登录、未保存、未交易、未切 tab、未触碰任何真实下单或持久化写入路径；只访问 `localhost`（CDP 端点是 `127.0.0.1:9222`，页面 origin 是 `http://localhost:5899`），四趟 stdout 全程没有 429／验证码／风控形状；四趟场景 JSON 的 `storage` 段逐字 `"cookies":[],"local_storage":[],"session_storage":[]` ⇒ **未请求任何 storage 读数**，所以本记录不指认那条画线与那四枚开关靠什么载体活到下一趟（run1／run2／run3 各步 `artifacts.storage.state: not_requested`，run1 第 92-93 行）
- 完整性：两层且不同值，本记录 `完整性：` 抄顶层并解释缺席面——顶层（run1 第 105-109 行）`status: incomplete`／`equality_eligible: false`／`missing_sections[1]: events`／`truncated_sections: []`，而 `events` 缺席是这四条场景命令自己把 `capture.events` 声明成空数组的结果，**不是页面上没有事件**（run1 第 101-104 行 `events: retained: 0 / dropped: 0 / items: []`，第 17 行 `event_families: []`）；步骤级（run1 click 步第 94-99 行）`status: complete`／`equality_eligible: true`／`missing_sections: []`／`truncated_sections: []`，其 accessibility 工件第 77-81 行 `state: captured`／`sha256: 9a49d9a221d71dbc3c802394ec56e3eeface83603c85d8a4c297e286b36765d4`／`bytes: 6074`；四趟 stdout 全文 `grep -c parse_failures` 各＝0，故顶层无需解释该键；另：`--filter-output` 按主键同趟口径写成 `evidence_id,normalized_result`（只点 `normalized_result` 会把顶层 `evidence_id` 一起滤掉），`--token-limit 150000` 之下那棵可达树这次**整串随 stdout 落盘**（run1 第 82 行，单行转义串），不再像旧记录只能引用 sha256＋bytes
- 状态：活体取证成立——同一 target、不重启、逐字相同的命令连跑三趟，pressed 计数呈 **1/0/1** 交替；诊断趟两枚等值判据（`s1` 那棵 == run1 的 at_end 形态、`s2` 那棵 == 其反面）**都成立**；另有「run3 收尾开着 ⇒ 诊断趟 `s1`（点击之前）仍读到开着」这一枚跨导航直读
- 用途：基线
- 取证时间：run1 落盘 mtime `2026-10-16 01:51:05.409019200 +0800`、run2 `01:51:12.619104800`、run3 `01:51:19.486310100`、诊断趟 `01:52:41.560966100`、前置导入趟 `01:49:34.680968400`（复算 `stat -c %y run1.out` 等五条；场景趟 stdout 里**没有绝对时间戳键**，只有 `duration_ms` 与逐步 `elapsed_ms`，所以这五个时刻记的是「写文件」不是「跑命令」，趟与趟的执行间隔只能由 mtime 上界读）
- 留档（仓外临时件，会随系统清理消失）：`C:/Users/fire/AppData/Local/Temp/rea-l3t5/` 下 `run.cmd`／`run1.cmd`／`run2.cmd`／`run3.cmd`（各 633 字节）、`run1.out`（10,144 字节）／`run2.out`（9,569）／`run3.out`（10,144）、诊断趟 `diag.cmd`（696 字节）／`diag.out`（19,906 字节）、前置导入趟 `setup-import.cmd`（766 字节）／`setup-import.out`（9,945 字节），以及本席那一次被自己管道截断的废件 `setup-import.truncated-by-pipe.out`（4,096 字节，见「偏差」第 1 条）与 `edge-start.txt`／`fetch-probe.mjs`

## 现场与归属（本趟所有读数的边界）

两个服务**都不是本席起的，本席也没停它们**：后端 PID 11692（`tasklist //FI "PID eq 11692"`＝python.exe，`netstat` 逐字 `TCP 127.0.0.1:8000 ... LISTENING 11692`），前端 dev server PID 28596（node.exe，`netstat` 逐字 `TCP [::1]:5899 ... LISTENING 28596`）。端口出处当场开过那一行：`frontend/vite.config.ts:26` 逐字 `const apiTarget = env.VITE_API_URL || "http://127.0.0.1:8000";`、`frontend/vite.config.ts:43` 逐字 `port: 5899,`。

**地址族不是服务状态**：dev server 只绑 IPv6 回环，所以简报 Step 2 那行 `curl http://127.0.0.1:5899/pro-chart` 本席实测＝`000` 且 `curl rc=7`（拒连），而 `http://localhost:5899/pro-chart` 与 `http://[::1]:5899/pro-chart` 各＝200；后端 `http://127.0.0.1:8000/health`＝200。`127.0.0.1:5899` 那一枚拒连**不许**被读成「前端没起来」。

「服务的是不是本 worktree」这条前提本席自己复跑过：`curl -s http://localhost:5899/src/lib/chartPanels.ts` 回传的模块体第 1 行逐字含 `export const PANELS_KEY = "pro-chart.panels.v1";`，复算 `curl -s http://localhost:5899/src/lib/chartPanels.ts | grep -c 'export const PANELS_KEY = "pro-chart.panels.v1"'`＝**1**（同一份回传里 `sessionStorage.getItem(PANELS_KEY)`／`removeItem`／`setItem` 三处各命中一次）。

**dev server 走的是工作树，本趟读数含未提交的 `chartDrawings.ts`**。本席开工起点的记账（`git status --short` 与 `git diff --numstat` 逐字）：

```text
 M frontend/public/usage-guide.md
 M frontend/src/lib/__tests__/chartDrawings.test.ts
 M frontend/src/lib/chartDrawings.ts
```

```text
1	1	frontend/public/usage-guide.md
14	4	frontend/src/lib/__tests__/chartDrawings.test.ts
2	2	frontend/src/lib/chartDrawings.ts
```

这三枚是别席的在途件，本席一个字节没动、没提交、没回退；收工时复跑同一对命令，两份读数逐字相同。HEAD＝`fa9f0eae`（分支 `feat/l3-panel-visibility`）。清理只按 `netstat -ano` 现读到的 PID 11540 走 `taskkill //PID 11540 //T //F`（rc=0，回执逐字列出它终止的 9 枚子进程与父进程本身），**没有**按镜像名杀 `msedge.exe`，8000／5899 那两枚 PID 未触碰；复核 `for p in 9222 5899 8000; do echo -n "$p "; netstat -ano | grep ":$p" | grep -c LISTENING; done` 读＝`9222 0`／`5899 1`／`8000 1`——后两枚**按设计仍为 1**（不是本席起的，本席无权停），简报 Step 8 那句「三个计数都该是 0」在「服务已在外部监听」的现场下不适用。

## 摘录（逐字，未改写）

第一枚：三趟 at_end 树里那枚按钮自身（各趟 stdout 第 82 行那个单行转义串里的片段，`grep -F` 可命中同一行）。围栏里三行**都是逐字片段、没有前缀**：第一行＝run1、第二行＝run2、第三行＝run3。

```text
 - button \"画线清单\" [pressed]: 清单 · 2
 - button \"画线清单\": 清单 · 2
 - button \"画线清单\" [pressed]: 清单 · 2
```

第二枚：诊断趟里同趟两棵树中那枚按钮——第一行＝`step_id: s1`（该 `step_id` 在 stdout 第 61 行，树在第 86 行，工件第 84-85 行 `sha256: 8feb6daaa2f88b9d07eedfa288e590ef1f1d36418638adb9efa7c0e41092c638`／`bytes: 6119`）、第二行＝`step_id: s2`（`step_id` 第 101 行，树在第 126 行，工件第 124-125 行 `sha256: 93249b91c288b6ab88919eb2c4dfefd132288bfc2be7802a3be3a0988cc569db`／`bytes: 5569`）。这一行是「点之前」的树，且**不是** `step_index: 0` 那棵。

```text
 - button \"画线清单\" [pressed]: 清单 · 2
 - button \"画线清单\": 清单 · 2
```

第三枚：诊断趟 `step_index: 0`（`step_id: scenario_start`／`action: goto_start`，`elapsed_ms: 1624`，第 20-23 行）那棵树——工件第 42-45 行 `state: captured`／`bytes: 2360`，树在第 46 行。旧记录踩过的那个坑本趟复现了：`sed -n '46p' diag.out | grep -c '画线清单'`＝**0**（整棵树里连那枚按钮都没有），所以 `step_index: 0` 那棵空树**不许当「点之前的面板态」用**，要「点之前」就必须显式加一步 `wait_for_timeout`。

## 判据与复算

判据要的是等值关系，不是常量。复算命令逐字（留档在仓外 `C:/Users/fire/AppData/Local/Temp/rea-l3t5`，可复跑）：

```bash
cd "C:/Users/fire/AppData/Local/Temp/rea-l3t5"
for r in run1 run2 run3; do echo "== $r"; grep -c 'button \\"画线清单\\" \[pressed\]' $r.out; grep -c 'button \\"画线清单\\":' $r.out; done
for r in run1 run2 run3; do echo -n "$r "; sed -n '1p' $r.out; done
diff run1.cmd run2.cmd; diff run2.cmd run3.cmd
wc -c run1.cmd run2.cmd run3.cmd
grep -c 'button \\"画线清单\\" \[pressed\]' diag.out
grep -c 'button \\"画线清单\\":' diag.out
sed -n '46p' diag.out | grep -c '画线清单'
grep -c 'button \\"画线清单\\" \[disabled\]' run1.out run2.out run3.out diag.out setup-import.out
for p in 9222 5899 8000; do echo -n "$p "; netstat -ano | grep ":$p" | grep -c LISTENING; done
```

本席 2026-10-16 现读：三趟的 `[pressed]`／「不带 pressed」两把计数分别是 run1＝1/0、run2＝0/1、run3＝1/0 ⇒ **形状 1/0/1**；`[disabled]` 那一枚在五份 stdout 里各＝**0**（全树唯一的 `disabled` 出现在别的按钮上：`button \"对比\" [disabled]` 与 `button \"添加\" [disabled]`）。诊断趟两把计数各＝1/1，且带 `[pressed]` 的那棵是 `s1`（第 86 行）、不带的那棵是 `s2`（第 126 行）。

成立的四条等值关系（照读数写，不写常量）：

1. 诊断趟 `step_id: s1` 那棵树里那枚按钮的形态 == run1 的 at_end 形态（都带 `[pressed]`）；
2. 诊断趟 `step_id: s2` 那棵 == 上一式的反面（不带 `[pressed]`）；
3. run3 的 at_end 形态 == run1 的 at_end 形态（都带 `[pressed]`，且两趟 accessibility 工件 `bytes` 同为 6074）；
4. run2 的 at_end 形态 == 前置导入趟 at_end 形态 == 诊断趟 `s2` 那棵（都不带 `[pressed]`）。

第 3 式的**限缩**要写清楚：`sha256` 两趟不同（run1 `9a49d9a2…`、run3 `f47627a1…`），本席按字符级 diff 定位过差在哪——两行的 `text` 串等长（各 4,789 字符），差异只有 8 组数字，全部是那两条图元恢复时重新生成的毫秒号（run1 `overlay_1792086665186_1/2`、run3 `overlay_1792086679361_1/2`；`grep -o 'overlay_[0-9_]*' run2.out` 为空，因为面板关着、清单行不在树里）。开关态与那串数字无关，与 `self-ci07-panel-toggle.md` 里 2026-10-14 量到的同一现象同形。

三趟 stdout 全文的差异规模也一并留个数：`diff run1.out run2.out | grep -c '^[<>]'`＝**14**、`diff run1.out run3.out | grep -c '^[<>]'`＝**12**。逐字差在 `evidence_id`、`duration_ms`（第 18 行）、两处 `elapsed_ms`（第 23、59 行）、accessibility 工件自身的 `sha256`（第 80 行）与那棵树自己那一行（第 82 行）——run1↔run3 之间 `bytes` 相同故第 81 行不进 diff，run1↔run2 之间它 6,074↔5,524 不同、多出的 550 字节正是面板展开后清单里那两行图元。

## 读数含义：这一趟读到了什么，没读到什么

`1/0/1` 这个形状同时读到两件事，两件事各自都只到「形态」级：

- **持久化真的跨过一次页面刷新**：run2 与 run3 之间没有任何「点开」的动作，唯一改变那四枚开关的是场景自己那一次 `goto_start` 导航＋那一次 click；run2 起步读到的是「开着」，而上一趟收尾就是开着 ⇒ 初值不是 `useState(false)` 给的。诊断趟这一环还有直读：run3 收尾开着（`[pressed]`），下一趟 `s1` 那棵树在任何点击**之前**就带 `[pressed]` ⇒ 开关态活过了又一次导航，中间没有 click。
- **「四枚全 false ⇒ 删键」在活体上成立**（到形态级）：run2 收尾关掉后不留偏差项，run3 因此从「关」起步、又被点开 ⇒ run3 的起步态是 run2 收尾态经「全默认 ⇒ 无键可读 ⇒ 回落默认」那条删键支路的结果。这一句是**行为侧推断**：本记录四趟的 `storage` 三段全空＝没读过 `pro-chart.panels.v1` 这个键本身在删与没删，所以「删键」这半边只由「run3 起步是关的」这个形态逼出来，不由 storage 读数支撑。

**没读到的**：键名、值编码、scope（session vs local）、以及任何对方站点上的对应物。本记录对面是 `docs/forensics/spec/drawings.md` 的 TV-DW-05 与 `chart-interaction.md` 的 TV-CI-06 那两格「键名 ↔ 界面行为」的**推断**边界——本趟读的是**本仓自己的**行为规格（「活过刷新、随 tab 重置」），不构成任何对方侧复刻主张，也不动 `tv-a16-storage.md` 那条纯枚举面。

对 `self-ci07-panel-toggle.md` 那条判因的**反事实检验**：那一格写的是「场景命令每趟开头强制 `goto_start` ⇒ 初值非持久 ⇒ 跨两趟必然同相」。本片把初值变成会话级持久之后，同样逐字相同的三趟命令读到了 `1/0/1` 交替——**「必然同相」这一半现在只有在那格自己声明的前提（初值非持久）下才成立**；前提一换，`goto_start` 那次导航不再抹掉上一趟留下的态。那条判因的两把必填旗标与词表限制本趟复用了旧记录，没有重新证。

## 偏差（如实登记，不放宽判据）

1. **`清单 · 2` 而不是简报 Step 4 要的 `清单 · 1`**。成因是本席自己的管道错误，不是页面：导入趟第一次实际执行形状是 `bash setup-import.cmd 2>setup-import.err | tee setup-import.out | head -60`，`head` 提前关闭管道把 stdout 截成 4,096 字节（废件留档 `setup-import.truncated-by-pipe.out`，那一份的 `grep -c '清单 · 1'` 与 `grep -c 'disabled'` 都读出 0，因为树根本没落盘）。为拿全树本席**把同一条命令重跑了一次**（`> setup-import.out`，rc=0、9,945 字节），于是那两串图元进了两次、清单计数变 2。所以：「按钮不带 `disabled`」＝成立（`grep -c 'button \\"画线清单\\" \[disabled\]' setup-import.out`＝0），「导入真在画布上落出了线」＝成立且落出了**两**条（`清单 · 2`，两趟的树里都带两条 `overlay_…` 行），「恰为 1 条」＝不成立。本记录不拿这个偏差去充 `清单 · 1`，也不因此重跑整套三趟（重跑只会变成 `清单 · 4`）。
2. **降级顺序没有被触发**：简报 Step 4 的第 1—4 级都不必试——第 1 级那次 `wait_for_timeout` 9000ms 一趟就够（导入趟 click 步之前按钮已解禁），所以本记录**不**含「种 `pro-chart.drawings.v1` 桶」那种「画线条目由我方直接种盘」的形状，`?d=` 第一方导入通道本身是被走通过的那一条。
3. **工具形状漂移**：`list-browser-targets` 在 rea-agents 6.5.0 下改收位置参数（详见「浏览器」键末段）。场景命令 `capture-browser-scenario <inputJson>` 的 inline JSON 形状与旧记录逐字兼容，四条命令体除 `target_id` 外与 `self-ci07-panel-toggle.md` 的形状一字不差。
4. **主键趟的实际执行形状是 `bash run1.cmd | tee run1.out > /dev/null`**（先 `tee` 出 `.cmd` 再执行，`.cmd` 里那一行就是留档的 `命令：`），与简报 Step 5 循环体那行的差别只是命令文本从文件读入、stdout 丢弃；`--filter-output`／`--token-limit` 与 JSON 段逐字未动。
5. **`用途` 这一格写的是 `基线`，不是本片简报 Step 7 要的 `规格`**，两条 rc 都当场量过：同一份正文只换那一行——`- 用途：规格` 时 `python -X utf8 tools/forensics_audit.py` 读 **rc=1**，逐字违规句是 `l0/self-dw05-panel-session.md: 没有被任何规格条目引用，也没标 用途：harness 或 用途：基线`；`- 用途：基线` 时读 **rc=0**（`forensics audit: clean`）。理由是仓内既有口径而不是本席放宽：`docs/forensics/batch-A-playbook.md:390-393` 写的正是「新落成的记录先写 `用途：基线`（孤证规则只豁免 `harness`／`基线`），等被逐条引用进条目表之后再把 `用途：` 改成 `规格`——这一改是被引用逼出来的，不是放宽规则」，而本片后续两席都没有引用面（Task 6 的 Files 段逐字写着「不动: `docs/forensics/spec/*.md`」、Task 7 只动 `项目档案.md` 与记忆），所以此刻没有任何一条 L1 的 `L0 依据` 列能指到这份文件。**改回 `规格` 的前置动作**＝把本记录补进某条规格条目（候选是 `drawings.md` 的 TV-DW-05 或 `chart-interaction.md` 的 TV-CI-06／TV-CI-07）的 `L0 依据` 列，本席无权动那张表。这一格只关引用拓扑，与本记录上面所有读数无关。
