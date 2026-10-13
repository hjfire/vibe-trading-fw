# REA 取证骨架＋第一批观察面（P0＋P1）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把设计文档里的五级漏斗（L0 观察 → L1 规格 → L2 差距）变成**机器可校验的取证骨架**，并用它先跑通一次本地闭环（P0），再跑一次对 tradingview.com 的真实观察批次（P1）。

**Architecture:** 三份 markdown 约定（L0 证据记录／规格条目表／差距矩阵）由一个纯标准库校验器 `tools/forensics_audit.py` 强制执行——「写不出判据的条目不算条目」这句话只有变成 rc 才是纪律。取证数据面只有 REA 的 loopback CDP 单趟命令可用（证据留在 stdout，由执行者逐字摘录进仓库内 markdown），所以骨架的第一原则是**校验器不读 REA 的原始输出文件，只读我们抄下来的那几行键值**。对外部站点的合规红线同样进校验器：`frontend/src` 里含 `tradingview.com` 的文件集合必须**恰好等于**现有白名单。

**Tech Stack:** Python 3.11 标准库（`hashlib`/`re`/`pathlib`）＋ pytest（`tools/` 套件）＋ Node 22.16 下的 `npx -y rea-agents@latest`（不装依赖）＋ Edge 155 headless CDP ＋ Markdown。

**Spec:** `docs/superpowers/specs/2026-10-13-rea-tradingview-replica-design.md`（执行时与本文件**同时**读；两者冲突以 spec 为准）

**Branch:** 继续在 `feat/multi-chart-scripts` 上做（设计文档 `92e49213` 就在这条分支上）。合回 `main`／推 `origin` 都是要用户点头的动作，本计划不含。

---

## Global Constraints

每一条对所有任务生效，逐字来自 spec 或本仓既有纪律：

1. **面向用户的文字用中文**；代码、命令、报错原文保留原文。
2. **改动严格限定在项目范围内**：不跑 `rea setup`，不注册 REA 的 MCP server，不装任何依赖，不改 `package.json`／`pyproject.toml`／全局 git 配置／Node／Python／pnpm／uv／`.pnpm-store`／SQLite。`npx -y rea-agents@latest` 只往 `~/.npm/_npx` 写缓存，不落项目文件——这是设计轮已实测并被接受的用法。
3. **证据只走 stdout**（spec §2.4）：本机上一切吃磁盘路径的 REA 命令都坏（`export-web-scripts`／`inspect-evidence-bundle`／`compare-web-captures` 报 `ESTALE`；`analyze-javascript-application` 目录模式报 `integrity_mismatch`）。因此 L0 记录＝命令原文＋stdout 里**逐字摘录的关键块**，不许假装工具替你存了文件。
4. **合规三条硬线**（spec 裁定 1）：产出只能是规格＋证据；实现不引用 TradingView 代码；TradingView 接口不作为运行时依赖。UI 文案一律自拟，表达层不搬。
5. **`docs/` 被 `.gitignore:125` 整目录忽略** ⇒ 每次加 `docs/**` 都要 `git add -f`。历次 spec/plan 都是这么提交的。
6. **提交一律 `-s`（DCO）且带 pathspec**：`git commit -s -m "…" -- <路径>`。工作树上一直有别人的在途改动（本计划开头实测为 `frontend/public/usage-guide.md`、`frontend/src/lib/__tests__/chartDrawings.test.ts`、`frontend/src/lib/chartDrawings.ts`），裸 `git commit` 会把它们吞进来。
7. **一次一面**：一份 L0 只对应一条 REA 命令、一个观察面。混面捕的证据在 L1 拆不干净（spec §5 工单使用规则）。
8. **每条命令必带 `--filter-output` 或 `--token-limit`**：内存常剩 2GB。排障时可以先去掉 `--token-limit`——它会把错误对象的 `details` 一起截掉（spec §2.5 实测）。
9. **基线数字当场复测**：spec §8 里 vitest 的「141 files / 2336 passed」是上一片交付态读数，不许当本片判据引用。
10. **CI 面暂不动**：把 `tools/test_forensics_spec.py` 加进 `.github/workflows/repowiki-freshness.yml:85` 的硬步骤属工作流变更，列入需用户点头项；本片只在本地显式跑。
11. **第一次对 tradingview.com 实抓要先报打算抓哪几面**（spec §9 第 4 条）——这是 Task 7 的停等点，不是可跳过的步骤。

## 六道门（每片末尾复跑，一条不加一条不减）

```bash
cd frontend && npx tsc -b
cd frontend && npx vitest run
cd frontend && npm run build
python -X utf8 -m pytest tools/test_wiki_drift.py tools/test_wiki_qmind.py -q
bash tools/wiki_freshness_gate.sh
bash tools/ci_grep_gates.sh
```

最后两条**本地恒红是已知状态**（水位阈值／命中在未跟踪忽略目录）。要证的是「本片 0 贡献」，不是调阈值。本片额外显式跑一条（不进 CI）：

```bash
python -X utf8 -m pytest tools/test_forensics_spec.py -q
python -X utf8 tools/forensics_audit.py
```

`tools/test_*.py` 不在 `pyproject.toml:289` 的 `testpaths = ["agent/tests"]` 里 ⇒ 裸 `pytest` 收集不到它，必须显式给路径。

## 文件布局（本计划建立的全部结构）

| 路径 | 职责 | 建立于 |
|---|---|---|
| `tools/forensics_audit.py` | 校验器：三份约定＋TV 主机红线，纯标准库，有违规即 rc=1 | T1–T4 |
| `tools/test_forensics_spec.py` | 校验器测试：`tmp_path` 合成树证明判别力 ＋ 活树实跑 | T1–T6 |
| `tools/rea_probe_site/index.html` | 本地中立探针页（自研三文件，不含任何第三方内容） | T5 |
| `tools/rea_probe_site/app.js` | ES module：`class ChartEngine`＋`fetch("/data.json")`＋`pointerdown` 监听 | T5 |
| `tools/rea_probe_site/data.json` | 12 根小数据，让端点面有东西可报 | T5 |
| `docs/forensics/README.md` | 三份约定的规范文本＋怎么跑校验器＋怎么起一趟取证 | T5 |
| `docs/forensics/_templates/{l0-capture,spec-entry,gap-matrix}.md` | 三份模板；`_templates/` 不被校验器走查 | T5 |
| `docs/forensics/l0/<face>.md` | 一面一份 L0 记录 | T5（harness×3）、T8（TV×N） |
| `docs/forensics/spec/<face>.md` | 一面一份规格条目表 | T9 |
| `docs/forensics/gap-matrix.md` | 差距矩阵：一条规格一行 | T10 |
| `docs/forensics/{l0,spec}/_example.md` | P0 的「一条能被测试打的规格条目」，校验器按**精确文件名**豁免 | T6 |
| `docs/forensics/batch-A-playbook.md` | P1 抓取批次清单（也是停等点要给人读的东西） | T7 |

## 任务顺序与依赖

```
T1 L0 规则 ─┐
T2 规格规则 ─┼─→ T3 矩阵与交叉规则 ─→ T4 TV 主机红线 ─→ T5 骨架＋探针闭环
                                                          │
                              T6 P0 收口（_example 条目）─┘
                                        │
                    T7 批次清单＋【停等用户点头】
                                        │
              T8 抓 TV → L0 ─→ T9 L1 规格 ─→ T10 L2 差距矩阵 ─→ T11 六道门＋落档
```

T1–T3 严格串行（同一模块增量）。T4 独立于 `docs/forensics/`，可与 T2/T3 并行。T8–T10 串行，且 T8 之前必须过 T7 的闸。

---

### Task 1: 校验器骨架与 L0 记录规则

**Files:**
- Create: `tools/forensics_audit.py`
- Test: `tools/test_forensics_spec.py`

**Interfaces:**
- Consumes: 无（本任务是起点）
- Produces:
  - `L0_REQUIRED_KEYS: tuple[str, ...]`、`L0_PURPOSES: tuple[str, ...]`、`L0_EXEMPT: frozenset[str]`、`SPEC_EXEMPT: frozenset[str]`
  - `_outside_fences(text: str) -> list[str]`
  - `_meta_keys(text: str) -> dict[str, str]`
  - `_read(path: Path) -> str`
  - `_audit_l0(path: Path, rel: str, repo_root: Path) -> tuple[list[str], str | None]`（违规列表＋该文件声明的 `用途`）
  - `audit_forensics(forensics_root: Path, repo_root: Path) -> list[str]`（本任务先只实现 l0 部分，T2/T3 扩）
  - `main(repo_root: Path) -> int`

- [ ] **Step 1: 写失败的测试——L0 的六把键与它们的失败模式**

创建 `tools/test_forensics_spec.py`：

```python
"""Contract tests for tools/forensics_audit.py.

Two failure directions matter here. A tree that is merely *missing* must skip
loudly (the skeleton is created in a later task, so "not yet" is a real state);
a tree that exists but is malformed must fail. The synthetic tmp_path trees
prove the auditor actually discriminates — a green run over an empty directory
would prove nothing at all.

Run with::

    pytest tools/test_forensics_spec.py -q
"""

from __future__ import annotations

import hashlib
from pathlib import Path

import pytest

from forensics_audit import (  # type: ignore[import-untyped]
    L0_PURPOSES,
    L0_REQUIRED_KEYS,
    _audit_l0,
    _meta_keys,
    _outside_fences,
    audit_forensics,
)

EVID = "ev_" + "ab" * 32  # ev_ + 64 个十六进制字符

L0_BODY = f"""# L0：探针页面骨架

- 命令：npx -y rea-agents@latest inspect-web-page http://127.0.0.1:9222 TID1 --filter-output normalized_result
- evidence_id：{EVID}
- 浏览器：Edg/155.0.4283.45（protocol_version 1.3）
- 目标 URL：http://127.0.0.1:8077/
- 观察条件：headless=new；未点开任何菜单；未禁用优化
- 完整性：completeness.status=parsed；parse_failures 未出现

```json
"completeness": {{"status": "parsed"}}
```
"""


def _mk(base: Path, rel: str, text: str) -> Path:
    p = base / rel
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(text, encoding="utf-8", newline="\n")
    return p


def _forensics(tmp_path: Path) -> Path:
    """docs/forensics/ inside a throwaway repo root, plus the probe fixture it hashes."""
    root = tmp_path / "docs" / "forensics"
    _mk(root, "l0/probe-skeleton.md", L0_BODY)
    app_dir = tmp_path / "tools" / "rea_probe_site"
    app_dir.mkdir(parents=True, exist_ok=True)
    (app_dir / "app.js").write_text("export const x = 1\n", encoding="utf-8", newline="\n")
    return root


def _l0(tmp_path: Path, text: str = L0_BODY, name: str = "probe-skeleton.md") -> tuple[Path, Path]:
    """(the L0 file, the repo root it is audited against)."""
    root = _forensics(tmp_path)
    path = root / "l0" / name
    path.write_text(text, encoding="utf-8", newline="\n")
    return path, root


def _drop_key(text: str, key: str) -> str:
    return "\n".join(
        line for line in text.splitlines() if not line.strip().startswith(f"- {key}：")
    ) + "\n"


def test_valid_l0_record_is_clean(tmp_path):
    path, repo = _l0(tmp_path)
    problems, _purpose = _audit_l0(path, "l0/probe-skeleton.md", repo)
    assert problems == []


def test_required_key_names_are_exactly_the_six():
    assert L0_REQUIRED_KEYS == ("命令", "evidence_id", "浏览器", "目标 URL", "观察条件", "完整性")
    assert L0_PURPOSES == ("harness", "规格", "基线")


@pytest.mark.parametrize("key", L0_REQUIRED_KEYS)
def test_each_required_key_is_named_when_missing(tmp_path, key):
    path, repo = _l0(tmp_path, _drop_key(L0_BODY, key))
    problems, _purpose = _audit_l0(path, "l0/probe-skeleton.md", repo)
    assert any(f"缺少必填键 {key}" in x for x in problems), problems


def test_empty_value_is_reported_separately(tmp_path):
    path, repo = _l0(tmp_path, L0_BODY.replace(
        "- 浏览器：Edg/155.0.4283.45（protocol_version 1.3）", "- 浏览器："))
    problems, _purpose = _audit_l0(path, "l0/probe-skeleton.md", repo)
    assert any("浏览器" in x and "值为空" in x for x in problems), problems


def test_placeholder_angle_brackets_are_refused(tmp_path):
    path, repo = _l0(tmp_path, L0_BODY.replace(
        "- 目标 URL：http://127.0.0.1:8077/", "- 目标 URL：<换成真实地址>"))
    problems, _purpose = _audit_l0(path, "l0/probe-skeleton.md", repo)
    assert any("目标 URL" in x and "占位符" in x for x in problems), problems


def test_evidence_id_must_have_the_shape(tmp_path):
    path, repo = _l0(tmp_path, L0_BODY.replace(EVID, "ev_123"))
    problems, _purpose = _audit_l0(path, "l0/probe-skeleton.md", repo)
    assert any("evidence_id 不是 ev_<64 位十六进制>" in x for x in problems), problems


def test_command_must_be_a_rea_command(tmp_path):
    path, repo = _l0(tmp_path, L0_BODY.replace("npx -y rea-agents@latest inspect-web-page", "curl inspect-web-page"))
    problems, _purpose = _audit_l0(path, "l0/probe-skeleton.md", repo)
    assert any("命令里没有 rea-agents" in x for x in problems), problems


def test_command_must_cap_its_own_output(tmp_path):
    path, repo = _l0(tmp_path, L0_BODY.replace(" --filter-output normalized_result", ""))
    problems, _purpose = _audit_l0(path, "l0/probe-skeleton.md", repo)
    assert any("--filter-output" in x and "--token-limit" in x for x in problems), problems


def test_parse_failures_must_be_explained(tmp_path):
    path, repo = _l0(tmp_path, L0_BODY.replace(
        '"completeness": {"status": "parsed"}',
        '"parse_failures": [{"reason": "timeout"}]',
    ).replace(
        "- 完整性：completeness.status=parsed；parse_failures 未出现",
        "- 完整性：completeness.status=parsed"))
    problems, _purpose = _audit_l0(path, "l0/probe-skeleton.md", repo)
    assert any("parse_failures" in x for x in problems), problems


def test_unusable_capture_needs_only_command_and_reason(tmp_path):
    text = (
        "# L0：画线工具目录\n\n"
        "- 命令：npx -y rea-agents@latest inspect-web-page http://127.0.0.1:9222 TID --token-limit 200\n"
        "- 状态：不可取证\n"
        "- 原因：headless 下工具条容器是空节点，页面对象自报反自动化拦截\n"
    )
    path, repo = _l0(tmp_path, text, name="tv-drawings.md")
    problems, purpose = _audit_l0(path, "l0/tv-drawings.md", repo)
    assert problems == []
    assert purpose is None


def test_unusable_capture_without_reason_fails(tmp_path):
    text = (
        "# L0：画线工具目录\n\n"
        "- 命令：npx -y rea-agents@latest inspect-web-page http://127.0.0.1:9222 TID --token-limit 200\n"
        "- 状态：不可取证\n"
    )
    path, repo = _l0(tmp_path, text, name="tv-drawings.md")
    problems, _purpose = _audit_l0(path, "l0/tv-drawings.md", repo)
    assert any("没有 原因：" in x for x in problems), problems


def test_keys_inside_fenced_blocks_are_not_metadata(tmp_path):
    """REA 的 stdout 摘录里也会出现 `- 命令：…` 这种行，不能拿它充当记录头的键。"""
    body = "\n".join(
        line for line in L0_BODY.splitlines() if not line.strip().startswith("- 命令：npx")
    ) + "\n"
    body = body.replace("# L0：探针页面骨架\n", "# L0：探针页面骨架\n\n```text\n- 命令：伪造在代码块里\n```\n")
    path, repo = _l0(tmp_path, body)
    problems, _purpose = _audit_l0(path, "l0/probe-skeleton.md", repo)
    assert any("缺少必填键 命令" in x for x in problems), problems


def test_meta_keys_and_fence_helper_are_public(tmp_path):
    text = "```text\n- 甲：在块内\n```\n- 乙：在块外\n"
    assert _meta_keys(text) == {"乙": "在块外"}
    assert "- 甲：在块内" not in _outside_fences(text)


def test_missing_forensics_root_is_named(tmp_path):
    problems = audit_forensics(tmp_path / "docs" / "forensics", tmp_path)
    assert any("不存在：取证骨架还没建" in x for x in problems), problems


def test_empty_l0_dir_is_not_a_passing_tree(tmp_path):
    root = _forensics(tmp_path)
    (root / "l0" / "probe-skeleton.md").unlink()
    problems = audit_forensics(root, tmp_path)
    assert any("l0/ 下没有任何证据文件" in x for x in problems), problems
```

