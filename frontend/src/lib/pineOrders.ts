/**
 * Order simulation for the Pine compatibility layer — the "money" half of
 * `strategy()`, kept apart from the interpreter so it can be unit-tested on its
 * own and so the bar loop stays readable.
 *
 * Matching rules follow TradingView defaults, because that is what people
 * compare their numbers against:
 *   - orders placed on bar *i* fill on bar *i+1* **at the open**, unless the
 *     script sets `process_orders_on_close=true` (then they fill at bar *i*'s
 *     close);
 *   - limit/stop orders are good-til-cancelled and fill at the trigger price
 *     when the bar only touches it, or at the open when the open already beats
 *     it (the better-price rule);
 *   - `default_qty_type=strategy.percent_of_equity` sizes off the previous
 *     bar's equity;
 *   - commissions follow `commission_type` (percent / cash_per_order /
 *     cash_per_contract) and `slippage` is quoted in ticks (approximated from
 *     the smallest observed price step).
 *
 * One net position per entry id is modelled; adding to the same id averages the
 * entry price, and `pyramiding` caps how many ids may be open at once.
 */

import {
  NA,
  NAMED_ONLY,
  argAt,
  asNum,
  asStr,
  flagArg,
  numArg,
  sentinel,
  strArg,
  type Arg,
  type BuiltinCtx,
  type PineBars,
  type PineReport,
  type PineTrade,
  type V,
} from "./pineTypes";

interface Position {
  id: string;
  dir: 1 | -1;
  qty: number;
  avg: number;
  entryBar: number;
  entryTime: number;
  /** Entry fees still attached to the open quantity. */
  entryFees: number;
  /** How many times this id was added to since it opened (pyramiding). */
  extra: number;
}

interface Order {
  id: string;
  kind: "entry" | "exit";
  /** Direction an entry opens, or the side an exit closes. */
  dir: 1 | -1;
  qty: number;
  qtyPercent: number;
  mode: "market" | "limit" | "stop";
  price: number;
  createdBar: number;
}

/** Puts a B/S dot on the chart at fill time. */
export type MarkSink = (bar: number, name: string, up: boolean, price: number) => void;

/** `strategy.long` / `1` / `-1` all mean the same thing to an order. */
export function dirOf(v: V | undefined): 1 | -1 | 0 {
  if (typeof v === "string") {
    if (/(^|\.)long$/.test(v)) return 1;
    if (/(^|\.)short$/.test(v)) return -1;
    return 0;
  }
  const n = asNum(v === undefined ? NA : v);
  if (Number.isNaN(n) || n === 0) return 0;
  return n > 0 ? 1 : -1;
}

/**
 * Smallest observed price step, so `slippage=2` and `loss=<ticks>` land in the
 * right unit. A-share quotes step by 0.01, which this recovers exactly.
 */
export function estimateTick(bars: PineBars): number {
  let best = 0;
  const n = Math.min(bars.list.length, 500);
  for (let i = 1; i < n; i++) {
    const d = Math.abs(bars.close[i] - bars.close[i - 1]);
    if (d > 1e-9 && (best === 0 || d < best)) best = d;
  }
  if (!best) return 0.01;
  const pow = 10 ** Math.floor(Math.log10(best));
  return Math.max(pow, 1e-6);
}

export class OrderSim {
  initialCapital = 10000;
  qtyType: "fixed" | "percent_of_equity" = "percent_of_equity";
  qtyValue = 100;
  commissionMode: "percent" | "cash_per_order" | "cash_per_contract" = "cash_per_order";
  commissionValue = 0;
  slippageTicks = 0;
  ordersOnClose = false;
  pyramiding = 0;

  private cash: number;
  private realized = 0;
  private bi = 0;
  private readonly pos = new Map<string, Position>();
  private pending: Order[] = [];
  private readonly trades: PineTrade[] = [];
  private readonly equity: number[] = [];

  constructor(
    private readonly bars: PineBars,
    private readonly tick: number,
    private readonly warn: (msg: string) => void,
    private readonly mark: MarkSink,
  ) {
    this.cash = this.initialCapital;
  }

