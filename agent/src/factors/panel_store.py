"""Deterministic on-disk store for computed factor panels.

One alpha panel is one ``<alpha_id>.npz`` payload plus a same-stem ``.json``
manifest. The payload is plain numpy -- ``pyarrow`` exists in some environments
but is not a declared dependency, so parquet is deliberately out of scope. The
manifest carries the provenance needed to decide whether a stored panel may be
reused (alpha id, universe, period, horizon, data source, input-panel digest)
and the hashes needed to prove the bytes were not changed.

Writes are atomic: payload and manifest are staged to temporary files in the
target directory and moved into place with ``os.replace``. There is no
``created_at`` -- the same input written twice produces byte-identical files.
"""

from __future__ import annotations

import hashlib
import json
import os
import tempfile
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

__all__ = [
    "StoredPanel",
    "list_panels",
    "panel_digest",
    "read_panel",
    "verify_panel",
    "write_panel",
]

_FORMAT_VERSION = 1
_PAYLOAD_KEYS = {"values", "index", "columns", "format_version"}
_MANIFEST_KEYS = (
    "format_version",
    "alpha_id",
    "universe",
    "period",
    "horizon",
    "data_source",
    "rows",
    "cols",
    "index_start",
    "index_end",
    "non_null",
    "panel_digest",
    "values_sha256",
    "payload_sha256",
)
_LIST_COLUMNS = [
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


@dataclass(frozen=True)
class StoredPanel:
    factor: pd.DataFrame
    manifest: dict


def _digest_segment(value: object) -> bytes:
    if isinstance(value, pd.DataFrame):
        values = value.to_numpy(dtype=np.float64)
        index = value.index
        if isinstance(index, pd.DatetimeIndex):
            index_bytes = index.to_numpy(dtype="datetime64[ns]").astype(np.int64).tobytes()
        else:
            index_bytes = "\x1f".join(str(item) for item in index).encode("utf-8")
        column_bytes = "\x1f".join(str(column) for column in value.columns).encode("utf-8")
        return values.tobytes(order="C") + b"\x00" + index_bytes + b"\x00" + column_bytes
    return repr(value).encode("utf-8")


def panel_digest(panel: Mapping[str, object]) -> str:
    """SHA-256 over an input panel, ignoring ``_meta`` and dict insertion order."""
    if not isinstance(panel, Mapping):
        raise TypeError(f"panel must be a mapping, got {type(panel).__name__}")
    digest = hashlib.sha256()
    for key in sorted(panel, key=lambda item: str(item).encode("utf-8")):
        name = str(key)
        if name == "_meta":
            continue
        segment = _digest_segment(panel[key])
        encoded = name.encode("utf-8")
        digest.update(len(encoded).to_bytes(4, "big"))
        digest.update(encoded)
        digest.update(len(segment).to_bytes(8, "big"))
        digest.update(segment)
    return digest.hexdigest()


def _validate_alpha_id(alpha_id: object) -> str:
    if not isinstance(alpha_id, str):
        raise TypeError("alpha_id must be a string")
    if not alpha_id.strip():
        raise ValueError("alpha_id must be non-empty")
    if "/" in alpha_id or "\\" in alpha_id or alpha_id in (".", ".."):
        raise ValueError("alpha_id must not contain path separators")
    return alpha_id


def _validate_label(value: object, name: str) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{name} must be a string")
    if not value.strip():
        raise ValueError(f"{name} must be non-empty")
    return value


def _factor_values(factor: object) -> np.ndarray:
    if not isinstance(factor, pd.DataFrame):
        raise TypeError(f"factor must be a pandas DataFrame, got {type(factor).__name__}")
    if not isinstance(factor.index, pd.DatetimeIndex):
        raise TypeError("factor index must be a DatetimeIndex")
    if not factor.index.is_unique:
        raise ValueError("factor index must be unique")
    if not factor.index.is_monotonic_increasing:
        raise ValueError("factor index must be strictly increasing")
    if not factor.columns.is_unique:
        raise ValueError("factor columns must be unique")
    if any(not str(column).strip() for column in factor.columns):
        raise ValueError("factor column names must be non-empty")
    values = factor.to_numpy()
    if not np.issubdtype(values.dtype, np.number) or np.issubdtype(
        values.dtype, np.complexfloating
    ):
        raise TypeError(f"factor values must be real numeric, got {values.dtype}")
    return np.ascontiguousarray(values, dtype=np.float64)


def _write_bytes(path: Path, payload: bytes) -> None:
    with path.open("wb") as handle:
        handle.write(payload)


def write_panel(
    root: str | Path,
    factor: pd.DataFrame,
    *,
    alpha_id: str,
    universe: str,
    period: str,
    horizon: int = 1,
    data_source: str | None = None,
    panel_digest: str | None = None,
    overwrite: bool = False,
) -> Path:
    """Write one factor panel plus its manifest; return the payload path."""
    values = _factor_values(factor)
    alpha_id = _validate_alpha_id(alpha_id)
    universe = _validate_label(universe, "universe")
    period = _validate_label(period, "period")
    if isinstance(horizon, bool) or not isinstance(horizon, int) or horizon < 1:
        raise ValueError(f"horizon must be an integer >= 1, got {horizon!r}")
    if data_source is not None and not isinstance(data_source, str):
        raise TypeError("data_source must be a string or None")
    if panel_digest is not None and not isinstance(panel_digest, str):
        raise TypeError("panel_digest must be a string or None")
    if not isinstance(overwrite, bool):
        raise TypeError("overwrite must be a bool")

    root_path = Path(root)
    root_path.mkdir(parents=True, exist_ok=True)
    payload_path = root_path / f"{alpha_id}.npz"
    manifest_path = root_path / f"{alpha_id}.json"
    if not overwrite and (payload_path.exists() or manifest_path.exists()):
        raise FileExistsError(f"panel already exists: {payload_path}")

    index = factor.index.to_numpy(dtype="datetime64[ns]")
    columns = np.asarray([str(column) for column in factor.columns], dtype=np.str_)

    tmp_payload: Path | None = None
    tmp_manifest: Path | None = None
    try:
        fd, name = tempfile.mkstemp(prefix=f".{alpha_id}.", suffix=".tmp", dir=root_path)
        os.close(fd)
        tmp_payload = Path(name)
        with tmp_payload.open("wb") as handle:
            np.savez(
                handle,
                values=values,
                index=index,
                columns=columns,
                format_version=np.array(_FORMAT_VERSION, dtype=np.int64),
            )

        manifest = {
            "format_version": _FORMAT_VERSION,
            "alpha_id": alpha_id,
            "universe": universe,
            "period": period,
            "horizon": horizon,
            "data_source": data_source,
            "rows": int(values.shape[0]),
            "cols": int(values.shape[1]),
            "index_start": str(factor.index[0].date()) if len(factor.index) else "",
            "index_end": str(factor.index[-1].date()) if len(factor.index) else "",
            "non_null": {
                str(column): int((~np.isnan(values[:, position])).sum())
                for position, column in enumerate(factor.columns)
            },
            "panel_digest": panel_digest,
            "values_sha256": hashlib.sha256(values.tobytes(order="C")).hexdigest(),
            "payload_sha256": hashlib.sha256(tmp_payload.read_bytes()).hexdigest(),
        }
        fd, name = tempfile.mkstemp(prefix=f".{alpha_id}.", suffix=".tmp", dir=root_path)
        os.close(fd)
        tmp_manifest = Path(name)
        _write_bytes(
            tmp_manifest,
            json.dumps(
                manifest, sort_keys=True, separators=(",", ":"), ensure_ascii=False
            ).encode("utf-8")
            + b"\n",
        )

        os.replace(tmp_payload, payload_path)
        os.replace(tmp_manifest, manifest_path)
    finally:
        for staged in (tmp_payload, tmp_manifest):
            if staged is not None and staged.exists():
                staged.unlink()
    return payload_path


def _load_manifest(manifest_path: Path) -> dict:
    if not manifest_path.exists():
        raise FileNotFoundError(f"manifest not found: {manifest_path}")
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"manifest is not valid JSON: {exc}") from exc
    if not isinstance(manifest, dict):
        raise ValueError("manifest must be a JSON object")
    missing = [key for key in _MANIFEST_KEYS if key not in manifest]
    if missing:
        raise ValueError(f"manifest missing keys: {missing}")
    return manifest


