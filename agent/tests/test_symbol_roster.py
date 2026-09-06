"""Tests for the local symbol roster behind the type-ahead box (local custom ㉓).

No network anywhere: matching is exercised against an injected ``rows=`` roster,
and the source builders are handed fake DataFrames / monkeypatched akshare. The
real FutuOpenD pull is measured by hand (its numbers are quoted in the module
docstring) rather than asserted here — a CI runner has no gateway.

The interesting assertions are the ones that encode a measured regression:
``600`` must not put 000600.SZ or 00600.HK ahead of the Shanghai 600xxx series,
and ``00700`` must not offer 象屿配股.
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import pytest

from src import symbol_roster as sr
from tests.module_os_helpers import patch_module_os


# --------------------------------------------------------------------------- #
# fixtures
# --------------------------------------------------------------------------- #


@pytest.fixture(autouse=True)
def _isolate_process_cache(monkeypatch: pytest.MonkeyPatch) -> None:
    """Give every test a clean in-memory roster and build flag.

    ``_MEM`` and ``_BUILDING`` are module globals shared by the whole process,
    so without this a warmup started by one test leaks into the next.
    """
    monkeypatch.setattr(sr, "_MEM", {"rows": None, "loaded_at": 0.0, "generations": 0})
    monkeypatch.setattr(sr, "_BUILDING", [False])


def _rows(*specs: tuple[str, str, str], source: str = "test") -> list[dict[str, Any]]:
    """Build roster rows from ``(symbol, name, type)`` triples."""
    return [
        {"symbol": s, "name": n, "type": t, "market": sr.market_of(s), "source": source}
        for s, n, t in specs
    ]


@pytest.fixture
def roster() -> list[dict[str, Any]]:
    """A clean roster shaped like the real one on the contested queries.

    ``700057.SH 象屿配股`` is deliberately NOT here: the builder drops it, so
    ``search`` never sees it. Its own tests below pin the filter at the cache
    boundary, which is where the defence actually lives.
    """
    return _rows(
        ("600000.SH", "浦发银行", "equity"),
        ("600519.SH", "贵州茅台", "equity"),
        ("600036.SH", "招商银行", "equity"),
        ("000600.SZ", "建投能源", "equity"),
        ("000001.SZ", "平安银行", "equity"),
        ("000001.SH", "上证综合指数", "index"),
        ("00600.HK", "爱芯元智", "equity"),
        ("00700.HK", "腾讯控股", "equity"),
        ("920000.BJ", "安徽凤凰", "equity"),
        ("AAPL.US", "苹果", "equity"),
        ("HP.US", "惠普", "equity"),
        ("HPE.US", "慧与", "equity"),
        ("HPE.PRC.US", "慧与优先C", "equity"),
        ("510300.SH", "沪深300ETF", "etf"),
        ("000300.SH", "沪深300指数", "index"),
    )


def symbols(out: list[dict[str, Any]]) -> list[str]:
    return [row["symbol"] for row in out]


# --------------------------------------------------------------------------- #
# symbol normalisation
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("code", "expected"),
    [
        ("SH.600519", "600519.SH"),
        ("SZ.000001", "000001.SZ"),
        ("HK.00700", "00700.HK"),
        ("HK.700", "00700.HK"),  # Futu pads to five; users do not
        ("US.AAPL", "AAPL.US"),
        ("sh.600519", "600519.SH"),  # case is not meaningful
        ("  HK.00005  ", "00005.HK"),
    ],
)
def test_from_futu_code(code: str, expected: str) -> None:
    assert sr.from_futu_code(code) == expected


@pytest.mark.parametrize("code", ["", None, "600519", "US.", "JP.6702", "SH.."])
def test_from_futu_code_rejects_unknown_shapes(code: str | None) -> None:
    """Anything we cannot map exactly must return None, never a guess."""
    assert sr.from_futu_code(code) is None  # type: ignore[arg-type]


def test_a_share_suffix_routes_beijing_before_shanghai() -> None:
    # 920 is a Beijing segment; its leading 9 is otherwise Shanghai's.
    assert sr._a_share_suffix("920000") == "BJ"
    assert sr._a_share_suffix("430047") == "BJ"
    assert sr._a_share_suffix("832000") == "BJ"
    assert sr._a_share_suffix("688981") == "SH"
    assert sr._a_share_suffix("510300") == "SH"
    assert sr._a_share_suffix("000001") == "SZ"
    assert sr._a_share_suffix("300750") == "SZ"


def test_clean_name_strips_exchange_padding() -> None:
    # Shenzhen pads short names with full-width spaces and uses Ａ/Ｂ.
    assert sr._clean_name("万  科Ａ") == "万科A"
    assert sr._clean_name("\u3000万科\u3000") == "万科"
    assert sr._clean_name("贵州茅台") == "贵州茅台"


@pytest.mark.parametrize(
    ("query", "needle"),
    [
        ("600519.SH", "600519.SH"),
        ("sh600519", "600519"),
        ("HK.00700", "00700"),
        ("  600  ", "600"),
        ("茅台", "茅台"),
        ("600519.", "600519"),
        # A venue marker is only stripped ahead of digits — these are tickers.
        ("HP", "HP"),
        ("SH", "SH"),
        ("SHP", "SHP"),
        ("", ""),
        (None, ""),  # type: ignore[arg-type]
    ],
)
def test_normalise(query: str | None, needle: str) -> None:
    assert sr._normalise(query) == needle  # type: ignore[arg-type]


# --------------------------------------------------------------------------- #
# which rows are allowed into the roster
# --------------------------------------------------------------------------- #


@pytest.mark.parametrize(
    ("symbol", "ok"),
    [
        ("600519.SH", True),
        ("920000.BJ", True),
        ("00700.HK", True),
        ("810004.HK", False),  # 临时代码 placeholder, six-wide (measured: all 750)
        ("AAPL.US", True),
        ("BRK.B.US", True),
        ("700057.SH", False),  # 配股 placeholder, not tradable
        ("730057.SZ", False),  # same block on Shenzhen
        ("2578256D.US", False),  # ISIK identifier, not a ticker
        ("BTCUSD", False),  # no venue: not a chartable symbol form
        ("", False),
        ("600519", False),  # missing suffix would break every loader
    ],
)
def test_is_chartable(symbol: str, ok: bool) -> None:
    assert sr._is_chartable(symbol) is ok


def test_noise_filter_is_scoped_to_mainland_equity_codes() -> None:
    # A leading 7 is legitimate in Hong Kong (700.HK = Tencent).
    assert sr._is_noise_code("700.HK") is False
    assert sr._is_noise_code("700057.SH") is True


# --------------------------------------------------------------------------- #
# matching
# --------------------------------------------------------------------------- #


def test_exact_beats_everything(roster: list[dict[str, Any]]) -> None:
    assert symbols(sr.search("600519", rows=roster))[0] == "600519.SH"
    assert symbols(sr.search("600519.SH", rows=roster))[0] == "600519.SH"


def test_chinese_name_prefix_and_infix(roster: list[dict[str, Any]]) -> None:
    assert symbols(sr.search("茅台", rows=roster)) == ["600519.SH"]
    assert symbols(sr.search("招商", rows=roster)) == ["600036.SH"]
    # '银行' sits inside three names, so it is an infix tier; SH and SZ share the
    # same type and market rank, so the bare code decides — a deterministic order,
    # not a venue grouping.
    assert symbols(sr.search("银行", rows=roster)) == [
        "000001.SZ",
        "600000.SH",
        "600036.SH",
    ]


def test_hk_zero_padding_is_a_prefix_not_an_exact_hit(roster: list[dict[str, Any]]) -> None:
    assert symbols(sr.search("700", rows=roster))[0] == "00700.HK"


def test_bare_prefix_does_not_promote_other_venues(roster: list[dict[str, Any]]) -> None:
    """The measured regression: ``600`` used to read as an exact match for
    ``00600.HK`` and for the zero-padded ``000600.SZ``, burying the Shanghai
    600xxx series the user was actually reaching for."""
    out = symbols(sr.search("600", rows=roster))
    assert out[:3] == ["600000.SH", "600036.SH", "600519.SH"]
    # The Hong Kong listing still qualifies, one tier down, and an infix hit on
    # 000600.SZ sits below all of them.
    assert out.index("00600.HK") > out.index("600519.SH")
    assert out.index("000600.SZ") > out.index("00600.HK")


def test_rights_issue_placeholder_never_reaches_the_caller(
    sandbox_root: Path,
) -> None:
    """A 配股 placeholder that slipped into the cache is filtered on read.

    The builder rejects it; the cache read rejects it again, because a cache
    written by an older build is exactly where such a row would hide."""
    sr._write_cache(
        _rows(("00700.HK", "腾讯控股", "equity"), ("700057.SH", "象屿配股", "equity"))
    )
    rows = sr.peek_roster()[0]
    assert "700057.SH" not in symbols(rows)
    assert symbols(sr.search("700", rows=rows, load=False)) == ["00700.HK"]
    assert symbols(sr.search("700057", rows=rows, load=False)) == []


def test_beijing_segment_is_reachable(roster: list[dict[str, Any]]) -> None:
    assert symbols(sr.search("920", rows=roster)) == ["920000.BJ"]


def test_ticker_prefix_keeps_short_tickers(roster: list[dict[str, Any]]) -> None:
    assert symbols(sr.search("hp", rows=roster)) == ["HP.US", "HPE.US", "HPE.PRC.US"]
    assert symbols(sr.search("aapl", rows=roster)) == ["AAPL.US"]


def test_plain_listing_precedes_its_own_sub_shares(roster: list[dict[str, Any]]) -> None:
    """The measured ``HP`` regression: the preferred outranked the ordinary.

    ``HPE.PRC.US`` and ``HPE.US`` share a bare code, so every other tiebreak key
    is equal and the roster's alphabetical order decided it — on the live roster
    that put ``HPE.PRC.US 7.625% SERIES C MAN CONV PREF`` above 慧与科技.
    """
    out = symbols(sr.search("hpe", rows=roster))
    assert out[:2] == ["HPE.US", "HPE.PRC.US"]
    assert sr.to_bare_code("HPE.PRC.US") == sr.to_bare_code("HPE.US")


def test_a_dotted_symbol_typed_back_is_an_exact_hit(roster: list[dict[str, Any]]) -> None:
    """Measured gap: typing what the picker just showed matched nothing.

    The row reads ``HPE.PRC.US``, so a user who types ``HPE.PRC`` expects it;
    the exact tier only ever compared the first dot-separated segment, which
    reduced that symbol to ``HPE`` — on the live roster ``HPE.PRC`` returned no
    rows at all and ``BRK.B`` came back with two leveraged ETFs instead of
    伯克希尔-B.
    """
    assert symbols(sr.search("HPE.PRC", rows=roster)) == ["HPE.PRC.US"]
    assert symbols(sr.search("hpe.prc.us", rows=roster)) == ["HPE.PRC.US"]
    # The short stem has to keep scoring as exact too, or ``BRK`` would lose
    # BRK.A.US / BRK.B.US to every plain ticker that merely starts with BRK.
    hpe = next(r for r in roster if r["symbol"] == "HPE.PRC.US")
    assert sr._score("HPE", hpe) == sr._TIER_EXACT


def test_stock_precedes_etf_and_index_at_the_same_tier(roster: list[dict[str, Any]]) -> None:
    # 000001 is both 平安银行 (SZ) and 上证综合指数 (SH). An exact code hit must
    # offer the tradable equity first — a user typing a code wants a company.
    assert symbols(sr.search("000001", rows=roster))[0] == "000001.SZ"
    # Type breaks the tie, never overrides the tier: an exact hit on the index
    # still outranks a mere prefix hit on an equity.
    assert sr._score("000300", roster[-1]) == sr._TIER_EXACT


def test_infix_matches_are_last_resort(roster: list[dict[str, Any]]) -> None:
    out = symbols(sr.search("300ETF", rows=roster))
    assert out == ["510300.SH"]


def test_empty_and_short_queries(roster: list[dict[str, Any]]) -> None:
    assert sr.search("", rows=roster) == []
    assert sr.search("   ", rows=roster) == []
    assert sr.search("...", rows=roster) == []


def test_no_match_returns_empty(roster: list[dict[str, Any]]) -> None:
    assert sr.search("zzzzzz", rows=roster) == []


def test_limit_is_honoured_and_clamped(roster: list[dict[str, Any]]) -> None:
    assert len(sr.search("0", rows=roster, limit=2)) == 2
    # 0 reads as "unset"; a negative is repaired to the floor.
    assert len(sr.search("0", rows=roster, limit=0)) == sr.DEFAULT_LIMIT
    assert len(sr.search("0", rows=roster, limit=-5)) == 1
    # An absurd ceiling clamps to MAX_LIMIT rather than dumping the roster.
    everything = len(sr.search("0", rows=roster, limit=sr.MAX_LIMIT))
    assert everything > sr.DEFAULT_LIMIT  # the fixture really does overflow a page
    assert len(sr.search("0", rows=roster, limit=10_000)) == everything


def test_results_are_copies(roster: list[dict[str, Any]]) -> None:
    out = sr.search("600519", rows=roster)
    out[0]["name"] = "mutated"
    assert roster[1]["name"] == "贵州茅台"


def test_search_without_load_never_builds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """The keystroke path must not be able to trigger a 17-20 s build."""

    def _boom(*_a: Any, **_k: Any) -> None:
        raise AssertionError("get_roster must not run on the type-ahead path")

    monkeypatch.setattr(sr, "get_roster", _boom)
    assert sr.search("600", load=False) == []


# --------------------------------------------------------------------------- #
# cache round-trip
# --------------------------------------------------------------------------- #


@pytest.fixture
def sandbox_root(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    monkeypatch.setattr(sr, "roster_path", lambda: tmp_path / "symbol_roster.json")
    return tmp_path


def test_cache_round_trip_reports_age(sandbox_root: Path) -> None:  # noqa: ARG001
    rows = _rows(("600519.SH", "贵州茅台", "equity"), ("00700.HK", "腾讯控股", "equity"))
    sr._write_cache(rows)

    cached, age = sr._read_cache()
    assert cached == rows
    assert age < 5  # freshly written


def test_undated_cache_is_treated_as_untrustworthy(sandbox_root: Path) -> None:  # noqa: ARG001
    path = sr.roster_path()
    path.write_text(
        json.dumps({"rows": _rows(("600519.SH", "贵州茅台", "equity"))}), encoding="utf-8"
    )
    _cached, age = sr._read_cache()
    assert age == float("inf")


def test_corrupt_cache_and_noise_rows_are_dropped(sandbox_root: Path) -> None:  # noqa: ARG001
    path = sr.roster_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("{not json", encoding="utf-8")
    assert sr._read_cache() is None

    path.write_text(
        json.dumps(
            {
                "generated_at": sr.datetime.now(sr.timezone.utc).isoformat(),
                "rows": [
                    {"symbol": "600519.SH", "name": "贵州茅台", "type": "equity", "market": "SH"},
                    {"symbol": "700057.SH", "name": "象屿配股", "type": "equity", "market": "SH"},
                    {"symbol": "600036.SH", "name": "", "type": "equity", "market": "SH"},
                    "garbage",
                ],
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    cached, _age = sr._read_cache()
    assert [r["symbol"] for r in cached] == ["600519.SH"]


def test_write_cache_failure_leaves_memory_working(
    sandbox_root: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An unwritable cache is an optimisation miss, not an error (read-only disk).

    Via ``patch_module_os`` rather than an attribute patch through ``sr.os``:
    that attribute **is** the shared ``os`` module, so patching it reaches every
    importer in the process and can take pytest's own teardown with it (CI gate
    (f) / #1123) — and the gate is a static grep, so it fires on the shape of
    the call, not on whether the test meant it that way.
    """
    patch_module_os(
        monkeypatch, sr, replace=lambda *_a, **_k: (_ for _ in ()).throw(OSError("ro"))
    )

    rows = _rows(("600519.SH", "贵州茅台", "equity"))
    sr._write_cache(rows)  # must not raise
    assert sr.roster_path().exists() is False  # the failed rename left no cache
    assert sr._read_cache() is None


