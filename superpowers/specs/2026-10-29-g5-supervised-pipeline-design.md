# G5（tier 2）设计：监督学习管线（泄漏防线先于工具）

日期：2026-10-29
状态：定稿（随 G5 提交落仓）

## 1. 要治的痛

`agent/src/quantlib/` 已有净化后的切分原语（`purged_kfold_splits`、
`purged_walk_forward_splits`、`combinatorial_purged_splits`、
`detect_boundary_leakage`），但**没有任何一条把特征面板喂给学习器再取样本外
预测的路径**。`neutralization.py` 只用 sklearn 做 PCA；`shadow_account/
extractor.py` 只做无监督聚类。想训练一个横截面收益模型的下游，只能自己手写
循环，而手写循环最容易犯的错恰是三类：

1. 预处理在**全样本**上拟合（标准化统计量里含测试期信息）；
2. 训练集切分没按标签跨度 purge（标签窗口跨进测试期的样本仍在训练里）；
3. 预测时用了测试期的标签（比如整表 `dropna` 把测试期标签的可见性带进训练）。

缺口写成一句话：**一条只依赖 numpy/pandas/sklearn、把「切分—预处理—训练—
预测—度量」串起来、并且把上述三类泄漏做成会红的断言的横截面学习管线。**

## 2. 目标 / 非目标

目标：

1. 新模块 `agent/src/quantlib/supervised.py`（纯函数，无 I/O、无时钟、无环境
   变量、无全局状态）。
2. 公开面：
   - `fit_predict_panel(features, labels, *, model=ModelSpec("ridge"),
     n_folds=5, horizon=1, expanding=True, embargo_fraction=0.01,
     standardize=True, random_state=0, min_train_samples=10)` → `MLRun`；
   - `assert_clean_splits(splits, label_end_times=None, *, n_samples=None,
     embargo_size=0)` → `list[Split]`，脏切分抛 `LeakageError`；
   - `compare_runs(left, right)` → `ComparisonResult`（同一 OOS 网格上的 A-B）；
   - 冻结数据类：`ModelSpec`、`FoldPrediction`、`SkippedFold`、`RunMetrics`、
     `ComparisonResult`、`MLRun`。
3. 三种学习器：`ridge`（可手算的闭式解）、`random_forest`、
   `gradient_boosting`（后两者只做不变量与确定性验收，不钉数值阈值）。
4. 验收：手算向量 A–G；泄漏探针（训练期与测试期特征互换、未来污染、前缀
   不变、测试期标签不可见）；变异自证 M1–M6。

非目标：

- 不做样本权重／标签衰减／分类分档／超参寻优。超参网格与 walk-forward 选参
  在 G2（`quantlib/selection.py`）已交付；本片只做「给定一组特征与模型，
  产出样本外预测」。
- 不引 XGBoost／LightGBM／torch（都不是声明依赖）。只用 sklearn
  （`neutralization.py` 已在用，锁里是 `scikit-learn==1.9.1`）。
- 不做中性化、不做组合权重、不做持久化。`run.predictions` 是一张普通的宽
  DataFrame，调用方可以交给 G4 的 `write_panel` 落盘；本模块不 import 存储层。
- **不构造标签**。`labels` 的约定是「日期 t 上已经算好的前向收益（覆盖
  t+1..t+horizon）」，由调用方负责；本模块只用 `horizon` 做 purge 几何，
  并保证除标签本身之外的任何测试期信息都不进训练。

## 3. 定义（冻结）

### 3.1 输入形状

`features: Mapping[str, pd.DataFrame]`，键是特征名（非空 str，**插入顺序
即设计矩阵列序**）；每张表与 `labels` 满足：

- `index` 是 `DatetimeIndex`，唯一、严格升序（乱序直接 `ValueError`：
  排序会静默改掉标签对齐，不做）；
- `columns` 与 `labels.columns` **逐元素相等**（`Index.equals`）；
- 可转 `float64`；NaN 允许；**±inf 拒绝**（与因子注册表同一口径）。

`labels: pd.DataFrame` 同形状、同索引、同列。

