"""iFinD macro-indicator tools: cache-first reads, opt-in quota spends.

Two tools rather than one with an ``action`` switch, because their costs are not
comparable: reading the local cache is free, repeatable and side-effect-free,
while one fetch burns a slice of a *finite* grant (the free iFinD MCP tier is
2000 requests in total, not per month) at 2 requests per second. Keeping them
apart is what lets the registry, the loop's repeat guard, and the agent itself
see which side of that line a call falls on.

Availability follows the split too. Reading the cache is unconditional: it needs
no key, no server and no network, so hiding it would only hide what was already
fetched. The fetch tool registers only when an MCP server that can serve
``get_edb_data`` is configured — the same shape as every other metered tool in
``src/tools/`` (``fred_macro`` checks for its key). That keeps the
credential-free registry size advertised in the READMEs stable regardless of
which operator has a grant, and it means a bundled swarm preset can grant the
free reader while the metered write stays out of every autonomous run.

Nothing in this module writes a key. The Bearer token stays in the MCP server's
``headers`` inside ``~/.vibe-trading/agent.json`` — a path outside the
repository — and is never echoed into a tool result.
"""

from __future__ import annotations

import datetime as dt
import json
import logging
from typing import Any, Mapping

from backtest.macro_regime import compute_macro_regime, load_macro_series, regime_on_date
from backtest.macro_series import (
    IfindDecodeError,
    MacroSeries,
    extract_series,
    is_fresh,
    list_cached,
    load_series,
    record_to_series,
    save_series,
)
from src.agent.tools import BaseTool

logger = logging.getLogger(__name__)

# Remote tool that answers with a table (every other iFinD data-service tool
# returns prose). Configured MCP servers may or may not whitelist it.
_EDB_REMOTE_TOOL = "get_edb_data"

# Timeline rows echoed back to the agent. Monthly gauges rarely exceed this; the
# cap exists so a decade of daily indicators cannot bloat one tool message.
_MAX_TIMELINE_ROWS = 60
_MAX_TAIL_READINGS = 240
_DEFAULT_TAIL_READINGS = 24


def _edb_server_names() -> list[str]:
    """Configured MCP servers that are allowed to serve ``get_edb_data``.

    Reads the operator config file only — no discovery round trip, since
    ``list_tools`` would spend a request for information the config already
    states.

    Returns:
        Server names, sorted, possibly empty.
    """
    from src.config.loader import load_agent_config

    try:
        servers = load_agent_config().mcp_servers or {}
    except Exception as exc:  # noqa: BLE001 - a broken config must not crash discovery
        logger.warning("macro tools could not read MCP server config: %s", exc)
        return []
    names = []
    for name, config in servers.items():
        enabled = list(getattr(config, "enabled_tools", None) or ["*"])
        allowed = any(
            pattern == "*" or str(pattern).strip() == _EDB_REMOTE_TOOL for pattern in enabled
        )
        if allowed:
            names.append(str(name))
    return sorted(names)


def _pick_server(explicit: str | None) -> tuple[str | None, str | None]:
    """Resolve which MCP server to call.

    Args:
        explicit: Caller-supplied server name, or ``None`` to auto-select.

    Returns:
        ``(server_name, error)`` — exactly one of the two is ``None``. When
        several servers could serve the tool, the one whose name mentions
        ``edb`` wins; anything past that is reported instead of guessed,
        because a guess here spends quota on the wrong endpoint.
    """
    candidates = _edb_server_names()
    if explicit:
        needle = explicit.strip()
        if needle in candidates:
            return needle, None
        return None, (
            f"MCP server {needle!r} is not configured for {_EDB_REMOTE_TOOL}. "
            f"Configured: {candidates or 'none'}"
        )
    if not candidates:
        return None, (
            f"no configured MCP server allows {_EDB_REMOTE_TOOL}. Add the iFinD "
            "data-service server under mcpServers in ~/.vibe-trading/agent.json"
        )
    if len(candidates) == 1:
        return candidates[0], None
    preferred = [name for name in candidates if "edb" in name.lower()]
    if len(preferred) == 1:
        return preferred[0], None
    return None, (
        f"several MCP servers allow {_EDB_REMOTE_TOOL}: {candidates}. "
        "Pass 'server' to choose one."
    )


