"""The fixture contract: one encoding, one normalisation, one hash definition."""

import hashlib
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

from pine_oracle.schema import (
    EXEMPTION_CLASSES,
    NA_ENCODING,
    REPO_ROOT,
    TOLERANCE_TIERS,
    _REQUIRED_MANIFEST_KEYS,
    canonical_bytes,
    dump_manifest,
    fmt_float,
    load_manifest,
    parse_float,
    sha256_of,
    validate_manifest,
    write_text_lf,
)


def test_tiers_are_the_three_declared_values() -> None:
    assert TOLERANCE_TIERS == {"exact": 0.0, "tight": 1e-12, "loose": 1e-9}
    assert EXEMPTION_CLASSES == ("strict", "tick_guarded", "mtf_guarded")


def test_na_encoding_is_the_empty_field_and_nothing_else() -> None:
    assert NA_ENCODING == "empty"
    assert fmt_float(float("nan")) == ""
    assert fmt_float(float("inf")) == ""


@pytest.mark.parametrize(
    "x",
    [
        0.0,
        1.0,
        -3.5,
        1 / 3,
        2.6666666666666665,
        1e-12,
        1.7976931348623157e308,
        -0.0,
        0.1 + 0.2,
        5e-324,
    ],
)
def test_float_text_round_trips_bit_for_bit(x: float) -> None:
    assert parse_float(fmt_float(x)) == x


def test_canonical_bytes_normalises_crlf_to_lf() -> None:
    assert canonical_bytes("a\r\nb\r\n") == b"a\nb\n"
    assert canonical_bytes("a\nb\n") == b"a\nb\n"


def test_sha_is_insensitive_to_checkout_line_endings(tmp_path) -> None:
    a = tmp_path / "a.csv"
    b = tmp_path / "b.csv"
    a.write_bytes(b"x,y\r\n1,2\r\n")   # what core.autocrlf=true can hand us
    b.write_bytes(b"x,y\n1,2\n")       # what the generator wrote
    assert sha256_of(a) == sha256_of(b)


def test_manifest_round_trip_is_byte_stable() -> None:
    # Two inputs built explicitly in opposite orders: `sort_keys=True` is what makes
    # them agree, so this comparison carries information instead of re-dumping one dict.
    forward = {"tolerance_tier": {"sma": "tight"}, "exemption": {"sma": "strict"}}
    backward = {"exemption": {"sma": "strict"}, "tolerance_tier": {"sma": "tight"}}
    assert json.loads(dump_manifest(forward)) == forward
    assert dump_manifest(forward) == dump_manifest(backward)
    # Trailing LF is the documented tail of the contract; the old `"\r" not in` check
    # could never fail (json.dumps escapes a CR into the two characters ``\r``), so the
    # red-capable CR guard lives in test_dump_manifest_round_trips_through_disk.
    assert dump_manifest(forward).endswith("\n")


def _manifest(**overrides):
    """A complete, valid document with the given keys replaced — so a bad value
    produces exactly the error under test and not eleven 'missing key' errors.
    Key set is `_REQUIRED_MANIFEST_KEYS`; this helper does not hand-copy it (the
    missing-key case below parametrises off the module) but the values have to be
    written here, so the one-to-one check is the parametrised test's job."""
    base = {
        "na_encoding": "empty",
        "line_ending": "lf",
        "period": {"default": 14},
        "seed": {"bars_daily_trend": 1234},
        "shape": {"bars_daily_trend": "daily"},
        "scripts": {"trend": "batch_1"},
        "lines": {"trend": ["sma"]},
        "tolerance_tier": {"sma": "tight"},
        "exemption": {"sma": "strict"},
        "external_anchors": [],
        "files": {"bars_daily_trend.csv": "0" * 64},
    }
    return {**base, **overrides}


def test_validate_manifest_accepts_a_well_formed_document() -> None:
    assert validate_manifest(_manifest()) == []


def test_validate_manifest_rejects_a_bad_tier_or_class() -> None:
    bad = _manifest(
        tolerance_tier={"sma": "1e-6"},
        exemption={"sma": "look-the-other-way"},
    )
    errors = validate_manifest(bad)
    assert len(errors) == 2, errors
    assert any("tolerance_tier[sma]" in e for e in errors), errors
    assert any("exemption[sma]" in e for e in errors), errors


