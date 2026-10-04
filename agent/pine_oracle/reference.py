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
never reset, so once the state turns NaN it stays NaN. The engine's rule is per
window — a window without an na has a mean, whatever happened earlier (na per
window at ``pineTa.ts:46-55``, state reseeded after an na at ``:134-145`` and
``:147-170``; cited as the rule this module deliberately departs from, never as
evidence for an assertion). What Pine itself does — carry, poison or reseed — is
an open Task 6 external-anchor question, and this module takes no position on it:
no gate depends on the answer, because nothing in the harness runs an na through
these three helpers (see the reachability note below). The
deviation is pinned by ``test_deviation_sma_na_input_poisons_every_later_bar`` and
``test_deviation_ema_na_input_poisons_the_rest_of_the_recursion`` in
``test_reference_batch1.py``: whoever rewrites these helpers to per-window
semantics turns those cases red, and that red is the visible decision that the
deviation was removed — which is the point, since a silently removed deviation
would also silently change what the gate proves. For now it is unreachable from
any committed byte: every numeric cell of all four bar fixtures is finite (400
rows, open/high/low/close/volume, re-measured), so no reference call ever sees an
na in its input — the blanks in the emitted ``values/*.csv`` are warm-up only and
are not produced by this propagation. It is also unreachable from the planned
batches: every later call site feeds these three helpers either a raw price
column or an na-free derived series — ``ta_rsi`` replaces bar 0's na ``change``
with ``0`` before smoothing, so both ``ta_rma`` streams are finite; ``ta_tr`` is
finite from bar 0, which is what ``ta_atr`` and Supertrend's rma consume;
``ta_bb`` smooths ``close``; ``ta_macd`` smooths a dense ema-minus-ema. The one
planned smoothing over an na-carrying series is ``stoch_d``
(``ta.sma(k5, d_len)``), and the plan answers it with the separate per-window
helper ``_sma_na_propagating`` rather than by editing these three functions in
place.
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


#: --- batch 2 parameters: one definition each, consumed by BOTH ref_batch_2 and
#: SCRIPTS["batch_2"], so the Pine text the JS gate runs and the numpy series the
#: fixture stores cannot quietly disagree about a length.
RSI_LEN = 14
MACD_FAST = 12
MACD_SLOW = 26
MACD_SIG = 9
BB_COEF = 2.0
STOCH_D_LEN = 3


def ta_tr(high: np.ndarray, low: np.ndarray, close: np.ndarray) -> NanArray:
    """True range, bar 0 included.

    The engine's ``pc`` at bar 0 is ``close[0]`` (pineTa.ts:536), not a missing
    value; for any bar with ``low <= close <= high`` the three candidates collapse
    to ``high - low``, which is what the folklore rule states.
    """
    out = np.empty(high.shape, dtype="float64")
    out[0] = max(
        float(high[0]) - float(low[0]),
        abs(float(high[0]) - float(close[0])),
        abs(float(low[0]) - float(close[0])),
    )
    for i in range(1, high.shape[0]):
        pc = float(close[i - 1])
        out[i] = max(
            float(high[i]) - float(low[i]),
            abs(float(high[i]) - pc),
            abs(float(low[i]) - pc),
        )
    return out


def ta_atr(high: np.ndarray, low: np.ndarray, close: np.ndarray, n: int) -> NanArray:
    return ta_rma(ta_tr(high, low, close), n)


def ta_rsi(src: np.ndarray, n: int) -> NanArray:
    """RSI on the engine's seeding rule (see the batch-2 note above).

    ``change`` is na at bar 0, but the engine feeds ``0`` into both rma streams
    there, so the seeding window is ``[0, c1, .. c(n-1)]`` and the first non-na
    output is at index ``n-1``. ``dn == 0`` -> 50 when ``up`` is also 0, else 100.
    """
    src = np.asarray(src, dtype="float64")
    out = np.full(src.shape, np.nan)
    L = src.shape[0]
    if n < 1 or L < n:
        return out
    change = np.full(L, np.nan)
    change[1:] = np.diff(src)
    up = np.where(np.isnan(change) | (change < 0), 0.0, change)
    down = np.where(np.isnan(change) | (change > 0), 0.0, -change)
    r_up, r_down = ta_rma(up, n), ta_rma(down, n)
    for i in range(L):
        if np.isnan(r_up[i]) or np.isnan(r_down[i]):
            continue
        u, d = float(r_up[i]), float(r_down[i])
        if d == 0.0:
            out[i] = 50.0 if u == 0.0 else 100.0
        elif u == 0.0:
            out[i] = 0.0
        else:
            out[i] = 100.0 - 100.0 / (1.0 + u / d)
    return out


def ta_bb(src: np.ndarray, n: int, coef: float) -> dict[str, NanArray]:
    """Bollinger on the engine's stdev default: the deviation is the POPULATION one."""
    src = np.asarray(src, dtype="float64")
    basis = ta_sma(src, n)
    dev = coef * ta_stdev(src, n)
    return {"bb_basis": basis, "bb_upper": basis + dev, "bb_lower": basis - dev}


def ta_macd(src: np.ndarray, fast: int, slow: int, sig: int) -> dict[str, NanArray]:
    """Three dense series from bar 0: line = ema(fast) - ema(slow), signal = ema(line).

    Because this engine's ``ema`` seeds at the first bar, nothing here is na during
    warm-up — the histogram is exactly ``line - signal``.
    """
    src = np.asarray(src, dtype="float64")
    line = ta_ema(src, fast) - ta_ema(src, slow)
    signal = ta_ema(line, sig)
    return {"macd": line, "macd_signal": signal, "macd_hist": line - signal}


def _sma_na_propagating(src: np.ndarray, n: int) -> NanArray:
    """A trailing mean that answers only for a window with no na in it.

    This is the rule THIS helper states — "a window holding an na has no mean" — and
    it is deliberately not the batch-1 ``ta_sma`` cumsum form, whose prefix sum is
    poisoned permanently by the first na (see the module docstring's DEVIATION note).
    The engine's ``smaStep`` is per window: it returns NA the moment a value in the
    *current* window is NA (pineTa.ts:46-54), which is what pushes the second stoch
    stage one bar later per na it inherits. What Pine's own ``ta.sma`` does with an
    na in the window is a Task 6 external-anchor question, not a claim made here.
    """
    out = np.full(src.shape, np.nan)
    for i in range(n - 1, src.shape[0]):
        window = src[i - n + 1 : i + 1]
        if not np.any(np.isnan(window)):
            out[i] = float(window.mean())
    return out


def ta_stoch(
    src: np.ndarray, high: np.ndarray, low: np.ndarray, n: int, d_len: int
) -> dict[str, NanArray]:
    """%K from the trailing high/low window (partial from bar 0); %D = sma(%K, d_len).

    ``hh == ll`` -> na (no divide-by-zero). The engine's four-argument overload
    returns %K only and its fifth argument is ``smoothK`` (pineTa.ts:596-610), so
    %D is produced on the Pine side by an explicit ``ta.sma`` — never by a six
    argument call, which would silently be a smoothed K.
    """
    src = np.asarray(src, dtype="float64")
    high = np.asarray(high, dtype="float64")
    low = np.asarray(low, dtype="float64")
    k = np.full(src.shape, np.nan)
    for i in range(src.shape[0]):
        # No full-window gate (pineTa.ts:212-222): bar 0 is measured over one bar.
        start = max(0, i - n + 1)
        hh = float(np.max(high[start : i + 1]))
        ll = float(np.min(low[start : i + 1]))
        if hh == ll:
            continue
        k[i] = 100.0 * (float(src[i]) - ll) / (hh - ll)
    return {"stoch_k": k, "stoch_d": _sma_na_propagating(k, d_len)}


def ref_batch_2(
    cols: dict[str, NanArray], period: int, session: Optional[np.ndarray] = None
) -> dict[str, NanArray]:
    """Batch 2's ten lines. ``session`` is unused: none of these builtins is session-aware.

    The engine's own ``ta.atr``/``ta.tr`` likewise read only high/low/close
    (pineTa.ts:532-545), so there is no session branch to mirror here.
    """
    close = cols["close"]
    out: dict[str, NanArray] = {
        "rsi": ta_rsi(close, RSI_LEN),
        "atr": ta_atr(cols["high"], cols["low"], close, period),
    }
    out.update(ta_bb(close, period, BB_COEF))
    out.update(ta_macd(close, MACD_FAST, MACD_SLOW, MACD_SIG))
    out.update(ta_stoch(close, cols["high"], cols["low"], period, STOCH_D_LEN))
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
REFERENCE["batch_2"] = ref_batch_2

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

# Batch 2's Pine text. ``ta.stoch`` here is the FOUR-argument overload, which returns
# %K only (its fifth argument is smoothK, pineTa.ts:596-610); %D is therefore an
# explicit ``ta.sma`` on the K, matching ``ta_stoch``'s ``_sma_na_propagating`` stage.
# The three-value destructurings below are the shape Pine documents and the engine
# implements (bb -> [basis, upper, lower], macd -> [line, signal, hist]); tuple
# returns already have committed precedent in ``pineRealWorld.test.ts:90/97``.
SCRIPTS["batch_2"] = (
    "//@version=5\n"
    'indicator("oracle batch 2")\n'
    f'plot(ta.rsi(close, {RSI_LEN}), title="rsi")\n'
    f'plot(ta.atr({PERIOD}), title="atr")\n'
    f'[basis, upper, lower] = ta.bb(close, {PERIOD}, {BB_COEF})\n'
    'plot(basis, title="bb_basis")\n'
    'plot(upper, title="bb_upper")\n'
    'plot(lower, title="bb_lower")\n'
    f'[macdLine, macdSig, macdHist] = ta.macd(close, {MACD_FAST}, {MACD_SLOW}, {MACD_SIG})\n'
    'plot(macdLine, title="macd")\n'
    'plot(macdSig, title="macd_signal")\n'
    'plot(macdHist, title="macd_hist")\n'
    f'k5 = ta.stoch(close, high, low, {PERIOD})\n'
    'plot(k5, title="stoch_k")\n'
    f'plot(ta.sma(k5, {STOCH_D_LEN}), title="stoch_d")\n'
)
