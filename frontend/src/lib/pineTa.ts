/**
 * `ta.*` library for the Pine compatibility layer.
 *
 * Every rolling indicator here is written as a **state machine step**: the
 * interpreter hands the call site a mutable slot, the step advances it with the
 * current bar's sample and returns the value. That mirrors how TradingView
 * evaluates these functions once per bar, and it is what lets `ta.atr()` be
 * defined as `rma(trueRange)` without a vector pass over the whole series.
 */

import { PineError, type Arg, type Expr } from "./pineLang";
import {
  NA,
  argAt,
  asNum,
  flagArg,
  isNa,
  isTrue,
  numArg,
  type Builtin,
  type BuiltinCtx,
  type V,
} from "./pineTypes";

/* ------------------------------------------------------- rolling primitives */

interface Win {
  win: number[];
}
interface Prev {
  prev: number;
}
interface RmaState extends Win, Prev {}

function push(st: Win, x: number, keep: number): number[] {
  st.win.push(x);
  if (st.win.length > keep) st.win.splice(0, st.win.length - keep);
  return st.win;
}

function full(st: Win, n: number): boolean {
  return st.win.length >= n;
}

export function smaStep(src: number, n: number, st: Win): number {
  push(st, src, n);
  if (!full(st, n)) return NA;
  let acc = 0;
  for (const v of st.win) {
    if (Number.isNaN(v)) return NA;
    acc += v;
  }
  return acc / n;
}

export function sumStep(src: number, n: number, st: Win): number {
  push(st, Number.isNaN(src) ? 0 : src, n);
  if (!full(st, n)) return NA;
  return st.win.reduce((a, b) => a + b, 0);
}

export function wmaStep(src: number, n: number, st: Win): number {
  push(st, src, n);
  if (!full(st, n)) return NA;
  let num = 0;
  let den = 0;
  for (let i = 0; i < st.win.length; i++) {
    const v = st.win[i];
    if (Number.isNaN(v)) return NA;
    num += v * (i + 1);
    den += i + 1;
  }
  return den === 0 ? NA : num / den;
}

export function emaStep(src: number, n: number, st: Prev): number {
  if (Number.isNaN(src)) {
    st.prev = NA;
    return NA;
  }
  if (Number.isNaN(st.prev)) st.prev = src;
  else {
    const a = 2 / (n + 1);
    st.prev = a * src + (1 - a) * st.prev;
  }
  return st.prev;
}

export function rmaStep(src: number, n: number, st: RmaState): number {
  push(st, src, n);
  if (Number.isNaN(src)) {
    st.prev = NA;
    return NA;
  }
  if (Number.isNaN(st.prev)) {
    if (full(st, n)) {
      let acc = 0;
      let ok = true;
      for (const v of st.win) {
        if (Number.isNaN(v)) {
          ok = false;
          break;
        }
        acc += v;
      }
      if (ok) st.prev = acc / n;
    }
  } else {
    st.prev = (st.prev * (n - 1) + src) / n;
  }
  return st.prev;
}

export function devStep(src: number, n: number, st: Win): number {
  push(st, src, n);
  if (!full(st, n)) return NA;
  let mean = 0;
  for (const v of st.win) {
    if (Number.isNaN(v)) return NA;
    mean += v;
  }
  mean /= n;
  let acc = 0;
  for (const v of st.win) acc += Math.abs(v - mean);
  return acc / n;
}

export function stdStep(src: number, n: number, st: Win): number {
  push(st, src, n);
  if (!full(st, n) || n < 2) return NA;
  let mean = 0;
  for (const v of st.win) {
    if (Number.isNaN(v)) return NA;
    mean += v;
  }
  mean /= n;
  let sq = 0;
  for (const v of st.win) sq += (v - mean) ** 2;
  return Math.sqrt(sq / (n - 1));
}

export function highestStep(src: number, n: number, st: Win): number {
  push(st, src, n);
  let best = NA;
  for (const v of st.win) if (!Number.isNaN(v) && (Number.isNaN(best) || v > best)) best = v;
  return best;
}

export function lowestStep(src: number, n: number, st: Win): number {
  push(st, src, n);
  let best = NA;
  for (const v of st.win) if (!Number.isNaN(v) && (Number.isNaN(best) || v < best)) best = v;
  return best;
}

export function changeStep(src: number, st: Prev): number {
  const out = Number.isNaN(st.prev) || Number.isNaN(src) ? NA : src - st.prev;
  st.prev = src;
  return out;
}

export function cumStep(src: number, st: Prev): number {
  if (!Number.isNaN(src)) st.prev = Number.isNaN(st.prev) ? src : st.prev + src;
  return st.prev;
}

/** Percent change versus `n` bars ago — the shape shared by roc/kst/mom. */
export function rocStep(src: number, n: number, st: Win): number {
  push(st, src, n + 1);
  const back = st.win[st.win.length - 1 - n];
  if (back === undefined || Number.isNaN(back) || back === 0 || Number.isNaN(src)) return NA;
  return (src / back - 1) * 100;
}

/* -------------------------------------------------------------- argument sugar */

/** Source argument: `ta.sma(close, 20)` / `ta.sma(source=close, length=20)`. */
function srcOf(args: Arg[], c: BuiltinCtx, index = 0): number {
  const e = argAt(args, index, "source", "src", "x");
  return e ? asNum(c.val(e)) : NA;
}

