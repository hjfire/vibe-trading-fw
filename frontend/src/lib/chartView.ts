import { isCalendarInterval, type IntervalKey } from "./marketApi";

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
 * This is the *one* question four places ask: the interval buttons' disabled
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
 * Lives here rather than in ProChart.tsx because the multi-chart page asks the
 * same question, and importing it from a 2000-line page would pull that page
 * into the route's chunk.
 */
export function intervalAllowed(symbol: string, interval: IntervalKey): boolean {
  return isCalendarInterval(interval) || canMinuteBars(symbol);
}

/** The period to actually use after `symbol` changes (or is restored). */
export function repairInterval(symbol: string, interval: IntervalKey): IntervalKey {
  return intervalAllowed(symbol, interval) ? interval : "1D";
}
