/**
 * Built-in script library for the Pine compatibility layer (local custom ⑪).
 *
 * Modelled on the category layout of https://cn.tradingview.com/scripts/ —
 * 趋势 / 振荡 / 量能 / 波动率 / 策略 — but every entry is original Pine source
 * written against the functions this engine actually implements, so importing
 * one from the workbench is guaranteed to run instead of erroring out.
 *
 * Where our renderer cannot match TradingView exactly (VWAP anchoring, the
 * Ichimoku cloud offset, `fill()` shading) the entry's own `description` says
 * so; nothing here silently pretends to be the real thing.
 *
 * One house rule, enforced by the library test: strategies always mount on the
 * price chart, because their fill markers are priced off the bars.
 */

import type { ScriptCard } from "./scriptExchange";

export interface LibraryEntry extends ScriptCard {
  category: LibraryCategoryKey;
  /** One-line summary shown in the library list. */
  description: string;
}

export type LibraryCategoryKey = "trend" | "oscillator" | "volume" | "volatility" | "strategy";

export const LIBRARY_CATEGORIES: { key: LibraryCategoryKey; label: string; hint: string }[] = [
  { key: "trend", label: "趋势", hint: "均线、通道、转向" },
  { key: "oscillator", label: "振荡", hint: "强弱、动量、超买超卖" },
  { key: "volume", label: "量能", hint: "资金流与量的确认" },
  { key: "volatility", label: "波动率", hint: "布林、肯特纳、ATR" },
  { key: "strategy", label: "策略", hint: "可回测的 strategy 脚本" },
];

/* ------------------------------------------------------------------ 趋势 */

