"""Local symbol roster: a code + name index the UI can type against.

Why a roster at all
-------------------
The agent already has :mod:`src.tools.symbol_search_tool`, but measured against
this machine it cannot serve a type-ahead box (2026-09-06, same code path the
tool exposes to the LLM):

* ``query="茅台"`` -> **0 candidates**. Eastmoney's suggest endpoint is the only
  source that speaks Chinese and it answers every request here with a non-JSON
  body (residential-IP risk control, the same failure the a-stock-data project
  documents for ``search-api-web``), while Yahoo refuses non-ASCII outright.
* ``query="00700"`` -> a Taiwan ETF, **not Tencent**. Yahoo ranks by text
  relevance, not by code prefix, so the instrument the user typed is absent.
* ``query="600"`` -> iShares Euro.600 ETFs plus one A-share out of 5 000.
* Latency 380-2 300 ms per keystroke, jittery.

A type-ahead needs sub-100 ms answers, prefix semantics and Chinese names, so
it gets its own index instead of a remote suggestion round-trip.

Where the rows come from
------------------------
``OpenQuoteContext.get_stock_basicinfo()`` on the operator's own FutuOpenD. It
is the only roster that is fast, complete, Chinese-named and free of public
IP throttling. Measured on the live gateway (v10.10.7008):

    SZ STOCK 2 967 (629 ms)   SH STOCK 2 380 (633 ms)
    HK STOCK 3 777 (674 ms)   US STOCK 13 046 (1 543 ms)
    SH IDX 321 / SZ IDX 400 / HK IDX 203 / US IDX 537
    SZ ETF 1 417 / SH ETF 1 709 / HK ETF 445 / US ETF 6 248

with ``SH.600519 -> 贵州茅台``, ``HK.00700 -> 腾讯控股``, ``US.AAPL -> 苹果``.
It is a listing catalog, not market data: no quote subscription and no K-line
quota is consumed, so the account's 0/1 000 history allowance is untouched.

Futu has no Beijing listing, so 北交所 comes from
``akshare.stock_info_bj_name_code()``; if the gateway is down the whole roster
degrades to A-shares-only from akshare, and if that fails too the caller gets an
empty index and the UI falls back to free-text entry.
"""

from __future__ import annotations

import json
import logging
import os
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

from src.config.paths import get_runtime_root

logger = logging.getLogger(__name__)

#: Symbol types fetched per market, in the order a tie should resolve.
_FUTU_KINDS: tuple[tuple[str, str], ...] = (
    ("STOCK", "equity"),
    ("ETF", "etf"),
    ("IDX", "index"),
)

#: Futu ``Market.<attr>`` paired with the project's own venue suffix.
_FUTU_MARKETS: tuple[tuple[str, str], ...] = (
    ("SH", "SH"),
    ("SZ", "SZ"),
    ("HK", "HK"),
    ("US", "US"),
)

#: A roster is a listing catalog; new listings appear weekly at worst.
DEFAULT_MAX_AGE_S = 7 * 24 * 3600.0

#: Rows kept per rendered candidate list; the UI shows a scrollable slice.
DEFAULT_LIMIT = 10
MAX_LIMIT = 50

#: Below this many characters a bare number matches a large fraction of the
#: market, which is noise rather than help (``5`` -> every 5xxxxx code).
MIN_QUERY_CHARS = 1

_LOCK = threading.RLock()
#: Process cache so the picker does not re-read the JSON file per keystroke.
_MEM: dict[str, Any] = {"rows": None, "loaded_at": 0.0, "generations": 0}
#: Single-flight guard for :func:`start_warmup` (a list, so the flag is
#: mutable under the lock without a global statement).
_BUILD_LOCK = threading.Lock()
_BUILDING = [False]


class RosterUnavailable(RuntimeError):
    """Raised when no source could produce a roster at all."""


def roster_path() -> Path:
    """Return the JSON file holding the cached roster."""
    return get_runtime_root() / "symbol_roster.json"


# --------------------------------------------------------------------------- #
# symbol normalisation
# --------------------------------------------------------------------------- #

_FUTU_CODE_RE = re.compile(r"^(SH|SZ|HK|US)\.([A-Za-z0-9][A-Za-z0-9.&\-]*)$")


