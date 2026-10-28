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
    six_of_six = sum(
        1 for row in rows if row[3] == f"{len(fa.L0_REQUIRED_KEYS)}/{len(fa.L0_REQUIRED_KEYS)}"
    )
    evidence_ok = sum(1 for row in rows if row[4] == "✓")
    purposes = {name: sum(1 for row in rows if row[2] == name) for name in fa.L0_PURPOSES}
    silent = len(rows) - sum(purposes.values())
    summary = (
        f"汇总：记录 {len(rows)} 份（不含 `_example.md`）；"
        f"完整 {complete}／{fa.UNCAPTURABLE} {uncapturable}；"
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
    # 工作树可能是 CRLF（本仓 core.autocrlf=true），blob 是 LF；判据只认内容。
    actual = target.read_bytes().replace(b"\r\n", b"\n").decode("utf-8", errors="replace")
    if actual != expected:
        return 1, f"{CENSUS_NAME} 与现算的表不一致：{_first_difference(expected, actual)}"
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