const TREND: LibraryEntry[] = [
  {
    id: "lib-ema-cross",
    dialect: "pine",
    category: "trend",
    name: "EMA 双均线交叉",
    display: "overlay",
    params: [],
    description: "快慢指数均线，金叉/死叉在K线上打点标记",
    code: `//@version=5
indicator("EMA 双均线交叉", "EMA×", overlay=true)
fastLen = input.int(9, "快线周期", minval=1, maxval=200)
slowLen = input.int(21, "慢线周期", minval=2, maxval=400)
fast = ta.ema(close, fastLen)
slow = ta.ema(close, slowLen)
plot(fast, "EMA快线", #2962ff)
plot(slow, "EMA慢线", #ff6d00)
plotshape(ta.crossover(fast, slow), "金叉", shape.triangleup, location.belowbar, #26a69a, "多")
plotshape(ta.crossunder(fast, slow), "死叉", shape.triangledown, location.abovebar, #ef5350, "空")`,
  },
  {
    id: "lib-macd",
    dialect: "pine",
    category: "trend",
    name: "MACD 动量聚散",
    display: "pane",
    params: [],
    description: "MACD 线、信号线与红绿柱，副图标准形态",
    code: `//@version=5
indicator("MACD 动量聚散", "MACD", overlay=false)
fastLen = input.int(12, "快线", minval=1, maxval=100)
slowLen = input.int(26, "慢线", minval=2, maxval=200)
sigLen = input.int(9, "信号", minval=1, maxval=100)
[macdLine, signalLine, histLine] = ta.macd(close, fastLen, slowLen, sigLen)
plot(macdLine, "MACD", #2962ff, 2)
plot(signalLine, "信号", #ff6d00, 2)
plot(histLine, "柱状", histLine >= 0 ? #26a69a : #ef5350, style=plot.style_histogram)
hline(0, "零轴", #787b86)`,
  },
  {
    id: "lib-supertrend",
    dialect: "pine",
    category: "trend",
    name: "SuperTrend 趋势轨道",
    display: "overlay",
    params: [],
    description: "ATR 通道转向线，转向当根打点；多空轨道分色",
    code: `//@version=5
indicator("SuperTrend 趋势轨道", "ST", overlay=true)
atrLen = input.int(10, "ATR 周期", minval=1, maxval=100)
factor = input.float(3, "通道倍数", minval=0.5, maxval=10, step=0.1)
[st, dir] = ta.supertrend(factor, atrLen)
flipUp = not na(dir[1]) and dir == -1 and dir[1] == 1
flipDn = not na(dir[1]) and dir == 1 and dir[1] == -1
plot(dir < 0 ? st : na, "多头轨道", #26a69a, 2)
plot(dir > 0 ? st : na, "空头轨道", #ef5350, 2)
plotshape(flipUp, "转多", shape.triangleup, location.belowbar, #26a69a, "多")
plotshape(flipDn, "转空", shape.triangledown, location.abovebar, #ef5350, "空")`,
  },
  {
    id: "lib-ichimoku",
    dialect: "pine",
    category: "trend",
    name: "一目均衡表",
    display: "overlay",
    params: [],
    description: "转换线/基准线/先行带；云图填充与前移未渲染，只画四线",
    code: `//@version=5
indicator("一目均衡表", "ICHIMOKU", overlay=true)
convLen = input.int(9, "转换线", minval=1, maxval=100)
baseLen = input.int(26, "基准线", minval=1, maxval=200)
spanBLen = input.int(52, "先行带B", minval=1, maxval=300)
conv = (ta.highest(high, convLen) + ta.lowest(low, convLen)) / 2
base = (ta.highest(high, baseLen) + ta.lowest(low, baseLen)) / 2
spanA = (conv + base) / 2
spanB = (ta.highest(high, spanBLen) + ta.lowest(low, spanBLen)) / 2
plot(conv, "转换线", #2962ff)
plot(base, "基准线", #ff6d00)
plot(spanA, "先行带A", #26a69a)
plot(spanB, "先行带B", #e91e63)`,
  },
  {
    id: "lib-hma",
    dialect: "pine",
    category: "trend",
    name: "Hull 均线 HMA",
    display: "overlay",
    params: [],
    description: "赫尔移动平均，转向处标三角；比同周期 SMA 跟价更紧",
    code: `//@version=5
indicator("Hull 均线", "HMA", overlay=true)
len = input.int(21, "周期", minval=2, maxval=200)
hma = ta.hma(close, len)
plot(hma, "HMA", #2962ff, 2)
plotshape(hma > hma[1] and hma[1] <= hma[2], "上拐", shape.triangleup, location.belowbar, #26a69a, "")
plotshape(hma < hma[1] and hma[1] >= hma[2], "下拐", shape.triangledown, location.abovebar, #ef5350, "")`,
  },
  {
    id: "lib-adx",
    dialect: "pine",
    category: "trend",
    name: "DMI / ADX 趋势强度",
    display: "pane",
    params: [],
    description: "+DI、-DI 与 ADX；ADX 高于阈值代表趋势成立",
    code: `//@version=5
indicator("DMI / ADX", "DMI", overlay=false)
diLen = input.int(14, "DI 周期", minval=2, maxval=100)
adxLen = input.int(14, "ADX 周期", minval=2, maxval=100)
threshold = input.int(25, "趋势阈值", minval=10, maxval=60)
[diPlus, diMinus, adx] = ta.dmi(diLen, adxLen)
plot(diPlus, "+DI", #26a69a)
plot(diMinus, "-DI", #ef5350)
plot(adx, "ADX", #2962ff, 2)
hline(25, "阈值", #787b86)`,
  },
  {
    id: "lib-vwap",
    dialect: "pine",
    category: "trend",
    name: "累计 VWAP",
    display: "overlay",
    params: [],
    description: "成交量加权均价及其 ±1σ 带；按整段区间累计（TV 为逐日锚定）",
    code: `//@version=5
indicator("累计 VWAP", "VWAP", overlay=true)
showBand = input.bool(true, "显示标准差带")
mult = input.float(1, "带宽倍数", minval=0.1, maxval=4, step=0.1)
v = ta.vwap(hlc3)
dev = ta.stdev(close, 20)
plot(v, "VWAP", #ab47bc, 2)
plot(showBand ? v + mult * dev : na, "上带", #787b86)
plot(showBand ? v - mult * dev : na, "下带", #787b86)`,
  },
];

/* ------------------------------------------------------------------ 振荡 */

