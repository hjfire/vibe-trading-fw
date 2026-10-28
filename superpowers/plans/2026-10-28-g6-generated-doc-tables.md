# G6 生成式文档数值表 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `forensics/l0/` 的逐份机器可判面从手打改成生成物 `forensics/l0-census.md`，由 `--check` 与 pytest 判陈旧，并接上一条 fork 自有的 CI 面。

**Architecture:** 生成器 `tools/doc_tables.py` 只做「读仓 → 出表」，解析一律复用 `tools/forensics_audit.py`（为此给审计模块加两个纯增量公开包装），于是「L0 记录的键面长什么样」全仓只有一把尺。陈旧判据是**归一化后的字节相等**（工作树 CRLF / blob LF 归一，平台无关），确定性的判据是「同一棵树两次 render 逐字节相同」。CI 面是新文件 `.github/workflows/doc-tables.yml`，因为 `pyproject.toml` 的 `testpaths = ["agent/tests"]` 让上游永远不会收集 `tools/` 下的测试，而 `.github/workflows/test.yml` 与 `tools/ci_grep_gates.sh` 上游所有、字节保护。

**Tech Stack:** Python 3.11 标准库（`pathlib`／`re`／`sys`）＋ pytest；GitHub Actions（`ubuntu-latest`、pin 过 SHA 的 checkout／setup-python）。

**Spec:** `superpowers/specs/2026-10-28-g6-generated-doc-tables-design.md`

## Global Constraints

- 全程自主推进，不等待逐步复核（用户 2026-10-28 明示）；破坏性操作与范围重定仍停。
- 改动限定在本仓：全局 git 配置、Node/Python 工具链、`.pnpm-store`、SQLite 一律不动。
- `.github/workflows/test.yml`、`tools/ci_grep_gates.sh` 上游所有，**字节不动**；新能力一律新开文件。
- 提交一律 `git commit -s` ＋显式 pathspec（禁 `-A`／`.`／`-a`）；推送前 `git ls-remote` 对真值。
- 商标字面量不得写进任何**跟踪面**：新文件里需要那个 host 时用 `forensics_audit.TV_PAGE_HOST`，不抄字面。
- 不调任何门禁阈值、不修门体、不清白名单；恒红门先证「本片 0 贡献」再报告。
- 生成物不许含日期／提交号／行号／绝对路径（自指读数禁令）。
- 始终用中文回复用户；命令给完整可复制形式。

---

## 基线（执行前现读，写在这里只为对账，不许抄进任何跟踪面）

- `python -X utf8 tools/forensics_audit.py` ⇒ `forensics audit: clean`，rc=0。
- `python -X utf8 -m pytest tools/test_forensics_spec.py -q` ⇒ `166 passed`。
- `git ls-files 'forensics/l0/*.md'` ⇒ 33 份（含 `_example.md`，用例侧 32 份）。
- 工作树 md／py 全 CRLF（`tr -cd '\r' | wc -c` 等于行数），blob 全 LF（`git show HEAD:forensics/README.md | tr -cd '\r' | wc -c` ⇒ 0），`core.autocrlf=true`。

---

### Task 1: 审计模块的两个公开包装（一把尺）

**Files:**
- Modify: `tools/forensics_audit.py`（在 `_is_tv_page_record` 之后追加，纯增量，不改任何既有函数体）
- Create: `tools/test_doc_tables.py`（本任务只放包装的针，后续任务往同一文件追加）

**Interfaces:**
- Produces: `record_keys(path: Path) -> dict[str, str]`、`record_target_kind(path: Path) -> str`（四值：`三方`／`自家`／`其他`／`无 URL`）、模块常量 `SELF_HOSTS: frozenset[str]`。

- [ ] **Step 1: 写失败的测试**

创建 `tools/test_doc_tables.py`：

