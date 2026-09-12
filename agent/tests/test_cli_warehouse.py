"""Where the warehouse lives for the person typing at a terminal.

The store, sync and audit logic has its own test files; this one covers the
four claims a user can actually check from a keyboard:

* ``vibe-trading --help`` names ``warehouse``, so the feature is findable from
  the front door rather than only from a README.
* ``vibe-trading warehouse`` and ``... --help`` print the real sub-command list
  with the name the user typed, and exit ``0`` -- a usage error there reads like
  a broken install and hides the one thing they were looking for.
* ``--root`` binds on either side of the sub-command, and the value reaches the
  handler: a flag argparse accepts and then drops is worse than one that
  rejects it, because the output looks right.
* the exit code is the verdict, not the print (``audit`` exits ``1`` on a row
  that cannot exist, and stays at ``0`` for a suspected halt), which is what lets
  a cron line or CI step branch on it.
"""

from __future__ import annotations

from pathlib import Path

import pandas as pd
import pytest

from backtest.warehouse import store
from backtest.warehouse.__main__ import build_parser
from backtest.warehouse.layout import partition_file
from backtest.warehouse.schema import normalize_bars
from cli import _legacy

#: Ten Mon-Fri sessions: enough of a grid that the audit calendar has a shape.
_SESSIONS = pd.bdate_range("2020-01-06", periods=10)
_PEER = "600000.SH"
_HALTED = "600519.SH"


def _write(root: Path, symbol: str, index: pd.DatetimeIndex) -> None:
    """Push *index* through the real write gate into *root*."""
    frame = pd.DataFrame(
        {
            "open": [100.0] * len(index),
            "high": [101.0] * len(index),
            "low": [99.0] * len(index),
            "close": [100.0] * len(index),
            "volume": [1000.0] * len(index),
            "amount": [5000.0] * len(index),
            "adj_factor": [1.0] * len(index),
        },
        index=index,
    )
    frame.index.name = "trade_date"
    bars, report = normalize_bars(
        frame,
        symbol=symbol,
        interval="1D",
        source="tushare",
        volume_unit="lots",
        amount_unit="cny_thousand",
    )
    assert report.is_clean, f"the fixture must survive its own gate: {report.to_dict()}"
    store.write_bars(bars, interval="1D", root=root)


def _run(argv: list[str]) -> int:
    """Invoke the packaged CLI the way the console script does."""
    return int(_legacy.main(list(argv)))


# ---------------------------------------------------------------------------
# Findability
# ---------------------------------------------------------------------------


def test_the_front_door_help_names_the_warehouse() -> None:
    """A user must not need the README to learn the command exists."""
    help_text = _legacy._build_parser().format_help()

    assert "warehouse" in help_text
    # The one-liner has to survive argparse's wrapping, or the entry is a bare
    # word in a list; check for a phrase that only the help text carries.
    assert "Local bar warehouse" in help_text.replace("\n", " ")


@pytest.mark.parametrize(
    "argv",
    [
        ["warehouse"],  # bare: the sub-commands are the answer
        ["warehouse", "--help"],
        ["warehouse", "-h"],
    ],
)
def test_warehouse_help_reaches_its_own_parser(argv: list[str], capsys) -> None:
    """``--help`` must print the sub-commands, not the top-level usage.

    argparse will not forward a leading ``--help`` through a positional
    (REMAINDER does not match option-like tokens), so the command is intercepted
    before :func:`cli._legacy.main` parses anything. Without that interception
    this prints ``vibe-trading [-h] [--version] ...`` and exits 2.
    """
    code = _run(argv)
    out = capsys.readouterr().out

    assert code == 0, out
    assert "{sync,audit,list,sql}" in out
    # Not the delegating parser's own surface: those flags belong to no
    # warehouse command.
    assert "--max-iter" not in out
    assert "PROMPT" not in out


def test_help_uses_the_name_the_user_typed(capsys) -> None:
    """The usage line has to be copy-pasteable from the screen they are on."""
    code = _run(["warehouse", "--help"])
    out = capsys.readouterr().out

    assert code == 0
    assert "vibe-trading warehouse" in out
    assert "python -m backtest.warehouse" not in out, "the module path leaked through"


def test_an_unknown_warehouse_command_is_a_usage_error_not_a_traceback(capsys) -> None:
    """The delegated parser's own error path still has to come back as a code."""
    code = _run(["warehouse", "frobnicate"])
    err = capsys.readouterr().err

    assert code == 2
    assert "invalid choice" in err
    assert "frobnicate" in err


# ---------------------------------------------------------------------------
# Flag binding
# ---------------------------------------------------------------------------


@pytest.mark.parametrize("before", [True, False])
def test_root_is_accepted_on_either_side_of_the_subcommand(before: bool) -> None:
    """``--root X list`` and ``list --root X`` must both bind.

    The sub-parser copy carries ``default=SUPPRESS``; give it a real default and
    the sub-command overwrites the program-level value with ``None``, which is
    the silent half of this bug.
    """
    argv = ["--root", "D:/bars", "list"] if before else ["list", "--root", "D:/bars"]

    assert build_parser().parse_args(argv).root == Path("D:/bars")


