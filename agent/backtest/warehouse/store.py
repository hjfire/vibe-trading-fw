"""Read and write the warehouse's parquet partitions.

Writes are per-partition merges: the touched ``data.parquet`` is read back, the
new rows replace any row with the same ``(symbol, session_date)``, and the file
is swapped in atomically. Partitions that hold only closed history are never
opened, which is what makes "an append cannot rewrite the past" observable
rather than aspirational.

Reads return corporate-action-adjusted frames computed on the fly. The
adjustment is delegated to :func:`backtest.loaders.cn_adjust.apply_qfq` — the
project's single implementation, shared by the loader and the alpha bench — so
the warehouse cannot drift into a second, subtly different convention. That
function anchors prices to the *last bar of the window it was given*, which is
exactly why raw + factor is stored instead of adjusted prices.
"""

from __future__ import annotations

import json
import logging
import os
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Iterable, Mapping

import pandas as pd

from backtest.loaders.base import _duckdb_sql_string
from backtest.loaders.cn_adjust import apply_qfq
from backtest.warehouse.layout import (
    SCHEMA_VERSION,
    atomic_replace,
    interval_glob,
    manifest_path,
    partition_file,
    partition_grain,
    universe_membership_file,
    universe_meta_file,
    utc_now_iso,
    warehouse_root,
)
from backtest.warehouse.schema import BAR_COLUMNS, asset_rule, classify_asset, empty_bars

logger = logging.getLogger(__name__)

#: Price columns a loader-shaped frame must expose after adjustment.
_LOADER_COLUMNS: tuple[str, ...] = ("open", "high", "low", "close", "volume", "amount")

ADJUST_MODES = ("raw", "qfq")


class WarehouseSchemaMismatch(RuntimeError):
    """On-disk data was written by a newer schema than this code understands."""


@dataclass
class WriteResult:
    """Outcome of one :func:`write_bars` call.

    Attributes:
        partitions: Partition files rewritten.
        rows_written: Rows in the resulting partitions.
        rows_added: Rows that were not previously stored.
        paths: Partition files touched, in write order.
    """

    partitions: int = 0
    rows_written: int = 0
    rows_added: int = 0
    paths: list[Path] = field(default_factory=list)


def _connect() -> Any:
    import duckdb

    return duckdb.connect(database=":memory:")


# ---------------------------------------------------------------------------
# Manifest
# ---------------------------------------------------------------------------


def read_manifest(root: Path | None = None) -> dict[str, Any]:
    """Return ``_manifest.json``, or ``{}`` when the warehouse is untouched.

    Raises:
        WarehouseSchemaMismatch: The stored ``schema_version`` is newer than
            :data:`backtest.warehouse.layout.SCHEMA_VERSION`; reading it with
            older code would silently misinterpret columns.
    """
    path = manifest_path(root)
    if not path.is_file():
        return {}
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("warehouse manifest unreadable (%s): %s", path, exc)
        return {}
    version = payload.get("schema_version")
    if isinstance(version, int) and version > SCHEMA_VERSION:
        raise WarehouseSchemaMismatch(
            f"warehouse at {path} declares schema_version={version}, this build "
            f"understands {SCHEMA_VERSION}; refusing to guess the column meaning"
        )
    return payload if isinstance(payload, dict) else {}


