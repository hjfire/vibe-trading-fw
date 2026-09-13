"""Tests for the ``/api/warehouse/*`` routes behind the Web warehouse page.

The warehouse's own modules are tested elsewhere; what matters on this surface is
the promise the browser builds a page out of:

* ``status`` reports the *configured* root and whether the loader switch is on,
  and it keeps listing inventory when the switch is off — the state a user needs
  to see in order to flip it;
* the commands printed on the page still parse against the real CLI parser, so a
  flag renamed there cannot keep being recommended here forever;
* the routes cannot write. On a store this suite built itself, every partition
  byte is asserted unchanged after both endpoints ran, and the module's import
  graph is parsed to prove it never reaches :mod:`backtest.warehouse.sync`;
* a newer ``schema_version`` on disk answers 409 rather than being reported as
  "no data", and an unknown interval answers 400 rather than 500.

``TUSHARE_TOKEN`` is unset, so everything here is a fixture store this suite
writes through the real gate. Nothing in this file is evidence about live data.

Loopback ``TestClient`` (127.0.0.1) bypasses dev-mode auth, matching
``test_market_symbols_route.py``.
"""

from __future__ import annotations

import hashlib
import json
import shlex
from pathlib import Path
from typing import Any

import pandas as pd
import pytest
from fastapi.testclient import TestClient

import api_server
from backtest.warehouse import store
from backtest.warehouse.layout import manifest_path
from backtest.warehouse.schema import normalize_bars

ENABLE_ENV_VAR = "VIBE_TRADING_WAREHOUSE_ENABLED"
ROOT_ENV_VAR = "VIBE_TRADING_WAREHOUSE_ROOT"

#: Ten Mon-Fri sessions, one peer and one name with a hole in the middle.
_SESSIONS = pd.bdate_range("2020-01-06", periods=10)
_PEER = "600000.SH"
_HOLLOW = "600519.SH"


def _frames(symbol: str, index: pd.DatetimeIndex) -> pd.DataFrame:
    frame = pd.DataFrame(
        {
            "open": [100.0] * len(index),
            "high": [101.0] * len(index),
            "low": [99.0] * len(index),
            "close": [100.0] * len(index),
            "volume": [1000.0] * len(index),
            "amount": [5000.0] * len(index),
            "adj_factor": [1.0] * len(index),
        },
        index=index,
    )
    frame.index.name = "trade_date"
    return frame


def _write(root: Path, symbol: str, index: pd.DatetimeIndex) -> None:
    """Push *index* through the real write gate into *root*."""
    bars, report = normalize_bars(
        _frames(symbol, index),
        symbol=symbol,
        interval="1D",
        source="tushare",
        volume_unit="lots",
        amount_unit="cny_thousand",
    )
    assert report.is_clean, f"the fixture must survive its own gate: {report.to_dict()}"
    store.write_bars(bars, interval="1D", root=root)


def _client() -> TestClient:
    return TestClient(api_server.app, client=("127.0.0.1", 50000))


