# Futu OpenD 真数据链设计：日线面板 → 筹码因子 / 涨停池 / 面板 store

日期：2026-10-29
状态：定稿（用户指令「按 futu opend 接真数据链」，长期授权全程自主）

## 1. 要治的痛

G1（筹码因子）与 G3（涨停池）此前的验收是「纯函数＋手算向量」，因为没有可用的
真数据源：tushare 的 `cyq_*` / `limit_list_d` / `limit_step` 需要高积分，本机 token
不可用。两个引擎都只吃宽表，数据接线一直空着，用户无法用真实行情跑出第一张面板。

本机 FutuOpenD 正在运行且已登录（2026-10-29 12:20 CST 实测：
`qot_logined=True`、`trd_logined=True`、`server_ver=1011`），历史日线接口可用。
本片把「OpenD 日线 → 两个引擎所需的宽表 → G4 面板落盘」这条链补上。

缺口一句话：**一个只读 OpenD 历史日线、产出未复权 OHLC + 昨收 + 百分数换手率 +
当前 ST 标记的对齐宽表面板层，连同可复跑的真数据验收脚本。**

## 2. 目标 / 非目标

目标：

1. 新模块 `agent/src/factors/futu_panels.py`：`normalize_daily_panels`（纯函数）＋
   `fetch_daily_panels`（唯一 I/O 面）＋`is_st_name`；公开 `FutuPanels` 冻结 dataclass。
2. 单位与口径写死：价格**未复权**；`last_close` 作 `prev_close`；Futu 的
   `turnover_rate` 是**小数**，对外字段 `turnover_rate_pct` 是**百分数**。
3. 无未来函数：日期 `>= as_of`（Asia/Shanghai 当日）的 bar 一律剔除，即使收盘后。
4. 新脚本 `agent/scripts/futu_chain_probe.py`：取数 → `chip_metrics` → `limit_pool`
   → `panel_store.write_panel` → `read_panel` 读回，一条命令可复跑。
5. 测试不依赖 futu-api（CI 未安装）：测试内 stub `sys.modules['futu']`，真实调用面
   用假 context；活体验收在 OpenD 上单独跑。

非目标：

- 不改 `agent/backtest/loaders/futu.py`（回测链仍走 qfq；本片另开只读面）；
- 不改 G1/G3 引擎、不注册 alpha、不加 API/CLI 子命令、不改前端；
- 不做历史 ST 状态、复权因子、停牌补齐、缓存；
- 不接 HK/US（筹码与涨跌停口径是 A 股专用）；不接实时行情与下单。

## 3. 数据面冻结（来自 2026-10-29 活体探测）

`OpenQuoteContext.request_history_kline(code, start, end, ktype=KLType.K_DAY,
autype=AuType.NONE, max_count=..., page_req_key=..., fields=[KL_FIELD.ALL])` 返回列：

```
code, name, time_key, open, close, high, low, pe_ratio, turnover_rate,
volume, turnover, change_rate, last_close
```

实测读数（SZ.000001，2026-10-20～10-29）：

| time_key | close | last_close | turnover_rate |
| --- | --- | --- | --- |
| 2026-10-20 | 11.44 | 11.65 | 0.00642 |
| 2026-10-28 | 11.31 | 11.47 | 0.00869 |
| 2026-10-29（探测时午间） | 11.42 | 11.31 | 0.00501 |

- `turnover_rate` 是**小数**：0.00642 = 0.642%。G1 的 `chip_metrics` 要百分数，
  故对外乘 100，字段名写 `turnover_rate_pct`。
- `last_close` 是**昨收**（2026-10-20 的 11.65 = 10-19 收盘；首根也有值）。
- `autype=AuType.NONE` 时价格未复权；这正是 G3 的硬前提（前复权会让涨跌停价失真）。
- 当日 bar 在午间已出现且是**未完成**数据（10-29 成交量 97,209,895，低于前几日
  1.2～1.7 亿），必须剔除。
- `name` 是**当前名称**，不是逐日历史名称：SH.600078 的 681 根 bar 全部叫
  「澄星股份」。历史 ST 变更不可得。
- 分页：`max_count=300` 取 2024-01-01～2026-10-29 返回 300/300/82 三页，共 682 根；
  `page_req_key` 为 None 表示结束。
