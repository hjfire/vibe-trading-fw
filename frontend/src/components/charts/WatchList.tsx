import { useCallback, useEffect, useRef, useState } from "react";
import { RefreshCw, Star, X } from "lucide-react";
import { fetchQuotes, type QuoteRow } from "@/lib/marketApi";

/** Persisted watchlist sidebar for the pro-chart page (local custom ⑧, step ②).
 *  Quotes come from GET /market/quote (daily last price + day-over-day change);
 *  rows refresh on mount, on list change, and via the manual button — no
 *  polling, to keep upstream data sources gentle. */

interface WatchListProps {
  symbols: string[];
  active: string;
  onPick: (symbol: string) => void;
  onChange: (symbols: string[]) => void;
}

const MAX_ROWS = 30;

export default function WatchList({ symbols, active, onPick, onChange }: WatchListProps) {
  const [quotes, setQuotes] = useState<Record<string, QuoteRow>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const seq = useRef(0);

  const refresh = useCallback(async () => {
    if (symbols.length === 0) {
      setQuotes({});
      return;
    }
    const id = ++seq.current;
    setLoading(true);
    setError(null);
    try {
      const rows = await fetchQuotes(symbols);
      if (id !== seq.current) return; // a newer refresh won the race
      const map: Record<string, QuoteRow> = {};
      rows.forEach((r) => {
        map[r.symbol] = r;
      });
      setQuotes(map);
    } catch (e) {
      if (id === seq.current) setError((e as Error).message);
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [symbols]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const add = () => {
    const v = draft.trim().toUpperCase();
    setDraft("");
    if (!v || symbols.includes(v) || symbols.length >= MAX_ROWS) return;
    onChange([...symbols, v]);
  };

  const remove = (symbol: string) => onChange(symbols.filter((s) => s !== symbol));

  return (
    <div className="flex h-full min-h-0 w-56 shrink-0 flex-col rounded-lg border bg-card">
      <div className="flex items-center justify-between gap-1 border-b px-2 py-1.5">
        <span className="flex items-center gap-1 text-[11px] font-semibold text-foreground">
          <Star size={12} className="text-primary" /> 自选
        </span>
        <button
          type="button"
          onClick={() => void refresh()}
          disabled={loading}
          title="刷新报价"
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {symbols.length === 0 && (
          <p className="p-3 text-[11px] leading-5 text-muted-foreground">
            列表为空 — 在下方输入代码，或点图表栏的 ★ 收藏当前标的。
          </p>
        )}
        {error && <p className="p-3 text-[11px] text-red-500">{error}</p>}
        {symbols.map((s) => {
          const q = quotes[s];
          const pct = q?.ok ? (q.change_pct ?? 0) : null;
          // A-share convention: red = up, green = down (mirrors the candles).
          const color =
            pct == null || pct === 0
              ? "text-muted-foreground"
              : pct > 0
                ? "text-red-500"
                : "text-green-600";
          return (
            <div
              key={s}
              className={`group flex cursor-pointer items-center gap-1 border-b px-2 py-1.5 text-xs last:border-b-0 hover:bg-muted ${
                s === active ? "bg-muted font-medium" : ""
              }`}
              onClick={() => onPick(s)}
              title={`${s}${q?.ok === false ? ` — ${q.error ?? "无数据"}` : ""}`}
            >
              <div className="min-w-0 flex-1">
                <div className="truncate font-mono text-[11px] text-foreground">{s}</div>
                <div className={`font-mono text-[10px] ${color}`}>
                  {q?.ok && q.last != null ? (
                    <>
                      {q.last.toFixed(q.last >= 100 ? 2 : q.last < 1 ? 4 : 2)}
                      {pct != null && (
                        <span className="ml-1">
                          {pct > 0 ? "+" : ""}
                          {pct.toFixed(2)}%
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-muted-foreground">{q ? (loading ? "…" : "—") : "…"}</span>
                  )}
                </div>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  remove(s);
                }}
                title="从自选移除"
                className="rounded p-0.5 text-muted-foreground opacity-0 hover:text-foreground group-hover:opacity-100"
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
      </div>

      <div className="flex items-center gap-1 border-t px-2 py-1.5">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
          placeholder="600519.SH / AAPL"
          spellCheck={false}
          className="h-6 min-w-0 flex-1 rounded border bg-background px-1.5 font-mono text-[11px] text-foreground outline-none focus:border-primary"
        />
        <button
          type="button"
          onClick={add}
          disabled={!draft.trim() || symbols.length >= MAX_ROWS}
          className="rounded border px-1.5 py-0.5 text-[11px] text-foreground hover:bg-muted disabled:opacity-40"
        >
          添加
        </button>
      </div>
    </div>
  );
}
