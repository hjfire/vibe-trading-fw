"""Batch 2: the functions whose warm-up and na rules are the whole story.

Every expected number is derived on paper from the recursion named in the test.
Where the engine's convention differs from the TA-Lib/textbook one, BOTH numbers
are written down: the gate holds the engine's, the comment keeps the other one from
being forgotten.
"""

import math

import numpy as np
import pytest

from pine_oracle.reference import (
    ta_atr,
    ta_bb,
    ta_ema,
    ta_macd,
    ta_rsi,
    ta_stoch,
    ta_tr,
)

CLOSE5 = np.array([1.0, 2.0, 3.0, 4.0, 5.0])
HIGH5 = np.array([2.0, 3.0, 4.0, 5.0, 6.0])
LOW5 = np.array([0.5, 1.0, 1.5, 2.0, 2.5])


def test_tr_first_bar_reduces_to_high_minus_low() -> None:
    """The engine uses ``pc = close[i]`` at bar 0 (pineTa.ts:536); for a well-formed
    bar (low <= close <= high) the three candidates collapse to ``high - low``."""
    tr = ta_tr(HIGH5, LOW5, CLOSE5)
    assert tr[0] == pytest.approx(1.5)                        # 2.0 - 0.5
    assert tr[1] == pytest.approx(2.0)                        # max(3-1, |3-1|, |1-1|)
    assert tr[2] == pytest.approx(2.5)                        # max(4-1.5, |4-2|, |1.5-2|)
    assert tr[4] == pytest.approx(3.5)


def test_tr_is_total_on_an_empty_input_like_the_other_helpers() -> None:
    """Zero-length in, zero-length out — no ``IndexError`` at the bar-0 assignment.

    Every other helper in this module answers a too-short input with its all-na (or
    empty) array through an ``n < 1 or shape[0] < n`` early return; ``ta_tr`` reads
    ``high[0]`` unconditionally, so the empty case was the one partial function here.
    Unreachable from the gate on purpose — all four bar fixtures carry 40 or 120 rows,
    so this is the unit-layer guard and no committed byte depends on it.
    """
    empty = np.empty(0, dtype="float64")
    out = ta_tr(empty, empty, empty)
    assert out.shape == (0,)
    assert out.dtype == np.float64


def test_atr_is_rma_of_tr_seeded_at_n_minus_one() -> None:
    tr = ta_tr(HIGH5, LOW5, CLOSE5)                      # [1.5, 2.0, 2.5, 3.0, 3.5]
    out = ta_atr(HIGH5, LOW5, CLOSE5, 3)
    assert math.isnan(out[0]) and math.isnan(out[1])
    assert out[2] == pytest.approx(float(tr[:3].mean()))  # (1.5+2+2.5)/3 = 2.0, the seed
    assert out[3] == pytest.approx((2.0 * 2 + 3.0) / 3)   # (prev*(n-1)+tr[3])/n = 7/3
    assert out[4] == pytest.approx(((7.0 / 3.0) * 2 + 3.5) / 3)   # 49/18


def test_rsi_seeds_one_bar_earlier_than_the_textbook_and_tells_you_so() -> None:
    """Engine: ``change`` at bar 0 is na, and both rma streams are fed **0** there
    (pineTa.ts:550-552), so the seed window includes that 0 and the first non-na
    RSI sits at index ``n-1``. The textbook na-propagation form would give index
    ``n`` with seed ``mean(change[1..n])`` — for [1..5], n=3: [na, na, na, 100, 100].
    Adopted engine convention; see ENGINE_CONVENTION["rsi"].
    """
    out = ta_rsi(CLOSE5, 3)
    assert math.isnan(out[0]) and math.isnan(out[1])
    assert out[2] == pytest.approx(100.0)     # dn seed = mean([0,0,0]) = 0, up = 2/3 > 0
    assert out[3] == pytest.approx(100.0)
    assert out[4] == pytest.approx(100.0)


def test_rsi_flat_series_is_50_not_na_and_not_a_division_crash() -> None:
    """pineTa.ts:554 ``dn === 0`` returns ``up === 0 ? 50 : 100`` — both zero is 50."""
    out = ta_rsi(np.array([5.0] * 6), 3)
    assert out[2:] == pytest.approx([50.0, 50.0, 50.0, 50.0])


def test_rsi_all_losses_is_zero() -> None:
    out = ta_rsi(CLOSE5[::-1].copy(), 3)
    assert out[2] == pytest.approx(0.0)
    assert out[4] == pytest.approx(0.0)


def test_bb_follows_the_population_stdev_it_calls() -> None:
    """bb's dev is ``coef * ta.stdev(src, n)`` with the engine's default biased=true,
    i.e. the population form (pineTa.ts:635-642 -> stdStep default). The folklore
    "bb uses the sample one" would give 4 ± 2.0 here instead of the values below."""
    out = ta_bb(CLOSE5, 3, 2.0)
    assert out["bb_basis"][4] == pytest.approx(4.0)
    dev = 2.0 * 0.8164965809277260                      # 2 * population sd of [3,4,5]
    assert out["bb_upper"][4] == pytest.approx(4.0 + dev)
    assert out["bb_lower"][4] == pytest.approx(4.0 - dev)
    assert not math.isclose(out["bb_upper"][4], 6.0, rel_tol=1e-3)   # sample form -> 6
    assert math.isnan(out["bb_upper"][1])                            # basis warm-up carries


