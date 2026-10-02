# repowiki/ — 仓库自有的 Repo Wiki 文档树

这是**本仓库自己的**Repo Wiki 事实源：被 git 跟踪的 Markdown 树，读写、漂移检测、
链接重锚、盖章全部可在 CLI 侧闭环，不依赖 Qoder IDE。

**它不是 `wiki/`。** 仓库根的 `wiki/` 是上游的公开文档站（Cloudflare Pages，
`vibetrading.wiki`），由上游拥有、由 `wiki.yml` / `wiki-deploy.yml` 部署。本树
不改动它一个字节，两棵树互不影响。

## 谁是事实源

- 事实源：本目录下的 Markdown ＋ `ledger.jsonl`（担保日志）。
- 非事实源：`.qoder/repowiki/**` 是 Qoder IDE 的导出物，冻结在 2026-08-14 的索引
  快照上，并被 `.git/info/exclude` 排除（git 不知道它存在，因此没有撤销能力）。
  `SearchKnowledge` 读的是那份 IDE 索引，所以它的 overview 会长期显示过期内容 —
  这是上游限制，只能标注，不能消除。

## 怎么更新

```bash
cd "E:/Vibe-Trading-main/Vibe-Trading-main"
python -X utf8 tools/wiki_drift.py --wiki-root repowiki report
python -X utf8 tools/wiki_drift.py --wiki-root repowiki reanchor --shifts --apply
python -X utf8 tools/wiki_drift.py --wiki-root repowiki mark \
    --page <相对 topics/ 的页路径> -m "<这次核对改了什么>"
```

每页 frontmatter 的 `verified_at` 是**该页上次核对时所处的 commit**：基线随页面走，
在 git 里可 diff、可回滚。`anchors` 记链接坐标是否已核，`vouch` 记这次盖章担保到
什么范围（`all` 只允许人工盖章写出，工具自动改链接只能写 `applied-only`）。

## 当前定性（M5 之前）

**链接层已核、散文层未核，别当事实源引用。** 播种进来的正文来自 IDE 快照，链接
坐标已全仓改写并验证幂等，但散文自 2026-08-14 起没被人重读过。

## 已知长期现象

`bash tools/ci_grep_gates.sh` 在本地**长期红一条**，且永远只有那一条：命中路径以
`./.qoder/` 开头就是它。那是门禁 (b) 按文件系统扫描的口径缺陷（IDE 导出物被 git
排除、CI 的 checkout 里没有该目录），修它要改上游拥有的 `tools/ci_grep_gates.sh`，
与「二次开发不动需要同步的上游原始部分」冲突，因此记为遗留。

**不要为了把它改绿去动上游脚本，也不要新开目录豁免。** 发布物合规靠两件事：
措辞合规（见 `项目档案.md`）＋ fork 自带的守卫用例
（`tools/test_wiki_drift.py` 里那组扫本树的商标检查，它会随一次真违规变红）。

## 播种的三张映射表（M2）

`seed` 把 IDE 导出物搬进本树时改了两层名字：目录名换成 ASCII slug，中文面名换成英文
文件名。导出物随后改名归档（见「归档位置」），git 里查不到旧名 —— 下面三张表是唯一还能
把 `modules/ci-gates/architecture.md` 还原成
`…/CI 流水线与安全门禁脚本/架构设计.md` 的地方，所以它必须跟着代码走：下面三张表照抄
`tools/wiki_drift.py` 里的 `MODULE_SLUGS` / `FACE_NAMES` / `CARD_SLUGS` 三张常量表（人工誊写，
非生成）。`test_readme_maps_every_seeded_name` 只做**单向**对账——码里有的每个 slug/面名/中文
名都必须在表里出现，所以改了 `wiki_drift.py` 却忘了同步这张表会红；反之（表里留了一行、码里
已经没有那个名字）这条测不出来，属过期行，靠人工对读。
名字换 ASCII 的理由：面是被脚本按文件名寻址的，而全角逗号写进**文件名**这件事在本仓咬过人。

### 面名映射表（每个模块 5 面）

