"""Regenerating from the reference implementations must reproduce the committed bytes.

This is the link that makes a committed fixture trustworthy: an edited CSV stops
being evidence and becomes a red test.

Both sides are compared after LF normalisation (schema's own sha definition) because
``core.autocrlf=true`` on this machine rewrites line endings at checkout — machine
fact R-46. Content differences are still caught byte for byte.
"""

from pathlib import Path

from pine_oracle import emit_fixtures
from pine_oracle.emit_fixtures import BARS_SETS, FIXTURE_DIR, PERIOD, emit
from pine_oracle.schema import (
    EXEMPTION_CLASSES,
    TOLERANCE_TIERS,
    load_manifest,
    sha256_of,
)


def _lf(path: Path) -> bytes:
    return path.read_bytes().replace(b"\r\n", b"\n")


def test_manifest_lists_every_committed_data_file() -> None:
    """Every data file the gate reads is on disk and hashes to what the manifest says.

    ``*.md`` is excluded because the prose ledger (`COVERAGE.md`, Task 7) and the
    anchor notes (`EXTERNAL_ANCHORS.md`, Task 6) live in this same directory and are
    not fixture data — listing them would put prose under a hash. Everything else is
    still enumerated in both directions, so a dropped, added or edited CSV (or a
    stray non-doc file) goes red.
    """
    manifest = load_manifest(FIXTURE_DIR / "manifest.json")
    listed = manifest["files"]
    on_disk = {
        str(p.relative_to(FIXTURE_DIR)).replace("\\", "/")
        for p in FIXTURE_DIR.rglob("*")
        if p.is_file() and p.suffix != ".md" and p.name not in {".gitattributes", "manifest.json"}
    }
    assert set(listed) == on_disk, (sorted(set(listed) - on_disk), sorted(on_disk - set(listed)))
    for rel, digest in listed.items():
        assert sha256_of(FIXTURE_DIR / rel) == digest, rel


def test_regenerated_files_are_bytewise_identical(tmp_path: Path) -> None:
    emit(out_dir=tmp_path)
    for rel in load_manifest(FIXTURE_DIR / "manifest.json")["files"]:
        assert _lf(tmp_path / rel) == _lf(FIXTURE_DIR / rel), rel


#: Manifest keys that describe the run rather than the fixture, so they legitimately
#: move between invocations and are the ONLY keys excluded below.
RUNTIME_METADATA_KEYS: frozenset[str] = frozenset({"generated_at", "head_sha"})


def test_committed_manifest_derived_keys_match_regeneration(tmp_path: Path) -> None:
    """Every manifest key except the two run-metadata ones must equal what the generator
    derives today — ``test_regenerated_files_are_bytewise_identical`` only walks ``files``,
    and ``manifest.json`` itself is not in ``files``, so the rest of it used to be unchecked.

    Hand-editing ``scripts.batch_1`` (``ta.sma(close, 5)`` -> ``7``) left every Python test
    green while the JS gate ran a script no committed source declares, and hand-editing
    ``tolerance_tier.sma`` from ``tight`` to ``loose`` widened the measured margin
    (5.797e-15 against 1e-12, about 172-fold) from 1e-12 to 1e-9, i.e. to roughly
    1.7e5-fold of headroom, in silence. Both are red here.

    The exclusion list is asserted to be present in BOTH manifests, so a key cannot be
    hidden from this comparison by renaming it into the runtime set, and the compared key
    set is asserted to be the same on both sides and non-empty — a manifest whose derived
    keys had all drifted away would otherwise compare nothing and pass.
    """
    committed = load_manifest(FIXTURE_DIR / "manifest.json")
    regenerated = emit(out_dir=tmp_path)
    assert RUNTIME_METADATA_KEYS <= set(committed), sorted(committed)
    assert RUNTIME_METADATA_KEYS <= set(regenerated), sorted(regenerated)
    derived = set(committed) - RUNTIME_METADATA_KEYS
    assert derived, "no derived manifest keys to compare — an empty set is a defect, not a green"
    assert derived == set(regenerated) - RUNTIME_METADATA_KEYS, (
        "manifest key set differs from the regenerated one: "
        f"committed-only={sorted(derived - (set(regenerated) - RUNTIME_METADATA_KEYS))} "
        f"regenerated-only={sorted((set(regenerated) - RUNTIME_METADATA_KEYS) - derived)}"
    )
    for key in sorted(derived):
        assert committed[key] == regenerated[key], (
            f"manifest.{key} is not what the reference implementations derive; regenerate "
            "the fixtures with `python -X utf8 -m pine_oracle.emit_fixtures` or fix the "
            "committed value — whichever side is actually wrong"
        )


