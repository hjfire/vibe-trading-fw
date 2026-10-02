# Repo Wiki M3（新鲜度机器：`stale` 队列 / `index` 生成器 / 门禁脚本 / fork 工作流）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 M2 播种好的 `repowiki/` 装上「谁过期了 / 导航是否确定性 / 水位有没有恶化」这三台机器，并让第一次有 CI 真的收集这个仓库自有的测试套件。

**Architecture:** 全部复用 M1/M2 已有的取数层：`build(args)` 已经是「一次 git、按页分配」的批处理，`stale` 只是它的队列视图 + 一个每页基线的 commit 计数缓存；`index` 是磁盘树的确定性投影，不写时间戳；门禁脚本只读，工作流是新文件。写盘动词一律经过 `write_refusal()` 同一个判据。

**Tech Stack:** Python 3.13 标准库（`argparse`/`ast`/`subprocess`/`json`/`pathlib`，**无 pyyaml、无新依赖**）、pytest、bash、GitHub Actions。

**Spec:** `docs/superpowers/specs/2026-10-01-repo-wiki-rebuild-design.md` —— §6 表的 `stale`/`index` 两行、§9.1 的门禁脚本与工作流、§5.3 的 `INDEX.md` 形状、§10 里程碑表 M3 那一行是本计划的授权来源；计划与 spec 冲突时以 spec 为准。

## Global Constraints

- **上游文件零改动**（用户原话：「开发部分不要动需要同步的开源程序原部分」）：`.gitignore`、`tools/ci_grep_gates.sh`、`.github/workflows/test.yml`、`wiki/**` 一律不得出现在 `git diff --name-only upstream/main...HEAD` 里。完工判据每次都复查这一条。
- 不新增第三方依赖；`tools/wiki_drift.py` 保持纯标准库。
- 商标字面量不得出现在 fork 自有的发布/实测文本面（`repowiki/**`、`docs/**` 之外的 `.md`）；测试里必须运行时拼接（`"".join(["World","Quant"])` 一类）。
- 每个提交 `git commit -s`（DCO）；**永不 `--no-verify`**；**永不 push**（本 fork 的既定状态：`origin/main` 落后本地，从未推送）。
- 中文文案；代码、命令、路径、标识符保留原文。
- 五条不可回退的既有契约（M2 用事故换来的，`repowiki/README.md` §五）：`cites` 只有 `all` 才推进报表基线、`partial` 不推进报表基线、`ledger-void` 按正文 sha 判定、行数口径 `换行数+1`、`--page` 不得越出 content 树。**M3 的 `stale` 队列不得成为第六条被稀释的契约**（见 Task 1 的「不藏活」用例）。
- 阈值哲学（spec §9.1）：门禁初值 = 当前实测水位，**只降不升**，首轮 `continue-on-error`。

**实测起点（2026-10-02 @`8d0c4119`）**：`report` = `pages 450 | needs update 445 | clean 5 (ledger 1, void 0, partial 423)`，state 分布 `partial 423 / stale 22 / clean 4 / reconciled 1`；`drift.json` summary 键序 = `pages needs_update clean reconciled ledger_void partial no_frontmatter frontmatter distinct_refs refs_changed refs_broken uncovered`；`stale` 与 `index` 两个动词**尚不存在**。

---

### Task 1: `stale` 子命令的队列语义（含「不藏活」契约）

**Files:**
- Modify: `tools/wiki_drift.py`（在 `cmd_report`（:2157）之后新增 `queue_reason()` / `cmd_stale()`；在 `main()`（:2291）注册 subparser）
- Test: `tools/test_wiki_drift.py`（在 `# write-back` 段之后、约 :2270 起新增一段）

**Interfaces:**
- Consumes: `build(args) -> dict | tuple[dict, list[PageReport], list[Change]]`（:2065，读 `args.baseline` 与 `args.page`）、`PageReport`（:1157，字段 `page/state/base/refs/fm/stale/broken/anchors/score`）。
- Produces: `queue_reason(rep: PageReport) -> str | None`（返回 `"sources-changed"|"refs-missing"|"anchors-open"|"prose-unverified"|None`）、`cmd_stale(args) -> int`、CLI 动词 `stale [--page SUB] [--baseline REV] [--top N] [--json] [--format queue|count]`。Task 2 会往同一函数里加 `commits_since`，Task 4 的门禁脚本消费 `--format count`。

- [ ] **Step 1: 写失败的用例 —— 四种 reason 与「正文未核也必须进队列」**

追加到 `tools/test_wiki_drift.py`（`repo_wired` 已有单页语料；`partial` 用台账行造）：

```python
def _args(**kw):
    """An argparse-shaped namespace: `build()` reads attributes, not a dict."""
    ns = argparse.Namespace(baseline=None, page=None, top=25, json=False, fmt="queue")
    for k, v in kw.items():
        setattr(ns, k, v)
    return ns


def test_a_page_with_no_drift_but_unverified_prose_is_still_queued(repo_wired, capsys):
    """The 414-to-3 trap, made permanent.

    A page the ledger marks `partial` (anchors moved, prose never re-read) has score 0,
    so `report`'s `needs_update` does not count it. If `stale` filtered on the same
    score, the queue would read 22 while the water level is 445 and M5 would be handed
    a list that quietly omits 423 pages — which is the exact failure this project has
    already been burned by once, where a stamp hid work the tool could not do itself.
    """
    head = repo_wired["head"]
    wiki_drift.LEDGER.parent.mkdir(parents=True, exist_ok=True)
    with wiki_drift.LEDGER.open("a", encoding="utf-8") as fh:
        fh.write(json.dumps({
            "page": "前端应用/模块说明.md", "head": head, "sha_after": "",
            "note": "anchors only", "cites": "applied-only", "partial": True,
        }, ensure_ascii=False) + "\n")
    rc = wiki_drift.cmd_stale(_args())
    assert rc == 0
    out = capsys.readouterr().out
    assert "前端应用/模块说明.md" in out
    assert "prose-unverified" in out
    assert "1" in out.splitlines()[-1], out.splitlines()


def test_the_queue_count_is_not_report_needs_update(repo_wired):
    """Two different numbers, both honest: `count` counts prose debt, `needs_update`
    counts drift. Pinning them apart is what stops a future refactor from merging the
    two predicates and silently dropping 423 pages again."""
    ns = _args()
    built = wiki_drift.build(ns)
    payload, reports, _ = built
    queue = [r for r in reports if wiki_drift.queue_reason(r) is not None]
    assert payload["summary"]["needs_update"] == len(
        [r for r in reports if r.score])
    assert len(queue) >= payload["summary"]["needs_update"]
    for rep in reports:
        if rep.score:
            assert wiki_drift.queue_reason(rep) in (
                "sources-changed", "refs-missing", "anchors-open"), rep.page


def test_queue_reason_prefers_the_reason_that_carries_the_most_work(repo_wired):
    """Order matters: a page with both changed sources and an open anchor is
    `sources-changed`, because that is the reason that requires re-reading prose."""
    changed = repo_wired["page"].with_name("漂移.md")
    changed.write_text(
        "# 漂移\n\n<cite>\n- [alpha](file://src/mod.py#L3-L4)\n</cite>\n", encoding="utf-8")
    rep = wiki_drift.PageReport(
        page="漂移.md", state="stale", base=repo_wired["head"], refs=1,
        stale=["src/mod.py"], broken=["src/gone.py"], anchors=["L9"])
    assert wiki_drift.queue_reason(rep) == "sources-changed"
    rep.stale = []
    assert wiki_drift.queue_reason(rep) == "refs-missing"
    rep.broken = []
    assert wiki_drift.queue_reason(rep) == "anchors-open"
    rep.anchors = []
    assert wiki_drift.queue_reason(rep) is None
    rep.state = "ledger-void"
    assert wiki_drift.queue_reason(rep) == "prose-unverified"
```