const OSC: LibraryEntry[] = [
  {
    id: "lib-rsi",
    dialect: "pine",
    category: "oscillator",
    name: "RSI 相对强弱",
    display: "pane",
    params: [],
    description: "Wilder RSI，可换计算源；70/50/30 三条参考线",
    code: `//@version=5
indicator("RSI 相对强弱", "RSI", overlay=false)
src = input.source(close, "来源")
len = input.int(14, "周期", minval=2, maxval=100)
showMid = input.bool(true, "显示中轴")
r = ta.rsi(src, len)
plot(r, "RSI", #2962ff, 2)
plot(showMid ? 50 : na, "中轴", #787b86)
hline(70, "超买", #ef5350)
hline(30, "超卖", #26a69a)`,
  },
  {
    id: "lib-stoch",
    dialect: "pine",
    category: "oscillator",
    name: "随机指标 KD",
    display: "pane",
    params: [],
    description: "%K 与 %D 慢速线，80/20 超买超卖区",
    code: `//@version=5
indicator("随机指标 KD", "KD", overlay=false)
kLen = input.int(14, "%K 周期", minval=2, maxval=100)
smooth = input.int(3, "平滑", minval=1, maxval=20)
dLen = input.int(3, "%D 周期", minval=1, maxval=20)
[k, d] = ta.stoch(close, kLen, smooth)
plot(k, "%K", #2962ff)
plot(d, "%D", #ff6d00)
hline(80, "超买", #ef5350)
hline(20, "超卖", #26a69a)`,
  },
  {
    id: "lib-cci",
    dialect: "pine",
    category: "oscillator",
    name: "CCI 顺势指标",
    display: "pane",
    params: [],
    description: "典型价偏离均值除以平均差，±100 为活跃边界",
    code: `//@version=5
indicator("CCI 顺势指标", "CCI", overlay=false)
src = input.source(hlc3, "来源")
len = input.int(20, "周期", minval=2, maxval=100)
plot(ta.cci(src, len), "CCI", #2962ff, 2)
hline(100, "上界", #ef5350)
hline(0, "中轴", #787b86)
hline(-100, "下界", #26a69a)`,
  },
  {
    id: "lib-wpr",
    dialect: "pine",
    category: "oscillator",
    name: "威廉 %R",
    display: "pane",
    params: [],
    description: "收盘价在 N 日区间的相对位置，0 ~ -100",
    code: `//@version=5
indicator("威廉 %R", "%R", overlay=false)
len = input.int(14, "周期", minval=2, maxval=100)
plot(ta.wpr(len), "%R", #2962ff, 2)
hline(-20, "超买", #ef5350)
hline(-80, "超卖", #26a69a)`,
  },
  {
    id: "lib-mfi",
    dialect: "pine",
    category: "oscillator",
    name: "MFI 资金流量",
    display: "pane",
    params: [],
    description: "成交量加权的 RSI，衡量资金进出强度",
    code: `//@version=5
indicator("MFI 资金流量", "MFI", overlay=false)
len = input.int(14, "周期", minval=2, maxval=100)
plot(ta.mfi(hlc3, len), "MFI", #2962ff, 2)
hline(80, "过热", #ef5350)
hline(20, "冰点", #26a69a)`,
  },
  {
    id: "lib-ao-ac",
    dialect: "pine",
    category: "oscillator",
    name: "AO / AC 振荡（威廉）",
    display: "pane",
    params: [],
    description: "中价快慢均线差及其变化率，柱状显示",
    code: `//@version=5
indicator("AO / AC 振荡", "AOAC", overlay=false)
fastLen = input.int(5, "快线", minval=1, maxval=50)
slowLen = input.int(34, "慢线", minval=2, maxval=200)
ao = ta.ao(fastLen, slowLen)
ac = ta.ac(fastLen, slowLen)
plot(ao, "AO", ao >= 0 ? #26a69a : #ef5350, style=plot.style_columns)
plot(ac, "AC", #2962ff, 2)
hline(0, "零轴", #787b86)`,
  },
  {
    id: "lib-tsi",
    dialect: "pine",
    category: "oscillator",
    name: "TSI 真实强度指数",
    display: "pane",
    params: [],
    description: "去噪动量：变化量的双重 RMA 比值，配自定义信号线交叉",
    code: `//@version=5
indicator("TSI 真实强度", "TSI", overlay=false)
longLen = input.int(25, "长平滑", minval=5, maxval=100)
shortLen = input.int(13, "短平滑", minval=2, maxval=50)
sigLen = input.int(9, "信号周期", minval=1, maxval=50)
tsi = ta.tsi(close, longLen, shortLen)
sig = ta.ema(tsi, sigLen)
plot(tsi, "TSI", #2962ff, 2)
plot(sig, "信号", #ff6d00)
plotshape(ta.crossover(tsi, sig), "上穿", shape.circle, location.absolute, #26a69a, "")
plotshape(ta.crossunder(tsi, sig), "下穿", shape.circle, location.absolute, #ef5350, "")
hline(0, "零轴", #787b86)`,
  },
  {
    id: "lib-kst",
    dialect: "pine",
    category: "oscillator",
    name: "KST 确证趋势",
    display: "pane",
    params: [],
    description: "四段 ROC 加权的确证序列，配信号线与零轴",
    code: `//@version=5
indicator("KST 确证趋势", "KST", overlay=false)
sigLen = input.int(9, "信号周期", minval=1, maxval=50)
[kst, sig, hist] = ta.kst(close)
plot(kst, "KST", #2962ff, 2)
plot(sig, "信号", #ff6d00)
plot(hist, "柱", hist >= 0 ? #26a69a : #ef5350, style=plot.style_histogram)
hline(0, "零轴", #787b86)`,
  },
];

