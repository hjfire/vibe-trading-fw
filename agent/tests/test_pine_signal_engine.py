"""Track B2b — the lookup SignalEngine contract the production backtest relies on.

The bridge hands the ordinary pipeline a `Dict[str, pd.Series]` built from the
TS engine's exported artifact. These tests pin the two things that can silently
go wrong in a bridge:

* the returned series share the loader's *own* index (so `_align`'s reindex is a
  no-op and nothing quietly turns to NaN/flat), and
* the held->decision forward-shift composes with `_align`'s shift(1) so the
  backtest holds the *same bars* the front-end simulator held — verified by
  running the real `_align`, not a re-derivation.

Daily and intraday (exchange wall-clock) indices are each exercised, because the
timestamp reconstruction differs between them.
"""

import importlib.util
import json
from pathlib import Path

import numpy as np
import pandas as pd
import pytest

from backtest.engines.base import _align

ENGINE_PATH = (
    Path(__file__).resolve().parents[1]
    / "src" / "skills" / "pine-signal" / "example_signal_engine.py"
)


def _load_engine():
    spec = importlib.util.spec_from_file_location("pine_signal_engine", ENGINE_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def _daily_index(periods=6, start="2024-01-02"):
    return pd.DatetimeIndex(pd.date_range(start, periods=periods, freq="B"), name="trade_date")


def _frame(index, price=100.0):
    n = len(index)
    return pd.DataFrame(
        {
            "open": [price] * n,
            "high": [price] * n,
            "low": [price] * n,
            "close": [price] * n,
            "volume": [1000.0] * n,
        },
        index=index,
    )


def _daily_ms(index):
    # market_routes daily convention: naive trading-day read as UTC -> epoch ms.
    return [int(ts.value // 1_000_000) for ts in index]


def _zone_ms(index, zone):
    # market_routes intraday convention: naive wall clock localized to the
    # exchange zone, then taken as a real instant.
    return [int(ts.tz_localize(zone).value // 1_000_000) for ts in index]


def _write_artifact(sig_dir: Path, code, *, timestamps, signals, interval="1D", zone=None, schema=1):
    payload = {
        "schema": schema,
        "engine": "pine-ts",
        "symbol": code,
        "interval": interval,
        "wallClockZone": zone,
        "timestamps": timestamps,
        "signals": signals,
        "meta": {"scriptKind": "strategy", "title": "t", "bars": len(signals), "notes": [], "generatedAt": ""},
    }
    (sig_dir / f"{code}.json").write_text(json.dumps(payload), encoding="utf-8")


HELD = [0.0, 0.0, 1.0, 1.0, 1.0, 0.0]  # long through bars 2,3,4


@pytest.mark.unit
def test_generate_returns_contract_and_index(tmp_path):
    module = _load_engine()
    module.SIGNAL_DIR = str(tmp_path)
    index = _daily_index()
    _write_artifact(tmp_path, "700.HK", timestamps=_daily_ms(index), signals=HELD)

    out = module.SignalEngine().generate({"700.HK": _frame(index)})

    assert set(out) == {"700.HK"}
    series = out["700.HK"]
    assert isinstance(series, pd.Series)
    # Same index object semantics: no NaN introduced by a reindex downstream.
    assert series.index.equals(index)
    assert series.notna().all()
    assert ((series >= -1.0) & (series <= 1.0)).all()


@pytest.mark.unit
def test_daily_held_reproduces_backend_positions(tmp_path):
    module = _load_engine()
    module.SIGNAL_DIR = str(tmp_path)
    index = _daily_index()
    _write_artifact(tmp_path, "700.HK", timestamps=_daily_ms(index), signals=HELD)

    data_map = {"700.HK": _frame(index)}
    signal_map = module.SignalEngine().generate(data_map)
    _dates, _close, _close_val, target_pos, _ret = _align(data_map, signal_map, ["700.HK"])

    # After the engine's shift(1), the backtest holds exactly the bars the front
    # end held: the forward-shift in the bridge and the shift(1) in _align cancel.
    np.testing.assert_allclose(target_pos["700.HK"].to_numpy(), HELD, atol=1e-12)


@pytest.mark.unit
def test_intraday_wall_clock_index_reconstructs(tmp_path):
    module = _load_engine()
    module.SIGNAL_DIR = str(tmp_path)
    # A short intraday session on HK wall clock (the loader index is naive).
    index = pd.DatetimeIndex(
        pd.to_datetime(
            ["2024-01-02 09:30", "2024-01-02 09:31", "2024-01-02 09:32",
             "2024-01-02 09:33", "2024-01-02 09:34", "2024-01-02 09:35"]
        ),
        name="trade_date",
    )
    zone = "Asia/Shanghai"
    _write_artifact(
        tmp_path, "700.HK",
        timestamps=_zone_ms(index, zone), signals=HELD, interval="1m", zone=zone,
    )

    data_map = {"700.HK": _frame(index)}
    signal_map = module.SignalEngine().generate(data_map)
    assert signal_map["700.HK"].index.equals(index)
    _dates, _close, _close_val, target_pos, _ret = _align(data_map, signal_map, ["700.HK"])
    np.testing.assert_allclose(target_pos["700.HK"].to_numpy(), HELD, atol=1e-12)


@pytest.mark.unit
def test_missing_artifact_raises(tmp_path):
    module = _load_engine()
    module.SIGNAL_DIR = str(tmp_path)
    index = _daily_index()
    with pytest.raises(FileNotFoundError):
        module.SignalEngine().generate({"700.HK": _frame(index)})


@pytest.mark.unit
def test_schema_mismatch_raises(tmp_path):
    module = _load_engine()
    module.SIGNAL_DIR = str(tmp_path)
    index = _daily_index()
    _write_artifact(tmp_path, "700.HK", timestamps=_daily_ms(index), signals=HELD, schema=99)
    with pytest.raises(ValueError, match="schema"):
        module.SignalEngine().generate({"700.HK": _frame(index)})


@pytest.mark.unit
def test_calendar_mismatch_raises(tmp_path):
    module = _load_engine()
    module.SIGNAL_DIR = str(tmp_path)
    index = _daily_index()
    # Artifact timestamps a full month ahead of the loader bars: no overlap.
    ahead = _daily_index(start="2024-03-01")
    _write_artifact(tmp_path, "700.HK", timestamps=_daily_ms(ahead), signals=HELD)
    with pytest.raises(ValueError, match="do not overlap"):
        module.SignalEngine().generate({"700.HK": _frame(index)})
