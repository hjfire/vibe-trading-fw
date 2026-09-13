"""The free warehouse source: akshare/Sina must clear the same gate as tushare.

``warehouse.sync.load_source`` admits a source only if it can deliver unadjusted
prices *plus* a factor, and until now exactly one loader did (tushare, which needs
a token). These tests run against a stubbed ``akshare`` so nothing here touches
the network, and they are aimed at the three ways a port of that contract goes
wrong in practice:

1. a vendor factor table is sparse (one row per ex-date) while the write gate
   wants one factor per session;
2. a *divisor* table (Sina's qfq factor) is positive and present, so the gate
   cannot tell it from a cumulative multiplier — but re-anchoring with it scales
   history the wrong way;
3. Sina quotes volume in shares while the A-share canonical unit is board lots,
   and ``volume_units`` is declared per source rather than per endpoint.
"""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pandas as pd
import pytest

from backtest.loaders import registry
from backtest.loaders.akshare_loader import (
    DataLoader,
    _date_value_columns,
    _sina_bars,
    _sina_factor,
    _sina_stock_symbol,
    _with_exchange_suffix,
)
from backtest.loaders.cn_adjust import apply_qfq
from backtest.warehouse import sync
from backtest.warehouse.schema import normalize_bars

_SYMBOL = "600519.SH"
_SESSIONS = pd.DatetimeIndex(
    ["2024-06-17", "2024-06-18", "2024-06-19", "2024-06-20", "2024-06-21"]
)
#: 2024-06-19 is the ex-dividend day: the factor table carries one row per
#: change, which is exactly the shape that must not be handed to the store raw.
_FACTOR_DATES = ["2023-01-04", "2024-06-19"]
_FACTOR_VALUES = [1.0, 1.35]


def _raw_frame() -> pd.DataFrame:
    """Sina's ``adjust=""`` shape: as-traded prices, volume in shares."""
    close = [1700.0, 1690.0, 1520.0, 1530.0, 1540.0]
    volume = [3_000_000.0] * 5
    return pd.DataFrame(
        {
            "date": [d.date() for d in _SESSIONS],
            "open": [c - 5.0 for c in close],
            "high": [c + 10.0 for c in close],
            "low": [c - 20.0 for c in close],
            "close": close,
            "volume": volume,
            "amount": [c * v for c, v in zip(close, volume)],
            "outstanding_share": [125_619.78] * 5,
            "turnover": [v / (125_619.78 * 10_000) for v in volume],
        }
    )


def _factor_frame(dates: list[str], values: list[float]) -> pd.DataFrame:
    """akshare's ``adjust="hfq-factor"`` shape after its own ``reset_index()``."""
    return pd.DataFrame(
        {"index": pd.to_datetime(dates), "hfq_factor": values},
    )


def _stub_akshare(
    *,
    raw: Any = None,
    factor: Any = None,
    factor_error: Exception | None = None,
) -> tuple[SimpleNamespace, list[dict[str, str]]]:
    """A fake ``akshare`` module recording how it was called."""
    calls: list[dict[str, str]] = []
    raw = _raw_frame() if raw is None else raw
    factor = _factor_frame(_FACTOR_DATES, _FACTOR_VALUES) if factor is None else factor

    def stock_zh_a_daily(**kwargs):
        calls.append({"adjust": str(kwargs.get("adjust", ""))})
        if kwargs.get("adjust") == "hfq-factor":
            if factor_error is not None:
                raise factor_error
            return factor
        return raw

    return SimpleNamespace(stock_zh_a_daily=stock_zh_a_daily), calls


# ---------------------------------------------------------------------------
# The admission gate
# ---------------------------------------------------------------------------


def test_akshare_now_passes_the_warehouse_admission_gate() -> None:
    """``warehouse sync --source akshare`` is the free path; it used to raise."""
    registry._ensure_registered()
    loader = sync.load_source("akshare")
    assert hasattr(loader, "fetch_raw_with_factor")
    assert loader.is_available() is True


def test_the_capability_list_is_computed_from_the_registry() -> None:
    """A hardcoded "only tushare" sentence would have gone stale today."""
    capable = sync.factor_capable_sources()
    assert "akshare" in capable
    assert "tushare" in capable
    assert "tencent" not in capable, "a qfq-only source must not be offered as a way in"


