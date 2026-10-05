"""Tests for tools/wiki_qmind.py — the QMind ingest planner (M4).

Why this module exists at all: the QMind tool face has no `update` and no `delete`
(spec §2 ⑨), so every ingest is append-only. An unplanned batch upload turns the
notebook into a pile of stale copies that nothing can retract. The planner is the
half that can be proven offline — roster, sha dedupe, title scheme, `list_sources`
reconciliation — while the upload itself is a human/MCP step.

As of 2026-10-05 the channel is NOT provisioned (`list_notebooks` -> totalSize 0,
`add_source`/`retrieve` -> permission_denied), so nothing here touches the network:
these cases pin the contract the moment a notebook exists, and pin that the state
file cannot claim an ingest that never happened.

Run with::

    pytest tools/test_wiki_qmind.py -v
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import re
import subprocess
from pathlib import Path

import pytest

import wiki_qmind
from wiki_qmind import (  # type: ignore[import-untyped]
    DumpShapeError,
    ID_KEYS,
    RosterError,
    SentinelError,
    load_state,
    plan,
    reconcile,
    roster,
    sentinel,
    title_for,
)

REAL_REPO = Path(__file__).resolve().parents[1]
FACES = ("overview", "architecture", "tech-stack", "conventions", "commands")


def build_tree(root: Path, modules: dict[str, list[str]], cards: list[str]) -> Path:
    """A throwaway aggregation layer: `modules/<slug>/<face>.md` + `cards/<n>.md`."""
    for slug, faces in modules.items():
        for face in faces:
            page = root / "repowiki" / "modules" / slug / f"{face}.md"
            page.parent.mkdir(parents=True, exist_ok=True)
            page.write_text(f"---\npage: x\n---\n# {slug}/{face}\n\nbody of {slug} {face}\n",
                            encoding="utf-8")
    for name in cards:
        page = root / "repowiki" / "cards" / f"{name}.md"
        page.parent.mkdir(parents=True, exist_ok=True)
        page.write_text(f"# card {name}\n\nzeta-{name}-unique-token\n", encoding="utf-8")
    return root


def mini(root: Path, n: int = 3) -> list[dict]:
    return roster(build_tree(root, {"agent-backend": list(FACES[:n])}, []), expected=n)


def dump_of(ros: list[dict]) -> list[dict]:
    return [{"title": e["title"], "id": f"src-{i}"} for i, e in enumerate(ros)]


# ---------------------------------------------------------------------------
# the roster: what is allowed into a store that cannot be edited afterwards
# ---------------------------------------------------------------------------


def test_the_real_roster_is_exactly_the_aggregation_layer_44():
    """35 module faces + 9 repo cards, and nothing else. `SECURITY.md` at the repo
    root is not an aggregation page, so a roster that globbed the root would upload
    a file the fork's own trademark gate forbids inside `repowiki/**`."""
    ros = roster(REAL_REPO)
    assert len(ros) == 44, len(ros)
    paths = {e["path"] for e in ros}
    expected = {
        p.relative_to(REAL_REPO / "repowiki").as_posix()
        for p in list((REAL_REPO / "repowiki" / "modules").rglob("*.md"))
        + list((REAL_REPO / "repowiki" / "cards").rglob("*.md"))
    }
    assert paths == expected, sorted(paths ^ expected)
    modules = [e for e in ros if e["path"].startswith("modules/")]
    cards = [e for e in ros if e["path"].startswith("cards/")]
    assert (len(modules), len(cards)) == (35, 9), (len(modules), len(cards))


def test_a_roster_of_the_wrong_size_raises_instead_of_passing(tmp_path):
    """The documented false green here is an empty walk that vacuously asserts: a
    directory with no aggregation pages must raise, not return `[]` and read as
    "nothing left to upload"."""
    with pytest.raises(RosterError):
        roster(tmp_path, expected=3)
    build_tree(tmp_path, {"agent-backend": ["overview"]}, [])
    with pytest.raises(RosterError):
        roster(tmp_path, expected=3)
    with pytest.raises(RosterError):
        roster(REAL_REPO / "docs", expected=44)


# ---------------------------------------------------------------------------
# titles and sha dedupe
# ---------------------------------------------------------------------------


def test_title_is_the_relative_path_at_seven_hex_of_the_content_sha(tmp_path):
    """`list_sources` is the only reconciliation surface QMind gives back, and there
    is no update — so the sha has to live IN the title for a second copy of an
    edited page to be recognisable instead of anonymous."""
    entry = mini(tmp_path, 1)[0]
    assert entry["title"] == f'{entry["path"]}@{entry["sha"][:7]}'
    assert entry["sha"] == hashlib.sha256(Path(entry["abs"]).read_bytes()).hexdigest()
    assert entry["title"] == title_for(entry["path"], entry["sha"])
    page = Path(entry["abs"])
    page.write_text(page.read_text(encoding="utf-8") + "\nappended\n", encoding="utf-8")
    again = roster(tmp_path, expected=1)[0]
    assert again["title"] != entry["title"], "a content change must change the title"


