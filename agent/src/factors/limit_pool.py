"""Limit-up / limit-down event tables over an unadjusted daily panel.

Pure functions: wide tables in, wide tables out. No I/O, no network, no clock.

Price limits are exchange prices, so the inputs MUST be unadjusted (raw) OHLC
plus an explicit previous close. Feeding forward-adjusted prices here silently
misclassifies every day around a corporate action; the caller owns that
contract. There is deliberately no ``close.shift(1)`` fallback.

This module does not call tushare's ``limit_list_d`` / ``limit_step`` (they
need points this machine does not have) and makes no claim of numeric parity
with them. The band ratio comes from ``backtest.engines.china_a._price_limit``
and the ST override plus ``ROUND_HALF_UP`` tick quantisation are reused, by a
function-local import, from ``paper_trade.limits_cn_a.heuristic_limit_prices``
so that this module stays light to import.
"""

from __future__ import annotations

from dataclasses import dataclass

import numpy as np
import pandas as pd

__all__ = [
    "LimitEventTables",
    "LimitPoolTables",
    "board_ladder",
    "daily_summary",
    "events_long",
    "limit_events",
    "limit_pool",
    "limit_prices",
    "promotion_rates",
]

STATUS_UP = "up"
STATUS_DOWN = "down"
STATUS_BROKEN_UP = "broken_up"
STATUS_BROKEN_DOWN = "broken_down"
STATUS_NONE = "none"

_TOL = 1e-9

_DAILY_COLUMNS = [
    "n_valid",
    "limit_up",
    "limit_down",
    "broken_up",
    "broken_down",
    "touched_up",
    "touched_down",
    "seal_rate",
    "broken_rate",
    "limit_up_ratio",
    "max_board",
]


@dataclass(frozen=True)
class LimitEventTables:
    status: pd.DataFrame
    streak: pd.DataFrame


@dataclass(frozen=True)
class LimitPoolTables:
    status: pd.DataFrame
    streak: pd.DataFrame
    daily: pd.DataFrame
    ladder: pd.DataFrame
    promotion: pd.DataFrame
    events: pd.DataFrame


def limit_prices(prev_close: float, symbol: str, is_st: bool = False) -> tuple[float, float]:
    """Limit band for one symbol-day, quantised to the 0.01 tick."""
    from src.tools.paper_trade.limits_cn_a import heuristic_limit_prices

    return heuristic_limit_prices(symbol, float(prev_close), bool(is_st))


def _validate(frame: pd.DataFrame, name: str) -> None:
    if not isinstance(frame, pd.DataFrame):
        raise TypeError(f"{name} must be a pandas DataFrame, got {type(frame).__name__}")
    if not frame.index.is_unique:
        raise ValueError(f"{name} index must be unique")
    if not frame.index.is_monotonic_increasing:
        raise ValueError(f"{name} index must be strictly increasing (oldest first)")
    if not frame.columns.is_unique:
        raise ValueError(f"{name} columns must be unique")


def _aligned(high, low, close, prev_close, is_st):
    for name, frame in (
        ("high", high), ("low", low), ("close", close), ("prev_close", prev_close),
    ):
        _validate(frame, name)
    index, columns = high.index, high.columns
    for name, frame in (
        ("low", low), ("close", close), ("prev_close", prev_close),
    ):
        if not frame.index.equals(index) or not frame.columns.equals(columns):
            raise ValueError(f"{name} must share high's index and columns")
    if is_st is not None:
        _validate(is_st, "is_st")
        if not is_st.index.equals(index) or not is_st.columns.equals(columns):
            raise ValueError("is_st must share high's index and columns")
        if is_st.isna().to_numpy().any():
            raise ValueError("is_st must be fully boolean (no NA)")
    return index, columns