def test_a_source_without_factors_is_told_which_ones_have_them() -> None:
    with pytest.raises(sync.SyncConfigError, match="Sources that can:") as exc:
        sync.load_source("tencent")
    assert "akshare" in str(exc.value)


def test_an_unavailable_default_names_the_free_alternative(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Without a token the run must end in a pasteable command, not a dead end."""
    class Tokenless:
        name = "tokenless"

        def fetch_raw_with_factor(self, *_args, **_kwargs):  # pragma: no cover
            raise AssertionError("must not be reached")

        def is_available(self) -> bool:
            return False

    registry._ensure_registered()
    monkeypatch.setitem(registry.LOADER_REGISTRY, "tokenless", Tokenless)

    with pytest.raises(sync.SyncConfigError, match=r"try --source <") as exc:
        sync.load_source("tokenless")
    assert "akshare" in str(exc.value)
    assert "tokenless" not in str(exc.value).split("try --source")[1]


def test_a_source_with_no_way_to_name_the_index_is_told_to_name_stocks() -> None:
    """The refusal belongs to a source that cannot resolve a roster at all.

    It used to be akshare's sentence too, which is why it is pinned with a stub
    here: refusing without the alternative reads as "this source cannot sync",
    and the command that got here is the one the docs print first.
    """
    class NoRoster:
        name = "no-roster"

        def fetch_raw_with_factor(self, *_args, **_kwargs):  # pragma: no cover
            raise AssertionError("must not be reached")

    with pytest.raises(sync.SyncConfigError, match="index-weight") as exc:
        sync.resolve_universe(
            "csi300", start="2024-01-01", end="2024-06-30", loader=NoRoster()
        )
    assert "--symbols" in str(exc.value)


# ---------------------------------------------------------------------------
# The named roster, without a token
# ---------------------------------------------------------------------------


def _cons_frame(sh: int = 150, sz: int = 150, date: str = "2026-09-11") -> pd.DataFrame:
    """The CSIndex constituent table: one row per member, as of a single date."""
    return pd.DataFrame(
        [
            {"日期": date, "成分券代码": f"{600000 + i:06d}", "交易所": "上海证券交易所"}
            for i in range(sh)
        ]
        + [
            {"日期": date, "成分券代码": f"{i + 1:06d}", "交易所": "深圳证券交易所"}
            for i in range(sz)
        ]
    )


def _stub_csindex(frame: Any) -> SimpleNamespace:
    """A fake ``akshare`` exposing only the compiler's constituent table."""

    def index_stock_cons_csindex(*, symbol: str):
        return frame

    return SimpleNamespace(index_stock_cons_csindex=index_stock_cons_csindex)


def test_the_exchange_column_wins_and_a_malformed_code_is_dropped() -> None:
    assert _with_exchange_suffix("000001", "上海证券交易所") == "000001.SH"
    assert _with_exchange_suffix("600519", "深圳证券交易所") == "600519.SZ"
    # No exchange text at all: fall back to the code prefix.
    assert _with_exchange_suffix("600519", "") == "600519.SH"
    assert _with_exchange_suffix("000001", None) == "000001.SZ"
    # Not a stock code: refuse rather than guess a suffix onto a name that never
    # existed in the index.
    assert _with_exchange_suffix("12345", "深圳证券交易所") is None
    assert _with_exchange_suffix("H30199", "上海证券交易所") is None


def test_the_free_source_can_name_todays_index_members() -> None:
    monkey = pytest.MonkeyPatch()
    monkey.setitem(__import__("sys").modules, "akshare", _stub_csindex(_cons_frame()))
    try:
        codes, snapshot = DataLoader().fetch_universe_members("csi300")
    finally:
        monkey.undo()

    assert len(codes) == 300
    assert snapshot == "2026-09-11"
    assert "600000.SH" in codes and "000001.SZ" in codes
    assert all(code.endswith((".SH", ".SZ")) for code in codes)
    assert DataLoader().fetch_universe_members("sse50") is None, (
        "a name this source cannot resolve is left for the caller to refuse"
    )


def test_a_short_roster_is_refused_rather_than_synced_as_an_index() -> None:
    """40 names under the flag `--universe csi300` is a partial download.

    Filling the store with 13% of an index and calling it CSI 300 is worse than
    failing: every downstream panel would silently be about the wrong market.
    """
    monkey = pytest.MonkeyPatch()
    monkey.setitem(
        __import__("sys").modules, "akshare", _stub_csindex(_cons_frame(sh=20, sz=20))
    )
    try:
        with pytest.raises(RuntimeError, match="below the") as exc:
            DataLoader().fetch_universe_members("csi300")
    finally:
        monkey.undo()
    assert "40 names" in str(exc.value)


def test_resolve_universe_without_a_token_still_returns_the_names() -> None:
    """`--universe csi300 --source akshare` is the command a token-less install types."""
    monkey = pytest.MonkeyPatch()
    monkey.setitem(__import__("sys").modules, "akshare", _stub_csindex(_cons_frame()))
    try:
        roster = sync.resolve_universe(
            "csi300", start="2016-09-11", end="2026-09-11", loader=DataLoader()
        )
    finally:
        monkey.undo()

    assert len(roster.codes) == 300
    assert roster.universe == "csi300"
    assert "akshare" in roster.constituent_source
    assert roster.constituent_source_date == "2026-09-11"


def test_a_snapshot_roster_is_never_stored_as_point_in_time_membership(
    tmp_path,
) -> None:
    """The whole honesty of the free path is this one assertion.

    The compiler publishes who is in the index *today*. Writing that as a
    membership matrix would make a 2016 panel of 2026's winners look resolved, so
    the matrix stays empty and no roster file is written — which is what lets a
    reader report ``survivorship_bias=true`` instead of trusting a roster nobody
    resolved.
    """
    monkey = pytest.MonkeyPatch()
    monkey.setitem(__import__("sys").modules, "akshare", _stub_csindex(_cons_frame()))
    try:
        roster = sync.resolve_universe(
            "csi300", start="2016-09-11", end="2026-09-11", loader=DataLoader()
        )
    finally:
        monkey.undo()

    assert roster.membership is None
    assert roster.pit_membership is False
    assert roster.persist(root=tmp_path) is None
    assert list(tmp_path.rglob("*")) == [], "a snapshot must not reach the roster table"


def test_a_roster_call_that_fails_ends_in_a_pasteable_command() -> None:
    """A network failure here is a config error with a way out, not a traceback."""
    monkey = pytest.MonkeyPatch()
    monkey.setitem(
        __import__("sys").modules,
        "akshare",
        SimpleNamespace(
            index_stock_cons_csindex=lambda **_kw: (_ for _ in ()).throw(
                RuntimeError("connection reset")
            )
        ),
    )
    try:
        with pytest.raises(sync.SyncConfigError, match="could not resolve the roster") as exc:
            sync.resolve_universe(
                "csi300", start="2024-01-01", end="2024-06-30", loader=DataLoader()
            )
    finally:
        monkey.undo()

    assert "--symbols" in str(exc.value)
    assert "connection reset" in str(exc.value), "the real reason must survive the wrap"


# ---------------------------------------------------------------------------
# Bars: as-traded prices, volume in the canonical unit
# ---------------------------------------------------------------------------


def test_bars_are_unadjusted_with_volume_in_board_lots() -> None:
    raw = _raw_frame()
    bars = _sina_bars(raw)

    assert bars.index.name == "trade_date"
    assert list(bars.index) == list(_SESSIONS)
    # Prices pass through untouched: the store re-anchors on read, so a corrected
    # price here would be double-applied later.
    assert bars["close"].tolist() == raw["close"].tolist()
    assert bars["volume"].tolist() == [30_000.0] * 5


def test_a_lot_quoted_volume_is_refused_rather_than_stored_100x_low() -> None:
    """The #1062 failure class, caught by measurement instead of by documentation."""
    raw = _raw_frame()
    raw["volume"] = raw["volume"] / 100.0  # board lots, with amount left per share
    with pytest.raises(ValueError, match="not in shares"):
        _sina_bars(raw)


def test_the_sina_symbol_gate_only_accepts_sh_shenzhen_stocks() -> None:
    assert _sina_stock_symbol("600519.SH") == "sh600519"
    assert _sina_stock_symbol("000001.SZ") == "sz000001"
    # ETF: stock_zh_a_daily has no fund factor table to give it.
    assert _sina_stock_symbol("518880.SH") is None
    # Beijing and malformed codes are not this endpoint's market.
    assert _sina_stock_symbol("832000.BJ") is None
    assert _sina_stock_symbol("AAPL.US") is None


# ---------------------------------------------------------------------------
# Factors: sparse to dense, and only in the direction the store can use
# ---------------------------------------------------------------------------


def test_sparse_factor_expands_to_one_row_per_session() -> None:
    ak, _ = _stub_akshare()
    bars = _sina_bars(_raw_frame())

    factor = _sina_factor(ak, "sh600519", bars.index)

    assert list(factor.columns) == ["trade_date", "adj_factor"]
    assert len(factor) == len(bars), "the write gate wants a factor per bar, not per ex-date"
    assert factor["adj_factor"].tolist() == [1.0, 1.0, 1.35, 1.35, 1.35]


def test_a_window_before_the_first_factor_is_left_a_hole_not_a_guess() -> None:
    """ffill only: back-filling would publish a factor before it existed."""
    ak, _ = _stub_akshare()
    early = pd.DatetimeIndex(["2022-01-04", "2022-01-05", "2024-06-20"])

    factor = _sina_factor(ak, "sh600519", early)

    assert pd.isna(factor["adj_factor"].iloc[0])
    assert pd.isna(factor["adj_factor"].iloc[1])
    assert factor["adj_factor"].iloc[2] == pytest.approx(1.35)


def test_a_divisor_table_is_refused_before_it_can_invert_the_history() -> None:
    """Sina's qfq factor is applied as ``price / factor`` and *falls* over time.

    It is positive and present on every row, so nothing downstream would notice;
    the store's ``factor / factor_at_end`` re-anchoring would scale past bars up
    instead of down. Refusing it here is the only place that can.
    """
    ak, _ = _stub_akshare(factor=_factor_frame(_FACTOR_DATES, [1.35, 1.0]))
    bars = _sina_bars(_raw_frame())

    with pytest.raises(ValueError, match="not a cumulative multiplier") as exc:
        _sina_factor(ak, "sh600519", bars.index)
    # The message has to carry where and how much: "decreases by -0.0249 somewhere
    # in its history" made the first real refusal (000568.SZ) unanswerable without
    # fetching the vendor table by hand, and the negative magnitude read as a
    # double negative.
    assert "falls by 0.35 at 2024-06-19" in str(exc.value)


def test_a_dip_the_synced_window_never_reads_does_not_lose_the_symbol() -> None:
    """One bad row in 2002 must not cost the whole 2024 fill.

    This is 000568.SZ as the vendor actually published it: hfq factor 6.5515 on
    2002-10-28, 6.5267 on 2002-11-11 (a 0.38% dip), then back up to 10.44 and on
    to 40.24 today. Judged over its whole life the series is "not cumulative" and
    the symbol is refused for every window forever; judged over the window being
    stored, the dip is invisible and the bars are correct.
    """
    ak, _ = _stub_akshare(
        factor=_factor_frame(
            ["2002-10-28", "2002-11-11", "2024-06-19"], [6.5515517, 6.5266724, 8.9]
        )
    )
    bars = _sina_bars(_raw_frame())

    factor = _sina_factor(ak, "sz000568", bars.index)

    assert factor["adj_factor"].tolist() == [
        6.5266724, 6.5266724, 8.9, 8.9, 8.9
    ], "the pre-window row is the window's baseline, and the dip is not stored"


def test_a_dip_inside_the_window_is_still_refused() -> None:
    """Scoping the guard must not silence it where the bars would be wrong."""
    ak, _ = _stub_akshare(
        factor=_factor_frame(["2002-10-28", "2024-06-17", "2024-06-19"], [1.0, 8.9, 6.5])
    )
    bars = _sina_bars(_raw_frame())

    with pytest.raises(ValueError, match="not a cumulative multiplier") as exc:
        _sina_factor(ak, "sz000568", bars.index)
    assert "falls by 2.4 at 2024-06-19" in str(exc.value)


def test_the_factor_table_is_located_by_dtype_not_by_column_name() -> None:
    """akshare resets an unnamed index; the date column can come back as "index"."""
    frame = _factor_frame(_FACTOR_DATES, _FACTOR_VALUES)
    assert _date_value_columns(frame) == ("index", "hfq_factor")
    renamed = frame.rename(columns={"index": "dt", "hfq_factor": "qfq_factor"})
    assert _date_value_columns(renamed) == ("dt", "qfq_factor")
    with pytest.raises(ValueError, match="dated factor table"):
        _date_value_columns(pd.DataFrame({"date": [1, 2], "value": [3, 4]}))


# ---------------------------------------------------------------------------
# The loader's own contract
# ---------------------------------------------------------------------------


def test_factor_failure_returns_bars_with_none_factor() -> None:
    """A missing factor is a hole the next sync repairs, not a lost fetch."""
    ak, _ = _stub_akshare(factor_error=RuntimeError("sina said no"))
    loader = DataLoader()

    bars, factor = loader._fetch_sina_raw_pair(ak, _SYMBOL, "2024-06-17", "2024-06-21")

    assert factor is None
    assert len(bars) == len(_SESSIONS)


def test_unserved_symbols_are_skipped_without_raising() -> None:
    ak, calls = _stub_akshare()
    loader = DataLoader()

    assert loader._fetch_sina_raw_pair(ak, "AAPL.US", "2024-06-17", "2024-06-21") is None
    assert calls == [], "a symbol this endpoint cannot serve must not be requested"


def test_fetch_raw_with_factor_walks_every_code_and_keeps_the_good_ones() -> None:
    ak, calls = _stub_akshare()
    loader = DataLoader()
    monkey = pytest.MonkeyPatch()
    monkey.setitem(__import__("sys").modules, "akshare", ak)
    try:
        result = loader.fetch_raw_with_factor(
            [_SYMBOL, "518880.SH", "000001.SZ"], "2024-06-17", "2024-06-21"
        )
    finally:
        monkey.undo()

    assert set(result) == {_SYMBOL, "000001.SZ"}
    bars, factor = result[_SYMBOL]
    assert bars["close"].loc[_SESSIONS[0]] == 1700.0
    assert factor is not None and factor["adj_factor"].notna().all()
    # raw + factor per symbol; the ETF was skipped before any request.
    assert [c["adjust"] for c in calls] == ["", "hfq-factor", "", "hfq-factor"]


def test_non_daily_interval_is_rejected_not_silently_answered() -> None:
    ak, _ = _stub_akshare()
    loader = DataLoader()
    with pytest.raises(ValueError, match="daily bars only"):
        loader.fetch_raw_with_factor([_SYMBOL], "2024-06-17", "2024-06-21", interval="1H")


# ---------------------------------------------------------------------------
# End to end through the real write gate
# ---------------------------------------------------------------------------


def _through_the_gate(bars: pd.DataFrame, factor: pd.DataFrame | None) -> tuple[pd.DataFrame, Any]:
    merged = sync._merge_factor(bars, factor)
    return normalize_bars(
        merged,
        symbol=_SYMBOL,
        interval="1D",
        source="akshare",
        volume_unit="lots",
        amount_unit=None,
        now=pd.Timestamp("2030-01-01"),
    )


def test_the_gate_stores_every_row_without_a_pending_factor_hole() -> None:
    """The sparse-to-dense step is the whole difference between an empty store and a full one."""
    ak, _ = _stub_akshare()
    bars = _sina_bars(_raw_frame())

    stored, report = _through_the_gate(bars, _sina_factor(ak, "sh600519", bars.index))

    assert len(stored) == len(bars)
    assert report.dropped == {} or all(value == 0 for value in report.dropped.values())
    assert not report.pending_dates
    assert stored["adj_factor"].notna().all()


def test_read_side_reproduces_a_forward_adjusted_history() -> None:
    """Direction check on the real product path: qfq history sits *below* as-traded."""
    ak, _ = _stub_akshare()
    bars = _sina_bars(_raw_frame())
    stored, _ = _through_the_gate(bars, _sina_factor(ak, "sh600519", bars.index))

    frame = stored.set_index("session_date").sort_index()
    factor = pd.DataFrame(
        {"trade_date": frame.index, "adj_factor": frame["adj_factor"].to_numpy()}
    )
    adjusted = apply_qfq(frame[["open", "high", "low", "close", "volume"]], factor)

    assert adjusted is not None
    first, last = _SESSIONS[0], _SESSIONS[-1]
    # factor 1.0 at the start, 1.35 at the window end -> 1/1.35 scaling backwards.
    assert adjusted["close"].loc[first] == pytest.approx(1700.0 / 1.35)
    assert adjusted["close"].loc[last] == pytest.approx(1540.0)
    assert adjusted["volume"].loc[first] > adjusted["volume"].loc[last], (
        "share counts are divided by the same ratio the prices are multiplied by"
    )
