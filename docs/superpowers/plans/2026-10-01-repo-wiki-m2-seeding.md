# Repo Wiki 重做 M2（494 页播种进 `repowiki/` ＋ `.qoder` 正文归档）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 IDE 导出的 450 页专题正文 + 知识聚合层（30 面 / 9 卡片）播种进仓库根 `repowiki/` 并纳入版本库，每页 frontmatter 落基线；`.qoder/repowiki` 的正文与台账**改名归档而不是删除**；播种前后 `report` 的判定分布必须逐字段相同（只有 `no_frontmatter` 从 450 变 0）。

**Architecture:** 一次性生成器 `seed` 子命令（默认 dry-run，`--apply` 才写盘），它把两棵源树映射成 `PagePlan` 列表，然后逐页写 `frontmatter + 正文字节`。正文**一个字节都不改**——唯一的例外是 `modules/ci-gates/architecture.md`，它转述上游门禁 (b) 的政策时携带了那条政策自己要 grep 的商标字面量，播种时改写这一句并计数点名。路径主键不变（`topics/` 保留中文相对路径）⇒ 426 行 ledger 无需迁移继续命中。基线从「IDE 全局 metadata 一个 commit」下沉为「每页 `verified_at`」，并由 `tree_baseline()` 取逐页众数当树级回落，于是 `report` 不再强制要 `--baseline`。

**Tech Stack:** Python 3.11+ 标准库（`dataclasses` / `re` / `json` / `hashlib` / `pathlib` / `shutil` / `collections.Counter`，**不引入 pyyaml**）、pytest、Git Bash on Windows；CJK 路径要 `git -c core.quotepath=off` 与 `python -X utf8`；`core.autocrlf=true` 是本机事实，新树必须自己钉 LF。

**Spec:** `docs/superpowers/specs/2026-10-01-repo-wiki-rebuild-design.md` —— 本计划实现 §13 的 M2，事实依据是 §2 ①–⑬、§5、§6、§11、§12。`docs/` 被上游 `.gitignore:124` 忽略，spec 与本 plan 只活在本地磁盘，版本库里的锚点是 `项目档案.md` 的「重做设计」一节。

**已完成的前置（M1）：** `WikiRoot` 换根 + frontmatter 编解码 + `body_sha` + 两条 fork 自带守卫 + `repowiki/README.md`，HEAD = `b2fbf338`，工作树干净，`repowiki/` 里只有 `README.md` 一个被跟踪文件。

---

## Global Constraints

- **零上游文件改动**（用户原话：「这个项目是一个开源项目，我只是做二次开发，我希望可以同步开源项目的更新，开发部分不要动需要同步的开源程序原部分」）。**每个任务收尾必须跑一次**：

  ```bash
  git -c core.quotepath=off diff --name-only upstream/main...HEAD \
    | grep -E '^(\.gitignore|tools/ci_grep_gates\.sh|\.github/workflows/test\.yml|wiki/)' || echo NONE
  ```

  期望输出 `NONE`。本次搬迁要动 494+ 个文件，正是最容易手滑的一步（spec §14 倒数第三行）。
- **禁止 Write/Edit 这四个路径**：`.gitignore`、`tools/ci_grep_gates.sh`、`.github/workflows/test.yml`、`wiki/**`（42 个文件，实测 `git ls-tree upstream/main` 存在）。`repowiki/.gitattributes` 是新树自带的，不是根级那份。
- **商标字面量不得进任何被跟踪文件，也不得进探针产物**（门禁 (b) 是按文件系统扫的，`.qoder/tmp/*.json` 印出上下文就会自己把命中数加一条——本轮踩过）。需要它时一律运行时拼装：`"".join(["World", "Quant"])`；证据文件只存计数或 `.txt` 行，不存该串。
- **归档 = 移动，不删除**：`.qoder/repowiki/zh`、`.qoder/repowiki/update` 改名进 `_ide-export-retired-2026-10-01/`；`knowledge/` 留在原处（它贡献了门禁那条长期红噪音，位置不动 ⇒ 「失败集逐行相同」退化成字面空 diff）。
- **五条已定契约不得退化**（spec §6 末段）：`cites` 担保范围语义（`all` 只允许人工 `mark` 写）、`partial` 不推进基线、正文哈希不匹配即 `ledger-void`、编辑器行数口径 `newlines+1`、越界两分类措辞。
- **播种不许推进任何基线**：`seed` 写的 `vouch` 一律 `applied-only`（哪怕某页 ledger 行是完整非 partial 的）。理由见 Task 4 的契约段——这是「M2 只搬不改，水位不可能变」的唯一保证。
- **反空断言纪律**：任何「0 命中 / 全部一致 / 494 页」的结论必须配一条能红的 canary；扫全树的守卫必须证明它扫的不是空集合（spec §12 门禁行、本项目「扫全仓守卫测试的两种假绿」）。
- **不动全局环境**：git 全局配置、Node/Python/pnpm/uv 工具链、`.pnpm-store`、SQLite 一律不许动。测 `core.autocrlf` 只能在 `tmp_path` 的一次性仓库里 `git config`（repo-local）。
- 提交一律 `git commit -s`（DCO），**不推送**。`git add` 只加任务列出的路径，不用 `-A`。
- 新树文件名一律 ASCII（`modules/`、`cards/`）；`topics/` 下的中文相对路径**必须原样保留**，它是 426 行台账的主键。
- 一律 `python -X utf8`，工作目录 = 仓库根 `E:\Vibe-Trading-main\Vibe-Trading-main`。
- **本计划与 spec 都在被忽略的路径里**：`docs/` 被上游 `.gitignore:124` 整目录忽略（那行上面的注释正是 `# Internal docs (plans, specs)`，而 `git ls-tree -r --name-only upstream/main -- docs` 为空 ⇒ 上游在里面没有任何文件）。所以 `git status` 看不见这两个文件，改完也不会显示 diff —— 这不是编辑失败。要入库必须 `git add -f docs/superpowers/**`，那是改跟踪范围的动作，**先取得用户批准**（见 Task 12 Step 5）；`-f` 不需要动 `.gitignore`，零上游约束不受影响。
- 用例总数**预测**只用于发现「漏写/误删用例」；与实测不一致时以实测为准并如实记录，**不许**为对齐预测改断言。基线 **120 passed**（M1 结束实测 33.10 s）；本计划新增 32 条，逐任务累计 122 → 124 → 127 → 131 → 134 → 140 → 145 → 148 → 150 → 151 → **152**。

---

## 测量前提（2026-10-01 本次实测，M2 开工水位）

| 事实 | 值 | 复跑命令 |
|---|---|---|
| `python -m pytest tools/test_wiki_drift.py -q` | **120 passed / 33.10 s** | 见左 |
| 专题正文 | `.qoder/repowiki/zh/content/**` **450 个 .md**、8,109,818 B、16 个中文顶层目录、最大深度 5、最大单页 26,833 B、最长相对路径 114 字符 | `find .qoder/repowiki/zh/content -name '*.md' \| wc -l` |
| 正文行尾 | 450/450 全 LF、BOM 0、**已有 frontmatter 的页 0** | `python -X utf8` 统计 |
| 每页 `file://` 引用 | 去重路径总数 3,943、单页最多 45、中位 8、**无引用页 0** | 同上 |
| 知识聚合层 | `knowledge/zh/**` 39 个 .md ＋ 7 个 yaml；6 个模块目录（1 个 depth-1 父 + 5 个 depth-2 子）× 5 面 = 30；9 个卡片目录各 1 页；**整棵知识树 `file://` 引用数 0** | `find … -name '*.md' \| wc -l` |
| 卡片 frontmatter | 9/9 有块，键集合 `kind/name/category/scope` ＋ 8 个有 `source_files` ＋ 2 个另有 `slug`/`category_hints`；`业务术语表` 无 `source_files`；列表缩进是 4 空格 | `Read` 任一张卡 |
| 台账 | `.qoder/repowiki/update/ledger.jsonl` **426 行 / 350,648 B / 424 个不同 page**，每行 `page` 都能解析到 `zh/content` 下的真实文件；**`cites == "all"` 的行数 = 0** | `wc -l`、`python -X utf8` |
| 旧树报告水位 | `--wiki-root .qoder/repowiki report --json` ⇒ `{pages:450, needs_update:445, clean:5, reconciled:1, ledger_void:0, partial:423, no_frontmatter:450, frontmatter:0, distinct_refs:813, refs_changed:338, refs_broken:8, uncovered:880}`，`metadata_baseline=7fdffa31a0d6ff54d236db3dea6adaf8d1ca6709`，`head=b2fbf3381b5cd74a33697eed94b0e5327fdae49a` | 见左（本次会话刚复跑） |
| 门禁水位 | `bash tools/ci_grep_gates.sh` ⇒ **rc=1，输出 19 行，FAIL 命中恰 1 条**，路径 `./.qoder/repowiki/knowledge/zh/…/CI 流水线与安全门禁脚本/架构设计.md:2`；已留档 `.qoder/tmp/gates_pre_m2.txt` | 见左 |
| 零上游 | 上面的证伪检查 ⇒ `NONE` | 见左 |
| Pine 源码 | `frontend/src/lib/pine*.ts` **13 个文件 / 7,879 行**；测试 `__tests__/pine*.test.ts` **11 个**；夹具目录 `__tests__/__fixtures__/{corpus,corpus-smoke,corpus-v6,corpus-verify}` | `ls` |
| 导出物里的 Pine 页 | **0**（`find .qoder/repowiki/zh/content -iname '*pine*'` 空）⇒ spec §11 要求手写 `modules/pine-engine/` 5 面 | 见左 |

**源树里那个需要改写的句子**（`CI 流水线与安全门禁脚本/架构设计.md` 第 2 行，文件共 4 行）逐码位确认过：分隔符是全角 `；` 与 U+0027 直引号、ASCII 冒号＋空格，即 `b: 禁止字面量 '<literal>'`。Task 6 的 needle 按此精确构造，替换后**行数不变**。

---

## 文件结构（M2 结束后）

