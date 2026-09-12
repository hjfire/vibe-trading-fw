"""The ``warehouse`` loader: serve a backtest or factor panel off local disk.

This is the read end of :mod:`backtest.warehouse`. It exists so a research run
can be reproducible after the fact: the bars it priced came from a store whose
provenance, units and adjustment factors are recorded on disk, rather than from
whatever a vendor endpoint happened to return on the day the run happened.

Why a separate loader name instead of reusing ``local``: ``runner`` stamps
provenance as ``(loader.name, price_caliber(loader.name, market))`` and the
caliber table is keyed by name, so only a distinct name can declare what this
store actually serves — raw prices plus a per-row factor, adjusted on read.
Reusing ``local`` would leave the served basket at ``"unknown"``, and
:func:`backtest.loaders.registry.mixed_caliber_warning` never fires on
``unknown``: the mixing would be silent, which is the one outcome worth
avoiding when a warehouse and a live source appear in the same run.

What this loader will not do:

* **Fall back to the network.** It is registered in
  ``_NO_NETWORK_FALLBACK_SOURCES``, so an unavailable warehouse is an error the
  user sees rather than a quiet re-route to Tencent — a backtest that silently
  changed data source is not the backtest that was asked for.
* **Cache again.** The parquet partitions *are* the cache; wrapping the read in
  ``cached_loader_fetch`` would duplicate them on disk and add a second,
  independently-stale expiry to reason about.
* **Fabricate an interval.** Ask for ``5m`` when only ``1D`` is stored and the
  answer is empty with a warning, never a daily bar split into five.
"""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional

import pandas as pd

from backtest.loaders.base import validate_date_range
from backtest.loaders.registry import register
from backtest.warehouse import store
from backtest.warehouse.layout import (
    bars_dir,
    list_intervals,
    normalize_interval,
    warehouse_enabled,
)
from backtest.warehouse.schema import canonical_units, storable_markets

logger = logging.getLogger(__name__)

#: Environment switch the whole feature hangs on, quoted verbatim in every
#: message so the fix is copy-pasteable.
ENABLE_ENV_VAR = "VIBE_TRADING_WAREHOUSE_ENABLED"


def has_bars(root: Path | None = None) -> bool:
    """Whether any bar is stored under *root*.

    Short-circuits on the first partition file: the question is "is there a
    warehouse here", not "how big is it" (that is :func:`audit.summarize_intervals`).
    """
    base = bars_dir(root)
    return base.is_dir() and any(base.glob("interval=*/**/data.parquet"))


def disabled_reason(root: Path | None = None) -> str:
    """Return why the warehouse cannot serve, or ``""`` when it can.

    Split out of :func:`DataLoader.is_available` because the registry's
    no-fallback error wants the same sentence the CLI prints, and a hint that
    has to be written twice is a hint that will drift.
    """
    if not warehouse_enabled():
        return (
            f"the local warehouse is disabled; set {ENABLE_ENV_VAR}=true to let "
            "backtests read it"
        )
    if not has_bars(root):
        return (
            "no bars are stored yet; run "
            "'python -m backtest.warehouse sync --symbols <codes> --since YYYY-MM-DD'"
        )
    return ""


def _stored_volume_units() -> dict[str, str]:
    """Volume units the store delivers, read from the write-side contract.

    Derived rather than declared: ``store`` keeps every market's ``volume`` in
    the canonical unit it was written under, so a second literal list here would
    be a second thing to keep correct — and a wrong volume unit is a wrong
    turnover, not a wrong label.
    """
    out: dict[str, str] = {}
    for market in storable_markets():
        unit = canonical_units(market).volume_unit
        if unit:
            out[market] = unit
    return out


