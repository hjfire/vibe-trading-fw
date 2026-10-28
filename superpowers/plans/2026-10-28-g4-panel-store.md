# G4（tier 2）实现计划：因子面板落盘与校验

日期：2026-10-28
设计：`superpowers/specs/2026-10-28-g4-panel-store-design.md`（定稿）

本片只交一个纯存储层：`agent/src/factors/panel_store.py`。不接 `run_bench`
热路径、不加 CLI／API／前端、不引 parquet。验收靠手算向量 A–F、逐字节可复现、
篡改可检出与五针变异自证。

---

## Task 1: RED — 写测试

文件：`agent/tests/factors/test_panel_store.py`

覆盖：

- 向量 A：往返帧相等（NaN 位置相等）＋ manifest 十项字段；
- 向量 B：`values_sha256` 独立手算、`payload_sha256` 对文件字节手算；
- 向量 C：digest 对 dict 插入顺序不敏感、对数值／列名／键名敏感、
  忽略 `_meta`、非 Mapping 抛 `TypeError`；
- 向量 D：改 `.npz` 第 200 字节 → `read_panel` 抛
  `ValueError("payload changed")`、`verify_panel` 报 `ok=False`；
- 向量 E：manifest 的 `rows`／`non_null` 与载荷不一致 → `ValueError`；
- 向量 F：`overwrite=False` 二次写抛 `FileExistsError` 且原字节不变、
  `overwrite=True` 读回新内容、失败写不留临时件；
- 可复现：同输入两次写，`.npz` 与 `.json` 逐字节相同；NaN／inf 保留；
- 空面板往返（0×0）、`list_panels` 列集合／排序／类型／缺失键抛错；
- 读缺文件抛 `FileNotFoundError`；
- 参数与形状校验（alpha_id 空／含分隔符、universe／period 空、horizon 0 与
  bool、overwrite 非 bool、非 DataFrame、非 DatetimeIndex、索引不递增、
  列重复或空、object dtype）。

运行：

```bash
cd agent && python -m pytest tests/factors/test_panel_store.py -q 2>&1 | tail -5
```

期望：收集期 `ModuleNotFoundError: No module named 'src.factors.panel_store'`。

---

## Task 2: GREEN — 写实现

文件：`agent/src/factors/panel_store.py`

要点：

1. 载荷 `np.savez`：`values` float64 C 顺序、`index` datetime64[ns]、
   `columns` `np.str_`、`format_version` int64；NaN 原样保留。
2. manifest 14 个必填键；`json.dumps(sort_keys=True, separators=(",", ":"))`
   ＋结尾换行；**无时钟**，同输入两次写逐字节相同。
3. 原子写：同目录 `tempfile.mkstemp` 临时件 → 写 → `os.replace`；
   载荷先于 manifest；`finally` 清理残留临时件。
4. `overwrite=False` 且任一目标已存在 → 写任何字节前就
   `FileExistsError`。
5. `panel_digest`：键按 UTF-8 字节序排序、跳过 `_meta`、每段写
   键长＋键名＋段长＋段；DataFrame 段 = 值字节＋index 纳秒字节＋列名；
   非 DataFrame 段 = `repr`。
6. `read_panel` 校验顺序照 spec §3.5；`verify_panel` 吞异常。
7. `list_panels` 只读 manifest，列固定 11 列，按 `alpha_id` 升序，
   `path` 为 manifest 绝对路径。

运行同一命令，期望全绿（枚数现数）。

---

## Task 3: 变异自证 M1–M5

逐条注入 → 测试必须真红 → 从动手前内存副本还原 → 比对 sha256 → 复绿。

- **M1**：`read_panel` 跳过 `payload_sha256` 校验 → 向量 D 两针红。
- **M2**：写盘把 NaN 填 0（`np.nan_to_num`）→ 往返／NaN 保留真红。
- **M3**：`panel_digest` 按 dict 插入顺序拼接 → 向量 C 顺序无关针红。
- **M4**：`list_panels` 去掉最终 `sort_values` → 排序针红。
  `glob` 已按文件名排过一遍，而文件名是 `<alpha_id>.json`；对
  「互为前缀」的 alpha_id（`alpha` 与 `alpha.beta`）文件名序与 alpha_id 序
  相反，故补一枚前缀对测试来钉住真正的契约（`alpha_id` 排序，而非文件名
  排序），M4 由它判红。
- **M5**：`overwrite` 的已存在检查被绕过（永不抛）→ 向量 F 第一支红。

---

## Task 4: 门禁、档案 §7.35、提交

```bash
cd agent && python -m pytest tests/factors -q 2>&1 | tail -3
cd .. && bash tools/ci_grep_gates.sh; echo "grep-gates rc=$?"
python -m pytest tools/test_ci_env_var_gate.py tools/test_ci_private_files_gate.py tools/test_doc_tables.py -q 2>&1 | tail -3
python -m pytest tools/test_wiki_drift.py -q 2>&1 | tail -3
bash tools/wiki_freshness_gate.sh; echo "watermark rc=$?"
```

后端全量（与 §7.34 基线同一命令行：`--continue-on-collection-errors -X utf8`）
取 FAILED 名集合差，新增红必须 0。

档案按仓库实际格式追加 `### 7.35 G4…`（bytes 层、CRLF），读数现填。

提交（显式 pathspec）：

```bash
git add agent/src/factors/panel_store.py agent/tests/factors/test_panel_store.py \
  项目档案.md superpowers/specs/2026-10-28-g4-panel-store-design.md \
  superpowers/plans/2026-10-28-g4-panel-store.md
git commit -s -m "feat(factors): deterministic panel store with tamper detection" \
  -m "<why>"
```

