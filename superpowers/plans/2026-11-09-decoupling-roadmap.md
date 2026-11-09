# 解耦与优化路线图（首片之后）

日期：2026-11-09
状态：登记。片②起各片开工时再写自己的 spec 与 plan，本文不实现任何东西。
上游：首片＝fork 语言覆盖层，已落地并推 origin（`项目档案.md` §7.42）。

取证坐标（三枚，都是落笔当趟现读，引用时请重跑本文给出的命令）：

- 本仓 `HEAD = 57a1ac71`（`main`，与 `origin/main` 逐字相同）
- 上次同步点 `2ac20879`（§7.41 并入的那枚上游头）
- 上游现头 `c6aaacc5`（本地追踪件 `upstream/main` 已 fetch 到该点）

**两把尺不许混**：对 `2ac20879` 读到的分叉面是我们自己的改动；对 `c6aaacc5` 读到的
差异里混着上游自我推进的 94 笔投影。§7.42 已为这条口径付过一次学费，本文每个数都点明用哪把尺。

## 0. 首片留下了什么

- 窄尺（`git diff --name-only --diff-filter=M 2ac20879 HEAD`）：**76 → 67**。
- 耐久判据：`git diff --name-only 2ac20879 HEAD -- frontend/src/i18n/locales/` 输出为空。
  往后每轮同步都该复跑它。
- 对同一上游头 `c6aaacc5` 的零写入预检（`git merge-tree --write-tree --name-only`）：
  片前 16 枚冲突 ⇒ 片后 15 枚，消失的是 `frontend/src/i18n/locales/en.json`，新增 0。
  **实减 1 枚不是 11 枚**——上游改了全部 11 枚 locale，但只有 en.json 与旧分叉撞同区。

## 1. 当前冲突面的形状（现测）

窄尺 67 枚里，**35 枚自 `2ac20879` 以来上游零改动**（休眠面，当下没有碰撞成本）。
真正会撞的是对 `c6aaacc5` 做零写入合并时报出的 **15 枚文件、59 枚冲突 hunk**：

| 文件 | hunk | fork 侧 delta（对 `2ac20879`） | 上游侧 delta（`2ac20879..c6aaacc5`） |
|---|---|---|---|
| `README.md` 等 7 枚 | 6 × 7 = **42** | 每枚约 18/15 | 每枚 200~257  added／1700~2472 deleted |
| `agent/SKILL.md` | **5** | 8/7 | 17/19 |
| `agent/backtest/loaders/registry.py` | 2 | 94/38 | 8/11 |
| `frontend/package-lock.json` | 2 | 25/30 | 197/189 |
| `frontend/package.json` | 2 | 2/0 | 16/16 |
| `frontend/src/components/layout/__tests__/Navigation.test.tsx` | 2 | 3/3 | 2/2 |
| `agent/tests/test_settings_api.py` | 2 | 18/11 | 49/2 |
| `agent/api_server.py` | 1 | 23/0 | 6/2 |
| `agent/tests/test_source_order_overrides.py` | 1 | 7/5 | 1/1 |

**47／59 = 80% 的 hunk 集中在 8 枚「计数型文档」**（README×7 ＋ `agent/SKILL.md`）。
这就是下一片该打的地方，而不是体量最大的那些文件。

复算命令（只读）：

```bash
git diff --name-only --diff-filter=M 2ac20879 HEAD                 # 窄尺 67
git merge-tree --write-tree --name-only HEAD upstream/main         # rc=1，首行是树号，其后是冲突路径
git show <树号>:<路径> | grep -c '^<<<<<<<'                        # 逐枚 hunk 数
```

## 2. 片②：文档计数再生成器（README×7 ＋ `agent/SKILL.md`）

### 2.1 fork 侧改的是什么

每枚 README 的 fork delta 只有 18 added／15 removed，内容全是**由代码决定的数**：
alpha 数 478→482、quantlib 328 函数／29 模块（上游 309／25）、数据源 29→30、
warehouse 那一行表格、三条 fallback chain 里前置 `futu`、以及 loader 注册说明里
`_loader_modules`→`_LOADER_MODULES`、`_VALID_SOURCES`→`VALID_SOURCES` 的改名。
`agent/SKILL.md` 的 5 枚 hunk 逐一现读，**全部是同类计数**：version、engines（我们 11／上游 12）、
alphas（482／478）、skills（90／89）、sources（30／28）。

漂移是**双向**的：我们加 alpha／skill／warehouse，上游加 engine（ArgentinaEquity）并删掉一个数据源。
手工合并要同时记住两个方向的账，这正是它每轮都出错的原因。

### 2.2 「撤回上游字节」这条路已被探针否证

locale 片能把 11 枚文件撤回上游字节，因为那 15 枚键全是自研增量、零改值。文档面**不同**：

- 承重门是 `agent/tests/test_readme_counts.py`（**上游拥有、fork 逐字相同**，721 行）
  与 `agent/tests/test_distribution_skill_manifest.py`（同样上游拥有、fork 逐字相同）。
  它们把文档里的数与**活代码**对账，不是文档之间互相对账。
