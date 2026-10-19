# L3 第⑤片实现计划：服务端「自定义倍数档位」取数面

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `/market/kline` 与 `/api/udf/history` 能吃下「已可服务的基档 × 正整数倍」的一切档位（`120m`／`2D`／`3M`／`7m`…），折叠由本仓自己算，绝不向数据源要新拼写。

**Architecture:** 新增一个零依赖纯模块 `agent/src/api/interval_spec.py`（解析表＋折叠实现＋每条可服务档位的秒数），`market_routes.py` 与 `udf_routes.py` 两处各只做「解析 → 按 kind 走既存取数通道 → 折叠」；UDF 的两张私有表改由该模块派生，从而消掉两枚 `86400` 静默兜底。前端一字不动。

**Tech Stack:** Python 3.11（stdlib only：`dataclasses`／`re`／`datetime`／`zoneinfo`）、FastAPI + TestClient、pytest。无新依赖、无新文件类型。

**Spec:** `superpowers/specs/2026-10-19-l3-slice5-custom-intervals-design.md`（本计划是该设计的论证；两者冲突时以设计为准，并在台账里写裁定）

## Global Constraints

逐字取自设计 §5 与本仓红线，每个任务的隐含要求都包含本节：

- **前端一字不动**：`frontend/src/lib/marketApi.ts:18` 的 `IntervalKey`、仓内 76 处引用／16 个文件、`frontend/src/lib/chartView.ts:34` 的 `intervalAllowed`——本片一个字节都不改（设计 §5 第 1 条）。本片任何 `frontend/**` 的 diff 都是越界。
- **不升 L2 那一格的状态**：`forensics/gap-matrix.md` 的 TV-CI-01 判态保持 `缺`，只在该行追加一条带日期的登记，写明「取数面先行、判据面未动」（设计 §5 第 2 条；`verify-stamp-vouch-scope-overclaim` 那条病灶不许重演）。
- **不引入任何对方档位名／键名／控件名字面量进跟踪文件**；`ci_grep_gates` 的 `[gate b]` 既存白名单命中**一枚也不许顺手清**。
- **不改三枚上限**：`_MAX_BARS`（`market_routes.py:52`）、`_AGG_DAILY_CAP`（`:80`）、`_MINUTE_WINDOW_CAP_DAYS`（`:101`）任何一枚都不动，也不新增上限常量。
- **不新增返回体键**：`/market/kline` 的载荷键保持 `status/symbol/interval/source/bars`（`market_routes.py:662-668`）；取不满一页就**如实少返**，不许补根。
- **禁未来函数**：折叠分组只能用它左边（含自身）的根基档数据，`前缀折叠 == 全量折叠的前缀` 是硬判据（设计 §4 第 2 步）。
- **两枚本机恒红门**（G7 水位门、G8 grep 门）不调阈值、不改门体，只交「本片跟踪面 0 贡献」的归属证明。
- **提交纪律**：每笔 `git commit -s`（DCO），多面提交必须显式 pathspec；`docs/**` 不许跟踪（上游门禁 (g)），本计划与设计的落点都在仓库根 `superpowers/**`。
- **零上游文件改动纪律**：要满足规则就在自家一侧改，不新开豁免。
- **门禁判据**：八道门逐腿自打 rc，判据是 rc 汇总里**每腿标签逐名点齐**＋`ALL-LEGS-DONE`，绝不取管道尾 `$?`；重定向一律绝对路径。

---

## 落笔时的裁定（对设计文本的偏离，每条都带现读凭据；枚数一律当场数本节小节标题）

**裁定一——活体读数不落 `forensics/l0/`，落 `项目档案.md` 的新 §7.29。**
设计 §4 第 5 步写的是「逐字落到新的 L0 `forensics/l0/self-ci01-custom-fold-feed.md`（用途＝活体读数）」。本席 2026-10-19 现读 `tools/forensics_audit.py`：`:30` 的 `L0_REQUIRED_KEYS = ("命令", "evidence_id", "浏览器", "目标 URL", "观察条件", "完整性")`、`:31` 的 `L0_PURPOSES = ("harness", "规格", "基线")`、`:110-113` 的 `_command_hygiene`（`命令` 必须长成 `npx -y rea-agents@latest …` 且带 `--filter-output`／`--token-limit`），而 `:204` 是无条件调用它。⇒ `forensics/l0/` 这把尺是**为 REA 捕获量身判的**：一条 `curl` 读数放进去必然三处红（缺 `evidence_id`／`浏览器`／`目标 URL`，`命令` 不是 REA 形状，`用途` 不在词表）。**改法**：活体读数逐字进 `项目档案.md` §7.29（仓内既有「档案即取证记录」的落点，三层门扫不到它），L2 那格的追加句引用 §7.29。代价：这条读数不进三层漏斗的 L0 层——它本来就不是 DOM 面证据，是自家后端的一次探真进程。

**裁定二——`_calendar_group_key` 迁入 `interval_spec.py`，不在 `market_routes` 留一份。**
设计 §2.2/§2.3 引的是 `market_routes.py:472-486` 那段 docstring 的理由。折叠实现一旦并进纯模块，日历分组就必须和折叠同源，否则 `market_routes` 里那份变成生产者不再调用、只有测试在打的死函数（本仓明令禁这种残留）。**改法**：函数连同 docstring 逐字迁址为 `interval_spec.calendar_group_key`，新增 `calendar_group_ordinal`，`tests/test_market_kline_coarse.py` 的 `TestGroupKey` 六枚针改指新址（断言的**内容**一字不动，只换被调对象）。设计 §2.2/§2.3 的那两处行号引用随之失效 ⇒ Task 2 给设计文件加一行带日期 amend。

**裁定三——UDF 面新针并进 `agent/tests/test_udf_routes.py`，不新建文件。**
`test_udf_routes.py:49-76` 的 `client`（两套路由同挂、`require_auth` 打桩）与 `daily_feed`（钉 `_fetch_daily` 并记账）正是新针要的接缝；另开一份就得逐字抄这两枚 fixture，评审必按「verbatim duplication」判。市场面的针另立新文件（`tests/test_market_kline_custom_intervals.py`），因为它要用的是分钟通道的替身，与 `daily_feed` 不同形。

**裁定四——日历折叠有两种「`1W`」形态，`_merge_to_calendar` 的委托不走 `fold_spec`。**
计划初稿把 `_merge_to_calendar` 委托成 `fold_bars(bars, fold_spec("1W", k))`，同时 `fold_bars` 对 `kind == "native"` 直接原样返回。这两句合起来在 `k == 1` 时**不再合并**——而 `k == 1` 正是今天线上唯一的调用形状（13 处两参调用全在里面）。凭据：本席 2026-10-19 在仓库外把计划正文的实现代码原样跑了一遍 oracle，两枚同形判据读为 `FAIL k1_same_as_merge_week`（拿到 120 根未合并日线，想要 25 根周线）／`FAIL k1_same_as_merge_month`（想要 6 根月线）。设计 §2.3 判死的就是这一形状（「`1W`／`1M` 是 k=1 的退化情形，必须与今天逐字同形」），而另一枚针 `test_fold_spec_is_the_shape_the_parser_gives_for_the_same_request` 钉的 `fold_spec("1M", 1) == parse_interval("1M")` 又要求 `fold_spec` 在 k=1 交回 native。**改法**：两者都留，把「要分组」这个意图显式化——新增 `interval_spec.calendar_fold_spec(unit, k)`，恒返回 `kind="calendar-fold"`（`k == 1` 就是一次 weld 一个自然组，即旧合并逐字），`_merge_to_calendar` 委托给它，两枚同形针也改成对同一形态断言。代价：同一个 `1W` 拼写存在两枚 `IntervalSpec`（native 与 calendar-fold k=1），`.interval` 相同、`kind` 不同；这不污染解析面（`parse_interval("1W")` 仍是 native，路由按 `kind` 分发：native 的 `1W`／`1M` 走既有四参 `_fetch_calendar_bars` → `_merge_to_calendar`，那条路上的 spec 一律由 `calendar_fold_spec` 构造，不经 `fold_spec` 的 native 退化），并由 Task 2 的一枚针把这个区别钉住而不是藏起来。

---

## 基线（写计划当场现读；执行时每一步都要自己复测，别引用这里的数）

- `cd agent && python -m pytest tests/test_market_kline_coarse.py tests/test_udf_routes.py -q` → 本席 2026-10-19 读数 **61 passed**（两套件合跑）。
- 文件长度（同一趟 `wc -l`）：`src/api/market_routes.py` **864**／`src/api/udf_routes.py` **806**／`tests/test_udf_routes.py` **594**／`tests/test_market_kline_coarse.py` **386**。
- 零消费者普查（`grep -rn` 全 `agent/`，排除 `udf_routes.py` 自身与 `__pycache__`）：`_RESOLUTION_TO_INTERVAL`／`_RESOLUTION_SECONDS`／`_bar_count`／`intraday_multipliers` **0 处**外部引用；`SUPPORTED_RESOLUTIONS` 只有 `test_udf_routes.py:87` 那一枚自指针（`== list(udf_routes.SUPPORTED_RESOLUTIONS)`，换内容不会红）。
- 会因接线形状而炸的两枚既存针（必须保持可通过）：`test_market_kline_coarse.py:370` 把 `_fetch_calendar_bars` 打桩成**四参** `def fake(symbol, interval, count, before)` ⇒ 原生 `1W`／`1M` 的调用点必须仍是四参；`:338` 钉 `1D` 的 `_fetch_daily` 只被问 `count` 次（`calls == [3]`）⇒ 原生日线不许进折叠尺寸式。

## File Structure

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `agent/src/api/interval_spec.py` | 新建 | 唯一实现：档位语法解析、折叠分组锚点、OHLCV 聚合、每条可服务档位的秒数。零 IO、零本仓依赖 |
| `agent/src/api/market_routes.py` | 修改 | 折叠接线（`_kline_sync` 分发、`_fetch_calendar_bars` 吃乘数）、400 闸门与 `Query` 文案改口、日历键迁出 |
| `agent/src/api/udf_routes.py` | 修改 | 两张表改派生、`_bar_count` 与 `history_payload` 吃 spec、`:86-94` 注释改口 |
| `agent/tests/test_interval_spec.py` | 新建 | 设计 §4 第 1 步：解析表＋秒数表（纯函数先红） |
| `agent/tests/test_market_kline_custom_intervals.py` | 新建 | 设计 §4 第 2 步折叠对账 ＋ 第 3 步市场路由面 |
| `agent/tests/test_udf_routes.py` | 修改 | 设计 §4 第 3 步 UDF 面 ＋ 第 4 步报价等式（并进既有 fixture，见裁定三） |
| `agent/tests/test_market_kline_coarse.py` | 修改 | 仅 `TestGroupKey` 六枚针改指 `interval_spec`（裁定二），其余针**一字不动**——它就是 k=1 同形判据本体 |
| `superpowers/specs/2026-10-19-l3-slice5-custom-intervals-design.md` | 修改 | 一行带日期 amend（迁址）＋一行带日期 amend（活体读数落点） |
| `项目档案.md` | 修改 | §7.29 插入：活体读数（Task 5）＋收口段（Task 6）。整文件 CRLF，只在 bytes 层改 |
| `forensics/gap-matrix.md` | 修改 | TV-CI-01（`:89`）追加带日期登记，状态列 `缺` 一字不动 |

---

## Task 1: `interval_spec.py` 的解析面（纯函数先红）

**Files:**
- Create: `agent/src/api/interval_spec.py`
- Create: `agent/tests/test_interval_spec.py`
- Test: `agent/tests/test_interval_spec.py`

**Interfaces:**
- Consumes: 无（本模块不 import 本仓任何东西）。
- Produces（Task 2/3/4 都按这些确切名字与签名取用）：
  - `IntervalSpec(kind: str, base: str, k: int, unit: str = "")` — frozen dataclass，`__eq__` 按字段比；`spec.interval -> str` 属性给出市场侧拼写。
  - `parse_interval(text: str) -> IntervalSpec | None`、`parse_resolution(text: str) -> IntervalSpec | None`、`bar_seconds(spec: IntervalSpec) -> int`、`fold_spec(base: str, k: int) -> IntervalSpec`。
  - 常量 `MINUTE_BASES: tuple[str, ...]`、`DAILY_BASE: str = "1D"`、`CALENDAR_BASES: tuple[str, ...]`、`NATIVE_INTERVALS: tuple[str, ...]`。
  - `kind` 取值恰四枚：`"native"`／`"minute-fold"`／`"daily-fold"`／`"calendar-fold"`；`unit` 只在 calendar 用：`"week"`／`"month"`，其余 `""`。

- [ ] **Step 1: 写红针** —— 新建 `agent/tests/test_interval_spec.py`，全文如下（这就是设计 §4 第 1 步那张钉表；`"120"`→`60m×2`、`"2D"`→`1D×2`、`"3M"`→`month×3`、`"7m"`→`1m×7` 逐枚在内）：

