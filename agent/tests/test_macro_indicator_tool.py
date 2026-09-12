"""Tests for the iFinD macro-indicator agent tools.

The interesting property of this module is not the JSON shape — it is which
calls cost the operator part of a finite, non-renewable request grant. Every
test below therefore either pins a refusal (no request went out) or pins an
honest receipt (one did). The stub MCP adapter records whether it was ever
constructed, so "we did not spend it" is an assertion rather than a hope.

No test in this file touches the network, and none needs an iFinD key: the real
reply is a captured fixture from ``tests/fixtures/ifind/``.
"""

from __future__ import annotations

import copy
import datetime as dt
import json
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable

import pytest

from backtest.macro_regime import (
    CONTRACTION,
    EXPANSION,
    NEUTRAL,
    compute_macro_regime,
    load_macro_series,
    regime_on_date,
)
from backtest.macro_series import (
    MacroSeries,
    is_fresh,
    list_cached,
    load_series,
    save_series,
)
from src.tools.macro_indicator_tool import (
    FetchMacroIndicatorTool,
    ReadMacroIndicatorsTool,
    _pick_server,
)

_EDB_QUERY = "全国:社会消费品零售总额:当月同比（202503-202606）"
_RETAIL_NAME = "全国:社会消费品零售总额:当月同比"
_FIXTURE = Path(__file__).parent / "fixtures" / "ifind" / "edb_standard_table.json"
_SECRET = "Bearer INVALID-TEST-VALUE-NOT-A-CREDENTIAL"


