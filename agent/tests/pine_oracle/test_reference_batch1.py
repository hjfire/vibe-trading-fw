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


def test_stdev_sample_at_n_one_is_na_because_pine_divides_by_zero_into_na() -> None:
    """``ta.stdev(src, 1, false)`` divides by ``n - 1 = 0`` — Pine's arithmetic answers na.

    The warrant is Pine's own convention that a division by zero yields na, so writing
    a number at that index would be asserting a value precisely where the language
    declines to give one. It is NOT "because ``stdStep`` returns NA" — the engine is
    consultable for parameter defaults and ``na`` rules only, and a reference that
    borrows an engine branch to justify itself stops being a reference.

    The asymmetry below is the whole point of the case: at ``n = 1`` the population
    form has a value and the sample form does not. One point deviates from itself by
    zero, which is a defined statistic; one point has no unbiased spread, since the
    divisor is ``count - 1 = 0``. Unreachable from any committed fixture (``PERIOD``
    is 5, so both denominators are >= 1) — which is exactly why it is pinned here
    rather than left for a gate that cannot reach it.
    """
    src = np.array([1.0, 2.0, 3.0])
    sample = ta_stdev(src, 1, biased=False)
    assert all(math.isnan(v) for v in sample), sample        # denom = 1 - 1 = 0 -> na
    population = ta_stdev(src, 1)
    assert not any(math.isnan(v) for v in population), population
    assert population == pytest.approx([0.0, 0.0, 0.0]), population  # denom = n = 1


def test_windows_use_the_trailing_n_values_inclusive_of_the_current_bar() -> None:
    src = np.array([10.0, 20.0, 30.0, 40.0])
    assert ta_sma(src, 2)[3] == pytest.approx(35.0)
    # window [30,40]: mean 35, deviations ±5, squares 25+25=50
    assert ta_stdev(src, 2)[3] == pytest.approx(5.0)                    # 50/2 -> sqrt 25
    assert ta_stdev(src, 2, biased=False)[3] == pytest.approx(7.0710678118654755)  # 50/1


def test_deviation_sma_na_input_poisons_every_later_bar() -> None:
    """DEVIATION from Pine, pinned on purpose: a na in ``src`` is never recovered from.

    This is not Pine semantics and is not claimed to be. Pine's ``ta.sma`` is per
    window: only a window that contains an na is na, so bar 5 below — window
    ``[4, 5, 6]``, no na in it — has a mean of 5.0. The reference computes the same
    quantity from one prefix sum, whose tail is poisoned by the na at index 2, so it
    answers na at bar 5 as well. See the module docstring of ``pine_oracle.reference``.

    The case exists to be red-able: if anyone rewrites ``ta_sma`` with per-window na
    semantics, ``out[5]`` stops being na and this assertion goes red. That red is the
    visible decision "the deviation was removed", which is the only honest way for
    this to change — the alternative is the gate silently proving something else.
    """
    src = np.array([1.0, 2.0, np.nan, 4.0, 5.0, 6.0])
    out = ta_sma(src, 3)
    assert all(math.isnan(v) for v in out), out
    # 0/1 are warm-up, 2/3/4 hold the na — 5 is the bar whose window is clean and is
    # still na. Asserted separately so a partial fix cannot slip past the blanket line.
    assert math.isnan(out[5]), out


def test_deviation_ema_na_input_poisons_the_rest_of_the_recursion() -> None:
    """DEVIATION from Pine, same shape as the ``sma`` case above: the state is not reset.

    ``prev`` becomes na at index 2 and ``alpha * src + (1 - alpha) * prev`` therefore
    stays na for every later bar, including bars 3/4/5 whose own close is finite.
    Pine's smoothing carries on from the last finite value (the engine reseeds — cited
    only as the documented ``na`` rule this module departs from, not as the warrant
    for the assertion), so a bar after an na would have a number here. Naming that a
    deviation is the point: it is a property of THIS reference, not of Pine.

    Red-able the same way: per-window/reseeding semantics make ``out[3]`` finite and
    this case fails, which is the visible decision that the deviation was removed.
    """
    src = np.array([1.0, 2.0, np.nan, 4.0, 5.0, 6.0])
    out = ta_ema(src, 3)
    assert not math.isnan(out[0]) and not math.isnan(out[1]), out   # seed-at-bar-0 form
    assert all(math.isnan(v) for v in out[2:]), out                 # tail: never recovers
    assert math.isnan(out[5]), out
