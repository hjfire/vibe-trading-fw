"""Independent numpy reference implementations of the Pine ``ta.*`` builtins.

Read this module as an argument about Pine's published semantics, not as a port
of the engine. The engine (``frontend/src/lib/pineTa.ts``) may be consulted ONLY
for parameter defaults and ``na`` rules — copying its control flow here would make
the oracle agree with the engine by construction, which is the failure mode this
whole harness exists to prevent.

Two seedings coexist and are NOT interchangeable (spec §6, §11 更正一): ``ema``
starts on the first bar, ``rma`` waits for a full window and seeds on its mean.
Any "unify the warm-up" refactor here silently changes what the gate proves.
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
        out[i] = (ss / denom) ** 0.5 if denom > 0 else 0.0
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
