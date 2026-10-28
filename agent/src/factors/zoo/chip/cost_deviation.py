"""Chip cost deviation: close vs the turnover-weighted average cost.

The mean cost is tracked analytically from the same triangular daily
distributions the ladder carries, so it needs no price-grid midpoint
approximation. On forward-adjusted panels the historical cost level scales
with corporate actions; the factor reads the panel as supplied.

Self-implemented from public definitions: no third-party code was copied and
no cyq_* endpoint is called.
"""

from __future__ import annotations

import pandas as pd

from src.factors.chips import chip_metrics

__alpha_meta__ = {
    "id": "chip_cost_deviation",
    "theme": ["microstructure"],
    "formula_latex": r"\frac{close_t - \bar{cost}_t}{\bar{cost}_t}",
    "columns_required": ["high", "low", "close", "val:turnover_rate"],
    "universe": ["equity_cn"],
    "frequency": ["1d"],
    "decay_horizon": 20,
    "min_warmup_bars": 1,
}


def compute(panel: dict[str, pd.DataFrame]) -> pd.DataFrame:
    """Return the close's relative deviation from the average chip cost."""
    metrics = chip_metrics(
        panel["high"], panel["low"], panel["close"], panel["val:turnover_rate"]
    )
    return metrics["cost_deviation"]
