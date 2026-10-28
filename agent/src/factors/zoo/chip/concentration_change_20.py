"""Chip concentration change over 20 trading days."""

from __future__ import annotations

import pandas as pd

from src.factors.chips import chip_metrics

__alpha_meta__ = {
    "id": "chip_concentration_change_20",
    "nickname": "Chip concentration change over 20 days",
    "theme": ["microstructure"],
    "formula_latex": (
        r"\mathrm{concentration}_t - \mathrm{concentration}_{t-20}"
    ),
    "columns_required": ["high", "low", "close", "val:turnover_rate"],
    "universe": ["equity_cn"],
    "frequency": ["1d"],
    "decay_horizon": 20,
    "min_warmup_bars": 21,
    "notes": (
        "20-trading-day change of the chip cost dispersion "
        "(concentration_t - concentration_{t-20}). Negative values mean the "
        "cost basis is converging. NaN until 20 rows of history exist and "
        "wherever either endpoint is NaN. Self-implemented from public "
        "definitions; no third-party code copied and no cyq_* endpoint is "
        "called."
    ),
}


def compute(panel: dict[str, pd.DataFrame]) -> pd.DataFrame:
    """Return the 20-day change of the modelled cost dispersion."""
    metrics = chip_metrics(
        panel["high"], panel["low"], panel["close"], panel["val:turnover_rate"]
    )
    return metrics["concentration_change_20"]
