"""Emit the value fixtures + manifest the JS oracle gate reads.

Every run rewrites the whole set from the reference implementations, so the
committed CSV is always reproducible from committed Python — which is what makes
the fixture trustworthy (test_pine_oracle_provenance.py).

This module writes the bar fixtures too: ``files`` must cover every byte the JS
gate reads, and a manifest that hashed only the answers would leave the questions
(the bars) free to drift.
"""

from __future__ import annotations

from datetime import date
from pathlib import Path
from subprocess import check_output
from typing import Any, Optional

import numpy as np

from pine_oracle.emit_bars import BAR_JOBS, BARS_BASENAMES, BARS_META, emit as emit_bars
from pine_oracle.reference import PERIOD, REFERENCE, SCRIPTS
from pine_oracle.schema import (
    FIXTURE_DIR,
    REPO_ROOT,
    VALUE_HEADER,
    dump_manifest,
    fmt_float,
    sha256_of,
    validate_manifest,
    write_text_lf,
)

#: A statistic decided by one pass over a fixed window — one mean, one deviation
#: over the trailing ``n`` bars — is ``tight``; anything that carries recursion or
#: state across bars is ``loose``. The classification is by the *quantity*, not by
#: the code shape: ``ta_sma`` happens to be written with a prefix-sum difference,
#: which is still one mean over a fixed window, so ``sma`` is tight even though the
#: implementation accumulates. ``ema`` / ``rma`` are the recursive ones and stay
#: loose. Spec §5, tighten-only.
TIGHT_LINES: frozenset[str] = frozenset(
    {"sma", "stdev", "stdev_sample", "bb_basis", "bb_upper", "bb_lower"}
)

#: basename -> (rows, writes_the_session_column), taken from emit_bars so the seeds
#: and shapes cannot be restated wrong here.
BARS_SETS: dict[str, tuple[list[dict[str, Any]], bool]] = {
    name: (rows, with_session) for name, rows, with_session in BAR_JOBS
}
assert set(BARS_SETS) == set(BARS_BASENAMES) == set(BARS_META), (
    sorted(BARS_SETS),
    sorted(BARS_BASENAMES),
    sorted(BARS_META),
)


def _columns(rows: list[dict[str, Any]]) -> dict[str, np.ndarray]:
    return {
        k: np.asarray([r[k] for r in rows], dtype="float64")
        for k in ("open", "high", "low", "close", "volume")
    }


def _session(rows: list[dict[str, Any]]) -> Optional[np.ndarray]:
    if "session" not in rows[0]:
        return None
    return np.asarray([r["session"] for r in rows], dtype="int64")


def values_csv(series: np.ndarray) -> str:
    lines = [",".join(VALUE_HEADER)]
    for i, v in enumerate(series):
        lines.append(f"{i},{'' if np.isnan(v) else fmt_float(float(v))}")
    return "\n".join(lines) + "\n"


def emit(out_dir: Path = FIXTURE_DIR) -> dict[str, Any]:
    files = {
        str(path.relative_to(out_dir)).replace("\\", "/"): digest
        for path, digest in emit_bars(out_dir)
    }
    tier: dict[str, str] = {}
    exemption: dict[str, str] = {}
    lines_by_batch: dict[str, list[str]] = {}
    for batch_name, fn in REFERENCE.items():
        emitted: set[str] = set()
        for bars_name, (rows, _with_session) in BARS_SETS.items():
            series = fn(_columns(rows), PERIOD, _session(rows))
            for line_name, arr in series.items():
                rel = f"values/{line_name}@{bars_name}.csv"
                path = out_dir / "values" / f"{line_name}@{bars_name}.csv"
                write_text_lf(path, values_csv(arr))
                files[rel] = sha256_of(path)
                emitted.add(line_name)
                tier[line_name] = "tight" if line_name in TIGHT_LINES else "loose"
                exemption[line_name] = "strict"
        lines_by_batch[batch_name] = sorted(emitted)
    manifest: dict[str, Any] = {
        "na_encoding": "empty",
        "line_ending": "lf",
        "period": {"default": PERIOD},
        "seed": {name: meta[0] for name, meta in BARS_META.items()},
        "shape": {name: meta[1] for name, meta in BARS_META.items()},
        "scripts": SCRIPTS,
        "lines": lines_by_batch,
        "tolerance_tier": tier,
        "exemption": exemption,
        # 外部锚点在 Task 5/6 逐批填；空数组是诚实读数，不是失败（spec §9 R-B）。
        "external_anchors": [],
        "generated_at": date.today().isoformat(),
        "generator": "agent/pine_oracle/emit_fixtures.py",
        # Read from the repo this module lives in, not from wherever the caller
        # happened to cd into — the rest of the module is ``__file__``-derived and
        # a cwd-dependent line here would crash (or mislabel) outside the repo root.
        "head_sha": check_output(
            ["git", "rev-parse", "--short", "HEAD"], cwd=REPO_ROOT, text=True
        ).strip(),
        # manifest.json 自己不进 files：自哈希是「先写后哈希」的循环，它既不可能被
        # 自己包含，也不可能被校验，列上它只是假装覆盖了。
        "files": files,
    }
    errors = validate_manifest(manifest)
    if errors:
        raise SystemExit("manifest invalid: " + "; ".join(errors))
    write_text_lf(out_dir / "manifest.json", dump_manifest(manifest))
    return manifest


if __name__ == "__main__":
    m = emit()
    print(
        f"{len(m['files'])} files, {len(m['tolerance_tier'])} lines tiered, "
        f"batches={ {k: len(v) for k, v in m['lines'].items()} }"
    )
