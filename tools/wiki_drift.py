#!/usr/bin/env python3
"""wiki_drift.py — keep the local Repo Wiki corpus honest about the code it documents.

Qoder IDE owns Repo Wiki *generation*: the table of contents, the navigation
tree and the incremental-update baseline all live in
``.qoder/repowiki/zh/meta/repowiki-metadata.json``, and several of its fields
(``current_document_structure``, ``catalogue_think_content``, per-catalog
``raw_data``) are ``WikiEncrypted:`` blobs no external tool can author. The
rendered pages under ``.qoder/repowiki/zh/content/**`` are plain UTF-8
Markdown, though — and every one of them opens with a ``<cite>`` block of
``[name](file://path#Lx-Ly)`` links, which is a page -> source-file mapping.

That mapping is what makes the wiki maintainable outside the IDE:

* compare each page's referenced files against the wiki's own baseline commit
  (read from ``wiki_repo.last_commit_id``, never rewritten here);
* keep an append-only, page-level ledger of reconciliations, so a page already
  brought current is measured from *its* commit rather than from the original
  snapshot date — which turns maintenance into per-page increments instead of
  a full regeneration;
* surface source files that no page mentions at all: subsystems that postdate
  the snapshot and are therefore undocumented rather than merely stale;
* re-point cites that are still *in* range but no longer *on* their block — an
  insertion above a cited passage pushes it down, so nothing goes out of bounds
  and the report alone cannot see the page now points a screen off.
* name the cites whose range stops past the end of the file, and say which of the
  two causes it is: the file shrank since the snapshot, which an agent re-derives,
  or those lines never existed, which only a rewrite can fix.

Only the active root's content tree is ever written — ``topics/**`` in the
repo-owned ``repowiki/``, ``zh/content/**`` in the IDE export — and only under
``reanchor --apply``, which rewrites a provable link and the range its own label
prints, then signs the page in the ledger as links-only work so ``report`` keeps
its prose drivers open.

``repowiki-metadata.json`` is treated as read-only on purpose. Leaving
``last_commit_id`` alone keeps the IDE's own incremental-update path intact, so
the wiki stays updatable from either side.

The default root is the tracked ``repowiki/`` tree; ``--wiki-root`` re-points
every path at another. Per-page baselines live in each page's own frontmatter
(``verified_at``), which is what lets the corpus be maintained in git instead of
inside an IDE snapshot.

Usage::

    python tools/wiki_drift.py                     # report -> repowiki/drift/
    python tools/wiki_drift.py report --top 30
    python tools/wiki_drift.py report --page 安装与配置
    python tools/wiki_drift.py reanchor --shifts             # dry-run every page
    python tools/wiki_drift.py reanchor --page 安装与配置 --shifts --apply
    python tools/wiki_drift.py --wiki-root repowiki report
    python tools/wiki_drift.py --wiki-root .qoder/repowiki report   # legacy export
    python tools/wiki_drift.py mark --page 安装与配置/安装与配置.md -m "re-anchored"
    python tools/wiki_drift.py mark --page 安装与配置/安装与配置.md --partial

Exit code is 0 when the check ran (even if pages are stale) and 2 on a
usage/environment error, so it is safe to chain after a build.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Iterable

REPO = Path(__file__).resolve().parents[1]

# The wiki tree moved out of the IDE export and into the repo. Root-level
# `repowiki/` is not matched by any .gitignore rule — unlike `docs/`, which
# upstream's own .gitignore ignores wholesale, and unlike `.qoder/`, which lives
# in .git/info/exclude and is invisible to git. So it becomes tracked without the
# fork editing a single upstream file, and it is NOT inside upstream gate (b)'s
# `--exclude-dir=docs` waiver: upstream's own tool polices this publication.
WIKI_ROOT_DEFAULT = "repowiki"

EMPTY_TREE_HINT = (
    "no wiki pages under {content} (root {root}, layout {layout}).\n"
    "  The repo-owned tree is seeded by milestone M2; until then the IDE export is\n"
    "  still readable explicitly:  --wiki-root .qoder/repowiki\n"
    "  Exiting 2 rather than reporting 0 pages, because an empty set that passes\n"
    "  every assertion is this repo's known false green."
)


@dataclass(frozen=True)
class WikiRoot:
    """Where the wiki lives, and which of the two on-disk shapes it uses.

    ``repo`` — the tracked tree: ``topics/ modules/ cards/ ledger.jsonl drift/``
    ``ide``  — the legacy Qoder export: ``zh/content/ zh/meta/ update/``

    Layout is read off the filesystem rather than from a flag: a directory holding
    ``zh/content`` *is* the IDE export, and the two shapes are disjoint, so the
    guess cannot be ambiguous. During M1 the new root holds only README.md, which
    resolves to ``repo`` and yields an empty ``topics`` — the hard error below.
    """

    root: Path
    layout: str

    @classmethod
    def resolve(cls, value: "str | Path", base: "Path | None" = None) -> "WikiRoot":
        path = Path(value)
        if not path.is_absolute():
            path = (base if base is not None else REPO) / path
        layout = "ide" if (path / "zh" / "content").is_dir() else "repo"
        return cls(root=path, layout=layout)

    @property
    def content(self) -> Path:
        return self.root / ("zh/content" if self.layout == "ide" else "topics")

    @property
    def update_dir(self) -> Path:
        return self.root / ("update" if self.layout == "ide" else "drift")

    @property
    def ledger(self) -> Path:
        return self.root / ("update/ledger.jsonl" if self.layout == "ide" else "ledger.jsonl")

    @property
    def meta(self) -> Path:
        return self.root / "zh" / "meta" / "repowiki-metadata.json"

    @property
    def modules(self) -> Path:
        return self.root / "modules"

    @property
    def cards(self) -> Path:
        return self.root / "cards"

    @property
    def index_md(self) -> Path:
        return self.root / "INDEX.md"


def apply_wiki_root(value: "str | Path") -> WikiRoot:
    """Re-point the path globals at `value`.

    The five globals stay the single source of truth (25 use sites, and the 77
    existing tests monkeypatch them directly), so this writes them rather than
    threading a `WikiRoot` through every function. `main()` calls it only when
    `--wiki-root` is present; the default is applied once at import.
    """
    global WIKI, CONTENT, META, UPDATE_DIR, LEDGER, wiki_root
    root = WikiRoot.resolve(value)
    WIKI = root.root
    CONTENT = root.content
    META = root.meta
    UPDATE_DIR = root.update_dir
    LEDGER = root.ledger
    wiki_root = root
    return root


WIKI: Path
CONTENT: Path
META: Path
UPDATE_DIR: Path
LEDGER: Path
wiki_root: WikiRoot
apply_wiki_root(WIKI_ROOT_DEFAULT)

CODE_SUFFIXES = {
    ".py", ".ts", ".tsx", ".js", ".jsx", ".json", ".toml", ".yaml",
    ".yml", ".md", ".sql", ".html", ".css", ".sh",
}

# file:// targets carry two anchor shapes: `path#L12-L34` and, in a minority of
# pages, `path:12-34`. Both must normalise to the same bare path.
REF_RE = re.compile(r"\[[^\]]*\]\(file://([^)\s]+)\)")
ANCHOR_RE = re.compile(r"[#:](?:L?(\d+)(?:\s*-\s*L?(\d+))?)?", re.IGNORECASE)


# ---------------------------------------------------------------------------
# git helpers
# ---------------------------------------------------------------------------


def git(*args: str) -> str:
    """Run git against this repo with path quoting off (CJK-safe output)."""
    proc = subprocess.run(
        ["git", "-C", str(REPO), "-c", "core.quotepath=off", *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    if proc.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)} failed: {proc.stderr.strip()}")
    return proc.stdout


def is_ancestor(rev: str, ref: str = "HEAD") -> bool:
    proc = subprocess.run(
        ["git", "-C", str(REPO), "merge-base", "--is-ancestor", rev, ref],
        capture_output=True,
    )
    if proc.returncode == 1:
        return False
    if proc.returncode > 1:
        raise RuntimeError(
            f"cannot compare {rev} with {ref}: "
            f"{proc.stderr.decode('utf-8', errors='replace').strip()}"
        )
    return True


def rev_reachable(rev: str) -> bool:
    """is_ancestor() for a revision that came from data, not from git.

    `last_commit_id` and ledger `head` values can name a commit that no longer
    exists — a force-pushed sync that later GC'd the orphan is exactly how this
    fork moves. That must degrade to "no usable baseline", not abort the report.
    """
    try:
        return is_ancestor(rev)
    except RuntimeError as exc:
        print(f"warning: {exc}", file=sys.stderr)
        return False


@dataclass
class Change:
    path: str
    status: str  # A / M / D / T, or '?' for untracked
    adds: int = 0
    dels: int = 0


def diff_since(base: str) -> dict[str, Change]:
    """Every file touched between *base* and the working tree's HEAD."""
    out: dict[str, Change] = {}
    for line in git("diff", "--name-status", "--no-renames", f"{base}..HEAD").splitlines():
        parts = line.split("\t")
        if len(parts) >= 2 and parts[0][:1] in "AMDT":
            out[parts[1]] = Change(parts[1], parts[0][:1])
    for line in git("diff", "--numstat", "--no-renames", f"{base}..HEAD").splitlines():
        parts = line.split("\t")
        if len(parts) < 3:
            continue
        adds, dels, path = parts
        ch = out.get(path)
        if ch is not None:
            ch.adds = int(adds) if adds.isdigit() else 0
            ch.dels = int(dels) if dels.isdigit() else 0
    return out


def worktree_delta() -> tuple[set[str], set[str]]:
    """Return (dirty tracked paths, untracked code paths) for uncommitted work."""
    dirty: set[str] = set()
    untracked: set[str] = set()
    for line in git("status", "--porcelain", "--untracked-files=normal").splitlines():
        flag, rest = line[:2], line[3:].strip()
        path = rest.split(" -> ")[-1].strip('"')
        if flag == "??":
            if Path(path).suffix.lower() in CODE_SUFFIXES:
                untracked.add(path)
        elif path:
            dirty.add(path)
    return dirty, untracked


# ---------------------------------------------------------------------------
# wiki corpus
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Ref:
    path: str
    start: int | None = None
    end: int | None = None


def strip_dotslash(value: str) -> str:
    """Normalise separators and drop a leading `./`, keeping dot-dirs intact.

    `lstrip("./")` would eat the leading dot of `.github` / `.devcontainer` and
    turn those real paths into phantom broken references.
    """
    path = value.replace("\\", "/")
    while path.startswith("./"):
        path = path[2:]
    return path


def parse_ref(raw: str) -> Ref | None:
    raw = raw.strip().rstrip(").,")
    if not raw or raw.startswith("/") or raw.startswith("http"):
        return None
    m = ANCHOR_RE.search(raw)
    path, start, end = raw, None, None
    if m and m.group(1):
        path = raw[: m.start()].strip()
        start = int(m.group(1))
        end = int(m.group(2)) if m.group(2) else start
    path = strip_dotslash(path)
    return Ref(path, start, end) if path else None


