# Repo Wiki 重做设计：从 IDE 只读快照到仓库自有、可自动更新的文档树

日期：2026-10-01
状态：待你评审（未开工）
作者：Qoder CLI 会话 `824c1609`
相关：`项目档案.md`（Wiki 漂移收口章节）、`tools/wiki_drift.py`、`tools/test_wiki_drift.py`

---

## 1. 目标与非目标

**目标**

1. Wiki 的事实源变成**仓库里被 git 跟踪的 Markdown 树**，读写、再生成、校验全部能在 CLI 侧闭环，不再依赖 Qoder IDE。
2. 「哪些页面已经过期」是**一条命令算出来的确定答案**，不是印象；「过期页面的链接坐标」是**工具自动改的**，不是手改。
3. 每一次改动都留下**可复核的证据**（逐文件 sha 对账、页数反空断言、变异探针），沿用本项目既有验证纪律。
4. **同步能力零损失**：本次全部产物落在 fork 自有的新路径上（仓库根 `repowiki/`、`tools/wiki_drift.py` 等），上游拥有的文件一个字节都不改（§2 ⑬、§9.2）。判定方法是可证伪的一条命令，不是承诺。

**非目标（本期明确不做）**

- 不做「知识中心 Repo Wiki 面板里点一下自动重生成」——见 §2 实测结论 ①，这条在 CLI 侧不可能。
- **不改上游拥有的文件**：`.gitignore`、`tools/ci_grep_gates.sh`、`.github/workflows/test.yml`、`wiki/**`。由此带来的两个已知代价（本地门禁长期红一条、新鲜度检查只在每周/手动触发）在 §9.2 与 §15 记为可接受的取舍。
- 不改公开文档站 `wiki/`（Cloudflare Pages 那套，`wiki.yml` / `wiki-deploy.yml` 两个工作流管它），两棵树互不影响。
- 不在本期重写 423 页的散文内容。本期交付的是**能重写它们的那套机器**，散文层是里程碑 M5。
- 不推送。所有动作止步于本地提交，push 由你决定。

---

## 2. 实测前提（本次会话取到的一手数字，每条都可复跑）

| # | 事实 | 取证方式 |
|---|---|---|
| ① | **知识中心检索读的是 IDE 建好的索引库，磁盘 Markdown 只是导出快照。** 我往 `.qoder/repowiki/knowledge/zh/…/探针试验条目.md` 写了含唯一哨兵词 `VIMRUN-SENTINEL-4417` 的页面，`SearchKnowledge` 零召回。 | 哨兵负向探针（探针文件已删，知识树回到 46 个文件） |
| ② | IDE 索引冻结在 `exported_at: "2026-08-14T20:26:24Z"`，`nodes_managed: true`；`.qoder/repowiki/zh/meta/repowiki-metadata.json` 的 `wiki_repo.last_commit_id` 只约束 IDE 生成器。 | `head -40 .qoder/repowiki/knowledge/zh/_index.yaml` |
| ③ | 正文树 **450 个 md / 9.0 MB**，最大单页 26 KB；整个 `.qoder/repowiki` 只有 490 个 md + 7 个 yaml + 2 个 json + 1 个 jsonl，**没有图片等二进制**。 | `find \| wc -l`、`du -sh`、扩展名分布 |
| ④ | 知识树 **46 个文件 = 6 个模块目录 × 5 面（概述/架构设计/技术栈/编码规范/特殊配置与命令）＝30 ＋ 9 个仓库级卡片（含业务术语表）**；`_module.yaml` 字段 `module_path/title/scope/source_files/depends_on/related_to`。**知识树里没有 Pine 引擎模块。** | `find -name '*.md' \| sed \| uniq -c` |
| ⑤ | `.qoder/` 写在 `.git/info/exclude` 里，`git ls-files .qoder` = 0 → **git 完全不知道它存在，没有任何撤销能力**。 | `cat .git/info/exclude` |
| ⑥ | **`docs/` 被 `.gitignore:124` 整目录忽略**，且门禁 (b) 用 `--exclude-dir=docs` 主动豁免它（脚本注释自证理由，并引用记忆 `feedback_no_push_docs`）。所以「把 wiki 放 `docs/` 就自动绕开商标门禁」是**假的安全感**：一条豁免本意是给内部规划文档的，不是给即将公开发布的文档树的。 | `grep -n docs .gitignore`、`tools/ci_grep_gates.sh:59-66` |
| ⑦ | 门禁 (b) 只扫 `*.py/*.md/*.html/*.json` 里的 `worldquant`；实测**正文树 0 页命中，知识树 1 个文件命中**。门禁 (c) 只扫 `wiki/`，不碰新树。 | `grep -rli` 计数 |
| ⑧ | 正文树里 `NNNNNN.SH/SZ/BJ` 与 `XXXX.US` 样式：**29 个文件 / 52 处 / 无单文件 >10**，属散文举例级，不是 §Vendor 数据 ToS 要拦的批量数据外泄。 | 逐文件命中计数直方图 |
| ⑨ | QMind 插件在 CLI 可用：`list_notebooks` 返回 `totalSize: 0`；工具面只有 `add_source / get_source / list_notebooks / list_sources / read_source / retrieve`——**没有 update，也没有 delete，入库是只进不改的**。也没有 `create_notebook`。 | `mcp_call list_notebooks` + `mcp_get add_source/retrieve` |
| ⑩ | `add_source` 接受 `kind: file`（`filePath`）或 `kind: text`（`content ≤ 200 000` 字符）；`retrieve` 一次最多 5 个 notebook。 | schema 实测 |
| ⑪ | 链接层已经收口：`reanchor --apply` 全仓改写 **5584 条链接 / 423 页**，改动 **5559 行且每行两侧都带链接**、**0 处行数变化**、重跑 dry 得 0 新提案（幂等），并由独立 `loop.py` 做字节级复核。台账 **426 行**。页面状态 `450 = 423 partial + 22 stale + 4 clean + 1 reconciled`。守卫测试 **77 例全绿**，4 个变异探针被杀死。 | `.qoder/tmp/sweep_apply.txt`、`audit_shape2.txt`、`drift_state.py` |
| ⑫ | **门禁 (b) 本地现在是红的，CI 是绿的。** `EXCLUDE_DIRS`（`ci_grep_gates.sh:42`）里没有 `.qoder`，而 grep 走的是文件系统，于是扫到了被 `.git/info/exclude` 排除的 IDE 导出物；CI 的 checkout 里没有这个目录，所以从不报。**唯一一处命中是门禁规则自己的文字**——那张「CI 流水线与安全门禁脚本 / 架构设计」卡片里写着 `b: 禁止字面量 'WorldQuant'`。也就是说：这不是商标违规，是**扫描范围口径**（文件系统的树 ≠ 交付的树）造出来的假缺陷，且它恰好挡住了本次把内容迁入 git 的路。 | `bash tools/ci_grep_gates.sh` 完整输出存档于 `.qoder/tmp/gates_post.txt`（`gate b FAIL` + 末行 `one or more gates failed`） |
| ⑬ | **本仓库是 fork，且同步是 merge 制的——所以「不动上游原始部分」是一条可以用一条命令证伪的要求，不是一种态度。** `upstream/main` 是 `main` 的严格祖先（`main` 领先 **165** 个 fork 提交、落后 **0**）；`.gitignore`／`tools/ci_grep_gates.sh`／`.github/workflows/test.yml`／`wiki/**`（42 个文件）在上游树里**都存在** ⇒ 上游拥有，改了就在每次同步时冲突；`sync.bat`／`.github/workflows/sync-upstream.yml`／`tools/wiki_drift.py`／`repowiki/`／`docs/` 上游计数为 0 ⇒ fork 拥有。上游同步工作流走 `fetch upstream` → `merge upstream/main --no-edit` → `push origin main`，冲突时 `::error::upstream merge conflicted` 显式失败，**没有 force/reset**，所以 fork 新增的独有路径能被 merge 带过来而不会被覆盖。 | `git merge-base --is-ancestor`、`rev-list --count`、`git ls-tree -r --name-only upstream/main -- <路径> \| wc -l`、两个同步入口读原文 |

