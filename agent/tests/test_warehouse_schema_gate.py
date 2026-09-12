"""The write gate: what may enter the warehouse, and what must never.

``backtest/warehouse/schema.py`` is the only place storage policy is decided, so
this file is where that policy is pinned. Each rule exists because the
alternative fails silently years later:

* **No factor, no row** (for assets that carry corporate actions). A raw close
  among adjusted-looking ones is a phantom split: ``tushare.py:256-274`` already
  prefers dropping a symbol over backtesting unadjusted prices (the -47.2% fake
  return on 300750.SZ 2023-04-26), and writing one is the same mistake in
  permanent form. Refused rows are recorded as *pending*, because a hole is a
  promise to retry while an absent row reads as "the market was closed".
* **Zero volume is deleted, not kept.** The engines build the calendar from each
  symbol's own index and forward-fill with a limit
  (``engines/base.py:_align``, ``test_backtest_with_suspension_gap``), so a
  placeholder row would turn "did not trade" into "price did not move".
* **Units are reconciled or the write is refused.** A 100x slip inside one
  partition is invisible downstream, so an undeclared market or an
  unconvertible unit raises instead of guessing.
* **A bar that has not closed never lands**, because appends never revisit the
  in-progress session at its source.
"""

from __future__ import annotations

import pandas as pd
import pytest

from backtest.loaders.tushare import _is_index
from backtest.warehouse.schema import (
    ASSET_CLASSES,
    ASSET_EQUITY,
    ASSET_FUND,
    ASSET_INDEX,
    ASSET_OTHER,
    BAR_COLUMNS,
    RejectReport,
    WarehouseConfigError,
    asset_classes_with,
    bar_duration,
    canonical_units,
    classify_asset,
    declared_amount_unit,
    empty_bars,
    factor_holes,
    normalize_bars,
    storable_markets,
)

#: Fixed clock for the closure gate. Every fixture session below is earlier than
#: this, so tests that are not about bar closure never lose a row to it.
NOW = pd.Timestamp("2020-01-10 15:00")
SESSIONS = pd.DatetimeIndex(["2020-01-06", "2020-01-07", "2020-01-08"])

EQUITY = "600519.SH"
INDEX = "000300.SH"
ETF = "510050.SH"


def source_frame(
    index: pd.DatetimeIndex = SESSIONS,
    *,
    close: float | list[float] = 100.0,
    factor: float | list[float] | None = 1.0,
    volume: float | list[float] = 1000.0,
    amount: float | list[float] = 5000.0,
) -> pd.DataFrame:
    """Build a source-shaped bar frame (raw prices, DatetimeIndex).

    ``factor`` is the whole point of the helper: the default of ``1.0`` writes a
    factor column, ``None`` writes the frame without the column at all (what a
    qfq-only source delivers), and a list lets a single session go missing.
    """
    closes = [close] * len(index) if isinstance(close, (int, float)) else list(close)
    volumes = [volume] * len(index) if isinstance(volume, (int, float)) else list(volume)
    amounts = [amount] * len(index) if isinstance(amount, (int, float)) else list(amount)
    frame = pd.DataFrame(
        {
            "open": closes,
            "high": [c * 1.01 for c in closes],
            "low": [c * 0.99 for c in closes],
            "close": closes,
            "volume": volumes,
            "amount": amounts,
        },
        index=index,
    )
    frame.index.name = "trade_date"
    if factor is not None:
        frame["adj_factor"] = (
            [float(factor)] * len(index) if isinstance(factor, (int, float)) else list(factor)
        )
    return frame


def gate(frame: pd.DataFrame, symbol: str = EQUITY, **kwargs) -> tuple[pd.DataFrame, RejectReport]:
    """Run :func:`normalize_bars` with the a-share units the loaders declare."""
    options = dict(symbol=symbol, interval="1D", source="tushare", volume_unit="lots",
                   amount_unit="cny_thousand", now=NOW)
    options.update(kwargs)
    return normalize_bars(frame, **options)


