/**
 * Sub-pane indicator registry and per-view persistence (local custom ㉛).
 *
 * Before this file the pro chart had exactly two sub panes, hardcoded at mount
 * (`createIndicator({ name: "VOL", … })` then `MACD`), and the only way to get a
 * third was to write a formula in the script workbench. That is the wrong shape
 * for two reasons the 分时 view makes obvious:
 *
 * 1. **MACD on a 分时 is not a blank pane by accident.** The line carries one
 *    trading day of 1-minute closes — 331 bars for a full HK session, verified
 *    against a live OpenD on 2026-09-10 — and MACD(12,26,9) emits nothing for
 *    the first ~33 of them. Mid-morning there are thirteen bars, so the pane is
 *    empty *on schedule*. Every broker's 分时 sub-chart is 成交量 for that
 *    reason, and that is now the default here.
 * 2. **A fixed pane set cannot be a feature.** "Which sub chart do I want" is a
 *    user decision, and the K线 view legitimately wants two.
 *
 * So the pane set becomes state: one ordered list per view, persisted, editable
 * from the toolbar. This module owns *what may be chosen* and *what is remembered*;
 * the chart page owns applying it, because only the page holds the chart.
 *
 * It also owns the display names, which used to live in a `SUB_PANE_LABELS`
 * literal inside `ProChart.tsx`. They moved here rather than being copied: the
 * pane label, the drawing manifest's "which sub chart is this line on" badge
 * (⑲) and this picker all read the same name for the same pane, and 项目档案.md
 * entry 46 is the record of what two copies of one naming rule do.
 */

import { subPaneIdOf } from "./paneLayout";

/**
 * The built-in indicators KLineChart 10.0.3 registers out of the box, minus the
 * ones whose `series` is `"price"` — `AVP`, `BOLL`, `BBI`, `EMA`, `MA`, `SMA`,
 * `SAR`. Those are main-chart overlays: dropping one onto a sub pane gives it a
 * price scale of its own next to bars it has nothing to do with, and `MA` is
 * already managed by `syncPriceOverlay`, which would fight the picker over the
 * same pane on every view change.
 *
 * Read off the library's own registrations (`name: '…'` / `series: 'price'`
 * pairs at dist 3288-5001), not from a documentation page, so the list cannot
 * drift from what `createIndicator` will actually accept.
 */
export interface SubIndicatorPreset {
  /** The token `createIndicator({ name })` takes. */
  name: string;
  /** What a Chinese trading terminal calls it; the pane legend is the library's own. */
  label: string;
  /** The expansion of the acronym, shown as the button's tooltip. */
  hint: string;
}

export const BUILTIN_SUB_INDICATORS: readonly SubIndicatorPreset[] = [
  { name: "VOL", label: "成交量", hint: "成交量柱与均量线" },
  { name: "MACD", label: "MACD", hint: "平滑异同移动平均线（DIF/DEA/柱）" },
  { name: "KDJ", label: "KDJ", hint: "随机指标" },
  { name: "RSI", label: "RSI", hint: "相对强弱指标" },
  { name: "WR", label: "WR", hint: "威廉指标" },
  { name: "BIAS", label: "BIAS", hint: "乖离率" },
  { name: "CCI", label: "CCI", hint: "顺势指标" },
  { name: "DMI", label: "DMI", hint: "趋向指标" },
  { name: "VR", label: "VR", hint: "成交量比率" },
  { name: "OBV", label: "OBV", hint: "能量潮" },
  { name: "PSY", label: "PSY", hint: "心理线" },
  { name: "ROC", label: "ROC", hint: "变动率指标" },
  { name: "MTM", label: "MTM", hint: "动量指标" },
  { name: "TRIX", label: "TRIX", hint: "三重指数平滑平均线" },
  { name: "BRAR", label: "BRAR", hint: "人气意愿指标" },
  { name: "CR", label: "CR", hint: "带状能量线" },
  { name: "DMA", label: "DMA", hint: "平均线差" },
  { name: "EMV", label: "EMV", hint: "简易波动指标" },
  { name: "AO", label: "AO", hint: "动量分形" },
];

/** Names this module is willing to mount. Anything else in storage is dropped. */
export const BUILTIN_SUB_NAMES: readonly string[] = BUILTIN_SUB_INDICATORS.map((i) => i.name);

export function isBuiltinSubIndicator(name: string): boolean {
  return BUILTIN_SUB_NAMES.includes(name);
}

/** 成交量 in the picker, 成交量 everywhere else that names a pane. */
const LABELS: Record<string, string> = Object.fromEntries(
  BUILTIN_SUB_INDICATORS.map((i) => [i.name, i.label]),
);

/**
 * Human name for a pane's indicator. User formulas are not in the table — they
 * carry their own workbench label, which the caller passes as the fallback.
 */
export function subIndicatorLabel(name: string, fallback = name): string {
  return LABELS[name] ?? fallback;
}

/**
 * Ceiling on simultaneously mounted sub panes. `planPaneHeights` already
 * refuses to let them eat the main chart below its floor and the page shows a
 * 「副图过多」banner, but a picker that kept saying yes would let the user mount
 * nineteen 74px strips and the banner is a poor no. Six is generous for a
 * 360px-tall host (the documented minimum: 180px main + 44px per sub is the
 * layout module's own floor) and it is a *stated* limit rather than a crash.
 */
export const MAX_SUB_PANES = 6;