### 3.2 切分与 purge

`label_end_times = np.arange(n) + horizon - 1`，逐折用
`purged_walk_forward_splits(n, label_end_times=..., n_folds=..., 
embargo_fraction=..., expanding=...)`。walk-forward 只训练测试块之前的数据，
所以 embargo 只影响回报计数、不改变训练集（原语如此，逐字沿用）。

每一折先过 `assert_clean_splits`：内部调 `detect_boundary_leakage`，
`clean=False` 即抛 `LeakageError`，消息带折号与三类越界计数。这条断言对本片
自己的切分器恒真——它的判别力由向量 E 用**手工构造的脏切分**单独证明。

折号从 1 起、按测试块时间顺序。训练窗口为空（全被 purge）的折原语直接不
产出，所以不会出现在 `folds` 或 `skipped` 里；`skipped` 只记「有训练窗口但
有效训练样本数 < `min_train_samples`」的折。

### 3.3 折内预处理（训练期拟合）

对每一折：

1. 训练样本 = 训练日期 × 全部标的的行，保留**所有特征有限且标签有限**的行；
2. 若样本数 < `min_train_samples`：记 `SkippedFold(reason=
   "insufficient_training_samples")`，跳过该折；
3. 逐特征在训练样本上算均值与总体标准差（`ddof=0`）；
4. **零方差列**（std == 0）不进设计矩阵（`used_features` 不含它），
   `scaler_scale` 记 `0.0`，`importance` 记 0；
5. `standardize=True` 时用第 3 步的统计量变换；`False` 时原值进模型。
   两种情况下统计量都照算、照记录（审计面不随开关消失）。

### 3.4 预测

测试日期 × 全部标的的行，**只要求 `used_features` 有限**即可预测；否则该格
NaN（不 fillna、不拿同列均值补）。预测值写回一张 `index = 测试日期、
columns = labels.columns` 的宽表。

### 3.5 模型规格

`ModelSpec(name: str, kind: str = "ridge", params: Mapping[str, Any] = {})`：

- `kind="ridge"`：允许键 `alpha`（默认 1.0）；
- `kind="random_forest"`：允许键 `n_estimators`（100）、`max_depth`（None）、
  `min_samples_leaf`（1）；固定 `n_jobs=1`、`random_state=run.random_state`；
- `kind="gradient_boosting"`：允许键 `n_estimators`（100）、`learning_rate`（0.1）、
  `max_leaf_nodes`（31）；固定 `random_state=run.random_state`。执行期改用
  `GradientBoostingRegressor`——`HistGradientBoostingRegressor` 不提供
  `feature_importances_`，重要度口径（§3.6）无从落地；
- 未知 kind／未知参数键 → `ValueError`（列出允许集），不把拼写错误交给
  sklearn 的静默容错。

### 3.6 特征重要度

- ridge：`|coef|`（未进设计矩阵的列为 0）；
- 树模型：`feature_importances_`；
- 逐折归一化到和为 1（全零则保持全零）；`MLRun.importance` 是各折的算术
  平均（按特征名对齐），只有全部折都是线性模型时才可能为 0 向量。

### 3.7 度量

对 OOS 预测与 `labels` 逐日算**横截面 Spearman 秩相关**（两侧各自
`rank(method="average")` 后取 Pearson，不依赖 scipy）。某日有效配对 < 2、
或任一侧为常数 → 该日 IC 记 NaN，且**不计入** `n_days`。汇总：

- `rank_ic_by_day: pd.Series`（索引 = OOS 日期，含 NaN 行）；
- `rank_ic_mean` / `rank_ic_std`（`ddof=1`，`n_days<2` 时 NaN）/
  `rank_ic_ir`（std 为 0 或样本不足时 NaN）/ `rank_ic_t`
  （`mean / (std/√n)`，同上 NaN）；
- `mse`：有限配对上的均方误差（无配对 NaN）；
- `hit_rate`：`pred*label > 0` 的比例（任一为 0 的配对不参与，无配对 NaN）；
- `n_pairs`、`coverage = 有限预测格数 / (OOS 日期数 × 标的数)`。

