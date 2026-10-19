# L0：真实 TV 图表页骨架（面 A1）

- 命令：npx -y rea-agents@latest inspect-web-page http://127.0.0.1:9222 F15772FA4914C51205634B2CD78D8B75 --allowed-origins https://www.tradingview.com --observation-ms 1500 --include-accessibility-text --include-json-body-shapes --include-websocket-shapes --filter-output evidence_id,normalized_result --token-limit 400000
- evidence_id：ev_c9e4190b222fc937f0ddefc334ac5107c0640c881543ab83c65f93ff741bbf46
- 浏览器：Edg/155.0.4283.45（protocol_version 1.3，js_version 15.5.9.4，revision 537.36 (@50f24ef2aa5369a074b8888b7db82d9c0652d642)；本趟 stdout 第 3-8 行自带 browser 块，与同一现场 list-browser-targets 留档 targets.txt:16-20 逐字相符）
- 目标 URL：https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL
- 留档（仓外临时件，会随清理消失）：C:\Users\fire\AppData\Local\Temp\rea-t10\a1-full.txt（正式趟，40,422 行／1,042,800 字节）；同目录 a1-truncated.txt（被体积闸门切在半截的第一趟）、a1-count.txt（--token-count 那一行读数）、targets.txt（挂载趟）
- 观察条件：Edge --headless=new，`--proxy-server` 指向当次 `reg query` 现读到的系统代理（ProxyEnable=0x1／ProxyServer=127.0.0.1:7897）；URL 作为 Edge 命令行参数交出；未点按任何元素、未派发事件、未禁用优化、未改 UA；观察窗 observation_ms=1500；本面只开三把旗标（accessibility-text／json-body-shapes／websocket-shapes），`--include-script-sources` 与 `--include-console-text` 按批次清单 §2 不开；一次一面——本条只有 A1，storage 面在 tv-a16-storage.md 另起一趟
- 完整性：completeness.status=policy_filtered；conditions[2]=attach_limited,policy_filtered；policy_filtered_sections[7]=console_events,console_text,metadata,resources,script_sources,scripts,storage_keys；attach_limited_sections[5]=console_events,metadata,network_requests,websocket_connections,websocket_frames；truncated_sections 与 unavailable_sections 都是空列表；excluded[9] 的 reason 分布＝disallowed_origin（metadata 488、resources 679、scripts 345、console_events 4）＋unsupported_url（resources 37）＋unattributed_origin（console_events 1）＋not_approved（console_text、script_sources、storage_keys，count 均为 null）；dropped_events 七类计数全 0；本面 stdout 里没有 parse_failures 这个键（它是 A2 那面的键，见 tv-a2-bundle.md），所以本记录不解释它的值
- 用途：规格
- 取证时间：2026-10-13T21:24:33+08:00（留档落盘 mtime；同一 stdout 里 capture_window.started_at 写作 2026-10-13T13:24:31.613Z、ended_at 13:24:33.390Z，即 UTC）

## 摘录（逐字，未改写）

下面这段是从 1,042,800 字节的留档里按行号切出来的**分段**（`a1-full.txt`，行号见本节末与「读数含义」）；分段之间用一行 `...` 标注被略过的部分。第 12 行 `title:` 是页面自报的当次报价标题，**故意不转录**（它是瞬时行情值，不是任何判据的依据），只在此说明它存在于 `a1-full.txt:12`。格式是 REA 默认的 toon 缩进文本，不是 JSON，所以围栏标 `text`。