| 路径 | 状态 | 职责 |
|---|---|---|
| `repowiki/.gitattributes` | 新建 | `* text=auto eol=lf`：`body_sha` 哈希的是正文字节，autocrlf  checkout 换行 ⇒ 426 行台账一次性全 `ledger-void`。根级 `.gitattributes` 是上游的地盘，深目录那份赢，所以新树自带 |
| `repowiki/topics/**` | 新建 450 页 | 专题正文，中文相对路径 = 台账主键；`report` 的页集**只有这一层**（`CONTENT=<root>/topics`），这条口径要写进 README，别在 M2 顺手扩 |
| `repowiki/modules/<slug>/<face>.md` | 新建 30＋5 | 6 个知识树模块 × 5 面（ASCII 面名）＋ 手写的 `pine-engine` 5 面 = 35 |
| `repowiki/cards/<slug>.md` | 新建 9 | 仓库级卡片，IDE 原有 frontmatter 键必须活着（Task 2） |
| `repowiki/ledger.jsonl` | 新建（逐字节复制） | 426 行担保记录进版本库，从此有 git 保护 |
| `repowiki/drift/{drift.json,DRIFT.md}` | 新建（report 输出） | 播种后第一份报告留档，便于 M3 对水位 |
| `repowiki/README.md` | 修改 | 面名/模块/卡片三张映射表、`--baseline` 口径变化、「modules 与 cards 不进 report 页集」这条决定、归档位置、门禁长期红一条的识别法 |
| `tools/wiki_drift.py` | 修改 | `refs_from_text`、键保留的 `emit_frontmatter`、`metadata_baseline(meta_path=None)`、`tree_baseline()`、`PagePlan`/`SeedTally`/常量表、`plan_topics`/`plan_knowledge`/`apply_page_plan`/`cmd_seed`、`EMPTY_TREE_HINT` 文案 |
| `tools/test_wiki_drift.py` | 修改 | 新增 32 条用例（预测 120 → 152） |
| `.gitignore`、`tools/ci_grep_gates.sh`、`.github/workflows/test.yml`、`wiki/**` | **禁止触碰** | 上游拥有 |
| `.qoder/repowiki/zh`、`.qoder/repowiki/update` | **改名归档**（非删除、未入库） | `.qoder/repowiki/_ide-export-retired-2026-10-01/{zh,update}` |
| `.qoder/repowiki/knowledge` | 原地不动 | 保住门禁失败集逐行相同 |

**播种契约（本计划的核心不变量，Task 4/6 各测一半）：**

1. `seed` 对每页写的 `vouch` 恒为 `applied-only`，`verified_at` 恒为导出快照 `7fdffa31…`。于是 `frontmatter_baseline()`（只认 `vouch == "all"`）对**每一页**返回 `None` ⇒ `effective_base()` 的判定路径与播种前逐字相同 ⇒ 报告分布只能变一处。
2. `topics/` 的相对路径 = ledger 主键，`modules/` 与 `cards/` 不在 `CONTENT` 下，因此不进 `report` 页集，`reworded` 那页也不可能撞上任何台账行。
3. `pages_written=489`（450 + 30 + 9），`checked=489`，`sha_mismatch=0`，`reworded=1`，`no_sources=31`（0 个 topic + 30 个面 + 1 张卡片，实测见 Task 10 Step 2）；树内 `.md` 总数 494 = 489 + 手写的 5 面，其中 `sources` 非空的 463 页。

---

## Task 1: `repowiki/.gitattributes` —— 把新树钉成 LF

**Files:**
- Create: `repowiki/.gitattributes`
- Test: `tools/test_wiki_drift.py`（追加到 M1 的守卫区）

**Interfaces:**
- Consumes: 无（纯 git 层）
- Produces: 「`repowiki/**` 的工作树字节 ≡ 仓库内字节 ≡ LF」这一前提，Task 4/6 的 `body_sha` 对账依赖它

- [ ] **Step 1: 写失败测试（含能红的 canary）**

```python
def test_repowiki_tree_is_pinned_to_lf():
    """core.autocrlf=true on this machine turns every checked-out page body into
    CRLF, and `body_sha` hashes those bytes — one clone would read all 426 ledger
    rows as `ledger-void`. The root .gitattributes belongs to upstream, so the
    tracked tree carries its own (a deeper attributes file wins)."""
    attr = REAL_REPO / "repowiki" / ".gitattributes"
    assert attr.is_file(), "M2 must pin line endings inside its own tree"
    assert "* text=auto eol=lf" in attr.read_text(encoding="utf-8")
    proc = subprocess.run(
        ["git", "-C", str(REAL_REPO), "check-attr", "text", "eol", "--",
         "repowiki/topics/\u524d\u7aef\u5e94\u7528/x.md"],
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
```

`import sys` 加到测试文件顶部（现有 import 里没有）。

- [ ] **Step 2: 跑测试确认失败**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q -k "lf or autocrlf"`
Expected: 2 FAIL（`attr.is_file()` 为假；control 分支可能已先红——那也是信号）

- [ ] **Step 3: 写 `repowiki/.gitattributes`**

```
# Line endings are part of this tree's contract, not a style preference.
# `wiki_drift.body_sha()` hashes the prose bytes and the 426 ledger rows store
# that hash, so a `core.autocrlf=true` checkout that rewrote LF as CRLF would
# read every stamped page as `ledger-void` at once. The repository root's
# .gitattributes is upstream's to add; a deeper attributes file wins, so the
# published tree pins itself.
* text=auto eol=lf
```

- [ ] **Step 4: 跑测试确认通过 + 全量不退**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q`
Expected: **122 passed**（预测 120+2；与实测不一致以实测为准）

- [ ] **Step 5: 零上游检查 + 提交**

```bash
git -c core.quotepath=off diff --name-only upstream/main...HEAD \
  | grep -E '^(\.gitignore|tools/ci_grep_gates\.sh|\.github/workflows/test\.yml|wiki/)' || echo NONE
git add repowiki/.gitattributes tools/test_wiki_drift.py
git commit -s -m "feat(wiki): pin repowiki/ to LF so autocrlf cannot void the ledger"
```

---

## Task 2: frontmatter 编解码保留外来键

**Files:**
- Modify: `tools/wiki_drift.py`（`emit_frontmatter` 441、`update_frontmatter` 456 的 `ordered = {k: merged[k] for k in FM_KEYS}`）
- Test: `tools/test_wiki_drift.py`

**Interfaces:**
- Consumes: `FM_KEYS`、`_fm_scalar`、`split_frontmatter`
- Produces: `emit_frontmatter(fm)` 写入 5 个已知键后，**按键名排序写入其余外来键**；`update_frontmatter` 不再吃键。Task 5 用它保住 9 张卡片的 `kind/name/category/scope/slug/category_hints/source_files`

- [ ] **Step 1: 写失败测试**

```python
def test_emit_frontmatter_keeps_foreign_keys(tmp_path):
    """The 9 IDE cards ship metadata we do not own and must not silently delete:
    `update_frontmatter` used to rebuild the block from FM_KEYS alone, which
    dropped every other key. Body bytes stay untouched — that is what `body_sha`
    and the 426 ledger rows depend on."""
    page = tmp_path / "\u5361\u7247.md"
    page.write_text(
        "---\n"
        "kind: external_dependency\n"
        "category_hints:\n"
        "    - framework_behavior\n"
        "    - auth_protocol\n"
        "source_files:\n"
        "    - frontend/src/lib/pineLang.ts\n"
        "---\n\n### \u89d2\u8272\n\u6b63\u6587\n",
        encoding="utf-8",
    )
    body_before = body_text(page)
    fm = wiki_drift.update_frontmatter(page, verified_at="a" * 40, anchors="open")
    assert fm["kind"] == "external_dependency"
    assert fm["category_hints"] == ["framework_behavior", "auth_protocol"]
    assert fm["source_files"] == ["frontend/src/lib/pineLang.ts"]
    again = wiki_drift.read_frontmatter(page)
    assert again["kind"] == "external_dependency", "round trip must not drop it"
    assert body_text(page) == body_before, "the ledger hashes the body, not the block"
    # Idempotence: a generator whose own output looks like an edit is unreviewable.
    before = page.read_bytes()
    wiki_drift.update_frontmatter(page, verified_at="a" * 40)
    assert page.read_bytes() == before
    text = page.read_text(encoding="utf-8")
    assert text.index("source_files:") > text.index("vouch:"), "5 known keys first, then sorted extras"


def test_foreign_scalar_keys_are_emitted_and_reread(tmp_path):
    page = tmp_path / "x.md"
    wiki_drift.update_frontmatter(page, name="\u4e1a\u52a1\u672f\u8bed\u8868", empty_list=[])
    fm = wiki_drift.read_frontmatter(page)
    assert fm["name"] == "\u4e1a\u52a1\u672f\u8bed\u8868"
    assert fm["empty_list"] == [], "an empty list must survive as `[]`, not as a nested key"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q -k "foreign"`
Expected: 2 FAIL（`KeyError: 'kind'` 或 `fm["kind"]` 缺失）

- [ ] **Step 3: 改 `emit_frontmatter`，键序固定为「5 已知 + 外来按字典序」**

```python
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
```

- [ ] **Step 4: `update_frontmatter` 去掉吃键的那行**

```python
    fm, body = split_frontmatter(read_page_text(target))
    merged = dict(fm or {})
    merged.update({k: v for k, v in fields.items() if v is not None})
    merged.setdefault("page", target.name)
    merged.setdefault("sources", [])
    merged.setdefault("verified_at", "")
    merged.setdefault("anchors", "open")
    merged.setdefault("vouch", "applied-only")
    target.write_text(emit_frontmatter(merged) + body, encoding="utf-8", newline="\n")
    return merged
```

（删掉 `ordered = {k: merged[k] for k in FM_KEYS}` 与 `return ordered`。）

