"""Gate 3 — read a ``.pine`` script and say what the harness can prove about it.

Two questions, deliberately kept apart, because the harness answers them with two
different witnesses:

* **算术对不对** — 判据二, ``pineTaOracle.test.ts`` against ``pine_oracle/reference.py``.
* **信号重不重绘** — 判据一, ``pinePrefixInvariance.test.ts``: the value series on
  ``bars[:N]`` must equal the first ``N`` entries of the series on the full array.

A function that only 判据二 prices (``rsi``/``atr``/``bb``/``macd``/``stoch``) has no
non-repaint witness: comparing two implementations on the SAME full bar array cannot see
one that reads bars it has not reached yet. So the buckets below are per-gate, and the
vocabulary comes from ``coverage.py`` — never a second hand-copied list.

What this module never proves: that a script *runs*. 编译/跑通率 is the corpus harness's
job (``frontend/src/lib/__tests__/pineCorpusReport.test.ts``); ``repaint_clean`` means
"every call this text makes has a prefix-invariance witness and nothing reads an
unfinished bar", not "TradingView would accept it".

Why ``lookahead_on`` is a finding and not a style choice, with in-repo evidence:

    frontend/src/lib/pineRuntime.ts:1376  asStr(this.val(laExpr)).includes("lookahead_on")
    frontend/src/lib/pineRuntime.ts:1407  const src = lookahead ? h : h - 1
    frontend/src/lib/__tests__/pineResample.test.ts:165  "...under lookahead_on (repaint)"

i.e. the engine's own committed test asserts that with the flag on, bar 0 sees that day's
own future close. Reading a value from bars that have not closed yet is the 未来函数 this
project forbids in delivered indicators.
"""

from __future__ import annotations

import functools
import re
import sys
from collections.abc import Iterable
from pathlib import Path
from typing import Any, Callable

from pine_oracle.coverage import (
    COVERED,
    GATE2_FUNCTIONS,
    builtins_from_source,
    gate1_functions,
)
from pine_oracle.schema import REPO_ROOT

PINE_TA = REPO_ROOT / "frontend" / "src" / "lib" / "pineTa.ts"

#: Bucket keys, and at the same time the finding codes for a call with no witness.
REPAINT_PROVEN = "repaint_proven"
PREFIX_UNPROVEN = "prefix_unproven"
NO_WITNESS = "no_witness"
#: Finding code for a live ``lookahead_on`` argument.
LOOKAHEAD = "lookahead_on"

_TA_CALL_RE = re.compile(r"\bta\.([a-z_][a-z_0-9]*)[ \t]*\(")
_BARE_CALL_RE = re.compile(r"\b([a-z_][a-z_0-9]*)[ \t]*\(")
_VERSION_RE = re.compile(r"//@version\s*=\s*(\d+)")
_LOOKAHEAD_RE = re.compile(r"\blookahead_on\b")


@functools.lru_cache(maxsize=1)
def _builtins() -> frozenset[str]:
    builtins = builtins_from_source(PINE_TA.read_text(encoding="utf-8"))
    assert builtins, f"{PINE_TA}: 分派表读空了——空集合不是「没有内置」，是没读到"
    return builtins


@functools.lru_cache(maxsize=1)
def _prefix_proven() -> frozenset[str]:
    """The functions 判据一 actually probes, read from the gate's own ``SCRIPTS`` roster.

    Read, not copied: a script name added to ``pinePrefixInvariance.test.ts`` widens what
    this audit can certify, and a name deleted from it narrows the certification again —
    which is the direction the harness polices (只准调严).
    """
    proven = gate1_functions()
    assert proven, "判据一的脚本名单读空了——那意味着没有函数被证明不重绘"
    return proven


def strip_comments(text: str) -> str:
    """Blank every ``//`` comment tail, keeping line count and column offsets.

    Quote-aware, because Pine titles are full of ``"9//1"``-shaped text and a naive cut
    would drop whatever followed it on the same line — a dropped call is a call that was
    never audited. Line numbers survive because line starts is what ``lookahead_lines``
    reports.
    """
    out: list[str] = []
    for line in text.split("\n"):
        quote = ""
        cut = len(line)
        i = 0
        while i < len(line):
            ch = line[i]
            if quote:
                if ch == "\\":
                    i += 2
                    continue
                if ch == quote:
                    quote = ""
            elif ch in {'"', "'"}:
                quote = ch
            elif line.startswith("//", i):
                cut = i
                break
            i += 1
        out.append(line[:cut])
    return "\n".join(out)


