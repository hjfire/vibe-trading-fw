"""The partition store: what a written byte guarantees, and what it must not cost.

Three claims here are the reason the warehouse exists at all, and each one is
testable only because of how the files are laid out:

* **Round-trip fidelity.** A stored bar must read back as the exact float the
  source delivered (``session_date`` at ``ns`` precision included), or a factor
  computed on it is measuring the parquet codec.
* **An ex-rights event never rewrites history** (acceptance criterion 4). Prices
  are stored raw with the factor in force for that bar, and qfq is computed on
  read against the *last factor of the requested window*. The observable
  consequence: after a new dividend is synced, the bytes of every older partition
  are unchanged. That is asserted with a hash, not with a row count.
* **Re-syncing is idempotent.** Merging the same rows in twice leaves one row per
  ``(symbol, session_date)``, so an interrupted run can be re-run freely.

Read-side guards are checked too: a partition with no usable factor for an
equity is skipped with a warning rather than forward-filled across the hole,
which would be a future-information leak.
"""

from __future__ import annotations

import hashlib
import json
import logging
from pathlib import Path
from types import SimpleNamespace

import duckdb
import pandas as pd
import pytest

from backtest.loaders.base import _duckdb_sql_string
from backtest.warehouse import store
from backtest.warehouse.layout import (
    partition_dir,
    partition_file,
    state_path,
    universe_membership_file,
    warehouse_root,
)
from backtest.warehouse.schema import (
    ASSET_EQUITY,
    BAR_COLUMNS,
    factor_holes,
    normalize_bars,
)

STORE_LOGGER = "backtest.warehouse.store"

#: Historical on purpose: the write gate drops bars that have not closed yet.
_WEEK = pd.DatetimeIndex(
    ["2020-01-02", "2020-01-03", "2020-01-06", "2020-01-07", "2020-01-08"]
)
#: Far ahead of every fixture date, so no test loses a row to the closure gate.
_NOW = pd.Timestamp("2035-01-01")
_SYMBOL = "600519.SH"
_UNSET = object()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _source_frame(
    index: pd.DatetimeIndex,
    *,
    closes: list[float],
    factors: list[float] | None,
    volume: float = 1000.0,
    amount: float = 5000.0,
) -> pd.DataFrame:
    """One raw-shaped source frame, prices unadjusted."""
    frame = pd.DataFrame(
        {
            "open": closes,
            "high": [c * 1.01 for c in closes],
            "low": [c * 0.99 for c in closes],
            "close": closes,
            "volume": [volume] * len(index),
            "amount": [amount] * len(index),
        },
        index=index,
    )
    frame.index.name = "trade_date"
    if factors is not None:
        frame["adj_factor"] = list(factors)
    return frame


def seed(
    root: Path,
    symbol: str,
    index: pd.DatetimeIndex,
    *,
    closes: list[float] | None = None,
    factors: list[float] | None | object = _UNSET,
    interval: str = "1D",
    volume: float = 1000.0,
    amount: float | None = 5000.0,
) -> store.WriteResult:
    """Push raw bars through the real write gate into *root*.

    ``factors`` is deliberately three-way: omitted means "every bar carries
    1.0", a list lets a session step across an ex-date, and ``None`` delivers
    the frame without the column at all (what an index partition looks like).
    """
    bar_closes = closes if closes is not None else [100.0 + i for i in range(len(index))]
    bar_factors = [1.0] * len(index) if factors is _UNSET else factors
    frame = _source_frame(
        index,
        closes=bar_closes,
        factors=None if bar_factors is None else list(bar_factors),  # type: ignore[arg-type]
        volume=volume,
        amount=5000.0 if amount is None else amount,
    )
    if amount is None:
        frame = frame.drop(columns=["amount"])
    bars, report = normalize_bars(
        frame,
        symbol=symbol,
        interval=interval,
        source="tushare",
        volume_unit="lots",
        amount_unit="cny_thousand" if amount is not None else None,
        now=_NOW,
    )
    assert report.is_clean, f"the fixture itself must survive the gate: {report.to_dict()}"
    return store.write_bars(bars, interval=interval, root=root)