- SZ.000004 返回 `未知股票 000004`：代码失效是逐标的失败，不是网关故障。

## 4. 公开 API（冻结）

```python
__all__ = ["FutuPanels", "FutuPanelsError", "fetch_daily_panels", "is_st_name", "normalize_daily_panels"]

class FutuPanelsError(RuntimeError): ...

@dataclass(frozen=True)
class FutuPanels:
    high: pd.DataFrame            # 未复权，元
    low: pd.DataFrame             # 未复权，元
    close: pd.DataFrame           # 未复权，元
    prev_close: pd.DataFrame      # 来自 last_close，元
    turnover_rate_pct: pd.DataFrame  # 百分数，0.642 表示 0.642%
    is_st: pd.DataFrame           # bool；由当前 name 前缀判定并广播到全历史
    names: dict[str, str]         # 项目代码 -> 当前名称
    failures: dict[str, str]      # 项目代码 -> 失败原因（fetch 面填充）
    as_of: datetime.date          # 数据截止日（当日及以后 bar 已剔除）

def is_st_name(name: str) -> bool: ...

def normalize_daily_panels(
    frames: Mapping[str, pd.DataFrame], *, today: date | None = None,
) -> FutuPanels: ...

def fetch_daily_panels(
    codes: Sequence[str], start_date: str, end_date: str, *,
    today: date | None = None, max_count: int = 1000, max_pages: int = 100,
) -> FutuPanels: ...
```

## 5. 归一化规则（冻结）

输入：项目代码（`000001.SZ` 形式）→ Futu 原始 DataFrame 的映射。

1. **代码白名单**：只接受 `^\d{6}\.(SH|SZ)$`；HK/US/BJ 一律 `ValueError`（口径是 A 股）。
2. **必需列**：`time_key, name, high, low, close, last_close, turnover_rate`；
   缺任一列 `ValueError`，错误信息点名缺列。
3. **时间**：`time_key` 转 tz-naive DatetimeIndex；NaT 行丢弃；按时间升序；
   重复时间保留**最后一行**。
4. **当日剔除**：`timestamp.normalize() >= pd.Timestamp(as_of)` 的行全部丢弃；
   `as_of = today` 或（默认）Asia/Shanghai 固定 +08:00 的本地日期。
5. **数值**：五个数值列 `pd.to_numeric(errors="coerce")`；不做插值、不补零。
   非法 OHLC（NaN/负值/high<low）**不在这里过滤**——G1/G3 各自有 NaN 语义。
6. **换手**：`turnover_rate_pct = turnover_rate * 100.0`（字段名即单位声明）。
7. **昨收**：`prev_close = last_close`，不再 `close.shift(1)`（不隐式回退）。
8. **ST**：`is_st_name(name)` 取**最后一行**的当前名称，布尔值广播到该标的全部行。
9. **对齐**：所有非空标的取**并集**日期索引（升序、唯一），列顺序＝调用方代码顺序；
   缺失格为 NaN；`is_st` 缺失格为 False；四张价格/换手表索引与列完全一致。
10. **空输入**：返回 `as_of` 正确、索引为空 DatetimeIndex、列为空、`is_st` 为 bool
    的空面板；不抛错（纯函数契约）。空标的（0 行）不产生列，名称也不进 `names`。

不变量（测试逐条钉）：

- 所有输出帧 `index.equals`、`columns.equals` 完全一致；
- `turnover_rate_pct` 非 NaN 处等于输入 `turnover_rate * 100`；
- 任一输出帧的行日期都 `< as_of`；
- 输入帧不被修改（`assert_frame_equal` 前后快照）；
- 输出索引严格递增且唯一。

## 6. fetch 行为（冻结）

- 连接走 `backtest.loaders.futu_gateway.open_context(host, port)`（复用冷却/探测语义）；
  host/port 来自 `gateway_target()`。连接异常 → `note_failure` 后抛 `FutuPanelsError`。
- 每标的独立分页：`page_req_key` 从 None 起，`max_count` 默认 1000；
  - `ret != RET_OK` → 该标的记 `failures[code]`，继续下一标的；
  - 返回空帧 → 记失败「no rows」；
  - `next_key` 为空 → 结束；
  - 同一 `next_key` 重复或页数超过 `max_pages` → 记失败「pagination loop」，不挂死。
