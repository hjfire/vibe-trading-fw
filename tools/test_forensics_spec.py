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
import os
import subprocess
from pathlib import Path

import pytest

from forensics_audit import (  # type: ignore[import-untyped]
    COORD,
    ENTRY_ID,
    L0_PURPOSES,
    L0_REQUIRED_KEYS,
    MATRIX_HEADER,
    MATRIX_PRIORITIES,
    MATRIX_STATUSES,
    MIN_VERDICT_LEN,
    PROBE_APP_JS,
    S3_HOST_FILE,
    SPEC_HEADER,
    TV_HOST_ALLOWLIST,
    TV_SUPPORT_HOST_LINE,
    TV_WIDGET_SRC_LINE,
    UNCAPTURABLE,
    VERDICT_TYPES,
    _audit_l0,
    _audit_spec,
    _meta_keys,
    _outside_fences,
    _resolve_l0,
    _table,
    audit_forensics,
    audit_tv_host_allowlist,
    main,
)

EVID = "ev_" + "ab" * 32  # ev_ + 64 个十六进制字符
# 校验和的期望值从这里算，不从 app.js 的读路径算（修复轮 F3）：`want =
# sha256(app.read_bytes()…)` 拿被验证的那条表达式当基准，实现漂了针跟着漂，
# 于是两根校验和针都在追踪实现而不是拒绝实现。夹具写的就是这串字节。
PROBE_APP_JS_LF = b"export const x = 1\n"

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

# F3-2：`_tree()` 之外新造的「第二份记录」（`loose.md` 那一族）的主键，逐字等于 `L0_BODY`
# 只是换了 `evidence_id`。老针 `test_harness_purpose_exempts_an_uncited_l0`／
# `test_baseline_purpose_exempts_an_uncited_l0` 钉的是「孤证规则给 用途 让路」，不是「允许两份
# 记录共用主键」；原夹具直接抄 `L0_BODY` 才顺带造出一枚重复主键。重复主键这把尺现在不吃
# 用途 豁免，所以改的是**夹具数据**（换一枚独立主键），两根老针的 `== []` 断言一字未动。
LOOSE_EVID = "ev_" + "cd" * 32
LOOSE_BODY = L0_BODY.replace(EVID, LOOSE_EVID)

UNCAPTURABLE_BODY = (
    "# L0：画线工具目录\n\n"
    "- 命令：npx -y rea-agents@latest inspect-web-page http://127.0.0.1:9222 TID --token-limit 200\n"
    "- 状态：不可取证\n"
    "- 原因：headless 下工具条容器是空节点，页面对象自报反自动化拦截\n"
)


def _mk(base: Path, rel: str, text: str) -> Path:
    p = base / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8", newline="\n")
    return p


def _forensics(tmp_path: Path) -> Path:
    """forensics/ inside a throwaway repo root, plus the probe fixture it hashes."""
    root = tmp_path / "forensics"
    _mk(root, "l0/probe-skeleton.md", L0_BODY)
    app_dir = tmp_path / "tools" / "rea_probe_site"
    app_dir.mkdir(parents=True, exist_ok=True)
    (app_dir / "app.js").write_bytes(PROBE_APP_JS_LF)
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
    path, repo = _l0(tmp_path, UNCAPTURABLE_BODY, name="tv-drawings.md")
    problems, purpose = _audit_l0(path, "l0/tv-drawings.md", repo)
    assert problems == []
    assert purpose == UNCAPTURABLE


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
    assert purpose == UNCAPTURABLE


def test_harness_purpose_must_carry_the_current_probe_checksum(tmp_path):
    """反编造针的两个方向都要打到：校验和对 ⇒ 干净，校验和错 ⇒ 必须红。

    针要生效，_l0() 交回来的必须是真仓库根，否则 app.js 永远「不存在」。
    期望值取自夹具的字面字节（F3）：读 app.js 再哈希的话，这条针就成了
    「实现怎么算我就怎么断言」，改实现改针都不红。
    """
    _forensics(tmp_path)  # 先把 tmp_path 这棵假仓库（含 tools/rea_probe_site/app.js）建出来

    def body(digest: str) -> str:
        return L0_BODY + "- 用途：harness\n- 探针 app.js sha256：" + digest + "\n"

    want = hashlib.sha256(PROBE_APP_JS_LF).hexdigest()

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
    problems = audit_forensics(tmp_path / "forensics", tmp_path)
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
    """(spec/drawings.md, the forensics root that holds it)."""
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
# 修复轮 1 · F1（评审 I5）：样例豁免件不能当**真实条目**的 L0 依据。
# `_resolve_l0` 只认落点，而 `l0/_example.md` 确实是 l0/ 下一个真文件，所以改之前
# 一条真实 TV 条目把依据写成 `_example.md`（那份记录是**本地探针页**的 A1，跟
# tradingview.com 没有任何关系）照样判合法；又因为 `audit_forensics` 早在走查时把
# `_example.md` 从 l0／spec 两个名单里滤掉，孤证规则根本看不见它——这个洞是**静默**的。
# 规则只加这一条，语义要留白给样例自己：`spec/_example.md`（在 `SPEC_EXEMPT` 内）
# 引 `_example.md` 仍然合法。三根针各自的可红方向：真文件指豁免件⇒红、样例自己指⇒绿、
# 真实记录指⇒绿（第三根证明针不是「只要引用就红」）。
# ---------------------------------------------------------------------------

def _with_sample_basis(tmp_path: Path, spec_name: str = "drawings.md") -> tuple[Path, Path]:
    """规格条目把依据写成豁免件 `_example.md`，且那份 l0 样例记录在这棵树上真实存在。"""
    root = _forensics(tmp_path)
    _mk(root, "l0/_example.md", L0_BODY)
    text = SPEC_TABLE.replace("| DOM | l0/probe-skeleton.md |", "| DOM | _example.md |")
    return _mk(root, f"spec/{spec_name}", text), root


def test_real_spec_entry_must_not_cite_the_exempt_sample_record(tmp_path):
    path, root = _with_sample_basis(tmp_path)
    problems, cited, _i = _audit_spec(path, "spec/drawings.md", root)
    assert any("落在样例豁免件上" in x and "条目 TV-DW-01" in x for x in problems), problems
    assert cited == set(), problems  # 豁免件也不许进 cited：它不是被抓出来的证据


def test_the_sample_spec_file_may_still_cite_the_sample_record(tmp_path):
    """豁免面不咬自己人：规格文件自己就是 SPEC_EXEMPT 的那一份，引 _example.md 仍然合法。"""
    path, root = _with_sample_basis(tmp_path, spec_name="_example.md")
    problems, _cited, _i = _audit_spec(path, "spec/_example.md", root)
    assert problems == [], problems


def test_citing_a_real_capture_is_not_the_new_violation(tmp_path):
    root = _forensics(tmp_path)
    _mk(root, "l0/_example.md", L0_BODY)  # 豁免件就在树上，引用它隔壁那份真实记录
    path = _mk(root, "spec/drawings.md", SPEC_TABLE)
    problems, cited, _i = _audit_spec(path, "spec/drawings.md", root)
    assert not any("落在样例豁免件上" in x for x in problems), problems
    assert cited == {"probe-skeleton.md"}, problems


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


# ---------------------------------------------------------------------------
# Task 3（L2 差距矩阵＋三层咬合）：一条规格恰好对一行矩阵，「已有／部分」必须指到
# 本仓真实存在的 file:line，「缺」要留下能复跑的 needle，没被引用的证据要么当
# harness 要么当基线。本层的测试全部走 audit_forensics，不直接调 _audit_matrix——
# 要钉的就是跨文件咬合；单层判据在 L0／L1 的既有测试里已经打过了。
# 夹具的三件事都必要：_forensics() 造 tools/rea_probe_site/app.js（harness 校验和针
# 要读它），_tree() 造 frontend/src/lib/chartDrawings.ts（矩阵坐标针要读它），_mk()
# 统一处理父目录与 LF 换行。少了前两样，针会因为「文件不存在」而红，掩盖真判据。
# ---------------------------------------------------------------------------

MATRIX_ROW = "| TV-DW-01 | 已有 | frontend/src/lib/chartDrawings.ts:2 | - | 本仓有同类工具目录 |"
MATRIX_TABLE = f"""# 差距矩阵

{MATRIX_HEADER}
|---|---|---|---|---|
{MATRIX_ROW}
"""
COORD_FILE = "frontend/src/lib/chartDrawings.ts"


def _tree(tmp_path: Path, spec: str | None = SPEC_TABLE, matrix: str | None = MATRIX_TABLE) -> Path:
    """A complete, valid tree: one L0 + one spec row + one matrix row + the cited source file."""
    root = _forensics(tmp_path)
    if spec is not None:
        _mk(root, "spec/drawings.md", spec)
    if matrix is not None:
        _mk(root, "gap-matrix.md", matrix)
    _mk(tmp_path, COORD_FILE, "one\ntwo\nthree\n")
    return root


def test_whole_tree_is_clean(tmp_path):
    assert audit_forensics(_tree(tmp_path), tmp_path) == []