@pytest.fixture(autouse=True)
def _dev_mode_auth(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("API_AUTH_KEY", raising=False)
    monkeypatch.setattr(api_server, "_API_KEY", "")


@pytest.fixture
def wh(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """A populated store, with the config layer pointed at it."""
    from src.config.accessor import reset_env_config

    root = tmp_path / "wh"
    monkeypatch.setenv(ROOT_ENV_VAR, str(root))
    monkeypatch.delenv(ENABLE_ENV_VAR, raising=False)
    reset_env_config()

    _write(root, _PEER, _SESSIONS)
    # Sessions 3-5 missing for one name: the audit's suspected-halt case.
    _write(root, _HOLLOW, _SESSIONS[[0, 1, 2, 6, 7, 8, 9]])
    # The manifest is sync's bookkeeping, not write_bars'; without it the
    # provenance half of the payload would never be exercised.
    store.write_manifest(
        source="tushare",
        markets=["a_share"],
        volume_unit="lots",
        amount_unit="cny_thousand",
        root=root,
    )
    try:
        yield root
    finally:
        reset_env_config()


def _fingerprints(root: Path) -> dict[str, str]:
    """Content hash of every file under the store, keyed by relative path."""
    out: dict[str, str] = {}
    for path in sorted(root.rglob("*")):
        if path.is_file():
            out[path.relative_to(root).as_posix()] = hashlib.sha256(
                path.read_bytes()
            ).hexdigest()
    return out


# ---------------------------------------------------------------------------
# status
# ---------------------------------------------------------------------------


def test_status_names_the_root_even_when_nothing_is_stored(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The empty state is the one a fresh install sees; it must not be an error."""
    from src.config.accessor import reset_env_config

    root = tmp_path / "fresh"
    monkeypatch.setenv(ROOT_ENV_VAR, str(root))
    reset_env_config()
    try:
        body = _client().get("/api/warehouse/status").json()
    finally:
        reset_env_config()

    assert body["status"] == "ok"
    assert body["has_data"] is False
    assert body["intervals"] == []
    assert body["totals"]["rows"] == 0
    assert str(root) in body["root"]


def test_status_lists_what_is_on_disk(wh: Path) -> None:
    body = _client().get("/api/warehouse/status").json()

    assert body["status"] == "ok"
    assert body["has_data"] is True
    assert [row["interval"] for row in body["intervals"]] == ["1D"]

    one_d = body["intervals"][0]
    assert one_d["symbols"] == 2
    assert one_d["rows"] == 17  # 10 + 7, the fixture's own arithmetic
    assert one_d["grain"] == "year"
    assert one_d["first"] == "2020-01-06"
    assert one_d["last"] == "2020-01-17"
    assert one_d["bytes"] > 0
    assert one_d["sources"] == ["tushare"]

    assert body["totals"]["rows"] == 17
    assert body["totals"]["bytes"] == one_d["bytes"]
    assert "tushare" in json.dumps(body["manifest"])


def test_status_reports_the_loader_switch_as_off_and_still_shows_data(
    wh: Path,
) -> None:
    """Disabling the loader must not hide the inventory.

    The switch gates whether a *backtest* may read the store. A user deciding
    whether to turn it on has to see what is already sitting there; an endpoint
    that answered "nothing here" while 17 rows were on disk would be lying.

    Asserts the row-level inventory, not just ``has_data``: the first version of
    this test read only ``totals``, and a mutation that blanked ``intervals``
    while leaving the arithmetic on the un-blanked local survived it — the name
    promised the thing the body did not check.
    """
    body = _client().get("/api/warehouse/status").json()

    assert body["enabled"] is False
    assert body["enable_env_var"] == ENABLE_ENV_VAR
    assert [row["interval"] for row in body["intervals"]] == ["1D"]
    assert body["intervals"][0]["rows"] == 17
    assert body["totals"]["rows"] == 17


def test_status_reflects_the_switch_when_it_is_on(
    wh: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The same inventory either way — the switch must not be a filter.

    The off-case above and this one are deliberately symmetric: checking the
    row listing on only one side of the switch leaves "hide it when enabled"
    (or the reverse) free to be written.
    """
    from src.config.accessor import reset_env_config

    monkeypatch.setenv(ENABLE_ENV_VAR, "true")
    reset_env_config()
    try:
        body = _client().get("/api/warehouse/status").json()
    finally:
        reset_env_config()

    assert body["enabled"] is True
    assert [row["interval"] for row in body["intervals"]] == ["1D"]
    assert body["intervals"][0]["rows"] == 17
    assert body["totals"]["rows"] == 17


def test_suggested_commands_parse_as_cli_arguments(wh: Path) -> None:
    """The page tells the user what to type, so that text has to be valid.

    A recommended command that argparse rejects is worse than no recommendation:
    the user reads the page as authoritative and concludes the install is broken.
    """
    from backtest.warehouse.__main__ import build_parser

    parser = build_parser()
    body = _client().get("/api/warehouse/status").json()

    for name, command in body["commands"].items():
        assert command.startswith("vibe-trading warehouse"), name
        tail = command.removeprefix("vibe-trading warehouse")
        # posix=False keeps Windows backslashes intact; the quotes it leaves
        # behind are stripped by hand.
        argv = [token.strip('"') for token in shlex.split(tail, posix=False)]
        if "--root" in argv:
            # The store's real path says nothing about whether the *command*
            # is well-formed, and on this machine it may contain anything.
            argv[argv.index("--root") + 1] = "D:/bars"
        parsed = parser.parse_args(argv)  # SystemExit here is the failure
        assert parsed.command in {"sync", "audit", "list", "sql"}, name
        if "--root" in argv:
            # Accepted *and* bound: a flag argparse swallows into a default is
            # the failure mode that keeps the printed command looking fine.
            assert parsed.root == Path("D:/bars"), name
        else:
            assert parsed.root is None, name


def test_a_root_with_a_space_is_quoted_in_the_suggested_command(tmp_path: Path) -> None:
    """One argument with a space in it has to arrive as one argument."""
    from src.api.warehouse_routes import _commands

    root = tmp_path / "My Bars" / "warehouse"
    commands = _commands(root)

    assert f'"{root}"' in commands["inventory"]
    assert f'"{root}"' in commands["health"]


def test_status_never_writes(wh: Path) -> None:
    before = _fingerprints(wh)

    _client().get("/api/warehouse/status")

    assert _fingerprints(wh) == before


# ---------------------------------------------------------------------------
# audit
# ---------------------------------------------------------------------------


def test_audit_reports_a_store_with_no_impossible_rows(wh: Path) -> None:
    r = _client().get("/api/warehouse/audit", params={"interval": "1D"})

    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert body["clean"] is True
    assert body["issues"] == []
    assert body["symbols"] == 2
    assert body["rows"] == 17


def test_audit_surfaces_suspected_halts_without_calling_them_failures(wh: Path) -> None:
    """A halt is a fact about the market; ``clean`` must stay true.

    Same contract as the CLI's exit code, which the page mirrors in a pill.
    """
    body = _client().get(
        "/api/warehouse/audit", params={"interval": "1D", "min_gap": 3}
    ).json()

    assert body["clean"] is True
    assert body["gaps_total"] >= 1
    assert {gap["symbol"] for gap in body["gaps"]} == {_HOLLOW}


def test_audit_marks_a_hand_edited_partition_dirty(wh: Path) -> None:
    """The row-level checks are the page's only claim of evidence, so they run."""
    path = next(wh.rglob("data.parquet"))
    frame = pd.read_parquet(path)
    frame.loc[frame["symbol"] == _PEER, "close"] = 0.0
    store._write_partition(path, frame, interval="1D", root=wh)

    body = _client().get("/api/warehouse/audit", params={"interval": "1D"}).json()

    codes = {issue["code"]: issue for issue in body["issues"]}
    assert "nonpositive_price" in codes, body["issues"]
    assert codes["nonpositive_price"]["severity"] == "error"
    assert body["clean"] is False


def test_audit_skips_the_gap_scan_when_asked(wh: Path) -> None:
    body = _client().get(
        "/api/warehouse/audit", params={"interval": "1D", "gaps": "false"}
    ).json()

    assert body["status"] == "ok"
    assert body["gaps"] == []


def test_audit_thins_coverage_but_says_so(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Coverage is sorted thinnest-first and capped, with the real total kept."""
    from src.config.accessor import reset_env_config

    root = tmp_path / "wide"
    monkeypatch.setenv(ROOT_ENV_VAR, str(root))
    reset_env_config()
    try:
        for i in range(25):
            _write(root, f"{600000 + i:06d}.SH", _SESSIONS[: 3 + (i % 4)])
        body = _client().get("/api/warehouse/audit", params={"interval": "1D"}).json()
    finally:
        reset_env_config()

    rows = [row["rows"] for row in body["coverage"]]
    assert body["coverage_total"] == 25
    assert len(rows) == 20
    assert rows == sorted(rows)


def test_audit_of_an_interval_that_is_not_stored_is_a_bad_request(wh: Path) -> None:
    r = _client().get("/api/warehouse/audit", params={"interval": "5m"})

    assert r.status_code == 400
    assert r.json()["status"] == "error"
    assert "5m" in r.json()["error"]


@pytest.mark.parametrize("params", [{"min_gap": 0}, {"min_gap": 253}, {"interval": ""}])
def test_out_of_range_params_are_rejected_before_any_scan(
    wh: Path, params: dict[str, Any]
) -> None:
    assert _client().get("/api/warehouse/audit", params=params).status_code == 422


# ---------------------------------------------------------------------------
# a store this build cannot read
# ---------------------------------------------------------------------------


@pytest.fixture
def future_store(wh: Path) -> Path:
    """Rewrite the manifest to declare a schema newer than this build."""
    path = manifest_path(wh)
    payload = json.loads(path.read_text(encoding="utf-8"))
    payload["schema_version"] = 99
    path.write_text(json.dumps(payload), encoding="utf-8")
    return wh


@pytest.mark.parametrize(
    "url", ["/api/warehouse/status", "/api/warehouse/audit"]
)
def test_a_newer_store_is_a_conflict_not_an_empty_warehouse(
    future_store: Path, url: str
) -> None:
    """``schema_version`` ahead of the code must be said out loud.

    Reporting it as "no data" would send the user to ``sync`` to re-download
    years of bars they already own.
    """
    r = _client().get(url)

    assert r.status_code == 409
    body = r.json()
    assert body["status"] == "error"
    assert "schema_version" in body["error"]


# ---------------------------------------------------------------------------
# auth surface
# ---------------------------------------------------------------------------


def test_every_warehouse_route_declares_require_auth() -> None:
    """Structural guard: no route in this group may skip the dependency."""
    routes = [
        route
        for route in api_server.app.routes
        if getattr(route, "path", "").startswith("/api/warehouse")
    ]

    assert len(routes) == 2
    for route in routes:
        calls = {dep.call for dep in route.dependant.dependencies}
        assert api_server.require_auth in calls, route.path


def test_route_requires_auth_for_remote_client(wh: Path, monkeypatch) -> None:
    """Local disk layout is not secret, but the API surface is uniform."""
    monkeypatch.setattr(api_server, "_API_KEY", "server-secret")
    remote = TestClient(api_server.app, client=("203.0.113.9", 51000))

    assert remote.get("/api/warehouse/status").status_code == 401
    assert remote.get("/api/warehouse/audit").status_code == 401


# ---------------------------------------------------------------------------
# read-only, structurally
# ---------------------------------------------------------------------------


def test_route_module_never_imports_sync() -> None:
    """The read-only split is an import graph, not a docstring.

    ``test_status_never_writes`` catches a write that does happen on a fixture
    store; it cannot catch the shape that makes one likely -- this module growing
    a dependency on :mod:`backtest.warehouse.sync`, whose helpers fetch, throttle,
    and rewrite partitions. Parsing the source rather than walking ``dir()`` is
    the point: a lazy ``import`` inside a handler is exactly what a later edit
    would add, and it is invisible to an attribute check on the loaded module.
    """
    import ast
    import inspect

    import src.api.warehouse_routes as warehouse_routes

    imported: set[str] = set()
    for node in ast.walk(ast.parse(inspect.getsource(warehouse_routes))):
        if isinstance(node, ast.ImportFrom):
            if node.module:
                imported.add(node.module)
                imported.update(f"{node.module}.{alias.name}" for alias in node.names)
        elif isinstance(node, ast.Import):
            imported.update(alias.name for alias in node.names)

    offenders = {name for name in imported if name.endswith(".sync") or name == "sync"}
    assert not offenders, f"the read-only page reached for the writer: {offenders}"
