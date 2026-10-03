"""Guard BOTH sides of the 2026-10 upstream merge against silent loss.

`UPSTREAM_OWNED` (tools/test_wiki_drift.py) proves one direction only: we did not
edit upstream's four protected prefixes. It cannot prove the direction a sync
actually risks — that `git merge` kept OUR hunks in the 14 files both sides
changed. Zero conflicts is not evidence of that: the two sides edited *different
regions* of the same file, which is exactly how one side's hunk disappears while
the merge still reports success.

Anchors are literals captured on MERGE_SHA d9a2fdc5 from the two-sided diffs
against merge base 18027a0c, NOT a live `git diff`, because the fork workflow runs
in a checkout whose refs may not carry the base.

How this table was built (ledger: 项目档案.md, the 2026-10 upstream-sync section)
--------------------------------------------------------------------------------
The durable readings of the generator run live in `项目档案.md`, which Task 8 writes
for this round; the per-needle implant forensics live in the round's working ledger
(`.superpowers/sdd/2026-10-03-upstream-sync/`), which is git-ignored and therefore a
dead link in a fresh CI checkout — do not chase it there first. For each side,
needles come from that side's *added* lines (`git diff --name-only 18027a0c..518d793f`
intersected with `18027a0c..f21aa13d` for the file set), in this order:

1. primary rule — `.py`: added `def` / `async def` / `class` lines (indentation
   kept, so the needle pins the block it sits in too); `.md`: added heading lines.
   Deduped, >= 12 chars, quote-free.  ->  20 needles
2. the declared relaxation — added module-level constant assignments (ALL_CAPS
   name, optional `: <type>`, then `=`).  ->  1 needle: our loader_health.py hunk
   edits the `EXCLUDED_PUBLIC_SOURCES` set literal and adds no def there.
3. hand-pick, one per (side, file) where both rules came up empty — the 7
   translated READMEs on both sides, ours/SKILL.md, ours+theirs of the two
   `src/factors/` files, theirs/market_data.py: the shortest added line that is
   >= 25 chars, holds no double quote, and occurs exactly once in the merged file.
   ->  19 needles. Each was checked against the OTHER side's added lines for the
   same file as well, so no hand-pick is a line both sides happened to add: every
   needle still attributes to exactly one side.
   Two of those 19 are *comment* lines, not code: `# happening (or dismiss a real one
   when it finishes early).` on our side of `agent/src/factors/cli_handlers.py` and
   `# table is the fallback for unconverted data (#1541).` on their side of
   `agent/src/market_data.py`. For those two (side, file) pairs no rule-legal code
   line existed, so do not read them as code-level guarantees — and note that our
   side of cli_handlers.py, the file whose theirs side is the declared hole below,
   is guarded by exactly that one prose line.

Needle strength is `merged_text.count(needle)`, and `count == 1` is an ASSERTED
invariant of the per-file test, not a reading that only lives in this comment:
`count == 0` reports as vanished (that side's hunk is gone) and `count > 1` reports
as weakened (the literal is still on the tree but no longer proves its own hunk,
because the second copy may belong to the other side or to upstream). Captured on
d9a2fdc5: 40 of 40 count exactly 1 — zero count==0 (nothing was eaten by CRLF,
indentation or the quote rule) and zero count>1 — so the table carries no waived
weak pins and nothing had to be dropped or re-picked for weakness.

Nothing was dropped for the grep gates either: `tools/ci_grep_gates.sh` gate (b)
scans `tools/*.py` for a trademark literal, and every needle here is quote-free
prose or a signature that carries none of it — the gate output is line-for-line
identical with this file on the tree (rc=1 before and after, `docs/` 0 hits).

`agent/src/factors/cli_handlers.py` is the one hole in the table, declared in
`NO_ANCHORS["theirs"]` with its reason in `NO_ANCHOR_REASONS["theirs"]` (the
partition test demands the reason exist as data, keyed per side) rather than left as
a missing row. A declared hole SKIPS, and a skip prints no reason under the `-q` the
CI line runs with — the reason text only reaches a log with `-rs`, which the pinned
workflow line cannot carry. So the *number* of holes is guarded by an assertion
(`MAX_DECLARED_HOLES`), not by log readability: declaring one more hole than the
merge captured is a hard red on that side whatever pytest prints.
"""

