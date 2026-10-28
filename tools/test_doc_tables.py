"""Guards for tools/doc_tables.py and the generated forensics/l0-census.md.

生成物只有一条诚实判据：**已跟踪的那份必须等于现算的那份**。所以这里先证明
「一把尺」——包装函数与审计的私有解析对整棵活树逐份一致；再证明「尺有分辨力」——
往临时语料加一份记录，表必须跟着变。只断言「文件存在」的守卫是恒真的静态图。

Run with::

    python -X utf8 -m pytest tools/test_doc_tables.py -q
"""

from __future__ import annotations

from pathlib import Path

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
