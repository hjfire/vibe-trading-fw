# agent/tests/pine_oracle/test_pine_audit.py
"""Gate 3: audit a ``.pine`` script for the two things this harness can actually prove.

The harness has two witnesses and they answer different questions. 判据二 (the numeric
oracle) proves *arithmetic* — engine vs an independently written Python reference on the
same full bar array. 判据一 (prefix invariance) is the only thing here that proves a value
does not move when future bars are appended, i.e. **不重绘**. So a function gate 2 prices
but gate 1 never probes (``rsi``/``atr``/``bb``/``macd``/``stoch``) has no non-repaint
witness yet, and that has to be said out loud instead of being folded into "covered".

Both shapes that make the claim anyway are real, with coordinates:

    frontend/src/lib/pineRuntime.ts:1376  asStr(this.val(laExpr)).includes("lookahead_on")
    frontend/src/lib/pineRuntime.ts:1407  const src = lookahead ? h : h - 1

The engine accepts ``lookahead=barmerge.lookahead_on`` silently, and this repo's own
committed test names the result "(repaint)" — ``pineResample.test.ts:165``, asserting
``v[0]`` sees day 0's own future close. A real community strategy in the local corpus does
exactly that and trades on the value two lines later
(``.qoder/tmp/pine_corpus/35_hasnocool_tradingview_pine_scripts__Fake_Strategy.pine:31-33``).
That corpus is local-only and never committed (bulk third-party ``.pine`` stays out of the
repo), so the shape is inlined below rather than read from disk.
"""

import os
import subprocess
import sys
from pathlib import Path

import pytest

from pine_oracle.audit import (
    LOOKAHEAD,
    NO_WITNESS,
    PINE_CHECKS,
    PREFIX_UNPROVEN,
    REPAINT_PROVEN,
    audit,
    lookahead_lines,
    repainting_calls,
    ta_calls_from_pine,
)
from pine_oracle.coverage import COVERED, builtins_from_source, gate1_functions
from pine_oracle.schema import REPO_ROOT

PINE_TA = REPO_ROOT / "frontend" / "src" / "lib" / "pineTa.ts"

#: The only ``.pine`` text this repo actually tracks: ``git ls-files | grep -c '\.pine$'``
#: == 53 at `847ad379`, all of them under this fixture dir (the bulk community corpus,
#: including the file whose ``lookahead_on`` is inlined above, stays out of the repo).
CORPUS = REPO_ROOT / "frontend" / "src" / "lib" / "__tests__" / "__fixtures__" / "corpus-smoke"

#: What the audit says about each tracked corpus file — only the files it REFUSES, with
#: the distinct finding codes as measured at `847ad379` (26 of 53 certifiable, 0 live
#: ``lookahead_on``). Transcribed from this directory, not from a memory of it.
EXPECTED_CORPUS_VERDICTS: dict[str, tuple[str, ...]] = {
    "bands_and_channels/interquartile_range_bands.pine": (NO_WITNESS,),
    "bands_and_channels/stoller_average_range_channels.pine": (NO_WITNESS, PREFIX_UNPROVEN),
    "movings/fractal_adaptive_moving_average.pine": (NO_WITNESS,),
    "movings/hampel_filter.pine": (NO_WITNESS,),
    "movings/hull_moving_average.pine": (NO_WITNESS,),
    "movings/kaufman_adaptive_moving_average.pine": (NO_WITNESS,),
    "movings/least_squares_moving_average.pine": (NO_WITNESS,),
    "movings/vidya_variable_index_dynamic_average.pine": (NO_WITNESS,),
    "oscillators/mfi_money_flow_index.pine": (NO_WITNESS,),
    "oscillators/rainbow_oscillator.pine": (NO_WITNESS,),
    "oscillators/stc_schaff_trend_cycle.pine": (NO_WITNESS, PREFIX_UNPROVEN),
    "oscillators/stochastic.pine": (NO_WITNESS, PREFIX_UNPROVEN),
    "oscillators/stochastic_connors_rsi.pine": (NO_WITNESS, PREFIX_UNPROVEN),
    "oscillators/tsi_true_strength_index.pine": (NO_WITNESS,),
    "statistics/close_to_close_percent_change_distribution.pine": (NO_WITNESS,),
    "statistics/roi_return_on_investment.pine": (NO_WITNESS,),
    "statistics/ytd_year_to_date_percent_return.pine": (NO_WITNESS,),
    "statistics/z_score.pine": (NO_WITNESS,),
    "trailing_stops/chandelier_exit.pine": (NO_WITNESS, PREFIX_UNPROVEN),
    "trailing_stops/halftrend.pine": (NO_WITNESS, PREFIX_UNPROVEN),
    "v6/errors/theilu.pine": (NO_WITNESS,),
    "v6/errors/wmape.pine": (NO_WITNESS,),
    "v6/errors/wrmse.pine": (NO_WITNESS,),
    "volatility/gopalakrishnan_range_index.pine": (NO_WITNESS,),
    "volatility/ulcer_index.pine": (NO_WITNESS,),
    "volume/negative_volume_index.pine": (NO_WITNESS,),
    "volume/net_volume.pine": (NO_WITNESS,),
}

