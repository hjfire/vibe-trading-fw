import { getSupportedLocales, registerLocale } from "klinecharts";
import type { Locales } from "klinecharts";

/**
 * Resolve the UI language to a locale tag the chart library really ships.
 *
 * KLineChart reads its strings through `locales[locale][key]` without any
 * guard, so an unknown tag does not degrade to English — it throws
 * `Cannot read properties of undefined (reading 'day')` from inside the
 * crosshair tooltip on every redraw (that was the `zh_CN` tag this page used
 * to pass at init, which is why the console filled up the moment bars
 * arrived). The supported set is small and version-dependent, so ask the
 * library instead of hardcoding it.
 */
export function chartLocale(lang: string): string {
  const supported = getSupportedLocales();
  const wanted = (lang || "en").toLowerCase();
  const exact = supported.find((l) => l.toLowerCase() === wanted);
  if (exact) return exact;
  const base = wanted.split("-")[0];
  return (
    supported.find((l) => l.toLowerCase().split("-")[0] === base) ??
    supported.find((l) => l.toLowerCase().startsWith("en")) ??
    supported[0] ??
    "en-US"
  );
}

/**
 * The one string this page refuses to leave blank: the minute-period unit.
 *
 * KLineChart builds the tooltip heading out of `{ticker} · {period}`, where
 * `period` is `span + i18n(period.type, locale)` (dist 7431, template dist
 * 11512). Both of its locale tables ship `minute: ''` (en-US dist 6944, zh-CN
 * dist 6975) — an empty string is a value, and `i18n` only falls back to the key
 * on `null`/`undefined` (dist 7008) — so every minute chart in the library, this
 * one included, announces itself as `09988.HK · 1`. On a 分时 page that is not a
 * cosmetic nit: "1" is the number the user is reading the axis against, and it
 * looks like a broken format rather than an untranslated unit.
 *
 * Only the unit is answered here. The two-letter style of the shipped table
 * (`S`/`H`/`D`) is what a compact heading wants, so English gets `Min`, not
 * `Minute`.
 */
export function periodUnitLabels(locale: string): Pick<Locales, "minute"> {
  const base = (locale || "").toLowerCase().split(/[-_]/)[0];
  return { minute: base === "zh" ? "分钟" : "Min" };
}

let periodUnitsRegistered = false;

/**
 * Patch the unit into every locale the library actually holds, once per load.
 *
 * `registerLocale` merges into the existing table rather than replacing it
 * (dist 7001: `locales[locale] = { ...locales[locale], ...ls }`), which is why
 * this can add one key without shipping a private copy of a table that is
 * version-dependent — the same reason `chartLocale` asks the library for its
 * tags instead of hardcoding them. Iterating `getSupportedLocales()` means a
 * future locale gains the fix without this file changing, and an unknown tag is
 * never invented (that is the failure `chartLocale` exists to stop).
 */
export function ensurePeriodUnitLabels(): void {
  if (periodUnitsRegistered) return;
  periodUnitsRegistered = true;
  for (const tag of getSupportedLocales()) {
    // A one-key object, and `Locales` types every key as required because it
    // describes a *complete* table. The widening is the library's own behaviour,
    // not a trick to get past tsc: `registerLocale` spreads the patch over the
    // table it already holds, so anything omitted here keeps its shipped value.
    registerLocale(tag, periodUnitLabels(tag) as Locales);
  }
}