def _cached_query_matches(query: str) -> tuple[str, dict[str, Any]] | None:
    """Find a cached series fetched with this exact query string, if any.

    Matched on the recorded query rather than on the indicator label, because
    the label is only known *after* the reply is decoded — which is the request
    this guard exists to avoid.
    """
    needle = query.strip()
    for row in list_cached():
        record = load_series(str(row.get("slug") or ""))
        if record and str(record.get("query") or "").strip() == needle:
            return str(row.get("slug")), record
    return None


def _series_tail(series: MacroSeries, limit: int) -> list[dict[str, Any]]:
    """Most recent readings as ``{period, usable_from, value}`` rows."""
    lag = _lag_for_series(series)
    rows: list[dict[str, Any]] = []
    for date, value in list(zip(series.dates, series.values))[-limit:]:
        try:
            usable = (dt.date.fromisoformat(date) + dt.timedelta(days=lag)).isoformat()
        except ValueError:
            usable = None
        rows.append({"period": date, "usable_from": usable, "value": value})
    return rows


def _lag_for_series(series: MacroSeries) -> int:
    """Publication lag for one cached series' frequency."""
    from backtest.macro_regime import lag_days_for

    return lag_days_for(series.freq)


def _resolve_indicators(spec: str | None) -> tuple[list[MacroSeries], list[str]]:
    """Turn a comma-separated query list into cached series.

    Returns:
        ``(series, problems)`` — a problem names a query that matched nothing,
        so a typo is reported rather than quietly shrinking the gauge.
    """
    problems: list[str] = []
    if not spec or not str(spec).strip():
        every: list[MacroSeries] = []
        for row in list_cached():
            record = load_series(str(row.get("slug") or ""))
            if record is not None:
                every.append(record_to_series(record))
        return every, []
    found: list[MacroSeries] = []
    for part in str(spec).split(","):
        needle = part.strip()
        if not needle:
            continue
        try:
            one = load_macro_series(needle)
        except ValueError as exc:  # ambiguous substring: report, do not guess
            problems.append(str(exc))
            continue
        if one is None:
            problems.append(f"no cached indicator matches {needle!r}")
            continue
        found.append(one)
    return found, problems


def _trimmed(timeline: Mapping[str, Any]) -> dict[str, Any]:
    """Shrink a full timeline to what an agent message can carry."""
    dates = list(timeline.get("dates") or [])
    keep = dates[-_MAX_TIMELINE_ROWS:]
    offset = len(dates) - len(keep)

    def _slice(key: str) -> list[Any]:
        return list(timeline.get(key) or [])[offset:]

    return {
        "dates": keep,
        "labels": _slice("labels"),
        "breadth": _slice("breadth"),
        "n_voting": _slice("n_voting"),
        "rows_total": len(dates),
        "rows_dropped": offset,
        "current": timeline.get("current"),
        "episodes": list(timeline.get("episodes") or [])[-8:],
        "indicators": list(timeline.get("indicators") or []),
        "params": timeline.get("params"),
        "warnings": list(timeline.get("warnings") or []),
    }