```python
"""The interval grammar this slice opens: a served base taken k times.

Only the parse table lives here — folding is reconciled bar-for-bar in
``test_market_kline_custom_intervals.py``. Every expected value is hand-written,
because what is under test is *which base a request lands on*: ``120`` must be
60m×2 and not 30m×4, and ``7m`` must be 1m×7 — that one is the model's own
corollary (a minute base divides every minute count), not leniency.
"""

from __future__ import annotations

import pytest

from src.api.interval_spec import (
    MINUTE_BASES,
    IntervalSpec,
    bar_seconds,
    fold_spec,
    parse_interval,
    parse_resolution,
)


class TestParseInterval:
    def test_the_eight_native_spellings_stay_native(self):
        for text in ("1m", "5m", "15m", "30m", "60m", "1D", "1W", "1M"):
            got = parse_interval(text)
            assert got is not None, text
            assert (got.kind, got.base, got.k) == ("native", text, 1), text
            assert got.interval == text, text

    @pytest.mark.parametrize(
        ("text", "kind", "base", "k", "unit"),
        [
            ("120m", "minute-fold", "60m", 2, ""),
            ("10m", "minute-fold", "5m", 2, ""),
            ("45m", "minute-fold", "15m", 3, ""),
            ("3m", "minute-fold", "1m", 3, ""),
            ("7m", "minute-fold", "1m", 7, ""),
            ("2D", "daily-fold", "1D", 2, ""),
            ("5D", "daily-fold", "1D", 5, ""),
            ("2W", "calendar-fold", "1W", 2, "week"),
            ("3M", "calendar-fold", "1M", 3, "month"),
        ],
    )
    def test_a_request_lands_on_the_largest_base_that_divides_it(self, text, kind, base, k, unit):
        got = parse_interval(text)
        assert got is not None
        assert (got.kind, got.base, got.k, got.unit) == (kind, base, k, unit), text

    @pytest.mark.parametrize(
        "text", ["2.5m", "0m", "-5m", "abc", "", "m", "120X", "1S", "1d", "120"]
    )
    def test_only_the_spelling_itself_can_fail(self, text):
        """Nothing about the *number* is refused — a non-positive or fractional count is.

        ``"120"`` is refused here and served by ``parse_resolution``: bare minutes is
        the UDF spelling, not the market one. That asymmetry is the protocol's, so it
        is pinned rather than smoothed over. ``"1d"`` is refused for the same kind of
        reason: the market spells a day with a capital ``D``, and a grammar that
        shrugs off case cannot tell ``1D`` from a request it has never heard of.
        """
        assert parse_interval(text) is None, text

    def test_a_fold_reprints_its_own_market_spelling(self):
        for text in ("120m", "7m", "2D", "2W", "3M"):
            assert parse_interval(text).interval == text, text

    def test_a_leading_zero_is_the_same_request_not_a_refused_one(self):
        """``"01D"`` parses as ``1D``: the grammar refuses spellings, not numbers.

        Ruled here rather than left to a reader: adding a zero-padding rule would be
        a second refusal axis, and the only thing it could protect is a URL nobody
        builds.
        """
        assert parse_interval("01D") == parse_interval("1D")


class TestParseResolution:
    def test_bare_numbers_are_udf_minutes(self):
        assert parse_resolution("1") == IntervalSpec("native", "1m", 1, "")
        assert parse_resolution("60") == IntervalSpec("native", "60m", 1, "")
        assert parse_resolution("120") == IntervalSpec("minute-fold", "60m", 2, "")
        assert parse_resolution("7") == IntervalSpec("minute-fold", "1m", 7, "")

    def test_the_h_letter_and_the_bare_unit_letters_are_aliases(self):
        assert parse_resolution("1H") == IntervalSpec("native", "60m", 1, "")
        assert parse_resolution("D") == IntervalSpec("native", "1D", 1, "")
        assert parse_resolution("W") == IntervalSpec("native", "1W", 1, "week")
        assert parse_resolution("M") == IntervalSpec("native", "1M", 1, "month")

    def test_multipliers_arrive_in_udf_shape_too(self):
        assert parse_resolution("2D") == IntervalSpec("daily-fold", "1D", 2, "")
        assert parse_resolution("2W") == IntervalSpec("calendar-fold", "1W", 2, "week")
        assert parse_resolution("3M") == IntervalSpec("calendar-fold", "1M", 3, "month")

    def test_a_day_written_in_minutes_stays_minutes_because_udf_days_are_spelled_d(self):
        """``1440`` is 24×60m, not a daily bar. The library never sends this.

        UDF names a day ``"D"``; a bare number is minutes by the protocol's own text,
        so inventing a day here would be a second spelling of one day that only this
        repo knows. Pinned so nobody "fixes" it into a daily bar later.
        """
        assert parse_resolution("1440") == IntervalSpec("minute-fold", "60m", 24, "")

    @pytest.mark.parametrize("text", ["2.5", "0", "-5", "", "abc", "1h", "d", "120x"])
    def test_a_resolution_that_is_not_a_spelling_is_none(self, text):
        assert parse_resolution(text) is None, text

    @pytest.mark.parametrize(
        "text",
        ["1", "5", "15", "30", "60", "1H", "1D", "D", "1W", "W", "1M", "M",
         "120", "7", "1440", "2D", "2W", "3M"],
    )
    def test_every_served_resolution_round_trips_through_the_market_grammar(self, text):
        got = parse_resolution(text)
        assert got is not None, text
        assert parse_interval(got.interval) == got, text


class TestBarSeconds:
    @pytest.mark.parametrize(
        ("resolution", "seconds"),
        [("1", 60), ("5", 300), ("15", 900), ("30", 1800), ("60", 3600), ("1H", 3600),
         ("D", 86400), ("1D", 86400), ("W", 604800), ("1W", 604800),
         ("M", 2678400), ("1M", 2678400)],
    )
    def test_native_widths_are_what_the_udf_table_already_said(self, resolution, seconds):
        """The table this replaces is *derived* now, so its old readings are pinned.

        ``_RESOLUTION_SECONDS`` feeds a bar-count estimate and a window filter; if a
        derived value drifted, the chart would fetch a different amount of history
        with nothing on the wire to say so. A month stays 31 days (the long one) so
        the estimate can only ever over-include.
        """
        assert bar_seconds(parse_resolution(resolution)) == seconds

    def test_a_fold_is_k_base_bars_wide(self):
        assert bar_seconds(parse_resolution("120")) == 2 * 3600
        assert bar_seconds(parse_resolution("7")) == 7 * 60
        assert bar_seconds(parse_resolution("2D")) == 2 * 86400
        assert bar_seconds(parse_resolution("2W")) == 2 * 604800
        assert bar_seconds(parse_resolution("3M")) == 3 * 2678400


class TestFoldSpec:
    def test_fold_spec_is_the_shape_the_parser_gives_for_the_same_request(self):
        assert fold_spec("1W", 3) == parse_interval("3W")
        assert fold_spec("1M", 1) == parse_interval("1M")
        assert fold_spec("1D", 2) == parse_interval("2D")
        assert fold_spec("1D", 1) == parse_interval("1D")

    def test_the_minute_bases_and_the_minute_period_table_say_the_same_five(self):
        """Two spellings of one fact must not be allowed to drift apart.

        ``market_routes._MINUTE_PERIODS`` is what the fetch layer can ask a source
        for; ``MINUTE_BASES`` is what this module is willing to fold. If one grows a
        sixth entry the other has to, or a request folds off a base nobody can fetch.
        """
        from src.api import market_routes

        assert {int(v) for v in market_routes._MINUTE_PERIODS.values()} == {
            int(b[:-1]) for b in MINUTE_BASES
        }
```

- [ ] **Step 2: 跑红** —— `cd agent && python -m pytest tests/test_interval_spec.py -q`；预期 `ModuleNotFoundError: No module named 'src.api.interval_spec'`（收集期就红，不是断言红）。把这行的逐字输出留在报告里。

- [ ] **Step 3: 写实现** —— 新建 `agent/src/api/interval_spec.py`，本任务先落解析面（折叠面在 Task 2 追加进同一文件）：

```python
"""Custom multiplier intervals — a served base, taken k times.

This repo can already ask a source for five minute bars, daily bars and
weekly/monthly bars (``market_routes._MINUTE_PERIODS`` / ``_AGG_DAILY_PER_BAR``).
Everything else a chart asks for — 3 minutes, 2 hours, 3 months — is one of those
bases taken ``k`` times, so it needs no second data feed: it needs the fold the
weekly bars already use, with the multiplier made visible.

Three things this module deliberately does **not** do:

* it never rounds a request to the nearest neighbour it can serve — a ``2.5m`` or
  a ``0m`` has no answer here, and the caller says so by name;
* it never imports ``market_routes`` (that module imports *this* one, so the
  arrow points one way and this file stays stdlib-only and testable alone);
* it never guesses an exchange clock — a minute fold is anchored inside a trading
  session, so the caller that knows the symbol's suffix passes ``zone``.

Bar timestamps are epoch **milliseconds** end-to-end, the unit ``_bars_from_frame``
writes and KLineChart v10 reads.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any

#: Minute bars a source can be asked for directly, in market spelling.
MINUTE_BASES: tuple[str, ...] = ("1m", "5m", "15m", "30m", "60m")
DAILY_BASE = "1D"
#: Calendar bars, which are themselves folded from daily ones by ``market_routes``.
CALENDAR_BASES: tuple[str, ...] = ("1W", "1M")
NATIVE_INTERVALS: tuple[str, ...] = (*MINUTE_BASES, DAILY_BASE, *CALENDAR_BASES)

_MINUTE_SECONDS = {"1m": 60, "5m": 300, "15m": 900, "30m": 1800, "60m": 3600}
_MINUTES_PER_HOUR = 60
DAY_MS = 86_400_000
DAY_SECONDS = 86400
#: A week and a month at their **widest**: 31 days for a month is the same
#: generous approximation ``udf_routes`` used to keep in its own table, and for the
#: same reason — a bar count sized from it can only come out too large and be
#: trimmed, never too small, which would clip a window.
WEEK_SECONDS = 7 * DAY_SECONDS
MONTH_SECONDS = 31 * DAY_SECONDS

#: ``<count><unit>``, and only the units this grammar means: lowercase ``m`` for
#: minutes (the market spelling), uppercase ``D``/``W``/``M`` for calendar ones
#: (both the market and the UDF spelling). A bare number is UDF-only, so it is
#: deliberately absent here.
_FOLDED_RE = re.compile(r"^(\d+)([mDWM])$")
_BARE_MINUTES_RE = re.compile(r"^\d+$")

#: Resolution spellings that mean a native interval but are not market spellings.
#: ``"1H"`` is what ``FutuLoader`` names a 60-minute bar; the bare letters are the
#: protocol's own day / week / month.
_UDF_ALIASES = {"1H": "60m", "D": "1D", "W": "1W", "M": "1M"}


@dataclass(frozen=True)
class IntervalSpec:
    """One request, resolved to the base it is folded from.

    ``kind`` is which of four shapes the request is; ``base`` is the spelling the
    existing fetch channels already understand; ``k`` is how many base bars make
    one served bar (always ``1`` when ``kind == "native"``); ``unit`` only carries
    the calendar unit for ``calendar-fold`` and the native weekly / monthly.
    """

    kind: str
    base: str
    k: int
    unit: str = ""

    @property
    def interval(self) -> str:
        """The market spelling of this same request — what ``_kline_sync`` takes.

        Both doors must land on one ``IntervalSpec`` or the UDF feed and
        ``/market/kline`` would fold differently for the same chart. The property is
        total: ``parse_interval(parse_resolution(x).interval)`` equals the original
        for every served spelling, which is pinned in the test.
        """
        if self.kind == "native":
            return self.base
        if self.kind == "minute-fold":
            return f"{self.base_minutes * self.k}m"
        if self.kind == "daily-fold":
            return f"{self.k}D"
        return f"{self.k}{self.base[-1]}"

    @property
    def base_minutes(self) -> int:
        return _MINUTE_SECONDS[self.base] // 60


def _unit_of(interval: str) -> str:
    if interval == "1W":
        return "week"
    if interval == "1M":
        return "month"
    return ""


def _minute_spec(minutes: int) -> IntervalSpec | None:
    """The largest served minute base that divides ``minutes``, taken that many times."""
    if minutes <= 0:
        return None
    for base in reversed(MINUTE_BASES):
        base_minutes = _MINUTE_SECONDS[base] // _MINUTES_PER_HOUR
        if minutes % base_minutes == 0:
            k = minutes // base_minutes
            return IntervalSpec("native" if k == 1 else "minute-fold", base, k)
    return None  # unreachable while 1m is served: one minute divides every count


def parse_interval(text: str) -> IntervalSpec | None:
    """``"120m"`` / ``"2D"`` / ``"3M"`` and the eight native spellings; else ``None``.

    Refused: a non-positive or fractional count (``0m``, ``2.5m``, ``-5m``), an
    unknown unit, and a bare number — bare minutes is the UDF spelling
    (:func:`parse_resolution`), and accepting it here would let one URL mean two
    intervals depending on who read the docstring.
    """
    t = (text or "").strip()
    if t in NATIVE_INTERVALS:
        return IntervalSpec("native", t, 1, _unit_of(t))
    m = _FOLDED_RE.match(t)
    if m is None:
        return None
    n, unit = int(m.group(1)), m.group(2)
    if n <= 0:
        return None
    if n == 1:  # `1m`/`1D` are native; `1W`/`1M` already returned above
        return IntervalSpec("native", f"{n}{unit}", 1, _unit_of(f"{n}{unit}"))
    if unit == "m":
        return _minute_spec(n)
    if unit == "D":
        return IntervalSpec("daily-fold", DAILY_BASE, n)
    return IntervalSpec("calendar-fold", f"1{unit}", n, _unit_of(f"1{unit}"))


def parse_resolution(text: str) -> IntervalSpec | None:
    """UDF resolution -> spec. Bare numbers are minutes; ``D``/``W``/``M``/``1H`` are aliases."""
    t = (text or "").strip()
    if t in _UDF_ALIASES:
        return parse_interval(_UDF_ALIASES[t])
    if _BARE_MINUTES_RE.match(t):
        return _minute_spec(int(t))
    return parse_interval(t)


def fold_spec(base: str, k: int) -> IntervalSpec:
    """``base`` bars folded ``k`` at a time (``k == 1`` is the merge already in use)."""
    if base in CALENDAR_BASES:
        return IntervalSpec("calendar-fold" if k > 1 else "native", base, k, _unit_of(base))
    if base == DAILY_BASE:
        return IntervalSpec("daily-fold" if k > 1 else "native", base, k)
    return IntervalSpec("minute-fold" if k > 1 else "native", base, k)


def bar_seconds(spec: IntervalSpec) -> int:
    """Approximate width of one served bar, generous.

    Total by construction: it takes an ``IntervalSpec``, which only exists for a
    request this module can serve. That is the point — the two ``.get(..., 86400)``
    defaults in ``udf_routes`` silently read *every* unknown spelling as a day, and
    a fold must never be sized off a guess.
    """
    if spec.base in _MINUTE_SECONDS:
        return _MINUTE_SECONDS[spec.base] * spec.k
    if spec.unit == "week":
        return WEEK_SECONDS * spec.k
    if spec.unit == "month":
        return MONTH_SECONDS * spec.k
    return DAY_SECONDS * spec.k
```

注意 `Any` 与 `datetime`/`timezone` 在本任务还没被用到——它们由 Task 2 的折叠函数消费，所以**本任务先不要写进 import 行**（`ruff`／`tsc` 无关，但「import 未消费符号」是本仓登记过的执行期病灶第五型）。Task 2 追加实现时再把缺的 import 补上。