def _arrays(high, low, close, prev_close, is_st, index, columns):
    h = high.to_numpy(dtype=float)
    l = low.to_numpy(dtype=float)
    c = close.to_numpy(dtype=float)
    p = prev_close.to_numpy(dtype=float)
    finite = np.isfinite(h) & np.isfinite(l) & np.isfinite(c) & np.isfinite(p)
    bad_prev = finite & (p <= 0.0)
    if bad_prev.any():
        i, j = np.argwhere(bad_prev)[0]
        raise ValueError(
            f"prev_close must be positive on a valid bar, got {p[i, j]!r} "
            f"at {index[i]} {columns[j]}"
        )
    bad_range = finite & (h < l)
    if bad_range.any():
        i, j = np.argwhere(bad_range)[0]
        raise ValueError(
            f"high must be >= low on a valid bar ({h[i, j]!r} < {l[i, j]!r}) "
            f"at {index[i]} {columns[j]}"
        )
    positive = finite & (h > 0.0) & (l > 0.0) & (c > 0.0)
    st = np.zeros(h.shape, dtype=bool) if is_st is None else is_st.to_numpy(dtype=bool)
    return h, l, c, p, positive, st


def _bands(prev_close, positive, is_st, columns):
    up = np.full(prev_close.shape, np.nan)
    down = np.full(prev_close.shape, np.nan)
    for j, symbol in enumerate(columns):
        for i in np.flatnonzero(positive[:, j]):
            up[i, j], down[i, j] = limit_prices(prev_close[i, j], symbol, bool(is_st[i, j]))
    return up, down


def _status(h, l, c, up, down, positive):
    tol = _TOL * np.maximum(np.maximum(np.abs(up), np.abs(down)), 1.0)
    sealed_up = positive & (c >= up - tol)
    broken_up = positive & ~sealed_up & (h >= up - tol)
    sealed_down = positive & ~sealed_up & (c <= down + tol)
    broken_down = positive & ~sealed_up & ~sealed_down & (l <= down + tol)
    status = np.full(h.shape, None, dtype=object)
    status[positive] = STATUS_NONE
    status[broken_down] = STATUS_BROKEN_DOWN
    status[broken_up] = STATUS_BROKEN_UP
    status[sealed_down] = STATUS_DOWN
    status[sealed_up] = STATUS_UP
    return status


def _streak(status, positive):
    streak = np.full(status.shape, np.nan)
    rows, cols = status.shape
    for j in range(cols):
        previous = np.nan
        for i in range(rows):
            if not positive[i, j]:
                previous = np.nan
                continue
            if status[i, j] == STATUS_UP:
                streak[i, j] = previous + 1.0 if np.isfinite(previous) else 1.0
            else:
                streak[i, j] = 0.0
            previous = streak[i, j]
    return streak


def limit_events(high, low, close, prev_close, *, is_st=None) -> LimitEventTables:
    """Per symbol-day limit status and consecutive-board count."""
    index, columns = _aligned(high, low, close, prev_close, is_st)
    h, l, c, p, positive, st = _arrays(high, low, close, prev_close, is_st, index, columns)
    up, down = _bands(p, positive, st, columns)
    status = _status(h, l, c, up, down, positive)
    streak = _streak(status, positive)
    return LimitEventTables(
        status=pd.DataFrame(status, index=index, columns=columns),
        streak=pd.DataFrame(streak, index=index, columns=columns),
    )


def _validate_pair(status: pd.DataFrame, streak: pd.DataFrame) -> None:
    _validate(status, "status")
    _validate(streak, "streak")
    if not streak.index.equals(status.index) or not streak.columns.equals(status.columns):
        raise ValueError("streak must share status's index and columns")


def daily_summary(status: pd.DataFrame, streak: pd.DataFrame) -> pd.DataFrame:
    """Per-day limit pool: counts, seal rate, broken rate and breadth."""
    _validate_pair(status, streak)
    values = status.to_numpy()
    valid = np.array([v is not None for v in values.ravel()], dtype=bool).reshape(values.shape)
    up = values == STATUS_UP
    down = values == STATUS_DOWN
    broken_up = values == STATUS_BROKEN_UP
    broken_down = values == STATUS_BROKEN_DOWN
    counts = {
        "n_valid": valid.sum(axis=1),
        "limit_up": up.sum(axis=1),
        "limit_down": down.sum(axis=1),
        "broken_up": broken_up.sum(axis=1),
        "broken_down": broken_down.sum(axis=1),
    }
    touched_up = counts["limit_up"] + counts["broken_up"]
    touched_down = counts["limit_down"] + counts["broken_down"]
    streak_values = streak.to_numpy(dtype=float)
    with np.errstate(invalid="ignore", divide="ignore"):
        seal_rate = np.where(touched_up > 0, counts["limit_up"] / touched_up, np.nan)
        broken_rate = np.where(touched_up > 0, counts["broken_up"] / touched_up, np.nan)
        limit_up_ratio = np.where(
            counts["n_valid"] > 0, counts["limit_up"] / counts["n_valid"], np.nan
        )
    max_board = np.where(
        counts["limit_up"] > 0,
        np.nanmax(np.where(np.isfinite(streak_values), streak_values, -np.inf), axis=1),
        np.nan,
    )
    frame = pd.DataFrame(
        {
            "n_valid": counts["n_valid"],
            "limit_up": counts["limit_up"],
            "limit_down": counts["limit_down"],
            "broken_up": counts["broken_up"],
            "broken_down": counts["broken_down"],
            "touched_up": touched_up,
            "touched_down": touched_down,
            "seal_rate": seal_rate,
            "broken_rate": broken_rate,
            "limit_up_ratio": limit_up_ratio,
            "max_board": max_board,
        },
        index=status.index,
    )
    return frame[_DAILY_COLUMNS]