  /** `strategy(...)` header: read settings once, on the first bar. */
  configure(args: Arg[], c: BuiltinCtx): void {
    this.initialCapital = numArg(args, c, NAMED_ONLY, 10000, "initial_capital");
    this.cash = this.initialCapital;
    const qt = strArg(args, c, NAMED_ONLY, "", "default_qty_type");
    // TradingView's own default is "100% of equity", so only an explicit
    // `strategy.fixed` switches to fixed quantities.
    this.qtyType = qt.includes("fixed") ? "fixed" : "percent_of_equity";
    this.qtyValue = numArg(args, c, NAMED_ONLY, this.qtyType === "fixed" ? 1 : 100, "default_qty_value");
    const ct = strArg(args, c, NAMED_ONLY, "", "commission_type");
    if (ct.includes("percent")) this.commissionMode = "percent";
    else if (ct.includes("cash_per_contract")) this.commissionMode = "cash_per_contract";
    else if (ct.includes("cash_per_order")) this.commissionMode = "cash_per_order";
    this.commissionValue = numArg(args, c, NAMED_ONLY, 0, "commission_value");
    this.slippageTicks = Math.max(0, numArg(args, c, NAMED_ONLY, 0, "slippage"));
    this.ordersOnClose = flagArg(args, c, NAMED_ONLY, false, "process_orders_on_close");
    this.pyramiding = Math.max(0, Math.trunc(numArg(args, c, NAMED_ONLY, 0, "pyramiding")));
    if (flagArg(args, c, NAMED_ONLY, false, "calc_on_every_tick")) {
      this.warn("calc_on_every_tick=true 未实现，按收盘计算");
    }
    if (this.qtyType === "fixed" && this.qtyValue <= 0) this.qtyValue = 1;
  }

  /**
   * Legacy header form — `strategy("x", short=s1, long=s2, buy=s3, sell=s4)`.
   * All those flags drive one net position, so they share an order id and the
   * usual reversal path handles going from one side to the other.
   */
  legacySignal(dir: 1 | -1): void {
    const held = this.pos.get("legacy");
    if (held && held.dir === dir) return;
    if (this.pending.some((o) => o.id === "legacy" && o.dir === dir)) return;
    this.place({
      id: "legacy",
      kind: "entry",
      dir,
      qty: 0,
      qtyPercent: 0,
      mode: "market",
      price: NA,
      createdBar: this.bi,
    });
  }

  /* --------------------------------------------------------------- bar hook */

  beginBar(i: number): void {
    this.bi = i;
    if (!this.ordersOnClose) this.processPending(i, "open");
  }

  endBar(i: number): void {
    this.bi = i;
    if (this.ordersOnClose) this.processPending(i, "close");
    this.equity[i] = this.markEquity(i);
  }

  /* ------------------------------------------------------------- order API */

