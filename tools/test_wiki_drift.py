"""Tests for tools/wiki_drift.py.

Each test builds a throwaway git repo under tmp_path with a fake
`.qoder/repowiki` tree, points the module globals at it, and asserts the drift
verdict. The suite deliberately covers the ways this tool can lie: an
over-normalised cite path (`.github` losing its dot), a stale ledger entry that
would mark a rewritten page current without re-reading it, a links-only stamp
that would read as a finished page, a moved link whose printed range still names
the lines it left, and an anchor guess that would invent a target the source
never had.

Run with::

    pytest tools/test_wiki_drift.py -v
"""

from __future__ import annotations

import ast
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

from wiki_drift import (  # type: ignore[import-untyped]
    AmbiguousPage,
    PageNotFound,
    PageOutsideRoot,
    PageReport,
    audit_page,
    cmd_mark,
    cmd_report,
    collect_pages,
    diff_since,
    effective_base,
    load_ledger,
    main,
    make_changes_for,
    metadata_baseline,
    parse_ref,
    parse_refs,
    reanchor_ref,
    render_markdown,
    sha256,
    shift_ref,
    strip_dotslash,
    uncovered_sources,
    worktree_delta,
)
import wiki_drift


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _git(cwd: Path, *args: str) -> str:
    proc = subprocess.run(
        ["git", *args], cwd=str(cwd), capture_output=True, text=True, encoding="utf-8"
    )
    assert proc.returncode == 0, proc.stderr
    return proc.stdout


@pytest.fixture(autouse=True)
def _no_cache_between_cases():
    """Three module caches key on content, not on repo — never leak them."""
    for cache in (wiki_drift._line_cache, wiki_drift._final_text_cache, wiki_drift._historical_cache):
        cache.clear()
    yield


@pytest.fixture
def body():
    return lambda text: (text + "\n") * 70


@pytest.fixture
def repo(tmp_path, body):
    """A git repo with a wiki snapshot one commit behind HEAD."""
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init", "-b", "main")
    _git(root, "config", "user.email", "test@example.com")
    _git(root, "config", "user.name", "Test")
    # Mirror the real fork: the wiki tree is excluded from git entirely.
    info = root / ".git" / "info"
    info.mkdir(parents=True, exist_ok=True)
    (info / "exclude").write_text(".qoder/\n", encoding="utf-8")

    (root / "src").mkdir()
    (root / "src" / "mod.py").write_text(body("print(1)"), encoding="utf-8")
    (root / "src" / "gone.py").write_text(body("print(2)"), encoding="utf-8")
    (root / ".github").mkdir()
    (root / ".github" / "workflows").mkdir()
    (root / ".github" / "workflows" / "ci.yml").write_text(body("name: ci"), encoding="utf-8")
    _git(root, "add", "-A")
    _git(root, "commit", "-m", "snapshot baseline")
    base = _git(root, "rev-parse", "HEAD").strip()

    wiki = root / ".qoder" / "repowiki"
    content = wiki / "zh" / "content"
    page_dir = content / "前端应用"
    page_dir.mkdir(parents=True)
    (page_dir / "模块说明.md").write_text(
        "# 模块说明\n\n<cite>\n**本文引用的文件**\n"
        "- [mod.py](file://src/mod.py#L1-L40)\n"
        "- [ci.yml](file://.github/workflows/ci.yml#L1-L40)\n"
        "</cite>\n\n## 简介\n",
        encoding="utf-8",
    )
    (content / "总览.md").write_text(
        "# 总览\n\n<cite>\n**本文引用的文件**\n"
        "- [gone.py](file://src/gone.py:1-40)\n"
        "</cite>\n",
        encoding="utf-8",
    )
    meta = wiki / "zh" / "meta"
    meta.mkdir(parents=True)
    (meta / "repowiki-metadata.json").write_text(
        json.dumps({"wiki_repo": {"last_commit_id": base}}), encoding="utf-8"
    )

    # Second commit: mod.py changes, gone.py is deleted, a new uncited file lands.
    (root / "src" / "mod.py").write_text(body("print('changed')"), encoding="utf-8")
    (root / "src" / "gone.py").unlink()
    (root / "src" / "brand_new.py").write_text(body("print(3)"), encoding="utf-8")
    _git(root, "add", "-A")
    _git(root, "commit", "-m", "move code past the snapshot")
    head = _git(root, "rev-parse", "HEAD").strip()

    return {"root": root, "wiki": wiki, "content": content, "base": base, "head": head}


@pytest.fixture
def wired(repo, monkeypatch):
    """Module globals pointed at the fixture repo."""
    root, wiki = repo["root"], repo["wiki"]
    monkeypatch.setattr(wiki_drift, "REPO", root)
    monkeypatch.setattr(wiki_drift, "WIKI", wiki)
    monkeypatch.setattr(wiki_drift, "CONTENT", wiki / "zh" / "content")
    monkeypatch.setattr(wiki_drift, "META", wiki / "zh" / "meta" / "repowiki-metadata.json")
    monkeypatch.setattr(wiki_drift, "UPDATE_DIR", wiki / "update")
    monkeypatch.setattr(wiki_drift, "LEDGER", wiki / "update" / "ledger.jsonl")
    monkeypatch.setattr(wiki_drift, "_line_cache", {})
    return repo


def _ns(**kw):
    return type("NS", (), kw)()


# ---------------------------------------------------------------------------
# cite parsing
# ---------------------------------------------------------------------------


def test_parse_ref_accepts_both_anchor_shapes():
    assert parse_ref("src/mod.py#L12-L34") == wiki_drift.Ref("src/mod.py", 12, 34)
    assert parse_ref("src/mod.py:12-34") == wiki_drift.Ref("src/mod.py", 12, 34)
    assert parse_ref("src/mod.py#L7") == wiki_drift.Ref("src/mod.py", 7, 7)
    assert parse_ref("src/mod.py") == wiki_drift.Ref("src/mod.py", None, None)


def test_parse_ref_keeps_dot_directories_intact():
    """`.github` must not become `github` — that fabricated broken refs."""
    ref = parse_ref(".github/workflows/ci.yml#L1-L9")
    assert ref is not None and ref.path == ".github/workflows/ci.yml"
    assert strip_dotslash("./src/mod.py") == "src/mod.py"
    assert strip_dotslash(".devcontainer/devcontainer.json") == ".devcontainer/devcontainer.json"


def test_parse_ref_rejects_non_repo_targets():
    assert parse_ref("/absolute/path.py") is None
    assert parse_ref("https://example.com/doc") is None
    assert parse_ref("  ") is None


def test_parse_refs_reads_cite_block_from_disk(wired):
    refs = parse_refs(wired["content"] / "前端应用" / "模块说明.md")
    paths = [r.path for r in refs]
    assert paths == ["src/mod.py", ".github/workflows/ci.yml"]
    assert refs[0].end == 40


# ---------------------------------------------------------------------------
# diff plumbing
# ---------------------------------------------------------------------------


def test_diff_since_classifies_added_modified_deleted(wired):
    changes = diff_since(wired["base"])
    assert changes["src/mod.py"].status == "M"
    assert changes["src/gone.py"].status == "D"
    assert changes["src/brand_new.py"].status == "A"
    assert changes["src/mod.py"].adds > 0


def test_worktree_delta_reports_untracked_and_dirty(wired):
    newfile = wired["root"] / "src" / "untracked.py"
    newfile.write_text("x = 1\n", encoding="utf-8")
    (wired["root"] / "src" / "mod.py").write_text("x = 2\n", encoding="utf-8")
    dirty, untracked = worktree_delta()
    assert "src/mod.py" in dirty
    assert "src/untracked.py" in untracked


def test_worktree_delta_ignores_the_wiki_tree_itself(wired):
    """The excluded `.qoder/` tree must never look like new source."""
    _dirty, untracked = worktree_delta()
    assert not [p for p in untracked if p.startswith(".qoder/")]


def test_metadata_baseline_reads_the_snapshot_commit(wired):
    assert metadata_baseline() == wired["base"]


def test_metadata_baseline_rejects_the_non_git_marker(wired, monkeypatch):
    """Generated outside a git root the IDE writes a magic string, not a SHA."""
    (wired["wiki"] / "zh" / "meta" / "repowiki-metadata.json").write_text(
        json.dumps({"wiki_repo": {"last_commit_id": "Q0DeR-MaG1C-BrAnCh-Fo2-NoN-GiT"}}),
        encoding="utf-8",
    )
    assert metadata_baseline() is None


# ---------------------------------------------------------------------------
# per-page verdicts
# ---------------------------------------------------------------------------


def _audit_all(wired):
    base = wired["base"]
    changes = diff_since(base)
    dirty, untracked = worktree_delta()
    reports = []
    for page in sorted(wired["content"].rglob("*.md")):
        rel = str(page.relative_to(wired["content"])).replace("\\", "/")
        reports.append(audit_page(page, rel, "snapshot", base, make_changes_for(), dirty, untracked))
    return {r.page: r for r in reports}


def test_page_is_stale_when_a_cited_file_changed(wired):
    rep = _audit_all(wired)["前端应用/模块说明.md"]
    assert rep.stale == ["src/mod.py"]
    assert rep.broken == []  # ci.yml still there, dot dir survived normalisation
    assert rep.state == "stale"


def test_page_is_broken_when_a_cited_file_disappeared(wired):
    rep = _audit_all(wired)["总览.md"]
    assert rep.broken == ["src/gone.py"]
    assert rep.state == "broken"


def test_a_missing_file_is_listed_once_however_many_cites_name_it(wired):
    """A page cites one file from a dozen sections; twelve identical rows in the
    report would read as twelve problems and bury the ones that differ.
    """
    (wired["content"] / "缺失.md").write_text(
        "# 缺失\n\n<cite>\n"
        "- [a](file://src/gone.py#L1-L9)\n"
        "- [b](file://src/gone.py#L20-L999)\n"
        "</cite>\n",
        encoding="utf-8",
    )
    rep = _audit_all(wired)["缺失.md"]
    assert rep.broken == ["src/gone.py"]
    assert rep.anchors == []  # no range to judge when the file is gone
    assert rep.state == "broken"


def test_anchor_out_of_range_is_its_own_bucket(wired):
    page = wired["content"] / "锚点.md"
    page.write_text(
        "# 锚点\n\n<cite>\n- [x](file://src/brand_new.py#L1-L99999)\n</cite>\n", encoding="utf-8"
    )
    head = wired["head"]
    # Baseline == HEAD: nothing changed, so only the anchor can be wrong.
    rep = audit_page(page, "锚点.md", "snapshot", head, make_changes_for(), set(), set())
    assert rep.state == "stale"
    assert len(rep.anchors) == 1 and "brand_new.py" in rep.anchors[0]
    assert rep.stale == []


def test_page_with_missing_and_changed_refs_is_mixed(wired):
    page = wired["content"] / "混合.md"
    page.write_text(
        "# 混合\n\n<cite>\n- [a](file://src/mod.py#L1-L5)\n- [b](file://src/gone.py)\n</cite>\n",
        encoding="utf-8",
    )
    rep = _audit_all(wired)["混合.md"]
    assert rep.state == "mixed"
    assert rep.broken == ["src/gone.py"] and rep.stale == ["src/mod.py"]


def test_clean_page_when_nothing_it_cites_moved(wired):
    page = wired["content"] / "干净.md"
    page.write_text(
        "# 干净\n\n<cite>\n- [x](file://src/brand_new.py#L1-L2)\n</cite>\n", encoding="utf-8"
    )
    head = wired["head"]
    rep = audit_page(page, "干净.md", "snapshot", head, make_changes_for(), set(), set())
    assert rep.score == 0 and rep.state == "clean"


def test_uncited_changed_files_are_reported_as_coverage_gaps(wired):
    changes = diff_since(wired["base"])
    all_refs = {r.path for p in wired["content"].rglob("*.md") for r in parse_refs(p)}
    gaps = uncovered_sources(changes, set(), all_refs)
    paths = [g.path for g in gaps]
    assert "src/brand_new.py" in paths
    assert "src/mod.py" not in paths  # it is cited, so it is stale not uncovered


# ---------------------------------------------------------------------------
# ledger semantics — the part that makes updates incremental
# ---------------------------------------------------------------------------


def _write_ledger(wired, page, head, sha_after, drivers=(), partial=False):
    wired["wiki"].mkdir(parents=True, exist_ok=True)
    (wired["wiki"] / "update").mkdir(parents=True, exist_ok=True)
    entry = {
        "page": page,
        "head": head,
        "sha_after": sha_after,
        "note": "test",
        "at": "2026-10-01T00:00:00+00:00",
        "drivers": list(drivers),
    }
    if partial:
        entry["partial"] = True
    with wired["wiki"].joinpath("update", "ledger.jsonl").open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")


def test_ledger_moves_a_pages_baseline_forward(wired):
    page = wired["content"] / "前端应用" / "模块说明.md"
    _write_ledger(wired, "前端应用/模块说明.md", wired["head"], sha256(page))
    ledger = load_ledger()
    base, tag = effective_base(page, "前端应用/模块说明.md", ledger, wired["base"])
    assert (base, tag) == (wired["head"], "reconciled")
    # Nothing changed between HEAD and itself, so the page is now current.
    rep = audit_page(page, "前端应用/模块说明.md", tag, base, make_changes_for(), *worktree_delta())
    assert rep.score == 0 and rep.state == "reconciled"


def test_ledger_entry_is_voided_when_the_page_is_rewritten(wired):
    page = wired["content"] / "前端应用" / "模块说明.md"
    _write_ledger(wired, "前端应用/模块说明.md", wired["head"], "0" * 64)
    ledger = load_ledger()
    base, tag = effective_base(page, "前端应用/模块说明.md", ledger, wired["base"])
    assert tag == "ledger-void" and base == wired["base"]
    rep = audit_page(page, "前端应用/模块说明.md", tag, base, make_changes_for(), *worktree_delta())
    assert rep.stale == ["src/mod.py"]
    assert rep.state == "ledger-void"


def test_ledger_entry_ignored_when_its_commit_is_unreachable(wired, capsys):
    """A mark naming a GC'd commit must degrade, not abort the whole report."""
    page = wired["content"] / "前端应用" / "模块说明.md"
    _write_ledger(wired, "前端应用/模块说明.md", "0" * 40, sha256(page))
    ledger = load_ledger()
    base, tag = effective_base(page, "前端应用/模块说明.md", ledger, wired["base"])
    assert tag == "snapshot" and base == wired["base"]
    assert "Not a valid commit name" in capsys.readouterr().err


def test_unreachable_metadata_baseline_asks_for_an_override(wired, capsys):
    """Force-pushed upstream syncs can orphan the snapshot commit."""
    (wired["wiki"] / "zh" / "meta" / "repowiki-metadata.json").write_text(
        json.dumps({"wiki_repo": {"last_commit_id": "f" * 40}}), encoding="utf-8"
    )
    assert main(["report"]) == 2
    assert "not reachable from HEAD" in capsys.readouterr().err


def test_load_ledger_last_entry_wins(wired):
    page = wired["content"] / "前端应用" / "模块说明.md"
    _write_ledger(wired, "前端应用/模块说明.md", wired["base"], sha256(page))
    _write_ledger(wired, "前端应用/模块说明.md", wired["head"], sha256(page))
    ledger = load_ledger()
    assert ledger["前端应用/模块说明.md"].head == wired["head"]


def test_load_ledger_skips_a_corrupt_line(wired, capsys):
    _write_ledger(wired, "a.md", wired["head"], "x")
    with (wired["wiki"] / "update" / "ledger.jsonl").open("a", encoding="utf-8") as fh:
        fh.write("{not json}\n")
    assert len(load_ledger()) == 1
    assert "unparseable" in capsys.readouterr().err


# ---------------------------------------------------------------------------
# commands end to end
# ---------------------------------------------------------------------------


def test_report_writes_json_and_markdown(wired, capsys):
    code = main(["report", "--top", "5"])
    assert code == 0
    payload = json.loads((wired["wiki"] / "update" / "drift.json").read_text(encoding="utf-8"))
    assert payload["summary"]["pages"] == 2
    assert payload["summary"]["needs_update"] == 2
    assert payload["metadata_baseline"] == wired["base"]
    md = (wired["wiki"] / "update" / "DRIFT.md").read_text(encoding="utf-8")
    assert "待更新页面" in md and "src/gone.py" in md
    # Non-vacuity: the report must name the real gaps, not print an empty table.
    assert "src/brand_new.py" in md
    assert "HEAD" in capsys.readouterr().out


def test_report_never_touches_the_ides_metadata(wired):
    meta = wired["wiki"] / "zh" / "meta" / "repowiki-metadata.json"
    before = sha256(meta)
    assert main(["report"]) == 0
    assert main(["mark", "--page", "总览.md", "-m", "test"]) == 0
    assert sha256(meta) == before


def test_mark_then_report_closes_the_loop(wired):
    page_rel = "前端应用/模块说明.md"
    page = wired["content"] / "前端应用" / "模块说明.md"
    assert main(["report", "--page", page_rel]) == 0
    payload = json.loads((wired["wiki"] / "update" / "drift.json").read_text(encoding="utf-8"))
    assert payload["summary"]["needs_update"] == 1

    # Bring the page current: drop the changed-file citation.
    page.write_text(
        "# 模块说明\n\n<cite>\n**本文引用的文件**\n"
        "- [ci.yml](file://.github/workflows/ci.yml#L1-L40)\n"
        "</cite>\n",
        encoding="utf-8",
    )
    assert main(["mark", "--page", page_rel, "-m", "repointed cites"]) == 0

    assert main(["report", "--page", page_rel]) == 0
    payload = json.loads((wired["wiki"] / "update" / "drift.json").read_text(encoding="utf-8"))
    assert payload["summary"]["needs_update"] == 0
    assert payload["pages"][0]["state"] == "reconciled"
    entry = load_ledger()[page_rel]
    assert entry.head == wired["head"] and entry.sha_after == sha256(page)


def test_mark_records_snapshot_era_drivers(wired):
    page = wired["content"] / "前端应用" / "模块说明.md"
    assert main(["mark", "--page", "前端应用/模块说明.md", "-m", "absorbed mod.py"]) == 0
    entry = load_ledger()["前端应用/模块说明.md"]
    assert entry.drivers == ["src/mod.py"]


def test_partial_mark_keeps_the_pages_drivers_visible(wired):
    """A links-only fix must not read as a finished page."""
    page_rel = "前端应用/模块说明.md"
    assert main(["mark", "--page", page_rel, "--partial", "-m", "fixed cites"]) == 0
    entry = load_ledger()[page_rel]
    assert entry.partial and entry.drivers == ["src/mod.py"]

    assert main(["report"]) == 0
    payload = json.loads((wired["wiki"] / "update" / "drift.json").read_text(encoding="utf-8"))
    row = next(p for p in payload["pages"] if p["page"] == page_rel)
    assert row["state"] == "partial"
    assert row["stale"] == ["src/mod.py"]
    assert payload["summary"]["partial"] == 1
    assert payload["summary"]["reconciled"] == 0
    # both fixture pages still carry a problem: nothing was hidden by the stamp
    assert payload["summary"]["needs_update"] == 2


def test_partial_entry_is_stamped_with_the_head_it_was_done_at(wired):
    page_rel = "前端应用/模块说明.md"
    page = wired["content"] / "前端应用" / "模块说明.md"
    assert main(["mark", "--page", page_rel, "--partial", "-m", "cites only"]) == 0
    entry = load_ledger()[page_rel]
    # The stamp records *when* the links were fixed ...
    assert entry.head == wired["head"]
    # ... but must not become the page's baseline while the prose lags behind.
    base, tag = effective_base(page, page_rel, load_ledger(), wired["base"])
    assert (base, tag) == (wired["base"], "partial")

    # Finishing the page for real supersedes the partial entry.
    page.write_text(
        "# 模块说明\n\n<cite>\n**本文引用的文件**\n"
        "- [ci.yml](file://.github/workflows/ci.yml#L1-L40)\n</cite>\n",
        encoding="utf-8",
    )
    assert main(["mark", "--page", page_rel, "-m", "prose re-derived"]) == 0
    assert main(["report", "--page", page_rel]) == 0
    payload = json.loads((wired["wiki"] / "update" / "drift.json").read_text(encoding="utf-8"))
    assert payload["pages"][0]["state"] == "reconciled"
    assert payload["summary"]["needs_update"] == 0
    assert load_ledger()[page_rel].partial is False


def test_partial_stamp_survives_a_page_that_drifted_no_further(wired):
    """Zero open drivers is not the same as a re-derived page.

    The stamp records that the prose was never checked, so the state must stay
    `partial` rather than reading as `clean` — otherwise a source change that
    later gets reverted makes an unfinished page look finished.
    """
    page_rel = "仅链接.md"
    (wired["content"] / page_rel).write_text(
        "# 仅链接\n\n<cite>\n**本文引用的文件**\n"
        "- [ci.yml](file://.github/workflows/ci.yml#L1-L40)\n</cite>\n",
        encoding="utf-8",
    )
    assert main(["mark", "--page", page_rel, "--partial", "-m", "cites only"]) == 0
    assert main(["report", "--page", page_rel]) == 0
    payload = json.loads((wired["wiki"] / "update" / "drift.json").read_text(encoding="utf-8"))
    row = payload["pages"][0]
    assert row["state"] == "partial"
    assert not row["stale"] and not row["broken"] and not row["anchors"]
    assert payload["summary"]["partial"] == 1
    assert payload["summary"]["needs_update"] == 0


def test_mark_rejects_an_ambiguous_page(wired):
    for name in ("重名.md", "重名2.md"):
        (wired["content"] / name).write_text("# x\n", encoding="utf-8")
    with pytest.raises(AmbiguousPage):
        cmd_mark(_ns(page="重名", message="", baseline=None, partial=False))


def test_mark_rejects_a_non_markdown_target(wired):
    with pytest.raises(SystemExit):
        main(["mark", "--page", "src/mod.py"])


def test_report_page_filter_that_matches_nothing_fails_cleanly(wired):
    assert main(["report", "--page", "不存在的页面"]) == 2


def test_collect_pages_substring_match(wired):
    assert len(collect_pages("前端应用")) == 1
    assert len(collect_pages(None)) == 2
    with pytest.raises(PageNotFound):
        collect_pages("nope")


def test_missing_content_tree_is_an_error(wired, monkeypatch, capsys):
    """Was `..._is_a_no_op` asserting exit 0. A wiki root with zero pages cannot be
    reported as clean — that is how a half-seeded tree would lie."""
    monkeypatch.setattr(wiki_drift, "CONTENT", wired["root"] / ".qoder" / "absent")
    monkeypatch.setattr(
        wiki_drift,
        "wiki_root",
        wiki_drift.WikiRoot.resolve(wired["wiki"], base=wired["root"]),
    )
    assert cmd_report(_ns(baseline=None, page=None, top=5, json=False)) == 2
    assert "no wiki pages" in capsys.readouterr().err


def test_unusable_baseline_requires_an_override(wired, monkeypatch, capsys):
    monkeypatch.setattr(wiki_drift, "META", wired["root"] / "nothing.json")
    assert cmd_report(_ns(baseline=None, page=None, top=5, json=False)) == 2
    assert "--baseline" in capsys.readouterr().err


