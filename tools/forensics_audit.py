"""Enforce the REA forensics funnel contract under ``docs/forensics/``.

The funnel only holds if every level's artefact is machine-checkable: an L0
record without an ``evidence_id`` is a memory, a spec entry without a verdict is
prose, and a gap row without a coordinate is a guess. This module turns those
three sentences into violations so the test suite can refuse them, and it
carries the funnel side of the compliance red line as two *content* criteria on
L0 records: an image body (a ``data_base64`` payload) never enters the repo —
pixel evidence is only ``sha256`` + ``bytes`` + ``media_type`` — and a
third-party page's markup body（标记正文）is never transcribed into an L0
record. The
runtime-dependency half of that red line is not carried here: it lives in
``audit_tv_host_allowlist`` below.

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
# 不是 用途 的第四种合法值，是 `_audit_l0` 给 `状态：不可取证` 记录的专用回执。它必须和
# 「完整记录但没写 用途」那个 None 分开：后者正是孤证规则要挡的形状，前者记的是一面拿不到
# 判据的面——给它编一条规格条目去引用，撞的是「写不出判据不算条目」那条红线。
UNCAPTURABLE: str = "不可取证"
L0_EXEMPT: frozenset[str] = frozenset({"_example.md"})
SPEC_EXEMPT: frozenset[str] = frozenset({"_example.md"})

EVIDENCE_ID = re.compile(r"ev_[0-9a-f]{64}")
KEY_LINE = re.compile(r"^- ([^：\n]{1,24})：(.*)$")
PROBE_APP_JS = "tools/rea_probe_site/app.js"

# 内容红线（评审 A 的 C1 两半，spec 那一节的「硬红线」逐字：`data_base64` 绝不准进仓库、
# L0 里像素证据只落 sha256＋bytes＋media_type；不拷 TV 源码／标记正文）。两条都只对**内容**
# 开口，都不数行多长：通用「超长行」阈值被控制席两次否决（现测活树最长行 3,103，且它正落在
# 即将变长的 CI-07 格里），任意的数下次编辑就变成假红。
DATA_BASE64_PAYLOAD = re.compile(r"""data_base64["'\s:=]*[A-Za-z0-9+/]{200,}""")
THIRD_PARTY_MARKUP = re.compile(r'<!doctype|<html|class="tv-', re.IGNORECASE)
TV_PAGE_HOST = "tradingview.com"

# 命令形状（评审 A 的 N2）：旧判据 `"rea-agents" in cmd` 连 `curl https://x/rea-agents` 都放过。
# 只钉形状，**不做子命令白名单**——REA 的词汇表写在文档里还会加，钉死词表＝下次多一条命令就假红。
REA_COMMAND_SHAPE = re.compile(r"npx\s+-y\s+rea-agents@latest\s+([a-z-]+)")

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
    if cmd and not REA_COMMAND_SHAPE.search(cmd):
        v.append(f"{rel}: 命令里没有 rea-agents@latest 的 REA 形状（要 `npx -y rea-agents@latest <子命令> …`）")
    if cmd and "--filter-output" not in cmd and "--token-limit" not in cmd:
        v.append(f"{rel}: 命令既没有 --filter-output 也没有 --token-limit（证据体积会吃掉内存）")
    return v


def _l0_evidence_id(path: Path) -> str:
    """一份 L0 记录的主键；读不出来或没写就回 ""（读失败那条由 `_audit_l0` 报，这里不重复）。"""
    try:
        return _meta_keys(_read(path)).get("evidence_id", "")
    except (OSError, ValueError):  # 权限／竞态／目录当文件：交给 `_audit_l0` 说，这里不许打穿调用方
        return ""