- [ ] **Step 2: 跑测试，确认它因「模块不存在」而红**

Run: `cd /e/Vibe-Trading-main/Vibe-Trading-main && python -X utf8 -m pytest tools/test_forensics_spec.py -q`
Expected: `ModuleNotFoundError: No module named 'forensics_audit'` 的 collection 错误（rc=2、零读数）。这是预期的第一红。

- [ ] **Step 3: 写实现**

创建 `tools/forensics_audit.py`：

```python
"""Enforce the REA forensics funnel contract under ``docs/forensics/``.

The funnel only holds if every level's artefact is machine-checkable: an L0
record without an ``evidence_id`` is a memory, a spec entry without a verdict is
prose, and a gap row without a coordinate is a guess. This module turns those
three sentences into violations so the test suite can refuse them, and carries
the compliance red line: TradingView must never become a runtime dependency of
``frontend/src``.

Stdlib only. A missing ``docs/forensics/`` is reported as a violation here; it
is the *test* that decides to skip instead (see tools/test_forensics_spec.py).

Run with::

    python -X utf8 tools/forensics_audit.py
"""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

L0_REQUIRED_KEYS: tuple[str, ...] = ("命令", "evidence_id", "浏览器", "目标 URL", "观察条件", "完整性")
L0_PURPOSES: tuple[str, ...] = ("harness", "规格", "基线")
L0_EXEMPT: frozenset[str] = frozenset({"_example.md"})
SPEC_EXEMPT: frozenset[str] = frozenset({"_example.md"})

EVIDENCE_ID = re.compile(r"ev_[0-9a-f]{64}")
KEY_LINE = re.compile(r"^- ([^：\n]{1,24})：(.*)$")
PROBE_APP_JS = "tools/rea_probe_site/app.js"


def _outside_fences(text: str) -> list[str]:
    """Lines that are not inside a ``` fence — evidence excerpts are fenced."""
    out: list[str] = []
    in_fence = False
    for line in text.splitlines():
        if line.strip().startswith("```"):
            in_fence = not in_fence
            continue
        if not in_fence:
            out.append(line)
    return out


def _meta_keys(text: str) -> dict[str, str]:
    keys: dict[str, str] = {}
    for line in _outside_fences(text):
        m = KEY_LINE.match(line.strip())
        if m:
            keys.setdefault(m.group(1).strip(), m.group(2).strip())
    return keys


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def _audit_l0(path: Path, rel: str, repo_root: Path) -> tuple[list[str], str | None]:
    """One L0 record -> (violations, declared 用途 or None)."""
    v: list[str] = []
    text = _read(path)
    keys = _meta_keys(text)

    if "不可取证" in keys.get("状态", ""):
        if not keys.get("命令"):
            v.append(f"{rel}: 不可取证的记录也要写清 命令：（到底试过哪一条）")
        if not keys.get("原因"):
            v.append(f"{rel}: 标记为不可取证但没有 原因：")
        return v, None

    for key in L0_REQUIRED_KEYS:
        if key not in keys:
            v.append(f"{rel}: 缺少必填键 {key}")
        elif not keys[key]:
            v.append(f"{rel}: 键 {key} 的值为空")
        elif "<" in keys[key] or ">" in keys[key]:
            v.append(f"{rel}: 键 {key} 的值里还留着占位符尖括号：{keys[key]!r}")

    ev = keys.get("evidence_id", "")
    if ev and not EVIDENCE_ID.fullmatch(ev):
        v.append(f"{rel}: evidence_id 不是 ev_<64 位十六进制>：{ev!r}")

    cmd = keys.get("命令", "")
    if cmd and "rea-agents" not in cmd:
        v.append(f"{rel}: 命令里没有 rea-agents，这不是一条 REA 取证记录")
    if cmd and "--filter-output" not in cmd and "--token-limit" not in cmd:
        v.append(f"{rel}: 命令既没有 --filter-output 也没有 --token-limit（证据体积会吃掉内存）")

    completeness = keys.get("完整性", "")
    if "parse_failures" in text and "parse_failures" not in completeness:
        v.append(f"{rel}: 证据里出现 parse_failures，必须在 完整性： 里解释它的值（不解释就是没看）")

    purpose = keys.get("用途", "")
    if purpose and purpose not in L0_PURPOSES:
        v.append(f"{rel}: 用途 {purpose!r} 不在 {'/'.join(L0_PURPOSES)} 之内")
    if purpose == "harness":
        app = repo_root / PROBE_APP_JS
        if not app.is_file():
            v.append(f"{rel}: 声明 harness 用途但 {PROBE_APP_JS} 不存在")
        else:
            # 行尾不是证据的一部分：本机 core.autocrlf=true 会把工作树里的 app.js
            # 变成 CRLF，裸 read_bytes() 会让反编造针在下次 checkout 时假红。
            want = hashlib.sha256(app.read_bytes().replace(b"\r\n", b"\n")).hexdigest()
            if want not in text:
                v.append(f"{rel}: 声明 harness 用途但正文没有探针 app.js 的当前 sha256（{want}）")
    return v, (purpose or None)


def audit_forensics(forensics_root: Path, repo_root: Path) -> list[str]:
    """Every violation in the funnel artefacts. Empty list == the contract holds."""
    if not forensics_root.is_dir():
        return [f"{forensics_root} 不存在：取证骨架还没建"]

    v: list[str] = []
    l0_dir = forensics_root / "l0"
    l0_files = sorted(
        p for p in (l0_dir.glob("*.md") if l0_dir.is_dir() else []) if p.name not in L0_EXEMPT
    )
    if not l0_files:
        v.append("docs/forensics/l0/ 下没有任何证据文件（骨架不等于取证）")
    for p in l0_files:
        problems, _purpose = _audit_l0(p, f"l0/{p.name}", repo_root)
        v += problems
    return v


def main(repo_root: Path) -> int:
    problems = audit_forensics(repo_root / "docs" / "forensics", repo_root)
    for line in problems:
        print(line)
    if not problems:
        print("forensics audit: clean")
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main(Path(__file__).resolve().parents[1]))
```

- [ ] **Step 4: 再跑测试，确认全绿且没有假绿**

Run: `python -X utf8 -m pytest tools/test_forensics_spec.py -q`
Expected: 全绿（条数以当次运行为准，本任务应新增 18 条测试）。若某条红着，改实现而不是放宽断言。

- [ ] **Step 5: 变异自证（不留痕，改完必回）**

把 `_outside_fences` 改成直接 `return text.splitlines()` 再跑：`test_keys_inside_fenced_blocks_are_not_metadata` 与 `test_meta_keys_and_fence_helper_are_public` 必须变红；把占位符那条 `elif` 改成 `elif False` ⇒ `test_placeholder_angle_brackets_are_refused` 必须变红。逐条改回后复跑全绿。三次红的原文摘进提交正文——这一步证明的是测试在打分，不是实现宽容。

- [ ] **Step 6: 提交**

```bash
cd /e/Vibe-Trading-main/Vibe-Trading-main
git add -- tools/forensics_audit.py tools/test_forensics_spec.py
git commit -s -m "$(cat <<'EOF'
test(forensics): L0 证据记录的六把键与它们的失败模式

REA 在本机读不了任何磁盘路径（spec §2.4），证据只能是我们从 stdout 逐字抄下来
的键值行，所以这把尺先立起来：缺键／空值／占位符／evidence_id 形状／命令没限流／
parse_failures 没解释，都要指名道姓地红。代码块里的假键行不算键。

变异自证：摘掉 fence 过滤与占位符判断，对应针按预期变红。
EOF
)" -- tools/forensics_audit.py tools/test_forensics_spec.py
```

---

### Task 2: 规格条目表规则（L1）

**Files:**
- Modify: `tools/forensics_audit.py`
- Test: `tools/test_forensics_spec.py`

**Interfaces:**
- Consumes: `_outside_fences`、`_read`、`audit_forensics`
- Produces:
  - `SPEC_HEADER: str`（逐字 `| 条目号 | 规格句 | 判据 | 判据类型 | L0 依据 |`）
  - `ENTRY_ID: re.Pattern`、`VERDICT_TYPES: tuple[str, ...]`、`MIN_VERDICT_LEN: int`
  - `_table(text: str, header: str) -> tuple[bool, list[list[str]], list[str]]`（表头是否出现、正好五列的数据行、列数不对的行的原文）
  - `_resolve_l0(forensics_root: Path, ref: str) -> str | None`
  - `_audit_spec(path: Path, rel: str, forensics_root: Path) -> tuple[list[str], set[str], list[str]]`（违规、被引用的 L0 文件名集合、本表条目号序列）
  - `audit_forensics` 现在走查 `spec/*.md`

- [ ] **Step 1: 写失败的测试**

追加到 `tools/test_forensics_spec.py`，并把 `SPEC_HEADER`、`_audit_spec` 加进文件顶部的 `from forensics_audit import (...)`：

```python
SPEC_ROW = (
    "| TV-DW-01 | 工具栏是一组横向并列的画线按钮，斐波那契需两点确定垂直范围 | "
    "inspect-web-page 的可达文本里 id=toolbar 容器下能数出 13 个按钮 | DOM | l0/probe-skeleton.md |"
)
SPEC_TABLE = f"""# 规格：画线面

