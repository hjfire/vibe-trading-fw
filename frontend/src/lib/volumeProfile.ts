/**
 * VPVR 的纯算术层（推荐清单第⑤片，spec §四）。**零 klinecharts import**——
 * 与 `heikinAshi.ts` 同规：导入库的代价在测试里表现为必须 mock 整个模块，
 * 而这层的全部价值恰恰是「不看库也能逐格手算」。
 *
 * 三件事：分档（域取自**传入那一段**的极值）、把每根的量按价格重叠比例摊进档、找 POC。
 * 它不知道可视区、不知道游标、不知道像素——`spec §八` 那两条反未来函数判据之所以能
 * 只用一个纯函数写成，就是因为这些知识全都不在这里。
 */

export interface ProfileBar {
  /** 只声明真用到的三格：摊派读 `low`/`high`/`volume`，`open`/`close` 用不上。 */
  high: number;
  low: number;
  volume: number;
}

export interface ProfileRow {
  low: number;
  high: number;
  volume: number;
}

export interface VolumeProfile {
  rows: ProfileRow[];
  pocIndex: number;
  totalVolume: number;
  spanLow: number;
  spanHigh: number;
}

/** 出厂档数。写死而不是可配（spec §一：不做参数面板）。 */
export const VPVR_ROWS = 100;

export function volumeProfile(bars: readonly ProfileBar[], rows: number = VPVR_ROWS): VolumeProfile {
  if (bars.length === 0) {
    // 「空片」不是「算不出」：调用方（绑定层）在右侧留白区里会喂进空数组，
    // 这里交出一张全零档，绘制侧读到 `totalVolume === 0` 就一根都不画。
    return {
      rows: Array.from({ length: rows }, () => ({ low: 0, high: 0, volume: 0 })),
      pocIndex: 0,
      totalVolume: 0,
      spanLow: 0,
      spanHigh: 0,
    };
  }

  let spanLow = bars[0].low;
  let spanHigh = bars[0].high;
  for (const bar of bars) {
    if (bar.low < spanLow) spanLow = bar.low;
    if (bar.high > spanHigh) spanHigh = bar.high;
  }
  const rowHeight = (spanHigh - spanLow) / rows;

  const acc = new Array<number>(rows).fill(0);
  let totalVolume = 0;

  for (const bar of bars) {
    // 零量不进任何档，也不算异常：`market_routes.py:175-176` 会把整列补成 `0.0`，
    // `timeShare.ts:171-186` 早就把零量当真实分支处理。
    if (bar.volume === 0) continue;
    totalVolume += bar.volume;

    // 域塌成一个点（所有根同一价，含只有一根一字线）：档宽是 0，除法会炸。
    // 正解是全部进第 0 档——形状无从谈起，一张图也没有。
    if (rowHeight === 0) {
      acc[0] += bar.volume;
      continue;
    }

    const span = bar.high - bar.low;
    if (span === 0) {
      // 一字线／单点：整量进包含该价的那一档，不做除法。库自己在内置 EMV 里对同一
      // 形状单独立了分支（`dist:3998` `if (volume === 0 || high - low === 0)`）。
      // `Math.min(rows - 1, …)` 不是防御：`price === spanHigh` 时 `floor` 恰好给出行数，
      // spec §四 的「末档右闭」就是靠这一钳实现的。
      acc[Math.min(rows - 1, Math.max(0, Math.floor((bar.low - spanLow) / rowHeight)))] += bar.volume;
      continue;
    }

    // 区间按价格重叠比例摊派。循环上界用「档下界 < bar.high」而不是
    // `floor(bar.high …)`：后者在 `high` 正落在档边界上时会多带出一个**零重叠**档，
    // 而 `high === spanHigh` 那一档靠循环体里的右闭处理。
    let j = Math.max(0, Math.floor((bar.low - spanLow) / rowHeight));
    while (j < rows && spanLow + j * rowHeight < bar.high) {
      const rowLow = spanLow + j * rowHeight;
      // 末档右闭：它的上界直接取 `spanHigh`，不让 `spanLow + rows * rowHeight` 的
      // 浮点误差把最高那一小条量丢掉。
      const rowHigh = j === rows - 1 ? spanHigh : rowLow + rowHeight;
      const overlap = Math.min(bar.high, rowHigh) - Math.max(bar.low, rowLow);
      if (overlap > 0) acc[j] += (bar.volume * overlap) / span;
      j += 1;
    }
  }

  const out = new Array<ProfileRow>(rows);
  for (let j = 0; j < rows; j++) {
    out[j] = {
      low: spanLow + j * rowHeight,
      high: j === rows - 1 ? spanHigh : spanLow + (j + 1) * rowHeight,
      volume: acc[j],
    };
  }

  let pocIndex = 0;
  let best = acc[0];
  for (let j = 1; j < rows; j++) {
    // **严格大于** ⇒ 并列时先到的（低价档）赢。spec §四：POC 并列取下，
    // 与 §五 价值区扩展的并列取上**故意相反**——两条各有针，别顺手统一。
    if (acc[j] > best) {
      best = acc[j];
      pocIndex = j;
    }
  }

  return { rows: out, pocIndex, totalVolume, spanLow, spanHigh };
}
