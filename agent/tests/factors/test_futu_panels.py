"""FutuOpenD daily panels for the chip and limit-pool engines.

Hand vectors and the frozen contract live in
``superpowers/specs/2026-10-29-futu-real-data-chain-design.md`` sections 5-9.
``futu-api`` is not installed in CI, so every fetch test stubs ``sys.modules``
and replaces ``futu_gateway.open_context`` with a fake context.
"""

from __future__ import annotations

import sys
import types
from datetime import date
from unittest.mock import MagicMock, call

import numpy as np
import pandas as pd
import pytest

from backtest.loaders import futu_gateway
from src.config.accessor import reset_env_config
from src.factors.futu_panels import (
    FutuPanels,
    FutuPanelsError,
    fetch_daily_panels,
    is_st_name,
    normalize_daily_panels,
)

# ── helpers ──────────────────────────────────────────────────────────────


def _raw(dates, *, close, last_close, turnover, name="平安银行", high=None, low=None):
    n = len(dates)
    return pd.DataFrame({
        "time_key": dates,
        "name": [name] * n,
        "high": high if high is not None else close,
        "low": low if low is not None else close,
        "close": close,
        "last_close": last_close,
        "turnover_rate": turnover,
    })


class _KLType:
    K_DAY = "K_DAY"


class _KLField:
    ALL = "ALL"


class _AuType:
    NONE = "NONE"
    QFQ = "QFQ"


def _stub_futu(monkeypatch):
    stub = types.SimpleNamespace(
        RET_OK=0, KLType=_KLType, KL_FIELD=_KLField, AuType=_AuType
    )
    monkeypatch.setitem(sys.modules, "futu", stub)


def _ok_ctx(frame):
    ctx = MagicMock()
    ctx.request_history_kline.return_value = (0, frame, None)
    return ctx


@pytest.fixture(autouse=True)
def _gateway_env(monkeypatch):
    """Pin the gateway target and clear cooldown/probe state per test."""
    monkeypatch.setenv("FUTU_HOST", "127.0.0.1")
    monkeypatch.setenv("FUTU_PORT", "11111")
    reset_env_config()
    futu_gateway.reset_state()
    yield
    futu_gateway.reset_state()
    reset_env_config()


# ── normalize: hand vectors A-F ──────────────────────────────────────────


def test_turnover_fraction_is_converted_to_percent():
    out = normalize_daily_panels(
        {"000001.SZ": _raw(["2026-10-28"], close=[11.31], last_close=[11.47], turnover=[0.00869])},
        today=date(2026, 10, 29),
    )
    assert out.turnover_rate_pct.iloc[0, 0] == pytest.approx(0.869)
    assert out.turnover_rate_pct.iloc[0, 0] == pytest.approx(0.00869 * 100.0)


def test_today_and_future_bars_are_dropped():
    frame = _raw(
        ["2026-10-28", "2026-10-29", "2026-10-30"],
        close=[1.0, 2.0, 3.0],
        last_close=[1.0, 1.0, 2.0],
        turnover=[0.01, 0.02, 0.03],
    )
    out = normalize_daily_panels({"000001.SZ": frame}, today=date(2026, 10, 29))
    assert list(out.close.index) == [pd.Timestamp("2026-10-28")]
    assert out.as_of == date(2026, 10, 29)


def test_last_close_is_prev_close_not_shifted_close():
    frame = _raw(
        ["2026-10-27", "2026-10-28"],
        close=[11.31, 11.42],
        last_close=[11.47, 11.31],
        turnover=[0.01, 0.02],
    )
    out = normalize_daily_panels({"000001.SZ": frame}, today=date(2026, 10, 29))
    assert list(out.prev_close["000001.SZ"]) == [11.47, 11.31]


