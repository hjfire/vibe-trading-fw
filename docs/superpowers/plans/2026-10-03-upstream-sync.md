# 上游同步轮（2026-10）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把上游 35 个提交并进 `sync/upstream-2026-10`，并交付三层各自可红的证据 —— 文本层证明两边的 hunk 都还在，数值层证明两条 A 股复权实现给同一个收益率、且降级时口径标签不静默。

**Architecture:** 一次 `git merge`（零冲突）作底座，之上是三台互不重叠的机器：`tools/test_upstream_sync.py`（钉 14 个重叠文件的双方锚点文本，由 fork 自带工作流收集）、`agent/tests/test_upstream_sync_calibers.py`（入库 fixture 驱动的跨实现对账，由上游 `test.yml` 收集）、`tools/wiki_freshness_gate.sh` + 工作流的两处水位针脚（同步后重测重钉）。本轮**零上游文件改动**：spec §3.1 的取证证明合并把上游自己的 `frame_caliber`（attrs 优先）干净带进 6 个调用点，于是原设计的「豁免两处上游文件」整块撤销。

**Tech Stack:** Python 3.11、pytest、pandas（仅 `agent/tests/` 那台机器）、stdlib + pytest（`tools/` 那台）、Git、GitHub Actions（fork 自有 `repowiki-freshness.yml`）。

**Spec:** `docs/superpowers/specs/2026-10-03-upstream-sync-design.md`（含 §3.1 更正块与 §6 更正版裁定 —— 计划从更正后的前提出发，spec 原文一并交付给执行者阅读）

## Global Constraints

- **零上游文件改动，本轮无豁免。** 判据：受保护四前缀 `.gitignore`、`tools/ci_grep_gates.sh`、`.github/workflows/test.yml`、`wiki/`（`tools/test_wiki_drift.py` 里的 `UPSTREAM_OWNED` 正则），加上「本轮不许编辑任何 `upstream/main` 里已存在的文件」。唯一例外：**变异探针可以在工作副本内临时改上游文件，`finally` 字节还原 + sha256 前后校验，不留改动**。
- **上游地籍不许改**：`pyproject.toml`（含 `testpaths = ["agent/tests"]` 与 markers）、`agent/tests/conftest.py`。不新建 pytest 标记。
- 每轮结束 `git status --porcelain` 必须为空；每个提交 `git commit -s`（DCO trailer），**绝不 `--no-verify`**；**绝不 push、绝不建 PR、绝不动 `origin`**；`main` 在三层验收全绿前不移动。
- `docs/` 被 `.gitignore:124` 忽略 ⇒ spec 与本计划都要 `git add -f`（既有 4 个 docs 文件就是这么进来的）。
- 探针纪律（本仓既有）：needle 唯一 + `finally` 字节还原 + sha256 前后校验；**禁用 `git checkout --` / `git restore` / `git stash` 还原**（脏树上会冲掉别人的工作）。
- Windows 本机：一律 `python -X utf8`；bash 脚本用 `bash tools/xxx.sh`（`core.filemode=false`，`./` 写法在 runner 上 Permission denied）；`core.autocrlf=true`。
- 全量套件基线（`f90473e2` 实测）：**17043 passed / 169 skipped / 11 failed / 11 errors**，529.96s；22 条红里 20 处 `OSError [WinError 1314]`（无符号链接特权），余 2 条是文件锁与时钟时限。失败必须**逐条按成因归类**，对不上基线的单列「本轮新增红」并停下修。**注意**：这条基线是合并**前**的；Task 1 报告实测从仓库根跑的 deselected 计数在合并前后是 **17227 → 17386**（差 159，上游那 7 个新测试文件带来的），所以 `17043 passed` 这个总数在 Task 8 不可逐字引用 —— 能对上的只有「22 条红的成因清单」，归类按成因、不按总数。
- `tools/` 那台机器只用 stdlib + pytest（fork 工作流只 `pip install pytest`）；`agent/tests/` 那台**刻意破这条纪律**，因为收益率对账离不开 pandas/numpy，它由上游 `test.yml` 经 `testpaths` 收集。
- 数值断言只读入库 fixture，**CI 里不取网络**。真取数只出现在 Task 3 的一次性只读探针与 Task 4 的一次性采集脚本里，两者都不提交脚本本体。
- 商标/敏感词针脚不许字面写进被扫描面（`.superpowers/**`、`tools/`、`repowiki/`、`.github/`、`项目档案.md`）；`docs/` 被 `ci_grep_gates.sh:66` 的 `--exclude-dir=docs` 豁免。
- 文档诚实性：每条守卫交「先弄红」证据；引用数字必须带提交坐标；不许 over-claim，也不许 under-report。
- 回复用户用中文；代码与命令原文保留。

**本轮读数的坐标**（写进任何文档时必须带上，否则下一轮一读就对不上）：`upstream/main = f21aa13d`；本计划写作时的 `HEAD = 8d1cba91`（spec 更正提交），`upstream/main...HEAD = 35 / 237`，`git merge-base upstream/main HEAD = 18027a0c`，`git merge-tree --write-tree HEAD upstream/main` 的树 oid = `306342d9`（rc=0）；spec §3.1 那批调用点读数是**在 `664e141f` 的合并树 `8a7a6740` 上**测的（**树 oid 含我们的树，HEAD 每前移一次都要重取**）。这些数**都是写作时点读数**，Task 1 Step 1 的全部意义就是重测它们 —— 对不上就停下，不在旧结论上硬合。

---

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `sync/upstream-2026-10` 分支 | 承载 merge 提交与全部守卫提交；`main` 不动 | Task 1 创建 |
| `tools/test_upstream_sync.py` | 文本层：14 个重叠文件的双方锚点是否逐字在位 | Task 2 新建 |
| `.github/workflows/repowiki-freshness.yml:85` | 把新守卫纳入 CI 收集面（不改这行它就永远没人收） | Task 2 改一行 |
| `项目档案.md` | 探针读数、缺口登记、水位重钉三处落档 | Task 3 / 7 / 8 各写一段 |
| `agent/tests/fixtures/upstream_sync/*.csv` + `manifest.json` | 数值层的入库样本（3 只可转换窗口 + 1 只拒绝窗口） | Task 4 新建 |
| `agent/tests/test_upstream_sync_calibers.py` | 数值层三条断言（G3 等价 / G1 attrs-first / G2 降级诚实） | Task 5、6 新建并扩 |
| `tools/wiki_freshness_gate.sh:16` + `.github/workflows/repowiki-freshness.yml:75` + `tools/test_wiki_drift.py` 四处 `445` 针脚 | 水位重钉必须是两文件同步动作 | Task 7 |

---

### Task 1: 同步分支与合并（含合并前后读数对账）

**Files:**
- Create: 分支 `sync/upstream-2026-10`（起点＝本计划落地后的 `HEAD`）
- Modify: 无（合并提交由 `git merge --no-edit` 自带）
- Ledger: `.superpowers/sdd/2026-10-03-upstream-sync/progress.md`（SDD workspace，git-ignored）

**Interfaces:**
- Produces: `MERGE_SHA`（Task 2 的锚点表要把它写进 docstring）、`BASE_SHA`（合并前的 `HEAD`）、合并后的树里 `frame_caliber` 的 6 个调用点（Task 6 的断言对象）。

- [ ] **Step 1: 复测合并前的全部 git 读数**（spec §2 的表是在 `f90473e2` 上测的，本计划提交后 `HEAD` 前移了 1～2 个提交，必须重测）

```bash
git fetch upstream
git rev-parse --short HEAD; git rev-parse --short upstream/main
git rev-list --left-right --count upstream/main...HEAD
git merge-base upstream/main HEAD
git merge-tree --write-tree HEAD upstream/main | head -1; echo "merge-tree rc=$?"
git diff --name-only HEAD...upstream/main -- .gitignore tools/ci_grep_gates.sh .github/workflows/test.yml wiki/ | wc -l
comm -12 <(git diff --name-only upstream/main...HEAD | sort) <(git diff --name-only HEAD...upstream/main | sort) | wc -l
```

Expected：`35 / <N>`（`N` 记录实际值，本计划写作时是 236）；merge-base `18027a0c`；merge-tree **rc=0** 且只输出一行 tree oid；四前缀 `0`；重叠文件 `14`。
**若 merge-tree rc≠0 或重叠数≠14 ⇒ 停下**（spec §8 的停止条件：`upstream/main` 又动了，不在旧结论上硬合），把读数报给用户。

- [ ] **Step 2: 采合并前门禁面读数**（Task 8 要比对，必须先留底）

```bash
python -X utf8 -m pytest tools/test_wiki_drift.py -q -k upstream_owned 2>&1 | tail -3
bash tools/ci_grep_gates.sh > /tmp/gates_before.txt 2>&1; echo "rc=$?"
python -X utf8 tools/wiki_drift.py stale --format count
python -X utf8 tools/wiki_drift.py index --check >/dev/null 2>&1; echo "index rc=$?"
```

Expected：`-k upstream_owned` 收到 **1** 条并通过（**必须指名文件**：`pyproject.toml:276` 的 `testpaths = ["agent/tests"]` 让从仓库根跑的 `-k` 永远收不到 `tools/` 下的用例 —— 在合并后的 `d9a2fdc5` 实测：从根跑 `7 skipped, 17386 deselected`，指名文件 `1 passed, 229 deselected`）；`ci_grep_gates.sh` rc=1（既有形状：19 行输出、`docs/` 0 行、`./.qoder/` 恰 1 条）；stale 读数 **445**；`index --check` rc=0。把四行读数写进 ledger 的 `Task 1: pre-merge readings` 段。

- [ ] **Step 3: 建分支并合并**

```bash
git checkout -b sync/upstream-2026-10
git merge upstream/main --no-edit
git status --porcelain
git log --oneline -1
git rev-list --count HEAD^1..HEAD^2
```