def test_every_declared_line_is_strict_and_tiered_from_the_two_allowed_sets() -> None:
    """Membership check, nothing more: every declared tier and exemption class is one of
    the names ``schema`` allows, and every line is ``strict``.

    This is NOT the design's "only ever tighten" audit trail — it cannot see a loosening,
    because ``loose`` is a legal tier name and this test has no earlier manifest to
    compare against. Direction (a tier or class moving the wrong way between commits) is
    Task 7's tighten-only gate's job, which is the only place that has a baseline to diff.
    """
    manifest = load_manifest(FIXTURE_DIR / "manifest.json")
    for line, cls in manifest["exemption"].items():
        assert cls in EXEMPTION_CLASSES, line
    for line, tier in manifest["tolerance_tier"].items():
        assert tier in TOLERANCE_TIERS, line
    assert all(cls == "strict" for cls in manifest["exemption"].values()), manifest["exemption"]


def test_manifest_lines_match_the_scripts_plot_titles() -> None:
    """The fixture must describe exactly the lines the Pine source plots — a plot
    added or renamed without regenerating would otherwise be read from a stale CSV."""
    manifest = load_manifest(FIXTURE_DIR / "manifest.json")
    for batch, src in manifest["scripts"].items():
        titles = sorted(
            part.split('title="')[1].split('"')[0] for part in src.split("\n") if 'title="' in part
        )
        assert manifest["lines"][batch] == titles, (batch, manifest["lines"][batch], titles)


def test_batch_one_lines_are_emitted_for_every_variant() -> None:
    manifest = load_manifest(FIXTURE_DIR / "manifest.json")
    assert manifest["lines"]["batch_1"] == ["ema", "rma", "sma", "stdev", "stdev_sample"]
    assert manifest["tolerance_tier"]["stdev"] == "tight"
    assert manifest["tolerance_tier"]["ema"] == "loose"
    for line in manifest["lines"]["batch_1"]:
        for bars in BARS_SETS:
            assert f"values/{line}@{bars}.csv" in manifest["files"], (line, bars)


def test_line_names_are_unique_across_batches() -> None:
    """Two batches using one title would merge into a single tier and one CSV — the
    fixture would then be checking one of them twice.

    The first assertion is the shape guard: ``len([]) == len(set([]))`` is true, so
    without it an emptied ``lines`` map would compare nothing and pass — the very
    defect class ``schema._NON_EMPTY_MANIFEST_KEYS`` exists to refuse.
    """
    manifest = load_manifest(FIXTURE_DIR / "manifest.json")
    all_lines = [line for names in manifest["lines"].values() for line in names]
    assert all_lines, "no line names to compare — an empty set is a defect, not a green"
    assert len(all_lines) == len(set(all_lines)), sorted(all_lines)


def test_declared_engine_conventions_are_the_exact_adjudicated_set() -> None:
    """Adopting the engine's convention over the textbook one is allowed, but only
    for the lines that have been argued about by name. New adoption => new entry,
    in git, next to a point-value test that writes down both numbers.

    The second assertion is the one that keeps the table honest about its own scope:
    a convention may only be declared for a line the manifest actually tiers, so an
    entry cannot name a line that no batch emits (a key set alone would still pass
    while the table drifted away from the fixture it describes).
    """
    manifest = load_manifest(FIXTURE_DIR / "manifest.json")
    assert set(manifest["convention"]) == {
        "ema",
        "macd",
        "rsi",
        "stoch_k",
        "st_direction",
        "supertrend",
        "vwap",
    }
    assert set(manifest["convention"]) <= set(manifest["tolerance_tier"])


