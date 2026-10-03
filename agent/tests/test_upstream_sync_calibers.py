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

from backtest.loaders import registry
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


def test_frame_caliber_prefers_the_frame_stamp_over_the_static_table() -> None:
    """G1: upstream shipped `frame_caliber` (`registry.py:407`) plus 6 call sites, and no
    test case in this repo NAMES it as the unit under test — `git grep -l frame_caliber
    upstream/main -- agent/tests` and the same selector on HEAD are both rc=1 (re-run on
    this tree, 2026-10-03); the only repo-wide test-side hit is
    `tools/test_upstream_sync.py:148`, which pins the def line as TEXT and never calls it.

    Wording discipline (an earlier draft of this docstring over-claimed "zero coverage"
    and was corrected at 7fb214aa — do not widen it back): the FALLBACK leg is asserted
    indirectly, by frames built without attrs (`test_price_caliber.py:23` `_df()`) in the
    tencent/sina cells (`test_price_caliber.py:275/:287/:301/:314`) and in the
    serving-source cells (`test_market_data_serving_source.py:19`, table at `:66-70`,
    assertion at `:71`), and the attrs-present leg is walked indirectly for
    `source="tencent"` by `test_additive_conversion.py:233`. What was missing for the
    `("akshare", "a_share")` cell is the leg that routes THROUGH `frame_caliber` — that
    leg is what this test adds, called by name, with the table value it must beat pinned
    alongside so the precedence is not a tautology.
    """
    converted = pd.DataFrame({"close": [9.0, 10.0]})
    converted.attrs = {"adjustment": "split_dividend"}
    # The unconverted shape is built FRESH, not copied: measured on pandas 2.3.3,
    # `converted.copy()` and `converted.reset_index()` both carry `attrs` along, so a copy
    # is an already-stamped frame. That propagation is what lets a loader stamp reach the
    # serving layer at all (assertion 3 depends on it), and it is pinned one line below
    # rather than assumed.
    plain = pd.DataFrame({"close": [9.0, 10.0]})
    assert "adjustment" not in plain.attrs
    assert converted.copy().attrs["adjustment"] == "split_dividend"
    # The static answer for this cell is the OTHER caliber, which is what makes this a
    # real precedence test rather than a tautology.
    assert registry.price_caliber("akshare", "a_share", "600519.SH") == "split_dividend_additive"
    assert registry.frame_caliber(converted, "akshare", "a_share", "600519.SH") == "split_dividend"
    assert registry.frame_caliber(plain, "akshare", "a_share", "600519.SH") == "split_dividend_additive"
    # An empty-string stamp must not be honored: `attrs.get(...) or table` would read the
    # same, `isinstance(...) and adjustment` is what the code actually does.
    blank = pd.DataFrame({"close": [9.0, 10.0]})
    blank.attrs = {"adjustment": ""}
    assert registry.frame_caliber(blank, "akshare", "a_share", "600519.SH") == "split_dividend_additive"


def _window(code: str) -> tuple[str, str]:
    """The committed fixture's own first/last bar dates (`manifest.json`).

    The serving and loader calls below take a date range, and a range invented for the
    test would make "the sample is the data being asserted" untrue — the fake legs
    ignore the dates, so nothing but this docstring would notice.
    """
    entry = _MANIFEST["symbols"][code]
    return entry["first"], entry["last"]


def _fixture_pair(code: str) -> tuple[pd.DataFrame, pd.DataFrame]:
    """``(raw, on-disk additive)`` for one committed fixture, with no conversion run.

    Not `_lane_pair`: its third slot is the CONVERTED multiplicative output, not the
    additive bars a qfq reply carries. Measured consequence of mixing the two up —
    `convert_additive_to_multiplicative(raw, lane_additive)` returns `None`, because the
    offset of a ratio-scaled series against raw is not a plateau series
    (`_plateau_spans(...) is None`), so the "companion served" test would silently be
    running the degrade branch instead. Same `_read_csv` + `COLS` route as `_lane_pair`,
    no second parse path, and no `apply_qfq`/conversion work (the refusal window would
    trip `_lane_pair`'s "committed convertible window was refused" assert).
    """
    raw = _read_csv(FIXTURES / f"{code}_raw.csv", indexed=True)[COLS]
    additive = _read_csv(FIXTURES / f"{code}_qfq.csv", indexed=True)[COLS]
    return raw, additive