#: Corpus file 35, lines 28-33: a live ``lookahead_on`` whose result feeds
#: ``strategy.entry`` two lines later.
REPAINT_STRATEGY = (
    "//@version=5\n"
    'strategy("Fake Strategy", overlay=true)\n'
    'resolution = timeframe.in_seconds(timeframe.period) > 86400 ? "W" : "D"\n'
    "[htfClose, htfHigh, htfLow] = request.security(syminfo.tickerid, resolution, "
    "[close, high, low], lookahead=barmerge.lookahead_on)\n"
    "if(close != htfClose and htfHigh > high and bar_index > last_bar_index - 5000)\n"
    "    strategy.entry('Long', strategy.long)\n"
)

#: Corpus file 16, line 236: the same token inside a ``//`` comment. Flagging it would
#: make the audit cry wolf over text nobody executes.
COMMENTED_LOOKAHEAD = (
    "//@version=5\n"
    'indicator("Cloud")\n'
    "// KijunD = getMidPoint(basePeriodsK, 0)\n"
    '// request.security(syminfo.tickerid, "D", pipSizeCalc[1], lookahead=barmerge.lookahead_on)\n'
    "plot(close, \"close\")\n"
)

CLEAN_SCRIPT = (
    "//@version=5\n"
    'indicator("clean")\n'
    "plot(ta.sma(close, 5), \"sma\")\n"
    "plot(ta.ema(close, 9), \"ema\")\n"
)


@pytest.fixture(scope="module")
def pine_ta_text() -> str:
    return PINE_TA.read_text(encoding="utf-8")


def test_a_live_ta_call_counts_and_a_commented_one_does_not() -> None:
    text = (
        "//@version=5\n"
        'indicator("p")\n'
        '// plot(ta.rsi(close, 14), "rsi")\n'
        "plot(ta.sma(close, 5), \"sma\")\n"
        "plot(ta.ema(close, 9), \"ema\")\n"
    )
    assert ta_calls_from_pine(text) == frozenset({"sma", "ema"})


def test_a_double_slash_inside_a_string_is_not_a_comment() -> None:
    """A line-agnostic ``//`` cut would truncate this line at the ``"9//1"`` title and
    silently lose the ``sma`` call that follows it — a missing call reads as "clean"."""
    text = (
        "//@version=5\n"
        'indicator("p")\n'
        'plot(ta.ema(close, 9), "9//1"), plot(ta.sma(close, 5), "5")\n'
    )
    assert ta_calls_from_pine(text) == frozenset({"ema", "sma"})


def test_a_legacy_bare_alias_counts_as_the_same_builtin() -> None:
    """``sma(close, 5)`` written bare is the v3/v4 idiom, and the engine answers it
    through ``LEGACY_SERIES``, which is gated ``ver <= 4`` (``pineRuntime.ts:94-100``,
    ``:1169``). Attributing it to the same builtin is what keeps a v3 script from being
    certified by a reader that only understands the ``ta.`` prefix."""
    legacy = (
        "//@version=3\n"
        'indicator("p")\n'
        'plot(sma(close, 5), "sma")\n'
    )
    assert ta_calls_from_pine(legacy) == frozenset({"sma"})
    v5 = legacy.replace("@version=3", "@version=5")
    assert ta_calls_from_pine(v5) == frozenset()


def test_lookahead_on_is_found_on_its_live_line_only() -> None:
    assert lookahead_lines(REPAINT_STRATEGY) == (4,)
    assert lookahead_lines(CLEAN_SCRIPT) == ()
    assert lookahead_lines(COMMENTED_LOOKAHEAD) == ()
    # fail-closed on the token rather than on one call shape: pineRuntime.ts:1376 decides
    # by `...includes("lookahead_on")`, which the named and the positional form both
    # reach, so any live occurrence is a live lookahead.
    assert lookahead_lines(
        'x = request.security(syminfo.tickerid, "D", close, false, barmerge.lookahead_on)\n'
    ) == (1,)


