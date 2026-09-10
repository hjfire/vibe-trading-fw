import { describe, expect, it, vi } from "vitest";
import { getSupportedLocales } from "klinecharts";
import type { Locales } from "klinecharts";

import { chartLocale, ensurePeriodUnitLabels, periodUnitLabels } from "../klineLocale";

/**
 * Everything the page writes into the library's global locale table, recorded.
 *
 * Only `registerLocale` is faked: the resolution tests below must keep asking the
 * installed chart which tags it actually holds, because "is this tag supported"
 * is the one fact this file exists to defer to the library on.
 */
const patched = vi.hoisted(() => [] as Array<{ tag: string; patch: Locales }>);
vi.mock("klinecharts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("klinecharts")>();
  return {
    ...actual,
    registerLocale: (tag: string, ls: Locales) => {
      patched.push({ tag, patch: ls });
    },
  };
});

/**
 * The chart library looks strings up with `locales[locale][key]` and no guard,
 * so an unsupported tag is not a fallback — it is a throw inside the crosshair
 * tooltip on every redraw. Whatever the UI language is, the answer must be a
 * tag the installed chart actually ships.
 */
describe("chart locale resolution", () => {
  it("only ever answers with a tag the chart supports", () => {
    for (const lang of ["zh-CN", "zh", "en", "en-US", "ja", "pt-BR", "ar", "", "klingon"]) {
      expect(getSupportedLocales()).toContain(chartLocale(lang));
    }
  });

  it("keeps Chinese on Chinese and falls back to English", () => {
    expect(chartLocale("zh-CN")).toBe("zh-CN");
    expect(chartLocale("zh")).toBe("zh-CN");
    expect(chartLocale("en")).toBe("en-US");
    expect(chartLocale("ja")).toBe("en-US");
    expect(chartLocale("")).toBe("en-US");
  });
});

/**
 * The minute unit in the tooltip heading (㉙).
 *
 * `09988.HK · 1` in the 2026-09-10 screenshot: the heading is
 * `{ticker} · {span}{i18n(period.type)}` (dist 7431), and both tables the library
 * ships have `minute: ''` — an empty string is a hit, so `i18n`'s `?? key`
 * fallback never fires and a minute chart prints a bare 1 for its period.
 */
describe("the minute-period unit", () => {
  it("answers the unit, in the language of the table it is patching", () => {
    expect(periodUnitLabels("zh-CN")).toEqual({ minute: "分钟" });
    expect(periodUnitLabels("zh")).toEqual({ minute: "分钟" });
    expect(periodUnitLabels("zh-TW")).toEqual({ minute: "分钟" });
    // Matched to the shipped style — en-US uses `S`/`H`/`D`, so a compact
    // heading wants `Min`, not `Minute`.
    expect(periodUnitLabels("en-US")).toEqual({ minute: "Min" });
    expect(periodUnitLabels("ja-JP")).toEqual({ minute: "Min" });
    expect(periodUnitLabels("")).toEqual({ minute: "Min" });
  });

  it("patches every tag the library holds, one key each, once per load", () => {
    // The merge semantics are the reason this is safe to do at all: a one-key
    // patch lands on top of the shipped table (dist 7001), so nothing here has
    // to copy — and re-copy, and then drift from — a version-dependent table.
    ensurePeriodUnitLabels();
    expect(patched.map((p) => p.tag).sort()).toEqual([...getSupportedLocales()].sort());
    for (const { tag, patch } of patched) {
      expect(Object.keys(patch)).toEqual(["minute"]);
      expect(patch.minute).toBe(periodUnitLabels(tag).minute);
    }
    // A StrictMode remount must not rewrite the global table a second time, and
    // an invented tag must never reach it — that is the throw `chartLocale` (L1)
    // exists to prevent, so the two halves have to agree on the tag list.
    ensurePeriodUnitLabels();
    expect(patched).toHaveLength(getSupportedLocales().length);
  });
});