def board_ladder(streak: pd.DataFrame) -> pd.DataFrame:
    """Counts per consecutive-board level (``board_1``..``board_N``)."""
    _validate(streak, "streak")
    values = streak.to_numpy(dtype=float)
    finite = np.isfinite(values)
    max_board = int(np.nanmax(values[finite])) if finite.any() else 0
    data = {
        f"board_{level}": ((values == level).sum(axis=1)).astype(np.int64)
        for level in range(1, max_board + 1)
    }
    return pd.DataFrame(data, index=streak.index)


def promotion_rates(streak: pd.DataFrame) -> pd.DataFrame:
    """Per-level promotion probability from yesterday's N board to today's N+1."""
    _validate(streak, "streak")
    values = streak.to_numpy(dtype=float)
    if values.shape[0] == 0:
        previous = values.copy()
    else:
        previous = np.vstack([np.full((1, values.shape[1]), np.nan), values[:-1]])
    finite = np.isfinite(values)
    max_board = int(np.nanmax(values[finite])) if finite.any() else 0
    data: dict[str, np.ndarray] = {}
    promoted_total = np.zeros(values.shape[0], dtype=np.int64)
    for level in range(1, max_board + 1):
        base = (previous == level).sum(axis=1).astype(np.int64)
        promoted = ((previous == level) & (values == level + 1)).sum(axis=1).astype(np.int64)
        promoted_total += promoted
        data[f"base_{level}"] = base
        data[f"promoted_{level}"] = promoted
        with np.errstate(invalid="ignore", divide="ignore"):
            data[f"rate_{level}"] = np.where(base > 0, promoted / base, np.nan)
    base_total = (previous >= 1).sum(axis=1).astype(np.int64)
    with np.errstate(invalid="ignore", divide="ignore"):
        overall = np.where(base_total > 0, promoted_total / base_total, np.nan)
    data["base_total"] = base_total
    data["promoted_total"] = promoted_total
    data["overall"] = overall
    return pd.DataFrame(data, index=streak.index)


def events_long(status: pd.DataFrame, streak: pd.DataFrame) -> pd.DataFrame:
    """Archive-shaped long table of valid symbol-days."""
    _validate_pair(status, streak)
    values = status.to_numpy()
    mask = np.array([v is not None for v in values.ravel()], dtype=bool).reshape(values.shape)
    rows, cols = np.nonzero(mask)
    events = pd.DataFrame(
        {
            "trade_date": status.index.to_numpy()[rows],
            "instrument": status.columns.to_numpy()[cols],
            "status": values[mask],
            "streak": streak.to_numpy(dtype=float)[mask],
        }
    )
    events = events.sort_values(["trade_date", "instrument"], kind="mergesort")
    return events.reset_index(drop=True)


def limit_pool(high, low, close, prev_close, *, is_st=None) -> LimitPoolTables:
    """All four research tables plus the archive long table in one call."""
    tables = limit_events(high, low, close, prev_close, is_st=is_st)
    return LimitPoolTables(
        status=tables.status,
        streak=tables.streak,
        daily=daily_summary(tables.status, tables.streak),
        ladder=board_ladder(tables.streak),
        promotion=promotion_rates(tables.streak),
        events=events_long(tables.status, tables.streak),
    )