def test_the_default_security_form_is_clean() -> None:
    """``pineRuntime.ts:1376`` leaves ``lookahead`` false when the argument is absent and
    ``:1407`` then reads ``h - 1`` — the last completed HTF bar, the non-repainting form,
    so the audit must not flag it."""
    report = audit(
        "//@version=5\n"
        'indicator("htf")\n'
        'htf = request.security(syminfo.tickerid, "D", ta.sma(close, 5))\n'
        "plot(htf, \"htf\")\n"
    )
    assert report["findings"] == []
    assert report["calls"] == frozenset({"sma"})
    assert report["repaint_clean"] is True


def test_repainting_calls_are_the_prefix_gate_roster_not_the_oracle_batch() -> None:
    """Five functions are priced by the oracle and probed by no prefix run
    (``GATE2_FUNCTIONS - gate1_functions()`` = rsi/atr/bb/macd/stoch), so a script using
    only those still has no 不重绘 witness."""
    assert repainting_calls(frozenset({"sma", "ema", "sar"})) == frozenset()
    assert repainting_calls(COVERED) == frozenset({"rsi", "atr", "bb", "macd", "stoch"})
    assert gate1_functions() <= COVERED


def test_the_three_buckets_partition_the_calls() -> None:
    report = audit(
        "//@version=5\n"
        'indicator("mix")\n'
        "plot(ta.sma(close, 5), \"a\")\n"
        "plot(ta.rsi(close, 14), \"b\")\n"
        "plot(ta.mfi(close, 14), \"c\")\n"
    )
    assert report["calls"] == frozenset({"sma", "rsi", "mfi"})
    buckets = report["buckets"]
    assert buckets[REPAINT_PROVEN] == frozenset({"sma"})
    assert buckets[PREFIX_UNPROVEN] == frozenset({"rsi"})
    assert buckets[NO_WITNESS] == frozenset({"mfi"})
    # four `==` assertions can pass on four empty sets; a counted partition cannot
    assert sum(len(names) for names in buckets.values()) == len(report["calls"]) == 3
    assert not buckets[REPAINT_PROVEN] & buckets[PREFIX_UNPROVEN]
    assert not buckets[PREFIX_UNPROVEN] & buckets[NO_WITNESS]


def test_a_finding_names_the_function_and_its_bucket() -> None:
    """``mfi`` is a real dispatch-table builtin sitting in the 62-row backlog, so the
    honest verdict is "no witness at all", not "unsupported"."""
    report = audit(
        "//@version=5\n"
        'indicator("m")\n'
        "plot(ta.mfi(hlc3, 14), \"mfi\")\n"
    )
    assert [(f["code"], f["name"]) for f in report["findings"]] == [(NO_WITNESS, "mfi")]
    assert report["repaint_clean"] is False


def test_every_registered_check_runs_inside_the_audit() -> None:
    """Upstream's declared registry has a ``walk()`` with zero production callers: the only
    executor is a by-name ``run()`` at ``agent/src/agent/grounding/policies.py:440``, so a
    newly registered check there never fires. Measured at `847ad379`:
    ``grep -rn '\\.walk(' agent/src --include=*.py`` = 0 hits, and the only caller anywhere
    is upstream's own test at ``agent/tests/test_grounding_registry.py:26``. Ours refuses
    the same half-finished interface — registering is not running, and an audit that skips
    a check goes red here."""
    registered = sorted(check.name for check, _ in PINE_CHECKS.walk(REPAINT_STRATEGY))
    assert len(registered) == len(PINE_CHECKS) >= 2, registered
    report = audit(CLEAN_SCRIPT)
    assert sorted(report["checks_run"]) == registered
    assert report["checks_run"], "no check ran — an empty run list is not a pass"


def test_the_repaint_script_is_caught_by_line_not_by_name() -> None:
    """The strategy calls no ``ta.*`` at all: its only defect is the lookahead argument,
    so a check that only reads function names would call this script clean."""
    report = audit(REPAINT_STRATEGY)
    assert report["calls"] == frozenset()
    assert [(f["code"], f["line"]) for f in report["findings"]] == [(LOOKAHEAD, 4)]
    assert report["repaint_clean"] is False
    assert audit(CLEAN_SCRIPT)["repaint_clean"] is True


