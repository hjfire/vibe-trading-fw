# REA 取证漏斗（docs/forensics/）

本目录是「用 REA 取证驱动的 TradingView 复刻」（`docs/superpowers/specs/2026-10-13-rea-tradingview-replica-design.md`）
那条漏斗的**产物目录**。这里不放感想，只放三层工件：L0 观察记录 → L1 规格条目 → L2 差距矩阵。
三层都由 `tools/forensics_audit.py`（纯标准库）机器判定，不满足就 rc=1。

## 1. 这是什么

- **L0 观察**（`l0/<面>.md`）：一条 REA 单趟 CDP 命令 ＋ 一个观察面 ＋ 一份记录。记录内容＝命令原文、
  `evidence_id`、浏览器读数、目标 URL、观察条件、完整性读数，再加一段**从 stdout 逐字抄的摘录**。
- **L1 规格**（`spec/<面>.md`）：把 L0 读数翻成条目 `TV-<面>-<两位序号>`，每条自带一个可执行判据。
- **L2 差距**（`gap-matrix.md`）：一条规格一行，对本仓现状做四态对账（已有／部分／缺／不可复刻）。
- 往上还有 L3 分片实现与 L4 验收，那两层不在本目录里，走本仓既有的六片式交付纪律。

纪律的一句话版本：**校验器不读 REA 的原始输出文件，只读我们抄下来的那几行键值。** 所以「摘录是否逐字、
`evidence_id` 是不是真从这趟 stdout 来的」没人能替你验——`用途：harness` 的探针校验和那支针就是为它装的。

## 2. 三份约定的机器判据（逐字）

以下三组值就是契约，抄错一个字符就红。逐字取自 `tools/forensics_audit.py`（**本目录不许改它**）。

L0 的六把必填键（`L0_REQUIRED_KEYS`）：

```
命令 / evidence_id / 浏览器 / 目标 URL / 观察条件 / 完整性
```

- 六把少一把即违规；值为空即违规；**值里残留 ASCII 尖括号 `<` 或 `>` 也即违规**（模板里的尖括号必须换成真实值）。
- `evidence_id` 必须整串匹配 `ev_[0-9a-f]{64}`。
- `命令` 必须含 `rea-agents`，且必须含 `--filter-output` 或 `--token-limit` 之一。
- 正文任何位置出现 `parse_failures` 字样时，`完整性：` 那一行里也必须出现它（不解释就是没看）。
- `用途` 只能是 `harness`／`规格`／`基线`；声明 `harness` 时正文必须带上
  `sha256(tools/rea_probe_site/app.js 按 LF 归一)` 那 64 位十六进制现算值。
- 标记 `状态：不可取证` 的记录走另一条支路（仍要写清 `命令：`＋`原因：`，且同样受命令卫生约束）。

L1 的表头（`SPEC_HEADER`，整行比对）：

```
| 条目号 | 规格句 | 判据 | 判据类型 | L0 依据 |
```

判据至少 12 个字符（`MIN_VERDICT_LEN`），判据类型只能是 `DOM`／`状态`／`像素`，条目号匹配
`TV-[A-Z][A-Z0-9]*-\d{2}` 且全仓库不重复，`L0 依据` 必须落进 `docs/forensics/l0/` 里真实存在的文件。

L2 的表头（`MATRIX_HEADER`，整行比对）：

```
| 条目号 | 状态 | 本仓坐标或搜索记录 | 优先级 | 说明 |
```

状态只能是 `已有`／`部分`／`缺`／`不可复刻`，优先级只能是 `高`／`中`／`低`／`-`；
`已有`／`部分` 要给仓库根之内的 `file:line` 且行号不越界（指到 `docs/forensics/**` 自己不算自证）；
`缺` 要以 `未找到：` 开头并带上能复跑的 needle。

## 3. 怎么跑校验器

```bash
python -X utf8 tools/forensics_audit.py                    # rc=0 clean ／ rc=1 逐条打印违规
python -X utf8 -m pytest tools/test_forensics_spec.py -q    # 校验器自己的测试（2026-10-13 实测 120 passed）
```

两条都要显式给路径：`tools/test_*.py` 不在 `pyproject.toml` 的 `testpaths` 里，裸 `pytest` 收不到它。

（2026-10-13 夜复跑＝`127 passed`。上面那个 120 是当天早先的读数，**保留不改写**——套测试条数在随每片增长漂，
任何引用它的地方都要当场重跑，别抄文档里的数。）

