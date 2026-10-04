"""Batch 1 reference implementations, pinned by hand-computable closed forms.

Every expected number below is derived on paper from the recursion written in the
test's own comment — NOT produced by the engine and NOT copied from a library. If
a number here needs changing, the hand derivation is what gets re-done.
"""

import math

import numpy as np
import pytest

from pine_oracle.reference import ta_ema, ta_rma, ta_sma, ta_stdev

ONE_TO_FIVE = np.array([1.0, 2.0, 3.0, 4.0, 5.0])


def test_sma_warmup_is_na_not_zero() -> None:
    out = ta_sma(ONE_TO_FIVE, 3)
    assert math.isnan(out[0]) and math.isnan(out[1])
    assert out[2:] == pytest.approx([2.0, 3.0, 4.0])


def test_ema_seeds_on_the_first_value_and_has_no_warmup() -> None:
    """Pine/TV convention: alpha = 2/(n+1), prev starts at src[0] (pineTa.ts:134-145).

    TA-Lib would instead SMA-seed at index n-1 and return na before it, i.e.
    [na, na, 2, 3, 4]. Spec §11 更正一 adjudicated that the engine's convention is
    the one under test, so the reference writes the seed-at-bar-0 form. The
    divergence is pinned by ``test_ema_is_not_thelibralib_seed_form`` below rather
    than left to be discovered by a red gate.
    """
    # alpha = 0.5: 1, 0.5*2+0.5*1, 0.5*3+0.5*1.5, 0.5*4+0.5*2.25, 0.5*5+0.5*3.125
    out = ta_ema(ONE_TO_FIVE, 3)
    assert not any(math.isnan(v) for v in out)
    assert out == pytest.approx([1.0, 1.5, 2.25, 3.125, 4.0625])


def test_ema_is_not_the_talib_seed_form() -> None:
    """The counterfactual, written down so a future 'fix' is a visible decision."""
    assert ta_ema(ONE_TO_FIVE, 3)[0] == pytest.approx(1.0)   # TA-Lib: na
    assert ta_ema(ONE_TO_FIVE, 3)[1] == pytest.approx(1.5)   # TA-Lib: na
    assert ta_ema(ONE_TO_FIVE, 3)[2] == pytest.approx(2.25)  # TA-Lib: 2.0 (the SMA seed)


def test_rma_is_wilder_alpha_one_over_n_seeded_on_the_sma() -> None:
    """Same engine, opposite convention: rma gates on a full window (pineTa.ts:147-170)."""
    # seed at index 2 = mean(1,2,3) = 2; index 3 = (2*2 + 4)/3 = 8/3;
    # index 4 = ((8/3)*2 + 5)/3 = 31/9.
    out = ta_rma(ONE_TO_FIVE, 3)
    assert math.isnan(out[0]) and math.isnan(out[1])
    assert out[2] == pytest.approx(2.0)
    assert out[3] == pytest.approx(8 / 3)
    assert out[4] == pytest.approx(31 / 9)


def test_stdev_default_is_population_the_ddof_the_folklore_gets_wrong() -> None:
    """Pine's ``ta.stdev`` defaults to the POPULATION deviation (ddof=0), so does numpy.

    The widespread claim that "Pine uses the sample one, that's the silent
    divergence vs numpy" is false in this direction (spec §11 更正一). The engine
    exposes the sample form only through the third argument, so the reference
    takes the same flag and both branches are covered.
    """
    out = ta_stdev(ONE_TO_FIVE, 3)
    assert math.isnan(out[1])
    assert out[2] == pytest.approx(0.8164965809277260), out[2]  # population [1,2,3]
    assert out[4] == pytest.approx(0.8164965809277260)          # population [3,4,5]
    assert out[4] == pytest.approx(float(np.std([3.0, 4.0, 5.0])), rel=1e-15)


def test_stdev_biased_false_is_the_sample_one() -> None:
    sample = ta_stdev(ONE_TO_FIVE, 3, biased=False)
    assert sample[2] == pytest.approx(1.0)   # [1,2,3]: 偏差 -1,0,1 → 平方和 2 ÷ (n-1)=2 → 开方 1
    assert sample[4] == pytest.approx(1.0)
    assert not math.isclose(sample[4], float(np.std([3.0, 4.0, 5.0])), rel_tol=1e-9)


def test_windows_use_the_trailing_n_values_inclusive_of_the_current_bar() -> None:
    src = np.array([10.0, 20.0, 30.0, 40.0])
    assert ta_sma(src, 2)[3] == pytest.approx(35.0)
    # window [30,40]: mean 35, deviations ±5, squares 25+25=50
    assert ta_stdev(src, 2)[3] == pytest.approx(5.0)                    # 50/2 -> sqrt 25
    assert ta_stdev(src, 2, biased=False)[3] == pytest.approx(7.0710678118654755)  # 50/1