def test_macd_is_dense_from_bar_zero_and_hist_is_the_exact_difference() -> None:
    """Both emas seed at bar 0, so the line, the signal and the histogram all have a
    value at bar 0 (pineTa.ts:622-632). hist is literally ``line - signal``."""
    out = ta_macd(CLOSE5, 3, 5, 3)
    for key in ("macd", "macd_signal", "macd_hist"):
        assert not any(math.isnan(v) for v in out[key]), key
    assert out["macd"][0] == pytest.approx(0.0)          # both emas start at src[0]
    assert (out["macd_hist"] == out["macd"] - out["macd_signal"]).all()


def test_macd_signal_is_an_ema_of_the_macd_line_not_of_the_source() -> None:
    ramp = np.arange(1.0, 41.0)
    out = ta_macd(ramp, 3, 5, 3)
    line = out["macd"]
    # Unit ramp: an EMA with alpha lags the ramp by (1-alpha)/alpha bars, so the
    # line tends to 2 - 1 = 1 (slow alpha=1/3 -> lag 2; fast alpha=1/2 -> lag 1).
    assert line[39] == pytest.approx(1.0, abs=1e-6)
    assert out["macd_signal"][39] < line[39]             # ema of a rising sequence is below it
    assert out["macd_signal"][39] < 2.0
    # The wrong implementation (ema over the source) would sit near 40 - 1 = 39.
    assert ta_ema(ramp, 3)[39] > 30.0


def test_stoch_uses_the_partial_window_from_bar_zero() -> None:
    """Engine: highest/lowest have no full-window gate (pineTa.ts:212-224), so %K is
    defined at bar 0 from the one bar available. A strict n-bar warm-up would give
    na for the first n-1 bars. Adopted engine convention; ENGINE_CONVENTION["stoch_k"]."""
    out = ta_stoch(CLOSE5, HIGH5, LOW5, 5, 3)
    k = out["stoch_k"]
    # bar 0: the window holds one bar, so hh = high[0] = 2.0 and ll = low[0] = 0.5.
    assert k[0] == pytest.approx(100.0 * (1.0 - 0.5) / (2.0 - 0.5))    # 33.333...
    # bar 1: the window holds two bars — hh = max(2.0, 3.0) = 3.0 over the highs and
    # ll = min(0.5, 1.0) = 0.5 over the lows, so the trailing aggregation itself is
    # what this cell measures, which bar 0's single-bar window cannot see.
    assert k[1] == pytest.approx(100.0 * (2.0 - 0.5) / (3.0 - 0.5))    # 60.0
    assert k[4] == pytest.approx(100.0 * (5.0 - 0.5) / (6.0 - 0.5))    # window of 5


def test_stoch_monotonic_ramp_is_100_whatever_the_length() -> None:
    src = np.arange(1.0, 21.0)
    out = ta_stoch(src, src, src, 5, 3)
    # bar 0: hh == ll, so this helper's guard leaves it na (the engine's four-argument
    # branch guards the same at pineTa.ts:608, and its three-argument overload at :617);
    # from bar 1 the ramp's own spread carries it, and on a strictly increasing series
    # (close == high == low) %K is 100 for any length.
    assert math.isnan(out["stoch_k"][0])
    assert out["stoch_k"][1:] == pytest.approx([100.0] * 19)
    # %D needs three finite %K, so it starts one bar after they are all there:
    # k is finite from index 1 => first finite d is index 3.
    assert math.isnan(out["stoch_d"][2])
    assert out["stoch_d"][3:] == pytest.approx([100.0] * 17)


def test_stoch_zero_range_is_na_not_divide_by_zero_inf() -> None:
    flat = np.array([5.0] * 10)
    out = ta_stoch(flat, flat, flat, 5, 3)
    assert np.all(np.isnan(out["stoch_k"]))
    assert np.all(np.isnan(out["stoch_d"]))


def test_smoothed_stages_propagate_na_instead_of_skipping_it() -> None:
    """The second stage is per-window na, not "average whatever is available".

    The engine's ``smaStep`` — what ``ta.sma`` runs — answers NA as soon as the
    *current* window holds an NA (pineTa.ts:46-55), and ``_sma_na_propagating``
    states that same per-window rule for the reference, so the smooth's first value
    is (first finite k) + d_len - 1, not just d_len - 1. An "average whatever is
    available" smoother would already answer at first_k, which is what makes this
    case red-able. What Pine's own ``ta.sma`` does with an na in the window is a
    Task 6 external-anchor question; nothing here settles it.
    """
    src = np.array([1.0, 1.0, 2.0, 3.0, 4.0, 5.0])
    out = ta_stoch(src, src, src, 3, 3)
    assert math.isnan(out["stoch_k"][0]) and math.isnan(out["stoch_k"][1])   # hh == ll
    first_k = 2
    assert out["stoch_k"][first_k] == pytest.approx(100.0)
    assert math.isnan(out["stoch_d"][first_k])           # window [na, na, 100]
    assert math.isnan(out["stoch_d"][first_k + 1])       # window [na, 100, 100]
    assert out["stoch_d"][first_k + 2] == pytest.approx(100.0)   # first all-finite window
