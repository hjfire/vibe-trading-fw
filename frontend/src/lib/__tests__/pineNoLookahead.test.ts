import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { KLineData } from "klinecharts";

import { compilePine, type PineArtifact } from "../pineScript";
import { inferTimeframeMs } from "../pineResample";
import { toBars, type PineDrawing, type PineLine, type PineMarker, type PineResult } from "../pineTypes";

/**
 * 「前缀 == 全量」重绘守卫 — the machine-checked form of design §10, which is itself
 * the automated version of §12's five-step manual Bar Replay self-check.
 *
 * The claim under test, in one sentence: feeding the interpreter the first `k`
 * bars must produce exactly the first `k` entries of what the full list
 * produces. If any value at bar < k moves when bars are appended, the script
 * (or the engine serving it) read data it could not have had at that bar —
 * a future function / repaint, which is this project's hard rule for trading
 * indicators. Bar Replay is only honest if this sentence holds, so the engine
 * earns a permanent regression gate out of the feature.
 *
 * What this gate does NOT claim: that the engine is look-ahead-free. It is not
 * (see the register below), and the corpus is not either. The gate's claim is
 * narrower and literally true: every difference between the two ways of feeding
 * bars is either (a) named in `LOOKAHEAD_REGISTER`, with the channel and the
 * mechanism, or (b) red. Nothing is averaged, tolerated or skipped.
 *
 * ── Comparison surface (what 逐项相等 means here, and what is left out) ──
 * Compared, index-aligned over bars [0, k), with `na` matching only `na` and
 * numbers matching EXACTLY (a causal recursion replays the same operations in
 * the same order, so any movement is a repaint, not float noise):
 *   · `result.lines[i].values`        — every plotted series, per bar
 *   · `result.markers[i].values / .texts / .up` — plotshape/plotchar families,
 *       all three channels: a shape's price, its label text and its side can
 *       each be driven by a different expression. `up` is compared at every
 *       bar: the engine only writes it where the shape fires and leaves the
 *       initial `true` elsewhere (`pineRuntime.ts:1843,1902`), which is the
 *       same value on both sides of a causal run, so a flip at a bar inside
 *       the window is a real flip.
 *   · `result.hlines`                 — `hline()` records, as an ORDER-PREFIX
 *       check (they are created once, in bar order, deduped by price)
 *   · `result.drawings`               — per kind, see the two drawing rules below
 *   · `result.alerts[i].hits`         — the interpreter's own per-bar alert
 *       verdict, i.e. the exact series the告警桥 reconciles with the backend
 *   · `report.equity / .positions`    — the strategy's per-bar, index-aligned
 *       curves; a decision taken from a future bar moves these at that bar
 *   · structural pins: a prefix run's series must be EXACTLY `k` long (the
 *       over-length tail is the shape a look-ahead leak takes — the same pin
 *       `pinePrefixInvariance.test.ts` calls I-2), and the full run's `TOTAL`.
 *
 * Deliberately NOT compared, each for a stated reason that cannot hide
 * look-ahead in a bar-indexed value:
 *   · `warnings` / `abort` text — diagnostics; they legitimately count a
 *     different number of dropped plots or a different run length, and no bar
 *     reads them as a value.
 *   · figure cosmetics (`PineFigure.color/.type/.title`, `PineLine.color`) —
 *     resolved once from a call site, and a marker's fallback colour is a
 *     MAJORITY OVER THE VALUES ARRAY THIS HARNESS COMPARES, so comparing it
 *     would be redundant at best and false-red at worst.
 *   · `artifact.rows / .figures` keys — the wire form is a pure function of the
 *     channels above plus the bar count, and its keys are POSITIONAL (`p0`,
 *     `s1`…), which the engine's all-`na` plot drop legitimately shifts. The
 *     values underneath the keys are compared at the source channel instead.
 *   · `report.trades` and the report's scalar summary — not bar-indexed: a
 *     position still open at bar k-1 is force-closed at the end of each run, so
 *     the last trade legitimately differs. The per-bar `equity`/`positions`
 *     curves carry the same look-ahead signal at the bar where it happened.
 *   · `table` drawings — a `table` has NO bar anchor at all (corner + cells);
 *     a dashboard rewrites its cells every bar, so "the first k entries" is not
 *     a meaningful projection. Counted and printed (`tables-skipped=`, measured 0
 *     here) so the hole is visible rather than silent; it carries no value onto a
 *     bar.
 *
 * ── Drawing rule 1: the bar-indexed kinds (`bg`, `bar`, `fill`) ──
 * These three are per-bar arrays in the engine (`bgcolor`/`barcolor` write
 * `bgColor[bi]`/`barColor[bi]`, `pineRuntime.ts:1993,2007`; a `fill` band is
 * rebuilt from the two plots' `values[i]`, `pineRuntime.ts:2260-2272`), and the
 * run-merging into `bg` records is a pure function of that array. So the
 * harness EXPANDS the records back to a per-bar projection and compares bars
 * [0, k) strictly — including bar k-1, which the earlier run-record form had
 * to exempt because a run that ends at the cut is still being painted. The
 * projection has no such artefact: what is checked is the colour of a bar the
 * prefix had.
 *
 * ── Drawing rule 2: the object kinds (`label`, `line`, `box`) ──
 * `emitDrawings` walks `drawObjs` (a Map in creation order) and emits ONE
 * record per surviving drawing object — its FINAL state
 * (`pineRuntime.ts:2220-2255`). An object the script mutates across bars
 * (`label.set_xy(l, bar_index, …)`, `if barstate.islast … line.new(…)`)
 * therefore has no bar-indexed value at all: what it emits depends on where
 * the run ENDS, not on which bars it read. `label[59]` in the k=60 run and
 * `label[299]` in the full run are the same object at two different ends of
 * the same mutation sequence, and neither one is "the value at bar 59". The
 * harness detects this from behaviour, never from a filename list: for every
 * object identity (kind + creation-order index) it walks ALL SIX runs
 * (k=60/120/180/240/299 and the full 300) and calls the record *run-end
 * dependent* when its content varies across runs, or when it exists in a
 * shorter run but not in the full one (deleted later). Those records are
 * counted (`live-objects=`), printed per script, and excluded from the content
 * comparison — the same honest treatment `table` gets, for the same reason.
 * What stays strict for those scripts is everything else, at zero tolerance:
 * every series, marker, hline, alert and strategy curve. A look-ahead that
 * only ever shows up in a mutable label would be invisible to this harness and
 * to Bar Replay alike — the chart's price data, and what replay steps through,
 * are the series.
 * Records that are frozen across all six runs are compared by content like
 * anything else, and records created after the cut are counted, not compared.
 *
 * ── Matching across the two runs ──
 * `build()` drops plots and markers that are all-`na` over the whole run
 * (`pineRuntime.ts:2413,2424`), so a 200-bar-length indicator legitimately has
 * no line at all in the k=60 run. Records are therefore matched by a call-site
 * signature (line name/style/offset/baseline, marker name, alert `fn@source
 * line`, fill colour/alpha) and, inside each signature group, PAIRED IN
 * CREATION ORDER by requiring the window slices to be exactly equal — a
 * positional zip would cross-match two call sites that share a signature the
 * moment one of them is dropped in the prefix run, which manufactures defects
 * that do not exist. A record present only in the FULL run is legal exactly
 * when its window slice carries no value (all `na`, or no alert `hits`); if it
 * has one, future bars conjured a value at bar < k — that is the defect this
 * gate exists to catch, and it is reported, not tolerated.
 *
 * ── Buckets ──
 *   · `failed`  — the FULL run returned `{ error }` (parse/compile failure or
 *     no output). `compilePine` reports those as values, not throws
 *     (`pineScript.ts:181-194`), so they cannot crash the harness and are not
 *     silently counted as passes: they are counted, printed, and excluded from
 *     the comparison because there is nothing to compare.
 *   · `aborted` — the full run stopped mid-list (`artifact.abort`); still
 *     compared, because bars after the abort are `na` on both sides.
 *   · `mtf`     — source calls `request.security*` / legacy `security(`, or the
 *     run reported `lowerTfMs`. Graded with the SAME zero tolerance as `plain`;
 *     the measured justification is in the MTF finding below.
 *   · `plain`   — everything that ran and is not MTF.
 *   · `crashed` — the harness itself threw for this script. Must be 0.
 *
 * ── MTF (Step 4's measurement, and the floor it earned) ──
 * MEASURED 2026-10-07 over the real corpus (210 `.pine` files, k ∈ {60,120,
 * 180,240,299}): the HTF sequence is NOT a pre-built array independent of the
 * input — `doSecurity` calls `resampleUp(this.bars, targetMs)`
 * (`pineRuntime.ts:1392`) on the bars the run was given, so truncating the
 * input truncates the HTF side with it, and with `barmerge.lookahead_off` the
 * value read is `chartToHtf[bi] - 1`, i.e. the last COMPLETED HTF bucket, which
 * only depends on bars at or before `bi`. Measured outcome across 7 MTF scripts
 * and 35 (script, k) pairs: exactly ONE MTF script mismatches
 * (`statistics/us_treasury_yields.pine`), and none of its differences come
 * from the security path — every one of them is a bar whose value was written
 * by a LATER source bar through a negative plot `offset` (see the register),
 * which is the same mechanism the three plain mismatches have.
 * What the other six do on these bars was then checked one file at a time, and
 * the honest answer is narrower than the sentence this paragraph used to carry:
 * only `research/chart_type_identifier.pine` really rolls up (it asks `"M"` and
 * `"W"` on this daily frame, so `resampleUp` answers) — and its entire output is
 * ONE `label`, the record drawing rule 2 excludes and the run prints as excluded
 * (`live: research/chart_type_identifier.pine label|0`): it emits no line, no
 * marker and no hline at all, so no HTF-derived value reaches a compared channel
 * where it could be wrong. The other five never get to a rollup:
 * `volatility/mayer_multiple.pine` and
 * `statistics/kendall_rank_correlation_coefficient.pine` read a bare `period`
 * this engine has no such builtin for, so both stop at bar 1 — they ARE the two
 * `aborted` files in the buckets line, and an aborted run is evidence about the
 * abort path, not about MTF; `statistics/bitcoin_ath_hash_rate_level.pine`,
 * `statistics/dividends_per_share_dps_yearly.pine` and
 * `statistics/earnings_per_share_eps_yearly.pine` ask `"D"` against a daily
 * chart, which is declined exactly like `us_treasury_yields`' own-timeframe call
 * below. So `mtf=1` means: no difference was ever OBSERVED on the security path,
 * and on this corpus none could have been WITNESSED either — no script carries a
 * future HTF value into a compared channel. The truncation-synchronised reading
 * above is therefore an argument from the engine's own code
 * (`resampleUp(this.bars, targetMs)`, `pineRuntime.ts:1392`, re-resampled per
 * run) plus zero observed differences, NOT a measured HTF invariance, and it is
 * written down at that strength on purpose: a corpus that grows a real HTF plot
 * is what would turn this section into a measurement, and when it does the script
 * either passes or goes red, because the bucket grants nothing.
 * The floor for this bucket is therefore the same as for `plain`: 0 outside the
 * register, with 摘出 not on offer for anybody, so an MTF script that starts
 * reading a still-forming (or future) HTF bucket goes red instead of being
 * excused — and that is not a hope, it is one of the three canaries proven below
 * (③ deletes this script's register row and the run names it while red).
 * `lookahead_on` is the one form that legitimately differs (it reads the
 * FORMING bucket, whose aggregate grows with later bars). The corpus has
 * exactly one script that passes it — `statistics/us_treasury_yields.pine:14`
 * (`security(sym, timeframe.period, close, barmerge.gaps_off,
 * barmerge.lookahead_on)`) — and there it is inert for a reason worth knowing:
 * it asks for the chart's OWN timeframe, so `resampleUp` declines (`not a
 * rollup`) and the expression is evaluated on the chart frame
 * (`pineRuntime.ts:1381,1393`), where `lookahead` never enters. The same
 * `lookahead=true` idiom appears in `statistics/dividends_per_share_dps_
 * yearly.pine:19-20` and `statistics/earnings_per_share_eps_yearly.pine:19-20`
 * against `"D"` on this daily harness, so it is declined the same way. That
 * leaves no corpus script that reads a forming HTF bucket, so nothing gets a
 * tolerance for it — if one appears, it appears as a mismatch and is argued
 * about, not pre-approved.
 *
 * ── The register: what is genuinely prefix ≠ full today ──
 * Four scripts differ between the two feeding styles in a way that is NOT a
 * modelling artefact of this harness. The facility is `plot(series, offset=-N)`:
 * the engine writes `line.values[this.bi + offset]` (`pineRuntime.ts:1828-1831`),
 * so with a negative offset the value DRAWN at bar `i` is the value COMPUTED at
 * bar `i + N`. Inside a window ending at `k` the last `N` bars of such a series
 * can only be filled by source bars `k … k+N-1`, which the prefix run never
 * received: MEASURED 2026-10-07, all 986 differences of those four files satisfy
 * `offset < 0`, `bar < k` and `srcBar = bar - offset >= k`, and the shallow ones
 * sit exactly at bar `k + offset` (`前缀=na 全量=<source bar k 的值>`). The gate
 * re-measures that predicate on every run, so a register row cannot quietly start
 * hiding a DIFFERENT mechanism: a mismatch whose numbers were not produced at a
 * bar at or after `k` fails the mechanism assertion instead of passing on the
 * strength of the row.
 * Per §12 step 3 that is 「提前 N 根出值」 — the column the chart shows at bar i
 * stands for data from bar i+N — so it is look-ahead by this project's own hard
 * rule, and it is exactly what Bar Replay must not pretend to know at the
 * cursor. These are distributions/dashboards, not entry signals, and the fix
 * belongs to the engine or to the scripts, not to this gate: this plan does not
 * touch `pineRuntime.ts`, so they are measured, named, registered and left red
 * for whoever owns the fix.
 *   · `statistics/bullish_bearish_candle_series_distribution.pine` — 458 diffs,
 *     measured offsets −5 … −285 (space=5, one column per series length)
 *   · `statistics/close_to_close_percent_change_distribution.pine` — 423 diffs,
 *     offsets −4 … −192 (space=4, one column per percent-change bucket)
 *   · `statistics/ticker_performance_by_us_president.pine` — 8 diffs, offset −150
 *     only (space=150). The deeper columns of that file would reach −3450, but a
 *     column that deep writes nothing at `bi-150·n < 0` over 300 bars, so `build()`
 *     drops it on BOTH sides and nothing there is compared — recorded here so this
 *     row is never read as full coverage of the file.
 *   · `statistics/us_treasury_yields.pine` — 97 diffs, offsets −8 … −80
 *     (space=8; the one MTF script in the register)
 * Measured 最大提前根数 (`srcBar - k`) across those 986 diffs: 0 … 225 — the worst
 * case is bar 0 of a −285 column, whose number comes from bar 285 while the window
 * stopped at bar 60.
 * Note `plotshape(..., offset=…)` does NOT reach the marker arrays
 * (`doShape` writes `marker.values[this.bi]`, `pineRuntime.ts:1900`), so the
 * same scripts shift their plots but not their shapes; that is an engine
 * fidelity gap, recorded here because it changes which channel goes red.
 *
 * The register is asserted BOTH WAYS: every observed mismatch must be listed,
 * and every listed entry must still be observed. A script that starts
 * mismatching goes red, and a script that gets fixed also goes red until
 * somebody shrinks the register, so the list cannot silently rot in either
 * direction. Everything outside it keeps zero tolerance in both buckets.
 * `statistics/dividends_per_share_dps_yearly.pine` and
 * `statistics/earnings_per_share_eps_yearly.pine` use the same negative-offset
 * idiom (`space = 8`, columns at `offset = (-i * space)`, i = 1 … 20) but are NOT
 * in the register, because on these bars their SHIFTED columns never write at
 * all: each one's target is `year - i` compared against the BAR's own `year` (a
 * date builtin here, `pineRuntime.ts:133`), so `year == year - i` holds for no
 * bar when i ≥ 1 and only `i = 0` — the column at `offset = 0`, which has nothing
 * to look ahead with — ever leaves `na`. The −8…−160 columns are `na` over the
 * whole run and `build()` drops them on BOTH sides; the engine's own warning for
 * each of the two files says it: 「20 条 plot 全区间无数据，已隐藏」.
 * They are NOT `na`-only scripts, though — the measured run puts both in the
 * informative 191, not in the printed 15 (that list is built in sorted file
 * order, and both names sort ahead of position 10,
 * `statistics/gaps_percent_size_distribution.pine`, which IS printed, so their
 * absence from it is what proves they were informative). Nothing is being waved
 * through a vacuous pass: their offset-0 series really was compared bar for bar,
 * and it is only the shifted columns that carry no value on these 300 bars. They
 * enter the register the moment one of them does.
 *
 * ── Missing input is an incident, never a skip ──
 * The corpus is local-only (`frontend/.gitignore:9`), like
 * `pineAlertCorpus.test.ts`, and this file takes the same discipline as that
 * harness: a walk that finds fewer than 100 scripts THROWS. There is no
 * `describe.skipIf` and no early return, because a guard that compares nothing
 * passes, and a guard that cannot fail is worse than no guard. Its red capability
 * was proven before its floors were trusted, three ways, on 2026-10-07 against
 * this file and this corpus — baseline green FIRST so any red below is
 * attributable to the edit and not to the machine (`scripts=210 passed=206
 * mismatched=4 crashed=0`, rc=0, 23.5s of comparing). Each edit then went red,
 * was reverted, and printed those same numbers again:
 *   · ① the window itself — `cmpNumbers`' per-bar loop walked `i <= k` instead of
 *     `i < k`, comparing the first `k+1` entries instead of the first `k` (the
 *     shift, not the tolerance, is what this gate exists to catch). RED, rc=1:
 *     `passed` 206 → 18, `mismatched` 4 → 192, `diffs collected=2624`, and every
 *     fresh diff spells the off-by-one out — `line 系列2#0：第 60 根 前缀=缺项
 *     全量=0`, a bar the prefix was never fed. The first `expect` to fire was the
 *     informativeness floor (「真有值在比的脚本数（实测 191）」: expected 3 to be
 *     greater than or equal to 180), because a note returns before any value of
 *     that series counts as compared; the ledger had 188 unregistered files to
 *     name as well and said so on the wall before any assertion ran
 *     (`mismatched: plain=188 mtf=4 register=192`), and the mechanism guard
 *     printed 违例=192 — a diff that is not the registered negative-offset branch
 *     cannot hide behind a row either.
 *   · ② the stale-row direction — a 5th `LOOKAHEAD_REGISTER` row pointing at
 *     `statistics/z_score.pine`, a file that does NOT mismatch. RED, rc=1, at
 *     `expect(stale, …).toEqual([])`, and the message names the offending row:
 *     「登记在册却没有再出现前缀≠全量」: expected [] / received
 *     ['statistics/z_score.pine']. The readout stayed `mismatched=4 passed=206`
 *     throughout — the row hid nothing, it only lied, and the gate reds a lie.
 *   · ③ the unregistered direction — deleting the `us_treasury_yields.pine` row.
 *     RED, rc=1, at `expect(unregistered, …).toEqual([])`: 「未登记的前缀≠全量」
 *     receiving ['statistics/us_treasury_yields.pine'] with three of that file's
 *     real `[mtf]` diff lines printed under it (offset=-8，第 52 根起分叉：
 *     前缀=na 全量=150.2017…). This is the one that proves the MTF bucket above is
 *     zero tolerance and not an exemption: strip its row and an MTF script goes
 *     red exactly like a plain one.
 * After every revert the harness file was byte-identical to the pre-canary
 * snapshot again (`diff` empty, md5 unchanged) before the next edit, so the three
 * proofs are independent of each other. The printed `[no-lookahead]` block is the
 * evidence each edit leaves behind, and all three are re-runnable against this
 * file as shipped — they are a record of runs, not a claim about one.
 */