def test_the_cli_exits_nonzero_only_when_a_script_cannot_be_certified(tmp_path: Path) -> None:
    bad = tmp_path / "repaint.pine"
    bad.write_text(REPAINT_STRATEGY, encoding="utf-8")
    good = tmp_path / "clean.pine"
    good.write_text(CLEAN_SCRIPT, encoding="utf-8")

    def run(path: Path) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, "-B", "-X", "utf8", "-m", "pine_oracle.audit", str(path)],
            capture_output=True,
            text=True,
            encoding="utf-8",
            env={**os.environ, "PYTHONPATH": str(REPO_ROOT / "agent")},
            check=False,
        )

    clean = run(good)
    assert clean.returncode == 0, clean.stdout + clean.stderr
    assert "sma" in clean.stdout, clean.stdout

    dirty = run(bad)
    assert dirty.returncode == 1, dirty.stdout + dirty.stderr
    assert "lookahead" in dirty.stdout, dirty.stdout

    missing = run(tmp_path / "nope.pine")
    assert missing.returncode == 2, missing.stdout + missing.stderr

    no_input = subprocess.run(
        [sys.executable, "-B", "-X", "utf8", "-m", "pine_oracle.audit"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
        env={**os.environ, "PYTHONPATH": str(REPO_ROOT / "agent")},
    )
    assert no_input.returncode == 2, (
        "没有输入路径却退出 0——一条没比任何东西的审计不能报成通过"
    )
    assert "usage" in no_input.stderr, no_input.stderr


def test_the_audit_reads_the_engine_table_it_claims_to(pine_ta_text: str) -> None:
    """``NO_WITNESS`` is not a hand-copied list: a builtin added to ``pineTa.ts`` shows up
    as a missing witness the next time the audit reads the table, the same way
    ``test_coverage_ledger`` refuses a ledger that lags the dispatch table."""
    builtins = builtins_from_source(pine_ta_text)
    assert len(builtins) == 74, len(builtins)
    text = "//@version=5\n" + "".join(f'plot(ta.{n}(close), "{n}")\n' for n in sorted(builtins))
    report = audit(text)
    assert report["calls"] == builtins
    assert report["buckets"][NO_WITNESS] == builtins - COVERED
    assert len(report["buckets"][NO_WITNESS]) == 62


def test_the_tracked_corpus_verdicts_are_the_roster_recorded() -> None:
    """The 53 tracked ``.pine`` files, audited: 26 certifiable, 27 refused, 0 lookahead.

    Why a roster and not a rate: every other gate in this file feeds the audit an inline
    script, so nothing here says what the audit concludes about text the repo actually
    ships. A rate would be worse than a roster — 「26/53 可核验」 stays green while a
    file moves from ``no_witness`` to ``prefix_unproven`` and another moves the other way.
    The per-file code set refuses that, and refuses a corpus addition nobody audited.

    The direction this can go red in is the one the harness polices (只准调严): widening
    判据一's ``SCRIPTS`` roster (``coverage.gate1_functions``, read at import time) drops
    files out of ``prefix_unproven``, so this table names which ones and asks for the
    transcription to be re-measured, not for the expectation to be edited to match.

    Why there is no separate ``assert no lookahead here`` loop: ``grep -rln lookahead_on``
    over this dir is 0 files at `847ad379`, so such a loop would iterate over nothing and
    stay green whatever the audit did — an empty-set pass, the exact defect
    ``test_coverage_ledger`` refuses. The token being absent from every tracked file
    (comment or live) is a READING recorded above; the refusal that has to be live is the
    roster equality, and a file gaining a live lookahead would enter it as
    ``+('lookahead_on',)`` under that file's name. The check itself is proven by
    :func:`test_lookahead_on_is_found_on_its_live_line_only`, whose input does contain it.

    Readings are at `847ad379` with `audit.py` in the working tree (untracked at the time
    of the run) — re-run ``rglob`` count and the asserts below if either moves.
    """
    files = sorted(CORPUS.rglob("*.pine"))
    assert len(files) == 53, f"跟踪语料只有 {len(files)} 份——门的前提是比过全部 53 份"
    assert EXPECTED_CORPUS_VERDICTS, "名单为空——对着空名单比是真空通过，不是通过"

    verdicts: dict[str, tuple[str, ...]] = {}
    for path in files:
        report = audit(path.read_text(encoding="utf-8-sig"))
        codes = tuple(sorted({f["code"] for f in report["findings"]}))
        if codes:
            verdicts[path.relative_to(CORPUS).as_posix()] = codes

    wrong = {
        rel: (EXPECTED_CORPUS_VERDICTS.get(rel), verdicts.get(rel))
        for rel in set(verdicts) | set(EXPECTED_CORPUS_VERDICTS)
        if verdicts.get(rel) != EXPECTED_CORPUS_VERDICTS.get(rel)
    }
    assert not wrong, (
        f"跟踪语料的审计结论与名单不符（{len(wrong)} 处，每项是 文件名 → (记录, 当场)）：{wrong}"
    )
    assert len(verdicts) == len(EXPECTED_CORPUS_VERDICTS) == 27, len(verdicts)
    assert len(files) - len(verdicts) == 26