@pytest.mark.parametrize("missing", _REQUIRED_MANIFEST_KEYS)
def test_validate_manifest_names_every_missing_required_key(missing: str) -> None:
    doc = _manifest()
    del doc[missing]
    errors = validate_manifest(doc)
    assert len(errors) == 1, errors
    assert missing in errors[0], errors


def test_validate_manifest_rejects_a_wrong_na_encoding() -> None:
    errors = validate_manifest(_manifest(na_encoding="NaN"))
    assert len(errors) == 1, errors
    assert "na_encoding" in errors[0], errors


def test_validate_manifest_rejects_an_all_null_or_empty_document() -> None:
    # Every key present, every value null — the document that used to read as legal
    # because the old checks were `data.get(k) or {}` and `not in (None, ...)`.
    all_null = {key: None for key in _REQUIRED_MANIFEST_KEYS}
    errors = validate_manifest(all_null)
    assert len(errors) >= 4, errors
    assert any("tolerance_tier must be a mapping" in e for e in errors), errors
    assert any("external_anchors must be a list" in e for e in errors), errors
    assert any("na_encoding" in e for e in errors), errors
    # An empty tier map is the vacuum-pass this gate exists to catch: zero lines would
    # be compared, and the JS gate would still report green.
    empty = validate_manifest(_manifest(tolerance_tier={}))
    assert len(empty) == 1, empty
    assert "tolerance_tier is empty" in empty[0], empty
    # `external_anchors: []` stays legal (no anchor declared yet is an honest reading,
    # spec §9 R-B) — a legal empty list must not be swept up by the rule above.
    assert validate_manifest(_manifest(external_anchors=[])) == []


def test_write_text_lf_refuses_cr_in_content(tmp_path) -> None:
    with pytest.raises(ValueError):
        write_text_lf(tmp_path / "x.csv", "a\rb\nc\n")


def test_write_text_lf_emits_canonical_bytes(tmp_path) -> None:
    p = tmp_path / "x.csv"
    text = "bar_index,expected\n0,\n"
    write_text_lf(p, text)
    assert p.read_bytes() == canonical_bytes(text) == b"bar_index,expected\n0,\n"
    assert b"\r" not in p.read_bytes()
    assert sha256_of(p) == hashlib.sha256(canonical_bytes(text)).hexdigest()


def test_dump_manifest_round_trips_through_disk(tmp_path) -> None:
    data = _manifest()
    path = tmp_path / "manifest.json"
    write_text_lf(path, dump_manifest(data))
    # The red-capable CR guard: on Windows a `write_text` regression turns every LF into
    # CRLF here, which is exactly what the manifest hash and Task 7's reader must not see.
    assert b"\r" not in path.read_bytes()
    assert load_manifest(path) == data


def test_fixture_dir_is_derived_from_the_package_not_the_cwd(tmp_path) -> None:
    from pine_oracle import schema
    from pine_oracle.schema import FIXTURE_DIR

    expected = REPO_ROOT / "frontend" / "src" / "lib" / "__tests__" / "__fixtures__" / "pine_oracle"
    assert FIXTURE_DIR == expected
    assert (REPO_ROOT / "frontend" / "src" / "lib" / "pineTa.ts").is_file()

    # The load-bearing half. `monkeypatch.chdir` cannot move a module-level constant that
    # was already bound at import, so an in-process assertion can never see a
    # `REPO_ROOT = Path.cwd()` regression when pytest happens to run from the repo root.
    # A fresh interpreter launched from a throwaway cwd can: its `Path.cwd()` is
    # `tmp_path`, so a cwd-derived REPO_ROOT prints a path under tmp_path.
    env = dict(os.environ, PYTHONPATH=str(REPO_ROOT / "agent"))
    proc = subprocess.run(
        [
            sys.executable,
            "-X",
            "utf8",
            "-c",
            "import os\n"
            "from pine_oracle.schema import FIXTURE_DIR\n"
            "print(os.getcwd())\n"
            "print(FIXTURE_DIR)\n",
        ],
        cwd=tmp_path,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )
    assert proc.returncode == 0, proc.stderr
    child_cwd, child_fixture = proc.stdout.splitlines()[-2:]
    # The child really ran somewhere else — without this the equality below could be a
    # repo-root-vs-repo-root tautology whenever pytest happens to sit at the root.
    assert Path(child_cwd) != REPO_ROOT
    assert Path(child_fixture) == expected
    assert schema.FIXTURE_DIR == expected