- [ ] **Step 4: 跑绿** —— `cd agent && python -m pytest tests/test_interval_spec.py -q`；预期全绿。若 `test_only_the_spelling_itself_can_fail` 里 `"01D"` 没被判死，说明 `_FOLDED_RE` 吃下了前导零——**这是可服务的**（`int("01") == 1` → native `1D`），所以把那枚样本从参数表里**移到** `test_a_fold_reprints_its_own_market_spelling` 之外、并补一枚断言 `parse_interval("01D") == parse_interval("1D")`；裁定：接受前导零，不新加一条拒绝规则。

- [ ] **Step 5: 复跑既有套件证明未受影响** —— `cd agent && python -m pytest tests/test_market_kline_coarse.py tests/test_udf_routes.py -q`；预期与本计划基线同读数（你当场测的那个数），0 失败。

- [ ] **Step 6: 提交**

```bash
cd /e/Vibe-Trading-main/Vibe-Trading-main
git add agent/src/api/interval_spec.py agent/tests/test_interval_spec.py
git commit -s -m "$(cat <<'EOF'
feat(l3-slice5): interval_spec 解析面——基档 × 正整数倍的档位语法

任何能被「已可服务的基档 × 整数倍」表达的档位都由基档折叠出来，所以第一步是
把「这条请求落在哪个基档、折几倍、一根多宽」写成一处可测的事实。拒绝的只有
拼写本身（非正整数），不引入「向上取整到最近邻」那种会把数据画错的做法。
EOF
)"
git status --porcelain
```

---

## Task 2: 折叠实现（分组锚点＋OHLCV 聚合），并把日历键迁进纯模块

**Files:**
- Modify: `agent/src/api/interval_spec.py`（追加折叠函数与 `date`／`ZoneInfo` 的 import）
- Modify: `agent/src/api/market_routes.py`（`_calendar_group_key` 删除→迁址；`_merge_to_calendar` 加 `k` 并委托）
- Modify: `agent/tests/test_market_kline_coarse.py`（仅 `TestGroupKey` 六枚针改指 `interval_spec`）
- Create: `agent/tests/test_market_kline_custom_intervals.py`（折叠对账那一段；路由面在 Task 3 追加进同文件）

**Interfaces:**
- Consumes: Task 1 的 `IntervalSpec`／`fold_spec`／`parse_interval`。
- Produces:
  - `calendar_group_key(ts_ms: int, unit: str) -> tuple[int, int]`（自 `market_routes` 迁来，签名不变）
  - `calendar_group_ordinal(group_key: tuple[int, int], unit: str) -> int`
  - `fold_by_keys(ordered_bars: list[dict], keys: list[Any]) -> list[dict]`
  - `fold_bars(bars: list[dict], spec: IntervalSpec, zone: str | None = None) -> list[dict]`
  - `calendar_fold_spec(unit: str, k: int) -> IntervalSpec` — 恒返回会分组的 `kind="calendar-fold"`，`k == 1` 就是旧合并（裁定四；`_merge_to_calendar` 只用它，不用 `fold_spec`）
  - `market_routes._merge_to_calendar(bars, unit, k: int = 1)`（既有 13 处两参调用零改动）

- [ ] **Step 1: 写红针** —— 新建 `agent/tests/test_market_kline_custom_intervals.py`：

```python
"""Folding base bars into a multiplier interval — bar-for-bar, hand-checked.

Every numeric claim here is a hand-written vector, not a re-run of the
implementation's own expression. The four shapes worth the ink:

* the OHLCV rule is the one the weekly merge already uses (open = group's first,
  close = its last, high/low = extremes, volume = sum, timestamp = **first**);
* a minute fold is anchored **inside a trading session** — stitching the A-share
  lunch break into one 120-minute bar would draw a candle that never existed;
* the anchor is absolute (a day's ordinal, a week's ordinal, a bar's position in
  its session), never "the index inside whatever this page happened to fetch", so
  paging cannot repaint the tape;
* a fold of a prefix equals the prefix of the fold — the same invariant that makes
  an indicator free of lookahead, applied to the data path itself.

Nothing here opens a socket. The daily/minute channels are fed literal bars.
"""

from __future__ import annotations

import zoneinfo
from datetime import datetime

import pandas as pd
import pytest

from src.api import interval_spec as spec_mod
from src.api import market_routes
from src.api.interval_spec import (
    IntervalSpec,
    calendar_fold_spec,
    fold_bars,
    fold_spec,
    parse_interval,
)

DAY_MS = 86_400_000
SH = "Asia/Shanghai"


def _day_ms(label: str) -> int:
    """Epoch ms of a trading-day *label* — midnight UTC, exactly as daily bars carry it."""
    return int(pd.Timestamp(label, tz="UTC").timestamp() * 1000)


def _bar(label: str, price: float, volume: float = 100.0) -> dict:
    return {
        "timestamp": _day_ms(label),
        "open": price,
        "high": price + 1.0,
        "low": price - 1.0,
        "close": price + 0.5,
        "volume": volume,
    }


def _weekdays(start: str, n: int) -> list[str]:
    return [d.strftime("%Y-%m-%d") for d in pd.bdate_range(start, periods=n)]


def _daily_series(days: list[str]) -> list[dict]:
    return [_bar(d, 10.0 + i * 0.1, volume=100.0 + i) for i, d in enumerate(days)]


def _minute_label(label: str, hhmm: str, zone: str = SH) -> int:
    """Epoch ms of an exchange wall-clock minute, stamped the way `_bars_from_frame` does."""
    naive = datetime.strptime(f"{label} {hhmm}", "%Y-%m-%d %H:%M")
    return int(naive.replace(tzinfo=zoneinfo.ZoneInfo(zone)).timestamp() * 1000)


class TestHandComputedVector:
    def test_a_two_day_fold_is_the_vector_arithmetic_says_it_is(self):
        """Tue 2026-06-02 + Wed 2026-06-03 weld into one bar, on the calendar's say-so.

        The anchor is the absolute epoch-day ordinal (design §2.2), and 2026-06-02
        is day 20606 — even, so it opens a group and 20607 lands inside it. Picking
        the pair by arithmetic instead of by wish is the point: the same table read
        off "the first two bars of the page" would redraw on every page.
        """
        bars = [_bar("2026-06-02", 10.0, 100.0), _bar("2026-06-03", 12.0, 50.0)]
        (folded,) = fold_bars(bars, fold_spec("1D", 2))
        assert folded["timestamp"] == _day_ms("2026-06-02")  # the group's FIRST bar
        assert folded["open"] == 10.0
        assert folded["high"] == 13.0  # day two's high is 12 + 1
        assert folded["low"] == 9.0  # day one's low
        assert folded["close"] == 12.5  # day two's close
        assert folded["volume"] == 150.0

    def test_a_monday_that_a_weekend_left_alone_stays_alone(self):
        """Design §2.2's accepted cost, pinned rather than smoothed: no bar is invented.

        2026-06-01 (Mon) is day 20605, odd, so its partner would be 20531 = Sunday —
        no bar. Thursday and Friday do weld. So one trading week under a `2D`
        multiplier is three served bars, and a holiday week can be two; the fold
        comes back short and never pads.
        """
        days = _weekdays("2026-06-01", 5)  # Mon 1 … Fri 5
        folded = fold_bars(_daily_series(days), fold_spec("1D", 2))
        assert [b["open"] for b in folded] == [
            _bar(days[0], 10.0)["open"],  # Jun 1, alone
            _bar(days[1], 10.1)["open"],  # Jun 2 + Jun 3
            _bar(days[3], 10.3)["open"],  # Jun 4 + Jun 5
        ]
        assert [b["timestamp"] for b in folded] == [
            _day_ms(d) for d in ("2026-06-01", "2026-06-02", "2026-06-04")
        ]


class TestMinuteSessionAnchor:
    """The 120-minute fold of an A-share day is two bars, not one stitched across lunch."""

    def _sixty(self, label: str) -> list[dict]:
        # 60-minute bars close at 10:30 / 11:30 / 14:00 / 15:00 (the shape this repo's
        # own 分时 path records; the reason is in the design doc §2.1).
        out = []
        for i, hhmm in enumerate(("10:30", "11:30", "14:00", "15:00")):
            stamp = _minute_label(label, hhmm)
            out.append(
                {
                    "timestamp": stamp,
                    "open": 10.0 + i,
                    "high": 11.0 + i,
                    "low": 9.0 + i,
                    "close": 10.5 + i,
                    "volume": 100.0 + i,
                }
            )
        return out

    def test_the_lunch_break_is_never_stitched_into_one_bar(self):
        bars = self._sixty("2026-06-01")
        folded = fold_bars(bars, IntervalSpec("minute-fold", "60m", 2, ""), SH)
        assert len(folded) == 2
        assert [b["timestamp"] for b in folded] == [bars[0]["timestamp"], bars[2]["timestamp"]]
        assert folded[0]["open"] == 10.0 and folded[0]["close"] == 11.5
        assert folded[0]["high"] == 12.0 and folded[0]["low"] == 9.0
        assert folded[1]["open"] == 12.0 and folded[1]["close"] == 13.5
        # The stitched bar would have this number; asserting it is NOT there is the
        # whole point of the pin — a UTC-minute floor produces exactly that shape.
        assert folded[0]["close"] != folded[1]["open"]

    def test_the_fold_drops_across_sessions_rather_than_spanning_them(self):
        bars = self._sixty("2026-06-01") + self._sixty("2026-06-02")
        folded = fold_bars(bars, IntervalSpec("minute-fold", "60m", 2, ""), SH)
        assert len(folded) == 4
        assert folded[1]["timestamp"] == _minute_label("2026-06-01", "14:00")
        assert folded[2]["timestamp"] == _minute_label("2026-06-02", "10:30")

    def test_a_prime_minute_count_folds_off_the_one_minute_base(self):
        bars = self._sixty("2026-06-01")  # reuse as 1m bars, times irrelevant
        one_minute = [dict(b, timestamp=b["timestamp"] + i * 60_000) for i, b in enumerate(bars)]
        folded = fold_bars(one_minute, IntervalSpec("minute-fold", "1m", 3, ""), SH)
        assert len(folded) == 2  # four 1m bars -> groups (0,1,2) and (3,)
        assert folded[0]["timestamp"] == one_minute[0]["timestamp"]
        assert folded[0]["volume"] == 303.0  # 100 + 101 + 102; the fourth bar is its own group
        assert folded[1]["volume"] == 103.0

    def test_a_minute_fold_without_an_exchange_clock_is_refused(self):
        with pytest.raises(ValueError, match="exchange clock"):
            fold_bars(self._sixty("2026-06-01"), IntervalSpec("minute-fold", "60m", 2, ""))


class TestPrefixInvariant:
    """A fold never uses a bar to its right — the future-function probe on the data path."""

    def test_folding_a_prefix_is_the_prefix_of_the_full_fold(self):
        days = _weekdays("2024-01-01", 130)
        bars = _daily_series(days)
        for spec in (fold_spec("1D", 2), fold_spec("1D", 5), fold_spec("1W", 2), fold_spec("1M", 3)):
            full = fold_bars(bars, spec)
            for cut in (30, 77, 120):
                # Every group but the last is complete on both sides; the tail group is
                # the only one a cut can leave short, so it drops out of the comparison
                # instead of being excused by a comment. This is the future-function
                # probe on the fold: nothing to the right of bar `cut` can move a bar.
                head = fold_bars(bars[:cut], spec)
                assert head[:-1] == full[: len(head) - 1], (spec, cut)

    def test_minute_fold_is_also_a_prefix_function(self):
        base = [
            {
                "timestamp": _minute_label("2026-06-01", "09:30") + i * 60_000,
                "open": 1.0 + i,
                "high": 2.0 + i,
                "low": 0.5 + i,
                "close": 1.5 + i,
                "volume": 10.0,
            }
            for i in range(30)
        ]
        spec = IntervalSpec("minute-fold", "1m", 7, "")
        full = fold_bars(base, spec, SH)
        for cut in (9, 15, 21):
            head = fold_bars(base[:cut], spec, SH)
            assert head[:-1] == full[:len(head) - 1]


class TestCalendarOrdinals:
    def test_the_ordinal_relabels_exactly_the_partition_the_pair_describes(self):
        days = _weekdays("2025-11-03", 60)
        for unit in ("week", "month"):
            pairs = [spec_mod.calendar_group_key(_day_ms(d), unit) for d in days]
            ordinals = [spec_mod.calendar_group_ordinal(p, unit) for p in pairs]
            assert len(set(ordinals)) == len(set(pairs))  # injective: no two weeks collide
            assert [ordinals.index(o) for o in ordinals] == [pairs.index(p) for p in pairs]

    def test_the_new_year_week_is_one_group_however_the_year_is_numbered(self):
        # Mon 29 Dec 2025 – Fri 2 Jan 2026 is ISO 2026-W01; 26 Dec 2025 is 2025-W52.
        straddling = [_day_ms(d) for d in ("2025-12-29", "2025-12-30", "2025-12-31",
                                           "2026-01-01", "2026-01-02")]
        keys = {spec_mod.calendar_group_key(ts, "week") for ts in straddling}
        assert len(keys) == 1
        ordinals = {spec_mod.calendar_group_ordinal(k, "week") for k in keys}
        assert len(ordinals) == 1

    def test_two_weeks_fold_the_straddling_week_whole(self):
        """The weld pairs *whole* natural weeks, so a year boundary cannot split one.

        Read the table off the calendar: ``2025-12-08`` starts ISO 2025-W50, and the
        twenty trading days run W50 (08–12), W51 (15–19), W52 (22–26) and 2026-W01
        (29–02, five days that straddle the year). Two-fold therefore welds W50+W51
        and W52+2026-W01 — the straddling week is the *second half* of the second
        served bar, and none of its five days may reach into a third bar.
        """
        days = _weekdays("2025-12-08", 20)
        members = _daily_series(days)
        folded = fold_bars(members, fold_spec("1W", 2))
        assert len(folded) == 2
        assert [b["timestamp"] for b in folded] == [
            _day_ms("2025-12-08"), _day_ms("2025-12-22")
        ]
        straddle = [_day_ms(d) for d in ("2025-12-29", "2025-12-30", "2025-12-31",
                                         "2026-01-01", "2026-01-02")]
        start, end = folded[1]["timestamp"], folded[1]["timestamp"] + 2 * 7 * DAY_MS
        assert all(start <= ts < end for ts in straddle)
        assert folded[1]["open"] == members[10]["open"]    # 2025-12-22, first day of W52
        assert folded[1]["close"] == members[-1]["close"]  # 2026-01-02, last day of 2026-W01

    def test_k_equals_one_reproduces_the_merge_the_daily_chain_already_did(self):
        """The shape every existing caller uses must still *group*, not pass through.

        ``fold_spec("1W", 1)`` is native — that is what ``1W`` means on the wire. The
        calendar merge is the opposite case: its ``k == 1`` default welds one natural
        group at a time, which is the merge that has always run. So the merge asks for
        a grouping spec directly, and this pin is the bar-for-bar proof that a
        multiplier-less fold still collapses (裁定四).
        """
        days = _weekdays("2024-06-05", 120)
        bars = _daily_series(days)
        for unit, base in (("week", "1W"), ("month", "1M")):
            folded = fold_bars(bars, calendar_fold_spec(unit, 1))
            assert len(folded) < len(bars), unit
            assert folded == market_routes._merge_to_calendar(bars, unit), unit

    def test_the_default_multiplier_is_the_same_call_as_saying_one(self):
        days = _weekdays("2026-06-01", 10)
        bars = _daily_series(days)
        assert market_routes._merge_to_calendar(bars, "week") == market_routes._merge_to_calendar(
            bars, "week", 1
        )

    def test_the_two_spellings_of_one_week_request_disagree_only_in_kind(self):
        """``1W`` is native to the parser and a grouping fold to the merge.

        Both are right and both must stay reachable, so the difference is pinned here
        instead of being hidden by making one shape serve both jobs: the router sends a
        native ``1W`` to the four-arg daily walk, which then merges; only a
        multiplier-beyond-one reaches ``fold_bars`` through ``spec.kind``.
        """
        native = parse_interval("1W")
        grouped = calendar_fold_spec("week", 1)
        assert (native.kind, grouped.kind) == ("native", "calendar-fold")
        assert native.interval == grouped.interval == "1W"
        assert native.base == grouped.base and native.k == grouped.k == 1

    def test_monthly_fold_is_three_month_groups(self):
        days = _weekdays("2026-01-01", 60)  # Jan..Mar 2026 trading days
        folded = fold_bars(_daily_series(days), fold_spec("1M", 3))
        assert len(folded) == 1
        assert folded[0]["timestamp"] == _day_ms(days[0])


class TestMergeToCalendarStillAnswersTheOldCall:
    def test_the_two_argument_form_is_the_native_merge(self):
        days = _weekdays("2026-06-01", 10)
        bars = _daily_series(days)
        assert market_routes._merge_to_calendar(bars, "week") == fold_bars(
            bars, calendar_fold_spec("week", 1)
        )
```

