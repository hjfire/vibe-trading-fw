"""Cross-implementation price-caliber reconciliation, 2026-10 upstream sync.

Seat: spec §5.3 / G1 G2 G3. Lives in `agent/tests/` on purpose — it needs
pandas, so the fork's pytest-only wiki workflow cannot collect it, while the
upstream `test.yml` step collects this directory through pyproject's
`testpaths = ["agent/tests"]`. That is the collection face this file needs.

Data: committed fixtures (real bars, real ex-dates), never live fetch — see
`fixtures/upstream_sync/manifest.json` for `additive_source`, which is
`derived`: the `_qfq.csv` leg was re-encoded from the same Sina `hfq-factor`
step table the multiplicative leg consumes (spec §6 outcome B, ledger R-12).
Assertion 1 therefore proves that two ENCODINGS of one corporate-action
history land on one return series — a consistency reconciliation. It is not
cross-vendor verification and verifies neither encoding.

Column face: `convert_additive_to_multiplicative` reads only `close` off the
additive frame (`additive_conversion.py:127`) and rebuilds open/high/low from
`raw * ratio` and volume from `raw / ratio`, so this file's assertion 1 is a
close/return statement. The non-close input columns carry their own faces in
the manifest (`ohlc_offset_identity_max_abs`, `volume_identical_to_raw_on_disk`)
and are not asserted here.
"""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd
import pytest

from backtest.loaders.additive_conversion import convert_additive_to_multiplicative
from backtest.loaders.cn_adjust import apply_qfq

FIXTURES = Path(__file__).parent / "fixtures" / "upstream_sync"
COLS = ["open", "high", "low", "close", "volume"]

# Face discipline: this tolerance is pinned from the RETURN-face residual measured on
# the committed fixtures, NOT from `manifest.json`'s LEVEL-face keys. The names come
# from `reverse_check_coverage.assertion_faces` and `reading_notes[4]`/`[5]`, and they
# are not interchangeable:
#   return face (this assertion) — `return_reverse_check_max_rel` (on-disk, pandas'
#     DEFAULT read_csv parser, the face the loader uses); `..._round_trip` is the
#     capture-bits corroborating read and differs on 000001.SZ (2.631e-13 vs 1.231e-13).
#   LEVEL faces (NOT this assertion) — `reverse_check_max_rel` (capture) and
#     `disk_reverse_check_max_rel` (on-disk) max over all five columns, so neither is a
#     close-only reading; `disk_reverse_check_close_only_max_rel` and
#     `reverse_check["close"].max_rel` are close-only; `reverse_check[<col>].max_rel` is
#     per column. All ~2e-16 here: five orders too tight for a return assertion, and
#     pinning one of them goes red on the committed data as it stands.
# Why the two faces are that far apart — 600519.SH 2025-07-16, `reading_notes[4]`: the
# lanes' close levels differ by 2.27e-13 at their worst bar, differencing cancels
# nearly all of that and leaves 2.22e-16 of absolute return gap, and the relative
# residual divides it by that bar's own return 2.13e-05 (a near-flat day) rather than
# by the price level: 2.220446e-16 / 2.126152e-05 = 1.044350e-11.
# Step 1's three maxes on the fixtures as committed (unchanged since 07b4eb2d):
# 600519.SH 1.044e-11 @2025-07-16, 000001.SZ 2.631e-13 @2025-03-13,
# 601398.SH 1.739e-13 @2025-10-30. Rule from spec §5.3: the largest one rounded up
# one order of magnitude, with 1e-6 as the ceiling — it must let 2-decimal vendor
# rounding through a 424-bar window and still catch a dividend-sized error (~1e-3,
# 7 orders above this tolerance, 3 above the ceiling). Do NOT relax this number to
# make a run pass — a residual above the cap is a defect in one of the two
# encodings, not a tolerance set too tightly.
REL_TOL = 1e-10  # 9.6x headroom over 1.044e-11 — one order of magnitude, rounded down

