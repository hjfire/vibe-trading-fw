"""Macro-regime timeline: sign breadth + causal hysteresis over published data.

Where this sits
---------------
``backtest.regime`` answers "is the market fused?" from rolling correlations
between *prices*. This module answers "is the macro backdrop expanding or
contracting?" from *published indicators*. The two share the machinery that
matters — a trailing (causal) smoother feeding a two-threshold Schmitt trigger
— and nothing else, because their inputs have different failure modes.

What price data does not have to worry about is publication lag. A monthly
reading stamped ``2026-06-30`` for China's retail sales is not knowable until
roughly mid-July, and GDP for a quarter ends 45-odd days later. Label a regime
"EXPANSION as of 2026-06-30" and join it against daily prices, and every
backtest that uses it trades on information nobody had. So every timeline
produced here is indexed by **availability date** (period end + lag), not by
the period the indicator describes, and the lag is reported back in ``params``
rather than hidden. The asymmetry that sets the defaults: a lag that is too
long only costs reaction time, a lag that is too short is lookahead bias.

Why the vote is a sign
----------------------
Indicators do not share a unit: ``%`` yoy prints, ``点`` PMIs, ``亿元`` aggregates
all land in one store. Averaging them needs a normalisation assumption (z-score,
min-max, percentile) that itself needs a long, stationarity-assuming history to
be valid. The only aggregation that requires no such assumption is the sign of
a period-over-period change, so that is what a series contributes: +1, -1, or 0
for "no change", with breadth the mean over whichever votes are currently alive.

Cache-only by construction
--------------------------
Nothing here reaches the network. The iFinD MCP free tier is 2000 requests *in
total*, so regime computation must be a pure function over what
:mod:`backtest.macro_series` already stored locally; a regime step that could
fetch would turn every research loop into a quota leak.
"""

from __future__ import annotations

import bisect
import datetime as dt
import logging
from typing import Any, Mapping, Sequence

import numpy as np
import pandas as pd

from backtest.macro_series import (
    MacroSeries,
    list_cached,
    load_series,
    record_to_series,
    slug_for,
)

logger = logging.getLogger(__name__)

EXPANSION = "EXPANSION"
NEUTRAL = "NEUTRAL"
CONTRACTION = "CONTRACTION"

_STATE_LABELS = {1: EXPANSION, 0: NEUTRAL, -1: CONTRACTION}

# Hysteresis band on smoothed breadth. Entering needs more agreement than
# staying in: with five indicators, ``enter=0.34`` means at least four of five
# pointing the same way (0.6) clears it while a 3/2 split (0.2) does not, and
# the 0.12 exit releases the label once the split turns roughly even again. The
# dead band between the two is the whole reason for a Schmitt trigger — a single
# threshold on a stepped series would flip state on every third print.
DEFAULT_ENTER_THRESHOLD = 0.34
DEFAULT_EXIT_THRESHOLD = 0.12

# Trailing windows, counted in *rows of their own grid*, not calendar time.
DEFAULT_DIFF_WINDOW = 1  # periods compared when taking the first difference
DEFAULT_VOTE_SMOOTHING = 3  # rows of one indicator's own period series
DEFAULT_BREADTH_SMOOTHING = 2  # rows of the (uneven) availability grid

# A series must have this many surviving observations before it votes. Below it
# there is no difference to take, so the series abstains rather than adding a
# confident-looking zero.
DEFAULT_MIN_PERIODS = 4

# Publication lag in days, keyed by iFinD ``freq`` code. Deliberately
# conservative (see module docstring): monthly Chinese statistics land on the
# 9th-15th of the following month, so 18 days covers the whole spread rather
# than optimistically assuming CPI's 10th. Annual shares the quarterly figure —
# preliminary GDP arrives mid-January but the level most research quotes is the
# February statistical bulletin.
_DEFAULT_LAG_DAYS_BY_FREQ: dict[str, int] = {
    "D": 1,
    "W": 7,
    "M": 18,
    "Q": 45,
    "Y": 45,
}
_UNKNOWN_FREQ_LAG_DAYS = 18  # unlabelled frequency is treated as monthly

