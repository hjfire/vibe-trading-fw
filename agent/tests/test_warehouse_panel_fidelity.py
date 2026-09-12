"""Acceptance criterion 5: the offline panel equals the vendor panel, value for value.

The warehouse exists so a bench can be re-run years later, offline, and land on
the same numbers. That claim is only worth anything if the two code paths are
provably the same panel — same vwap derivation, same point-in-time cross-section
mask, same adjustment anchor — which is why both route through
:func:`src.tools.alpha_bench_tool._assemble_csi300_panel`.

``TUSHARE_TOKEN`` is unset in this environment, so the vendor side is exercised
with its own ``apply_qfq`` helper fed the same synthetic raw bars the store was
fed. That is the comparison that matters: not "does the network path work", but
"do the two paths disagree anywhere they must not".
"""

from __future__ import annotations

import inspect
from pathlib import Path

import pandas as pd
import pytest

from backtest.loaders.cn_adjust import apply_qfq
from backtest.warehouse import store
from backtest.warehouse.schema import normalize_bars

tool = pytest.importorskip("src.tools.alpha_bench_tool")

ROOT_ENV_VAR = "VIBE_TRADING_WAREHOUSE_ENABLED"
ROOT_ROOT_ENV = "VIBE_TRADING_WAREHOUSE_ROOT"

#: Three sessions, one ex-rights step, and a member that joins at the second
#: snapshot — so the point-in-time mask has something to hide.
_DATES = pd.DatetimeIndex(["2020-01-02", "2020-01-03", "2020-01-06", "2020-01-07"])
_SNAPSHOTS = pd.DatetimeIndex(["2019-12-31", "2020-01-03"])
_JOINNER = "600000.SH"
_ALWAYS = ("600519.SH", "000858.SZ")


def _base_close(code: str) -> float:
    return 100.0 if code == _ALWAYS[0] else 20.0


def _factors(code: str) -> list[float]:
    """One factor per session; the anchor symbol doubles mid-window (ex-rights)."""
    return [1.0, 1.0, 2.0, 2.0] if code == _ALWAYS[0] else [1.5, 1.5, 1.5, 1.5]


#: Raw (unadjusted) close multipliers per session. ``_ALWAYS[0]`` *halves* its
#: price on 2020-01-06, the day its factor doubles — that mechanical drop is the
#: whole reason qfq exists, and a fixture without it cannot detect a qfq bug.
_PROFILES: dict[str, tuple[float, ...]] = {
    _ALWAYS[0]: (1.0, 0.99, 0.5050, 0.50),
    _ALWAYS[1]: (1.0, 0.99, 1.01, 1.0),
    _JOINNER: (1.0, 0.98, 1.02, 1.0),
}


def _raw(code: str) -> pd.DataFrame:
    """One raw daily frame, tushare units: vol in 手, amount in 千元."""
    closes = [_base_close(code) * m for m in _PROFILES[code]]
    return pd.DataFrame(
        {
            "open": [c * 0.995 for c in closes],
            "high": [c * 1.01 for c in closes],
            "low": [c * 0.99 for c in closes],
            "close": closes,
            "volume": [12_000.0, 9_500.0, 11_000.0, 8_700.0],
            "amount": [1_500_000.0, 1_180_000.0, 1_400_000.0, 1_090_000.0],
        },
        index=_DATES,
    )


def _factor_frame(code: str) -> pd.DataFrame:
    """``pro.adj_factor``-shaped rows, the shape the vendor path feeds qfq with."""
    return pd.DataFrame(
        {
            "ts_code": code,
            "trade_date": [d.strftime("%Y%m%d") for d in _DATES],
            "adj_factor": _factors(code),
        }
    )


def _membership() -> pd.DataFrame:
    """date x symbol roster in which ``_JOINNER`` only appears in snapshot 2."""
    frame = pd.DataFrame(False, index=_SNAPSHOTS, columns=[*_ALWAYS, _JOINNER])
    frame.loc[:, _ALWAYS[0]] = True
    frame.loc[:, _ALWAYS[1]] = True
    frame.loc[_SNAPSHOTS[1], _JOINNER] = True
    return frame


@pytest.fixture()
def warehouse(tmp_path: Path, monkeypatch) -> Path:
    """Enable the store, fill it, and point the config layer at it."""
    from src.config.accessor import reset_env_config

    root = tmp_path / "wh"
    monkeypatch.setenv(ROOT_ENV_VAR, "true")
    monkeypatch.setenv(ROOT_ROOT_ENV, str(root))
    reset_env_config()

    membership = _membership()
    for code in (*_ALWAYS, _JOINNER):
        frame = _raw(code).copy()
        frame["adj_factor"] = _factors(code)
        bars, report = normalize_bars(
            frame,
            symbol=code,
            interval="1D",
            source="tushare",
            volume_unit="lots",
            amount_unit="cny_thousand",
        )
        assert report.is_clean, f"the fixture itself must survive the write gate: {report.to_dict()}"
        store.write_bars(bars, interval="1D", root=root)

    written = store.write_universe_roster(
        "csi300",
        membership,
        constituent_source="tushare index_weight",
        constituent_source_date=str(_SNAPSHOTS[-1].date()),
        root=root,
    )
    assert written is not None
    yield root
    reset_env_config()