def test_every_spec_id_needs_exactly_one_matrix_row(tmp_path):
    root = _tree(tmp_path, matrix=None)
    problems = audit_forensics(root, tmp_path)
    assert any("有 1 条规格条目但 forensics/gap-matrix.md 不存在" in x for x in problems), problems


def test_matrix_without_a_header_row_is_named(tmp_path):
    root = _tree(tmp_path, matrix="# 差距矩阵\n\n随手写的散文，没有表。\n")
    problems = audit_forensics(root, tmp_path)
    assert any("gap-matrix.md: 表头不是逐字的" in x for x in problems), problems


def test_missing_matrix_row_is_named(tmp_path):
    problems = audit_forensics(_tree(tmp_path, matrix=MATRIX_TABLE.replace(MATRIX_ROW, "")), tmp_path)
    assert any("TV-DW-01 在矩阵里出现 0 次" in x for x in problems), problems


def test_duplicate_matrix_row_is_named(tmp_path):
    problems = audit_forensics(_tree(tmp_path, matrix=MATRIX_TABLE + MATRIX_ROW + "\n"), tmp_path)
    assert any("TV-DW-01 在矩阵里出现 2 次" in x for x in problems), problems


def test_phantom_matrix_row_is_named(tmp_path):
    problems = audit_forensics(_tree(tmp_path, matrix=MATRIX_TABLE.replace("TV-DW-01", "TV-ZZZ-99")), tmp_path)
    assert any("TV-ZZZ-99 在任何规格文件里都不存在" in x for x in problems), problems


def test_same_entry_id_in_two_spec_files_is_named(tmp_path):
    root = _tree(tmp_path)
    _mk(root, "spec/interaction.md", SPEC_TABLE)
    problems = audit_forensics(root, tmp_path)
    assert any("spec/interaction.md: 条目号 TV-DW-01 已在 spec/drawings.md 里出现过" in x for x in problems), problems


@pytest.mark.parametrize("bad", ["有", "部分实现", "", "缺憾"])
def test_matrix_status_domain(tmp_path, bad):
    problems = audit_forensics(_tree(tmp_path, matrix=MATRIX_TABLE.replace("| 已有 |", f"| {bad} |", 1)), tmp_path)
    assert any("状态" in x and "不在 已有/部分/缺/不可复刻 之内" in x for x in problems), problems


@pytest.mark.parametrize("bad", ["P0", "", "很高"])
def test_matrix_priority_domain(tmp_path, bad):
    problems = audit_forensics(_tree(tmp_path, matrix=MATRIX_TABLE.replace("| - |", f"| {bad} |", 1)), tmp_path)
    assert any("优先级" in x and "不在 高/中/低/- 之内" in x for x in problems), problems


def test_empty_note_is_named(tmp_path):
    problems = audit_forensics(
        _tree(tmp_path, matrix=MATRIX_TABLE.replace("| 本仓有同类工具目录 |", "|  |")), tmp_path)
    assert any("说明是空的" in x for x in problems), problems


@pytest.mark.parametrize("bad", ["chartDrawings.ts", "frontend/src/lib/chartDrawings.ts", "x.ts:abc"])
def test_existing_status_needs_file_line_shape(tmp_path, bad):
    problems = audit_forensics(
        _tree(tmp_path, matrix=MATRIX_TABLE.replace(f"| {COORD_FILE}:2 |", f"| {bad} |")), tmp_path)
    assert any("要给本仓坐标 file:line" in x for x in problems), problems


def test_coordinate_file_must_exist(tmp_path):
    root = _tree(tmp_path, matrix=MATRIX_TABLE.replace(COORD_FILE, "frontend/src/lib/nope.ts"))
    problems = audit_forensics(root, tmp_path)
    assert any("坐标 frontend/src/lib/nope.ts:2 的文件不存在" in x for x in problems), problems


def test_coordinate_line_must_be_within_the_file(tmp_path):
    _mk(tmp_path, "short.ts", "one\n")
    root = _tree(tmp_path, matrix=MATRIX_TABLE.replace(f"{COORD_FILE}:2", "short.ts:9"))
    problems = audit_forensics(root, tmp_path)
    assert any("行号 9 超出 short.ts 的实际 1 行" in x for x in problems), problems


def test_missing_status_needs_a_rerunnable_needle(tmp_path):
    problems = audit_forensics(_tree(
        tmp_path, matrix=MATRIX_TABLE.replace(f"| 已有 | {COORD_FILE}:2 |", "| 缺 | 没有这个东西 |")), tmp_path)
    assert any("要以 未找到： 开头" in x for x in problems), problems


def test_missing_status_with_empty_needle_is_named(tmp_path):
    problems = audit_forensics(_tree(
        tmp_path, matrix=MATRIX_TABLE.replace(f"| 已有 | {COORD_FILE}:2 |", "| 缺 | 未找到： |")), tmp_path)
    assert any("needle 为空" in x for x in problems), problems


def test_uncited_l0_without_purpose_is_named(tmp_path):
    root = _tree(tmp_path)
    _mk(root, "l0/loose.md", L0_BODY)
    path = root / "l0" / "loose.md"
    _problems, purpose = _audit_l0(path, "l0/loose.md", tmp_path)
    assert purpose is None  # 「完整记录但没写 用途」必须是 None，不能和 UNCAPTURABLE 同值
    problems = audit_forensics(root, tmp_path)
    assert any("loose.md: 没有被任何规格条目引用" in x for x in problems), problems


def test_harness_purpose_exempts_an_uncited_l0(tmp_path):
    """孤证规则给 用途：harness 让路；第三段是 CRLF 腿（F3 恢复被删掉的那一段）。

    校验和的两个方向由 Task 1 的 test_harness_purpose_must_carry_the_current_probe_
    checksum 钉，这里不重复。本机 core.autocrlf=true 且仓库根没有 .gitattributes
    （实测），checkout 出来的 app.js 就是 CRLF —— 行尾不是证据的一部分，摘掉
    _audit_l0 的 replace(b"\\r\\n", b"\\n") 这根针要红。

    F3-2：夹具从 `L0_BODY` 换成 `LOOSE_BODY`（逐字同一份记录，只换 `evidence_id`），
    因为重复主键那把尺现在不吃 用途 豁免；`== []` 这两行断言一字未动。
    """
    root = _tree(tmp_path)
    app = tmp_path / "tools" / "rea_probe_site" / "app.js"
    want = hashlib.sha256(PROBE_APP_JS_LF).hexdigest()
    _mk(root, "l0/loose.md", LOOSE_BODY + "\n- 用途：harness\n" + f"\n探针 app.js 的当前 sha256：{want}\n")
    assert audit_forensics(root, tmp_path) == []

    app.write_bytes(PROBE_APP_JS_LF.replace(b"\n", b"\r\n"))  # 同一个文件按 CRLF 落盘
    assert app.read_bytes().count(b"\r") == 1, app.read_bytes()  # 前提：磁盘上真的是 CRLF
    assert audit_forensics(root, tmp_path) == []


def test_baseline_purpose_exempts_an_uncited_l0(tmp_path):
    root = _tree(tmp_path)
    _mk(root, "l0/loose.md", LOOSE_BODY + "\n- 用途：基线\n")  # 夹具换主键，断言一字未动（F3-2）
    assert audit_forensics(root, tmp_path) == []


def test_uncapturable_l0_is_not_an_orphan(tmp_path):
    """一条 `状态：不可取证` 的记录不是一份「没被引用的证据」——它记的是一面拿不到判据的面。

    孤证规则今天把它算进 `purposes`（`_audit_l0` 为它提前 `return (v, None)`，调用方无条件
    登记），只要规格侧真解析出条目号就报红。而 P1 批次 A 会同时交出规格表与两页需登录的
    不可取证记录，那两条红没有出路：给它们编条目撞「写不出判据不算条目」红线，
    把它们标 `用途：基线` 又撞「提前 return 根本不读 用途 键」。

    判别力在配对上：如果修法退化成「`purpose is None` 一律放行」，
    ``test_uncited_l0_without_purpose_is_named``（一份完整记录但没写 用途，同样是 None）就红。
    """
    root = _tree(tmp_path)
    _mk(root, "l0/tv-a12-pine-editor.md", UNCAPTURABLE_BODY)
    problems = audit_forensics(root, tmp_path)
    assert not any("没有被任何规格条目引用" in x for x in problems), problems


def test_example_files_are_exempt_by_exact_name(tmp_path):
    root = _tree(tmp_path)
    _mk(root, "l0/_example.md", "- 命令：随便\n")
    _mk(root, "spec/_example.md", "随便一张表\n")
    assert audit_forensics(root, tmp_path) == []


# ---------------------------------------------------------------------------
# brief 清单之外、三条裁定各自需要的针（不钉就等于没钉）：L2 契约常量逐字钉住
# （理由同 I4——夹具会跟着实现漂）；``bad`` 的两种成因按列数分派（裁定 1）；矩阵
# 走查不被 ``if spec_ids:`` 跳过，孤证规则也不拿规格侧的格式失败去 blame 证据
# （裁定 2）；三种用途只豁免两种。
# ---------------------------------------------------------------------------

