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
    ENTRY_ID,
    L0_PURPOSES,
    L0_REQUIRED_KEYS,
    MIN_VERDICT_LEN,
    SPEC_HEADER,
    VERDICT_TYPES,
    _audit_l0,
    _audit_spec,
    _meta_keys,
    _outside_fences,
    _resolve_l0,
    _table,
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


# ---------------------------------------------------------------------------
# 评审修复 I1（_resolve_l0）：`L0 依据` 必须指向存在的 **l0** 文件。
# 原实现 `forensics_root / ref` 认树下任何一份文件，还把 basename 当成引用的
# L0 文件名返回——`spec/drawings.md`（规格自引）当场全绿。
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("basis", ["spec/drawings.md", "gap-matrix.md"])
def test_basis_must_point_at_an_l0_file_not_at_any_existing_file(tmp_path, basis):
    """存在的非 l0 文件（自引／矩阵）不是证据：必须报，且不得进 `cited`。"""
    path, root = _with_spec(tmp_path, SPEC_TABLE.replace("l0/probe-skeleton.md", basis))
    if basis == "gap-matrix.md":
        _mk(root, "gap-matrix.md", "# 差距矩阵\n\n随手写的散文，没有表。\n")
    problems, cited, _i = _audit_spec(path, "spec/drawings.md", root)
    assert any(f"L0 依据 {basis!r} 指向的文件不存在" in x for x in problems), problems
    assert cited == set(), problems


def test_basis_reaching_out_of_the_forensics_root_is_reported(tmp_path):
    """`../outside.md` 落在 docs/ 里、取证根之外：同样不是 L0 证据。"""
    path, root = _with_spec(
        tmp_path, SPEC_TABLE.replace("l0/probe-skeleton.md", "../outside.md"))
    _mk(tmp_path / "docs", "outside.md", "在 forensics 根之外\n")
    problems, cited, _i = _audit_spec(path, "spec/drawings.md", root)
    assert any("L0 依据 '../outside.md'" in x for x in problems), problems
    assert cited == set(), problems


@pytest.mark.parametrize("basis", ["l0/probe-skeleton.md", "probe-skeleton.md"])
def test_the_two_accepted_l0_spellings_still_count(tmp_path, basis):
    """`l0/x.md` 与裸 `x.md` 两种写法都要继续认（修严不能修没）。"""
    path, root = _with_spec(
        tmp_path, SPEC_TABLE.replace("| DOM | l0/probe-skeleton.md |", f"| DOM | {basis} |"))
    problems, cited, _i = _audit_spec(path, "spec/drawings.md", root)
    assert problems == [], problems
    assert cited == {"probe-skeleton.md"}


# ---------------------------------------------------------------------------
# 评审修复 I2（_table 的分隔行判定）：`set(s) <= set("|-: ")` 连 `|  |  |  |  |  |`
# 也算分隔行，全空的数据行被静默丢掉——行行全空的表反而零违规。分隔行必含 `-`。
# ---------------------------------------------------------------------------

def test_all_blank_row_is_reported_not_dropped(tmp_path):
    """空行是写坏了的数据行，不是 `|---|` 分隔行：必须落到空单元格的判据上。"""
    blank = "|  |  |  |  |  |"
    path, root = _with_spec(tmp_path, SPEC_TABLE.replace(SPEC_ROW, blank))
    problems, cited, ids = _audit_spec(path, "spec/drawings.md", root)
    assert ids == [""], problems  # 行进了表，没被解析丢掉
    assert any("条目号 '' 不符合" in x for x in problems), problems
    assert any("判据短于 12 个字符" in x for x in problems), problems
    assert any("判据类型 '' 不在" in x for x in problems), problems
    assert any("L0 依据是空的" in x for x in problems), problems
    assert cited == set(), problems


def test_blank_row_beside_a_good_row_is_still_reported(tmp_path):
    """五列全空的行混在好行里也一样报，别让它当免费的一行蒙过去。"""
    path, root = _with_spec(tmp_path, SPEC_TABLE + "|  |  |  |  |  |\n")
    problems, cited, ids = _audit_spec(path, "spec/drawings.md", root)
    assert ids == ["TV-DW-01", ""], problems
    assert any("条目号 '' 不符合" in x for x in problems), problems
    assert cited == {"probe-skeleton.md"}, problems