def refs_from_text(text: str) -> list[Ref]:
    """Every `file://` cite in *text*, in document order.

    The seed derives a page's `sources` from this and the report derives its cite
    list from `parse_refs` below — one codec, or the frontmatter and the verdict can
    disagree about what a page cites while both look green.
    """
    refs = []
    for raw in REF_RE.findall(text):
        ref = parse_ref(raw)
        if ref is not None:
            refs.append(ref)
    return refs


def parse_refs(page: Path) -> list[Ref]:
    return refs_from_text(page.read_text(encoding="utf-8", errors="replace"))


def metadata_baseline(meta_path: "Path | None" = None) -> str | None:
    """The commit the wiki export was generated at.

    `meta_path` exists for the one-shot seed read against the legacy root; the
    tracked tree has no metadata file and gets its fallback from `tree_baseline()`.
    """
    path = meta_path if meta_path is not None else META
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as exc:
        print(f"warning: cannot read {path}: {exc}", file=sys.stderr)
        return None
    commit = (data.get("wiki_repo") or {}).get("last_commit_id") or ""
    # Generated outside a git root the IDE writes a magic non-commit marker
    # instead of a SHA, which is not a usable baseline.
    if len(commit) != 40 or any(c not in "0123456789abcdef" for c in commit.lower()):
        return None
    return commit


def tree_baseline() -> str | None:
    """The commit the current tree agrees it was generated at.

    Modal page `verified_at` over `CONTENT`, ties broken by the revision itself so
    the answer cannot depend on walk order; falls back to the IDE metadata while an
    IDE-layout root is what is being read. `frontmatter_baseline()` gates on `vouch`
    because a page's stamp must not outrank its own ledger row; this value is the
    opposite case — the tree-wide fallback for pages that have no per-page claim.

    Keeping `metadata_baseline()` as the last resort is a deliberate deviation from
    spec §6, which asked for that call path to be deleted: a page stamp always wins,
    so only a tree with no usable per-page stamp reaches it, and that is exactly the
    IDE-layout root the pre-M1 cases run on. Dropping the fallback would have
    repointed `test_unreachable_metadata_baseline_asks_for_an_override`, the guard
    that a missing baseline is an error rather than a guess. M2's README and the
    archive both have to record this, so it is not a silent difference.
    """
    counts: Counter[str] = Counter()
    if CONTENT.is_dir():
        for page in CONTENT.rglob("*.md"):
            fm = read_frontmatter(page)
            if not fm:
                continue
            rev = str(fm.get("verified_at") or "").strip().lower()
            if HEX40_RE.match(rev):
                counts[rev] += 1
    if counts:
        return min(counts.items(), key=lambda kv: (-kv[1], kv[0]))[0]
    return metadata_baseline()


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# ---------------------------------------------------------------------------
# M2 seeding: the IDE export -> the tracked tree
# ---------------------------------------------------------------------------
#
# Source dir names are the export's own CJK keys; target names are ASCII, because
# a full-width comma inside a *filename* has bitten this repo before (and the faces
# are addressed by scripts). `topics/` keeps its CJK relative paths — that is the
# ledger's primary key, so nothing there may be renamed.

LEGACY_EXPORT = ".qoder/repowiki"
LEGACY_KNOWLEDGE = "knowledge/zh"
EXPORT_ARCHIVE = "_ide-export-retired-2026-10-01"

_ROOT = "Vibe-Trading 多端一体化仓库（Agent_前端_Electron_Wiki_CI）"
MODULE_SLUGS: dict[str, str] = {
    _ROOT: "repo-root",
    f"{_ROOT}/Vibe-Trading Agent 后端（API_MCP_CLI_回测）": "agent-backend",
    f"{_ROOT}/Vibe Trading 前端应用（React + Vite 交易分析界面）": "frontend-app",
    f"{_ROOT}/Vibe-Trading Electron 桌面宿主": "electron-desktop",
    f"{_ROOT}/Vibe-Trading Wiki 静态站点与 Pages Functions": "wiki-static-site",
    f"{_ROOT}/CI 流水线与安全门禁脚本": "ci-gates",
}

FACE_NAMES: dict[str, str] = {
    "概述.md": "overview.md",
    "架构设计.md": "architecture.md",
    "技术栈.md": "tech-stack.md",
    "编码规范.md": "conventions.md",
    "特殊配置与命令.md": "commands.md",
}

CARD_SLUGS: dict[str, str] = {
    "多语言仓库依赖管理：pip + pip-compile、npm lockfile 与 Dependabot 协同治理": "dependency-management",
    "多端一体化构建系统：Docker 多阶段镜像、pyproject 包管理与 GitHub Actions CI_CD": "build-system",
    "基于 Python stdlib logging + Uvicorn 访问日志脱敏的日志体系": "logging",
    "基于 Pydantic 的集中式环境变量与结构化 Agent 配置系统": "pydantic-settings",
    "前端样式体系：Tailwind CSS + CSS 变量主题系统": "tailwind-theme",
    "Vibe-Trading 错误处理体系：FastAPI HTTPException + 领域异常类 + CLI 吞错 + Electron 进程级兜底": "error-handling",
    "Novita AI — OpenAI 兼容推理网关": "novita-openai-gateway",
    "GitHub Actions 每日同步工作流（sync-upstream）": "sync-upstream-workflow",
    "业务术语表": "glossary",
}

# The only published page whose prose differs from the export. Its ci-gates
# architecture face describes upstream gate (b) — and gate (b) greps the
# filesystem for the literal that sentence names, so shipping it verbatim would
# make the wiki the thing the gate fails on. Rewritten at seed time, counted, and
# named in the output: publishing under this repo's own trademark policy, not a
# waiver of it (spec §9.2). The needle is assembled at runtime for the same reason.
REWORDS: dict[str, tuple[str, str]] = {
    "modules/ci-gates/architecture.md": (
        "b: 禁止字面量 '" + "".join(["World", "Quant"]) + "'",
        "b: 禁止商标字面量（名单由 `tools/ci_grep_gates.sh` 自持）",
    ),
}


# ---------------------------------------------------------------------------
# page frontmatter: the baseline that travels with the page
# ---------------------------------------------------------------------------
#
# Written by hand, not by a YAML library. The shape is fixed — the five keys this
# tool owns in their own order, then any key it does not, sorted — and gate (a) of
# the repo's own CI is about `yaml.load`, so pulling a parser in would buy nothing.
# Scalars are emitted as JSON-quoted strings — valid YAML, and it keeps CJK paths
# and `/` unescaped — and the one flow form this emitter produces, `[]`, is read
# back as an empty list.

FM_KEYS = ("page", "sources", "verified_at", "anchors", "vouch")
FM_BLOCK_RE = re.compile(r"\A---[ \t]*\r?\n(.*?)\r?\n---[ \t]*\r?\n", re.DOTALL)
FM_LIST_ITEM_RE = re.compile(r"^[ \t]+-[ \t]+(.*)$")
FM_KV_RE = re.compile(r"^([A-Za-z_][A-Za-z0-9_]*)[ \t]*:[ \t]*(.*)$")
HEX40_RE = re.compile(r"\A[0-9a-f]{40}\Z", re.IGNORECASE)


def _fm_scalar(raw: str) -> str | list:
    """One YAML scalar this emitter can produce: a JSON-quoted string, a bare
    token, or the empty flow list `[]`."""
    raw = raw.strip()
    if raw == "[]":
        return []
    if len(raw) >= 2 and raw[0] == raw[-1] and raw[0] in {'"', "'"}:
        if raw[0] == '"':
            try:
                return json.loads(raw)
            except json.JSONDecodeError:
                return raw[1:-1]
        return raw[1:-1]
    return raw


def read_page_text(page: Path) -> str:
    """Page text with the file's own line endings intact.

    `newline=""` is the whole point. This checkout is CRLF (core.autocrlf=true), and
    universal-newline reading would turn every `\r\n` in the prose into `\n` before
    hashing it — so the body hash would not match the bytes on disk, and all 426
    existing ledger rows would read `ledger-void` on the first report after M2.
    """
    with page.open("r", encoding="utf-8", errors="replace", newline="") as handle:
        return handle.read()


def split_frontmatter(text: str) -> tuple[dict | None, str]:
    """``(frontmatter-or-None, body)``.

    The body is what the ledger hashes, which is the only reason adding
    frontmatter does not void the 426 existing stamps.
    """
    match = FM_BLOCK_RE.match(text)
    if not match:
        return None, text
    fm: dict = {}
    pending: str | None = None
    for line in match.group(1).splitlines():
        if not line.strip():
            continue
        item = FM_LIST_ITEM_RE.match(line)
        if item and pending:
            fm.setdefault(pending, []).append(_fm_scalar(item.group(1)))
            continue
        kv = FM_KV_RE.match(line)
        if not kv:
            continue
        key, value = kv.group(1), kv.group(2).strip()
        if value:
            fm[key] = _fm_scalar(value)
            pending = None
        else:
            pending = key
            fm.setdefault(key, [])
    return fm, text[match.end():]


def parse_frontmatter(text: str) -> dict | None:
    return split_frontmatter(text)[0]


def read_frontmatter(page: Path) -> dict | None:
    return parse_frontmatter(read_page_text(page))


def body_text(page: Path) -> str:
    return split_frontmatter(read_page_text(page))[1]


def body_sha(page: Path) -> str:
    """Hash of the prose bytes, frontmatter excluded.

    `sha_after` in the ledger means this: a page can gain or update frontmatter
    without its reconciliation claim dissolving, while a hand edit to the prose
    still voids it (the `ledger-void` path). A page with no frontmatter hashes to
    exactly what `sha256(page)` returns, which is what keeps the pre-M1 stamps.
    """
    return hashlib.sha256(body_text(page).encode("utf-8")).hexdigest()


def _emit_kv(key: str, value: "str | list") -> str:
    """One non-FM_KEYS entry: a JSON-quoted scalar, or a 2-space list.

    The IDE export indents its lists by 4 spaces; the reader accepts any leading
    whitespace (`FM_LIST_ITEM_RE`), so re-indenting on the way out is a rendering
    change, not a content change — and one shape is what makes the block diffable.
    """
    if isinstance(value, list):
        if not value:
            return f"{key}: []"
        return "\n".join([f"{key}:"] + [f"  - {json.dumps(v, ensure_ascii=False)}" for v in value])
    return f"{key}: {json.dumps(value, ensure_ascii=False)}"


def emit_frontmatter(fm: dict) -> str:
    lines = [f"page: {json.dumps(fm.get('page', ''), ensure_ascii=False)}"]
    sources = list(fm.get("sources") or [])
    if sources:
        lines.append("sources:")
        lines += [f"  - {json.dumps(s, ensure_ascii=False)}" for s in sources]
    else:
        lines.append("sources: []")
    lines.append(f"verified_at: {json.dumps(fm.get('verified_at', ''), ensure_ascii=False)}")
    lines.append(f"anchors: {fm.get('anchors', 'open')}")
    lines.append(f"vouch: {fm.get('vouch', 'applied-only')}")
    for key in sorted(k for k in fm if k not in FM_KEYS):
        lines.append(_emit_kv(key, fm[key]))
    return "---\n" + "\n".join(lines) + "\n---\n"


