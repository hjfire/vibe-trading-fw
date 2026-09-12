"""Read-side contract of the ``warehouse`` loader.

The store writes raw bars plus a per-row factor; this file pins what the *read*
end promises back, because that is the surface a backtest or a factor bench
touches. Three claims matter most and each has a way to be wrong quietly:

* **Adjusted on read, anchored to the requested window.** A stored qfq series
  would be re-scaled by the next dividend, so ``2020-2023`` would stop matching
  the same slice of a ``2016-2026`` pull. The loader must therefore reproduce the
  online sources' caliber, including the fact that two windows ending on
  different dates report different *levels* and identical *returns*.
* **A halt is missing rows, never a placeholder row.** The engines align on each
  symbol's own index and forward-fill with a limit, so a synthesized
  "price did not move" row would defeat that and quietly change returns.
* **No silent network fallback.** A run that was told to read local disk and got
  Tencent instead is not the run that was asked for.
"""

from __future__ import annotations

import logging
from pathlib import Path

import pandas as pd
import pytest

from backtest.engines.base import _align
from backtest.loaders.base import NoAvailableSourceError
from backtest.loaders import registry
from backtest.warehouse import store
from backtest.warehouse.layout import normalize_interval
from backtest.warehouse.loader import ENABLE_ENV_VAR, DataLoader, disabled_reason, has_bars
from backtest.warehouse.schema import (
    ASSET_EQUITY,
    BAR_COLUMNS,
    WarehouseConfigError,
    classify_asset,
    normalize_bars,
    storable_markets,
    canonical_units,
)

WAREHOUSE_LOGGER = "backtest.warehouse.loader"

#: Sessions Mon-Fri of the first full 2020 week. Historical on purpose: the
#: write gate drops bars that have not closed yet.
_WEEK = pd.DatetimeIndex(
    ["2020-01-02", "2020-01-03", "2020-01-06", "2020-01-07", "2020-01-08", "2020-01-09", "2020-01-10"]
)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


def _raw_frame(
    index: pd.DatetimeIndex,
    *,
    close: float | list[float],
    factor: list[float] | None,
    volume: float = 1000.0,
    amount: float = 5000.0,
) -> pd.DataFrame:
    """Build one source-shaped frame (raw prices, optional factor column)."""
    closes = [close] * len(index) if isinstance(close, (int, float)) else list(close)
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
    if factor is not None:
        frame["adj_factor"] = list(factor)
    return frame


def _seed(
    root: Path,
    symbol: str,
    frame: pd.DataFrame,
    *,
    interval: str = "1D",
    source: str = "tushare",
) -> store.WriteResult:
    """Push one source frame through the real write gate into *root*."""
    bars, _report = normalize_bars(
        frame,
        symbol=symbol,
        interval=interval,
        source=source,
        volume_unit="lots",
        amount_unit="cny_thousand",
    )
    return store.write_bars(bars, interval=interval, root=root)


@pytest.fixture()
def ex_date_store(tmp_path: Path) -> Path:
    """Warehouse with a factor step, a halt gap and a factorless index.

    ``600519.SH`` goes ex-rights on 2020-01-08: the raw close halves (100 -> 50)
    while the factor doubles (1.0 -> 2.0), and 2020-01-06/07 are missing rows
    (halted). ``000300.SH`` is an index, which legitimately stores no factor.
    """
    root = tmp_path / "warehouse"
    halted = _WEEK.drop(["2020-01-06", "2020-01-07"])
    _seed(
        root,
        "600519.SH",
        _raw_frame(
            halted,
            close=[100.0, 100.0, 50.0, 50.0, 50.0],
            factor=[1.0, 1.0, 2.0, 2.0, 2.0],
        ),
    )
    _seed(root, "000300.SH", _raw_frame(_WEEK, close=4000.0, factor=None))
    return root


@pytest.fixture()
def enabled(monkeypatch):
    """Turn the feature on through the real config layer."""
    from src.config.accessor import reset_env_config

    monkeypatch.setenv(ENABLE_ENV_VAR, "true")
    reset_env_config()
    yield
    reset_env_config()


def _loader(root: Path, **kwargs) -> DataLoader:
    """Return an enabled loader reading *root*."""
    loader = DataLoader(root=root, **kwargs)
    return loader


# ---------------------------------------------------------------------------
# Registration: the name exists, and it exists on its own terms
# ---------------------------------------------------------------------------


def test_registered_under_its_own_name() -> None:
    registry._ensure_registered()
    assert registry.LOADER_REGISTRY["warehouse"] is DataLoader
    assert registry.LOADER_REGISTRY["warehouse"].name == "warehouse"


