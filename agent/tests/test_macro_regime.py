"""Tests for :mod:`backtest.macro_regime` (sign breadth + causal hysteresis).

The module's whole claim is that a macro label carries no information the
reader did not have on that date. That claim is not testable by inspecting one
final row — a centered smoother, a ``shift(-1)``, or a state machine run over a
descending index all produce a plausible-looking tail. So the load-bearing test
here is prefix invariance: truncating the inputs must never re-label a date
that was already on the timeline. Everything else (lags, staleness expiry,
sign-vs-return, unit indifference) supports that claim.
"""

from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

import pandas as pd
import pytest

from backtest.macro_regime import (
    CONTRACTION,
    EXPANSION,
    NEUTRAL,
    breadth_from_votes,
    compute_macro_regime,
    detect_macro_regimes,
    lag_days_for,
    load_macro_series,
    regime_frame,
    regime_on_date,
    series_vote,
)
from backtest.macro_series import MacroSeries, extract_series, save_series

FIXTURES = Path(__file__).parent / "fixtures" / "ifind"

MONTH_LAG = 18  # mirrors _DEFAULT_LAG_DAYS_BY_FREQ["M"]; asserted, not trusted


def _month_stamps(start: str, count: int) -> list[str]:
    """Count month-end stamps beginning at ``start``'s month."""
    stamp = pd.Timestamp(start)
    out: list[str] = []
    for _ in range(count):
        out.append((stamp + pd.offsets.MonthEnd(0)).strftime("%Y-%m-%d"))
        stamp = stamp + pd.offsets.MonthBegin(1)
    return out


def _series(
    name: str,
    values: list[float | None],
    *,
    start: str = "2025-01-31",
    freq: str = "M",
    unit: str = "%",
    index_id: str | None = None,
) -> MacroSeries:
    """A monthly-shaped indicator with the given readings."""
    return MacroSeries(
        name=name,
        dates=_month_stamps(start, len(values)),
        values=list(values),
        freq=freq,
        unit=unit,
        index_id=index_id or f"ID_{name}",
    )


def _prefix(series: MacroSeries, keep: int) -> MacroSeries:
    """The series as it would have looked with only its first ``keep`` prints."""
    return MacroSeries(
        name=series.name,
        dates=series.dates[:keep],
        values=series.values[:keep],
        freq=series.freq,
        unit=series.unit,
        index_id=series.index_id,
    )


def _gauge() -> list[MacroSeries]:
    """Mixed frequency and mixed sign, including one V-shaped series.

    The V matters: monotone indicators hide a centered smoother, because the
    mean of same-sign differences has the same sign whichever way the window
    looks. A turn is the only input that can tell "trailing" from "centered".
    """
    return [
        _series("零售:同比", [4.0, 4.2, 4.5, 4.9, 5.4, 6.0, 6.7, 7.5], index_id="M01"),
        _series("工业:同比", [1.0, 1.4, 1.9, 2.5, 3.2, 3.8, 4.1, 4.6], index_id="M02"),
        _series("信贷:同比", [8.0, 8.3, 8.8, 9.4, 9.9, 10.5, 11.2, 11.9], index_id="M03"),
        _series("投资:累计同比", [5.0, 4.0, 3.0, 2.0, 3.0, 4.0, 5.0, 6.0], index_id="M04"),
        _series(
            "出口:累计同比",
            [9.0, 8.0, 7.0, 6.0],
            start="2025-03-31",
            freq="Q",
            index_id="Q01",
        ),
    ]


def _real_series() -> MacroSeries:
    """The verbatim captured retail-sales reply, decoded."""
    payload = json.loads((FIXTURES / "edb_standard_table.json").read_text(encoding="utf-8"))
    return extract_series(payload)[0]


# ---------------------------------------------------------------------------
# Publication lag: the timeline is keyed by when a reading was knowable
# ---------------------------------------------------------------------------


