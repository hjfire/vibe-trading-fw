"""Decode iFinD EDB (macro indicator) responses into date-indexed series.

Why this module exists
----------------------
The iFinD data-service MCP ``get_edb_data`` tool is the only endpoint in that
family whose reply is a *table* rather than prose: everything else returns a
markdown blob aimed at a human reader. Its payload is nevertheless triple
encoded — an MCP text envelope wrapping a JSON string wrapping a ``data`` field
that is *itself* another JSON string on some paths — so nothing downstream can
touch it without a decoder. ``backtest.loaders`` is the wrong home for it: the
loader contract is OHLCV bars (``open/high/low/close/volume``), market types are
inferred from symbol spellings by ``_market_hooks._detect_market`` which never
yields ``macro``, and a macro indicator is a single value per period, not a
bar. Forcing a CPI print through a price-shaped frame would either fabricate
three dummy columns or trip ``validate_ohlc``'s non-positive rejection the
first time an indicator goes negative (growth rates, spreads, and PMI
sub-components all do). So this module keeps its own, honest shape.

Hard-won invariants (each was observed in live payloads, not assumed)
---------------------------------------------------------------------
* Rows arrive **newest first**. A ``pd.Series`` built in served order has a
  descending index, and ``pct_change()`` on that computes *backwards*
  differences — a sign error that survives every plausible eyeball check.
  Everything here is sorted ascending on the way out.
* Values in the structured branch are native JSON numbers (``1.0``, ``-0.6``).
  The Chinese magnitude suffixes (``44.3084亿``) appear in the *markdown*
  branch, where a suffix on the cell is part of the number.
* ``unit`` is recorded, never applied. ``1.0`` with ``unit="%"`` stays ``1.0``:
  silently dividing by 100 would move the decimal place of every macro series
  in the store to satisfy a convention nobody asked for. Callers that need a
  fraction do the conversion themselves, with the unit in hand.
* An unparseable cell is a **gap** (``None``), never ``0.0``. Macro indicators
  legitimately print 0.0; a filler that turns "no data" into zero invents a
  reading, and a reading of zero for e.g. industrial profit growth is a
  economic statement, not a missing value.

The local cache exists for quota reasons: the free iFinD MCP tier is 2000
requests *in total* at 2 req/s, so a fetch that is re-issued on every backtest
would burn the grant in a week. Cached reads are the default path; the network
is only reached by an explicit refresh.
"""

from __future__ import annotations

import datetime as dt
import hashlib
import json
import logging
import math
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Mapping

import pandas as pd

logger = logging.getLogger(__name__)

# Number of decode layers to tolerate before giving up. Real payloads nest
# three deep (envelope -> text -> data); a cap keeps a pathological
# self-referential string from looping.
_MAX_UNWRAP_DEPTH = 5

# Chinese magnitude suffixes. Only applied when the suffix is *inline on the
# cell* (markdown branch), where the number is unintelligible without it.
# Ordered longest-first so "千亿" is not eaten by "亿".
_UNIT_MULTIPLIERS: tuple[tuple[str, float], ...] = (
    ("百万亿", 1e14),
    ("十万亿", 1e13),
    ("万亿", 1e12),
    ("千亿", 1e11),
    ("百亿", 1e10),
    ("十亿", 1e9),
    ("亿", 1e8),
    ("千万", 1e7),
    ("百万", 1e6),
    ("十万", 1e5),
    ("万", 1e4),
)

# Cells iFinD uses for "no value on this date". A bare tab shows up when a
# non-trading day is echoed back with empty fields.
_NULL_CELLS = frozenset({"", "-", "--", "—", "None", "null", "nan", "NaN", "\t"})

# Column header iFinD uses for the period anchor of a macro table.
_DATE_COLUMN_NAMES = ("日期", "时间", "报告期", "统计期", "date", "Date")

# ``（单位：%）`` / ``(单位:元)``, full- or half-width colon.
_HEADER_UNIT_RE = re.compile(r"[（(]\s*单位\s*[:：]\s*([^）)]+?)\s*[）)]")

# Cache format version: bump when the on-disk layout changes so old files are
# simply never matched again instead of being misread.
CACHE_VERSION = 1

