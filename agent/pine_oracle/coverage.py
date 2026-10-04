"""The coverage ledger's own vocabulary: which ``ta.*`` a gate really touches.

Two artefacts read these sets — ``test_coverage_ledger.py`` (the machine gate) and
``emit_coverage.py`` (the human list). One definition is what keeps them from
drifting apart; a ledger that claims more than the gate checks is the failure mode
this whole harness was built to catch.

Nothing here is derived from the engine's *numbers*. ``builtins_from_source`` parses
the engine's dispatch table so a newly added ``ta.*`` shows up as a coverage gap
instead of as silence — the same rule the JS gate applies to its probe count.
"""

from __future__ import annotations

import re

#: The 11 functions whose reference values gate 2 (the oracle) prices against.
GATE2_FUNCTIONS: frozenset[str] = frozenset(
    {
        "sma",
        "ema",
        "rma",
        "stdev",
        "rsi",
        "atr",
        "bb",
        "macd",
        "stoch",
        "supertrend",
        "vwap",
    }
)

#: Functions gate 1 proves but gate 2 does NOT price.
#: ``sar``: a Parabolic SAR reference in numpy has to re-implement the reversal and
#: acceleration state machine, and a "reference" that transcribes the code under test
#: adds another place to be wrong rather than a second witness. Prefix invariance is
#: the claim that needs no cross-implementation oracle, so ``sar`` carries gate 1
#: alone — and the ledger must say so out loud (spec §11 R-C).
GATE1_ONLY: frozenset[str] = frozenset({"sar"})

#: Everything this round touches, gate 2 or gate 1.
COVERED: frozenset[str] = GATE2_FUNCTIONS | GATE1_ONLY

#: The eight script keys in ``pinePrefixInvariance.test.ts``. ``stdev_sample`` is the
#: sample branch (``ta.stdev(..., false)``) of the same builtin, so it is a script,
#: not a function — the branch map below is the only place that says so.
GATE1_SCRIPTS: frozenset[str] = frozenset(
    {"sma", "ema", "rma", "stdev", "stdev_sample", "sar", "supertrend", "vwap"}
)
SCRIPT_TO_FUNCTION: dict[str, str] = {"stdev_sample": "stdev"}

#: Each gate-2 function's plotted line names, as they appear in ``manifest.json``.
#: Written out (not derived by splitting on ``_``) because ``st_direction`` belongs to
#: ``supertrend`` and no prefix rule sees that.
FUNCTION_LINES: dict[str, tuple[str, ...]] = {
    "sma": ("sma",),
    "ema": ("ema",),
    "rma": ("rma",),
    "stdev": ("stdev", "stdev_sample"),
    "rsi": ("rsi",),
    "atr": ("atr",),
    "bb": ("bb_basis", "bb_upper", "bb_lower"),
    "macd": ("macd", "macd_signal", "macd_hist"),
    "stoch": ("stoch_k", "stoch_d"),
    "supertrend": ("supertrend", "st_direction"),
    "vwap": ("vwap",),
}

#: Gate 2's measured divergence, one row per manifest line, four readings per row in
#: ``pineOracleFixtures.BARS_VARIANTS`` order (trend, oscillating, gapped, intraday).
#:
#: These are READINGS taken off the printed ``[oracle]`` lines of the committed gate,
#: not aspirations and not a re-derivation of the comparison:
#:
#:     cd frontend && npx.cmd vitest run src/lib/__tests__/pineTaOracle.test.ts
#:
#: taken on 2026-10-04 at HEAD ``575d3382`` (72 print lines = 18 lines x 4 variants).
#: They are recorded because the *witness* a zero residual provides is a different
#: thing from the witness a non-zero one does (Ruling H): two separately written
#: implementations landing bit-for-bit on a line usually means the reference mirrors
#: the engine's arithmetic form, so that line's cross-implementation pass pins
#: SEMANTICS (seeding position, population-vs-sample choice, ``PERIOD`` wiring,
#: line name <-> ``title=``) rather than arithmetic. A non-zero residual is the case
#: where the two really do different arithmetic and still land inside the tier.
#:
#: This table is NOT the gate. ``pineTaOracle.test.ts`` asserts ``worst <= tier`` live
#: on every run; if the engine moves, that gate goes red, and ``test_coverage_ledger``
#: below then refuses a ledger whose recorded tier no longer matches the manifest.
MEASURED_WORST: dict[str, tuple[float, ...]] = {
    "sma": (2.991e-15, 3.785e-15, 5.797e-15, 9.337e-16),
    "ema": (0.0, 0.0, 0.0, 0.0),
    "rma": (0.0, 0.0, 0.0, 0.0),
    "stdev": (0.0, 0.0, 0.0, 0.0),
    "stdev_sample": (0.0, 0.0, 0.0, 0.0),
    "rsi": (0.0, 0.0, 0.0, 0.0),
    "atr": (0.0, 0.0, 0.0, 0.0),
    "bb_basis": (2.991e-15, 3.785e-15, 5.797e-15, 9.337e-16),
    "bb_upper": (2.972e-15, 3.765e-15, 5.496e-15, 9.280e-16),
    "bb_lower": (3.009e-15, 3.806e-15, 6.132e-15, 9.394e-16),
    "macd": (0.0, 0.0, 0.0, 0.0),
    "macd_signal": (0.0, 0.0, 0.0, 0.0),
    "macd_hist": (0.0, 0.0, 0.0, 0.0),
    "stoch_k": (0.0, 0.0, 0.0, 0.0),
    "stoch_d": (0.0, 0.0, 0.0, 0.0),
    "supertrend": (0.0, 0.0, 0.0, 0.0),
    "st_direction": (0.0, 0.0, 0.0, 0.0),
    "vwap": (0.0, 0.0, 0.0, 0.0),
}