def test_monthly_reading_is_dated_by_availability_not_by_its_period() -> None:
    """``2026-06-30`` data must not be usable on ``2026-06-30``."""
    series = _series("x", [1.0, 1.2, 1.5, 1.9, 2.4])
    frame = series_vote(series)
    assert frame.index[-1] == pd.Timestamp("2025-05-31")
    assert frame["usable_from"].iloc[-1] == pd.Timestamp("2025-05-31") + pd.Timedelta(days=MONTH_LAG)
    assert frame.attrs["lag_days"] == MONTH_LAG


def test_lag_defaults_follow_frequency() -> None:
    """A daily series is next-day public; a quarterly one is six weeks out."""
    assert lag_days_for("D") == 1
    assert lag_days_for("M") == MONTH_LAG
    assert lag_days_for("Q") == 45
    assert lag_days_for(None) == MONTH_LAG  # unlabelled falls back to monthly
    assert lag_days_for("m") == MONTH_LAG  # case-insensitive code
    assert lag_days_for("M", 0) == 0  # a caller may override
    assert lag_days_for("M", {"Q": 9}) == MONTH_LAG


def test_regime_on_date_is_unanswered_before_the_first_print() -> None:
    """Asking about an undelivered month returns None, not a fabricated NEUTRAL."""
    result = compute_macro_regime(_gauge())
    first = result["dates"][0]
    assert regime_on_date(result, "2024-01-01") is None
    assert regime_on_date(result, first) == result["labels"][0]


def test_a_period_end_still_sees_the_previous_periods_regime() -> None:
    """On the last day of the turning month, the turn is not public yet.

    This is the leak every macro-backtest inherits: joining a month-end stamp
    onto that same month-end's price bar hands the strategy ~2-3 weeks of
    future information. The whole gauge here turns on one print, so the pair of
    assertions below is exact rather than illustrative.
    """
    turning = _series(
        "a",
        [1.0, 1.2, 1.5, 1.9, 2.4, 3.0, 2.5, 1.8],  # rises to 2025-06-30, falls after
    )
    result = compute_macro_regime([turning], min_periods=2, vote_smoothing=1, breadth_smoothing=1)
    # 2025-07-31 is the first falling print; it is public from 2025-08-18.
    assert regime_on_date(result, "2025-07-31") == EXPANSION
    assert regime_on_date(result, "2025-08-17") == EXPANSION
    assert regime_on_date(result, "2025-08-18") == CONTRACTION


# ---------------------------------------------------------------------------
# Causality
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("keep", [5, 6, 7, 8])
def test_no_row_is_relabelled_by_data_that_arrived_later(keep: int) -> None:
    """Prefix invariance: the module may not read past the row it labels.

    A centered window, a forward shift, or a state machine that peeks at the
    series' final direction all break this, and none of them are visible in a
    single tail row.
    """
    full = compute_macro_regime(_gauge())
    partial = compute_macro_regime([_prefix(item, keep) for item in _gauge()])
    known = dict(zip(full["dates"], full["labels"]))
    assert partial["dates"], "the truncated gauge should still vote"
    for date, label in zip(partial["dates"], partial["labels"]):
        assert known[date] == label, f"{date} was re-labelled by later data"


def test_vote_smoothing_is_trailing_so_a_turn_lands_one_row_late() -> None:
    """Hand-computed: a 3-row trailing mean flips its sign one period after the turn.

    The V's deltas are ``NaN,-1,-1,-1,+1,+1,+1,+1`` (April is the low, May is the
    first rising print). The trailing 3-row mean is therefore ``-1`` on
    2025-04-30, ``-1/3`` on 2025-05-31 and ``+1/3`` on 2025-06-30: the vote
    turns up a full period after the turn. ``center=True`` instead averages
    ``{-1,+1,+1}`` for May, calling the turn from June's number — and no
    monotone series can reveal the difference, which is why this gauge turns.
    """
    valley = _series("v", [5.0, 4.0, 3.0, 2.0, 3.0, 4.0, 5.0, 6.0])
    frame = series_vote(valley, smoothing=3, min_periods=2)
    assert frame.loc[pd.Timestamp("2025-04-30"), "momentum"] == pytest.approx(-1.0)
    assert frame.loc[pd.Timestamp("2025-05-31"), "momentum"] == pytest.approx(-1 / 3)
    assert frame.loc[pd.Timestamp("2025-05-31"), "vote"] == -1.0
    assert frame.loc[pd.Timestamp("2025-06-30"), "momentum"] == pytest.approx(1 / 3)
    assert frame.loc[pd.Timestamp("2025-06-30"), "vote"] == 1.0


