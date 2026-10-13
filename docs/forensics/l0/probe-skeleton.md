# L0：探针页骨架（面 A1）

- 命令：npx -y rea-agents@latest inspect-web-page http://127.0.0.1:9222 437D7000A067F60AC4103AE26B62F9A4 --filter-output evidence_id,normalized_result
- evidence_id：ev_d2a92fc3d71f5017d1e6994e80c921216fddfabfbd2d3eb0d0ae00cad576cf73
- 浏览器：Edg/155.0.4283.45（protocol_version 1.3，js_version 15.5.9.4，revision 537.36，user_agent 含 HeadlessChrome/155.0.0.0）
- 目标 URL：http://127.0.0.1:8077/
- 观察条件：本地自研探针页 tools/rea_probe_site/（三文件，无第三方资产）；Edge --headless=new；未点开任何菜单、未点按任何元素；未禁用优化；观察窗 500ms（capture_window.observation_ms=500，默认值）
- 完整性：completeness.status=policy_filtered；conditions=attach_limited,policy_filtered；policy_filtered_sections 六项 accessibility,console_text,json_body_shapes,script_sources,storage_keys,websocket_shapes；attach_limited_sections 五项 console_events,metadata,network_requests,websocket_connections,websocket_frames；truncated_sections 与 unavailable_sections 都是空列表；excluded 六条 reason 全为 not_approved
- 用途：harness
- 探针校验和：sha256(tools/rea_probe_site/app.js 按 LF 归一) = 62ea3b375625208a69137b6c634e425c921098f45e4fbe2b3f1194a90229e52f
- 取证时间：2026-10-13T17:03:45+08:00（同一 stdout 里 capture_window.started_at 写作 2026-10-13T09:03:45.589Z，即 UTC）

## 摘录（逐字，未改写）

下面这段是从 stdout 里按行号切出来的**分段**，不是整包（本机内存只剩约 2GB，整包 12,776 字节不进仓库）；分段之间用一行 `...` 标注被略过的部分。格式是 REA 默认的 toon 缩进文本，不是 JSON，所以围栏标 `text`。

```text
evidence_id: ev_d2a92fc3d71f5017d1e6994e80c921216fddfabfbd2d3eb0d0ae00cad576cf73
normalized_result:
  browser:
    product: Edg/155.0.4283.45
    protocol_version: "1.3"
    revision: 537.36 (@50f24ef2aa5369a074b8888b7db82d9c0652d642)
    user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0"
    js_version: 15.5.9.4
  target:
    target_id: 437D7000A067F60AC4103AE26B62F9A4
    type: page
    title: Probe Chart
    url: "http://127.0.0.1:8077/"
    origin: "http://127.0.0.1:8077"
    attached: false
...
  capture_window:
    started_at: "2026-10-13T09:03:45.589Z"
    ended_at: "2026-10-13T09:03:46.107Z"
    observation_ms: 500
...
  completeness:
    status: policy_filtered
    conditions[2]: attach_limited,policy_filtered
    policy_filtered_sections[6]: accessibility,console_text,json_body_shapes,script_sources,storage_keys,websocket_shapes
    attach_limited_sections[5]: console_events,metadata,network_requests,websocket_connections,websocket_frames
    truncated_sections: []
    unavailable_sections: []
    excluded[6]{section,reason,count}:
      accessibility,not_approved,18
      console_text,not_approved,null
      json_body_shapes,not_approved,null
      script_sources,not_approved,1
      storage_keys,not_approved,null
      websocket_shapes,not_approved,null
...
  dom:
    total_nodes: 35
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
      status: not_approved
      retained_bytes: 0
      excluded_fields: 18
    nodes[20]:
...
  scripts:
    total: 1
    items[1]:
      - script_key: scr_4e3ecbca435a356645a9ccc67cfcf2d4a549be3af02cd344900b39d6eb3fe66f
        frame_id: 437D7000A067F60AC4103AE26B62F9A4
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
        source:
          included: false
          reason: source capture was not selected
...
  resources[1]{resource_key,url,origin,type,mime_type,content_size}:
    res_95861a957d90ad8d4aaef2237454c953fd3779fc4f9545ee3c1b4442ecbf64ee,"http://127.0.0.1:8077/app.js","http://127.0.0.1:8077",Script,application/javascript,697
```

