# L0：样例记录——工具栏按钮群的可达名称（面 A1 的无障碍文本支）

- 命令：npx -y rea-agents@latest inspect-web-page http://127.0.0.1:9222 6F787E33EF3B4D3D90CF0B1327355111 --observation-ms 1500 --include-accessibility-text --filter-output evidence_id,normalized_result
- evidence_id：ev_713128c5681bbf2309f7ec4ae12868375a67f13312982f6d6f180103266b4835
- 浏览器：Edg/155.0.4283.45（protocol_version 1.3，js_version 15.5.9.4，revision 537.36 (@50f24ef2aa5369a074b8888b7db82d9c0652d642)，user_agent 含 HeadlessChrome/155.0.0.0）
- 目标 URL：http://127.0.0.1:8077/
- 观察条件：本地自研探针页 tools/rea_probe_site/（三文件，无第三方资产）；Edge --headless=new，URL 作命令行参数交给这一趟进程；未点开任何菜单、未点按任何元素、未禁用优化；观察窗 1500ms（capture_window.observation_ms=1500，非默认值）；一次一面——这一面是 A1 的无障碍文本支，旗标只开 --include-accessibility-text 这一个，四个结构旗标 --include-storage-keys／--include-storage-fingerprints／--include-json-body-shapes／--include-websocket-shapes 全关（所以本记录不引 storage 块）
- 完整性：completeness.status=policy_filtered；conditions 两项 attach_limited,policy_filtered；policy_filtered_sections 五项 console_text,json_body_shapes,script_sources,storage_keys,websocket_shapes（比 l0/probe-skeleton.md 那面的六项少一项 accessibility，正是因为本次开了 --include-accessibility-text）；attach_limited_sections 五项 console_events,metadata,network_requests,websocket_connections,websocket_frames；truncated_sections 与 unavailable_sections 都是空列表；excluded 五条 reason 全为 not_approved；同一趟里 accessibility.text_capture.status=included、retained_bytes=130、excluded_fields=0
- 探针校验和：sha256(tools/rea_probe_site/app.js 按 LF 归一) = 62ea3b375625208a69137b6c634e425c921098f45e4fbe2b3f1194a90229e52f
- 取证时间：2026-10-13T18:14:27+08:00（同一 stdout 里 capture_window.started_at 写作 2026-10-13T10:14:27.562Z、ended_at 写作 2026-10-13T10:14:29.088Z，即 UTC）

## 摘录（逐字，未改写）

下面这段是从 stdout（12,788 字节／462 行）里按行号切出来的**分段**，不是整包（本机内存只剩约 2GB，整包不进仓库）；分段之间用一行 `...` 标注被略过的部分，切取的行号区间依序是 1–32、44–46、155–160、215–220、257–263、295–301、323–349、413–427、431–441、462。格式是 REA 默认的 toon 缩进文本，不是 JSON，所以围栏标 `text`。

