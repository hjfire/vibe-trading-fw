"""Local bar-warehouse HTTP routes for the Web ``/warehouse`` page.

Local custom ㊱: the warehouse had a CLI and no front door -- the "找不到新功能"
complaint again, one layer down.

Mounted by ``agent/api_server.py`` via ``register_warehouse_routes(app)``.

Routes (auth via the caller-supplied ``require_auth`` dependency):

* ``GET /api/warehouse/status`` — where the store lives, whether it is switched
  on, and what is actually on disk.
* ``GET /api/warehouse/audit`` — one health pass over one stored interval.

Both are **read-only by construction**: this module imports nothing from
:mod:`backtest.warehouse.sync` and issues no writes, so a browser cannot fill or
damage the store through it. Filling it stays a CLI act (``vibe-trading
warehouse sync``), which is the right split -- a sync is a minutes-long,
rate-limited, credentialed job, and the Web layer has no business starting one
behind a GET request. The page's job is to answer "what do I have, is it
trustworthy, and what do I run next".

Path prefix note: these live under ``/api/`` rather than ``/warehouse``, so the
SPA route never competes with an endpoint. The two shapes of collision worth
knowing: ``/correlation`` is a page path *and* a registered GET route, so the
404-based SPA fallback in :mod:`src.api.spa` can never reach it and
``helpers.py`` has to name it in ``_SPA_HTML_EXACT_PATHS``; ``/options`` is only
a prefix overlap (``/options/payoff``, ``/options/chain``), so it needs the dev
proxy's ``Accept: text/html`` bypass but no such exemption, because ``GET
/options`` does 404. Under ``/api/`` neither applies and no new dev-proxy prefix
is needed either.

The audit is not run by :func:`status`: the halt scan walks every partition of
the interval it is handed, which is far too slow to repeat on every page load.
The browser asks for it explicitly.
"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import Any, Awaitable, Callable

from fastapi import Depends, FastAPI, Query
from fastapi.responses import JSONResponse

logger = logging.getLogger(__name__)

AuthDep = Callable[..., Awaitable[Any] | Any]

#: Quoted verbatim in the payload so the fix is copy-pasteable, the same way
#: :data:`backtest.warehouse.loader.ENABLE_ENV_VAR` does for the loader.
ENABLE_ENV_VAR = "VIBE_TRADING_WAREHOUSE_ENABLED"

#: How many rows of a per-symbol list the browser is sent. The CLI prints 12;
#: a panel of 300 rows is not what a dashboard is for, and the thinnest coverage
#: is the part worth looking at.
_MAX_COVERAGE_ROWS = 20
_MAX_GAP_ROWS = 100


def _commands(root: Path) -> dict[str, str]:
    """The copy-pasteable next steps, in packaged-CLI form.

    These strings are pinned against the real parser by
    ``test_suggested_commands_parse_as_cli_arguments`` -- a command that has
    drifted from ``backtest/warehouse/__main__.py`` would otherwise sit here
    looking authoritative forever, which is worse than printing nothing.
    """
    where = str(root)
    if " " in where:
        # Quoted so the line stays one argument in PowerShell and POSIX shells
        # alike; a Windows profile path with a space in it is common enough that
        # ignoring it would print a command that cannot be pasted back.
        where = f'"{where}"'
    return {
        "fill": "vibe-trading warehouse sync --universe csi300 --years 10",
        "fill_symbols": "vibe-trading warehouse sync --symbols 600519.SH --years 10",
        "inventory": f"vibe-trading warehouse --root {where} list",
        "health": f"vibe-trading warehouse --root {where} audit --interval 1D --min-gap 3",
    }


def _status_sync() -> dict[str, Any]:
    """Blocking part of ``GET /api/warehouse/status`` (runs off the loop)."""
    from backtest.warehouse import audit as audit_mod
    from backtest.warehouse import store
    from backtest.warehouse.layout import warehouse_enabled, warehouse_root

    root = warehouse_root()
    try:
        intervals = audit_mod.summarize_intervals(root)
    except store.WarehouseSchemaMismatch:
        # Not this build's data format. Surfaced, not swallowed: the operator
        # needs to know the store is there and unreadable, not that it is empty.
        raise
    except Exception as exc:  # noqa: BLE001 - disk is the failure domain here
        logger.exception("warehouse inventory failed for %s", root)
        raise RuntimeError(f"cannot read the warehouse at {root}: {exc}") from exc

    manifest: dict[str, Any] = {}
    try:
        manifest = store.read_manifest(root) or {}
    except store.WarehouseSchemaMismatch:
        raise
    except Exception as exc:  # noqa: BLE001 - an unreadable manifest is not fatal
        logger.warning("warehouse manifest unreadable (%s): %s", root, exc)

    # ``summarize_intervals`` counts symbols per interval, so a name stored at
    # two grains would be counted twice here. That is intended: this total is a
    # glance-value readout of "how much did I store", not a universe.
    totals = {
        "symbols": sum(row["symbols"] for row in intervals),
        "rows": sum(row["rows"] for row in intervals),
        "partitions": sum(row["partitions"] for row in intervals),
        "bytes": sum(row["bytes"] for row in intervals),
        "first": min((row["first"] for row in intervals if row["first"]), default=None),
        "last": max((row["last"] for row in intervals if row["last"]), default=None),
    }
    try:
        universes = store.list_universes(root)
    except Exception as exc:  # noqa: BLE001 - roster listing is a bonus, not a promise
        logger.warning("warehouse universe listing failed: %s", exc)
        universes = []

    return {
        "status": "ok",
        # The switch gates the *loader* (whether backtests may read the store),
        # never this readout -- a disabled warehouse with data on disk is exactly
        # the state a user needs to see in order to flip the switch.
        "enabled": warehouse_enabled(),
        "enable_env_var": ENABLE_ENV_VAR,
        "root": str(root),
        "root_exists": root.is_dir(),
        "has_data": bool(intervals),
        "intervals": intervals,
        "totals": totals,
        "universes": universes,
        "manifest": {
            key: manifest.get(key)
            for key in ("schema_version", "created_at", "updated_at", "sources")
        },
        "commands": _commands(root),
    }


def _audit_sync(
    *,
    interval: str,
    min_sessions: int,
    check_gaps: bool,
    symbols: list[str] | None,
) -> dict[str, Any]:
    """Blocking part of ``GET /api/warehouse/audit`` (runs off the loop)."""
    from backtest.warehouse import audit as audit_mod

    report = audit_mod.audit(
        interval=interval,
        min_sessions=min_sessions,
        symbols=symbols or None,
        check_gaps=check_gaps,
    )
    payload = report.to_dict()
    coverage = sorted(payload["coverage"], key=lambda row: row["rows"])
    payload["coverage_total"] = len(coverage)
    payload["coverage"] = coverage[:_MAX_COVERAGE_ROWS]
    payload["gaps_total"] = len(payload["gaps"])
    payload["gaps"] = payload["gaps"][:_MAX_GAP_ROWS]
    payload["status"] = "ok"
    return payload


def register_warehouse_routes(app: FastAPI, require_auth: AuthDep | None = None) -> None:
    """Mount the warehouse read-only routes onto ``app`` (market_routes pattern)."""
    if require_auth is None:
        import sys as _sys

        host = _sys.modules.get("api_server") or _sys.modules.get("agent.api_server")
        if host is None:  # pragma: no cover - only triggers on weird import setups
            raise RuntimeError(
                "register_warehouse_routes: api_server module not in sys.modules; "
                "pass require_auth explicitly"
            )
        require_auth = host.require_auth

    @app.get("/api/warehouse/status", dependencies=[Depends(require_auth)])
    async def warehouse_status() -> JSONResponse:
        """Inventory, config state and next commands for the local bar store."""
        from backtest.warehouse import store

        try:
            return JSONResponse(await asyncio.to_thread(_status_sync))
        except store.WarehouseSchemaMismatch as exc:
            # The store on disk is newer than this build understands. Retrying
            # after upgrading is the fix, so this is a state conflict, not a
            # client error and not something to hide behind a generic 500.
            return JSONResponse(
                {"status": "error", "error": str(exc)}, status_code=409
            )
        except RuntimeError as exc:
            return JSONResponse({"status": "error", "error": str(exc)}, status_code=500)
        except Exception as exc:  # noqa: BLE001 - the page must render an error, not hang
            logger.exception("warehouse status route failed")
            return JSONResponse(
                {"status": "error", "error": f"{type(exc).__name__}: {exc}"},
                status_code=500,
            )

    @app.get("/api/warehouse/audit", dependencies=[Depends(require_auth)])
    async def warehouse_audit(
        interval: str = Query("1D", min_length=1, max_length=8),
        min_gap: int = Query(3, ge=1, le=252, description="shortest missing run to report"),
        gaps: bool = Query(True, description="false skips the halt scan (whole-store checks only)"),
        symbols: str = Query("", max_length=4000, description="comma-separated names to narrow the scan"),
    ) -> JSONResponse:
        """One health pass: impossible rows, suspected halts, thin coverage."""
        from backtest.warehouse import audit as audit_mod
        from backtest.warehouse import store

        wanted = [part.strip() for part in symbols.split(",") if part.strip()]
        try:
            payload = await asyncio.to_thread(
                _audit_sync,
                interval=interval,
                min_sessions=min_gap,
                check_gaps=gaps,
                symbols=wanted,
            )
        except store.WarehouseSchemaMismatch as exc:
            return JSONResponse({"status": "error", "error": str(exc)}, status_code=409)
        except audit_mod.WarehouseAuditError as exc:
            # "no such interval stored" / "nothing to audit yet" is the operator
            # asking for a pass over data that is not there: a bad request.
            return JSONResponse({"status": "error", "error": str(exc)}, status_code=400)
        except Exception as exc:  # noqa: BLE001 - DuckDB surfaces many failure modes
            logger.exception("warehouse audit route failed")
            return JSONResponse(
                {"status": "error", "error": f"{type(exc).__name__}: {exc}"},
                status_code=500,
            )
        return JSONResponse(payload)


__all__ = ["register_warehouse_routes", "ENABLE_ENV_VAR"]
