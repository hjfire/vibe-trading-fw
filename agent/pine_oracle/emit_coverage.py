# agent/pine_oracle/emit_coverage.py
"""Generate ``COVERAGE.md`` — the human-readable half of the coverage ledger.

Every table is computed from what the machine gate already reads (the engine's
dispatch table and ``manifest.json``), so the document cannot claim a coverage state
the gate disagrees with. Run from the repo root:

    PYTHONPATH=agent python -X utf8 -m pine_oracle.emit_coverage
"""

from __future__ import annotations

from pine_oracle.coverage import (
    COVERED,
    FUNCTION_LINES,
    GATE1_ONLY,
    GATE2_FUNCTIONS,
    MEASURED_WORST,
    MEASURED_WORST_VARIANTS,
    builtins_from_source,
    gate1_functions,
    worst_range,
)
from pine_oracle.schema import (
    FIXTURE_DIR,
    REPO_ROOT,
    TOLERANCE_TIERS,
    load_manifest,
    write_text_lf,
)

PINE_TA = REPO_ROOT / "frontend" / "src" / "lib" / "pineTa.ts"
OUT = FIXTURE_DIR / "COVERAGE.md"

#: Ruling H's two wording buckets, asserted verbatim by ``test_coverage_ledger.py``: a
#: line whose residual is identically zero on all four bar sets is NOT better evidence
#: than one that moves in the last bits — it is different evidence.
ZERO_WITNESS = "零残差＝只核对语义"
MOVED_WITNESS = "非零残差＝独立算术见证"


def _fmt(x: float) -> str:
    """The printed shape gate 2 uses, so the ledger and the console can be compared."""
    return f"{x:.3e}"