- 至少一个成功 → `note_success`；全部失败 → 不 latch 冷却（逐标的拒绝不是网关故障），
  抛 `FutuPanelsError`，消息含首个失败原因。
- context 在 `finally` 中关闭，成功/异常都关。
- 请求参数写死 `ktype=KLType.K_DAY`、`autype=AuType.NONE`、`fields=[KL_FIELD.ALL]`；
  `autype` 用 QFQ 会让涨跌停判定失真，测试钉住必须是 NONE。
- 失败标的不产生列；`failures` 原样带回，调用方可决定 strict 与否。

## 7. 无未来函数证明

- 取数只到 `end_date`；归一化再把 `>= as_of` 的行整体剔除，因此任何输出行都只含
  已结束的交易日；
- 归一化逐标的独立（并集对齐只补 NaN，不读未来行值）；
- 昨收取自同一行的 `last_close`（开盘前已知），不用 `close.shift(1)`；
- 测试用「截断前缀 == 全长前缀」与「as_of 前后一日差分」两针实证。

## 8. 手算向量（冻结）

### A 换手单位
输入一行 `turnover_rate=0.00642` → `turnover_rate_pct=0.642`；`0.00869→0.869`。

### B 当日剔除
日期 `[2026-10-28, 2026-10-29, 2026-10-30]`，`today=2026-10-29` →
输出只有 `2026-10-28`；`as_of=2026-10-29`。

### C 昨收来源
`close=[11.31,11.42]`、`last_close=[11.47,11.31]` → `prev_close=[11.47,11.31]`，
不是 `[NaN,11.31]`。

### D 并集对齐
A 有 `[d1,d2]`，B 有 `[d2,d3]` → 索引 `[d1,d2,d3]`；A 在 d3 的 high 为 NaN，
B 在 d1 的 high 为 NaN；`is_st` 对应格为 False/True 按各自名称。

### E ST 名称
`ST平安`→True，`*ST海航`→True，`S*ST长油`→True，`平安银行`→False，
` st 平安 `（小写带空格）→True。

### F 分页与去重
两页各有 `d2`，第二页 `close=12.0` → 输出一行 d2、close=12.0（保留最后）。

## 9. 验收判据（写死）

1. **单元测试**（`agent/tests/factors/test_futu_panels.py`，stub futu，不联网）：
   向量 A–F、空输入、输入不变、缺列、代码白名单、分页、重复页键、全失败、
   连接失败冷却、成功清冷却、context 必关、autype/fields/ktype 参数、无未来函数两针。
2. **活体验收**（本机 OpenD，脚本 `agent/scripts/futu_chain_probe.py`）：
   至少 6 个 A 股标的 × ≥250 根日线；输出末行日期 `< as_of`；`turnover_rate_pct`
   与探测值同量级（0.6% 附近）；`chip_metrics` 与 `limit_pool` 跑通；两张面板
   `write_panel` 后 `read_panel` 成功且 manifest 的 `data_source` 为 `futu:opend`。
3. **变异自证 M1–M8**（每条注入后目标测试真红，再从内存副本还原并复校 sha256）：
   - M1 `* 100.0` → `* 1.0`（向量 A 红）
   - M2 `>=` → `>`（向量 B 红：当日 bar 被保留）
   - M3 `last_close` → `close`（向量 C 红）
   - M4 并集 → 交集（向量 D 红）
   - M5 `is_st_name` 恒 False（向量 E 红）
   - M6 `AuType.NONE` → `AuType.QFQ`（参数针红）
   - M7 分页只取第一页（向量 F 红 / 分页针红）
   - M8 全失败返回空面板而不是抛错（契约针红）
