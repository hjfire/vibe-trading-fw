"""Where the local market-data warehouse lives and how its files are named.

Layout is a Hive-style long table::

    <root>/bars/interval=1D/year=2024/data.parquet
    <root>/bars/interval=5m/year=2024/month=2024-06/data.parquet
    <root>/_manifest.json
    <root>/state/interval=1D/scope=<sha256-12>.json
    <root>/universe/csi300/{membership.parquet,_meta.json}

One file per partition, named ``data.parquet`` rather than DuckDB's
``data_0.parquet`` so the path is predictable enough to rewrite in place: an
append merges into the touched partition and replaces it atomically, which the
probe measured at 49 ms for a full year of daily csi300 bars (vs 2.9 s to
rewrite 300 per-symbol files).

The partition grain follows the write cost, not the read cost: at minute scale
year- and month-partitioned tables read identically (21.5 ms vs 22.1 ms for one
symbol-day) while a daily append rewrites the whole touched partition (755.6 ms
vs 120.1 ms).
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

SCHEMA_VERSION = 1

# Intervals that live in their own directory tree. ``backtest.runner._VALID_INTERVALS``
# is the truth table ({"1m","5m","15m","30m","1H","4H","1D"}); the lowercase
# alias is admitted because loaders are called with both spellings.
_DAILY_INTERVALS = frozenset({"1D", "1d"})
_PARTITION_SAFE = re.compile(r"^[A-Za-z0-9_.\-]+$")


def warehouse_enabled() -> bool:
    """Return whether the local market-data warehouse is turned on.

    The warehouse is opt-in: an empty root directory must never make
    ``source=warehouse`` look like a working data path.
    """
    from src.config.accessor import get_env_config

    return get_env_config().data.vibe_trading_warehouse_enabled is True


def warehouse_root() -> Path:
    """Return the warehouse root directory.

    Mirrors :func:`backtest.loaders.base.loader_cache_root`, and tightens it: the
    configured override is honored only when it is a non-blank ``str`` that
    resolves to an **absolute** path. A non-string value (a stubbed config in
    tests, or any object exposing ``__fspath__``) would otherwise reach
    ``Path()`` and yield a *relative* path, and a relative path resolves against
    the current working directory — which for a test run or a scheduled job can
    be the repository itself. The project forbids accumulating data in the repo,
    so both cases fall back to ``~/.vibe-trading/warehouse`` with a warning
    rather than writing market data next to the source tree.

    Returns:
        The configured root, or ``~/.vibe-trading/warehouse``.
    """
    from src.config.accessor import get_env_config

    root = get_env_config().data.vibe_trading_warehouse_root
    if isinstance(root, str) and root.strip():
        candidate = Path(root).expanduser()
        if candidate.is_absolute():
            return candidate
        logger.warning(
            "warehouse: ignoring the relative VIBE_TRADING_WAREHOUSE_ROOT %r; the "
            "data store must not depend on the working directory, so this falls "
            "back to the home directory",
            root,
        )
    return Path.home() / ".vibe-trading" / "warehouse"


def bars_dir(root: Path | None = None) -> Path:
    """Return the ``bars`` tree under *root*."""
    return (root or warehouse_root()) / "bars"


def manifest_path(root: Path | None = None) -> Path:
    return (root or warehouse_root()) / "_manifest.json"


def state_dir(root: Path | None = None) -> Path:
    return (root or warehouse_root()) / "state"


def normalize_interval(interval: str) -> str:
    """Return the canonical ``interval=`` directory spelling for one interval.

    Loaders are called with both ``1D`` and ``1d`` (``tushare.fetch`` even
    accepts ``daily``), and a tree that stored ``interval=1d`` would be invisible
    to a read asking for ``interval=1D`` — an empty result, not an error. The
    alias is folded here, at the one place the spelling becomes a path, so the
    write and read sides cannot disagree.
    """
    text = str(interval).strip()
    return "1D" if text.lower() in _DAILY_INTERVALS or text.lower() in {"d", "day", "daily"} else text


def partition_grain(interval: str) -> str:
    """Return ``"year"`` or ``"year,month"`` for one bar interval."""
    return "year" if str(interval).strip().lower() in _DAILY_INTERVALS else "year,month"


def partition_parts(interval: str, stamp: Any) -> tuple[tuple[str, str], ...]:
    """Return the Hive partition keys for one timestamp.

    Args:
        interval: Bar interval string (decides the grain).
        stamp: Anything ``pd.Timestamp`` can parse.

    Returns:
        Ordered ``(key, value)`` pairs, e.g.
        ``(("interval", "1D"), ("year", "2024"))``.
    """
    year = int(getattr(stamp, "year", 0))
    month = int(getattr(stamp, "month", 0))
    if not year:  # pragma: no cover - guarded by the caller's dropna
        raise ValueError(f"cannot partition an unparseable timestamp: {stamp!r}")
    keys: list[tuple[str, str]] = [
        ("interval", normalize_interval(interval)),
        ("year", f"{year:04d}"),
    ]
    if partition_grain(interval) == "year,month":
        keys.append(("month", f"{year:04d}-{month:02d}"))
    return tuple(keys)


def partition_dir(
    interval: str, stamp: Any, root: Path | None = None
) -> Path:
    """Return the directory holding one partition's ``data.parquet``."""
    path = bars_dir(root)
    for key, value in partition_parts(interval, stamp):
        path = path / f"{key}={value}"
    return path


