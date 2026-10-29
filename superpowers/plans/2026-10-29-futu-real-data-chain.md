# Futu OpenD 真数据链接线 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 FutuOpenD 历史日线接成 G1/G3 所需的未复权宽表面板，并提供一条可复跑的真数据落盘链路。

**Architecture:** `agent/src/factors/futu_panels.py` 分两层：纯函数 `normalize_daily_panels` 负责单位换算、当日剔除、并集对齐与 ST 标记；`fetch_daily_panels` 是唯一 I/O 面，复用 `backtest.loaders.futu_gateway` 的连接与冷却语义。脚本 `agent/scripts/futu_chain_probe.py` 负责取数 → 筹码/涨停引擎 → `panel_store` 落盘与读回。

**Tech Stack:** Python 3.11、pandas、numpy、futu-api（可选依赖，测试用 stub）、pytest。

**Spec:** `superpowers/specs/2026-10-29-futu-real-data-chain-design.md`

## Global Constraints

- 只读 OpenD，不写任何 OpenD/券商状态；不下单。
- 价格未复权（`AuType.NONE`）；`last_close` 作昨收；换手率小数 ×100 变百分数。
- `timestamp >= as_of` 的 bar 全部剔除（as_of = Asia/Shanghai 当日，固定 +08:00）。
- 不新增第三方依赖；CI 不装 futu-api，测试必须 stub。
- 提交一律 `git commit -s` ＋显式 pathspec；推送前 `git ls-remote` 对真值。
- 恒红门先证「本片 0 贡献」再报告，不调阈值、不修门、不清白名单。

---

### Task 1: 纯归一化 `normalize_daily_panels` + `FutuPanels`

**Files:**
- Create: `agent/src/factors/futu_panels.py`
- Test: `agent/tests/factors/test_futu_panels.py`

**Interfaces:**
- Produces:
  - `FutuPanels(high, low, close, prev_close, turnover_rate_pct, is_st, names, failures, as_of)`
  - `is_st_name(name: str) -> bool`
  - `normalize_daily_panels(frames: Mapping[str, pd.DataFrame], *, today: date | None = None) -> FutuPanels`

- [ ] **Step 1: 写失败测试（纯函数部分）**

```python
def _raw(dates, *, close, last_close, turnover, name="平安银行", high=None, low=None):
    n = len(dates)
    return pd.DataFrame({
        "time_key": dates,
        "name": [name] * n,
        "high": high if high is not None else close,
        "low": low if low is not None else close,
        "close": close,
        "last_close": last_close,
        "turnover_rate": turnover,
    })

def test_turnover_fraction_is_converted_to_percent():
    out = normalize_daily_panels({"000001.SZ": _raw(["2026-10-28"], close=[11.31], last_close=[11.47], turnover=[0.00869])})
    assert out.turnover_rate_pct.iloc[0, 0] == pytest.approx(0.869)

def test_today_and_future_bars_are_dropped():
    frame = _raw(["2026-10-28", "2026-10-29", "2026-10-30"], close=[1, 2, 3], last_close=[1, 1, 2], turnover=[0.01, 0.02, 0.03])
    out = normalize_daily_panels({"000001.SZ": frame}, today=date(2026, 10, 29))
    assert list(out.close.index) == [pd.Timestamp("2026-10-28")]
    assert out.as_of == date(2026, 10, 29)

def test_last_close_is_prev_close_not_shifted_close():
    frame = _raw(["2026-10-27", "2026-10-28"], close=[11.31, 11.42], last_close=[11.47, 11.31], turnover=[0.01, 0.02])
    out = normalize_daily_panels({"000001.SZ": frame}, today=date(2026, 10, 29))
    assert list(out.prev_close["000001.SZ"]) == [11.47, 11.31]

def test_union_alignment_fills_missing_cells_with_nan():
    a = _raw(["2026-10-27", "2026-10-28"], close=[10.0, 11.0], last_close=[9.0, 10.0], turnover=[0.01, 0.02])
    b = _raw(["2026-10-28", "2026-10-29"], close=[20.0, 21.0], last_close=[19.0, 20.0], turnover=[0.03, 0.04], name="ST测试")
    out = normalize_daily_panels({"000001.SZ": a, "600000.SH": b}, today=date(2026, 10, 31))
    assert list(out.high.index) == [pd.Timestamp(d) for d in ("2026-10-27", "2026-10-28", "2026-10-29")]
    assert np.isnan(out.high.loc["2026-10-29", "000001.SZ"])
    assert out.is_st.loc["2026-10-27", "600000.SH"] == True  # noqa: E712
    assert out.is_st.loc["2026-10-27", "000001.SZ"] == False  # noqa: E712

@pytest.mark.parametrize(("name", "expected"), [("ST平安", True), ("*ST海航", True), ("S*ST长油", True), ("平安银行", False), (" st 平安 ", True)])
def test_is_st_name(name, expected):
    assert is_st_name(name) is expected

def test_empty_mapping_returns_empty_aligned_frames():
    out = normalize_daily_panels({}, today=date(2026, 10, 29))
    assert out.high.empty and out.high.index.empty and list(out.high.columns) == []
    assert out.is_st.dtypes.iloc[0] if list(out.is_st.columns) else out.is_st.empty

def test_missing_required_column_raises():
    frame = _raw(["2026-10-28"], close=[1.0], last_close=[1.0], turnover=[0.01]).drop(columns="turnover_rate")
    with pytest.raises(ValueError, match="turnover_rate"):
        normalize_daily_panels({"000001.SZ": frame}, today=date(2026, 10, 29))

def test_input_frames_are_not_modified():
    frame = _raw(["2026-10-28"], close=[1.0], last_close=[1.0], turnover=[0.01])
    before = frame.copy(deep=True)
    normalize_daily_panels({"000001.SZ": frame}, today=date(2026, 10, 29))
    pd.testing.assert_frame_equal(frame, before)

def test_duplicate_timestamps_keep_last():
    frame = _raw(["2026-10-28", "2026-10-28"], close=[1.0, 2.0], last_close=[1.0, 1.0], turnover=[0.01, 0.02])
    out = normalize_daily_panels({"000001.SZ": frame}, today=date(2026, 10, 29))
    assert len(out.close) == 1 and out.close.iloc[0, 0] == 2.0
```

