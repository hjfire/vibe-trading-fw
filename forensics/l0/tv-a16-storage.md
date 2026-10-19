# L0：真实 TV 的存储键与内容指纹面（面 A16）

- 命令：npx -y rea-agents@latest inspect-web-page http://127.0.0.1:9222 F15772FA4914C51205634B2CD78D8B75 --allowed-origins https://www.tradingview.com --observation-ms 1500 --include-storage-keys --include-storage-fingerprints --filter-output evidence_id,normalized_result --token-limit 400000
- evidence_id：ev_96e65a0561f3da4489dbf03f41db8d56e7c73624c4dbaaf3fb8a0df25b022a70
- 浏览器：Edg/155.0.4283.45（protocol_version 1.3，js_version 15.5.9.4，revision 537.36 (@50f24ef2aa5369a074b8888b7db82d9c0652d642)；本趟 stdout 第 3-8 行自带 browser 块，与同一现场 list-browser-targets 留档 targets.txt:16-20 逐字相符）
- 目标 URL：https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL
- 留档（仓外临时件，会随清理消失）：C:\Users\fire\AppData\Local\Temp\rea-t10\a16.txt（正式趟，41,220 行／1,063,091 字节）；同目录 a16-count.txt（--token-count 读数＝288,917）
- 观察条件：Edge --headless=new ＋ 当次现读到的系统代理 127.0.0.1:7897；未交互、未点按、未禁用优化、未改 UA；观察窗 observation_ms=1500；本面**只开两把 storage 旗标**（`--include-storage-keys`＋`--include-storage-fingerprints`），不开 accessibility-text／json-body-shapes／websocket-shapes，`--include-script-sources` 与 `--include-console-text` 按批次清单 §2 写死不开；与 A1 **分趟**（各自主键，见 §1 末尾那条 GC7 理由）；值一律不落（`values_redacted: true` 在本趟 stdout 里自证）
- 完整性：completeness.status=policy_filtered；conditions[2]=attach_limited,policy_filtered；policy_filtered_sections[9]=accessibility,console_events,console_text,json_body_shapes,metadata,resources,script_sources,scripts,websocket_shapes；attach_limited_sections[5]=console_events,metadata,network_requests,websocket_connections,websocket_frames；truncated_sections 与 unavailable_sections 都是空列表；excluded[11] 的 reason 分布＝disallowed_origin（metadata 489、resources 679、scripts 345、console_events 4）＋unsupported_url（resources 37）＋unattributed_origin（console_events 1）＋not_approved（console_text、script_sources、accessibility 计 1305 个字段、json_body_shapes、websocket_shapes）；dropped_events 七类计数全 0；本面 stdout 里没有 parse_failures 键（那把键属 A2 面）
- 用途：规格
- 取证时间：2026-10-13T21:32:31+08:00（留档落盘 mtime；同一 stdout 里 capture_window.started_at 写作 2026-10-13T13:32:29.633Z、ended_at 13:32:31.462Z，即 UTC）

## 摘录（逐字，未改写）

从 1,063,091 字节的留档（`a16.txt`）里按行号切出来的**分段**，分段之间用一行 `...` 标注被略过的部分；行号写在「读数含义」开头。本面与存储无关的那 4 万行 DOM／accessibility 枚举一律不切（那是 A1 那趟的面）。键名是证据、值不是证据：`local_storage_keys[20]` 那条整行只含键名（REA 的 help 原文就是 *without values*），`content_fingerprints[]` 每条只有两个 sha256 与 `complete` 布尔位。

