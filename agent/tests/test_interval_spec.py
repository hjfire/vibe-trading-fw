"""The interval grammar this slice opens: a served base taken k times.

Only the parse table lives here — folding is reconciled bar-for-bar in
``test_market_kline_custom_intervals.py``. Every expected value is hand-written,
because what is under test is *which base a request lands on*: ``120`` must be
60m×2 and not 30m×4, and ``7m`` must be 1m×7 — that one is the model's own
corollary (a minute base divides every minute count), not leniency.
"""

from __future__ import annotations

import pytest

from src.api.interval_spec import (
    MINUTE_BASES,
    IntervalSpec,
    bar_seconds,
    fold_spec,
    parse_interval,
    parse_resolution,
)


class TestParseInterval:
    def test_the_eight_native_spellings_stay_native(self):
        for text in ("1m", "5m", "15m", "30m", "60m", "1D", "1W", "1M"):
            got = parse_interval(text)
            assert got is not None, text
            assert (got.kind, got.base, got.k) == ("native", text, 1), text
            assert got.interval == text, text

    @pytest.mark.parametrize(
        ("text", "kind", "base", "k", "unit"),
        [
            ("120m", "minute-fold", "60m", 2, ""),
            ("10m", "minute-fold", "5m", 2, ""),
            ("45m", "minute-fold", "15m", 3, ""),
            ("3m", "minute-fold", "1m", 3, ""),
            ("7m", "minute-fold", "1m", 7, ""),
            ("2D", "daily-fold", "1D", 2, ""),
            ("5D", "daily-fold", "1D", 5, ""),
            ("2W", "calendar-fold", "1W", 2, "week"),
            ("3M", "calendar-fold", "1M", 3, "month"),
        ],
    )
    def test_a_request_lands_on_the_largest_base_that_divides_it(self, text, kind, base, k, unit):
        got = parse_interval(text)
        assert got is not None
        assert (got.kind, got.base, got.k, got.unit) == (kind, base, k, unit), text

    @pytest.mark.parametrize(
        "text", ["2.5m", "0m", "-5m", "abc", "", "m", "120X", "1S", "1d", "120"]
    )
    def test_only_the_spelling_itself_can_fail(self, text):
        """Nothing about the *number* is refused — a non-positive or fractional count is.

        ``"120"`` is refused here and served by ``parse_resolution``: bare minutes is
        the UDF spelling, not the market one. That asymmetry is the protocol's, so it
        is pinned rather than smoothed over. ``"1d"`` is refused for the same kind of
        reason: the market spells a day with a capital ``D``, and a grammar that
        shrugs off case cannot tell ``1D`` from a request it has never heard of.
        """
        assert parse_interval(text) is None, text

    def test_a_fold_reprints_its_own_market_spelling(self):
        for text in ("120m", "7m", "2D", "2W", "3M"):
            assert parse_interval(text).interval == text, text

    def test_a_leading_zero_is_the_same_request_not_a_refused_one(self):
        """``"01D"`` parses as ``1D``: the grammar refuses spellings, not numbers.

        Ruled here rather than left to a reader: adding a zero-padding rule would be
        a second refusal axis, and the only thing it could protect is a URL nobody
        builds.
        """
        assert parse_interval("01D") == IntervalSpec("native", "1D", 1, "")


