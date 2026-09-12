"""Command line for the local market-data warehouse.

    python -m backtest.warehouse sync --symbols 600519.SH --since 2015-01-01
    python -m backtest.warehouse sync --universe csi300 --interval 1D
    python -m backtest.warehouse audit --interval 1D --min-gap 3
    python -m backtest.warehouse list
    python -m backtest.warehouse sql "SELECT symbol, count(*) FROM bars GROUP BY 1"

Deliberately not wired into ``agent/cli``: that surface is a 5000-line argparse
pile with slash commands and banner counts, and a data tool does not need any of
it to be usable. Exit codes are the contract for scripts: ``0`` success or a
clean audit, ``1`` work that failed or a dirty audit, ``2`` a configuration
problem that no retry will fix.
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from pathlib import Path
from typing import Any, Iterable, Sequence

from backtest.loaders.base import _duckdb_sql_string
from backtest.warehouse import audit as audit_mod
from backtest.warehouse import store, sync
from backtest.warehouse.layout import all_glob, warehouse_root

EXIT_OK = 0
EXIT_FAILED = 1
EXIT_CONFIG = 2


def build_parser() -> argparse.ArgumentParser:
    """Return the argument parser for the warehouse sub-commands."""
    parser = argparse.ArgumentParser(
        prog="python -m backtest.warehouse",
        description="Local, backtest-ready market-data warehouse (parquet + DuckDB).",
    )
    parser.add_argument(
        "--root",
        type=Path,
        default=None,
        help="warehouse directory (default: $VIBE_TRADING_WAREHOUSE_ROOT or ~/.vibe-trading/warehouse)",
    )
    parser.add_argument("-v", "--verbose", action="store_true", help="log INFO and above")
    sub = parser.add_subparsers(dest="command", required=True)

    fill = sub.add_parser("sync", help="fetch bars into the warehouse")
    target = fill.add_mutually_exclusive_group(required=True)
    target.add_argument("--symbols", help="comma-separated tickers, e.g. 600519.SH,510050.SH")
    target.add_argument(
        "--universe", choices=["csi300"], help="named roster to resolve from the source"
    )
    fill.add_argument("--source", default=sync.DEFAULT_SOURCE, help="data source name")
    fill.add_argument("--interval", default=sync.DEFAULT_INTERVAL, help="bar interval (1D)")
    fill.add_argument("--since", default=None, help="YYYY-MM-DD; forces a backfill from here")
    fill.add_argument("--until", default=None, help="YYYY-MM-DD; capped at the last settled session")
    fill.add_argument(
        "--years",
        type=int,
        default=sync.DEFAULT_YEARS,
        help="history depth when a symbol has nothing stored yet",
    )
    fill.add_argument(
        "--per-minute",
        type=float,
        default=sync.DEFAULT_PER_MINUTE,
        help="request-rate ceiling",
    )
    fill.add_argument(
        "--budget-s", type=float, default=sync.DEFAULT_BUDGET_S, help="wall-clock budget"
    )
    fill.add_argument(
        "--dry-run",
        action="store_true",
        help="print the planned windows without fetching or writing",
    )
    fill.add_argument("--json", action="store_true", help="emit the report as JSON")

    check = sub.add_parser("audit", help="report coverage, suspected halts, bad rows")
    check.add_argument("--interval", default=sync.DEFAULT_INTERVAL)
    check.add_argument("--symbols", help="comma-separated tickers to narrow the halt scan")
    check.add_argument(
        "--min-gap",
        type=int,
        default=audit_mod.MIN_GAP_SESSIONS,
        help="shortest missing run worth reporting, in reference sessions",
    )
    check.add_argument(
        "--no-gaps", action="store_true", help="skip the halt scan (whole-warehouse checks only)"
    )
    check.add_argument("--json", action="store_true")

    listing = sub.add_parser("list", help="inventory what is stored")
    listing.add_argument("--json", action="store_true")

    query = sub.add_parser("sql", help="query the stored bars directly")
    query.add_argument("statement", help="SQL; the bars table is exposed as 'bars'")
    query.add_argument("--csv", type=Path, default=None, help="write the result here as well")
    query.add_argument(
        "--max-rows", type=int, default=40, help="rows printed to the terminal"
    )
    return parser


def _symbols(value: str | None) -> list[str]:
    return [part.strip() for part in str(value or "").split(",") if part.strip()]


def _configure_logging(verbose: bool) -> None:
    logging.basicConfig(
        level=logging.INFO if verbose else logging.WARNING,
        format="%(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )


def _emit(payload: Any, as_json: bool, lines: Iterable[str]) -> None:
    if as_json:
        print(json.dumps(payload, indent=2, sort_keys=True, default=str))
        return
    for line in lines:
        print(line)


def cmd_sync(args: argparse.Namespace, root: Path | None) -> int:
    """Fill the warehouse; see :func:`backtest.warehouse.sync.sync_symbols`."""
    # A dry run plans from local state and disk coverage, so it must not need
    # credentials; resolving a named roster is the one plan step that does.
    loader = None
    if args.universe or not args.dry_run:
        loader = sync.load_source(args.source)
    wanted = _symbols(args.symbols)
    roster: sync.UniverseRoster | None = None
    if args.universe:
        end = args.until or str(sync.settled_end().date())
        start = args.since or sync.resolve_window(
            None, start=None, end=None, years=args.years
        )[0]
        roster = sync.resolve_universe(args.universe, start=start, end=end, loader=loader)
        wanted = roster.codes
        print(f"{args.universe}: {len(wanted)} name(s) for {start}..{end}", file=sys.stderr)
        # Stored before any bar is fetched: the roster costs an API call that can
        # fail later for quota reasons, and a name list without its membership
        # dates is the survivorship-biased half of the answer.
        roster_path = roster.persist(root=root, dry_run=args.dry_run)
        if roster_path is not None:
            print(f"roster: {roster_path}", file=sys.stderr)
    if not wanted:
        print("nothing to sync: the symbol list resolved to zero names", file=sys.stderr)
        return EXIT_CONFIG

    report = sync.sync_symbols(
        wanted,
        source=args.source,
        interval=args.interval,
        start=args.since,
        end=args.until,
        years=args.years,
        root=root,
        per_minute=args.per_minute,
        budget_s=args.budget_s,
        dry_run=args.dry_run,
        loader=loader,
        progress=None if args.json else (lambda line: print(line, file=sys.stderr)),
    )
    _emit(report.to_dict(), args.json, [report.summary()])
    for line in report.problems():
        print(f"  ! {line}", file=sys.stderr)
    if report.failed or report.stopped_reason:
        return EXIT_FAILED
    return EXIT_OK


def cmd_audit(args: argparse.Namespace, root: Path | None) -> int:
    """Report warehouse health; never touches the data."""
    try:
        report = audit_mod.audit(
            interval=args.interval,
            root=root,
            min_sessions=args.min_gap,
            symbols=_symbols(args.symbols) or None,
            check_gaps=not args.no_gaps,
        )
    except audit_mod.WarehouseAuditError as exc:
        print(f"audit failed: {exc}", file=sys.stderr)
        return EXIT_CONFIG
    _emit(report.to_dict(), args.json, [report.summary()])
    return EXIT_OK if report.is_clean() else EXIT_FAILED


def cmd_list(args: argparse.Namespace, root: Path | None) -> int:
    """Print the stored inventory."""
    lines = audit_mod.summarize_intervals(root)
    if not lines:
        _emit([], args.json, [f"no warehouse data under {warehouse_root() if root is None else root}"])
        return EXIT_OK
    if args.json:
        _emit(lines, True, [])
        return EXIT_OK
    print(f"{'interval':<8} {'grain':<11} {'symbols':>8} {'rows':>12} "
          f"{'first':<10} {'last':<10} {'partitions':>10} {'size':>9}  sources/markets")
    for row in lines:
        print(
            f"{row['interval']:<8} {row['grain']:<11} {row['symbols']:>8} {row['rows']:>12} "
            f"{str(row['first']):<10} {str(row['last']):<10} {row['partitions']:>10} "
            f"{_human_bytes(row['bytes']):>9}  {','.join(row['sources'])}/{','.join(row['markets'])}"
        )
    manifest = store.read_manifest(root)
    if manifest.get("sources"):
        print("manifest sources:", json.dumps(manifest["sources"], sort_keys=True))
    else:
        print("manifest: no source provenance recorded")
    return EXIT_OK


def cmd_sql(args: argparse.Namespace, root: Path | None) -> int:
    """Run one SQL statement over the stored bars, exposed as ``bars``.

    This is the factor-mining entry point: the view keeps the Hive partition
    keys (``interval``, ``year``, ``month``) as columns, so a query can prune by
    directory instead of scanning every file.
    """
    import duckdb

    glob = all_glob(root)
    con = duckdb.connect(database=":memory:")
    try:
        con.execute(
            "CREATE VIEW bars AS SELECT * FROM read_parquet("
            f"{_duckdb_sql_string(glob)}, hive_partitioning = 1, union_by_name = 1)"
        )
        frame = con.execute(args.statement).df()
    except Exception as exc:  # noqa: BLE001 - the user's SQL is the thing under test
        print(f"query failed: {exc}", file=sys.stderr)
        return EXIT_CONFIG
    finally:
        con.close()
    if args.csv:
        args.csv.parent.mkdir(parents=True, exist_ok=True)
        frame.to_csv(args.csv, index=False)
        print(f"wrote {len(frame)} row(s) to {args.csv}", file=sys.stderr)
    print(frame.to_string(max_rows=args.max_rows))
    print(f"[{len(frame)} row(s) / {len(frame.columns)} column(s)]")
    return EXIT_OK


def _human_bytes(count: int) -> str:
    size = float(count or 0)
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if size < 1024 or unit == "TB":
            return f"{size:.1f}{unit}" if unit != "B" else f"{size:.0f}B"
        size /= 1024.0
    return f"{size:.1f}TB"


def main(argv: Sequence[str] | None = None) -> int:
    """Entry point; returns the process exit code."""
    args = build_parser().parse_args(argv)
    _configure_logging(bool(getattr(args, "verbose", False)))
    root = Path(args.root).expanduser() if args.root else None
    handlers = {"sync": cmd_sync, "audit": cmd_audit, "list": cmd_list, "sql": cmd_sql}
    handler = handlers.get(str(args.command))
    if handler is None:  # pragma: no cover - argparse restricts the choices
        print(f"unknown command: {args.command}", file=sys.stderr)
        return EXIT_CONFIG
    try:
        return handler(args, root)
    except (sync.SyncConfigError, store.WarehouseSchemaMismatch) as exc:
        print(f"config: {exc}", file=sys.stderr)
        return EXIT_CONFIG
    except KeyboardInterrupt:  # state is per-run, so a cancelled sync resumes
        print("interrupted; progress already written is durable — re-run to continue", file=sys.stderr)
        return EXIT_FAILED


if __name__ == "__main__":
    raise SystemExit(main())