@register
class DataLoader:
    """Read raw-plus-factor bars from the local warehouse, adjusted on read."""

    name = "warehouse"
    # Only the markets the write gate can actually fill. ``index`` and ETF codes
    # are not separate markets here: ``000300.SH`` and ``510050.SH`` both
    # classify as ``a_share`` and reach the same store.
    markets = set(_stored_volume_units())
    volume_units = _stored_volume_units()
    requires_auth = False

    def __init__(self, *, root: Path | None = None, adjust: str = "qfq") -> None:
        """Build a reader.

        Args:
            root: Warehouse override; defaults to the configured root.
            adjust: ``"qfq"`` (the online-source caliber) or ``"raw"``.

        Raises:
            ValueError: ``adjust`` is not a stored mode.
        """
        if adjust not in store.ADJUST_MODES:
            raise ValueError(f"adjust must be one of {list(store.ADJUST_MODES)}, got {adjust!r}")
        self.root = root
        self.adjust = str(adjust)

    def is_available(self) -> bool:
        """Whether the feature is enabled *and* holds at least one bar."""
        return not disabled_reason(self.root)

    def intervals(self) -> list[str]:
        """Return the intervals that have data on disk, sorted."""
        return list_intervals(self.root)

    def coverage(self, codes: Iterable[str]) -> dict[str, tuple[str, str, int]]:
        """Return ``{symbol: (first, last, rows)}`` stored for *codes*.

        Read straight from the partitions, so the answer describes the data and
        not the resume state — the question a researcher asks is "can I run this
        window", and only the files know.
        """
        out: dict[str, tuple[str, str, int]] = {}
        for symbol in codes:
            first, last, rows = store.symbol_range(
                str(symbol), interval=self._interval_or_default(), root=self.root
            )
            if rows:
                out[str(symbol)] = (
                    first.date().isoformat(),
                    last.date().isoformat(),
                    rows,
                )
        return out

    def _interval_or_default(self) -> str:
        """Return the only interval a bare coverage call can mean."""
        stored = self.intervals()
        return "1D" if "1D" in stored or not stored else stored[0]

    def fetch(
        self,
        codes: List[str],
        start_date: str,
        end_date: str,
        *,
        interval: str = "1D",
        fields: Optional[List[str]] = None,
    ) -> Dict[str, pd.DataFrame]:
        """Return stored bars for *codes*, adjusted the way the store means it.

        Args:
            codes: Project-format tickers (``600519.SH``).
            start_date: ``YYYY-MM-DD``, inclusive.
            end_date: ``YYYY-MM-DD``, inclusive; also the qfq anchor.
            interval: Bar interval as stored; ``1d``/``daily`` alias onto ``1D``.
            fields: Not served. A non-empty list is reported, not ignored.

        Returns:
            ``{symbol: frame}`` with a ``trade_date`` index and
            open/high/low/close/volume(/amount). A symbol with nothing stored in
            the window is simply absent, which is how every other loader spells
            "no data" and how a halt already reads downstream.

        Raises:
            ValueError: The date range is inverted.
            backtest.warehouse.store.WarehouseSchemaMismatch: The store on disk
                is newer than this code understands.
        """
        validate_date_range(start_date, end_date)
        wanted = [str(code) for code in codes if str(code).strip()]
        if not wanted:
            return {}
        if fields:
            logger.warning(
                "warehouse loader: fundamentals (%s) are not stored; the warehouse "
                "keeps bars, so ask a live source for payout/PE columns",
                ", ".join(str(field) for field in fields),
            )
        target = normalize_interval(interval)
        stored = self.intervals()
        if target not in stored:
            logger.warning(
                "warehouse loader: no %r bars stored under %s (on disk: %s); "
                "sync them with 'python -m backtest.warehouse sync --interval %s'",
                target,
                bars_dir(self.root),
                ", ".join(stored) or "nothing",
                target,
            )
            return {}
        result: Dict[str, pd.DataFrame] = store.read_bars(
            wanted,
            interval=target,
            start=start_date,
            end=end_date,
            adjust=self.adjust,
            root=self.root,
        )
        missing = [code for code in wanted if code not in result]
        if missing:
            logger.info(
                "warehouse loader: %d/%d symbol(s) have no usable bar in %s..%s: %s",
                len(missing),
                len(wanted),
                start_date,
                end_date,
                ", ".join(missing[:8]) + ("..." if len(missing) > 8 else ""),
            )
        return result

    def __repr__(self) -> str:  # pragma: no cover - logging aid
        return f"<WarehouseDataLoader root={self.root or 'configured'} adjust={self.adjust!r}>"


def frame_attrs(frames: Dict[str, pd.DataFrame], *, source_root: Path | None) -> dict[str, Any]:
    """Attach store provenance to loader frames for a run card.

    ``src.market_data`` reads ``df.attrs`` for currency/volume notes, so the
    warehouse records which directory answered — a reader comparing two runs has
    to be able to tell the store they came from.
    """
    root = bars_dir(source_root)
    for frame in frames.values():
        attrs: dict[str, Any] = frame.attrs if isinstance(frame.attrs, dict) else {}
        attrs.setdefault("warehouse_bars", str(root))
        frame.attrs = attrs
    return {"bars_root": str(root)}
