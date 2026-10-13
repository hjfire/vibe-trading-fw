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
import os
import re
from pathlib import Path

L0_REQUIRED_KEYS: tuple[str, ...] = ("命令", "evidence_id", "浏览器", "目标 URL", "观察条件", "完整性")
L0_PURPOSES: tuple[str, ...] = ("harness", "规格", "基线")
L0_EXEMPT: frozenset[str] = frozenset({"_example.md"})
SPEC_EXEMPT: frozenset[str] = frozenset({"_example.md"})

EVIDENCE_ID = re.compile(r"ev_[0-9a-f]{64}")
KEY_LINE = re.compile(r"^- ([^：\n]{1,24})：(.*)$")
PROBE_APP_JS = "tools/rea_probe_site/app.js"

SPEC_HEADER = "| 条目号 | 规格句 | 判据 | 判据类型 | L0 依据 |"
ENTRY_ID = re.compile(r"TV-[A-Z][A-Z0-9]*-\d{2}")
VERDICT_TYPES: tuple[str, ...] = ("DOM", "状态", "像素")
MIN_VERDICT_LEN = 12

MATRIX_HEADER = "| 条目号 | 状态 | 本仓坐标或搜索记录 | 优先级 | 说明 |"
MATRIX_STATUSES: tuple[str, ...] = ("已有", "部分", "缺", "不可复刻")
MATRIX_PRIORITIES: tuple[str, ...] = ("高", "中", "低", "-")
COORD = re.compile(r"[\w./-]+:\d+")


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


def _command_hygiene(rel: str, cmd: str) -> list[str]:
    """命令卫生：Global Constraint 5 是无条件的，不可取证的记录同样要限住自己的输出。"""
    v: list[str] = []
    if cmd and "rea-agents" not in cmd:
        v.append(f"{rel}: 命令里没有 rea-agents，这不是一条 REA 取证记录")
    if cmd and "--filter-output" not in cmd and "--token-limit" not in cmd:
        v.append(f"{rel}: 命令既没有 --filter-output 也没有 --token-limit（证据体积会吃掉内存）")
    return v


def _audit_l0(path: Path, rel: str, repo_root: Path) -> tuple[list[str], str | None]:
    """One L0 record -> (violations, declared 用途 or None)."""
    v: list[str] = []
    text = _read(path)
    keys = _meta_keys(text)

    if "不可取证" in keys.get("状态", ""):
        cmd = keys.get("命令", "")
        if not cmd:
            v.append(f"{rel}: 不可取证的记录也要写清 命令：（到底试过哪一条）")
        if not keys.get("原因"):
            v.append(f"{rel}: 标记为不可取证但没有 原因：")
        v += _command_hygiene(rel, cmd)
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
    v += _command_hygiene(rel, cmd)

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


