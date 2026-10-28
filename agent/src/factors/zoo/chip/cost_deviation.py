"""Chip cost deviation: close vs the turnover-weighted average cost."""

from __future__ import annotations

import pandas as pd

from src.factors.chips import chip_metrics

__alpha_meta__ = {
    "id": "chip_cost_deviation",
    "nickname": "Chip cost deviation: close vs turnover-weighted average cost",
    "theme": ["microstructure"],
    "formula_latex": r"\frac{close_t - \bar{cost}_t}{\bar{cost}_t}",
    "columns_required": ["high", "low", "close", "val:turnover_rate"],
    "universe": ["equity_cn"],
    "frequency": ["1d"],
    "decay_horizon": 20,
    "min_warmup_bars": 1,
    "notes": (
        "Daily triangular chip distribution on [low, high] with the mode at the "
        "typical price (high+low+close)/3, mixed by turnover into a "
        "turnover-weighted holding-cost distribution; this factor is the "
        "close's relative deviation from the mean chip cost. Self-implemented "
        "from public definitions; no third-party code copied and no cyq_* "
        "endpoint is called. Price levels are taken as the panel supplies them: "
        "on forward-adjusted panels the historical cost level scales with "
        "corporate actions."
    ),
}


def compute(panel: dict[str, pd.DataFrame]) -> pd.DataFrame:
    """Return the close's relative deviation from the average chip cost."""
    metrics = chip_metrics(
        panel["high"], panel["low"], panel["close"], panel["val:turnover_rate"]
    )
    return metrics["cost_deviation"]