const CORPUS_DIR = resolve(
  process.cwd(),
  process.env.PINE_CORPUS_DIR || "src/lib/__tests__/__fixtures__/corpus",
);

const TOTAL = 300;
const KS = [60, 120, 180, 240, 299];
const DAY_MS = 86_400_000;
/** 2023-01-02T00:00:00Z — a Monday, so the weekend holes below are real. */
const START_TS = 1672617600000;

/** `request.security` / `request.security_lower_tf` / legacy v3 `security(`. */
const MTF_RE = /(^|[^\w.])(request\.security[a-z_]*|security)\s*\(/;

/**
 * Measured look-ahead register — see the header. `family` is the corpus
 * directory, `script` its file name, `channel` the compared surface the
 * difference shows up on, `mechanism` the engine facility that allows it.
 */
interface LookaheadEntry {
  readonly family: string;
  readonly script: string;
  readonly channel: string;
  readonly mechanism: string;
}

const LOOKAHEAD_REGISTER: readonly LookaheadEntry[] = [
  {
    family: "statistics",
    script: "bullish_bearish_candle_series_distribution.pine",
    channel: "line",
    mechanism:
      "plot(seriesN, offset=(-N*space))，space=5：引擎写 values[bi+offset]（pineRuntime.ts:1828-1831），" +
      "实测 458 条差异全落在 offset −5…−285 的那些列，分叉点正是 k+offset，值取自 ≥k 的源 bar",
  },
  {
    family: "statistics",
    script: "close_to_close_percent_change_distribution.pine",
    channel: "line",
    mechanism:
      "同上，space=4：实测 423 条差异、offset −4…−192 —— 直方图把 N 根之后才算出的分桶计数画到左边 N 列上",
  },
  {
    family: "statistics",
    script: "ticker_performance_by_us_president.pine",
    channel: "line",
    mechanism:
      "offset 按总统一任任往累减 space=150：实测 8 条差异全部来自 -150 那列（'Joe Biden'），" +
      "k≤150 的前缀里那条线整条为 na 被 build() 摘掉，全量却在第 0 根画出第 150 根的值",
  },
  {
    family: "statistics",
    script: "us_treasury_yields.pine",
    channel: "line",
    mechanism:
      "plot(security(...), offset=(-N*space))，space=8：实测 97 条差异、offset −8…−80。它的 security() 要的是" +
      "图表自身周期，resampleUp 拒滚（pineRuntime.ts:1380）→ 退回本帧求值，lookahead_on 因此是惰性的，" +
      "差异与多周期通道无关",
  },
];

const registerKey = (e: { family: string; script: string }) => `${e.family}/${e.script}`;
const REGISTER_KEYS: readonly string[] = LOOKAHEAD_REGISTER.map(registerKey).sort();

function pineFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...pineFiles(abs));
    else if (entry.name.endsWith(".pine")) out.push(abs);
  }
  return out.sort();
}

