# Pine 引擎正确性护栏实施计划（前缀不变式 ＋ 跨实现数值 oracle）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给自研 Pine 引擎装两道会红的门——「前缀不变式」（无未来函数的定义式判据）与「跨实现数值 oracle」（独立 numpy 参考实现 ＋ 闭式/外部点值双重正证），首批覆盖 12 个 `ta.*` 函数。

**Architecture:** Python 侧四个新单元（schema 契约 / bar 生成器 / 参考实现 / fixture 生成器）产出提交进 git 的 fixture CSV + `manifest.json`；vitest 侧两条门只读这些已提交文件（运行时零 Python）；Python 侧两条门守住「重算必须逐字节相同」和「参考实现自己 vs 手算/外部点值」。信任链见 spec §3——任何一环都不许用「引擎也这么算」当证据。

**Tech Stack:** Python 3.11.9 + numpy 2.4.6（已装，不新增依赖）、pytest（根 `pyproject.toml:276-277` 已有 `testpaths=["agent/tests"]` / `pythonpath=["agent"]`）、TypeScript + vitest（`frontend` `npm run test:run` = `vitest run`，收集面 `src/**/__tests__/**/*.test.{ts,tsx}`）。

**Spec:** `docs/superpowers/specs/2026-10-04-pine-oracle-harness-design.md`（本计划从它论证，执行者两个文件都要读）

## Global Constraints

- 面向用户正文用中文；代码与命令原文保留。
- 每笔提交 `git commit -s`（DCO trailer `hjfire <307501063+hjfire@users.noreply.github.com>`）；**永不** `--no-verify`；**永不** push、**永不**建 PR、**永不**碰 `origin`（`hjfire/vibe-trading-fw`）与 `upstream`（`HKUDS/Vibe-Trading`）；**永不** merge 到 `main`。
- **零上游程序文件改动**。`git diff --name-only main...HEAD` 的路径白名单只有：`agent/pine_oracle/`、`agent/tests/pine_oracle/`、`frontend/src/lib/__tests__/pinePrefixInvariance.test.ts`、`frontend/src/lib/__tests__/pineTaOracle.test.ts`、`frontend/src/lib/__tests__/__fixtures__/pine_oracle/`、`frontend/src/lib/__tests__/pineOracleFixtures.ts`、`docs/superpowers/`、`项目档案.md`。白名单外出现任何路径 = 该任务判失败。
- **零新增依赖**：不 `pip install`、不 `npm install`、不动 Node/Python/pnpm/uv 工具链。numpy 已在环境（实测 2.4.6）。
- **不改** 根 `pyproject.toml`、`.github/workflows/*`、任何 `README*`、`repowiki/**`。新门靠既有收集面自动生效。
- 禁用命令：`git checkout --`、`git restore`、`git stash`、`git reset --hard`、`git clean`（工作区有唯一份的 git-ignored 文件）。
- 变异探针纪律：**每一根针**都要唯一 needle（只改一处很可能是**等价变异**——字节改了、代码路径没走到，spec §11 更正五 就是实测撞上的一次，所以探针必须断言两轮读数不同）、`finally` 里按字节还原、探针前后各取一次 sha256 并写进报告；探针期间不得跑会读同一 needle 的门禁。
- CJK 输出用 `python -X utf8`；中文路径用 `git -c core.quotepath=false`（本轮已实测：默认 `core.quotepath` 会把 `项目档案.md` 转义，看起来像「文件不在」）。
- 文档诚实纪律：每个被引用的数字带提交坐标；**推导出来的数不得写成像实测过的数**；单份回执不算证据（只读选择器至少两次、不同形状）；空集合真空通过是缺陷不是绿。
- 容差档位与豁免分类**只准调严，不准放宽**。发现引擎与参考实现不一致时，先裁定（写 ledger `Ruling:` 行）再动断言；**不许**用放宽容差、改 `na` 个数、挪进 `guarded` 三招糊过去。
- 本机内存常只剩 ~2GB：全量套件一次跑，不做二次分片重跑取好看读数。
- 交易指标禁用未来函数——本轮的判据一就是它的机器化，交付必附判据读数。

---

### Task 1: fixture 契约模块（schema）

**Files:**
- Create: `agent/pine_oracle/__init__.py`
- Create: `agent/pine_oracle/schema.py`
- Create: `frontend/src/lib/__tests__/__fixtures__/pine_oracle/.gitattributes`
- Test: `agent/tests/pine_oracle/__init__.py`（空）
- Test: `agent/tests/pine_oracle/test_schema.py`

**Interfaces:**
- Produces:
  - `REPO_ROOT: Path`、`FIXTURE_DIR: Path`（由 `__file__` 上溯两级得出，**不依赖 cwd**——本项目的 Python 命令既可能在仓库根跑也可能在 `agent/` 跑，任何相对 `Path("frontend/…")` 都会在其中一处静默指错）
  - `TOLERANCE_TIERS: dict[str, float]` = `{"exact": 0.0, "tight": 1e-12, "loose": 1e-9}`
  - `EXEMPTION_CLASSES: tuple[str, ...]` = `("strict", "tick_guarded", "mtf_guarded")`
  - `NA_ENCODING: str` = `"empty"`；`BAR_COLUMNS: tuple[str, ...]` = `("bar_index", "time", "open", "high", "low", "close", "volume")`；`BARS_INTRADAY_EXTRA_COLUMNS` = `("session",)`
  - `VALUE_HEADER: tuple[str, ...]` = `("bar_index", "expected")`
  - `fmt_float(x: float) -> str`、`parse_float(text: str) -> float`
  - `canonical_bytes(text: str) -> bytes`（LF 归一 + UTF-8）
  - `sha256_of(path: Path) -> str`（读字节、`\r\n`→`\n` 后哈希）
  - `write_text_lf(path: Path, text: str) -> None`
  - `load_manifest(path: Path) -> dict`、`dump_manifest(data: dict) -> str`
  - `validate_manifest(data: dict) -> list[str]`（返回错误列表，空即合法）——**「在场」不等于「有值」**：11 个必需键逐个查值（9 容器种类＋8 非空映射＋2 标量精确相等），`external_anchors` 是唯一允许为空的容器。详见文末「执行期对账」。

  **manifest 的键约定（后续所有任务与 JS 门共用，写在这里以免各自发明）**：`tolerance_tier` 与 `exemption` 都以 **line 名**为键（即 Pine `plot(..., title="X")` 的 `X`，也是 `values/<line>@<variant>.csv` 的 `<line>` 部分）；一个 line 一档，与 bar 形态无关。

- [ ] **Step 1: 写失败测试**

```python
# agent/tests/pine_oracle/test_schema.py
"""The fixture contract: one encoding, one normalisation, one hash definition."""

import json

import pytest

from pine_oracle.schema import (
    EXEMPTION_CLASSES,
    NA_ENCODING,
    TOLERANCE_TIERS,
    canonical_bytes,
    dump_manifest,
    fmt_float,
    parse_float,
    sha256_of,
    validate_manifest,
    write_text_lf,
)


def test_tiers_are_the_three_declared_values() -> None:
    assert TOLERANCE_TIERS == {"exact": 0.0, "tight": 1e-12, "loose": 1e-9}
    assert EXEMPTION_CLASSES == ("strict", "tick_guarded", "mtf_guarded")


def test_na_encoding_is_the_empty_field_and_nothing_else() -> None:
    assert NA_ENCODING == "empty"
    assert fmt_float(float("nan")) == ""
    assert fmt_float(float("inf")) == ""


@pytest.mark.parametrize("x", [0.0, 1.0, -3.5, 1 / 3, 2.6666666666666665, 1e-12, 1.7976931348623157e308])
def test_float_text_round_trips_bit_for_bit(x: float) -> None:
    assert parse_float(fmt_float(x)) == x


def test_canonical_bytes_normalises_crlf_to_lf() -> None:
    assert canonical_bytes("a\r\nb\r\n") == b"a\nb\n"
    assert canonical_bytes("a\nb\n") == b"a\nb\n"


def test_sha_is_insensitive_to_checkout_line_endings(tmp_path) -> None:
    a = tmp_path / "a.csv"
    b = tmp_path / "b.csv"
    a.write_bytes(b"x,y\r\n1,2\r\n")   # what core.autocrlf=true can hand us
    b.write_bytes(b"x,y\n1,2\n")       # what the generator wrote
    assert sha256_of(a) == sha256_of(b)


def test_manifest_round_trip_is_byte_stable() -> None:
    data = {"tolerance_tier": {"sma": "tight"}, "exemption": {"sma": "strict"}}
    assert json.loads(dump_manifest(data)) == data
    assert dump_manifest(data) == dump_manifest(dict(sorted(data.items())))
    assert "\r" not in dump_manifest(data)


def _manifest(**overrides):
    """A complete, valid document with the given keys replaced — so a bad value
    produces exactly the error under test and not six 'missing key' errors."""
    base = {
        "na_encoding": "empty",
        "line_ending": "lf",
        "tolerance_tier": {"sma": "tight"},
        "exemption": {"sma": "strict"},
        "external_anchors": [],
        "files": {"bars_daily_trend.csv": "0" * 64},
    }
    return {**base, **overrides}


def test_validate_manifest_accepts_a_well_formed_document() -> None:
    assert validate_manifest(_manifest()) == []


def test_validate_manifest_rejects_a_bad_tier_or_class() -> None:
    bad = _manifest(
        tolerance_tier={"sma": "1e-6"},
        exemption={"sma": "look-the-other-way"},
    )
    errors = validate_manifest(bad)
    assert len(errors) == 2, errors
    assert any("tolerance_tier[sma]" in e for e in errors), errors
    assert any("exemption[sma]" in e for e in errors), errors


@pytest.mark.parametrize("missing", ["na_encoding", "line_ending", "tolerance_tier", "exemption", "external_anchors", "files"])
def test_validate_manifest_names_every_missing_required_key(missing: str) -> None:
    doc = _manifest()
    del doc[missing]
    errors = validate_manifest(doc)
    assert len(errors) == 1, errors
    assert missing in errors[0], errors


def test_validate_manifest_rejects_a_wrong_na_encoding() -> None:
    errors = validate_manifest(_manifest(na_encoding="NaN"))
    assert len(errors) == 1, errors
    assert "na_encoding" in errors[0], errors


def test_write_text_lf_refuses_cr_in_content(tmp_path) -> None:
    with pytest.raises(ValueError):
        write_text_lf(tmp_path / "x.csv", "a\rb\nc\n")


def test_fixture_dir_is_derived_from_the_package_not_the_cwd(tmp_path, monkeypatch) -> None:
    from pine_oracle import schema
    from pine_oracle.schema import FIXTURE_DIR, REPO_ROOT

    assert FIXTURE_DIR == REPO_ROOT / "frontend" / "src" / "lib" / "__tests__" / "__fixtures__" / "pine_oracle"
    assert (REPO_ROOT / "frontend" / "src" / "lib" / "pineTa.ts").is_file()
    monkeypatch.chdir(tmp_path)          # 换到一个空目录，路径必须一个字都不变
    assert schema.FIXTURE_DIR == FIXTURE_DIR
```

- [ ] **Step 2: 跑到失败，确认是「模块不存在」而不是别的**

Run: `python -X utf8 -m pytest agent/tests/pine_oracle/test_schema.py -q`（**在仓库根跑**，与同步轮的常驻命令同一口径）
Expected: collection error — `ModuleNotFoundError: No module named 'pine_oracle.schema'`（若报的是别的错，先修到这条再往下）

- [ ] **Step 3: 写 `agent/pine_oracle/__init__.py`**

```python
"""Pine engine oracle harness: fixture contract, bar generator, reference implementations.

Imported as ``pine_oracle.*`` because the root ``pyproject.toml`` already puts
``agent`` on ``pythonpath`` (line 277) — this package must not need a config edit.
"""
```

- [ ] **Step 4: 写 `agent/pine_oracle/schema.py`**

```python
"""The fixture contract, in one place.

Why this module exists: the JS gate and the Python generator agree only if a
single definition of encoding, line ending and hashing is shared. Both
``core.autocrlf=true`` (this machine) and Git's text handling can rewrite bytes
at checkout, so the hash is defined over LF-normalised content on purpose —
normalising explicitly beats normalising by accident, which is how a previous
round's ``sed`` evidence misled (R-46).

All public helpers are total: they raise on contract violations instead of
silently coercing junk, because a silently coerced fixture is a false green.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

#: ``agent/pine_oracle/schema.py`` → two levels up is the repository root.
REPO_ROOT: Path = Path(__file__).resolve().parents[2]
FIXTURE_DIR: Path = (
    REPO_ROOT / "frontend" / "src" / "lib" / "__tests__" / "__fixtures__" / "pine_oracle"
)

TOLERANCE_TIERS: dict[str, float] = {"exact": 0.0, "tight": 1e-12, "loose": 1e-9}
#: The two guarded classes each name one engine fact that would make the prefix gate
#: red for a reason that is NOT lookahead. ``this.tick = estimateTick(bars)`` is the
#: call site (`pineRuntime.ts:344`); the definition is `pineOrders.ts:86-96`, whose :88
#: caps the scan at ``Math.min(bars.list.length, 500)`` bars. So tick is estimated from
#: the series the run is handed — never from the whole history — and a sliced run can
#: legitimately see a different tick, which alone can move price-grid-dependent output
#: (`strategy.*` fills). What this does NOT promise is that the difference lands only on
#: the last bar: tick is one scalar per run, so when it changes it can move rounding
#: anywhere inside the slice. ``PineRunOptions.lowerBars`` (`pineRuntime.ts:176-189`) is
#: what lets MTF output see a different aligned series at all. Spec §4 puts both in the
#: contract; no line in the first batch is in either class (all 18 exemptions are
#: ``strict``), which is why ``tick_guarded`` is reserved but unused here, and the
#: provenance gate asserts that rather than letting it drift.
EXEMPTION_CLASSES: tuple[str, ...] = ("strict", "tick_guarded", "mtf_guarded")
NA_ENCODING = "empty"

BAR_COLUMNS: tuple[str, ...] = ("bar_index", "time", "open", "high", "low", "close", "volume")
BARS_INTRADAY_EXTRA_COLUMNS: tuple[str, ...] = ("session",)
VALUE_HEADER: tuple[str, ...] = ("bar_index", "expected")

_REQUIRED_MANIFEST_KEYS: tuple[str, ...] = (
    "na_encoding",
    "line_ending",
    "tolerance_tier",
    "exemption",
    "external_anchors",
    "files",
)


def fmt_float(x: float) -> str:
    """Shortest round-trip decimal for a float, empty field for non-finite."""
    if x != x or x in (float("inf"), float("-inf")):
        return ""
    return repr(float(x))


def parse_float(text: str) -> float:
    """Inverse of :func:`fmt_float`; the empty field means Pine ``na``."""
    if text == "":
        return float("nan")
    return float(text)


def canonical_bytes(text: str) -> bytes:
    """UTF-8 bytes with CRLF folded to LF — the only form a fixture is hashed in."""
    if "\r" in text:
        text = text.replace("\r\n", "\n").replace("\r", "\n")
    return text.encode("utf-8")


def sha256_of(path: Path) -> str:
    """Hash the file's LF-normalised bytes, so a CRLF checkout hashes the same."""
    raw = path.read_bytes()
    return hashlib.sha256(raw.replace(b"\r\n", b"\n")).hexdigest()


def write_text_lf(path: Path, text: str) -> None:
    """Write LF-only text; refuse rather than emit a file whose hash depends on checkout."""
    if "\r" in text:
        raise ValueError(f"{path}: refusing to write a CR byte; the contract is LF-only")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(canonical_bytes(text))


def dump_manifest(data: dict[str, Any]) -> str:
    """Deterministic manifest text: sorted keys, 2-space indent, trailing LF, no CR."""
    return json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def load_manifest(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def validate_manifest(data: dict[str, Any]) -> list[str]:
    """Return contract errors for ``data``; an empty list means it is well formed."""
    errors: list[str] = []
    for key in _REQUIRED_MANIFEST_KEYS:
        if key not in data:
            errors.append(f"manifest: missing required key {key!r}")
    for name, tier in (data.get("tolerance_tier") or {}).items():
        if tier not in TOLERANCE_TIERS:
            errors.append(f"manifest tolerance_tier[{name}]={tier!r} is not a tier name")
    for line, cls in (data.get("exemption") or {}).items():
        if cls not in EXEMPTION_CLASSES:
            errors.append(f"manifest exemption[{line}]={cls!r} is not a class")
    if data.get("na_encoding") not in (None, NA_ENCODING):
        errors.append(f"manifest na_encoding={data['na_encoding']!r}, expected {NA_ENCODING!r}")
    if data.get("line_ending") not in (None, "lf"):
        errors.append(f"manifest line_ending={data['line_ending']!r}, expected 'lf'")
    return errors
```

- [ ] **Step 5: 全部跑到绿**

Run: `python -X utf8 -m pytest agent/tests/pine_oracle/test_schema.py -q`
Expected: `23 passed`（10 条普通用例 + 7 条 float 往返参数化 + 6 条缺键参数化 = 23；条数是计划期把本文件的代码块原样抽出来跑出来的实测值，不是推算——若执行时与此不同，报实际数并说明差在哪一条，**不许改期望凑数**）。若 `1e-12` 的往返性在 Windows 上出问题，报 DONE_WITH_CONCERNS 并附实测值，不许删用例。

- [ ] **Step 6: 写 fixture 目录的换行规则**

Create `frontend/src/lib/__tests__/__fixtures__/pine_oracle/.gitattributes`:

```
# Oracle fixtures are hashed over LF-normalised bytes (schema.sha256_of), and
# this machine runs core.autocrlf=true. Pinning eol=lf here keeps the checked-out
# bytes equal to the hashed bytes instead of relying on the normalisation.
*.csv text eol=lf
*.json text eol=lf
```

- [ ] **Step 7: 提交**

```bash
git add agent/pine_oracle/__init__.py agent/pine_oracle/schema.py \
        agent/tests/pine_oracle/__init__.py agent/tests/pine_oracle/test_schema.py \
        frontend/src/lib/__tests__/__fixtures__/pine_oracle/.gitattributes
git -c core.quotepath=false status --porcelain
git commit -s -m "test(pineOracle): fixture 契约模块——na 编码/LF 归一/sha 定义/容差与豁免档位一处收口"
```

白名单自检：`git -c core.quotepath=false diff --name-only main...HEAD` 必须只出现上述 5 条路径。

---

### Task 2: bar 序列生成器与 bars fixture

**Files:**
- Create: `agent/pine_oracle/bars.py`
- Create: `agent/pine_oracle/emit_bars.py`（CLI）
- Create: `frontend/src/lib/__tests__/__fixtures__/pine_oracle/bars_daily_trend.csv`、`bars_daily_oscillating.csv`、`bars_daily_gapped.csv`、`bars_intraday_vwap.csv`（由 Step 5 真跑生成）
- Test: `agent/tests/pine_oracle/test_bars.py`

**Interfaces:**
- Consumes: `schema.BAR_COLUMNS`、`schema.BARS_INTRADAY_EXTRA_COLUMNS`、`schema.fmt_float`、`schema.write_text_lf`、`schema.FIXTURE_DIR`
- Produces:
  - `LCG_MULTIPLIER = 1103515245`、`LCG_INCREMENT = 12345`、`LCG_MODULUS = 2**31`
  - `lcg_stream(seed: int, n: int) -> list[float]`（整数 LCG → `[0,1)` 浮点，`value / LCG_MODULUS`）
  - `make_daily_bars(seed: int, n: int, shape: str) -> list[dict]`，`shape ∈ {"trend","oscillate","gap"}`；每个 dict 的键恰为 `BAR_COLUMNS` 去掉 `bar_index`：`time/open/high/low/close/volume`
  - `make_intraday_bars(seed: int, sessions: int) -> list[dict]`，每 session 8 根 30 分钟 bar，时段 09:30–11:30 / 13:00–15:00，A 股 08:00 时区偏移显式写进 epoch（不依赖本机时区）；每个 dict 多一个 `session` 键
  - `bars_csv_text(rows: list[dict], with_session: bool = False) -> str`
  - `DAILY_BAR_COUNT = 120`、`INTRADAY_SESSIONS = 5`、`FIRST_SESSION_ID = 1`
  - `pine_oracle.emit_bars.emit(out_dir: Path = FIXTURE_DIR) -> list[tuple[Path, str]]`（写四份 bar 夹具，返回 `(路径, sha256)`；Task 4 的 `emit_fixtures` 复用它，一条命令即可重生全部夹具）
  - `BARS_BASENAMES: tuple[str, ...]` = 四个不带扩展名的 bar 名，Task 3/4 的 JS 门与 manifest 都从这里取
  - `BAR_JOBS: tuple[tuple[str, list[dict], bool], ...]`（bar 名 → 已生成的行 → 是否带 `session`）与 `BARS_META: dict[str, tuple[int, str]]`（bar 名 → `(seed, shape)`）**都定义在 `emit_bars.py`，不是 `bars.py`**——Task 4 的 `emit_fixtures.py` 从 `pine_oracle.emit_bars` 一并导入它们写进 manifest 的 `seed`/`shape`

- [ ] **Step 1: 写失败测试**

```python
# agent/tests/pine_oracle/test_bars.py
"""Bars are the fixture's input, so their generation must be reproducible byte for byte.

The JS gate never regenerates bars (a different float operation order in JS would
make the bar arrays themselves differ in the last bit, which voids the
comparison). Instead the CSV is the single truth — these tests pin that it is
deterministic, well-formed, and that wicks are independent of adjacent closes.
"""

from pine_oracle.bars import (
    DAILY_BAR_COUNT,
    INTRADAY_SESSIONS,
    bars_csv_text,
    lcg_stream,
    make_daily_bars,
    make_intraday_bars,
)
from pine_oracle.schema import sha256_of, write_text_lf

HALF_HOUR = 30 * 60_000


def test_lcg_is_deterministic_and_in_unit_interval() -> None:
    a, b = lcg_stream(11, 200), lcg_stream(11, 200)
    assert a == b
    assert all(0.0 <= x < 1.0 for x in a)
    assert len(set(a)) == 200


def test_daily_bar_shape_and_counts() -> None:
    rows = make_daily_bars(seed=11, n=DAILY_BAR_COUNT, shape="trend")
    assert len(rows) == DAILY_BAR_COUNT
    assert set(rows[0]) == {"time", "open", "high", "low", "close", "volume"}
    for r in rows:
        assert r["high"] >= max(r["open"], r["close"])
        assert r["low"] <= min(r["open"], r["close"])
        assert r["volume"] > 0


def test_unknown_shape_is_a_hard_error_not_a_quiet_fallback() -> None:
    import pytest

    with pytest.raises(ValueError):
        make_daily_bars(seed=11, n=5, shape="sideways")


def test_trend_shape_actually_trends() -> None:
    """`trend` adds a constant positive term to every bar, so over 120 bars the
    compounding must be visible: the generator's per-bar term is ~+0.72%, which
    over 119 bars is ~2.3x. Asserting >1.5x leaves room without letting a
    driftless shape through."""
    rows = make_daily_bars(seed=11, n=DAILY_BAR_COUNT, shape="trend")
    closes = [r["close"] for r in rows]
    assert closes[-1] > closes[0] * 1.5, (closes[0], closes[-1])
    ups = sum(1 for i in range(1, len(closes)) if closes[i] > closes[i - 1])
    assert ups > len(closes) // 2, ups


def test_wicks_are_not_pinned_to_adjacent_closes() -> None:
    """The corpus harness's lesson: `high=max(o,c)*1.01` makes a strict local
    extremum in high/low impossible, so pivot/fractal/zigzag never fire and get
    mis-measured. Keep the wicks independent."""
    rows = make_daily_bars(seed=11, n=DAILY_BAR_COUNT, shape="oscillate")
    highs = [r["high"] for r in rows]
    interiors = sum(
        1 for i in range(1, len(highs) - 1) if highs[i] > highs[i - 1] and highs[i] > highs[i + 1]
    )
    assert interiors >= 5, interiors


def test_gap_shape_injects_exactly_five_jump_bars() -> None:
    """The 1% threshold must isolate the *injected* jumps, not the noise. With the
    daily noise term bounded by ±0.6% (see ``make_daily_bars``), any bar moving
    >=1% is one of the 5 injected gaps — so this is an exact count, not a floor."""
    rows = make_daily_bars(seed=11, n=DAILY_BAR_COUNT, shape="gap")
    jumped = [
        i for i in range(1, len(rows)) if abs(rows[i]["open"] / rows[i - 1]["close"] - 1) >= 0.01
    ]
    assert jumped == [22, 45, 68, 91, 114], jumped


def test_intraday_sessions_and_bar_count() -> None:
    rows = make_intraday_bars(seed=13, sessions=INTRADAY_SESSIONS)
    assert len(rows) == 8 * INTRADAY_SESSIONS
    assert len({r["session"] for r in rows}) == INTRADAY_SESSIONS
    assert [r["session"] for r in rows][:9] == [1] * 8 + [2]
    stamps = [r["time"] for r in rows if r["session"] == 1]
    assert len(stamps) == 8
    # Morning leg 09:30→11:00 and afternoon leg 13:00→14:30 are each four bars of
    # exact 30-minute spacing; index 3→4 is the lunch break, which must be a real
    # gap. Asserting "every adjacent pair is 30 min" would be false, and asserting
    # "some pair is longer" would pass on a shuffled grid — so both halves are
    # checked explicitly, plus the gap itself.
    assert all(b - a == HALF_HOUR for a, b in zip(stamps[:3], stamps[1:4]))
    assert all(b - a == HALF_HOUR for a, b in zip(stamps[4:7], stamps[5:8]))
    assert stamps[4] - stamps[3] == 120 * 60_000, (stamps[3], stamps[4])   # 11:00 → 13:00
    assert stamps[7] - stamps[0] == 6 * HALF_HOUR + 120 * 60_000           # 09:30 → 14:30


def test_intraday_sessions_are_on_consecutive_days() -> None:
    rows = make_intraday_bars(seed=13, sessions=INTRADAY_SESSIONS)
    first_of = {}
    for r in rows:
        first_of.setdefault(r["session"], r["time"])
    days = [first_of[s] for s in sorted(first_of)]
    assert all(b - a == 86_400_000 for a, b in zip(days, days[1:])), days


def test_csv_text_is_lf_and_header_matches() -> None:
    rows = make_daily_bars(seed=11, n=4, shape="trend")
    text = bars_csv_text(rows)
    assert text.splitlines()[0] == "bar_index,time,open,high,low,close,volume"
    assert "\r" not in text
    assert len(text.splitlines()) == 5


def test_csv_text_with_session_appends_the_column() -> None:
    rows = make_intraday_bars(seed=13, sessions=1)
    text = bars_csv_text(rows, with_session=True)
    assert text.splitlines()[0] == "bar_index,time,open,high,low,close,volume,session"
    assert len(text.splitlines()) == 9


def test_generated_file_is_bytewise_reproducible(tmp_path) -> None:
    p1 = tmp_path / "a.csv"
    p2 = tmp_path / "b.csv"
    for p in (p1, p2):
        write_text_lf(p, bars_csv_text(make_daily_bars(seed=11, n=30, shape="oscillate")))
    assert sha256_of(p1) == sha256_of(p2)
```