#: The four bar variants ``MEASURED_WORST`` columns are ordered by, kept here so the
#: generator and the document name them instead of inventing a fifth order.
MEASURED_WORST_VARIANTS: tuple[str, ...] = (
    "bars_daily_trend",
    "bars_daily_oscillating",
    "bars_daily_gapped",
    "bars_intraday_vwap",
)

_BUILTIN_RE = re.compile(r"^  ([a-z_][a-z_0-9]*): \(args", re.M)
# Reads EXPECTED_LINES, not a count map: the gate landed as a ROSTER of line names
# (``pinePrefixInvariance.test.ts:79-88``, whose own comment at :73-78 states
# "Names, not a count (M-4)"), and no ``LINE_COUNT`` exists in the file. Reading the
# roster is the stronger claim anyway — it is the same text the gate compares
# ``Object.keys(reference).sort()`` against, and it still carries script -> line names.
_EXPECTED_LINES_RE = re.compile(
    r"const EXPECTED_LINES: Record<string, string\[\]> = \{([^}]*)\}", re.S
)
# The roster the gate LOOPS over: `for (const [name, src] of Object.entries(SCRIPTS))`
# (:127) is what decides which script gets prefix-checked at all, so a set read only
# from EXPECTED_LINES cannot see a script deleted here (review round I-2 — the hole
# `gate1_script_keys_from_ts`'s docstring used to claim it closed). The values are
# template strings whose bodies can contain `}` (`ta.supertrend`'s destructuring
# comment, any future `${}`), so `[^}]*` is the wrong character class: the match runs
# to the first line-initial `};`, which is how the block actually closes at :48.
_SCRIPTS_RE = re.compile(r"const SCRIPTS: Record<string, string> = \{(.*?)\n\};", re.S)
#: Keys only — a line-indented `ident:` at the start of a line. Comment lines start
#: with `//` and value lines start with a quote, so neither is read as a key; the
#: prose inside those comments contains `pineRuntime.ts:94-100`-style colons, which is
#: why the roster keys are NOT read with the line-agnostic ``_KEY_RE``.
_SCRIPT_KEY_RE = re.compile(r"^[ \t]*([a-z_][a-z_0-9]*):", re.M)
_KEY_RE = re.compile(r"([a-z_][a-z_0-9]*):")


def builtins_from_source(ts_text: str) -> frozenset[str]:
    """Every ``ta.*`` name in the engine's dispatch table."""
    return frozenset(_BUILTIN_RE.findall(ts_text))


def gate1_script_keys_from_ts(ts_text: str) -> frozenset[str]:
    """The script keys of ``EXPECTED_LINES`` — the roster gate 1 compares LINE NAMES to.

    Read as NAMES, not as a count, because the names are what the gate compares
    (``lineNames`` vs ``EXPECTED_LINES[name]``) — a count would still pass while the
    compared series changed identity.

    Scope, stated honestly: this map is the gate's *expectation* table, not its loop.
    The loop authority is ``SCRIPTS`` (``Object.entries(SCRIPTS)``, :127), read by
    :func:`gate1_scripts_keys_from_ts`. Neither function alone closes the
    delete-a-script hole — ``EXPECTED_LINES`` cannot notice a script removed from
    ``SCRIPTS``, and ``SCRIPTS`` cannot notice a renamed expected line. What closes it
    is ``test_coverage_ledger.py::test_gate_1_loops_exactly_the_ledger_scripts``
    requiring ``SCRIPTS keys == EXPECTED_LINES keys == GATE1_SCRIPTS``, so both
    directions are refused from the same text in the same file.
    """
    found = _EXPECTED_LINES_RE.search(ts_text)
    if found is None:
        raise ValueError("pinePrefixInvariance.test.ts: no EXPECTED_LINES roster to read")
    return frozenset(_KEY_RE.findall(found.group(1)))


