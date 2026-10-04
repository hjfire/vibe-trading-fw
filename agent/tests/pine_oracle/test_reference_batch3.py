"""Batch 3: Supertrend and VWAP, whose semantics are set by published text, not by us.

``supertrend`` is transcribed from TradingView's own Pine body, already committed in
this repo (``frontend/src/lib/__tests__/pineRealWorld.test.ts:65-93``), and the
engine claims the same body as its source (``pineTa.ts:664-673``). Both sides of the
gate therefore descend from one external text: what agreement here proves is that
the fork's transcription is faithful, which is the surface this harness exists to
hold. It does NOT re-prove TV's algorithm, and the report must not claim that.

``sar`` is deliberately absent — see the note above the steps (spec §11 更正三).

One scope limit on that claim: the body fixes the BRANCHES, but it does not settle what
happens on the FIRST bar, where ``upperBand[1]``/``lowerBand[1]``/``close[1]`` are all
missing. Reading Pine's ``nz()`` literally diverges from the NaN guard this port (and
the engine) take, and Pine's own warm-up behaviour is un-anchored
(``ENGINE_CONVENTION["supertrend"]``, ``ta_supertrend``'s docstring, and the
「未取到，已放弃」 row of ``EXTERNAL_ANCHORS.md``). So the warm-up reading below is
THIS implementation's choice, not something the published body implies.
"""

import math

import numpy as np
import pytest

from pine_oracle.reference import ref_batch_3, ta_supertrend, ta_vwap

# TV's body has three branches and a ratchet; this five-bar table walks all of them
# with period=1 (so atr == tr, dense from bar 0) and multiplier=1.0 (so every number
# below is doable on a calculator). Worked on paper, bar by bar, UNDER THE NaN GUARD:
# the `line` row is that reading, NOT a reading the body implies — the three Pine na
# readings of bar 0 diverge here (literal nz() with the na comparison taking the false
# arm gives [0.0, 14.0, 12.0, 8.0, 8.0]; letting na poison the ternary gives
# [na, 8.0, 8.0, 8.0, 8.0]; see ENGINE_CONVENTION["supertrend"]).
#   high  = [10, 12, 11, 20, 19]
#   low   = [ 8, 10,  9, 11, 10]
#   close = [ 9, 11, 10, 19, 18]
#   tr    = [ 2,  3,  2, 10,  9]      bar 0 collapses to high-low (pineTa.ts:536);
#                                     bar 3's 10 is |high - close[1]| = |20 - 10|, not
#                                     high - low = 9 — taking that second candidate IS
#                                     the point of bar 3 (max(9, 10, 1) = 10)
#   hl2   = [ 9, 11, 10, 15.5, 14.5]
#   raw ub/lb = hl2 +/- tr = [11/7, 14/8, 12/8, 25.5/5.5, 23.5/5.5]
#   after the ratchet: ub = [11, 11, 11, 11, 23.5]   lb = [7, 8, 8, 8, 8]
#   direction (TV: -1 is UP) = [1, 1, 1, -1, -1]     line = [11, 11, 11, 8, 8]  <- guard
#   (the sign line is shared by the guard and the false-arm nz() reading; raw ub 25.5 /
#    raw lb 5.5 never reach the line at bar 3, the ratchet holds 11 and 8)
H5 = np.array([10.0, 12.0, 11.0, 20.0, 19.0])
L5 = np.array([8.0, 10.0, 9.0, 11.0, 10.0])
C5 = np.array([9.0, 11.0, 10.0, 19.0, 18.0])


def test_supertrend_matches_the_published_body_under_the_nan_guard_reading_bar_by_bar() -> None:
    out = ta_supertrend(H5, L5, C5, period=1, multiplier=1.0)
    assert out["supertrend"] == pytest.approx([11.0, 11.0, 11.0, 8.0, 8.0])
    assert out["st_direction"] == pytest.approx([1.0, 1.0, 1.0, -1.0, -1.0])


def test_supertrend_bands_only_ratchet_one_way() -> None:
    """Bar 1's raw upper band is 14.0, but the guard keeps the previous 11.0 because
    neither ``ub < prevUb`` nor ``close[1] > prevUb`` holds. A port that assigns the
    raw band gets a line 3.0 too high here and never notices."""
    out = ta_supertrend(H5, L5, C5, period=1, multiplier=1.0)["supertrend"]
    assert out[1] == pytest.approx(11.0)          # not 14.0
    assert out[4] == pytest.approx(8.0)           # lower band held at 8, not raw 5.5