- [ ] **Step 2: 跑到失败**

Run: `python -X utf8 -m pytest agent/tests/pine_oracle/test_bars.py -q`
Expected: `ModuleNotFoundError: No module named 'pine_oracle.bars'`

- [ ] **Step 3: 写 `agent/pine_oracle/bars.py`**

```python
"""Deterministic bar arrays for the oracle fixtures.

Integer LCG only, then one division: the stream must be reproducible without
numpy and without any dependency on the host's float print settings. Bars live
in the committed CSV, never re-derived in JS — see the header of
``test_bars.py`` for why that matters.

The noise and drift terms are not decorative: ``test_gap_shape_injects_exactly_
five_jump_bars`` counts bars moving >=1%, which is only an exact count while the
per-bar noise stays under that threshold. Changing ``_BODY_STEP`` silently turns
that test into noise, so the bound is asserted there rather than here.
"""

from __future__ import annotations

from typing import Any

from pine_oracle.schema import BAR_COLUMNS, BARS_INTRADAY_EXTRA_COLUMNS, fmt_float

LCG_MULTIPLIER = 1103515245
LCG_INCREMENT = 12345
LCG_MODULUS = 2**31

DAILY_BAR_COUNT = 120
INTRADAY_SESSIONS = 5
FIRST_SESSION_ID = 1
BARS_PER_SESSION = 8

#: Per-bar body step. |shock| <= _BODY_STEP/2 < 1%, so a >=1% move is a gap.
_BODY_STEP = 0.012
#: Upward bias added to the LCG draw in ``trend`` shape (compounds to ~2.3x over 120 bars).
_TREND_BIAS = 0.6
#: Overnight jumps injected every _GAP_EVERY bars in ``gap`` shape.
_GAP_EVERY = 23
_GAP_UP = 0.05
_GAP_DOWN = -0.055

#: Daily epoch-ms for 2024-01-02 (Tue), the first A-share bar of that week.
DAY_ZERO_MS = 1_704_153_600_000
DAY_MS = 86_400_000
#: Session starts, in ms from local midnight, Asia/Shanghai wall clock (+08:00).
_AM_START_MS = 9 * 3_600_000 + 30 * 60_000      # 09:30
_PM_START_MS = 13 * 3_600_000                    # 13:00
_MIN30_MS = 1_800_000
#: Exchange zone offset, written into the epoch explicitly so the fixture does
#: not depend on the host's timezone.
_OFFSET_MS = 8 * 3_600_000


def lcg_stream(seed: int, n: int) -> list[float]:
    """``n`` values in [0, 1) from a plain integer linear congruential generator."""
    state = seed % LCG_MODULUS
    out: list[float] = []
    for _ in range(n):
        state = (LCG_MULTIPLIER * state + LCG_INCREMENT) % LCG_MODULUS
        out.append(state / LCG_MODULUS)
    return out


def make_daily_bars(seed: int, n: int, shape: str) -> list[dict[str, Any]]:
    """``n`` daily bars. Wicks swing independently of the adjacent closes.

    ``shape``:
      ``trend``      — a persistent upward drift (tests warm-up and seeding).
      ``oscillate``  — mean-reverting with independent wicks (extrema must exist).
      ``gap``        — oscillating plus injected overnight jumps (tests
                       ``change``/``tr``/``rsi`` handling of discontinuities).
    """
    if shape not in {"trend", "oscillate", "gap"}:
        raise ValueError(f"unknown shape {shape!r}")
    rnd = lcg_stream(seed, n * 6)
    bias = _TREND_BIAS if shape == "trend" else 0.0
    rows: list[dict[str, Any]] = []
    price = 20.0
    for i in range(n):
        # A gap belongs in the OPEN (an overnight jump), not the close: the test
        # that counts them measures ``open[i] / close[i-1]``, which is exactly 1
        # without this line. Its sign draws from a slot no other term uses.
        if shape == "gap" and i and i % _GAP_EVERY == _GAP_EVERY - 1:
            price *= 1 + (_GAP_UP if rnd[5 * n + i] > 0.5 else _GAP_DOWN)
        open_ = price
        shock = (rnd[i] - 0.5 + bias) * _BODY_STEP
        close = open_ * (1 + shock)
        # Independent wicks: each is drawn from its own stream slot, not from the
        # bar's own open/close, otherwise a strict local extremum is impossible.
        up_wick = rnd[2 * n + i] * 0.03
        down_wick = rnd[3 * n + i] * 0.03
        high = max(open_, close) * (1 + up_wick)
        low = min(open_, close) * (1 - down_wick)
        rows.append(
            {
                "time": DAY_ZERO_MS + i * DAY_MS,
                "open": round(open_, 6),
                "high": round(high, 6),
                "low": round(low, 6),
                "close": round(close, 6),
                "volume": int(1_000_000 + rnd[4 * n + i] * 5_000_000),
            }
        )
        price = close
    return rows


def make_intraday_bars(seed: int, sessions: int) -> list[dict[str, Any]]:
    """A-share intraday grid: 8 x 30-minute bars per session, 09:30-11:30 / 13:00-15:00.

    ``session`` is written as its own column so the reference implementation can
    express TradingView's session-anchored VWAP. The engine does not take a
    session argument at all (spec §6 vwap row), which is the gap this column
    makes measurable rather than the mechanism under test.
    """
    total = sessions * BARS_PER_SESSION
    rnd = lcg_stream(seed, total * 6)
    rows: list[dict[str, Any]] = []
    price = 30.0
    slot = 0
    for s in range(sessions):
        day = DAY_ZERO_MS + s * DAY_MS
        # 09:30,10:00,10:30,11:00 | 13:00,13:30,14:00,14:30 — the lunch gap lives in
        # the timestamps, so an even-spacing shortcut cannot reproduce it.
        starts = [_AM_START_MS + k * _MIN30_MS for k in range(4)]
        starts += [_PM_START_MS + k * _MIN30_MS for k in range(4)]
        for k in range(BARS_PER_SESSION):
            shock = (rnd[slot] - 0.5) * 0.008
            close = price * (1 + shock)
            high = max(price, close) * (1 + rnd[2 * total + slot] * 0.004)
            low = min(price, close) * (1 - rnd[3 * total + slot] * 0.004)
            rows.append(
                {
                    "time": day - _OFFSET_MS + starts[k],
                    "open": round(price, 6),
                    "high": round(high, 6),
                    "low": round(low, 6),
                    "close": round(close, 6),
                    "volume": int(50_000 + rnd[4 * total + slot] * 500_000),
                    "session": FIRST_SESSION_ID + s,
                }
            )
            price = close
            slot += 1
    return rows


def bars_csv_text(rows: list[dict[str, Any]], with_session: bool = False) -> str:
    """Serialise bars; the header is ``schema.BAR_COLUMNS`` (+ ``session``)."""
    fields = list(BAR_COLUMNS[1:]) + (list(BARS_INTRADAY_EXTRA_COLUMNS) if with_session else [])
    lines = [",".join(("bar_index", *fields))]
    for i, row in enumerate(rows):
        cells = [str(i)]
        for name in fields:
            value = row[name]
            cells.append(str(value) if isinstance(value, int) else fmt_float(float(value)))
        lines.append(",".join(cells))
    return "\n".join(lines) + "\n"
```

- [ ] **Step 4: 写生成器 CLI `agent/pine_oracle/emit_bars.py`**

```python
"""Write the four committed bar fixtures. From the repository root:

    PYTHONPATH=agent python -X utf8 -m pine_oracle.emit_bars

``PYTHONPATH=agent`` is needed because only ``pytest`` gets ``agent`` on the path
automatically (root ``pyproject.toml:277``). The target directory comes from
``schema.FIXTURE_DIR``, which is derived from ``__file__`` — not from the cwd.
"""

from __future__ import annotations

from pathlib import Path

from pine_oracle.bars import (
    DAILY_BAR_COUNT,
    INTRADAY_SESSIONS,
    bars_csv_text,
    make_daily_bars,
    make_intraday_bars,
)
from pine_oracle.schema import FIXTURE_DIR, sha256_of, write_text_lf

#: ``(basename, rows, writes_the_session_column)`` for each committed bar fixture.
BAR_JOBS: tuple[tuple[str, list[dict], bool], ...] = (
    ("bars_daily_trend", make_daily_bars(11, DAILY_BAR_COUNT, "trend"), False),
    ("bars_daily_oscillating", make_daily_bars(17, DAILY_BAR_COUNT, "oscillate"), False),
    ("bars_daily_gapped", make_daily_bars(23, DAILY_BAR_COUNT, "gap"), False),
    ("bars_intraday_vwap", make_intraday_bars(13, INTRADAY_SESSIONS), True),
)

#: basename -> (seed, shape). The manifest declares these, and it derives them from
#: here rather than restating them, so a seed change cannot leave the manifest
#: describing bars that no longer exist.
BARS_META: dict[str, tuple[int, str]] = {
    "bars_daily_trend": (11, "trend"),
    "bars_daily_oscillating": (17, "oscillate"),
    "bars_daily_gapped": (23, "gap"),
    "bars_intraday_vwap": (13, "intraday"),
}

BARS_BASENAMES: tuple[str, ...] = tuple(name for name, _, _ in BAR_JOBS)


def emit(out_dir: Path = FIXTURE_DIR) -> list[tuple[Path, str]]:
    """Write the four bar fixtures and return ``(path, sha256)`` for the manifest."""
    written: list[tuple[Path, str]] = []
    for name, rows, with_session in BAR_JOBS:
        path = out_dir / f"{name}.csv"
        write_text_lf(path, bars_csv_text(rows, with_session=with_session))
        written.append((path, sha256_of(path)))
    return written


if __name__ == "__main__":
    for p, digest in emit():
        print(f"{digest[:12]}  {p}")
```

- [ ] **Step 5: 真跑生成，并核对生成物不是空文件**

```bash
PYTHONPATH=agent python -X utf8 -m pine_oracle.emit_bars
wc -l frontend/src/lib/__tests__/__fixtures__/pine_oracle/bars_*.csv
```
Expected: 4 行 `sha 前 12 位  路径`；`wc -l` 给出 `121 / 121 / 121 / 41`（表头各占一行）。把这八行原文写进报告——**不许用推导值代替**。若 `gap` 形态的注入条数与 `test_gap_shape_injects_exactly_five_jump_bars` 的期望下标不符，报实测下标列表，按 spec §8 的裁定纪律处理，**不许改阈值**。

- [ ] **Step 6: 二次生成验证幂等**

```bash
PYTHONPATH=agent python -X utf8 - <<'PY'
import tempfile
from pathlib import Path
from pine_oracle.emit_bars import emit

a = sorted(d for _, d in emit())
tmp = Path(tempfile.mkdtemp())
b = sorted(d for _, d in emit(tmp))
print("run1", a[:1])
print("idempotent:", a == b, len(a), "files")
PY
```
Expected: `idempotent: True 4 files`。两次都要真跑，`run1` 的 sha 与 Step 5 打印的第一行一致。

- [ ] **Step 7: 全套测试到绿**

Run: `python -X utf8 -m pytest agent/tests/pine_oracle -q`
Expected: `34 passed`（Task 1 的 23 + 本任务 11；两个数都是计划期实测，条数若与此不同，报实际数并说明差在哪条，不许改期望凑数）

- [ ] **Step 8: 提交**

```bash
git add agent/pine_oracle/bars.py agent/pine_oracle/emit_bars.py \
        agent/tests/pine_oracle/test_bars.py \
        frontend/src/lib/__tests__/__fixtures__/pine_oracle/
git -c core.quotepath=false status --porcelain
git commit -s -m "test(pineOracle): 确定性 bar 夹具三形态＋日内 session 网格（4 文件入 git，幂等实测）"
```

---

### Task 3: 判据一——前缀不变式门（JS）

**Files:**
- Create: `frontend/src/lib/__tests__/pineOracleFixtures.ts`（读盘与解码 helper，两条 JS 门共用）
- Test: `frontend/src/lib/__tests__/pinePrefixInvariance.test.ts`

**Interfaces:**
- Consumes: `runPine(src, bars, opts?)`（`pineRuntime.ts:2376`）、`compilePine(code, dataList, opts)`（`pineScript.ts:177`）、`toBars(list)`（`pineTypes.ts:318`）、`KLineData`（`klinecharts`）、Task 2 落盘的 bars CSV
- Produces（供 Task 4/5/6 的 `pineTaOracle.test.ts` 复用）：
  - `BARS_VARIANTS: readonly string[]` = `["bars_daily_trend", "bars_daily_oscillating", "bars_daily_gapped", "bars_intraday_vwap"]`（与 `emit_bars.BARS_BASENAMES` 逐项一致，Task 4 的 provenance 门负责钉住这条一致性）
  - `loadBars(name: string): PineBars`
  - `loadSession(name: string): number[] | null`（该 bar CSV 有 `session` 列时返回它，否则 `null`）
  - `loadManifest(): OracleManifest`，`type OracleManifest = { tolerance_tier: Record<string,string>; exemption: Record<string,string>; scripts: Record<string,string>; lines: Record<string,string[]>; external_anchors: {name:string;value:string;source:string;retrieved_at:string}[]; files: Record<string,string>; na_encoding: string; line_ending: string; seed: Record<string,number>; shape: Record<string,string>; period: Record<string,number> }`（`lines` = 每个脚本应产出的 line 名，Task 4 写、Task 4 的 JS 门读）
  - `expectedColumn(line: string, variant: string): number[]`（读 `values/<line>@<variant>.csv`，空字段 → `NaN`）
  - `runScript(src: string, bars: PineBars): Record<string, number[]>`（**以 line 名为键**；编译失败或 `abort` 直接 throw）
  - `TIER_VALUE: Record<string, number>` = `{ exact: 0, tight: 1e-12, loose: 1e-9 }`

- [ ] **Step 1: 写 helper `frontend/src/lib/__tests__/pineOracleFixtures.ts`**

```ts
/**
 * Fixture readers for the Pine oracle gates.
 *
 * Nothing here regenerates bars: the committed CSV is the single truth, because
 * re-deriving the same float array in JS with a different operation order would
 * make the bars themselves differ in the last bit and void the comparison.
 * The gate must fail — never skip — when a fixture is missing: these files are
 * committed, so their absence is an incident, not a local-only corpus.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import type { KLineData } from "klinecharts";

import { compilePine } from "../pineScript";
import { toBars, type PineBars } from "../pineTypes";

export const BARS_VARIANTS = [
  "bars_daily_trend",
  "bars_daily_oscillating",
  "bars_daily_gapped",
  "bars_intraday_vwap",
] as const;

export const TIER_VALUE: Record<string, number> = { exact: 0, tight: 1e-12, loose: 1e-9 };

// Resolved from this module's URL, not process.cwd(): vitest's cwd depends on how
// it was invoked, and a relative path would read a missing directory as "no data".
const DIR = fileURLToPath(new URL("./__fixtures__/pine_oracle", import.meta.url));

function readCsv(path: string): string[][] {
  // LF is pinned by the fixture dir's .gitattributes; accept CRLF anyway so a
  // hand-checkout on a core.autocrlf=true box cannot be mistaken for a value bug.
  const text = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
  return text.split("\n").filter((l) => l.length > 0).map((l) => l.split(","));
}

export interface OracleAnchor {
  name: string;
  value: string;
  source: string;
  retrieved_at: string;
}

export interface OracleManifest {
  tolerance_tier: Record<string, string>;
  exemption: Record<string, string>;
  scripts: Record<string, string>;
  lines: Record<string, string[]>;
  external_anchors: OracleAnchor[];
  files: Record<string, string>;
  na_encoding: string;
  line_ending: string;
  seed: Record<string, number>;
  shape: Record<string, string>;
  period: Record<string, number>;
}

export function loadManifest(): OracleManifest {
  return JSON.parse(readFileSync(`${DIR}/manifest.json`, "utf8")) as OracleManifest;
}

function columnsOf(name: string): { header: string[][][0]; rows: string[][] } {
  const rows = readCsv(`${DIR}/${name}.csv`);
  return { header: rows[0], rows: rows.slice(1) };
}

export function loadBars(name: string): PineBars {
  const { header, rows } = columnsOf(name);
  const col = (key: string) => header.indexOf(key);
  const list: KLineData[] = rows.map((r) => ({
    timestamp: Number(r[col("time")]),
    open: Number(r[col("open")]),
    high: Number(r[col("high")]),
    low: Number(r[col("low")]),
    close: Number(r[col("close")]),
    volume: Number(r[col("volume")]),
  }));
  return toBars(list);
}

/** The ``session`` column when the variant carries one; ``null`` when it does not. */
export function loadSession(name: string): number[] | null {
  const { header, rows } = columnsOf(name);
  const at = header.indexOf("session");
  if (at < 0) return null;
  return rows.map((r) => Number(r[at]));
}

/** ``values/<line>@<variant>.csv`` → expected series; an empty field is Pine ``na``. */
export function expectedColumn(line: string, variant: string): number[] {
  const rows = readCsv(`${DIR}/values/${line}@${variant}.csv`);
  return rows.slice(1).map((r) => (r[1] === "" ? NaN : Number(r[1])));
}

/** Every plotted line's value series, keyed by line name — never by plot order. */
export function runScript(src: string, bars: PineBars): Record<string, number[]> {
  const out = compilePine(src, bars.list, {});
  if ("error" in out) throw new Error(`编译失败：${out.error}`);
  if (out.abort) throw new Error(`运行中断：${out.abort}`);
  const byName: Record<string, number[]> = {};
  for (const line of out.result.lines) {
    if (byName[line.name]) {
      throw new Error(`重复的 line 名 ${line.name}：夹具按名对齐，重名会把两条线读成一条`);
    }
    byName[line.name] = line.values;
  }
  return byName;
}

/** Slice a PineBars array down to its first ``n`` bars (gate 1's prefix probe). */
export function sliceBars(bars: PineBars, n: number): PineBars {
  const cut = (a: number[]) => a.slice(0, n);
  return {
    list: bars.list.slice(0, n),
    open: cut(bars.open),
    high: cut(bars.high),
    low: cut(bars.low),
    close: cut(bars.close),
    volume: cut(bars.volume),
    time: cut(bars.time),
  };
}
```

- [ ] **Step 2: 写失败测试 `pinePrefixInvariance.test.ts`**

```ts
import { describe, expect, it } from "vitest";

import { BARS_VARIANTS, loadBars, runScript, sliceBars } from "./pineOracleFixtures";

/**
 * Gate 1 — prefix invariance, the machine-checked definition of "no repainting":
 * the engine's value series on bars[:N] must equal the first N entries of the
 * series it produces on the full array, for every N we probe. NaN matches NaN
 * (a warm-up blank that turns into a number on a longer array is a repaint).
 *
 * These scripts are hand-written and independent of the oracle batches on purpose:
 * gate 1 must keep working if a reference batch is restructured, and comparing the
 * engine against itself needs no fixtures beyond the bars.
 */

const SCRIPTS: Record<string, string> = {
  sma: "//@version=5\nindicator(\"p\")\nplot(ta.sma(close, 5), title=\"sma\")",
  ema: "//@version=5\nindicator(\"p\")\nplot(ta.ema(close, 5), title=\"ema\")",
  rma: "//@version=5\nindicator(\"p\")\nplot(ta.rma(close, 5), title=\"rma\")",
  stdev: "//@version=5\nindicator(\"p\")\nplot(ta.stdev(close, 5), title=\"stdev\")",
  // The biased flag is Pine's third argument and defaults to true (population);
  // the sample branch is a separate code path and must be prefix-checked too.
  stdev_sample:
    "//@version=5\nindicator(\"p\")\nplot(ta.stdev(close, 5, false), title=\"stdev_sample\")",
  // Stateful and reversal-prone: the best repainting candidate in the batch, and
  // the one gate 2 does not cover (spec §11 R-C), so gate 1 carries it alone.
  sar: "//@version=5\nindicator(\"p\")\nplot(ta.sar, title=\"sar\")",
};

/** Compare two series with NaN-equals-NaN; report the worst relative divergence. */
function comparePrefix(
  prefix: number[],
  reference: number[],
): { checked: number; maxRelDiff: number; mismatch: string | null } {
  let checked = 0;
  let maxRelDiff = 0;
  for (let i = 0; i < prefix.length; i += 1) {
    const x = prefix[i];
    const y = reference[i];
    checked += 1;
    if (Number.isNaN(x) && Number.isNaN(y)) continue;
    if (Number.isNaN(x) !== Number.isNaN(y)) {
      return { checked, maxRelDiff, mismatch: `index ${i}: na-vs-value ${x} / ${y}` };
    }
    const scale = Math.max(Math.abs(y), 1e-9);
    const diff = Math.abs(x - y) / scale;
    if (diff > maxRelDiff) maxRelDiff = diff;
  }
  return { checked, maxRelDiff, mismatch: null };
}

describe("prefix invariance (no-lookahead gate)", () => {
  /** How many lines each script must plot. A dropped or renamed `title=` would
   * otherwise shrink the comparison set silently and the gate would still be green. */
  const LINE_COUNT: Record<string, number> = { sma: 1, ema: 1, rma: 1, stdev: 1, stdev_sample: 1, sar: 1 };

  for (const variant of BARS_VARIANTS) {
    const full = loadBars(variant);
    const L = full.close.length;
    for (const [name, src] of Object.entries(SCRIPTS)) {
      it(`${name} on ${variant}: no plotted value moves when bars are appended`, () => {
        const reference = runScript(src, full);
        const lineNames = Object.keys(reference);
        expect(lineNames.length, `${name} plotted lines`).toBe(LINE_COUNT[name]);
        // Every line of the script, not just the first: a multi-output script
        // (supertrend's band + direction, macd's triple) repaints per output.
        for (const lineName of lineNames) {
          let probes = 0;
          let worst = 0;
          for (let n = 16; n < L; n += 8) {
            const prefix = runScript(src, sliceBars(full, n));
            const { mismatch, maxRelDiff } = comparePrefix(
              prefix[lineName],
              reference[lineName].slice(0, n),
            );
            expect(mismatch, `${lineName} N=${n}`).toBeNull();
            worst = Math.max(worst, maxRelDiff);
            probes += 1;
          }
          // A gate that probed nothing would pass: pin the probe count to the bar
          // count so shortening the fixture cannot silently hollow the test out.
          expect(probes, `${lineName} probes`).toBe(Math.ceil((L - 16) / 8));
          // Exact, not "within a tolerance": a causal recursion replays the same
          // operations in the same order, so any movement is a repaint, not noise.
          expect(worst, `${lineName} worst`).toBe(0);
        }
      });
    }
  }

  it("the fixtures are the length the gate's probe math assumes", () => {
    for (const variant of BARS_VARIANTS) {
      const L = loadBars(variant).close.length;
      expect(L, variant).toBe(variant === "bars_intraday_vwap" ? 40 : 120);
    }
  });
});

describe("a Pine source in this engine cannot address a future bar", () => {
  /**
   * TradingView's idiom for "the next bar" is a NEGATIVE history offset, `close[-1]`.
   * The engine makes that impossible in two places, and both are load-bearing for
   * every claim gate 1 makes: `readIdx` floors the offset with
   * `Math.max(0, Math.trunc(k))` (`pineRuntime.ts:957`), and `readBack` answers any
   * `k <= 0` with the CURRENT bar (`pineRuntime.ts:430`). So `close[-1]` reads the
   * same value as `close`, never bar+1.
   *
   * This is pinned because no other `pine*.test.ts` exercises a negative offset at
   * all (checked by grep on 2026-10-04 across the pine suites), and the `indicatorLang`
   * suite that does test `close[-1]` is a DIFFERENT evaluator — it asserts NaN there,
   * which is not this runtime's behaviour. An unpinned floor is a floor someone can
   * "tidy away" in an unrelated refactor, and gate 1 would then be guarding nothing.
   */
  it("close[-1] is the current bar, not the bar after it", () => {
    const bars = loadBars("bars_daily_trend");
    const head = "//@version=5\nindicator(\"p\")\n";
    const fwd = runScript(head + 'plot(ta.sma(close[-1], 5), title="f")', bars).f;
    const cur = runScript(head + 'plot(ta.sma(close, 5), title="c")', bars).c;
    const { checked, mismatch } = comparePrefix(fwd, cur);
    expect(checked).toBe(bars.close.length);
    expect(mismatch, `close[-1] diverged from close: ${mismatch}`).toBeNull();
  });
});
```

