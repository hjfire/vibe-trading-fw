# G2（第 1 档）设计：参数网格寻优 × walk-forward OOS × Deflated Sharpe 护栏

日期：2026-10-28
状态：已定稿（用户已授权全程自主推进，本 spec 的设计裁定不等待复核）

## 1. 要治的痛

仓库里三件积木已经各自存在，但从未被串成一个协议：

- `agent/src/quantlib/crossvalidation.py:417` `purged_walk_forward_splits`：
  只产出 `train`/`test` 位置索引，不知道「参数」是什么；
- `agent/src/quantlib/multipletesting.py:339` `deflated_sharpe_ratio`：
  只需要 `n_trials` 这个数，而没人负责如实统计它；
- `agent/src/factors/bench_runner_strict.py`：只有**单切点** train/test，
  不是滚动窗口，也没有「每折重新选参」。

因此当前任何网格搜索结果都只能报「最优 IS（样本内）」。缺口写成一句话：
**一个每折只在训练窗里挑参数、测试窗只评估不重挑、并把实际搜索次数如实计入
Deflated Sharpe 的纯函数协议。**

## 2. 目标 / 非目标

目标：

1. 纯函数模块 `agent/src/quantlib/selection.py`：
   `walk_forward_selection(returns_by_param, *, n_folds=5, expanding=True,
   label_end_times=None, confidence=0.95, min_train_observations=30)`。
2. 返回冻结 dataclass：`WalkForwardSelection`（`folds`、`skipped`、`oos_returns`、
   `grid_size`、`n_trials`、`n_evaluations`、`deflated`、`note`）。
3. 每次选参只读该折 `train` 索引；OOS 只读 `test` 索引。
4. DSR 复用既有 `deflated_sharpe_ratio`，不复制公式、不改其字节。
5. 验收：手算向量、未来函数注入、并列确定性、短样本护栏、变异自证。

非目标：

- 不接 API / CLI / 前端 / zoo 注册表；不新增依赖（只用 numpy / pandas）。
- 不修改 `crossvalidation.py`、`multipletesting.py` 的任何字节（只 import）。
- 不做贝叶斯优化、剪枝、换手约束、组合权重；那属于别的片。

## 3. 协议定义（冻结）

### 3.1 输入

`returns_by_param: Mapping[str, Sequence[float] | np.ndarray | pd.Series]`

- 键必须是非空 `str`，值序列必须等长 `n >= 2`；空 Mapping → `ValueError`。
- 全为 `pd.Series` 时索引必须严格相等（`.equals`）；全为数组时用
  `RangeIndex(n)`。Series 与数组混用 → `ValueError`。
- NaN 原样保留：既不填也不插值；Sharpe 只在有限值上计算。

### 3.2 切分

直接调用 `purged_walk_forward_splits(n_samples=n, label_end_times=...,
n_folds=n_folds, expanding=expanding)`。

**既有语义照抄并钉住**：该函数产出 `n_folds - 1` 个测试块（第一段只作训练），
不是 `n_folds` 个。`label_end_times` 原样透传。

### 3.3 每折选参

- 对每个参数，在 `train` 索引的收益上算 per-observation Sharpe（与
  `multipletesting.sharpe_ratio` 同口径：`ddof=1`、不年化）。
- 不可选：Sharpe 非有限（NaN/Inf），或训练窗有限样本数
  `< min_train_observations`（默认 `MIN_OBSERVATIONS` = 30）。
- 可选集合为空 → 该折记入 `skipped`（`reason="no_eligible_parameter"`），
  不产出 OOS 段。
- 并列（`|Δ| <= 1e-12`）按参数名字典序取第一个；与 dict 插入顺序无关。

### 3.4 OOS 拼接

按折的时间顺序拼接「被选中参数」在 `test` 索引上的收益，索引沿用输入
（Series 输入用原索引，数组输入用 `RangeIndex`）。`test` 段的 NaN 原样保留。

### 3.5 DSR 护栏

- `n_trials = grid_size`：DSR 校正的是**选择偏差**，而每次选择面对的搜索面
  都是同一个网格；同一参数组合在不同折上重复评估不是独立试验，不能乘折数。
