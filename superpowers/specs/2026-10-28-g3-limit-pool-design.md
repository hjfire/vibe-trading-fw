# G3（第 1 档）设计：涨停池、连板天梯与炸板率（纯函数）

日期：2026-10-28
状态：定稿（2026-10-28；随 G3 提交落仓）

## 1. 要治的痛

仓库里只有**执行侧**的涨跌停规则，没有**研究侧**的事件口径：

- `agent/backtest/engines/china_a.py` 的 `_price_limit`（10%/20%/30%）只回答
  「这笔单能不能成交」；
- `agent/src/tools/paper_trade/limits_cn_a.py` 的 `heuristic_limit_prices`
  把「上一收盘 + 板块比例 + ST」折成价格带，只服务纸交易；
- 没有任何函数从日线面板里回答「今天多少家封板、多少家炸板、连板天梯长什么样、
  昨日 N 板今天晋级几家」。

tushare 的 `limit_list_d`（5000 积分）与 `limit_step`（8000 积分）本机不可用，
因此本片**只做纯函数 + 手算向量**，不调用任何积分接口，也不声称与它们数值一致。

缺口写成一句话：**一个只吃未复权日线 + 昨收 + ST 标记、可手算、可对账的
打板事件引擎，连同涨停池、连板天梯、炸板率与晋级率四张表。**

## 2. 目标 / 非目标

目标：

1. 纯函数模块 `agent/src/factors/limit_pool.py`：宽表进、宽表出，无 I/O、
   无网络、无全局状态。
2. 公开面：
   - `limit_prices(prev_close, symbol, is_st=False)` → `(up_limit, down_limit)`；
   - `limit_events(high, low, close, prev_close, *, is_st=None)` →
     `LimitEventTables(status, streak)`；
   - `daily_summary(status, streak)` → 涨停池日表；
   - `board_ladder(streak)` → 连板天梯；
   - `promotion_rates(streak)` → 晋级率表；
   - `events_long(status, streak)` → 归档长表；
   - `limit_pool(...)` → `LimitPoolTables` 总装。
3. 验收：手算向量 A–E；前缀==全量；未来污染；缺失 bar；变异自证 M1–M5。

非目标：

- 不调用 `limit_list_d` / `limit_step` / `cyq_*`；不接 futu/OpenD；
- 不新增 API/CLI/前端/注册表 alpha；
- 不做持久化（归档长表只是 DataFrame，落不落盘由调用方决定）；
- 不建模 `open_times`（炸板次数）、`first_time`/`last_time`（封板时间）、
  一字板——日线 OHLC 里没有这些量；
- 不处理新股上市首日/复牌首日的无涨跌幅例外（没有昨收即判无效，不编造）。

## 3. 定义（冻结）

### 3.1 输入与单位

四个宽表 `high`/`low`/`close`/`prev_close`：`index = trading_date`
（严格递增且唯一），`columns = instrument_code`；单位元；**必须是未复权价**。
涨跌停价按交易所价格计算，前复权价会让分位比较失真——这条写进模块 docstring
与测试名， caller 责任不由引擎猜。

`prev_close` 必须显式传入（tushare `daily.pre_close` 口径）；
**不提供 `close.shift(1)` 隐式回退**——那会把复权口径错误藏起来。

`is_st`：可选布尔宽表，缺省全 False。ST 只在主板把 ±10% 收窄到 ±5%，
创业板/科创板/北交所保持板块比例（与 `heuristic_limit_prices` 同口径）。

四表必须索引与列完全一致，否则 `ValueError`。

### 3.2 涨跌停价

直接复用 `agent/src/tools/paper_trade/limits_cn_a.py::heuristic_limit_prices`
（VD-2 式「import 复用、不改字节」）：板块比例来自
`backtest.engines.china_a._price_limit`，ST 覆盖与 0.01 分位
`ROUND_HALF_UP` 都在既有实现里。`limit_prices` 只是逐标量的公开包装，
`prev_close <= 0` 抛 `ValueError`（既有函数已有此检查）。

### 3.3 单日状态 `status`

