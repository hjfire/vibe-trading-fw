"""Independent numpy reference implementations of the Pine ``ta.*`` builtins.

Read this module as an argument about Pine's published semantics, not as a port
of the engine. The engine (``frontend/src/lib/pineTa.ts``) may be consulted ONLY
for parameter defaults and ``na`` rules — copying its control flow here would make
the oracle agree with the engine by construction, which is the failure mode this
whole harness exists to prevent.

Two seedings coexist and are NOT interchangeable (spec §6, §11 更正一): ``ema``
starts on the first bar, ``rma`` waits for a full window and seeds on its mean.
Any "unify the warm-up" refactor here silently changes what the gate proves.

A third difference is a DEVIATION of this module, not a reading of Pine, and it is
named here so it cannot be mistaken for semantics: an ``np.nan`` in ``src``
propagates **permanently from the bar where it first appears**. ``ta_sma`` builds
its trailing windows out of one prefix sum, so a single NaN poisons every later
window of that sum; ``ta_ema`` and ``ta_rma`` carry a recursive state that is
never reset, so once the state turns NaN it stays NaN. Pine's rule is per window
— a window without an na has a mean, whatever happened earlier — and the engine
follows it (na per window at ``pineTa.ts:46-55``, state reseeded after an na at
``:134-145`` and ``:147-170``; those coordinates are cited only as the na RULE
this module deliberately departs from, never as evidence for an assertion). The
deviation is pinned by ``test_deviation_sma_na_input_poisons_every_later_bar`` and
``test_deviation_ema_na_input_poisons_the_rest_of_the_recursion`` in
``test_reference_batch1.py``: whoever rewrites these helpers to per-window
semantics turns those cases red, and that red is the visible decision that the
deviation was removed — which is the point, since a silently removed deviation
would also silently change what the gate proves. For now it is unreachable from
any committed byte: every numeric cell of all four bar fixtures is finite (400
rows, open/high/low/close/volume, re-measured), so no reference call ever sees an
na in its input — the blanks in the emitted ``values/*.csv`` are warm-up only and
are not produced by this propagation. It becomes reachable in batch 2, where
``ta.sma(rsi(...))`` and ``ta.rma(hlc3, n)`` feed a series that carries warm-up na
into a filter; if per-window semantics are wanted there, Task 5 writes
``_sma_na_propagating`` as a new helper rather than editing these three functions
in place.
"""

from __future__ import annotations

from typing import Callable, Optional

import numpy as np

NanArray = np.ndarray  # float64, same length as the input, np.nan where Pine says na

#: The one length every batch-1/2 line is computed at. The Pine source text below
#: and the reference calls in ``emit_fixtures.py`` both read THIS, so a drift in
#: the length can only be a deliberate one-edit change.
PERIOD = 5


def ta_sma(src: np.ndarray, n: int) -> NanArray:
    out = np.full(src.shape, np.nan)
    if n < 1 or src.shape[0] < n:
        return out
    csum = np.cumsum(np.insert(np.asarray(src, dtype="float64"), 0, 0.0))
    out[n - 1 :] = (csum[n:] - csum[:-n]) / n
    return out


def ta_ema(src: np.ndarray, n: int) -> NanArray:
    """alpha = 2/(n+1) seeded on ``src[0]`` — Pine's convention, no warm-up blank."""
    src = np.asarray(src, dtype="float64")
    out = np.full(src.shape, np.nan)
    if n < 1 or src.shape[0] < 1:
        return out
    alpha = 2.0 / (n + 1.0)
    prev = float(src[0])
    out[0] = prev
    for i in range(1, src.shape[0]):
        prev = alpha * float(src[i]) + (1.0 - alpha) * prev
        out[i] = prev
    return out


def ta_rma(src: np.ndarray, n: int) -> NanArray:
    """Wilder smoothing: alpha = 1/n, seeded on the SMA of the first ``n`` values."""
    src = np.asarray(src, dtype="float64")
    out = np.full(src.shape, np.nan)
    if n < 1 or src.shape[0] < n:
        return out
    prev = float(src[:n].mean())
    out[n - 1] = prev
    for i in range(n, src.shape[0]):
        prev = (prev * (n - 1) + float(src[i])) / n
        out[i] = prev
    return out


def ta_stdev(src: np.ndarray, n: int, biased: bool = True) -> NanArray:
    """Trailing ``n`` bars. ``biased=True`` (Pine's default) is the POPULATION form."""
    src = np.asarray(src, dtype="float64")
    out = np.full(src.shape, np.nan)
    if n < 1 or src.shape[0] < n:
        return out
    denom = n if biased else (n - 1)
    for i in range(n - 1, src.shape[0]):
        window = src[i - n + 1 : i + 1]
        mean = float(window.mean())
        ss = float(((window - mean) ** 2).sum())
        # The guard is Pine's own arithmetic convention — a division by zero is na —
        # not a port of any engine branch. ``ta.stdev(src, 1, false)`` divides by
        # ``n - 1 = 0``, so it has no value to report and na is the honest reading;
        # answering ``0.0`` there would assert a number precisely where Pine says na.
        # The population form keeps ``denom = n = 1`` and does answer 0.0, because a
        # one-point window really has zero deviation. That asymmetry is the semantics
        # being claimed (spec §11 更正一: the default is the population form, ddof=0),
        # and the unit case named in test_reference_batch1.py pins it — not the engine.
        out[i] = (ss / denom) ** 0.5 if denom >= 1 else np.nan
    return out


def ref_batch_1(
    cols: dict[str, NanArray], period: int, session: Optional[np.ndarray] = None
) -> dict[str, NanArray]:
    close = cols["close"]
    return {
        "sma": ta_sma(close, period),
        "ema": ta_ema(close, period),
        "rma": ta_rma(close, period),
        "stdev": ta_stdev(close, period),
        "stdev_sample": ta_stdev(close, period, biased=False),
    }


REFERENCE: dict[str, Callable[..., dict[str, NanArray]]] = {"batch_1": ref_batch_1}

#: The Pine source text the JS gate runs, per reference batch. Plot titles are the
#: ``line`` keys in the emitted ``values/*.csv`` — one file per (title, bars variant).
SCRIPTS: dict[str, str] = {
    "batch_1": (
        "//@version=5\n"
        'indicator("oracle batch 1")\n'
        f'plot(ta.sma(close, {PERIOD}), title="sma")\n'
        f'plot(ta.ema(close, {PERIOD}), title="ema")\n'
        f'plot(ta.rma(close, {PERIOD}), title="rma")\n'
        f'plot(ta.stdev(close, {PERIOD}), title="stdev")\n'
        f'plot(ta.stdev(close, {PERIOD}, false), title="stdev_sample")\n'
    ),
}