def test_union_alignment_fills_missing_cells_with_nan():
    a = _raw(
        ["2026-10-27", "2026-10-28"],
        close=[10.0, 11.0],
        last_close=[9.0, 10.0],
        turnover=[0.01, 0.02],
    )
    b = _raw(
        ["2026-10-28", "2026-10-29"],
        close=[20.0, 21.0],
        last_close=[19.0, 20.0],
        turnover=[0.03, 0.04],
        name="ST测试",
    )
    out = normalize_daily_panels(
        {"000001.SZ": a, "600000.SH": b}, today=date(2026, 10, 31)
    )
    assert list(out.high.index) == [
        pd.Timestamp(d) for d in ("2026-10-27", "2026-10-28", "2026-10-29")
    ]
    assert list(out.high.columns) == ["000001.SZ", "600000.SH"]
    assert np.isnan(out.high.loc["2026-10-29", "000001.SZ"])
    assert np.isnan(out.high.loc["2026-10-27", "600000.SH"])
    assert out.is_st.loc["2026-10-27", "600000.SH"] == True  # noqa: E712
    assert out.is_st.loc["2026-10-27", "000001.SZ"] == False  # noqa: E712
    assert out.names == {"000001.SZ": "平安银行", "600000.SH": "ST测试"}


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("ST平安", True),
        ("*ST海航", True),
        ("S*ST长油", True),
        ("SST华塑", True),
        ("平安银行", False),
        (" st 平安 ", True),
        ("", False),
    ],
)
def test_is_st_name(name, expected):
    assert is_st_name(name) is expected


def test_duplicate_timestamps_keep_last():
    frame = _raw(
        ["2026-10-28", "2026-10-28"],
        close=[1.0, 2.0],
        last_close=[1.0, 1.0],
        turnover=[0.01, 0.02],
    )
    out = normalize_daily_panels({"000001.SZ": frame}, today=date(2026, 10, 29))
    assert len(out.close) == 1
    assert out.close.iloc[0, 0] == 2.0


# ── normalize: contract pins ─────────────────────────────────────────────


def test_all_output_frames_share_one_index_and_columns():
    frame = _raw(
        ["2026-10-27", "2026-10-28"],
        close=[10.0, 11.0],
        last_close=[9.0, 10.0],
        turnover=[0.01, 0.02],
    )
    out = normalize_daily_panels({"000001.SZ": frame}, today=date(2026, 10, 29))
    frames = [out.high, out.low, out.close, out.prev_close, out.turnover_rate_pct, out.is_st]
    for frame_out in frames[1:]:
        assert frame_out.index.equals(frames[0].index)
        assert frame_out.columns.equals(frames[0].columns)
    assert frames[0].index.name == "trade_date"
    assert frames[0].index.is_monotonic_increasing
    assert frames[0].index.is_unique


def test_every_row_is_strictly_before_as_of():
    frame = _raw(
        ["2026-10-26", "2026-10-27", "2026-10-28"],
        close=[1.0, 2.0, 3.0],
        last_close=[1.0, 1.0, 2.0],
        turnover=[0.01, 0.02, 0.03],
    )
    out = normalize_daily_panels({"000001.SZ": frame}, today=date(2026, 10, 28))
    assert len(out.close) == 2
    assert all(ts.date() < out.as_of for ts in out.close.index)


def test_empty_mapping_returns_empty_aligned_frames():
    out = normalize_daily_panels({}, today=date(2026, 10, 29))
    assert isinstance(out, FutuPanels)
    for frame in (out.high, out.low, out.close, out.prev_close, out.turnover_rate_pct):
        assert frame.empty
        assert frame.index.empty
        assert list(frame.columns) == []
    assert out.is_st.empty
    assert list(out.is_st.columns) == []
    assert out.names == {}
    assert out.failures == {}
    assert out.as_of == date(2026, 10, 29)


def test_frame_with_only_as_of_rows_produces_no_column():
    frame = _raw(["2026-10-29"], close=[1.0], last_close=[1.0], turnover=[0.01])
    out = normalize_daily_panels({"000001.SZ": frame}, today=date(2026, 10, 29))
    assert list(out.close.columns) == []
    assert out.names == {}


def test_missing_required_column_raises():
    frame = _raw(
        ["2026-10-28"], close=[1.0], last_close=[1.0], turnover=[0.01]
    ).drop(columns="turnover_rate")
    with pytest.raises(ValueError, match="turnover_rate"):
        normalize_daily_panels({"000001.SZ": frame}, today=date(2026, 10, 29))


def test_non_a_share_code_is_rejected():
    frame = _raw(["2026-10-28"], close=[1.0], last_close=[1.0], turnover=[0.01])
    with pytest.raises(ValueError, match="A-share"):
        normalize_daily_panels({"700.HK": frame}, today=date(2026, 10, 29))


def test_input_frames_are_not_modified():
    frame = _raw(["2026-10-28"], close=[1.0], last_close=[1.0], turnover=[0.01])
    before = frame.copy(deep=True)
    normalize_daily_panels({"000001.SZ": frame}, today=date(2026, 10, 29))
    pd.testing.assert_frame_equal(frame, before)


