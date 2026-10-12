"""Contract tests for tools/forensics_audit.py.

Two failure directions matter here. A tree that is merely *missing* must skip
loudly (the skeleton is created in a later task, so "not yet" is a real state);
a tree that exists but is malformed must fail. The synthetic tmp_path trees
prove the auditor actually discriminates — a green run over an empty directory
would prove nothing at all.

Run with::

    pytest tools/test_forensics_spec.py -q
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from forensics_audit import (  # type: ignore[import-untyped]
    L0_PURPOSES,
    L0_REQUIRED_KEYS,
    SPEC_HEADER,
    _audit_l0,
    _audit_spec,
    _meta_keys,
    _outside_fences,
    audit_forensics,
)

EVID = "ev_" + "ab" * 32  # ev_ + 64 个十六进制字符

L0_BODY = f"""# L0：探针页面骨架

- 命令：npx -y rea-agents@latest inspect-web-page http://127.0.0.1:9222 TID1 --filter-output normalized_result
- evidence_id：{EVID}
- 浏览器：Edg/155.0.4283.45（protocol_version 1.3）
- 目标 URL：http://127.0.0.1:8077/
- 观察条件：headless=new；未点开任何菜单；未禁用优化
- 完整性：completeness.status=parsed；parse_failures 未出现