- 零写入探针（只改内存里的 `_read`，不动任何被跟踪文件）：把 `2ac20879` 的 README 字节喂进去
  ⇒ **50 failed / 65 passed**；同一棵树喂磁盘字节 ⇒ **115 passed**。
  红的 8 个函数逐名：`test_repo_tree_states_the_real_agent_tool_count`、
  `test_feature_badges_state_the_real_counts`、
  `test_quantlib_badge_states_both_the_function_and_module_counts`、
  `test_readme_loader_tree_line_matches_the_registry`、
  `test_data_sources_prose_states_the_real_source_count`、
  `test_every_registered_source_appears_in_the_data_sources_table`、
  `test_fallback_chains_are_written_in_the_order_the_loader_walks`（各 ×7 枚 README）
  ＋ `test_all_readmes_agree_with_each_other`。

**结论：这 8 枚文档不能撤回上游字节。**只要 fork 比上游多 ship 东西，它们就必须带着我们的数。

探针自己先失明过一次，留痕以免重犯：第一版 patch 的是 `import test_readme_counts`，
而 `agent/tests/__init__.py` 存在、`agent/__init__.py` 不存在 ⇒ pytest 收的模块名是
`tests.test_readme_counts`，于是 patch 打在另一个对象上，读数 rc=0／115 passed 是**假绿**。
修法＝从 `pytest_collection_modifyitems` 的 `item.module` 取对象，并加两条自证
（`disk != upstream`、`"482" in disk and "478" in upstream`），armed 名单打进 stdout。

### 2.3 交付形状

fork 自有的生成器（`tools/` 下一枚新文件，名字开工时定），`--check` ／ `--write` 两个动词：

- 从活代码现算：alpha 数、quantlib 函数／模块数、engine 数、skill 数、注册数据源数、MCP 工具数、
  fallback chain 的实际顺序、loader 注册说明里的符号名。
- 锚点走「翻译无关」的模式，与上游那套门同一手法（`<summary>…<sub>N …</sub></summary>`、
  反引号里的代码标识符、`mcp_server.py` 所在那行树），**不匹配任何自然语言措辞**。
- 锚点消失必须**大声失败**，不许静默跳过——上游会整段重写（`README.md` 的 hunk@360 是 253 行、
  hunk@715 是 567 行），静默跳过等于把门变成豁免型恒绿针。
- 输出确定性：排序、无时间戳、无日期、无提交号；陈旧判据是归一化后的字节相等
  （沿用 `tools/doc_tables.py` 的既有形状，那枚只写 `forensics/l0-census.md`，不碰 README）。

### 2.4 收益口径要诚实

**窄尺不降**：这 8 枚仍是「改过的上游文件」，仍会每轮报冲突。
降的是**每轮同步的手工成本**：47 枚 hunk 从「逐枚读两边、心算双向漂移」变成
「取上游字节 → 跑一条命令 → 让上游那两套门判绿」。顺带治掉手打数字的静默过期。

### 2.5 开工前置

1. 取这 8 枚文档的**全部锚点清单**并逐枚现读，确认每个数都有唯一可判的落点。
2. 把 `test_distribution_skill_manifest.py` 的 7 枚测试与 `test_readme_counts.py` 的 115 枚
   一并列为验收面（两者都是上游拥有、fork 不许改）。两套合跑现读 `122 passed`。
3. 生成器必须能在「上游刚重写完的 README」上跑通 ⇒ **排在同步轮之后**，见 §6。

## 3. 片③：`registry.py` 的搬动改纯追加

- 取证：hunk@141 是 33 行，形状＝fork 把函数内的 `_loader_modules` 列表整体搬到模块级
  `_LOADER_MODULES`（并加一枚 `backtest.warehouse.loader`），而上游在同一列表里删了一枚。
  **「删除＋搬动」对「删除」必然冲突**，与两边改的内容是否相似无关。
- 交付形状：上游函数内那份列表**原位不动**，fork 的 warehouse 走一个 fork 自有的后置追加，
  把 30 行搬动换成几行纯追加。上游此后改自己的列表不再与我们撞。
- 承重约束（搬动不是随手做的，理由写在 `registry.py` 的注释里）：测试会 swap `LOADER_REGISTRY`
  并 stub `importlib.import_module`，按路径前缀猜的 stub 会让存放在别处的 loader 落到临时 dict，
  进程注册表从此永久丢那枚 loader。改形状必须同时改 `agent/tests/test_registry.py`
  （fork 已改 +69/-4）的拦截清单，并保住这条不变量。
- hunk@202 是 `_NO_NETWORK_FALLBACK_SOURCES` 的一行集合字面量，便宜，但语义 loaded（见 §5）。
- 收益：2 hunk → 1 或 0；这是窄尺里唯一能靠**改形状**真削掉碰撞的面。

## 4. 判定为「不值得一片」的面（附理由，不要回头再议）

- `agent/api_server.py`：1 hunk，纯追加对纯追加（我们加两枚路由注册，上游加一枚），
  解法就是「两边都留」。为它造扩展点属过度设计。
