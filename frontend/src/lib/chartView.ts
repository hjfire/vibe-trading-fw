import { isCalendarInterval, type AnyInterval } from "./marketApi";

/** Which symbols can have minute bars at all.
 *
 * FutuOpenD covers .SH/.SZ/.HK/.US; the Sina fall-back behind it reaches
 * A-shares only, so a crypto or LSE code has no intraday source here.
 *
 * Exported for tests: it mirrors ``_FUTU_MINUTE_SUFFIXES`` in market_routes.py.
 */
export function canMinuteBars(symbol: string): boolean {
  // Case-insensitive because the route upper-cases the symbol before resolving
  // it, so a lowercase code typed into the box is servable too.
  return /\.(SH|SZ|HK|US)$/i.test(symbol);
}

/** Can this period be used on this instrument at all? Daily and coarser always can.
 *
 * This is the *one* question the chart surfaces ask (a sample, not a count): the period rows' disabled
 * state, the click handler, the repair on symbol switch, and session restore.
 * When it was spelled inline in each of them, relaxing one copy produced a
 * button that looked clickable and did nothing -- the guard in `pickInterval`
 * kept the old A-share-only rule after the button stopped disabling itself.
 *
 * Weekly and monthly sit in daily's lane because the server folds them out of
 * the very same daily answer (local custom ㉜, `_AGG_DAILY_PER_BAR` in
 * market_routes.py): no second source is involved, so there is nothing second to
 * gate. Inventing a per-symbol rule for them here would be a fourth copy of a
 * rule the route already owns.
 *
 * 自定义档按它的单位落车道：`m` 要分钟源，`D`/`W`/`M` 不需要——这条判据的来源是
 * `interval_spec` 的折叠基档，不是任何 disabled 标记。
 *
 * Lives here rather than in ProChart.tsx because the multi-chart page asks the
 * same question, and importing it from a page of that size would pull that page
 * into the route's chunk.
 */
export function intervalAllowed(symbol: string, interval: AnyInterval): boolean {
  return isCalendarInterval(interval) || canMinuteBars(symbol);
}

/** The period to actually use after `symbol` changes (or is restored).
 *
 *  泛型让拿着窄类型 `IntervalKey` 的调用方（如 `MultiChart.tsx`）零改动：结果仍是
 *  `T | "1D"`，T 本身是内置八档时它就还是 `IntervalKey`。 */
export function repairInterval<T extends AnyInterval>(symbol: string, interval: T): T | "1D" {
  return intervalAllowed(symbol, interval) ? interval : "1D";
}