```json
"completeness": {{"status": "parsed"}}
```
"""


def _mk(base: Path, rel: str, text: str) -> Path:
    p = base / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8", newline="\n")
    return p


def _forensics(tmp_path: Path) -> Path:
    """docs/forensics/ inside a throwaway repo root, plus the probe fixture it hashes."""
    root = tmp_path / "docs" / "forensics"
    _mk(root, "l0/probe-skeleton.md", L0_BODY)
    app_dir = tmp_path / "tools" / "rea_probe_site"
    app_dir.mkdir(parents=True, exist_ok=True)
    (app_dir / "app.js").write_text("export const x = 1\n", encoding="utf-8", newline="\n")
    return root


def _l0(tmp_path: Path, text: str = L0_BODY, name: str = "probe-skeleton.md") -> tuple[Path, Path]:
    """(the L0 file, the repo root it is audited against)."""
    root = _forensics(tmp_path)
    path = root / "l0" / name
    path.write_text(text, encoding="utf-8", newline="\n")
    return path, tmp_path


def _drop_key(text: str, key: str) -> str:
    return "\n".join(
        line for line in text.splitlines() if not line.strip().startswith(f"- {key}：")
    ) + "\n"


def test_valid_l0_record_is_clean(tmp_path):
    path, repo = _l0(tmp_path)
    problems, _purpose = _audit_l0(path, "l0/probe-skeleton.md", repo)
    assert problems == []


def test_required_key_names_are_exactly_the_six():
    assert L0_REQUIRED_KEYS == ("命令", "evidence_id", "浏览器", "目标 URL", "观察条件", "完整性")
    assert L0_PURPOSES == ("harness", "规格", "基线")


@pytest.mark.parametrize("key", L0_REQUIRED_KEYS)
def test_each_required_key_is_named_when_missing(tmp_path, key):
    path, repo = _l0(tmp_path, _drop_key(L0_BODY, key))
    problems, _purpose = _audit_l0(path, "l0/probe-skeleton.md", repo)
    assert any(f"缺少必填键 {key}" in x for x in problems), problems


def test_empty_value_is_reported_separately(tmp_path):
    path, repo = _l0(tmp_path, L0_BODY.replace(
        "- 浏览器：Edg/155.0.4283.45（protocol_version 1.3）", "- 浏览器："))
    problems, _purpose = _audit_l0(path, "l0/probe-skeleton.md", repo)
    assert any("浏览器" in x and "值为空" in x for x in problems), problems


def test_placeholder_angle_brackets_are_refused(tmp_path):
    path, repo = _l0(tmp_path, L0_BODY.replace(
        "- 目标 URL：http://127.0.0.1:8077/", "- 目标 URL：<换成真实地址>"))
    problems, _purpose = _audit_l0(path, "l0/probe-skeleton.md", repo)
    assert any("目标 URL" in x and "占位符" in x for x in problems), problems


def test_evidence_id_must_have_the_shape(tmp_path):
    path, repo = _l0(tmp_path, L0_BODY.replace(EVID, "ev_123"))
    problems, _purpose = _audit_l0(path, "l0/probe-skeleton.md", repo)
    assert any("evidence_id 不是 ev_<64 位十六进制>" in x for x in problems), problems


def test_command_must_be_a_rea_command(tmp_path):
    path, repo = _l0(tmp_path, L0_BODY.replace("npx -y rea-agents@latest inspect-web-page", "curl inspect-web-page"))
    problems, _purpose = _audit_l0(path, "l0/probe-skeleton.md", repo)
    assert any("命令里没有 rea-agents" in x for x in problems), problems


def test_command_must_cap_its_own_output(tmp_path):
    path, repo = _l0(tmp_path, L0_BODY.replace(" --filter-output normalized_result", ""))
    problems, _purpose = _audit_l0(path, "l0/probe-skeleton.md", repo)
    assert any("--filter-output" in x and "--token-limit" in x for x in problems), problems


def test_parse_failures_must_be_explained(tmp_path):
    path, repo = _l0(tmp_path, L0_BODY.replace(
        '"completeness": {"status": "parsed"}',
        '"parse_failures": [{"reason": "timeout"}]',
    ).replace(
        "- 完整性：completeness.status=parsed；parse_failures 未出现",
        "- 完整性：completeness.status=parsed"))
    problems, _purpose = _audit_l0(path, "l0/probe-skeleton.md", repo)
    assert any("parse_failures" in x for x in problems), problems


def test_unusable_capture_needs_only_command_and_reason(tmp_path):
    text = (
        "# L0：画线工具目录\n\n"
        "- 命令：npx -y rea-agents@latest inspect-web-page http://127.0.0.1:9222 TID --token-limit 200\n"
        "- 状态：不可取证\n"
        "- 原因：headless 下工具条容器是空节点，页面对象自报反自动化拦截\n"
    )
    path, repo = _l0(tmp_path, text, name="tv-drawings.md")
    problems, purpose = _audit_l0(path, "l0/tv-drawings.md", repo)
    assert problems == []
    assert purpose is None


def test_unusable_capture_without_reason_fails(tmp_path):
    text = (
        "# L0：画线工具目录\n\n"
        "- 命令：npx -y rea-agents@latest inspect-web-page http://127.0.0.1:9222 TID --token-limit 200\n"
        "- 状态：不可取证\n"
    )
    path, repo = _l0(tmp_path, text, name="tv-drawings.md")
    problems, _purpose = _audit_l0(path, "l0/tv-drawings.md", repo)
    assert any("没有 原因：" in x for x in problems), problems


def test_unusable_capture_command_must_still_cap_output(tmp_path):
    """不可取证豁免的是六把键，不是命令卫生：Global Constraint 5 无条件生效。"""
    text = (
        "# L0：画线工具目录\n\n"
        "- 命令：npx -y rea-agents@latest inspect-web-page http://127.0.0.1:9222 TID\n"
        "- 状态：不可取证\n"
        "- 原因：headless 下工具条容器是空节点，页面对象自报反自动化拦截\n"
    )
    path, repo = _l0(tmp_path, text, name="tv-drawings.md")
    problems, purpose = _audit_l0(path, "l0/tv-drawings.md", repo)
    assert any("--filter-output" in x and "--token-limit" in x for x in problems), problems
    assert purpose is None


def test_harness_purpose_must_carry_the_current_probe_checksum(tmp_path):
    """反编造针的两个方向都要打到：校验和对 ⇒ 干净，校验和错 ⇒ 必须红。

    针要生效，_l0() 交回来的必须是真仓库根，否则 app.js 永远「不存在」。
    """
    _forensics(tmp_path)  # 先把 tmp_path 这棵假仓库（含 tools/rea_probe_site/app.js）建出来

    def body(digest: str) -> str:
        return L0_BODY + "- 用途：harness\n- 探针 app.js sha256：" + digest + "\n"

    app = tmp_path / "tools" / "rea_probe_site" / "app.js"
    want = hashlib.sha256(app.read_bytes().replace(b"\r\n", b"\n")).hexdigest()

    path, repo = _l0(tmp_path, body(want))
    problems, purpose = _audit_l0(path, "l0/probe-skeleton.md", repo)
    assert problems == [], problems
    assert purpose == "harness"

    path.write_text(body("0" * 64), encoding="utf-8", newline="\n")
    problems, _purpose = _audit_l0(path, "l0/probe-skeleton.md", repo)
    assert any("sha256" in x for x in problems), problems


def test_keys_inside_fenced_blocks_are_not_metadata(tmp_path):
    """REA 的 stdout 摘录里也会出现 `- 命令：…` 这种行，不能拿它充当记录头的键。"""
    body = "\n".join(
        line for line in L0_BODY.splitlines() if not line.strip().startswith("- 命令：npx")
    ) + "\n"
    body = body.replace("# L0：探针页面骨架\n", "# L0：探针页面骨架\n\n```text\n- 命令：伪造在代码块里\n```\n")
    path, repo = _l0(tmp_path, body)
    problems, _purpose = _audit_l0(path, "l0/probe-skeleton.md", repo)
    assert any("缺少必填键 命令" in x for x in problems), problems


def test_meta_keys_and_fence_helper_are_public(tmp_path):
    text = "```text\n- 甲：在块内\n```\n- 乙：在块外\n"
    assert _meta_keys(text) == {"乙": "在块外"}
    assert "- 甲：在块内" not in _outside_fences(text)


def test_missing_forensics_root_is_named(tmp_path):
    problems = audit_forensics(tmp_path / "docs" / "forensics", tmp_path)
    assert any("不存在：取证骨架还没建" in x for x in problems), problems


def test_empty_l0_dir_is_not_a_passing_tree(tmp_path):
    root = _forensics(tmp_path)
    (root / "l0" / "probe-skeleton.md").unlink()
    problems = audit_forensics(root, tmp_path)
    assert any("l0/ 下没有任何证据文件" in x for x in problems), problems


SPEC_ROW = (
    "| TV-DW-01 | 工具栏是一组横向并列的画线按钮，斐波那契需两点确定垂直范围 | "
    "inspect-web-page 的可达文本里 id=toolbar 容器下能数出 13 个按钮 | DOM | l0/probe-skeleton.md |"
)
SPEC_TABLE = f"""# 规格：画线面