- `n_evaluations = grid_size × attempted_folds`（诊断字段，**不**喂给 DSR），
  其中 `attempted_folds = len(folds) + len(skipped)`。
- `trial_sharpe_std`：所有 `(fold, param)` 组合的训练窗 Sharpe 有限值的
  样本标准差（`ddof=1`）；不足 2 个有限值 → `0.0`。
- `observed_sharpe`：拼接后 OOS 的 per-observation Sharpe（`ddof=1`）。
- `n_observations = len(oos_returns)`；若 `< MIN_OBSERVATIONS` →
  `deflated = None` 且 `note` 说明原因（与 `bench_runner` 的短样本口径一致）。
  不允许返回一个「看起来能读」的 NaN 概率。
- 单参数网格 → `n_trials = 1` → 期望最大值为 0，DSR 退化为 PSR
  （「没有搜索可校正」必须真的没有）。
- 所有折都跳过 → `ValueError`（不返回空协议）。

### 3.6 为什么没有未来函数

- 选参函数只接收 `train` 索引切片；测试段收益在选定之后才被读取。
- 判据 2/3 用注入证明：改测试段收益不改变该折 `chosen`；改未来折收益
  不改变前面折的 `chosen` 与 OOS 前缀。

## 4. 手算向量（冻结）

### 4.1 小样本向量（12 点 × 2 参数 × 3 段 → 2 折）

`n_folds=3` 时 `purged_walk_forward_splits` 的边界为 `0,4,8,12`：

- fold 1：`train=[0,4)`、`test=[4,8)`；
- fold 2：`train=[0,8)`、`test=[8,12)`。

参数序列（`B = -A`）：

```
A = [ 0.4, 0.2, 0.4, 0.2, -1.1,-0.9,-1.1,-0.9,  1.1, 0.9, 1.1, 0.9]
B = [-0.4,-0.2,-0.4,-0.2,  1.1, 0.9, 1.1, 0.9, -1.1,-0.9,-1.1,-0.9]
```

- fold 1 训练窗 `mean(A)=0.3`、`mean(B)=-0.3`，标准差相同 → 选 A；
- fold 2 训练窗 `mean(A)=-0.35`、`mean(B)=+0.35` → 选 B；
- OOS 逐点等于 `A[4:8] ++ B[8:12]` =
  `[-1.1,-0.9,-1.1,-0.9, -1.1,-0.9,-1.1,-0.9]`；
- `n_trials = 2`（网格大小）；`n_evaluations = 2 × 2 = 4`；
  OOS 长度 8 `< 30` → `deflated is None` 且 `note` 存在。

**该向量必须显式传 `min_train_observations=2`**：训练窗只有 4/8 个样本，
默认门槛 30 会（正确地）把两折都拒绝。默认门槛这一面另有一针：
同样的 12 点输入不传该参数时抛 `ValueError`。

这个向量同时证明「选参只看训练窗」：若偷看测试段，fold 1 会选 B、fold 2 会选 A。

### 4.2 长样本向量（120 点 × 2 参数 → DSR 数值面）

`n_folds=3` → 边界 `0,40,80,120`：fold 1 `train=[0,40)`/`test=[40,80)`，
fold 2 `train=[0,80)`/`test=[80,120)`；两折训练窗都 ≥ 30，默认门槛可用。

A 的前 70 个点按 `[+0.012, -0.008]` 交替（35 正 35 负），第 70 个点起按
`[-0.012, +0.008]` 交替；B 取反。

- fold 1 训练窗 `[0,40)`：A 均值 `+0.002`、B 均值 `-0.002` → 选 A；
- fold 2 训练窗 `[0,80)`：A 均值 `+0.0015`（前 70 点 `+0.002`、后 10 点
  `-0.002`）、B 均值 `-0.0015` → 仍选 A；
