/**
 * Heikin-Ashi 的算术（推荐清单第④片）。
 *
 * `haClose = (O+H+L+C)/4`；`haOpen` 首根播种 `(O+C)/2`，其后 `= (上一根 haOpen + 上一根 haClose)/2`；
 * `haHigh = max(H, haOpen, haClose)`；`haLow = min(L, haOpen, haClose)`。涨色判据用 HA 自己的
 * `haClose` 对 `haOpen`，不是真实收叠——这条在 `heikinAshiChart.ts` 的 `draw` 里读。
 *
 * 只有当根四价与上一根的 HA 值参与，所以它是因果的：前缀输出等于全量输出的同长前缀
 * （`__tests__/heikinAshi.test.ts` 逐 `n` 钉住）。Bar Replay 喂进来的永远是前缀，靠的就是这条。
 *
 * 这个文件一个字都不 import klinecharts：数学能被单测直接喂数组，而库绑定层（同目录
 * `heikinAshiChart.ts`）要 mock 掉 `registerIndicator` 才测得动。两件事分开，才有地方能
 * 在浏览器外判对错。
 */

export interface HaRow {
  open?: number;
  high?: number;
  low?: number;
  close?: number;
}

/**
 * The only keys a row may carry. Exported because `heikinAshiChart.ts`'s test asserts the
 * same whitelist against the value handed to the library: `YAxisImp.createRangeImp` folds
 * every `figures[].key` of every indicator on the pane into the y-axis min/max as a *price*,
 * so a pixel number in here would repaint the price scale. Geometry belongs in `draw`.
 */
export const HA_PRICE_KEYS: readonly string[] = ["open", "high", "low", "close"] as const;

function price(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function heikinAshi(bars: readonly unknown[]): HaRow[] {
  const out: HaRow[] = [];
  let prev: { open: number; close: number } | null = null;
  for (const raw of bars) {
    const b = (raw ?? {}) as Record<string, unknown>;
    const [o, h, l, c] = [b.open, b.high, b.low, b.close];
    if (!price(o) || !price(h) || !price(l) || !price(c)) {
      // na：无键行，不是空数组——`timeShare.ts` 的 `prevCloseSeries` 已经证明库吃得下这个形状，
      // 而库的轴折叠只认 `isNumber(value)`，无键行自然跳过。链也在这里断开：下一根重新播种，
      // 不拿一个不存在的 HA 值去平均。
      prev = null;
      out.push({});
      continue;
    }
    const close = (o + h + l + c) / 4;
    // `: number` 不是装饰：`open` 的推断类型要经过 `prev.open`，而 `prev` 在这个循环体里
    // 又被 `{ open, close }` 赋值，自引用成环，strict 下报 TS7022（隐式 any）。
    const open: number = prev === null ? (o + c) / 2 : (prev.open + prev.close) / 2;
    out.push({
      open,
      high: Math.max(h, open, close),
      low: Math.min(l, open, close),
      close,
    });
    prev = { open, close };
  }
  return out;
}