- [ ] **Step 3: 跑到失败**

Run: `cd frontend && npx vitest run src/lib/__tests__/pinePrefixInvariance.test.ts`
Expected: 能 import、能读盘（Task 2 已生成 bars），失败点必须出现在断言里而不是 import；若报 `ENOENT ... pineOracleFixtures`，先补 Step 1。读数写进报告：每个 `probes` 值、每个 `worst`。

- [ ] **Step 4: 迭代到全绿；若某条真红，那是发现不是噪声**

Run: `cd frontend && npx vitest run src/lib/__tests__/pinePrefixInvariance.test.ts`
Expected: `26 passed`（6 脚本 × 4 变体 + 1 条 bar 数守卫 + 1 条 `close[-1]` 偏置下限守卫）。**注意**：这条判据有可能真的抓到引擎的重绘 bug。抓到就停在这里：把最小复现（脚本、变体、N、两个值）写进报告，标 DONE_WITH_CONCERNS，**不许**通过删脚本或放宽 `worst` 来收场。**但 `close[-1]` 那条红了是另一回事**：它不是「引擎重绘」，而是 `:957` 的下限被人动过——那要停下来查改动来源，不是把它当发现写进台账。

- [ ] **Step 5: 变异探针——两条，分别证明「比较器有牙」与「引擎级未来函数会被这条门抓到」**

spec §8 第 5 条要的是**引擎级**的未来函数探针。本仓的 `ta.*` 步骤函数只看得见已经推进来的值，
「读下一根棒」这件事在这个引擎里唯一的入口是序列下标求值那条路，所以真正的未来函数注入点
是 `readIdx`/`readBack`（`:957` 的下限与 `:430` 的钳位）——这也正是 Step 2 里那条 `close[-1]`
守卫钉住的东西。**单针改动是等价变异**：计划期实测只把 `:430` 改掉时，两轮读数逐字节相同
（`neg_offset_equals_current_bars` 与 `prefix_mismatch` 都是 `[]`），因为 `:957` 先把负数夹回了 0，
那处改动根本没被执行到。探针因此带**两根针**，并断言两轮读数必须不同。

**MUT-PI-1（比较器正证，临时加进 `pinePrefixInvariance.test.ts` 末尾，跑完就删）**

```ts
// 唯一 needle：MUT-PI-1
it("MUT-PI-1: a hand-fed look-ahead series is caught", () => {
  const bars = loadBars("bars_daily_trend");
  const cheat = (b: typeof bars) => b.close.map((_, i) => (i + 1 < b.close.length ? b.close[i + 1] : NaN));
  const full = cheat(bars);
  const probes: number[] = [];
  for (let n = 16; n < 120; n += 8) {
    const sliced = cheat({ ...bars, close: bars.close.slice(0, n) });
    const { mismatch } = comparePrefix(sliced, full.slice(0, n));
    if (mismatch) probes.push(n);
  }
  expect(probes.length).toBeGreaterThan(0);
});
```

Run: `cd frontend && npx vitest run src/lib/__tests__/pinePrefixInvariance.test.ts`
Expected: **27 passed**（26 ＋ 这段）且这段 itself passed——它证明「未来函数形态会被 `comparePrefix` 抓到」；随后删除这段，复跑回到 26 passed，并把「needle 已移除」写进报告。

**MUT-PI-2（引擎级未来函数，改 `pineRuntime.ts` 的字节，`finally` 还原）**

```bash
PYTHONPATH=. python -X utf8 - <<'PY'
"""MUT-PI-2: lift both clamps so close[-1] really reads bar+1, and watch the pin go red.

Two needles, both must be unique, or the probe is an equivalent mutation and proves
nothing (see the note above). Restore is byte-exact and verified by sha in `finally`.
"""
import hashlib
import pathlib
import subprocess

TARGET = pathlib.Path("frontend/src/lib/pineRuntime.ts")
GATE = "src/lib/__tests__/pinePrefixInvariance.test.ts"
PAIRS = [
    (b"Math.max(0, Math.trunc(k))", b"Math.trunc(k)"),
    (b"if (k <= 0) return this.readSeries(name);",
     b"if (k < 0) return this.builtinAt(name, this.bi - k); if (k === 0) return this.readSeries(name);"),
]

original = TARGET.read_bytes()
before = hashlib.sha256(original).hexdigest()
for needle, _ in PAIRS:
    if original.count(needle) != 1:
        raise SystemExit(f"needle not unique ({original.count(needle)}x): {needle!r}")


def gate() -> tuple[int, list[str]]:
    proc = subprocess.run(
        f"npx vitest run {GATE}", shell=True, cwd="frontend",
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    tail = [l.strip() for l in proc.stdout.splitlines() if "Tests " in l or "× " in l]
    return proc.returncode, tail[-6:]


try:
    print("baseline:", gate())
    mutated = original
    for needle, repl in PAIRS:
        mutated = mutated.replace(needle, repl)
    TARGET.write_bytes(mutated)
    print("mutated :", gate())
finally:
    TARGET.write_bytes(original)
    after = hashlib.sha256(TARGET.read_bytes()).hexdigest()
    print("restored byte-identical:", after == before, before[:12], "->", after[:12])
PY
```

Run: 上面这段（仓库根，Git Bash 的 python）
Expected: `baseline` 的 `rc=0` 全绿；`mutated` 的 `rc` 非 0，**且红的必须正是 `close[-1] is the current bar, not the bar after it` 那一条**——24/32 条前缀探针应当仍然绿（判据一的脚本没有一个用负下标）。这个不对称就是那条 pin 存在的理由：未来函数注进引擎，只有下限守卫看得见。`restored byte-identical: True`，三个读数与前后 sha 全部抄进报告。

计划期已用等价探针真跑过这一注入（`pineRuntime.ts` sha `66a6bbdbd2c2`，还原后逐字节相同）：把 `ta.sma(close[-1], 5)` 与 `ta.sma(close, 5)` 在同一 60 根棒序列上逐位比对，未注入时差异下标集合为 `[]`，注入后为 `[4..59]`（前 4 根是 sma 的 warm-up，两侧同 na）；再把完整 60 根与截断到 40 根的前缀比对，未注入 `[]`、注入后 `[39]`——未来函数只暴露在前缀的**末棒**，与 `tick_guarded` 的「仅末棒可不同」（spec §4）是同一个形状。**这条探针跑的是当时的等价物而非本任务的文件**（`pinePrefixInvariance.test.ts` 那时还不存在），执行阶段要以真文件的 `rc` 为准。

- [ ] **Step 6: 提交**

```bash
git add frontend/src/lib/__tests__/pineOracleFixtures.ts frontend/src/lib/__tests__/pinePrefixInvariance.test.ts
git commit -s -m "test(pineOracle): 判据一——前缀不变式门（6 脚本 × 4 bar 形态，逐 line 比对＋NaN 对位＋probes 计数守卫＋负下标未来函数下限守卫）"
```

---

### Task 4: 参考实现批次一（sma / ema / rma / stdev）＋ fixture 落地 ＋ oracle 门接通

**Files:**
- Create: `agent/pine_oracle/reference.py`
- Create: `agent/pine_oracle/emit_fixtures.py`
- Create: `frontend/src/lib/__tests__/__fixtures__/pine_oracle/values/*.csv`（20 个：批次一 5 条 line × 4 形态，由 Step 5 生成）
- Create: `frontend/src/lib/__tests__/__fixtures__/pine_oracle/manifest.json`
- Create: `frontend/src/lib/__tests__/pineTaOracle.test.ts`
- Test: `agent/tests/pine_oracle/test_reference_batch1.py`、`test_pine_oracle_provenance.py`

**Interfaces:**
- Consumes: `pine_oracle.bars.make_daily_bars` / `make_intraday_bars`、`pine_oracle.emit_bars.BAR_JOBS` / `BARS_BASENAMES` / `BARS_META` / `emit`（三者定义处见 Task 2 Step 4 的代码块）、`pine_oracle.schema.*`（含 `REPO_ROOT`、`FIXTURE_DIR`、`VALUE_HEADER`、`dump_manifest`）
- Produces（批次二/三继续往里加函数，签名形状固定，三个批次必须是同一个形状）：
  - 每个参考函数返回 `np.ndarray`（`float64`，长度 = 输入长度，warm-up 处 `np.nan`）
  - `ta_sma(src, n)` / `ta_ema(src, n)` / `ta_rma(src, n)` / `ta_stdev(src, n, biased=True)`
  - `REFERENCE: dict[str, Callable[..., dict[str, np.ndarray]]]`，键 = 批次名（`"batch_1"`…），值签名统一为 **`(cols: dict[str, np.ndarray], period: int, session: np.ndarray | None = None) -> {line_name: array}`**；line_name 即 JS 侧 `plot(...)` 的 `title`，也是 `values/<line>@<variant>.csv` 的文件名前缀
  - `SCRIPTS: dict[str, str]`（批次名 → Pine 源文本，与 `REFERENCE` 同步扩充，写进 `manifest.json` 供 JS 门读）
  - `emit_fixtures.emit(out_dir=FIXTURE_DIR) -> dict`（先写 bars 再写 values，`manifest["files"]` 覆盖除 `manifest.json` 自身外的每个文件；`manifest["lines"]` = 批次名 → 该批次的 line 名单）

- [ ] **Step 1: 写失败测试（参考实现的单元断言，含闭式点值）**

「手算一个小整点序列的闭式值 + `toBeCloseTo(值, 10)`」不是本计划新发明的写法，仓库里已经有四例：
`frontend/src/lib/__tests__/pineBuiltins.test.ts` 的 `describe("legacy statistical ta steps (exact values)")` 里
`:23`（percentrank = 100）、`:32`（percentrank = 25）、`:40` 与 `:45`（linreg = 5 / 7）、`:53`（percentile_nearest_rank = 20）。
下面的期望值沿用同一形状，只是把手算过程写进每个用例的注释里，让复核者能重算而不是只能信引擎。

```python
# agent/tests/pine_oracle/test_reference_batch1.py
"""Batch 1 reference implementations, pinned by hand-computable closed forms.

Every expected number below is derived on paper from the recursion written in the
test's own comment — NOT produced by the engine and NOT copied from a library. If
a number here needs changing, the hand derivation is what gets re-done.
"""

import math

import numpy as np
import pytest

from pine_oracle.reference import ta_ema, ta_rma, ta_sma, ta_stdev

ONE_TO_FIVE = np.array([1.0, 2.0, 3.0, 4.0, 5.0])


def test_sma_warmup_is_na_not_zero() -> None:
    out = ta_sma(ONE_TO_FIVE, 3)
    assert math.isnan(out[0]) and math.isnan(out[1])
    assert out[2:] == pytest.approx([2.0, 3.0, 4.0])


def test_ema_seeds_on_the_first_value_and_has_no_warmup() -> None:
    """Pine/TV convention: alpha = 2/(n+1), prev starts at src[0] (pineTa.ts:134-145).

    TA-Lib would instead SMA-seed at index n-1 and return na before it, i.e.
    [na, na, 2, 3, 4]. Spec §11 更正一 adjudicated that the engine's convention is
    the one under test, so the reference writes the seed-at-bar-0 form. The
    divergence is pinned by ``test_ema_is_not_thelibralib_seed_form`` below rather
    than left to be discovered by a red gate.
    """
    # alpha = 0.5: 1, 0.5*2+0.5*1, 0.5*3+0.5*1.5, 0.5*4+0.5*2.25, 0.5*5+0.5*3.125
    out = ta_ema(ONE_TO_FIVE, 3)
    assert not any(math.isnan(v) for v in out)
    assert out == pytest.approx([1.0, 1.5, 2.25, 3.125, 4.0625])


def test_ema_is_not_the_talib_seed_form() -> None:
    """The counterfactual, written down so a future 'fix' is a visible decision."""
    assert ta_ema(ONE_TO_FIVE, 3)[0] == pytest.approx(1.0)   # TA-Lib: na
    assert ta_ema(ONE_TO_FIVE, 3)[1] == pytest.approx(1.5)   # TA-Lib: na
    assert ta_ema(ONE_TO_FIVE, 3)[2] == pytest.approx(2.25)  # TA-Lib: 2.0 (the SMA seed)


def test_rma_is_wilder_alpha_one_over_n_seeded_on_the_sma() -> None:
    """Same engine, opposite convention: rma gates on a full window (pineTa.ts:147-170)."""
    # seed at index 2 = mean(1,2,3) = 2; index 3 = (2*2 + 4)/3 = 8/3;
    # index 4 = ((8/3)*2 + 5)/3 = 31/9.
    out = ta_rma(ONE_TO_FIVE, 3)
    assert math.isnan(out[0]) and math.isnan(out[1])
    assert out[2] == pytest.approx(2.0)
    assert out[3] == pytest.approx(8 / 3)
    assert out[4] == pytest.approx(31 / 9)


def test_stdev_default_is_population_the_ddof_the_folklore_gets_wrong() -> None:
    """Pine's ``ta.stdev`` defaults to the POPULATION deviation (ddof=0), so does numpy.

    The widespread claim that "Pine uses the sample one, that's the silent
    divergence vs numpy" is false in this direction (spec §11 更正一). The engine
    exposes the sample form only through the third argument, so the reference
    takes the same flag and both branches are covered.
    """
    out = ta_stdev(ONE_TO_FIVE, 3)
    assert math.isnan(out[1])
    assert out[2] == pytest.approx(0.8164965809277260), out[2]  # population [1,2,3]
    assert out[4] == pytest.approx(0.8164965809277260)          # population [3,4,5]
    assert out[4] == pytest.approx(float(np.std([3.0, 4.0, 5.0])), rel=1e-15)


def test_stdev_biased_false_is_the_sample_one() -> None:
    sample = ta_stdev(ONE_TO_FIVE, 3, biased=False)
    assert sample[2] == pytest.approx(1.0)   # [1,2,3]: 偏差 -1,0,1 → 平方和 2 ÷ (n-1)=2 → 开方 1
    assert sample[4] == pytest.approx(1.0)
    assert not math.isclose(sample[4], float(np.std([3.0, 4.0, 5.0])), rel_tol=1e-9)


def test_windows_use_the_trailing_n_values_inclusive_of_the_current_bar() -> None:
    src = np.array([10.0, 20.0, 30.0, 40.0])
    assert ta_sma(src, 2)[3] == pytest.approx(35.0)
    # window [30,40]: mean 35, deviations ±5, squares 25+25=50
    assert ta_stdev(src, 2)[3] == pytest.approx(5.0)                    # 50/2 -> sqrt 25
    assert ta_stdev(src, 2, biased=False)[3] == pytest.approx(7.0710678118654755)  # 50/1
```

- [ ] **Step 2: 跑到失败**

Run: `python -X utf8 -m pytest agent/tests/pine_oracle/test_reference_batch1.py -q`
Expected: `ModuleNotFoundError: No module named 'pine_oracle.reference'`（collection error，不是 pass，也不是 skip）

- [ ] **Step 3: 写 `agent/pine_oracle/reference.py`（批次一）**

```python
"""Independent numpy reference implementations of the Pine ``ta.*`` builtins.

Read this module as an argument about Pine's published semantics, not as a port
of the engine. The engine (``frontend/src/lib/pineTa.ts``) may be consulted ONLY
for parameter defaults and ``na`` rules — copying its control flow here would make
the oracle agree with the engine by construction, which is the failure mode this
whole harness exists to prevent.

Two seedings coexist and are NOT interchangeable (spec §6, §11 更正一): ``ema``
starts on the first bar, ``rma`` waits for a full window and seeds on its mean.
Any "unify the warm-up" refactor here silently changes what the gate proves.
"""

from __future__ import annotations

from typing import Callable, Optional

import numpy as np

NanArray = np.ndarray  # float64, same length as the input, np.nan where Pine says na

#: The one length every batch-1/2 line is computed at. The Pine source text below
#: and the reference calls in ``emit_fixtures.py`` both read THIS, so a drift in
#: the length can only be a deliberate one-edit change.
PERIOD = 5


def ta_sma(src: np.ndarray, n: int) -> NanArray:
    out = np.full(src.shape, np.nan)
    if n < 1 or src.shape[0] < n:
        return out
    csum = np.cumsum(np.insert(np.asarray(src, dtype="float64"), 0, 0.0))
    out[n - 1 :] = (csum[n:] - csum[:-n]) / n
    return out


def ta_ema(src: np.ndarray, n: int) -> NanArray:
    """alpha = 2/(n+1) seeded on ``src[0]`` — Pine's convention, no warm-up blank."""
    src = np.asarray(src, dtype="float64")
    out = np.full(src.shape, np.nan)
    if n < 1 or src.shape[0] < 1:
        return out
    alpha = 2.0 / (n + 1.0)
    prev = float(src[0])
    out[0] = prev
    for i in range(1, src.shape[0]):
        prev = alpha * float(src[i]) + (1.0 - alpha) * prev
        out[i] = prev
    return out


def ta_rma(src: np.ndarray, n: int) -> NanArray:
    """Wilder smoothing: alpha = 1/n, seeded on the SMA of the first ``n`` values."""
    src = np.asarray(src, dtype="float64")
    out = np.full(src.shape, np.nan)
    if n < 1 or src.shape[0] < n:
        return out
    prev = float(src[:n].mean())
    out[n - 1] = prev
    for i in range(n, src.shape[0]):
        prev = (prev * (n - 1) + float(src[i])) / n
        out[i] = prev
    return out


def ta_stdev(src: np.ndarray, n: int, biased: bool = True) -> NanArray:
    """Trailing ``n`` bars. ``biased=True`` (Pine's default) is the POPULATION form."""
    src = np.asarray(src, dtype="float64")
    out = np.full(src.shape, np.nan)
    if n < 1 or src.shape[0] < n:
        return out
    denom = n if biased else (n - 1)
    for i in range(n - 1, src.shape[0]):
        window = src[i - n + 1 : i + 1]
        mean = float(window.mean())
        ss = float(((window - mean) ** 2).sum())
        out[i] = (ss / denom) ** 0.5 if denom > 0 else 0.0
    return out


def ref_batch_1(
    cols: dict[str, NanArray], period: int, session: Optional[np.ndarray] = None
) -> dict[str, NanArray]:
    close = cols["close"]
    return {
        "sma": ta_sma(close, period),
        "ema": ta_ema(close, period),
        "rma": ta_rma(close, period),
        "stdev": ta_stdev(close, period),
        "stdev_sample": ta_stdev(close, period, biased=False),
    }


REFERENCE: dict[str, Callable[..., dict[str, NanArray]]] = {"batch_1": ref_batch_1}
```

Also define in the same module the Pine sources the JS gate runs (kept here so the fixture and the script can never drift apart):

```python
#: The Pine source text the JS gate runs, per reference batch. Plot titles are the
#: ``line`` keys in the emitted ``values/*.csv`` — one file per (title, bars variant).
SCRIPTS: dict[str, str] = {
    "batch_1": (
        "//@version=5\n"
        'indicator("oracle batch 1")\n'
        f'plot(ta.sma(close, {PERIOD}), title="sma")\n'
        f'plot(ta.ema(close, {PERIOD}), title="ema")\n'
        f'plot(ta.rma(close, {PERIOD}), title="rma")\n'
        f'plot(ta.stdev(close, {PERIOD}), title="stdev")\n'
        f'plot(ta.stdev(close, {PERIOD}, false), title="stdev_sample")\n'
    ),
}
```

- [ ] **Step 4: 单元断言到绿**

Run: `python -X utf8 -m pytest agent/tests/pine_oracle/test_reference_batch1.py -q`
Expected: `7 passed`。若 `test_windows_use_the_trailing_n_values...` 的 `5.0` / `7.0710678118654755` 对不上，**先按注释里那条手算复核（和=50，除以 2 或除以 1），再决定改哪一侧**；不许把断言改成 `np.std(...)` 的返回值自证清白——那正是「拿实现当证据」。

- [ ] **Step 5: 写 `agent/pine_oracle/emit_fixtures.py` 并生成 values**

```python
"""Emit the value fixtures + manifest the JS oracle gate reads.

Every run rewrites the whole set from the reference implementations, so the
committed CSV is always reproducible from committed Python — which is what makes
the fixture trustworthy (test_pine_oracle_provenance.py).

This module writes the bar fixtures too: ``files`` must cover every byte the JS
gate reads, and a manifest that hashed only the answers would leave the questions
(the bars) free to drift.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path
from subprocess import check_output
from typing import Any, Optional

import numpy as np

from pine_oracle.emit_bars import BAR_JOBS, BARS_BASENAMES, BARS_META, emit as emit_bars
from pine_oracle.reference import PERIOD, REFERENCE, SCRIPTS
from pine_oracle.schema import (
    FIXTURE_DIR,
    REPO_ROOT,
    VALUE_HEADER,
    dump_manifest,
    fmt_float,
    sha256_of,
    validate_manifest,
    write_text_lf,
)

#: One-pass computations (a mean, a deviation over a fixed window) are ``tight``;
#: everything iterative or cumulative is ``loose``. Spec §5, tighten-only.
TIGHT_LINES: frozenset[str] = frozenset(
    {"sma", "stdev", "stdev_sample", "bb_basis", "bb_upper", "bb_lower"}
)

#: basename -> (rows, writes_the_session_column), taken from emit_bars so the seeds
#: and shapes cannot be restated wrong here.
BARS_SETS: dict[str, tuple[list[dict[str, Any]], bool]] = {
    name: (rows, with_session) for name, rows, with_session in BAR_JOBS
}
assert set(BARS_SETS) == set(BARS_BASENAMES) == set(BARS_META), (
    sorted(BARS_SETS),
    sorted(BARS_BASENAMES),
    sorted(BARS_META),
)


def _columns(rows: list[dict[str, Any]]) -> dict[str, np.ndarray]:
    return {
        k: np.asarray([r[k] for r in rows], dtype="float64")
        for k in ("open", "high", "low", "close", "volume")
    }


def _session(rows: list[dict[str, Any]]) -> Optional[np.ndarray]:
    if "session" not in rows[0]:
        return None
    return np.asarray([r["session"] for r in rows], dtype="int64")


def values_csv(series: np.ndarray) -> str:
    lines = [",".join(VALUE_HEADER)]
    for i, v in enumerate(series):
        lines.append(f"{i},{'' if np.isnan(v) else fmt_float(float(v))}")
    return "\n".join(lines) + "\n"


def emit(out_dir: Path = FIXTURE_DIR) -> dict[str, Any]:
    files = {
        str(path.relative_to(out_dir)).replace("\\", "/"): digest
        for path, digest in emit_bars(out_dir)
    }
    tier: dict[str, str] = {}
    exemption: dict[str, str] = {}
    lines_by_batch: dict[str, list[str]] = {}
    for batch_name, fn in REFERENCE.items():
        emitted: set[str] = set()
        for bars_name, (rows, _with_session) in BARS_SETS.items():
            series = fn(_columns(rows), PERIOD, _session(rows))
            for line_name, arr in series.items():
                rel = f"values/{line_name}@{bars_name}.csv"
                path = out_dir / "values" / f"{line_name}@{bars_name}.csv"
                write_text_lf(path, values_csv(arr))
                files[rel] = sha256_of(path)
                emitted.add(line_name)
                tier[line_name] = "tight" if line_name in TIGHT_LINES else "loose"
                exemption[line_name] = "strict"
        lines_by_batch[batch_name] = sorted(emitted)
    manifest: dict[str, Any] = {
        "na_encoding": "empty",
        "line_ending": "lf",
        "period": {"default": PERIOD},
        "seed": {name: meta[0] for name, meta in BARS_META.items()},
        "shape": {name: meta[1] for name, meta in BARS_META.items()},
        "scripts": SCRIPTS,
        "lines": lines_by_batch,
        "tolerance_tier": tier,
        "exemption": exemption,
        # 外部锚点在 Task 5/6 逐批填；空数组是诚实读数，不是失败（spec §9 R-B）。
        "external_anchors": [],
        "generated_at": date.today().isoformat(),
        "generator": "agent/pine_oracle/emit_fixtures.py",
        # Read from the repo this module lives in, not from wherever the caller
        # happened to cd into — the rest of the module is ``__file__``-derived and
        # a cwd-dependent line here would crash (or mislabel) outside the repo root.
        "head_sha": check_output(
            ["git", "rev-parse", "--short", "HEAD"], cwd=REPO_ROOT, text=True
        ).strip(),
        # manifest.json 自己不进 files：自哈希是「先写后哈希」的循环，它既不可能被
        # 自己包含，也不可能被校验，列上它只是假装覆盖了。
        "files": files,
    }
    errors = validate_manifest(manifest)
    if errors:
        raise SystemExit("manifest invalid: " + "; ".join(errors))
    write_text_lf(out_dir / "manifest.json", dump_manifest(manifest))
    return manifest


if __name__ == "__main__":
    m = emit()
    print(
        f"{len(m['files'])} files, {len(m['tolerance_tier'])} lines tiered, "
        f"batches={ {k: len(v) for k, v in m['lines'].items()} }"
    )
```