/**
 * 300 synthetic daily bars: trend in both directions, real weekend holes, an
 * independent wick on every bar and a跳空 every 41 bars. Millisecond
 * timestamps, like the rest of the page (no `*1000` anywhere in this file).
 *
 * Why each feature is load-bearing rather than decorative:
 *   · weekend holes — `inferTimeframeMs` answers the MEDIAN delta, so the holes
 *     must exist and must not swamp the median; the weekly/monthly rollups that
 *     `request.security` sizes off it only happen when the chart period is
 *     inferred correctly (Step 4 is a measurement, not an assumption).
 *   · independent wicks — tying high/low to the adjacent closes makes a strict
 *     local extremum impossible, so pivot/fractal/zigzag scripts never fire and
 *     the harness would compare `na` against `na` (the vacuous-pass shape this
 *     repo has been burned by; see `pineCorpusReport.test.ts:40-47`).
 *   · 跳空 — gap-sensitive scripts (`ta.gap`-style windows, `high[1] < low`)
 *     get a non-degenerate input.
 *   · trend regimes — crossover/signal scripts actually produce hits.
 */
function makeBars(n: number): KLineData[] {
  let seed = 20261006;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const out: KLineData[] = [];
  let price = 120;
  let ts = START_TS;
  for (let i = 0; i < n; i++) {
    const dow = new Date(ts).getUTCDay();
    if (dow === 6) ts += 2 * DAY_MS; // Saturday → Monday
    else if (dow === 0) ts += DAY_MS; // Sunday → Monday
    const drift = Math.sin(i / 23) * 0.004 + 0.0006;
    const shock = (rand() - 0.5) * 0.03;
    const gap =
      i > 0 && i % 41 === 0 ? (rand() < 0.5 ? -1 : 1) * (0.025 + rand() * 0.035) : 0;
    const open = price * (1 + gap);
    const close = open * (1 + drift + shock);
    const high = Math.max(open, close) * (1 + 0.002 + rand() * 0.02);
    const low = Math.min(open, close) * (1 - 0.002 - rand() * 0.02);
    out.push({
      timestamp: ts,
      open,
      high,
      low,
      close,
      volume: 800 + Math.floor(rand() * 1200),
      turnover: 0,
    } as KLineData);
    price = close;
    ts += DAY_MS;
  }
  return out;
}