def pine_version(text: str) -> int | None:
    """The ``//@version`` directive, or None when the script declares none.

    Read from the RAW text: the directive is itself a comment line, so it is exactly what
    :func:`strip_comments` removes.
    """
    found = _VERSION_RE.search(text)
    return int(found.group(1)) if found else None


def ta_calls_from_pine(text: str) -> frozenset[str]:
    """Every builtin this script calls, through the ``ta.`` prefix or the legacy bare name.

    Bare attribution is limited to ``ver <= 4`` / no directive, because that is the only
    form the engine answers: ``LEGACY_SERIES`` is gated ``ver <= 4``
    (``pineRuntime.ts:94-100``, ``:1169``). Over-attributing a bare name is the safe
    direction — it can only ever widen the audit's demand for witnesses.
    """
    live = strip_comments(text)
    calls = frozenset(_TA_CALL_RE.findall(live))
    version = pine_version(text)
    if version is None or version <= 4:
        builtins = _builtins()
        calls |= frozenset(name for name in _BARE_CALL_RE.findall(live) if name in builtins)
    return calls


def lookahead_lines(text: str) -> tuple[int, ...]:
    """1-based line numbers of live ``lookahead_on`` occurrences.

    Keyed on the token, not on a parsed call shape: ``pineRuntime.ts:1376`` decides by
    ``...includes("lookahead_on")``, which the named form (``lookahead=...``) and the
    positional form (5th argument) both reach, so any live occurrence is a live lookahead.
    """
    return tuple(
        number
        for number, line in enumerate(strip_comments(text).split("\n"), 1)
        if _LOOKAHEAD_RE.search(line)
    )


def repainting_calls(calls: Iterable[str]) -> frozenset[str]:
    """The calls in `calls` for which no prefix-invariance witness exists yet."""
    return frozenset(calls) - _prefix_proven()


def buckets_for_calls(calls: Iterable[str]) -> dict[str, frozenset[str]]:
    """Split calls by which witness the harness holds for them — a partition, not a filter.

    ``PREFIX_UNPROVEN`` ∩ ``NO_WITNESS`` is empty by construction: a function 判据二 prices
    is in ``COVERED``, and ``COVERED - 判据一`` is exactly ``{rsi, atr, bb, macd, stoch}``
    plus ``sar`` (which 判据一 does probe), so nothing lands in two buckets.
    """
    names = frozenset(calls)
    proven = _prefix_proven()
    return {
        REPAINT_PROVEN: frozenset(n for n in names if n in proven),
        PREFIX_UNPROVEN: frozenset(
            n for n in names if n not in proven and n in GATE2_FUNCTIONS
        ),
        NO_WITNESS: frozenset(n for n in names if n not in COVERED),
    }


class PineCheck:
    """One declared audit rule — upstream's ``GroundingCheck`` shape, ours actually run."""

    __slots__ = ("name", "code", "description", "predicate")

    def __init__(
        self,
        *,
        name: str,
        code: str,
        description: str,
        predicate: Callable[[str], list[dict[str, Any]]],
    ) -> None:
        self.name = name
        self.code = code
        self.description = description
        self.predicate = predicate


class PineCheckRegistry:
    def __init__(self) -> None:
        self._checks: dict[str, PineCheck] = {}

    def register(self, check: PineCheck) -> None:
        if check.name in self._checks:
            raise ValueError(f"duplicate pine check name: {check.name}")
        self._checks[check.name] = check

    def __len__(self) -> int:
        return len(self._checks)

    def walk(self, text: str) -> list[tuple[PineCheck, list[dict[str, Any]]]]:
        """Every check with its findings, in registration order.

        Deliberately the only executor: upstream's registry also offers a by-name
        ``run()``, and its live call site (``policies.py:440``) uses exactly that, which is
        how ``walk()`` ended up with no production caller at all. A check declared here is
        reached by ``audit()`` or it is reached by nothing — and
        ``test_pine_audit.py::test_every_registered_check_runs_inside_the_audit`` says so.
        """
        return [(check, check.predicate(text)) for check in self._checks.values()]


PINE_CHECKS = PineCheckRegistry()