```python
"""Guards for tools/doc_tables.py and the generated forensics/l0-census.md.

生成物只有一条诚实判据：**已跟踪的那份必须等于现算的那份**。所以这里先证明
「一把尺」——包装函数与审计的私有解析对整棵活树逐份一致；再证明「尺有分辨力」——
往临时语料加一份记录，表必须跟着变。只断言「文件存在」的守卫是恒真的静态图。

Run with::

    python -X utf8 -m pytest tools/test_doc_tables.py -q
"""

from __future__ import annotations

from pathlib import Path

import pytest

import forensics_audit as fa

REPO = Path(__file__).resolve().parent.parent
FORENSICS = REPO / "forensics"
L0_DIR = FORENSICS / "l0"
KINDS = frozenset({"三方", "自家", "其他", "无 URL"})


def _live_records() -> list[Path]:
    return [
        p
        for p in sorted(L0_DIR.glob("*.md"))
        if p.is_file() and p.name not in fa.L0_EXEMPT
    ]


def test_record_keys_equals_the_audit_parser_on_every_live_record() -> None:
    records = _live_records()
    assert records, "forensics/l0/ 没有任何可判记录：语料空时这条针会恒真"
    for path in records:
        assert fa.record_keys(path) == fa._meta_keys(fa._read(path)), path.name


def test_record_target_kind_agrees_with_the_third_party_ruler() -> None:
    records = _live_records()
    assert records
    for path in records:
        kind = fa.record_target_kind(path)
        assert kind in KINDS, path.name
        url_field = fa.record_keys(path).get("目标 URL", "")
        assert (kind == "三方") == fa._is_tv_page_record(url_field), path.name


def test_record_target_kind_covers_all_four_values(tmp_path: Path) -> None:
    tv = f"https://www.{fa.TV_PAGE_HOST}/chart/?symbol=X"
    cases = {
        "tv.md": (tv, "三方"),
        "self.md": ("http://localhost:5899/pro-chart", "自家"),
        "loop.md": ("http://127.0.0.1:8077/", "自家"),
        "other.md": ("https://example.invalid/x", "其他"),
        "none.md": ("", "无 URL"),
    }
    for name, (url, want) in cases.items():
        body = "# L0：包装\n" if not url else f"# L0：包装\n- 目标 URL：{url}\n"
        path = tmp_path / name
        path.write_text(body, encoding="utf-8")
        assert fa.record_target_kind(path) == want, name
```

- [ ] **Step 2: 跑测试确认红**

Run: `python -X utf8 -m pytest tools/test_doc_tables.py -q`

Expected: 收集成功、三条 `AttributeError: module 'forensics_audit' has no attribute 'record_keys'`（或 `record_target_kind`）失败。

- [ ] **Step 3: 实现两个包装**

在 `tools/forensics_audit.py` 的 `_is_tv_page_record` 函数之后（`_audit_l0` 之前）插入：

```python
# 自家站点的 host 白名单（生成侧 `doc_tables.py` 用它把「观察自己的页面」与「观察三方页」
# 分开）。这里只认逐字 host：IP 变体、`.local` 之类等真出现再加——活树实测只有 localhost
# 与 127.0.0.1 两种形状，提前铺一张大表就是把没发生的事写进代码。
SELF_HOSTS: frozenset[str] = frozenset({"localhost", "127.0.0.1", "0.0.0.0"})


def record_keys(path: Path) -> dict[str, str]:
    """一份 L0 记录的点号键面（与 ``_meta_keys`` 逐字同一把尺）。

    生成器不许自带第二个解析器：同一事实两处实现，下一份记录的写法一变就会漂成两种真相。
    """
    return _meta_keys(_read(path))


def record_target_kind(path: Path) -> str:
    """``目标 URL`` 的 host 类：``三方``／``自家``／``其他``／``无 URL``。

    「三方」与审计的第三方标记红线同一判据（``_is_tv_page_record``，按 host 不按子串）；
    「无 URL」是根本没有这一键或值为空——它与「有 URL 但判不出 host」分开，后者记 ``其他``。
    """
    url_field = record_keys(path).get("目标 URL", "")
    if not url_field:
        return "无 URL"
    if _is_tv_page_record(url_field):
        return "三方"
    host = _url_host(url_field)
    if host and host in SELF_HOSTS:
        return "自家"
    return "其他"
```