function lenOf(args: Arg[], c: BuiltinCtx, index: number, def: number, who: string): number {
  const n = numArg(args, c, index, def, "length", "len", "period", "atrPeriod", "diLength");
  if (!Number.isFinite(n) || n <= 0) {
    throw new PineError(`${who}() 的周期必须是正数，实际是 ${n}`);
  }
  return Math.trunc(n);
}

const lit = (v: number): Expr => ({ k: "num", v, line: 0 });
const a1 = (v: number): Arg => ({ value: lit(v) });

/* --------------------------------------------------------------------- ta.* */

export const TA: Record<string, Builtin> = {
  sma: (args, c) => smaStep(srcOf(args, c), lenOf(args, c, 1, 14, "ta.sma"), c.state(() => ({ win: [] }) as Win)),
  ma: (args, c) => TA.sma(args, c),
  ema: (args, c) => emaStep(srcOf(args, c), lenOf(args, c, 1, 9, "ta.ema"), c.state(() => ({ prev: NA }) as Prev)),
  wma: (args, c) => wmaStep(srcOf(args, c), lenOf(args, c, 1, 14, "ta.wma"), c.state(() => ({ win: [] }) as Win)),
  rma: (args, c) =>
    rmaStep(srcOf(args, c), lenOf(args, c, 1, 9, "ta.rma"), c.state(() => ({ prev: NA, win: [] }) as RmaState)),

  vwma: (args, c) => {
    const src = srcOf(args, c);
    const n = lenOf(args, c, 1, 14, "ta.vwma");
    const volArg = argAt(args, 2, "volume");
    const vol = volArg ? asNum(c.val(volArg)) : c.bars.volume[c.bi];
    const st = c.state(() => ({ s: [], v: [] }) as { s: number[]; v: number[] });
    st.s.push(src);
    st.v.push(vol);
    if (st.s.length > n) {
      st.s.shift();
      st.v.shift();
    }
    if (st.s.length < n) return NA;
    let num = 0;
    let den = 0;
    for (let i = 0; i < n; i++) {
      if (Number.isNaN(st.s[i]) || Number.isNaN(st.v[i])) return NA;
      num += st.s[i] * st.v[i];
      den += st.v[i];
    }
    return den === 0 ? NA : num / den;
  },

  hma: (args, c) => {
    const src = srcOf(args, c);
    const n = lenOf(args, c, 1, 14, "ta.hma");
    const half = wmaStep(src, 2 * n, c.state(() => ({ win: [] }) as Win, "h2"));
    const fast = wmaStep(src, n, c.state(() => ({ win: [] }) as Win, "h1"));
    if (Number.isNaN(half) || Number.isNaN(fast)) return NA;
    return wmaStep(2 * fast - half, Math.max(1, Math.round(Math.sqrt(n))), c.state(() => ({ win: [] }) as Win, "h0"));
  },

  tma: (args, c) => {
    const src = srcOf(args, c);
    const n = lenOf(args, c, 1, 14, "ta.tma");
    const half = Math.ceil(n / 2);
    const a = wmaStep(src, half, c.state(() => ({ win: [] }) as Win, "t1"));
    if (Number.isNaN(a)) return NA;
    return wmaStep(a, n - half + 1, c.state(() => ({ win: [] }) as Win, "t2"));
  },

  swma: (args, c) => {
    const src = srcOf(args, c);
    const n = lenOf(args, c, 1, 14, "ta.swma");
    const a = wmaStep(src, n, c.state(() => ({ win: [] }) as Win, "w1"));
    if (Number.isNaN(a)) return NA;
    return wmaStep(a, n, c.state(() => ({ win: [] }) as Win, "w2"));
  },

  zma: (args, c) => {
    const src = srcOf(args, c);
    const n = lenOf(args, c, 1, 14, "ta.zma");
    const w = wmaStep(src, n, c.state(() => ({ win: [] }) as Win, "w"));
    if (Number.isNaN(w)) return NA;
    const st = c.state(() => ({ prev: NA }) as Prev, "zl");
    const out = Number.isNaN(st.prev) ? w : ((2 * n - 1) * (w - st.prev)) / (n + 1) + st.prev;
    st.prev = w;
    return out;
  },

  tema: (args, c) => {
    const src = srcOf(args, c);
    const n = lenOf(args, c, 1, 14, "ta.tema");
    const s = () => ({ prev: NA }) as Prev;
    const e1 = emaStep(src, n, c.state(s, "e1"));
    const e2 = emaStep(e1, n, c.state(s, "e2"));
    const e3 = emaStep(e2, n, c.state(s, "e3"));
    if ([e1, e2, e3].some(Number.isNaN)) return NA;
    return 3 * (e1 - e2) + e3;
  },

  alma: (args, c) => {
    const src = srcOf(args, c);
    const n = lenOf(args, c, 1, 9, "ta.alma");
    const offset = numArg(args, c, 2, 0.85, "offset", "windowOffset");
    const sigma = numArg(args, c, 3, 6, "sigma", "windowSigma");
    const st = c.state(() => ({ win: [] }) as Win);
    push(st, src, n);
    if (!full(st, n)) return NA;
    const m = offset * (n - 1);
    const sd = n / (sigma || 1);
    let num = 0;
    let den = 0;
    st.win.forEach((v, i) => {
      if (Number.isNaN(v)) return;
      const w = Math.exp(-((i - m) ** 2) / (2 * sd * sd));
      num += v * w;
      den += w;
    });
    return den === 0 ? NA : num / den;
  },

  change: (args, c) => changeStep(srcOf(args, c), c.state(() => ({ prev: NA }) as Prev)),

  change_log: (args, c) => {
    const src = srcOf(args, c);
    const st = c.state(() => ({ prev: NA }) as Prev);
    const out = Number.isNaN(st.prev) || st.prev <= 0 || Number.isNaN(src) ? NA : Math.log(src / st.prev);
    st.prev = src;
    return out;
  },

  cum: (args, c) => cumStep(srcOf(args, c), c.state(() => ({ prev: NA }) as Prev)),

  mom: (args, c) => {
    const src = srcOf(args, c);
    const n = lenOf(args, c, 1, 14, "ta.mom");
    const st = c.state(() => ({ win: [] }) as Win);
    push(st, src, n + 1);
    const back = st.win[st.win.length - 1 - n];
    return back === undefined || Number.isNaN(back) || Number.isNaN(src) ? NA : src - back;
  },

  roc: (args, c) => rocStep(srcOf(args, c), lenOf(args, c, 1, 9, "ta.roc"), c.state(() => ({ win: [] }) as Win)),

  highest: (args, c) => highestStep(srcOf(args, c), lenOf(args, c, 1, 14, "ta.highest"), c.state(() => ({ win: [] }) as Win)),
  lowest: (args, c) => lowestStep(srcOf(args, c), lenOf(args, c, 1, 14, "ta.lowest"), c.state(() => ({ win: [] }) as Win)),

  highestbars: (args, c) => barOffset(args, c, "max"),
  lowestbars: (args, c) => barOffset(args, c, "min"),

  stdev: (args, c) => stdStep(srcOf(args, c), lenOf(args, c, 1, 14, "ta.stdev"), c.state(() => ({ win: [] }) as Win)),
  std: (args, c) => TA.stdev(args, c),
  deviation: (args, c) => devStep(srcOf(args, c), lenOf(args, c, 1, 14, "ta.deviation"), c.state(() => ({ win: [] }) as Win)),
  dev: (args, c) => devStep(srcOf(args, c), lenOf(args, c, 1, 14, "ta.dev"), c.state(() => ({ win: [] }) as Win)),
  var: (args, c) => {
    const s = TA.stdev(args, c) as number;
    return Number.isNaN(s) ? NA : s * s;
  },
  variance: (args, c) => TA.var(args, c),

  median: (args, c) => {
    const src = srcOf(args, c);
    const n = lenOf(args, c, 1, 14, "ta.median");
    const st = c.state(() => ({ win: [] }) as Win);
    push(st, src, n);
    if (!full(st, n)) return NA;
    const w = st.win.filter((v) => !Number.isNaN(v)).sort((a, b) => a - b);
    if (!w.length) return NA;
    const mid = Math.floor(w.length / 2);
    return w.length % 2 ? w[mid] : (w[mid - 1] + w[mid]) / 2;
  },

  corr: (args, c) => {
    const x = srcOf(args, c);
    const yArg = argAt(args, 1, "b", "y");
    const y = yArg ? asNum(c.val(yArg)) : NA;
    const n = lenOf(args, c, 2, 14, "ta.corr");
    const st = c.state(() => ({ x: [], y: [] }) as { x: number[]; y: number[] });
    st.x.push(x);
    st.y.push(y);
    if (st.x.length > n) {
      st.x.shift();
      st.y.shift();
    }
    if (st.x.length < n) return NA;
    const mx = st.x.reduce((a, b) => a + b, 0) / n;
    const my = st.y.reduce((a, b) => a + b, 0) / n;
    let num = 0;
    let dx = 0;
    let dy = 0;
    for (let i = 0; i < n; i++) {
      const u = st.x[i] - mx;
      const v = st.y[i] - my;
      num += u * v;
      dx += u * u;
      dy += v * v;
    }
    return dx === 0 || dy === 0 ? NA : num / Math.sqrt(dx * dy);
  },

  crossover: (args, c) => crossStep(args, c, "above"),
  crossunder: (args, c) => crossStep(args, c, "below"),
  cross: (args, c) => (crossStep(args, c, "above", "x") || crossStep(args, c, "below", "x") ? 1 : 0),

  barssince: (args, c) => {
    const e = argAt(args, 0, "condition", "cond", "source");
    const v = e ? c.val(e) : NA;
    const countNa = flagArg(args, c, 1, false, "count_na");
    const st = c.state(() => ({ hist: [] }) as { hist: V[] });
    st.hist.push(v);
    if (st.hist.length > 5000) st.hist.shift();
    for (let i = st.hist.length - 1; i >= 0; i--) {
      const h = st.hist[i];
      if (!countNa && isNa(asNum(h))) continue;
      if (isTrue(h)) return st.hist.length - 1 - i;
    }
    return NA;
  },

  tr: (args, c) => {
    const absolute = flagArg(args, c, 0, false, "absolute");
    const b = c.bars;
    const i = c.bi;
    const pc = i > 0 ? b.close[i - 1] : b.close[i];
    const raw = Math.max(b.high[i] - b.low[i], Math.abs(b.high[i] - pc), Math.abs(b.low[i] - pc));
    if (!absolute) return raw;
    return Math.max(b.high[i], pc) - Math.min(b.low[i], pc);
  },

  atr: (args, c) => {
    const n = lenOf(args, c, 0, 14, "ta.atr");
    return rmaStep(asNum(TA.tr([], c)), n, c.state(() => ({ prev: NA, win: [] }) as RmaState, "atr"));
  },

  rsi: (args, c) => {
    const src = args.length ? srcOf(args, c) : c.bars.close[c.bi];
    const n = lenOf(args, c, 1, 14, "ta.rsi");
    const d = changeStep(src, c.state(() => ({ prev: NA }) as Prev, "d"));
    const up = rmaStep(Number.isNaN(d) || d < 0 ? 0 : d, n, c.state(() => ({ prev: NA, win: [] }) as RmaState, "up"));
    const dn = rmaStep(Number.isNaN(d) || d > 0 ? 0 : -d, n, c.state(() => ({ prev: NA, win: [] }) as RmaState, "dn"));
    if (Number.isNaN(up) || Number.isNaN(dn)) return NA;
    if (dn === 0) return up === 0 ? 50 : 100;
    return 100 - 100 / (1 + up / dn);
  },

  cci: (args, c) => {
    const src = srcOf(args, c);
    const n = lenOf(args, c, 1, 20, "ta.cci");
    const m = smaStep(src, n, c.state(() => ({ win: [] }) as Win, "m"));
    const dv = devStep(src, n, c.state(() => ({ win: [] }) as Win, "d"));
    if (Number.isNaN(m) || Number.isNaN(dv) || dv === 0) return NA;
    return (src - m) / (0.015 * dv);
  },

  mfi: (args, c) => {
    const n = lenOf(args, c, 0, 14, "ta.mfi");
    const b = c.bars;
    const i = c.bi;
    const tp = (b.high[i] + b.low[i] + b.close[i]) / 3;
    const ptp = i > 0 ? (b.high[i - 1] + b.low[i - 1] + b.close[i - 1]) / 3 : tp;
    const flow = tp * b.volume[i];
    const st = c.state(() => ({ p: [], q: [] }) as { p: number[]; q: number[] });
    st.p.push(tp > ptp ? flow : 0);
    st.q.push(tp < ptp ? flow : 0);
    if (st.p.length > n) {
      st.p.shift();
      st.q.shift();
    }
    if (st.p.length < n) return NA;
    const sp = st.p.reduce((x, y) => x + y, 0);
    const sn = st.q.reduce((x, y) => x + y, 0);
    return sn === 0 ? 100 : 100 - 100 / (1 + sp / sn);
  },

  wpr: (args, c) => {
    const n = lenOf(args, c, 0, 14, "ta.wpr");
    const b = c.bars;
    const hi = highestStep(b.high[c.bi], n, c.state(() => ({ win: [] }) as Win, "h"));
    const lo = lowestStep(b.low[c.bi], n, c.state(() => ({ win: [] }) as Win, "l"));
    if (Number.isNaN(hi) || Number.isNaN(lo) || hi === lo) return NA;
    return (-100 * (hi - b.close[c.bi])) / (hi - lo);
  },

  stoch: (args, c) => {
    // (src, high, low, length[, smoothK]) -> %K; (src, length, smoothing) -> [K, D]
    if (args.length >= 4) {
      const src = srcOf(args, c);
      const hiArg = argAt(args, 1, "high");
      const loArg = argAt(args, 2, "low");
      const hiSeries = hiArg ? asNum(c.val(hiArg)) : c.bars.high[c.bi];
      const loSeries = loArg ? asNum(c.val(loArg)) : c.bars.low[c.bi];
      const n = lenOf(args, c, 3, 14, "ta.stoch");
      const smooth = Math.trunc(numArg(args, c, 4, 1, "smoothK", "smoothing")) || 1;
      const hh = highestStep(hiSeries, n, c.state(() => ({ win: [] }) as Win, "H"));
      const ll = lowestStep(loSeries, n, c.state(() => ({ win: [] }) as Win, "L"));
      if (Number.isNaN(hh) || Number.isNaN(ll) || hh === ll) return NA;
      const k = (100 * (src - ll)) / (hh - ll);
      return smooth <= 1 ? k : smaStep(k, smooth, c.state(() => ({ win: [] }) as Win, "S"));
    }
    const src = srcOf(args, c);
    const n = lenOf(args, c, 1, 14, "ta.stoch");
    const smooth = lenOf(args, c, 2, 3, "ta.stoch");
    const hh = highestStep(c.bars.high[c.bi], n, c.state(() => ({ win: [] }) as Win, "H"));
    const ll = lowestStep(c.bars.low[c.bi], n, c.state(() => ({ win: [] }) as Win, "L"));
    const k = Number.isNaN(hh) || Number.isNaN(ll) || hh === ll ? NA : (100 * (src - ll)) / (hh - ll);
    const d = Number.isNaN(k) ? NA : smaStep(k, smooth, c.state(() => ({ win: [] }) as Win, "D"));
    return [k, d];
  },

  macd: (args, c) => {
    const src = args.length ? srcOf(args, c) : c.bars.close[c.bi];
    const fast = lenOf(args, c, 1, 12, "ta.macd");
    const slow = lenOf(args, c, 2, 26, "ta.macd");
    const sig = lenOf(args, c, 3, 9, "ta.macd");
    const e1 = emaStep(src, fast, c.state(() => ({ prev: NA }) as Prev, "f"));
    const e2 = emaStep(src, slow, c.state(() => ({ prev: NA }) as Prev, "s"));
    if (Number.isNaN(e1) || Number.isNaN(e2)) return [NA, NA, NA];
    const line = e1 - e2;
    const s = emaStep(line, sig, c.state(() => ({ prev: NA }) as Prev, "g"));
    return [line, s, Number.isNaN(s) ? NA : line - s];
  },

  bb: (args, c) => {
    const src = args.length ? srcOf(args, c) : c.bars.close[c.bi];
    const n = lenOf(args, c, 1, 20, "ta.bb");
    const mult = numArg(args, c, 2, 2, "mult", "dev", "stddev");
    const basis = smaStep(src, n, c.state(() => ({ win: [] }) as Win, "m"));
    const dv = stdStep(src, n, c.state(() => ({ win: [] }) as Win, "d"));
    if (Number.isNaN(basis) || Number.isNaN(dv)) return [NA, NA, NA];
    return [basis, basis + mult * dv, basis - mult * dv];
  },

  bbw: (args, c) => {
    const src = args.length ? srcOf(args, c) : c.bars.close[c.bi];
    const n = lenOf(args, c, 1, 20, "ta.bbw");
    const mult = numArg(args, c, 2, 2, "mult", "dev");
    const t = TA.bb([a1(src), a1(n), a1(mult)], c) as number[];
    if (t.length < 3 || Number.isNaN(t[0]) || t[0] === 0) return NA;
    return ((t[1] - t[2]) / t[0]) * 100;
  },

  kc: (args, c) => {
    const src = args.length ? srcOf(args, c) : (c.bars.high[c.bi] + c.bars.low[c.bi] + c.bars.close[c.bi]) / 3;
    const n = lenOf(args, c, 1, 20, "ta.kc");
    const mult = numArg(args, c, 2, 1, "mult", "atrMultiplier", "percentage");
    const basis = emaStep(src, n, c.state(() => ({ prev: NA }) as Prev, "m"));
    const rng = rmaStep(asNum(TA.tr([], c)), n, c.state(() => ({ prev: NA, win: [] }) as RmaState, "a"));
    if (Number.isNaN(basis) || Number.isNaN(rng)) return [NA, NA, NA];
    return [basis, basis + mult * rng, basis - mult * rng];
  },

  /**
   * A literal port of TradingView's own Pine body, because scripts pasted from
   * tv.com hand-write exactly this logic and both paths must land on the same
   * track. Two details that are easy to get wrong and that imported scripts
   * depend on:
   *   - the trend state is keyed on `prevSuperTrend == prevUpperBand`, not on a
   *     boolean flag, and the flip test uses *this* bar's close;
   *   - `direction` is 1 in a downtrend (line above price) and -1 in an
   *     uptrend, which is why `plot(direction < 0 ? supertrend : na, "Up")`.
   */
  supertrend: (args, c) => {
    // v6: ta.supertrend(factor, atrPeriod); earlier: (source, factor, period)
    const threeArg = args.length >= 3;
    const factor = numArg(args, c, threeArg ? 1 : 0, 3, "factor");
    const period = lenOf(args, c, threeArg ? 2 : 1, 10, "ta.supertrend");
    const b = c.bars;
    const i = c.bi;
    const given = threeArg && args.length ? asNum(c.val(args[0].value)) : NA;
    const src = Number.isFinite(given) ? given : (b.high[i] + b.low[i]) / 2;
    const atr = rmaStep(asNum(TA.tr([], c)), period, c.state(() => ({ prev: NA, win: [] }) as RmaState, "a"));
    const st = c.state(
      () => ({ ub: NA, lb: NA, prevSt: NA, prevAtr: NA }) as {
        ub: number;
        lb: number;
        prevSt: number;
        prevAtr: number;
      },
    );
    const prevAtr = st.prevAtr;
    st.prevAtr = atr;
    if (Number.isNaN(atr)) return [NA, NA];
    const prevUb = st.ub;
    const prevLb = st.lb;
    const prevClose = i > 0 ? b.close[i - 1] : NA;
    // Bands only ratchet: an upper band never rises unless price closed above
    // it, a lower band never falls unless price closed below it (`nz()` makes
    // the cold start a no-op, which is what the NaN guard below reproduces).
    let ub = src + factor * atr;
    let lb = src - factor * atr;
    if (Number.isFinite(prevUb) && !(ub < prevUb || prevClose > prevUb)) ub = prevUb;
    if (Number.isFinite(prevLb) && !(lb > prevLb || prevClose < prevLb)) lb = prevLb;
    st.ub = ub;
    st.lb = lb;
    let dir: number;
    if (!Number.isFinite(prevAtr)) dir = 1;
    else if (st.prevSt === prevUb) dir = b.close[i] > ub ? -1 : 1;
    else dir = b.close[i] < lb ? 1 : -1;
    const line = dir === -1 ? lb : ub;
    st.prevSt = line;
    return [line, dir];
  },

  sar: (args, c) => {
    const start = numArg(args, c, 0, 0.02, "start");
    const inc = numArg(args, c, 1, 0.02, "increment", "inc");
    const cap = numArg(args, c, 2, 0.2, "maximum", "max");
    const b = c.bars;
    const i = c.bi;
    const st = c.state(() => ({ sar: NA, ep: NA, af: start, up: true })) as {
      sar: number;
      ep: number;
      af: number;
      up: boolean;
    };
    if (i < 2 || Number.isNaN(st.sar)) {
      st.up = b.high[i] >= (i > 0 ? b.high[i - 1] : b.high[i]);
      st.sar = st.up ? Math.min(b.low[i], i > 0 ? b.low[i - 1] : b.low[i]) : Math.max(b.high[i], i > 0 ? b.high[i - 1] : b.high[i]);
      st.ep = st.up ? b.high[i] : b.low[i];
      st.af = start;
      return st.sar;
    }
    const l1 = b.low[i - 1];
    const l2 = i > 1 ? b.low[i - 2] : l1;
    const h1 = b.high[i - 1];
    const h2 = i > 1 ? b.high[i - 2] : h1;
    if (st.up) {
      st.sar = Math.min(st.sar + st.af * (st.ep - st.sar), l1, l2);
      if (b.low[i] < st.sar) {
        st.up = false;
        st.sar = st.ep;
        st.ep = b.low[i];
        st.af = start;
      } else if (b.high[i] > st.ep) {
        st.ep = b.high[i];
        st.af = Math.min(cap, st.af + inc);
      }
    } else {
      st.sar = Math.max(st.sar + st.af * (st.ep - st.sar), h1, h2);
      if (b.high[i] > st.sar) {
        st.up = true;
        st.sar = st.ep;
        st.ep = b.high[i];
        st.af = start;
      } else if (b.low[i] < st.ep) {
        st.ep = b.low[i];
        st.af = Math.min(cap, st.af + inc);
      }
    }
    return st.sar;
  },

  tsi: (args, c) => {
    const src = args.length ? srcOf(args, c) : c.bars.close[c.bi];
    const long = lenOf(args, c, 1, 25, "ta.tsi");
    const short = lenOf(args, c, 2, 13, "ta.tsi");
    const d = changeStep(src, c.state(() => ({ prev: NA }) as Prev, "d"));
    const m1 = rmaStep(Math.abs(d), long, c.state(() => ({ prev: NA, win: [] }) as RmaState, "a"));
    const m0 = rmaStep(d, long, c.state(() => ({ prev: NA, win: [] }) as RmaState, "b"));
    if (Number.isNaN(m0) || Number.isNaN(m1) || m1 === 0) return NA;
    const t = (m0 / m1) * 100;
    const sig = emaStep(t, short, c.state(() => ({ prev: NA }) as Prev, "e"));
    return Number.isNaN(sig) ? NA : sig * 100;
  },

  ao: (args, c) => {
    const b = c.bars;
    const mid = (b.high[c.bi] + b.low[c.bi]) / 2;
    const fast = lenOf(args, c, 0, 5, "ta.ao");
    const slow = lenOf(args, c, 1, 34, "ta.ao");
    const x = smaStep(mid, fast, c.state(() => ({ win: [] }) as Win, "f"));
    const y = smaStep(mid, slow, c.state(() => ({ win: [] }) as Win, "s"));
    return Number.isNaN(x) || Number.isNaN(y) ? NA : x - y;
  },

  ac: (args, c) => {
    const fast = lenOf(args, c, 0, 5, "ta.ac");
    const slow = lenOf(args, c, 1, 34, "ta.ac");
    const ao = asNum(TA.ao([a1(fast), a1(slow)], c));
    if (Number.isNaN(ao)) return NA;
    const m = smaStep(ao, 5, c.state(() => ({ win: [] }) as Win, "m"));
    return Number.isNaN(m) ? NA : ao - m;
  },

  dpo: (args, c) => {
    const src = args.length ? srcOf(args, c) : c.bars.close[c.bi];
    const n = lenOf(args, c, 1, 20, "ta.dpo");
    const back = Math.trunc(n / 2) + 1;
    const st = c.state(() => ({ win: [] }) as Win);
    push(st, src, n + back);
    const shifted = st.win[st.win.length - back];
    const w = st.win.slice(0, st.win.length - back + 1).slice(-n);
    if (shifted === undefined || w.length < n || Number.isNaN(shifted)) return NA;
    return shifted - smaStep(src, n, c.state(() => ({ win: [] }) as Win, "s"));
  },

  kst: (args, c) => {
    const src = args.length ? srcOf(args, c) : c.bars.close[c.bi];
    const rl = [10, 15, 20, 30].map((d, i) => lenOf(args, c, i + 1, d, "ta.kst"));
    const rs = [10, 10, 10, 15].map((d, i) => lenOf(args, c, i + 5, d, "ta.kst"));
    const parts = rl.map((n, k) => {
      // Own slot per component: all four share this call site, so they must not
      // read and write one rolling window.
      const r = rocStep(src, n, c.state(() => ({ win: [] }) as Win, `r${k}`));
      return Number.isNaN(r) ? NA : emaStep(r, rs[k], c.state(() => ({ prev: NA }) as Prev, `e${k}`));
    });
    if (parts.some(Number.isNaN)) return [NA, NA, NA];
    const value = parts[0] + 2 * parts[1] + 3 * parts[2] + 4 * parts[3];
    const sigLen = lenOf(args, c, 9, 9, "ta.kst");
    const sig = emaStep(value, sigLen, c.state(() => ({ prev: NA }) as Prev, "g"));
    return [value, sig, Number.isNaN(sig) ? NA : value - sig];
  },

  cmo: (args, c) => {
    const src = srcOf(args, c);
    const n = lenOf(args, c, 1, 14, "ta.cmo");
    const d = changeStep(src, c.state(() => ({ prev: NA }) as Prev, "d"));
    const st = c.state(() => ({ up: [], dn: [] }) as { up: number[]; dn: number[] });
    st.up.push(Number.isNaN(d) || d < 0 ? 0 : d);
    st.dn.push(Number.isNaN(d) || d > 0 ? 0 : -d);
    if (st.up.length > n) {
      st.up.shift();
      st.dn.shift();
    }
    if (st.up.length < n) return NA;
    const su = st.up.reduce((x, y) => x + y, 0);
    const sd = st.dn.reduce((x, y) => x + y, 0);
    return su + sd === 0 ? NA : (100 * (su - sd)) / (su + sd);
  },

  dmi: (args, c) => {
    const n = lenOf(args, c, 0, 14, "ta.dmi");
    const adxLen = lenOf(args, c, 1, 14, "ta.dmi");
    const b = c.bars;
    const i = c.bi;
    if (i < 1) return [NA, NA, NA];
    const up = b.high[i] - b.high[i - 1];
    const dn = b.low[i - 1] - b.low[i];
    const plus = up > dn && up > 0 ? up : 0;
    const minus = dn > up && dn > 0 ? dn : 0;
    const p = rmaStep(plus, n, c.state(() => ({ prev: NA, win: [] }) as RmaState, "p"));
    const m = rmaStep(minus, n, c.state(() => ({ prev: NA, win: [] }) as RmaState, "m"));
    const t = rmaStep(asNum(TA.tr([], c)), n, c.state(() => ({ prev: NA, win: [] }) as RmaState, "t"));
    if (Number.isNaN(p) || Number.isNaN(m) || Number.isNaN(t) || t === 0) return [NA, NA, NA];
    const pdi = (100 * p) / t;
    const mdi = (100 * m) / t;
    const dx = pdi + mdi === 0 ? NA : (100 * Math.abs(pdi - mdi)) / (pdi + mdi);
    const adx = Number.isNaN(dx) ? NA : rmaStep(dx, adxLen, c.state(() => ({ prev: NA, win: [] }) as RmaState, "x"));
    return [pdi, mdi, adx];
  },

  adxr: (args, c) => {
    const n = lenOf(args, c, 0, 14, "ta.adxr");
    const l = lenOf(args, c, 1, 14, "ta.adxr");
    const t = TA.dmi([a1(n), a1(l)], c) as number[];
    const adx = t[2];
    const st = c.state(() => ({ win: [] }) as Win);
    push(st, Number.isNaN(adx) ? NA : adx, 2 * l);
    const past = st.win[st.win.length - 1 - l];
    return Number.isNaN(adx) || past === undefined || Number.isNaN(past) ? NA : (adx + past) / 2;
  },

  obv: (args, c) => {
    const src = args.length ? srcOf(args, c) : c.bars.close[c.bi];
    const volArg = argAt(args, 1, "volume");
    const vol = volArg ? asNum(c.val(volArg)) : c.bars.volume[c.bi];
    const st = c.state(() => ({ prev: NA, acc: 0 })) as { prev: number; acc: number };
    if (Number.isNaN(st.prev)) st.prev = src;
    else if (!Number.isNaN(src)) {
      if (src > st.prev) st.acc += vol;
      else if (src < st.prev) st.acc -= vol;
      st.prev = src;
    }
    return st.acc;
  },

  ad: (_args, c) => {
    const b = c.bars;
    const i = c.bi;
    const st = c.state(() => ({ acc: 0 })) as { acc: number };
    const span = b.high[i] - b.low[i];
    if (span !== 0) st.acc += ((2 * b.close[i] - b.high[i] - b.low[i]) / span) * b.volume[i];
    return st.acc;
  },

  adi: (_args, c) => {
    const b = c.bars;
    const i = c.bi;
    const st = c.state(() => ({ ad: 0, vol: 0 })) as { ad: number; vol: number };
    const span = b.high[i] - b.low[i];
    if (span !== 0) st.ad += ((2 * b.close[i] - b.high[i] - b.low[i]) / span) * b.volume[i];
    st.vol += b.volume[i];
    return st.vol === 0 ? NA : st.ad / st.vol;
  },

  cmf: (args, c) => {
    const n = lenOf(args, c, 0, 20, "ta.cmf");
    const b = c.bars;
    const i = c.bi;
    const span = b.high[i] - b.low[i];
    const mf = (span === 0 ? 0 : ((2 * b.close[i] - b.high[i] - b.low[i]) / span) * b.volume[i]);
    const num = sumStep(mf, n, c.state(() => ({ win: [] }) as Win, "n"));
    const den = sumStep(b.volume[i], n, c.state(() => ({ win: [] }) as Win, "d"));
    return Number.isNaN(num) || Number.isNaN(den) || den === 0 ? NA : num / den;
  },

  eom: (args, c) => {
    const n = lenOf(args, c, 0, 14, "ta.eom");
    const scale = numArg(args, c, 1, 1e8, "scale");
    const b = c.bars;
    const i = c.bi;
    const span = b.high[i] - b.low[i];
    if (span === 0 || b.volume[i] === 0) return NA;
    const box = (b.volume[i] * span) / scale;
    const mid = (b.high[i] + b.low[i]) / 2 - (i > 0 ? (b.high[i - 1] + b.low[i - 1]) / 2 : NA);
    return smaStep(mid / box, n, c.state(() => ({ win: [] }) as Win, "s"));
  },

  massi: (args, c) => {
    const n = lenOf(args, c, 0, 9, "ta.massi");
    const sumN = lenOf(args, c, 1, 25, "ta.massi");
    const b = c.bars;
    const rng = b.high[c.bi] - b.low[c.bi];
    const e1 = emaStep(rng, n, c.state(() => ({ prev: NA }) as Prev, "1"));
    if (Number.isNaN(e1) || e1 === 0) return NA;
    const e2 = emaStep(e1, n, c.state(() => ({ prev: NA }) as Prev, "2"));
    if (Number.isNaN(e2) || e2 === 0) return NA;
    return sumStep(e1 / e2, sumN, c.state(() => ({ win: [] }) as Win, "s"));
  },

  nvi: (args, c) => volumeIndex(args, c, false),
  pvi: (args, c) => volumeIndex(args, c, true),

  vwap: (args, c) => {
    // TradingView anchors this at the session start; here it accumulates over
    // the loaded range (the runtime notes that once as a warning).
    const src = args.length ? srcOf(args, c) : (c.bars.high[c.bi] + c.bars.low[c.bi] + c.bars.close[c.bi]) / 3;
    const st = c.state(() => ({ pv: 0, v: 0 })) as { pv: number; v: number };
    if (!Number.isNaN(src)) {
      st.pv += src * c.bars.volume[c.bi];
      st.v += c.bars.volume[c.bi];
    }
    return st.v === 0 ? NA : st.pv / st.v;
  },

  trix: (args, c) => {
    const src = args.length ? srcOf(args, c) : c.bars.close[c.bi];
    const n = lenOf(args, c, 1, 15, "ta.trix");
    const sigLen = lenOf(args, c, 2, 9, "ta.trix");
    const e1 = emaStep(src, n, c.state(() => ({ prev: NA }) as Prev, "1"));
    const e2 = emaStep(e1, n, c.state(() => ({ prev: NA }) as Prev, "2"));
    const e3 = emaStep(e2, n, c.state(() => ({ prev: NA }) as Prev, "3"));
    const st = c.state(() => ({ prev: NA }) as Prev, "c");
    const out = Number.isNaN(e3) || Number.isNaN(st.prev) || st.prev === 0 ? NA : 10000 * (e3 / st.prev - 1);
    st.prev = e3;
    const sig = Number.isNaN(out) ? NA : emaStep(out, sigLen, c.state(() => ({ prev: NA }) as Prev, "s"));
    return [out, sig];
  },

  force: (args, c) => {
    const src = srcOf(args, c);
    const n = lenOf(args, c, 1, 13, "ta.force");
    const b = c.bars;
    const d = b.close[c.bi] - (c.bi > 0 ? b.close[c.bi - 1] : b.close[c.bi]);
    return emaStep(d * src, n, c.state(() => ({ prev: NA }) as Prev));
  },

  // Needs bars from the future (Pine confirms a pivot `left`+`right` later);
  // kept as na so such scripts still run, and the runtime warns once.
  pivot_high: () => NA,
  pivot_low: () => NA,

  pivot_point: (args, c) => {
    const typeArg = argAt(args, 0, "type");
    const type = typeArg ? String(c.val(typeArg)) : "classic";
    const b = c.bars;
    const i = c.bi;
    if (i < 1) return NA;
    const h = b.high[i - 1];
    const l = b.low[i - 1];
    const cl = b.close[i - 1];
    const p = (h + l + cl) / 3;
    switch (type) {
      case "resistance1":
      case "R1":
        return 2 * p - l;
      case "support1":
      case "S1":
        return 2 * p - h;
      case "resistance2":
      case "R2":
        return p + (h - l);
      case "support2":
      case "S2":
        return p - (h - l);
      case "resistance3":
      case "R3":
        return h + 2 * (p - l);
      case "support3":
      case "S3":
        return l - 2 * (h - p);
      default:
        return p;
    }
  },
};