# How stale a cached series may get before a refresh is justified, keyed by the
# iFinD ``freq`` code (M=monthly, W=weekly, D=daily, Q=quarterly, Y=annual).
# Monthly data appears once a month, so a day of staleness costs nothing and
# saves most of the quota. Anything unknown takes the 1-day default.
_TTL_BY_FREQ: dict[str, dt.timedelta] = {
    "D": dt.timedelta(hours=2),
    "W": dt.timedelta(days=1),
    "M": dt.timedelta(days=1),
    "Q": dt.timedelta(days=3),
    "Y": dt.timedelta(days=7),
}
_DEFAULT_TTL = dt.timedelta(days=1)

# iFinD's own coverage window fields (``start_time``/``end_time`` on every
# indicator) come as ``YYYYMMDD``. Compact dates also show up in row keys.
_COMPACT_DATE_RE = re.compile(r"^(\d{4})(\d{2})(\d{2})$")

# ``2026-06`` / ``2026/6`` — a month quoted with no day. pd.Timestamp resolves
# that to the *first* of the month, which is the wrong anchor for macro data:
# statistics bureaus publish a month as of its last day, and joining a
# month-start stamp against daily prices would leak the reading ~30 days early.
_MONTH_ONLY_RE = re.compile(r"^(\d{4})[-/](\d{1,2})$")


@dataclass(frozen=True)
class MacroSeries:
    """One decoded indicator series: parallel dates/values plus provenance.

    Attributes:
        name: Indicator label as iFinD spells it, e.g.
            ``全国:社会消费品零售总额:当月同比``.
        dates: ISO ``YYYY-MM-DD`` period ends, **ascending**.
        values: One entry per date; ``None`` marks a gap (never a fake 0.0).
        index_id: iFinD indicator code (``M001657195``) when the source gave
            one. This is the stable identity; the label is not.
        unit: Declared unit verbatim (``%``, ``元``, ``万元``). Not applied to
            ``values`` — see the module docstring.
        freq: iFinD frequency code (``M``/``D``/``Q``/``Y``/``W``).
        data_source: Originating publisher (``国家统计局`` / ``中国人民银行``).
        country: Region label when present (``中国``).
        source: Which branch produced this series: ``"structured"`` or
            ``"markdown"``. Provenance for the parser, not for the reader.
        warnings: Non-fatal decode notes (dropped rows, ambiguous units).
    """

    name: str
    dates: list[str]
    values: list[float | None]
    index_id: str | None = None
    unit: str | None = None
    freq: str | None = None
    data_source: str | None = None
    country: str | None = None
    source: str = "structured"
    warnings: list[str] = field(default_factory=list)

    def frame(self) -> pd.DataFrame:
        """Return a ``DatetimeIndex`` frame with a single ``value`` column.

        The index is explicitly sorted ascending rather than trusted: every
        consumer of this module (regime detection, momentum, plotting) computes
        differences between neighbours, so ordering is part of the contract.

        Returns:
            Frame with ``value`` column and ``as_index`` provenance attrs.
        """
        idx = pd.to_datetime(pd.Index(self.dates), errors="coerce")
        out = pd.DataFrame({"value": pd.array(self.values, dtype="float64")}, index=idx)
        out = out[~out.index.isna()]
        out = out[~out.index.duplicated(keep="last")].sort_index()
        out.index.name = "trade_date"
        out.attrs["indicator"] = self.name
        out.attrs["index_id"] = self.index_id or ""
        out.attrs["unit"] = self.unit or ""
        out.attrs["freq"] = self.freq or ""
        out.attrs["data_source"] = self.data_source or ""
        return out

    def to_cache_record(self, *, query: str | None = None) -> dict[str, Any]:
        """Render the series as the JSON shape written to the local cache."""
        return {
            "version": CACHE_VERSION,
            "name": self.name,
            "index_id": self.index_id,
            "unit": self.unit,
            "freq": self.freq,
            "data_source": self.data_source,
            "country": self.country,
            "decoder": self.source,
            "query": query,
            "fetched_at": dt.datetime.now(dt.timezone.utc).isoformat(),
            "count": len(self.dates),
            "dates": self.dates,
            "values": self.values,
            "warnings": list(self.warnings),
        }