def write_manifest(
    *,
    source: str,
    markets: Iterable[str],
    volume_unit: str | None,
    amount_unit: str | None,
    root: Path | None = None,
) -> dict[str, Any]:
    """Record which source delivered which market, in which units.

    Unit provenance is the point: a reader must be able to tell whether the
    ``volume`` column of a given partition was ever interpreted as shares.
    Units are kept per market, because one source can serve markets whose units
    differ; the top-level keys are only filled in while every market agrees, so
    an ambiguous source reads back ``None`` rather than whichever market happened
    to be synced last.
    """
    wanted = [str(market) for market in markets]
    if not wanted:
        raise ValueError("write_manifest needs at least one market")
    manifest = read_manifest(root)
    manifest.setdefault("schema_version", SCHEMA_VERSION)
    manifest.setdefault("created_at", utc_now_iso())
    manifest["updated_at"] = utc_now_iso()
    sources = manifest.get("sources")
    if not isinstance(sources, dict):
        sources = {}
    entry = sources.get(source) if isinstance(sources.get(source), dict) else {}
    known = {str(market) for market in entry.get("markets", [])}
    entry["markets"] = sorted(known | set(wanted))
    per_market = entry.get("units_by_market")
    if not isinstance(per_market, dict):
        per_market = {}
    for market in wanted:
        per_market[market] = {"volume_unit": volume_unit, "amount_unit": amount_unit}
    entry["units_by_market"] = per_market
    entry["volume_unit"] = _single_value([u.get("volume_unit") for u in per_market.values()])
    entry["amount_unit"] = _single_value([u.get("amount_unit") for u in per_market.values()])
    sources[source] = entry
    manifest["sources"] = sources
    _write_json_atomic(manifest, manifest_path(root))
    return manifest


def _single_value(values: list[Any]) -> Any:
    """Return the one value *values* share, or ``None`` when they disagree."""
    unique = {str(value) for value in values}
    if len(unique) != 1:
        return None
    return values[0]


def unit_conflicts(
    manifest: dict[str, Any],
    *,
    source: str,
    units_by_market: Mapping[str, tuple[Any, Any]],
) -> list[str]:
    """Return one message per market another *source* already stores differently.

    Units are not a label that can be disagreed about in one column: if
    ``a_share`` volume arrived from one source in lots and another hands it over
    in shares, the partition silently becomes two different tables and every
    later backtest is off by 100x with nothing to trace. The row-level ``source``
    column records provenance but cannot fix the mix, so the caller is expected
    to refuse the run rather than merge it.

    Args:
        manifest: Parsed ``_manifest.json`` (``{}`` is fine).
        source: Source about to write.
        units_by_market: ``market -> (volume_unit, amount_unit)`` it declares.

    Returns:
        Human-readable conflict messages; empty when the write is compatible.
    """
    messages: list[str] = []
    sources = manifest.get("sources")
    if not isinstance(sources, dict):
        return messages
    for name, entry in sorted(sources.items()):
        if str(name) == str(source) or not isinstance(entry, dict):
            continue
        stored = entry.get("units_by_market")
        stored = stored if isinstance(stored, dict) else {}
        markets = [str(market) for market in entry.get("markets", [])]
        for market in markets:
            if market not in units_by_market:
                continue
            recorded = stored.get(market)
            if not isinstance(recorded, dict):
                # Written before per-market units existed: fall back to the
                # source-level declaration, which is all the older manifest has.
                recorded = {
                    "volume_unit": entry.get("volume_unit"),
                    "amount_unit": entry.get("amount_unit"),
                }
            want_volume, want_amount = units_by_market[market]
            if recorded.get("volume_unit") != want_volume or recorded.get(
                "amount_unit"
            ) != want_amount:
                messages.append(
                    f"market {market!r} is already stored from {name!r} as "
                    f"volume={recorded.get('volume_unit')!r}/"
                    f"amount={recorded.get('amount_unit')!r}, but {source!r} declares "
                    f"volume={want_volume!r}/amount={want_amount!r}"
                )
    return messages


def _write_json_atomic(payload: dict[str, Any], target: Path) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f"{target.name}.{os.getpid()}.{uuid.uuid4().hex}.tmp")
    tmp.write_text(json.dumps(payload, sort_keys=True, indent=2), encoding="utf-8")
    atomic_replace(tmp, target)


# ---------------------------------------------------------------------------
# Write path
# ---------------------------------------------------------------------------