- [ ] **Step 2: 跑红** —— `cd agent && python -m pytest tests/test_market_kline_custom_intervals.py -q`；预期 `AttributeError`（`fold_bars`／`calendar_group_key` 还不存在）或收集期 `ImportError`。逐字留档。

- [ ] **Step 3: 追加折叠实现到 `interval_spec.py`** —— 顶部 import 补 `from datetime import date`、`from zoneinfo import ZoneInfo`（`Any` 此时才真的被消费）。文件末尾追加：

```python
#: First Monday the ISO week numbering can name: 1970-01-05. Anchoring on its
#: ordinal turns an ``(iso_year, iso_week)`` pair into one monotonic integer, which
#: is what a multiplier needs — ``iso_week // k`` collides across a year boundary.
_ISO_EPOCH_ORDINAL = date(1970, 1, 5).toordinal()
_WEEK_MS = 7 * DAY_MS


def calendar_group_key(ts_ms: int, unit: str) -> tuple[int, int]:
    """Which natural week / month one daily bar belongs to.

    Daily bars arrive stamped with the epoch of **midnight UTC of their
    trading-day label** (``market_routes._bars_from_frame`` leaves ``wall_clock_zone``
    as ``None`` precisely so that a US session's date does not walk back a day), so
    the calendar date is read straight off the number with no zone table — and it
    stays the same however far from Greenwich the server sits. Grouping on the
    *viewer's* calendar instead is what splits a US week in half, the same failure
    ``timeShare.ts`` records for the 分时 cut.

    ISO week numbering rather than ``strftime("%W")``: the trading week that
    straddles New Year (Mon 29 Dec – Fri 2 Jan) is one bar on every broker's chart,
    and an (iso-year, iso-week) pair keeps it that way across the year boundary,
    where a bare week number would collide with week 1 of next year.
    """
    day = datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc)
    if unit == "week":
        iso = day.isocalendar()
        return (int(iso[0]), int(iso[1]))
    return (day.year, day.month)


def calendar_group_ordinal(group_key: tuple[int, int], unit: str) -> int:
    """One key from :func:`calendar_group_key` as a single monotonic integer.

    Division by ``k`` needs one number, not a pair: ``(2026, 1) // 2`` and
    ``(2025, 53) // 2`` say nothing about whether those weeks are neighbours. A week
    becomes whole weeks since the ISO epoch's first Monday, a month becomes
    ``year * 12 + (month - 1)``. Both are bijections onto the pair they replace, so
    ``k == 1`` groups exactly the bars it always grouped.
    """
    year, index = group_key
    if unit == "week":
        return (date.fromisocalendar(year, index, 1).toordinal() - _ISO_EPOCH_ORDINAL) // 7
    return year * 12 + (index - 1)


def _day_ordinal(ts_ms: int) -> int:
    """Trading-day label as a whole number of days since the epoch.

    Daily bars are midnight UTC of their label, so this division *is* the label —
    no zone table, no viewer's calendar. That is what makes a ``2D`` page land the
    same way however the request was cut.
    """
    return int(ts_ms) // DAY_MS


def _session_position_keys(bars: list[dict[str, Any]], k: int, zone: str) -> list[tuple[str, int]]:
    """``(session date, position-within-session // k)`` for ascending bars.

    The anchor is a bar's index **inside its own trading session**, so a fold can
    never cross a session: an A-share day holds four 60-minute bars closing at
    10:30 / 11:30 / 14:00 / 15:00, and a floor of UTC minutes would happily weld
    11:30 to 14:00 into a bar spanning the lunch break. Counting within the session
    gives [10:30, 11:30] and [14:00, 15:00] — the two bars every broker draws.

    Stateful by design and safe for paging: the count only ever walks forward, so a
    fold of a prefix is a prefix of the fold.
    """
    zone_info = ZoneInfo(zone)
    counts: dict[str, int] = {}
    keys: list[tuple[str, int]] = []
    for bar in bars:
        stamp = datetime.fromtimestamp(int(bar["timestamp"]) / 1000, tz=zone_info)
        day = stamp.date().isoformat()
        position = counts.get(day, 0)
        counts[day] = position + 1
        keys.append((day, position // k))
    return keys


def fold_by_keys(ordered_bars: list[dict[str, Any]], keys: list[Any]) -> list[dict[str, Any]]:
    """Collapse ascending bars by a parallel list of group keys.

    The OHLCV rule is the one the weekly merge has always used, and the two lists
    must already be ascending and the same length — sorting here is what a caller
    that computed its keys from a different order would silently get wrong.

    Open from the group's first bar, close from its last, high/low across the whole
    group, volume summed. The served bar keeps the **first** bar's timestamp, which
    is what makes paging exact: ``before`` is then always a group boundary, so a
    page can never split one group into two stubs.
    """
    if len(ordered_bars) != len(keys):
        raise ValueError(f"fold keys off the bar list: {len(ordered_bars)} bars, {len(keys)} keys")
    merged: list[dict[str, Any]] = []
    group: Any = None
    for bar, key in zip(ordered_bars, keys):
        if key != group:
            group = key
            merged.append(dict(bar))
            continue
        held = merged[-1]
        held["high"] = max(float(held["high"]), float(bar["high"]))
        held["low"] = min(float(held["low"]), float(bar["low"]))
        held["close"] = float(bar["close"])
        held["volume"] = float(held["volume"] or 0.0) + float(bar["volume"] or 0.0)
    return merged


def fold_bars(
    bars: list[dict[str, Any]], spec: IntervalSpec, zone: str | None = None
) -> list[dict[str, Any]]:
    """Base bars in, served bars out. Pure, no IO, ascending on the way in and out.

    ``zone`` is required for a minute fold (the session anchor) and ignored
    otherwise — the caller knows the symbol's suffix, this module must not grow a
    second copy of ``_MINUTE_WALL_CLOCK_ZONE`` to find out.
    """
    ordered = sorted(bars, key=lambda b: int(b["timestamp"]))
    if spec.kind == "native":
        return ordered
    if spec.kind == "minute-fold":
        if not zone:
            raise ValueError(
                f"{spec.interval} bars are folded {spec.k} {spec.base} ones inside a "
                "trading session, which needs the symbol's exchange clock"
            )
        return fold_by_keys(ordered, _session_position_keys(ordered, spec.k, zone))
    if spec.kind == "daily-fold":
        return fold_by_keys(ordered, [_day_ordinal(b["timestamp"]) // spec.k for b in ordered])
    return fold_by_keys(
        ordered,
        [
            calendar_group_ordinal(calendar_group_key(int(b["timestamp"]), spec.unit), spec.unit)
            // spec.k
            for b in ordered
        ],
    )


def calendar_fold_spec(unit: str, k: int) -> IntervalSpec:
    """A calendar grouping that always groups — ``k == 1`` included.

    ``fold_spec("1W", 1)`` is deliberately ``native``: that is the shape
    ``parse_interval("1W")`` gives, and the two must agree or the same request would
    fold differently through the two doors. The merge function needs the *opposite*
    default. Its ``k`` has always defaulted to one, and one natural week welded at a
    time still is a week bar — so a caller that means "group by calendar" says so
    here, instead of asking ``fold_spec`` for a shape it then has to un-degrade.
    """
    base = "1W" if unit == "week" else "1M"
    return IntervalSpec("calendar-fold", base, k, unit)
```

- [ ] **Step 4: `market_routes` 换键、加乘数** ——
  1. 删除 `_calendar_group_key`（`market_routes.py:471-491`，连同它的 docstring——理由已经随函数迁到 `interval_spec.calendar_group_key`，那里逐字保留了同一段话）。
  2. `_merge_to_calendar` 换成委托（**名字、前两参、返回形状都不变**，所以 `test_market_kline_coarse.py` 的 13 处两参调用零改动）：

```python
def _merge_to_calendar(
    bars: list[dict[str, Any]], unit: str, k: int = 1
) -> list[dict[str, Any]]:
    """Collapse ascending daily bars into natural-week / natural-month bars — or a
    multiple of them.

    OHLC follows what every broker does: open from the group's first day, close
    from its last, the high/low across the whole group, volume summed. The merged
    bar keeps the **first** day's timestamp, which is what makes paging exact —
    `before` is then always a group boundary, so a page can never split one week
    into two stubs (see :func:`_fetch_calendar_bars`).

    ``k`` says how many natural groups to weld into one served bar. The anchor is
    the group's **absolute** ordinal (weeks since the ISO epoch, months since year 1
    of the Common Era), never its index in the page this request happened to fetch:
    two pages of the same symbol have to disagree about where the data starts, not
    about which days belong to which bar. ``k == 1`` is the merge this function has
    always done.

    It goes through :func:`interval_spec.calendar_fold_spec`, not ``fold_spec``: the
    latter hands back a ``native`` spec at ``k == 1`` (that is what ``1W`` means to the
    parser), and ``fold_bars`` answers a native spec by returning the base bars
    untouched — which would silently turn every existing weekly call into a daily one.
    """
    return interval_spec.fold_bars(bars, interval_spec.calendar_fold_spec(unit, k))
```

  3. `market_routes.py` 顶部 import 区（`from datetime import ...` 之后）加一行 `from src.api import interval_spec`。若该文件用 `sys.modules` 兜底导入别处（`from src.api import market_routes` 是 udf 侧的形状），照 `market_routes.py` 自己的既有风格写，不新造第三种。
  4. **本步不许动** `_fetch_calendar_bars`（Task 3 才接乘数），也不许动 `_kline_sync`。

- [ ] **Step 5: `TestGroupKey` 六枚针改指新址** —— 在 `tests/test_market_kline_coarse.py` 里，把该类的六处 `market_routes._calendar_group_key(...)` 逐处改成 `interval_spec.calendar_group_key(...)`（顶部 `from src.api import market_routes` 旁补 `from src.api import interval_spec`）。**断言表达式与期望值一个字不改**——`(2026, 27)`、`"2025-12-29" == "2026-01-02"` 那两枚尤其保持原样；`TestMerge`／`TestFetchCalendarBars`／`TestRouting`／`TestQueryValidation` 四个类**一律不动**。
  同时在该文件 docstring 末尾追加一句（它现在讲的是两件事，得说明键住哪儿）：

```python
"""... (既有正文)

Grouping keys moved to ``src.api.interval_spec`` with the fold that now needs
multipliers; the pairs asserted in ``TestGroupKey`` are unchanged.
"""
```

- [ ] **Step 6: 跑绿＋同形复算** —— `cd agent && python -m pytest tests/test_market_kline_custom_intervals.py tests/test_interval_spec.py -q` 全绿；再 `python -m pytest tests/test_market_kline_coarse.py -q` **必须与 Task 1 Step 5 的同读数一致**（这一步就是设计 §2.3 那条「摘掉乘数分支后既有套件全绿」的正向半边）。

- [ ] **Step 7: 给设计文件补一行 amend** —— 在 `superpowers/specs/2026-10-19-l3-slice5-custom-intervals-design.md` 的 §2.3 末尾追加：

```markdown

> **2026-10-19 计划落笔时裁定**：本节引用的 `_calendar_group_key` docstring（原文
> `market_routes.py:472-486`）随折叠面迁入 `agent/src/api/interval_spec.py`，逐字同行；
> `market_routes` 里那份已不存在，不留别名。
```

- [ ] **Step 8: 提交**

