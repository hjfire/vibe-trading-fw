# 规格样例：一条能被测试打的条目长什么样

| 条目号 | 规格句 | 判据 | 判据类型 | L0 依据 |
|---|---|---|---|---|
| TV-EX-01 | 图表工具栏是一组并列的可点击按钮，画线工具以按钮形式出现，至少含趋势线／斐波那契／画笔三类 | 对探针页跑 `inspect-web-page --include-accessibility-text`，在 `accessibility.nodes` 里同一 `parent_id` 下能数出 ≥3 个 `role: button`，其 `name` 字面为 `Trend line`、`Fibonacci`、`Brush` | DOM | _example.md |

这条是**格式样例**：文件名带下划线前缀 ⇒ `forensics_audit` 按精确文件名豁免，它不进差距矩阵，
也不冒充任何第三方观察结论。真正的 TV 面条目从 P1 批次起写在 `spec/<面名>.md` 里，一律要过校验器。
它的判据之所以算数，是因为同一句话在本地探针页上真跑过一次、读数就贴在 L0 的摘录块里。

这条只引 `_example.md` 一份，因为 `name` 读数只在带 `--include-accessibility-text` 的那一趟里存在；
`probe-skeleton.md` 记录的是同一面不开该旗标时的形状（可达名称被策略扣掉），它支撑不了这句话。

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

## 为什么这一行算 P0 的收口

spec §7 对 P0 的判据是「对本地中立页走完 A1＋A2 并产出 1 条能被测试打的规格条目」。
上面这一行的「能被测试打」有两层：一是判据本身可执行（读数在 L0 摘录里逐字可查），
二是它的形状由 `tools/test_forensics_spec.py::test_live_example_files_use_the_contract_shape` 钉住——
表头逐字、条目号恰好一条、`l0/_example.md` 的六把必填键齐全。样例件被审计豁免，所以那一根针就是它唯一的门。
