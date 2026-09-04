# AKShare Reference: Intraday / Minute Bars (A-shares)

> Verified on 2026-09-04 against akshare 1.18.81 (Python 3.11). Re-probe before
> relying on an interface you have not used in this project — AKShare scrapes
> public endpoints and they change without notice.

Free intraday bars for A-shares. This is the main gap the paid
`tushare` path leaves open (`stk_mins()` needs 2000 points), so prefer these
when the user just needs recent minute data.

## 1. Sina minute bars — `stock_zh_a_minute` (primary, verified OK)

```python
import akshare as ak

# period: "1" | "5" | "15" | "30" | "60"; adjust: "" | "qfq" | "hfq"
df = ak.stock_zh_a_minute(symbol="sh600519", period="5", adjust="qfq")
# columns: day, open, high, low, close, volume   (English, lowercase)
df["day"] = pd.to_datetime(df["day"])
df = df.set_index("day").sort_index().astype(float)  # values arrive as strings
```

- `symbol` format: **exchange prefix + digits** — `sh600519`, `sz000001`
  (NOT the `600519.SH` project suffix; strip and remap: `.SH→sh`, `.SZ→sz`).
- Returns a long history window (~2000 bars for 5-min in our test), not a
  date-range query — clip afterwards: `df.loc["2026-09-01":]`.
- 1-minute bars cover only a short recent window; for deep intraday history
  no free akshare source can help — that remains tushare territory.

## 2. East Money minute bars — `stock_zh_a_hist_min_em` (may be blocked)

```python
df = ak.stock_zh_a_hist_min_em(symbol="000001", period="5", adjust="")
# period: 1/5/15/30/60; symbol: pure digits (no suffix)
```

- Richer `adjust` options and cleaner columns (时间/开盘/...), BUT it hits
  `push2his.eastmoney.com`, which **failed in our environment with
  `ProxyError`** (local proxy interferes with push2* hosts). Treat as
  best-effort; fall back to the Sina variant above.
- Same caveat for real-time snapshots: `stock_zh_a_spot_em()` uses
  `82.push2.eastmoney.com` and failed here too.

## 3. Tick / intraday transaction flow

```python
df = ak.stock_intraday_em(symbol="000001")  # 逐笔成交 — also push2-based, may be blocked
```

## Practical rules for the agent

1. Try `stock_zh_a_minute` (Sina) first — it worked in every probe here.
2. Normalize immediately: `pd.to_datetime` + `astype(float)` + sort index;
   the loader contract in this repo wants `trade_date` index with
   `open/high/low/close/volume` float columns (see
   `backtest/loaders/akshare_loader.py::_normalize`).
3. Do not loop this endpoint across a whole universe in one run — Sina
   rate-limits aggressive scrapers. Sample ≤ ~20 symbols per request batch,
   or sleep ~1s between calls.
4. Minute data is for *recent* inspection (intraday structure, execution
   studies). For backtests prefer the daily path (`akshare_loader` /
   `fetch_market_data`), which is cached and validated.