- [ ] **Step 4: 跑测试确认绿，并复跑既有审计套件**

Run:
```bash
python -X utf8 -m pytest tools/test_doc_tables.py -q
python -X utf8 -m pytest tools/test_forensics_spec.py -q
```
Expected: 前者 `3 passed`；后者仍是 `166 passed`（一条不多一条不少——纯增量的证据）。

- [ ] **Step 5: 提交**

```bash
git add tools/forensics_audit.py tools/test_doc_tables.py
git commit -s -m "feat(forensics): 记录键面与目标 host 类的两个公开包装，生成器不再造第二把尺"
```

---

### Task 2: 生成器与第一份生成物

**Files:**
- Create: `tools/doc_tables.py`
- Create: `forensics/l0-census.md`（由 `--write` 生成，不手写）
- Modify: `tools/test_doc_tables.py`（追加生成器针）

**Interfaces:**
- Consumes: `fa.record_keys`、`fa.record_target_kind`、`fa.L0_REQUIRED_KEYS`、`fa.EVIDENCE_ID`、`fa.UNCAPTURABLE`、`fa.L0_EXEMPT`。
- Produces: `render(forensics_root: Path) -> str`、`check(forensics_root: Path) -> tuple[int, str]`、`main(argv: list[str] | None = None, forensics_root: Path | None = None) -> int`、常量 `CENSUS_NAME = "l0-census.md"`、`TABLE_HEADER`。

- [ ] **Step 1: 写失败的测试（追加到 `tools/test_doc_tables.py`）**