def from_futu_code(code: str) -> str | None:
    """Convert a Futu ``MARKET.CODE`` into the project's suffix convention.

    Inverse of ``backtest.loaders.futu._to_futu_symbol``, including that
    function's zero-padding: Hong Kong codes come back as five digits
    (``HK.00700`` -> ``00700.HK``) and A-share codes as six, which is what the
    loaders, the chart and ``_FUTU_ROUTABLE_RE`` all accept.

    Args:
        code: A Futu instrument code such as ``SH.600519``.

    Returns:
        The project symbol, or ``None`` when the code is not a market-prefixed
        form we know how to rewrite (a bare ``US.``, an empty or punctuated
        body, or an unexpected market).
    """
    matched = _FUTU_CODE_RE.match((code or "").strip().upper())
    if not matched:
        return None
    market, raw = matched.group(1), matched.group(2).strip()
    if not raw:
        return None
    if market in ("SH", "SZ"):
        return f"{raw.zfill(6)}.{market}"
    if market == "HK":
        return f"{raw.zfill(5)}.HK"
    # US tickers carry no padding, and a Futu US code can be an ISIK-style
    # identifier (``US.2578256D``) for non-listed instruments; those are not
    # chartable symbols in this project, so they are dropped by the caller's
    # shape check rather than guessed at here.
    return f"{raw}.US"


def to_bare_code(symbol: str) -> str:
    """Split ``600519.SH`` into ``600519`` for prefix matching."""
    return symbol.split(".", 1)[0] if "." in symbol else symbol


def market_of(symbol: str) -> str:
    """Return the venue suffix (``SH``/``SZ``/``HK``/``US``/``BJ``)."""
    return symbol.rsplit(".", 1)[1].upper() if "." in symbol else ""


def _clean_name(name: str) -> str:
    """Squeeze exchange padding out of a security short name.

    Shenzhen publishes ``万  科Ａ`` with embedded padding, and the full-width
    space ``\\u3000`` is not removed by a plain ``strip()``; leaving either in
    means a user typing ``万科`` misses the name-prefix tier. The full-width
    latin letters are folded to ASCII so ``万科A`` matches too.
    """
    text = re.sub(r"[\s\u3000]+", "", name)
    return text.replace("Ａ", "A").replace("Ｂ", "B")


def _a_share_suffix(code: str) -> str:
    """Map a six-digit mainland code onto its venue suffix.

    ``920`` is the Beijing Stock Exchange's newer segment and starts with a 9,
    which is otherwise Shanghai's — testing the first character alone would
    route those symbols to ``.SH`` and every loader downstream would reject
    them.
    """
    if code.startswith("92") or code[:1] in ("4", "8"):
        return "BJ"
    if code[:1] in ("6", "5", "9"):
        return "SH"
    return "SZ"


def _is_noise_code(symbol: str) -> bool:
    """Whether *symbol* is a placeholder rather than a tradable listing.

    The Shanghai and Shenzhen catalogs both carry transient seven-digit codes
    (配股 / 新股申购 / 增发 / 转债配售 — ``700057`` 象屿配股) in the same
    ``get_stock_basicinfo`` response as real equities. No ordinary share uses a
    leading ``7`` on either exchange, so the whole block is dropped: leaving it
    in means a user typing ``00700`` is offered a rights issue they cannot buy.
    """
    market = market_of(symbol)
    code = to_bare_code(symbol)
    if market in ("SH", "SZ"):
        return code[:1] == "7"
    return False


def _is_chartable(symbol: str) -> bool:
    """Whether *symbol* is a form the data layer can actually be asked for.

    Filters the non-symbol rows that appear inside a Futu listing response
    (ISIK-coded US instruments, blank names, delisted shells) instead of
    shipping candidates that fail as soon as they are selected.

    The Hong Kong width is capped at five digits because the six-digit block
    is not listings at all: measured on the live gateway (2026-09-06), all 750
    of them are ``81xxxx`` rows named ``…(临时代码)`` with ``lot_size`` 0 —
    temporary counters for issues that have not started normal trading.
    """
    return bool(
        re.fullmatch(
            r"(?:\d{6}\.(?:SH|SZ|BJ)|[A-Z][A-Z0-9.&\-]{0,9}\.US|\d{1,5}\.HK)",
            symbol,
        )
        and not _is_noise_code(symbol)
    )


