"""Pin the fork's own ``warehouse`` loader to the shared per-source contract.

Upstream's contract guard (``test_loader_contract.py``) enumerates every name in
``VALID_SOURCES``. ``warehouse`` is this fork's opt-in source, so it has to carry
its own suite - otherwise the guard only stays green by subtracting the one name
it was written to catch.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd

from backtest.warehouse import store
from backtest.warehouse.loader import DataLoader
from backtest.warehouse.schema import normalize_bars
from tests.loader_contract import assert_loader_contract

_SYMBOL = "600519.SH"
_WINDOW = ("2020-01-01", "2020-01-06")


def _raw_bars() -> pd.DataFrame:
    """Three unadjusted daily bars, the last one carrying a split factor."""
    return pd.DataFrame(
        {
            "open": [10.0, 11.0, 12.0],
            "high": [11.0, 12.0, 13.0],
            "low": [9.0, 10.0, 11.0],
            "close": [10.5, 11.5, 12.5],
            "volume": [100.0, 110.0, 120.0],
            "amount": [1050.0, 1265.0, 1500.0],
            "adj_factor": [1.0, 1.0, 2.0],
        },
        index=pd.to_datetime(["2020-01-02", "2020-01-03", "2020-01-06"]),
    )


def _seeded_root(tmp_path: Path) -> Path:
    """Write the fixture through the real write gate and return its root."""
    root = tmp_path / "warehouse"
    bars, report = normalize_bars(
        _raw_bars(),
        symbol=_SYMBOL,
        interval="1D",
        source="tushare",
        volume_unit="lots",
        amount_unit="cny_thousand",
    )
    assert report.is_clean, f"the fixture must survive the write gate: {report.to_dict()}"
    store.write_bars(bars, interval="1D", root=root)
    return root


def test_warehouse_loader_serves_a_contract_shaped_frame(tmp_path: Path) -> None:
    """The stored read path returns the OHLCV shape downstream consumers expect."""
    frame = DataLoader(root=_seeded_root(tmp_path), adjust="raw").fetch(
        [_SYMBOL], *_WINDOW
    )[_SYMBOL]

    assert_loader_contract(frame, context="warehouse daily")
    assert list(frame.index) == list(pd.to_datetime(["2020-01-02", "2020-01-03", "2020-01-06"]))
    assert list(frame["close"]) == [10.5, 11.5, 12.5]


def test_warehouse_qfq_read_anchors_at_the_window_end(tmp_path: Path) -> None:
    """``qfq`` rescales every bar before the anchor by its own factor ratio.

    The anchor is what makes the caliber comparable with a live source over the
    same window, so the last stored close reads back unchanged.
    """
    root = _seeded_root(tmp_path)
    raw = DataLoader(root=root, adjust="raw").fetch([_SYMBOL], *_WINDOW)[_SYMBOL]
    qfq = DataLoader(root=root, adjust="qfq").fetch([_SYMBOL], *_WINDOW)[_SYMBOL]

    assert_loader_contract(qfq, context="warehouse daily qfq")
    assert qfq["close"].iloc[-1] == raw["close"].iloc[-1]
    assert list(qfq["close"]) == [5.25, 5.75, 12.5]
