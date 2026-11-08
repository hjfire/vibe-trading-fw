# 自研 locale 覆盖层 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **本仓裁定（优先于上面那行默认推荐）**：用户自 2026-10-24 起拒绝 `Agent` 派单，故本片**一律用 `superpowers:executing-plans` 在本会话内串行执行**，不派子代理、不派评审席。独立评审由执行者按同一判据自审，并在报告里如实写明「未做独立子代理评审」。

**Goal:** 把本仓自研的 15 枚导航文案键 × 11 门语言从上游所有的 `frontend/src/i18n/locales/` 迁到本仓新增的 `frontend/src/i18n/fork/`，让那 11 枚上游文件回到逐字未改，同时每一门语言的有效 bundle 逐叶不变。

**Architecture:** 覆盖层照上游的 eager-en / lazy-其余形状做：`fork/en.json` 在 `init()` 之后用 `addResourceBundle(..., true, true)` 深合并进 en；其余 10 门在 `loadLanguage` 的 try 内、上游 bundle **之后**再深合并一次。类型面把 `CustomTypeOptions.resources.translation` 从 `typeof en` 扩成 `typeof en & typeof forkEn`。新增一套从磁盘发现语言的守卫，钉住「磁盘↔注册表双向相等／覆盖层内部平价／与上游键不相交／运行时逐语言解析／注册表派生的三族齐全／文案质量／切换终态」。

**Tech Stack:** TypeScript 5.7、i18next 26、react-i18next 17、Vite 8、Vitest 5（jsdom，`forks` 池，CLI 只认 `--maxWorkers`）、@testing-library/react 16（`waitFor`，`asyncUtilTimeout` 已由 `src/tests/setup.ts:13` 设为 5000ms）。

**Spec:** `superpowers/specs/2026-11-08-fork-locale-overlay-design.md`（**§九 是 2026-11-08 计划期更正，优先于 §一～§八**）

## Global Constraints

以下每条都是硬约束，每个 Task 的要求都隐含包含本节。

- 改动严格限定在项目范围内：全局 git 配置、Node/Python/pnpm/uv 工具链、`.pnpm-store`、SQLite 一律不许动。
- `wiki/**` 不碰；`.github/workflows/test.yml` 上游所有、只读；`frontend/src/i18n/__tests__/i18n.test.ts` 上游所有、**本片一字不改**；`frontend/src/i18n/locales/tsconfig.json` 上游游离件、**不动**。
- 提交一律 `git commit -s` ＋**显式 pathspec**；禁 `git add -A`／`git add .`／`git commit -a`。
- 本仓惯例是**每片一支**：实现提交全落 `feat/fork-locale-overlay`（Task 1 Step 1 建），收尾 `--ff-only` 合入本地 `main`（Task 9 Step 6）再推 `origin`。spec 与 plan 这两份计划期文档先在 `main` 上提交，作为本片分支的起点。
- 门 b 的商标 needle 不得出现在任何跟踪面（本计划、spec、新 JSON 都算）。要比对就在代码里拼出来（`'world' + 'quant'`），不要写整串。
- 恒红门先证「本片 0 贡献」再报告：**不调阈值、不改门、不清白名单**。
- 本片不新增任何指标或信号 ⇒ 未来函数自查不适用；但 Bar Replay 与画线面要在活体里顺手点一遍。
- 门册串行跑，不与重 CPU 活并发。
- 每条 Bash 命令都从仓库根 `E:/Vibe-Trading-main/Vibe-Trading-main` 起；`cd frontend` 之后**下一条命令的工作目录会留在那里**，所以凡带 `frontend/…` pathspec 的 git 命令必须在仓库根跑。
- 中文回复；命令给完整可复制形式。
- 上游坐标钉死 `2ac20879`（写作时现读）。**若 Task 0 读到 `upstream/main` 已不是这一枚，停下报告，不要改用新 sha 继续**——那会把上游改动夹带进本片，Task 5 的逐叶对账也会因此失败。
- 取值唯一真值源是 `git show b292dfb6:frontend/src/i18n/locales/<code>.json`，不靠任何转述。

### EOL 地籍（写作时现读，执行时复核）

| 文件 | 工作树 EOL | 本片动作 |
| --- | --- | --- |
| `frontend/src/i18n/index.ts` | CRLF（CR=171／LF=171） | 改，保持 CRLF |
| `frontend/src/i18next.d.ts` | **LF**（CR=0／LF=11） | 改，保持 LF |
| `frontend/src/__tests__/navigationCopy.test.ts` | CRLF（CR=101／LF=101） | 改，保持 CRLF |
| `frontend/src/i18n/locales/*.json` | CRLF（en：CR=2605／LF=2605） | `git checkout` 撤回，经 autocrlf 过滤仍 CRLF |
| `frontend/src/i18n/fork/*.json`（新） | 不存在 | 新建，写 **LF** |
| `frontend/src/i18n/fork/index.ts`（新） | 不存在 | 新建，写 **LF** |
| `frontend/src/i18n/fork/__tests__/forkOverlay.test.ts`（新） | 不存在 | 新建，写 **LF** |
| 本计划 / spec | LF | 追加时走 bytes 层，CR 必须仍为 0 |

`core.autocrlf=true`。数 CR 只能用 `tr -cd '\r' | wc -c` 或 Python 的 `b.count(b'\r')`。新文件写 LF 后 `git add` 存的也是 LF，`git status` 干净；git 会打印「LF will be replaced by CRLF」提示，那是提示不是错误。

### 门册（A–I，与档案 §7.41 同一套）

| 门 | 命令（仓库根起） |
| --- | --- |
| A | `cd frontend && npx tsc -b` |
| B | `cd frontend && npx vitest run` |
| C | `cd frontend && npx vite build` |
| D | `python tools/forensics_audit.py` |
| E | `python -m pytest tools/test_forensics_spec.py -q` |
| F | `python -X utf8 -m pytest tools/test_wiki_drift.py -q -m "not local_archive"` |
| G | `python -X utf8 -m pytest tools/test_wiki_qmind.py tools/test_upstream_sync.py -q` |
| H | `bash tools/wiki_freshness_gate.sh` |
| I | `bash tools/ci_grep_gates.sh` |

外加一条定向前端→后端腿（本片唯一的后端可见面）：
`cd agent && python -m pytest tests/test_channel_config_meta.py -q`

**本地恒红门：H 与 I。** H 是 wiki 水位（本片未动 `wiki/`／`repowiki/`）；I 只红 `[gate b]`，命中全为未跟踪本地 scratch。两者都按 Task 0 的同树基线逐字比对证 0 贡献，I 要做到**字节相同**。

---

## File Structure

**新建（全部本仓所有，零冲突成本）**

| 路径 | 职责 |
| --- | --- |
| `frontend/src/i18n/fork/<code>.json` ×11 | 只承载 15 枚键的嵌套 translation 子树；值逐字搬自 `b292dfb6` |
| `frontend/src/i18n/fork/index.ts` | 导出 `forkEn`（eager）与 `forkLoaders`（10 枚动态 import），用 `satisfies` 钉双向穷尽 |
| `frontend/src/i18n/fork/__tests__/forkOverlay.test.ts` | 七组守卫；语言集从磁盘发现 |
| `frontend/src/i18n/fork/deepMerge.ts` | **条件件**：仅当 Task 3 的 `tsc -b` 判交叉类型不可用时才建 |

**修改**

| 路径 | 归属 | 改动 |
| --- | --- | --- |
| `frontend/src/i18n/index.ts` | 上游 | 三处纯追加，零删除 |
| `frontend/src/i18next.d.ts` | 上游 | +2/-1（交叉类型）；退路 +3/-1 |
| `frontend/src/i18n/locales/<code>.json` ×11 | 上游 | 撤回 `2ac20879`，回到逐字未改 |
| `frontend/src/__tests__/navigationCopy.test.ts` | 本仓新增 | `readLocale` 改读深合并后的有效 bundle；断言体一字不改 |
| `项目档案.md` | 本仓 | bytes 层追加一节（CRLF） |
| `superpowers/specs/2026-11-08-fork-locale-overlay-design.md` | 本仓 | §九 已在计划期追加，本片只提交 |

**仓库外一次性脚本（不进 git，不被门 b 扫）**

| 路径 | 职责 |
| --- | --- |
| `C:/Users/fire/AppData/Local/Temp/arch/gen_fork_overlay.py` | 从 `b292dfb6` 逐字取 15 枚键，生成 11 枚覆盖层；生成前先断言 delta 恰为 +15/-0/改0 |
| `C:/Users/fire/AppData/Local/Temp/arch/verify_overlay_equivalence.py` | 逐语言断言「旧 locale 叶映射」==「新 locale ∪ 覆盖层叶映射」 |

---

## Task 0: 同树基线（动手前，只读）

**Files:** 无改动。输出落 `C:/Users/fire/AppData/Local/Temp/arch/baseline/`。

**Interfaces:**
- Consumes: 无
- Produces: `baseline/gateH.txt`、`baseline/gateI.txt`、`baseline/upstream_sha.txt`、`baseline/conflict.txt`、`baseline/frontend.txt`、`baseline/channel.txt`——Task 7 的比对分母

- [ ] **Step 1: 核对上游坐标与冲突面**

```bash
git rev-parse --short upstream/main
git diff --name-only upstream/main HEAD -- frontend/src/i18n/locales/
git diff --name-only upstream/main HEAD | wc -l
git status --short
```