def test_exact_tier_is_only_for_the_declared_integer_lines() -> None:
    """``exact`` (tier value 0, i.e. bit-for-bit) is reserved for the integer-valued
    outputs ``emit_fixtures.EXACT_LINES`` names — today just ``st_direction``, a sign
    bit with no rounding to forgive. Declaring the set here as well is what keeps the
    third tier from silently widening or narrowing: moving ``st_direction`` out of
    ``EXACT_LINES`` loosens the JS gate to ``loose`` with no other test noticing, and
    adding a float line to it would demand a new argument in git.
    """
    manifest = load_manifest(FIXTURE_DIR / "manifest.json")
    exact = {line for line, t in manifest["tolerance_tier"].items() if t == "exact"}
    assert exact == {"st_direction"}, sorted(exact)
    # The same claim read off a SECOND, independent source: the generator's own set,
    # not reverse-engineered from the committed manifest it just wrote.
    assert emit_fixtures.EXACT_LINES == frozenset({"st_direction"})
    # A name in both sets would make the tier a function of which `if` comes first in
    # emit() — one key, two tiers, no visible conflict.
    assert not (emit_fixtures.EXACT_LINES & emit_fixtures.TIGHT_LINES)


def test_values_header_and_na_encoding_are_the_declared_contract() -> None:
    manifest = load_manifest(FIXTURE_DIR / "manifest.json")
    rel = f"values/sma@{next(iter(BARS_SETS))}.csv"
    text = _lf(FIXTURE_DIR / rel).decode("utf-8")
    assert text.splitlines()[0] == "bar_index,expected"
    assert "nan" not in text.lower() and "null" not in text.lower(), rel
    assert manifest["na_encoding"] == "empty"
    assert manifest["period"]["default"] == PERIOD


#: The loosest tier each line may be shipped at. A tolerance is a promise, not a knob:
#: tightening is free, and loosening costs an explicit edit to THIS table — which from
#: this round on is refused unless ``emit_fixtures``' own tier sets move with it
#: (``test_the_floor_table_is_the_tier_table_the_generator_derives``), and THAT move
#: cannot land without regenerating the committed manifest.
#:
#: WHAT THIS TABLE DOES NOT LOCK — the previous wording promised a written ruling and
#: got a comment (review round B-IMP-1: 「:198-200 注释承诺的『放宽需要书面裁定』无机器执法」):
#: there is no machine gate anywhere in this harness that demands a 项目档案.md ruling.
#: A loosening can still be pushed through as FOUR coordinated edits — this table,
#: ``emit_fixtures.EXACT_LINES``/``TIGHT_LINES``, the committed ``manifest.json`` and one
#: re-run of ``emit_coverage`` — after which every gate reads green (measured at
#: ``32fe0754`` by the review round's 针 c: 119 Python + 118 JS, zero red). This is
#: therefore a HUMAN ratchet whose channel has been narrowed, not a machine ceiling: what
#: no longer passes in silence is a lone edit to the floor table (the 针 form this round
#: added the pin for). The blind spot is registered out loud in ``COVERAGE.md``'s
#: 已知偏离 section rather than being described as closed.
#:
#: WHAT THESE 18 VALUES ARE — the previous wording ("the readings taken when the
#: fixtures were first generated") overstated them. `TIER_FLOOR` equals
#: `manifest["tolerance_tier"]` item for item (measured True at cfeeb66f by the review
#: round and again at this round's HEAD), so it is a RATCHET ON THE DECLARED TIER: it
#: refuses a line being shipped looser than the tier this repository announced. It is
#: NOT a measurement ceiling and not "the tightest tier the residual supports" — 14 of
#: the 18 lines are identically zero across all four bar sets and would therefore
#: support `exact`, and 13 of them are announced `loose`/`tight` anyway (`st_direction`
#: is the one zero line that is announced `exact`), because a tier states the SEMANTIC
#: promise of that line (no cross-bar state; ledger L-3 and Ruling H), not what today's
#: bars happened to measure. The readings live in one place and it is not this table:
#: ``coverage.MEASURED_WORST``, guarded against these tiers by
#: ``test_coverage_ledger.py``. Measured against the residual, 5 of the 18 floors
#: coincide with the tightest tier it supports — `sma`/`bb_basis`/`bb_upper`/`bb_lower`,
#: whose 1e-15-scale readings rule `exact` out, plus `st_direction` — and the other 13
#: are looser than it by the announcement.
TIER_FLOOR: dict[str, str] = {
    "sma": "tight",
    "ema": "loose",
    "rma": "loose",
    "stdev": "tight",
    "stdev_sample": "tight",
    "rsi": "loose",
    "atr": "loose",
    "bb_basis": "tight",
    "bb_upper": "tight",
    "bb_lower": "tight",
    "macd": "loose",
    "macd_signal": "loose",
    "macd_hist": "loose",
    "stoch_k": "loose",
    "stoch_d": "loose",
    "supertrend": "loose",
    "st_direction": "exact",
    "vwap": "loose",
}
TIER_ORDER: dict[str, int] = {"exact": 0, "tight": 1, "loose": 2}