# ---------------------------------------------------------------------------
# 评审修复 I3（_table 的 `seen` 闩锁）：表头一旦出现过，`seen` 就永远是真，
# 文件里后面每张 `|` 表都被当成规格行 ⇒ 幻影违规。表 = 逐字表头开头的那一段
# **连续** `|` 行；第一条非 `|` 行（散文／标题／空行）关掉窗口。
# 选定的行为：同一文件里第二张「同逐字表头」的规格表照样解析（表头重开窗口），
# 但两张表的条目号合并成**文件作用域**查重——与消息文案「在 {rel} 里」一致。
# ---------------------------------------------------------------------------

NOTES_TABLE = (
    "| 面 | 条目数 | 判据 | 状态 | 说明 |\n"
    "|---|---|---|---|---|\n"
    "| DW | 1 | 只是统计数字 | 完成 | 这张表跟规格条目无关 |\n"
)


def test_a_second_unrelated_table_below_the_spec_table_is_not_spec_content(tmp_path):
    """规格表＋散文＋一张不相干的五列表：后面的表不是条目，不得产出违规。"""
    path, root = _with_spec(tmp_path, SPEC_TABLE + "\n## 备注\n\n一段散文，不属于任何表。\n\n" + NOTES_TABLE)
    problems, cited, ids = _audit_spec(path, "spec/drawings.md", root)
    assert problems == [], problems
    assert cited == {"probe-skeleton.md"}
    assert ids == ["TV-DW-01"]


def test_prose_between_the_header_rows_and_a_later_table_closes_the_window(tmp_path):
    """行和行之间夹散文也一样关窗口：只有连续的 `|` 行算这张表的行。"""
    text = (
        f"{SPEC_HEADER}\n|---|---|---|---|---|\n{SPEC_ROW}\n\n先写点说明文字。\n\n" + NOTES_TABLE
    )
    path, root = _with_spec(tmp_path, text)
    problems, _cited, ids = _audit_spec(path, "spec/drawings.md", root)
    assert problems == [], problems
    assert ids == ["TV-DW-01"]


def test_second_spec_shaped_table_is_parsed_and_dups_stay_file_scoped(tmp_path):
    """逐字表头重开第二张规格表 ⇒ 行合并、条目号按文件查重（选定行为的钉子）。"""
    text = (
        SPEC_TABLE + "\n## 第二批条目\n\n"
        f"{SPEC_HEADER}\n|---|---|---|---|---|\n{SPEC_ROW}\n"
    )
    path, root = _with_spec(tmp_path, text)
    problems, cited, ids = _audit_spec(path, "spec/drawings.md", root)
    assert ids == ["TV-DW-01", "TV-DW-01"], problems
    assert any("条目号 TV-DW-01 在 spec/drawings.md 里出现 2 次" in x for x in problems), problems
    assert cited == {"probe-skeleton.md"}, problems


# ---------------------------------------------------------------------------
# 评审修复 I4：L1 的四个契约常量逐字钉住，跟 Task 1 的
# `test_required_key_names_are_exactly_the_six` 同一个套路。
# `SPEC_TABLE = f"...{SPEC_HEADER}..."` 是拿常量插出来的，夹具会跟着实现一起漂：
# 把表头改成 `|条目号|规格句|判据|判据类型|L0 依据|`（去空格）实测 51 条全绿。
# 另外三个常量今天只会「顺带红」——`test_entry_id_shape`／`test_verdict_type_domain`／
# `test_verdict_shorter_than_12_chars…` 断言的是拿同一批常量拼出来的消息子串，
# 常量一改子串跟着改，红不红取决于夹具而不是契约。逐字钉住才是契约级的针。
# ---------------------------------------------------------------------------

def test_l1_contract_constants_are_verbatim():
    assert SPEC_HEADER == "| 条目号 | 规格句 | 判据 | 判据类型 | L0 依据 |"
    assert ENTRY_ID.pattern == r"TV-[A-Z][A-Z0-9]*-\d{2}"
    assert VERDICT_TYPES == ("DOM", "状态", "像素")
    assert MIN_VERDICT_LEN == 12