期望：第一条输出 `2ac20879`（**不是这一枚就停下报告**）；第二条列 11 枚 `*.json`（不含 `tsconfig.json`）；第三条给出当前分叉总数——**由你当场测、当场记，本计划不预填数字**（spec 与 plan 两笔计划期提交都已计入）；第四条只列未跟踪的 `.superpowers/` 与 `superpowers/plans/2026-10-05-m4-qmind-m5-shard1.md`。把三条读数连 upstream sha、`main` 的短 sha 一起记进 `baseline/conflict.txt`——Task 9 Step 7 要用那枚 `main` 短 sha 做远程真值比对。

- [ ] **Step 2: 取恒红门 H/I 的同树基线**

```bash
mkdir -p /c/Users/fire/AppData/Local/Temp/arch/baseline
bash tools/wiki_freshness_gate.sh > /c/Users/fire/AppData/Local/Temp/arch/baseline/gateH.txt 2>&1; echo "H rc=$?"
bash tools/ci_grep_gates.sh > /c/Users/fire/AppData/Local/Temp/arch/baseline/gateI.txt 2>&1; echo "I rc=$?"
```

两条都预期 rc=1。把 rc 也记进文件末尾之外的台账（不要写进被比对的文件里）。门 I 的命中文件逐枚判跟踪态：

```bash
grep -oE '^\./[^:]+' /c/Users/fire/AppData/Local/Temp/arch/baseline/gateI.txt | sort -u > /c/Users/fire/AppData/Local/Temp/arch/baseline/gateI_files.txt
while read -r f; do git ls-files --error-unmatch "$f" >/dev/null 2>&1 && echo "TRACKED $f" || echo "untracked $f"; done < /c/Users/fire/AppData/Local/Temp/arch/baseline/gateI_files.txt
```

期望：**TRACKED 0 枚**。出现任何 TRACKED 就停下报告——那是既存的真红，不是本片的噪音，且不许顺手清。

- [ ] **Step 3: 取前端三门与定向后端腿的基线**

```bash
cd frontend && npx tsc -b > /c/Users/fire/AppData/Local/Temp/arch/baseline/frontend.txt 2>&1; echo "A rc=$?"
```

```bash
cd frontend && npx vitest run >> /c/Users/fire/AppData/Local/Temp/arch/baseline/frontend.txt 2>&1; echo "B rc=$?"
```

```bash
cd frontend && npx vite build >> /c/Users/fire/AppData/Local/Temp/arch/baseline/frontend.txt 2>&1; echo "C rc=$?"
```

```bash
cd agent && python -m pytest tests/test_channel_config_meta.py -q > /c/Users/fire/AppData/Local/Temp/arch/baseline/channel.txt 2>&1; echo "channel rc=$?"
```

期望 A/B/C 全 rc=0。vitest 的 `Test Files`／`Tests` 枚数**当场读、当场记**，不要引用本计划里的任何数字。若 B 有红，先定因（已登记 flake 还是真红），真红就停下报告。

channel 腿的判据**不是 rc=0**，而是「FAILED 名字集合与基线相同、新增红为 0」：本机缺 `nh3`（上游自己在 `agent/requirements.txt:79` 与 `pyproject.toml:88` 声明的依赖），使这一腿在未改动树上就恒红。取分母的方式是当场 `grep -n '^FAILED' …/baseline/channel.txt`，**不要抄本计划里的名字**。定因证据与裁定见本文件末尾「执行期偏差」的 2026-11-08 条。**不装包、不动 Python 工具链、不改这三枚测试。**

- [ ] **Step 4: 记录 EOL 与 sha256**

```bash
python -c "
import hashlib
from pathlib import Path
for p in ['frontend/src/i18n/index.ts','frontend/src/i18next.d.ts','frontend/src/__tests__/navigationCopy.test.ts','frontend/src/i18n/locales/en.json']:
    b=Path(p).read_bytes()
    print(p, 'bytes', len(b), 'CR', b.count(b'\r'), 'LF', b.count(b'\n'), 'sha256', hashlib.sha256(b).hexdigest())
"
```

读数记进台账。Task 6 的变异还原要靠这份 sha256 复校。

---

## Task 1: 生成 11 枚覆盖层 JSON

**Files:**
- Create（仓库外）: `C:/Users/fire/AppData/Local/Temp/arch/gen_fork_overlay.py`
- Create: `frontend/src/i18n/fork/{en,zh-CN,ja,ko,ar,fa,es,de,pt-BR,id,tr}.json`

**Interfaces:**
- Consumes: `git show b292dfb6:frontend/src/i18n/locales/<code>.json`、`git show 2ac20879:…`
- Produces: 11 枚嵌套 JSON，每枚恰 15 枚叶，键路径集合为 `layout.{proChart,multiChart,alerts,warehouse,help}` ∪ `navigation.descriptions.{同5}` ∪ `navigation.instructions.{同5}`

- [ ] **Step 1: 建本片分支（本仓每片一支的既有惯例）**

Task 0 全程只读，到这一步才第一次写 `.git`。spec 与 plan 已在 `main` 上（spec 是 `5a5a8d2a`），本片分支从 `main` 现读的那一枚切出：

```bash
git rev-parse --short HEAD
git status --short
git switch -c feat/fork-locale-overlay
git rev-parse --abbrev-ref HEAD
```

期望：第一条与 Task 0 Step 1 记下的 `main` 坐标一致；第二条只剩那两枚既有未跟踪路径（`.superpowers/`、`superpowers/plans/2026-10-05-m4-qmind-m5-shard1.md`）——**若还有别的在飞改动，停下报告，不要 stash 别人的东西**；第四条输出 `feat/fork-locale-overlay`。

分支名若已存在（`git switch -c` 报 fatal），说明上一轮留了残支：先 `git log --oneline -3 feat/fork-locale-overlay` 只读看它是什么，再决定是接着用还是换名，**不要删支**。

- [ ] **Step 2: 写生成器（仓库外）**

写到 `C:/Users/fire/AppData/Local/Temp/arch/gen_fork_overlay.py`：

```python
#!/usr/bin/env python3
"""One-shot: lift the fork's navigation copy out of the upstream locale files."""

from __future__ import annotations

import hashlib
import json
import subprocess
import sys
from pathlib import Path

REPO = Path("E:/Vibe-Trading-main/Vibe-Trading-main")
SOURCE_REV = "b292dfb6"
UPSTREAM_REV = "2ac20879"
CODES = ["en", "zh-CN", "ja", "ko", "ar", "fa", "es", "de", "pt-BR", "id", "tr"]
IDS = ["proChart", "multiChart", "alerts", "warehouse", "help"]
PATHS = sorted(
    [f"layout.{i}" for i in IDS]
    + [f"navigation.descriptions.{i}" for i in IDS]
    + [f"navigation.instructions.{i}" for i in IDS]
)
TRADEMARK = ("world" + "quant").encode()


def leaves(obj: dict, prefix: str = "") -> dict:
    out: dict = {}
    for key, value in obj.items():
        full = f"{prefix}.{key}" if prefix else key
        if isinstance(value, dict):
            out.update(leaves(value, full))
        else:
            out[full] = value
    return out


def git_locale(rev: str, code: str) -> dict:
    raw = subprocess.run(
        ["git", "show", f"{rev}:frontend/src/i18n/locales/{code}.json"],
        cwd=REPO, capture_output=True, check=True,
    ).stdout
    return json.loads(raw.decode("utf-8"))


def nest(flat: dict) -> dict:
    root: dict = {}
    for path, value in flat.items():
        parts = path.split(".")
        node = root
        for part in parts[:-1]:
            node = node.setdefault(part, {})
        node[parts[-1]] = value
    return root


def main() -> int:
    out_dir = REPO / "frontend/src/i18n/fork"
    out_dir.mkdir(parents=True, exist_ok=True)
    rows = []
    for code in CODES:
        fork_map = leaves(git_locale(SOURCE_REV, code))
        up_map = leaves(git_locale(UPSTREAM_REV, code))
        added = sorted(set(fork_map) - set(up_map))
        removed = sorted(set(up_map) - set(fork_map))
        changed = sorted(k for k in set(fork_map) & set(up_map) if fork_map[k] != up_map[k])
        if added != PATHS or removed or changed:
            print(f"FAIL {code}: added={added} removed={removed} changed={changed}")
            return 1
        payload = nest({k: fork_map[k] for k in PATHS})
        text = json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True) + "\n"
        blob = text.encode("utf-8")
        if TRADEMARK in blob.lower():
            print(f"FAIL {code}: trademark literal in overlay")
            return 1
        target = out_dir / f"{code}.json"
        target.write_bytes(blob)
        rows.append((code, len(leaves(payload)), len(blob), blob.count(b"\r"),
                     hashlib.sha256(blob).hexdigest()[:16]))
    for code, n, size, cr, digest in rows:
        print(f"{code:6s} leaves={n} bytes={size} CR={cr} sha256={digest}")
    print(f"OK: wrote {len(rows)} overlay files, {len(PATHS)} leaves each")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 3: 跑生成器**

```bash
PYTHONIOENCODING=utf-8 python /c/Users/fire/AppData/Local/Temp/arch/gen_fork_overlay.py
```

期望：11 行 `leaves=15 … CR=0`，末行 `OK: wrote 11 overlay files, 15 leaves each`，rc=0。任何 `FAIL` 都停下报告——那说明分叉内容与 spec §1.3 的取证不符，不许改脚本迁就。

**这个脚本只跑这一次。** 它写的是被跟踪面，手工改过覆盖层之后重跑会把改动覆盖掉。

- [ ] **Step 4: 抽验一枚非英语覆盖层的值确实搬对了**

```bash
PYTHONIOENCODING=utf-8 python -c "
import json, subprocess
from pathlib import Path
for code in ['zh-CN','ar','tr']:
    old = json.loads(subprocess.run(['git','show',f'b292dfb6:frontend/src/i18n/locales/{code}.json'],capture_output=True,check=True).stdout.decode('utf-8'))
    new = json.loads(Path(f'frontend/src/i18n/fork/{code}.json').read_text(encoding='utf-8'))
    for i in ['proChart','multiChart','alerts','warehouse','help']:
        assert new['layout'][i] == old['layout'][i], (code,'layout',i)
        assert new['navigation']['descriptions'][i] == old['navigation']['descriptions'][i], (code,'desc',i)
        assert new['navigation']['instructions'][i] == old['navigation']['instructions'][i], (code,'instr',i)
    print(code, 'verbatim OK')