def test_peek_roster_reads_cache_and_never_builds(
    sandbox_root: Path, monkeypatch: pytest.MonkeyPatch  # noqa: ARG001
) -> None:
    rows = _rows(("600519.SH", "贵州茅台", "equity"))

    def _boom(*_a: Any, **_k: Any) -> None:
        raise AssertionError("peek_roster must not build")

    monkeypatch.setattr(sr, "build_roster", _boom)

    empty, stale = sr.peek_roster()
    assert empty == [] and stale is True  # cold start is a state, not a crash

    sr._write_cache(rows)
    found, stale = sr.peek_roster()
    assert symbols(found) == ["600519.SH"] and stale is False


def test_peek_roster_flags_a_stale_index(
    sandbox_root: Path, monkeypatch: pytest.MonkeyPatch  # noqa: ARG001
) -> None:
    sr._write_cache(_rows(("600519.SH", "贵州茅台", "equity")))
    sr.peek_roster()  # populate the memory entry from the fresh cache
    # The age lives on the memory entry, which is what staleness is judged on.
    monkeypatch.setitem(sr._MEM, "age", 100.0)

    assert sr.peek_roster(max_age_s=10.0)[1] is True
    assert sr.peek_roster(max_age_s=1000.0)[1] is False


def test_status_shape_without_a_cache(
    sandbox_root: Path,  # noqa: ARG001
) -> None:
    assert sr.status() == {"ready": False, "count": 0, "age_seconds": None, "building": False}


