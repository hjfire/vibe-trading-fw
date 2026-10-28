# G5（tier 2）实现计划：监督学习管线（泄漏防线先于工具）

日期：2026-10-29
坐标：spec＝`superpowers/specs/2026-10-29-g5-supervised-pipeline-design.md`
基线：main `bbc360d5`（G4 收口、CI 九腿全绿之后）

## Task 1: RED — 写测试

文件：`agent/tests/quantlib/test_supervised.py`

覆盖（全部按 spec §4 的向量逐条落针）：

1. **向量 A**：OLS 精确拟合（`coef=2`、`intercept=1`），OOS 预测
   `9,11,11,13`；逐日 IC=1、`rank_ic_std=0`、`rank_ic_ir`/`rank_ic_t` NaN、
   `mse=0`、`hit_rate=1`、`coverage=1`。
2. **向量 B**：ridge 闭式解四枚预测（`13/12`、`41/36`、`37/9`、`41/9`）
   与 `mse=99666/5184=19.225694444444443`；单标的每日 IC 全 NaN、`n_days=0`。
   （执行期更正：初稿写 `3626/81` 是把折 2 的平方和当成了均值。）
3. **向量 C**：标准化不改变线性拟合；`scaler_mean`/`scaler_scale`
   等于折 1 训练期手算值。
4. **向量 D**：`horizon=4` 的 purge 几何（折 2 `purged=3`、训练 `[0,1,2]`；
   折 3 `purged=3`、训练 `[0..5]`）；`min_train_samples=10` 时折 2 进
   `skipped`；同面板 `horizon=1` 时 `purged=0`、两折都产出。
5. **向量 E**：`assert_clean_splits` 对共享下标／标签越界两枚脏切分抛
   `LeakageError`，对只差一个数的干净切分放行。
6. **向量 F**：四枚泄漏探针（测试期特征改→scaler 不变而预测变；训练期
   特征改→scaler 变；测试期标签改→预测不变而 IC 变；未来污染→折 1 不变、
   折 2 变）。
7. **向量 G**：NaN 预测格、训练标签缺行的手算分母、常数列剔除与
   `importance=0`、全 NaN 列导致折跳过。
8. **向量 H**：`random_forest` 与 `gradient_boosting` 各跑两遍逐位相等、
   形状一致、重要性非负且和 ≤ 1+1e-12、`rank_ic_mean > 0`。
9. **向量 I**：同 run 自比全 0、`rank_ic_t` NaN；列序不同 → `ValueError`。
10. **输入校验**：乱序索引、列不对齐、±inf、非 `DatetimeIndex`、空
    features、未知 kind/参数、布尔型 `n_folds`、`horizon<1` 均抛。
11. **确定性/纯度**：同输入两跑逐位相等；输入表前后 `.equals` 不变；
    模块源码不含 `import os`/`import time`/`open(`/`os.environ`。

运行：

```bash
cd agent && python -m pytest tests/quantlib/test_supervised.py -q
```

期望：收集期 `ModuleNotFoundError: No module named 'src.quantlib.supervised'`。
实读：`1 error in 1.65s`，异常行与期望逐字相同。

---

## Task 2: GREEN — 写实现

文件：`agent/src/quantlib/supervised.py`

要点：

1. 校验层：形状/索引/列/数值/参数，逐条 `ValueError`，消息带具体键名。
2. 切分：`label_end_times = np.arange(n) + horizon - 1` 交给
   `purged_walk_forward_splits`；每折先过 `assert_clean_splits`
   （内部 `detect_boundary_leakage`）。
3. 折内预处理：训练样本掩码（特征全有限且标签有限）；`ddof=0` 均值/标准差；
   零方差列剔除；`standardize` 开关只影响是否变换、不影响统计量记录。
4. 模型：`Ridge`／`RandomForestRegressor(n_jobs=1)`／
   `GradientBoostingRegressor`，随机种子来自 `random_state`。
5. 预测：测试行只要求 `used_features` 有限；缺失格 NaN。
6. 度量：逐日秩相关（rank→Pearson，无 scipy）、`mse`、`hit_rate`、
   `coverage`、`n_days`/`n_pairs`；样本不足时全 NaN（truthful-empty）。
7. `compare_runs`：网格严格对齐；逐日 IC 差均值与配对 t；NaN 口径同 spec。
8. 输入不可变：任何写回都先 copy；OOS 拼接出现重复日期 → `RuntimeError`。

运行同一命令，期望全绿（枚数现数）。

---

## Task 3: 变异自证 M1–M6

逐条注入 → 测试必须真红 → 从动手前内存副本还原 → 比对 sha256 → 复绿。

- **M1** 标准化统计量改用「训练 ∪ 测试」样本 → 向量 F 第 1 条红。
- **M2** `label_end_times` 传 `np.arange(n)`（丢掉 horizon）→ 向量 D 红。
- **M3** 训练集并进测试行 → 向量 F 第 3、4 条红。
- **M4** 预测前把 NaN 补 0 → 向量 G 第 1 条红。
- **M5** `assert_clean_splits` 对脏切分放行 → 向量 E 第 1、2 条红。
- **M6** 逐日 IC 把常数日当 0 计入 → 向量 B 的 `n_days`/`rank_ic_mean` 红
  （单标的每日横截面是常数）。