/* ------------------------------------------------------------------ 量能 */

const VOLUME: LibraryEntry[] = [
  {
    id: "lib-obv",
    dialect: "pine",
    category: "volume",
    name: "OBV 能量潮",
    display: "pane",
    params: [],
    description: "累计成交量及其均线：价升量增才确认",
    code: `//@version=5
indicator("OBV 能量潮", "OBV", overlay=false)
sigLen = input.int(20, "均线周期", minval=2, maxval=100)
obv = ta.obv(close, volume)
plot(obv, "OBV", #2962ff, 2)
plot(ta.ema(obv, sigLen), "信号", #ff6d00)`,
  },
  {
    id: "lib-cmf",
    dialect: "pine",
    category: "volume",
    name: "CMF 资金流",
    display: "pane",
    params: [],
    description: "Chaikin 资金流量，正数收在区间上半部",
    code: `//@version=5
indicator("CMF 资金流", "CMF", overlay=false)
len = input.int(20, "周期", minval=2, maxval=100)
plot(ta.cmf(len), "CMF", #2962ff, 2)
hline(0.25, "流入", #26a69a)
hline(0, "零轴", #787b86)
hline(-0.25, "流出", #ef5350)`,
  },
  {
    id: "lib-adi",
    dialect: "pine",
    category: "volume",
    name: "accumulation/distribution 振荡",
    display: "pane",
    params: [],
    description: "AD 线减去其均线，剔除量级只看相对强弱",
    code: `//@version=5
indicator("AD 振荡", "ADI", overlay=false)
len = input.int(20, "均线周期", minval=2, maxval=100)
plot(ta.adi() - ta.ema(ta.adi(), len), "ADI", #2962ff, 2)
hline(0, "零轴", #787b86)`,
  },
  {
    id: "lib-vr",
    dialect: "pine",
    category: "volume",
    name: "VR 量能比率",
    display: "pane",
    params: [],
    description: "上涨日成交量除以下跌日成交量，纯手写公式示例",
    code: `//@version=5
indicator("VR 量能比率", "VR", overlay=false)
len = input.int(26, "周期", minval=5, maxval=100)
upVol = close > close[1] ? volume : close < close[1] ? 0 : volume / 2
dnVol = close < close[1] ? volume : close > close[1] ? 0 : volume / 2
vd = math.sum(dnVol, len)
vr = vd == 0 ? 100 : 100 * math.sum(upVol, len) / vd
plot(vr, "VR", #2962ff, 2)
hline(160, "过热", #ef5350)
hline(70, "冰点", #26a69a)`,
  },
  {
    id: "lib-force",
    dialect: "pine",
    category: "volume",
    name: "Force Index 力度",
    display: "pane",
    params: [],
    description: "价变×量的平滑值，连接多空力量的力度",
    code: `//@version=5
indicator("Force Index 力度", "FI", overlay=false)
len = input.int(13, "平滑周期", minval=2, maxval=100)
plot(ta.force(close, len), "力度", #2962ff, 2)
hline(0, "零轴", #787b86)`,
  },
  {
    id: "lib-massi",
    dialect: "pine",
    category: "volume",
    name: "Mass Index 质量指标",
    display: "pane",
    params: [],
    description: "波幅翻倍反转：连续在 27 上方后回落到 26 下方视为反转信号",
    code: `//@version=5
indicator("Mass Index", "MASS", overlay=false)
n = input.int(9, "EMA 周期", minval=2, maxval=30)
sumN = input.int(25, "累计周期", minval=10, maxval=60)
m = ta.massi(n, sumN)
plot(m, "Mass Index", #2962ff, 2)
hline(27, "扩张", #ef5350)
hline(26, "回落", #26a69a)
plotshape(ta.crossunder(m, 26) and ta.highest(m, 5) > 27, "翻倍反转", shape.triangledown, location.absolute, #ef5350, "反")`,
  },
];