"
```

期望三行 `verbatim OK`。

- [ ] **Step 5: 确认树仍绿（新 JSON 还没被任何模块 import）**

```bash
cd frontend && npx tsc -b; echo "A rc=$?"
```

期望 rc=0。

- [ ] **Step 6: 提交（显式 pathspec，11 枚逐名列出）**

```bash
git add frontend/src/i18n/fork/en.json frontend/src/i18n/fork/zh-CN.json frontend/src/i18n/fork/ja.json frontend/src/i18n/fork/ko.json frontend/src/i18n/fork/ar.json frontend/src/i18n/fork/fa.json frontend/src/i18n/fork/es.json frontend/src/i18n/fork/de.json frontend/src/i18n/fork/pt-BR.json frontend/src/i18n/fork/id.json frontend/src/i18n/fork/tr.json
git diff --cached --numstat
git commit -s -m "feat(i18n): carry fork navigation copy in a fork-owned overlay" -m "Lift the five fork navigation ids out of the upstream locale files verbatim, so the next upstream sync no longer collides inside their hunks. Values are unchanged; nothing imports the overlay yet." -- frontend/src/i18n/fork/
git status --short
```

`git diff --cached --numstat` 必须恰列 11 枚新 JSON、每枚 +行数/-0。`git status --short` 之后仍只剩 Task 0 记下的那两枚未跟踪路径。

---

## Task 2: 覆盖层注册表与七组守卫（RED-A）

**Files:**
- Create: `frontend/src/i18n/fork/index.ts`
- Create: `frontend/src/i18n/fork/__tests__/forkOverlay.test.ts`

**Interfaces:**
- Consumes: Task 1 的 11 枚 JSON；`SUPPORTED_LANGUAGES`／`SupportedLanguageCode`（`@/i18n`）；`NAVIGATION_GROUPS`（`@/components/layout/navigation`）
- Produces: `forkEn`（`typeof import("./en.json")`）、`forkLoaders`（`Record<Exclude<SupportedLanguageCode,"en">, () => Promise<{ default: typeof forkEn }>>`）——Task 4 的 `i18n/index.ts` 按这两个名字消费

- [ ] **Step 1: 写 `fork/index.ts`**

```ts
import type { SupportedLanguageCode } from "../index";
import forkEn from "./en.json";

type ForkLazyCode = Exclude<SupportedLanguageCode, "en">;

export { forkEn };

// Kept outside locales/ so upstream edits to those files never collide with
// ours. `satisfies` fails both ways: a registered language with no overlay, and
// an overlay for a language nobody registered.
export const forkLoaders = {
  "zh-CN": () => import("./zh-CN.json"),
  ja: () => import("./ja.json"),
  ko: () => import("./ko.json"),
  ar: () => import("./ar.json"),
  fa: () => import("./fa.json"),
  es: () => import("./es.json"),
  de: () => import("./de.json"),
  "pt-BR": () => import("./pt-BR.json"),
  id: () => import("./id.json"),
  tr: () => import("./tr.json"),
} satisfies Record<ForkLazyCode, () => Promise<{ default: typeof forkEn }>>;
```

`import type` 编译后擦除 ⇒ 与 `../index` 不构成运行时循环。

- [ ] **Step 2: 写守卫（完整文件）**

写到 `frontend/src/i18n/fork/__tests__/forkOverlay.test.ts`：

```ts
import { waitFor } from "@testing-library/react";
import { NAVIGATION_GROUPS } from "@/components/layout/navigation";
import i18n, { SUPPORTED_LANGUAGES } from "@/i18n";

// Both sides are discovered from disk, never listed here: a hardcoded list is
// how a language ships with perfect parity and no coverage at all.
const overlayModules = import.meta.glob<Record<string, unknown>>("../*.json", {
  eager: true,
  import: "default",
});
const localeModules = import.meta.glob<Record<string, unknown>>("../../locales/*.json", {
  eager: true,
  import: "default",
});

function codeOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1, -".json".length);
}

const overlays: Record<string, Record<string, unknown>> = {};
for (const [path, mod] of Object.entries(overlayModules)) {
  overlays[codeOf(path)] = mod;
}

const locales: Record<string, Record<string, unknown>> = {};
for (const [path, mod] of Object.entries(localeModules)) {
  const code = codeOf(path);
  // Upstream keeps a stray tsconfig.json in the locales directory.
  if (code !== "tsconfig") locales[code] = mod;
}

/** Every leaf value keyed by its dot path; Object.keys of this is the key set. */
function leafValues(obj: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(out, leafValues(value as Record<string, unknown>, full));
    } else {
      out[full] = value;
    }
  }
  return out;
}

const codes = SUPPORTED_LANGUAGES.map((language) => language.code);
const enOverlay = leafValues(overlays.en ?? {});
const enOverlayKeys = Object.keys(enOverlay).sort();
const navIds = NAVIGATION_GROUPS.flatMap((group) => [...group.items]).map((item) => item.id);
const upstreamIds = new Set(Object.keys((locales.en?.layout ?? {}) as Record<string, unknown>));
const forkIds = navIds.filter((id) => !upstreamIds.has(id));
const FAMILIES = ["layout", "navigation.descriptions", "navigation.instructions"] as const;
const VAR_RE = /\{\{(\w+)\}\}/g;
const MOJIBAKE_RE = /â€|Ã|Â|\uFFFD/;

describe("fork overlay registry", () => {
  it("has one overlay file per registered language, and no others", () => {
    expect(Object.keys(overlays).sort()).toEqual([...codes].sort());
  });
});

describe.each(codes)("fork overlay parity for %s", (code) => {
  const mine = leafValues(overlays[code] ?? {});

  it("carries every key the English overlay carries", () => {
    const present = new Set(Object.keys(mine));
    expect(enOverlayKeys.filter((key) => !present.has(key))).toEqual([]);
  });

  it("carries no key the English overlay lacks", () => {
    const canonical = new Set(enOverlayKeys);
    expect(Object.keys(mine).filter((key) => !canonical.has(key)).sort()).toEqual([]);
  });
});

describe.each(codes)("fork overlay stays out of upstream copy for %s", (code) => {
  it("shares no leaf path with the upstream locale", () => {
    // Also the regression pin for a future sync that unions our keys back into
    // locales/: the moment both sides carry a key, this intersection is non-empty.
    const upstream = new Set(Object.keys(leafValues(locales[code] ?? {})));
    const collisions = Object.keys(leafValues(overlays[code] ?? {}))
      .filter((key) => upstream.has(key))
      .sort();
    expect(collisions).toEqual([]);
  });
});

describe.each(codes)("fork overlay copy quality for %s", (code) => {
  const mine = leafValues(overlays[code] ?? {});

  it("ships non-empty strings that are not their own key path", () => {
    for (const [key, value] of Object.entries(mine)) {
      expect(value, key).toBeTypeOf("string");
      expect((value as string).length, key).toBeGreaterThan(0);
      expect(value, key).not.toBe(key);
    }
  });

  it("has no UTF-8 text decoded as Windows-1252", () => {
    const broken = Object.entries(mine)
      .filter(([, value]) => MOJIBAKE_RE.test(String(value)))
      .map(([key]) => key);
    expect(broken).toEqual([]);
  });

  it("interpolates the same variables as the English overlay", () => {
    // Vacuous at landing: none of the fork's keys carry a {{variable}}. Kept so
    // a future placeholder cannot drift between languages; M11 proves it bites.
    const mismatches: string[] = [];
    for (const key of enOverlayKeys) {
      const enVars = [...String(enOverlay[key]).matchAll(VAR_RE)].map((m) => m[1]).sort();
      const locVars = [...String(mine[key] ?? "").matchAll(VAR_RE)].map((m) => m[1]).sort();
      if (enVars.join(",") !== locVars.join(",")) mismatches.push(key);
    }
    expect(mismatches).toEqual([]);
  });
});

describe("fork overlay Turkish copy", () => {
  it("does not ship copied English", () => {
    // Upstream's i18n.test.ts stops covering these keys once they move out of
    // tr.json, so the check is re-established here. Stricter than upstream's:
    // no shared-term allowlist, because every fork key is prose.
    const tr = leafValues(overlays.tr ?? {});
    const copied = Object.entries(tr)
      .filter(([key, value]) => value === enOverlay[key])
      .map(([key]) => key);
    expect(copied).toEqual([]);
  });
});

