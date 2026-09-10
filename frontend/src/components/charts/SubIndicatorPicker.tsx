import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  BUILTIN_SUB_INDICATORS,
  MAX_SUB_PANES,
  subIndicatorLabel,
} from "@/lib/subIndicators";
import type { UserIndicator } from "@/lib/indicatorStore";

/**
 * Toolbar strip for the sub-chart indicator set (local custom ㉛).
 *
 * Three verbs, because that is what the request was: **看** which sub panes are
 * up, **加** one, and **换** one.
 *
 * 加 is a plain `createIndicator({ name, paneId: sub:<NAME> })` with `isStack`
 * left at its default `false` — passing `true` would stack the new formula into
 * the strip above it, which is the exact failure `syncPriceOverlay` documents
 * (one legend row per mounted copy, `MA(5,10,30,60)` walls).
 *
 * 换 closes one strip and opens the chosen one in a single click. It cannot put
 * the replacement in the *same* strip, and the reason is load-bearing rather
 * than lazy: `paneLayout.subPaneIdOf` derives a pane's address from the
 * indicator mounted on it — that is how ⑲ made a drawing survive a reload — so
 * mounting RSI onto `sub:MACD` would leave the drawing manifest naming an
 * indicator that is no longer there, and KLineChart 10.0.3 has no pane
 * reordering to correct it with. Closing a strip is already safe for its
 * drawings (`ChartImp.removeIndicator` destroys the pane at dist 15330-15347,
 * the overlay callbacks park what was on it, and `flushParked` puts it back when
 * a pane with that id returns), so the strip moving to the bottom is the whole
 * cost — and it is stated on the button rather than discovered later.
 */

interface SubIndicatorPickerProps {
  /** Which view the list being edited belongs to: 「分时」 or 「K线」. */
  viewName: string;
  /** Built-in sub indicators currently mounted, in pane order. */
  names: readonly string[];
  /** The workbench's saved formulas; `kind` says whether one is a sub chart. */
  scripts: readonly UserIndicator[];
  /** Feedback from the last attempt (「副图最多 N 个」and friends). */
  notice: string | null;
  onAdd: (name: string) => void;
  onReplace: (from: string, to: string) => void;
  onRemove: (name: string) => void;
  onToggleScript: (id: string) => void;
  onReset: () => void;
  /** Jump to the script workbench, which is the only place a formula is written. */
  onOpenWorkbench: () => void;
}

export default function SubIndicatorPicker({
  viewName,
  names,
  scripts,
  notice,
  onAdd,
  onReplace,
  onRemove,
  onToggleScript,
  onReset,
  onOpenWorkbench,
}: SubIndicatorPickerProps) {
  /** Which mounted name is being replaced; `null` means the grid appends. */
  const [target, setTarget] = useState<string | null>(null);

  const pick = (name: string) => {
    if (target) onReplace(target, name);
    else onAdd(name);
    setTarget(null);
  };

  const startReplace = (name: string) => setTarget((cur) => (cur === name ? null : name));

  return (
    <div className="shrink-0 rounded-lg border bg-background px-2 py-1.5 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">副图指标 · {viewName}</span>
        {target ? (
          <>
            <span className="rounded bg-primary/10 px-1.5 py-0.5 font-medium text-primary">
              替换「{subIndicatorLabel(target)}」为：
            </span>
            <button
              type="button"
              aria-label="取消替换"
              className="rounded-md border px-2 py-0.5 hover:bg-muted"
              onClick={() => setTarget(null)}
            >
              取消
            </button>
          </>
        ) : (
          <span className="text-muted-foreground">
            {names.length}/{MAX_SUB_PANES} 个副图 · 点面板上的「换」一步换掉这条
          </span>
        )}
        <button
          type="button"
          aria-label="恢复默认副图"
          title={`恢复「${viewName}」视图的默认副图组合`}
          className="ml-auto rounded-md border px-2 py-0.5 hover:bg-muted"
          onClick={() => {
            setTarget(null);
            onReset();
          }}
        >
          恢复默认
        </button>
      </div>

      {/* Mounted panes, in the order they sit on the chart. */}
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        {names.length === 0 && (
          <span className="text-muted-foreground">当前没有副图，只看主图 — 从下面挑一个</span>
        )}
        {names.map((name) => (
          <span
            key={name}
            className={cn(
              "flex items-center gap-1 rounded-md border px-1.5 py-0.5",
              target === name && "border-primary bg-primary/10 text-primary",
            )}
          >
            <span title={hintOf(name)}>{subIndicatorLabel(name)}</span>
            <button
              type="button"
              aria-label={`更换副图 ${name}`}
              title="关掉这条并在最后一条的位置改画另一个指标"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => startReplace(name)}
            >
              换
            </button>
            <button
              type="button"
              aria-label={`关闭副图 ${name}`}
              title="关闭这个副图；画在它上面的线会被暂存，重新开启即回到原面板"
              className="text-muted-foreground hover:text-red-500"
              onClick={() => {
                if (target === name) setTarget(null);
                onRemove(name);
              }}
            >
              ×
            </button>
          </span>
        ))}
      </div>

      {/* The catalogue. `target` decides whether a click appends or replaces. */}
      <div className="mt-1.5 flex flex-wrap gap-1">
        {BUILTIN_SUB_INDICATORS.map((preset) => {
          const mounted = names.includes(preset.name);
          const disabled = mounted || (!target && names.length >= MAX_SUB_PANES);
          return (
            <button
              key={preset.name}
              type="button"
              aria-label={`副图指标 ${preset.label}`}
              title={mounted ? "已在图上" : target ? `用「${preset.label}」替换` : preset.hint}
              disabled={disabled}
              className={cn(
                "rounded-md border px-2 py-0.5 hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40",
                mounted && "bg-muted font-medium",
              )}
              onClick={() => pick(preset.name)}
            >
              {preset.label}
            </button>
          );
        })}
      </div>

      {notice && <div className="mt-1 text-red-500">{notice}</div>}

      {/* Saved formulas mount on the chart through the workbench, so they are
          listed here as switches, not as editor affordances. */}
      {scripts.length > 0 && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1 border-t pt-1.5">
          <span className="text-muted-foreground">自定义脚本:</span>
          {scripts.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-label={`自定义脚本 ${item.label}`}
              title={
                item.kind === "overlay"
                  ? "这个脚本画在主图上"
                  : "开关这个脚本的副图；画在它上面的线会被暂存"
              }
              className={cn(
                "rounded-md border px-2 py-0.5 hover:bg-muted",
                item.enabled && "bg-muted font-medium",
              )}
              onClick={() => {
                setTarget(null);
                onToggleScript(item.id);
              }}
            >
              {item.label}
              {item.kind === "overlay" ? "（主图）" : ""}
              {item.enabled ? "" : " · 关"}
            </button>
          ))}
          <button
            type="button"
            aria-label="打开脚本工作台"
            title="编写、导入与管理公式"
            className="ml-auto rounded-md border px-2 py-0.5 hover:bg-muted"
            onClick={() => {
              setTarget(null);
              onOpenWorkbench();
            }}
          >
            ƒ 脚本工作台
          </button>
        </div>
      )}
    </div>
  );
}

/** The tooltip text for a mounted pane's label. */
function hintOf(name: string): string {
  return BUILTIN_SUB_INDICATORS.find((i) => i.name === name)?.hint ?? name;
}