# --------------------------------------------------------------------------- #
# source builders
# --------------------------------------------------------------------------- #


def _row(symbol: str, name: str, kind: str, source: str) -> dict[str, Any]:
    return {
        "symbol": symbol,
        "name": (name or "").strip(),
        "market": market_of(symbol),
        "type": kind,
        "source": source,
    }


def _futu_rows() -> list[dict[str, Any]]:
    """Pull the whole listing catalog from the operator's FutuOpenD.

    Raises:
        Exception: Whatever the SDK or gateway raises; the caller treats any
            failure as "fall back to the public roster".
    """
    from futu import Market, OpenQuoteContext, SecurityType  # noqa: PLC0415 — optional dep

    from backtest.loaders import futu_gateway  # noqa: PLC0415

    host, port = futu_gateway.gateway_target()
    if not host or not port:
        raise RosterUnavailable("futu gateway is not configured")

    ctx = OpenQuoteContext(host=host, port=int(port))
    rows: list[dict[str, Any]] = []
    try:
        for market_attr, suffix in _FUTU_MARKETS:
            market = getattr(Market, market_attr, None)
            if market is None:  # SDK renamed the enum: skip, never guess
                logger.warning("futu SDK has no Market.%s; skipping that venue", market_attr)
                continue
            for type_attr, kind in _FUTU_KINDS:
                stock_type = getattr(SecurityType, type_attr, None)
                if stock_type is None:
                    logger.warning("futu SDK has no SecurityType.%s", type_attr)
                    continue
                ret, df = ctx.get_stock_basicinfo(market, stock_type=stock_type)
                if ret != 0:
                    # A denied market must not abort the venues that did answer.
                    logger.warning("futu basicinfo %s/%s returned %s", market_attr, type_attr, ret)
                    continue
                for rec in df.to_dict("records"):
                    if rec.get("delisting"):
                        continue
                    symbol = from_futu_code(str(rec.get("code") or ""))
                    name = str(rec.get("name") or "")
                    if symbol and _is_chartable(symbol) and name:
                        rows.append(_row(symbol, name, kind, "futu"))
    finally:
        ctx.close()
    if not rows:
        raise RosterUnavailable("futu basic info returned no rows")
    return rows


def _ak_bj_rows() -> list[dict[str, Any]]:
    """Beijing Stock Exchange listings, which Futu does not carry."""
    import akshare as ak  # noqa: PLC0415 — optional dep

    df = ak.stock_info_bj_name_code()
    out: list[dict[str, Any]] = []
    for rec in df.to_dict("records"):
        code = str(rec.get("证券代码") or rec.get("code") or "").strip()
        name = str(rec.get("证券简称") or rec.get("name") or "").strip()
        if not (code and name):
            continue
        symbol = f"{code.zfill(6)}.BJ"
        if _is_chartable(symbol):
            out.append(_row(symbol, _clean_name(name), "equity", "akshare"))
    return out


def _ak_a_share_rows() -> list[dict[str, Any]]:
    """Shanghai + Shenzhen + Beijing roster from akshare, gateway-free."""
    import akshare as ak  # noqa: PLC0415 — optional dep

    df = ak.stock_info_a_code_name()
    out: list[dict[str, Any]] = []
    for rec in df.to_dict("records"):
        code = str(rec.get("code") or "").strip()
        name = str(rec.get("name") or "").strip()
        if not (code and name):
            continue
        suffix = _a_share_suffix(code)
        symbol = f"{code.zfill(6)}.{suffix}"
        if _is_chartable(symbol):
            out.append(_row(symbol, _clean_name(name), "equity", "akshare"))
    return out


#: Order the roster is attempted in; first success wins for that slice.
_BUILDERS: tuple[Callable[[], Iterable[dict[str, Any]]], ...] = (
    _futu_rows,
    _ak_a_share_rows,
)