def _serving_frames(monkeypatch: pytest.MonkeyPatch, frame: pd.DataFrame, code: str) -> dict:
    """Push one frame through the serving layer and return its provenance entry.

    The double follows the shape upstream's own `test_additive_conversion.py:233` uses:
    a stub loader class swapped into `LOADER_REGISTRY`/`FALLBACK_CHAINS` with
    `_ensure_registered` neutralised, so `fetch_market_data(source="akshare")` resolves
    to it and no vendor is contacted. `frame` is served verbatim — this helper asserts
    what `_emit` READS off it (`market_data.py:464`, the `frame_caliber` call), not what
    a loader did to it. The plan skeleton also patched `_ensure_registered` on the
    loader module; that name does not exist there (`hasattr` = False), so the line was a
    no-op and is not carried here.
    """
    from src.market_data import fetch_market_data

    class Serving:
        name = "akshare"
        markets = {"a_share"}
        volume_units: dict[str, str] = {}

        def is_available(self) -> bool:
            return True

        def fetch(self, codes, start, end, interval="1D"):
            return {c: frame for c in codes}

    start, end = _window(code)
    monkeypatch.setattr(registry, "_ensure_registered", lambda: None)
    monkeypatch.setattr(registry, "LOADER_REGISTRY", {"akshare": Serving})
    monkeypatch.setattr(registry, "FALLBACK_CHAINS", {"a_share": ["akshare"]})
    out = fetch_market_data(codes=[code], start_date=start, end_date=end,
                            source="akshare", include_provenance=True)
    return out["_provenance"][code]


def test_converted_frame_leaves_with_the_multiplicative_label(monkeypatch) -> None:
    """The akshare cell, attrs-present, routed through `frame_caliber` BY the serving
    layer: the caller of `fetch_market_data(include_provenance=True)` reads
    `split_dividend`, so the stamp beats this cell's static table. Upstream walked that
    precedence only for `source="tencent"` (`test_additive_conversion.py:233`); the
    akshare row of the table (`registry.py:356`) is what has to lose here."""
    _raw, _lane_factor, lane_additive = _lane_pair("600519.SH")
    assert "adjustment" not in lane_additive.attrs  # the converter itself does not stamp
    stamped = lane_additive.copy()
    stamped.attrs = {"adjustment": "split_dividend"}
    prov = _serving_frames(monkeypatch, stamped, "600519.SH")
    assert prov["adjustment"] == "split_dividend"
    assert prov["adjustment"] != registry.price_caliber("akshare", "a_share", "600519.SH")


def test_unstamped_additive_leaves_with_the_additive_label(monkeypatch) -> None:
    """The degrade/self-refusal seat G2 names: upstream asserts the additive series
    passes through untouched (`test_additive_conversion.py:283` checks
    `df["close"].tolist() == additive["close"].tolist()`), nobody asserted what the served
    caliber says about it. Without this line a one-cell edit to the static table turns a
    silent downgrade into a false label. The premise is checked first (the frame really
    is unstamped), so the label assertion cannot quietly be reading a stamped frame."""
    _raw, additive = _fixture_pair("600519.SH")
    assert "adjustment" not in additive.attrs
    prov = _serving_frames(monkeypatch, additive, "600519.SH")
    assert prov["adjustment"] == "split_dividend_additive"