# Nominal length of one reporting period, used only to decide how long a
# carried-forward vote stays alive: two missed periods and the series has
# clearly stopped publishing, so it drops out of the denominator instead of
# voting with last year's news forever.
_PERIOD_DAYS_BY_FREQ: dict[str, int] = {
    "D": 1,
    "W": 7,
    "M": 31,
    "Q": 92,
    "Y": 366,
}
_UNKNOWN_FREQ_PERIOD_DAYS = 31
_STALE_PERIOD_MULTIPLIER = 2

# Below this many voting indicators, "breadth" is a coin flip wearing a
# decimal point. Not refused — a one-indicator gauge is a legitimate narrow
# question — but it has to be said out loud in ``warnings``.
_MIN_BREADTH_DEPTH = 3


# ---------------------------------------------------------------------------
# Cache-only input
# ---------------------------------------------------------------------------


def load_macro_series(query: str) -> MacroSeries | None:
    """Resolve one cached indicator by index id, slug, exact name, or substring.

    Cache-only, like everything in this module. Resolution order is strict so a
    caller holding an ``M001657195``-style code never depends on label wording,
    which iFinD renders inconsistently.

    Args:
        query: An iFinD indicator code, a cache slug, an exact indicator name,
            or a substring unique among the cached series.

    Returns:
        The decoded series, or ``None`` when nothing is cached under that query.

    Raises:
        ValueError: When a substring matches more than one cached series; the
            message lists the candidates so the caller can disambiguate instead
            of guessing which one it got.
    """
    needle = (query or "").strip()
    if not needle:
        return None
    rows = list_cached()
    lowered = needle.lower()

    record = load_series(slug_for(needle))
    if record is not None:
        return record_to_series(record)

    by_id = [row for row in rows if str(row.get("index_id") or "").lower() == lowered]
    if by_id:
        record = load_series(by_id[0]["slug"])
        return record_to_series(record) if record else None

    exact = [row for row in rows if str(row.get("name") or "") == needle]
    if exact:
        record = load_series(exact[0]["slug"])
        return record_to_series(record) if record else None

    partial = [
        row
        for row in rows
        if lowered in str(row.get("name") or "").lower()
        or lowered in str(row.get("index_id") or "").lower()
    ]
    if not partial:
        return None
    if len(partial) > 1:
        candidates = ", ".join(
            f"{row.get('name')} [{row.get('index_id') or row.get('slug')}]" for row in partial
        )
        raise ValueError(f"query {needle!r} matches {len(partial)} cached series: {candidates}")
    record = load_series(partial[0]["slug"])
    return record_to_series(record) if record else None


# ---------------------------------------------------------------------------
# Publication lag
# ---------------------------------------------------------------------------


def lag_days_for(freq: str | None, override: int | Mapping[str, int] | None = None) -> int:
    """How many days after a period ends its reading becomes public.

    Args:
        freq: iFinD frequency code (``M``/``Q``/``Y``/``W``/``D``), possibly
            ``None`` when the reply carried no label.
        override: Either a single day count applied to every frequency, or a
            ``{freq: days}`` mapping for targeted overrides.

    Returns:
        A non-negative day count.
    """
    if isinstance(override, int):
        return max(0, override)
    code = str(freq or "").strip().upper()[:1]
    if isinstance(override, Mapping):
        for key, value in override.items():
            if str(key).strip().upper()[:1] == code and isinstance(value, int):
                return max(0, value)
    return _DEFAULT_LAG_DAYS_BY_FREQ.get(code, _UNKNOWN_FREQ_LAG_DAYS)


def _staleness_allowance(freq: str | None) -> dt.timedelta:
    """How long a vote may be carried forward before the series abstains.

    Measured from the availability stamp, not the period end, and deliberately
    independent of the publication lag: a reader holding the print is already
    ``lag`` days behind the data and no rule can fix that. What must be bounded
    is the *extra* carry — once two more reporting periods pass without a new
    print, the indicator has stopped publishing, and its last vote should leave
    the denominator rather than keep voting on last year's news.
    """
    code = str(freq or "").strip().upper()[:1]
    period = _PERIOD_DAYS_BY_FREQ.get(code, _UNKNOWN_FREQ_PERIOD_DAYS)
    return dt.timedelta(days=_STALE_PERIOD_MULTIPLIER * period)