```bash
cd /e/Vibe-Trading-main/Vibe-Trading-main
git add agent/src/api/interval_spec.py agent/src/api/market_routes.py \
        agent/tests/test_market_kline_custom_intervals.py agent/tests/test_market_kline_coarse.py \
        superpowers/specs/2026-10-19-l3-slice5-custom-intervals-design.md
git commit -s -m "$(cat <<'EOF'
feat(l3-slice5): 折叠实现——分组锚点用绝对序，OHLCV 沿用周月那条

分钟折锚在「会话内序号」，A 股 120 分因此是 [10:30,11:30] 与 [14:00,15:00] 两根，
不会把午休两端缝成一根世界上不存在的 K 线；日线与周月折锚在绝对日序／ISO 周序，
同一标的两次分页对同一天的归属必须一致，否则翻页就重绘。k=1 与既有折叠逐字同形。
EOF
)"
```

---

## Task 3: `/market/kline` 接线（尺寸、少返、拒绝、文档面）

**Files:**
- Modify: `agent/src/api/market_routes.py`（`_fetch_calendar_bars` 加乘数与标签；`_kline_sync` 按 spec 分发；路由 `:766` 的 `Query(description=...)` 与 `:774` 的闸门改口）
- Modify: `agent/tests/test_market_kline_custom_intervals.py`（追加路由面那一段）

**Interfaces:**
- Consumes: `interval_spec.parse_interval`／`fold_bars`／`MINUTE_BASES`／`DAILY_BASE`／`CALENDAR_BASES`／`IntervalSpec.interval`。
- Produces:
  - `_fetch_calendar_bars(symbol, interval, count, before, k: int = 1, label: str = "") -> tuple[list[dict], str]`（**前两参与四参调用形状保持兼容**，`test_market_kline_coarse.py:370` 那个四参桩必须继续可挂）
  - `_kline_sync(symbol, interval, count, adjust, before=None, session="")` 签名不变，能接受折叠拼写。
  - `source` 串：折叠时 `f"{source}+{label or interval}"`；原生 `1W`/`1M` 仍是 `f"{source}+{interval}"`；原生日线/分钟**不加后缀**（今天的样子）。

- [ ] **Step 1: 写红针** —— 追加进 `agent/tests/test_market_kline_custom_intervals.py`：

```python
def _client():
    from fastapi import FastAPI
    from fastapi.testclient import TestClient

    app = FastAPI()
    market_routes.register_market_routes(app, require_auth=lambda: None)
    return TestClient(app)


class TestRouteServesFolds:
    def test_a_two_day_request_is_the_fold_of_the_daily_chain(self, monkeypatch):
        days = _weekdays("2026-06-01", 40)
        bars_in = _daily_series(days)

        def fake(symbol, count, before):
            return bars_in[-count:], "backtest:test_chain"

        monkeypatch.setattr(market_routes, "_fetch_daily", fake)
        out = market_routes._kline_sync("600519.SH", "2D", 10, "qfq")
        assert out["interval"] == "2D"
        assert out["source"] == "backtest:test_chain+2D"
        assert out["bars"] == fold_bars(bars_in, fold_spec("1D", 2))[-10:]
        assert set(out) == {"status", "symbol", "interval", "source", "bars"}

    def test_two_pages_cut_at_different_before_agree_where_they_overlap(self, monkeypatch):
        """Design §4.2's paging leg: the anchor is the calendar's, never the page's.

        The stub honours `before` the way every real channel does (drop the bars at
        or after the cursor, then take the tail), so page two really is a different
        slice of the same chain. Grouping by "the Nth bar I happened to fetch" would
        pass a single-page test and then redraw the chart on the first scroll — this
        is the only pin that can see that, and it is why the fold keys on an
        absolute ordinal.
        """
        days = _weekdays("2026-03-02", 40)
        chain = _daily_series(days)

        def fake(symbol, count, before):
            pool = [b for b in chain if before is None or b["timestamp"] < before]
            return pool[-count:], "backtest:test_chain"

        monkeypatch.setattr(market_routes, "_fetch_daily", fake)
        page_one = market_routes._kline_sync("600519.SH", "2D", 6, "qfq")["bars"]
        page_two = market_routes._kline_sync(
            "600519.SH", "2D", 6, "qfq", before=page_one[-1]["timestamp"]
        )["bars"]
        assert page_two[-1]["timestamp"] < page_one[-1]["timestamp"]
        shared = [b for b in page_two if b["timestamp"] >= page_one[0]["timestamp"]]
        assert shared == page_one[: len(shared)]

    def test_the_daily_walk_is_scaled_by_the_multiplier(self, monkeypatch):
        asked: list[int] = []

        def fake(symbol, count, before):
            asked.append(count)
            return _daily_series(_weekdays("2020-01-01", count)), "backtest:test_chain"

        monkeypatch.setattr(market_routes, "_fetch_daily", fake)
        market_routes._kline_sync("600519.SH", "3W", 20, "qfq")
        assert asked == [20 * 8 * 3 + 30 * 3]  # per_bar 8, one margin per folded bar
        market_routes._kline_sync("600519.SH", "1W", 20, "qfq")
        assert asked[-1] == 20 * 8 + 30  # k = 1 is the old sizing, verbatim

    def test_the_daily_fold_asks_for_k_daily_bars_plus_the_leftover(self, monkeypatch):
        asked: list[int] = []

        def fake(symbol, count, before):
            asked.append(count)
            return _daily_series(_weekdays("2024-01-01", count)), "backtest:test_chain"

        monkeypatch.setattr(market_routes, "_fetch_daily", fake)
        market_routes._kline_sync("600519.SH", "2D", 30, "qfq")
        assert asked == [30 * 1 * 2 + 30 * 2]  # per_bar 1 for a daily base, margin × k too

    def test_a_minute_fold_asks_the_base_channel_for_k_times_the_bars(self, monkeypatch):
        """50 served bars of 120m asks the 60-minute channel for 101 base bars.

        The stub lays the base bars out the way an A-share tape really is — four 60m
        closes per trading day at 10:30 / 11:30 / 14:00 / 15:00 — because the anchor
        being tested is the session, and a stub that ran bars straight through the
        night would fold into groups no exchange ever produces. 101 = 25 whole days
        plus one orphan bar, so the fold has 51 groups and the leftover-orphan tail
        is what `count` then trims.
        """
        seen: list[tuple[str, int]] = []
        session_close_times = ("10:30", "11:30", "14:00", "15:00")

        def fake_minute(symbol, interval, count, adjust, before):
            seen.append((interval, count))
            days = _weekdays("2026-06-01", -(-count // 4))
            return [
                {
                    "timestamp": _minute_label(days[i // 4], session_close_times[i % 4]),
                    "open": 1.0 + i,
                    "high": 2.0 + i,
                    "low": 0.5,
                    "close": 1.5 + i,
                    "volume": 10.0,
                }
                for i in range(count)
            ]

        monkeypatch.setattr(market_routes, "_futu_minute_bars", fake_minute)
        out = market_routes._kline_sync("600519.SH", "120m", 50, "qfq")
        assert seen == [("60m", 50 * 2 + 2 - 1)]
        assert out["interval"] == "120m"
        assert out["source"].endswith("+120m")
        assert len(out["bars"]) == 50

    def test_a_page_that_cannot_be_filled_comes_back_short_and_says_so(self, monkeypatch):
        """设计 §6 那条「如实少返」的判据：不补根，靠 bars 与 source 自己说话。"""
        only = _daily_series(_weekdays("2026-06-01", 4))

        def fake(symbol, count, before):
            return only, "backtest:test_chain"

        monkeypatch.setattr(market_routes, "_fetch_daily", fake)
        out = market_routes._kline_sync("600519.SH", "2D", 10, "qfq")
        assert len(out["bars"]) < 10
        assert out["source"] == "backtest:test_chain+2D"

    def test_the_full_window_drops_the_leftover_group_like_the_weekly_merge_does(self, monkeypatch):
        """An exactly-satisfied ask means the chain ran further left, so the first fold is a stub.

        Same rule `_fetch_calendar_bars` already applies to weekly bars, carried to the
        multiplier — and the stub is built to *hit* it: `len(bars) == dailies`, which is
        how the pin knows the drop branch is the one that ran.
        """
        dailies = 40 * 2 + 30 * 2  # count * per_bar * k + margin * k
        chain = _daily_series(_weekdays("2026-06-01", dailies))

        def fake(symbol, count, before):
            assert count == dailies, count
            return chain, "backtest:test_chain"

        monkeypatch.setattr(market_routes, "_fetch_daily", fake)
        out = market_routes._kline_sync("600519.SH", "2D", 40, "qfq")
        assert out["bars"] == fold_bars(chain, fold_spec("1D", 2))[1:][-40:]


class TestRouteRefusals:
    def test_a_fold_with_session_latest_names_the_fold_not_the_day(self, monkeypatch):
        monkeypatch.setattr(market_routes, "_fetch_daily", lambda *a, **k: ([], "x"))
        with pytest.raises(ValueError, match="folded") as exc:
            market_routes._kline_sync("600519.SH", "2D", 100, "qfq", session="latest")
        assert "already are one day each" not in str(exc.value)

    def test_a_minute_fold_with_session_latest_is_refused_the_same_way(self, monkeypatch):
        monkeypatch.setattr(
            market_routes, "_futu_minute_bars",
            lambda symbol, interval, count, adjust, before: [
                {"timestamp": _minute_label("2026-06-01", "10:30") + i * 3_600_000,
                 "open": 1.0, "high": 2.0, "low": 0.5, "close": 1.5, "volume": 1.0}
                for i in range(count)
            ],
        )
        with pytest.raises(ValueError, match="folded"):
            market_routes._kline_sync("600519.SH", "120m", 10, "qfq", session="latest")

    def test_the_native_refusals_still_say_what_they_said(self, monkeypatch):
        """设计 §2.1：那两句既有文案一字不改，因为它俩说的是真话。"""
        monkeypatch.setattr(market_routes, "_fetch_daily", lambda *a, **k: ([], "x"))
        with pytest.raises(ValueError, match="1W bars are merged from daily"):
            market_routes._kline_sync("600519.SH", "1W", 100, "qfq", session="latest")
        with pytest.raises(ValueError, match="daily bars already are one day each"):
            market_routes._kline_sync("600519.SH", "1D", 100, "qfq", session="latest")

    def test_an_unserviceable_interval_names_the_rule_and_the_bases(self):
        res = _client().get("/market/kline?symbol=600519.SH&interval=2.5m")
        assert res.status_code == 400
        body = res.json()["error"]
        assert "'2.5m'" in body
        for base in ("1D", "1W", "1M"):
            assert base in body, body
        assert "multiplier" in body, body


class TestRouteDoc:
    def _interval_description(self) -> str:
        client = _client()
        schema = client.app.openapi()
        params = schema["paths"]["/market/kline"]["get"]["parameters"]
        return [p for p in params if p["name"] == "interval"][0]["description"]

    def test_the_route_doc_describes_a_rule_not_a_dead_list(self):
        """Carries the judgment: the old text was a closed list of eight literals.

        The eight base spellings still appear (they are the bases), so only the two
        assertions below actually separate the new copy from the old.
        """
        description = self._interval_description()
        assert "multiplier" in description, description
        assert "120m" in description, description
```

注意 `test_the_daily_fold_asks_for_k_daily_bars_plus_the_leftover` 里 `[30 * 1 * 2 + 30 * 2]` 的读法：`_kline_sync` 对 `2D` 只问一次 `_fetch_daily`，所以期望是一条单元素的清单；那个 `1` 是日线基档的 `per_bar`（`_AGG_DAILY_PER_BAR` 里没有 `1D`，`.get` 落回 1），两个 `30` 分别是 `count` 与 `_AGG_DAILY_MARGIN`，都按 `k = 2` 放大。

- [ ] **Step 2: 跑红** —— `cd agent && python -m pytest tests/test_market_kline_custom_intervals.py -q`；新类逐枚红（折叠拼写现在被 `:774` 的闸门或 `_kline_sync` 的 `else` 分支吃掉）。逐字留档每枚红的失败首行。

- [ ] **Step 3: 接线** —— `_fetch_calendar_bars` 与 `_kline_sync` 换成下面两版（`_kline_sync` 的 payload 组装、`session == "latest"` 尾段、两句原生拒绝的文案**逐字保持原样**）：

```python
def _fetch_calendar_bars(
    symbol: str,
    interval: str,
    count: int,
    before: int | None,
    k: int = 1,
    label: str = "",
) -> tuple[list[dict[str, Any]], str]:
    """Weekly / monthly / daily bars, merged out of the daily chain — k at a time.

    （既有 docstring 三条理由**逐字保留**，然后追加下面这段）

    ``k`` welds that many natural groups into one served bar (``k == 1`` is what
    ``1W`` / ``1M`` have always done); ``label`` is the spelling the caller asked
    for, which the status line has to print because ``interval`` is only the base.
    The daily walk scales with both, and :data:`_AGG_DAILY_CAP` still bounds it —
    no ceiling is raised here, so a big multiplier comes back short and says so.
    """
    per_bar = _AGG_DAILY_PER_BAR.get(interval, 1)  # a daily fold welds one day each
    dailies = min(
        count * per_bar * k + _AGG_DAILY_MARGIN * k, _AGG_DAILY_CAP
    )
    bars, source = _fetch_daily(symbol, dailies, before)
    if interval == interval_spec.DAILY_BASE:
        # A daily fold welds *days*, so it does not go through the calendar merge:
        # that function's `unit` has always been week / month, and inventing a third
        # token for it would make `_merge_to_calendar` mean two different groupings
        # depending on a string nobody validates.
        merged = interval_spec.fold_bars(bars, interval_spec.fold_spec(interval, k))
    else:
        merged = _merge_to_calendar(
            bars, "week" if interval == "1W" else "month", k
        )
    if len(bars) >= dailies and len(merged) > 1:
        # （:546-559 那段解释左缘残组的注释逐字保留）
        merged = merged[1:]
    return merged[-count:], f"{source}+{label or interval}"
```

