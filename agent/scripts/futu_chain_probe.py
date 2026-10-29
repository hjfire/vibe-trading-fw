"""End-to-end probe: FutuOpenD daily panels -> chip/limit engines -> panel store.

Development-only script. Run from the repository root:

    python agent/scripts/futu_chain_probe.py \
      --codes 000001.SZ 600519.SH --start 2024-01-01 --out "$TEMP/futu_chain_panels"

It only reads OpenD (no orders, no state changes) and writes the two stored
panels under ``--out``. Failures for individual symbols are printed; with
``--strict`` any failure makes the run exit 1.
"""

from __future__ import annotations

import argparse
import os
import sys
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

from dotenv import load_dotenv

AGENT_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(AGENT_DIR))
load_dotenv(AGENT_DIR / ".env")

from src.factors.chips import chip_metrics  # noqa: E402
from src.factors.futu_panels import fetch_daily_panels  # noqa: E402
from src.factors.limit_pool import limit_pool  # noqa: E402
from src.factors.panel_store import panel_digest, read_panel, write_panel  # noqa: E402

_CN_TZ = timezone(timedelta(hours=8))


def _today() -> date:
    return datetime.now(_CN_TZ).date()


def _print_last_bars(panels) -> None:
    for code in panels.close.columns:
        series = panels.close[code].dropna()
        if series.empty:
            continue
        ts = series.index[-1]
        print(
            f"  {code} {ts.date()} close={series.loc[ts]:.3f} "
            f"prev_close={panels.prev_close.at[ts, code]:.3f} "
            f"turnover_pct={panels.turnover_rate_pct.at[ts, code]:.4f} "
            f"st={bool(panels.is_st.at[ts, code])}"
        )


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--codes", nargs="+", required=True, help="A-share codes, e.g. 000001.SZ")
    parser.add_argument("--days", type=int, default=400, help="calendar days before end when --start is omitted")
    parser.add_argument("--start", default=None, help="YYYY-MM-DD (default: end - days)")
    parser.add_argument("--end", default=None, help="YYYY-MM-DD (default: today in Asia/Shanghai)")
    parser.add_argument("--out", required=True, help="panel store directory (outside the repo)")
    parser.add_argument("--strict", action="store_true", help="exit 1 when any symbol failed")
    parser.add_argument("--overwrite", action="store_true")
    args = parser.parse_args(argv)

    end = args.end or _today().isoformat()
    start = args.start or (date.fromisoformat(end) - timedelta(days=args.days)).isoformat()

    t0 = time.perf_counter()
    panels = fetch_daily_panels(args.codes, start, end)
    print(f"panels: {panels.close.shape[0]} rows x {panels.close.shape[1]} cols; as_of={panels.as_of}")
    print(f"first bar: {panels.close.index[0].date()}; last bar: {panels.close.index[-1].date()}")
    if panels.close.index[-1].date() >= panels.as_of:
        raise SystemExit("no-lookahead violation: last bar is not before as_of")
    print(f"names: {panels.names}")
    if panels.failures:
        print(f"failures ({len(panels.failures)}):")
        for code, reason in sorted(panels.failures.items()):
            print(f"  {code}: {reason}")
    print("last completed bar per symbol:")
    _print_last_bars(panels)

    t1 = time.perf_counter()
    chip = chip_metrics(panels.high, panels.low, panels.close, panels.turnover_rate_pct)
    print(
        f"chip_metrics: {time.perf_counter() - t1:.1f}s; "
        f"non-null profit_ratio={int(chip['profit_ratio'].notna().to_numpy().sum())}"
    )
    t2 = time.perf_counter()
    pool = limit_pool(panels.high, panels.low, panels.close, panels.prev_close, is_st=panels.is_st)
    print(f"limit_pool: {time.perf_counter() - t2:.1f}s; latest daily row:")
    print(pool.daily.tail(1).to_string())

    digest = panel_digest(
        {
            "high": panels.high,
            "low": panels.low,
            "close": panels.close,
            "prev_close": panels.prev_close,
            "turnover_rate_pct": panels.turnover_rate_pct,
        }
    )
    out = Path(args.out)
    paths = [
        write_panel(
            out,
            chip["profit_ratio"],
            alpha_id="chip_profit_ratio",
            universe="futu_a_share",
            period=f"{start}..{end}",
            data_source="futu:opend",
            panel_digest=digest,
            overwrite=args.overwrite,
        ),
        write_panel(
            out,
            pool.streak,
            alpha_id="limit_streak",
            universe="futu_a_share",
            period=f"{start}..{end}",
            data_source="futu:opend",
            panel_digest=digest,
            overwrite=args.overwrite,
        ),
    ]
    for path in paths:
        stored = read_panel(path)
        non_null = int(stored.factor.notna().to_numpy().sum())
        print(
            f"stored: {path} rows={stored.factor.shape[0]} cols={stored.factor.shape[1]} "
            f"non_null={non_null} source={stored.manifest['data_source']} digest={digest[:16]}"
        )
    print(f"total {time.perf_counter() - t0:.1f}s")
    return 1 if args.strict and panels.failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