- `frontend/package.json` ／ `package-lock.json`：各 2 hunk。fork 只加 `klinecharts` 与
  `@types/node` 两枚依赖；lock 本来就由 npm 重生成，不手工解。
- `Navigation.test.tsx`：2 hunk。上游拥有的测试断言精确 href 列表与链接数（12→17），
  fork 加 5 个导航入口就必须改它，确定性强、每轮解法相同。
- `agent/tests/test_settings_api.py`（2 hunk）／`test_source_order_overrides.py`（1 hunk）：同上，便宜。
- 35 枚休眠面：上游零改动，当下无碰撞成本。**不动**——为 hypothetical 的未来冲突改形状
  只会增加窄尺，方向反了。

## 5. 下一轮同步的已知语义决策（同步前置，不是解耦片）

上游 `0af09d59`（`Make Gildata research tools opt-in and require explicit quote selection`）
**删除了 QVeris**：`agent/backtest/loaders/qveris_loader.py` 是 `D`，`registry.py` 是 `M`。
fork 侧那枚 loader 与上游逐字相同 ⇒ 合并会干净地把它删掉，不报冲突。

零写入合并树（`git merge-tree --write-tree --name-only HEAD upstream/main` 的首行树号，
随 `HEAD` 变，引用时现取）里 `agent/` 下 qveris 路径 **0 枚存活**，但仍有两枚 blob 提到它
＝`agent/SKILL.md`（1 处）与 `agent/backtest/loaders/registry.py`（4 处），都在冲突名单里、我们那侧留着。
全树唯一存活的路径是一枚 `repowiki/` 下的 QVeris 文档页——**wiki 面不碰**，只登记。

后果链（**要逐条验，不许推断**）：`_ensure_registered()` 里的 `importlib.import_module`
会抛 `ModuleNotFoundError`，被同一个 `except Exception` 吞掉 ⇒ `LOADER_REGISTRY` 没有 qveris，
而 `VALID_SOURCES` 仍接受 `"qveris"` ⇒ 配置层放行、取数层失败。

**别指望那枚门报警**：`test_valid_sources_covers_all_registered_loaders`
（`agent/tests/test_engine_robustness.py:469`）断言的是 `set(LOADER_REGISTRY) - VALID_SOURCES`
为空，**反向不查** ⇒ 陈旧的 VALID_SOURCES 条目在它眼里合法。

裁定：同步轮必须显式决定「跟随上游删 QVeris」还是「fork 自留」。选自留就要把那枚 loader
搬进 fork 自有路径并让 `_LOADER_MODULES` 指名它，否则就是一个静默失效的数据源。

## 6. 顺序与理由

1. **同步轮**（并入 `c6aaacc5`，含 §5 的语义决策）。它已经逾期：`b292dfb6` 上四趟
   `Sync upstream` schedule 全 failure；本地门 F 也因这次 fetch 翻红（§7.42 末条），
   复绿判据就是这轮并入。那 47 枚文档 hunk 手工解**最后一次**。
2. **片②**（文档计数再生成器）。排在同步之后是因为锚点必须对齐上游刚重写的结构；
   先做它，同步轮会把锚点全推翻，等于造两次。
3. **片③**（registry 纯追加）。独立于文档面，可与片②并行考虑，但一次只开一片。
4. **路线 A**（ProChart 拆解）维持原判：后续多片纲领。

## 7. 路线 A：ProChart 拆解（维持「后续多片纲领」原判）

- 3517 行（`wc -l` 现读）、**fork-added** ⇒ 冲突面收益 **0**。收益是可维护性，不是同步成本。
- 不与片②③争优先级：②③削的是每轮同步都要付的 recurring 成本，A 是一次性投入。
- 开工前置：先取闭包与 ref 镜像的承重清单（既有教训：闭包里的守卫读 `viewRef` 不是 state 快照），
  再定拆几片。不要一次性大重构。

## 8. 登记为后续候选的小面

- ProChart／ReplayBar 工具栏的硬编码中文字面量（§7.42 已登记）：切 en/ar/tr 时仍是中文。
  它是语言覆盖片的自然延续——把这些文案收进 fork 覆盖层，独立一片，与片②无关。
- `frontend/src/__tests__/navigationCopy.test.ts:120` 的 `if (typeof value !== "string") continue;`
  对缺失键天然失明（§7.42 RED-B 裁定「治它的盲区属另一片」）。该文件是 fork-added，改它零冲突成本。

## 9. 每片收口判据（沿用，不新增）

- 门册 A–I 串行跑，不与重 CPU 活并发。
- **F 现在是「同步前恒红」的第三枚本地门**，与 H／I 并列（§7.42 末条：两把尺口径不对称，
  三点名单走 merge-base、`.gitignore` 豁免走两点）。引用 F 的读数必须连带写明当时
  `upstream/main` 指向哪一枚。恒红门一律先证「本片 0 贡献」（字节相等强于名字集合），
  再报告；**不调阈值、不改门、不清白名单**。
- 提交一律 `git commit -s` ＋显式 pathspec；合入 `main` 用 merge 不用 rebase；
  推送前后各 `git ls-remote` 取一次真值（cron 会自己推进远程）。
