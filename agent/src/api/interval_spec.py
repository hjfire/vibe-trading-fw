"""Custom multiplier intervals — a served base, taken k times.

This repo can already ask a source for five minute bars, daily bars and
weekly/monthly bars (``market_routes._MINUTE_PERIODS`` / ``_AGG_DAILY_PER_BAR``).
Everything else a chart asks for — 3 minutes, 2 hours, 3 months — is one of those
bases taken ``k`` times, so it needs no second data feed: it needs the fold the
weekly bars already use, with the multiplier made visible.

Three things this module deliberately does **not** do:

* it never rounds a request to the nearest neighbour it can serve — a ``2.5m`` or
  a ``0m`` has no answer here, and the caller says so by name;
* it never imports ``market_routes`` (that module imports *this* one, so the
  arrow points one way and this file stays stdlib-only and testable alone);
* it never guesses an exchange clock — a minute fold is anchored inside a trading
  session, so the caller that knows the symbol's suffix passes ``zone``.

Bar timestamps are epoch **milliseconds** end-to-end, the unit ``_bars_from_frame``
writes and KLineChart v10 reads.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

#: Minute bars a source can be asked for directly, in market spelling.
MINUTE_BASES: tuple[str, ...] = ("1m", "5m", "15m", "30m", "60m")
DAILY_BASE = "1D"
#: Calendar bars, which are themselves folded from daily ones by ``market_routes``.
CALENDAR_BASES: tuple[str, ...] = ("1W", "1M")
NATIVE_INTERVALS: tuple[str, ...] = (*MINUTE_BASES, DAILY_BASE, *CALENDAR_BASES)

_MINUTE_SECONDS = {"1m": 60, "5m": 300, "15m": 900, "30m": 1800, "60m": 3600}
_MINUTES_PER_HOUR = 60
DAY_MS = 86_400_000
DAY_SECONDS = 86400
#: A week and a month at their **widest**: 31 days for a month is the same
#: generous approximation ``udf_routes`` used to keep in its own table, and for the
#: same reason — a bar count sized from it can only come out too large and be
#: trimmed, never too small, which would clip a window.
WEEK_SECONDS = 7 * DAY_SECONDS
MONTH_SECONDS = 31 * DAY_SECONDS

#: ``<count><unit>``, and only the units this grammar means: lowercase ``m`` for
#: minutes (the market spelling), uppercase ``D``/``W``/``M`` for calendar ones
#: (both the market and the UDF spelling). A bare number is UDF-only, so it is
#: deliberately absent here.
_FOLDED_RE = re.compile(r"^(\d+)([mDWM])$")
_BARE_MINUTES_RE = re.compile(r"^\d+$")

#: Resolution spellings that mean a native interval but are not market spellings.
#: ``"1H"`` is what ``FutuLoader`` names a 60-minute bar; the bare letters are the
#: protocol's own day / week / month.
_UDF_ALIASES = {"1H": "60m", "D": "1D", "W": "1W", "M": "1M"}


@dataclass(frozen=True)
class IntervalSpec:
    """One request, resolved to the base it is folded from.

    ``kind`` is which of four shapes the request is; ``base`` is the spelling the
    existing fetch channels already understand; ``k`` is how many base bars make
    one served bar (always ``1`` when ``kind == "native"``); ``unit`` only carries
    the calendar unit for ``calendar-fold`` and the native weekly / monthly.
    """

    kind: str
    base: str
    k: int
    unit: str = ""

    @property
    def interval(self) -> str:
        """The market spelling of this same request — what ``_kline_sync`` takes.

        Both doors must land on one ``IntervalSpec`` or the UDF feed and
        ``/market/kline`` would fold differently for the same chart. The property is
        total: ``parse_interval(parse_resolution(x).interval)`` equals the original
        for every served spelling, which is pinned in the test.
        """
        if self.kind == "native":
            return self.base
        if self.kind == "minute-fold":
            return f"{self.base_minutes * self.k}m"
        if self.kind == "daily-fold":
            return f"{self.k}D"
        return f"{self.k}{self.base[-1]}"

    @property
    def base_minutes(self) -> int:
        return _MINUTE_SECONDS[self.base] // 60


def _unit_of(interval: str) -> str:
    if interval == "1W":
        return "week"
    if interval == "1M":
        return "month"
    return ""


def _minute_spec(minutes: int) -> IntervalSpec | None:
    """The largest served minute base that divides ``minutes``, taken that many times."""
    if minutes <= 0:
        return None
    for base in reversed(MINUTE_BASES):
        base_minutes = _MINUTE_SECONDS[base] // _MINUTES_PER_HOUR
        if minutes % base_minutes == 0:
            k = minutes // base_minutes
            return IntervalSpec("native" if k == 1 else "minute-fold", base, k)
    return None  # unreachable while 1m is served: one minute divides every count


def parse_interval(text: str) -> IntervalSpec | None:
    """``"120m"`` / ``"2D"`` / ``"3M"`` and the eight native spellings; else ``None``.

    Refused: a non-positive or fractional count (``0m``, ``2.5m``, ``-5m``), an
    unknown unit, and a bare number — bare minutes is the UDF spelling
    (:func:`parse_resolution`), and accepting it here would let one URL mean two
    intervals depending on who read the docstring.
    """
    t = (text or "").strip()
    if t in NATIVE_INTERVALS:
        return IntervalSpec("native", t, 1, _unit_of(t))
    m = _FOLDED_RE.match(t)
    if m is None:
        return None
    n, unit = int(m.group(1)), m.group(2)
    if n <= 0:
        return None
    if n == 1:  # `1m`/`1D` are native; `1W`/`1M` already returned above
        return IntervalSpec("native", f"{n}{unit}", 1, _unit_of(f"{n}{unit}"))
    if unit == "m":
        return _minute_spec(n)
    if unit == "D":
        return IntervalSpec("daily-fold", DAILY_BASE, n)
    return IntervalSpec("calendar-fold", f"1{unit}", n, _unit_of(f"1{unit}"))


def parse_resolution(text: str) -> IntervalSpec | None:
    """UDF resolution -> spec. Bare numbers are minutes; ``D``/``W``/``M``/``1H`` are aliases."""
    t = (text or "").strip()
    if t in _UDF_ALIASES:
        return parse_interval(_UDF_ALIASES[t])
    if _BARE_MINUTES_RE.match(t):
        return _minute_spec(int(t))
    return parse_interval(t)


def fold_spec(base: str, k: int) -> IntervalSpec:
    """``base`` bars folded ``k`` at a time (``k == 1`` is the merge already in use)."""
    if base in CALENDAR_BASES:
        return IntervalSpec("calendar-fold" if k > 1 else "native", base, k, _unit_of(base))
    if base == DAILY_BASE:
        return IntervalSpec("daily-fold" if k > 1 else "native", base, k)
    return IntervalSpec("minute-fold" if k > 1 else "native", base, k)


def bar_seconds(spec: IntervalSpec) -> int:
    """Approximate width of one served bar, generous.

    Total for every spec this module can produce, and it is ``base`` alone that
    decides the width: an ``IntervalSpec`` hand-built around a base outside this
    module's vocabulary raises rather than being sized off a guess. That is the
    point — the two ``.get(..., 86400)`` defaults in ``udf_routes`` silently read
    *every* unknown spelling as a day, and a fold must never be sized off a guess.
    """
    if spec.base in _MINUTE_SECONDS:
        return _MINUTE_SECONDS[spec.base] * spec.k
    unit = _unit_of(spec.base)
    if unit == "week":
        return WEEK_SECONDS * spec.k
    if unit == "month":
        return MONTH_SECONDS * spec.k
    if spec.base == DAILY_BASE:
        return DAY_SECONDS * spec.k
    raise ValueError(f"no bar width for base {spec.base!r}")