# ---------------------------------------------------------------------------
# Rule 1: the adjustment factor
# ---------------------------------------------------------------------------


def test_equity_without_a_factor_column_is_refused_outright() -> None:
    """A source that only speaks adjusted prices cannot feed the warehouse."""
    with pytest.raises(WarehouseConfigError) as exc:
        gate(source_frame(factor=None))

    message = str(exc.value)
    assert "adj_factor" in message
    assert "fetch_raw_with_factor" in message, "the error must name the way out"


def test_index_needs_no_factor_because_it_is_already_continuous() -> None:
    bars, report = gate(source_frame(factor=None), symbol=INDEX)

    assert len(bars) == len(SESSIONS)
    assert report.is_clean
    assert bars["adj_factor"].isna().all()


def test_a_null_factor_row_is_dropped_and_recorded_as_a_pending_hole() -> None:
    """Missing factors lag price by hours; that is a hole to retry, not a halt."""
    bars, report = gate(source_frame(factor=[1.0, float("nan"), 1.0]))

    assert [str(stamp.date()) for stamp in bars["session_date"]] == [
        "2020-01-06",
        "2020-01-08",
    ]
    assert report.dropped["missing_adj_factor"] == 1
    assert report.pending_dates == ["2020-01-07"], "the retry list must name the session"


def test_a_nonpositive_factor_is_treated_as_missing() -> None:
    """``adj_factor = 0`` would divide by zero downstream, so it is no factor."""
    bars, report = gate(source_frame(factor=[1.0, 0.0, -3.0]))

    assert len(bars) == 1
    assert report.dropped["missing_adj_factor"] == 2
    assert report.pending_dates == ["2020-01-07", "2020-01-08"]


def test_pending_dates_are_sorted_and_deduplicated() -> None:
    frame = source_frame(
        pd.DatetimeIndex(["2020-01-09", "2020-01-08", "2020-01-07"]),
        factor=[float("nan"), float("nan"), 1.0],
    )

    _bars, report = gate(frame)

    assert report.pending_dates == ["2020-01-08", "2020-01-09"]


def test_a_fund_is_held_to_the_same_factor_rule_as_an_equity() -> None:
    with pytest.raises(WarehouseConfigError):
        gate(source_frame(factor=None), symbol=ETF)


# ---------------------------------------------------------------------------
# Rule 2: halts are absences
# ---------------------------------------------------------------------------


def test_zero_volume_equity_row_is_deleted_not_stored_as_a_placeholder() -> None:
    """This is the "停牌" row an ``is_halt`` flag would have written instead."""
    bars, report = gate(source_frame(volume=[1000.0, 0.0, 1000.0]))

    assert [str(stamp.date()) for stamp in bars["session_date"]] == [
        "2020-01-06",
        "2020-01-08",
    ]
    assert report.dropped["zero_volume"] == 1
    assert report.pending_dates == [], "a halt is not a hole to retry"


def test_null_volume_is_deleted_rather_than_read_as_zero() -> None:
    frame = source_frame()
    frame.loc[SESSIONS[1], "volume"] = float("nan")

    bars, report = gate(frame)

    assert len(bars) == 2
    assert report.dropped["missing_volume"] == 1


def test_an_index_may_print_zero_volume_and_keep_its_session() -> None:
    bars, report = gate(source_frame(volume=[1000.0, 0.0, 1000.0]), symbol=INDEX)

    assert len(bars) == 3
    assert report.is_clean


def test_asset_classes_are_read_from_one_rule_table() -> None:
    """The audit phrases its questions with these, so the sets are the contract."""
    assert asset_classes_with("drop_zero_volume") == [ASSET_EQUITY, ASSET_FUND, ASSET_OTHER]
    assert asset_classes_with("adjust_applicable") == [ASSET_EQUITY, ASSET_FUND]
    assert ASSET_INDEX not in asset_classes_with("adjust_applicable")


# ---------------------------------------------------------------------------
# Rule 3: units
# ---------------------------------------------------------------------------


