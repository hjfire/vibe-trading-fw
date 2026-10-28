# G3（第 1 档）实现计划：涨停池、连板天梯与炸板率

日期：2026-10-28
依据：`superpowers/specs/2026-10-28-g3-limit-pool-design.md`（已随片落仓）

## Global Constraints

- 纯函数，无 I/O／网络／时钟；只用 numpy / pandas；不新增依赖。
- 未复权价是硬前提；`prev_close` 显式传入，不做 `shift(1)` 回退。
- 复用 `paper_trade.limits_cn_a.heuristic_limit_prices`（函数内 import，保持模块导入轻）；
  不修改该文件一个字节。
- TDD：先写测试跑红，再写实现跑绿。
- 提交一律 `git commit -s` ＋ 显式 pathspec；不碰 `wiki/**`。
- 变异注入后必须还原（用动手前的内存副本/`git show` 内容写回并核对 sha）。
- 恒红门先证「本片 0 贡献」再报告；不调阈值、不修门、不清白名单。

## File Structure

- Create: `agent/tests/factors/test_limit_pool.py`（Task 1）
- Create: `agent/src/factors/limit_pool.py`（Task 2）

---

## Task 1: RED — 测试面

**Files:** Create `agent/tests/factors/test_limit_pool.py`

写完整测试文件后运行：

```bash
cd agent && python -m pytest tests/factors/test_limit_pool.py -q 2>&1 | tail -5
```

期望：`ModuleNotFoundError: No module named 'src.factors.limit_pool'`。

测试文件全文（执行时按此落盘）：