- OOS = `A[40:120)`，长度 80 ≥ 30 → DSR 可算；
- OOS 均值 = `(30×0.002 + 50×(-0.002)) / 80 = -0.0005 < 0` → Sharpe 为负。
- 手算常量在实现时用独立算式算定并写死（不调用被测函数）：
  `observed_sharpe`、`trial_sharpe_std`、`n_trials == 2`、
  `n_evaluations == 4`、`n_observations == 80`、`survives is False`。

## 5. 数据接线

无。纯函数，不进 zoo、不进 API。若将来要接 bench，另开一片，并把「收益序列
如何生成」的未来函数责任划给该片。

## 6. 验收判据（写死）

1. **手算向量**：§4.1 逐点相等；§4.2 的 DSR 字段与手算常量相等。
2. **未来污染（测试段）**：把 fold 1 test 段收益改成极端值，fold 1 的
   `chosen` 不变。（2026-10-28 执行期更正：原文写「两折 `chosen` 不变，
   OOS 逐点不变」，这与 §4.1 的分折边界自相矛盾——fold 2 的训练窗
   `[0,8)` 包含 fold 1 的 test 段 `[4,8)`，其 `chosen` 允许改变；而 OOS
   就是 test 段收益本身，篡改后必然改变。判据 3 继续守「更晚的折不影响
   更早的折」。）
3. **未来污染（未来折）**：把 fold 2 test 段改掉，fold 1 的 `chosen` 与
   OOS 前 4 点不变。
4. **选参只读训练窗**：把 A 在 fold 1 test 段改成 `+100`，fold 1 仍选 A。
5. **并列确定性**：两参数训练窗 Sharpe 完全相等时按名字典序取第一个；
   打乱 dict 插入顺序结果不变。
6. **不可选参数**：训练窗全 NaN 的参数不被选；一折全不可选时进 `skipped`
   且有 `reason`；所有折都跳过 → `ValueError`；默认门槛 30 拒绝 12 点向量。
7. **短样本护栏**：OOS `< MIN_OBSERVATIONS` → `deflated is None` + `note`。
8. **DSR 口径**：`n_trials == grid_size`；
   `n_evaluations == grid_size × attempted_folds`；
   `trial_sharpe_std` 与独立手算一致；单参数网格的
   `deflated.expected_maximum_sharpe == 0`。
9. **输入校验**：索引不等、长度不等、空 Mapping、`n_folds < 2` → `ValueError`。
10. **变异自证**（每条注入后测试必须真红，再按动手前的内存副本还原）：
    M1 选参改用 test 段 Sharpe；M2 `n_trials` 误乘折数（把评估次数当试验次数）；
    M3 并列裁决改成 dict 顺序；M4 跳过折仍拼进 OOS；
    M5 `trial_sharpe_std` 改用 OOS 段 Sharpe。
11. **门禁**：新测试全绿；后端全量新增红为 0；恒红门先证「本片 0 贡献」再报告，
    不调阈值、不修门、不清白名单。

## 7. 风险与限制（明写，不藏）

- 输入是「每个参数组合的收益序列」矩阵；本模块**不验证**这些序列的生成过程
  是否含未来函数——那是策略/因子层的责任。
- 每折独立选参，未建模参数切换成本；换手约束属于别的片。
- `n_trials = grid_size` **不**乘折数：DSR 校正的是选择偏差（每次选择的搜索面
  大小），同一网格在每折重复评估不是独立试验。评估次数单列为 `n_evaluations`，
  只作诊断；若有人把它当 `n_trials`，门槛会被无端抬高——变异 M2 专门钉这一点。
- `trial_sharpe_std` 用训练窗 Sharpe 的分散度；若网格设计得极窄，标尺会偏小、
  DSR 偏乐观。spec 明写，不藏。

## 8. 「Bar Replay 五步自查」的后端等价物

1. **只用已收盘数据**：选参只切 `train` 索引；测试段在选定后才读。
2. **信号不重绘**：判据 2/3 的注入证明。
3. **窗口不越界**：直接复用 `crossvalidation` 的 purge 语义；测试钉
   `set(train) ∩ set(test) == ∅`。
4. **自喂检查**：无自喂面（选参与评估用互不相交的索引）。
5. **变异可证**：判据 10 的五条注入全部真红。