const BARS = makeBars(TOTAL);

/* ------------------------------------------------------------ comparison */

/** Per-(script, k) evaluation state: what was compared and how it went wrong. */
interface Sink {
  readonly rel: string;
  readonly k: number;
  /** At least one FINITE value (or `true` hit / frozen drawing / non-default flag) was compared. */
  informative: boolean;
  /** Every difference found for this script, across all its probe lengths. */
  readonly diffs: string[];
  /** Structured record of every line-channel difference, for the mechanism check. */
  mech?: (h: MechHit) => void;
}

/**
 * A line-channel difference, measured rather than described: `offset` is the
 * plot's own offset, `bar` the first bar below `k` where the two runs disagree
 * (or, for a line the short run never produced, the bar of the value the long
 * run produced), and `srcBar = bar - offset` the bar whose data produced that
 * value. `plot(v, offset=-N)` writes bar `i` from bar `i+N`, so `srcBar >= k`
 * says it exactly: the full run shows, below bar `k`, a number computed at a bar
 * the prefix did not have. That is §12 step 3's 提前 N 根出值.
 */
interface MechHit {
  readonly shape: "line-diverges" | "line-not-in-prefix";
  readonly k: number;
  readonly offset: number;
  readonly bar: number;
  readonly srcBar: number;
}

function note(s: Sink, msg: string): void {
  // No cap here on purpose: a capped collector would feed a capped
  // classification, and the floors below assert on the FULL list.
  s.diffs.push(`k=${s.k} ${s.rel} — ${msg}`);
}

function fmt(v: number | undefined): string {
  if (v === undefined) return "缺项";
  return Number.isNaN(v) ? "na" : String(v);
}

/**
 * The shape of a diff: every number collapsed to `N`, every quoted series name
 * collapsed to `X`. Two diffs share a shape when the same channel, the same
 * matcher branch and the same bucket produced them, so a shape histogram says
 * what KIND of difference a script has — which is what the classification below
 * is made of. Raw diffs are printed as well; the histogram never replaces them.
 */
function shapeOf(msg: string): string {
  return msg.replace(/「[^」]*」/g, "「X」").replace(/-?\d+(?:\.\d+)?/g, "N");
}

interface Counts {
  /** Number series (line / marker channel / alert hits) actually walked. */
  series: number;
  /** Individual bar-indexed values walked inside those series. */
  values: number;
  /** Full-run-only records whose window slice carried nothing (all-`na` series, never-fired alert): the legal warm-up drop. */
  naDropped: number;
  /** `table` drawings skipped (no bar anchor to window). */
  tables: number;
  /** Drawing records compared on the strict rule (bar-indexed + frozen objects). */
  drawings: number;
  /** Object drawings excluded as run-end dependent (see drawing rule 2). */
  live: number;
  /** Object drawings created at or after the cut (nothing in the window to check). */
  afterCut: number;
  /** hline records compared. */
  hlines: number;
}

function groupBy<T>(items: readonly T[], key: (t: T) => string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const it of items) {
    const k = key(it);
    const bucket = out.get(k);
    if (bucket) bucket.push(it);
    else out.set(k, [it]);
  }
  return out;
}

/** Number series, bars [0, k): `na` matches only `na`, numbers exactly. */
function cmpNumbers(s: Sink, path: string, p: number[], f: number[], k: number, c: Counts): void {
  if (p.length !== k) {
    note(s, `${path}：前缀序列长度 ${p.length}，应为 ${k}（超长的尾巴正是未来数据的形状）`);
    return;
  }
  if (f.length !== TOTAL) {
    note(s, `${path}：全量序列长度 ${f.length}，应为 ${TOTAL}`);
    return;
  }
  c.series += 1;
  c.values += k;
  for (let i = 0; i < k; i++) {
    const a = p[i];
    const b = f[i];
    if (Number.isNaN(a) && Number.isNaN(b)) continue;
    if (Number.isNaN(a) !== Number.isNaN(b) || a !== b) {
      note(s, `${path}：第 ${i} 根 前缀=${fmt(a)} 全量=${fmt(b)}`);
      return;
    }
    if (Number.isFinite(a)) s.informative = true;
  }
}

/** Text / boolean series channel, same exactness rule. */
function cmpSeries<T>(
  s: Sink,
  path: string,
  p: T[],
  f: T[],
  k: number,
  c: Counts,
  same: (a: T, b: T) => boolean,
  informative: (a: T) => boolean,
): void {
  if (p.length !== k || f.length !== TOTAL) {
    note(s, `${path} 长度 ${p.length}/${f.length} 不为 ${k}/${TOTAL}`);
    return;
  }
  c.series += 1;
  c.values += k;
  for (let i = 0; i < k; i++) {
    if (!same(p[i], f[i])) {
      note(s, `${path} 第 ${i} 根 前缀=${String(p[i])} 全量=${String(f[i])}`);
      return;
    }
    if (informative(p[i])) s.informative = true;
  }
}

function lineSig(l: PineLine): string {
  return `${l.name}\u0000${l.style}\u0000${l.offset}\u0000${l.baseValue === undefined ? "" : l.baseValue}`;
}

function sigName(sig: string): string {
  return sig.split("\u0000")[0] || "（无名）";
}

/**
 * Pair the records of one signature group in creation order.
 *
 * `equal` is the strict window comparison itself, so a pair exists only when the
 * two records are literally the same over the bars the prefix had — this aligns
 * records, it never loosens them. Full-run records left over are the warm-up
 * drops (`isEmpty`) or the defect (`未来 bar 让 bar<k 出值`), and prefix records
 * left over are a difference no full-run record explains.
 */
function pairGroup<J>(
  ps: J[],
  fs: J[],
  equal: (a: J, b: J) => boolean,
  isEmpty: (j: J) => boolean,
): { pairs: [J, J][]; onlyPrefix: J[]; onlyFullNonEmpty: J[]; droppedFull: number } {
  const pairs: [J, J][] = [];
  const open = ps.slice();
  const droppedFull: J[] = [];
  const keptFull: J[] = [];
  for (const f of fs) {
    const at = open.findIndex((p) => equal(p, f));
    if (at >= 0) {
      pairs.push([open[at], f]);
      open.splice(at, 1);
    } else if (isEmpty(f)) droppedFull.push(f);
    else keptFull.push(f);
  }
  return { pairs, onlyPrefix: open, onlyFullNonEmpty: keptFull, droppedFull: droppedFull.length };
}

