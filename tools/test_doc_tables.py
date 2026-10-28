"""Guards for tools/doc_tables.py and the generated forensics/l0-census.md.

生成物只有一条诚实判据：**已跟踪的那份必须等于现算的那份**。所以这里先证明
「一把尺」——包装函数与审计的私有解析对整棵活树逐份一致；再证明「尺有分辨力」——
往临时语料加一份记录，表必须跟着变。只断言「文件存在」的守卫是恒真的静态图。

Run with::

    python -X utf8 -m pytest tools/test_doc_tables.py -q
"""

from __future__ import annotations

import re
import shutil
import subprocess
import sys
from pathlib import Path

import doc_tables
import forensics_audit as fa

REPO = Path(__file__).resolve().parent.parent
FORENSICS = REPO / "forensics"
L0_DIR = FORENSICS / "l0"
CENSUS = FORENSICS / "l0-census.md"
KINDS = frozenset({"三方", "自家", "其他", "无 URL"})
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
    assert doc_tables.main(["--check"], forensics_root=root) == 1, "没有生成物时 --check 必须红"
    assert doc_tables.main(["--write"], forensics_root=root) == 0
    assert doc_tables.main(["--check"], forensics_root=root) == 0

    census = root / doc_tables.CENSUS_NAME
    census.write_bytes(census.read_bytes().replace(b"6/6", b"0/6", 1))
    assert doc_tables.main(["--check"], forensics_root=root) == 1, "改一个字节后 --check 必须红"


def test_check_is_eol_insensitive_on_a_crlf_checkout(tmp_path: Path) -> None:
    root = _census_root(tmp_path, {"a.md": SAMPLE})
    assert doc_tables.main(["--write"], forensics_root=root) == 0
    census = root / doc_tables.CENSUS_NAME
    census.write_bytes(census.read_bytes().replace(b"\n", b"\r\n"))
    assert doc_tables.main(["--check"], forensics_root=root) == 0, "CRLF 工作树不许判陈旧"


def test_cli_on_the_real_repo_is_clean() -> None:
    got = subprocess.run(
        [sys.executable, "-X", "utf8", str(REPO / "tools" / "doc_tables.py"), "--check"],
        cwd=REPO,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
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
