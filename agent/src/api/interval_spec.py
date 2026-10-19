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
from datetime import date, datetime, timezone
from typing import Any
from zoneinfo import ZoneInfo

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


#: First Monday the ISO week numbering can name: 1970-01-05. Anchoring on its
#: ordinal turns an ``(iso_year, iso_week)`` pair into one monotonic integer, which
#: is what a multiplier needs — ``iso_week // k`` collides across a year boundary.
_ISO_EPOCH_ORDINAL = date(1970, 1, 5).toordinal()


def calendar_group_key(ts_ms: int, unit: str) -> tuple[int, int]:
    """Which natural week / month one daily bar belongs to.

    Daily bars arrive stamped with the epoch of **midnight UTC of their
    trading-day label** (``market_routes._bars_from_frame`` leaves ``wall_clock_zone``
    as ``None`` precisely so that a US session's date does not walk back a day), so
    the calendar date is read straight off the number with no zone table — and it
    stays the same however far from Greenwich the server sits. Grouping on the
    *viewer's* calendar instead is what splits a US week in half, the same failure
    ``timeShare.ts`` records for the 分时 cut.

    ISO week numbering rather than ``strftime("%W")``: the trading week that
    straddles New Year (Mon 29 Dec – Fri 2 Jan) is one bar on every broker's chart,
    and an (iso-year, iso-week) pair keeps it that way across the year boundary,
    where a bare week number would collide with week 1 of next year.
    """
    day = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
    if unit == "week":
        iso = day.isocalendar()
        return (int(iso[0]), int(iso[1]))
    return (day.year, day.month)


def calendar_group_ordinal(group_key: tuple[int, int], unit: str) -> int:
    """One key from :func:`calendar_group_key` as a single monotonic integer.

    Division by ``k`` needs one number, not a pair: ``(2026, 1) // 2`` and
    ``(2025, 53) // 2`` say nothing about whether those weeks are neighbours. A week
    becomes whole weeks since the ISO epoch's first Monday, a month becomes
    ``year * 12 + (month - 1)``. Both are bijections onto the pair they replace, so
    ``k == 1`` groups exactly the bars it always grouped.
    """
    year, index = group_key
    if unit == "week":
        return (date.fromisocalendar(year, index, 1).toordinal() - _ISO_EPOCH_ORDINAL) // 7
    return year * 12 + (index - 1)


def _day_ordinal(ts_ms: int) -> int:
    """Trading-day label as a whole number of days since the epoch.

    Daily bars are midnight UTC of their label, so this division *is* the label —
    no zone table, no viewer's calendar. That is what makes a ``2D`` page land the
    same way however the request was cut.
    """
    return int(ts_ms) // DAY_MS