{SPEC_HEADER}
|---|---|---|---|---|
{SPEC_ROW}
"""


def _with_spec(tmp_path: Path, text: str = SPEC_TABLE) -> tuple[Path, Path]:
    """(spec/drawings.md, the docs/forensics root that holds it)."""
    root = _forensics(tmp_path)
    return _mk(root, "spec/drawings.md", text), root


def test_valid_spec_table_is_clean(tmp_path):
    path, root = _with_spec(tmp_path)
    problems, cited, ids = _audit_spec(path, "spec/drawings.md", root)
    assert problems == []
    assert cited == {"probe-skeleton.md"}
    assert ids == ["TV-DW-01"]


def test_spec_header_must_be_verbatim(tmp_path):
    path, root = _with_spec(tmp_path, SPEC_TABLE.replace(SPEC_HEADER, "| 编号 | 句子 | 判据 | 类型 | 依据 |"))
    problems, _c, _i = _audit_spec(path, "spec/drawings.md", root)
    assert any("表头不是逐字的" in x for x in problems), problems


@pytest.mark.parametrize("bad_id", ["TV-DW-1", "tv-DW-01", "TV-dw-01", "TV-DW-001", "DW-01", ""])
def test_entry_id_shape(tmp_path, bad_id):
    path, root = _with_spec(tmp_path, SPEC_TABLE.replace("| TV-DW-01 |", f"| {bad_id} |"))
    problems, _c, _i = _audit_spec(path, "spec/drawings.md", root)
    assert any(f"条目号 {bad_id!r} 不符合" in x for x in problems), problems


def test_verdict_shorter_than_12_chars_is_not_a_verdict(tmp_path):
    path, root = _with_spec(tmp_path, SPEC_TABLE.replace(
        "inspect-web-page 的可达文本里 id=toolbar 容器下能数出 13 个按钮", "数一下"))
    problems, _c, _i = _audit_spec(path, "spec/drawings.md", root)
    assert any("判据短于 12 个字符" in x for x in problems), problems


@pytest.mark.parametrize("bad_type", ["视觉", "pixel", "", "DOM 或 状态"])
def test_verdict_type_domain(tmp_path, bad_type):
    # 单元格不能含 `|`：那会改行列数，红的是「列数不是 5」而不是判据类型域。
    path, root = _with_spec(tmp_path, SPEC_TABLE.replace("| DOM |", f"| {bad_type} |"))
    problems, _c, _i = _audit_spec(path, "spec/drawings.md", root)
    assert any("判据类型" in x and "不在 DOM/状态/像素 之内" in x for x in problems), problems


def test_basis_must_point_at_an_existing_l0(tmp_path):
    path, root = _with_spec(tmp_path, SPEC_TABLE.replace("l0/probe-skeleton.md", "l0/never-captured.md"))
    problems, _c, _i = _audit_spec(path, "spec/drawings.md", root)
    assert any("L0 依据 'l0/never-captured.md' 指向的文件不存在" in x for x in problems), problems


def test_basis_accepts_bare_name_and_multiple_refs(tmp_path):
    path, root = _with_spec(tmp_path, SPEC_TABLE.replace(
        "| DOM | l0/probe-skeleton.md |", "| DOM | probe-skeleton.md、l0/probe-skeleton.md |"))
    problems, cited, _i = _audit_spec(path, "spec/drawings.md", root)
    assert problems == []
    assert cited == {"probe-skeleton.md"}


def test_empty_basis_is_named(tmp_path):
    path, root = _with_spec(tmp_path, SPEC_TABLE.replace("| DOM | l0/probe-skeleton.md |", "| DOM |  |"))
    problems, _c, _i = _audit_spec(path, "spec/drawings.md", root)
    assert any("L0 依据是空的" in x for x in problems), problems


def test_duplicate_entry_id_in_one_table(tmp_path):
    path, root = _with_spec(tmp_path, SPEC_TABLE + SPEC_ROW + "\n")
    problems, _c, _i = _audit_spec(path, "spec/drawings.md", root)
    assert any("条目号 TV-DW-01 在 spec/drawings.md 里出现 2 次" in x for x in problems), problems


def test_row_with_wrong_column_count_is_not_dropped_silently(tmp_path):
    """少一列的行如果直接被解析丢掉，表就「空着也全绿」——必须报出来。"""
    broken = SPEC_ROW.rsplit("|", 2)[0] + "|"  # 砍掉最后一列
    assert broken.count("|") == 5
    path, root = _with_spec(tmp_path, SPEC_TABLE.replace(SPEC_ROW, broken))
    problems, _c, _i = _audit_spec(path, "spec/drawings.md", root)
    assert any("列数不是 5" in x for x in problems), problems


def test_audit_forensics_picks_up_spec_violations(tmp_path):
    root = _forensics(tmp_path)
    _mk(root, "spec/drawings.md", SPEC_TABLE.replace("| DOM |", "| 视觉 |"))
    problems = audit_forensics(root, tmp_path)
    assert any("spec/drawings.md" in x and "判据类型" in x for x in problems), problems
```

- [ ] **Step 2: 跑测试确认红**

Run: `python -X utf8 -m pytest tools/test_forensics_spec.py -q`
Expected: `ImportError: cannot import name 'SPEC_HEADER'`。

- [ ] **Step 3: 实现**

常量区补：

```python
SPEC_HEADER = "| 条目号 | 规格句 | 判据 | 判据类型 | L0 依据 |"
ENTRY_ID = re.compile(r"TV-[A-Z][A-Z0-9]*-\d{2}")
VERDICT_TYPES: tuple[str, ...] = ("DOM", "状态", "像素")
MIN_VERDICT_LEN = 12
```

表解析与规格走查：

```python
def _table(text: str, header: str) -> tuple[bool, list[list[str]], list[str]]:
    """(header_seen, five-column data rows, raw text of rows with the wrong width)."""
    seen = False
    rows: list[list[str]] = []
    bad: list[str] = []
    for line in _outside_fences(text):
        s = line.strip()
        if s == header:
            seen = True
            continue
        if not seen or not s.startswith("|"):
            continue
        if set(s) <= set("|-: "):  # the |---|---| separator row
            continue
        cells = [c.strip() for c in s.strip("|").split("|")]
        if len(cells) == 5:
            rows.append(cells)
        else:
            bad.append(s)
    return seen, rows, bad


def _resolve_l0(forensics_root: Path, ref: str) -> str | None:
    """Accept ``l0/x.md`` or a bare ``x.md``; return the resolved file name or None."""
    name = ref.rsplit("/", 1)[-1]
    for cand in (forensics_root / "l0" / name, forensics_root / ref):
        if cand.is_file():
            return name
    return None


def _audit_spec(path: Path, rel: str, forensics_root: Path) -> tuple[list[str], set[str], list[str]]:
    v: list[str] = []
    text = _read(path)
    seen, rows, bad = _table(text, SPEC_HEADER)
    if not seen:
        return [f"{rel}: 表头不是逐字的 {SPEC_HEADER}，文件里没有规格表"], set(), []
    if bad:
        v.append(f"{rel}: 有 {len(bad)} 行的列数不是 5（表行必须正好五列）：{bad[0]!r}")
    cited: set[str] = set()
    ids: list[str] = []
    for eid, _sentence, verdict, vtype, basis in rows:
        tag = f"{rel} 条目 {eid or '(空)'}"
        if not ENTRY_ID.fullmatch(eid):
            v.append(f"{tag}: 条目号 {eid!r} 不符合 TV-<大写字母…>-<两位数字>")
        ids.append(eid)
        if len(verdict) < MIN_VERDICT_LEN:
            v.append(f"{tag}: 判据短于 {MIN_VERDICT_LEN} 个字符，打不了（写不出判据不算条目）")
        if vtype not in VERDICT_TYPES:
            v.append(f"{tag}: 判据类型 {vtype!r} 不在 {'/'.join(VERDICT_TYPES)} 之内")
        refs = [r.strip() for r in re.split(r"[、,]", basis) if r.strip()]
        if not refs:
            v.append(f"{tag}: L0 依据是空的")
        for ref in refs:
            resolved = _resolve_l0(forensics_root, ref)
            if resolved is None:
                v.append(f"{tag}: L0 依据 {ref!r} 指向的文件不存在")
            else:
                cited.add(resolved)
    for dup in sorted({i for i in ids if ids.count(i) > 1}):
        v.append(f"{rel}: 条目号 {dup} 在 {rel} 里出现 {ids.count(dup)} 次")
    return v, cited, ids
```

在 `audit_forensics` 的 `return v` 之前插入：

```python
    spec_dir = forensics_root / "spec"
    for p in sorted(
        q for q in (spec_dir.glob("*.md") if spec_dir.is_dir() else []) if q.name not in SPEC_EXEMPT
    ):
        problems, _cited, _ids = _audit_spec(p, f"spec/{p.name}", forensics_root)
        v += problems
```

- [ ] **Step 4: 跑测试确认绿**

Run: `python -X utf8 -m pytest tools/test_forensics_spec.py -q` → 全绿。

- [ ] **Step 5: 变异自证**

① `if len(verdict) < MIN_VERDICT_LEN:` 改 `if False:` ⇒ 判据长度针红。
② `else: bad.append(s)` 那枝删掉（坏行静默丢弃）⇒ `test_row_with_wrong_column_count_is_not_dropped_silently` 红。
改回后复跑全绿，两次红的原文进提交正文。

- [ ] **Step 6: 提交**

```bash
git add -- tools/forensics_audit.py tools/test_forensics_spec.py
git commit -s -m "$(cat <<'EOF'
feat(forensics): L1 规格条目表的机器判据

「写不出判据的条目不算条目」要能被机器拒绝才算数：表头逐字、条目号形状、
判据至少 12 字符、判据类型三选一、L0 依据必须指向真实存在的证据文件。
列数不对的行不能静默丢掉——否则一张写坏了的表也能「零条目全绿」。
EOF
)" -- tools/forensics_audit.py tools/test_forensics_spec.py
```

---

### Task 3: 差距矩阵（L2）与三层咬合规则

**Files:**
- Modify: `tools/forensics_audit.py`
- Test: `tools/test_forensics_spec.py`

**Interfaces:**
- Consumes: `_audit_l0` 返回的 `用途`、`_audit_spec` 返回的 `cited`／`ids`
- Produces:
  - `MATRIX_HEADER: str`（逐字 `| 条目号 | 状态 | 本仓坐标或搜索记录 | 优先级 | 说明 |`）
  - `MATRIX_STATUSES: tuple[str, ...]`、`MATRIX_PRIORITIES: tuple[str, ...]`、`COORD: re.Pattern`
  - `_audit_matrix(path: Path, rel: str, repo_root: Path, spec_ids: dict[str, str]) -> list[str]`
  - `audit_forensics` 完成全部交叉规则：孤证、harness 校验和、跨文件重复条目号、每条目恰好一行、凭空条目

- [ ] **Step 1: 写失败的测试**

追加（import 增加 `MATRIX_HEADER`；本任务的测试全部走 `audit_forensics`，不直接调 `_audit_matrix`）：

```python
MATRIX_ROW = "| TV-DW-01 | 已有 | frontend/src/lib/chartDrawings.ts:2 | - | 本仓有同类工具目录 |"
MATRIX_TABLE = f"""# 差距矩阵

