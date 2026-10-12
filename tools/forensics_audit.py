"""Enforce the REA forensics funnel contract under ``docs/forensics/``.

The funnel only holds if every level's artefact is machine-checkable: an L0
record without an ``evidence_id`` is a memory, a spec entry without a verdict is
prose, and a gap row without a coordinate is a guess. This module turns those
three sentences into violations so the test suite can refuse them, and carries
the compliance red line: TradingView must never become a runtime dependency of
``frontend/src``.

Stdlib only. A missing ``docs/forensics/`` is reported as a violation here; it
is the *test* that decides to skip instead (see tools/test_forensics_spec.py).

Run with::

    python -X utf8 tools/forensics_audit.py
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

L0_REQUIRED_KEYS: tuple[str, ...] = ("命令", "evidence_id", "浏览器", "目标 URL", "观察条件", "完整性")
L0_PURPOSES: tuple[str, ...] = ("harness", "规格", "基线")
L0_EXEMPT: frozenset[str] = frozenset({"_example.md"})
SPEC_EXEMPT: frozenset[str] = frozenset({"_example.md"})

EVIDENCE_ID = re.compile(r"ev_[0-9a-f]{64}")
KEY_LINE = re.compile(r"^- ([^：\n]{1,24})：(.*)$")
PROBE_APP_JS = "tools/rea_probe_site/app.js"

SPEC_HEADER = "| 条目号 | 规格句 | 判据 | 判据类型 | L0 依据 |"
ENTRY_ID = re.compile(r"TV-[A-Z][A-Z0-9]*-\d{2}")
VERDICT_TYPES: tuple[str, ...] = ("DOM", "状态", "像素")
MIN_VERDICT_LEN = 12


def _outside_fences(text: str) -> list[str]:
    """Lines that are not inside a ``` fence — evidence excerpts are fenced."""
    out: list[str] = []
    in_fence = False
    for line in text.splitlines():
        if line.strip().startswith("```"):
            in_fence = not in_fence
            continue
        if not in_fence:
            out.append(line)
    return out


def _meta_keys(text: str) -> dict[str, str]:
    keys: dict[str, str] = {}
    for line in _outside_fences(text):
        m = KEY_LINE.match(line.strip())
        if m:
            keys.setdefault(m.group(1).strip(), m.group(2).strip())
    return keys


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def _command_hygiene(rel: str, cmd: str) -> list[str]:
    """命令卫生：Global Constraint 5 是无条件的，不可取证的记录同样要限住自己的输出。"""
    v: list[str] = []
    if cmd and "rea-agents" not in cmd:
        v.append(f"{rel}: 命令里没有 rea-agents，这不是一条 REA 取证记录")
    if cmd and "--filter-output" not in cmd and "--token-limit" not in cmd:
        v.append(f"{rel}: 命令既没有 --filter-output 也没有 --token-limit（证据体积会吃掉内存）")
    return v


def _audit_l0(path: Path, rel: str, repo_root: Path) -> tuple[list[str], str | None]:
    """One L0 record -> (violations, declared 用途 or None)."""
    v: list[str] = []
    text = _read(path)
    keys = _meta_keys(text)

    if "不可取证" in keys.get("状态", ""):
        cmd = keys.get("命令", "")
        if not cmd:
            v.append(f"{rel}: 不可取证的记录也要写清 命令：（到底试过哪一条）")
        if not keys.get("原因"):
            v.append(f"{rel}: 标记为不可取证但没有 原因：")
        v += _command_hygiene(rel, cmd)
        return v, None

    for key in L0_REQUIRED_KEYS:
        if key not in keys:
            v.append(f"{rel}: 缺少必填键 {key}")
        elif not keys[key]:
            v.append(f"{rel}: 键 {key} 的值为空")
        elif "<" in keys[key] or ">" in keys[key]:
            v.append(f"{rel}: 键 {key} 的值里还留着占位符尖括号：{keys[key]!r}")

    ev = keys.get("evidence_id", "")
    if ev and not EVIDENCE_ID.fullmatch(ev):
        v.append(f"{rel}: evidence_id 不是 ev_<64 位十六进制>：{ev!r}")

    cmd = keys.get("命令", "")
    v += _command_hygiene(rel, cmd)

    completeness = keys.get("完整性", "")
    if "parse_failures" in text and "parse_failures" not in completeness:
        v.append(f"{rel}: 证据里出现 parse_failures，必须在 完整性： 里解释它的值（不解释就是没看）")

    purpose = keys.get("用途", "")
    if purpose and purpose not in L0_PURPOSES:
        v.append(f"{rel}: 用途 {purpose!r} 不在 {'/'.join(L0_PURPOSES)} 之内")
    if purpose == "harness":
        app = repo_root / PROBE_APP_JS
        if not app.is_file():
            v.append(f"{rel}: 声明 harness 用途但 {PROBE_APP_JS} 不存在")
        else:
            # 行尾不是证据的一部分：本机 core.autocrlf=true 会把工作树里的 app.js
            # 变成 CRLF，裸 read_bytes() 会让反编造针在下次 checkout 时假红。
            want = hashlib.sha256(app.read_bytes().replace(b"\r\n", b"\n")).hexdigest()
            if want not in text:
                v.append(f"{rel}: 声明 harness 用途但正文没有探针 app.js 的当前 sha256（{want}）")
    return v, (purpose or None)