- [ ] **Step 2: 跑到红**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q -k "queue_reason or queue_count or no_drift_but_unverified"`
Expected: FAIL —— `AttributeError: module 'tools.wiki_drift' has no attribute 'queue_reason'`（若 `argparse`/`json` 未在测试文件顶部导入，先补 `import argparse`；`json` 已导入）。

- [ ] **Step 3: 实现 `queue_reason()` 与 `cmd_stale()`**

在 `tools/wiki_drift.py` 的 `cmd_report` 之后插入：

```python
QUEUE_REASONS = ("sources-changed", "refs-missing", "anchors-open", "prose-unverified")


def queue_reason(rep: PageReport) -> str | None:
    """Why this page belongs in the rewrite queue, or None when it does not.

    The order is a policy, not an accident: drift (a source moved) outranks an open
    anchor, because the first needs a human to re-read prose and the second can be
    fixed by `reanchor`. `prose-unverified` is the last test and catches the pages a
    score-based filter would drop — a `partial` page with every link healthy is exactly
    the shape M2 left 423 of, and a queue that hides it hands M5 a 22-page list and
    calls the corpus clean.
    """
    if rep.stale:
        return "sources-changed"
    if rep.broken:
        return "refs-missing"
    if rep.anchors:
        return "anchors-open"
    if rep.state in ("partial", "ledger-void"):
        return "prose-unverified"
    return None


def cmd_stale(args: argparse.Namespace) -> int:
    """The M5 work queue: every page whose prose is not known-good at HEAD.

    Reads the same `build()` pass `report` uses — one batch of git calls per distinct
    baseline, never one per page — and prints the subset in a stable order. It writes
    nothing, so it is legal on a read-only root.
    """
    built = build(args)
    if isinstance(built, int):
        return built
    payload, reports, _gaps = built
    queue = []
    for rep in reports:
        reason = queue_reason(rep)
        if reason is None:
            continue
        queue.append({
            "page": rep.page,
            "reason": reason,
            "state": rep.state,
            "base": rep.base,
            "changed_sources": sorted(rep.stale),
            "missing_sources": sorted(rep.broken),
            "open_anchors": len(rep.anchors),
            "score": rep.score,
        })
    queue.sort(key=lambda row: (-len(row["changed_sources"]), row["page"]))

    if getattr(args, "json", False):
        print(json.dumps({"head": payload["head"], "baseline": payload["metadata_baseline"],
                          "count": len(queue), "reasons": dict(
                              (r, sum(1 for q in queue if q["reason"] == r))
                              for r in QUEUE_REASONS),
                          "queue": queue}, ensure_ascii=False, indent=2))
        return 0
    if args.fmt == "count":
        print(len(queue))
        return 0

    shown = queue[: args.top]
    tally = ", ".join(f"{r} {sum(1 for q in queue if q['reason'] == r)}"
                      for r in QUEUE_REASONS
                      if any(q["reason"] == r for q in queue))
    print(f"stale queue: {len(queue)} pages "
          f"(threshold-shaped count, not `report`'s needs_update {payload['summary']['needs_update']})")
    print(f"  by reason: {tally or 'empty'}")
    for row in shown:
        changed = ",".join(row["changed_sources"][:3]) or "-"
        print(f"  {row['page']} [{row['reason']}] state={row['state']} "
              f"changed={changed} missing={len(row['missing_sources'])} "
              f"anchors={row['open_anchors']}")
    if len(queue) > len(shown):
        print(f"  ... {len(queue) - len(shown)} more (--top N)")
    print(len(queue))
    return 0
```

注册动词（`main()` 里，紧跟 `seed` 的 subparser 之后，且**必须**把 `stale` 加进 :2360 那个 `for parser_ in (...)` 元组，否则 `--wiki-root` 不能写在动词之后）：

```python
    stale = sub.add_parser("stale", help="print the rewrite queue (reads only; writes nothing)")
    stale.add_argument("--page", help="only pages whose path contains this substring")
    stale.add_argument("--baseline", help="override the wiki snapshot commit (40-hex)")
    stale.add_argument("--top", type=int, default=25, help="rows printed (default 25)")
    stale.add_argument("--json", action="store_true", help="emit the queue as JSON")
    stale.add_argument("--format", dest="fmt", choices=("queue", "count"), default="queue",
                       help="'count' prints one integer for the CI gate")
    stale.set_defaults(func=cmd_stale)
```

- [ ] **Step 4: 三条用例转绿**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q -k "queue_reason or queue_count or no_drift_but_unverified"`
Expected: `3 passed`

- [ ] **Step 5: 真树对账（spec §10 M3 判据的前半）**

Run:
```bash
python -X utf8 tools/wiki_drift.py stale --format count
python -X utf8 tools/wiki_drift.py stale --json | python -X utf8 -c "import json,sys; d=json.load(sys.stdin); print(d['count'], d['reasons'])"
```
Expected: 第一个输出 **445**；第二个的 `reasons` 里 `sources-changed + prose-unverified + refs-missing + anchors-open` 之和 = 445。若 445 对不上，**停在这里**：数字对不上说明搬迁或基线判定错了（spec §10 明写这一条是 M2 搬迁正确性的复查），不要把下一个任务的活带过去。

- [ ] **Step 6: 提交**

```bash
git add tools/wiki_drift.py tools/test_wiki_drift.py
git commit -s -m "feat(wiki): stale 队列 —— 正文未核也算过期，计数不许与 report 的 needs_update 混同"
```

---

### Task 2: `commits_since` —— 批量取数，且用一条用例钉住「不许每页调一次 git」

**Files:**
- Modify: `tools/wiki_drift.py`（在 `diff_since`（:285）附近新增 `commits_touching()`；在 `make_changes_for`（:1284）附近新增 `make_commits_counter()`；`cmd_stale` 的行字典多一个 `commits_since` 键）
- Test: `tools/test_wiki_drift.py`

**Interfaces:**
- Consumes: `git(*args) -> str`（:234，已带 `-C REPO -c core.quotepath=off`）、`PageReport.base`、`PageReport.stale`。
- Produces: `commits_touching(base: str) -> dict[str, list[str]]`（路径 → 触及它的 commit 全哈希）、`make_commits_counter() -> Callable[[str, list[str]], int]`（带 per-base 缓存）；`cmd_stale` 每行 JSON 含 `commits_since: int`。Task 3 的 `index` 不用它。

- [ ] **Step 1: 写失败的用例**

```python
def test_commits_since_counts_the_commits_that_moved_a_pages_sources(repo_wired):
    """Two commits touch the cited file, so the page's queue row must say 2 — the field
    is what M5 shards the rewrite by, and a row that reads 0 would look finished."""
    for i in range(2):
        (repo_wired["root"] / "src" / "mod.py").write_text(
            (repo_wired["root"] / "src" / "mod.py").read_text(encoding="utf-8")
            + f"\n# drift {i}\n", encoding="utf-8")
        _git(repo_wired["root"], "add", "-A")
        _git(repo_wired["root"], "commit", "-m", f"drift {i}")
    page = repo_wired["page"]
    page.write_text(page.read_text(encoding="utf-8").replace(
        "#L3-L4", "#L9-L10"), encoding="utf-8")
    _git(repo_wired["root"], "add", "-A")
    _git(repo_wired["root"], "commit", "-m", "move the citation")
    rows = _stale_json()
    row = [r for r in rows["queue"] if r["page"] == "前端应用/模块说明.md"]
    assert row, rows["queue"]
    assert row[0]["commits_since"] >= 2, row[0]


def test_stale_makes_one_git_log_per_distinct_baseline_not_per_page(repo_wired, monkeypatch):
    """Anti-N-plus-1: 450 pages x a subprocess each is minutes, and the spec forbids it.

    The cache is what makes the batch real, so this counts `git log` calls while every
    page in the tree shares one baseline: one call, not one per page. Without the
    assertion, a future refactor could move the lookup inside the page loop and every
    behavioural test above would still pass — just slowly.
    """
    for i in range(4):
        extra = repo_wired["content"] / f"额外{i}.md"
        extra.write_text(
            "# 额外\n\n<cite>\n- [alpha](file://src/mod.py#L3-L4)\n</cite>\n", encoding="utf-8")
    calls: list[tuple[str, ...]] = []
    real_git = wiki_drift.git

    def spy(*args: str) -> str:
        calls.append(args)
        return real_git(*args)

    monkeypatch.setattr(wiki_drift, "git", spy)
    assert wiki_drift.cmd_stale(_args()) == 0
    logs = [c for c in calls if c and c[0] == "log"]
    assert len(logs) == 1, logs
```