def test_no_line_is_looser_than_the_tier_it_was_measured_at() -> None:
    manifest = load_manifest(FIXTURE_DIR / "manifest.json")
    tiers = manifest["tolerance_tier"]
    # the floor table covers every line, so a new batch line cannot dodge the gate
    assert set(TIER_FLOOR) == set(tiers), set(TIER_FLOOR) ^ set(tiers)
    assert tiers, "tolerance_tier 为空——下面的逐档比较一个数都不比"
    for line, floor in TIER_FLOOR.items():
        assert TIER_ORDER[tiers[line]] <= TIER_ORDER[floor], (line, tiers[line], floor)


def test_the_floor_table_is_the_tier_table_the_generator_derives(tmp_path: Path) -> None:
    """``TIER_FLOOR`` may not be looser than what ``emit_fixtures`` derives, item for item.

    The gate above reads the committed manifest, so it refuses a *declared* tier moving
    past the floor — but it never looked at the floor's own 18 values, and
    ``grep -rn TIER_FLOOR agent/`` had zero readers outside this file (review round
    B-IMP-1). That asymmetry is what made "the ratchet is tighten-only" a statement about
    a table nobody guarded: moving one floor entry a tier looser changed nothing anybody
    could observe. Re-planted this round at ``32fe0754`` (改
    ``test_pine_oracle_provenance.py`` 的 ``"sma": "tight"`` → ``"loose"``，其余文件一律不动):
    ``121 passed``, zero red.

    Pinning equality against the generator's derived tier map narrows the channel instead
    of closing it — the four-edit path described above the table still exists and is
    registered as a known blind spot in ``COVERAGE.md``. Direction is checked in the only
    direction that can loosen anything: a floor entry looser than the generator's own
    announcement is refused, while a floor at or tighter than it stays green, so a future
    tightening of a line does not have to be announced twice.

    The comparison is against ``emit()``'s output in a temporary directory OUTSIDE the
    repository (``tmp_path``) — the committed fixture is never written to, because
    ``emit_fixtures`` stamps ``head_sha``/``generated_at`` and those lines cannot be
    restored with the commands this round forbids.
    """
    derived = emit(out_dir=tmp_path)["tolerance_tier"]
    assert TIER_FLOOR, "地板表为空——下面的逐项比较一个档都不比"
    assert derived, "生成器导出的档表为空——同样比不出东西"
    assert set(TIER_FLOOR) == set(derived), set(TIER_FLOOR) ^ set(derived)
    looser = {
        line: (TIER_FLOOR[line], derived[line])
        for line in TIER_FLOOR
        if TIER_ORDER[TIER_FLOOR[line]] > TIER_ORDER[derived[line]]
    }
    assert not looser, (
        "地板表比生成器宣告的档位更松——放宽一档现在是「挪这张表 + 挪 emit_fixtures 的档集 + "
        f"重生 manifest + 重生台账」四次可见的编辑，不再是一次静默的手滑：{looser}"
    )


def test_no_line_may_be_exempted_out_of_strict_without_an_audit_trail() -> None:
    """``exemption`` may not shrink away either: an empty dict makes ``non_strict`` empty
    by accident, which is the vacuous-pass class this repo already logs (the ``all_lines``
    pin in ``test_line_names_are_unique_across_batches`` is the same fix). The key-set
    equality below is what refuses it — an exemption table that no longer names the
    tiered lines is not an audit trail, it is an absent one.
    """
    manifest = load_manifest(FIXTURE_DIR / "manifest.json")
    non_strict = {k: v for k, v in manifest["exemption"].items() if v != "strict"}
    assert manifest["exemption"], "exemption 为空——「全为 strict」的断言比较的是零条线"
    assert set(manifest["exemption"]) == set(manifest["tolerance_tier"]), (
        "exemption 与 tolerance_tier 的线名单不一致：豁免表必须逐条点名每一条被档住的线，"
        f"exemption-only={sorted(set(manifest['exemption']) - set(manifest['tolerance_tier']))} "
        f"tier-only={sorted(set(manifest['tolerance_tier']) - set(manifest['exemption']))}"
    )
    assert non_strict == {}, (
        "把任何线挪出 strict 之前，必须在 项目档案.md 留下裁定行并在这里点名它："
        f"{non_strict}"
    )