describe("fork overlay covers every fork-owned navigation entry", () => {
  it("has at least one fork-owned entry to cover", () => {
    // Non-vacuity: without this the it.each below passes on an empty id set.
    expect(forkIds.length).toBeGreaterThan(0);
  });

  it.each(codes)("%s supplies all three copy families for every fork-owned entry", (code) => {
    const mine = leafValues(overlays[code] ?? {});
    for (const id of forkIds) {
      for (const family of FAMILIES) {
        expect(mine[`${family}.${id}`], `${code} ${family}.${id}`).toBeTypeOf("string");
      }
    }
  });
});

describe.each(codes)("runtime resolution for %s", (code) => {
  it("resolves every overlay key to that language's own value", async () => {
    await i18n.changeLanguage(code);
    // layout.agent belongs to upstream, so its presence says the locale bundle
    // landed without saying anything about the overlay under test. Waiting on a
    // fork key instead would time out for 20s per language in RED-B.
    await waitFor(() => {
      expect(i18n.getResource(code, "translation", "layout.agent")).toBeTypeOf("string");
    });
    const expected = leafValues(overlays[code] ?? {});
    for (const key of enOverlayKeys) {
      // Right side is the overlay JSON's value, never t() re-run (tautology) and
      // never "not equal to the key path" (would pass on an English fallback).
      expect(i18n.t(key, key)).toBe(expected[key]);
    }
  });
});

describe("language switching", () => {
  it("leaves the final language's overlay copy in effect after two quick switches", async () => {
    // Ordering is not forced: this pins the final state, not a simulated slow
    // import. The slice adds a second await to loadLanguage, widening the window
    // in which a stale load could otherwise win.
    void i18n.changeLanguage("de");
    await i18n.changeLanguage("id");
    await waitFor(() => {
      expect(i18n.getResource("id", "translation", "layout.agent")).toBeTypeOf("string");
    });
    const expected = leafValues(overlays.id ?? {});
    for (const key of enOverlayKeys) {
      expect(i18n.t(key, key)).toBe(expected[key]);
    }
    expect(i18n.language).toBe("id");
  });
});
```

**为什么 `i18n.t(key, key)` 里的 `key: string` 不需要断言**（计划期已用 TypeScript 编译器 API 对虚拟文件实测，三种写法各跑一遍）：本仓 `frontend/src/i18next.d.ts` 只设了 `defaultNS` 与 `resources`，没设 `strictKeyChecks`／`enableSelector`，而 i18next 的默认值分别是 `false`（`node_modules/i18next/typescript/options.d.ts:160`）与 `false`（同文件 `:232`）⇒ `TFunctionSignature` 落到 `TFunctionNonStrict`，它的 rest 形参是三元组并集，其中两支的首位就是 `string | string[]`。实测读数：

| 写法 | 探针文件上的诊断数 |
| --- | --- |
| `i18n.t(key, key)` | **0** |
| `i18n.t(key as never, key)` | 0 |
| `type TranslationKey = Parameters<typeof i18n.t>[0]; i18n.t(key as TranslationKey, key)` | **1（TS2345）** |

第三行是**反例，不要写**：`Parameters<>` 取到的首位是含 `string` 的宽并集，回传给实参时反而与严格键那一支不兼容。选第一行（无断言、可读性最好）。探针脚本在仓库外 `C:\Users\fire\AppData\Local\Temp\arch\probe_tkey.cjs`，用虚拟文件喂给 `ts.createProgram`，仓内零写入。

- [ ] **Step 3: 跑新守卫，取 RED-A 逐字读数**

```bash
cd frontend && npx vitest run src/i18n/fork/__tests__/forkOverlay.test.ts > /c/Users/fire/AppData/Local/Temp/arch/redA.txt 2>&1; echo "RED-A rc=$?"
```

期望 rc=1，且红针**恰为**这两类（枚数当场数，逐字留档）：

- `fork overlay stays out of upstream copy for <code> > shares no leaf path with the upstream locale` —— **11 支全红**（15 枚键此刻还住在 locale 里，交集非空）
- `fork overlay covers every fork-owned navigation entry > has at least one fork-owned entry to cover` —— **1 支红**（`forkIds` 由「不在上游 locale 里的导航 id」派生，此刻为 0）

**其余全绿**，包括 `runtime resolution` 的 11 支：locale 仍供着同语言同值的文案，所以运行时守卫此刻抓不到任何东西。这正是 spec §九 第 1 条更正的内容——不要把它记成「en 绿／其余 10 红」。

若红的比预期多，先定因再继续；若 `runtime resolution` 有红，说明 `waitFor` 哨兵选错（必须是上游的 `layout.agent`，不能是自研键）或 `leafValues` 的展平口径与生成器不一致，停下修。

- [ ] **Step 4: 确认门 A 绿（`satisfies` 双向穷尽成立）**

```bash
cd frontend && npx tsc -b; echo "A rc=$?"
```

期望 rc=0。**本步不提交**（RED 态不进历史）。

---

## Task 3: 撤回 11 枚 locale ＋ 扩类型（RED-B）

**Files:**
- Modify: `frontend/src/i18n/locales/{en,zh-CN,ja,ko,ar,fa,es,de,pt-BR,id,tr}.json`（撤回 `2ac20879`）
- Modify: `frontend/src/i18next.d.ts`
- Create（条件）: `frontend/src/i18n/fork/deepMerge.ts`

**Interfaces:**
- Consumes: Task 1 的 `fork/en.json`
- Produces: `CustomTypeOptions.resources.translation` 含全部 2185 枚键 ⇒ `PageHelp.tsx:15,19,20` 与 `SidebarNavigation.tsx:45,49` 的模板字面量键仍可解析

- [ ] **Step 1: 撤回上游 locale（同时写索引与工作树）**

```bash
git checkout 2ac20879 -- frontend/src/i18n/locales/
git diff --name-only 2ac20879 -- frontend/src/i18n/locales/
git diff --cached --numstat -- frontend/src/i18n/locales/
```

第二条必须**输出为空**（11 枚与上游逐字相同，游离 `tsconfig.json` 本来就相同故不动）。第三条预期 11 枚各 `-15` 行左右（实际行数以 JSON 排版为准，当场读）。

- [ ] **Step 2: 扩 `i18next.d.ts`（保持 LF）**

把第 2 行之后加一行 import，并把 `translation: typeof en;` 换成跨类型。改完整个文件是：

```ts
import "i18next";
import type en from "./i18n/locales/en.json";
import type forkEn from "./i18n/fork/en.json";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: {
      translation: typeof en & typeof forkEn;
    };
  }
}
```

净改 +2/-1。用 Edit 工具做两处替换即可，不要整文件重写（重写会改 EOL）。

- [ ] **Step 3: 跑门 A —— 这一步同时是 spec §3.2 的类型退路判定**

```bash
cd frontend && npx tsc -b > /c/Users/fire/AppData/Local/Temp/arch/typeprobe.txt 2>&1; echo "A rc=$?"
```

**这一步不是假绿**：`locales/en.json` 已在 Step 1 撤回上游、不再含那 15 枚键，所以只有交叉类型能供出它们。

- 若 rc=0 ⇒ 交叉类型可用，**跳过 Step 4**，直接 Step 5。
- 若 rc≠0 且报错指向 `PageHelp.tsx`／`SidebarNavigation.tsx` 的模板字面量键 ⇒ 走 Step 4 退路。把 `typeprobe.txt` 的报错逐字留档。

- [ ] **Step 4（条件）: DeepMerge 退路**

新建 `frontend/src/i18n/fork/deepMerge.ts`：

```ts
/** Recursive merge for type-level resource bundles; overlay wins at leaves. */
export type DeepMerge<A, B> = {
  [K in keyof A | keyof B]: K extends keyof B
    ? K extends keyof A
      ? A[K] extends object
        ? B[K] extends object
          ? DeepMerge<A[K], B[K]>
          : B[K]
        : B[K]
      : B[K]
    : K extends keyof A
      ? A[K]
      : never;
};
```

`i18next.d.ts` 改成（净改 +3/-1）：

```ts
import "i18next";
import type en from "./i18n/locales/en.json";
import type forkEn from "./i18n/fork/en.json";
import type { DeepMerge } from "./i18n/fork/deepMerge";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: {
      translation: DeepMerge<typeof en, typeof forkEn>;
    };
  }
}
```

复跑 `cd frontend && npx tsc -b`，必须 rc=0。仍红就停下报告，不要继续往下接运行时。

- [ ] **Step 5: 取 RED-B 逐字读数**

```bash
cd frontend && npx vitest run src/i18n/fork/__tests__/forkOverlay.test.ts src/__tests__/navigationCopy.test.ts src/i18n/__tests__/i18n.test.ts > /c/Users/fire/AppData/Local/Temp/arch/redB.txt 2>&1; echo "RED-B rc=$?"
```

期望 rc=1，红针分布：

- `forkOverlay` 的 `runtime resolution for <code>` —— **11 支全红**（键在 locale 与运行时两侧都不存在，`t()` 退回键路径）
- `forkOverlay` 的 `language switching` —— **1 支红**（同因）
- `forkOverlay` 的 `stays out of upstream copy` —— **11 支转绿**（键已撤出 locale）
- `forkOverlay` 的 `has at least one fork-owned entry to cover` —— **转绿**（`forkIds` 现为 5）
- `navigationCopy` 的 `sidebar copy for <code>` 里 `labels every navigation entry`／`tooltips every navigation entry`／`explains every page that has a help block`／`never ships a key path as its own value` —— 红（它只读 locale 一枚文件）
- **`i18n.test.ts` 全绿**：11 枚同时撤掉同样 15 枚键，双向平价原样成立。这一套本片一字不改，它绿是判据不是巧合。

枚数一律当场数、逐字留档。**本步不提交。**

---

## Task 4: 接运行时 ＋ navigationCopy 改口（GREEN）

**Files:**
- Modify: `frontend/src/i18n/index.ts`（三处纯追加，保持 CRLF）
- Modify: `frontend/src/__tests__/navigationCopy.test.ts`（保持 CRLF）

**Interfaces:**
- Consumes: Task 2 的 `forkEn`／`forkLoaders`
- Produces: 每门语言的有效 bundle = 上游 2170 叶 ∪ 覆盖层 15 叶 = 2185 叶，值与 `b292dfb6` 逐字相同

- [ ] **Step 1: `i18n/index.ts` 追加 import**

在 `import en from "./locales/en.json";`（写作时 `:5`）之后插入一行：

```ts
import { forkEn, forkLoaders } from "./fork";
```

- [ ] **Step 2: `i18n/index.ts` 追加 lazy 侧注册**

在 `loadLanguage` 的 try 内、`i18n.addResourceBundle(code, "translation", resources, true, true);`（写作时 `:63`）之后、`loadedLanguages.add(code);` 之前插入：

```ts
        // After the upstream bundle so fork copy wins; inside the try so a
        // failed overlay shares the retry and fallback path.
        const { default: forkResources } = await forkLoaders[code]();
        i18n.addResourceBundle(code, "translation", forkResources, true, true);