def test_supertrend_cold_start_is_the_downtrend_branch() -> None:
    """``if na(atr[1]) direction := 1`` — the very first bar with a finite ATR takes
    direction +1 (downtrend), so the plotted line is the UPPER band, above price.
    A port that seeds by comparing close to hl2 gives -1 here. ENGINE_CONVENTION."""
    out = ta_supertrend(H5, L5, C5, period=3, multiplier=1.0)
    assert math.isnan(out["supertrend"][0]) and math.isnan(out["supertrend"][1])
    # atr = rma(tr, 3) seeds at index 2 with mean(2, 3, 2) = 7/3, so the line is
    # hl2 + atr = 10 + 7/3 and direction is the cold-start +1.
    assert out["supertrend"][2] == pytest.approx(10.0 + 7.0 / 3.0)
    assert out["st_direction"][2] == pytest.approx(1.0)
    assert out["supertrend"][2] > C5[2]


def test_direction_minus_one_is_the_uptrend_not_the_folklore_one() -> None:
    """TV's body: ``direction := close > upperBand ? -1 : 1`` and
    ``superTrend := direction == -1 ? lowerBand : upperBand``. So -1 means up and the
    line sits BELOW price. The widespread "+1 = up" reading is inverted; adopting
    Pine's sign is recorded in ENGINE_CONVENTION["st_direction"]."""
    out = ta_supertrend(H5, L5, C5, period=1, multiplier=1.0)
    assert out["st_direction"][4] == pytest.approx(-1.0)
    assert out["supertrend"][4] < C5[4]                      # 8.0 < 18.0: band below price


def test_vwap_unanchored_is_the_running_ratio_over_the_whole_range() -> None:
    price = np.array([1.0, 2.0, 3.0, 4.0])
    vol = np.array([1.0, 1.0, 1.0, 1.0])
    assert ta_vwap(price, vol)["vwap"] == pytest.approx([1.0, 1.5, 2.0, 2.5])


def test_vwap_session_argument_reanchors_and_is_not_the_engines_reading() -> None:
    """Two facts in one test: the reference CAN express TradingView's session
    anchoring, and that form is NOT what the gate compares — the engine takes no
    session argument and accumulates over the loaded range (pineTa.ts:960-970), so
    ``ref_batch_3`` passes ``None``. The difference at bar 2 is the backlog item."""
    price = np.array([1.0, 2.0, 3.0, 4.0])
    vol = np.array([1.0, 1.0, 1.0, 1.0])
    session = np.array([1, 1, 2, 2])
    anchored = ta_vwap(price, vol, session)["vwap"]
    assert anchored == pytest.approx([1.0, 1.5, 3.0, 3.5])
    assert anchored[2] == pytest.approx(3.0)                 # restarts at its own bar
    assert ta_vwap(price, vol)["vwap"][2] == pytest.approx(2.0)   # engine's reading


def test_vwap_zero_volume_is_na_not_a_division_by_zero() -> None:
    """Engine: ``return st.v === 0 ? NA : st.pv / st.v`` (pineTa.ts:969)."""
    out = ta_vwap(np.array([1.0, 2.0]), np.array([0.0, 0.0]))["vwap"]
    assert np.all(np.isnan(out))


def test_vwap_an_na_price_bar_carries_the_previous_running_ratio() -> None:
    """reference.py's na-price branch (``if not np.isnan(price[i])`` guards the
    accumulation, while the bar still reports ``num / den`` from the previous bars) is
    the shape ``pineTa.ts:960-970`` has too: an na-price bar contributes NOTHING and
    the running ratio is carried forward unchanged.

    Unreachable on the committed fixtures — hlc3 is finite on all four shapes and the
    volume column is always positive, so 判据二 prints ``vwap ... na=0`` everywhere and
    never walks this branch. That is why it is pinned here instead.
    """
    out = ta_vwap(np.array([2.0, np.nan]), np.array([1.0, 5.0]))["vwap"]
    assert out[0] == pytest.approx(2.0)
    assert out[1] == pytest.approx(2.0)                    # carried, not averaged in
    # The skip covers the VOLUME too, which the next finite bar exposes: had the na
    # bar contributed its 5.0, bar 2 would read (2 + 20) / 6 = 3.666... instead.
    carried = ta_vwap(np.array([2.0, np.nan, 4.0]), np.array([1.0, 5.0, 1.0]))["vwap"]
    assert carried[2] == pytest.approx(3.0)                # (2*1 + 4*1) / (1 + 1)
    assert not np.isnan(carried).any()


def test_ref_batch_3_ignores_the_session_column_by_design() -> None:
    """Feeding the session column to the reference while the engine ignores it would
    compare two different functions and call the difference a pass. The batch must
    therefore be byte-identical with and without the column."""
    cols = {"open": C5, "high": H5, "low": L5, "close": C5, "volume": np.array([1.0] * 5)}
    with_session = ref_batch_3(cols, 5, np.array([1, 1, 2, 2, 2]))
    without = ref_batch_3(cols, 5, None)
    assert set(with_session) == {"st_direction", "supertrend", "vwap"}
    for key, arr in with_session.items():
        assert np.array_equal(arr, without[key], equal_nan=True), key