# ---------------------------------------------------------------------------
# 修复轮 2 · R1（`_table` 的窗口连续性造出的新静默丢弃）：round 1 关掉行窗口以后，
# 窗口之外的 `|` 行被直接 `continue`——既不进 ``rows`` 也不进 ``bad``，实测
#   表头 + 空行 + 分隔行 + 一条合法行 ⇒ _table = (True, [], [])
#                               _audit_spec = ([], set(), [])
# 零条目、零违规、空 `cited` 的假绿，违反本 Task 的「列数不对的行不许被静默丢掉」，
# 而且空 `cited`/`ids` 会把 Task 3 的跨层规则喂成假红。
# 选定规则（写在 `_table` 的 docstring 里）：表头**之后**、窗口之外的 `|` 行，只有
# 首格整段匹配 ``ENTRY_ID`` 的那一种算「掉出窗口的疑似规格行」，原文进 ``bad``；
# 散文里的普通 Markdown 表（首格是「面」／「DW」）一概不碰，表头之前的行也不碰
# （defer 的 rows-above-header）。``_audit_spec`` 再按列数把 ``bad`` 分派成两条
# 消息：列数确实不是 5 的照旧报「列数不是 5」，正好五列的报「落在窗口之外」。
# ---------------------------------------------------------------------------

def test_blank_line_between_header_and_rows_is_not_a_green_document(tmp_path):
    """(a) 表头与行之间夹了空行：文档不得审计为绿，违规要点名这个文件。"""
    text = f"{SPEC_HEADER}\n\n|---|---|---|---|---|\n{SPEC_ROW}\n"
    path, root = _with_spec(tmp_path, text)
    problems, cited, ids = _audit_spec(path, "spec/drawings.md", root)
    assert problems, "零条目零违规地过审就是本轮要关的假绿"
    assert any("spec/drawings.md" in x and "窗口之外" in x for x in problems), problems
    # 选定的 plumbing：窗口外的疑似行不进 rows（不重复计数条目号），只进 bad。
    assert ids == [] and cited == set(), problems
    _seen, rows, bad = _table(text, SPEC_HEADER)
    assert rows == [], rows
    assert bad == [SPEC_ROW], bad


def test_orphaned_entry_shaped_row_outside_the_window_is_reported(tmp_path):
    """(b) 掉出窗口的四列行：与紧挨着表的同一条行同样报「列数不是 5」，不许消失。"""
    broken = "| TV-DW-02 | 短句 | 短 | DOM |"
    text = f"{SPEC_HEADER}\n|---|---|---|---|---|\n{SPEC_ROW}\n\n{broken}\n"
    path, root = _with_spec(tmp_path, text)
    problems, _c, ids = _audit_spec(path, "spec/drawings.md", root)
    assert ids == ["TV-DW-01"], problems
    assert any(
        "spec/drawings.md" in x and "列数不是 5" in x and broken in x for x in problems
    ), problems


def test_window_orphan_report_is_gated_on_the_entry_id_shape(tmp_path):
    """首格不像条目号的窗口外表（I3 的备注／统计表）继续零违规——门禁不许扩到散文表。"""
    text = SPEC_TABLE + "\n## 备注\n\n" + NOTES_TABLE.replace(
        "| DW | 1 | 只是统计数字 | 完成 | 这张表跟规格条目无关 |",
        "| TV-DW-99 | 条目数 | 判据 | 状态 | 说明 |")
    path, root = _with_spec(tmp_path, text)
    problems, _cited, ids = _audit_spec(path, "spec/drawings.md", root)
    assert ids == ["TV-DW-01"], problems
    assert any("窗口之外" in x and "TV-DW-99" in x for x in problems), problems
    plain = SPEC_TABLE + "\n## 备注\n\n" + NOTES_TABLE
    path2, root2 = _with_spec(tmp_path, plain)
    assert _audit_spec(path2, "spec/other.md", root2) == ([], {"probe-skeleton.md"}, ["TV-DW-01"])