- [ ] **Step 5: 全量跑**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q`
Expected: **124 passed**（122+2，Task 2 写两条用例）。若 M1 既有用例断言了「返回值恰好等于 5 键字典」，那是本次有意改变的契约——改那条断言并在提交信息里写明。

- [ ] **Step 6: 提交**

```bash
git add tools/wiki_drift.py tools/test_wiki_drift.py
git commit -s -m "feat(wiki): frontmatter 编解码保留外来键，播种不吃掉 IDE 卡片元数据"
```

---

## Task 3: 播种常量表 + `metadata_baseline(meta_path=None)`

**Files:**
- Modify: `tools/wiki_drift.py`（`metadata_baseline` 322；新 constants 区）
- Test: `tools/test_wiki_drift.py`

**Interfaces:**
- Consumes: 无
- Produces: `MODULE_SLUGS`（6）、`FACE_NAMES`（5）、`CARD_SLUGS`（9）、`LEGACY_EXPORT`、`LEGACY_KNOWLEDGE`、`EXPORT_ARCHIVE`、`REWORDS`；`metadata_baseline(meta_path: Path | None = None)`
- Task 4/5/8/9 全部消费这张表

- [ ] **Step 1: 写失败测试（纯数据不变量，不依赖磁盘）**

```python
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
    assert len(parents) == 1 and parents[0] in wiki_drift.MODULE_SLUGS


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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q -k "seed_slug or seed_reword or second_root"`
Expected: 3 FAIL（`AttributeError: MODULE_SLUGS`）

- [ ] **Step 3: `metadata_baseline` 加可选参数**

```python
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
    if len(commit) != 40 or any(c not in "0123456789abcdef" for c in commit.lower()):
        return None
    return commit
```

- [ ] **Step 4: 写常量区**（放在 frontmatter 区之前，`sha256` 之后）

```python
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
```

- [ ] **Step 5: 跑测试 + 全量**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q`
Expected: **127 passed**（124+3）；另外 `python -X utf8 -c "import sys; sys.path[:0]=['tools']; import wiki_drift"` 无 SyntaxError（CJK 源文件在 Windows 上必须确认 `# -*- coding` 不需要——PEP 263 默认 UTF-8，本文件已如此）。

- [ ] **Step 6: 提交**

```bash
git add tools/wiki_drift.py tools/test_wiki_drift.py
git commit -s -m "feat(wiki): 播种常量表（6 模块/9 卡片/5 面 + 唯一改写页）与 metadata_baseline 第二根"
```

---

## Task 4: `plan_topics()` —— 450 页正文与 `<cite>` 推导

**Files:**
- Modify: `tools/wiki_drift.py`（`parse_refs` 312 拆出 `refs_from_text`；新增 `strip_reword`、`PagePlan`、`plan_topics`）
- Test: `tools/test_wiki_drift.py`

**Interfaces:**
- Consumes: `read_page_text`、`split_frontmatter`、`REF_RE`、`parse_ref`
- Produces: `refs_from_text(text) -> list[Ref]`（`parse_refs` 变为薄壳）、`PagePlan`（Task 5/6）、`plan_topics(legacy: Path, snapshot: str) -> list[PagePlan]`

- [ ] **Step 1: 写失败测试**

```python
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
    un-stamps every page."""
    wiki = tmp_path / "repowiki"
    wiki.mkdir()
    monkeypatch.setattr(wiki_drift, "WIKI", wiki)
    plans = wiki_drift.plan_topics(_export(tmp_path), "a" * 40)
    assert [p.label for p in plans] == [
        "topics/前端应用/页一.md", "topics/前端应用/页二.md",
    ]
    assert plans[0].fm["page"] == "前端应用/页一.md", "`page` is relative to topics/"
    assert plans[0].origin == "topic"
    assert plans[0].target == wiki / "topics" / "前端应用" / "页一.md"


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
    (wiki / "zh" / "content" / "前端应用" / "页三.md").write_text(
        "---\nkind: x\n---\n\n# 页三\n", encoding="utf-8")
    with pytest.raises(RuntimeError, match="unexpected frontmatter"):
        wiki_drift.plan_topics(wiki, "a" * 40)


def test_parse_refs_and_refs_from_text_are_one_implementation(tmp_path, wired):
    """Two codecs would drift. `sources` is only worth having if it is read the
    same way the report reads cites."""
    page = wired["content"] / "前端应用" / "模块说明.md"
    text = page.read_text(encoding="utf-8")
    assert [r.path for r in wiki_drift.refs_from_text(text)] == [r.path for r in parse_refs(page)]
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q -k "plan_topics or refs_from_text"`
Expected: 4 FAIL（`AttributeError: plan_topics` / `refs_from_text`）

- [ ] **Step 3: `parse_refs` 拆薄壳**

```python
def refs_from_text(text: str) -> list[Ref]:
    refs = []
    for raw in REF_RE.findall(text):
        ref = parse_ref(raw)
        if ref is not None:
            refs.append(ref)
    return refs


def parse_refs(page: Path) -> list[Ref]:
    return refs_from_text(page.read_text(encoding="utf-8", errors="replace"))
```

- [ ] **Step 4: `PagePlan` + `strip_reword` + `plan_topics`**

```python
@dataclass
class PagePlan:
    """One page the seed intends to publish. Built before anything is written, so a
    source-side surprise raises during planning instead of half-way through 489
    writes."""

    target: Path
    label: str          # path relative to WIKI, posix — what the tally prints
    body: bytes         # prose bytes exactly as published, frontmatter excluded
    fm: dict
    origin: str         # topic | module | card
    reworded: bool = False


def strip_reword(rel: str, body: bytes) -> tuple[bytes, bool]:
    """Apply the one published-prose exception, and refuse to apply it quietly."""
    pair = REWORDS.get(rel)
    if pair is None:
        return body, False
    old, new = pair[0].encode("utf-8"), pair[1].encode("utf-8")
    if body.count(old) != 1:
        raise RuntimeError(
            f"reword for {rel}: expected the needle exactly once, found {body.count(old)}"
        )
    replaced = body.replace(old, new)
    if replaced.count(b"\n") != body.count(b"\n"):
        raise RuntimeError(f"reword for {rel} changed the line count")
    return replaced, True


def plan_topics(legacy: Path, snapshot: str) -> list[PagePlan]:
    content = legacy / "zh" / "content"
    if not content.is_dir():
        raise RuntimeError(f"no export content tree at {content}")
    plans: list[PagePlan] = []
    for src in sorted(content.rglob("*.md")):
        rel = str(src.relative_to(content)).replace("\\", "/")
        fm, body = split_frontmatter(read_page_text(src))
        if fm:
            raise RuntimeError(f"unexpected frontmatter in export page {rel}")
        published, reworded = strip_reword(f"topics/{rel}", body.encode("utf-8"))
        plans.append(PagePlan(
            target=WIKI / "topics" / rel,
            label=f"topics/{rel}",
            body=published,
            fm={
                "page": rel,
                "sources": sorted({r.path for r in refs_from_text(body)}),
                "verified_at": snapshot,
                "anchors": "open",
                "vouch": "applied-only",
            },
            origin="topic",
            reworded=reworded,
        ))
    return plans
```

- [ ] **Step 5: 全量跑**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q`
Expected: **131 passed**（127+4；`parse_refs` 改成薄壳不得让任何既有用例变红——它有 6 个使用点）

- [ ] **Step 6: 提交**

```bash
git add tools/wiki_drift.py tools/test_wiki_drift.py
git commit -s -m "feat(wiki): plan_topics — 台账主键即路径，正文与 sources 分别对账"
```

---

## Task 5: `plan_knowledge()` —— 30 面 + 9 卡片，双向完整性

**Files:**
- Modify: `tools/wiki_drift.py`（新增 `plan_knowledge`）
- Test: `tools/test_wiki_drift.py`

**Interfaces:**
- Consumes: `MODULE_SLUGS`、`FACE_NAMES`、`CARD_SLUGS`、`read_page_text`、`split_frontmatter`、`strip_reword`
- Produces: `plan_knowledge(kb: Path, snapshot: str, modules=None, cards=None) -> list[PagePlan]`；参数化是为了让测试喂一张 2 模块 / 1 卡片的小表——**不许**为了测试去碰真实导出树

- [ ] **Step 1: 写失败测试**

```python
def _kb(tmp_path: Path, modules: list[str], cards: list[str]) -> Path:
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


def test_plan_knowledge_maps_every_face_and_keeps_card_keys(tmp_path):
    kb = _kb(tmp_path, ["父", "父/子"], ["业务术语表"])
    plans = wiki_drift.plan_knowledge(
        kb, "a" * 40, modules={"父": "repo-root", "父/子": "ci-gates"},
        cards={"业务术语表": "glossary"})
    assert len(plans) == 11, "2 modules x 5 faces + 1 card"
    by_label = {p.label: p for p in plans}
    assert by_label["modules/repo-root/overview.md"].fm["sources"] == []
    card = by_label["cards/glossary.md"]
    assert card.fm["kind"] == "card" and card.fm["name"] == "业务术语表"
    assert card.fm["sources"] == ["src/mod.py"], "source_files feeds `sources`, then goes"
    assert card.fm["source_files"] == ["src/mod.py"], "...and the IDE key still ships"
    assert card.origin == "card"


