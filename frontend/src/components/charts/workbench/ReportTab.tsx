import { useEffect, useMemo, useState } from "react";
import { detectDialect, getPineArtifact, subscribePineArtifact } from "@/lib/indicatorLang";
import { isPineStrategy } from "@/lib/pineScript";
import type { PineArtifact } from "@/lib/pineScript";
import type { PineReport } from "@/lib/pineTypes";
import type { UserIndicator } from "@/lib/indicatorStore";

/**
 * Strategy report panel (local custom ⑪).
 *
 * A Pine `strategy()` runs inside the chart's indicator calc, so the numbers
 * only reach the UI through the artifact side channel in indicatorLang.
 * Colours follow the A-share convention used by the chart itself: red is a
 * gain, green is a loss.
 */

interface ReportTabProps {
  items: UserIndicator[];
  /** Re-run a script against the current bars; returns an error string or null. */
  onRerun: (item: UserIndicator) => string | null;
}

const money = (v: number): string =>
  `${v < 0 ? "-" : ""}${Math.abs(v).toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (v: number): string => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
const gainClass = (v: number): string => (v > 0 ? "text-red-500" : v < 0 ? "text-emerald-500" : "");

/**
 * Only scripts that can produce a report belong to this panel. `indicator()`
 * sources are Pine too but never trade, so listing them here would offer a
 * chip that keeps showing the previous strategy's numbers.
 */
function trades(item: UserIndicator): boolean {
  if (detectDialect(item.code) !== "pine") return false;
  const seen = getPineArtifact(item.id);
  return seen ? seen.result.scriptKind === "strategy" : isPineStrategy(item.code);
}

export default function ReportTab({ items, onRerun }: ReportTabProps) {
  const strategies = useMemo(() => items.filter((it) => it.enabled && trades(it)), [items]);
  const withReport = strategies.filter((it) => getPineArtifact(it.id)?.result.report);
  const [selected, setSelected] = useState<string>("");
  const [artifact, setArtifact] = useState<PineArtifact | null>(null);

  const active = selected || withReport[0]?.id || strategies[0]?.id || "";

  useEffect(() => {
    if (!active) {
      setArtifact(null);
      return;
    }
    setArtifact(getPineArtifact(active) ?? null);
    return subscribePineArtifact(active, (next) => setArtifact(next));
  }, [active]);

  if (!strategies.length) {
    // Distinguish "nothing Pine is mounted" from "only drawing scripts are":
    // the second one needs a different action from the user.
    const pineOnly = items.some((it) => it.enabled && detectDialect(it.code) === "pine");
    return (
      <p className="text-xs leading-5 text-muted-foreground">
        {pineOnly
          ? "当前挂载的 Pine 脚本都是 indicator()：只画图，不下单，所以没有回测报告。到「脚本库」选一个 strategy 策略，或粘贴含 strategy.entry() 的 TradingView 策略源码。"
          : "图表上还没有 Pine 脚本。到「脚本库」里选一个 strategy 策略应用，或把 TradingView 的策略源码粘贴进「导入」，回测结果会显示在这里。"}
      </p>
    );
  }

  const rep = artifact?.result.report;

  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-[11px] text-muted-foreground">策略：</span>
        {strategies.map((it) => (
          <button
            key={it.id}
            type="button"
            onClick={() => {
              setSelected(it.id);
            }}
            className={
              it.id === active
                ? "rounded border border-primary bg-primary/10 px-2 py-0.5 text-[11px] font-semibold"
                : "rounded border px-2 py-0.5 text-[11px] hover:bg-muted"
            }
          >
            {it.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => {
            const item = strategies.find((x) => x.id === active);
            if (item) onRerun(item);
          }}
          className="ml-auto rounded border px-2 py-0.5 text-[11px] hover:bg-muted"
        >
          重新回测
        </button>
      </div>

      {!rep && (
        <p className="text-xs leading-5 text-muted-foreground">
          这个策略还没有在当前图表上算过（可能刚切换标的或周期），点「重新回测」。
        </p>
      )}

      {rep && <ReportBody rep={rep} warnings={artifact?.result.warnings ?? []} />}
    </div>
  );
}

function ReportBody({ rep, warnings }: { rep: PineReport; warnings: string[] }) {
  const cells: { label: string; value: string; tone?: number; hint?: string }[] = [
    { label: "净收益", value: money(rep.netPnl), tone: rep.netPnl, hint: "已平仓部分合计" },
    { label: "总收益率", value: pct(rep.returnPct), tone: rep.returnPct, hint: "含浮盈，相对初始资金" },
    { label: "浮动盈亏", value: money(rep.unrealizedPnl), tone: rep.unrealizedPnl, hint: "未平仓部分的市值差" },
    { label: "最大回撤", value: `${rep.maxDrawdownPct.toFixed(2)}%`, tone: -rep.maxDrawdownPct, hint: "权益曲线峰谷比" },
    { label: "交易次数", value: String(rep.closedCount), hint: `未平仓 ${rep.openEntries} 笔` },
    { label: "胜率", value: `${rep.winRatePct.toFixed(2)}%`, hint: `${rep.winCount} 胜 / ${rep.closedCount - rep.winCount} 负` },
    { label: "盈亏比", value: rep.profitFactor === Infinity ? "∞" : rep.profitFactor.toFixed(2), hint: "总盈利 / 总亏损" },
    { label: "平均盈亏", value: `${money(rep.avgWin)} / ${money(rep.avgLoss)}`, hint: "平均盈利 / 平均亏损" },
    { label: "买入持有", value: pct(rep.buyHoldPct), tone: rep.buyHoldPct, hint: "同期持有的收益" },
    { label: "当前持仓", value: rep.openSide === "flat" ? "空仓" : rep.openSide === "long" ? "多头" : "空头", hint: `${rep.defaultQtyType === "fixed" ? "固定手数" : "权益比例"} ${rep.defaultQtyValue}` },
  ];

  return (
    <>
      <div className="grid grid-cols-2 gap-1.5">
        {cells.map((c) => (
          <div key={c.label} className="rounded border px-2 py-1.5" title={c.hint}>
            <div className="text-[10px] text-muted-foreground">{c.label}</div>
            <div className={c.tone === undefined ? "font-mono text-xs font-semibold" : `font-mono text-xs font-semibold ${gainClass(c.tone)}`}>
              {c.value}
            </div>
          </div>
        ))}
      </div>

      <div className="rounded border p-2">
        <div className="mb-1 flex items-center justify-between text-[10px] text-muted-foreground">
          <span>权益曲线（{rep.equity.length} 根K线）</span>
          <span>初始 {money(rep.initialCapital)}</span>
        </div>
        <Spark values={rep.equity} baseline={rep.initialCapital} />
      </div>

      {rep.trades.length > 0 && (
        <div className="overflow-hidden rounded border">
          <table className="w-full text-[11px]">
            <thead className="bg-muted/50 text-muted-foreground">
              <tr>
                <th className="px-1.5 py-1 text-left font-normal">方向</th>
                <th className="px-1.5 py-1 text-right font-normal">开仓价</th>
                <th className="px-1.5 py-1 text-right font-normal">平仓价</th>
                <th className="px-1.5 py-1 text-right font-normal">盈亏</th>
                <th className="px-1.5 py-1 text-right font-normal">收益率</th>
                <th className="px-1.5 py-1 text-left font-normal">离场</th>
              </tr>
            </thead>
            <tbody>
              {rep.trades.slice(-12).reverse().map((t, i) => (
                <tr key={`${t.entryBar}-${i}`} className="border-t">
                  <td className="px-1.5 py-1">{t.side === "long" ? "多" : "空"}</td>
                  <td className="px-1.5 py-1 text-right font-mono">{t.entryPrice.toFixed(2)}</td>
                  <td className="px-1.5 py-1 text-right font-mono">{t.exitPrice.toFixed(2)}</td>
                  <td className={`px-1.5 py-1 text-right font-mono ${gainClass(t.pnl)}`}>{money(t.pnl)}</td>
                  <td className={`px-1.5 py-1 text-right font-mono ${gainClass(t.retPct)}`}>{pct(t.retPct)}</td>
                  <td className="px-1.5 py-1 text-muted-foreground">{reasonLabel(t.reason)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {rep.trades.length > 12 && (
            <p className="border-t px-1.5 py-1 text-[10px] text-muted-foreground">仅显示最近 12 笔，共 {rep.trades.length} 笔</p>
          )}
        </div>
      )}

      {warnings.length > 0 && (
        <details className="rounded border p-2 text-[11px]">
          <summary className="cursor-pointer text-muted-foreground">运行时说明（{warnings.length}）</summary>
          <ul className="mt-1 space-y-0.5 leading-4 text-muted-foreground">
            {warnings.map((w) => (
              <li key={w}>{w}</li>
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function reasonLabel(reason: string): string {
  return reason === "signal" ? "信号" : reason === "stop" ? "止损" : reason === "limit" ? "止盈" : reason === "end" ? "结束" : reason;
}

/** Tiny inline equity curve — a polyline is enough next to a full chart. */
function Spark({ values, baseline }: { values: number[]; baseline: number }) {
  const W = 260;
  const H = 60;
  const pts = useMemo(() => {
    const nums = values.filter((v) => Number.isFinite(v));
    if (nums.length < 2) return null;
    const lo = Math.min(...nums, baseline);
    const hi = Math.max(...nums, baseline);
    const span = hi - lo || 1;
    const step = W / (values.length - 1);
    let x = 0;
    const path: string[] = [];
    for (const v of values) {
      if (Number.isFinite(v)) path.push(`${x.toFixed(1)},${(H - ((v - lo) / span) * H).toFixed(1)}`);
      x += step;
    }
    const zeroY = H - ((baseline - lo) / span) * H;
    return { d: path.join(" "), zeroY, up: nums[nums.length - 1] >= baseline };
  }, [values, baseline]);

  if (!pts) return <p className="text-[11px] text-muted-foreground">权益数据不足，无法绘制曲线</p>;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="h-16 w-full" preserveAspectRatio="none" role="img" aria-label="权益曲线">
      <line x1={0} y1={pts.zeroY} x2={W} y2={pts.zeroY} stroke="currentColor" strokeOpacity={0.3} strokeDasharray="3 3" />
      <polyline
        points={pts.d}
        fill="none"
        stroke={pts.up ? "#ef5350" : "#26a69a"}
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