def _table(text: str, header: str) -> tuple[bool, list[list[str]], list[str]]:
    """(header_seen, five-column data rows, raw text of `|` rows not audited as entries).

    一张表 = 以逐字 ``header`` 开头的那一段**连续** ``|`` 行：第一条非 ``|`` 行
    （散文、标题、空行）就关掉行窗口，所以同一文件后面不相干的管道表不会被当成
    这张表的条目（否则真实 L1 文档里的备注／统计表会造出幻影违规）。
    ``header_seen`` 是整个文件范围的——出现过一次逐字表头就算这文件有表。
    作用域约定：第二张同表头的规格表照样解析（表头重开窗口），但返回的 ``rows``
    把每张规格表的行合并到一个文件里，``_audit_spec`` 的条目号查重因此是**文件**
    作用域，与它的消息文案「在 {rel} 里出现 N 次」一致。
    分隔行必须含 ``-``：`|  |  |  |  |  |` 这种全空数据行不是 `|---|---|`，
    它要落到「空单元格」的判据上，不能被静默丢掉。
    窗口之外的行也有条件地上报（修复轮 2 R1，别把「连续性」读成「可以静默丢」）：
    表头**之后**、窗口之外的 ``|`` 行，如果首格整段匹配 ``ENTRY_ID``，就是「掉出
    窗口的疑似规格行」，原文进 ``bad``——``header`` 与行之间夹一个空行的规格文档
    于是报违规，而不是零条目零违规地过审。门禁只在首格像条目号：散文里的普通
    Markdown 表（首格是「面」／「DW」）继续不进任何列表，表头**之前**的行也不进
    （defer 的 rows-above-header，本轮不顺手修）。因此 ``bad`` 有两种成因，调用方
    必须按列数分派消息（见 ``_audit_spec``）：不是 5 列的报「列数不是 5」，正好
    5 列的那一种是窗口问题，拿「列数不是 5」说它就是在撒谎。
    """
    seen = False
    window_open = False  # 表头之后、第一条非 `|` 行之前：这一段才是这张表的行
    rows: list[list[str]] = []
    bad: list[str] = []
    for line in _outside_fences(text):
        s = line.strip()
        if s == header:
            seen = True
            window_open = True
            continue
        if not s.startswith("|"):
            window_open = False
            continue
        if not window_open:
            if seen and ENTRY_ID.fullmatch(s.strip("|").split("|")[0].strip()):
                bad.append(s)  # 表头之后掉出窗口的疑似规格行：进 bad，不消失
            continue
        if "-" in s and set(s) <= set("|-: "):  # the |---|---| separator row
            continue
        cells = [c.strip() for c in s.strip("|").split("|")]
        if len(cells) == 5:
            rows.append(cells)
        else:
            bad.append(s)
    return seen, rows, bad


def _resolve_l0(forensics_root: Path, ref: str) -> str | None:
    """Accept ``l0/x.md`` or a bare ``x.md``; return the resolved file name or None.

    判据说的是「L0 依据 必须指向存在的 **l0** 文件」，所以唯一的规则是**落点**：
    解析后仍在 ``forensics_root/l0/`` 里的文件才算命中，其余都是 None，调用方报
    「指向的文件不存在」（``spec/drawings.md`` 规格自引、``gap-matrix.md`` 这类
    同树非 l0 文件、``../outside.md`` 这种 l0/ 下没有同名文件的写法）。
    「写法」本身不作限制：两个候选里裸名那一个先把 ``ref`` 折成末段（basename），
    所以带目录的引用只要末段在 l0/ 里存在就命中——实测
    ``C:/elsewhere/probe-skeleton.md``／``/elsewhere/probe-skeleton.md``／
    ``../probe-skeleton.md`` 都返回 ``probe-skeleton.md``，因为落点是
    ``forensics_root/l0/probe-skeleton.md``。证据于是仍然真实存在，只是引用方写得
    绕；要改成「只接受两种写法」得连本 slice 后续任务引用的解析语义一起改，
    本轮不动行为（见 report §9.3）。两种被接受的写法与多份依据（``、``／`,` 分隔）
    都继续生效。
    """
    l0_dir = (forensics_root / "l0").resolve()
    name = ref.rsplit("/", 1)[-1]
    for cand in (forensics_root / "l0" / name, forensics_root / ref):
        try:
            hit = cand.resolve()
        except (OSError, ValueError):  # 坏路径（符号环／NUL 字节）：当作没找到，不许崩
            continue
        if hit.is_file() and l0_dir in hit.parents:
            return name
    return None