---

## 3. 已否决的方案

| 方案 | 否决理由 |
|---|---|
| 继续用 IDE 重生成 + CLI 只读 | ② 已证 CLI 无法触发；上游一同步就静默变旧，正是这次要解决的问题。 |
| 把 `.qoder/` 整目录 `git add -f` 进版本库 | ⑤ 是唯一让它「不进 git」的原因，但整目录入库会把 ⑦ 的那 1 个 `WorldQuant` 命中变成 CI 阻断（`EXCLUDE_DIRS` 里没有 `.qoder`），还会把 IDE 的加密导航、探针残留一起锁进历史。**要进 git 的是内容，不是 IDE 的容器。** |
| 只做 QMind 入库、不留仓库文件树 | ⑨：只进不改，编辑一次就多一份过期副本；且知识内容不在版本库里就没有 diff、没有 CI、没有回滚。 |
| **改上游文件来给新树让路**（把门禁 (b) 换成 `git grep`、给 `EXCLUDE_DIRS` 加 `--exclude-dir=.qoder`、改 `.gitignore` 放行 `docs/repowiki/`、把新鲜度检查塞进 `test.yml`） | 这四条都动上游拥有的文件（⑬ 实测归属），与用户规则「开发部分不要动需要同步的开源程序原部分」直接冲突；代价是每次 `merge upstream/main` 都要人工重新解决同一处冲突，收益只是「本地门禁变绿」这种表象。**全部作废**，替代品见 §9.2（改写措辞 ＋ fork 自带按路径限定的守卫用例）与 §9.1（新增工作流文件）。 |
| 把 450 页按「模块 × 面」压成 30 页重写 | 丢内容。现有 450 页里有大量按优化器/数据源/组件逐项著述的深度页，压平即不可逆降级。 |

---

## 4. 架构总览

```
                      ┌─────────────────────────────────────────┐
     播种（一次性）    │  repowiki/               ← 唯一事实源，git 跟踪  │
  .qoder/knowledge ──┐│  ├─ INDEX.md            生成的纯文本导航        │
  .qoder/zh/content ─┼┼▶ ├─ modules/<slug>/      6+1 模块 × 5 面        │
  代码 + 记忆条目 ───┘│  │   └─ overview.md …    （含新增 pine-engine） │
                      │  ├─ topics/<16 顶层目录>/ 450 页，路径不变       │
                      │  ├─ ledger.jsonl         担保日志（426 行起）    │
                      │  └─ drift/               DRIFT.md drift.json    │
                      └───────────────────┬─────────────────────────────┘
                                          │ 读写
              ┌───────────────────────────┴──────────────────────────┐
              │ tools/wiki_drift.py --wiki-root repowiki             │
              │   report  谁过期了（页面级 verified_at，不再读 IDE 元数据）│
              │   stale   过期队列（JSON，M5 的输入）                   │
              │   reanchor 链接坐标自动改写（--apply，已证幂等）        │
              │   mark    人工盖章，cites: all                          │
              │   index   重新生成 INDEX.md（两次跑字节相同）           │
              └───────────────────┬──────────────────┬────────────────┘
                                  │                  │
                    CI 新鲜度门禁  │                  │  tools/wiki_qmind.py plan
                    （只报阈值，不拦推送首轮）           （sha 去重的入库清单，Agent 发 MCP 调用）
                                                       QMind notebook（语义召回）
```

四层各司其职：**A 文件树**是事实源；**B 工具**算漂移、改链接、盖章；**C 规程**让 Agent 无人值守重写散文；**D 检索**给未来的会话用（`Grep` 永远准，QMind 供语义召回）。

---

## 5. A 层：目录与文件格式

### 5.1 路径布局

```
repowiki/                        # 仓库根级；与上游公开文档站 wiki/ 无关
  INDEX.md                     # 生成物，禁止手改
  README.md                    # 人写的三句说明：这是什么、怎么更新、谁是事实源
  modules/
    repo-root/                 overview.md architecture.md tech-stack.md conventions.md commands.md
    agent-backend/             同上 5 面
    frontend-app/              同上 5 面
    pine-engine/               同上 5 面        ← 新增，知识树里现在完全没有
    electron-desktop/          同上 5 面
    wiki-static-site/          同上 5 面
    ci-gates/                  同上 5 面
  cards/                       # 9 个仓库级卡片（依赖管理/构建/日志/配置/Tailwind/错误处理/网关/同步工作流/业务术语表）
  topics/                      # 450 页，16 个中文顶层目录原样保留
  ledger.jsonl                 # 担保日志，追加式
  drift/DRIFT.md  drift/drift.json   # report 的输出，可重生成，进 git 便于对比历史
```