合法 bar = `high/low/close/prev_close` 四值有限且为正、`high >= low`；
否则该格为 `None`（未知），不参与任何计数。

对合法 bar，令 `up`/`down` 为 3.2 的价格带，`tol = 1e-9 * max(|up|, |down|, 1.0)`：

- `up`：`close >= up - tol`（封涨停）
- `broken_up`：非 `up` 且 `high >= up - tol`（炸板：盘中触及、收盘未封）
- `down`：`close <= down + tol`（封跌停）
- `broken_down`：非 `down` 且 `low <= down + tol`（跌停开板）
- `none`：其余

优先级：先判 `up`，再判 `broken_up`，再判 `down`，再判 `broken_down`。
`close` 只有一个值，构造上不会同时封涨停与封跌停。

### 3.4 连板数 `streak`

按时间逐行、逐标量递推：

- 合法 bar 且 `status == "up"`：`streak = 前一值 + 1`（前一值有限且 > 0），
  否则 `streak = 1`；
- 合法 bar 且非 `up`：`streak = 0`；
- 非法 bar：`streak = NaN`，**链条中断**（下一根涨停从 1 重新起算）。

dtype 为 float64（NaN 载体），取值恒为整数或 NaN。

### 3.5 涨停池日表 `daily_summary`

按日计数与比率（`index = trading_date`）：

| 列 | 定义 |
| --- | --- |
| `n_valid` | 合法 bar 家数 |
| `limit_up` / `limit_down` | 封涨停／封跌停家数 |
| `broken_up` / `broken_down` | 炸板／跌停开板家数 |
| `touched_up` / `touched_down` | `limit_up + broken_up` / `limit_down + broken_down` |
| `seal_rate` | `limit_up / touched_up`（分母 0 → NaN） |
| `broken_rate` | `broken_up / touched_up`（分母 0 → NaN） |
| `limit_up_ratio` | `limit_up / n_valid`（分母 0 → NaN） |
| `max_board` | 当日最大连板数（无涨停 → NaN） |

计数列 int64；比率列 float64。恒等式 `seal_rate + broken_rate == 1`
（分母非零时）由测试逐日钉住。

### 3.6 连板天梯 `board_ladder`

`index = trading_date`，列 `board_1 … board_N`，`N = 全样本最大连板数`
（全样本无涨停 → 零列）。`board_k[t] = #{streak[t] == k}`，int64。

### 3.7 晋级率 `promotion_rates`

列 `base_1 … base_N`、`promoted_1 … promoted_N`、`rate_1 … rate_N`、
`base_total`、`promoted_total`、`overall`：

- `base_k[t] = #{streak[t-1] == k}`；
- `promoted_k[t] = #{streak[t-1] == k 且 streak[t] == k + 1}`；
- `rate_k[t] = promoted_k / base_k`（分母 0 → NaN）；
- `base_total[t] = #{streak[t-1] >= 1}`；
- `promoted_total[t] = Σ_k promoted_k[t]`；
- `overall[t] = promoted_total / base_total`（分母 0 → NaN）；
- 首日无前一日：计数为 0、比率为 NaN。

晋级只认**恰好 +1**板；停牌/缺失 bar 当日 `streak = NaN`，不计入
`promoted`（也不计入下一日的 `base`）。

### 3.8 归档长表 `events_long`

只保留合法 bar 的行，列为
`trade_date, instrument, status, streak`，按 `(trade_date, instrument)` 排序。
这就是「打板事件归档」的最小形状；落盘格式不属本片。

### 3.9 总装 `limit_pool`

一次调用返回冻结 dataclass：

```python
@dataclass(frozen=True)
class LimitPoolTables:
    status: pd.DataFrame
    streak: pd.DataFrame
    daily: pd.DataFrame
    ladder: pd.DataFrame
    promotion: pd.DataFrame
    events: pd.DataFrame
```

## 4. 手算向量（冻结）

### 4.1 向量 A：涨跌停价与分位

