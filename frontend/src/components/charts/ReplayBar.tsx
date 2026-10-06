import { useState, type KeyboardEvent } from "react";

import { paceMs, type ReplayReadout, type ReplaySpeed } from "@/lib/barReplay";
import { cn } from "@/lib/utils";

/**
 * The replay toolbar row. Purely presentational on purpose: it never touches the chart
 * instance, so the readout wording is testable without a canvas and the page keeps the only
 * copy of the cursor state.
 *
 * Deliberately absent: a vertical cursor line drawn as an overlay. `serializeDrawings
 * (chart.getOverlays())` banks every overlay on the chart by no name filter
 * (ProChart.tsx:844), so a replay marker would be written into the user's drawing bucket,
 * survive exit, come back on reload, and travel in the `.json`/`?d=` export. The truncated
 * window already says where "now" is — the newest bar on screen *is* the cursor.
 */

export const SPEEDS: readonly ReplaySpeed[] = ["0.5", "1", "2", "4"];

const BTN = "rounded-md border px-2 py-1 text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40";

export interface ReplayBarProps {
  active: boolean;
  disabled: boolean;
  /** Why the entry button cannot be used; shown as its title when disabled. */
  reason: string | null;
  playing: boolean;
  speed: ReplaySpeed;
  readout: ReplayReadout | null;
  /** The cursor formatted as a date, or null before entry. */
  cursorLabel: string | null;
  onStart: (mode: "default" | "viewEdge") => void;
  onStop: () => void;
  onStep: (n: number) => void;
  onTogglePlay: () => void;
  onSpeed: (s: ReplaySpeed) => void;
  onPickDate: (iso: string) => void;
}

export function ReplayBar({
  active,
  disabled,
  reason,
  playing,
  speed,
  readout,
  cursorLabel,
  onStart,
  onStop,
  onStep,
  onTogglePlay,
  onSpeed,
  onPickDate,
}: ReplayBarProps) {
  const [date, setDate] = useState("");
  const sendDate = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key !== "Enter") return;
    if (date) onPickDate(date);
  };

  if (!active) {
    return (
      <div className="flex items-center gap-1.5">
        <button
          type="button"
          className={BTN}
          disabled={disabled}
          title={disabled ? (reason ?? "当前视图不能回放") : "把图表裁到历史某一刻，逐根向前推进"}
          onClick={() => onStart("default")}
        >
          回放
        </button>
        <button
          type="button"
          className={BTN}
          disabled={disabled}
          title={disabled ? (reason ?? "当前视图不能回放") : "从当前视图最右那根开始回放"}
          onClick={() => onStart("viewEdge")}
        >
          从视图右端开始
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <button type="button" className={BTN} onClick={() => onStep(-10)} title="向左 10 根">
        快退 10 根
      </button>
      <button type="button" className={BTN} onClick={() => onStep(-1)} title="向左一根">
        前一根
      </button>
      <button type="button" className={BTN} onClick={onTogglePlay} disabled={!!readout && readout.remaining === 0}>
        {playing ? "暂停" : "播放"}
      </button>
      <button type="button" className={BTN} onClick={() => onStep(1)} title="向右一根">
        后一根
      </button>
      <button type="button" className={BTN} onClick={() => onStep(10)} title="向右 10 根">
        快进 10 根
      </button>
      {SPEEDS.map((s) => (
        <button
          type="button"
          key={s}
          className={cn(BTN, s === speed && "bg-muted font-medium")}
          onClick={() => onSpeed(s)}
          title={`${s}× ＝ 每根 ${paceMs(s)} ms`}
        >
          {s}×
        </button>
      ))}
      <label className="ml-1 text-xs text-muted-foreground" htmlFor="replay-start-date">
        起点
      </label>
      <input
        id="replay-start-date"
        aria-label="回放起点日期"
        type="date"
        className="rounded-md border bg-transparent px-2 py-1 text-xs"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        onKeyDown={sendDate}
      />
      <span className="text-xs text-muted-foreground">
        回放中{cursorLabel ? ` ${cursorLabel}` : ""}
        {readout ? ` · 第 ${readout.shown}/${readout.total} 根 · 剩 ${readout.remaining} 根` : ""}
      </span>
      <button type="button" className={BTN} onClick={onStop} title="交回完整已加载区间，恢复正常分页">
        退出回放
      </button>
    </div>
  );
}
