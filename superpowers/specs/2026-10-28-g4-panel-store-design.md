# G4（tier 2）设计：因子面板落盘与校验（纯存储层）

日期：2026-10-28
状态：定稿（随 G4 提交落仓）

## 1. 要治的痛

`agent/src/factors/bench_runner.py` 为每枚 alpha 调 `registry.compute()` 得到
`date × instrument` 的因子面板，但面板算完即弃：worker 里只把 IC 行带回主进程，
落盘的是聚合读数。任何想复用同一批因子值的下游（研究、监督学习、跨片对账）
只能重算一遍，而重算意味着重新取数，**无法证明两次拿到的是同一批 bars**。

缺口写成一句话：**一个只依赖 numpy/pandas、能把因子面板连出处一起落在盘上、
读回时能自证未被改动过的存储层。**

## 2. 目标 / 非目标

目标：

1. 新模块 `agent/src/factors/panel_store.py`：一个 alpha 面板 = 一个
   `<alpha_id>.npz` 载荷 ＋ 一个同名 `<alpha_id>.json` manifest。
2. 载荷只用 numpy（`values` float64、`index` datetime64[ns]、`columns`
   Unicode），**不引入 parquet 引擎**——`pyarrow` 只在环境里、不在
   `pyproject.toml` 的声明面，不能当依赖用。
3. 公开面：
   - `panel_digest(panel)` → 输入面板的确定性 SHA-256；
   - `write_panel(root, factor, *, alpha_id, universe, period, horizon=1,
     data_source=None, panel_digest=None, overwrite=False)` → `Path`；
   - `read_panel(path)` → `StoredPanel(factor, manifest)`；
   - `list_panels(root)` → 按 `alpha_id` 排序的 manifest 表；
   - `verify_panel(path)` → 重算校验结果（不抛）。
4. 验收：手算向量 A–F；确定性（同内容同 digest、key 顺序无关）；
   篡改可检出；变异自证 M1–M5。

非目标：

- 不接 `run_bench` 热路径、不加 CLI／API／前端（接线需要真实面板与网络，
  本片只交可手算的存储层；接线下沉到后续片）。
- 不做版本目录、不做 GC、不做并发写者协调（单写者、原子替换）。
- 不记录时钟：manifest 里**没有** `created_at`，同一输入重复写产出逐字节
  相同的两个文件（这是可复现判据的一部分）。
- 不压缩语义：`np.savez`（非 `savez_compressed`），字节布局可预测。

## 3. 定义（冻结）

### 3.1 载荷格式

`np.savez(path, values=..., index=..., columns=..., format_version=np.array(1))`：

- `values`：`np.float64`，形状 `(rows, cols)`，C 顺序；NaN 原样保留；
- `index`：`np.datetime64[ns]`，形状 `(rows,)`，严格递增且唯一；
- `columns`：`np.str_`，形状 `(cols,)`，唯一、非空；
- `format_version`：`np.int64` 标量，当前 `1`。

读回时逐项校验：键集合必须恰为上述四个；`values` 二维且 float64；
`index` 一维 datetime64、严格递增；`columns` 一维、长度等于 `values` 列数；
`format_version == 1`。任何不符 → `ValueError`。

### 3.2 manifest（JSON，UTF-8，`sort_keys=True`、`separators=(",", ":")`）

必填键：

| 键 | 类型 | 定义 |
| --- | --- | --- |
| `format_version` | int | 1 |
| `alpha_id` | str | 非空、不含路径分隔符 |
| `universe` | str | 非空 |
| `period` | str | 非空 |
| `horizon` | int | ≥ 1 |
| `data_source` | str 或 null | 与原样透传 |
| `rows` / `cols` | int | 载荷形状 |
| `index_start` / `index_end` | str | 首末交易日的 ISO 日期 |
| `non_null` | dict[str,int] | 每列非 NaN 计数 |
| `panel_digest` | str 或 null | 3.4 |
| `values_sha256` | str | `sha256(values.tobytes(order="C"))` |
| `payload_sha256` | str | 整个 `.npz` 文件的 sha256 |

`payload_sha256` 与生成它的 `.npz` 一一对应，是「文件未被改动」的判据；
`values_sha256` 是「数值内容」的判据，重打包（如换 numpy 版本）时前者可变、
后者应稳定。