- [ ] **Step 2: 运行确认失败**

Run: `cd agent && python -m pytest tests/factors/test_futu_panels.py -q`
Expected: FAIL（`ModuleNotFoundError: No module named 'src.factors.futu_panels'`）

- [ ] **Step 3: 写最小实现**

```python
"""Real daily panels from FutuOpenD for the chip and limit-pool engines."""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

import pandas as pd

__all__ = ["FutuPanels", "FutuPanelsError", "fetch_daily_panels", "is_st_name", "normalize_daily_panels"]

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
    """A-share name prefix marker; only the *current* name is known."""
    if not isinstance(name, str):
        return False
    return "".join(name.split()).upper().startswith(_ST_PREFIXES)


def normalize_daily_panels(frames: Mapping[str, pd.DataFrame], *, today: date | None = None) -> FutuPanels:
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
        work = work.sort_values("_ts", kind="mergesort").drop_duplicates("_ts", keep="last")
        work.index = pd.DatetimeIndex(work["_ts"].dt.normalize(), name="trade_date")
        numeric = work.loc[:, ["high", "low", "close", "last_close", "turnover_rate"]].apply(pd.to_numeric, errors="coerce")
        numeric = numeric.rename(columns={"last_close": "prev_close"})
        numeric["turnover_rate_pct"] = numeric["turnover_rate"] * 100.0
        name_value = work["name"].iloc[-1]
        name = "" if pd.isna(name_value) else str(name_value)
        prepared[code] = (numeric, name)

    if not prepared:
        empty_index = pd.DatetimeIndex([], name="trade_date")
        empty = pd.DataFrame(index=empty_index)
        return FutuPanels(
            high=empty.copy(), low=empty.copy(), close=empty.copy(),
            prev_close=empty.copy(), turnover_rate_pct=empty.copy(),
            is_st=pd.DataFrame(index=empty_index, dtype=bool),
            names={}, failures={}, as_of=as_of,
        )

    index = next(iter(prepared.values()))[0].index
    for frame, _name in prepared.values():
        index = index.union(frame.index)
    index = pd.DatetimeIndex(index.sort_values(), name="trade_date")
    columns = list(prepared)

    def panel(column: str) -> pd.DataFrame:
        return pd.DataFrame(
            {code: prepared[code][0][column] for code in columns}, index=index
        ).reindex(index=index, columns=columns).astype(float)

    is_st = pd.DataFrame(
        {code: pd.Series(is_st_name(prepared[code][1]), index=index, dtype=bool) for code in columns},
        index=index,
    ).reindex(index=index, columns=columns, fill_value=False).astype(bool)

    return FutuPanels(
        high=panel("high"), low=panel("low"), close=panel("close"),
        prev_close=panel("prev_close"), turnover_rate_pct=panel("turnover_rate_pct"),
        is_st=is_st, names={code: prepared[code][1] for code in columns},
        failures={}, as_of=as_of,
    )
```

