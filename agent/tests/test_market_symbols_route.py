"""Tests for GET /market/symbols — the type-ahead route (local custom ㉓).

The roster layer itself is tested in ``test_symbol_roster.py``; what matters
here is the route's promise to the browser:

* it never builds the index inline (a cold build is 17-20 s of gateway calls,
  which on a keystroke path would freeze the input box);
* a cold index answers ``status: "warming"`` and keeps searching nothing;
* a stale-but-usable index answers normally while a rebuild happens off-thread.

``src.symbol_roster`` is monkeypatched at the module the route imports it from
(the handler does ``from src import symbol_roster`` per request, so patching the
module attributes is what the handler actually sees), which keeps FutuOpenD and
akshare out of the suite entirely.

Loopback ``TestClient`` (127.0.0.1) bypasses dev-mode auth, matching the
convention in ``test_options_routes.py``.
"""

from __future__ import annotations

from typing import Any

import pytest
from fastapi.testclient import TestClient

import api_server
from src import symbol_roster

_ROW: dict[str, Any] = {"symbol": "600519.SH", "name": "贵州茅台", "market": "SH", "type": "equity"}


def _client() -> TestClient:
    return TestClient(api_server.app, client=("127.0.0.1", 50000))


@pytest.fixture(autouse=True)
def _dev_mode_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("API_AUTH_KEY", raising=False)
    monkeypatch.setattr(api_server, "_API_KEY", "")


@pytest.fixture
def spy(monkeypatch: pytest.MonkeyPatch) -> dict[str, list[Any]]:
    """Record every roster call the route makes, with sane default answers."""
    calls: dict[str, list[Any]] = {"peek": [], "warm": [], "search": [], "build": []}

    def _peek(*, max_age_s: float = symbol_roster.DEFAULT_MAX_AGE_S):  # noqa: ARG001
        calls["peek"].append(max_age_s)
        return list(_STATE["rows"]), _STATE["stale"]

    def _warm(*, force: bool = False) -> bool:
        calls["warm"].append(force)
        return True

    def _search(query: str, *, limit: int = 10, rows=None, load: bool = True):  # noqa: ARG001
        calls["search"].append({"q": query, "limit": limit, "load": load})
        return list(_STATE["hits"])

    def _building() -> bool:
        calls["build"].append(True)
        return False

    _STATE: dict[str, Any] = {"rows": [_ROW], "stale": False, "hits": [_ROW]}

    monkeypatch.setattr(symbol_roster, "peek_roster", _peek)
    monkeypatch.setattr(symbol_roster, "start_warmup", _warm)
    monkeypatch.setattr(symbol_roster, "search", _search)
    monkeypatch.setattr(symbol_roster, "is_building", _building)
    calls["state"] = _STATE  # type: ignore[assignment]
    return calls


# ── warm index ──────────────────────────────────────────────────────────────


def test_ready_index_returns_candidates(spy: dict[str, list[Any]]) -> None:
    r = _client().get("/market/symbols", params={"q": "茅台"})

    assert r.status_code == 200
    body = r.json()
    assert body == {"status": "ok", "ready": True, "results": [_ROW], "count": 1}
    # The keystroke path must never be allowed to trigger a synchronous build.
    assert spy["search"][0]["load"] is False


def test_query_and_limit_are_passed_through(spy: dict[str, list[Any]]) -> None:
    r = _client().get("/market/symbols", params={"q": "600", "limit": 3})

    assert r.status_code == 200
    assert spy["search"][0] == {"q": "600", "limit": 3, "load": False}


def test_empty_query_is_valid_and_answers_ok(spy: dict[str, list[Any]]) -> None:
    spy["state"]["hits"] = []  # type: ignore[index]

    r = _client().get("/market/symbols")

    assert r.status_code == 200
    assert r.json()["status"] == "ok"
    assert r.json()["results"] == []
    assert spy["warm"] == []  # nothing to warm on a fresh index


# ── cold index ──────────────────────────────────────────────────────────────


def test_cold_index_warms_instead_of_blocking(
    spy: dict[str, list[Any]]
) -> None:
    """The contract the UI depends on: a first call is instant, not 17-20 s."""
    spy["state"]["rows"] = []  # type: ignore[index]
    spy["state"]["stale"] = True  # type: ignore[index]

    r = _client().get("/market/symbols", params={"q": "600"})

    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "warming"
    assert body["ready"] is False
    assert body["results"] == []
    assert body["building"] is True
    assert spy["warm"] == [False]
    assert spy["search"] == []  # nothing to search yet, so nothing is scanned


# ── stale index ─────────────────────────────────────────────────────────────


def test_stale_index_still_answers_and_kicks_a_rebuild(
    spy: dict[str, list[Any]]
) -> None:
    """Serving yesterday's listing catalog beats serving nothing."""
    spy["state"]["stale"] = True  # type: ignore[index]

    r = _client().get("/market/symbols", params={"q": "茅台"})

    assert r.status_code == 200
    assert r.json()["status"] == "ok"
    assert r.json()["count"] == 1
    assert spy["warm"] == [False]  # rebuilt in the background
    assert len(spy["search"]) == 1  # ...without delaying the answer


def test_refresh_param_forces_a_rebuild(spy: dict[str, list[Any]]) -> None:
    r = _client().get("/market/symbols", params={"q": "600", "refresh": "true"})

    assert r.status_code == 200
    assert r.json()["status"] == "ok"
    assert spy["warm"] == [True]


def test_refresh_on_a_cold_index_reports_warming(spy: dict[str, list[Any]]) -> None:
    spy["state"]["rows"] = []  # type: ignore[index]

    r = _client().get("/market/symbols", params={"refresh": "true"})

    assert r.json()["status"] == "warming"
    assert spy["warm"] == [True]


# ── parameter validation and auth ───────────────────────────────────────────


@pytest.mark.parametrize("params", [{"limit": 0}, {"limit": 51}, {"q": "x" * 33}])
def test_out_of_range_params_are_rejected_before_any_work(
    spy: dict[str, list[Any]], params: dict[str, Any]
) -> None:
    r = _client().get("/market/symbols", params=params)

    assert r.status_code == 422
    assert spy["search"] == []
    assert spy["warm"] == []


def test_route_requires_auth_for_remote_client(monkeypatch: pytest.MonkeyPatch) -> None:
    """The roster is not secret, but the API surface is uniform."""
    monkeypatch.setattr(api_server, "_API_KEY", "server-secret")
    remote = TestClient(api_server.app, client=("203.0.113.9", 51000))

    assert remote.get("/market/symbols", params={"q": "600"}).status_code == 401