def write_bars(
    bars: pd.DataFrame,
    *,
    interval: str,
    root: Path | None = None,
) -> WriteResult:
    """Merge normalized rows into their partitions and swap the files in.

    Args:
        bars: Frame produced by :func:`backtest.warehouse.schema.normalize_bars`
            (exact :data:`BAR_COLUMNS`); may span several symbols.
        interval: Bar interval, which selects the partition grain and the
            ``interval=`` directory.
        root: Warehouse root override, for tests.

    Returns:
        A :class:`WriteResult`. An empty *bars* frame writes nothing.

    Raises:
        ValueError: ``bars`` is missing contract columns.
    """
    missing = [col for col in BAR_COLUMNS if bars is None or col not in bars.columns]
    if missing:
        raise ValueError(f"bars are missing warehouse columns: {missing}")
    if bars.empty:
        return WriteResult()

    work = bars.loc[:, list(BAR_COLUMNS)].copy()
    work["session_date"] = pd.to_datetime(work["session_date"]).astype("datetime64[ns]")
    keys = pd.Series(_partition_keys(work, interval), index=work.index)
    result = WriteResult()
    for key, chunk in work.groupby(keys, sort=True):
        path = partition_file(interval, pd.Timestamp(str(key)), root)
        rows_before = _count_rows(path)
        merged = _merge_partition(path, chunk)
        _write_partition(path, merged, interval=interval, root=root)
        result.partitions += 1
        result.rows_written += int(len(merged))
        result.rows_added += max(0, int(len(merged)) - rows_before)
        result.paths.append(path)
    return result


def _partition_keys(work: pd.DataFrame, interval: str) -> list[str]:
    """Return one ISO date *inside* each row's partition, used as the group key.

    A daily partition is keyed ``"2024-01-01"`` and a monthly one ``"2024-06-01"``;
    :func:`backtest.warehouse.layout.partition_file` only reads the year/month off
    the stamp, so any date inside the period names the same directory.
    """
    dates = pd.to_datetime(work["session_date"])
    if partition_grain(interval) == "year":
        return [f"{int(year):04d}-01-01" for year in dates.dt.year]
    return [f"{int(year):04d}-{int(month):02d}-01" for year, month in zip(dates.dt.year, dates.dt.month)]


def _count_rows(path: Path) -> int:
    if not path.is_file():
        return 0
    try:
        con = _connect()
        try:
            return int(con.execute(
                f"SELECT count(*) FROM read_parquet({_duckdb_sql_string(path)}, "
                "hive_partitioning=0)"
            ).fetchone()[0])
        finally:
            con.close()
    except Exception as exc:  # noqa: BLE001 - an unreadable partition must not block the merge
        logger.warning("warehouse partition unreadable (%s): %s", path, exc)
        return 0


def _read_partition(path: Path) -> pd.DataFrame:
    """Return a stored partition, or an empty contract frame."""
    if not path.is_file():
        return empty_bars()
    con = _connect()
    try:
        # hive_partitioning=0: the directory keys (interval=/year=) must not leak
        # in as extra columns, or a merge round-trip drifts away from the
        # 12-column contract.
        frame = con.execute(
            f"SELECT * FROM read_parquet({_duckdb_sql_string(path)}, hive_partitioning=0)"
        ).df()
    finally:
        con.close()
    frame["session_date"] = pd.to_datetime(frame["session_date"]).astype("datetime64[ns]")
    return frame


def _merge_partition(path: Path, incoming: pd.DataFrame) -> pd.DataFrame:
    """Union existing and incoming rows; incoming wins on the same key."""
    if not path.is_file():
        merged = incoming
    else:
        merged = pd.concat([_drop_superseded(_read_partition(path), incoming), incoming], ignore_index=True)
    merged = merged.loc[:, list(BAR_COLUMNS)]
    merged["session_date"] = pd.to_datetime(merged["session_date"]).astype("datetime64[ns]")
    return merged.sort_values(["symbol", "session_date"]).reset_index(drop=True)


