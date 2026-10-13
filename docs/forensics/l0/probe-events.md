# L0：探针页元素事件面（面 A4）

- 命令：npx -y rea-agents@latest inspect-web-event-listeners http://127.0.0.1:9222 437D7000A067F60AC4103AE26B62F9A4 #probe-chart --token-limit 1500
- evidence_id：ev_d9cdbd192fffe709aaff5f54178427b2d849f760f6fc1dac08592a52a7537b15
- 浏览器：Edg/155.0.4283.45（protocol_version 1.3，js_version 15.5.9.4，同一趟 list-browser-targets 的读数）
- 目标 URL：http://127.0.0.1:8077/
- 观察条件：本地自研探针页 tools/rea_probe_site/；Edge --headless=new；selector 是 canvas 本身（#probe-chart）；未派发任何事件、未点按、未禁用优化；--token-limit 1500（同一条命令用 brief 的 400 跑过一次，载荷被截在 listeners 的 type 值上，见下面读数含义）；同一 target_id 与 A1／A2 共用
- 完整性：这一面的 stdout 里没有 completeness 块（无 status 键可抄）；能核对到的完成度信号是 selected_node.match=found、listeners[1] 一条、sources[1] 一条、source.state=captured、cleanup=confirmed
- 用途：harness
- 探针校验和：sha256(tools/rea_probe_site/app.js 按 LF 归一) = 62ea3b375625208a69137b6c634e425c921098f45e4fbe2b3f1194a90229e52f
- 取证时间：2026-10-13T17:05:21+08:00（同一 stdout 里 inspected_at 写作 2026-10-13T09:05:21.097Z，即 UTC）

## 摘录（逐字，未改写）

下面这段是从 5,361 字节的 stdout 里按行号切出来的**分段**（`source.text` 那一行是整份脚本的单行转义拷贝，与探针文件重复，故略过）；分段之间用一行 `...` 标注被略过的部分。格式是 REA 默认的 toon 缩进文本，不是 JSON，所以围栏标 `text`。

```text
evidence_id: ev_d9cdbd192fffe709aaff5f54178427b2d849f760f6fc1dac08592a52a7537b15
...
  cdp_endpoint: "http://127.0.0.1:9222"
  allowed_origins: []
  target_id: 437D7000A067F60AC4103AE26B62F9A4
  selector: #probe-chart
...
  browser:
    product: Edg/155.0.4283.45
    protocol_version: "1.3"
    revision: 537.36 (@50f24ef2aa5369a074b8888b7db82d9c0652d642)
    user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0"
    js_version: 15.5.9.4
  target:
    target_id: 437D7000A067F60AC4103AE26B62F9A4
    origin: "http://127.0.0.1:8077"
    initial_url: "http://127.0.0.1:8077/"
    frame_id: 437D7000A067F60AC4103AE26B62F9A4
    loader_id: EF8C2DF3E212C8CBF05EA6D6F635EB7D
  inspected_at: "2026-10-13T09:05:21.097Z"
...
  selected_node:
    selector: #probe-chart
    match: found
    backend_node_id: 29
  listeners[1]:
    - type: pointerdown
      use_capture: false
      passive: false
      once: false
      location:
        script_id: "3"
        url: "http://127.0.0.1:8077/app.js"
        line_number: 4
        column_number: 43
        function_name: null
        source_association: script_id
      execution: unknown
  sources[1]:
    - script_id: "3"
      url: "http://127.0.0.1:8077/app.js"
...
      producer_hash: 62ea3b375625208a69137b6c634e425c921098f45e4fbe2b3f1194a90229e52f
...
        state: captured
...
        sha256: 62ea3b375625208a69137b6c634e425c921098f45e4fbe2b3f1194a90229e52f
        utf8_bytes: 697
        utf16_units: 697
  cleanup: confirmed
```

## 读数含义

- `listeners[1]` 只有**一条**，`type: pointerdown`，且 `use_capture: false`、`passive: false`、`once: false`。这就是工单 A4 要回答的问题形状：这块画布接的是 pointerdown，不是 click，也没有 pointerup／pointermove——app.js 里确实只 `addEventListener` 了一次。
- `location` 给的是 `script_id: "3"`／`url: http://127.0.0.1:8077/app.js`／`line_number: 4`／`column_number: 43`／`function_name: null`／`source_association: script_id`，`execution: unknown`。**`line_number` 是 0-based**：4 对应工作树 app.js 的第 5 行 `canvas.addEventListener("pointerdown", (event) => this.pick(event));`。这一条与 A2 的 `location.line: 23`（1-based）口径不同，写判据时不能混用。
- `column_number: 43` 是 CDP 给的列，本记录不解释它指向哪个字符（工作树里那一行的 `"pointerdown"` 字面量起点按 0-based 数是 28，对不上 ⇒ CDP 的列口径不是「字面量起始」，具体是什么没验，别拿去当判据）。
- `sources[1]` 两条指纹 `producer_hash` 与 `source.sha256` 都等于 `62ea3b37…e52f`，`utf8_bytes: 697`／`utf16_units: 697` ⇒ 监听器回调所在脚本就是这棵树里的探针脚本；`source.state: captured` 说明这一面把源码文本一并带回来了（A1 那面是 `included: false`，因为它没选 source capture）。
- `cleanup: confirmed` 的含义在 limitations 末条原文里：REA 释放远端对象组、关掉启用的域、断开 transport，「the externally owned page remains open」——页面还在，不是被它关掉的。
- 这一面撑不住的结论（limitations 逐条圈住）：它「Inspects listeners registered directly on the first native CSS match」，所以**委托在祖先上的监听、子元素上的监听、闭合 shadow root、框架自己的注册表都不在这份枚举里**；`execution: unknown` 加上「REA does not dispatch an event, evaluate JavaScript or invoke a handler」⇒ 「按下 pointerdown 之后会发生什么」不在这份证据里，那是行为面，要另开一趟真的派发。
- `--token-limit` 的实测形状：400 那一趟的 stdout 到 `  listeners[1]:` 之后停在 `    - type:`（值没打出来），末尾一行 `[truncated: showing tokens 0–400 of 1477]`。整份载荷 1,477 tokens，所以本记录用了 1500。这就是「报错／关键值看不清时先放宽或去掉 --token-limit」的代价形状：它截的是载荷，不区分你要的那几行。
- 校验和这样拿（**按 LF 算**，与校验器同口径）：
  `python -X utf8 -c 'import pathlib,hashlib;p=pathlib.Path("tools/rea_probe_site/app.js");print(hashlib.sha256(p.read_bytes().replace(b"\r\n",b"\n")).hexdigest())'`
- 这一串是反编造针：没在这棵树上真跑过的人抄不出来；改过 app.js 也会让它失效，从而暴露旧证据。
