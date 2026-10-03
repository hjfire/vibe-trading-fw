# 上游同步设计：35 个提交并入 fork，并把「合并干净」与「数值口径没被静默改掉」分开证明

日期：2026-10-03
状态：已批准并含 §3.1 更正（未开工）。初版 §3 的「降级即谎报」判词与 §6 结局 A 的两处上游文件豁免**已被合并取证推翻并撤销**，缺口重定位为 G1–G3。
作者：Qoder CLI 会话 `824c1609`
相关：`项目档案.md`（Wiki 漂移收口章节）、`agent/backtest/loaders/registry.py`、`agent/backtest/loaders/akshare_loader.py`、`agent/backtest/loaders/additive_conversion.py`（上游新文件）、`tools/test_wiki_drift.py`

> 本轮读到的所有 git 与磁盘读数都是在 `f90473e2`（M3 收口 nit 轮）上测的；`git fetch upstream` 之后 `upstream/main` 的尖端是 `f21aa13d`。引用这些数字时必须带上这两个坐标之一，否则下一轮一读就对不上。

---

## 1. 目标与非目标

**目标**

1. 把上游 35 个提交并进 fork，并留下**三层独立的证据**：文本层证明「两边改动都还在」，测试层证明「两边的测试都还认账」，数值层证明「同一只 A 股经两个入口拿到的是同一个收益率口径」。
2. 交付一条**可复用的固定样本对账 harness**（不依赖网络）。它不属于这一次同步：以后每一次上游同步都重跑它，成本一次性。
3. 把本轮发现的口径碰撞**裁定并落档**——合并取证已证明两支读数都诚实（§3.1），所以本轮要交付的不是改动，而是**把"诚实"从巧合变成有断言撑着**：钉 `frame_caliber` 的 attrs-first 语义（G1）、降级支的出门口径（G2）、两条乘法实现的数值等价（G3）。（§6 的测量照做，但它现在只决定 fixture 形态，不再决定要不要动上游。）
4. 同步后 fork 自带的新鲜度门禁**在新水位下真绿**，且重钉过程不靠放宽阈值消音。

**非目标（本轮明确不做）**

- 不做任何新功能。上游 35 个提交里带来的新能力（南向资金工具、grounding registry、会计括号解析、Monte Carlo 初始资金、凭据脱敏）**并进来就自带**，本轮不自己实现、也不给它们补文档。
- 不动 `frontend/`：本轮 14 个重叠文件里没有一个是前端文件，零冲突面。
- 不重写 Wiki 散文（M5 的账），不补新模块的文档（§5 只登记欠账增量）。
- 不重排 `FALLBACK_CHAINS`、不改任何 loader 的取数优先级——那是功能轮的决定，混进来会让本轮的红/绿无法归因。
- 不 push、不建 PR、不动 `origin`。集成交付方式沿用「保持现状」，由你在同步完成后另行裁定。

---

## 2. 事实底座（全部实测，不是推测）