```text
evidence_id: ev_96e65a0561f3da4489dbf03f41db8d56e7c73624c4dbaaf3fb8a0df25b022a70
...
  completeness:
    status: policy_filtered
    conditions[2]: attach_limited,policy_filtered
    policy_filtered_sections[9]: accessibility,console_events,console_text,json_body_shapes,metadata,resources,script_sources,scripts,websocket_shapes
    attach_limited_sections[5]: console_events,metadata,network_requests,websocket_connections,websocket_frames
    truncated_sections: []
    unavailable_sections: []
    excluded[11]{section,reason,count}:
      accessibility,not_approved,1305
      console_events,disallowed_origin,4
      console_events,unattributed_origin,1
      console_text,not_approved,null
      json_body_shapes,not_approved,null
      metadata,disallowed_origin,489
      resources,disallowed_origin,679
      resources,unsupported_url,37
      script_sources,not_approved,1
      scripts,disallowed_origin,345
      websocket_shapes,not_approved,null
...
  storage:
    origin: "https://www.tradingview.com"
    usage_bytes: 1167837
    quota_bytes: 401094222642
    local_storage_keys[20]: cookie_dialog_tracked,tradingview.globalNotification,tradingview.details.force_uncheck_bid_ask_03_2023,tvlocalstorage.available,tradingview.widgetbar.layout-settings,tradingview.widgetbar.widget.alerts.NirPG2OMjcuR,tradingview.trading.orderWidgetMode.,tradingview.hint.pineEditorDialogMoved,tradingview.widgetbar.widget.object_tree.lwgFPzLQmg6a,tradingview.toggle_delete_locked_linetools,snowplowOutQueue_tv_cf_post2.expires,tradingview.RightToolbarProducts.storeVersion,featuretoggle_seed,snowplowOutQueue_tv_cf_post2,tradingview.editchart.model.style,tradingview.editchart.model.interval,tradingview.editchart.model.symbol,last-crosstab-monotonic-timestamp,signin-promo-story,tradingview.details.force_uncheck_ranges_03_2023
    session_storage_keys[4]: widgetbar.layout-settings,ChartFavoriteDrawingToolbarWidget.visible,chartPageGrid.maximizedPanel,symbol-lists.activeList
    indexed_db_names[1]: Sessions Logs
    cache_names[1]: TVChartApi
    content_fingerprints[32]{scope,identity_sha256,value_sha256,complete}:
      cache_entry,3f3a8434131c8c6ca244722377f34a0a1239f49ec33a7ba77bb8e113a4b5c509,290adcfbb436e76ddee70be1acd583ba86b6de6c8fc90a821a05cb9db5e8378e,true
...
      indexed_db_record,90997e9df3c1de7a8a5df720bb1dbda1f79cd220e85064815e01046bde2ea4c0,d2e2cd5a4a0e746da72c4bbfcca82b39e0da2444e1b03f25c544d18f0b94e33f,false
      indexed_db_schema,42e460bed2843ae09aaaa6b4eaabb2fa47682ae514e3db5f4472441a67a61921,f734825387c1d7c0d941f6f082f67e2771766c8748ebf50ad72fa08e7d83c033,true
      local_storage,0c2c94a734b8d72d3c950f0272183b012294e85621310bcbee0707abd0c12daa,8f097023401b3d58704c1f3abea8ec2eba57c387f09d10125cd66076afd13b1e,true
      session_storage,9baabfb499a1967fbe8a1912b9e7e6b73c49139cb297bf570da8b5fec1178fb6,9bec5a8d5a66d2fd137865f6b1258f26f2d3ed6a4dce54f8f6e53557b0886c85,true
    fingerprint_algorithm: sha256
    fingerprints_complete: false
    values_redacted: true
...
  limitations[5]: Observation starts when REA attaches; prior network and console activity is unavailable.,"Raw network headers, bodies, cookies, storage values, console objects, and WebSocket payloads are never retained; explicitly requested primitive console text is retained verbatim, while payload captures retain value-free shapes.",Source maps are reported only as declarative URLs and are not fetched.,URL-less scripts and console events without an allowed source URL are excluded because their origin cannot be proven.,"Cookie fingerprints cover cookies applicable to the current main-frame URL, not every path on its origin."
```

## 读数含义