### 3.3 原子写

先写同目录临时文件（`tempfile.mkstemp`，形如 `.<alpha_id>.XXXXXX.tmp`），
`os.replace` 到目标；manifest 在载荷之后写。失败时清理临时文件。
`overwrite=False` 且目标 manifest 或载荷已存在 → `FileExistsError`
（检查在写任何字节之前）。

### 3.4 `panel_digest`

对 `Mapping[str, Any]` 的输入面板（`bench_runner` 的 `panel` 形状）求
SHA-256，排除键 `_meta`。规范化：

1. 键按 UTF-8 字节序排序，跳过 `_meta`；
2. 每段写入：4 字节大端键名长度 ＋ 键名 UTF-8 ＋ 8 字节大端段长 ＋ 段字节；
3. 每个值是 `DataFrame` 时：段 = `to_numpy(dtype=np.float64)` 的 C 顺序
   字节 ＋ `0x00` ＋ `index` 的 `int64` 纳秒数组字节（非 DatetimeIndex 则
   逐项 `str` 以 `0x1f` 拼接）＋ `0x00` ＋ `columns` 的 UTF-8 拼接
   （`0x1f` 分隔）；
4. 每个值不是 DataFrame 时：段 = `repr(value).encode("utf-8")`。

同一内容的不同 dict 插入顺序 → 同一 digest；任一数值、日期、列名或键名
变化 → 不同 digest。空面板 → 固定 digest（由上述规则决定，测试钉住）。

### 3.5 `read_panel` 的校验顺序

1. `.npz` 存在且可读 → 否则 `FileNotFoundError`；
2. manifest 存在且 JSON 可解析 → 否则 `ValueError`；
3. `payload_sha256` 重算相等 → 否则 `ValueError("payload changed")`；
4. 载荷内部形状／dtype／索引规则 → 否则 `ValueError`；
5. manifest 的 `rows/cols/index_start/index_end/non_null` 与载荷一致
   → 否则 `ValueError`；
6. 返回 `StoredPanel(factor, manifest)`，`factor` 的 index 为
   `DatetimeIndex`（name 保留 `None`），columns 为 `Index[str]`。

`verify_panel(path)` 走同一套检查但把异常吞成
`{"ok": bool, "reason": str|None}`，供批量巡检。

### 3.6 `list_panels`

只读 `*.json`（不读载荷），返回列固定为
`alpha_id, universe, period, horizon, data_source, rows, cols, non_null_total,
panel_digest, values_sha256, path`，按 `alpha_id` 升序、`path` 为 manifest
的绝对路径字符串。manifest 缺键 → `ValueError`（不静默跳过）。

## 4. 手算向量（冻结）

### 4.1 向量 A：往返

```
factor = DataFrame(
  [[1.0, NaN], [2.5, -3.0], [NaN, 0.0]],
  index=[2024-01-02, 2024-01-03, 2024-01-04],
  columns=["000001.SZ", "600000.SH"])
```

写后读回：`assert_frame_equal(factor, stored.factor)`（NaN 位置相等）；
manifest `rows=3, cols=2, index_start="2024-01-02", index_end="2024-01-04",
non_null={"000001.SZ": 2, "600000.SH": 2}`。

### 4.2 向量 B：`values_sha256` 手算

同一面板，独立算
`hashlib.sha256(np.array([[1.0, np.nan], [2.5, -3.0], [np.nan, 0.0]], dtype=np.float64).tobytes(order="C")).hexdigest()`，
必须等于 manifest 的值。

### 4.3 向量 C：digest 的确定性与敏感性

- 同一面板构造两次（dict 插入顺序相反）→ `panel_digest` 相等；
- 改一个数值（`1.0 → 1.0000001`）→ 不等；
- 改一个列名 → 不等；
- 面板多一枚无关键 → 不等；
- 含 `_meta` 键时，改 `_meta` 的内容 → **相等**（`_meta` 被排除）。

### 4.4 向量 D：篡改可检出

写入后把 `.npz` 的第 200 个字节异或 `0xFF` → `read_panel` 抛
`ValueError`（`payload changed`），`verify_panel` 返回 `ok=False`。