- **模块目录与卡片用 ASCII 文件名**（`overview.md` 等）：CJK 文件名在本机造成过实际困难（全角逗号出现在文件名里导致脚本切分出错）。新写的一律 ASCII。
- **`topics/` 保留中文目录名与相对路径不变**，这是关键约束：`ledger.jsonl` 的 426 行用「相对 content 根的路径」作页面主键，路径不变 ⇒ 台账无需迁移即可继续命中。

### 5.2 页面 frontmatter（每页新增，工具写入）

```yaml
---
page: 回测引擎/投资组合优化器/最大分散化优化器.md   # 相对 topics/ 的稳定主键
sources:                                        # 由页内 <cite> 块自动推导，是过期判定的依据
  - agent/backtest/optimizers/max_diversification.py
  - agent/backtest/constraints.py
verified_at: 3212111e…                          # 40 位，本页散文上次核对时所处的 commit
anchors: verified                               # verified | open —— 链接坐标状态
vouch: applied-only                             # applied-only | all，与 ledger 的 cites 字段同义
---
```

设计要点：

- **基线下沉到页面**。现在 `report` 用的是 `.qoder/.../repowiki-metadata.json` 里的**一个全局 commit**（`metadata_baseline()`，`wiki_drift.py:221`），这是 IDE 的产物，CLI 改不动它；换成每页自带 `verified_at` 之后，「这页上次是在哪个 commit 核过的」跟着页面走，git 里可 diff、可回滚。
- `sources` 与 `<cite>` 块**双写**：`<cite>` 给人看（IDE/前端渲染），frontmatter 给工具读（不用每次正则解析 HTML -ish 块）。二者不一致时 `report` 报警，防止只改一处。
- `vouch` 沿用本次刚修好的担保口径（`cites: all` 只允许人工 `mark` 写；`reanchor --apply` 只能写 `applied-only`）。这条纪律不能因为搬家而退化——它正是上一轮 414 条隐藏待办的成因。

### 5.3 导航生成物 `INDEX.md`

现在的目录树元数据字段值是 `WikiEncrypted:`（IDE 加密），CLI 既解不开也不该再依赖。`wiki_drift.py index` 从磁盘树生成：

```
# Repo Wiki 索引
> 生成物，由 `python -X utf8 tools/wiki_drift.py index` 重写；请勿手改。
> 共 450 页 · 其中 <n> 页自 verified_at 起其引用文件有变更 · 基线 HEAD 3212111e

## 模块
- [Vibe-Trading Agent 后端](modules/agent-backend/overview.md) — 5 面 · verified@3212111e
...
## 专题
### 回测引擎 (28 页 · 3 页待更新)
- [最大分散化优化器](topics/回测引擎/投资组合优化器/最大分散化优化器.md) `3212111e`
```

**确定性要求**（有测试）：同 HEAD 同树跑两次，字节相同 ⇒ 排序不得依赖文件系统遍历顺序，时间戳一律取自 git 而非 `now()`。

---

## 6. B 层：`tools/wiki_drift.py` 的改造点

现工具已跑通一轮完整闭环（⑪），本期是**换根 + 换基线**，不是重写：

| 位置 | 现状 | 改动 |
|---|---|---|
| `wiki_drift.py:65-70` | `WIKI = REPO/".qoder"/"repowiki"`、`CONTENT = WIKI/"zh"/"content"`、`META = …/repowiki-metadata.json`、`UPDATE_DIR = WIKI/"update"`、`LEDGER = UPDATE_DIR/"ledger.jsonl"` 全部硬编码 | 引入 `WikiRoot` dataclass，由 `--wiki-root`（默认 `repowiki`）解析：`content=<root>/topics`、`ledger=<root>/ledger.jsonl`、`drift_dir=<root>/drift`。`.qoder` 老路径通过 `--wiki-root .qoder/repowiki-legacy` 仍可指，保留一个版本周期。 |
| `metadata_baseline()`（221） | 读 IDE 全局元数据 | 删除调用路径。基线来源改为页面 frontmatter `verified_at`；仅播种脚本一次性读取它，把值写进各页 frontmatter，此后不再读。 |
| 页面读取 | 从磁盘正文解析 `<cite>` 取引用 | 优先读 frontmatter（`sources`/`verified_at`/`anchors`/`vouch`），缺失则回落 `<cite>` 并在报告里标 `no-frontmatter`（反空断言会立刻暴露漏播种）。 |
| `cmd_report`（1214）/`build`（1146） | 全局基线 vs HEAD | 判定改为**逐页** `verified_at..HEAD` 是否有 `sources` 变更；状态机四态保持 `reconciled/partial/stale/clean` 语义不变，`partial` 仍**不**推进报告基线。 |
| `cmd_reanchor`（1005） | 已证幂等、0 行数变化 | 逻辑不动，只改根解析 + 改写成功后把 `anchors: verified` 回写 frontmatter。 |
| `cmd_mark`（1244） | 手写 `cites: all` 进 ledger | 同步回写该页 `vouch: all`、`verified_at: HEAD`。 |
| **新增 `stale`** | — | `stale [--page SUB] [--json] [--top N] [--format queue\|count]`：输出「自 `verified_at` 起其 `sources` 有 commit」的队列，附每页 `commits_since`、`changed_sources`、`missing_sources`；`--format count` 只打一个整数（CI 门禁读它，故两种格式的稳定性都进测试）。这是 M5 散文重写的输入。实现走一次 `git rev-list`/`git diff --name-only` 批量取变更集再按页分配，**不做每页一次 git 调用**（450 页 × 子进程 = 分钟级；批量 = 一次）。 |
| **新增 `index`** | — | 生成 §5.3 的 `INDEX.md`，`--check` 模式只比较不落盘（CI 用）。 |
| **新增 `seed`** | — | 一次性播种：从 `.qoder` 两棵树拷贝 + 计算逐文件 sha256 对账 + 注入 frontmatter。**必须幂等且可 dry-run**，输出 `pages_written/pages_skipped/sha_mismatch=0`。 |

不改的东西，明确列出来以免「顺手优化」：**`cites` 担保范围语义、`partial` 不推进基线、sha 判定的 `ledger-void`、编辑器行数口径（`newlines+1`，正是 3194 处 EOF 引用被判健康的成因）、越界两分类措辞**。这五条都是本轮踩过坑之后定下的契约。

### 6.1 配套测试（`tools/test_wiki_drift.py`，现 77 例）

新增分组，全部自带语料、不依赖真实 `.qoder`：