```text
evidence_id: ev_713128c5681bbf2309f7ec4ae12868375a67f13312982f6d6f180103266b4835
normalized_result:
  browser:
    product: Edg/155.0.4283.45
    protocol_version: "1.3"
    revision: 537.36 (@50f24ef2aa5369a074b8888b7db82d9c0652d642)
    user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0"
    js_version: 15.5.9.4
  target:
    target_id: 6F787E33EF3B4D3D90CF0B1327355111
    type: page
    title: Probe Chart
    url: "http://127.0.0.1:8077/"
    origin: "http://127.0.0.1:8077"
    attached: false
  capture_window:
    started_at: "2026-10-13T10:14:27.562Z"
    ended_at: "2026-10-13T10:14:29.088Z"
    observation_ms: 1500
  completeness:
    status: policy_filtered
    conditions[2]: attach_limited,policy_filtered
    policy_filtered_sections[5]: console_text,json_body_shapes,script_sources,storage_keys,websocket_shapes
    attach_limited_sections[5]: console_events,metadata,network_requests,websocket_connections,websocket_frames
    truncated_sections: []
    unavailable_sections: []
    excluded[5]{section,reason,count}:
      console_text,not_approved,null
      json_body_shapes,not_approved,null
      script_sources,not_approved,1
      storage_keys,not_approved,null
      websocket_shapes,not_approved,null
...
  dom:
    total_nodes: 35
    nodes[35]:
...
      - index: 18
        parent_index: 16
        node_type: 1
        node_name: BUTTON
        node_value_length: 0
        attribute_names[1]: type
...
      - index: 28
        parent_index: 11
        node_type: 1
        node_name: CANVAS
        node_value_length: 0
        attribute_names[3]: id,width,height
...
  accessibility:
    total_nodes: 20
    text_capture:
      status: included
      retained_bytes: 130
      excluded_fields: 0
    nodes[20]:
...
      - node_id: "17"
        parent_id: "12"
        role: generic
        name: ""
        description: null
        ignored: false
        states: []
...
      - node_id: "19"
        parent_id: "17"
        role: button
        name: Trend line
        description: null
        ignored: false
        states[2]{name,value}:
          focusable,true
          invalid,"false"
      - node_id: "22"
        parent_id: "17"
        role: button
        name: Fibonacci
        description: null
        ignored: false
        states[2]{name,value}:
          focusable,true
          invalid,"false"
      - node_id: "25"
        parent_id: "17"
        role: button
        name: Brush
        description: null
        ignored: false
        states[2]{name,value}:
          focusable,true
          invalid,"false"
...
  scripts:
    total: 1
    items[1]:
      - script_key: scr_4e3ecbca435a356645a9ccc67cfcf2d4a549be3af02cd344900b39d6eb3fe66f
        frame_id: 6F787E33EF3B4D3D90CF0B1327355111
        url: "http://127.0.0.1:8077/app.js"
        origin: "http://127.0.0.1:8077"
        cdp_hash: 62ea3b375625208a69137b6c634e425c921098f45e4fbe2b3f1194a90229e52f
        length: 697
        is_module: true
        language: JavaScript
        source_map_url: null
        resource_reconciliation:
          status: exact
          resource_key: res_95861a957d90ad8d4aaef2237454c953fd3779fc4f9545ee3c1b4442ecbf64ee
...
  resources[1]{resource_key,url,origin,type,mime_type,content_size}:
    res_95861a957d90ad8d4aaef2237454c953fd3779fc4f9545ee3c1b4442ecbf64ee,"http://127.0.0.1:8077/app.js","http://127.0.0.1:8077",Script,application/javascript,697
  network:
    requests: []
    websocket_connections: []
    coverage_started_at: "2026-10-13T10:14:27.562Z"
    prior_activity_available: false
  console:
    events: []
    coverage_started_at: "2026-10-13T10:14:27.562Z"
    prior_activity_available: false
...
  limitations[4]: Observation starts when REA attaches; prior network and console activity is unavailable.,"Raw network headers, bodies, cookies, storage values, console objects, and WebSocket payloads are never retained; explicitly requested primitive console text is retained verbatim, while payload captures retain value-free shapes.",Source maps are reported only as declarative URLs and are not fetched.,URL-less scripts and console events without an allowed source URL are excluded because their origin cannot be proven.
```

## 读数含义