def test_is_a_valid_source_but_in_no_fallback_chain() -> None:
    """Selectable by name, invisible to ``auto``.

    A chain member must be permutation-safe: ``is_valid_source_order`` compares a
    user's saved ``MARKET_DATA_ORDER_*`` against the written defaults including
    membership, so adding a name to a chain would invalidate every saved order.
    """
    assert "warehouse" in registry.VALID_SOURCES
    for market, chain in registry.FALLBACK_CHAINS.items():
        assert "warehouse" not in chain, f"{market} chain would ask an opt-in store"


def test_declares_its_caliber_so_mixing_cannot_be_silent() -> None:
    """The reason a distinct source name exists at all.

    Provenance is stamped ``(loader.name, price_caliber(name, market))``, and
    ``mixed_caliber_warning`` ignores "unknown". Reusing ``local`` would have left
    this store at "unknown" and let raw and adjusted bars share a basket with no
    warning.
    """
    assert registry.price_caliber("warehouse", "a_share") == "split_dividend"
    warning = registry.mixed_caliber_warning(
        {"600519.SH": ("warehouse", registry.price_caliber("warehouse", "a_share")),
         "300750.SZ": ("sina", registry.price_caliber("sina", "a_share"))}
    )
    assert warning, "a warehouse/live mix must be reported, not averaged"
    # The other half: choosing the same caliber the online A-share path serves
    # must not cry wolf, or the warning stops being read.
    assert registry.mixed_caliber_warning(
        {"600519.SH": ("warehouse", "split_dividend"), "300750.SZ": ("tushare", "split_dividend")}
    ) is None


def test_markets_and_units_are_derived_from_the_write_gate() -> None:
    """A market is servable exactly when it is writable, never a day earlier.

    The read side declares no literal list, so widening ``_CANONICAL_UNITS``
    extends the loader and this test follows automatically.
    """
    assert DataLoader.markets == set(storable_markets())
    assert DataLoader.volume_units == {
        market: canonical_units(market).volume_unit for market in storable_markets()
    }
    assert DataLoader.requires_auth is False


# ---------------------------------------------------------------------------
# Availability: disabled, empty, or usable — and the message says which
# ---------------------------------------------------------------------------


def test_disabled_by_default_and_says_how_to_enable() -> None:
    reason = disabled_reason()
    assert ENABLE_ENV_VAR in reason
    assert "true" in reason
    assert DataLoader().is_available() is False


def test_enabled_but_empty_points_at_sync(monkeypatch, tmp_path, enabled) -> None:
    empty = tmp_path / "nothing_yet"
    reason = disabled_reason(empty)
    assert "sync" in reason
    assert has_bars(empty) is False
    assert DataLoader(root=empty).is_available() is False


def test_env_var_really_is_the_switch(tmp_path, ex_date_store, enabled) -> None:
    """``is_available()`` must follow the config layer, not a module constant."""
    from backtest.warehouse.layout import warehouse_enabled

    assert warehouse_enabled() is True
    assert DataLoader(root=ex_date_store).is_available() is True
    assert has_bars(tmp_path / "unused") is False


def test_unavailable_warehouse_never_reroutes_to_the_network(monkeypatch, tmp_path) -> None:
    """The error text is copy-pasteable: same sentence the CLI prints."""
    monkeypatch.delenv(ENABLE_ENV_VAR, raising=False)
    from src.config.accessor import reset_env_config

    reset_env_config()
    registry._ensure_registered()
    with pytest.raises(NoAvailableSourceError) as excinfo:
        registry.get_loader_cls_with_fallback("warehouse")
    assert ENABLE_ENV_VAR in str(excinfo.value)


# ---------------------------------------------------------------------------
# fetch(): the bars, the caliber, and what a gap looks like
# ---------------------------------------------------------------------------


def test_fetch_returns_qfq_levels_over_an_ex_date(ex_date_store, enabled) -> None:
    frame = _loader(ex_date_store).fetch(["600519.SH"], "2020-01-02", "2020-01-10")["600519.SH"]
    # Raw 100 * (1.0 / 2.0) == 50, so the mechanical halving is removed and the
    # series is flat across the ex-date: no fabricated -50% day.
    assert frame["close"].round(6).tolist() == [50.0] * 5
    assert frame["close"].pct_change().dropna().eq(0.0).all()
    # amount is a cash figure; volume is divided by the same ratio as prices.
    assert frame["amount"].tolist() == [5000.0] * 5
    assert frame["volume"].iloc[0] == pytest.approx(2000.0)
    assert frame["volume"].iloc[-1] == pytest.approx(1000.0)
    assert "adj_factor" not in frame.columns, "the factor is storage metadata, not a bar"