推送前 `git ls-remote origin refs/heads/main` 对真值；cron 推进则
`git merge`（不 rebase）并复跑门禁。

---

## 执行期偏差（2026-10-28 回填）

- **RED**：`python -m pytest tests/factors/test_panel_store.py -q`
  → 收集期 `ModuleNotFoundError: No module named 'src.factors.panel_store'`
  （`1 error in 1.69s`）。
- **GREEN**：同命令 `34 passed`（6.13s，一次过）；补上 M4 的前缀对测试后
  `35 passed`（1.62s）；再补 `test_panel_digest_empty_input_is_sha256_of_nothing`
  与 `test_zero_row_panel_round_trip` 后终态 `37 passed`（1.47s）。
- **M4 可达域更正**：spec §6.6 写「M4：`list_panels` 不排序（向量 E 的顺序
  断言真红）」。实测：`list_panels` 里有两处排序——`sorted(glob(...))` 与
  末尾 `sort_values`；对测试用的 `alpha`／`zeta`，文件名序与 alpha_id 序
  恰好相同，故只删 `sort_values` 是等价变异。改为补一枚
  `test_list_panels_sorts_by_alpha_id_not_filename`（`alpha` 与
  `alpha.beta`），使末尾排序成为唯一决定 alpha_id 序的杠杆；M4 由它判红
  （`1 failed, 34 passed`），其余四针的读数与 spec 预期一致。
- **变异自证（五针全部真红，逐条从动手前内存副本还原并比对 sha256）**：
  - M1（跳过 `payload_sha256` 校验）→ `2 failed`：`test_vector_d_tampered_payload_is_detected`、`test_vector_d_verify_panel_reports_ok_false`。
  - M2（写盘 NaN→0）→ `4 failed`：`test_vector_a_round_trip`、`test_vector_d_verify_panel_reports_ok_false`、`test_vector_f_overwrite_replaces_content`、`test_nan_and_inf_are_preserved`。多出的两枚是 manifest `non_null` 与载荷不一致的连带检出（读回先撞 non_null 校验，再撞帧不等），属同一注入的两条可观测面。
  - M3（digest 按插入顺序）→ `1 failed`：`test_vector_c_digest_is_order_insensitive`。
  - M4（`list_panels` 去排序）→ `1 failed`：`test_list_panels_sorts_by_alpha_id_not_filename`（新增针）。
  - M5（`overwrite` 已存在检查被绕过）→ `1 failed`：`test_vector_f_existing_target_raises_without_overwrite`。
  - 还原后复跑 `35 passed`（补两针后 `37 passed`）；`agent/src/factors/panel_store.py`
    的 sha256 前后均为 `79daa9f1c642e2578f68d1eee80d92163d8b7fc320f160272d4ab88039291eef`。
- **门禁读数（2026-10-28，同一工作树）**：
  - 门 A `pytest tests/factors -q`：`2101 passed, 76 skipped in 158.20s`，rc=0
    （G3 基线 2064 ＋ 本片 37）。
  - 门 B 后端全量（最终树）：`85 failed, 21859 passed, 206 skipped, 9 errors
    in 739.42s`；对 G3 基线 87 名红集新增 **0**、消失 2（
    `test_rate_limiter_memory.py::test_empty_buckets_are_evicted_after_window_expires`
    与 `test_runtime_jobstore.py::test_concurrent_saves_use_distinct_temporary_files`，
    均为已登记的 flake）；分数自洽：21820＋37 枚新测试＋2 枚转绿＝21859。
    errors ＝ 5 个缺包收集错误（nh3×2／pypdf／reportlab／mistune，本机未装）
    ＋ 4 个 `test_interactive_message_limit` 的
    `ValueError: the environment variable is longer than 32767 characters`
    （Windows 平台环境变量上限，均与本片路径无关）。
  - 门 C `ci_grep_gates.sh`：rc=1，只红 `[gate b]`；54 枚命中文件逐枚
    `git ls-files --error-unmatch` 判未跟踪；本片五枚文件对商标 needle 的
    计数全 0 ⇒ 跟踪面零贡献（2026-10-29 更正：原文逐字抄了带 needle 的命令，
    使计划自身在干净检出里被该门命中；改口后 HEAD 的干净 worktree 里 rc=0）。
  - 门 D 三件工具测试：`1 failed, 51 passed`，唯一红为
    `test_force_added_internal_documents_fail[docs/notes with spaces\nand newline.md]`
    （Windows 文件名不允许换行，平台既知红）。
  - 门 E `tools/test_wiki_drift.py`：`240 passed in 82.32s`，rc=0。
  - 门 F `wiki_freshness_gate.sh`：`wiki stale pages: 447 (threshold 439)`，rc=1；
    本片未动 `wiki/`／`repowiki/`，水位读数与 G3 相同 ⇒ 零贡献。
- **CI 生产复读（2026-10-29）**：修复提交 `6666ae33` 触发的 run
  `40767498608` 九腿全绿——`Windows desktop source lifecycle`、
  `Hash lock / macOS ARM64`、`Hash lock / Windows x64`、
  `Hash lock / Linux x64`、`test / Python 3.11`、`test / Python 3.14`、
  `frontend`、`Windows 11 ARM64 / Python 3.14 background lifecycle`、
  `Windows Server 2025 x64 / Python 3.14 background lifecycle` 逐一现读
  job 载荷均 `success`。首跑 `40766440427` 的两条红腿（3.11／3.14）红因即
  上述自喂 needle，修复后未再出现。