function cmpLines(s: Sink, p: PineLine[], f: PineLine[], k: number, c: Counts): void {
  const pg = groupBy(p, lineSig);
  const fg = groupBy(f, lineSig);
  // `pairGroup`'s 4th predicate is the LEGAL drop test, so it must be "the window
  // carries nothing", not its opposite. (Getting this backwards reports every
  // warm-up-only line as a look-ahead — a manufactured defect, not a real one.)
  const windowEmpty = (l: PineLine) => !l.values.slice(0, k).some((v) => !Number.isNaN(v));
  const equalSlices = (a: PineLine, b: PineLine) => {
    for (let i = 0; i < k; i++) {
      const x = a.values[i];
      const y = b.values[i];
      if (Number.isNaN(x) && Number.isNaN(y)) continue;
      if (Number.isNaN(x) !== Number.isNaN(y) || x !== y) return false;
    }
    return true;
  };
  // The bar that only exists once the later bars are fed: the first bar below k
  // where the longer run carries a value and NO prefix record of the same
  // call-site signature does. -1 means the two runs disagree on a VALUE at a bar
  // both had — this harness has no mechanism claim for that, and says so.
  const conjuredBar = (b: PineLine, others: PineLine[]): number => {
    for (let i = 0; i < k; i++) {
      if (Number.isNaN(b.values[i])) continue;
      if (others.some((p) => !Number.isNaN(p.values[i]))) continue;
      return i;
    }
    return -1;
  };
  for (const [sig, ps] of pg) {
    const fs = fg.get(sig) ?? [];
    const m = pairGroup(ps, fs, equalSlices, windowEmpty);
    for (const [i, [a, b]] of m.pairs.entries()) cmpNumbers(s, `line ${sigName(sig)}#${i}`, a.values, b.values, k, c);
    c.naDropped += m.droppedFull;
    for (const a of m.onlyPrefix) {
      // Nothing in the full run reproduces this window slice: the prefix drew a
      // value the longer run no longer has, at a bar the longer run also had.
      // With one record per side the peer is unambiguous and the bar the two runs
      // first disagree at is the evidence for the mechanism (`plot(v, offset=-N)`
      // writes bar i from bar i+N, so a run of length k shows bar k-N's number at
      // bar k-1). Records of one signature group share `offset` by construction
      // (it is part of the signature), so the arithmetic holds even when the peer
      // choice is ambiguous; only the printed bar is then omitted.
      const peer = fs.length ? firstDiff(a.values, fs[0].values, k) : -1;
      const bar = peer >= 0 ? peer : a.values.slice(0, k).findIndex((v) => !Number.isNaN(v));
      s.mech?.({ shape: "line-diverges", k, offset: a.offset, bar, srcBar: bar - a.offset });
      note(
        s,
        `line「${sigName(sig)}」前缀里的这条线在全量里找不到同窗口的对应（条数 前缀=${ps.length} 全量=${fs.length}，` +
          `offset=${a.offset}，第 ${bar} 根起分叉：前缀=${fmt(a.values[bar])} 全量=${fmt(fs[0]?.values[bar])}，` +
          `全量那一根的值是第 ${bar - a.offset} 根算出来的）`,
      );
    }
  }
  for (const [sig, fs] of fg) {
    const ps = pg.get(sig) ?? [];
    const m = pairGroup(ps, fs, equalSlices, windowEmpty);
    for (const b of m.onlyFullNonEmpty) {
      const bar = conjuredBar(b, ps);
      const at = b.values.slice(0, k).findIndex((v) => !Number.isNaN(v));
      s.mech?.({ shape: "line-not-in-prefix", k, offset: b.offset, bar, srcBar: bar - b.offset });
      note(
        s,
        bar >= 0
          ? `line「${sigName(sig)}」全量在第 ${bar} 根有值 ${fmt(b.values[bar])}，前缀里同签名的 ${ps.length} 条线在那根都没有值` +
            `（offset=${b.offset}，这个值是全量在第 ${bar - b.offset} 根算出来的，未来 bar 让 bar<${k} 出值）`
          : `line「${sigName(sig)}」前缀里没有同窗口的这条线，且窗口内每个有值的 bar 前缀同签名线也有值（offset=${b.offset}，` +
            `第 ${at} 根 = ${fmt(b.values[at])}）——不是「晚出值」这条路，机制未知`,
      );
    }
  }
}

function firstDiff(a: number[], b: number[], k: number): number {
  for (let i = 0; i < k; i++) {
    const x = a[i];
    const y = b[i];
    if (Number.isNaN(x) && Number.isNaN(y)) continue;
    if (Number.isNaN(x) !== Number.isNaN(y) || x !== y) return i;
  }
  return -1;
}

function cmpMarkers(s: Sink, p: PineMarker[], f: PineMarker[], k: number, c: Counts): void {
  const pg = groupBy(p, (m) => m.name);
  const fg = groupBy(f, (m) => m.name);
  const equalSlice = (a: PineMarker, b: PineMarker) => firstDiff(a.values, b.values, k) < 0;
  const windowEmpty = (m: PineMarker) => !m.values.slice(0, k).some((v) => !Number.isNaN(v));
  for (const [name, ps] of pg) {
    const fs = fg.get(name) ?? [];
    const m = pairGroup(ps, fs, equalSlice, windowEmpty);
    for (const [i, [a, b]] of m.pairs.entries()) {
      cmpNumbers(s, `marker ${name}#${i} 价位`, a.values, b.values, k, c);
      cmpSeries(s, `marker ${name}#${i} 文字`, a.texts, b.texts, k, c, (x, y) => x === y, (x) => x !== "");
      cmpSeries(s, `marker ${name}#${i} 上下方`, a.up, b.up, k, c, (x, y) => x === y, () => false);
    }
    c.naDropped += m.droppedFull;
    for (const a of m.onlyPrefix) {
      const at = a.values.slice(0, k).findIndex((v) => !Number.isNaN(v));
      note(
        s,
        `marker「${name}」前缀里的这个标记在全量里找不到同窗口的对应（前缀 ${ps.length} 个 / 全量 ${fs.length} 个，` +
          `前缀第 ${at} 根 = ${fmt(a.values[at])}）`,
      );
    }
  }
  for (const [name, fs] of fg) {
    const ps = pg.get(name) ?? [];
    const m = pairGroup(ps, fs, equalSlice, windowEmpty);
    for (const b of m.onlyFullNonEmpty) {
      const at = b.values.slice(0, k).findIndex((v) => !Number.isNaN(v));
      note(s, `marker「${name}」前缀里没有，但全量在第 ${at} 根标了 ${fmt(b.values[at])}`);
    }
  }
}

/**
 * `hline()` records: created once per distinct price, in bar order, so the
 * prefix list must be an ORDER-PREFIX of the full list. A price that differs at
 * an index below the prefix's own count means the level was computed from data
 * the prefix did not have.
 */
function cmpHlines(s: Sink, p: PineResult["hlines"], f: PineResult["hlines"], c: Counts): void {
  if (p.length > f.length) {
    note(s, `hline 条数 前缀=${p.length} > 全量=${f.length}（多喂 bar 反而少一条参考线）`);
  }
  for (let i = 0; i < Math.min(p.length, f.length); i++) {
    c.hlines += 1;
    if (p[i].price !== f[i].price) {
      note(s, `hline#${i}「${p[i].title}」价位 前缀=${fmt(p[i].price)} 全量=${fmt(f[i].price)}`);
    } else if (p[i].title !== f[i].title) {
      note(s, `hline#${i} 标题 前缀="${p[i].title}" 全量="${f[i].title}"`);
    } else {
      s.informative = true;
    }
  }
}

type Draw = PineDrawing;
type Fill = Extract<Draw, { kind: "fill" }>;
type Alert = NonNullable<PineResult["alerts"]>[number];

/** A record rendered comparable: kind + every field, `na` spelled `na`. */
function drawKey(d: Draw): string {
  const num = (v: number | undefined) => (v === undefined ? "-" : fmt(v));
  switch (d.kind) {
    case "bg":
      return `bg|${d.color}|${d.alpha}|${d.startBar}|${d.endBar}`;
    case "bar":
      return `bar|${d.color}|${d.alpha}|${d.bar}`;
    case "label":
      return `label|${d.bar}|${num(d.price)}|${d.text}|${d.bg ?? ""}|${d.fg ?? ""}`;
    case "box":
      return `box|${num(d.x1)}|${num(d.y1)}|${num(d.x2)}|${num(d.y2)}|${d.border ?? ""}|${d.bg ?? ""}`;
    case "line":
      return `line|${num(d.x1)}|${num(d.y1)}|${num(d.x2)}|${num(d.y2)}|${d.color ?? ""}|${num(d.width)}|${d.dashed ? 1 : 0}`;
    case "table":
      return `table|${d.corner}|${d.cells.map((x) => `${x.row},${x.col},${x.text}`).join(";")}`;
    case "fill":
      return `fill|${d.color}|${d.alpha}|${d.pts.map((x) => `${x.bar}:${fmt(x.top)}:${fmt(x.bottom)}`).join(";")}`;
  }
}

const OBJECT_KINDS: Draw["kind"][] = ["label", "line", "box"];

/**
 * Which object drawings are run-end dependent, measured over ALL runs of one
 * script (the five prefixes plus the full one). Key is `kind|identity`, the
 * value the measured reason. See drawing rule 2 in the header.
 */
function measureObjectLiveness(results: PineResult[]): Map<string, string> {
  const live = new Map<string, string>();
  for (const kind of OBJECT_KINDS) {
    const lists = results.map((r) => r.drawings.filter((d) => d.kind === kind));
    const widest = Math.max(0, ...lists.map((l) => l.length));
    for (let i = 0; i < widest; i++) {
      const states = lists.map((l) => (i < l.length ? drawKey(l[i]) : undefined));
      const seen = states.filter((x): x is string => x !== undefined);
      const distinct = new Set(seen).size;
      const inFull = states[states.length - 1] !== undefined;
      if (distinct > 1) {
        live.set(
          `${kind}|${i}`,
          `${distinct} 种喂法给出 ${distinct} 种状态（对象随喂到第几根而变，前 k 项投影不存在）`,
        );
      } else if (!inFull) {
        live.set(`${kind}|${i}`, `较短的喂法里有、全量里没有（对象在更晚的 bar 被删掉或重建）`);
      }
    }
  }
  return live;
}

