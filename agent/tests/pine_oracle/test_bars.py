"""Bars are the fixture's input, so their generation must be reproducible byte for byte.

The JS gate never regenerates bars (a different float operation order in JS would
make the bar arrays themselves differ in the last bit, which voids the
comparison). Instead the CSV is the single truth — these tests pin that it is
deterministic, well-formed, and that wicks are independent of adjacent closes.
"""

from pine_oracle.bars import (
    DAILY_BAR_COUNT,
    INTRADAY_SESSIONS,
    bars_csv_text,
    lcg_stream,
    make_daily_bars,
    make_intraday_bars,
)
from pine_oracle.schema import sha256_of, write_text_lf

HALF_HOUR = 30 * 60_000


def test_lcg_is_deterministic_and_in_unit_interval() -> None:
    a, b = lcg_stream(11, 200), lcg_stream(11, 200)
    assert a == b
    assert all(0.0 <= x < 1.0 for x in a)
    assert len(set(a)) == 200


def test_daily_bar_shape_and_counts() -> None:
    rows = make_daily_bars(seed=11, n=DAILY_BAR_COUNT, shape="trend")
    assert len(rows) == DAILY_BAR_COUNT
    assert set(rows[0]) == {"time", "open", "high", "low", "close", "volume"}
    for r in rows:
        assert r["high"] >= max(r["open"], r["close"])
        assert r["low"] <= min(r["open"], r["close"])
        assert r["volume"] > 0


def test_unknown_shape_is_a_hard_error_not_a_quiet_fallback() -> None:
    import pytest

    with pytest.raises(ValueError):
        make_daily_bars(seed=11, n=5, shape="sideways")


def test_trend_shape_actually_trends() -> None:
    """`trend` adds a constant positive term to every bar, so over 120 bars the
    compounding must be visible: the generator's per-bar term is ~+0.72%, which
    over 119 bars is ~2.3x. Asserting >1.5x leaves room without letting a
    driftless shape through."""
    rows = make_daily_bars(seed=11, n=DAILY_BAR_COUNT, shape="trend")
    closes = [r["close"] for r in rows]
    assert closes[-1] > closes[0] * 1.5, (closes[0], closes[-1])
    ups = sum(1 for i in range(1, len(closes)) if closes[i] > closes[i - 1])
    assert ups > len(closes) // 2, ups


def test_wicks_are_not_pinned_to_adjacent_closes() -> None:
    """The corpus harness's lesson: `high=max(o,c)*1.01` makes a strict local
    extremum in high/low impossible, so pivot/fractal/zigzag never fire and get
    mis-measured. Keep the wicks independent."""
    rows = make_daily_bars(seed=11, n=DAILY_BAR_COUNT, shape="oscillate")
    highs = [r["high"] for r in rows]
    interiors = sum(
        1 for i in range(1, len(highs) - 1) if highs[i] > highs[i - 1] and highs[i] > highs[i + 1]
    )
    assert interiors >= 5, interiors


def test_gap_shape_injects_exactly_five_jump_bars() -> None:
    """The 1% threshold must isolate the *injected* jumps, not the noise. With the
    daily noise term bounded by ±0.6% (see ``make_daily_bars``), any bar moving
    >=1% is one of the 5 injected gaps — so this is an exact count, not a floor."""
    rows = make_daily_bars(seed=11, n=DAILY_BAR_COUNT, shape="gap")
    jumped = [
        i for i in range(1, len(rows)) if abs(rows[i]["open"] / rows[i - 1]["close"] - 1) >= 0.01
    ]
    assert jumped == [22, 45, 68, 91, 114], jumped


def test_intraday_sessions_and_bar_count() -> None:
    rows = make_intraday_bars(seed=13, sessions=INTRADAY_SESSIONS)
    assert len(rows) == 8 * INTRADAY_SESSIONS
    assert len({r["session"] for r in rows}) == INTRADAY_SESSIONS
    assert [r["session"] for r in rows][:9] == [1] * 8 + [2]
    stamps = [r["time"] for r in rows if r["session"] == 1]
    assert len(stamps) == 8
    # Morning leg 09:30→11:00 and afternoon leg 13:00→14:30 are each four bars of
    # exact 30-minute spacing; index 3→4 is the lunch break, which must be a real
    # gap. Asserting "every adjacent pair is 30 min" would be false, and asserting
    # "some pair is longer" would pass on a shuffled grid — so both halves are
    # checked explicitly, plus the gap itself.
    assert all(b - a == HALF_HOUR for a, b in zip(stamps[:3], stamps[1:4]))
    assert all(b - a == HALF_HOUR for a, b in zip(stamps[4:7], stamps[5:8]))
    assert stamps[4] - stamps[3] == 120 * 60_000, (stamps[3], stamps[4])   # 11:00 → 13:00
    assert stamps[7] - stamps[0] == 6 * HALF_HOUR + 120 * 60_000           # 09:30 → 14:30


def test_intraday_sessions_are_on_consecutive_days() -> None:
    rows = make_intraday_bars(seed=13, sessions=INTRADAY_SESSIONS)
    first_of = {}
    for r in rows:
        first_of.setdefault(r["session"], r["time"])
    days = [first_of[s] for s in sorted(first_of)]
    assert all(b - a == 86_400_000 for a, b in zip(days, days[1:])), days


def test_csv_text_is_lf_and_header_matches() -> None:
    rows = make_daily_bars(seed=11, n=4, shape="trend")
    text = bars_csv_text(rows)
    assert text.splitlines()[0] == "bar_index,time,open,high,low,close,volume"
    assert "\r" not in text
    assert len(text.splitlines()) == 5


def test_csv_text_with_session_appends_the_column() -> None:
    rows = make_intraday_bars(seed=13, sessions=1)
    text = bars_csv_text(rows, with_session=True)
    assert text.splitlines()[0] == "bar_index,time,open,high,low,close,volume,session"
    assert len(text.splitlines()) == 9


def test_generated_file_is_bytewise_reproducible(tmp_path) -> None:
    p1 = tmp_path / "a.csv"
    p2 = tmp_path / "b.csv"
    for p in (p1, p2):
        write_text_lf(p, bars_csv_text(make_daily_bars(seed=11, n=30, shape="oscillate")))
    assert sha256_of(p1) == sha256_of(p2)