| 导出里的中文面名 | 树里的 ASCII 文件名 |
| --- | --- |
| 概述.md | `overview.md` |
| 架构设计.md | `architecture.md` |
| 技术栈.md | `tech-stack.md` |
| 编码规范.md | `conventions.md` |
| 特殊配置与命令.md | `commands.md` |

### 模块映射表（6 个来自导出 ＋ 1 个手写）

除第一行的 `repo-root` 本身，其余 5 个目录都是它名下的直接子目录；导出里的完整相对路径
＝ `repo-root` 的目录名 ＋ `/` ＋ 表里的子目录名。

| slug | 导出目录名 | 面数 |
| --- | --- | --- |
| `repo-root` | Vibe-Trading 多端一体化仓库（Agent_前端_Electron_Wiki_CI） | 5 |
| `agent-backend` | Vibe-Trading Agent 后端（API_MCP_CLI_回测） | 5 |
| `frontend-app` | Vibe Trading 前端应用（React + Vite 交易分析界面） | 5 |
| `electron-desktop` | Vibe-Trading Electron 桌面宿主 | 5 |
| `wiki-static-site` | Vibe-Trading Wiki 静态站点与 Pages Functions | 5 |
| `ci-gates` | CI 流水线与安全门禁脚本 | 5 |
| `pine-engine` | 手写，无导出来源 | 5 |

`pine-engine` 是第 7 个模块，也是唯一的例外：IDE 的知识树里 Pine 引擎一页都没有，5 面全是
手写。手写页的 `sources` 必须逐个在盘上解析得出，`anchors` 只能停在 `open`，`vouch` 只能
是 `applied-only` —— 手写正文不等于逐条核过引用。`seed` 的计划按导出目录枚举，永远产不出
`modules/pine-engine/` 下的路径，所以重播种覆盖不到手写正文。

### 卡片映射表（9 张 repo 级卡片）

卡片在导出里是 `knowledge/zh/` 顶层的目录，靠「没有 `_module.yaml`」跟模块目录区分；每张
目录里一页 `<目录名>.md`。

| slug | 导出目录名 |
| --- | --- |
| `dependency-management` | 多语言仓库依赖管理：pip + pip-compile、npm lockfile 与 Dependabot 协同治理 |
| `build-system` | 多端一体化构建系统：Docker 多阶段镜像、pyproject 包管理与 GitHub Actions CI_CD |
| `logging` | 基于 Python stdlib logging + Uvicorn 访问日志脱敏的日志体系 |
| `pydantic-settings` | 基于 Pydantic 的集中式环境变量与结构化 Agent 配置系统 |
| `tailwind-theme` | 前端样式体系：Tailwind CSS + CSS 变量主题系统 |
| `error-handling` | Vibe-Trading 错误处理体系：FastAPI HTTPException + 领域异常类 + CLI 吞错 + Electron 进程级兜底 |
| `novita-openai-gateway` | Novita AI — OpenAI 兼容推理网关 |
| `sync-upstream-workflow` | GitHub Actions 每日同步工作流（sync-upstream） |
| `glossary` | 业务术语表 |

## `topics/` 为什么保留中文名

三张表只改名了 `modules/` 与 `cards/`。`topics/` 原样保留导出里的中文相对路径，**因为那个
路径就是 `ledger.jsonl` 的主键**：播种逐字节复制过来的 426 行全部按它寻址（如
`回测引擎/投资组合优化器/最大分散化优化器.md`），改一次名等于给每一行判一次无主，全树的
`verified_at` 与 `sha_after` 担保同时作废。`modules/` 与 `cards/` 换 ASCII 没有这个代价 ——
426 行里 0 行讲它们，它们的历史担保从播种那一刻才开始计。

## 命令口径

```bash
cd "E:/Vibe-Trading-main/Vibe-Trading-main"
python -X utf8 tools/wiki_drift.py --wiki-root repowiki report   # 现在无需 --baseline
```

- `report` 不再强制 `--baseline`：基线自己回落到逐页 `verified_at` 的**众数**
  （`tree_baseline()`，平票由 commit 本身裁决，与 walk 顺序无关）。仍想指定就写
  `--baseline <40-hex>`，显式值优先于任何回落；取不到众数时它也是唯一出路。