class IfindDecodeError(ValueError):
    """Raised when a payload cannot be decoded into anything usable."""


# ---------------------------------------------------------------------------
# Layer unwrapping
# ---------------------------------------------------------------------------


def unwrap_json(value: Any, *, depth: int = 0) -> Any:
    """Peel JSON-encoded strings until a real object shows up.

    iFinD double-encodes: the MCP envelope's ``text`` is a JSON string, and its
    ``data`` field is another JSON string on every non-error path. A plain
    ``json.loads`` on the envelope therefore yields a string, and a caller who
    stops there sees prose instead of a table.

    Args:
        value: Anything; strings that look like JSON get parsed.
        depth: Internal recursion guard.

    Returns:
        The first non-string object reached, or ``value`` unchanged.
    """
    if depth >= _MAX_UNWRAP_DEPTH:
        return value
    if isinstance(value, str):
        text = value.strip()
        if not text.startswith(("{", "[")):
            return value
        try:
            parsed = json.loads(text)
        except json.JSONDecodeError:
            return value
        return unwrap_json(parsed, depth=depth + 1)
    if isinstance(value, Mapping):
        return {key: unwrap_json(item, depth=depth + 1) for key, item in value.items()}
    if isinstance(value, list):
        return [unwrap_json(item, depth=depth + 1) for item in value]
    return value


def unwrap_envelope(payload: Any) -> dict[str, Any]:
    """Reduce an MCP tool reply to ``{code, msg, data, raw}``.

    Args:
        payload: Whatever ``MCPServerAdapter.call_tool`` returned (a dict with
            ``text``/``content``), or the already-decoded inner object.

    Returns:
        Mapping with ``code`` (int or None), ``msg`` (str), ``data``
        (dict/list/str/None) and ``raw`` (the decoded reply for diagnostics).
        ``ok`` is True when iFinD reported ``code == 1``.

    Raises:
        IfindDecodeError: When no JSON object can be reached at all.
    """
    node = payload
    if isinstance(node, Mapping) and ("text" in node or "content" in node):
        text = node.get("text")
        if not isinstance(text, str):
            content = node.get("content")
            first = content[0] if isinstance(content, list) and content else None
            text = first.get("text") if isinstance(first, Mapping) else None
        node = text if isinstance(text, str) else node
    decoded = unwrap_json(node)
    if not isinstance(decoded, dict):
        raise IfindDecodeError(
            f"could not reach a JSON object in the iFinD reply (got {type(decoded).__name__})"
        )
    status = str(decoded.get("status") or "").lower()
    if status not in {"", "ok"} and "code" not in decoded:
        # ``MCPServerAdapter.call_tool`` swallows transport exceptions into a
        # {status: error, error: ...} payload. Reported as itself here, rather
        # than degrading into "code=None" and a lost reason.
        raise IfindDecodeError(
            f"iFinD MCP call failed ({status}): {decoded.get('error') or 'no detail'}"
        )
    if "code" not in decoded and isinstance(decoded.get("data"), Mapping):
        # A server that answers with structured content only (no text block)
        # wraps the iFinD body one layer deeper.
        inner = unwrap_json(decoded.get("data"))
        if isinstance(inner, Mapping) and "code" in inner:
            decoded = inner
    code = decoded.get("code")
    data = unwrap_json(decoded.get("data"))
    return {
        "code": code if isinstance(code, int) else None,
        "ok": code == 1,
        "msg": str(decoded.get("msg") or ""),
        "data": data,
        "raw": decoded,
    }


# ---------------------------------------------------------------------------
# Numeric / date normalisation
# ---------------------------------------------------------------------------