```python
"""Limit-pool hand vectors and no-lookahead pins (G3 design).

Every expected number is derivable by hand; the derivation lives in
``superpowers/specs/2026-10-28-g3-limit-pool-design.md`` section 4.
"""

from __future__ import annotations

from decimal import ROUND_HALF_UP, Decimal

import numpy as np
import pandas as pd
import pytest

from src.factors.limit_pool import (
    LimitPoolTables,
    board_ladder,
    daily_summary,
    events_long,
    limit_events,
    limit_pool,
    limit_prices,
    promotion_rates,
)

MAIN = ["000001.SZ", "000002.SZ", "000003.SZ", "000004.SZ", "000005.SZ"]


def _panel(rows, columns, start="2024-01-02"):
    idx = pd.bdate_range(start, periods=len(rows))
    return pd.DataFrame(rows, index=idx, columns=columns, dtype=float)


def _vector_b():
    idx = pd.bdate_range("2024-01-02", periods=2)
    cols = MAIN
    high = _panel([[11.00, 11.00, 10.90, 10.50, 10.50],
                   [12.10, 11.88, 9.90, 8.20, 10.20]], cols)
    low = _panel([[10.20, 10.50, 9.00, 9.00, 9.50],
                  [11.50, 11.00, 8.50, 8.10, 9.80]], cols)
    close = _panel([[11.00, 10.80, 9.00, 9.05, 10.00],
                    [12.10, 11.88, 9.90, 8.15, 10.00]], cols)
    prev = _panel([[10.00, 10.00, 10.00, 10.00, 10.00],
                   [11.00, 10.80, 9.00, 9.05, 10.00]], cols)
    return high, low, close, prev


# ── 4.1 limit prices ──────────────────────────────────────────────────────

def test_vector_a_limit_prices_by_board_and_st():
    cases = [
        (10.00, "000001.SZ", False, (11.00, 9.00)),
        (10.00, "300001.SZ", False, (12.00, 8.00)),
        (10.00, "688001.SH", False, (12.00, 8.00)),
        (10.00, "920001.BJ", False, (13.00, 7.00)),
        (10.00, "000001.SZ", True, (10.50, 9.50)),
        (10.00, "300001.SZ", True, (12.00, 8.00)),  # ST does not narrow 20%
        (2.05, "000001.SZ", False, (2.26, 1.85)),   # ROUND_HALF_UP, not banker's
        (10.03, "000001.SZ", False, (11.03, 9.03)),
    ]
    for prev_close, symbol, is_st, expected in cases:
        assert limit_prices(prev_close, symbol, is_st) == expected


def test_vector_a_non_positive_prev_close_raises():
    with pytest.raises(ValueError):
        limit_prices(0.0, "000001.SZ", False)


# ── 4.2 status + daily pool ───────────────────────────────────────────────

def test_vector_b_status_table():
    high, low, close, prev = _vector_b()
    tables = limit_events(high, low, close, prev)
    assert tables.status.values.tolist() == [
        ["up", "broken_up", "down", "broken_down", "none"],
        ["up", "up", "up", "down", "none"],
    ]
    np.testing.assert_allclose(
        tables.streak.to_numpy(),
        [[1.0, 0.0, 0.0, 0.0, 0.0], [2.0, 1.0, 1.0, 0.0, 0.0]],
        equal_nan=True,
    )


def test_vector_b_daily_summary():
    high, low, close, prev = _vector_b()
    tables = limit_events(high, low, close, prev)
    daily = daily_summary(tables.status, tables.streak)
    assert daily["n_valid"].tolist() == [5, 5]
    assert daily["limit_up"].tolist() == [1, 3]
    assert daily["limit_down"].tolist() == [1, 1]
    assert daily["broken_up"].tolist() == [1, 0]
    assert daily["broken_down"].tolist() == [1, 0]
    assert daily["touched_up"].tolist() == [2, 3]
    assert daily["touched_down"].tolist() == [2, 1]
    np.testing.assert_allclose(daily["seal_rate"].to_numpy(), [0.5, 1.0])
    np.testing.assert_allclose(daily["broken_rate"].to_numpy(), [0.5, 0.0])
    np.testing.assert_allclose(daily["limit_up_ratio"].to_numpy(), [0.2, 0.6])
    np.testing.assert_allclose(daily["max_board"].to_numpy(), [1.0, 2.0])


def test_vector_b_ladder_and_promotion():
    high, low, close, prev = _vector_b()
    tables = limit_events(high, low, close, prev)
    ladder = board_ladder(tables.streak)
    assert ladder.columns.tolist() == ["board_1", "board_2"]
    assert ladder["board_1"].tolist() == [1, 2]
    assert ladder["board_2"].tolist() == [0, 1]
    promotion = promotion_rates(tables.streak)
    np.testing.assert_allclose(promotion["rate_1"].to_numpy(), [np.nan, 1.0], equal_nan=True)
    assert np.isnan(promotion["rate_2"].iloc[0]) and np.isnan(promotion["rate_2"].iloc[1])
    assert promotion["base_total"].tolist() == [0, 1]
    assert promotion["promoted_total"].tolist() == [0, 1]
    np.testing.assert_allclose(promotion["overall"].to_numpy(), [np.nan, 1.0], equal_nan=True)


# ── 4.3 streak break on a missing bar ─────────────────────────────────────

def test_vector_c_missing_bar_breaks_the_chain():
    cols = ["000001.SZ"]
    high = _panel([[11.00], [11.20], [12.10], [np.nan], [13.31], [14.64], [14.90]], cols)
    low = _panel([[10.50], [10.80], [11.50], [np.nan], [13.31], [14.64], [14.50]], cols)
    close = _panel([[11.00], [11.00], [12.10], [np.nan], [13.31], [14.64], [14.70]], cols)
    prev = _panel([[10.00], [11.00], [11.00], [12.10], [12.10], [13.31], [14.64]], cols)
    tables = limit_events(high, low, close, prev)
    np.testing.assert_allclose(
        tables.streak["000001.SZ"].to_numpy(),
        [1.0, 0.0, 1.0, np.nan, 1.0, 2.0, 0.0],
        equal_nan=True,
    )
    assert tables.status["000001.SZ"].tolist() == [
        "up", "none", "up", None, "up", "up", "none",
    ]
    daily = daily_summary(tables.status, tables.streak)
    assert daily["n_valid"].tolist() == [1, 1, 1, 0, 1, 1, 1]


# ── 4.4 ladder + promotion over three days ───────────────────────────────

def _vector_d():
    cols = ["000010.SZ", "000011.SZ", "000012.SZ", "000013.SZ"]  # P Q R S
    high = _panel([
        [11.00, 11.00, 10.20, 11.00],
        [12.10, 12.10, 11.00, 12.10],
        [13.31, 12.20, 11.20, 13.31],
    ], cols)
    low = _panel([
        [10.50, 10.50, 9.90, 10.50],
        [11.50, 11.50, 10.90, 11.50],
        [13.31, 11.80, 10.90, 13.31],
    ], cols)
    close = _panel([
        [11.00, 11.00, 10.00, 11.00],
        [12.10, 12.10, 11.00, 12.10],
        [13.31, 12.00, 11.20, 13.31],
    ], cols)
    prev = _panel([
        [10.00, 10.00, 10.00, 10.00],
        [11.00, 11.00, 10.00, 11.00],
        [12.10, 12.10, 11.00, 12.10],
    ], cols)
    return high, low, close, prev


def test_vector_d_ladder():
    high, low, close, prev = _vector_d()
    tables = limit_events(high, low, close, prev)
    np.testing.assert_allclose(
        tables.streak.to_numpy(),
        [[1, 1, 0, 1], [2, 2, 1, 2], [3, 0, 0, 3]],
    )
    ladder = board_ladder(tables.streak)
    assert ladder.columns.tolist() == ["board_1", "board_2", "board_3"]
    assert ladder["board_1"].tolist() == [3, 1, 0]
    assert ladder["board_2"].tolist() == [0, 3, 0]
    assert ladder["board_3"].tolist() == [0, 0, 2]


def test_vector_d_promotion_rates():
    high, low, close, prev = _vector_d()
    tables = limit_events(high, low, close, prev)
    promotion = promotion_rates(tables.streak)
    assert promotion["base_1"].tolist() == [0, 3, 1]
    assert promotion["promoted_1"].tolist() == [0, 3, 0]
    assert promotion["base_2"].tolist() == [0, 0, 3]
    assert promotion["promoted_2"].tolist() == [0, 0, 2]
    np.testing.assert_allclose(
        promotion["rate_2"].to_numpy(), [np.nan, np.nan, 2.0 / 3.0], equal_nan=True
    )
    np.testing.assert_allclose(promotion["rate_1"].to_numpy(), [np.nan, 1.0, 0.0], equal_nan=True)
    assert promotion["base_total"].tolist() == [0, 3, 4]
    assert promotion["promoted_total"].tolist() == [0, 3, 2]
    np.testing.assert_allclose(
        promotion["overall"].to_numpy(), [np.nan, 1.0, 0.5], equal_nan=True
    )


# ── 4.5 one tick is the whole difference ─────────────────────────────────

def test_vector_e_one_tick_separates_sealed_from_broken():
    cols = ["000001.SZ"]
    high = _panel([[11.00], [11.00], [10.20], [10.20]], cols)
    low = _panel([[10.50], [10.50], [9.00], [9.00]], cols)
    close = _panel([[10.99], [11.00], [9.01], [9.00]], cols)
    prev = _panel([[10.00], [10.00], [10.00], [10.00]], cols)
    tables = limit_events(high, low, close, prev)
    assert tables.status["000001.SZ"].tolist() == [
        "broken_up", "up", "broken_down", "down",
    ]


# ── ST + board ratios through the panel path ─────────────────────────────

def test_st_and_growth_board_limits_are_applied_per_symbol():
    idx = pd.bdate_range("2024-01-02", periods=1)
    cols = ["000001.SZ", "300001.SZ", "920001.BJ"]
    high = _panel([[10.50, 12.00, 13.00]], cols)
    low = _panel([[10.50, 12.00, 13.00]], cols)
    close = _panel([[10.50, 12.00, 13.00]], cols)
    prev = _panel([[10.00, 10.00, 10.00]], cols)
    st = pd.DataFrame([[True, False, False]], index=idx, columns=cols)
    tables = limit_events(high, low, close, prev, is_st=st)
    assert tables.status.values.tolist() == [["up", "up", "up"]]

    tables_plain = limit_events(high, low, close, prev)
    assert tables_plain.status.values.tolist() == [["none", "up", "up"]]


# ── no-lookahead pins ────────────────────────────────────────────────────

def _band(prev: float, ratio: float = 0.10) -> tuple[float, float]:
    """Independent hand tick rule (mirrors vector A); never calls the module."""
    base = Decimal(str(prev))
    tick = Decimal("0.01")
    up = (base * (Decimal(1) + Decimal(str(ratio)))).quantize(tick, rounding=ROUND_HALF_UP)
    down = (base * (Decimal(1) - Decimal(str(ratio)))).quantize(tick, rounding=ROUND_HALF_UP)
    return float(up), float(down)


def _limit_heavy_panel(rows=40):
    """Deterministic panel that hits every status, so the pins cannot go vacuous.

    Symbol A seals up every day (streak 1..rows), B alternates up/none,
    C touches the up limit without sealing, D seals down every 4th day,
    E breaks the down limit every 5th day.
    """
    columns = ["000001.SZ", "000002.SZ", "000003.SZ", "000004.SZ", "000005.SZ"]
    plan = [
        lambda t: "up",
        lambda t: "up" if t % 2 == 0 else "none",
        lambda t: "broken_up" if t % 3 == 0 else "none",
        lambda t: "down" if t % 4 == 0 else "up",
        lambda t: "broken_down" if t % 5 == 0 else "none",
    ]
    idx = pd.bdate_range("2024-01-02", periods=rows)
    arrays = {
        name: np.zeros((rows, len(columns))) for name in ("high", "low", "close", "prev")
    }
    for j, symbol in enumerate(columns):
        price = 10.0
        for t in range(rows):
            up, down = _band(price)
            kind = plan[j](t)
            arrays["prev"][t, j] = price
            if kind == "up":
                high = low = close = up
            elif kind == "down":
                high, low, close = price, down, down
            elif kind == "broken_up":
                high, low, close = up, price, up - 0.02
            elif kind == "broken_down":
                high, low, close = price, down, down + 0.02
            else:
                high, low, close = price + 0.01, price - 0.01, price
            arrays["high"][t, j] = high
            arrays["low"][t, j] = low
            arrays["close"][t, j] = close
            price = close
    return tuple(
        pd.DataFrame(arrays[name], index=idx, columns=columns)
        for name in ("high", "low", "close", "prev")
    )


def test_fixture_hits_every_status():
    h, l, c, p = _limit_heavy_panel()
    seen = set(limit_events(h, l, c, p).status.to_numpy().ravel().tolist())
    assert {"up", "down", "broken_up", "broken_down", "none"} <= seen


def test_prefix_equals_full_history():
    h, l, c, p = _limit_heavy_panel()
    full = limit_pool(h, l, c, p)
    for k in (1, 13, 30):
        part = limit_pool(h.iloc[:k], l.iloc[:k], c.iloc[:k], p.iloc[:k])
        pd.testing.assert_frame_equal(part.status, full.status.iloc[:k])
        pd.testing.assert_frame_equal(part.streak, full.streak.iloc[:k])
        pd.testing.assert_frame_equal(part.daily, full.daily.iloc[:k])
        # Ladder/promotion schemas enumerate every board level seen in the
        # sample, so a shorter history legitimately carries fewer columns;
        # the past rows must agree on every column the prefix produced.
        for short, long in ((part.ladder, full.ladder), (part.promotion, full.promotion)):
            shared = [column for column in short.columns if column in long.columns]
            pd.testing.assert_frame_equal(short[shared], long[shared].iloc[:k])
        pd.testing.assert_frame_equal(
            part.events, full.events[full.events["trade_date"] < h.index[k]]
        )


def test_future_bars_do_not_change_past_tables():
    h, l, c, p = _limit_heavy_panel()
    before = limit_pool(h, l, c, p)
    cut = 25
    h2, l2, c2 = h.copy(), l.copy(), c.copy()
    h2.iloc[cut:] *= 3.0
    l2.iloc[cut:] *= 0.5
    c2.iloc[cut:] *= 2.0
    after = limit_pool(h2, l2, c2, p)
    for before_frame, after_frame in (
        (before.status, after.status),
        (before.streak, after.streak),
        (before.daily, after.daily),
    ):
        pd.testing.assert_frame_equal(before_frame.iloc[:cut], after_frame.iloc[:cut])
    for before_frame, after_frame in ((before.ladder, after.ladder), (before.promotion, after.promotion)):
        shared = [column for column in before_frame.columns if column in after_frame.columns]
        pd.testing.assert_frame_equal(
            before_frame[shared].iloc[:cut], after_frame[shared].iloc[:cut]
        )


# ── identities + validation + empty ──────────────────────────────────────

def test_rates_are_internally_consistent():
    h, l, c, p = _limit_heavy_panel()
    tables = limit_pool(h, l, c, p)
    daily = tables.daily
    touched = daily["touched_up"] > 0
    assert touched.sum() > 0
    np.testing.assert_allclose(
        (daily.loc[touched, "seal_rate"] + daily.loc[touched, "broken_rate"]).to_numpy(), 1.0
    )
    promotion = tables.promotion
    assert (promotion["promoted_total"] <= promotion["base_total"]).all()
    assert promotion["base_total"].max() > 0
    levels = [
        int(column.split("_")[1])
        for column in promotion.columns
        if column.startswith("base_") and column != "base_total"
    ]
    for level in levels:
        base = promotion[f"base_{level}"]
        rate = promotion[f"rate_{level}"]
        mask = base > 0
        np.testing.assert_allclose(
            rate[mask].to_numpy(),
            (promotion[f"promoted_{level}"][mask] / base[mask]).to_numpy(),
        )


def test_misaligned_panels_raise():
    high, low, close, prev = _vector_b()
    with pytest.raises(ValueError):
        limit_events(high, low, close, prev.rename(columns={MAIN[0]: "000099.SZ"}))


def test_non_increasing_index_raises():
    high, low, close, prev = _vector_b()
    reversed_index = high.index[::-1]
    with pytest.raises(ValueError):
        limit_events(
            high.set_axis(reversed_index), low.set_axis(reversed_index),
            close.set_axis(reversed_index), prev.set_axis(reversed_index),
        )


def test_non_positive_prev_close_in_panel_raises():
    high, low, close, prev = _vector_b()
    bad = prev.copy()
    bad.iloc[0, 0] = 0.0
    with pytest.raises(ValueError):
        limit_events(high, low, close, bad)


def test_high_below_low_raises():
    high, low, close, prev = _vector_b()
    bad = low.copy()
    bad.iloc[0, 0] = 11.50  # above high 11.00
    with pytest.raises(ValueError):
        limit_events(high, bad, close, prev)


def test_empty_panel_returns_empty_tables():
    idx = pd.DatetimeIndex([], name="trade_date")
    cols = ["000001.SZ"]
    empty = pd.DataFrame(index=idx, columns=cols, dtype=float)
    tables = limit_pool(empty, empty, empty, empty)
    assert isinstance(tables, LimitPoolTables)
    assert tables.status.empty and tables.streak.empty
    assert tables.daily.empty and tables.daily.columns.tolist() == [
        "n_valid", "limit_up", "limit_down", "broken_up", "broken_down",
        "touched_up", "touched_down", "seal_rate", "broken_rate",
        "limit_up_ratio", "max_board",
    ]
    assert tables.ladder.empty and tables.ladder.columns.tolist() == []
    assert tables.promotion.empty
    assert tables.events.empty and tables.events.columns.tolist() == [
        "trade_date", "instrument", "status", "streak",
    ]


def test_events_long_is_the_archive_shape():
    high, low, close, prev = _vector_b()
    tables = limit_pool(high, low, close, prev)
    assert len(tables.events) == 10
    assert tables.events.columns.tolist() == ["trade_date", "instrument", "status", "streak"]
    assert tables.events.iloc[0]["instrument"] == MAIN[0]
    assert tables.events["status"].tolist()[0] == "up"
```

