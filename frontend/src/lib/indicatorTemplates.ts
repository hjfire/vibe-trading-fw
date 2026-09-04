/**
 * Built-in formula templates for the user-indicator editor (local custom ⑩).
 *
 * Written in the mini formula language (see indicatorLang.ts: assignments,
 * `return { 名称: 序列 }`, broadcasting arithmetic, no eval). Users load one,
 * tweak the math or parameters, and save it as their own indicator.
 * `kind: "overlay"` mounts on the price chart, `"pane"` gets a sub-chart.
 */

export interface FormulaTemplate {
  key: string;
  label: string;
  kind: "overlay" | "pane";
  params: number[];
  code: string;
}

export const FORMULA_TEMPLATES: FormulaTemplate[] = [
  {
    key: "ema-cross",
    label: "EMA 双线（主图）",
    kind: "overlay",
    params: [9, 21],
    code: `// EMA 快慢线，参数 P = [快线, 慢线]
fast = ema(close, P[0]);
slow = ema(close, P[1]);
return { EMA_F: fast, EMA_S: slow };`,
  },
  {
    key: "boll",
    label: "布林带 BOLL（主图）",
    kind: "overlay",
    params: [20, 2],
    code: `// 布林带：中轨 ± k 倍标准差，参数 P = [周期, 倍数]
mid = ma(close, P[0]);
sd = stdev(close, P[0]);
return { MID: mid, UP: mid + P[1] * sd, LOW: mid - P[1] * sd };`,
  },
  {
    key: "donchian",
    label: "唐奇安通道（主图）",
    kind: "overlay",
    params: [20],
    code: `// 唐奇安通道：N 日最高/最低/中轨，参数 P = [周期]
hi = hh(high, P[0]);
lo = ll(low, P[0]);
return { UP: hi, LOW: lo, MID: avg(hi, lo) };`,
  },
  {
    key: "vwap",
    label: "VWAP 量能加权价（主图）",
    kind: "overlay",
    params: [],
    code: `// 累计 VWAP：典型价×量的累积比值，无参数
tp = hlc3;
return { VWAP: cumsum(tp * volume) / cumsum(volume) };`,
  },
  {
    key: "atr-channel",
    label: "ATR 波动通道（主图）",
    kind: "overlay",
    params: [14, 2],
    code: `// 收盘价 ± k 倍 ATR，参数 P = [周期, 倍数]
pc1 = ref(close, 1);
tr = max(high - low, abs(pc1 - high), abs(pc1 - low));
atr = rma(nz(tr), P[0]);
return { MID: close, UP: close + P[1] * atr, LOW: close - P[1] * atr };`,
  },
  {
    key: "rsi",
    label: "RSI 相对强弱（副图）",
    kind: "pane",
    params: [14],
    code: `// Wilder RSI + 超买/超卖参考线，参数 P = [周期]
d = change(close);
gain = rma(nz(max(d, 0)), P[0]);
loss = rma(nz(max(0 - d, 0)), P[0]);
rsi = where(gain + loss == 0, 50, 100 * gain / (gain + loss));
return { RSI: rsi, 超买: 70, 超卖: 30 };`,
  },
  {
    key: "cross-signal",
    label: "均线金叉信号（副图）",
    kind: "pane",
    params: [5, 20],
    code: `// 快慢 EMA 的金叉(+1)/死叉(-1)，参数 P = [快, 慢]
fast = ema(close, P[0]);
slow = ema(close, P[1]);
return { 信号: cross(fast, slow) };`,
  },
  {
    key: "cci",
    label: "CCI 顺势指标（副图）",
    kind: "pane",
    params: [20],
    code: `// CCI = (典型价 - 均值) / (0.015 × 平均绝对偏差)，参数 P = [周期]
tp = hlc3;
return { CCI: (tp - ma(tp, P[0])) / (0.015 * dev(tp, P[0])) };`,
  },
  {
    key: "willr",
    label: "威廉 %R（副图）",
    kind: "pane",
    params: [14],
    code: `// 威廉 %R（0 ~ -100），参数 P = [周期]
hi = hh(high, P[0]);
lo = ll(low, P[0]);
return { WR: where(hi == lo, -50, -100 * (hi - close) / (hi - lo)) };`,
  },
  {
    key: "roc",
    label: "ROC 变动率 + 信号线（副图）",
    kind: "pane",
    params: [12, 6],
    code: `// 动量 ROC(%) 与其均线信号，参数 P = [动量周期, 信号周期]
r = roc(close, P[0]);
return { ROC: r, SIG: ma(nz(r), P[1]) };`,
  },
  {
    key: "ao",
    label: "AO 动量振荡器（副图）",
    kind: "pane",
    params: [5, 34],
    code: `// Awesome Oscillator：中价快均线 - 慢均线，参数 P = [快, 慢]
return { AO: ma(hl2, P[0]) - ma(hl2, P[1]) };`,
  },
  {
    key: "mfi",
    label: "MFI 资金流量指标（副图）",
    kind: "pane",
    params: [14],
    code: `// MFI：成交量加权的 RSI，参数 P = [周期]
tp = hlc3;
flow = tp * volume;
pos = where(tp > ref(tp, 1), flow, 0);
neg = where(tp < ref(tp, 1), flow, 0);
sp = sum(pos, P[0]);
sn = sum(neg, P[0]);
return { MFI: where(sn == 0, 100, 100 - 100 / (1 + sp / sn)) };`,
  },
];