def parse_cell_number(cell: Any) -> tuple[float | None, str | None, bool]:
    """Parse one table cell into a float, honouring an inline Chinese magnitude.

    Args:
        cell: Raw cell value (number, numeric string, unit-suffixed string, or
            a gap marker such as ``""`` / ``"-"`` / ``"\t"``).

    Returns:
        ``(value, inline_unit, is_gap)``. ``value`` is ``None`` for gaps and
        unparseable text; ``inline_unit`` is the suffix consumed (``"亿"``) so
        the caller can record that a scaling was applied.
    """
    if cell is None:
        return None, None, True
    if isinstance(cell, bool):  # bool is an int subclass; True is not the number 1
        return None, None, True
    if isinstance(cell, (int, float)):
        # ``json.loads`` accepts the bare token ``NaN``, and a NaN value would
        # poison every downstream difference *and* break the strict
        # (``allow_nan=False``) JSON used for tool envelopes. A gap is the
        # honest reading.
        if isinstance(cell, float) and math.isnan(cell):
            return None, None, True
        return float(cell), None, False

    text = str(cell).strip()
    if text in _NULL_CELLS:
        return None, None, True
    # Thousands separators and a leading sign in either order ("−1,234").
    cleaned = text.replace(",", "").replace("，", "").replace("−", "-")
    for suffix, factor in _UNIT_MULTIPLIERS:
        if cleaned.endswith(suffix):
            mantissa = cleaned[: -len(suffix)].strip()
            try:
                return float(mantissa) * factor, suffix, False
            except ValueError:
                return None, suffix, True
    try:
        return float(cleaned), None, False
    except ValueError:
        return None, None, True


def normalize_date(value: Any) -> str | None:
    """Coerce one period cell to ISO ``YYYY-MM-DD``.

    Accepts ``2026-06-30``, ``2026/06/30``, the compact ``20260630`` used by
    iFinD's coverage fields, and a monthly ``2026-06`` (padded to month end —
    macro periods are always quoted as of the period's last day, and month-start
    would silently mis-time every comparison against daily price data).

    Returns:
        The ISO date string, or ``None`` when the cell is not a date.
    """
    if value is None:
        return None
    text = str(value).strip()
    if not text or text in _NULL_CELLS:
        return None
    compact = _COMPACT_DATE_RE.match(text)
    if compact:
        text = f"{compact.group(1)}-{compact.group(2)}-{compact.group(3)}"
    month = _MONTH_ONLY_RE.match(text)
    if month:
        # Anchor at the period's last day (see _MONTH_ONLY_RE).
        stamp = pd.Timestamp(int(month.group(1)), int(month.group(2)), 1)
        return (stamp + pd.offsets.MonthEnd(0)).strftime("%Y-%m-%d")
    try:
        stamp = pd.Timestamp(text)
    except (ValueError, TypeError):
        return None
    return stamp.strftime("%Y-%m-%d")


# ---------------------------------------------------------------------------
# Structured (``datas[].data``) branch
# ---------------------------------------------------------------------------


def _series_from_table(table: Mapping[str, Any], *, source: str = "structured") -> list[MacroSeries]:
    """Build one :class:`MacroSeries` per value column of a standard table.

    Args:
        table: The ``data`` node of one ``datas[]`` element, holding
            ``columns`` (``["日期", "<indicator>", ...]``), ``data`` (rows of
            equal length, **newest first**) and ``attrs`` (per-indicator
            metadata keyed by the indicator name).
        source: Provenance tag copied onto the series.

    Returns:
        Series in column order. Empty when the node is not table-shaped.
    """
    columns = table.get("columns")
    rows = table.get("data")
    if not isinstance(columns, list) or not isinstance(rows, list) or not rows:
        return []

    names = [str(column) for column in columns]
    date_pos = next(
        (i for i, name in enumerate(names) if name.strip() in _DATE_COLUMN_NAMES), None
    )
    if date_pos is None:
        return []
    attrs = table.get("attrs") if isinstance(table.get("attrs"), Mapping) else {}

    series: list[MacroSeries] = []
    for pos, name in enumerate(names):
        if pos == date_pos:
            continue
        meta = attrs.get(name) if isinstance(attrs.get(name), Mapping) else {}
        dated: list[tuple[str, float | None, bool]] = []
        inline_units: set[str] = set()
        for row in rows:
            if not isinstance(row, (list, tuple)) or len(row) <= max(pos, date_pos):
                continue
            date = normalize_date(row[date_pos])
            if date is None:
                continue
            value, inline_unit, is_gap = parse_cell_number(row[pos])
            if inline_unit:
                inline_units.add(inline_unit)
            dated.append((date, None if is_gap else value, is_gap))

        if not dated:
            series.append(MacroSeries(name=name, dates=[], values=[], source=source))
            continue
        # Rows are served newest-first, so the first row carrying a given period
        # is the newest rendition of it and a later repeat is an older restatement.
        # Iterating in served order and keeping the first occurrence is what makes
        # "latest word wins" true; sorting first would silently keep the oldest.
        seen: dict[str, float | None] = {}
        for date, value, _gap in dated:
            if date not in seen:
                seen[date] = value
        ordered = sorted(seen)
        warnings: list[str] = []
        unit = _clean_text(meta.get("unit"))
        if inline_units:
            note = "+".join(sorted(inline_units))
            warnings.append(
                f"inline magnitude suffix(es) {note} were applied to the values"
            )
        series.append(
            MacroSeries(
                name=name,
                dates=ordered,
                values=[seen[d] for d in ordered],
                index_id=_clean_text(meta.get("index_id")),
                unit=unit,
                freq=_clean_text(meta.get("freq")),
                data_source=_clean_text(meta.get("data_source")),
                country=_clean_text(meta.get("country")),
                source=source,
                warnings=warnings,
            )
        )
    return series