---

## Task 2: GREEN — 实现

**Files:** Create `agent/src/factors/limit_pool.py`

```python
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
```

运行：

```bash
cd agent && python -m pytest tests/factors/test_limit_pool.py -q 2>&1 | tail -5
```

期望：全绿（枚数执行时现数，不预写）。

---

## Task 3: 变异自证 M1–M5

逐条注入 → 跑测试必须真红 → 从动手前的内存副本还原 → 复绿。
记录每条的失败枚数与失败用例名。

- **M1**：`_bands` 里绕开 `heuristic_limit_prices`，改用
  `round(prev_close * (1 + ratio), 2)`（银行家舍入）→ 向量 A 后两行红。
- **M2**：`_status` 把 `broken_up` 也标成 `STATUS_UP` → 向量 B 第 1 日
  `seal_rate`／`broken_rate` 红。
- **M3**：`_streak` 非涨停日不归零（保留上一个值）→ 向量 C/D 红。
- **M4**：`promotion_rates` 把 `values == level + 1` 改成 `values >= level + 1`
  → 向量 D 第 3 日 `promoted_2=3` 红。
  **2026-10-28 执行更正**：该式在 `_streak` 的可达域上与原式恒等（streak 只能
  `previous + 1` 或归零，永远不会跳过 `level + 1`；60 个随机面板差分比较 0 差异），
  是等价变异、不能判别。改用 `values == level`（promoted 恒 0）作替代探针：
  `test_vector_b_ladder_and_promotion` 与 `test_vector_d_promotion_rates` 两针真红。
