# L0：〈面名〉（面 〈A#〉）

<!--
本目录 _templates/ 不在校验器走查范围内（tools/forensics_audit.py 只扫 l0/、spec/、gap-matrix.md），
所以这里的尖括号占位符是安全的。落到 docs/forensics/l0/ 的那一份**必须**把尖括号整个换掉：
校验器对六个必填键的「值」直接判 `<`／`>` —— 留着占位符就是红。
用途：harness 的记录还必须在正文任意位置带上探针 app.js 的现算校验和，见下面那行。
-->

- 命令：npx -y rea-agents@latest 〈单趟 CDP 命令名〉 http://127.0.0.1:9222 〈list-browser-targets 给的真实 target_id〉 〈该面其余实参〉 --filter-output 〈键路径〉
- evidence_id：〈从这次 stdout 里逐字抄的 ev_…64 位十六进制〉
- 浏览器：〈同一趟 list-browser-targets 报的 browser.product／protocol_version／js_version，照抄〉
- 目标 URL：〈targets[] 里那个 target_id 对应的 url，照抄〉
- 观察条件：〈headless 形态；有没有点开菜单／派发事件；有没有禁用优化；观察窗多大；一次一面的那一面是哪个〉
- 完整性：〈stdout 里 completeness 块的 status 值照抄，并写清它是什么〉
- 用途：〈harness／规格／基线 三选一〉
- 探针校验和：sha256(tools/rea_probe_site/app.js 按 LF 归一) = 〈现算命令的 64 位十六进制〉
- 取证时间：〈YYYY-MM-DDTHH:MM:SS+08:00；stdout 里给了 UTC 时间戳的按 UTC 换算〉

## 摘录（逐字，未改写）

```text
〈把 stdout 里支撑结论的那几行贴进来，别整包贴——内存只有 2GB〉
〈分段之间用一行 ... 标注被略过的部分；围栏按载荷真实格式标，REA 默认是 toon 缩进文本，不是 JSON〉
```

## 读数含义

- 〈每个被引用的键名怎么写就怎么读：6.4.0 的 `list-browser-targets` 报的是 **`target_id`**，不是 `targetId`；三条命令共用同一趟拿到的那一个〉
- 〈completeness 的读数逐键列出你这次真看到的：A1（`inspect-web-page`）2026-10-13 实测是 `status: policy_filtered`，并带 `conditions`／`policy_filtered_sections`／`attach_limited_sections`／`truncated_sections`／`unavailable_sections`／`excluded`／`dropped_events`；A2（`analyze-web-bundle`）实测是 `status: complete`，并带 `parsed_scripts`／`parse_failures`／`visited_ast_nodes`。**不要抄模板里的示例值**〉
- 〈正文里出现了 `parse_failures` 这个字样，`完整性：` 那一行就必须也带上它并解释其值——校验器按全文比对；这一面真没有该键时就别提它〉
- 校验和这样拿（**按 LF 算**，与校验器同口径；别用 `sha256sum`——本机 core.autocrlf=true 时工作树里是 CRLF，它会算出另一个值，而校验器读的是行尾归一后的字节）：
  `python -X utf8 -c 'import pathlib,hashlib;p=pathlib.Path("tools/rea_probe_site/app.js");print(hashlib.sha256(p.read_bytes().replace(b"\r\n",b"\n")).hexdigest())'`
  **这一串是反编造针**：没在这棵树上真跑过的人抄不出来；改过 app.js 也会让它失效，从而暴露旧证据。
- 〈这一面撑得住哪句结论、撑不住哪句（limitations 逐条圈住的范围要写清，别把「没报」写成「没有」）〉