```python
def _kline_sync(
    symbol: str, interval: str, count: int, adjust: str, before: int | None = None,
    session: str = "",
) -> dict[str, Any]:
    if session not in {"", "latest"}:
        raise ValueError(f"unsupported session {session!r} (only 'latest' is defined)")
    spec = interval_spec.parse_interval(interval)
    if spec is None:
        raise ValueError(_unsupported_interval_message(interval))
    if session == "latest" and spec.k > 1:
        # 分时是「一个交易日里的那一段」，折叠根跨天——这句必须点名折叠，不能借用
        # 下面那句「daily bars already are one day each」对 2D 说一句假话。
        raise ValueError(
            f"session=latest narrows one trading day out of minute bars; {interval} bars "
            f"are folded {spec.k} {spec.base} ones and a fold can span days"
        )
    bars: list[dict[str, Any]]
    if spec.base in interval_spec.MINUTE_BASES:
        # One extra base bar per served bar: the weld drops the group the window's
        # left edge lands inside, and `count` served bars still have to come back.
        ask = min(count * spec.k + spec.k - 1, _MAX_BARS)
        bars = _futu_minute_bars(symbol, spec.base, ask, adjust, before)
        source = "futu:opend"
        if bars is None:
            # Fall through to the public path, which reaches A-shares only.
            # Everything else has no source left and is told so *by cause*.
            if symbol.rsplit(".", 1)[-1] not in {"SH", "SZ"}:
                raise ValueError(_minute_no_source_reason(symbol, adjust))
            bars = _fetch_minute_a_share(symbol, _MINUTE_PERIODS[spec.base], ask, adjust, before)
            source = "akshare:sina_stock_zh_a_minute"
        if spec.k > 1:
            zone = _MINUTE_WALL_CLOCK_ZONE.get(symbol.rsplit(".", 1)[-1])
            if zone is None:
                raise ValueError(f"{interval} bars cannot be folded: {symbol} has no exchange clock")
            folded = interval_spec.fold_bars(bars, spec, zone)
            if len(bars) >= ask and len(folded) > 1:
                folded = folded[1:]
            bars, source = folded[-count:], f"{source}+{interval}"
    elif spec.kind in {"daily-fold", "calendar-fold"}:
        # `session == "latest"` never reaches here: a fold has k > 1 and was refused
        # above, so this branch has no session handling of its own to write.
        bars, source = _fetch_calendar_bars(
            symbol, spec.base, count, before, spec.k, interval
        )
    elif interval in _AGG_DAILY_PER_BAR:
        if session == "latest":
            raise ValueError(
                "session=latest narrows one trading day out of minute bars; "
                f"{interval} bars are merged from daily ones, which are one day each already"
            )
        bars, source = _fetch_calendar_bars(symbol, interval, count, before)
    else:
        if session == "latest":
            raise ValueError(
                "session=latest narrows one trading day out of minute bars; "
                "daily bars already are one day each"
            )
        bars, source = _fetch_daily(symbol, count, before)
    payload: dict[str, Any] = {
        "status": "ok",
        "symbol": symbol,
        "interval": interval,
        "source": source,
        "bars": bars,
    }
    # （`:669-681` 的 session=latest 尾段逐字保留，一个字不改）
    return payload
```

`_MAX_BARS` 就是 `market_routes.py:52` 那枚既存上限——折叠请求把它当天花板，所以一个 `k=2` 的 2000 根请求只会**如实少返**，不会越过既存上限去要 4000 根基 bar。这条是 Global Constraints 里「不新增、不修改上限常量」的落地形状，写针时不许换成新的常量名。

再加一条私有文案函数（放在 `_kline_sync` 上方），让路由的 400 与 `_kline_sync` 的 `ValueError` 共用一句真话：

```python
def _unsupported_interval_message(interval: str) -> str:
    """Name the rule, not a closed list: the set is now base × a whole number of times."""
    return (
        f"unsupported interval {interval!r} (known: {'/'.join(_MINUTE_PERIODS)} / 1D / "
        f"{'/'.join(_AGG_DAILY_PER_BAR)}, or any of those bases taken a whole number of "
        f"times — e.g. 120m is two 60-minute bars)"
    )
```

- [ ] **Step 4: 路由面改口** —— `market_kline` 路由里：
  1. `:766` 那枚 `Query(...)` 的 `description` 换成（既有 `count`／`adjust`／`before`／`session` 四枚参数一字不动）：

```python
        interval: str = Query(
            "1D",
            description=(
                "1m/5m/15m/30m/60m, 1D, or 1W/1M (merged from daily bars) — and any of "
                "those bases taken a whole number of times, folded here: 120m is two 60m "
                "bars, 2D two daily ones, 3M three monthly ones"
            ),
        ),
```

  2. `:774` 那支 400 闸门的条件从 `if interval not in _MINUTE_PERIODS and interval not in _AGG_DAILY_PER_BAR and interval != "1D":` 换成 `if interval_spec.parse_interval(interval) is None:`，错误体里那句 `f"unsupported interval {interval!r} (known: ...)"` 换成调用 `_unsupported_interval_message(interval)`（`content` 的外层 `{"status": "error", "error": ...}` 形状不动）。

- [ ] **Step 5: 跑绿＋复跑既有** ——
  `cd agent && python -m pytest tests/test_market_kline_custom_intervals.py tests/test_interval_spec.py -q` 全绿；
  `python -m pytest tests/test_market_kline_coarse.py tests/test_udf_routes.py -q` **与当场复测的基线同读数**。若 `test_coarse_intervals_pass_the_gate` 红在参数个数，说明原生 `1W`/`1M` 的调用点写成了六参——改回四参调用（`k`／`label` 只由折叠支传）。

- [ ] **Step 6: 提交**

```bash
cd /e/Vibe-Trading-main/Vibe-Trading-main
git add agent/src/api/market_routes.py agent/tests/test_market_kline_custom_intervals.py
git commit -s -m "$(cat <<'EOF'
feat(l3-slice5): /market/kline 接折叠档位，文案改口成一条规则

尺寸式按乘数放大并仍受三枚既存上限约束（不放宽、不补根：取不满一页就少返，
source 串带 +2D / +120m 让状态行说真话）。session=latest × k>1 点名拒绝——折叠根
跨天，不能借用那句「daily bars already are one day each」。Query 的 description 从
八枚字面量的死清单改成「基档 × 正整数倍」的一条规则。
EOF
)"
```

---

## Task 4: `udf_routes` 派生化（两张表＋两枚 86400 兜底＋报价等式）

**Files:**
- Modify: `agent/src/api/udf_routes.py`
- Modify: `agent/tests/test_udf_routes.py`（并进既有 fixture，见裁定三）

**Interfaces:**
- Consumes: `interval_spec.parse_resolution`／`bar_seconds`／`IntervalSpec.interval`。
- Produces: 名字保持 `_RESOLUTION_TO_INTERVAL` 与 `_RESOLUTION_SECONDS`（改成派生）；`_bar_count(spec, frm, to, countback)` **第二枚入参从拼写字符串变成 `IntervalSpec`**；`history_payload` 签名不变。

- [ ] **Step 1: 先跑基线并留未跟踪件** —— 动表之前：

```bash
cd /e/Vibe-Trading-main/Vibe-Trading-main/agent
mkdir -p C:/Users/fire/AppData/Local/Temp/slice5
python -m pytest tests/test_udf_routes.py -q > C:/Users/fire/AppData/Local/Temp/slice5/udf-baseline.txt 2>&1
echo "rc=$?"
tail -3 C:/Users/fire/AppData/Local/Temp/slice5/udf-baseline.txt
```

（重定向一律绝对路径；`/tmp` 对 Windows 侧 python 不可见。这份件就是设计 §6 那条「先跑基线留未跟踪件，再动」的落点，改完要逐字对比尾行读数。）

- [ ] **Step 2: 写红针** —— 追加到 `agent/tests/test_udf_routes.py` 末尾：

```python
# --------------------------------------------------------------------------- #
# custom multiplier resolutions (local ㊞ slice 5): the tables are derived now
# --------------------------------------------------------------------------- #

def test_the_native_table_lost_not_a_single_spelling():
    """Whole-dict equality: dropping one of the twelve spellings is the failure mode.

    The table used to be twelve hand-written entries; it is now built from
    ``interval_spec``. A hand-deleted key here would make a real widget's `1H` or
    `1D` request 400 while `/config` still looks fine, so the comparison is against
    the literals, not against the module.
    """
    assert udf_routes._RESOLUTION_TO_INTERVAL == {
        "1": "1m", "5": "5m", "15": "15m", "30": "30m", "60": "60m", "1H": "60m",
        "1D": "1D", "D": "1D", "1W": "1W", "W": "1W", "1M": "1M", "M": "1M",
    }


def test_the_bar_width_table_still_reads_the_old_numbers():
    assert udf_routes._RESOLUTION_SECONDS == {
        "1": 60, "5": 300, "15": 900, "30": 1800, "60": 3600, "1H": 3600,
        "D": 86400, "1D": 86400, "W": 604800, "1W": 604800, "M": 2678400, "1M": 2678400,
    }


def test_config_advertises_exactly_the_eight_canonical_spellings():
    """The pin above (`cfg[...] == list(SUPPORTED_RESOLUTIONS)`) cannot fail; this one can.

    `1H` / `1D` / `1W` / `1M` are accepted by `/history` but must not be offered: a
    chart that is handed a second spelling of one interval will draw two buttons.
    """
    assert udf_routes.SUPPORTED_RESOLUTIONS == ("1", "5", "15", "30", "60", "D", "W", "M")


@pytest.mark.parametrize(
    "resolution",
    ["1", "5", "15", "30", "60", "1H", "1D", "D", "1W", "W", "1M", "M"],
)
def test_every_advertised_resolution_is_answerable(resolution, client, daily_feed):
    """报价等式：`/config` 报出去的每一个拼写，`/history` 必须答得出。

    Asserting `s != "error"` rather than `== "ok"` because the fixture window is
    allowed to be empty for one spelling or another; what is not allowed is the
    `unsupported resolution` answer.
    """
    body = client.get(
        "/api/udf/history",
        params={"symbol": "600519.SH", "resolution": resolution, "from": 1_750_000_000,
                "to": 1_760_000_000},
    ).json()
    assert body.get("s") != _S_ERROR, body
    assert "unsupported" not in str(body.get("errmsg", ""))


@pytest.mark.parametrize(
    "resolution", ["120", "7", "1440", "2D", "2W", "3M"],
)
def test_multiplier_resolutions_are_served_not_rejected(resolution, client, monkeypatch):
    """`/config` never lists these; the protocol still lets a widget ask for them."""
    asked: list[tuple[str, int]] = []

    def fake_minute(symbol, interval, count, adjust, before):
        asked.append((interval, count))
        step = {"1m": 60_000, "60m": 3_600_000}[interval]
        start = 1_760_000_000_000
        return [
            {"timestamp": start + i * step, "open": 1.0, "high": 2.0, "low": 0.5,
             "close": 1.5, "volume": 10.0}
            for i in range(count)
        ]

    monkeypatch.setattr(market_routes, "_futu_minute_bars", fake_minute)
    body = client.get(
        "/api/udf/history",
        params={"symbol": "600519.SH", "resolution": resolution,
                "from": 1_750_000_000, "to": 1_770_000_000},
    ).json()
    assert body.get("s") in ("ok", "no_data"), body
    assert "unsupported" not in str(body.get("errmsg", ""))


@pytest.mark.parametrize(
    "resolution", ["1", "5", "15", "30", "60", "1H", "1D", "D", "1W", "W", "1M", "M",
                   "120", "7", "2D", "2W", "3M"],
)
def test_every_served_resolution_has_a_real_bar_width(resolution):
    """设计 §4 第 4 步：不 grep 源码，而是断言那两枚 86400 兜底已经没有对象可兜。

    `_bar_count` and the window filter now both take `bar_seconds(spec)`, which is
    total over `IntervalSpec`. A spelling that has no width cannot produce a spec at
    all, so it is refused by name before either site is reached.
    """
    parsed = interval_spec.parse_resolution(resolution)
    assert parsed is not None, resolution
    assert interval_spec.bar_seconds(parsed) > 0, resolution


def test_a_resolution_that_is_not_a_spelling_is_refused_by_name(client):
    body = client.get(
        "/api/udf/history",
        params={"symbol": "600519.SH", "resolution": "2.5", "from": 1_750_000_000,
                "to": 1_760_000_000},
    ).json()
    assert body["s"] == "error"
    assert "'2.5'" in body["errmsg"]
    assert "multiplier" in body["errmsg"], body["errmsg"]


def test_the_history_window_uses_the_fold_width_not_a_day(client, daily_feed):
    """`120` must not borrow `86400`: that would widen the window to a day per bar.

    20 folded bars over a 15-day window: with the old default the estimate sized
    itself as if each bar were a day (a factor-of-12 error), and the overlap filter
    then let bars through that never reach the window.
    """
    bars = daily_feed["bars"]
    frm = int(bars[0]["timestamp"]) // 1000
    to = int(bars[19]["timestamp"]) // 1000 + 7200
    body = client.get(
        "/api/udf/history",
        params={"symbol": "600519.SH", "resolution": "120", "from": frm, "to": to},
    ).json()
    assert body["s"] == "ok", body
    assert interval_spec.bar_seconds(interval_spec.parse_resolution("120")) == 7200
    assert all(to > t >= frm - 7200 for t in body["t"]), body["t"]
```

该文件顶部 import 区补 `from src.api import interval_spec`；`_S_ERROR` 若该文件尚未导入，就直接用字面量 `"error"`（别新增一条私有名）。

- [ ] **Step 3: 跑红** —— `cd agent && python -m pytest tests/test_udf_routes.py -q > C:/Users/fire/AppData/Local/Temp/slice5/udf-red.txt 2>&1; echo "rc=$?"`；预期新增针红在「折叠拼写被拒」与「派生表尚未存在」。逐字对比 `udf-baseline.txt` 的尾行，确认红的只是新针。

- [ ] **Step 4: 派生化改造** —— `agent/src/api/udf_routes.py`：

  1. 顶部 `from src.api import market_routes` 旁加 `from src.api import interval_spec`。
  2. `:86-108` 那段注释＋字面表替换为派生式（注释里「multipliers are **not** here」那两句已经是假话，必须改写；新文案把「为什么仍然不向 `/config` 报倍数」留下）：