4. **门册**：A' `cd agent && python -m pytest tests/factors/test_futu_panels.py
   tests/test_futu_loader.py tests/test_futu_gateway.py -q`；B 仓库根全量后端；
   C `bash tools/ci_grep_gates.sh`；D 三合一工具测试；E wiki drift；F 水位。
   恒红门先证「本片 0 贡献」；前端三门免跑（零 `frontend/**`）。
5. **文档**：本 spec、plan、`项目档案.md` §7.40 读数一致；README 徽章不动
   （本片不加 quantlib 模块）。

## 10. 风险与限制（明写，不藏）

- **ST 是当前状态**：Futu 只给当前名称；历史 ST 变更会让过去的涨跌停带宽判错。
  `is_st` 字段与档案必须写明；需要 point-in-time ST 时另接数据源。
- **换手率单位**依赖 Futu 口径（小数）；若上游改成百分数，M1 之外的量级检查会
  在活体验收里暴露（0.642 vs 64.2）。
- **除权日昨收**：`last_close` 是 Futu 给的前收；交易所除权日的涨跌停基准可能被
  交易所调整，本片不做除权换算，按 Futu 原值传。
- **停牌日**：Futu 日线通常不返回停牌 bar；面板因此有日期缺口，G1/G3 按缺失 bar 处理。
- **当日 bar 一律剔除**：即使收盘后运行，也拿不到当天数据；这是保守的无未来函数选择。
- **无缓存**：每次运行都请求 OpenD；历史 K 线有独立配额，批量标的时先看配额。
- **A 股专用**：HK/US 被代码白名单拒绝；不要拿这套面板喂 G3 的 A 股涨跌停规则。
- **futu-api 是可选依赖**：CI 未安装，测试全部走 stub；活体验收只在有 OpenD 的机器上跑。

## 11. 脚本与持久化

`agent/scripts/futu_chain_probe.py`：

```
python agent/scripts/futu_chain_probe.py \
  --codes 000001.SZ 600519.SH 600078.SH 300750.SZ 688981.SH 000002.SZ \
  --start 2024-01-01 --out "$TEMP/futu_chain_panels"
```

- 取数 → 打印形状、`as_of`、末行日期、失败表；
- `chip_metrics` → 取 `profit_ratio` 写 `chip_profit_ratio` 面板；
- `limit_pool` → 取 `streak` 写 `limit_streak` 面板；
- `panel_digest` 记录输入面板摘要；写后 `read_panel` 读回并打印 rows/cols；
- `--strict` 时任一标的失败即 exit 1；默认部分失败仍 exit 0 但打印失败表。

## 12. 执行期偏差与实读（2026-10-29 回填）

1. 计划草案的 `panels.columns.size` 不存在（`FutuPanels` 无 `.columns`），实现改为
   `panels.close.columns.size`；四张价格表索引/列一致，取其一即等价。
2. 分页请求抽成 `_request_pages` 私有函数，`fetch_daily_panels` 主循环只负责失败
   归集；行为与 §6 冻结口径一致（`max_pages`、重复 page key、`no rows`、`RET_OK`
   四条分支逐条落测）。
3. `import futu` 的 `ImportError` 单独转成 `FutuPanelsError`（附安装提示），不落进
   `open_context` 的失败分支，也不 latch 冷却。
4. `today` 的类型校验提前到连接前（草案在归一化才校验）；非法 `today` 不会先建连接。
5. 测试从计划的 20 余条补到 31 例：新增并集不变式两条（所有输出帧共享同一
   index/columns、每行严格 `< as_of`）、`as_of` 边界差分针、前缀==全量针、
   只有当日 bar 的标的产不出列、`note_success` 正反两针。
6. 活体实读（2026-10-29，本机 OpenD）：`turnover_rate=0.00869 → 0.869%`、
   `last_close=11.47` 对应 `close=11.31`；6 标的 × 681 根（2024-01-02..2026-10-28）；
   `AuType.NONE` 的字符串值为 `'None'`、`KL_FIELD.ALL` 为 `''`，SDK 签名
   `request_history_kline(code, start, end, ktype, autype, fields, max_count, page_req_key, ...)`
   与计划草案一致。
7. 变异 M3 首跑因注入串缩进少 8 空格触发 `IndentationError`（rc=2，1 error），
   修正注入串后八针全部判别；这是 harness 的注入缺陷，不是引擎缺陷。
8. 活体脚本在 cp936 控制台下中文名乱码，实跑加 `PYTHONIOENCODING=utf-8`；
   脚本本身不设编码，保持调用方决定。
