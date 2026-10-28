"""Panel-store hand vectors: deterministic payload + manifest, tamper detection."""

from __future__ import annotations

import hashlib
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from src.factors.panel_store import (
    StoredPanel,
    list_panels,
    panel_digest,
    read_panel,
    verify_panel,
    write_panel,
)

ALPHA = "alpha101_alpha001"


def _factor() -> pd.DataFrame:
    return pd.DataFrame(
        [[1.0, np.nan], [2.5, -3.0], [np.nan, 0.0]],
        index=pd.DatetimeIndex(["2024-01-02", "2024-01-03", "2024-01-04"]),
        columns=["000001.SZ", "600000.SH"],
    )


def _write(root: Path, factor: pd.DataFrame | None = None, **overrides) -> Path:
    kwargs = dict(alpha_id=ALPHA, universe="csi300", period="2024-2024", horizon=1)
    kwargs.update(overrides)
    return write_panel(root, _factor() if factor is None else factor, **kwargs)


def _manifest(path: Path) -> dict:
    return json.loads(path.with_suffix(".json").read_text(encoding="utf-8"))


# ── 4.1 round trip ────────────────────────────────────────────────────────

def test_vector_a_round_trip(tmp_path):
    factor = _factor()
    path = _write(tmp_path, factor)
    stored = read_panel(path)
    assert isinstance(stored, StoredPanel)
    pd.testing.assert_frame_equal(factor, stored.factor)


def test_vector_a_manifest_fields(tmp_path):
    path = _write(tmp_path)
    manifest = _manifest(path)
    assert manifest["format_version"] == 1
    assert manifest["alpha_id"] == ALPHA
    assert manifest["universe"] == "csi300"
    assert manifest["period"] == "2024-2024"
    assert manifest["horizon"] == 1
    assert manifest["data_source"] is None
    assert manifest["rows"] == 3 and manifest["cols"] == 2
    assert manifest["index_start"] == "2024-01-02"
    assert manifest["index_end"] == "2024-01-04"
    assert manifest["non_null"] == {"000001.SZ": 2, "600000.SH": 2}


# ── 4.2 values sha ────────────────────────────────────────────────────────

def test_vector_b_values_sha_is_independently_computable(tmp_path):
    path = _write(tmp_path)
    manifest = _manifest(path)
    expected_values = np.array(
        [[1.0, np.nan], [2.5, -3.0], [np.nan, 0.0]], dtype=np.float64
    )
    assert manifest["values_sha256"] == hashlib.sha256(
        expected_values.tobytes(order="C")
    ).hexdigest()
    assert manifest["payload_sha256"] == hashlib.sha256(path.read_bytes()).hexdigest()


# ── 4.3 digest determinism ────────────────────────────────────────────────

def test_vector_c_digest_is_order_insensitive():
    a = _factor()
    b = _factor()
    first = {"open": a, "close": b}
    second = {"close": b, "open": a}
    assert panel_digest(first) == panel_digest(second)


def test_vector_c_digest_changes_with_values_columns_keys():
    base = {"close": _factor()}
    changed_value = _factor()
    changed_value.iloc[0, 0] = 1.0000001
    changed_column = _factor()
    changed_column.columns = ["000001.SZ", "600001.SH"]
    assert panel_digest(base) != panel_digest({"close": changed_value})
    assert panel_digest(base) != panel_digest({"close": changed_column})
    assert panel_digest(base) != panel_digest({"close": _factor(), "open": _factor()})


def test_vector_c_digest_ignores_meta():
    base = {"close": _factor()}
    meta_a = {"close": _factor(), "_meta": {"survivorship_bias": False}}
    meta_b = {"close": _factor(), "_meta": {"survivorship_bias": True}}
    assert panel_digest(meta_a) == panel_digest(meta_b) == panel_digest(base)


def test_panel_digest_rejects_non_mapping():
    with pytest.raises(TypeError):
        panel_digest([("close", _factor())])  # type: ignore[arg-type]


def test_panel_digest_empty_input_is_sha256_of_nothing():
    empty = hashlib.sha256(b"").hexdigest()
    assert panel_digest({}) == empty
    assert panel_digest({"_meta": {"survivorship_bias": False}}) == empty