辅助函数放同一段（读 `--json` 支路的 stdout）：

```python
def _stale_json() -> dict:
    """Run `cmd_stale --json` and parse what it printed."""
    import io
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        rc = wiki_drift.cmd_stale(_args(json=True))
    assert rc == 0
    return json.loads(buf.getvalue())
```

（若 `contextlib` 未导入，在文件顶部 `import` 块补 `import contextlib`。）

- [ ] **Step 2: 跑到红**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q -k "commits_since or per_distinct_baseline"`
Expected: FAIL —— 第一条 `KeyError: 'commits_since'`（或行里没有该键），第二条在没有缓存的实现上会数到 >1 次 `log`（若实现尚未使用 `git log`，则第一条先红，符合「先弄红再落地」）。

- [ ] **Step 3: 实现批量取数**

`diff_since` 之后：

```python
def commits_touching(base: str) -> dict[str, list[str]]:
    """path -> every commit that touched it in `base..HEAD`, from ONE git call.

    `--no-renames` matches `diff_since()`, so a rename counts as delete+add for both
    readings of history rather than disagreeing between the two. The sentinel on the
    format line is why a path can never be mistaken for a hash.
    """
    out: dict[str, list[str]] = {}
    current = ""
    for line in git("log", "--format=\x01%H", "--name-only", "--no-renames",
                    f"{base}..HEAD").splitlines():
        if not line:
            continue
        if line.startswith("\x01"):
            current = line[1:].strip()
            continue
        out.setdefault(line, []).append(current)
    return out


def make_commits_counter() -> Callable[[str, list[str]], int]:
    """Per-baseline cache over `commits_touching` — the batch the spec asks for.

    Pages overwhelmingly share a baseline (the tree's modal `verified_at`), so the
    git-log count tracks distinct baselines, not the 450 pages that consume it.
    """
    cache: dict[str, dict[str, list[str]]] = {}

    def count(base: str, paths: list[str]) -> int:
        if not paths:
            return 0
        if base not in cache:
            cache[base] = commits_touching(base)
        by_path = cache[base]
        touched: set[str] = set()
        for p in paths:
            touched.update(by_path.get(p, ()))
        return len(touched)

    return count
```

`cmd_stale` 里建行时改用缓存（在 `for rep in reports` 之前加 `counter = make_commits_counter()`），行字典里 `commits_since` 放在 `changed_sources` 之前：

```python
            "commits_since": counter(rep.base, list(rep.stale)),
```

- [ ] **Step 4: 两条用例转绿**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q -k "commits_since or per_distinct_baseline"`
Expected: `2 passed`

- [ ] **Step 5: 真树读一遍，确认计数不是 0 也不是荒谬**

Run: `python -X utf8 tools/wiki_drift.py stale --top 5`
Expected: 每行有 `changed=...`，且 `--json` 里 `commits_since >= 1` 对至少一行成立（真树有 22 页 drift，`sources-changed` 那批必然非 0）。

- [ ] **Step 6: 提交**

```bash
git add tools/wiki_drift.py tools/test_wiki_drift.py
git commit -s -m "feat(wiki): stale 的 commits_since 走 per-baseline 缓存，一次 git log 而不是每页一次"
```

---

### Task 3: `index` 生成器 —— 确定性 `INDEX.md`，且 `--check` 不许把空树当合规

**Files:**
- Create: `repowiki/INDEX.md`（由命令生成后入库）
- Modify: `tools/wiki_drift.py`（新增 `render_index()` / `cmd_index()`；`main()` 注册 `index`）
- Modify: `repowiki/README.md`（把 `index` 写进操作规程）
- Test: `tools/test_wiki_drift.py`

**Interfaces:**
- Consumes: `build(args)`、`wiki_root.index_md`（`WikiRoot:155-157`，`root/"INDEX.md"`）、`WIKI/"modules"`（7 个 slug 目录 × `overview/architecture/tech-stack/conventions/commands.md`）、`WIKI/"cards"`（9 个 `*.md`）、`read_frontmatter(page)`（:571）、`write_refusal(verb)`（:193）、`queue_reason()`（Task 1）。
- Produces: `render_index(payload: dict, reports: list[PageReport], head: str, modules: list[tuple[str, int, str]], cards: list[tuple[str, str]], topics: list[tuple[str, int, int, list[tuple[str, str, str]]]]) -> str`；`cmd_index(args) -> int`；CLI 动词 `index [--check] [--baseline REV]`。

- [ ] **Step 1: 写失败的用例（确定性 + 反空 + 只读门）**

```python
def test_index_output_is_byte_identical_across_two_runs(repo_wired):
    """Determinism is the contract, and the two ways it breaks are ordering and clocks.

    Sorting is explicit in the renderer; the risk a future edit reintroduces is a
    timestamp. There is no `generated_at` anywhere in INDEX.md by design — `drift.json`
    carries the clock, the navigation file must not, or `--check` fails on every run.
    """
    head = _git(repo_wired["root"], "rev-parse", "HEAD").strip()
    once = wiki_drift.render_index(**_index_inputs(repo_wired, head))
    twice = wiki_drift.render_index(**_index_inputs(repo_wired, head))
    assert once == twice
    assert head[:8] in once
    for stamp in ("generated_at", datetime.now().strftime("%Y"), time.strftime("%Y-%m")):
        assert stamp not in once, stamp


def test_index_banner_says_the_prose_is_not_verified(repo_wired):
    """spec §10 item 5: until M5 finishes, the prose layer must not read as a fact
    source, and the banner is where a reader meets that first."""
    head = _git(repo_wired["root"], "rev-parse", "HEAD").strip()
    text = wiki_drift.render_index(**_index_inputs(repo_wired, head))
    assert "散文层未核" in text
    assert "别当事实源" in text
    assert "请勿手改" in text


def test_index_check_refuses_a_tree_where_no_page_is_stamped(repo_wired, monkeypatch, capsys):
    """Anti-empty, and the reason it is `--check` that refuses: a corpus with zero
    frontmatter would render a perfectly deterministic INDEX.md full of blanks, and a
    deterministic blank file is exactly the kind of green that means nothing."""
    page = repo_wired["page"]
    for fm in page.parent.rglob("*.md"):
        fm.write_text("## 正文\n", encoding="utf-8")
    ns = _args(check=True)
    rc = wiki_drift.cmd_index(ns)
    assert rc == 1, rc
    assert "no_frontmatter" in capsys.readouterr().out


def test_index_writes_nothing_on_a_read_only_root(repo_wired, monkeypatch, capsys):
    """`index` is the fourth writing verb M3 adds, so it goes through the same entry
    gate `mark` and `reanchor --apply` use — the contract in README §一 is four
    entries, not three, and a fifth that skips it re-opens the clobber hazard."""
    monkeypatch.setattr(wiki_drift, "wiki_root",
                        wiki_drift.WikiRoot.resolve(repo_wired["root"] / "nonsense",
                                                    base=repo_wired["root"]))
    before = _tree_bytes(repo_wired["wiki"])
    rc = wiki_drift.cmd_index(_args())
    assert rc == 2, rc
    assert "read-only" in capsys.readouterr().err or "拒绝写入" in capsys.readouterr().err
    assert _tree_bytes(repo_wired["root"]) == before
```

`_index_inputs(repo_wired, head)` 是测试侧的输入装配器，把 `build()` 的输出与磁盘树打包成 `render_index` 的关键字参数（写出来，别留空）：