```text
evidence_id: ev_c9e4190b222fc937f0ddefc334ac5107c0640c881543ab83c65f93ff741bbf46
normalized_result:
  browser:
    product: Edg/155.0.4283.45
    protocol_version: "1.3"
    revision: 537.36 (@50f24ef2aa5369a074b8888b7db82d9c0652d642)
    js_version: 15.5.9.4
  target:
    target_id: F15772FA4914C51205634B2CD78D8B75
    type: page
...
    url: "https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL"
    origin: "https://www.tradingview.com"
    attached: false
  capture_window:
    started_at: "2026-10-13T13:24:31.613Z"
    ended_at: "2026-10-13T13:24:33.390Z"
    observation_ms: 1500
  completeness:
    status: policy_filtered
    conditions[2]: attach_limited,policy_filtered
    policy_filtered_sections[7]: console_events,console_text,metadata,resources,script_sources,scripts,storage_keys
    attach_limited_sections[5]: console_events,metadata,network_requests,websocket_connections,websocket_frames
    truncated_sections: []
    unavailable_sections: []
    excluded[9]{section,reason,count}:
      console_events,disallowed_origin,4
      console_events,unattributed_origin,1
      console_text,not_approved,null
      metadata,disallowed_origin,488
      resources,disallowed_origin,679
      resources,unsupported_url,37
      script_sources,not_approved,1
      scripts,disallowed_origin,345
      storage_keys,not_approved,null
...
  frames[1]{frame_id,parent_frame_id,url,origin}:
    F15772FA4914C51205634B2CD78D8B75,null,"https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL","https://www.tradingview.com"
  dom:
    total_nodes: 4232
    nodes[4232]:
...
      - index: 1786
        parent_index: 1520
        node_type: 1
        node_name: CANVAS
        node_value_length: 0
        attribute_names[5]: data-name,aria-hidden,width,height,style
...
  accessibility:
    total_nodes: 2018
    text_capture:
      status: included
      retained_bytes: 7906
      excluded_fields: 0
    nodes[2018]:
...
      - node_id: "1350"
        parent_id: "1349"
        role: toolbar
        name: ""
...
      - node_id: "1173"
        parent_id: "1172"
        role: button
        name: 1 day
        description: null
        ignored: false
        states[3]{name,value}:
          focusable,true
          hasPopup,menu
          invalid,"false"
...
  scripts:
    total: 1
    items[1]:
...
        is_module: false
        language: JavaScript
        source_map_url: null
        resource_reconciliation:
          status: unmatched
          reason: no_exact_sanitized_url
        source:
          included: false
          reason: source capture was not selected
  resources: []
  network:
    requests: []
    websocket_connections: []
    coverage_started_at: "2026-10-13T13:24:31.613Z"
    prior_activity_available: false
  console:
    events: []
    prior_activity_available: false
  workers: []
...
  storage:
    local_storage_keys: []
    session_storage_keys: []
    content_fingerprints: []
    fingerprints_complete: false
    values_redacted: true
...
  limitations[4]: Observation starts when REA attaches; prior network and console activity is unavailable.,"Raw network headers, bodies, cookies, storage values, console objects, and WebSocket payloads are never retained; explicitly requested primitive console text is retained verbatim, while payload captures retain value-free shapes.",Source maps are reported only as declarative URLs and are not fetched.,URL-less scripts and console events without an allowed source URL are excluded because their origin cannot be proven.
```

## 读数含义

**留档行号（`grep -n` 可反查，文件＝`%TEMP%\rea-t10\a1-full.txt`）**：`evidence_id` 第 1 行；browser 块 3-8；target 块 9-15（12 是未转录的 `title`）；capture_window 16-19；completeness 20-45；frames 46-47；dom 头 48-49；CANVAS 节点样本 10767-10772；accessibility 头 25443-25449；`role: toolbar` 节点 25669-25672（另五枚的条目起点在 25790、25812、27568、28206、31482）；`name: 1 day` 节点 27319-27328；scripts 段 39881-39898；resources/network/console/workers 39899-39909；storage 段 40410-40421；limitations[4] 第 40422 行（文件末行）。

