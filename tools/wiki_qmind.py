#!/usr/bin/env python
"""QMind aggregation-layer ingest planner (M4).

QMind's tool face has `add_source`/`list_sources`/`read_source`/`retrieve` and — this
is the whole design constraint — no `update` and no `delete`. An ingest is therefore
append-only forever, so the only safe way in is a deterministic plan that names the
exact set to upload (the 44 slow-moving aggregation pages: 7 modules x 5 faces + 9
repo cards), titles each item with the sha it was uploaded at, and reconciles against
`list_sources` before anything is recorded as done.

Split of labour this tool encodes: the upload and the recall probe are MCP calls an
agent makes; the roster, the dedupe, the reconciliation and the state file are here,
because those are the parts that can be wrong in silence. `plan`, `status` and
`sentinel` read only. `reconcile` writes the state file, and only from a dump the
operator pasted out of the real notebook.

Dump shape: a JSON **array** of items, each with the page title and one id field
(`id`/`sourceId`/`source_id`/`uid`). Normalize `list_sources` pages into one array
before feeding it — the raw MCP envelope is refused rather than guessed at.

Channel status as measured 2026-10-05: NOT provisioned. `list_notebooks` returned
totalSize 0 and `add_source`/`retrieve` with the conventional notebookId answered
`permission_denied`; no `create_notebook` exists in the tool face. So
`repowiki/.qmind-state.json` carries an empty `sources` map and the verbatim probe
error, and the recall proof in spec §8.1 stays outstanding.

Run with::

    python -B -X utf8 tools/wiki_qmind.py plan
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
WIKI = REPO / "repowiki"
STATE = WIKI / ".qmind-state.json"
NOTEBOOK = "vibe-trading-repowiki"
ROSTER_DIRS = ("modules", "cards")
ROSTER_SIZE = 44
ID_KEYS = ("id", "sourceId", "source_id", "uid")
TOKEN = re.compile(r"[A-Za-z][A-Za-z0-9_.:/-]{7,}")


class RosterError(RuntimeError):
    """The aggregation layer is not the size the ingest was designed against."""


class DumpShapeError(RuntimeError):
    """The `list_sources` dump is not an array of titled items — refuse to guess."""


class SentinelError(RuntimeError):
    """No phrase unique to that one page exists, so a recall hit would prove nothing."""


def file_sha(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def title_for(rel: str, sha: str) -> str:
    return f"{rel}@{sha[:7]}"


def roster(root: Path = REPO, expected: int = ROSTER_SIZE) -> list[dict]:
    """The 44 uploadable pages, sorted, each with the sha its bytes carry right now.

    A wrong size raises instead of returning a short list: an empty walk under a
    mistyped root would otherwise read as "everything is already ingested".
    """
    wiki = Path(root) / "repowiki"
    entries: list[dict] = []
    for folder in ROSTER_DIRS:
        base = wiki / folder
        if not base.is_dir():
            continue
        for page in sorted(base.rglob("*.md")):
            rel = page.relative_to(wiki).as_posix()
            sha = file_sha(page)
            entries.append({"path": rel, "abs": page.resolve().as_posix(),
                            "sha": sha, "title": title_for(rel, sha)})
    if len(entries) != expected:
        counts = {folder: len(list((wiki / folder).rglob("*.md"))) if (wiki / folder).is_dir()
                  else 0 for folder in ROSTER_DIRS}
        raise RosterError(
            f"{wiki} yielded {len(entries)} aggregation pages, expected {expected} "
            f"(per directory: {counts}); the ingest is designed against the "
            "module/card layer only")
    return entries


def load_state(path: Path = STATE) -> dict:
    if not Path(path).is_file():
        return {"version": 1, "notebook": NOTEBOOK, "sources": {}}
    return json.loads(Path(path).read_text(encoding="utf-8"))


def plan(state: dict, ros: list[dict]) -> list[dict]:
    """Roster entries the state file does not already hold at this exact sha."""
    held = state.get("sources", {})
    pending = []
    for entry in ros:
        record = held.get(entry["path"])
        if record and record.get("sha") == entry["sha"]:
            continue
        pending.append({**entry, "kind": "file", "filePath": entry["abs"]})
    return pending


def reconcile(state: dict, items, ros: list[dict]) -> tuple[dict, list[str]]:
    """Fold a `list_sources` dump into a new state map, or name why it cannot be.

    A duplicated title makes the store un-attributable — two copies of one page in a
    notebook nothing can delete — so no mapping is produced at all; an orphan (an id
    we recorded that the notebook no longer returns) is dropped and reported, because
    keeping it would let the state file vouch for content that is gone.
    """
    if not isinstance(items, list):
        raise DumpShapeError(
            f"dump must be a JSON array of items, got {type(items).__name__}; "
            "normalise the list_sources pages into one array first")
    problems: list[str] = []
    by_title: dict[str, str] = {}
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, dict) or "title" not in item:
            raise DumpShapeError(f"dump item has no title: {item!r}")
        source_id = next((item[k] for k in ID_KEYS if item.get(k)), None)
        if source_id is None:
            raise DumpShapeError(
                f"dump item {item['title']!r} carries no id field among {ID_KEYS}")
        title = item["title"]
        if title in seen:
            problems.append(f"duplicate title {title}: ids {by_title.get(title)}, "
                            f"{source_id} — refuse to attribute the notebook")
            continue
        seen.add(title)
        by_title[title] = str(source_id)

    known = {entry["title"]: entry for entry in ros}
    if problems:
        return {**state, "channel": state.get("channel", {}),
                "sources": dict(state.get("sources", {}))}, problems

    recorded = state.get("sources", {})
    sources: dict[str, dict] = {}
    for entry in ros:
        source_id = by_title.pop(entry["title"], None)
        if source_id is None:
            continue
        sources[entry["path"]] = {"sha": entry["sha"], "sourceId": source_id,
                                  "title": entry["title"]}
    for path, record in recorded.items():
        sid = record.get("sourceId")
        if sid and sid not in set(by_title.values()) and path not in sources:
            problems.append(f"orphan {path}: recorded sourceId {sid} is not in the dump")
    for title, source_id in sorted(by_title.items()):
        if title not in known:
            problems.append(f"unknown source in the notebook: {title} ({source_id})")
    return {**state, "channel": state.get("channel", {}), "sources": sources}, problems


def sentinel(ros: list[dict], page_rel: str) -> str:
    """The longest phrase in that page which no other roster page contains.

    Uniqueness is measured across the roster rather than the repo, because the
    notebook only ever holds the roster — a `retrieve` hit on such a token is proof
    the bytes landed, and nothing more than that.
    """
    target = next((e for e in ros if e["path"] == page_rel), None)
    if target is None:
        raise SentinelError(f"{page_rel!r} is not in the roster")
    text = Path(target["abs"]).read_text(encoding="utf-8")
    others = [Path(e["abs"]).read_text(encoding="utf-8") for e in ros
              if e["path"] != page_rel]
    unique = {tok for tok in TOKEN.findall(text) if all(tok not in o for o in others)}
    if not unique:
        raise SentinelError(f"every token in {page_rel} also appears in another "
                            "roster page — a recall hit would prove nothing")
    return max(unique, key=lambda tok: (len(tok), tok))


def cmd_plan(args: argparse.Namespace) -> int:
    ros = roster()
    state = load_state()
    pending = plan(state, ros)
    if args.json:
        print(json.dumps({"notebook": state.get("notebook", NOTEBOOK), "roster": len(ros),
                          "ingested": len(state.get("sources", {})),
                          "pending": pending}, ensure_ascii=False, indent=2))
        return 0
    print(f"roster {len(ros)} pages, ingested {len(state.get('sources', {}))}, "
          f"pending {len(pending)}")
    for entry in pending:
        print(f"  {entry['path']}  {entry['title']}")
    if state.get("channel", {}).get("status") != "available":
        print("channel: " + str(state.get("channel", {}).get("status"))
              + " — nothing has been uploaded, so this list is unexecuted")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    state = load_state()
    print(f"notebook: {state.get('notebook', NOTEBOOK)}")
    print(f"channel:  {state.get('channel', {}).get('status', 'unknown')}")
    print(f"sources:  {len(state.get('sources', {}))} recorded")
    for probe in state.get("channel", {}).get("detail", []):
        print(f"  {probe.get('tool')} {probe.get('code')}: {probe.get('message')}"
              f" (operationId {probe.get('operationId')})")
    return 0


def cmd_reconcile(args: argparse.Namespace) -> int:
    ros = roster()
    state = load_state()
    items = json.loads(Path(args.from_file).read_text(encoding="utf-8"))
    new, problems = reconcile(state, items, ros)
    for problem in problems:
        print(f"PROBLEM: {problem}", file=sys.stderr)
    print(f"would record {len(new.get('sources', {}))} of {len(ros)} roster pages")
    if problems:
        print("refusing to write — reconcile the notebook first", file=sys.stderr)
        return 1
    if not args.apply:
        print("dry run: pass --apply to write the state file")
        return 0
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(new, ensure_ascii=False, indent=2) + "\n",
                     encoding="utf-8", newline="\n")
    print(f"wrote {STATE}")
    return 0


def cmd_sentinel(args: argparse.Namespace) -> int:
    print(sentinel(roster(), args.page))
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="wiki_qmind.py",
                                     description="QMind aggregation-layer ingest planner")
    sub = parser.add_subparsers(dest="cmd", required=True)
    p_plan = sub.add_parser("plan", help="what still has to be uploaded (reads only)")
    p_plan.add_argument("--json", action="store_true")
    p_plan.set_defaults(fn=cmd_plan)
    p_status = sub.add_parser("status", help="channel and reconciliation summary (reads only)")
    p_status.set_defaults(fn=cmd_status)
    p_rec = sub.add_parser("reconcile", help="fold a list_sources dump into the state file")
    p_rec.add_argument("--from", dest="from_file", required=True,
                       help="JSON array of {title, id} items")
    p_rec.add_argument("--apply", action="store_true")
    p_rec.set_defaults(fn=cmd_reconcile)
    p_sent = sub.add_parser("sentinel", help="a phrase unique to one roster page")
    p_sent.add_argument("--page", required=True, help="roster-relative path")
    p_sent.set_defaults(fn=cmd_sentinel)
    ns = parser.parse_args(argv)
    return ns.fn(ns)


if __name__ == "__main__":
    sys.exit(main())
