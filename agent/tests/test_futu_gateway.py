"""Tests for the FutuOpenD gateway layer: cooldown, pacing, snapshot mapping.

``futu-api`` is not installed in CI, so every test injects a stub module into
``sys.modules`` (the same pattern ``test_futu_loader_interval_case.py`` uses).
Nothing here touches a real OpenD.

The behavior these lock down is the reason the gateway exists: an operator who
has not started FutuOpenD must degrade to the public sources after *one* failed
connect, not one per symbol — and a gateway that merely rejects a bad batch
must not be mistaken for a dead one.
"""

from __future__ import annotations

import sys
from unittest.mock import MagicMock

import pandas as pd
import pytest


@pytest.fixture()
def stub_futu(monkeypatch):
    """Install a fake ``futu`` module and keep cooldown state isolated."""
    from backtest.loaders import futu_gateway

    stub = MagicMock()
    stub.RET_OK = 0
    monkeypatch.setitem(sys.modules, "futu", stub)
    futu_gateway.reset_state()
    yield stub
    futu_gateway.reset_state()


@pytest.fixture()
def gateway(monkeypatch):
    """The gateway module pointed at a fixed host/port, with no sleeps.

    Resets the module state on both sides: the cooldown latch and the probe
    trust window are process-global, so without this a passing probe in one
    test answers for the next one and the failure under test never happens.
    """
    from backtest.loaders import futu_gateway
    from src.config.accessor import reset_env_config

    monkeypatch.setenv("FUTU_HOST", "127.0.0.1")
    monkeypatch.setenv("FUTU_PORT", "11111")
    reset_env_config()
    futu_gateway.reset_state()
    # Pacing must not actually block a test run.
    monkeypatch.setattr(futu_gateway.time, "sleep", lambda _s: None)
    yield futu_gateway
    futu_gateway.reset_state()
    reset_env_config()


class TestCooldown:
    def test_clean_by_default(self, gateway):
        assert gateway.in_cooldown("127.0.0.1", 11111) is False
        assert gateway.cooldown_remaining("127.0.0.1", 11111) == 0.0

    def test_failure_latches(self, gateway):
        gateway.note_failure("127.0.0.1", 11111, reason="test")
        assert gateway.in_cooldown("127.0.0.1", 11111) is True
        assert gateway.cooldown_remaining("127.0.0.1", 11111) > 0.0

    def test_success_clears_latch(self, gateway):
        gateway.note_failure("127.0.0.1", 11111)
        gateway.note_success("127.0.0.1", 11111)
        assert gateway.in_cooldown("127.0.0.1", 11111) is False

    def test_latch_expires(self, gateway, monkeypatch):
        gateway.note_failure("127.0.0.1", 11111)
        # Jump the monotonic clock past the window instead of sleeping in a test.
        # The original must be captured first: calling gateway.time.monotonic()
        # from inside the replacement would recurse into itself.
        real_monotonic = gateway.time.monotonic
        monkeypatch.setattr(
            gateway.time, "monotonic", lambda: real_monotonic() + gateway.COOLDOWN_S + 1
        )
        assert gateway.in_cooldown("127.0.0.1", 11111) is False

    def test_latch_is_per_target(self, gateway):
        """A dead local gateway must not mark a healthy remote one down."""
        gateway.note_failure("127.0.0.1", 11111)
        assert gateway.in_cooldown("10.0.0.9", 11111) is False

    def test_reset_state_clears_all(self, gateway):
        gateway.note_failure("127.0.0.1", 11111)
        gateway.note_failure("10.0.0.9", 22222)
        gateway.reset_state()
        assert gateway.in_cooldown("127.0.0.1", 11111) is False
        assert gateway.in_cooldown("10.0.0.9", 22222) is False