若某条在可达域上不成立（等价变异），先算可达域并补针，再判红；不许把
「没红」记成「已证」。

**执行读数（2026-10-29，逐条字节级还原后 sha256 复原 = 真）**：

| 变异 | 实际红针 | 备注 |
| --- | --- | --- |
| M1 | F-test-features、C、B | 比预期多（B/C 的 scaler 也变） |
| M2 | D-horizon-four、D-min-train | 两枚 D 都依赖 horizon=4 |
| M3 | A、B、C、D×3、F×2、G-train-label | 宽面红，F 第 4 条未红（折 1 测试行未被扰动） |
| M4 | G-missing-feature | 恰为目标针 |
| M5 | E-shared、E-label-overlap | 恰为目标两针 |
| M6 | B2（补针后）；初跑 0 红 | 向量 B 是单标的日，`size<2` 先短路 |

M6 的初跑不红即「等价变异」：常数横截面分支在既有语料里不可达。已按上
条纪律补 B2 针（常数横截面 + 2 标的），再注入 M6 → 只红 B2。

---

## Task 4: 门禁、档案 §7.36、提交

```bash
cd agent && python -m pytest tests/quantlib -q 2>&1 | tail -3
cd .. && bash tools/ci_grep_gates.sh; echo "grep-gates rc=$?"
python -m pytest tools/test_ci_env_var_gate.py tools/test_ci_private_files_gate.py tools/test_doc_tables.py -q 2>&1 | tail -3
python -m pytest tools/test_wiki_drift.py -q 2>&1 | tail -3
bash tools/wiki_freshness_gate.sh; echo "watermark rc=$?"
```

后端全量（与 §7.35 基线同一命令行）：

```bash
PYTHONDONTWRITEBYTECODE=1 python -B -X utf8 -m pytest agent/tests -q --tb=no -rf \
  --continue-on-collection-errors --ignore=agent/tests/e2e_backtest \
  --ignore=agent/tests/test_e2e_harness_v2.py -p no:cacheprovider
```

取 FAILED 名集合与 G4 最终树基线（`85 failed, 21859 passed, 206 skipped,
9 errors`）做差，新增红必须 0。前端三门免跑（本片零 `frontend/**` 改动，
判据是 `git diff --name-only`）。

档案按仓库实际格式追加 `### 7.36 G5…`（bytes 层、CRLF），读数现填。

提交（显式 pathspec）：

```bash
git add agent/src/quantlib/supervised.py agent/tests/quantlib/test_supervised.py \
  项目档案.md superpowers/specs/2026-10-29-g5-supervised-pipeline-design.md \
  superpowers/plans/2026-10-29-g5-supervised-pipeline.md
git commit -s -m "feat(quantlib): leakage-audited cross-sectional learning pipeline" \
  -m "<why>"
```

推送前 `git ls-remote origin refs/heads/main` 对真值；cron 推进则改道
merge（不 rebase），合后复跑门 A 与档案读档门。推送后复读 CI 九腿。

## 执行期偏差（待回填）

- 2026-10-29：`HistGradientBoostingRegressor` 没有 `feature_importances_`，
  `gradient_boosting` 改用 `GradientBoostingRegressor`；公开参数键随之从
  `max_iter/l2_regularization` 变为 `n_estimators`。
- 2026-10-29：向量 F 第 3 条原用「测试期标签 ×1000」，等比例缩放是单调
  变换、横截面秩不变 ⇒ IC 半句恒真；改为取反（`×(-1)`），IC 从 `ic` 变
  `-ic`。
- 2026-10-29：向量 E 的 `label_end_times` 初值 `[0,1,4,0,0]`／`[0,1,2,0,0]`
  违反审计器「标签不得早于自身观测结束」的输入不变式，改为
  `[0,1,4,4,4]`／`[0,1,2,4,4]`。
- 2026-10-29：两枚 `assert_frame_equal` 的期望用 `labels.index[k:]`
  （保留 `freq="D"`），预测表的索引来自花式索引（`freq=None`）；对齐的是
  值与标签，不是全等元数据 ⇒ 加 `check_freq=False`。
- 2026-10-29：M6 初跑 0 红（不可达），补向量 B2 针后才真红，见 Task 3 表。
- 2026-10-29：新模块带 `__all__`，quantlib 徽章计数从 309 函数／25 模块变为
  319／26；门 B 首跑因此新增 15 枚 `test_readme_counts` 红，七份 README 徽章
  同步改数（改后该套件 `115 passed`），提交 pathspec 相应扩到七份 README。
- 2026-10-29：门 B 在最终树复跑 `85 failed, 21904 passed, 206 skipped,
  9 errors`，FAILED 名集合与 G4 基线逐名相等（新增红 0、消失 0）；首跑新增
  的另一枚 `test_concurrent_saves_use_distinct_temporary_files` 是已登记
  Windows 时序 flake（同树单跑一红一绿）。