- `--wiki-root` 指向 tmp 目录时，report/reanchor/mark 三者都在新根上生效，且**绝不再碰 `.qoder`**（断言旧根字节未变）。
- frontmatter 回落：缺 `verified_at` 的页必须被列进报告而不是被当成「基线 = HEAD」静默通过（这是 §5.2 双写不一致的观测点）。
- `stale`：构造两页 + 两个 commit，断言只有引用了被改文件的那页进队列；`missing_sources` 单列。
- `index --check`：两次生成字节相同；`no-frontmatter` 计数 > 0 时不通过（反空）。
- `seed` 幂等：连跑两次，第二次 `pages_written == 0`；人为破坏一个文件后 sha 对账必须报错。
- 对每一条新代码行做**变异探针**，三态判定（killed / survived / harness-blind），跑完字节还原——沿用 `mut_cites_run.py` 的写法（needle 唯一性检查 + `finally` 还原 + 控制组必须绿）。

---

## 7. C 层：更新闭环操作规程（这是「自动」的真实含义）

**不是 IDE 的重生成按钮，是 Agent 按队列干活。** 可复制命令：

```bash
cd "E:/Vibe-Trading-main/Vibe-Trading-main"

# 1) 谁过期了（队列 + 计数）
python -X utf8 tools/wiki_drift.py stale --json > .qoder/tmp/stale.json
python -X utf8 tools/wiki_drift.py report            # 重写 drift/DRIFT.md

# 2) 链接坐标自动改写（先 dry 再 apply，工具本身已证幂等）
python -X utf8 tools/wiki_drift.py reanchor --shifts
python -X utf8 tools/wiki_drift.py reanchor --shifts --apply

# 3) 一个目录一个目录重写散文：Agent 读该页 sources 的当前代码 → 改正文 → 盖章
python -X utf8 tools/wiki_drift.py mark --page 回测引擎/投资组合优化器/最大分散化优化器.md -m "重写优化器接口段，对齐 max_diversification.py@3212111e"

# 4) 导航重算
python -X utf8 tools/wiki_drift.py index
```

批量重写用**并行子代理按目录分片**（每片一份互不重叠的页面清单，这是本项目整合记忆时验证过的做法：给不出互不重叠清单就会漏项/重复认领）。每片完工的标准不是「我写完了」，而是该片页面在 `stale` 队列里消失且 `mark` 进了 ledger。

可无人值守到什么程度：`qoder_cron` 可以排一个每周任务，跑步骤 1+2+4（纯机械、可证幂等），**散文重写（步骤 3）默认不进定时任务**——它需要读代码做判断，出错会静默写错文档，宁可人推一把。

---

## 8. D 层：检索

| 通道 | 状态 | 说明 |
|---|---|---|
| `Grep` / `Read` 打 `repowiki/` | **主通道，永远准** | 就是磁盘文件，无索引、无 staleness。 |
| `SearchKnowledge` | 会长期显示过期 overview | 它读的是 ② 那份 2026-08-14 的 IDE 索引。**处置**：写一条项目记忆「wiki 事实源在仓库根 `repowiki/`，`SearchKnowledge` 的 overview 是 IDE 冻结快照」，并在 §11 从新树再生成知识时明确它不会出现在那里。 |
| QMind `retrieve` | 语义召回，只进不改 | 见下。 |

### 8.1 QMind 入库（⑨⑩ 的形状决定了只能这样做）

- **没有 `create_notebook`**：先用 `add_source` 带一个约定 `notebookId`（`vibe-trading-repowiki`）做一次单条探针。若服务端拒绝未知 id，则这一步需要你**在 QMind 里手工建一个 notebook**，我把 id 写进 `repowiki/.qmind.json`。探针只送 1 条，不整批上传。
- **只收慢变的聚合层**：7 个模块 × 5 面 = 35 个文件 + 9 张仓库级卡片 ≈ 44 条 source；450 个专题页**不整批入库**（⑨ 没有 update/delete，450 条会在几次编辑后变成历史副本堆）。
- **sha 去重**：`tools/wiki_qmind.py plan` 比对 `repowiki/.qmind-state.json`（记 `{path, sha, sourceId}`），只对内容变过的页出清单；`title` 固定为 `<相对路径>@<sha 前 7 位>`，这样**即便产生第二条也是可识别的**，`list_sources` 可对账。
- **正证探针**：入库后取一个**只存在于新树**里的哨兵短语（例如新写的 `pine-engine` 页面里的唯一标识串），用 `retrieve` 查它。查得到 ⇒ 入库真的落地（正好是 §2 ① 那次负向验证的反面）。查不到 ⇒ 判定 QMind 通道不可用，退回「Grep 为主 + 记忆条目指路」，并把这一点如实写进 `项目档案.md`，不假装成功。
- 需要你知情：入库等于把这部分仓库文本送到 QMind 服务端。这些文本本来就要提交进公开的 GitHub 仓库，所以不新增暴露面。`modules/ci-gates/architecture.md` 里含那句对门禁政策自己的描述（⑫ 的唯一命中），按 §9.2 改成不携带字面量的转述后再入库——改写只发生这一次，且 `seed` 会把它记成 `reworded=1`。

---

## 9. E 层：门禁与 CI

### 9.1 新增 `tools/wiki_freshness_gate.sh`

```bash
# tools/wiki_freshness_gate.sh —— 只读：不改文件、不建仓、不安装
# Threshold-based, not zero: a fork cannot chase 450 pages instantly, and a
# gate that is always red gets switched off. WIKI_STALE_MAX is the tuning knob;
# its shipped default is the measured water level at M3 time (423 partial + 22
# stale = 445), and M5 lowers it shard by shard.
STALE=$(python -X utf8 tools/wiki_drift.py stale --format count)
echo "wiki stale pages: $STALE (threshold ${WIKI_STALE_MAX:-445})"
if [ "$STALE" -gt "${WIKI_STALE_MAX:-445}" ]; then
    exit 1
fi
# Deterministic check: INDEX.md must equal what `index` would write today.
if ! python -X utf8 tools/wiki_drift.py index --check; then
    echo "INDEX.md is stale - run: python -X utf8 tools/wiki_drift.py index"
    exit 1
fi
exit 0
```

这个脚本**只做两件新鲜度的事**（过期水位 + 导航确定性）。商标与股票代码那两条继续只在 `ci_grep_gates.sh` 里各有一份实现，不在这里复制模式串——一条政策有两个实现，早晚只改一个。