Expected：`git status --porcelain` 空；`git log --oneline -1` 是 `Merge remote-tracking branch 'upstream/main' into sync/upstream-2026-10`；`HEAD^1..HEAD^2` 计数 = **35**（第二-parent 侧带进来的提交数，等号不成立说明合并方向或基点错了 ⇒ 停下）。记录 `MERGE_SHA=$(git rev-parse HEAD)`。

- [ ] **Step 4: 复测合并后的口径调用点（这是 spec §3.1 第 2 条的实测复现，不是推理）**

```bash
git grep -c "frame_caliber(" -- agent/src/market_data.py agent/backtest/runner.py
git grep -n "def frame_caliber" -- agent/backtest/loaders/registry.py
git grep -n '"adjustment": "split_dividend"' -- agent/backtest/loaders/akshare_loader.py
git grep -n '("akshare", "a_share")' -- agent/backtest/loaders/registry.py
python -X utf8 -c "import sys; sys.path[:0]=['agent']; from backtest.loaders import registry; print(registry.frame_caliber.__doc__.splitlines()[0])"
```

Expected：`market_data.py` 命中 **1**、`runner.py` 命中 **5**；`def frame_caliber` 在 `registry.py` 存在；akshare loader 有 `"adjustment": "split_dividend"` 写入点（合并树实测在 `akshare_loader.py:371`，形状是 `converted.attrs = {**getattr(df, "attrs", {}), "adjustment": "split_dividend",}` 的字典字面量，**不是** `attrs["adjustment"] = …` 的下标赋值 —— 原判据按字面写法 grep 会 0 命中，那是判据写错不是合并丢了东西）；表里有 `("akshare", "a_share")` 那一格；末行打印出函数 docstring 首句。
**任何一条不成立 ⇒ 本计划的 Task 5/6 前提失效，停下重读 spec §3.1，不要改代码去凑。**

- [ ] **Step 5: 复测门禁面（合并后）**

重跑 Step 2 的四条命令，把读数并排写进 ledger 的 `Task 1: post-merge readings` 段。Expected：`upstream_owned` 仍 1 条且绿；`ci_grep_gates.sh` 输出与 `/tmp/gates_before.txt` **剥掉 6-hex 短 sha 后 diff 为空**；stale 读数 ≥445（这是预期，不叫失败）；`index --check` 仍 rc=0。

```bash
sed -E 's/\b[0-9a-f]{6,40}\b/SHA/g' /tmp/gates_before.txt > /tmp/gates_before_norm.txt
bash tools/ci_grep_gates.sh > /tmp/gates_after.txt 2>&1
sed -E 's/\b[0-9a-f]{6,40}\b/SHA/g' /tmp/gates_after.txt > /tmp/gates_after_norm.txt
diff /tmp/gates_before_norm.txt /tmp/gates_after_norm.txt && echo "gates identical"
```

- [ ] **Step 6: 不新增提交、不推送**

合并提交就是本任务唯一的提交。确认 `git status --porcelain` 空后结束。

---

### Task 2: 文本层守卫 `tools/test_upstream_sync.py` ＋ 收集面

**Files:**
- Create: `tools/test_upstream_sync.py`
- Modify: `.github/workflows/repowiki-freshness.yml:85`（一行）
- Test: 本任务的文件就是被测对象；可红性由 Step 4/5 的两次植入交付

**Interfaces:**
- Consumes: `MERGE_SHA`（Task 1）、14 个重叠文件清单（Task 1 Step 1 的 `comm -12` 输出）。
- Produces: `OVERLAP_FILES` / `ANCHORS` / `NO_ANCHORS` 三个模块级常量（Task 8 的档案段落要引用其计数）。

- [ ] **Step 1: 生成锚点表（一次性脚本，不入库）**

规则：`.py` 取**新增的 `def`/`async def`/`class` 行**（含缩进整行），`.md` 取**新增的标题行**；去重、丢长度 <12 的、丢含双引号的；某侧为空则该文件进 `NO_ANCHORS`。

```bash
python -X utf8 - <<'PY'
import subprocess, re
# 坐标必须写死成字面 sha：合并之后 merge-base(upstream/main, HEAD) == upstream/main，
# 于是 `git diff HEAD...upstream/main` 变成**空集**，`upstream/main...HEAD` 变成「我们对
# 上游的全部差」。照字面跑会得到一张空锚点表，而守卫对空表是**真空通过**的 —— 本项目
# 已知的第二种假绿形状。M/OURS/THEIRS 三方都来自 Task 1 的 ledger。
M, OURS, THEIRS = "18027a0c", "518d793f", "f21aa13d"
FILES = subprocess.run(
    ["git", "diff", "--name-only", f"{M}..{OURS}"], capture_output=True, text=True, encoding="utf-8"
).stdout.split()
THEIRS_FILES = set(subprocess.run(
    ["git", "diff", "--name-only", f"{M}..{THEIRS}"], capture_output=True, text=True, encoding="utf-8"
).stdout.split())
OVERLAP = [f for f in FILES if f in THEIRS_FILES]
assert THEIRS_FILES and OVERLAP, "empty theirs/overlap set -> the table would be vacuously green"
assert len(OVERLAP) == 14, (len(OVERLAP), OVERLAP)   # Task 1 实测；不等于 14 就停下报读数
RULE = {".py": re.compile(r"^\s*(async def |def |class )"), ".md": re.compile(r"^#{1,6} ")}

def added(side, path):
    rng = f"{M}..{OURS}" if side == "ours" else f"{M}..{THEIRS}"
    out = subprocess.run(["git", "diff", rng, "--", path], capture_output=True, text=True, encoding="utf-8").stdout
    lines = [l[1:] for l in out.splitlines() if l.startswith("+") and not l.startswith("+++")]
    rx = RULE["." + path.rsplit(".", 1)[-1]]
    cand, seen = [], set()
    for s in lines:
        s2 = s.rstrip()
        if not rx.match(s2.strip() if path.endswith(".md") else s2):
            continue
        if len(s2.strip()) < 12 or '"' in s2 or s2 in seen:
            continue
        seen.add(s2); cand.append(s2)
    return cand

print("OVERLAP_FILES =", repr(tuple(OVERLAP)), "# n =", len(OVERLAP))
tot = 0
for side in ("ours", "theirs"):
    print(f"\nANCHORS[{side!r}] = {{")
    for f in OVERLAP:
        a = added(side, f)
        tot += len(a)
        print(f"    {f!r}: {a!r}," if a else f"    # MISSING {side} {f}")
    print("}")
print("\ntotal anchors =", tot)
PY
```

Expected：打印出 `n = 14` 与两份表，`total anchors` 是一个**非零**整数。
**`MISSING` 的处理**（不许留空装作有）：先跑放宽规则 —— 同一函数里再取「新增的模块级常量赋值行」`^\s*[A-Z][A-Z0-9_]{3,}(: .*)? = `；仍为空则手工挑**一条在合并后文件里逐字唯一、长度 ≥25、不含 `"` 的新增行**；挑不出来才把该文件登记进 `NO_ANCHORS[side]`，并在集合旁写一行**理由注释**（例如「该侧只删不增」或「改动是 badge 行，标题层无新增」）。把每一步的实得计数记进 ledger。

- [ ] **Step 2: 写守卫文件**

把 Step 1 的表粘进下面这个骨架（`...` 处全部替换为实得字面量；**不许留 `...`**）：

```python
"""Guard BOTH sides of the 2026-10 upstream merge against silent loss.

`UPSTREAM_OWNED` (tools/test_wiki_drift.py) proves one direction only: we did not
edit upstream's four protected prefixes. It cannot prove the direction a sync
actually risks — that `git merge` kept OUR hunks in the 14 files both sides
changed. Zero conflicts is not evidence of that: the two sides edited *different
regions* of the same file, which is exactly how one side's hunk disappears while
the merge still reports success.

Anchors are literals captured on MERGE_SHA 0000000 (replace with the real short
sha) from the two-sided diffs against merge base 18027a0c, NOT a live `git diff`,
because the fork workflow runs in a checkout whose refs may not carry the base.
"""

from __future__ import annotations

from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
MERGE_BASE = "18027a0c"

OVERLAP_FILES: tuple[str, ...] = ...          # Step 1 的 14 元组

ANCHORS: dict[str, dict[str, tuple[str, ...]]] = {"ours": ..., "theirs": ...}

#: Files where a side has no anchor to read. Every entry must carry its reason in
#: the comment; an undeclared gap here is the vacuous pass this module exists to
#: prevent.
NO_ANCHORS: dict[str, tuple[str, ...]] = {"ours": ..., "theirs": ...}

TOTAL_ANCHORS = ...                            # Step 1 打印的 total，作为形状下限


@pytest.mark.parametrize("side", ("ours", "theirs"))
def test_the_anchor_table_is_a_declared_partition_of_the_overlap_set(side: str) -> None:
    """Every overlap file is either pinned or explicitly excused — no silent holes."""
    covered = set(ANCHORS[side]) | set(NO_ANCHORS[side])
    assert covered == set(OVERLAP_FILES), sorted(set(OVERLAP_FILES) - covered)
    assert not set(ANCHORS[side]) & set(NO_ANCHORS[side]), "a file cannot be both pinned and excused"
    for rel, needles in ANCHORS[side].items():
        # An empty tuple in ANCHORS is the OTHER vacuous pass: the file looks covered,
        # the per-file loop below asserts nothing, and the partition test stays green.
        assert needles, f"{side}/{rel} is declared as pinned with zero needles"


def test_the_anchor_table_has_not_been_thinned() -> None:
    """A guard that loses its own rows passes quietly. This one cannot: the floor is the
    count captured at merge time, and the two-sided totals are what makes the per-file
    loop above mean something."""
    total = sum(len(v) for side in ANCHORS.values() for v in side.values())
    assert total >= TOTAL_ANCHORS, f"{total} anchors, captured {TOTAL_ANCHORS}"


@pytest.mark.parametrize("side", ("ours", "theirs"))
@pytest.mark.parametrize("rel", OVERLAP_FILES)
def test_both_sides_changes_are_still_in_the_merged_file(side: str, rel: str) -> None:
    if rel in NO_ANCHORS[side]:
        pytest.fail(f"{side} declared no anchors for {rel} yet it is not excused either")
    text = (REPO / rel).read_text(encoding="utf-8")
    missing = [n for n in ANCHORS[side].get(rel, ()) if n not in text]
    assert not missing, (
        f"{side}-only hunks vanished from {rel} ({len(missing)} of "
        f"{len(ANCHORS[side].get(rel, ()))}): " + " || ".join(missing[:3])
    )
```