```python
# ---------------------------------------------------------------------------
# 生成器（Task 2）
# ---------------------------------------------------------------------------

import re  # noqa: E402  （追加段自带导入，保持上面的基线段可独立阅读）
import shutil  # noqa: E402
import subprocess  # noqa: E402
import sys  # noqa: E402

import doc_tables  # noqa: E402

CENSUS = FORENSICS / "l0-census.md"
SAMPLE = f"""# L0：样例

- 命令：npx -y rea-agents@latest inspect-web-page http://127.0.0.1:9222 T1 --filter-output normalized_result
- evidence_id：ev_{"ab" * 32}
- 浏览器：chrome 1.0
- 目标 URL：http://localhost:5899/pro-chart
- 观察条件：c
- 完整性：ok
"""


def _census_root(tmp_path: Path, records: dict[str, str]) -> Path:
    root = tmp_path / "forensics"
    (root / "l0").mkdir(parents=True)
    (root / "l0" / "_example.md").write_text("# 模板\n", encoding="utf-8")
    for name, body in records.items():
        (root / "l0" / name).write_text(body, encoding="utf-8")
    return root


def _table_rows(text: str) -> list[str]:
    lines = text.splitlines()
    start = lines.index(doc_tables.TABLE_HEADER)
    rows: list[str] = []
    for line in lines[start + 1:]:
        if not line.startswith("|"):
            break
        if set(line) <= set("|-: "):
            continue  # `|---|---|` 分隔行不是数据行
        rows.append(line)
    return rows


def test_tracked_census_matches_the_live_render() -> None:
    assert CENSUS.is_file(), "forensics/l0-census.md 不存在：先跑 --write"
    actual = CENSUS.read_bytes().replace(b"\r\n", b"\n").decode("utf-8")
    assert actual == doc_tables.render(FORENSICS)


def test_render_is_deterministic() -> None:
    assert doc_tables.render(FORENSICS) == doc_tables.render(FORENSICS)


def test_render_has_no_self_referential_readings() -> None:
    text = doc_tables.render(FORENSICS)
    assert not re.search(r"\d{4}-\d{2}-\d{2}", text), "生成物里出现日期"
    assert not re.search(r"\b[0-9a-f]{40}\b", text), "生成物里出现提交号"
    assert not re.search(r":\d+", text), "生成物里出现行号（或任何 冒号+数字）"


def test_rows_track_the_corpus(tmp_path: Path) -> None:
    root = _census_root(tmp_path, {"a.md": SAMPLE})
    one = doc_tables.render(root)
    assert len(_table_rows(one)) == 1
    assert "`a.md`" in one

    (root / "l0" / "b.md").write_text(SAMPLE, encoding="utf-8")
    two = doc_tables.render(root)
    assert len(_table_rows(two)) == 2
    assert "`b.md`" in two, "新增的记录没进表——这把尺是静态图，不是现算"


def test_uncapturable_status_shows_up_in_the_census(tmp_path: Path) -> None:
    body = "# L0：拿不到\n- 状态：不可取证\n- 命令：npx -y rea-agents@latest inspect-web-page x T --filter-output r\n- 原因：站点拒绝\n"
    root = _census_root(tmp_path, {"u.md": body})
    row = _table_rows(doc_tables.render(root))[0]
    assert "不可取证" in row
    # 不可取证的记录照样带有 `命令`（审计对它也是这么要求的），所以六键计数是 1/6 而不是 0/6：
    # 这一格是「量出来的」不是「按状态发的」，状态与键面是两个独立的读数。
    assert "1/6" in row


def test_check_semantics_on_a_temp_tree(tmp_path: Path) -> None:
    root = _census_root(tmp_path, {"a.md": SAMPLE})
    assert doc_tables.main(["--check"], root=root) == 1, "没有生成物时 --check 必须红"
    assert doc_tables.main(["--write"], root=root) == 0
    assert doc_tables.main(["--check"], root=root) == 0

    census = root / doc_tables.CENSUS_NAME
    census.write_bytes(census.read_bytes().replace(b"6/6", b"0/6", 1))
    assert doc_tables.main(["--check"], root=root) == 1, "改一个字节后 --check 必须红"


def test_check_is_eol_insensitive_on_a_crlf_checkout(tmp_path: Path) -> None:
    root = _census_root(tmp_path, {"a.md": SAMPLE})
    assert doc_tables.main(["--write"], root=root) == 0
    census = root / doc_tables.CENSUS_NAME
    census.write_bytes(census.read_bytes().replace(b"\n", b"\r\n"))
    assert doc_tables.main(["--check"], root=root) == 0, "CRLF 工作树不许判陈旧"


def test_cli_on_the_real_repo_is_clean() -> None:
    got = subprocess.run(
        [sys.executable, "-X", "utf8", str(REPO / "tools" / "doc_tables.py"), "--check"],
        cwd=REPO, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=120,
    )
    assert got.returncode == 0, got.stderr + got.stdout


def test_the_census_file_lives_outside_l0() -> None:
    assert CENSUS.parent == FORENSICS
    assert fa.audit_forensics(FORENSICS, REPO) == [], "生成物进了 l0/ 会被审计当成缺键的记录"


def test_a_census_shaped_file_inside_l0_would_be_refused(tmp_path: Path) -> None:
    """把位置裁定做成有分辨力的针：同一份内容搬进 l0/，审计必须报缺键。"""
    root = _census_root(tmp_path, {})
    shutil.copyfile(CENSUS, root / "l0" / "census-copy.md")
    assert fa.audit_forensics(root, REPO) != []
```

- [ ] **Step 2: 跑测试确认红**

Run: `python -X utf8 -m pytest tools/test_doc_tables.py -q`

Expected: `ModuleNotFoundError: No module named 'doc_tables'`（其余旧针仍绿）。

- [ ] **Step 3: 写生成器**

创建 `tools/doc_tables.py`：