- **这一趟存在的全部理由**：`accessibility.nodes` 里 `role: button` 出现**三**次（node_id "19"／"22"／"25"），三枚的 `parent_id` 全是 `"17"`，`name` 字面分别是 `Trend line`、`Fibonacci`、`Brush`，且各带 `states[2]{name,value}` 的 `focusable,true`＋`invalid,"false"`。spec/_example.md 那条 `TV-EX-01` 的判据（同一 `parent_id` 下数得出 ≥3 枚 `role: button`、三个 `name` 字面值）照着的就是摘录里那三坨各九行，别处没有这些读数。
- 容器只能按 **`parent_id`** 认：`node_id: "17"` 自己是一条 `role: generic`（`parent_id: "12"`、`name: ""`）；页面上它写的是 `<div id="toolbar">`（自家 `tools/rea_probe_site/index.html` 第 9 行），但 `dom` 段每个节点只给 `attribute_names`（`index 16` 那枚 DIV 与三枚 BUTTON 都是 `attribute_names[1]: type`、CANVAS 是 `attribute_names[3]: id,width,height`），**从头到尾不含属性的值**——本份 stdout 里 `grep -c toolbar` 与 `grep -c 'id='` 都是 0。所以「`id=toolbar` 的容器」这句话没有证据面，判据里不写。这条边界见 `docs/forensics/batch-A-playbook.md` §4 与 `docs/forensics/README.md` §4。
- `text_capture` 的 `status: included`／`retained_bytes: 130`／`excluded_fields: 0`，对 `l0/probe-skeleton.md` 同一面的 `not_approved`／`retained_bytes: 0`／`excluded_fields: 18`：不开旗标时可达名称整批被策略扣掉（`policy_filtered_sections` 于是多一项 `accessibility`）。⇒ 那份记录是这句话的**反面**证据，支撑不了上面那句 `name` 读数，所以样例条目不引它当依据。
- `evidence_id` 是本记录的主键，抄自 stdout 第 1 行；过滤键写成 `evidence_id,normalized_result` 就是为了它——只写 `normalized_result` 会把顶层主键一起滤掉（`README.md` §4 第 5 条）。`--token-limit` 本次没带：先不限流跑一次，确认目标键在、整份 12,788 字节，再定收口口径（`batch-A-playbook.md` §3）。
- `target_id` 是 **`target_id`**（不是 `targetId`），来自同一趟 CDP 的 `list-browser-targets`：那次 stdout（1,451 字节）第 20 行 `targets[1]{target_id,type,title,url,origin,attached}:`、第 21 行 `6F787E33EF3B4D3D90CF0B1327355111,page,Probe Chart,"http://127.0.0.1:8077/","http://127.0.0.1:8077",false`，它自己的 `evidence_id` 是 `ev_58545f5d7a4861620a56c54f784564efdd064acc03eca5a375704c92dcdb74d3`。`目标 URL：` 抄的就是那行里的 url。
- 校验和这样拿（**按 LF 算**，与校验器同口径；别用 `sha256sum`——本机 `core.autocrlf=true`，工作树里若是 CRLF 它会算出另一个值，而校验器读的是行尾归一后的字节）：
  `python -X utf8 -c 'import pathlib,hashlib;p=pathlib.Path("tools/rea_probe_site/app.js");print(hashlib.sha256(p.read_bytes().replace(b"\r\n",b"\n")).hexdigest())'`
  本趟里 REA 自己算出的 `scripts.items[1].cdp_hash` 与它同值，`length: 697` 等于 app.js 的 LF 归一字节数，`resource_reconciliation.status: exact` ⇒ 页面跑的就是这棵树里那份脚本。样例文件按精确文件名豁免审计（`L0_EXEMPT`），所以这一行不是校验器要求的，是本记录自己给的互证。
- `network.requests: []`、`console.events: []` 与两处 `prior_activity_available: false` 是 **attach 时机**造成的，不是页面没发请求：`limitations[4]` 第 1 条原文「Observation starts when REA attaches; prior network and console activity is unavailable.」。app.js 里那句 `fetch("/data.json")` 由另一面（`l0/probe-bundle.md`）的静态分析数出来，不在本面的证据范围内。
- 这一面**撑得住**：工具栏是「一组并列的可点击按钮」（同一 `parent_id`、三枚 `role: button`、`focusable,true`），以及三类画线工具各自的功能名。这一面**撑不住**：按钮的视觉样式／图标／配色（表达层，硬线 1 不碰）、容器在 DOM 里叫什么 id（属性值不在这一面）、以及任何交互之后的状态（本趟没有点按、没有派发事件）。
- 本记录**不写** `用途：` 那一行：`用途` 的合法值只有 harness／规格／基线，而样例文件按精确文件名豁免审计，不进差距矩阵、也不冒充任何第三方观察结论；它的形状改由 `tools/test_forensics_spec.py` 的 `test_live_example_files_use_the_contract_shape` 单独钉（六把必填键逐把断言 `- 〈键〉：` 在文件里）。

本记录支撑 spec/_example.md 的那条条目（`TV-EX-01`）：它是 2026-10-13 18:14（+08:00）**重新起的一趟**本地取证跑出来的，`evidence_id` 与摘录同一趟，不是把上一趟（`l0/probe-skeleton.md`，同一页不同旗标）的读数换个文件名。
