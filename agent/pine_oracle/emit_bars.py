"""Write the four committed bar fixtures. From the repository root:

    PYTHONPATH=agent python -X utf8 -m pine_oracle.emit_bars

``PYTHONPATH=agent`` is needed because only ``pytest`` gets ``agent`` on the path
automatically (root ``pyproject.toml:277``). The target directory comes from
``schema.FIXTURE_DIR``, which is derived from ``__file__`` — not from the cwd.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from pine_oracle.bars import (
    DAILY_BAR_COUNT,
    INTRADAY_SESSIONS,
    bars_csv_text,
    make_daily_bars,
    make_intraday_bars,
)
from pine_oracle.schema import FIXTURE_DIR, sha256_of, write_text_lf

#: Single source for "which seed and shape produced which committed fixture". Both
#: public views below are derived from this table, so a seed change cannot leave the
#: manifest describing bars that no longer exist.
_JOBS: tuple[tuple[str, int, str], ...] = (
    ("bars_daily_trend", 11, "trend"),
    ("bars_daily_oscillating", 17, "oscillate"),
    ("bars_daily_gapped", 23, "gap"),
    ("bars_intraday_vwap", 13, "intraday"),
)


def _rows_for(seed: int, shape: str) -> list[dict[str, Any]]:
    """``intraday`` is the only shape that is not a daily one, and it is also the
    only fixture that writes the ``session`` column — so the same string dispatches
    the generator and the header."""
    if shape == "intraday":
        return make_intraday_bars(seed, INTRADAY_SESSIONS)
    return make_daily_bars(seed, DAILY_BAR_COUNT, shape)


#: ``(basename, rows, writes_the_session_column)`` for each committed bar fixture.
BAR_JOBS: tuple[tuple[str, list[dict], bool], ...] = tuple(
    (name, _rows_for(seed, shape), shape == "intraday") for name, seed, shape in _JOBS
)

#: basename -> (seed, shape), derived from ``_JOBS`` (see the note there).
BARS_META: dict[str, tuple[int, str]] = {name: (seed, shape) for name, seed, shape in _JOBS}

BARS_BASENAMES: tuple[str, ...] = tuple(name for name, _, _ in BAR_JOBS)


def emit(out_dir: Path = FIXTURE_DIR) -> list[tuple[Path, str]]:
    """Write the four bar fixtures and return ``(path, sha256)`` for the manifest."""
    written: list[tuple[Path, str]] = []
    for name, rows, with_session in BAR_JOBS:
        path = out_dir / f"{name}.csv"
        write_text_lf(path, bars_csv_text(rows, with_session=with_session))
        written.append((path, sha256_of(path)))
    return written


if __name__ == "__main__":
    for p, digest in emit():
        print(f"{digest[:12]}  {p}")
