# repowiki/ — 仓库自有的 Repo Wiki 文档树

这是**本仓库自己的**Repo Wiki 事实源：被 git 跟踪的 Markdown 树，读写、漂移检测、
链接重锚、盖章全部可在 CLI 侧闭环，不依赖 Qoder IDE。

**它不是 `wiki/`。** 仓库根的 `wiki/` 是上游的公开文档站（Cloudflare Pages，
`vibetrading.wiki`），由上游拥有、由 `wiki.yml` / `wiki-deploy.yml` 部署。本树
不改动它一个字节，两棵树互不影响。

## 谁是事实源

- 事实源：本目录下的 Markdown ＋ `ledger.jsonl`（担保日志）。`drift/` 里的 `DRIFT.md` 与 `drift.json`
  是 `report` 的**派生物**，被 `repowiki/.gitignore` 排除、不入库（规则写在本子树里而不是仓库根的
  `.gitignore`，因为根那份归上游，本 fork 的约束是它一个字节都不动）。
- 非事实源：`.qoder/repowiki/**` 是 Qoder IDE 的导出物，冻结在 2026-08-14 的索引
  快照上，并被 `.git/info/exclude` 排除（git 不知道它存在，因此没有撤销能力）。
  正文已于 2026-10-02 改名归档进 `_ide-export-retired-2026-10-01/`，那份归档是**只读**的：
  `--wiki-root` 指到 `ide` 布局根时，五个会写盘的入口一律 **rc=2 拒绝写入**，一个字节都不改：
  `report` 的派生报表、`mark`、`reanchor --apply`、`index` 走 `wiki_root` 判据
  （`root_is_read_only()`），`seed`（含干跑）走「目标根必须是 `repo` 形状」的磁盘判据。
  `index` 是 M3 加的第五个写动词，用的是和前三个同一道入口门（在 `@1067870e` 实测 rc=2、
  零字节落地），不是「只读命令」—— 它写 `INDEX.md`。这条规则是事故换来的 ——
  加门之前实测到 `report` 会把报表写进归档（M1 那份 `DRIFT.md` 因此没了）、`mark` 会在
  归档里凭空创建 `update/ledger.jsonl`、`reanchor --apply` 会改写导出页的字节。
  判据两处不同是有意的：命令入口读 `wiki_root`（`apply_wiki_root()` 一次解析同时导出
  `WIKI`/`CONTENT`/`UPDATE_DIR`/`LEDGER`，CLI 拼不出「可写布局 ＋ IDE 形状」这对组合），
  而 `stamp_frontmatter()` 与 `seed` 直接按磁盘形状判定（严格读法），因为前者也被只改了部分全局量的 fixture 调用。
  `SearchKnowledge` 读的是那份 IDE 索引，所以它的 overview 会长期显示过期内容 —
  这是上游限制，只能标注，不能消除。

## 怎么更新

```bash
cd "E:/Vibe-Trading-main/Vibe-Trading-main"
python -X utf8 tools/wiki_drift.py --wiki-root repowiki report
python -X utf8 tools/wiki_drift.py --wiki-root repowiki reanchor --shifts --apply
python -X utf8 tools/wiki_drift.py --wiki-root repowiki mark \
    --page <相对 topics/ 的页路径> -m "<这次核对改了什么>"
# M3 加的三台机器（见「M3 的三台机器」一节）：
python -X utf8 tools/wiki_drift.py --wiki-root repowiki stale                  # 人读的队列
python -X utf8 tools/wiki_drift.py --wiki-root repowiki stale --format count    # 队列/CI 取数：一个整数
python -X utf8 tools/wiki_drift.py --wiki-root repowiki index                    # 重写 INDEX.md（要提交）
python -X utf8 tools/wiki_drift.py --wiki-root repowiki index --check            # 只比不写：不一致 rc=1
bash tools/wiki_freshness_gate.sh                                              # 两条腿的水位门禁
```

