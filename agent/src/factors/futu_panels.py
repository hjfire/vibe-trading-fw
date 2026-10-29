"""Daily A-share panels from FutuOpenD for the chip and limit-pool engines.

Three units/definitions are deliberate and tested, because getting any of them
wrong silently poisons every downstream number:

* Prices are **unadjusted** (``AuType.NONE``). The limit-band rules compare a
  close against the exchange price band; forward-adjusted prices distort that
  band on every ex-dividend date.
* ``prev_close`` comes from Futu's ``last_close`` column, never from
  ``close.shift(1)`` — an implicit shift would hide a wrong price basis.
* ``turnover_rate`` is a **fraction** in Futu's payload (``0.00869``); the
  panel exposes ``turnover_rate_pct`` in percent (``0.869``) because
  :func:`src.factors.chips.chip_metrics` takes percent.

No-lookahead: every bar dated on or after the Asia/Shanghai as-of date is
dropped, so a run during the session never consumes an unfinished bar.

ST is a *current-state* flag only: Futu returns one name per symbol for the
whole history, so a historical ST change is not representable here.
"""

from __future__ import annotations

import logging
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, replace
from datetime import date, datetime, timedelta, timezone

import pandas as pd

from backtest.loaders import futu_gateway
from backtest.loaders.futu import _to_futu_symbol

__all__ = [
    "FutuPanels",
    "FutuPanelsError",
    "fetch_daily_panels",
    "is_st_name",
    "normalize_daily_panels",
]

logger = logging.getLogger(__name__)

_REQUIRED = ("time_key", "name", "high", "low", "close", "last_close", "turnover_rate")
_CODE_RE = re.compile(r"^\d{6}\.(SH|SZ)$")
_ST_PREFIXES = ("ST", "*ST", "SST", "S*ST")
_CN_TZ = timezone(timedelta(hours=8))


class FutuPanelsError(RuntimeError):
    """FutuOpenD could not produce a usable daily panel."""


@dataclass(frozen=True)
class FutuPanels:
    high: pd.DataFrame
    low: pd.DataFrame
    close: pd.DataFrame
    prev_close: pd.DataFrame
    turnover_rate_pct: pd.DataFrame
    is_st: pd.DataFrame
    names: dict[str, str]
    failures: dict[str, str]
    as_of: date


def _shanghai_today() -> date:
    return datetime.now(_CN_TZ).date()


def is_st_name(name: str) -> bool:
    """True when a name carries an ST prefix (current name only)."""
    if not isinstance(name, str):
        return False
    return "".join(name.split()).upper().startswith(_ST_PREFIXES)


def _empty_panels(as_of: date) -> FutuPanels:
    index = pd.DatetimeIndex([], name="trade_date")
    empty = pd.DataFrame(index=index)
    return FutuPanels(
        high=empty.copy(),
        low=empty.copy(),
        close=empty.copy(),
        prev_close=empty.copy(),
        turnover_rate_pct=empty.copy(),
        is_st=pd.DataFrame(index=index, dtype=bool),
        names={},
        failures={},
        as_of=as_of,
    )


def normalize_daily_panels(
    frames: Mapping[str, pd.DataFrame], *, today: date | None = None
) -> FutuPanels:
    """Turn raw Futu kline frames into aligned, unit-fixed wide panels."""
    as_of = today if today is not None else _shanghai_today()
    if isinstance(as_of, datetime):
        as_of = as_of.date()
    if not isinstance(as_of, date):
        raise ValueError(f"today must be a date, got {type(as_of).__name__}")
    cutoff = pd.Timestamp(as_of)

    prepared: dict[str, tuple[pd.DataFrame, str]] = {}
    for code, frame in frames.items():
        if not isinstance(code, str) or not _CODE_RE.match(code):
            raise ValueError(f"unsupported A-share code: {code!r}")
        if not isinstance(frame, pd.DataFrame):
            raise ValueError(f"{code}: frame must be a pandas DataFrame")
        missing = [column for column in _REQUIRED if column not in frame.columns]
        if missing:
            raise ValueError(f"{code}: missing required columns {missing}")
        if frame.empty:
            continue
        work = frame.loc[:, list(_REQUIRED)].copy()
        work["_ts"] = pd.to_datetime(work["time_key"], errors="coerce")
        work = work.dropna(subset=["_ts"])
        work = work[work["_ts"].dt.normalize() < cutoff]
        if work.empty:
            continue
        work = work.sort_values("_ts", kind="mergesort").drop_duplicates(
            "_ts", keep="last"
        )
        work.index = pd.DatetimeIndex(work["_ts"].dt.normalize(), name="trade_date")
        numeric = work.loc[
            :, ["high", "low", "close", "last_close", "turnover_rate"]
        ].apply(pd.to_numeric, errors="coerce")
        numeric = numeric.rename(columns={"last_close": "prev_close"})
        numeric["turnover_rate_pct"] = numeric["turnover_rate"] * 100.0
        name_value = work["name"].iloc[-1]
        prepared[code] = (numeric, "" if pd.isna(name_value) else str(name_value))

    if not prepared:
        return _empty_panels(as_of)

    index = next(iter(prepared.values()))[0].index
    for frame, _name in prepared.values():
        index = index.union(frame.index)
    index = pd.DatetimeIndex(index.sort_values(), name="trade_date")
    columns = list(prepared)

    def panel(column: str) -> pd.DataFrame:
        return (
            pd.DataFrame({code: prepared[code][0][column] for code in columns}, index=index)
            .reindex(index=index, columns=columns)
            .astype(float)
        )

    is_st = (
        pd.DataFrame(
            {
                code: pd.Series(is_st_name(prepared[code][1]), index=index, dtype=bool)
                for code in columns
            },
            index=index,
        )
        .reindex(index=index, columns=columns, fill_value=False)
        .astype(bool)
    )

    return FutuPanels(
        high=panel("high"),
        low=panel("low"),
        close=panel("close"),
        prev_close=panel("prev_close"),
        turnover_rate_pct=panel("turnover_rate_pct"),
        is_st=is_st,
        names={code: prepared[code][1] for code in columns},
        failures={},
        as_of=as_of,
    )


