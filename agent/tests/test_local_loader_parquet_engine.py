"""Fork-side pins for the two parquet read engines of the local loader.

Upstream's ``test_local_loader.py`` stubs ``pd.read_parquet``, so it only ever
reaches the pandas leg. This file covers the leg a clean install actually runs:
``duckdb`` is a declared dependency, ``pyarrow``/``fastparquet`` are not, so
``pd.read_parquet`` raises ``ImportError`` there and DuckDB reads the file.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd
import pytest

import backtest.loaders.local_loader as local_loader


def _no_engine(path: object) -> pd.DataFrame:  # pragma: no cover - called via monkeypatch
    """Stand in for a machine without pyarrow or fastparquet installed."""
    raise ImportError("Unable to find a usable engine; tried: 'pyarrow', 'fastparquet'")


def _write_parquet(path: Path, select: str) -> None:
    """Write one parquet file with DuckDB, the engine the fallback leg reads with."""
    duckdb = pytest.importorskip("duckdb")
    con = duckdb.connect(database=":memory:")
    try:
        con.execute(
            f"COPY (SELECT {select}) TO {local_loader._duckdb_sql_string(path.as_posix())} "
            "(FORMAT PARQUET)"
        )
    finally:
        con.close()


_OHLCV = (
    "10.0::DOUBLE AS open, 12.0::DOUBLE AS high, 9.0::DOUBLE AS low, "
    "11.0::DOUBLE AS close, 100::DOUBLE AS volume"
)


@pytest.mark.parametrize("date_format", [None, "%Y-%m-%d"])
def test_duckdb_leg_supplies_dates_from_a_datetime_column_with_any_format(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, date_format: str | None
) -> None:
    """A parquet without a mapped date column is still read when date_format is set.

    DuckDB gives no DatetimeIndex back, so the datetime column has to be found by
    ``_recovered_index_column`` whatever the configured format says; parsing a
    datetime64 column with a string format does not lose the bars.
    """
    path = tmp_path / "bars.parquet"
    _write_parquet(
        path,
        f"TIMESTAMP '2026-01-01' AS trade_time, {_OHLCV}",
    )
    monkeypatch.setattr(pd, "read_parquet", _no_engine)

    result = local_loader._read_parquet(
        str(path), dict(local_loader._DEFAULT_COLUMNS), date_format
    )

    assert result is not None
    assert len(result) == 1
    assert result["close"].tolist() == [11.0]
    assert result.index[0] == pd.Timestamp("2026-01-01")


def test_duckdb_leg_prefers_the_unnamed_index_sentinel_over_a_later_datetime(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """``__index_level_0__`` is the bar date even when another datetime column exists.

    A pandas-written parquet lands its unnamed index under that sentinel name, and
    a second datetime column in the file cannot be the date; the sentinel is checked
    before the lone-column and last-position rules, so the sentinel here is written
    first and the other datetime last — the position rule alone would pick it up.
    """
    path = tmp_path / "indexed.parquet"
    _write_parquet(
        path,
        "TIMESTAMP '2026-01-02' AS \"__index_level_0__\", "
        f"{_OHLCV}, TIMESTAMP '2026-03-01' AS ingested_at",
    )
    monkeypatch.setattr(pd, "read_parquet", _no_engine)

    result = local_loader._read_parquet(
        str(path), dict(local_loader._DEFAULT_COLUMNS), None
    )

    assert result is not None
    assert result.index[0] == pd.Timestamp("2026-01-02")


def test_duckdb_leg_keeps_an_explicitly_mapped_date_column(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A mapped date column wins over a recovered datetime column."""
    path = tmp_path / "explicit.parquet"
    _write_parquet(
        path,
        "'2026-05-05'::VARCHAR AS trade_date, "
        f"{_OHLCV}, TIMESTAMP '2026-01-01' AS bar_time",
    )
    monkeypatch.setattr(pd, "read_parquet", _no_engine)

    result = local_loader._read_parquet(
        str(path), {**local_loader._DEFAULT_COLUMNS, "date": "trade_date"}, None
    )

    assert result is not None
    assert result.index[0] == pd.Timestamp("2026-05-05")