class TestProbe:
    """The cheap "is it worth routing through OpenD?" answer.

    Nothing here opens a socket: the SDK connect costs about a second and this
    is consulted once per symbol group, so the tests drive
    ``socket.create_connection`` directly.
    """

    def test_unconfigured_answers_false_without_a_socket(self, monkeypatch):
        from backtest.loaders import futu_gateway
        from src.config.accessor import reset_env_config

        monkeypatch.setenv("FUTU_HOST", "")
        monkeypatch.setenv("FUTU_PORT", "0")
        reset_env_config()
        called = []
        monkeypatch.setattr(
            futu_gateway.socket, "create_connection",
            lambda *a, **k: called.append(a),
        )
        assert futu_gateway.probe() is False
        assert called == []
        # "Not configured" is not evidence of a dead gateway: no latch, so a
        # later configuration is used immediately.
        assert futu_gateway.in_cooldown("", 0) is False
        reset_env_config()

    def test_accepting_port_answers_true(self, gateway, monkeypatch):
        class _Conn:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        monkeypatch.setattr(
            gateway.socket, "create_connection", lambda *a, **k: _Conn()
        )
        assert gateway.probe() is True
        assert gateway.in_cooldown("127.0.0.1", 11111) is False

    def test_refused_port_latches_the_cooldown(self, gateway, monkeypatch):
        def _refused(*_a, **_k):
            raise ConnectionRefusedError("no gateway")

        monkeypatch.setattr(gateway.socket, "create_connection", _refused)
        assert gateway.probe() is False
        assert gateway.in_cooldown("127.0.0.1", 11111) is True

    def test_cooldown_skips_the_socket(self, gateway, monkeypatch):
        gateway.note_failure("127.0.0.1", 11111)
        monkeypatch.setattr(
            gateway.socket, "create_connection",
            lambda *a, **k: pytest.fail("must not probe a latched gateway"),
        )
        assert gateway.probe() is False

    def test_success_is_trusted_for_a_window(self, gateway, monkeypatch):
        """One request spans several symbol groups; it must not re-probe each."""
        calls = []

        class _Conn:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        def _spy(*_a, **_k):
            calls.append(1)
            return _Conn()

        monkeypatch.setattr(gateway.socket, "create_connection", _spy)
        assert gateway.probe() is True
        assert gateway.probe() is True
        assert len(calls) == 1

    def test_reset_clears_the_trust_window(self, gateway, monkeypatch):
        class _Conn:
            def __enter__(self):
                return self

            def __exit__(self, *exc):
                return False

        calls = []

        def _spy(*_a, **_k):
            calls.append(1)
            return _Conn()

        monkeypatch.setattr(gateway.socket, "create_connection", _spy)
        assert gateway.probe() is True
        gateway.reset_state()
        assert gateway.probe() is True
        assert len(calls) == 2