def _drop_superseded(existing: pd.DataFrame, incoming: pd.DataFrame) -> pd.DataFrame:
    """Remove existing rows the incoming frame replaces."""
    if existing.empty or incoming.empty:
        return existing
    keys = set(zip(incoming["symbol"], incoming["session_date"]))
    keep = [
        (symbol, stamp) not in keys
        for symbol, stamp in zip(existing["symbol"], existing["session_date"])
    ]
    return existing[pd.Series(keep, index=existing.index)]


def _write_partition(
    path: Path, frame: pd.DataFrame, *, interval: str = "1D", root: Path | None = None
) -> None:
    """Swap *frame* in as one partition file.

    Every row must belong to *path*: a row stored in the wrong partition is
    invisible to the merge that would fix it and shows up as a duplicate on
    every read, so the mistake is refused rather than written.
    """
    if len(frame):
        stamps = pd.to_datetime(frame["session_date"]).unique()
        targets = {partition_file(interval, stamp, root) for stamp in stamps}
        if targets != {path}:
            raise ValueError(
                f"refusing to write {len(targets)} partition(s) into {path}: a row must "
                "live in the partition its session_date names"
            )
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(f"{path.stem}.tmp-{os.getpid()}.{uuid.uuid4().hex}.parquet")
    con = _connect()
    try:
        con.register("warehouse_partition", frame.loc[:, list(BAR_COLUMNS)])
        # ``TIMESTAMP_NS``, not DuckDB's microsecond default: a stored bar must
        # read back as the exact stamp it was written with, or "bit-level
        # fidelity" is a claim about the codec rather than the data. The cast is
        # in the SELECT because ``COPY ... (FORMAT PARQUET, TIMESTAMP_NS)`` is not
        # accepted by every supported duckdb version. The read side casts to
        # ``datetime64[ns]`` either way, so this only changes what is on disk.
        con.execute(
            f"COPY (SELECT * REPLACE (session_date::TIMESTAMP_NS AS session_date) "
            f"FROM warehouse_partition) TO {_duckdb_sql_string(tmp)} (FORMAT PARQUET)"
        )
    finally:
        con.close()
    atomic_replace(tmp, path)


# ---------------------------------------------------------------------------
# Read path
# ---------------------------------------------------------------------------


def read_bars(
    symbols: Iterable[str],
    *,
    interval: str = "1D",
    start: str | pd.Timestamp,
    end: str | pd.Timestamp,
    adjust: str = "qfq",
    root: Path | None = None,
    index_name: str | None = "trade_date",
) -> dict[str, pd.DataFrame]:
    """Return loader-shaped bars for *symbols*, adjusted as requested.

    Args:
        symbols: Project-format tickers.
        interval: Bar interval to read.
        start: First session, inclusive (anything ``pd.Timestamp`` parses).
        end: Last session, inclusive. This is the qfq anchor: prices are scaled
            to the last stored factor *inside* the window, matching the online
            path, so two windows that end differently return differently-scaled
            levels. Returns are unaffected.
        adjust: ``"qfq"`` (corporate-action adjusted) or ``"raw"``.
        root: Warehouse root override.
        index_name: Name given to the returned index; the online loaders use
            ``"trade_date"``, which the panel builders keep.

    Returns:
        ``{symbol: frame}`` with a ``datetime64[ns]`` index and any of
        open/high/low/close/volume/amount. Missing symbols are simply absent —
        a halted range contributes no rows, which is how the rest of the
        project spells "did not trade".

    Raises:
        ValueError: ``adjust`` is not one of :data:`ADJUST_MODES`.
    """
    if adjust not in ADJUST_MODES:
        raise ValueError(f"adjust must be one of {list(ADJUST_MODES)}, got {adjust!r}")
    wanted = [str(symbol) for symbol in symbols]
    if not wanted:
        return {}
    bars = _query_bars(wanted, interval=interval, start=start, end=end, root=root)
    if bars.empty:
        return {}

    out: dict[str, pd.DataFrame] = {}
    for symbol, frame in bars.groupby("symbol", sort=False):
        frame = frame.set_index("session_date").sort_index()
        frame.index = frame.index.astype("datetime64[ns]")
        frame.index.name = index_name
        if adjust == "qfq":
            frame = _adjust_qfq(str(symbol), frame)
            if frame is None:
                continue
        columns = [col for col in _LOADER_COLUMNS if col in frame.columns]
        out[str(symbol)] = frame.loc[:, columns].copy()
    return out