- [ ] **Step 3: 跑绿**

Run: `python -X utf8 -m pytest tools/test_upstream_sync.py -q`
Expected：全绿（用例数 = 2 + 1 + 14×2 = **31**；不是 31 就说明 `OVERLAP_FILES` 或分区写错了）。

- [ ] **Step 4: 可红性证据（用例面）—— 改名必须让它红**

挑 `agent/backtest/loaders/akshare_loader.py` 里一条 **ours** 锚点（应为 `    def fetch_raw_with_factor(` 一族），在工作副本内改名，跑守卫，再按字节还原：

```bash
python -X utf8 - <<'PY'
import hashlib, pathlib, subprocess
p = pathlib.Path("agent/backtest/loaders/akshare_loader.py")
NEEDLE = "    def fetch_raw_with_factor("            # 必须在锚点表里唯一命中
ORIG = p.read_bytes(); SHA = hashlib.sha256(ORIG).hexdigest()
try:
    text = p.read_text(encoding="utf-8")
    assert text.count(NEEDLE) == 1, text.count(NEEDLE)
    p.write_text(text.replace(NEEDLE, "    def fetch_raw_with_factor_PROBED("), encoding="utf-8")
    r = subprocess.run(["python", "-X", "utf8", "-m", "pytest", "tools/test_upstream_sync.py", "-q",
                        "-k", "akshare_loader"], capture_output=True, text=True, encoding="utf-8")
    print("PROBE rc=", r.returncode); print(r.stdout[-1500:])
    assert r.returncode != 0, "the guard stayed green on a renamed ours-only function"
finally:
    p.write_bytes(ORIG)
    assert hashlib.sha256(p.read_bytes()).hexdigest() == SHA, "byte restore failed"
print("restored, sha verified")
PY
git status --porcelain
```

Expected：`PROBE rc=1`，输出里能看到 `ours-only hunks vanished from agent/backtest/loaders/akshare_loader.py`；还原后 `git status --porcelain` 空。

- [ ] **Step 5: 可红性证据（门禁面）—— 收集面真的收**

```bash
python -X utf8 -m pytest tools/test_wiki_drift.py tools/test_upstream_sync.py -q -m "not local_archive" --collect-only 2>&1 | tail -2
python -X utf8 -m pytest tools/test_upstream_sync.py -q --collect-only -k upstream_sync 2>&1 | tail -2
```

Expected：第一条把两个文件一起收，`tail` 里出现 `tools/test_upstream_sync.py` 的用例；第二条 31 条。**再把工作流那一行临时改回只收 `test_wiki_drift.py`**，跑同一条 `--collect-only`，命中必须掉到 **0**，然后立刻按字节还原并校验 sha256（同 Step 4 的形状，needle 换工作流那一行）。**不把「临时改回」留在树上**，收尾 `git status --porcelain` 空。

- [ ] **Step 6: 正式改收集面（一行）**

`.github/workflows/repowiki-freshness.yml:85`：

```yaml
        run: python -X utf8 -m pytest tools/test_wiki_drift.py tools/test_upstream_sync.py -q -m "not local_archive"
```

- [ ] **Step 7: 证明这一行没弄坏钉在工作流上的 5 条用例**

Run: `python -X utf8 -m pytest tools/test_wiki_drift.py -q -k "workflow"`
Expected：全绿。这 5 条（`:4925` `:4963` `:5008` `:5031` `:5050`）断的是 `fetch-depth: 0`、`wiki_freshness_gate.sh`、`not local_archive` 子串与 `continue-on-error` 恰 1 处，多一个路径都不影响；**若有红，说明新增路径撞了针脚，改守卫的表述而不是改针脚**。

- [ ] **Step 8: 提交**

```bash
git add tools/test_upstream_sync.py .github/workflows/repowiki-freshness.yml
git commit -s -m "test(sync): 文本层守卫 —— 14 个重叠文件的双方 hunk 逐字钉住，并把它接进 CI 收集面

零冲突不证明我们的 hunk 还在：两边改的是同一文件的不同区域。UPSTREAM_OWNED 只
证明反向（我们没动上游四个受保护前缀），本轮 14 个文件一个都不在它里面。锚点是
合并时抓的字面量，不是活动 git diff —— 全新检出的 ref 里未必有 merge-base。
收集面同轮换：工作流那行现在收两个文件，否则这条守卫只是一支本地手动用例。"
git status --porcelain
```

---

### Task 3: §6 可达性探针与 fixture 形态裁定

**Files:**
- Modify: `项目档案.md`（追加一段，带提交号与日期）
- 无代码产物；探针脚本走 heredoc，不落文件。

**Interfaces:**
- Produces: `ADDITIVE_SOURCE = "vendor" | "derived"` —— Task 4 用它选采集路径，Task 5 用它决定 docstring 的措辞（互证 vs 一致性对账）。

- [ ] **Step 1: 跑一次性只读探针（真网络，只读，不写盘）**

```bash
python -X utf8 - <<'PY'
import sys, json, traceback
sys.path[:0] = ["agent"]
import akshare as ak
probe = {}
for key, call in {
    "em_hist_raw": lambda: ak.stock_zh_a_hist(symbol="600519", period="daily",
                                              start_date="20240101", end_date="20261003", adjust=""),
    "em_hist_qfq": lambda: ak.stock_zh_a_hist(symbol="600519", period="daily",
                                              start_date="20240101", end_date="20261003", adjust="qfq"),
    "sina_daily_raw": lambda: ak.stock_zh_a_daily(symbol="sh600519", start_date="20240101",
                                                  end_date="20261003", adjust=""),
    "sina_hfq_factor": lambda: ak.stock_zh_a_daily(symbol="sh600519", start_date="20240101",
                                                   end_date="20261003", adjust="hfq-factor"),
}.items():
    try:
        df = call()
        probe[key] = {"rows": 0 if df is None else int(len(df)),
                      "cols": [] if df is None else [str(c) for c in df.columns][:12],
                      "head": None if df is None or df.empty else str(df.iloc[0].to_dict())[:220]}
    except Exception as exc:
        probe[key] = {"error": f"{type(exc).__name__}: {exc}"[:220]}
print(json.dumps(probe, ensure_ascii=False, indent=2))
PY
```

Expected：四个端点各得 `rows` 或 `error`。**不许猜**；`em_hist_raw` 与 `em_hist_qfq` 两个都要能拿到非零 `rows`，才算 vendor 可达。

- [ ] **Step 2: 裁定并落档（两个结局都不动上游文件，差别只在 fixture 形态）**

- `em_hist_*` 双双可达 ⇒ `ADDITIVE_SOURCE = "vendor"`：断言一是**跨厂商取数路线的数值互证**（Sina 因子表 vs 东财 additive 平台）。
- 任一 `em_hist_*` 挂 ⇒ `ADDITIVE_SOURCE = "derived"`：additive 序列由 Sina `hfq-factor` 步长按 `除权参考价 = 前收盘 × f_next/f_prev` 反推，断言一**降级为「同一批公司行为在两种编码下的一致性」**，docstring 与档案都必须这样写，不许说成互证。

```markdown
## 上游同步轮（2026-10-03，`<MERGE_SHA>` × `upstream/main=f21aa13d`）

- **akshare A 股 lane 本机可达性（一次性只读探针，不进 CI）**：`em_hist_raw` = `<读数>`、
  `em_hist_qfq` = `<读数>`、`sina_daily_raw` = `<读数>`、`sina_hfq_factor` = `<读数>`。
  裁定 `ADDITIVE_SOURCE = <vendor|derived>` ⇒ 数值层断言一是**<跨厂商互证 | 同厂商两编码一致性>**。
- **G1｜`frame_caliber` 零测试**：上游带函数（`registry.py`）与 6 个调用点（`market_data.py` 1 +
  `runner.py` 5）不带测试（`git grep -l frame_caliber upstream/main -- agent/tests` 无命中）。
- **G2｜降级支出门读数零断言**：上游 `agent/tests/test_additive_conversion.py:205` 一族只断
  「加法序列原样穿过」，没断 `adjustment` 字段是什么 ⇒ 一次表改动就能把它变成静默错标。
- **G3｜两条乘法实现从未对账**：`convert_additive_to_multiplicative`（偏移反推因子）与
  `cn_adjust.apply_qfq`（厂商因子表）是两条独立取数路线，上游用例全是合成小样本单实现自证。
- **本轮零上游文件改动，无豁免**：spec §3.1 推翻了初版「降级即谎报」的判词 ——
  `price_caliber()` 的 per-(source, market) 例外先赢，`("akshare","a_share")` 本来就是
  `split_dividend_additive`；转换成功支由 `attrs["adjustment"]` 报乘法。两支读数都诚实，
  本轮交付的是「把诚实从巧合变成有断言撑着」。
```

（把 `<...>` 逐个换成 Step 1 的实得读数；`项目档案.md` 追加在文件末尾，不重排既有任何行。）

- [ ] **Step 3: 提交**

```bash
git add 项目档案.md
git commit -s -m "docs(档案): 同步轮取证 —— 本机 A 股端点读数与 G1/G2/G3 三条缺口登记"
git status --porcelain
```

---

### Task 4: fixture 采集、分桶与入库

**Files:**
- Create: `agent/tests/fixtures/upstream_sync/<CODE>_raw.csv`、`_hfq.csv`、`_qfq.csv`（每只三个）与 `manifest.json`
- Modify: 无（`manifest.json` 就是采集过程的唯一入库产物）