- [ ] **Step 4: 运行确认通过**

Run: `cd agent && python -m pytest tests/factors/test_futu_panels.py -q`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add agent/src/factors/futu_panels.py agent/tests/factors/test_futu_panels.py
git commit -s -m "feat(factors): normalize Futu daily panels for chip and limit engines"
```

---

### Task 2: `fetch_daily_panels`（分页 / 失败 / 冷却 / autype）

**Files:**
- Modify: `agent/src/factors/futu_panels.py`
- Test: `agent/tests/factors/test_futu_panels.py`

**Interfaces:**
- Consumes: Task 1 的 `normalize_daily_panels`、`backtest.loaders.futu_gateway`
- Produces: `fetch_daily_panels(codes, start_date, end_date, *, today=None, max_count=1000, max_pages=100) -> FutuPanels`

- [ ] **Step 1: 写失败测试（stub futu + 假 context）**

```python
class _KLType: K_DAY = "K_DAY"
class _KLField: ALL = "ALL"
class _AuType: NONE = "NONE"; QFQ = "QFQ"

def _stub_futu(monkeypatch):
    stub = types.SimpleNamespace(RET_OK=0, KLType=_KLType, KL_FIELD=_KLField, AuType=_AuType)
    monkeypatch.setitem(sys.modules, "futu", stub)

@pytest.fixture(autouse=True)
def _reset_gateway():
    from backtest.loaders import futu_gateway
    futu_gateway.reset_state()
    yield
    futu_gateway.reset_state()

def test_fetch_requests_unadjusted_all_fields(monkeypatch):
    _stub_futu(monkeypatch)
    ctx = MagicMock()
    ctx.request_history_kline.return_value = (0, _raw(["2026-10-28"], close=[11.31], last_close=[11.47], turnover=[0.00869]), None)
    monkeypatch.setattr("backtest.loaders.futu_gateway.open_context", lambda *a, **k: ctx)
    out = fetch_daily_panels(["000001.SZ"], "2026-10-20", "2026-10-28", today=date(2026, 10, 29))
    kwargs = ctx.request_history_kline.call_args.kwargs
    assert kwargs["autype"] == _AuType.NONE
    assert kwargs["fields"] == [_KLField.ALL]
    assert kwargs["ktype"] == _KLType.K_DAY
    assert out.close.iloc[0, 0] == 11.31
    ctx.close.assert_called_once()

def test_fetch_paginates_and_keeps_last_duplicate(monkeypatch):
    _stub_futu(monkeypatch)
    ctx = MagicMock()
    first = _raw(["2026-10-27", "2026-10-28"], close=[1.0, 2.0], last_close=[1.0, 1.0], turnover=[0.01, 0.02])
    second = _raw(["2026-10-28"], close=[9.0], last_close=[1.0], turnover=[0.03])
    ctx.request_history_kline.side_effect = [(0, first, b"p1"), (0, second, None)]
    monkeypatch.setattr("backtest.loaders.futu_gateway.open_context", lambda *a, **k: ctx)
    out = fetch_daily_panels(["000001.SZ"], "2026-10-20", "2026-10-29", today=date(2026, 10, 30))
    assert len(out.close) == 2
    assert out.close.loc["2026-10-28", "000001.SZ"] == 9.0

