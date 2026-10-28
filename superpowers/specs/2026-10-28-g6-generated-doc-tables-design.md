# G6（第 0 档）设计：文档里的数值表由测试重生成

日期：2026-10-28
状态：已定稿（用户已授权全程自主推进，本 spec 的设计裁定不等待复核）

## 1. 要治的痛

本仓反复踩「文档自指读数」：文档里手打的数字（计数、页数、行数、提交号）在写下那一刻就开始
过期，而且**没有一个机器判据能抓住它**。两枚实证：

- `forensics/README.md:38` 写着「`l0/` 下 25 份记录里 23 份有 `浏览器：` 这一键」——现读
  `git ls-files forensics/l0/*.md | wc -l` ＝ **33**（含 `_example.md`）。那串 25/23 是
  2026-10-14 的一次性读数，此后每加一份 L0 就再假一分，而没有任何门会红。
- `项目档案.md` 里的同类句子只能靠「写日期＋不回改」维持诚实；凡是**可以现算**的数字，
  靠纪律维持就是可避免的债。

G6 的判据一句话：**凡是能由仓库状态现算的数值表，都不许手打；由生成器写，由测试判陈旧。**

## 2. 目标 / 非目标

目标：

1. 一个纯标准库生成器 `tools/doc_tables.py`：从仓库状态算出文档表格，`--write` 重写、
   `--check` 只比对（CI 用）。
2. 第一份落地物：`forensics/l0-census.md` —— `forensics/l0/` 下每一份 L0 记录的机器可判面
   （状态、用途、六键齐、`evidence_id` 合法性、目标 host 类），外加一行汇总计数。
3. 一条守卫：`tools/test_doc_tables.py`，判「已跟踪的表 == 现算的表」，并证明这把尺不是恒真。
4. 一条 CI 面：新增 fork 自有工作流，路径命中即跑 `--check` ＋ 该测试。

非目标：

- 不改 `forensics/README.md` 里任何**带日期的历史读数**（那是台账，不归生成器管）；只追加
  一条带日期的指针，指向新生成物。
- 不改 `tools/ci_grep_gates.sh`、`.github/workflows/test.yml`（上游所有，字节不动）。
- 不动任何门禁阈值，不新增任何「豁免白名单」。

## 3. 关键设计裁定

### 3.1 生成物放 `forensics/l0-census.md`，不放 `l0/` 里

`tools/forensics_audit.py:460` 把 `forensics/l0/*.md`（除 `_example.md`）**全部**当 L0 记录
审计；把生成表塞进 `l0/` 会让它立刻吃掉一条「缺少必填键 命令」的违规。放 `forensics/` 根下，
审计不枚举根目录的散装 md（它只认 `l0/`、`spec/`、`gap-matrix.md` 三处）。

### 3.2 一把尺，不造第二把解析器

`doc_tables.py` **不**自己解析 L0 键值，而是调用 `forensics_audit` 的解析：
`_meta_keys`／`_read`／`_url_host`／`_is_tv_page_record`。为了让这次复用不靠私有名，给
`forensics_audit.py` 追加两个公开包装（纯增量，不改既有行为）：

- `record_keys(path) -> dict[str, str]`：一份记录的点号键面；
- `record_target_kind(path) -> str`：`三方`／`自家`／`其他`／`无 URL` 四值。

第二把解析器是「同一事实两处实现」的经典漂移源；这里用导入把两条路钉成一条。

### 3.3 生成物不许含自指读数

表里只放**现算的事实**，且不含：日期、提交号、行号、文件行数、绝对路径。理由是它们会让
「本文件 N 行」这类句子在自己的生成动作里失效——那正是 G6 要治的病。守卫测试用正则钉住
（`\d{4}-\d{2}-\d{2}`、`\b[0-9a-f]{40}\b`、`:\d+\b` 在表体内零命中）。

### 3.4 陈旧的判据是「字节相等」，不是「大致对」

`--check` 现算一遍，与已跟踪文件逐字节比对；不等即 rc=1 并打印首个差异行。生成器本身
**确定性**：同一棵树上跑两遍必须字节相同（排序固定、无时间戳）。测试把「两遍相等」单列一枚针，
因为不确定性会让 `--check` 在 CI 里随机红。

### 3.5 表的列（机器可判面的最小集）

| 记录 | 状态 | 用途 | 六键 | evidence_id | 目标 |
|---|---|---|---|---|---|
| `probe-bundle.md` | 完整 | 基线 | 6/6 | ✓ | 自家 |

- 状态：`状态：` 键里含「不可取证」⇒ `不可取证`，否则 `完整`（与 `_audit_l0` 同判据）。
- 用途：`用途：` 键原文；缺省 `—`（`不可取证` 记录**不**代填）。
- 六键：`L0_REQUIRED_KEYS` 六枚里「键存在且值为非空、且不含尖括号」的枚数。
- `evidence_id`：`EVIDENCE_ID.fullmatch` 通过 ⇒ `✓`，否则 `—`。
- 目标：`record_target_kind` 的四值。

汇总行：总份数（不含 `_example.md`）、完整／不可取证、六键齐枚数、`evidence_id` 合法枚数、
用途分布（`harness a／规格 b／基线 c／未声明 d`）。

### 3.6 CI 面：新开一条 fork 自有工作流

`test.yml:118` 只跑 `ci_grep_gates.sh`、`:121` 只跑两枚上游测试文件，且 `test.yml` 上游所有、
字节保护 ⇒ 新测试无法挂进去。因此新增 `.github/workflows/doc-tables.yml`（**新文件，不改任何人**）：
`push`／`pull_request` 命中 `forensics/**`、`tools/doc_tables.py`、`tools/forensics_audit.py`、
`tools/test_doc_tables.py`、自身时运行；步骤＝`pip install pytest -q` ＋ `python -X utf8
tools/doc_tables.py --check` ＋ `pytest tools/test_doc_tables.py -q`。

## 4. 验收

1. `python -X utf8 tools/doc_tables.py --check` 在干净树上 rc=0；改一个字节后 rc=1（测试自证）。
2. `pytest tools/test_doc_tables.py -q` 全绿，且含一条判别力针：往临时语料加一份 L0 记录后，
   行数与对应行必须变化——否则「表」可能只是一张恒真的静态图。
3. `tools/forensics_audit.py` 仍 `clean`（166 passed 的既有套件不回归）。
4. 生成物里不含日期／提交号／行号（正则针）。
5. 门册八腿复跑，rc 册与开工前同形（G7／G8 两枚恒红按构造归属，不调阈值）。

## 5. 风险与缓解

- **风险**：`forensics_audit` 追加公开包装会碰一枚被 166 条测试钉住的模块。
  **缓解**：纯增量函数，不改既有函数体；先跑该套件基线，再跑改动后，逐字对读 `166 passed`。
- **风险**：新工作流在上游 `Sync upstream` 里成为冲突面。**缓解**：新文件与上游零交集；
  `sync-upstream.yml` 是机械合并，新文件不参与。
- **风险**：生成物与 README 的旧读数并存产生两种真相。**缓解**：README 只追加带日期的指针，
  写明「旧句是 2026-10-14 的一次性读数，现量看 `forensics/l0-census.md`」，不回改旧句。