/** Per-bar colour projection of the `bg` / `bar` records a run emitted. */
function colourPerBar(list: Draw[], k: number): (string | null)[] {
  const out: (string | null)[] = new Array<string | null>(k).fill(null);
  for (const d of list) {
    if (d.kind === "bg") {
      const tag = `${d.color}|${d.alpha}`;
      for (let i = d.startBar; i <= d.endBar && i < k; i++) out[i] = tag;
    } else if (d.kind === "bar" && d.bar < k) {
      out[d.bar] = `${d.color}|${d.alpha}`;
    }
  }
  return out;
}

function cmpBarIndexedDrawings(s: Sink, p: Draw[], f: Draw[], k: number, c: Counts): void {
  for (const kind of ["bg", "bar"] as const) {
    const ps = p.filter((d) => d.kind === kind);
    const fs = f.filter((d) => d.kind === kind);
    if (!ps.length && !fs.length) continue;
    const a = colourPerBar(ps, k);
    const b = colourPerBar(fs, k);
    c.series += 1;
    c.values += k;
    c.drawings += 1;
    for (let i = 0; i < k; i++) {
      if (a[i] !== b[i]) {
        note(
          s,
          `${kind} 第 ${i} 根颜色 前缀=${a[i] ?? "无"} 全量=${b[i] ?? "无"}（记录数 前缀=${ps.length} 全量=${fs.length}）`,
        );
        break;
      }
      if (a[i] !== null) s.informative = true;
    }
  }
  // `fill`: group by the call-site colour/alpha, then compare the band's
  // projection onto bars [0, k). A band the prefix could not draw (< 2 shared
  // finite bars) but the full run draws INSIDE the window is a conjured value.
  const fills = (list: Draw[]) => list.filter((d): d is Fill => d.kind === "fill");
  const key = (d: Fill) => `fill|${d.color}|${d.alpha}`;
  const pg = groupBy(fills(p), key);
  const fg = groupBy(fills(f), key);
  const proj = (d: Fill) => d.pts.filter((x) => x.bar < k).map((x) => `${x.bar}:${fmt(x.top)}:${fmt(x.bottom)}`);
  for (const sig of new Set([...pg.keys(), ...fg.keys()])) {
    const ps = pg.get(sig) ?? [];
    const fs = fg.get(sig) ?? [];
    for (let i = 0; i < Math.max(ps.length, fs.length); i++) {
      const a = ps[i];
      const b = fs[i];
      if (!a || !b) {
        const only = (a ?? b)!;
        const inWindow = proj(only);
        if (inWindow.length >= 2) {
          note(s, `${sig}#${i} 只在一侧出现（前缀 ${ps.length} 条 / 全量 ${fs.length} 条），窗口内却有 ${inWindow.length} 个点`);
        } else {
          c.naDropped += 1; // fewer than two shared finite bars → nothing to draw
        }
        continue;
      }
      const pa = proj(a);
      const pb = proj(b);
      c.drawings += 1;
      c.values += pa.length;
      if (pa.length) s.informative = true;
      if (pa.join(";") !== pb.join(";")) {
        note(s, `${sig}#${i} 窗口内形状不同：前缀 ${pa.length} 点 / 全量 ${pb.length} 点`);
      }
    }
  }
}

function cmpObjectDrawings(
  s: Sink,
  p: Draw[],
  f: Draw[],
  c: Counts,
  live: Map<string, string>,
  liveReasons: Set<string>,
): void {
  for (const kind of OBJECT_KINDS) {
    const ps = p.filter((d) => d.kind === kind);
    const fs = f.filter((d) => d.kind === kind);
    for (let i = 0; i < Math.max(ps.length, fs.length); i++) {
      const a = ps[i];
      const b = fs[i];
      const tag = `${kind}|${i}`;
      const why = live.get(tag);
      if (why) {
        c.live += 1;
        liveReasons.add(`${s.rel} ${tag} — ${why}`);
        continue;
      }
      if (!a) {
        c.afterCut += 1; // created at or after the cut: no window entry to compare
        continue;
      }
      c.drawings += 1;
      // Contradiction guards: the liveness pass above already covers "content
      // varies" and "gone in the full run", so reaching either line means the
      // two views of the same data disagree — a harness bug, which must be loud.
      if (!b) {
        note(s, `${kind} 第 ${i} 项在前缀里有、全量里没有，而存活度判定没抓到：前缀=${drawKey(a)}`);
        continue;
      }
      if (a.kind !== b.kind) {
        note(s, `${kind} 第 ${i} 项两侧类型不一致（前缀=${a.kind} 全量=${b.kind}）`);
        continue;
      }
      if (drawKey(a) !== drawKey(b)) {
        note(s, `${kind} 第 ${i} 项冻结于窗口内却变了：前缀=${drawKey(a)} 全量=${drawKey(b)}`);
        continue;
      }
      s.informative = true;
    }
  }
}

function cmpDrawings(
  s: Sink,
  p: Draw[],
  f: Draw[],
  k: number,
  c: Counts,
  live: Map<string, string>,
  liveReasons: Set<string>,
): void {
  c.tables += Math.max(
    p.filter((d) => d.kind === "table").length,
    f.filter((d) => d.kind === "table").length,
  );
  cmpBarIndexedDrawings(s, p, f, k, c);
  cmpObjectDrawings(s, p, f, c, live, liveReasons);
}

function cmpAlerts(s: Sink, p: Alert[], f: Alert[], k: number, c: Counts): void {
  const key = (a: Alert) => `${a.fn}@${a.line}`;
  const pg = groupBy(p, key);
  const fg = groupBy(f, key);
  const equalHits = (a: Alert, b: Alert) => {
    for (let i = 0; i < k; i++) if (a.hits[i] !== b.hits[i]) return false;
    return true;
  };
  const windowEmpty = (a: Alert) => !a.hits.slice(0, k).some(Boolean);
  for (const [kk, ps] of pg) {
    const fs = fg.get(kk) ?? [];
    const m = pairGroup(ps, fs, equalHits, windowEmpty);
    for (const [a, b] of m.pairs) cmpSeries(s, `alert ${kk}`, a.hits, b.hits, k, c, (x, y) => x === y, (x) => x);
    c.naDropped += m.droppedFull;
    for (const a of m.onlyPrefix) {
      const at = a.hits.slice(0, k).findIndex(Boolean);
      note(
        s,
        `alert ${kk} 前缀里的这条告警在全量里找不到同窗口的对应（前缀${at < 0 ? "窗口内无命中" : `第 ${at} 根命中`}，` +
          `条数 前缀=${ps.length} 全量=${fs.length}）`,
      );
    }
  }
  for (const [kk, fs] of fg) {
    const ps = pg.get(kk) ?? [];
    const m = pairGroup(ps, fs, equalHits, windowEmpty);
    for (const b of m.onlyFullNonEmpty) {
      const at = b.hits.slice(0, k).findIndex(Boolean);
      note(s, `alert ${kk} 前缀里没这条，但全量在第 ${at} 根就命中`);
    }
  }
}

function cmpReport(s: Sink, p: PineResult, f: PineResult, k: number, c: Counts): void {
  if (!p.report || !f.report) {
    if (p.report || f.report) note(s, `report 只在一侧存在（前缀=${p.report ? "有" : "无"} 全量=${f.report ? "有" : "无"}）`);
    return;
  }
  cmpNumbers(s, "report.equity", p.report.equity.slice(0, k), f.report.equity, k, c);
  cmpNumbers(s, "report.positions", p.report.positions.slice(0, k), f.report.positions, k, c);
}

function cmpArtifact(
  s: Sink,
  pre: PineArtifact,
  full: PineArtifact,
  k: number,
  c: Counts,
  live: Map<string, string>,
  liveReasons: Set<string>,
): void {
  cmpLines(s, pre.result.lines, full.result.lines, k, c);
  cmpMarkers(s, pre.result.markers, full.result.markers, k, c);
  cmpHlines(s, pre.result.hlines, full.result.hlines, c);
  cmpDrawings(s, pre.result.drawings, full.result.drawings, k, c, live, liveReasons);
  if (pre.result.alerts || full.result.alerts) {
    cmpAlerts(s, pre.result.alerts ?? [], full.result.alerts ?? [], k, c);
  }
  if (isStrategy(pre) || isStrategy(full)) cmpReport(s, pre.result, full.result, k, c);
  if (pre.result.bars > k) note(s, `前缀只喂了 ${k} 根，脚本却走到第 ${pre.result.bars} 根`);
}