from __future__ import annotations

from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
#: provenance only — no assertion depends on it
MERGE_BASE = "18027a0c"


#: The 14 files BOTH sides of the 2026-10 merge touched — Task 1's
#: `comm -12` reading, reproduced by the generator and re-asserted (== 14) by the
#: partition test, because every shape assertion below is only as wide as this set.
OVERLAP_FILES: tuple[str, ...] = (
    'README.md',
    'README_ar.md',
    'README_es.md',
    'README_id.md',
    'README_ja.md',
    'README_ko.md',
    'README_zh.md',
    'agent/SKILL.md',
    'agent/backtest/loader_health.py',
    'agent/backtest/loaders/akshare_loader.py',
    'agent/backtest/loaders/registry.py',
    'agent/src/factors/bench_runner_strict.py',
    'agent/src/factors/cli_handlers.py',
    'agent/src/market_data.py',
)

#: Per-side literals, keyed by the paths of OVERLAP_FILES. A file missing from
#: a side's dict is not silently unchecked: it has to show up in NO_ANCHORS.
ANCHORS: dict[str, dict[str, tuple[str, ...]]] = {
    'ours': {
        'README.md': ('   `VALID_SOURCES` in `agent/backtest/loaders/registry.py`.',),
        'README_ar.md': ('   `VALID_SOURCES` في `agent/backtest/loaders/registry.py`.',),
        'README_es.md': ('   a `VALID_SOURCES` en `agent/backtest/loaders/registry.py`.',),
        'README_id.md': ('   `VALID_SOURCES` in `agent/backtest/loaders/registry.py`.',),
        'README_ja.md': ('vibe-trading warehouse list    # ローカルのバー倉庫：sync / audit / list / sql',),
        'README_ko.md': ('3. **이름 허용** 으로 설정 검증 통과 —— `agent/backtest/loaders/registry.py`의',),
        'README_zh.md': ('   `agent/backtest/loaders/registry.py` 的 `_LOADER_MODULES`。',),
        'agent/SKILL.md': ('| `get_market_data` | Fetch OHLCV data (auto-detect + ordered fallback across 29 sources) | None* |',),
        'agent/backtest/loader_health.py': ('EXCLUDED_PUBLIC_SOURCES = {',),
        'agent/backtest/loaders/akshare_loader.py': (
            'def _sina_stock_symbol(code: str) -> Optional[str]:',
            'def _with_exchange_suffix(code: Any, exchange: Any) -> Optional[str]:',
            'def _date_value_columns(frame: pd.DataFrame) -> tuple[str, str]:',
            'def _assert_cumulative(series: pd.Series, window: pd.DatetimeIndex | None = None) -> None:',
            'def _assert_share_basis(volume: pd.Series, amount: pd.Series, close: pd.Series) -> None:',
            'def _sina_bars(raw: pd.DataFrame) -> pd.DataFrame:',
            'def _sina_factor(ak, symbol: str, axis: pd.DatetimeIndex) -> pd.DataFrame:',
            '    def fetch_raw_with_factor(',
            '    def _fetch_sina_raw_pair(',
            '    def fetch_universe_members(',
        ),
        'agent/backtest/loaders/registry.py': ('def _warehouse_hint() -> str:',),
        'agent/src/factors/bench_runner_strict.py': ('    data_source: str | None = None,',),
        'agent/src/factors/cli_handlers.py': ('            # happening (or dismiss a real one when it finishes early).',),
        'agent/src/market_data.py': (
            'def _futu_gateway_live() -> bool:',
            'def _preferred_source(code: str) -> str:',
        ),
    },
    'theirs': {
        'README.md': ('For strict factor benchmarks, pass `--training-cutoff YYYY-MM-DD` to',),
        'README_ar.md': ('│   ├── mcp_server.py               # MCP server — 75 tools for OpenClaw / Claude Desktop',),
        'README_es.md': ('│   ├── mcp_server.py               # Servidor MCP — 75 herramientas para OpenClaw / Claude Desktop',),
        'README_id.md': ('│   ├── mcp_server.py               # MCP server — 75 tools for OpenClaw / Claude Desktop',),
        'README_ja.md': ('│   ├── mcp_server.py               # MCP サーバー — OpenClaw / Claude Desktop 向け 75 tools',),
        'README_ko.md': ('│   ├── mcp_server.py               # MCP server — 75 tools for OpenClaw / Claude Desktop',),
        'README_zh.md': ('│   ├── mcp_server.py               # MCP server —— 75 个工具，面向 OpenClaw / Claude Desktop',),
        'agent/SKILL.md': ('## Available MCP Tools (75)',),
        'agent/backtest/loader_health.py': (
            'def sanitize_evidence(text: str) -> str | None:',
            'class _LoaderWarningCollector(logging.Handler):',
            '    def __init__(self) -> None:',
            '    def emit(self, record: logging.LogRecord) -> None:',
        ),
        'agent/backtest/loaders/akshare_loader.py': ('    def _fetch_a_share_raw(',),
        'agent/backtest/loaders/registry.py': ('def frame_caliber(frame: object, source: str, market: str | None = None, symbol: str | None = None) -> str:',),
        'agent/src/factors/bench_runner_strict.py': ('    training_cutoff: str | None = None,',),
        'agent/src/market_data.py': ('                # table is the fallback for unconverted data (#1541).',),
    },
}