**CI 状态**：这个校验器与它的测试**当前只在本地显式跑，不在 CI**（实现计划 Global Constraints 第 10 条：
把 `tools/test_forensics_spec.py` 加进 `.github/workflows/repowiki-freshness.yml` 属工作流变更，是需用户点头项）。
所以「绿了」只代表有人在本机跑过，不代表流水线替你守着。

红了就改**记录**，不许改校验器——校验器是被 120 条测试钉住的契约，为通过而放宽它等于把纪律摘掉。

## 4. 怎么起一趟取证

spec §5 的统一前置（每个批次开头跑一次），逐字照抄：

```bash
npx -y rea-agents@latest doctor                       # 记下 node detail
"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" --headless=new \
  --remote-debugging-port=9222 --user-data-dir="$TEMP/rea-cdp-profile" \
  --disable-extensions --disable-sync --no-first-run --no-default-browser-check "<目标页 URL>"
npx -y rea-agents@latest list-browser-targets http://127.0.0.1:9222   # 取 targetId
```

实测坑（下面按编号列，条数随每批的实测增长——**别在任何地方引用它的总数**，要引用就去数本节实际的条目）：

1. **URL 只能当 Edge 的命令行参数交出去**。不许用 CDP 的 `PUT /json/new?url=` 开标签——Edge 155 会回一个
   target id 但页面停在 `about:blank`（设计轮实测）。
2. **`--allowed-origins` 要裸值**（如 `--allowed-origins http://127.0.0.1:8077`），写 JSON 数组字面量会被拒
   （`invalid_request`／`invalid_input`）。
3. **一次一面**：一份 L0 只对应一条命令、一个观察面（Global Constraints 第 7 条）。混面捕的证据在 L1 拆不干净。
4. **每条命令必带 `--filter-output` 或 `--token-limit`**（内存常剩 2GB）。排障时可以先去掉 `--token-limit`——
   它会把错误对象的 `details` 一起截掉。反过来也成立：2026-10-13 的 A4 那趟用 `--token-limit 400` 时，
   载荷正好截在 `  listeners[1]:` 的 `    - type:` 上，值看不见（末尾 `[truncated: showing tokens 0–400 of 1477]`），
   放宽到 1500 才读到 `pointerdown`。
5. **`--filter-output normalized_result` 会把顶层 `evidence_id` 一起滤掉**（2026-10-13 A1 实测）。
   要留主键就把过滤键写成 `evidence_id,normalized_result…`；`l0/` 三份记录的 `命令：` 就是加了它的版本。

另外两条形状上的事实：键名是 **`target_id`**（不是 `targetId`），三条命令共用同一趟 `list-browser-targets` 的那一个；
`completeness.status` 的合法读数按面不同——A1 实测 `policy_filtered`（策略扣字段，不是解析失败），
A2 实测 `complete`，A4 那面的 stdout 里根本没有 completeness 块。**照抄你这次看到的，别抄模板。**

收尾（只杀自己起的那两个 PID，**绝不按镜像名杀 `msedge.exe`**——那会连带杀掉用户正在用的浏览器窗口）：
`$!` 拿到的是 Git-Bash 的 PID，`taskkill` 不认；要从 `netstat -ano` 取真实 Windows PID，
先 `tasklist //FI "PID eq <pid>"` 只读核对身份，再 `taskkill //PID <pid> //T //F`，最后 `rm -rf "$TEMP/rea-cdp-profile"`。

## 5. 本机不可用的两条路（spec §2.4，决定架构）

1. **一切吃磁盘路径的 REA 命令都坏**：`inspect-evidence-bundle`／`export-web-scripts` 报 `ESTALE`
   （换目录、换卷、加 sleep 都试过）。
2. **`analyze-javascript-application` 的目录模式在本机确定性失败**：`code: artifact_operation_failed`、
   `category: integrity_mismatch`、detail 永远是「Directory entry changed before open:〈清单里第一个文件〉」；
   REA 给的解法 `--integrity-policy record-and-continue` 不生效。

合起来的三条含义（写死，别绕）：证据的**产生**只走 loopback CDP 单趟命令；证据的**留存**只走 stdout＋
我手动逐字摘录进仓库内 markdown（`evidence_id`＋`sha256`＋命令＋观察时间）；
「把对方脚本落盘再慢慢读」那条深挖链在本机不可用，要先把环境修好（Node ≥22.19 是最可能的解药，那是项目外动作）。