def test_prefix_panels_equal_full_panels_on_overlap():
    days = ["2026-10-20", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-26"]
    full = _raw(
        days,
        close=[10.0, 11.0, 12.0, 13.0, 14.0],
        last_close=[9.0, 10.0, 11.0, 12.0, 13.0],
        turnover=[0.01, 0.02, 0.03, 0.04, 0.05],
    )
    out_full = normalize_daily_panels({"000001.SZ": full}, today=date(2026, 10, 27))
    out_prefix = normalize_daily_panels(
        {"000001.SZ": full.iloc[:3]}, today=date(2026, 10, 27)
    )
    for name in ("high", "low", "close", "prev_close", "turnover_rate_pct"):
        pd.testing.assert_frame_equal(
            getattr(out_full, name).iloc[:3], getattr(out_prefix, name)
        )


def test_as_of_boundary_changes_only_the_cutoff_row():
    frame = _raw(
        ["2026-10-26", "2026-10-27", "2026-10-28"],
        close=[1.0, 2.0, 3.0],
        last_close=[1.0, 1.0, 2.0],
        turnover=[0.01, 0.02, 0.03],
    )
    before = normalize_daily_panels({"000001.SZ": frame}, today=date(2026, 10, 28))
    after = normalize_daily_panels({"000001.SZ": frame}, today=date(2026, 10, 29))
    assert list(before.close.index) == [pd.Timestamp("2026-10-26"), pd.Timestamp("2026-10-27")]
    assert list(after.close.index) == [
        pd.Timestamp("2026-10-26"),
        pd.Timestamp("2026-10-27"),
        pd.Timestamp("2026-10-28"),
    ]
    pd.testing.assert_frame_equal(after.close.iloc[:2], before.close)


# ── fetch: request contract ──────────────────────────────────────────────


def test_fetch_requests_unadjusted_all_fields(monkeypatch):
    _stub_futu(monkeypatch)
    frame = _raw(["2026-10-28"], close=[11.31], last_close=[11.47], turnover=[0.00869])
    ctx = _ok_ctx(frame)
    monkeypatch.setattr(futu_gateway, "open_context", lambda *a, **k: ctx)
    out = fetch_daily_panels(
        ["000001.SZ"], "2026-10-20", "2026-10-28", today=date(2026, 10, 29)
    )
    args, kwargs = ctx.request_history_kline.call_args
    assert args[0] == "SZ.000001"
    assert kwargs["start"] == "2026-10-20"
    assert kwargs["end"] == "2026-10-28"
    assert kwargs["autype"] == _AuType.NONE
    assert kwargs["fields"] == [_KLField.ALL]
    assert kwargs["ktype"] == _KLType.K_DAY
    assert kwargs["page_req_key"] is None
    assert out.close.iloc[0, 0] == 11.31
    assert out.as_of == date(2026, 10, 29)
    ctx.close.assert_called_once()


def test_fetch_paginates_and_keeps_last_duplicate(monkeypatch):
    _stub_futu(monkeypatch)
    ctx = MagicMock()
    first = _raw(
        ["2026-10-27", "2026-10-28"],
        close=[1.0, 2.0],
        last_close=[1.0, 1.0],
        turnover=[0.01, 0.02],
    )
    second = _raw(["2026-10-28"], close=[9.0], last_close=[1.0], turnover=[0.03])
    ctx.request_history_kline.side_effect = [(0, first, b"p1"), (0, second, None)]
    monkeypatch.setattr(futu_gateway, "open_context", lambda *a, **k: ctx)
    out = fetch_daily_panels(
        ["000001.SZ"], "2026-10-20", "2026-10-29", today=date(2026, 10, 30)
    )
    assert len(out.close) == 2
    assert out.close.loc["2026-10-28", "000001.SZ"] == 9.0
    assert ctx.request_history_kline.call_args_list[0].kwargs["page_req_key"] is None
    assert ctx.request_history_kline.call_args_list[1].kwargs["page_req_key"] == b"p1"


# ── fetch: failure contract ──────────────────────────────────────────────


def test_fetch_records_symbol_failure_and_keeps_others(monkeypatch):
    _stub_futu(monkeypatch)
    ctx = MagicMock()
    ok = _raw(["2026-10-28"], close=[11.31], last_close=[11.47], turnover=[0.00869])
    ctx.request_history_kline.side_effect = [(0, ok, None), (1, "未知股票", None)]
    monkeypatch.setattr(futu_gateway, "open_context", lambda *a, **k: ctx)
    out = fetch_daily_panels(
        ["000001.SZ", "000004.SZ"], "2026-10-01", "2026-10-28", today=date(2026, 10, 29)
    )
    assert list(out.close.columns) == ["000001.SZ"]
    assert "未知股票" in out.failures["000004.SZ"]


def test_fetch_all_failed_raises_without_cooldown(monkeypatch):
    _stub_futu(monkeypatch)
    ctx = MagicMock()
    ctx.request_history_kline.return_value = (1, "denied", None)
    monkeypatch.setattr(futu_gateway, "open_context", lambda *a, **k: ctx)
    with pytest.raises(FutuPanelsError, match="denied"):
        fetch_daily_panels(
            ["000001.SZ"], "2026-10-01", "2026-10-28", today=date(2026, 10, 29)
        )
    assert futu_gateway.in_cooldown("127.0.0.1", 11111) is False
    ctx.close.assert_called_once()


def test_fetch_connect_failure_raises_and_latches_cooldown(monkeypatch):
    _stub_futu(monkeypatch)

    def _boom(*a, **k):
        raise OSError("refused")

    monkeypatch.setattr(futu_gateway, "open_context", _boom)
    with pytest.raises(FutuPanelsError, match="FutuOpenD"):
        fetch_daily_panels(
            ["000001.SZ"], "2026-10-01", "2026-10-28", today=date(2026, 10, 29)
        )
    assert futu_gateway.in_cooldown("127.0.0.1", 11111) is True


def test_fetch_rejects_non_a_share_before_connecting(monkeypatch):
    _stub_futu(monkeypatch)
    ctx = MagicMock()
    monkeypatch.setattr(futu_gateway, "open_context", lambda *a, **k: ctx)
    with pytest.raises(ValueError, match="A-share"):
        fetch_daily_panels(["700.HK"], "2026-10-01", "2026-10-28")
    ctx.request_history_kline.assert_not_called()


def test_fetch_repeated_page_key_is_a_failure(monkeypatch):
    _stub_futu(monkeypatch)
    ctx = MagicMock()
    ctx.request_history_kline.return_value = (
        0,
        _raw(["2026-10-28"], close=[1.0], last_close=[1.0], turnover=[0.01]),
        b"same",
    )
    monkeypatch.setattr(futu_gateway, "open_context", lambda *a, **k: ctx)
    with pytest.raises(FutuPanelsError, match="pagination"):
        fetch_daily_panels(
            ["000001.SZ"], "2026-10-01", "2026-10-28",
            today=date(2026, 10, 29), max_pages=5,
        )


def test_fetch_empty_codes_raises():
    with pytest.raises(ValueError, match="non-empty"):
        fetch_daily_panels([], "2026-10-01", "2026-10-28")


def test_fetch_success_calls_note_success(monkeypatch):
    _stub_futu(monkeypatch)
    frame = _raw(["2026-10-28"], close=[11.31], last_close=[11.47], turnover=[0.00869])
    ctx = _ok_ctx(frame)
    monkeypatch.setattr(futu_gateway, "open_context", lambda *a, **k: ctx)
    success = MagicMock(wraps=futu_gateway.note_success)
    monkeypatch.setattr(futu_gateway, "note_success", success)
    fetch_daily_panels(
        ["000001.SZ"], "2026-10-01", "2026-10-28", today=date(2026, 10, 29)
    )
    assert success.call_args == call("127.0.0.1", 11111)


def test_fetch_all_failed_does_not_call_note_success(monkeypatch):
    _stub_futu(monkeypatch)
    ctx = MagicMock()
    ctx.request_history_kline.return_value = (1, "denied", None)
    monkeypatch.setattr(futu_gateway, "open_context", lambda *a, **k: ctx)
    success = MagicMock(wraps=futu_gateway.note_success)
    monkeypatch.setattr(futu_gateway, "note_success", success)
    with pytest.raises(FutuPanelsError):
        fetch_daily_panels(
            ["000001.SZ"], "2026-10-01", "2026-10-28", today=date(2026, 10, 29)
        )
    success.assert_not_called()