def partition_file(interval: str, stamp: Any, root: Path | None = None) -> Path:
    """Return the parquet file for one partition."""
    return partition_dir(interval, stamp, root) / "data.parquet"


def interval_glob(interval: str, root: Path | None = None) -> str:
    """Return a ``**`` glob covering every partition of one interval.

    Forward slashes are forced: DuckDB's glob parser does not treat ``\\`` as a
    separator on Windows, and paths are embedded into SQL text.
    """
    base = bars_dir(root) / f"interval={_safe_segment(normalize_interval(interval))}"
    return (base / "**" / "data.parquet").as_posix()


def all_glob(root: Path | None = None) -> str:
    """Glob covering every stored interval, for SQL exploration."""
    return (bars_dir(root) / "**" / "data.parquet").as_posix()


def list_intervals(root: Path | None = None) -> list[str]:
    """Return the intervals that actually have data on disk, sorted."""
    found: list[str] = []
    base = bars_dir(root)
    if not base.is_dir():
        return found
    for child in sorted(base.iterdir()):
        if child.is_dir() and child.name.startswith("interval="):
            found.append(child.name.split("=", 1)[1])
    return found


def state_path(interval: str, symbols: list[str], root: Path | None = None) -> Path:
    """Return the resume-state file for one sync scope.

    The scope is the sorted symbol list plus the interval, hashed: two
    overlapping ``--symbols`` runs must not overwrite each other's progress.
    """
    payload = json.dumps(
        {"interval": normalize_interval(interval), "symbols": sorted(symbols)}, sort_keys=True
    ).encode("utf-8")
    digest = hashlib.sha256(payload).hexdigest()[:12]
    return (
        state_dir(root)
        / f"interval={_safe_segment(normalize_interval(interval))}"
        / f"scope-{digest}.json"
    )


def universe_dir(name: str, root: Path | None = None) -> Path:
    """Return the directory holding one universe's point-in-time roster.

    Kept outside ``bars/`` because it is not bar data: it answers "which names
    belonged to the index on this date", which a cross-sectional panel needs in
    order to avoid measuring factors on a roster selected with hindsight.
    """
    return (root or warehouse_root()) / "universe" / _safe_segment(name)


def universe_membership_file(name: str, root: Path | None = None) -> Path:
    """Return the ``(trade_date, symbol)`` roster file for *name*."""
    return universe_dir(name, root) / "membership.parquet"


def universe_meta_file(name: str, root: Path | None = None) -> Path:
    """Return the roster provenance file for *name*."""
    return universe_dir(name, root) / "_meta.json"


def utc_now_iso() -> str:
    """Timestamp used in the manifest (whole seconds are enough)."""
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat()


def atomic_replace(tmp: Path, target: Path) -> None:
    """Rename *tmp* onto *target*, retrying the Windows sharing violation.

    A backtest running in another process can hold a partition open on Windows
    (``os.replace`` then raises ``PermissionError``). Retrying briefly is the
    right behavior for a human-driven sync; the caller is already holding data
    that must not be lost. A non-retryable error propagates.
    """
    last: OSError | None = None
    for _ in range(50):
        try:
            os.replace(tmp, target)
            return
        except OSError as exc:  # pragma: no cover - timing dependent
            last = exc
            import time

            time.sleep(0.1)
    if last is not None:
        raise last


def _safe_segment(value: str) -> str:
    """Reject anything that could escape the tree when used as a path part."""
    text = str(value).strip()
    if not text or not _PARTITION_SAFE.match(text) or ".." in text:
        raise ValueError(f"unsafe path segment: {value!r}")
    return text