def test_json_mode_prints_and_writes_nothing(wired, capsys):
    assert main(["report", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["summary"]["refs_broken"] == 1
    assert not (wired["wiki"] / "update" / "DRIFT.md").exists()


def test_report_surfaces_ledger_void_state(wired, capsys):
    page = wired["content"] / "前端应用" / "模块说明.md"
    _write_ledger(wired, "前端应用/模块说明.md", wired["head"], "1" * 64)
    assert main(["report", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["summary"]["ledger_void"] == 1


# ---------------------------------------------------------------------------
# rendering
# ---------------------------------------------------------------------------


def test_render_markdown_lists_every_bucket(wired):
    reports = [
        PageReport("a.md", "stale", "deadbeef" * 5, 3, stale=["src/mod.py"], broken=["src/gone.py"]),
        PageReport("b.md", "clean", "deadbeef" * 5, 1),
    ]
    payload = {
        "generated_at": "2026-10-01T00:00:00+00:00",
        "head": "h",
        "metadata_baseline": "b",
        "summary": {
            "pages": 2, "needs_update": 1, "clean": 1, "reconciled": 0, "ledger_void": 0,
            "partial": 0, "no_frontmatter": 0, "frontmatter": 0,
            "distinct_refs": 4, "refs_changed": 1, "refs_broken": 1, "uncovered": 1,
        },
    }
    gaps = [wiki_drift.Change("src/brand_new.py", "A", 10, 2)]
    md = render_markdown(payload, reports, gaps, top=10)
    assert "a.md" in md and "src/gone.py" in md and "src/brand_new.py" in md
    assert "缺失 1" in md and "变更 1" in md
    assert "缺 frontmatter 的页面：0" in md


def test_render_markdown_says_all_clear_instead_of_hiding_the_table(wired):
    payload = {
        "generated_at": "x", "head": "h", "metadata_baseline": "b",
        "summary": {
            "pages": 1, "needs_update": 0, "clean": 1, "reconciled": 0, "ledger_void": 0,
            "partial": 0, "no_frontmatter": 1, "frontmatter": 0,
            "distinct_refs": 1, "refs_changed": 0, "refs_broken": 0, "uncovered": 0,
        },
    }
    md = render_markdown(payload, [PageReport("a.md", "clean", "b", 1, fm="missing")], [], top=10)
    assert "全部页面与当前代码一致" in md
    assert "无" in md
    # A clean-looking tree where nobody seeded the pages must say so out loud.
    assert "缺 frontmatter 的页面：1" in md


# ---------------------------------------------------------------------------
# re-anchoring cites onto the files that inherited their text
# ---------------------------------------------------------------------------

GATE_AT_SNAPSHOT = [
    "# header",              # L1
    "",                      # L2
    "def alpha():",          # L3
    "    return 1",          # L4
    "",                      # L5
    "def beta():",           # L6
    "    return 2",          # L7
]


def _build_split_repo(tmp_path, monkeypatch, edit_before_split=False):
    root = tmp_path
    root.mkdir(exist_ok=True)
    _git(root, "init", "-b", "main")
    _git(root, "config", "user.email", "test@example.com")
    _git(root, "config", "user.name", "Test")
    info = root / ".git" / "info"
    info.mkdir(parents=True, exist_ok=True)
    (info / "exclude").write_text(".qoder/\n", encoding="utf-8")

    (root / "src").mkdir()
    (root / "src" / "gate.py").write_text("\n".join(GATE_AT_SNAPSHOT) + "\n", encoding="utf-8")
    wiki = root / ".qoder" / "repowiki"
    content = wiki / "zh" / "content"
    content.mkdir(parents=True)
    (content / "锚定测试.md").write_text(
        "# 锚定测试\n\n<cite>\n"
        "- [alpha](file://src/gate.py#L3-L4)\n"
        "- [beta](file://src/gate.py#L6-L7)\n"
        "- [bare](file://src/gate.py)\n"
        "- [ghost](file://src/ghost.py#L1-L2)\n"
        "</cite>\n",
        encoding="utf-8",
    )
    _git(root, "add", "-A")
    _git(root, "commit", "-m", "snapshot")
    base = _git(root, "rev-parse", "HEAD").strip()

    lines = list(GATE_AT_SNAPSHOT)
    if edit_before_split:
        lines.insert(0, "# touched after the snapshot")
    (root / "src" / "gate").mkdir()
    # alpha lands in policies.py, beta in figures.py, at fresh line numbers.
    head_pad = ["'''policies'''", ""] if not edit_before_split else ["'''policies'''", "", ""]
    (root / "src" / "gate" / "policies.py").write_text(
        "\n".join(head_pad + lines[lines.index("def alpha():") : lines.index("def alpha():") + 2]) + "\n",
        encoding="utf-8",
    )
    (root / "src" / "gate" / "figures.py").write_text(
        "\n".join(["'''figures'''", ""] + lines[lines.index("def beta():") :]) + "\n", encoding="utf-8"
    )
    (root / "src" / "gate" / "__init__.py").write_text("'''facade'''\n", encoding="utf-8")
    (root / "src" / "gate.py").unlink()
    _git(root, "add", "-A")
    _git(root, "commit", "-m", "split the gate into a package")

    wiki_meta = wiki / "zh" / "meta"
    wiki_meta.mkdir(parents=True, exist_ok=True)
    (wiki_meta / "repowiki-metadata.json").write_text(
        json.dumps({"wiki_repo": {"last_commit_id": base}}), encoding="utf-8"
    )
    for name, value in (
        ("REPO", root),
        ("WIKI", wiki),
        ("CONTENT", content),
        ("META", wiki_meta / "repowiki-metadata.json"),
        ("UPDATE_DIR", wiki / "update"),
        ("LEDGER", wiki / "update" / "ledger.jsonl"),
        ("_final_text_cache", {}),
        ("_line_cache", {}),
    ):
        monkeypatch.setattr(wiki_drift, name, value)
    return {"root": root, "content": content, "base": base}


def _proposals(ctx):
    page = ctx["content"] / "锚定测试.md"
    refs = [r for r in parse_refs(page) if not (ctx["root"] / r.path).exists()]
    return {r: reanchor_ref(r, ctx["base"]) for r in refs}


def test_reanchor_routes_each_range_to_the_module_that_kept_it(tmp_path, monkeypatch):
    ctx = _build_split_repo(tmp_path / "a", monkeypatch)
    by_ref = _proposals(ctx)
    alpha = next(p for r, p in by_ref.items() if r.start == 3)
    beta = next(p for r, p in by_ref.items() if r.start == 6)
    assert alpha["outcome"] == "matched" and alpha["file"] == "src/gate/policies.py"
    assert beta["outcome"] == "matched" and beta["file"] == "src/gate/figures.py"
    # The new anchor must be the position the block actually occupies now.
    assert alpha["anchor"][0] <= len((ctx["root"] / alpha["file"]).read_text(encoding="utf-8").splitlines())
    assert beta["anchor"] == (3, 4)


def test_reanchor_uses_snapshot_text_when_the_file_shifted_before_split(tmp_path, monkeypatch):
    ctx = _build_split_repo(tmp_path / "b", monkeypatch, edit_before_split=True)
    alpha = next(p for r, p in _proposals(ctx).items() if r.start == 3)
    assert alpha["outcome"] == "matched"
    assert alpha["evidence"] == "snapshot"
    assert alpha["file"] == "src/gate/policies.py"


def test_reanchor_never_invents_a_target_for_a_bare_cite(tmp_path, monkeypatch):
    ctx = _build_split_repo(tmp_path / "c", monkeypatch)
    bare = next(p for r, p in _proposals(ctx).items() if r.start is None)
    assert bare["outcome"] == "unanchored" and bare["file"] is None


def test_reanchor_calls_out_a_path_that_never_existed(tmp_path, monkeypatch):
    """Generated wikis do invent paths; those need an agent, not a rewrite."""
    ctx = _build_split_repo(tmp_path / "d", monkeypatch)
    ghost = next(p for r, p in _proposals(ctx).items() if r.path == "src/ghost.py")
    assert ghost["outcome"] == "no-candidate"


def test_dry_run_writes_nothing_and_apply_rewrites_only_matched_links(tmp_path, monkeypatch):
    ctx = _build_split_repo(tmp_path / "e", monkeypatch)
    page = ctx["content"] / "锚定测试.md"
    before = page.read_text(encoding="utf-8")
    assert main(["reanchor", "--page", "锚定测试"]) == 0
    assert page.read_text(encoding="utf-8") == before

    assert main(["reanchor", "--page", "锚定测试", "--apply"]) == 0
    after = page.read_text(encoding="utf-8")
    assert "src/gate/policies.py#L" in after and "src/gate/figures.py#L" in after
    assert "[bare](file://src/gate.py)" in after  # unprovable links are left alone
    assert "[ghost](file://src/ghost.py#L1-L2)" in after
    assert after.count("file://src/gate.py#") == 0


def test_reanchor_survives_a_missing_baseline(tmp_path, monkeypatch):
    ctx = _build_split_repo(tmp_path / "f", monkeypatch)
    (ctx["root"] / ".qoder" / "repowiki" / "zh" / "meta" / "repowiki-metadata.json").unlink()
    assert main(["reanchor", "--page", "锚定测试"]) == 0


# ---------------------------------------------------------------------------
# cites on files that still exist but slid down under an insertion
# ---------------------------------------------------------------------------

SNAPSHOT_GATE = [
    "# header",      # L1
    "",              # L2
    "def alpha():",  # L3
    "    return 1",  # L4
    "",              # L5
    "def beta():",   # L6
    "    return 2",  # L7
]


def _build_shift_repo(tmp_path, monkeypatch, variant="header"):
    """A repo where every cited file survives and every range stays in bounds.

    This is the drift the report cannot see: an insertion above a block pushes it
    down, so no anchor goes out of range even though none of them point at the
    right lines any more. `variant="tail"` instead grows a block in place, which
    is the shape that must *not* be reported as a move.
    """
    root = tmp_path
    root.mkdir(exist_ok=True)
    _git(root, "init", "-b", "main")
    _git(root, "config", "user.email", "test@example.com")
    _git(root, "config", "user.name", "Test")
    info = root / ".git" / "info"
    info.mkdir(parents=True, exist_ok=True)
    (info / "exclude").write_text(".qoder/\n", encoding="utf-8")
    (root / "src").mkdir()
    (root / "src" / "gate.py").write_text("\n".join(SNAPSHOT_GATE) + "\n", encoding="utf-8")
    content = root / ".qoder" / "repowiki" / "zh" / "content"
    content.mkdir(parents=True)
    (content / "平移测试.md").write_text(
        "# 平移测试\n\n<cite>\n"
        "- [alpha](file://src/gate.py#L3-L4)\n"
        "- [beta](file://src/gate.py#L5-L7)\n"
        "- [tiny](file://src/gate.py#L4-L5)\n"
        "- [bare](file://src/gate.py)\n"
        "</cite>\n",
        encoding="utf-8",
    )
    _git(root, "add", "-A")
    _git(root, "commit", "-m", "snapshot")
    base = _git(root, "rev-parse", "HEAD").strip()

    # Three header lines land on top and beta's body is edited: alpha only
    # slides, beta's text genuinely changes.
    if variant == "tail":
        # A line is added inside alpha's body: no block moves, the file grows.
        after = (
            SNAPSHOT_GATE[:4] + ["    return 11"] + SNAPSHOT_GATE[4:]
        )
    else:
        after = ["# a", "# b", "# c"] + SNAPSHOT_GATE[:6] + ["    return 20"]
    (root / "src" / "gate.py").write_text("\n".join(after) + "\n", encoding="utf-8")
    _git(root, "add", "-A")
    _git(root, "commit", "-m", "insert a header and edit beta")

    meta = root / ".qoder" / "repowiki" / "zh" / "meta"
    meta.mkdir(parents=True)
    (meta / "repowiki-metadata.json").write_text(
        json.dumps({"wiki_repo": {"last_commit_id": base}}), encoding="utf-8"
    )
    for name, value in (
        ("REPO", root),
        ("WIKI", root / ".qoder" / "repowiki"),
        ("CONTENT", content),
        ("META", meta / "repowiki-metadata.json"),
        ("UPDATE_DIR", root / ".qoder" / "repowiki" / "update"),
        ("LEDGER", root / ".qoder" / "repowiki" / "update" / "ledger.jsonl"),
        ("_final_text_cache", {}),
        ("_line_cache", {}),
        ("_historical_cache", {}),
    ):
        monkeypatch.setattr(wiki_drift, name, value)
    return {"root": root, "content": content, "base": base}


def _shifts(ctx):
    page = ctx["content"] / "平移测试.md"
    return {r: shift_ref(r, ctx["base"]) for r in parse_refs(page)}


def test_shift_ref_proposes_the_range_a_block_slid_to(tmp_path, monkeypatch):
    ctx = _build_shift_repo(tmp_path / "s1", monkeypatch)
    alpha = next(p for r, p in _shifts(ctx).items() if r.start == 3)
    assert alpha["outcome"] == "matched" and alpha["file"] == "src/gate.py"
    assert alpha["anchor"] == (6, 7)
    assert alpha["evidence"] == "moved"


def test_shift_ref_leaves_an_edited_block_for_an_agent(tmp_path, monkeypatch):
    ctx = _build_shift_repo(tmp_path / "s2", monkeypatch)
    beta = next(p for r, p in _shifts(ctx).items() if r.start == 5)
    assert beta["outcome"] == "block-changed" and beta["file"] is None


def test_shift_ref_declares_a_low_signal_block_unprovable(tmp_path, monkeypatch):
    """A one-word block would "match" the first similar line in the file."""
    ctx = _build_shift_repo(tmp_path / "s6", monkeypatch)
    tiny = next(p for r, p in _shifts(ctx).items() if r.start == 4)
    assert tiny["outcome"] == "uninformative" and tiny["file"] is None


def test_shift_mode_moves_only_provable_anchors(tmp_path, monkeypatch, capsys):
    ctx = _build_shift_repo(tmp_path / "s3", monkeypatch)
    page = ctx["content"] / "平移测试.md"
    # The default mode is about vanished targets; nothing vanished here.
    assert main(["reanchor", "--page", "平移测试"]) == 0
    assert "0 provable" in capsys.readouterr().out
    before = page.read_text(encoding="utf-8")

    assert main(["reanchor", "--page", "平移测试", "--shifts"]) == 0
    assert page.read_text(encoding="utf-8") == before  # dry run writes nothing

    assert main(["reanchor", "--page", "平移测试", "--shifts", "--apply"]) == 0
    after = page.read_text(encoding="utf-8")
    assert "[alpha](file://src/gate.py#L6-L7)" in after
    assert "[beta](file://src/gate.py#L5-L7)" in after  # edited block stays as written
    assert "[tiny](file://src/gate.py#L4-L5)" in after  # nothing to prove
    assert "[bare](file://src/gate.py)" in after


def test_shift_mode_leaves_bare_cites_out_of_the_queue(tmp_path, monkeypatch, capsys):
    """A cite with no anchor cannot have drifted, so it is not open work."""
    _build_shift_repo(tmp_path / "s7", monkeypatch)
    assert main(["reanchor", "--page", "平移测试", "--shifts"]) == 0
    out = capsys.readouterr().out
    assert "unanchored" not in out
    assert "1 provable proposal(s), 2 open" in out


def test_shift_mode_names_a_vanished_cite_instead_of_ignoring_it(tmp_path, monkeypatch, capsys):
    """A pass that finds nothing to move must not read as an all-clear."""
    _build_split_repo(tmp_path / "s9", monkeypatch)
    assert main(["reanchor", "--page", "锚定测试", "--shifts"]) == 0
    out = capsys.readouterr().out
    assert "gone" in out and "3 open" in out and "PROPOSE" not in out


def test_shift_ref_uses_any_informative_line_of_the_block(tmp_path, monkeypatch):
    """A block may open on a blank or a one-word line and still be provable.

    Judging only the first line would throw away re-anchors that are completely
    determined by the rest of the window.
    """
    ctx = _build_shift_repo(tmp_path / "s10", monkeypatch)
    prop = shift_ref(wiki_drift.Ref("src/gate.py", 4, 6), ctx["base"])
    assert prop["outcome"] == "matched" and prop["anchor"] == (7, 9)


def test_growth_inside_a_block_is_not_reported_as_a_move(tmp_path, monkeypatch, capsys):
    """A line added inside the cited range leaves the block on its own line.

    The range is no longer identical to the block it was trimmed from, so only
    the block's position proves the cite never moved — without that check a
    whole-file growth would shift every anchor on the page.
    """
    ctx = _build_shift_repo(tmp_path / "s8", monkeypatch, variant="tail")
    page = ctx["content"] / "平移测试.md"
    page.write_text(
        "# 平移测试\n\n<cite>\n- [alpha](file://src/gate.py#L3-L5)\n</cite>\n",
        encoding="utf-8",
    )
    assert main(["reanchor", "--page", "平移测试", "--shifts"]) == 0
    out = capsys.readouterr().out
    assert "1 already on their line" in out and "PROPOSE" not in out


def test_a_second_shift_run_finds_nothing_to_move(tmp_path, monkeypatch, capsys):
    """Once stamped current, a page must not be re-anchored onto itself.

    Without the self-match guard every cite of a marked page matches its own
    current text, so a duplicate line elsewhere in the file would look like a
    provable move and rewrite a healthy anchor.
    """
    ctx = _build_shift_repo(tmp_path / "s4", monkeypatch)
    assert main(["reanchor", "--page", "平移测试", "--shifts", "--apply"]) == 0
    assert main(["mark", "--page", "平移测试.md", "-m", "anchors re-derived"]) == 0
    capsys.readouterr()

    assert main(["reanchor", "--page", "平移测试", "--shifts"]) == 0
    out = capsys.readouterr().out
    assert "0 provable" in out and "2 already on their line" in out
    assert " -> " not in out


def _ledger_rows(ctx):
    path = ctx["root"] / ".qoder" / "repowiki" / "update" / "ledger.jsonl"
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def test_an_anchor_the_tool_moved_is_not_walked_by_the_next_run(tmp_path, monkeypatch, capsys):
    """Without a `mark`, a second pass would read the new HEAD coordinates as
    baseline coordinates and diff the wrong slice of history — each run pushing
    the same link further down the file.
    """
    ctx = _build_shift_repo(tmp_path / "s11", monkeypatch)
    page = ctx["content"] / "平移测试.md"
    assert main(["reanchor", "--page", "平移测试", "--shifts", "--apply"]) == 0
    written = page.read_text(encoding="utf-8")
    capsys.readouterr()

    assert main(["reanchor", "--page", "平移测试", "--shifts"]) == 0
    out = capsys.readouterr().out
    assert "PROPOSE" not in out and " -> " not in out
    # Only the anchor this tool moved is vouched as current; the two it gave up on
    # stay in the queue, so a second pass counts one, not three, as settled.
    assert "1 already on their line" in out
    assert "src/gate.py#6-7" not in out
    assert page.read_text(encoding="utf-8") == written


def test_apply_signs_the_anchors_it_moved_as_partial_work(tmp_path, monkeypatch, capsys):
    """The stamp is what makes the next run idle, so it has to say links-only."""
    ctx = _build_shift_repo(tmp_path / "s12", monkeypatch)
    page = ctx["content"] / "平移测试.md"
    assert main(["reanchor", "--page", "平移测试", "--shifts", "--apply"]) == 0
    assert "1 page(s) re-stamped as links-only" in capsys.readouterr().out
    row = _ledger_rows(ctx)[-1]
    assert row["partial"] is True
    assert row["cites"] == "applied-only"
    assert row["applied"] == ["src/gate.py#L6-L7"]
    assert row["sha_after"] == wiki_drift.sha256(page)
    assert row["drivers"] == ["src/gate.py"]
    assert row["head"] == _git(ctx["root"], "rev-parse", "HEAD").strip()


def test_a_stamp_does_not_blind_the_tool_to_the_cites_it_left_open(tmp_path, monkeypatch, capsys):
    """An unresolved cite has to outlive the sweep that rewrote its neighbours.

    A links-only stamp vouches for the anchors this tool moved. The ones it gave
    up on are still written against the snapshot, and re-deriving those against
    the stamp head makes each one match itself: the judgement queue would empty
    without anybody having judged it.
    """
    ctx = _build_shift_repo(tmp_path / "s26", monkeypatch)
    assert main(["reanchor", "--page", "平移测试", "--shifts", "--apply"]) == 0
    first = capsys.readouterr().out
    assert "block-changed" in first

    assert main(["reanchor", "--page", "平移测试", "--shifts"]) == 0
    out = capsys.readouterr().out
    assert "block-changed" in out and "src/gate.py#5-7" in out


def test_a_ledger_row_from_before_the_vouch_field_vouches_for_nothing(tmp_path, monkeypatch, capsys):
    """Rows written by an earlier build carry no `cites` key at all.

    They must read as links-only: defaulting them to `all` would keep the 40 pages
    the pilot sweep already stamped exactly as blind as the bug being fixed here.
    """
    ctx = _build_shift_repo(tmp_path / "s27", monkeypatch)
    assert main(["reanchor", "--page", "平移测试", "--shifts", "--apply"]) == 0
    row = dict(_ledger_rows(ctx)[-1])
    row.pop("cites")
    ledger = ctx["root"] / ".qoder" / "repowiki" / "update" / "ledger.jsonl"
    ledger.write_text(json.dumps(row, ensure_ascii=False) + "\n", encoding="utf-8")
    capsys.readouterr()

    assert main(["reanchor", "--page", "平移测试", "--shifts"]) == 0
    out = capsys.readouterr().out
    assert "block-changed" in out and "src/gate.py#5-7" in out


def test_an_anchor_the_tool_moved_moves_again_when_the_file_grows(tmp_path, monkeypatch, capsys):
    """Re-deriving from the stamp rather than freezing the coordinate is what
    keeps the loop open: a fresh insertion above the block has to be caught.
    """
    ctx = _build_shift_repo(tmp_path / "s13", monkeypatch)
    assert main(["reanchor", "--page", "平移测试", "--shifts", "--apply"]) == 0
    capsys.readouterr()

    source = ctx["root"] / "src" / "gate.py"
    body = source.read_text(encoding="utf-8").splitlines()
    source.write_text("\n".join(["# new", "# more"] + body) + "\n", encoding="utf-8")
    _git(ctx["root"], "add", "-A")
    _git(ctx["root"], "commit", "-m", "grow the header again")

    assert main(["reanchor", "--page", "平移测试", "--shifts"]) == 0
    out = capsys.readouterr().out
    assert "src/gate.py#6-7 -> src/gate.py#L8-L9" in out


def test_a_full_mark_stops_re_deriving_from_the_stamp(tmp_path, monkeypatch):
    ctx = _build_shift_repo(tmp_path / "s14", monkeypatch)
    assert main(["reanchor", "--page", "平移测试", "--shifts", "--apply"]) == 0
    assert main(["mark", "--page", "平移测试.md", "-m", "prose re-derived"]) == 0
    row = _ledger_rows(ctx)[-1]
    assert row.get("applied") == [] and "partial" not in row
    # The page is current now, so its own baseline proves every anchor in place.
    assert main(["reanchor", "--page", "平移测试", "--shifts"]) == 0


def test_a_re_stamp_keeps_the_note_and_the_moves_of_the_last_one(tmp_path, monkeypatch):
    """Signing the same page twice must not lose what the first stamp recorded:
    the agent's note is its own, and the moved anchors are what keeps a voided
    stamp from being re-derived off the wrong window of history.
    """
    ctx = _build_shift_repo(tmp_path / "s15", monkeypatch)
    page = ctx["content"] / "平移测试.md"
    assert main(["reanchor", "--page", "平移测试", "--shifts", "--apply"]) == 0
    assert main(["mark", "--page", "平移测试.md", "--partial", "-m", "手记：prose 待补"]) == 0
    prior = wiki_drift.load_ledger()["平移测试.md"]
    assert prior.applied == ["src/gate.py#L6-L7"]
    wiki_drift.stamp_links(page, "平移测试.md", ctx["base"], prior, ["src/gate.py#L9-L10"])
    row = _ledger_rows(ctx)[-1]
    assert row["note"] == "手记：prose 待补"
    assert row["applied"] == ["src/gate.py#L6-L7", "src/gate.py#L9-L10"]
    assert row["partial"] is True
    # The hash describes the page as it stands now. Inheriting the previous
    # stamp's hash would void the entry the moment the page is edited again, and
    # with it the claim that these cites were brought current.
    stale = row["sha_after"]
    page.write_text(page.read_text(encoding="utf-8") + "\n<!-- touched -->\n", encoding="utf-8")
    wiki_drift.stamp_links(page, "平移测试.md", ctx["base"], prior, ["src/gate.py#L6-L7"])
    fresh = _ledger_rows(ctx)[-1]
    assert fresh["sha_after"] == wiki_drift.sha256(page) != stale
    # An apply that finds nothing to carry over still stamps a usable note.
    wiki_drift.stamp_links(page, "空白.md", ctx["base"], None, [])
    assert _ledger_rows(ctx)[-1]["note"].startswith("links only")


def test_a_stamp_whose_commit_was_force_pushed_away_is_trusted(tmp_path, monkeypatch, capsys):
    """The fork's daily sync rewrites history, so a stamp can end up naming a
    commit whose objects are gone. The coordinates on the page are all that is
    left: they are trusted, and no other cite is read off an unreadable window.
    """
    ctx = _build_shift_repo(tmp_path / "s16", monkeypatch)
    assert main(["reanchor", "--page", "平移测试", "--shifts", "--apply"]) == 0
    _git(ctx["root"], "checkout", "--orphan", "rewritten")
    _git(ctx["root"], "add", "-A")
    _git(ctx["root"], "commit", "-m", "history the sync rewrote")
    _git(ctx["root"], "branch", "-D", "main")
    _git(ctx["root"], "-c", "gc.auto=0", "reflog", "expire", "--expire-unreachable=now", "--all")
    _git(ctx["root"], "-c", "gc.auto=0", "gc", "--prune=now", "--quiet")
    capsys.readouterr()

    assert main(["reanchor", "--page", "平移测试", "--shifts"]) == 0
    out = capsys.readouterr().out
    assert "KEEP" in out and "1 left on coordinates this tool stamped" in out
    assert "src/gate.py#6-7 -> " not in out
    # The rest of the page falls back to the page's own baseline rather than being
    # read off a commit that no longer resolves, which would make every other
    # cite look unreadable.
    assert "no-baseline-text" not in out


def test_a_move_updates_the_text_a_cite_prints_as_well_as_its_target(tmp_path, monkeypatch):
    """The IDE writes a range twice, in the label and in the URL. Moving only the
    URL would leave the label naming lines nothing points at — the one half of a
    cite a reader checks by eye.
    """
    ctx = _build_shift_repo(tmp_path / "s18", monkeypatch)
    page = ctx["content"] / "平移测试.md"
    page.write_text(
        "# 平移测试\n\n<cite>\n"
        "- [gate.py:3-4](file://src/gate.py#L3-L4)\n"
        "- [src/gate.py:3-4](file://src/gate.py#L3-L4)\n"
        "- [章节来源](file://src/gate.py#L3-L4)\n"
        "</cite>\n",
        encoding="utf-8",
    )
    assert main(["reanchor", "--page", "平移测试", "--shifts", "--apply"]) == 0
    text = page.read_text(encoding="utf-8")
    assert "[gate.py:6-7](file://src/gate.py#L6-L7)" in text
    assert "[src/gate.py:6-7](file://src/gate.py#L6-L7)" in text
    # A label written as a title stays a title: no range is invented for it.
    assert "[章节来源](file://src/gate.py#L6-L7)" in text


def test_a_renamed_target_renames_what_the_cite_says(tmp_path, monkeypatch):
    ctx = _build_split_repo(tmp_path / "s19", monkeypatch)
    page = ctx["content"] / "锚定测试.md"
    page.write_text(
        page.read_text(encoding="utf-8").replace(
            "[alpha](file://src/gate.py#L3-L4)", "[gate.py:3-4](file://src/gate.py#L3-L4)"
        ),
        encoding="utf-8",
    )
    assert main(["reanchor", "--page", "锚定测试", "--apply"]) == 0
    text = page.read_text(encoding="utf-8")
    moved = re.search(r"\[([^\]]*)\]\(file://src/gate/policies\.py#L(\d+)-L(\d+)\)", text)
    assert moved, text
    assert moved.group(1) == f"policies.py:{moved.group(2)}-{moved.group(3)}"


def test_a_label_that_disagrees_with_its_own_url_is_brought_onto_it(tmp_path, monkeypatch, capsys):
    """The two halves of a cite drift apart one at a time — a hand edit, a link
    moved by an older build of this tool. A write that leaves them disagreeing
    ships a contradiction the reader can only settle by opening the file.
    """
    ctx = _build_shift_repo(tmp_path / "s20", monkeypatch)
    page = ctx["content"] / "平移测试.md"
    page.write_text(
        "# 平移测试\n\n<cite>\n"
        "- [gate.py:3-4](file://src/gate.py#L6-L7)\n"
        "- [gate.py:3-4](file://src/gate.py)\n"
        "</cite>\n",
        encoding="utf-8",
    )
    assert main(["reanchor", "--page", "平移测试", "--shifts", "--apply"]) == 0
    out = capsys.readouterr().out
    text = page.read_text(encoding="utf-8")
    assert "[gate.py:6-7](file://src/gate.py#L6-L7)" in text
    # A range printed on a cite whose target carries no anchor at all is the
    # heading of a section, not a stale anchor: there is nothing to align it to.
    assert "[gate.py:3-4](file://src/gate.py)" in text
    assert "re-printed 1 label(s)" in out
    # A label that already prints its target is left byte-identical: a sweep over
    # 450 pages must not churn the 800 links that are already honest.
    capsys.readouterr()
    before = page.read_text(encoding="utf-8")
    assert main(["reanchor", "--page", "平移测试", "--shifts", "--apply"]) == 0
    assert "LABEL" not in capsys.readouterr().out
    assert page.read_text(encoding="utf-8") == before


def test_a_single_line_cite_is_not_inflated_into_a_range(tmp_path, monkeypatch, capsys):
    ctx = _build_shift_repo(tmp_path / "s21", monkeypatch)
    page = ctx["content"] / "平移测试.md"
    page.write_text(
        "# 平移测试\n\n<cite>\n- [gate.py:4](file://src/gate.py#L4)\n</cite>\n",
        encoding="utf-8",
    )
    assert main(["reanchor", "--page", "平移测试", "--shifts", "--apply"]) == 0
    capsys.readouterr()
    assert "[gate.py:4](file://src/gate.py#L4)" in page.read_text(encoding="utf-8")


def test_a_label_fix_does_not_demote_a_reconciled_page(tmp_path, monkeypatch, capsys):
    """Realigning what a cite prints changes no claim about its prose. Demoting the
    page would send a finished page back into the update queue on every sweep.
    """
    ctx = _build_shift_repo(tmp_path / "s22", monkeypatch)
    page = ctx["content"] / "平移测试.md"
    page.write_text(
        "# 平移测试\n\n<cite>\n- [gate.py:3-4](file://src/gate.py#L6-L7)\n</cite>\n",
        encoding="utf-8",
    )
    assert main(["mark", "--page", "平移测试.md", "-m", "prose re-derived"]) == 0
    capsys.readouterr()

    assert main(["reanchor", "--page", "平移测试", "--shifts", "--apply"]) == 0
    assert "[gate.py:6-7](file://src/gate.py#L6-L7)" in page.read_text(encoding="utf-8")
    # The run must not tell the reader the page went back on the prose queue.
    assert "0 page(s) re-stamped as links-only" in capsys.readouterr().out
    row = _ledger_rows(ctx)[-1]
    assert "partial" not in row and row["drivers"] == ["src/gate.py"]
    assert row["sha_after"] == wiki_drift.sha256(page)
    capsys.readouterr()
    assert main(["report", "--page", "平移测试", "--json"]) == 0
    state = json.loads(capsys.readouterr().out)["pages"][0]["state"]
    assert state == "reconciled"


def test_a_moved_anchor_still_owes_its_prose(tmp_path, monkeypatch):
    """The other half of the rule: a link that had to move means the sources
    drifted, and nobody has re-read the sentences around it.
    """
    ctx = _build_shift_repo(tmp_path / "s23", monkeypatch)
    assert main(["reanchor", "--page", "平移测试", "--shifts", "--apply"]) == 0
    head = _git(ctx["root"], "rev-parse", "HEAD").strip()
    assert main(["mark", "--page", "平移测试.md", "-m", "prose re-derived"]) == 0

    # A fresh insertion above the block, then a mark that cannot claim it.
    source = ctx["root"] / "src" / "gate.py"
    body = source.read_text(encoding="utf-8").splitlines()
    source.write_text("\n".join(["# grown"] + body) + "\n", encoding="utf-8")
    _git(ctx["root"], "add", "-A")
    _git(ctx["root"], "commit", "-m", "one more line on top")
    assert main(["reanchor", "--page", "平移测试", "--shifts", "--apply"]) == 0
    row = _ledger_rows(ctx)[-1]
    assert row["partial"] is True and row["head"] == _git(ctx["root"], "rev-parse", "HEAD").strip()
    assert head != row["head"]


def test_a_fix_on_a_page_edited_behind_the_ledger_still_owes_prose(tmp_path, monkeypatch):
    """The reconciled claim only holds while the page still hashes to what was
    signed. Once someone edits it outside the loop, a link fix is not enough to
    put it back on the finished side.
    """
    ctx = _build_shift_repo(tmp_path / "s24", monkeypatch)
    page = ctx["content"] / "平移测试.md"
    page.write_text(
        "# 平移测试\n\n<cite>\n- [gate.py:3-4](file://src/gate.py#L6-L7)\n</cite>\n",
        encoding="utf-8",
    )
    assert main(["mark", "--page", "平移测试.md", "-m", "prose re-derived"]) == 0
    page.write_text(page.read_text(encoding="utf-8") + "\n本章节补充说明。\n", encoding="utf-8")

    assert main(["reanchor", "--page", "平移测试", "--shifts", "--apply"]) == 0
    assert "[gate.py:6-7](file://src/gate.py#L6-L7)" in page.read_text(encoding="utf-8")
    assert _ledger_rows(ctx)[-1]["partial"] is True


def test_a_partial_stamp_reads_hand_fixed_anchors_as_current(tmp_path, monkeypatch, capsys):
    """An agent that re-derives cites by hand and stamps links-only has said the
    cites are current; diffing them against the snapshot again would treat the
    HEAD coordinates as baseline ones and try to move them a second time.
    """
    ctx = _build_shift_repo(tmp_path / "s17", monkeypatch)
    page = ctx["content"] / "平移测试.md"
    page.write_text(
        "# 平移测试\n\n<cite>\n- [alpha](file://src/gate.py#L6-L7)\n</cite>\n",
        encoding="utf-8",
    )
    assert main(["mark", "--page", "平移测试.md", "--partial", "-m", "anchors re-derived by hand"]) == 0
    assert _ledger_rows(ctx)[-1]["cites"] == "all"
    capsys.readouterr()

    assert main(["reanchor", "--page", "平移测试", "--shifts"]) == 0
    out = capsys.readouterr().out
    assert "1 already on their line" in out and "PROPOSE" not in out and "OPEN" not in out


def test_shift_ref_skips_a_cite_that_already_matches_its_own_text(tmp_path, monkeypatch):
    ctx = _build_shift_repo(tmp_path / "s5", monkeypatch)
    page = ctx["content"] / "平移测试.md"
    # Pretend the page is current: interpret the anchors against HEAD itself.
    head = _git(ctx["root"], "rev-parse", "HEAD").strip()
    by_ref = {r: shift_ref(r, head) for r in parse_refs(page)}
    beta = next(p for r, p in by_ref.items() if r.start == 5)
    assert beta["outcome"] == "in-place"


# ---------------------------------------------------------------------------
# wide ranges that a split leaves non-contiguous
# ---------------------------------------------------------------------------

MONOLITH = [
    "# header",                                                        # L1
    "",                                                                # L2
    "def alpha():",                                                    # L3
    "    return 'alpha body marker one'",                               # L4
    "    return 'alpha body marker two'",                               # L5
    "    return 'alpha body marker three'",                            # L6
    "    return 'alpha body marker four'",                              # L7
    "    return 'alpha body marker five'",                              # L8
    "",                                                                # L9
    "def beta():",                                                     # L10
    "    return 'beta body marker one'",                                # L11
    "    return 'beta body marker two'",                                # L12
    "",                                                                 # L13
    "def gamma():",                                                    # L14
    "    return 'gamma body marker one'",                               # L15
    "    return 'gamma body marker two'",                               # L16
    "    return 'gamma body marker three'",                             # L17
    "    return 'gamma body marker four'",                              # L18
    "    return 'gamma body marker five'",                              # L19
    "    return 'gamma body marker six'",                               # L20
]


def _make_repo(tmp_dir, monkeypatch, after_files, page_cite):
    """A repo whose single cited module is reshaped into a package."""
    root = tmp_dir
    root.mkdir(exist_ok=True)
    _git(root, "init", "-b", "main")
    _git(root, "config", "user.email", "test@example.com")
    _git(root, "config", "user.name", "Test")
    info = root / ".git" / "info"
    info.mkdir(parents=True, exist_ok=True)
    (info / "exclude").write_text(".qoder/\n", encoding="utf-8")
    (root / "src").mkdir()
    (root / "src" / "gate.py").write_text("\n".join(MONOLITH) + "\n", encoding="utf-8")
    content = root / ".qoder" / "repowiki" / "zh" / "content"
    content.mkdir(parents=True)
    (content / "宽引用.md").write_text(
        f"# 宽引用\n\n<cite>\n{page_cite}\n</cite>\n", encoding="utf-8"
    )
    _git(root, "add", "-A")
    _git(root, "commit", "-m", "snapshot")
    base = _git(root, "rev-parse", "HEAD").strip()
    (root / "src" / "gate.py").unlink()
    for rel, lines in after_files.items():
        f = root / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text("\n".join(lines) + "\n", encoding="utf-8")
    _git(root, "add", "-A")
    _git(root, "commit", "-m", "split")
    meta = root / ".qoder" / "repowiki" / "zh" / "meta"
    meta.mkdir(parents=True, exist_ok=True)
    (meta / "repowiki-metadata.json").write_text(
        json.dumps({"wiki_repo": {"last_commit_id": base}}), encoding="utf-8"
    )
    for name, value in (
        ("REPO", root), ("WIKI", root / ".qoder" / "repowiki"), ("CONTENT", content),
        ("META", meta / "repowiki-metadata.json"),
        ("UPDATE_DIR", root / ".qoder" / "repowiki" / "update"),
        ("LEDGER", root / ".qoder" / "repowiki" / "update" / "ledger.jsonl"),
        ("_final_text_cache", {}), ("_line_cache", {}), ("_historical_cache", {}),
    ):
        monkeypatch.setattr(wiki_drift, name, value)
    return root


def _one_ref(root):
    refs = [r for r in parse_refs(root / ".qoder" / "repowiki" / "zh" / "content" / "宽引用.md")
            if not (root / r.path).exists()]
    assert len(refs) == 1, refs
    return refs[0]


def test_wide_range_is_recut_by_its_own_ends(tmp_path, monkeypatch):
    """A split line in the middle kills the whole-block match, not the ends."""
    policies = ["'''policies'''", "", *MONOLITH[0:9], "    # inserted by the split", *MONOLITH[9:20]]
    root = _make_repo(
        tmp_path / "g", monkeypatch, {"src/gate/policies.py": policies},
        "- [wide](file://src/gate.py#L1-L20)",
    )
    prop = reanchor_ref(_one_ref(root), metadata_baseline())
    assert prop["outcome"] == "matched"
    assert prop["file"] == "src/gate/policies.py"
    assert prop["evidence"].startswith("span-bracket")
    assert prop["anchor"] == (3, 23)


def test_span_split_across_modules_is_reported_not_applied(tmp_path, monkeypatch):
    head_module = ["'''identity'''", "", *MONOLITH[0:9]]
    tail_module = ["'''release'''", "", *MONOLITH[9:20]]
    root = _make_repo(
        tmp_path / "h", monkeypatch,
        {"src/gate/identity.py": head_module, "src/gate/release.py": tail_module},
        "- [wide](file://src/gate.py#L1-L20)",
    )
    prop = reanchor_ref(_one_ref(root), metadata_baseline())
    assert prop["outcome"] == "span-partition"
    assert prop["file"] is None
    assert any("identity.py" in o for o in prop["options"])
    assert any("release.py" in o for o in prop["options"])

    before = (root / ".qoder" / "repowiki" / "zh" / "content" / "宽引用.md").read_text(encoding="utf-8")
    assert main(["reanchor", "--page", "宽引用", "--apply"]) == 0
    after = (root / ".qoder" / "repowiki" / "zh" / "content" / "宽引用.md").read_text(encoding="utf-8")
    assert after == before  # a partition is an agent's call, never a rewrite


def test_span_bracket_rewrites_the_page(tmp_path, monkeypatch):
    policies = ["'''policies'''", "", *MONOLITH[0:9], "    # inserted by the split", *MONOLITH[9:20]]
    root = _make_repo(
        tmp_path / "i", monkeypatch, {"src/gate/policies.py": policies},
        "- [wide](file://src/gate.py#L1-L20)",
    )
    assert main(["reanchor", "--page", "宽引用", "--apply"]) == 0
    after = (root / ".qoder" / "repowiki" / "zh" / "content" / "宽引用.md").read_text(encoding="utf-8")
    assert "src/gate/policies.py#L3-L23" in after


# ---------------------------------------------------------------------------
# cites that point past the end of the file
# ---------------------------------------------------------------------------


def _build_overrun_repo(tmp_path, monkeypatch, shrink=True):
    """A page citing the last line an editor shows, and a range that never existed.

    The generator writes an end-of-file cite on the line an editor shows after the
    last newline — 3194 of the wiki's cites end there — so counting newlines
    instead called all of them out of bounds.
    """
    root = tmp_path
    root.mkdir(exist_ok=True)
    _git(root, "init", "-b", "main")
    _git(root, "config", "user.email", "test@example.com")
    _git(root, "config", "user.name", "Test")
    info = root / ".git" / "info"
    info.mkdir(parents=True, exist_ok=True)
    (info / "exclude").write_text(".qoder/\n", encoding="utf-8")
    (root / "src").mkdir()
    tall = [f"line {i}" for i in range(1, 121)]
    (root / "src" / "tall.py").write_text("\n".join(tall) + "\n", encoding="utf-8")
    content = root / ".qoder" / "repowiki" / "zh" / "content"
    content.mkdir(parents=True)
    (content / "越界测试.md").write_text(
        "# 越界测试\n\n<cite>\n"
        "- [eof](file://src/tall.py#L1-L121)\n"
        "- [invented](file://src/tall.py#L1-L600)\n"
        "</cite>\n",
        encoding="utf-8",
    )
    _git(root, "add", "-A")
    _git(root, "commit", "-m", "snapshot")
    base = _git(root, "rev-parse", "HEAD").strip()
    if shrink:
        (root / "src" / "tall.py").write_text("\n".join(tall[:60]) + "\n", encoding="utf-8")
        _git(root, "add", "-A")
        _git(root, "commit", "-m", "the file lost half its lines")

    meta = root / ".qoder" / "repowiki" / "zh" / "meta"
    meta.mkdir(parents=True)
    (meta / "repowiki-metadata.json").write_text(
        json.dumps({"wiki_repo": {"last_commit_id": base}}), encoding="utf-8"
    )
    for name, value in (
        ("REPO", root),
        ("WIKI", root / ".qoder" / "repowiki"),
        ("CONTENT", content),
        ("META", meta / "repowiki-metadata.json"),
        ("UPDATE_DIR", root / ".qoder" / "repowiki" / "update"),
        ("LEDGER", root / ".qoder" / "repowiki" / "update" / "ledger.jsonl"),
        ("_final_text_cache", {}),
        ("_line_cache", {}),
        ("_historical_cache", {}),
    ):
        monkeypatch.setattr(wiki_drift, name, value)
    return {"root": root, "content": content, "base": base}


def _audit_overrun(ctx):
    page = ctx["content"] / "越界测试.md"
    return audit_page(page, "越界测试.md", "snapshot", ctx["base"], make_changes_for(), set(), set())


def test_a_cite_on_the_last_shown_line_is_not_an_overrun(tmp_path, monkeypatch):
    ctx = _build_overrun_repo(tmp_path / "o1", monkeypatch, shrink=False)
    rep = _audit_overrun(ctx)
    assert rep.stale == []
    assert [a for a in rep.anchors if "L1-L121" in a] == []
    assert len(rep.anchors) == 1
    # The remaining one was past the end the day it was written: no re-anchor can
    # find a block that never existed, and the report has to say so.
    assert "past the end at the snapshot too" in rep.anchors[0]


def test_a_shrunk_file_reports_the_change_and_the_overrun_apart(tmp_path, monkeypatch):
    """A changed file used to short-circuit the anchor check, which hid the half of
    the overruns that drift did cause — the ones a reader cannot see without opening
    the file.
    """
    ctx = _build_overrun_repo(tmp_path / "o2", monkeypatch)
    rep = _audit_overrun(ctx)
    assert rep.stale == ["src/tall.py"]
    eof = next(a for a in rep.anchors if "L1-L121" in a)
    assert "61 lines now, 121 at the snapshot" in eof
    invented = next(a for a in rep.anchors if "L1-L600" in a)
    assert "past the end at the snapshot too" in invented


def test_a_cite_past_the_end_keeps_its_own_label(tmp_path, monkeypatch, capsys):
    """Copying an out-of-range URL into the label would dress a fabricated cite up as
    a self-consistent one and bury the only clue that an agent has to replace it.
    """
    ctx = _build_overrun_repo(tmp_path / "o3", monkeypatch, shrink=False)
    page = ctx["content"] / "越界测试.md"
    page.write_text(
        "# 越界测试\n\n<cite>\n- [tall.py:1-120](file://src/tall.py#L1-L600)\n</cite>\n",
        encoding="utf-8",
    )
    assert main(["reanchor", "--page", "越界测试", "--shifts", "--apply"]) == 0
    out = capsys.readouterr().out
    assert "[tall.py:1-120](file://src/tall.py#L1-L600)" in page.read_text(encoding="utf-8")
    assert "1 cite(s) left as printed: their target is past the end" in out


# ---------------------------------------------------------------------------
# fork-owned trademark guard over repowiki/**
# ---------------------------------------------------------------------------
#
# Upstream's gate (b) greps the *filesystem*, so it polices repowiki/** the moment
# that tree is tracked — and the tree is a publication, so the literal must not
# appear in it. This guard exists because that same gate is ALSO permanently red
# locally (defect ⑫: it scans the .qoder/ export that git excludes), which would
# bury a new hit in existing noise until CI blocked the push. The needle is
# assembled at runtime: a contiguous literal here would trip the gate this
# enforces, and `grep -v "$SELF"` exempts only the gate script itself.
TM_NEEDLE = "".join(["wor", "ld", "quant"])
TM_RE = re.compile(TM_NEEDLE, re.IGNORECASE)
TM_SUFFIXES = {".md", ".html", ".json", ".py", ".txt", ".yml", ".yaml"}
REAL_REPO = Path(__file__).resolve().parents[1]


def scan_trademark(root: Path) -> list[tuple[str, int]]:
    """Every (posix-relative-path, line-number) under root carrying the literal."""
    hits: list[tuple[str, int]] = []
    for path in sorted(root.rglob("*")):
        if not path.is_file() or path.suffix.lower() not in TM_SUFFIXES:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        for n, line in enumerate(text.splitlines(), 1):
            if TM_RE.search(line):
                hits.append((path.relative_to(root).as_posix(), n))
    return hits


def test_tm_guard_catches_a_planted_hit(tmp_path):
    (tmp_path / "topics").mkdir()
    (tmp_path / "topics" / "x.md").write_text(
        f"# 标题\n禁止 {TM_NEEDLE} 出现在发布物里\n", encoding="utf-8"
    )
    assert scan_trademark(tmp_path) == [("topics/x.md", 2)]


def test_guard_sees_a_cjk_named_page(wired):
    """Canary for the real tree's file naming: the scan must resolve CJK paths."""
    planted = wired["content"] / "命中页.md"
    planted.write_text(f"{TM_NEEDLE}\n", encoding="utf-8")
    assert scan_trademark(wired["wiki"]) == [("zh/content/命中页.md", 1)]


def test_this_test_file_does_not_contain_the_literal():
    text = Path(__file__).read_text(encoding="utf-8")
    assert TM_NEEDLE not in text.lower()


def test_shipped_wiki_tree_is_trademark_clean():
    tree = REAL_REPO / "repowiki"
    assert tree.is_dir(), "repowiki/ must exist from M1 onward"
    scanned = [p for p in tree.rglob("*") if p.is_file()]
    assert scanned, "guard must not pass on an empty tree"
    assert scan_trademark(tree) == []


# ---------------------------------------------------------------------------
# WikiRoot: one root, two layouts, no silent empty tree
# ---------------------------------------------------------------------------


def test_wiki_root_repo_layout(tmp_path):
    root = wiki_drift.WikiRoot.resolve(tmp_path, base=tmp_path)
    assert root.layout == "repo"
    assert root.content == tmp_path / "topics"
    assert root.ledger == tmp_path / "ledger.jsonl"
    assert root.update_dir == tmp_path / "drift"
    assert root.meta == tmp_path / "zh" / "meta" / "repowiki-metadata.json"
    assert root.modules == tmp_path / "modules"
    assert root.cards == tmp_path / "cards"
    assert root.index_md == tmp_path / "INDEX.md"


def test_wiki_root_detects_the_ide_layout(tmp_path):
    (tmp_path / "zh" / "content").mkdir(parents=True)
    root = wiki_drift.WikiRoot.resolve(tmp_path, base=tmp_path)
    assert root.layout == "ide"
    assert root.content == tmp_path / "zh" / "content"
    assert root.update_dir == tmp_path / "update"
    assert root.ledger == tmp_path / "update" / "ledger.jsonl"


def test_wiki_root_resolves_relative_to_the_repo(tmp_path):
    root = wiki_drift.WikiRoot.resolve("repowiki", base=tmp_path)
    assert root.root == tmp_path / "repowiki"


def test_apply_wiki_root_repoints_the_five_globals(tmp_path, monkeypatch):
    """`apply_wiki_root` mutates module globals, so the case must snapshot them
    first — otherwise the mutation leaks into whichever test runs next."""
    for name in ("REPO", "WIKI", "CONTENT", "META", "UPDATE_DIR", "LEDGER", "wiki_root"):
        monkeypatch.setattr(wiki_drift, name, getattr(wiki_drift, name))
    (tmp_path / "repowiki" / "topics").mkdir(parents=True)
    monkeypatch.setattr(wiki_drift, "REPO", tmp_path)
    root = wiki_drift.apply_wiki_root("repowiki")
    assert root.layout == "repo"
    assert wiki_drift.CONTENT == tmp_path / "repowiki" / "topics"
    assert wiki_drift.LEDGER == tmp_path / "repowiki" / "ledger.jsonl"
    assert wiki_drift.UPDATE_DIR == tmp_path / "repowiki" / "drift"
    assert wiki_drift.wiki_root is root


def test_wiki_root_flag_is_accepted_on_either_side_of_the_verb(tmp_path, monkeypatch, capsys):
    """Both spellings must work: README and the usage block show
    `--wiki-root repowiki report`, while muscle memory writes `report --wiki-root X`.
    A flag defined only on the subparsers rejects the first form with an argparse error."""
    for name in ("REPO", "WIKI", "CONTENT", "META", "UPDATE_DIR", "LEDGER", "wiki_root"):
        monkeypatch.setattr(wiki_drift, name, getattr(wiki_drift, name))
    root = tmp_path / "repo"
    (root / "repowiki").mkdir(parents=True)
    monkeypatch.setattr(wiki_drift, "REPO", root)
    for argv in (["--wiki-root", "repowiki", "report"], ["report", "--wiki-root", "repowiki"]):
        assert main(argv) == 2, argv
        err = capsys.readouterr().err
        assert "no wiki pages under" in err, argv
        assert wiki_drift.CONTENT == root / "repowiki" / "topics", argv


def test_empty_tree_is_an_error_not_a_green(tmp_path, monkeypatch, capsys):
    """Zero pages must not read as zero problems: an empty set that passes every
    assertion is this repo's known false green."""
    root = tmp_path / "repo"
    (root / "repowiki").mkdir(parents=True)  # README only, no topics/
    monkeypatch.setattr(wiki_drift, "REPO", root)
    monkeypatch.setattr(wiki_drift, "WIKI", root / "repowiki")
    monkeypatch.setattr(wiki_drift, "CONTENT", root / "repowiki" / "topics")
    monkeypatch.setattr(
        wiki_drift, "META", root / "repowiki" / "zh" / "meta" / "repowiki-metadata.json"
    )
    monkeypatch.setattr(wiki_drift, "UPDATE_DIR", root / "repowiki" / "drift")
    monkeypatch.setattr(wiki_drift, "LEDGER", root / "repowiki" / "ledger.jsonl")
    monkeypatch.setattr(
        wiki_drift,
        "wiki_root",
        wiki_drift.WikiRoot.resolve(root / "repowiki", base=root),
    )
    assert main(["report"]) == 2
    err = capsys.readouterr().err
    assert "no wiki pages" in err and "--wiki-root" in err


def test_empty_tree_hint_points_at_the_archive(tmp_path, monkeypatch, capsys):
    """After M2 the export is archived, so the hint that still says 'read it with
    --wiki-root .qoder/repowiki' would send a reader to a directory that no longer
    has a content tree. Both substrings the existing cases assert must survive."""
    monkeypatch.setattr(wiki_drift, "CONTENT", tmp_path / "topics")
    monkeypatch.setattr(wiki_drift, "WIKI", tmp_path)
    monkeypatch.setattr(wiki_drift, "wiki_root", wiki_drift.WikiRoot(root=tmp_path, layout="repo"))
    assert main(["report"]) == 2
    err = capsys.readouterr().err
    assert "no wiki pages" in err and "--wiki-root" in err
    assert wiki_drift.EXPORT_ARCHIVE in err


def _packed(text: str) -> str:
    """Help text with every run of whitespace removed, so argparse's wrapping can
    never break a long path across two lines and make an assertion miss it."""
    return "".join(text.split())


def _assert_no_bare_legacy_root(text: str, label: str) -> None:
    """Every mention of the retired root must carry the archive suffix.

    A bare `.qoder/repowiki` in help output is an instruction the shell cannot
    run any more (it exits 2), which is the defect this pins shut."""
    packed = _packed(text)
    for hit in re.finditer(re.escape(wiki_drift.LEGACY_EXPORT), packed):
        tail = packed[hit.end():]
        assert tail.startswith(f"/{wiki_drift.EXPORT_ARCHIVE}"), (
            label, packed[max(0, hit.start() - 60):hit.end() + 30]
        )


def _archive_value(node: ast.Call) -> ast.expr:
    """The expression one `EMPTY_TREE_HINT.format(...)` call hands to `archive=`."""
    return next(kw.value for kw in node.keywords if kw.arg == "archive")


@pytest.mark.parametrize("argv", [
    ["mark", "--page", "缺席页.md"],
    ["reanchor", "--page", "缺席页"],
], ids=["mark", "reanchor"])
def test_empty_tree_hint_points_at_the_archive_on_the_writing_verbs(
        tmp_path, monkeypatch, capsys, argv):
    """The hint has three call sites — `cmd_reanchor`, `build()` (behind `report`)
    and `cmd_mark` — and before this case only `report` reached its own.

    Deleting `archive=` at either writer raised a bare `KeyError` *inside the
    error path*, so the suite stayed green while `mark`/`reanchor` on an empty
    root turned into a traceback instead of the six-line explanation. Same drive
    shape as the `report` case above, same three assertions, plus the rendered
    archive path itself: that is what a wrong-but-present `archive=` would slip
    past."""
    monkeypatch.setattr(wiki_drift, "CONTENT", tmp_path / "topics")
    monkeypatch.setattr(wiki_drift, "WIKI", tmp_path)
    monkeypatch.setattr(wiki_drift, "UPDATE_DIR", tmp_path / "drift")
    monkeypatch.setattr(wiki_drift, "LEDGER", tmp_path / "ledger.jsonl")
    monkeypatch.setattr(wiki_drift, "wiki_root", wiki_drift.WikiRoot(root=tmp_path, layout="repo"))
    assert main(argv) == 2, argv
    err = capsys.readouterr().err
    assert "no wiki pages" in err and "--wiki-root" in err, argv
    assert f"{wiki_drift.LEGACY_EXPORT}/{wiki_drift.EXPORT_ARCHIVE}" in err, argv


def test_every_empty_tree_hint_call_site_passes_archive():
    """Static backstop to the behavioural cases above: a *fourth* guard added by
    the next milestone (`stale`/`index`) that forgets `archive=` fails exactly
    like the two untested sites did — a `KeyError` no other test reaches.

    Sweeping the source also pins the two regressions this task's brief warns
    about: the template must stay a plain `.format` string (an f-string would
    evaluate `{content}` at import and NameError on module load), and its slot
    list must equal the keywords each site passes, so `{archive}` cannot be
    dropped from the template while the call sites still hand it over."""
    src = (REAL_REPO / "tools" / "wiki_drift.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    slots = set(re.findall(r"\{(\w+)\}", wiki_drift.EMPTY_TREE_HINT))
    assert slots == {"content", "root", "layout", "archive"}, sorted(slots)

    sites = [
        node for node in ast.walk(tree)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute)
        and node.func.attr == "format"
        and isinstance(node.func.value, ast.Name)
        and node.func.value.id == "EMPTY_TREE_HINT"
    ]
    assert len(sites) >= 3, [node.lineno for node in sites]
    for node in sites:
        passed = {kw.arg for kw in node.keywords}
        assert passed == slots, (node.lineno, sorted(passed))
        # the archive value must be DERIVED (`LEGACY_EXPORT` + `EXPORT_ARCHIVE`);
        # a second hardcoded copy of the path is what drifted out of sync this round
        segment = ast.get_source_segment(src, _archive_value(node)) or ""
        words = set(re.findall(r"\w+", segment))
        assert {"LEGACY_EXPORT", "EXPORT_ARCHIVE"} <= words, (node.lineno, segment)

    assignment = [
        node for node in tree.body
        if isinstance(node, ast.Assign)
        and any(isinstance(t, ast.Name) and t.id == "EMPTY_TREE_HINT" for t in node.targets)
    ]
    assert len(assignment) == 1, assignment
    assert not isinstance(assignment[0].value, ast.JoinedStr), "must stay a .format template"


def test_help_advertises_the_archive_not_the_retired_root(capsys):
    """Both `--wiki-root` help strings and the module docstring's usage block used
    to tell readers the IDE export "stays reachable as .qoder/repowiki" — measured
    today that root exits 2, so following `--help` produced a hard failure the
    tool's own documentation had caused.

    `seed --help` is checked for the archive only, not for the bare root: its
    `--from` default is still the pre-retirement export root, which is a seeding
    concern (M3 owns the `--from`/`knowledge/` split), not a `--wiki-root` claim.
    """
    archive = f"{wiki_drift.LEGACY_EXPORT}/{wiki_drift.EXPORT_ARCHIVE}"

    def _help(argv):
        with pytest.raises(SystemExit):
            main(argv)
        return _packed(capsys.readouterr().out)

    top = _help(["--help"])
    assert archive in top
    _assert_no_bare_legacy_root(top, "--help")
    for verb in ("report", "mark", "reanchor"):
        out = _help([verb, "--help"])
        assert archive in out, verb
        _assert_no_bare_legacy_root(out, f"{verb} --help")
    assert archive in _help(["seed", "--help"])

    doc = _packed(wiki_drift.__doc__ or "")
    assert archive in doc, "the usage block must show the archive path"
    _assert_no_bare_legacy_root(doc, "module docstring")


# ---------------------------------------------------------------------------
# frontmatter: the per-page baseline, and the hash that must survive adding it
# ---------------------------------------------------------------------------

FM_SAMPLE = (
    "---\n"
    'page: "回测引擎/投资组合优化器/最大分散化优化器.md"\n'
    "sources:\n"
    '  - "agent/backtest/optimizers/max_diversification.py"\n'
    '  - "agent/backtest/constraints.py"\n'
    'verified_at: "0000000000000000000000000000000000000000"\n'
    "anchors: verified\n"
    "vouch: applied-only\n"
    "---\n"
    "# 最大分散化优化器\n\n<cite>\n- [x](file://agent/backtest/constraints.py#L1-L9)\n</cite>\n"
)


def test_split_frontmatter_keeps_body_bytes_intact():
    fm, body = wiki_drift.split_frontmatter(FM_SAMPLE)
    assert fm["page"] == "回测引擎/投资组合优化器/最大分散化优化器.md"
    assert fm["sources"] == [
        "agent/backtest/optimizers/max_diversification.py",
        "agent/backtest/constraints.py",
    ]
    assert fm["anchors"] == "verified" and fm["vouch"] == "applied-only"
    assert fm["verified_at"] == "0" * 40
    assert body.startswith("# 最大分散化优化器")
    assert "<cite>" in body


def test_pages_without_frontmatter_are_unaffected(tmp_path):
    plain = tmp_path / "plain.md"
    plain.write_text("# 标题\n正文\n", encoding="utf-8")
    assert wiki_drift.parse_frontmatter(plain.read_text(encoding="utf-8")) is None
    assert wiki_drift.body_sha(plain) == wiki_drift.sha256(plain)


def test_body_hash_is_byte_faithful_on_a_crlf_checkout(tmp_path):
    """core.autocrlf=true makes this repo's working copy CRLF. A body hash built from
    newline-translated text would not match the bytes on disk, so every existing
    ledger row would read `ledger-void` the moment frontmatter is seeded — the exact
    regression body_sha exists to avoid. The suite caught this on the first run."""
    page = tmp_path / "crlf.md"
    page.write_bytes(
        "# 标题\r\n\r\n<cite>\r\n- [x](file://a.py#L1-L2)\r\n</cite>\r\n".encode("utf-8")
    )
    old = wiki_drift.sha256(page)
    assert wiki_drift.body_sha(page) == old
    assert wiki_drift.read_frontmatter(page) is None
    wiki_drift.update_frontmatter(page, anchors="verified")
    assert wiki_drift.body_sha(page) == old, "seeding frontmatter must not void the stamp"
    assert "\r\n" in wiki_drift.body_text(page), "the body keeps its own line endings"
    assert wiki_drift.read_frontmatter(page)["anchors"] == "verified"


def test_ledger_hash_survives_seeding_frontmatter(tmp_path):
    """The load-bearing property: adding frontmatter must not void the 426 existing
    ledger rows, because they hash the body and seeding keeps the body byte-exact."""
    legacy = tmp_path / "legacy.md"
    legacy.write_text("# 标题\n\n<cite>\n- [x](file://a.py#L1-L2)\n</cite>\n", encoding="utf-8")
    old_sha = wiki_drift.sha256(legacy)
    seeded = tmp_path / "seeded.md"
    seeded.write_text(
        wiki_drift.emit_frontmatter(
            {
                "page": "主题/页.md",
                "sources": ["a.py"],
                "verified_at": "0" * 40,
                "anchors": "open",
                "vouch": "applied-only",
            }
        )
        + legacy.read_text(encoding="utf-8"),
        encoding="utf-8",
    )
    assert wiki_drift.body_sha(seeded) == old_sha
    assert wiki_drift.sha256(seeded) != old_sha


def test_emit_then_read_roundtrip(tmp_path):
    page = tmp_path / "p.md"
    original = "# 标题\n正文\n"
    page.write_text(original, encoding="utf-8", newline="\n")
    fm = wiki_drift.update_frontmatter(
        page,
        page="主题/页.md",
        sources=["b.py", "a.py"],
        verified_at="f" * 40,
        anchors="verified",
        vouch="all",
    )
    assert fm["sources"] == ["b.py", "a.py"]  # cite order preserved, not sorted
    assert wiki_drift.read_frontmatter(page) == fm
    assert wiki_drift.body_text(page) == original


def test_update_frontmatter_is_idempotent_and_order_stable(tmp_path):
    page = tmp_path / "p.md"
    page.write_text("# 标题\n正文\n", encoding="utf-8")
    first = wiki_drift.update_frontmatter(page, anchors="verified")
    after_first = page.read_text(encoding="utf-8")
    wiki_drift.update_frontmatter(page, anchors="verified")
    assert page.read_text(encoding="utf-8") == after_first
    assert list(first) == ["page", "sources", "verified_at", "anchors", "vouch"]
    assert "sources: []" in after_first  # empty list must parse back as a list


def test_emit_frontmatter_keeps_foreign_keys(tmp_path):
    """The 9 IDE cards ship metadata we do not own and must not silently delete:
    `update_frontmatter` used to rebuild the block from FM_KEYS alone, which
    dropped every other key. Body bytes stay untouched — that is what `body_sha`
    and the 426 ledger rows depend on."""
    page = tmp_path / "卡片.md"
    page.write_text(
        "---\n"
        "kind: external_dependency\n"
        "category_hints:\n"
        "    - framework_behavior\n"
        "    - auth_protocol\n"
        "source_files:\n"
        "    - frontend/src/lib/pineLang.ts\n"
        "---\n\n### 角色\n正文\n",
        encoding="utf-8",
    )
    body_before = wiki_drift.body_text(page)
    fm = wiki_drift.update_frontmatter(page, verified_at="a" * 40, anchors="open")
    assert fm["kind"] == "external_dependency"
    assert fm["category_hints"] == ["framework_behavior", "auth_protocol"]
    assert fm["source_files"] == ["frontend/src/lib/pineLang.ts"]
    again = wiki_drift.read_frontmatter(page)
    assert again["kind"] == "external_dependency", "round trip must not drop it"
    assert wiki_drift.body_text(page) == body_before, "the ledger hashes the body, not the block"
    # Idempotence: a generator whose own output looks like an edit is unreviewable.
    before = page.read_bytes()
    wiki_drift.update_frontmatter(page, verified_at="a" * 40)
    assert page.read_bytes() == before
    text = page.read_text(encoding="utf-8")
    assert text.index("source_files:") > text.index("vouch:"), "5 known keys first, then sorted extras"
    assert text.index("category_hints:") < text.index("kind:"), "extras sorted, not in arrival order"


def test_foreign_scalar_keys_are_emitted_and_reread(tmp_path):
    page = tmp_path / "x.md"
    page.write_text("", encoding="utf-8", newline="\n")
    wiki_drift.update_frontmatter(page, name="业务术语表", empty_list=[])
    fm = wiki_drift.read_frontmatter(page)
    assert fm["name"] == "业务术语表"
    assert fm["empty_list"] == [], "an empty list must survive as `[]`, not as a nested key"


def test_frontmatter_baseline_only_accepts_a_reachable_full_sha(tmp_path):
    page = tmp_path / "p.md"
    page.write_text("# 标题\n", encoding="utf-8")
    assert wiki_drift.frontmatter_baseline(page) is None
    wiki_drift.update_frontmatter(page, verified_at="abc123")  # not 40 hex
    assert wiki_drift.frontmatter_baseline(page) is None
    good = "0123456789abcdef" * 2 + "01234567"  # exactly 40 hex
    assert len(good) == 40
    wiki_drift.update_frontmatter(page, verified_at=good, vouch="all")
    assert wiki_drift.frontmatter_baseline(page) == good


# ---------------------------------------------------------------------------
# per-page baseline beats the single global snapshot; missing frontmatter is loud
# ---------------------------------------------------------------------------


def _refs_for(wired):
    return wiki_drift.make_changes_for()


def test_frontmatter_baseline_wins_over_ledger_and_snapshot(wired):
    page = wired["content"] / "前端应用" / "模块说明.md"
    wiki_drift.update_frontmatter(page, page="前端应用/模块说明.md", verified_at=wired["head"], vouch="all")
    base, tag = wiki_drift.effective_base(page, "前端应用/模块说明.md", {}, wired["base"])
    assert (base, tag) == (wired["head"], "frontmatter")


def test_unreachable_frontmatter_rev_does_not_become_a_baseline(wired):
    """A seeded page may name a commit a force-pushed sync GC'd. The snapshot stays
    the honest base — a phantom baseline would freeze the page's drift at zero."""
    page = wired["content"] / "前端应用" / "模块说明.md"
    wiki_drift.update_frontmatter(page, verified_at="deadbeef" + "0" * 32, vouch="all")
    base, tag = wiki_drift.effective_base(page, "前端应用/模块说明.md", {}, wired["base"])
    assert (base, tag) == (wired["base"], "snapshot")


def test_ledger_still_wins_over_the_snapshot(wired):
    page = wired["content"] / "前端应用" / "模块说明.md"
    entry = wiki_drift.LedgerEntry(
        page="前端应用/模块说明.md", head=wired["head"],
        sha_after=wiki_drift.body_sha(page), note="", at="", cites="all",
    )
    base, tag = wiki_drift.effective_base(page, "前端应用/模块说明.md", {entry.page: entry}, wired["base"])
    assert (base, tag) == (wired["head"], "reconciled")


def test_partial_entry_still_does_not_move_the_baseline(wired):
    """Contract ④: the discipline that made 414 hidden todos visible must survive
    the frontmatter feature, on the ledger branch too."""
    page = wired["content"] / "前端应用" / "模块说明.md"
    entry = wiki_drift.LedgerEntry(
        page="前端应用/模块说明.md", head=wired["head"],
        sha_after=wiki_drift.body_sha(page), note="", at="", partial=True, cites="applied-only",
    )
    base, tag = wiki_drift.effective_base(page, "前端应用/模块说明.md", {entry.page: entry}, wired["base"])
    assert (base, tag) == (wired["base"], "partial")


def test_missing_frontmatter_is_flagged_on_the_page_report(wired):
    page = wired["content"] / "前端应用" / "模块说明.md"
    rep = audit_page(
        page, "前端应用/模块说明.md", "snapshot", wired["base"],
        _refs_for(wired), set(), set(),
    )
    assert rep.fm == "missing"
    wiki_drift.update_frontmatter(page, verified_at=wired["base"])
    rep = audit_page(
        page, "前端应用/模块说明.md", "snapshot", wired["base"],
        _refs_for(wired), set(), set(),
    )
    assert rep.fm == "present"


def test_frontmatter_provenance_survives_a_clean_page(wired):
    """A page whose baseline came from its own frontmatter and owes nothing reads
    `frontmatter`, not `clean` — the report must keep saying where the base came from."""
    page = wired["content"] / "前端应用" / "模块说明.md"
    wiki_drift.update_frontmatter(page, verified_at=wired["head"], vouch="all")
    rep = audit_page(
        page, "前端应用/模块说明.md", "frontmatter", wired["head"],
        _refs_for(wired), set(), set(),
    )
    assert rep.score == 0 and rep.state == "frontmatter"


def test_recorded_drivers_are_measured_from_the_page_baseline(wired):
    """Drivers must follow the same precedence, or a stamped page would list itself
    as owing everything since the snapshot."""
    page = wired["content"] / "前端应用" / "模块说明.md"
    wiki_drift.update_frontmatter(page, verified_at=wired["head"], vouch="all")
    stale, _broken = wiki_drift.recorded_drivers(page, "前端应用/模块说明.md", wired["base"])
    assert stale == []


def test_unreachable_page_baseline_falls_back_instead_of_claiming_no_drivers(wired):
    """A GC'd `verified_at` must not read as `nothing owed`: recorded_drivers
    returning ([], []) is how a stamp quietly becomes a clean page. The plan's
    `frontmatter_baseline(page) or fallback` would have done exactly that."""
    page = wired["content"] / "前端应用" / "模块说明.md"
    wiki_drift.update_frontmatter(page, verified_at="deadbeef" + "0" * 32, vouch="all")
    stale, _broken = wiki_drift.recorded_drivers(page, "前端应用/模块说明.md", wired["base"])
    assert stale == ["src/mod.py"]


def test_report_counts_pages_without_frontmatter(wired, capsys):
    assert main(["report", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["summary"]["no_frontmatter"] == 2
    assert payload["summary"]["pages"] == 2


def test_drift_md_names_the_missing_frontmatter(wired):
    main(["report", "--top", "5"])
    text = (wired["wiki"] / "update" / "DRIFT.md").read_text(encoding="utf-8")
    assert "缺 frontmatter 的页面：2" in text


# ---------------------------------------------------------------------------
# a repo-shaped fixture: the write-back tests must not exercise the IDE shape
# ---------------------------------------------------------------------------


@pytest.fixture
def repo_tree(tmp_path):
    """A git repo whose wiki uses the *repo* layout: repowiki/topics/... .

    Mirrors `repo` (the IDE-layout fixture) but with the tracked shape M1 moves to,
    so the write-back tests exercise `layout == "repo"`. The second commit inserts
    lines ABOVE the cited block: the block still exists, it just moved down, which
    is exactly what `reanchor --shifts` claims to prove — so it needs lines a matcher
    can recognise. Seven identical `print(1)` lines read as "nothing to prove", and a
    fixture whose apply pass changes nothing would let the write-back assertions pass
    by not running at all.
    """
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init", "-b", "main")
    _git(root, "config", "user.email", "test@example.com")
    _git(root, "config", "user.name", "Test")
    (root / "src").mkdir()
    mod = [
        "# header",      # L1
        "",              # L2
        "def alpha():",  # L3
        "    return 1",  # L4
        "",              # L5
        "def beta():",   # L6
        "    return 2",  # L7
    ]
    (root / "src" / "mod.py").write_text("\n".join(mod) + "\n", encoding="utf-8")
    _git(root, "add", "-A")
    _git(root, "commit", "-m", "snapshot baseline")
    base = _git(root, "rev-parse", "HEAD").strip()

    wiki = root / "repowiki"
    content = wiki / "topics"
    page_dir = content / "前端应用"
    page_dir.mkdir(parents=True)
    page = page_dir / "模块说明.md"
    page.write_text(
        "# 模块说明\n\n<cite>\n**本文引用的文件**\n"
        "- [alpha](file://src/mod.py#L3-L4)\n</cite>\n\n## 简介\n",
        encoding="utf-8",
    )
    _git(root, "add", "-A")
    _git(root, "commit", "-m", "seed the repo-owned wiki tree")
    seed = _git(root, "rev-parse", "HEAD").strip()

    lines = (root / "src" / "mod.py").read_text(encoding="utf-8").splitlines()
    (root / "src" / "mod.py").write_text(
        "\n".join(["# inserted above the cited block"] * 6 + lines) + "\n", encoding="utf-8"
    )
    _git(root, "add", "-A")
    _git(root, "commit", "-m", "insert lines above the cited block")
    head = _git(root, "rev-parse", "HEAD").strip()
    return {
        "root": root, "wiki": wiki, "content": content, "page": page,
        "base": base, "seed": seed, "head": head,
    }


@pytest.fixture
def repo_wired(repo_tree, monkeypatch):
    """The repo-layout tree, with every path global AND `wiki_root` pointed at it."""
    root, wiki = repo_tree["root"], repo_tree["wiki"]
    monkeypatch.setattr(wiki_drift, "REPO", root)
    monkeypatch.setattr(wiki_drift, "WIKI", wiki)
    monkeypatch.setattr(wiki_drift, "CONTENT", repo_tree["content"])
    monkeypatch.setattr(wiki_drift, "META", wiki / "zh" / "meta" / "repowiki-metadata.json")
    monkeypatch.setattr(wiki_drift, "UPDATE_DIR", wiki / "drift")
    monkeypatch.setattr(wiki_drift, "LEDGER", wiki / "ledger.jsonl")
    monkeypatch.setattr(wiki_drift, "wiki_root", wiki_drift.WikiRoot.resolve(wiki, base=root))
    monkeypatch.setattr(wiki_drift, "_line_cache", {})
    return repo_tree


# ---------------------------------------------------------------------------
# write-back: the stamp must leave its mark on the page, not only in the ledger
# ---------------------------------------------------------------------------


def test_repo_wired_fixture_is_the_repo_layout(repo_wired):
    """Canary: if this fixture silently degrades to `ide`, every write-back
    assertion below would pass by doing nothing."""
    assert wiki_drift.wiki_root.layout == "repo"


def test_mark_full_stamp_advances_the_page_baseline(repo_wired):
    page = repo_wired["page"]
    rel = "前端应用/模块说明.md"
    assert main(["mark", "--page", rel, "-m", "re-derived prose"]) == 0
    fm = wiki_drift.read_frontmatter(page)
    assert fm["verified_at"] == repo_wired["head"] and fm["vouch"] == "all"
    # The `page` key is the ledger's key, not the file name: a nested page stamped with
    # only its name is a second spelling of one identity.
    assert fm["page"] == rel


def test_partial_stamp_never_moves_verified_at(repo_wired):
    """Contract: a links-only / unfinished stamp may sign the ledger but must not
    advance the page's baseline, or the page drops out of the queue unsolved."""
    page = repo_wired["page"]
    rel = "前端应用/模块说明.md"
    assert main(["mark", "--page", rel, "--partial", "-m", "cites only"]) == 0
    fm = wiki_drift.read_frontmatter(page)
    assert fm["verified_at"] == "" and fm["vouch"] == "applied-only"
    row = wiki_drift.load_ledger()[rel]
    # The two axes are deliberately different here. `cites` scopes the LEDGER row, and
    # a hand stamp — partial or not — was signed by whoever read the page, so it vouches
    # every cite on it. `partial: True` is what keeps the prose owed, and `vouch` is what
    # stops a later tool pass from reading that row as a finished page.
    assert row.partial is True and row.cites == "all"


def test_body_sha_stable_across_frontmatter_write(repo_wired):
    page = repo_wired["page"]
    rel = "前端应用/模块说明.md"
    assert main(["mark", "--page", rel, "-m", "first"]) == 0
    first = wiki_drift.load_ledger()[rel].sha_after
    # The stamp is recorded before the block is written, so it equals the body hash;
    # afterwards the file is longer but its body is not, which is the whole point.
    assert first == wiki_drift.body_sha(page) != wiki_drift.sha256(page)
    assert main(["mark", "--page", rel, "-m", "second"]) == 0
    assert wiki_drift.load_ledger()[rel].sha_after == first


def test_ide_layout_root_stays_byte_identical(wired, monkeypatch):
    """The guard reads the root's shape off the disk, not the module global: a caller
    whose `wiki_root` is stale (which is what a fixture that only re-points CONTENT
    leaves behind) must still not be able to rewrite the IDE export."""
    page = wired["content"] / "前端应用" / "模块说明.md"
    before = page.read_bytes()
    monkeypatch.setattr(
        wiki_drift,
        "wiki_root",
        wiki_drift.WikiRoot.resolve(wired["root"] / "repowiki", base=wired["root"]),
    )
    assert wiki_drift.wiki_root.layout == "repo"  # deliberately mismatched global
    assert wiki_drift.stamp_frontmatter(page, verified_at="a" * 40) is None
    assert page.read_bytes() == before


def test_mark_on_an_ide_root_leaves_the_page_bytes_alone(wired):
    """Same contract through the command path: frontmatter belongs to the tracked
    tree, and touching 450 IDE bytes would recreate the second source of truth."""
    page = wired["content"] / "前端应用" / "模块说明.md"
    before = page.read_bytes()
    assert main(["mark", "--page", "前端应用/模块说明.md", "-m", "ledger only"]) == 0
    assert page.read_bytes() == before
    assert wiki_drift.load_ledger()["前端应用/模块说明.md"].note == "ledger only"


def test_anchor_axis_is_open_when_a_cite_was_refused():
    """The decision `reanchor --apply` records: the tool refuses to invent targets
    for ranges that stop past the end, so that page's anchor axis is NOT verified."""
    assert wiki_drift.anchors_axis(0) == "verified"
    assert wiki_drift.anchors_axis(2) == "open"


def test_reanchor_apply_writes_the_anchor_axis_back(repo_wired):
    page = repo_wired["page"]
    # `--baseline` because the repo-shaped fixture has no IDE metadata file: with no
    # baseline at all there is no window to diff, the pass finds nothing to move, and
    # the write-back below would never run.
    assert main(["reanchor", "--page", "前端应用/模块说明.md", "--shifts", "--apply",
                 "--baseline", repo_wired["base"]]) == 0
    # Prove the apply branch ran at all: without a moved link in the body, `fm is not
    # None` below could only ever come from some other writer.
    assert "[alpha](file://src/mod.py#L9-L10)" in page.read_text(encoding="utf-8")
    fm = wiki_drift.read_frontmatter(page)
    assert fm is not None, "a repo-layout page must gain frontmatter after --apply"
    assert fm["anchors"] == "verified"  # nothing on this page was refused
    assert fm["vouch"] == "applied-only"  # a tool pass never vouches the whole page


def test_a_refused_cite_keeps_the_anchor_axis_open(repo_wired):
    """Both branches of `anchors_axis` have to be reachable through the command, or the
    field is decoration. A cite whose target stops past the end is left as printed on
    purpose — copying the range into its label would dress a fabricated cite up as a
    self-consistent one — so the page cannot claim its anchors are verified."""
    page = repo_wired["page"]
    page.write_text(
        page.read_text(encoding="utf-8").replace(
            "- [alpha](file://src/mod.py#L3-L4)\n",
            "- [alpha](file://src/mod.py#L3-L4)\n"
            "- [mod.py:30-60](file://src/mod.py#L30-L60)\n",
        ),
        encoding="utf-8",
    )
    assert main(["reanchor", "--page", "前端应用/模块说明.md", "--shifts", "--apply",
                 "--baseline", repo_wired["base"]]) == 0
    fm = wiki_drift.read_frontmatter(page)
    assert fm["anchors"] == "open" and "[mod.py:30-60](file://src/mod.py#L30-L60)" in (
        page.read_text(encoding="utf-8")
    )


# ---------------------------------------------------------------------------
# the vouch scope is what makes frontmatter precedence safe
# ---------------------------------------------------------------------------


def test_only_a_full_vouch_makes_verified_at_the_baseline(tmp_path):
    """`verified_at` is a claim about the whole page, and only a hand `mark` may make
    it. Without this gate the *next* writer (reanchor, a partial mark) would leave a
    stale `verified_at` in front of a body nobody re-read — frontmatter outranks the
    ledger, so the diff would be measured from HEAD and come out empty by construction.
    That is the 414-hidden-todos failure mode, in new clothing."""
    page = tmp_path / "p.md"
    page.write_text("# 标题\n", encoding="utf-8")
    good = "0123456789abcdef" * 2 + "01234567"
    wiki_drift.update_frontmatter(page, verified_at=good, vouch="all")
    assert wiki_drift.frontmatter_baseline(page) == good
    wiki_drift.update_frontmatter(page, vouch="applied-only")
    assert wiki_drift.frontmatter_baseline(page) is None


def test_a_partial_mark_takes_back_a_previous_full_vouch(repo_wired):
    """The ordering this contract exists to protect: a full stamp moves the baseline to
    HEAD, a later partial pass signs the ledger `partial`, and the page must go back
    into the queue rather than self-match against its own fresh stamp."""
    page = repo_wired["page"]
    rel = "前端应用/模块说明.md"
    assert main(["mark", "--page", rel, "-m", "read the whole page"]) == 0
    assert wiki_drift.read_frontmatter(page)["vouch"] == "all"
    assert wiki_drift.frontmatter_baseline(page) == repo_wired["head"]

    assert main(["mark", "--page", rel, "--partial", "-m", "cites only"]) == 0
    fm = wiki_drift.read_frontmatter(page)
    assert fm["vouch"] == "applied-only"
    assert fm["verified_at"] == repo_wired["head"]  # not moved, not cleared
    assert wiki_drift.frontmatter_baseline(page) is None
    base, tag = wiki_drift.effective_base(page, rel, wiki_drift.load_ledger(), repo_wired["base"])
    assert (base, tag) == (repo_wired["base"], "partial")


def test_reanchor_apply_takes_back_a_stale_full_vouch(repo_wired):
    """The same withdrawal where it actually bites: `mark` signed the page at an older
    head, so the page owes the window since — and the tool pass that fixes its links
    must not leave `vouch: all` in front of bytes nobody re-read."""
    page = repo_wired["page"]
    rel = "前端应用/模块说明.md"
    wiki_drift.update_frontmatter(page, page=rel, verified_at=repo_wired["seed"], vouch="all")
    assert wiki_drift.frontmatter_baseline(page) == repo_wired["seed"]
    assert main(["reanchor", "--page", rel, "--shifts", "--apply"]) == 0
    assert "[alpha](file://src/mod.py#L9-L10)" in page.read_text(encoding="utf-8")
    fm = wiki_drift.read_frontmatter(page)
    assert fm["vouch"] == "applied-only"
    assert fm["verified_at"] == repo_wired["seed"]  # kept, but no longer a claim
    assert wiki_drift.frontmatter_baseline(page) is None
    base, tag = wiki_drift.effective_base(page, rel, wiki_drift.load_ledger(), repo_wired["base"])
    assert (base, tag) == (repo_wired["base"], "partial")


# ---------------------------------------------------------------------------
# zero-upstream-file-changes: a falsifiable requirement, not a good intention
# ---------------------------------------------------------------------------
#
# This is a fork of an open-source project, and `merge upstream/main` is how it
# stays current — a merge has no force/reset escape hatch that the owner would
# accept, so every file upstream also owns is a hand conflict waiting on the next
# sync. Upstream ownership here was measured, not assumed:
#
#   git ls-tree -r --name-only upstream/main -- <path>   (>0 ⇒ upstream owns it)
#
# which makes `.gitignore`, `tools/ci_grep_gates.sh`, `.github/workflows/test.yml`
# and `wiki/**` (42 files) theirs, and `tools/wiki_drift.py`, `tools/test_wiki_drift.py`,
# `项目档案.md`, `repowiki/**` and `docs/**` ours. The predicate below is the only
# thing standing between a convenience edit and that conflict, so it has to be able
# to say *yes* — see the canary.

UPSTREAM_OWNED = re.compile(
    r"^(\.gitignore|tools/ci_grep_gates\.sh|\.github/workflows/test\.yml|wiki/)"
)


def changed_vs_upstream() -> list[str]:
    """Fork-side paths changed between upstream/main and HEAD."""
    proc = subprocess.run(
        ["git", "-C", str(REAL_REPO), "-c", "core.quotepath=off",
         "diff", "--name-only", "upstream/main...HEAD"],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"upstream/main is not resolvable here ({proc.stderr.strip()}) — "
            "run `git fetch upstream` first. This check must fail, never skip: "
            "a guard that quietly passes when it could not read anything is the "
            "false green this repo already documents twice."
        )
    return [line for line in proc.stdout.splitlines() if line.strip()]


def test_protected_path_predicate_flags_known_owned_paths():
    """Canary: the filter has to be able to say yes, or an empty diff proves nothing."""
    for path in (".gitignore", "tools/ci_grep_gates.sh", ".github/workflows/test.yml",
                 "wiki/home/index.html"):
        assert UPSTREAM_OWNED.match(path), path
    for path in ("tools/wiki_drift.py", "repowiki/README.md", "docs/x/y.md",
                 "agent/src/x.py", "repowiki/topics/前端应用/页.md"):
        assert not UPSTREAM_OWNED.match(path), path


def test_fork_change_set_is_not_empty():
    """Second canary: `no offenders` over an empty diff would be the same vacuity."""
    assert len(changed_vs_upstream()) > 100  # measured 275 at M1 time


def test_an_unresolvable_upstream_raises_instead_of_passing(tmp_path, monkeypatch):
    """The failure mode this repo keeps hitting: a check that cannot read anything
    returns nothing, and nothing looks like compliance."""
    monkeypatch.setitem(globals(), "REAL_REPO", tmp_path)
    with pytest.raises(RuntimeError, match="must fail, never skip"):
        changed_vs_upstream()


def test_no_fork_commit_touches_an_upstream_owned_file():
    offenders = [p for p in changed_vs_upstream() if UPSTREAM_OWNED.match(p)]
    assert offenders == [], f"upstream-owned files modified by fork commits: {offenders}"


# ---------------------------------------------------------------------------
# line-ending pin for the published tree (M2 precondition)
# ---------------------------------------------------------------------------


def test_repowiki_tree_is_pinned_to_lf():
    """core.autocrlf=true on this machine turns every checked-out page body into
    CRLF, and `body_sha` hashes those bytes — one clone would read all 426 ledger
    rows as `ledger-void`. The root .gitattributes belongs to upstream, so the
    tracked tree carries its own (a deeper attributes file wins)."""
    attr = REAL_REPO / "repowiki" / ".gitattributes"
    assert attr.is_file(), "M2 must pin line endings inside its own tree"
    assert "* text=auto eol=lf" in attr.read_text(encoding="utf-8")
    proc = subprocess.run(
        # core.quotepath is on by default here, which renders this CJK probe path
        # octal-escaped inside quotes; the flag only affects that display, never
        # the resolution being asserted. Same flag, same reason as the
        # zero-upstream helper above.
        ["git", "-C", str(REAL_REPO), "-c", "core.quotepath=off", "check-attr",
         "text", "eol", "--", "repowiki/topics/\u524d\u7aef\u5e94\u7528/x.md"],
        capture_output=True, text=True, encoding="utf-8",
    )
    assert proc.stdout.strip().endswith("repowiki/topics/\u524d\u7aef\u5e94\u7528/x.md: eol: lf")


def test_autocrlf_pinning_is_what_saves_the_body_bytes(tmp_path):
    """Not a claim about git's docs — a round trip in a throwaway repo, with the
    control branch proving the hazard is real on this platform."""
    def build(with_attr: bool) -> bytes:
        repo = tmp_path / ("pinned" if with_attr else "loose")
        repo.mkdir()
        _git(repo, "init", "-b", "main")
        _git(repo, "config", "user.email", "t@example.com")      # repo-local, never global
        _git(repo, "config", "user.name", "T")
        _git(repo, "config", "core.autocrlf", "true")
        tree = repo / "repowiki"
        tree.mkdir()
        if with_attr:
            (tree / ".gitattributes").write_text("* text=auto eol=lf\n", encoding="utf-8")
        page = tree / "topics"
        page.mkdir()
        src = "# \u6807\u9898\n\n\u6b63\u6587 LF \u4e00\u81f4\u6027\u3002\n"
        (page / "\u9875.md").write_bytes(src.encode("utf-8"))
        _git(repo, "add", "-A")
        _git(repo, "commit", "-m", "seed")
        (page / "\u9875.md").unlink()
        _git(repo, "checkout", "--", ".")
        return (page / "\u9875.md").read_bytes()

    pinned, loose = build(True), build(False)
    assert b"\r\n" not in pinned, pinned
    if sys.platform == "win32":
        # The canary: if the control also comes back LF, autocrlf did not run and
        # the assertion above proves nothing (this repo's HARNESS-BLIND category).
        assert b"\r\n" in loose, f"control lost the hazard: {loose[:40]!r}"


# ---------------------------------------------------------------------------
# M2 seeding: the constant tables the seed reads
# ---------------------------------------------------------------------------


def test_seed_slug_maps_are_two_way_unique_and_ascii():
    """Hard-coded instead of parsed: the export's own `_index.yaml`/`_module.yaml`
    are YAML, and gate (a) of this repo's CI exists precisely to keep a yaml parser
    out of these tools. 6 + 9 is small enough to assert in both directions, which
    is what turns 'we silently forgot a module' from a story into a red test."""
    assert len(wiki_drift.MODULE_SLUGS) == 6
    assert len(wiki_drift.CARD_SLUGS) == 9
    assert len(wiki_drift.FACE_NAMES) == 5
    for table in (wiki_drift.MODULE_SLUGS, wiki_drift.CARD_SLUGS):
        slugs = list(table.values())
        assert len(slugs) == len(set(slugs)), "two source dirs cannot share one target slug"
        for slug in slugs:
            assert re.fullmatch(r"[a-z0-9][a-z0-9-]*", slug), slug
    assert sorted(wiki_drift.FACE_NAMES.values()) == [
        "architecture.md", "commands.md", "conventions.md", "overview.md", "tech-stack.md",
    ]
    # The parent module is the only depth-1 dir; the five children hang off it.
    parents = [k for k in wiki_drift.MODULE_SLUGS if "/" not in k]
    assert len(parents) == 1, "exactly one depth-1 module dir"
    parent = parents[0]
    assert wiki_drift.MODULE_SLUGS[parent] == "repo-root"
    assert all(k.startswith(f"{parent}/") for k in wiki_drift.MODULE_SLUGS if k != parent), \
        "every other module key must hang off the one parent"


def test_seed_reword_key_names_a_real_published_path():
    """A typo in a REWORDS key would silently mean 'nothing was reworded' — the
    exception would become an excuse for a page that never got seeded (spec §12)."""
    targets = {f"modules/{slug}/{face}" for slug in wiki_drift.MODULE_SLUGS.values()
               for face in wiki_drift.FACE_NAMES.values()}
    targets |= {f"cards/{slug}.md" for slug in wiki_drift.CARD_SLUGS.values()}
    assert set(wiki_drift.REWORDS) <= targets
    assert list(wiki_drift.REWORDS) == ["modules/ci-gates/architecture.md"]


def test_metadata_baseline_can_read_a_second_root(tmp_path):
    """The seed reads the export's snapshot commit exactly once, from a path that is
    not the module global — after M1 the tracked tree has no metadata file at all."""
    meta = tmp_path / "zh" / "meta" / "repowiki-metadata.json"
    meta.parent.mkdir(parents=True)
    meta.write_text(json.dumps({"wiki_repo": {"last_commit_id": "b" * 40}}), encoding="utf-8")
    assert wiki_drift.metadata_baseline(meta) == "b" * 40


# ---------------------------------------------------------------------------
# M2 seeding: page planning (PagePlan / plan_topics / plan_knowledge / refs_from_text)
# ---------------------------------------------------------------------------


def _export(tmp_path: Path) -> Path:
    """A throwaway legacy export: 2 topic pages with cites, plus `zh/meta` and
    `update/ledger.jsonl`. Absolute, because a relative `--from` resolves against
    `REPO`, and the seeds' `WIKI` is absolute for the same reason."""
    wiki = tmp_path / "export"
    content = wiki / "zh" / "content" / "前端应用"
    content.mkdir(parents=True)
    (content / "页一.md").write_text(
        "# 页一\n\n<cite>\n**本文引用的文件**\n"
        "- [a](file://src/mod.py#L1-L10)\n- [b](file://src/other.py)\n"
        "- [a again](file://src/mod.py#L40-L50)\n</cite>\n\n## 简介\n\n正文\n",
        encoding="utf-8",
    )
    (content / "页二.md").write_text("# 页二\n\n<cite>\n- [c](file://src/mod.py)\n</cite>\n", encoding="utf-8")
    (wiki / "zh" / "meta").mkdir(parents=True)
    update = wiki / "update"
    update.mkdir(parents=True)
    (update / "ledger.jsonl").write_text(
        json.dumps({"page": "前端应用/页一.md", "head": "c" * 40,
                    "sha_after": "d" * 64, "note": "n", "at": "t"}) + "\n",
        encoding="utf-8",
    )
    return wiki


def test_plan_topics_keys_are_the_ledger_primary_key(tmp_path, monkeypatch):
    """The relative path must survive verbatim under `topics/`, CJK included: 426
    ledger rows are keyed by exactly this string, so a rename here silently
    un-stamps every page. The rows hash the *body* too, so the body is pinned to the
    source's own bytes, and a tree that plans no page at all is a failure, not a
    green run."""
    wiki = tmp_path / "repowiki"
    wiki.mkdir()
    monkeypatch.setattr(wiki_drift, "WIKI", wiki)
    export = _export(tmp_path)
    plans = wiki_drift.plan_topics(export, "a" * 40)
    assert [p.label for p in plans] == [
        "topics/前端应用/页一.md", "topics/前端应用/页二.md",
    ]
    assert plans[0].fm["page"] == "前端应用/页一.md", "`page` is relative to topics/"
    assert plans[0].origin == "topic"
    assert plans[0].target == wiki / "topics" / "前端应用" / "页一.md"
    # The ledger hashes the *body bytes* under that key, so the bytes are the
    # invariant too, not just the path. `Path.write_text` translates `\n` to the
    # platform newline, so these fixture pages are CRLF here (the real export's 450
    # pages are LF-only) — which is exactly what makes the assertion bite: a
    # `\n` -> `\r\n` translation in `plan_topics` lands on the CRs and yields
    # `\r\r\n` bytes, red; dropping the CRs (universal-newline reading) is red too.
    src = export / "zh" / "content" / "前端应用" / "页一.md"
    assert plans[0].body == src.read_bytes(), "the ledger hashes these exact bytes"
    # And the key only means something if there are plans to carry it: a `zh/content`
    # that exists but holds no page would otherwise sail through every assertion above
    # and let Task 6's seed "succeed" having published 0 of 450 pages.
    empty = tmp_path / "empty"
    (empty / "zh" / "content").mkdir(parents=True)
    with pytest.raises(RuntimeError, match="no export pages planned"):
        wiki_drift.plan_topics(empty, "a" * 40)


def test_plan_topics_sources_are_deduped_sorted_repo_paths(tmp_path):
    plans = wiki_drift.plan_topics(_export(tmp_path), "a" * 40)
    # Two cites of one file -> one source; bare paths, not `file://` links, so
    # `parse_refs` on the seeded page still counts the body and nothing else.
    assert plans[0].fm["sources"] == ["src/mod.py", "src/other.py"]
    assert plans[0].fm["verified_at"] == "a" * 40
    assert plans[0].fm["anchors"] == "open"
    assert plans[0].fm["vouch"] == "applied-only", "a move is not a re-reading"


def test_plan_topics_rejects_an_export_page_with_frontmatter(tmp_path):
    """Measured 0 such pages today. A surprise here must stop the seed rather than
    nest two blocks: `split_frontmatter` would then hash a body that starts with a
    stray `---`, and the ledger would call it a hand edit."""
    wiki = _export(tmp_path)
    keyed = wiki / "zh" / "content" / "前端应用" / "页三.md"
    keyed.write_text("---\nkind: x\n---\n\n# 页三\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="unexpected frontmatter"):
        wiki_drift.plan_topics(wiki, "a" * 40)
    # A fence whose every line is a comment parses to `{}` — truthiness waves it
    # through, `is not None` does not, and it is exactly the page this guard exists
    # for. Isolate it: drop the `kind:` page so only the comment fence can raise.
    keyed.unlink()
    (wiki / "zh" / "content" / "前端应用" / "页四.md").write_text(
        "---\n# 注释\n---\n\n# 页四\n", encoding="utf-8")
    assert wiki_drift.split_frontmatter(
        "---\n# 注释\n---\nbody\n")[0] == {}, "the fence has to parse empty for this to bite"
    with pytest.raises(RuntimeError, match="unexpected frontmatter"):
        wiki_drift.plan_topics(wiki, "a" * 40)


def test_parse_refs_and_refs_from_text_are_one_implementation(tmp_path, wired):
    """Two codecs would drift. `sources` is only worth having if it is read the
    same way the report reads cites.

    The seed hands `refs_from_text` the `newline=""` text (CR intact) and the report
    hands it the universal-newline text, so the newline modality is the one thing that
    genuinely differs between them — compare *those* two, not one call against itself.
    A `write_bytes` page keeps its `\r\n` on every platform, so the two sides really do
    read different bytes here, not just on a CRLF checkout.
    """
    page = wired["content"] / "前端应用" / "模块说明.md"
    crlf = wired["content"] / "前端应用" / "换行.md"
    crlf.write_bytes(b"# \xe6\x8d\xa2\xe8\xa1\x8c\r\n\r\n<cite>\r\n"
                     b"- [m](file://src/mod.py#L1-L4)\r\n</cite>\r\n")
    for target in (page, crlf):
        assert [r.path for r in wiki_drift.refs_from_text(wiki_drift.read_page_text(target))] == [
            r.path for r in parse_refs(target)
        ]
    assert [r.path for r in parse_refs(crlf)] == ["src/mod.py"], "not one codec scored twice"


def _kb(tmp_path: Path, modules: list[str], cards: list[str]) -> Path:
    """A throwaway knowledge export: module dirs holding `_module.yaml` + the 5
    faces, and card dirs holding one self-named `.md`.

    Fake tables, never the real tree: `modules=`/`cards=` exist so these tests can
    feed 2 modules and 2 cards (a base given neither writes no tree root at all,
    which is why the blocks that add a dir of their own pass `parents=True`). Every
    card this writes carries `source_files` as a list; the real glossary does not
    carry the key at all, so that case is built by hand where a test needs it. A unit
    test that read `.qoder/repowiki/knowledge/` would be invisible to CI and to
    anyone without the export, and Task 10 is the one that runs against it for real.
    """
    kb = tmp_path / "knowledge" / "zh"
    for m in modules:
        d = kb / m
        d.mkdir(parents=True, exist_ok=True)
        (d / "_module.yaml").write_text("key: x\n", encoding="utf-8")
        for face in wiki_drift.FACE_NAMES:
            (d / face).write_text(f"# {face}\n\n内容\n", encoding="utf-8")
    for c in cards:
        d = kb / c
        d.mkdir(parents=True, exist_ok=True)
        (d / f"{c}.md").write_text(
            f"---\nkind: card\nname: {c}\nsource_files:\n    - src/mod.py\n---\n\n### 角色\n",
            encoding="utf-8",
        )
    return kb


def test_plan_knowledge_maps_every_face_and_keeps_card_keys(tmp_path, monkeypatch):
    wiki = tmp_path / "repowiki"
    wiki.mkdir()
    monkeypatch.setattr(wiki_drift, "WIKI", wiki)
    kb = _kb(tmp_path, ["父", "父/子"], ["业务术语表"])
    # A second card carrying `kind/name/slug/scope` but NO `source_files` — the real
    # glossary's shape (measured: 8 of the 9 cards have the key, 1 does not). This is
    # the fact behind "31 of 494 pages ship with empty `sources`" and nothing in the
    # suite proved it: an empty evidence base publishes empty, never invented, while
    # the IDE keys the card does carry still round-trip.
    bare = kb / "卡片二"
    bare.mkdir()
    (bare / "卡片二.md").write_text(
        "---\nkind: card\nname: 卡片二\nslug: two\nscope: repo\n---\n\n### 角色\n",
        encoding="utf-8",
    )
    # The second fake module is slugged `agent-backend`, not `ci-gates`: `REWORDS`
    # claims `modules/ci-gates/architecture.md`, and `strip_reword` demands the needle
    # exactly once on any label it owns — a stand-in dir with generic prose in that
    # slot raises instead of planning. Test 3 puts the needle there on purpose.
    plans = wiki_drift.plan_knowledge(
        kb, "a" * 40, modules={"父": "repo-root", "父/子": "agent-backend"},
        cards={"业务术语表": "glossary", "卡片二": "card-two"})
    assert len(plans) == 12, "2 modules x 5 faces + 2 cards"
    by_label = {p.label: p for p in plans}
    # A plan count cannot see the *values* of the two tables: two source dirs mapped
    # to one slug produce the right number of plans with two identical labels and two
    # identical targets, and the dict above collapses the duplicate — so the
    # surviving assertion would pass on the wrong page. `plan_knowledge` refuses a
    # non-injective label set; this line is the test-side half of that refusal.
    assert len(by_label) == len(plans), "labels are the ledger key: 12 distinct"
    # Sampling, not spot-checking: every plan lands where its own label says, and
    # the aggregation layer's half of the sources rule holds for all 30 faces, not
    # just for the one page this test used to read.
    for p in plans:
        assert p.target == wiki / p.label, "the label is the path it lands on"
        assert p.fm["page"] == p.label, "prefixed on both layers, unlike topics/"
        if p.label.startswith("modules/"):
            assert p.origin == "module" and p.fm["sources"] == []
        else:
            assert p.origin == "card"
    card = by_label["cards/glossary.md"]
    assert card.fm["kind"] == "card" and card.fm["name"] == "业务术语表"
    assert card.fm["sources"] == ["src/mod.py"], "source_files feeds `sources`"
    assert card.fm["source_files"] == ["src/mod.py"], "...and the IDE key still ships"
    assert card.origin == "card"
    bare_card = by_label["cards/card-two.md"]
    assert bare_card.fm["sources"] == [], "no source_files -> an honest empty base"
    assert "source_files" not in bare_card.fm, "...and the absent IDE key is not forged"
    assert bare_card.fm["slug"] == "two" and bare_card.fm["scope"] == "repo"


def test_plan_knowledge_demands_both_directions_of_the_map(tmp_path):
    """The migration's reconciliation rule: every source dir claimed exactly once,
    no exceptions accepted. An unmapped dir means a page nobody seeded; a mapped dir
    missing on disk means a slug pointing at nothing.

    Both halves, both layers. Every block below gets its own throwaway tree and a
    table that is *complete* for the other layer, because the module loop runs first:
    a block aimed at a card guard handed a broken module table would report the module
    raise and still be green. Each `match=` therefore names its own guard.
    """
    kb = _kb(tmp_path, ["父"], [])
    root = {"父": "repo-root"}
    with pytest.raises(RuntimeError, match="unmapped module dir"):
        wiki_drift.plan_knowledge(kb, "a" * 40, modules={}, cards={})
    with pytest.raises(RuntimeError, match="module dir missing"):
        wiki_drift.plan_knowledge(kb, "a" * 40, modules={"父": "repo-root", "缺": "gone"}, cards={})

    # "module" is the `_module.yaml` marker, not a directory on disk. A mapped dir
    # that lost or renamed its marker used to plan its 5 faces silently, and the card
    # scan is top-level only, so nothing on either side reported the swap.
    kb_nomark = _kb(tmp_path / "m0", ["父"], [])
    (kb_nomark / "父" / "_module.yaml").unlink()
    with pytest.raises(RuntimeError, match="module dir missing"):
        wiki_drift.plan_knowledge(kb_nomark, "a" * 40, modules=root, cards={})

    # One face short is 4 pages published and 1 that is not — indistinguishable from
    # a clean run by the plan count.
    kb_face = _kb(tmp_path / "m1", ["父"], [])
    (kb_face / "父" / "概述.md").unlink()
    with pytest.raises(RuntimeError, match=r"module face missing: 父/概述\.md"):
        wiki_drift.plan_knowledge(kb_face, "a" * 40, modules=root, cards={})

    # Faces arrive without frontmatter (measured 0 today). A fence here would be
    # nested into the body and hashed as prose; `is not None` is what makes a
    # comment-only fence raise as well — `if fm:` waves `{}` through.
    kb_fm = _kb(tmp_path / "m2", ["父"], [])
    (kb_fm / "父" / "概述.md").write_text("---\nkind: face\n---\n\n# 概述\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="unexpected frontmatter"):
        wiki_drift.plan_knowledge(kb_fm, "a" * 40, modules=root, cards={})
    (kb_fm / "父" / "概述.md").write_text("---\n# 注释\n---\n\n# 概述\n", encoding="utf-8")
    assert wiki_drift.split_frontmatter(
        "---\n# 注释\n---\nbody\n")[0] == {}, "the fence has to parse empty for this to bite"
    with pytest.raises(RuntimeError, match="unexpected frontmatter"):
        wiki_drift.plan_knowledge(kb_fm, "a" * 40, modules=root, cards={})

    # Byte fidelity on faces: one invalid byte becomes U+FFFD under
    # `read_page_text`'s `errors="replace"`, i.e. a page whose published bytes differ
    # from the bytes the ledger hashes under the same key.
    kb_byte = _kb(tmp_path / "m3", ["父"], [])
    (kb_byte / "父" / "概述.md").write_bytes(b"# overview\n\n\xff\n")
    with pytest.raises(RuntimeError, match="not the export bytes"):
        wiki_drift.plan_knowledge(kb_byte, "a" * 40, modules=root, cards={})

    # Both tables are keyed by the source *dir*, so two dirs can share one slug: 10
    # plans, 5 of them labels another plan already owns.
    kb_dupe = _kb(tmp_path / "m4", ["父", "父/子"], [])
    with pytest.raises(RuntimeError, match="duplicate plan label"):
        wiki_drift.plan_knowledge(
            kb_dupe, "a" * 40, modules={"父": "same", "父/子": "same"}, cards={})

    # ---- the card half ----
    kb_unmapped = _kb(tmp_path / "c0", [], ["孤儿卡"])
    with pytest.raises(RuntimeError, match="unmapped card dirs"):
        wiki_drift.plan_knowledge(kb_unmapped, "a" * 40, modules={}, cards={})
    # The table has to name the orphan too, or the unmapped guard fires first and the
    # missing direction is never reached. `sorted(cards)` puts 孤(U+5B64) before
    # 缺(U+7F3A), so the orphan plans and the typo is the one that raises.
    with pytest.raises(RuntimeError, match="card dir missing"):
        wiki_drift.plan_knowledge(
            kb_unmapped, "a" * 40, modules={}, cards={"孤儿卡": "orphan", "缺卡": "gone"})

    kb_nopage = _kb(tmp_path / "c1", [], [])
    (kb_nopage / "空卡").mkdir(parents=True)
    with pytest.raises(RuntimeError, match="card page missing"):
        wiki_drift.plan_knowledge(kb_nopage, "a" * 40, modules={}, cards={"空卡": "empty"})

    # A card page with no `---` fence used to plan with `sources: []` and no IDE keys
    # at all: that block is the card's only evidence source, and losing it shipped a
    # page claiming an empty evidence base where the export names eight files.
    kb_bare = _kb(tmp_path / "c2", [], [])
    (kb_bare / "无栅栏卡").mkdir(parents=True)
    (kb_bare / "无栅栏卡" / "无栅栏卡.md").write_text("### 角色\n\n正文\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="has no frontmatter"):
        wiki_drift.plan_knowledge(kb_bare, "a" * 40, modules={}, cards={"无栅栏卡": "bare"})

    # The card half of byte fidelity: the fence is dropped by design, so byte
    # identity is unavailable and a strict decode is what is left of the guarantee.
    kb_bad = _kb(tmp_path / "c3", [], ["坏卡"])
    bad = kb_bad / "坏卡" / "坏卡.md"
    bad.write_bytes(bad.read_bytes() + b"\xff")
    with pytest.raises(RuntimeError, match="not valid UTF-8"):
        wiki_drift.plan_knowledge(kb_bad, "a" * 40, modules={}, cards={"坏卡": "broken"})

    # A card that already owns one of our five keys must stop the seed rather than
    # have the writer emit the key twice from two owners.
    kb_clash = _kb(tmp_path / "c4", [], ["占键卡"])
    (kb_clash / "占键卡" / "占键卡.md").write_text(
        "---\nkind: card\nsources:\n    - src/mod.py\n---\n\n### 角色\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="already uses our keys"):
        wiki_drift.plan_knowledge(kb_clash, "a" * 40, modules={}, cards={"占键卡": "clash"})

    # An empty tree and a missing tree are both refusals, and the second one is a
    # `RuntimeError`: `kb.iterdir()` used to raise `FileNotFoundError`, which is not
    # what Task 6's exit-2 path prints.
    empty_kb = tmp_path / "empty-kb"
    empty_kb.mkdir()
    with pytest.raises(RuntimeError, match="no knowledge pages planned"):
        wiki_drift.plan_knowledge(empty_kb, "a" * 40, modules={}, cards={})
    with pytest.raises(RuntimeError, match="no knowledge tree at"):
        wiki_drift.plan_knowledge(tmp_path / "nope", "a" * 40, modules={}, cards={})


def test_plan_knowledge_applies_the_reword_and_counts_it(tmp_path):
    needle = "b: 禁止字面量 '" + "".join(["World", "Quant"]) + "'"
    kb = _kb(tmp_path, [], [])
    d = kb / "父"
    d.mkdir(parents=True)
    (d / "_module.yaml").write_text("key: x\n", encoding="utf-8")
    for face in wiki_drift.FACE_NAMES:
        (d / face).write_text(f"# {face}\n\n内容\n", encoding="utf-8")
    (d / "架构设计.md").write_text(f"# 架构\n\n{needle}；c: 下一句\n", encoding="utf-8")
    plans = wiki_drift.plan_knowledge(kb, "a" * 40, modules={"父": "ci-gates"}, cards={})
    arch = next(p for p in plans if p.label == "modules/ci-gates/architecture.md")
    assert arch.reworded is True
    assert needle not in arch.body.decode("utf-8")
    assert "禁止商标字面量" in arch.body.decode("utf-8")


# ---------------------------------------------------------------------------
# M2 seeding: cmd_seed (dry-run by default, per-body reconciliation, ledger copy)
# ---------------------------------------------------------------------------


def _seedable(tmp_path: Path, monkeypatch) -> tuple[Path, Path]:
    """An export with 2 topic pages + a 1-module/1-card knowledge tree + a 2-row
    ledger, and a repo-shaped target.

    The slug maps are monkeypatched rather than left at the real 6-module/9-card
    constants: `cmd_seed` calls `plan_knowledge(kb, snapshot)` with `modules=None`,
    which resolves `MODULE_SLUGS` at call time, so an unpatched fixture dies on
    `unmapped module dirs: ['父']` before writing a byte. Patching is also what pins
    the arithmetic the assertions read: 2 topics + 5 faces + 1 card = 8 pages, and
    the 5 faces carry no `<cite>` (measured: 0 `file://` refs in the whole knowledge
    tree), so `no_sources` starts at 5.
    """
    export = _export(tmp_path)
    # `main()` calls `apply_wiki_root`, which re-points the six path globals at the
    # tmp target. Snapshot them first so the mutation dies with the case instead of
    # leaking into whatever runs next (the same hygiene as
    # `test_apply_wiki_root_repoints_the_five_globals`).
    for name in ("REPO", "WIKI", "CONTENT", "META", "UPDATE_DIR", "LEDGER", "wiki_root"):
        monkeypatch.setattr(wiki_drift, name, getattr(wiki_drift, name))
    # Measured on the real export: 0 of the 450 topic pages and 0 of the 39 knowledge
    # pages contain a CR. `_export`/`_kb` write with `Path.write_text`, which
    # translates `\n` to the platform newline, so on a CRLF checkout the fixture would
    # seed `\r\n` prose and the seeded page's no-CR assertion would be reading the
    # fixture's writer rather than the seed's. Re-write the fixture bytes to LF so the
    # assertion pins what it says it pins on every platform. `_export` itself stays
    # CRLF on purpose — Task 4's byte-fidelity tripwire needs the CRs to bite.
    for page in sorted((export / "zh" / "content").rglob("*.md")):
        page.write_bytes(page.read_bytes().replace(b"\r\n", b"\n"))
    monkeypatch.setattr(wiki_drift, "REPO", tmp_path)
    monkeypatch.setattr(wiki_drift, "MODULE_SLUGS", {"父": "repo-root"})
    monkeypatch.setattr(wiki_drift, "CARD_SLUGS", {"业务术语表": "glossary"})
    kb = _kb(tmp_path, ["父"], ["业务术语表"])
    dst_kb = export / wiki_drift.LEGACY_KNOWLEDGE
    dst_kb.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(kb, dst_kb)
    for page in sorted(dst_kb.rglob("*.md")):
        page.write_bytes(page.read_bytes().replace(b"\r\n", b"\n"))
    (export / "update" / "ledger.jsonl").write_text(
        json.dumps({"page": "前端应用/页一.md", "head": "c" * 40,
                    "sha_after": "d" * 64, "note": "n", "at": "t"}) + "\n"
        + json.dumps({"page": "前端应用/页二.md", "head": "c" * 40,
                      "sha_after": "e" * 64, "note": "n", "at": "t"}) + "\n",
        encoding="utf-8",
    )
    target = tmp_path / "repowiki"
    target.mkdir()
    return export, target


def test_seed_defaults_to_dry_run_then_is_idempotent(tmp_path, monkeypatch, capsys):
    export, target = _seedable(tmp_path, monkeypatch)
    argv = ["--wiki-root", str(target), "seed", "--from", str(export), "--snapshot", "a" * 40]
    assert main(argv) == 0
    assert not list(target.rglob("*.md")), "dry-run must not write a byte"
    assert not (target / "ledger.jsonl").exists(), "the ledger is a byte too"
    assert "dry-run: nothing written" in capsys.readouterr().out
    assert main([*argv, "--apply"]) == 0
    # `checked` is Task 10's "nothing was absorbed" counter: it increments once per
    # plan that reaches `apply_page_plan`, before the skip/write branches, so the
    # first real apply must read 8 — the same 8 the `written` list counts two lines
    # later, from the other side of the assertion.
    assert "checked=8" in capsys.readouterr().out, "first --apply tally"
    written = sorted(p.as_posix() for p in target.rglob("*.md"))
    assert len(written) == 8, written  # 2 topics + 5 faces + 1 card
    before = {p: p.read_bytes() for p in target.rglob("*.md")}
    # re-running --apply is what a later operator actually does; it must be a no-op
    assert main([*argv, "--apply"]) == 0
    assert {p: p.read_bytes() for p in target.rglob("*.md")} == before, "not idempotent"
    assert "pages_written=0 pages_skipped=8" in capsys.readouterr().out


def test_seed_reconciles_body_bytes(tmp_path, monkeypatch, capsys):
    export, target = _seedable(tmp_path, monkeypatch)
    assert main(["--wiki-root", str(target), "seed", "--from", str(export),
                 "--snapshot", "a" * 40, "--apply"]) == 0
    page = target / "topics" / "前端应用" / "页一.md"
    src = export / "zh" / "content" / "前端应用" / "页一.md"
    src_text = src.read_text(encoding="utf-8")
    assert page.read_text(encoding="utf-8").endswith(src_text), "frontmatter only, prose verbatim"
    # The leg above reads *text* on both sides, and universal newlines make a CR the
    # seed added invisible: `read_text` would strip it from the page and from the
    # source alike, and the assertion would still hold. These are the bytes the 426
    # ledger rows hash, so compare them (`_seedable` has rewritten the fixture to LF,
    # which is what the real export measures as, so this holds byte-for-byte).
    assert page.read_bytes().endswith(src.read_bytes()), "verbatim at the byte level too"
    assert page.read_bytes().startswith(b"---\n") and b"\r\n" not in page.read_bytes()
    tally = capsys.readouterr().out
    assert "sha_mismatch=0" in tally and "reworded=0" in tally
    # the 5 module faces carry no <cite> block at all; the 2 topics and the card all
    # have sources, so no_sources must be exactly 5 and origins splits 2/5/1.
    assert "no_sources=5" in tally, tally
    assert "origins={card:1, module:5, topic:2}" in tally, tally


def test_seed_copies_the_ledger_byte_identically(tmp_path, monkeypatch):
    export, target = _seedable(tmp_path, monkeypatch)
    assert main(["--wiki-root", str(target), "seed", "--from", str(export),
                 "--snapshot", "a" * 40, "--apply"]) == 0
    src = (export / "update" / "ledger.jsonl").read_bytes()
    dst = (target / "ledger.jsonl").read_bytes()
    assert dst == src, "426 rows are the only un-reconstructable asset this repo has"
    rows = wiki_drift.load_ledger()
    assert sorted(rows) == ["前端应用/页一.md", "前端应用/页二.md"]
    for rel in rows:
        assert (target / "topics" / rel).is_file(), "every row must resolve in the new tree"


def test_seed_refuses_an_ide_layout_target(tmp_path, monkeypatch, capsys):
    """Seeding into the export would rewrite the source in place and make the next
    run's diff meaningless."""
    export, _ = _seedable(tmp_path, monkeypatch)
    # Snapshot the whole export, not one page: the refusal's promise is that the
    # source tree is untouched, and a `topics/` dir or a `ledger.jsonl` appearing
    # beside `zh/content` breaks that promise just as surely as a rewritten page.
    before = {p.relative_to(export).as_posix(): p.read_bytes()
              for p in sorted(export.rglob("*")) if p.is_file()}
    assert main(["--wiki-root", str(export), "seed", "--apply"]) == 2
    err = capsys.readouterr().err
    assert "refusing to seed into an ide-layout root" in err
    # The message must name the *refused target*. `--from` defaults to the legacy
    # export, and interpolating that path here would blame a repo-layout source
    # directory for an IDE-layout target — the opposite of what the operator needs.
    assert str(export) in err, err
    assert {p.relative_to(export).as_posix(): p.read_bytes()
            for p in sorted(export.rglob("*")) if p.is_file()} == before, \
        "a refused seed must leave the export byte-for-byte as it found it"


def test_seed_reports_a_missing_reword_needle(tmp_path, monkeypatch, capsys):
    """The exception must be countable, or 'the one reworded page' doubles as the
    excuse for a page that never got seeded (spec §12)."""
    export, target = _seedable(tmp_path, monkeypatch)
    monkeypatch.setattr(wiki_drift, "REWORDS", {
        "modules/repo-root/overview.md": ("needle-not-present", "replacement")})
    assert main(["--wiki-root", str(target), "seed", "--from", str(export),
                 "--snapshot", "a" * 40, "--apply"]) == 2
    assert "reword for modules/repo-root/overview.md" in capsys.readouterr().err
    assert not list(target.rglob("*.md")), "a failed plan must not half-publish a tree"


def test_seed_counts_pages_without_sources(tmp_path, monkeypatch, capsys):
    """Delta form, so the counter is pinned to one page rather than to the fixture's
    face count: the same export seeds 5 source-less pages, adding one cite-free topic
    page makes it 6."""
    export, target = _seedable(tmp_path, monkeypatch)
    argv = ["--wiki-root", str(target), "seed", "--from", str(export),
            "--snapshot", "a" * 40, "--apply"]
    assert main(argv) == 0
    assert "no_sources=5" in capsys.readouterr().out
    (export / "zh" / "content" / "无引用.md").write_text("# 无引用\n\n散文\n", encoding="utf-8")
    assert main(argv) == 0
    assert "no_sources=6" in capsys.readouterr().out


def test_seed_counts_a_reword_that_actually_lands(tmp_path, monkeypatch, capsys):
    """`reworded` is a contract field (Task 10 reads the tally line), and a counter
    that is only ever asserted at 0 cannot be deleted. The existing needle test keys a
    label whose needle is *absent*, so it exercises `strip_reword`'s refusal, never the
    increment. `内容` occurs exactly once in every face body `_kb` writes and holds no
    newline, so both of `strip_reword`'s guards (count == 1, line count unchanged) stay
    satisfied and the reword is the real thing."""
    export, target = _seedable(tmp_path, monkeypatch)
    monkeypatch.setattr(wiki_drift, "REWORDS", {
        "modules/repo-root/overview.md": ("内容", "改写后的正文")})
    assert main(["--wiki-root", str(target), "seed", "--from", str(export),
                 "--snapshot", "a" * 40, "--apply"]) == 0
    out = capsys.readouterr().out
    assert "reworded=1" in out, out
    assert "reworded: modules/repo-root/overview.md" in out, out
    assert "sha_mismatch=0" in out, "a reworded body still reconciles against itself"
    page = target / "modules" / "repo-root" / "overview.md"
    assert "改写后的正文" in page.read_text(encoding="utf-8"), "the reword landed on disk"


def test_seed_flags_a_body_that_landed_different(tmp_path, monkeypatch, capsys):
    """The post-write `endswith(plan.body)` is the per-file reconciliation spec §12
    asks for, and it is the only thing that can raise `sha_mismatch` — so it needs a
    measured divergence, not a 0 read off a clean run. `write_bytes` is patched to
    append one byte to every `.md` write and to nothing else: mangle a non-`.md` write
    too and `copy_ledger`'s own byte-identity guard raises first, turning this into the
    exit-2 path instead of the exit-1 the reconciliation is supposed to produce."""
    export, target = _seedable(tmp_path, monkeypatch)
    real_write_bytes = Path.write_bytes

    def one_byte_more(self, data: bytes) -> int:
        return real_write_bytes(self, data + b"X" if self.suffix == ".md" else data)

    monkeypatch.setattr(Path, "write_bytes", one_byte_more)
    rc = main(["--wiki-root", str(target), "seed", "--from", str(export),
               "--snapshot", "a" * 40, "--apply"])
    out = capsys.readouterr().out
    assert "sha_mismatch=8" in out, out
    assert "pages_written=0" in out, "a mismatched page is not a published one"
    assert rc == 1, "a body that landed different is a failed seed, not a green run"


def test_seed_reads_the_layout_off_the_disk_not_the_global(tmp_path, monkeypatch, capsys):
    """`wiki_root` is a global, and `stamp_frontmatter` re-reads the disk precisely
    because a stale one must not decide who writes the IDE export. Seed is this
    milestone's highest-consequence writer, so it holds the same line: with a global
    that claims `repo` and a `WIKI` that is shaped like the export, the run still
    refuses."""
    export, _ = _seedable(tmp_path, monkeypatch)
    monkeypatch.setattr(wiki_drift, "WIKI", export)
    monkeypatch.setattr(wiki_drift, "wiki_root",
                        wiki_drift.WikiRoot(root=export, layout="repo"))
    assert wiki_drift.cmd_seed(
        _ns(from_root=str(export), snapshot="a" * 40, apply=True)) == 2
    assert "refusing to seed into an ide-layout root" in capsys.readouterr().err
    assert not (export / "topics").exists(), "and it refused before writing"


def test_copy_ledger_refuses_a_missing_export_ledger(tmp_path, monkeypatch):
    """The ledger is the one asset the seed cannot reconstruct, so its absence is the
    one failure that raises rather than tallies — and nothing pinned the string the
    operator of Task 10 reads when the export moved out from under the run."""
    wiki = tmp_path / "wiki"
    wiki.mkdir()
    monkeypatch.setattr(wiki_drift, "WIKI", wiki)
    with pytest.raises(RuntimeError, match="ledger missing from the export"):
        wiki_drift.copy_ledger(tmp_path / "no-such-export", dry_run=False)
    assert not (wiki / "ledger.jsonl").exists()


def test_copy_ledger_refuses_a_copy_that_landed_different(tmp_path, monkeypatch):
    """The ledger's mirror of the per-page reconciliation: write, re-read, compare,
    and raise — never publish a truncated 426-row history with a green exit code."""
    (tmp_path / "export" / "update").mkdir(parents=True)
    data = json.dumps({"page": "a.md", "head": "c" * 40, "sha_after": "d" * 64,
                       "note": "n", "at": "t"}).encode("utf-8") + b"\n"
    (tmp_path / "export" / "update" / "ledger.jsonl").write_bytes(data)
    wiki = tmp_path / "wiki"
    wiki.mkdir()
    monkeypatch.setattr(wiki_drift, "WIKI", wiki)
    real_write_bytes = Path.write_bytes

    def one_byte_more(self, payload: bytes) -> int:
        return real_write_bytes(self, payload + b"X" if self.parent == wiki else payload)

    monkeypatch.setattr(Path, "write_bytes", one_byte_more)
    with pytest.raises(RuntimeError, match="ledger copy is not byte-identical"):
        wiki_drift.copy_ledger(tmp_path / "export", dry_run=False)


def test_seed_stops_on_a_missing_export_ledger(tmp_path, monkeypatch, capsys):
    """The unit test above proves the raise; this one proves `cmd_seed` reaches it and
    that the CLI turns it into exit 2 with the message on stderr, not a traceback.
    Measured, and deliberately not asserted either way: unlike a failed *plan* (see
    `test_seed_reports_a_missing_reword_needle`, which writes nothing), this failure
    lands after the write loop, so the pages are already on disk when it raises — the
    ledger is what does not get published."""
    export, target = _seedable(tmp_path, monkeypatch)
    (export / "update" / "ledger.jsonl").unlink()
    assert main(["--wiki-root", str(target), "seed", "--from", str(export),
                 "--snapshot", "a" * 40, "--apply"]) == 2
    err = capsys.readouterr().err
    assert "ledger missing from the export" in err, err
    assert not (target / "ledger.jsonl").exists()


# ---------------------------------------------------------------------------
# tree_baseline: the tree-wide fallback that retires the mandatory --baseline
# ---------------------------------------------------------------------------


def test_tree_baseline_is_the_modal_page_verified_at(repo_wired):
    """The fallback the tree agrees on. Ignoring `vouch` here is deliberate: that
    gate decides whether a page's own stamp may *outrank* its ledger row, while this
    value is only the tree-wide fallback for pages with no per-page claim — which,
    right after seeding, is every page, and their `verified_at` is this same commit."""
    # A majority needs pages to hold one. The shared `repo_tree` fixture ships
    # exactly one topic page and 77 repo-layout cases read that shape, so the extra
    # pages are created by the cases that need them, never by editing the fixture;
    # these fixtures are function-scoped, so this writes a throwaway tmp dir.
    for name in ("页二.md", "页三.md"):
        (repo_wired["content"] / "前端应用" / name).write_text(
            f"# {name[:-3]}\n\n## 简介\n", encoding="utf-8"
        )
    pages = sorted((repo_wired["wiki"] / "topics").rglob("*.md"))
    assert len(pages) >= 3, "a mode over a single page is not a mode"
    wiki_drift.update_frontmatter(pages[0], verified_at="a" * 40, vouch="applied-only")
    wiki_drift.update_frontmatter(pages[1], verified_at="a" * 40, vouch="applied-only")
    wiki_drift.update_frontmatter(pages[2], verified_at="b" * 40, vouch="all")
    assert wiki_drift.tree_baseline() == "a" * 40


def test_tree_baseline_is_deterministic_under_a_tie(repo_wired):
    """A tie must not fall out of filesystem walk order (spec §5.3's determinism
    requirement applies to every derived value, not just INDEX.md)."""
    page_dir = repo_wired["content"] / "前端应用"
    topics = repo_wired["wiki"] / "topics"

    def page_stamps() -> dict[str, str]:
        """The stamped pages as they sit on disk right now, name -> revision.
        `tree_baseline()` re-reads the disk on every call, so the only way to change
        its inputs is to change the disk."""
        out: dict[str, str] = {}
        for path in topics.rglob("*.md"):
            fm = wiki_drift.read_frontmatter(path)
            if fm and fm.get("verified_at"):
                out[path.name] = str(fm["verified_at"])
        return out

    # Three single-vote stamps over three votes: that is the tie. A majority needs
    # pages to hold one and the shared `repo_tree` fixture ships exactly one topic page
    # (77 repo-layout cases read that shape), so these cases create their own pages and
    # never edit the fixture; the ASCII names exist so the rename below can invert the
    # order the walk enumerates them in. The fixture's own page stays unstamped — an
    # absent frontmatter casts no vote either way.
    for name, rev in (("tie-1.md", "c"), ("tie-2.md", "a"), ("tie-3.md", "b")):
        (page_dir / name).write_text(f"# {name[:-3]}\n\n## 简介\n", encoding="utf-8")
        wiki_drift.update_frontmatter(page_dir / name, verified_at=rev * 40)

    layout1 = page_stamps()
    assert sorted(layout1) == ["tie-1.md", "tie-2.md", "tie-3.md"], layout1
    # Name order deliberately disagrees with revision order: the page a name-ordered
    # walk meets first carries the lexicographically LAST stamp, which is exactly the
    # answer a walk-order tie-break returns instead of the one taken by revision.
    assert layout1["tie-1.md"] == "c" * 40
    first = wiki_drift.tree_baseline()
    assert first == "a" * 40 == min(layout1.values()), "ties break by revision, not order"

    # And now change what the walk actually sees: renaming inverts the on-disk name
    # order, so the first page met carries `b` instead of `c`. A tie-break that reads
    # insertion/walk order has to flip between the two calls; the revision tie-break
    # answers `a` in both, and in either name direction.
    for old, new in (
        ("tie-1.md", "zzz-c.md"),
        ("tie-2.md", "yyy-a.md"),
        ("tie-3.md", "xxx-b.md"),
    ):
        (page_dir / old).rename(page_dir / new)
    layout2 = page_stamps()
    assert sorted(layout2) == ["xxx-b.md", "yyy-a.md", "zzz-c.md"], (
        f"the rename must invert the on-disk order, not no-op it: {layout2}"
    )
    assert layout2["xxx-b.md"] == "b" * 40
    assert wiki_drift.tree_baseline() == first == "a" * 40


def test_tree_baseline_ignores_non_hex_and_missing_blocks(repo_wired):
    pages = sorted((repo_wired["wiki"] / "topics").rglob("*.md"))
    # One page whose frontmatter carries a non-commit marker, one with no frontmatter
    # at all: both branches of the skip get an inhabitant, so neither stays green by
    # never having been reached.
    (repo_wired["content"] / "前端应用" / "无块.md").write_text("# 无块\n", encoding="utf-8")
    wiki_drift.update_frontmatter(pages[0], verified_at="Q0DeR-MaG1C")
    assert wiki_drift.tree_baseline() is None, "no IDE metadata in the repo layout"


def test_report_without_a_baseline_works_after_seeding(repo_wired, capsys):
    """M2's whole point: the baseline travels with the pages, so `report` needs no
    40-hex incantation once the tree is seeded."""
    # Non-vacuity, measured on the same tree one statement earlier: unsed, this root
    # has no metadata file either, so the 0 below can only come from the page stamps.
    assert main(["--wiki-root", str(repo_wired["wiki"]), "report", "--json"]) == 2
    pages = sorted((repo_wired["wiki"] / "topics").rglob("*.md"))
    for page in pages:
        wiki_drift.update_frontmatter(page, verified_at=repo_wired["base"], vouch="applied-only")
    assert main(["--wiki-root", str(repo_wired["wiki"]), "report", "--json"]) == 0
    # And the human-readable run says where the number came from: `tree`, not a
    # `--baseline` nobody passed.
    assert main(["--wiki-root", str(repo_wired["wiki"]), "report"]) == 0
    assert f"baseline  {repo_wired['base']}  (tree: modal page verified_at)" in (
        capsys.readouterr().out
    )


def test_report_labels_an_operator_override_as_an_override(repo_wired, capsys):
    """Provenance has to name the value's real source, and here there is no room for
    the label to hedge: this root has no page stamps and no IDE metadata, so the only
    thing that can lift the run out of exit 2 is `--baseline`. A line still claiming
    `modal page verified_at` is not loose wording on this tree, it is false — the tree
    is empty of stamps by the assertion above."""
    pages = sorted((repo_wired["wiki"] / "topics").rglob("*.md"))
    assert pages and all(not wiki_drift.read_frontmatter(p) for p in pages)
    assert wiki_drift.tree_baseline() is None, "nothing in the tree to fall back on"
    assert main(["--wiki-root", str(repo_wired["wiki"]), "report"]) == 2
    assert main(["--wiki-root", str(repo_wired["wiki"]), "report",
                 "--baseline", repo_wired["base"]]) == 0
    out = capsys.readouterr().out
    assert f"baseline  {repo_wired['base']}  (--baseline override (operator-supplied))" in out
    # The whole point of the branch: an override is by definition not the page stamp,
    # so the old label's suffix must be gone rather than merely preceded by a name.
    assert "modal page verified_at" not in out, out


def test_ide_layout_still_falls_back_to_metadata(wired):
    """The 77+120 existing cases run against the IDE fixture, whose pages carry no
    frontmatter. Falling back keeps `test_unreachable_metadata_baseline_*` honest
    instead of silently repointing it."""
    assert wiki_drift.tree_baseline() == wired["base"]
    # And the ordering that bounds that fallback: the moment a page on this very tree
    # carries a stamp, the page wins and the metadata stops being read. Without the
    # second half the fallback could quietly outrank a real claim.
    page = wired["content"] / "前端应用" / "模块说明.md"
    wiki_drift.update_frontmatter(page, verified_at="a" * 40)
    assert wiki_drift.tree_baseline() == "a" * 40


def test_report_labels_the_metadata_fallthrough(wired, capsys):
    """The other false half of the old label. On an IDE-layout root no page carries a
    stamp, so `tree_baseline()` reached its last resort and the printed number came out
    of `repowiki-metadata.json` — while the line went on crediting a modal page stamp
    that does not exist on this tree. Same fixture and same report path as
    `test_report_writes_json_and_markdown`, read through the human printer."""
    pages = sorted(wired["content"].rglob("*.md"))
    assert pages and all(not wiki_drift.read_frontmatter(p) for p in pages)
    assert wiki_drift.tree_baseline() == metadata_baseline() == wired["base"]
    assert main(["report"]) == 0
    out = capsys.readouterr().out
    assert f"baseline  {wired['base']}  (metadata: repowiki-metadata.json)" in out, out
    assert "modal page verified_at" not in out, out


# ---------------------------------------------------------------------------
# M2 hand-authoring: modules/pine-engine (5 faces with no source in the export)
# ---------------------------------------------------------------------------

PINE_FACES = ["overview", "architecture", "tech-stack", "conventions", "commands"]


def test_pine_engine_faces_are_grounded_in_real_files():
    """Spec §11: these five pages have no source in the export, so the only thing
    keeping them from being folklore is a `sources` list that resolves on disk and
    a body long enough to be read. `anchors` must stay `open` — hand-writing a page
    is not the same as verifying every cite in it."""
    base = REAL_REPO / "repowiki" / "modules" / "pine-engine"
    for face in PINE_FACES:
        page = base / f"{face}.md"
        assert page.is_file(), page
        assert len(page.read_bytes()) > 800, page
        fm = wiki_drift.read_frontmatter(page)
        assert fm is not None and fm["page"] == f"modules/pine-engine/{face}.md"
        assert fm["sources"], page
        assert fm["anchors"] == "open" and fm["vouch"] == "applied-only"
        assert wiki_drift.HEX40_RE.match(str(fm["verified_at"])), fm
        for src in fm["sources"]:
            assert (REAL_REPO / src).is_file(), f"{page.name} cites a missing file: {src}"
        # a `sources` list that resolves but says nothing is still a false claim
        assert len(fm["sources"]) >= 2, f"{page.name} cites {fm['sources']}"


def test_pine_engine_is_the_seventh_module_and_faces_are_complete():
    """CONTROLLER RULING 4 (Task 10 widening): this asserted a 1-slug equality at
    Task 8 because the other 6 module dirs were published only by the real seed,
    which had not run. Now that the seed has landed, `repowiki/modules/` holds all
    7 — `pine-engine` (hand-authored) plus the 6 slugs `MODULE_SLUGS` maps — and
    this is the full 7-slug equality, i.e. the post-seed state. A stray or misnamed
    sibling dir, or a missing face in any one of them, goes red here."""
    base = REAL_REPO / "repowiki" / "modules"
    slugs = {p.name for p in base.iterdir() if p.is_dir()}
    assert slugs == {"pine-engine"} | set(wiki_drift.MODULE_SLUGS.values()), slugs
    for slug in slugs:
        assert sorted(p.name for p in (base / slug).glob("*.md")) == \
            sorted(f"{f}.md" for f in PINE_FACES), slug


def test_seed_does_not_touch_hand_authored_pages(tmp_path, monkeypatch):
    """`plan_*` enumerates source dirs, so the authored module can only be written
    by hand. Prove the seed's plan never yields a pine-engine path — the reverse
    would let a re-seed overwrite prose nobody re-read."""
    export, target = _seedable(tmp_path, monkeypatch)
    plans = (wiki_drift.plan_topics(export, "a" * 40)
             + wiki_drift.plan_knowledge(export / wiki_drift.LEGACY_KNOWLEDGE, "a" * 40,
                                         modules={"父": "repo-root"},
                                         cards={"业务术语表": "glossary"}))
    assert not [p for p in plans if "pine-engine" in p.label]
    assert target.is_dir()  # the fixture really is the export this plan reads


# The commit the IDE export was generated at, and the `verified_at` every seeded page
# carries (`tree_baseline()`'s modal value over the shipped tree, measured 489 of 494).
# 5 hand-authored `modules/pine-engine/` faces are stamped later, at `b19b6578…`.
SEEDING_SNAPSHOT = "7fdffa31a0d6ff54d236db3dea6adaf8d1ca6709"


def test_seeded_tree_is_not_an_empty_set():
    """'All 494 pages parsed' over a directory holding 1 README is the exact false
    green this repo has now documented three times.

    CONTROLLER RULING 1: scope to the three PAGE directories rather than
    name-excluding. The brief's `{README.md, INDEX.md}` exclusion set is not enough
    for the tree this task creates, because `repowiki/drift/DRIFT.md` is also not a
    wiki page (and has no frontmatter) — name-excluding would count it and land it
    in `missing`. Dir-scoping excludes all three for the right reason: a top-level
    file has `parts[0] == "README.md"`, and a report has `parts[0] == "drift"`.

    The `vouch` clause states the durable invariant the seeding actually claimed, not
    a snapshot of a moving tree. `mark` without `--partial` writes `vouch: "all"` AND
    rewrites `verified_at` to HEAD, so a live count of `all` measures whether M5 has
    started: the final review reproduced this assertion going red on the first
    legitimate stamp (`assert 1 == 0`), in the same test that carries the anti-empty-set
    canary. What seeding promised is narrower — no page vouches for all its cites
    **while still stamped at the seeding snapshot**, because that pairing is a claimed
    re-reading nobody did.
    """
    tree = REAL_REPO / "repowiki"
    pages = sorted(p for p in tree.rglob("*.md")
                   if p.relative_to(tree).parts[0] in {"topics", "modules", "cards"})
    assert len(pages) == 494, len(pages)          # 450 topics + 35 module faces + 9 cards
    with_sources = [p for p in pages if (wiki_drift.read_frontmatter(p) or {}).get("sources")]
    assert len(with_sources) == 463, len(with_sources)   # 494 − 31 measured no_sources
    missing = [p for p in pages if wiki_drift.read_frontmatter(p) is None]
    assert missing == [], missing[:3]
    blocks = [wiki_drift.split_frontmatter(wiki_drift.read_page_text(p))[0] for p in pages]
    assert all(fm and fm["verified_at"] and fm["page"] for fm in blocks), "every page carries a baseline"
    unearned = [
        p.relative_to(tree).as_posix()
        for p, fm in zip(pages, blocks)
        if fm["vouch"] == "all" and fm["verified_at"] == SEEDING_SNAPSHOT
    ]
    assert unearned == [], f"`vouch: all` at the seeding stamp is a re-reading nobody did: {unearned[:3]}"


# ---------------------------------------------------------------------------
# M2 contract: repowiki/README.md is the only place these tables are written down
# ---------------------------------------------------------------------------


def test_readme_maps_every_seeded_name():
    """The tables are the only place a human learns that `modules/ci-gates/` used to
    be `…/CI 流水线与安全门禁脚本/架构设计.md`. One-directional on purpose: every
    slug/face/Chinese-name the CODE knows must appear in the README, so renaming a
    value in wiki_drift.py without updating the table goes red. The reverse (a stale
    row left in the table for a name already gone from the code) is NOT detected here
    — that is a human cross-read, and the README says so rather than claiming more."""
    text = (REAL_REPO / "repowiki" / "README.md").read_text(encoding="utf-8")
    for slug in set(wiki_drift.MODULE_SLUGS.values()) | {"pine-engine"}:
        assert f"`{slug}`" in text or f"/{slug}" in text, slug
    for slug in wiki_drift.CARD_SLUGS.values():
        assert f"`{slug}`" in text or f"cards/{slug}" in text, slug
    for src, dst in wiki_drift.FACE_NAMES.items():
        assert src in text and dst in text, (src, dst)
    for name in wiki_drift.MODULE_SLUGS:                 # 中文源名必须也能查到
        assert name.split("/")[-1] in text, name
    assert wiki_drift.EXPORT_ARCHIVE in text


def test_readme_states_the_conventions_a_reader_will_otherwise_violate():
    text = (REAL_REPO / "repowiki" / "README.md").read_text(encoding="utf-8")
    for needle in ("不是 `wiki/`", "topics/", "modules/", "cards/", "ledger.jsonl",
                   "verified_at", "applied-only", "M5", "ci_grep_gates.sh",
                   "./.qoder/", "--baseline"):
        assert needle in text, needle


# ---------------------------------------------------------------------------
# C-1: `--page` cannot take the tool outside the active root's content tree
# ---------------------------------------------------------------------------
#
# `mark --page ../../victim.md` used to return rc=0: it rewrote a file that is not a
# wiki page, stamped `vouch: "all"` plus a `verified_at` onto a page nobody read, and
# appended the escaped string as a ledger key. In the real repo that same spelling
# reaches upstream's `wiki/*.md`, which is the one rule that outranks this milestone.
# Before this section, nothing in the suite passed a `..` component to any verb.


def _plant_victims(repo_wired) -> dict[str, Path]:
    """Two real files outside `CONTENT`, at the depths a `--page` argument reaches.

    `root/wiki/victim.md` stands in for upstream's public documentation site — the
    same relative distance (`../../wiki/<page>.md`) as the review's sandbox probe.
    `wiki/victim.md` is inside the root but above `topics/`: the property being
    enforced is containment in the *content tree*, not merely containment in the repo.
    """
    root, wiki = repo_wired["root"], repo_wired["wiki"]
    upstream = root / "wiki" / "victim.md"
    upstream.parent.mkdir(parents=True, exist_ok=True)
    upstream.write_text("# 上游文档站的一页\n\n这页不该被本工具改写。\n", encoding="utf-8")
    above_content = wiki / "victim.md"
    above_content.write_text("# 根内、内容树外的一页\n\n同样不该被改写。\n", encoding="utf-8")
    return {"upstream": upstream, "above_content": above_content}


def _victim_bytes(victims: dict[str, Path]) -> dict[str, str]:
    return {key: path.read_bytes().hex() for key, path in victims.items()}


@pytest.mark.parametrize("arg, which", [
    ("../../wiki/victim.md", "upstream"),          # the probe the review ran
    ("..\\..\\wiki\\victim.md", "upstream"),       # Windows separators
    ("./../../wiki/victim.md", "upstream"),        # the `./`-prefixed form
    ("a/../../wiki/victim.md", "upstream"),        # hop in, two hops out
    ("../../wiki/../wiki/victim.md", "upstream"),  # disguised
    ("..\\victim.md", "above_content"),
    ("../victim.md", "above_content"),             # inside the root, outside CONTENT
    ("topics/../victim.md", "above_content"),      # re-enters the root, not the tree
])
def test_mark_refuses_an_escaping_page_argument(repo_wired, capsys, arg, which):
    """rc=2, the victim's bytes intact, no ledger row, no `update/`/`drift/` created."""
    victims = _plant_victims(repo_wired)
    before = _victim_bytes(victims)
    assert main(["mark", "--page", arg, "-m", "must never land"]) == 2
    err = capsys.readouterr().err
    assert arg in err, err                       # names the offending argument
    assert str(repo_wired["content"]) in err, err  # names the root it must stay inside
    assert _victim_bytes(victims) == before, "a refused --page must not touch a byte"
    assert not wiki_drift.LEDGER.exists(), "a refused --page must not append the ledger"
    assert not wiki_drift.UPDATE_DIR.exists()


@pytest.mark.parametrize("spell", ["path", "posix"])
def test_mark_refuses_an_absolute_page_argument(repo_wired, capsys, spell):
    """Both absolute spellings: pathlib lets an absolute arg replace the base outright."""
    victims = _plant_victims(repo_wired)
    before = _victim_bytes(victims)
    absolute = victims["upstream"]
    arg = str(absolute) if spell == "path" else absolute.as_posix()
    assert main(["mark", "--page", arg, "-m", "must never land"]) == 2
    err = capsys.readouterr().err
    assert arg in err and str(repo_wired["content"]) in err, err
    assert _victim_bytes(victims) == before
    assert not wiki_drift.LEDGER.exists()


def test_mark_still_writes_a_deeply_nested_cjk_page(repo_wired):
    """The other half of the guard: containment must not cost a legitimate page.

    Three CJK levels, the shape of the real ledger keys
    (`回测引擎/投资组合优化器/最大分散化优化器.md`), marked through the same command.
    """
    page = repo_wired["content"] / "回测引擎" / "投资组合优化器" / "最大分散化优化器.md"
    page.parent.mkdir(parents=True, exist_ok=True)
    page.write_text(
        "# 最大分散化优化器\n\n<cite>\n**本文引用的文件**\n"
        "- [alpha](file://src/mod.py#L9-L10)\n</cite>\n\n## 简介\n",
        encoding="utf-8",
    )
    rel = "回测引擎/投资组合优化器/最大分散化优化器.md"
    assert main(["mark", "--page", rel, "-m", "重读完毕"]) == 0
    fm = wiki_drift.read_frontmatter(page)
    assert fm is not None and fm["page"] == rel, fm
    assert fm["verified_at"] == repo_wired["head"] and fm["vouch"] == "all"
    assert wiki_drift.load_ledger()[rel].note == "重读完毕"


def test_mark_still_accepts_the_dotslash_spelling(repo_wired):
    """`./x/y.md` is a legitimate prefix, not an escape: it must keep working."""
    rel = "./前端应用/模块说明.md"
    assert main(["mark", "--page", rel, "-m", "同一页的另一种写法"]) == 0
    # The ledger key is the normalised path, so the two spellings stay one identity.
    assert set(wiki_drift.load_ledger()) == {"前端应用/模块说明.md"}


def test_report_refuses_an_escaping_page_argument(repo_wired, capsys):
    victims = _plant_victims(repo_wired)
    before = _victim_bytes(victims)
    # `--baseline` because the repo-shaped fixture has no IDE metadata: without a
    # baseline `build()` exits 2 earlier, and the guard would never be reached.
    assert main(["report", "--page", "../../wiki/victim.md", "--baseline", repo_wired["base"]]) == 2
    err = capsys.readouterr().err
    assert "../../wiki/victim.md" in err and str(repo_wired["content"]) in err, err
    assert _victim_bytes(victims) == before
    assert not (repo_wired["wiki"] / "drift" / "DRIFT.md").exists()
    assert not (repo_wired["wiki"] / "drift" / "drift.json").exists()


def test_reanchor_refuses_an_escaping_page_argument(repo_wired, capsys):
    victims = _plant_victims(repo_wired)
    before = _victim_bytes(victims)
    assert main(["reanchor", "--page", "../victim.md", "--shifts", "--apply"]) == 2
    assert "../victim.md" in capsys.readouterr().err
    assert _victim_bytes(victims) == before
    assert not wiki_drift.LEDGER.exists()


def test_collect_pages_refuses_escaping_needles_and_stays_home_otherwise(repo_wired):
    """What `collect_pages` could actually do before the guard, measured not assumed.

    It builds no path from the argument: it filters `CONTENT.rglob("*.md")` by
    substring, so an escaping needle could only ever match nothing (rc=2 via
    PageNotFound) and could not write outside. The guard still applies, because one
    rule for every `--page` spelling is cheaper to reason about than two, and the
    positive half below pins that it cannot return a path outside the content tree.
    """
    _plant_victims(repo_wired)
    for needle in ("../victim.md", "..\\victim.md", "../../wiki/victim.md",
                   str(repo_wired["root"] / "wiki" / "victim.md")):
        with pytest.raises(PageOutsideRoot):
            collect_pages(needle)
    for page in collect_pages("前端应用"):
        assert page.resolve().is_relative_to(repo_wired["content"].resolve())


# ---------------------------------------------------------------------------
# I-4: an IDE-layout root is a read-only snapshot, so `report` writes nothing into it
# ---------------------------------------------------------------------------#
# `EMPTY_TREE_HINT` and `--wiki-root`'s help both advertise the archived export as "a
# readable second root". Measured, `report` against it exited 0 AND wrote
# `update/DRIFT.md` + `update/drift.json` into the archive — an unrecoverable write
# into the one backup of the pre-M2 state, because `.qoder/` is in `.git/info/exclude`
# and git therefore cannot undo it. The reviewer's own probe left those two files
# behind; this pair of cases is what stops the tool from making more of them.


def _hold_path_globals(monkeypatch) -> None:
    """`main()` runs `apply_wiki_root`, which mutates the six path globals in place.

    Re-assigning each through `monkeypatch` is what makes the mutation die with the
    case (the same hygiene `_seedable` documents).
    """
    for name in ("REPO", "WIKI", "CONTENT", "META", "UPDATE_DIR", "LEDGER", "wiki_root"):
        monkeypatch.setattr(wiki_drift, name, getattr(wiki_drift, name))


def test_report_on_an_ide_root_writes_nothing(wired, monkeypatch, capsys):
    _hold_path_globals(monkeypatch)
    update = wired["wiki"] / "update"
    update.mkdir(parents=True, exist_ok=True)
    sentinel = update / "ledger.jsonl"
    sentinel.write_text(
        json.dumps({"page": "前端应用/模块说明.md", "head": "c" * 40,
                    "sha_after": "d" * 64, "note": "归档里的既有行", "at": "t"},
                   ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    before_bytes = {p.name: p.read_bytes() for p in update.iterdir()}

    assert main(["--wiki-root", str(wired["wiki"]), "report"]) == 0

    assert wiki_drift.wiki_root.layout == "ide", "the CLI must have read the archive shape"
    assert {p.name: p.read_bytes() for p in update.iterdir()} == before_bytes, (
        "an IDE-layout root keeps exactly the files it had — nothing added, nothing rewritten"
    )
    assert not (update / "DRIFT.md").exists() and not (update / "drift.json").exists()
    out = capsys.readouterr().out
    assert "read-only snapshot" in out and str(wired["wiki"]) in out, out
    # …and the report is still delivered: the summary lines are the whole point.
    assert "pages     2 total" in out, out


def test_report_on_a_repo_root_still_writes_both_reports(repo_wired, monkeypatch, capsys):
    """The other side of the rule: untracking `drift/` (Fix 3) must not stop `report`
    from producing its files in the tracked layout."""
    _hold_path_globals(monkeypatch)
    assert main(["--wiki-root", str(repo_wired["wiki"]), "report",
                 "--baseline", repo_wired["base"]]) == 0
    drift = repo_wired["wiki"] / "drift"
    assert (drift / "DRIFT.md").is_file() and (drift / "drift.json").is_file()
    out = capsys.readouterr().out
    assert str(drift / "DRIFT.md") in out, out
    assert "read-only snapshot" not in out


# ---------------------------------------------------------------------------
# I-3: `repowiki/drift/` is derived output, so it is not tracked
# ---------------------------------------------------------------------------


def _ls_files(*args: str) -> list[str]:
    proc = subprocess.run(
        ["git", "-C", str(REAL_REPO), "-c", "core.quotepath=off", *args],
        capture_output=True, text=True, encoding="utf-8", errors="replace",
    )
    assert proc.returncode == 0, f"{args} -> rc={proc.returncode}: {proc.stderr}"
    return [line for line in proc.stdout.splitlines() if line.strip()]


def test_drift_reports_are_derived_and_not_tracked():
    """`report` rewrites `DRIFT.md` + `drift.json` on every run.

    Tracking them (as M2 did) meant the documented headline command left two ` M`
    entries in `git status` forever — churn with no owner for a fork whose whole rule
    is a clean upstream sync — and whatever got committed stated a HEAD and a water
    level that were already false (measured at the review: `uncovered 888` committed vs
    `1379` live). They are output, regenerable in one command from the tree they
    describe, so the tracked tree is the publication only.

    The ignore rule lives in `repowiki/.gitignore`, not the repository root's
    `.gitignore`, because that file is upstream-owned and this fork's binding rule is to
    leave it byte-for-byte alone.
    """
    assert _ls_files("ls-files", "repowiki/drift") == [], "derived reports must not be tracked"
    # `check-ignore -v` names the file and pattern that fired, so a rule deleted or
    # moved out of `repowiki/` cannot pass this quietly.
    provenance = _ls_files(
        "check-ignore", "-v", "repowiki/drift/DRIFT.md", "repowiki/drift/drift.json"
    )
    assert len(provenance) == 2, provenance
    for line in provenance:
        assert "repowiki/.gitignore" in line and "drift/" in line, line


def test_tracked_repowiki_tree_is_pages_plus_four_derivation_free_entries():
    """The publication's composition, re-measured rather than subtracted by hand.

    494 pages (pinned by `test_seeded_tree_is_not_an_empty_set`) plus four items that
    are neither pages nor derived: `/.gitattributes` (the LF pin the ledger hashes
    depend on), `/.gitignore` (keeps `drift/` out of the tree), `/README.md`,
    `/ledger.jsonl`. Adding a fifth tracked non-page file is a decision, and this is
    where it has to be made — the count is expressed from the two facts, so it cannot
    drift out of sync with the page count it is quoted next to.
    """
    names = _ls_files("ls-files", "repowiki")
    non_pages = sorted(
        n for n in names if n.split("/")[1] not in {"topics", "modules", "cards"}
    )
    assert non_pages == [
        "repowiki/.gitattributes",
        "repowiki/.gitignore",
        "repowiki/README.md",
        "repowiki/ledger.jsonl",
    ], non_pages
    pages = [n for n in names if n not in non_pages]
    assert len(pages) == 494, len(pages)
    assert len(names) == 494 + len(non_pages) == 498, len(names)


# ---------------------------------------------------------------------------
# M-4 + acceptance gate 6: M2's central property must stay re-checkable
# ---------------------------------------------------------------------------
#
# "The 450 seeded bodies are the archived export's bodies, byte for byte" was proven by
# one hand-run command whose script (`.qoder/tmp/audit_sweep_shape2.py`) still pointed at
# the emptied `.qoder/repowiki/zh/content` — so it printed `pages touched 0 | lines
# changed 0` and exited 0. That is this repo's documented false green on its own
# acceptance criterion, and M-4's larger half: no test asserted the archive exists, so
# `git clean -fdx` could delete a directory no commit protects and every constant-derived
# `EXPORT_ARCHIVE` assertion in the suite would stay green.
#
# These two cases do not `pytest.skip()` when the archive is missing. Red is the correct
# outcome: an absent archive means the seed's parent evidence is gone, which is exactly
# what a guard is supposed to say out loud, and a skip would make the deletion look like
# a passing suite.


ARCHIVE_CONTENT = (
    REAL_REPO / wiki_drift.LEGACY_EXPORT / wiki_drift.EXPORT_ARCHIVE / "zh" / "content"
)
EXTERNAL_BACKUP = "../wiki-content-backup-2026-10-01"


def test_the_archived_export_still_holds_the_450_seeded_pages():
    """The archive is the only in-repo copy of what 450 pages were copied FROM.

    It is not tracked — `.qoder/` sits in `.git/info/exclude` — so `git` cannot restore
    it and `git clean -fdx` deletes it. The only recovery is the external backup at
    `../wiki-content-backup-2026-10-01` (also untracked, outside the repo), which is
    named in the failure text because a reader who hits this needs the path, not a hint.
    """
    missing = (
        f"the archived IDE export is gone: {ARCHIVE_CONTENT} is not a directory. "
        f"Nothing in git can bring it back (`.qoder/` is excluded, and the archive was "
        f"moved, not committed) — recover it from the external backup at "
        f"{EXTERNAL_BACKUP} before any claim about seed fidelity is re-checked."
    )
    assert ARCHIVE_CONTENT.is_dir(), missing
    pages = sorted(ARCHIVE_CONTENT.rglob("*.md"))
    assert pages, missing
    assert len(pages) == 450, (
        f"the archive holds {len(pages)} pages, not the 450 the seed copied; "
        f"cross-check against {EXTERNAL_BACKUP} before trusting either side"
    )


def test_every_seeded_topic_body_matches_the_archive_byte_for_byte():
    """Gate 6, made permanent: 450 pages, both directions named, no empty iteration.

    For every archived export page the same relative key must exist under
    `repowiki/topics/`, and the seeded page's *body* bytes (its frontmatter stripped —
    the frontmatter is what M2 added, and `body_sha()` hashes the body for exactly this
    reason) must equal the export file's bytes. The count is asserted from the archive
    side, so a walk that found nothing could never pass, and the two failure lists are
    reported separately: "absent" is a lost page, "mismatch" is an edited one.
    """
    export_pages = sorted(ARCHIVE_CONTENT.rglob("*.md"))
    assert len(export_pages) == 450, (
        f"refusing to compare against {len(export_pages)} archived pages — the 450-page "
        f"archive is the premise of this check (see the case above; recovery is "
        f"{EXTERNAL_BACKUP})"
    )
    absent: list[str] = []
    mismatched: list[str] = []
    for export in export_pages:
        rel = export.relative_to(ARCHIVE_CONTENT).as_posix()
        seeded = REAL_REPO / "repowiki" / "topics" / export.relative_to(ARCHIVE_CONTENT)
        if not seeded.is_file():
            absent.append(rel)
            continue
        if wiki_drift.body_text(seeded).encode("utf-8") != export.read_bytes():
            mismatched.append(rel)
    assert absent == [], f"pages the seed did not publish: {absent[:5]} ({len(absent)} total)"
    assert mismatched == [], (
        f"seeded bodies that are not the archive's bytes: {mismatched[:5]} "
        f"({len(mismatched)} total)"
    )
    assert len(export_pages) - len(absent) - len(mismatched) == 450


# ---------------------------------------------------------------------------
# M-3: the two baseline failures are different problems and must say so differently
# ---------------------------------------------------------------------------
#
# Measured verbatim before this section, for a run that DID pass the flag:
#   baseline b19b5a… is not reachable from HEAD — pass --baseline <sha> (the snapshot
#   commit was GC'd by a force-pushed sync)
# Both failure modes (nothing determinable / a supplied value that does not resolve)
# printed the same remedy, so the tool instructed the operator to do the thing they had
# just done. Each message now names what was actually tried and what is missing, and the
# flag is only recommended to someone who is not already using it.

# The tool spells the remedy as prose at the start of a sentence ("Pass --baseline <sha>
# to override it."), while the defect this section pins is the *advice*, not its casing —
# so every assertion below matches the phrase case-insensitively.
BASELINE_ADVICE = re.compile(r"pass --baseline", re.IGNORECASE)


def test_supplied_unreachable_baseline_does_not_recommend_the_flag_it_was_given(
        wired, monkeypatch, capsys):
    given = "f" * 40
    assert main(["report", "--baseline", given]) == 2
    err = capsys.readouterr().err
    assert f"baseline {given} is not reachable from HEAD" in err, err
    assert not BASELINE_ADVICE.search(err), err        # the operator just did that
    assert "--baseline" in err, err                    # …named as where the value came from
    assert str(wired["content"]) not in err            # not blamed on the tree


def test_derived_unreachable_baseline_still_offers_the_override(wired, capsys):
    """`tree_baseline()`'s own value can be the unreachable one (a GC'd snapshot)."""
    (wired["wiki"] / "zh" / "meta" / "repowiki-metadata.json").write_text(
        json.dumps({"wiki_repo": {"last_commit_id": "e" * 40}}), encoding="utf-8"
    )
    assert main(["report"]) == 2
    err = capsys.readouterr().err
    assert f"baseline {'e' * 40} is not reachable from HEAD" in err, err
    assert BASELINE_ADVICE.search(err), err
    assert "verified_at" in err, err                  # says where the value came from


def test_undeterminable_baseline_names_both_sources_it_tried(wired, monkeypatch, capsys):
    absent_meta = wired["root"] / "nothing.json"
    monkeypatch.setattr(wiki_drift, "META", absent_meta)
    assert main(["report"]) == 2
    err = capsys.readouterr().err
    assert BASELINE_ADVICE.search(err), err            # here the advice IS the remedy
    assert str(wired["content"]) in err, err           # the page tree was looked at …
    assert "verified_at" in err, err                   # … and said so, key and all
    assert str(absent_meta) in err and "wiki_repo.last_commit_id" in err, err
    # … both sources named, each with the file it actually opened.


def test_the_two_baseline_failures_are_not_the_same_message(wired, monkeypatch, capsys):
    """The defect was one string serving two causes; the pair must now differ."""
    given = "f" * 40
    assert main(["report", "--baseline", given]) == 2
    supplied = capsys.readouterr().err
    monkeypatch.setattr(wiki_drift, "META", wired["root"] / "nothing.json")
    assert main(["report"]) == 2
    undeterminable = capsys.readouterr().err
    assert supplied.strip() != undeterminable.strip(), (supplied, undeterminable)
    assert BASELINE_ADVICE.search(undeterminable) and not BASELINE_ADVICE.search(supplied)