`MLRun.predictions` 是各折测试块按时间拼接的宽表；折间日期若重叠（切分器
违约）直接 `RuntimeError`，不静默后写覆盖。

### 3.8 `compare_runs`

要求两张 `predictions` 的 index 与 columns 完全相同，否则 `ValueError`。
返回 `ComparisonResult(n_days, rank_ic_delta, rank_ic_t, mse_delta,
coverage_delta)`：逐日 IC 差（仅在两侧都有限的日期上）的均值与配对 t 统计量
（`ddof=1`，日期数 < 2 或差值 std 为 0 时 NaN）；`mse_delta` 与
`coverage_delta` 为右减左。

## 4. 手算向量（冻结）

所有向量固定 `random_state=0`；数值用 `np.testing.assert_allclose`
（`atol=1e-12`）钉死。

### 4.1 向量 A：OLS 精确拟合与逐日秩相关

6 个日期、2 只标的。特征 `x[t, s0] = t`、`x[t, s1] = t+1`；标签
`y = 2x + 1`。`model=ModelSpec("ridge", params={"alpha": 0.0})`、
`standardize=False`、`n_folds=3`（边界 0/2/4/6，walk-forward 产出折 1 测试
[2,4)、折 2 测试 [4,6)）。

- 折 1 训练 = 日期 0–1（4 个样本）；折 2 训练 = 日期 0–3（8 个样本，horizon=1
  不 purge 任何行）。
- OLS 闭式解：`coef=2`、`intercept=1`；OOS 预测逐格等于 `2x+1`
 （`x=4,5,5,6` → `9,11,11,13`）。
- 每日两只标的完美同序 ⇒ 每日 IC=1；`rank_ic_mean=1.0`、`rank_ic_std=0`、
  `rank_ic_ir` 与 `rank_ic_t` 为 NaN；`mse=0`、`hit_rate=1`、`coverage=1`。

### 4.2 向量 B：ridge 收缩的闭式解（独立 oracle）

6 个日期、1 只标的：`x=[0..5]`、`y=2x`、`alpha=17.5`、`standardize=False`、
`min_train_samples=2`、`n_folds=3`。

- 折 1 训练 `x={0,1}`：中心化 `Sxx=0.5`、`Sxy=1` ⇒
  `coef=1/18=0.05555555555555555`、
  `intercept=35/36=0.9722222222222222`；测试 `x=2,3` ⇒
  `13/12=1.0833333333333333`、`41/36=1.1388888888888888`。
- 折 2 训练 `x={0,1,2,3}`：`Sxx=5`、`Sxy=10` ⇒
  `coef=4/9=0.4444444444444444`、`intercept=7/3=2.3333333333333335`；
  测试 `x=4,5` ⇒ `37/9=4.111111111111111`、`41/9=4.555555555555555`。
- 每日只有 1 只标的 ⇒ 每日 IC 均 NaN、`n_days=0`、`rank_ic_mean` NaN；
  `mse` 按 4 个测试格手算（逐格残差 `35/12`、`175/36`、`35/9`、`49/9`）：
  `1225/144 + 30625/1296 + 1225/81 + 2401/81 = 99666/1296`，
  除以 4 得 `99666/5184 = 19.225694444444443`。
- 以上四枚预测值与两枚系数由真实 sklearn 1.9.0 跑出后写进本 spec
  （2026-10-29，`Ridge(alpha=17.5, fit_intercept=True)`）。
- 补针 B2（执行期加，2026-10-29）：6 日期、2 只标的、两标的的特征序列
  相同 ⇒ 每日预测横截面为常数（`size=2` 但秩方差 0）⇒ `n_days=0`、
  `rank_ic_by_day` 全 NaN、`n_pairs=8`。向量 B 本身是单标的日，走的是
  `size<2` 短路，够不到常数横截面分支——M6 初跑不红即由此；补此针后
  M6 才可观测。

### 4.3 向量 C：标准化不改变线性拟合

