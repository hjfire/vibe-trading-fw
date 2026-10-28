"""Chip alphas obey the zoo contract and equal the engine's own output."""

from __future__ import annotations

import importlib

import numpy as np
import pandas as pd
import pytest

from src.factors.chips import chip_metrics
from src.factors.registry import Registry, SkipAlpha

CHIP_ALPHAS = {
    "chip_cost_deviation": "cost_deviation",
    "chip_profit_ratio": "profit_ratio",
    "chip_concentration": "concentration",
    "chip_concentration_change_20": "concentration_change_20",
}


def _panel(n_rows: int = 80, n_symbols: int = 3, seed: int = 7) -> dict[str, pd.DataFrame]:
    rng = np.random.default_rng(seed)
    index = pd.bdate_range("2023-01-02", periods=n_rows)
    columns = [f"{600000 + i}.SH" for i in range(n_symbols)]
    cents = np.maximum(
        1000 + np.cumsum(rng.integers(-40, 41, size=(n_rows, n_symbols)), axis=0),
        300,
    )

    def frame(values):
        return pd.DataFrame(values, index=index, columns=columns)

    close = frame(cents / 100.0)
    high = frame(cents / 100.0 + rng.integers(0, 60, size=(n_rows, n_symbols)) / 100.0)
    low = frame(cents / 100.0 - rng.integers(0, 60, size=(n_rows, n_symbols)) / 100.0)
    turnover = frame(rng.uniform(0.5, 8.0, size=(n_rows, n_symbols)))
    return {"high": high, "low": low, "close": close, "val:turnover_rate": turnover}


def test_registry_discovers_the_chip_zoo() -> None:
    registry = Registry()
    assert set(registry.list(zoo="chip")) == set(CHIP_ALPHAS)
    assert all(registry.get(alpha_id).zoo == "chip" for alpha_id in CHIP_ALPHAS)


def test_metadata_contract() -> None:
    registry = Registry()
    for alpha_id in CHIP_ALPHAS:
        meta = registry.get(alpha_id).meta
        assert meta["theme"] == ["microstructure"], alpha_id
        assert meta["columns_required"] == [
            "high",
            "low",
            "close",
            "val:turnover_rate",
        ], alpha_id
        assert meta["universe"] == ["equity_cn"], alpha_id
        assert meta["frequency"] == ["1d"], alpha_id
        assert meta["decay_horizon"] == 20, alpha_id
        assert meta["min_warmup_bars"] == (
            21 if alpha_id.endswith("change_20") else 1
        ), alpha_id


def test_zoo_docstring_records_provenance() -> None:
    package = importlib.import_module("src.factors.zoo.chip")
    doc = package.__doc__ or ""
    assert "no third-party code copied" in doc
    assert "no cyq_* endpoint is called" in doc


def test_missing_turnover_column_skips() -> None:
    panel = _panel()
    del panel["val:turnover_rate"]
    with pytest.raises(SkipAlpha):
        Registry().compute("chip_profit_ratio", panel)


def test_registry_output_equals_the_engine() -> None:
    panel = _panel()
    panel["val:turnover_rate"].iloc[10:12, 0] = np.nan
    metrics = chip_metrics(
        panel["high"], panel["low"], panel["close"], panel["val:turnover_rate"]
    )
    registry = Registry()
    for alpha_id, metric in CHIP_ALPHAS.items():
        actual = registry.compute(alpha_id, panel)
        pd.testing.assert_frame_equal(actual, metrics[metric])


def test_registry_masks_a_bar_with_a_missing_dependency() -> None:
    panel = _panel()
    panel["close"].iloc[5, 1] = np.nan
    out = Registry().compute("chip_concentration", panel)
    assert np.isnan(out.iloc[5, 1])


def test_change_20_is_nan_through_warmup_then_finite() -> None:
    out = Registry().compute("chip_concentration_change_20", _panel())
    assert np.isnan(out.iloc[:20].to_numpy()).all()
    assert np.isfinite(out.iloc[20:].to_numpy()).all()