**阈值初值的依据**：当前水位是 423 `partial` ＋ 22 `stale` = 445 页待更新（⑪）。M1–M3 只换根、搬内容、加机器，**一行散文都不改**，所以首跑必然是 445 ⇒ **`repowiki-freshness.yml` 首轮 `continue-on-error: true`，且 `WIKI_STALE_MAX` 初值设 445**（把现状钉住、不许恶化），M5 每收口一片就把阈值往下压一次。「阈值 = 当前实测水位、只降不升」是刻意的：门禁第一天就红，结局是被人关掉而不是被人修。

- **工作流必须是新增文件，不改上游的 `test.yml`**（§9.2 的归属表）：`.github/workflows/repowiki-freshness.yml`，`schedule: weekly` ＋ `workflow_dispatch`，`actions/checkout` 用 `fetch-depth: 0`（`stale` 需要历史里存在各页的 `verified_at` commit，浅历史会失真），首轮 `continue-on-error: true`，观察两周、阈值定准了再改成阻断。文件名刻意避开上游已有的 6 条（`desktop-windows` / `docker-build` / `loader-health` / `test` / `wiki-deploy` / `wiki`），也不与 fork 自有的 `sync-upstream` 撞。
- `index --check`（确定性检查，不依赖历史深度）**同样放进这个新工作流**，不进上游的 `test.yml`。代价是它只在每周/手动触发时跑，不是每次推送都跑；接受这个代价，因为换到的是零上游改动。真要每次推送都跑，做法是在 `repowiki/` 侧自有守卫（§9.2 末段）之外加一条 pre-commit 钩子——本期不做，属可后补项。

### 9.2 商标门禁：**不改上游脚本**，改新树的措辞 ＋ fork 自带守卫

用户规则（本轮重述）：本仓库是开源项目的二次开发，**开发不得触碰需要同步的上游原始部分**。据此先测归属（`git ls-tree upstream/main -- <路径>`）：

| 路径 | upstream/main 里存在？ | 结论 |
|---|---|---|
| `tools/ci_grep_gates.sh` | 1 | **上游拥有，不可改** |
| `.gitignore` | 1 | **上游拥有，不可改**（`docs/` 那条忽略规则就是它 124 行写的） |
| `.github/workflows/test.yml` | 1 | **上游拥有，不可改**（上游另有 `desktop-windows` / `docker-build` / `loader-health` / `wiki-deploy` / `wiki` 共 6 条） |
| `wiki/**` | 42 | **上游拥有**（公开文档站），本期一个字节不动 |
| `sync.bat`、`.github/workflows/sync-upstream.yml` | 0 | fork 拥有——同步机制本身就是我们加的，实测两者都是 merge/pull 制，无 force/reset（⑬） |
| `项目档案.md` | 0 | fork 拥有（`70a16c64 本地自定义⑤`），已在用 |
| `tools/wiki_drift.py`、`tools/test_wiki_drift.py` | 0 | fork 拥有（`bccc02a2` 新增） |
| `docs/` | 0 | 上游根本没有这个目录，且被上游 `.gitignore:124` 忽略 |

所以 ⑫ 那个「门禁 (b) 按文件系统扫 ⇒ 本地红、CI 绿」的口径缺陷**本期不修**——修它要动上游脚本，收益（本地/CI 一致）不值这个冲突代价。它已经作为已知事实写进 `项目档案.md`，识别方法只看一行：**命中路径以 `./.qoder/` 开头就是它，不是回归**。

那门禁怎么办？答案是**让它照常扫我们，我们措辞合规**：新树落在仓库根的 `repowiki/`（§10.1），不在 `docs/` 的豁免范围内，于是上游的 (b) 会主动检查这棵发布物树——**上游的工具替我们执法，比我们自己豁免更好**，且零改动。实测这一页需要改写（⑦/⑫ 的唯一命中，`modules/ci-gates/architecture.md` 里那句政策转述）：

```
b: 禁止商标字面量，见 `tools/ci_grep_gates.sh`
```

不是掩盖：这条政策本就管发布物，而 `repowiki/` 是发布物；门禁脚本自己带字面量是它工作的必要条件（`grep -v "$SELF"` 就是这个豁免的机制），一篇转述政策的文档没有这个必要。播种输出显式记账 `reworded=1` 并点名，sha 对账断言写成「**除这 1 页外**每页去掉 frontmatter 后与源文件字节相同」——例外要数得出来，否则「例外」就是漏播种的遮羞布。

**fork 自带守卫（这条是必需的，不是可选）**：在 `tools/test_wiki_drift.py` 里加一条用例，用与上游 (b) 相同的模式串**按路径限定**扫 `repowiki/**` 并断言 0 命中。为什么是「按路径」而不是「整个跟踪集减掉脚本自身」：实测 `git grep -icE '<该字面量>'` 在排除 `tools/ci_grep_gates.sh` 之后为 0，而那个上游脚本**自己带 5 处**（`grep -v "$SELF"` 就是这个豁免的机制）——一条断言「跟踪集 = 0」的用例第一天就是红的，而且它会随上游怎么写注释而失效。
理由就是本轮实证过一次的那件事：我写这一节时把那个字面量落进了被跟踪的 `项目档案.md`，`git grep` 立刻给出「除门禁脚本外命中 1 个文件」，而 `bash tools/ci_grep_gates.sh` 那时**已经是红的**（因为 ⑫），新命中完全混在既有噪音里看不出来。推送之后才会变成 GitHub CI 的阻断。所以本地必须有一条只针对新树、断言明确、不会被 `.qoder` 干扰的检查。

**已删掉的旧方案**（保留记录，免得后续会话又捡起来）：原设计要改 (b) 为 `git grep`（只查跟踪文件）＋ 给 `EXCLUDE_DIRS` 加 `--exclude-dir=.qoder` ＋ 改 `.gitignore` 放行 `docs/repowiki/`。三条都动上游文件，与用户规则冲突，**全部作废**；`docs/repowiki` 这个落点也随之换成根级 `repowiki/`（实测 `git check-ignore` 未忽略、`git status` 直接给 `?? repowiki/`，不需要任何忽略改动）。

**已知但未修的同类暴露**：门禁 (a) 同样按文件系统扫 `*.py`，会扫到 `.qoder/tmp/` 下 106 个探针脚本——今天 0 命中所以看不出来，探针里哪天出现 `yaml.load(` 就会本地红。与 ⑫ 一起记为遗留，不动上游。

### 9.3 股票代码样式（⑧，判定为**不构成阻断**）

