"""Bars are the fixture's input, so their generation must be reproducible byte for byte.

The JS gate never regenerates bars (a different float operation order in JS would
make the bar arrays themselves differ in the last bit, which voids the
comparison). Instead the CSV is the single truth — these tests pin that it is
deterministic, well-formed, and that wicks are independent of adjacent closes.

The last test is the only one that reads the COMMITTED ``bars_*.csv``; everything
above it checks rows the generator just built in memory. That distinction is the
whole point of it: ``reference.py`` documents a cold-start branch as unreachable
"on the committed bars", and that claim is about bytes in the fixture directory,
not about what ``make_daily_bars`` returns today.
"""

import csv

import numpy as np

from pine_oracle.bars import (
    DAILY_BAR_COUNT,
    INTRADAY_SESSIONS,
    bars_csv_text,
    lcg_stream,
    make_daily_bars,
    make_intraday_bars,
)
from pine_oracle.schema import FIXTURE_DIR, sha256_of, write_text_lf

HALF_HOUR = 30 * 60_000

#: The five priced columns of a bar CSV. These are the columns whose finiteness every
#: batch of ``reference.py`` assumes: an empty cell is Pine ``na`` (``schema.NA_ENCODING
#: == "empty"``, decoded by ``schema.parse_float`` straight into ``float("nan")``) and a
#: signed-infinity cell parses fine and then satisfies every row invariant below —
#: ``high >= max(open, close)`` and ``volume > 0`` are both TRUE for ``inf``, so the
#: in-memory shape checks cannot be the finiteness guard.
PRICED_COLUMNS: tuple[str, ...] = ("open", "high", "low", "close", "volume")


def test_lcg_is_deterministic_and_in_unit_interval() -> None:
    a, b = lcg_stream(11, 200), lcg_stream(11, 200)
    assert a == b
    assert all(0.0 <= x < 1.0 for x in a)
    assert len(set(a)) == 200


def test_daily_bar_shape_and_counts() -> None:
    """Row invariants over every shape the committed fixtures use, intraday
    included: each daily shape has its own wick draw and ``make_intraday_bars``
    has a third set of row formulas, from which batch one's VWAP reference values
    are computed — checking only ``trend`` would leave two of them unguarded."""
    for shape in ("trend", "oscillate", "gap"):
        rows = make_daily_bars(seed=11, n=DAILY_BAR_COUNT, shape=shape)
        assert len(rows) == DAILY_BAR_COUNT
        assert set(rows[0]) == {"time", "open", "high", "low", "close", "volume"}
        for r in rows:
            assert r["high"] >= max(r["open"], r["close"])
            assert r["low"] <= min(r["open"], r["close"])
            assert r["volume"] > 0
    # sessions=1 is enough: the row formulas don't depend on the session index,
    # and 8 bars keeps this case as cheap as the three 120-bar shapes above.
    intraday = make_intraday_bars(seed=13, sessions=1)
    assert len(intraday) == 8
    assert set(intraday[0]) == {"time", "open", "high", "low", "close", "volume", "session"}
    for r in intraday:
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
    """The 1% threshold isolates the *injected* jumps because the non-injected
    overnight ratio is exactly 0.0, not because the body noise happens to stay
    under 1% — see ``test_non_injected_bars_open_equals_previous_close``. So this
    is an exact count, not a floor."""
    rows = make_daily_bars(seed=11, n=DAILY_BAR_COUNT, shape="gap")
    jumped = [
        i for i in range(1, len(rows)) if abs(rows[i]["open"] / rows[i - 1]["close"] - 1) >= 0.01
    ]
    assert jumped == [22, 45, 68, 91, 114], jumped


def test_non_injected_bars_open_equals_previous_close() -> None:
    """The invariant the gap count above rests on. ``price = close`` stores the
    *unrounded* close and the next bar opens from it, so ``open[i]`` and
    ``close[i-1]`` are one float passed through one ``round(value, 6)``: exact
    equality, never an approximation. Rounding either side to a different
    precision breaks it, and no noise bound can put it back."""
    rows = make_daily_bars(seed=11, n=DAILY_BAR_COUNT, shape="gap")
    injected = {22, 45, 68, 91, 114}
    for i in range(1, len(rows)):
        if i not in injected:
            assert rows[i]["open"] == rows[i - 1]["close"], i
    for shape in ("trend", "oscillate"):
        rows = make_daily_bars(seed=11, n=DAILY_BAR_COUNT, shape=shape)
        for i in range(1, len(rows)):
            assert rows[i]["open"] == rows[i - 1]["close"], (shape, i)


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


def priced_cells_from_csv(text: str) -> dict[str, list[str]]:
    """The five priced columns of one bar CSV, read from TEXT and kept as raw cells.

    Two deliberate choices, both so this gate can be disproved without touching a
    fixture:
      * it takes text, not a path — ``bars_*.csv`` are frozen, so the "it would go red"
        evidence is fed as a bad sample (a copy outside the repo, or a rewritten
        string) and the committed bytes stay byte-identical;
      * it returns STRINGS, not floats — coercing here would raise ``ValueError`` on an
        empty field before the gate could name the file and column it is refusing,
        and it would quietly swallow the other shape worth pinning, ``"inf"``.
    """
    rows = list(csv.reader(text.splitlines()))
    header, body = rows[0], rows[1:]
    missing = [name for name in PRICED_COLUMNS if name not in header]
    if missing:
        raise ValueError(f"bar CSV header carries none of {missing}: {header!r}")
    index = {name: header.index(name) for name in PRICED_COLUMNS}
    columns: dict[str, list[str]] = {name: [] for name in PRICED_COLUMNS}
    for row in body:
        for name, position in index.items():
            # a row too short to reach the column IS an empty field: Pine `na` is
            # encoded as an empty cell, so never invent a value for a missing cell.
            columns[name].append(row[position] if position < len(row) else "")
    return columns


def test_the_committed_bar_csvs_are_finite_and_have_no_empty_price_field() -> None:
    """The committed ``bars_*.csv``: every priced column finite, no empty cell.

    This closes a reference that pointed at a gate which did not exist. Until now
    ``reference.py`` explained its cold-start branch as "Unreachable on the committed
    bars (test_bars.py asserts finiteness)", while this file asserted no finiteness at
    all (``grep -n -i -E "finite|nan|inf"`` over it: zero hits) and every test above it
    builds rows in memory with ``make_daily_bars()``/``make_intraday_bars()``, comparing
    not one committed byte. The in-memory invariants are not a substitute either:
    ``high >= max(open, close)``, ``low <= min(open, close)`` and ``volume > 0`` are all
    TRUE for ``inf``, so a +/-inf price walked straight through them — which is why the
    promise is now pinned where it is actually made, in the four CSVs, against both
    shapes the JS reader trips over: the empty field (Pine ``na``, ``schema.NA_ENCODING``)
    and any non-finite float.
    """
    paths = sorted(FIXTURE_DIR.glob("bars_*.csv"))
    assert len(paths) == 4, [p.name for p in paths]
    for path in paths:
        columns = priced_cells_from_csv(path.read_text(encoding="utf-8"))
        for column, cells in columns.items():
            assert cells, (path.name, column, "no rows parsed at all")
            empty = [i for i, cell in enumerate(cells) if cell == ""]
            assert not empty, (path.name, column, "empty cell (Pine na) at rows", empty)
            values = np.asarray([float(cell) for cell in cells], dtype="float64")
            non_finite = [i for i, value in enumerate(values) if not np.isfinite(value)]
            assert not non_finite, (path.name, column, "non-finite value at rows", non_finite)
