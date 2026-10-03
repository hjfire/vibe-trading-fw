# agent/tests/pine_oracle/test_schema.py
"""The fixture contract: one encoding, one normalisation, one hash definition."""

import json

import pytest

from pine_oracle.schema import (
    EXEMPTION_CLASSES,
    NA_ENCODING,
    TOLERANCE_TIERS,
    canonical_bytes,
    dump_manifest,
    fmt_float,
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


@pytest.mark.parametrize("x", [0.0, 1.0, -3.5, 1 / 3, 2.6666666666666665, 1e-12, 1.7976931348623157e308])
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
    data = {"tolerance_tier": {"sma": "tight"}, "exemption": {"sma": "strict"}}
    assert json.loads(dump_manifest(data)) == data
    assert dump_manifest(data) == dump_manifest(dict(sorted(data.items())))
    assert "\r" not in dump_manifest(data)


def _manifest(**overrides):
    """A complete, valid document with the given keys replaced — so a bad value
    produces exactly the error under test and not six 'missing key' errors."""
    base = {
        "na_encoding": "empty",
        "line_ending": "lf",
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


@pytest.mark.parametrize("missing", ["na_encoding", "line_ending", "tolerance_tier", "exemption", "external_anchors", "files"])
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


def test_write_text_lf_refuses_cr_in_content(tmp_path) -> None:
    with pytest.raises(ValueError):
        write_text_lf(tmp_path / "x.csv", "a\rb\nc\n")


def test_fixture_dir_is_derived_from_the_package_not_the_cwd(tmp_path, monkeypatch) -> None:
    from pine_oracle import schema
    from pine_oracle.schema import FIXTURE_DIR, REPO_ROOT

    assert FIXTURE_DIR == REPO_ROOT / "frontend" / "src" / "lib" / "__tests__" / "__fixtures__" / "pine_oracle"
    assert (REPO_ROOT / "frontend" / "src" / "lib" / "pineTa.ts").is_file()
    monkeypatch.chdir(tmp_path)          # 换到一个空目录，路径必须一个字都不变
    assert schema.FIXTURE_DIR == FIXTURE_DIR
