import { useEffect, useRef, useState } from "react";

import type { AnyInterval } from "@/lib/marketApi";
import { cn } from "@/lib/utils";

/** One row of the interval directory, fully decided by the page. */
export type PeriodOption = {
  key: AnyInterval;
  label: string;
  title: string;
  disabled: boolean;
  /** 自定义档才有；内置行没有移除按钮。 */
  onRemove?: () => void;
  custom?: boolean;
};

export type PeriodPickerProps = {
  options: readonly PeriodOption[];
  /** The trigger's accessible name — the page passes the current option's label,
   *  so "the button names the selected row" holds at name level. */
  triggerLabel: string;
  /** Which row carries the selected state. `null` while 分时 is on: 分时 is a
   *  view, not a period, so no directory row is the current one. */
  active: AnyInterval | null;
  onPick: (key: AnyInterval) => void;
  /** 给了才在目录末尾铺出「添加自定义周期…」那枚入口行；不需要入口的宿主就不传。 */
  onAddCustom?: () => void;
};

/**
 * TV-CI-03/02: the interval control is a popup entry, not an instant switch.
 * The trigger self-reports `hasPopup,menu` the way the other side's toolbar
 * button does, and the directory it opens marks the current interval with
 * `aria-selected` on a row whose name equals the trigger's.
 */
export function PeriodPicker({
  options,
  triggerLabel,
  active,
  onPick,
  onAddCustom,
}: PeriodPickerProps) {
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
        <div className="absolute left-0 top-full z-50 mt-1 min-w-full rounded-md border bg-background py-1 shadow-lg">
          {/* 外层这一枚面板 div 只承接定位与外观三件；`id`／`role`／`aria-label` 仍住在下面
              那枚 listbox div 上——既存针断的是入口的 `aria-controls` 逐字等于 listbox 的 `id`，
              且 `document.getElementById(id)` 取回的就是那枚 listbox。 */}
          <div
            id="pro-chart-period-menu"
            role="listbox"
            aria-label="周期目录"
          >
            {options.map((option) => (
              <div key={option.key} role="none" className="flex items-center">
                {/* 行容器夹在 listbox 与 option 之间，按 ARIA 不是 listbox 的合法被拥有元素，
                    所以写 `role="none"`，让 option 在无障碍树里仍直接归 listbox 所有。 */}
                <button
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
                    "block grow whitespace-nowrap px-3 py-1 text-left text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40",
                    option.key === active && "bg-muted font-medium",
                  )}
                >
                  {option.label}
                </button>
                {/* 移除按钮与选档按钮并排、不嵌进 option：button 里不能再放一枚 button，且既存针
                    断的是 option 的 textContent 逐字等于档位名。它自带 `button` 角色、留在
                    `role="listbox"` 之下是本仓**自家的裁定，不是对面证据**——它没有别的合法位置。
                    两处 stopPropagation 已按第 4 轮预检撤回：兄弟之间不冒泡，而 `document` 上那枚
                    外点监听只看 `wrapRef.contains(target)`，移除按钮就住在 `wrapRef` 里 ⇒ 按移除
                    不选中那档，交给「按移除不会选中那一档」那枚针钉，不靠不可达的守卫。 */}
                {option.custom && (
                  <button
                    type="button"
                    aria-label={`移除 ${option.label}`}
                    title="从周期目录里移除这一档"
                    onClick={() => option.onRemove?.()}
                    className="px-2 py-1 text-xs text-muted-foreground hover:bg-muted"
                  >
                    移除
                  </button>
                )}
              </div>
            ))}
          </div>
          {/* 裁定两则：入口行不是 option，是一枚普通 `button`（`getAllByRole("option")` 的计数因此不因它漂）。
              且入口是「换一层浮层」：关目录、焦点压回入口、再交出去——移除那枚按钮相反，是就地改清单，不关任何东西。 */}
          {onAddCustom && (
            <button
              type="button"
              onClick={() => { setOpen(false); triggerRef.current?.focus(); onAddCustom(); }}
              className="block w-full whitespace-nowrap px-3 py-1 text-left text-xs hover:bg-muted"
            >
              添加自定义周期…
            </button>
          )}
        </div>
      )}
    </div>
  );
}