```

缩进照上游那两行（8 空格）。

- [ ] **Step 3: `i18n/index.ts` 追加 en 侧注册**

在 `.init({…});` 的收尾 `  });`（写作时 `:164`）之后、`applyDocumentDirection(i18n.language || "en");`（写作时 `:166`）之前插入：

```ts

// Fork copy lives outside locales/ so upstream edits there never collide with
// ours. Deep-merge, not spread: navigation.descriptions is an upstream branch
// that this overlay extends rather than replaces.
i18n.addResourceBundle("en", "translation", forkEn, true, true);
```

`initAsync: false` ⇒ init 同步完成，紧随其后注册即可。三处追加合计**零删除**。

- [ ] **Step 4: `navigationCopy.test.ts` 改读有效 bundle**

把 `const localesDir = …` 与 `function readLocale …` 那一段（写作时 `:20-24`）换成：

```ts
const localesDir = resolve(__dirname, "../i18n/locales");
const overlayDir = resolve(__dirname, "../i18n/fork");

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(path, "utf-8"));
}

// Mirrors i18next's addResourceBundle(code, "translation", fork, true, true):
// recurse while both sides are branch objects, overlay wins at leaves, keys on
// only one side survive. Reading a single file would call a missing overlay green.
function deepMerge(base: Record<string, any>, overlay: Record<string, any>): Record<string, any> {
  const out: Record<string, any> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    const existing = out[key];
    const bothBranches =
      value !== null && typeof value === "object" && !Array.isArray(value) &&
      existing !== null && typeof existing === "object" && !Array.isArray(existing);
    out[key] = bothBranches ? deepMerge(existing, value) : value;
  }
  return out;
}

function readLocale(code: string): Record<string, any> {
  return deepMerge(
    readJson(resolve(localesDir, `${code}.json`)),
    readJson(resolve(overlayDir, `${code}.json`)),
  );
}
```

**下方所有 describe/it 的断言体一字不改。** 只换输入。

- [ ] **Step 5: 更正 `navigationCopy.test.ts` 头注释里那句陈旧读数（行数守恒 3→3）**

把写作时 `:12-14` 这三行：

```
 * visible defect no behavioural test of a page would notice. Upstream now owns
 * the item list (components/layout/navigation.ts) and nine locale files, so the
 * pair can drift on either side of a merge.
```

换成：

```
 * visible defect no behavioural test of a page would notice. Upstream owns the
 * item list (components/layout/navigation.ts) and eleven locale files; the five
 * fork entries live in i18n/fork/, so the pair can drift on either side.