def _audit_spec(path: Path, rel: str, forensics_root: Path) -> tuple[list[str], set[str], list[str]]:
    v: list[str] = []
    text = _read(path)
    seen, rows, bad = _table(text, SPEC_HEADER)
    if not seen:
        return [f"{rel}: 表头不是逐字的 {SPEC_HEADER}，文件里没有规格表"], set(), []
    # `bad` 的两种成因（_table 的 docstring）按列数分派，免得拿「列数不是 5」
    # 去描述一行正好五列、只是掉出窗口的疑似规格行。
    narrow = [s for s in bad if len(s.strip("|").split("|")) != 5]
    outside = [s for s in bad if len(s.strip("|").split("|")) == 5]
    if narrow:
        v.append(f"{rel}: 有 {len(narrow)} 行的列数不是 5（表行必须正好五列）：{narrow[0]!r}")
    if outside:
        v.append(
            f"{rel}: 有 {len(outside)} 行落在规格表窗口之外（表头与它之间隔了非 `|` 行），"
            f"这些行没有被当成条目审计：{outside[0]!r}"
        )
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
            elif resolved in L0_EXEMPT and path.name not in SPEC_EXEMPT:
                # 样例豁免件是**本地探针页**的记录，跟 tradingview.com 没有任何关系。
                # `_resolve_l0` 只认落点，`l0/_example.md` 又是 l0/ 下的真文件，所以它过去
                # 能被真实条目当依据且**不红**——`audit_forensics` 把 `_example.md` 从 l0／spec
                # 两个名单里滤掉了，孤证规则也看不见它，这个洞是静默的（评审 I5）。
                # 「当前规格文件自己是否豁免」按 `SPEC_EXEMPT` 里的文件名判，与
                # `audit_forensics:358-360` 走查时用的 `q.name` 同一把尺：样例引样例仍合法。
                v.append(
                    f"{tag}: L0 依据 {ref!r} 落在样例豁免件上——样例证据不能当真实条目的依据（真实条目必须指实抓记录）"
                )
            else:
                cited.add(resolved)
    for dup in sorted({i for i in ids if ids.count(i) > 1}):
        v.append(f"{rel}: 条目号 {dup} 在 {rel} 里出现 {ids.count(dup)} 次")
    return v, cited, ids