def _audit_l0(path: Path, rel: str, repo_root: Path) -> tuple[list[str], str | None]:
    """One L0 record -> (violations, declared 用途／UNCAPTURABLE／None)."""
    v: list[str] = []
    try:
        text = _read(path)
    except (OSError, ValueError):  # 评审 A 的 I3：回溯穿出 audit_forensics 就吞掉全部已收集的违规
        return [f"{rel}: 读不出来（权限／竞态），这份记录没被审计"], None
    keys = _meta_keys(text)

    if DATA_BASE64_PAYLOAD.search(text):
        v.append(
            f"{rel}: 图像本体（`data_base64` 后面跟着 base64 载荷）一字节都不许进仓——"
            "像素证据只落三键：sha256＋bytes＋media_type"
        )
    # 只对「真实三方页记录」开口：自家页与探针页的标记本来就在仓里，拿同一把尺量它
    # 就把「观察自己的页面」变成了违规；`_example.md` 由 L0_EXEMPT 挡在走查之外。
    if TV_PAGE_HOST in keys.get("目标 URL", "").lower() and THIRD_PARTY_MARKUP.search(text):
        v.append(
            f"{rel}: 目标 URL 是 {TV_PAGE_HOST} 的三方页记录里出现标记正文（`<!DOCTYPE`／`<html`／`class=\"tv-`）——"
            "不拷第三方源码与标记正文，只落结构化读数与三键 sha256＋bytes＋media_type"
        )

    if "不可取证" in keys.get("状态", ""):
        cmd = keys.get("命令", "")
        if not cmd:
            v.append(f"{rel}: 不可取证的记录也要写清 命令：（到底试过哪一条）")
        if not keys.get("原因"):
            v.append(f"{rel}: 标记为不可取证但没有 原因：")
        v += _command_hygiene(rel, cmd)
        return v, UNCAPTURABLE

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
            try:
                raw = app.read_bytes()
            except (OSError, ValueError):  # 同 I3：核不了校验和要说出来，不许把回溯打出去
                v.append(f"{rel}: {PROBE_APP_JS} 读不出来（权限／竞态）——harness 的 sha256 没法核对")
            else:
                want = hashlib.sha256(raw.replace(b"\r\n", b"\n")).hexdigest()
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
    try:
        text = _read(path)
    except (OSError, ValueError):  # 评审 A 的 I3：同 `_audit_l0`，读不动 ⇒ 违规，不许回溯
        return [f"{rel}: 读不出来（权限／竞态），这份规格没被审计"], set(), []
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
    try:
        matrix_text = _read(path)
    except (OSError, ValueError):  # 评审 A 的 I3：矩阵侧原本把 `_read` 裸写在调用里，同形缺陷同法兜
        return [f"{rel}: 读不出来（权限／竞态），差距矩阵没被审计"]
    seen, rows, bad = _table(matrix_text, MATRIX_HEADER)
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
    l0_candidates = sorted(l0_dir.glob("*.md")) if l0_dir.is_dir() else []
    l0_files = [p for p in l0_candidates if p.is_file() and p.name not in L0_EXEMPT]
    # 评审 A 的 I3②：`glob` 连目录一起返回，旧写法拿它当文件去 `read_text()`，于是
    # 一个叫 `x.md` 的目录把整个门禁打穿成回溯。加 `is_file()` 守卫，但**不许静默跳过**。
    for p in l0_candidates:
        if not p.is_file() and p.name not in L0_EXEMPT:
            v.append(f"l0/{p.name}: 是目录不是文件——L0 记录得是一份 markdown 文件，这一份没被审计")
    if not l0_files:
        v.append("docs/forensics/l0/ 下没有任何证据文件（骨架不等于取证）")
    purposes: dict[str, str | None] = {}
    by_evidence: dict[str, list[str]] = {}
    for p in l0_files:
        problems, purpose = _audit_l0(p, f"l0/{p.name}", repo_root)
        v += problems
        purposes[p.name] = purpose
        # 评审 A 的 I2（裁过的一半）：只禁重复 `evidence_id`，**不**禁重复 `命令`
        # （活树实测有 1 组逐字相同的命令行，合法：同一条件重跑、主键不同）。
        # harness／基线／不可取证三种声明与孤证规则同样让路——它们不冒充观察面。
        if purpose not in ("harness", "基线", UNCAPTURABLE):
            ev = _l0_evidence_id(p)
            if EVIDENCE_ID.fullmatch(ev):
                by_evidence.setdefault(ev, []).append(p.name)
    for ev in sorted(by_evidence):
        names = sorted(by_evidence[ev])
        if len(names) > 1:
            v.append(
                f"同一枚 evidence_id（{ev[:16]}…）出现在 {len(names)} 份 L0 记录里：{'、'.join(names)}"
                "——一份 L0 只对应一条 REA 命令、一个观察面，重复主键就是同一份捕获冒充两个面"
            )

    cited: set[str] = set()
    spec_ids: dict[str, str] = {}
    spec_format_failure = False  # 规格层有没有格式失败（列数／窗口）——它决定这一轮能不能下引用结论
    spec_dir = forensics_root / "spec"
    spec_candidates = sorted(spec_dir.glob("*.md")) if spec_dir.is_dir() else []
    for p in spec_candidates:
        if p.name in SPEC_EXEMPT:
            continue
        if not p.is_file():  # 与 l0/ 同形（I3②）：显式报，不静默
            v.append(f"spec/{p.name}: 是目录不是文件——规格表得是一份 markdown 文件，这一份没被审计")
            continue
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

    # 评审 A 的 I1：孤证那道门写成 `if spec_ids and …`、缺矩阵那道门写成 `elif spec_ids:`，
    # 于是「L1 整层为空」时门禁沉默——一张写坏了的表也能零条目全绿，撞的就是本模块 docstring
    # 那句「a spec entry without a verdict is prose」。口径（本席选的，见报告 F2-3）：
    # **捕到过 L0 证据却没有规格条目**才报；既没证据也没规格的骨架红在既有的 l0 那一条上，
    # 不在这里叠加（那棵树上「没规格」不是新信息）。
    if l0_files and not spec_ids:
        v.append(
            "docs/forensics/spec/ 里没解析出任何规格条目（骨架不等于规格："
            "取证了却不写规格就是 prose，L1 空层不能让孤证与矩阵两道门沉默）"
        )

    # 孤证规则只在规格侧真解析出条目号、且整层没有格式失败时才开口：表写坏了 ⇒ `cited` 是
    # 残缺的，那时候说「没人引用这份证据」是在拿规格的格式失败 blame 证据文件。
    # 取舍：一处格式失败 ⇒ 这一轮别处没被引用的证据也不再上报，但树已经红了，不会漏过。
    # UNCAPTURABLE 让路：那类记录没有 `evidence_id`，结构上就引用不到任何条目。
    if spec_ids and not spec_format_failure:
        for name in sorted(purposes):
            if (
                name not in cited
                and purposes[name] not in ("harness", "基线", UNCAPTURABLE)
            ):
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