```python
def _index_inputs(tree: dict, head: str) -> dict:
    """Assemble render_index's arguments the way cmd_index does, so the renderer is
    tested as a pure function and cmd_index is tested through behaviour."""
    built = wiki_drift.build(_args())
    assert not isinstance(built, int), built
    payload, reports, _gaps = built
    wiki = tree["wiki"]
    modules = [(d.name, len(list((d).glob("*.md"))), _fm_stamp(d / "overview.md"))
               for d in sorted((wiki / "modules").glob("*/")) if (d / "overview.md").is_file()] \
        if (wiki / "modules").is_dir() else []
    cards = [(c.name, c.stem) for c in sorted((wiki / "cards").glob("*.md"))] \
        if (wiki / "cards").is_dir() else []
    topics = []
    for top in sorted({r.page.split("/")[0] for r in reports}):
        rows = [(r.page.split("/")[-1][:-3], r.page, _fm_stamp(tree["content"] / r.page))
                for r in reports if r.page.split("/")[0] == top]
        queued = sum(1 for r in reports if r.page.split("/")[0] == top
                     and wiki_drift.queue_reason(r) is not None)
        topics.append((top, len(rows), queued, rows))
    return {"payload": payload, "reports": reports, "head": head,
            "modules": modules, "cards": cards, "topics": topics}


def _fm_stamp(path: Path) -> str:
    fm = wiki_drift.read_frontmatter(path) if path.is_file() else None
    return (fm or {}).get("verified_at", "")[:8] or "--------"
```

- [ ] **Step 2: 跑到红**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q -k "index"`
Expected: FAIL —— `AttributeError: ... has no attribute 'render_index'`。

- [ ] **Step 3: 实现渲染器与命令**

```python
INDEX_BANNER = (
    "# Repo Wiki 索引\n"
    "> 生成物，由 `python -X utf8 tools/wiki_drift.py index` 重写；请勿手改。\n"
    "> {stats}\n"
    "> **散文层未核**：链接层已核对到各页基线，正文自快照以来未逐页复核 —— 别当事实源引用，"
    "查现状请 `Grep`/`Read` 打 `repowiki/` 本体。\n"
)


def render_index(payload: dict, reports: list[PageReport], head: str,
                 modules: list[tuple[str, int, str]], cards: list[tuple[str, str]],
                 topics: list[tuple[str, int, int, list[tuple[str, str, str]]]]) -> str:
    """The navigation file, as a pure function of the tree.

    No clock, no filesystem order: every list arrives sorted and the only hash printed
    is the HEAD the caller resolved. `INDEX.md` is what a human clicks through, so it
    also carries the prose-not-verified banner — a spec §10 requirement that must not
    depend on someone remembering to paste it.
    """
    queued = sum(1 for r in reports if queue_reason(r) is not None)
    stats = (f"共 {len(reports)} 页 · 其中 {queued} 页在 `stale` 队列里"
             f"（正文未核或引用有变更）· 基线 HEAD {head[:8]}")
    out = [INDEX_BANNER.format(stats=stats), "", "## 模块", ""]
    for slug, faces, stamp in modules:
        out.append(f"- [{slug}](modules/{slug}/overview.md) — {faces} 面 · verified@{stamp}")
    out += ["", "## 卡片", ""]
    for label, stem in cards:
        out.append(f"- [{stem}](cards/{stem}.md)")
    out += ["", "## 专题", ""]
    for top, pages, page_queued, rows in topics:
        out.append(f"### {top} ({pages} 页 · {page_queued} 页待更新)")
        out.append("")
        for label, rel, stamp in rows:
            out.append(f"- [{label}](topics/{rel}) `{stamp}`")
        out.append("")
    return "\n".join(out).rstrip() + "\n"


def cmd_index(args: argparse.Namespace) -> int:
    """Generate `INDEX.md`, or with --check compare it instead of writing it."""
    built = build(args)
    if isinstance(built, int):
        return built
    payload, reports, _gaps = built
    missing = payload["summary"]["no_frontmatter"]
    if args.check and missing:
        print(f"INDEX.md cannot certify this tree: {missing} page(s) carry no frontmatter, "
              "so the index would be deterministic but empty of baselines — run "
              "`report` and seed/re-mark them.", file=sys.stderr)
        return 1
    head = payload["head"]
    wiki = WIKI
    modules_dir, cards_dir = wiki / "modules", wiki / "cards"
    modules = [(d.name, len(list(d.glob("*.md"))), _fm_stamped(d / "overview.md"))
               for d in sorted(modules_dir.iterdir())
               if d.is_dir() and (d / "overview.md").is_file()] if modules_dir.is_dir() else []
    cards = [(c.stem, c.stem) for c in sorted(cards_dir.glob("*.md"))] if cards_dir.is_dir() else []
    groups: dict[str, list[PageReport]] = {}
    for rep in reports:
        groups.setdefault(rep.page.split("/")[0], []).append(rep)
    topics = []
    for top in sorted(groups):
        rows = [(r.page.split("/")[-1][:-3], r.page, _fm_stamped(CONTENT / r.page))
                for r in sorted(groups[top], key=lambda r: r.page)]
        queued = sum(1 for r in groups[top] if queue_reason(r) is not None)
        topics.append((top, len(rows), queued, rows))
    text = render_index(payload=payload, reports=reports, head=head,
                        modules=modules, cards=cards, topics=topics)
    path = wiki_root.index_md
    if args.check:
        if path.is_file() and path.read_text(encoding="utf-8") == text:
            print(f"INDEX.md is current ({len(reports)} pages, HEAD {head[:8]})")
            return 0
        print(f"INDEX.md is stale — run: python -X utf8 tools/wiki_drift.py index "
              f"(expected {len(text)} bytes at HEAD {head[:8]})", file=sys.stderr)
        return 1
    refusal = write_refusal("index")
    if refusal:
        print(refusal, file=sys.stderr)
        return 2
    path.write_text(text, encoding="utf-8", newline="\n")
    print(f"wrote {path} ({len(text)} bytes, {len(reports)} pages, HEAD {head[:8]})")
    return 0


def _fm_stamped(path: Path) -> str:
    fm = read_frontmatter(path) if path.is_file() else None
    return (fm or {}).get("verified_at", "")[:8] or "--------"
```

注册（并把 `index` 加进 :2360 的 `--wiki-root` 循环元组）：

```python
    index = sub.add_parser("index", help="regenerate INDEX.md from the tree on disk")
    index.add_argument("--check", action="store_true",
                       help="compare instead of write; exit 1 when it differs (CI)")
    index.add_argument("--baseline", help="override the wiki snapshot commit (40-hex)")
    index.set_defaults(func=cmd_index)
```

- [ ] **Step 4: 四条用例转绿**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q -k "index"`
Expected: `4 passed`

- [ ] **Step 5: 真树生成并入库，再验两次字节相同**

```bash
python -X utf8 tools/wiki_drift.py index
python -X utf8 tools/wiki_drift.py index --check; echo "rc=$?"
cp repowiki/INDEX.md .qoder/tmp/m3-index-a.md
python -X utf8 tools/wiki_drift.py index
cmp .qoder/tmp/m3-index-a.md repowiki/INDEX.md && echo "DETERMINISTIC"
grep -c '^' repowiki/INDEX.md
```
Expected: `--check` rc=0；`cmp` 报 `DETERMINISTIC`；行数 ≈ 450 页 + 7 模块 + 9 卡片 + 表头 ≈ 480–520。检查 `INDEX.md` 里 `445 页在 \`stale\` 队列里` 这个数与 Task 1 的实测一致。

- [ ] **Step 6: 提交**

```bash
git add tools/wiki_drift.py tools/test_wiki_drift.py repowiki/INDEX.md repowiki/README.md
git commit -s -m "feat(wiki): index 生成器与确定性 INDEX.md —— 散文层未核写进顶部横幅"
```

---

### Task 4: `tools/wiki_freshness_gate.sh` —— 只做两件新鲜度的事

**Files:**
- Create: `tools/wiki_freshness_gate.sh`
- Test: `tools/test_wiki_drift.py`

**Interfaces:**
- Consumes: `stale --format count`、`index --check`。
- Produces: 可执行脚本，`WIKI_STALE_MAX`（默认 **445**）超线 ⇒ rc=1；`index --check` 失败 ⇒ rc=1；两者都过 ⇒ rc=0。形状与 `ci_grep_gates.sh` 同族（`FAIL:` / `ok` 前缀），但**不复用它的模式串**（spec §9.1：一条政策只能有一份实现）。

- [ ] **Step 1: 写失败的用例（阈值、非整数输入、无商标模式串）**

