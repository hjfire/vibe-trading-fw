# AKShare Reference: Macro Indicators & Option Chains

> Verified on 2026-09-04 against akshare 1.18.81.

## Macro (China) — all verified OK

| Function | Returns | Cols (observed) |
|---|---|---|
| `macro_china_gdp()` | 季度 GDP | (see SKILL.md quick ref) |
| `macro_china_cpi()` | 月度 CPI | " |
| `macro_china_ppi()` | 月度 PPI | 月份, 当月, 当月同比增长, 累计 |
| `macro_china_pmi_yearly()` | 制造业 PMI | 商品, 日期, 今值, 预测值, 前值 |
| `macro_china_lpr()` | LPR 贷款报价利率 | TRADE_DATE, LPR1Y, LPR5Y, RATE_1, RATE_2 |
| `bond_zh_us_rate(start_date="20250101")` | 中美国债收益率 | 日期, 中国国债收益率2/5/10/30年, 美国国债收益率…, GDP年增率 |

Notes:
- All return full history (LPR: 1500+ rows) — **clip to the window you need**
  before putting into a prompt or chart.
- Columns are mixed Chinese/English per source; rename before joins.
- `bond_zh_us_rate` is the workhorse for rate/regime studies (10Y-2Y
  spreads are pre-computed as `...10年-2年` columns).
- More: `macro_china_m2_yearly`, `macro_china_consumer_goods_retail`,
  `macro_china_au_report` etc. — same family, not all probed; verify on use.

## Option chains (China exchange-listed)

### Board snapshot — `option_finance_board` (verified OK)

```python
df = ak.option_finance_board(symbol="华夏上证50ETF期权", end_month="2609")
# cols: 日期, 合约交易代码, 当前价, 涨跌幅, 前结价, 行权价, 数量
```

- `symbol` ∈ {`"华夏上证50ETF期权"`, `"华泰柏瑞沪深300ETF期权"`,
  `"嘉实沪深300ETF期权"`, ...}; `end_month` = `YYMM` expiry month.
- Gives the listed contracts of one expiry month, both C and P sides.

### CFFEX index options — `option_cffex_hs300_list_sina` (verified OK)

```python
d = ak.option_cffex_hs300_list_sina()   # dict: contract month -> symbol list
```

- IO/MO/HO index options. Follow-up spot/greeks calls exist
  (`option_cffex_hs300_spot_sina` etc.) — not probed, verify on first use.

### ⚠️ Known-broken in 1.18.81

`option_sse_codes_sina` raises `ValueError: Length mismatch` — avoid; use
`option_finance_board` above for SSE ETF option contract lists.

## Boundary with this repo's own option tooling

- **US / cross-market option chains**: use the built-in
  `get_options_chain` tool (yfinance-backed) — not akshare.
- **China ETF/index options**: akshare is the only free source here; payoff
  math can reuse `backtest/options_payoff.py` rather than recomputing.
- The Options Lab frontend pages consume the repo's option tools — raw
  akshare calls are for research answers, not for feeding those APIs.

## Practical rules for the agent

1. Macro tables are small enough to print inline; option boards are not —
  summarize (strikes range, ATM picks, IV if available) instead of dumping.
2. `end_month` must be a *live* expiry or the board returns empty; compute
  from today (next monthly expiry: 4th Wednesday of the month for SSE ETFs).
3. Quote freshness: option board prices are delayed snapshots, not
  tradeable quotes — never present them as live market data.