### 4.5 向量 E：manifest 与载荷不一致

手改 manifest 的 `rows`（3 → 4）但不改载荷 → `read_panel` 抛
`ValueError`（形状不一致）；`non_null` 改一位同理。

### 4.6 向量 F：覆盖语义

- `overwrite=False` 第二次写 → `FileExistsError`，且盘上原文件字节不变；
- `overwrite=True` 第二次写（内容不同）→ 读回新内容；
- 失败的写（例如 `factor` 含 object 列）不留临时文件、不破坏原文件。

## 5. 可复现性论证

- 同一输入两次写：载荷字节相同（`np.savez` 对同一数组确定性输出；
  `zipfile` 的时间戳是固定值——`np.savez` 内部写 zip 时用
  `ZipInfo` 默认 1980-01-01），manifest 因 `sort_keys` 与无时间戳而相同；
- 测试用「写两次 → 两个文件逐字节相等」把这条钉住；
- `panel_digest` 不含 Python `hash()`、不含随机数、不含时钟。

## 6. 验收判据（写死）

1. 手算向量 A–F 逐项相等。
2. 同输入两次写出的 `.npz` 与 `.json` **逐字节相同**。
3. 输入校验：非 `DataFrame`、非 `DatetimeIndex`、索引不严格递增、
   列名重复或空、`values` 非 float64、`alpha_id` 含路径分隔符、
   `horizon < 1`、`overwrite` 非 bool → `TypeError`／`ValueError`。
4. 空面板（0 行 × 0 列、0 行 × N 列）往返成功，`non_null` 全 0。
5. 篡改／不一致全部可检出（向量 D/E）。
6. 变异自证（注入后测试真红，再从动手前内存副本还原）：
   - M1：`read_panel` 跳过 `payload_sha256` 校验（向量 D 真红）；
   - M2：写盘时把 NaN 填成 `0.0`（向量 A/B 真红）；
   - M3：`panel_digest` 按 dict 插入顺序拼接（向量 C 第一支真红）；
   - M4：`list_panels` 不排序（向量 E 的顺序断言真红）。
     **2026-10-28 执行更正**：`list_panels` 有两处排序，`sorted(glob(...))`
     已按文件名（即 `<alpha_id>.json`）排过一遍；对测试用的 `alpha`／`zeta`，
     文件名序与 alpha_id 序相同，故只删末尾 `sort_values` 是等价变异。
     补一枚 `alpha`／`alpha.beta` 前缀对测试（二者文件名序与 alpha_id 序
     相反）作该判据的真正探针，M4 由它判红；
   - M5：`overwrite` 参数被忽略（向量 F 第一支真红）。
7. 门禁：新测试全绿；后端全量新增红为 0；两枚恒红门先证「本片 0 贡献」。

## 7. 风险与限制（明写，不藏）

- **不做并发写者协调**：两个进程同时写同一 `alpha_id` 会互相覆盖，
  最后 `os.replace` 者胜；manifest 与载荷可能来自不同写者（理论窗口）。
  单写者使用；需要并发时另开锁片。
- **`np.savez` 的 zip 字节布局依赖 numpy 实现**：同一环境逐字节稳定，
  跨 numpy 版本不承诺 `payload_sha256` 相同；`values_sha256` 才是跨版本
  判据。测试只用同一环境两趟。
- **manifest 不防伪**：能改载荷的人也能改 manifest 与 sha。它防的是
  「意外漂移／截断／写坏」，不是恶意攻击。
- **`panel_digest` 对非数值列**（如 `sector` 字符串列）走 `repr`，
  跨 Python 版本的 dict repr 顺序不承诺稳定；本片的面板契约是数值列，
  字符串列只做「不同则不同」的粗粒度指纹。
- `pyarrow` 虽在本机可用但不在依赖声明面，故不选 parquet；若将来
  `pyarrow` 进 `pyproject.toml`，另开片换格式，不改本片 manifest 契约。

## 8. 数据接线

本片无接线。后续接线时的责任划分：`bench_runner` 负责在算完每枚 alpha 后
调用 `write_panel` 并透传 `universe/period/horizon/data_source`；面板来源
（vendor／warehouse）由 loader 负责，存储层不猜。