`y=x`、两只标的每日期值不同、`standardize=True`、`alpha=0.0`、`n_folds=2`：
预测逐格等于 `x`（标准化是可逆线性变换，OLS 与之交换）；同时钉
`scaler_mean`／`scaler_scale` 等于折 1 训练期的手算总体均值／标准差。

### 4.4 向量 D：purge 几何（horizon 是真杠杆）

12 个日期、2 只标的、`n_folds=4`（边界 0/3/6/9/12）、`horizon=4`：

- 折 1 测试 [3,6)：候选训练 [0,1,2] 的 `label_ends=[3,4,5]` 全部 ≥ 3
  ⇒ 训练窗为空，原语不产出该折；
- 折 2 测试 [6,9)：候选 [0..5]，purge 掉 3,4,5 ⇒ 训练 `[0,1,2]`、
  `purged=3`、训练样本 `3×2=6`；
- 折 3 测试 [9,12)：候选 [0..8]，purge 掉 6,7,8 ⇒ 训练 `[0..5]`、
  `purged=3`、训练样本 `6×2=12`。
- `min_train_samples=10` 时折 2 因 6<10 进 `skipped`
  （`reason="insufficient_training_samples"`），只有折 3 进 `folds`。
- 同一面板把 `horizon` 改成 1：折 2 的 `purged=0`、训练样本 12，
  两折都产出 ⇒ 断言 `horizon` 从 1 变成 4 时 `purged` 从 0 变成 3。

### 4.5 向量 E：审计断言的判别力

`assert_clean_splits` 直接喂三枚手工切分：

1. `train=[0,1,2]`、`test=[2,3]`（共享下标）→ 抛 `LeakageError`；
2. `train=[0,1,2]`、`test=[3,4]`、`label_end_times=[0,1,4,4,4]`
   （训练行 2 的标签覆盖到 4 ≥ 测试起点 3）→ 抛 `LeakageError`；
3. 同一枚脏切分把 `label_end_times` 换成 `[0,1,2,4,4]` → 不抛，返回列表
   长度 1。（测试行 3、4 的标签止于自身下标，满足审计器
   「标签不得在自己的观测之前结束」的输入不变式。）
- 第三条与第二条只差一个数，用来证明这条断言读的确实是标签跨度，不是
  「有训练有测试就放行」。

### 4.6 向量 F：折内拟合与测试期不可见（四枚探针）

同一张 8 日期 × 3 标的的确定性面板（ridge，`standardize=True`，
`n_folds=4` ⇒ 折 1 测试 [2,4)、折 2 测试 [4,6)）：

1. **测试期特征不进训练统计量**：把折 1 测试日期起的特征值整体 `× 1000`，
   折 1 的 `scaler_mean`／`scaler_scale` 逐位不变；**折 1 的预测必须变化**
   ——预测本来就消费测试特征，这一半是反向对照，证明第 1 条不是「预测根本
   没读测试期」；
2. **改训练期特征会改统计量**：把折 1 训练日期的特征 `+1`，折 1
   `scaler_mean` 必须变化——否则第 1 条是恒真断言；
3. **测试期标签不可见**：把折 1 测试日期的标签整体**取反**（`×(-1)`），折 1
   预测逐位不变（预测不消费测试标签），而 `rank_ic_by_day` 的测试段从
   `ic` 变成 `-ic`。执行期注意：等比例缩放（如 `×1000`）是单调变换、
   横截面秩不变，会让这半句恒真——必须用改变秩方向或秩序的扰动；
4. **前缀不变**：把第 5 个日期起的所有特征置为极端值，折 1（测试 [2,4)）
   的统计量与预测逐位不变，折 2（测试 [4,6)）的预测变化——后半句防真空。

### 4.7 向量 G：NaN 与零方差

- 某标的某测试日特征缺一格 ⇒ 该格预测 NaN、同折其他格有限；
- 训练行标签缺一格 ⇒ 不计入训练样本数（手算分母）；
- 常数列（训练期 std=0）⇒ `used_features` 不含它、`importance` 为 0、
  预测与「把该列删掉再跑」逐位相等；