| 事实 | 读数 | 怎么量的 |
|---|---|---|
| 我们落后上游 | **35** 个提交（`upstream/main...HEAD = 35 / 235`；spec 提交后 `664e141f` 复测为 **`35 / 236`**） | `git fetch upstream` 后 `git rev-list --left-right --count` |
| 合并基点 | `18027a0c` | `git merge-base upstream/main HEAD` |
| 文本冲突 | **0**（自动合并即成功） | `git merge-tree --write-tree HEAD upstream/main` ⇒ `git_rc=0`，输出只有一行 tree oid（`f90473e2` 上是 `fed5389…`，`664e141f` 上重测为 `8a7a6740…`——**这个 oid 含我们的树，每次 HEAD 前移都要重取**） |
| 双方都改过的文件 | **14** 个：7 份 README、`agent/SKILL.md`、`agent/backtest/loader_health.py`、`akshare_loader.py`、`loaders/registry.py`、`agent/src/factors/bench_runner_strict.py`、`cli_handlers.py`、`market_data.py` | `comm -12` 两份 `git diff --name-only` |
| 重叠最重的三处 | `akshare_loader.py` 我们 `+346/-1` vs 上游 `+58/-0`；`registry.py` 我们 `+93/-37` vs 上游 `+13/-0`；`cli_handlers.py` 我们 `+61/-6` vs 上游 `+28/-3` | `git diff --numstat` 两侧分别对合并基点 |
| 上游新增文件 | **11** 个，其中 7 个是测试：`agent/backtest/loaders/additive_conversion.py`、`agent/src/tools/southbound_tool.py`、`agent/src/agent/grounding/{registry,identity_checks}.py`、`agent/tests/{test_additive_conversion,test_southbound_tool,test_grounding_registry,test_report_audit_accounting_parens,test_run_card_training_cutoff,test_agent_loop_strategy_provenance,test_validation_initial_capital}.py` | `git diff --diff-filter=A --name-only` |
| 受保护四前缀 | 上游这 35 个提交对 `.gitignore`、`tools/ci_grep_gates.sh`、`.github/workflows/test.yml`、`wiki/` **零改动**（0 行） | `git diff --name-only HEAD...upstream/main -- <四前缀> \| wc -l` |
| 本机全量套件基线 | **17043 passed / 169 skipped / 11 failed / 11 errors**（529.96s）。22 条红里 `OSError [WinError 1314] 客户端没有所需的特权` 出现 **20** 处（8 条 symlink 逃逸用例 + `agent/tests/factors/test_registry.py` 的 11 条 fixture error），另两条是 Windows 形状：并发写撞 `PermissionError(13)` 文件锁、一条时钟时限竞争 | `python -X utf8 -m pytest -q` 在 `f90473e2` |
| Wiki 现状 | 450 页、活水位 **445**、`repowiki/INDEX.md` 48301 字节、`index --check` rc=0、门禁 rc=0 | `python -X utf8 tools/wiki_drift.py` 与 `bash tools/wiki_freshness_gate.sh` |

**要点：合并的机械风险是零，全部风险在语义层。** `git merge` 会成功，成功本身不证明任何事。

---

## 3. 本轮发现的语义碰撞（原判词已被 §3.1 推翻，缺口重新定位为 G1–G3）

`akshare_loader.py` 在合并后的树里同时活着**三套**「A 股复权」实现：

1. **base 既有**：`_fetch_a_share`（合并后文件 `:417`）调 `ak.stock_zh_a_hist(..., adjust="qfq")`——分红**加法**口径。
2. **上游新增**（`HEAD...upstream/main`）：`fetch()` 主循环里 `:347-372` 判定「A 股且非 ETF」时，去取 `adjust=""` 的原始价伴侣（新方法 `_fetch_a_share_raw`，`:441`，同一个东财端点族），成功则用**新模块** `additive_conversion.convert_additive_to_multiplicative` 转成乘法口径并写 `attrs["adjustment"] = "split_dividend"`；**取失败就 `logger.warning` 后继续发 additive**（注释原文：`degrade to additive`）。
3. **我们新增**（`upstream/main...HEAD`）：`fetch_raw_with_factor`（`:603`）+ `_fetch_sina_raw_pair`（`:663`，新浪 `stock_zh_a_daily` raw + `hfq-factor`）+ `_sina_bars`/`_assert_cumulative`/`_assert_share_basis`，以及模块注释 `:58-65` 记录的实测事实：**本地仓 A 股入口刻意走新浪而不走 `stock_zh_a_hist`（东财 push2），因为那台 kline 主机在高负载下回 HTTP 501，新浪一直可达**。

碰撞的后果不是"两处代码重复"，而是**口径归属会不会被静默改掉**。§3 本节最初写下的判词是「降级 ⇒ 加法数据顶着 `split_dividend` 出门」，**这条已被后续取证推翻**，而且方向正好相反——见下面的更正块。保留原判词是为了让下一轮看得见错法长什么样。

### 3.1 更正（2026-10-03 第二轮取证，读数在 `664e141f` × `upstream/main=f21aa13d`）

三条实测，逐条推翻原判词的前提：