## 读数含义

- target_id 是 **`target_id`**（不是 `targetId`），由同一趟的 `list-browser-targets` 给出：那次 stdout 第 21 行是 `targets[1]{target_id,type,title,url,origin,attached}:`，第 22 行是 `437D7000A067F60AC4103AE26B62F9A4,page,Probe Chart,"http://127.0.0.1:8077/","http://127.0.0.1:8077",false`；A1／A2／A4 三条命令共用这一个 id。该趟第 1 行是它自己的 `evidence_id: ev_f001598be5bb1a754ad2cc8b082e03784678b0563da8adcc7337b0388afd4090`。
- **`--filter-output normalized_result` 会把顶层 `evidence_id` 一起滤掉**（实测：那一趟的 stdout 第一行直接是 `normalized_result:`，全文没有 `evidence_id` 字样），而 L0 记录的主键就是 `evidence_id`。所以本记录的命令把过滤键写成 `evidence_id,normalized_result` —— 这条是本计划要收口的第五个实测坑。
- `policy_filtered` 不是解析失败：它是 REA 自己的策略门（六条 `excluded` 的 reason 全是 `not_approved`，`accessibility,not_approved,18` 就是 18 个可达文本字段被扣下）。A1 这一面的 completeness 块里也没有任何解析失败计数键——那份键在 A2（脚本面）才出现，本记录不提它的值，因为本趟这一面确实没有它。
- 这一面撑得住的骨架结论：`dom.total_nodes: 35`，全文里 `node_name: BUTTON` 出现**三**次（index 18／21／24，摘录只切了 index 18 那一条作形状样本，另两条同形状被略过），
  一枚 `CANVAS`（index 28，`attribute_names[3]: id,width,height`）、一枚 `P`（`attribute_names[1]: id`）、一枚 `H1`、一枚 `SCRIPT`（`attribute_names[2]: type,src`）。
- 这一面撑不住的结论：按钮上的**文案**。`accessibility.text_capture.status: not_approved`、`retained_bytes: 0`、`excluded_fields: 18` ⇒ 可达名称整批被策略扣掉，所以「工具栏有几枚按钮」有证据，「按钮上写着什么」没有。文案要另开一面（点开／授权后复捕），不能从这份记录里推。
- `scripts.items[1].cdp_hash` 与本记录的探针校验和同值（`62ea3b37…e52f`），`length: 697` 与工作树 app.js 的 LF 归一字节数一致，`resource_reconciliation.status: exact` ⇒ 页面里跑的就是这棵树里那份脚本，没有中间层。
- `network.requests: []` 与 `console.events: []` 是** attach 时机**造成的，不是页面没发请求：limitations 第 1 条原文「Observation starts when REA attaches; prior network and console activity is unavailable.」。同一趟的 A2（`analyze-web-bundle`）就看到了 `fetch("/data.json")`。
- 校验和这样拿（**按 LF 算**，与校验器同口径；别用 `sha256sum`——本机 `core.autocrlf=true`，工作树里是 CRLF，它会算出另一个值，而校验器读的是行尾归一后的字节）：
  `python -X utf8 -c 'import pathlib,hashlib;p=pathlib.Path("tools/rea_probe_site/app.js");print(hashlib.sha256(p.read_bytes().replace(b"\r\n",b"\n")).hexdigest())'`
- **这一串是反编造针**：没在这棵树上真跑过的人抄不出来；改过 app.js 也会让它失效，从而暴露旧证据。本趟里 REA 自己算出的三处指纹（本面的 `cdp_hash`、A2 的 `artifact_sha256`、A4 的 `source.sha256`＋`producer_hash`）都等于它，是互证。