def test_plan_skips_what_the_state_holds_and_lists_what_it_does_not(tmp_path):
    ros = mini(tmp_path, 3)
    state = {"sources": {ros[0]["path"]: {"sha": ros[0]["sha"], "sourceId": "s0"},
                         ros[1]["path"]: {"sha": "deadbe" + "0" * 58, "sourceId": "s1"}}}
    pending = plan(state, ros)
    assert [e["path"] for e in pending] == [ros[1]["path"], ros[2]["path"]], pending
    assert [e["kind"] for e in pending] == ["file", "file"], pending


def test_a_pending_entry_names_a_file_that_actually_exists(tmp_path):
    """`add_source` takes `kind: file` plus a local path. A plan pointing at a path
    that is not on disk uploads nothing while the batch still looks complete."""
    for entry in plan({"sources": {}}, mini(tmp_path, 3)):
        assert Path(entry["filePath"]).is_file(), entry
        assert Path(entry["filePath"]) == Path(entry["abs"]), entry
        assert len(entry["title"]) <= 500, entry["title"]


# ---------------------------------------------------------------------------
# reconcile: the dump is the only witness of what the server really holds
# ---------------------------------------------------------------------------


def test_reconcile_writes_source_ids_only_when_the_dump_matches_one_to_one(tmp_path):
    ros = mini(tmp_path, 3)
    state = {"sources": {}, "channel": {"status": "unavailable"}}
    new, problems = reconcile(state, dump_of(ros), ros)
    assert problems == [], problems
    assert {k: v["sourceId"] for k, v in new["sources"].items()} == {
        ros[0]["path"]: "src-0", ros[1]["path"]: "src-1", ros[2]["path"]: "src-2"}
    assert new["sources"][ros[2]["path"]]["sha"] == ros[2]["sha"]


def test_reconcile_refuses_two_sources_carrying_the_same_title(tmp_path):
    """Append-only store: two copies of one page is the exact failure §8.1 exists to
    make visible, so it must stop the write rather than pick one silently."""
    ros = mini(tmp_path, 3)
    dup = dump_of(ros) + [{"title": ros[1]["title"], "id": "dupe"}]
    new, problems = reconcile({"sources": {}, "channel": {}}, dup, ros)
    assert any("duplicate" in p and ros[1]["title"] in p for p in problems), problems
    assert new["sources"] == {}, new


def test_reconcile_reports_a_stamped_source_the_dump_no_longer_has(tmp_path):
    """A sourceId we recorded that `list_sources` no longer returns means the
    notebook moved behind our back or we never wrote it. Either way the state file
    must not keep vouching for it quietly."""
    ros = mini(tmp_path, 3)
    state = {"sources": {"ghost/page.md": {"sha": "f" * 64, "sourceId": "gone"}},
             "channel": {}}
    new, problems = reconcile(state, dump_of(ros), ros)
    assert any("orphan" in p and "gone" in p for p in problems), problems
    assert "ghost/page.md" not in new["sources"], new["sources"]


def test_reconcile_refuses_a_dump_item_without_a_known_id_field(tmp_path):
    """The live `list_sources` shape is unobserved because the channel is closed, so
    an unrecognised item must raise rather than record `sourceId: null` — a state
    file that reads as if an ingest happened is the lie this tool exists to prevent."""
    ros = mini(tmp_path, 3)
    junk = [{"title": e["title"], "identifier": f"x{i}"} for i, e in enumerate(ros)]
    with pytest.raises(DumpShapeError):
        reconcile({"sources": {}, "channel": {}}, junk, ros)


# The four spellings are the tool's own documented tolerance, written before anyone has
# read the real envelope. Mutation probe MP-5 (narrowing `ID_KEYS` to `("id",)`) stayed
# green with only `test_reconcile_refuses_a_dump_item_without_a_known_id_field` in place:
# that case cannot see the narrowing, so the set itself needed pinning — otherwise the
# day the notebook is opened, a dump keyed `sourceId` is refused as a shape error.
ID_SPELLINGS = ("id", "sourceId", "source_id", "uid")


def test_the_accepted_id_spellings_are_exactly_the_documented_four():
    assert tuple(ID_KEYS) == ID_SPELLINGS, ID_KEYS


@pytest.mark.parametrize("key", ID_SPELLINGS)
def test_a_dump_item_is_accepted_under_any_documented_id_spelling(tmp_path, key):
    ros = mini(tmp_path, 2)
    items = [{"title": e["title"], key: f"src-{i}"} for i, e in enumerate(ros)]
    new, problems = reconcile({"sources": {}, "channel": {}}, items, ros)
    assert problems == [], problems
    assert new["sources"][ros[1]["path"]]["sourceId"] == "src-1"