```python
"""Regenerate the numeric tables under ``forensics/`` from repository state.

手打的数字在写下那一刻就开始过期，而没有门会红——`forensics/README.md` 里那句
「25 份记录里 23 份」就是一枚（现量 32 份用例记录）。这里把「L0 记录的机器可判面」
变成生成物：解析一律走 ``forensics_audit``（同一把尺），输出确定性（排序、无时间戳、
无日期、无提交号、无行号），陈旧判据是归一化后的字节相等。

Run with::

    python -X utf8 tools/doc_tables.py            # 等同 --check
    python -X utf8 tools/doc_tables.py --check    # 已跟踪的表 != 现算的表 ⇒ rc 1
    python -X utf8 tools/doc_tables.py --write    # 重写 forensics/l0-census.md
"""

from __future__ import annotations

import sys
from pathlib import Path

import forensics_audit as fa

CENSUS_NAME = "l0-census.md"
TABLE_HEADER = "| 记录 | 状态 | 用途 | 六键 | evidence_id | 目标 |"
TABLE_SEPARATOR = "|---|---|---|---|---|---|"
PREAMBLE = """# L0 记录普查

> 机器生成，不要手改：`python -X utf8 tools/doc_tables.py --write` 重写本文件，
> `--check` 判陈旧；表里的每一格都由 `tools/doc_tables.py` 从 `l0/` 现算，
> 解析与 `tools/forensics_audit.py` 共用同一把尺。改数据改记录本身，表会自己跟上。
> 模板 `_example.md` 不在普查范围（它不是证据）。
"""


def _records(forensics_root: Path) -> list[Path]:
    l0_dir = forensics_root / "l0"
    return [
        p
        for p in sorted(l0_dir.glob("*.md"))
        if p.is_file() and p.name not in fa.L0_EXEMPT
    ]


def _row(path: Path) -> tuple[str, ...]:
    keys = fa.record_keys(path)
    status = fa.UNCAPTURABLE if fa.UNCAPTURABLE in keys.get("状态", "") else "完整"
    purpose = keys.get("用途", "") or "—"
    filled = sum(
        1
        for key in fa.L0_REQUIRED_KEYS
        if keys.get(key) and "<" not in keys[key] and ">" not in keys[key]
    )
    evidence = "✓" if fa.EVIDENCE_ID.fullmatch(keys.get("evidence_id", "")) else "—"
    return (
        f"`{path.name}`",
        status,
        purpose,
        f"{filled}/{len(fa.L0_REQUIRED_KEYS)}",
        evidence,
        fa.record_target_kind(path),
    )


def render(forensics_root: Path) -> str:
    rows = [_row(path) for path in _records(forensics_root)]
    uncapturable = sum(1 for row in rows if row[1] == fa.UNCAPTURABLE)
    complete = len(rows) - uncapturable
    six_of_six = sum(1 for row in rows if row[3] == f"{len(fa.L0_REQUIRED_KEYS)}/{len(fa.L0_REQUIRED_KEYS)}")
    evidence_ok = sum(1 for row in rows if row[4] == "✓")
    purposes = {name: sum(1 for row in rows if row[2] == name) for name in fa.L0_PURPOSES}
    silent = len(rows) - sum(purposes.values())
    summary = (
        f"汇总：记录 {len(rows)} 份（不含 `_example.md`）；完整 {complete}／{fa.UNCAPTURABLE} {uncapturable}；"
        f"六键齐 {six_of_six} 份；evidence_id 合法 {evidence_ok} 份；用途 "
        + "／".join(f"{name} {count}" for name, count in purposes.items())
        + f"／未声明 {silent}。"
    )
    lines = [PREAMBLE, TABLE_HEADER, TABLE_SEPARATOR]
    lines += ["| " + " | ".join(row) + " |" for row in rows]
    lines += ["", summary]
    return "\n".join(lines) + "\n"


def _first_difference(expected: str, actual: str) -> str:
    exp = expected.splitlines()
    act = actual.splitlines()
    for i in range(max(len(exp), len(act))):
        left = act[i] if i < len(act) else "<已跟踪的文件到此结束>"
        right = exp[i] if i < len(exp) else "<现算的表到此结束>"
        if left != right:
            return f"第 {i + 1} 行起不同：已跟踪={left!r} 现算={right!r}"
    return "逐行相同，差异只在行尾或结尾换行"


def check(forensics_root: Path) -> tuple[int, str]:
    target = forensics_root / CENSUS_NAME
    expected = render(forensics_root)
    if not target.is_file():
        return 1, f"{target} 不存在：先跑 python -X utf8 tools/doc_tables.py --write"
    raw = target.read_bytes().replace(b"\r\n", b"\n")
    if raw.decode("utf-8", errors="replace") != expected:
        return 1, f"{CENSUS_NAME} 与现算的表不一致：{_first_difference(expected, raw.decode('utf-8', errors='replace'))}"
    return 0, f"doc tables: clean ({CENSUS_NAME})"


def main(argv: list[str] | None = None, forensics_root: Path | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    if forensics_root is None:
        forensics_root = Path(__file__).resolve().parent.parent / "forensics"
    if not args:
        args = ["--check"]
    if args not in (["--check"], ["--write"]):
        print("用法：python -X utf8 tools/doc_tables.py [--check|--write]", file=sys.stderr)
        return 2
    if args == ["--write"]:
        target = forensics_root / CENSUS_NAME
        target.write_bytes(render(forensics_root).encode("utf-8"))
        print(f"wrote {target}")
        return 0
    code, message = check(forensics_root)
    print(message, file=sys.stdout if code == 0 else sys.stderr)
    return code


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 4: 生成第一份生成物**

Run: `python -X utf8 tools/doc_tables.py --write`

Expected: 打印 `wrote …\forensics\l0-census.md`；文件里 32 行数据行＋1 行汇总。

- [ ] **Step 5: 跑测试确认绿**

Run:
```bash
python -X utf8 -m pytest tools/test_doc_tables.py -q
python -X utf8 tools/doc_tables.py --check; echo "RC=$?"
python -X utf8 tools/forensics_audit.py; echo "RC=$?"
```

Expected: `13 passed`（3 枚包装针＋10 枚生成器针，实测值）；`doc tables: clean (l0-census.md)` 且 `RC=0`；`forensics audit: clean` 且 `RC=0`。

- [ ] **Step 6: 提交**

```bash
git add tools/doc_tables.py tools/test_doc_tables.py forensics/l0-census.md
git commit -s -m "feat(docs): L0 普查表改由生成器写、由测试判陈旧（取代手打计数）"
```

---

### Task 3: CI 面与 README 指针

**Files:**
- Create: `.github/workflows/doc-tables.yml`
- Modify: `forensics/README.md`（只**插入**一条带日期的指针，不回改旧句）

**Interfaces:**
- Consumes: `tools/doc_tables.py --check`、`tools/test_doc_tables.py`、`tools/test_forensics_spec.py`。

- [ ] **Step 1: 写工作流**

创建 `.github/workflows/doc-tables.yml`：

```yaml
name: doc-tables