52 处 / 29 文件 / 无单文件 >10，是散文举例级，且门禁 (c) 的扫描范围本来就是 `wiki/`。本期动作：仅在 `项目档案.md` 留一句「已量过，判定为散文级」，不改内容、不扩门禁。**如果后续要把 `repowiki/` 也接入 (c)，得先做同类计数断言，不能直接套 `wiki/` 的批量口径**（那是 §「扫描口径造出的假缺陷」那个坑）。

---

## 10. F 层：`.qoder/` 处置与两个待决定项

### 10.1 决定 1 —— `.qoder/` 要不要进版本库：**内容进 git，容器不进**

| 资产 | 体量 | 处置 |
|---|---|---|
| `zh/content/*.md` | 450 页 / 9.0 MB | **播种进 `repowiki/topics/`，进 git。** 之后 `.qoder` 里那份改名归档：`.qoder/repowiki/zh/content` → `.qoder/repowiki/_ide-export-retired-2026-10-01/content`（**移动不删除**，可逆；避免同一棵树两份真相）。 |
| `knowledge/**/*.md` | 39 个 md | 同上，播种进 `modules/` + `cards/`。 |
| `update/ledger.jsonl` | 426 行担保记录 | **进 git**，落在 `repowiki/ledger.jsonl`。这是「哪页在哪个 commit 被谁担保过」的唯一审计凭据，不能只活在排除目录里。 |
| `zh/meta/repowiki-metadata.json`、`_index.yaml`、`WikiEncrypted` 导航 | IDE 私有 | **不进 git**，随归档留在原地。它只对 IDE 生成器有意义（②）。 |
| `.qoder/tmp/` 探针脚本 | 106 个 py | **保持仓库外归档**（已在 `E:/Vibe-Trading-main/vibe-trading-tmp-backup-2026-10-01`）。被 `项目档案.md` 引用的少数取证脚本（`mut_cites_run.py`、`audit_sweep_shape2.py`、`drift_state.py`）值得**改写成正经测试**，改写完成后才算保全，其余留在归档里。 |

**落点为什么是根级 `repowiki/`，且不需要任何忽略改动**（替代原方案的 `docs/repowiki/` ＋ `.gitignore` 补丁）：

- `.gitignore` 是上游拥有的文件，改它就是「动了需要同步的上游原始部分」，与用户规则冲突（§9.2 归属表）。
- 上游 `.gitignore:124` 的 `docs/` 整目录忽略会让 negation 失效，非改不可 ⇒ 反过来证明 `docs/` 这个落点本身就选错了：它要求一次上游文件改动才能工作。
- 根级 `repowiki/` 实测：`git check-ignore -v repowiki/probe.md` 返回未忽略（rc=1），`git status --porcelain` 直接给 `?? repowiki/` ⇒ **无需碰任何忽略规则即可跟踪**。upstream/main 的根条目里也没有 `repowiki`（现有 26 项：`agent`/`frontend`/`desktop`/`wiki`/`tools`/`assets`/`scripts`/`docs` 均不存在同名），未来上游新增同名目录才会冲突，概率低且冲突会在 `sync-upstream.yml` 的 merge 里显式报错，不会静默覆盖。
- 命名代价要认：根级 `repowiki/` 与上游的公开文档站 `wiki/` 是两个东西（前者是仓库自述的导出物，后者是 Cloudflare Pages 站点）。`README.md` 第一行就写清这个区别，`wiki/` 一个字节都不动。
- `.qoder/` 继续留在 `.git/info/exclude` 里（本机生效、永不提交）——这正是它当初被写进 exclude 而不是 `.gitignore` 的原因，本次不改。

### 10.2 决定 2 —— 父目录键那 64 条过期分叉记忆：**原地留着 + 约定，不删**

按你的倾向执行。理由与本次实测一致：那个键（`e--Vibe-Trading-main`，工作区根误开在 `E:\Vibe-Trading-main`）里是 2026-08-28 的旧分叉，双gram 相似度对照显示**没有任何独有内容**，删除不可逆而收益为零。

落地动作（不是口头承诺，是两处可检查的东西）：

1. 已存在的记忆条目 `ref-four-project-keys.md` 里补一行约定：**「任何『打开项目』的建议都必须指向 `E:\Vibe-Trading-main\Vibe-Trading-main`」**（已有该句，补「含 IDE / CLI / 新会话」的限定）。
2. `项目档案.md` 增加一句同样的约定，让不读记忆的人（和未来 IDE 会话）也撞得上。

---

## 11. 播种来源清单（M2 的输入）

| 目标位置 | 来源 | 校验 |
|---|---|---|
| `topics/**`（450） | `.qoder/repowiki/zh/content/**` 逐字节复制，仅前置 frontmatter | 每页去掉 frontmatter 后与源文件 sha256 相同 |
| `modules/<6 个知识树模块的 slug>/*`（30） | `.qoder/repowiki/knowledge/zh/…/<模块>/<面>.md`（6 个模块目录 × 5 面，④） | 同上 + 面名映射表（中文面名 → ASCII 文件名）写进 `README.md`；其中 `modules/ci-gates/architecture.md` 是**全树唯一被改写的播种页**（去掉那个商标字面量、保留指向门禁脚本的指针，§9.2），`seed` 必须打印 `reworded=1` 并列出页名 |
| `cards/*`（9） | 知识树 9 个仓库级卡片，含 `业务术语表.md` | 同上；⑦ 实测正文与知识树里该字面量命中数为 0 / 1，唯一那 1 处即上一行的 `modules/ci-gates/architecture.md` |
| `modules/pine-engine/*`（5） | **无现成来源** —— 从 `frontend/src/lib/pine*.ts` 源码 + 本项目 8 条 Pine 记忆条目（语法器/求值语义/内置函数契约/复合值模型/绘图通道/MTF/架构边界/SignalEngine 桥）加 1 条语料 harness、1 条前端 CSP 硬约束撰写 | 每页 `sources` 非空且文件真实存在；`anchors` 允许 `open`，但**不许**标 `verified`（未经核实的盖章正是 §5.2 那条纪律要拦的） |
| `ledger.jsonl` | `.qoder/repowiki/update/ledger.jsonl` 426 行原样 | 行数一致 + 每行 `page` 在新树里可解析 |

---

## 12. 验证计划（每层各自的「测过了」是什么）

