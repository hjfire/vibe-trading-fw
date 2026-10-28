"""Chip profit ratio: modelled share of holders in profit."""

from __future__ import annotations

import pandas as pd

from src.factors.chips import chip_metrics

__alpha_meta__ = {
    "id": "chip_profit_ratio",
    "nickname": "Chip profit ratio: modelled share of holders in profit",
    "theme": ["microstructure"],
    "formula_latex": r"\frac{\sum_{k:\, k \cdot tick < close_t} W_k}{M_t}",
    "columns_required": ["high", "low", "close", "val:turnover_rate"],
    "universe": ["equity_cn"],
    "frequency": ["1d"],
    "decay_horizon": 20,
    "min_warmup_bars": 1,
    "notes": (
        "Share of the modelled chip mass whose cost is at or below today's "
        "close, i.e. the estimated fraction of holders in profit. Daily "
        "triangular distributions are mixed by turnover; a missing bar leaves "
        "the state untouched. Self-implemented from public definitions; no "
        "third-party code copied and no cyq_* endpoint is called. A "
        "cent-aligned close is exact; an off-grid close is linearly "
        "interpolated inside its bin."
    ),
}


def compute(panel: dict[str, pd.DataFrame]) -> pd.DataFrame:
    """Return the modelled share of chips below today's close."""
    metrics = chip_metrics(
        panel["high"], panel["low"], panel["close"], panel["val:turnover_rate"]
    )
    return metrics["profit_ratio"]
