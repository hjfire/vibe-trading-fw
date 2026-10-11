/**
 * 第⑥片（多标的叠加对比）唯一的纯函数：把对比标的的收盘对齐到主图时间轴。
 *
 * 口径抄后端那条已被验证过的规则，不自己发明：
 * `agent/backtest/loaders/akshare_loader.py` 的**只 ffill、拒绝 bfill**——原文理由是
 * 「a back fill would quote a bar a factor the market had not issued yet, which is the
 * future-information leak」。回填（拿右边的价填左边）在这里同样是未来函数：
 * 回放游标往前走时线会重绘。
 *
 * 停牌／休市期间线**平着走**（carry 的定义就是"最近已知价"），这是语义不是缺陷；
 * 不设"超过 N 天就断线"的参数（spec §三）。
 *
 * 输出里的 `null` 直接交给库，不需要适配层：`null` 在 `line` 图元上是双向缺口
 * 且不被桥接、不掉基线，在那根独立轴的量程上被 `isNumber` 跳过（spec §二·8）。
 * 「主图有 bar、对比还没有价」的左段因此是真的没有线。
 */
export interface CompareBar {
  timestamp: number;
  close: number;
}

/**
 * 两个入参都按时间戳升序——**这是前置条件，不是本地可校验的不变量**（游标只右移，乱序输入
 * 不会报错，只会静默交出错的价）。担保人在后端那一侧，且只有一处：
 * `agent/src/api/market_routes.py:177` 的 `frame = frame.sort_index()`（`_bars_from_frame`
 * 内部，`:242`／`:279`／`:336`／`:465`／`:591` 五条取数通路都从它出门，`udf_routes.py:532`
 * 也直调 `_kline_sync`，所以两侧序列走的是同一个担保人）；周／月线那侧
 * `_merge_to_calendar` 在 `:505` 又按 `timestamp` 显式排一次。主图那一半是库自己的
 * `dataList`：分页 `forward` 交更早的一页、`backward` 更新尾根，两侧各自有序。
 *
 * `cursor` 单调右移 ⇒ O(n + m)，且**逐根独立**：第 `i` 项只读 `mainTimestamps[i]`
 * 与 `usable`，不读别的输出项。前缀不变量（§十·②）就是这条独立性的读数形态。
 *
 * 坏值判据 `Number.isFinite(close) && close > 0` 两半都不能省（spec §十二 R11）：
 * 缺列时 `marketApi.columnsToBars` 补的是 `0` 而不是 null，`0` 过得了 `isFinite`，
 * 而它在库的 `isValid`/`isNumber` 两道上都是合法数值 ⇒ 会真画出一条 0 线并把那根
 * 独立轴的量程拽到 0。「跳过」= 整根不进游标（连时间戳一起丢），**不是**「到了那根
 * 交 `null`」——后者会让一根坏 bar 把后面的好价格一起截断。
 */
export function alignCloseToTimestamps(
  mainTimestamps: readonly number[],
  compare: readonly CompareBar[],
): (number | null)[] {
  const usable = compare.filter((bar) => Number.isFinite(bar.close) && bar.close > 0);
  const out: (number | null)[] = [];
  let cursor = -1;
  for (const ts of mainTimestamps) {
    while (cursor + 1 < usable.length && usable[cursor + 1].timestamp <= ts) {
      cursor += 1;
    }
    out.push(cursor >= 0 ? usable[cursor].close : null);
  }
  return out;
}