#: Files where a side has no anchor to read, keyed BY SIDE. Every entry must carry
#: its reason in NO_ANCHOR_REASONS under the same side; an undeclared gap here is the
#: vacuous pass this module exists to prevent.
NO_ANCHORS: dict[str, tuple[str, ...]] = {
    "ours": (),
    "theirs": ("agent/src/factors/cli_handlers.py",),
}

#: Why a side has nothing to read here. Kept as data, not just a comment, so the
#: partition test can demand it — an excuse with no reason behind it is still a
#: hole. Nested by side on purpose: a file-keyed map let one side's reason excuse the
#: OTHER side's future hole in the same file (cli_handlers.py is pinned on our side,
#: which is now enforced by MAX_DECLARED_HOLES["ours"] == 0, not just asserted by a
#: comment).
NO_ANCHOR_REASONS: dict[str, dict[str, str]] = {
    "ours": {},
    "theirs": {
        "agent/src/factors/cli_handlers.py": (
            "theirs-only hunk here is the --training-cutoff CLI plumbing: that side adds "
            "no def/class and no module-level constant in this file, and every one of its "
            "added lines is either a double-quoted argparse/error string (a needle may "
            "not carry quotes) or a short structural fragment such as `        if (` that "
            "also repeats 20+ times in the merged file — so no >=25-char, unique, "
            "quote-free literal exists to pin. Widening the quote rule was not an option "
            "taken here; the plan's own escape hatch is this declaration."
        ),
    },
}

#: Ceiling on declared holes per side, as captured on d9a2fdc5: ours 0, theirs 1.
#: TOTAL_ANCHORS is only a floor on the SUM, so without this cap a table can be
#: redistributed — move a file's needles into another file, excuse the vacated file,
#: and the total still clears the floor while the partition stays self-consistent,
#: quietly un-guarding one more file per round. The cap is also the only visible
#: consequence of an added hole, since a skip reason never reaches a `-q` log.
MAX_DECLARED_HOLES: dict[str, int] = {"ours": 0, "theirs": 1}

#: Captured on d9a2fdc5: 20 primary-rule + 1 constant-rule + 19 hand-picked
#: needles, split ours 24 / theirs 16. A floor only — see MAX_DECLARED_HOLES for the
#: ceiling that stops the same total from being spread over fewer files.
TOTAL_ANCHORS = 40