def _iso_day(value: np.datetime64) -> str:
    return str(value.astype("datetime64[D]"))


def read_panel(path: str | Path) -> StoredPanel:
    """Load a stored panel, verifying the payload hash and every manifest field."""
    payload_path = Path(path)
    if not payload_path.exists():
        raise FileNotFoundError(f"payload not found: {payload_path}")
    manifest = _load_manifest(payload_path.with_suffix(".json"))

    if hashlib.sha256(payload_path.read_bytes()).hexdigest() != manifest["payload_sha256"]:
        raise ValueError(f"payload changed: {payload_path}")

    with np.load(payload_path, allow_pickle=False) as data:
        if set(data.files) != _PAYLOAD_KEYS:
            raise ValueError(f"payload keys must be {sorted(_PAYLOAD_KEYS)}, got {sorted(data.files)}")
        values = np.asarray(data["values"])
        index = np.asarray(data["index"])
        columns = np.asarray(data["columns"])
        version = int(np.asarray(data["format_version"]))

    if version != _FORMAT_VERSION:
        raise ValueError(f"unsupported format_version {version}")
    if values.ndim != 2 or values.dtype != np.float64:
        raise ValueError(f"values must be a 2-D float64 array, got {values.shape} {values.dtype}")
    if index.ndim != 1 or not np.issubdtype(index.dtype, np.datetime64):
        raise ValueError("index must be a 1-D datetime64 array")
    if index.size != values.shape[0]:
        raise ValueError("index length disagrees with values rows")
    if index.size > 1 and not (index[1:] > index[:-1]).all():
        raise ValueError("index must be strictly increasing")
    if columns.ndim != 1 or columns.size != values.shape[1]:
        raise ValueError("columns length disagrees with values cols")

    if int(manifest["rows"]) != values.shape[0] or int(manifest["cols"]) != values.shape[1]:
        raise ValueError("manifest rows/cols disagree with payload")
    index_start = _iso_day(index[0]) if index.size else ""
    index_end = _iso_day(index[-1]) if index.size else ""
    if manifest["index_start"] != index_start or manifest["index_end"] != index_end:
        raise ValueError("manifest index range disagrees with payload")
    non_null = {
        str(column): int((~np.isnan(values[:, position])).sum())
        for position, column in enumerate(columns)
    }
    if manifest["non_null"] != non_null:
        raise ValueError("manifest non_null disagrees with payload")

    factor = pd.DataFrame(
        values.copy(),
        index=pd.DatetimeIndex(index),
        columns=pd.Index([str(column) for column in columns], dtype=object),
    )
    return StoredPanel(factor=factor, manifest=manifest)