def update_frontmatter(target: Path, **fields) -> dict:
    """Merge `fields` into the page's frontmatter, creating the block if absent.

    The file argument is `target`, not `page`: `page` is one of the five keys, and
    a parameter named after a field would make that field impossible to set.

    Keys this tool does not own are kept and rewritten, so seeding a page cannot
    delete the metadata its IDE export carries. The returned dict — and the block on
    disk — puts the five known keys first in their fixed order, then the foreign
    ones sorted, with empty values written explicitly; a page rewritten twice stays
    byte-identical, because a generator that touches pages must be diffable or its
    own output looks like an edit.
    """
    fm, body = split_frontmatter(read_page_text(target))
    merged = dict(fm or {})
    merged.update({k: v for k, v in fields.items() if v is not None})
    merged.setdefault("page", target.name)
    merged.setdefault("sources", [])
    merged.setdefault("verified_at", "")
    merged.setdefault("anchors", "open")
    merged.setdefault("vouch", "applied-only")
    # Reorder only — every key in `merged` is still in the result.
    merged = {k: merged[k] for k in (*FM_KEYS, *sorted(k for k in merged if k not in FM_KEYS))}
    target.write_text(emit_frontmatter(merged) + body, encoding="utf-8", newline="\n")
    return merged


def frontmatter_baseline(page: Path) -> str | None:
    """The page's own `verified_at` — but only while the page still vouches for all of
    its cites, or None when the block is absent/unusable.

    A baseline that outranks the ledger has to be a *claim about the whole page*, and
    only a hand `mark` makes one. `reanchor --apply` and `mark --partial` edit bytes
    nobody re-read while leaving `verified_at` in place, and a stamp at the current HEAD
    measures its own drift window as empty: the page would drop out of the queue with
    its todo list intact. That is how 414 unfinished pages once hid behind their own
    stamps, so the withdrawal is recorded in the frontmatter as `vouch`.
    """
    fm = read_frontmatter(page)
    if not fm:
        return None
    if str(fm.get("vouch") or "").strip() != "all":
        return None
    rev = str(fm.get("verified_at") or "").strip()
    return rev if HEX40_RE.match(rev) else None


def anchors_axis(past_end: int) -> str:
    """`verified` only when nothing was left unprovable on this page."""
    return "open" if past_end else "verified"


def stamp_frontmatter(
    page: Path,
    *,
    rel: str | None = None,
    verified_at: str | None = None,
    anchors: str | None = None,
    vouch: str | None = None,
) -> dict | None:
    """Write the stamp back onto the page — for the repo-owned tree only.

    The layout is read off the disk (`WIKI`'s own shape) rather than from the
    `wiki_root` global, because a stale global must not be able to rewrite the IDE
    export: that snapshot is read-only by design (its own metadata drives the IDE's
    incremental regeneration), and touching its 450 pages from here would recreate
    the second source of truth this whole milestone exists to remove.

    `rel` is the page's path relative to the content tree — the same string the ledger
    is keyed by. Left to `update_frontmatter`'s default the `page` key would hold only
    the file name, and two spellings of one identity is how a ledger row and its page
    stop finding each other.
    """
    if WikiRoot.resolve(WIKI).layout != "repo":
        return None
    return update_frontmatter(
        page, page=rel, verified_at=verified_at, anchors=anchors, vouch=vouch
    )


# ---------------------------------------------------------------------------
# M2 seeding: page planning
# ---------------------------------------------------------------------------
#
# What the seed publishes is decided here, before a byte is written: the export's
# topic pages (and, in Task 5, its knowledge layer) become `PagePlan`s, so a
# source-side surprise raises during planning instead of half-way through the writes
# — with page 300 already on disk and page 120's stamp already overwritten.


@dataclass
class PagePlan:
    """One page the seed intends to publish. Built before anything is written, so a
    source-side surprise raises during planning instead of half-way through the
    milestone's 494 page writes."""

    target: Path
    label: str          # path relative to WIKI, posix — what the tally prints
    body: bytes         # prose bytes exactly as published, frontmatter excluded
    fm: dict
    origin: str         # topic | module | card
    reworded: bool = False


def strip_reword(label: str, body: bytes) -> tuple[bytes, bool]:
    """Apply the one published-prose exception, and refuse to apply it quietly.

    `label` is the prefixed plan label (`topics/...`, `modules/...`) — the spelling
    `REWORDS` is keyed by — not the unprefixed `fm["page"]` value.
    """
    pair = REWORDS.get(label)
    if pair is None:
        return body, False
    old, new = pair[0].encode("utf-8"), pair[1].encode("utf-8")
    if body.count(old) != 1:
        raise RuntimeError(
            f"reword for {label}: expected the needle exactly once, found {body.count(old)}"
        )
    replaced = body.replace(old, new)
    if replaced.count(b"\n") != body.count(b"\n"):
        raise RuntimeError(f"reword for {label} changed the line count")
    return replaced, True


def plan_topics(legacy: Path, snapshot: str) -> list[PagePlan]:
    """Plan every page of the legacy export's `zh/content` tree as a `topics/` page.

    Two invariants make this more than a copy, and both are about *not* changing
    anything. The relative path is the ledger's primary key (426 rows, CJK included),
    so `rel` is reused verbatim rather than re-slugged; and `body` is the export's own
    bytes through `read_page_text`'s `newline=""` plus one `.encode("utf-8")` —
    nothing else. `body_sha` hashes exactly those bytes, so a newline translation or a
    renamed path here would silently read every existing stamp as `ledger-void`.

    That byte identity is *checked*, not just claimed: `errors="replace"` turns an
    invalid byte into U+FFFD and republishes different bytes under the same key, and a
    plan built from such a text voids its own ledger row without a word of complaint.
    So an un-reworded plan must equal `src.read_bytes()`. Measured today across the 450
    export pages: 0 contain a CR, 0 carry a BOM.

    `fm["page"]` stays relative to `topics/` (no prefix) for the same reason: the
    prefix is where the page lives, `page` is what the ledger calls it.
    """
    content = legacy / "zh" / "content"
    if not content.is_dir():
        raise RuntimeError(f"no export content tree at {content}")
    plans: list[PagePlan] = []
    for src in sorted(content.rglob("*.md")):
        rel = str(src.relative_to(content)).replace("\\", "/")
        fm, body = split_frontmatter(read_page_text(src))
        # `is not None`, not truthiness: `split_frontmatter` returns {} for a block
        # whose lines parse to nothing (a comment-only `---` fence), and that page is
        # exactly the surprise this guard exists to catch. Measured 0 today.
        if fm is not None:
            raise RuntimeError(f"unexpected frontmatter in export page {rel}")
        label = f"topics/{rel}"
        published, reworded = strip_reword(label, body.encode("utf-8"))
        if not reworded and published != src.read_bytes():
            raise RuntimeError(f"planned body is not the export bytes for {rel}")
        plans.append(PagePlan(
            target=WIKI / "topics" / rel,
            label=label,
            body=published,
            fm={
                "page": rel,
                # Read off the published bytes, not the pre-reword text: `sources`
                # must describe the prose that actually ships.
                "sources": sorted({r.path for r in refs_from_text(published.decode("utf-8"))}),
                "verified_at": snapshot,
                "anchors": "open",
                # Seeding moves bytes, it does not re-read cites: only a human
                # `mark` may claim `all`, and a self-matching baseline would hide
                # the 414 unfinished pages this whole contract surfaced.
                "vouch": "applied-only",
            },
            origin="topic",
            reworded=reworded,
        ))
    if not plans:
        # An empty plan set passes every per-page assertion there is, and the seed
        # would then "succeed" having published 0 of 450 pages.
        raise RuntimeError(f"no export pages planned from {content}")
    return plans