  /** @returns undefined when `name` is not an order call the sim knows. */
  call(name: string, args: Arg[], c: BuiltinCtx): V | undefined {
    const nothing = sentinel("void");
    switch (name) {
      case "strategy.entry": {
        const id = strArg(args, c, 0, "entry", "id", "name");
        const dirExpr = argAt(args, 1, "direction", "dir");
        const dir = dirOf(dirExpr ? c.val(dirExpr) : NA);
        if (dir === 0) return nothing;
        const stop = numArg(args, c, NAMED_ONLY, NA, "stop");
        const limit = numArg(args, c, NAMED_ONLY, NA, "limit");
        this.place({
          id,
          kind: "entry",
          dir,
          qty: numArg(args, c, 2, 0, "qty", "quantity", "amount"),
          qtyPercent: numArg(args, c, 3, 0, "qty_percent"),
          mode: !Number.isNaN(stop) ? "stop" : !Number.isNaN(limit) ? "limit" : "market",
          price: !Number.isNaN(stop) ? stop : !Number.isNaN(limit) ? limit : NA,
          createdBar: this.bi,
        });
        return nothing;
      }
      case "strategy.order": {
        const id = strArg(args, c, 0, "entry", "id", "name");
        const dirExpr = argAt(args, 1, "direction", "dir");
        const dir = dirOf(dirExpr ? c.val(dirExpr) : NA);
        if (dir === 0) return nothing;
        const price = numArg(args, c, 4, NA, "price");
        this.place({
          id,
          kind: "entry",
          dir,
          qty: numArg(args, c, 2, 0, "qty", "quantity", "amount"),
          qtyPercent: numArg(args, c, 3, 0, "qty_percent"),
          mode: !Number.isNaN(price) && price > 0 ? "limit" : "market",
          price: !Number.isNaN(price) ? price : NA,
          createdBar: this.bi,
        });
        return nothing;
      }
      case "strategy.exit": {
        const id = strArg(args, c, 0, "id", "name");
        const fromExpr = argAt(args, 1, "from_entry", "fromEntry");
        const from = fromExpr ? asStr(c.val(fromExpr)) : id;
        const qty = numArg(args, c, 2, 0, "qty");
        const qtyPercent = numArg(args, c, 3, 0, "qty_percent");
        const stop = numArg(args, c, NAMED_ONLY, NA, "stop");
        const limit = numArg(args, c, NAMED_ONLY, NA, "limit");
        const loss = numArg(args, c, NAMED_ONLY, NA, "loss");
        const profit = numArg(args, c, NAMED_ONLY, NA, "profit");
        if ([stop, limit, loss, profit].every(Number.isNaN)) {
          this.warn("strategy.exit() 需要 stop/limit/loss/profit 之一，已忽略");
          return nothing;
        }
        let placed = 0;
        for (const p of [...this.pos.values()]) {
          if (from && p.id !== from) continue;
          // TV quotes `loss` in ticks but `profit` in price segments; keep both.
          const stopAt = !Number.isNaN(stop) ? stop : !Number.isNaN(loss) ? p.avg - p.dir * loss * this.tick : NA;
          const limitAt = !Number.isNaN(limit) ? limit : !Number.isNaN(profit) ? p.avg + p.dir * profit : NA;
          if (!Number.isNaN(stopAt)) {
            this.place({ id: `${id}#stop`, kind: "exit", dir: p.dir, qty, qtyPercent, mode: "stop", price: stopAt, createdBar: this.bi });
            placed++;
          }
          if (!Number.isNaN(limitAt)) {
            this.place({ id: `${id}#limit`, kind: "exit", dir: p.dir, qty, qtyPercent, mode: "limit", price: limitAt, createdBar: this.bi });
            placed++;
          }
        }
        if (!placed) {
          // Bracket issued before its entry filled: re-armed every bar by the
          // script itself, so nothing to do but note it once.
          this.warn("strategy.exit() 在持仓建立前调用，本根未生效");
        }
        return nothing;
      }
      case "strategy.close": {
        const id = strArg(args, c, 0, "", "id", "name");
        const qty = numArg(args, c, 1, 0, "qty");
        const qtyPercent = numArg(args, c, 2, 0, "qty_percent");
        for (const p of [...this.pos.values()]) {
          if (id && p.id !== id) continue;
          this.place({
            id: `${id || p.id}#close`,
            kind: "exit",
            dir: p.dir,
            qty,
            qtyPercent,
            mode: "market",
            price: NA,
            createdBar: this.bi,
          });
        }
        return nothing;
      }
      case "strategy.close_all":
        for (const p of [...this.pos.values()]) {
          this.place({
            id: `${p.id}#close`,
            kind: "exit",
            dir: p.dir,
            qty: 0,
            qtyPercent: 0,
            mode: "market",
            price: NA,
            createdBar: this.bi,
          });
        }
        return nothing;
      case "strategy.cancel": {
        const id = strArg(args, c, 0, "", "id", "name");
        this.pending = this.pending.filter((o) => o.id !== id && !o.id.startsWith(`${id}#`));
        return nothing;
      }
      case "strategy.cancel_all":
        this.pending = [];
        return nothing;
      case "strategy.disable_entry_long":
      case "strategy.disable_entry_short":
      case "strategy.allow_immediate_partials":
      case "strategy.risk.max_intraday_filled_orders":
      case "strategy.risk.max_drawdown":
        return nothing;
      default:
        return undefined;
    }
  }