def test_l2_contract_constants_are_verbatim():
    assert MATRIX_HEADER == "| 条目号 | 状态 | 本仓坐标或搜索记录 | 优先级 | 说明 |"
    assert MATRIX_STATUSES == ("已有", "部分", "缺", "不可复刻")
    assert MATRIX_PRIORITIES == ("高", "中", "低", "-")
    assert COORD.pattern == r"[\w./-]+:\d+"


def test_matrix_row_with_wrong_column_count_is_named_by_column_count(tmp_path):
    """少一列的行如果被丢掉，矩阵就「空着也全绿」——这一种成因才配「列数不是 5」。"""
    broken = MATRIX_ROW.rsplit("|", 2)[0] + "|"  # 砍掉最后一列
    assert broken.count("|") == 5
    root = _tree(tmp_path, matrix=MATRIX_TABLE.replace(MATRIX_ROW, broken))
    problems = audit_forensics(root, tmp_path)
    assert any("gap-matrix.md" in x and "列数不是 5" in x and broken in x for x in problems), problems


def test_matrix_row_outside_the_window_is_not_called_a_column_problem(tmp_path):
    """裁定 1：五列齐全、只是掉出窗口的行，拿「列数不是 5」描述它就是在撒谎。"""
    root = _tree(tmp_path, matrix=f"# 差距矩阵\n\n{MATRIX_HEADER}\n\n|---|---|---|---|---|\n{MATRIX_ROW}\n")
    problems = audit_forensics(root, tmp_path)
    assert any("gap-matrix.md" in x and "窗口之外" in x and MATRIX_ROW in x for x in problems), problems
    assert not any("列数不是 5" in x for x in problems), problems


def test_blank_matrix_row_is_reported_not_dropped(tmp_path):
    """全空的行不是 `|---|` 分隔行：条目号／状态／优先级／说明四条判据都要落到它身上。"""
    root = _tree(tmp_path, matrix=MATRIX_TABLE + "|  |  |  |  |  |\n")
    problems = audit_forensics(root, tmp_path)
    assert any("条目号 '' 不符合" in x for x in problems), problems
    assert any("状态 '' 不在 已有/部分/缺/不可复刻 之内" in x for x in problems), problems
    assert any("优先级 '' 不在 高/中/低/- 之内" in x for x in problems), problems
    assert any("说明是空的" in x for x in problems), problems


def test_matrix_is_audited_even_when_no_spec_id_was_parsed(tmp_path):
    """裁定 2：``if spec_ids:`` 会把整张矩阵的判据一起跳过——规格表写坏时矩阵仍要走查。"""
    root = _tree(
        tmp_path,
        spec=f"{SPEC_HEADER}\n\n|---|---|---|---|---|\n{SPEC_ROW}\n",
        matrix=MATRIX_TABLE.replace("| 已有 |", "| 有 |", 1),
    )
    problems = audit_forensics(root, tmp_path)
    # 前提也要钉（修复轮 M9）：这条针的红靠「规格侧一个条目号都没解析出来」，
    # 那个状态本身得有个断言看着，否则夹具一漂它就变成了「两边都绿」的空针。
    assert any("spec/drawings.md" in x and "窗口之外" in x for x in problems), problems
    assert not any("规格条目 TV-DW-01 在矩阵里出现" in x for x in problems), problems
    assert any("状态 '有' 不在 已有/部分/缺/不可复刻 之内" in x for x in problems), problems


def test_broken_spec_table_does_not_make_the_orphan_rule_blame_the_l0(tmp_path):
    """裁定 2：规格侧的格式失败要说在规格侧，不能造出一条「没人引用这份证据」。"""
    root = _tree(tmp_path, spec=f"{SPEC_HEADER}\n\n|---|---|---|---|---|\n{SPEC_ROW}\n")
    problems = audit_forensics(root, tmp_path)
    assert any("spec/drawings.md" in x and "窗口之外" in x for x in problems), problems
    assert not any("没有被任何规格条目引用" in x for x in problems), problems


def test_spec_purpose_does_not_exempt_an_uncited_l0(tmp_path):
    """harness／基线两种用途让路，规格那种不让：标了 用途：规格 却没人引用，照样是孤证。"""
    root = _tree(tmp_path)
    _mk(root, "l0/loose.md", L0_BODY + "\n- 用途：规格\n")
    problems = audit_forensics(root, tmp_path)
    assert any("loose.md: 没有被任何规格条目引用" in x for x in problems), problems


# ---------------------------------------------------------------------------
# 修复轮 1 的针（评审 F1／F2／F4／F5／M8）。F1 那两根钉的是**已有**行为没被任何针
# 看着（摘掉 `部分`／把那一枝 widen 成 `status != "缺"` 都 94/94 绿），所以它们到达
# 时是绿的，靠变异自证证明会咬；F2／F4／F5／M8 那五组钉的是**当下错**的行为，到达即红。
# 措辞判据：违规要说清哪儿不对（仓外／指着取证文档自己／行号越界），不许一句「不存在」糊过去。
# ---------------------------------------------------------------------------

def test_partial_status_needs_a_coordinate_too(tmp_path):
    """F1：`部分` 也是本仓的声称，坐标格空着必须是违规——今天没有任何针写过 `部分` 的行。"""
    problems = audit_forensics(
        _tree(tmp_path, matrix=MATRIX_TABLE.replace(
            f"| 已有 | {COORD_FILE}:2 |", "| 部分 | 抄了一半，说不清在哪 |")),
        tmp_path)
    assert any("状态 部分 要给本仓坐标 file:line" in x for x in problems), problems


def test_irreproducible_status_needs_no_coordinate(tmp_path):
    """F1：`不可复刻` 是设计里的第四态（spec §4：三态＋不可复刻），坐标格空着要过审；
    那一枝被 widen 成 ``status != "缺"`` 就会把它判成缺坐标 ⇒ 这根针红。"""
    root = _tree(tmp_path, matrix=MATRIX_TABLE.replace(f"| 已有 | {COORD_FILE}:2 |", "| 不可复刻 |  |"))
    assert audit_forensics(root, tmp_path) == []


@pytest.mark.parametrize("kind", ["relative", "unc"])
def test_coordinate_must_point_inside_the_repo(tmp_path, kind):
    """F2：「本仓坐标」的落点必须在仓库根之内。`repo_root / f` 能把 `../x`／UNC 指到
    仓外（实测 ``../OUTSIDE_target.txt:3`` 整棵树零违规），仓外的一份文件冒充本仓实现。
    """
    outside = "rea-forensics-outside-target.txt"  # 落在 tmp_path 之外（pytest 的上一级临时目录）
    _mk(tmp_path.parent, outside, "a\nb\nc\n")
    coord = f"../{outside}:3" if kind == "relative" else "//server/share/x.txt:1"
    problems = audit_forensics(
        _tree(tmp_path, matrix=MATRIX_TABLE.replace(f"| {COORD_FILE}:2 |", f"| {coord} |")), tmp_path)
    assert any("仓库根之外" in x for x in problems), problems
    # 落点检查在存在性检查之前：仓外那份文件不会被读，也就不许说它「不存在」。
    assert not any("坐标" in x and "文件不存在" in x for x in problems), problems


@pytest.mark.parametrize("cell", ["forensics/gap-matrix.md:1", "forensics/l0/probe-skeleton.md:1"])
def test_coordinate_cannot_certify_a_funnel_document(tmp_path, cell):
    """F2：漏斗产物不能自证——矩阵给自己发「已有」（或指着 L0 记录）都不是本仓实现。"""
    problems = audit_forensics(
        _tree(tmp_path, matrix=MATRIX_TABLE.replace(f"| {COORD_FILE}:2 |", f"| {cell} |")), tmp_path)
    assert any("取证漏斗自己的文档" in x for x in problems), problems


@pytest.mark.parametrize("ln", ["0", "00", "0000"])
def test_coordinate_line_number_starts_at_one(tmp_path, ln):
    """F2：行号域是 1..行数。今天只挡「大于行数」，`:0`／`:0000` 是任何文件里都不存在的
    一行，照样过审（实测零违规）。
    """
    problems = audit_forensics(
        _tree(tmp_path, matrix=MATRIX_TABLE.replace(f"{COORD_FILE}:2", f"{COORD_FILE}:{ln}")), tmp_path)
    assert any(f"行号 {ln} 不在 1..3 之内" in x for x in problems), problems  # chartDrawings.ts 是 3 行