# ---------------------------------------------------------------------------
# Per-indicator vote
# ---------------------------------------------------------------------------


def _clean_level(series: MacroSeries) -> pd.Series:
    """Return one indicator's observations as an ascending float series.

    Gaps (``None`` in :class:`MacroSeries.values`) are dropped rather than
    filled: a China Jan+Feb combined print means there is no January reading to
    invent, and the next difference simply spans the combined period.
    """
    idx = pd.to_datetime(pd.Index(series.dates), errors="coerce")
    level = pd.Series(series.values, index=idx, dtype="float64", name=series.name)
    level = level[level.index.notna()]
    level = level[~level.index.duplicated(keep="last")].sort_index()
    return level.dropna()


def series_vote(
    series: MacroSeries,
    *,
    diff_window: int = DEFAULT_DIFF_WINDOW,
    smoothing: int = DEFAULT_VOTE_SMOOTHING,
    min_periods: int = DEFAULT_MIN_PERIODS,
    lag_days: int | Mapping[str, int] | None = None,
) -> pd.DataFrame:
    """Turn one indicator into a period-by-period direction vote.

    Args:
        series: Decoded indicator, ascending dates guaranteed by the decoder.
        diff_window: How many *surviving* observations apart the first
            difference is taken. One skips a missing period rather than
            comparing across an invented one.
        smoothing: Trailing mean length on the difference. Trailing, never
            centered — a centered window here reads the next print.
        min_periods: Minimum surviving observations before the series votes.
        lag_days: Publication-lag override, see :func:`lag_days_for`.

    Returns:
        Frame indexed by period end with columns ``value`` (the reading),
        ``delta`` (raw first difference), ``momentum`` (smoothed difference),
        ``vote`` (+1/0/-1, ``NaN`` until the series starts voting) and
        ``usable_from`` (the date the reading became public). Empty when the
        series cannot vote at all.
    """
    level = _clean_level(series)
    if level.empty:
        return pd.DataFrame(columns=["value", "delta", "momentum", "vote", "usable_from"])
    lag = lag_days_for(series.freq, lag_days)

    # First difference, not a return: a year-over-year print crosses zero
    # (-0.6 -> 1.0 is an acceleration) and dividing by a negative base flips
    # the sign of the result. ``macro_series`` pins that arithmetic down.
    delta = level - level.shift(max(1, int(diff_window)))
    momentum = delta.rolling(max(1, int(smoothing)), min_periods=1).mean()
    vote = np.sign(momentum).astype("float64")
    # Warm-up as a per-row gate, not an all-or-nothing switch: a series starts
    # voting once it has ``min_periods`` surviving observations, so the earliest
    # rows abstain instead of a short history voting on two points.
    warm = pd.Series(np.arange(1, len(level) + 1), index=level.index, dtype="float64")
    vote = vote.where(warm >= max(1, int(min_periods)))

    out = pd.DataFrame(
        {
            "value": level,
            "delta": delta,
            "momentum": momentum,
            "vote": vote,
        }
    )
    out["usable_from"] = out.index + pd.Timedelta(days=lag)
    out.attrs["lag_days"] = lag
    out.attrs["index_id"] = series.index_id or ""
    out.attrs["unit"] = series.unit or ""
    # Carried by the frame, not re-derived by the caller: the staleness rule in
    # breadth_from_votes needs the reporting period, and a series that lost its
    # freq label during decoding must not silently borrow another series' tolerance.
    out.attrs["freq"] = series.freq or ""
    return out


# ---------------------------------------------------------------------------
# Breadth
# ---------------------------------------------------------------------------