{MATRIX_HEADER}
|---|---|---|---|---|
{MATRIX_ROW}
"""
COORD_FILE = "frontend/src/lib/chartDrawings.ts"


def _tree(tmp_path: Path, spec: str | None = SPEC_TABLE, matrix: str | None = MATRIX_TABLE) -> Path:
    """A complete, valid tree: one L0 + one spec row + one matrix row + the cited source file."""
    root = _forensics(tmp_path)
    if spec is not None:
        _mk(root, "spec/drawings.md", spec)
    if matrix is not None:
        _mk(root, "gap-matrix.md", matrix)
    _mk(tmp_path, COORD_FILE, "one\ntwo\nthree\n")
    return root


def test_whole_tree_is_clean(tmp_path):
    assert audit_forensics(_tree(tmp_path), tmp_path) == []


def test_every_spec_id_needs_exactly_one_matrix_row(tmp_path):
    root = _tree(tmp_path, matrix=None)
    problems = audit_forensics(root, tmp_path)
    assert any("有 1 条规格条目但 docs/forensics/gap-matrix.md 不存在" in x for x in problems), problems


def test_matrix_without_a_header_row_is_named(tmp_path):
    root = _tree(tmp_path, matrix="# 差距矩阵\n\n随手写的散文，没有表。\n")
    problems = audit_forensics(root, tmp_path)
    assert any("gap-matrix.md: 表头不是逐字的" in x for x in problems), problems


def test_missing_matrix_row_is_named(tmp_path):
    problems = audit_forensics(_tree(tmp_path, matrix=MATRIX_TABLE.replace(MATRIX_ROW, "")), tmp_path)
    assert any("TV-DW-01 在矩阵里出现 0 次" in x for x in problems), problems


def test_duplicate_matrix_row_is_named(tmp_path):
    problems = audit_forensics(_tree(tmp_path, matrix=MATRIX_TABLE + MATRIX_ROW + "\n"), tmp_path)
    assert any("TV-DW-01 在矩阵里出现 2 次" in x for x in problems), problems


def test_phantom_matrix_row_is_named(tmp_path):
    problems = audit_forensics(_tree(tmp_path, matrix=MATRIX_TABLE.replace("TV-DW-01", "TV-ZZZ-99")), tmp_path)
    assert any("TV-ZZZ-99 在任何规格文件里都不存在" in x for x in problems), problems


def test_same_entry_id_in_two_spec_files_is_named(tmp_path):
    root = _tree(tmp_path)
    _mk(root, "spec/interaction.md", SPEC_TABLE)
    problems = audit_forensics(root, tmp_path)
    assert any("spec/interaction.md: 条目号 TV-DW-01 已在 spec/drawings.md 里出现过" in x for x in problems), problems


@pytest.mark.parametrize("bad", ["有", "部分实现", "", "缺憾"])
def test_matrix_status_domain(tmp_path, bad):
    problems = audit_forensics(_tree(tmp_path, matrix=MATRIX_TABLE.replace("| 已有 |", f"| {bad} |", 1)), tmp_path)
    assert any("状态" in x and "不在 已有/部分/缺/不可复刻 之内" in x for x in problems), problems


@pytest.mark.parametrize("bad", ["P0", "", "很高"])
def test_matrix_priority_domain(tmp_path, bad):
    problems = audit_forensics(_tree(tmp_path, matrix=MATRIX_TABLE.replace("| - |", f"| {bad} |", 1)), tmp_path)
    assert any("优先级" in x and "不在 高/中/低/- 之内" in x for x in problems), problems


def test_empty_note_is_named(tmp_path):
    problems = audit_forensics(
        _tree(tmp_path, matrix=MATRIX_TABLE.replace("| 本仓有同类工具目录 |", "|  |")), tmp_path)
    assert any("说明是空的" in x for x in problems), problems


@pytest.mark.parametrize("bad", ["chartDrawings.ts", "frontend/src/lib/chartDrawings.ts", "x.ts:abc"])
def test_existing_status_needs_file_line_shape(tmp_path, bad):
    problems = audit_forensics(
        _tree(tmp_path, matrix=MATRIX_TABLE.replace(f"| {COORD_FILE}:2 |", f"| {bad} |")), tmp_path)
    assert any("要给本仓坐标 file:line" in x for x in problems), problems


def test_coordinate_file_must_exist(tmp_path):
    root = _tree(tmp_path, matrix=MATRIX_TABLE.replace(COORD_FILE, "frontend/src/lib/nope.ts"))
    problems = audit_forensics(root, tmp_path)
    assert any("坐标 frontend/src/lib/nope.ts:2 的文件不存在" in x for x in problems), problems


def test_coordinate_line_must_be_within_the_file(tmp_path):
    _mk(tmp_path, "short.ts", "one\n")
    root = _tree(tmp_path, matrix=MATRIX_TABLE.replace(f"{COORD_FILE}:2", "short.ts:9"))
    problems = audit_forensics(root, tmp_path)
    assert any("行号 9 超出 short.ts 的实际 1 行" in x for x in problems), problems


def test_missing_status_needs_a_rerunnable_needle(tmp_path):
    problems = audit_forensics(_tree(
        tmp_path, matrix=MATRIX_TABLE.replace(f"| 已有 | {COORD_FILE}:2 |", "| 缺 | 没有这个东西 |")), tmp_path)
    assert any("要以 未找到： 开头" in x for x in problems), problems


def test_missing_status_with_empty_needle_is_named(tmp_path):
    problems = audit_forensics(_tree(
        tmp_path, matrix=MATRIX_TABLE.replace(f"| 已有 | {COORD_FILE}:2 |", "| 缺 | 未找到： |")), tmp_path)
    assert any("needle 为空" in x for x in problems), problems


def test_uncited_l0_without_purpose_is_named(tmp_path):
    root = _tree(tmp_path)
    _mk(root, "l0/loose.md", L0_BODY)
    problems = audit_forensics(root, tmp_path)
    assert any("loose.md: 没有被任何规格条目引用" in x for x in problems), problems


def test_harness_purpose_exempts_an_uncited_l0_but_must_carry_the_checksum(tmp_path):
    root = _tree(tmp_path)
    body = L0_BODY + "\n- 用途：harness\n"
    _mk(root, "l0/loose.md", body)
    app = tmp_path / "tools" / "rea_probe_site" / "app.js"
    want = hashlib.sha256(app.read_bytes().replace(b"\r\n", b"\n")).hexdigest()
    problems = audit_forensics(root, tmp_path)
    assert any("没有探针 app.js 的当前 sha256" in x and want in x for x in problems), problems
    _mk(root, "l0/loose.md", body + f"\n探针 app.js 的当前 sha256：{want}\n")
    assert audit_forensics(root, tmp_path) == []
    app.write_bytes(app.read_bytes().replace(b"\n", b"\r\n"))
    assert audit_forensics(root, tmp_path) == []


def test_baseline_purpose_exempts_an_uncited_l0(tmp_path):
    root = _tree(tmp_path)
    _mk(root, "l0/loose.md", L0_BODY + "\n- 用途：基线\n")
    assert audit_forensics(root, tmp_path) == []


def test_example_files_are_exempt_by_exact_name(tmp_path):
    root = _tree(tmp_path)
    _mk(root, "l0/_example.md", "- 命令：随便\n")
    _mk(root, "spec/_example.md", "随便一张表\n")
    assert audit_forensics(root, tmp_path) == []
```

夹具的三件事都必要：`_forensics` 造 `tools/rea_probe_site/app.js`（harness 校验和针要读它），`_tree` 造 `frontend/src/lib/chartDrawings.ts`（矩阵坐标针要读它），`_mk` 统一处理父目录与 LF 换行。少了前两样，针会因为「文件不存在」而红，掩盖真正的判据。

- [ ] **Step 2: 跑测试确认红**

Expected: `ImportError: cannot import name 'MATRIX_HEADER'`。

- [ ] **Step 3: 实现**

常量：

```python
MATRIX_HEADER = "| 条目号 | 状态 | 本仓坐标或搜索记录 | 优先级 | 说明 |"
MATRIX_STATUSES: tuple[str, ...] = ("已有", "部分", "缺", "不可复刻")
MATRIX_PRIORITIES: tuple[str, ...] = ("高", "中", "低", "-")
COORD = re.compile(r"[\w./-]+:\d+")
```

矩阵走查：

```python
def _audit_matrix(path: Path, rel: str, repo_root: Path, spec_ids: dict[str, str]) -> list[str]:
    v: list[str] = []
    seen, rows, bad = _table(_read(path), MATRIX_HEADER)
    if not seen:
        return [f"{rel}: 表头不是逐字的 {MATRIX_HEADER}，文件里没有差距矩阵表"]
    if bad:
        v.append(f"{rel}: 有 {len(bad)} 行的列数不是 5（表行必须正好五列）：{bad[0]!r}")
    counts: dict[str, int] = {}
    for eid, status, coord, prio, note in rows:
        tag = f"{rel} 条目 {eid or '(空)'}"
        if not ENTRY_ID.fullmatch(eid):
            v.append(f"{tag}: 条目号 {eid!r} 不符合 TV-<大写字母…>-<两位数字>")
        counts[eid] = counts.get(eid, 0) + 1
        if status not in MATRIX_STATUSES:
            v.append(f"{tag}: 状态 {status!r} 不在 {'/'.join(MATRIX_STATUSES)} 之内")
        if prio not in MATRIX_PRIORITIES:
            v.append(f"{tag}: 优先级 {prio!r} 不在 {'/'.join(MATRIX_PRIORITIES)} 之内")
        if not note:
            v.append(f"{tag}: 说明是空的")
        if status in ("已有", "部分"):
            if not COORD.fullmatch(coord):
                v.append(f"{tag}: 状态 {status} 要给本仓坐标 file:line，实际是 {coord!r}")
                continue
            f, _, ln = coord.rpartition(":")
            target = repo_root / f
            if not target.is_file():
                v.append(f"{tag}: 坐标 {coord} 的文件不存在")
            else:
                n = len(_read(target).splitlines())
                if int(ln) > n:
                    v.append(f"{tag}: 坐标 {coord} 的行号 {ln} 超出 {f} 的实际 {n} 行")
        elif status == "缺":
            if not coord.startswith("未找到："):
                v.append(f"{tag}: 状态 缺 的记录要以 未找到： 开头（写清搜过的 needle）")
            elif len(coord) <= len("未找到："):
                v.append(f"{tag}: 状态 缺 但 needle 为空")
    for eid in sorted(spec_ids):
        k = counts.get(eid, 0)
        if k != 1:
            v.append(f"{rel}: 规格条目 {eid} 在矩阵里出现 {k} 次（要求恰好 1 次）")
    for eid in sorted(counts):
        if eid not in spec_ids:
            v.append(f"{rel}: 矩阵里的 {eid} 在任何规格文件里都不存在（凭空条目）")
    return v
```

`audit_forensics` 里把 T1/T2 的两段循环替换成完整的收集逻辑：

```python
    purposes: dict[str, str | None] = {}
    for p in l0_files:
        problems, purpose = _audit_l0(p, f"l0/{p.name}", repo_root)
        v += problems
        purposes[p.name] = purpose

    cited: set[str] = set()
    spec_ids: dict[str, str] = {}
    spec_dir = forensics_root / "spec"
    for p in sorted(
        q for q in (spec_dir.glob("*.md") if spec_dir.is_dir() else []) if q.name not in SPEC_EXEMPT
    ):
        rel = f"spec/{p.name}"
        problems, refs, ids = _audit_spec(p, rel, forensics_root)
        v += problems
        cited |= refs
        for i in ids:
            first = spec_ids.setdefault(i, rel)
            if first != rel:
                v.append(f"{rel}: 条目号 {i} 已在 {first} 里出现过")

    for name in sorted(purposes):
        if name not in cited and purposes[name] not in ("harness", "基线"):
            v.append(f"l0/{name}: 没有被任何规格条目引用，也没标 用途：harness 或 用途：基线")

    matrix = forensics_root / "gap-matrix.md"
    if spec_ids:
        if not matrix.is_file():
            v.append(f"有 {len(spec_ids)} 条规格条目但 docs/forensics/gap-matrix.md 不存在")
        else:
            v += _audit_matrix(matrix, "gap-matrix.md", repo_root, spec_ids)
    return v
```

- [ ] **Step 4: 跑测试确认绿**

Run: `python -X utf8 -m pytest tools/test_forensics_spec.py -q` → 全绿。

- [ ] **Step 5: 变异自证（四条针，逐条单独摘再改回）**

① 孤证规则条件改成 `if name not in cited:`（去掉用途豁免）⇒ `test_harness_purpose_exempts_an_uncited_l0_but_must_carry_the_checksum` 红。
② `if int(ln) > n` 改 `if False` ⇒ `test_coordinate_line_must_be_within_the_file` 红。
③ `if k != 1` 改 `if k == 0` ⇒ `test_duplicate_matrix_row_is_named` 红。
④ `if first != rel` 那枝删掉 ⇒ `test_same_entry_id_in_two_spec_files_is_named` 红。
四次红的原文摘进提交正文。

- [ ] **Step 6: 提交**

```bash
git add -- tools/forensics_audit.py tools/test_forensics_spec.py
git commit -s -m "$(cat <<'EOF'
feat(forensics): 差距矩阵与三层咬合规则

一条规格恰好一行、已有/部分必须指到真实存在的 file:line、缺必须留能复跑的
needle；没被引用的证据要么当 harness 要么当基线，harness 还得带探针 app.js
的当前 sha256——这条反编造针挡的就是「没跑过却写了记录」。跨文件重复条目号
同样报，否则两份表各写一遍就能冒充两条规格。

变异自证四针：摘用途豁免／摘行号越界／把「恰好一次」写成「少于一次」／摘跨文件重复。
EOF
)" -- tools/forensics_audit.py tools/test_forensics_spec.py
```

---

### Task 4: TradingView 主机红线

**Files:**
- Modify: `tools/forensics_audit.py`
- Test: `tools/test_forensics_spec.py`

**Interfaces:**
- Consumes: `_read`
- Produces:
  - `TV_HOST_ALLOWLIST: frozenset[str]`、`S3_HOST_FILE: str`、`TV_SUPPORT_HOST_LINE: str`、`TV_WIDGET_SRC_LINE: str`
  - `audit_tv_host_allowlist(repo_root: Path) -> list[str]`
  - `main()` 同时跑两支审计

**为什么这条要写成「集合相等」**：spec 裁定 1 的第三条硬线是「TradingView 接口不作为运行时依赖」。本仓 `frontend/src` **今天**就有 5 个文件含 `tradingview.com`（其中 `pages/TVChart.tsx` 是官方 embed-widget 集成，属既有事实；设计轮实测）。所以红线不是「一处都不许有」——那条门一落地就恒红——而是**集合必须恰好等于这 5 个**：新增＝把外部站点接成了依赖；消失＝白名单该同步收紧，同样要人看一眼。

- [ ] **Step 1: 写失败的测试**

追加（import 增加 `TV_HOST_ALLOWLIST`、`audit_tv_host_allowlist`）：

```python
def _src(repo_root: Path, rel: str, text: str) -> Path:
    """rel is repo-relative, e.g. frontend/src/lib/x.ts."""
    return _mk(repo_root, rel, text)


def _fake_tv_tree(tmp_path: Path) -> None:
    """Reproduce today's real shape: 5 allowlisted files mention tradingview.com, one hosts s3."""
    for rel in sorted(TV_HOST_ALLOWLIST):
        _src(tmp_path, rel, 'const h = "tradingview.com";\n')
    _src(tmp_path, "frontend/src/pages/TVChart.tsx",
         "const widget = {\n"
         '  support_host: "https://www.tradingview.com",\n'
         "};\n"
         "const script = document.createElement('script');\n"
         'script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";\n')