@pytest.mark.parametrize("code", SYMBOL_REFUSAL)
def test_a_refused_window_is_not_relabeled(code: str, monkeypatch) -> None:
    """`convert_additive_to_multiplicative` refuses the committed window at ONE named
    branch, and which branch matters: bare `assert refused is None` is satisfied by nine
    unrelated `return None` paths (`additive_conversion.py:117,119,125,130,138,149,153,
    159,168`), so loosening the guard under test would still leave this green. That is
    why the plateau-shape pin comes FIRST: the committed `000651.SZ` window refuses
    because its last plateau is ONE bar — `_plateau_spans` returns None at `:86-89` (an
    edge one-bar plateau, the window's last bar being ex-date 2026-08-27) and
    `convert_additive_to_multiplicative` then returns None at `:128-130`. It is NOT the
    ratio-series guard at `:136-138`: measured over 4000 randomized offset shapes,
    `_plateau_spans` never returned a span list holding a one-bar plateau, so
    `single_bar_spans` is 0 by the time `:137` reads it and a drifting offset series is
    refused at `:86-89` instead — the same route as here, and the one upstream's
    `test_additive_conversion.py:137 test_non_plateau_offsets_fail_closed` exercises.
    `manifest.refusal_cause` stays `unclassified`; this fixture claims nothing about the
    kind of corporate action. Refusal and label are checked together, because refusing is
    only honest if the label then says additive — a loosened refusal rule would otherwise
    mint a mislabel with clean numbers."""
    from backtest.loaders.additive_conversion import _plateau_spans

    raw, additive = _fixture_pair(code)
    offset = (additive["close"] - raw["close"]).astype(float)
    assert _plateau_spans(offset) is None, (
        f"{code}: the offset series no longer trips the plateau-shape guard — the refusal "
        f"sample drifted, and this test is now asserting a different branch than it names")
    refused = convert_additive_to_multiplicative(raw, additive)
    assert refused is None, f"{code}: the committed refusal window converted — bucket drifted"
    prov = _serving_frames(monkeypatch, additive, code)
    assert prov["adjustment"] == "split_dividend_additive"


def test_companion_fetch_failure_degrades_loudly_and_stays_additive(monkeypatch, caplog) -> None:
    """Loader-level seat: the real #1541 branch, fed with committed bars, companion
    forced to fail. Three things at once — no attrs written, additive caliber out the
    door, and a warning attributed to the akshare loader's own logger. Any one alone is
    satisfiable by accident; upstream's sibling case
    (`test_additive_conversion.py:283 test_akshare_raw_failure_serves_additive`) checks
    none of the three, only the close passthrough on a synthetic `_two_action_series()`."""
    import logging

    from backtest.loaders import akshare_loader as mod

    _raw, additive = _fixture_pair("600519.SH")
    start, end = _window("600519.SH")

    def fake_cached(*, source, symbol, timeframe, start_date, end_date, fields, fetch):
        if fields == ["raw"]:
            raise RuntimeError("probe: raw companion unavailable")
        return additive.copy()

    monkeypatch.setattr(mod, "cached_loader_fetch", fake_cached)
    with caplog.at_level(logging.WARNING, logger="backtest.loaders.akshare_loader"):
        out = mod.DataLoader().fetch(["600519.SH"], start, end)
    frame = out["600519.SH"]
    assert frame is not None and not frame.empty
    assert "adjustment" not in frame.attrs
    assert registry.frame_caliber(frame, "akshare", "a_share", "600519.SH") == "split_dividend_additive"
    assert any(r.name == mod.logger.name and r.levelno >= logging.WARNING for r in caplog.records), (
        f"the degrade path went silent: {caplog.text!r}")
    assert "serving additive" in caplog.text, caplog.text


def test_companion_success_stamps_multiplicative(monkeypatch) -> None:
    """Same branch with the companion served: the real 424-bar fixture conversion, and —
    unlike upstream's `test_additive_conversion.py:197 test_akshare_converts_and_stamps`,
    which stops at `df.attrs["adjustment"]` on a synthetic 8-bar `_two_action_series()` —
    the stamp read back through `frame_caliber`, i.e. the label a caller actually gets."""
    from backtest.loaders import akshare_loader as mod

    raw, additive = _fixture_pair("600519.SH")
    start, end = _window("600519.SH")

    def fake_cached(*, source, symbol, timeframe, start_date, end_date, fields, fetch):
        return raw.copy() if fields == ["raw"] else additive.copy()

    monkeypatch.setattr(mod, "cached_loader_fetch", fake_cached)
    out = mod.DataLoader().fetch(["600519.SH"], start, end)
    frame = out["600519.SH"]
    assert frame.attrs["adjustment"] == "split_dividend"
    assert registry.frame_caliber(frame, "akshare", "a_share", "600519.SH") == "split_dividend"