_MANIFEST = json.loads((FIXTURES / "manifest.json").read_text(encoding="utf-8"))
SYMBOLS_CONVERTIBLE = tuple(c for c, v in _MANIFEST["symbols"].items() if v["bucket"] == "convertible")
SYMBOL_REFUSAL = tuple(c for c, v in _MANIFEST["symbols"].items() if v["bucket"] == "refusal")
# Both tuples are DERIVED from the manifest, which is right — but an empty one turns every
# parametrize over it into a single skip with zero assertions run and rc=0. That is this
# project's known false-green shape (an empty universe passing vacuously), so the emptiness
# itself has to be red, here rather than in a report.
assert SYMBOLS_CONVERTIBLE, "manifest has no convertible bucket — the return assertion would skip, not test"
assert SYMBOL_REFUSAL, "manifest has no refusal bucket — Task 6's refusal assertion would skip, not test"


def _read_csv(path: Path, indexed: bool) -> pd.DataFrame:
    frame = pd.read_csv(path, parse_dates=["trade_date"])
    if indexed:
        frame = frame.set_index("trade_date").sort_index()
    return frame


def _lane_pair(code: str) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Return ``(raw, lane_factor, lane_additive)`` for one committed fixture.

    Task 6's assertions reuse this read path instead of opening the CSVs again,
    which is why `raw` is part of the return alongside the two lanes.
    """
    raw = _read_csv(FIXTURES / f"{code}_raw.csv", indexed=True)[COLS]
    factor = _read_csv(FIXTURES / f"{code}_hfq.csv", indexed=False)
    additive = _read_csv(FIXTURES / f"{code}_qfq.csv", indexed=True)[COLS]
    lane_factor = apply_qfq(raw, factor)
    lane_additive = convert_additive_to_multiplicative(raw, additive)
    assert lane_factor is not None, f"{code}: apply_qfq returned None on a committed fixture"
    assert lane_additive is not None, f"{code}: the committed convertible window was refused"
    return raw, lane_factor, lane_additive


@pytest.mark.parametrize("code", SYMBOLS_CONVERTIBLE)
def test_the_two_multiplicative_implementations_agree_on_returns(code: str) -> None:
    """The same bars through #1541's offset->ratio conversion and through a published
    factor table must produce one return series. Absolute levels are not compared (the
    two anchor at the window end by construction, but their precision differs); returns
    are what every downstream metric actually reads. The additive leg here is `derived`
    from the same factor table, so a pass says the two encodings agree — not that either
    encoding was verified against a vendor (ledger R-12)."""
    raw, lane_factor, lane_additive = _lane_pair(code)
    r_factor = lane_factor["close"].pct_change().dropna()
    r_additive = lane_additive["close"].pct_change().dropna()
    pd.testing.assert_index_equal(r_factor.index, r_additive.index)
    # Exact coverage, not a floor: both lanes copy `raw`'s index, so a bar dropped by BOTH
    # of them would leave the floor green while the residual quietly skipped that bar.
    assert len(r_factor) == len(raw) - 1, (
        f"{code}: returns cover {len(r_factor)} of {len(raw) - 1} bars — a lane lost bars to "
        f"dropna() and the residual is not measuring the whole window")
    # The clip makes the metric relative down to |r| = 1e-12 and absolute below it: an
    # exactly-flat bar prints |Δr|/1e-12, so a 1-ulp gap (~2.2e-16) reads 2.2e-4 and is
    # ~6 orders over REL_TOL. A red on a bar whose own return is under ~2.2e-6 (= 2.2e-16
    # / REL_TOL) is a flat-bar artifact to be explained, NOT a reason to touch REL_TOL.
    rel = (r_factor - r_additive).abs() / r_factor.abs().clip(lower=1e-12)
    assert rel.max() <= REL_TOL, (
        f"{code}: max relative return residual {rel.max():.3e} exceeds REL_TOL {REL_TOL:.0e} "
        f"at {rel.idxmax()} — a dividend-scale error, not rounding"
    )