def test_current_repo_passes_the_host_red_line():
    repo_root = Path(__file__).resolve().parents[1]
    assert audit_tv_host_allowlist(repo_root) == []


def test_new_tradingview_host_file_is_refused(tmp_path):
    _fake_tv_tree(tmp_path)
    _src(tmp_path, "frontend/src/lib/tvFetch.ts", 'const u = "https://scanner.tradingview.com/";\n')
    problems = audit_tv_host_allowlist(tmp_path)
    assert any("白名单不符" in x and "frontend/src/lib/tvFetch.ts" in x for x in problems), problems


def test_disappearing_allowlist_entry_is_also_reported(tmp_path):
    _fake_tv_tree(tmp_path)
    (tmp_path / "frontend/src/lib/pineLang.ts").unlink()
    problems = audit_tv_host_allowlist(tmp_path)
    assert any("白名单不符" in x and "pineLang.ts" in x for x in problems), problems


def test_s3_host_outside_the_widget_file_is_refused(tmp_path):
    _fake_tv_tree(tmp_path)
    _src(tmp_path, "frontend/src/lib/sneaky.ts", 'const s = "https://s3.tradingview.com/x.js";\n')
    problems = audit_tv_host_allowlist(tmp_path)
    assert any("s3.tradingview 只允许出现在" in x and "lib/sneaky.ts" in x for x in problems), problems


def test_pinned_widget_lines_are_checked_verbatim(tmp_path):
    _fake_tv_tree(tmp_path)
    _src(tmp_path, "frontend/src/pages/TVChart.tsx", 'const nothing = 1;\n')
    problems = audit_tv_host_allowlist(tmp_path)
    assert any("support_host" in x for x in problems), problems
    assert any("s3.tradingview.com/external-embedding" in x for x in problems), problems


def test_non_ts_files_are_not_scanned(tmp_path):
    _fake_tv_tree(tmp_path)
    _src(tmp_path, "frontend/src/notes.md", "讲讲 tradingview.com 的设计取舍\n")
    assert audit_tv_host_allowlist(tmp_path) == []


def test_missing_frontend_src_is_named(tmp_path):
    assert audit_tv_host_allowlist(tmp_path) != []
```

- [ ] **Step 2: 跑测试确认红**

Expected: `ImportError: cannot import name 'audit_tv_host_allowlist'`。

- [ ] **Step 3: 实现**

```python
TV_HOST_ALLOWLIST: frozenset[str] = frozenset({
    "frontend/src/components/chat/PineScriptViewer.tsx",
    "frontend/src/lib/__tests__/scriptExchange.test.ts",
    "frontend/src/lib/pineLang.ts",
    "frontend/src/lib/scriptLibrary.ts",
    "frontend/src/pages/TVChart.tsx",
})
S3_HOST_FILE = "frontend/src/pages/TVChart.tsx"
TV_SUPPORT_HOST_LINE = 'support_host: "https://www.tradingview.com"'
TV_WIDGET_SRC_LINE = 'script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js"'


def audit_tv_host_allowlist(repo_root: Path) -> list[str]:
    """Spec ruling 1: TradingView is a research subject, never a dependency."""
    v: list[str] = []
    src = repo_root / "frontend" / "src"
    if not src.is_dir():
        return [f"{src} 不存在：无法核对 TradingView 主机白名单"]
    hits: set[str] = set()
    s3_counts: dict[str, int] = {}
    for p in sorted(src.rglob("*")):
        if not p.is_file() or p.suffix not in (".ts", ".tsx"):
            continue
        rel = p.relative_to(repo_root).as_posix()
        text = _read(p)
        if "tradingview.com" in text:
            hits.add(rel)
        n = text.count("s3.tradingview")
        if n:
            s3_counts[rel] = n
    extra = sorted(hits - TV_HOST_ALLOWLIST)
    gone = sorted(TV_HOST_ALLOWLIST - hits)
    if extra or gone:
        v.append(
            "frontend/src 里含 tradingview.com 的文件集合与白名单不符："
            f"新增={extra or '无'}；消失={gone or '无'}"
            "（新增＝把外部站点接成了运行时依赖；消失＝白名单该同步收紧）"
        )
    offenders = sorted(f"{f}（{n} 次）" for f, n in s3_counts.items() if f != S3_HOST_FILE)
    if offenders:
        v.append(f"s3.tradingview 只允许出现在 {S3_HOST_FILE}，实际还有：{'、'.join(offenders)}")
    widget = repo_root / S3_HOST_FILE
    if widget.is_file():
        text = _read(widget)
        if TV_SUPPORT_HOST_LINE not in text:
            v.append(f"{S3_HOST_FILE}: 逐字行 {TV_SUPPORT_HOST_LINE} 不见了或被改过——"
                     "那是对外部站点的运行时依赖，改动要重新裁定")
        if TV_WIDGET_SRC_LINE not in text:
            v.append(f"{S3_HOST_FILE}: 逐字行 {TV_WIDGET_SRC_LINE} 不见了或被改过——同上")
    return v
```

`main()` 换成：

```python
def main(repo_root: Path) -> int:
    problems = (
        audit_forensics(repo_root / "docs" / "forensics", repo_root)
        + audit_tv_host_allowlist(repo_root)
    )
    for line in problems:
        print(line)
    if not problems:
        print("forensics audit: clean")
    return 1 if problems else 0
```

- [ ] **Step 4: 跑测试确认绿**

Run: `python -X utf8 -m pytest tools/test_forensics_spec.py -q` → 全绿。
`test_current_repo_passes_the_host_red_line` 是**活树**测试，此刻就该绿（设计轮实测：5 文件、`s3.tradingview` 出现 1 次）。**若它红**：说明工作树上那三个在途改动动过主机面 ⇒ 停下来报告实情，**不许**为了让门绿去改白名单。

- [ ] **Step 5: 变异自证**

`p.suffix not in (".ts", ".tsx")` 改成 `False`（即所有扩展名都扫）⇒ `test_non_ts_files_are_not_scanned` 红；改回。

- [ ] **Step 6: 提交**

```bash
git add -- tools/forensics_audit.py tools/test_forensics_spec.py
git commit -s -m "$(cat <<'EOF'
feat(forensics): TradingView 主机红线按集合相等来判

「一处都不许出现」在这棵树上今天就有 5 个文件命中，门一落地必恒红。改成与既有
白名单集合相等：新增即拒绝（外部站点不许成运行时依赖），消失也报（白名单要同步
收紧）。widget 那两行主机串按逐字子式钉住，不钉行号——行号会漂，子式不会。
EOF
)" -- tools/forensics_audit.py tools/test_forensics_spec.py
```

---

### Task 5: 取证骨架落地＋本地探针闭环（P0 主体）

**Files:**
- Create: `tools/rea_probe_site/index.html`、`tools/rea_probe_site/app.js`、`tools/rea_probe_site/data.json`
- Create: `docs/forensics/README.md`
- Create: `docs/forensics/_templates/l0-capture.md`、`docs/forensics/_templates/spec-entry.md`、`docs/forensics/_templates/gap-matrix.md`
- Create: `docs/forensics/l0/probe-skeleton.md`、`docs/forensics/l0/probe-bundle.md`、`docs/forensics/l0/probe-events.md`

**Interfaces:**
- Consumes: `audit_forensics`（含 harness 校验和针）
- Produces: 三份真实 L0 记录，文件名固定 `probe-skeleton.md`／`probe-bundle.md`／`probe-events.md`，全部 `用途：harness`

- [ ] **Step 1: 建本地中立探针页（自研内容，不含任何第三方资产）**

`tools/rea_probe_site/index.html`：

```html
<!doctype html>
<html lang="zh">
  <head>
    <meta charset="utf-8" />
    <title>Probe Chart</title>
  </head>
  <body>
    <h1>Probe Chart</h1>
    <div id="toolbar">
      <button type="button">Trend line</button>
      <button type="button">Fibonacci</button>
      <button type="button">Brush</button>
    </div>
    <canvas id="probe-chart" width="240" height="140"></canvas>
    <p id="legend">O H L C</p>
    <script type="module" src="/app.js"></script>
  </body>
</html>
```

`tools/rea_probe_site/app.js`：

```javascript
export class ChartEngine {
  constructor(canvas, bars) {
    this.canvas = canvas;
    this.bars = bars;
    canvas.addEventListener("pointerdown", (event) => this.pick(event));
  }

  pick(event) {
    this.selected = Math.floor(event.offsetX / 8);
    this.draw();
  }

  draw() {
    const ctx = this.canvas.getContext("2d");
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.bars.forEach((bar, i) => {
      const top = 130 - bar.close;
      ctx.fillRect(i * 8, top, 6, Math.max(1, bar.high - bar.low));
    });
  }
}

const response = await fetch("/data.json");
const bars = await response.json();
new ChartEngine(document.getElementById("probe-chart"), bars).draw();
```

`tools/rea_probe_site/data.json`：12 个 `{"high": n, "low": n, "close": n}` 对象，数值递增带回落即可（手写，不许从外部抓）。

- [ ] **Step 2: 起静态服务与 Edge CDP，取一次 targetId**

```bash
cd /e/Vibe-Trading-main/Vibe-Trading-main
python -m http.server 8077 --bind 127.0.0.1 --directory tools/rea_probe_site &
HTTP_PID=$!

"/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  --headless=new --remote-debugging-port=9222 \
  --user-data-dir="$TEMP/rea-cdp-profile" \
  --disable-extensions --disable-sync --no-first-run --no-default-browser-check \
  "http://127.0.0.1:8077/" &
EDGE_PID=$!

npx -y rea-agents@latest list-browser-targets http://127.0.0.1:9222
```

期望：`browser.product` 含 `Edg/155`，`targets[]` 里出现 `url: "http://127.0.0.1:8077/"` 的那个 `targetId`，下称 `TID`（下面三条命令共用它）。
坑（设计轮实测）：**不许**用 CDP 的 `PUT /json/new?url=` 开标签——Edge 155 会回 target id 但页面停在 `about:blank`。URL 只能当命令行参数交给 Edge 起进程。

- [ ] **Step 3: 一面一趟，跑三条命令并留 stdout**

```bash
npx -y rea-agents@latest inspect-web-page http://127.0.0.1:9222 "$TID" --filter-output normalized_result

npx -y rea-agents@latest analyze-web-bundle http://127.0.0.1:9222 "$TID" \
  --observation-ms 1500 --allowed-origins http://127.0.0.1:8077 \
  --filter-output normalized_result.observations

npx -y rea-agents@latest inspect-web-event-listeners http://127.0.0.1:9222 "$TID" "#probe-chart" \
  --token-limit 400
```

`--allowed-origins` 要**裸值**，写 JSON 数组字面量会被拒（`invalid_request`/`invalid_input`）。报错看不清时先去掉 `--token-limit` 重跑——它会把 `details` 一起截掉。

- [ ] **Step 4: 收尾进程与临时目录（不留项目外副作用）**

```bash
taskkill //PID "$EDGE_PID" //T //F 2>/dev/null
kill "$HTTP_PID" 2>/dev/null
rm -rf "$TEMP/rea-cdp-profile"
netstat -ano | grep -E ':(9222|8077)' | grep LISTEN || echo "端口已释放"
```

**只杀我们自己起的那个 PID。绝不按镜像名杀 `msedge.exe`**——那会连带杀掉用户正在用的浏览器窗口。

- [ ] **Step 5: 写三份 L0 记录**

骨架（`docs/forensics/l0/probe-skeleton.md`；另两份只换 `命令`／摘录块／`观察条件`）：

```markdown
# L0：探针页骨架（面 A1）

- 命令：npx -y rea-agents@latest inspect-web-page http://127.0.0.1:9222 <Step 2 拿到的真实 targetId> --filter-output normalized_result
- evidence_id：<从这次 stdout 里逐字抄的 ev_…64 位十六进制>
- 浏览器：Edg/155.0.4283.45（protocol_version 1.3，js_version 15.5.9.4）
- 目标 URL：http://127.0.0.1:8077/
- 观察条件：headless=new；未点开任何菜单；未禁用优化；观察窗 500ms（默认）
- 完整性：completeness.status=parsed；parse_failures 未出现
- 用途：harness
- 探针校验和：sha256(tools/rea_probe_site/app.js，按 LF 算) = <下面那条现算命令的 64 位十六进制>
- 取证时间：2026-10-13T<HH:MM:SS>+08:00

## 摘录（逐字，未改写）

```json
<把 stdout 里支撑结论的那几行贴进来，别整包贴——内存只有 2GB>
```

## 读数含义

- targetId 由同一次趟次的 `list-browser-targets` 给出，三条命令共用。
- 校验和这样拿（**按 LF 算**，与校验器同口径；别用 `sha256sum`——本机 core.autocrlf=true
  时工作树里是 CRLF，它会算出另一个值，而校验器读的是行尾归一后的字节）：
  `python -X utf8 -c 'import pathlib,hashlib;p=pathlib.Path("tools/rea_probe_site/app.js");print(hashlib.sha256(p.read_bytes().replace(b"\r\n",b"\n")).hexdigest())'`
  **这一串是反编造针**：没在这棵树上真跑过的人抄不出来；改过 app.js 也会让它失效，从而暴露旧证据。