def pine_check(*, name: str, code: str, description: str):
    """Decorator: declare a check so ``audit()`` runs it — no call site to edit."""

    def wrap(
        predicate: Callable[[str], list[dict[str, Any]]],
    ) -> Callable[[str], list[dict[str, Any]]]:
        PINE_CHECKS.register(
            PineCheck(
                name=name, code=code, description=description, predicate=predicate
            )
        )
        return predicate

    return wrap


@pine_check(
    name="pine-lookahead-off",
    code=LOOKAHEAD,
    description="no live barmerge.lookahead_on: a signal must not read an unfinished bar",
)
def _check_lookahead(text: str) -> list[dict[str, Any]]:
    return [
        {
            "code": LOOKAHEAD,
            "name": "request.security",
            "line": line,
            "detail": "lookahead_on 读的是未收盘的高级别柱（pineRuntime.ts:1407 `src = h`），信号会重绘",
        }
        for line in lookahead_lines(text)
    ]


@pine_check(
    name="pine-ta-witness",
    code=PREFIX_UNPROVEN,
    description="every ta.* call has a prefix-invariance witness",
)
def _check_ta_witness(text: str) -> list[dict[str, Any]]:
    buckets = buckets_for_calls(ta_calls_from_pine(text))
    findings: list[dict[str, Any]] = []
    for bucket in (PREFIX_UNPROVEN, NO_WITNESS):
        for name in sorted(buckets[bucket]):
            findings.append(
                {
                    "code": bucket,
                    "name": name,
                    "detail": (
                        "判据二给它算过数，判据一的前缀不变式没跑过它 ⇒ 「不重绘」未被证明"
                        if bucket == PREFIX_UNPROVEN
                        else "两道判据都没有这个函数的见证 ⇒ 读数与重绘都未证明"
                    ),
                }
            )
    return findings


def audit(text: str) -> dict[str, Any]:
    """Run every declared check over one script and report what can be certified.

    ``walk()`` is the executor on purpose. Upstream's equivalent registry has the same
    method with no production caller (measured at `847ad379`: ``grep -rn '\\.walk('
    agent/src --include=*.py`` = 0 hits; its one caller anywhere is
    ``agent/tests/test_grounding_registry.py:26``), and its only live executor is a
    by-name ``run()`` at ``policies.py:440`` — so a check registered there never fires.
    Registering here means running, and ``checks_run`` says which ones ran.
    """
    calls = ta_calls_from_pine(text)
    findings: list[dict[str, Any]] = []
    checks_run: list[str] = []
    for check, issues in PINE_CHECKS.walk(text):
        checks_run.append(check.name)
        findings.extend(issues)
    assert checks_run, "没有已注册的检查——一条不跑任何门的审计不是通过，是空转"
    return {
        "calls": calls,
        "buckets": buckets_for_calls(calls),
        "findings": findings,
        "checks_run": checks_run,
        "repaint_clean": not findings,
    }


def _report(path: str, text: str) -> tuple[list[str], bool]:
    report = audit(text)
    proven = sorted(report["buckets"][REPAINT_PROVEN])
    lines = [
        f"{path}: "
        + ("可核验（不重绘有判据一兜住）" if report["repaint_clean"] else "不可核验"),
        f"  跑过的检查: {', '.join(report['checks_run'])}",
        f"  判据一兜住的 ta.*: {', '.join(proven) if proven else '（无）'}",
    ]
    for finding in report["findings"]:
        where = f"第 {finding['line']} 行 " if finding.get("line") else ""
        lines.append(f"  - {finding['code']} {where}{finding['name']}：{finding['detail']}")
    return lines, report["repaint_clean"]


def main(argv: list[str]) -> int:
    """Lint one or more ``.pine`` files. 0 = certifiable, 1 = findings, 2 = unreadable."""
    if not argv:
        # Not a pass: no input means nothing was certified, and the harness reads a
        # silent 0 as a green gate. ``test_the_cli_exits_nonzero_...`` pins this too.
        print("usage: python -X utf8 -m pine_oracle.audit <file.pine> [...]", file=sys.stderr)
        return 2
    clean = True
    rc = 0
    for path in argv:
        try:
            text = Path(path).read_text(encoding="utf-8-sig")
        except OSError as err:
            print(f"{path}: 读不到（{err}）—— 读不到不是通过", file=sys.stderr)
            rc = 2
            continue
        lines, ok = _report(path, text)
        print("\n".join(lines))
        clean = clean and ok
    if rc == 0 and not clean:
        rc = 1
    return rc


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
