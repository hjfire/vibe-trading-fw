# L0：真实 TV 的脚本与端点面（面 A2）

- 命令：npx -y rea-agents@latest analyze-web-bundle http://127.0.0.1:9222 F15772FA4914C51205634B2CD78D8B75 --allowed-origins https://www.tradingview.com --observation-ms 2000 --filter-output evidence_id,normalized_result.observations,normalized_result.completeness --token-limit 1000
- evidence_id：ev_48b6beaa63e84708e7e6336531f2b9b3418ffb28fa2d8e72f28a3fd34d03f571
- 浏览器：Edg/155.0.4283.45（protocol_version 1.3，js_version 15.5.9.4；**本面的过滤口径里没有 browser 块**，这三个读数取自同一现场、同一 target_id 的那趟 list-browser-targets 留档 targets.txt:16-20，与 A1 那趟 stdout 第 3-8 行逐字相符）
- 目标 URL：https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL
- 留档（仓外临时件，会随清理消失）：C:\Users\fire\AppData\Local\Temp\rea-t10\a2.txt（正式趟，32 行／1,089 字节，整份已在下面贴全）；同目录 a2-count.txt（--token-count 读数＝270）
- 观察条件：Edge --headless=new ＋ 当次 `reg query` 现读到的系统代理（ProxyEnable=0x1／ProxyServer=127.0.0.1:7897）；未交互、未禁用优化、未改 UA；--observation-ms 2000；--allowed-origins 给**裸值** https://www.tradingview.com（批次清单 §0／README §4 第 2 条）；该命令不吃 `--include-*`；同一 target_id 与 A1／A4／A16／A9／A15／② 各面共用。**过滤键比批次清单 §1 表里那一行多写了 `normalized_result.completeness` 一段**——因为 §4 要求 A2 的 `完整性：` 抄 `status`＋`parse_failures`，而只切到 `observations` 的那份 stdout 里根本没有 completeness 块；与仓内 harness 记录 probe-bundle.md 同一处置，差异已写进回报
- 完整性：completeness.status=complete；parsed_scripts=1；parse_failures=0（值 0＝进了分析口的那 1 份脚本没有一份失败；它**不是**「对方所有脚本都解析成功」——见下面「脚本面被归属门拦住」那条）；visited_ast_nodes=3607
- 用途：基线
- 取证时间：2026-10-13T21:26:47+08:00（这份 filtered stdout 里没有任何时间键，时间取 stdout 落盘 mtime；同趟 `observations` 里也没有 capture_window 键）

## 摘录（逐字，未改写）

这一面的载荷只有 1,089 字节（`--token-count` 报 270 tokens），整份贴进来；格式是 REA 默认的 toon 缩进文本，不是 JSON，所以围栏标 `text`。

```text
evidence_id: ev_48b6beaa63e84708e7e6336531f2b9b3418ffb28fa2d8e72f28a3fd34d03f571
normalized_result:
  observations:
    chunks:
      nodes[1]{script_key,url,artifact_sha256,bytes}:
        scr_c97e5760ed59e5513cea09d8aee42fb517877e99ce89572a86f141567892685c,"https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL",5f652c6c1f28c91eb1999a73e4a851e7565d11d199dad53a8b31e7c3e92eb6e2,15186
      edges: []
    routes: []
    endpoints[2]:
      - value: mobileapp_new
        mechanism: "call:n.get"
        location:
          script_key: scr_c97e5760ed59e5513cea09d8aee42fb517877e99ce89572a86f141567892685c
          line: 2
          column: 353
      - value: mobileapp
        mechanism: "call:n.get"
        location:
          script_key: scr_c97e5760ed59e5513cea09d8aee42fb517877e99ce89572a86f141567892685c
          line: 2
          column: 387
    webmcp_declarations: []
    source_maps:
      status: not_requested
      requested: 0
      processed: 0
      items: []
  completeness:
    status: complete
    parsed_scripts: 1
    parse_failures: 0
    visited_ast_nodes: 3607
```

## 读数含义

**留档行号（`a2.txt`，上面就是整份）**：`evidence_id` 第 1 行；`chunks.nodes[1]` 5-6；`edges: []` 7；`routes: []` 8；`endpoints[2]` 9-21（第一条 10-15，column=353 在第 15 行；第二条 16-21，column=387 在第 21 行）；`webmcp_declarations: []` 22；`source_maps` 23-27；`completeness` 28-32。