**Interfaces:**
- Consumes: `ADDITIVE_SOURCE`（Task 3）；`AkshareLoader.fetch_raw_with_factor(codes, start, end, interval="1D") -> dict[code, (bars, factor)]`（`bars` 索引 `trade_date`、列 `open/high/low/close/volume`；`factor` 列 `trade_date/adj_factor`）；`AkshareLoader._fetch_a_share(ak, code, start_date, end_date, interval)`（东财 `adjust="qfq"` additive）。
- Produces: `SYMBOLS_CONVERTIBLE: tuple[str, ...]`（3 只）、`SYMBOL_REFUSAL: str`（1 只）、`manifest.json` 的 `symbols[*].bucket` 与 `additive_source` 键（Task 5/6 读它们）。

- [ ] **Step 1: 选样与分桶 —— 让生产代码自己分类，不靠人肉认定「这只票有送转」**

`additive_conversion` 的 refusal 规则就是判据：纯现金分红窗口 ⇒ 返回 frame；跨送转（偏移随价位漂移）⇒ 返回 `None`。候选顺序固定 `["600519.SH", "000001.SZ", "601398.SH", "600036.SH", "000651.SZ"]`，窗口 `2025-01-01` … 采集当日（**500 根以内**）。

```bash
python -X utf8 - <<'PY'
import sys; sys.path[:0] = ["agent"]
import akshare as ak, pandas as pd
from backtest.loaders.akshare_loader import DataLoader
from backtest.loaders.additive_conversion import convert_additive_to_multiplicative

START, END = "2025-01-01", "2026-10-03"
CAND = ["600519.SH", "000001.SZ", "601398.SH", "600036.SH", "000651.SZ"]
loader = DataLoader()
rows = []
for code in CAND:
    bars, factor = loader.fetch_raw_with_factor([code], START, END)[code]
    if factor is None:
        rows.append((code, "no-factor", 0, 0, 0)); continue
    bars = bars.tail(500)
    factor = factor[factor["trade_date"].isin(bars.index)].reset_index(drop=True)
    additive = loader._fetch_a_share(ak, code, bars.index[0].strftime("%Y-%m-%d"),
                                     bars.index[-1].strftime("%Y-%m-%d"), "1D")
    if additive is None or additive.empty:
        rows.append((code, "em-unreachable", len(bars), int(factor["adj_factor"].nunique()), 0)); continue
    joined = bars[["close"]].join(additive[["close"]], rsuffix="_adj")
    offset = (joined["close_adj"] - joined["close"]).dropna()
    steps = int(factor["adj_factor"].nunique()) - 1
    conv = convert_additive_to_multiplicative(bars[["open","high","low","close","volume"]], additive[["open","high","low","close","volume"]])
    drift = int(offset.nunique())
    rows.append((code, "convertible" if conv is not None else "refused", len(bars), steps, drift))
for r in rows:
    print(r)
PY
```

Expected：打印每只的 `(code, bucket, bars, factor_steps, offset_distinct)`。取前 3 只 `convertible` 作 `SYMBOLS_CONVERTIBLE`（必须含 `600519.SH`；拿不到就换窗口起点，**不许把 refused 塞进等价组**），取第 1 只 `refused` 作 `SYMBOL_REFUSAL`。
**拒绝样本的成因必须实测**：`refused` 且 `offset_distinct` ≥ 20（偏移随价位漂移，即送转 signature）才写进 manifest 作「送转窗口」；`refused` 但 `offset_distinct` < 20 ⇒ 成因未定，manifest 里写 `"refusal_cause": "unclassified"`，用例 docstring 也不许说它是送转。**若 5 只候选凑不出 refused 样本 ⇒ 停下报告**，用合成送转样本代替（Task 6 Step 1 里给形状），不许默默删掉这条断言。

- [ ] **Step 2: 落盘（`vendor` 路径）**

```bash
python -X utf8 - <<'PY'
import sys, json, hashlib; sys.path[:0] = ["agent"]
from pathlib import Path
import akshare as ak
from backtest.loaders.akshare_loader import DataLoader

START, END = "2025-01-01", "2026-10-03"
SELECTED = ["600519.SH", "...", "..."]        # Step 1 实得的 3 只 convertible
REFUSAL = "..."                                # Step 1 实得的 refused 一只
OUT = Path("agent/tests/fixtures/upstream_sync"); OUT.mkdir(parents=True, exist_ok=True)
loader = DataLoader()
manifest = {"captured_at": "2026-10-03", "base_sha": "<HEAD short>", "merge_sha": "<MERGE_SHA short>",
            "window": [START, END], "additive_source": "vendor", "symbols": {}}
for code in SELECTED + [REFUSAL]:
    bars, factor = loader.fetch_raw_with_factor([code], START, END)[code]
    bars = bars.tail(500)
    additive = loader._fetch_a_share(ak, code, bars.index[0].strftime("%Y-%m-%d"),
                                     bars.index[-1].strftime("%Y-%m-%d"), "1D")
    fac = factor[factor["trade_date"].isin(bars.index)].reset_index(drop=True)
    cols = ["open", "high", "low", "close", "volume"]
    bars[cols].to_csv(OUT / f"{code}_raw.csv", index_label="trade_date")
    fac.to_csv(OUT / f"{code}_hfq.csv", index=False)
    additive[cols].to_csv(OUT / f"{code}_qfq.csv", index_label="trade_date")
    offset = (additive["close"] - bars["close"]).dropna()
    manifest["symbols"][code] = {
        "bars": len(bars), "factor_steps": int(fac["adj_factor"].nunique()) - 1,
        "offset_distinct": int(offset.nunique()),
        "bucket": "refusal" if code == REFUSAL else "convertible",
        "first": str(bars.index[0].date()), "last": str(bars.index[-1].date()),
    }
(OUT / "manifest.json").write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(manifest, ensure_ascii=False, indent=2))
PY
```

- [ ] **Step 3: 落盘（`derived` 路径 —— 东财不可达时才走）**

additive 帧由 Sina 因子步长反推：`隐含每股现金红利 d_m = 前收盘 × (1 − f_next/f_prev)`；`additive.close_t = raw.close_t − Σ{d_m : 除权日 e_m > t}`；OHLC 四列同加该偏移，`volume` 取原值。

```python
def build_additive_from_factor(raw: pd.DataFrame, factor: pd.DataFrame) -> pd.DataFrame:
    """Encode the same corporate actions the way an additive vendor serves them.

    ``除权参考价 = 前收盘 × f_next/f_prev`` ⇒ implied cash per share is
    ``d = 前收盘 × (1 − f_next/f_prev)``; an additive 前复权 level is that bar's raw price
    minus every dividend whose ex-date falls AFTER it. The resulting offset is ≤ 0 and
    rises to 0 at the window end — the plateau signature #1541's converter reads.
    """
    f = factor.sort_values("trade_date").reset_index(drop=True)
    divs: list[tuple[pd.Timestamp, float]] = []
    for i in range(1, len(f)):
        prev_f, next_f = float(f["adj_factor"].iloc[i - 1]), float(f["adj_factor"].iloc[i])
        if prev_f <= 0 or next_f <= 0 or next_f >= prev_f:
            continue                      # 只有向下走的因子步才是除权除息
        ex = pd.Timestamp(f["trade_date"].iloc[i])
        prior = raw["close"][raw.index < ex]
        if prior.empty:
            continue
        divs.append((ex, float(prior.iloc[-1]) * (1.0 - next_f / prev_f)))
    out = raw.copy()                       # volume 不变：厂商的 additive 不动成交量
    for col in ("open", "high", "low", "close"):
        remaining = pd.Series(0.0, index=raw.index)
        for ex, amount in divs:
            remaining.loc[raw.index < ex] += amount
        out[col] = raw[col] - remaining
    return out
```

用它生成 `_qfq.csv`，并把 `manifest["additive_source"]` 写成 `"derived"`、每个 symbol 加 `"derived_note": "additive 序列由 Sina hfq-factor 步长反推，非厂商原样回包"`。**落盘前必须先用真数据核对这个反推**：对每只 convertible 票跑 `convert_additive_to_multiplicative(raw, build_additive_from_factor(raw, factor))`，它必须返回非 `None`（返回 `None` 就说明反推错了，用它做等价断言会造一条永远红的用例）。核不上 ⇒ 停下报告，不许改成"预期就是 None"。

- [ ] **Step 4: 体积与「语料不入库」纪律核对**

```bash
du -sh agent/tests/fixtures/upstream_sync
ls agent/tests/fixtures/upstream_sync | wc -l
wc -l agent/tests/fixtures/upstream_sync/*_raw.csv
```

Expected：文件数 = `3×4 + 1 = 13`；入库的是**被断言读的那几份**，取数过程的中间产物（`/tmp` 里的 dump、候选扫描输出）一律不进。CSV 逐行是 `trade_date,open,high,low,close,volume`。若体积 > 2 MB，把窗口从 500 根收到**能覆盖 ≥2 个除权日的最小长度**并重测，不许改用 git-lfs（本机未装）。

- [ ] **Step 5: 提交**

```bash
git add agent/tests/fixtures/upstream_sync
git status --porcelain | head
git commit -s -m "test(sync): 数值层 fixture —— 3 只纯派息可转换窗口 + 1 只拒绝窗口，跨除权日真数据"
```

---

### Task 5: 数值层断言一（G3：两条乘法实现给同一个收益率）

**Files:**
- Create: `agent/tests/test_upstream_sync_calibers.py`（本任务只写等价这一支）
- Modify: 无生产代码

**Interfaces:**
- Consumes: Task 4 的 fixture 与 `manifest.json`；`convert_additive_to_multiplicative(raw, additive) -> DataFrame | None`；`apply_qfq(df, factor) -> DataFrame | None`（`factor` 需列 `trade_date`/`adj_factor`，`df` 需 DatetimeIndex）。
- Produces: 模块常量 `FIXTURES`、`REL_TOL`、`SYMBOLS_CONVERTIBLE`、`_lane_pair(code) -> (lane_factor, lane_additive)`（Task 6 复用同一个 loader 函数，不重复实现读盘）。

- [ ] **Step 1: 先量残差分布，再钉阈值（spec §5.3 硬约束：不许先写死 `1e-9`）**