# --------------------------------------------------------------------------- #
# warmup single-flight
# --------------------------------------------------------------------------- #


def test_start_warmup_is_single_flight(monkeypatch: pytest.MonkeyPatch) -> None:
    import threading

    gate = threading.Event()
    release = threading.Event()
    calls: list[bool] = []

    def _slow(*, force: bool = False) -> list[dict[str, Any]]:
        calls.append(force)
        gate.set()
        release.wait(timeout=5)
        return []

    monkeypatch.setattr(sr, "get_roster", _slow)

    assert sr.start_warmup() is True
    gate.wait(timeout=5)
    assert sr.is_building() is True
    assert sr.start_warmup() is False  # second caller does not queue a second build

    release.set()
    for _ in range(100):
        if not sr.is_building():
            break
        time.sleep(0.02)
    assert sr.is_building() is False
    assert calls == [False]


@pytest.mark.filterwarnings("ignore::pytest.PytestUnhandledThreadExceptionWarning")
def test_start_warmup_clears_the_flag_even_when_the_build_raises(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A wedged flag would disable type-ahead until the process restarted."""

    def _explode(*_a: Any, **_k: Any) -> None:
        raise RuntimeError("gateway down")

    monkeypatch.setattr(sr, "get_roster", _explode)

    assert sr.start_warmup(force=True) is True
    for _ in range(100):
        if not sr.is_building():
            break
        time.sleep(0.02)
    assert sr.is_building() is False
    # The flag clears in ``finally``; let the dying thread finish unwinding so
    # its traceback is recorded against this test, not whatever runs next.
    time.sleep(0.05)


def test_get_roster_falls_back_to_a_stale_cache(
    sandbox_root: Path, monkeypatch: pytest.MonkeyPatch  # noqa: ARG001
) -> None:
    """Stale is better than nothing: a dead gateway keeps the last good list."""
    sr._write_cache(_rows(("600519.SH", "贵州茅台", "equity")))
    monkeypatch.setitem(sr._MEM, "rows", None)  # force a re-read
    monkeypatch.setattr(sr, "build_roster", lambda: (_ for _ in ()).throw(sr.RosterUnavailable("no")))

    rows = sr.get_roster(max_age_s=0.0)  # age 0 => always rebuild
    assert symbols(rows) == ["600519.SH"]


def test_get_roster_returns_empty_when_nothing_works(
    sandbox_root: Path, monkeypatch: pytest.MonkeyPatch  # noqa: ARG001
) -> None:
    monkeypatch.setattr(sr, "build_roster", lambda: (_ for _ in ()).throw(sr.RosterUnavailable("no")))
    assert sr.get_roster() == []


# --------------------------------------------------------------------------- #
# source builders (fake frames, no gateway)
# --------------------------------------------------------------------------- #


class _FakeFrame:
    def __init__(self, records: list[dict[str, Any]]) -> None:
        self._records = records

    def to_dict(self, _orient: str = "records") -> list[dict[str, Any]]:
        return list(self._records)


def _stub_gateway_target(
    monkeypatch: pytest.MonkeyPatch, target: tuple[Any, Any]
) -> None:
    """Make :func:`sr._futu_rows` see a gateway at *target*.

    Patched on the **real** module rather than injected into ``sys.modules``:
    ``_futu_rows`` resolves ``from backtest.loaders import futu_gateway`` as an
    attribute of the already-imported parent package, so an injected submodule
    is silently ignored the moment any earlier test file (``test_futu_gateway.py``)
    has imported the real one. That made this module pass in isolation and fail
    in the full run — the real ``gateway_target`` answers "unconfigured" here,
    because conftest pins ``FUTU_HOST``/``FUTU_PORT`` off (see 项目档案 37).
    """
    from backtest.loaders import futu_gateway

    monkeypatch.setattr(futu_gateway, "gateway_target", lambda: target)


def test_futu_rows_skips_a_denied_market(monkeypatch: pytest.MonkeyPatch) -> None:
    """One refusing venue must not cost the operator the other three."""
    import sys
    import types

    class _Ctx:
        def get_stock_basicinfo(self, market, stock_type=None, **_k):  # noqa: ANN001, ARG002
            if market == "US":
                return -1, _FakeFrame([])  # the gateway says no
            code = {"SH": "SH.600519", "SZ": "SZ.000001", "HK": "HK.00700"}[market]
            return 0, _FakeFrame(
                [{"code": code, "name": "x", "delisting": False}]
                if stock_type == "STOCK"
                else []
            )

        def close(self) -> None:
            return None

    module = types.ModuleType("futu")
    module.Market = types.SimpleNamespace(SH="SH", SZ="SZ", HK="HK", US="US")  # type: ignore[attr-defined]
    module.SecurityType = types.SimpleNamespace(STOCK="STOCK", ETF="ETF", IDX="IDX")  # type: ignore[attr-defined]
    module.OpenQuoteContext = lambda **_kw: _Ctx()  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "futu", module)

    _stub_gateway_target(monkeypatch, ("127.0.0.1", 11111))

    rows = sr._futu_rows()
    assert {r["market"] for r in rows} == {"SH", "SZ", "HK"}
    assert all(r["source"] == "futu" for r in rows)


def test_futu_rows_with_nothing_usable_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    import sys
    import types

    class _Ctx:
        def get_stock_basicinfo(self, *_a, **_k):  # noqa: ANN002, ANN003
            return -1, _FakeFrame([])

        def close(self) -> None:
            return None

    module = types.ModuleType("futu")
    module.Market = types.SimpleNamespace(SH="SH", SZ="SZ", HK="HK", US="US")  # type: ignore[attr-defined]
    module.SecurityType = types.SimpleNamespace(STOCK="STOCK", ETF="ETF", IDX="IDX")  # type: ignore[attr-defined]
    module.OpenQuoteContext = lambda **_kw: _Ctx()  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "futu", module)

    _stub_gateway_target(monkeypatch, ("127.0.0.1", 11111))

    with pytest.raises(sr.RosterUnavailable):
        sr._futu_rows()


def test_futu_rows_without_a_gateway_raises(monkeypatch: pytest.MonkeyPatch) -> None:
    import sys
    import types

    module = types.ModuleType("futu")
    module.Market = types.SimpleNamespace(SH="SH")  # type: ignore[attr-defined]
    module.SecurityType = types.SimpleNamespace(STOCK="STOCK")  # type: ignore[attr-defined]
    module.OpenQuoteContext = lambda **_kw: pytest.fail(  # type: ignore[attr-defined]
        "no context may be opened without a configured gateway"
    )
    monkeypatch.setitem(sys.modules, "futu", module)

    _stub_gateway_target(monkeypatch, ("", 0))

    with pytest.raises(sr.RosterUnavailable, match="not configured"):
        sr._futu_rows()


def test_ak_a_share_rows_map_venues_and_drop_blanks(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    import sys
    import types

    ak = types.ModuleType("akshare")
    ak.stock_info_a_code_name = lambda: _FakeFrame(  # type: ignore[attr-defined]
        [
            {"code": "600519", "name": "贵州茅台"},
            {"code": "1", "name": "平安银行"},  # short code gets padded
            {"code": "920000", "name": "安徽凤凰"},
            {"code": "700057", "name": "象屿配股"},  # placeholder, filtered
            {"code": "000002", "name": ""},  # blank name, filtered
        ]
    )
    monkeypatch.setitem(sys.modules, "akshare", ak)

    rows = sr._ak_a_share_rows()
    assert symbols(rows) == ["600519.SH", "000001.SZ", "920000.BJ"]
    assert {r["source"] for r in rows} == {"akshare"}


def _no_futu() -> list[dict[str, Any]]:
    raise sr.RosterUnavailable("gateway down")


def test_build_roster_falls_through_to_akshare(
    sandbox_root: Path, monkeypatch: pytest.MonkeyPatch  # noqa: ARG001
) -> None:
    """``_BUILDERS`` is replaced wholesale: it holds the functions themselves,
    so patching the module attributes would not reach the loop."""
    monkeypatch.setattr(
        sr,
        "_BUILDERS",
        (_no_futu, lambda: _rows(("600519.SH", "贵州茅台", "equity"))),
    )

    rows = sr.build_roster()
    assert symbols(rows) == ["600519.SH"]
    assert sr.roster_path().is_file()  # cached for the next keystroke


def test_build_roster_merges_beijing_only_for_a_futu_catalog(
    sandbox_root: Path, monkeypatch: pytest.MonkeyPatch  # noqa: ARG001
) -> None:
    bj = _rows(("920000.BJ", "安徽凤凰", "equity"))
    calls: list[int] = []
    monkeypatch.setattr(sr, "_ak_bj_rows", lambda: calls.append(1) or bj)

    # Futu catalog -> Beijing is missing from it, so it is fetched and merged.
    monkeypatch.setattr(
        sr,
        "_BUILDERS",
        (lambda: _rows(("600519.SH", "贵州茅台", "equity"), source="futu"),),
    )
    assert symbols(sr.build_roster()) == ["600519.SH", "920000.BJ"]
    assert calls == [1]

    # An akshare-sourced roster already contains Beijing; no second fetch.
    ak_rows = _rows(
        ("600519.SH", "贵州茅台", "equity"),
        ("920000.BJ", "安徽凤凰", "equity"),
    )
    calls.clear()
    monkeypatch.setattr(sr, "_BUILDERS", (_no_futu, lambda: ak_rows))
    assert symbols(sr.build_roster()) == ["600519.SH", "920000.BJ"]
    assert calls == []


def test_build_roster_survives_a_missing_beijing_list(
    sandbox_root: Path, monkeypatch: pytest.MonkeyPatch  # noqa: ARG001
) -> None:
    """A whole venue being unavailable beats refusing to serve anything."""

    def _explode() -> list[dict[str, Any]]:
        raise TimeoutError("akshare throttled")

    monkeypatch.setattr(
        sr,
        "_BUILDERS",
        (lambda: _rows(("600519.SH", "贵州茅台", "equity"), source="futu"),),
    )
    monkeypatch.setattr(sr, "_ak_bj_rows", _explode)

    assert symbols(sr.build_roster()) == ["600519.SH"]


def test_build_roster_deduplicates_and_sorts(
    sandbox_root: Path, monkeypatch: pytest.MonkeyPatch  # noqa: ARG001
) -> None:
    dupe = _rows(("600519.SH", "贵州茅台", "equity"), source="futu") + _rows(
        ("600519.SH", "贵州茅台B", "etf"), source="futu"
    )
    monkeypatch.setattr(sr, "_BUILDERS", (lambda: dupe,))
    monkeypatch.setattr(sr, "_ak_bj_rows", lambda: [])

    out = sr.build_roster()
    assert symbols(out) == ["600519.SH"]
    assert out[0]["name"] == "贵州茅台"  # sorted by (symbol, type) => equity first


def test_build_roster_raises_when_no_source_answers(
    sandbox_root: Path, monkeypatch: pytest.MonkeyPatch  # noqa: ARG001
) -> None:
    monkeypatch.setattr(sr, "_BUILDERS", (_no_futu, lambda: []))
    with pytest.raises(sr.RosterUnavailable, match="gateway down"):
        sr.build_roster()


def test_roster_path_is_under_the_runtime_root() -> None:
    """Guards the conftest sandbox: a stray Path.home() here would write to the
    operator's real ~/.vibe-trading from a test run."""
    assert sr.roster_path().name == "symbol_roster.json"
    assert sr.roster_path().parent == sr.get_runtime_root()