def build_roster() -> list[dict[str, Any]]:
    """Fetch the roster from the first source that answers, and cache it.

    Akshare's Beijing list is merged into a Futu roster (Futu has no 北交所) but
    is not fetched separately when akshare already served the whole A-share
    universe.

    Returns:
        Deduplicated roster rows, sorted so the deterministic order survives
        caching.

    Raises:
        RosterUnavailable: When every source failed; the caller keeps serving
            the previous cache or an empty index.
    """
    rows: list[dict[str, Any]] = []
    failures: list[str] = []
    for builder in _BUILDERS:
        try:
            rows = list(builder())
        except Exception as exc:  # noqa: BLE001 — a dead source is not a crash
            failures.append(f"{builder.__name__}: {exc}")
            logger.warning("symbol roster source %s failed: %s", builder.__name__, exc)
            continue
        if rows:
            break
        failures.append(f"{builder.__name__}: empty")
    if not rows:
        raise RosterUnavailable("; ".join(failures) or "no source produced rows")

    if rows and rows[0]["source"] == "futu":
        # Only the Futu catalog is missing Beijing; the akshare fallback that
        # produced this roster already contains it.
        try:
            rows.extend(_ak_bj_rows())
        except Exception as exc:  # noqa: BLE001 — a missing venue beats no roster
            logger.warning("beijing roster merge failed; serving without it: %s", exc)

    seen: set[str] = set()
    unique: list[dict[str, Any]] = []
    for row in sorted(rows, key=lambda r: (r["symbol"], r["type"])):
        if row["symbol"] in seen:
            continue
        seen.add(row["symbol"])
        unique.append(row)

    _write_cache(unique)
    with _LOCK:
        _MEM["rows"] = unique
        _MEM["loaded_at"] = time.monotonic()
        _MEM["age"] = 0.0
    logger.info("symbol roster rebuilt: %d instruments", len(unique))
    return unique


def _write_cache(rows: list[dict[str, Any]]) -> None:
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "count": len(rows),
        "rows": rows,
    }
    path = roster_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".json.tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        os.replace(tmp, path)
    except OSError as exc:  # noqa: PERF203 — cache is an optimisation, not a dependency
        logger.warning("symbol roster cache write failed (%s); keeping it in memory", exc)


def _read_cache() -> tuple[list[dict[str, Any]], float] | None:
    """Return ``(rows, age_seconds)`` from disk, or ``None`` when unusable."""
    path = roster_path()
    if not path.is_file():
        return None
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        logger.warning("symbol roster cache unreadable (%s); rebuilding", exc)
        return None
    rows = payload.get("rows")
    if not isinstance(rows, list) or not rows:
        return None
    stamp = str(payload.get("generated_at") or "")
    try:
        age = (datetime.now(timezone.utc) - datetime.fromisoformat(stamp)).total_seconds()
    except ValueError:
        age = float("inf")  # an undated cache cannot be trusted to be fresh
    cleaned = [
        r for r in rows
        if isinstance(r, dict) and _is_chartable(str(r.get("symbol") or "")) and r.get("name")
    ]
    return (cleaned, age) if cleaned else None


# --------------------------------------------------------------------------- #
# public access
# --------------------------------------------------------------------------- #


def get_roster(*, max_age_s: float = DEFAULT_MAX_AGE_S, force: bool = False) -> list[dict[str, Any]]:
    """Return the roster, rebuilding it when stale, missing or requested.

    Args:
        max_age_s: How old the on-disk cache may be before a rebuild is tried.
        force: Rebuild even when a fresh cache exists.

    Returns:
        Roster rows, possibly empty. An empty list is a degraded state, not an
        error: the picker stays usable as a plain text input.
    """
    now = time.monotonic()
    with _LOCK:
        if not force and _MEM["rows"] is not None and now - _MEM["loaded_at"] < 300:
            return list(_MEM["rows"])

    if not force:
        cached = _read_cache()
        if cached is not None:
            rows, age = cached
            if age <= max_age_s:
                with _LOCK:
                    _MEM["rows"] = rows
                    _MEM["loaded_at"] = now
                    _MEM["age"] = age
                return list(rows)
            logger.info("symbol roster is %.0f h old; rebuilding", age / 3600)

    try:
        return build_roster()
    except Exception as exc:  # noqa: BLE001 — stale is better than nothing
        logger.warning("symbol roster rebuild failed (%s)", exc)
        cached = _read_cache()
        if cached is not None:
            rows, _ = cached
            with _LOCK:
                _MEM["rows"] = rows
                _MEM["loaded_at"] = now
            return list(rows)
        with _LOCK:
            _MEM["rows"] = []
            _MEM["loaded_at"] = now
        return []