def test_plan_knowledge_demands_both_directions_of_the_map(tmp_path):
    """The migration's reconciliation rule: every source dir claimed exactly once,
    no exceptions accepted. An unmapped dir means a page nobody seeded; a mapped dir
    missing on disk means a slug pointing at nothing."""
    kb = _kb(tmp_path, ["父"], [])
    with pytest.raises(RuntimeError, match="unmapped module dir"):
        wiki_drift.plan_knowledge(kb, "a" * 40, modules={}, cards={})
    with pytest.raises(RuntimeError, match="module dir missing"):
        wiki_drift.plan_knowledge(kb, "a" * 40, modules={"父": "repo-root", "缺": "gone"}, cards={})


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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q -k plan_knowledge`
Expected: 3 FAIL

- [ ] **Step 3: 实现**

```python
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
    """
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
        if not mod.is_dir():
            raise RuntimeError(f"module dir missing: {dir_rel}")
        for face_src, face_dst in sorted(FACE_NAMES.items()):
            src = mod / face_src
            if not src.is_file():
                raise RuntimeError(f"module face missing: {dir_rel}/{face_src}")
            fm, body = split_frontmatter(read_page_text(src))
            if fm:
                raise RuntimeError(f"unexpected frontmatter in {dir_rel}/{face_src}")
            rel = f"modules/{slug}/{face_dst}"
            published, reworded = strip_reword(rel, body.encode("utf-8"))
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
        fm, body = split_frontmatter(read_page_text(src))
        extra = dict(fm or {})
        files = extra.pop("source_files", [])
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
    return plans
```

- [ ] **Step 4: 全量跑**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q`
Expected: **134 passed**（131+3）

- [ ] **Step 5: 提交**

```bash
git add tools/wiki_drift.py tools/test_wiki_drift.py
git commit -s -m "feat(wiki): plan_knowledge — 面名 ASCII 映射、卡片键保全、缺项即报错"
```

---

## Task 6: `cmd_seed` —— 写盘、逐文件 sha 对账、台账逐字节复制、子命令接线

**Files:**
- Modify: `tools/wiki_drift.py`（`SeedTally`、`apply_page_plan`、`copy_ledger`、`cmd_seed`、`main()` 接线）
- Test: `tools/test_wiki_drift.py`

**Interfaces:**
- Consumes: `plan_topics`、`plan_knowledge`、`emit_frontmatter`、`metadata_baseline(meta_path)`、`wiki_root.layout`
- Produces: `python -X utf8 tools/wiki_drift.py seed [--from R] [--snapshot SHA] [--apply]`，输出行 `pages_written=… pages_skipped=… sha_mismatch=… checked=… reworded=… no_sources=… origins={…}`（spec §6 要求的三个字段名逐字保留），`--dry-run` 是默认（不写一个字节）

- [ ] **Step 1: 写失败测试**

先把 `import shutil` 加进 `tools/test_wiki_drift.py` 的第 19-22 行导入区（该文件目前只 `import json/re/subprocess`，`shutil` 是本轮新依赖）。

```python
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
    monkeypatch.setattr(wiki_drift, "REPO", tmp_path)
    monkeypatch.setattr(wiki_drift, "MODULE_SLUGS", {"父": "repo-root"})
    monkeypatch.setattr(wiki_drift, "CARD_SLUGS", {"业务术语表": "glossary"})
    kb = _kb(tmp_path, ["父"], ["业务术语表"])
    dst_kb = export / wiki_drift.LEGACY_KNOWLEDGE
    dst_kb.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(kb, dst_kb)
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
    assert "dry-run: nothing written" in capsys.readouterr().out
    assert main([*argv, "--apply"]) == 0
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
    src_text = (export / "zh" / "content" / "前端应用" / "页一.md").read_text(encoding="utf-8")
    assert page.read_text(encoding="utf-8").endswith(src_text), "frontmatter only, prose verbatim"
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
    assert main(["--wiki-root", str(export), "seed", "--apply"]) == 2
    assert "refusing to seed into an ide-layout root" in capsys.readouterr().err


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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q -k seed_`
Expected: 6 FAIL（`unrecognized arguments: seed`）

- [ ] **Step 3: 实现 `SeedTally` / `apply_page_plan` / `copy_ledger` / `cmd_seed`**

```python
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

    `newline="\n"` is not enough — the payload is assembled as bytes, so no layer
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
    if wiki_root.layout != "repo":
        print(
            f"refusing to seed into an ide-layout root ({legacy}): the target tree is "
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
```

- [ ] **Step 4: `main()` 接线**（`reanchor` 之后、那个 `for parser_ in …` 循环之前）

```python
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

    for parser_ in (rep, mark, reanchor, seed):
        ...  # 现有的 --wiki-root 追加循环，只需把元组补上 seed
```

- [ ] **Step 5: 全量跑**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q`
Expected: **140 passed**（134+6）；`python -X utf8 tools/wiki_drift.py seed` 在真树上应打印 `pages_written=489 … reworded=1`（**不加 `--apply`**，本步只验证 dry-run 数字，不写盘）

- [ ] **Step 6: 提交**

```bash
git add tools/wiki_drift.py tools/test_wiki_drift.py
git commit -s -m "feat(wiki): seed 子命令 — 默认 dry-run、逐文件正文对账、台账逐字节复制"
```

---

## Task 7: `tree_baseline()` —— 把「必须传 `--baseline`」这条枷锁拿掉

**Files:**
- Modify: `tools/wiki_drift.py`（新函数；`build` 1476、`cmd_reanchor` 1320、`cmd_mark` 1591 三处 `args.baseline or metadata_baseline()`）
- Test: `tools/test_wiki_drift.py`

**Interfaces:**
- Consumes: `read_frontmatter`、`HEX40_RE`、`CONTENT`
- Produces: `tree_baseline() -> str | None`；`report`/`mark`/`reanchor` 无 `--baseline` 时不再 exit 2

- [ ] **Step 1: 写失败测试**

```python
def test_tree_baseline_is_the_modal_page_verified_at(repo_wired):
    """The fallback the tree agrees on. Ignoring `vouch` here is deliberate: that
    gate decides whether a page's own stamp may *outrank* its ledger row, while this
    value is only the tree-wide fallback for pages with no per-page claim — which,
    right after seeding, is every page, and their `verified_at` is this same commit."""
    pages = sorted((repo_wired["wiki"] / "topics").rglob("*.md"))
    wiki_drift.update_frontmatter(pages[0], verified_at="a" * 40, vouch="applied-only")
    wiki_drift.update_frontmatter(pages[1], verified_at="a" * 40, vouch="applied-only")
    wiki_drift.update_frontmatter(pages[2], verified_at="b" * 40, vouch="all")
    assert wiki_drift.tree_baseline() == "a" * 40


def test_tree_baseline_is_deterministic_under_a_tie(repo_wired):
    """A tie must not fall out of filesystem walk order (spec §5.3's determinism
    requirement applies to every derived value, not just INDEX.md)."""
    pages = sorted((repo_wired["wiki"] / "topics").rglob("*.md"))
    for page, rev in zip(pages, ["c" * 40, "a" * 40, "b" * 40]):
        wiki_drift.update_frontmatter(page, verified_at=rev)
    first = wiki_drift.tree_baseline()
    pages.reverse()
    assert first == "a" * 40 == wiki_drift.tree_baseline()


def test_tree_baseline_ignores_non_hex_and_missing_blocks(repo_wired):
    pages = sorted((repo_wired["wiki"] / "topics").rglob("*.md"))
    wiki_drift.update_frontmatter(pages[0], verified_at="Q0DeR-MaG1C")
    assert wiki_drift.tree_baseline() is None, "no IDE metadata in the repo layout"


def test_report_without_a_baseline_works_after_seeding(repo_wired):
    """M2's whole point: the baseline travels with the pages, so `report` needs no
    40-hex incantation once the tree is seeded."""
    pages = sorted((repo_wired["wiki"] / "topics").rglob("*.md"))
    for page in pages:
        wiki_drift.update_frontmatter(page, verified_at=repo_wired["base"], vouch="applied-only")
    assert main(["--wiki-root", str(repo_wired["wiki"]), "report", "--json"]) == 0


def test_ide_layout_still_falls_back_to_metadata(wired):
    """The 77+120 existing cases run against the IDE fixture, whose pages carry no
    frontmatter. Falling back keeps `test_unreachable_metadata_baseline_*` honest
    instead of silently repointing it."""
    assert wiki_drift.tree_baseline() == wired["base"]
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q -k tree_baseline`
Expected: 5 FAIL（`AttributeError: tree_baseline`）

- [ ] **Step 3: 实现**（`metadata_baseline` 之后）

```python
def tree_baseline() -> str | None:
    """The commit the current tree agrees it was generated at.

    Modal page `verified_at` over `CONTENT`, ties broken by the revision itself so
    the answer cannot depend on walk order; falls back to the IDE metadata while an
    IDE-layout root is what is being read. `frontmatter_baseline()` gates on `vouch`
    because a page's stamp must not outrank its own ledger row; this value is the
    opposite case — the tree-wide fallback for pages that have no per-page claim.
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
```

顶部 import 增加 `from collections import Counter`。

**这是 spec §6「删除 `metadata_baseline()` 调用路径」的一次有意偏离**，不是漏改：M1 留下的 120 条用例大多跑在 IDE 布局的 fixture 上（那些页**没有** frontmatter，已逐条确认），去掉兜底会把它们 collectively 打成红，而其中 `test_unreachable_metadata_baseline_asks_for_an_override` 恰恰是「读不到基线就必须报错、不许静默」那条纪律的守卫 —— 把它连根拔掉等于顺手削掉一条能红的闸。偏离的代价被 `tree_baseline()` 的次序锁死：页内 `verified_at` 的众数**总是**先赢，只有树里一个可用 stamp 都没有时才轮到 IDE 元数据。播种后的 `repowiki/` 走前者，`--wiki-root .qoder/...` 走后者，两条路都可观测。Task 9 的 README 与 Task 12 的档案都必须把这条偏离写进「与 spec 的不同」，不许留成隐性差异。

- [ ] **Step 4: 三处调用点替换 + 打印口径**

`build`(1476)、`cmd_reanchor`(1320)、`cmd_mark`(1591) 的
`fallback = args.baseline or metadata_baseline()` → `fallback = args.baseline or tree_baseline()`。

`cmd_report` 的 `print(f"baseline  {payload['metadata_baseline']}  (wiki snapshot, read-only)")` →

```python
    provenance = "--baseline" if args.baseline else "tree"
    print(f"baseline  {payload['metadata_baseline']}  ({provenance}: modal page verified_at)")
```

`payload["metadata_baseline"]` 这个键名**保留**（3 条既有用例读它，且 `render_markdown` 用它），语义改为「本次判定的树级回落」。

- [ ] **Step 5: 全量跑**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q`
Expected: **145 passed**（140+5）。特别确认 `test_unreachable_metadata_baseline_asks_for_an_override`（371）与两条空树用例仍绿——若 `repo_wired` 里某用例因不再需要 `--baseline` 而走了不同分支，按新事实改断言并写明理由，不许放宽。

- [ ] **Step 6: 提交**

```bash
git add tools/wiki_drift.py tools/test_wiki_drift.py
git commit -s -m "feat(wiki): 树级回落基线取自逐页 verified_at 众数，report 不再强制 --baseline"
```

---