  /** `strategy.*` reads; undefined when the name belongs to someone else. */
  readVar(name: string): V | undefined {
    if (!name.startsWith("strategy.")) return undefined;
    const open = [...this.pos.values()];
    const netQty = open.reduce((a, p) => a + p.dir * p.qty, 0);
    const avg = netQty === 0 ? NA : open.reduce((a, p) => a + p.dir * p.qty * p.avg, 0) / netQty;
    switch (name) {
      case "strategy.long":
        return sentinel("strategy.long");
      case "strategy.short":
        return sentinel("strategy.short");
      case "strategy.flat":
        return sentinel("strategy.flat");
      case "strategy.position_size":
        return netQty;
      case "strategy.position_avg_price":
        return avg;
      case "strategy.position_entry_bar_index":
        return open.length ? open[0].entryBar : NA;
      case "strategy.opentrades":
        return open.length;
      case "strategy.losers":
        return this.trades.filter((t) => t.pnl <= 0).length;
      case "strategy.closedtrades":
        return this.trades.length;
      case "strategy.wintrades":
        return this.trades.filter((t) => t.pnl > 0).length;
      case "strategy.netprofit":
      case "strategy.profitloss":
        return this.realized;
      case "strategy.grossprofit":
        return this.trades.filter((t) => t.pnl > 0).reduce((a, t) => a + t.pnl, 0);
      case "strategy.grossloss":
        return this.trades.filter((t) => t.pnl <= 0).reduce((a, t) => a - t.pnl, 0);
      case "strategy.equity":
        return this.equity[this.bi] ?? this.markEquity(this.bi);
      case "strategy.initial_capital":
        return this.initialCapital;
      case "strategy.max_drawdown":
        return this.maxDrawdown();
      case "strategy.commission.cash_per_order":
        return 0.5;
      case "strategy.commission.cash_per_contract":
        return 0.0066;
      case "strategy.commission.percent":
        return 0.05;
      default:
        return undefined;
    }
  }

  /* ------------------------------------------------------------- mechanics */

  private place(o: Order): void {
    const same = this.pending.findIndex((x) => x.id === o.id);
    if (same >= 0) this.pending.splice(same, 1);
    this.pending.push(o);
  }

  private fee(notional: number, qty: number): number {
    if (this.commissionMode === "percent") return (Math.abs(notional) * this.commissionValue) / 100;
    if (this.commissionMode === "cash_per_contract") return this.commissionValue * Math.abs(qty);
    return this.commissionValue;
  }

  private markEquity(i: number): number {
    let eq = this.cash;
    for (const p of this.pos.values()) eq += p.dir * p.qty * this.bars.close[i];
    return eq;
  }

  private sizingEquity(i: number): number {
    const prev = this.equity[i - 1];
    return prev === undefined ? this.markEquity(i) : prev;
  }

  private qtyFor(o: Order, price: number, i: number): number {
    if (o.qty > 0) return o.qty;
    if (o.qtyPercent > 0) return (this.sizingEquity(i) * o.qtyPercent) / 100 / price;
    if (this.qtyType === "percent_of_equity") {
      return (this.sizingEquity(i) * this.qtyValue) / 100 / price;
    }
    return this.qtyValue;
  }

  /** Fill price at bar `i`, or NaN when the bar never reaches the trigger. */
  private tryFill(o: Order, i: number, base: number): number {
    const b = this.bars;
    const isBuy = o.kind === "entry" ? o.dir === 1 : o.dir === -1;
    if (o.mode === "market") {
      const slip = this.slippageTicks * this.tick;
      return isBuy ? base + slip : base - slip;
    }
    const open = b.open[i];
    if (o.mode === "limit") {
      if (isBuy) return open <= o.price ? open : b.low[i] <= o.price ? o.price : NA;
      return open >= o.price ? open : b.high[i] >= o.price ? o.price : NA;
    }
    if (isBuy) return open >= o.price ? open : b.high[i] >= o.price ? o.price : NA;
    return open <= o.price ? open : b.low[i] <= o.price ? o.price : NA;
  }

