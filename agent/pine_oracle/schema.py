"""The fixture contract, in one place.

Why this module exists: the JS gate and the Python generator agree only if a
single definition of encoding, line ending and hashing is shared. Both
``core.autocrlf=true`` (this machine) and Git's text handling can rewrite bytes
at checkout, so the hash is defined over LF-normalised content on purpose —
normalising explicitly beats normalising by accident, which is how a previous
round's ``sed`` evidence misled (R-46).

All public helpers are total: they raise on contract violations instead of
silently coercing junk, because a silently coerced fixture is a false green.
"""

from __future__ import annotations

import hashlib
import json
from pathlib import Path
from typing import Any

#: ``agent/pine_oracle/schema.py`` → two levels up is the repository root.
REPO_ROOT: Path = Path(__file__).resolve().parents[2]
FIXTURE_DIR: Path = (
    REPO_ROOT / "frontend" / "src" / "lib" / "__tests__" / "__fixtures__" / "pine_oracle"
)

TOLERANCE_TIERS: dict[str, float] = {"exact": 0.0, "tight": 1e-12, "loose": 1e-9}
#: The two guarded classes each name one engine fact that would make the prefix gate
#: red for a reason that is NOT lookahead: ``this.tick = estimateTick(bars)`` is
#: estimated from the WHOLE series (`pineRuntime.ts:344-349`), so a sliced run can
#: legitimately differ on the last bar of a price-tick-quantised output, and
#: ``PineRunOptions.lowerBars`` (`pineRuntime.ts:176-189`) is what lets MTF output
#: see a different aligned series at all. Spec §4 puts both in the contract; no line
#: in the first batch is in either class (all 18 exemptions are ``strict``), and the
#: provenance gate asserts that rather than letting it drift.
EXEMPTION_CLASSES: tuple[str, ...] = ("strict", "tick_guarded", "mtf_guarded")
NA_ENCODING = "empty"

BAR_COLUMNS: tuple[str, ...] = ("bar_index", "time", "open", "high", "low", "close", "volume")
BARS_INTRADAY_EXTRA_COLUMNS: tuple[str, ...] = ("session",)
VALUE_HEADER: tuple[str, ...] = ("bar_index", "expected")

_REQUIRED_MANIFEST_KEYS: tuple[str, ...] = (
    "na_encoding",
    "line_ending",
    "tolerance_tier",
    "exemption",
    "external_anchors",
    "files",
)


def fmt_float(x: float) -> str:
    """Shortest round-trip decimal for a float, empty field for non-finite."""
    if x != x or x in (float("inf"), float("-inf")):
        return ""
    return repr(float(x))


def parse_float(text: str) -> float:
    """Inverse of :func:`fmt_float`; the empty field means Pine ``na``."""
    if text == "":
        return float("nan")
    return float(text)


def canonical_bytes(text: str) -> bytes:
    """UTF-8 bytes with CRLF folded to LF — the only form a fixture is hashed in."""
    if "\r" in text:
        text = text.replace("\r\n", "\n").replace("\r", "\n")
    return text.encode("utf-8")


def sha256_of(path: Path) -> str:
    """Hash the file's LF-normalised bytes, so a CRLF checkout hashes the same."""
    raw = path.read_bytes()
    return hashlib.sha256(raw.replace(b"\r\n", b"\n")).hexdigest()


def write_text_lf(path: Path, text: str) -> None:
    """Write LF-only text; refuse rather than emit a file whose hash depends on checkout."""
    if "\r" in text:
        raise ValueError(f"{path}: refusing to write a CR byte; the contract is LF-only")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(canonical_bytes(text))


def dump_manifest(data: dict[str, Any]) -> str:
    """Deterministic manifest text: sorted keys, 2-space indent, trailing LF, no CR."""
    return json.dumps(data, indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def load_manifest(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def validate_manifest(data: dict[str, Any]) -> list[str]:
    """Return contract errors for ``data``; an empty list means it is well formed."""
    errors: list[str] = []
    for key in _REQUIRED_MANIFEST_KEYS:
        if key not in data:
            errors.append(f"manifest: missing required key {key!r}")
    for name, tier in (data.get("tolerance_tier") or {}).items():
        if tier not in TOLERANCE_TIERS:
            errors.append(f"manifest tolerance_tier[{name}]={tier!r} is not a tier name")
    for line, cls in (data.get("exemption") or {}).items():
        if cls not in EXEMPTION_CLASSES:
            errors.append(f"manifest exemption[{line}]={cls!r} is not a class")
    if data.get("na_encoding") not in (None, NA_ENCODING):
        errors.append(f"manifest na_encoding={data['na_encoding']!r}, expected {NA_ENCODING!r}")
    if data.get("line_ending") not in (None, "lf"):
        errors.append(f"manifest line_ending={data['line_ending']!r}, expected 'lf'")
    return errors