def _vendor_panel(membership: pd.DataFrame) -> dict:
    """The vendor path's own arithmetic, fed the same raw bars and factors."""
    fetched = {
        code: apply_qfq(_raw(code), _factor_frame(code))
        for code in (*_ALWAYS, _JOINNER)
    }
    return tool._assemble_csi300_panel(
        fetched,
        membership=membership,
        constituent_source="tushare index_weight",
        constituent_source_date=str(_SNAPSHOTS[-1].date()),
        codes=sorted(fetched),
        dropped=[],
    )


# ---------------------------------------------------------------------------
# The equality claim
# ---------------------------------------------------------------------------


def test_warehouse_panel_equals_the_vendor_panel_value_for_value(warehouse) -> None:
    start, end = "2020-01-02", "2020-01-07"
    wh = tool._load_warehouse_csi300_panel(start, end)
    vendor = _vendor_panel(_membership())

    assert set(wh) - {"_meta"} == set(vendor) - {"_meta"}
    for field in sorted(set(wh) - {"_meta"}):
        pd.testing.assert_frame_equal(wh[field], vendor[field], check_names=False)
    assert "vwap" in wh, "gtja191 factors read vwap; a missing column is a silent NaN bench"


def test_both_paths_apply_the_same_point_in_time_mask(warehouse) -> None:
    """The joiner is NaN before its snapshot and present after, on both sides.

    Without the mask every IC is measured on a set selected with hindsight, and
    the warehouse would be a survivorship machine with better provenance.
    """
    wh = tool._load_warehouse_csi300_panel("2020-01-02", "2020-01-07")
    vendor = _vendor_panel(_membership())
    for panel in (wh, vendor):
        close = panel["close"]
        # The joiner's first roster appearance is the 2020-01-03 snapshot, so the
        # session before it must be masked out of the cross-section.
        assert pd.isna(close.loc[_DATES[0], _JOINNER]), "member only from snapshot 2"
        assert close.loc[_DATES[1]:, _JOINNER].notna().all()
        assert close[_ALWAYS[0]].notna().all()
    pd.testing.assert_frame_equal(wh["close"], vendor["close"], check_names=False)


def test_panel_meta_agrees_except_for_provenance(warehouse) -> None:
    wh = tool._load_warehouse_csi300_panel("2020-01-02", "2020-01-07")
    vendor = _vendor_panel(_membership())
    warehouse_only = {"data_source", "warehouse_root", "stored_symbols"}
    assert {k: v for k, v in wh["_meta"].items() if k not in warehouse_only} == vendor["_meta"]

    meta = wh["_meta"]
    assert meta["data_source"] == "warehouse"
    assert meta["survivorship_bias"] is False
    assert meta["pit_membership"] is True
    assert meta["degraded"] is False
    assert meta["price_adjustment"] == "qfq"
    assert meta["constituent_count"] == 3
    assert Path(meta["warehouse_root"]).name == "bars"


def test_ex_date_return_is_not_fabricated_on_either_path(warehouse) -> None:
    """600519.SH halves its raw close as its factor doubles: no +104% day survives."""
    wh = tool._load_warehouse_csi300_panel("2020-01-02", "2020-01-07")
    vendor = _vendor_panel(_membership())
    for panel in (wh, vendor):
        returns = panel["close"][_ALWAYS[0]].pct_change().dropna()
        assert (returns.abs() < 0.05).all(), returns.tolist()
    pd.testing.assert_series_equal(
        wh["close"][_ALWAYS[0]], vendor["close"][_ALWAYS[0]], check_names=False
    )


# ---------------------------------------------------------------------------
# The wiring, and the refusals
# ---------------------------------------------------------------------------


def test_unwired_source_is_refused_not_ignored() -> None:
    with pytest.raises(ValueError, match="not wired into the panel loader"):
        tool._load_universe_panel("csi300", "2020-2020", source="tushare")
    with pytest.raises(ValueError, match="not recognized"):
        tool._load_universe_panel("sse50", "2020-2020", source="warehouse")