- **M5**：`_status` 用下一行 high 判 `broken_up`（`np.vstack([h[1:], h[-1:]])`）
  → 前缀/污染两针红。

---

## Task 4: 门禁、档案 §7.34、提交

```bash
cd agent && python -m pytest tests/factors -q 2>&1 | tail -3
cd .. && bash tools/ci_grep_gates.sh; echo "grep-gates rc=$?"
python -m pytest tools/test_wiki_drift.py -q 2>&1 | tail -3
bash tools/wiki_freshness_gate.sh; echo "watermark rc=$?"
```

后端全量新增红为 0（与同树基线名单取差集）；恒红门先证「本片 0 贡献」。
档案按仓库实际格式追加 `### 7.34 G3…`（bytes 层、CRLF），读数现填。
提交：

```bash
git add agent/src/factors/limit_pool.py agent/tests/factors/test_limit_pool.py 项目档案.md superpowers/specs/2026-10-28-g3-limit-pool-design.md superpowers/plans/2026-10-28-g3-limit-pool.md
git commit -s -m "feat(factors): limit-up pool, board ladder and broken-board rates" -m "Pure engine over unadjusted OHLC plus an explicit previous close; band ratios reuse the execution-side primitive and the ST/ROUND_HALF_UP quantisation is the paper-trade implementation. Hand vectors A-E, prefix and future-pollution pins, five mutations." -m "Signed-off-by: hjfire <307501063+...>"
```