def test_shares_are_converted_to_the_canonical_lot_unit() -> None:
    bars, report = gate(source_frame(volume=100_000.0), volume_unit="shares")

    assert bars["volume"].tolist() == [1000.0, 1000.0, 1000.0]
    assert any("volume" in note and "shares -> lots" in note for note in report.notes)


def test_an_undeclared_volume_unit_is_refused() -> None:
    """#1062: sources genuinely disagree, so a blank is not a license to guess."""
    with pytest.raises(WarehouseConfigError, match="undeclared"):
        gate(source_frame(), volume_unit=None)


def test_a_unit_with_no_exact_conversion_is_refused() -> None:
    """Contracts/weight units vary by instrument; nothing here can claim a ratio."""
    with pytest.raises(WarehouseConfigError, match="no exact conversion rule"):
        gate(source_frame(), volume_unit="contracts")


def test_a_market_without_established_units_cannot_be_stored() -> None:
    with pytest.raises(WarehouseConfigError, match="no canonical volume unit"):
        gate(source_frame(factor=None), symbol="BTC-USDT")


def test_amount_becomes_null_when_its_unit_was_never_verified() -> None:
    """Nulling an optional column is honest; storing it 1000x off is not."""
    bars, report = gate(source_frame(), amount_unit=None)

    assert bars["amount"].isna().all()
    assert any("amount nulled" in note for note in report.notes)


def test_amount_is_converted_to_the_unit_the_vwap_derivation_expects() -> None:
    """``alpha_bench_tool`` multiplies stored amount by 1000, so it must be CNY-thousands."""
    bars, _report = gate(source_frame(amount=5_000_000.0), amount_unit="cny")

    assert bars["amount"].tolist() == [5000.0, 5000.0, 5000.0]


def test_only_verified_pairs_declare_an_amount_unit() -> None:
    assert declared_amount_unit("tushare", "a_share") == "cny_thousand"
    assert declared_amount_unit("baostock", "a_share") is None
    assert declared_amount_unit("tushare", "hk_equity") is None


def test_storable_markets_are_exactly_the_unit_declared_ones() -> None:
    assert storable_markets() == ["a_share"]
    assert canonical_units("a_share").volume_unit == "lots"
    assert canonical_units("hk_equity").volume_unit is None, "not yet evidenced"


# ---------------------------------------------------------------------------
# Bar shape, closure, duplicates
# ---------------------------------------------------------------------------


def test_today_unfinished_bar_is_refused_and_yesterday_survives() -> None:
    """The last bar of a run must be a closed session or the partition is poisoned."""
    bars, report = gate(source_frame(pd.DatetimeIndex(["2020-01-09", "2020-01-10"])))

    assert [str(stamp.date()) for stamp in bars["session_date"]] == ["2020-01-09"]
    assert report.dropped["bar_not_closed"] == 1

    one_minute = source_frame(pd.DatetimeIndex(["2020-01-10 14:59", "2020-01-10 15:00"]))
    minute_bars, minute_report = gate(one_minute, interval="1m", now=pd.Timestamp("2020-01-10 15:00"))

    assert [str(stamp) for stamp in minute_bars["session_date"]] == ["2020-01-10 14:59:00"]
    assert minute_report.dropped["bar_not_closed"] == 1


def test_duplicate_sessions_keep_the_last_row() -> None:
    frame = source_frame(
        pd.DatetimeIndex(["2020-01-08", "2020-01-08"]), close=[100.0, 200.0]
    )

    bars, report = gate(frame)

    assert len(bars) == 1
    assert bars["close"].iloc[0] == 200.0
    assert report.dropped["duplicate_session"] == 1


def test_bars_are_sorted_by_session_and_carry_the_exact_contract() -> None:
    shuffled = source_frame(SESSIONS[[2, 0, 1]])

    bars, _report = gate(shuffled)

    assert list(bars.columns) == list(BAR_COLUMNS)
    assert bars["session_date"].is_monotonic_increasing
    assert list(bars.index) == [0, 1, 2], "rows must be positionally clean for the merge"