| prev_close | symbol | is_st | up | down |
| --- | --- | --- | --- | --- |
| 10.00 | 000001.SZ | False | 11.00 | 9.00 |
| 10.00 | 300001.SZ | False | 12.00 | 8.00 |
| 10.00 | 688001.SH | False | 12.00 | 8.00 |
| 10.00 | 920001.BJ | False | 13.00 | 7.00 |
| 10.00 | 000001.SZ | True | 10.50 | 9.50 |
| 10.00 | 300001.SZ | True | 12.00 | 8.00 |
| 2.05 | 000001.SZ | False | 2.26 | 1.85 |
| 10.03 | 000001.SZ | False | 11.03 | 9.03 |

最后两行钉 `ROUND_HALF_UP`：`2.05 × 1.1 = 2.255`、`2.05 × 0.9 = 1.845`，
银行家舍入会得 2.25/1.84。`prev_close = 0` 抛 `ValueError`。

### 4.2 向量 B：状态与涨停池（5 标的 × 2 日，主板）

第 1 日全部 `prev_close = 10.00`：

| 标的 | high | low | close | status |
| --- | --- | --- | --- | --- |
| A | 11.00 | 10.20 | 11.00 | up |
| B | 11.00 | 10.50 | 10.80 | broken_up |
| C | 10.90 | 9.00 | 9.00 | down |
| D | 10.50 | 9.00 | 9.05 | broken_down |
| E | 10.50 | 9.50 | 10.00 | none |

日表第 1 行：`n_valid=5, limit_up=1, limit_down=1, broken_up=1,
broken_down=1, touched_up=2, touched_down=2, seal_rate=0.5,
broken_rate=0.5, limit_up_ratio=0.2, max_board=1`。

第 2 日 `prev_close` 取第 1 日 close：

| 标的 | prev_close | up | down | high | low | close | status | streak |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A | 11.00 | 12.10 | 9.90 | 12.10 | 11.50 | 12.10 | up | 2 |
| B | 10.80 | 11.88 | 9.72 | 11.88 | 11.00 | 11.88 | up | 1 |
| C | 9.00 | 9.90 | 8.10 | 9.90 | 8.50 | 9.90 | up | 1 |
| D | 9.05 | 9.96 | 8.15 | 8.20 | 8.10 | 8.15 | down | 0 |
| E | 10.00 | 11.00 | 9.00 | 10.20 | 9.80 | 10.00 | none | 0 |

日表第 2 行：`n_valid=5, limit_up=3, limit_down=1, broken_up=0,
broken_down=0, touched_up=3, touched_down=1, seal_rate=1.0,
broken_rate=0.0, limit_up_ratio=0.6, max_board=2`。

天梯：第 1 日 `board_1=1, board_2=0`；第 2 日 `board_1=2, board_2=1`。

晋级：第 1 日 `base_total=0, overall=NaN`；第 2 日 `base_1=1, promoted_1=1,
rate_1=1.0, base_total=1, promoted_total=1, overall=1.0`。

### 4.3 向量 C：链条中断（1 标的 × 7 日）

状态序列 `[up, none, up, 缺失, up, up, none]` →
`streak = [1, 0, 1, NaN, 1, 2, 0]`。

### 4.4 向量 D：天梯与晋级（P/Q/R/S × 3 日）

- 第 1 日：P/Q/S 涨停，R 非涨停 → `streak = [1,1,0,1]`，`board_1=3`；
- 第 2 日：P/Q/S 继续涨停，R 也涨停 → `streak = [2,2,1,2]`，
  `board_1=1, board_2=3`；`promoted_1=3, rate_1=1.0, overall=1.0`
  （`base_total=3`）；
- 第 3 日：P/S 继续（3 板），Q/R 断板 → `streak = [3,0,0,3]`，
  `board_3=2`；`base_2=3`（P/Q/S），`promoted_2=2`（P/S）→
  `rate_2 = 2/3`；`base_1=1`（R），`promoted_1=0` → `rate_1=0.0`；
  `base_total=4`，`promoted_total=2`，`overall=0.5`。

### 4.5 向量 E：一 tick 之差