推送前 `git ls-remote origin refs/heads/main` 对真值；cron 推进则 `git merge`（不 rebase）并复跑门禁。

---

## 执行期偏差（2026-10-28 回填）

- **RED**：`cd agent && python -m pytest tests/factors/test_limit_pool.py -q`
  → `ModuleNotFoundError: No module named 'src.factors.limit_pool'`（收集期，
  与计划预期一致）。
- **GREEN**：同一命令 `20 passed`（3.2s 级）。
- **变异自证（六针全部真红，逐条从动手前内存副本还原并比对 sha256）**：
  - M1（`_bands` 绕开价带原语、改银行家舍入）→ `2 failed`：
    `test_vector_b_status_table`、`test_vector_b_daily_summary`。
    **与计划预期不符**：向量 A 的两条用例直接调 `limit_prices` 标量包装、
    不经 `_bands`，故不会红；真正红的是面板路径上 `9.05 × 0.9 = 8.145 →
    8.14`（HALF_EVEN）把 D 从 `down` 改判 `broken_down`。计划里「向量 A
    后两行红」这句是错的，补 M1b 作为该判据的真正探针。
  - M1b（`limit_prices` 标量包装改银行家舍入）→ `4 failed`：含
    `test_vector_a_limit_prices_by_board_and_st`（`2.255 → 2.25`、
    `1.845 → 1.84`）与 `test_vector_a_non_positive_prev_close_raises`
    （注入版不再走既有函数的非正检查）。
  - M2（炸板记成涨停）→ `5 failed`：向量 B 状态与日表、向量 E、
    夹具覆盖针。
  - M3（非涨停不归零）→ `2 failed`：向量 C、向量 D 天梯。
  - M4′（`values == level`，promoted 恒 0）→ `2 failed`：向量 B 与 D 的
    晋级针。（原 M4 `>= level + 1` 是等价变异，见 Task 3 的执行更正。）
  - M5（用下一行 high 判炸板）→ `3 failed`：向量 C、前缀==全量、未来污染。
  - 还原后复跑 `20 passed`；`agent/src/factors/limit_pool.py` 的 sha256
    前后均为 `bceefc0e5e26c2954189c762f43e07bed60e2a348c1ca3401140d348230b9f6c`。
