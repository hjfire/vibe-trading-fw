# AKShare Reference: Index Constituents & Stock Pools

> Verified on 2026-09-04 against akshare 1.18.81.

Building a backtest universe (CSI 300 / CSI 500 / ...) with no API key.
Prefer the **csindex** (中证指数公司 official) family; Sina is the fallback.

## 1. Constituents — `index_stock_cons_csindex` (verified OK, recommended)

```python
df = ak.index_stock_cons_csindex(symbol="000300")
# 300 rows: 日期, 指数代码, 指数名称, 成分券代码, 成分券名称, 交易所...
```

Common `symbol` values: `000016` SSE50, `000300` CSI300, `000905` CSI500,
`000852` CSI1000, `000010` CSI100, `931152` etc. (any csindex-published code).

## 2. Constituents + weights — `index_stock_cons_weight_csindex` (verified OK)

```python
df = ak.index_stock_cons_weight_csindex(symbol="000300")
# same as above + 权重 (percent) — use for cap-weighted synthetic baskets
```

## 3. Sina fallback — `index_stock_cons` (verified OK, slow)

```python
df = ak.index_stock_cons(symbol="000300")   # 品种代码, 品种名称, 纳入日期
```

- Took ~9s in our probe; csindex answered in ~1s. Prefer csindex.

## Turning a constituent list into a project universe

The repo's loaders expect suffixed symbols. Map from the 交易所 column:

```python
def to_symbols(df) -> list[str]:
    m = {"上证A股": "SH", "深证A股": "SZ", "北证A股": "BJ"}
    return [f"{c}.{m[e]}" for c, e in
            zip(df["成分券代码"].astype(str).str.zfill(6), df["交易所"])]

codes = to_symbols(ak.index_stock_cons_csindex(symbol="000300"))
# then: fetch_market_data(codes=codes, ...) or the backtest runner
```

## Honest limitations

- **Point-in-time universes are NOT available**: csindex returns the
  *current* snapshot only. Backtesting a strategy over history with today's
  constituents silently introduces survivorship bias — state this explicitly
  whenever you build a universe this way (the repo's alpha-bench tooling
  cares about exactly this).
- CSI 300/500 snapshots refresh monthly on the exchange side; 日期 column
  tells you which snapshot you got.
- For industry classification: `stock_industry_clf_hist_sw` (申万) exists in
  1.18.x but was not probed — verify on first use.