def test_absurd_line_number_is_a_violation_not_a_traceback(tmp_path):
    """F5：4301 位的行号让 `int(ln)` 抛 ValueError（Python 3.11 的 4300 位上限），回溯穿出
    `audit_forensics`／`main()`，前面已经收集到的违规一条也不打印。
    """
    root = _tree(
        tmp_path, matrix=MATRIX_TABLE.replace("chartDrawings.ts:2", "chartDrawings.ts:" + "9" * 4301))
    _mk(root, "l0/extra.md", L0_BODY)  # 一条本已收集到的违规：修前它跟回溯一起丢
    problems = audit_forensics(root, tmp_path)
    short = [x[:100] for x in problems]  # 行号本身四千多位，失败输出里截断它
    assert any("行号" in x and f"超出 {COORD_FILE} 的实际 3 行" in x for x in problems), short
    assert any("extra.md: 没有被任何规格条目引用" in x for x in problems), short
    assert not any(len(x) > 500 for x in problems), [len(x) for x in problems]  # 消息别把四千位数字整个印出来


def test_a_format_failure_in_one_spec_file_silences_the_orphan_rule(tmp_path):
    """F4：孤证那道门只挡了「一个条目号都没解析出来」那半边。两份规格文件里坏一份时
    `spec_ids` 仍非空，于是 l0/extra.md 照样被 blame（实测「窗口之外」与「没有被任何
    规格条目引用」同出）——规格层的格式失败一律不许下引用结论。
    """
    root = _tree(tmp_path)  # spec/drawings.md 是合法的，所以 spec_ids 非空
    _mk(root, "spec/extra.md", f"{SPEC_HEADER}\n\n|---|---|---|---|---|\n{SPEC_ROW}\n")
    _mk(root, "l0/extra.md", L0_BODY)
    problems = audit_forensics(root, tmp_path)
    assert any("spec/extra.md" in x and "窗口之外" in x for x in problems), problems
    assert not any("l0/extra.md: 没有被任何规格条目引用" in x for x in problems), problems


def test_phantom_row_with_an_empty_entry_id_says_empty(tmp_path):
    """M8：空首格落到凭空条目那条消息上是两个空格（「矩阵里的  在任何规格文件里…」）。"""
    problems = audit_forensics(_tree(tmp_path, matrix=MATRIX_TABLE + "|  |  |  |  |  |\n"), tmp_path)
    assert any("矩阵里的 (空) 在任何规格文件里都不存在" in x for x in problems), problems
    assert not any("矩阵里的  " in x for x in problems), problems


# ---------------------------------------------------------------------------
# Task 4（TradingView 主机红线）：spec 裁定 1 的第三条硬线是「TradingView 接口不作为
# 运行时依赖」。判据是**集合相等**不是「零出现」——本仓 frontend/src 今天就有 5 个文件
# 含 tradingview.com（pages/TVChart.tsx 是官方 embed-widget 集成），零出现的门一落地就
# 恒红。新增＝把外部站点接成了依赖；消失＝白名单该同步收紧，两种都要人看一眼。
# 活树针 test_current_repo_passes_the_host_red_line 打的是真仓库，其余主机判据针打
# tmp_path 假树；段末另有 main() 的组合针与四个契约常量的逐字钉。
# ---------------------------------------------------------------------------

def _src(repo_root: Path, rel: str, text: str) -> Path:
    """rel is repo-relative, e.g. frontend/src/lib/x.ts."""
    return _mk(repo_root, rel, text)


def _fake_tv_tree(tmp_path: Path) -> None:
    """Reproduce today's real shape: 5 allowlisted files mention tradingview.com, one hosts s3."""
    for rel in sorted(TV_HOST_ALLOWLIST):
        _src(tmp_path, rel, 'const h = "tradingview.com";\n')
    _src(tmp_path, "frontend/src/pages/TVChart.tsx",
         "const widget = {\n"
         '  support_host: "https://www.tradingview.com",\n'
         "};\n"
         "const script = document.createElement('script');\n"
         'script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";\n')


def test_current_repo_passes_the_host_red_line():
    repo_root = Path(__file__).resolve().parents[1]
    assert audit_tv_host_allowlist(repo_root) == []


def test_new_tradingview_host_file_is_refused(tmp_path):
    _fake_tv_tree(tmp_path)
    _src(tmp_path, "frontend/src/lib/tvFetch.ts", 'const u = "https://scanner.tradingview.com/";\n')
    problems = audit_tv_host_allowlist(tmp_path)
    assert any("白名单不符" in x and "frontend/src/lib/tvFetch.ts" in x for x in problems), problems


def test_disappearing_allowlist_entry_is_also_reported(tmp_path):
    _fake_tv_tree(tmp_path)
    (tmp_path / "frontend/src/lib/pineLang.ts").unlink()
    problems = audit_tv_host_allowlist(tmp_path)
    assert any("白名单不符" in x and "pineLang.ts" in x for x in problems), problems


def test_s3_host_outside_the_widget_file_is_refused(tmp_path):
    _fake_tv_tree(tmp_path)
    _src(tmp_path, "frontend/src/lib/sneaky.ts", 'const s = "https://s3.tradingview.com/x.js";\n')
    problems = audit_tv_host_allowlist(tmp_path)
    assert any("s3.tradingview 只允许出现在" in x and "lib/sneaky.ts" in x for x in problems), problems


def test_pinned_widget_lines_are_checked_verbatim(tmp_path):
    _fake_tv_tree(tmp_path)
    _src(tmp_path, "frontend/src/pages/TVChart.tsx", 'const nothing = 1;\n')
    problems = audit_tv_host_allowlist(tmp_path)
    assert any("support_host" in x for x in problems), problems
    assert any("s3.tradingview.com/external-embedding" in x for x in problems), problems


def test_non_ts_files_are_not_scanned(tmp_path):
    """F2-6② 之后这根针钉的是**文档／语料不进主机白名单这把尺**，不再是「非 TS 一律不扫」。

    2026-10-14 终席裁定（A-I4 只取半）：`.js/.jsx/.mjs/.cjs/.html/.htm/.css/.json/.svg`
    已纳入同一把集合等式尺（见 `test_tv_host_in_a_non_ts_code_file_is_now_scanned`），
    `.md`／`.pine`／第三方语料继续不进——把 `frontend/src/**/*.md` 里一句「tradingview.com」
    当成运行时依赖，就是把「写文档」变成违规（现读活树正好有 1 个这样的 `.md`）。
    这根针改动的只有注释与覆盖面（多钉一把 `.pine`）；断言方向没动：文档里的字样
    既不产「新增」也不产「消失」，白名单等式照样成立。
    """
    _fake_tv_tree(tmp_path)
    _src(tmp_path, "frontend/src/notes.md", "讲讲 tradingview.com 的设计取舍\n")
    _src(tmp_path, "frontend/src/pine/idea.pine", 'study("tradingview.com")\n')
    assert audit_tv_host_allowlist(tmp_path) == []


def test_missing_frontend_src_is_named(tmp_path):
    assert audit_tv_host_allowlist(tmp_path) != []


def test_main_runs_both_audits(tmp_path, capsys):
    """main() 的替换体：两支审计都要跑，打印的就是违规行本身（每支各验一个红方向）。

    夹具全是既有的，四段各钉一条边：``_tree()`` 造一棵合规的 forensics，它的
    frontend/src 只有不含 tradingview.com 的 chartDrawings.ts ⇒ 第一段的红只能来自主机
    侧（实测：main 漏掉 audit_tv_host_allowlist 时这里红）；``_fake_tv_tree()`` 把主机
    侧补齐成今天的形状 ⇒ 第二段两支都绿；第三段只把规格表的判据类型改坏、主机侧保持
    干净 ⇒ 红只能来自取证侧，且输出里不再出现主机那条（实测：main 漏掉 audit_forensics
    时第三段红）。
    """
    root = _tree(tmp_path)
    assert main(tmp_path) == 1
    assert "白名单不符" in capsys.readouterr().out
    _fake_tv_tree(tmp_path)
    assert main(tmp_path) == 0
    assert "forensics audit: clean" in capsys.readouterr().out
    _mk(root, "spec/drawings.md", SPEC_TABLE.replace("| DOM |", "| 视觉 |"))
    assert main(tmp_path) == 1
    out = capsys.readouterr().out
    assert "判据类型" in out and "白名单不符" not in out, out


# ---------------------------------------------------------------------------
# 四个契约常量逐字钉住（同 I4／L2 那两根的理由）：``_fake_tv_tree`` 是拿
# ``sorted(TV_HOST_ALLOWLIST)`` 插出夹具的，两条逐字行也嵌在夹具自己的字面字节里，
# 所以常量漂移时假树侧要么跟着漂、要么只报一条难读的「与白名单不符」；实测两根针
# 都追不上契约变更——TV_HOST_ALLOWLIST 多一条路径时只有活树针红（变异 G），
# TV_SUPPORT_HOST_LINE 改成单引号时
# test_pinned_widget_lines_are_checked_verbatim 照样绿，因为它断言的是实现回显进消息
# 的子串（变异 H）。这条针让改白名单／改主机串的人当场看到「契约变了」。
# ---------------------------------------------------------------------------