Run: `PYTHONPATH=agent python -X utf8 -m pine_oracle.emit_fixtures`
Expected: 打印 `24 files, 5 lines tiered, batches={'batch_1': 5}`（20 values + 4 bars）。把打印原文与 `ls frontend/src/lib/__tests__/__fixtures__/pine_oracle/values | wc -l`、`wc -l frontend/src/lib/__tests__/__fixtures__/pine_oracle/values/*.csv | tail -1` 三行读数一起写进报告。

- [ ] **Step 6: 写 provenance 门（防「手改 CSV 当真值」）**

```python
# agent/tests/pine_oracle/test_pine_oracle_provenance.py
"""Regenerating from the reference implementations must reproduce the committed bytes.

This is the link that makes a committed fixture trustworthy: an edited CSV stops
being evidence and becomes a red test.

Both sides are compared after LF normalisation (schema's own sha definition) because
``core.autocrlf=true`` on this machine rewrites line endings at checkout — machine
fact R-46. Content differences are still caught byte for byte.
"""

from pathlib import Path

from pine_oracle.emit_fixtures import BARS_SETS, FIXTURE_DIR, PERIOD, emit
from pine_oracle.schema import (
    EXEMPTION_CLASSES,
    TOLERANCE_TIERS,
    load_manifest,
    sha256_of,
)


def _lf(path: Path) -> bytes:
    return path.read_bytes().replace(b"\r\n", b"\n")


def test_manifest_lists_every_committed_data_file() -> None:
    """Every data file the gate reads is on disk and hashes to what the manifest says.

    ``*.md`` is excluded because the prose ledger (`COVERAGE.md`, Task 7) and the
    anchor notes (`EXTERNAL_ANCHORS.md`, Task 6) live in this same directory and are
    not fixture data — listing them would put prose under a hash. Everything else is
    still enumerated in both directions, so a dropped, added or edited CSV (or a
    stray non-doc file) goes red.
    """
    manifest = load_manifest(FIXTURE_DIR / "manifest.json")
    listed = manifest["files"]
    on_disk = {
        str(p.relative_to(FIXTURE_DIR)).replace("\\", "/")
        for p in FIXTURE_DIR.rglob("*")
        if p.is_file() and p.suffix != ".md" and p.name not in {".gitattributes", "manifest.json"}
    }
    assert set(listed) == on_disk, (sorted(set(listed) - on_disk), sorted(on_disk - set(listed)))
    for rel, digest in listed.items():
        assert sha256_of(FIXTURE_DIR / rel) == digest, rel


def test_regenerated_files_are_bytewise_identical(tmp_path: Path) -> None:
    emit(out_dir=tmp_path)
    for rel in load_manifest(FIXTURE_DIR / "manifest.json")["files"]:
        assert _lf(tmp_path / rel) == _lf(FIXTURE_DIR / rel), rel


def test_every_declared_line_is_strict_and_tiered_from_the_two_allowed_sets() -> None:
    """A tier or class that quietly loosens defeats the whole harness; this test is
    the audit trail the design's "only ever tighten" rule requires (spec §5)."""
    manifest = load_manifest(FIXTURE_DIR / "manifest.json")
    for line, cls in manifest["exemption"].items():
        assert cls in EXEMPTION_CLASSES, line
    for line, tier in manifest["tolerance_tier"].items():
        assert tier in TOLERANCE_TIERS, line
    assert all(cls == "strict" for cls in manifest["exemption"].values()), manifest["exemption"]


def test_manifest_lines_match_the_scripts_plot_titles() -> None:
    """The fixture must describe exactly the lines the Pine source plots — a plot
    added or renamed without regenerating would otherwise be read from a stale CSV."""
    manifest = load_manifest(FIXTURE_DIR / "manifest.json")
    for batch, src in manifest["scripts"].items():
        titles = sorted(
            part.split('title="')[1].split('"')[0] for part in src.split("\n") if 'title="' in part
        )
        assert manifest["lines"][batch] == titles, (batch, manifest["lines"][batch], titles)


def test_batch_one_lines_are_emitted_for_every_variant() -> None:
    manifest = load_manifest(FIXTURE_DIR / "manifest.json")
    assert manifest["lines"]["batch_1"] == ["ema", "rma", "sma", "stdev", "stdev_sample"]
    assert manifest["tolerance_tier"]["stdev"] == "tight"
    assert manifest["tolerance_tier"]["ema"] == "loose"
    for line in manifest["lines"]["batch_1"]:
        for bars in BARS_SETS:
            assert f"values/{line}@{bars}.csv" in manifest["files"], (line, bars)


def test_values_header_and_na_encoding_are_the_declared_contract() -> None:
    manifest = load_manifest(FIXTURE_DIR / "manifest.json")
    rel = f"values/sma@{next(iter(BARS_SETS))}.csv"
    text = _lf(FIXTURE_DIR / rel).decode("utf-8")
    assert text.splitlines()[0] == "bar_index,expected"
    assert "nan" not in text.lower() and "null" not in text.lower(), rel
    assert manifest["na_encoding"] == "empty"
    assert manifest["period"]["default"] == PERIOD
```

Run: `python -X utf8 -m pytest agent/tests/pine_oracle/test_pine_oracle_provenance.py -q`
Expected: `6 passed`。`test_manifest_lists_every_committed_data_file` 若红，先分清是「文件真的不在盘上」还是「`files` 的相对路径分隔符不一致（`\\` vs `/`）」——后者是 Windows 上的典型症状，不是数据问题。

- [ ] **Step 7: 写 oracle 门（JS）——先接到批次一 5 条 line**

```ts
import { describe, expect, it } from "vitest";

import {
  BARS_VARIANTS,
  TIER_VALUE,
  expectedColumn,
  loadBars,
  loadManifest,
  runScript,
  type OracleManifest,
} from "./pineOracleFixtures";

/**
 * Gate 2 — cross-implementation reconciliation. The reference series here come
 * from ``agent/pine_oracle/reference.py`` (independent numpy code, pinned by
 * hand-derivable closed forms), never from the engine. A pass therefore means
 * "two separately-written implementations agree to within the declared tier".
 */

/** The bar count each variant is generated with; a shorter fixture would silently
 * shrink the comparison instead of failing. */
const BAR_COUNT: Record<string, number> = {
  bars_daily_trend: 120,
  bars_daily_oscillating: 120,
  bars_daily_gapped: 120,
  bars_intraday_vwap: 40,
};

interface Reading {
  checked: number;
  naCount: number;
  worst: number;
  mismatch: string | null;
}

function worstRelative(engine: number[], reference: number[]): Reading {
  let worst = 0;
  let checked = 0;
  let naCount = 0;
  for (let i = 0; i < reference.length; i += 1) {
    const ref = reference[i];
    const got = engine[i];
    if (Number.isNaN(ref)) {
      if (!Number.isNaN(got)) {
        return { checked, naCount, worst, mismatch: `index ${i}: reference is na, engine gave ${got}` };
      }
      naCount += 1;
      continue;
    }
    if (Number.isNaN(got)) {
      return { checked, naCount, worst, mismatch: `index ${i}: engine is na, reference has ${ref}` };
    }
    checked += 1;
    const diff = Math.abs(got - ref) / Math.max(Math.abs(ref), 1e-9);
    if (diff > worst) worst = diff;
  }
  return { checked, naCount, worst, mismatch: null };
}

describe("pine ta.* cross-implementation oracle", () => {
  const manifest: OracleManifest = loadManifest();

  for (const batch of Object.keys(manifest.scripts)) {
    const lineNames = manifest.lines[batch];
    const src = manifest.scripts[batch];

    for (const variant of BARS_VARIANTS) {
      const bars = loadBars(variant);
      const engine = runScript(src, bars);

      // A stray/renamed/missing plot() must not be able to hide behind "the lines we
      // knew about matched": compare the whole key set, in both directions.
      it(`${batch} on ${variant}: the script plots exactly the declared lines`, () => {
        expect([...Object.keys(engine)].sort()).toEqual([...lineNames].sort());
        expect(bars.close.length).toBe(BAR_COUNT[variant]);
      });

      for (const line of lineNames) {
        const expected = expectedColumn(line, variant);
        const { checked, naCount, worst, mismatch } = worstRelative(engine[line] ?? [], expected);
        const tier = TIER_VALUE[manifest.tolerance_tier[line]];
        it(`${line} on ${variant}: matches the numpy reference within ${manifest.tolerance_tier[line]}`, () => {
          expect(mismatch).toBeNull();
          // Every index is either compared or na on both sides — nothing skipped.
          expect(checked + naCount).toBe(expected.length);
          expect(checked).toBeGreaterThan(0);
          expect(worst).toBeLessThanOrEqual(tier);
        });
        // The reading the DoD asks for: one number per (line, variant), printed, not a
        // boolean. Assertions stay above; this line only reports.
        console.info(`[oracle] ${batch}/${line}@${variant} worst=${worst.toExponential(3)} na=${naCount} checked=${checked}`);
      }
    }
  }
});
```

Run: `cd frontend && npx vitest run src/lib/__tests__/pineTaOracle.test.ts`
Expected: `24 passed`（每批次每变体 1 条 key-set 守卫 + 5 条 line 对账 ⇒ 1 批次 × 4 变体 × 6 = 24）。把 `Test Files` 与 `Tests` 两行原文抄进报告，以命令输出为准，不引用本行推算值。**这一步很可能第一次就红**：引擎的 `na` 起始下标与参考实现的播种下标不同（`ema` 无 warm-up、`rma` 首值在 `n-1`），`console.info` 那行的 `na=` 就是量出差异的读数。红了按 Step 8 裁定，禁止改容差档位或改 `na` 数糊过去。

- [ ] **Step 8: 分歧裁定（只在有分歧时执行）**

对每个不一致的函数，按 spec §8 的纪律写一段裁定进 `项目档案.md` 的本轮条目：`函数 / 两侧各自的下标或值 / 谁依据哪条 Pine 公开定义 / 裁定 / 若裁定为引擎缺陷则登记 backlog 不改引擎`。裁定权在用户：**发现引擎缺陷时停下来报告，不许自行改 `pineTa.ts`。**

- [ ] **Step 9: 提交**

```bash
git add agent/pine_oracle/reference.py agent/pine_oracle/emit_fixtures.py \
        agent/tests/pine_oracle/test_reference_batch1.py agent/tests/pine_oracle/test_pine_oracle_provenance.py \
        frontend/src/lib/__tests__/pineTaOracle.test.ts \
        frontend/src/lib/__tests__/__fixtures__/pine_oracle/
git commit -s -m "test(pineOracle): 批次一 5 条 line 的 numpy 参考实现＋values 夹具＋跨实现对账门接通"
```

---

### Task 5: 参考实现批次二（rsi / atr / bb / macd / stoch）

**Files:**
- Modify: `agent/pine_oracle/reference.py`（+6 个函数与批次二参数常量、`ref_batch_2`、`SCRIPTS["batch_2"]`）
- Modify: `agent/pine_oracle/emit_fixtures.py`（新增 `ENGINE_CONVENTION` 表并写进 `manifest["convention"]`；`PERIOD` 已在 Task 4 从 `reference` 导入，本任务不再重复定义）
- Create: `agent/tests/pine_oracle/test_reference_batch2.py`
- Modify: `agent/tests/pine_oracle/test_pine_oracle_provenance.py`（+2 条守卫）
- Modify: `frontend/src/lib/__tests__/pineOracleFixtures.ts`（`OracleManifest` 加 `convention`）
- Create: `frontend/src/lib/__tests__/__fixtures__/pine_oracle/values/*.csv`（+40：批次二 10 条 line × 4 形态）

**Interfaces:**
- Consumes: `ta_sma`/`ta_ema`/`ta_rma`/`ta_stdev`（Task 4）、`PERIOD`（Task 4 起定义在 `reference.py`）
- Produces:
  - 参数常量 `RSI_LEN = 14`、`MACD_FAST = 12`、`MACD_SLOW = 26`、`MACD_SIG = 9`、`BB_COEF = 2.0`、`STOCH_D_LEN = 3`（`atr`/`bb`/`stoch` 的长度一律用 Task 4 的 `PERIOD`，Pine 文本与参考调用同一常量）
  - `ta_tr(high, low, close) -> NanArray`、`ta_atr(high, low, close, n)`、`ta_rsi(src, n)`、`ta_bb(src, n, coef) -> {"bb_basis","bb_upper","bb_lower"}`、`ta_macd(src, fast, slow, sig) -> {"macd","macd_signal","macd_hist"}`、`ta_stoch(src, high, low, n, d_len) -> {"stoch_k","stoch_d"}`
  - `ref_batch_2(cols, period, session=None) -> dict[str, NanArray]`（10 条 line：`atr`、`bb_basis`、`bb_lower`、`bb_upper`、`macd`、`macd_hist`、`macd_signal`、`rsi`、`stoch_d`、`stoch_k`）
  - `emit_fixtures.ENGINE_CONVENTION: dict[str, str]` → 写进 `manifest["convention"]`；JS 侧 `OracleManifest.convention: Record<string, string>`

> **本任务的关键纪律**：批次二里有三处「引擎的做法与 TA-Lib/教科书的做法不同」，坐标已逐条读源码确认（见 Step 3 每处注释）。参考实现**按引擎的做法写**，但每一处都必须在 `ENGINE_CONVENTION` 里留名、并在点值测试里同时写出「另一套约定的数是多少」。这样门是绿的，而每一次对引擎约定的采纳都是一条 git 可见、可回退的记录——不是把引擎的写法抄成「标准」。

- [ ] **Step 1: 写失败测试（每条都手算可复核）**

```python
# agent/tests/pine_oracle/test_reference_batch2.py
"""Batch 2: the functions whose warm-up and na rules are the whole story.

Every expected number is derived on paper from the recursion named in the test.
Where the engine's convention differs from the TA-Lib/textbook one, BOTH numbers
are written down: the gate holds the engine's, the comment keeps the other one from
being forgotten.
"""

import math

import numpy as np
import pytest

from pine_oracle.reference import (
    ta_atr,
    ta_bb,
    ta_ema,
    ta_macd,
    ta_rsi,
    ta_stoch,
    ta_tr,
)

CLOSE5 = np.array([1.0, 2.0, 3.0, 4.0, 5.0])
HIGH5 = np.array([2.0, 3.0, 4.0, 5.0, 6.0])
LOW5 = np.array([0.5, 1.0, 1.5, 2.0, 2.5])


def test_tr_first_bar_reduces_to_high_minus_low() -> None:
    """The engine uses ``pc = close[i]`` at bar 0 (pineTa.ts:536); for a well-formed
    bar (low <= close <= high) the three candidates collapse to ``high - low``."""
    tr = ta_tr(HIGH5, LOW5, CLOSE5)
    assert tr[0] == pytest.approx(1.5)                        # 2.0 - 0.5
    assert tr[1] == pytest.approx(2.0)                        # max(3-1, |3-1|, |1-1|)
    assert tr[2] == pytest.approx(2.5)                        # max(4-1.5, |4-2|, |1.5-2|)
    assert tr[4] == pytest.approx(3.5)


def test_atr_is_rma_of_tr_seeded_at_n_minus_one() -> None:
    tr = ta_tr(HIGH5, LOW5, CLOSE5)                      # [1.5, 2.0, 2.5, 3.0, 3.5]
    out = ta_atr(HIGH5, LOW5, CLOSE5, 3)
    assert math.isnan(out[0]) and math.isnan(out[1])
    assert out[2] == pytest.approx(float(tr[:3].mean()))  # (1.5+2+2.5)/3 = 2.0, the seed
    assert out[3] == pytest.approx((2.0 * 2 + 3.0) / 3)   # (prev*(n-1)+tr[3])/n = 7/3
    assert out[4] == pytest.approx(((7.0 / 3.0) * 2 + 3.5) / 3)   # 49/18


def test_rsi_seeds_one_bar_earlier_than_the_textbook_and_tells_you_so() -> None:
    """Engine: ``change`` at bar 0 is na, and both rma streams are fed **0** there
    (pineTa.ts:550-551), so the seed window includes that 0 and the first non-na
    RSI sits at index ``n-1``. The textbook na-propagation form would give index
    ``n`` with seed ``mean(change[1..n])`` — for [1..5], n=3: [na, na, na, 100, 100].
    Adopted engine convention; see ENGINE_CONVENTION["rsi"].
    """
    out = ta_rsi(CLOSE5, 3)
    assert math.isnan(out[0]) and math.isnan(out[1])
    assert out[2] == pytest.approx(100.0)     # dn seed = mean([0,0,0]) = 0, up = 2/3 > 0
    assert out[3] == pytest.approx(100.0)
    assert out[4] == pytest.approx(100.0)


def test_rsi_flat_series_is_50_not_na_and_not_a_division_crash() -> None:
    """pineTa.ts:554 ``dn === 0`` returns ``up === 0 ? 50 : 100`` — both zero is 50."""
    out = ta_rsi(np.array([5.0] * 6), 3)
    assert out[2:] == pytest.approx([50.0, 50.0, 50.0, 50.0])


def test_rsi_all_losses_is_zero() -> None:
    out = ta_rsi(CLOSE5[::-1].copy(), 3)
    assert out[2] == pytest.approx(0.0)
    assert out[4] == pytest.approx(0.0)


def test_bb_follows_the_population_stdev_it_calls() -> None:
    """bb's dev is ``coef * ta.stdev(src, n)`` with the engine's default biased=true,
    i.e. the population form (pineTa.ts:635-642 -> stdStep default). The folklore
    "bb uses the sample one" would give 4 ± 2.0 here instead of the values below."""
    out = ta_bb(CLOSE5, 3, 2.0)
    assert out["bb_basis"][4] == pytest.approx(4.0)
    dev = 2.0 * 0.8164965809277260                      # 2 * population sd of [3,4,5]
    assert out["bb_upper"][4] == pytest.approx(4.0 + dev)
    assert out["bb_lower"][4] == pytest.approx(4.0 - dev)
    assert not math.isclose(out["bb_upper"][4], 6.0, rel_tol=1e-3)   # sample form -> 6
    assert math.isnan(out["bb_upper"][1])                            # basis warm-up carries


def test_macd_is_dense_from_bar_zero_and_hist_is_the_exact_difference() -> None:
    """Both emas seed at bar 0, so the line, the signal and the histogram all have a
    value at bar 0 (pineTa.ts:622-632). hist is literally ``line - signal``."""
    out = ta_macd(CLOSE5, 3, 5, 3)
    for key in ("macd", "macd_signal", "macd_hist"):
        assert not any(math.isnan(v) for v in out[key]), key
    assert out["macd"][0] == pytest.approx(0.0)          # both emas start at src[0]
    assert (out["macd_hist"] == out["macd"] - out["macd_signal"]).all()


def test_macd_signal_is_an_ema_of_the_macd_line_not_of_the_source() -> None:
    ramp = np.arange(1.0, 41.0)
    out = ta_macd(ramp, 3, 5, 3)
    line = out["macd"]
    # Unit ramp: an EMA with alpha lags the ramp by (1-alpha)/alpha bars, so the
    # line tends to 2 - 1 = 1 (slow alpha=1/3 -> lag 2; fast alpha=1/2 -> lag 1).
    assert line[39] == pytest.approx(1.0, abs=1e-6)
    assert out["macd_signal"][39] < line[39]             # ema of a rising sequence is below it
    assert out["macd_signal"][39] < 2.0
    # The wrong implementation (ema over the source) would sit near 40 - 1 = 39.
    assert ta_ema(ramp, 3)[39] > 30.0


def test_stoch_uses_the_partial_window_from_bar_zero() -> None:
    """Engine: highest/lowest have no full-window gate (pineTa.ts:212-222), so %K is
    defined at bar 0 from the one bar available. A strict n-bar warm-up would give
    na for the first n-1 bars. Adopted engine convention; ENGINE_CONVENTION["stoch_k"]."""
    out = ta_stoch(CLOSE5, HIGH5, LOW5, 5, 3)
    k = out["stoch_k"]
    assert k[0] == pytest.approx(100.0 * (1.0 - 0.5) / (2.0 - 0.5))    # 33.333...
    assert k[4] == pytest.approx(100.0 * (5.0 - 0.5) / (6.0 - 0.5))    # window of 5
    assert not math.isnan(k[0])


def test_stoch_monotonic_ramp_is_100_whatever_the_length() -> None:
    src = np.arange(1.0, 21.0)
    out = ta_stoch(src, src, src, 5, 3)
    # bar 0: hh == ll -> na by rule; from bar 1 the ramp's own spread carries it, and
    # on a strictly increasing series (close == high == low) %K is 100 for any length.
    assert math.isnan(out["stoch_k"][0])
    assert out["stoch_k"][1:] == pytest.approx([100.0] * 19)
    # %D needs three finite %K, so it starts one bar after they are all there:
    # k is finite from index 1 => first finite d is index 3.
    assert math.isnan(out["stoch_d"][2])
    assert out["stoch_d"][3:] == pytest.approx([100.0] * 17)


def test_stoch_zero_range_is_na_not_divide_by_zero_inf() -> None:
    flat = np.array([5.0] * 10)
    out = ta_stoch(flat, flat, flat, 5, 3)
    assert np.all(np.isnan(out["stoch_k"]))
    assert np.all(np.isnan(out["stoch_d"]))


def test_smoothed_stages_propagate_na_instead_of_skipping_it() -> None:
    """``ta.sma`` returns na if any window value is na (pineTa.ts:46-54), so the
    smooth's first value is (first finite k) + d_len - 1, not just d_len - 1.
    An 'average whatever is available' smoother would already answer at first_k."""
    src = np.array([1.0, 1.0, 2.0, 3.0, 4.0, 5.0])
    out = ta_stoch(src, src, src, 3, 3)
    assert math.isnan(out["stoch_k"][0]) and math.isnan(out["stoch_k"][1])   # hh == ll
    first_k = 2
    assert out["stoch_k"][first_k] == pytest.approx(100.0)
    assert math.isnan(out["stoch_d"][first_k])           # window [na, na, 100]
    assert math.isnan(out["stoch_d"][first_k + 1])       # window [na, 100, 100]
    assert out["stoch_d"][first_k + 2] == pytest.approx(100.0)   # first all-finite window
```

- [ ] **Step 2: 跑到失败**

Run: `python -X utf8 -m pytest agent/tests/pine_oracle/test_reference_batch2.py -q`
Expected: `ImportError: cannot import name 'ta_atr' from 'pine_oracle.reference'`（collection error；不是 pass，也不是 skip）

- [ ] **Step 3: 实现（追加进 `reference.py`）**