/* --------------------------------------------------------------- 波动率 */

const VOLATILITY: LibraryEntry[] = [
  {
    id: "lib-bb",
    dialect: "pine",
    category: "volatility",
    name: "布林带 BOLL",
    display: "overlay",
    params: [],
    description: "中轨 ± k 倍标准差；带间填充未渲染，只画三条边界",
    code: `//@version=5
indicator("布林带", "BOLL", overlay=true)
len = input.int(20, "周期", minval=2, maxval=200)
mult = input.float(2, "倍数", minval=0.5, maxval=6, step=0.1)
[basis, upper, lower] = ta.bb(close, len, mult)
plot(basis, "中轨", #2962ff)
plot(upper, "上轨", #ef5350)
plot(lower, "下轨", #26a69a)`,
  },
  {
    id: "lib-bbw",
    dialect: "pine",
    category: "volatility",
    name: "布林带宽与 %B",
    display: "pane",
    params: [],
    description: "带宽缩到近期低点＝挤压，常先于大幅波动",
    code: `//@version=5
indicator("布林带宽 / %B", "BBW", overlay=false)
len = input.int(20, "周期", minval=2, maxval=200)
mult = input.float(2, "倍数", minval=0.5, maxval=6, step=0.1)
[basis, upper, lower] = ta.bb(close, len, mult)
band = basis == 0 or upper - lower == 0 ? na : 100 * (upper - lower) / basis
pctb = upper - lower == 0 ? na : (close - lower) / (upper - lower)
squeeze = band < ta.lowest(band, 60)
plot(band, "带宽%", #2962ff, 2)
plot(4 * pctb, "%B×4", #ff6d00)
plotshape(squeeze, "挤压", shape.circle, location.belowbar, #e91e63, "挤")`,
  },
  {
    id: "lib-kc",
    dialect: "pine",
    category: "volatility",
    name: "肯特纳通道",
    display: "overlay",
    params: [],
    description: "EMA 中轨 ± k 倍 ATR；布林收进肯特纳＝低波动",
    code: `//@version=5
indicator("肯特纳通道", "KC", overlay=true)
len = input.int(20, "周期", minval=2, maxval=200)
mult = input.float(1.5, "ATR 倍数", minval=0.5, maxval=5, step=0.1)
[basis, upper, lower] = ta.kc(close, len, mult)
plot(basis, "中轨", #2962ff)
plot(upper, "上轨", #ef5350)
plot(lower, "下轨", #26a69a)`,
  },
  {
    id: "lib-atr",
    dialect: "pine",
    category: "volatility",
    name: "ATR 波动率",
    display: "pane",
    params: [],
    description: "真实波幅的 RMA，并给出占价格的百分比",
    code: `//@version=5
indicator("ATR 波动率", "ATR", overlay=false)
len = input.int(14, "周期", minval=1, maxval=100)
a = ta.atr(len)
plot(a, "ATR", #2962ff, 2)
plot(100 * a / close, "ATR%", #ff6d00)`,
  },
  {
    id: "lib-sar",
    dialect: "pine",
    category: "volatility",
    name: "抛物线 SAR",
    display: "overlay",
    params: [],
    description: "停损转向点，价格在 SAR 上方为多头持有区",
    code: `//@version=5
indicator("抛物线 SAR", "SAR", overlay=true)
start = input.float(0.02, "起始加速", minval=0.001, maxval=0.2, step=0.005)
inc = input.float(0.02, "increment", minval=0.001, maxval=0.2, step=0.005)
cap = input.float(0.2, "最大加速", minval=0.01, maxval=1, step=0.01)
sar = ta.sar(start, inc, cap)
plot(sar, "SAR", close > sar ? #26a69a : #ef5350, style=plot.style_circles)`,
  },
];