# Fork-owned，理由与 repowiki-freshness.yml 同源：pyproject.toml 的 testpaths 是
# "agent/tests"，上游永远不会收集 tools/ 下的测试；而 .github/workflows/test.yml 与
# tools/ci_grep_gates.sh 归上游所有、按本仓规则字节不动 —— 所以 fork 新增文件，
# 不去改别人的工作流。
#
# 两条判据：`--check` 判已跟踪的 forensics/l0-census.md 是否等于现算的表（归一化后
# 逐字节相等），pytest 判那把尺本身有分辨力（加一份记录表必须跟着变）。

on:
  push:
    paths:
      - 'forensics/**'
      - 'tools/doc_tables.py'
      - 'tools/test_doc_tables.py'
      - 'tools/forensics_audit.py'
      - '.github/workflows/doc-tables.yml'
  pull_request:
    paths:
      - 'forensics/**'
      - 'tools/doc_tables.py'
      - 'tools/test_doc_tables.py'
      - 'tools/forensics_audit.py'
      - '.github/workflows/doc-tables.yml'
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: doc-tables-${{ github.ref }}
  cancel-in-progress: true

jobs:
  census:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - uses: actions/setup-python@5fda3b95a4ea91299a34e894583c3862153e4b97 # v7.0.0
        with:
          python-version: "3.11"
      # 两套件按设计只依赖标准库 + pytest，不引入任何新的第三方依赖。
      - name: Install pytest only
        run: python -m pip install --upgrade pytest
      - name: Generated doc tables are up to date
        run: python -X utf8 tools/doc_tables.py --check
      # forensics 套件一并在同一趟跑：本工作流只在 forensics/** 与那两个工具文件变动时触发，
      # 而那正是审计契约最容易被碰坏的面。它在 CI 里没有任何 local_archive 依赖（现读 0 命中）。
      - name: Guards
        run: python -X utf8 -m pytest tools/test_doc_tables.py tools/test_forensics_spec.py -q