def test_timeline_starts_where_the_first_vote_lands() -> None:
    """Warm-up periods are absent, not labelled: no invented early rows."""
    series = _series("only", [1.0, 1.2, 1.4, 1.7, 2.1, 2.6])
    result = compute_macro_regime([series], min_periods=4)
    # Prints 1-3 cannot vote (min_periods=4), so the gauge opens on print 4 --
    # and that row is dated by when print 4 was published, not by its period.
    assert result["dates"][0] == "2025-05-18"  # 2025-04-30 + 18 days
    assert len(result["dates"]) == 3


def test_descending_input_is_ordered_before_the_state_machine_runs() -> None:
    """A reversed index would walk the trigger backwards through time."""
    ascending = pd.Series(
        [0.7, 0.75, 0.8, -0.9, -0.95],
        index=pd.to_datetime(["2025-01-31", "2025-02-28", "2025-03-31", "2025-04-30", "2025-05-31"]),
    )
    kwargs = {"smoothing": 1, "enter_threshold": 0.6, "exit_threshold": 0.2}
    forward = detect_macro_regimes(ascending, **kwargs)
    backward = detect_macro_regimes(ascending.iloc[::-1], **kwargs)
    assert list(forward["state"]) == [1, 1, 1, -1, -1]
    # The output is indexed by ascending date whichever way the input came, so a
    # caller can never get a timeline that runs from the future to the past.
    assert list(backward["state"]) == list(forward["state"])
    assert backward.index.is_monotonic_increasing


def test_missing_period_in_the_history_reproduces_the_same_label() -> None:
    """China's combined Jan+Feb print leaves no February row; the gap is not a 0."""
    stamps = _month_stamps("2025-01-31", 8)
    with_gap = _series("a", [3.0, 3.2, None, 3.6, 3.9, 4.2, 4.6, 5.0])
    without_gap = _series("a", [3.0, 3.2, 3.6, 3.9, 4.2, 4.6, 5.0])
    gapped = compute_macro_regime([with_gap], min_periods=2, vote_smoothing=1, breadth_smoothing=1)
    plain = compute_macro_regime([without_gap], min_periods=2, vote_smoothing=1, breadth_smoothing=1)
    assert gapped["labels"] == plain["labels"] == [EXPANSION] * len(plain["labels"])
    # The hole produces no row and no invented date: every gapped stamp is the
    # availability date of one of the seven surviving periods, never of March.
    march = pd.Timestamp(stamps[2]) + pd.Timedelta(days=MONTH_LAG)
    assert march.strftime("%Y-%m-%d") not in gapped["dates"]
    assert gapped["dates"] == [
        (pd.Timestamp(date) + pd.Timedelta(days=MONTH_LAG)).strftime("%Y-%m-%d")
        for i, date in enumerate(stamps)
        if i != 2
    ][1:]  # [1:] because the first observation cannot differ from anything


# ---------------------------------------------------------------------------
# What a vote is
# ---------------------------------------------------------------------------


def test_vote_is_the_sign_of_a_difference() -> None:
    """Rising readings vote +1, falling votes -1, unchanged votes 0."""
    up = series_vote(_series("up", [1.0, 2.0, 3.0, 4.0, 5.0]))
    down = series_vote(_series("down", [5.0, 4.0, 3.0, 2.0, 1.0]))
    assert up["vote"].iloc[-1] == 1.0
    assert down["vote"].iloc[-1] == -1.0
    flat = series_vote(_series("flat", [3.0, 3.0, 3.0, 3.0, 3.0]))
    assert set(flat["vote"].dropna().unique()) == {0.0}