def list_panels(root: str | Path) -> pd.DataFrame:
    """Manifest-only index of stored panels, sorted by ``alpha_id``."""
    root_path = Path(root)
    rows: list[dict] = []
    for manifest_path in sorted(root_path.glob("*.json")):
        manifest = _load_manifest(manifest_path)
        non_null = manifest["non_null"]
        if not isinstance(non_null, dict):
            raise ValueError(f"manifest non_null must be an object: {manifest_path}")
        rows.append(
            {
                "alpha_id": manifest["alpha_id"],
                "universe": manifest["universe"],
                "period": manifest["period"],
                "horizon": manifest["horizon"],
                "data_source": manifest["data_source"],
                "rows": manifest["rows"],
                "cols": manifest["cols"],
                "non_null_total": int(sum(int(count) for count in non_null.values())),
                "panel_digest": manifest["panel_digest"],
                "values_sha256": manifest["values_sha256"],
                "path": str(manifest_path.resolve()),
            }
        )
    table = pd.DataFrame(rows, columns=_LIST_COLUMNS)
    return table.sort_values("alpha_id", kind="mergesort").reset_index(drop=True)


def verify_panel(path: str | Path) -> dict:
    """Non-raising wrapper around :func:`read_panel` for batch audits."""
    try:
        read_panel(path)
    except Exception as exc:  # noqa: BLE001 — the report is the product
        return {"ok": False, "reason": f"{type(exc).__name__}: {exc}"}
    return {"ok": True, "reason": None}