  private processPending(i: number, when: "open" | "close"): void {
    if (!this.pending.length) return;
    const base = when === "open" ? this.bars.open[i] : this.bars.close[i];
    const due = this.pending.filter((o) => (when === "close" ? o.createdBar <= i : o.createdBar < i));
    for (const o of due) {
      const price = this.tryFill(o, i, base);
      if (!Number.isFinite(price) || !(price > 0)) continue;
      if (o.kind === "entry") this.openPosition(o, i, price);
      else this.closeByOrder(o, i, price);
      const at = this.pending.indexOf(o);
      if (at >= 0) this.pending.splice(at, 1);
    }
  }

  private openPosition(o: Order, i: number, price: number): void {
    // TradingView nets the whole book: an entry against the current direction
    // closes every opposite position first, whatever order id opened them.
    // Scripts copied from tv.com (`strategy.entry("Long")` / `("Short")`) rely
    // on that to produce trades, so keying the reversal by id alone was wrong.
    for (const p of [...this.pos.values()]) {
      if (p.dir !== o.dir) this.settle(p, p.qty, i, price, "signal");
    }
    const held = this.pos.get(o.id);
    if (held) {
      // Pyramiding is scoped to one order id (TradingView does not count the
      // whole book), and hitting the cap is normal script behaviour, so the
      // extra entry is dropped in silence rather than reported as a gap.
      const limit = Math.max(1, this.pyramiding);
      if (held.extra >= limit) return;
      held.extra += 1;
    } else if (this.pos.size >= 1 && this.pyramiding <= 1) {
      // A same-direction entry under a different id: one position at a time.
      return;
    } else if (this.pos.size >= 64) {
      // Safety valve for scripts that mint a new id every bar.
      this.warn("持仓订单号数量超过 64，后续开仓已忽略");
      return;
    }
    const qty = this.qtyFor(o, price, i);
    if (!Number.isFinite(qty) || !(qty > 0)) {
      this.warn("下单数量算出来是 0（检查 default_qty_value / 初始资金），该订单已跳过");
      return;
    }
    const feeCash = this.fee(qty * price, qty);
    const live = this.pos.get(o.id);
    if (live) {
      const total = live.qty + qty;
      live.avg = (live.avg * live.qty + price * qty) / total;
      live.entryFees += feeCash;
      live.qty = total;
    } else {
      this.pos.set(o.id, {
        id: o.id,
        dir: o.dir,
        qty,
        avg: price,
        entryBar: i,
        entryTime: this.bars.time[i],
        entryFees: feeCash,
        extra: 0,
      });
    }
    this.cash -= o.dir * qty * price;
    this.cash -= feeCash;
    this.mark(i, o.dir === 1 ? "买入开仓" : "卖出开仓", o.dir === 1, price);
  }

  private closeByOrder(o: Order, i: number, price: number): void {
    const p = this.pos.get(o.id.split("#")[0]);
    if (!p) return;
    const take =
      o.qty > 0 ? Math.min(o.qty, p.qty) : o.qtyPercent > 0 ? (p.qty * o.qtyPercent) / 100 : p.qty;
    this.settle(p, take, i, price, o.mode === "stop" ? "stop" : o.mode === "limit" ? "limit" : "signal");
  }

