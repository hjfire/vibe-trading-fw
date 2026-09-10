/**
 * The sub-chart indicator registry and its persistence (local custom ㉛).
 *
 * `ProChartTimeShare.test.tsx` drives this through the toolbar; this file pins
 * the rules themselves, because two of them are only reachable through storage
 * that no click can produce:
 *
 * - a hand-edited or forward-written name reaching `createIndicator`, which
 *   answers with a `console.warn` and no pane at all — the picker would then
 *   claim a strip that was never drawn;
 * - the difference between a *missing* list (fall back to the default) and an
 *   *empty* one (the user closed every sub chart on purpose, and honouring it
 *   back to VOL + MACD on the next load would undo their choice).
 *
 * The catalogue assertions read the real library, not a copy of its docs, so a
 * KLineChart upgrade that renames or drops an indicator fails here instead of
 * showing a dead button.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { getSupportedIndicators } from "klinecharts";

import {
  BUILTIN_SUB_INDICATORS,
  BUILTIN_SUB_NAMES,
  DEFAULT_SUB_SETS,
  MAX_SUB_PANES,
  isBuiltinSubIndicator,
  loadSubPaneSets,
  normalizeSubList,
  saveSubPaneSets,
  subIndicatorLabel,
  subNamesForView,
  subPaneIdFor,
  withAdded,
  withDefaults,
  withRemoved,
  withReplaced,
} from "../subIndicators";
import { subPaneIdOf } from "../paneLayout";
import type { SubPaneSets } from "../subIndicators";

const STORE_KEY = "pro-chart.subIndicators.v1";

const sets = (kline: string[], timeShare: string[]): SubPaneSets => ({ kline, timeShare });

function writeStorage(value: unknown): void {
  localStorage.setItem(STORE_KEY, typeof value === "string" ? value : JSON.stringify(value));
}

beforeEach(() => {
  localStorage.clear();
});

describe("the catalogue", () => {
  it("only offers indicators the library can actually mount", () => {
    // `ChartImp.createIndicator` warns and returns null for an unregistered name,
    // so a typo here is a dead button, not a broken pane.
    const supported = new Set(getSupportedIndicators());
    for (const preset of BUILTIN_SUB_INDICATORS) {
      expect(supported.has(preset.name), `${preset.name} is not registered by klinecharts`).toBe(true);
    }
  });

  it("leaves every price-series indicator to the main chart", () => {
    // Those are what `syncPriceOverlay` manages; a picker that mounted `MA` on a
    // sub pane would give the price lines their own axis and start a fight with
    // the view switch on every period click.
    for (const name of ["MA", "BOLL", "SAR", "EMA", "SMA", "BBI", "AVP"]) {
      expect(isBuiltinSubIndicator(name)).toBe(false);
    }
  });

  it("is addressable by exactly one name", () => {
    const names = BUILTIN_SUB_NAMES;
    expect(new Set(names).size).toBe(names.length);
    expect(names.length).toBeGreaterThan(10);
    for (const preset of BUILTIN_SUB_INDICATORS) {
      expect(subIndicatorLabel(preset.name)).toBe(preset.label);
    }
    // A name nobody knows still has to say something, and it says the name.
    expect(subIndicatorLabel("NOPE", "我的脚本")).toBe("我的脚本");
    expect(subIndicatorLabel("NOPE")).toBe("NOPE");
  });
});

describe("defaults", () => {
  it("gives 分时 成交量 alone and the candles what they always had", () => {
    // The K线 pair is verbatim the hardcoded `createIndicator` order this page
    // shipped with; changing it here is a regression, not a preference.
    expect([...DEFAULT_SUB_SETS.kline]).toEqual(["VOL", "MACD"]);
    // MACD(12,26,9) emits nothing for the first ~33 bars of a one-session 分时,
    // which is the blank pane the 2026-09 report was about.
    expect([...DEFAULT_SUB_SETS.timeShare]).toEqual(["VOL"]);
  });

  it("only defaults to things it is willing to mount", () => {
    for (const list of Object.values(DEFAULT_SUB_SETS)) {
      expect(normalizeSubList(list)).toEqual([...list]);
    }
  });
});

describe("normalizeSubList", () => {
  it("drops anything createIndicator would refuse", () => {
    expect(normalizeSubList("VOL")).toEqual([]);
    expect(normalizeSubList(undefined)).toEqual([]);
    expect(normalizeSubList([{ name: "VOL" }])).toEqual([]);
    expect(normalizeSubList(["VOL", "MA", "我的公式", 7, null, "", "MACD"])).toEqual(["VOL", "MACD"]);
  });

  it("keeps the first entry when one is listed twice", () => {
    // Dedupe must not reorder: the position is what the user dragged separators
    // against, and `RSI, VOL, RSI` is one RSI at the top.
    expect(normalizeSubList(["RSI", "VOL", "RSI"])).toEqual(["RSI", "VOL"]);
  });

  it("truncates to the cap instead of rejecting the list", () => {
    const long = BUILTIN_SUB_NAMES.concat(BUILTIN_SUB_NAMES.slice(0, 3));
    const out = normalizeSubList(long);
    expect(out).toHaveLength(MAX_SUB_PANES);
    expect(out).toEqual(BUILTIN_SUB_NAMES.slice(0, MAX_SUB_PANES));
  });
});

describe("loadSubPaneSets", () => {
  it("answers the defaults when nothing was written", () => {
    expect(loadSubPaneSets()).toEqual({ kline: ["VOL", "MACD"], timeShare: ["VOL"] });
  });

  it.each([
    ["corrupt json", "{not json"],
    ["a bare array", ["VOL"]],
    ["a string", '"VOL"'],
    ["null", null],
  ])("survives %s", (_label, value) => {
    writeStorage(value);
    expect(loadSubPaneSets()).toEqual({ kline: ["VOL", "MACD"], timeShare: ["VOL"] });
  });

  it("keeps a list the user emptied, and refills only a missing one", () => {
    // The distinction the whole feature turns on: `[]` is a decision, an absent
    // key is an older version that never had the idea.
    writeStorage({ kline: [], timeShare: ["VOL"] });
    expect(loadSubPaneSets()).toEqual({ kline: [], timeShare: ["VOL"] });

    writeStorage({ timeShare: ["RSI"] });
    expect(loadSubPaneSets()).toEqual({ kline: ["VOL", "MACD"], timeShare: ["RSI"] });
  });

  it("filters what it reads, so storage cannot name a pane the picker cannot show", () => {
    writeStorage({ kline: ["VOL", "NONSENSE", "VOL", "MACD"], timeShare: ["RSI"] });
    expect(loadSubPaneSets().kline).toEqual(["VOL", "MACD"]);
  });

  it("round-trips what saveSubPaneSets wrote", () => {
    const next = sets(["RSI"], []);
    saveSubPaneSets(next);
    expect(loadSubPaneSets()).toEqual(next);
    expect(JSON.parse(localStorage.getItem(STORE_KEY) ?? "{}")).toEqual({ kline: ["RSI"], timeShare: [] });
  });
});

describe("subNamesForView", () => {
  it("hands out a copy", () => {
    const source = sets(["VOL", "MACD"], ["VOL"]);
    const got = subNamesForView(source, true);
    got.push("RSI");
    expect(source.timeShare).toEqual(["VOL"]);
    // …and it picked the right view in the first place.
    expect(subNamesForView(source, false)).toEqual(["VOL", "MACD"]);
  });
});

describe("withAdded", () => {
  it("appends, and refuses to double-book a pane", () => {
    expect(withAdded(sets(["VOL"], ["VOL"]), "kline", "RSI").kline).toEqual(["VOL", "RSI"]);
    expect(withAdded(sets(["VOL"], ["VOL"]), "kline", "VOL").kline).toEqual(["VOL"]);
    expect(withAdded(sets(["VOL"], ["VOL"]), "timeShare", "RSI").kline).toEqual(["VOL"]);
  });

  it("refuses an unknown name and the eighth pane", () => {
    expect(withAdded(sets(["VOL"], ["VOL"]), "kline", "NONSENSE").kline).toEqual(["VOL"]);
    const full = sets(BUILTIN_SUB_NAMES.slice(0, MAX_SUB_PANES), ["VOL"]);
    expect(withAdded(full, "kline", "AO").kline).toEqual(BUILTIN_SUB_NAMES.slice(0, MAX_SUB_PANES));
  });
});

describe("withRemoved", () => {
  it("takes one name out and leaves the other view alone", () => {
    const source = sets(["VOL", "MACD"], ["VOL", "MACD"]);
    const next = withRemoved(source, "kline", "VOL");
    expect(next.kline).toEqual(["MACD"]);
    expect(next.timeShare).toEqual(["VOL", "MACD"]);
    expect(source.kline).toEqual(["VOL", "MACD"]); // no mutation of the caller's state
  });
});

describe("withReplaced", () => {
  it("refuses to replace a pane that is not on the chart", () => {
    const source = sets(["VOL"], ["VOL"]);
    // Same object, so the caller's "did the list move?" check says no and the
    // picker can report the failure instead of nodding.
    expect(withReplaced(source, "kline", "MACD", "RSI")).toBe(source);
  });

  it("releases the closed strip's slot and appends, rather than lying about an address", () => {
    // `subPaneIdOf` derives a pane's id from the indicator on it (⑲), so "put RSI
    // where MACD was" would leave a pane addressed `sub:MACD` running RSI and
    // mislabel every drawing parked there. The order changes; the address does
    // not get to be wrong.
    const next = withReplaced(sets(["VOL", "MACD", "KDJ"], ["VOL"]), "kline", "VOL", "RSI");
    expect(next.kline).toEqual(["MACD", "KDJ", "RSI"]);
    expect(subPaneIdFor("RSI")).toBe(subPaneIdOf("RSI"));
    expect(subPaneIdFor("RSI")).not.toBe(subPaneIdFor("VOL"));
  });

  it("still closes the old strip when the new one is already mounted", () => {
    // The button for a mounted indicator is disabled, so this is the defensive
    // path — but a state that closes VOL *and* keeps a single MACD is the only
    // sane answer, and `withAdded`'s dedupe is what makes it that.
    expect(withReplaced(sets(["VOL", "MACD"], ["VOL"]), "kline", "VOL", "MACD").kline).toEqual(["MACD"]);
  });
});

describe("withDefaults", () => {
  it("resets one view and keeps the other's edits", () => {
    const next = withDefaults(sets(["RSI", "WR"], ["KDJ"]), "timeShare");
    expect(next.timeShare).toEqual(["VOL"]);
    expect(next.kline).toEqual(["RSI", "WR"]);
    // A fresh copy, so a later mutation cannot reach back into the shared default.
    next.timeShare.push("MACD");
    expect(withDefaults(next, "timeShare").timeShare).toEqual(["VOL"]);
  });
});
