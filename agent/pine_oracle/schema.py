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
#: red for a reason that is NOT lookahead. ``this.tick = estimateTick(bars)`` is the
#: call site (`pineRuntime.ts:344`); the definition is `pineOrders.ts:86-96`, whose :88
#: caps the scan at ``Math.min(bars.list.length, 500)`` bars. So tick is estimated from
#: the series the run is handed — never from the whole history — and a sliced run can
#: legitimately see a different tick, which alone can move price-grid-dependent output
#: (`strategy.*` fills). What this does NOT promise is that the difference lands only on
#: the last bar: tick is one scalar per run, so when it changes it can move rounding
#: anywhere inside the slice. ``PineRunOptions.lowerBars`` (`pineRuntime.ts:176-189`) is
#: what lets MTF output see a different aligned series at all. Spec §4 puts both in the
#: contract; no line in the first batch is planned to be in either class — "all 18
#: first-batch exemptions are ``strict``" is a PLANNING expectation for fixtures that do
#: not exist yet, not a measurement made here, and the Task 4 / Task 7 provenance gates
#: are what pin it against the generated manifest. That is why ``tick_guarded`` is
#: reserved but unused here rather than asserted from this module.
EXEMPTION_CLASSES: tuple[str, ...] = ("strict", "tick_guarded", "mtf_guarded")
NA_ENCODING: str = "empty"

BAR_COLUMNS: tuple[str, ...] = ("bar_index", "time", "open", "high", "low", "close", "volume")
BARS_INTRADAY_EXTRA_COLUMNS: tuple[str, ...] = ("session",)
VALUE_HEADER: tuple[str, ...] = ("bar_index", "expected")

#: The manifest keys both sides of the harness read. This list is the contract: the JS
#: gate's ``OracleManifest`` declares the same 11 keys — ``pineOracleFixtures.ts`` is
#: created in Task 3 (plan `2026-10-04-pine-oracle-harness.md:768`, type body ``:829-841``)
#: and written by Task 4's generator — so a manifest that satisfies this tuple but not
#: that type hands the JS gate `undefined` where it aligns line names.
#: `generated_at`, `generator` and `head_sha` are deliberately NOT listed: they are
#: generator metadata owned by the Task 4 / Task 7 provenance gate, not read fields —
#: the narrowness here is a ruling, not an oversight.
_REQUIRED_MANIFEST_KEYS: tuple[str, ...] = (
    "na_encoding",
    "line_ending",
    "period",
    "seed",
    "shape",
    "scripts",
    "lines",
    "tolerance_tier",
    "exemption",
    "external_anchors",
    "files",
)

#: Required keys whose value must be a container of a specific kind — never null, never
#: a look-alike of the wrong kind. Declared separately because `validate_manifest`
#: rejects a present-but-null value: a null container iterates zero lines, which reads as
#: "every line passed" downstream. Together with the two scalar literals checked by exact
#: equality below, this covers ALL 11 required keys, so "present" is never "present with a
#: value that carries no information".
#: The kinds are read off the generator, not guessed: Task 4's ``emit()``
#: (`2026-10-04-pine-oracle-harness.md:1479-1502`) writes ``period`` = ``{"default":
#: PERIOD}``, ``seed``/``shape`` as comprehension-built dicts from ``BARS_META``
#: (``:698``, ``dict[str, tuple[int, str]]``), ``scripts`` = ``SCRIPTS`` (``dict[str,
#: str]``, ``:1366``) and ``lines`` = ``lines_by_batch`` (``dict[str, list[str]]``);
#: the JS side declares the same five as ``Record``s and ``external_anchors`` as
#: ``OracleAnchor[]`` (``:829-841``).
#: `external_anchors` is a LIST and the only one allowed to be empty (an empty list is the
#: honest reading for batches that declare no anchor yet — spec §9 R-B), so a `{}` there is
#: a shape error, not "empty".
_REQUIRED_CONTAINER_KINDS: dict[str, tuple[tuple[type, ...], str]] = {
    "period": ((dict,), "a mapping"),
    "seed": ((dict,), "a mapping"),
    "shape": ((dict,), "a mapping"),
    "scripts": ((dict,), "a mapping"),
    "lines": ((dict,), "a mapping"),
    "tolerance_tier": ((dict,), "a mapping"),
    "exemption": ((dict,), "a mapping"),
    "files": ((dict,), "a mapping"),
    "external_anchors": ((list,), "a list"),
}

#: Required mappings that must carry at least one entry. An empty mapping is not a pass
#: but a vacuous gate: Task 4's provenance assertions iterate ``manifest["exemption"]``
#: and ``all(cls == "strict" for …)``, and the JS gate iterates ``tolerance_tier`` /
#: ``lines`` / ``files`` — on ``{}`` all of them compare nothing and report green. This is
#: the same defect class round 1 caught for ``tolerance_tier`` alone, applied to every key
#: that has a reader which iterates it.
#: `external_anchors` is deliberately NOT listed: an empty anchor list stays legal until
#: Task 6 fills anchors (round 1's ruling; pinned by test so a later pass cannot sweep it
#: up by accident).
_NON_EMPTY_MANIFEST_KEYS: tuple[str, ...] = (
    "period",
    "seed",
    "shape",
    "scripts",
    "lines",
    "tolerance_tier",
    "exemption",
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
    """Return contract errors for ``data``; an empty list means it is well formed.

    A key that is present with a null, wrong-kinded or empty value is an error, not a
    pass: Task 4 calls this as the only gate before committing fixture CSVs, and a
    manifest whose containers came out ``None``, ``[]`` or ``{}`` would be written
    anyway, letting the JS gate iterate zero lines and go green while comparing nothing.
    Every one of the 11 required keys is therefore checked for presence *with a real
    value* — the 9 containers against `_REQUIRED_CONTAINER_KINDS`, the 8 mappings in
    `_NON_EMPTY_MANIFEST_KEYS` again for emptiness, the 2 scalar literals for exact
    equality. `external_anchors` is the one container that may stay an empty list.
    Tiers and exemption classes may only be tightened here, never relaxed.
    """
    errors: list[str] = []
    for key in _REQUIRED_MANIFEST_KEYS:
        if key not in data:
            errors.append(f"manifest: missing required key {key!r}")
    for key, (kinds, kind_name) in _REQUIRED_CONTAINER_KINDS.items():
        if key in data and not isinstance(data[key], kinds):
            errors.append(
                f"manifest: {key} must be {kind_name}, got {type(data[key]).__name__}"
            )
    for key in _NON_EMPTY_MANIFEST_KEYS:
        value = data.get(key)
        if isinstance(value, dict) and not value:
            errors.append(
                f"manifest: {key} is empty — a gate that iterates it compares nothing"
            )
    tiers = data.get("tolerance_tier")
    if isinstance(tiers, dict):
        for name, tier in tiers.items():
            if tier not in TOLERANCE_TIERS:
                errors.append(f"manifest tolerance_tier[{name}]={tier!r} is not a tier name")
    exemptions = data.get("exemption")
    if isinstance(exemptions, dict):
        for line, cls in exemptions.items():
            if cls not in EXEMPTION_CLASSES:
                errors.append(f"manifest exemption[{line}]={cls!r} is not a class")
    if "na_encoding" in data and data["na_encoding"] != NA_ENCODING:
        errors.append(f"manifest na_encoding={data['na_encoding']!r}, expected {NA_ENCODING!r}")
    if "line_ending" in data and data["line_ending"] != "lf":
        errors.append(f"manifest line_ending={data['line_ending']!r}, expected 'lf'")
    return errors