```python
# --- batch 2 parameters: one definition each, consumed by BOTH ref_batch_2 and
# SCRIPTS["batch_2"], so the Pine text the JS gate runs and the numpy series the
# fixture stores cannot quietly disagree about a length.
RSI_LEN = 14
MACD_FAST = 12
MACD_SLOW = 26
MACD_SIG = 9
BB_COEF = 2.0
STOCH_D_LEN = 3


def ta_tr(high: np.ndarray, low: np.ndarray, close: np.ndarray) -> NanArray:
    """True range, bar 0 included.

    The engine's ``pc`` at bar 0 is ``close[0]`` (pineTa.ts:536), not a missing
    value; for any bar with ``low <= close <= high`` the three candidates collapse
    to ``high - low``, which is what the folklore rule states.
    """
    out = np.empty(high.shape, dtype="float64")
    out[0] = max(
        float(high[0]) - float(low[0]),
        abs(float(high[0]) - float(close[0])),
        abs(float(low[0]) - float(close[0])),
    )
    for i in range(1, high.shape[0]):
        pc = float(close[i - 1])
        out[i] = max(
            float(high[i]) - float(low[i]),
            abs(float(high[i]) - pc),
            abs(float(low[i]) - pc),
        )
    return out


def ta_atr(high: np.ndarray, low: np.ndarray, close: np.ndarray, n: int) -> NanArray:
    return ta_rma(ta_tr(high, low, close), n)


def ta_rsi(src: np.ndarray, n: int) -> NanArray:
    """RSI on the engine's seeding rule (see the batch-2 note above).

    ``change`` is na at bar 0, but the engine feeds ``0`` into both rma streams
    there, so the seeding window is ``[0, c1, .. c(n-1)]`` and the first non-na
    output is at index ``n-1``. ``dn == 0`` -> 50 when ``up`` is also 0, else 100.
    """
    src = np.asarray(src, dtype="float64")
    out = np.full(src.shape, np.nan)
    L = src.shape[0]
    if n < 1 or L < n:
        return out
    change = np.full(L, np.nan)
    change[1:] = np.diff(src)
    up = np.where(np.isnan(change) | (change < 0), 0.0, change)
    down = np.where(np.isnan(change) | (change > 0), 0.0, -change)
    r_up, r_down = ta_rma(up, n), ta_rma(down, n)
    for i in range(L):
        if np.isnan(r_up[i]) or np.isnan(r_down[i]):
            continue
        u, d = float(r_up[i]), float(r_down[i])
        if d == 0.0:
            out[i] = 50.0 if u == 0.0 else 100.0
        elif u == 0.0:
            out[i] = 0.0
        else:
            out[i] = 100.0 - 100.0 / (1.0 + u / d)
    return out


def ta_bb(src: np.ndarray, n: int, coef: float) -> dict[str, NanArray]:
    """Bollinger on the engine's stdev default: the deviation is the POPULATION one."""
    src = np.asarray(src, dtype="float64")
    basis = ta_sma(src, n)
    dev = coef * ta_stdev(src, n)
    return {"bb_basis": basis, "bb_upper": basis + dev, "bb_lower": basis - dev}


def ta_macd(src: np.ndarray, fast: int, slow: int, sig: int) -> dict[str, NanArray]:
    """Three dense series from bar 0: line = ema(fast) - ema(slow), signal = ema(line).

    Because this engine's ``ema`` seeds at the first bar, nothing here is na during
    warm-up — the histogram is exactly ``line - signal``.
    """
    src = np.asarray(src, dtype="float64")
    line = ta_ema(src, fast) - ta_ema(src, slow)
    signal = ta_ema(line, sig)
    return {"macd": line, "macd_signal": signal, "macd_hist": line - signal}


def _sma_na_propagating(src: np.ndarray, n: int) -> NanArray:
    """``ta.sma`` with Pine's na arithmetic: a window containing any na is na.

    This is *not* a "skip the na and average the rest" smoother — the engine's
    ``smaStep`` returns NA the moment a window value is NA (pineTa.ts:46-54), which
    is what pushes the second stoch stage one bar later per na it inherits.
    """
    out = np.full(src.shape, np.nan)
    for i in range(n - 1, src.shape[0]):
        window = src[i - n + 1 : i + 1]
        if not np.any(np.isnan(window)):
            out[i] = float(window.mean())
    return out


def ta_stoch(src: np.ndarray, high: np.ndarray, low: np.ndarray, n: int, d_len: int) -> dict[str, NanArray]:
    """%K from the trailing high/low window (partial from bar 0); %D = sma(%K, d_len).

    ``hh == ll`` -> na (no divide-by-zero). The engine's four-argument overload
    returns %K only and its fifth argument is ``smoothK`` (pineTa.ts:596-610), so
    %D is produced on the Pine side by an explicit ``ta.sma`` — never by a six
    argument call, which would silently be a smoothed K.
    """
    src = np.asarray(src, dtype="float64")
    high = np.asarray(high, dtype="float64")
    low = np.asarray(low, dtype="float64")
    k = np.full(src.shape, np.nan)
    for i in range(src.shape[0]):
        # No full-window gate (pineTa.ts:212-222): bar 0 is measured over one bar.
        start = max(0, i - n + 1)
        hh = float(np.max(high[start : i + 1]))
        ll = float(np.min(low[start : i + 1]))
        if hh == ll:
            continue
        k[i] = 100.0 * (float(src[i]) - ll) / (hh - ll)
    return {"stoch_k": k, "stoch_d": _sma_na_propagating(k, d_len)}


def ref_batch_2(
    cols: dict[str, NanArray], period: int, session: Optional[np.ndarray] = None
) -> dict[str, NanArray]:
    close = cols["close"]
    out: dict[str, NanArray] = {
        "rsi": ta_rsi(close, RSI_LEN),
        "atr": ta_atr(cols["high"], cols["low"], close, period),
    }
    out.update(ta_bb(close, period, BB_COEF))
    out.update(ta_macd(close, MACD_FAST, MACD_SLOW, MACD_SIG))
    out.update(ta_stoch(close, cols["high"], cols["low"], period, STOCH_D_LEN))
    return out


REFERENCE["batch_2"] = ref_batch_2
```

Extend `SCRIPTS` (same module, same constants) so the gate runs real Pine for these:

```python
SCRIPTS["batch_2"] = (
    "//@version=5\n"
    'indicator("oracle batch 2")\n'
    f'plot(ta.rsi(close, {RSI_LEN}), title="rsi")\n'
    f'plot(ta.atr({PERIOD}), title="atr")\n'
    f'[basis, upper, lower] = ta.bb(close, {PERIOD}, {BB_COEF})\n'
    'plot(basis, title="bb_basis")\n'
    'plot(upper, title="bb_upper")\n'
    'plot(lower, title="bb_lower")\n'
    f'[macdLine, macdSig, macdHist] = ta.macd(close, {MACD_FAST}, {MACD_SLOW}, {MACD_SIG})\n'
    'plot(macdLine, title="macd")\n'
    'plot(macdSig, title="macd_signal")\n'
    'plot(macdHist, title="macd_hist")\n'
    f'k5 = ta.stoch(close, high, low, {PERIOD})\n'
    'plot(k5, title="stoch_k")\n'
    f'plot(ta.sma(k5, {STOCH_D_LEN}), title="stoch_d")\n'
)
```

`ta.stoch` 的三元组重载（`[K, D] = ta.stoch(src, length, smoothing)`）与四元组重载走的是引擎里两条不同的支路（`pineTa.ts:596-618`）；这里刻意只用四参 + 显式 `ta.sma`，因为参考实现只能对应这一种可写清的读法。解构赋值 `[a, b, c] = ta.bb(...)` 的支持度有既有先例（`pineRealWorld.test.ts:90/97` 的 `[supertrend, direction] = ta.supertrend(...)` 已在跑的绿测试里）。

- [ ] **Step 4: 让 `emit_fixtures.py` 记下每一处「采纳引擎约定」**

```python
#: Lines whose reference value follows THIS engine's convention rather than the
#: TA-Lib/textbook one. Each entry states what the other convention would have
#: produced, so the adoption is a record, not a forgetting. Provenance asserts this
#: exact key set: a new entry (or a removal) has to be made in git, visibly.
ENGINE_CONVENTION: dict[str, str] = {
    "ema": "seeded on src[0] with no na warm-up; TA-Lib SMA-seeds at n-1 (pineTa.ts:134-145)",
    "rsi": "bar-0 change enters both rma streams as 0, so the first value is at n-1 and the "
           "seed window includes that 0; na-propagation would start at n (pineTa.ts:550-551)",
    "stoch_k": "highest/lowest have no full-window gate, so %K exists from the first bar whose "
               "partial window has hh!=ll (on the ramp fixture that is bar 1, and bar 0 is na only "
               "via the hh==ll rule, not via warm-up); a strict n-bar warm-up leaves n-1 bars na "
               "(pineTa.ts:212-222)",
    "macd": "all three outputs are dense from bar 0 because the underlying emas are (pineTa.ts:622-632)",
}
```

`emit()` 的 manifest 里加一行 `"convention": ENGINE_CONVENTION`（放在 `exemption` 之后）。其余不动：`REFERENCE` 迭代自动带上 batch_2，`TIGHT_LINES` 里 `bb_basis`/`bb_upper`/`bb_lower` 已在，`rsi`/`atr`/`macd*`/`stoch_*` 落 `loose`。

- [ ] **Step 5: 补两条 provenance 守卫，并把 `convention` 的键钉成精确名单**

`pineOracleFixtures.ts` 的 `OracleManifest` 加 `convention: Record<string, string>;`。`test_pine_oracle_provenance.py` 追加：

```python
def test_line_names_are_unique_across_batches() -> None:
    """Two batches using one title would merge into a single tier and one CSV — the
    fixture would then be checking one of them twice."""
    manifest = load_manifest(FIXTURE_DIR / "manifest.json")
    all_lines = [line for names in manifest["lines"].values() for line in names]
    assert len(all_lines) == len(set(all_lines)), sorted(all_lines)


def test_declared_engine_conventions_are_the_exact_adjudicated_set() -> None:
    """Adopting the engine's convention over the textbook one is allowed, but only
    for the lines that have been argued about by name. New adoption => new entry,
    in git, next to a point-value test that writes down both numbers."""
    manifest = load_manifest(FIXTURE_DIR / "manifest.json")
    assert set(manifest["convention"]) == {"ema", "macd", "rsi", "stoch_k"}
    assert set(manifest["convention"]) <= set(manifest["tolerance_tier"])
```

Run: `python -X utf8 -m pytest agent/tests/pine_oracle/test_pine_oracle_provenance.py -q`
Expected: `8 passed`（Task 4 的 6 条 + 本任务 2 条）。

- [ ] **Step 6: 重新生成 fixture 并跑 Python 侧全套**

```bash
PYTHONPATH=agent python -X utf8 -m pine_oracle.emit_fixtures
python -X utf8 -m pytest agent/tests/pine_oracle -q
```
Expected: 打印 `64 files, 15 lines tiered, batches={'batch_1': 5, 'batch_2': 10}`（4 bars + 20 batch_1 values + 40 batch_2 values；`files` 含 bars 但不含 `manifest.json`，故是 64 而非 60）。把打印原文、`ls frontend/src/lib/__tests__/__fixtures__/pine_oracle/values | wc -l` 的 60、以及 pytest 那行的 `N passed` 原文一起抄进报告。

- [ ] **Step 7: JS 门——本任务应当零改动**

门是按 `manifest.scripts` 的批次循环的，批次二自动接入，且每批单独 `runScript`（`stoch` 的解构与 `ta.sma` 的 na 传播都在这条批次脚本里跑）。若 `runScript` 报 `编译失败`，那是引擎不支持某条语法（不是数值分歧），按 spec §8 记进 `项目档案.md` 并停下报告，**不许**改脚绕过。

Run: `cd frontend && npx vitest run src/lib/__tests__/pineTaOracle.test.ts`
Expected: `68 passed`（batch_1：1 守卫 + 5 线 = 6；batch_2：1 + 10 = 11；(6+11) × 4 变体 = 68）。以命令输出原文为准。逐条抄 `console.info` 的 `[oracle]` 行（15 条 × 4 变体 = 60 行里的前 4 变体样本 + 全部 `worst=` 读数进报告），并抄 `na=` 一列——批次二的 warm-up 差异正是从这一列读出来的。

- [ ] **Step 8: 分歧裁定（只在有分歧时执行）**

同 Task 4 Step 8：`函数 / 两侧各自的下标或值 / 谁依据哪条公开定义 / 裁定 / 引擎缺陷入 backlog 不改引擎`。**本任务已预登记三处待量**（`rsi` 的首值下标、`stoch_k` 的 bar 0、`macd` 的稠密性）；量出来若与 Step 3 的注释不符，以实测为准并回写 `ENGINE_CONVENTION` 与本文件的 §11——注释不是门，门才是。

- [ ] **Step 9: 提交**

```bash
git add agent/pine_oracle/reference.py agent/pine_oracle/emit_fixtures.py \
        agent/tests/pine_oracle/test_reference_batch2.py agent/tests/pine_oracle/test_pine_oracle_provenance.py \
        frontend/src/lib/__tests__/pineOracleFixtures.ts frontend/src/lib/__tests__/pineTaOracle.test.ts \
        frontend/src/lib/__tests__/__fixtures__/pine_oracle/
git commit -s -m "test(pineOracle): 批次二 rsi/atr/bb/macd/stoch 参考实现＋40 份 values＋四处引擎约定的采纳记录"
```

---

### Task 6: 批次三（supertrend / vwap）＋ 判据一扩到 8 脚本 ＋ 外部锚点取数

**Files:**
- Modify: `agent/pine_oracle/reference.py`（`ST_PERIOD`/`ST_FACTOR`、`ta_supertrend`、`ta_vwap`、`ref_batch_3`、`SCRIPTS["batch_3"]`）
- Modify: `agent/pine_oracle/emit_fixtures.py`（新增 `EXACT_LINES`，tier 三态化；`REFERENCE` 自动带上 batch_3）
- Create: `agent/tests/pine_oracle/test_reference_batch3.py`
- Modify: `agent/tests/pine_oracle/test_pine_oracle_provenance.py`（`convention` 精确名单 4 → 7）
- Modify: `frontend/src/lib/__tests__/pinePrefixInvariance.test.ts`（脚本集 6 → 8，`LINE_COUNT` 加两条）
- Create: `frontend/src/lib/__tests__/__fixtures__/pine_oracle/EXTERNAL_ANCHORS.md`
- Modify: `frontend/src/lib/__tests__/__fixtures__/pine_oracle/values/*.csv`（+12：3 条 line × 4 形态）

**Interfaces:**
- Consumes: `ta_rma`/`ta_tr`（Task 4/5）、`REFERENCE`/`SCRIPTS`（同模块）、`schema.TOLERANCE_TIERS["exact"]`
- Produces:
  - `ta_supertrend(high, low, close, period=ST_PERIOD, multiplier=ST_FACTOR) -> {"supertrend", "st_direction"}`
  - `ta_vwap(price, volume, session: Optional[np.ndarray] = None) -> {"vwap"}`
  - `ref_batch_3(cols, period, session=None) -> dict[str, NanArray]`（恒 3 条 line：`st_direction`、`supertrend`、`vwap`）
  - `emit_fixtures.EXACT_LINES: frozenset[str]`、`ENGINE_CONVENTION` 增至 7 键
  - 判据二终态：**11 个函数 / 18 条 line / 4 形态 = 72 份 values**（`supertrend` 与 `st_direction` 同源一函数、`vwap` 一条；函数计数把 `st_direction` 记在 `supertrend` 名下，`stdev`/`stdev_sample` 记在 `stdev` 名下——Task 7 的 `COVERAGE.md` 按同一口径列）

> **`sar` 不在本任务（spec §11 更正三 / 裁定 R-C）**：它没有单一公开规范——初始化支路、反转日的 `af`/`ep` 重置次序各家实现不同，独立参考实现只能表达「另一种意见」，红了也判不出谁错。所以本任务**不写 `ta_sar`**：一个没有对照物的参考实现只是多一处能被改错的地方。`sar` 由判据一（Task 3 已含 `ta.sar` 脚本，本任务把它推广到「逐 line 比对」的门继续覆盖）单独兜住，并在 Task 7 的 `COVERAGE.md` 里点名这条边界——**边界必须写出来，不写就等于假装 12/12 全覆盖**。

- [ ] **Step 1: 写失败测试（一张手算表走完 TV 的三个支路）**

```python
# agent/tests/pine_oracle/test_reference_batch3.py
"""Batch 3: Supertrend and VWAP, whose semantics are set by published text, not by us.

``supertrend`` is transcribed from TradingView's own Pine body, already committed in
this repo (``frontend/src/lib/__tests__/pineRealWorld.test.ts:65-95``), and the
engine claims the same body as its source (``pineTa.ts:664-673``). Both sides of the
gate therefore descend from one external text: what agreement here proves is that
the fork's transcription is faithful, which is the surface this harness exists to
hold. It does NOT re-prove TV's algorithm, and the report must not claim that.

``sar`` is deliberately absent — see the note above the steps (spec §11 更正三).
"""

import math

import numpy as np
import pytest

from pine_oracle.reference import ref_batch_3, ta_supertrend, ta_vwap

# TV's body has three branches and a ratchet; this five-bar table walks all of them
# with period=1 (so atr == tr, dense from bar 0) and multiplier=1.0 (so every number
# below is doable on a calculator). Derived on paper, bar by bar:
#   high  = [10, 12, 11, 20, 19]
#   low   = [ 8, 10,  9, 11, 10]
#   close = [ 9, 11, 10, 19, 18]
#   tr    = [ 2,  3,  2,  9,  9]      bar 0 collapses to high-low (pineTa.ts:536)
#   hl2   = [ 9, 11, 10, 15.5, 14.5]
#   raw ub/lb = hl2 +/- tr = [11/7, 14/8, 12/8, 24.5/6.5, 23.5/5.5]
#   after the ratchet: ub = [11, 11, 11, 11, 23.5]   lb = [7, 8, 8, 8, 8]
#   direction (TV: -1 is UP) = [1, 1, 1, -1, -1]     line = [11, 11, 11, 8, 8]
H5 = np.array([10.0, 12.0, 11.0, 20.0, 19.0])
L5 = np.array([8.0, 10.0, 9.0, 11.0, 10.0])
C5 = np.array([9.0, 11.0, 10.0, 19.0, 18.0])


def test_supertrend_matches_the_published_body_bar_by_bar() -> None:
    out = ta_supertrend(H5, L5, C5, period=1, multiplier=1.0)
    assert out["supertrend"] == pytest.approx([11.0, 11.0, 11.0, 8.0, 8.0])
    assert out["st_direction"] == pytest.approx([1.0, 1.0, 1.0, -1.0, -1.0])


def test_supertrend_bands_only_ratchet_one_way() -> None:
    """Bar 1's raw upper band is 14.0, but the body keeps the previous 11.0 because
    neither ``ub < prevUb`` nor ``close[1] > prevUb`` holds. A port that assigns the
    raw band gets a line 3.0 too high here and never notices."""
    out = ta_supertrend(H5, L5, C5, period=1, multiplier=1.0)["supertrend"]
    assert out[1] == pytest.approx(11.0)          # not 14.0
    assert out[4] == pytest.approx(8.0)           # lower band held at 8, not raw 5.5


def test_supertrend_cold_start_is_the_downtrend_branch() -> None:
    """``if na(atr[1]) direction := 1`` — the very first bar with a finite ATR takes
    direction +1 (downtrend), so the plotted line is the UPPER band, above price.
    A port that seeds by comparing close to hl2 gives -1 here. ENGINE_CONVENTION."""
    out = ta_supertrend(H5, L5, C5, period=3, multiplier=1.0)
    assert math.isnan(out["supertrend"][0]) and math.isnan(out["supertrend"][1])
    # atr = rma(tr, 3) seeds at index 2 with mean(2, 3, 2) = 7/3, so the line is
    # hl2 + atr = 10 + 7/3 and direction is the cold-start +1.
    assert out["supertrend"][2] == pytest.approx(10.0 + 7.0 / 3.0)
    assert out["st_direction"][2] == pytest.approx(1.0)
    assert out["supertrend"][2] > C5[2]


def test_direction_minus_one_is_the_uptrend_not_the_folklore_one() -> None:
    """TV's body: ``direction := close > upperBand ? -1 : 1`` and
    ``superTrend := direction == -1 ? lowerBand : upperBand``. So -1 means up and the
    line sits BELOW price. The widespread "+1 = up" reading is inverted; adopting
    Pine's sign is recorded in ENGINE_CONVENTION["st_direction"]."""
    out = ta_supertrend(H5, L5, C5, period=1, multiplier=1.0)
    assert out["st_direction"][4] == pytest.approx(-1.0)
    assert out["supertrend"][4] < C5[4]                      # 8.0 < 18.0: band below price


def test_vwap_unanchored_is_the_running_ratio_over_the_whole_range() -> None:
    price = np.array([1.0, 2.0, 3.0, 4.0])
    vol = np.array([1.0, 1.0, 1.0, 1.0])
    assert ta_vwap(price, vol)["vwap"] == pytest.approx([1.0, 1.5, 2.0, 2.5])


def test_vwap_session_argument_reanchors_and_is_not_the_engines_reading() -> None:
    """Two facts in one test: the reference CAN express TradingView's session
    anchoring, and that form is NOT what the gate compares — the engine takes no
    session argument and accumulates over the loaded range (pineTa.ts:960-971), so
    ``ref_batch_3`` passes ``None``. The difference at bar 2 is the backlog item."""
    price = np.array([1.0, 2.0, 3.0, 4.0])
    vol = np.array([1.0, 1.0, 1.0, 1.0])
    session = np.array([1, 1, 2, 2])
    anchored = ta_vwap(price, vol, session)["vwap"]
    assert anchored == pytest.approx([1.0, 1.5, 3.0, 3.5])
    assert anchored[2] == pytest.approx(3.0)                 # restarts at its own bar
    assert ta_vwap(price, vol)["vwap"][2] == pytest.approx(2.0)   # engine's reading


def test_vwap_zero_volume_is_na_not_a_division_by_zero() -> None:
    """Engine: ``return st.v === 0 ? NA : st.pv / st.v`` (pineTa.ts:969)."""
    out = ta_vwap(np.array([1.0, 2.0]), np.array([0.0, 0.0]))["vwap"]
    assert np.all(np.isnan(out))


def test_ref_batch_3_ignores_the_session_column_by_design() -> None:
    """Feeding the session column to the reference while the engine ignores it would
    compare two different functions and call the difference a pass. The batch must
    therefore be byte-identical with and without the column."""
    cols = {"open": C5, "high": H5, "low": L5, "close": C5, "volume": np.array([1.0] * 5)}
    with_session = ref_batch_3(cols, 5, np.array([1, 1, 2, 2, 2]))
    without = ref_batch_3(cols, 5, None)
    assert set(with_session) == {"st_direction", "supertrend", "vwap"}
    for key, arr in with_session.items():
        assert np.array_equal(arr, without[key], equal_nan=True), key
```

- [ ] **Step 2: 跑到失败**

Run: `python -X utf8 -m pytest agent/tests/pine_oracle/test_reference_batch3.py -q`
Expected: `ImportError: cannot import name 'ta_supertrend' from 'pine_oracle.reference'`（collection error，不是 pass 也不是 skip）

- [ ] **Step 3: 实现（追加进 `reference.py`）**