| 层 | 证据 | 失败长什么样 |
|---|---|---|
| 播种 | 逐文件 sha256 对账表；`topics/` 450 ＋ `modules/` 35 ＋ `cards/` 9 = 494 页；`sha_mismatch == 0`；`reworded == 1` 且点名是 `modules/ci-gates/architecture.md`；frontmatter 解析全通过 | 数字来自脚本，不来自我的描述（本项目纪律：验收输入本身不可信）。**改写页数必须数得出来并列出页名**，否则「例外」就成了漏播种的遮羞布 |
| 反空断言 | 新树 `*.md` 计数 > 400；`sources` 非空页数 > 400；`stale` 队列在全 HEAD 下非空 | 空集合真空通过是本项目反复踩过的假绿 |
| B 工具 | 现有 77 例保持全绿 + 新增组（§6.1）；每条新代码行变异探针三态并字节还原 | 探针 `red=[]` 而通过数等于基线 ⇒ 判等价变异 ⇒ 换观测点，**不许放宽断言** |
| 幂等 | `seed` 连跑两次 `pages_written=0`；`reanchor --apply` 后重跑 dry 得 0 提案；`index` 两次字节相同 | 与 ⑪ 同口径 |
| 形状审计 | 独立脚本复查：改动行必须两侧都带 `file://` 链接、行数不得变化（沿用 `audit_sweep_shape2.py` 的 v2 谓词；v1 的过严判定曾误报 154 处） | 用自己的口径复核自己的结论，别只信工具自检 |
| 门禁 | **上游脚本一个字节都不改**（§9.2），所以这里验的是「我们没污染它」：M2 前后各跑一次 `bash tools/ci_grep_gates.sh` 并 diff 留档（`.qoder/tmp/gates_post.txt` 是既有基线那份）。要求：失败集**逐行相同**（既有那条 `./.qoder/…:2:` 噪音 ±0，新树贡献 0 命中），且守卫用例（按路径限定的 `repowiki/**` 断言，不是「整个跟踪集 = 0」——上游脚本自身合法带 5 处，见 §9.2）必须**能红**：临时往 `repowiki/` 放一个字面量，用例必须失败，随即删掉并还原 | 验收看的是 diff，不是「全绿」二字——脚本本来就是红的（⑫）。**只测「能抓到」不够**：还要测守卫扫的确实是 `repowiki/**` 而不是空集合（把 pathspec 改掉，用例应当变成 0 命中而通过 ⇒ 那它就是死代码），这就是本项目「扫全仓守卫测试的两种假绿」那个坑 |
| QMind | `retrieve` 召回**只存在于新树**的哨兵短语（§8.1 正证） | 召回失败必须报「通道不可用」，不得用「大概进去了」代替 |
| 端到端 | 挑 1 页做完整闭环：`stale → reanchor --apply → 重写散文 → mark → index`，然后 `report` 显示该页 `reconciled` | 收口一页先验证机器，再谈批量（试点→全仓的既有节奏） |
| 工作区洁净 | 每步结束 `git status` 只应出现预期路径；`.qoder` 未入库 | 排除目录里的意外改动没有 git 撤销能力（⑤） |

---

## 13. 里程碑与验收门槛

| | 内容 | 完工判据 | 提交 |
|---|---|---|---|
| **M1** | `WikiRoot` 换根到根级 `repowiki/` + frontmatter schema + **fork 自带守卫用例**（§9.2 末段：用上游同款模式串扫 `repowiki/**` 断言 0 命中）＋ `repowiki/README.md` 写清与上游 `wiki/` 的区别 | **零上游文件改动**可证：`git diff --name-only upstream/main...HEAD` 里不出现 `.gitignore` / `tools/ci_grep_gates.sh` / `.github/workflows/test.yml` / `wiki/**`；守卫用例能红（往 `repowiki/` 放一个字面量进去必须被抓住，随即删掉）；77 例不退。此时 `repowiki/` 只有 README，**不搬一个字节** | 1 个提交 |
| **M2** | `seed`（先 dry 再实）把 494 页搬进 `repowiki/` ＋ 提交；`.qoder` 正文改名归档；`reworded=1` 那页落地 | §12 播种/反空/幂等/形状四行全绿；归档为移动非删除；`bash tools/ci_grep_gates.sh` 的失败集与 M2 之前**逐行相同**（既有 `.qoder` 噪音 ±0，新树贡献 0 命中）；`repowiki/**` 按路径限定的守卫用例绿（M1 建的那条） | 1 个提交 |
| **M3** | 新增 `stale` ＋ `index` 生成器 ＋ `tools/wiki_freshness_gate.sh` ＋ **新文件** `.github/workflows/repowiki-freshness.yml`（`continue-on-error`，不改上游 `test.yml`） | `index --check` 两次运行字节相同；`stale --format count` 输出 445（与 ⑪ 吻合——M2 只搬不改内容，水位不可能变，数字对不上就说明搬迁或基线判定错了）；本地直接跑 `python -X utf8 tools/wiki_drift.py report` 复核同一数字（`workflow_dispatch` 要推上去才跑得动，本地先证） | 1 个提交 |
| **M4** | QMind：notebook 探针 → 44 条聚合层入库 + `repowiki/.qmind.json` 去重态 + 正证召回 | 哨兵短语可召回；`list_sources` 与 state 文件对账一致 | 工具 + 状态文件 1 个提交 |
| **M5** | 散文层重写开工（423 partial + 22 stale），按 16 个顶层目录分片 | 每片：该目录页面从 `stale` 队列消失且 ledger 有对应 `mark` | 按目录多次提交 |

M1–M3 是「机器立起来」，M5 才是「内容真的新」。**在 M5 完成之前，`repowiki/` 的散文层不能当事实源引用**——这一点必须写在 `INDEX.md` 顶部和 `项目档案.md` 里（就是原计划那句话的正式落地，只是范围从「散文层」扩到「除已收口的那 1 页之外全部」）。

---

## 14. 风险与回滚