def test_tv_host_contract_constants_are_verbatim():
    assert TV_HOST_ALLOWLIST == frozenset({
        "frontend/src/components/chat/PineScriptViewer.tsx",
        "frontend/src/lib/__tests__/scriptExchange.test.ts",
        "frontend/src/lib/pineLang.ts",
        "frontend/src/lib/scriptLibrary.ts",
        "frontend/src/pages/TVChart.tsx",
    })
    assert S3_HOST_FILE == "frontend/src/pages/TVChart.tsx"
    assert TV_SUPPORT_HOST_LINE == 'support_host: "https://www.tradingview.com"'
    assert TV_WIDGET_SRC_LINE == (
        'script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js"'
    )


# ---------------------------------------------------------------------------
# Task 4 修复轮 1（T4-F1／T4-F2 ＋ Minor3）：红线不能对着它自己存在的理由静默失明。
# 两个坏方向都是本机实测复现过的：单文件读不动 ⇒ PermissionError 穿出
# audit_tv_host_allowlist 也穿出 main()，前面 collected 的违规一条都不打印；子目录列不
# 出来 ⇒ Path.rglob 在内部吞掉 PermissionError 并跳过该目录，审计照样返回 []，main()
# 印 clean。权限夹具只准作用在 tmp_path 下，绝不打仓库路径。
# ---------------------------------------------------------------------------

def _deny_read(path: Path, *, directory: bool = False) -> bool:
    """Make ``path`` unreadable for the current user. Return True only when the condition
    measurably took hold — a silently-ineffective fixture is how a permission test lies.

    Windows: icacls /deny works without elevation (verified on this machine).
    posix: chmod 000. NEVER call this on a repo path; tmp_path only.
    """
    if os.name == "nt":
        perm = "(RX)" if directory else "(R)"
        subprocess.run(
            ["icacls", str(path), "/deny", f"{os.environ['USERNAME']}:{perm}"],
            capture_output=True, check=False,
        )
    else:
        path.chmod(0o000)
    if directory:
        try:
            list(path.iterdir())
        except OSError:
            return True
        return False
    try:
        path.read_bytes()
    except OSError:
        return True
    return False


def _restore_read(path: Path) -> None:
    """Always run this in a finally: an unrestored deny leaves tmp_path undeletable."""
    if os.name == "nt":
        subprocess.run(["icacls", str(path), "/reset"], capture_output=True, check=False)
    else:
        path.chmod(0o755 if path.is_dir() else 0o644)


def test_unreadable_allowlist_file_is_a_violation_not_a_blind_spot(tmp_path):
    _fake_tv_tree(tmp_path)
    victim = tmp_path / "frontend/src/lib/pineLang.ts"
    if not _deny_read(victim):
        _restore_read(victim)
        pytest.skip("本机造不出「文件存在但读不动」的条件")
    try:
        problems = audit_tv_host_allowlist(tmp_path)   # 修前：PermissionError 直接穿出
    finally:
        _restore_read(victim)
    assert any("pineLang.ts" in x and "读不出来" in x for x in problems), problems


def test_unlistable_directory_under_frontend_src_is_named(tmp_path):
    _fake_tv_tree(tmp_path)
    hidden = tmp_path / "frontend/src/lib/hidden"
    hidden.mkdir(parents=True)
    (hidden / "tvFetch.ts").write_bytes(b'const u = "https://scanner.tradingview.com/";\n')
    if not _deny_read(hidden, directory=True):
        _restore_read(hidden)
        pytest.skip("本机造不出「目录列不出来」的条件")
    try:
        problems = audit_tv_host_allowlist(tmp_path)   # 修前：[]，红线静默报干净
    finally:
        _restore_read(hidden)
    assert any("hidden" in x and "列不出来" in x for x in problems), problems


def test_missing_frontend_src_names_the_missing_directory(tmp_path):
    # 伴随针：test_missing_frontend_src_is_named 只看 != []，摘掉早退也照样绿（它会被别的规则填上）。
    assert any("不存在：无法核对" in x for x in audit_tv_host_allowlist(tmp_path))


def test_mixed_case_host_is_not_a_free_pass(tmp_path):
    _fake_tv_tree(tmp_path)
    _src(tmp_path, "frontend/src/lib/tvFetch.ts", 'const u = "https://Scanner.TradingView.com/";\n')
    problems = audit_tv_host_allowlist(tmp_path)
    assert any("白名单不符" in x and "tvFetch.ts" in x for x in problems), problems


def test_mixed_case_s3_host_is_still_counted_outside_the_widget_file(tmp_path):
    _fake_tv_tree(tmp_path)
    _src(tmp_path, "frontend/src/lib/sneaky.ts", 'const s = "https://S3.TradingView.com/x.js";\n')
    problems = audit_tv_host_allowlist(tmp_path)
    assert any("s3.tradingview 只允许出现在" in x and "lib/sneaky.ts" in x for x in problems), problems


REPO_ROOT = Path(__file__).resolve().parents[1]
LIVE_FORENSICS = REPO_ROOT / "forensics"
live_forensics = pytest.mark.skipif(
    not LIVE_FORENSICS.is_dir(),
    reason="forensics/ 还没建（Task 5 之前这是真状态）——大声 skip，不是通过",
)


@live_forensics
def test_live_forensics_tree_is_clean():
    assert audit_forensics(LIVE_FORENSICS, REPO_ROOT) == []


@live_forensics
def test_live_forensics_tree_is_not_vacuous():
    """全绿也可能什么都没测：一棵只有一张空表的树和一棵没捕过的树都返回 []。"""
    captured = [p for p in (LIVE_FORENSICS / "l0").glob("*.md") if p.name != "_example.md"]
    assert len(captured) >= 3, captured


@live_forensics
def test_live_example_files_use_the_contract_shape():
    """_example.md 被审计豁免，所以它的形状只能在这里单独钉——钉法是**让样例走一遍真规则**。

    修复轮 1（评审 I3／I4／N3）：旧针自己重写子串判断，5 样形状只钉住 3 样——评审席拿变异体
    实测过：判据类型改成「可达性」、判据那一格改成单字「空」、条目号改名 TV-ZZZ-99，三种都
    照样绿（`_example.md` 永远豁免，真规则碰不到它，而针又没复刻真规则）；六把键那根还
    不分围栏，把 `- 命令：` 整行删掉它才红，把同一串塞进 ```text 摘录块里它照样绿。
    现在这四段全由校验器自己的函数裁决：``_audit_spec`` 管表头逐字／条目号形状与值／
    判据 ≥MIN_VERDICT_LEN／判据类型域／L0 依据落点与豁免，``_audit_l0`` 按围栏感知的
    ``_meta_keys`` 查六把必填键并跑命令卫生。两个签名的第 3 个参数不是一回事：
    ``_audit_spec`` 收 ``forensics_root``，``_audit_l0`` 收 ``repo_root``——传串了 l0 那半边
    就看不见 ``tools/rea_probe_site/app.js``。
    ``spec/_example.md`` 的 `L0 依据` 那一格写的就是 `_example.md`，所以
    ``problems == []`` 同时是 F1 那条新规则「豁免面不咬自己人」的活树读数。
    """
    spec_path = LIVE_FORENSICS / "spec" / "_example.md"
    l0_path = LIVE_FORENSICS / "l0" / "_example.md"
    l0 = l0_path.read_text(encoding="utf-8")

    problems, _cited, ids = _audit_spec(spec_path, "spec/_example.md", LIVE_FORENSICS)
    assert problems == [], problems
    assert ids == ["TV-EX-01"], ids  # 钉值，不只钉「恰好一个」

    l0_problems, _purpose = _audit_l0(l0_path, "l0/_example.md", REPO_ROOT)
    assert l0_problems == [], l0_problems

    # 显式补的那一格：真规则只查判据类型的**域**（DOM／状态／像素）与判据长度，
    # 这里要钉的是样例用的是**哪一把**——换成「状态」校验器不红，可后来人抄走的形状就变了。
    _seen, rows, _bad = _table(spec_path.read_text(encoding="utf-8"), SPEC_HEADER)
    assert len(rows) == 1, rows
    _eid, _sentence, verdict, vtype, basis = rows[0]
    assert vtype == "DOM", vtype
    assert len(verdict) >= MIN_VERDICT_LEN, verdict
    assert basis == "_example.md", basis  # 这一格换成实抓记录，上面那条 F1 豁免读数就悄悄没针了

    # F4（评审 N3）：样例件第 9 行那串探针校验和过去没有任何东西复验——它故意不写 `用途：`
    # （写了会撞孤证规则）＋文件名豁免 ⇒ forensics_audit 的反编造针两道门都不走，app.js 一改
    # 它就变成静默的旧断言。期望值必须**现算**，不许把 62ea3b37… 抄成字面量（那等于用被验证
    # 的表达式当基准）；口径与校验器同尺：LF 归一。
    probe = (REPO_ROOT / PROBE_APP_JS).read_bytes().replace(b"\r\n", b"\n")
    assert hashlib.sha256(probe).hexdigest() in l0, PROBE_APP_JS