## Task 8: 手写 `modules/pine-engine/` 5 面

**Files:**
- Create: `repowiki/modules/pine-engine/{overview,architecture,tech-stack,conventions,commands}.md`
- Test: `tools/test_wiki_drift.py`

**Interfaces:**
- Consumes: 真实源码路径（下表）；`emit_frontmatter`（手写页也走同一编解码，键序一致）
- Produces: 树内第 7 个模块目录；spec §11 那句「知识树里 pine 一页都没有」的补位

**内容来源与硬约束**：正文只能写 `frontend/src/lib/pine*.ts` 与 `__tests__/pine*.test.ts` 里读得到的事实，加上项目记忆里已核过的决策（逐 bar 解释器而非翻译器、生产 CSP `script-src 'self'` 禁 eval、后端没有 Pine 解释器、`produced` 口径不放宽、第三方语料不入库）。**每页 `anchors: open`、`vouch: applied-only`** ——spec §11 明确禁止给未经逐条核实的新页盖 `verified`。`verified_at` 用**本页写就时的 HEAD**（不是导出快照 `7fdffa31…`：这几页从未在那一刻存在过）。

13 个源文件（8,109 行中的 7,879 行）：`pineLang.ts`（词法 + 递归下降解析）、`pineTypes.ts`（V 值模型/na/输出类型）、`pineRuntime.ts`（逐 bar 执行器 + 输出收集）、`pineScript.ts`（对外 `compilePine` + dialect 嗅探）、`pineTa.ts`/`pineMath.ts`（内置表）、`pineArray.ts`/`pineMap.ts`/`pineMatrix.ts`（复合值命名空间）、`pineOrders.ts`（`strategy.*` 撮合）、`pineDrawings.ts`（plot/line/label/box）、`pineResample.ts`（`request.security` 多周期）、`pineSignal.ts`（与后端 SignalEngine 的列对齐）。11 个测试：`pineCorpusReport.test.ts`（含 `makeBars` 与 `_pass-rate` 口径）、`pineCorpusSmoke.test.ts`、`pineRealWorld.test.ts`、`pineBuiltins.test.ts`、`pineContinuation.test.ts`、`pineScript.test.ts`、`pineSeries.test.ts`、`pineSignal.test.ts`、`pineResample.test.ts`、`pineIndicatorWire.test.ts`、`pineMtfStrategy.test.ts`。

- [ ] **Step 1: 写失败测试**

```python
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
```

（`test_seed_does_not_touch_hand_authored_pages` 复用 Task 6 的 `_seedable`，`MODULE_SLUGS`/`CARD_SLUGS`/`REPO` 已在其中 monkeypatch 好；这里仍显式传 `modules=`/`cards=`，让形状断言不依赖被改过的全局。`HEX40_RE` 走 `wiki_drift.HEX40_RE`，测试文件的 `from wiki_drift import (...)` 名单不改。）

- [ ] **Step 2: 跑测试确认失败**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q -k pine_engine`
Expected: 3 FAIL（目录不存在）

- [ ] **Step 3: 写 5 页**

每页形状固定为「`# 标题` + 3–6 个小节」，正文全部可回溯到上表文件。**Step 3 只交正文、不写 frontmatter**（Step 4 用 `emit_frontmatter` 统一产出，键序与引号风格才不会分叉）。示例（`overview.md` 全文，其余 4 面同法写就，禁止 TBD/TODO）：

```markdown
# Pine 兼容引擎总览

前端自研的 TradingView Pine v5/v6 兼容层：导入 `.pine` 源码，按 Pine 的逐根 K 线语义求值，把线、标记、交易与策略报告画进 KLineChart v10，并把策略报告与后端回测口径分开。

## 1. 它是什么、不是什么

- **是**独立于自有 DSL 的第二套执行内核，两者共存，`pineScript.ts` 的 dialect 嗅探（检测 `indicator()`/`strategy()` 头部）自动分派。
- **不是**翻译器。把 Pine 翻成自有 DSL 的方案已被否决：`var` 的 persist 语义、历史缓冲、命名输入绑定在翻译中易丢。
- **不是**后端能力。`artifacts/strategy.pine` 是 LLM 生成的**文本**（`agent/src/skills/pine-script/SKILL.md` 写明方向是 Python→Pine 供展示/导出），后端内核只吃 Python `signal_engine.py`。

## 2. 为什么必须是解释器

生产 CSP 是 `script-src 'self'`，`eval` 与 `new Function` 被禁 ⇒ 动态求值这条路从一开始就不存在。逐 bar 解释器同时满足语义等价与 CSP，因此是唯一被接受的执行模型。

## 3. 模块清单（13 个文件，7,879 行）

| 层 | 文件 | 职责 |
|---|---|---|
| 词法/语法 | `pineLang.ts` | v5/v6 词法器 + 递归下降解析器（缩进块、命名参数、`x[n]` 历史下标、tuple 解构） |
| 类型与值 | `pineTypes.ts` | 共享 `V` 表示、na 工具、Arg 访问器、`PineLine`/`PineMarker`/`PineTrade`/`PineReport` |
| 求值 | `pineRuntime.ts` | 逐 bar 执行器、变量历史缓冲、persist、输出收集 |
| 对外 API | `pineScript.ts` | `compilePine(code, params?) → { run(bars) }`、dialect 嗅探、错误转 UI 提示 |
| 内置 | `pineTa.ts`、`pineMath.ts` | `ta.*` 与数学函数 |
| 复合值 | `pineArray.ts`、`pineMap.ts`、`pineMatrix.ts` | `array.*`/`map.*`/`matrix.*` 命名空间 |
| 交易与绘图 | `pineOrders.ts`、`pineDrawings.ts` | `strategy.*` 撮合模拟、plot/line/label/box |
| 多周期 | `pineResample.ts` | `request.security` |
| 桥接 | `pineSignal.ts` | 信号列与后端 SignalEngine 的列对齐 |

细节见 `modules/pine-engine/` 其余四面，专题正文见 `repowiki/topics/前端应用/`。
```

其余四面按下面的骨架写，事实全部来自上表文件与既有记忆条目：

- `architecture.md`：五层分工（词法/解析 → 求值 → 内置 → 绘图/撮合 → 对外 API）、历史缓冲与 `x[i]` 索引读、`var` persist 与普通变量该 bar 为 na、命名输入绑到 `Record<inputId, value>`、前后端边界（Pine 只在浏览器；要走后端市场引擎需导出信号列）、集成点（`ProChart.tsx` 的「ƒ Pine」入口、买卖标记用 `type:'circle'`、信号线用 `type:'text'` ▲▼）。
- `tech-stack.md`：TypeScript 纯前端、无第三方 Pine 依赖、KLineChart v10 figure 能力（`line`/`bar`/`circle`/`text`）、逐 bar 在 1000+ bars 下流畅、`.pine` 导入导出四种载体（单文件含 header 注释、JSON 集合带元数据、URL hash 的 gzip base64url、粘贴导入自动识别 dialect）、生产 CSP 硬约束。
- `conventions.md`：新语言能力按层落位（词法 + 路由 + 内置表 + 必要时 `ENUM_NS` 四处同改），不许往通用内置表里塞本该在 `pineTa.ts` 的实现；`sources` 类改动必须配精确钉值单测；「真缺口 vs 脚本自坏」的判据（是否已发布脚本 + 权威签名）；被否决项清单（`^^` 不实现、LLM Pine→Python 路径、翻译器方案、装饰性基元的三条件重启门槛）。
- `commands.md`：`cd frontend && npx.cmd vitest run src/lib/__tests__`（本机 PowerShell 5.1 需 `npx.cmd`）；三闸对账命令（everget 基线 + v6 + 全量 vitest）；`_pass-rate.json` 的 `topReasons` 读法；`produced` 口径位置（`pineCorpusReport.test.ts` 约 98–101 行，只数 finite `lines`/`markers`/`hlines`）；语料 env 开关（`PINE_CORPUS_DIR`/`PINE_CORPUS_MANIFEST`、`CORPUS_MANIFEST`/`CORPUS_OUT`，默认必须仍是老源）；第三方语料不入库。

- [ ] **Step 4: 用工具自己产 frontmatter（不手敲 YAML，保证键序与编解码一致）**

`sources` 逐面给死（下表全部 25 个路径都已在磁盘上确认存在：13 个 `frontend/src/lib/pine*.ts`、11 个 `frontend/src/lib/__tests__/pine*.test.ts`、`frontend/src/pages/ProChart.tsx`、`agent/src/skills/pine-script/SKILL.md`）。**不要现场另拟列表** —— 断言里 `>= 2` 与 `(REAL_REPO / src).is_file()` 两道闸是靠这张表才有效的。

```bash
python -X utf8 - <<'PY'
import sys, os; sys.path.insert(0, "tools")
import wiki_drift as w
LIB = "frontend/src/lib/"
T = "frontend/src/lib/__tests__/"
SOURCES = {
    "overview": [LIB + "pineScript.ts", LIB + "pineLang.ts", LIB + "pineRuntime.ts",
                 LIB + "pineTypes.ts", "agent/src/skills/pine-script/SKILL.md"],
    "architecture": [LIB + "pineLang.ts", LIB + "pineRuntime.ts", LIB + "pineScript.ts",
                     LIB + "pineOrders.ts", LIB + "pineResample.ts", LIB + "pineSignal.ts",
                     "frontend/src/pages/ProChart.tsx"],
    "tech-stack": [LIB + "pineTypes.ts", LIB + "pineArray.ts", LIB + "pineMap.ts",
                   LIB + "pineMatrix.ts", LIB + "pineDrawings.ts",
                   "frontend/src/pages/ProChart.tsx"],
    "conventions": [LIB + "pineTa.ts", LIB + "pineMath.ts", LIB + "pineRuntime.ts",
                    LIB + "pineLang.ts", T + "pineBuiltins.test.ts", T + "pineRealWorld.test.ts"],
    "commands": [T + "pineCorpusReport.test.ts", T + "pineCorpusSmoke.test.ts",
                 T + "pineRealWorld.test.ts", T + "pineBuiltins.test.ts",
                 T + "pineContinuation.test.ts"],
}
HEAD = w.git("rev-parse", "HEAD").strip()
for face, srcs in SOURCES.items():
    for s in srcs:
        assert os.path.isfile(s), f"sources cites a file that is not on disk: {s}"
    p = w.REPO / "repowiki" / "modules" / "pine-engine" / f"{face}.md"
    text = p.read_text(encoding="utf-8")
    fm, body = w.split_frontmatter(text)
    assert fm is None, f"{face}.md already carries frontmatter; Step 3 must write prose only"
    fm = {"page": f"modules/pine-engine/{face}.md", "sources": srcs,
          "verified_at": HEAD, "anchors": "open", "vouch": "applied-only"}
    p.write_bytes(w.emit_frontmatter(fm).encode("utf-8") + body.encode("utf-8"))
    print(face, len(srcs), HEAD[:8])
PY
```