def test_warehouse_panel_never_touches_the_pickle_cache(warehouse, monkeypatch) -> None:
    """Parquet is the cache; a second copy would go stale against the next sync."""
    cache_dir = Path.home() / ".vibe-trading" / "cache"
    panel = tool._load_universe_panel("csi300", "2020-01-02/2020-01-07", source="warehouse")
    assert panel["_meta"]["data_source"] == "warehouse"
    assert list(cache_dir.glob("csi300*")) == []
    # The vendor stem stays untouched by the namespacing, so old caches survive.
    assert tool._panel_cache_stem("csi300", "2020-01-02", "2020-01-07", None) == (
        "csi300_2020-01-02_2020-01-07"
    )
    assert "warehouse" in tool._panel_cache_stem("csi300", "2020-01-02", "2020-01-07", "warehouse")
    assert ":" not in tool._panel_cache_stem("csi300", "2020-01-02", "2020-01-07", "warehouse")


def test_missing_roster_reports_itself_as_survivorship_biased(warehouse) -> None:
    """No roster on disk means no mask — and the panel has to say so out loud.

    The absent file is the honest record of a sync whose vendor roster call had
    failed; a reader must get ``survivorship_bias=true`` rather than a panel that
    quietly carries today's names through the whole window.
    """
    from backtest.warehouse.layout import universe_membership_file, universe_meta_file

    for path in (universe_membership_file("csi300", warehouse), universe_meta_file("csi300", warehouse)):
        if path.is_file():
            path.unlink()
    panel = tool._load_warehouse_csi300_panel("2020-01-02", "2020-01-07")
    assert panel["_meta"]["survivorship_bias"] is True
    assert panel["_meta"]["pit_membership"] is False
    assert panel["_meta"]["degraded"] is True
    # Unmasked: the joiner is present from the first session.
    assert panel["close"][_JOINNER].notna().all()


def test_disabled_store_raises_with_the_fix(tmp_path, monkeypatch) -> None:
    from src.config.accessor import reset_env_config

    monkeypatch.delenv(ROOT_ENV_VAR, raising=False)
    monkeypatch.setenv(ROOT_ROOT_ENV, str(tmp_path / "empty"))
    reset_env_config()
    with pytest.raises(RuntimeError, match=ROOT_ENV_VAR):
        tool._load_warehouse_csi300_panel("2020-01-02", "2020-01-07")
    reset_env_config()


def test_empty_store_raises_with_the_sync_command(warehouse, tmp_path, monkeypatch) -> None:
    from src.config.accessor import reset_env_config

    monkeypatch.setenv(ROOT_ROOT_ENV, str(tmp_path / "fresh"))
    reset_env_config()
    with pytest.raises(RuntimeError, match="sync"):
        tool._load_warehouse_csi300_panel("2020-01-02", "2020-01-07")
    reset_env_config()


def test_bench_runners_pass_the_source_through(warehouse, monkeypatch) -> None:
    """``--data-source warehouse`` has to reach the panel loader, not just the CLI.

    Both runners forward the value to :func:`_load_universe_panel`, and only when
    it was asked for: the second half of this test calls them with no
    ``data_source`` against a *two-argument* stub, which is the shape existing
    test doubles have. Passing the keyword unconditionally would break them.

    The stub records and refuses, which is also the cheapest way through a
    runner: everything after the panel load is factor arithmetic.
    """
    class _Stop(Exception):
        pass

    class _Registry:
        def list(self, zoo: str | None = None) -> list[str]:  # noqa: ARG002
            return ["gtja191_1"]

    period = "2020-01-02/2020-01-07"
    seen: list[tuple[str, str, str | None]] = []

    def _stub(universe: str, window: str, *, use_cache: bool = True, source: str | None = None):
        seen.append((universe, window, source))
        raise _Stop("recorded and refused")

    two_arg_seen: list[tuple[str, str]] = []

    def _two_arg_stub(universe: str, window: str) -> dict:
        two_arg_seen.append((universe, window))
        raise _Stop("legacy two-argument stub")

    for module_name, fn_name in (
        ("src.factors.bench_runner", "run_bench"),
        ("src.factors.bench_runner_strict", "run_bench_strict"),
    ):
        module = pytest.importorskip(module_name)
        run = getattr(module, fn_name)
        assert "data_source" in inspect.signature(run).parameters, module_name
        # ``random_control`` is keyword-only with no default on purpose, so the
        # strict rail has to be told; the plain runner takes nothing extra.
        required = {"random_control": False} if "strict" in module_name else {}

        monkeypatch.setattr(module, "_load_universe_panel", _stub)
        seen.clear()
        with pytest.raises(_Stop):
            run(
                zoo="gtja191",
                universe="csi300",
                period=period,
                top=1,
                registry=_Registry(),
                data_source="warehouse",
                **required,
            )
        assert seen == [("csi300", period, "warehouse")], module_name

        monkeypatch.setattr(module, "_load_universe_panel", _two_arg_stub)
        two_arg_seen.clear()
        with pytest.raises(_Stop):
            run(
                zoo="gtja191",
                universe="csi300",
                period=period,
                top=1,
                registry=_Registry(),
                **required,
            )
        assert two_arg_seen == [("csi300", period)], module_name