def _audit_matrix(path: Path, rel: str, repo_root: Path, spec_ids: dict[str, str]) -> list[str]:
    """One L2 gap matrix -> violations, cross-checked against the spec layer's entry ids.

    ``spec_ids`` 只读它的键集合（条目号）；值那半份「条目号→首个出现它的 spec 文件」是给
    ``audit_forensics`` 的跨文件查重用的，本函数不碰。
    """
    v: list[str] = []
    seen, rows, bad = _table(_read(path), MATRIX_HEADER)
    if not seen:
        return [f"{rel}: 表头不是逐字的 {MATRIX_HEADER}，文件里没有差距矩阵表"]
    # 与 `_audit_spec` 同一套分派（`_table` 的 docstring）：`bad` 有两种成因，
    # 拿「列数不是 5」去描述一行正好五列、只是掉出窗口的矩阵行就是在撒谎。
    narrow = [s for s in bad if len(s.strip("|").split("|")) != 5]
    outside = [s for s in bad if len(s.strip("|").split("|")) == 5]
    if narrow:
        v.append(f"{rel}: 有 {len(narrow)} 行的列数不是 5（表行必须正好五列）：{narrow[0]!r}")
    if outside:
        v.append(
            f"{rel}: 有 {len(outside)} 行落在差距矩阵窗口之外（表头与它之间隔了非 `|` 行），"
            f"这些行没有被当成矩阵行审计：{outside[0]!r}"
        )
    counts: dict[str, int] = {}
    root_dir = repo_root.resolve()  # 「本仓坐标」的落点域：仓库根之内
    funnel = path.parent.resolve()  # 矩阵住在漏斗根 ⇒ path.parent 就是 docs/forensics/
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
            # 「已有／部分」是本仓的声称，必须落到一个数得出来的坐标上。
            if not COORD.fullmatch(coord):
                v.append(f"{tag}: 状态 {status} 要给本仓坐标 file:line，实际是 {coord!r}")
                continue
            f, _, ln = coord.rpartition(":")
            try:
                hit = (repo_root / f).resolve()
            except (OSError, ValueError):  # 坏路径（符号环／NUL 字节）：出违规，不许回溯（同 _resolve_l0）
                v.append(f"{tag}: 坐标 {coord} 的路径解析不了")
                continue
            if root_dir not in hit.parents:
                # `repo_root / f` 会把 `../x`／UNC／盘符绝对路径整个挪到仓外，那份文件不是本仓的。
                v.append(f"{tag}: 坐标 {coord} 解析到 {hit}，在仓库根之外，不是本仓的文件")
                continue
            if funnel in hit.parents:
                # 漏斗产物不能自证：矩阵给 `docs/forensics/**` 里的自己或 L0 记录发「已有」，
                # 是把「我写了这句话」当成「本仓有这段实现」。
                v.append(f"{tag}: 坐标 {coord} 指的是取证漏斗自己的文档（docs/forensics/**），不能自证")
                continue
            if not hit.is_file():
                v.append(f"{tag}: 坐标 {coord} 的文件不存在")
                continue
            try:
                n = len(_read(hit).splitlines())
            except (OSError, ValueError):  # 存在但读不动（权限／坏字节）：同样是违规（本机造不出这种文件，无针）
                v.append(f"{tag}: 坐标 {coord} 的文件读不出来")
                continue
            digits = ln.lstrip("0") or "0"  # 先比位数再 int()：4301 位的数字串会让 int() 抛 ValueError，
            # 回溯穿出 audit_forensics／main()，前面 collected 的违规一条也不打印（同 :199 那条规则）。
            if digits == "0":
                v.append(f"{tag}: 坐标 {coord} 的行号 {ln} 不在 1..{n} 之内（行号从 1 开始）")
            elif len(digits) > len(str(n)):  # 位数就已经超过，不必转成整数，也别把四千位数字印进消息
                v.append(f"{tag}: 坐标 {f} 的行号写了 {len(digits)} 位数字，超出 {f} 的实际 {n} 行")
            elif int(digits) > n:
                v.append(f"{tag}: 坐标 {coord} 的行号 {ln} 超出 {f} 的实际 {n} 行")
        elif status == "缺":
            # 「缺」留下的必须是能复跑的搜索记录，不是一句「没有」。
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
            v.append(f"{rel}: 矩阵里的 {eid or '(空)'} 在任何规格文件里都不存在（凭空条目）")
    return v


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
    purposes: dict[str, str | None] = {}
    for p in l0_files:
        problems, purpose = _audit_l0(p, f"l0/{p.name}", repo_root)
        v += problems
        purposes[p.name] = purpose

    cited: set[str] = set()
    spec_ids: dict[str, str] = {}
    spec_format_failure = False  # 规格层有没有格式失败（列数／窗口）——它决定这一轮能不能下引用结论
    spec_dir = forensics_root / "spec"
    for p in sorted(
        q for q in (spec_dir.glob("*.md") if spec_dir.is_dir() else []) if q.name not in SPEC_EXEMPT
    ):
        rel = f"spec/{p.name}"
        problems, refs, ids = _audit_spec(p, rel, forensics_root)
        v += problems
        cited |= refs
        # 「列数不是 5」／「窗口之外」是 `_audit_spec` 里 `bad` 那两条消息的签名（只有文件级
        # 消息带它们，行级消息一律是 `{rel} 条目 …` 前缀）。按消息子串判而不改返回值形状。
        if any("列数不是 5" in x or "窗口之外" in x for x in problems):
            spec_format_failure = True
        # 条目号是三层咬合的主键：两份表各写一遍就能冒充两条规格，所以后一份要报。
        for i in ids:
            first = spec_ids.setdefault(i, rel)
            if first != rel:
                v.append(f"{rel}: 条目号 {i} 已在 {first} 里出现过")

    # 孤证规则只在规格侧真解析出条目号、且整层没有格式失败时才开口：表写坏了 ⇒ `cited` 是
    # 残缺的，那时候说「没人引用这份证据」是在拿规格的格式失败 blame 证据文件。
    # 取舍：一处格式失败 ⇒ 这一轮别处没被引用的证据也不再上报，但树已经红了，不会漏过。
    if spec_ids and not spec_format_failure:
        for name in sorted(purposes):
            if name not in cited and purposes[name] not in ("harness", "基线"):
                v.append(f"l0/{name}: 没有被任何规格条目引用，也没标 用途：harness 或 用途：基线")

    # 矩阵走查不挂在 `if spec_ids:` 上：规格表写坏的时候，矩阵自己的表头／域／坐标
    # 判据更要照跑，否则整层判据被一个上游格式失败静默跳过。缺文件那条才需要条目数。
    matrix = forensics_root / "gap-matrix.md"
    if matrix.is_file():
        v += _audit_matrix(matrix, "gap-matrix.md", repo_root, spec_ids)
    elif spec_ids:
        v.append(f"有 {len(spec_ids)} 条规格条目但 docs/forensics/gap-matrix.md 不存在")
    return v


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