- 全 NaN 列在校验期不抛（NaN 合法），但因训练样本要求全部特征有限，
  结果是 0 个有效训练样本 ⇒ 该折 `skipped`（不是崩溃）。

### 4.8 向量 H：树模型只钉不变量

20 日期 × 10 标的、`y = x`（3 个特征中的第一个，另两个是噪声）：

- `random_forest`（`n_estimators=50, max_depth=3`）与 `gradient_boosting`
  （`n_estimators=50`）各跑两遍，预测逐位相等（同 `random_state`）；
- 形状/列序/coverage 与 ridge 相同；重要性非负、和 ≤ 1+1e-12；
- OOS `rank_ic_mean > 0.0`（方向性，不钉具体值——具体值随 sklearn 版本漂）。

### 4.9 向量 I：A-B 比较

- 同一 run 比自身：`rank_ic_delta=0`、`mse_delta=0`、`coverage_delta=0`、
  `rank_ic_t` NaN（差值 std=0）；
- 网格不对齐（列换序）→ `ValueError`。

## 5. 可复现性论证

- 无时钟、无 I/O、无环境变量、无模块级可变状态；随机性只来自
  `random_state`，树模型固定 `n_jobs=1`。
- 同一输入两次调用：`predictions` 逐位相等，`metrics` 各标量相等
  （NaN 用 `np.isnan` 分别判）。
- 输入不被原地修改：调用前后对每张输入表 `.equals` 快照。
- 源码纯度：模块源文件里不得出现 `import os`／`import time`／`open(`／
  `os.environ`（模块级测试按源码字面断言）。

## 6. 验收判据（写死）

1. 向量 A–I 与补针 B2 全绿；其中 A/B/C/D/G 的数值逐格手算，E/F/I 为结构断言。
2. 变异自证（每条真红，逐条还原）：
   - M1 标准化统计量改用「训练 ∪ 测试」样本 → 向量 F 第 1 条的
     `scaler` 不变性红；
   - M2 `label_end_times` 传 `np.arange(n)`（丢掉 horizon）→ 向量 D 红；
   - M3 训练集并进测试行（标签可见）→ 向量 F 第 1、3 条红；
   - M4 预测前把 NaN 补 0 → 向量 G 第 1 条红；
   - M5 `assert_clean_splits` 对脏切分放行 → 向量 E 第 1、2 条红；
   - M6 逐日 IC 把常数日当 0 计入 → 向量 B2 的 `n_days`／`rank_ic_mean` 红
     （执行期更正：向量 B 是单标的日、`size<2` 先短路，够不到常数分支，
     故 M6 的可达域由补针 B2 提供——常数横截面、2 标的）。
3. 门 A `pytest agent/tests/quantlib -q` 零失败；门 B 后端全量对基线
   新增红 = 0；门 C–F 沿用 G1–G4 口径（本片不动 `frontend/**`、`wiki/**`、
   `repowiki/**`，前端三门免跑）。
4. 测试数当场数，不在文档里预言。

## 7. 风险与限制（明写，不藏）

- **标签约定不可验证**：本模块无法证明调用方传的 `labels` 真是前向收益；
  它只保证「训练不使用测试期特征统计量与测试期标签」。这条限制写进模块
  docstring。
- **walk-forward 首块只训练**：`n_folds=5` 只产出 4 个 OOS 块；`n_samples`
  太小可能一个折都不产出，此时返回空预测表 + 全 NaN 度量 + `note`，
  不抛异常（与 G2 `selection.py` 的 truthful-empty 口径一致）。
- **树模型重要性不是因果归因**，只是切分增益的归一化；文档不给它更强的
  解释。
- **横截面秩相关只度量排序**，对幅度误差由 `mse` 另行报告；两者不可互推。
- **性能**：每折把「日期 × 标的」摊平后训练，面板量级到万行时仍可接受；
  不做并行、不做增量。大面板请先降采样，这是调用方的选择。
- **sklearn 版本漂移**：树模型的预测值可能随版本变；本片只钉同版本逐位
  确定性与方向性，不钉跨版本数值（向量 H 明写）。