def _parse_day(value: str, label: str) -> date:
    try:
        stamp = pd.Timestamp(value)
    except Exception as exc:
        raise ValueError(f"{label} is not a date: {value!r}") from exc
    if pd.isna(stamp):
        raise ValueError(f"{label} is not a date: {value!r}")
    return stamp.date()


def _request_pages(ctx, futu, futu_code: str, start_date: str, end_date: str,
                   max_count: int, max_pages: int) -> tuple[list[pd.DataFrame], str | None]:
    """Walk every page of one symbol; the second item is a failure reason."""
    rows: list[pd.DataFrame] = []
    page_key = None
    seen: set = set()
    pages = 0
    while True:
        pages += 1
        if pages > max_pages:
            return rows, f"pagination exceeded {max_pages} pages"
        try:
            ret, data, next_key = ctx.request_history_kline(
                futu_code,
                start=start_date,
                end=end_date,
                ktype=futu.KLType.K_DAY,
                autype=futu.AuType.NONE,
                max_count=max_count,
                page_req_key=page_key,
                fields=[futu.KL_FIELD.ALL],
            )
        except Exception as exc:
            return rows, f"{type(exc).__name__}: {exc}"
        if ret != futu.RET_OK:
            return rows, str(data)
        if isinstance(data, pd.DataFrame) and not data.empty:
            rows.append(data)
        if not next_key:
            return rows, None
        if next_key == page_key or next_key in seen:
            return rows, "pagination loop detected"
        seen.add(next_key)
        page_key = next_key


def fetch_daily_panels(
    codes: Sequence[str],
    start_date: str,
    end_date: str,
    *,
    today: date | None = None,
    max_count: int = 1000,
    max_pages: int = 100,
) -> FutuPanels:
    """Fetch unadjusted A-share daily bars and normalize them into panels.

    Per-symbol failures are reported in ``FutuPanels.failures`` and simply do
    not produce a column. Only when *every* symbol fails is ``FutuPanelsError``
    raised — a refused symbol is not a gateway fault, so no cooldown is latched.
    """
    requested = list(
        dict.fromkeys(
            str(code).strip().upper() for code in codes if str(code).strip()
        )
    )
    if not requested:
        raise ValueError("codes must be non-empty")
    unsupported = [code for code in requested if not _CODE_RE.match(code)]
    if unsupported:
        raise ValueError(
            f"Futu panels only serve A-share codes (000001.SZ); got {unsupported}"
        )
    start = _parse_day(start_date, "start_date")
    end = _parse_day(end_date, "end_date")
    if end < start:
        raise ValueError(f"end_date {end} is before start_date {start}")
    as_of = today if today is not None else _shanghai_today()
    if isinstance(as_of, datetime):
        as_of = as_of.date()
    if not isinstance(as_of, date):
        raise ValueError(f"today must be a date, got {type(as_of).__name__}")

    host, port = futu_gateway.gateway_target()
    if futu_gateway.in_cooldown(host, port):
        raise FutuPanelsError(f"FutuOpenD at {host}:{port} is marked unavailable")
    try:
        import futu  # noqa: PLC0415 — optional dependency, absent in CI
    except ImportError as exc:
        raise FutuPanelsError(
            "futu-api is not installed; cannot reach FutuOpenD"
        ) from exc
    try:
        ctx = futu_gateway.open_context(host, port)
    except Exception as exc:
        futu_gateway.note_failure(
            host, port, reason=f"futu panels connect: {type(exc).__name__}"
        )
        raise FutuPanelsError(f"Cannot connect to FutuOpenD at {host}:{port}: {exc}") from exc

    frames: dict[str, pd.DataFrame] = {}
    failures: dict[str, str] = {}
    try:
        for code in requested:
            rows, failure = _request_pages(
                ctx, futu, _to_futu_symbol(code), start_date, end_date, max_count, max_pages
            )
            if failure is not None:
                failures[code] = failure
            elif not rows:
                failures[code] = "no rows"
            else:
                frames[code] = pd.concat(rows, ignore_index=True)
    finally:
        try:
            ctx.close()
        except Exception:  # noqa: BLE001 — close failures must not mask results
            logger.debug("FutuPanels context close failed", exc_info=True)

    panels = normalize_daily_panels(frames, today=as_of)
    for code in requested:
        if code not in panels.close.columns:
            failures.setdefault(code, "no completed rows before as_of")
    if not panels.close.columns.size:
        first = next(iter(failures.items()), ("", "no rows returned"))
        raise FutuPanelsError(
            f"FutuOpenD returned no completed daily bars; "
            f"first failure {first[0]}: {first[1]}"
        )
    futu_gateway.note_success(host, port)
    return replace(panels, failures=dict(failures))
