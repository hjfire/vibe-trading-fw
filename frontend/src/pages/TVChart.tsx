import { useEffect, useMemo, useRef, useState } from "react";
import { LineChart } from "lucide-react";
import i18n from "@/i18n";
import { useThemeDark } from "@/lib/theme-store";

/**
 * Phase-C trial page: embed TradingView's free Advanced Chart widget.
 * Purpose is ONLY to validate the "pro chart" interaction (drawing tools,
 * indicators, multi-timeframe) before we invest in the KLineChart build-out.
 * NOTE: the widget loads data from TradingView's public servers; anything
 * typed into it is visible to TradingView, and private/backtest data cannot
 * be displayed here.
 */

const INTERVALS = [
  { label: "1m", value: "1" },
  { label: "5m", value: "5" },
  { label: "15m", value: "15" },
  { label: "1h", value: "60" },
  { label: "1D", value: "D" },
  { label: "1W", value: "W" },
] as const;

const PRESETS = [
  { label: "贵州茅台", symbol: "600519.SH" },
  { label: "平安银行", symbol: "000001.SZ" },
  { label: "腾讯", symbol: "0700.HK" },
  { label: "AAPL", symbol: "AAPL.US" },
  { label: "BTC/USDT", symbol: "BTC-USDT" },
  { label: "EUR/USD", symbol: "EURUSD.FX" },
];

/** Map project-style symbols to TradingView symbols; pass through raw "X:Y" form. */
export function toTradingViewSymbol(code: string): string {
  const s = code.trim().toUpperCase();
  if (!s) return "SSE:600519";
  if (s.includes(":")) return s; // already a TV symbol, e.g. NASDAQ:AAPL
  if (s.endsWith(".SH")) return `SSE:${s.slice(0, -3)}`;
  if (s.endsWith(".SZ")) return `SZSE:${s.slice(0, -3)}`;
  if (s.endsWith(".HK")) return `HKEX:${s.slice(0, -3).padStart(5, "0")}`;
  if (s.endsWith(".US")) return `NASDAQ:${s.slice(0, -3)}`;
  if (s.endsWith(".FX")) return `FX:${s.slice(0, -3)}`;
  if (/^[A-Z]{6}$/.test(s)) return `FX:${s}`; // bare pair, e.g. EURUSD
  if (s.endsWith("-USDT")) return `BINANCE:${s.replace("-", "")}USDT`;
  if (s.endsWith("/USDT")) return `BINANCE:${s.replace("/", "")}USDT`;
  if (/^[A-Z]{3}\/[A-Z]{3}$/.test(s)) return `FX:${s.replace("/", "")}`;
  return s;
}

export function TVChart() {
  const [input, setInput] = useState("600519.SH");
  const [symbol, setSymbol] = useState("SSE:600519");
  const [interval, setInterval] = useState<string>("D");
  const hostRef = useRef<HTMLDivElement | null>(null);
  const dark = useThemeDark();
  const locale = (i18n.language || "en").startsWith("zh") ? "zh_CN" : "en";

  const applySymbol = (raw: string) => {
    setInput(raw);
    setSymbol(toTradingViewSymbol(raw));
  };

  const config = useMemo(
    () => ({
      autosize: true,
      symbol,
      interval,
      timezone: "Asia/Shanghai",
      theme: dark ? "dark" : "light",
      style: "1",
      locale,
      hide_top_toolbar: false,
      hide_legend: false,
      hide_side_toolbar: false, // drawing toolbar ON — this is what we are evaluating
      allow_symbol_change: true,
      save_image: false,
      calendar: false,
      support_host: "https://www.tradingview.com",
    }),
    [symbol, interval, dark, locale],
  );

  // Inject the official embed script; TradingView renders the widget inside .host.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    host.innerHTML = "";
    const container = document.createElement("div");
    container.className = "tradingview-widget-container";
    container.style.height = "100%";
    const inner = document.createElement("div");
    inner.className = "tradingview-widget-container__widget";
    inner.style.height = "100%";
    const script = document.createElement("script");
    script.src = "https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js";
    script.async = true;
    script.type = "text/javascript";
    script.innerHTML = JSON.stringify(config);
    container.appendChild(inner);
    container.appendChild(script);
    host.appendChild(container);
    return () => {
      host.innerHTML = "";
    };
  }, [config]);

  return (
    <div className="flex flex-col gap-3 p-4 h-[calc(100vh-0px)]">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 text-lg font-semibold">
          <LineChart className="h-5 w-5" />
          TradingView 图表试水 / Phase-C Trial
        </div>
        <input
          className="w-52 rounded-md border bg-background px-2 py-1 text-sm"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && applySymbol(input)}
          placeholder="600519.SH / AAPL.US / NASDAQ:AAPL"
        />
        <button
          className="rounded-md border px-3 py-1 text-sm hover:bg-accent"
          onClick={() => applySymbol(input)}
        >
          加载
        </button>
        <select
          className="rounded-md border bg-background px-2 py-1 text-sm"
          value={interval}
          onChange={(e) => setInterval(e.target.value)}
        >
          {INTERVALS.map((i) => (
            <option key={i.value} value={i.value}>
              {i.label}
            </option>
          ))}
        </select>
        <div className="flex flex-wrap gap-1">
          {PRESETS.map((p) => (
            <button
              key={p.symbol}
              className="rounded-md border px-2 py-1 text-xs hover:bg-accent"
              onClick={() => applySymbol(p.symbol)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
      <div className="text-xs text-muted-foreground">
        数据来自 TradingView 公开服务器（非本地数据源）；本页仅用于验证画线工具 / 指标 /
        多周期交互需求，确认后 Phase-A 将用开源 KLineChart 对接本项目自有数据链路。
      </div>
      <div ref={hostRef} className="min-h-0 flex-1 rounded-lg border" />
    </div>
  );
}
