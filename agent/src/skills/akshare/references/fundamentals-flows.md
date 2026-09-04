# AKShare Reference: Fundamentals & Money Flow (A-shares)

> Verified on 2026-09-04 against akshare 1.18.81. Interfaces marked ⚠️ have
> known failure modes in this environment — read before using.

Fund statements, valuations, earnings, northbound flow and dragon-tiger
board — all free, no token. Use these when the user asks "is it cheap /
is money flowing in / who is buying" style questions.

## 1. Financial indicators — `stock_financial_analysis_indicator` (verified OK)

```python
df = ak.stock_financial_analysis_indicator(symbol="600519", start_year="2023")
# 14 rows x 86 cols: 摊薄每股收益, 加权净资产收益率, 每股经营性现金流, ...
```

- `symbol`: pure 6-digit code. Returns one row per report period.
- Wide Chinese-named table — pick needed columns, don't dump all 86.

## 2. Valuation time series — `stock_value_em` (verified OK)

```python
df = ak.stock_value_em(symbol="600519")
# cols: 数据日期, 当日收盘价, 总市值, 流通市值, PE(TTM), PE(静), 市净率, PEG值, 市现率...
```

- Daily history back years — ideal for "PE percentile" style answers.
- ⚠️ The old `stock_a_indicator_lg` (乐咕估值) **no longer exists** in
  akshare ≥ 1.18 — do not emit it; use `stock_value_em`.

## 3. Earnings reports by quarter — `stock_yjbb_em` (verified OK, slow)

```python
df = ak.stock_yjbb_em(date="20250331")   # report period end: 0331/0630/0930/1231
# whole-market table (6000+ rows): 股票代码, 每股收益, 净利润-同比增长, 净资产收益率...
```

- ⚠️ Paginated (~13 pages took 12s). Filter by code locally afterwards;
  never call it per-symbol.
- Siblings: `stock_yjyg_em` (业绩预告), `stock_yjkk_em` (业绩快报).

## 4. Northbound / southbound flow — `stock_hsgt_fund_flow_summary_em` (verified OK)

```python
df = ak.stock_hsgt_fund_flow_summary_em()
# rows: 沪股通/深股通(北向) + 港股通沪/深(南向) for the latest trading day
# cols: 交易日, 类型, 板块, 资金方向, 成交净买额, 资金净流入, 当日资金余额, 上涨数, 相关指数...
```

- Snapshot of the latest day only. Historical daily flow:
  `stock_hsgt_hist_em(symbol="北向资金")` (not probed — verify on first use).
- ⚠️ Since 2024-08 the exchange stopped publishing per-stock northbound
  holdings in real time; do not promise stock-level northbound data.

## 5. Dragon-tiger board — `stock_lhb_detail_em` (verified OK)

```python
df = ak.stock_lhb_detail_em(start_date="20260817", end_date="20260821")
# cols: 代码, 名称, 上榜日, 解读, 收盘价, 涨跌幅, 龙虎榜净买额, 龙虎榜买入额, ...
```

- Keep windows ≤ ~1 week per call; wide ranges paginate heavily.

## Practical rules for the agent

1. Codes are **pure 6-digit** here (strip `.SH/.SZ`); opposite of the
   `fetch_market_data` convention in this repo.
2. These are *research* endpoints: no caching layer, Chinese columns.
   Rename/normalize before joining with OHLCV frames.
3. Rate discipline: one paginated call (e.g. `stock_yjbb_em`) is cheaper
   than 100 single-symbol calls. Prefer whole-market tables + local filter.
4. For backtests needing fundamentals as signals, extract to a CSV and run
   through the `local` loader instead of calling akshare inside the loop.