@pytest.mark.parametrize("side", ("ours", "theirs"))
def test_the_anchor_table_is_a_declared_partition_of_the_overlap_set(side: str) -> None:
    """Every overlap file is either pinned or explicitly excused — no silent holes."""
    assert len(OVERLAP_FILES) == 14, (
        f"the universe is {len(OVERLAP_FILES)} files, 14 were captured: the partition "
        "below proves nothing about a set that is allowed to shrink itself")
    covered = set(ANCHORS[side]) | set(NO_ANCHORS[side])
    assert covered == set(OVERLAP_FILES), sorted(set(OVERLAP_FILES) - covered)
    assert not set(ANCHORS[side]) & set(NO_ANCHORS[side]), "a file cannot be both pinned and excused"
    # A ceiling, not a floor: TOTAL_ANCHORS counts needles in the aggregate, so
    # redistributing them and excusing the vacated file keeps both asserts above
    # green while one more file stops being guarded. That has to cost a red.
    assert len(NO_ANCHORS[side]) <= MAX_DECLARED_HOLES[side], (
        f"{side} declares {len(NO_ANCHORS[side])} holes, cap is "
        f"{MAX_DECLARED_HOLES[side]} — and the skip reason a hole prints is invisible "
        "under the workflow's -q, so this count is the only thing that can speak for it")
    for rel in NO_ANCHORS[side]:
        # Keyed per side: theirs' reason cannot excuse our hole in the same file.
        reason = NO_ANCHOR_REASONS.get(side, {}).get(rel, "")
        assert len(reason) >= 40, f"{side}/{rel} excused with no reason behind it"
    unexcused = set(NO_ANCHOR_REASONS.get(side, ())) - set(NO_ANCHORS[side])
    assert not unexcused, f"{side} carries reasons for files it does not excuse: {sorted(unexcused)}"
    for rel, needles in ANCHORS[side].items():
        # An empty tuple in ANCHORS is the OTHER vacuous pass: the file looks covered,
        # the per-file loop below asserts nothing, and the partition test stays green.
        assert needles, f"{side}/{rel} is declared as pinned with zero needles"


def test_the_anchor_table_has_not_been_thinned() -> None:
    """A guard that loses its own rows passes quietly. This one cannot: the floor is the
    count captured at merge time, and the two-sided totals are what makes the per-file
    loop below mean something. Floor only — the matching per-side ceiling on holes is in
    the partition test, otherwise the same total could be spread over fewer files."""
    total = sum(len(v) for side in ANCHORS.values() for v in side.values())
    assert total >= TOTAL_ANCHORS, f"{total} anchors, captured {TOTAL_ANCHORS}"


@pytest.mark.parametrize("side", ("ours", "theirs"))
@pytest.mark.parametrize("rel", OVERLAP_FILES)
def test_both_sides_changes_are_still_in_the_merged_file(side: str, rel: str) -> None:
    needles = ANCHORS[side].get(rel, ())
    if not needles:
        # What is red here is an *unexcused* hole — a file with no needles that is not
        # declared in NO_ANCHORS either (the partition test fails on it too). A
        # declared, reasoned excuse skips with its text printed instead, which is what
        # keeps NO_ANCHORS usable rather than a permanent red the table avoids using.
        assert rel in NO_ANCHORS[side], (
            f"{side} declared no anchors for {rel} yet it is not excused either")
        pytest.skip(f"{side}: {NO_ANCHOR_REASONS[side][rel]}")
    text = (REPO / rel).read_text(encoding="utf-8")
    counts = {n: text.count(n) for n in needles}
    vanished = [n for n, c in counts.items() if c == 0]
    weakened = [n for n, c in counts.items() if c > 1]
    assert not vanished, (
        f"{side}-only hunks vanished from {rel} ({len(vanished)} of "
        f"{len(needles)}): " + " || ".join(vanished[:3])
    )
    # count == 1 is the invariant, not mere presence: a literal that now occurs twice
    # still "passes" an existence check yet no longer proves THIS side's hunk, since
    # the second copy may be the other side's or upstream's. Decaying that far must
    # not read as green.
    assert not weakened, (
        f"{side}-only needles weakened (count > 1) in {rel} ({len(weakened)} of "
        f"{len(needles)}): " + " || ".join(f"{n} x{counts[n]}" for n in weakened[:3])
    )