def test_a_sign_crossing_print_votes_on_the_difference_not_the_return() -> None:
    """``-0.6 -> 1.0`` is an acceleration; dividing by the negative base says otherwise.

    ``macro_series`` documents the arithmetic (-2.67 for a rising reading); this
    pins the consequence: the vote goes up.
    """
    series = _real_series()
    # smoothing=1 isolates the single step; the default 3-row smoother would
    # average this +1.6 over two preceding declines and read the tail as
    # decelerating, which is a different (also defensible) question.
    frame = series_vote(series, smoothing=1)
    assert series.dates[-1] == "2026-06-30"
    assert series.values[-2] == pytest.approx(-0.6)  # the negative base
    assert series.values[-1] == pytest.approx(1.0)  # the rise
    assert frame.loc[pd.Timestamp("2026-06-30"), "delta"] == pytest.approx(1.6)
    assert frame["vote"].iloc[-1] == 1.0


def test_a_series_too_short_to_differ_abstains_and_says_so() -> None:
    """Two points give a direction but no confidence; the gauge drops them."""
    thin = _series("thin", [1.0, 2.0])
    result = compute_macro_regime([thin])
    assert result["dates"] == []
    assert result["indicators"][0]["votes"] is False
    assert any("abstains" in note for note in result["warnings"])


def test_unit_scale_cannot_change_a_label() -> None:
    """Sign votes are why a ``%`` series and a ``亿元`` series may share a gauge.

    Scaling one indicator by 1e8 is exactly the kind of unit mismatch a
    normalising aggregator would have to survive; here it is a no-op.
    """
    small = [
        _series("a", [1.0, 1.2, 1.5, 1.9, 2.4, 3.0], unit="%"),
        _series("b", [2.0, 2.1, 2.3, 2.6, 3.0, 3.5], unit="%"),
        _series("c", [9.0, 9.1, 9.3, 9.6, 10.0, 10.5], unit="%"),
    ]
    large = [
        MacroSeries(
            name=item.name,
            dates=list(item.dates),
            values=[None if value is None else value * 1e8 for value in item.values],
            freq=item.freq,
            unit="元",
            index_id=item.index_id,
        )
        for item in small
    ]
    assert compute_macro_regime(small)["labels"] == compute_macro_regime(large)["labels"]


def test_duplicate_labels_keep_separate_votes() -> None:
    """Two indicators sharing a name must not collapse into one column."""
    twin_a = _series("同名指标", [1.0, 2.0, 3.0, 4.0, 5.0], index_id="AAA")
    twin_b = _series("同名指标", [5.0, 4.0, 3.0, 2.0, 1.0], index_id="BBB")
    result = compute_macro_regime([twin_a, twin_b])
    names = [row["name"] for row in result["indicators"]]
    assert len(names) == 2
    assert len(set(names)) == 2
    assert max(result["n_voting"]) == 2


# ---------------------------------------------------------------------------
# Breadth and its denominator
# ---------------------------------------------------------------------------


def test_breadth_is_the_mean_of_live_votes() -> None:
    """Two up, one down: 1/3, not 1."""
    votes = {
        "a": series_vote(_series("a", [1.0, 2.0, 3.0, 4.0, 5.0])),
        "b": series_vote(_series("b", [1.0, 2.0, 3.0, 4.0, 5.0])),
        "c": series_vote(_series("c", [5.0, 4.0, 3.0, 2.0, 1.0])),
    }
    joined = breadth_from_votes(votes)
    assert joined["breadth"].iloc[-1] == pytest.approx(1 / 3)
    assert joined["n_voting"].iloc[-1] == 3


def test_a_silent_indicator_leaves_the_denominator_and_moves_the_regime() -> None:
    """The gauge can flip with no new news about the series that kept voting.

    ``b`` stops after three prints while voting against ``a``. While both are
    live the gauge is a 0.0 tie (NEUTRAL); once ``b``'s vote expires the same
    unchanged ``a`` reads as full agreement. A forward-fill with no expiry
    would sit at NEUTRAL forever and hide that its own input went stale.
    """
    a = _series("a", [1.0, 1.2, 1.5, 1.9, 2.4, 3.0, 3.7, 4.5])
    b = _series("b", [9.0, 8.0, 7.0, 6.0])
    result = compute_macro_regime([a, b])
    assert min(result["n_voting"]) == 1
    assert max(result["n_voting"]) == 2
    tied = [label for count, label in zip(result["n_voting"], result["labels"]) if count == 2]
    assert set(tied) == {NEUTRAL}
    assert result["labels"][-1] == EXPANSION