`stale` 只读、不写任何东西，所以在只读根上也能跑；取数请用 `stale --format count`，
队列行是给人和 agent 看的。`index` 会写 `repowiki/INDEX.md`（那是本树**有意保留的**
唯一被跟踪生成物 —— `index --check` 比的就是它），跑完得跟着提交，否则下一轮的
`--check` 就红。

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

### 零命中面的范围（M3 名单 ⑧ 的裁定）

**`docs/superpowers/**` 不纳入商标零命中面，而 `.superpowers/**` 在面上。** 商标字面量
（名单由 `tools/ci_grep_gates.sh` 自持）在这里讨论的是**作用域**，不是新政策：门 (b) 的
`--exclude-dir` 列表里本来就带 `docs`（脚本注释写明 `docs/` 是讨论这条政策本身的内部计划
文档、不对外发布），列表里**没有** `.superpowers`。本 fork 既不改上游脚本，就不该用第二个
实现去覆盖上游已经划好的范围 —— 所以**这条是确认既有作用域，不是新开豁免**；「新开豁免」
指的是给某个目录加第二份实现去绕开门，那仍然是禁止的。`docs/superpowers/` 只含计划与 spec
文本、不含发布内容，这也是它符合上游那条豁免理由的原因。

实测（在 `@1067870e`；待查字面量一律由 `printf` 之类的方式拼接产生，不写进任何文件）：
门 (b) 实跑 **rc=1**，唯一命中的路径仍以 `./.qoder/` 开头，输出里**没有任何 `docs/` 路径**
——「`docs/` 不在扫描面上」是被执行结果证实的，不是推断。两条推论随之成立：

1. **`.superpowers/**`（SDD 的任务切片、报告、台账）照样被扫**，所以写计划、切任务、出报告
   时一律按「会被扫」对待；那里今天的命中数是 0，这个 0 靠的是拼接写法，不是豁免。
2. `docs/superpowers/` 里的 **5 处命中 / 2 个文件**（M1 计划 2 处、重建 spec 3 处，逐条文件＋
   行号登记在 `项目档案.md`）**保持原样、如实登记**，不做运行时拼接改写 —— 它们不在执法面上，
   把它们改掉等于把「内部计划文档可以如实讨论这条政策」改成「必须藏起来」，是超出政策自身
   要求的动作。

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
`modules/pine-engine/` 下的路径，所以重播种覆盖不到手写正文。**保护这 5 面的是这个「计划集
不枚举它」的形状（`test_seed_does_not_touch_hand_authored_pages`），不是 M3 加的覆盖闸门**：
闸门只看计划集里的页，因此这 5 面永远不会出现在 `overwritten`/`refused` 的计数里 ——
「闸门拦得住一切回滚」是读错了它的作用域（见「命令口径」那节）。

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
  （平票由 commit 本身裁决，与 walk 顺序无关）。仍想指定就写
  `--baseline <40-hex>`，显式值优先于任何回落；取不到众数时它也是唯一出路。
  M3-T7 之后这层回落是**两个函数**：众数扫描抽成了 `page_mode_baseline()`，
  `tree_baseline()` 是 `page_mode_baseline() or metadata_baseline()`。出版本时点的那条路径
  （`build()`）直接问前者，因为它要在载荷里写下这个数**是谁 supplied 的**（`baseline` ＋
  `baseline_source`，见「与 spec §6 的一处偏离」末段）—— 问后者拿到的是一个真值，但真值
  证明不了它是众数还是躲在后面的 metadata，那正是 M3 之前机器可读面撒的那个谎。
- 四个接受 `--page` 的动词（`report`、`mark`、`reanchor`，M3 起再加 `stale`）都必须落在**活动根的
  内容树之内**（默认根就是 `topics/`）：不许 `..` 段、不许绝对路径，越界一律 `rc=2` 且零字节写入、
  零台账追加。这条闸门是终审整改加的 —— 之前 `mark --page ../../wiki/x.md` 能 rc=0 改写**上游拥有**
  的 `wiki/*.md` 并给它盖上 `vouch: all`。`report`/`stale`/`reanchor` 只按子串过滤、并不拿这个参数
  拼路径，越界的针永远碰不到文件，但它们走同一道门：对一个意指**另一棵树**的参数答「没有页匹配」，
  正是本仓反复写过三遍的那种空集假绿。在 `@1067870e` 实测这四处都是 `rc=2`。
  深层中文键与 `./` 前缀写法都照常可用，路径就是 `ledger.jsonl` 的主键，别改。