def main() -> None:
    text = PINE_TA.read_text(encoding="utf-8")
    lines = text.splitlines()
    manifest = load_manifest(FIXTURE_DIR / "manifest.json")
    builtins = builtins_from_source(text)
    g1 = gate1_functions()

    def row_line(name: str) -> int:
        prefix = f"  {name}: (args"
        return next(i for i, line in enumerate(lines, 1) if line.startswith(prefix))

    out: list[str] = [
        "# oracle 覆盖台账",
        "",
        "判据一 = 前缀不变式（`frontend/src/lib/__tests__/pinePrefixInvariance.test.ts`）——"
        "信号不重绘。判据二 = 跨实现数值对账（`pineTaOracle.test.ts` 读 `values/`）——"
        "每条 line 与 Python 参考实现逐位对账。",
        "",
        "名单与档位由 `agent/pine_oracle/coverage.py` 和 `manifest.json` 生成"
        f"（`PYTHONPATH=agent python -X utf8 -m pine_oracle.emit_coverage`），**不要手改本文件**。",
        "",
        "行号取自 `pineTa.ts` 的当前工作树（"
        f"head `{manifest['head_sha']}`，共 {len(builtins)} 个 `ta.*` 分派键），只作定位用。",
        "",
        f"## 已覆盖（{len(COVERED)} / {len(builtins)}）",
        "",
        "| ta.* | 判据一 | 判据二 | manifest line | 备注 |",
        "|---|---|---|---|---|",
    ]
    for name in sorted(COVERED):
        if name in FUNCTION_LINES:
            gate_2 = "✓"
            line_names = "`" + "`, `".join(FUNCTION_LINES[name]) + "`"
        else:
            gate_2, line_names = "✗（R-C）", "—"
        note = ""
        if name in GATE1_ONLY:
            note = "只由判据一兜住：numpy 里的 SAR 参考实现等于把被测代码抄一遍，不是第二证人（spec §11 R-C）"
        elif name == "vwap":
            note = "无会话锚定，见下方「已知偏离」"
        out.append(
            f"| `{name}` | {'✓' if name in g1 else '✗'} | {gate_2} | {line_names} | {note} |"
        )

    out += [
        "",
        f"## 采纳引擎／TV 约定（{len(manifest['convention'])} 处，逐字取自 manifest 的 `convention`）",
        "",
        "每一行都是「参考实现刻意跟着引擎约定走」的记录：**它让判据二可跑，但它本身不是判据二的证据**——"
        "这些约定的独立正证是各自的手算点值测试与外部锚点。",
        "",
        "| line | 采纳了什么、另一套约定会给什么（含源码坐标） |",
        "|---|---|",
    ]
    for line in sorted(manifest["convention"]):
        out.append(f"| `{line}` | {manifest['convention'][line]} |")

    out += [
        "",
        f"## 判据二的见证物性质（{len(GATE2_FUNCTIONS)} 个函数、{len(MEASURED_WORST)} 条 line 的当场读数）",
        "",
        f"下表是 {len(MEASURED_WORST)} 条 line 在四份 bar（{('、'.join(MEASURED_WORST_VARIANTS))}）上当场复跑得出的"
        f"相对残差区间，取自 `pineTaOracle.test.ts:148` 的 `[oracle]` 打印"
        f"（{len(MEASURED_WORST) * len(MEASURED_WORST_VARIANTS)} 行 = {len(MEASURED_WORST)} line × {len(MEASURED_WORST_VARIANTS)} bar 集），"
        "**不是**从 CSV 里反推的第二个数。它按裁定 Ruling H 回答一个门回答不了的问题：",
        "（数值按 Python 的 `:.3e` 排版，零写作 `0.000e+00`；控制台是 JS 的 `toExponential(3)`，"
        "同一读数写作 `0.000e+0`——同值不同形，逐条数值已当场复核一致，见 task-7-report.md。）",
        "**恒零的线只核对语义（播种位置、总体/样本式选择、`PERIOD` 接线、line 名↔`title=`），"
        "不核对算术形式**——两条独立实现逐位相同，更可能说明参考实现照抄了引擎的运算顺序，"
        "而不是两套算术在容差内各自成立。非零残差才是「两套不同算术落进同一档位」的那种见证。",
        "",
        "| line | 档位 | worst 下界 | worst 上界 | 距档位地板的余量 | 见证物性质 |",
        "|---|---|---|---|---|---|",
    ]
    for line in sorted(MEASURED_WORST):
        lo, hi = worst_range(line)
        floor = TOLERANCE_TIERS[manifest["tolerance_tier"][line]]
        margin = "—（恒零，无余量可言）" if hi == 0 else f"{floor / hi:.1f}×"
        kind = ZERO_WITNESS if hi == 0 else MOVED_WITNESS
        out.append(
            f"| `{line}` | `{manifest['tolerance_tier'][line]}` | {_fmt(lo)} | {_fmt(hi)} | {margin} | {kind} |"
        )

    zero = sum(1 for readings in MEASURED_WORST.values() if max(readings) == 0)
    out += [
        "",
        f"读数分档（{zero} 恒零 / {len(MEASURED_WORST) - zero} 非零，{len(MEASURED_WORST)} 条合计）："
        "恒零者的判据二通过=**语义见证**，非零者的判据二通过=**独立算术见证**。"
        "本表不是门——门是 `pineTaOracle.test.ts` 当场断言 `worst ≤ 档位`；"
        "本表记录的是「这条门在这条线上到底见证了什么」。"
        "`test_coverage_ledger.py::test_the_witness_table_names_every_priced_line_within_its_own_tier`"
        f" 钉住三件事：行数={len(MEASURED_WORST)}、每行 {len(MEASURED_WORST_VARIANTS)} 个读数、"
        "每个读数落在该线 manifest 档位的地板之内"
        "（档位被人改了而没重测 ⇒ 这条红）。",
        "",
        "## 已知偏离，记为 backlog 而不是通过的门",
        "",
        "- `vwap`：引擎按整段加载区间累积 hlc3×volume，不接受 session 参；"
        "TradingView 每个会话重新锚定累计量。本项目**不**把这条当成已通过——"
        "参考实现照引擎的口径写（`ref_batch_3` 收下并忽略 `session` 列），"
        "会话锚定的缺失留作功能 backlog。",
        "- `sar`：判据二不覆盖，理由见上表的备注行。",
        "- **na carry / poison / reseed 在 Pine 侧未锚定**：输入出现 `na` 时，"
        "批次一/二的参考实现是**永久中毒**（本模块自记的 DEVIATION），引擎是按窗口重播"
        "（`pineTa.ts:46-55`、`:134-145`、`:147-170`），而 Pine 自己走哪一条**没有取到第三方原文**"
        "（`EXTERNAL_ANCHORS.md`「放弃的条目」）。这条开口不是判据二能判的事：两边的规则不同，"
        "但参考实现照引擎写，所以对账恒绿；它记为 backlog，不记为通过。",
        "- **`supertrend` warm-up 段的 `nz()`／na 条件语义同样未锚定**（Task 6 新登记）："
        "第一棒没有 `upperBand[1]`/`lowerBand[1]`/`close[1]` 时，字面 `nz(na)` 读法与 NaN-guard 读法"
        "在 bar 0 给出的线不同（四份夹具上只在 index 0 不同，`supertrend` 的 na 计数 8 对 9）。"
        "本实现与引擎同取 NaN-guard（`pineTa.ts:700-713`），在取到原文之前**两种读法都不许写成 Pine 的规则**。",
        "",
        "## 待补 backlog（按字母序）",
        "",
        "| ta.* | 引擎表行号 |",
        "|---|---|",
    ]
    for name in sorted(builtins - COVERED):
        out.append(f"| `{name}` | `{row_line(name)}` |")

    body = "\n".join(out) + "\n"
    write_text_lf(OUT, body)
    print(
        f"{len(builtins)} builtins, {len(COVERED)} covered, "
        f"{len(builtins) - len(COVERED)} open, {len(manifest['convention'])} conventions"
    )


if __name__ == "__main__":
    main()