# ── 4.4 tamper detection ──────────────────────────────────────────────────

def test_vector_d_tampered_payload_is_detected(tmp_path):
    path = _write(tmp_path)
    raw = bytearray(path.read_bytes())
    raw[200] ^= 0xFF
    path.write_bytes(bytes(raw))
    with pytest.raises(ValueError, match="payload changed"):
        read_panel(path)


def test_vector_d_verify_panel_reports_ok_false(tmp_path):
    path = _write(tmp_path)
    assert verify_panel(path) == {"ok": True, "reason": None}
    raw = bytearray(path.read_bytes())
    raw[200] ^= 0xFF
    path.write_bytes(bytes(raw))
    report = verify_panel(path)
    assert report["ok"] is False
    assert "payload changed" in report["reason"]


# ── 4.5 manifest/payload mismatch ─────────────────────────────────────────

def test_vector_e_manifest_rows_mismatch_raises(tmp_path):
    path = _write(tmp_path)
    manifest = _manifest(path)
    manifest["rows"] = 4
    path.with_suffix(".json").write_text(
        json.dumps(manifest, sort_keys=True, separators=(",", ":")), encoding="utf-8"
    )
    with pytest.raises(ValueError, match="manifest"):
        read_panel(path)


def test_vector_e_manifest_non_null_mismatch_raises(tmp_path):
    path = _write(tmp_path)
    manifest = _manifest(path)
    manifest["non_null"]["000001.SZ"] = 3
    path.with_suffix(".json").write_text(
        json.dumps(manifest, sort_keys=True, separators=(",", ":")), encoding="utf-8"
    )
    with pytest.raises(ValueError, match="non_null"):
        read_panel(path)


# ── 4.6 overwrite semantics ───────────────────────────────────────────────

def test_vector_f_existing_target_raises_without_overwrite(tmp_path):
    path = _write(tmp_path)
    before = path.read_bytes()
    with pytest.raises(FileExistsError):
        _write(tmp_path, _factor() * 2.0)
    assert path.read_bytes() == before


def test_vector_f_overwrite_replaces_content(tmp_path):
    path = _write(tmp_path)
    changed = _factor() * 2.0
    _write(tmp_path, changed, overwrite=True)
    pd.testing.assert_frame_equal(read_panel(path).factor, changed)


def test_failed_write_leaves_no_temporary_files(tmp_path):
    bad = _factor().astype(object)
    bad.iloc[0, 0] = "not-a-number"
    with pytest.raises(TypeError):
        _write(tmp_path, bad)
    assert [p.name for p in tmp_path.iterdir()] == []


# ── reproducibility ───────────────────────────────────────────────────────

def test_second_write_is_byte_identical(tmp_path):
    left = tmp_path / "left"
    right = tmp_path / "right"
    left.mkdir()
    right.mkdir()
    left_path = _write(left)
    right_path = _write(right)
    assert left_path.read_bytes() == right_path.read_bytes()
    assert (
        left_path.with_suffix(".json").read_bytes()
        == right_path.with_suffix(".json").read_bytes()
    )


def test_nan_and_inf_are_preserved(tmp_path):
    factor = _factor().copy()
    factor.iloc[1, 1] = np.inf
    path = _write(tmp_path, factor)
    back = read_panel(path).factor
    assert np.isnan(back.iloc[0, 1])
    assert np.isinf(back.iloc[1, 1]) and back.iloc[1, 1] > 0


# ── empty + listing ───────────────────────────────────────────────────────

def test_empty_panel_round_trip(tmp_path):
    empty = pd.DataFrame(
        index=pd.DatetimeIndex([]), columns=pd.Index([], dtype=object), dtype=float
    )
    path = _write(tmp_path, empty)
    stored = read_panel(path)
    assert stored.factor.empty
    assert _manifest(path)["non_null"] == {}


def test_zero_row_panel_round_trip(tmp_path):
    empty = pd.DataFrame(
        index=pd.DatetimeIndex([]),
        columns=["000001.SZ", "600000.SH"],
        dtype=float,
    )
    path = _write(tmp_path, empty)
    stored = read_panel(path)
    assert stored.factor.shape == (0, 2)
    manifest = _manifest(path)
    assert manifest["non_null"] == {"000001.SZ": 0, "600000.SH": 0}
    assert manifest["index_start"] == "" and manifest["index_end"] == ""