class TestFetchSnapshots:
    def test_empty_codes_short_circuits(self, gateway, stub_futu):
        assert gateway.fetch_snapshots([]) == {}
        stub_futu.OpenQuoteContext.assert_not_called()

    def test_cooldown_skips_construction_entirely(self, gateway, stub_futu):
        """The point of the latch: no SDK object is built while it is down."""
        gateway.note_failure("127.0.0.1", 11111)
        assert gateway.fetch_snapshots(["HK.00700"]) == {}
        stub_futu.OpenQuoteContext.assert_not_called()

    def test_connect_failure_latches(self, gateway, stub_futu):
        stub_futu.OpenQuoteContext.side_effect = OSError("connection refused")
        assert gateway.fetch_snapshots(["HK.00700"]) == {}
        assert gateway.in_cooldown("127.0.0.1", 11111) is True

    def test_batch_refusal_does_not_latch(self, gateway, stub_futu):
        """A rejected batch means bad codes or missing entitlements.

        The gateway itself answered, so latching it down for 90s would take a
        healthy gateway away from every *other* symbol in the run.
        """
        ctx = MagicMock()
        ctx.get_market_snapshot.return_value = (1, "invalid code")
        stub_futu.OpenQuoteContext.return_value = ctx
        assert gateway.fetch_snapshots(["HK.99999"]) == {}
        assert gateway.in_cooldown("127.0.0.1", 11111) is False

    def test_success_clears_a_previous_latch(self, gateway, stub_futu):
        ctx = MagicMock()
        ctx.get_market_snapshot.return_value = (
            0,
            pd.DataFrame([{"code": "HK.00700", "last_price": 442.8, "prev_close_price": 433.0}]),
        )
        stub_futu.OpenQuoteContext.return_value = ctx
        gateway.note_failure("127.0.0.1", 11111)
        # Cooldown is checked before connecting, so clear it the way a
        # successful loader call would, then confirm a good batch keeps it clear.
        gateway.note_success("127.0.0.1", 11111)
        out = gateway.fetch_snapshots(["HK.00700"])
        assert out["HK.00700"]["last"] == 442.8
        assert gateway.in_cooldown("127.0.0.1", 11111) is False

    def test_transport_error_latches_and_closes(self, gateway, stub_futu):
        ctx = MagicMock()
        ctx.get_market_snapshot.side_effect = OSError("socket dropped")
        stub_futu.OpenQuoteContext.return_value = ctx
        assert gateway.fetch_snapshots(["HK.00700"]) == {}
        ctx.close.assert_called_once()
        assert gateway.in_cooldown("127.0.0.1", 11111) is True

    def test_local_bug_does_not_latch_the_gateway(self, gateway, stub_futu):
        """A processing error is evidence about our code, not the gateway.

        Taking a healthy OpenD out of every fallback chain for 90s because a
        caller mis-handled a response would be worse than the original fault.
        """
        ctx = MagicMock()
        ctx.get_market_snapshot.side_effect = ValueError("too many values to unpack")
        stub_futu.OpenQuoteContext.return_value = ctx
        assert gateway.fetch_snapshots(["HK.00700"]) == {}
        ctx.close.assert_called_once()
        assert gateway.in_cooldown("127.0.0.1", 11111) is False

    def test_close_failure_does_not_lose_results(self, gateway, stub_futu):
        ctx = MagicMock()
        ctx.get_market_snapshot.return_value = (
            0,
            pd.DataFrame([{"code": "HK.00700", "last_price": 442.8, "prev_close_price": 433.0}]),
        )
        ctx.close.side_effect = RuntimeError("already gone")
        stub_futu.OpenQuoteContext.return_value = ctx
        out = gateway.fetch_snapshots(["HK.00700"])
        assert out["HK.00700"]["last"] == 442.8

    def test_rows_without_last_price_are_dropped(self, gateway, stub_futu):
        ctx = MagicMock()
        ctx.get_market_snapshot.return_value = (
            0,
            pd.DataFrame([
                {"code": "HK.00700", "last_price": None, "prev_close_price": 433.0},
                {"code": "HK.00005", "last_price": 71.0, "prev_close_price": 70.0},
            ]),
        )
        stub_futu.OpenQuoteContext.return_value = ctx
        out = gateway.fetch_snapshots(["HK.00700", "HK.00005"])
        assert list(out) == ["HK.00005"]

    def test_duplicate_codes_are_requested_once(self, gateway, stub_futu):
        ctx = MagicMock()
        ctx.get_market_snapshot.return_value = (0, pd.DataFrame())
        stub_futu.OpenQuoteContext.return_value = ctx
        gateway.fetch_snapshots(["HK.00700", "HK.00700", "HK.00005"])
        asked = ctx.get_market_snapshot.call_args.args[0]
        assert asked == ["HK.00700", "HK.00005"]


class TestLoaderIntegration:
    """The cooldown must be visible through the loader, not just the gateway."""

    @pytest.fixture()
    def loader(self, monkeypatch):
        from src.config.accessor import reset_env_config

        monkeypatch.setenv("FUTU_HOST", "127.0.0.1")
        monkeypatch.setenv("FUTU_PORT", "11111")
        reset_env_config()
        from backtest.loaders.futu import FutuLoader

        yield FutuLoader()
        reset_env_config()

    def test_is_available_false_in_cooldown_without_sdk(self, loader, gateway, stub_futu):
        gateway.note_failure("127.0.0.1", 11111)
        assert loader.is_available() is False
        stub_futu.OpenQuoteContext.assert_not_called()

    def test_fetch_raises_in_cooldown(self, loader, gateway, stub_futu):
        from backtest.loaders.base import NoAvailableSourceError

        gateway.note_failure("127.0.0.1", 11111)
        with pytest.raises(NoAvailableSourceError, match="marked unavailable"):
            loader.fetch(["700.HK"], "2024-01-01", "2024-01-31")
        stub_futu.OpenQuoteContext.assert_not_called()

    def test_connect_failure_latches_for_the_whole_walk(self, loader, gateway, stub_futu):
        """One refused connect must cover the remaining symbols of a batch."""
        from backtest.loaders.base import NoAvailableSourceError

        stub_futu.OpenQuoteContext.side_effect = OSError("connection refused")
        with pytest.raises(NoAvailableSourceError):
            loader.fetch(["700.HK"], "2024-01-01", "2024-01-31")
        assert gateway.in_cooldown("127.0.0.1", 11111) is True
        # The next symbol in the same walk now fails instantly instead of
        # paying another connect round trip.
        stub_futu.OpenQuoteContext.reset_mock()
        with pytest.raises(NoAvailableSourceError, match="marked unavailable"):
            loader.fetch(["5.HK"], "2024-01-01", "2024-01-31")
        stub_futu.OpenQuoteContext.assert_not_called()

    def test_kline_requests_forward_adjusted_bars(self, loader, gateway, stub_futu):
        """autype must be qfq: it is what the rest of the equity chain serves."""
        ctx = MagicMock()
        ctx.request_history_kline.return_value = (
            0,
            pd.DataFrame({
                "code": ["HK.00700"],
                "time_key": ["2024-01-02 00:00:00"],
                "open": [350.0], "high": [360.0], "low": [345.0],
                "close": [355.0], "volume": [1_000_000],
            }),
            None,
        )
        stub_futu.OpenQuoteContext.return_value = ctx
        loader.fetch(["700.HK"], "2024-01-01", "2024-01-31")
        assert ctx.request_history_kline.call_args.kwargs["autype"] == "qfq"


