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
