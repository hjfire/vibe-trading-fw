# 规格样例：一条能被测试打的条目长什么样

| 条目号 | 规格句 | 判据 | 判据类型 | L0 依据 |
|---|---|---|---|---|
| TV-EX-01 | 图表工具栏是一组并列的可点击按钮，画线工具以按钮形式出现，至少含趋势线／斐波那契／画笔三类 | 对探针页跑 `inspect-web-page --include-accessibility-text --filter-output evidence_id,normalized_result`，在 `accessibility.nodes` 里同一 `parent_id` 下能数出 ≥3 个 `role: button`，其 `name` 字面为 `Trend line`、`Fibonacci`、`Brush` | DOM | _example.md |

这条是**格式样例**：文件名带下划线前缀 ⇒ `forensics_audit` 按精确文件名豁免，它不进差距矩阵，
也不冒充任何第三方观察结论。真正的 TV 面条目从 P1 批次起写在 `spec/<面名>.md` 里，一律要过校验器。
它的判据之所以算数，是因为同一句话在本地探针页上真跑过一次、读数就贴在 L0 的摘录块里。

这条只引 `_example.md` 一份，因为 `name` 读数只在带 `--include-accessibility-text` 的那一趟里存在；
`probe-skeleton.md` 记录的是同一面不开该旗标时的形状（可达名称被策略扣掉），它支撑不了这句话。

**表格最后一格写 `_example.md`，只在样例文件自己里合法。**校验器按精确文件名豁免这一对样例件
（`SPEC_EXEMPT`／`L0_EXEMPT`），而真实条目（`spec/<面名>.md`）把 `L0 依据` 指向任何豁免件，
校验器现在会当场红——那条违规的原话是「落在样例豁免件上——样例证据不能当真实条目的依据（真实条目必须指实抓记录）」。
理由就写在上面那段里：`l0/_example.md` 记的是**本地探针页**那一趟，跟 tradingview.com 没有任何关系，
所以抄这一行形状的人不能连最后一格一起抄——真实条目要指在 TV 上真跑过的那份实抓记录。

## 判据打在哪几行

- `role: button` ×3：`l0/_example.md` 摘录里 `node_id` 为 `"19"`／`"22"`／`"25"` 的那三坨（stdout 第 323–349 行），
  每坨九行；数的是 `role:` 这一格，不是 `node_name: BUTTON`（那是 `dom` 段的另一套编号）。
- 同一 `parent_id`：三坨的第二行都写 `parent_id: "17"`；`"17"` 自己是摘录里那条 `role: generic`
  （`parent_id: "12"`），所以「并列」这件事在证据里的形状是**同一个父**，不是某个 id 属性。
- 三个 `name` 字面值：`name: Trend line`／`name: Fibonacci`／`name: Brush`（摘录第 87／96／105 行，逐字）。
- 「可点击」：三坨各带 `states[2]{name,value}: focusable,true`＋`invalid,"false"`——`focusable` 是这一面
  对「按得动」的唯一读数，`invalid,"false"` 只说明可达性树没把它标成无效。
- 判据里那句命令与旗标要一起抄：同一趟没带 `--include-accessibility-text` 时 `text_capture.status` 是
  `not_approved`、`retained_bytes: 0`、18 个可达名称被扣掉，那时候这条判据打不到任何东西。
  `--filter-output evidence_id,normalized_result` 也得一起抄：那一趟的 stdout 是 12,788 字节，
  不带闸门的命令形式照抄到 TV 上就是 MB 级（`README.md` §4 第 4 条）。

## 为什么这一行算 P0 的收口

spec §7 对 P0 的判据是「对本地中立页走完 A1＋A2 并产出 1 条能被测试打的规格条目」。
上面这一行的「能被测试打」有两层：一是判据本身可执行（读数在 L0 摘录里逐字可查），
二是它的形状由 `tools/test_forensics_spec.py::test_live_example_files_use_the_contract_shape` 钉住——
那根针不再自己重写子串判断，而是把这两份样例件喂回校验器的真规则：`_audit_spec` 管表头逐字、
条目号的形状与值、判据长度（≥`MIN_VERDICT_LEN`）、判据类型域、`L0 依据` 的落点与豁免；
`_audit_l0` 按围栏感知的 `_meta_keys` 查 `l0/_example.md` 的六把必填键（摘录块里写「`- 命令：`」不算数）；
外加显式钉住那一行的判据类型是 `DOM`、以及那串探针 `app.js` 的校验和按 LF 现算后仍在文本里。
样例件被审计豁免，所以那一根针就是它唯一的门。
