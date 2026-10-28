"""Chip concentration: (q95 - q05) / (q95 + q05) cost dispersion.

Higher values mean a more dispersed cost basis. The public field is named
"concentration", but its direction is dispersion: the value rises when costs
spread out. Quantile prices are taken at bin midpoints.

Self-implemented from public definitions: no third-party code was copied and
no cyq_* endpoint is called.
"""

from __future__ import annotations

import pandas as pd

from src.factors.chips import chip_metrics

__alpha_meta__ = {
    "id": "chip_concentration",
    "theme": ["microstructure"],
    "formula_latex": r"\frac{q_{95} - q_{05}}{q_{95} + q_{05}}",
    "columns_required": ["high", "low", "close", "val:turnover_rate"],
    "universe": ["equity_cn"],
    "frequency": ["1d"],
    "decay_horizon": 20,
    "min_warmup_bars": 1,
}


def compute(panel: dict[str, pd.DataFrame]) -> pd.DataFrame:
    """Return the modelled cost dispersion of the chip distribution."""
    metrics = chip_metrics(
        panel["high"], panel["low"], panel["close"], panel["val:turnover_rate"]
    )
    return metrics["concentration"]