function isStrategy(a: PineArtifact): boolean {
  return a.result.scriptKind === "strategy";
}

/* --------------------------------------------------------------- harness */

const files = pineFiles(CORPUS_DIR);
if (files.length < 100) {
  throw new Error(`语料只有 ${files.length} 份，遍历坏了：${CORPUS_DIR}`);
}

describe("pineNoLookahead — 前缀必须等于全量的前缀（spec §10 / §12 的自动版）", () => {
  it("合成的 300 根 bar 本身就是可信输入", () => {
    expect(BARS.length).toBe(TOTAL);
    for (let i = 0; i < BARS.length; i++) {
      const t = BARS[i].timestamp!;
      expect(Number.isSafeInteger(t), `第 ${i} 根时间戳`).toBe(true);
      // 毫秒：日线步进 1 天，量级 1.7e12；秒级时间戳会在这里现形（本仓禁 *1000）
      expect(t).toBeGreaterThan(1e12);
      expect(t).toBeLessThan(2e12);
      if (i) expect(t).toBeGreaterThan(BARS[i - 1].timestamp!);
    }
    // 周末空洞确实在（推断周期要靠中位数扛住它），跳空也确实在
    const deltas = BARS.slice(1).map((b, i) => b.timestamp! - BARS[i].timestamp!);
    expect(deltas.filter((d) => d > DAY_MS).length).toBeGreaterThan(30);
    const gaps = BARS.slice(1).map((b, i) => Math.abs(b.open / BARS[i].close - 1));
    expect(Math.max(...gaps), "没有跳空：gap 类脚本会在 na 对 na 上空转").toBeGreaterThan(0.02);
    const bodies = BARS.map((b) => Math.abs(b.close - b.open) / b.open);
    expect(Math.max(...bodies)).toBeGreaterThan(0.01);
    // Step 4 的实测前提：宿主周期必须被推断成恰好 1 天，且每个探针长度都是——
    // 否则 request.security 的 HTF 分桶在两种喂法下不是同一个函数，比较无意义。
    expect(inferTimeframeMs(toBars(BARS))).toBe(DAY_MS);
    for (const k of KS) expect(inferTimeframeMs(toBars(BARS.slice(0, k))), `k=${k}`).toBe(DAY_MS);
  });

  it("每个脚本、每个 k：前 k 根喂进去的结果必须等于全量的前 k 项", () => {
    const c: Counts = {
      series: 0,
      values: 0,
      naDropped: 0,
      tables: 0,
      drawings: 0,
      live: 0,
      afterCut: 0,
      hlines: 0,
    };
    let failed = 0;
    let aborted = 0;
    let ran = 0;
    let plainScripts = 0;
    let mtfScripts = 0;
    let passed = 0;
    let mismatched = 0;
    let plainMismatched = 0;
    let mtfMismatched = 0;
    let crashed = 0;
    let pairs = 0;
    let informativeScripts = 0;
    const diffs: string[] = [];
    const mismatchKeys: string[] = [];
    const perFile: { rel: string; isMtf: boolean; diffs: string[]; hits: MechHit[] }[] = [];
    const liveReasons = new Set<string>();
    const nonInformative: string[] = [];

    for (const abs of files) {
      const rel = abs.slice(CORPUS_DIR.length + 1).replace(/\\/g, "/");
      const family = rel.split("/")[0];
      const script = rel.split("/").pop() ?? rel;
      const src = readFileSync(abs, "utf8");
      try {
        const full = compilePine(src, BARS, {});
        if ("error" in full) {
          failed += 1; // not runnable → nothing to compare; counted, never a pass
          continue;
        }
        ran += 1;
        if (full.abort) aborted += 1;
        const isMtf = MTF_RE.test(src) || (full.result.lowerTfMs?.length ?? 0) > 0;
        if (isMtf) mtfScripts += 1;
        else plainScripts += 1;

        // All five prefix runs first: the object-drawing liveness verdict is a
        // measurement over the whole sweep, not a per-k guess.
        const prefixes = KS.map((k) => compilePine(src, BARS.slice(0, k), {}));
        const results: PineResult[] = [];
        for (const p of prefixes) if (!("error" in p)) results.push(p.result);
        results.push(full.result);
        const live = measureObjectLiveness(results);

        const scriptDiffs: string[] = [];
        const hits: MechHit[] = [];
        let informative = false;
        KS.forEach((k, i) => {
          pairs += 1;
          const s: Sink = { rel, k, informative: false, diffs: scriptDiffs, mech: (h) => hits.push(h) };
          const pre = prefixes[i];
          if ("error" in pre) {
            note(s, `全量能跑、前 ${k} 根跑不起来：${pre.error}`);
          } else {
            cmpArtifact(s, pre, full, k, c, live, liveReasons);
          }
          if (s.informative) informative = true;
        });
        if (scriptDiffs.length) {
          mismatched += 1;
          mismatchKeys.push(`${family}/${script}`);
          if (isMtf) mtfMismatched += 1;
          else plainMismatched += 1;
          diffs.push(...scriptDiffs.map((d) => `${isMtf ? "[mtf] " : "[plain]"}${d}`));
          perFile.push({ rel: `${family}/${script}`, isMtf, diffs: scriptDiffs, hits });
        } else {
          passed += 1;
          if (informative) informativeScripts += 1;
          else nonInformative.push(`${family}/${script}`);
        }
      } catch (e) {
        crashed += 1;
        diffs.push(`[crash] ${family}/${script} — ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    /* ------------------------------------------------------------- readout */
    process.stdout.write(
      `\n[no-lookahead] scripts=${ran} passed=${passed} mismatched=${mismatched} crashed=${crashed}\n`,
    );
    process.stdout.write(
      `  buckets: files=${files.length} failed=${failed} aborted=${aborted} ` +
        `plain=${plainScripts} mtf=${mtfScripts} pairs=${pairs} informative-scripts=${informativeScripts}\n`,
    );
    process.stdout.write(
      `  compared: series=${c.series} values=${c.values} drawings=${c.drawings} hlines=${c.hlines} ` +
        `na-dropped=${c.naDropped} live-objects=${c.live} after-cut-objects=${c.afterCut} tables-skipped=${c.tables}\n`,
    );
    process.stdout.write(
      `  mismatched: plain=${plainMismatched} mtf=${mtfMismatched} register=${mismatchKeys.length} (files: ${mismatchKeys
        .slice(0, 6)
        .join(", ")})\n`,
    );
    process.stdout.write(
      `  non-informative (nothing but \`na\` produced on these bars): ${nonInformative.length}: ${nonInformative
        .slice(0, 12)
        .join(", ")}${nonInformative.length > 12 ? ", …" : ""}\n`,
    );
    process.stdout.write(`  live drawing objects (run-end dependent, ${liveReasons.size} verdicts):\n`);
    for (const r of [...liveReasons].sort().slice(0, 24)) process.stdout.write(`    live: ${r}\n`);
    // Shape histogram: a flat head-N dump of the raw list is dominated by the
    // noisiest file, and classification needs the SHAPE of every file's diffs.
    // Nothing is dropped here — `diffs` keeps all of them and the assertions
    // below read `diffs`, `perFile` and `mismatchKeys`.
    process.stdout.write(`  diffs collected=${diffs.length} across ${perFile.length} files (cap removed: all are collected)\n`);
    const shapes = new Map<string, { count: number; example: string; rel: string }>();
    for (const e of perFile) {
      for (const d of e.diffs) {
        const msg = d.slice(d.indexOf(" — ") + 3);
        const key = `${e.rel}\u0000${shapeOf(msg)}`;
        const hit = shapes.get(key);
        if (hit) hit.count += 1;
        else shapes.set(key, { count: 1, example: d, rel: e.rel });
      }
    }
    const byRel = [...shapes.entries()].sort((a, b) => (a[1].rel < b[1].rel ? -1 : a[1].rel > b[1].rel ? 1 : b[1].count - a[1].count));
    let lastRel = "";
    for (const [, v] of byRel) {
      if (v.rel !== lastRel) {
        lastRel = v.rel;
        const total = perFile.find((x) => x.rel === v.rel)!.diffs.length;
        process.stdout.write(`    file ${v.rel} (${total} diffs):\n`);
      }
      process.stdout.write(`      x${v.count} ${shapeOf(v.example.slice(v.example.indexOf(" — ") + 3))}\n`);
    }
    process.stdout.write(`  top shapes (globally, first 10 of ${shapes.size}):\n`);
    for (const v of [...shapes.values()].sort((a, b) => b.count - a.count).slice(0, 10)) {
      process.stdout.write(`    x${v.count} [${v.rel}] e.g. ${v.example}\n`);
    }

    /* -------------------------------------------- the mechanism, re-measured */
    // A register row is only honest while it still names the mechanism it was
    // written for. A row that later mismatches through some OTHER channel would
    // keep this gate green while the ledger lies, so the line channel records its
    // differences structurally (see `MechHit`) and they are re-checked per
    // registered file here, BEFORE the register rows themselves are compared, so
    // the numbers are printed even when the ledger is what is out of date:
    //   · every diff of a registered file must be one of those recorded
    //     line-channel differences — nothing else may hide behind the row;
    //   · every recorded difference must be the offset mechanism: a NEGATIVE plot
    //     offset, and the value the full run shows below bar k must be produced at
    //     bar `srcBar = bar - offset >= k` — a bar the prefix never had.
    const mechBad: string[] = [];
    let mechHits = 0;
    let mechMaxAhead = 0;
    const observed = [...new Set(mismatchKeys)].sort();
    for (const key of observed) {
      const e = perFile.find((x) => x.rel === key)!;
      if (e.hits.length !== e.diffs.length) {
        mechBad.push(
          `${key}: ${e.diffs.length} 条差异中只有 ${e.hits.length} 条是登记的「负 offset」那条分支记下的，其余 ${
            e.diffs.length - e.hits.length
          } 条来路不同：\n      ${e.diffs.filter((d) => !/ line「/.test(d)).slice(0, 3).join("\n      ")}`,
        );
        continue;
      }
      const offs = e.hits.map((h) => h.offset);
      const ahead = e.hits.map((h) => h.srcBar - h.k);
      process.stdout.write(
        `    mechanism ${key}: hits=${e.hits.length} offset∈[${Math.min(...offs)}…${Math.max(
          ...offs,
        )}] 提前根数 srcBar-k∈[${Math.min(...ahead)}…${Math.max(...ahead)}]\n`,
      );
      mechMaxAhead = Math.max(mechMaxAhead, ...ahead);
      for (const h of e.hits) {
        mechHits += 1;
        if (!(h.offset < 0 && h.bar >= 0 && h.bar < h.k && h.srcBar >= h.k)) {
          mechBad.push(`${key}: k=${h.k} offset=${h.offset} 第 ${h.bar} 根 ← 第 ${h.srcBar} 根，不满足「负 offset 且 srcBar>=k」`);
        }
      }
    }
    process.stdout.write(
      `  mechanism check: registered=${observed.length} line-hits=${mechHits} 最大提前根数=${mechMaxAhead} 违例=${mechBad.length}\n`,
    );

    /* -------------------------------------------------------------- floors */
    // No vacuous pass: the walk found these files and every compared script was
    // evaluated at every k in the probe set. Floors are the measured counts
    // (2026-10-07), with room for a corpus file to be removed, not room for the
    // comparison to stop happening.
    expect(pairs, "(script, k) 对必须是 已比较脚本 × 探针长度").toBe(ran * KS.length);
    expect(pairs, "对数下限（实测 1050）").toBeGreaterThanOrEqual(1000);
    expect(ran, "跑通并可比较的脚本数掉了：语料遍历或解释器坏了（实测 210）").toBeGreaterThanOrEqual(200);
    expect(plainScripts + mtfScripts, "分档必须覆盖每个跑通的脚本").toBe(ran);
    expect(mtfScripts, "多周期档的脚本数（实测 7）").toBeGreaterThanOrEqual(6);
    expect(c.values, "一个值都没比到，等于没守卫（实测 460826 个逐 bar 的值）").toBeGreaterThan(400_000);
    expect(c.series, "一条序列都没比到（实测 2302 条）").toBeGreaterThan(2_000);
    expect(c.drawings, "一条画线记录都没比到（实测 366 条，另有 live-objects 走单独口径）").toBeGreaterThan(300);
    expect(c.hlines, "一条 hline 都没比到（实测 920）").toBeGreaterThan(800);
    // The comparison must not be `na` against `na` all the way down: a script
    // only counts as covered once a FINITE value (or a fired alert, or a frozen
    // drawing) actually sat in the window and was compared.
    expect(informativeScripts + nonInformative.length, "信息/非信息两档必须盖过每个跑通的脚本").toBe(passed);
    expect(informativeScripts, "真有值在比的脚本数（实测 191）").toBeGreaterThanOrEqual(180);
    // The gate itself must not be the thing that breaks.
    expect(crashed, "harness 自己抛异常").toBe(0);
    expect(passed + mismatched, "passed + mismatched 必须等于跑通的脚本数").toBe(ran);

    /* --------------------------------------------------------- the register */
    // Two-way exact equality between the observed mismatch set and the
    // register: a script that starts mismatching goes red, and a script that
    // gets fixed goes red too until somebody shrinks the list. Zero tolerance
    // for everything outside it, in BOTH buckets.
    const unregistered = observed.filter((x) => !REGISTER_KEYS.includes(x));
    const stale = REGISTER_KEYS.filter((x) => !observed.includes(x));
    expect(
      unregistered,
      `未登记的前缀≠全量（每条都必须在 LOOKAHEAD_REGISTER 里命名机制，否则就是新增重绘）：\n${unregistered
        .map((k) => `  · ${k}\n${diffs.filter((d) => d.includes(k)).slice(0, 3).map((x) => `      ${x}`).join("\n")}`)
        .join("\n")}`,
    ).toEqual([]);
    expect(
      stale,
      `登记在册却没有再出现前缀≠全量：修好了就把 LOOKAHEAD_REGISTER 那一行删掉，留着它就等于假装还在守（实测脚本：${observed.join(", ")}）`,
    ).toEqual([]);
    expect(mismatchKeys.length, "一个脚本只许计一次，且必须与 observed 集合一致").toBe(observed.length);
    expect(plainMismatched + mtfMismatched, "两个档加起来就是 mismatched").toBe(mismatched);
    expect(
      observed.filter((x) => LOOKAHEAD_REGISTER.find((e) => registerKey(e) === x && e.channel !== "")).length,
      "登记项必须写清是哪条通道出的问题",
    ).toBe(observed.length);
    // The register is a ledger of defects, not a coverage number: it may never
    // grow into a tolerance mechanism.
    expect(REGISTER_KEYS.length, "register 尺寸（实测 4）").toBeLessThanOrEqual(6);
    expect(LOOKAHEAD_REGISTER.length).toBe(4);

    /* -------------------------------------------- the mechanism, asserted */
    // Computed and printed above (before the floors, so the numbers are on the
    // wall even when the ledger is what is out of date), asserted last: when the
    // register itself is stale the message above explains it better than this one.
    expect(
      mechBad,
      `登记项的机制说明已经不再成立（要么换了通道，要么不是负 offset 造成的）：\n${mechBad.slice(0, 10).join("\n")}`,
    ).toEqual([]);
    expect(mechHits, "登记在册的脚本一条 line 通道差异都没记到（等于 register 空转）").toBeGreaterThan(0);
  }, 900_000);

  it("语料里每个脚本都被走查过，且 register 里没有幽灵条目", () => {
    // A register row whose file is not in the corpus would make the two-way
    // assertion above pass by pointing at nothing.
    const present = new Set(files.map((abs) => abs.slice(CORPUS_DIR.length + 1).replace(/\\/g, "/")));
    expect(present.size, "语料里出现了同名文件路径").toBe(files.length);
    for (const e of LOOKAHEAD_REGISTER) {
      expect(present.has(registerKey(e)), `register 指向语料里不存在的文件：${registerKey(e)}`).toBe(true);
      expect(e.mechanism.length, `register 项必须写机制：${registerKey(e)}`).toBeGreaterThan(20);
    }
    expect(files.length, "语料遍历（实测 210）").toBeGreaterThanOrEqual(200);
  });
});