`ENUM_NS` 的实际位置是 `pineRuntime.ts`（已 grep 确认，不在 `pineDrawings.ts`），`conventions.md` 正文里提到它时按这个路径写。Step 3 交出去的 5 个文件**只有正文**，frontmatter 一律由本步产出 —— 手敲 YAML 会让键序和引号风格与 `emit_frontmatter` 分叉，而 M3 的门禁要按字节比对。

- [ ] **Step 5: 跑测试**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q -k pine_engine` → 3 PASS
Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q` → **148 passed**（145+3）

- [ ] **Step 6: 提交**

```bash
git add repowiki/modules/pine-engine tools/test_wiki_drift.py
git commit -s -m "docs(wiki): 手写 pine-engine 五面 —— 知识树里 Pine 一页都没有"
```

---

## Task 9: `repowiki/README.md` 映射表与契约

**Files:**
- Modify: `repowiki/README.md`
- Test: `tools/test_wiki_drift.py`

**Interfaces:**
- Consumes: `MODULE_SLUGS`、`FACE_NAMES`、`CARD_SLUGS`、`EXPORT_ARCHIVE`
- Produces: spec §11 要求的「中文面名 → ASCII 文件名写进 README」，以及 Task 12 形状审计要引用的归档路径

- [ ] **Step 1: 写失败测试**

```python
def test_readme_maps_every_seeded_name():
    """The tables are the only place a human learns that `modules/ci-gates/` used to
    be `…/CI 流水线与安全门禁脚本/架构设计.md`. Guarded against drift both ways: a
    slug in the table but not in the code, and a slug in the code but not the table."""
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q -k readme`
Expected: 2 FAIL

- [ ] **Step 3: 在现有 README 之后追加**（保留 M1 写的三段：与 `wiki/` 的区别、M5 之前别当事实源、门禁长期红一条）

追加内容必须包含：

1. **面名映射表**（5 行，两列：导出里的中文名 → 树里的 ASCII 名）。
2. **模块映射表**（7 行：`slug` → 导出目录名 → 面数）。6 行来自 `MODULE_SLUGS`，第 7 行 `pine-engine` 标「手写，无导出来源」。
3. **卡片映射表**（9 行：`slug` → 导出目录名）。
4. **专题**一句话说明：`topics/` 保留导出里的中文相对路径**因为它是 `ledger.jsonl` 的主键**，改名等于清空全部担保。
5. **命令口径**：`report` 现在无需 `--baseline`（回落取逐页 `verified_at` 众数）；仍想指定就写 `--baseline <40-hex>`；播种是一次性动作，`seed` 默认 dry-run。
6. **页集口径**（本计划冻结的决定，M3 若要扩必须显式改判）：`report` 只审 `topics/`；`modules/` 与 `cards/` 有 frontmatter 但不在 `CONTENT` 下，因此不参与水位统计——这正是「450 页」这个数字在播种后仍是 450 的原因。
7. **归档位置**：`.qoder/repowiki/_ide-export-retired-2026-10-01/{zh,update}`，`.qoder/` 在 `.git/info/exclude` 里（git 看不见它，`git status` 干净不代表已备份）。
8. **`seed` 的唯一改写页**：`modules/ci-gates/architecture.md`，改的是什么、为什么（发布物不得携带门禁自己要 grep 的那个字面量；指针保留）、以及「这条政策由上游脚本自持，本树不复制名单」。
9. **与 spec 的偏离一条，必须写明而不是留成隐性差异**：spec §6 要求删掉 `metadata_baseline()` 的调用路径，本实现把它保留为 `tree_baseline()` 的**末位兜底**（只在树内一个合法 `verified_at` 都没有时才生效，即 `--wiki-root` 指向 IDE 导出时的旧行为）。理由与次序都写在 `tree_baseline()` 的 docstring 里。