def _digest(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _years_frame(*, start: str = "2016-01-04", end: str = "2026-01-02") -> pd.DatetimeIndex:
    return pd.bdate_range(start, end)


# ---------------------------------------------------------------------------
# Fidelity (acceptance criterion 2)
# ---------------------------------------------------------------------------


def test_a_stored_bar_reads_back_as_the_exact_float_it_was_written(tmp_path: Path) -> None:
    closes = [0.1 + 0.2, 12.34, 1 / 3, 9999.9999, 100.0]
    index = _WEEK[:5]
    seed(tmp_path, _SYMBOL, index, closes=closes, factors=[1.0] * 5)

    stored = store.read_bars([_SYMBOL], start=index[0], end=index[-1], adjust="raw", root=tmp_path)

    assert stored[_SYMBOL]["close"].to_list() == closes, "bit-level, not approximately"
    assert stored[_SYMBOL]["high"].to_list() == [c * 1.01 for c in closes]


def test_dtypes_and_index_shape_survive_the_round_trip(tmp_path: Path) -> None:
    index = _WEEK
    seed(tmp_path, _SYMBOL, index, closes=[100.0] * len(index))

    frame = store.read_bars([_SYMBOL], start="2020-01-01", end="2020-01-31", root=tmp_path)[_SYMBOL]

    assert str(frame.index.dtype) == "datetime64[ns]"
    assert frame.index.name == "trade_date"
    assert frame.index.tz is None
    for column in frame.columns:
        assert str(frame[column].dtype) == "float64", column
    assert list(frame.columns) == ["open", "high", "low", "close", "volume", "amount"]


def test_sub_daily_stamps_keep_nanosecond_precision_and_land_in_a_month_partition(
    tmp_path: Path,
) -> None:
    """Parquet's default is microseconds; a stored bar must not be rounded."""
    stamp = pd.DatetimeIndex(["2020-06-30 09:31:00.000000123"])
    seed(tmp_path, _SYMBOL, stamp, closes=[10.5], interval="1m")

    read = store.read_bars(
        [_SYMBOL], interval="1m", start="2020-06-30", end="2020-06-30 23:59",
        adjust="raw", root=tmp_path,
    )[_SYMBOL]

    assert str(read.index[0]) == "2020-06-30 09:31:00.000000123"
    assert str(read.index.dtype) == "datetime64[ns]"
    assert partition_file("1m", stamp[0], tmp_path).is_file()
    assert partition_dir("1m", stamp[0], tmp_path).name.startswith("month=")


def test_the_file_on_disk_declares_nanosecond_stamps(tmp_path: Path) -> None:
    """Read back the *file's* type, because the reader casts to ``ns`` anyway.

    ``read_bars`` coerces ``session_date`` to ``datetime64[ns]``, so a partition
    written as ``timestamp[us]`` would still pass every value-level test while
    being a lossy artifact for anyone else — a plain pyarrow consumer, a
    spreadsheet export, or a copy of the tree read without this code in the
    loop. The writer's cast is what makes the format claim true, so the format
    claim is checked where it is made: on disk.
    """
    stamp = pd.DatetimeIndex(["2020-06-30 09:31:00.000000123"])
    seed(tmp_path, _SYMBOL, stamp, closes=[10.5], interval="1m")
    path = partition_file("1m", stamp[0], tmp_path)

    con = duckdb.connect()
    try:
        columns = con.execute(
            "DESCRIBE SELECT session_date FROM read_parquet("
            f"{_duckdb_sql_string(path.as_posix())}, hive_partitioning=0)"
        ).fetchall()
    finally:
        con.close()

    assert columns[0][1] == "TIMESTAMP_NS", f"{path.name} is typed {columns[0][1]}"


def test_daily_partitions_are_yearly_and_minute_partitions_are_monthly(
    tmp_path: Path,
) -> None:
    seed(tmp_path, _SYMBOL, _WEEK)
    seed(tmp_path, _SYMBOL, pd.DatetimeIndex(["2020-01-02 09:31"]), interval="5m", closes=[10.0])

    assert partition_file("1D", _WEEK[0], tmp_path).parent.name == "year=2020"
    assert partition_file("5m", pd.Timestamp("2020-01-02 09:31"), tmp_path).parent.name == "month=2020-01"


def test_a_null_amount_stays_null_rather_than_becoming_zero(tmp_path: Path) -> None:
    """Zero notional is a claim about money; NULL is the honest answer."""
    seed(tmp_path, _SYMBOL, _WEEK, amount=None)

    frame = store.read_bars([_SYMBOL], start="2020-01-01", end="2020-01-31", root=tmp_path)[_SYMBOL]

    assert frame["amount"].isna().all()


def test_the_partition_file_holds_raw_prices_plus_the_factor(tmp_path: Path) -> None:
    """Criterion 4: adjusted levels must never be what is on disk."""
    index = _WEEK
    seed(tmp_path, _SYMBOL, index, closes=[100.0, 100.0, 50.0, 50.0, 50.0],
         factors=[1.0, 1.0, 2.0, 2.0, 2.0])

    raw = store.read_raw_with_factor([_SYMBOL], start="2020-01-01", end="2020-01-31", root=tmp_path)
    stored = raw[_SYMBOL]

    assert "adj_factor" in stored.columns
    assert stored["close"].to_list() == [100.0, 100.0, 50.0, 50.0, 50.0]
    assert stored["adj_factor"].to_list() == [1.0, 1.0, 2.0, 2.0, 2.0]
    adjusted = store.read_bars([_SYMBOL], start="2020-01-01", end="2020-01-31", root=tmp_path)
    assert adjusted[_SYMBOL]["close"].to_list() != stored["close"].to_list()


def test_stored_equity_partitions_carry_no_factor_holes(tmp_path: Path) -> None:
    """The read-side helper must agree with what the write gate promised."""
    seed(tmp_path, _SYMBOL, _WEEK, factors=[1.0, 1.0, 2.0, 2.0, 2.0])
    seed(tmp_path, "000300.SH", _WEEK, factors=None)

    equity = store._query_bars([_SYMBOL], interval="1D", start="2020-01-01", end="2020-01-31", root=tmp_path)
    index = store._query_bars(["000300.SH"], interval="1D", start="2020-01-01", end="2020-01-31", root=tmp_path)

    assert set(equity["asset_class"]) == {ASSET_EQUITY}
    assert factor_holes(equity).empty, "a step in the factor is not a hole"
    assert factor_holes(index).empty, "an index legitimately stores no factor at all"


# ---------------------------------------------------------------------------
# Idempotency and merging (acceptance criterion 3)
# ---------------------------------------------------------------------------


def test_writing_the_same_rows_twice_changes_nothing(tmp_path: Path) -> None:
    index = _WEEK
    first = seed(tmp_path, _SYMBOL, index, closes=[100.0] * len(index))
    second = seed(tmp_path, _SYMBOL, index, closes=[100.0] * len(index))

    assert first.rows_added == len(index)
    assert second.rows_added == 0, "a re-run must not add rows"
    frame = store.read_raw_with_factor([_SYMBOL], start="2020-01-01", end="2020-01-31", root=tmp_path)[_SYMBOL]
    assert len(frame) == len(index)
    assert not frame.index.duplicated().any()


def test_the_incoming_row_replaces_the_stored_one_for_the_same_key(tmp_path: Path) -> None:
    seed(tmp_path, _SYMBOL, _WEEK, closes=[100.0] * 5)

    seed(tmp_path, _SYMBOL, _WEEK[2:3], closes=[110.0])

    frame = store.read_raw_with_factor([_SYMBOL], start="2020-01-01", end="2020-01-31", root=tmp_path)[_SYMBOL]
    assert len(frame) == 5
    assert frame.loc[_WEEK[2], "close"] == 110.0


def test_a_second_symbol_widens_the_partition_without_duplicating_rows(tmp_path: Path) -> None:
    seed(tmp_path, _SYMBOL, _WEEK)

    seed(tmp_path, "000858.SZ", _WEEK)

    symbols = store.stored_symbols(root=tmp_path)
    assert symbols == ["000858.SZ", "600519.SH"]
    frame = store.read_raw_with_factor(symbols, start="2020-01-01", end="2020-01-31", root=tmp_path)
    assert all(len(one) == 5 for one in frame.values())


def test_partitions_that_are_not_touched_keep_their_exact_bytes(tmp_path: Path) -> None:
    """Criterion 4's decisive test: an ex-rights event rewrites no history."""
    old = pd.DatetimeIndex(["2019-06-03", "2019-06-04"])
    new = pd.DatetimeIndex(["2020-06-03", "2020-06-04"])
    seed(tmp_path, _SYMBOL, old, closes=[100.0, 100.0], factors=[1.0, 1.0])
    old_path = partition_file("1D", old[0], tmp_path)
    old_digest = _digest(old_path)

    result = seed(tmp_path, _SYMBOL, new, closes=[50.0, 50.0], factors=[2.0, 2.0])

    assert _digest(old_path) == old_digest, "a 2019 partition must be byte-identical"
    assert all(path != old_path for path in result.paths), "and never opened for the merge"
    assert partition_file("1D", new[0], tmp_path) in result.paths


def test_no_temporary_files_survive_a_write(tmp_path: Path) -> None:
    seed(tmp_path, _SYMBOL, _WEEK)
    seed(tmp_path, _SYMBOL, pd.DatetimeIndex(["2020-06-03"]), closes=[50.0], factors=[2.0])
    store.write_universe_roster(
        "csi300",
        pd.DataFrame({_SYMBOL: [True]}, index=pd.DatetimeIndex(["2020-01-02"])),
        constituent_source="tushare index_weight",
        root=tmp_path,
    )

    leftovers = sorted(p.name for p in tmp_path.rglob("*") if ".tmp" in p.name)
    assert leftovers == [], f"the atomic swap leaked {leftovers}"


def test_the_atomic_swap_survives_a_failed_write(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A crash mid-write must leave the previous partition readable, not half."""
    seed(tmp_path, _SYMBOL, _WEEK, closes=[100.0] * 5)
    path = partition_file("1D", _WEEK[0], tmp_path)
    before = _digest(path)

    def explode(*_args, **_kwargs):
        raise OSError("disk full")

    monkeypatch.setattr(store, "atomic_replace", explode)
    with pytest.raises(OSError):
        seed(tmp_path, _SYMBOL, _WEEK, closes=[200.0] * 5)

    assert _digest(path) == before
    assert store.read_raw_with_factor([_SYMBOL], start="2020-01-01", end="2020-01-31", root=tmp_path)


# ---------------------------------------------------------------------------
# Window-anchored qfq (acceptance criterion 4)
# ---------------------------------------------------------------------------


def _seed_long_history(root: Path, symbol: str = _SYMBOL) -> pd.DatetimeIndex:
    """Ten years of raw bars with the factor doubling every two years."""
    index = _years_frame()
    factor = [2.0 ** ((stamp.year - 2016) // 2) for stamp in index]
    closes = [(100.0 + position * 0.05) / value for position, value in enumerate(factor)]
    seed(root, symbol, index, closes=closes, factors=factor)
    return index


def test_two_windows_differ_by_exactly_one_constant(tmp_path: Path) -> None:
    """qfq is anchored to the window's last factor, so levels scale and returns do not."""
    index = _seed_long_history(tmp_path)
    short = store.read_bars([_SYMBOL], start="2020-01-01", end="2023-12-31", root=tmp_path)[_SYMBOL]
    long = store.read_bars([_SYMBOL], start="2016-01-04", end="2026-01-02", root=tmp_path)[_SYMBOL]

    overlap = long.loc[short.index]
    ratio = short["close"].to_numpy() / overlap["close"].to_numpy()
    assert float(ratio.max() - ratio.min()) < 1e-12, "one constant, not a shifting drift"
    assert abs(ratio[0] - 4.0) < 1e-9, "the 2016-2026 anchor sits four factors lower"
    pd.testing.assert_series_equal(
        short["close"].pct_change().dropna(), overlap["close"].pct_change().dropna(),
        check_names=False, rtol=1e-12,
    )


def test_the_ex_rights_day_shows_no_fabricated_return(tmp_path: Path) -> None:
    """The bar after a 2:1 factor change must not read as a -50% crash."""
    index = pd.DatetimeIndex(["2020-06-01", "2020-06-02", "2020-06-03"])
    seed(tmp_path, _SYMBOL, index, closes=[100.0, 100.0, 50.0], factors=[1.0, 1.0, 2.0])

    frame = store.read_bars([_SYMBOL], start="2020-06-01", end="2020-06-03", root=tmp_path)[_SYMBOL]

    returns = frame["close"].pct_change().dropna()
    assert (returns.abs() < 1e-9).all(), f"adjusted across the split: {returns.to_list()}"
    assert frame["close"].round(6).nunique() == 1


def test_volume_is_deflated_by_the_same_ratio_prices_are_inflated_by(tmp_path: Path) -> None:
    """A split doubles share count; storing that inconsistency is a silent 2x."""
    index = pd.DatetimeIndex(["2020-06-01", "2020-06-03"])
    seed(tmp_path, _SYMBOL, index, closes=[100.0, 50.0], factors=[1.0, 2.0], volume=2000.0)

    frame = store.read_bars([_SYMBOL], start="2020-06-01", end="2020-06-03", root=tmp_path)[_SYMBOL]

    assert frame["volume"].to_list() == [4000.0, 2000.0], "pre-split lots are doubled back"
    assert frame["amount"].to_list() == [5000.0, 5000.0], "notional is a cash figure, never rescaled"


# ---------------------------------------------------------------------------
# Read guards
# ---------------------------------------------------------------------------


def test_a_factorless_equity_partition_is_skipped_with_a_warning(
    tmp_path: Path, caplog: pytest.LogCaptureFixture
) -> None:
    """Written past the gate by hand: the reader must still refuse to extrapolate."""
    bars = pd.DataFrame(
        {
            "symbol": _SYMBOL,
            "market": "a_share",
            "asset_class": ASSET_EQUITY,
            "session_date": _WEEK,
            "open": 100.0,
            "high": 101.0,
            "low": 99.0,
            "close": 100.0,
            "volume": 1000.0,
            "amount": 5000.0,
            "adj_factor": [1.0, 1.0, float("nan"), 1.0, 1.0],
            "source": "tushare",
        }
    )
    store.write_bars(bars, interval="1D", root=tmp_path)

    with caplog.at_level(logging.WARNING, logger=STORE_LOGGER):
        result = store.read_bars([_SYMBOL], start="2020-01-01", end="2020-01-31", root=tmp_path)

    assert result == {}, "no rows beats rows built on a borrowed factor"
    assert "adjustment factor" in caplog.text
    assert _SYMBOL in caplog.text


def test_an_index_without_factors_is_still_served(tmp_path: Path) -> None:
    seed(tmp_path, "000300.SH", _WEEK, factors=None)

    frame = store.read_bars(["000300.SH"], start="2020-01-01", end="2020-01-31", root=tmp_path)

    assert len(frame["000300.SH"]) == 5


def test_a_missing_symbol_is_simply_absent(tmp_path: Path) -> None:
    seed(tmp_path, _SYMBOL, _WEEK)

    result = store.read_bars([_SYMBOL, "600000.SH"], start="2020-01-01", end="2020-01-31", root=tmp_path)

    assert list(result) == [_SYMBOL]
    assert store.read_bars([], start="2020-01-01", end="2020-01-31", root=tmp_path) == {}
    assert store.read_bars([_SYMBOL], start="2010-01-01", end="2011-01-01", root=tmp_path) == {}


def test_the_window_bounds_are_inclusive(tmp_path: Path) -> None:
    seed(tmp_path, _SYMBOL, _WEEK)

    frame = store.read_bars([_SYMBOL], start="2020-01-03", end="2020-01-07", root=tmp_path)[_SYMBOL]

    assert [str(stamp.date()) for stamp in frame.index] == [
        "2020-01-03", "2020-01-06", "2020-01-07"
    ]


def test_an_unsupported_adjust_mode_is_refused(tmp_path: Path) -> None:
    seed(tmp_path, _SYMBOL, _WEEK)

    with pytest.raises(ValueError, match="adjust must be one of"):
        store.read_bars([_SYMBOL], start="2020-01-01", end="2020-01-31", adjust="hfq", root=tmp_path)


def test_an_empty_interval_tree_reads_as_empty(tmp_path: Path) -> None:
    assert store.read_bars([_SYMBOL], start="2020-01-01", end="2020-01-31", root=tmp_path) == {}
    assert store.stored_symbols(root=tmp_path) == []
    assert store.symbol_range(_SYMBOL, root=tmp_path) == (None, None, 0)


def test_coverage_helpers_report_the_stored_range(tmp_path: Path) -> None:
    seed(tmp_path, _SYMBOL, _WEEK)

    first, last, rows = store.symbol_range(_SYMBOL, root=tmp_path)

    assert (str(first.date()), str(last.date()), rows) == ("2020-01-02", "2020-01-08", 5)
    assert store.stored_symbols(root=tmp_path) == [_SYMBOL]


# ---------------------------------------------------------------------------
# Write contract
# ---------------------------------------------------------------------------


def test_write_bars_requires_the_full_column_contract(tmp_path: Path) -> None:
    frame = pd.DataFrame({"symbol": [_SYMBOL], "close": [1.0]})

    with pytest.raises(ValueError, match="missing warehouse columns"):
        store.write_bars(frame, interval="1D", root=tmp_path)


def test_an_empty_write_creates_nothing(tmp_path: Path) -> None:
    from backtest.warehouse.schema import empty_bars

    result = store.write_bars(empty_bars(), interval="1D", root=tmp_path)

    assert result.partitions == 0 and result.paths == []
    assert list(tmp_path.iterdir()) == []


def test_a_row_whose_session_names_another_partition_is_refused(tmp_path: Path) -> None:
    """A misplaced row is invisible to the merge that would fix it."""
    bars = pd.DataFrame(
        {
            "symbol": [_SYMBOL, _SYMBOL],
            "market": "a_share",
            "asset_class": ASSET_EQUITY,
            "session_date": pd.to_datetime(["2020-01-02", "2019-01-02"]),
            "open": 100.0,
            "high": 101.0,
            "low": 99.0,
            "close": 100.0,
            "volume": 1000.0,
            "amount": 5000.0,
            "adj_factor": 1.0,
            "source": "tushare",
        }
    )
    path = partition_file("1D", pd.Timestamp("2020-01-02"), tmp_path)

    with pytest.raises(ValueError, match="refusing to write"):
        store._write_partition(path, bars, interval="1D", root=tmp_path)


def test_the_interval_spelling_cannot_split_the_tree(tmp_path: Path) -> None:
    """``1d`` and ``1D`` are one interval, or a read silently sees nothing."""
    seed(tmp_path, _SYMBOL, _WEEK, interval="1d")

    frame = store.read_bars([_SYMBOL], interval="1D", start="2020-01-01", end="2020-01-31", root=tmp_path)

    assert len(frame[_SYMBOL]) == 5
    assert [child.name for child in (tmp_path / "bars").iterdir()] == ["interval=1D"]


# ---------------------------------------------------------------------------
# Manifest: unit provenance is what a reader trusts
# ---------------------------------------------------------------------------


def test_the_manifest_records_units_per_market(tmp_path: Path) -> None:
    manifest = store.write_manifest(
        source="tushare", markets=["a_share"], volume_unit="lots",
        amount_unit="cny_thousand", root=tmp_path,
    )

    entry = manifest["sources"]["tushare"]
    assert entry["markets"] == ["a_share"]
    assert entry["units_by_market"]["a_share"] == {
        "volume_unit": "lots", "amount_unit": "cny_thousand",
    }
    assert entry["volume_unit"] == "lots"


def test_an_ambiguous_source_reports_no_single_unit(tmp_path: Path) -> None:
    store.write_manifest(source="tushare", markets=["a_share"], volume_unit="lots",
                         amount_unit="cny_thousand", root=tmp_path)

    manifest = store.write_manifest(source="tushare", markets=["hk_equity"], volume_unit="shares",
                                    amount_unit=None, root=tmp_path)

    entry = manifest["sources"]["tushare"]
    assert entry["volume_unit"] is None, "two markets, two units: no answer is the answer"
    assert sorted(entry["markets"]) == ["a_share", "hk_equity"]


def test_a_manifest_needs_a_market(tmp_path: Path) -> None:
    with pytest.raises(ValueError, match="at least one market"):
        store.write_manifest(source="tushare", markets=[], volume_unit="lots",
                             amount_unit=None, root=tmp_path)


def test_a_second_source_may_not_redefine_a_stored_unit(tmp_path: Path) -> None:
    """Otherwise one column becomes two tables and every later read is off by 100x."""
    store.write_manifest(source="tushare", markets=["a_share"], volume_unit="lots",
                         amount_unit="cny_thousand", root=tmp_path)

    conflicts = store.unit_conflicts(
        store.read_manifest(tmp_path),
        source="akshare",
        units_by_market={"a_share": ("shares", "cny_thousand")},
    )

    assert len(conflicts) == 1
    assert "already stored from 'tushare'" in conflicts[0]
    assert store.unit_conflicts(
        store.read_manifest(tmp_path), source="akshare", units_by_market={"a_share": ("lots", "cny_thousand")}
    ) == []


def test_the_same_source_never_conflicts_with_itself(tmp_path: Path) -> None:
    store.write_manifest(source="tushare", markets=["a_share"], volume_unit="lots",
                         amount_unit="cny_thousand", root=tmp_path)

    assert store.unit_conflicts(
        store.read_manifest(tmp_path), source="tushare", units_by_market={"a_share": ("shares", None)}
    ) == []


def test_an_unwritten_warehouse_has_no_manifest(tmp_path: Path) -> None:
    assert store.read_manifest(tmp_path) == {}


def test_a_newer_schema_version_is_refused_rather_than_guessed(tmp_path: Path) -> None:
    path = tmp_path / "_manifest.json"
    path.write_text('{"schema_version": 999, "sources": {}}', encoding="utf-8")

    with pytest.raises(store.WarehouseSchemaMismatch, match="schema_version=999"):
        store.read_manifest(tmp_path)


def test_a_newer_roster_schema_version_is_refused_too(tmp_path: Path) -> None:
    store.write_universe_roster(
        "csi300",
        pd.DataFrame({_SYMBOL: [True]}, index=pd.DatetimeIndex(["2020-01-02"])),
        constituent_source="tushare index_weight",
        root=tmp_path,
    )
    meta = tmp_path / "universe" / "csi300" / "_meta.json"
    payload = json.loads(meta.read_text(encoding="utf-8"))
    payload["schema_version"] = 999
    meta.write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(store.WarehouseSchemaMismatch, match="schema_version=999"):
        store.read_universe_roster("csi300", root=tmp_path)


# ---------------------------------------------------------------------------
# Point-in-time roster (the survivorship-bias answer)
# ---------------------------------------------------------------------------


def _roster() -> pd.DataFrame:
    """Two snapshots, columns in the order ``pivot_table`` will restore them."""
    dates = pd.DatetimeIndex(["2019-12-31", "2020-06-30"])
    return pd.DataFrame(
        {"000858.SZ": [True, False], "600000.SH": [False, True], _SYMBOL: [True, True]},
        index=dates,
    )


def test_the_roster_round_trips_as_a_boolean_matrix(tmp_path: Path) -> None:
    membership = _roster()

    written = store.write_universe_roster(
        "csi300", membership, constituent_source="tushare index_weight",
        constituent_source_date="2020-06-30", root=tmp_path,
    )

    assert written == universe_membership_file("csi300", tmp_path)
    read_back, meta = store.read_universe_roster("csi300", root=tmp_path)
    # The stored form keys its rows on a session-date axis named ``trade_date``;
    # that naming is part of the contract, because the panel reindexes on it.
    pd.testing.assert_frame_equal(read_back, membership.rename_axis("trade_date"))
    assert read_back.index.name == "trade_date"
    assert list(read_back.columns) == list(membership.columns), "name order is part of the contract"
    assert meta["constituent_source"] == "tushare index_weight"
    assert meta["snapshot_dates"] == 2 and meta["constituent_count"] == 3


def test_an_unresolved_roster_writes_no_file(tmp_path: Path) -> None:
    """The absent file is what makes a later panel report itself as biased."""
    assert store.write_universe_roster(
        "csi300", None, constituent_source="hand-picked list", root=tmp_path
    ) is None
    assert store.write_universe_roster(
        "csi300", pd.DataFrame(), constituent_source="hand-picked list", root=tmp_path
    ) is None

    assert store.read_universe_roster("csi300", root=tmp_path) == (None, {})
    assert store.list_universes(root=tmp_path) == []
    assert not universe_membership_file("csi300", tmp_path).exists()


def test_only_member_rows_are_stored_and_reconstruction_is_lossless(tmp_path: Path) -> None:
    """300 names x 120 snapshots of booleans is 36k cells; the True cells are ~300."""
    membership = pd.DataFrame(
        {f"6000{j:02d}.SH": [(row + j) % 3 == 0 for row in range(20)] for j in range(4)},
        index=pd.DatetimeIndex(pd.bdate_range("2020-01-01", periods=20)),
    )
    expected_members = int(membership.to_numpy().sum())
    assert expected_members > 20, "the fixture must actually mix members in and out"

    store.write_universe_roster("csi300", membership, constituent_source="tushare index_weight", root=tmp_path)

    read_back, _meta = store.read_universe_roster("csi300", root=tmp_path)
    # ``check_freq`` is off because a frequency hint is a pandas-side annotation
    # that the (trade_date, symbol) table deliberately does not store.
    pd.testing.assert_frame_equal(
        read_back, membership.rename_axis("trade_date"), check_freq=False
    )
    con = duckdb.connect(":memory:")
    try:
        rows = con.execute(
            f"SELECT count(*) FROM read_parquet('{universe_membership_file('csi300', tmp_path).as_posix()}')"
        ).fetchone()[0]
    finally:
        con.close()
    assert rows == expected_members, "one row per member-snapshot, no False cells"


def test_listed_universes_reflect_what_is_on_disk(tmp_path: Path) -> None:
    store.write_universe_roster(
        "sse50", pd.DataFrame({_SYMBOL: [True]}, index=pd.DatetimeIndex(["2020-01-02"])),
        constituent_source="tushare index_weight", root=tmp_path,
    )
    store.write_universe_roster(
        "csi300", pd.DataFrame({"000858.SZ": [True]}, index=pd.DatetimeIndex(["2020-01-02"])),
        constituent_source="tushare index_weight", root=tmp_path,
    )

    assert store.list_universes(root=tmp_path) == ["csi300", "sse50"]


@pytest.mark.parametrize("name", ["../escape", "a/b", "", "  ", "na me"])
def test_an_unsafe_universe_name_cannot_escape_the_tree(tmp_path: Path, name: str) -> None:
    with pytest.raises(ValueError, match="unsafe path segment"):
        store.write_universe_roster(
            name, pd.DataFrame({_SYMBOL: [True]}, index=pd.DatetimeIndex(["2020-01-02"])),
            constituent_source="tushare index_weight", root=tmp_path,
        )
    assert list(tmp_path.rglob("escape")) == []


# ---------------------------------------------------------------------------
# Path safety (acceptance criterion 7)
# ---------------------------------------------------------------------------


def test_state_files_are_keyed_by_scope_not_by_caller(tmp_path: Path) -> None:
    one = state_path("1D", [_SYMBOL, "000858.SZ"], tmp_path)
    same_in_other_order = state_path("1d", ["000858.SZ", _SYMBOL], tmp_path)
    different_scope = state_path("1D", [_SYMBOL], tmp_path)

    assert one == same_in_other_order, "the same symbol set is the same resume state"
    assert one != different_scope, "an overlapping run must not overwrite the other's progress"
    assert one.parent.name == "interval=1D"
    assert one.name.startswith("scope-") and len(one.stem) == 6 + 12


def _stub_root(monkeypatch: pytest.MonkeyPatch, value: object) -> None:
    """Make the config layer hand back exactly *value* for the root setting.

    Going through a stub instead of ``os.environ`` is the point: an env var can
    only ever be a string, so the non-string cases (a stubbed config, a bad
    default) can only be reproduced where the value is read.
    """
    import src.config.accessor as accessor

    fake = SimpleNamespace(data=SimpleNamespace(vibe_trading_warehouse_root=value))
    monkeypatch.setattr(accessor, "get_env_config", lambda: fake)


@pytest.mark.parametrize(
    "rejected",
    ["warehouse-data", "./relative", "..", "", "   ", 123, 3.5, None, Path("x")],
)
def test_a_root_that_cannot_be_resolved_absolutely_falls_back_home(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, rejected: object
) -> None:
    """Criterion 7: none of these may put a data file under the working tree."""
    monkeypatch.chdir(tmp_path)
    _stub_root(monkeypatch, rejected)

    root = warehouse_root()

    assert root == Path.home() / ".vibe-trading" / "warehouse", rejected
    assert root.is_absolute()
    assert tmp_path not in root.parents and root != tmp_path
    assert partition_file("1D", _WEEK[0], root).as_posix().startswith(Path.home().as_posix())


def test_a_genuine_absolute_root_is_honoured_and_tilde_expanded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    _stub_root(monkeypatch, str(tmp_path / "honoured"))
    assert warehouse_root() == tmp_path / "honoured"

    _stub_root(monkeypatch, "~/warehouse-tilde")
    assert warehouse_root() == Path.home() / "warehouse-tilde"


def test_a_relative_root_warns_instead_of_silently_ignoring_the_config(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    monkeypatch.chdir(tmp_path)
    _stub_root(monkeypatch, "warehouse-data")

    with caplog.at_level(logging.WARNING, logger="backtest.warehouse.layout"):
        warehouse_root()

    assert "VIBE_TRADING_WAREHOUSE_ROOT" in caplog.text
    assert "warehouse-data" in caplog.text
    assert list(tmp_path.iterdir()) == [], "and nothing was written into the working tree"