def _naive_utc(moment: dt.datetime) -> pd.Timestamp:
    """Project any caller's moment onto the timeline's own clock.

    Availability stamps are naive UTC day boundaries, so comparing them against
    a tz-aware timestamp raises outright in pandas. Accepting both spellings is
    the tool layer's job: an agent passes ``datetime.now(timezone.utc)``, a
    backtest passes a naive bar timestamp.

    Args:
        moment: A naive or tz-aware datetime.

    Returns:
        Tz-naive :class:`pandas.Timestamp` in UTC. A naive input is taken at its
        face value as UTC rather than shifted — guessing an offset for a
        timestamp that declares none would invent a boundary nobody set.
    """
    stamp = pd.Timestamp(moment)
    if stamp.tzinfo is not None:
        stamp = stamp.tz_convert("UTC").tz_localize(None)
    return stamp


def breadth_from_votes(
    votes: Mapping[str, pd.DataFrame],
    *,
    now: dt.datetime | None = None,
) -> pd.DataFrame:
    """As-of-join per-indicator votes onto one availability-dated grid.

    Each row is a date on which *some* reading became public, not a calendar
    period, so the grid is deliberately uneven: a quarterly print creates a row
    where the monthly series merely carry their last vote forward. A vote is
    carried only until :func:`_staleness_allowance` expires, after which that
    indicator leaves the denominator instead of voting on stale news — that
    distinction is why breadth can move when a series stops publishing.

    Args:
        votes: ``{indicator label: series_vote() frame}``. Frames that are empty
            (the series never accumulated enough history) are skipped.
        now: Optional cut-off; availability stamps after it are ignored. Passed
            by callers reproducing a historical view. Naive input is read as
            UTC; aware input is converted to UTC before comparison.

    Returns:
        Frame indexed by availability date with one float column per indicator
        (``NaN`` where that indicator has no live vote) plus ``breadth`` (mean
        over the live votes, ``NaN`` when none are live) and ``n_voting``.
    """
    live: dict[str, tuple[pd.DatetimeIndex, np.ndarray]] = {}
    allowances = {
        name: _staleness_allowance(str(frame.attrs.get("freq") or ""))
        for name, frame in votes.items()
    }
    for name, frame in votes.items():
        if frame is None or frame.empty or "vote" not in frame:
            continue
        living = frame[frame["vote"].notna()]
        if living.empty:
            continue
        # Indexed by ``usable_from``, never by the period the reading describes:
        # joining on the period end would hand every consumer the reading
        # ``lag`` days before anyone could have published it, silently undoing
        # the only thing the availability timeline exists for.
        stamps = pd.DatetimeIndex(living["usable_from"])
        values = living["vote"].to_numpy(dtype="float64")
        order = np.argsort(stamps.values)
        live[name] = (stamps[order], values[order])

    columns = sorted(live)
    if not columns:
        return pd.DataFrame(index=pd.DatetimeIndex([]), columns=["breadth", "n_voting"])

    grid = sorted({stamp for name in columns for stamp in live[name][0]})
    if now is not None:
        cutoff = _naive_utc(now)
        grid = [stamp for stamp in grid if stamp <= cutoff]
    if not grid:
        return pd.DataFrame(index=pd.DatetimeIndex([]), columns=["breadth", "n_voting"])

    rows: dict[str, list[float | None]] = {name: [] for name in columns}
    for stamp in grid:
        for name in columns:
            stamps, values = live[name]
            pos = stamps.searchsorted(stamp, side="right") - 1
            if pos < 0 or (stamp - stamps[pos]) > allowances[name]:
                rows[name].append(None)
            else:
                rows[name].append(float(values[pos]))

    out = pd.DataFrame(rows, index=pd.DatetimeIndex(grid))
    matrix = out.to_numpy(dtype="float64")
    with np.errstate(invalid="ignore"):
        counts = np.count_nonzero(~np.isnan(matrix), axis=1)
        totals = np.nansum(matrix, axis=1)
    out["breadth"] = [None if count == 0 else total / count for total, count in zip(totals, counts)]
    out["n_voting"] = counts
    return out


# ---------------------------------------------------------------------------
# State machine
# ---------------------------------------------------------------------------