- `seed` 是一次性动作，M2 已跑完（播种提交 `f16d5dbc`），**且归档之后它不再有单一可用的
  `--from` 根**：`seed` 要求 `zh/content` 与 `knowledge/` 落在同一个根下，而归档只移走了
  前者（→ `_ide-export-retired-2026-10-01/zh`），后者按下一节的「归档位置」有意原地留在
  `.qoder/repowiki/knowledge`。在 `@1067870e` 实测三种写法一律 `rc=2`：默认根（报
  `seed snapshot commit unavailable at …: pass --snapshot <40-hex>`，补上 `--snapshot` 又报
  `no export content tree at …/zh/content`）、显式 `.qoder/repowiki`（同上）、显式归档根
  （报 `seed plan failed: no knowledge tree at …/_ide-export-retired-2026-10-01/knowledge/zh`）。
  **三条都在计划阶段退出，一行 tally 也不打、一个字节都不写**，所以「跑一次 `seed` 看看」
  这条路今天在真树上走不通；要复播得先把两样放回同一根。控制器裁定**不加 `--knowledge-root`
  这类旗标**（YAGNI：重播不是任何里程碑的前置动作），这个后果由文档承担。
- `seed` 的覆盖闸门（M3-T6，实现提交 `4dcacb43`）：目标页存在、而它的字节与计划载荷不相等时，
  **默认拒绝写入并整轮 `rc=2`**，要覆盖必须显式 `--force`；**干跑（不带 `--apply`）也为这种树返回
  `rc=2`** —— 预览的是 `--apply` 真会做的事，把被改过的页报成 `written` 就是让预览替一次不会发生
  的写盘背书。计数打 `overwritten=N refused=N`：`overwritten` 数「字节不同」这件事本身（无论
  `--force` 有没有放行），`refused` 数没被放行的那些；stderr 点名是哪几页（`edited pages: …`），
  并在拒绝时**先于 `copy_ledger` 退出** —— 那一轮不打 `ledger_rows=`/`ledger_sha=`、也不拷台账，
  因为「半棵树的页没发完」配上一份宣称全都发完的台账，正是这道闸门要造的假状态。担保这三条形状的
  用例是 `test_seed_apply_refuses_an_edited_page_until_force`、
  `test_seed_dry_run_reports_a_refused_page_instead_of_a_written_one`、
  `test_seed_overwrite_gate_fires_only_on_bytes_a_human_changed`。
  ⚠ **这条与上一条是两件事**：闸门管的是「计划出得来、但目标页被人改写过」的树，而今天的真树连
  计划都出不来 —— 「重跑 `seed` 今天不通」是 M2-T11 的归档把正文与知识层拆进两个根造成的，
  **不是**加了闸门造成的。闸门在今天真树上的惰性由**等价只读取证**给出（同一段代码路径、
  `dry_run=True`、全程只 `read_bytes`；`@4dcacb43` 那轮记录）：`plans = 489`、
  `pages_written=0 pages_skipped=489 … overwritten=0 refused=0` ⇒ 零误报。
- **重播 `seed` 仍是 rollback 级操作，但别把闸门读成「拦得住一切回滚」**：`modules/pine-engine/`
  那 5 面手写页**不在 `seed` 的计划集里**（489 = 450 topic 页 ＋ 30 模块面 ＋ 9 卡片），所以闸门
  永远不可能把它们计进 `overwritten`。保护它们的是「计划按导出目录枚举、产不出那些路径」这个
  形状（`test_seed_does_not_touch_hand_authored_pages`），也就是「播种的三张映射表」那节里
  「重播种覆盖不到手写正文」那句的另一面 —— 受计划集保护，不受闸门保护。默认 dry-run、
  `--apply` 才写盘这一点不变；复播前先把工作树干净地提交，并把它当一次**回滚**而不是更新来读。