- `seed` 是一次性动作，M2 已跑完（播种提交 `f16d5dbc`），**且归档之后它不再有单一可用的
  `--from` 根**：`seed` 要求 `zh/content` 与 `knowledge/` 落在同一个根下，而归档只移走了
  前者（→ `_ide-export-retired-2026-10-01/zh`），后者按下一节的「归档位置」有意原地留在
  `.qoder/repowiki/knowledge`。实测三种写法一律 `rc=2`：默认根、显式 `.qoder/repowiki`、
  显式归档根（后者报 `no knowledge tree at …/_ide-export-retired-2026-10-01/knowledge/zh`）。
  要复播得先把两样放回同一根。默认 dry-run、`--apply` 才写盘这一点不变。

## 页集口径（M2 冻结的决定，M3 要扩必须显式改判）

`report` 只审 `topics/` —— `CONTENT` 就是 `topics/`，水位统计（页数、partial、stale）只算
它。`modules/` 与 `cards/` 有 frontmatter、进 git、被 `seed` 逐字节对账，但它们**不在
`CONTENT` 下，因此不参与水位统计**。这正是「450 页」这个数字在播种之后仍然是 450 的原因：
`seed` 落 489 页（450 topics ＋ 30 模块面 ＋ 9 卡片），加手写 5 面本树共 494 页，而 report
的口径只认前 450 页。不是漏播了 44 页，也不许靠「让 `collect_pages()` 顺路多收一棵树」来
凑数 —— 那会把未核正文算进以 topics 为定义的水位里。

## 归档位置

`.qoder/repowiki/_ide-export-retired-2026-10-01/{zh,update}`：播种后已把导出的 `zh/` 与
`update/` 整棵**移动**进去（2026-10-02 落盘；改名归档，不删除，也不入库）。`knowledge/` 留在原处
`.qoder/repowiki/knowledge/` —— 它是 `seed` 幂等重放的输入，动它等于自断后路；同时它也正是
「已知长期现象」那节里门禁长期红的那条命中路径。

`.qoder/` 整棵在 `.git/info/exclude` 里，git 既看不见归档也撤销不了归档：**`git status`
干净不代表已备份**。核对备份要直接对盘数（归档里 450 页 ＋ 426 行 `ledger.jsonl`）。

## `seed` 改写的唯一一页

`modules/ci-gates/architecture.md` —— 整棵导出里唯一被改写正文的发布页，`seed` 的输出会把它
点名打出来（`reworded: …`，计数为 1）。改的是描述门禁 (b) 的那一句：原句把**门禁自己要 grep
的那个商标字面量当成例子写进了正文**，于是发布物自己变成了门禁要拦的东西 —— 一条自指的假
阳性。播种版删掉字面量、保留指针，写成「禁止商标字面量（名单由 `tools/ci_grep_gates.sh`
自持）」。

禁词名单不在本树复制第二份：那份名单由上游脚本自持，本树只指过去。fork 自己的守卫是
`tools/test_wiki_drift.py` 里扫 `repowiki/**` 的那组商标用例，它在运行时拼装待查字面量（否则
自己就会命中自己），所以这段散文里既不需要也不该出现那个词。

## 与 spec §6 的一处偏离（写明，不留成隐性差异）

spec §6 要求删掉 `metadata_baseline()` 的调用路径。本实现没有删，而是把它保留为
`tree_baseline()` 的**末位兜底**：逐页 `verified_at` 的众数永远优先，只有当树里一个合法
`verified_at` 都没有时才走到它 —— 那正是 `--wiki-root` 指向 IDE 导出的情形，也就是播种前
M1 的老行为。完整次序与理由写在 `tree_baseline()` 的 docstring 里。一句话版：删掉兜底会逼
`test_unreachable_metadata_baseline_asks_for_an_override` 改锚，而那条用例担保的是「基线取不到
时报错、不是瞎猜」，动它等于把守卫削成自己想要的形状。这是记录在案的有意偏离，不是疏漏。