def detect_macro_regimes(
    breadth: pd.Series,
    *,
    smoothing: int = DEFAULT_BREADTH_SMOOTHING,
    enter_threshold: float = DEFAULT_ENTER_THRESHOLD,
    exit_threshold: float = DEFAULT_EXIT_THRESHOLD,
) -> pd.DataFrame:
    """Two-sided hysteresis on smoothed breadth: EXPANSION / NEUTRAL / CONTRACTION.

    The state machine is strictly sequential over an ascending index, so each
    row's label depends only on rows before it. A collapse straight through
    neutral is labelled in the same row rather than one row late: leaving one
    extreme re-tests the opposite entry condition immediately.

    Args:
        breadth: Breadth series indexed by ascending availability date.
        smoothing: Trailing mean length (rows, causal, never centered).
        enter_threshold: Smoothed breadth needed to open an extreme regime.
        exit_threshold: |breadth| below which an open regime releases.

    Returns:
        Frame with ``breadth``, ``smoothed`` and ``state`` (1/0/-1).

    Raises:
        ValueError: When the thresholds are not ordered, or enter is not
            positive (an enter of zero would label every row an extreme).
    """
    if exit_threshold >= enter_threshold:
        raise ValueError("exit_threshold must be below enter_threshold")
    if enter_threshold <= 0 or enter_threshold > 1:
        raise ValueError("enter_threshold must lie in (0, 1]")

    frame = breadth.astype("float64")
    if not frame.index.is_monotonic_increasing:
        # Feeding a descending index here would run the state machine
        # backwards through time and label every row from its own future.
        frame = frame.sort_index()
    smoothed = frame.rolling(max(1, int(smoothing)), min_periods=1).mean()

    state = 0
    states = np.zeros(len(smoothed), dtype=int)
    for i, value in enumerate(smoothed.to_numpy()):
        if np.isnan(value):
            states[i] = state
            continue
        if state == 0:
            if value >= enter_threshold:
                state = 1
            elif value <= -enter_threshold:
                state = -1
        else:
            turned = (state == 1 and value <= exit_threshold) or (state == -1 and value >= -exit_threshold)
            if turned:
                state = 0
                if value >= enter_threshold:  # straight through to the other side
                    state = 1
                elif value <= -enter_threshold:
                    state = -1
        states[i] = state

    out = pd.DataFrame({"breadth": frame, "smoothed": smoothed, "state": states})
    out["label"] = [_STATE_LABELS[int(code)] for code in states]
    return out


# ---------------------------------------------------------------------------
# Timeline
# ---------------------------------------------------------------------------


def _state_episodes(dates: Sequence[str], states: Sequence[int]) -> list[dict[str, Any]]:
    """Contiguous runs of one non-neutral label within the window.

    ``end`` is the last availability date seen in the regime, or ``None`` while
    the final row is still inside it.
    """
    episodes: list[dict[str, Any]] = []
    start: str | None = None
    current = 0
    last: str | None = None
    for date, code in zip(dates, states):
        if code == 0:
            if start is not None:
                episodes.append({"label": _STATE_LABELS[current], "start": start, "end": last})
                start = None
            current = 0
            continue
        if start is None or code != current:
            if start is not None:
                episodes.append({"label": _STATE_LABELS[current], "start": start, "end": last})
            start, current = date, code
        last = date
    if start is not None:
        # The run still open reached the final row, so its end is genuinely
        # unknown: claiming the last date would say "it stopped there".
        episodes.append({"label": _STATE_LABELS[current], "start": start, "end": None})
    return episodes


def _rounded(value: Any) -> float | None:
    """Round for transport, mapping every non-finite reading to ``None``."""
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    if not np.isfinite(number):
        return None
    return round(number, 4)