def read_raw_with_factor(
    symbols: Iterable[str],
    *,
    interval: str = "1D",
    start: str | pd.Timestamp,
    end: str | pd.Timestamp,
    root: Path | None = None,
) -> dict[str, pd.DataFrame]:
    """Return unadjusted bars plus their ``adj_factor`` column, per symbol."""
    wanted = [str(symbol) for symbol in symbols]
    if not wanted:
        return {}
    bars = _query_bars(wanted, interval=interval, start=start, end=end, root=root)
    if bars.empty:
        return {}
    out: dict[str, pd.DataFrame] = {}
    for symbol, frame in bars.groupby("symbol", sort=False):
        frame = frame.set_index("session_date").sort_index()
        frame.index = frame.index.astype("datetime64[ns]")
        frame.index.name = "trade_date"
        keep = [col for col in (*_LOADER_COLUMNS, "adj_factor") if col in frame.columns]
        out[str(symbol)] = frame.loc[:, keep]
    return out


def _query_bars(
    symbols: list[str],
    *,
    interval: str,
    start: str | pd.Timestamp,
    end: str | pd.Timestamp,
    root: Path | None,
) -> pd.DataFrame:
    """Fetch every stored row for *symbols* inside ``[start, end]``."""
    glob = interval_glob(interval, root)
    placeholders = ", ".join(["?"] * len(symbols))
    sql = (
        "SELECT * FROM read_parquet("
        f"{_duckdb_sql_string(glob)}, hive_partitioning=0, union_by_name=1"
        f") WHERE symbol IN ({placeholders}) AND session_date >= ? AND session_date <= ?"
        " ORDER BY symbol, session_date"
    )
    con = _connect()
    try:
        try:
            frame = con.execute(sql, [*symbols, pd.Timestamp(start), pd.Timestamp(end)]).df()
        except Exception as exc:  # noqa: BLE001 - a missing tree is not an error
            if "does not exist" in str(exc) or "No files found" in str(exc):
                return empty_bars()
            raise
    finally:
        con.close()
    if frame.empty:
        return frame
    frame["session_date"] = pd.to_datetime(frame["session_date"]).astype("datetime64[ns]")
    return frame


def _as_ns(value: Any) -> pd.Timestamp:
    """Return a ``datetime64[ns]``-precision timestamp, matching the loaders."""
    stamp = pd.Timestamp(value)
    return stamp.as_unit("ns") if hasattr(stamp, "as_unit") else stamp


def _adjust_qfq(symbol: str, frame: pd.DataFrame) -> pd.DataFrame | None:
    """Apply the shared qfq, refusing to extrapolate a factor across a hole.

    ``apply_qfq`` fills a sparse factor series with ``ffill`` *and* ``bfill``,
    and bfill reaches forward in time — harmless for the online path (Tushare
    returns one factor per session) but a future-information leak here, since a
    stored row with no factor would silently borrow the next session's value.
    The write gate already refuses such rows, so this is a guard against a
    hand-edited or older partition, and it is enforced on read as well.
    """
    market, asset_class = classify_asset(symbol, None)
    if frame.get("adj_factor") is None or frame["adj_factor"].isna().all():
        if asset_rule(market, asset_class).adjust_applicable:
            logger.warning(
                "warehouse: %s has no adjustment factors in the requested window — "
                "skipping it rather than backtesting it on unadjusted prices",
                symbol,
            )
            return None
        return frame
    factors = frame["adj_factor"]
    if (factors.isna() | (factors <= 0)).any():
        logger.warning(
            "warehouse: %s has %d bar(s) without a usable adjustment factor — "
            "skipping the symbol rather than forward-filling across the hole",
            symbol,
            int((factors.isna() | (factors <= 0)).sum()),
        )
        return None
    factor_frame = pd.DataFrame({"trade_date": frame.index, "adj_factor": factors.to_numpy()})
    prices = frame.loc[:, [c for c in _LOADER_COLUMNS if c in frame.columns]]
    return apply_qfq(prices, factor_frame)