# ---------------------------------------------------------------------------
# F2（门与测试席，任务 #137）· 评审 A 的 C1(i)／C1(ii)／I1／I2
# 这四条都是**漏报**判据：`audit_forensics` 对文件内容零判据（base64 载荷、三方页标记
# 正文）、L1 整层为空时门禁沉默（零条目全绿）、重复 `evidence_id` 无人查。
# 每条都是先写针（当趟读到 RED）再写实现；红绿两根针成对出现，绿的这根证明判据不是
# 「只要出现这个词就红」。硬纪律：不钉任何计数不变量，钉的是**形状**与**规则**。
# ---------------------------------------------------------------------------

B64_PAYLOAD = "Q" * 300  # 一段图像本体的形状（base64 字母表，200 字符以上）

TV_URL_LINE = "- 目标 URL：https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL"
SELF_URL_LINE = "- 目标 URL：http://localhost:5899/pro-chart"
MARKUP_EXCERPT = '```html\n<!DOCTYPE html>\n<html lang="en"><div class="tv-toolbar-button">\n```\n'


def _l0_with_url(body: str, url_line: str) -> str:
    return body.replace("- 目标 URL：http://127.0.0.1:8077/", url_line)


def test_l0_must_not_carry_an_image_payload(tmp_path):
    """C1(i)：`data_base64` 后面跟着一长串载荷 ⇒ 图像本体进仓了，一字节都不许。"""
    body = L0_BODY + f'\n```json\n"data_base64": "{B64_PAYLOAD}"\n```\n'
    path, repo = _l0(tmp_path, body)
    problems, _purpose = _audit_l0(path, "l0/probe-skeleton.md", repo)
    assert any("图像本体" in x and "三键" in x for x in problems), problems


def test_a_data_base64_key_name_without_a_payload_is_still_clean(tmp_path):
    """C1(i) 的绿方向：键名与说明（活树 9 处就是这个形状）不是载荷，不得红。"""
    body = L0_BODY + '\n```json\n"data_base64": "（载荷不进仓）"\n```\n- 说明：data_base64 只落 sha256 三键\n'
    path, repo = _l0(tmp_path, body)
    problems, _purpose = _audit_l0(path, "l0/probe-skeleton.md", repo)
    assert problems == [], problems


@pytest.mark.parametrize("marker", [
    '<!DOCTYPE html>\n<html lang="en">\n',
    '<!doctype html>\n<HTML>\n',
    '<div class="tv-chart-view__legend">\n',
])
def test_third_party_page_markup_in_a_tv_record_is_refused(tmp_path, marker):
    """C1(ii)：`目标 URL` 是 tradingview.com 的记录里出现标记正文（大小写都判）⇒ 红。"""
    body = _l0_with_url(L0_BODY, TV_URL_LINE) + "```html\n" + marker + "```\n"
    path, repo = _l0(tmp_path, body)
    problems, _purpose = _audit_l0(path, "l0/tv-a1-page.md", repo)
    assert any("标记正文" in x and "tradingview.com" in x for x in problems), problems


def test_the_same_markup_on_a_self_page_record_is_not_the_new_violation(tmp_path):
    """C1(ii) 的绿方向：与上面逐字同一份正文，只差 `目标 URL` ——自家页／探针页合法有标记。

    这对针的差**只能来自 `目标 URL`**：harness／自家 dev server 的页面上本来就有标记，
    拿同一把尺去量它就把「观察自己的页面」变成了违规。
    """
    body = _l0_with_url(L0_BODY, SELF_URL_LINE) + "```html\n" + MARKUP_EXCERPT
    path, repo = _l0(tmp_path, body)
    problems, _purpose = _audit_l0(path, "l0/self-dw07-pixel-equality.md", repo)
    assert problems == [], problems


# --- F3-1（控制席探针 P-C）：这把尺的作用域判的是 **host**，不是子串。 ----------------
# `目标 URL` 是「散文＋说明」混排的一行，不是纯 URL：活树实测 2 份自家页记录合法地在值里
# 写着「**自家 dev server，不是 tradingview.com**」这句免责声明（`self-dw07-pixel-equality.md`
# 与 `self-ci07-panel-toggle.md`），旧实现那句 `TV_PAGE_HOST in keys.get("目标 URL", "").lower()`
# 拿子串量散文行 ⇒ 把它们当成三方页记录 ⇒ 自家页标记一进仓就判「不拷第三方标记正文」，
# 而那句话对 host 是 `localhost:5899` 的记录是**假的**。下面两根针的观测量只能来自 host
# 判定：换回子串判定它们立刻红（F3 报告 §变异 第 1 行）。
OWN_PAGE_URL_LINE = (
    "- 目标 URL：http://localhost:5899/pro-chart（**自家 dev server，不是 tradingview.com**；"
    "当趟 stdout 的 target 块回声同一 url 与 origin http://localhost:5899）"
)
PROBE_PAGE_URL_LINE = "- 目标 URL：http://127.0.0.1:8077/（本地探针页，**不是 tradingview.com**）"
OWN_PAGE_MARKUP = '```html\n<!DOCTYPE html>\n<html lang="zh"><div class="pro-chart-toolbar">\n```\n'


@pytest.mark.parametrize(
    "url_line",
    [OWN_PAGE_URL_LINE, PROBE_PAGE_URL_LINE],
    ids=["self-dev-server-disclaims-tv", "local-probe-disclaims-tv"],
)
def test_a_own_page_record_naming_tv_in_its_disclaimer_is_not_a_third_party_record(tmp_path, url_line):
    """F3-1 的钉：`目标 URL` 值里逐字含「不是 tradingview.com」，host 是 localhost／127.0.0.1
    ⇒ 它不是三方页记录，贴自家页标记（`<!DOCTYPE`／`<html`）不得红。

    反向那半（简报 §F3-1 第 3 条）：host `127.0.0.1:8077` 的探针页记录同样不红——两个 case
    共用一把尺，所以免责声明这一半也钉住了（子串实现下两个 case 都红）。
    """
    body = _l0_with_url(L0_BODY, url_line) + OWN_PAGE_MARKUP
    path, repo = _l0(tmp_path, body)
    problems, _purpose = _audit_l0(path, "l0/self-dw07-pixel-equality.md", repo)
    assert problems == [], problems


@pytest.mark.parametrize(
    "url_line",
    [
        "- 目标 URL：https://tradingview.com/chart/",
        "- 目标 URL：https://s3.tradingview.com/snippets/",
        "- 目标 URL：HTTPS://WWW.TRADINGVIEW.COM/chart/?symbol=NASDAQ%3AAAPL",
    ],
    ids=["bare-host", "subdomain", "uppercase"],
)
def test_host_judgement_still_refuses_every_tradingview_shape(tmp_path, url_line):
    """收紧的那一半：改成 host 判定**不许**顺手把真三方页放走（裸 host／子域／大写照样红）。

    `host == "tradingview.com" or host.endswith(".tradingview.com")` 两条来路各钉一次，
    再加上大小写一向——摘掉 endswith 或摘掉 lower() 都有针红。
    """
    body = _l0_with_url(L0_BODY, url_line) + "```html\n" + MARKUP_EXCERPT
    path, repo = _l0(tmp_path, body)
    problems, _purpose = _audit_l0(path, "l0/tv-a1-page.md", repo)
    assert any("标记正文" in x and "tradingview.com" in x for x in problems), problems


def test_a_lookalike_host_is_not_a_tradingview_page_record(tmp_path):
    """点号边界：`tradingview.com.evil.example` 里逐字含着 `tradingview.com`，但它不是 TV 的页面。

    子串判定会把它当三方页记录（=F3-1 那个缺陷的镜像形状），host 判定按点号边界把它放在尺外。
    这根针钉的是**边界方向**：摘掉 `endswith("." + TV_PAGE_HOST)` 换成子串 ⇒ 本针红。
    """
    url_line = "- 目标 URL：https://tradingview.com.evil.example/chart/"
    body = _l0_with_url(L0_BODY, url_line) + "```html\n" + MARKUP_EXCERPT
    path, repo = _l0(tmp_path, body)
    problems, _purpose = _audit_l0(path, "l0/tv-a1-page.md", repo)
    assert not any("标记正文" in x for x in problems), problems


@pytest.mark.parametrize(
    "url_line",
    ["- 目标 URL：tradingview.com/chart/", "- 目标 URL：www.tradingview.com/chart/"],
    ids=["bare-host-no-scheme", "subdomain-no-scheme"],
)
def test_a_target_url_without_a_scheme_is_refused_not_read_blindly(tmp_path, url_line):
    """F3-1 的配套腿：host 判定要求 scheme，所以裸 `tradingview.com/…` 会掉出标记正文那把尺。

    裁定＝不猜 host，改判「这条记录不合格」：`目标 URL` 里必须有一个带 scheme 的 URL，
    否则红。判别力＝把 `_audit_l0` 里那句「判不出 host 就出违规」摘掉 ⇒ 本针不红，而
    那份正文里的 `<!DOCTYPE` 会安静地待在一个尺看不见的记录里（正是 F3 报告需裁第 1 条）。
    """
    body = _l0_with_url(L0_BODY, url_line) + "```html\n<!DOCTYPE html>\n```\n"
    path, repo = _l0(tmp_path, body)
    problems, _purpose = _audit_l0(path, "l0/tv-a1-page.md", repo)
    assert any("判不出 host" in x for x in problems), problems


