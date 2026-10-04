"""Deterministic bar arrays for the oracle fixtures.

Integer LCG only, then one division: the stream must be reproducible without
numpy and without any dependency on the host's float print settings. Bars live
in the committed CSV, never re-derived in JS — see the header of
``test_bars.py`` for why that matters.

The injected-gap count is exact because of a constructive invariant, not a noise
bound: ``price = close`` carries the *unrounded* close into the next bar's open,
so on a bar with no injected gap ``open[i]`` and ``close[i-1]`` are the same
float run through the same ``round(value, 6)``. The overnight ratio
``open[i] / close[i-1] - 1`` is therefore identically 0.0 there whatever
``_BODY_STEP`` is — only the injected jumps can reach a 1% threshold.
``test_non_injected_bars_open_equals_previous_close`` pins that invariant.

``time`` is ``DAY_ZERO_MS + i * DAY_MS`` over consecutive calendar days, not the
A-share trading calendar, so the committed daily fixtures contain weekend bars.
"""

from __future__ import annotations

from typing import Any

from pine_oracle.schema import BAR_COLUMNS, BARS_INTRADAY_EXTRA_COLUMNS, fmt_float

LCG_MULTIPLIER = 1103515245
LCG_INCREMENT = 12345
LCG_MODULUS = 2**31

DAILY_BAR_COUNT = 120
INTRADAY_SESSIONS = 5
FIRST_SESSION_ID = 1
BARS_PER_SESSION = 8

#: Per-bar body step: without a bias the bar body stays within
#: ``|close/open - 1| <= _BODY_STEP/2``; ``trend`` adds ``_TREND_BIAS`` on top of
#: the draw, so its bodies run larger. This constant scales the body only — the
#: gap count measures the overnight ratio, which it cannot move (module docstring).
_BODY_STEP = 0.012
#: Upward bias added to the LCG draw in ``trend`` shape (compounds to ~2.3x over 120 bars).
_TREND_BIAS = 0.6
#: Overnight jumps injected every _GAP_EVERY bars in ``gap`` shape.
_GAP_EVERY = 23
_GAP_UP = 0.05
_GAP_DOWN = -0.055

#: Daily epoch-ms for 2024-01-02 (Tue), the first A-share bar of that week.
DAY_ZERO_MS = 1_704_153_600_000
DAY_MS = 86_400_000
#: Session starts, in ms from local midnight, Asia/Shanghai wall clock (+08:00).
_AM_START_MS = 9 * 3_600_000 + 30 * 60_000      # 09:30
_PM_START_MS = 13 * 3_600_000                    # 13:00
_MIN30_MS = 1_800_000
#: Exchange zone offset, written into the epoch explicitly so the fixture does
#: not depend on the host's timezone.
_OFFSET_MS = 8 * 3_600_000


def lcg_stream(seed: int, n: int) -> list[float]:
    """``n`` values in [0, 1) from a plain integer linear congruential generator."""
    state = seed % LCG_MODULUS
    out: list[float] = []
    for _ in range(n):
        state = (LCG_MULTIPLIER * state + LCG_INCREMENT) % LCG_MODULUS
        out.append(state / LCG_MODULUS)
    return out


def make_daily_bars(seed: int, n: int, shape: str) -> list[dict[str, Any]]:
    """``n`` daily bars. Wicks swing independently of the adjacent closes.

    ``shape``:
      ``trend``      — a persistent upward drift (tests warm-up and seeding).
      ``oscillate``  — mean-reverting with independent wicks (extrema must exist).
      ``gap``        — oscillating plus injected overnight jumps (tests
                       ``change``/``tr``/``rsi`` handling of discontinuities).
    """
    if shape not in {"trend", "oscillate", "gap"}:
        raise ValueError(f"unknown shape {shape!r}")
    rnd = lcg_stream(seed, n * 6)
    bias = _TREND_BIAS if shape == "trend" else 0.0
    rows: list[dict[str, Any]] = []
    price = 20.0
    for i in range(n):
        # A gap belongs in the OPEN (an overnight jump), not the close: the test
        # that counts them measures ``open[i] / close[i-1]``, which is exactly 1
        # without this line. Its sign draws from a slot no other term uses.
        if shape == "gap" and i and i % _GAP_EVERY == _GAP_EVERY - 1:
            price *= 1 + (_GAP_UP if rnd[5 * n + i] > 0.5 else _GAP_DOWN)
        open_ = price
        shock = (rnd[i] - 0.5 + bias) * _BODY_STEP
        close = open_ * (1 + shock)
        # Independent wicks: each is drawn from its own stream slot, not from the
        # bar's own open/close, otherwise a strict local extremum is impossible.
        up_wick = rnd[2 * n + i] * 0.03
        down_wick = rnd[3 * n + i] * 0.03
        high = max(open_, close) * (1 + up_wick)
        low = min(open_, close) * (1 - down_wick)
        rows.append(
            {
                "time": DAY_ZERO_MS + i * DAY_MS,
                "open": round(open_, 6),
                "high": round(high, 6),
                "low": round(low, 6),
                "close": round(close, 6),
                "volume": int(1_000_000 + rnd[4 * n + i] * 5_000_000),
            }
        )
        price = close
    return rows


def make_intraday_bars(seed: int, sessions: int) -> list[dict[str, Any]]:
    """A-share intraday grid: 8 x 30-minute bars per session, 09:30-11:30 / 13:00-15:00.

    ``session`` is written as its own column so the reference implementation can
    express TradingView's session-anchored VWAP. The engine does not take a
    session argument at all (spec §6 vwap row), which is the gap this column
    makes measurable rather than the mechanism under test.
    """
    total = sessions * BARS_PER_SESSION
    rnd = lcg_stream(seed, total * 6)
    rows: list[dict[str, Any]] = []
    price = 30.0
    slot = 0
    for s in range(sessions):
        day = DAY_ZERO_MS + s * DAY_MS
        # 09:30,10:00,10:30,11:00 | 13:00,13:30,14:00,14:30 — the lunch gap lives in
        # the timestamps, so an even-spacing shortcut cannot reproduce it.
        starts = [_AM_START_MS + k * _MIN30_MS for k in range(4)]
        starts += [_PM_START_MS + k * _MIN30_MS for k in range(4)]
        for k in range(BARS_PER_SESSION):
            shock = (rnd[slot] - 0.5) * 0.008
            close = price * (1 + shock)
            high = max(price, close) * (1 + rnd[2 * total + slot] * 0.004)
            low = min(price, close) * (1 - rnd[3 * total + slot] * 0.004)
            rows.append(
                {
                    "time": day - _OFFSET_MS + starts[k],
                    "open": round(price, 6),
                    "high": round(high, 6),
                    "low": round(low, 6),
                    "close": round(close, 6),
                    "volume": int(50_000 + rnd[4 * total + slot] * 500_000),
                    "session": FIRST_SESSION_ID + s,
                }
            )
            price = close
            slot += 1
    return rows


def bars_csv_text(rows: list[dict[str, Any]], with_session: bool = False) -> str:
    """Serialise bars; the header is ``schema.BAR_COLUMNS`` (+ ``session``)."""
    fields = list(BAR_COLUMNS[1:]) + (list(BARS_INTRADAY_EXTRA_COLUMNS) if with_session else [])
    lines = [",".join(("bar_index", *fields))]
    for i, row in enumerate(rows):
        cells = [str(i)]
        for name in fields:
            value = row[name]
            cells.append(str(value) if isinstance(value, int) else fmt_float(float(value)))
        lines.append(",".join(cells))
    return "\n".join(lines) + "\n"