- 尖括号只是本模板的记号。**落档时一律换成真实值**——校验器把六把必填键里的
  尖括号当占位符直接拒绝。
```

- `probe-bundle.md`：`命令` 用 Step 3 第二条（含 `--allowed-origins http://127.0.0.1:8077`），摘录要含 `observations` 下实际出现的键名（`endpoints`／模块或 chunk／`routes`）。`fetch("/data.json")` 应当让端点面非空；真为空就照实写「本次 endpoints 为空」并解释，不许美化。
- `probe-events.md`：`命令` 用 Step 3 第三条，摘录要能读出 `pointerdown`（`app.js` 里挂的就是它）。

- [ ] **Step 6: 写三份模板与 README**

`docs/forensics/_templates/l0-capture.md`＝Step 5 的骨架原样（占位符留着，模板不受校验器走查）。
`docs/forensics/_templates/spec-entry.md`：

```markdown
# 规格：<面名>

<!-- 表头逐字，校验器按整行比对；改表头＝改契约，要重新裁定。 -->
| 条目号 | 规格句 | 判据 | 判据类型 | L0 依据 |
|---|---|---|---|---|

<!--
条目号：TV-<面大写>-<两位序号>，例如 TV-DW-01。整个仓库内不许重复，两份表各写一遍也会被报出来。
规格句：写能被测试打的行为句子，不写「TV 有一个工具栏」这种描述。
判据：至少 12 个字符，且具体到「用哪条命令／在哪个 selector 上／数出什么」；
      写不出判据的条目不算条目——那就先别写这一行。
判据类型：只能填 DOM / 状态 / 像素 三选一。本批证据只撑得起前两类，别为了填满列
          去写没跑过的像素判据。
L0 依据：l0/ 下真实存在的文件名，可以多引用（顿号或逗号分隔）。
-->
```

`docs/forensics/_templates/gap-matrix.md`：

```markdown
# 差距矩阵

<!-- 表头逐字。一条规格条目一行，不多不少。 -->
| 条目号 | 状态 | 本仓坐标或搜索记录 | 优先级 | 说明 |
|---|---|---|---|---|

<!--
状态：已有 / 部分 / 缺 / 不可复刻。
  已有、部分 → 第三列写 file:line；校验器只验「文件存在＋行号不越界」，
    「那一行指的是不是那回事」只有打开文件的人判得了 —— 每条都要自己复测。
  缺 → 第三列写「未找到：<你搜过的 needle>」，别人照着 grep 就能复跑；写完自己先跑一遍。
  不可复刻 → 说明列写清被什么挡住（合规／需要后端／需要授权）。
优先级：高 / 中 / 低 / -（还没排到就写 -，别硬填；排期是 P3 的事）。
-->
```

`docs/forensics/README.md` 至少七段，内容只用本计划已确立的事实：

1. **这是什么**：REA 取证漏斗的产物目录，L0 观察 → L1 规格 → L2 差距。
2. **三份约定的机器判据**：把 `L0_REQUIRED_KEYS` 六把键、`SPEC_HEADER`、`MATRIX_HEADER` 逐字列出，说明不满足就 rc=1。
3. **怎么跑校验器**：`python -X utf8 tools/forensics_audit.py`（rc=0 clean／rc=1 有违规）；测试 `python -X utf8 -m pytest tools/test_forensics_spec.py -q`。**注明它当前只在本地跑，不在 CI**（Global Constraints 第 10 条）。
4. **怎么起一趟取证**：spec §5 统一前置三行＋四条实测坑（URL 只能当 Edge 的命令行参数；`--allowed-origins` 裸值；一次一面；必带 `--filter-output` 或 `--token-limit`）。
5. **本机不可用的两条路**（spec §2.4）：吃磁盘路径的命令一律 `ESTALE`；`analyze-javascript-application` 目录模式 `integrity_mismatch` ⇒ 证据只走 stdout＋逐字摘录；「分析自家源码」改判为**对称取证**（对自家 dev server 跑同一套命令）。
6. **合规三条硬线**（spec 裁定 1）＋ `frontend/src` 的 5 文件主机白名单原文。
7. **状态语义**：`docs/forensics/` 不存在＝骨架没建（测试大声 skip）；存在但畸形＝红。`_templates/` 与两个 `_example.md` 不受走查，其形状由测试钉。

- [ ] **Step 7: 校验器实跑必须绿**

Run: `python -X utf8 tools/forensics_audit.py`
Expected: `forensics audit: clean`，rc=0。
红了就改**记录**，不许改校验器——校验器是被测试钉住的契约，为通过而放宽它等于把纪律摘掉。

- [ ] **Step 8: 提交**

```bash
git add -- tools/rea_probe_site/index.html tools/rea_probe_site/app.js tools/rea_probe_site/data.json
git add -f -- docs/forensics/README.md docs/forensics/_templates docs/forensics/l0
git commit -s -m "$(cat <<'EOF'
docs(forensics): 取证骨架落地，本地探针页跑通 A1/A2/A4 全链

三份 harness L0 是 spec §2.4 结论的复验：只有 loopback CDP 单趟命令可用，
证据只能从 stdout 逐字抄。harness 用途的 L0 少了探针 app.js 的现算校验和就红，
这条针挡的是「没跑过却写了记录」。

docs/ 被 .gitignore 整目录忽略，全部 -f 加。
EOF
)" -- tools/rea_probe_site docs/forensics
```

---

### Task 6: P0 收口——一条能被测试打的规格条目＋活树测试

**Files:**
- Create: `docs/forensics/l0/_example.md`、`docs/forensics/spec/_example.md`
- Modify: `tools/test_forensics_spec.py`

**Interfaces:**
- Consumes: T5 的三份 harness L0、`audit_forensics`
- Produces: 活树测试三条；两个 `_example.md` 靠精确文件名豁免审计，其形状由测试钉住

- [ ] **Step 1: 写活树测试（第三条此刻应红）**

追加到 `tools/test_forensics_spec.py`（`import re` 补进文件顶部）：

```python
REPO_ROOT = Path(__file__).resolve().parents[1]
LIVE_FORENSICS = REPO_ROOT / "docs" / "forensics"
live_forensics = pytest.mark.skipif(
    not LIVE_FORENSICS.is_dir(),
    reason="docs/forensics/ 还没建（Task 5 之前这是真状态）——大声 skip，不是通过",
)


@live_forensics
def test_live_forensics_tree_is_clean():
    assert audit_forensics(LIVE_FORENSICS, REPO_ROOT) == []


@live_forensics
def test_live_forensics_tree_is_not_vacuous():
    """全绿也可能什么都没测：一棵只有一张空表的树和一棵没捕过的树都返回 []。"""
    captured = [p for p in (LIVE_FORENSICS / "l0").glob("*.md") if p.name != "_example.md"]
    assert len(captured) >= 3, captured


@live_forensics
def test_live_example_files_use_the_contract_shape():
    """_example.md 被审计豁免，所以它的表头／条目号／六把键形状只能在这里单独钉。"""
    spec = (LIVE_FORENSICS / "spec" / "_example.md").read_text(encoding="utf-8")
    assert SPEC_HEADER in spec
    ids = re.findall(r"^\| (TV-[A-Z][A-Z0-9]*-\d{2}) \|", spec, flags=re.M)
    assert len(ids) == 1, ids
    l0 = (LIVE_FORENSICS / "l0" / "_example.md").read_text(encoding="utf-8")
    for key in L0_REQUIRED_KEYS:
        assert f"- {key}：" in l0, key
```

Run: `python -X utf8 -m pytest tools/test_forensics_spec.py -q`
Expected: 前两条绿（T5 已完成），`test_live_example_files_use_the_contract_shape` 因 `_example.md` 不存在而红（FileNotFoundError 或断言失败都算这一红）。

- [ ] **Step 2: 重新起一趟取证，写 `docs/forensics/l0/_example.md`**

**不许**把 T5 的旧读数换个文件名当新证据。按 T5 Step 2–4 重起一次 Edge＋静态服务（同一页即可），跑 `inspect-web-page`，用这次的新 `evidence_id` 落这份文件，六把键全写、`用途：` 那行**不写**（`用途` 只能填 harness/规格/基线；样例文件靠文件名豁免，不需要用途）。文末加一句「本记录支撑 spec/_example.md 的那条条目」，然后照样清场。

- [ ] **Step 3: 写 `docs/forensics/spec/_example.md`**

```markdown
# 规格样例：一条能被测试打的条目长什么样

| 条目号 | 规格句 | 判据 | 判据类型 | L0 依据 |
|---|---|---|---|---|
| TV-EX-01 | 图表工具栏是一组可点击按钮的横向容器，画线工具以按钮形式并列，至少含趋势线／斐波那契／画笔三类 | inspect-web-page 的可达文本里 id=toolbar 的容器下能数出 ≥3 个 button，且字面为 Trend line、Fibonacci、Brush | DOM | _example.md、probe-skeleton.md |

这条是**格式样例**：文件名带下划线前缀 ⇒ `forensics_audit` 按精确文件名豁免，它不进差距矩阵，
也不冒充任何第三方观察结论。真正的 TV 面条目从 P1 批次起写在 `spec/<面名>.md` 里，一律要过校验器。
它的判据之所以算数，是因为同一句话在本地探针页上真跑过一次、读数就贴在 L0 的摘录块里。
```

- [ ] **Step 4: 复跑，确认全绿**

```bash
python -X utf8 -m pytest tools/test_forensics_spec.py -q
python -X utf8 tools/forensics_audit.py
```
Expected：测试全绿；审计 `clean`（rc=0，证明样例豁免生效、`TV-EX-01` 没被当成凭空条目）。

- [ ] **Step 5: P0 判据自查**

spec §7 P0 的判据是「对本地中立页走完 A1＋A2 并产出 1 条能被测试打的规格条目；这一步同时是 §2.4 结论的复验」。逐条对着读：① A1/A2/A4 三份 harness L0（T5）；② `TV-EX-01` 带 DOM 判据，且判据里那句 `id=toolbar 下数 button` 的读数在 Step 2 那份 L0 的摘录里看得见；③ 全链没碰任何第三方站点。

- [ ] **Step 6: 提交**

```bash
git add -f -- docs/forensics/l0/_example.md docs/forensics/spec/_example.md
git add -- tools/test_forensics_spec.py
git commit -s -m "$(cat <<'EOF'
docs(forensics): P0 收口——一条带 DOM 判据的样例规格＋活树非空钉

样例件按精确文件名豁免审计，所以它的表头、条目号形状与六把键改由测试单独钉。
活树测试还断言 l0/ 下非样例证据 ≥3 份：一棵空树也能全绿，那种绿没有意义。
样例的 evidence_id 来自重新起的一趟，不是把上一趟的读数换个文件名。
EOF
)" -- docs/forensics tools/test_forensics_spec.py
```

---

### Task 7: P1 批次清单＋停等用户点头

**这是一个停等任务。** spec §9 第 4 条白纸黑字：第一次对 tradingview.com 实抓之前，先报打算抓哪几面。

**Files:**
- Create: `docs/forensics/batch-A-playbook.md`

**Interfaces:**
- Consumes: spec §5 工单表、§2.4 的本机限制、T1–T4 的契约
- Produces: 一份给人读的批次清单（哪几面／命令／预期／被挡的面怎么办）＋**用户的一句「可以」或「改哪几面」**

- [ ] **Step 1: 写批次清单，把「可达／不可达」讲实话**

```markdown
# 批次 A：TV 图表页观察（P1）

## 打算跑的面（可达，无需页内交互）

| 面 | 命令 | 取什么 |
|---|---|---|
| A1 页面骨架与可达文本 | `rea inspect-web-page … --filter-output normalized_result` | 面板分区、工具栏按钮清单 |
| A2 脚本与端点面 | `rea analyze-web-bundle … --observation-ms 2000 --filter-output normalized_result.observations` | endpoints／模块图／路由 |
| A4 元素事件面（每条 selector 一趟） | `rea inspect-web-event-listeners … "<selector>" --token-limit 400` | 该元素挂了哪几类原生监听器＋源码位置 |

A4 的 selector 候选（跑之前先由 A1 的可达文本确认它们真在 DOM 里，确认不了就不跑）：
图表 canvas 容器、工具栏容器、价格轴、时间轴、图例区。一条 selector 一份 L0。

## 明说跑不了的面（不硬凑）

A3 展开工具条、A5 点开周期下拉、A6 右键菜单、A7 指标对话框、A12 Pine 编辑器、A13 告警对话框
都要**页内交互**。本机能做交互的 `capture-browser-scenario` 入参是**文件路径**，而 spec §2.4
已实测一切吃磁盘路径的 REA 命令报 `ESTALE` ⇒ 这一批拿不到。
处置：这些面各写一份 `状态：不可取证` 的 L0（带 `命令：` 与 `原因：`），不在 L1 里给它们编条目。

## 闸门与停手条件

- 只读公开页面，GET only；不登录、不绕过检测、不重试撞限流。出现空白页／空 targets／请求被拒
  即标「不可取证」并停（spec §10 对策原话）。
- 跑之前先探一次连通性；网络异常按既有诊断顺序（代理端口拒连时先不带 --proxy 重发再判网络全灭）。
- 每面只跑一趟，一趟一份 L0；`--filter-output` 或 `--token-limit` 必带。
- 只用 stdout，摘录进仓库；不落地任何第三方脚本或资产。

## 预期产物

`docs/forensics/l0/tv-a1-page.md`、`tv-a2-bundle.md`、`tv-a4-<selector>.md`×N，
加 `docs/forensics/spec/drawings.md`、`chart-interaction.md` 与差距矩阵的行。
```