def test_list_panels_is_sorted_and_typed(tmp_path):
    _write(tmp_path, alpha_id="zeta")
    _write(tmp_path, alpha_id="alpha")
    table = list_panels(tmp_path)
    assert table.columns.tolist() == [
        "alpha_id",
        "universe",
        "period",
        "horizon",
        "data_source",
        "rows",
        "cols",
        "non_null_total",
        "panel_digest",
        "values_sha256",
        "path",
    ]
    assert table["alpha_id"].tolist() == ["alpha", "zeta"]
    assert table["non_null_total"].tolist() == [4, 4]
    assert table["path"].map(lambda p: Path(p).is_absolute()).all()


def test_list_panels_sorts_by_alpha_id_not_filename(tmp_path):
    # "alpha" < "alpha.beta" as alpha ids, but "alpha.beta.json" < "alpha.json"
    # as filenames -- filename order must not leak into the table order.
    _write(tmp_path, alpha_id="alpha")
    _write(tmp_path, alpha_id="alpha.beta")
    table = list_panels(tmp_path)
    assert table["alpha_id"].tolist() == ["alpha", "alpha.beta"]


def test_list_panels_empty_directory(tmp_path):
    table = list_panels(tmp_path)
    assert table.empty
    assert table.columns.tolist()[0] == "alpha_id"


def test_list_panels_missing_key_raises(tmp_path):
    path = _write(tmp_path)
    manifest = _manifest(path)
    del manifest["universe"]
    path.with_suffix(".json").write_text(
        json.dumps(manifest, sort_keys=True, separators=(",", ":")), encoding="utf-8"
    )
    with pytest.raises(ValueError, match="universe"):
        list_panels(tmp_path)


# ── validation ────────────────────────────────────────────────────────────

def test_read_missing_files_raise(tmp_path):
    with pytest.raises(FileNotFoundError):
        read_panel(tmp_path / "missing.npz")
    path = _write(tmp_path)
    path.with_suffix(".json").unlink()
    with pytest.raises(FileNotFoundError):
        read_panel(path)


@pytest.mark.parametrize(
    "kwargs",
    [
        pytest.param({"alpha_id": ""}, id="empty-alpha"),
        pytest.param({"alpha_id": "a/b"}, id="slash-alpha"),
        pytest.param({"alpha_id": "a\\b"}, id="backslash-alpha"),
        pytest.param({"universe": ""}, id="empty-universe"),
        pytest.param({"period": ""}, id="empty-period"),
        pytest.param({"horizon": 0}, id="horizon-zero"),
        pytest.param({"horizon": True}, id="horizon-bool"),
        pytest.param({"overwrite": "yes"}, id="overwrite-str"),
    ],
)
def test_bad_arguments_raise(tmp_path, kwargs):
    with pytest.raises((TypeError, ValueError)):
        _write(tmp_path, **kwargs)


def test_non_dataframe_raises(tmp_path):
    with pytest.raises(TypeError):
        write_panel(tmp_path, np.zeros((2, 2)), alpha_id=ALPHA, universe="u", period="p")


def test_non_datetime_index_raises(tmp_path):
    factor = _factor()
    factor.index = [0, 1, 2]
    with pytest.raises(TypeError):
        _write(tmp_path, factor)


def test_non_increasing_index_raises(tmp_path):
    factor = _factor().iloc[::-1]
    with pytest.raises(ValueError):
        _write(tmp_path, factor)


def test_duplicate_or_empty_columns_raise(tmp_path):
    duplicate = _factor().copy()
    duplicate.columns = ["000001.SZ", "000001.SZ"]
    with pytest.raises(ValueError):
        _write(tmp_path, duplicate)
    empty = _factor().copy()
    empty.columns = ["", "600000.SH"]
    with pytest.raises(ValueError):
        _write(tmp_path, empty)


def test_object_dtype_raises(tmp_path):
    factor = _factor().astype(object)
    factor.iloc[0, 0] = "x"
    with pytest.raises(TypeError):
        _write(tmp_path, factor)
