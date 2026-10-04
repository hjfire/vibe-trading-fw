"""Write the four committed bar fixtures. From the repository root:

    PYTHONPATH=agent python -X utf8 -m pine_oracle.emit_bars

``PYTHONPATH=agent`` is needed because only ``pytest`` gets ``agent`` on the path
automatically (root ``pyproject.toml:277``). The target directory comes from
``schema.FIXTURE_DIR``, which is derived from ``__file__`` — not from the cwd.
"""

from __future__ import annotations

from pathlib import Path

from pine_oracle.bars import (
    DAILY_BAR_COUNT,
    INTRADAY_SESSIONS,
    bars_csv_text,
    make_daily_bars,
    make_intraday_bars,
)
from pine_oracle.schema import FIXTURE_DIR, sha256_of, write_text_lf

#: ``(basename, rows, writes_the_session_column)`` for each committed bar fixture.
BAR_JOBS: tuple[tuple[str, list[dict], bool], ...] = (
    ("bars_daily_trend", make_daily_bars(11, DAILY_BAR_COUNT, "trend"), False),
    ("bars_daily_oscillating", make_daily_bars(17, DAILY_BAR_COUNT, "oscillate"), False),
    ("bars_daily_gapped", make_daily_bars(23, DAILY_BAR_COUNT, "gap"), False),
    ("bars_intraday_vwap", make_intraday_bars(13, INTRADAY_SESSIONS), True),
)

#: basename -> (seed, shape). The manifest declares these, and it derives them from
#: here rather than restating them, so a seed change cannot leave the manifest
#: describing bars that no longer exist.
BARS_META: dict[str, tuple[int, str]] = {
    "bars_daily_trend": (11, "trend"),
    "bars_daily_oscillating": (17, "oscillate"),
    "bars_daily_gapped": (23, "gap"),
    "bars_intraday_vwap": (13, "intraday"),
}

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
