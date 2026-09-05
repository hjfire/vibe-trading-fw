import { describe, expect, it } from "vitest";
import { getSupportedLocales } from "klinecharts";

import { chartLocale } from "../klineLocale";

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