class ReadMacroIndicatorsTool(BaseTool):
    """Report cached macro indicators and the regime computed from them."""

    name = "read_macro_indicators"
    description = (
        "Read locally cached macro-economic indicator series (iFinD EDB) and the "
        "EXPANSION / NEUTRAL / CONTRACTION regime computed from them. Costs "
        "nothing: never contacts iFinD, no request quota is spent. The regime "
        "timeline is keyed by *availability* date (period end + publication lag), "
        "so 'what did the macro backdrop look like on 2026-05-06' is answerable "
        "without hindsight. Call fetch_macro_indicator first if the cache is "
        "empty. Example: {} for the whole cache, or "
        '{"indicators": "社会消费品零售总额, 工业增加值", "as_of": "2026-05-06"}.'
    )
    parameters = {
        "type": "object",
        "properties": {
            "indicators": {
                "type": "string",
                "description": (
                    "Comma-separated indicators to build the gauge from: an iFinD "
                    "index code (M001657195), an exact name, or a substring unique "
                    "among cached series. Omit to use every cached series."
                ),
            },
            "as_of": {
                "type": "string",
                "description": (
                    "YYYY-MM-DD. Report only what was publicly known on that date. "
                    "Omit for the latest view."
                ),
            },
            "limit": {
                "type": "integer",
                "description": (
                    f"Most recent readings to echo per indicator (1-{_MAX_TAIL_READINGS}). "
                    f"Defaults to {_DEFAULT_TAIL_READINGS}."
                ),
                "default": _DEFAULT_TAIL_READINGS,
            },
        },
        "required": [],
    }

    # Repeatable and read-only, but deliberately not ``deterministic``: a fetch
    # in the same pass can refill the cache, and an identical-args cache hit
    # would then hand back the pre-fetch answer.
    repeatable = True
    is_readonly = True

    def execute(self, **kwargs: Any) -> str:
        """Return cached indicator data and its regime, as a JSON envelope.

        Args:
            **kwargs: ``indicators`` (comma-separated queries), ``as_of``
                (YYYY-MM-DD historical view) and ``limit`` (readings per series).

        Returns:
            JSON string. On success ``{"ok": true, "quota_spent": false,
            "cached": [...], "series": [...], "regime": {...}}``; on failure
            ``{"ok": false, "error": str}``. ``regime`` is absent when fewer
            than one indicator is cached.
        """
        limit = _clamp_int(kwargs.get("limit"), _DEFAULT_TAIL_READINGS, 1, _MAX_TAIL_READINGS)
        as_of, bad_date = _parse_date(kwargs.get("as_of"))
        if bad_date:
            return _error(bad_date)

        series, problems = _resolve_indicators(kwargs.get("indicators"))
        if not series:
            return json.dumps(
                {
                    "ok": False,
                    "error": "no cached macro indicators match that request",
                    "quota_spent": False,
                    "problems": problems,
                    "cached": list_cached(),
                    "hint": "call fetch_macro_indicator to spend one request and populate the cache",
                },
                ensure_ascii=False,
                allow_nan=False,
            )

        payload: dict[str, Any] = {
            "ok": True,
            "quota_spent": False,
            "cached": list_cached(),
            "series": [
                {
                    "name": item.name,
                    "index_id": item.index_id,
                    "unit": item.unit,
                    "freq": item.freq,
                    "data_source": item.data_source,
                    "points": len(item.dates),
                    "first": item.dates[0] if item.dates else None,
                    "last": item.dates[-1] if item.dates else None,
                    "publication_lag_days": _lag_for_series(item),
                    "readings": _series_tail(item, limit),
                    "warnings": list(item.warnings),
                }
                for item in series
            ],
        }
        if problems:
            payload["problems"] = problems
        if len(series) > 1:
            payload["note"] = (
                f"the regime below is built from {len(series)} cached indicators; "
                "pass 'indicators' to narrow the gauge"
            )
        try:
            timeline = compute_macro_regime(series, now=as_of)
        except ValueError as exc:
            return _error(str(exc))
        regime = _trimmed(timeline)
        if as_of is not None:
            regime["asked_on"] = as_of.date().isoformat()
            regime["label_on_asked_date"] = regime_on_date(timeline, as_of.date().isoformat())
        payload["regime"] = regime
        return json.dumps(payload, ensure_ascii=False, allow_nan=False)