def peek_roster(*, max_age_s: float = DEFAULT_MAX_AGE_S) -> tuple[list[dict[str, Any]], bool]:
    """Return ``(rows, stale)`` without ever building anything.

    This is what the HTTP type-ahead route calls. :func:`get_roster` is happy
    to spend 17-20 s rebuilding when the cache is missing, which is the right
    behaviour for a batch caller and an unacceptable one for a keystroke
    handler; here a missing or stale roster is reported back instead, and the
    caller decides whether to kick :func:`start_warmup`.

    Args:
        max_age_s: Age past which the second element comes back ``True``.

    Returns:
        ``(rows, stale)``. ``rows`` is empty when no usable cache exists.
    """
    now = time.monotonic()
    with _LOCK:
        if _MEM["rows"] is not None:
            age = float(_MEM.get("age") or 0.0)
            return list(_MEM["rows"]), age > max_age_s

    cached = _read_cache()
    if cached is None:
        return [], True
    rows, age = cached
    with _LOCK:
        _MEM["rows"] = rows
        _MEM["loaded_at"] = now
        _MEM["age"] = age
    return list(rows), age > max_age_s


def status() -> dict[str, Any]:
    """Describe the roster without fetching anything."""
    rows, age = peek_roster()
    return {
        "ready": bool(rows),
        "count": len(rows),
        "age_seconds": round(age, 1) if rows else None,
        "building": is_building(),
    }


def is_building() -> bool:
    """Whether a background rebuild is already under way."""
    with _BUILD_LOCK:
        return _BUILDING[0]


def start_warmup(*, force: bool = False) -> bool:
    """Rebuild the roster on a daemon thread, without making a caller wait.

    A cold build costs 17-20 s (twelve gateway calls plus the Beijing list),
    which is far too long for a keystroke-driven endpoint but perfectly fine
    once per week in the background. Exactly one build may run at a time: each
    one opens its own ``OpenQuoteContext``, so two concurrent warmups would pay
    twice and race on the cache file for no benefit.

    Args:
        force: Rebuild even when a fresh cache exists.

    Returns:
        ``True`` when this call started a builder, ``False`` when it found one
        already running (or found nothing to do).
    """
    with _BUILD_LOCK:
        if _BUILDING[0]:
            return False
        _BUILDING[0] = True

    def _run() -> None:
        try:
            get_roster(force=force)
        finally:
            with _BUILD_LOCK:
                _BUILDING[0] = False

    threading.Thread(target=_run, name="symbol-roster-warmup", daemon=True).start()
    return True


# --------------------------------------------------------------------------- #
# matching
# --------------------------------------------------------------------------- #

#: Rank weights. A candidate must satisfy exactly one tier to be returned, and
#: ties inside a tier fall through to :func:`_tiebreak`.
_TIER_EXACT = 1000
_TIER_CODE_PREFIX = 800
_TIER_NAME_EXACT = 700
_TIER_NAME_PREFIX = 600
_TIER_NAME_INFIX = 400
_TIER_CODE_INFIX = 300


def _tiebreak(row: dict[str, Any]) -> tuple[Any, ...]:
    """Stable order inside a match tier: liquid plain equities first.

    Index and ETF rows sort after stocks that match just as well (a user
    typing ``000`` wants a company, not the composite index), and within a
    type the shortest code wins, which keeps 6-digit A-shares and short US
    tickers at the top.

    The dot count keeps a plain listing ahead of its own sub-shares: a US
    preferred (``HPE.PRC.US``) reduces to the same bare code as the ordinary
    ``HPE.US``, so without this the roster's alphabetical order put the
    preferred first (measured querying ``HP``). No other venue carries a second
    dot, so the term is inert for mainland and Hong Kong symbols.
    """
    type_rank = {"equity": 0, "etf": 1, "index": 2}.get(str(row.get("type")), 3)
    market_rank = {"SH": 0, "SZ": 0, "HK": 1, "BJ": 2, "US": 3}.get(str(row.get("market")), 4)
    symbol = str(row.get("symbol") or "")
    code = to_bare_code(symbol)
    return (type_rank, market_rank, symbol.count("."), len(code), code)