`up = 11.00` 时：`high=11.00, close=10.99` → `broken_up`；
`close=11.00` → `up`。`down = 9.00` 时：`low=9.00, close=9.01` →
`broken_down`；`close=9.00` → `down`。

## 5. 无未来函数论证

- `status/streak` 在第 t 行只读第 ≤ t 行与第 t 行的 `prev_close`（开盘前已知）；
- `daily/ladder` 第 t 行只读第 t 行；`promotion` 第 t 行只读 t-1 与 t；
- 不读任何未来行。测试用两条注入证明：
  1. **前缀==全量**：`limit_pool` 只喂 `[0:k]` 与喂全长后取前 k 行，
     `status/streak/daily/ladder/promotion` 逐值相等（`assert_frame_equal`）；
  2. **未来污染**：把 `[k:]` 的 high/low/close 改成极端值后重跑，
     `[0:k]` 的所有表逐值不变。

## 6. 验收判据（写死）

1. **手算向量**：§4.1–§4.5 逐项相等（含 NaN 位置）。
2. **前缀/污染**：§5 两条注入全绿。
3. **缺失 bar**：NaN 行的 status 为 `None`、streak 为 NaN；日表不计数；
   链条在下一次涨停从 1 起算（向量 C）。
4. **输入校验**：索引或列不一致、索引非严格递增、`prev_close <= 0`、
   合法行 `high < low` → `ValueError`；空面板 → 空表且列齐全。
5. **ST 与板块**：向量 A 八行；ST 标的 10% 价被拒、5% 价被认。
6. **比率恒等式**：分母非零的每一天 `seal_rate + broken_rate == 1`；
   `promoted_total <= base_total`；`rate_k` 与 `base_k/promoted_k` 自洽。
7. **变异自证**（注入后测试真红，再按动手前内存副本还原）：
   - M1：`ROUND_HALF_UP` 换成内置 `round`（向量 A 后两行真红）；
   - M2：把 `broken_up` 当成 `up`（向量 B 第 1 日 seal_rate 真红）；
   - M3：连板断板不归零（向量 C/D 真红）；
   - M4：晋级改成「≥ k+1 即算」（向量 D 第 3 日 `promoted_2=3` 真红）。
     2026-10-28 执行更正：该式在 `_streak` 的可达域上与 `== k+1` 恒等
     （streak 只 +1 或归零；60 个随机面板差分 0 差异），不能判别；实际改用
     `values == level`（promoted 恒 0）作替代探针，两针真红；
   - M5：`status` 偷看下一行 high（前缀/污染两针真红）。
8. **门禁**：新测试全绿；后端全量新增红为 0；恒红门先证「本片 0 贡献」
   再报告，不调阈值、不修门、不清白名单。

## 7. 风险与限制（明写，不藏）

- **未复权价是硬前提**：`TushareLoader` 默认返回 qfq 价，直接喂进来会
  因除权日价格带失真而误判。本片不猜、不自动反推，只在 docstring 与
  参数名上写死；调用方要用 `fetch_raw_with_factor` 的未复权侧。
- `open_times`（炸板次数）、封板时间、一字板、封单额都不在日线里；
  本引擎的 `broken_up` 是「触板未封」的布尔，不是次数。
- 新股/复牌首日无昨收 → 判无效；上市首日无涨跌幅这类交易所例外不建模。
- ST 标记靠调用方传入；漏传会把 5% 标的按 10% 判，属输入错误，不属引擎错误。
- 不与 tushare `limit_list_d` 做数值对账（无积分）；将来有数据时另开对账片。
- 晋级率按「恰好 +1」计；跨停牌日的连板语义按 3.4 归零，若将来需要
  「停牌不算断板」的另一种口径，另开参数，不在此片偷改默认。

## 8. 数据接线

本片无接线。将来接数据时的责任划分：loader 负责提供**未复权** OHLC、
`prev_close`、ST 标记；本引擎只负责事件判定。若接 tushare
`limit_list_d` 做对账，对账片要显式写出「哪些差异属于 ST 排除/次数口径」，
不得把对账差异吞掉。