```bash
python -X utf8 - <<'PY'
import sys; sys.path[:0] = ["agent", "agent/tests"]
from pathlib import Path
import pandas as pd, json
from backtest.loaders.additive_conversion import convert_additive_to_multiplicative
from backtest.loaders.cn_adjust import apply_qfq

FIX = Path("agent/tests/fixtures/upstream_sync")
man = json.loads((FIX / "manifest.json").read_text(encoding="utf-8"))
COLS = ["open", "high", "low", "close", "volume"]
for code, info in man["symbols"].items():
    if info["bucket"] != "convertible":
        continue
    raw = pd.read_csv(FIX / f"{code}_raw.csv", parse_dates=["trade_date"]).set_index("trade_date").sort_index()[COLS]
    fac = pd.read_csv(FIX / f"{code}_hfq.csv", parse_dates=["trade_date"])
    add = pd.read_csv(FIX / f"{code}_qfq.csv", parse_dates=["trade_date"]).set_index("trade_date").sort_index()[COLS]
    lf = apply_qfq(raw, fac); la = convert_additive_to_multiplicative(raw, add)
    assert lf is not None and la is not None, (code, lf is None, la is None)
    r1 = lf["close"].pct_change().dropna(); r2 = la["close"].pct_change().dropna()
    rel = ((r1 - r2).abs() / r1.abs().clip(lower=1e-12))
    print(code, "n=", len(rel), "max=", f"{rel.max():.3e}", "p99=", f"{rel.quantile(0.99):.3e}",
          "median=", f"{rel.median():.3e}")
PY
```

Expected：每只打印 `max` / `p99` / `median` 相对残差。
**钉阈值的规则（写死，不许事后放宽）**：`REL_TOL` = 三个 `max` 里最大的那个**向上取一个数量级**，且必须 `≤ 1e-6`；若 `> 1e-6` ⇒ **不是放阈值，是停下查明细**（大概率是窗口末端锚点日不同，或 derived 编码把 送转 当成现金红利塞进了 additive —— 这两种都是真缺陷，spec §5.3 说得很清楚：阈值要既能放过 2 位小数的舍入、又能抓住一个分红量级的偏差 `≈1e-3`）。把打印出的三个 `max` 与最终 `REL_TOL` 写进 ledger 和用例注释。
**与 Step 2 的对账**：Step 2 骨架里的 `REL_TOL = 1e-10` 已由控制器在 `07b4eb2d` 的实测上预钉。
若 Step 1 打印的最大 `max` 仍是 `1.044e-11` 量级 ⇒ 直接沿用，把三个数写进用例注释即可；若明显不同
（差一个数量级以上）⇒ **不要改阈值去就它**，停下报 BLOCKED：要么盘上 fixture 变了，要么量的面不对。

- [ ] **Step 2: 写失败用例（此时文件里没有实现读取路径，跑起来必红在 import/fixture 缺失或断言）**

```python
"""Cross-implementation price-caliber reconciliation, 2026-10 upstream sync.

Seat: spec §5.3 / G1 G2 G3. Lives in `agent/tests/` on purpose — it needs
pandas, so the fork's pytest-only wiki workflow cannot collect it, while the
upstream `test.yml` step collects this directory through pyproject's
`testpaths = ["agent/tests"]`. That is the collection face this file needs.

Data: committed fixtures (real bars, real ex-dates), never live fetch — see
`fixtures/upstream_sync/manifest.json` for `additive_source`. <vendor|derived>
"""

from __future__ import annotations

import json
from pathlib import Path

import pandas as pd
import pytest

from backtest.loaders.additive_conversion import convert_additive_to_multiplicative
from backtest.loaders.cn_adjust import apply_qfq

FIXTURES = Path(__file__).parent / "fixtures" / "upstream_sync"
COLS = ["open", "high", "low", "close", "volume"]

# Face discipline: this tolerance is pinned from the RETURN-face residual measured by
# Step 1 above, NOT from `manifest.json`'s `reverse_check_max_rel` — those are LEVEL-face
# numbers (~2e-16 here) and they are 5 orders too tight for returns: a 2.3e-13 level gap
# divided by a near-flat day's return (+2.1e-05 on 600519.SH, 2025-07-16) prints 1e-11.
# Step 1's own three maxes, on fixtures as committed at 07b4eb2d: 600519.SH 1.044e-11,
# 000001.SZ 2.631e-13, 601398.SH 1.739e-13. One order above the largest, capped at 1e-6
# by spec §5.3: it must let through 2-decimal vendor rounding over a 500-bar window and
# still catch a dividend-sized error (~1e-3, 7 orders away). Do NOT relax this number to
# make a run pass — a residual above the cap is a defect in one of the two conversions,
# not a tolerance that was set too tightly.
REL_TOL = 1e-10  # 9.6x headroom over 1.044e-11 — one order of magnitude, rounded down

_MANIFEST = json.loads((FIXTURES / "manifest.json").read_text(encoding="utf-8"))
SYMBOLS_CONVERTIBLE = tuple(c for c, v in _MANIFEST["symbols"].items() if v["bucket"] == "convertible")
SYMBOL_REFUSAL = tuple(c for c, v in _MANIFEST["symbols"].items() if v["bucket"] == "refusal")


def _read_csv(path: Path, indexed: bool) -> pd.DataFrame:
    frame = pd.read_csv(path, parse_dates=["trade_date"])
    if indexed:
        frame = frame.set_index("trade_date").sort_index()
    return frame


def _lane_pair(code: str) -> tuple[pd.DataFrame, pd.DataFrame, pd.DataFrame]:
    """Return ``(raw, lane_factor, lane_additive)`` for one committed fixture."""
    raw = _read_csv(FIXTURES / f"{code}_raw.csv", indexed=True)[COLS]
    factor = _read_csv(FIXTURES / f"{code}_hfq.csv", indexed=False)
    additive = _read_csv(FIXTURES / f"{code}_qfq.csv", indexed=True)[COLS]
    lane_factor = apply_qfq(raw, factor)
    lane_additive = convert_additive_to_multiplicative(raw, additive)
    assert lane_factor is not None, f"{code}: apply_qfq returned None on a committed fixture"
    assert lane_additive is not None, f"{code}: the committed convertible window was refused"
    return raw, lane_factor, lane_additive


@pytest.mark.parametrize("code", SYMBOLS_CONVERTIBLE)
def test_the_two_multiplicative_implementations_agree_on_returns(code: str) -> None:
    """A vendor additive platform run through #1541's offset->ratio conversion, and the
    same bars through a published factor table, must produce one return series. Absolute
    levels are not compared (the two anchor at the window end by construction, but vendor
    precision differs); returns are what every downstream metric actually reads."""
    _raw, lane_factor, lane_additive = _lane_pair(code)
    r_factor = lane_factor["close"].pct_change().dropna()
    r_additive = lane_additive["close"].pct_change().dropna()
    pd.testing.assert_index_equal(r_factor.index, r_additive.index)
    assert len(r_factor) >= 200, f"{code}: fixture window too short to mean anything ({len(r_factor)})"
    rel = (r_factor - r_additive).abs() / r_factor.abs().clip(lower=1e-12)
    assert rel.max() <= REL_TOL, (
        f"{code}: max relative return residual {rel.max():.3e} exceeds REL_TOL {REL_TOL:.0e} "
        f"at {rel.idxmax()} — a dividend-scale error, not rounding"
    )
```

- [ ] **Step 3: 跑绿**

Run: `python -X utf8 -m pytest agent/tests/test_upstream_sync_calibers.py -q`
Expected：`3 passed`（convertible 样本数）。**只跑这个文件**，不为此重跑 9 分钟全量套件。

- [ ] **Step 4: 可红性证据 ① —— 改坏一个除权日因子，断言一必须红**

```bash
python -X utf8 - <<'PY'
import hashlib, pathlib, subprocess
p = pathlib.Path("agent/tests/fixtures/upstream_sync/600519.SH_hfq.csv")
ORIG = p.read_bytes(); SHA = hashlib.sha256(ORIG).hexdigest()
try:
    text = p.read_text(encoding="utf-8").splitlines()
    # 第一个因子步所在的行：把 adj_factor 改掉 0.1%，等于抹掉一个分红量级
    head, rows = text[0], text[1:]
    for i, row in enumerate(rows):
        cols = row.split(",")
        if i and cols[-1] != rows[i - 1].split(",")[-1]:
            cols[-1] = f"{float(cols[-1]) * 1.001:.6f}"
            rows[i] = ",".join(cols)
            print("mutated row", i, "->", rows[i]); break
    p.write_text("\n".join([head, *rows]) + "\n", encoding="utf-8")
    r = subprocess.run(["python", "-X", "utf8", "-m", "pytest", "agent/tests/test_upstream_sync_calibers.py",
                        "-q", "-k", "agree_on_returns"], capture_output=True, text=True, encoding="utf-8")
    print("PROBE rc=", r.returncode); print(r.stdout[-1500:])
    assert r.returncode != 0, "a 0.1% factor step change did not move the returns"
finally:
    p.write_bytes(ORIG)
    assert hashlib.sha256(p.read_bytes()).hexdigest() == SHA
print("restored, sha verified")
PY
git status --porcelain
```

Expected：`PROBE rc=1` 且失败消息带 `dividend-scale error`；还原后 `git status --porcelain` 空。
**若 rc=0 ⇒ 这条断言是假绿**（改坏厂商输入却不改变输出），停下 —— 大概率是 fixture 的 `volume`/`close` 读盘路径其实没被喂进转换。

- [ ] **Step 5: 提交**

```bash
git add agent/tests/test_upstream_sync_calibers.py
git commit -s -m "test(sync): 数值层断言一 —— 两条 A 股乘法实现在真数据上给同一个收益率

偏移反推因子（#1541）与厂商因子表是两条独立取数路线，上游用例全是合成小样本、
单实现自证，跨实现零覆盖（G3）。阈值先量残差再钉，不写死也不事后放宽。"
git status --porcelain
```