class TestRealtimeQuotes:
    def test_unsupported_shapes_are_never_sent(self, gateway, stub_futu):
        """Crypto/LSE/index codes are not Futu instruments — no round trip."""
        from backtest.loaders.futu import realtime_quotes

        assert realtime_quotes(["BTC-USDT", "SHELL.L", "^SPX"]) == {}
        stub_futu.OpenQuoteContext.assert_not_called()

    def test_supported_shapes_are_converted_and_keyed_back(self, gateway, stub_futu):
        from backtest.loaders.futu import realtime_quotes

        ctx = MagicMock()
        row = {
            "code": "US.AAPL",
            "last_price": 319.97,
            "prev_close_price": 328.21,
            "open_price": 320.0,
            "high_price": 322.0,
            "low_price": 318.0,
            "volume": 10.0,
            "turnover": 3200.0,
            "update_time": "2026-09-04 19:59:58",
            "name": "Apple",
        }
        ctx.get_market_snapshot.return_value = (0, pd.DataFrame([row]))
        stub_futu.OpenQuoteContext.return_value = ctx
        out = realtime_quotes(["AAPL.US"])
        # Keyed by the symbol that was asked for, not the OpenD code.
        assert out["AAPL.US"]["last"] == 319.97
        assert out["AAPL.US"]["source"] == "futu"
        assert out["AAPL.US"]["change_pct"] == pytest.approx((319.97 - 328.21) / 328.21 * 100)
        assert ctx.get_market_snapshot.call_args.args[0] == ["US.AAPL"]

    def test_bare_ticker_reaches_us_market(self, gateway, stub_futu):
        from backtest.loaders.futu import _to_futu_symbol

        assert _to_futu_symbol("AAPL") == "US.AAPL"
        assert _to_futu_symbol("AAPL.US") == "US.AAPL"
        # Numeric codes must not be guessed into the US market.
        assert _to_futu_symbol("600519") == "600519"


class TestQuoteRowShaping:
    def test_unparseable_timestamp_yields_no_quote(self):
        """A fabricated timestamp would sort alerts and charts wrong."""
        from src.api.market_routes import _live_quote_row

        assert _live_quote_row("700.HK", {"last": 442.8, "update_time": "not-a-date"}) is None

    def test_missing_last_price_yields_no_quote(self):
        from src.api.market_routes import _live_quote_row

        assert _live_quote_row("700.HK", {"last": None, "update_time": "2026-09-04"}) is None
        assert _live_quote_row("700.HK", None) is None

    def test_valid_row_is_shaped_into_the_quote_contract(self):
        from src.api.market_routes import _live_quote_row

        row = _live_quote_row(
            "700.HK", {"last": 442.81234, "change_pct": 2.264, "update_time": "2026-09-04 16:07:59"}
        )
        assert row["ok"] is True
        assert row["symbol"] == "700.HK"
        assert row["last"] == 442.8123
        assert row["change_pct"] == 2.26
        assert row["realtime"] is True
        assert row["source"] == "futu"
        assert isinstance(row["timestamp"], int) and row["timestamp"] > 0