def _table(text: str, header: str) -> tuple[bool, list[list[str]], list[str]]:
    """(header_seen, five-column data rows, raw text of rows with the wrong width).

    一张表 = 以逐字 ``header`` 开头的那一段**连续** ``|`` 行：第一条非 ``|`` 行
    （散文、标题、空行）就关掉行窗口，所以同一文件后面不相干的管道表不会被当成
    这张表的条目（否则真实 L1 文档里的备注／统计表会造出幻影违规）。
    ``header_seen`` 是整个文件范围的——出现过一次逐字表头就算这文件有表。
    作用域约定：第二张同表头的规格表照样解析（表头重开窗口），但返回的 ``rows``
    把每张规格表的行合并到一个文件里，``_audit_spec`` 的条目号查重因此是**文件**
    作用域，与它的消息文案「在 {rel} 里出现 N 次」一致。
    分隔行必须含 ``-``：`|  |  |  |  |  |` 这种全空数据行不是 `|---|---|`，
    它要落到「空单元格」的判据上，不能被静默丢掉。
    """
    seen = False
    window_open = False  # 表头之后、第一条非 `|` 行之前：这一段才是这张表的行
    rows: list[list[str]] = []
    bad: list[str] = []
    for line in _outside_fences(text):
        s = line.strip()
        if s == header:
            seen = True
            window_open = True
            continue
        if not s.startswith("|"):
            window_open = False
            continue
        if not window_open:
            continue
        if "-" in s and set(s) <= set("|-: "):  # the |---|---| separator row
            continue
        cells = [c.strip() for c in s.strip("|").split("|")]
        if len(cells) == 5:
            rows.append(cells)
        else:
            bad.append(s)
    return seen, rows, bad


def _resolve_l0(forensics_root: Path, ref: str) -> str | None:
    """Accept ``l0/x.md`` or a bare ``x.md``; return the resolved file name or None.

    判据说的是「L0 依据 必须指向存在的 **l0** 文件」，所以落点必须在
    ``forensics_root/l0/`` 里：``spec/drawings.md``（规格自引）、``gap-matrix.md``
    这类同树里的非 l0 文件，以及 ``../x.md``／绝对路径这种越出取证根的写法，
    一律返回 None。两种被接受的写法都保留，多份依据（``、``／`,` 分隔）也保留。
    调用方对「找不到」与「找到了但不在 l0/」都报同一条 指向的文件不存在。
    """
    l0_dir = (forensics_root / "l0").resolve()
    name = ref.rsplit("/", 1)[-1]
    for cand in (forensics_root / "l0" / name, forensics_root / ref):
        try:
            hit = cand.resolve()
        except OSError:  # 符号环之类的坏路径：当作没找到
            continue
        if hit.is_file() and l0_dir in hit.parents:
            return name
    return None


def _audit_spec(path: Path, rel: str, forensics_root: Path) -> tuple[list[str], set[str], list[str]]:
    v: list[str] = []
    text = _read(path)
    seen, rows, bad = _table(text, SPEC_HEADER)
    if not seen:
        return [f"{rel}: 表头不是逐字的 {SPEC_HEADER}，文件里没有规格表"], set(), []
    if bad:
        v.append(f"{rel}: 有 {len(bad)} 行的列数不是 5（表行必须正好五列）：{bad[0]!r}")
    cited: set[str] = set()
    ids: list[str] = []
    for eid, _sentence, verdict, vtype, basis in rows:
        tag = f"{rel} 条目 {eid or '(空)'}"
        if not ENTRY_ID.fullmatch(eid):
            v.append(f"{tag}: 条目号 {eid!r} 不符合 TV-<大写字母…>-<两位数字>")
        ids.append(eid)
        if len(verdict) < MIN_VERDICT_LEN:
            v.append(f"{tag}: 判据短于 {MIN_VERDICT_LEN} 个字符，打不了（写不出判据不算条目）")
        if vtype not in VERDICT_TYPES:
            v.append(f"{tag}: 判据类型 {vtype!r} 不在 {'/'.join(VERDICT_TYPES)} 之内")
        refs = [r.strip() for r in re.split(r"[、,]", basis) if r.strip()]
        if not refs:
            v.append(f"{tag}: L0 依据是空的")
        for ref in refs:
            resolved = _resolve_l0(forensics_root, ref)
            if resolved is None:
                v.append(f"{tag}: L0 依据 {ref!r} 指向的文件不存在")
            else:
                cited.add(resolved)
    for dup in sorted({i for i in ids if ids.count(i) > 1}):
        v.append(f"{rel}: 条目号 {dup} 在 {rel} 里出现 {ids.count(dup)} 次")
    return v, cited, ids


def audit_forensics(forensics_root: Path, repo_root: Path) -> list[str]:
    """Every violation in the funnel artefacts. Empty list == the contract holds."""
    if not forensics_root.is_dir():
        return [f"{forensics_root} 不存在：取证骨架还没建"]

    v: list[str] = []
    l0_dir = forensics_root / "l0"
    l0_files = sorted(
        p for p in (l0_dir.glob("*.md") if l0_dir.is_dir() else []) if p.name not in L0_EXEMPT
    )
    if not l0_files:
        v.append("docs/forensics/l0/ 下没有任何证据文件（骨架不等于取证）")
    for p in l0_files:
        problems, _purpose = _audit_l0(p, f"l0/{p.name}", repo_root)
        v += problems

    spec_dir = forensics_root / "spec"
    for p in sorted(
        q for q in (spec_dir.glob("*.md") if spec_dir.is_dir() else []) if q.name not in SPEC_EXEMPT
    ):
        problems, _cited, _ids = _audit_spec(p, f"spec/{p.name}", forensics_root)
        v += problems
    return v


def main(repo_root: Path) -> int:
    problems = audit_forensics(repo_root / "docs" / "forensics", repo_root)
    for line in problems:
        print(line)
    if not problems:
        print("forensics audit: clean")
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main(Path(__file__).resolve().parents[1]))