def test_a_shallow_gauge_is_called_shallow() -> None:
    """One indicator's +/-1 breadth is a coin flip, and the result says so."""
    one = compute_macro_regime([_series("a", [1.0, 2.0, 3.0, 4.0, 5.0])])
    assert any("coin flip" in note for note in one["warnings"])
    three = compute_macro_regime(_gauge())
    assert not any("coin flip" in note for note in three["warnings"])


def test_no_votes_at_all_yields_an_empty_timeline_with_a_reason() -> None:
    result = compute_macro_regime([_series("a", [1.0, 2.0])])
    assert result["dates"] == []
    assert result["current"] is None
    assert any("no indicator produced a vote" in note for note in result["warnings"])


# ---------------------------------------------------------------------------
# Hysteresis
# ---------------------------------------------------------------------------


def test_breadth_smoothing_is_trailing_and_reports_its_own_values() -> None:
    """An odd window is the only one that can leak, so it is the one pinned here.

    ``center=True`` on a 2-row window is arithmetically identical to a trailing
    one, so a test on the default width could never tell them apart; on 3 rows
    the centered window is shifted a period early. Expected values are read off
    by hand from the sequence below, not copied from the implementation.
    """
    breadth = pd.Series(
        [1.0, -1.0, 1.0, 1.0, 1.0],
        index=pd.to_datetime(
            ["2025-01-31", "2025-02-28", "2025-03-31", "2025-04-30", "2025-05-31"]
        ),
    )
    out = detect_macro_regimes(breadth, smoothing=3, enter_threshold=0.6, exit_threshold=0.2)
    assert list(out["smoothed"].round(2)) == [1.0, 0.0, 0.33, 0.33, 1.0]
    assert list(out["state"]) == [1, 0, 0, 0, 1]
    # Under ``center=True`` the same input smooths to [0, .33, .33, 1, .33], so
    # the regime would open on row 4 -- one period early, on a reading that no
    # one had published yet -- and stay open on row 5 only by keeping it.
    assert list(out["label"]) == [EXPANSION, NEUTRAL, NEUTRAL, NEUTRAL, EXPANSION]


def test_the_dead_band_holds_a_regime_through_a_shave() -> None:
    """A single threshold would chatter between 0.65 and 0.3; hysteresis does not."""
    breadth = pd.Series(
        [0.7, 0.3, 0.65, 0.3],
        index=pd.to_datetime(["2025-01-31", "2025-02-28", "2025-03-31", "2025-04-30"]),
    )
    out = detect_macro_regimes(breadth, smoothing=1, enter_threshold=0.6, exit_threshold=0.2)
    assert list(out["state"]) == [1, 1, 1, 1]
    assert list(out["label"]) == [EXPANSION] * 4
    naive = [1 if value >= 0.6 else 0 for value in breadth]  # what hysteresis replaces
    assert naive != list(out["state"])


def test_a_collapse_straight_through_neutral_is_labelled_immediately() -> None:
    """Leaving one extreme re-tests the other, so a hard flip is not a day late."""
    breadth = pd.Series(
        [0.9, 0.8, -0.9, -0.8],
        index=pd.to_datetime(["2025-01-31", "2025-02-28", "2025-03-31", "2025-04-30"]),
    )
    out = detect_macro_regimes(breadth, smoothing=1, enter_threshold=0.6, exit_threshold=0.2)
    assert list(out["state"]) == [1, 1, -1, -1]


def test_a_missing_breadth_row_keeps_the_last_state() -> None:
    """NaN means "nothing was published", which is not a reason to go neutral."""
    breadth = pd.Series(
        [0.9, float("nan"), 0.9],
        index=pd.to_datetime(["2025-01-31", "2025-02-28", "2025-03-31"]),
    )
    out = detect_macro_regimes(breadth, smoothing=1, enter_threshold=0.6, exit_threshold=0.2)
    assert list(out["state"]) == [1, 1, 1]