class FetchMacroIndicatorTool(BaseTool):
    """Fetch one macro indicator from iFinD EDB into the local cache."""

    name = "fetch_macro_indicator"
    description = (
        "Query iFinD's macro/industry indicator database (get_edb_data) and cache "
        "the reply locally. SPENDS ONE REQUEST from a finite quota (the free tier "
        "is 2000 requests in total at 2/second), so use it deliberately, once per "
        "indicator, and read results with read_macro_indicators afterwards. "
        "Covered: global macro, China national and provincial indicators, sector "
        "indicators, commodity volume/price/inventory data. Time ranges must be "
        "explicit (202301-202506) - relative phrasing like 'the past year' wastes "
        'the request on an ambiguous query. Example: {"query": '
        '"全国:社会消费品零售总额:当月同比（202401-202607）"}.'
    )
    parameters = {
        "type": "object",
        "properties": {
            "query": {
                "type": "string",
                "description": (
                    "Natural-language indicator request: precise term, explicit "
                    "date range, region, frequency and statistic type "
                    "(同比/环比/累计值/当月值)."
                ),
            },
            "server": {
                "type": "string",
                "description": (
                    "MCP server name when several configured servers expose "
                    f"{_EDB_REMOTE_TOOL}. Omit to auto-select the unique match."
                ),
            },
            "force": {
                "type": "boolean",
                "description": (
                    "Re-fetch even when this exact query is already cached and "
                    "fresh. Default false: a fresh cache entry is returned instead "
                    "of spending the request."
                ),
                "default": False,
            },
        },
        "required": ["query"],
    }

    # Not repeatable: the loop's duplicate-call guard is the cheapest possible
    # protection for a finite request grant.
    repeatable = False
    is_readonly = False

    @classmethod
    def check_available(cls) -> bool:
        """Register only when a configured MCP server can actually serve EDB."""
        return bool(_edb_server_names())

    def execute(self, **kwargs: Any) -> str:
        """Fetch one query, cache every series in the reply, report provenance.

        Args:
            **kwargs: ``query`` (required), ``server`` (optional MCP server name)
                and ``force`` (re-fetch a fresh cache entry).

        Returns:
            JSON string with ``quota_spent`` stating whether a request actually
            went out. A decode failure after a successful call still reports
            ``quota_spent: true`` — the grant is gone either way, and the agent
            has to know that before retrying.
        """
        query = str(kwargs.get("query") or "").strip()
        if not query:
            return _error("'query' is required and must be a non-empty string")

        server_name, server_error = _pick_server(kwargs.get("server"))
        if server_name is None:
            return _error(server_error or "no MCP server could be resolved for this query")

        if not kwargs.get("force"):
            hit = _cached_query_matches(query)
            if hit is not None:
                slug, record = hit
                if is_fresh(record):
                    return json.dumps(
                        {
                            "ok": True,
                            "quota_spent": False,
                            "cached": True,
                            "slug": slug,
                            "reason": "this exact query is already cached and fresh; pass force=true to re-fetch",
                            "fetched_at": record.get("fetched_at"),
                            "series": [record.get("name")],
                        },
                        ensure_ascii=False,
                        allow_nan=False,
                    )

        from src.config.loader import load_agent_config
        from src.tools.mcp import MCPServerAdapter

        config = (load_agent_config().mcp_servers or {}).get(server_name)
        if config is None:  # pragma: no cover - raced with a config edit
            return _error(f"MCP server {server_name!r} disappeared from the config")

        # Nobody is at the keyboard inside an agent loop: if the iFinD grant has
        # expired, fail closed with the server's own error instead of opening a
        # browser on the operator's machine halfway through a run.
        adapter = MCPServerAdapter(server_name, config, interactive_oauth=False)
        reply = adapter.call_tool(_EDB_REMOTE_TOOL, {"query": query}, local_name=self.name)
        if isinstance(reply, Mapping) and str(reply.get("status")) == "error":
            return json.dumps(
                {
                    "ok": False,
                    "quota_spent": True,
                    "error": str(reply.get("error") or "remote call failed"),
                    "server": server_name,
                    "hint": "the request was issued; check the key and the quota before retrying",
                },
                ensure_ascii=False,
                allow_nan=False,
            )

        try:
            series = extract_series(reply)
        except IfindDecodeError as exc:
            excerpt = _reply_excerpt(reply)
            return json.dumps(
                {
                    "ok": False,
                    "quota_spent": True,
                    "error": f"{str(exc)} — {excerpt}" if excerpt else str(exc),
                    "server": server_name,
                    "hint": (
                        "quota was spent even though nothing decoded; do not "
                        "retry the same query blindly"
                    ),
                },
                ensure_ascii=False,
                allow_nan=False,
            )

        if not series:
            return json.dumps(
                {
                    "ok": True,
                    "quota_spent": True,
                    "cached": False,
                    "series": [],
                    "server": server_name,
                    "note": (
                        "iFinD answered successfully with no tabular data "
                        "(the query matched no indicator). The request is spent; "
                        "rephrase rather than repeat it."
                    ),
                },
                ensure_ascii=False,
                allow_nan=False,
            )

        saved: list[dict[str, Any]] = []
        for item in series:
            path = save_series(item, query=query)
            saved.append(
                {
                    "name": item.name,
                    "slug": path.stem,
                    "index_id": item.index_id,
                    "unit": item.unit,
                    "freq": item.freq,
                    "data_source": item.data_source,
                    "points": len(item.dates),
                    "first": item.dates[0] if item.dates else None,
                    "last": item.dates[-1] if item.dates else None,
                    "publication_lag_days": _lag_for_series(item),
                    "warnings": list(item.warnings),
                    "readings": _series_tail(item, _DEFAULT_TAIL_READINGS),
                }
            )
        return json.dumps(
            {
                "ok": True,
                "quota_spent": True,
                "cached": True,
                "server": server_name,
                "series": saved,
                "next": "read_macro_indicators re-reads this without spending quota",
            },
            ensure_ascii=False,
            allow_nan=False,
        )