class TestParseResolution:
    def test_bare_numbers_are_udf_minutes(self):
        assert parse_resolution("1") == IntervalSpec("native", "1m", 1, "")
        assert parse_resolution("60") == IntervalSpec("native", "60m", 1, "")
        assert parse_resolution("120") == IntervalSpec("minute-fold", "60m", 2, "")
        assert parse_resolution("7") == IntervalSpec("minute-fold", "1m", 7, "")

    def test_the_h_letter_and_the_bare_unit_letters_are_aliases(self):
        assert parse_resolution("1H") == IntervalSpec("native", "60m", 1, "")
        assert parse_resolution("D") == IntervalSpec("native", "1D", 1, "")
        assert parse_resolution("W") == IntervalSpec("native", "1W", 1, "week")
        assert parse_resolution("M") == IntervalSpec("native", "1M", 1, "month")

    def test_multipliers_arrive_in_udf_shape_too(self):
        assert parse_resolution("2D") == IntervalSpec("daily-fold", "1D", 2, "")
        assert parse_resolution("2W") == IntervalSpec("calendar-fold", "1W", 2, "week")
        assert parse_resolution("3M") == IntervalSpec("calendar-fold", "1M", 3, "month")

    def test_a_day_written_in_minutes_stays_minutes_because_udf_days_are_spelled_d(self):
        """``1440`` is 24×60m, not a daily bar. The library never sends this.

        UDF names a day ``"D"``; a bare number is minutes by the protocol's own text,
        so inventing a day here would be a second spelling of one day that only this
        repo knows. Pinned so nobody "fixes" it into a daily bar later.
        """
        assert parse_resolution("1440") == IntervalSpec("minute-fold", "60m", 24, "")

    @pytest.mark.parametrize("text", ["2.5", "0", "-5", "", "abc", "1h", "d", "120x"])
    def test_a_resolution_that_is_not_a_spelling_is_none(self, text):
        assert parse_resolution(text) is None, text

    @pytest.mark.parametrize(
        "text",
        ["1", "5", "15", "30", "60", "1H", "1D", "D", "1W", "W", "1M", "M",
         "120", "7", "1440", "2D", "2W", "3M"],
    )
    def test_every_served_resolution_round_trips_through_the_market_grammar(self, text):
        got = parse_resolution(text)
        assert got is not None, text
        assert parse_interval(got.interval) == got, text


class TestBarSeconds:
    @pytest.mark.parametrize(
        ("resolution", "seconds"),
        [("1", 60), ("5", 300), ("15", 900), ("30", 1800), ("60", 3600), ("1H", 3600),
         ("D", 86400), ("1D", 86400), ("W", 604800), ("1W", 604800),
         ("M", 2678400), ("1M", 2678400)],
    )
    def test_native_widths_are_the_ones_udf_history_needs(self, resolution, seconds):
        """The bar width belongs to ``interval_spec``; both doors read it from here.

        ``bar_seconds`` feeds a bar-count estimate and a window filter; if a
        derived value drifted, the chart would fetch a different amount of history
        with nothing on the wire to say so. A month stays 31 days (the long one) so
        the estimate can only ever over-include.
        """
        assert bar_seconds(parse_resolution(resolution)) == seconds

    def test_a_fold_is_k_base_bars_wide(self):
        assert bar_seconds(parse_resolution("120")) == 2 * 3600
        assert bar_seconds(parse_resolution("7")) == 7 * 60
        assert bar_seconds(parse_resolution("2D")) == 2 * 86400
        assert bar_seconds(parse_resolution("2W")) == 2 * 604800
        assert bar_seconds(parse_resolution("3M")) == 3 * 2678400


class TestFoldSpec:
    def test_fold_spec_is_the_shape_the_parser_gives_for_the_same_request(self):
        assert fold_spec("1W", 3) == parse_interval("3W")
        assert fold_spec("1M", 1) == parse_interval("1M")
        assert fold_spec("1D", 2) == parse_interval("2D")
        assert fold_spec("1D", 1) == parse_interval("1D")
        assert fold_spec("1m", 7) == parse_interval("7m")
        assert fold_spec("60m", 2) == parse_interval("120m")

    def test_the_width_is_the_base_not_a_fall_through_to_a_day(self):
        """A base outside the vocabulary is refused; it is never read as a day.

        ``fold_spec`` takes ``base`` on trust, so a hand-built ``2m`` spec can reach
        ``bar_seconds``. Its last line used to be ``return DAY_SECONDS * spec.k``,
        which answered that request with three days — the very silent ``86400``
        default this module exists to abolish. Both shapes of the bug are pinned: an
        unknown base raises, and a week built without its ``unit`` field still comes
        out two weeks wide, because width is a function of ``base`` and never of
        ``unit``.
        """
        with pytest.raises(ValueError):
            bar_seconds(fold_spec("2m", 3))
        assert bar_seconds(IntervalSpec("calendar-fold", "1W", 2)) == 2 * 604800

    def test_the_minute_bases_and_the_minute_period_table_say_the_same_five(self):
        """Two spellings of one fact must not be allowed to drift apart.

        ``market_routes._MINUTE_PERIODS`` is what the fetch layer can ask a source
        for; ``MINUTE_BASES`` is what this module is willing to fold. If one grows a
        sixth entry the other has to, or a request folds off a base nobody can fetch.
        """
        from src.api import market_routes

        assert {int(v) for v in market_routes._MINUTE_PERIODS.values()} == {
            int(b[:-1]) for b in MINUTE_BASES
        }