def test_thresholds_that_make_the_trigger_meaningless_are_rejected() -> None:
    with pytest.raises(ValueError, match="exit_threshold"):
        detect_macro_regimes(pd.Series([0.5]), enter_threshold=0.2, exit_threshold=0.8)
    with pytest.raises(ValueError, match="enter_threshold"):
        detect_macro_regimes(pd.Series([0.5]), enter_threshold=0.0, exit_threshold=-0.1)
    with pytest.raises(ValueError, match="enter_threshold"):
        detect_macro_regimes(pd.Series([0.5]), enter_threshold=1.5, exit_threshold=0.5)


def test_episodes_report_open_ends_as_none() -> None:
    result = compute_macro_regime(_gauge())
    assert result["episodes"], "the mixed-sign gauge should produce an episode"
    for episode in result["episodes"]:
        assert episode["label"] in {EXPANSION, CONTRACTION}
        assert episode["start"] in result["dates"]
        assert episode["end"] is None or episode["end"] in result["dates"]
    if result["labels"][-1] != NEUTRAL:
        assert result["episodes"][-1]["end"] is None


# ---------------------------------------------------------------------------
# Transport and the cache door
# ---------------------------------------------------------------------------


def test_timeline_is_strict_json_safe() -> None:
    """No NaN may reach the tool envelope: ``allow_nan=False`` would raise.

    A single non-finite float makes ``json.dumps`` blow up, and the failure
    would surface at the MCP boundary, far from the smoothing that produced it.
    """
    result = compute_macro_regime(_gauge())
    json.dumps(result, ensure_ascii=False, allow_nan=False)
    assert set(result["labels"]) <= {EXPANSION, NEUTRAL, CONTRACTION}


def test_regime_frame_round_trips_and_names_its_index() -> None:
    result = compute_macro_regime(_gauge())
    frame = regime_frame(result)
    assert [stamp.strftime("%Y-%m-%d") for stamp in frame.index] == result["dates"]
    assert frame.index.name == "usable_from"
    assert list(frame["label"]) == result["labels"]
    assert frame["state"].iloc[-1] == result["states"][-1]


def test_regime_frame_tolerates_a_ragged_timeline() -> None:
    frame = regime_frame({"dates": ["2025-01-31", "2025-02-28"], "labels": [NEUTRAL]})
    assert len(frame) == 2
    assert frame["label"].tolist() == [NEUTRAL, None]