def _score(needle: str, row: dict[str, Any]) -> int:
    """Return the tier *row* earns for *needle*, or 0 when it does not match.

    Args:
        needle: Normalised query (upper-cased, suffix-stripped, trimmed).
        row: One roster row.

    Returns:
        A tier constant above, or ``0`` to exclude the row.
    """
    symbol = str(row.get("symbol") or "")
    code = to_bare_code(symbol)
    name = str(row.get("name") or "")
    if not needle:
        return 0
    name_upper = name.upper()

    # ``600519``, ``600519.SH`` and ``sh600519`` all reduce to the bare code,
    # so an exact hit on it is the instrument the user typed. Class and
    # preferred series need a second form: the picker renders ``BRK.B.US``, and
    # someone typing back what they saw must land on it rather than on the
    # ETFs that merely contain the string (measured: ``BRK.B`` offered only
    # BRKC.US / BRKL.US, ``HPE.PRC`` nothing at all). ``to_bare_code`` cannot
    # cover that — it stops at the first dot — but dropping it would cost the
    # ``BRK`` hit on BRK.A.US, so both stems are tested.
    stem = symbol.rsplit(".", 1)[0] if "." in symbol else symbol
    if code == needle or stem == needle or symbol.upper() == needle:
        return _TIER_EXACT
    if needle.isdigit() and row.get("market") == "HK":
        # Hong Kong is the one venue whose published width differs from how
        # people type it: the listing is ``00700``, everyone writes ``0700``.
        # Padding the needle to *this code's* width recognises that. It is
        # scored as a prefix, not an exact hit, because the width shortcut
        # otherwise reads ``600`` as an exact match for ``00600.HK`` and ranks
        # that ahead of the 600xxx Shanghai series the user was reaching for
        # (measured doing so).
        if needle.zfill(len(code)) == code:
            return _TIER_CODE_PREFIX
    if name_upper == needle:
        return _TIER_NAME_EXACT
    if code.startswith(needle):
        return _TIER_CODE_PREFIX
    if name_upper.startswith(needle):
        return _TIER_NAME_PREFIX
    if needle in name_upper:
        return _TIER_NAME_INFIX
    if needle in code:
        return _TIER_CODE_INFIX
    return 0


def _normalise(query: str) -> str:
    """Reduce raw input to what the matcher needs, in one place.

    A leading venue marker is stripped only when digits follow it
    (``sh600519``, ``HK.00700``), because that test is what keeps the letter
    tickers intact: a looser ``^(SH|H|US)...`` would rewrite ``HP`` (HP Inc.)
    into ``P`` and ``SH`` (a Soni ticker) into nothing, silently losing the
    instrument the user was typing.

    Args:
        query: Raw keystrokes.

    Returns:
        Upper-cased needle with any ``<venue><digits>`` prefix reduced to the
        bare code.
    """
    text = re.sub(r"[\s\u3000]+", "", (query or "")).upper()
    matched = re.match(r"^(?:SH|SZ|BJ|HK|US)[.\-_]?(?=\d)", text)
    if matched:
        text = text[matched.end() :]
    return text.rstrip(".")


def search(
    query: str,
    *,
    limit: int = DEFAULT_LIMIT,
    rows: list[dict[str, Any]] | None = None,
    load: bool = True,
) -> list[dict[str, Any]]:
    """Return roster rows that a user typing *query* most likely means.

    Args:
        query: Keystrokes so far — a code prefix (``600``), a full or partial
            symbol (``600519.SH``), a ticker (``aapl``) or a Chinese name
            fragment (``茅台``).
        limit: Maximum candidates.
        rows: Pre-loaded roster, for callers that already hold one.
        load: When ``False`` and no roster is loaded yet, answer from an empty
            index instead of triggering a synchronous build. Route handlers
            pass ``False``; they warm the roster on a thread.

    Returns:
        At most *limit* rows, best match first, each carrying
        ``symbol/name/market/type``.
    """
    limit = max(1, min(int(limit or DEFAULT_LIMIT), MAX_LIMIT))
    needle = _normalise(query)
    if len(needle) < MIN_QUERY_CHARS:
        return []
    if rows is None:
        rows = get_roster() if load else peek_roster()[0]
    scored: list[tuple[int, tuple[Any, ...], dict[str, Any]]] = []
    for row in rows:
        tier = _score(needle, row)
        if tier:
            scored.append((tier, _tiebreak(row), row))
    scored.sort(key=lambda item: (-item[0], item[1]))
    return [dict(row) for _, _, row in scored[:limit]]
