"""Regenerating from the reference implementations must reproduce the committed bytes.

This is the link that makes a committed fixture trustworthy: an edited CSV stops
being evidence and becomes a red test.

Both sides are compared after LF normalisation (schema's own sha definition) because
``core.autocrlf=true`` on this machine rewrites line endings at checkout — machine
fact R-46. Content differences are still caught byte for byte.
"""

from pathlib import Path

from pine_oracle.emit_fixtures import BARS_SETS, FIXTURE_DIR, PERIOD, emit
from pine_oracle.schema import (
    EXEMPTION_CLASSES,
    TOLERANCE_TIERS,
    load_manifest,
    sha256_of,
)


def _lf(path: Path) -> bytes:
    return path.read_bytes().replace(b"\r\n", b"\n")


def test_manifest_lists_every_committed_data_file() -> None:
    """Every data file the gate reads is on disk and hashes to what the manifest says.

    ``*.md`` is excluded because the prose ledger (`COVERAGE.md`, Task 7) and the
    anchor notes (`EXTERNAL_ANCHORS.md`, Task 6) live in this same directory and are
    not fixture data — listing them would put prose under a hash. Everything else is
    still enumerated in both directions, so a dropped, added or edited CSV (or a
    stray non-doc file) goes red.
    """
    manifest = load_manifest(FIXTURE_DIR / "manifest.json")
    listed = manifest["files"]
    on_disk = {
        str(p.relative_to(FIXTURE_DIR)).replace("\\", "/")
        for p in FIXTURE_DIR.rglob("*")
        if p.is_file() and p.suffix != ".md" and p.name not in {".gitattributes", "manifest.json"}
    }
    assert set(listed) == on_disk, (sorted(set(listed) - on_disk), sorted(on_disk - set(listed)))
    for rel, digest in listed.items():
        assert sha256_of(FIXTURE_DIR / rel) == digest, rel


def test_regenerated_files_are_bytewise_identical(tmp_path: Path) -> None:
    emit(out_dir=tmp_path)
    for rel in load_manifest(FIXTURE_DIR / "manifest.json")["files"]:
        assert _lf(tmp_path / rel) == _lf(FIXTURE_DIR / rel), rel


def test_every_declared_line_is_strict_and_tiered_from_the_two_allowed_sets() -> None:
    """A tier or class that quietly loosens defeats the whole harness; this test is
    the audit trail the design's "only ever tighten" rule requires (spec §5)."""
    manifest = load_manifest(FIXTURE_DIR / "manifest.json")
    for line, cls in manifest["exemption"].items():
        assert cls in EXEMPTION_CLASSES, line
    for line, tier in manifest["tolerance_tier"].items():
        assert tier in TOLERANCE_TIERS, line
    assert all(cls == "strict" for cls in manifest["exemption"].values()), manifest["exemption"]


def test_manifest_lines_match_the_scripts_plot_titles() -> None:
    """The fixture must describe exactly the lines the Pine source plots — a plot
    added or renamed without regenerating would otherwise be read from a stale CSV."""
    manifest = load_manifest(FIXTURE_DIR / "manifest.json")
    for batch, src in manifest["scripts"].items():
        titles = sorted(
            part.split('title="')[1].split('"')[0] for part in src.split("\n") if 'title="' in part
        )
        assert manifest["lines"][batch] == titles, (batch, manifest["lines"][batch], titles)


def test_batch_one_lines_are_emitted_for_every_variant() -> None:
    manifest = load_manifest(FIXTURE_DIR / "manifest.json")
    assert manifest["lines"]["batch_1"] == ["ema", "rma", "sma", "stdev", "stdev_sample"]
    assert manifest["tolerance_tier"]["stdev"] == "tight"
    assert manifest["tolerance_tier"]["ema"] == "loose"
    for line in manifest["lines"]["batch_1"]:
        for bars in BARS_SETS:
            assert f"values/{line}@{bars}.csv" in manifest["files"], (line, bars)


def test_values_header_and_na_encoding_are_the_declared_contract() -> None:
    manifest = load_manifest(FIXTURE_DIR / "manifest.json")
    rel = f"values/sma@{next(iter(BARS_SETS))}.csv"
    text = _lf(FIXTURE_DIR / rel).decode("utf-8")
    assert text.splitlines()[0] == "bar_index,expected"
    assert "nan" not in text.lower() and "null" not in text.lower(), rel
    assert manifest["na_encoding"] == "empty"
    assert manifest["period"]["default"] == PERIOD