```

- [ ] **Step 2: 在本机模拟这条工作流的两步**

Run:
```bash
python -X utf8 tools/doc_tables.py --check; echo "RC=$?"
python -X utf8 -m pytest tools/test_doc_tables.py tools/test_forensics_spec.py -q
```

Expected: `RC=0`；`179 passed`（13＋166，实测值）。

- [ ] **Step 3: README 插入指针（bytes 层，保 CRLF）**

`forensics/README.md` 的那条 `浏览器：` 口径 bullet 之后、下一条 `parse_failures` bullet 之前，插入：

```
- 2026-10-28：上一句「25 份／23 份」是 2026-10-14 的一次性读数，不回改；`l0/` 的现量口径以
  `forensics/l0-census.md` 为准——那份表由 `python -X utf8 tools/doc_tables.py --write` 生成、
  `--check` 判陈旧（状态／用途／六键齐／`evidence_id` 合法／目标 host 类逐份可判）。
```

用 Python 按字节插入，保留该文件既有的 CRLF：

```bash
python -X utf8 - <<'PY'
from pathlib import Path
p = Path("forensics/README.md")
raw = p.read_bytes()
anchor = "- 正文任何位置出现 `parse_failures` 字样时".encode("utf-8")
crlf = b"\r\n" if b"\r\n" in raw else b"\n"
assert raw.count(anchor) == 1, "锚点不唯一，停手"
insert = crlf.join([
    "- 2026-10-28：上一句「25 份／23 份」是 2026-10-14 的一次性读数，不回改；`l0/` 的现量口径以".encode(),
    "  `forensics/l0-census.md` 为准——那份表由 `python -X utf8 tools/doc_tables.py --write` 生成、".encode(),
    "  `--check` 判陈旧（状态／用途／六键齐／`evidence_id` 合法／目标 host 类逐份可判）。".encode(),
]) + crlf
p.write_bytes(raw.replace(anchor, insert + anchor, 1))
PY
```

然后立刻验形状：

```bash
tr -cd '\r' < forensics/README.md | wc -c; tr -cd '\n' < forensics/README.md | wc -c
git diff --stat -- forensics/README.md
```

Expected: CR 数与 LF 数相等（每行都以 CRLF 结尾，无孤立 CR）；`git diff --stat` 显示 **3 行新增、0 行删除**。

- [ ] **Step 4: 复跑审计与生成器**

Run:
```bash
python -X utf8 tools/forensics_audit.py; echo "RC=$?"
python -X utf8 tools/doc_tables.py --check; echo "RC=$?"
```

Expected: 两条都 `clean`、`RC=0`（README 不在 `l0/` 里，不参与生成）。

- [ ] **Step 5: 提交**

```bash
git add .github/workflows/doc-tables.yml forensics/README.md
git commit -s -m "ci(docs): 生成表接一条 fork 自有工作流；README 只追加带日期指针不改旧读数"
```

---

### Task 4: 门册复跑与推送

**Files:** 无新增，只跑门与提交。

- [ ] **Step 1: 八腿门册逐腿点名**

按本仓既有脚本 `.superpowers/scratch/t187-merged-gates.sh` 的形状重跑八腿（它是 scratch，不在仓里，命令照下面这份清单执行；日志放仓库外临时目录）：

```bash
T=$(mktemp -d)
cd /e/Vibe-Trading-main/Vibe-Trading-main
python -X utf8 tools/forensics_audit.py                        >"$T/A.log" 2>&1; echo "A=$?"
python -X utf8 -m pytest tools/test_forensics_spec.py tools/test_doc_tables.py -q >"$T/B.log" 2>&1; echo "B=$?"
python -X utf8 -m pytest tools/test_wiki_drift.py tools/test_wiki_qmind.py tools/test_upstream_sync.py -q -m "not local_archive" >"$T/C.log" 2>&1; echo "C=$?"
python -X utf8 -m pytest tools/test_ci_env_var_gate.py tools/test_ci_private_files_gate.py -q >"$T/D.log" 2>&1; echo "D=$?"
bash tools/ci_grep_gates.sh                                    >"$T/E.log" 2>&1; echo "E=$?"
bash tools/wiki_freshness_gate.sh                              >"$T/F.log" 2>&1; echo "F=$?"
python -X utf8 -m pytest tools/test_wiki_drift.py -q -m "not local_archive" -k index >"$T/G.log" 2>&1; echo "G=$?"
python - <<'PY' >"$T/H.log" 2>&1; echo "H=$?"
import sys, yaml, pathlib
bad = []
for p in sorted(pathlib.Path(".github/workflows").glob("*.yml")):
    try:
        yaml.safe_load(p.read_text(encoding="utf-8"))
    except Exception as exc:
        bad.append(f"{p}: {exc}")
