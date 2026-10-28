"""Pins the akshare 1.20 module move that silently disabled forex routing.

akshare 1.20.0 (uploaded 2026-10-27) deleted the whole ``akshare.forex`` package and
moved its pair table to ``akshare.fx.cons_forex``. ``_is_forex`` imported only the old
private path behind ``except Exception: return False``, so the rename did not raise
— it made every forex pair look like an A-share, and the forex lane degraded in
silence. ``requirements-lock.txt`` pins akshare==1.19.1 (old layout, no ``fx`` path)
while the ``test`` legs install ``-e .`` against ``akshare>=1.12.0`` and so resolve
1.20.0 — both layouts are in service at once and both have to work.

Most cases below fake a layout in ``sys.modules``, or a broken install on
``sys.meta_path``, so the pin runs offline; the last case drops the fakes and asks
whatever akshare this machine actually has.
"""

from __future__ import annotations

import sys
import types

import pytest

from backtest.loaders.akshare_loader import _is_forex

#: The pair table as akshare actually keys it: bare uppercase pairs, no slash form,
#: no ``.FX`` form. Read off the installed 1.18.81 and off the 1.20.0 wheel
#: (``akshare/fx/cons_forex.py``) — both hold the same 190 keys. A fake that also
#: keyed ``EUR/USD`` would make the slash fold unobservable.
_TABLE_KEYS = {"EURUSD", "GBPUSD", "USDCHF"}


def _fake_layout(monkeypatch: pytest.MonkeyPatch, dotted: str) -> None:
    """Publish ``dotted`` as an importable module holding the pair table."""
    parts = dotted.split(".")
    for i in range(len(parts)):
        name = ".".join(parts[: i + 1])
        module = types.ModuleType(name)
        if i == len(parts) - 1:
            # Values are akshare's numeric market codes; the body only ever asks
            # membership, so the keys are what has to look real.
            module.symbol_market_map = {pair: 119 for pair in _TABLE_KEYS}
        monkeypatch.setitem(sys.modules, name, module)


def _block_layout(monkeypatch: pytest.MonkeyPatch, dotted: str) -> None:
    """Make ``dotted`` unimportable, the way a deleted package does.

    Blocking the parents is not enough on its own: ``test_akshare_loader.py`` resolves
    the real table in the same worker, and a leaf already sitting in ``sys.modules``
    is handed back without the blocked parent ever being consulted. So anything cached
    under ``dotted`` goes in as ``None`` too.
    """
    parts = dotted.split(".")
    for i in range(len(parts)):
        monkeypatch.setitem(sys.modules, ".".join(parts[: i + 1]), None)
    prefix = dotted + "."
    for name in [n for n in tuple(sys.modules) if n.startswith(prefix)]:
        monkeypatch.setitem(sys.modules, name, None)


def test_new_layout_only_still_detects_forex(monkeypatch: pytest.MonkeyPatch) -> None:
    # akshare >= 1.20: akshare.forex is gone, the table lives under akshare.fx.
    _block_layout(monkeypatch, "akshare.forex")
    _fake_layout(monkeypatch, "akshare.fx.cons_forex")
    assert _is_forex("EURUSD") is True


def test_old_layout_only_still_detects_forex(monkeypatch: pytest.MonkeyPatch) -> None:
    # akshare <= 1.19 — the version held by requirements-lock.txt.
    _block_layout(monkeypatch, "akshare.fx")
    _fake_layout(monkeypatch, "akshare.forex.cons")
    assert _is_forex("EURUSD") is True


def test_slash_form_resolves_on_the_new_layout(monkeypatch: pytest.MonkeyPatch) -> None:
    # The mt5 -> akshare fallback passes project-style codes like "EUR/USD".
    _block_layout(monkeypatch, "akshare.forex")
    _fake_layout(monkeypatch, "akshare.fx.cons_forex")
    assert _is_forex("EUR/USD") is True
    assert _is_forex("eurusd") is True
    assert _is_forex("EURUSD.FX") is True


def test_pair_absent_from_the_table_is_not_forex(monkeypatch: pytest.MonkeyPatch) -> None:
    # The True half keeps the False halves from passing by ignoring the table.
    _block_layout(monkeypatch, "akshare.forex")
    _fake_layout(monkeypatch, "akshare.fx.cons_forex")
    assert _is_forex("EURUSD") is True
    assert _is_forex("600519.SH") is False
    assert _is_forex("ZZZZZZ") is False


def test_missing_table_warns_instead_of_going_quiet(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    # A third akshare reshuffle must surface as a log line, not as "not forex".
    # The 1.20 move stayed invisible for a day precisely because a miss returned
    # False without saying anything.
    _block_layout(monkeypatch, "akshare.forex")
    _block_layout(monkeypatch, "akshare.fx")
    with caplog.at_level("WARNING", logger="backtest.loaders.akshare_loader"):
        assert _is_forex("EURUSD") is False
    assert "symbol_market_map" in caplog.text


class _ImportHookFails:
    """Meta-path finder that fails an import with something that is not an
    ImportError — the shape of a half-installed akshare, not of a moved table."""

    def __init__(self, top: str, exc: BaseException) -> None:
        self.top = top
        self.exc = exc

    def find_spec(self, fullname, path=None, target=None):
        if fullname == self.top or fullname.startswith(self.top + "."):
            raise self.exc
        return None


def test_a_broken_akshare_raises_instead_of_answering_not_forex(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    # The old handler was `except Exception: return False`, which is the other half
    # of why the 1.20 move stayed quiet: any import-time failure was re-read as a
    # routing answer. Narrowed to ImportError/AttributeError, a broken install now
    # reaches the caller instead of being answered.
    for name in ("akshare", "akshare.forex", "akshare.forex.cons", "akshare.fx"):
        monkeypatch.delitem(sys.modules, name, raising=False)
    hook = _ImportHookFails("akshare", RuntimeError("akshare is half-installed"))
    # First, not last: the real PathFinder answers every akshare name, so a hook
    # appended behind it is never consulted.
    monkeypatch.setattr(sys, "meta_path", [hook, *sys.meta_path])
    with pytest.raises(RuntimeError, match="half-installed"):
        _is_forex("EURUSD")


def test_the_akshare_actually_installed_here_resolves() -> None:
    # No fakes: whichever akshare this machine really has must answer for a pair that
    # has been in the table for years. The two literals the fakes above publish were
    # read off an installed 1.18.81 and off the 1.20.0 wheel rather than assumed, and
    # this is the case that turns a third reshuffle red on the day it is installed —
    # which is exactly when the silent `except Exception: return False` did not.
    pytest.importorskip("akshare")
    assert _is_forex("EURUSD") is True
    assert _is_forex("ZZZZZZ") is False