def compute_macro_regime(
    series: Sequence[MacroSeries],
    *,
    diff_window: int = DEFAULT_DIFF_WINDOW,
    vote_smoothing: int = DEFAULT_VOTE_SMOOTHING,
    min_periods: int = DEFAULT_MIN_PERIODS,
    breadth_smoothing: int = DEFAULT_BREADTH_SMOOTHING,
    enter_threshold: float = DEFAULT_ENTER_THRESHOLD,
    exit_threshold: float = DEFAULT_EXIT_THRESHOLD,
    lag_days: int | Mapping[str, int] | None = None,
    now: dt.datetime | None = None,
) -> dict[str, Any]:
    """Build the macro-regime timeline from decoded indicator series.

    Pure function over data already in hand — it never fetches. Callers pass
    :func:`load_macro_series` results (or decoded replies); quota defence lives
    in the cache, not here.

    Args:
        series: The indicator set forming the gauge. One series is allowed and
            warned about; order does not matter.
        diff_window: Periods apart for each series' first difference.
        vote_smoothing: Trailing rows smoothed before a series' sign is read.
        min_periods: Surviving observations required before a series votes.
        breadth_smoothing: Trailing grid rows smoothed before the trigger runs.
        enter_threshold: Smoothed breadth that opens an extreme regime.
        exit_threshold: Magnitude that releases it (must be below ``enter``).
        lag_days: Publication-lag override, see :func:`lag_days_for`.
        now: Availability cut-off for reproducing a historical view.

    Returns:
        Dict with ``dates`` (availability stamps, ascending), ``breadth``,
        ``smoothed``, ``states`` (1/0/-1), ``labels``, ``indicators`` (per-series
        provenance and whether it actually voted), ``current``, ``episodes``,
        ``params`` and ``warnings``. Non-finite scalars become ``None`` so the
        result is safe for strict (``allow_nan=False``) JSON.

    Raises:
        ValueError: When no series is supplied, or the thresholds are misordered.
    """
    items = [item for item in (series or []) if isinstance(item, MacroSeries)]
    if not items:
        raise ValueError("compute_macro_regime needs at least one MacroSeries")

    warnings: list[str] = []
    votes: dict[str, pd.DataFrame] = {}
    indicators: list[dict[str, Any]] = []
    for item in items:
        frame = series_vote(
            item,
            diff_window=diff_window,
            smoothing=vote_smoothing,
            min_periods=min_periods,
            lag_days=lag_days,
        )
        key = item.name or item.index_id or f"unnamed_{len(votes)}"
        if key in votes:
            # Two indicators sharing a label would otherwise silently merge into
            # one vote column and understate the gauge's depth.
            key = f"{key}#{item.index_id or len(votes)}"
        if not frame.empty:
            votes[key] = frame
        lag = lag_days_for(item.freq, lag_days)
        points = len(_clean_level(item))
        voted = not frame.empty and bool(np.isfinite(frame["vote"].to_numpy(dtype="float64")).any())
        if not voted:
            warnings.append(
                f"{key}: fewer than {min_periods} usable observations "
                f"({points} found) — abstains from the gauge"
            )
        indicators.append(
            {
                "name": key,
                "index_id": item.index_id,
                "freq": item.freq,
                "unit": item.unit,
                "data_source": item.data_source,
                "points": points,
                "lag_days": lag,
                "votes": voted,
            }
        )

    active = sum(1 for row in indicators if row["votes"])
    if active < _MIN_BREADTH_DEPTH:
        warnings.append(
            f"breadth rests on {active} voting indicator(s); below {_MIN_BREADTH_DEPTH} "
            "the gauge is a coin flip, not a consensus"
        )

    joined = breadth_from_votes(votes, now=now)
    if joined.empty:
        return {
            "dates": [],
            "breadth": [],
            "smoothed": [],
            "states": [],
            "labels": [],
            "indicators": indicators,
            "current": None,
            "episodes": [],
            "params": _params(diff_window, vote_smoothing, min_periods, breadth_smoothing,
                              enter_threshold, exit_threshold),
            "warnings": warnings + ["no indicator produced a vote, so no regime is computable"],
        }

    detected = detect_macro_regimes(
        joined["breadth"],
        smoothing=breadth_smoothing,
        enter_threshold=enter_threshold,
        exit_threshold=exit_threshold,
    )
    # ``n_voting`` is the honest denominator: a row built from one live vote and
    # one built from six both read +/-1.0, and only this column says which.
    detected = detected.join(joined[["n_voting"]])
    dates = [stamp.strftime("%Y-%m-%d") for stamp in detected.index]
    states = [int(code) for code in detected["state"]]
    labels = [_STATE_LABELS[code] for code in states]
    return {
        "dates": dates,
        "breadth": [_rounded(value) for value in detected["breadth"]],
        "smoothed": [_rounded(value) for value in detected["smoothed"]],
        "states": states,
        "labels": labels,
        "n_voting": [int(value) for value in detected["n_voting"]],
        "indicators": indicators,
        "current": (
            {"date": dates[-1], "label": labels[-1], "breadth": _rounded(detected["breadth"].iloc[-1])}
            if dates
            else None
        ),
        "episodes": _state_episodes(dates, states),
        "params": _params(
            diff_window, vote_smoothing, min_periods, breadth_smoothing,
            enter_threshold, exit_threshold,
        ),
        "warnings": warnings,
    }