def test_a_dump_that_is_not_a_list_of_items_is_refused(tmp_path):
    """`reconcile` accepts the JSON array of `{title, id}` the operator pastes out of
    `list_sources`. Feeding it the raw MCP envelope (or a typo'd file) must raise, not
    iterate a dict's keys and produce an empty-but-successful reconciliation."""
    ros = mini(tmp_path, 3)
    with pytest.raises(DumpShapeError):
        reconcile({"sources": {}, "channel": {}}, {"data": dump_of(ros)}, ros)
    with pytest.raises(DumpShapeError):
        reconcile({"sources": {}, "channel": {}}, None, ros)


def test_reconcile_keeps_the_channel_block_byte_for_byte(tmp_path):
    """`channel` is the honest record that the upload leg is blocked; dropping it on
    a rewrite would make the state file read as if the probe had succeeded."""
    ros = mini(tmp_path, 3)
    channel = {"status": "unavailable",
               "detail": [{"code": "permission_denied",
                           "message": "The notebook is outside the current Agent "
                                      "Notebook scope.",
                           "operationId": "4b319bc8-b77e-4912-94af-e85a59290c61"}]}
    new, problems = reconcile({"sources": {}, "channel": channel}, dump_of(ros), ros)
    assert problems == [], problems
    assert new["channel"] == channel, new["channel"]


def test_load_state_reads_a_missing_file_as_an_empty_plan(tmp_path):
    """No state file yet is not an error — it is 'nothing ingested' — but the shape
    has to be the one `plan` understands, or the first run silently plans zero."""
    assert load_state(tmp_path / "nope.json") == {
        "version": 1, "notebook": "vibe-trading-repowiki", "sources": {}}


# ---------------------------------------------------------------------------
# the positive-proof sentinel (spec §8.1: recall must be provable, not assumed)
# ---------------------------------------------------------------------------


def test_sentinel_returns_a_token_no_other_roster_page_contains(tmp_path):
    """Proof that an ingest landed: a phrase living in exactly one ingested file.
    Uniqueness is measured against the roster, because the notebook only ever holds
    the roster — claiming uniqueness against the whole repo would be a stronger
    statement than `retrieve` can actually support."""
    ros = roster(build_tree(tmp_path, {"agent-backend": list(FACES[:2])}, ["alpha"]),
                 expected=3)
    pick = next(e for e in ros if e["path"].startswith("cards/"))
    assert sentinel(ros, pick["path"]) == "zeta-alpha-unique-token"


def test_sentinel_refuses_a_page_whose_tokens_are_all_shared(tmp_path):
    root = tmp_path / "repowiki" / "modules" / "m"
    root.mkdir(parents=True)
    (root / "overview.md").write_text("# overview\n\nuniformly-shared-marker here\n",
                                      encoding="utf-8")
    (tmp_path / "repowiki" / "cards").mkdir(parents=True)
    (tmp_path / "repowiki" / "cards" / "c.md").write_text(
        "# card c\n\nuniformly-shared-marker there\n", encoding="utf-8")
    ros = roster(tmp_path, expected=2)
    with pytest.raises(SentinelError):
        sentinel(ros, "cards/c.md")


# ---------------------------------------------------------------------------
# the gate that keeps this tool read-only in a repo whose other tools are not
# ---------------------------------------------------------------------------

WRITE_ATTRS = ("write_text", "write_bytes", "mkdir", "makedirs", "touch",
               "copyfile", "copy2", "copytree", "rename", "unlink")
QUALIFIED_WRITES = {"os": ("replace", "remove"), "shutil": ("copy",)}


def _writers(path: Path) -> dict[str, set[str]]:
    """{function: {write spellings}} for the module, ignoring calls that appear only
    as an argument inside `print(...)`.

    The root of an attribute chain is resolved (`STATE.parent.mkdir` counts as a
    `STATE` write) because the shape the gate must not miss is exactly the one that
    reaches the filesystem through a chain."""
    tree = ast.parse(path.read_text(encoding="utf-8"))
    printed: set[int] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) \
                and node.func.id == "print":
            printed.update(s.lineno for s in ast.walk(node) if isinstance(s, ast.Call))

    def root_of(node: ast.expr) -> str | None:
        while isinstance(node, ast.Attribute):
            node = node.value
        return node.id if isinstance(node, ast.Name) else None

    def spelling(call: ast.Call) -> str | None:
        f = call.func
        if isinstance(f, ast.Attribute):
            base = root_of(f.value)
            if f.attr in WRITE_ATTRS or f.attr in QUALIFIED_WRITES.get(base, ()):
                return f"{base}.{f.attr}" if base else f".{f.attr}"
            return None
        if isinstance(f, ast.Name) and f.id == "open":
            return "open"
        return None

    found: dict[str, set[str]] = {}
    for fn in (n for n in ast.walk(tree) if isinstance(n, ast.FunctionDef)):
        for call in (c for c in ast.walk(fn) if isinstance(c, ast.Call)):
            if call.lineno in printed:
                continue
            name = spelling(call)
            if name:
                found.setdefault(fn.name, set()).add(name)
    return found


