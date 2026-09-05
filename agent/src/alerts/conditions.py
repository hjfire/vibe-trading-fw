"""Pure condition evaluation for alert rules.

A rule's ``condition`` is a small operator dict; this module turns it into a
``{hit, reason, value}`` verdict over an :class:`EvalContext` the caller fills.

Two rules govern every branch here:

1. **The operator grammar is the screener's.** ``gt``, ``crossUp``, ``rising``
   and friends behave exactly as ``frontend/src/lib/screener.ts`` implements
   them (``crossUp`` is ``a.prev <= b.prev and a.last > b.last``), so what the
   app's screener shows and what the server alerts on cannot drift apart.
2. **A data failure is never a verdict.** Missing bars, a missing position, a
   short series or an unresolvable symbol returns ``error`` set and ``hit``
   false. The engine leaves the rule's state untouched on an error, so a
   vendor outage can neither fabricate an alert nor silently "resolve" one that
   is still true.

Indicator math is not reimplemented here — the SMA/EMA/RSI/MACD/Bollinger
helpers come from :mod:`src.tools.technical_indicator_tool`, which is the same
code the agent's indicator tool and the shadow-account extractor use.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Any, Dict, List, Mapping, Optional, Sequence

import pandas as pd

from src.alerts.models import CONDITION_OPS

# ---------------------------------------------------------------------------
# Value objects
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SeriesBundle:
    """The last two points of one named series, plus how much data backed it.

    Attributes:
        name: The series name as written in the rule.
        last: Newest value (``None`` when unavailable).
        prev: The value one bar earlier, required by crossings and slopes.
        bars: How many data points the series was built from.
        error: Why the series could not be built, when it could not.
    """

    name: str
    last: Optional[float] = None
    prev: Optional[float] = None
    bars: int = 0
    error: Optional[str] = None

    @property
    def ok(self) -> bool:
        """Whether at least the newest value exists."""
        return self.error is None and self.last is not None


@dataclass
class EvalContext:
    """Everything one rule evaluation may look at.

    The engine owns how the fields get filled (bar loader, portfolio service,
    inbound event), so evaluation stays a pure function of this snapshot and
    tests can hand it literal numbers.

    Attributes:
        symbol: Canonical symbol the bars belong to.
        bars: Oldest-first OHLCV dicts with ``timestamp``/``open``/``high``/
            ``low``/``close``/``volume``.
        positions: Portfolio position rows (normalized shape: ``symbol``,
            ``cost_price``, ``market_price``, ``quantity``, ``market_value_usd``).
        account_history: Portfolio equity snapshots, **oldest first** (``total_usd``
            / ``total_cny`` / ``created_at``) for account-level series.
        event: Normalized inbound event values (``price`` / ``value`` /
            ``change_pct``), used only by event rules.
        errors: Data-source failures collected while filling the context. They
            are reported on the verdict so a rule never looks "false" when it
            simply could not be measured.
    """

    symbol: str = ""
    bars: List[Dict[str, Any]] = field(default_factory=list)
    positions: List[Mapping[str, Any]] = field(default_factory=list)
    account_history: List[Mapping[str, Any]] = field(default_factory=list)
    event: Optional[Mapping[str, Any]] = None
    errors: List[str] = field(default_factory=list)

    def close(self) -> pd.Series:
        """Return the close series (oldest first), empty when there are no bars."""
        values: List[float] = []
        for bar in self.bars:
            raw = bar.get("close")
            if raw is None:
                continue
            try:
                value = float(raw)  # type: ignore[arg-type]
            except (TypeError, ValueError):
                continue
            if pd.isna(value):
                continue
            values.append(value)
        return pd.Series(values, dtype="float64")

    def position(self, symbol: str) -> Optional[Mapping[str, Any]]:
        """Return the holding for *symbol*, matched across broker symbol shapes."""
        want = _match_key(symbol or self.symbol)
        if not want:
            return None
        rows = [row for row in self.positions if str(row.get("symbol") or "").strip()]
        for row in rows:
            if str(row.get("symbol") or "").strip().upper() == (symbol or self.symbol).strip().upper():
                return row
        for row in rows:
            if _match_key(row.get("symbol")) == want:
                return row
        return None


@dataclass(frozen=True)
class ConditionResult:
    """One evaluation's verdict.

    Attributes:
        hit: Whether the condition holds on the newest bar.
        reason: Human-readable note (Chinese, like the screener's). Empty when
            it hit and there is nothing extra to say.
        value: The lhs newest value, for the message and the UI.
        error: Data failure. When set, ``hit`` is not a real verdict and the
            engine must not change the rule's state.
        bars: How many data points backed the lhs series.
    """

    hit: bool
    reason: str = ""
    value: Optional[float] = None
    error: Optional[str] = None
    bars: int = 0

    def as_dict(self) -> Dict[str, Any]:
        """Return a JSON-safe dict for the API layer."""
        return {
            "hit": self.hit,
            "reason": self.reason,
            "value": self.value,
            "error": self.error,
            "bars": self.bars,
        }


# ---------------------------------------------------------------------------
# Series resolution
# ---------------------------------------------------------------------------


def _pair(series: pd.Series, compute) -> tuple[Optional[float], Optional[float]]:  # type: ignore[no-untyped-def]
    """Compute *compute* on the full series and on all-but-the-last bar.

    Returning ``(last, prev)`` from one helper is what makes ``crossUp`` and
    ``rising`` well-defined for indicators as well as for raw prices: the
    previous value is always "the same indicator, one bar shorter", never a
    value cached from an earlier poll.
    """
    if len(series) == 0:
        return None, None
    last = compute(series)
    prev = compute(series.iloc[:-1]) if len(series) > 1 else None
    return last, prev


def _indicator_tools():
    """Return the shared indicator helpers, imported on first use.

    The math belongs to :mod:`src.tools.technical_indicator_tool` — the same
    Wilder-RSI / MACD / Bollinger the agent's indicator tool and the
    shadow-account extractor use — so this module must not re-derive it. The
    import is lazy because ``src.tools`` auto-discovers every tool module on
    import: a rule that only watches ``close > 1700`` should not pay for that
    (or risk an import cycle with a tool that imports alerts back).
    """
    global _INDICATOR_TOOLS
    if _INDICATOR_TOOLS is None:
        from src.tools.technical_indicator_tool import (
            _compute_bollinger,
            _compute_ema,
            _compute_macd,
            _compute_rsi,
            _compute_sma,
        )

        _INDICATOR_TOOLS = {
            "sma": _compute_sma,
            "ema": _compute_ema,
            "rsi": _compute_rsi,
            "macd_line": _compute_macd,
            "macd_signal": _compute_macd,
            "macd_hist": _compute_macd,
            "bb_upper": _compute_bollinger,
            "bb_middle": _compute_bollinger,
            "bb_lower": _compute_bollinger,
        }
    return _INDICATOR_TOOLS


_INDICATOR_TOOLS: Optional[Dict[str, Any]] = None


def _named_indicator(series: pd.Series, fn: str, period: int) -> tuple[Optional[float], Optional[float]]:
    """Resolve an indicator function by name over *series*."""
    tools = _indicator_tools()
    if fn == "sma":
        return _pair(series, lambda s: tools["sma"](s, period))
    if fn == "ema":
        return _pair(series, lambda s: tools["ema"](s, period))
    if fn == "rsi":
        return _pair(series, lambda s: tools["rsi"](s, period))
    if fn == "macd_line":
        return _pair(series, lambda s: (tools["macd_line"](s) or {}).get("macd_line"))
    if fn == "macd_signal":
        return _pair(series, lambda s: (tools["macd_signal"](s) or {}).get("signal_line"))
    if fn == "macd_hist":
        return _pair(series, lambda s: (tools["macd_hist"](s) or {}).get("histogram"))
    if fn == "bb_upper":
        return _pair(series, lambda s: (tools["bb_upper"](s) or {}).get("upper"))
    if fn == "bb_middle":
        return _pair(series, lambda s: (tools["bb_middle"](s) or {}).get("middle"))
    if fn == "bb_lower":
        return _pair(series, lambda s: (tools["bb_lower"](s) or {}).get("lower"))
    raise ValueError(f"unknown indicator {fn!r}")


def _split_name(name: str) -> tuple[str, int]:
    """Split ``rsi:14`` into ``("rsi", 14)``; an omitted period defaults to 14."""
    head, _, tail = name.partition(":")
    head = head.strip().lower()
    if not tail:
        return head, 14
    try:
        period = int(tail.strip())
    except ValueError as exc:
        raise ValueError(f"series {name!r} has a non-integer period") from exc
    if period < 1 or period > 500:
        raise ValueError(f"series {name!r} period must be between 1 and 500")
    return head, period


def _first_number(row: Mapping[str, Any], keys: Sequence[str]) -> Optional[float]:
    """Return the first finite numeric value among *keys* in *row*."""
    for key in keys:
        raw = row.get(key)
        if raw is None:
            continue
        try:
            value = float(raw)  # type: ignore[arg-type]
        except (TypeError, ValueError):
            continue
        if pd.isna(value):
            continue
        return value
    return None


def _match_key(symbol: Any) -> str:
    """Reduce a symbol to a venue-blind comparison key.

    Portfolio rows arrive in whatever shape the broker uses (``AAPL``,
    ``700.HK``, ``600519``, ``BTCUSDT``) while alert rules are written in this
    project's canonical form (``AAPL.US``, ``0700.HK``, ``600519.SH``,
    ``BTC-USDT``). Dropping the venue suffix, the separators, and HK/CN leading
    zeros is the comparison that lets a holding match its rule; anything that
    still does not match is genuinely a different instrument.
    """
    text = str(symbol or "").strip().upper()
    head = text.split(".")[0]
    core = re.sub(r"[^A-Z0-9]", "", head)
    if core.isdigit():
        return core.lstrip("0") or "0"
    return core


def resolve_series(name: str, ctx: EvalContext) -> SeriesBundle:
    """Build one named series out of *ctx*.

    Supported names: ``close``/``open``/``high``/``low``/``volume``,
    ``change_pct``, ``sma:N``, ``ema:N``, ``rsi:N``, ``macd_line``,
    ``macd_signal``, ``macd_hist``, ``bb_upper``, ``bb_middle``, ``bb_lower``,
    ``pnl_pct``, ``position_value``, ``quantity``, ``cost_price``,
    ``market_price``, ``equity_usd``, ``equity_cny``, ``drawdown_pct``,
    ``event_value``, ``event_price``, ``event_change_pct``.

    Args:
        name: Series name as written in the rule.
        ctx: The snapshot to read.

    Returns:
        A :class:`SeriesBundle`; ``error`` is set instead of a value when the
        data is missing or too short.
    """
    raw = str(name or "").strip()
    if not raw:
        return SeriesBundle(name=raw, error="条件里的序列名为空")

    # --- raw bar fields -------------------------------------------------
    if raw.lower() in ("close", "open", "high", "low", "volume"):
        col = raw.lower()
        values = [
            _first_number(bar, (col,)) for bar in ctx.bars
        ]
        clean = [v for v in values if v is not None]
        if not clean:
            return SeriesBundle(name=raw, error=f"没有 {col} 数据")
        return SeriesBundle(
            name=raw,
            last=clean[-1],
            prev=clean[-2] if len(clean) > 1 else None,
            bars=len(clean),
        )

    if raw.lower() == "change_pct":
        closes = [v for v in (_first_number(b, ("close",)) for b in ctx.bars) if v is not None]
        if len(closes) < 2:
            return SeriesBundle(name=raw, error="涨跌幅至少需要两根 K 线")
        last = (closes[-1] - closes[-2]) / closes[-2] * 100.0 if closes[-2] else 0.0
        prev: Optional[float] = None
        if len(closes) > 2:
            prev = (closes[-2] - closes[-3]) / closes[-3] * 100.0 if closes[-3] else 0.0
        return SeriesBundle(name=raw, last=last, prev=prev, bars=len(closes))

    # --- indicators -----------------------------------------------------
    fn, period = _split_name(raw)
    if fn in (
        "sma",
        "ema",
        "rsi",
        "macd_line",
        "macd_signal",
        "macd_hist",
        "bb_upper",
        "bb_middle",
        "bb_lower",
    ):
        series = ctx.close()
        if series.empty:
            return SeriesBundle(name=raw, error="没有可用于计算指标的 K 线")
        try:
            last, prev = _named_indicator(series, fn, period)
        except ValueError:
            raise
        if last is None:
            return SeriesBundle(
                name=raw, error=f"{raw} 数据不足（至少需要 {period + 1} 根）", bars=len(series)
            )
        return SeriesBundle(name=raw, last=last, prev=prev, bars=len(series))

    # --- portfolio ------------------------------------------------------
    if fn in ("pnl_pct", "position_value", "quantity", "cost_price", "market_price"):
        row = ctx.position(ctx.symbol)
        if row is None:
            return SeriesBundle(name=raw, error=f"持仓里没有 {ctx.symbol or '该标的'}")
        if fn == "pnl_pct":
            cost = _first_number(row, ("cost_price",))
            mark = _first_number(row, ("market_price",))
            if not cost or mark is None:
                return SeriesBundle(name=raw, error="该持仓没有成本或现价，无法算浮盈")
            return SeriesBundle(name=raw, last=(mark - cost) / cost * 100.0, bars=1)
        key = {
            "position_value": ("market_value_usd", "market_value_cny"),
            "quantity": ("quantity",),
            "cost_price": ("cost_price",),
            "market_price": ("market_price",),
        }[fn]
        value = _first_number(row, key)
        if value is None:
            return SeriesBundle(name=raw, error=f"持仓里 {ctx.symbol} 的 {fn} 不可用")
        return SeriesBundle(name=raw, last=value, bars=1)

    if fn in ("equity_usd", "equity_cny"):
        key = "total_usd" if fn == "equity_usd" else "total_cny"
        values = [v for v in (_first_number(row, (key,)) for row in ctx.account_history) if v is not None]
        if not values:
            return SeriesBundle(name=raw, error="还没有账户净值记录")
        return SeriesBundle(name=raw, last=values[-1], prev=values[-2] if len(values) > 1 else None, bars=len(values))

    if fn == "drawdown_pct":
        # History arrives oldest-first, so the peak to date is a running max over
        # the prefix — measured from the account's own high-water mark, not from
        # whatever the newest snapshot happens to be.
        values = [v for v in (_first_number(row, ("total_usd",)) for row in ctx.account_history) if v is not None]
        if len(values) < 2:
            return SeriesBundle(name=raw, error="账户回撤至少需要两条净值记录")
        peak = max(values)
        prev_peak = max(values[:-1])
        if peak <= 0 or prev_peak <= 0:
            return SeriesBundle(name=raw, error="账户净值为 0，无法计算回撤")
        last = (values[-1] - peak) / peak * 100.0
        prev = (values[-2] - prev_peak) / prev_peak * 100.0
        return SeriesBundle(name=raw, last=last, prev=prev, bars=len(values))

    # --- inbound event --------------------------------------------------
    if fn in ("event_value", "event_price", "event_change_pct"):
        if not ctx.event:
            return SeriesBundle(name=raw, error="还没有收到外部警报事件")
        keys = {
            "event_value": ("value", "price"),
            "event_price": ("price", "value"),
            "event_change_pct": ("change_pct", "percent"),
        }[fn]
        value = _first_number(ctx.event, keys)
        if value is None:
            return SeriesBundle(name=raw, error="外部警报事件里没有可用数值")
        return SeriesBundle(name=raw, last=value, bars=1)

    return SeriesBundle(name=raw, error=f"不支持的序列名 {raw}")


# ---------------------------------------------------------------------------
# Evaluation
# ---------------------------------------------------------------------------


def shown_number(value: Optional[float]) -> str:
    """Format a number the way the screener does: compact, no trailing zeros."""
    if value is None or not pd.notna(value):
        return "空"
    text = f"{float(value):.4f}".rstrip("0").rstrip(".")
    return text or "0"


def evaluate_condition(condition: Mapping[str, Any], ctx: EvalContext) -> ConditionResult:
    """Judge *condition* against *ctx* on the newest data point.

    Args:
        condition: The operator dict (``op``/``lhs``/``rhs``/``value``).
        ctx: The snapshot the rule may read.

    Returns:
        :class:`ConditionResult`. ``error`` is set whenever the verdict could
        not be measured — in that case ``hit`` is ``False`` and the caller must
        treat the result as "unknown", not as "cleared".
    """
    op = str(condition.get("op") or "")
    if op not in CONDITION_OPS:
        return ConditionResult(hit=False, error=f"不支持的条件 {op!r}")

    try:
        lhs = resolve_series(str(condition.get("lhs") or ""), ctx)
    except ValueError as exc:
        return ConditionResult(hit=False, error=str(exc))

    rhs: Optional[SeriesBundle] = None
    rhs_name = condition.get("rhs")
    if rhs_name:
        try:
            rhs = resolve_series(str(rhs_name), ctx)
        except ValueError as exc:
            return ConditionResult(hit=False, error=str(exc))
    elif condition.get("value") is not None:
        # A constant becomes a one-point series whose prev equals its last, so
        # "close crosses above 1700" and "rsi crosses above its own level" use
        # exactly one comparison path.
        const = float(condition["value"])
        rhs = SeriesBundle(name=str(condition.get("value")), last=const, prev=const, bars=1)

    if ctx.errors and not lhs.ok:
        return ConditionResult(
            hit=False, error="；".join(ctx.errors), bars=lhs.bars, value=lhs.last
        )
    if lhs.error:
        return ConditionResult(hit=False, error=lhs.error, bars=lhs.bars)
    if rhs is not None and rhs.error:
        return ConditionResult(hit=False, error=rhs.error, bars=lhs.bars, value=lhs.last)

    last = lhs.last
    prev = lhs.prev
    r_last = rhs.last if rhs is not None else None
    r_prev = rhs.prev if rhs is not None else None

    if op == "nonEmpty":
        return ConditionResult(hit=True, value=last, bars=lhs.bars)

    if op == "truthy":
        hit = last is not None and last > 0
        return ConditionResult(
            hit=hit,
            value=last,
            bars=lhs.bars,
            reason="" if hit else f"{lhs.name} = {shown_number(last)}，不为真",
        )

    if op in ("gt", "lt"):
        if last is None or r_last is None:
            return ConditionResult(
                hit=False, value=last, bars=lhs.bars, error=f"{lhs.name} 或比较对象没有值"
            )
        hit = last > r_last if op == "gt" else last < r_last
        reason = "" if hit else (
            f"{lhs.name} = {shown_number(last)} {'≤' if op == 'gt' else '≥'} {shown_number(r_last)}"
        )
        return ConditionResult(hit=hit, value=last, bars=lhs.bars, reason=reason)

    if op in ("crossUp", "crossDown"):
        missing = [v for v in (prev, last, r_prev, r_last) if v is None]
        if missing or prev is None or last is None or r_prev is None or r_last is None:
            return ConditionResult(
                hit=False,
                value=last,
                bars=lhs.bars,
                error=f"{lhs.name} 或 {rhs.name if rhs else ''} 需要上一根的值，数据不够",
            )
        if op == "crossUp":
            hit = prev <= r_prev and last > r_last
            reason = "" if hit else f"{lhs.name} 未在最后一根上穿 {rhs.name if rhs else ''}"
        else:
            hit = prev >= r_prev and last < r_last
            reason = "" if hit else f"{lhs.name} 未在最后一根下穿 {rhs.name if rhs else ''}"
        return ConditionResult(hit=hit, value=last, bars=lhs.bars, reason=reason)

    if op in ("rising", "falling"):
        if prev is None or last is None:
            return ConditionResult(
                hit=False, value=last, bars=lhs.bars, error=f"{lhs.name} 只有一根数据，无法判断变化"
            )
        hit = last > prev if op == "rising" else last < prev
        arrow = "→"
        reason = "" if hit else (
            f"{lhs.name} 未{'上升' if op == 'rising' else '下降'}（{shown_number(prev)}{arrow}{shown_number(last)}）"
        )
        return ConditionResult(hit=hit, value=last, bars=lhs.bars, reason=reason)

    return ConditionResult(hit=False, error=f"不支持的条件 {op!r}")


#: Display names for the pushed message. The rule itself is written in the
#: screener's vocabulary (``close``, ``rsi:14``) so the app and the engine share
#: one grammar; a chat reader does not need to learn it.
_SERIES_LABELS = {
    "close": "收盘",
    "open": "开盘",
    "high": "最高",
    "low": "最低",
    "volume": "成交量",
    "change_pct": "涨跌幅",
    "sma": "均线",
    "ema": "指数均线",
    "rsi": "RSI",
    "macd_line": "MACD 轴",
    "macd_signal": "MACD 信号轴",
    "macd_hist": "MACD 柱",
    "bb_upper": "布林上轨",
    "bb_middle": "布林中轨",
    "bb_lower": "布林下轨",
    "pnl_pct": "浮盈",
    "position_value": "仓位市值",
    "quantity": "持仓数量",
    "cost_price": "成本价",
    "market_price": "现价",
    "equity_usd": "账户净值(USD)",
    "equity_cny": "账户净值(CNY)",
    "drawdown_pct": "账户回撤",
    "event_value": "事件值",
    "event_price": "事件价格",
    "event_change_pct": "事件涨跌幅",
}


def series_label(name: Any) -> str:
    """Return the Chinese display name for a series, keeping its period suffix.

    Args:
        name: A series name as written in a rule (``rsi:14``).

    Returns:
        ``RSI(14)``, or the input unchanged when the name is not in the table
        (an unfamiliar name is better shown raw than mislabeled).
    """
    text = str(name or "").strip()
    if not text:
        return text
    if text in _SERIES_LABELS:
        return _SERIES_LABELS[text]
    try:
        fn, period = _split_name(text)
    except ValueError:
        return text
    base = _SERIES_LABELS.get(fn)
    if base is None:
        return text
    return f"{base}({period})" if fn in ("sma", "ema", "rsi") else base


def describe_condition(condition: Mapping[str, Any]) -> str:
    """Return a short Chinese label for a condition (used in messages).

    Args:
        condition: The operator dict.

    Returns:
        A phrase like ``收盘 上穿 1700`` — never empty, so a pushed message
        always says what was tested even when the evaluator had nothing to add.
    """
    op = str(condition.get("op") or "?")
    lhs = series_label(condition.get("lhs") or "?")
    rhs = condition.get("rhs")
    value = condition.get("value")
    partner = series_label(rhs) if rhs else ("" if value is None else shown_number(float(value)))
    labels = {
        "nonEmpty": "有值",
        "truthy": "为真",
        "gt": f">{partner}",
        "lt": f"<{partner}",
        "crossUp": f"上穿 {partner}".rstrip(),
        "crossDown": f"下穿 {partner}".rstrip(),
        "rising": "上升",
        "falling": "下降",
    }
    return f"{lhs} {labels.get(op, op)}".strip()