def test_truncating_history_at_a_date_reproduces_the_label_on_that_date() -> None:
    """``now`` is the historical-view knob, and it must agree with the full run."""
    gauge = _gauge()
    full = compute_macro_regime(gauge)
    cutoff = pd.Timestamp(full["dates"][len(full["dates"]) // 2])
    view = compute_macro_regime(gauge, now=cutoff.to_pydatetime())
    assert view["dates"][-1] == cutoff.strftime("%Y-%m-%d")
    assert view["labels"] == full["labels"][: len(view["labels"])]


def test_an_aware_now_never_admits_a_print_that_was_not_out_yet() -> None:
    """The timeline is naive UTC, but callers are not.

    ``datetime.now(timezone.utc)`` is what a tool layer naturally passes, and
    comparing it against a naive stamp raises in pandas — a crash is loud, but
    the silent version (dropping the conversion and reading the local wall
    clock) would let a viewer in UTC+9 see a print ~9 hours early.
    """
    gauge = _gauge()
    full = compute_macro_regime(gauge)
    last = pd.Timestamp(full["dates"][-1])
    tokyo = dt.timezone(dt.timedelta(hours=9))

    # 23:00 UTC the day before the last print, written in a +09:00 zone: the
    # same instant, and locally it already looks like the print's own day.
    just_before = dt.datetime.combine(
        (last - pd.Timedelta(days=1)).date(), dt.time(23), tzinfo=dt.timezone.utc
    ).astimezone(tokyo)

    view = compute_macro_regime(gauge, now=just_before)
    assert view["dates"][-1] == full["dates"][-2]
    assert view["labels"] == full["labels"][: len(view["labels"])]


def test_naive_and_aware_now_agree_on_the_same_instant() -> None:
    """A naive ``now`` is read as UTC, so both spellings must land identically."""
    gauge = _gauge()
    full = compute_macro_regime(gauge)
    stamp = pd.Timestamp(full["dates"][-1])

    naive = compute_macro_regime(gauge, now=stamp.to_pydatetime().replace(hour=12))
    aware = compute_macro_regime(
        gauge, now=stamp.to_pydatetime().replace(hour=12, tzinfo=dt.timezone.utc)
    )
    assert naive["dates"] == aware["dates"]
    assert naive["labels"] == aware["labels"]


def test_regime_on_date_reads_an_aware_datetime_as_utc() -> None:
    """Morning in Tokyo is still yesterday evening in the timeline's clock."""
    timeline = {"dates": ["2025-06-18", "2025-07-18"], "labels": [NEUTRAL, EXPANSION]}
    tokyo = dt.timezone(dt.timedelta(hours=9))

    # 08:00 JST on 2025-07-18 is 23:00 UTC on 2025-07-17 — before the print.
    assert regime_on_date(timeline, dt.datetime(2025, 7, 18, 8, tzinfo=tokyo)) == NEUTRAL
    assert regime_on_date(timeline, dt.datetime(2025, 7, 18, 8, tzinfo=dt.timezone.utc)) == EXPANSION
    assert regime_on_date(timeline, dt.datetime(2025, 7, 18, 8)) == EXPANSION


def _isolated_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("VIBE_TRADING_HOME", str(tmp_path))


def test_load_macro_series_finds_a_cached_indicator_four_ways(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    _isolated_cache(tmp_path, monkeypatch)
    series = _series("全国:某指标:当月同比", [1.0, 2.0, 3.0, 4.0], index_id="M0000123")
    save_series(series)
    assert load_macro_series("M0000123").name == series.name
    assert load_macro_series(series.name).index_id == "M0000123"
    assert load_macro_series("某指标").index_id == "M0000123"  # unique substring
    assert load_macro_series("m0000123").index_id == "M0000123"  # case-insensitive
    assert load_macro_series("从未缓存") is None
    assert load_macro_series("   ") is None


def test_an_ambiguous_query_lists_the_candidates(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """Silently picking one of two matches would build a gauge from a guess."""
    _isolated_cache(tmp_path, monkeypatch)
    save_series(_series("工业:同比", [1.0, 2.0, 3.0, 4.0], index_id="A1"))
    save_series(_series("工业:环比", [1.0, 2.0, 3.0, 4.0], index_id="A2"))
    with pytest.raises(ValueError) as exc:
        load_macro_series("工业")
    message = str(exc.value)
    assert "工业:同比" in message and "工业:环比" in message


def test_a_cached_gauge_computes_without_any_network(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The documented contract: regime math reads the cache, never iFinD."""
    _isolated_cache(tmp_path, monkeypatch)
    save_series(_real_series())
    loaded = load_macro_series("M001657195")
    result = compute_macro_regime([loaded])
    assert result["indicators"][0]["index_id"] == "M001657195"
    assert result["indicators"][0]["freq"] == "M"
    assert result["indicators"][0]["lag_days"] == MONTH_LAG
    assert len(result["dates"]) > 0


def test_real_edb_fixture_yields_a_monotonic_gauge() -> None:
    """End-to-end on captured data: ascending availability dates, valid labels."""
    result = compute_macro_regime([_real_series()], min_periods=3)
    assert result["dates"] == sorted(result["dates"])
    assert result["n_voting"][0] == 1
    assert result["current"]["date"] == result["dates"][-1]
    assert result["params"]["index_meaning"].startswith("availability date")


def test_no_series_is_refused_loudly() -> None:
    with pytest.raises(ValueError, match="at least one"):
        compute_macro_regime([])