def _session_position_keys(bars: list[dict[str, Any]], k: int, zone: str) -> list[tuple[str, int]]:
    """``(session date, position-within-session // k)`` for ascending bars.

    The anchor is a bar's index **inside its own trading session**, so a fold can never
    cross a *day or session boundary*: an A-share day holds four 60-minute bars closing
    at 10:30 / 11:30 / 14:00 / 15:00, and counting within the session gives
    [10:30, 11:30] and [14:00, 15:00] — the two bars every broker draws. A floor of UTC
    minutes serves the same two bars on this clock (+8 = 480 minutes, 480 % 120 == 0
    lines its buckets up with the session boundary) and serves three on a +5:30 one;
    the anchor is the spec because its answer does not depend on which clock the server
    sits on, not because the floor always draws the tape wrong.

    What the anchor does **not** promise is a group that stays inside one trading block.
    It counts *bars* within the session, so a ``k`` that does not divide the morning
    block leaves a group running across the midday gap: ``90m`` (= 30m × 3) welds the
    11:30, 13:30 and 14:00 bars into one served bar, and ``45m`` (= 15m × 3) welds
    11:15, 11:30 and the afternoon's first bar (13:15). Both spellings are reachable
    through :func:`parse_interval` today. This is known behaviour, not an accident —
    pinned by ``test_a_ninety_minute_fold_welds_across_the_midday_gap_by_design`` —
    because a gap-aware anchor would need this module to hold an exchange session table
    it has no evidence for, and refusing those multipliers would be a rule nobody asked
    for.

    Stateful by design and safe for paging: the count only ever walks forward, so a
    fold of a prefix is a prefix of the fold.
    """
    zone_info = ZoneInfo(zone)
    counts: dict[str, int] = {}
    keys: list[tuple[str, int]] = []
    for bar in bars:
        stamp = datetime.fromtimestamp(int(bar["timestamp"]) / 1000, tz=zone_info)
        day = stamp.date().isoformat()
        position = counts.get(day, 0)
        counts[day] = position + 1
        keys.append((day, position // k))
    return keys


def fold_by_keys(ordered_bars: list[dict[str, Any]], keys: list[Any]) -> list[dict[str, Any]]:
    """Collapse ascending bars by a parallel list of group keys.

    The OHLCV rule is the one the weekly merge has always used, and the two lists
    must already be ascending and the same length — sorting here is what a caller
    that computed its keys from a different order would silently get wrong.

    Open from the group's first bar, close from its last, high/low across the whole
    group, volume summed. The served bar keeps the **first** bar's timestamp, which
    is what makes paging exact: ``before`` is then always a group boundary, so a
    page can never split one group into two stubs.
    """
    if len(ordered_bars) != len(keys):
        raise ValueError(f"fold keys off the bar list: {len(ordered_bars)} bars, {len(keys)} keys")
    merged: list[dict[str, Any]] = []
    group: Any = None
    for bar, key in zip(ordered_bars, keys):
        if key != group:
            group = key
            merged.append(dict(bar))
            continue
        held = merged[-1]
        held["high"] = max(float(held["high"]), float(bar["high"]))
        held["low"] = min(float(held["low"]), float(bar["low"]))
        held["close"] = float(bar["close"])
        held["volume"] = float(held["volume"] or 0.0) + float(bar["volume"] or 0.0)
    return merged


def fold_bars(
    bars: list[dict[str, Any]], spec: IntervalSpec, zone: str | None = None
) -> list[dict[str, Any]]:
    """Base bars in, served bars out. Pure, no IO, ascending on the way in and out.

    ``zone`` is required for a minute fold (the session anchor) and ignored
    otherwise — the caller knows the symbol's suffix, this module must not grow a
    second copy of ``_MINUTE_WALL_CLOCK_ZONE`` to find out.
    """
    ordered = sorted(bars, key=lambda b: int(b["timestamp"]))
    if spec.kind == "native":
        return ordered
    if spec.kind == "minute-fold":
        if not zone:
            raise ValueError(
                f"{spec.interval} bars are folded {spec.k} {spec.base} ones inside a "
                "trading session, which needs the symbol's exchange clock"
            )
        return fold_by_keys(ordered, _session_position_keys(ordered, spec.k, zone))
    if spec.kind == "daily-fold":
        return fold_by_keys(ordered, [_day_ordinal(b["timestamp"]) // spec.k for b in ordered])
    return fold_by_keys(
        ordered,
        [
            calendar_group_ordinal(calendar_group_key(int(b["timestamp"]), spec.unit), spec.unit)
            // spec.k
            for b in ordered
        ],
    )


def calendar_fold_spec(unit: str, k: int) -> IntervalSpec:
    """A calendar grouping that always groups — ``k == 1`` included.

    ``fold_spec("1W", 1)`` is deliberately ``native``: that is the shape
    ``parse_interval("1W")`` gives, and the two must agree or the same request would
    fold differently through the two doors. The merge function needs the *opposite*
    default. Its ``k`` has always defaulted to one, and one natural week welded at a
    time still is a week bar — so a caller that means "group by calendar" says so
    here, instead of asking ``fold_spec`` for a shape it then has to un-degrade.
    """
    base = "1W" if unit == "week" else "1M"
    return IntervalSpec("calendar-fold", base, k, unit)
