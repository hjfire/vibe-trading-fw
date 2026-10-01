# Repo Wiki 重做 M1（换根 + frontmatter + fork 自带守卫）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `tools/wiki_drift.py` 的事实源从 IDE 导出目录 `.qoder/repowiki/` 换到仓库根 `repowiki/`，为每页引入 `frontmatter` 级基线，并补上两条 fork 自有的可证伪守卫（商标扫描 + 零上游文件改动）。

**Architecture:** M1 只立机器不搬内容：`repowiki/` 里只落一个 `README.md`，494 页正文留在 IDE 导出目录，由 M2 播种。路径解析收敛进一个 `WikiRoot`（按文件系统形状选 `repo`/`ide` 两种布局）；页面元数据用无第三方依赖的极简 YAML 夹在正文之前；**ledger 的哈希对象从「整文件字节」改成「去掉 frontmatter 的正文字节」**——这一步让播种后既有的 426 行担保记录仍然命中（播种不动正文一个字节）。

**Tech Stack:** Python 3.11+ 标准库（`dataclasses` / `re` / `json` / `subprocess` / `pathlib`，不引入 pyyaml）、pytest、Git Bash on Windows；CJK 路径需要 `git -c core.quotepath=off` 与 `python -X utf8`。

**Spec:** `docs/superpowers/specs/2026-10-01-repo-wiki-rebuild-design.md`（本计划实现其 §13 的 M1；§2 ①–⑬ 是事实依据）。注意 `docs/` 被上游 `.gitignore:124` 忽略，spec 与本 plan 都只活在本地磁盘，版本库里的锚点是 `项目档案.md` 的「重做设计」一节。

**后续里程碑各需一份独立计划：** M2 播种、M3 `stale`/`index`/新鲜度门禁、M4 QMind、M5 散文重写。本计划不含其内容。

## Global Constraints

- **零上游文件改动**（用户原话：「这个项目是一个开源项目，我只是做二次开发，我希望可以同步开源项目的更新，开发部分不要动需要同步的开源程序原部分」）。实测归属：`.gitignore`、`tools/ci_grep_gates.sh`、`.github/workflows/test.yml`、`wiki/**`（42 个文件）在上游树里存在 ⇒ **本计划任何任务都不得 Write/Edit 这四个路径**。
- **落点 = 仓库根 `repowiki/`**，不是 `docs/repowiki/`（后者必须改上游 `.gitignore` 才能被跟踪）。`repowiki/` 实测未被忽略。
- **不得把商标字面量写进任何被跟踪文件**（门禁 (b) 的目标串）。需要引用该政策时写「禁止商标字面量，见 `tools/ci_grep_gates.sh`」。
- **五条已定契约不得退化**（spec §6 末段）：`cites` 担保范围语义（`all` 只允许人工 `mark` 写；`reanchor --apply` 只能写 `applied-only`）、`partial` 不推进基线、正文哈希不匹配即 `ledger-void`、编辑器行数口径 `newlines+1`、越界两分类措辞。
- **反空断言纪律**：任何「0 命中 / 0 页 / 全部一致」的结论必须配一条能红的 canary（本仓库吃过两次假绿）。
- 提交一律 `git commit -s`（DCO），**不推送**；`git add` 只加本任务列出的文件，不用 `-A`。
- 新建文件名一律 ASCII；`repowiki/topics/` 下的中文相对路径是 M2 才出现的内容，本计划不创建。
- 基线数字（本次实测，仅供对账，不可当结论引用）：`python -m pytest tools/test_wiki_drift.py -q` ⇒ **77 passed / 28.2s**；`bash tools/ci_grep_gates.sh` ⇒ **rc=1**，唯一红项是 `./.qoder/repowiki/knowledge/…/架构设计.md:2`（口径缺陷 ⑫，本期不修）；`git diff --name-only upstream/main...HEAD` ⇒ **274 个文件**，受保护路径 **0**；`git grep -icE 'worldquant'` 排除 `tools/ci_grep_gates.sh` 后 ⇒ **0 个文件**。
- 用例总数的**预测**（81→85→91→98→104→107）只用于发现「漏写/误删用例」；与实测不一致时以实测为准并如实记录，**不许**为对齐预测改动断言。

---

## 文件结构（M1 结束后）

| 文件 | 状态 | 职责 |
|---|---|---|
| `repowiki/README.md` | 新建 | 这棵树是什么、与上游 `wiki/` 的区别、怎么更新、谁是事实源、M5 之前的定性、本地门禁长期红一条的识别方法 |
| `tools/wiki_drift.py` | 修改 | ①`WikiRoot` 路径解析；②frontmatter 编解码 + `body_sha`；③逐页基线优先；④盖章/改锚时回写 frontmatter |
| `tools/test_wiki_drift.py` | 修改 | 新增 5 组用例；**有意修改 1 条既有用例**（空树从 exit 0 改 exit 2，理由见 Task 2） |
| `.gitignore`、`tools/ci_grep_gates.sh`、`.github/workflows/test.yml`、`wiki/**` | **禁止触碰** | 上游拥有 |

`tools/wiki_drift.py` 里那 5 个硬编码常量共在 25 处被引用（`WIKI` 4、`CONTENT` 13、`META` 4、`UPDATE_DIR` 8、`LEDGER` 6），测试文件在 5 处重新指向它们（`wired` fixture ＋ 4 个内联 `monkeypatch` 循环，行 141-145、544、550、678-682、818-822、1340-1343、1449-1453）。**策略：保留这 5 个模块全局名作为唯一存储**，只把默认值换成新树，`--wiki-root` 显式改指——这样 77 条既有用例一行都不用改（它们靠 monkeypatch 指向自己的 tmp 树）。

---

### Task 1: `repowiki/README.md` ＋ fork 自带的商标守卫用例

**Files:**
- Create: `repowiki/README.md`
- Modify: `tools/test_wiki_drift.py`（文件末尾追加一组；顶部已有 `import re`、`from pathlib import Path`、`import wiki_drift`）

**Interfaces:**
- Consumes: 无（本任务不碰 `wiki_drift.py`）
- Produces: `tools/test_wiki_drift.py::TM_NEEDLE: str`、`TM_RE: re.Pattern`、`TM_SUFFIXES: set[str]`、`REAL_REPO: Path`、`scan_trademark(root: Path) -> list[tuple[str,int]]`（Task 6 复用 `REAL_REPO` 与「先 canary 后结论」的写法）

- [ ] **Step 1: 先写会红的守卫用例**

追加到 `tools/test_wiki_drift.py` 末尾：

```python
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
```

