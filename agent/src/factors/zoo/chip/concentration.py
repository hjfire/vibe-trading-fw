"""Chip concentration: (q95 - q05) / (q95 + q05) cost dispersion."""

from __future__ import annotations

import pandas as pd

from src.factors.chips import chip_metrics

__alpha_meta__ = {
    "id": "chip_concentration",
    "nickname": "Chip concentration: (q95-q05)/(q95+q05) cost dispersion",
    "theme": ["microstructure"],
    "formula_latex": r"\frac{q_{95} - q_{05}}{q_{95} + q_{05}}",
    "columns_required": ["high", "low", "close", "val:turnover_rate"],
    "universe": ["equity_cn"],
    "frequency": ["1d"],
    "decay_horizon": 20,
    "min_warmup_bars": 1,
    "notes": (
        "Cost dispersion of the chip distribution: (q95 - q05) / (q95 + q05) "
        "of the modelled holding cost, with quantile prices taken at bin "
        "midpoints. Higher = a more dispersed cost basis (the public field is "
        "named concentration, but its direction is dispersion). "
        "Self-implemented from public definitions; no third-party code copied "
        "and no cyq_* endpoint is called."
    ),
}


def compute(panel: dict[str, pd.DataFrame]) -> pd.DataFrame:
    """Return the modelled cost dispersion of the chip distribution."""
    metrics = chip_metrics(
        panel["high"], panel["low"], panel["close"], panel["val:turnover_rate"]
    )
    return metrics["concentration"]