def gate1_scripts_keys_from_ts(ts_text: str) -> frozenset[str]:
    """The script keys of ``SCRIPTS`` — the roster gate 1 actually ITERATES over.

    ``for (const [name, src] of Object.entries(SCRIPTS))`` (:127) is the only thing
    that decides whether a script is prefix-checked at all: delete an entry here and
    the gate silently runs one fewer script (vitest 34 → 30, and no test count pins
    it), while a roster read off ``EXPECTED_LINES`` still reports eight and the ledger
    keeps stamping that script "判据一 ✓". This is the half of the I-2 fix that makes
    the docstring's promise true instead of rewording it.
    """
    found = _SCRIPTS_RE.search(ts_text)
    if found is None:
        raise ValueError("pinePrefixInvariance.test.ts: no SCRIPTS roster to read")
    return frozenset(_SCRIPT_KEY_RE.findall(found.group(1)))


def gate1_functions() -> frozenset[str]:
    """The functions gate 1 touches, with script branches folded onto their builtin."""
    return frozenset(SCRIPT_TO_FUNCTION.get(name, name) for name in GATE1_SCRIPTS)


# The numbers gate 2 ENFORCES live are this JS table, not ``schema.TOLERANCE_TIERS``
# (``pineTaOracle.test.ts:134`` reads ``TIER_VALUE[manifest.tolerance_tier[line]]`` and
# ``:144`` asserts ``worst <= tier``). The mapping is written out twice — once in
# Python (``schema.py:27``), once here (``pineOracleFixtures.ts:28``) — and only the JS
# copy is executed, while this `.ts` file is NOT inside the ``manifest.files`` sha lock
# face (those 76 entries are bars/values CSVs only). Review round A-IMP-2 / C 席 针 a:
# widening `loose` from 1e-9 to 1e-3 — three orders of magnitude on the enforcement
# side — came back 119 Python + 118 JS green. So the JS copy gets a witness: read the
# table out of the text and compare it item for item with the Python one.
_TIER_VALUE_RE = re.compile(
    r"export const TIER_VALUE: Record<string, number> = \{([^}]*)\}", re.S
)
_TIER_PAIR_RE = re.compile(
    r"([A-Za-z_][A-Za-z_0-9]*)\s*:\s*(-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)"
)


def tier_values_from_ts(ts_text: str) -> dict[str, float]:
    """``TIER_VALUE`` from ``pineOracleFixtures.ts``, as tier name → float.

    A dict, not a key set: the finding was about the VALUES (a silently widened
    tolerance still has the same three keys). Empty is an error, never a pass — a
    reader that matched nothing would compare nothing and read green, which is the
    defect class ``schema._NON_EMPTY_MANIFEST_KEYS`` exists to refuse.
    """
    found = _TIER_VALUE_RE.search(ts_text)
    if found is None:
        raise ValueError("pineOracleFixtures.ts: no TIER_VALUE table to read")
    tiers = {name: float(value) for name, value in _TIER_PAIR_RE.findall(found.group(1))}
    if not tiers:
        raise ValueError("pineOracleFixtures.ts: TIER_VALUE read as empty — that is not a pass")
    return tiers


# ``BARS_VARIANTS`` is an ARRAY of quoted names (`as const`), not a `key:` map, so it
# needs its own pair of readers; the match runs to the first line-initial `]` for the
# same reason `SCRIPTS` does — array elements are strings and could contain brackets.
_BARS_VARIANTS_RE = re.compile(r"export const BARS_VARIANTS = \[(.*?)\n\]", re.S)
_QUOTED_NAME_RE = re.compile(r'"([^"]+)"')


def bars_variants_from_ts(ts_text: str) -> tuple[str, ...]:
    """The bar-set order gate 2 iterates, read off ``pineOracleFixtures.ts``.

    ``MEASURED_WORST``'s four columns are ordered by this list. Nothing compared that
    order before: ``test_coverage_ledger.py`` pinned ``len(MEASURED_WORST_VARIANTS) == 4``
    and "four readings per row", which stays green if someone reorders the columns —
    min/max排版 then prints a different line's story while every number is still inside
    its tier (review round M-2). Returning a TUPLE in document order is the point: a set
    would pin the members and still let the order drift.
    """
    found = _BARS_VARIANTS_RE.search(ts_text)
    if found is None:
        raise ValueError("pineOracleFixtures.ts: no BARS_VARIANTS list to read")
    order = tuple(_QUOTED_NAME_RE.findall(found.group(1)))
    if not order:
        raise ValueError("pineOracleFixtures.ts: BARS_VARIANTS read as empty — that is not a pass")
    return order


def worst_range(line: str) -> tuple[float, float]:
    """(min, max) of the four recorded gate-2 readings for one line."""
    readings = MEASURED_WORST[line]
    return min(readings), max(readings)