def test_partition_dtypes_are_pinned_so_parquet_cannot_drift() -> None:
    bars, _report = gate(source_frame())

    assert str(bars["session_date"].dtype) == "datetime64[ns]"
    for column in ("open", "high", "low", "close", "volume", "amount", "adj_factor"):
        assert str(bars[column].dtype) == "float64", column
    for column in ("symbol", "market", "asset_class", "source"):
        assert bars[column].dtype == object, column


def test_symbol_market_asset_class_and_source_are_stamped_per_row() -> None:
    bars, _report = gate(source_frame())

    assert set(bars["symbol"]) == {EQUITY}
    assert set(bars["market"]) == {"a_share"}
    assert set(bars["asset_class"]) == {ASSET_EQUITY}
    assert set(bars["source"]) == {"tushare"}


def test_rows_violating_the_shared_ohlc_invariant_are_dropped() -> None:
    """Same canonical check every online loader runs (``loaders.base.validate_ohlc``)."""
    frame = source_frame()
    frame.loc[SESSIONS[0], "high"] = frame.loc[SESSIONS[0], "low"] - 1.0
    frame.loc[SESSIONS[1], "close"] = 0.0

    bars, report = gate(frame)

    assert len(bars) == 1
    assert report.dropped["ohlc_invariant"] == 2


def test_a_row_with_a_missing_price_is_dropped() -> None:
    frame = source_frame()
    frame.loc[SESSIONS[1], "open"] = float("nan")

    bars, report = gate(frame)

    assert len(bars) == 2
    assert report.dropped["missing_ohlc"] == 1


def test_a_frame_missing_ohlc_columns_raises_rather_than_storing_half_a_bar() -> None:
    frame = source_frame().drop(columns=["low"])

    with pytest.raises(WarehouseConfigError, match="low"):
        gate(frame)


def test_an_empty_frame_returns_the_empty_contract_frame() -> None:
    bars, report = gate(source_frame(SESSIONS[:0]))

    assert list(bars.columns) == list(BAR_COLUMNS)
    assert bars.empty and report.is_clean
    assert report.rows_in == 0


def test_a_frame_with_nothing_but_bad_rows_stores_nothing() -> None:
    bars, report = gate(source_frame(volume=[0.0, 0.0, 0.0]))

    assert bars.empty
    assert report.rows_out == 0
    assert report.dropped["zero_volume"] == 3


def test_timestamps_may_arrive_as_a_named_column_or_an_index() -> None:
    expected = [str(stamp.date()) for stamp in SESSIONS]
    frame = source_frame()

    for column in ("trade_date", "date", "datetime", "time", "timestamp"):
        flat = frame.reset_index()
        if column != "trade_date":
            flat = flat.rename(columns={"trade_date": column})
        bars, _report = gate(flat)
        assert [str(stamp.date()) for stamp in bars["session_date"]] == expected, column


def test_a_multi_indexed_source_frame_is_keyed_on_its_named_date_level() -> None:
    """Criterion 2: a panel-shaped MultiIndex must key on the session, not guess."""
    frame = source_frame().reset_index()
    frame["symbol_in_index"] = [EQUITY] * len(frame)
    framed = frame.set_index(["symbol_in_index", "trade_date"])

    bars, report = gate(framed)

    assert report.rows_in == len(SESSIONS)
    assert [str(stamp.date()) for stamp in bars["session_date"]] == [
        "2020-01-06", "2020-01-07", "2020-01-08"
    ]
    assert list(bars.columns) == list(BAR_COLUMNS)
    assert "symbol_in_index" not in bars.columns, "a merge artifact is not a warehouse column"


def test_a_multi_index_without_a_named_session_level_is_refused() -> None:
    """A level that merely happens to hold dates is not evidence of a session."""
    framed = source_frame().reset_index(drop=True)
    framed.index = pd.MultiIndex.from_arrays(
        [[EQUITY] * len(SESSIONS), SESSIONS], names=["symbol", "row_two"]
    )

    with pytest.raises(WarehouseConfigError, match="no timestamp column"):
        gate(framed)