function barOffset(args: Arg[], c: BuiltinCtx, dir: "max" | "min"): number {
  const src = srcOf(args, c);
  const n = lenOf(args, c, 1, 14, `ta.${dir}bars`);
  const st = c.state(() => ({ win: [] }) as Win);
  push(st, src, n);
  let best = NA;
  let at = NA;
  st.win.forEach((v, i) => {
    if (Number.isNaN(v)) return;
    const better = Number.isNaN(best) || (dir === "max" ? v >= best : v <= best);
    if (better) {
      best = v;
      at = i - (st.win.length - 1);
    }
  });
  return at;
}

function crossStep(args: Arg[], c: BuiltinCtx, dir: "above" | "below", sub: string = dir): 0 | 1 {
  const ea = argAt(args, 0, "long", "a", "series1");
  const eb = argAt(args, 1, "short", "b", "series2");
  const a = ea ? asNum(c.val(ea)) : NA;
  const b = eb ? asNum(c.val(eb)) : NA;
  const st = c.state(() => ({ pa: NA, pb: NA }) as { pa: number; pb: number }, sub);
  const pa = st.pa;
  const pb = st.pb;
  st.pa = a;
  st.pb = b;
  if ([a, b, pa, pb].some(Number.isNaN)) return 0;
  if (dir === "above") return pa <= pb && a > b ? 1 : 0;
  return pa >= pb && a < b ? 1 : 0;
}

/** Positive/Negative Volume Index: only moves on up/down volume days. */
function volumeIndex(_args: Arg[], c: BuiltinCtx, positive: boolean): number {
  const b = c.bars;
  const i = c.bi;
  const st = c.state(() => ({ prevVol: NA, val: 1000 })) as { prevVol: number; val: number };
  if (Number.isNaN(st.prevVol)) {
    st.prevVol = b.volume[i];
    return st.val;
  }
  const rises = positive ? b.volume[i] > st.prevVol : b.volume[i] < st.prevVol;
  const back = i > 0 ? b.close[i - 1] : b.close[i];
  if (rises && back !== 0) st.val += st.val * ((b.close[i] - back) / back);
  st.prevVol = b.volume[i];
  return st.val;
}