def _clean_text(value: Any) -> str | None:
    """Return a stripped non-empty string, else ``None`` (JSON-friendly)."""
    if value is None:
        return None
    text = str(value).strip()
    return text or None


# ---------------------------------------------------------------------------
# Markdown fallback branch
# ---------------------------------------------------------------------------


def split_markdown_table(markdown: str) -> tuple[list[str], list[list[str]]]:
    """Parse a pipe-delimited markdown table into headers and cells.

    Args:
        markdown: Text possibly containing a ``|a|b|`` / ``|---|---|`` table.

    Returns:
        ``(headers, rows)`` with leading/trailing pipes removed and each row
        padded or truncated to the header width. Empty headers when the text
        holds no table.
    """
    lines: list[list[str]] = []
    for raw in markdown.splitlines():
        line = raw.strip()
        if not line.startswith("|"):
            continue
        cells = [cell.strip() for cell in line.strip("|").split("|")]
        if cells and all(re.fullmatch(r":?-{2,}:?", cell or "-") for cell in cells):
            continue  # the |---|---| separator row carries no data
        lines.append(cells)
    if not lines:
        return [], []
    headers = lines[0]
    width = len(headers)
    rows: list[list[str]] = []
    for cells in lines[1:]:
        if len(cells) < width:
            cells = cells + [""] * (width - len(cells))
        rows.append(cells[:width])
    return headers, rows