```python
#: Supertrend's published parameters — TV's body inputs ``atrPeriod = 10``,
#: ``factor = 3.0``, and Pine's two-argument form takes them as (factor, atrPeriod).
#: Consumed by BOTH ``ref_batch_3`` and SCRIPTS["batch_3"] like every other length.
ST_PERIOD = 10
ST_FACTOR = 3.0


def ta_supertrend(
    high: np.ndarray,
    low: np.ndarray,
    close: np.ndarray,
    period: int = ST_PERIOD,
    multiplier: float = ST_FACTOR,
) -> dict[str, NanArray]:
    """Transcribed from TradingView's published Pine body, not from the engine.

    Three things a naive port gets wrong, each named by a test above:
      - the trend state is keyed on ``prevSuperTrend == prevUpperBand``, not a boolean
        flag, and the flip test uses *this* bar's close against the *ratcheted* band;
      - the cold start is ``if na(atr[1]) direction := 1``, not "compare close to hl2";
      - ``-1`` is the uptrend (line = lower band).

    The body wraps the previous bands in ``nz()``, which makes the first bar's ratchet
    a no-op for positive prices; the NaN guard below reproduces that. The equivalence
    holds only while prices stay positive — every bar fixture does, by construction.
    """
    src = (np.asarray(high, dtype="float64") + np.asarray(low, dtype="float64")) / 2.0
    close = np.asarray(close, dtype="float64")
    atr_ = ta_rma(ta_tr(high, low, close), period)
    n = close.shape[0]
    upper = np.full(n, np.nan)
    lower = np.full(n, np.nan)
    line = np.full(n, np.nan)
    direction = np.full(n, np.nan)
    prev_line = np.nan
    for i in range(n):
        if np.isnan(atr_[i]):
            continue                       # the body returns [na, na] before ATR warms up
        ub = float(src[i]) + float(multiplier) * float(atr_[i])
        lb = float(src[i]) - float(multiplier) * float(atr_[i])
        prev_ub = float(upper[i - 1]) if i > 0 and not np.isnan(upper[i - 1]) else np.nan
        prev_lb = float(lower[i - 1]) if i > 0 and not np.isnan(lower[i - 1]) else np.nan
        prev_close = float(close[i - 1]) if i > 0 else np.nan
        if not np.isnan(prev_ub) and not (ub < prev_ub or prev_close > prev_ub):
            ub = prev_ub
        if not np.isnan(prev_lb) and not (lb > prev_lb or prev_close < prev_lb):
            lb = prev_lb
        upper[i], lower[i] = ub, lb
        prev_atr = float(atr_[i - 1]) if i > 0 else np.nan
        if np.isnan(prev_atr):
            d = 1.0
        elif prev_line == prev_ub:
            d = -1.0 if close[i] > ub else 1.0
        else:
            d = 1.0 if close[i] < lb else -1.0
        direction[i] = d
        prev_line = lb if d == -1.0 else ub
        line[i] = prev_line
    return {"supertrend": line, "st_direction": direction}


def ta_vwap(
    price: np.ndarray, volume: np.ndarray, session: Optional[np.ndarray] = None
) -> dict[str, NanArray]:
    """Running ``sum(price*volume) / sum(volume)`` — unanchored unless a session is given.

    ``session=None`` is the reading the gate uses, because the engine's ``ta.vwap``
    takes no session argument and accumulates over the whole loaded range
    (``pineTa.ts:960-971``, whose own comment notes the TV difference as a warning).
    Passing a session column re-anchors at each change — TradingView's behaviour, and
    the known deviation COVERAGE.md lists as a backlog item rather than a passing gate.
    """
    price = np.asarray(price, dtype="float64")
    volume = np.asarray(volume, dtype="float64")
    out = np.full(price.shape, np.nan)
    cur: Optional[int] = None
    num = den = 0.0
    for i in range(price.shape[0]):
        s = 0 if session is None else int(session[i])
        if s != cur:
            cur, num, den = s, 0.0, 0.0
        if not np.isnan(price[i]):
            num += float(price[i]) * float(volume[i])
            den += float(volume[i])
        out[i] = num / den if den != 0.0 else np.nan
    return {"vwap": out}


def ref_batch_3(
    cols: dict[str, NanArray], period: int, session: Optional[np.ndarray] = None
) -> dict[str, NanArray]:
    """Three lines, same Pine call signature on all four bar shapes.

    ``session`` is accepted and ignored on purpose (see ``ta_vwap`` and the batch-3
    test): the engine reads no session parameter, so honouring it here would compare
    a different function to the engine and call the gap a pass. ``period`` (the
    harness-wide ``PERIOD``) is likewise not Supertrend's length — TV's published
    inputs are ``ST_PERIOD``/``ST_FACTOR``, and the Pine text below passes those same
    constants, so no length can disagree between the two sides.
    """
    out = ta_supertrend(cols["high"], cols["low"], cols["close"], ST_PERIOD, ST_FACTOR)
    hlc3 = (cols["high"] + cols["low"] + cols["close"]) / 3.0
    out.update(ta_vwap(hlc3, cols["volume"]))
    return out


REFERENCE["batch_3"] = ref_batch_3
```

Extend `SCRIPTS` — Supertrend's two outputs are read with a destructuring tuple, the
same form the in-repo TV corpus already exercises (`pineRealWorld.test.ts:93`'s
`[stBuiltin, dirBuiltin] = ta.supertrend(factor, atrPeriod)`), and `ta.vwap` with no
argument is the engine's hlc3 reading (`pineTa.ts:962`):

```python
SCRIPTS["batch_3"] = (
    "//@version=5\n"
    'indicator("oracle batch 3")\n'
    f'[stBand, stDir] = ta.supertrend({ST_FACTOR}, {ST_PERIOD})\n'
    'plot(stBand, title="supertrend")\n'
    'plot(stDir, title="st_direction")\n'
    "plot(ta.vwap, title=\"vwap\")\n"
)
```

- [ ] **Step 4: 单元断言到绿**

Run: `python -X utf8 -m pytest agent/tests/pine_oracle/test_reference_batch3.py -q`
Expected: `8 passed`（计划期把本节代码块原样抽出跑过，8 条全绿；表里每个数都在注释里给了推导）。若 `test_supertrend_matches_the_published_body_bar_by_bar` 红，先重算那张表——它是纸面推导，不是从实现读的。

- [ ] **Step 5: 把三处「采纳引擎/TV 约定」登记进 `ENGINE_CONVENTION`，tier 三态化**

```python
ENGINE_CONVENTION.update(
    {
        "supertrend": "cold start takes direction +1 (`if na(atr[1]) direction := 1`) and "
                      "the band ratchet is guarded by nz(), whose no-op only equals a NaN "
                      "guard while prices stay positive (pineTa.ts:700-712, TV body "
                      "pineRealWorld.test.ts:65-95)",
        "st_direction": "-1 is the UPTREND and the plotted line is the lower band; the "
                        "folklore '+1 = up' reading is inverted (pineTa.ts:707-712)",
        "vwap": "accumulates over the whole loaded range and takes no session argument; "
                "TradingView re-anchors each session, and that difference is a backlog "
                "entry in COVERAGE.md rather than a passing gate (pineTa.ts:960-971)",
    }
)

#: Integer-valued outputs: a sign bit has no rounding to forgive, so the strictest
#: tier is the honest one. Tighten-only (spec §5) — nothing may move out of this set.
EXACT_LINES: frozenset[str] = frozenset({"st_direction"})
```

`emit()` 里那一行 tier 判断改为三态（其余不动）：

```python
                tier[line_name] = (
                    "exact"
                    if line_name in EXACT_LINES
                    else "tight"
                    if line_name in TIGHT_LINES
                    else "loose"
                )
```

provenance 的精确名单守卫同步加宽（Task 5 那条断言的右侧集合）：

```python
    assert set(manifest["convention"]) == {
        "ema",
        "macd",
        "rsi",
        "stoch_k",
        "st_direction",
        "supertrend",
        "vwap",
    }
```

并把 `test_every_declared_line_is_strict_and_tiered_from_the_two_allowed_sets` 的「全 strict」保留，新增一句 `exact` 面的读法（防有人把 `st_direction` 挪出 `EXACT_LINES` 又没留痕）：

```python
def test_exact_tier_is_only_for_the_declared_integer_lines() -> None:
    manifest = load_manifest(FIXTURE_DIR / "manifest.json")
    exact = {line for line, t in manifest["tolerance_tier"].items() if t == "exact"}
    assert exact == {"st_direction"}, sorted(exact)
```

Run: `python -X utf8 -m pytest agent/tests/pine_oracle -q`
Expected: `70 passed` = schema 23 ＋ bars 11 ＋ batch_1 7 ＋ batch_2 12 ＋ batch_3 8 ＋ provenance 9。这六个分块读数都是计划期抽跑实测（见文末「计划期实跑」表），执行时仍以命令输出原文为准；差一条也要说清差在哪条，不许改期望凑数。

- [ ] **Step 6: 生成 fixture，核对批次三终态读数**

```bash
PYTHONPATH=agent python -X utf8 -m pine_oracle.emit_fixtures
ls frontend/src/lib/__tests__/__fixtures__/pine_oracle/values | wc -l
```
Expected: 打印 `76 files, 18 lines tiered, batches={'batch_1': 5, 'batch_2': 10, 'batch_3': 3}`（4 bars + 72 values），`values` 下 72 个 CSV。**这是判据二的终态：11 个函数 / 18 条 line / 4 形态 = 72 份 values。** 三条读数的原文抄进报告；`supertrend`/`st_direction`/`vwap` 若在某形态上全列 na（例如 120 根日线仍不够 ATR 热身），那是可读的实测，不是失败——把 na 计数抄下来。

- [ ] **Step 7: 判据一扩到 8 个脚本，并确认逐 line 比对真的在跑**

`pinePrefixInvariance.test.ts` 的 `SCRIPTS` 加两条、`LINE_COUNT` 同步（Task 3 的门已写成「对该脚本的每一条 line 都比」，所以 `supertrend` 的两条输出会自动进比对集）：

```ts
  // Both outputs of one Pine call: the band AND the sign. A repainting sign flip is
  // the failure mode the oracle cannot see (the reference carries the same convention).
  supertrend:
    "//@version=5\nindicator(\"p\")\n[band, dir] = ta.supertrend(3.0, 10)\nplot(band, title=\"supertrend\")\nplot(dir, title=\"st_direction\")",
  // The cumulative branch: appending bars must extend the running sums, not rebase them.
  vwap: "//@version=5\nindicator(\"p\")\nplot(ta.vwap, title=\"vwap\")",
```

```ts
  const LINE_COUNT: Record<string, number> = {
    sma: 1, ema: 1, rma: 1, stdev: 1, stdev_sample: 1, sar: 1, supertrend: 2, vwap: 1,
  };
```

Run: `cd frontend && npx vitest run src/lib/__tests__/pinePrefixInvariance.test.ts`
Expected: `34 passed`（8 脚本 × 4 变体 + 1 条 bar 数守卫 + 1 条 `close[-1]` 下限守卫）。**`sar` 与 `supertrend` 是这条门最可能真红的两处**（状态机 + 反转）：红了停在原样，把最小复现（脚本、变体、N、两侧的值）写进报告并标 DONE_WITH_CONCERNS，**不许**用删脚本或改 `worst` 阈值收场。同时抄 `supertrend` 那条的 `probes` 读数——它现在对两条 line 各探针一次，`probes` 应当相同。

- [ ] **Step 8: 取外部锚点（不许造数）**

用 WebSearch/WebFetch 取 **3–6 条**第三方文档公布的示例数值，逐条写进 `frontend/src/lib/__tests__/__fixtures__/pine_oracle/EXTERNAL_ANCHORS.md`，每行格式：

```
| 断言名 | 数值 | 出处 URL | 取回日期 | 与本项目哪条点值测试同调 |
```

优先级按「本项目已有手算、外部只有一份公布值可对」排：`supertrend` 的方向口径（TV 官方文档/help center 对 `direction` 的定义，或已入仓的 TV 脚本正文——后者是**仓内文本**，标注为仓内出处）、`rsi` 的 `down == 0` 分支、`stdev`/`bb` 的 ddof、`atr` 的 Wilder 播种、`vwap` 的会话锚定（这条是用来记「引擎与 TV 不同」的，不是用来判引擎对错的）。

取不到、或取回的数与本项目公式冲突而无法判定谁对时：**该条不写，并在文件末尾记一行「未取到，已放弃」。** 绝不允许为了满足条数而编。同时 `manifest["external_anchors"]` 每条填 `{name, value, source, retrieved_at}`——**这四个键就是 Task 3 在 `pineOracleFixtures.ts` 里声明的 `OracleAnchor` 的那四个**（JS 门的读法按它来，别在这里另起一套名字）；空数组是诚实读数，不是失败。

- [ ] **Step 9: JS 门接到批次三**

`pineTaOracle.test.ts` 按 `manifest.scripts` 循环，批次三自动接入，无需改代码；`st_direction` 的 `exact` 档位从 manifest 读，不在测试里写死。

Run: `cd frontend && npx vitest run src/lib/__tests__/pineTaOracle.test.ts`
Expected: `84 passed`（(6 + 11 + 4) × 4 变体；batch_3 是 1 条 key-set 守卫 + 3 条 line 对账）。以命令输出原文为准。把 `supertrend`/`st_direction`/`vwap` 三条的 `worst=` 与 `na=` 读数逐条抄进报告——`st_direction` 的 `worst` 必须是 `0`，因为它的档位是 `exact`。若 `vwap` 在日线上与引擎有差，先核对参考实现是否误用了 `session`（本任务的答案是不该用），再走裁定。

- [ ] **Step 10: 分歧裁定（只在有分歧时执行）**

同 Task 4 Step 8 的表格。**本任务预登记三处待量**：`supertrend` 的冷启动支路、`st_direction` 的符号、`vwap` 的锚定范围。量出来若与 Step 3 的注释不符，以实测为准并回写 `ENGINE_CONVENTION` 与 spec §11——注释不是门，门才是。

- [ ] **Step 11: 提交**

```bash
git add agent/pine_oracle/reference.py agent/pine_oracle/emit_fixtures.py \
        agent/tests/pine_oracle/test_reference_batch3.py \
        agent/tests/pine_oracle/test_pine_oracle_provenance.py \
        frontend/src/lib/__tests__/pinePrefixInvariance.test.ts \
        frontend/src/lib/__tests__/__fixtures__/pine_oracle/
git -c core.quotepath=false status --porcelain
git commit -s -m "test(pineOracle): 批次三 supertrend/vwap 参考实现＋判据一扩到 8 脚本＋外部锚点取证"
```

`git -c core.quotepath=false status --porcelain` 必须显示干净（fixture 目录整体是新文件，`git add` 目录会把 `EXTERNAL_ANCHORS.md` 与 72 份 values 一并带上）；不干净就报出未纳入的路径再决定，不许 `-f` 绕过判断。

---

### Task 7: 覆盖台账、只准调严守卫与 backlog 名单

**Files:**
- Create: `agent/pine_oracle/coverage.py`（覆盖名单的唯一定义处）
- Create: `agent/pine_oracle/emit_coverage.py`（生成器，`python -m` 跑）
- Create: `agent/tests/pine_oracle/test_coverage_ledger.py`
- Create: `frontend/src/lib/__tests__/__fixtures__/pine_oracle/COVERAGE.md`（由生成器写，12 已覆盖 / 62 待补）
- Modify: `agent/tests/pine_oracle/test_pine_oracle_provenance.py`（档位只准调严 ＋ 豁免审计两条守卫）

**Interfaces:**
- Consumes: `pine_oracle.schema` 的 `REPO_ROOT`/`FIXTURE_DIR`/`load_manifest`/`write_text_lf`；`pineTa.ts` 的分派表键（**74** 个，实测方式：`grep -oE "^  [a-z_][a-z_0-9]*: \(args" frontend/src/lib/pineTa.ts | wc -l`，@2a50023d 与 2026-10-04 计划期各测一次都是 74）；`manifest.json` 的 `scripts`/`tolerance_tier`/`convention`；`pinePrefixInvariance.test.ts` 的 `LINE_COUNT` 键集合
- Produces: `coverage.GATE2_FUNCTIONS`（11）、`coverage.GATE1_ONLY`（`{"sar"}`）、`coverage.COVERED`（12）、`coverage.GATE1_SCRIPTS`（8）、`coverage.FUNCTION_LINES`（11 → 18）、`coverage.builtins_from_source`、`coverage.gate1_script_keys_from_ts`

- [ ] **Step 1: 写名单模块 `agent/pine_oracle/coverage.py`**

名单只写一处：机器门（Step 2）与台账文档（Step 3）都从这里取。两份各列一份就是本项目反复抓的那种「改一处忘另一处」的静默漂移。

```python
"""The coverage ledger's own vocabulary: which ``ta.*`` a gate really touches.

Two artefacts read these sets — ``test_coverage_ledger.py`` (the machine gate) and
``emit_coverage.py`` (the human list). One definition is what keeps them from
drifting apart; a ledger that claims more than the gate checks is the failure mode
this whole harness was built to catch.

Nothing here is derived from the engine's *numbers*. ``builtins_from_source`` parses
the engine's dispatch table so a newly added ``ta.*`` shows up as a coverage gap
instead of as silence — the same rule the JS gate applies to its probe count.
"""

from __future__ import annotations

import re

#: The 11 functions whose reference values gate 2 (the oracle) prices against.
GATE2_FUNCTIONS: frozenset[str] = frozenset(
    {
        "sma",
        "ema",
        "rma",
        "stdev",
        "rsi",
        "atr",
        "bb",
        "macd",
        "stoch",
        "supertrend",
        "vwap",
    }
)

#: Functions gate 1 proves but gate 2 does NOT price.
#: ``sar``: a Parabolic SAR reference in numpy has to re-implement the reversal and
#: acceleration state machine, and a "reference" that transcribes the code under test
#: adds another place to be wrong rather than a second witness. Prefix invariance is
#: the claim that needs no cross-implementation oracle, so ``sar`` carries gate 1
#: alone — and the ledger must say so out loud (spec §11 R-C).
GATE1_ONLY: frozenset[str] = frozenset({"sar"})

#: Everything this round touches, gate 2 or gate 1.
COVERED: frozenset[str] = GATE2_FUNCTIONS | GATE1_ONLY

#: The eight script keys in ``pinePrefixInvariance.test.ts``. ``stdev_sample`` is the
#: sample branch (``ta.stdev(..., false)``) of the same builtin, so it is a script,
#: not a function — the branch map below is the only place that says so.
GATE1_SCRIPTS: frozenset[str] = frozenset(
    {"sma", "ema", "rma", "stdev", "stdev_sample", "sar", "supertrend", "vwap"}
)
SCRIPT_TO_FUNCTION: dict[str, str] = {"stdev_sample": "stdev"}

#: Each gate-2 function's plotted line names, as they appear in ``manifest.json``.
#: Written out (not derived by splitting on ``_``) because ``st_direction`` belongs to
#: ``supertrend`` and no prefix rule sees that.
FUNCTION_LINES: dict[str, tuple[str, ...]] = {
    "sma": ("sma",),
    "ema": ("ema",),
    "rma": ("rma",),
    "stdev": ("stdev", "stdev_sample"),
    "rsi": ("rsi",),
    "atr": ("atr",),
    "bb": ("bb_basis", "bb_upper", "bb_lower"),
    "macd": ("macd", "macd_signal", "macd_hist"),
    "stoch": ("stoch_k", "stoch_d"),
    "supertrend": ("supertrend", "st_direction"),
    "vwap": ("vwap",),
}

_BUILTIN_RE = re.compile(r"^  ([a-z_][a-z_0-9]*): \(args", re.M)
_LINE_COUNT_RE = re.compile(r"const LINE_COUNT: Record<string, number> = \{([^}]*)\}", re.S)
_KEY_RE = re.compile(r"([a-z_][a-z_0-9]*):")


def builtins_from_source(ts_text: str) -> frozenset[str]:
    """Every ``ta.*`` name in the engine's dispatch table."""
    return frozenset(_BUILTIN_RE.findall(ts_text))


def gate1_script_keys_from_ts(ts_text: str) -> frozenset[str]:
    """The script names the prefix-invariance gate actually loops over.

    Read from ``LINE_COUNT``, because that map is what the gate asserts its line
    count against: a script deleted from ``SCRIPTS`` without deleting its entry here
    is the hole this closes.
    """
    found = _LINE_COUNT_RE.search(ts_text)
    if found is None:
        raise ValueError("pinePrefixInvariance.test.ts: no LINE_COUNT map to read")
    return frozenset(_KEY_RE.findall(found.group(1)))


def gate1_functions() -> frozenset[str]:
    """The functions gate 1 touches, with script branches folded onto their builtin."""
    return frozenset(SCRIPT_TO_FUNCTION.get(name, name) for name in GATE1_SCRIPTS)
```

- [ ] **Step 2: 写守卫测试 `agent/tests/pine_oracle/test_coverage_ledger.py`**

```python
# agent/tests/pine_oracle/test_coverage_ledger.py
"""The covered/backlog split is recomputed from the engine and the fixtures.

74 is a measured number (``grep -oE "^  [a-z_][a-z_0-9]*: \\(args"
frontend/src/lib/pineTa.ts | wc -l`` at @2a50023d), not a constant to be trusted.
Every path below goes through ``schema.REPO_ROOT``/``FIXTURE_DIR``: the previous
task's dry-run proved that a cwd-relative path in a gate is a gate that reads a
missing directory as "no data".
"""

import re

import pytest

from pine_oracle.coverage import (
    COVERED,
    FUNCTION_LINES,
    GATE1_ONLY,
    GATE1_SCRIPTS,
    GATE2_FUNCTIONS,
    builtins_from_source,
    gate1_functions,
    gate1_script_keys_from_ts,
)
from pine_oracle.schema import FIXTURE_DIR, REPO_ROOT, load_manifest

PINE_TA = REPO_ROOT / "frontend" / "src" / "lib" / "pineTa.ts"
PREFIX_GATE = REPO_ROOT / "frontend" / "src" / "lib" / "__tests__" / "pinePrefixInvariance.test.ts"
COVERAGE_DOC = FIXTURE_DIR / "COVERAGE.md"


@pytest.fixture(scope="module")
def builtins() -> frozenset[str]:
    return builtins_from_source(PINE_TA.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def manifest() -> dict:
    return load_manifest(FIXTURE_DIR / "manifest.json")


def test_the_dispatch_table_still_has_74_builtins(builtins: frozenset[str]) -> None:
    assert len(builtins) == 74, sorted(builtins)


def test_the_ledger_names_are_real_and_disjoint(builtins: frozenset[str]) -> None:
    assert COVERED <= builtins, COVERED - builtins
    assert GATE1_ONLY & GATE2_FUNCTIONS == frozenset()
    assert len(COVERED) == len(GATE2_FUNCTIONS) + len(GATE1_ONLY) == 12


def test_function_lines_are_exactly_the_manifest_lines(manifest: dict) -> None:
    """The ledger's per-function line list is the fixture's line list — a batch line
    with no owning function (or a function with no line) is a naming drift."""
    assert set(FUNCTION_LINES) == GATE2_FUNCTIONS
    lines = frozenset(line for names in FUNCTION_LINES.values() for line in names)
    assert lines == frozenset(manifest["tolerance_tier"]), lines ^ frozenset(manifest["tolerance_tier"])
    assert len(lines) == 18


def test_gate_2_priced_exactly_the_registered_functions(manifest: dict) -> None:
    """Every name counted as gate-2-covered must actually appear as a ``ta.`` call in
    the emitted Pine sources, and nothing else may. This is what makes ``sar``'s
    exclusion a statement about the fixtures rather than about a list."""
    called = frozenset(re.findall(r"ta\.([a-z_][a-z_0-9]*)", "\n".join(manifest["scripts"].values())))
    assert called == GATE2_FUNCTIONS, (called - GATE2_FUNCTIONS, GATE2_FUNCTIONS - called)
    assert "sar" not in called


def test_gate_1_loops_exactly_the_ledger_scripts() -> None:
    ts = PREFIX_GATE.read_text(encoding="utf-8")
    assert gate1_script_keys_from_ts(ts) == GATE1_SCRIPTS
    assert gate1_functions() <= COVERED
    assert "sar" in gate1_functions(), "sar 只由判据一兜住，它必须真的在这条门的脚本表里"


def test_the_backlog_is_written_and_matches_the_gap(builtins: frozenset[str]) -> None:
    doc = COVERAGE_DOC.read_text(encoding="utf-8")
    gap = builtins - COVERED
    # a row, not a mention: the table form is what makes an empty set impossible
    for name in sorted(gap):
        assert f"| `{name}` |" in doc, name
    assert len(gap) == len(builtins) - len(COVERED) == 62


def test_the_covered_table_marks_each_gate_for_each_function(builtins: frozenset[str]) -> None:
    doc = COVERAGE_DOC.read_text(encoding="utf-8")
    g1 = gate1_functions()
    for name in sorted(COVERED):
        row = next((line for line in doc.splitlines() if line.startswith(f"| `{name}` |")), None)
        assert row is not None, name
        gate_1, gate_2 = row.split("|")[2].strip(), row.split("|")[3].strip()
        assert gate_1 == ("✓" if name in g1 else "✗"), row
        assert (gate_2.startswith("✓") if name in GATE2_FUNCTIONS else gate_2.startswith("✗")), row


def test_the_vwap_session_deviation_is_written_as_backlog_not_a_pass() -> None:
    """The engine has no session re-anchoring, so TV and this harness differ for real.
    Recording that in a gate that passes would launder a known deviation into a
    green tick; the ledger has to carry the words."""
    doc = COVERAGE_DOC.read_text(encoding="utf-8")
    assert re.search(r"vwap[^\n]*会话锚定", doc), "vwap 的会话锚定偏离必须写在台账里"
```

- [ ] **Step 3: 写生成器 `agent/pine_oracle/emit_coverage.py`**

