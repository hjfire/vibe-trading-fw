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
 * narrower and literally true, and it is scoped on purpose: every difference
 * between the two ways of feeding bars that lands on a BAR-INDEXED channel —
 * series, marker value/text/side, hline prefix, `bg`/`bar`/`fill` colour
 * projections, alert hits, strategy equity/positions — is either (a) named in
 * `LOOKAHEAD_REGISTER`, with the channel and the mechanism, or (b) red. On those
 * channels nothing is averaged and nothing is tolerated. (The CHANNEL a row claims is
 * machine-checked for the line family only — see the `channel` limit in the register
 * section below, which is stated as a limit rather than smoothed over.)
 *
 * What IS skipped, and where the number for it lives: three record families are
 * not bar-indexed and are therefore not compared — mutable `label`/`line`/`box`
 * objects, the `hline` tail past the prefix's own count, and `table` cells. They
 * are never skipped silently: each one is counted and named on the wall — the
 * drawing/hline/table families under `exempted:`, the legal all-`na` warm-up drop
 * under `compared:` as `na-dropped=` — and every counter on those two lines carries
 * a gate at the bottom of this file, of one of two kinds. CEILINGS (a measured
 * number somebody has to raise before it may grow): `live` total, three of the four
 * buckets it decomposes into (`mutating`, `run-end-built`, `existence`), the
 * sub-count `existence-anchor-below-k` that says how much of `existence` sits below
 * its own cut, `na-dropped`, `after-cut-objects` and `after-cut-end-created`.
 * EXACT ZERO (that skip may not appear at all): the fourth bucket `unexplained`,
 * `after-cut-unexplained`, `hlines-tail-skipped`, `tables-skipped`. The identity that
 * makes the four buckets ADD UP to `live` is asserted as well, so an exemption cannot
 * migrate from one bucket to another without moving a capped number, and `aborted` is
 * pinned by its exact sorted LIST rather than by a count. Measured 2026-10-07 on the
 * delivered bytes: `live-objects=1848 (mutating=238 run-end-built=892
 * existence=718 existence-anchor-below-k=288 unexplained=0)`, `na-dropped=71`,
 * `after-cut-objects=4`, `after-cut-end-created=1`, `after-cut-unexplained=0`,
 * `hlines-tail-skipped=0`, `tables-skipped=0`. The strict side of the object channel
 * is fenced from the other end too, by a measured floor on
 * `drawings / (drawings + live)` (≥15%, today 368/2216 = 16.6%). So a skip on this
 * inventory can only grow by somebody reading a number and raising the cap over it —
 * which is what THIS sentence is scoped to, and nothing more: the compared channels
 * are the ones with zero tolerance, not these record families. "Nothing is averaged,
 * tolerated or skipped" would be false as an unconditional sentence; it is true of the
 * compared channels and the inventory beside it is the proof.
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
 * harness decides this per (script, k) from measured signals and never from a
 * filename list. Three arms, tried in this order, each with its own counter, its
 * own ceiling and its own mechanism claim:
 *   · MUTATION, FIELD BY FIELD (`mutating=238`): a record whose CONTENT differs
 *     at this k is excused only when every field that actually differs is one a
 *     call this script's source contains can WRITE — `PROPS_OF_OP` is the engine's
 *     own `applyDrawOp` switch (`pineRuntime.ts:2127-2196`) and
 *     `RECORD_FIELD_OF_PROP` is `emitDrawings`' record shape
 *     (`pineRuntime.ts:2222-2247`), so the mapping is read off the engine, not
 *     guessed. `label.set_text` therefore excuses `text`, `set_xy` excuses
 *     `bar`/`price`, and `delete` excuses NOTHING here: it writes only the
 *     `deleted` flag, which can explain a record being ABSENT, never a record whose
 *     fields differ. Round 1 of this file keyed the excuse on the KIND alone, so
 *     one `label.set_text` excused every label in the script and the corpus's
 *     rolling-buffer `line.delete(l[1])` idiom
 *     (`statistics/gaps_percent_size_distribution.pine:82,100`) was carrying
 *     content differences it cannot explain. The previous build printed that as
 *     `mutating=1130`; this one prints `mutating=238 run-end-built=892` — the same
 *     1 130 records, split by the mechanism that actually reaches each one, and
 *     `live-objects=` is 1 848 either way. Read that as what this round did and
 *     what it did not do: it stopped a `delete` from excusing a FIELD it cannot
 *     write and named the construction mechanism that was hiding inside the
 *     mutation excuse; it did not shrink the exemption, because the records are
 *     still run-end dependent and still not comparable. Variance across runs is NOT
 *     what excuses a CONTENT difference, and neither is a call that cannot write the
 *     field; an object that changes with no explaining call is reported
 *     (`unexplained=`, measured 0, pinned at 0). That last clause is MEASURED, not
 *     just constructed: canary ⑥ below takes `delete` out of the source scan on a
 *     copy of these delivered bytes, and `unexplained` does not rise above that 0 —
 *     the whole `exempted:` line stays `live-objects=1848 (mutating=238
 *     run-end-built=892 existence=718 existence-anchor-below-k=288 unexplained=0)`
 *     unchanged to the digit, and the only thing that moves is the printed inventory
 *     of calls. A `delete`-free scan cannot convict a record, because a `delete`
 *     never excused one.
 *   · RUN-END CONSTRUCTION (`run-end-built=892`), for the content differences no
 *     call writes: the script has a `barstate.islast` block, constructs this kind
 *     (`label.new(`/`line.new(`/`box.new(`), and the MEASURED per-kind record count
 *     grows with the run (`59/119/179/239/298` for that file's `line`), so index
 *     `i` of the k=60 run and index `i` of the full run are the i-th object of two
 *     different construction passes — their args were evaluated at two different
 *     ends, e.g. `time[149]` is `na` in the shorter run and a real timestamp in the
 *     full one, which is how that file's column lands at `line|0|0|0|0|…` versus
 *     `line|149|0|149|0|…`. This is the object-channel hole the design §10 ruling
 *     accepted, and it is named, counted and capped HERE rather than folded into
 *     the mutation excuse; a source scan cannot localise it to the block, because
 *     the construction sits in the `_line()`/`_label()` helpers that the
 *     `barstate.islast` block calls. A look-ahead in a script that does NOT rebuild
 *     its objects at the run end still lands in `unexplained` and reddens.
 *   · an identity-level EXISTENCE flag, walked over ALL SIX runs
 *     (k=60/120/180/240/299 and the full 300) — this excuses only records whose
 *     very PRESENCE moves with the end of the run (`existence=718`), where index
 *     pairing carries no information for an anchor check to convict. THIS arm is
 *     still the cross-run variance signal: what the two content arms above lost is
 *     the power to excuse a CONTENT difference by variance, not the existence one.
 *     Their anchors are still MEASURED: `existence-anchor-below-k=288` is that hole
 *     printed and pinned, not argued away. Which side of the pairing the records sit
 *     on is measured too: in the forced build below the prefix-only arm is NOT part
 *     of the forcing (it excuses unconditionally) and that build still prints
 *     `existence=0`, so today every one of the 718 comes from the full-run-only side
 *     — a record the shorter runs never reached — while `a && !b`, the shape a
 *     `delete` between `k` and the end of the run leaves behind, fires on 0 records
 *     on this corpus. It is kept because the shape is real in the engine
 *     (`emitDrawings` drops a deleted object from the walk,
 *     `pineRuntime.ts:2220-2221`) and no rule here can promise the corpus will keep
 *     not producing it; what the measurement promises is only that if it starts, the
 *     count moves under a cap somebody has to raise.
 * Exempted records are counted, printed per identity (the wall's
 * `live drawing objects (run-end dependent: …)` block names the (script, identity)
 * pairs and the reason each one carries) and left out of the content comparison —
 * the same honest treatment `table` gets, for the same reason. What stays strict
 * for those scripts is everything else, at zero tolerance: every series, marker,
 * hline, alert and strategy curve. A look-ahead that only ever shows up in a
 * mutable label would be invisible to this harness and to Bar Replay alike — the
 * chart's price data, and what replay steps through, are the series.
 * HOW MUCH THAT EXEMPTION COULD ABSORB, measured rather than asserted: re-run
 * 2026-10-07 on a scratch copy of THIS build with all three content signals
 * forced empty (`mutators`, `creators`, `live`) so no arm has anything to excuse
 * with and object records are compared like any other channel. Same corpus, same
 * bars: `scripts=210 passed=194 mismatched=16`, `diffs collected=2404 across 16
 * files`, and the wall reads `live-objects=1130 (mutating=0 run-end-built=0
 * existence=0 existence-anchor-below-k=0 unexplained=1130)
 * after-cut-objects=434 after-cut-end-created=1 after-cut-unexplained=288`.
 * Twelve more scripts go red beyond the 4 registered ones and 1 418 more diff
 * records appear — and `1130 = 238 + 892` is exactly the two content arms this
 * file splits today, which is the point of splitting them: the hole did not
 * shrink, it got a mechanism on every part of it. The first `expect` to fire was
 * again `expect(c.liveUnexplained).toBe(0)`, at 1130. `informative-scripts`
 * printed 191 rather than 192 for one reason worth naming: the forced build makes
 * `statistics/gaps_percent_size_distribution.pine` a mismatched file, and
 * mismatches are not counted as covered. The mechanism guard printed
 * `registered=16 line-hits=986 违例=12` — 12 of those 16 files have no register
 * row, so the extra red cannot be waved through as "already known".
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
 * The limit on the CHANNEL check, stated because the table behind it is
 * degenerate today: each row's `channel` is compared against the channel the
 * difference was MEASURED on, and that measurement only exists for line records —
 * both `MechHit` shapes come out of `cmpLines` and both map to `"line"`, so the
 * derived set can literally only ever answer `line`. The assertion is therefore
 * one-way: it convicts a row whose differences STOPPED being line-channel (a row
 * claiming `line` while the measured set is empty, or a file that no longer
 * mismatches at all), but it cannot CONFIRM a marker or alert channel, because no
 * marker/alert difference is recorded as a `MechHit` at all. A marker-channel row
 * would be checked by hand until someone adds the matching shapes; what still
 * convicts any non-negative-offset difference on a registered file is the two-way
 * list check plus the mechanism predicate below, not the channel word.
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
 * informative 192, not in the printed 14. That list is collected in sorted file
 * order, and both names sort AHEAD of `statistics/kendall_rank_correlation_coefficient.pine`,
 * the tenth entry of the list, which IS printed — so their absence from it is what
 * proves they were informative. The delivered file does not rest on that sorting
 * argument: both names are pinned out of the `non-informative` list by an assertion
 * beside the floors, so the sentence below fails loudly rather than quietly if one of
 * them ever goes `na`-only. Nothing is being waved
 * through a vacuous pass: their offset-0 series really was compared bar for bar,
 * and it is only the shifted columns that carry no value on these 300 bars. They
 * enter the register the moment one of them does.
 * What counts as INFORMATIVE is itself a rule, and it is worth stating site by site
 * because the number is read as "the comparison was not vacuous here". A script is
 * informative when at least one comparison inside the window MATCHED on something
 * with a value in it, at any of the places that set the flag: a finite bar value on a
 * number series (`cmpNumbers`), a non-empty marker `texts` entry or a `true` alert hit
 * (`cmpSeries`, whose own predicate decides — the marker `up` channel is deliberately
 * given a predicate that never earns coverage, because the engine's default `true` is
 * not a value), an equal `hline` pair (`cmpHlines`), a non-null per-bar colour in the
 * `bg`/`bar` projection, a `fill` band with at least one point in the window, or an
 * object record that matched at this k AND carries a finite value
 * (`recordCarriesValue`, arm 1 of `cmpObjectDrawings`: a finite `price` for a `label`,
 * a finite `y1`/`y2` for a `line`/`box`). The object arm is the one this round
 * tightened, because a drawing record is emitted as soon as its coordinates are merely
 * DEFINED (`o.y !== undefined`, `pineRuntime.ts:2223-2238`): agreement on a bare
 * `label|0|na|…` placeholder used to be able to mark a script covered on its own, and
 * now cannot — so `informative-scripts=192` does NOT include that weaker form any
 * more. What it still does include, and nobody should mistake for a per-bar value, is
 * the `hline`-pair and colour-projection arms above: those are matched channels whose
 * records carry no bar-indexed number of their own. Measured on this corpus the
 * tightening costs nothing and, so far, buys nothing: the build this round replaced
 * and this one both print `informative-scripts=192` with a byte-identical 14-name
 * `non-informative` list, because every script that reaches the equal-state arm also
 * has at least one value-carrying comparison here. One further limit worth naming:
 * only PASSED scripts are sorted into the two buckets — `informative` +
 * `non-informative` = `passed` is asserted — so a mismatched file never counts as
 * covered, which is exactly why the forced build below prints 191 rather than 192.
 * The flag says a comparison was not vacuous, not that it was large; the size floors
 * are per-script averages rather than a story about this list.
 *
 * ── Missing input is an incident, never a skip ──
 * The corpus is local-only (`frontend/.gitignore:9`), like
 * `pineAlertCorpus.test.ts`, and this file takes the same discipline as that
 * harness: a walk that finds fewer than 100 scripts THROWS. There is no
 * `describe.skipIf` and no early return, because a guard that compares nothing
 * passes, and a guard that cannot fail is worse than no guard. Its red capability
 * was proven before its floors were trusted, seven ways on 2026-10-07 against
 * this harness and this corpus (each entry below names WHICH build of this file it
 * was run against) — six of them red, the seventh (⑥, the `delete` arm)
 * a measurement whose finding is that it does NOT redden. Baseline green FIRST so
 * any red below is attributable to the edit and not to the machine (`scripts=210 passed=206
 * mismatched=4 crashed=0`, rc=0 — five green runs are logged for this build and they
 * measured 25.17–25.63 s of comparing (`tests`) and 27.25–28.34 s for the file; the
 * timing is reported, not gated, and no assertion below depends on it). Each edit then went
 * red, was reverted, and printed those same numbers again:
 *   · ① the window itself — `cmpNumbers`' per-bar loop walked `i <= k` instead of
 *     `i < k`, comparing the first `k+1` entries instead of the first `k` (the
 *     shift, not the tolerance, is what this gate exists to catch). Re-run
 *     2026-10-07 against THIS build, on a scratch copy. RED, rc=1:
 *     `scripts=210 passed=18 mismatched=192 crashed=0`
 *     (`mismatched: plain=188 mtf=4 register=192`), `diffs collected=2624 across
 *     192 files`, and every fresh diff spells the off-by-one out — the collapsed
 *     shape on the wall is literally `x5 line Upper#N：第 N 根 前缀=缺项 全量=N`,
 *     i.e. index `k`, the bar the prefix run was never fed, where `p[k]` is
 *     `undefined` and `fmt` prints 缺项. `values` went 460 826 → 462 464 (+1 638:
 *     one bar walked on every series that got that far), which is exactly the work
 *     this pin forbids. The object channel did not move (`exempted:` still
 *     1848 / 238 / 892 / 718 / 288 / 0) — a series-loop edit has no business
 *     changing it, and the wall agrees. The first `expect` to fire is the
 *     informativeness floor, with the message computed as designed: 「真有值在比的
 *     脚本数不得低于跑通脚本的 85%（实测 4/210 = 2%）」 expected 4 to be greater than
 *     or equal to 179 — 192 files went mismatched, and of the 18 that stayed clean
 *     only 4 still had a finite value inside the window. The mechanism guard named
 *     the rest on the wall before any assertion ran
 *     (`registered=192 line-hits=0 违例=192`): 188 of those files have no register
 *     row, so a build that somehow survived the floor would still die on the
 *     two-way register check — a diff that is not the registered negative-offset
 *     branch cannot hide behind a row either.
 *   · ② the stale-row direction — a 5th `LOOKAHEAD_REGISTER` row pointing at
 *     `statistics/z_score.pine`, a file that does NOT mismatch. RED, rc=1, at
 *     `expect(stale, …).toEqual([])`, and the message names the offending row:
 *     「登记在册却没有再出现前缀≠全量」: expected [] / received
 *     ['statistics/z_score.pine']. The readout stayed `mismatched=4 passed=206`
 *     throughout — the row hid nothing, it only lied, and the gate reds a lie.
 *     BUILD: round 1 (1748 lines, `exempted:` read `mutating=1130`, no
 *     `run-end-built`), NOT re-run against these bytes — the two-way register check it
 *     exercises is byte-identical here, so the reading carries over, but it is that
 *     build's reading and is named as one.
 *   · ③ the unregistered direction — deleting the `us_treasury_yields.pine` row.
 *     RED, rc=1, at `expect(unregistered, …).toEqual([])`: 「未登记的前缀≠全量」
 *     receiving ['statistics/us_treasury_yields.pine'] with three of that file's
 *     real `[mtf]` diff lines printed under it (offset=-8，第 52 根起分叉：
 *     前缀=na 全量=150.2017…). This is the one that proves the MTF bucket above is
 *     zero tolerance and not an exemption: strip its row and an MTF script goes
 *     red exactly like a plain one. BUILD: round 1 as well (same
 *     `mutating=1130` wall, same three named diff lines), not re-run here — the
 *     assertion it reddens is unchanged between the two builds.
 *   · ④–⑦ are the pins' own canaries — numbered after the three above, they are
 *     not the review findings of the same names. All four ran on a scratch COPY of
 *     this file (a sibling directory of `src/`, imports rewritten, deleted after the
 *     run), so the shipped bytes never held a mutation:
 *     ④ the `live` ceiling lowered from `1_848` to `1_847`. RED, rc=1, at exactly
 *     that `expect`: 「被豁免的对象画线记录总数（实测 1848）只许按登记的口径长」
 *     expected 1848 to be less than or equal to 1847. So `live-objects=1848` is a
 *     gate, not a caption. BUILD: round 1 (`mutating=1130` on its wall); the ceiling
 *     itself is the same 1 848 here, and ⑦ below is this build's bite-test for the
 *     bucket ④'s total is now decomposed into.
 *     ⑤ finding ②'s old bug put back — branch 4's `an >= k` relaxed to
 *     `an !== undefined`, i.e. every full-run-only object record counted as
 *     "created after the cut" without its anchor being checked. RED, rc=1 at
 *     `expect(c.afterCut, …).toBeLessThanOrEqual(4)`: expected 5 to be less than
 *     or equal to 4, with `after-cut-end-created=0` and `passed`/`mismatched`/
 *     `diffs collected` unchanged to the digit (206/4/986). Two honest readings:
 *     the anchor check decides WHICH pinned bucket a record lands in, and
 *     `after-cut-unexplained` itself stayed 0 under this mutation — the ceiling on
 *     `after-cut-objects` is what has the bite, so finding ② is closed by the pair
 *     (anchor is checked, bucket is capped), not by the 0 alone. BUILD: round 1
 *     again, not re-run against these bytes; branch 4's anchor check and the `4`
 *     ceiling are both unchanged here, and the delivered wall still prints
 *     `after-cut-objects=4 after-cut-end-created=1 after-cut-unexplained=0`.
 *     ⑥ the `delete` arm taken out of the source scan — `OBJECT_MUTATION_RE`
 *     relaxed from `(?:set|delete)[a-z0-9_]*` to `set[a-z0-9_]*`, so
 *     `label.delete(…)`/`line.delete(…)` are no longer found as calls this script
 *     makes. GREEN — all three of that copy's tests passed — and not one count
 *     moved: `live-objects=1848
 *     (mutating=238 run-end-built=892 existence=718 existence-anchor-below-k=288
 *     unexplained=0)`, `passed=206 mismatched=4`, `diffs collected=986`. The only
 *     line that changed was the inventory itself — `mutation calls in corpus
 *     source:` lost `line.delete=13, label.delete=13` — and the reason rows that
 *     quote the call list read `set_x/set_text/set_tooltip` instead of
 *     `delete/set_x/set_text/set_tooltip`. That is the answer to "was `delete`
 *     load-bearing?": no, and by construction it cannot be — `PROPS_OF_OP.delete`
 *     is the empty list, so the field-scoped rule hands a `delete` no excusable
 *     FIELD at all, which is exactly what the round-1 kind-keyed rule had been
 *     spending. The arm stays in the scan because the wall's inventory should read
 *     like the corpus, and because the EXISTENCE branch is where a `delete` does
 *     earn its exemption (`pineRuntime.ts:2220-2221`).
 *     ⑦ the `run-end-built` ceiling lowered from `892` to `891`, the new bucket's
 *     cap proven the same way ④'s was. RED, rc=1, at exactly that `expect`:
 *     「内容差异被「run 末端重建」豁免掉的记录数（实测 892）…」 expected 892 to be
 *     less than or equal to 891, readout otherwise unchanged to the digit. So the
 *     arm this round added is capped by a gate, not by a caption.
 * After every revert the harness file was byte-identical to the pre-canary
 * snapshot again (`diff` empty, md5 unchanged) before the next edit, so the
 * proofs are independent of each other; ④–⑦ needed no revert, being copies. The
 * printed `[no-lookahead]` block is the evidence each edit leaves behind, and the
 * BUILD each canary was run against is now stated on the canary itself instead of
 * being claimed for all seven at once: ①, ⑥, ⑦ and the hole-size measurement above
 * ran against THIS build (① and ⑥ were run once more, 2026-10-07, on the final
 * doc-only bytes — their entries carry that second reading), while ②, ③, ④ and ⑤
 * belong to the round-1 build whose wall read `mutating=1130` with every other
 * number identical, and are named as that. They are a record of runs, not a claim
 * about one.
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

/**
 * The channel a recorded difference came in, derived from the measurement rather
 * than from the register row's own self-report — that is what makes the
 * `channel` field of a row checkable (`LOOKAHEAD_REGISTER` says which surface the
 * difference shows up on; this says which surface it was actually seen on).
 *
 * Scope, stated because the table is degenerate today: both `MechHit` shapes come
 * out of `cmpLines`, so this map can only ever answer `line`. The assertion is
 * therefore one-way — it can catch a registered row whose differences stopped
 * being line-channel (a row claiming `line` while the measured set is empty, or a
 * row whose file no longer mismatches at all), but it CANNOT confirm a marker or
 * alert channel, because nothing records a MechHit for those; a marker-channel
 * difference on a registered file shows up as the `hits.length !== diffs.length`
 * count mismatch above instead. Adding a marker/alert row means adding the
 * matching `MechHit` shapes first — until then this is a line-channel check only.
 */
const CHANNEL_OF_SHAPE: Record<MechHit["shape"], string> = {
  "line-diverges": "line",
  "line-not-in-prefix": "line",
};

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
  /** Number series (line / marker channel / alert hits) with at least one bar walked. */
  series: number;
  /** Individual bar-indexed values actually walked inside those series. */
  values: number;
  /** Full-run-only records whose window slice carried nothing (all-`na` series, never-fired alert): the legal warm-up drop. */
  naDropped: number;
  /** `table` drawings skipped (no bar anchor to window). */
  tables: number;
  /** Drawing records compared on the strict rule (bar-indexed + object records frozen AT THIS k). */
  drawings: number;
  /** Object drawings excluded as run-end dependent at this k (see drawing rule 2). */
  live: number;
  /** …of `live`: content differs at this k AND every differing field is one a `set_*` call this
   *  script's source contains can change (`excusableFields`; `delete` changes no field at all). */
  liveMutating: number;
  /** …of `live`: content differs in fields no call writes, and the measured evidence is that the
   *  whole object set of this kind is REBUILT as the run grows (see `cmpObjectDrawings` arm 2b). */
  liveRunEndBuilt: number;
  /** …of `live`: one side is missing and the identity itself moves with the end of the run. */
  liveExistence: number;
  /** …of `live`: content differs at this k and some differing field is not attributable to any
   *  call in the source (nor to a record created at the run's own end) → red. */
  liveUnexplained: number;
  /** …of `liveExistence`: that record's own anchor is below `k` — a hole measured on the wall, not argued. */
  liveExistenceBelowCut: number;
  /** Object drawings the full run alone has, anchored at or after the cut (nothing in the window to check). */
  afterCut: number;
  /** …full-run-only records whose index no shorter run reaches at all: appended at the run's last bar. */
  afterCutEndCreated: number;
  /** …records anchored BELOW the cut with neither explanation: a future bar conjured them at bar < k → red. */
  afterCutBelowCut: number;
  /** hline records compared. */
  hlines: number;
  /** hline records the full run has past the prefix's own count: no bar anchor, so not comparable. */
  hlineTail: number;
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
  // Counted AFTER the walk, and only for the bars actually reached: a series that
  // diverges at bar 3 was compared over 4 bars, not over `k`, and `values=` is
  // read as "bar-indexed values compared" on the wall.
  let walked = 0;
  for (let i = 0; i < k; i++) {
    const a = p[i];
    const b = f[i];
    walked += 1;
    if (Number.isNaN(a) && Number.isNaN(b)) continue;
    if (Number.isNaN(a) !== Number.isNaN(b) || a !== b) {
      note(s, `${path}：第 ${i} 根 前缀=${fmt(a)} 全量=${fmt(b)}`);
      break;
    }
    if (Number.isFinite(a)) s.informative = true;
  }
  if (walked > 0) {
    c.series += 1;
    c.values += walked;
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
  let walked = 0;
  for (let i = 0; i < k; i++) {
    walked += 1;
    if (!same(p[i], f[i])) {
      note(s, `${path} 第 ${i} 根 前缀=${String(p[i])} 全量=${String(f[i])}`);
      break;
    }
    if (informative(p[i])) s.informative = true;
  }
  if (walked > 0) {
    c.series += 1;
    c.values += walked;
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
  for (const sig of new Set([...pg.keys(), ...fg.keys()])) {
    const ps = pg.get(sig) ?? [];
    const fs = fg.get(sig) ?? [];
    // ONE match per signature group: `pairGroup` is deterministic in its
    // arguments, so matching the group once and reading both sides off the same
    // result is the same report — running it twice (once per side) used to
    // produce two notes for one value-divergent line and double the pass.
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
  for (const name of new Set([...pg.keys(), ...fg.keys()])) {
    const ps = pg.get(name) ?? [];
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
 *
 * The TAIL (the full run has more records than the prefix) is NOT silently
 * dropped any more: a `hline` record carries no bar anchor (`pineTypes.ts:304`
 * is `{ price, title, color?, style? }`), so the harness cannot tell "created
 * after the cut" from "created before it with a future price" — it counts the
 * tail (`hlines-tail-skipped=`), prints it and pins the count, exactly like the
 * other skips. What the probe set gives for free: a record is appended only when
 * the `hline()` key has not been seen yet (`pineRuntime.ts:1920-1925`), so one
 * call site contributes at most one record per bar and a tail can only be what a
 * LATER bar created — at `k = TOTAL - 1` that is bar 299 alone, while an
 * unchecked tail at k=60 could hide 240 bars of creations. Deepest cut, tightest
 * bound; the pin below is what turns "measured 0" into "stays 0".
 * Was the drop LIVE or LATENT on this corpus? Measured LATENT: `hlines-tail-skipped`
 * is 0 in every run of this build that was logged — the shipped green readout, the
 * hole-size build, and each of canary ①/⑥/⑦'s copies — and it was 0 in the round-1
 * build's exemption-off and anchor-blinding runs too (those took `liveUnexplained`
 * 0 → 1130 and `after-cut-objects` 4 → 5 respectively, and neither dropped an hline).
 * No hline record has ever been dropped invisibly here, and `tailRows` has never
 * printed.
 * The pin is still the only thing between a future tail and silence, so it is an
 * exact `toBe(0)`, not a ceiling with slack: a record that can be neither compared
 * nor attributed should cost somebody a red run and a paragraph.
 */
function cmpHlines(
  s: Sink,
  p: PineResult["hlines"],
  f: PineResult["hlines"],
  k: number,
  c: Counts,
  tailRows: Set<string>,
): void {
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
  if (f.length > p.length) {
    const extra = f.length - p.length;
    c.hlineTail += extra;
    tailRows.add(
      `${s.rel} k=${k}：全量 ${f.length} 条 > 前缀 ${p.length} 条，多出的 ${extra} 条无 bar 锚点、不比`,
    );
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

const OBJECT_KINDS: readonly ("label" | "line" | "box")[] = ["label", "line", "box"];

/**
 * The compared fields of an object record, BY NAME: exactly what `drawKey` joins
 * into a string, split back out so a difference can be attributed to a field
 * instead of to the whole record. Same normalisation as `drawKey` (`num`/`fmt`),
 * so `drawFields(a)` equals `drawFields(b)` field-for-field whenever their
 * `drawKey`s are equal.
 */
function drawFields(d: Draw): Map<string, string> {
  const num = (v: number | undefined) => (v === undefined ? "-" : fmt(v));
  switch (d.kind) {
    case "label":
      return new Map([
        ["bar", String(d.bar)],
        ["price", num(d.price)],
        ["text", d.text],
        ["bg", d.bg ?? ""],
        ["fg", d.fg ?? ""],
      ]);
    case "line":
      return new Map([
        ["x1", num(d.x1)],
        ["y1", num(d.y1)],
        ["x2", num(d.x2)],
        ["y2", num(d.y2)],
        ["color", d.color ?? ""],
        ["width", num(d.width)],
        ["dashed", d.dashed ? "1" : "0"],
      ]);
    case "box":
      return new Map([
        ["x1", num(d.x1)],
        ["y1", num(d.y1)],
        ["x2", num(d.x2)],
        ["y2", num(d.y2)],
        ["border", d.border ?? ""],
        ["bg", d.bg ?? ""],
      ]);
    default:
      // Not decomposable: this pass only ever sees `label`/`line`/`box`
      // (`OBJECT_KINDS`), so any other record is compared as one anonymous field.
      return new Map([["record", drawKey(d)]]);
  }
}

/** The named fields in which two records of one identity differ (`[]` = no named
 *  field differs, i.e. only the joined `drawKey` string differs — not excusable,
 *  because nothing here can say WHAT changed). */
function objectFieldDiff(a: Draw, b: Draw): string[] {
  const fa = drawFields(a);
  const fb = drawFields(b);
  const out: string[] = [];
  for (const [name, v] of fa) if (fb.get(name) !== v) out.push(name);
  for (const name of fb.keys()) if (!fa.has(name)) out.push(name);
  return out.sort();
}

/**
 * Which engine properties each drawing operation writes — copied from
 * `applyDrawOp`'s own switch (`pineRuntime.ts:2127-2196`), which is the ONLY way a
 * `set_*`/`delete` call reaches a drawing object. `delete` writes nothing but the
 * `deleted` flag: it can explain a record being ABSENT (`emitDrawings` skips
 * deleted objects, `pineRuntime.ts:2220-2221`), never a record whose FIELDS
 * differ — hence the empty list, and hence a `delete`-only script excuses no
 * content difference at all. An operation missing from this table is the engine's
 * `default:` arm (`pineRuntime.ts:2197-2199`, "harmless read, ignore"): the
 * corpus's 2 `label.set_tooltip` calls are exactly that — the engine has no
 * tooltip property and the compared record has no tooltip field, so they change
 * nothing here and excuse nothing.
 */
const PROPS_OF_OP: Record<string, readonly string[]> = {
  delete: [],
  set_text: ["text"],
  set_x: ["x"],
  set_x1: ["x"],
  set_left: ["x"],
  set_y: ["y"],
  set_y1: ["y"],
  set_top: ["y"],
  set_x2: ["x2"],
  set_right: ["x2"],
  set_y2: ["y2"],
  set_bottom: ["y2"],
  set_xy: ["x", "y"],
  set_xy1: ["x", "y"],
  set_xy2: ["x2", "y2"],
  // `set_color` is kind-dependent in the engine (`pineRuntime.ts:2163-2166`): a
  // label gets `bg`, anything else gets `color`. `RECORD_FIELD_OF_PROP` resolves
  // the difference per kind, so listing both props over-excuses nothing.
  set_color: ["bg", "color"],
  set_border_color: ["color"],
  set_bg_color: ["bg"],
  set_text_color: ["fg"],
  set_textcolor: ["fg"],
  set_width: ["width"],
  set_style: ["dashed"],
};

/** Which compared record field each engine property lands in, per kind — read off
 *  `emitDrawings` (`pineRuntime.ts:2222-2247`): `o.x` → `label.bar` / `line.x1` /
 *  `box.x1`, `o.y` → `label.price` / `line.y1` / `box.y1`, `o.color` → `line.color`
 *  / `box.border`, and a property the kind's record does not carry (`fg` on a box,
 *  `width` on a label) simply has no field to excuse. */
const RECORD_FIELD_OF_PROP: Record<"label" | "line" | "box", Record<string, string>> = {
  label: { x: "bar", y: "price", text: "text", bg: "bg", fg: "fg" },
  line: { x: "x1", y: "y1", x2: "x2", y2: "y2", color: "color", width: "width", dashed: "dashed" },
  box: { x: "x1", y: "y1", x2: "x2", y2: "y2", color: "border", bg: "bg" },
};

/** The fields the calls this script's source contains can actually change. */
function excusableFields(kind: "label" | "line" | "box", calls: readonly string[]): Set<string> {
  const out = new Set<string>();
  const props = RECORD_FIELD_OF_PROP[kind];
  for (const op of calls) {
    for (const p of PROPS_OF_OP[op] ?? []) {
      const f = props[p];
      if (f) out.add(f);
    }
  }
  return out;
}

/** Does this record carry a FINITE value, as opposed to a bare `na` placeholder?
 *  `label`/`line`/`box` records are emitted with their coordinates merely
 *  DEFINED (`o.y !== undefined`, `pineRuntime.ts:2223-2238`), so `label|0|na|…`
 *  is an empty placeholder: agreeing on one says nothing about the window, and it
 *  must not mark a script covered. */
function recordCarriesValue(d: Draw): boolean {
  if (d.kind === "label") return Number.isFinite(d.price);
  if (d.kind === "line" || d.kind === "box") return Number.isFinite(d.y1) || Number.isFinite(d.y2);
  return true;
}

/**
 * The bar a drawing record is anchored to: `label` carries `.bar`, `line`/`box`
 * carry `.x1` (both are `Math.round(xToBar(…))` of the object's own first
 * coordinate, `pineRuntime.ts:2220-2255`). `undefined` only for the kinds with
 * no anchor at all (`hline`, `table`), which never reach here.
 */
function anchorOf(d: Draw): number | undefined {
  if (d.kind === "label") return d.bar;
  if (d.kind === "line" || d.kind === "box") return d.x1;
  return undefined;
}

/**
 * The MUTATION MECHANISM, measured from the corpus source rather than from run
 * behaviour: `label.set_text` / `label.set_xy` / `label.set_x` /
 * `label.set_tooltip` / `line.set_xy1` / `line.set_xy2` / `label.delete` /
 * `line.delete` — the forms the corpus actually uses, counted on the wall by
 * `mutation calls in corpus source:` (measured 2026-10-07: 13 `label.set_text`,
 * 13 `line.delete`, 13 `label.delete`, 11 `label.set_xy`, 2 `label.set_x`,
 * 2 `label.set_tooltip`, 1 `line.set_xy1`, 1 `line.set_xy2`).
 * `statistics/gaps_percent_size_distribution.pine:100,145-155` is the corpus
 * example — a label created once and rewritten from inside `if barstate.islast`;
 * `statistics/linear_regression_all_data.pine:39-40` is the case that sets the
 * DIGIT-suffixed `line.set_xy1` / `line.set_xy2`, which is why the method name is
 * `(set|delete)[a-z0-9_]*` and not `set_[a-z_]*` — a stricter class left those two
 * calls unseen and reddened 5 records whose mechanism was on the next line (that
 * run belongs to the build this round replaced; what carries over is the reason the
 * class is wide — the engine's own case labels are `set_xy1`/`set_xy2`,
 * `pineRuntime.ts:2155,2159`, and this round's rule reads the SAME list to decide
 * which fields may be excused, so a call the scan misses is a field nothing here can
 * excuse).
 * Keyed by the object kind the call names, value the distinct calls found;
 * `excusableFields` turns that list into the FIELDS those calls can change, which
 * is what the content exemption is granted on — the kind is only the scope of the
 * search, never the exemption itself.
 * `delete` is in this scan for two reasons and not a third: the wall's inventory
 * should read like the corpus, and the EXISTENCE branch is where a `delete` does
 * explain something (`emitDrawings` skips deleted objects,
 * `pineRuntime.ts:2220-2221`). It is not in it because it excuses content:
 * `PROPS_OF_OP.delete` is the empty list, and taking `delete` out of this regex
 * changed not one count on this corpus — canary ⑥ in the header.
 *
 * Honest limits, stated because they are real: this is a SOURCE scan, so a
 * commented-out `label.set_text(` would satisfy it, and it says "this SCRIPT has
 * mutation calls that reach this FIELD", not "this object identity was mutated
 * after bar k". What it does buy is that the exemption can no longer be granted by
 * variance alone, nor by a call that cannot write the field that differs — an
 * object that changes in a way nothing in the source explains is reported
 * (`live-unexplained=`), not excused.
 */
const OBJECT_MUTATION_RE = /(?:^|[^.\w])(label|line|box)\.((?:set|delete)[a-z0-9_]*)\s*\(/g;

/**
 * Does this script build objects at the END of the run? Also source-measured:
 * `barstate.islast` present (`statistics/gaps_percent_size_distribution.pine:119`
 * opens the histogram block that calls `_line()`/`_label()`, and
 * `utils/unit_testing_framework.pine` / `statistics/linear_regression_all_data.pine`
 * are the other two). It is never a blanket exemption: both places that read it
 * pair it with measured conjuncts — `createdAfterEveryPrefix` in branch 4's
 * end-created verdict, and `creators` + `rebuiltAsItGrows` in arm 2b's
 * run-end-construction verdict.
 */
const RUN_END_RE = /barstate\.islast/;

function measureObjectMutators(src: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const m of src.matchAll(OBJECT_MUTATION_RE)) {
    const calls = out.get(m[1]) ?? [];
    if (!calls.includes(m[2])) calls.push(m[2]);
    out.set(m[1], calls);
  }
  return out;
}

/** Which object kinds this script constructs at all (`label.new(` / `line.new(` /
 *  `box.new(`). Paired with `RUN_END_RE` and the measured per-kind record counts
 *  (`rebuiltAsItGrows`) this is the evidence for the second content mechanism in
 *  `cmpObjectDrawings` arm 2b — construction, not mutation. A source scan cannot
 *  tell WHERE the construction runs: `statistics/gaps_percent_size_distribution.pine`
 *  builds its columns in the `_line()`/`_label()` helpers (lines 70-96) which the
 *  `if barstate.islast` block calls at line 131-133, so the `.new(` text sits in a
 *  function body, not inside the block. The count conjunct below is what pins it
 *  down to behaviour rather than leaving it at "the file mentions islast". */
const OBJECT_CREATE_RE = /(?:^|[^.\w])(label|line|box)\.new\s*\(/g;

function measureObjectCreators(src: string): Set<string> {
  const out = new Set<string>();
  for (const m of src.matchAll(OBJECT_CREATE_RE)) out.add(m[1]);
  return out;
}

/**
 * Which object IDENTITIES are run-end dependent, measured over ALL SIX runs of
 * one script (the five prefixes plus the full one). Key is `kind|identity`, the
 * value the measured reason.
 *
 * After the per-`k` rewrite this answers ONE question — does this identity's
 * very EXISTENCE move with the end of the run — and it is no longer what
 * exempts a content difference (see `cmpObjectDrawings`: content is decided at
 * the `k` it happened, against the mutation mechanism). See drawing rule 2.
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
      const present = seen.length;
      const inFull = states[states.length - 1] !== undefined;
      if (distinct > 1) {
        live.set(
          `${kind}|${i}`,
          `${present} 种喂法给出 ${distinct} 种状态（对象随喂到第几根而变，前 k 项投影不存在）`,
        );
      } else if (!inFull) {
        live.set(`${kind}|${i}`, `较短的喂法里有、全量里没有（对象在更晚的 bar 被删掉或重建）`);
      }
    }
  }
  return live;
}

/** How many records of each object kind each of the five prefixes emitted, in
 * `KS` order — the shape `createdAfterEveryPrefix` reads. A prefix that did not
 * compile reports `Number.MAX_SAFE_INTEGER`, i.e. the exemption is not granted. */
function measureKindCounts(prefixes: (PineResult | null)[]): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const kind of OBJECT_KINDS) {
    out.set(
      kind,
      prefixes.map((r) => (r ? r.drawings.filter((d) => d.kind === kind).length : Number.MAX_SAFE_INTEGER)),
    );
  }
  return out;
}

/**
 * Was index `i` of this kind created at the END of the full run rather than at a
 * bar inside the window? Two measured conjuncts, no engine fact invented:
 *   (a) NO prefix reaches index `i` — the object did not exist while any of them
 *       was running;
 *   (b) the per-kind count is non-decreasing with run length — `emitDrawings`
 *       walks `drawObjs.values()` in INSERTION order and skips deleted objects
 *       (`pineRuntime.ts:2220-2221`), so a count that only grows means index `i` is a
 *       SUFFIX append, not a renumbered survivor.
 * Used with `RUN_END_RE` (source) this is what makes
 * `statistics/gaps_percent_size_distribution.pine`'s 299th histogram column
 * legible: it is created at bar 299 and ANCHORED at `x=298`, so its coordinate
 * sits inside the window while its creation does not — a bare "anchor < k ⇒ red"
 * would call that a leak and be wrong about the engine.
 */
function createdAfterEveryPrefix(counts: number[] | undefined, i: number): boolean {
  if (!counts || !counts.length) return false;
  if (!counts.every((n) => n <= i)) return false;
  for (let j = 1; j < counts.length; j++) if (counts[j]! < counts[j - 1]!) return false;
  return true;
}

/**
 * Is this kind's object set REBUILT as the run grows? Measured over the five
 * prefixes: non-decreasing counts AND strictly more records at the longest prefix
 * than at the shortest (`statistics/gaps_percent_size_distribution.pine`'s `line`:
 * 59/119/179/239/298). That shape is what a run-end construction pass leaves
 * behind — the object set is a function of where the run ENDED — and it is what
 * makes index `i` of the k=60 run and index `i` of the full run the i-th object of
 * TWO CONSTRUCTIONS rather than one object one of the runs moved. A prefix that
 * did not compile reports `Number.MAX_SAFE_INTEGER`, so the test fails and the
 * exemption is not granted.
 */
function rebuiltAsItGrows(counts: number[] | undefined): boolean {
  if (!counts || counts.length < 2) return false;
  if (counts[counts.length - 1]! <= counts[0]!) return false;
  for (let j = 1; j < counts.length; j++) if (counts[j]! < counts[j - 1]!) return false;
  return true;
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
    c.drawings += 1;
    let walked = 0;
    for (let i = 0; i < k; i++) {
      walked += 1;
      if (a[i] !== b[i]) {
        note(
          s,
          `${kind} 第 ${i} 根颜色 前缀=${a[i] ?? "无"} 全量=${b[i] ?? "无"}（记录数 前缀=${ps.length} 全量=${fs.length}）`,
        );
        break;
      }
      if (a[i] !== null) s.informative = true;
    }
    if (walked > 0) {
      c.series += 1;
      c.values += walked;
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

/** Everything the drawing pass needs beyond the counters: the five measured
 * signals below (identity liveness, the per-kind mutation calls, the kinds the
 * script constructs, the per-kind record counts of the five prefixes, and the
 * `barstate.islast` flag) and the row collectors that make each skip visible on
 * the wall. No arm reads a filename list. */
interface Extras {
  /** Identity-level run-end dependence over all six runs (`measureObjectLiveness`). */
  readonly live: Map<string, string>;
  /** Per-kind mutation calls found in this script's source (`measureObjectMutators`);
   *  `excusableFields` turns them into the record fields they can write. */
  readonly mutators: Map<string, string[]>;
  /** Object kinds this script constructs at all (`measureObjectCreators`). */
  readonly creators: Set<string>;
  /** Per-kind record counts of the five prefixes, in `KS` order. */
  readonly kindCounts: Map<string, number[]>;
  /** Source contains `barstate.islast` (`RUN_END_RE`). */
  readonly runEnd: boolean;
  readonly liveReasons: Set<string>;
  readonly afterCutRows: Set<string>;
  readonly tailRows: Set<string>;
  readonly belowCutRows: Set<string>;
  readonly endCreatedRows: Set<string>;
}

/**
 * Object drawings (`label` / `line` / `box`), decided PER (script, k).
 *
 * `emitDrawings` emits ONE record per surviving object holding its FINAL state
 * (`pineRuntime.ts:2220-2255`), so the two records of one identity are the same
 * object at two ends of one mutation sequence. Four branches, narrowest first:
 *   1. equal at this k → compared like any other record (per-`k` exemption: a
 *      longer prefix mutating the object later no longer excuses this one);
 *   2. both sides have this index and the content differs → two arms, tried in
 *      order and each with its own counter and ceiling: 2a FIELD BY FIELD, where
 *      every field that actually differs must be one a call found in this script's
 *      source can change (`excusableFields`, built from the engine's own
 *      `applyDrawOp` switch) — a `delete` writes no field, so it never excuses this
 *      arm; 2b RUN-END CONSTRUCTION, for the fields no call writes, gated on three
 *      measured conjuncts (`barstate.islast` in the source, this kind constructed,
 *      this kind's record count non-decreasing and growing with the run). Nothing
 *      explaining it → reported, not excused (`live-unexplained`, pinned at 0);
 *   3. prefix-only → the identity-level flag excuses the record's ABSENCE. The
 *      flag is set by construction here (`a && !b` is precisely the shape
 *      `measureObjectLiveness` records), so there is no second path in this branch
 *      and this file deletes provably-dead code instead of commenting it;
 *   4. full-only → the identity flag excuses the re-counted creation order (its
 *      anchor measured, printed and pinned); otherwise the anchor is CHECKED:
 *      `>= k` after-cut, `< k` either end-created (`barstate.islast` + an index no
 *      shorter run reaches — `anchorOf` is a coordinate, not a creation bar) or RED.
 * Measured outcome per branch on this corpus, 2026-10-07: 2a excuses 238 records,
 * 2b excuses 892, branch 3 fires on NONE (all 718 existence records are full-only
 * ones from branch 4 — the header's forced-build measurement shows it, because that
 * build empties the liveness map but not this unconditional arm, and still prints
 * `existence=0`), branch 4 gives 4 records `>= k`, 1 end-created and 0 red, and
 * `unexplained` is 0 in both content paths. So `live` = 238 + 892 + 718 = 1848, and
 * the identity assertion at the bottom of the file makes those buckets add up to it
 * on every run. Branch 1's compared records are inside the wall's `drawings=368`,
 * which also counts rule 1's `fill` comparisons.
 */
function cmpObjectDrawings(s: Sink, p: Draw[], f: Draw[], k: number, c: Counts, x: Extras): void {
  for (const kind of OBJECT_KINDS) {
    const ps = p.filter((d) => d.kind === kind);
    const fs = f.filter((d) => d.kind === kind);
    const calls = x.mutators.get(kind) ?? [];
    const excusable = excusableFields(kind, calls);
    for (let i = 0; i < Math.max(ps.length, fs.length); i++) {
      const a = ps[i];
      const b = fs[i];
      const tag = `${kind}|${i}`;
      const why = x.live.get(tag);
      // (1) same state at this k as at the end of the full run → COMPARED, hard,
      // even when a longer prefix mutates this object afterwards. This is what
      // "exempt per (script, k)" buys. Coverage is earned by a record that carries
      // a value: agreement on a bare `label|0|na|…` placeholder says nothing about
      // the window and must not mark the script covered.
      if (a && b && drawKey(a) === drawKey(b)) {
        c.drawings += 1;
        if (recordCarriesValue(b)) s.informative = true;
        continue;
      }
      // (2) same identity, different end of the sequence — two mechanisms, tried
      // in order, each named on the wall:
      //   2a MUTATION, field by field: every differing field must be one a call
      //      found in this script's source can write. `delete` is in the source
      //      inventory but writes no field, so it stops being an excuse once the
      //      difference is in a FIELD rather than in the record's existence.
      //   2b CONSTRUCTION at the run's end, for the fields no call writes: this
      //      script has a `barstate.islast` block, constructs this kind, and the
      //      measured per-kind record count grows with the run
      //      (`rebuiltAsItGrows`) — so the two records are the i-th object of two
      //      different construction passes, and their args were evaluated at two
      //      different ends. This arm is the object-channel hole the design §10
      //      ruling accepted; it is counted, capped and named here rather than
      //      folded into the mutation excuse.
      if (a && b) {
        const diff = objectFieldDiff(a, b);
        if (diff.length > 0 && diff.every((field) => excusable.has(field))) {
          c.live += 1;
          c.liveMutating += 1;
          x.liveReasons.add(`${s.rel} ${tag} — 源码对 ${kind} 有 ${calls.join("/")} 调用，同一对象在更长的喂法里还会变`);
          continue;
        }
        if (x.runEnd && x.creators.has(kind) && rebuiltAsItGrows(x.kindCounts.get(kind))) {
          c.live += 1;
          c.liveRunEndBuilt += 1;
          x.liveReasons.add(
            `${s.rel} ${tag} — ${kind} 在 barstate.islast 的建造里重建（条数 ${(x.kindCounts.get(kind) ?? []).join("/")}），` +
              `差异字段「${diff.join(",") || "无具名字段"}」无人写入`,
          );
          continue;
        }
        c.live += 1;
        c.liveUnexplained += 1;
        note(
          s,
          `${kind} 第 ${i} 项在 k=${k} 的内容与全量末端不同，而差异字段「${diff.join(",") || "无具名字段"}」既不属于源码 ` +
            `${kind} 调用（${calls.join("/") || "无"}）能改到的字段（${[...excusable].sort().join(",") || "无"}），` +
            `也不是「run 末端重建」那条（runEnd=${x.runEnd} 建造 ${kind}=${x.creators.has(kind)} 条数随喂法长=${rebuiltAsItGrows(
              x.kindCounts.get(kind),
            )}）：` +
            `前缀=${drawKey(a)} 全量=${drawKey(b)}（不是「对象在 k 之后被改过」，按字面差异处理）`,
        );
        continue;
      }
      // (3) the prefix has it, the full run does not: the object was deleted (or
      // rebuilt) at a bar the shorter run never reached — `emitDrawings` skips
      // deleted objects (`pineRuntime.ts:2220-2221`), which is the ONLY thing a
      // `delete` can explain. `measureObjectLiveness` flags exactly this shape, so
      // `why` is set here by construction and there is no second arm to keep. Its
      // anchor is still MEASURED: `existence-anchor-below-k=` is that hole, printed
      // and pinned.
      if (a && !b) {
        const an = anchorOf(a);
        c.live += 1;
        c.liveExistence += 1;
        if (an !== undefined && an < k) c.liveExistenceBelowCut += 1;
        if (an !== undefined && an < k && x.belowCutRows.size < 8) {
          x.belowCutRows.add(`${s.rel} ${tag} k=${k} — 前缀这条记录锚在第 ${an} 根（< k），全量里它已经不存在`);
        }
        x.liveReasons.add(`${s.rel} ${tag} — ${why ?? "较短的喂法里有、全量里没有（对象在更晚的 bar 被删掉或重建）"}`);
        continue;
      }
      // (4) only the FULL run has it, and the identity itself did NOT move between
      // runs. The anchor is CHECKED here instead of assumed — with one correction
      // the measurement forced on me: `anchorOf` returns a drawing COORDINATE
      // (`Math.round(xToBar(o.x))`, `pineRuntime.ts:2229-2247`), not the bar the
      // object was created on, so "anchor < k" is not by itself evidence of a leak;
      // it says the coordinate lies inside the window. Three verdicts, each pinned:
      //   • anchor >= k → after-cut (created past the cut, nothing in the window);
      //   • anchor < k but the object was BUILT AT THE RUN'S END (`x.runEnd` from
      //     the source, `createdAfterEveryPrefix` from the six runs) → end-created:
      //     creation bar is the full run's last bar (299), which is past every cut
      //     in `KS`, while its column sits on bar 298;
      //   • neither → RED (`after-cut-unexplained=`), pinned at 0. That is the gate
      //     the reviewer asked for; it fires on nothing today, which is why the two
      //     positive categories carry their own measured ceilings.
      // When the identity DOES move (`why`), index pairing carries no information
      // for any anchor check to convict — `statistics/
      // gaps_percent_size_distribution.pine:145-155` draws one column per bucket
      // inside `if barstate.islast`, so index 239 of the k=240 run and index 239 of
      // the full run are different objects. Exempted, counted, and its anchor
      // MEASURED: `existence-anchor-below-k=` is that hole, on the wall.
      const full = b!;
      const an = anchorOf(full);
      if (why) {
        c.live += 1;
        c.liveExistence += 1;
        if (an !== undefined && an < k) {
          c.liveExistenceBelowCut += 1;
          if (x.belowCutRows.size < 8) {
            x.belowCutRows.add(`${s.rel} ${tag} k=${k} — 全量这条记录锚在第 ${an} 根（< k），索引配对本身随喂法移动`);
          }
        }
        x.liveReasons.add(`${s.rel} ${tag} — ${why}`);
        continue;
      }
      if (an === undefined) {
        c.afterCutBelowCut += 1;
        note(s, `${kind} 第 ${i} 项只有全量有，而这条记录没有 bar 锚点可查：全量=${drawKey(full)}`);
        continue;
      }
      if (an >= k) {
        c.afterCut += 1;
        x.afterCutRows.add(`${s.rel} ${tag} k=${k} — 锚在第 ${an} 根（>= k）：${drawKey(full)}`);
        continue;
      }
      if (x.runEnd && createdAfterEveryPrefix(x.kindCounts.get(kind), i)) {
        c.afterCutEndCreated += 1;
        x.endCreatedRows.add(
          `${s.rel} ${tag} k=${k} — 锚点 ${an} 在窗口内，但没有任何更短的喂法够到这个索引，且 ${kind} 的条数随喂法单调不减（${(x.kindCounts.get(kind) ?? []).join("/")}/${fs.length}）：${drawKey(full)}`,
        );
        continue;
      }
      c.afterCutBelowCut += 1;
      note(
        s,
        `${kind} 第 ${i} 项只有全量有，锚在第 ${an} 根（< k=${k}），而「末端造物」的三条证据都不成立` +
          `（更短的喂法也到过这个索引 / 该 kind 的条数不单调 / 源码无 barstate.islast）：全量=${drawKey(full)}`,
      );
    }
  }
}

function cmpDrawings(s: Sink, p: Draw[], f: Draw[], k: number, c: Counts, x: Extras): void {
  c.tables += Math.max(
    p.filter((d) => d.kind === "table").length,
    f.filter((d) => d.kind === "table").length,
  );
  cmpBarIndexedDrawings(s, p, f, k, c);
  cmpObjectDrawings(s, p, f, k, c, x);
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
  for (const kk of new Set([...pg.keys(), ...fg.keys()])) {
    const ps = pg.get(kk) ?? [];
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
  x: Extras,
): void {
  cmpLines(s, pre.result.lines, full.result.lines, k, c);
  cmpMarkers(s, pre.result.markers, full.result.markers, k, c);
  cmpHlines(s, pre.result.hlines, full.result.hlines, k, c, x.tailRows);
  cmpDrawings(s, pre.result.drawings, full.result.drawings, k, c, x);
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
    // 「独立影线 ⇒ 严格局部极值存在」是文件头列为承重的那条性质，这里断言它，
    // 不再只写在注释里：把 high/low 绑到相邻收盘上，pivot/fractal/zigzag 一类
    // 脚本就永远不出值，比较会退化成 na 对 na（本仓踩过的空转通过）。
    // 实测：300 根里 86 根严格高点、86 根严格低点；最短探针 k=60 里 18/17。
    const pivotHigh = (list: KLineData[]) => {
      let n = 0;
      for (let i = 1; i < list.length - 1; i++) {
        if (list[i].high > list[i - 1].high && list[i].high > list[i + 1].high) n += 1;
      }
      return n;
    };
    const pivotLow = (list: KLineData[]) => {
      let n = 0;
      for (let i = 1; i < list.length - 1; i++) {
        if (list[i].low < list[i - 1].low && list[i].low < list[i + 1].low) n += 1;
      }
      return n;
    };
    expect(pivotHigh(BARS), "严格局部高点数（实测 86/300）").toBeGreaterThanOrEqual(60);
    expect(pivotLow(BARS), "严格局部低点数（实测 86/300）").toBeGreaterThanOrEqual(60);
    // 每个探针长度自己也要有极值，否则最短那一档是在空比
    for (const k of KS) {
      const pre = BARS.slice(0, k);
      expect(pivotHigh(pre), `k=${k} 前缀的严格高点数（k=60 实测 18）`).toBeGreaterThan(5);
      expect(pivotLow(pre), `k=${k} 前缀的严格低点数（k=60 实测 17）`).toBeGreaterThan(5);
    }
    // Step 4 的实测前提：宿主周期必须被推断成恰好 1 天。逐个 k 的同一条针搬进
    // 下面那条比较 test 的前置里了——两条 test 相互独立，留在这里只会让周期漂移
    // 在比较跑完之后的下一条 test 才红。
    expect(inferTimeframeMs(toBars(BARS)), "宿主周期必须是恰好 1 天").toBe(DAY_MS);
  });

  it("每个脚本、每个 k：前 k 根喂进去的结果必须等于全量的前 k 项", () => {
    const c: Counts = {
      series: 0,
      values: 0,
      naDropped: 0,
      tables: 0,
      drawings: 0,
      live: 0,
      liveMutating: 0,
      liveRunEndBuilt: 0,
      liveExistence: 0,
      liveExistenceBelowCut: 0,
      liveUnexplained: 0,
      afterCut: 0,
      afterCutEndCreated: 0,
      afterCutBelowCut: 0,
      hlines: 0,
      hlineTail: 0,
    };
    // Step 4 的前提在比较之前现场核一遍（原来只有那条输入 test 里有）：两条 test
    // 相互独立，周期漂移若留到下一条才红，比较已经白跑了一轮。
    expect(inferTimeframeMs(toBars(BARS)), "宿主周期必须是恰好 1 天，否则 HTF 分桶在两种喂法下不是同一个函数").toBe(DAY_MS);
    for (const k of KS) {
      expect(inferTimeframeMs(toBars(BARS.slice(0, k))), `k=${k} 的周期推断也必须是 1 天`).toBe(DAY_MS);
    }
    let failed = 0;
    let aborted = 0;
    const abortedFiles: string[] = [];
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
    const failedFiles: string[] = [];
    const perFile: { rel: string; isMtf: boolean; diffs: string[]; hits: MechHit[] }[] = [];
    const liveReasons = new Set<string>();
    const afterCutRows = new Set<string>();
    const endCreatedRows = new Set<string>();
    const tailRows = new Set<string>();
    const belowCutRows = new Set<string>();
    const mutationCalls = new Map<string, number>();
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
          failedFiles.push(`${rel} — ${full.error}`);
          continue;
        }
        ran += 1;
        if (full.abort) {
          aborted += 1;
          abortedFiles.push(`${rel} — ${full.abort}`);
        }
        const isMtf = MTF_RE.test(src) || (full.result.lowerTfMs?.length ?? 0) > 0;
        if (isMtf) mtfScripts += 1;
        else plainScripts += 1;

        // All five prefix runs first: the object-drawing liveness verdict is a
        // measurement over the whole sweep, not a per-k guess. The mutation
        // mechanism is read off the SOURCE, so it is known before any run.
        const prefixes = KS.map((k) => compilePine(src, BARS.slice(0, k), {}));
        const results: PineResult[] = [];
        for (const p of prefixes) if (!("error" in p)) results.push(p.result);
        results.push(full.result);
        const mutators = measureObjectMutators(src);
        const kindCounts = measureKindCounts(prefixes.map((p) => ("error" in p ? null : p.result)));
        const runEnd = RUN_END_RE.test(src);
        for (const m of src.matchAll(OBJECT_MUTATION_RE)) {
          const name = `${m[1]}.${m[2]}`;
          mutationCalls.set(name, (mutationCalls.get(name) ?? 0) + 1);
        }
        const live = measureObjectLiveness(results);
        const x: Extras = {
          live,
          mutators,
          creators: measureObjectCreators(src),
          kindCounts,
          runEnd,
          liveReasons,
          afterCutRows,
          tailRows,
          belowCutRows,
          endCreatedRows,
        };

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
            cmpArtifact(s, pre, full, k, c, x);
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
        `na-dropped=${c.naDropped}\n`,
    );
    // Every record this gate does NOT compare is on this line, with the reason
    // counter it is excused on. Nothing here is a prose claim.
    process.stdout.write(
      `  exempted: live-objects=${c.live} (mutating=${c.liveMutating} run-end-built=${c.liveRunEndBuilt} ` +
        `existence=${c.liveExistence} ` +
        `existence-anchor-below-k=${c.liveExistenceBelowCut} unexplained=${c.liveUnexplained}) ` +
        `after-cut-objects=${c.afterCut} after-cut-end-created=${c.afterCutEndCreated} ` +
        `after-cut-unexplained=${c.afterCutBelowCut} ` +
        `hlines-tail-skipped=${c.hlineTail} tables-skipped=${c.tables}\n`,
    );
    if (failedFiles.length) process.stdout.write(`  failed runs: ${failedFiles.join(" | ")}\n`);
    if (abortedFiles.length) process.stdout.write(`  aborted runs: ${abortedFiles.join(" | ")}\n`);
    process.stdout.write(
      `  mutation calls in corpus source: ${[...mutationCalls.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([x, n]) => `${x}=${n}`)
        .join(", ") || "none"}\n`,
    );
    process.stdout.write(
      `  mismatched: plain=${plainMismatched} mtf=${mtfMismatched} register=${mismatchKeys.length} (files: ${mismatchKeys
        .slice(0, 6)
        .join(", ")})\n`,
    );
    // Uncapped on purpose: the header argues from this list, so the argument has
    // to be readable off the wall, not off a truncated print.
    process.stdout.write(
      `  non-informative (nothing but \`na\` produced on these bars): ${nonInformative.length}: ${nonInformative.join(", ")}\n`,
    );
    // Identities, not records: `live-objects=1848` is 1848 RECORD comparisons
    // spread over the (script, identity) pairs named here.
    const liveIdentities = new Set([...liveReasons].map((r) => r.slice(0, r.indexOf(" — ")))).size;
    process.stdout.write(
      `  live drawing objects (run-end dependent: ${liveIdentities} (script, identity) pairs exempted, ${liveReasons.size} reason rows):\n`,
    );
    for (const r of [...liveReasons].sort().slice(0, 24)) process.stdout.write(`    live: ${r}\n`);
    if (afterCutRows.size) {
      process.stdout.write(`  after-cut object records (${afterCutRows.size}, anchor >= k checked, not assumed):\n`);
      for (const r of [...afterCutRows].sort()) process.stdout.write(`    ${r}\n`);
    }
    if (endCreatedRows.size) {
      process.stdout.write(
        `  end-created object records (${c.afterCutEndCreated}, anchor < k but built on the run's last bar):\n`,
      );
      for (const r of [...endCreatedRows].sort()) process.stdout.write(`    ${r}\n`);
    }
    if (tailRows.size) {
      process.stdout.write(`  hline tail records (${tailRows.size}):\n`);
      for (const r of [...tailRows].sort()) process.stdout.write(`    ${r}\n`);
    }
    if (belowCutRows.size) {
      process.stdout.write(
        `  existence records anchored BELOW the cut (${c.liveExistenceBelowCut} counted, first ${belowCutRows.size} shown):\n`,
      );
      for (const r of [...belowCutRows].sort()) process.stdout.write(`    ${r}\n`);
    }
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
    // evaluated at every k in the probe set. The WORK floors are per-script
    // averages against `ran`, not absolutes. The arithmetic, on this build's wall: an
    // absolute `> 400_000` under a measured 460 826 sits 60 826 values below it, and
    // at the measured 2 194 values per script (460 826/210) that is ~28 scripts'
    // worth of comparison free to vanish while the gate stayed green — the comment
    // above the old literal claimed room for ONE removed file. Kept relative, the
    // floor binds on the average instead: 2 000 of a measured 2 194 per script, so a
    // script that stops contributing VALUES reddens even if `ran` itself holds, and a
    // smaller corpus lowers the bar honestly rather than silently gaining slack. The
    // remaining slack is stated as arithmetic, not prose — every multiple below sits
    // at 86–91% of its measured per-script average (values 2 000 vs 2 194, series 10
    // vs 11.0, hlines 4 vs 4.4, drawings 1.5 vs 1.75), which is ~18 scripts' worth of
    // work for the first three and ~29 for `drawings`, all of it below one whole file
    // per script.
    expect(pairs, "(script, k) 对必须是 已比较脚本 × 探针长度").toBe(ran * KS.length);
    expect(ran, "跑通并可比较的脚本数掉了：语料遍历或解释器坏了（实测 210）").toBeGreaterThanOrEqual(200);
    expect(plainScripts + mtfScripts, "分档必须覆盖每个跑通的脚本").toBe(ran);
    expect(mtfScripts, "多周期档的脚本数（实测 7）").toBeGreaterThanOrEqual(6);
    // Measured averages, COMPUTED in the message rather than retyped into it: a
    // caption that has to be edited every run is a caption that goes stale (this
    // one said 2 186 while the measured value was 460 826/210 = 2 194). The
    // multiples below are the ones the paragraph above prices out.
    const avg = (n: number): string => (n / ran).toFixed(2);
    expect(
      c.values,
      `平均每个脚本至少比到 2 000 个逐 bar 的值（实测 ${c.values} / ${ran} = ${avg(c.values)}）`,
    ).toBeGreaterThanOrEqual(ran * 2_000);
    expect(
      c.series,
      `平均每个脚本至少比到 10 条序列（实测 ${c.series} / ${ran} = ${avg(c.series)}）`,
    ).toBeGreaterThanOrEqual(ran * 10);
    expect(
      c.hlines,
      `平均每个脚本至少比到 4 条 hline（实测 ${c.hlines} / ${ran} = ${avg(c.hlines)}）`,
    ).toBeGreaterThanOrEqual(ran * 4);
    expect(
      c.drawings,
      `平均每个脚本至少严格比到 1.5 条画线记录（实测 ${c.drawings} / ${ran} = ${avg(c.drawings)}；其余走 exempted 那行）`,
    ).toBeGreaterThanOrEqual(Math.round(ran * 1.5));
    // The comparison must not be `na` against `na` all the way down: a script
    // only counts as covered once a FINITE value (or a fired alert, or a compared
    // drawing record) actually sat in the window and was compared.
    expect(informativeScripts + nonInformative.length, "信息/非信息两档必须盖过每个跑通的脚本").toBe(passed);
    expect(
      informativeScripts,
      `真有值在比的脚本数不得低于跑通脚本的 85%（实测 ${informativeScripts}/${ran} = ${Math.round(
        (informativeScripts / ran) * 100,
      )}%）`,
    ).toBeGreaterThanOrEqual(Math.round(ran * 0.85));
    // The two buckets that SHRINK the comparison are pinned like the ones that
    // add work to it. `failed` produces no comparison at all, so it is 0 or the
    // corpus broke; `aborted` matters because a run that stops at bar 1 compares
    // `na` against `na` at every later bar and passes for free — the floor above
    // is what keeps that from becoming the whole gate, and the pin below is the
    // exact sorted LIST of which files they are, because 2 files with different
    // names in them are a different hole and a count of 2 would not have noticed.
    expect(failed, `全量 run 直接返回 error 的脚本数（实测 ${failed}）：没东西可比不等于通过`).toBe(0);
    expect(
      abortedFiles.map((x) => x.split(" — ")[0]).sort(),
      `中途 abort 的脚本名单（实测 ${aborted} 本）：中断之后的 bar 两侧都是 na、比的是空，` +
        `所以钉的是「哪两本」而不是「几本」——换了名字就换了机制，计数相同也不算同一条洞`,
    ).toEqual(["statistics/kendall_rank_correlation_coefficient.pine", "volatility/mayer_multiple.pine"]);
    // The header argues that the two `offset = (-i * space)` dashboards are not
    // vacuous passes. That is asserted, not read off a truncated print — and it is
    // asserted the strong way: the two names must stay OUT of the `non-informative`
    // list, which is the same fact the paragraph above argues by sorting order.
    for (const rel of [
      "statistics/dividends_per_share_dps_yearly.pine",
      "statistics/earnings_per_share_eps_yearly.pine",
    ]) {
      expect(nonInformative, `${rel} 掉进了 non-informative 档：文件头「它的 offset=0 序列真在被逐根比对」一句失效`).not.toContain(
        rel,
      );
    }
    // The gate itself must not be the thing that breaks.
    expect(crashed, "harness 自己抛异常").toBe(0);
    expect(passed + mismatched, "passed + mismatched 必须等于跑通的脚本数").toBe(ran);

    /* ------------------------------------------------ the skip inventory */
    // Every one of these numbers is a hole with a size on it. They are pinned so
    // a hole can only grow by somebody reading the number and saying so.
    expect(
      c.liveUnexplained,
      `内容随喂法而变、既没有「源码里的 ${OBJECT_KINDS.join("/")} 调用写得到该字段」也没有「run 末端重建」` +
        `可解释的画线记录（实测 ${c.liveUnexplained}，必须 0）——非 0 就是「对象通道里出现了无法解释的差异」，` +
        `见文件头 drawing rule 2`,
    ).toBe(0);
    expect(
      c.afterCutBelowCut,
      `只有全量有、锚点 < k、而「末端造物」的三条证据（源码有 barstate.islast + 没有任何更短喂法够到这个索引 + ` +
        `该 kind 条数随喂法单调）都不成立的对象记录` +
        `（实测 ${c.afterCutBelowCut}，必须 0）：那就是更晚的 bar 在窗口里造出来的记录`,
    ).toBe(0);
    // The two positive categories, ceilings pinned from the same measurement the
    // header quotes (2026-10-07: all 5 records are one identity, `line|298` of
    // `statistics/gaps_percent_size_distribution.pine` — 4 of them anchored at 298
    // ≥ k, the k=299 one anchored at 298 < k and end-created).
    expect(
      c.afterCut,
      `锚点 >= k 的「只有全量有」对象记录（实测 ${c.afterCut}）：切点之后创建的画线，只许登记这么多`,
    ).toBeLessThanOrEqual(4);
    expect(
      c.afterCutEndCreated,
      `锚点 < k 但由 barstate.islast 在 run 末端创建的对象记录（实测 ${c.afterCutEndCreated}）：` +
        `画线的 x 是坐标不是创建 bar（pineRuntime.ts:2229），这条只能命名不能算违规，但也不许悄悄长`,
    ).toBeLessThanOrEqual(1);
    expect(c.live, `被豁免的对象画线记录总数（实测 ${c.live}）只许按登记的口径长`).toBeLessThanOrEqual(1_848);
    // `existence-anchor-below-k` is the biggest single hole inside `live` — 288
    // of the 718 existence records are anchored below their own cut, where index
    // pairing carries no information for any anchor check to convict. It was a
    // printed number with no gate under it; now it is a capped one, same shape as
    // the `live` ceiling above. That ceiling's bite was proven by lowering it one
    // notch in a scratch copy (canary ④ — a round-1-build run, see the header; the
    // 1 848 it caps is identical in both builds), and THIS bucket's bite is proven by
    // canary ⑦ lowering `run-end-built` from 892 to 891 on this build.
    expect(
      c.liveExistenceBelowCut,
      `被豁免的存在性记录里锚点在切点以下的条数（实测 ${c.liveExistenceBelowCut}）：` +
        `这条洞靠索引配对撑着，只许按登记的口径长`,
    ).toBeLessThanOrEqual(288);
    expect(
      c.liveMutating,
      `内容差异被「源码里的调用写得到该字段」逐字段豁免掉的记录数（实测 ${c.liveMutating}）：` +
        `豁免从严到只能按字段对上调用（「delete」写不到任何字段），这个数只许按登记的口径长`,
    ).toBeLessThanOrEqual(238);
    expect(
      c.liveRunEndBuilt,
      `内容差异被「run 末端重建」豁免掉的记录数（实测 ${c.liveRunEndBuilt}）：barstate.islast + 本 kind 有 .new + ` +
        `条数随喂法单调长，这是设计 §10 认下的对象通道洞本身，只许按登记的口径长`,
    ).toBeLessThanOrEqual(892);
    expect(
      c.liveExistence,
      `存在性豁免的记录数（实测 ${c.liveExistence}）：对象身份本身随「喂到第几根」增减（六根走查量出来的存活度旗标），` +
        `本语料上这 ${c.liveExistence} 条全部来自「只有全量有」那一侧、前缀-only 那条命中 0 条；` +
        `豁免建立在跨 run 方差上而不是机制上，所以这条洞只许按登记的口径长`,
    ).toBeLessThanOrEqual(718);
    expect(
      c.liveMutating + c.liveRunEndBuilt + c.liveExistence + c.liveUnexplained,
      `四个桶必须正好铺满 live（实测 ${c.liveMutating}+${c.liveRunEndBuilt}+${c.liveExistence}+` +
        `${c.liveUnexplained} 对 ${c.live}）：豁免不许在桶之间悄悄迁移——换了机制口径就得有人同时动这条 identity ` +
        `与上面四条上限`,
    ).toBe(c.live);
    expect(
      c.naDropped,
      `全量独有、窗口里什么都没有（全 na / 告警没命中）的合法摘除条数（实测 ${c.naDropped}）：` +
        `它印在 compared: 那行而不是 exempted:，签名组取并集之后 droppedFull 会收到只有全量才有的组，` +
        `所以它同样只许按登记的口径长`,
    ).toBeLessThanOrEqual(71);
    expect(
      c.drawings / (c.drawings + c.live),
      `画线里被严格比到的份额（实测 ${c.drawings}/${c.drawings + c.live} = ${(
        (c.drawings / (c.drawings + c.live)) *
        100
      ).toFixed(1)}%）不得低于 15%`,
    ).toBeGreaterThanOrEqual(0.15);
    expect(
      c.hlineTail,
      `全量比前缀多出的 hline 条数（实测 ${c.hlineTail}）：hline 记录没有 bar 锚点（pineTypes.ts:304），` +
        `这条尾巴比不了，但也不许悄悄长出来`,
    ).toBe(0);
    expect(c.tables, `table 画线跳过条数（实测 ${c.tables}）：没有 bar 锚点，见文件头`).toBeLessThanOrEqual(0);

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
    // A row must name the channel the differences were MEASURED on. Deriving it
    // from `MechHit.shape` (recorded at the matcher branch that fired) is what
    // makes this checkable: an `e.channel !== ""` test against four hard-coded
    // "line" rows can never fail, so it was not a gate.
    const channelOf = new Map<string, string[]>();
    for (const e of perFile) channelOf.set(e.rel, [...new Set(e.hits.map((h) => CHANNEL_OF_SHAPE[h.shape]))].sort());
    const channelBad = observed
      .map((key) => {
        const row = LOOKAHEAD_REGISTER.find((e) => registerKey(e) === key);
        const got = channelOf.get(key) ?? [];
        return { key, want: row?.channel ?? "（无登记行）", got: got.join("/") || "（无实测命中）" };
      })
      .filter((x) => x.got !== x.want);
    expect(
      channelBad,
      `登记行写的通道与实测出差异的通道不一致（通道由 MechHit.shape 推出，不是自述）：\n${channelBad
        .map((x) => `  · ${x.key} 登记=${x.want} 实测=${x.got}`)
        .join("\n")}`,
    ).toEqual([]);
    process.stdout.write(
      `  register channels: ${observed.map((k) => `${k}=${(channelOf.get(k) ?? []).join("/")}`).join(", ")}\n`,
    );
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