```python
#: UDF resolution spellings -> ``market_routes`` interval tokens. Derived from
#: :mod:`src.api.interval_spec`, which is the one place that knows what a bar is.
#:
#: The protocol names intraday bars by bare minutes (``"1"``, ``"60"``) and calendar
#: bars by a unit letter, with the ``"1D"`` form also accepted because both spellings
#: appear in the wild and in our own toolbar. A multiplier (``"120"``, ``"2D"``,
#: ``"3M"``) is **served but not advertised**: the library composes those requests
#: itself from the bases it is shown, and a list of every product would be a
#: catalogue to maintain rather than a capability to discover. What stays refused is
#: the spelling that is not a whole multiple of a served base — ``2.5``, ``0`` —
#: because a silent round to the nearest neighbour would draw monthly bars on a
#: ``3M`` request and look like data.
_NATIVE_RESOLUTIONS: tuple[str, ...] = (
    "1", "5", "15", "30", "60", "1H", "1D", "D", "1W", "W", "1M", "M",
)


def _native_spec(resolution: str) -> interval_spec.IntervalSpec:
    """One entry of the native list, as a spec. Loud, never ``None``-into-a-default."""
    parsed = interval_spec.parse_resolution(resolution)
    if parsed is None:
        raise ValueError(f"native resolution {resolution!r} is not a parseable interval")
    return parsed


_RESOLUTION_TO_INTERVAL: dict[str, str] = {
    r: _native_spec(r).interval for r in _NATIVE_RESOLUTIONS
}

#: What ``/config`` advertises. The canonical spellings only: a chart that offers
#: a resolution the feed does not name is an offer the feed has to keep.
SUPPORTED_RESOLUTIONS: tuple[str, ...] = ("1", "5", "15", "30", "60", "D", "W", "M")

#: Approximate seconds per resolution, used only to size a bar count from a
#: ``[from, to)`` window when the library does not send ``countback``. Monthly is
#: 31 days (the long month), so the count can only ever come out too large and
#: be trimmed by the response — never too small, which would clip the window.
_RESOLUTION_SECONDS: dict[str, int] = {
    r: interval_spec.bar_seconds(_native_spec(r)) for r in _NATIVE_RESOLUTIONS
}
```

  3. `_bar_count`（`:461`）改吃 spec，**删掉 `86400` 兜底**：

```python
def _bar_count(spec: interval_spec.IntervalSpec, frm: int, to: int, countback: int | None) -> int:
    """（既有 docstring 逐字保留，只在末尾追加一句：）

    ``spec`` is the parsed resolution, so the width is the fold's own — a bar sized
    as a day for a 120-minute request would ask for an order of magnitude too few.
    """
    if countback and countback > 0:
        return max(1, min(int(countback), market_routes._MAX_BARS))
    per_bar = interval_spec.bar_seconds(spec)
    span = max(int(to) - int(frm), 0)
    estimated = math.ceil(span / per_bar) + 2 if span else market_routes._MAX_BARS
    return max(1, min(estimated, market_routes._MAX_BARS))
```

  4. `history_payload`（`:481`）的解析支、`_kline_sync` 调用与窗口过滤：

```python
    parsed = interval_spec.parse_resolution(resolution)
    if parsed is None:
        return {"s": _S_ERROR, "errmsg": _unsupported_resolution(resolution)}
    interval = parsed.interval
```

```python
def _unsupported_resolution(resolution: str) -> str:
    """Name the rule and the bases; the old text could only list eight literals."""
    return (
        f"unsupported resolution {resolution!r} (known: {'/'.join(SUPPORTED_RESOLUTIONS)} "
        f"native spellings, or any served base taken a whole number of times — 120 is two "
        f"60-minute bars)"
    )
```

`_kline_sync` 调用那行的 `interval` 用 `parsed.interval`（折叠拼写由此进入市场侧的同一条分发），`count = _bar_count(parsed, frm_s, to_s, countback)`；窗口过滤那行 `span = _RESOLUTION_SECONDS.get(resolution, 86400)` 换成 `span = interval_spec.bar_seconds(parsed)`，并在它上面的 `:554-567` 注释里把「``_RESOLUTION_SECONDS`` is the generous approximation」改成「``bar_seconds`` is the generous approximation of **this** bar's width (31 days for a month, ``k`` days for a ``2D``)」——那段「宁可多含一根也不许少含」的理由**逐字留着**，它现在解释的是派生值。

  5. `config_payload`（`:205`）与 `symbol_info`（`:309`、`:333`）**一字不动**——报价面继续只报八枚原生拼写与五枚 multipliers（设计 §3 的判据是那条等式，针在 Step 2 已钉）。

- [ ] **Step 5: 跑绿＋基线逐字对比** —— `cd agent && python -m pytest tests/test_udf_routes.py -q > C:/Users/fire/AppData/Local/Temp/slice5/udf-after.txt 2>&1; echo "rc=$?"`；再 `diff C:/Users/fire/AppData/Local/Temp/slice5/udf-baseline.txt C:/Users/fire/AppData/Local/Temp/slice5/udf-after.txt` 只看尾行 pass 数的变化，`test_udf_history_and_market_kline_are_the_same_bars` 那三枚参数化读数必须**继续通过**（设计 §6 点名的两处读数）。
`python -m pytest tests/test_interval_spec.py tests/test_market_kline_custom_intervals.py tests/test_market_kline_coarse.py -q` 全绿。

- [ ] **Step 6: 变异自证（一次性，不提交）** —— 在 `agent/src/api/udf_routes.py` 里临时把 `span = interval_spec.bar_seconds(parsed)` 改回 `span = _RESOLUTION_SECONDS.get(resolution, 86400)`，跑 `python -m pytest tests/test_udf_routes.py -q`，记录哪几枚针红；还原只用**动手前那份内存副本**写回（`Path.write_bytes`），随后 `git diff -- agent/src/api/udf_routes.py` 必须为空。任一枚针不红 ⇒ 那枚针是 HARNESS-BLIND，写进报告并补强。

- [ ] **Step 7: 提交**

```bash
cd /e/Vibe-Trading-main/Vibe-Trading-main
git add agent/src/api/udf_routes.py agent/tests/test_udf_routes.py
git commit -s -m "$(cat <<'EOF'
feat(l3-slice5): udf 两张表改派生，两枚 86400 静默兜底随之消失

`_RESOLUTION_TO_INTERVAL` 与 `_RESOLUTION_SECONDS` 现在由 interval_spec 生成，
`_bar_count` 与窗口过滤改吃 bar_seconds(spec)——折叠档位一旦放开，旧兜底会把 120 分
按「一根＝一天」估根并把窗口拉宽到 86400 秒，少取一个数量级又放过不该进窗的根。
/config 仍只报八枚原生拼写：倍数由库自己按基档组合，报出去就变成一张要养的清单。
EOF
)"
```

> **2026-10-20 执行期 amend（Task 4 的三条正文缺陷，由控制席当场复测后裁定，落地形状以 `5b0c5595` 为准）**
>
> （一）**Interfaces 那句「名字保持 `_RESOLUTION_TO_INTERVAL` 与 `_RESOLUTION_SECONDS`（改成派生）」作废，两张表删除。**
> 开工前 `grep -rn "_RESOLUTION_SECONDS|_RESOLUTION_TO_INTERVAL|_bar_count" src/ tests/ --include=*.py` 现读：
> 前者的唯一读者是 `udf_routes.py:509`，后者的两枚读者是 `:475` 与 `:568`——三处都在本任务的 Step 4 里换成
> `parse_resolution`／`bar_seconds(spec)`，于是两张表**读者归零**。Step 2 又要求整字典钉它们，那就是一张没人读的
> 字典外加一枚专供测试的针，与本计划在 `alerts_routes.py:51` 照出来的同一种病（词表长在别处、解析器说另一套）。
> 设计 §3 那段的用途自述是「两枚 `86400` 静默兜底」，兜底消失即用途满足；两枚针的 claim 逐字留在测试里，
> 等号左边从「读 src 的表」改成「当场对 `interval_spec` 求值」，字面量仍整字典对账。
>
> （二）**Step 2 三枚新针的 fixture 接线是计划缺陷。** 本文件自己写的 `minute_feed` docstring
> （`agent/tests/test_udf_routes.py:322-325`）就点名「只钉日链会让日内测试真去 `import akshare`」，而
> `test_every_advertised_resolution_is_answerable` 与 `test_the_history_window_uses_the_fold_width_not_a_day`
> 只挂 `daily_feed` 却请求分钟族，`test_multiplier_resolutions_are_served_not_rejected` 只钉分钟链却把
> `2D`／`2W`／`3M` 交给日链。补钉是纯增量：断言、参数化条目、docstring 的 claim 一字不动——让它们在未钉的通道上红，
> 等于把一次网络故障记成语义失败。
>
> （三）**Step 4.4 的 `_unsupported_resolution` 文案与 Step 2 的针互斥**：针要求 `"multiplier" in body["errmsg"]`，
> 交付文案只说「taken a whole number of times」。裁定形与 Task 1 F3／Task 3 F1 同——**针是需求，文案是过期那一半**，
> 只做纯增量插句。连带一处既存针 `test_udf_history_unknown_resolution_is_an_error_naming_the_known_ones`
> 的反例从 `3M` 换成 `1Q`：`3M` 被本片放开是**故意的行为变更**，而那枚针的 claim（被拒的拼写要点名已知的那些）
> 在换掉的反例上原样成立；`"3"` 不能用，它解析成 `1m`×3。
>
> **2026-10-20 执行期 amend 第二批（修复轮 1＋2 落地后由控制席自己复测；三枚注入一律走仓库外 pytest 插件，
> 跟踪文件零写入。同一对套件 `tests/test_udf_routes.py ＋ tests/test_interval_spec.py` 的未注入基线＝
> `142 passed, rc=0`，下面四条读数共用这个分母）**
>
> （四）**控制席在裁定里写过两句假话，落地时已被修复轮改口成盘面真相。**
> 一句是「宽度由两扇门共同从 `interval_spec` 读」：`grep -rn bar_seconds agent/src` 现读的读者只有
> `udf_routes.py:452` 与 `:550` 两处，`market_routes.py` 一次没调用——`/market/kline` 吃的是 `spec.base`
> 与 `spec.k`，宽度不经 `bar_seconds`。于是 `agent/tests/test_interval_spec.py:128-129` 从「两张表已由本模块派生」
> 改成单扇门的说法，逐字现为 `test_native_widths_are_the_ones_udf_history_needs` /
> `"""The bar width belongs to ``interval_spec``; ``/history`` reads it from here.`（1 行换 1 行，`:122-136` 行数守恒）。
> 另一句是「只有 `120`／`7`／`1440` 三枚走到 `fold_bars`」：现读三个调用点 `market_routes.py:497`／`:540`／`:673`，
> 日历腿与 `1D` 同样到达、`k=1` 也过 ⇒ `agent/tests/test_udf_routes.py:652-655` 改口为「六枚腿都到 `fold_bars`，
> 但『到得了』是路由而不是折叠证明，折叠算术由 Task 3 钉」。
> 两句同因：把「本片新开的倍数面」当成了「那张表的全部来电」，落笔前没现读调用点。给下一个执行者的纪律：
> 裁定里凡说「谁读了 X」，先 `grep -rn` 再写。
>
> （五）**被删的两枚整字典针，claim 由继任者分担，且本席当场验过继任者有牙。**
> 摘掉 `udf_routes.py:105` 的 `"M"` ⇒ `1 failed, 141 passed`，红的正是
> `test_udf_routes.py:606 test_config_advertises_exactly_the_eight_canonical_spellings`（断言在 `:612`）。
> 摘掉 `interval_spec.py:58` 的 `"1H": "60m"` ⇒ `5 failed, 137 passed`：
> `test_every_advertised_resolution_is_answerable[1H]`（`:619`）、
> `test_every_served_resolution_has_a_real_bar_width[1H]`（`:692`），加 `test_interval_spec.py` 的
> `TestParseResolution::test_the_h_letter_and_the_bare_unit_letters_are_aliases`、
> `TestParseResolution::test_every_served_resolution_round_trips_through_the_market_grammar[1H]`、
> `TestBarSeconds::test_native_widths_are_the_ones_udf_history_needs[1H-3600]`。
> 最后一枚以 `interval_spec.py:172` 的 `AttributeError` 形状红（`None` 喂进 `bar_seconds`）而不是断言失败——
> 形状难看但确实红，正是裁定预告并接受的代价。
> `Why:` 手删一枚拼写时该红的不是「那张字典少一个键」，而是「报价与应答不再相等」与「这枚拼写没有宽度」；
> 继任者把这两条分别接在 HTTP 应答面、宽度面、别名面与往返面上。
>
> （六）**根数腿起初无针，是本片自造出来又当场治掉的读数病灶。**
> `_bar_count`（`udf_routes.py:435`）算出的根数在修复轮 1 之前没有任何东西接住：窗口针的替身不看 `count`
> 参数、恒回固定根数，于是「把 `per_bar` 换成 `86400`」在树上全绿——一条写了却没被任何针读到的算术，
> 而档案若据此写「两枚 `86400` 兜底已消失」就是假话。落地形状：替身记下收到的 `ask`，用窗口自己算出的尺断言
> （`test_udf_routes.py:758`，逐字 `assert asked_count and asked_count[0] >= (to - frm) // 7200 * 2, (asked_count, frm, to)`），
> 尺由窗口导出、不是手抄魔数。终态注入读数（本席自跑）：**`3 failed, 139 passed`**，红的三条腿＝
> `test_multiplier_resolutions_are_served_not_rejected[120]`、`[7]`、
> `test_the_history_window_uses_the_fold_width_not_a_day`。`1440` 那枚腿在注入下不红，原因如实记在这儿：
> 它自己的真宽度就是 `86400`，注入对它是恒等操作，不是针瞎。

---

## Task 5: 活体探真进程（不起 TestClient 交差）

**Files:**
- Modify: `项目档案.md`（新建 §7.29 的第一段：活体读数；bytes 层插入）
- Report artifact: `.superpowers/sdd/2026-10-19-l3-slice5-custom-intervals/live-probe.md`（未跟踪，逐字命令行与原始 JSON 全文）

**Interfaces:**
- Consumes: Task 3/4 的落地实现；本机后端 8000 端口（`agent/api_server.py`，`serve_main` 吃 `--port`／`--host`，无子命令）。
- Produces: §7.29 里一段可复算的读数（根数、首尾时间戳、`source` 串、纯函数对同一基档的折叠结果比对结论）。

