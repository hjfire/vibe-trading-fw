"""Emit the value fixtures + manifest the JS oracle gate reads.

Every run rewrites the whole set from the reference implementations, so the
committed CSV is always reproducible from committed Python — which is what makes
the fixture trustworthy (test_pine_oracle_provenance.py).

This module writes the bar fixtures too: ``files`` must cover every byte the JS
gate reads, and a manifest that hashed only the answers would leave the questions
(the bars) free to drift.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path
from subprocess import check_output
from typing import Any, Optional

import numpy as np

from pine_oracle.emit_bars import BAR_JOBS, BARS_BASENAMES, BARS_META, emit as emit_bars
from pine_oracle.reference import PERIOD, REFERENCE, SCRIPTS
from pine_oracle.schema import (
    FIXTURE_DIR,
    REPO_ROOT,
    VALUE_HEADER,
    dump_manifest,
    fmt_float,
    sha256_of,
    validate_manifest,
    write_text_lf,
)

#: A statistic decided by one pass over a fixed window — one mean, one deviation
#: over the trailing ``n`` bars — is ``tight``; anything that carries recursion or
#: state across bars is ``loose``. The classification is by the *quantity*, not by
#: the code shape: ``ta_sma`` happens to be written with a prefix-sum difference,
#: which is still one mean over a fixed window, so ``sma`` is tight even though the
#: implementation accumulates. ``ema`` / ``rma`` are the recursive ones and stay
#: loose. Spec §5, tighten-only.
TIGHT_LINES: frozenset[str] = frozenset(
    {"sma", "stdev", "stdev_sample", "bb_basis", "bb_upper", "bb_lower"}
)

#: Lines whose reference value follows THIS engine's convention rather than the
#: TA-Lib/textbook one. Each entry states what the other convention would have
#: produced, so the adoption is a record, not a forgetting. Provenance asserts this
#: exact key set: a new entry (or a removal) has to be made in git, visibly.
ENGINE_CONVENTION: dict[str, str] = {
    "ema": "seeded on src[0] with no na warm-up; TA-Lib SMA-seeds at n-1 (pineTa.ts:134-145)",
    "rsi": "bar-0 change enters both rma streams as 0, so the first value is at n-1 and the "
           "seed window includes that 0; na-propagation would start at n (pineTa.ts:550-552)",
    "stoch_k": "highest/lowest have no full-window gate, so %K exists from the first bar whose "
               "partial window has hh!=ll (on the ramp fixture that is bar 1, and bar 0 is na only "
               "via the hh==ll rule, not via warm-up); a strict n-bar warm-up leaves n-1 bars na "
               "(pineTa.ts:212-224)",
    "macd": "all three outputs are dense from bar 0 because the underlying emas are; TA-Lib "
            "would leave the first slow-1 bars na (pineTa.ts:622-632)",
    "supertrend": "cold start takes direction +1 (`if na(atr[1]) direction := 1`), and on "
                  "the first bar — where upperBand[1]/lowerBand[1]/close[1] are all missing "
                  "— THIS implementation guards the previous band with a NaN guard, the "
                  "reading the engine also takes (pineTa.ts:700-713). Pine's own nz()/na "
                  "behaviour through that warm-up is NOT ANCHORED (EXTERNAL_ANCHORS.md logs "
                  "the fetch as 未取到，已放弃), so the guard is a choice, not a fact about "
                  "Pine: taking the body's nz() literally answers bar 0 differently — on all "
                  "four committed shapes it differs from the supertrend CSVs at index 0 alone "
                  "(0.0 where the CSV is empty), 8 na against the 9 committed, and it answers "
                  "+/-1 through the whole ATR warm-up where both sides of the gate leave na, "
                  "so st_direction would carry 0 na against the 9 committed (TV body "
                  "pineRealWorld.test.ts:65-93; readings recomputed in ta_supertrend's "
                  "docstring)",
    "st_direction": "-1 is the UPTREND and the plotted line is the lower band; the "
                    "folklore '+1 = up' reading is inverted (pineTa.ts:707-712)",
    "vwap": "takes no session argument and accumulates over the whole loaded range; that "
            "TradingView re-anchors each session is cited, not established — the only "
            "source in reach is this repo's own pre-existing assertion "
            "scriptLibrary.ts:160 「按整段区间累计（TV 为逐日锚定）」, and TradingView's "
            "documentation for it was NOT retrieved (EXTERNAL_ANCHORS.md), so the "
            "difference is a backlog entry in COVERAGE.md rather than a passing gate "
            "(pineTa.ts:960-970). The Pine text "
            "passes hlc3 EXPLICITLY: that is the engine's own default source for an "
            "argument-less call (pineTa.ts:963), while a bare `ta.vwap` never reaches the "
            "ta.* dispatcher — that branch is on the call path only "
            "(pineRuntime.ts:1537-1541) — and reads as an undefined variable (measured: "
            "未定义的变量 \"ta.vwap\", task-6 report Step 7)",
}

#: Integer-valued outputs: a sign bit has no rounding to forgive, so the strictest
#: tier is the honest one. Tighten-only (spec §5) — nothing may move out of this set.
EXACT_LINES: frozenset[str] = frozenset({"st_direction"})

#: Anchors this harness reads its conventions off, in the four string fields
#: ``pineOracleFixtures.ts``'s ``OracleAnchor`` declares (name/value/source/
#: retrieved_at). ``value`` is a STRING, not a float: these are textual readings
#: (a sign, a source name), not measurements to be compared numerically.
#:
#: Task 6 Step 8 asked for 3-6 third-party numbers. Measured outcome: every
#: third-party fetch this machine can attempt failed (WebSearch returns titles
#: only, no quotable text; WebFetch to ta-lib.org / en.wikipedia.org /
#: gist.github.com / tradingview.com all errored with "fetch failed", and
#: stackoverflow.com answered 403 — see task-6-report.md Step 8 for the verbatim
#: errors), and the brief forbids inventing a number to fill a quota. So this
#: list carries ONLY what can be quoted from committed text, each source labelled
#: ``in-repo:`` so no reader mistakes it for a third-party document. The three
#: dropped items (rsi ``down == 0``, stdev/bb ddof, atr Wilder seeding) are
#: recorded as "未取到，已放弃" in ``EXTERNAL_ANCHORS.md``, which is the ledger
#: this list is generated from. An entry may only be added here when the quoted
#: text is reachable and read, never when a search result merely looks related.
EXTERNAL_ANCHORS: list[dict[str, str]] = [
    {
        "name": "st_direction_uptrend_sign",
        "value": "-1",
        "source": "in-repo: frontend/src/lib/__tests__/pineRealWorld.test.ts:65-93, "
                  "TradingView's published Pine body committed verbatim — :83 "
                  "`direction := close > upperBand ? -1 : 1` and :86 "
                  "`superTrend := direction == -1 ? lowerBand : upperBand`, so the "
                  "uptrend is -1 and its line is the LOWER band. Anchors "
                  "ENGINE_CONVENTION[\"st_direction\"] and "
                  "test_direction_minus_one_is_the_uptrend_not_the_folklore_one; the "
                  "same text is what the reference transcribes, so this pins the "
                  "convention, not an independent numeric check of TV's algorithm.",
        "retrieved_at": "2026-10-04",
    },
    {
        "name": "vwap_source_and_anchor_range",
        "value": "hlc3",
        "source": "in-repo: frontend/src/lib/scriptLibrary.ts:154-165, the fork's own "
                  "VWAP library script — :165 `v = ta.vwap(hlc3)` is the only live "
                  "`ta.vwap` use in the corpus (always with an explicit source, never "
                  "bare), and :160 states the anchoring in words: "
                  "\"按整段区间累计（TV 为逐日锚定）\" — accumulated over the whole "
                  "loaded range, whereas TradingView re-anchors each session. Anchors "
                  "ENGINE_CONVENTION[\"vwap\"] and the backlog entry COVERAGE.md must "
                  "carry; it is a record of a known deviation, NOT a verdict on the "
                  "engine.",
        "retrieved_at": "2026-10-04",
    },
]

#: basename -> (rows, writes_the_session_column), taken from emit_bars so the seeds
#: and shapes cannot be restated wrong here.
BARS_SETS: dict[str, tuple[list[dict[str, Any]], bool]] = {
    name: (rows, with_session) for name, rows, with_session in BAR_JOBS
}
assert set(BARS_SETS) == set(BARS_BASENAMES) == set(BARS_META), (
    sorted(BARS_SETS),
    sorted(BARS_BASENAMES),
    sorted(BARS_META),
)


def _columns(rows: list[dict[str, Any]]) -> dict[str, np.ndarray]:
    return {
        k: np.asarray([r[k] for r in rows], dtype="float64")
        for k in ("open", "high", "low", "close", "volume")
    }


def _session(rows: list[dict[str, Any]]) -> Optional[np.ndarray]:
    if "session" not in rows[0]:
        return None
    return np.asarray([r["session"] for r in rows], dtype="int64")


def values_csv(series: np.ndarray) -> str:
    lines = [",".join(VALUE_HEADER)]
    for i, v in enumerate(series):
        lines.append(f"{i},{'' if np.isnan(v) else fmt_float(float(v))}")
    return "\n".join(lines) + "\n"


def emit(out_dir: Path = FIXTURE_DIR) -> dict[str, Any]:
    files = {
        str(path.relative_to(out_dir)).replace("\\", "/"): digest
        for path, digest in emit_bars(out_dir)
    }
    tier: dict[str, str] = {}
    exemption: dict[str, str] = {}
    lines_by_batch: dict[str, list[str]] = {}
    for batch_name, fn in REFERENCE.items():
        emitted: set[str] = set()
        for bars_name, (rows, _with_session) in BARS_SETS.items():
            series = fn(_columns(rows), PERIOD, _session(rows))
            for line_name, arr in series.items():
                rel = f"values/{line_name}@{bars_name}.csv"
                path = out_dir / "values" / f"{line_name}@{bars_name}.csv"
                write_text_lf(path, values_csv(arr))
                files[rel] = sha256_of(path)
                emitted.add(line_name)
                tier[line_name] = (
                    "exact"
                    if line_name in EXACT_LINES
                    else "tight"
                    if line_name in TIGHT_LINES
                    else "loose"
                )
                exemption[line_name] = "strict"
        lines_by_batch[batch_name] = sorted(emitted)
    manifest: dict[str, Any] = {
        "na_encoding": "empty",
        "line_ending": "lf",
        "period": {"default": PERIOD},
        "seed": {name: meta[0] for name, meta in BARS_META.items()},
        "shape": {name: meta[1] for name, meta in BARS_META.items()},
        "scripts": SCRIPTS,
        "lines": lines_by_batch,
        "tolerance_tier": tier,
        "exemption": exemption,
        # 每一处「采纳引擎约定而非教科书/TA-Lib 约定」都在这张表里留名（见其定义处）。
        "convention": ENGINE_CONVENTION,
        # 外部锚点：只收「读得到的文本」，取数过程与放弃条目见 EXTERNAL_ANCHORS.md。
        "external_anchors": EXTERNAL_ANCHORS,
        "generated_at": date.today().isoformat(),
        "generator": "agent/pine_oracle/emit_fixtures.py",
        # Read from the repo this module lives in, not from wherever the caller
        # happened to cd into — the rest of the module is ``__file__``-derived and
        # a cwd-dependent line here would crash (or mislabel) outside the repo root.
        "head_sha": check_output(
            ["git", "rev-parse", "--short", "HEAD"], cwd=REPO_ROOT, text=True
        ).strip(),
        # manifest.json 自己不进 files：自哈希是「先写后哈希」的循环，它既不可能被
        # 自己包含，也不可能被校验，列上它只是假装覆盖了。
        "files": files,
    }
    errors = validate_manifest(manifest)
    if errors:
        raise SystemExit("manifest invalid: " + "; ".join(errors))
    write_text_lf(out_dir / "manifest.json", dump_manifest(manifest))
    return manifest


if __name__ == "__main__":
    m = emit()
    print(
        f"{len(m['files'])} files, {len(m['tolerance_tier'])} lines tiered, "
        f"batches={ {k: len(v) for k, v in m['lines'].items()} }"
    )