- [ ] **Step 2: 提交清单（不含任何抓取结果）**

```bash
git add -f -- docs/forensics/batch-A-playbook.md
git commit -s -m "$(cat <<'EOF'
docs(forensics): 批次 A 抓取清单——可达面与不可达面分开列

要页内交互的面在本机拿不到（capture-browser-scenario 的入参是文件路径，而一切吃
磁盘路径的 REA 命令报 ESTALE）。这句话写在开工前，而不是等等不来证据时再解释。
EOF
)" -- docs/forensics/batch-A-playbook.md
```

- [ ] **Step 3: 停下来，向用户报三件事并等回复**

报：① 打算抓的三面（A1／A2／A4×N selector）与具体 URL；② 明说拿不到的面与原因；③ 单趟必带限流旗标、只读、不重试撞限流。**得到明确同意才进 Task 8**。用户若换面／减量／加面，改本文件重跑 Step 2 再问一次。

---

### Task 8: 执行批次 A——真实 TV 的 L0 记录

**Files:**
- Create: `docs/forensics/l0/tv-a1-page.md`、`docs/forensics/l0/tv-a2-bundle.md`、`docs/forensics/l0/tv-a4-<selector>.md`（每个 selector 一份）
- 被挡的面：同样一份，但用 `状态：不可取证` ＋ `命令：` ＋ `原因：`

**Interfaces:**
- Consumes: T7 清单（已批准版）；T5 的 Edge 启动配方；`_audit_l0` 的形状要求
- Produces: `docs/forensics/l0/` 下 `tv-*` 命名的真实证据，供 T9 的 `L0 依据` 列引用

- [ ] **Step 1: 探连通性，再按 T5 Step 2 起浏览器**

```bash
curl -sS -o /dev/null -w '%{http_code}\n' --max-time 20 https://www.tradingview.com/chart/
```

非 200／超时 ⇒ 按既有诊断顺序处理；仍不通就把本任务记为「环境未就绪」并停，**不改判据、不写假证据**。
通则用 spec §5 的统一前置起 Edge（URL 换成 `https://www.tradingview.com/chart/`），取 `TID`。

- [ ] **Step 2: 一面一趟，按 T7 清单顺序跑，跑完一条立刻落一份 L0**

```bash
npx -y rea-agents@latest inspect-web-page http://127.0.0.1:9222 "$TID" --filter-output normalized_result
npx -y rea-agents@latest analyze-web-bundle http://127.0.0.1:9222 "$TID" \
  --observation-ms 2000 --filter-output normalized_result.observations
npx -y rea-agents@latest inspect-web-event-listeners http://127.0.0.1:9222 "$TID" "<selector>" --token-limit 400
```

每份 L0 六把键齐全，末行 `取证时间` 用真钟点。**新落成的 TV L0 先标 `用途：基线`**（孤证规则只豁免 `harness`／`基线`；T9 引用它们之后改成 `用途：规格`，那时被引用就不再需要豁免）。

- [ ] **Step 3: 被挡的面按形状记录，不编条目**

出现空白页／空 targets／请求被拒 ⇒ 写一份 `状态：不可取证` 的 L0：`命令：` 填真跑过的那条，`原因：` 填读到的现象。**不绕过、不重试撞限流。**

- [ ] **Step 4: 清场**

同 T5 Step 4：只杀我们自己起的 PID，删 `$TEMP/rea-cdp-profile`，`netstat` 复验 9222 已释放。

- [ ] **Step 5: 审计必须仍然绿**

Run: `python -X utf8 tools/forensics_audit.py` → `forensics audit: clean`
任何形状类红（占位符／evidence_id／限流旗标缺失）都改记录，不改校验器。

- [ ] **Step 6: 提交**

```bash
git add -f -- docs/forensics/l0
git commit -s -m "$(cat <<'EOF'
docs(forensics): 批次 A 的真实证据——A1/A2/A4 各一份 L0

证据只从 stdout 逐字抄（本机无文件通道）。被页内交互挡住的面另立「不可取证」
记录，写清试过哪条命令、看到什么现象。新落成的先标 用途：基线，被规格引用后
再改 用途：规格——孤证规则故意逼着「捕了就得翻」。
EOF
)" -- docs/forensics/l0
```

---

### Task 9: L1——把批次 A 翻成规格条目表

**Files:**
- Create: `docs/forensics/spec/drawings.md`、`docs/forensics/spec/chart-interaction.md`
- Modify: `docs/forensics/l0/tv-*.md`（`用途：` 改口）、`docs/forensics/batch-A-playbook.md`（末尾记偏差）

**Interfaces:**
- Consumes: T8 的 `tv-*` L0 文件名
- Produces: 条目号集合（`TV-DW-NN`、`TV-CI-NN`），T10 的差距矩阵要为每条各留一行

- [ ] **Step 1: 逐面填表，条目只能从证据来**

每条三个硬要求（校验器会拒）：条目号形状；判据 ≥12 字符且具体到「哪条命令／哪个 selector／数出什么」；`L0 依据` 指向 T8 真实落地的文件名。判据类型只能 `DOM`／`状态`／`像素` 三选一——本批只有 A1/A2/A4 三类证据，`像素` 暂时用不上，**别为了填满列去写没跑过的判据**。
把被引用的 L0 的 `用途：基线` 改成 `用途：规格`；摘录块保持原样（改摘录＝污染证据）。

- [ ] **Step 2: 条数目标与诚实的下限**

spec §7 P1 写的是「规格条目 ≥20」，那是**按 A1–A6 六面**算的；本批可达只有 A1/A2/A4（T7 已说明原因）。
**本片的裁定：下限 ≥12 条来自批次 A 的条目**，依据是 spec §12 自己给的降级口径（取证面拿不到判据级证据就收窄成只做 A1/A4）。这处偏差同时写进 `batch-A-playbook.md` 末尾与 `项目档案.md` 的对应小节。凑不满 12 条**不要编**：按 §4 红线，写不出判据的不算条目，宁可报「本批只有 N 条成立」。

- [ ] **Step 3: 审计**

Run: `python -X utf8 tools/forensics_audit.py`
Expected: 只剩差距矩阵类违规（`有 N 条规格条目但 docs/forensics/gap-matrix.md 不存在`）。出现形状类红就说明条目是硬凑的——回去改句子，而不是改校验器。

- [ ] **Step 4: 提交**

```bash
git add -f -- docs/forensics
git commit -s -m "$(cat <<'EOF'
docs(forensics): 批次 A → L1 规格条目表（画线面与图表交互面）

判据列全是指向具体命令与 selector 的句子，不写「TV 有工具栏」这种描述。
§7 那句「≥20 条」按六面算，本批可达三面 ⇒ 落地 ≥12，偏差按 §12 的降级口径
显式记在批次清单末尾。被引用的 L0 从 用途：基线 改成 用途：规格。
EOF
)" -- docs/forensics
```

---

### Task 10: L2——差距矩阵，坐标逐条自己复测

**Files:**
- Create: `docs/forensics/gap-matrix.md`

**Interfaces:**
- Consumes: T9 的全部条目号；`frontend/src/**` 的真实行号
- Produces: 一条规格一行的矩阵；P3 排优先级时的唯一输入

- [ ] **Step 1: 每条规格一行**

`已有`／`部分` ⇒ 第三列 `file:line`，**写之前亲自打开那个文件**确认那一行确实是那回事（设计轮的教训：现状报告里的坐标有两处出入）。校验器验「文件存在＋行号不越界」，但「指的是不是那回事」只有读得出来。
`缺` ⇒ 第三列 `未找到：<needle>`，needle 要别人照着 grep 就能复跑。
`不可复刻` ⇒ 说明列写清被什么挡住（合规／需要后端／需要授权）。
优先级列本片一律 `-`：排期是 P3，本片不越界替它决定。

- [ ] **Step 2: 复跑每一条 needle**

```bash
grep -rn --include=*.ts --include=*.tsx "<needle>" frontend/src | head
```

有命中 ⇒ 那行写错了，改成 `已有`／`部分` 并补坐标。（「写着未找到但一搜就有」是本仓记录过的假缺陷形状之一。）

- [ ] **Step 3: 审计与测试全绿**

```bash
python -X utf8 tools/forensics_audit.py
python -X utf8 -m pytest tools/test_forensics_spec.py -q
```
Expected：`clean`；测试全绿（含 `test_live_forensics_tree_is_clean`、`test_live_forensics_tree_is_not_vacuous`）。

- [ ] **Step 4: 提交**

```bash
git add -f -- docs/forensics/gap-matrix.md
git commit -s -m "$(cat <<'EOF'
docs(forensics): L2 差距矩阵——每条规格一行，坐标逐条自复测

已有/部分的行号由校验器验存在与不越界，但「指的是不是那回事」只有打开文件才判
得了；每条 未找到 的 needle 都当场 grep 复跑过。优先级列留 -，排期归 P3。
EOF
)" -- docs/forensics/gap-matrix.md
```

---

### Task 11: 六道门复跑＋落档＋记忆更正

**Files:**
- Modify: `项目档案.md`（仓库根，工作树 CRLF）
- Modify: 项目记忆 `ops-delivered-features-and-comparisons.md` ＋ 两份 `MEMORY.md` 索引；用户记忆 `env-rea-web-forensics.md`

- [ ] **Step 1: 六道门**

```bash
cd frontend && npx tsc -b && npx vitest run && npm run build; cd ..
python -X utf8 -m pytest tools/test_wiki_drift.py tools/test_wiki_qmind.py -q
python -X utf8 -m pytest tools/test_forensics_spec.py -q
bash tools/wiki_freshness_gate.sh
bash tools/ci_grep_gates.sh
```

后两条已知恒红 ⇒ 复述红项原文并归因（证「本片 0 贡献」），不调阈值。本片**不动前端代码**，前三道门预期与本片改动无关，但照样复跑并记录读数。

- [ ] **Step 2: 未来函数自查在本片的适用面**

spec §8 的 Bar Replay 五步自查针对指标／信号交付；本片是取证骨架＋文档，不产出任何指标 ⇒ 判据退化成一条可复跑断言：本片提交里**不含** `frontend/src/**` 的改动。

```bash
git diff --name-only <本片第一笔的父提交> HEAD -- frontend/src | cat
```

预期：空输出。非空即越界，回退并查是谁动的。

- [ ] **Step 3: 档案落一节（`项目档案.md` 一轮一节）**

该文件工作树是 CRLF ⇒ 按既有配方**在 bytes 层追加**，别用文本模式重写整文件（`Path.write_text` 的默认换行会把 CRLF 写进树）。节内容：本片做了什么／L0 份数与规格条目数（**当场数出来的数**）／`forensics_audit` 的 rc 读数／六道门读数／被挡面清单／§7「≥20」→ 本片「≥12」的偏差声明。

- [ ] **Step 4: 复跑 wiki 守卫（档案面排在最后，改完必须复验）**

```bash
python -X utf8 -m pytest tools/test_wiki_drift.py tools/test_wiki_qmind.py -q
bash tools/wiki_freshness_gate.sh
```

- [ ] **Step 5: 提交**

```bash
git add -- 项目档案.md
git commit -s -m "$(cat <<'EOF'
docs(archive): ㊽ REA 取证骨架与批次 A——三份约定进机器判据，规格条目落差距矩阵
EOF
)" -- 项目档案.md
```

- [ ] **Step 6: 记忆更正**

- 项目记忆 `ops-delivered-features-and-comparisons.md`：加 ㊽ 一段（分支＋提交坐标＋被挡面）。
- 用户记忆 `env-rea-web-forensics.md`：补「**需要页内交互的观察面在本机拿不到**（`capture-browser-scenario` 入参是文件路径 ⇒ 撞 ESTALE）」——这条下次会直接决定批次形状。
- 两份 `MEMORY.md` 索引各加／改一行钩子，条数引用一律现数。

- [ ] **Step 7: 停在这里并报告**

P1 产物就绪即报告。下一步（P2 对称取证／P3 排优先级／P4 第一个实现片）需要新的 spec 与计划；§9 那五项（升 Node／`rea setup`／杀软白名单／CI 套件行／合回 main＋推送）任一项都要单独点头。

---

## 计划自查（写完这份计划后跑过一遍）

**1. 覆盖 spec 的哪些条目**