**留档行号（`grep -n` 可反查，文件＝`%TEMP%\rea-t10\a16.txt`）**：`evidence_id` 第 1 行；completeness 块 20-45（`policy_filtered_sections[9]` 第 23 行、`excluded[11]` 表头 27、`accessibility,not_approved,1305` 第 28 行）；storage 段整块 41176-41219（`local_storage_keys[20]` 第 41180 行、`session_storage_keys[4]` 41181、`indexed_db_names[1]` 41182、`cache_names[1]` 41183、`content_fingerprints[32]` 表头 41184、条目 41185-41216、`fingerprint_algorithm` 41217、`fingerprints_complete` 41218、`values_redacted` 41219）；`limitations[5]` 第 41220 行（文件末行）。摘录里被 `...` 略过的指纹条目在 41187-41190（cookie 四条）、41194-41212（local_storage 其余 19 条）、41214-41216（session_storage 其余三条）。

- **旗标↔段落的对照实验在本面落地，答案是「`--include-storage-fingerprints` 不额外让任何一段消失」**（批次清单 §2 留的那个「还没验过」的口子，本面读到了）：本趟 `policy_filtered_sections` 是 **9 项**，逐项为 `accessibility,console_events,console_text,json_body_shapes,metadata,resources,script_sources,scripts,websocket_shapes`；与探针页那趟全表 6 项（`forensics/l0/probe-skeleton.md:42` 的 `policy_filtered_sections[6]`）对不上的三项（`console_events`／`metadata`／`resources`）在本页是 `disallowed_origin` 扣的、不是旗标扣的。**关键比对**：`storage_keys` 这一段名在两趟都开了旗标的口径下**从列表里消失**（A1 那趟没开 storage 旗标，它的列表里就有 `storage_keys`；本趟开了，列表里没有），而**列表里从来没有出现过 `storage_fingerprints` 这个段名**，本趟 `excluded` 里也没有 `storage_fingerprints` 条目 ⇒ 指纹读数寄在 `storage` 段里，`--include-storage-fingerprints` 这把旗标不对应 `policy_filtered_sections` 的任何一项。这条读数是照抄当次 stdout 得出的，不是预填的（批次清单 §2 要求的就是这个）。
- **本面撑得住的结论（键名级，P3 对账画线持久化要的正是这一级）**：对方把偏好／布局存在**这些键名**下——`local_storage_keys[20]` 与 `session_storage_keys[4]`。与图表状态直接相关的键名（照抄第 41180-41181 行）：`tradingview.editchart.model.style`、`tradingview.editchart.model.interval`、`tradingview.editchart.model.symbol`、`tradingview.widgetbar.layout-settings`、`tradingview.widgetbar.widget.alerts.<一段后缀>`、`tradingview.widgetbar.widget.object_tree.<一段后缀>`、`tradingview.trading.orderWidgetMode.`（末尾那个点上是键名的空后缀位，我照抄不改）、`tradingview.toggle_delete_locked_linetools`、`ChartFavoriteDrawingToolbarWidget.visible`、`chartPageGrid.maximizedPanel`、`widgetbar.layout-settings`、`symbol-lists.activeList`。⇒ 规格能写的一句形状是：「图表样式／周期／品种三项状态各占一个存储键；侧栏 widget 的实例键把 widget 名与一段后缀拼在一起」——**这是键名形状的观察，不是任何值的观察**。
- **本面撑不住的结论（要写清，否则 L1 会越界）**：
  - 任何「某个键存的是什么值」——`values_redacted: true`（第 41219 行）＋limitations 第 2 条原文「Raw network headers, bodies, cookies, storage values, … are never retained」⇒ 值一个字节都没进 stdout，也就没有任何依据。
  - 「画线对象本身存在哪儿」——本趟枚举到的 20 个 localStorage 键名里**没有**画线集合的键；但 `fingerprints_complete: false`（第 41218 行）＋`indexed_db_names[1]: Sessions Logs` 只有 1 个库名＋`content_fingerprints[32]` 里只有 1 条 `indexed_db_record` 且它的 `complete` 是 **false**（第 41191 行）⇒ 「画线数据不在 IndexedDB」这句话**没有**证据面，只能说「本趟没枚举到那样的键」。「没报≠没有」。
  - 「配额／用量说明什么」——`usage_bytes: 1167837`／`quota_bytes: 401094222642` 是浏览器自报数字，本面不据此下任何结论（同一次会话里它还包含 cookie_dialog 跟踪键、`signin-promo-story` 等与图表无关的项）。