- [ ] **Step 4: 跑测试**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q` → **150 passed**（148+2）

- [ ] **Step 5: 提交**

```bash
git add repowiki/README.md tools/test_wiki_drift.py
git commit -s -m "docs(wiki): README 补齐三张映射表与播种/页集/归档口径"
```

---

## Task 10: 真跑播种 —— 494 页进 git ＋ 两份报告逐字段对账

**Files:**
- Create: `repowiki/topics/**`（450）、`repowiki/modules/**`（30 面）、`repowiki/cards/**`（9）、`repowiki/ledger.jsonl`、`repowiki/drift/{drift.json,DRIFT.md}`
- Test: `tools/test_wiki_drift.py`（反空断言一条）

**Interfaces:**
- Consumes: Task 1–9 全部
- Produces: M2 的主体交付物；Task 11 的比对基准

- [ ] **Step 1: 先写反空断言（播种前必然红）**

```python
def test_seeded_tree_is_not_an_empty_set():
    """'All 494 pages parsed' over a directory holding 1 README is the exact false
    green this repo has now documented three times."""
    tree = REAL_REPO / "repowiki"
    # README.md is hand-written prose; INDEX.md is M3's generated root index.
    # Neither is a wiki page, and counting them would make the 494 off by two.
    pages = sorted(p for p in tree.rglob("*.md") if p.name not in {"README.md", "INDEX.md"})
    assert len(pages) == 494, len(pages)          # 450 topics + 35 module faces + 9 cards
    with_sources = [p for p in pages if (wiki_drift.read_frontmatter(p) or {}).get("sources")]
    assert len(with_sources) == 463, len(with_sources)   # 494 − 31 measured no_sources
    missing = [p for p in pages if wiki_drift.read_frontmatter(p) is None]
    assert missing == [], missing[:3]
    blocks = [wiki_drift.split_frontmatter(wiki_drift.read_page_text(p))[0] for p in pages]
    assert all(fm and fm["verified_at"] and fm["page"] for fm in blocks), "every page carries a baseline"
    assert sum(1 for fm in blocks if fm["vouch"] == "all") == 0, "seeding is not a re-reading"
```

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q -k not_an_empty_set` → FAIL（`1 != 494`）

- [ ] **Step 2: dry-run 复核数字（不写盘）**

Run: `python -X utf8 tools/wiki_drift.py seed`
Expected 关键行：

```
pages_written=489 pages_skipped=0 sha_mismatch=0 checked=489 reworded=1 no_sources=31 …
ledger_rows=426 ledger_sha=<12 hex> snapshot=7fdffa31a0d6ff54d236db3dea6adaf8d1ca6709 target=…\repowiki
reworded: modules/ci-gates/architecture.md
```

`no_sources=31` 是**测出来的**，不是推的（探针 `.qoder/tmp/m2_no_sources.py`，2026-10-01 跑）：450 个 topic 页里 0 个没有 `file://` 引用；6 个模块目录 × 5 面 = 30 面全为空（知识树里 `file://` 引用计数为 0）；9 张卡片里只有 `业务术语表`（→ `cards/glossary.md`）没有 `source_files` ⇒ 0 + 30 + 1 = 31。同一探针另测 `ledger_rows=426`、台账键全部能在 `topics/` 里解析（`ledger_keys_not_in_topics 0`）、26 页尚无台账行。**以实测打印为准**：若与 31 不符，先查是不是某张卡片的路径解析出了问题，不许改断言凑数。若 `489/1/0` 三项中任一不符，**停在这里**，不要 `--apply`。

- [ ] **Step 3: 实写**

Run: `python -X utf8 tools/wiki_drift.py seed --apply` → `pages_written=489 sha_mismatch=0`
Run: `python -X utf8 tools/wiki_drift.py seed --apply` → `pages_written=0 pages_skipped=489`（幂等，spec §12 幂等行）

- [ ] **Step 4: 两份报告逐字段对账（M2 的完工判据）**

```bash
python -X utf8 tools/wiki_drift.py --wiki-root .qoder/repowiki report --json > .qoder/tmp/rep_legacy.json
python -X utf8 tools/wiki_drift.py report --json > .qoder/tmp/rep_repo.json
python -X utf8 - <<'PY'
import json
legacy = json.load(open(".qoder/tmp/rep_legacy.json", encoding="utf-8"))
repo = json.load(open(".qoder/tmp/rep_repo.json", encoding="utf-8"))
a, b = legacy["summary"], repo["summary"]
print("only-expected diff:", {k: (a[k], b[k]) for k in a if a[k] != b[k]})
assert len(legacy["pages"]) == len(repo["pages"]) == 450, "zip below is only valid page-for-page"
print("per-page base diff:", sum(1 for x, y in zip(legacy["pages"], repo["pages"])
                                 if x["base"] != y["base"]))
PY
```

Expected：`only-expected diff: {'no_frontmatter': (450, 0)}` ——**只此一处**（`frontmatter` 两边同为 0，`vouch` 全为 `applied-only`，所以它进不了 diff；`clean` 两边同为 5）。其余 11 个键逐字不变，2026-10-01 实测的播种前快照存在 `.qoder/tmp/rep_legacy_pre_m2.json`：`pages=450 needs_update=445 clean=5 reconciled=1 ledger_void=0 partial=423 no_frontmatter=450 frontmatter=0 distinct_refs=813 refs_changed=338 refs_broken=8 uncovered=880`；per-page `base` 差异 **0**。任何别的变化 = 搬迁或基线判定错了，回到 Task 4/7 查因，**不许**放宽对账口径。

（`zip(legacy["pages"], repo["pages"])` 只在两边页序一致时成立；页集都由 `collect_pages` 的 `sorted()` 产出，故可比。若两边长度不同，`zip` 会静默截短 —— 先断言 `len==len==450` 再比。）

- [ ] **Step 5: 形状审计（独立口径复核，别只信工具自检）**

```bash
python -X utf8 - <<'PY'
import hashlib, pathlib, sys
sys.path.insert(0, "tools")
import wiki_drift as w
src = pathlib.Path(".qoder/repowiki/zh/content")
bad = []
for s in sorted(src.rglob("*.md")):
    rel = str(s.relative_to(src)).replace("\\", "/")
    d = pathlib.Path("repowiki") / "topics" / rel
    if not d.is_file():
        bad.append(("missing", rel)); continue
    want = s.read_bytes()
    got = d.read_bytes()
    if not got.endswith(want):
        # only the one reworded page may differ, and it must differ on one line only
        body = w.body_text(d)
        if len(body.splitlines()) != len(want.decode("utf-8").splitlines()):
            bad.append(("line-count", rel))
        else:
            bad.append(("body", rel))
print("diverging pages:", [b[0] for b in bad][:5], "count", len(bad))
print("topics under repowiki/topics:", len(list((pathlib.Path('repowiki/topics')).rglob('*.md'))))
print("md total in repowiki:", len([p for p in pathlib.Path('repowiki').rglob('*.md') if p.name != 'README.md']))
print("ledger rows:", len([l for l in (pathlib.Path('repowiki/ledger.jsonl')).read_text(encoding='utf-8').splitlines() if l.strip()]))
unresolvable = [r["page"] for r in w.load_ledger().values()
                if not (pathlib.Path("repowiki") / "topics" / r.page).is_file()]
print("ledger rows not resolvable:", len(unresolvable))
PY
```

Expected：`diverging pages: [] count 0`（topics 全部逐字节包含；唯一的改写页在 `modules/` 不在这里）、`topics … 450`、`md total … 494`、`ledger rows … 426`、`not resolvable … 0`。

- [ ] **Step 6: 生成并留档第一份报告**

Run: `python -X utf8 tools/wiki_drift.py report`
Expected：打印 `baseline 7fdffa31… (tree: modal page verified_at)`、`pages 450 total | needs update 445 | clean 5 (ledger 1, void 0, partial 423)`，写出 `repowiki/drift/drift.json` 与 `DRIFT.md`。

- [ ] **Step 7: 守卫 + 门禁 + 零上游**

```bash
python -X utf8 -m pytest tools/test_wiki_drift.py -q
bash tools/ci_grep_gates.sh | tee .qoder/tmp/gates_post_seed.txt
git -c core.quotepath=off diff --name-only upstream/main...HEAD \
  | grep -E '^(\.gitignore|tools/ci_grep_gates\.sh|\.github/workflows/test\.yml|wiki/)' || echo NONE
```

Expected：全绿；门禁仍只红那 **1 条**（路径以 `./.qoder/` 开头），`repowiki/` 贡献 **0** 命中 ⇒ `test_shipped_wiki_tree_is_trademark_clean` 绿（它就是那页改写落地的证明）；`NONE`。

- [ ] **Step 8: Step 1 的反空用例转绿 + 全量 + 提交**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q` → **151 passed**（150+1）

```bash
git status --short | head -5           # 只应出现 repowiki/ 下的新文件与测试改动
git add repowiki tools/test_wiki_drift.py
git -c core.quotepath=off status --short | wc -l    # 记录进提交信息前的最后一眼
git commit -s -m "$(cat <<'EOF'
feat(wiki): 播种 494 页进 repowiki/ —— 正文逐字节、基线落页、台账入 git

topics 450 + modules 35(30 播种 + pine-engine 手写) + cards 9；426 行 ledger 逐字节复制。
唯一被改写的播种页是 modules/ci-gates/architecture.md（去掉那句政策转述里的商标
字面量，指针保留），seed 记为 reworded=1 并点名。
播种前后 report 判定分布逐字段相同，只有 no_frontmatter 450 -> 0。
EOF
)"
```

---

## Task 11: `.qoder` 正文改名归档（移动，不删除）+ `EMPTY_TREE_HINT`

**Files:**
- Modify: 文件系统 `.qoder/repowiki/{zh,update}` → `.qoder/repowiki/_ide-export-retired-2026-10-01/`
- Modify: `tools/wiki_drift.py`（`EMPTY_TREE_HINT` 84）
- Test: `tools/test_wiki_drift.py`

**Interfaces:**
- Consumes: Task 10 的提交
- Produces: IDE 那份不再是「当前正文」；`--wiki-root .qoder/repowiki` 从此硬失败而不是静默报 450 页

- [ ] **Step 1: 写失败测试（提示文案必须自指新事实）**

```python
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
```

Run → FAIL（`EXPORT_ARCHIVE` 不在文案里）

- [ ] **Step 2: 先做仓库外备份确认（spec §14：未提交的 `.qoder` 资产唯一防丢手段）**

```bash
ls -d ../vibe-trading-wiki-content-backup-2026-10-01 2>/dev/null || echo "NO BACKUP — 先停，报告缺失"
find .qoder/repowiki/zh/content -name '*.md' | wc -l     # 450
sha256sum .qoder/repowiki/update/ledger.jsonl | cut -c1-12
```

备份目录不存在就**停下**并报告，不要继续移动（`.qoder` 未被 git 跟踪，撤销不了）。

- [ ] **Step 3: 归档（`mv`，不用 `rm`）**

```bash
mkdir -p .qoder/repowiki/_ide-export-retired-2026-10-01
mv .qoder/repowiki/zh .qoder/repowiki/_ide-export-retired-2026-10-01/zh
mv .qoder/repowiki/update .qoder/repowiki/_ide-export-retired-2026-10-01/update
ls -1 .qoder/repowiki                        # 期望：_ide-export-retired-2026-10-01  knowledge
find .qoder/repowiki/_ide-export-retired-2026-10-01 -name '*.md' | wc -l   # 450
find .qoder/repowiki/_ide-export-retired-2026-10-01 -name 'ledger.jsonl' -exec wc -l {} \;  # 426
```

`knowledge/` **原地不动**：门禁那条长期红噪音就在它里面，位置不变才让 Step 4 的失败集比对退化成字面空 diff。

- [ ] **Step 4: 门禁失败集逐行相同（M2 完工判据之一）**

```bash
bash tools/ci_grep_gates.sh > .qoder/tmp/gates_post_m2.txt 2>&1; echo "rc=$?"
diff .qoder/tmp/gates_pre_m2.txt .qoder/tmp/gates_post_m2.txt && echo "IDENTICAL FAILURE SET"
```

Expected：`IDENTICAL FAILURE SET`（rc=1 不变，唯一命中仍是 `./.qoder/repowiki/knowledge/…:2`；新树贡献 0）。若差异是「少了一条 `./.qoder/tmp/reword_probe.json`」之类，那是探针产物污染，按 §Global Constraints 的「探针只打印计数」清理后重跑。

- [ ] **Step 5: 改 `EMPTY_TREE_HINT`**

`{content}/{root}/{layout}` 是 `.format` 的槽位，不能把这一段写成 f-string（f-string 会当场求值 `{content}` 而 NameError）。归档路径由常量拼出，作为**第四个槽位**传入，三处调用点（1315、1469、1572）一起补 `archive=` —— 少补一处就是 `KeyError`，而这三处都有测试覆盖（`no wiki pages` 断言在 553、1634、1658 行）。

```python
EMPTY_TREE_HINT = (
    "no wiki pages under {content} (root {root}, layout {layout}).\n"
    "  The tracked tree is the publication: repowiki/topics (+ modules/, cards/).\n"
    "  The IDE export was archived (moved, not deleted) and is still readable as a\n"
    "  second root:  --wiki-root {archive}\n"
    "  Exiting 2 rather than reporting 0 pages, because an empty set that passes\n"
    "  every assertion is this repo's known false green."
)
```

三处调用点同步改为：

```python
            EMPTY_TREE_HINT.format(content=CONTENT, root=WIKI, layout=wiki_root.layout,
                                   archive=f"{LEGACY_EXPORT}/{EXPORT_ARCHIVE}"),
```

- [ ] **Step 6: 新树报告仍对 + 全量 + 提交**

```bash
python -X utf8 tools/wiki_drift.py report --json | python -X utf8 -c "import json,sys; print(json.load(sys.stdin)['summary'])"
python -X utf8 tools/wiki_drift.py --wiki-root .qoder/repowiki report --json > /dev/null; echo "rc=$?"   # 期望 rc=2
python -X utf8 -m pytest tools/test_wiki_drift.py -q     # 152 passed（151+1）
git status --short                                       # .qoder 不出现在这里（未跟踪）
git add tools/wiki_drift.py tools/test_wiki_drift.py
git commit -s -m "chore(wiki): IDE 正文与台账改名归档（移动非删除），空树提示指向归档"
```

---

## Task 12: 变异探针 + 守卫可红性 + 写回项目档案

**Files:**
- Modify: `项目档案.md`（§「重做设计…（2026-10-01，M1 已落地 / M2 待开工）」→ M2 已落地，实测数字、播种契约、两条改写、缺陷 ⑫ 现状）
- Modify: 项目记忆 `ops-repo-wiki-git-root-and-update.md`、`arch-repo-wiki-baseline-and-ci-status.md`（基线与命令口径已变，旧条目会误导未来会话）
- Test: 无新增断言（本任务只证明既有断言能红）

**Interfaces:**
- Consumes: Task 1–11 的交付物
- Produces: spec §12 B 工具/门禁两行的证据；下一次会话的可读锚点

- [ ] **Step 1: 变异探针（三态记录，每条改完立刻字节还原）**

对每条：`记录 sha256 → 植入一个具体 bug → 跑指定用例 → 期望红 → 还原 → 再跑全量绿`。

```bash
python -X utf8 - <<'PY'
import hashlib, pathlib
p = pathlib.Path("tools/wiki_drift.py")
pathlib.Path(".qoder/tmp/wiki_drift.sha.m1-probe").write_text(hashlib.sha256(p.read_bytes()).hexdigest())
PY
```

| # | 植入的 bug（一字之差的具体改动） | 观测点 | 期望 |
|---|---|---|---|
| P1 | `apply_page_plan` 里 `payload = … + plan.body` 之后加一行 `payload = payload + b"\n"` | `-k "reconciles_body_bytes"` 及 `-k idempotent` | KILLED（`sha_mismatch=1` 或二次运行不 skip）；若全绿 ⇒ **HARNESS-BLIND**，换观测点到 `endswith` 断言本身 |
| P2 | `emit_frontmatter` 恢复 `for key in FM_KEYS` 白名单（丢外来键） | `-k "keeps_foreign_keys"` | KILLED |
| P3 | `REWORDS = {}` | `-k "applies_the_reword" / -k "seed_reports_a_missing_reword"` 与 `-k reword_key` | KILLED（reworded 计数与「键必须指向真实页」两条至少中一条） |
| P4 | `tree_baseline` 里 `if HEX40_RE.match(rev)` 改成 `if rev` | `-k "ignores_non_hex"` | KILLED |
| P5 | `plan_topics` 的 `"vouch": "applied-only"` 改成 `"all"` | `-k "not_an_empty_set"` 里的 `vouch == "all" count 0`，以及 Task 10 的分布对账 | KILLED ——这条是 414 隐藏待办那个故障链的复活开关，必须能被抓 |
| P6 | `plan_knowledge` 的双向检查去掉 `unmapped` 那半 | `-k "demands_both_directions"` | KILLED |

任何一条 SURVIVED ⇒ 该断言是等价变异或根本没被执行覆盖，**改测试不是改断言强度来凑绿**；判不出来就记为 HARNESS-BLIND 并写明缺哪个观测点。

- [ ] **Step 2: 守卫的可红性实测（不是「扫到 0」就算合规）**

```bash
python -X utf8 - <<'PY'
import pathlib
needle = "".join(["wor", "ld", "quant"])
p = pathlib.Path("repowiki/topics/_probe.md")
p.write_text(f"# probe\n{needle}\n", encoding="utf-8")
print("planted", p)
PY
python -X utf8 -m pytest tools/test_wiki_drift.py -q -k "shipped_wiki_tree_is_trademark_clean"   # 必须 FAIL
rm repowiki/topics/_probe.md
python -X utf8 -m pytest tools/test_wiki_drift.py -q -k "shipped_wiki_tree_is_trademark_clean"   # 必须 PASS
```

再加 pathspec 死代码探针：临时把该用例的扫描根从 `repowiki/` 改成 `repowiki/definitely-absent/`，用例**必须仍然绿或明确失败**——如果它因为扫到空集合而绿，那就是本项目「扫全仓守卫测试的两种假绿」那个坑，必须补一条「扫描根非空」断言（`test_shipped_wiki_tree_is_trademark_clean` 已含「树非空」断言，本步验证它真的会因空目录而红）。

- [ ] **Step 3: 零上游检查的手动证伪（最小破坏）**

```bash
cp .gitignore .qoder/tmp/gitignore.bak
sha256sum .gitignore | cut -c1-12
printf '# probe\n' >> .gitignore
git -c core.quotepath=off diff --name-only upstream/main...HEAD \
  | grep -E '^(\.gitignore|tools/ci_grep_gates\.sh|\.github/workflows/test\.yml|wiki/)'   # 必须打印 .gitignore
cp .qoder/tmp/gitignore.bak .gitignore
sha256sum .gitignore | cut -c1-12          # 与第一步同值
git status --short                          # 必须干净
```

注意这条检查是 `upstream/main...HEAD`（提交级），工作区改动不会被它抓到；所以要验证 **pytest 版**守卫能红，必须真提交一个临时 commit。完整序列（**禁止 `--no-verify` 及任何变体**，钩子失败就停下报告，不许绕过）：

```bash
cp .gitignore .qoder/tmp/gitignore.bak && sha256sum .gitignore | cut -c1-12
printf '# probe\n' >> .gitignore
git add .gitignore && git commit -s -m "tmp: falsify the upstream-owned guard"   # 钩子照常跑
python -X utf8 -m pytest tools/test_wiki_drift.py -q -k upstream_owned          # 必须 FAIL 并点名 .gitignore
git reset --soft HEAD~1                       # 只动 HEAD，索引里那条改动还在
cp .qoder/tmp/gitignore.bak .gitignore        # 工作树还原（干净树上才允许这么写回）
git reset .gitignore                          # 退索引，让 index == HEAD
sha256sum .gitignore | cut -c1-12             # 与第一行同值
git status --short                            # 必须为空
```

`git reset --soft` 而不是 `--hard`：`--hard` 会连工作树一起吃掉，而这个仓库的工作树里有未跟踪的 `.qoder/` 与刚提交的 494 页，回滚代价不对等（同条记忆里已记过一次教训）。若嫌这条序列的风险不划算，退化为只跑谓词 canary（`test_protected_path_predicate_flags_known_owned_paths` 已在），并在档案里写明「提交级证伪本轮未做」——不许默默略过后称已验。

- [ ] **Step 4: 全量 + 水位收口**

```bash
python -X utf8 -m pytest tools/test_wiki_drift.py -q      # 152 passed，0 failed
bash tools/ci_grep_gates.sh > .qoder/tmp/gates_final.txt 2>&1; echo rc=$?
diff .qoder/tmp/gates_pre_m2.txt .qoder/tmp/gates_final.txt && echo "FAILURE SET UNCHANGED"
git -c core.quotepath=off diff --name-only upstream/main...HEAD \
  | grep -E '^(\.gitignore|tools/ci_grep_gates\.sh|\.github/workflows/test\.yml|wiki/)' || echo NONE
find repowiki -name '*.md' | grep -v README | wc -l       # 494
```

- [ ] **Step 5: 写回 `项目档案.md` 与记忆**

档案里必须落的数字（本次实测，不抄本计划预测）：播种页数、`reworded` 页名、`sha_mismatch`、`no_sources`、报告分布唯一变化项、归档路径、门禁仍红那 1 条及其识别法（路径以 `./.qoder/` 开头）、`seed` 是一次性动作、`report` 不再强制 `--baseline`、以及 Task 7 那条对 spec §6 的有意偏离。

记忆更新两条：`ops-repo-wiki-git-root-and-update.md`（默认根仍 `repowiki/`，但「未播种 ⇒ 故意 exit 2」已失效；动 450 页现在直接改 `repowiki/topics/`）、`arch-repo-wiki-baseline-and-ci-status.md`（基线已下沉到页面 + 树级回落取众数）。

**顺带处理一个本次写计划时新发现的事实**：spec 与本计划都落在 `docs/` 下，而上游 `.gitignore:124` 把整个 `docs/` 忽略（注释即 `# Internal docs (plans, specs)`，上游自己在这个目录里没有任何文件）。这意味着**这两份文档目前是磁盘上唯一的副本**，和审计里 `.qoder/tmp` 那类「真丢失」同级。要入库只有一条路：`git add -f docs/superpowers`（不动 `.gitignore`，因此零上游约束不变；今后 `git status` 会照常显示它们，因为一旦被跟踪，ignore 规则就不再作用）。**这是改跟踪范围的动作，必须先问用户**；用户不同意就原样留在磁盘，并在本步之后把「spec/plan 未入库」写进档案，不许默认它是已备份的。

- [ ] **Step 6: 提交**

```bash
git add 项目档案.md
git commit -s -m "docs(profile): M2 落地的实测数字、播种契约与归档位置"
# 仅在用户批准后执行：
git add -f docs/superpowers && git status --short   # 确认是这两个文件，不是别的
git commit -s -m "docs(plan): M2 播种实施计划与设计 spec 入库（docs/ 被上游 .gitignore 忽略，需 -f）"
```

---

## 验收门槛对照（spec §13 M2 行 / §12 各行）

| spec 要求 | 本计划落点 | 证据形态 |
|---|---|---|
| `seed` 先 dry 再实，494 页搬进 `repowiki/` 并提交 | Task 6、Task 10 Step 2/3/8 | `pages_written=489`（＋手写 5 ＝ 494）与两次 `--apply` 的 0/489 |
| `.qoder` 正文改名归档（移动非删除） | Task 11 Step 3 | `find … -name '*.md' \| wc -l` = 450 在归档目录里 |
| `reworded=1` 那页落地并点名 | Task 3 `REWORDS`、Task 6 打印、Task 12 P3 | 输出的 `reworded: modules/ci-gates/architecture.md` |
| §12 播种行（逐文件 sha 对账、494、`sha_mismatch==0`、frontmatter 全解析） | Task 6 `apply_page_plan`、Task 10 Step 1/5 | `diverging pages: [] count 0` |
| §12 反空断言行 | Task 10 Step 1 | `len(pages) == 494` 播种前必然红 |
| §12 幂等行 | Task 6 Step 1、Task 10 Step 3 | `pages_written=0 pages_skipped=489` |
| §12 形状审计行 | Task 10 Step 5（独立脚本，不用 `seed` 自己的口径） | 行数不变 + `endswith` 双查 |
| §12 门禁行（失败集逐行相同 + 守卫能红 + 不扫空集合） | Task 11 Step 4、Task 12 Step 2 | `IDENTICAL FAILURE SET` + 种植/删除两次跑 |
| 零上游文件改动 | 每任务收尾 + Task 12 Step 3 | `NONE` 与 `.gitignore` 证伪 |
| 五契约不退化（`vouch`/`partial`/`ledger-void`/行数/越界措辞） | Task 4 契约段、Task 10 Step 4 分布对账、Task 12 P5 | 只有 `no_frontmatter` 变，per-page `base` 差异 0 |

## 不在本计划内（各自需独立 spec→plan）

M3 `stale`/`index` + `tools/wiki_freshness_gate.sh` + 新文件 `.github/workflows/repowiki-freshness.yml`（task #14）；M4 QMind 聚合层入库 + 哨兵正证（#15）；M5 散文层重写（423 partial + 22 stale，按 16 个顶层目录分片，#16）。M2 之后 `repowiki/` 的定性仍是「链接层已核、散文层未核，别当事实源」。