/* ------------------------------------------------------------------ 策略 */

const STRATEGIES: LibraryEntry[] = [
  {
    id: "lib-st-ma",
    dialect: "pine",
    category: "strategy",
    name: "双均线趋势策略",
    display: "overlay",
    params: [],
    description: "EMA 金叉进场、死叉离场；可选 200 日均线趋势过滤",
    code: `//@version=5
strategy("双均线趋势策略", "MA×", overlay=true, initial_capital=100000, default_qty_type=strategy.percent_of_equity, default_qty_value=95, commission_type=strategy.commission.percent, commission_value=0.05, pyramiding=1)
fastLen = input.int(9, "快线周期", minval=1, maxval=100)
slowLen = input.int(21, "慢线周期", minval=2, maxval=200)
useFilter = input.bool(true, "长期趋势过滤")
fast = ta.ema(close, fastLen)
slow = ta.ema(close, slowLen)
bullish = close > ta.ema(close, 200)
allowLong = not useFilter or bullish
plot(fast, "EMA快线", #2962ff)
plot(slow, "EMA慢线", #ff6d00)
if ta.crossover(fast, slow) and allowLong
    strategy.entry("多", strategy.long)
if ta.crossunder(fast, slow)
    strategy.close("多")`,
  },
  {
    id: "lib-st-donchian",
    dialect: "pine",
    category: "strategy",
    name: "唐奇安通道突破",
    display: "overlay",
    params: [],
    description: "海龟式：创新高进场，跌破离场周期出场",
    code: `//@version=5
strategy("唐奇安通道突破", "DONCHIAN", overlay=true, initial_capital=100000, default_qty_type=strategy.percent_of_equity, default_qty_value=90, pyramiding=1)
enterLen = input.int(20, "突破周期", minval=5, maxval=200)
exitLen = input.int(10, "离场周期", minval=2, maxval=100)
hiN = ta.highest(high, enterLen)
loN = ta.lowest(low, exitLen)
plot(hiN[1], "上轨", #26a69a)
plot(loN[1], "下轨", #ef5350)
if close > hiN[1]
    strategy.entry("多", strategy.long)
if close < loN[1]
    strategy.close("多")`,
  },
  {
    id: "lib-st-rsi",
    dialect: "pine",
    category: "strategy",
    name: "RSI 超卖反弹 + ATR 止损",
    display: "overlay",
    params: [],
    description: "固定手数低吸，持仓期叠加动态止损线与 60 日均线",
    code: `//@version=5
strategy("RSI 超卖反弹", "RSI-REV", overlay=true, initial_capital=100000, default_qty_type=strategy.fixed, default_qty_value=100, pyramiding=1)
len = input.int(14, "RSI 周期", minval=2, maxval=60)
buyLevel = input.int(30, "超卖买入", minval=5, maxval=45)
sellLevel = input.int(65, "反弹离场", minval=40, maxval=95)
atrLen = input.int(14, "ATR 周期", minval=1, maxval=60)
atrMult = input.float(2, "止损 ATR 倍数", minval=0.5, maxval=6, step=0.1)
r = ta.rsi(close, len)
stopLine = close - atrMult * ta.atr(atrLen)
plot(ta.sma(close, 60), "60日均线", #2962ff)
plot(strategy.position_size > 0 ? stopLine : na, "动态止损", #ef5350)
plotshape(r < buyLevel, "超卖进场", shape.circle, location.belowbar, #26a69a, "买")
if r < buyLevel
    strategy.entry("多", strategy.long)
if strategy.position_size > 0
    strategy.exit("止损", "多", stop=stopLine)
if r > sellLevel
    strategy.close("多")`,
  },
  {
    id: "lib-st-macd",
    dialect: "pine",
    category: "strategy",
    name: "MACD 零轴上方金叉",
    display: "overlay",
    params: [],
    description: "只吃趋势段：MACD 在零轴上方金叉进场，柱转负离场",
    code: `//@version=5
strategy("MACD 金叉策略", "MACD-S", overlay=true, initial_capital=100000, default_qty_type=strategy.percent_of_equity, default_qty_value=90, commission_type=strategy.commission.percent, commission_value=0.05, pyramiding=1)
fastLen = input.int(12, "快线", minval=1, maxval=100)
slowLen = input.int(26, "慢线", minval=2, maxval=200)
sigLen = input.int(9, "信号", minval=1, maxval=100)
needAboveZero = input.bool(true, "要求零轴上方")
[macdLine, signalLine, histLine] = ta.macd(close, fastLen, slowLen, sigLen)
gold = ta.crossover(macdLine, signalLine)
okEntry = macdLine >= 0
plot(ta.ema(close, slowLen), "慢线", #ff6d00)
plotshape(gold, "进场", shape.triangleup, location.belowbar, #26a69a, "多")
if gold and (not needAboveZero or okEntry)
    strategy.entry("多", strategy.long)
if histLine < 0 and histLine[1] >= 0
    strategy.close("多")`,
  },
  {
    id: "lib-st-supertrend",
    dialect: "pine",
    category: "strategy",
    name: "SuperTrend 多空反转",
    display: "overlay",
    params: [],
    description: "轨道转向即反手：多头与空头双向持仓，含手续费",
    code: `//@version=5
strategy("SuperTrend 多空反转", "ST-S", overlay=true, initial_capital=100000, default_qty_type=strategy.percent_of_equity, default_qty_value=90, commission_type=strategy.commission.percent, commission_value=0.05, pyramiding=1)
atrLen = input.int(10, "ATR 周期", minval=1, maxval=60)
factor = input.float(3, "通道倍数", minval=1, maxval=8, step=0.1)
[st, dir] = ta.supertrend(factor, atrLen)
flipUp = not na(dir[1]) and dir == -1 and dir[1] == 1
flipDn = not na(dir[1]) and dir == 1 and dir[1] == -1
plot(st, "SuperTrend", #2962ff, 2)
if flipUp
    strategy.entry("多", strategy.long)
    strategy.close("空")
if flipDn
    strategy.entry("空", strategy.short)
    strategy.close("多")`,
  },
  {
    id: "lib-st-bb",
    dialect: "pine",
    category: "strategy",
    name: "布林带均值回归",
    display: "overlay",
    params: [],
    description: "跌破下轨进场，回到中轨离场（震荡品种）",
    code: `//@version=5
strategy("布林带均值回归", "BB-REV", overlay=true, initial_capital=100000, default_qty_type=strategy.percent_of_equity, default_qty_value=50, commission_type=strategy.commission.percent, commission_value=0.03, pyramiding=1)
len = input.int(20, "周期", minval=5, maxval=200)
mult = input.float(2, "倍数", minval=1, maxval=5, step=0.1)
[basis, upper, lower] = ta.bb(close, len, mult)
plot(basis, "中轨", #2962ff)
plot(upper, "上轨", #ef5350)
plot(lower, "下轨", #26a69a)
if close < lower
    strategy.entry("多", strategy.long)
if strategy.position_size > 0 and close > basis
    strategy.close("多")`,
  },
];