| spec 条目 | 落在哪个任务 |
|---|---|
| §4 L0 完成判据（evidence_id／完整性／parse_failures） | T1 |
| §4 L1「写不出判据不算条目」红线 | T2 |
| §4 L2 三态对账＋「未找到」要能复跑 | T3（机器面）＋T10（执行面） |
| §5 工单 A1／A2／A4 | T5（本地页）＋T8（TV） |
| §5 工单 A3／A5—A15 | **本片不做**，T7 清单逐条写明被页内交互挡住 |
| §7 P0 判据（本地页跑通＋1 条能打判据的条目） | T5＋T6 |
| §7 P1 判据（条目带判据、每条 L0 有 evidence_id） | T8＋T9；条数按三面从 ≥20 收窄到 ≥12，T9 Step 2 显式记偏差 |
| §8 六道门＋活体＋未来函数 | T11（活体即 T5/T8 的实跑；本片无指标交付 ⇒ 自查退化为「没动 frontend/src」） |
| §9 第 4 项（抓 TV 先报面） | T7 停等 |
| §9 第 1/2/3/5 项 | **不在本片**，T11 Step 7 交回用户 |
| §3 裁定 1（合规三硬线） | T4（机器红线）＋Global Constraints 4 |
| §3 裁定 3（不产生项目外副作用） | T5/T8 的清场步骤＋Global Constraints 2 |
| §2.4 两条坏路的复验 | T5（本地页全链）＋T11 Step 6 的记忆更正 |
| §12 的降级口径 | T9 Step 2 用它作 ≥12 的依据 |

**2. 占位符扫描**：无 TBD/TODO。尖括号占位只出现在模板与「命令里换真实 targetId」这类明确指令处；校验器把六把必填键里的尖括号当违规（T1 的 `test_placeholder_angle_brackets_are_refused`），所以落档件留不下占位符。

**3. 类型一致性**：`audit_forensics(forensics_root, repo_root) -> list[str]` 与 `audit_tv_host_allowlist(repo_root) -> list[str]` 在 T1/T4 定义，T2/T3/T5/T6/T10 使用一致；`_audit_l0` 的 `(v, purpose)` 二元组在 T3 被 `purposes` 字典消费，签名未变；`_table` 自 T2 起就是 `(seen, rows, bad)` 三元组，T3 的 `_audit_matrix` 同签名；表头三串与 `L0_REQUIRED_KEYS` 在实现、测试、模板、README 四处文字逐字一致。

**4. 三处刻意设计（不是疏漏）**：① T8 让 `用途：规格` 的 L0 在被引用前就报红——捕了就得翻；② `_example.md` 按**精确文件名**豁免（不是 `_*` 通配），且其形状由 T6 的测试钉住，避免「拿豁免目录藏证据」；③ T3 的 `_tree` 夹具必须造出被引用的 `frontend/src/lib/chartDrawings.ts`，否则矩阵针会因为文件不存在而红，掩盖真正的判据。

---

## 执行期更正（2026-10-13，Task 5 跑通之后）

下面是计划正文里被实测推翻或补强的句子。**按面名与任务名指认，不钉行号**（行号会漂）；
计划本体按「带日期追加子句」的既有纪律原地保留，不回头改写。

1. **`--filter-output normalized_result` 会把顶层 `evidence_id` 一起滤掉。**
   本计划所有「跑 A1 然后逐字抄 `evidence_id`」的指令都因此跑不通：那一趟的 stdout 第一行直接是
   `normalized_result:`，全文 0 次出现 `evidence_id`（判据：留档的 `inspect-web-page.txt` 与
   `inspect-web-page-with-evidence-id.txt` 一对比，12,695 字节 0 命中 vs 12,776 字节 1 命中）。
   可用形态是把主键一起点名：`--filter-output evidence_id,normalized_result`。
   「Task 5：取证骨架落地＋本地探针闭环」的三条命令、「Task 7：P1 批次清单」里 A1 那一行的命令、
   以及「统一前置」里给样板命令的那几处，一律照此替换。
2. **`--token-limit` 小了会静默截掉你要读的那个键，不报错。**
   `inspect-web-event-listeners` 整份约 1,477 tokens：`--token-limit 400` 截出来的那份
   （1,234 字节）里 `pointerdown` **0 命中**，而不限流的那份（5,361 字节）2 命中。
   ⇒ 计划里凡是写 `--token-limit 400` 去拿「该元素挂了哪几类原生监听器」的地方，都要改成
   先不限流跑一次、确认要读的键在，再决定收口口径；`--token-limit` 只当**体积**闸门用。
3. **REA 的字段名与 completeness 形状逐面不同，不能一个值套三份记录。**
   `list-browser-targets` 给的是 **`target_id`**（不是 `targetId`）。`completeness`：A1＝`policy_filtered`
   ＋`policy_filtered_sections[]`（无解析失败计数键）、A2＝`complete`＋`parse_failures: 0`、A4＝**整块不存在**。
   「Task 5」里那份骨架模板写的 `completeness.status=parsed` 是设计轮读数，落档时必须按当次 stdout 写。
4. **A1 的读数面不含属性值——只有属性名。**
   `dom` 段每个节点给 `attribute_names`（如 `[3]: id,width,height`），全份 stdout 里
   **搜不到 `toolbar` 这个词**（那是探针页 `<div id="toolbar">` 的值）。按钮文案默认也不可得：
   `accessibility.text_capture.status: not_approved`、`retained_bytes: 0`、18 个可达名称被策略扣掉；
   带 `--include-accessibility-text` 才翻成 `included`（`retained_bytes: 130`）并真带出
   `role: button` ＋ `name: Trend line／Fibonacci／Brush` ＋ `parent_id`。
   ⇒ 任何 A1 类判据只能按 **`role`／`name`／`parent_id`** 指认元素，不能按 `id=…` 或 CSS 选择器指认
   （选择器只在 A4 作为**入参**存在，那是「我告诉它看哪」，不是「我观察到了什么」）。
   「Task 6：P0 收口——一条能被测试打的规格条目＋活树测试」的样例条目、「Task 9：L1 规格条目表」的全部判据，
   都按这条口径写。
5. **`taskkill` 只认 Windows PID。** 计划里 Step 4 那种 `taskkill //PID "$EDGE_PID"` 用 `$!` 取号在本机不成立
   （Git-Bash 的 PID 不是 Windows 的），实测结果是 `python.exe`／`msedge.exe` 各留一个进程占着 8077/9222，
   临时 profile 目录 `rm -rf` 一路 `Device or resource busy`。取号一律走 `netstat -ano`，
   再用 `tasklist //FI "PID eq <号>"` 只读核对身份，然后才杀。**依旧绝不按镜像名杀 `msedge.exe`。**

---

## 执行期更正二（2026-10-13 晚，Task 6 落地之后）：页内交互在本机可用，Task 8 的「不可取证」名单要缩

**绑住 spec §2.4.1（带日期追加子句，逐字到 `evidence_id` 与读数键路径那一级）。** 上一份更正里
「A1 只给 `attribute_names`、不给属性值」等结论**全部保留**；这里否证的是另一条操作性推论：
「需要先在页面上点一下才出现的面（Task 7 面表里那批『明说跑不了』）拿不到」。

- 实测：`capture-browser-scenario` 吃**内联 JSON**，`browser.mode: connect` 只要 `cdp_endpoint`＋`target_id`，
  一步 `click` 在探针页上 `status: completed`／`error: null`；`capture.at_end: ["url","dom","accessibility","screenshot"]`
  能在**同一趟**里给出点击后的可达树（`accessibility.value.text` 逐字含 `- button "Trend line"` 这一族）与 PNG 工件。
- 对 **Task 8** 的三处具体改法：
  1. 「被挡的面＝写一份 `状态：不可取证`」那条支路，适用范围**收窄到**需要登录／需要 `executable_path` 的 `launch` 模式／
     一切吃磁盘路径的命令。A3（展开画线工具条）、A5（周期下拉）、A7（指标对话框）、A8（图例／数据窗口）
     改为「先 `click` 一步、再读同趟 `at_end` 工件」；A6（右键菜单）要先确认 `right_click` 这个 action 名，未确认前仍按不可取证写。
  2. **像素判据（`判据类型：像素`）自此可用**，但硬红线是 `data_base64` **绝不进仓库**——
     L0 只落 `sha256`＋`bytes`＋`media_type` 三键。这条同时是合规要求（spec 裁定 1 的表达层）与内存要求。
  3. `--filter-output` 的**下标键路径不生效**（`…steps[1].artifacts.screenshot` → `steps: []`，`rc=0` 静默空）
     ⇒ 场景类证据必须整份落到仓外留档再本地切片，键路径过滤只用于非下标面。
- **范围重定＝先停先问**：扩面改的是批次内容，而本计划 Task 7 的停等条款（＋计划 Global Constraints 第 11 条）
  要求「改动批次内容要重新问一次」。所以 **Task 8 在用户答复扩面问题之前不派发**；
  这份更正只写清「怎么改」，不等于授权「改」。

---

## 执行期更正三（2026-10-13 晚，Task 6 评审收口之后）：三项答复到手，playbook 已重写，Task 8 解锁

**上一份更正里那条「在用户答复之前不派发」现在生效完了——答复已到手，三个选项逐字如下：**

1. 批次 A 扩面：«全扩：A3＋A5＋A7＋A8（推荐）»
2. 对 `tradingview.com` 派发交互动作：«允许：只做打开类动作（推荐）»
   （选项自带的约束原文：只点自己触发的 UI，不登录／不保存／不交易，见 429 或验证码立刻停手并记不可取证）
3. 像素面：«纳入，但只落 sha256＋bytes＋media_type（推荐）»

**落地面＝`docs/forensics/batch-A-playbook.md` 已按这三条重写**（前言记点头、§1 补 A3／A5／A7／A8／A9／A15 六行、
§2 补 `at_end` 取舍与 `dom` 红线、§3 补下标过滤、§4 补空面前置检查与场景完整性两层、
§5 从「明说跑不了」改成三档、§6 闸门从 GET only 改成打开类动作、§7 补产物名）。
**Task 8 的命令口径以重写后的 playbook 为准**，不再以本计划 Task 7 的旧面表为准——旧面表里那批「明说跑不了」已被否证。

本份更正要补的是上一份里几处**读数级**的错与缺（现读取证，出处同时写进 spec §2.4.1 与 playbook §5①）：

- `capture.at_end` 的值域是 **6** 个（`screenshot,dom,accessibility,url,history,storage`），
  上一份写成 4 个是把「当次用到的样本」当成了值域。`action` 词表 9 值里**没有右键**
  ⇒ 上一份那句「A6 要先确认 `right_click` 这个 action 名」现在有了答案：**这个词不存在**，
  A6 记「未验证」（不是「不可取证」），也不许用左键硬凑一个「等价于右键」的读数；A14 快捷键同批不跑。
- **`dom.value.text` 是整段页面 HTML 正文**（实测 `bytes: 475`，逐字含 `<!DOCTYPE html>`）——
  上一份只红线了 `data_base64`，漏了这一条。对第三方站点它同样撞裁定 1 第 1 条（表达层／标记），
  ⇒ 交互复捕默认取 `accessibility`，`dom` 允许跑但 L0 最多落 `state`＋`sha256`＋`bytes`。
- 场景记录的**完整性有两层**且不同值：顶层 `completeness.status: incomplete`／`missing_sections[1]: events`／
  `equality_eligible: false`，逐步工件那层才是 `complete`。Task 8 写 `完整性：` 时抄顶层并解释 `events` 缺席的原因，
  否则会被读成「页面上没有事件」。
- 四个单趟 CDP 命令都有 `--allowed-origins <array>`（帮助写 *Optional*），而工具自己的 limitations 自陈
  「没有 allowed source URL 的脚本与控制台事件会被排除」⇒ A2 那面**空**的第一个嫌疑是 origin 写法而不是「对方没有」，
  已按裸值写进 playbook 每条单趟命令；仓内 `docs/forensics/l0/probe-bundle.md` 那条「未验证的猜测」由 Task 8 判定收口。
- 上一份那句「一步 `click` 在探针页上 `status: completed`」的**出处搞错了，已重新取证**：原先引的那份留档
  （`rea-t7/scenario-run2.txt`）里 click 实际是 `status: failed`＋strict mode violation，`completed` 属于第 0 步 `goto_start`。
  换成单元素 selector 的那趟（`rea-t8-click.txt`，`steps[3]` 三步全部 `completed`／`error: null`）才是支撑。
  ⇒ 「管道可用」与「一次点击落地」要分开说，Task 8 引用交互面时只准引后者。
- 两条操作性新事实：**不存在的 `role`／`name` 会把整趟挂住**（>2 分钟零产出后中止，留档停在 0 字节）
  ⇒ miss 探针别和真动作同趟；**非法入参不挂**（schema 校验跑在连浏览器之前，`cdp_endpoint` 指向死端口也秒回
  `invalid_request`）⇒ 逼词表这类探针不需要起现场。`wait_for_timeout` 的时长字段叫 `duration_ms`（不是 `timeout_ms`）。
- **Task 8 自己那段的 Step 2 三条命令是旧的，不要照抄**（本更正不重排任务正文，以免与已生成的简报脱节）：
  ① 三条都没带 `--allowed-origins`；② `--filter-output normalized_result` 会把顶层 `evidence_id` 一起滤掉
  （playbook §3①），主键必须与摘录同趟；③ A4 那条写的 `--token-limit 400` 正是 §3 点名的陷阱
  （探针页实测它把 `    - type:` 切在半截，`pointerdown` 拿不到）。
  以 playbook §1 那张表的命令为准；Task 8 的 Step 1／3／4／5／6 仍然有效。