# 评审 A 的 I4（裁过的半）：`frontend/src` 的集合等式尺以前只看 `.ts`／`.tsx`，写在
# `.html`／`.js`／`.json` 里的一条 `<script src="https://s3.tradingview.com/…">` 于是被
# 当成「没有新增依赖」。代码类扩展名全部纳进同一把尺；`.md`／`.pine`／第三方语料继续不进
# （把文档里的一句字样当运行时依赖＝拿文案当依赖，控制席 2026-10-14 裁定）。
TV_SCAN_SUFFIXES: tuple[str, ...] = (
    ".ts", ".tsx",
    ".js", ".jsx", ".mjs", ".cjs", ".html", ".htm", ".css", ".json", ".svg",
)
# 与扩展名过滤无关的一条：这三份是真正会被浏览器／构建器加载的入口，住在 `frontend/src`
# 之外，所以前面那把尺永远看不见它们（活树现读三份各 0 命中）。
TV_ENTRY_FILES: tuple[str, ...] = (
    "frontend/index.html",
    "frontend/vite.config.ts",
    "frontend/package.json",
)


def _scannable_files(root: Path) -> tuple[list[Path], list[str], list[str]]:
    """Walk ``root`` and report (files seen, directories we could not list, symlinked dirs).

    ``Path.rglob`` swallows ``PermissionError`` internally, so a deny-read subdirectory
    makes the host red line return a clean list while blind to exactly what it exists to
    refuse. ``os.walk`` with ``onerror`` surfaces that instead of hiding it. ``followlinks``
    stays False on purpose: this walk must not be able to loop. That safety, however, also
    makes a directory symlink (the usual shape of "the TV corpus checked out next to the
    app") invisible — it is neither scanned nor reported. Reviewer A's N1 rules that a
    silent skip is not acceptable here: such directories are collected and the caller
    turns every one of them into a violation.
    """
    files: list[Path] = []
    unlistable: list[str] = []
    linked: list[str] = []

    def _note_error(err: OSError) -> None:
        unlistable.append(str(getattr(err, "filename", "") or err))

    for dirpath, dirnames, names in os.walk(root, onerror=_note_error):
        keep: list[str] = []
        for d in dirnames:
            cand = Path(dirpath) / d
            try:
                is_link = cand.is_symlink()
            except OSError:  # 连判定本身都判不动：同样是「看不见」，显式报，不许静默
                is_link = True
            if is_link:
                linked.append(str(cand))
            else:
                keep.append(d)
        # 真实链接本来就不会被 `followlinks=False` 跟进去；这里显式剪掉，为的是调用方那句
        # 「它不进扫描」在自己的走查里也是真的，而不是只对 os.walk 的默认行为抱有期待。
        dirnames[:] = keep
        files.extend(Path(dirpath) / name for name in names)
    return files, unlistable, linked