---

### Task 6: 数值层断言二/三（G1 attrs-first 语义、G2 降级不静默）

**Files:**
- Modify: `agent/tests/test_upstream_sync_calibers.py`（追加用例，不动 Task 5 的部分）
- Modify: `项目档案.md`（G1/G2 的「已交付断言」一行，Task 8 收口时补）

**Interfaces:**
- Consumes: `registry.frame_caliber(frame, source, market=None, symbol=None) -> str`；`registry.price_caliber(...)`；`AkshareLoader.DataLoader().fetch(codes, start, end, interval)`；`src.market_data.fetch_market_data(*, codes, start_date, end_date, source="auto", interval="1D", include_provenance=False, ...)` → `data["_provenance"][code]["adjustment"]`；Task 5 的 `_lane_pair` / `SYMBOL_REFUSAL` / `_read_csv` / `COLS`。
- Produces: 无（终点断言）。

- [ ] **Step 1: 追加断言二（G1）—— attrs 必须打赢静态表**

```python
def test_frame_caliber_prefers_the_frame_stamp_over_the_static_table() -> None:
    """G1: upstream shipped `frame_caliber` and rewired 6 call sites with no test at all
    (`git grep -l frame_caliber upstream/main -- agent/tests` = no matches). The whole
    caliber-honesty argument of the merge rests on the three lines below being reached
    first, so they are now pinned here — including the table value they must beat."""
    converted = pd.DataFrame({"close": [9.0, 10.0]})
    converted.attrs = {"adjustment": "split_dividend"}
    plain = converted.copy()          # copy() carries no attrs: the unconverted shape
    assert "adjustment" not in plain.attrs
    # The static answer for this cell is the OTHER caliber, which is what makes this a
    # real precedence test rather than a tautology.
    assert registry.price_caliber("akshare", "a_share", "600519.SH") == "split_dividend_additive"
    assert registry.frame_caliber(converted, "akshare", "a_share", "600519.SH") == "split_dividend"
    assert registry.frame_caliber(plain, "akshare", "a_share", "600519.SH") == "split_dividend_additive"
    # An empty-string stamp must not be honored: `attrs.get(...) or table` would read the
    # same, `isinstance(...) and adjustment` is what the code actually does.
    blank = pd.DataFrame({"close": [9.0, 10.0]})
    blank.attrs = {"adjustment": ""}
    assert registry.frame_caliber(blank, "akshare", "a_share", "600519.SH") == "split_dividend_additive"
```

同文件顶部补 import：

```python
from backtest.loaders import registry
```

- [ ] **Step 2: 追加断言三（G2）—— 降级与自拒两支都必须「读得出诚实」**

```python
def _serving_frames(monkeypatch, frame: pd.DataFrame) -> dict:
    """Push one pre-stamped frame through the serving layer and read its provenance."""
    from backtest.loaders import akshare_loader as mod
    from src.market_data import fetch_market_data

    class Serving:
        name = "akshare"
        markets = {"a_share"}
        volume_units: dict[str, str] = {}

        def is_available(self):
            return True

        def fetch(self, codes, start, end, interval="1D"):
            return {code: frame for code in codes}

    monkeypatch.setattr(mod, "_ensure_registered", lambda: None, raising=False)
    monkeypatch.setattr(registry, "_ensure_registered", lambda: None)
    monkeypatch.setattr(registry, "LOADER_REGISTRY", {"akshare": Serving})
    monkeypatch.setattr(registry, "FALLBACK_CHAINS", {"a_share": ["akshare"]})
    out = fetch_market_data(codes=["600519.SH"], start_date="2025-01-01", end_date="2025-06-30",
                            source="akshare", include_provenance=True)
    return out["_provenance"]["600519.SH"]


def test_converted_frame_leaves_with_the_multiplicative_label(monkeypatch) -> None:
    _raw, _lf, lane_additive = _lane_pair("600519.SH")
    stamped = lane_additive.copy()
    stamped.attrs = {"adjustment": "split_dividend"}
    prov = _serving_frames(monkeypatch, stamped)
    assert prov["adjustment"] == "split_dividend"
    assert prov["adjustment"] != registry.price_caliber("akshare", "a_share", "600519.SH")


def test_unstamped_additive_leaves_with_the_additive_label(monkeypatch) -> None:
    """The degrade/self-refusal seat G2 names: upstream asserts the additive series passes
    through untouched, nobody asserted what the served caliber says about it. Without this
    line a one-cell edit to the static table turns a silent downgrade into a false label."""
    raw, _lf, additive = _lane_pair("600519.SH")
    prov = _serving_frames(monkeypatch, additive)          # no attrs at all
    assert "adjustment" not in prov or prov["adjustment"] == "split_dividend_additive"
    assert prov["adjustment"] == "split_dividend_additive"


@pytest.mark.parametrize("code", SYMBOL_REFUSAL)
def test_a_refused_window_is_not_relabeled(code: str, monkeypatch) -> None:
    """`convert_additive_to_multiplicative` refuses the committed window at ONE named branch.
    Which branch matters: bare `assert refused is None` is satisfied by eight
    `return None` paths (`additive_conversion.py:117,119,125,130,149,153,159,168` — `:138`
    would be a ninth but it cannot fire, see the paragraph below), so
    loosening the guard under test would still leave this green. The committed `000651.SZ`
    window refuses at the plateau-shape guard (`:128-130`, `_plateau_spans(offset) is None`)
    because its last plateau is ONE bar — NOT because a 送转 crosses it. So the docstring
    must not claim 送转, and must not claim the drift branch is covered elsewhere either:
    `:136-138` is an unreachable guard. `_plateau_spans` returns a span list only after its
    edge/unc fold loop at `:86-89` has refused every window that still holds a one-bar
    plateau, so any list reaching `:136` has `single_bar_spans == 0` and `:137` is
    perpetually false (controller re-measure at 95e65087: 4000 randomized offset shapes plus
    an exhaustive 55,980-case sweep over all integer offsets of length 2..6 on a 6-symbol
    alphabet, zero surviving one-bar plateaus; the four hand-built drift shapes all came
    back `_plateau_spans(...) is None`). Upstream's own
    `test_additive_conversion.py:137 test_non_plateau_offsets_fail_closed` (`[95.0, 95.5,
    96.0, 96.5]`) does refuse, but through that same `:86-89 -> :128-130` route, so the
    `:138` line is covered by NEITHER file. Register that as an upstream reachability gap in
    `项目档案.md` (Task 8); do not fix upstream code here. Refusing is only correct
    if the label then says additive — refusal and stamp are checked together or a loosened
    refusal rule turns into a mislabel with clean numbers."""
    import akshare as _ak  # noqa: F401  (fixture path needs no vendor import; kept explicit)
    from backtest.loaders.additive_conversion import _plateau_spans
    raw = _read_csv(FIXTURES / f"{code}_raw.csv", indexed=True)[COLS]
    additive = _read_csv(FIXTURES / f"{code}_qfq.csv", indexed=True)[COLS]
    offset = (additive["close"] - raw["close"]).astype(float)
    assert _plateau_spans(offset) is None, (
        f"{code}: the offset series no longer trips the plateau-shape guard — the refusal "
        f"sample drifted, and this test is now asserting a different branch than it names")
    refused = convert_additive_to_multiplicative(raw, additive)
    assert refused is None, f"{code}: the committed refusal window converted — bucket drifted"
    prov = _serving_frames(monkeypatch, additive)
    assert prov["adjustment"] == "split_dividend_additive"


def test_companion_fetch_failure_degrades_loudly_and_stays_additive(monkeypatch, caplog) -> None:
    """Loader-level seat: the real #1541 branch, fed with committed bars, companion forced
    to fail. Three things at once — no attrs written, additive-caliber out the door, and a
    warning in the log. Any one alone is satisfiable by accident."""
    import logging

    from backtest.loaders import akshare_loader as mod

    raw, _lf, additive = _lane_pair("600519.SH")

    def fake_cached(*, source, symbol, timeframe, start_date, end_date, fields, fetch):
        if fields == ["raw"]:
            raise RuntimeError("probe: raw companion unavailable")
        return additive.copy()

    monkeypatch.setattr(mod, "cached_loader_fetch", fake_cached)
    with caplog.at_level(logging.WARNING, logger="backtest.loaders.akshare_loader"):
        out = mod.DataLoader().fetch(["600519.SH"], "2025-01-01", "2025-06-30")
    frame = out["600519.SH"]
    assert frame is not None and not frame.empty
    assert "adjustment" not in frame.attrs
    assert registry.frame_caliber(frame, "akshare", "a_share", "600519.SH") == "split_dividend_additive"
    assert "serving additive" in caplog.text, caplog.text


def test_companion_success_stamps_multiplicative(monkeypatch) -> None:
    """Same branch, companion served: the real fixture conversion, not a synthetic frame."""
    from backtest.loaders import akshare_loader as mod

    raw, _lf, additive = _lane_pair("600519.SH")

    def fake_cached(*, source, symbol, timeframe, start_date, end_date, fields, fetch):
        return raw.copy() if fields == ["raw"] else additive.copy()

    monkeypatch.setattr(mod, "cached_loader_fetch", fake_cached)
    out = mod.DataLoader().fetch(["600519.SH"], "2025-01-01", "2025-06-30")
    frame = out["600519.SH"]
    assert frame.attrs["adjustment"] == "split_dividend"
    assert registry.frame_caliber(frame, "akshare", "a_share", "600519.SH") == "split_dividend"
```

顶部再补 `import pytest` 已有；`SYMBOL_REFUSAL` 已在 Task 5 定义。
**窗口日期**必须与 fixture 实际覆盖区间一致（`manifest.json` 的 `first`/`last`）；上面写的 `2025-01-01 … 2025-06-30` 若与 fixture 不符，**改成 fixture 的真区间**，因为 `_is_a_share` / 分支不依赖日期，但断言的诚实性依赖「样本 = 被断言的那段数据」。