```python
def test_the_freshness_gate_is_readable_and_carries_no_brand_patterns():
    """Two policies, one implementation each. The brand/code gates live in
    `ci_grep_gates.sh` (upstream-owned, unchangeable); copying their needles into a
    fork script is how a policy ends up half-updated."""
    src = (REAL_REPO / "tools" / "wiki_freshness_gate.sh").read_text(encoding="utf-8")
    assert "WIKI_STALE_MAX" in src and "445" in src
    assert "stale --format count" in src
    assert "index --check" in src
    assert REAL_BRAND.lower() not in src.lower(), "freshness gate must not duplicate brand needles"


def test_the_freshness_gate_fails_when_the_water_level_rises(tmp_path):
    """Run it with the count faked: a gate whose red path has never been taken is not
    a gate. Both legs get exercised — over threshold ⇒ exit 1, at threshold ⇒ exit 0."""
    script = REAL_REPO / "tools" / "wiki_freshness_gate.sh"
    fake = tmp_path / "wiki_drift.py"
    fake.write_text("import sys\nprint(446 if 'count' in sys.argv else '')\n", encoding="utf-8")
    env = {**os.environ, "PATH": f"{tmp_path}{os.pathsep}{os.environ['PATH']}"}
    # `python` resolves to a stub that prints an over-threshold count.
    stub = tmp_path / "python"
    stub.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{fake}" "$@"\n', encoding="utf-8")
    stub.chmod(0o755)
    proc = subprocess.run(["bash", str(script)], capture_output=True, text=True,
                          encoding="utf-8", errors="replace", env=env, cwd=REAL_REPO)
    assert proc.returncode == 1, proc.stdout + proc.stderr
    assert "wiki stale pages: 446" in proc.stdout
```

- [ ] **Step 2: 跑到红**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q -k "freshness_gate"`
Expected: FAIL —— `FileNotFoundError: ... wiki_freshness_gate.sh`。

- [ ] **Step 3: 写脚本**

```bash
#!/usr/bin/env bash
# tools/wiki_freshness_gate.sh —— 只读：不改文件、不建仓、不安装
# Threshold-based, not zero: a fork cannot chase 450 pages instantly, and a gate that
# is always red gets switched off. WIKI_STALE_MAX is the tuning knob; its shipped
# default is the measured water level at M3 time (423 partial + 22 stale = 445), and
# M5 lowers it shard by shard. The brand/code/secret gates stay in ci_grep_gates.sh —
# one policy, one implementation.
set -u
set -o pipefail
cd "$(dirname "$0")/.." || exit 1

RED=$'\033[0;31m'
GREEN=$'\033[0;32m'
NC=$'\033[0m'
FAILED=0
LIMIT="${WIKI_STALE_MAX:-445}"

STALE=$(python -X utf8 tools/wiki_drift.py stale --format count 2>/dev/null)
if ! [[ "$STALE" =~ ^[0-9]+$ ]]; then
    echo "${RED}FAIL${NC}: stale --format count did not print one integer"
    echo "  got: '${STALE}'"
    exit 1
fi
echo "wiki stale pages: $STALE (threshold ${LIMIT})"
if [ "$STALE" -gt "$LIMIT" ]; then
    echo "${RED}FAIL${NC}: water level rose above the threshold"
    FAILED=1
else
    echo "${GREEN}ok${NC}"
fi

if python -X utf8 tools/wiki_drift.py index --check; then
    echo "${GREEN}ok${NC}: INDEX.md is deterministic and current"
else
    echo "${RED}FAIL${NC}: INDEX.md is stale - run: python -X utf8 tools/wiki_drift.py index"
    FAILED=1
fi

if [ "$FAILED" -ne 0 ]; then
    echo
    echo "${RED}wiki_freshness_gate: one or more checks failed${NC}"
    exit 1
fi
echo
echo "${GREEN}wiki_freshness_gate: all checks passed${NC}"
exit 0
```

```bash
chmod +x tools/wiki_freshness_gate.sh
bash tools/wiki_freshness_gate.sh; echo "rc=$?"
WIKI_STALE_MAX=444 bash tools/wiki_freshness_gate.sh; echo "rc-444=$?"
```
Expected: 默认阈值 rc=0；`WIKI_STALE_MAX=444` ⇒ rc=1 并打印 `water level rose above the threshold`（这条实测就是「红路径被人踩过一次」的证据，必须记进档案）。

- [ ] **Step 4: 用例转绿 + 全量**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q -k "freshness_gate"` → `2 passed`

- [ ] **Step 5: 提交**

```bash
git add tools/wiki_freshness_gate.sh tools/test_wiki_drift.py
git commit -s -m "feat(wiki): 新鲜度门禁脚本 —— 阈值 445 只降不升，且不复用商标门的模式串"
```

---

### Task 5: fork 自有工作流 ＋ 把两条本地归档用例从 CI 里摘出去

**Files:**
- Create: `.github/workflows/repowiki-freshness.yml`
- Modify: `tools/test_wiki_drift.py`（给两条归档用例 ＋ Task 8 新增的那条打 `@pytest.mark.local_archive`）
- Test: `tools/test_wiki_drift.py`（新增一条读工作流文本的用例）

**Interfaces:**
- Consumes: `tools/wiki_freshness_gate.sh`、`tools/test_wiki_drift.py`。
- Produces: 工作流 `repowiki-freshness`（weekly + `workflow_dispatch`，`actions/checkout` 用 `fetch-depth: 0`）；标记 `local_archive`；CI 的收集命令 `pytest tools/test_wiki_drift.py -q -m "not local_archive"`。

**控制器裁定（写进计划，不许执行者自己翻案）**：套件步骤**不带** `continue-on-error`（它第一天就该绿：本地 192 绿，CI 少 2 条 ⇒ 190 绿），只有新鲜度门禁步骤 `continue-on-error: true`（spec §9.1：水位门禁首周只观察）。若这条判断错了，代价是一次没人理的红灯工作流，可在 M3 收口时一行改回。

- [ ] **Step 1: 写失败的用例**

```python
def test_the_fork_workflow_collects_the_suite_and_only_softens_the_water_level():
    """The reason this file exists: nothing upstream ever ran tools/test_wiki_drift.py
    (`pyproject.toml:276` testpaths is upstream's). A workflow that softens both steps
    would collect 192 cases and report nothing, which is the green-that-means-nothing
    this project keeps having to design against."""
    text = (REAL_REPO / ".github" / "workflows" / "repowiki-freshness.yml").read_text(encoding="utf-8")
    assert "fetch-depth: 0" in text
    assert 'schedule:' in text and "workflow_dispatch" in text
    assert "wiki_freshness_gate.sh" in text
    assert "not local_archive" in text
    assert "-m \"not local_archive\"" in text or "-m 'not local_archive'" in text
    # water level soft, suite hard:
    gate_idx, suite_idx = text.index("wiki_freshness_gate.sh"), text.index("not local_archive")
    hard = [l for l in text.splitlines() if "continue-on-error" in l]
    assert len(hard) == 1, hard
    assert text.index(hard[0]) < max(gate_idx, suite_idx)


def test_the_two_archive_cases_are_marked_local_archive():
    """They read `.qoder/repowiki/_ide-export-retired-2026-10-01`, which is untracked and
    absent from a fresh checkout — so in CI they are red by construction, not by defect.
    Marking them is what lets the workflow collect the other 190."""
    src = (REAL_REPO / "tools" / "test_wiki_drift.py").read_text(encoding="utf-8")
    marked = re.findall(r'@pytest\.mark\.local_archive\ndef (test_\w+)', src)
    assert len(marked) >= 2, marked
    for name in ("test_the_archived_export_still_holds_the_450_seeded_pages",
                 "test_every_seeded_topic_body_matches_the_archive_byte_for_byte"):
        assert name in marked, marked
    assert "-m \"not local_archive\"" in src or True  # the deselect lives in the workflow
```

- [ ] **Step 2: 跑到红**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q -k "fork_workflow or archive_cases_are_marked"` → 2 FAIL（文件不存在 / 未打标记）。

- [ ] **Step 3: 打标记**

给那两条用例各加一行装饰器，并把 marker 在测试文件内注册（**不动上游 `pyproject.toml`**）：

```python
pytestmark_group = None  # noqa: F841  (markers are per-function here; registration below)