def test_fetch_raw_mode_leaves_stored_prices_alone(ex_date_store, enabled) -> None:
    frame = _loader(ex_date_store, adjust="raw").fetch(
        ["600519.SH"], "2020-01-02", "2020-01-10"
    )["600519.SH"]
    assert frame["close"].tolist() == [100.0, 100.0, 50.0, 50.0, 50.0]
    assert frame["close"].pct_change().dropna().min() == pytest.approx(-0.5), (
        "raw mode must stay raw: hiding the -50% here would mean the store had "
        "decided the ex-date return instead of the reader"
    )


def test_halt_contributes_missing_rows_not_placeholder_rows(ex_date_store, enabled) -> None:
    """停牌 reads as absent sessions, which is what the engine alignment expects."""
    frame = _loader(ex_date_store).fetch(["600519.SH"], "2020-01-02", "2020-01-10")["600519.SH"]
    assert list(frame.index.strftime("%Y-%m-%d")) == [
        "2020-01-02", "2020-01-03", "2020-01-08", "2020-01-09", "2020-01-10",
    ]
    assert frame.index.name == "trade_date"
    assert not frame.index.duplicated().any()


def test_a_long_halt_stays_untradable_after_engine_alignment(tmp_path, enabled) -> None:
    """The payoff of "a halt is missing rows": what the engine does with them.

    ``_align`` forward-fills with a limit of 5 bars for a single market, so a
    14-session halt has to leave 9 unusable rows in the trading view. Had the
    warehouse filled the halt with "price did not move" rows, the count would be
    zero and a backtest would trade a name that was not trading — while the
    unbounded valuation view would still carry the last traded close, because
    marking a position is a different question from deciding one.
    """
    root = tmp_path / "warehouse"
    calendar = pd.bdate_range("2020-01-02", periods=20)
    halted = calendar[[0, 1, 2, 17, 18, 19]]  # 14 sessions with no bar at all
    _seed(root, "600000.SH", _raw_frame(calendar, close=100.0, factor=[1.0] * 20))
    _seed(root, "600519.SH", _raw_frame(halted, close=100.0, factor=[1.0] * len(halted)))

    data_map = _loader(root).fetch(["600000.SH", "600519.SH"], "2020-01-02", "2020-01-31")
    signal_map = {
        symbol: pd.Series(1.0, index=frame.index) for symbol, frame in data_map.items()
    }

    dates, close, close_val, _positions, _returns = _align(
        data_map, signal_map, ["600000.SH", "600519.SH"]
    )

    assert len(dates) == 20, "the grid is the union of the two calendars"
    assert int(close["600519.SH"].isna().sum()) == 9, "14 halted bars, 5 carried by the limit"
    assert not close["600000.SH"].isna().any(), "the peer is untouched by the halt"
    assert int(close_val["600519.SH"].isna().sum()) == 0, "valuation carries the last close"
    assert close.loc[dates[17], "600519.SH"] == 100.0, "trading resumes on its own bar"


def test_qfq_level_is_anchored_to_the_window_that_was_asked_for(ex_date_store, enabled) -> None:
    """Short window ends before the ex-date, so its levels are 2x the long one.

    This is the online caliber reproduced, not a compromise: the anchor is the
    last factor *of the requested window*. What has to survive is the return
    series, which is why the comparison below is on ``pct_change`` and not on
    price levels.
    """
    loader = _loader(ex_date_store)
    short = loader.fetch(["600519.SH"], "2020-01-02", "2020-01-03")["600519.SH"]
    long = loader.fetch(["600519.SH"], "2020-01-02", "2020-01-10")["600519.SH"]
    assert short["close"].tolist() == [100.0, 100.0]
    assert float(short["close"].iloc[0]) == 2.0 * float(long["close"].iloc[0])
    shared = long.index.intersection(short.index)
    assert len(shared) == 2


def _plant_factorless_equity(root: Path, symbol: str) -> None:
    """Write an equity partition the write gate would never have produced.

    :func:`backtest.warehouse.schema.normalize_bars` is bypassed on purpose. The
    read-side guard exists for a hand-edited or older partition, and the only way
    to exercise it is to make the illegal thing on disk.
    """
    frame = _raw_frame(_WEEK, close=10.0, factor=None).rename_axis("session_date").reset_index()
    frame["symbol"] = symbol
    frame["market"] = "a_share"
    frame["asset_class"] = ASSET_EQUITY
    frame["adj_factor"] = float("nan")
    frame["source"] = "tushare"
    store.write_bars(frame[list(BAR_COLUMNS)], interval="1D", root=root)


