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

/** 出厂价值区比例（经典口径 70%）。 */
export const VPVR_VALUE_AREA_RATIO = 0.7;

export interface ValueArea {
  /** 闭区间，**含 POC 档自己**。 */
  lowIndex: number;
  highIndex: number;
  coverage: number;
}

/**
 * 经典 Volume Profile 价值区：从 POC 出发，每步比较**相邻的**上一档与下一档的量，
 * 吃掉较大的那一侧，直到累计 ≥ `ratio × totalVolume`。
 *
 * `ratio` 形参只为测试的两个边界（0 与 >1）而留，生产侧不传——它不是参数面板
 * （spec §一 否掉的是 UI 可调）。
 */
export function valueAreaOf(profile: VolumeProfile, ratio: number = VPVR_VALUE_AREA_RATIO): ValueArea {
  const rows = profile.rows;
  const total = profile.totalVolume;
  // `totalVolume === 0` 时 `coverage` 是 0 而不是 `0/0`；两条退化（空片／全零量）
  // 都从这一支出。
  if (total === 0) return { lowIndex: 0, highIndex: 0, coverage: 0 };

  const target = ratio * total;
  let lowIndex = profile.pocIndex;
  let highIndex = profile.pocIndex;
  let acc = rows[profile.pocIndex].volume;

  while (acc < target) {
    const canUp = highIndex + 1 < rows.length;
    const canDown = lowIndex - 1 >= 0;
    // 两侧都到头而仍未达标是**可达**情形（极端集中的分布＋高档数，或 `ratio > 1`），
    // 不是防御性代码：就地收摊返回当前区间。
    if (!canUp && !canDown) break;
    // 走哪一侧只由**边界**与两侧的档量决定，不用「越界记作 -1」的哨兵：哨兵要靠
    // 「档量非负」才必然输，而那是数据形状给的、不是这段代码给的。一旦有负量，越界那侧
    // 的 -1 反而赢，`highIndex` 就一路越界、`acc` 逐轮减下去，循环永不退出——页签冻死
    // 比算错一个数更糟。下面每一支都必然推进一个**存在的**下标，循环上界恒为
    // `rows.length`，与取值无关。
    // **并列取上侧**。注意这与 §四 的 POC 并列取下相反——一个「先到的赢」是扫描副产物，
    // 一个是扩展方向的选择，两条都是定死的口径。
    let takeUp: boolean;
    if (!canUp) takeUp = false;
    else if (!canDown) takeUp = true;
    else takeUp = rows[highIndex + 1].volume >= rows[lowIndex - 1].volume;
    if (takeUp) {
      highIndex += 1;
      acc += rows[highIndex].volume;
    } else {
      lowIndex -= 1;
      acc += rows[lowIndex].volume;
    }
  }

  return { lowIndex, highIndex, coverage: acc / total };
}