print("\n".join(bad) or "yaml ok")
sys.exit(1 if bad else 0)
PY
echo "T=$T"
```

Expected: 与开工前同形——E（grep 门）与 F（水位门）两枚恒红按构造归属（E 只红在未跟踪 scratch 面的商标命中，F 是 447 vs 439 的历史水位），其余全绿。**F 的红必须记录开工前读数并对照**：本片不新增任何 wiki 页面引用，红数不许变化；若变了，先查明再继续。

- [ ] **Step 2: 恒红两门的 0 贡献证明**

```bash
git diff --name-only origin/main..HEAD
grep -c 'tradingview' tools/doc_tables.py tools/test_doc_tables.py forensics/l0-census.md
```

Expected: 文件清单只含 `forensics/**`、`tools/forensics_audit.py`、`tools/doc_tables.py`、`tools/test_doc_tables.py`、`.github/workflows/doc-tables.yml`、`superpowers/**`、`项目档案.md`；三条 grep 计数都是 **0**（商标字面量在这三份新文件里零命中）。

- [ ] **Step 3: 推送前对真值**

```bash
git ls-remote origin refs/heads/main
git log --oneline -3
```

Expected: 远程 main 与本地 `origin/main` 一致；若 cron 已推进远程，按既有裁定走 `git merge --signoff --no-edit origin/main`（不 rebase），合并后用 `git merge-base --is-ancestor origin/main HEAD` 与 `HEAD^{tree}` 对账。

- [ ] **Step 4: 推送**

```bash
git push origin HEAD:main
```

- [ ] **Step 5: 读 CI**

推送后按新 head 读 `doc-tables` 工作流那一趟（匿名 `/actions/runs` ＋ `/jobs`），确认九腿里新腿绿；同时确认既有 `CI` 九腿读数与推送前同形。取不到名字就只报「绿／红＋run id」，不猜。

---

### Task 5: 档案落档

**Files:**
- Modify: `项目档案.md`（bytes 层追加一节，不改旧文）

- [ ] **Step 1: 追加一节**（标题沿既有编号，正文写：要治的痛＝`forensics/README.md` 那句 25/23 与现量 32；落地＝两个包装＋生成器＋生成物＋守卫＋CI 面；判据＝`--check` rc、11 枚针、166 不动、八腿同形；**不写任何「本文件 N 行」「HEAD=X」**）

- [ ] **Step 2: 改完复跑读档门**

```bash
python -X utf8 -m pytest tools/test_wiki_drift.py tools/test_wiki_qmind.py -q -m "not local_archive"
bash tools/wiki_freshness_gate.sh; echo "RC=$?"
tr -cd '\r' < 项目档案.md | wc -c; tr -cd '\n' < 项目档案.md | wc -c
```

Expected: 套件与追加前同绿；水位门红数与追加前**逐字相同**；CR 数＝LF 数。

- [ ] **Step 3: 提交并推送**

```bash
git add 项目档案.md
git commit -s -m "docs(archive): §7.32 落 G6——生成式数值表与它的一条 CI 面"
git push origin HEAD:main
```