```python
# agent/pine_oracle/emit_coverage.py
"""Generate ``COVERAGE.md`` — the human-readable half of the coverage ledger.

Every table is computed from what the machine gate already reads (the engine's
dispatch table and ``manifest.json``), so the document cannot claim a coverage state
the gate disagrees with. Run from the repo root:

    PYTHONPATH=agent python -X utf8 -m pine_oracle.emit_coverage
"""

from __future__ import annotations

from pine_oracle.coverage import (
    COVERED,
    FUNCTION_LINES,
    GATE1_ONLY,
    GATE2_FUNCTIONS,
    builtins_from_source,
    gate1_functions,
)
from pine_oracle.schema import FIXTURE_DIR, REPO_ROOT, load_manifest, write_text_lf

PINE_TA = REPO_ROOT / "frontend" / "src" / "lib" / "pineTa.ts"
OUT = FIXTURE_DIR / "COVERAGE.md"


def main() -> None:
    text = PINE_TA.read_text(encoding="utf-8")
    lines = text.splitlines()
    manifest = load_manifest(FIXTURE_DIR / "manifest.json")
    builtins = builtins_from_source(text)
    g1 = gate1_functions()

    def row_line(name: str) -> int:
        prefix = f"  {name}: (args"
        return next(i for i, line in enumerate(lines, 1) if line.startswith(prefix))

    out: list[str] = [
        "# oracle 覆盖台账",
        "",
        "判据一 = 前缀不变式（`frontend/src/lib/__tests__/pinePrefixInvariance.test.ts`）——"
        "信号不重绘。判据二 = 跨实现数值对账（`pineTaOracle.test.ts` 读 `values/`）——"
        "每条 line 与 Python 参考实现逐位对账。",
        "",
        f"名单与档位由 `agent/pine_oracle/coverage.py` 和 `manifest.json` 生成"
        f"（`PYTHONPATH=agent python -X utf8 -m pine_oracle.emit_coverage`），**不要手改本文件**。",
        "",
        "行号取自 `pineTa.ts` 的当前工作树（"
        f"head `{manifest['head_sha']}`，共 {len(builtins)} 个 `ta.*` 分派键），只作定位用。",
        "",
        f"## 已覆盖（{len(COVERED)} / {len(builtins)}）",
        "",
        "| ta.* | 判据一 | 判据二 | manifest line | 备注 |",
        "|---|---|---|---|---|",
    ]
    for name in sorted(COVERED):
        if name in FUNCTION_LINES:
            gate_2 = "✓"
            line_names = "`" + "`, `".join(FUNCTION_LINES[name]) + "`"
        else:
            gate_2, line_names = "✗（R-C）", "—"
        note = ""
        if name in GATE1_ONLY:
            note = "只由判据一兜住：numpy 里的 SAR 参考实现等于把被测代码抄一遍，不是第二证人（spec §11 R-C）"
        elif name == "vwap":
            note = "无会话锚定，见下方「已知偏离」"
        out.append(
            f"| `{name}` | {'✓' if name in g1 else '✗'} | {gate_2} | {line_names} | {note} |"
        )

    out += [
        "",
        f"## 采纳引擎／TV 约定（{len(manifest['convention'])} 处，逐字取自 manifest 的 `convention`）",
        "",
        "每一行都是「参考实现刻意跟着引擎约定走」的记录：**它让判据二可跑，但它本身不是判据二的证据**——"
        "这些约定的独立正证是各自的手算点值测试与外部锚点。",
        "",
        "| line | 采纳了什么、另一套约定会给什么（含源码坐标） |",
        "|---|---|",
    ]
    for line in sorted(manifest["convention"]):
        out.append(f"| `{line}` | {manifest['convention'][line]} |")

    out += [
        "",
        "## 已知偏离，记为 backlog 而不是通过的门",
        "",
        "- `vwap`：引擎按整段加载区间累积 hlc3×volume，不接受 session 参；"
        "TradingView 每个会话重新锚定累计量。本项目**不**把这条当成已通过——"
        "参考实现照引擎的口径写（`ref_batch_3` 收下并忽略 `session` 列），"
        "会话锚定的缺失留作功能 backlog。",
        "- `sar`：判据二不覆盖，理由见上表的备注行。",
        "",
        "## 待补 backlog（按字母序）",
        "",
        "| ta.* | 引擎表行号 |",
        "|---|---|",
    ]
    for name in sorted(builtins - COVERED):
        out.append(f"| `{name}` | `{row_line(name)}` |")

    body = "\n".join(out) + "\n"
    write_text_lf(OUT, body)
    print(
        f"{len(builtins)} builtins, {len(COVERED)} covered, "
        f"{len(builtins) - len(COVERED)} open, {len(manifest['convention'])} conventions"
    )


if __name__ == "__main__":
    main()
```

Run: `PYTHONPATH=agent python -X utf8 -m pine_oracle.emit_coverage`
Expected: 打印 `74 builtins, 12 covered, 62 open, 7 conventions`。四个数都抄进报告，且必须与 Step 2 的断言一致；`open` 的 62 行逐行落在文档表二里。

- [ ] **Step 4: 加「只准调严」与豁免审计两条守卫**

在 `agent/tests/pine_oracle/test_pine_oracle_provenance.py` 追加：

```python
#: The loosest tier each line has ever been measured to satisfy. A tolerance is a
#: promise, not a knob: tightening is free, loosening needs a written ruling in
#: 项目档案.md and an explicit edit to this table (the gate below refuses otherwise).
#: These 18 values are the readings taken when the fixtures were first generated —
#: they are not aspirations.
TIER_FLOOR: dict[str, str] = {
    "sma": "tight",
    "ema": "loose",
    "rma": "loose",
    "stdev": "tight",
    "stdev_sample": "tight",
    "rsi": "loose",
    "atr": "loose",
    "bb_basis": "tight",
    "bb_upper": "tight",
    "bb_lower": "tight",
    "macd": "loose",
    "macd_signal": "loose",
    "macd_hist": "loose",
    "stoch_k": "loose",
    "stoch_d": "loose",
    "supertrend": "loose",
    "st_direction": "exact",
    "vwap": "loose",
}
TIER_ORDER: dict[str, int] = {"exact": 0, "tight": 1, "loose": 2}


def test_no_line_is_looser_than_the_tier_it_was_measured_at() -> None:
    manifest = load_manifest(FIXTURE_DIR / "manifest.json")
    tiers = manifest["tolerance_tier"]
    # the floor table covers every line, so a new batch line cannot dodge the gate
    assert set(TIER_FLOOR) == set(tiers), set(TIER_FLOOR) ^ set(tiers)
    for line, floor in TIER_FLOOR.items():
        assert TIER_ORDER[tiers[line]] <= TIER_ORDER[floor], (line, tiers[line], floor)


def test_no_line_may_be_exempted_out_of_strict_without_an_audit_trail() -> None:
    manifest = load_manifest(FIXTURE_DIR / "manifest.json")
    non_strict = {k: v for k, v in manifest["exemption"].items() if v != "strict"}
    assert non_strict == {}, (
        "把任何线挪出 strict 之前，必须在 项目档案.md 留下裁定行并在这里点名它："
        f"{non_strict}"
    )
```

Run: `python -X utf8 -m pytest agent/tests/pine_oracle -q`（**在仓库根跑**）
Expected: 全绿。条数报实际值（Task 1–7 累计），计划期抽跑实测 `80 passed`，分解为 schema 23 ＋ bars 11 ＋ batch_1 7 ＋ batch_2 12 ＋ batch_3 8 ＋ provenance 11（Task 4 的 6 ＋ Task 5 的 2 ＋ Task 6 的 1 ＋ 本任务的 2）＋ ledger 8。**执行时以命令输出原文为准**，差一条要说清差在哪条，不许改期望凑数。

- [ ] **Step 5: 提交**

```bash
git add agent/pine_oracle/coverage.py agent/pine_oracle/emit_coverage.py \
        agent/tests/pine_oracle/test_coverage_ledger.py \
        agent/tests/pine_oracle/test_pine_oracle_provenance.py \
        frontend/src/lib/__tests__/__fixtures__/pine_oracle/COVERAGE.md
git -c core.quotepath=false status --porcelain
git commit -s -m "test(pineOracle): 覆盖台账 12/74（判据一 8 脚本 × 判据二 11 函数）＋backlog 62 行＋容差只准调严与豁免审计守卫"
```

---

### Task 8: 收口——双端全量实跑、DoD 九条、档案落档、集成菜单

**Files:**
- Modify: `项目档案.md`（尾部追加本轮收口条目，CR 计数保持 0）

**Interfaces:**
- Consumes: Task 1–7 的全部产物
- Produces: 一份九条 DoD 的实测读数 + 集成菜单（控制器持有，不下发给实现者）

- [ ] **Step 1: fixture 缺失必红（防「空集合真空通过」）**

本步骤会临时移走**已被 git 跟踪**的 fixture 目录，所以先做一份仓库外的副本再动手，并在结尾用 `git status` 证明工作树回到了原样。所有目录切换都用子 shell `( cd … && … )`，命令行本身不依赖上一条命令留下的 cwd。

```bash
# ① 先备份（/tmp 在 Git Bash 里真实可写；这一步不是可选的保险，是还原路径）
cp -r frontend/src/lib/__tests__/__fixtures__/pine_oracle /tmp/pine_oracle_backup

# ② 藏起 fixture，跑两条门：必须红，且不能是 skip
(cd frontend && mv src/lib/__tests__/__fixtures__/pine_oracle src/lib/__tests__/__fixtures__/pine_oracle_hidden;\
 npx vitest run src/lib/__tests__/pineTaOracle.test.ts src/lib/__tests__/pinePrefixInvariance.test.ts; echo "rc=$?")

# ③ 还原：mv 回来；若 mv 失败就从 ① 的副本拷回
(cd frontend/src/lib/__tests__/__fixtures && mv pine_oracle_hidden pine_oracle) \
  || cp -r /tmp/pine_oracle_backup/. frontend/src/lib/__tests__/__fixtures__/pine_oracle

# ④ 全绿复跑 ＋ 工作树自证
(cd frontend && npx vitest run src/lib/__tests__/pineTaOracle.test.ts src/lib/__tests__/pinePrefixInvariance.test.ts; echo "rc=$?")
git status --porcelain -- frontend/src/lib/__tests__/__fixtures__/pine_oracle; echo "status_rc=$?"
```
Expected: 第一次 `rc` 非 0 且**不是 skip**（报告里抄出实际 failed 数与一条报错原文）；第二次 `rc=0`；④ 的 `git status --porcelain` **必须一行都不输出**（有输出说明还原不完整，先修好再继续，别往下提交）。两次 `rc` 读数都要有。

- [ ] **Step 2: oracle 可红性——改一位十进制必须被 provenance 门抓到**

一条自包含的探针：**唯一 needle**（该行在文件里只出现一次，否则中止）、`finally` 里按字节还原并当场验证字节相同、前后各取一次 LF 归一化 sha。禁止用 `git checkout --` 还原（脏树上禁用，已入账）。

```bash
PYTHONPATH=agent python -X utf8 - <<'PY'
import subprocess, sys
from pine_oracle.schema import FIXTURE_DIR, REPO_ROOT, canonical_bytes, sha256_of

TARGET = FIXTURE_DIR / "values" / "sma@bars_daily_trend.csv"
original = TARGET.read_bytes()
before = sha256_of(TARGET)
rows = original.decode("utf-8").splitlines()

# needle: the first data row with a real number; its whole line must be unique.
hit = next((i for i, line in enumerate(rows) if i and line.count(",") == 1 and line.split(",")[1]), None)
if hit is None:
    raise SystemExit("no non-na row to perturb — the probe would prove nothing")
bar_index, value = rows[hit].split(",")
if sum(1 for line in rows if line == f"{bar_index},{value}") != 1:
    raise SystemExit(f"needle not unique: {bar_index},{value}")
rows[hit] = f"{bar_index},{float(value) * 1.0000001!r}"
TARGET.write_bytes(canonical_bytes("\n".join(rows) + "\n"))
print(f"needle: row {hit} {value} -> {rows[hit].split(',')[1]}")
print("before sha", before[:12], "| broken sha", sha256_of(TARGET)[:12])
try:
    proc = subprocess.run(
        [sys.executable, "-X", "utf8", "-m", "pytest",
         "agent/tests/pine_oracle/test_pine_oracle_provenance.py", "-q"],
        cwd=REPO_ROOT, capture_output=True, text=True,
    )
    print("rc =", proc.returncode)
    print("\n".join(proc.stdout.splitlines()[-14:]))
finally:
    TARGET.write_bytes(original)
    restored = TARGET.read_bytes() == original
    print("restored byte-identical:", restored, "| after sha", sha256_of(TARGET)[:12])
PY
```
Expected: `rc` 非 0；红的那两条是 `test_manifest_lists_every_committed_data_file`（清单里的 sha 对不上）与 `test_regenerated_files_are_bytewise_identical`（重算的字节 ≠ 提交的字节）——报告里抄出这两条的名字与实际 failed 数。三个 sha（before / broken / after）与 `restored byte-identical: True` 一并抄进报告；`before` 与 `after` 必须逐字相同，否则本步判失败。若红的是**别的**用例，说明这位篡改绕过了一道你以为存在的门——那是发现，写进报告而不是改探针。

计划期已把这段探针原样跑过一遍（仓库外抽出树，见文末「计划期实跑」）：`needle: row 5 20.3841954 -> 20.38419743841954`、`before sha 75245ea58c7f / broken sha bdab57c0e9c3`、`rc = 1`、`2 failed, 9 passed`（红的正是上面点名的两条）、`restored byte-identical: True`、`after sha 75245ea58c7f`（与 before 逐字相同）。**执行时仍以自己那一次的输出为准**——sha 会随 fixture 重生成而变，变的只该是数值，不是「两条红」这个形状。

- [ ] **Step 3: Python 全量**

```bash
python -X utf8 -m pytest -q -rs
```
Expected: 全绿之外要报实际数。**基线坐标必须先抄**：`git rev-parse --short HEAD` 与本轮 Task 1 开工前记录的 `N passed / K skipped`；本轮新增的期望增量是 `+80`（`agent/tests/pine_oracle/` 的七个文件，计划期抽跑实测 80 passed），**新增红必须为 0**。`-rs` 的 skip 理由清单要逐条抄进报告——同步轮 R-42 教训：passed→skipped 的漂移在这种全量跑里是静默的，只有 skip 理由清单能看见它。若增量不等于 80，说明新目录没被 `testpaths`（根 `pyproject.toml:276`）收到，或有用例被 deselect——先查收集体，别改期望。

- [ ] **Step 4: 前端全量**

```bash
(cd frontend && npm run test:run)
```
Expected: 全绿；把 `Test Files / Tests` 两行原文抄进报告，并与本轮开工前记录的同一读数相减——增量应当正好是本轮新增的两个 JS 门文件（判据一 33 ＋ 判据二 84，均按 `it`/变体展开后的实际条数报，**以输出原文为准**）。

- [ ] **Step 5: 上游归属面与两条收集面自检**

```bash
python -X utf8 -m pytest tools/test_wiki_drift.py -q -k upstream_owned
git -c core.quotepath=false diff --name-only main...HEAD | sort
git check-ignore -v frontend/src/lib/__tests__/__fixtures__/pine_oracle/manifest.json; echo "rc=$?"
grep -n "pytest\|pip install" .github/workflows/repowiki-freshness.yml
```
Expected: 前者 `1 passed`（其余 deselected；计划期实测 `1 passed, 229 deselected in 0.33s`，`tools/test_wiki_drift.py:2837` 的 `test_no_fork_commit_touches_an_upstream_owned_file`）；第二行的每一行都落在 Global Constraints 的白名单内，**若有白名单外路径，本任务判失败，回退那笔改动**；第三行 `rc=1` —— `git check-ignore` 命中规则才返回 0 并打印规则，`1` 意味着没有任何 ignore 规则吃掉这个路径（`frontend/.gitignore:9-10` 只点名 `corpus/` 与 `corpus-v6/`，计划期实测 rc=1），所以 fixture 是默认可入库的一族；若这里读出 `rc=0`，前面的 `git add` 全是静默空操作，先查是谁加了 ignore 规则。第四行要看到两处：`:65-67` 只 `pip install pytest`，`:85` 的套件命令**点名单个文件** `tools/test_wiki_drift.py`——显式参数让 `testpaths` 失效，所以 fork 自有工作流永远不会收到 `agent/tests/pine_oracle/`（它也没有 numpy）。

由这两条收集面得出的三句话必须原样抄进档案，不许含糊：
- Python 两道门（provenance ＋ coverage ledger）在**根 `.github/workflows/test.yml` 的 `test` job** 里会跑——那一步是裸 `pytest`（`test.yml:136`），走 `testpaths=["agent/tests"]`，而依赖来自 `pip install -e ".[dev,...]"`（`test.yml:105`），numpy 是核心依赖不是 extra（`pyproject.toml:39` `numpy>=1.24.0`，本机锁到 2.4.6，`requirements-lock.txt:2159`）⇒ numpy 在。
- JS 两道门在同一工作流的 `frontend` job 里会跑——`test.yml:169` 是 `cd frontend && npx vitest run`，`frontend/vitest.config.ts:14` 的 include 是 `src/**/__tests__/**/*.test.{ts,tsx}`，本轮两个新测试文件正好落在这个 glob 里。
- 三条都是**零上游文件改动**得到的：新增文件自动被既有收集面收下，本轮不编辑 `test.yml`、`vitest.config.ts` 与 `repowiki-freshness.yml` 中的任何一个。反过来说，`repowiki-freshness.yml` 那条面**从来没跑过本轮任何一道门**，所以「那个 workflow 绿」不能被引用成本轮门通过的正证。

- [ ] **Step 6: 档案落档**

在 `项目档案.md` 尾部追加一条本轮收口条目（一个新条目，不改历史条目），至少含：分支与基座坐标、判据一的实测读数（8 脚本 × 4 变体，逐 line 的 `probes` 与 `worst`，`worst` 全为 0 才是过）、判据二的实测读数（**11 个函数 / 18 条 line × 4 形态 = 72 份 values**，逐 line 的 `worst` 与实际容差档位）、DoD 九条逐条读数、判据一两条探针的读数（MUT-PI-1 的 `27 passed` 与删除后的 `26/34 passed`；MUT-PI-2 的两轮 `rc`、红的那条用例名、以及 `pineRuntime.ts` 的前后 sha 与「还原逐字节相同」）、provenance 变异探针三 sha 与「红了哪两条」、覆盖台账 `12/74`（判据一 8 脚本 / 判据二 11 函数）与 backlog `62`、`convention` 采纳的 7 条、外部锚点取到几条/放弃几条、裁定记录（warm-up 分歧每一条都要，含 `sar` 不进判据二的理由与 `vwap` 会话锚定的 backlog）。写完自检：

```bash
python -X utf8 -c "import pathlib;d=pathlib.Path('项目档案.md').read_bytes();print('CR',d.count(b'\r'),'bytes',len(d))"
git status --porcelain
```
Expected: `CR 0`（本轮已实测该文件是 `i/lf w/lf`）；`git status --porcelain` 只允许出现档案这一条 `M 项目档案.md`（Step 1 的 fixture 目录、Step 2 的探针都应已回到原样；出现别的路径就说明前面某步留下了痕迹，先查清楚再提交）。

- [ ] **Step 7: 提交**

```bash
git add 项目档案.md
git commit -s -m "docs(档案): Pine 护栏轮收口——两道门读数、12/74 覆盖台账与 warm-up 裁定"
```

- [ ] **Step 8: 集成菜单（控制器持有）**

按 `superpowers:finishing-a-development-branch` 的三选一原文呈现，**不自动 merge、不 push**：
1. 本地合回 `main`
2. 推送并开 PR
3. 保持分支现状

同时必须提醒用户三条实测坐标（2026-10-04 在本仓库测得，执行时各测各的并带上自己的坐标）：

- 本轮分支是 `feat/pine-oracle-harness`，基座 `518d793f`，与 `main` 同一个提交（`git rev-list --count feat/pine-oracle-harness..main` = 0）——这是「本轮不并进同步轮」裁定的落地方式。
- `main` 领先 `origin/main` **77** 个提交（`git rev-list --count origin/main..main`）。
- 同步轮分支 `sync/upstream-2026-10` 头 `2a50023d`，领先 `main` **65** 个提交，**尚未收口**。本轮若先合入 `main`，之后要按 spec §9 R-A 把 `feat/pine-oracle-harness` rebase 到新 `main` 上，预期冲突只集中在 `项目档案.md` 的尾部追加区与 `docs/superpowers/` 两处；rebase 属于改历史的操作，**必须由用户点头才做**。

---

## 自检表（覆盖自检：每条都写了核对方法，方法是跑过的）

- **spec §2 的 17 行现状事实全部被消费**（实测 `rows: 17` —— 早先这里写的是「14 行」，是把表头与分隔行一起数、又漏了三行的错读；核对方法：取出 `## 2.` 小节里以 `|` 开头的行，减表头减分隔行，得 17）。曾经有两行只有坐标没有落点、一行落点写歪，现已补成真消费：
  - `已有闭式点值断言的先例` → Task 4 Step 1 开头的三行理由，把「手算值 + `toBeCloseTo(x, 10)`」按本仓既有写法引用。注意引用姿势：`:18/:35/:48` 是三个 `it(...)` 的**起始行**，实际断言值在 `:23`(100)、`:32`(25)、`:40/:45`(5/7)、`:53`(20)——第一版把这两个体系混成了一个，已按读回原文的结果改正。
  - `PineRunOptions.lowerBars` 与 `estimateTick` 两行 → Task 1 `schema.py` 里 `EXEMPTION_CLASSES` 上方的注释，各自带 `pineRuntime.ts:176-189` / 调用点 `pineRuntime.ts:344`（定义与 500 根扫描上限在 `pineOrders.ts:86-96` 的 `:88`）坐标；「首批 18 条 line 无一属于 `tick_guarded`/`mtf_guarded`」不是沉默假设，由 Task 4 与 Task 7 两条 provenance 断言钉住。
  - `语料 harness「NOT a gate」` → Task 3 `pineOracleFixtures.ts` 的头注释（缺失必须 fail，绝不 skip）＋ Task 8 Step 1 的藏 fixture 探针。
  - 三行收集面（上游 vitest / Python `testpaths` / fork 自有工作流）与 `frontend/.gitignore` 一行 → Task 8 Step 5 的四条命令加三句话，坐标实测：`test.yml:105`（`pip install -e`，numpy 来自 `pyproject.toml:39`）、`:136`（裸 `pytest` 走 `testpaths`）、`:169`（`cd frontend && npx vitest run`）、`vitest.config.ts:14`、`repowiki-freshness.yml:65-67` 与 `:85`、`git check-ignore` 对 fixture 路径 `rc=1`。
- spec §4 的三档豁免 → Task 1 schema 常量（含上条注释）+ Task 3 判据 + Task 4/Task 7 的「全 `strict`」与挪档审计守卫。
- spec §5 的编码/换行/sha/容差 → Task 1（定义）、Task 4（应用）、Task 7（只准调严的档位地板）。
- spec §6 的 12 个函数与陷阱 → 参考实现分三批：Task 4（`sma`/`ema`/`rma`/`stdev`，4 个）、Task 5（`rsi`/`atr`/`bb`/`macd`/`stoch`，5 个）、Task 6（`supertrend`/`vwap`，2 个）；**第 12 个 `sar` 依 spec §11 更正三的 R-C 裁定不写参考实现**，只由判据一兜住，并在 Task 6 开头的裁定段、Task 7 的 `GATE1_ONLY` 与生成的 `COVERAGE.md` 三处点名。判据二终态 = 11 函数 / 18 条 line / 4 形态 = 72 份 values。逐函数有点值锚。
- spec §7 的两类锚点 → Task 6 Step 6/8（含「取不到就不写」的退路；计划期 `external_anchors` 终态读数 `[]`，按 R-B 这是诚实空读不是失败）与 `supertrend` 的 TV 官方脚本。
- spec §8 的 DoD 九条（编号 1–9，实测就是九条）→ Task 8 Step 1–8 加各任务的「实测读数」步骤；第 4/5/6 条（三类可红性）分别落在 Task 8 Step 1（藏 fixture）、Task 3 Step 5（MUT-PI-1 比较器正证 ＋ MUT-PI-2 引擎级未来函数）、Task 8 Step 2（改一位十进制）。**第 5 条在计划自检里被改写过一次**：设计稿的字面形态（把某个 `ta.*` 函数改成读 `bars[b+1]`）在本仓不可执行，因为步骤函数看不见 bar 数组；可执行的等价形态与它实测出的等价变异陷阱都记在 spec §11 第五行。
- 无占位符：每个 code step 给完整代码，每个 Run 给完整命令与期望文本。**核对方法不是眼睛看**——下一节把 python/TS 块逐字抽出真跑，抽不出来的块即视为占位符；`patch()` 的锚点要求出现次数恰为 1，不为 1 直接 `SystemExit`，本轮全部命中。
- 名称一致：`sha256_of`(20)、`bars_csv_text`(9)、`expectedColumn`(5)、`runScript`(10)、`TIER_VALUE`(5)、`ref_batch_1`(3)、`ref_batch_2`(5)、`ref_batch_3`(11)、`REFERENCE`(11)、`SCRIPTS`(24)、`TIER_FLOOR`(4)、`TIER_ORDER`(3)、`LINE_COUNT`(12)、`loadManifest`(4)；括号内是计划全文出现次数，均 ≥2，即定义处与消费处同时在，且抽出真跑时拼写一致（全套 80 passed）。

## 计划期实跑（Python 侧，2026-10-04，坐标 `518d793f` 的工作树）