def series_from_markdown(markdown: str) -> list[MacroSeries]:
    """Decode a markdown-table reply when the structured branch is absent.

    ``get_edb_data`` also answers in plain markdown (and so does every other
    tool in the family). Header cells carry the declared unit as
    ``名称（单位：%）``; that unit is recorded but not applied, while an inline
    suffix on a cell is applied, because there the suffix is part of the number.

    Args:
        markdown: Reply text, expected to hold one table.

    Returns:
        Series per non-date column, ordered as in the table. Empty when no
        table is found.
    """
    headers, rows = split_markdown_table(markdown)
    if not headers or not rows:
        return []
    date_pos = next(
        (i for i, name in enumerate(headers) if name.strip() in _DATE_COLUMN_NAMES), None
    )
    if date_pos is None:
        return []

    out: list[MacroSeries] = []
    for pos, header in enumerate(headers):
        if pos == date_pos:
            continue
        unit_match = _HEADER_UNIT_RE.search(header)
        name = _HEADER_UNIT_RE.sub("", header).strip() or header.strip()
        pairs: dict[str, float | None] = {}
        inline_units: set[str] = set()
        warnings: list[str] = []
        for row in rows:
            if len(row) <= max(pos, date_pos):
                continue
            date = normalize_date(row[date_pos])
            if date is None:
                continue
            value, inline_unit, is_gap = parse_cell_number(row[pos])
            if inline_unit:
                inline_units.add(inline_unit)
            if is_gap and row[pos].strip() and row[pos].strip() not in _NULL_CELLS:
                warnings.append(f"unparseable cell {row[pos]!r} at {date} kept as a gap")
            if date in pairs:
                # Served newest-first: keep the first word on a period (see
                # _series_from_table for the same rule in the structured branch).
                continue
            pairs[date] = None if is_gap else value
        ordered = sorted(pairs)
        if inline_units:
            # Same rule as the structured branch: the suffix was part of the
            # number, so scaling it is decoding, not rescaling the series.
            warnings.append(
                "inline magnitude suffix(es) "
                f"{'+'.join(sorted(inline_units))} were applied to the values"
            )
        out.append(
            MacroSeries(
                name=name,
                dates=ordered,
                values=[pairs[d] for d in ordered],
                unit=unit_match.group(1).strip() if unit_match else None,
                source="markdown",
                warnings=warnings,
            )
        )
    return out


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def extract_series(payload: Any) -> list[MacroSeries]:
    """Decode any iFinD data-service reply into macro-shaped series.

    Tries the machine-readable table first (``data.datas[].data``), then falls
    back to a markdown table in ``data.answer`` / ``data.data_markdown`` /
    ``data`` itself. An empty list means "this reply has no tabular series"
    (for example iFinD's ``抱歉，本次新闻搜索结果为空`` prose), which is a
    *successful* call that still spent quota — callers must not retry blindly.

    Args:
        payload: Raw MCP reply or already-decoded body.

    Returns:
        Every series found, in served order. Empty when none is decodable.

    Raises:
        IfindDecodeError: When the reply is not even iFinD-shaped.
        IfindDecodeError: When iFinD returned a non-zero ``code`` (bad key,
            quota exhausted, rate limit) — the message is kept in the error so
            the caller can tell those apart.
    """
    envelope = unwrap_envelope(payload)
    if not envelope["ok"]:
        raise IfindDecodeError(
            f"iFinD replied code={envelope['code']} msg={envelope['msg']!r}"
        )

    data = envelope["data"]
    found: list[MacroSeries] = []
    if isinstance(data, Mapping):
        blocks = data.get("datas")
        if isinstance(blocks, list):
            for block in blocks:
                if not isinstance(block, Mapping):
                    continue
                if block.get("success") is False:
                    found.append(
                        MacroSeries(
                            name=_clean_text(block.get("description")) or "unnamed",
                            dates=[],
                            values=[],
                            warnings=[f"datas[].success=false: {_clean_text(block.get('answer')) or 'no detail'}"],
                        )
                    )
                    continue
                inner = block.get("data")
                if isinstance(inner, Mapping):
                    found.extend(_series_from_table(inner))
                    continue
                text = _clean_text(block.get("data_markdown")) or _clean_text(block.get("answer"))
                if text:
                    found.extend(series_from_markdown(text))
        answer = _clean_text(data.get("answer"))
        if not found and answer:
            found.extend(series_from_markdown(answer))
    elif isinstance(data, str):
        found.extend(series_from_markdown(data))
    return [series for series in found if series.dates] or found


# ---------------------------------------------------------------------------
# Local cache (quota defence)
# ---------------------------------------------------------------------------


def macro_cache_dir() -> Path:
    """Return ``<runtime root>/macro``, created on demand.

    Lives beside the other operator-owned state under ``~/.vibe-trading`` (or
    ``VIBE_TRADING_HOME``) rather than in the checkout: fetched indicator data is
    user data and the repository must never accumulate it.
    """
    from src.config.paths import get_runtime_root

    path = get_runtime_root() / "macro"
    path.mkdir(parents=True, exist_ok=True)
    return path