## M3 的三台机器

M3 给这棵树装了三个问题各自的答案。它们读的是同一批页，但**判据不同**，所以不许互换、
也不许被「顺手统一」成一个谓词：

- **`stale` —— 谁还没核过（队列）**：M5 的待办清单。人读那条打每页一行 ＋ 末行一个整数；
  `stale --format count` 只打那一个整数，是 `tools/wiki_freshness_gate.sh` 与 CI 的取数口。
  两者都**不写任何文件**，所以在只读根上合法。
- **`WIKI_STALE_MAX` —— 水位有没有恶化（阈值）**：门禁脚本的第一条腿。它的默认值是
  **2026-10-02 实测到的当时水位**，在 `@1067870e` 复跑仍是 `stale --format count` = **445**
  （时点读数，不是常量）。这条旋钮**只降不升**：调大它等于把门禁关掉 —— 一个永远绿的
  绿灯比红灯更早被关闭；M5 的进度恰恰是每收一个分片就把它往下调一格。脚本对**两个**输入
  都做整数校验：拼错的 `WIKI_STALE_MAX`（例：`4o5`）直接 `rc=1`，不再像上一版那样让
  `[ 445 -gt 4o5 ]` 走「没超」那支、把旋钮的拼错读成合规。
- **`index` / `index --check` —— 导航是否确定性**：`INDEX.md` 是磁盘树的**确定性投影**
  （不含时间戳），所以「重写一遍字节相同」就是它的正确性判据。`--check` 比的是入库那份
  `repowiki/INDEX.md`，不一致 ⇒ **rc=1**（活干了、对账不过），而不是 rc=2（拒绝干活）；
  一棵一页 `verified_at` 都没有的树它**拒绝认证**（同样 rc=1）—— 一份确定性的空白索引
  正是本仓反复记的那种「没有含义的绿灯」。

### `stale` 的 count ≠ `report` 的 needs_update

这是 Task 1 定下的契约，钉成**不等式**而不是相等：`count >= needs_update`
（用例 `test_the_queue_count_is_not_report_needs_update`）。两个数数的是两种不同的债：

| 读数 | 数什么 | 判据 |
| --- | --- | --- |
| `report` 的 `needs_update` | **漂移** —— 页与其基线之间源码动了 | `score = 变更引用 + 缺失引用 + 未核锚点` 非零 |
| `stale` 的 `count` | **待办** —— 正文尚未被确认核过的页 | 上面那三个理由，**外加** `prose-unverified`（状态 `partial`/`ledger-void` 的页，分数为零也进队列） |

于是「链接全做完了、正文却没人重读过」的页在 `count` 里而不在 `needs_update` 里；反向不可能。
在 `@1067870e` 的时点读数里两个数都是 **445**，那是这棵树当前形状的**巧合**（同一轮
`report --json` 的 summary：`pages 450 / needs_update 445 / clean 5 / partial 423`），
不是恒等式，M5 一动它们就会分叉。**谁把它们统一成一个过滤器，谁就把 423 页从 M5 的清单里
悄悄删掉了** —— 那是当年 414 条待判引用被盖章清成 3 条那个缺陷换个坐标重演，也正是
`test_a_page_with_no_drift_but_unverified_prose_is_still_queued` 钉住的那件事。

### 谁在 CI 里收集这三台机器