1. **静态表本来就按市场分档。** `PRICE_CALIBER_BY_SOURCE_MARKET` 里有 `("akshare", "a_share"): "split_dividend_additive"`（`agent/backtest/loaders/registry.py:351` 附近，注释记录的是 600519.SH 上 `fqt=1 - fqt=0` 的五个常数偏移实测）。原判词只引了 `PRICE_CALIBER_BY_SOURCE` 的 `"akshare": "split_dividend"`，漏了 `price_caliber()` 的取值顺序：**per-(source, market) 例外先赢**（`:427-429`）。所以降级时的回落读数不是 `split_dividend`，是 `split_dividend_additive`——诚实。
2. **上游自己带了 attrs 优先的读数口。** theirs-only 那侧往 `registry.py` 只加了一个函数：`frame_caliber(frame, source, market, symbol)`（`git diff HEAD...upstream/main -- registry.py` 全文 13 行），语义正是"先读 `frame.attrs["adjustment"]`，读不到才回落静态表"。而合并树里 `agent/src/market_data.py:464` 与 `agent/backtest/runner.py` 的 5 个标定 stamp 站点**已经全部是 `frame_caliber`**（`git grep frame_caliber 8a7a6740… -- agent`）。我们的分支没碰过这些行（`git diff upstream/main...HEAD -- market_data.py runner.py | grep '^+.*price_caliber('` 命中 0），所以这些 hunk 是**干净落地**而不是被我们覆盖——这正是零冲突的真实原因。
3. **合并不是"把谎报带进来"，是"把两处谎报一起关掉"。** 合并后：转换成功 ⇒ loader 写 `attrs["adjustment"]="split_dividend"`（`akshare_loader.py:369-372`）⇒ `frame_caliber` 报乘法；伴侣取数失败或转换自拒（返 `None`）⇒ 不写 attrs ⇒ 回落表 ⇒ 报 `split_dividend_additive`。两支都对。原判词担心的那一边不成立，反方向（转换成功却被表报成加法）也不成立。

**所以本轮残留的真缺口是别的东西**，三条都可测、可钉：

- **G1｜零测试。** 全仓没有任何用例断 `frame_caliber` 的 attrs-first 语义（`git grep -l frame_caliber upstream/main -- agent/tests` 无命中）。上游带函数、带 6 个调用点、不带测试。今天它对不对，只由"没人测过"这个事实支撑。
- **G2｜降级支的读数没被断过。** 上游 `agent/tests/test_additive_conversion.py:205`（`test_akshare_keeps_additive_when_raw_missing` 一族）只断"加法序列原样穿过"，**没断出门时 `adjustment` 字段是什么**。加法序列 + 无人断言的口径标签 = 一次表改动就能静默变成谎报。
- **G3｜两条乘法实现从没对过账。** `convert_additive_to_multiplicative`（从 additive 平台的**偏移**反推因子）与 `cn_adjust.apply_qfq`（直接用厂商**因子表**）是两条独立取数路线，同一个窗口的收益率理应一致；上游的用例全是合成小样本、单实现自证，跨实现零覆盖。**这才是本轮数值层该交付的东西。**

另有一条现成的盲区必须说清：既有的守卫 `UPSTREAM_OWNED`（`tools/test_wiki_drift.py:2792-2794`，正则 `^(\.gitignore|tools/ci_grep_gates\.sh|\.github/workflows/test\.yml|wiki/)`）**只保护这四个前缀**，本轮 14 个重叠文件**一个都不在其中**。所以「零上游改动」这条老判据兜不住本轮的险，文本层与数值层是新机器，不是走过场。

---

## 4. 底座动作

1. `git checkout -b sync/upstream-2026-10`（从 `f90473e2` 起）。
2. `git merge upstream/main --no-edit`。预期零冲突；若真出冲突（说明 `upstream/main` 在计划期间又动了），**停下来重测第 2 节全部读数**，不在旧结论上硬合。
3. 三层验收（§5）全绿前，`main` 与 `origin` 一概不动。
4. 验收不过 ⇒ 在同步分支上继续修；分支本身不可用（例如发现合并方向错了）时用 `git checkout main` + 删分支回到今天，**不用 `reset --hard` 冲掉任何未提交工作**（本轮每轮结束都要求 `git status --porcelain` 为空，所以不存在可丢的东西）。

---

## 5. 三层验收

每一层都必须交「**先弄红的证据**」：新增/改动的每条守卫，要演示它对应的失败确实能让它红，否则按本项目纪律记为假绿、不算交付。