# ---------------------------------------------------------------------------
# Coverage helpers (used by sync and audit)
# ---------------------------------------------------------------------------


def stored_symbols(*, interval: str = "1D", root: Path | None = None) -> list[str]:
    """Return every symbol that has at least one stored bar for *interval*."""
    glob = interval_glob(interval, root)
    con = _connect()
    try:
        try:
            rows = con.execute(
                f"SELECT DISTINCT symbol FROM read_parquet({_duckdb_sql_string(glob)}, "
                "hive_partitioning=0, union_by_name=1) ORDER BY symbol"
            ).fetchall()
        except Exception as exc:  # noqa: BLE001 - an empty warehouse is not an error
            if "does not exist" in str(exc) or "No files found" in str(exc):
                return []
            raise
    finally:
        con.close()
    return [str(row[0]) for row in rows]


def symbol_range(
    symbol: str,
    *,
    interval: str = "1D",
    root: Path | None = None,
) -> tuple[pd.Timestamp | None, pd.Timestamp | None, int]:
    """Return ``(first, last, rows)`` stored for one symbol."""
    glob = interval_glob(interval, root)
    con = _connect()
    try:
        try:
            row = con.execute(
                f"SELECT min(session_date), max(session_date), count(*) FROM read_parquet("
                f"{_duckdb_sql_string(glob)}, hive_partitioning=0, union_by_name=1) "
                "WHERE symbol = ?",
                [str(symbol)],
            ).fetchone()
        except Exception as exc:  # noqa: BLE001
            if "does not exist" in str(exc) or "No files found" in str(exc):
                return None, None, 0
            raise
    finally:
        con.close()
    if not row or row[2] in (None, 0):
        return None, None, 0
    return _as_ns(row[0]), _as_ns(row[1]), int(row[2])


# ---------------------------------------------------------------------------
# Universe roster (point-in-time index membership)
# ---------------------------------------------------------------------------


