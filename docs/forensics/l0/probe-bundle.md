# L0：探针页脚本与端点面（面 A2）

- 命令：npx -y rea-agents@latest analyze-web-bundle http://127.0.0.1:9222 437D7000A067F60AC4103AE26B62F9A4 --observation-ms 1500 --allowed-origins http://127.0.0.1:8077 --filter-output evidence_id,normalized_result.observations,normalized_result.completeness
- evidence_id：ev_dc437f89448ceca96521af2ddabab88c5de46c7bef415cc3c087604ddf05aedc
- 浏览器：Edg/155.0.4283.45（protocol_version 1.3，js_version 15.5.9.4，同一趟 list-browser-targets 的读数）
- 目标 URL：http://127.0.0.1:8077/
- 观察条件：本地自研探针页 tools/rea_probe_site/；Edge --headless=new；未交互、未禁用优化；--observation-ms 1500；--allowed-origins 给裸值 http://127.0.0.1:8077（写 JSON 数组字面量会被拒）；同一 target_id 与 A1／A4 共用
- 完整性：completeness.status=complete；parsed_scripts=1；parse_failures=0；visited_ast_nodes=157
- 用途：harness
- 探针校验和：sha256(tools/rea_probe_site/app.js 按 LF 归一) = 62ea3b375625208a69137b6c634e425c921098f45e4fbe2b3f1194a90229e52f
- 取证时间：2026-10-13T17:04:44+08:00（这份 filtered stdout 里没有 capture_window 键，时间取 stdout 落盘的 mtime）

## 摘录（逐字，未改写）

这一面的载荷只有 850 字节，整份贴进来；格式是 REA 默认的 toon 缩进文本，不是 JSON，所以围栏标 `text`。

```text
evidence_id: ev_dc437f89448ceca96521af2ddabab88c5de46c7bef415cc3c087604ddf05aedc
normalized_result:
  observations:
    chunks:
      nodes[1]{script_key,url,artifact_sha256,bytes}:
        scr_4e3ecbca435a356645a9ccc67cfcf2d4a549be3af02cd344900b39d6eb3fe66f,"http://127.0.0.1:8077/app.js",62ea3b375625208a69137b6c634e425c921098f45e4fbe2b3f1194a90229e52f,697
      edges: []
    routes: []
    endpoints[1]:
      - value: /data.json
        mechanism: "call:fetch"
        location:
          script_key: scr_4e3ecbca435a356645a9ccc67cfcf2d4a549be3af02cd344900b39d6eb3fe66f
          line: 23
          column: 23
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
    visited_ast_nodes: 157
```

## 读数含义

- `observations` 下本趟实际出现的键名，逐个照抄：`chunks`（其内 `nodes[1]{script_key,url,artifact_sha256,bytes}` 与 `edges`）、`routes`、`endpoints`、`webmcp_declarations`、`source_maps`（其内 `status`/`requested`/`processed`/`items`）。completeness 块本面出现的是 `status`、`parsed_scripts`、`parse_failures`、`visited_ast_nodes` 四把键。
- **端点面非空**：`endpoints[1]` 一条，`value: /data.json`、`mechanism: "call:fetch"`、`location` 三把键 `script_key`／`line: 23`／`column: 23`。这条就是 app.js 第 23 行 `const response = await fetch("/data.json");`——`line` 与工作树的 1-based 行号一致，`column` 是 0-based（23 正好是标识符 `fetch` 的起始列）。
- **路由面为空**：`routes: []`。解释只取本面与仓内的依据：`tools/rea_probe_site/index.html` 只有一个静态页面、`app.js` 里没有任何路由机制（无 `history.pushState`／`replaceState`、无 hash 变更、只有一个 URL），所以路由观察器数不出条目。本面 stdout 里**没有** `frames` 这个键——一帧那件事是 A1（`inspect-web-page`）那一面的读数，见 `probe-skeleton.md`，不在这里引。这是「目标确实没有这个面」，不是命令失败（同一次调用在同一次里就把端点面数出来了）。
- `chunks.edges: []` 同理：app.js 是单个 ES module，不 import 任何东西，所以模块图是一条节点、零条边。
- `webmcp_declarations: []`、`source_maps.status: not_requested`：这一面没请求 source map，也没声明页内工具。
- `nodes[1]` 那一条里 `artifact_sha256` = `62ea3b37…e52f`，`bytes=697`，与本记录的探针校验和／工作树 LF 归一字节数逐一相符 ⇒ 被分析的脚本就是这棵树里的那份，没有第二份拷贝。
- **与 pre-probe 读数的分歧（照实记）**：控制器在写执行期更正时预探针实测的是 `routes: []` 且 `endpoints: []`。本趟两条命令（brief 原样的 `--filter-output normalized_result.observations` 与本文这条加了 `evidence_id`／`completeness` 的变体）都稳定给出 `endpoints[1]`，`routes` 才为空。本记录以本趟 stdout 为准，不迁就上文。可能的成因（**未验证，只是猜测，留给后续复跑判定**）：`--allowed-origins` 那一笔的写法——若当时给的是 JSON 数组字面量而不是裸值，脚本 origin 证明不了，AST 就不大会跑，端点面自然空。
- 校验和这样拿（**按 LF 算**，与校验器同口径）：
  `python -X utf8 -c 'import pathlib,hashlib;p=pathlib.Path("tools/rea_probe_site/app.js");print(hashlib.sha256(p.read_bytes().replace(b"\r\n",b"\n")).hexdigest())'`
- 这一串是反编造针：没在这棵树上真跑过的人抄不出来；改过 app.js 也会让它失效，从而暴露旧证据。