/** Which view a list belongs to. 分时 and K线 are separate charts, so they get separate choices. */
export type SubViewKey = "kline" | "timeShare";

/**
 * What a view shows before the user has ever touched the picker.
 *
 * `kline` is verbatim today's behaviour — VOL then MACD, the order the hardcoded
 * pair mounted in — so shipping this changes nothing for anyone already reading
 * the candle chart. `timeShare` is the change: 成交量 only, because a 分时 has
 * one session of bars and MACD's warm-up eats the left half of them.
 */
export const DEFAULT_SUB_SETS: Record<SubViewKey, readonly string[]> = {
  kline: ["VOL", "MACD"],
  timeShare: ["VOL"],
};

export type SubPaneSets = Record<SubViewKey, string[]>;

const STORE_KEY = "pro-chart.subIndicators.v1";

/**
 * Storage is hostile input like any other: a hand-edited key, a list from a
 * future version that renamed something, or an array of objects all arrive here
 * from `localStorage` with nothing between them and `createIndicator`. Unknown
 * names are dropped rather than passed through, because `ChartImp.createIndicator`
 * answers an unregistered name with a `console.warn` and a `null` — the pane
 * never appears and the picker's chip row would claim it did.
 *
 * Over `MAX_SUB_PANES` is truncated, not rejected: the first entries are the
 * ones the user added earliest and therefore most likely still wants.
 */
export function normalizeSubList(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  for (const item of list) {
    if (typeof item !== "string") continue;
    if (!isBuiltinSubIndicator(item)) continue;
    if (out.includes(item)) continue;
    out.push(item);
    if (out.length >= MAX_SUB_PANES) break;
  }
  return out;
}

function emptySets(): SubPaneSets {
  return { kline: [...DEFAULT_SUB_SETS.kline], timeShare: [...DEFAULT_SUB_SETS.timeShare] };
}

/** Read both lists back. A corrupt or absent entry yields the defaults, never a throw. */
export function loadSubPaneSets(): SubPaneSets {
  const fallback = emptySets();
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return fallback;
    const box = parsed as Record<string, unknown>;
    const next: SubPaneSets = { kline: [], timeShare: [] };
    for (const key of ["kline", "timeShare"] as const) {
      if (box[key] === undefined) {
        next[key] = [...DEFAULT_SUB_SETS[key]];
        continue;
      }
      // An *empty* list is a choice the user made — they closed every sub pane
      // on purpose. Only a missing one falls back to the default.
      next[key] = normalizeSubList(box[key]);
    }
    return next;
  } catch {
    return fallback;
  }
}

export function saveSubPaneSets(sets: SubPaneSets): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(sets));
  } catch {
    /* quota errors are non-fatal for a convenience feature (same contract as indicatorStore) */
  }
}

/** The list a given view should be showing. */
export function subNamesForView(sets: SubPaneSets, timeShare: boolean): string[] {
  const list = timeShare ? sets.timeShare : sets.kline;
  // Defensive copy: callers hand the result to a `setState` and to
  // `syncSubPanes`, and neither should be able to mutate the other's input.
  return [...list];
}

/**
 * `sets` with one view's `from` swapped out for `to`.
 *
 * `to` goes onto the **end** of the list, not into `from`'s slot, and that is not
 * an oversight I have not yet found a way around: a pane's address is derived
 * from the indicator mounted on it (`paneLayout.subPaneIdOf`, which ⑲ introduced
 * so a drawing survives a reload), so "put RSI where MACD was" would leave a pane
 * addressed `sub:MACD` running RSI — every drawing badge on that strip would then
 * name an indicator that is no longer there. KLineChart 10.0.3 offers no pane
 * reordering either. Swapping in place would mean a pane id that lies, so the
 * closed strip's slot is simply released and the new one is appended, which keeps
 * the persisted order and the visual order the same list.
 */
export function withReplaced(sets: SubPaneSets, view: SubViewKey, from: string, to: string): SubPaneSets {
  // Replacing something that is not on the chart would add `to` and leave the
  // caller believing a pane had been swapped. Refuse, and let the caller's
  // "did the list change" check surface it.
  if (!sets[view].includes(from)) return sets;
  return withAdded({ ...sets, [view]: sets[view].filter((n) => n !== from) }, view, to);
}

/** `sets` with `name` appended to one view (idempotent, length-capped). */
export function withAdded(sets: SubPaneSets, view: SubViewKey, name: string): SubPaneSets {
  const next = normalizeSubList(sets[view]);
  if (!next.includes(name) && isBuiltinSubIndicator(name) && next.length < MAX_SUB_PANES) next.push(name);
  return { ...sets, [view]: next };
}

/** `sets` with `name` removed from one view. */
export function withRemoved(sets: SubPaneSets, view: SubViewKey, name: string): SubPaneSets {
  return { ...sets, [view]: sets[view].filter((n) => n !== name) };
}

/** Reset one view to its default list. */
export function withDefaults(sets: SubPaneSets, view: SubViewKey): SubPaneSets {
  return { ...sets, [view]: [...DEFAULT_SUB_SETS[view]] };
}

/**
 * The pane a sub indicator owns. Re-exported so the picker and the page cannot
 * each build their own idea of the address — `paneLayout.subPaneIdOf` is what
 * makes a pane id survive a reload, and a pane the picker looks up under a
 * different string than the page created it with reads as "not mounted".
 */
export function subPaneIdFor(name: string): string {
  return subPaneIdOf(name);
}