def test_a_placeholder_target_url_keeps_only_the_placeholder_violation(tmp_path):
    """绿方向：占位符值已经有「还留着占位符尖括号」那条红，不许再叠一条「判不出 host」。

    钉的是两条判据的**分工**——把 `"<" not in url_field` 那个前置摘掉 ⇒ 本针红（同一条记录
    收到两句归因不同的话，下一席会去修错的那半）。
    """
    body = _l0_with_url(L0_BODY, "- 目标 URL：<换成真实地址>")
    path, repo = _l0(tmp_path, body)
    problems, _purpose = _audit_l0(path, "l0/tv-a1-page.md", repo)
    assert any("占位符" in x for x in problems), problems
    assert not any("判不出 host" in x for x in problems), problems


def test_captured_evidence_with_an_empty_spec_table_is_not_green(tmp_path):
    """I1：表头齐＋分隔行齐＋零条目 ⇒ 「取证了但没写规格」，门禁不许沉默。"""
    empty = f"# 规格：画线面\n\n{SPEC_HEADER}\n|---|---|---|---|---|\n"
    root = _tree(tmp_path, spec=empty, matrix=None)
    problems = audit_forensics(root, tmp_path)
    assert any("没解析出任何规格条目" in x for x in problems), problems


def test_captured_evidence_without_any_spec_layer_is_named(tmp_path):
    """I1 的第二种来路：只有 l0/ 没有 spec/ ——同样是 prose，选的是「有证据却没规格」这个口径。"""
    root = _forensics(tmp_path)  # l0/probe-skeleton.md，既没有 spec/ 也没有 gap-matrix.md
    problems = audit_forensics(root, tmp_path)
    assert any("没解析出任何规格条目" in x for x in problems), problems


def test_no_spec_layer_and_no_evidence_keeps_the_existing_l0_message_only(tmp_path):
    """口径收窄的边界针：一棵没捕过任何东西的树红在 l0 那条，不叠加「没规格」（钉现状）。"""
    root = _forensics(tmp_path)
    (root / "l0" / "probe-skeleton.md").unlink()
    problems = audit_forensics(root, tmp_path)
    assert any("l0/ 下没有任何证据文件" in x for x in problems), problems
    assert not any("没解析出任何规格条目" in x for x in problems), problems


def test_one_capture_cannot_be_two_l0_records(tmp_path):
    """I2（裁过的一半）：同一枚 `evidence_id` 出现在两份文件里 ⇒ 一份捕获冒充两个面。"""
    root = _tree(tmp_path)
    _mk(root, "l0/tv-a9-axis-scale.md", L0_BODY)  # 逐字复制：主键与 L0_BODY 完全相同
    problems = audit_forensics(root, tmp_path)
    assert any(
        "同一枚 evidence_id" in x and "tv-a9-axis-scale.md" in x and "probe-skeleton.md" in x
        for x in problems
    ), problems


def test_the_same_command_on_two_faces_is_not_a_duplicate_key(tmp_path):
    """I2 裁掉的那一半不许顺手加回来：`命令：` 逐字相同、主键不同是合法的（活树实测 1 组）。

    到达即绿；它的咬合力由变异自证证明——把 F2-4 的倒排键从 `evidence_id` 换成 `命令`
    这根针就红（那正是要拒绝的恒红形状）。
    """
    root = _tree(tmp_path)
    _mk(root, "l0/tv-a15-pixel-baseline.md", L0_BODY.replace(EVID, "ev_" + "cd" * 32))
    problems = audit_forensics(root, tmp_path)
    assert not any("同一枚 evidence_id" in x for x in problems), problems


def test_a_harness_copy_does_not_collide_under_the_orphan_exemptions(tmp_path):
    """孤证规则给 用途：harness 让路，但那份副本**带自己的主键**——F3-2 起这把尺不吃 用途 豁免。

    原先这份夹具拿 `L0_BODY` 逐字再造一个文件，于是 `loose.md` 与 `_tree()` 里的
    `probe-skeleton.md` 共用同一枚 `EVID`，它才需要「重复主键也按 用途 让路」这个豁免来保住
    `assert not any("同一枚 evidence_id" …)`。豁免面已在 F3-2 被摘掉（台账裁定：抄一份再补
    一行 `用途：基线` 就躲过这把尺，成本一行字 ⇒ 不接受），所以这里改的是**夹具数据**
    （副本换一枚独立主键 `LOOSE_EVID`），断言一字未动。两根老针的豁免腿仍由
    `test_harness_purpose_exempts_an_uncited_l0`／`test_baseline_purpose_exempts_an_uncited_l0` 钉。
    """
    root = _tree(tmp_path)
    want = hashlib.sha256(PROBE_APP_JS_LF).hexdigest()
    _mk(root, "l0/loose.md", LOOSE_BODY + "\n- 用途：harness\n" + f"\n探针 app.js 的当前 sha256：{want}\n")
    problems = audit_forensics(root, tmp_path)
    assert not any("同一枚 evidence_id" in x for x in problems), problems


def test_a_purposed_copy_still_collides_on_its_primary_key(tmp_path):
    """F3-2 的钉：两份记录都声明 用途（一份 基线、一份 harness）＋共用同一枚合法主键 ⇒ 必须红，
    而且红在「同一枚 evidence_id」这一条上。

    这是 F2 报告主动披露的那个豁免逃逸面（控制席探针 P-E：把副本标成 `用途：基线` ⇒ 重复主键
    隐身）。裁定理由：两把尺判的是两件不同的事——孤证规则判「这份证据有没有被 L1 引用」，
    所以 用途 声明让路是对的；重复主键判「一份捕获有没有被抄成两个面」，**跟有没有被引用无关**。
    判别力形状：这两份记录都声明了 用途 ⇒ 孤证那一条**不许**出现（豁免照旧），所以树上关于
    这两份记录的红只可能来自重复主键；把 `用途` 豁免加回倒排表 ⇒ 本针立刻不红（F3 报告 §变异 第 2 行）。
    """
    root = _tree(tmp_path)
    want = hashlib.sha256(PROBE_APP_JS_LF).hexdigest()
    copy = "ev_" + "cd" * 32  # 与 _tree() 里那枚 EVID 不同，两副本之间逐字相同
    base = L0_BODY.replace(EVID, copy)
    _mk(root, "l0/tv-copycat-baseline.md", base + "\n- 用途：基线\n")
    _mk(root, "l0/tv-copycat-harness.md", base + "\n- 用途：harness\n" + f"\n探针 app.js 的当前 sha256：{want}\n")
    problems = audit_forensics(root, tmp_path)
    assert any(
        "同一枚 evidence_id" in x
        and "tv-copycat-baseline.md" in x
        and "tv-copycat-harness.md" in x
        for x in problems
    ), problems
    assert not any(
        "没有被任何规格条目引用" in x
        and ("tv-copycat-baseline.md" in x or "tv-copycat-harness.md" in x)
        for x in problems
    ), problems  # 孤证那一条照旧让路 ⇒ 红只可能来自重复主键这把尺


# ---------------------------------------------------------------------------
# F2-5（评审 A 的 I3）：读失败／目录名打穿 `audit_forensics` ⇒ 出违规，不许吐回溯。
# 同形缺陷早已在矩阵侧修过（`test_absurd_line_number_is_a_violation_not_a_traceback`、
# `_resolve_l0`／坐标解析各自的 `except (OSError, ValueError)`），L0／L1 侧原样留着：
# `_audit_l0`／`_audit_spec`／`_audit_matrix` 三处 `_read` 与 harness 分支的
# `app.read_bytes()` 一个 except 都没有；`l0_files` 与 spec 走查的 glob 结果没有
# `is_file()` 守卫（目录名叫 `x.md` 会被当成文件去读）；`main()` 外层没有 try，
# 回溯一穿，前面 collected 的违规一条都不打印。权限夹具只作用在 tmp_path 下。
# ---------------------------------------------------------------------------

def test_unreadable_l0_record_is_a_violation_not_a_traceback(tmp_path):
    root = _tree(tmp_path)
    victim = root / "l0" / "probe-skeleton.md"
    if not _deny_read(victim):
        _restore_read(victim)
        pytest.skip("本机造不出「文件存在但读不动」的条件")
    try:
        problems = audit_forensics(root, tmp_path)  # 修前：PermissionError 直接穿出
    finally:
        _restore_read(victim)
    assert any("probe-skeleton.md" in x and "读不出来" in x for x in problems), problems
    assert not any("l0/ 下没有任何证据文件" in x for x in problems), problems


def test_directory_named_md_in_l0_is_reported_not_read(tmp_path):
    """`l0/probe-dir.md` 是个目录：出一条「是目录不是文件」，不许静默跳过、更不许回溯。"""
    root = _tree(tmp_path)
    (root / "l0" / "probe-dir.md").mkdir()
    problems = audit_forensics(root, tmp_path)  # 修前：IsADirectoryError 穿出
    assert any("probe-dir.md" in x and "是目录不是文件" in x for x in problems), problems
    assert not any("l0/ 下没有任何证据文件" in x for x in problems), problems