def write_universe_roster(
    universe: str,
    membership: pd.DataFrame | None,
    *,
    constituent_source: str,
    constituent_source_date: str | None = None,
    root: Path | None = None,
) -> Path | None:
    """Persist a date x symbol membership matrix as a ``(trade_date, symbol)`` table.

    Only the ``True`` cells are written. The matrix is fully determined by them:
    every stored snapshot lists its members, and a name absent from a snapshot
    simply was not in the index that day — so the long form is lossless, half the
    files, and readable as plain SQL (``WHERE trade_date = DATE '2020-06-30'``).

    ``membership=None`` writes nothing and returns ``None``. That is the degraded
    path (the vendor roster call failed, so a hand-picked list was used), and
    leaving the file absent is the honest record: a reader then reports the panel
    as survivorship-biased instead of trusting a roster nobody resolved.

    Args:
        universe: Roster name, e.g. ``csi300``.
        membership: date x symbol boolean matrix, or ``None`` when unresolved.
        constituent_source: Where the roster came from, verbatim.
        constituent_source_date: Latest roster snapshot, ``YYYY-MM-DD``.
        root: Warehouse root override.

    Returns:
        The membership file path, or ``None`` when nothing was written.

    Raises:
        ValueError: *universe* is not a safe path segment.
    """
    if membership is None or membership.empty:
        logger.warning(
            "warehouse: universe %r has no point-in-time roster to store; a panel "
            "built from it will be reported as survivorship-biased", universe
        )
        return None
    long = (
        membership.rename_axis("trade_date")
        .reset_index()
        .melt(id_vars=["trade_date"], var_name="symbol", value_name="is_member")
    )
    long = long.loc[long["is_member"].astype(bool), ["trade_date", "symbol"]]
    long["trade_date"] = pd.to_datetime(long["trade_date"]).astype("datetime64[ns]")
    long["symbol"] = long["symbol"].astype(str)
    long = long.sort_values(["trade_date", "symbol"]).reset_index(drop=True)
    if long.empty:  # pragma: no cover - an all-False matrix is not a roster
        logger.warning("warehouse: universe %r roster has no member rows; not storing it", universe)
        return None

    target = universe_membership_file(universe, root)
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f"{target.stem}.tmp-{os.getpid()}.{uuid.uuid4().hex}.parquet")
    con = _connect()
    try:
        con.register("universe_membership", long)
        con.execute(
            f"COPY universe_membership TO {_duckdb_sql_string(tmp)} (FORMAT PARQUET)"
        )
    finally:
        con.close()
    atomic_replace(tmp, target)

    _write_json_atomic(
        {
            "schema_version": SCHEMA_VERSION,
            "universe": str(universe),
            "constituent_source": str(constituent_source),
            "constituent_source_date": constituent_source_date,
            "snapshot_dates": int(membership.shape[0]),
            "constituent_count": int(len(long["symbol"].unique())),
            "updated_at": utc_now_iso(),
        },
        universe_meta_file(universe, root),
    )
    return target


def read_universe_roster(
    universe: str, *, root: Path | None = None
) -> tuple[pd.DataFrame | None, dict[str, Any]]:
    """Return ``(membership, meta)`` for one stored universe.

    The matrix is rebuilt with the same pivot the online path uses, so a panel
    masked from the stored roster matches the panel masked live name for name.

    Returns:
        ``(None, {})`` when no roster was ever stored, which the caller must
        surface as a degraded (survivorship-biased) universe rather than an
        empty one.

    Raises:
        WarehouseSchemaMismatch: The stored roster is newer than this code.
    """
    path = universe_membership_file(universe, root)
    if not path.is_file():
        return None, {}
    con = _connect()
    try:
        frame = con.execute(
            f"SELECT trade_date, symbol FROM read_parquet({_duckdb_sql_string(path)}, "
            "hive_partitioning=0) ORDER BY trade_date, symbol"
        ).df()
    finally:
        con.close()
    if frame.empty:
        return None, {}
    frame["trade_date"] = pd.to_datetime(frame["trade_date"]).astype("datetime64[ns]")
    membership = (
        frame.assign(_member=True)
        .pivot_table(index="trade_date", columns="symbol", values="_member", aggfunc="first")
        .notna()
        .sort_index()
    )
    membership.columns.name = None
    meta: dict[str, Any] = {}
    meta_path = universe_meta_file(universe, root)
    if meta_path.is_file():
        try:
            loaded = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            logger.warning("warehouse universe roster meta unreadable (%s): %s", meta_path, exc)
            loaded = None
        if isinstance(loaded, dict):
            version = loaded.get("schema_version")
            if isinstance(version, int) and version > SCHEMA_VERSION:
                raise WarehouseSchemaMismatch(
                    f"universe roster {meta_path} declares schema_version={version}, "
                    f"this build understands {SCHEMA_VERSION}"
                )
            meta = loaded
    return membership, meta


def list_universes(root: Path | None = None) -> list[str]:
    """Return the universe names that have a stored roster, sorted."""
    base = (root or warehouse_root()) / "universe"
    if not base.is_dir():
        return []
    return sorted(
        child.name for child in base.iterdir() if (child / "membership.parquet").is_file()
    )