- **这一面只归到 1 份脚本，而且原因看得见**：`chunks.nodes[1]` 那一条的 `url` 就是**页面 URL 本身**、`bytes=15186`、`artifact_sha256=5f652c6c…b6e2`——与 A1 那趟 `scripts.items[1]` 的 `length: 15186`／`cdp_hash: 5f652c6c1f28c91eb1999a73e4a851e7565d11d199dad53a8b31e7c3e92eb6e2` 逐字相同（留档 a1-full.txt:39888 是 `cdp_hash`、39889 是 `length`，见 tv-a1-page.md 的 scripts 段）。两趟互证：被静态分析的只有文档里那枚内联引导脚本（`is_module: false`）。**同一趟 A1 的 `excluded` 报 `scripts,disallowed_origin,345`**，所以「TV 图表页有多少脚本」这句话在本面撑不住；能说的只有「以单个 origin 为归属门时，可证明归属、且被分析过的脚本 1 份」。这是**写法造成的窄采集**，不是对方的页面事实（批次清单 §4「空面要先排除写法导致再读成没有」在本面的落点）。
- **`chunks.edges: []`** ⇒ 在这 1 份脚本的范围内数不出模块边。**不能**读成「TV 没有打包结构／没有 chunk 图」：图的另一半（那 345 份）根本没进采集口。
- **`routes: []`** ⇒ 本面在这 1 份脚本里没观察到路由声明。同一口径：证据范围只是那 1 份脚本。`endpoints` 非空证明观察器确实在跑（同一次调用数出了 2 条），所以「路由面为空」不是命令失败——但也升格不成「对方没有前端路由」。
- **`endpoints[2]` 两条都不是网络端点**：`mechanism` 都是 `"call:n.get"`，`value` 是 `mobileapp_new` 与 `mobileapp`，`location` 三把键 `script_key`／`line: 2`／`column: 353`（另一条 `column: 387`）。⇒ 读作「它在那份脚本的第 2 行按两个名字取了值」，是**数据需求的形状**；把它写成「TV 请求了 mobileapp 这个接口」超出证据。`line` 的口径与 A4 的 `line_number` 不同（本地探针实测：A2 的 `location.line` 是 1-based，A4 的 `location.line_number` 是 0-based，见 probe-bundle.md 与 probe-events.md），本面这两条按 1-based 读。
- `webmcp_declarations: []` ⇒ 本面没观察到页内工具声明（同样只在那 1 份脚本的范围内）。
- `source_maps.status: not_requested`、`requested: 0`、`processed: 0`、`items: []` ⇒ 这一趟没请求 source map；「对方的 source map 是什么」在本批次没有任何证据面。
- `completeness.status: complete`＋`parsed_scripts: 1`＋`parse_failures: 0`＋`visited_ast_nodes: 3607` 是本面 completion 的全部键（逐键照抄，本趟没有 `excluded`／`dropped_events` 这两把键，A2 的 completeness 块比 A1 的小）。**这一面没有出现任何脚本源码文本**：`nodes[]` 那一条只有 `script_key`／`url`／`artifact_sha256`／`bytes` 四把键（该命令的输出形状里就没有 source 段），符合合规硬线 1。
- 体积闸门：`--token-count` 那一趟报 270 tokens，正式趟用 `--token-limit 1000`（留足余量，原因见 tv-a1-page.md 里那条「count 报的数是下界」的实测），EOF 无 `[truncated:` 标记，读数完整。
- 命令行那条腿无盘可验（2026-10-14 终席披露，源自最终评审席 B 的 B-I-1；按只追加纪律写在文件末尾，头部各行行号照旧可达。这条讲的是 `命令：`／`留档：` 那两行）：本机 `/tmp/rea-t10/` 里**没有本趟的 `.cmd` 留档**——本席现量 `ls /tmp/rea-t10/*.cmd | wc -l`＝**0**（同目录其它件 55 个；对照 `rea-t10b`＝11、`rea-t10c`＝6、`rea-t11b`＝11），「命令行要落盘」是 `forensics/batch-A-playbook.md` §7 后来补的纪律，这批跑在它之前 ⇒ 上面 `命令：` 是操作者终端转录，**无法从盘上逐字复原**。另两条腿本席现跑仍可机验：`sed -n '1p' /tmp/rea-t10/a2.txt` 逐字＝本记录 `evidence_id：` 那串（`ev_48b6beaa63e84708e7e6336531f2b9b3418ffb28fa2d8e72f28a3fd34d03f571`）；摘录围栏内每一非省略号的整行片段在该留档上逐字命中 **32/32**（本面是「整份贴全」，分母＝留档自身 32 行；席 B 的 16/16 是条目级 needle 口径）。本记录 `浏览器：` 那一键另有一处同源披露（取自同一现场、同一 `target_id` 的挂载趟 `targets.txt:16-20`），口径见 `forensics/README.md` §2。**不必重跑**：重跑拿不回同一趟。