- [ ] **Step 2: 跑一次，确认它因为「树还不存在」而红**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q -k "tm_guard or cjk or contain_the_literal or trademark_clean"`
Expected: 3 passed ＋ 1 FAILED — `test_shipped_wiki_tree_is_trademark_clean` 报 `AssertionError: repowiki/ must exist from M1 onward`。前三条只依赖测试自身就应先绿，这是有意的：**先证明判据能用，再让它去判仓库**。

- [ ] **Step 3: 写 `repowiki/README.md`**

全文如下（**正文不得出现商标字面量**，政策引用一律走指针；下面这段是待写入的正文，代码围栏是文档内容的一部分）：

````markdown
# repowiki/ — 仓库自有的 Repo Wiki 文档树

这是**本仓库自己的**Repo Wiki 事实源：被 git 跟踪的 Markdown 树，读写、漂移检测、
链接重锚、盖章全部可在 CLI 侧闭环，不依赖 Qoder IDE。

**它不是 `wiki/`。** 仓库根的 `wiki/` 是上游的公开文档站（Cloudflare Pages，
`vibetrading.wiki`），由上游拥有、由 `wiki.yml` / `wiki-deploy.yml` 部署。本树
不改动它一个字节，两棵树互不影响。

## 谁是事实源

- 事实源：本目录下的 Markdown ＋ `ledger.jsonl`（担保日志）。
- 非事实源：`.qoder/repowiki/**` 是 Qoder IDE 的导出物，冻结在 2026-08-14 的索引
  快照上，并被 `.git/info/exclude` 排除（git 不知道它存在，因此没有撤销能力）。
  `SearchKnowledge` 读的是那份 IDE 索引，所以它的 overview 会长期显示过期内容 —
  这是上游限制，只能标注，不能消除。

## 怎么更新

```bash
cd "E:/Vibe-Trading-main/Vibe-Trading-main"
python -X utf8 tools/wiki_drift.py --wiki-root repowiki report
python -X utf8 tools/wiki_drift.py --wiki-root repowiki reanchor --shifts --apply
python -X utf8 tools/wiki_drift.py --wiki-root repowiki mark \
    --page <相对 topics/ 的页路径> -m "<这次核对改了什么>"
```

每页 frontmatter 的 `verified_at` 是**该页上次核对时所处的 commit**：基线随页面走，
在 git 里可 diff、可回滚。`anchors` 记链接坐标是否已核，`vouch` 记这次盖章担保到
什么范围（`all` 只允许人工盖章写出，工具自动改链接只能写 `applied-only`）。

## 当前定性（M5 之前）

**链接层已核、散文层未核，别当事实源引用。** 播种进来的正文来自 IDE 快照，链接
坐标已全仓改写并验证幂等，但散文自 2026-08-14 起没被人重读过。

## 已知长期现象

`bash tools/ci_grep_gates.sh` 在本地**长期红一条**，且永远只有那一条：命中路径以
`./.qoder/` 开头就是它。那是门禁 (b) 按文件系统扫描的口径缺陷（IDE 导出物被 git
排除、CI 的 checkout 里没有该目录），修它要改上游拥有的 `tools/ci_grep_gates.sh`，
与「二次开发不动需要同步的上游原始部分」冲突，因此记为遗留。

**不要为了把它改绿去动上游脚本，也不要新开目录豁免。** 发布物合规靠两件事：
措辞合规（见 `项目档案.md`）＋ fork 自带的守卫用例
（`tools/test_wiki_drift.py` 里那组扫本树的商标检查，它会随一次真违规变红）。
````

- [ ] **Step 4: 跑守卫用例，确认全绿**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q -k "tm_guard or cjk or contain_the_literal or trademark_clean"`
Expected: 4 passed。若仍报 `repowiki/ must exist`，说明 README 落错目录（必须是仓库根 `repowiki/README.md`）。

- [ ] **Step 5: 确认没把字面量落进任何被跟踪文件**

Run: `git grep -icE 'worldquant' -- . ':(exclude)tools/ci_grep_gates.sh' | wc -l`
Expected: `0`。（基线事实：上游门禁脚本自己带 5 处该字面量，是它工作的必要条件，故排除。）

- [ ] **Step 6: 全量测试不退化**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q`
Expected: **81 passed**（77 ＋ 4）。

- [ ] **Step 7: 提交**

```bash
git add repowiki/README.md tools/test_wiki_drift.py
git commit -s -m "feat(wiki): 建仓库根 repowiki/ 并自带商标守卫用例（不改上游门禁）"
```

---

### Task 2: `WikiRoot` 换根 + `--wiki-root` + 空树硬失败

**Files:**
- Modify: `tools/wiki_drift.py:38-46`（Usage docstring）、`:65-70`（常量块）
- Modify: `tools/wiki_drift.py:1006-1007`、`:1147-1149`、`:1245-1247`（三处空树前置检查）
- Modify: `tools/wiki_drift.py:1297-1340`（三个子命令加 `--wiki-root`）
- Modify: `tools/test_wiki_drift.py:541-546`（把「空树是 no-op」那条改成「空树是错误」）＋ 末尾追加一组

**Interfaces:**
- Consumes: 无
- Produces: `wiki_drift.WIKI_ROOT_DEFAULT = "repowiki"`、`wiki_drift.EMPTY_TREE_HINT: str`、`wiki_drift.WikiRoot`（frozen dataclass：`root: Path`、`layout: str`；方法 `resolve(value, base=None)`；属性 `content`、`update_dir`、`ledger`、`meta`、`modules`、`cards`、`index_md`）、`wiki_drift.apply_wiki_root(value) -> WikiRoot`、模块全局 `wiki_root: WikiRoot`（与既有 5 个全局一起被 `apply_wiki_root` 重指向）

- [ ] **Step 1: 写失败测试**

追加到 `tools/test_wiki_drift.py` 末尾：

```python
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


def test_empty_tree_is_an_error_not_a_green(tmp_path, monkeypatch, capsys):
    """Zero pages must not read as zero problems: an empty set that passes every
    assertion is this repo's known false green."""
    root = tmp_path / "repo"
    (root / "repowiki").mkdir(parents=True)  # README only, no topics/
    monkeypatch.setattr(wiki_drift, "REPO", root)
    monkeypatch.setattr(wiki_drift, "WIKI", root / "repowiki")
    monkeypatch.setattr(wiki_drift, "CONTENT", root / "repowiki" / "topics")
    monkeypatch.setattr(wiki_drift, "META", root / "repowiki" / "zh" / "meta" / "repowiki-metadata.json")
    monkeypatch.setattr(wiki_drift, "UPDATE_DIR", root / "repowiki" / "drift")
    monkeypatch.setattr(wiki_drift, "LEDGER", root / "repowiki" / "ledger.jsonl")
    monkeypatch.setattr(wiki_drift, "wiki_root",
                        wiki_drift.WikiRoot.resolve(root / "repowiki", base=root))
    assert main(["report"]) == 2
    err = capsys.readouterr().err
    assert "no wiki pages" in err and "--wiki-root" in err
```

再把既有那条（现 `tools/test_wiki_drift.py:541-546`）整段替换。**这是本计划唯一一处有意修改既有断言**：

```python
def test_missing_content_tree_is_an_error(wired, monkeypatch, capsys):
    """Was `..._is_a_no_op` asserting exit 0. A wiki root with zero pages cannot be
    reported as clean — that is how a half-seeded tree would lie."""
    monkeypatch.setattr(wiki_drift, "CONTENT", wired["root"] / ".qoder" / "absent")
    monkeypatch.setattr(wiki_drift, "wiki_root",
                        wiki_drift.WikiRoot.resolve(wired["wiki"], REPO=None, base=wired["root"]))
    assert cmd_report(_ns(baseline=None, page=None, top=5, json=False)) == 2
    assert "no wiki pages" in capsys.readouterr().err
```

- [ ] **Step 2: 跑一次确认红**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q -k "wiki_root or empty_tree or missing_content"`
Expected: 6 条 FAIL（`AttributeError: module 'wiki_drift' has no attribute 'WikiRoot'`；被替换的 no-op 用例因返回 0 而 FAIL）。

- [ ] **Step 3: 实现 `WikiRoot`，并把 5 个常量的默认值指向新树**

`tools/wiki_drift.py:65-70` 整段替换：

```python
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
        return self.root / ("zh" / "content" if self.layout == "ide" else "topics")

    @property
    def update_dir(self) -> Path:
        return self.root / ("update" if self.layout == "ide" else "drift")

    @property
    def ledger(self) -> Path:
        return self.root / ("update" / "ledger.jsonl" if self.layout == "ide" else "ledger.jsonl")

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
```

> 注意 `wiki_root: WikiRoot` 这几行只是类型声明（不赋值），让 `apply_wiki_root` 的 `global` 语句有声明依据，且 IDE 能推断出类型。旧值 `WIKI = REPO/".qoder"/"repowiki"` 等 5 行整体删除，`REPO` 保留。

Usage docstring（现 `:38-46`）在 `python tools/wiki_drift.py mark ...` 那两行之前插入：

```
    python tools/wiki_drift.py --wiki-root repowiki report
    python tools/wiki_drift.py --wiki-root .qoder/repowiki report   # legacy export
```

- [ ] **Step 4: 三处空树检查统一为 exit 2**

`build()` 现 `:1147-1149`（原来 `return 0`！）、`cmd_reanchor()` 现 `:1006-1007`、`cmd_mark()` 现 `:1245-1247` 三处统一替换为：

```python
    if not CONTENT.is_dir():
        print(
            EMPTY_TREE_HINT.format(content=CONTENT, root=WIKI, layout=wiki_root.layout),
            file=sys.stderr,
        )
        return 2
```

- [ ] **Step 5: 三个子命令加 `--wiki-root`**

在 `main()` 里三个 `sub.add_parser(...)` 之后（`rep.set_defaults(func=cmd_report)` 之前不动，紧跟在每个 parser 的其它 `add_argument` 前面）加同一行：

```python
    for parser in (rep, mark, reanchor):
        parser.add_argument(
            "--wiki-root",
            default=None,
            help=f"wiki tree to operate on (default {WIKI_ROOT_DEFAULT}; the IDE "
            "export stays reachable as .qoder/repowiki)",
        )
```

并在 `raw = list(argv) if argv is not None else sys.argv[1:]` 之后、`args.func(args)` 之前插入：

```python
    if getattr(args, "wiki_root", None):
        apply_wiki_root(args.wiki_root)
```

> 为什么 `main()` 不兜默认值：默认已由模块导入时的 `apply_wiki_root(WIKI_ROOT_DEFAULT)` 落地；`main()` 只在显式传参时改指，测试里 monkeypatch 的全局才不会被覆盖（`test_apply_wiki_root_repoints_the_five_globals` 钉住这一点）。

- [ ] **Step 6: 跑本任务用例 + 全量**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q`
Expected: **85 passed**（81 ＋ 4；第 5 条是对既有用例的替换，不增加数量）。

- [ ] **Step 7: 真仓手跑，确认信号是「还没播种」而不是崩**

```bash
python -X utf8 tools/wiki_drift.py report; echo "rc=$?"
python -X utf8 tools/wiki_drift.py --wiki-root .qoder/repowiki report --top 3 | head -4
```

Expected: 第一段 stderr 打 `no wiki pages under …repowiki/topics (root …repowiki, layout repo)` ＋ `--wiki-root .qoder/repowiki` 提示，`rc=2`；第二段老树照常出报告（`pages 450 total` 量级），证明 legacy 布局仍可用。

- [ ] **Step 8: 提交**

```bash
git add tools/wiki_drift.py tools/test_wiki_drift.py
git commit -s -m "feat(wiki): WikiRoot 换根到仓库根 repowiki/，空树从假绿改成 exit 2"
```

---

### Task 3: frontmatter 编解码 + `body_sha`（播种后既有 ledger 仍命中）

**Files:**
- Modify: `tools/wiki_drift.py`（在 `sha256()` 现 `:237-238` 之后插入 frontmatter 段）
- Modify: `tools/wiki_drift.py:310`、`:946`、`:1096`、`:1269`（4 处 `sha256(page)` → `body_sha(page)`）
- Modify: `tools/test_wiki_drift.py`（新增一组）

**Interfaces:**
- Consumes: `wiki_drift.sha256(path)`（保留并继续导出，M2 播种要它做整字节对账）
- Produces: `wiki_drift.FM_KEYS: tuple[str, ...]`、`split_frontmatter(text) -> tuple[dict | None, str]`、`parse_frontmatter(text) -> dict | None`、`read_frontmatter(page) -> dict | None`、`body_text(page) -> str`、`body_sha(page) -> str`、`emit_frontmatter(fm: dict) -> str`、`update_frontmatter(page, **fields) -> dict`、`frontmatter_baseline(page) -> str | None`

- [ ] **Step 1: 写失败测试**

```python
# ---------------------------------------------------------------------------
# frontmatter: the per-page baseline, and the hash that must survive adding it
# ---------------------------------------------------------------------------

FM_SAMPLE = (
    "---\n"
    'page: "回测引擎/投资组合优化器/最大分散化优化器.md"\n'
    "sources:\n"
    '  - "agent/backtest/optimizers/max_diversification.py"\n'
    '  - "agent/backtest/constraints.py"\n'
    'verified_at: "0123456789012345678901234567890123456789"\n'
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
    page.write_text("# 标题\n正文\n", encoding="utf-8")
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
    assert wiki_drift.body_text(page) == "# 标题\n正文\n"


def test_update_frontmatter_is_idempotent_and_order_stable(tmp_path):
    page = tmp_path / "p.md"
    page.write_text("# 标题\n正文\n", encoding="utf-8")
    first = wiki_drift.update_frontmatter(page, anchors="verified")
    after_first = page.read_text(encoding="utf-8")
    wiki_drift.update_frontmatter(page, anchors="verified")
    assert page.read_text(encoding="utf-8") == after_first
    assert list(first) == ["page", "sources", "verified_at", "anchors", "vouch"]
    assert "sources: []" in after_first  # empty list must parse back as a list


def test_frontmatter_baseline_only_accepts_a_reachable_full_sha(tmp_path):
    page = tmp_path / "p.md"
    page.write_text("# 标题\n", encoding="utf-8")
    assert wiki_drift.frontmatter_baseline(page) is None
    wiki_drift.update_frontmatter(page, verified_at="abc123")  # not 40 hex
    assert wiki_drift.frontmatter_baseline(page) is None
    wiki_drift.update_frontmatter(page, verified_at="0123456789abcdef" * 2 + "0123")
    assert wiki_drift.frontmatter_baseline(page) == "0123456789abcdef" * 2 + "0123"
```

- [ ] **Step 2: 跑一次确认红**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q -k "frontmatter or ledger_hash"`
Expected: 6 条 FAIL（`AttributeError: module 'wiki_drift' has no attribute 'split_frontmatter'`）。

- [ ] **Step 3: 实现编解码（不引入第三方 YAML）**

插在 `sha256()` 之后（现 `:239` 之后）。**为什么手写**：门禁 (a) 禁的是 `yaml.load`，`safe_load` 虽允许，但为一个固定五键的形状引入解析器不值得；序列化统一用 `json.dumps` 产出双引号标量（合法 YAML，CJK 与 `/` 都不必转义），空列表写成 flow 形式 `[]` 并由 `_scalar` 还原成 list。

```python
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
    return parse_frontmatter(page.read_text(encoding="utf-8", errors="replace"))


def body_text(page: Path) -> str:
    return split_frontmatter(page.read_text(encoding="utf-8", errors="replace"))[1]


def body_sha(page: Path) -> str:
    """Hash of the prose only.

    `sha_after` in the ledger means this: a page can gain or update frontmatter
    without its reconciliation claim dissolving, while a hand edit to the prose
    still voids it (the `ledger-void` path).
    """
    return hashlib.sha256(body_text(page).encode("utf-8")).hexdigest()


def emit_frontmatter(fm: dict) -> str:
    lines = ["---", f"page: {json.dumps(fm.get('page', ''), ensure_ascii=False)}"]
    sources = list(fm.get("sources") or [])
    if sources:
        lines.append("sources:")
        lines += [f"  - {json.dumps(s, ensure_ascii=False)}" for s in sources]
    else:
        lines.append("sources: []")
    lines.append(f"verified_at: {json.dumps(fm.get('verified_at', ''), ensure_ascii=False)}")
    lines.append(f"anchors: {fm.get('anchors', 'open')}")
    lines.append(f"vouch: {fm.get('vouch', 'applied-only')}")
    lines.append("---")
    return "\n".join(lines) + "\n"


def update_frontmatter(page: Path, **fields) -> dict:
    """Merge `fields` into the page's frontmatter, creating the block if absent.

    Key order is fixed to FM_KEYS and empty values are written explicitly, so a
    page rewritten twice stays byte-identical — a generator that touches pages must
    be diffable or its own output looks like an edit.
    """
    fm, body = split_frontmatter(page.read_text(encoding="utf-8"))
    merged = dict(fm or {})
    merged.update({k: v for k, v in fields.items() if v is not None})
    merged.setdefault("page", page.name)
    merged.setdefault("sources", [])
    merged.setdefault("verified_at", "")
    merged.setdefault("anchors", "open")
    merged.setdefault("vouch", "applied-only")
    ordered = {k: merged[k] for k in FM_KEYS}
    page.write_text(emit_frontmatter(ordered) + body, encoding="utf-8", newline="\n")
    return ordered


def frontmatter_baseline(page: Path) -> str | None:
    """The page's own `verified_at`, or None when it is absent/unusable."""
    fm = read_frontmatter(page)
    if not fm:
        return None
    rev = str(fm.get("verified_at") or "").strip()
    return rev if HEX40_RE.match(rev) else None
```

再把 4 处整文件哈希改为正文哈希（**语义变更：`sha_after` 从此是正文的哈希**）：

| 现行号 | 原式 | 改为 |
|---|---|---|
| `:310`（`effective_base`） | `if sha256(page) != entry.sha_after:` | `if body_sha(page) != entry.sha_after:` |
| `:946`（`stamp_links`） | `"sha_after": sha256(page),` | `"sha_after": body_sha(page),` |
| `:1096`（`cmd_reanchor`） | `entry.sha_after == sha256(page)` | `entry.sha_after == body_sha(page)` |
| `:1269`（`cmd_mark`） | `"sha_after": sha256(page),` | `"sha_after": body_sha(page),` |

- [ ] **Step 4: 跑本组 + 全量**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q`
Expected: **91 passed**（85 ＋ 6）。**特别核对**：断言 `sha_after == sha256(page)` 的既有用例（`:444`、`:976`、`:1070`、`:1202`）仍全绿——fixture 的页面无 frontmatter，两者相等，这正是「换哈希口径不使既有台账失效」的证明。

- [ ] **Step 5: 提交**

```bash
git add tools/wiki_drift.py tools/test_wiki_drift.py
git commit -s -m "feat(wiki): 页面 frontmatter 编解码，ledger 改哈希正文而非整文件"
```

---

### Task 4: 逐页基线优先（`verified_at` > ledger > 快照）＋ 报告点名漏播种

**Files:**
- Modify: `tools/wiki_drift.py:293-316`（`effective_base`）、`:324-347`（`PageReport`）、`:403-443`（`audit_page`）、`:899-919`（`recorded_drivers`）、`:482-500`（`render_markdown` 头部）、`:1196-1207`（`build` 的 summary）
- Modify: `tools/test_wiki_drift.py`（新增一组）

**Interfaces:**
- Consumes: `frontmatter_baseline(page)`、`read_frontmatter(page)`（Task 3）
- Produces: `effective_base` 的 tag 集合新增 `"frontmatter"`；`PageReport.fm: str`（`"present" | "missing"`）；`payload["summary"]["no_frontmatter"]: int`；`payload["summary"]["frontmatter"]: int`

- [ ] **Step 1: 写失败测试**

```python
# ---------------------------------------------------------------------------
# per-page baseline beats the single global snapshot; missing frontmatter is loud
# ---------------------------------------------------------------------------


def _refs_for(wired):
    return wiki_drift.make_changes_for()


def test_frontmatter_baseline_wins_over_ledger_and_snapshot(wired):
    page = wired["content"] / "前端应用" / "模块说明.md"
    wiki_drift.update_frontmatter(page, page="前端应用/模块说明.md", verified_at=wired["head"])
    base, tag = wiki_drift.effective_base(page, "前端应用/模块说明.md", {}, wired["base"])
    assert (base, tag) == (wired["head"], "frontmatter")


def test_unreachable_frontmatter_rev_does_not_become_a_baseline(wired):
    """A seeded page may name a commit a force-pushed sync GC'd. The snapshot stays
    the honest base — a phantom baseline would freeze the page's drift at zero."""
    page = wired["content"] / "前端应用" / "模块说明.md"
    wiki_drift.update_frontmatter(page, verified_at="deadbeef" + "0" * 32)
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
    wiki_drift.update_frontmatter(page, verified_at=wired["head"])
    rep = audit_page(
        page, "前端应用/模块说明.md", "frontmatter", wired["head"],
        _refs_for(wired), set(), set(),
    )
    assert rep.score == 0 and rep.state == "frontmatter"


def test_recorded_drivers_are_measured_from_the_page_baseline(wired):
    """Drivers must follow the same precedence, or a stamped page would list itself
    as owing everything since the snapshot."""
    page = wired["content"] / "前端应用" / "模块说明.md"
    wiki_drift.update_frontmatter(page, verified_at=wired["head"])
    stale, _broken = wiki_drift.recorded_drivers(page, "前端应用/模块说明.md", wired["base"])
    assert stale == []


def test_report_counts_pages_without_frontmatter(wired, capsys):
    assert main(["report", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["summary"]["no_frontmatter"] == 2
    assert payload["summary"]["pages"] == 2


def test_drift_md_names_the_missing_frontmatter(wired):
    main(["report", "--top", "5"])
    text = (wired["wiki"] / "update" / "DRIFT.md").read_text(encoding="utf-8")
    assert "缺 frontmatter 的页面：2" in text
```

- [ ] **Step 2: 跑一次确认红**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q -k "frontmatter_baseline or unreachable_frontmatter or flagged or provenance or recorded_drivers or without_frontmatter or drift_md"`
Expected: 6 条 FAIL（tag 仍是 `"snapshot"`；`PageReport` 无 `fm`；summary 无 `no_frontmatter`）。`test_ledger_still_wins_over_the_snapshot` 与 `test_partial_entry_still_does_not_move_the_baseline` 应直接通过——它们是**回归护栏**，防止优先级插入把 ledger 两条分支写坏。

- [ ] **Step 3: 实现优先级**

`effective_base`（现 `:293-316`）整段替换——**顺序即优先级，注释写清理由**：

```python
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
```

`PageReport`（现 `:324-347`）加字段并进 `to_dict`：

```python
    fm: str = "present"  # present | missing — `missing` after seeding means a page was skipped
```

```python
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
```

`audit_page` 两处（现 `:413-415` 与 `:432-433`）：

```python
    rep = PageReport(page=rel, state=tag, base=base, refs=len(refs))
    rep.fm = "present" if read_frontmatter(page) else "missing"
```

```python
    if rep.score == 0:
        rep.state = (
            tag if tag in ("reconciled", "ledger-void", "partial", "frontmatter") else "clean"
        )
        return rep
```

`recorded_drivers`（现 `:899-919`）改为按页取基线（其余逻辑不动）：

```python
def recorded_drivers(page: Path, rel: str, fallback: str | None) -> tuple[list[str], list[str]]:
    """Cited files that changed since this page's own baseline, plus cites that are gone.

    The page's frontmatter `verified_at` wins over the snapshot, matching
    `effective_base`: a stamp claims to cover the window the page actually owes, and
    diffing against HEAD would come out empty by construction and prove nothing.
    """
    base = frontmatter_baseline(page) or fallback
    if not (base and rev_reachable(base)):
        return [], []
    dirty, untracked = worktree_delta()
    rep = audit_page(
        page, rel, "reconciled", base,
        make_changes_for(), dirty, untracked, record_broken=True,
    )
    return sorted(set(rep.stale)), sorted(set(rep.broken))
```

`build()` 的 summary（现 `:1196-1207`）加两项：

```python
            "no_frontmatter": sum(1 for r in reports if r.fm == "missing"),
            "frontmatter": sum(1 for r in reports if r.state == "frontmatter"),
```

`render_markdown` 头部（现 `:491-492` 那条「页面」之后）插入一行：

```python
        f"- 缺 frontmatter 的页面：{s['no_frontmatter']}"
        "（播种之前应为全部；播种之后非零即漏播种）",
```

- [ ] **Step 4: 跑本组 + 全量**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q`
Expected: **98 passed**（91 ＋ 7）。

- [ ] **Step 5: 变异探针（三态判定；survived ⇒ 换观测点，不许放宽断言）**

```bash
# 探针 1：摘掉 frontmatter 优先级 —— 期望 test_frontmatter_baseline_wins_over_ledger_and_snapshot 红
python - <<'PY'
from pathlib import Path
p = Path("tools/wiki_drift.py"); orig = p.read_bytes()
mut = orig.replace(b"    if fm_rev and rev_reachable(fm_rev):", b"    if False and fm_rev and rev_reachable(fm_rev):")
assert mut != orig, "needle not found: harness-blind, fix the needle"
p.write_bytes(mut)
PY
python -X utf8 -m pytest tools/test_wiki_drift.py -q -k frontmatter_baseline
git checkout -- tools/wiki_drift.py

# 探针 2：不可达 rev 也当基线 —— 期望 test_unreachable_frontmatter_rev_does_not_become_a_baseline 红
python - <<'PY'
from pathlib import Path
p = Path("tools/wiki_drift.py"); orig = p.read_bytes()
mut = orig.replace(b"    if fm_rev and rev_reachable(fm_rev):", b"    if fm_rev:")
assert mut != orig, "needle not found: harness-blind"
p.write_bytes(mut)
PY
python -X utf8 -m pytest tools/test_wiki_drift.py -q -k unreachable_frontmatter
git checkout -- tools/wiki_drift.py

# 探针 3：no_frontmatter 恒 0 —— 期望两条计数类用例红
python - <<'PY'
from pathlib import Path
p = Path("tools/wiki_drift.py"); orig = p.read_bytes()
mut = orig.replace(b'"no_frontmatter": sum(1 for r in reports if r.fm == "missing"),', b'"no_frontmatter": 0,')
assert mut != orig, "needle not found: harness-blind"
p.write_bytes(mut)
PY
python -X utf8 -m pytest tools/test_wiki_drift.py -q -k "without_frontmatter or drift_md"
git checkout -- tools/wiki_drift.py
git status --porcelain
```

Expected: 三支均 FAILED（killed）；最后 `git status --porcelain` 无输出。把每支的三态结论记进 Task 7 的汇报。

- [ ] **Step 6: 提交**

```bash
git add tools/wiki_drift.py tools/test_wiki_drift.py
git commit -s -m "feat(wiki): 基线下沉到页面 frontmatter，报告点名漏播种的页"
```

---

### Task 5: 盖章与改锚时回写 frontmatter（含「partial 不推进基线」「IDE 根不动字节」）

**Files:**
- Modify: `tools/wiki_drift.py`（新增 `anchors_axis()` / `stamp_frontmatter()`；`cmd_mark` 现 `:1277-1286` 之后写回；`cmd_reanchor` 写页处现 `:1097-1100` 之后写回）
- Modify: `tools/test_wiki_drift.py`（新增 `repo_tree` + `repo_wired` fixture ＋ 一组用例）

**Interfaces:**
- Consumes: `update_frontmatter`、`read_frontmatter`、`body_sha`（Task 3）、`wiki_root.layout`（Task 2）
- Produces: `wiki_drift.anchors_axis(past_end: int) -> str`、`wiki_drift.stamp_frontmatter(page, *, verified_at=None, anchors=None, vouch=None) -> dict | None`；fixture `repo_wired`（M2/M3 的播种与 stale 用例可直接复用）

- [ ] **Step 1: 写失败测试（含新 fixture）**

```python
@pytest.fixture
def repo_tree(tmp_path, body):
    """A git repo whose wiki uses the *repo* layout: repowiki/topics/... .

    Mirrors `repo` (the IDE-layout fixture) but with the tracked shape M1 moves to,
    so the write-back tests exercise `layout == "repo"`. The second commit inserts
    lines ABOVE the cited block: the block still exists, it just moved down, which
    is exactly what `reanchor --shifts` claims to prove.
    """
    root = tmp_path / "repo"
    root.mkdir()
    _git(root, "init", "-b", "main")
    _git(root, "config", "user.email", "test@example.com")
    _git(root, "config", "user.name", "Test")
    (root / "src").mkdir()
    (root / "src" / "mod.py").write_text(body("print(1)"), encoding="utf-8")
    _git(root, "add", "-A")
    _git(root, "commit", "-m", "snapshot baseline")
    base = _git(root, "rev-parse", "HEAD").strip()

    wiki = root / "repowiki"
    content = wiki / "topics" / "前端应用"
    content.mkdir(parents=True)
    page = content / "模块说明.md"
    page.write_text(
        "# 模块说明\n\n<cite>\n**本文引用的文件**\n"
        "- [mod.py](file://src/mod.py#L10-L40)\n</cite>\n\n## 简介\n",
        encoding="utf-8",
    )
    _git(root, "add", "-A")
    _git(root, "commit", "-m", "seed the repo-owned wiki tree")

    lines = (root / "src" / "mod.py").read_text(encoding="utf-8").splitlines()
    (root / "src" / "mod.py").write_text(
        "\n".join(["# inserted above the cited block"] * 6 + lines) + "\n", encoding="utf-8"
    )
    _git(root, "add", "-A")
    _git(root, "commit", "-m", "insert lines above the cited block")
    head = _git(root, "rev-parse", "HEAD").strip()
    return {
        "root": root, "wiki": wiki, "content": content, "page": page,
        "base": base, "head": head,
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


def test_partial_stamp_never_moves_verified_at(repo_wired):
    """Contract: a links-only / unfinished stamp may sign the ledger but must not
    advance the page's baseline, or the page drops out of the queue unsolved."""
    page = repo_wired["page"]
    rel = "前端应用/模块说明.md"
    assert main(["mark", "--page", rel, "--partial", "-m", "cites only"]) == 0
    fm = wiki_drift.read_frontmatter(page)
    assert fm["verified_at"] == "" and fm["vouch"] == "applied-only"
    row = wiki_drift.load_ledger()[rel]
    assert row.partial is True and row.cites == "applied-only"


def test_body_sha_stable_across_frontmatter_write(repo_wired):
    page = repo_wired["page"]
    rel = "前端应用/模块说明.md"
    assert main(["mark", "--page", rel, "-m", "first"]) == 0
    first = wiki_drift.load_ledger()[rel].sha_after
    assert first == wiki_drift.sha256(page) != wiki_drift.body_sha(page)
    assert main(["mark", "--page", rel, "-m", "second"]) == 0
    assert wiki_drift.load_ledger()[rel].sha_after == first


def test_ide_layout_root_stays_byte_identical(wired):
    """The legacy export must not be rewritten: frontmatter belongs to the repo tree,
    and touching 450 IDE bytes would recreate the second source of truth."""
    monkey_root = wired["root"]
    monkey_ide = wiki_drift.WikiRoot.resolve(wired["wiki"], base=monkey_root)
    assert monkey_ide.layout == "ide"
    page = wired["content"] / "前端应用" / "模块说明.md"
    before = page.read_bytes()
    import pytest as _pytest
    # `stamp_frontmatter` reads the module-global `wiki_root`; assert the guard by
    # calling it while the global still describes an IDE-shaped root.
    real = wiki_drift.wiki_root
    try:
        wiki_drift.wiki_root = monkey_ide
        assert wiki_drift.stamp_frontmatter(page, verified_at="a" * 40) is None
    finally:
        wiki_drift.wiki_root = real
    assert page.read_bytes() == before


def test_anchor_axis_is_open_when_a_cite_was_refused():
    """The decision `reanchor --apply` records: the tool refuses to invent targets
    for ranges that stop past the end, so that page's anchor axis is NOT verified."""
    assert wiki_drift.anchors_axis(0) == "verified"
    assert wiki_drift.anchors_axis(2) == "open"


def test_reanchor_apply_writes_the_anchor_axis_back(repo_wired):
    page = repo_wired["page"]
    assert main(["reanchor", "--page", "前端应用/模块说明.md", "--shifts", "--apply"]) == 0
    fm = wiki_drift.read_frontmatter(page)
    assert fm is not None, "a repo-layout page must gain frontmatter after --apply"
    assert fm["anchors"] in {"verified", "open"}
    assert fm["vouch"] == "applied-only"  # a tool pass never vouches the whole page
```

- [ ] **Step 2: 跑一次确认红**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q -k "repo_wired or stamp or body_sha_stable or ide_layout_root_stays or anchor_axis"`
Expected: FAIL —— `AttributeError: module 'wiki_drift' has no attribute 'stamp_frontmatter'`；`fm is None` / `fm["verified_at"] == ""` 类断言失败。`test_repo_wired_fixture_is_the_repo_layout` 与 `test_ide_layout_root_stays_byte_identical` 可能先失败于缺函数，属预期。

- [ ] **Step 3: 实现写回**

`update_frontmatter` 之后新增：

```python
def anchors_axis(past_end: int) -> str:
    """`verified` only when nothing was left unprovable on this page."""
    return "open" if past_end else "verified"


def stamp_frontmatter(
    page: Path,
    *,
    verified_at: str | None = None,
    anchors: str | None = None,
    vouch: str | None = None,
) -> dict | None:
    """Write the stamp back onto the page — for the repo-owned tree only.

    The IDE export is a read-only snapshot by design (its own metadata drives the
    IDE's incremental regeneration), and rewriting its bytes from here would create
    the second source of truth this whole milestone exists to remove.
    """
    if wiki_root.layout != "repo":
        return None
    return update_frontmatter(page, verified_at=verified_at, anchors=anchors, vouch=vouch)
```

`cmd_mark` 内，`with LEDGER.open("a", ...)` 写入那一段**之后**、`if args.partial:` 打印之前插入：

```python
    # A hand stamp vouches for the whole page and moves its baseline; a partial one
    # records unfinished work and must leave `verified_at` where it was.
    if not args.partial:
        stamp_frontmatter(page, verified_at=head, vouch="all")
```

`cmd_reanchor` 内 `page.write_text(text, ...)` 与 `signed = stamp_links(...)` 之后（同一 `if args.apply and text != original:` 块内，`stamped += 1` 之前）插入：

```python
            # Past-the-end cites were left as printed on purpose, so the anchor axis
            # is only `verified` when this page had none of those.
            stamp_frontmatter(page, anchors=anchors_axis(past_end))
```

`stamp_links()` 不改：它只写 ledger，`cites: "applied-only"` 是它的既有契约（Task 5 的 `fm["vouch"] == "applied-only"` 断言的是 frontmatter 的默认值，不是工具写了 `all`）。

- [ ] **Step 4: 跑全量**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q`
Expected: **104 passed**（98 ＋ 6）。

- [ ] **Step 5: 变异探针两支**

```bash
# 探针 4：partial 也推进基线 —— 期望 test_partial_stamp_never_moves_verified_at 红
python - <<'PY'
from pathlib import Path
p = Path("tools/wiki_drift.py"); orig = p.read_bytes()
mut = orig.replace(b"    if not args.partial:\n        stamp_frontmatter(page, verified_at=head, vouch=\"all\")",
                   b"    if True:\n        stamp_frontmatter(page, verified_at=head, vouch=\"all\")")
assert mut != orig, "needle not found: harness-blind"
p.write_bytes(mut)
PY
python -X utf8 -m pytest tools/test_wiki_drift.py -q -k partial_stamp
git checkout -- tools/wiki_drift.py

# 探针 5：IDE 布局也写 frontmatter —— 期望 test_ide_layout_root_stays_byte_identical 红
python - <<'PY'
from pathlib import Path
p = Path("tools/wiki_drift.py"); orig = p.read_bytes()
mut = orig.replace(b'    if wiki_root.layout != "repo":\n        return None',
                   b'    if False:\n        return None')
assert mut != orig, "needle not found: harness-blind"
p.write_bytes(mut)
PY
python -X utf8 -m pytest tools/test_wiki_drift.py -q -k ide_layout_root_stays
git checkout -- tools/wiki_drift.py
git status --porcelain
```

Expected: 两支 FAILED（killed）；`git status --porcelain` 无输出。

- [ ] **Step 6: legacy 根未被写坏（真实仓库手跑）**

```bash
python -X utf8 tools/wiki_drift.py --wiki-root .qoder/repowiki reanchor --page 安装与配置 --shifts | head -5
```

Expected: dry-run 正常输出（不写文件），证明 `layout == "ide"` 这条路仍走老逻辑。

- [ ] **Step 7: 提交**

```bash
git add tools/wiki_drift.py tools/test_wiki_drift.py
git commit -s -m "feat(wiki): mark/reanchor 回写页面 frontmatter（partial 不推进基线）"
```

---

### Task 6: 零上游文件改动守卫用例（含能红的 canary）

**Files:**
- Modify: `tools/test_wiki_drift.py`（末尾追加；不新增文件，YAGNI）

**Interfaces:**
- Consumes: `REAL_REPO`（Task 1）
- Produces: `UPSTREAM_OWNED: re.Pattern`、`changed_vs_upstream() -> list[str]`

- [ ] **Step 1: 写测试**

```python
# ---------------------------------------------------------------------------
# zero-upstream-file-changes: a falsifiable requirement, not a good intention
# ---------------------------------------------------------------------------
#
# Upstream owns .gitignore, tools/ci_grep_gates.sh, .github/workflows/test.yml and
# wiki/** (measured with `git ls-tree -r --name-only upstream/main -- <path>`). Any
# commit touching them turns every `merge upstream/main` — which is how this fork
# stays current, and which has no force/reset escape hatch — into a hand conflict.
# That is the one thing the owner asked not to happen.

UPSTREAM_OWNED = re.compile(
    r"^(\.gitignore|tools/ci_grep_gates\.sh|\.github/workflows/test\.yml|wiki/)"
)


def changed_vs_upstream() -> list[str]:
    proc = subprocess.run(
        ["git", "-C", str(REAL_REPO), "-c", "core.quotepath=off",
         "diff", "--name-only", "upstream/main...HEAD"],
        capture_output=True, text=True, encoding="utf-8",
    )
    if proc.returncode != 0:
        raise RuntimeError(
            f"upstream/main is not resolvable here ({proc.stderr.strip()}) — "
            "run `git fetch upstream` first. This check must fail, never skip."
        )
    return [line for line in proc.stdout.splitlines() if line.strip()]


def test_protected_path_predicate_flags_known_owned_paths():
    """Canary: the filter has to be able to say yes, or an empty diff proves nothing."""
    for path in (".gitignore", "tools/ci_grep_gates.sh", ".github/workflows/test.yml",
                 "wiki/home/index.html"):
        assert UPSTREAM_OWNED.match(path), path
    for path in ("tools/wiki_drift.py", "repowiki/README.md", "docs/x/y.md", "agent/src/x.py"):
        assert not UPSTREAM_OWNED.match(path), path


def test_fork_change_set_is_not_empty():
    assert len(changed_vs_upstream()) > 100  # measured 274 at M1 time


def test_no_fork_commit_touches_an_upstream_owned_file():
    offenders = [p for p in changed_vs_upstream() if UPSTREAM_OWNED.match(p)]
    assert offenders == [], f"upstream-owned files modified by fork commits: {offenders}"
```

- [ ] **Step 2: 跑一次**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q -k "protected_path or fork_change_set or upstream_owned"`
Expected: 3 passed。若 `RuntimeError: upstream/main is not resolvable` ⇒ 先 `git fetch upstream`（走本机代理），**不许**把抛错改成 skip。

- [ ] **Step 3: 反证——真改一个上游文件，用例必须变红**

```bash
git log --oneline -1                      # 记住当前位置，下面只回退一条自己刚造的提交
printf '\n# canary: pretend the fork edited upstream\n' >> .gitignore
git add .gitignore && git commit -s -m "canary: touch an upstream file"
python -X utf8 -m pytest tools/test_wiki_drift.py -q -k upstream_owned
```

Expected: **FAILED**，且信息点名 `.gitignore`。随后撤销（这条提交是本会话刚创建的、未推送）：

```bash
git reset --hard HEAD~1
git status --porcelain
python -X utf8 -m pytest tools/test_wiki_drift.py -q -k upstream_owned
```

Expected: 用例重新变绿；`git status --porcelain` 无输出；`git log --oneline -1` 回到 Step 3 开始前那条。**执行前必须用 `git log --oneline -3` 确认 HEAD~1 就是那条 `canary:` 提交**——`git reset --hard` 是破坏性操作，这里只允许回退自己刚造的这一条。

- [ ] **Step 4: 提交**

```bash
git add tools/test_wiki_drift.py
git commit -s -m "test(wiki): 零上游文件改动守卫（含能红的 canary）"
```

---

### Task 7: M1 收尾验收

**Files:**
- Modify: `项目档案.md`（「重做设计」小节状态行 ＋ 一条 M1 实测记录）
- Modify（本地、不被跟踪）: `docs/superpowers/specs/2026-10-01-repo-wiki-rebuild-design.md` §13 的 M1 行——把「已落地」与实际数字写回

**Interfaces:**
- Consumes: Task 1–6 的全部产物
- Produces: M2 计划的输入（播种清单见 spec §11）

- [ ] **Step 1: 全量测试**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q`
Expected: 预测 **107 passed**（基线 77 ＋ 新增 30）。以实测为准，并把数字写进 Step 5 的档案条目。

- [ ] **Step 2: 门禁失败集不变**

```bash
bash tools/ci_grep_gates.sh > .qoder/tmp/gates_m1.txt 2>&1; echo "rc=$?"
grep -vE 'WARN|^$' .qoder/tmp/gates_post.txt > .qoder/tmp/g_base.txt
grep -vE 'WARN|^$' .qoder/tmp/gates_m1.txt  > .qoder/tmp/g_new.txt
diff .qoder/tmp/g_base.txt .qoder/tmp/g_new.txt && echo "GATE OUTPUT IDENTICAL"
```

Expected: `rc=1` ＋ `GATE OUTPUT IDENTICAL`（唯一红仍是那条 `./.qoder/…`；M1 的新树贡献 0 命中）。**「跳过」不等于「通过」**：diff 为空但门禁根本没跑时 rc 会是 0，那时要先查为什么没跑。

- [ ] **Step 3: 零上游改动（独立于 Task 6 用例再手跑一次）**

```bash
git diff --name-only upstream/main...HEAD | grep -cE '^(\.gitignore|tools/ci_grep_gates\.sh|\.github/workflows/test\.yml|wiki/)'
git diff --name-only upstream/main...HEAD | wc -l
git ls-tree -r --name-only upstream/main -- repowiki | wc -l
```

Expected: 依次 `0`、`>274`（M1 新增文件使它变大）、`0`（上游没有 `repowiki/` ⇒ 无同名冲突）。

- [ ] **Step 4: 工作区洁净 + 排除目录未被顺手改动**

```bash
git status --porcelain
python -X utf8 tools/wiki_drift.py --wiki-root .qoder/repowiki report --top 1 | head -3
python -X utf8 tools/wiki_drift.py report; echo "rc=$?"
```

Expected: `git status --porcelain` 只剩本步骤要改的 `项目档案.md`；legacy 根仍出报告（`pages 450 total` 量级）；默认根仍 `rc=2` 并给出播种未完成的可复制提示（Task 2 的已知副作用，不是回归）。

- [ ] **Step 5: 更新档案的 M1 状态**

把「重做设计」小节标题后缀从 `（2026-10-01，待用户评审，未开工）` 改为 `（2026-10-01，M1 已落地 / M2 待开工）`，并在里程碑那条之后追加：

```markdown
- **M1 已落地**：`repowiki/README.md` ＋ `WikiRoot` 换根（默认 `repowiki`，`.qoder/repowiki` 靠 `--wiki-root` 仍可指）＋ 页面 frontmatter（基线下沉到页，ledger 改哈希正文）＋ 两条 fork 自带守卫（商标按路径限定、零上游改动检查）。实测：`pytest tools/test_wiki_drift.py` **<N> passed**（基线 77）；门禁失败集与基线**逐行相同**；`upstream/main...HEAD` 里受保护路径 **0**、变更文件 **<M> 个**；变异探针 5 支全部 killed。**M1 未搬任何正文**：494 页仍在 `.qoder/` 里等 M2 播种，默认根未播种时 `report` 故意 `exit 2`。
```

`<N>`/`<M>` 用 Step 1 与 Step 3 的实测值替换。

- [ ] **Step 6: 提交并汇报**

```bash
git add 项目档案.md
git commit -s -m "docs(profile): 记录 M1 落地的实测数字与未播种状态"
git log --oneline -8
```

汇报必须包含：用例总数与 passed 数、门禁 diff 结论、零上游检查三个数字、`repowiki/` 当前只有 README 这一事实、5 支变异探针的三态结论、「散文层未核，别当事实源」的定性仍成立、以及**未推送**（`git rev-list --count origin/main..HEAD` 的实际值）。

---

## Self-Review（对照 spec 的复查）

**1. Spec 覆盖（M1 范围）**

| spec 条目 | 落在哪个任务 |
|---|---|
| §13 M1「`WikiRoot` 换根」 | Task 2 |
| §13 M1「frontmatter schema」 | Task 3（编解码）＋ 4（基线优先）＋ 5（回写） |
| §13 M1「fork 自带守卫用例，且能红」 | Task 1（商标：planted-hit ＋ CJK 文件名 canary）＋ Task 6（零上游改动：谓词 canary ＋ 真提交反证） |
| §13 M1「README 写清与 `wiki/` 的区别」 | Task 1 Step 3 |
| §13 M1「此时 `repowiki/` 只有 README，不搬一个字节」 | Task 2 Step 7 ＋ Task 7 Step 4 |
| §13 M1「77 例不退」 | 每个任务末尾跑全量；Task 2 唯一一处有意改既有断言并写明理由 |
| §6 表「`--wiki-root` 默认 `repowiki`；老路径保留一个版本周期」 | Task 2 Step 3/5/7 |
| §6 表「frontmatter 回落并报警」 | Task 4（`rep.fm = "missing"` ＋ summary 计数 ＋ DRIFT.md 一行） |
| §6 表「`mark` 回写 `vouch: all`、`verified_at: HEAD`」/「reanchor 回写 `anchors`」 | Task 5 |
| §6 末「五条契约不得退化」 | Task 3（sha 口径）、Task 4（`partial` 不推进 ＋ `cites` 范围回归用例）、Task 5（`partial` 不推进落到 frontmatter ＋ IDE 根不动字节） |
| §12「反空断言」 | Task 1 空树守卫、Task 2 空树 exit 2、Task 4 计数用例、Task 6 `fork_change_set_is_not_empty` |
| §12「每条新代码行变异探针三态」 | Task 4 Step 5（3 支）＋ Task 5 Step 5（2 支） |
| §9.2「守卫必须按路径限定，不能断言整个跟踪集 = 0」 | Task 1（`scan_trademark(repowiki/)`）＋ Task 1 Step 5 的排除式 `git grep` |
| §10.1「`.qoder/` 继续留在 `.git/info/exclude`」 | Task 5 的 IDE 布局保护 ＋ Task 7 Step 4 |

**2. 占位符扫描**：Task 7 Step 5 的 `<N>`/`<M>` 是**要现场测出来的数字**（预测值已给出且标明只用于发现漏写用例），不是「以后再填」；其余步骤均给可执行正文，无 TBD/「适当处理」。起草时我写过一条坏断言（`scan_trademark(...) == [...].join(()) or ...`），已在本版本替换为 `test_guard_sees_a_cjk_named_page`。

**3. 类型一致性**：`effective_base(page, rel, ledger, fallback) -> (str, str)` 签名未变，只扩 tag 取值；`PageReport.fm` 带默认值故既有构造点不破；`WikiRoot.resolve(value, base=None)` 在 Task 2 定义、Task 5 fixture 用 `base=`；`anchors_axis(past_end: int) -> str` 只在 Task 5 出现（定义＋使用一致）；`stamp_frontmatter` 读全局 `wiki_root`（Task 2 落地）；`body_sha`/`sha256` 两个名字在 Task 3 定义、Task 4/5 引用一致；`recorded_drivers(page, rel, fallback)` 签名不变（`fallback` 仍可为 `None`）。

**4. 三处已知风险（写明而不是藏起来）**

- **默认根改成 `repowiki` 后，不带 `--wiki-root` 的旧调用会 `exit 2` 直到 M2 播种。** 这是有意的假绿防护；`repowiki/README.md` 与错误文案都给了 `--wiki-root .qoder/repowiki` 逃生口。`项目档案.md` 里既有命令示例在 Task 7 不必回改（M2 播种后即可用），但要在档案的 M1 条目里点明这一条。
- **Task 5 的 `test_ide_layout_root_stays_byte_identical` 临时改写模块全局 `wiki_root`**（用 `try/finally` 还原），因为该函数读全局。若后续把它改成参数注入会更干净，但那要改 3 个调用点，超出 M1 的最小改动；此处以「显式还原 ＋ fixture 的 monkeypatch 兜底」承担。
- **Task 6 的 canary 需要一次真提交与一次 `git reset --hard HEAD~1`**。这是本计划唯一的破坏性动作，限定在「刚由本任务创建、未推送」的那条 `canary:` 提交上，且步骤里要求执行前用 `git log --oneline -3` 核对。若执行者不接受，替代观测点是「把 `UPSTREAM_OWNED` 的模式串改窄（例如只匹配 `^wiki/`）后用例仍应因 `.gitignore` 红」——同样能证明判据活着，且不动历史。

---

## 执行回写（2026-10-01，Task 1–7 全部完成）

提交：`b99a9a8e`(T1) `97560045`(T2) `78798551`(T3) `4ea50458`(T4) `37a296e2`(T5) `e26d99fa`(T6) `b2fbf338`(T7 档案)。
实测：`pytest tools/test_wiki_drift.py -q` **120 passed**（基线 77）；门禁去 WARN 后 14 行与 `.qoder/tmp/gates_post.txt` 逐行相同；受保护路径 0、变更文件 275、上游 `repowiki/` 下 0；14 支变异探针全 killed；未推送 12 条。

下面是计划正文里需要更正的地方，按「计划写了什么 → 实际需要什么」的顺序，M2 起草时逐条对照。

### A. 计划里的硬错误（照抄就跑不起来）

1. `WikiRoot.resolve(wired["wiki"], REPO=None, base=root)` —— `REPO` 不是形参，`TypeError`。删掉该 kwarg。
2. `self.root / ("zh" / "content" if ... else "topics")` —— 括号里的三元在 `/` **之前**求值，`"zh" / "content"` 是 `str.__truediv__` → IDE 布局直接 `TypeError`。写成 `"zh/content"`、`"update/ledger.jsonl"` 字符串形式。
3. `--wiki-root` 只挂在 subparser 上，README 与 docstring 里 `--wiki-root repowiki report` 这种「动词在前」的写法 argparse 不认。补顶层形参，subparser 那份用 `default=argparse.SUPPRESS` 才不会把 None 覆盖成默认值；新增两支位置的用例 `test_wiki_root_flag_is_accepted_on_either_side_of_the_verb`。
4. `body_sha` 用 `page.read_text(...)` —— 本机 `core.autocrlf=true`，翻译后的文本哈希 ≠ 磁盘字节。**播种加完 frontmatter 的当天，426 条既有 ledger 行会集体读成 `ledger-void`**（实测 legacy 根现在 `void 0`）。改成 `open(..., newline="")` 读原文（`read_page_text()`），并留 `test_body_hash_is_byte_faithful_on_a_crlf_checkout`。
5. `def update_frontmatter(page, **fields)` —— `page` 既是形参又是五个键之一，`update_frontmatter(p, page="x")` 报「got multiple values for argument 'page'」。形参改名 `target`。
6. `FM_SAMPLE` 三处数据错：`verified_at` 字面量与 `== "0" * 40` 断言不一致；当样本用的「40 位十六进制」实际 36 位；roundtrip 用例拿 LF 期望比 CRLF 写回。现补 `assert len(good) == 40`。
7. `repo_tree` fixture 把 `content` 设成 `wiki/topics/前端应用`（多套一层），于是 `--page 前端应用/模块说明.md` 解析不到页，测试**因错误的原因**失败。改成 `content = wiki / "topics"`。
8. `test_body_sha_stable_across_frontmatter_write` 的断言写反（`first == sha256(page) != body_sha(page)`）。ledger 在写块之前追加，正确式子是 `first == body_sha(page) != sha256(page)`。
9. `recorded_drivers` 计划写成 `base = frontmatter_baseline(page) or fallback` —— 当 `verified_at` 是被 GC 掉的幻影提交时，它会返回 `([], [])`，即「这页什么都不欠」，正好是档案里记过的自我匹配假绿。实现成「不可用就回落到快照，快照也不可用才返回空」，并补 `test_unreachable_page_baseline_falls_back_instead_of_claiming_no_drivers`。

### B. 契约改动（计划没写，执行中发现必须改）

10. **计划 Task 5 的用例断言 `mark --partial` 写 ledger `cites == "applied-only"`，与 `cmd_mark` 既有的 `cites: "all"` 冲突。** 判据：ledger 的 `cites` 描述「这一行替哪些 cite 背书」，人手的 partial 章确实为全部 cite 背书（`--partial` 的 help 就写着「cite 已新、散文未新」），所以 **ledger 不动**，收回动作落到 **frontmatter 的 `vouch`**。
11. 由此新增闸门：`frontmatter_baseline()` 只在 `vouch == "all"` 时承认 `verified_at`。原因是 frontmatter 优先级高于 ledger —— 若 `reanchor --apply` 或 `mark --partial` 改过字节却留着旧的 `all`，一条盖在 HEAD 上的基线会把自己的漂移窗口量成空集，未收口的页静默掉出队列（414 页事件的新变体）。探针 P3（闸门改成 `if False`）killed 3 支。
12. 收回只写 `vouch: applied-only`，**不清零 `verified_at`**：工具无权判定人读过什么，且保留可 diff 的历史。
13. `stamp_frontmatter()` 加 `rel=` 形参，把 frontmatter 的 `page` 键写成内容树相对路径（= ledger 主键），而不是 `target.name`。一个身份两种拼写是页与台账行从此找不到对方的起点。探针 P7 killed。
14. `stamp_frontmatter` 的 IDE 守卫从「读 `wiki_root` 全局」改成「按磁盘形状 `WikiRoot.resolve(WIKI)` 现算」：全局可能过期，而过期的全局正好能把 450 页 IDE 导出物改掉。计划里那条 `try/finally` 手工还原全局的测试因此简化成 monkeypatch ＋ 一支「故意把全局设成 repo」的反证。
15. `cmd_reanchor` 的写回放在 `stamp_links()` **之前**，让台账里的 `drivers` 在收回已生效的基线上量。诚实记录：该顺序在本 fixture 里**没有判据**（两种顺序得到的 `drivers` 相同），是一处无测试覆盖的取舍，M3 若要依赖 `drivers` 需补用例。

### C. fixture / 探针的可执行性细节

16. `repo_tree` 的源文件若写成 70 行一模一样的 `print(1)`，`reanchor --shifts` 判 `uninformative` → `text == original` → `--apply` 分支根本不进，写回断言会「因什么都没做而通过」。换成语义可辨的 7 行文件，cite `#L3-L4`，插 6 行后必须断言 `[alpha](file://src/mod.py#L9-L10)` 真的出现在页里（这条就是「apply 分支跑过」的正证）。
17. repo 布局的 fixture 没有 `repowiki-metadata.json`，`reanchor` 没有基线就没有可比窗口 ⇒ 那两支 anchor 轴用例必须显式 `--baseline <base>`。
18. past-the-end 一支必须在 **label 里也带范围**（`[mod.py:30-60](file://src/mod.py#L30-L60)`）：`align_labels()` 的 `refused` 只统计 label 已带范围的链接，`[far](...#L30-L60)` 会被 `lm is None` 提前返回，`past_end` 恒 0 ⇒ `anchors` 仍是 `verified`。
19. Task 6 的证伪改用 `git reset --soft <HEAD>` ＋ `git restore --staged/--worktree .gitignore`：同样能证明判据活着（真红点名 `['.gitignore']`），但不动工作树——计划里的 `--hard` 在这台机器上会把当轮未提交的 Task 5 改动一起吞掉。
20. 变异探针若用 `git checkout --` 还原，在**脏工作树**上等于删除本轮未提交的工作 ⇒ 一律改成「先存字节、finally 写回、`== ORIG` 自检」。Windows 下 pytest 的 `FAILED` 行用反斜杠分隔路径，匹配要按分隔符不敏感写。
21. 等价变异一支：把 `return []` 追加在 `raise RuntimeError(...)` **之后**，是不可达代码，全绿但什么都没测（判 SURVIVED 是对的）。改成整块替换 raise 语句才 killed。教训：**探针要改的是可达路径**，加代码不等于改行为。
22. 用例数预测全程偏低：Task 2 86（预测 85）、Task 3 94（91）、Task 4 104（98）、Task 5 116（104）、Task 6 120（107）。计划自己的口径「以实测为准」生效，无漏写用例。