def audit_tv_host_allowlist(repo_root: Path) -> list[str]:
    """Spec ruling 1: TradingView is a research subject, never a dependency."""
    v: list[str] = []
    src = repo_root / "frontend" / "src"
    if not src.is_dir():
        return [f"{src} 不存在：无法核对 TradingView 主机白名单"]
    hits: set[str] = set()
    s3_counts: dict[str, int] = {}
    files, unlistable, linked_dirs = _scannable_files(src)

    def _rel(pathish: str) -> str:
        try:
            return Path(pathish).relative_to(repo_root).as_posix()
        except ValueError:
            return pathish

    for dirpath in sorted(unlistable):
        v.append(f"{_rel(dirpath)} 列不出来（权限／竞态）：主机红线看不见里面的文件，不许当作没有依赖")
    # N1：`followlinks=False` 只对环路，代价是指向仓外的目录符号链接整个消失——不扫也不报。
    for dirpath in sorted(set(linked_dirs)):
        v.append(f"{_rel(dirpath)}: 目录级符号链接——它不进扫描（followlinks=False），显式报此违规，"
                 "不许当作链接后面没有依赖")
    for p in sorted(files, key=lambda q: q.relative_to(repo_root).as_posix()):
        if not p.is_file() or p.suffix not in TV_SCAN_SUFFIXES:
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
    # I4 的另一条来路：入口件不进 `frontend/src` 那把集合等式尺，永远照不到这三份文件，
    # 而它们才是真正会被浏览器／构建器加载的东西。判据与扩展名过滤无关，只看 tradingview
    # 这个词（大小写不敏感）——入口件里没有理由出现第三方站点的名字。
    for rel in TV_ENTRY_FILES:
        entry = repo_root / rel
        if not entry.is_file():
            continue  # 缺件不是这条判据的形状（构建入口的存亡是另一把尺）
        try:
            entry_text = _read(entry)
        except (OSError, ValueError):
            v.append(f"{rel}: 入口件读不出来（权限／竞态）——主机判据没法核对它")
            continue
        if "tradingview" in entry_text.lower():
            v.append(
                f"{rel}: 入口件里出现 tradingview——{'、'.join(TV_ENTRY_FILES)} 这三份是真正会被浏览器／"
                "构建加载的入口，第三方站点只能以白名单的形式住在 frontend/src 里（裁定 1）"
            )
    return v


def main(repo_root: Path) -> int:
    try:
        problems = (
            audit_forensics(repo_root / "docs" / "forensics", repo_root)
            + audit_tv_host_allowlist(repo_root)
        )
    except Exception as exc:  # 评审 A 的 I3③：回溯穿出 main() 就把已收集的违规全吞了——炸了也算一条违规
        print(f"取证门禁自己炸了：{type(exc).__name__}: {exc}——按一条违规处理，rc=1")
        return 1
    for line in problems:
        print(line)
    if not problems:
        print("forensics audit: clean")
    return 1 if problems else 0


if __name__ == "__main__":
    raise SystemExit(main(Path(__file__).resolve().parents[1]))