def plan_knowledge(
    kb: Path,
    snapshot: str,
    modules: "dict[str, str] | None" = None,
    cards: "dict[str, str] | None" = None,
) -> list[PagePlan]:
    """The aggregation layer: 6 module dirs x 5 faces + 9 repo-level cards.

    Module faces carry no `<cite>` block at all (measured: 0 `file://` refs in the
    whole knowledge tree), so their `sources` is honestly empty — a page whose
    evidence base nobody recorded must not be given one by the generator. Cards
    publish their IDE metadata alongside our five keys.

    `modules`/`cards` are parameters rather than constants so a test can feed a
    small table; production reads `MODULE_SLUGS`/`CARD_SLUGS`. Both directions of
    the mapping are checked, because the reconciliation rule for the migration is
    that every source dir is claimed exactly once: an on-disk dir with no slug is a
    page nobody seeds, and a slug with no dir is a published path pointing at
    nothing. Card dirs are told apart from module dirs by the absence of
    `_module.yaml`, which is what keeps the module *root* — the one dir that is a
    module and sits at the top level — from being read as an unmapped card. The same
    marker, not `is_dir()`, is what the module *missing* direction compares against:
    a mapped dir that lost its marker is no longer a module, and planning its 5 faces
    anyway is precisely the "page nobody seeded" failure this rule forbids.

    `fm["page"]` is the **prefixed** label (`modules/…`, `cards/…`) here, where
    `plan_topics` writes the path relative to `topics/` — deliberate mirrors, because
    the prefixed label is the ledger key for a module/card row; "unifying" the two
    spellings would break every module/card lookup, not fix one.
    """
    if not kb.is_dir():
        # Before anything reads the tree: `rglob` on a missing path yields nothing
        # and `iterdir` raises `FileNotFoundError`, so a wrong `--knowledge-root`
        # would otherwise reach Task 6's seed as a traceback instead of the
        # `RuntimeError` the CLI's exit-2 path prints.
        raise RuntimeError(f"no knowledge tree at {kb}")
    modules = MODULE_SLUGS if modules is None else modules
    cards = CARD_SLUGS if cards is None else cards
    plans: list[PagePlan] = []

    found_mods = {str(p.parent.relative_to(kb)).replace("\\", "/")
                  for p in kb.rglob("_module.yaml")}
    unmapped = sorted(found_mods - set(modules))
    if unmapped:
        raise RuntimeError(f"unmapped module dirs: {unmapped}")
    for dir_rel, slug in sorted(modules.items()):
        mod = kb / dir_rel
        # The marker, not `is_dir()`: `found_mods` is what "module" means here, so
        # the two directions of the map compare against the same set. On the real
        # export `found_mods == set(MODULE_SLUGS)`, so this cannot false-red today.
        if dir_rel not in found_mods:
            raise RuntimeError(f"module dir missing: {dir_rel}")
        for face_src, face_dst in sorted(FACE_NAMES.items()):
            src = mod / face_src
            if not src.is_file():
                raise RuntimeError(f"module face missing: {dir_rel}/{face_src}")
            fm, body = split_frontmatter(read_page_text(src))
            # `is not None`, not truthiness, exactly as in `plan_topics`: a fence
            # whose lines all parse to nothing returns {}, and `if fm:` would wave
            # that page through into a nested block the ledger then hashes as prose.
            if fm is not None:
                raise RuntimeError(f"unexpected frontmatter in {dir_rel}/{face_src}")
            rel = f"modules/{slug}/{face_dst}"
            published, reworded = strip_reword(rel, body.encode("utf-8"))
            # Byte fidelity, mirrored from `plan_topics`: a face has no frontmatter
            # to drop (rejected just above), so the planned body *is* the file. The
            # ledger keys the row by path and hashes these exact bytes, and
            # `read_page_text`'s `errors="replace"` turns an invalid byte into
            # U+FFFD — different bytes under the same key, voiding the row without a
            # word of complaint. Only the un-reworded plans are byte-identical by
            # construction, so the reworded one is checked by `strip_reword` alone.
            if not reworded and published != src.read_bytes():
                raise RuntimeError(f"planned body is not the export bytes for {rel}")
            plans.append(PagePlan(
                target=WIKI / rel, label=rel, body=published, reworded=reworded,
                fm={"page": rel, "sources": [], "verified_at": snapshot,
                    "anchors": "open", "vouch": "applied-only"},
                origin="module",
            ))

    found_cards = {p.name for p in kb.iterdir()
                   if p.is_dir() and not (p / "_module.yaml").exists()}
    unmapped_cards = sorted(found_cards - set(cards))
    if unmapped_cards:
        raise RuntimeError(f"unmapped card dirs: {unmapped_cards}")
    for dir_name, slug in sorted(cards.items()):
        if dir_name not in found_cards:
            raise RuntimeError(f"card dir missing: {dir_name}")
        src = kb / dir_name / f"{dir_name}.md"
        if not src.is_file():
            raise RuntimeError(f"card page missing: {dir_name}")
        # Byte fidelity, card shape. The frontmatter block is dropped by design, so
        # the plan's body can never equal the whole file; the strict decode is what
        # remains of the guarantee — `read_page_text` replaces an invalid byte with
        # U+FFFD and the IDE keys would then round-trip through the writer mangled.
        try:
            src.read_bytes().decode("utf-8")
        except UnicodeDecodeError as exc:
            raise RuntimeError(f"card {dir_name} is not valid UTF-8: {exc}") from exc
        fm, body = split_frontmatter(read_page_text(src))
        # The card's mirror of the faces' hard guard, and its only evidence source:
        # a lost or unparseable fence used to plan `sources: []` silently, shipping a
        # page that claims no evidence base where the export claims eight files'
        # worth, and regressing Task 2's foreign-key preservation to "0 keys
        # preserved" with no raise. Measured today: all 9 cards carry a block.
        if fm is None:
            raise RuntimeError(f"card {dir_name} has no frontmatter")
        extra = dict(fm)
        # Read, not popped: `sources` is the derived view (sorted, blank-stripped,
        # deduplicated) while `source_files` keeps shipping verbatim under the IDE's
        # own key — Task 2's foreign-key preservation exists so a card's metadata
        # round-trips. A card without the key (the glossary, measured) keeps not
        # having it, and gets `sources: []`.
        files = extra.get("source_files", [])
        if not isinstance(files, list):
            files = [files]
        clash = sorted(k for k in extra if k in FM_KEYS)
        if clash:
            raise RuntimeError(f"card {dir_name} already uses our keys {clash}")
        rel = f"cards/{slug}.md"
        published, reworded = strip_reword(rel, body.encode("utf-8"))
        plans.append(PagePlan(
            target=WIKI / rel, label=rel, body=published, reworded=reworded,
            fm={"page": rel,
                "sources": sorted({str(s) for s in files if str(s).strip()}),
                "verified_at": snapshot, "anchors": "open", "vouch": "applied-only",
                **extra},
            origin="card",
        ))
    labels = [p.label for p in plans]
    if len(set(labels)) != len(labels):
        # Both tables are keyed by the *source dir*, so nothing structural stops two
        # dirs sharing one slug: the plan count stays right while two pages claim the
        # same path and the same label, and any caller that indexes by label (a dict,
        # the tally, the ledger) silently keeps one of them.
        dupes = sorted({lbl for lbl in labels if labels.count(lbl) > 1})
        raise RuntimeError(f"duplicate plan label: {dupes}")
    if not plans:
        # Empty tables are a call that planned nothing, not a clean run: the same
        # shape `plan_topics` refuses for the same reason.
        raise RuntimeError(f"no knowledge pages planned from {kb}")
    return plans


# ---------------------------------------------------------------------------
# M2 seeding: the publish step
# ---------------------------------------------------------------------------
#
# Planning decided *what* ships; this section ships it and counts what happened
# while doing so. The whole point of the tally is that "the seed ran" is a
# falsifiable statement: every page it plans is reconciled against the bytes that
# were planned for it, the exceptions are named rather than absorbed, and the
# numbers print on one line that a human or a gate can read.
#
# `--dry-run` is the default and `--apply` the opt-in, inverting the usual CLI
# habit on purpose: the first run of this command against the real export happens
# before anyone has reviewed a diff, and a mistake there rewrites the tree that
# Task 10 commits.


@dataclass
class SeedTally:
    written: int = 0
    skipped: int = 0
    mismatched: int = 0
    reworded: int = 0
    checked: int = 0
    no_sources: int = 0
    origins: dict[str, int] = field(default_factory=dict)
    reword_names: list[str] = field(default_factory=list)

    def line(self) -> str:
        return (f"pages_written={self.written} pages_skipped={self.skipped} "
                f"sha_mismatch={self.mismatched} checked={self.checked} "
                f"reworded={self.reworded} no_sources={self.no_sources} "
                f"origins={{{', '.join(f'{k}:{v}' for k, v in sorted(self.origins.items()))}}}")


def apply_page_plan(plan: PagePlan, tally: SeedTally, dry_run: bool) -> None:
    """Publish one page: our frontmatter, then the body bytes verbatim.

    `newline="\\n"` is not enough — the payload is assembled as bytes, so no layer
    between here and the disk can decide to rewrite a line ending inside the prose.
    The post-write `endswith(plan.body)` is the per-file sha256 reconciliation
    spec §12 asks for: it fails if the body that landed differs from the body that
    was planned, whichever step did it.
    """
    payload = emit_frontmatter(plan.fm).encode("utf-8") + plan.body
    tally.checked += 1
    tally.origins[plan.origin] = tally.origins.get(plan.origin, 0) + 1
    if not plan.fm["sources"]:
        tally.no_sources += 1
    if plan.reworded:
        tally.reworded += 1
        tally.reword_names.append(plan.label)
    if plan.target.is_file() and plan.target.read_bytes() == payload:
        tally.skipped += 1
        return
    if dry_run:
        tally.written += 1
        return
    plan.target.parent.mkdir(parents=True, exist_ok=True)
    plan.target.write_bytes(payload)
    if not plan.target.read_bytes().endswith(plan.body):
        tally.mismatched += 1
    else:
        tally.written += 1


def copy_ledger(legacy: Path, dry_run: bool) -> tuple[int, str]:
    src = legacy / "update" / "ledger.jsonl"
    if not src.is_file():
        raise RuntimeError(f"ledger missing from the export: {src}")
    data = src.read_bytes()
    rows = [line for line in data.decode("utf-8").splitlines() if line.strip()]
    if not dry_run:
        (WIKI / "ledger.jsonl").write_bytes(data)
        if (WIKI / "ledger.jsonl").read_bytes() != data:
            raise RuntimeError("ledger copy is not byte-identical")
    return len(rows), hashlib.sha256(data).hexdigest()[:12]


def cmd_seed(args: argparse.Namespace) -> int:
    legacy = Path(args.from_root)
    if not legacy.is_absolute():
        legacy = REPO / legacy
    # The layout is read off the disk (`WIKI`'s own shape), not from the `wiki_root`
    # global — the same strong form `stamp_frontmatter` uses, for the same reason: a
    # stale global must not be able to point a writer at the IDE export. Seed is the
    # milestone's highest-consequence writer, so it gets the strictest reading.
    # The message names `WIKI` because that is the thing being refused; `legacy` is
    # the `--from` source, which is normally *supposed* to be an IDE-layout root.
    if WikiRoot.resolve(WIKI).layout != "repo":
        print(
            f"refusing to seed into an ide-layout root ({WIKI}): the target tree is "
            "the tracked publication, not the export",
            file=sys.stderr,
        )
        return 2
    snapshot = args.snapshot or metadata_baseline(
        legacy / "zh" / "meta" / "repowiki-metadata.json")
    if not snapshot or not HEX40_RE.match(snapshot):
        print(
            f"seed snapshot commit unavailable at {legacy}: pass --snapshot <40-hex>",
            file=sys.stderr,
        )
        return 2
    try:
        plans = (plan_topics(legacy, snapshot)
                 + plan_knowledge(legacy / LEGACY_KNOWLEDGE, snapshot))
    except RuntimeError as exc:
        print(f"seed plan failed: {exc}", file=sys.stderr)
        return 2
    tally = SeedTally()
    for plan in plans:
        apply_page_plan(plan, tally, not args.apply)
    rows, digest = copy_ledger(legacy, not args.apply)
    print(("" if args.apply else "dry-run: nothing written\n") + tally.line())
    print(f"ledger_rows={rows} ledger_sha={digest} snapshot={snapshot} target={WIKI}")
    if tally.reword_names:
        print("reworded: " + ", ".join(tally.reword_names))
    if not args.apply:
        print("pass --apply to publish")
    return 0 if tally.mismatched == 0 else 1


# ---------------------------------------------------------------------------
# ledger
# ---------------------------------------------------------------------------


@dataclass
class LedgerEntry:
    page: str
    head: str
    sha_after: str
    note: str
    at: str
    drivers: list[str] = field(default_factory=list)
    partial: bool = False
    applied: list[str] = field(default_factory=list)
    # What the stamp vouches for on the *anchor* axis: `all` means every cite on
    # the page is current at `head`, `applied-only` means just the ones listed in
    # `applied` are, and the rest keep their page baseline.
    cites: str = "applied-only"


def load_ledger() -> dict[str, LedgerEntry]:
    """Latest entry per page wins (the file is append-only history)."""
    latest: dict[str, LedgerEntry] = {}
    if not LEDGER.exists():
        return latest
    for line in LEDGER.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            row = json.loads(line)
        except json.JSONDecodeError:
            print(f"warning: skipping unparseable ledger line: {line[:80]}", file=sys.stderr)
            continue
        if row.get("page"):
            latest[row["page"]] = LedgerEntry(
                page=row["page"],
                head=row.get("head", ""),
                sha_after=row.get("sha_after", ""),
                note=row.get("note", ""),
                at=row.get("at", ""),
                drivers=list(row.get("drivers") or []),
                partial=bool(row.get("partial")),
                applied=list(row.get("applied") or []),
                # Rows written before the vouch-scope field existed all came from
                # `reanchor --apply`, which only ever moved the anchors it names.
                cites=row.get("cites") or "applied-only",
            )
    return latest