- **门册读数**（同一棵树，逐条现读）：
  - A `cd agent && python -m pytest tests/factors -q`：
    `2064 passed, 76 skipped`，rc 0。
  - B 后端全量（与 §7.33 基线同一命令行）：`87 failed, 21820 passed,
    206 skipped, 4 errors in 764.26s`。对基线 `86 failed, 21781 passed,
    206 skipped, 4 errors` 取 FAILED 名集合差：新增 1
    （`test_rate_limiter_memory.py::test_empty_buckets_are_evicted_after_window_expires`）、
    消失 0。该条为 10ms 墙钟 flake（`window_seconds=0.05` 对 `sleep(0.06)`），
    与本片文件路径交集为 0，单用例五跑 4 绿 1 红，且在 §7.33 已记为基线
    独有红 ⇒ 本片新增红＝0。passes 净增 39＝40 枚新测试 − 1 枚转红。
  - C `bash tools/ci_grep_gates.sh`：rc=1，仅 `[gate b]`；36 个命中文件全为
    未跟踪本地文档（`./.superpowers/**` 35 个＋
    `.qoder/repowiki/knowledge/zh/.../架构设计.md` 1 个），跟踪面命中 0。
  - D `python -m pytest tools/test_ci_env_var_gate.py
    tools/test_ci_private_files_gate.py tools/test_doc_tables.py -q`：
    `1 failed, 51 passed`，红为 `docs/notes with spaces\nand newline.md`
    （Windows 建不了换行文件名的既知红），与 §7.33 同读数。
  - E `python -m pytest tools/test_wiki_drift.py -q`：`240 passed`，rc 0。
  - F `bash tools/wiki_freshness_gate.sh`：`wiki stale pages: 447
    (threshold 439)` rc=1，与 §7.32／§7.33 同读数；本片未动
    `wiki/`／`repowiki/`。
- **未做**：不与 tushare `limit_list_d`／`limit_step` 做数值对账（本机无
  积分）；不接 API／CLI／前端（本片无接线）。