- **挂载是这一面最硬的读数**：`target_id` 就叫 `target_id`（不是 `targetId`），本面与 A2／A4／A16／A9／A15／A3／A5／A7／A8 共用同一趟 `list-browser-targets` 的那一个（targets 留档 `targets.txt:21-22`）。`frames[1]` 只有一帧，`parent_frame_id: null`，且 frame_id 与 target_id 同值 ⇒ 观察窗内**没有第二个 document 帧**被枚举到（注意：这是「本趟枚举到一帧」，不等于「页面上只有 iframe 存在」——`excluded` 里 metadata／resources 的大计数说明窗外资源本来就不在归属证明范围内）。
- **体积闸门的实测形状（本面撞出来的，写死给后续）**：`--token-count` 那一趟报 263,000（`a1-count.txt:1`），正式第一趟用这个数当 `--token-limit`，结果 stdout 停在 `a1-truncated.txt:37373` 的 `[truncated: showing tokens 0–263000 of 284654]`——**真实载荷 284,654 tokens，比量到的多约 8%**，因为 accessibility 是活树、两趟之间会长。被切掉的不只是 accessibility 枚举的后半段（`nodes[2018]` 只数到约 2,622 号节点），还包括**它后面的整段 network／console／workers／metadata／storage／limitations**。所以本记录引用的是同一条命令把闸门放宽到 400,000 的第二趟，那份 EOF 没有 truncated 标记。**结论形状：`--token-count` 报的数是下界，不是目标数。**
- **`dom` 只给属性名，不给属性值**（批次清单 §3②／§4 的第一条，本面复验成立）：`attribute_names[5]: data-name,aria-hidden,width,height,style` 就是那枚 CANVAS 节点的全部属性**名字**清单，没有任何属性值出现在 stdout 里。⇒ 从这一面只能指认标签级／角色级事实与「这一格挂着某个属性」，**指认不了**「某个 id／class 是什么值」，所以 L1 里「对方有个 id 叫 …」这种句子在本面没有证据面。
- **本面撑得住的节点形状结论**（计数都是在留档上重跑一条只读命令得到的，命令写在句子后面，可按行号窗口复跑）：
  - `dom.total_nodes: 4232`；`accessibility.total_nodes: 2018`，且 `text_capture.status: included`、`retained_bytes: 7906`、`excluded_fields: 0` ⇒ 这一趟开了无障碍文本旗标，可达名称**没有**被策略扣掉（对照本地探针那份 `not_approved`／`excluded_fields: 18`）。
  - 标签分布：`sed -n '48,25442p' a1-full.txt | grep -o 'node_name: .*' | sort | uniq -c` ⇒ `DIV` 1223、`SPAN` 889、`#text` 627、`LINK` 418、`path` 322、`svg` 224、`BUTTON` 202、`SCRIPT` 63、`CANVAS` **20**、`IMG` 22、`INPUT` 0（词表里没有 INPUT 这一项）。
  - 角色分布：`sed -n '25443,39880p' a1-full.txt | grep -o 'role: .*' | sort | uniq -c` ⇒ `none` 766、`generic` 404、`InlineTextBox` 312、`StaticText` 285、`button` **96**、`image` 33、`group` 25、`log` 20、`list` 20、`LayoutTableCell` 12、`Canvas` 11、`separator` 8、`toolbar` **6**、`link` 5。
  - 「工具栏有几组」这句在本面的形状是：6 枚 `role: toolbar` 节点（条目起点 25669／25790／25812／27568／28206／31482），**六枚的 `name` 都是空串**（25672／25793／25815／27571／28209／31485），且每一枚都带一条 `states[1]{name,value}: orientation,<横向或纵向>`（vertical＝25675-25676 的 1350、27574-27575 的 1976；其余四枚 horizontal）。再数一层父子：`parent_id` 归一后**只有 `node_id: "1976"` 那一枚 toolbar 直接挂着按钮**——它 14 个子节点里 10 个是 `role: button`（第一条按钮条目在 28249-28252），另外五枚 toolbar 的直接子节点是 1-2 个、且都不是 button。⇒ 能说的是「六组工具栏、两组自报纵向、其中纵向的 1976 那组直接挂着 10 枚按钮」，**不能**说「第 N 组是画线工具栏」——空 `name` 上没有可引用的功能名，那一层要靠 ② 交互面各自的记录（tv-a3／a5／a7／a8）。
  - 「按钮是怎么成组的」：把 `role: button` 的 `parent_id` 计数（`sed -n '25443,39880p' a1-full.txt | grep -B1 'role: button$' | grep parent_id | sort | uniq -c`）⇒ 最大一组 10 枚共享 `parent_id: "1976"`（上面那枚纵向 toolbar），其后是 4 枚（1757）、三组各 3 枚（4228／2071／1246）、五组各 2 枚（16／1584／1473／1215／1155），其余单枚；这 96 枚里带 `pressed` 状态的 28 枚、带 `hasPopup,menu` 的 9 枚。`1976` 那一组是右侧竖排功能按钮（同一 `parent_id` 下的 `name` 里有 `Alerts`、`Object tree and data window` 等，见 28260-28272 窗口）。