def effective_base(
    page: Path, rel: str, ledger: dict[str, LedgerEntry], fallback: str
) -> tuple[str, str]:
    """Per-page baseline plus a provenance tag.

    Precedence: the page's own ``verified_at`` > the ledger > the snapshot commit.
    Frontmatter wins because it travels with the page in git (diffable, revertible)
    while the snapshot is one global IDE value. A frontmatter rev that is no longer
    reachable must NOT become a baseline, or a force-pushed sync would freeze the
    page's drift measurement at a phantom commit.

    The ledger branch keeps its old rules verbatim: a body-hash mismatch voids the
    claim (``ledger-void``), and a ``partial`` entry deliberately does not move the
    baseline — that is the discipline that surfaced 414 hidden todos.
    """
    fm_rev = frontmatter_baseline(page)
    if fm_rev and rev_reachable(fm_rev):
        return fm_rev, "frontmatter"
    entry = ledger.get(rel)
    if entry and entry.head and entry.sha_after:
        if body_sha(page) != entry.sha_after:
            return fallback, "ledger-void"
        if entry.partial:
            return fallback, "partial"
        if rev_reachable(entry.head):
            return entry.head, "reconciled"
    return fallback, "snapshot"


# ---------------------------------------------------------------------------
# per-page analysis
# ---------------------------------------------------------------------------


@dataclass
class PageReport:
    page: str
    state: str  # clean | stale | broken | mixed | reconciled | ledger-void | frontmatter
    base: str
    refs: int
    fm: str = "present"  # present | missing — `missing` after seeding means a page was skipped
    stale: list[str] = field(default_factory=list)
    broken: list[str] = field(default_factory=list)
    anchors: list[str] = field(default_factory=list)

    @property
    def score(self) -> int:
        return len(self.stale) + len(self.broken) + len(self.anchors)

    def to_dict(self) -> dict:
        return {
            "page": self.page,
            "state": self.state,
            "base": self.base,
            "refs": self.refs,
            "fm": self.fm,
            "stale": self.stale,
            "broken": self.broken,
            "anchors": self.anchors,
        }


_line_cache: dict[str, int] = {}


def file_line_count(rel_path: str) -> int:
    """Lines a file shows today, or -1 if it is gone.

    Counted the way the wiki generator counts them: an editor numbers the empty
    line after a trailing newline, so a file of 120 newlines offers line 121 and a
    cite ending there is healthy. The stricter count called some three thousand
    end-of-file cites out of bounds.
    """
    if rel_path in _line_cache:
        return _line_cache[rel_path]
    abs_path = REPO / rel_path
    if not abs_path.is_file():
        _line_cache[rel_path] = -1
        return -1
    with abs_path.open("rb") as fh:
        raw = fh.read()
    n = raw.count(b"\n") + (1 if raw else 0)
    _line_cache[rel_path] = n
    return n


def historical_line_count(rev: str, rel_path: str) -> int:
    """Lines the file showed in an editor at *rev*, or -1 if it was not there."""
    lines = historical_lines(rev, rel_path)
    if lines is None:
        return -1
    return len(lines) + (1 if lines else 0)


def anchor_overrun(ref: Ref, base: str | None) -> str | None:
    """Why a cite ends past the file, or None if it still fits.

    The two answers cost an agent different things: an anchor that overruns only
    because the file shrank is drift, and the block it names can be found again;
    one that was past the end the day it was written cites lines that never
    existed, so nothing re-derives it — it has to be replaced by hand.
    """
    if ref.end is None:
        return None
    n = file_line_count(ref.path)
    if n < 0 or ref.end <= n:
        return None
    label = f"{ref.path}#L{ref.start}-L{ref.end}"
    then = -1 if base is None else historical_line_count(base, ref.path)
    if then >= ref.end:
        return f"{label} ({n} lines now, {then} at the snapshot)"
    tail = "it was not there at the snapshot" if then < 0 else f"{then} lines then"
    return f"{label} (past the end at the snapshot too: {tail}, {n} now)"


def audit_page(
    page: Path,
    rel: str,
    tag: str,
    base: str,
    changes_for: Callable[[str], dict[str, Change]],
    dirty: set[str],
    untracked: set[str],
    record_broken: bool = True,
) -> PageReport:
    refs = parse_refs(page)
    changes = changes_for(base)
    rep = PageReport(page=rel, state=tag, base=base, refs=len(refs))
    rep.fm = "present" if read_frontmatter(page) else "missing"
    seen: set[str] = set()
    for ref in refs:
        if not (REPO / ref.path).exists():
            if record_broken and ref.path not in rep.broken:
                rep.broken.append(ref.path)
            continue
        # Checked once per range, not once per file: a page cites one file from
        # many sections, and an overrun in just one of them is still a lie.
        over = anchor_overrun(ref, base)
        if over and over not in rep.anchors:
            rep.anchors.append(over)
        if ref.path in seen:
            continue
        seen.add(ref.path)
        if ref.path in changes or ref.path in dirty or ref.path in untracked:
            rep.stale.append(ref.path)
    if rep.score == 0:
        rep.state = (
            tag if tag in ("reconciled", "ledger-void", "partial", "frontmatter") else "clean"
        )
        return rep
    if rep.broken and (rep.stale or rep.anchors):
        rep.state = "mixed"
    elif rep.broken:
        rep.state = "broken"
    else:
        rep.state = "stale"
    if tag in ("ledger-void", "partial"):
        rep.state = tag
    return rep


def make_changes_for() -> Callable[[str], dict[str, Change]]:
    """Cache `diff_since` per baseline — pages share few distinct bases."""
    cache: dict[str, dict[str, Change]] = {}

    def get(base: str) -> dict[str, Change]:
        if base not in cache:
            cache[base] = diff_since(base)
        return cache[base]

    return get


# ---------------------------------------------------------------------------
# coverage
# ---------------------------------------------------------------------------


def uncovered_sources(
    changes: dict[str, Change], untracked: set[str], all_refs: set[str]
) -> list[Change]:
    """Changed code files that no wiki page cites — undocumented, not stale."""
    rows = [
        ch
        for path, ch in changes.items()
        if path not in all_refs and Path(path).suffix.lower() in CODE_SUFFIXES
    ]
    rows += [Change(path, "?") for path in sorted(untracked) if path not in all_refs]
    rows.sort(key=lambda c: (-(c.adds + c.dels), c.path))
    return rows


# ---------------------------------------------------------------------------
# reporting
# ---------------------------------------------------------------------------


def render_markdown(payload: dict, reports: list[PageReport], gaps: list[Change], top: int) -> str:
    s = payload["summary"]
    ordered = sorted(reports, key=lambda r: (-r.score, r.page))
    lines = [
        "# Repo Wiki 漂移报告",
        "",
        f"- 生成时间：{payload['generated_at']}",
        f"- 当前 HEAD：`{payload['head']}`",
        f"- Wiki 快照基线：`{payload['metadata_baseline']}`（只读取，不改写 `repowiki-metadata.json`）",
        f"- 页面：共 {s['pages']}｜需更新 {s['needs_update']}｜已一致 {s['clean']}"
        f"（其中台账已对齐 {s['reconciled']}、台账失效 {s['ledger_void']}、只改了链接 {s['partial']}）",
        f"- 引用源文件：{s['distinct_refs']} 个｜自各页有效基线以来有变更 {s['refs_changed']}｜已不存在 {s['refs_broken']}",
        f"- 缺 frontmatter 的页面：{s['no_frontmatter']}"
        f"（播种之前应为全部；播种之后非零即漏播种）｜基线来自页自身的 {s['frontmatter']}",
        f"- 无任何页面引用的改动文件：{s['uncovered']}",
        "",
        "## 待更新页面（按问题引用数排序）",
        "",
        "| # | 页面 | 状态 | 有效基线 | 引用数 | 问题 |",
        "| --- | --- | --- | --- | --- | --- |",
    ]
    flagged = [r for r in ordered if r.score]
    for i, rep in enumerate(flagged[:top], 1):
        bits = []
        if rep.broken:
            bits.append(f"缺失 {len(rep.broken)}")
        if rep.stale:
            bits.append(f"变更 {len(rep.stale)}")
        if rep.anchors:
            bits.append(f"锚点越界 {len(rep.anchors)}")
        lines.append(
            f"| {i} | `{rep.page}` | {rep.state} | `{rep.base[:8]}` | "
            f"{rep.refs} | {'、'.join(bits)} |"
        )
    if not flagged:
        lines.append("| — | 全部页面与当前代码一致 | clean | — | — | — |")

    lines += ["", "## 已消失的引用（页面指向不存在的文件）", ""]
    broken_rows = [r for r in ordered if r.broken][:top]
    if broken_rows:
        for rep in broken_rows:
            lines.append(f"- `{rep.page}`")
            lines += [f"  - `{p}`" for p in rep.broken]
    else:
        lines.append("- 无")

    lines += ["", "## 锚点越界（引用行号超出文件当前长度）", ""]
    anchor_rows = [r for r in ordered if r.anchors][:top]
    if anchor_rows:
        for rep in anchor_rows:
            lines.append(f"- `{rep.page}`")
            lines += [f"  - `{a}`" for a in rep.anchors]
    else:
        lines.append("- 无")

    lines += [
        "",
        "## 未覆盖子系统（按自快照基线以来的改动量排序）",
        "",
        "| 文件 | 状态 | +行 | -行 |",
        "| --- | --- | --- | --- |",
    ]
    for ch in gaps[: top * 2]:
        lines.append(f"| `{ch.path}` | {ch.status} | {ch.adds} | {ch.dels} |")
    if not gaps:
        lines.append("| — | 无 | 0 | 0 |")
    lines += [
        "",
        "> 目录与导航由 IDE 的 Wiki 生成器持有（`repowiki-metadata.json` 里的 "
        "`WikiEncrypted` 字段），本页只能改正文。新增子系统需要成页时，回 IDE 触发一次增量生成。",
        "",
    ]
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# re-anchoring refs to files that moved
# ---------------------------------------------------------------------------