def test_rows_above_the_header_stay_out_of_this_round(tmp_path):
    """R1 只覆盖「表头之后」的窗口外行；表头之前的行是 defer 的 rows-above-header，
    本轮不顺手修。这根针钉住边界（修前修后都绿），不是认可那种写法。"""
    path, root = _with_spec(
        tmp_path, f"{SPEC_ROW}\n\n{SPEC_HEADER}\n|---|---|---|---|---|\n")
    problems, _c, _i = _audit_spec(path, "spec/drawings.md", root)
    assert problems == [], problems


# ---------------------------------------------------------------------------
# 修复轮 2 · R2（`_resolve_l0` 把审计器打崩）：`except OSError` 接不住
# `Path.resolve()` 对含 NUL 字节的路径抛的 `ValueError: stat: embedded null
# character in path`（实测），而 `_read` 的 errors="replace" 会把那种字节原样
# 读进来——一格坏依据于是让 `main` 吐回溯而不是列违规，正好把本模块存在的理由
# （「树存在但畸形 ⇒ 报违规」）反写成「崩」。坏路径当作没找到，落到既有的
# 「指向的文件不存在」上。
# ---------------------------------------------------------------------------

def test_nul_byte_in_basis_is_a_violation_not_a_traceback(tmp_path):
    """一格 NUL 字节要红，但只能红在违规上：`_resolve_l0`／`_audit_spec` 都不许抛。"""
    path, root = _with_spec(
        tmp_path, SPEC_TABLE.replace("l0/probe-skeleton.md", "probe\x00skeleton.md"))
    assert _resolve_l0(root, "probe\x00skeleton.md") is None  # 修前：这里抛 ValueError
    problems, cited, _i = _audit_spec(path, "spec/drawings.md", root)
    assert any(
        "spec/drawings.md" in x and "L0 依据" in x and "指向的文件不存在" in x for x in problems
    ), problems
    assert cited == set(), problems
    assert any("指向的文件不存在" in x for x in audit_forensics(root, tmp_path))


# ---------------------------------------------------------------------------
# 修复轮 2 · R3（`_resolve_l0` 的 docstring 过强）：round 1 的文本写
# 「``../x.md``／绝对路径这种越出取证根的写法，一律返回 None」，实测三条都不成立
# ——裸名候选先把 ``ref`` 折成末段，所以带目录的写法只要末段在 l0/ 里存在就命中：
#   _resolve_l0(root, 'C:/elsewhere/probe-skeleton.md') -> 'probe-skeleton.md'
#   _resolve_l0(root, '/elsewhere/probe-skeleton.md')   -> 'probe-skeleton.md'
#   _resolve_l0(root, '../probe-skeleton.md')           -> 'probe-skeleton.md'
# 落点仍在 ``forensics_root/l0/`` 之内 ⇒ I1 的信条没破、没有假绿，但那句话是错的。
# 本轮只改文字不改行为：下面的行为针把现状钉住（本 slice 的后续任务引用这套解析
# 语义，修前修后都绿），文本针保证那句过强的话不被写回去。
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("basis", [
    "C:/elsewhere/probe-skeleton.md",
    "/elsewhere/probe-skeleton.md",
    "../probe-skeleton.md",
])
def test_a_ref_whose_basename_exists_in_l0_is_accepted(tmp_path, basis):
    """真实规则：只看落点在不在 ``l0/`` 里——带目录的写法被裸名候选折成末段。"""
    path, root = _with_spec(tmp_path, SPEC_TABLE.replace("l0/probe-skeleton.md", basis))
    assert _resolve_l0(root, basis) == "probe-skeleton.md"
    problems, cited, _i = _audit_spec(path, "spec/drawings.md", root)
    assert problems == [], problems
    assert cited == {"probe-skeleton.md"}


def test_resolve_l0_docstring_states_the_real_rule():
    """文本针：docstring 描述必须与实测一致——过强的「一律返回 None」不许留着。"""
    doc = _resolve_l0.__doc__ or ""
    assert "forensics_root/l0/" in doc  # 唯一的判据是落点
    assert "一律返回 None" not in doc, doc
    assert "末段" in doc or "basename" in doc, doc  # 要解释带目录的写法为何命中