### 5.1 文本层：两边改动都还在

对 14 个重叠文件逐 hunk 核对：`upstream/main...f90473e2` 的 ours-only hunk 在合并后的文件里逐字在位，`HEAD...upstream/main` 的 theirs-only hunk 同样在位。

**落点与收集面（写死，避免"加了用例但 CI 永远不收"）**：新用例放**新文件** `tools/test_upstream_sync.py`，理由是这个断言不属于 Wiki 那套守卫的语义面。但 fork 的工作流只跑 `python -X utf8 -m pytest tools/test_wiki_drift.py -q -m "not local_archive"`（`repowiki-freshness.yml:85`），上游的 `test.yml` 走 pyproject 的 `testpaths = ["agent/tests"]` —— **两边都不收 `tools/` 下的新文件**。所以本轮必须**同时**把 `repowiki-freshness.yml` 的 pytest 那一步改成收这两个路径（那是 fork 自有文件，允许改），否则这条守卫就是一支本地手动用例、不构成门禁。断言形式：逐文件给出「ours 命中数 / theirs 命中数 / 应有数」，任何一边少一块即红并打印缺失块的锚点文本。

- 可红性证明（两件，各证一面）：**用例面** —— 把合并后某个文件里 ours 的一个函数体改名（工作副本内、needle 唯一 + `finally` 字节还原 + sha256 前后校验），守卫必须红；**门禁面** —— 把改后工作流那一步的 pytest 命令原样在本地跑一次 `--collect-only`，新用例必须在收集清单里，再把命令临时改回只收 `test_wiki_drift.py` 跑同一个 `--collect-only`，命中数必须掉到 0。第二次跑完立刻还原工作流文件并校验字节，**不把"临时改回"留在树上**。
- 已知代价：`main` 的 diff 面从此多一个 merge 提交；守卫的 base 会随同步前移，fork 自有改动面重新变小（这是好事，也是 §3 那条守卫范围要重测的原因）。

### 5.2 测试层：两边的测试都还认账

- 上游带来的 18 个测试文件（含 7 个全新文件）全跑；重点 `test_additive_conversion`、`test_loader_health`、`test_southbound_tool`、`test_report_audit_accounting_parens`、`test_validation_initial_capital`、`test_agent_loop_strategy_provenance`。
- 口径与数据源用例全跑：`test_price_caliber`、`test_market_data_serving_source`、`test_get_market_data_provenance`、`test_sina_loader`、`test_fetch_sina_penalties`、`test_dropped_target_adjustments`、`test_warehouse_akshare_source`、`test_warehouse_loader`、`test_registry`。（2026-10-03 更正两处：① 原写作"我们侧的"是**误标**——实测这些文件相对 merge-base 两侧都是 0/0 改动，属共同祖先文件，名单里唯一 fork 自有的是 `agent/tests/test_warehouse_akshare_source.py`（ours-only，`+536/-0`）；② 原来点的 `cn_adjust 相关` 写作 `agent/tests/test_cn_adjust.py` 是个**假指针**，该文件不存在（`git ls-files --error-unmatch` 报 NO），因子法的既有覆盖住在 `test_dropped_target_adjustments.py` 与 `test_warehouse_loader.py` 里。名单照跑，只是不许把共同祖先的覆盖算成本轮的自研面。）
- 全量套件（约 9 分钟）与 §2 那条 22 项基线**逐条按成因归类**：能对上 WinError 1314 / 文件锁 / 时钟时限的记为既有环境红；对不上的单列「本轮新增红」并停下修，不许并进结论文字里。
- 门禁面：`python -X utf8 -m pytest -q -k upstream_owned`（实测 1 条）与 `bash tools/ci_grep_gates.sh`（实测 rc=1、19 行输出、`docs/` 0 行、`./.qoder/` 恰 1 条）在合并前后各跑一次，输出逐行对比（剥掉 6-hex 短 sha 后 `diff` 应为空）。

### 5.3 数值层：两个入口必须给同一个收益率

一条不依赖网络的固定样本 harness，落 `agent/tests/`（新文件，fork 自有；上游 CI 的 `pytest` 步骤会经 pyproject 的 `testpaths = ["agent/tests"]` 收集它）：

