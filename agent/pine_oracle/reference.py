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

    Total on an empty input, like the rest of this module's helpers: with no bar
    there is no bar-0 candidate to read, so the answer is an empty result rather
    than an ``IndexError``. Nothing on the gate depends on that branch (all four
    bar fixtures carry 40 or 120 rows); it is here so the helper is a function on
    every input the module's other helpers already accept.
    """
    out = np.empty(high.shape, dtype="float64")
    if high.shape[0] == 0:
        return out
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
    *current* window is NA (pineTa.ts:46-55), which is what pushes the second stoch
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
        # No full-window gate (pineTa.ts:212-224): bar 0 is measured over one bar.
        start = max(0, i - n + 1)
        hh = float(np.max(high[start : i + 1]))
        ll = float(np.min(low[start : i + 1]))
        if hh == ll:
            continue
        k[i] = 100.0 * (float(src[i]) - ll) / (hh - ll)
    return {"stoch_k": k, "stoch_d": _sma_na_propagating(k, d_len)}


#: Supertrend's published parameters — TV's body inputs ``atrPeriod = 10``,
#: ``factor = 3.0``, and Pine's two-argument form takes them as (factor, atrPeriod).
#: Consumed by BOTH ``ref_batch_3`` and SCRIPTS["batch_3"] like every other length.
ST_PERIOD = 10
ST_FACTOR = 3.0


def ta_supertrend(
    high: np.ndarray,
    low: np.ndarray,
    close: np.ndarray,
    period: int = ST_PERIOD,
    multiplier: float = ST_FACTOR,
) -> dict[str, NanArray]:
    """Transcribed from TradingView's published Pine body, not from the engine.

    Three things a naive port gets wrong, each named by a test above:
      - the trend state is keyed on ``prevSuperTrend == prevUpperBand``, not a boolean
        flag, and the flip test uses *this* bar's close against the *ratcheted* band;
      - the cold start is ``if na(atr[1]) direction := 1``, not "compare close to hl2";
      - ``-1`` is the uptrend (line = lower band).

    The warm-up reading is THIS IMPLEMENTATION'S CHOICE, not Pine's rule. On the first
    bar there is no ``upperBand[1]`` / ``lowerBand[1]`` / ``close[1]``; this port guards
    the previous band with ``np.isfinite``, the same reading the engine takes
    (``pineTa.ts:700-713``). Pine's own behaviour there is NOT ANCHORED — whether
    ``nz(na)`` answering 0 makes the reassignment pick its ``prev`` arm, or the na
    comparison poisons the ternary — and the third-party fetch for it failed, recorded
    as 「未取到，已放弃」 in ``EXTERNAL_ANCHORS.md``. Taking the body's ``nz()`` literally
    instead produces a different line. Measured on this module's own five-bar table
    (period=1, factor=1.0, high=[10,12,11,20,19], low=[8,10,9,11,10],
    close=[9,11,10,19,18]; recomputed in task-6-report.md 「Fix round 1」):
      - NaN guard (this implementation): line [11.0, 11.0, 11.0, 8.0, 8.0]
      - literal ``nz()``, na comparison takes the false arm: [0.0, 14.0, 12.0, 8.0, 8.0]
      - literal ``nz()``, na poisons the ternary: [na, 8.0, 8.0, 8.0, 8.0]
    So bar 0 is 11.0 only under the guard; the wrong reason for it (``nz()`` as a no-op
    "while prices stay positive") is not a reason at all — bar 0 differs because the
    previous bar is missing, and positive prices cannot fix that. On the four committed
    bar fixtures at ``ST_PERIOD``/``ST_FACTOR`` the false-arm reading differs from the
    committed ``supertrend`` CSVs at index 0 alone (0.0 where the CSV is empty), i.e. 8
    na there against 9 committed, on all four shapes; the same reading answers +/-1
    through the whole ATR warm-up where both sides of the gate leave na (``st_direction``
    0 na against 9). Direction on the five-bar table is [1, 1, 1, -1, -1] under the guard
    AND under the false-arm reading, while the poisoned-ternary variant moves bars 1-3 to
    -1 — which is exactly why no reading of the un-anchored warm-up gets called Pine's.
    """
    src = (np.asarray(high, dtype="float64") + np.asarray(low, dtype="float64")) / 2.0
    close = np.asarray(close, dtype="float64")
    atr_ = ta_rma(ta_tr(high, low, close), period)
    n = close.shape[0]
    upper = np.full(n, np.nan)
    lower = np.full(n, np.nan)
    line = np.full(n, np.nan)
    direction = np.full(n, np.nan)
    prev_line = np.nan
    for i in range(n):
        if np.isnan(atr_[i]):
            # This implementation leaves na through the ATR warm-up. The published body
            # has NO early return there — it keeps evaluating, and what it answers depends
            # on the un-anchored nz()/na reading (see the docstring), so na here is THIS
            # port's chosen equivalent, not something the body states.
            continue
        ub = float(src[i]) + float(multiplier) * float(atr_[i])
        lb = float(src[i]) - float(multiplier) * float(atr_[i])
        # np.isfinite, not `not np.isnan`: the engine guards the previous band with
        # Number.isFinite (pineTa.ts:700-713), so a +/-inf previous band counts as
        # unusable on both sides. Unreachable on the committed bars (test_bars.py
        # asserts finiteness), so this alignment moves no CSV byte.
        prev_ub = float(upper[i - 1]) if i > 0 and np.isfinite(upper[i - 1]) else np.nan
        prev_lb = float(lower[i - 1]) if i > 0 and np.isfinite(lower[i - 1]) else np.nan
        prev_close = float(close[i - 1]) if i > 0 else np.nan
        if not np.isnan(prev_ub) and not (ub < prev_ub or prev_close > prev_ub):
            ub = prev_ub
        if not np.isnan(prev_lb) and not (lb > prev_lb or prev_close < prev_lb):
            lb = prev_lb
        upper[i], lower[i] = ub, lb
        prev_atr = float(atr_[i - 1]) if i > 0 else np.nan
        if np.isnan(prev_atr):
            d = 1.0
        elif prev_line == prev_ub:
            d = -1.0 if close[i] > ub else 1.0
        else:
            d = 1.0 if close[i] < lb else -1.0
        direction[i] = d
        prev_line = lb if d == -1.0 else ub
        line[i] = prev_line
    return {"supertrend": line, "st_direction": direction}


def ta_vwap(
    price: np.ndarray, volume: np.ndarray, session: Optional[np.ndarray] = None
) -> dict[str, NanArray]:
    """Running ``sum(price*volume) / sum(volume)`` — unanchored unless a session is given.

    ``session=None`` is the reading the gate uses, because the engine's ``ta.vwap``
    takes no session argument and accumulates over the whole loaded range
    (``pineTa.ts:960-970``, whose own comment notes the TV difference as a warning).
    Passing a session column re-anchors at each change; that per-session form is what
    THIS REPO already asserts of TradingView — ``scriptLibrary.ts:160``,
    「按整段区间累计（TV 为逐日锚定）」 — and TradingView's own documentation for it was
    NOT retrieved (``EXTERNAL_ANCHORS.md`` logs the fetch as 未取到，已放弃), so it is a
    citation of an in-repo assertion, not an anchored external fact. COVERAGE.md carries
    the difference as a backlog item rather than a passing gate.

    The na-price branch below (a bar whose price is na is skipped but still emits the
    ratio accumulated through the PREVIOUS bar, mirroring ``pineTa.ts:960-970``) is
    UNREACHABLE on the committed fixtures: hlc3 is finite on all four shapes and volume
    is always positive, so the gate prints ``na=0`` for ``vwap`` everywhere and 判据二
    never exercises this branch. It is pinned by a unit test instead
    (``test_vwap_an_na_price_bar_carries_the_previous_running_ratio``).
    """
    price = np.asarray(price, dtype="float64")
    volume = np.asarray(volume, dtype="float64")
    out = np.full(price.shape, np.nan)
    cur: Optional[int] = None
    num = den = 0.0
    for i in range(price.shape[0]):
        s = 0 if session is None else int(session[i])
        if s != cur:
            cur, num, den = s, 0.0, 0.0
        if not np.isnan(price[i]):
            num += float(price[i]) * float(volume[i])
            den += float(volume[i])
        out[i] = num / den if den != 0.0 else np.nan
    return {"vwap": out}


def ref_batch_3(
    cols: dict[str, NanArray], period: int, session: Optional[np.ndarray] = None
) -> dict[str, NanArray]:
    """Three lines, same Pine call signature on all four bar shapes.

    ``session`` is accepted and ignored on purpose (see ``ta_vwap`` and the batch-3
    test): the engine reads no session parameter, so honouring it here would compare
    a different function to the engine and call the gap a pass. ``period`` (the
    harness-wide ``PERIOD``) is likewise not Supertrend's length — TV's published
    inputs are ``ST_PERIOD``/``ST_FACTOR``, and the Pine text below passes those same
    constants, so no length can disagree between the two sides.
    """
    out = ta_supertrend(cols["high"], cols["low"], cols["close"], ST_PERIOD, ST_FACTOR)
    hlc3 = (cols["high"] + cols["low"] + cols["close"]) / 3.0
    out.update(ta_vwap(hlc3, cols["volume"]))
    return out


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
REFERENCE["batch_3"] = ref_batch_3

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

# Batch 3's Pine text. Supertrend's two outputs are read with a destructuring tuple,
# the same form the in-repo TV corpus already exercises (``pineRealWorld.test.ts:97``'s
# ``[stBuiltin, dirBuiltin] = ta.supertrend(factor, atrPeriod)``), and the two arguments
# are Pine's v5 order (factor, atrPeriod) — ``pineTa.ts:674-678`` reads them in that
# order, so ``ST_FACTOR`` comes first here and in ``ta_supertrend``'s call below.
# ``ta.vwap`` is written with its source spelled out: the engine answers the bare
# builtin with hlc3 (``pineTa.ts:960-970``, ``src = args.length ? ... : hlc3``), but a
# bare member access never reaches the ``ta.*`` dispatcher (that branch lives on the
# CALL path, ``pineRuntime.ts:1537-1541``), and no in-repo corpus writes it that way —
# the only live use is ``scriptLibrary.ts:165``'s ``ta.vwap(hlc3)``. Passing hlc3
# explicitly is the same function on both sides of the gate, so the argument list
# states what is compared instead of leaning on a default the runtime cannot see.
SCRIPTS["batch_3"] = (
    "//@version=5\n"
    'indicator("oracle batch 3")\n'
    f'[stBand, stDir] = ta.supertrend({ST_FACTOR}, {ST_PERIOD})\n'
    'plot(stBand, title="supertrend")\n'
    'plot(stDir, title="st_direction")\n'
    'plot(ta.vwap(hlc3), title="vwap")\n'
)