def test_directory_named_md_in_spec_is_reported_not_read(tmp_path):
    root = _tree(tmp_path)
    (root / "spec" / "probe-dir.md").mkdir()
    problems = audit_forensics(root, tmp_path)  # 修前：同样是 IsADirectoryError
    assert any("spec/probe-dir.md" in x and "是目录不是文件" in x for x in problems), problems


def test_unreadable_spec_file_is_a_violation_not_a_traceback(tmp_path):
    """规格层自己那把 `is_file()` 守卫挡不住「是文件但读不动」——`_audit_spec` 的 except
    必须有独立的针（变异自证：摘掉那个 except 时只有这根针红，两根目录针都还是绿的）。
    """
    root = _tree(tmp_path)
    victim = root / "spec" / "drawings.md"
    if not _deny_read(victim):
        _restore_read(victim)
        pytest.skip("本机造不出「文件存在但读不动」的条件")
    try:
        problems = audit_forensics(root, tmp_path)  # 修前：PermissionError 穿出
    finally:
        _restore_read(victim)
    assert any("spec/drawings.md" in x and "读不出来" in x for x in problems), problems
    assert any("没解析出任何规格条目" in x for x in problems), problems


def test_unreadable_gap_matrix_is_a_violation_not_a_traceback(tmp_path):
    root = _tree(tmp_path)
    victim = root / "gap-matrix.md"
    if not _deny_read(victim):
        _restore_read(victim)
        pytest.skip("本机造不出「文件存在但读不动」的条件")
    try:
        problems = audit_forensics(root, tmp_path)  # 修前：`_table(_read(path))` 直接抛
    finally:
        _restore_read(victim)
    assert any("gap-matrix.md" in x and "读不出来" in x for x in problems), problems
    assert problems, problems


def test_unreadable_probe_app_is_a_violation_not_a_traceback(tmp_path):
    """harness 分支的 `app.read_bytes()` 同法兜住：校验和核不了要说出来，不许崩。"""
    root = _tree(tmp_path)
    want = hashlib.sha256(PROBE_APP_JS_LF).hexdigest()
    _mk(root, "l0/loose.md", L0_BODY + "\n- 用途：harness\n" + f"\n探针 app.js 的当前 sha256：{want}\n")
    app = tmp_path / "tools" / "rea_probe_site" / "app.js"
    if not _deny_read(app):
        _restore_read(app)
        pytest.skip("本机造不出「文件存在但读不动」的条件")
    try:
        problems = audit_forensics(root, tmp_path)  # 修前：PermissionError 穿出
    finally:
        _restore_read(app)
    assert any("app.js" in x and "读不出来" in x for x in problems), problems
    assert problems, problems


def test_main_turns_its_own_crash_into_a_violation_line(tmp_path, monkeypatch, capsys):
    """③：门自己炸了也要 rc=1 并印一行——回溯穿出的话前面收集的违规一条都看不见。"""

    def boom(*_args, **_kwargs):
        raise RuntimeError("门自己炸了")

    monkeypatch.setattr("forensics_audit.audit_forensics", boom)
    rc = main(tmp_path)  # 修前：RuntimeError 穿出 main()，这里根本拿不到返回值
    out = capsys.readouterr().out
    assert rc == 1, out
    assert "门自己炸了" in out, out


# ---------------------------------------------------------------------------
# F2-6（评审 A 的 I4 裁过的半＋N1＋N2）：主机红线的两条来路。
# ① 入口件判据（与扩展名过滤无关）——`frontend/index.html`／`vite.config.ts`／
#    `package.json` 是真正会被浏览器与构建加载的三份，住在 `frontend/src` 之外，
#    所以这两把尺互不遮蔽。
# ② 代码类扩展名进同一把集合等式尺（`.md`／`.pine` 按裁定继续不进）。
# ③ 目录级符号链接：`os.walk(followlinks=False)` 防环对，但指向仓外的链接被静默跳过
#    ——要显式出一条违规。本机造不出真实链接（现读：`os.symlink` → WinError 1314
#    客户端没有所需的特权），这根针用 monkeypatch 钉**判定形状**，不是钉现场。
# ④ `命令` 形状正则：`"rea-agents" in cmd` 连 `curl https://x/rea-agents` 都放过。
#    只做形状匹配，不做子命令白名单（词汇表在文档里会漂，钉白名单＝下次加一条 REA
#    命令就假红）。
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("entry", [
    "frontend/index.html",
    "frontend/vite.config.ts",
    "frontend/package.json",
])
def test_tradingview_in_a_build_entry_file_is_refused(tmp_path, entry):
    _fake_tv_tree(tmp_path)
    _src(tmp_path, entry, '<script src="https://s3.tradingview.com/external-embedding/x.js"></script>\n')
    problems = audit_tv_host_allowlist(tmp_path)
    assert any("入口" in x and entry in x for x in problems), problems


@pytest.mark.parametrize("rel", [
    "frontend/src/lib/tvFetch.js",
    "frontend/src/embed.html",
    "frontend/src/assets/lib.json",
])
def test_tv_host_in_a_non_ts_code_file_is_now_scanned(tmp_path, rel):
    """PROBE P9 的形状现在要能红：写在 `.js`／`.html`／`.json` 里的 embed 不是「没有新增依赖」。"""
    _fake_tv_tree(tmp_path)
    _src(tmp_path, rel, 'const u = "https://scanner.tradingview.com/";\n')
    problems = audit_tv_host_allowlist(tmp_path)
    assert any("白名单不符" in x and rel.rsplit("/", 1)[-1] in x for x in problems), problems


def test_tv_widget_embed_in_a_js_file_is_refused_by_the_s3_rule_too(tmp_path):
    _fake_tv_tree(tmp_path)
    _src(tmp_path, "frontend/src/lib/tvFetch.js",
         'script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";\n')
    problems = audit_tv_host_allowlist(tmp_path)
    assert any("s3.tradingview 只允许出现在" in x and "tvFetch.js" in x for x in problems), problems


def test_directory_symlink_under_frontend_src_is_an_explicit_violation(tmp_path, monkeypatch):
    """N1：防环对不等于可以静默跳过——目录级符号链接要显式报出来。

    本机造不出真实符号链接（现读 `os.symlink` → WinError 1314 客户端没有所需的特权），
    所以这根针打的是 `Path.is_symlink` 的**判定形状**，不是「现场已封闭」的凭据。
    代价要说清：夹具里的 `linked` 在磁盘上是真目录，只有谓词被打了桩，所以 `os.walk`
    照样进去扫（RED 读数里同时有「白名单不符」那一条）——这根针断言的只是「符号链接
    那一条必须出现」，真实链接「进去就不扫」那一半本机证明不了，报告里按盲区登记。
    """
    _fake_tv_tree(tmp_path)
    linked = tmp_path / "frontend" / "src" / "lib" / "linked"
    linked.mkdir(parents=True)
    _mk(linked, "inside.ts", 'const u = "https://scanner.tradingview.com/";\n')
    monkeypatch.setattr(Path, "is_symlink", lambda self: self.name == "linked")
    problems = audit_tv_host_allowlist(tmp_path)  # 修前：返回里没有「符号链接」那一条
    assert any("linked" in x and "符号链接" in x for x in problems), problems


def test_a_url_that_merely_mentions_rea_agents_is_not_a_rea_command(tmp_path):
    """N2：形状正则取代「命令里含 rea-agents 这个词」。"""
    body = L0_BODY.replace(
        "- 命令：npx -y rea-agents@latest inspect-web-page http://127.0.0.1:9222 TID1 --filter-output normalized_result",
        "- 命令：curl https://mirror.example.com/rea-agents --filter-output evidence_id --token-limit 1")
    path, repo = _l0(tmp_path, body)
    problems, _purpose = _audit_l0(path, "l0/probe-skeleton.md", repo)
    assert any("命令里没有 rea-agents" in x for x in problems), problems


# ---------------------------------------------------------------------------
# F2-7（评审 A 的 C1 附带）：模块 docstring 那句 "carries the compliance red line"
# 只在 F2-1／F2-2 落地后才成立，落地前要改成准确描述（漏斗侧承载的是两条内容判据，
# 运行时依赖那半在 `audit_tv_host_allowlist`）。这是文本针，与
# `test_resolve_l0_docstring_states_the_real_rule` 同一套路：钉措辞不许过强。
# ---------------------------------------------------------------------------

def test_module_docstring_describes_the_red_lines_it_actually_carries():
    import forensics_audit

    doc = " ".join((forensics_audit.__doc__ or "").split())
    assert "carries the compliance red line" not in doc, doc
    assert "data_base64" in doc, doc  # 漏斗侧承载的两条内容判据要点名
    assert "标记正文" in doc, doc
    assert "audit_tv_host_allowlist" in doc, doc  # 运行时依赖那半的落点要说清在哪