**这里刻意破了 Wiki 那套「只用 stdlib + pytest」的纪律**：收益率对账离不开 `pandas`/`numpy`，而 fork 的 `repowiki-freshness.yml` 只装 pytest。所以它必须住在 `agent/tests/`、由上游 `test.yml` 那条腿收集，本地跑法是**只跑这个新文件**（秒级），不为此重跑 9 分钟全量套件。

- **样本**（2026-10-03 更正：原判据的 (ii) 是错的，见下）：3 只跨除权日的沪深 A 股，入选标准三条——(i) 窗口内至少 2 个**纯现金分红**除权日；(ii) 窗口内**不得有送转**：`additive_conversion` 的模块 docstring 写死了「Windows that cross a 送转 (bonus-share) event have offsets that drift with the price level by construction, and this module refuses them」，送转窗口是它的**拒绝样本**而非等价样本，把送转当"能区分加法与乘法口径"的入选条件会造出一条注定 `None` 的等价断言；(iii) 至少一只是 `600519.SH`，因为口径表里 tencent/eastmoney 两条注释的实测都落在它身上（五个常数偏移覆盖 500 根），有现成的可比读数。**送转另开一支拒绝样本**：单独取一只窗口内跨送转的票，断 `convert_additive_to_multiplicative(...)` 返回 `None` **且**出门读数仍是 `split_dividend_additive`——"拒得对"和"标签对"要同时钉住，否则一次"顺手放宽 refusal"就变成静默错标。每只 500 根日线窗口，窗口与代码常量写死在测试里，不取实时数据。
- **fixture**：入库的 `raw` OHLCV + `hfq` 因子表 + 东财 additive `qfq` 序列各一份（不依赖 git-lfs，按本项目既有做法用 CSV 或 JSON；fixture 与 manifest 一起提交，bulk 目录 gitignore，参照「语料不入库」那条纪律的切法——进仓库的是被断言读的那几份，不是取数过程的中间产物）。
- **断言一（等价，对应 G3）**：`convert_additive_to_multiplicative(raw, additive)`（上游，从偏移反推因子）与 `cn_adjust.apply_qfq(raw, factor)`（因子法，warehouse/tushare lane 用的那套）在同一段真实 raw 上产出的**收益率**逐日一致。**只比 `pct_change`**，价格绝对值不比（两条 lane 的锚点日虽同为窗口末根，但供应商编码精度不同）。阈值上限 `1e-6`：为什么不是更小——供应商价格只到 2 位小数，500 根窗口下 `pct_change` 的累积舍入量级要先实测才知道能不能压到 `1e-9`；阈值必须**既能放过舍入、又能抓住一个分红量级的偏差**（约 `1e-3`），所以实施第一步是量出真实残差分布，再在 `≤1e-6` 上限内钉一个具体数并写进用例注释。additive 输入的来源形态按 §6 结局 A/B 标注（厂商原样回包 vs 因子反推），docstring 必须写清是互证还是一致性对账。
- **断言二（attrs-first 语义，对应 G1）**：`frame_caliber(frame, "akshare", "a_share", "600519.SH")` 在 frame 带 `attrs["adjustment"]="split_dividend"` 时必须返回 `split_dividend`，**即使静态表说这一格是 `split_dividend_additive`**；attrs 缺失时必须回落表。这一条今天全仓零覆盖，是本轮数值层最容易交付、也最不会被上游重复实现的一条。
- **断言三（降级/自拒不许静默，对应 G2）**：用替身显式制造伴侣取数失败与送转窗口两种 refusal，各断三件事——(a) 返回的 frame **不带** `attrs["adjustment"]`；(b) 走 serving 层（`fetch_market_data(include_provenance=True)`）时该符号的 `adjustment` 读数**等于 `split_dividend_additive`**（不是"没写"，也不是靠表碰巧）；(c) `logger.warning` 文本可见（`caplog`）。转换成功支同样走 serving，断 `adjustment == "split_dividend"`。
- **可红性证明**：三处植入，各处钉一条断言——① 把 fixture 的一个除权日因子人为改坏 ⇒ 断言一必须红；② 删掉 `frame_caliber` 里读 attrs 的那三行（**植入面是合并后的工作副本，`finally` 字节还原**）⇒ 断言二必须红；③ 把 `convert_additive_to_multiplicative` 的返回值置 None（改的是 fork 自有的测试替身，不动上游文件）⇒ 断言三的成功支必须红。三处都走 needle 唯一 + `finally` 字节还原 + sha256 前后校验的标准探针形状。**②要额外报一句**：它植入的是上游文件，只为证明本条用例可红、不留改动，还原后 `git status --porcelain` 必须回到空。

