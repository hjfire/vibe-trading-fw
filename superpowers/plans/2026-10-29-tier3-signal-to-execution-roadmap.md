# 第三档路线图：信号 → 仓位 → 执行（G7–G9）

日期：2026-10-29
状态：定稿（随 G7 落仓；G8/G9 在各自片开始时再写 spec 与 plan）
上游：第一档 G1–G3（因子/选参/涨停池）、第二档 G4–G6（面板存储/监督学习/文档表）
均已收口，`agent/src/quantlib/` 现为 26 个带 `__all__` 的子模块、319 个导出名。

## 0. 为什么是这三片

前两档把「数据 → 特征 → 面板 → 样本外预测」这条链补齐了，但链条在
`supervised.fit_predict_panel` 的 `predictions` 宽表处断开：从「一张分数表」
到「一个可回测的持仓序列」之间的每一步仍要调用方手写，而手写最容易犯的
错恰好是三类：

1. **约束被静默违反**——单名权重超过上限、多空账本不中性、gross 漂移；
2. **换手成本缺席**——毛收益被当成净收益，高换手策略在纸面上永远更好；
3. **执行不可实现**——目标权重一夜之间全仓换手，忽略参与率与成交节奏。

三片各治一类，接口全部是纯函数＋宽表，不引入优化器框架、不碰实盘。

## 1. G7：约束权重构建（`construction.py`）

**缺口**：`portfolio.py` 只接受协方差矩阵（HRP/逆方差），`combination.py`
只合成因子面板，没有任何函数把「一行分数」变成「满足制度约束的权重」。

**交付**：
- `build_weights(scores, *, long_only=False, gross=1.0, max_weight=None,
  prior_weights=None, turnover_penalty=0.0, min_names=1) -> WeightResult`；
- 两种制度：long-only（权重非负、和 = gross）、dollar-neutral（净敞口 0、
  Σ|w| = gross）；
- 秩基权重（并列取平均秩）；逐名上限的迭代等量重分配；向先验权重收缩且
  收缩后仍精确满足全部约束；逐行退化报告（`insufficient`/`no_dispersion`）；
- 冻结数据类 `ConstraintReport`、`WeightResult`。

**边界**：不做协方差/风险模型、不做行业或因子中性（`neutralization.py`
已有残差化，组合约束是另一层）、不做整数股与手数、不做实盘下单。不注册
进 `quantlib_tool.ALLOWED_MODULES`（与 `selection`/`supervised` 一致：
面板体量超出 5000 叶预算）。

**验收**：手算向量 A–N、错误契约、逐行独立、精确性不变量、确定性/纯度、
变异自证 M1–M6；门 A–F；README 徽章 322 函数/27 模块；档案 §7.37。

## 2. G8：换手成本与净收益（`turnover.py`）

**缺口**：`impact.py` 有单笔冲击/滑点模型，但没有任何函数把「权重变化」
记成成本序列、把毛收益折成净收益，也没有盈亏归因的会计恒等式。

**计划交付**（开工时再冻结精确签名）：
- `trade_cost(weights, *, cost_bps=..., impact=None, adv=None) -> DataFrame`：
  逐日单边换手 `0.5·Σ|Δw|`，成本 = 换手 × 费率（可叠加 `impact.py` 的
  逐笔模型）；返回逐日成本与累计成本；
- `net_returns(gross_returns, costs, *, lag=1) -> DataFrame`：权重在 t 日
  收盘形成、t+lag 日起生效；成本在换手发生日扣除；
- `attribution_summary(...)`：毛收益、成本、净收益、成本占毛收益比、
  盈亏平衡成本（净收益归零时的 bps）；
- 会计恒等式：`net = gross - cost` 逐日成立（±1e-12），成本非负。

**边界**：不构造收益（调用方给），不优化换手，不做融券费用/税；不引入
新依赖。

**验收口径**：手算向量（含 lag 对齐与「成本只扣一次」）、未来函数自查
（t 日权重只能用 ≤t 的信息）、变异自证、门 A–F、徽章与档案。

## 3. G9：参与率上限下的执行排程（`execution.py`）

**缺口**：`impact.py` 自陈「没有交易轨迹」；目标权重与当前权重之间的差
没有任何函数切成可执行的日切片。

**计划交付**（开工时再冻结）：
- `schedule_trades(target, current, *, adv, max_participation=0.1,
  max_days=5, lot_size=None) -> ExecutionPlan`：按名生成逐日切片，
  每日成交量 ≤ `max_participation × adv`，确定性（不随机、不打乱顺序）；
- 未完成残差如实报告（`residual`、`days_used`、`unfilled`），不静默截断；
- 可选整手取整（`lot_size`），取整后的现金残差单独报告；
- 计划可复算：同一输入两次运行逐位相等。

**边界**：只产出计划，不连接券商、不读实时盘口、不下单；不建模
盘中价格路径（那是 `impact.py` 的输入）。

**验收口径**：手算切片向量、参与率不变量（逐日逐名 ≤ 上限）、
确定性、残差守恒（Σ切片 + 残差 = 目标 − 当前）、变异自证、门 A–F、
徽章与档案。

## 4. 依赖与顺序

```
G7 分数 → 目标权重
        └──> G8 权重变化 → 成本/净收益（只消费宽表，不 import G7）
        └──> G9 目标 vs 当前 → 执行切片（只消费宽表，不 import G7）
```

G8/G9 都以「任意权重宽表」为输入，不与 G7 形成 import 耦合；这样 G8/G9
可以独立用手算权重表验收。顺序仍是 G7 → G8 → G9：G7 的
`ConstraintReport.turnover` 是 G8 成本口径的唯一定义来源（单边、对原始
先验计），G8 不再自造第二种换手定义。

## 5. 共同纪律（三片都适用）

- 纯函数：无 I/O、无时钟、无环境变量、无全局状态；输入表不被修改。
- 不使用未来信息：第 t 行只读第 t 行（及其先验行），跨行独立性有测试钉。
- 验收 = 手算向量 + 错误契约 + 不变量 + 变异自证 + 门 A–F + 徽章 + 档案。
- 不新增第三方依赖；只用 numpy/pandas（G7/G8/G9 均不需要 sklearn/scipy）。
- 不注册进 `quantlib_tool.ALLOWED_MODULES`；API/MCP 面留给后续按需裁定。
- 提交一律 `git commit -s` ＋显式 pathspec；推送前 `git ls-remote` 对真值；
  推送后复读 CI 九腿。

## 6. 收口判据

第三档完成 = G7/G8/G9 三片各自「实现 + 测试 + 变异自证 + 门册 + 档案 +
推送后 CI 九腿全绿」，且 `quantlib` 徽章、`项目档案.md` 与各片 plan 的
执行期偏差三者读数一致。任何一片的恒红门先证「本片 0 贡献」再报告，
不调阈值、不修门、不清白名单。