因此「分析自家源码」这一路已被改判为**对称取证**：对自家 dev server 跑同一套 CDP 命令，而不是喂目录给静态重建器。

## 6. 合规三条硬线（spec 裁定 1）＋ 主机白名单原文

1. **产出只能是「规格＋证据」**：不拷贝 TradingView 的源码、图标、字体、配色表、CSS 及任何表达层内容；
   UI 文案自拟（它叫 "Crosshair"，我们叫「十字光标」）。
2. **实现必须从规格出发，不引用任何 TV 代码**：每片走 TDD；允许参考的第三方源码仅限既有开源依赖
   （klinecharts v10）与本仓自有代码。
3. **TradingView 的接口不作为运行时依赖**：观察阶段看到的请求地址只作为「它有这样的数据需求」的证据记录，
   绝不写进本仓任何请求代码。

这条硬线由校验器的 `audit_tv_host_allowlist()` 机器执行：`frontend/src` 里含 `tradingview.com` 的**文件集合必须
恰好等于**下面这五把（多一个＝把外部站点接成运行时依赖，少一个＝白名单该同步收紧，两边都红）：

```
frontend/src/components/chat/PineScriptViewer.tsx
frontend/src/lib/__tests__/scriptExchange.test.ts
frontend/src/lib/pineLang.ts
frontend/src/lib/scriptLibrary.ts
frontend/src/pages/TVChart.tsx
```

并且：`s3.tradingview` 只允许出现在 `frontend/src/pages/TVChart.tsx` 一个文件里；那两行逐字子式
（`support_host: "https://www.tradingview.com"` 与
`script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js"`）
被改动或消失同样报红——那是对外部站点的运行时依赖，改动要重新裁定。

## 7. 状态语义与豁免

- `docs/forensics/` **不存在** ＝ 取证骨架还没建：`tools/forensics_audit.py` 报
  「…docs\forensics 不存在：取证骨架还没建」并 rc=1（这条措辞由 `test_missing_forensics_root_is_named` 钉住）。
  测试层的约定写在 `tools/test_forensics_spec.py` 模块 docstring 里：「仅仅是**缺失**的树必须大声 skip
  （骨架由后续任务建立，所以『还没建』是一个真实的状态）；存在但畸形的树必须失败」——活树那一条 skip 针
  要等 Task 6 落，本文件先按已确立的约定描述。
- 目录**存在但畸形** ＝ 红：逐条打印违规（缺键、空值、占位符尖括号、`evidence_id` 形状不对、
  表头不逐字、列数不是 5、坐标越界／在仓外／自证、条目号重复或凭空、孤证……）。
- 空目录不等于没建：`l0/` 下没有任何证据文件时报「骨架不等于取证」。
- **`_templates/` 根本不在走查范围内**——校验器只扫 `l0/`、`spec/`、`gap-matrix.md`。所以模板里保留占位符是安全的，
  也正是它该有的样子：模板是形状，`l0/` 下三份才是证据。说清这一层的保证从哪来：测试并不读 `_templates/`
  里的文件，它在 `tmp_path` 合成树上钉的是三份约定的**判据形状**；模板的价值在于把那套形状写给人看，
  真正被机器盯着的是落进 `l0/`／`spec/`／`gap-matrix.md` 的那几份。
- `l0/_example.md` 与 `spec/_example.md` 两个**精确文件名**分别被所在层豁免（`L0_EXEMPT`／`SPEC_EXEMPT`），
  留给 P0 的样例规格条目用；截至本文件写作时这两个文件都还不存在（由后续任务建立）。
- 本目录当前实有内容：`l0/probe-skeleton.md`／`l0/probe-bundle.md`／`l0/probe-events.md`（三份 `用途：harness`
  的本地探针记录，2026-10-13 同趟产出）＋ `_templates/` 三份模板。还没有 `spec/`，也没有 `gap-matrix.md`
  ——没有条目时矩阵不是必需，孤证规则也不开口。

## 附：`docs/` 被整目录忽略

`.gitignore:125` 把 `docs/` 整个忽略，所以本目录每次加文件都要 `git add -f`，
提交一律 `-s` 且带 pathspec（工作树上常驻他人在途改动，裸 `git commit` 会把它们吞进来）。