def _params(
    diff_window: int,
    vote_smoothing: int,
    min_periods: int,
    breadth_smoothing: int,
    enter_threshold: float,
    exit_threshold: float,
) -> dict[str, Any]:
    """Echo every knob that shaped the timeline, including the hidden ones."""
    return {
        "diff_window": diff_window,
        "vote_smoothing": vote_smoothing,
        "min_periods": min_periods,
        "breadth_smoothing": breadth_smoothing,
        "enter_threshold": enter_threshold,
        "exit_threshold": exit_threshold,
        "index_meaning": "availability date (period end + publication lag)",
    }


def regime_on_date(result: Mapping[str, Any], date: str | dt.date | dt.datetime) -> str | None:
    """The label a viewer standing on ``date`` could hold.

    Binary search over availability stamps, so a caller joining daily prices
    onto this timeline asks "what was knowable on 2026-05-06" and gets the most
    recent regime whose reading had already been published. Returns ``None``
    before the first one, which is the correct answer rather than a fabricated
    ``NEUTRAL``.
    """
    dates = result.get("dates") if isinstance(result, Mapping) else None
    labels = result.get("labels") if isinstance(result, Mapping) else None
    if not dates or not labels:
        return None
    if isinstance(date, dt.datetime) and date.tzinfo is not None:
        # ``str()`` would print the local calendar day and ask about the wrong
        # date when the viewer stands in a non-UTC zone.
        stamp = date.astimezone(dt.timezone.utc).strftime("%Y-%m-%d")
    else:
        stamp = str(date)[:10]
    pos = bisect.bisect_right(list(dates), stamp) - 1
    if pos < 0:
        return None
    return str(labels[pos])


def _column(result: Mapping[str, Any], key: str, size: int) -> list[Any]:
    """Take one timeline column, padded or trimmed to the dates' length.

    A hand-assembled or truncated dict must not make pandas raise on ragged
    columns; the timeline is a plain transport record, so a short column reads
    as missing cells rather than an error.
    """
    values = list(result.get(key) or [])
    if len(values) < size:
        values = values + [None] * (size - len(values))
    return values[:size]


def regime_frame(result: Mapping[str, Any]) -> pd.DataFrame:
    """Materialise a timeline dict as a ``DatetimeIndex`` frame for joins.

    Returns:
        Frame indexed by availability date with ``breadth``, ``smoothed``,
        ``state``, ``label`` and ``n_voting``. Empty (with those columns) when
        the dict carries no rows.
    """
    columns = ["breadth", "smoothed", "state", "label", "n_voting"]
    dates = result.get("dates") if isinstance(result, Mapping) else None
    if not dates:
        return pd.DataFrame({column: pd.Series(dtype="object") for column in columns})
    size = len(dates)
    out = pd.DataFrame(
        {
            "breadth": _column(result, "breadth", size),
            "smoothed": _column(result, "smoothed", size),
            "state": _column(result, "states", size),
            "label": _column(result, "labels", size),
            "n_voting": _column(result, "n_voting", size),
        },
        index=pd.to_datetime(pd.Index([str(item)[:10] for item in dates])),
    )
    out.index.name = "usable_from"
    return out.sort_index()


def cached_series_names() -> list[str]:
    """Names of every cached indicator, for building a gauge interactively."""
    return [str(row.get("name") or row.get("slug") or "") for row in list_cached()]