def test_factorless_index_still_serves_and_factorless_equity_does_not(
    ex_date_store, enabled, caplog
) -> None:
    """An index level is already continuous; an equity without factors is not data."""
    loader = _loader(ex_date_store)
    index = loader.fetch(["000300.SH"], "2020-01-02", "2020-01-10")
    assert list(index["000300.SH"]["close"].round(6).tolist()) == [4000.0] * 7
    assert classify_asset("000300.SH")[1] == "index"

    # The write gate refuses such a source outright, so the refusal is stated
    # first and the read guard second: two independent layers, both tested.
    with pytest.raises(WarehouseConfigError) as excinfo:
        normalize_bars(
            _raw_frame(_WEEK, close=10.0, factor=None),
            symbol="600000.SH",
            interval="1D",
            source="tushare",
            volume_unit="lots",
        )
    assert "adj_factor" in str(excinfo.value)

    root = ex_date_store.parent / "no_factors"
    _plant_factorless_equity(root, "600000.SH")
    with caplog.at_level(logging.WARNING, logger="backtest.warehouse.store"):
        assert _loader(root).fetch(["600000.SH"], "2020-01-02", "2020-01-10") == {}
    assert "factor" in caplog.text, "skipping a symbol must be announced, not silent"


# ---------------------------------------------------------------------------
# fetch(): what it refuses to do
# ---------------------------------------------------------------------------


def test_interval_alias_reads_the_same_tree_both_ways(tmp_path, enabled) -> None:
    """`1d`, `daily` and `1D` are one directory, decided at the path boundary."""
    root = tmp_path / "alias"
    _seed(root, "600519.SH", _raw_frame(_WEEK, close=100.0, factor=[1.0] * 7), interval="1d")
    assert store.stored_symbols(interval="1D", root=root) == ["600519.SH"]
    assert normalize_interval("daily") == "1D"
    loader = _loader(root)
    for spelling in ("1D", "1d", "daily"):
        frames = loader.fetch(["600519.SH"], "2020-01-02", "2020-01-10", interval=spelling)
        assert len(frames["600519.SH"]) == 7, spelling


def test_unstored_interval_answers_empty_and_says_so(ex_date_store, enabled, caplog) -> None:
    loader = _loader(ex_date_store)
    with caplog.at_level(logging.WARNING, logger=WAREHOUSE_LOGGER):
        assert loader.fetch(["600519.SH"], "2020-01-02", "2020-01-10", interval="5m") == {}
    text = caplog.text
    assert "5m" in text and "1D" in text
    assert "sync" in text, "the message must carry the fix, not just the refusal"


def test_field_requests_are_reported_not_silently_dropped(ex_date_store, enabled, caplog) -> None:
    loader = _loader(ex_date_store)
    with caplog.at_level(logging.WARNING, logger=WAREHOUSE_LOGGER):
        frames = loader.fetch(
            ["600519.SH"], "2020-01-02", "2020-01-10", fields=["close", "pe_ttm"]
        )
    assert len(frames["600519.SH"]) == 5  # still served: bars are not the issue
    assert "pe_ttm" in caplog.text


def test_unusable_arguments_do_not_reach_disk(ex_date_store, enabled) -> None:
    loader = _loader(ex_date_store)
    assert loader.fetch([], "2020-01-02", "2020-01-10") == {}
    assert loader.fetch(["  "], "2020-01-02", "2020-01-10") == {}
    with pytest.raises(ValueError):
        loader.fetch(["600519.SH"], "2020-01-10", "2020-01-02")
    with pytest.raises(ValueError):
        DataLoader(adjust="hfq")


def test_symbols_with_no_rows_in_the_window_are_absent(ex_date_store, enabled) -> None:
    frames = _loader(ex_date_store).fetch(
        ["600519.SH", "600000.SH"], "2021-01-04", "2021-01-08"
    )
    assert frames == {}, "an empty window must not be padded into existence"


# ---------------------------------------------------------------------------
# Introspection used by the CLI and run cards
# ---------------------------------------------------------------------------


def test_coverage_describes_the_files_not_the_resume_state(ex_date_store, enabled) -> None:
    coverage = _loader(ex_date_store).coverage(["600519.SH", "000300.SH", "600000.SH"])
    assert coverage["600519.SH"] == ("2020-01-02", "2020-01-10", 5)
    assert coverage["000300.SH"][2] == 7
    assert "600000.SH" not in coverage


def test_intervals_lists_what_is_on_disk(ex_date_store, enabled) -> None:
    assert _loader(ex_date_store).intervals() == ["1D"]


def test_frame_attrs_record_which_directory_answered(ex_date_store, enabled) -> None:
    from backtest.warehouse.loader import frame_attrs

    loader = _loader(ex_date_store)
    frames = loader.fetch(["600519.SH"], "2020-01-02", "2020-01-10")
    meta = frame_attrs(frames, source_root=ex_date_store)
    assert Path(meta["bars_root"]) == ex_date_store / "bars"
    assert frames["600519.SH"].attrs["warehouse_bars"] == meta["bars_root"]