def test_fetch_records_symbol_failure_and_keeps_others(monkeypatch):
    _stub_futu(monkeypatch)
    ctx = MagicMock()
    ok = _raw(["2026-10-28"], close=[11.31], last_close=[11.47], turnover=[0.00869])
    ctx.request_history_kline.side_effect = [(0, ok, None), (1, "未知股票", None)]
    monkeypatch.setattr("backtest.loaders.futu_gateway.open_context", lambda *a, **k: ctx)
    out = fetch_daily_panels(["000001.SZ", "000004.SZ"], "2026-10-01", "2026-10-28", today=date(2026, 10, 29))
    assert list(out.close.columns) == ["000001.SZ"]
    assert "未知股票" in out.failures["000004.SZ"]

def test_fetch_all_failed_raises_without_cooldown(monkeypatch):
    _stub_futu(monkeypatch)
    ctx = MagicMock(); ctx.request_history_kline.return_value = (1, "denied", None)
    monkeypatch.setattr("backtest.loaders.futu_gateway.open_context", lambda *a, **k: ctx)
    with pytest.raises(FutuPanelsError, match="denied"):
        fetch_daily_panels(["000001.SZ"], "2026-10-01", "2026-10-28", today=date(2026, 10, 29))
    from backtest.loaders import futu_gateway
    assert futu_gateway.in_cooldown("127.0.0.1", 11111) is False

def test_fetch_connect_failure_raises_and_latches_cooldown(monkeypatch):
    _stub_futu(monkeypatch)
    def _boom(*a, **k): raise OSError("refused")
    monkeypatch.setattr("backtest.loaders.futu_gateway.open_context", _boom)
    with pytest.raises(FutuPanelsError, match="FutuOpenD"):
        fetch_daily_panels(["000001.SZ"], "2026-10-01", "2026-10-28", today=date(2026, 10, 29))
    from backtest.loaders import futu_gateway
    assert futu_gateway.in_cooldown("127.0.0.1", 11111) is True

def test_fetch_rejects_non_a_share_before_connecting(monkeypatch):
    _stub_futu(monkeypatch)
    ctx = MagicMock()
    monkeypatch.setattr("backtest.loaders.futu_gateway.open_context", lambda *a, **k: ctx)
    with pytest.raises(ValueError, match="A-share"):
        fetch_daily_panels(["700.HK"], "2026-10-01", "2026-10-28")
    ctx.request_history_kline.assert_not_called()

def test_fetch_repeated_page_key_is_a_failure(monkeypatch):
    _stub_futu(monkeypatch)
    ctx = MagicMock()
    ctx.request_history_kline.return_value = (0, _raw(["2026-10-28"], close=[1.0], last_close=[1.0], turnover=[0.01]), b"same")
    monkeypatch.setattr("backtest.loaders.futu_gateway.open_context", lambda *a, **k: ctx)
    with pytest.raises(FutuPanelsError, match="pagination"):
        fetch_daily_panels(["000001.SZ"], "2026-10-01", "2026-10-28", today=date(2026, 10, 29), max_pages=5)

def test_fetch_empty_codes_raises():
    with pytest.raises(ValueError, match="non-empty"):
        fetch_daily_panels([], "2026-10-01", "2026-10-28")
```

- [ ] **Step 2: 运行确认失败**

Run: `cd agent && python -m pytest tests/factors/test_futu_panels.py -q`
Expected: FAIL（`fetch_daily_panels` 不存在）

- [ ] **Step 3: 实现 fetch**

```python
import logging
from dataclasses import replace
from collections.abc import Sequence

from backtest.loaders import futu_gateway
from backtest.loaders.futu import _to_futu_symbol

logger = logging.getLogger(__name__)


def _parse_day(value: str, label: str) -> date:
    try:
        stamp = pd.Timestamp(value)
    except Exception as exc:
        raise ValueError(f"{label} is not a date: {value!r}") from exc
    if pd.isna(stamp):
        raise ValueError(f"{label} is not a date: {value!r}")
    return stamp.date()