Run: `python -X utf8 -m pytest agent/tests/test_upstream_sync_calibers.py -q`
Expected：全绿（Task 5 的 3 条 + 本步 6 条）。**若 `_serving_frames` 里 `_ensure_registered` 名称或 `Serving` 属性对不上**，读 `agent/src/market_data.py` 的 `_fetch_via_chain` 与 `registry` 的注册函数名再改测试替身，**不许改生产代码去迁就测试**。

- [ ] **Step 3: 可红性证据 ② —— 删掉 `frame_caliber` 读 attrs 的那三行，断言二必须红（植入面是上游文件，还原后不留改动）**

```bash
python -X utf8 - <<'PY'
import hashlib, pathlib, subprocess
p = pathlib.Path("agent/backtest/loaders/registry.py")
NEEDLE = '''    attrs = getattr(frame, "attrs", None)
    adjustment = attrs.get("adjustment") if isinstance(attrs, dict) else None
    if isinstance(adjustment, str) and adjustment:
        return adjustment
'''
ORIG = p.read_bytes(); SHA = hashlib.sha256(ORIG).hexdigest()
try:
    text = p.read_text(encoding="utf-8")
    assert text.count(NEEDLE) == 1, text.count(NEEDLE)
    p.write_text(text.replace(NEEDLE, ""), encoding="utf-8")
    r = subprocess.run(["python", "-X", "utf8", "-m", "pytest", "agent/tests/test_upstream_sync_calibers.py",
                        "-q", "-k", "prefers_the_frame_stamp or leaves_with_the_multiplicative"],
                       capture_output=True, text=True, encoding="utf-8")
    print("PROBE rc=", r.returncode); print(r.stdout[-1500:])
    assert r.returncode != 0, "frame_caliber kept honoring attrs after the read was deleted"
finally:
    p.write_bytes(ORIG)
    assert hashlib.sha256(p.read_bytes()).hexdigest() == SHA
print("restored, sha verified")
PY
git status --porcelain
```

Expected：`PROBE rc=1`；还原后工作树空。**这条探针植入的是上游文件**，所以收尾必须显式验证 `git status --porcelain` 空 —— 在 `sync/upstream-2026-10` 上留一处上游文件改动就是破了 Global Constraints。

- [ ] **Step 4: 可红性证据 ③ —— 强制转换失败，降级支必须红**

改**自己的测试文件**（不碰上游）：临时把 `test_companion_success_stamps_multiplicative` 里的 `fake_cached` 返回值改成 `if fields == ["raw"]: raise RuntimeError`，跑 `-k companion_success`，必须 rc=1；`finally` 还原字节并 sha256 校验。把 rc 与失败行留在 ledger。

- [ ] **Step 5: 只跑本文件确认全绿，然后提交**

```bash
python -X utf8 -m pytest agent/tests/test_upstream_sync_calibers.py -q
git add agent/tests/test_upstream_sync_calibers.py
git commit -s -m "test(sync): 数值层断言二/三 —— attrs 优先语义与降级/自拒的出门读数

G1：上游带 frame_caliber 与 6 个调用点，零测试。G2：上游只断加法序列原样穿过，
没人断 adjustment 字段。两条各配一次植入证据 —— ② 植的是上游文件，字节还原 +
sha256 校验，树上不留改动。"
git status --porcelain
```

---

### Task 7: Wiki 水位重钉（两文件动作 ＋ 四处 `445` 针脚同调）

**Files:**
- Modify: `tools/wiki_freshness_gate.sh:16`（`LIMIT="${WIKI_STALE_MAX:-<N>}"`）与 `:5` 的 prose 读数
- Modify: `.github/workflows/repowiki-freshness.yml:75`（`WIKI_STALE_MAX: '<N>'`）
- Modify: `tools/test_wiki_drift.py:4811`（正则 `:-445}`）、`:4813`（`${WIKI_STALE_MAX:-445}` 字面量）、`:5044` 附近的工作流断言、`:5036` 的 prose「The other 445 pins」（**坐标更正，Task 7 实读**：原写 `:5034` 偏两行，`:5034` 实为同一条 docstring 上一句 `env:` value 的结尾；spec §7.2 的 `:4811-4813` ＋ `:5031`/`:5044` 本来就是对的）
- Modify: `repowiki/README.md:234`（运维口径里的那个数）

**Interfaces:**
- Consumes: `python -X utf8 tools/wiki_drift.py stale --format count` 的实测读数。
- Produces: 新水位 `N` 与「重钉是两文件动作」的完整取证（Task 8 档案段引用）。

- [ ] **Step 1: 取新水位**

```bash
python -X utf8 tools/wiki_drift.py stale --format count
```

Expected：一个整数 `N`。spec §7.1：`N` 只会往 450 方向走（HEAD 前移 ⇒ `tree_baseline()` 众数回落点变新）。
- `N ≤ 445` ⇒ 门本来就绿，**不改任何数**，跳过 Step 2~5，直接 Step 6 记录「本轮无需重钉，读数 `<N>` @ `<SHA>`」。**记录必须带上天花板说明**：Task 1 实测合并前后都是 445，而 445 距全树 450 只差 5 页 ⇒ 这个数「没变」是**接近天花板**、不是「上游改动与 Wiki 无关」的证据；判据形状是 `tools/wiki_freshness_gate.sh:33` 的 `[ "$STALE" -gt "$LIMIT" ]`（严格大于 ⇒ 445 恰好不红，450 必红）。下一次任何 HEAD 前移都可能把它推到 450，那时本分支的结论作废、按 `N == 450` 分支走。
- `N > 445` ⇒ 继续。
- `N == 450`（全树皆 stale）⇒ **接受门红着等 M5**，把读数与决定写进档案，不改判据形状、不放宽阈值消音（spec §7.3）。

- [ ] **Step 2: 同时改两处数**

```bash
NEW=450   # 换成 Step 1 的实得 N
sed -i "s/\${WIKI_STALE_MAX:-445}/\${WIKI_STALE_MAX:-$NEW}/" tools/wiki_freshness_gate.sh
sed -i "s/WIKI_STALE_MAX: '445'/WIKI_STALE_MAX: '$NEW'/" .github/workflows/repowiki-freshness.yml
grep -n "WIKI_STALE_MAX" tools/wiki_freshness_gate.sh .github/workflows/repowiki-freshness.yml
```

Expected：脚本只剩一处 `${WIKI_STALE_MAX:-<N>}`，工作流只剩一处 `WIKI_STALE_MAX: '<N>'`。

- [ ] **Step 3: 同调四处针脚（行号不变、只换数字；总行数不许动）**

```bash
sed -i "s/WIKI_STALE_MAX:-445/WIKI_STALE_MAX:-$NEW/g" tools/test_wiki_drift.py
sed -i 's/WIKI_STALE_MAX: '"'"'445'"'"'/WIKI_STALE_MAX: '"'"'$NEW'"'"'/' tools/test_wiki_drift.py
grep -n "445" tools/test_wiki_drift.py tools/wiki_freshness_gate.sh repowiki/README.md | head -20
```

Expected：第一条改到 `:4811` 正则与 `:4813` 字面量（两处同形，一起换）；第二条改到 `:5044` 的工作流断言；第三条打印**剩下的 445 全是历史散文读数**（档案里带坐标的旧读数**不改**，那是历史；`repowiki/README.md:234` 的运维现值要改成新数）。若 `grep` 显示某处 prose 把「当前水位」说成 445（而非历史读数），一并改并保留其坐标说明。

- [ ] **Step 4: 门与针脚用例双向验证**

```bash
bash tools/wiki_freshness_gate.sh; echo "gate rc=$?"
python -X utf8 -m pytest tools/test_wiki_drift.py -q -k "water_level or freshness_gate or workflow"
python -X utf8 -m pytest tools/test_wiki_drift.py -q -m "not local_archive"
```

Expected：`gate rc=0`；三条相关用例绿；整套绿（既有 22 项基线红不在 `tools/`，`tools/` 侧应全绿）。

- [ ] **Step 5: 可红性证据 —— 只改一处必须让另一处报警**

```bash
python -X utf8 - <<'PY'
import hashlib, pathlib, subprocess
files = [pathlib.Path("tools/wiki_freshness_gate.sh"), pathlib.Path(".github/workflows/repowiki-freshness.yml")]
backup = {f: f.read_bytes() for f in files}
sha = {f: hashlib.sha256(f.read_bytes()).hexdigest() for f in files}
try:
    # 只把脚本的 fallback 挪走，工作流不动：钉 fallback 的那条用例必须红
    f = files[0]; t = f.read_text(encoding="utf-8")
    import re, os
    new = re.sub(r"\$\{WIKI_STALE_MAX:-\d+\}", "${WIKI_STALE_MAX:-999999}", t)
    assert new != t
    f.write_text(new, encoding="utf-8")
    r = subprocess.run(["python", "-X", "utf8", "-m", "pytest", "tools/test_wiki_drift.py", "-q",
                        "-k", "freshness_gate"], capture_output=True, text=True, encoding="utf-8")
    print("PROBE rc=", r.returncode); print(r.stdout[-800:])
finally:
    for k, v in backup.items():
        k.write_bytes(v)
    for k, v in sha.items():
        assert hashlib.sha256(k.read_bytes()).hexdigest() == v
print("restored")
PY
git status --porcelain
```

Expected：`PROBE rc=1`（钉 `${WIKI_STALE_MAX:-N}` 字面量的那条红了）—— 这就是「改一处必红一条」的现行担保形状。**同时登记一条限制**：没有任何用例断两处数字**相等**（`项目档案.md` 残项 6 的全分支评审补记早已写明），所以本探针只证「单侧改动可被看见」，不谎称「两侧不一致会红」。这条跨文件相等断言属 M4 代码轮的候选，不在本轮做。

- [ ] **Step 6: `index --check` 实测仍绿（spec §7.4：这条要测不要推）**

```bash
python -X utf8 tools/wiki_drift.py index --check; echo "index rc=$?"
wc -c repowiki/INDEX.md
```

Expected：rc=0；字节数 48301（若变了，说明上游动了 `repowiki/` 树 —— 本轮预期不动，变了就停下查明）。