/** The whole library, ordered by category. */
export const SCRIPT_LIBRARY: LibraryEntry[] = [...TREND, ...OSC, ...VOLUME, ...VOLATILITY, ...STRATEGIES];

export function libraryByCategory(category?: LibraryCategoryKey | ""): LibraryEntry[] {
  return category ? SCRIPT_LIBRARY.filter((e) => e.category === category) : SCRIPT_LIBRARY.slice();
}

export function findLibrary(id: string): LibraryEntry | undefined {
  return SCRIPT_LIBRARY.find((e) => e.id === id);
}

export function searchLibrary(query: string, category: LibraryCategoryKey | "" = ""): LibraryEntry[] {
  const q = query.trim().toLowerCase();
  const pool = libraryByCategory(category);
  if (!q) return pool;
  return pool.filter((e) =>
    [e.name, e.description, e.code.toLowerCase(), e.category].some((f) => f.toLowerCase().includes(q)),
  );
}

/** A fresh copy to add to the user's own list (new id, so nothing collides). */
export function libraryToCard(id: string): ScriptCard | null {
  const entry = findLibrary(id);
  if (!entry) return null;
  return { ...entry, id: `lib-${Date.now().toString(36)}-${entry.id}` };
}

export function categoryLabel(key: LibraryCategoryKey): string {
  return LIBRARY_CATEGORIES.find((c) => c.key === key)?.label ?? key;
}