def fetch_daily_panels(codes, start_date, end_date, *, today=None, max_count=1000, max_pages=100):
    requested = list(dict.fromkeys(str(code).strip().upper() for code in codes if str(code).strip()))
    if not requested:
        raise ValueError("codes must be non-empty")
    unsupported = [code for code in requested if not _CODE_RE.match(code)]
    if unsupported:
        raise ValueError(f"Futu panels only serve A-share codes (000001.SZ); got {unsupported}")
    start = _parse_day(start_date, "start_date")
    end = _parse_day(end_date, "end_date")
    if end < start:
        raise ValueError(f"end_date {end} is before start_date {start}")
    as_of = today if today is not None else _shanghai_today()
    if isinstance(as_of, datetime):
        as_of = as_of.date()

    host, port = futu_gateway.gateway_target()
    if futu_gateway.in_cooldown(host, port):
        raise FutuPanelsError(f"FutuOpenD at {host}:{port} is in cooldown")
    try:
        import futu
        ctx = futu_gateway.open_context(host, port)
    except Exception as exc:
        futu_gateway.note_failure(host, port, reason=f"futu panels connect: {type(exc).__name__}")
        raise FutuPanelsError(f"Cannot connect to FutuOpenD at {host}:{port}: {exc}") from exc

    frames: dict[str, pd.DataFrame] = {}
    failures: dict[str, str] = {}
    try:
        for code in requested:
            futu_code = _to_futu_symbol(code)
            rows: list[pd.DataFrame] = []
            page_key = None
            seen: set = set()
            pages = 0
            failure = None
            while True:
                pages += 1
                if pages > max_pages:
                    failure = f"pagination exceeded {max_pages} pages"
                    break
                try:
                    ret, data, next_key = ctx.request_history_kline(
                        futu_code, start=start_date, end=end_date,
                        ktype=futu.KLType.K_DAY, autype=futu.AuType.NONE,
                        max_count=max_count, page_req_key=page_key,
                        fields=[futu.KL_FIELD.ALL],
                    )
                except Exception as exc:
                    failure = f"{type(exc).__name__}: {exc}"
                    break
                if ret != futu.RET_OK:
                    failure = str(data)
                    break
                if isinstance(data, pd.DataFrame) and not data.empty:
                    rows.append(data)
                if not next_key:
                    break
                if next_key == page_key or next_key in seen:
                    failure = "pagination loop detected"
                    break
                seen.add(next_key)
                page_key = next_key
            if failure is not None:
                failures[code] = failure
                continue
            if not rows:
                failures[code] = "no rows"
                continue
            frames[code] = pd.concat(rows, ignore_index=True)
    finally:
        try:
            ctx.close()
        except Exception:
            logger.debug("FutuPanels context close failed", exc_info=True)

    panels = normalize_daily_panels(frames, today=as_of)
    for code in requested:
        if code not in panels.columns:
            failures.setdefault(code, "no completed rows before as_of")
    if not panels.columns.size:
        first = next(iter(failures.items()), ("", "no rows returned"))
        raise FutuPanelsError(f"FutuOpenD returned no completed daily bars; first failure {first[0]}: {first[1]}")
    futu_gateway.note_success(host, port)
    return replace(panels, failures=dict(failures))
```

- [ ] **Step 4: 运行确认通过**

Run: `cd agent && python -m pytest tests/factors/test_futu_panels.py -q`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add agent/src/factors/futu_panels.py agent/tests/factors/test_futu_panels.py
git commit -s -m "feat(factors): fetch Futu daily panels with pagination and failure contract"
```

---

### Task 3: 活体验收脚本 + 真实 OpenD 实跑

**Files:**
- Create: `agent/scripts/futu_chain_probe.py`

**Interfaces:**
- Consumes: `fetch_daily_panels`、`chip_metrics`、`limit_pool`、`panel_store.{panel_digest, write_panel, read_panel}`

- [ ] **Step 1: 写脚本**