---

## 6. 口径裁定：测量照做，但两个结局都不再需要动上游文件

> 本节是 §3.1 更正的直接后果。原判据「结局 A 需要改 `registry.py` + `market_data.py` 两处上游文件、并申请显式豁免」**整块撤销**：§3.1 第 2/3 条实测表明合并态的读数已经两支诚实，改动无处可用。**对本轮约束（不动开源程序原文件）来说这是净收益——零豁免。**

第 5.3 节第一步仍然不是断言，是**测量**，但问题换了：本机 `ak.stock_zh_a_hist`（东财 push2 族）到底服不服务，决定的是**数值层 fixture 的 additive 序列能不能取到厂商原样回包**，而不是"有没有谎报"。§3 那条模块注释说这台主机在高负载下回 501，但那是「本地仓取数入口」的实测记录，不等于 `stock_zh_a_hist(adjust="")` 今天在这台机器上必挂。不许拿注释当结论。

- **结局 A（该端点在本机可服务）**：fixture 的 additive `qfq` 序列是厂商原样回包 ⇒ §5.3 断言一是**跨厂商取数路线的数值互证**（Sina 因子表 vs 东财 additive 平台），这是本轮能交付的最强形态。
- **结局 B（该端点不可达）**：additive 序列只能由本机可达的 Sina `hfq-factor` 步长反推出来（`除权参考价 = 前收盘 × f_next/f_prev` ⇒ 隐含每股现金红利），此时断言一**降级为"同一批公司行为在两种编码下的一致性问题"**，不是厂商互证。这个降级必须写进用例 docstring 与 `项目档案.md`，不许把一致性对账说成互证。
  - 两种结局都跑同一个测量步（一次性只读探针，不落文件、不进 CI），读数带提交号与日期进档案；同时把 G1/G2（`frame_caliber` 零测试、降级支出门口径零断言）**登记为上游缺口**——它们与本机可达性无关，在任意环境下都是"上游改了表就没人报警"。
  - **刻意不做的两件事**（沿用原判据，理由不变）：不为网络用例新建 pytest 标记（`pyproject.toml` 是上游地籍、`testpaths = ["agent/tests"]` 不许改；`tools/conftest.py` 的 `addinivalue_line` 只在 `tools/` 生效）；不在 `agent/tests/conftest.py` 里加跳过规则（上游文件，多一处同步冲突点换不来断言强度）。数值层的**断言面一律用入库 fixture**，所以这条"不做"没有代价。

两个结局都要落一条 `项目档案.md` 记录；不存在的第三种结局是"发现了，先记着"。

---

## 7. Wiki 连带后果（同步必然踩到，规程写死）

1. **水位只可能上升。** 合并后 HEAD 前进 ⇒ `tree_baseline()` 的众数回落点变新 ⇒ 450 页里被判 stale 的数量从 445 往 450 方向走。没有任何用例把「活水位等于 445」当断言（445 只活在两处阈值 needle 与档案的 20 处散文读数里），所以套件不会因此红——**但 fork 自带的 `repowiki-freshness.yml` 那道门会红**，这是设计如此：门禁的语义就是"水位变了要人来重钉"。
2. **重钉是两文件动作。** 必须**同时**改 `tools/wiki_freshness_gate.sh:16` 的 `${WIKI_STALE_MAX:-445}` 与 `.github/workflows/repowiki-freshness.yml:75` 的 `WIKI_STALE_MAX: '445'`，两处各被一条字面量 needle 钉住（`tools/test_wiki_drift.py:4811-4813` 钉脚本、`:5031`/`:5044`（同一条用例的 def 行与断言行）钉工作流）。只改一处会留下一条仍然绿的不一致，CI 里 env 赢。
3. **不许用放宽阈值消音。** 新水位必须是**重测出来的读数**，不是"够让门绿的数 +1"。若水位到 450（全树皆 stale），本设计接受"门继续红着、等 M5 收分片"这个结局，并把它写进档案，不改判据形状。
4. **`index --check` 不会红**：`INDEX.md` 是磁盘树的纯函数（M3 预飞行裁定 P-3），上游改 `agent/` 源码不动 `repowiki/` 树。这条要实测确认，不靠推理交付。
5. **散文欠账变大是预期后果**：上游带来的 4 个新生产模块（`additive_conversion`、`southbound_tool`、`grounding/registry`、`grounding/identity_checks`）没有对应 topic 页 ⇒ `uncovered`（今天 1382）继续涨。本轮只把增量登记进 M5 名单，不补文档。