| 风险 | 影响 | 缓解 / 回滚 |
|---|---|---|
| 9.0 MB Markdown 进 git | clone 变大；未来上游若自己在根级引入 `repowiki/` 会目录级冲突 | 纯文本、无二进制，可接受；冲突不会静默——`sync-upstream.yml` 走的是 merge，撞车时 `::error::upstream merge conflicted` 显式失败（已读原文确认无 force/reset）。回滚 = `git rm -r repowiki`，**不需要还原任何忽略规则**（根级 `repowiki/` 本来就未被忽略），IDE 那份导出物已按 10.1 保留，可再播种 |
| 同一棵树两份真相 | 改了 `repowiki` 忘了 `.qoder`（或反之） | 归档改名（10.1）让 IDE 那份不再是「当前正文」；`report` 只认 `--wiki-root` |
| QMind 只进不改（⑨） | 聚合层每次编辑多一条副本 | 只收 44 条慢变页；state 文件 + `title` 带 sha；`list_sources` 对账 |
| `SearchKnowledge` 永远读旧索引（②） | 未来会话被过期 overview 误导 | 项目记忆条目 + `INDEX.md` 顶部声明；这是不可消除的上游限制，只能标注 |
| 搬迁过程中顺手改了上游文件（`.gitignore` / `tools/ci_grep_gates.sh` / `.github/workflows/test.yml` / `wiki/**`） | 每次同步都产生冲突，正是本次要守住的那条线 | M1 的完工判据里放一条**可证伪检查**：`git diff --name-only upstream/main...HEAD` 不得出现上述四个路径；M2（搬 494 页）与 M3（落地工作流）各复用一次——这两步最容易手滑。新树本身落在上游门禁 (b) 的扫描范围内，所以「合规」是靠改写措辞达成的，不是靠新开豁免达成的 |
| `repowiki-freshness.yml` 首轮就是红的 | 门禁第一天就红，结局是被人关掉而不是被人修 | `WIKI_STALE_MAX` 初值 = 实测水位 445（只许下调，不许放宽），且首轮 `continue-on-error: true`，观察两周再改阻断（§9.1） |
| 散文重写写出静默错文档 | 比过期更糟 | M5 逐页 `sources` 白名单约束 + 每片收口判据是队列消失，不是「Agent 说写完了」；步骤 3 不进 cron |
| 未提交的 `.qoder` 资产在搬迁中丢失 | 426 行担保记录不可重建（⑤） | 搬迁前先做仓库外备份（已有 `vibe-trading-tmp-backup-2026-10-01` 与 `wiki-content-backup-2026-10-01` 450/450 sha 校验），M2 里把 ledger 纳入 git |
| 本地 `ci_grep_gates.sh` 从此**长期红一条**，且永远只有那一条 | 未来会话（含我）重跑门禁，见到 `.qoder/repowiki/knowledge/…:2` 命中会误判「新树污染了门禁」或「某步没做」，甚至去改上游脚本求全绿 | 这条命中的文件**不在 git 里**（`.git/info/exclude`），是文件系统残留的旧 IDE 导出物；⑫ 的口径缺陷本期不修（修它要动上游脚本）。识别方法只看一行：**路径以 `./.qoder/` 开头就是它，不是回归**。M2 归档改名后路径会变但仍在排除目录内，红依然存在。本条之所以值得单列：本项目吃过「同一个脚本两次运行给出矛盾结论」的亏，而这条红会长期存在，所以 `repowiki/README.md` 与 `项目档案.md` 都要各写一句，让读代码的人和读记忆的人都撞得上 |

---

## 15. 需要你确认的五件事（开工前）

里程碑编号：**M1 = `WikiRoot` 换根到仓库根 `repowiki/` ＋ frontmatter ＋ fork 自带守卫用例 ＋ README；M2 = 494 页内容播种进 `repowiki/` 并提交（含 `.qoder` 正文改名归档）；M3 = `stale`/`index`/新鲜度门禁（新增工作流文件）；M4 = QMind；M5 = 散文层重写**。

本轮按你的规则（**二次开发不动需要同步的上游原始部分**）重排过，取舍点全在下面的第 1、2 件事上。

1. **零上游文件改动是硬约束，代价记下来**（§9.2 / §10.1）。归属实测过：`.gitignore`、`tools/ci_grep_gates.sh`、`.github/workflows/test.yml`、`wiki/**` 都在 `upstream/main` 里存在 ⇒ **一律不改**。由此产生三个后果，都需要你认可：
   - ⑫ 那个「门禁 (b) 按文件系统扫 ⇒ 本地红、CI 绿」的口径缺陷**不修**，记为遗留。所以 `bash tools/ci_grep_gates.sh` 从此**长期是红的**，唯一命中路径以 `./.qoder/` 开头——不是回归，识别方法就这一行。
   - 新鲜度门禁放在**新文件** `.github/workflows/repowiki-freshness.yml`（weekly + 手动、首轮 `continue-on-error: true`），不进上游每次推送都跑的 `test.yml`。⇒ 过期水位与 `INDEX.md` 确定性**只在每周/手动触发时检查**，不是每次推送。
   - 落点从 `docs/repowiki/` 改成**仓库根 `repowiki/`**：因为 `docs/` 的整目录忽略是上游 `.gitignore:124` 写的，放行它必须改上游文件。根级 `repowiki/` 实测未被忽略（`git check-ignore` rc=1、`git status` 给 `?? repowiki/`），**零忽略改动即可跟踪**，而且它不在 `docs/` 豁免里，所以上游自己的商标门禁会主动把新树当发布物来执法——由上游的工具替我们合规，比我们自己豁免更好。命名与上游公开文档站 `wiki/` 的区别写进 `repowiki/README.md` 第一行，`wiki/` 一个字节不动。
   - 补一条 **fork 自有的守卫用例**（`tools/test_wiki_drift.py`，用上游同款模式串扫 `repowiki/**` 断言 0 命中）来顶替「改上游脚本口径」：本轮我确实把那个字面量写进了被跟踪的 `项目档案.md`，`git grep` 给出「除门禁脚本外命中 1 个文件」，而当时 `ci_grep_gates.sh` 已经因为 ⑫ 是红的，新命中会完全淹没在既有噪音里。M1 完工判据包含一条可证伪检查：`git diff --name-only upstream/main...HEAD` 里不得出现上面那四个路径。
2. **M2：9.0 MB / 494 页 Markdown 进 git**，且 `.qoder/repowiki/zh/content` 播种后**改名归档**（移动，不删除）。
3. **M2 附带的一处改写**：全树唯一被改动的播种页是 `modules/ci-gates/architecture.md`，把那句政策转述里的商标字面量换成不携带字面量的等价写法、指针保留（§9.2）。这是「发布物遵守本仓库自己的商标政策」，不是为过门禁掩盖问题——`seed` 会把它记成 `reworded=1` 并点名。
4. **QMind 只入库聚合层 44 条**（7 模块 × 5 面 = 35 ＋ 9 张仓库级卡片），450 个专题页不整批入库——⑨ 的 store 只进不改，专题页高频编辑会在几次同步后变成历史副本堆。
5. **M5 之前的 wiki 定性为「链接层已核、散文层未核，别当事实源」**，写进 `INDEX.md` 顶部。

确认后我按 `superpowers:writing-plans` 出实施计划，从 M1 开工；每一步完工都交回实测数字而不是「已完成」。
