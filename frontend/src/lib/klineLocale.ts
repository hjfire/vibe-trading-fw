import { getSupportedLocales } from "klinecharts";

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