---

## 8. 完成判据与停止条件

**DoD（七条全绿才算完）**

1. 同步分支上有且只有一个 merge 提交（外加 §5/§6 的守卫与 harness 提交），`main` 未被移动。
2. 文本层守卫：14 文件逐 hunk 全在位，且交过"改名即红"的证据。
3. 测试层：上游 18 个测试文件与我们侧口径用例全绿；全量套件的失败**逐条**归到 §2 那 22 项基线；`-k upstream_owned` 与 `ci_grep_gates.sh` 前后输出可 diff 为空（剥短 sha 后）。
4. 数值层：三条断言各交一次"先弄红"证据，收益率一致到 §5.3 钉下的阈值（上限 `1e-6` 相对误差）。
5. §6 的探针读数与 `ADDITIVE_SOURCE` 裁定落档，且 G1／G2／G3 三条缺口**各有至少一条断言撑着**；本轮零上游文件改动、零豁免（探针若临时植上游文件，按 sha256 还原后 `git status --porcelain` 必须空）。
6. 重钉后的 `bash tools/wiki_freshness_gate.sh` rc=0，且档案/README 里的水位读数与两处 needle 是同一个新数。
7. 每轮结束 `git status --porcelain` 空；全程 `git commit -s`、不 `--no-verify`、**不 push**。

**立刻停止并回到你面前问的情况**（不自己拍板）：合并期发现 `upstream/main` 又前进导致 §2 读数失效；需要动 `.qoder/`（要先退 IDE）；任何 push/PR/merge 到远端；任何触碰 §1 非目标的动作。

---

## 9. 已知代价与风险

- **harness 的一次性建造成本**是本轮最贵的一块（fixture 取数 + 三断言 + 两次可红性植入）。换来的是一条永久可复跑的同步闸门；若你判断"只要这次对上就行"，可以砍掉 fixture、只做真实取数的一次对账——但那会把结论变成时点性的，下次同步要重做全部工作。本设计按前者写。
- **网络与本机数据源形状**：A 股端点的可达性今天可达、明天可能 501，这不可控。因此数值层的**断言面一律用入库 fixture**，真取数只在"测量 §6 结局"那一步用一次，且不进 CI。
- **§6 的测量只影响 fixture 形态，不影响改动面**（更正后）：两个结局都是零上游文件改动，所以原设计里那条"本轮唯一可能被你判过重的动作"（动 `registry.py` + `market_data.py` 申请豁免）**不存在了**。剩下的代价是结局 B 会把断言一从"厂商互证"降为"编码一致性对账"，这个降级要写进用例 docstring 与档案，不许含糊。
- **merge 提交进 main 之后**，`upstream/main...HEAD` 的 base 前移，历史上"我们改过哪些上游文件"的证据要靠 `git log --first-parent` 与档案名单，不再靠单一 diff。这是同步的固有代价，不是本轮可优化项。

---

## 10. 交给实施计划的事（本轮不定切法）

任务切分、TDD 顺序、每步命令与预期读数由 `writing-plans` 出。设计侧对切片的唯一硬约束：§5 三层必须**各自**有独立的"先弄红"证据步，不许合并成一步交"看起来全绿"；§6 的测量步必须排在 fixture 采集之前（它决定 additive 序列是厂商原样回包还是因子反推，也就决定断言一能说什么话）。