def test_naive_and_aware_stamps_land_on_the_same_utc_day() -> None:
    """The stored column means one thing, or a partition is keyed ambiguously."""
    aware = source_frame()
    aware.index = pd.DatetimeIndex(
        [f"{day} 15:00" for day in ("2020-01-06", "2020-01-07", "2020-01-08")],
        tz="Asia/Shanghai",
    )

    bars, _report = gate(aware)

    assert [str(stamp) for stamp in bars["session_date"]] == [
        "2020-01-06 07:00:00",
        "2020-01-07 07:00:00",
        "2020-01-08 07:00:00",
    ], "15:00 in Shanghai is 07:00 UTC, and the warehouse stores naive UTC"


def test_a_source_with_no_stamps_at_all_is_refused() -> None:
    frame = source_frame().reset_index(drop=True)

    with pytest.raises(WarehouseConfigError, match="no timestamp column"):
        gate(frame)


def test_bar_duration_understands_the_runner_intervals_only() -> None:
    assert bar_duration("1m") == pd.Timedelta(minutes=1)
    assert bar_duration("4H") == pd.Timedelta(hours=4)
    assert bar_duration("1d") == pd.Timedelta(days=1)
    with pytest.raises(ValueError, match="unsupported interval"):
        bar_duration("1w")


# ---------------------------------------------------------------------------
# Classification
# ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "symbol,expected",
    [
        (INDEX, ASSET_INDEX),
        ("399001.SZ", ASSET_INDEX),
        (EQUITY, ASSET_EQUITY),
        ("000001.SZ", ASSET_EQUITY),
        ("600000.SH", ASSET_EQUITY),
        ("00700.HK", ASSET_EQUITY),
        (ETF, ASSET_FUND),
        ("159915.SZ", ASSET_FUND),
        ("BTC-USDT", ASSET_OTHER),
    ],
)
def test_classify_asset_covers_the_a_share_address_space(symbol: str, expected: str) -> None:
    assert classify_asset(symbol)[1] == expected


@pytest.mark.parametrize("code", ["000300.SH", "399001.SZ", "600519.SH", "BTC-USDT", "SPY"])
def test_index_detection_matches_the_loader_that_routes_the_request(code: str) -> None:
    """Two implementations of one rule must not disagree about which endpoint serves a name."""
    assert _is_index(code) == (classify_asset(code)[1] == ASSET_INDEX)


def test_a_precomputed_market_is_honoured_and_every_class_is_known() -> None:
    assert classify_asset("600519.SH", "us_equity") == ("us_equity", ASSET_EQUITY)
    assert classify_asset("SPY", "us_equity") == ("us_equity", ASSET_EQUITY)
    assert set(ASSET_CLASSES) == {ASSET_EQUITY, ASSET_FUND, ASSET_INDEX, ASSET_OTHER}


# ---------------------------------------------------------------------------
# The read-side view of the same rule
# ---------------------------------------------------------------------------


def test_factor_holes_reports_sessions_without_a_usable_factor() -> None:
    bars, _report = gate(source_frame())
    bars.loc[bars.index[1], "adj_factor"] = float("nan")

    holes = factor_holes(bars)

    assert [str(stamp.date()) for stamp in holes] == ["2020-01-07"]


def test_factor_holes_is_empty_for_a_clean_or_index_partition() -> None:
    bars, _report = gate(source_frame())
    index_bars, _index_report = gate(source_frame(factor=None), symbol=INDEX)

    assert factor_holes(bars).empty
    assert factor_holes(index_bars).empty, "an index legitimately stores no factor"
    assert factor_holes(empty_bars()).empty


def test_reject_report_counts_and_cleanliness_agree() -> None:
    _bars, report = gate(source_frame(volume=[1000.0, 1000.0, 0.0]))

    assert report.rows_in == 3
    assert report.total_dropped == 1
    assert not report.is_clean
    payload = report.to_dict()
    assert payload["dropped"]["zero_volume"] == 1
    assert payload["pending_dates"] == []
    assert payload["rows_out"] == 2