def _parse_date(value: Any) -> tuple[dt.datetime | None, str | None]:
    """Validate an optional ``as_of`` argument as the end of that UTC day.

    Returns:
        ``(moment, error)``. A date is read as that day's end-of-day UTC so an
        intraday call still sees everything published that day.
    """
    if value is None or not str(value).strip():
        return None, None
    text = str(value).strip()[:10]
    try:
        day = dt.date.fromisoformat(text)
    except ValueError:
        return None, f"'as_of' is not a valid YYYY-MM-DD date: {value!r}"
    return dt.datetime.combine(day, dt.time(23, 59), tzinfo=dt.timezone.utc), None


def _clamp_int(value: Any, default: int, low: int, high: int) -> int:
    """Coerce a requested count into the supported range."""
    try:
        number = int(value)
    except (TypeError, ValueError, OverflowError):
        return default
    return max(low, min(number, high))


_EXCERPT_CHARS = 160


def _reply_excerpt(reply: Any) -> str:
    """Pull the server's own words out of a reply that would not decode.

    iFinD answers an unmatched request with prose (``抱歉，本次搜索结果为空``)
    instead of a table, and the decoder correctly refuses to build a series out
    of it. Quoting the sentence back is what tells the agent to rephrase the
    query rather than repeat it — repeating costs another request.

    Args:
        reply: Whatever the MCP layer returned.

    Returns:
        A one-line excerpt, or ``""`` when the reply carries no text at all.
    """
    if isinstance(reply, str):
        text = reply
    elif isinstance(reply, Mapping):
        text = str(reply.get("text") or "")
        if not text.strip():
            for block in reply.get("content") or []:
                if isinstance(block, Mapping) and block.get("type") == "text":
                    text = str(block.get("text") or "")
                    if text.strip():
                        break
    else:
        text = str(reply or "")
    return text[:_EXCERPT_CHARS].replace("\n", " ").strip()


def _error(message: str, **extra: Any) -> str:
    """Render a failure envelope as a JSON string.

    States ``quota_spent: false`` because every call site is a refusal that
    happened *before* a request went out — an invalid argument or an unresolved
    server costs nothing, and the agent is tracking a finite grant it cannot
    observe directly. A future call site that failed after spending passes
    ``quota_spent=True`` to override.
    """
    payload: dict[str, Any] = {"ok": False, "quota_spent": False, "error": message}
    payload.update(extra)
    return json.dumps(payload, ensure_ascii=False, allow_nan=False)