```python
"""Fetch real A-share daily panels from FutuOpenD, compute, and persist."""

from __future__ import annotations

import argparse
import sys
import time
from datetime import date, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv

HERE = Path(__file__).resolve().parent
AGENT_DIR = HERE.parent
sys.path.insert(0, str(AGENT_DIR))
load_dotenv(AGENT_DIR / ".env")

from src.factors.chips import chip_metrics  # noqa: E402
from src.factors.futu_panels import fetch_daily_panels  # noqa: E402
from src.factors.limit_pool import limit_pool  # noqa: E402
from src.factors.panel_store import panel_digest, read_panel, write_panel  # noqa: E402

_CN_TZ = timezone(timedelta(hours=8))


def _today() -> date:
    from datetime import datetime
    return datetime.now(_CN_TZ).date()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codes", nargs="+", required=True, help="A-share codes, e.g. 000001.SZ")
    parser.add_argument("--days", type=int, default=400, help="calendar days before end when --start is omitted")
    parser.add_argument("--start", default=None, help="YYYY-MM-DD (default: end - days)")
    parser.add_argument("--end", default=None, help="YYYY-MM-DD (default: today in Asia/Shanghai)")
    parser.add_argument("--out", required=True, help="panel store directory")
    parser.add_argument("--strict", action="store_true", help="exit 1 when any symbol failed")
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args(argv)

    end = args.end or _today().isoformat()
    start = args.start or (date.fromisoformat(end) - timedelta(days=args.days)).isoformat()
    t0 = time.perf_counter()
    panels = fetch_daily_panels(args.codes, start, end)
    print(f"panels: {panels.close.shape[0]} rows x {panels.close.shape[1]} cols; as_of={panels.as_of}")
    print(f"last bar: {panels.close.index[-1].date()}; first bar: {panels.close.index[0].date()}")
    if len(panels.close) and panels.close.index[-1].date() >= panels.as_of:
        raise SystemExit("no-lookahead violation: last bar is not before as_of")
    print(f"names: {panels.names}")
    if panels.failures:
        print(f"failures ({len(panels.failures)}):")
        for code, reason in sorted(panels.failures.items()):
            print(f"  {code}: {reason}")

    t1 = time.perf_counter()
    chip = chip_metrics(panels.high, panels.low, panels.close, panels.turnover_rate_pct)
    print(f"chip_metrics: {time.perf_counter() - t1:.1f}s; non-null profit_ratio="
          f"{int(chip['profit_ratio'].notna().to_numpy().sum())}")
    t2 = time.perf_counter()
    pool = limit_pool(panels.high, panels.low, panels.close, panels.prev_close, is_st=panels.is_st)
    print(f"limit_pool: {time.perf_counter() - t2:.1f}s; latest daily row:")
    print(pool.daily.tail(1).to_string())

    digest = panel_digest({
        "high": panels.high, "low": panels.low, "close": panels.close,
        "prev_close": panels.prev_close, "turnover_rate_pct": panels.turnover_rate_pct,
    })
    out = Path(args.out)
    paths = [
        write_panel(out, chip["profit_ratio"], alpha_id="chip_profit_ratio", universe="futu_a_share",
                    period=f"{start}..{end}", data_source="futu:opend",
                    panel_digest=digest, overwrite=args.overwrite),
        write_panel(out, pool.streak, alpha_id="limit_streak", universe="futu_a_share",
                    period=f"{start}..{end}", data_source="futu:opend",
                    panel_digest=digest, overwrite=args.overwrite),
    ]
    for path in paths:
        stored = read_panel(path)
        print(f"stored: {path} rows={stored.factor.shape[0]} cols={stored.factor.shape[1]} "
              f"source={stored.manifest['data_source']}")
    print(f"total {time.perf_counter() - t0:.1f}s")
    return 1 if args.strict and panels.failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 2: `--help` 烟测**

Run: `cd agent && python scripts/futu_chain_probe.py --help`
Expected: 打印参数，exit 0

- [ ] **Step 3: 真实 OpenD 实跑（6 标的 × 250+ 根）**

Run（Git Bash；`OUT` 用仓库外目录）:

```bash
cd agent && python scripts/futu_chain_probe.py \
  --codes 000001.SZ 600519.SH 600078.SH 300750.SZ 688981.SH 000002.SZ \
  --start 2024-01-01 --out "$TEMP/futu_chain_panels" --overwrite