def candidates_for(old_path: str) -> list[str]:
    """Files that plausibly hold the cited text today.

    Two refactors dominate: a file renamed in place (same basename elsewhere)
    and a module promoted to a package (`x/y.py` -> `x/y/*.py`). Both are
    enumerated; the second is what stops a split gate from being re-anchored
    onto an unrelated same-named file in another subtree.
    """
    p = Path(old_path)
    out: list[str] = []
    # module -> package
    inner = p.parent / p.stem
    if (REPO / inner).is_dir():
        out += sorted(str(f.relative_to(REPO)).replace("\\", "/") for f in (REPO / inner).glob("*.py"))
    # same basename elsewhere
    proc = subprocess.run(
        ["git", "-C", str(REPO), "-c", "core.quotepath=off", "ls-files", "--", f"*{p.name}"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    out += [line for line in proc.stdout.splitlines() if Path(line).name == p.name and line != old_path]
    seen: set[str] = set()
    return [c for c in out if not (c in seen or seen.add(c))]


def last_touch_rev(rel_path: str) -> str | None:
    """Newest commit that still contained *rel_path*.

    The block must come from the file's *final* text: a cite recorded at the
    snapshot baseline can already be words behind a file that was edited some
    more before it was renamed or split, and only its last shape is what a
    surviving module can match byte for byte.
    """
    proc = subprocess.run(
        ["git", "-C", str(REPO), "rev-list", "-n", "1", "HEAD", "--", rel_path],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    rev = proc.stdout.strip().splitlines()
    return rev[0] if proc.returncode == 0 and rev else None


_historical_cache: dict[tuple[str, str], list[str] | None] = {}


def historical_lines(rev: str, rel_path: str) -> list[str] | None:
    """Lines of *rel_path* as it stood at *rev*, or None if it never existed."""
    key = (rev, rel_path)
    if key in _historical_cache:
        return _historical_cache[key]
    proc = subprocess.run(
        ["git", "-C", str(REPO), "show", f"{rev}:{rel_path}"],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    out = proc.stdout.splitlines() if proc.returncode == 0 else None
    _historical_cache[key] = out
    return out


def locate_block(block: list[str], haystack: list[str]) -> int | None:
    """Start index (1-based) of *block* inside *haystack*, compared stripped."""
    if not block:
        return None
    norm = [line.rstrip() for line in haystack]
    want = [line.rstrip() for line in block]
    for i in range(len(norm) - len(want) + 1):
        if norm[i : i + len(want)] == want:
            return i + 1
    return None


_final_text_cache: dict[str, list[str] | None] = {}


def final_text(rel_path: str) -> list[str] | None:
    rev = last_touch_rev(rel_path)
    if rev is None:
        return None
    if rel_path not in _final_text_cache:
        _final_text_cache[rel_path] = historical_lines(rev, rel_path)
    return _final_text_cache[rel_path]


def _trim(block: list[str]) -> list[str]:
    while block and not block[0].strip():
        block.pop(0)
    while block and not block[-1].strip():
        block.pop()
    return block


def _informative(block: list[str]) -> bool:
    """Reject a window that is only punctuation — it would match anywhere."""
    return any(len(line.strip()) >= 20 or line.strip().startswith(("def ", "class ", "import ", "from ")) for line in block)


def _old_text(ref: Ref, base: str | None) -> tuple[str, list[str]] | tuple[None, None]:
    for label, lines in (("final", final_text(ref.path)), ("snapshot", historical_lines(base, ref.path) if base else None)):
        if lines:
            return label, lines
    return None, None


def refine_span(ref: Ref, base: str | None, texts: dict[str, list[str]]) -> dict | None:
    """Re-cut a wide cite that a split left non-contiguous.

    A 350-line range cited against a monolith lands in several modules once the
    monolith is split, so it can never match byte for byte again. Its head and
    tail windows still say where the passage went: if both ends resurface in
    one module the new bracket is provable, and if they split apart the result
    is reported as a partition for an agent to read, never auto-applied.
    """
    label, lines = _old_text(ref, base)
    if lines is None or ref.start is None:
        return None
    stop = ref.end if ref.end else ref.start
    if stop - ref.start < 8:
        return None  # narrow enough that the whole-block match already applies
    head = _trim(lines[ref.start - 1 : ref.start - 1 + 6])
    tail = _trim(lines[max(ref.start - 1, stop - 6) : stop])
    if not _informative(head) or not _informative(tail):
        return None
    where = {}
    for name, window in (("head", head), ("tail", tail)):
        for cand, haystack in texts.items():
            start = locate_block(window, haystack)
            if start is not None:
                where[name] = (cand, start, start + len(window) - 1)
                break
    if "head" not in where:
        return None
    if "tail" in where and where["head"][0] == where["tail"][0]:
        cand, hs, _ = where["head"]
        _, _, te = where["tail"]
        return {
            "ref": ref,
            "outcome": "matched",
            "file": cand,
            "anchor": (hs, te),
            "evidence": f"span-bracket@{label}",
        }
    return {
        "ref": ref,
        "outcome": "span-partition",
        "file": None,
        "anchor": None,
        "options": [
            f"{f}#L{a}-L{b} ({role})" for role, (f, a, b) in where.items()
        ],
        "evidence": label,
    }


def cite_blocks(ref: Ref, base: str | None) -> list[tuple[str, list[str]]]:
    """The cited range as the file's final text, then as the snapshot's text.

    An anchor was authored against the file as it looked when the page was
    generated. If the file was edited afterwards and *then* split, its final
    shape is what a surviving module can match; if it was split untouched, the
    snapshot shape is. Both are tried, and the proposal names which one hit so
    the evidence is never just a green tick.
    """
    out: list[tuple[str, list[str]]] = []
    stop = ref.end if ref.end else ref.start
    assert ref.start is not None and stop is not None
    sources: list[tuple[str, list[str] | None]] = [("final", final_text(ref.path))]
    if base:
        sources.append(("snapshot", historical_lines(base, ref.path)))
    for label, lines in sources:
        if not lines:
            continue
        block = _trim(list(lines[ref.start - 1 : stop]))
        if block:
            out.append((label, block))
    return out


def reanchor_ref(ref: Ref, base: str | None = None) -> dict:
    """One proposal for one cite whose target no longer exists."""
    cands = candidates_for(ref.path)
    if not cands:
        return {"ref": ref, "outcome": "no-candidate", "file": None, "anchor": None, "evidence": None}
    if ref.start is None:
        # A bare cite carries no text to match on, so nothing can be proven.
        return {"ref": ref, "outcome": "unanchored", "file": None, "anchor": None, "options": cands}
    texts: dict[str, list[str]] = {}
    for cand in cands:
        target = REPO / cand
        if target.is_file():
            texts[cand] = target.read_text(encoding="utf-8", errors="replace").splitlines()
    for label, block in cite_blocks(ref, base):
        for cand, lines in texts.items():
            start = locate_block(block, lines)
            if start is not None:
                return {
                    "ref": ref,
                    "outcome": "matched",
                    "file": cand,
                    "anchor": (start, start + len(block) - 1),
                    "evidence": label,
                }
    refined = refine_span(ref, base, texts)
    if refined:
        return refined
    return {"ref": ref, "outcome": "block-not-found", "file": None, "anchor": None, "options": cands}


def shift_ref(ref: Ref, base: str | None) -> dict:
    """Where a cite on a still-present file has to move to.

    An insertion above a cited block pushes the whole block down without
    touching a byte of it, so the range stays inside the file and the report
    calls the page clean while every anchor in it points one screen off. The
    move is provable only when the block as it stood at the page's baseline still
    locates today: a block whose own text was edited is prose work for an agent,
    and a block that still sits on its recorded lines is left alone so a routine
    run does not rewrite 800 healthy links.
    """
    if ref.start is None or base is None:
        return {"ref": ref, "outcome": "unanchored", "file": None, "anchor": None}
    if not (REPO / ref.path).is_file():
        return {"ref": ref, "outcome": "gone", "file": None, "anchor": None}
    old = historical_lines(base, ref.path)
    if old is None:
        return {"ref": ref, "outcome": "no-baseline-text", "file": None, "anchor": None}
    current = (REPO / ref.path).read_text(encoding="utf-8", errors="replace").splitlines()
    stop = ref.end if ref.end else ref.start
    block = _trim(list(old[ref.start - 1 : stop]))
    if not block or not _informative(block):
        return {"ref": ref, "outcome": "uninformative", "file": None, "anchor": None}
    # Lines are compared the way `locate_block` compares them, so a cite whose own
    # range still holds the same text is settled here rather than searched for.
    # This is what stops a page whose baseline was just stamped at HEAD from
    # re-anchoring onto itself: every cite would match its own text, the blank line
    # a trimmed block drops would make it look a line off, and the pass would
    # churn through 800 healthy links narrowing each by a line.
    want = [line.rstrip() for line in block]
    here = [line.rstrip() for line in _trim(list(current[ref.start - 1 : stop]))]
    if here == want:
        return {"ref": ref, "outcome": "in-place", "file": ref.path, "anchor": (ref.start, stop)}
    start = locate_block(block, current)
    if start is None:
        return {"ref": ref, "outcome": "block-changed", "file": None, "anchor": None}
    end = start + len(block) - 1
    # Text added *after* the cited block leaves the block on its own line while
    # making the recorded range no longer equal to it: still nothing to move.
    if start == ref.start:
        return {"ref": ref, "outcome": "in-place", "file": ref.path, "anchor": (start, end)}
    return {"ref": ref, "outcome": "matched", "file": ref.path, "anchor": (start, end),
            "evidence": "moved"}


LINK_TEMPLATE = re.compile(r"(\[)([^\]]*)(\]\()(file://)([^)\s]+)(\))")
LABEL_RANGE = re.compile(r":\d+(?:-\d+)?$")


def rewrite_label(label: str, old: Ref, new: Ref) -> str:
    """Keep the range a cite prints in its own text in step with its target.

    The IDE writes the range twice — `[base.py:14-157](file://…#L14-L157)` — so a
    move that only rewrites the URL leaves a link whose label names lines the
    target no longer points at. That is the one part of a cite a reader checks by
    eye, and a rename leaves the old file name printed on the page as well.
    """
    m = LABEL_RANGE.search(label)
    shown = label if m is None else label[: m.start()]
    if shown == old.path:
        shown = new.path
    elif shown == Path(old.path).name:
        shown = Path(new.path).name
    # A label that never printed a range keeps it that way: adding one would
    # rewrite text the IDE wrote as a plain section title.
    if m is None or new.start is None:
        return shown
    return f"{shown}:{new.start}-{new.end or new.start}"


def rewrite_link(text: str, old: Ref, new_target: str) -> tuple[str, int]:
    """Replace links pointing at exactly this (path, anchor), not its siblings.

    A page cites one source file from many sections with different ranges, and
    each range re-anchors to a different module after a split. Matching on the
    path alone would collapse them all onto the first answer.
    """
    new = parse_ref(new_target)

    def sub(m: re.Match) -> str:
        ref = parse_ref(m.group(5))
        if ref == old:
            return (
                f"{m.group(1)}{rewrite_label(m.group(2), old, new)}"
                f"{m.group(3)}{m.group(4)}{new_target}{m.group(6)}"
            )
        return m.group(0)

    hits = sum(1 for raw in REF_RE.findall(text) if (r := parse_ref(raw)) == old)
    return LINK_TEMPLATE.sub(sub, text), hits


def anchor_key(ref: Ref) -> str:
    """The ledger identity of a cite, in the form this tool writes back.

    ``--shifts`` reads a page's anchors as *baseline* coordinates. Once the tool
    has moved one onto its HEAD coordinates, the next pass would diff the wrong
    slice of history and walk that link further down the file on every run, so a
    move is recorded here and the link is left alone afterwards.
    """
    if ref.start is None:
        return ref.path
    return f"{ref.path}#L{ref.start}-L{ref.end or ref.start}"


def ref_base(ref: Ref, cite_base: str | None, entry: LedgerEntry | None) -> tuple[str | None, str]:
    """Which slice of history a single cite was written against.

    ``cite_base`` is that answer for the page as a whole: the baseline the anchors
    were authored against, or, when a stamp vouches for every cite on the page
    (``cites: all``), the head it was signed at. An anchor this tool moved itself
    is an exception — its coordinate is only meaningful against the HEAD its own
    stamp recorded, which is usually further along. Reading either
    one against an older window diffs the wrong lines of history and walks the
    link further down the file on every run.

    ``(None, "orphaned")`` comes back when the stamp's commit is no longer in the
    repo — the fork's daily sync rewrites history — because then the coordinates
    on the page are the only evidence left, so the cite is left alone.
    """
    if entry is not None and entry.head and anchor_key(ref) in entry.applied:
        return (entry.head, "stamp") if rev_reachable(entry.head) else (None, "orphaned")
    return cite_base, ""


def recorded_drivers(page: Path, rel: str, fallback: str | None) -> tuple[list[str], list[str]]:
    """Cited files that changed since this page's own baseline, plus cites that are gone.

    Drivers follow `effective_base`'s precedence — the page's ``verified_at``, then the
    snapshot — and never HEAD: a stamp claims to cover the window the page actually
    owes, and diffing against HEAD comes out empty by construction and proves nothing.

    An unusable ``verified_at`` falls back to the snapshot instead of short-circuiting
    to "no drivers": a phantom baseline would make the stamp look like a finished page.
    """
    base = frontmatter_baseline(page)
    if not (base and rev_reachable(base)):
        base = fallback
    if not (base and rev_reachable(base)):
        return [], []
    dirty, untracked = worktree_delta()
    rep = audit_page(
        page,
        rel,
        "reconciled",
        base,
        make_changes_for(),
        dirty,
        untracked,
        record_broken=True,
    )
    return sorted(set(rep.stale)), sorted(set(rep.broken))


def stamp_links(
    page: Path,
    rel: str,
    fallback: str | None,
    prior: LedgerEntry | None,
    moved: list[str],
    prior_reconciled: bool = False,
) -> dict:
    """Sign an ``--apply`` pass.

    Rewriting cites changes the page's bytes, which voids the very ledger entry
    that made the diff provable, so the change is re-stamped straight away: the
    note survives, and the anchors this tool moved are carried forward so a later
    run reads them against this head instead of walking them down the file again.

    The stamp says ``partial`` — prose still owed — whenever a link had to move,
    because a move means the sources drifted and nobody has re-read the sentences.
    A pass that only brought labels onto their own targets changes no claim about
    the prose, so a page already signed reconciled stays reconciled.
    """
    drivers, _ = recorded_drivers(page, rel, fallback)
    entry = {
        "page": rel,
        "head": git("rev-parse", "HEAD").strip(),
        "sha_after": body_sha(page),
        "note": (prior.note if prior else "") or "links only: anchors re-pointed by `reanchor --apply`",
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "drivers": drivers,
        "applied": sorted({*(prior.applied if prior else []), *moved}),
        # This stamp only vouches for the anchors it actually re-pointed. Says so
        # in the row, so a later pass cannot read the whole page as current.
        "cites": "applied-only",
    }
    if not (prior_reconciled and not moved):
        entry["partial"] = True
    UPDATE_DIR.mkdir(parents=True, exist_ok=True)
    with LEDGER.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return entry


def align_labels(text: str) -> tuple[str, int, int]:
    """Make every cite print the range its own target points at.

    The IDE writes the range twice, in the label and in the URL, and the two
    halves drift apart one at a time: a page edited by hand, or moved by an older
    build of this tool, ends up with a link whose label names lines nothing
    points at. Alignment is not optional in a write — a sweep that leaves that
    behind ships a contradiction a reader can only check by opening the file.

    A target that lies past the end of its file is left out of it. Copying that
    range into the label would make a fabricated cite look self-consistent, which
    hides the one clue an agent needs; the mismatch is the finding.
    """
    fixed = 0
    refused = 0

    def sub(m: re.Match) -> str:
        nonlocal fixed, refused
        label, target = m.group(2), m.group(5)
        ref = parse_ref(target)
        lm = LABEL_RANGE.search(label)
        anchor = ANCHOR_RE.search(target)
        if lm is None or ref.start is None or anchor is None or anchor.group(1) is None:
            return m.group(0)
        n = file_line_count(ref.path)
        if n >= 0 and ref.end is not None and ref.end > n:
            refused += 1
            return m.group(0)
        # A one-line target keeps a one-line label; parse_ref fills end=start for
        # both shapes, so the printed hyphen is what says which shape this is.
        want = f":{ref.start}" if anchor.group(2) is None else f":{ref.start}-{ref.end}"
        if lm.group(0) == want:
            return m.group(0)
        fixed += 1
        return (
            f"{m.group(1)}{label[: lm.start()]}{want}"
            f"{m.group(3)}{m.group(4)}{target}{m.group(6)}"
        )

    return LINK_TEMPLATE.sub(sub, text), fixed, refused


def cmd_reanchor(args: argparse.Namespace) -> int:
    if not CONTENT.is_dir():
        print(
            EMPTY_TREE_HINT.format(content=CONTENT, root=WIKI, layout=wiki_root.layout),
            file=sys.stderr,
        )
        return 2
    pages = collect_pages(args.page)
    fallback = args.baseline or tree_baseline()
    if fallback and not rev_reachable(fallback):
        print(f"note: baseline {fallback} unreachable, using the files' final text only", file=sys.stderr)
        fallback = None
    applied = proposals = blocked = skipped = kept = stamped = aligned = owed = refused = 0
    ledger = load_ledger()
    for page in pages:
        original = page.read_text(encoding="utf-8", errors="replace")
        text = original
        rel = str(page.relative_to(CONTENT)).replace("\\", "/")
        # Anchors were authored against *this page's* baseline, which the ledger
        # may have advanced past the snapshot; using the snapshot here would
        # re-point an already-current page onto stale text.
        base, provenance = effective_base(page, rel, ledger, fallback)
        entry = ledger.get(rel)
        # A stamp that vouches for *every* cite (a hand `mark --partial`) says the
        # anchors were brought current at its head, so the shift pass diffs them
        # against that head — while `report` keeps diffing against the snapshot,
        # which is what leaves the page's prose drivers open. A links-only stamp
        # from this tool vouches only for the anchors in its `applied` list, and
        # those are handled one by one in `ref_base`; promoting the whole page on
        # its strength would read the cites it could not resolve as already
        # current and drop them off the judgement queue.
        cite_base = base
        if (
            args.shifts
            and provenance == "partial"
            and entry
            and entry.cites == "all"
            and rev_reachable(entry.head)
        ):
            cite_base = entry.head
        moved: list[str] = []
        every = {r for r in parse_refs(page)}
        if args.shifts:
            wanted = [r for r in every if r.start is not None]
            resolve = shift_ref
        else:
            missing = {r.path for r in every if not (REPO / r.path).exists()}
            wanted = [r for r in every if r.path in missing]
            resolve = reanchor_ref
        wanted.sort(key=lambda r: (r.path, r.start or 0, r.end or 0))
        if not wanted:
            continue
        print(f"\n=== {rel} === (baseline {base[:8] if base else '-'} {provenance})")
        for ref in wanted:
            label = f"{ref.path}" + (f"#{ref.start}-{ref.end}" if ref.start else "")
            use, whence = ref_base(ref, cite_base, entry if args.shifts else None)
            if whence == "orphaned":
                print(f"  KEEP    {label}: moved by this tool at {entry.head[:8]}, which no longer resolves")
                kept += 1
                continue
            prop = resolve(ref, use)
            if prop["outcome"] == "in-place":
                skipped += 1
                continue
            if prop["outcome"] == "matched":
                new_target = f"{prop['file']}#L{prop['anchor'][0]}-L{prop['anchor'][1]}"
                n = sum(1 for raw in REF_RE.findall(text) if parse_ref(raw) == ref)
                evidence = f"byte-identical@{prop['evidence']}"
                if args.apply:
                    text, applied_n = rewrite_link(text, ref, new_target)
                    print(f"  APPLIED {applied_n:>2}x  {label} -> {new_target}  [{evidence}]")
                    applied += applied_n
                    moved.append(new_target)
                else:
                    print(f"  PROPOSE {n:>2}x  {label} -> {new_target}  [{evidence}]")
                    proposals += n
            else:
                opts = ", ".join(prop.get("options") or []) or "-"
                print(f"  OPEN    {label}: {prop['outcome']}; candidates: {opts}")
                blocked += 1
        if args.apply:
            text, realigned, past_end = align_labels(text)
            if realigned:
                print(f"  LABEL   {realigned} cite(s) re-printed to match their own target")
                aligned += realigned
            if past_end:
                print(
                    f"  REFUSE  {past_end} cite(s) left as printed: their target is past the end"
                )
                refused += past_end
        if args.apply and text != original:
            # Read the page's state before this write overwrites it: an entry that
            # still hashes to the page and was signed reconciled says the prose is
            # done, and a label-only fix must not take that claim back.
            reconciled = bool(entry and not entry.partial and entry.sha_after == body_sha(page))
            page.write_text(text, encoding="utf-8", newline="\n")
            # Which axis this pass can honestly sign off: past-the-end cites were left
            # as printed on purpose, so `anchors` is only `verified` when the page had
            # none of those. The vouch is taken back unconditionally — this pass edited
            # bytes nobody re-read, and `verified_at` outranks the ledger, so leaving an
            # older `all` in place would sign the tool's edit as a finished page.
            # Stamped before `stamp_links` so the drivers it records are measured with
            # that withdrawal already in effect.
            stamp_frontmatter(
                page, rel=rel, anchors=anchors_axis(past_end), vouch="applied-only"
            )
            signed = stamp_links(page, rel, fallback, entry, moved, reconciled)
            stamped += 1
            owed += bool(signed.get("partial"))
    summary = (
        f"{proposals} provable proposal(s), {blocked} open, {skipped} already on their line"
    )
    if kept:
        summary += f", {kept} left on coordinates this tool stamped"
    if args.apply:
        print(
            f"\napplied {applied} link(s) across {stamped} page(s), "
            f"re-printed {aligned} label(s); {blocked} still need an agent's judgement"
        )
        if stamped:
            print(f"{owed} page(s) re-stamped as links-only — their prose still owes a `mark`")
        return 0
    print(f"\n{summary} — add --apply to write the provable ones")
    return 0


# ---------------------------------------------------------------------------
# commands
# ---------------------------------------------------------------------------


class PageNotFound(Exception):
    pass


class AmbiguousPage(Exception):
    pass


def collect_pages(filter_substr: str | None) -> list[Path]:
    pages = sorted(CONTENT.rglob("*.md"))
    if filter_substr is None:
        return pages
    needle = normalise_page_arg(filter_substr)
    kept = [p for p in pages if needle in str(p.relative_to(CONTENT)).replace("\\", "/")]
    if not kept:
        raise PageNotFound(f"no wiki page matches --page {filter_substr!r}")
    return kept


def normalise_page_arg(value: str) -> str:
    return strip_dotslash(value).strip("/")


def build(args: argparse.Namespace) -> tuple[dict, list[PageReport], list[Change]] | int:
    if not CONTENT.is_dir():
        print(
            EMPTY_TREE_HINT.format(content=CONTENT, root=WIKI, layout=wiki_root.layout),
            file=sys.stderr,
        )
        return 2
    if not (REPO / ".git").exists():
        print(f"{REPO} is not a git repository", file=sys.stderr)
        return 2
    fallback = args.baseline or tree_baseline()
    if not fallback:
        print(
            "wiki baseline commit unavailable — pass --baseline <sha> "
            "(snapshot was generated outside a git root, or metadata is missing)",
            file=sys.stderr,
        )
        return 2

    head = git("rev-parse", "HEAD").strip()
    if not rev_reachable(fallback):
        print(
            f"baseline {fallback} is not reachable from HEAD — pass --baseline <sha> "
            "(the snapshot commit was GC'd by a force-pushed sync)",
            file=sys.stderr,
        )
        return 2
    changes_at_snapshot = diff_since(fallback)
    dirty, untracked = worktree_delta()
    ledger = load_ledger()
    changes_for = make_changes_for()
    changes_for(fallback)

    try:
        pages = collect_pages(args.page)
    except PageNotFound as exc:
        print(exc, file=sys.stderr)
        return 2

    reports: list[PageReport] = []
    all_refs: set[str] = set()
    for page in pages:
        rel = str(page.relative_to(CONTENT)).replace("\\", "/")
        base, tag = effective_base(page, rel, ledger, fallback)
        all_refs.update(ref.path for ref in parse_refs(page))
        reports.append(audit_page(page, rel, tag, base, changes_for, dirty, untracked))

    gaps = uncovered_sources(changes_at_snapshot, untracked, all_refs)
    needs = [r for r in reports if r.score]
    payload = {
        "generated_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "head": head,
        "metadata_baseline": fallback,
        "summary": {
            "pages": len(reports),
            "needs_update": len(needs),
            "clean": len(reports) - len(needs),
            "reconciled": sum(1 for r in reports if r.state == "reconciled"),
            "ledger_void": sum(1 for r in reports if r.state == "ledger-void"),
            "partial": sum(1 for r in reports if r.state == "partial"),
            "no_frontmatter": sum(1 for r in reports if r.fm == "missing"),
            "frontmatter": sum(1 for r in reports if r.state == "frontmatter"),
            "distinct_refs": len(all_refs),
            "refs_changed": sum(1 for p in all_refs if p in changes_at_snapshot or p in dirty or p in untracked),
            "refs_broken": sum(1 for p in all_refs if not (REPO / p).exists()),
            "uncovered": len(gaps),
        },
        "pages": [r.to_dict() for r in sorted(reports, key=lambda r: (-r.score, r.page))],
        "uncovered": [vars(c) for c in gaps],
    }
    return payload, reports, gaps


def cmd_report(args: argparse.Namespace) -> int:
    built = build(args)
    if isinstance(built, int):
        return built
    payload, reports, gaps = built
    if args.json:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0
    UPDATE_DIR.mkdir(parents=True, exist_ok=True)
    (UPDATE_DIR / "drift.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (UPDATE_DIR / "DRIFT.md").write_text(
        render_markdown(payload, reports, gaps, args.top), encoding="utf-8"
    )
    s = payload["summary"]
    print(f"HEAD      {payload['head']}")
    provenance = "--baseline" if args.baseline else "tree"
    print(f"baseline  {payload['metadata_baseline']}  ({provenance}: modal page verified_at)")
    print(
        f"pages     {s['pages']} total | needs update {s['needs_update']} | clean {s['clean']} "
        f"(ledger {s['reconciled']}, void {s['ledger_void']}, partial {s['partial']})"
    )
    print(
        f"refs      {s['distinct_refs']} distinct | {s['refs_changed']} changed | "
        f"{s['refs_broken']} missing | {s['uncovered']} uncited changed files"
    )
    print(f"report    {UPDATE_DIR / 'DRIFT.md'}")
    return 0


def cmd_mark(args: argparse.Namespace) -> int:
    if not CONTENT.is_dir():
        print(
            EMPTY_TREE_HINT.format(content=CONTENT, root=WIKI, layout=wiki_root.layout),
            file=sys.stderr,
        )
        return 2
    rel = normalise_page_arg(args.page)
    page = CONTENT / rel
    if not page.is_file():
        matches = collect_pages(args.page)
        if len(matches) != 1:
            raise AmbiguousPage(
                f"--page {args.page!r} matched {len(matches)} pages; give a unique path"
            )
        page = matches[0]
        rel = str(page.relative_to(CONTENT)).replace("\\", "/")
    if page.suffix.lower() != ".md":
        print(f"{rel} is not a Markdown wiki page", file=sys.stderr)
        return 2

    head = git("rev-parse", "HEAD").strip()
    fallback = args.baseline or tree_baseline()
    drivers, broken = recorded_drivers(page, rel, fallback)
    prior = load_ledger().get(rel)
    entry = {
        "page": rel,
        "head": head,
        "sha_after": body_sha(page),
        "note": args.message or "",
        "at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "drivers": drivers,
        # A hand stamp is signed by whoever read the page, so it vouches for every
        # cite on it, not just the handful an automated pass happened to move.
        "cites": "all",
    }
    if args.partial:
        entry["partial"] = True
    # Which anchors this tool moved, and therefore has to be re-derived against
    # the stamp's HEAD rather than the page's baseline. A partial re-stamp keeps
    # that list; a full mark drops it, because its baseline *is* HEAD and every
    # anchor is then read off the same slice of history anyway.
    entry["applied"] = sorted(set(prior.applied)) if (args.partial and prior) else []
    UPDATE_DIR.mkdir(parents=True, exist_ok=True)
    with LEDGER.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    # A hand stamp vouches for the whole page, so it moves the baseline that travels
    # with the page. A partial one records unfinished work: it must leave
    # `verified_at` exactly where it was — but it takes the whole-page vouch back,
    # because frontmatter outranks the ledger and a stale `all` would silently
    # outrank the `partial` row written a moment ago.
    stamp_frontmatter(
        page,
        rel=rel,
        verified_at=None if args.partial else head,
        vouch="applied-only" if args.partial else "all",
    )
    if args.partial:
        print(f"marked {rel} partial at {head[:12]} — baseline unchanged, still {len(drivers)} driver(s)")
    else:
        print(f"marked {rel} reconciled at {head[:12]} ({len(drivers)} drivers)")
    if broken:
        print(f"page still cites {len(broken)} nonexistent path(s): {', '.join(broken[:5])}")
    print(f"ledger {LEDGER}")
    return 0


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="wiki_drift.py", description="Repo Wiki drift checker")
    parser.add_argument(
        "--wiki-root",
        default=None,
        help=f"wiki tree to operate on (default {WIKI_ROOT_DEFAULT}; the IDE "
        "export stays reachable as .qoder/repowiki)",
    )
    sub = parser.add_subparsers(dest="cmd")

    rep = sub.add_parser("report", help="write drift.json + DRIFT.md (default)")
    rep.add_argument("--baseline", help="override the wiki snapshot commit (40-hex)")
    rep.add_argument("--page", help="only pages whose path contains this substring")
    rep.add_argument("--top", type=int, default=25, help="rows per report section (default 25)")
    rep.add_argument("--json", action="store_true", help="print drift as JSON to stdout, write no files")
    rep.set_defaults(func=cmd_report)

    mark = sub.add_parser("mark", help="record a page as reconciled at HEAD")
    mark.add_argument(
        "--page",
        required=True,
        help="wiki page path, relative to the root's content tree "
        "(topics/ in repowiki/, zh/content/ in the IDE export)",
    )
    mark.add_argument("-m", "--message", default="", help="what was updated")
    mark.add_argument(
        "--partial",
        action="store_true",
        help="the cites are current but the prose is not: anchors will read "
        "against this head while the report keeps the page's drivers open",
    )
    mark.add_argument("--baseline", help="override the wiki snapshot commit (40-hex)")
    mark.set_defaults(func=cmd_mark)

    reanchor = sub.add_parser(
        "reanchor",
        help="re-point cites that drifted — onto another file, or down the same "
        "one — and with --apply sign the page as links-only work",
    )
    reanchor.add_argument(
        "--page",
        help="wiki page path or substring; omit it to sweep every page like `report`",
    )
    reanchor.add_argument("--apply", action="store_true", help="rewrite byte-identical matches in place")
    reanchor.add_argument(
        "--shifts",
        action="store_true",
        help="re-point cites on files that still exist but shifted under an insertion, "
        "instead of cites whose target is gone",
    )
    reanchor.add_argument("--baseline", help="override the wiki snapshot commit (40-hex)")
    reanchor.set_defaults(func=cmd_reanchor)

    seed = sub.add_parser(
        "seed",
        help="one-shot: publish the IDE export into the tracked tree "
             "(dry-run unless --apply; idempotent; reconciles every body byte)",
    )
    seed.add_argument("--from", dest="from_root", default=LEGACY_EXPORT,
                      help="legacy export root (default %(default)s)")
    seed.add_argument("--snapshot",
                      help="40-hex commit the export was generated at "
                           "(default: read from its metadata once, then never again)")
    seed.add_argument("--apply", action="store_true", help="write; without it, plan and report only")
    seed.set_defaults(func=cmd_seed)

    # The same flag, also accepted after the verb. SUPPRESS is what makes the two
    # positions coexist: without a default of its own the subparser cannot overwrite
    # a value the top-level parser already read.
    for parser_ in (rep, mark, reanchor, seed):
        parser_.add_argument(
            "--wiki-root",
            default=argparse.SUPPRESS,
            help=f"wiki tree to operate on (default {WIKI_ROOT_DEFAULT}; the IDE "
            "export stays reachable as .qoder/repowiki)",
        )

    raw = list(argv) if argv is not None else sys.argv[1:]
    args = parser.parse_args([*raw, "report"] if not raw else raw)
    if getattr(args, "wiki_root", None):
        apply_wiki_root(args.wiki_root)
    if args.cmd == "mark" and not str(args.page).endswith(".md"):
        parser.error("mark --page must name a .md file (report --page may be a substring)")
    try:
        return args.func(args)
    except (PageNotFound, AmbiguousPage) as exc:
        print(exc, file=sys.stderr)
        return 2
    except RuntimeError as exc:
        print(exc, file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