- [ ] **Step 7: 提交**

```bash
git add tools/wiki_freshness_gate.sh .github/workflows/repowiki-freshness.yml tools/test_wiki_drift.py repowiki/README.md
git commit -s -m "ci(wiki): 同步后水位重钉 <旧>→<新> —— 脚本 fallback 与工作流 override 同调，四处针脚跟着走

门禁的语义就是「水位变了要人来重钉」，它红不是回归。重钉取的是重测读数，
不是「够让门绿的数 +1」。"
git status --porcelain
```

---

### Task 8: 收口 —— 全量套件归类、DoD 七条核对、档案落档

**Files:**
- Modify: `项目档案.md`（同步轮台账段：验收读数、探针台账、遗留登记）
- 无代码改动

**Interfaces:**
- Consumes: Task 1 的前后读数、Task 2 的锚点计数、Task 3/4 的裁定与 fixture 清单、Task 5/6 的三次植入、Task 7 的新水位。
- Produces: 下一轮同步可复用的闸门（两个新测试文件 + 一份档案台账）。

- [ ] **Step 1: 先定点跑两边的关键用例，再跑全量（约 9 分钟）并逐条归类**

spec §5.2 点名的两组文件先单独跑一遍 —— 全量绿不掩盖"某一支根本没被收集"：

```bash
python -X utf8 -m pytest agent/tests/test_additive_conversion.py agent/tests/test_loader_health.py agent/tests/test_southbound_tool.py agent/tests/test_report_audit_accounting_parens.py agent/tests/test_validation_initial_capital.py agent/tests/test_agent_loop_strategy_provenance.py agent/tests/test_grounding_registry.py -q
python -X utf8 -m pytest agent/tests/test_price_caliber.py agent/tests/test_market_data_serving_source.py agent/tests/test_get_market_data_provenance.py agent/tests/test_sina_loader.py agent/tests/test_fetch_sina_penalties.py agent/tests/test_dropped_target_adjustments.py agent/tests/test_warehouse_akshare_source.py agent/tests/test_warehouse_loader.py agent/tests/test_registry.py -q
```

Expected：两组各自全绿（第一组 = 上游 7 个新测试文件里的 6 个 + `test_loader_health`；第二组 = 口径与数据源面，含 `("akshare","a_share")` 那一格的既有断言）。**若某条 `ERROR: file or directory not found`，说明上游这次没带它 —— 记进档案，别改命令去凑。**

```bash
python -X utf8 -m pytest -q 2>&1 | tail -40
```

Expected：与基线 **11 failed / 11 errors** 对比，逐条按成因归类：能对上 `WinError 1314`（无符号链接特权）/ 并发 `PermissionError(13)` / 时钟时限的记为**既有环境红**；对不上的单列「本轮新增红」并**停下修**，不许并进结论文字（spec §5.2）。归类表写进 ledger，条数与短 sha 一起记。

- [ ] **Step 2: 门禁面收口**

```bash
python -X utf8 -m pytest tools/test_wiki_drift.py -q -k upstream_owned 2>&1 | tail -3
bash tools/ci_grep_gates.sh > /tmp/gates_final.txt 2>&1; echo "rc=$?"
sed -E 's/\b[0-9a-f]{6,40}\b/SHA/g' /tmp/gates_final.txt > /tmp/gates_final_norm.txt
diff /tmp/gates_before_norm.txt /tmp/gates_final_norm.txt && echo "gates identical to pre-merge"
```

Expected：`upstream_owned` 仍 1 条绿（**它证明本轮没动四前缀**，是本计划唯一的既有门禁能直接复用的「零上游改动」证据）；`ci_grep_gates.sh` 剥 sha 后与合并前 diff 为空。
**若 gates 输出多了行**：多半是新 fixture 或守卫文件触了品牌/敏感词针脚 —— 改**自己的**文件措辞，绝不改 `tools/ci_grep_gates.sh`（上游文件）。

- [ ] **Step 3: DoD 七条逐条实测（spec §8），每条给命令与读数，不许打勾了事**

```bash
git log --oneline --first-parent -8
git log --merges --oneline upstream/main..HEAD | wc -l      # 期望 1（只有那一个 merge 提交）
git diff --name-only HEAD...upstream/main -- .gitignore tools/ci_grep_gates.sh .github/workflows/test.yml wiki/ | wc -l
python -X utf8 -m pytest agent/tests/test_upstream_sync_calibers.py tools/test_upstream_sync.py -q
bash tools/wiki_freshness_gate.sh; echo "gate rc=$?"
git status --porcelain
```

Expected：merge 提交恰 1；四前缀 0；两个新测试文件全绿；`gate rc=0`；工作树空。DoD 第 5 条（§6 裁定落档）核对 Task 3 的档案段是否存在；DoD 第 6 条核对 Task 7 的数与档案/README 里的数一致。

- [ ] **Step 4: 档案落档（追加，不重排既有行）**

在 Task 3 那段「上游同步轮」下续写：

```markdown
- **文本层**：`tools/test_upstream_sync.py` <n> 条用例，锚点 <total> 条（ours <a> / theirs <b>），
  `NO_ANCHORS` 声明 <k> 处（各带理由）。植入证据 ①：把 ours 的 `fetch_raw_with_factor` 改名
  ⇒ rc=1；收集面证据：工作流那行改回单路径后 `--collect-only -k upstream_sync` 命中 <读数>。
- **数值层**：残差实测 max = <三只 convertible 的 max>，`REL_TOL` 钉 <值>；植入证据 ②（删
  `frame_caliber` 读 attrs 的三行，**上游文件、字节还原**）⇒ rc=1；③（强制伴侣失败）⇒ rc=1。
  跨文件相等断言（水位 445 那类同形缺口）**本轮刻意不做**，理由同 Task 7 Step 5 的登记。
- **门禁面**：合并前后 `ci_grep_gates.sh` 剥短 sha 后 diff 为空；`-k upstream_owned` 前后均 1 条绿。
- **水位**：<旧> → <新>（`stale --format count` 实测），`index --check` rc=<值>，`INDEX.md` <字节>。
- **全量套件**：`<passed> / <skipped> / <failed> / <errors>` @ `<SHA>`，与 22 项基线逐条对上的
  <n> 条记既有环境红，新增红 <n 条或「零」>。
- **零上游文件改动**：本轮无豁免（spec §3.1 撤销了初版的两处豁免申请）。探针 ② 临时植上游
  文件但按 sha256 还原，树上零残留 —— 由 Step 3 的 `git status --porcelain` 空与四前缀 0 行共同撑。
- **散文欠账增量（spec §7.5，本轮只登记不补文档）**：`report --json` 的 `uncovered` 由 1382 → <实测新读数>；
  上游带来的 4 个新生产模块（`additive_conversion`、`southbound_tool`、`grounding/registry`、
  `grounding/identity_checks`）无对应 topic 页 ⇒ 转 M5 名单（任务 #16），并附 `refs_broken` 的新读数。

  ```bash
  python -X utf8 tools/wiki_drift.py report --json 2>/dev/null | python -X utf8 -c "import json,sys; d=json.load(sys.stdin); print({k: d[k] for k in ('uncovered','refs_broken','partial','ledger_void','count') if k in d})"
  ```

- **交付的永久闸门**：以后每次同步跑 `pytest tools/test_upstream_sync.py agent/tests/test_upstream_sync_calibers.py -q`
  即可复用；锚点表随每次同步重抓（`MERGE_BASE` 与 `ANCHORS` 一起更新）。
```

- [ ] **Step 5: 提交**

```bash
git add 项目档案.md
git commit -s -m "docs(档案): 同步轮收口台账 —— 三层验收读数、三次植入证据与遗留登记"
git status --porcelain
```

- [ ] **Step 6: 交给用户裁定集成方式（不自动 merge、不 push）**

按 `superpowers:finishing-a-development-branch`：报告全量套件读数（含失败逐条归类），原样给三选一菜单（① 本地合并回 `main`；② 推送建 PR；③ 保持分支现状），**并显式提醒**：spec §4 约定「三层验收全绿才快进 `main`」，而 `main` 目前领先 `origin/main` 74 个提交、M3 轮的集成菜单也还悬着 —— 两个决定会叠加，请一并裁定。

---

## 自检（写完后逐条核过）

**Spec 覆盖**：§4 底座→Task 1；§5.1 文本层→Task 2（含收集面与两件可红证据）；§5.2 测试层→Task 1 Step 2/5 + Task 8 Step 1/2；§5.3 数值层→Task 4/5/6（含三条断言与三处植入）；§6 裁定→Task 3（两个结局都落档、零上游改动）；§7 Wiki 连带→Task 7（含 §7.3 不放宽阈值、§7.4 实测 `index --check`、§7.5 欠账增量在 Task 8 登记）；§8 DoD→Task 8 Step 3；§10 两条硬约束（三层各自独立「先弄红」步、测量步排在改动前）→ 分别由 Task 2/5/6 的独立探针步与 Task 3 排在 Task 4/5 之前满足。
**未覆盖并已在计划内说明的**：`uncovered` 1382 的增量（spec §7.5 只要「登记」）落在 Task 8 Step 4 的档案段；4 个新生产模块的文档按 §1 非目标不补。
**类型一致性**：`frame_caliber(frame, source, market=None, symbol=None)`、`price_caliber(source, market=None, symbol=None)`、`apply_qfq(df, factor)`、`convert_additive_to_multiplicative(raw, additive)`、`fetch_raw_with_factor(codes, start, end, *, interval="1D")`、`fetch_market_data(*, codes, start_date, end_date, source, interval, include_provenance, ...)` 均按合并态实测签名书写；fixture 列名 `trade_date/open/high/low/close/volume` 与 `adj_factor` 对齐 `_normalize` 与 `apply_qfq` 的实际读取。
**无占位符**：所有 `<...>` 都是**实测槽位**（读数、实得样本、实得计数），每处都写明取数命令与失败时的处置（停下 / 换窗口 / 不放宽阈值），没有 TBD 型空白。