```

Expected: 打印 `as_of=2026-10-29`、last bar `< 2026-10-29`、chip/limit 跑通、
两个 `stored:` 行、exit 0；`failures` 为空。

- [ ] **Step 4: 核对读数（写进档案，不先写结论）**

要求逐条现读：

1. `turnover_rate_pct` 在 000001.SZ `2026-10-28` 的值 ≈ 0.869；
2. `prev_close` 等于同一行 Futu `last_close`（用独立 probe 复读一根）；
3. `chip["profit_ratio"]` 非空数 > 0；
4. `pool.daily` 末行 `n_valid == 6`；
5. `read_panel` 两份都成功且 `data_source == "futu:opend"`。

- [ ] **Step 5: 提交**

```bash
git add agent/scripts/futu_chain_probe.py
git commit -s -m "feat(scripts): end-to-end Futu panel probe into the panel store"
```

---

### Task 4: 变异自证 M1–M8

**Files:**
- Modify (temp copies only): `agent/src/factors/futu_panels.py`
- Harness: `%TEMP%/futu_panels_mutations.py`（仓库外）

- [ ] **Step 1: 基线**

Run: `cd agent && python -m pytest tests/factors/test_futu_panels.py -q`
Expected: PASS（记录枚数）

- [ ] **Step 2: 逐针注入并跑目标测试**

M1 `turnover_rate_pct"] = numeric["turnover_rate"] * 100.0` → `* 1.0`
M2 `work["_ts"].dt.normalize() < cutoff` → `<= cutoff`
M3 `numeric = numeric.rename(columns={"last_close": "prev_close"})` → 先把 `close` 拷进 `prev_close`
M4 `index = index.union(frame.index)` → `index = index.intersection(frame.index)`
M5 `return "".join(...).startswith(_ST_PREFIXES)` → `return False`
M6 `autype=futu.AuType.NONE` → `autype=futu.AuType.QFQ`
M7 在 `if isinstance(data, ...)` 之后立即 `break`（只取第一页）
M8 全失败分支 `raise FutuPanelsError(...)` → `return replace(panels, failures=...)`

每条命令必须是：注入 → 跑 `pytest tests/factors/test_futu_panels.py -q` → 记录失败名与 rc →
从**动手前的内存副本**写回 → 复跑全绿 → `hashlib.sha256` 与基线相等。

- [ ] **Step 3: 记录变异表**

档案 §7.40 写：每针注入文本、红掉的测试名、rc、还原后 sha256 与基线相等。

- [ ] **Step 4: 提交（仅当档案与代码有追加）**

```bash
git add 项目档案.md
git commit -s -m "docs(archive): record the Futu data-chain mutation probes"
```

---

### Task 5: 门册、档案、提交与推送

**Files:**
- Modify: `项目档案.md`（bytes 层，CRLF）
- Modify: `superpowers/specs/2026-10-29-futu-real-data-chain-design.md`（执行期偏差）
- Modify: `superpowers/plans/2026-10-29-futu-real-data-chain.md`（执行期偏差）

- [ ] **Step 1: 门 A'（focused）**

Run: `cd agent && python -m pytest tests/factors/test_futu_panels.py tests/test_futu_loader.py tests/test_futu_gateway.py -q`

- [ ] **Step 2: 门 B（全量后端，不并发）**

Run:
```bash
cd /e/Vibe-Trading-main/Vibe-Trading-main && PYTHONDONTWRITEBYTECODE=1 python -B -X utf8 -m pytest agent/tests -q --tb=no -rf --continue-on-collection-errors --ignore=agent/tests/e2e_backtest --ignore=agent/tests/e2e_harness_v2.py -p no:cacheprovider
```
Expected: 与 G9 基线逐名比对新增红 = 0。

- [ ] **Step 3: 门 C–F**

```bash
bash tools/ci_grep_gates.sh
python -m pytest tools/test_ci_env_var_gate.py tools/test_ci_private_files_gate.py tools/test_doc_tables.py -q
python -m pytest tools/test_wiki_drift.py -q
bash tools/wiki_freshness_gate.sh
```

恒红门：C 只红 `[gate b]`、D 换行文件名、F 水位 447>439；先证本片文件在各门输出里 0 命中。

- [ ] **Step 4: 档案 §7.40**

按既有格式追加一节：落点、冻结口径、活体读数、手算向量、变异表、门册、限制、坐标。
`项目档案.md` 用 bytes 追加，保持 CRLF；改后复跑读档门与 E/F。

- [ ] **Step 5: 提交与推送**

```bash
git ls-remote origin refs/heads/main
git push origin main
```

若远程已被 cron 推进：先 `git merge origin/main`（不 rebase），复跑门 A'/B/E/F 后再推。

- [ ] **Step 6: CI 九腿复读**

匿名面：`curl -sS -H 'Accept: application/vnd.github+json' 'https://api.github.com/repos/hjfire/vibe-trading-fw/commits/<sha>/check-runs?per_page=50'`；
九腿 success 即收口，红腿先归因再报告。
