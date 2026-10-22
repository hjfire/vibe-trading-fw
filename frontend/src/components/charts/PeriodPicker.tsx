import { useEffect, useRef, useState } from "react";

import type { AnyInterval, IntervalKey } from "@/lib/marketApi";
import { cn } from "@/lib/utils";

/** One row of the interval directory, fully decided by the page. */
export type PeriodOption = {
  key: IntervalKey;
  label: string;
  title: string;
  disabled: boolean;
};

export type PeriodPickerProps = {
  options: readonly PeriodOption[];
  /** The trigger's accessible name — the page passes the current option's label,
   *  so "the button names the selected row" holds at name level. */
  triggerLabel: string;
  /** Which row carries the selected state. `null` while 分时 is on: 分时 is a
   *  view, not a period, so no directory row is the current one. */
  active: AnyInterval | null;
  onPick: (key: IntervalKey) => void;
};

/**
 * TV-CI-03/02: the interval control is a popup entry, not an instant switch.
 * The trigger self-reports `hasPopup,menu` the way the other side's toolbar
 * button does, and the directory it opens marks the current interval with
 * `aria-selected` on a row whose name equals the trigger's.
 */
export function PeriodPicker({ options, triggerLabel, active, onPick }: PeriodPickerProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  return (
    <div className="relative" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? "pro-chart-period-menu" : undefined}
        title={
          active === null
            ? `周期目录：当前线上画的是分时，档位仍是 ${triggerLabel}（点开换档）`
            : `周期目录：当前 ${triggerLabel}（点开换档）`
        }
        className={cn(
          "rounded-md border px-2 py-1 text-xs hover:bg-muted",
          active !== null && "bg-muted font-medium",
        )}
      >
        {triggerLabel}
      </button>
      {open && (
        <div
          id="pro-chart-period-menu"
          role="listbox"
          aria-label="周期目录"
          className="absolute left-0 top-full z-50 mt-1 min-w-full rounded-md border bg-background py-1 shadow-lg"
        >
          {options.map((option) => (
            <button
              key={option.key}
              type="button"
              role="option"
              aria-selected={option.key === active}
              disabled={option.disabled}
              title={option.title}
              onClick={() => {
                setOpen(false);
                onPick(option.key);
              }}
              className={cn(
                "block whitespace-nowrap px-3 py-1 text-left text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40",
                option.key === active && "bg-muted font-medium",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