  private settle(p: Position, qty: number, i: number, price: number, reason: string): void {
    if (!(qty > 0)) return;
    const b = this.bars;
    const gross = p.dir * qty * (price - p.avg);
    const feeCash = this.fee(qty * price, qty);
    const entryFee = (p.entryFees * qty) / Math.max(p.qty, 1e-12);
    const pnl = gross - feeCash - entryFee;
    this.cash += p.dir * qty * price;
    this.cash -= feeCash;
    this.realized += pnl;
    this.trades.push({
      side: p.dir === 1 ? "long" : "short",
      entryBar: p.entryBar,
      entryTime: p.entryTime,
      entryPrice: p.avg,
      exitBar: i,
      exitTime: b.time[i],
      exitPrice: price,
      qty,
      pnl,
      reason,
      retPct: p.avg === 0 ? NA : (pnl / (p.avg * qty)) * 100,
    });
    this.mark(i, p.dir === 1 ? "卖出平仓" : "买入平仓", p.dir !== 1, price);
    p.qty -= qty;
    p.entryFees -= entryFee;
    if (p.qty <= 1e-9) {
      this.pos.delete(p.id);
      // A dead position must not keep dragging bracket orders around.
      this.pending = this.pending.filter((o) => o.id.split("#")[0] !== p.id);
    }
  }

  /* -------------------------------------------------------------- reporting */

  private maxDrawdown(): number {
    let peak = -Infinity;
    let dd = 0;
    for (const e of this.equity) {
      if (Number.isNaN(e)) continue;
      peak = Math.max(peak, e);
      if (peak > 0) dd = Math.max(dd, ((peak - e) / peak) * 100);
    }
    return dd;
  }

  private maxRunUp(): number {
    let trough = Infinity;
    let ru = 0;
    for (const e of this.equity) {
      if (Number.isNaN(e)) continue;
      trough = Math.min(trough, e);
      if (trough > 0) ru = Math.max(ru, ((e - trough) / trough) * 100);
    }
    return ru;
  }

  /** TradingView-style strategy report over everything settled so far. */
  report(): PineReport {
    const wins = this.trades.filter((t) => t.pnl > 0);
    const losses = this.trades.filter((t) => t.pnl <= 0);
    const grossProfit = wins.reduce((a, t) => a + t.pnl, 0);
    const grossLoss = losses.reduce((a, t) => a - t.pnl, 0);
    const lastEq = this.equity.length ? this.equity[this.equity.length - 1] : this.initialCapital;
    // TradingView's "Net Profit" is realised only; the equity curve additionally
    // carries what is still open, so both numbers are reported separately.
    const net = this.realized;
    const unrealized = lastEq - this.initialCapital - net;
    const b = this.bars;
    const first = b.close[0] ?? 0;
    const last = b.close[b.close.length - 1] ?? 0;
    const openSide = [...this.pos.values()][0]?.dir;
    return {
      initialCapital: this.initialCapital,
      commissionPct: this.commissionMode === "percent" ? this.commissionValue : 0,
      slippagePct: this.slippageTicks ? (this.slippageTicks * this.tick * 100) / (last || 1) : 0,
      defaultQtyType: this.qtyType,
      defaultQtyValue: this.qtyValue,
      ordersOnClose: this.ordersOnClose,
      equity: this.equity.slice(0, b.list.length),
      trades: this.trades.slice(),
      openSide: openSide === undefined ? "flat" : openSide === 1 ? "long" : "short",
      openEntries: this.pos.size,
      netPnl: net,
      netPnlPct: this.initialCapital ? (net / this.initialCapital) * 100 : NA,
      unrealizedPnl: unrealized,
      returnPct: this.initialCapital ? ((lastEq - this.initialCapital) / this.initialCapital) * 100 : NA,
      closedCount: this.trades.length,
      winCount: wins.length,
      winRatePct: this.trades.length ? (wins.length / this.trades.length) * 100 : NA,
      grossProfit,
      grossLoss,
      profitFactor: grossLoss === 0 ? (grossProfit > 0 ? Number.POSITIVE_INFINITY : NA) : grossProfit / grossLoss,
      maxRunUp: this.maxRunUp(),
      maxDrawdownPct: this.maxDrawdown(),
      buyHoldPct: first ? ((last - first) / first) * 100 : NA,
      avgWin: wins.length ? grossProfit / wins.length : NA,
      avgLoss: losses.length ? grossLoss / losses.length : NA,
    };
  }
}