def test_a_flag_the_handler_ignored_would_show_the_wrong_root(
    tmp_path: Path, capsys
) -> None:
    """Prove the bound value reaches the handler, not just argparse."""
    elsewhere = tmp_path / "elsewhere"

    code = _run(["warehouse", "list", "--root", str(elsewhere)])
    out = capsys.readouterr().out

    assert code == 0
    assert "no warehouse data under" in out
    assert str(elsewhere) in out, "the report named the default root, so --root was dropped"


def test_a_seeded_warehouse_answers_list_and_sql(tmp_path: Path, capsys) -> None:
    """The read side of the CLI works on real files, empty-root paths aside."""
    _write(tmp_path, _PEER, _SESSIONS)

    code = _run(["warehouse", "list", "--root", str(tmp_path)])
    listing = capsys.readouterr().out
    assert code == 0
    assert "1D" in listing
    assert str(len(_SESSIONS)) in listing, f"row count missing from:\n{listing}"

    code = _run(
        [
            "warehouse",
            "sql",
            "SELECT symbol, count(*) AS n FROM bars GROUP BY symbol",
            "--root",
            str(tmp_path),
        ]
    )
    query = capsys.readouterr().out
    assert code == 0
    assert _PEER in query
    assert "[1 row(s) / 2 column(s)]" in query


def test_bad_sql_reports_and_exits_without_a_traceback(tmp_path: Path, capsys) -> None:
    """User SQL is the untrusted input here; the exit code is the contract."""
    _write(tmp_path, _PEER, _SESSIONS)

    code = _run(["warehouse", "sql", "SELECT nope FROM bars", "--root", str(tmp_path)])
    err = capsys.readouterr().err

    assert code == 2
    assert "query failed" in err


# ---------------------------------------------------------------------------
# Exit code as verdict
# ---------------------------------------------------------------------------


def test_a_complete_store_audits_clean(tmp_path: Path, capsys) -> None:
    _write(tmp_path, _PEER, _SESSIONS)

    code = _run(["warehouse", "audit", "--root", str(tmp_path), "--symbols", _PEER])

    assert code == 0, capsys.readouterr().out


def test_an_impossible_row_flips_the_audit_exit_code(tmp_path: Path, capsys) -> None:
    """``audit`` exiting 1 on unreadable data is what makes it usable in a script.

    The row is written straight to disk, past the write gate, because that is
    the case only an audit can see (a hand-copied partition). Suspected halts
    are deliberately *not* in this test: they report but never fail the run, so
    a non-zero code always means "a stored row is impossible".
    """
    _write(tmp_path, _PEER, _SESSIONS)
    path = partition_file("1D", _SESSIONS[0], tmp_path)
    frame = store._read_partition(path).copy()
    frame.loc[frame["symbol"] == _PEER, "close"] = 0.0
    store._write_partition(path, frame, interval="1D", root=tmp_path)

    code = _run(
        [
            "warehouse",
            "audit",
            "--root",
            str(tmp_path),
            "--symbols",
            _PEER,
            "--no-gaps",
        ]
    )
    out = capsys.readouterr().out

    assert code == 1, f"a zero-priced bar must not audit clean:\n{out}"
    assert "nonpositive_price" in out


def test_a_halt_is_reported_without_failing_the_audit(tmp_path: Path, capsys) -> None:
    """The other half of the contract: exit 1 means bad rows, nothing else.

    A name missing sessions in the middle of the stored calendar is the
    warehouse's most common finding, and a nightly job that pages on it would be
    ignored within a week.
    """
    _write(tmp_path, _PEER, _SESSIONS)
    # Interior absence only: days before a name's first bar are its listing date
    # and days after the last are an unfinished sync, neither of them a halt.
    _write(tmp_path, _HALTED, _SESSIONS[[0, 1, 2, 7, 8, 9]])

    code = _run(["warehouse", "audit", "--root", str(tmp_path)])
    out = capsys.readouterr().out

    assert code == 0, out
    assert _HALTED in out, "the halt still has to be named on the way past"


def test_json_output_is_exactly_one_parseable_document(tmp_path: Path, capsys) -> None:
    """``--json`` is a machine surface: stdout must be loadable, nothing else.

    A banner or a stray progress line on stdout would make ``... --json |
    python -c "json.load(sys.stdin)"`` fail, so the check is that the whole
    stream parses -- not that a substring of it does.
    """
    import json

    _write(tmp_path, _PEER, _SESSIONS)

    assert _legacy.main(["warehouse", "list", "--root", str(tmp_path), "--json"]) == 0
    rows = json.loads(capsys.readouterr().out)

    assert [row["interval"] for row in rows] == ["1D"]
    assert rows[0]["rows"] == len(_SESSIONS)


def test_parser_stays_single_sourced() -> None:
    """The packaged CLI must not restate warehouse's flags.

    ``_legacy`` registers the command name for discovery and hands argv over. If
    someone copies ``--symbols``/``--universe`` into ``cli/_legacy.py`` to "fix"
    a parse error, the two copies drift and one of them starts lying.
    """
    from cli import _legacy as legacy_mod

    source = Path(legacy_mod.__file__).read_text(encoding="utf-8")
    start = source.index('subparsers.add_parser(\n        "warehouse"')
    block = source[start : start + 1200]

    assert "warehouse_args" in block, "the pass-through positional is gone"
    for flag in ("--symbols", "--universe", "--dry-run", "--min-gap"):
        assert flag not in block, f"{flag} is now maintained in two places"