@pytest.fixture(autouse=True)
def _isolated_cache(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Keep the macro cache out of the developer's real ``~/.vibe-trading``."""
    monkeypatch.setenv("VIBE_TRADING_HOME", str(tmp_path))
    return tmp_path


def _reply() -> dict[str, Any]:
    """The captured ``get_edb_data`` envelope, fresh each call so tests can edit."""
    return json.loads(_FIXTURE.read_text(encoding="utf-8"))


def _text_reply(inner: Any) -> dict[str, Any]:
    """Wrap an already-encoded iFinD body in the MCP envelope."""
    text = json.dumps(inner, ensure_ascii=False)
    return {"status": "ok", "content": [{"type": "text", "text": text}], "text": text}


def _server(tools: list[str] | None = None) -> SimpleNamespace:
    """A stand-in ``MCPServerConfig`` — only ``enabled_tools`` is read here."""
    return SimpleNamespace(
        url="https://example.invalid/mcp",
        headers={"Authorization": _SECRET},
        enabled_tools=tools if tools is not None else ["*"],
    )


@pytest.fixture
def stub_adapter(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    """Replace ``MCPServerAdapter`` with a recorder. Never builds a connection."""
    state: dict[str, Any] = {
        "reply": _reply(),
        "raises": None,
        "built": [],
        "calls": [],
    }

    class _Adapter:
        def __init__(  # noqa: ANN001
            self,
            server_name: str,
            server_config: Any,
            *,
            interactive_oauth: bool = True,
        ) -> None:
            state["built"].append(
                {"server": server_name, "interactive_oauth": interactive_oauth}
            )
            self._server = server_name

        def call_tool(  # noqa: ANN001
            self,
            remote_name: str,
            arguments: dict[str, Any],
            *,
            local_name: str | None = None,
        ) -> Any:
            state["calls"].append(
                {"remote": remote_name, "arguments": dict(arguments), "local": local_name}
            )
            if state["raises"] is not None:
                raise state["raises"]
            return copy.deepcopy(state["reply"])

    monkeypatch.setattr("src.tools.mcp.MCPServerAdapter", _Adapter)
    return state


@pytest.fixture
def configured_servers(monkeypatch: pytest.MonkeyPatch) -> Callable[..., Any]:
    """Install the operator's MCP server table for the duration of one test."""

    def _install(**servers: Any) -> dict[str, Any]:
        monkeypatch.setattr(
            "src.config.loader.load_agent_config",
            lambda: SimpleNamespace(mcp_servers=servers),
        )
        return servers

    return _install


def _series(name: str, values: list[float], *, index_id: str = "") -> MacroSeries:
    """A monthly indicator long enough to clear ``min_periods``.

    Day 28 rather than a month end: the exact day does not matter to these
    tests, and arithmetic that stays inside the month cannot roll into a
    neighbouring one and shift the availability stamps under an assertion.
    """
    dates = []
    year, month = 2025, 1
    for _ in values:
        dates.append(f"{year}-{month:02d}-28")
        year, month = (year + 1, 1) if month == 12 else (year, month + 1)
    return MacroSeries(
        name=name,
        dates=dates,
        values=list(values),
        index_id=index_id,
        unit="%",
        freq="M",
        data_source="国家统计局",
    )


def _cached_fixture(query: str = _EDB_QUERY) -> str:
    """Save the fixture reply and return its slug."""
    saved = save_series(_reply_series(), query=query)
    return saved.stem


def _reply_series() -> MacroSeries:
    """The single series the fixture reply decodes into."""
    from backtest.macro_series import extract_series

    return extract_series(_reply())[0]


# ---------------------------------------------------------------------------
# Availability
# ---------------------------------------------------------------------------


def test_the_free_reader_registers_on_a_fresh_install() -> None:
    """Reading a local cache needs no key, no server, and no network."""
    assert ReadMacroIndicatorsTool.check_available() is True


def test_the_metered_writer_stays_hidden_until_a_server_can_serve_it() -> None:
    """A quota-spending tool appears exactly when iFinD is reachable.

    Same convention ``fred_macro`` uses for its key: the credential or server
    *is* the opt-in, so there is no second switch to forget and no tool whose
    only possible answer is 'not configured'.
    """
    assert FetchMacroIndicatorTool.check_available() is False


def test_configuring_an_edb_server_makes_the_writer_available(
    configured_servers: Callable[..., Any],
) -> None:
    configured_servers(ifind=_server(["get_edb_data"]))
    assert FetchMacroIndicatorTool.check_available() is True


def test_a_server_that_cannot_serve_edb_keeps_it_hidden(
    configured_servers: Callable[..., Any],
) -> None:
    """The server must be able to answer, not merely exist."""
    configured_servers(stock=_server(["get_stock_data"]))
    assert FetchMacroIndicatorTool.check_available() is False


def test_registry_membership_on_a_fresh_install() -> None:
    """The credential-free registry size the READMEs advertise.

    ``read_macro_indicators`` is inside that count — it is free and needs no
    configuration, so the honest treatment is to count it and update the number.
    ``fetch_macro_indicator`` is outside it, like every metered tool. That split
    is also what lets a bundled swarm preset grant the reader: the honesty gate
    in ``test_preset_honesty.py`` resolves every whitelisted tool against this
    same credential-free registry.
    """
    from src.tools import build_registry

    names = set(build_registry().tool_names)
    assert "read_macro_indicators" in names
    assert "fetch_macro_indicator" not in names


def test_a_configured_operator_sees_both_tools(
    configured_servers: Callable[..., Any],
) -> None:
    from src.tools import build_registry

    configured_servers(ifind=_server(["get_edb_data"]))
    names = set(build_registry().tool_names)
    assert {"read_macro_indicators", "fetch_macro_indicator"} <= names


# ---------------------------------------------------------------------------
# Server resolution
# ---------------------------------------------------------------------------


def test_edb_allowlist_decides_which_server_is_a_candidate(
    configured_servers: Callable[..., Any]
) -> None:
    """A server that whitelisted only other tools cannot serve the query."""
    configured_servers(
        stock=_server(["get_stock_data", "get_high_frequency_data"]),
        edb=_server(["get_edb_data"]),
    )
    assert _pick_server(None) == ("edb", None)


def test_wildcard_allowlist_counts_as_edb_capable(
    configured_servers: Callable[..., Any]
) -> None:
    """``enabled_tools: ["*"]`` is how the shipped iFinD config is written."""
    configured_servers(ifind=_server(["*"]))
    assert _pick_server("ifind") == ("ifind", None)


def test_broken_config_file_degrades_to_no_servers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """An unreadable operator config is a miss, not a crash during registration."""

    def _boom() -> Any:
        raise RuntimeError("agent.json is not valid JSON")

    monkeypatch.setattr("src.config.loader.load_agent_config", _boom)

    name, error = _pick_server(None)
    assert name is None
    assert "no configured MCP server" in error


def test_unconfigured_server_name_is_rejected_with_the_real_alternatives(
    configured_servers: Callable[..., Any]
) -> None:
    """Guessing a server would spend quota on the wrong endpoint."""
    configured_servers(ifind=_server(["get_edb_data"]))
    name, error = _pick_server("wrong-one")

    assert name is None
    assert "'wrong-one'" in error
    assert "ifind" in error


def test_ambiguous_servers_are_reported_not_guessed(
    configured_servers: Callable[..., Any]
) -> None:
    """Two equally valid servers: ask, do not pick."""
    configured_servers(ifind_a=_server(["get_edb_data"]), ifind_b=_server(["*"]))

    name, error = _pick_server(None)
    assert name is None
    assert "ifind_a" in error and "ifind_b" in error
    assert "Pass 'server'" in error


def test_the_server_whose_name_says_edb_wins_the_tie(
    configured_servers: Callable[..., Any]
) -> None:
    """One unambiguous hint in a name is cheaper than a clarification round trip."""
    configured_servers(ifind=_server(["*"]), ifind_edb=_server(["get_edb_data"]))
    assert _pick_server(None) == ("ifind_edb", None)


def test_fetch_reports_an_unresolvable_server_without_spending(
    stub_adapter: dict[str, Any],
    configured_servers: Callable[..., Any],
) -> None:
    configured_servers(stock=_server(["get_stock_data"]))
    payload = json.loads(FetchMacroIndicatorTool().execute(query=_EDB_QUERY))

    assert payload["ok"] is False
    assert payload["quota_spent"] is False
    assert stub_adapter["built"] == []


# ---------------------------------------------------------------------------
# Quota accounting on the fetch path
# ---------------------------------------------------------------------------


def test_blank_query_is_refused_before_the_server_is_chosen(
    stub_adapter: dict[str, Any], configured_servers: Callable[..., Any]
) -> None:
    configured_servers(ifind=_server())
    payload = json.loads(FetchMacroIndicatorTool().execute(query="   "))

    assert payload["ok"] is False
    assert "query" in payload["error"]
    assert payload["quota_spent"] is False
    assert stub_adapter["built"] == []


def test_a_fresh_cache_hit_costs_nothing(
    stub_adapter: dict[str, Any], configured_servers: Callable[..., Any]
) -> None:
    """The cache is the quota defence: an identical query must not go out."""
    configured_servers(ifind=_server())
    slug = _cached_fixture()

    payload = json.loads(FetchMacroIndicatorTool().execute(query=_EDB_QUERY))
    assert payload["ok"] is True
    assert payload["quota_spent"] is False
    assert payload["slug"] == slug
    assert stub_adapter["built"] == []


def test_force_true_pays_for_a_query_that_is_already_cached(
    stub_adapter: dict[str, Any], configured_servers: Callable[..., Any]
) -> None:
    """Refresh is the operator's call, never the tool's default."""
    configured_servers(ifind=_server())
    _cached_fixture()

    payload = json.loads(FetchMacroIndicatorTool().execute(query=_EDB_QUERY, force=True))
    assert payload["quota_spent"] is True
    assert len(stub_adapter["built"]) == 1


def test_a_stale_cache_entry_is_refetched(
    stub_adapter: dict[str, Any],
    configured_servers: Callable[..., Any],
    tmp_path: Path,
) -> None:
    """Freshness is frequency-aware; a five-day-old monthly read is not fresh."""
    configured_servers(ifind=_server())
    slug = _cached_fixture()
    record = load_series(slug)
    assert record is not None and is_fresh(record)
    record["fetched_at"] = (dt.datetime.now(dt.timezone.utc) - dt.timedelta(days=5)).isoformat()
    tmp_path.joinpath("macro", f"{slug}.json").write_text(
        json.dumps(record, ensure_ascii=False), encoding="utf-8"
    )
    assert is_fresh(load_series(slug)) is False

    payload = json.loads(FetchMacroIndicatorTool().execute(query=_EDB_QUERY))
    assert payload["quota_spent"] is True
    assert len(stub_adapter["calls"]) == 1


def test_remote_error_is_a_spent_request(
    stub_adapter: dict[str, Any], configured_servers: Callable[..., Any]
) -> None:
    """Quota is gone the moment the call is issued, success or not."""
    configured_servers(ifind=_server())
    stub_adapter["reply"] = {"status": "error", "error": "quota exceeded", "error_type": "RuntimeError"}

    payload = json.loads(FetchMacroIndicatorTool().execute(query=_EDB_QUERY))
    assert payload["ok"] is False
    assert payload["quota_spent"] is True
    assert "quota exceeded" in payload["error"]
    assert "retrying" in payload["hint"]


def test_undecodable_reply_carries_the_servers_own_words(
    stub_adapter: dict[str, Any], configured_servers: Callable[..., Any]
) -> None:
    """A prose refusal must not read like a transport glitch.

    The decoder cannot build a series out of 抱歉, and the agent needs the
    server's phrasing to tell that apart from a malformed reply — otherwise it
    retries the same query and burns the grant again.
    """
    configured_servers(ifind=_server())
    stub_adapter["reply"] = {
        "status": "ok",
        "text": "抱歉，没有找到匹配的指标",
        "content": [{"type": "text", "text": "抱歉，没有找到匹配的指标"}],
    }

    payload = json.loads(FetchMacroIndicatorTool().execute(query=_EDB_QUERY))
    assert payload["ok"] is False
    assert payload["quota_spent"] is True
    assert "抱歉，没有找到匹配的指标" in payload["error"]


def test_success_with_zero_tables_is_honest_about_the_spend(
    stub_adapter: dict[str, Any], configured_servers: Callable[..., Any]
) -> None:
    """'No indicator matched' is a successful call: the request is spent."""
    configured_servers(ifind=_server())
    stub_adapter["reply"] = _text_reply(
        {"code": 1, "msg": "success", "data": {"answer": "抱歉，本次搜索结果为空"}}
    )

    payload = json.loads(FetchMacroIndicatorTool().execute(query=_EDB_QUERY))
    assert payload["ok"] is True
    assert payload["quota_spent"] is True
    assert payload["series"] == []
    assert list_cached() == []
    assert "rephrase" in payload["note"]


def test_successful_fetch_caches_with_provenance(
    stub_adapter: dict[str, Any], configured_servers: Callable[..., Any], tmp_path: Path
) -> None:
    configured_servers(ifind=_server())

    payload = json.loads(FetchMacroIndicatorTool().execute(query=_EDB_QUERY))
    assert payload["ok"] is True
    assert payload["quota_spent"] is True

    (entry,) = payload["series"]
    assert entry["name"] == _RETAIL_NAME
    assert entry["index_id"] == "M001657195"
    assert entry["unit"] == "%"
    assert entry["freq"] == "M"
    assert entry["data_source"] == "国家统计局"
    assert entry["points"] == 14
    assert entry["publication_lag_days"] == 18
    assert (tmp_path / "macro").is_dir()
    assert [row["slug"] for row in list_cached()] == [entry["slug"]]
    assert stub_adapter["calls"] == [
        {"remote": "get_edb_data", "arguments": {"query": _EDB_QUERY}, "local": "fetch_macro_indicator"}
    ]


def test_adapter_refuses_interactive_oauth(
    stub_adapter: dict[str, Any], configured_servers: Callable[..., Any]
) -> None:
    """An agent loop has nobody at a browser; an expired grant must fail closed."""
    configured_servers(ifind=_server())
    FetchMacroIndicatorTool().execute(query=_EDB_QUERY)

    assert stub_adapter["built"] == [{"server": "ifind", "interactive_oauth": False}]


def test_fetch_never_echoes_the_bearer_token(
    stub_adapter: dict[str, Any], configured_servers: Callable[..., Any]
) -> None:
    """The reply is pasted into an agent message; the key must not ride along."""
    configured_servers(ifind=_server())

    ok = FetchMacroIndicatorTool().execute(query=_EDB_QUERY)
    broken = FetchMacroIndicatorTool().execute(query="不存在的指标（209901-209912）")

    assert _SECRET not in ok
    assert _SECRET not in broken


def test_second_distinct_query_spends_again(
    stub_adapter: dict[str, Any], configured_servers: Callable[..., Any]
) -> None:
    """The guard is per query, not a global 'one fetch per session' lock."""
    configured_servers(ifind=_server())
    tool = FetchMacroIndicatorTool()

    first = json.loads(tool.execute(query=_EDB_QUERY))
    assert first["quota_spent"] is True
    second = json.loads(tool.execute(query="工业增加值:当月同比（202503-202606）"))
    assert second["quota_spent"] is True
    assert len(stub_adapter["calls"]) == 2


# ---------------------------------------------------------------------------
# The read path
# ---------------------------------------------------------------------------


def test_read_on_an_empty_cache_points_at_the_fetch_tool(
    stub_adapter: dict[str, Any]
) -> None:
    payload = json.loads(ReadMacroIndicatorsTool().execute())

    assert payload["ok"] is False
    assert payload["quota_spent"] is False
    assert "fetch_macro_indicator" in payload["hint"]
    assert stub_adapter["built"] == []


def test_read_costs_nothing_even_with_a_server_configured(
    stub_adapter: dict[str, Any], configured_servers: Callable[..., Any]
) -> None:
    """The cheap tool must never reach for the expensive one."""
    configured_servers(ifind=_server())
    _cached_fixture()

    payload = json.loads(ReadMacroIndicatorsTool().execute())
    assert payload["ok"] is True
    assert payload["quota_spent"] is False
    assert stub_adapter["calls"] == []


def test_read_resolves_an_index_code_and_a_substring() -> None:
    _cached_fixture()

    by_code = json.loads(ReadMacroIndicatorsTool().execute(indicators="M001657195"))
    by_words = json.loads(ReadMacroIndicatorsTool().execute(indicators="社会消费品零售"))

    assert [item["name"] for item in by_code["series"]] == [_RETAIL_NAME]
    assert [item["name"] for item in by_words["series"]] == [_RETAIL_NAME]


def test_an_ambiguous_substring_is_reported_with_its_candidates() -> None:
    """Refusing to guess is the only honest answer when two series match."""
    save_series(_series("工业:增加值:当月同比", [1, 2, 3, 4, 5, 6], index_id="M001"))
    save_series(_series("工业:增加值:累计同比", [6, 5, 4, 3, 2, 1], index_id="M002"))

    payload = json.loads(ReadMacroIndicatorsTool().execute(indicators="工业:增加值"))

    assert payload["ok"] is False
    assert payload["problems"]
    assert "M001" in payload["problems"][0] and "M002" in payload["problems"][0]


def test_a_typo_is_reported_next_to_what_did_resolve() -> None:
    """A silent shrink of the gauge would quietly change the regime."""
    _cached_fixture()

    payload = json.loads(
        ReadMacroIndicatorsTool().execute(indicators=f"{_RETAIL_NAME}, 不存在的指标")
    )
    assert payload["ok"] is True
    assert len(payload["series"]) == 1
    assert any("不存在的指标" in problem for problem in payload["problems"])


def test_read_reports_publication_lag_per_series() -> None:
    """Daily and monthly readings become public on different clocks."""
    monthly = _series(_RETAIL_NAME, [1, 2, 3, 4, 5, 6])
    daily = MacroSeries(
        name="商品房成交面积:30城:当日值",
        dates=[(dt.date(2026, 1, day)).isoformat() for day in range(1, 20)],
        values=[float(value % 5) for value in range(19)],
        unit="万平方米",
        freq="D",
    )
    save_series(monthly)
    save_series(daily)

    payload = json.loads(ReadMacroIndicatorsTool().execute())
    lags = {item["name"]: item["publication_lag_days"] for item in payload["series"]}

    assert lags[_RETAIL_NAME] == 18
    assert lags["商品房成交面积:30城:当日值"] == 1


def test_read_echoes_tail_readings_keyed_by_availability_date() -> None:
    """Every row says when it could first be known, not just what it says."""
    _cached_fixture()

    payload = json.loads(ReadMacroIndicatorsTool().execute(limit=3))
    readings = payload["series"][0]["readings"]

    assert len(readings) == 3
    assert [row["period"] for row in readings] == ["2026-04-30", "2026-05-31", "2026-06-30"]
    assert [row["usable_from"] for row in readings] == [
        "2026-05-18", "2026-06-18", "2026-07-18"
    ]


def test_read_rejects_a_malformed_as_of() -> None:
    _cached_fixture()
    payload = json.loads(ReadMacroIndicatorsTool().execute(as_of="2026年5月6日"))

    assert payload["ok"] is False
    assert "as_of" in payload["error"]


def test_read_clamps_an_absurd_limit() -> None:
    """A request for a million rows must not bloat the agent's context."""
    save_series(_series(_RETAIL_NAME, [float(step) for step in range(400)]))

    payload = json.loads(ReadMacroIndicatorsTool().execute(limit=10**6))
    assert len(payload["series"][0]["readings"]) == 240

    smallest = json.loads(ReadMacroIndicatorsTool().execute(limit=-5))
    assert len(smallest["series"][0]["readings"]) == 1


def test_read_trims_a_long_timeline_and_says_how_much(
    monkeypatch: pytest.MonkeyPatch
) -> None:
    """The cap is reported, so a truncated history cannot read as a complete one."""
    monkeypatch.setattr("src.tools.macro_indicator_tool._MAX_TIMELINE_ROWS", 5)
    _cached_fixture()
    save_series(_series("固定资产投资:累计同比", [float(step) for step in range(30)]))

    regime = json.loads(ReadMacroIndicatorsTool().execute())["regime"]
    assert len(regime["dates"]) == 5
    assert regime["rows_total"] > 5
    assert regime["rows_dropped"] == regime["rows_total"] - 5
    assert len(regime["labels"]) == 5


def test_as_of_view_agrees_with_the_full_timeline() -> None:
    """The causal guarantee, checked through the tool rather than the unit.

    Rebuilding the gauge with ``now=`` set must reproduce exactly the label the
    complete timeline already assigned to that date — otherwise the historical
    view would be re-decided by data published after it.
    """
    _cached_fixture()
    save_series(_series("工业增加值:当月同比", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))
    save_series(_series("固定资产投资:累计同比", [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]))

    every = [load_macro_series(name) for name in (_RETAIL_NAME, "工业增加值:当月同比", "固定资产投资:累计同比")]
    full = compute_macro_regime([item for item in every if item is not None])
    assert full["labels"], "the fixture gauge should produce a timeline"

    checked = 0
    for stamp in full["dates"][::3]:
        payload = json.loads(ReadMacroIndicatorsTool().execute(as_of=stamp))
        assert payload["ok"] is True, payload
        assert payload["regime"]["asked_on"] == stamp
        assert payload["regime"]["label_on_asked_date"] == regime_on_date(full, stamp)
        assert payload["regime"]["current"]["date"] <= stamp
        checked += 1
    assert checked >= 3


def test_read_labels_are_the_three_regime_names() -> None:
    _cached_fixture()
    save_series(_series("工业增加值:当月同比", [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))
    save_series(_series("固定资产投资:累计同比", [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]))

    regime = json.loads(ReadMacroIndicatorsTool().execute())["regime"]
    allowed = {EXPANSION, NEUTRAL, CONTRACTION}

    assert set(regime["labels"]) <= allowed
    assert regime["current"]["label"] in allowed
    # The index is availability-dated, and the payload has to say so: a reader
    # who mistakes it for a period-dated series will join it a month early.
    assert regime["params"]["index_meaning"] == (
        "availability date (period end + publication lag)"
    )


def test_read_states_when_the_gauge_is_too_shallow_to_trust() -> None:
    """One indicator is a coin flip, and the tool has to say so out loud."""
    _cached_fixture()

    regime = json.loads(ReadMacroIndicatorsTool().execute())["regime"]
    assert any("coin flip" in warning for warning in regime["warnings"])


# ---------------------------------------------------------------------------
# Contract flags and wording
# ---------------------------------------------------------------------------


def test_cost_flags_separate_the_two_tools() -> None:
    """Read is safe to repeat; a fetch is not, and the loop must know which."""
    reader = ReadMacroIndicatorsTool()
    fetcher = FetchMacroIndicatorTool()

    assert (reader.repeatable, reader.is_readonly, reader.deterministic) == (True, True, False)
    assert (fetcher.repeatable, fetcher.is_readonly, fetcher.deterministic) == (False, False, False)


def test_fetch_description_states_the_grant_is_finite() -> None:
    """The warning is in the tool schema, not in a doc nobody reads at call time."""
    text = FetchMacroIndicatorTool().description

    assert "2000" in text
    assert "SPENDS ONE REQUEST" in text
    assert "explicit" in text.lower()


def test_read_description_promises_it_does_not_call_out() -> None:
    text = ReadMacroIndicatorsTool().description

    assert "never contacts iFinD" in text
    assert "quota" in text.lower()


def test_both_tools_declare_required_arguments_only_where_they_must() -> None:
    assert ReadMacroIndicatorsTool().parameters["required"] == []
    assert FetchMacroIndicatorTool().parameters["required"] == ["query"]


def test_every_envelope_states_whether_it_spent_quota(
    stub_adapter: dict[str, Any], configured_servers: Callable[..., Any]
) -> None:
    """No caller should have to infer the ledger from the presence of a field."""
    configured_servers(ifind=_server())
    tool = FetchMacroIndicatorTool()
    outcomes = [
        tool.execute(query=""),  # refused: no query
        tool.execute(query=_EDB_QUERY),  # cache miss: spends
        tool.execute(query=_EDB_QUERY),  # now cached and fresh: free
    ]

    assert [json.loads(out)["quota_spent"] for out in outcomes] == [False, True, False]
    assert json.loads(ReadMacroIndicatorsTool().execute())["quota_spent"] is False
    assert json.loads(ReadMacroIndicatorsTool().execute(as_of="nonsense"))["quota_spent"] is False