def pytest_configure(config):
    config.addinivalue_line("markers",
                            "local_archive: needs the untracked .qoder export archive on disk")
```

（`pytest_configure` 写在 `tools/test_wiki_drift.py` 顶部 import 之后一次即可；文件里已有 `pytest.mark` 用法则跳过重复定义 —— 先 `grep -n 'def pytest_configure' tools/test_wiki_drift.py` 确认没有。）

- [ ] **Step 4: 写工作流**

`.github/workflows/repowiki-freshness.yml` 全文如下，其中 **两处 `uses:` 行必须逐字从同目录现有文件抄**（本仓约定：pin 完整 SHA ＋ 行尾版本注释，不许写 `@vN`）：`actions/checkout` 用 `.github/workflows/loader-health.yml` 里那一行（含 SHA 与注释）；`actions/setup-python` 用 `.github/workflows/test.yml` 里那一行；`python-version` 的值也照 `test.yml` 抄。执行前跑：

```bash
grep -n 'actions/checkout@' .github/workflows/loader-health.yml
grep -n 'actions/setup-python@\|python-version' .github/workflows/test.yml
```

骨架（把上面抄到的 `uses:` 与 `python-version` 原样替换进去）：

```yaml
name: repowiki-freshness

# Fork-owned. Nothing upstream ever collects tools/test_wiki_drift.py
# (pyproject.toml's testpaths is "agent/tests"), and this repository's rule is that
# upstream files stay byte-for-byte alone — so the fork adds a file rather than
# editing .github/workflows/test.yml.

on:
  schedule:
    - cron: '17 3 * * 1'   # Mondays, off the top of the hour
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: public-repowiki-freshness
  cancel-in-progress: false

jobs:
  freshness:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: <actions/checkout line copied verbatim from loader-health.yml>
        with:
          fetch-depth: 0   # `stale` needs every page's verified_at commit reachable
      - uses: <actions/setup-python line copied verbatim from test.yml>
        with:
          python-version: '<same value as test.yml>'
      - name: Install pytest only
        run: python -m pip install --upgrade pytest
      - name: Wiki freshness gate
        continue-on-error: true
        env:
          WIKI_STALE_MAX: '445'
        run: bash tools/wiki_freshness_gate.sh
      - name: Wiki guard suite
        run: python -X utf8 -m pytest tools/test_wiki_drift.py -q -m "not local_archive"
```

- [ ] **Step 5: 本地验证 CI 会跑的收集面**

```bash
python -X utf8 -m pytest tools/test_wiki_drift.py -q -m "not local_archive"
```
Expected: `190 passed, 2 deselected`（当前 192 条里摘掉 2 条；Task 8 再加的第 3 条标记会把这个数再降 1，届时同步 README 与档案的口径）。

- [ ] **Step 6: 两条用例转绿 + 提交**

```bash
git add .github/workflows/repowiki-freshness.yml tools/test_wiki_drift.py
git commit -s -m "ci(wiki): fork 自有 repowiki-freshness 工作流 —— 第一次真正收集这套守卫用例"
```

---

### Task 6: `seed` 的覆盖闸门（档案 M3 名单 ①）

**Files:**
- Modify: `tools/wiki_drift.py`（`SeedTally` :965、`apply_page_plan` :983、`cmd_seed` :1027）
- Test: `tools/test_wiki_drift.py`

**Interfaces:**
- Consumes: `apply_page_plan(plan, tally, dry_run)` 的现有形状。
- Produces: `apply_page_plan(plan, tally, dry_run, force=False)`；`SeedTally.overwritten: int`；`SeedTally.line()` 多出 `overwritten=N`；`seed --force`。

- [ ] **Step 1: 写失败的用例**

```python
def test_seed_refuses_to_overwrite_a_changed_page_without_force(...):
    """`seed --apply` used to `write_bytes` anything whose bytes differed, with no
    warning and a `written` count that did not distinguish a new page from a clobber.
    After M5 that is the recipe for deleting rewritten prose with a 2026-08-14 export —
    which is why the README sentence about re-seeding was labelled rollback-grade."""
    target = repo_wired["content"] / "前端应用" / "模块说明.md"
    original = target.read_bytes()
    target.write_bytes(b"## 重写过的正文，不是导出物\n")
    tally = wiki_drift.SeedTally()
    plan = wiki_drift.PagePlan(
        label="模块说明", target=target, body=original,
        fm=wiki_drift.frontmatter_shape_for_test(target) if hasattr(wiki_drift, "frontmatter_shape_for_test") else {},
        origin="topics", reworded=False)
    rc = wiki_drift.apply_page_plan(plan, tally, dry_run=False, force=False)
```

执行者注意：上面最后两行**是给你照着改成真实构造的**——先 `sed -n '705,725p' tools/wiki_drift.py` 读 `PagePlan` 的真实字段与构造点，再用与 `cmd_seed` 相同的构造方式造 `plan`；断言部分逐字保留：

```python
    assert rc == "refused", rc
    assert tally.overwritten == 1
    assert target.read_bytes() == b"## 重写过的正文，不是导出物\n"
    rc2 = wiki_drift.apply_page_plan(plan, wiki_drift.SeedTally(), dry_run=False, force=True)
    assert rc2 == "written"
    assert target.read_bytes() == original
```

并加一条 CLI 级用例：`seed --apply` 在有一页被改过 ⇒ rc=1 或 rc=2（实现选一个，两个都测）且 stderr 点名被覆盖页数与 `--force`；同一命令加 `--force` ⇒ rc=0 且 `overwritten=1` 出现在 tally 行里。

- [ ] **Step 2: 跑到红** → `TypeError: apply_page_plan() got an unexpected keyword argument 'force'`。

- [ ] **Step 3: 实现**

```python
@dataclass
class SeedTally:
    ...
    overwritten: int = 0
    refused: int = 0