自检不止于纸面：把本文件的 python 代码块**逐字抽出**成 `agent/pine_oracle/{schema,bars,emit_bars,reference,emit_fixtures,coverage,emit_coverage}.py` 与 `agent/tests/pine_oracle/` 的七份测试（`test_schema` / `test_bars` / `test_reference_batch1` / `test_reference_batch2` / `test_reference_batch3` / `test_pine_oracle_provenance` / `test_coverage_ledger`；跨任务的增量按锚点替换打上目标文件——Task 5 给 `emit_fixtures.py` 的 `ENGINE_CONVENTION` 与 manifest `"convention"` 键、给 provenance 门的两条守卫，Task 6 给 `emit_fixtures.py` 的 `ENGINE_CONVENTION.update` 与三态 tier、给 provenance 门的精确键名单替换与追加用例，Task 7 给 provenance 门的档位地板与豁免审计——锚点出现次数不为 1 即中止；抽不出来的块即视为占位符）。Task 7 的门要读引擎真表与判据一的脚本表，所以抽跑时把仓库里的 `frontend/src/lib/pineTa.ts` 原样复制进来（只读，74 个键必须是真的），并把 Task 3 的 `pinePrefixInvariance.test.ts` 与 Task 6 Step 7 的 `LINE_COUNT` 拼成终态。在仓库外的临时目录里真跑，得到下列读数。执行阶段仍以本仓库内的命令原文为准——**这里的数字是「计划文本能跑」的证据，不是「引擎与参考实现已对账」的证据**（后者要等 JS 门落进仓库、在 `frontend/` 里跑 vitest 才算）。

| 读数 | 计划文本 | 计划期实测（2026-10-04 复跑，全套一次抽出） |
|---|---|---|
| `test_schema.py` | 22 passed | **23 passed**（普通用例是 10 条不是 9 条，已把 302 行改为 23） |
| `test_schema + test_bars` | 33 passed | **34 passed**（23 + 11，737 行已同调） |
| `test_reference_batch1.py` | 7 passed | 7 passed |
| `test_reference_batch2.py` | 12 passed | 12 passed |
| `test_reference_batch3.py` | 8 passed | 8 passed |
| `test_pine_oracle_provenance.py`（Task 4 的 6 ＋ Task 5 的 2 ＋ Task 6 的 1 ＋ Task 7 的 2） | 6 / 8 / 9 / 11 passed | 11 passed |
| `test_coverage_ledger.py`（Task 7） | 8 passed | 8 passed |
| `pytest agent/tests/pine_oracle`（全套，Task 1–7 终态） | 80 passed | **80 passed in 0.77s**（23+11+7+12+8+11+8=80，逐文件实跑相加一致；Task 6 结束时为 70，见上） |
| `emit_coverage` 打印 | `74 builtins, 12 covered, 62 open, 7 conventions` | 逐字一致；生成的 `COVERAGE.md` 共 110 行、81 个表格行（12 ＋ 7 ＋ 62） |
| `emit_fixtures` 打印 | `60 files` | **`76 files, 18 lines tiered, batches={'batch_1': 5, 'batch_2': 10, 'batch_3': 3}`**（2026-10-04 已把 Task 5 Step 6 的期望改为 `64 files`、Task 6 Step 6 改为 76；`files` 含 4 份 bars，`values/` 目录实测 **72 份 CSV** = 18 line × 4 形态） |
| JS 门 24 / 68 / 84 passed 与判据一 26 / 34 passed | 推算 | **未实测**（vitest 侧要等 Task 3/4 落进仓库才能跑；这里没有替代证据，故保留「推算」字样，不许当读数引用） |

抽跑额外产出了**只有真跑才会暴露**的四处计划缺陷，均已就地改掉：`atr` 的 `out[3]`/`out[4]` 期望把 `tr[3]=3.0` 写成了 `2.5`（连带 `out[4]` 的种子错）；`emit_fixtures.py` 的 `git rev-parse` 依赖调用者 cwd 而其余路径全按 `__file__` 派生（已加 `cwd=REPO_ROOT`）；Task 4↔Task 5 之间 `PERIOD` 的两处定义（已收敛为 `reference.py` 单一定义、`SCRIPTS` 用 f-string 渲染）；以及**本轮新红的一条**——Task 4 的 `test_manifest_lists_every_committed_file_except_itself` 在 Task 7 把 `COVERAGE.md` 写进同一个 fixture 目录后**真的红了**（`([], ['COVERAGE.md'])`），因为那条门把目录里每个非 `manifest.json`/`.gitattributes` 的文件都当成 fixture 数据。已把它改名为 `test_manifest_lists_every_committed_data_file` 并把枚举限定为「非 `.md`」——CSV 仍然双向穷举，掉一个、加一个、改一位都照红；散文台账不该进哈希清单。

顺带一条正向证据：抽出跑时 `test_fixture_dir_is_derived_from_the_package_not_the_cwd` 在临时目录里**真的红了**（那里没有 `frontend/src/lib/pineTa.ts`），补上该文件后才绿——这条守卫不是摆设，它在仓库外会拒绝通过。

**引擎侧的计划期实跑**（2026-10-04，同一工作树，坐标 `518d793f`）：判据一的两条探针不能只写在计划里，所以本轮在**真引擎**上跑过一遍——临时在 `frontend/src/lib/__tests__/` 放了一份等价探针（`compilePine` 跑 `ta.sma(close[-1], 5)` 与 `ta.sma(close, 5)`，同一 60 根棒序列，NaN-相等逐位比对），跑完删除。三组读数：

| 注入 | 改了哪几处 | 读数 |
|---|---|---|
| 无（基线） | —— | `close[-1]` 与 `close` 的差异下标 `[]`；前缀(40) 与完整(60) 的差异下标 `[]` ⇒ 引擎把负下标钳在当前棒，**Pine 源无法读到未来** |
| 单针 | `pineRuntime.ts:430` 的 `k <= 0` 钳位 | **两轮读数逐字节相同**——字节改了、代码路径没走到，因为 `:957` 的 `Math.max(0, Math.trunc(k))` 先把负数夹回 0。这就是本仓记忆里「变异探针集体失明」的等价变异成因，实测复刻了一次 |
| 双针 | `:957` 去掉下限 ＋ `:430` 放行负下标 | `close[-1]` vs `close` 差异 `[4..59]`（前 4 根是 sma warm-up，两侧同 na）；前缀(40) vs 完整(60) 差异 `[39]` ⇒ 未来函数只暴露在前缀**末棒**，`comparePrefix` 与那条下限守卫都看得见。`pineRuntime.ts` sha `66a6bbdbd2c2`，还原后 `byte-identical: True` |

这次实跑改掉的是**设计侧的一处不可达**：spec §8 第 5 条写「把某函数改成用 `bars[b+1]` 的未来函数形态」，而本仓的 `ta.*` 是逐棒 stateful step，步骤函数拿不到 bar 数组，那句按字面无法执行；真正可达的注入点是序列下标求值，MUT-PI-2 就钉在那里，已把这条回写进 spec §11 第五行。同一趟跑还挖出一条**此前无人看守的门**：`:957` 那个下限在任何 `pine*.test.ts` 里都没有用例（grep 实测零命中；`indicatorLang.test.ts:163` 测的是另一套求值器，那里 `close[-1]` 断言成 `NaN`，与本运行时不同），而它正是「无未来函数」这句话的机器保证——所以 Task 3 Step 2 新增了一条永久 `it`，判据一的期望条数各 +1（Task 3 `25→26`、Task 6 `33→34`），MUT-PI-1 临时段所在的那次跑则报 `27 passed`。

---

## 执行期对账（不改动上方任何行号坐标）

**为什么单列在文末**：Task 1 落地后经两轮评审偏离了本计划的代码块，而把实码就地换回来会让下方 2800 余行整体位移——被 `agent/pine_oracle/schema.py:52,79,81,84` 与 `agent/tests/pine_oracle/test_schema.py:231-234` 引用的 15 处坐标（`:698` `:768` `:829-841` `:1358` `:1366-1376` `:1422` `:1479-1502` `:1519` `:1601`）会全部指错。实跑验过一次：就地替换那段 120 行代码块后，`:841` 落到了 `Run: pytest …` 那行、`:1601` 落到了 `if __name__ == "__main__":`。所以本节只做**追加**，上方坐标保持有效；实码是权威，本计划的 Step 1/3/4 代码块是计划期产物。

**Task 1 的实际终态与计划差异（逐条，含可核对坐标）**：

| 项 | 计划期 | 落仓实码 | 定性 |
|---|---|---|---|
| `validate_manifest` 对「键齐值空」 | 用 `(data.get(…) or {})` 吞类型，空映射返 `[]` | 11 必需键逐个查值：`_REQUIRED_CONTAINER_KINDS`（`schema.py:88-98`，9 键）钉容器种类，`_NON_EMPTY_MANIFEST_KEYS`（`:109-118`，8 档映射须非空），2 个标量字面量精确相等 | **加严**。这是对计划文本的授权偏离，裁定理由：Task 4 把它当写盘前唯一的门，空 `tolerance_tier` 会让 JS 门迭代零条 line 而绿，属全局约束点名的「空集合真空通过是缺陷不是绿」 |
| `_REQUIRED_MANIFEST_KEYS` | 6 键 | 11 键（并入 `period/seed/shape/scripts/lines`，`schema.py:58-70`） | **加严**。JS 门 `OracleManifest` 声明的正是这 11 键（`:829-841`）；两侧名单必须同源 |
| `NA_ENCODING` | `NA_ENCODING = "empty"` | `NA_ENCODING: str = "empty"`（`:44`） | 仅类型标注，值未变 |
| 豁免类注释 | 声称「首批 18 条全 `strict`」当既成事实，并断言 tick 差异「仅末棒可不同」 | 措辞改为「计划期预期，由 Task 4/7 的 provenance 门钉住」（`:38-42`），并撤销「仅末棒」这一条 | **文档诚实纪律**。spec §11 更正六；tick 是每次 run 的一个标量，没有证据它只砸末棒 |
| `estimateTick` 坐标 | `pineRuntime.ts:344-349`，且说「从整条序列估」 | `pineRuntime.ts:344` 是调用点，定义在 `pineOrders.ts:86-96`，`:88` 的扫描上限是 `Math.min(bars.list.length, 500)` | **计划原文坐标错**，由实现者实测指出、我复验、评审者独立复验 |
| Step 5 期望条数 | `23 passed` | `52 passed`（`23 → 34 → 52`；round 1 `+11` = I-1 全 null 文档 1 ＋ I-4 落盘字节 1 ＋ M-3 往返 1 ＋ M-5 float 补形状 3 ＋ I-2 缺键参数化 6→11 共 5；round 2 `+18` = 结构钉 1 ＋ 空映射参数化 8 ＋ 值形状参数化 8 ＋ 真实产物形态正证 1） | 计划期的 23 保留不改成实际数，是为「执行时报实际数」留一个可对照的原值 |

**给 Task 4 的两条前置事实**（本轮把「将来会撞」换成了常驻用例）：`_task4_generated_manifest()`（`test_schema.py:227-…`）逐键照 `:1479-1502` 的字面量构造真实产物形态并断 `validate_manifest(doc) == []`，**生成器落的是 14 键**（11 契约 + `generated_at`/`generator`/`head_sha`），不是 11——多出的 3 个是生成器元数据，被有意排除在必需键名单外。Task 5 追加的 `convention`（`:2113`）与 Task 6 填充的 `external_anchors` 元素都不落在被收紧的判据上，仍合法。若 Task 4 的产物被这道门拒了，先怀疑生成器，门是有意严的。

**仍未做且已裁定的**（不是遗漏）：`lines` 批内值类型、`seed`/`period` 值类型、`files` 值是否 64-hex、`external_anchors` 元素形状——由 Task 4/7 的 provenance 门在真文件上把关；不可 hash 的 tier 值（`tolerance_tier: {"x": []}`）仍抛 `TypeError` 而非返错误列表，登记在 ledger 为 parked。

### Task 2 执行期对账（同上一条：只追加，上方坐标不动）

| 项 | 计划期 | 落仓实码 | 定性 |
|---|---|---|---|
| `emit_bars.py` 的 seed 声明 | `BAR_JOBS` 调用实参写一份 seed，`BARS_META` 字面量再写一份，注释声称「派生而非重述」 | 私有表 `_JOBS`（`emit_bars.py:27-32`）单点声明，`BAR_JOBS` 与 `BARS_META` 都由它派生；`BARS_BASENAMES` 仍从 `BAR_JOBS` 取 | **加严**。计划文本的假声明在 Task 4 里抓不到：它只断言名字集合相等（`:1431`），seed 错配会产出一份「声称 seed=X 可重生、字节实来自 seed=Y」的 manifest |
| 「恰好 5 根跳棒」的理由 | `bars.py` docstring 归因于「棒内噪声 <1%」 | 归因改为构造性不变式，并新增第 12 条用例 `test_non_injected_bars_open_equals_previous_close` 用 `==` 精确钉住它 | **加严**＋文字归真。评审探针实测 `_BODY_STEP` 取 0.012/0.12/0.6/1.2 时计数四次全为 `[22,45,68,91,114]`，旧理由是假的；新用例经两根针证可红（`round(open_, 6)`→`round(open_, 2)` 时旧计数用例仍绿） |
| OHLC 括号与 volume 正性 | 只对 `shape="trend"` 逐行断言 | 同一循环扩到 `trend/oscillate/gap` ＋ `make_intraday_bars(seed=13, sessions=1)` | **加严**，用例条数不变。Task 4 的 `vwap` 参考值正是从日内 `high/low/close/volume` 算（`:1438-1444`） |
| Step 7 期望条数 | `34 passed`（23＋11） | **64 passed**（Task 1 实际 52 ＋ Task 2 实际 12） | 计划期两个数都已过期，见上一条 Task 1 对账 |
| Step 6 那句「`run1` 的 sha 与 Step 5 打印的第一行一致」 | 成立 | **不成立**：`emit()` 返回的元组被 `sorted(d for _, d in emit())` 排序，排的是 sha 串，`run1` 是第四份（vwap） | 计划文本缺陷，已在执行报告中纠正；Step 6 的命令本身照旧可跑 |
| 日内 epoch 的时区独立性 | 靠「显式写 08:00 偏移」这句话保证 | 结构性保证：`bars.py` 全文只 import `__future__`/`typing.Any`/`pine_oracle.schema`，**没有 `datetime`/`zoneinfo`** | 比计划更强，无需改动 |
| `lcg_stream(seed, n * 6)` 的第 1 带（`n..2n-1`） | 未说明 | 确实从未被读（实读带为 `i`/`2n+i`/`3n+i`/`4n+i`/`5n+i`） | **已裁定不改**：流长度一动就改四份已入库 CSV 的字节。登记为 parked，不是遗漏 |

**四份 bar 夹具的字节基线**（后续任务不得改动；改动即重生成对账失败）：
`wc -l` = `121 / 121 / 121 / 41`，sha12 前缀 `cca364cadeea`（trend）/ `35441afa24c7`（oscillating）/ `671b1f8d4aca`（gapped）/ `0c261a2a6692`（intraday），
`git ls-files --eol` 四份均 `i/lf w/lf attr/text eol=lf`；gap 注入下标实测 `[22, 45, 68, 91, 114]`。

**Task 4 的两条前置事实**：日线 `time` 排的是**连续日历日**（`DAY_ZERO_MS + i*DAY_MS`，120 天里含 34 根周末棒，日内 session 5 落在 2024-01-06 周六），期望值必须按实数据算，别按 A 股交易日历推；`BARS_META` 的 shape 值 `"intraday"` 不是 `make_daily_bars` 的合法 shape，若 Task 4 改从 `BARS_META` 重生成行（而不是用 `BAR_JOBS` 的行）需要特判。

**给后续所有 Python 轮次的探针纪律（Task 2 一起真实事故换来的）**：变异针若与原文**同字节长度**，且源文件 mtime 与 size 都落回原值，CPython 会复用 mutant 编译出的 `.pyc`（`int(st_mtime)+size` 校验被骗过）。Task 2 的 `23→24` 那根针就因此让一次「提交后复证 CLI」把 `bars_daily_gapped.csv` 写成了 `583fac7d97d9`（坏字节从未进 git，按 `git cat-file blob HEAD:` 读回的原始字节写回）。**规则**：针脚还原后，凡该模块参与写已入库文件，先删其 `__pycache__/*.pyc` 或带 `-B` / `PYTHONDONTWRITEBYTECODE=1` 跑那一步。

### Task 3 执行期对账（同上一条：只追加，上方坐标不动）

| 项 | 计划期 | 落仓实码 | 定性 |
|---|---|---|---|
| Step 1 的夹具目录解析 | `fileURLToPath(new URL("./__fixtures__/pine_oracle", import.meta.url))` | `resolve(__dirname, "__fixtures__/pine_oracle")`（`pineOracleFixtures.ts:35`） | **计划文本与本仓 vitest 配置冲突**：`vitest.config.ts:12` 是 `environment: "jsdom"`，jsdom 下 `import.meta.url` 不是 `file:` scheme，模块加载期就 `TypeError: The URL must be of scheme file`，收集到 0 条用例。本仓读盘用例的既有写法一致（`Help.test.tsx:113-116`、`apiProxyCoverage.test.ts:21`、`viteProxy.test.ts:6`、`warehouseEntry.test.ts:15-17`）。brief 的**理由**（从模块定位、绝不从 `process.cwd()`）原样保留在 `:27-28`，改的只是拿路径的手段。**Task 4 的 JS 门若自己拼路径必须同样用 `__dirname`** |
| Step 2 的 `sar` 脚本字面量 | `plot(ta.sar, title="sar")` | `plot(ta.sar(0.02, 0.02, 0.2), title="sar")`（`pinePrefixInvariance.test.ts:37`） | **计划文本的字面量在 v5 下无效**：裸 `ta.sar` 的兜底名单 `LEGACY_SERIES`（`pineRuntime.ts:94-100`）只含 `accdist/pvt/obv/nvi/pvi`，且整条路被 `if (this.ver <= 4)`（`:1169`）门控，实测 RED 是诚实中断「未定义的变量 "ta.sar"」。三个实参就是引擎默认值（`pineTa.ts:717-719`），`pineTa.ts:722-762` 是同一条 `c.state` 递归——脚本未删、`worst` 仍 `toBe(0)`、探针数学一根没少。判据二不覆盖 `ta.sar`（spec §11 R-C），所以它只有判据一这一条门，换成诚实写法没有削弱任何目标 |
| `readBack` 钳位坐标 | 5 处写作 `pineRuntime.ts:429` / `` `:429` `` | 实际是 **`:430`**（`:429` 是签名行 `private readBack(name, k)`） | 计划原文坐标错一行，评审者实测指出、控制器回读确认。**已就地等长改成 `:430`**（`429`→`430` 同字符数，不动任何行号，被实码引用的 15 处坐标全部复验有效），落仓注释 `pinePrefixInvariance.test.ts:170-172` 同步 |
| 缺列的处置 | `col = (key) => header.indexOf(key)`，取不到列就是 `r[-1]` | `requireColumn`（`pineOracleFixtures.ts:98-107`）缺列即抛，消息命名文件＋列名＋它真读到的 header；`loadBars` 的六列全部走它（`:110-119`）；`loadSession` 仍用 `indexOf`（`:126`）——它是唯一被允许回答「没有这一列」的调用方 | **加严**（评审 I-1 后半）。计划的全局约束点名「空集合真空通过是缺陷不是绿」，而计划代码块本身正是那条静默路径 |
| 「这条线到底有没有可比点」 | 无任何断言 | 逐 line 钉 `EXPECTED_NA`（`:88-95`，`sma/ema/rma/stdev/stdev_sample/sar` = `4/0/4/4/4/0`）＋「可比点 > 0」下限（`:112-119`），另钉 `reference[lineName].length === L`（`:112`） | **加严**。取的是裁定允许的**严格形态**（精确 warm-up 数而非 `>=`）。代价已如实登记：判据一现在同时钉住了引擎的 warm-up 行为，一次正当的 `ema`/`sar` 播种变更会以「非重绘原因」把这条门判红 |
| 前缀长度 | 只比 `prefix.length` 个位置，多出来的尾巴静默丢 | `expect(prefix[lineName]?.length).toBe(n)`（`:133`） | **加严**（评审 I-2）。计划里 `comparePrefix` 的 `checked` 算了又丢（`:77`），所以旧代码对「前缀 run 产出多于 n 个值」——恰好是前视泄漏的形状——是绿的；不足长那一侧本已由 `runScript` 在 `result.bars < n` 时抛错覆盖（`pineOracleFixtures.ts:106` ＋ `pineScript.ts:185-188`），缺的正是另一半 |
| 比对集的钉法 | `LINE_COUNT`（只钉条数）＋注释声称能防「`title=` 丢了」 | `EXPECTED_LINES` 钉 line **名**（`:69-76`，断言 `:107-108`），注释改为只声称它做得到（`:63-68`） | **加严**＋文字归真。计划原注释是假声明：无 title 的 `plot()` 仍是一条线（引擎自动命名 `系列N`，`pineRuntime.ts:1720`），钉条数拦不住改名 |
| `probes` 钉的注释 | 声称「夹具变短会静默掏空本用例」 | 注释改为「loop-edit canary」，并承认变短由 `:156-161` 的字面量长度钉抓到（`:142-146`） | **文字归真**（评审 M-3）：`L > 16` 时两侧同由 `L` 推导，这条钉按构造就是自指的；断言本体一字未动 |
| Step 4 期望条数 | `26 passed` | **`26 passed` 成立**（两轮修复后控制器复跑仍 26；`npx tsc -b` exit 0；五条姊妹 pine 套件 160 passed） | 计划期唯一未被推翻的读数 |

**控制器的一条裁定写错了机制，留痕**：我在 Task 3 的评审工作单里写「缺列 ⇒ 整条线全 `NaN` ⇒ 整道门在垃圾上绿，只有行数钉能活」。**这是假的**：`build()` 在 `pineRuntime.ts:2351` 把全 `NaN` 的 line 直接滤掉（并 warn「N 条 plot 全区间无数据，已隐藏」），`ensureLine`（`:1740-1742`）按 `bars.list.length` 分配长度，所以全空线根本进不到 `result.lines`，旧的条数钉当时就会红；实现者实测 `close`→`clsae` 那根针**修前也红**（21 failed / 5 passed，与 `:2351` 完全自洽：5 条 close 驱动脚本 × 4 变体＝20 条数钉红，加 `close[-1]` 那条 1 个 TypeError，剩 4 条 `sar`（high/low 驱动）与长度钉仍绿＝5 passed）。修复本身仍然是需要的，真正**可达**的洞是另外三个：门不比较的列（`volume`/`time`）静默全 `na` 而 26 全绿；某条线少掉一个数据点而全绿；以及红是靠巧合触发的、消息既不指文件也不指列。**规则化**：控制器把评审者的机制断言写进裁定词之前必须回读被点名的实码——这是本会话第二次犯同一类错（前一次是 Task 2 的 `n..2n-1` 带）。

**引擎侧事实，Task 4/5/6 会直接用到**：① 无 title 的 `plot()` 自动命名 `系列N`（`pineRuntime.ts:1720`）；② 重名 title 自动加后缀 ` (2)`（`:1719-1724`），所以 `runScript` 的重名抛错（`pineOracleFixtures.ts:144-146`）只可能由非 `plot` 的 line 生产者触发；③ 某条参考批全 `na` 时这条线被 `:2351` 隐藏 ⇒ 判据二按 line 名取值时「线不存在」与「线全空」是同一种表象，Task 4 的门必须显式区分这两者，否则「参考实现一条没算出来」会伪装成「少一条 line」。

**环境噪音（非本任务引入，已对照确认）**：任何 `npx vitest run` 都会先打一条 `(!) Your Vite config uses features that are unsupported by configLoader: 'native' … __dirname (vitest.config.ts:8:32)`。改一个本任务没碰的文件对照跑（`pineSeries.test.ts`）同样出现，故登记为仓级既有噪音，不算判据一的不纯净输出。Windows 下 `npx` 可能挂，用 `npx.cmd`。

**parked（带向 Task 8 / 最终全分支评审，不是遗漏）**：M-6 夹具读盘发生在 collection 期（缺文件报 `Failed Suites`、非零退出，符合「绝不 skip」契约，但 CI 看不到逐条红）；M-8 `sar` 的 `st.up` 翻转在这四个变体上是否真发生过没有读数；`expectedColumn`（`pineOracleFixtures.ts:132-135`）仍按位置取 `r[1]` 不做 header 校验；`readCsv` 不校验每行字段数（截断行 ⇒ 一个静默 `na`）；`requireColumn` 的 doc 把 `volume` 针的红因写成「`comparePrefix` 视两个空位为相等」，与实现者自己 §R1.5-1 的正确说法（门根本不比较该列）矛盾，等长一行改词即可；`EXPECTED_NA` 缺一句「此处红是 warm-up/seeding 变更、不是重绘，别按判据一发现立案」；`EXPECTED_NA` 按脚本键取值却逐 line 断言，只在每脚本恰好一条 line 时成立（`EXPECTED_LINES` 目前确实如此）。
