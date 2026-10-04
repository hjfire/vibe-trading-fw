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
    MEASURED_WORST,
    MEASURED_WORST_VARIANTS,
    builtins_from_source,
    gate1_functions,
    gate1_script_keys_from_ts,
)
from pine_oracle.emit_coverage import render
from pine_oracle.schema import TOLERANCE_TIERS, FIXTURE_DIR, REPO_ROOT, load_manifest

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
    assert gap, "引擎分派表减去已覆盖集为空——那不是全覆盖，是名单失去了意义"
    for name in sorted(gap):
        assert f"| `{name}` |" in doc, name
    assert len(gap) == len(builtins) - len(COVERED) == 62


def test_the_covered_table_marks_each_gate_for_each_function(builtins: frozenset[str]) -> None:
    doc = COVERAGE_DOC.read_text(encoding="utf-8")
    g1 = gate1_functions()
    assert COVERED, "已覆盖集为空——遍历它的断言不会比较任何东西"
    for name in sorted(COVERED):
        row = next((line for line in doc.splitlines() if line.startswith(f"| `{name}` |")), None)
        assert row is not None, name
        gate_1, gate_2 = row.split("|")[2].strip(), row.split("|")[3].strip()
        assert gate_1 == ("✓" if name in g1 else "✗"), row
        assert (gate_2.startswith("✓") if name in GATE2_FUNCTIONS else gate_2.startswith("✗")), row


def test_the_vwap_session_deviation_is_written_as_backlog_not_a_pass() -> None:
    """The engine has no session re-anchoring, so TV and this harness differ for real.
    Recording that in a gate that passes would launder a known deviation into a
    green tick; the ledger has to carry the words.

    Two pins, not one. The doc-level regex alone is satisfied from either place — the
    covered table's note OR the 已知偏离 paragraph — so it cannot see the note being
    rewritten; the row pin below is the one dispatch-notes 第 10 条 names as the live
    dependency (``convention["vwap"]`` has no 会话 in it, so the table note is the only
    place the covered list says this out loud).
    """
    doc = COVERAGE_DOC.read_text(encoding="utf-8")
    assert re.search(r"vwap[^\n]*会话锚定", doc), "vwap 的会话锚定偏离必须写在台账里"
    row = next((line for line in doc.splitlines() if line.startswith("| `vwap` |")), None)
    assert row is not None and "会话锚定" in row, f"已覆盖表的 vwap 行必须自带「无会话锚定」：{row}"


def test_the_witness_table_names_every_priced_line_within_its_own_tier(manifest: dict) -> None:
    """A zero residual and a 6e-15 residual are two different kinds of witness (Ruling H),
    so the ledger records the measured number per line — and the record must stay glued
    to the manifest it describes.

    Three separate refusals, none of them the engine's job: the row set must be exactly
    the 18 priced lines (a line missing here is a line the ledger claims covered without
    saying how well); four readings per row, in the declared variant order (a truncated
    row compares one bar set and still reads as agreement); and every recorded reading
    inside THAT line's tier in ``schema.TOLERANCE_TIERS`` — a tier moved in the manifest
    without re-measuring shows up here as a stale claim, not as a silent pass.
    """
    tiers = manifest["tolerance_tier"]
    lines = {line for names in FUNCTION_LINES.values() for line in names}
    assert MEASURED_WORST, "见证表为空——下面的循环一个数都不比"
    assert set(MEASURED_WORST) == lines, set(MEASURED_WORST) ^ lines
    assert len(MEASURED_WORST_VARIANTS) == 4, MEASURED_WORST_VARIANTS
    for line, readings in MEASURED_WORST.items():
        assert len(readings) == len(MEASURED_WORST_VARIANTS), (line, readings)
        assert max(readings) <= TOLERANCE_TIERS[tiers[line]], (
            line,
            tiers[line],
            max(readings),
            TOLERANCE_TIERS[tiers[line]],
        )
    doc = COVERAGE_DOC.read_text(encoding="utf-8")
    for line in sorted(lines):
        assert f"| `{line}` |" in doc, line
    # Ruling H's other half: the document has to say which witness it is showing.
    assert "零残差＝只核对语义" in doc and "非零残差＝独立算术见证" in doc, (
        "台账必须写明恒零线只核对语义、不核对算术形式"
    )


def test_the_committed_ledger_is_what_the_generator_renders() -> None:
    """The committed ``COVERAGE.md`` IS the generator's rendering, byte for byte.

    Every other test in this file checks the ledger *property by property* — each
    backlog name has a row, each covered row carries the right ticks, each recorded
    reading sits inside its tier — and all of them stay green while the document's
    columns drift from ``coverage.py``, because a property check never compares the
    whole rendering. The review round measured exactly that: four hand edits
    (N-4b a tier column rewritten to ``loose``, N-5 ``sma``'s worst upper bound pushed
    three orders of magnitude past its own ``tight``, N-6 the 读数分档 prose renumbered
    14/4 → 18/0, N-8 a backlog line number rewritten to ``9999``) all came back
    ``rc=0``.

    One equality over the whole body is what those columns lacked, and it locks the
    four column classes at once: 数值（``MEASURED_WORST`` 的 18×4 读数）、档位
    （``manifest.tolerance_tier`` 的逐线宣告）、散文（读数分档的恒零/非零计数与 Ruling H
    的说法）、行号（``pineTa.ts`` 的分派表行号）. A ledger can now only change by
    re-running the generator.

    This also promotes "the generated artefact is idempotent" from process discipline
    (the report's 收尾 checklist, where a forgotten re-run was a mistake someone had to
    remember to catch) into a machine gate: a stale ``COVERAGE.md`` is a red test.
    """
    committed = COVERAGE_DOC.read_text(encoding="utf-8")
    assert committed.strip(), "台账正文为空——任何渲染比较都会在两份空文本上绿"
    assert render() == committed, (
        "COVERAGE.md 不是生成器的当前输出——重跑 "
        "`PYTHONPATH=agent python -X utf8 -m pine_oracle.emit_coverage`；"
        "数值/档位/散文/行号四类列只能由生成器改，手改正文就是这条门该红的东西"
    )
