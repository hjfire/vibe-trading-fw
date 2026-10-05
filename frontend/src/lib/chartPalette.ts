/**
 * The candle palette, shared because "red = up" is a market convention rather
 * than a style choice: a page that quietly drifts to green-up reads as an
 * inverse chart, and a user comparing /pro-chart with /multi-chart would be
 * reading two different stories off the same bars.
 *
 * Grid and axis greys deliberately stay with each page — that is chrome, and
 * the two pages are not obliged to match.
 */
export const CANDLE_COLORS = {
  up: "#ef5350",
  down: "#26a69a",
  noChange: "#888888",
} as const;