- **`content_fingerprints[32]` 的 scope 分布**（在留档 41185-41216 窗口上跑 `grep -o '^      [a-z_]*,' | sort | uniq -c` 得到）：`local_storage` 20 条、`cookie` 4 条、`session_storage` 4 条、`cache_entry` 2 条、`indexed_db_schema` 1 条、`indexed_db_record` 1 条，合计 32 条，与表头的 `[32]` 相符。每条四个字段 `scope,identity_sha256,value_sha256,complete`——**`identity_sha256` 是「哪个键」的哈希、`value_sha256` 是「内容派生哈希」**，两者都是可比对的指纹而不是内容。⇒ 这一面给 P3 的可复用形状是「同一个 `value_sha256` 在多个 `identity_sha256` 上重复出现」这类**等值关系**（本趟确实有：第 41197／41199／41206 行的 local_storage 条目共享 `18d10c7d…36ee`，第 41198 与 41203 行共享 `076de6e7…6869`，第 41205 与 41206 行共享 `391552c0…a0bf`，第 41210 行的 local_storage 与第 41213 行的 session_storage 共享 `9bec5a8d…c85`），但**不许**据此说「那两个键存的是同一个值」——只能说到「内容指纹相同」为止。
- `cookie` 四条的 `complete` 都是 true，而 limitations **第 5 条**（本面比 A1 那趟多出来的一条）原文：「Cookie fingerprints cover cookies applicable to the current main-frame URL, not every path on its origin.」⇒ cookie 指纹的覆盖范围是**当前主文档 URL 适用的 cookie**，不是该 origin 上的全部；「它有几枚 cookie／cookie 存了什么」都不在本面证据内。
- `fingerprint_algorithm: sha256`、`storage.origin: "https://www.tradingview.com"`（第 41177 行）照抄。
- **`--token-count` 又报低了**：count 趟报 288,917（`a16-count.txt:1`），本趟载荷把闸门放到 400,000 才收全——EOF 是 `limitations[5]` 那一行、全文没有 `[truncated:` 标记。与 A1 同一形状的实测：**`--token-count` 的读数是下界，不是目标数**（活树在两趟之间会长）。
- 本面与 A1 各有一把自己的 `evidence_id`（A1＝`ev_c9e4190b…bbf46`，本面＝`ev_96e65a05…b022a70`），这是 §1 末尾「A16 必须与 A1 分趟」那条的落地：两份记录不是同一主键的两块摘录。
- **2026-10-13 22:20 更正：本记录的 `evidence_id` 原先写作 `ev_8e37f921…af8e5`，那把键在任何一份留档里都不存在**——`grep -rl 'ev_8e37f921' %TEMP%\rea-t10\` 数出 0 份命中，而 `sed -n '1p' a16.txt` ＝ `ev_96e65a0561f3da4489dbf03f41db8d56e7c73624c4dbaaf3fb8a0df25b022a70`。本记录的全部行号（41180／41181／41184／41185／41218／41219／41220）与指纹值都在 `a16.txt` 上逐行验过、原样成立，所以错的是那把键，不是摘录：它挂成了另一趟（没留档、或留档已被覆盖）的读数。键与摘录首行现已改成 `a16.txt` 第一行的值，改完这条记录才满足它自己第 7 行承诺的「留档＝正式趟」。**教训形状：`evidence_id` 必须由 `sed -n '1p' <留档>` 当场取，不能从终端回显里抄。**
- **2026-10-14 更正（摘录转录保真）：第 44 行的 `local_storage_keys[20]` 原先只抄了 18 项——漏三项、重一项。**
  现读复算（仓内；2026-10-14 终席把下面三条从「本文件第 44 行」这种**行号型判据**换成**内容锚**——
  任何一次落在 44 行之上的编辑都会静默作废行号型判据，本文件自己就被这类作废咬过一次；「第 44 行」
  只在最后一行当历史注记留着，不再是判据）：
  `awk -F',' '/^    local_storage_keys\[20\]:/ {sub(/^    local_storage_keys\[20\]: */, ""); print NF}' forensics/l0/tv-a16-storage.md`＝**20**（本席 2026-10-14 现跑）；
  `awk '/^    local_storage_keys\[20\]:/' forensics/l0/tv-a16-storage.md | tr ',' '\n' | grep -c 'tvlocalstorage.available'`＝**1**（原先＝2；本席现跑）；
  要行号就现取：`grep -n '^    local_storage_keys\[20\]:' forensics/l0/tv-a16-storage.md | cut -d: -f1`（本席现读＝44，与历史上那条 `sed -n '44p'` 同指一行，仅作历史注记）。
  留档侧同一条管道打在 `%TEMP%\rea-t10\a16.txt` 第 41180 行上＝20，两边现已**逐字等串**：
  `diff <(sed -n '41180p' "$TEMP/rea-t10/a16.txt") <(awk '/^    local_storage_keys\[20\]:/' forensics/l0/tv-a16-storage.md)` 无输出（本席 2026-10-14 现跑 rc＝0）。
  被漏掉的三项逐字（留档第 12／13／14 位）：`tradingview.RightToolbarProducts.storeVersion`／`featuretoggle_seed`／`snowplowOutQueue_tv_cf_post2`；
  原先仓内第 12 位是 `tvlocalstorage.available` 的**第二次**出现（该串本已在第 4 位）。
  ⇒ 上面「本趟枚举到的 20 个 localStorage 键名里**没有**画线集合的键」这句全称话，在修平之前是说在一份 18 项清单上的；
  补回的三项名逐字在上面这三串里，都不含 `linetool`／`drawing`／`overlay` 词根 ⇒ **结论不变**，但它的证据面从「一份名不副实的清单」
  换成「与留档逐字等长的清单」。同段的 `content_fingerprints[32]` scope 分布里 `local_storage` 20 条这一数与本行修平后的项数**互证**。
  ⇒ 归属与成因：这一行最后由 `29365de9`（T8 落档席）写下，缺陷在**摘录转录**那一步（把留档的一行抄短并重复了一项），
  不是留档缺失、也不是判据造假；由 T9 评审席（`task-9-review.md` I-6）报出，控制席当场按留档补平。
  补平是**单行换单行**（第 44 行换成第 44 行）⇒ 本文件既有行号坐标一个没挪，L1 那张表里指向本记录的「摘录第 56／57 行」仍逐字可达；
  本文件的行数不写在这里（写了就立刻作废），要数请现读 `wc -l < forensics/l0/tv-a16-storage.md`。
- 命令行那条腿无盘可验（2026-10-14 终席披露，源自最终评审席 B 的 B-I-1；按只追加纪律落在文件末尾，
  上面 44／45／56／57 这些行的行号一个没挪，指向它们的锚照旧可达。这条讲的是头部 `命令：`／`留档：`
  那两行）：本机 `/tmp/rea-t10/` 里**没有本趟的 `.cmd` 留档**——本席现量
  `ls /tmp/rea-t10/*.cmd | wc -l`＝**0**（同目录其它件 55 个；对照 `rea-t10b`＝11、`rea-t10c`＝6、
  `rea-t11b`＝11，那三批都落盘了），「命令行要落盘」是 `batch-A-playbook.md` §7 后来补的纪律，这批跑在
  它之前 ⇒ 上面 `命令：` 那一条（含那两把 `--include-storage-*` 旗标的顺序）是操作者终端转录，
  **无法从盘上逐字复原**。另两条腿本席现跑仍可机验：`sed -n '1p' /tmp/rea-t10/a16.txt` 逐字＝本记录
  `evidence_id：` 那串（`ev_96e65a0561f3da4489dbf03f41db8d56e7c73624c4dbaaf3fb8a0df25b022a70`）；
  摘录围栏内每一非省略号的整行片段在该留档上逐字命中 **38/38**（本席口径＝围栏行作 needle 做子串判定；
  席 B 的 36/36 是条目级 needle 口径，分母不同、结论同向）。**不必重跑**：重跑拿不回同一趟。