{SPEC_HEADER}
|---|---|---|---|---|
{SPEC_ROW}
"""


def _with_spec(tmp_path: Path, text: str = SPEC_TABLE) -> tuple[Path, Path]:
    """(spec/drawings.md, the docs/forensics root that holds it)."""
    root = _forensics(tmp_path)
    return _mk(root, "spec/drawings.md", text), root


def test_valid_spec_table_is_clean(tmp_path):
    path, root = _with_spec(tmp_path)
    problems, cited, ids = _audit_spec(path, "spec/drawings.md", root)
    assert problems == []
    assert cited == {"probe-skeleton.md"}
    assert ids == ["TV-DW-01"]


def test_spec_header_must_be_verbatim(tmp_path):
    path, root = _with_spec(tmp_path, SPEC_TABLE.replace(SPEC_HEADER, "| 编号 | 句子 | 判据 | 类型 | 依据 |"))
    problems, _c, _i = _audit_spec(path, "spec/drawings.md", root)
    assert any("表头不是逐字的" in x for x in problems), problems


@pytest.mark.parametrize("bad_id", ["TV-DW-1", "tv-DW-01", "TV-dw-01", "TV-DW-001", "DW-01", ""])
def test_entry_id_shape(tmp_path, bad_id):
    path, root = _with_spec(tmp_path, SPEC_TABLE.replace("| TV-DW-01 |", f"| {bad_id} |"))
    problems, _c, _i = _audit_spec(path, "spec/drawings.md", root)
    assert any(f"条目号 {bad_id!r} 不符合" in x for x in problems), problems


def test_verdict_shorter_than_12_chars_is_not_a_verdict(tmp_path):
    path, root = _with_spec(tmp_path, SPEC_TABLE.replace(
        "inspect-web-page 的可达文本里 id=toolbar 容器下能数出 13 个按钮", "数一下"))
    problems, _c, _i = _audit_spec(path, "spec/drawings.md", root)
    assert any("判据短于 12 个字符" in x for x in problems), problems


@pytest.mark.parametrize("bad_type", ["视觉", "pixel", "", "DOM 或 状态"])
def test_verdict_type_domain(tmp_path, bad_type):
    # 单元格不能含 `|`：那会改行列数，红的是「列数不是 5」而不是判据类型域。
    path, root = _with_spec(tmp_path, SPEC_TABLE.replace("| DOM |", f"| {bad_type} |"))
    problems, _c, _i = _audit_spec(path, "spec/drawings.md", root)
    assert any("判据类型" in x and "不在 DOM/状态/像素 之内" in x for x in problems), problems


def test_basis_must_point_at_an_existing_l0(tmp_path):
    path, root = _with_spec(tmp_path, SPEC_TABLE.replace("l0/probe-skeleton.md", "l0/never-captured.md"))
    problems, _c, _i = _audit_spec(path, "spec/drawings.md", root)
    assert any("L0 依据 'l0/never-captured.md' 指向的文件不存在" in x for x in problems), problems


def test_basis_accepts_bare_name_and_multiple_refs(tmp_path):
    path, root = _with_spec(tmp_path, SPEC_TABLE.replace(
        "| DOM | l0/probe-skeleton.md |", "| DOM | probe-skeleton.md、l0/probe-skeleton.md |"))
    problems, cited, _i = _audit_spec(path, "spec/drawings.md", root)
    assert problems == []
    assert cited == {"probe-skeleton.md"}


def test_empty_basis_is_named(tmp_path):
    path, root = _with_spec(tmp_path, SPEC_TABLE.replace("| DOM | l0/probe-skeleton.md |", "| DOM |  |"))
    problems, _c, _i = _audit_spec(path, "spec/drawings.md", root)
    assert any("L0 依据是空的" in x for x in problems), problems


def test_duplicate_entry_id_in_one_table(tmp_path):
    path, root = _with_spec(tmp_path, SPEC_TABLE + SPEC_ROW + "\n")
    problems, _c, _i = _audit_spec(path, "spec/drawings.md", root)
    assert any("条目号 TV-DW-01 在 spec/drawings.md 里出现 2 次" in x for x in problems), problems


def test_row_with_wrong_column_count_is_not_dropped_silently(tmp_path):
    """少一列的行如果直接被解析丢掉，表就「空着也全绿」——必须报出来。"""
    broken = SPEC_ROW.rsplit("|", 2)[0] + "|"  # 砍掉最后一列
    assert broken.count("|") == 5
    path, root = _with_spec(tmp_path, SPEC_TABLE.replace(SPEC_ROW, broken))
    problems, _c, _i = _audit_spec(path, "spec/drawings.md", root)
    assert any("列数不是 5" in x for x in problems), problems


def test_audit_forensics_picks_up_spec_violations(tmp_path):
    root = _forensics(tmp_path)
    _mk(root, "spec/drawings.md", SPEC_TABLE.replace("| DOM |", "| 视觉 |"))
    problems = audit_forensics(root, tmp_path)
    assert any("spec/drawings.md" in x and "判据类型" in x for x in problems), problems