- [ ] **Step 1: 起真进程**（后台，记下 PID；**只按现读 PID 停，绝不按镜像名杀**）

```bash
cd /e/Vibe-Trading-main/Vibe-Trading-main/agent
python api_server.py --port 8000 > C:/Users/fire/AppData/Local/Temp/slice5/server.log 2>&1 &
echo "server_pid=$!"
sleep 3
tail -20 C:/Users/fire/AppData/Local/Temp/slice5/server.log
```

`Errno 10048` 就换 8010 并在记录里写明用的哪一枚端口；起不来先看 `server.log`，不要动依赖。

- [ ] **Step 2: 探四条**（`--noproxy '*'` 必带：本机代理在 `127.0.0.1:7897` 且注册表 `ProxyEnable` 会漂，回环地址走代理会连不上）

```bash
mkdir -p C:/Users/fire/AppData/Local/Temp/slice5
cd C:/Users/fire/AppData/Local/Temp/slice5
curl --noproxy '*' -s "http://127.0.0.1:8000/market/kline?symbol=600519.SH&interval=2D&count=30" -o kline-2d.json
curl --noproxy '*' -s "http://127.0.0.1:8000/market/kline?symbol=600519.SH&interval=1D&count=60" -o kline-1d.json
curl --noproxy '*' -s "http://127.0.0.1:8000/market/kline?symbol=600519.SH&interval=120m&count=12" -o kline-120m.json
curl --noproxy '*' -s "http://127.0.0.1:8000/api/udf/history?symbol=600519.SH&resolution=120&from=1758000000&to=1760000000&countback=12" -o udf-120.json
curl --noproxy '*' -s "http://127.0.0.1:8000/api/udf/history?symbol=600519.SH&resolution=2.5&from=1758000000&to=1760000000" -o udf-bad.json
wc -c kline-2d.json kline-1d.json kline-120m.json udf-120.json udf-bad.json
```

（五条 URL 全部指向 `127.0.0.1:8000`，五条都带 `--noproxy '*'`——少一条就是让回环请求去撞本机代理，读回来的会是 `curl: (7)` 而不是页面真正的答案。`udf-bad.json` 那条用 `resolution=2.5`：它必须**不是**一份 bar，读数里要看得见拒绝。）

- [ ] **Step 3: 读数＋纯函数对账**（同一趟，别分两趟）

```bash
cd /e/Vibe-Trading-main/Vibe-Trading-main/agent
python - <<'PY'
import json, tempfile, pathlib
from datetime import datetime, timezone
from src.api import interval_spec as isp

tmp = pathlib.Path(tempfile.gettempdir()) / "slice5"
def load(name):
    return json.loads((tmp / name).read_text(encoding="utf-8"))

k2d = load("kline-2d.json"); k1d = load("kline-1d.json")
print("2D:", k2d["status"], k2d["interval"], k2d["source"], "bars=", len(k2d["bars"]))
print("1D:", k1d["status"], k1d["interval"], k1d["source"], "bars=", len(k1d["bars"]))
if k1d["status"] == "ok" and k2d["status"] == "ok":
    folded = isp.fold_bars(k1d["bars"], isp.parse_interval("2D"))
    print("fold(1D)->2D bars=", len(folded))
    print("tail-equal:", folded[-len(k2d["bars"]):] == k2d["bars"])
    print("first ts:", k2d["bars"][0]["timestamp"] if k2d["bars"] else None,
          "last ts:", k2d["bars"][-1]["timestamp"] if k2d["bars"] else None)
k120 = load("kline-120m.json")
print("120m:", k120.get("status"), k120.get("interval"), k120.get("source"),
      "bars=", len(k120.get("bars") or []), k120.get("error"))
u120 = load("udf-120.json")
print("udf 120:", u120.get("s"), "t0=", (u120.get("t") or [None])[0],
      "tn=", (u120.get("t") or [None])[-1], "src=", u120.get("source"))
ubad = load("udf-bad.json")
print("udf 2.5:", ubad.get("s"), ubad.get("errmsg"))
PY
```

`fold(1D)->2D` 那条等式**可能天然为假**（两次请求取的日线窗口不同、左缘残组的丢弃规则也不同），读数为 `False` 时不许直接记成缺陷——要按「同一批日线输入」再对账：把 `kline-1d.json` 的 bars 存下来，用 `count` 让 `2D` 的日线走查覆盖同一区间（`_AGG_DAILY_MARGIN` 那条差异在记录里写明），或退一步只断言**首尾时间戳落在纯函数折叠出的组边界上**。判据写在记录里，不写在嘴上。

- [ ] **Step 4: 停进程**（用 Step 1 现读的 PID）

```bash
kill <server_pid>
sleep 1; curl --noproxy '*' -s -o /dev/null -w "%{http_code}\n" --max-time 3 http://127.0.0.1:8000/api/udf/time || echo "down rc=$?"
```

- [ ] **Step 5: 落档**（bytes 层插入 `项目档案.md` §7.29，CRLF 保持）
插入点＝当前**最后一个** `### 7.x` 小节之后、`## 上游同步轮（2026-10-19` 那一行之前（本席 2026-10-19 现读：`## 七、脚本侧审计开工` 在 `:1628`，§7.28 在 `:2102`，`:2129` 已是同步轮那节 ⇒ §7.29 必须插在 `:2129` 之前，不能追加到文件末尾）。配方：

```bash
cd /e/Vibe-Trading-main/Vibe-Trading-main
python - <<'PY'
import pathlib
p = pathlib.Path("项目档案.md")
raw = p.read_bytes()
anchor = "\n## 上游同步轮（2026-10-19".encode("utf-8")
i = raw.index(anchor)          # 唯一命中；多处命中要按行号现读再定
section = """### 7.29 REA 复刻漏斗 L3 第⑤片：服务端自定义倍数档位取数（分支 `feat/l3-slice5-custom-intervals`，基座 `748bec8d`，开工 2026-10-19；设计席＝控制席本人＋计划席＝控制席本人＋实现席若干＋评审席若干＋活体席＝控制席本人）

**(1) 活体探真进程读数（2026-10-19，本机后端真进程，非 TestClient）**

- 命令行逐字：<把 Step 2 的每条 curl 逐字贴进来，一条一行>
- 读数：<kline 2D／1D／120m 与 udf 120／2.5 五条的 status／interval／source／根数／首尾时间戳，逐条列，不许汇总>
- 纯函数对账：<fold(1D)->2D 的比较式与结论，False 的成因按上面那段说明写清>
- 端口与 PID：<实际端口、PID、停机确认的 http_code>
- 限制：<数据源当趟可达／不可达的逐字错误体；空读数照实记「记的是没拿到」，不许升级成结论>
""".replace("\n", "\r\n").encode("utf-8")
p.write_bytes(raw[:i] + section + raw[i:])
PY
python -c "print(open('项目档案.md','rb').read().count(b'\r\n'))"
```

改完复跑读档门（G4 与 G7），并在提交前用 `tr -cd '\r' < 项目档案.md | wc -c` 数 CR（本机 `grep -c $'\r'` 读不出 CR，2026-10-16 实测）。

- [ ] **Step 6: 提交**（只提交档案这一面；`live-probe.md` 留在台账目录，未跟踪）

```bash
cd /e/Vibe-Trading-main/Vibe-Trading-main
git add 项目档案.md
git commit -s -m "$(cat <<'EOF'
docs(archive): §7.29 第⑤片活体读数——自家后端真进程对 2D／120m 两条折叠档的答复

活体落点不在 forensics/l0：那把尺的六枚必填键与 `命令` 的 REA 形状是为浏览器捕获量身判的，
一条 curl 读数放进去三处必红（现读 tools/forensics_audit.py:30/:31/:110-113）。
EOF
)"
```

---

## Task 6: 八道门＋L2 带日期登记＋记忆更正

**Files:**
- Modify: `forensics/gap-matrix.md`（TV-CI-01 行 `:89` 追加登记，状态列 `缺` 不动）
- Modify: `项目档案.md`（§7.29 追加收口段：任务落点、八道门终态读数、两枚恒红门归属）
- Memory: `chart-timeshare-and-coarse-period.md`（折叠面进本仓取数层的事实；不新增文件，索引行不加长）

**Interfaces:**
- Consumes: Task 1-5 的全部落地件。
- Produces: 门禁台账读数＋一条 L2 登记。

- [ ] **Step 1: 八道门逐腿跑，每腿自打 rc**（重定向绝对路径；判据＝每腿标签逐名点齐＋`ALL-LEGS-DONE`）

```bash
cd /e/Vibe-Trading-main/Vibe-Trading-main
LOG=C:/Users/fire/AppData/Local/Temp/slice5/gates
mkdir -p $LOG
( cd frontend && npx tsc -b ) > $LOG/g1-tsc.log 2>&1; echo "G1-tsc rc=$?"
( cd frontend && npx vitest run ) > $LOG/g2-vitest.log 2>&1; echo "G2-vitest rc=$?"
( cd frontend && npx vite build ) > $LOG/g3-build.log 2>&1; echo "G3-build rc=$?"
( cd agent && python ../tools/test_wiki_drift.py ) > $LOG/g4-wiki.log 2>&1; echo "G4-wiki-drift rc=$?"
python tools/forensics_audit.py > $LOG/g5-forensics.log 2>&1; echo "G5-forensics-audit rc=$?"
python tools/test_forensics_spec.py > $LOG/g6-spec.log 2>&1; echo "G6-forensics-spec rc=$?"
bash tools/wiki_freshness_gate.sh > $LOG/g7-water.log 2>&1; echo "G7-water rc=$?"
bash tools/ci_grep_gates.sh > $LOG/g8-grep.log 2>&1; echo "G8-grep rc=$?"
cd agent && python -m pytest tests/test_interval_spec.py tests/test_market_kline_custom_intervals.py tests/test_market_kline_coarse.py tests/test_udf_routes.py -q > $LOG/backend-suites.log 2>&1; echo "BACKEND rc=$?"
echo ALL-LEGS-DONE
```

（`tools/test_wiki_drift.py` 与 `tools/test_forensics_spec.py` 用 `python <路径>` 还是 `pytest <路径>`，以这两个文件自己的 `__main__` 形状为准——动手前先 `tail -5` 读一次，别照抄本行。）

- [ ] **Step 2: 两枚恒红门交归属** —— G7／G8 若红，取「本片跟踪面 0 贡献」证明：先把日志尾行与**动手前的基线日志**逐字节对比（`diff`），再单独证明本片改过的文件不在该腿的命中集里（`grep` 命中的文件名单里逐个不含本片 pathspec）。不许调阈值、不许改门体、不许清白名单既存命中。

- [ ] **Step 3: 后端全量的「本片 0 贡献」证明** —— 同树 before/after：先在动手前的等价树（`git stash` 不行——本支已有提交；用 `git worktree` 或直接以 Task 1 Step 5 那次读数作 before）跑 `python -m pytest tests -q`，after 复跑，两次输出 `diff` 后**合并新红必须为 0 条**；平台性既有红逐条点名，不汇总。

- [ ] **Step 4: L2 追加登记（状态列一个字不改）** —— `forensics/gap-matrix.md:89` 那一行，在最后一个单元格正文末尾（`|` 之前）追加一句：

```markdown
本席 2026-10-19 带日期登记（第⑤片，判态仍 `缺`）：本片只落**服务端取数面**——`agent/src/api/interval_spec.py` 把「基档 × 正整数倍」解析成折叠规格并就地折叠，`/market/kline` 与 `/api/udf/history` 各接一条道（活体读数见 `项目档案.md` §7.29）。本格判据的三样（两级 treegrid 目录、六类分组、Add custom interval 那一行）全是 DOM 面，**一个字节都没动**：`grep -rn --include=*.ts --include=*.tsx -e treegrid -e "Add custom interval" frontend/src` 复跑＝0 命中、rc=1。取数先行不等于逼近判据，第⑥片才做目录 UI。
```

- [ ] **Step 5: 档案追加收口段**（同 §7.29 内、下一条 `## ` 之前，bytes 层）：写任务落点（六枚任务各自提交号，现读 `git log --oneline`）、八道门终态逐腿 rc、后端套件读数、本计划开头那节列出的每一条裁定与偏离（按该节小节标题逐条点名，枚数当场数）。

- [ ] **Step 6: 记忆更正** —— 更新 `C:\Users\fire\.qoder-cn\projects\e--Vibe-Trading-main-Vibe-Trading-main\memory\chart-timeshare-and-coarse-period.md`：加一段「服务端折叠档位（2026-10-19 起）」的事实——基档 × k、分钟族锚在会话内序号（A 股午休不合并）、日线与周月锚在绝对序、两枚 86400 兜底已随派生化消失、`/config` 仍只报八枚。**不新增记忆文件**，`MEMORY.md` 索引行长度不变（该索引已 25373/25000 字节超限）。

- [ ] **Step 7: 提交**

```bash
cd /e/Vibe-Trading-main/Vibe-Trading-main
git add forensics/gap-matrix.md 项目档案.md
git commit -s -m "$(cat <<'EOF'
docs(l3-slice5): L2 带日期登记＋档案 §7.29 收口——取数面先行，TV-CI-01 判态仍「缺」

八道门逐腿终态读数与两枚本机恒红门的「本片 0 贡献」归属一并入账；
本格的三样 DOM 面判据一个字节没动，登记句写清了本片产出与判据的边界。
EOF
)"
git status --porcelain
```

- [ ] **Step 8: 台账** —— 每个任务收尾时在 `.superpowers/sdd/2026-10-19-l3-slice5-custom-intervals/progress.md` 追加一行 `Task <N>: complete — <commit> — <套件读数>`；三条裁定（含 Step 2 变异自证的读数）按 `Ruling: ...` 格式入账。

---

## 收尾（计划外，由 subagent-driven-development 的流程承接）

1. 最终整支评审（最高可用模型），发现项一次修复派发＋一次收窄复评。
2. `superpowers:finishing-a-development-branch`：用户 2026-10-19 已明示「全程自主推进，不需要经过我授权」⇒ 走推荐路径＝**纯快进合入本地 `main` 并推 `origin/main`**；推送前先 `git ls-remote origin main` 对真值（fork 的每日 `Sync upstream` cron 会自己推进远程 main），若远程已前移则先并入再复跑八道门。`--force`、删分支、重写已公开历史**不在授权面内**。