def test_only_reconcile_writes_and_it_writes_only_the_state_file():
    """`plan`/`status`/`sentinel` must run on a read-only root (CI invokes them that
    way); a stray writer turns the planner into the thing that dirties the
    publication tree. The set is exact, not a floor: an unrecognised spelling shows
    up as a name in the failure, and adding a second writer is a decision that has
    to be made here."""
    writers = _writers(REAL_REPO / "tools" / "wiki_qmind.py")
    assert set(writers) == {"cmd_reconcile"}, writers
    assert writers["cmd_reconcile"] == {"STATE.mkdir", "STATE.write_text"}, writers


def test_reconcile_apply_writes_lf_bytes(tmp_path, monkeypatch):
    """`repowiki/.gitattributes` pins `* text=auto eol=lf`, and on Windows a
    `write_text` with the default newline translation silently writes CRLF into that
    tree — the file on disk then has bytes the committed blob does not, which is the
    same class of defect the pin exists to prevent (`body_sha` hashes prose bytes, and
    `load_state` here reads the *disk* copy). The producer must state its newline.

    `roster`/`load_state` are reached through the module because their `root`/`path`
    defaults were bound at def time to the real repo — without the seam this case would
    reconcile a tmp dump against the 44 real pages and exit 1 by construction."""
    ros = mini(tmp_path, 3)
    dump = tmp_path / "dump.json"
    dump.write_text(json.dumps(dump_of(ros)), encoding="utf-8")
    target = tmp_path / "repowiki" / ".qmind-state.json"
    monkeypatch.setattr(wiki_qmind, "STATE", target)
    monkeypatch.setattr(wiki_qmind, "roster", lambda *a, **k: ros)
    monkeypatch.setattr(wiki_qmind, "load_state",
                        lambda *a, **k: {"sources": {}, "channel": {"status": "unavailable"}})
    assert wiki_qmind.cmd_reconcile(argparse.Namespace(from_file=str(dump), apply=True)) == 0
    raw = target.read_bytes()
    assert b"\r" not in raw, raw[:80]
    assert raw.endswith(b"\n"), raw[-40:]
    assert json.loads(raw)["sources"][ros[0]["path"]]["sourceId"] == "src-0"


def test_the_tracked_state_file_carries_no_crlf_bytes():
    """The shipped artifact, not just the producer: with `sources: {}` this file is
    hand-authored once, so nothing re-runs the writer to notice a CRLF creep."""
    raw = (REAL_REPO / "repowiki" / ".qmind-state.json").read_bytes()
    assert b"\r" not in raw, raw[:80]
    assert json.loads(raw)["channel"]["status"] == "unavailable"


def test_the_fork_workflow_collects_the_qmind_suite():
    """A suite no CI ever ran is the bug this repo already had (`test.yml`'s
    testpaths is upstream's), and the fork workflow lists its test files explicitly —
    so adding this module without adding it there stays invisible until someone
    assumes green means covered. Scoped to the step block, because the workflow's
    Chinese comments name the very paths these needles look for."""
    text = (REAL_REPO / ".github" / "workflows" / "repowiki-freshness.yml").read_text(
        encoding="utf-8")
    step = re.search(r"- name: Wiki guard suite.*?(?=\n {6}- |\Z)", text, re.S)
    assert step, "no step block matched — the workflow renamed its own step"
    body = step.group(0)
    assert "tools/test_wiki_qmind.py" in body, body
    assert "tools/test_wiki_drift.py" in body and "tools/test_upstream_sync.py" in body


def test_the_state_file_is_tracked_and_holds_no_invented_source_ids():
    """M4's deliverable is tool + state file. With the channel closed the file must
    carry `sources: {}` plus the verbatim probe error — any sourceId in here today
    would be fabricated, since nothing has ever been uploaded."""
    names = subprocess.run(
        ["git", "-C", str(REAL_REPO), "-c", "core.quotepath=off", "ls-files",
         "repowiki/.qmind-state.json"],
        capture_output=True, text=True, encoding="utf-8", errors="replace").stdout.split()
    assert names == ["repowiki/.qmind-state.json"], names
    state = json.loads((REAL_REPO / "repowiki" / ".qmind-state.json").read_text(
        encoding="utf-8"))
    assert state["sources"] == {}, state["sources"]
    assert state["channel"]["status"] == "unavailable", state["channel"]