- **② 交互面的点哪一枚，是从这份读数里选的**：`- node_id: "1173"` 那枚 `role: button` 的 `name: 1 day` 带 `states[3]` 里的 **`hasPopup,menu`**（27319-27328）。⇒ 它是「点了会弹菜单」的控件，被 A5 那趟用作 `locator{kind:role,role:button,name:"1 day"}`。同一留档里带 `hasPopup,menu` 的按钮共 9 枚（`Date Range`、`Layout setup`、`Take a snapshot`、`1 day`、`Candles`、`Indicator templates`、`Manage layouts`、`Products`，外加一枚 `name: ""`）——**这一句是「有哪些弹窗型按钮」的读数，不是「点开了什么」的读数**，后者只在各交互面自己的记录里。
- **两个 shape 面为空，而且空的原因不是命令失败**：`network.requests: []`、`network.websocket_connections: []`、`console.events: []`，且两段都带 `prior_activity_available: false`，`coverage_started_at` 等于 `capture_window.started_at`；limitations 第 1 条原文「Observation starts when REA attaches; prior network and console activity is unavailable.」⇒ `--include-json-body-shapes`／`--include-websocket-shapes` 这两把旗标本面**没有产出可引用的形状**，因为 REA 是挂在已加载完的页上、观察窗只有 1500ms。这是「attach 时机造成的空」，**不许读成「TV 没有 websocket／json 形状」**（批次清单 §4 那条「没报≠没有」在本面复验）。
- **脚本面被归属门拦住，读数本身要说清**：`scripts.total: 1`（唯一那枚 `script_key: scr_c97e5760…685c`、`url` 就是页面 URL 本身、`length: 15186`、`is_module: false`、`resource_reconciliation.status: unmatched`／`reason: no_exact_sanitized_url`、`source.included: false`）；同一趟 `excluded` 里 `scripts,disallowed_origin,345`、`resources: []`、`metadata` 段 `dom_urls[494]` 的绝大多数 `destination_scope: outside_policy`（留档 40406 行附近，`excluded_dom_urls: 488` 在第 40408 行）。⇒ 「TV 图表页有多少脚本」这句话在本面**撑不住**：本面只证明了「能证明归属的脚本有 1 枚，345 枚被 origin 门扣掉」，扣掉的成因是**我方给的 `--allowed-origins` 只有一个裸 origin**（批次清单 §4「空面要先排除写法导致再读成没有」在本面的具体落点）。
- **storage 段在本面是空的，而且空得有原因**：`storage.local_storage_keys: []`、`session_storage_keys: []`、`content_fingerprints: []`、`fingerprints_complete: false`、`values_redacted: true`，而同一趟 `policy_filtered_sections[7]` 里就含 `storage_keys`、`excluded` 里含 `storage_keys,not_approved,null` ⇒ 本面没开 storage 两把旗标（旗标在 A16 那一趟开），所以**这一句不能读成「对方没有存储键」**；键名读数见 `tv-a16-storage.md`。同一趟 `storage.usage_bytes: 1167837`／`quota_bytes: 401094222642` 是配额读数，本面不提它作任何判据。
- `policy_filtered` 是 REA 自己的策略门（`excluded` 的 reason 是 `not_approved`／`disallowed_origin`／`unsupported_url`／`unattributed_origin`），不是解析失败；本面 completeness 里没有解析失败计数键（那把键在 A2 那面）。
- **2026-10-13 22:20 更正：本记录的 `evidence_id` 原先写的是 `ev_2a7703ec…0b8358d`，那是被体积闸门切在半截的第一趟**（`a1.txt`＝`a1-truncated.txt`，965,225 字节）的键，而上面所有摘录与行号都来自放宽闸门后的第二趟 `a1-full.txt`（1,042,800 字节／40,422 行）。两个键不是一趟的，属于「转述自另一趟的键挂在本趟头上」那类错。判据是机械的：`sed -n '1p' a1-full.txt` ＝ `evidence_id: ev_c9e4190b222fc937f0ddefc334ac5107c0640c881543ab83c65f93ff741bbf46`，本记录的键与摘录首行现已改成这个值；`grep -c` 在 `a1-full.txt` 里数 `ev_2a7703ec` 得 **0**。第一趟的那把键从此不再被本记录引用（它的 `[truncated: …]` 读数仍在上一那条里作为闸门教训被引用，那是留档 `a1-truncated.txt:37373` 的行号，与键无关）。
- 本记录的命令没有 `--token-limit` 之外的收口花活：`--filter-output` 按批次清单 §3① 写成 `evidence_id,normalized_result`，主键与摘录同源（第一行就是 `evidence_id`）。
- 命令行那条腿无盘可验（2026-10-14 终席披露，源自最终评审席 B 的 B-I-1；按只追加纪律写在文件末尾，不动上面任何一行、上面的行号坐标因此全部照旧可达。这条讲的是头部 `命令：`／`留档：` 那两行）：本机 `/tmp/rea-t10/` 里**没有本趟的 `.cmd` 留档**——本席现量 `ls /tmp/rea-t10/*.cmd | wc -l`＝**0**（同目录其它件 55 个；对照 `rea-t10b`＝11、`rea-t10c`＝6、`rea-t11b`＝11，那三批都落盘了），「命令行要落盘」是 `forensics/batch-A-playbook.md` §7 后来补的纪律，这批跑在它之前 ⇒ 上面 `命令：` 那一条是操作者终端转录，**无法从盘上逐字复原**。另两条腿本席现跑仍可机验：`sed -n '1p' /tmp/rea-t10/a1-full.txt` 逐字＝本记录 `evidence_id：` 那串（`ev_c9e4190b222fc937f0ddefc334ac5107c0640c881543ab83c65f93ff741bbf46`）；摘录围栏内每一非省略号的整行片段在该留档上逐字命中 **95/95**（本席口径＝围栏行作 needle 做子串判定；席 B 报的 69/69 是条目级 needle 口径，分母不同、结论同向）。**不必重跑**：重跑拿不回同一趟（新主键会不一样），这一条腿只能永久标注为转录。