def slug_for(name: str, index_id: str | None = None) -> str:
    """Build a filesystem-safe cache key for one indicator.

    ``index_id`` wins when present because iFinD's indicator label is not
    stable across queries (``全国:社会消费品零售总额:当月同比`` vs a shorter
    rendering), while the code identifies the series regardless of wording.

    Args:
        name: Indicator label.
        index_id: iFinD indicator code, if known.

    Returns:
        Lowercase key safe on Windows and POSIX filesystems.
    """
    basis = (index_id or name or "").strip().lower()
    safe = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", "_", basis).strip("_")
    if not safe:
        safe = "unnamed"
    if index_id:
        return safe[:64]
    # No stable id: a hash suffix keeps two long labels that share a prefix
    # from colliding onto the same file.
    return f"{safe[:48]}_{hashlib.sha1(name.encode('utf-8')).hexdigest()[:8]}"


def save_series(series: MacroSeries, *, query: str | None = None) -> Path:
    """Write one series to the cache and return its path."""
    slug = slug_for(series.name, series.index_id)
    path = macro_cache_dir() / f"{slug}.json"
    record = series.to_cache_record(query=query)
    record["slug"] = slug
    tmp = path.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(record, ensure_ascii=False, sort_keys=True), encoding="utf-8")
    tmp.replace(path)
    return path


def load_series(slug: str) -> dict[str, Any] | None:
    """Read one cached record by slug (with or without a ``.json`` suffix).

    Returns:
        The record, or ``None`` when it is missing, unreadable, or written by a
        different cache version. A corrupt cache file is a miss, not an error:
        the whole point of the cache is to save quota, and failing loudly would
        turn a stale byte into an outage.
    """
    name = slug if slug.endswith(".json") else f"{slug}.json"
    path = macro_cache_dir() / name
    if not path.is_file():
        return None
    try:
        record = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        logger.warning("macro cache %s unreadable: %s", path.name, exc)
        return None
    if not isinstance(record, dict) or record.get("version") != CACHE_VERSION:
        return None
    return record


def list_cached() -> list[dict[str, Any]]:
    """Return lightweight index rows for every cached series, by name."""
    rows: list[dict[str, Any]] = []
    for path in sorted(macro_cache_dir().glob("*.json")):
        record = load_series(path.stem)
        if record is None:
            continue
        dates = record.get("dates") or []
        rows.append(
            {
                "slug": record.get("slug") or path.stem,
                "name": record.get("name"),
                "index_id": record.get("index_id"),
                "unit": record.get("unit"),
                "freq": record.get("freq"),
                "data_source": record.get("data_source"),
                "count": len(dates),
                "first": dates[0] if dates else None,
                "last": dates[-1] if dates else None,
                "fetched_at": record.get("fetched_at"),
            }
        )
    return rows


def is_fresh(record: Mapping[str, Any] | None, *, now: dt.datetime | None = None) -> bool:
    """Whether a cached record is new enough to serve without spending quota."""
    if not record:
        return False
    stamp = record.get("fetched_at")
    if not isinstance(stamp, str):
        return False
    try:
        fetched = dt.datetime.fromisoformat(stamp)
    except ValueError:
        return False
    if fetched.tzinfo is None:
        fetched = fetched.replace(tzinfo=dt.timezone.utc)
    ttl = _TTL_BY_FREQ.get(str(record.get("freq") or ""), _DEFAULT_TTL)
    current = now or dt.datetime.now(dt.timezone.utc)
    return current - fetched <= ttl


def record_to_series(record: Mapping[str, Any]) -> MacroSeries:
    """Rebuild a :class:`MacroSeries` from a cache record."""
    dates = [str(item) for item in (record.get("dates") or [])]
    values = [None if item is None else float(item) for item in (record.get("values") or [])]
    if len(values) != len(dates):  # pragma: no cover - defensive against hand edits
        keep = min(len(values), len(dates))
        dates, values = dates[:keep], values[:keep]
    warnings = record.get("warnings")
    return MacroSeries(
        name=str(record.get("name") or ""),
        dates=dates,
        values=values,
        index_id=_clean_text(record.get("index_id")),
        unit=_clean_text(record.get("unit")),
        freq=_clean_text(record.get("freq")),
        data_source=_clean_text(record.get("data_source")),
        country=_clean_text(record.get("country")),
        source=str(record.get("decoder") or "structured"),
        warnings=[str(item) for item in warnings] if isinstance(warnings, list) else [],
    )