```

`line()` 末尾追加 `f"overwritten={self.overwritten} refused={self.refused}"`。

```python
def apply_page_plan(plan: PagePlan, tally: SeedTally, dry_run: bool,
                    force: bool = False) -> str:
    """Publish one page, and never silently replace bytes a human may have rewritten.

    Returns one of "skipped" / "written" / "refused" so the caller can count without
    re-reading the tally. The pre-existing-bytes check is the whole point: M5 will
    rewrite prose, and `seed` is a one-shot whose `--from` root no longer exists as a
    single usable place — running it again is not a refresh, it is a rollback.
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
        return "skipped"
    if plan.target.is_file():
        tally.overwritten += 1
        if not force:
            tally.refused += 1
            return "refused"
    if dry_run:
        tally.written += 1
        return "written"
    plan.target.parent.mkdir(parents=True, exist_ok=True)
    plan.target.write_bytes(payload)
    if not plan.target.read_bytes().endswith(plan.body):
        tally.mismatched += 1
    else:
        tally.written += 1
    return "written"
```

`cmd_seed`：调用点接住返回值统计 `refused`，写完后若有拒绝 ⇒

```python
    if tally.refused:
        print(f"seed refused to overwrite {tally.refused} page(s) whose bytes differ from "
              "the export — those are edited pages, and overwriting them is a rollback, "
              "not a refresh. Pass --force if you truly mean to restore the export.",
              file=sys.stderr)
        return 2
```

并在 seed subparser 加 `seed.add_argument("--force", action="store_true", help="overwrite pages whose bytes differ from the export")`。

- [ ] **Step 4: 用例转绿；`grep -n 'apply_page_plan(' tools/wiki_drift.py` 确认**所有**调用点都接了返回值**（漏一个就少一份账）。
- [ ] **Step 5: 提交** `feat(wiki): seed --force 覆盖闸门 —— 改写过的页不许被导出物静默回滚`

---

### Task 7: `drift.json` 的基线键诚实化（档案 M3 名单 ④）

**Files:**
- Modify: `tools/wiki_drift.py`（`build()` :2136 写键处、`render_markdown` :1328、`cmd_report` :2197/:2201）
- Test: `tools/test_wiki_drift.py`（:412、:595、:611 三处消费者）

**Interfaces:**
- Produces: `payload["baseline"]`（值同旧 `metadata_baseline`）＋ `payload["baseline_source"]` ∈ `{"--baseline", "page-verified_at-mode", "wiki_repo.last_commit_id"}`；旧键 `metadata_baseline` **删除**（不保留兼容别名：这是 fork 自有的派生文件，消费者只有 `render_markdown`、`cmd_report` 与本测试文件）。

- [ ] **Step 1: 写失败的用例**

```python
def test_drift_json_names_the_baseline_and_where_it_came_from(repo_wired):
    """The key was called `metadata_baseline` while the value came from the modal page
    `verified_at`. A machine-readable surface that misreports its own provenance is the
    same defect the human-readable half got fixed for in the M2 rounds — the JSON is
    what a future tool will trust."""
    built = wiki_drift.build(_args())
    payload = built[0] if not isinstance(built, int) else None
    assert payload is not None
    assert "metadata_baseline" not in payload, sorted(payload)
    assert payload["baseline"]
    assert payload["baseline_source"] in ("--baseline", "page-verified_at-mode",
                                         "wiki_repo.last_commit_id")
    assert "baseline_source" in wiki_drift.render_markdown.__doc__ or True
```

再加一条：传 `--baseline <sha>` ⇒ `baseline_source == "--baseline"`；不传且页有 stamp ⇒ `"page-verified_at-mode"`（用 `repo_wired` 的 `seed` 提交号写进页 frontmatter 后实测，别猜）。

- [ ] **Step 2: 红** → `KeyError: 'baseline'`。
- [ ] **Step 3: 实现** —— `build()` 里 `fallback = args.baseline or tree_baseline()` 之后立刻记下来源，替换 `payload` 的键：

```python
    if args.baseline:
        baseline_source = "--baseline"
        fallback = args.baseline
    else:
        from_mode = tree_baseline()
        if from_mode:
            baseline_source, fallback = "page-verified_at-mode", from_mode
        else:
            baseline_source = "wiki_repo.last_commit_id"
            fallback = metadata_baseline(META)
```

（`tree_baseline()` 现在是否内含 metadata 回落，先 `sed -n '/^def tree_baseline/,+22p' tools/wiki_drift.py` 读清楚再改：**目标不是重写它的回落链，而是让 `build()` 知道自己拿到的是哪一条**；若 `tree_baseline()` 内部已经吞掉 metadata，就让它接受/返回来源标记，最小改动优先。）

`payload` 里把 `"metadata_baseline": fallback` 换成 `"baseline": fallback, "baseline_source": baseline_source`；`render_markdown`/`cmd_report` 的两个读取点同步改名；三处测试消费者同步改名。

- [ ] **Step 4: 全量转绿** Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q` → 全绿（改名会牵到多处断言，任何一条残留红就顺着键名继续找，不要放宽断言）。
- [ ] **Step 5: 提交** `fix(wiki): drift.json 的基线键说实话 —— baseline + baseline_source，不再冒充 metadata`

---

### Task 8: 三条静态/形状用例（档案 M3 名单 ③⑨⑩）

**Files:**
- Modify: `tools/test_wiki_drift.py`

**Interfaces:**
- Consumes: `ast`、`REAL_REPO`（:1537）、`wiki_drift.EMPTY_TREE_HINT`。
- Produces: 三条新用例，无生产代码改动（若用例证明生产代码有洞，就在对应任务里补，并在本报告里写明）。

- [ ] **Step 1: ⑩「每个 `cmd_*` 写点之前必有门」的 AST 用例**

```python
def test_every_command_that_writes_is_gated_on_the_root_shape():
    """The backstop the M2 round could not pay for: three writing commands are pinned
    by behaviour, so a fourth writer added beside `LEDGER.open("a")` / `write_bytes`
    could still slip through a green suite. Static reading is the cheap way to close
    that — same idea as the EMPTY_TREE_HINT call-site case above it.

    Rule: every `cmd_*` containing a filesystem write must contain a guard call
    (`write_refusal` / `root_is_read_only` / `WikiRoot.resolve(...)layout != "repo"`)
    whose line number precedes the first write's line number.
    """
    src = (REAL_REPO / "tools" / "wiki_drift.py").read_text(encoding="utf-8")
    tree = ast.parse(src)
    writes = ("write_text", "write_bytes", "mkdir")
    guards = ("write_refusal", "root_is_read_only")
    offenders = []
    for node in tree.body:
        if not (isinstance(node, ast.FunctionDef) and node.name.startswith("cmd_")):
            continue
        write_lines, guard_line = [], None
        for sub in ast.walk(node):
            if isinstance(sub, ast.Call):
                fname = getattr(sub.func, "attr", None) or getattr(sub.func, "id", None)
                seg = ast.get_source_segment(src, sub) or ""
                if fname in writes or (fname == "open" and '"a"' in seg):
                    write_lines.append(sub.lineno)
                if fname in guards or 'layout != "repo"' in (ast.get_source_segment(src, node) or ""):
                    if guard_line is None or sub.lineno < guard_line:
                        guard_line = sub.lineno
        if write_lines and (guard_line is None or guard_line > min(write_lines)):
            offenders.append((node.name, guard_line, min(write_lines)))
    assert not offenders, offenders
```

（`cmd_seed` 的门是 `WikiRoot.resolve(WIKI).layout != "repo"`，所以用例接受源码里出现该形状；若它把 `cmd_seed` 判成 offender，**不要放宽规则**，改成在 `cmd_seed` 里把那条判断的调用行提到写点之前——它本来就该如此。）

- [ ] **Step 2: ⑨「导出正文树必须仍然不存在」的用例**

```python
@pytest.mark.local_archive
def test_the_ide_export_body_tree_is_still_absent():
    """README says `.qoder/repowiki` is frozen at the 2026-08-14 snapshot. If someone
    clicks Generate in the IDE again, `zh/content` grows back, `--wiki-root
    .qoder/repowiki` starts working, and that README sentence becomes a lie inside the
    tracked tree — with nothing in the suite to notice. The assertion is on disk, so it
    is marked local_archive: a CI checkout has no `.qoder/` at all."""
    export = REAL_REPO / wiki_drift.LEGACY_EXPORT / "repowiki"
    if not export.is_dir():
        pytest.skip(f"no .qoder container here: {export}")
    body = export / "zh" / "content"
    assert not body.is_dir(), (
        f"{body} exists again: the IDE export grew back, so README's frozen-snapshot "
        "claim is false and the two roots disagree about which tree is publication"
    )
```

- [ ] **Step 3: ③ `EMPTY_TREE_HINT` 整串断言**

把现有只匹句子串的那条改成断言 stderr **等于** `EMPTY_TREE_HINT.format(...)`（`build()` :2068 的真实参数形状），并保留 `--json` 与默认路径两个观测点：

```python
def test_the_empty_tree_hint_is_printed_whole_at_the_report_site(...):
    want = wiki_drift.EMPTY_TREE_HINT.format(
        content=<真实 CONTENT>, root=<真实 WIKI>, layout="repo",
        archive=f"{wiki_drift.LEGACY_EXPORT}/{wiki_drift.EXPORT_ARCHIVE}")
    assert err.strip() == want.strip(), err
```

- [ ] **Step 4: 全量 + CI 选择器**

```bash
python -X utf8 -m pytest tools/test_wiki_drift.py -q
python -X utf8 -m pytest tools/test_wiki_drift.py -q -m "not local_archive"
```
Expected: 全量 `193 passed`（192 + ⑨ 那条 −1 deselected 只影响第二条）；CI 选择器 `190 passed, 3 deselected`。**以实测为准写进档案，别引用这里的预测数。**

- [ ] **Step 5: 提交** `test(wiki): 三条静态用例 —— 写门 AST 后备、导出正文树不再长回来、空树提示整串`

---

### Task 9: 文档写回（README ＋ 项目档案 ＋ 记忆），含名单 ⑧ 的实测与决定

**Files:**
- Modify: `repowiki/README.md`、`项目档案.md`
- Memory（仓库外，用户授权范围内）: `ops-repo-wiki-git-root-and-update.md` ＋ `MEMORY.md` 钩子

- [ ] **Step 1: ⑧ 先测再定，不许拍脑袋**

```bash
sed -n '38,48p' tools/ci_grep_gates.sh
grep -rni --include='*.md' 'worldquant' docs/superpowers/ | wc -l
bash tools/ci_grep_gates.sh 2>&1 | grep -c 'docs/'
```
决定写进 README §五与 `项目档案.md`：**`docs/superpowers/**` 不纳入商标零命中面**（依据：上游 `ci_grep_gates.sh` 的门 (b) 自己带 `--exclude-dir=docs`，那是上游政策的一部分，本 fork 不改上游脚本也就不该用第二个实现去覆盖它的范围；且 `docs/superpowers/` 只含计划/spec 文本、不含发布内容）。若第一条 grep 的命中数不是 0，就**如实记下命中文件与行数**，并给这些文件加运行时拼接改写 —— 但只能在确认 `docs/` 不在扫描面之后做，别顺手改出第二个实现。

- [ ] **Step 2: README 增补三处**

1. 操作规程里加：`stale --format count`（队列/CI 取数）、`stale`（人读队列）、`index` / `index --check`。
2. §一「写盘入口」计数从四个改为**五个**（新增 `index`），并保持 `rc=2 拒绝写入` / `按磁盘形状判定` 两条针脚原文不变（Task 3 的门就是这两句的另一处站点）。
3. 新增一节「M3 的三台机器」，写明 `WIKI_STALE_MAX` 只降不升、阈值 445 的来源是 2026-10-02 的实测水位，以及「`stale` 的 count ≠ `report` 的 needs_update」这条语义区别（Task 1 的契约在文档里也得有一条，否则下一个人会把它们「统一」掉）。

- [ ] **Step 3: `项目档案.md` 追加 M3 段（时点读数一律写「在 `@<commit>` 实测」）**

内容：三台机器与判据、Task 5 的「套件步骤硬、门禁步骤软」裁定、CI 收集面的实测数（`-m "not local_archive"` 的 passed/deselected）、M3 名单 ①–⑩ 的逐项处置（哪几项被这次做了、哪几项留 M4/M5、留的理由）、⑧ 的实测与决定、`bash tools/wiki_freshness_gate.sh` 两条腿的实测 rc。

- [ ] **Step 4: 记忆同步**（`ops-repo-wiki-git-root-and-update.md` 的 CLI 闭环一节加 `stale`/`index`/门禁脚本与工作流；`MEMORY.md` 钩子那行补一句「M3 起有 fork 自己的 CI 收集这套用例，本地归档两条被 deselect」）。

- [ ] **Step 5: 提交** `docs(wiki): M3 写回 —— 三台机器的口径、阈值哲学与 ⑧ 的实测决定`

---

### Task 10: 收口实测与变异探针台账

- [ ] **Step 1: 全量与门禁**

```bash
python -X utf8 -m pytest tools/test_wiki_drift.py -q
python -X utf8 -m pytest tools/test_wiki_drift.py -q -m "not local_archive"
python -X utf8 -m pytest tools/test_wiki_drift.py -q -k upstream_owned
bash tools/ci_grep_gates.sh; echo "rc=$?"
bash tools/wiki_freshness_gate.sh; echo "rc=$?"
WIKI_STALE_MAX=<比实测小 1 的数> bash tools/wiki_freshness_gate.sh; echo "rc-red=$?"
python -X utf8 tools/wiki_drift.py report --top 3
python -X utf8 tools/wiki_drift.py stale --format count
python -X utf8 tools/wiki_drift.py index --check; echo "rc=$?"
git diff --name-only upstream/main...HEAD
git rev-list --left-right --count upstream/main...HEAD
git status --short
```
Expected：水位 445 一致（`report` 的 `partial + stale` 与 `stale --format count` 相等）；门禁默认 rc=0、调小阈值后 rc=1；`upstream/main...HEAD` 里 `.gitignore` / `tools/ci_grep_gates.sh` / `.github/workflows/test.yml` / `wiki/**` **一个都不出现**；工作树干净。

- [ ] **Step 2: 变异探针（每条新代码都要有「先弄红」的证据）**

沿用 `.qoder/tmp/f1probe/mutate.py` 的写法（needle 唯一性 + `finally` 字节还原 + sha256 前后校验 + 控制组必须绿），至少植入并判定这六支，全部记 KILLED / SURVIVED / HARNESS-BLIND 三态：

| 编号 | 植入 | 应当红的用例 |
|---|---|---|
| MS-1 | `queue_reason` 去掉 `prose-unverified` 那半 | Task 1 的「无漂移也要进队列」 |
| MS-2 | `commits_touching` 的缓存改成每次重算（`cache` 不写回） | Task 2 的 per-distinct-baseline 计数 |
| MS-3 | `render_index` 里把排序换成 `reports` 原序（不 `sorted`） | Task 3 的两次字节相同（需配合遍历序，若单跑不动就注入 `reversed`） |
| MS-4 | `index --check` 去掉 `no_frontmatter` 那道拒绝 | Task 3 的反空用例 |
| MS-5 | `cmd_index` 的 `write_refusal("index")` 删掉 | Task 3 的只读门 ＋ Task 8 的 AST 后备 |
| MS-6 | `seed` 的 `force` 判断改成恒真 | Task 6 的覆盖闸门 |

SURVIVED 的必须写清「为什么这套用例分不出」，不许写成「纵深防御」—— 上一轮就是这句把一个真缺陷盖掉了。

- [ ] **Step 3: 把探针台账写进 `项目档案.md` 并提交**（`test(wiki): M3 变异探针台账`；若同轮还改了生产码，拆成两个提交）。

- [ ] **Step 4: 交回控制器**：报告状态（DONE / DONE_WITH_CONCERNS / BLOCKED）、本轮提交号、两条计数（全量 passed / CI 选择器 passed+deselected）、水位读数、门禁两个 rc、以及任何你认为 spec 与计划冲突的点。

---

## Self-Review（写计划的人自己过一遍，已就地修正）

1. **Spec 覆盖**：§6 表里 M3 的两个新动词（`stale` :170、`index` :171）⇒ Task 1/2/3；§9.1 脚本 ⇒ Task 4；§9.1 工作流（新文件、`fetch-depth: 0`、`continue-on-error`、不改 `test.yml`）⇒ Task 5；§5.3 的 INDEX 形状与确定性 ⇒ Task 3；§10 判据「`stale --format count` = 445」⇒ Task 1 Step 5 与 Task 10 Step 1；§6.1 的 `stale` 分组用例（两页两 commit、`missing_sources` 单列）⇒ Task 1/2 的用例形态覆盖。无遗漏。
2. **占位符**：Task 5 的两处 `uses:` 与 `python-version`、Task 6 的 `PagePlan` 构造是「逐字从指定位置抄取」的指令，附了取数命令与要抄的确切文件行号 —— 这是可执行的取材步骤，不是 TBD。其余步骤全部自带完整代码。
3. **类型一致性**：`queue_reason(rep: PageReport) -> str | None`（Task 1）在 Task 3/8 的使用签名一致；`apply_page_plan(..., force=False) -> str`（Task 6）与 `cmd_seed` 调用点、Task 8 的 AST 规则不冲突；`payload["baseline"]/["baseline_source"]`（Task 7）在 Task 1 的 `--json` 里被读作 `payload["metadata_baseline"]` —— **这是计划里唯一的真实顺序耦合**：Task 7 改名后 Task 1 的 JSON 行必须同步，故 Task 7 Step 3 的「三处消费者」必须包含 `cmd_stale`。执行 Task 7 时先 `grep -n 'metadata_baseline' tools/wiki_drift.py` 把 `cmd_stale` 一起改掉，全量必须仍绿。
4. **歧义**：`stale --format count` 与 `report` 的 `needs_update` 的关系已在 Task 1 用两条用例钉成「两个不同但都诚实的数」，并在 README（Task 9 Step 2）与档案里各写一次；阈值默认值 445 在 Task 4 脚本与 Task 5 工作流的 `env` 里各出现一次，两处都是「当前实测水位」的同一读数，若收口时水位变化就一起改。