def _scannable_files(root: Path) -> tuple[list[Path], list[str]]:
    """Walk ``root`` and report directories we could not list.

    ``Path.rglob`` swallows ``PermissionError`` internally, so a deny-read subdirectory
    makes the host red line return a clean list while blind to exactly what it exists to
    refuse. ``os.walk`` with ``onerror`` surfaces that instead of hiding it. ``followlinks``
    stays False on purpose: this walk must not be able to loop.
    """
    files: list[Path] = []
    unlistable: list[str] = []

    def _note_error(err: OSError) -> None:
        unlistable.append(str(getattr(err, "filename", "") or err))

    for dirpath, _dirs, names in os.walk(root, onerror=_note_error):
        files.extend(Path(dirpath) / name for name in names)
    return files, unlistable


def audit_tv_host_allowlist(repo_root: Path) -> list[str]:
    """Spec ruling 1: TradingView is a research subject, never a dependency."""
    v: list[str] = []
    src = repo_root / "frontend" / "src"
    if not src.is_dir():
        return [f"{src} 不存在：无法核对 TradingView 主机白名单"]
    hits: set[str] = set()
    s3_counts: dict[str, int] = {}
    files, unlistable = _scannable_files(src)
    for dirpath in sorted(unlistable):
        try:
            rel_dir = Path(dirpath).relative_to(repo_root).as_posix()
        except ValueError:
            rel_dir = dirpath
        v.append(f"{rel_dir} 列不出来（权限／竞态）：主机红线看不见里面的文件，不许当作没有依赖")
    for p in sorted(files, key=lambda q: q.relative_to(repo_root).as_posix()):
        if not p.is_file() or p.suffix not in (".ts", ".tsx"):
            continue
        rel = p.relative_to(repo_root).as_posix()
        try:
            text = _read(p)
        except (OSError, ValueError):
            v.append(f"{rel}: 读不出来（权限／竞态）——不许把读不动的文件当作「不含 tradingview.com」")
            continue
        low = text.lower()
        if "tradingview.com" in low:
            hits.add(rel)
        n = low.count("s3.tradingview")
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
        try:
            widget_text = _read(widget)
        except (OSError, ValueError):
            v.append(f"{S3_HOST_FILE}: 读不出来（权限／竞态）——逐字主机子式没法核对")
        else:
            if TV_SUPPORT_HOST_LINE not in widget_text:
                v.append(f"{S3_HOST_FILE}: 逐字行 {TV_SUPPORT_HOST_LINE} 不见了或被改过——"
                         "那是对外部站点的运行时依赖，改动要重新裁定")
            if TV_WIDGET_SRC_LINE not in widget_text:
                v.append(f"{S3_HOST_FILE}: 逐字行 {TV_WIDGET_SRC_LINE} 不见了或被改过——同上")
    return v


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


if __name__ == "__main__":
    raise SystemExit(main(Path(__file__).resolve().parents[1]))