`.github/workflows/repowiki-freshness.yml`（**fork 自有**的新文件；上游的 `test.yml` 一个字节
没动，因为 `pyproject.toml` 的 `testpaths` 是上游地籍、只收 `agent/tests`）。两步的软硬是
裁定过的：**套件那步是硬的**（第一天就该绿，不配任何容错开关），**只有水位门禁那步是软的**
（spec §9.1「首周只观察」）—— 全文件里那个容错开关只允许出现一行，这条由
`test_the_fork_workflow_collects_the_suite_and_only_softens_the_water_level` 钉着；两步都软
等于一个从不报警的绿灯。CI 用的选择器是 `-m "not local_archive"`：在 `@1067870e` 实测
**227 passed, 3 deselected**，同文件不带 `-m` 是 **230 passed**（本地那 3 条真跑不跳）。
门禁两条腿在同一点的实测：`bash tools/wiki_freshness_gate.sh` **rc=0**
（`445 (threshold 445) ok` ＋ `INDEX.md is current (450 pages) ok`）。

## 五条不可回退的契约（spec §6，踩过坑才定下的）

这五条是 M1/M2 用事故换来的口径，M5 的 agent 改任何一页之前要先知道它们存在。「顺手优化」掉其中任何
一条都会静默改变水位，而水位是这棵树唯一的进度事实源。

M3 又添了两条同形状的告诫，写在本节之外，这里只指过去：**`stale` 的 count 不得被「统一」成
`report` 的 needs_update**（那等于造出第六条被稀释的契约，见「M3 的三台机器」一节），以及
**商标零命中面的范围裁定**（名单 ⑧：`docs/superpowers/**` 不纳入、`.superpowers/**` 照样被扫，
见「已知长期现象」一节 —— 它不是第六条契约，但它和这五条一样，是「顺手改一下措辞」就会动到
执法面的东西）。

1. **`cites` 担保范围（`vouch`）**：只有 `all` 才让页的 `verified_at` 顶替台账/快照当基线，而 `all` 只能
   由「人真的重读过整页」的 `mark`（不带 `--partial`）写下；`reanchor --apply` 只搬得动它列进 `applied`
   的那些引用，所以永远写 `applied-only`。当年把 `applied-only` 当全页担保，414 条待判引用被读成「已在
   自己行上」，队列从 414 缩到 3 —— 工具把自己干不了的活藏了起来。
2. **`partial` 不推进报表基线**：`mark --partial` 表示「引用已新、正文未核」，报表基线原地不动、只前移
   锚点基线。2026-10-01 全仓扫描那天的读数里 423 个 `partial` 页就是这么留在队列里的（当日水位读数，
   不是常量，跑一次 `report` 就会变），谁把它们盖章清掉谁就造出第二个 414。
3. **`ledger-void` 由正文 sha 判定**：台账行的 `sha_after` 与页当前正文字节不符即作废，退回快照基线并
   在报表点名 —— 防「改过一页却冒充已核对」。哈希按字节算（`open(newline="")`），且 `repowiki/.gitattributes`
   把全树钉成 LF；两者任一失效，426 行台账会集体读成 `ledger-void`。
4. **编辑器行数口径 `换行数+1`**：生成器把「末尾换行之后那个编辑器行号」写进 EOF 引用（全仓 3194 处），
   所以 `file_line_count` 按 `newlines + 1` 计。按换行数计会把这 3194 条健康引用全判成越界。
5. **越界分两类、报表分别措辞**：「文件收缩导致」可重定位，交给 `reanchor`；「快照当天就不存在这些行」
   是生成器给整文件引用套的 `#L1-L200` 模板（全仓 25 个不同串），只能人工换掉。合并成一句话就会让第二类
   看起来像工具没干活。

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

M3-T7 起这层回落是**两个函数**：众数扫描抽在 `page_mode_baseline()`，`tree_baseline()` ＝
`page_mode_baseline() or metadata_baseline()`。必须写明出处的调用方（`build()` —— 它把
`baseline` 与 `baseline_source` 一起发进 `drift.json`／`DRIFT.md`／`stale --json`）问的是
前者，因为一个真值只证明「这棵树同意」，证明不了它是页上的众数还是躲在 `or` 后面的 metadata
SHA。**「没删」不等于「没动」**：动的是拆分与出处命名，末位兜底的位置没变。