```

- [ ] **Step 6: 跑 GREEN**

```bash
cd frontend && npx vitest run src/i18n/fork/__tests__/forkOverlay.test.ts src/__tests__/navigationCopy.test.ts src/i18n/__tests__/i18n.test.ts > /c/Users/fire/AppData/Local/Temp/arch/green.txt 2>&1; echo "GREEN rc=$?"
```

期望 rc=0，三套全绿。枚数当场读。

- [ ] **Step 7: 跑门 A 与全量门 B**

```bash
cd frontend && npx tsc -b; echo "A rc=$?"
```

```bash
cd frontend && npx vitest run > /c/Users/fire/AppData/Local/Temp/arch/gateB.txt 2>&1; echo "B rc=$?"
```

A 必须 rc=0。B 与 Task 0 基线比：`Test Files` 数 +1（新守卫文件），`Tests` 数增量为新守卫的用例数，**既有红必须为 0**。

- [ ] **Step 8: 跑定向后端腿**

```bash
cd agent && python -m pytest tests/test_channel_config_meta.py -q; echo "channel rc=$?"
```

判据是「FAILED 名字集合与 Task 0 基线相同、新增红为 0」，**不是 rc=0**（本机缺 `nh3`，该腿恒红；见「执行期偏差」2026-11-08 条）。取基线名字集合：`grep '^FAILED' /c/Users/fire/AppData/Local/Temp/arch/baseline/channel.txt | sort`，与本次输出的同名集合做 `diff`，必须为空。这是本片唯一的后端可见面（`agent/tests/test_channel_config_meta.py:1076` 读前端 `en.json`，只沿 `hint["help_key"]` 走 channel 配置字段，与 15 枚键无交集）。

- [ ] **Step 9: 提交（显式 pathspec）**

```bash
git add frontend/src/i18n/index.ts frontend/src/i18next.d.ts frontend/src/i18n/fork/index.ts frontend/src/i18n/fork/__tests__/forkOverlay.test.ts frontend/src/__tests__/navigationCopy.test.ts frontend/src/i18n/locales/
git diff --cached --numstat
git status --short
```

若走了 Task 3 Step 4 退路，`git add` 再加 `frontend/src/i18n/fork/deepMerge.ts`。

`git diff --cached --numstat` 必须列出：11 枚 locale（纯删行）、`index.ts`（**纯追加，deleted 列为 0**）、`i18next.d.ts`（+2/-1 或退路 +3/-1）、`fork/index.ts`、`fork/__tests__/forkOverlay.test.ts`、`navigationCopy.test.ts`。`git status --short` 里不得出现任何未列出的改动。

```bash
git commit -s -m "refactor(i18n): register the fork overlay and leave upstream locales untouched" -m "The eleven locale files return to their upstream bytes, removing a conflict class that recurred in three consecutive sync rounds. Every language's effective bundle stays leaf-for-leaf identical; guards pin registry parity, disjointness from upstream keys, and per-language runtime resolution." -- frontend/src/i18n/index.ts frontend/src/i18next.d.ts frontend/src/i18n/fork/ frontend/src/i18n/locales/ frontend/src/__tests__/navigationCopy.test.ts
git log --oneline -1
```

---

## Task 5: 语义等价对账 ＋ 冲突面读数

**Files:**
- Create（仓库外）: `C:/Users/fire/AppData/Local/Temp/arch/verify_overlay_equivalence.py`

**Interfaces:**
- Consumes: `git show b292dfb6:…`、工作树的 locale 与覆盖层
- Produces: 11 行 `EQUAL` ＋ 冲突面三条读数，落 `arch/equivalence.txt`／`arch/conflict_after.txt`

- [ ] **Step 1: 写对账脚本（仓库外）**

```python
#!/usr/bin/env python3
"""Assert every language's effective bundle is leaf-for-leaf unchanged."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

REPO = Path("E:/Vibe-Trading-main/Vibe-Trading-main")
BEFORE_REV = "b292dfb6"
CODES = ["en", "zh-CN", "ja", "ko", "ar", "fa", "es", "de", "pt-BR", "id", "tr"]


def leaves(obj: dict, prefix: str = "") -> dict:
    out: dict = {}
    for key, value in obj.items():
        full = f"{prefix}.{key}" if prefix else key
        if isinstance(value, dict):
            out.update(leaves(value, full))
        else:
            out[full] = value
    return out


def merge(base: dict, overlay: dict) -> dict:
    out = dict(base)
    for key, value in overlay.items():
        if isinstance(value, dict) and isinstance(out.get(key), dict):
            out[key] = merge(out[key], value)
        else:
            out[key] = value
    return out


def main() -> int:
    failed = []
    for code in CODES:
        raw = subprocess.run(
            ["git", "show", f"{BEFORE_REV}:frontend/src/i18n/locales/{code}.json"],
            cwd=REPO, capture_output=True, check=True,
        ).stdout
        before = leaves(json.loads(raw.decode("utf-8")))
        locale = json.loads((REPO / f"frontend/src/i18n/locales/{code}.json").read_text(encoding="utf-8"))
        overlay = json.loads((REPO / f"frontend/src/i18n/fork/{code}.json").read_text(encoding="utf-8"))
        after = leaves(merge(locale, overlay))
        if before == after:
            print(f"{code:6s} leaves={len(after)} EQUAL")
            continue
        missing = sorted(set(before) - set(after))
        extra = sorted(set(after) - set(before))
        changed = sorted(k for k in set(before) & set(after) if before[k] != after[k])
        print(f"{code:6s} DIFF missing={missing} extra={extra} changed={changed}")
        failed.append(code)
    if failed:
        print(f"FAIL: {len(failed)} languages differ: {failed}")
        return 1
    print(f"OK: all {len(CODES)} languages leaf-for-leaf identical to {BEFORE_REV}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 2: 跑对账**

```bash
PYTHONIOENCODING=utf-8 python /c/Users/fire/AppData/Local/Temp/arch/verify_overlay_equivalence.py > /c/Users/fire/AppData/Local/Temp/arch/equivalence.txt 2>&1; echo "equivalence rc=$?"
```

期望 rc=0，11 行 `EQUAL`，每行 `leaves=` 同一个数（写作时取证为 2185，**执行时当场读，不要照抄**），末行 `OK: all 11 languages leaf-for-leaf identical to b292dfb6`。

任何一枚 `DIFF` 都停下报告。这是本片唯一的语义承诺，红了就不许往下走。

- [ ] **Step 3: 取冲突面读数（耐久判据优先）**

```bash
git rev-parse --short upstream/main
git diff --name-only upstream/main HEAD -- frontend/src/i18n/locales/
git diff --numstat upstream/main HEAD -- frontend/src/i18n/index.ts frontend/src/i18next.d.ts
git diff --name-only upstream/main HEAD | wc -l
```

期望：第二条**输出为空**（这是耐久判据，不随上游推进而漂）；第三条 `index.ts` 的 deleted 列为 **0**、`i18next.d.ts` 为 +2/-1（退路 +3/-1）；第四条给出当前分叉总数，**引用时必须连 upstream sha 一起写**。

把四条读数落 `arch/conflict_after.txt`。spec §二 目标 5 的「76 → 67」是预期不是读数——这里只记现读值，不去凑那个数。

---

## Task 6: 变异自证 M1–M11

**Files:** 临时改 Task 1–4 落地的文件，每枚注入后**从内存副本还原**。

**Interfaces:**
- Consumes: Task 0 Step 4 的 sha256、Task 4 的全绿基线
- Produces: `arch/mutations.txt`——每枚的注入前读数、注入后红针名、还原后 sha256

**纪律（每枚都照做）**：先跑目标套件确认绿并记 sha256 → Python 读原始 bytes 存内存 → 字节级替换写回 → 跑目标套件**必须真红** → 从内存副本 `write_bytes` 还原 → 复校 sha256 与 `git diff` 为空。**禁止 `git checkout --` 还原**（树上有在飞改动）。每枚只改一处，还原后再动下一枚。

目标套件统一为：

```bash
cd frontend && npx vitest run src/i18n/fork/__tests__/forkOverlay.test.ts src/__tests__/navigationCopy.test.ts
```

门 A 类变异（M5/M7）改用 `cd frontend && npx tsc -b`。

- [ ] **Step 1: M1 — 某语言覆盖层删一枚键**

注入：`frontend/src/i18n/fork/ja.json` 里 `"help": "…"` 那一对键值删掉（`layout.help`，注意同时删掉前一行的尾逗号以保持 JSON 合法）。
期望红：`fork overlay parity for ja > carries every key the English overlay carries`；`runtime resolution for ja`；`fork overlay covers every fork-owned navigation entry > ja supplies all three copy families…`；`navigationCopy` 的 ja 三支。

- [ ] **Step 2: M2 — 某语言覆盖层加一枚无关键**

注入：`fork/de.json` 的 `layout` 分支里加 `"probe": "Probe"`。
期望红：`fork overlay parity for de > carries no key the English overlay lacks`。

- [ ] **Step 3: M3 — 删 `loadLanguage` 里那两行**

注入：`frontend/src/i18n/index.ts` 里 Step 2 追加的 `const { default: forkResources } …` 与 `i18n.addResourceBundle(code, "translation", forkResources, …);` 两行删掉（注释留着不影响编译，但 `forkLoaders` 会变成未消费 import ⇒ 门 A 也红，如实记）。
期望红：`runtime resolution` 的 **10 支非 en 全红、en 支仍绿**——这个不对称证明针分得清两侧注册。`language switching` 同因红。

- [ ] **Step 4: M4 — 删启动那句 en 注册**

注入：`frontend/src/i18n/index.ts` 里 `i18n.addResourceBundle("en", "translation", forkEn, true, true);` 一行删掉。
期望红：`runtime resolution for en`。**注意**：`forkEn` 仍被 import 但未消费 ⇒ 门 A 可能同时红，如实记；若只跑 vitest 则 en 支必红。

- [ ] **Step 5: M5 — d.ts 退回 `typeof en`**

注入：`frontend/src/i18next.d.ts` 的 `translation: typeof en & typeof forkEn;` 改回 `translation: typeof en;`。
期望红：门 A `tsc -b`，报错指向 `PageHelp.tsx`／`SidebarNavigation.tsx` 的模板字面量键。走退路的话改成 `translation: typeof en;` 同样红。

- [ ] **Step 6: M6 — 把一枚自研键并回某枚 locale**

注入：`frontend/src/i18n/locales/en.json` 的 `layout` 分支里加回 `"proChart": "Pro Chart"`（模拟同步轮的机械并集）。
期望红：`fork overlay stays out of upstream copy for en > shares no leaf path with the upstream locale`。

- [ ] **Step 7: M7 — `forkLoaders` 删一门语言**

注入：`frontend/src/i18n/fork/index.ts` 里 `tr: () => import("./tr.json"),` 一行删掉。
期望红：门 A（`satisfies Record<ForkLazyCode, …>` 缺键）。

- [ ] **Step 8: M8 — 某覆盖层值改成自身键路径**

注入：`fork/es.json` 的 `layout.alerts` 值改成字符串 `"layout.alerts"`。
期望红：`fork overlay copy quality for es > ships non-empty strings that are not their own key path`。

- [ ] **Step 9: M9 — 某覆盖层值改成英文原文（判别力针）**

注入：`fork/tr.json` 的 `layout.proChart` 值改成 en 侧的 `"Pro Chart"`。
期望红：`runtime resolution for tr`（`toBe` 覆盖层值 ⇒ 红）**且** `fork overlay Turkish copy > does not ship copied English`。
这枚专门否证「断言写宽了也能全绿」：若第 4 条只断「不等于键路径」，此针会存活。如实记录它确实红。

- [ ] **Step 10: M10 — 某一语言的覆盖层整份换成空对象**

注入：`fork/ko.json` 全文换成 `{}\n`。
期望红：`fork overlay parity for ko` 两支；`runtime resolution for ko`；`ko supplies all three copy families…`；`navigationCopy` 的 ko 三支。
再跑一次 Task 5 的对账脚本，期望 `ko DIFF` 且 rc=1，然后还原。

- [ ] **Step 11: M11 — 给某语言某键塞一个 en 侧没有的 `{{probe}}`（给空转条款判别力）**

注入：`fork/fa.json` 的 `layout.help` 值末尾追加 ` {{probe}}`。
期望红：`fork overlay copy quality for fa > interpolates the same variables as the English overlay`。
这枚是 spec §九 第 4 条要求的：该条款落地时 15 枚键 × 11 语言的变量集合全为空、判别力为 0，M11 是它唯一的存在证明。

- [ ] **Step 12: 复校还原并复跑**

```bash
git status --short
git diff --stat
python -c "
import hashlib
from pathlib import Path
for p in ['frontend/src/i18n/index.ts','frontend/src/i18next.d.ts','frontend/src/__tests__/navigationCopy.test.ts']:
    b=Path(p).read_bytes()
    print(p, 'CR', b.count(b'\r'), 'LF', b.count(b'\n'), 'sha256', hashlib.sha256(b).hexdigest())
"
```

`git diff --stat` 必须为空（Task 4 已提交，工作树干净）；三枚文件的 sha256 与 Task 4 提交后的值相同。覆盖层 11 枚同样复校。

```bash
cd frontend && npx vitest run src/i18n/fork/__tests__/forkOverlay.test.ts src/__tests__/navigationCopy.test.ts src/i18n/__tests__/i18n.test.ts; echo "restore rc=$?"
```

期望 rc=0。任何一枚变异**没红**，先算可达域并补针，不得把「没红」记成「已证」。

---

## Task 7: 门册 A–I ＋ 恒红门 0 贡献证明

**Files:** 无改动（只跑门）。

**Interfaces:**
- Consumes: Task 0 的 `baseline/gateH.txt`／`gateI.txt`／`frontend.txt`／`channel.txt`
- Produces: `arch/gates_after/` 九份读数 ＋ 归属判定

- [ ] **Step 1: 前端三门**

```bash
cd frontend && npx tsc -b; echo "A rc=$?"
```

```bash
cd frontend && npx vitest run > /c/Users/fire/AppData/Local/Temp/arch/gateB_after.txt 2>&1; echo "B rc=$?"
```

```bash
cd frontend && npx vite build > /c/Users/fire/AppData/Local/Temp/arch/gateC_after.txt 2>&1; echo "C rc=$?"
```

A/C 必须 rc=0。B 与基线逐名比对，新增红必须 0。

- [ ] **Step 2: 取证两门与 wiki 三套**

```bash
python tools/forensics_audit.py; echo "D rc=$?"
python -m pytest tools/test_forensics_spec.py -q; echo "E rc=$?"
```

```bash
python -X utf8 -m pytest tools/test_wiki_drift.py -q -m "not local_archive"; echo "F rc=$?"
python -X utf8 -m pytest tools/test_wiki_qmind.py tools/test_upstream_sync.py -q; echo "G rc=$?"
```

D/E/F/G 全须 rc=0。本片零 `forensics/**`／`wiki/**`／`repowiki/**` 改动，任何红都要先定因。

- [ ] **Step 3: 恒红门 H/I 复跑并逐字比对**

```bash
bash tools/wiki_freshness_gate.sh > /c/Users/fire/AppData/Local/Temp/arch/gateH_after.txt 2>&1; echo "H rc=$?"
bash tools/ci_grep_gates.sh > /c/Users/fire/AppData/Local/Temp/arch/gateI_after.txt 2>&1; echo "I rc=$?"
cmp /c/Users/fire/AppData/Local/Temp/arch/baseline/gateH.txt /c/Users/fire/AppData/Local/Temp/arch/gateH_after.txt; echo "H cmp rc=$?"
cmp /c/Users/fire/AppData/Local/Temp/arch/baseline/gateI.txt /c/Users/fire/AppData/Local/Temp/arch/gateI_after.txt; echo "I cmp rc=$?"
```

两条 `cmp` 都期望 rc=0（**字节相同**）。

- 若 H 不同：本片未动 `wiki/`／`repowiki/`，先查是不是别的过程在写 wiki；读数差逐字记，**不调阈值**。
- 若 I 不同：命中集变了。逐枚判跟踪态：

```bash
grep -oE '^\./[^:]+' /c/Users/fire/AppData/Local/Temp/arch/gateI_after.txt | sort -u > /c/Users/fire/AppData/Local/Temp/arch/gateI_after_files.txt
while read -r f; do git ls-files --error-unmatch "$f" >/dev/null 2>&1 && echo "TRACKED $f" || echo "untracked $f"; done < /c/Users/fire/AppData/Local/Temp/arch/gateI_after_files.txt
```

判据是 **TRACKED 0 枚**，且新增命中全为本片执行期自己产生的未跟踪 scratch。本片的 11 枚覆盖层 JSON、`fork/index.ts`、守卫测试、spec、本计划对商标 needle 的计数必须**逐枚为 0**：

```bash
PYTHONIOENCODING=utf-8 python -c "
from pathlib import Path
needle = ('world' + 'quant').encode()
paths = sorted(Path('frontend/src/i18n/fork').rglob('*')) + [
    Path('superpowers/specs/2026-11-08-fork-locale-overlay-design.md'),
    Path('superpowers/plans/2026-11-08-fork-locale-overlay.md'),
]
for p in paths:
    if p.is_file():
        print(p.as_posix(), p.read_bytes().lower().count(needle))
"
```

每个数都必须是 0。**不调排除表、不改门、不清白名单。**

- [ ] **Step 4: 定向后端腿复跑**

```bash
cd agent && python -m pytest tests/test_channel_config_meta.py -q; echo "channel rc=$?"
```

判据同 Task 4 Step 8：FAILED 名字集合与 Task 0 基线逐名相同、新增红为 0，**不要求 rc=0**（本机缺 `nh3`，恒红；见「执行期偏差」2026-11-08 条）。全量后端腿本片免跑：唯一的后端可见面就是这一枚文件读前端 `en.json`，已由 Task 5 的逐叶对账证明 en 的有效 bundle 未变（且该测试只走 channel 配置字段路径，与 15 枚键无交集）。

---

## Task 8: 活体验收（prod 构建 ＋ asset 指纹对账）

**Files:** 无改动。

**Interfaces:**
- Consumes: Task 7 门 C 产出的 `frontend/dist`
- Produces: `arch/live.txt`——指纹对账 ＋ 逐语言文案读数

- [ ] **Step 1: 起后端托管的 prod 构建**

先只读盘点 8000 端口上有没有旧进程（有旧进程就先确认它是谁起的，**不要**顺手杀别人的进程；若是本片之前自己起的验收进程，记下 PID 再停）：

```bash
netstat -ano | grep -E ':8000\s' | grep LISTENING || echo "8000 free"
```

端口空了再起。入口是 `agent/api_server.py:381` 的 `__main__` → `serve_main()`（`:374`）→ `agent/src/api/server_cli.py:11` 的 `serve()`；`serve()` 在 `:49-52` 判 `frontend/dist` 存在且没被别的 route 占住 `/`，就 `app.mount("/", SPAStaticFiles(..., html=True))` 并打印 `[prod] Frontend served from …`。**不加 `--dev`**：`:38` 那一支会另起 Vite（:5173），React dev 双跑 StrictMode，一次性副作用缺陷不属于本片。

```bash
cd agent && python -X utf8 api_server.py --host 127.0.0.1 --port 8000 > /c/Users/fire/AppData/Local/Temp/arch/server.log 2>&1
```

用 `run_in_background: true` 起（Bash 工具的参数，不是 shell 的 `&`）。起来后读日志确认那行 `[prod] Frontend served from` **真的出现**——只出现 `[warn] No frontend build found` 说明门 C 的 dist 不在预期位置，回去修，不要拿 dev server 凑数。

```bash
grep -nE '\[prod\]|\[warn\]|Uvicorn running' /c/Users/fire/AppData/Local/Temp/arch/server.log
```

验收结束后停掉**本片自己起的**那个进程（PID 从 `netstat` 现读），并把停机读数一并落 `arch/live.txt`。

- [ ] **Step 2: asset 指纹对账**

```bash
curl -s http://127.0.0.1:8000/ | grep -oE 'assets/index-[A-Za-z0-9_-]+\.js'
ls frontend/dist/assets/ | grep -E '^index-.*\.js$'
```

两个指纹必须**逐字相同**。不同说明服务的是旧进程或旧 dist，先解决再验收（光看状态码不够：SPA 兜底会把未注册路径答成 200+HTML）。

- [ ] **Step 3: 逐语言读三族文案**

在浏览器里至少切 **en／zh-CN／ar（RTL）／tr** 四门，每门读：

1. 侧栏里 `Pro Chart`／`Multi Chart`／`Alerts`／`Bar warehouse`／`Usage guide` 五个入口的**标签本体**（`SidebarNavigation.tsx:45`）
2.  compact 侧栏的 **link title**（`SidebarNavigation.tsx:49`，形如 `<label> — <description>`）
3.  展开后进 `/pro-chart` 与 `/help`，读 **PageHelp** 的标题（`navigation.howTo` 插值出 feature 名）与两段正文（descriptions／instructions）

每门的读数与 `frontend/src/i18n/fork/<code>.json` 里的值**逐字比对**。任何一处显示成字面点路径（如 `layout.proChart`）即失败。ar 还要确认 `<html dir="rtl">`。

- [ ] **Step 4: 顺手确认未被波及的面**

在同一活体里点一遍 **Bar Replay**（进 `/pro-chart`，开回放，拖游标，播放/暂停）与**画线面**（画一条线、删除、导入导出各一次），确认行为与本片前一致。本片不新增指标或信号 ⇒ **未来函数自查不适用**，在报告里如实这样写，不要编一套五步自查。

- [ ] **Step 5: 落读数**

把指纹两枚、四门语言 × 三族文案的比对结果、Bar Replay／画线面的点击结果落 `arch/live.txt`。读不到的项写「读不到」，不许升级成结论。

---

## Task 9: 档案、提交、推送、CI 复读

**Files:**
- Modify: `项目档案.md`（bytes 层追加，CRLF）
- Modify: `superpowers/plans/2026-11-08-fork-locale-overlay.md`（本文件，回填「执行期偏差」）
- Modify: `superpowers/specs/2026-11-08-fork-locale-overlay-design.md`（§九 已写，本步只提交）

**Interfaces:**
- Consumes: Task 5／6／7／8 的全部读数
- Produces: 档案新节 ＋ 两枚提交 ＋ origin/main ＋ CI 九腿读数

- [ ] **Step 1: 确定档案落点（现读，不猜）**

```bash
grep -n '^### 7\.' 项目档案.md | tail -3
python -c "
from pathlib import Path
b=Path('项目档案.md').read_bytes()
print('bytes',len(b),'CR',b.count(b'\r'),'LF',b.count(b'\n'),'ends_crlf',b.endswith(b'\r\n'))
"
```

节号取当前最大 +1，**当场读**。

- [ ] **Step 2: bytes 层追加档案节**

用 Python 读原始 bytes、在末尾追加、`write_bytes` 写回。追加块每行以 `\r\n` 结尾，**不要**用 `splitlines()` 拼（会丢 EOL），也不要在末尾留一个空串元素。追加后复校：

```python
assert crlf_after == crlf_before + len(added_lines)
assert lf_after == lf_before + len(added_lines)
```

内容至少含：归属（冲突面削减片，用户可见文案一字不变）、取证坐标（`b292dfb6`／`2ac20879`／落地提交号）、Task 5 的 11 行 `EQUAL` 与叶数、冲突面三条现读值（连 upstream sha）、RED-A／RED-B／GREEN 三段红绿分布、M1–M11 逐枚实际红针名、门册 A–I 逐条 rc 与恒红门 `cmp` 结果、活体指纹与四门语言读数、以及「未做独立子代理评审（用户拒绝 Agent 派单），由执行者按同一判据自审」。

**所有数字现填，不预填、不引用本计划里的任何枚数。**

- [ ] **Step 3: 改完复跑读档门**

```bash
python tools/forensics_audit.py; echo "D rc=$?"
python -m pytest tools/test_forensics_spec.py -q; echo "E rc=$?"
python -X utf8 -m pytest tools/test_wiki_drift.py -q -m "not local_archive"; echo "F rc=$?"
bash tools/wiki_freshness_gate.sh > /c/Users/fire/AppData/Local/Temp/arch/gateH_final.txt 2>&1; echo "H rc=$?"
cmp /c/Users/fire/AppData/Local/Temp/arch/baseline/gateH.txt /c/Users/fire/AppData/Local/Temp/arch/gateH_final.txt; echo "H cmp rc=$?"
bash tools/ci_grep_gates.sh > /c/Users/fire/AppData/Local/Temp/arch/gateI_final.txt 2>&1; echo "I rc=$?"
```

D/E/F 须 rc=0；H 的 `cmp` 须 rc=0；I 若红，命中集里新增的必须全是未跟踪 scratch，且档案新节对商标 needle 计数为 0。

- [ ] **Step 4: 回填本计划的「执行期偏差」**

在本文件末尾的「执行期偏差」节按日期追加实际读数与裁定（LF，bytes 层或 Edit 均可，改完 CR 必须仍为 0）。至少记：上游 sha 是否仍为 `2ac20879`、类型退路走没走、RED-A/RED-B 的实际红针分布与预期是否一致、M1–M11 有没有没红的、恒红门 `cmp` 是否字节相同。

- [ ] **Step 5: 提交文档面（显式 pathspec）**

```bash
git add 项目档案.md superpowers/plans/2026-11-08-fork-locale-overlay.md superpowers/specs/2026-11-08-fork-locale-overlay-design.md
git diff --cached --numstat
git commit -s -m "docs(ledger): record the fork locale overlay landing" -m "Eleven upstream locale files return to their upstream bytes; every language's effective bundle reconciles leaf-for-leaf against b292dfb6. Includes the planning-phase spec corrections and the mutation readings." -- 项目档案.md superpowers/plans/2026-11-08-fork-locale-overlay.md superpowers/specs/2026-11-08-fork-locale-overlay-design.md
git status --short
```

`git status --short` 之后必须只剩 Task 0 记下的那两枚未跟踪路径（`.superpowers/` 与 `superpowers/plans/2026-10-05-m4-qmind-m5-shard1.md`）。**不许把它们扫进提交。**

- [ ] **Step 6: 快进合入本地 main**

本片三枚提交（Task 1 Step 6、Task 4 Step 9、本任务 Step 5）都落在 `feat/fork-locale-overlay` 上。合入前先只读看清要合的是哪几枚：

```bash
git rev-parse --abbrev-ref HEAD
git log --oneline main..HEAD
git status --short
git switch main
git merge --ff-only feat/fork-locale-overlay
git rev-parse HEAD
git rev-parse HEAD^{tree}
git rev-parse feat/fork-locale-overlay^{tree}
```

期望：第一条 `feat/fork-locale-overlay`；第二条恰列本片那几枚（枚数现数，别引用这里的措辞）；第三条只剩那两枚既有未跟踪路径；`--ff-only` 成功；**最后两条树哈希逐字相同**（快进不改树，这是「合进来的就是我验过的那棵」的凭据）。

`--ff-only` 若失败，说明本地 `main` 在本片期间被别的东西推进了（例如一轮同步在本地落了地）。**停下**，先 `git log --oneline -5 main` 只读看它是什么，再决定合并形状；不要 rebase，不要 `--no-ff` 硬造一个合并提交把读数搅浑。

- [ ] **Step 7: 推送前对远程真值**

```bash
git ls-remote origin refs/heads/main
git rev-parse HEAD
git log --oneline -4
```

远程 main 若等于 Task 0 Step 1 记下的那枚本地起点（**现读比对，不要引用这里写死的短 sha**——plan 自己那笔提交也会推进 main）⇒ 快进推送：

```bash
git push origin HEAD:main
```

远程 main 若已被 cron 推进 ⇒ **改道 merge，不 rebase**。先做零写入预检，看清会不会冲突再动手：

```bash
git fetch origin
git merge-base HEAD origin/main
git merge-tree --write-tree --name-only HEAD origin/main; echo "merge-tree rc=$?"
```

`merge-tree` rc=0 ⇒ 无冲突，直接合；rc=1 ⇒ 它会把冲突文件名列出来，先读那份名单定因（本片把 11 枚 locale 撤回了上游字节，理论上 locale 桶应当消失；若名单里仍有 locale，说明上游这一轮又改了它们，那是真冲突不是回归）。然后：

```bash
git merge --signoff origin/main
```

解冲突后复跑门 A 与读档门（Step 3），再推。`git merge --signoff` 不重写 SHA，盖章安全。

- [ ] **Step 8: 推送后对账并复读 CI**

```bash
git ls-remote origin refs/heads/main
git rev-parse HEAD
gh run list --branch main --limit 5
```

两个 sha 必须相同。取最新一次 run，逐腿读结论；任何红腿用 `/check-runs/<id>/annotations` 取名（**父载荷的 `annotations_count` 是 `None`，不可用**），每步十条是硬预算、要按腿算。读数回填本计划的「执行期偏差」。

---

## 执行期偏差（执行时回填）

### 2026-11-08 — Task 0 基线：channel 腿在未改动树上恒红，判据改为名字集合比对

**读数（当场测，源文件在仓库外 `%TEMP%/arch/baseline/`）**

- 树状态：`main`，HEAD `9df83cbb`，工作树除两枚既存未跟踪路径外干净。
- `frontend_rc.txt`：A rc=0、B rc=0、C rc=0、**channel rc=1**。
- `frontend.txt`：`Test Files 164 passed (164)`、`Tests 2609 passed (2609)`、`Start at 19:04:36`、`Duration 144.10s`。
- `channel.txt`：`3 failed, 77 passed, 10 skipped in 2.28s`；三枚 FAILED 名字见该文件 `^FAILED` 行（`test_unloadable_adapter_is_handled_gracefully`、`test_split_never_leaks_secret_keys_in_values[email]`、`…[slack]`）。
- `gate_rc.txt`：H rc=1、I rc=1（既存恒红，`gateI_tracked.txt` 的 TRACKED 为 0）。

**定因（systematic-debugging Phase 1–3，未改任何代码）**

调用链：`tests/test_channel_config_meta.py:812` → `src/channels/registry.py:163` 的 `importlib.import_module` → `src/channels/email.py:24` → `src/channels/rich_text.py:9` 的 `import nh3` → `ModuleNotFoundError: No module named 'nh3'`。异常被测试的 `except Exception` 吞掉后，断言「加载失败应降级为空 hints」不成立（email 多出 33 项、slack 多出 12 项），因为 hints 走的是另一条不依赖该模块的路径。

三条证据证明**与本片零关系、与 fork 零关系**：

1. `importlib.util.find_spec('nh3')` 返回 `None`（解释器 `…\Python311\python.exe`）——本机缺包。
2. `nh3` 是**上游自己声明**的依赖：`git show upstream/main:agent/requirements.txt` 第 79 行 `nh3>=0.2.18`，`pyproject.toml:88` 同；`git show upstream/main:agent/src/channels/rich_text.py` 第 9 行就是 `import nh3`。
3. 四枚涉事文件（`test_channel_config_meta.py`／`rich_text.py`／`email.py`／`registry.py`）的 `git rev-parse HEAD:<path>` 与 `git rev-parse upstream/main:<path>` **blob 哈希逐一相同**；`git -C <repo root> diff --stat upstream/main -- <五枚路径>` 输出为空。本片改动面全在 `frontend/**`，不含任何后端文件。

**裁定**

- 记为本片的**基线分母**，不修。Task 0 Step 3、Task 4 Step 8、Task 7 Step 4 的判据已同步改为「FAILED 名字集合与基线逐名相同、新增红为 0」，不再要求 rc=0。
- **不装 `nh3`、不动 Python 工具链**（长期约束：工具链一律不许动；Never silently install system dependencies）。装包会把恒红门变成绿门，反而丢掉「本片 0 贡献」的可比性。
- 不调阈值、不改门、不清白名单、不改这三枚测试。

**方法论留痕（差点报出假绿）**

第一次跑的 `git diff --stat upstream/main -- agent/...` 输出为空，我一度把它当成「与上游相同」的证据。实际上 Bash 的工作目录当时停在 `frontend/`（门 A/B/C 留下的），pathspec 相对 cwd 解析 ⇒ 匹配不到任何文件 ⇒ **空输出是零命中的假绿**。改用 `git -C <repo root>` 重跑，并另用 `git rev-parse HEAD:<path>`（这条永远相对仓库根）做 blob 等式独立复核，两者一致才采信。教训与既有记忆条目「计数口径造出的假缺陷／零命中先验通道」同型：**凡是「空输出即通过」的判据，先证通道真的能命中。**
