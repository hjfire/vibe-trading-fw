import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";

import { CUSTOM_UNITS, specLabel, validateDraft } from "@/lib/customInterval";
import type { IntervalUnit } from "@/lib/customInterval";
import { cn } from "@/lib/utils";

export type CustomIntervalDialogProps = {
  /** 目录里已有的串（内置八档 ∪ 已添加的自定义档），用来判「这一档已在目录里」。 */
  existing: readonly string[];
  onCancel: () => void;
  onAdd: (spec: string) => void;
};

/**
 * 数值框 `max` 的**提示值**，按单位给一份。它不是判据——判据只有 `validateDraft`
 * 那一处（跨度尺住在 `customInterval.ts` 的 `durationOk`，那三枚数没有对外端出来，
 * 组件拿不到），这里只是让输入框的上下箭头不往明显越界的方向走。
 *
 * 抄了就有可能漂，所以针面把它钉在可观察的 DOM 属性上逐单位复算两侧
 * （`max` 界内、`max + 1` 越界，见本文件的测试）：尺一动而这里没跟上，那枚针先红。
 */
const INPUT_MAX: Record<IntervalUnit, number> = {
  minute: 999,
  hour: 24,
  day: 366,
  week: 366,
  month: 366,
};

/** 「这一档已在目录里」的两种来源各给一句：内置档那句由 `validateDraft` 给（它就是
 *  唯一持有内置表的地方），已添加的自定义档那句只能由对话框给——`existing` 是目录的
 *  现状，不是文法模块的知识。两句都说「已经有了」，用户看到的结论一致。 */
const DUPLICATE_CUSTOM_REASON = "这一档目录里已经有了（它是已添加的自定义档）";

const UNIT_LISTBOX_ID = "custom-interval-unit-listbox";
const NUMBER_INPUT_ID = "custom-interval-number";

/**
 * 添加自定义周期的对话框：单位（五档弹层）＋ 数值 ⇒ 一条 market 拼写。
 *
 * 结构照 L1 里 TV-CI-09 那七把骨架尺（dialog／关闭／单位标签＋弹层按钮／数值标签＋
 * 输入框／取消／加入），名字全是自家文案；`aria-modal` 与焦点陷阱**故意不做**——取证
 * 那侧没有任何读数证明对面锁了焦点，不发明凭据里没有的行为。单位按钮的可达名只念
 * 一次单位标签（对面那枚展开态把标签念了两遍，那是可达性反模式，不复刻）。
 *
 * 签名不带返回类型标注（与 `PeriodPicker.tsx` 同形，靠 TS 推断）：简报给的
 * `JSX.Element | null` 在本仓的 `@types/react` 19 下认不下全局 `JSX` 命名空间，
 * `tsc -b` 报 `error TS2503: Cannot find namespace 'JSX'`；而且这枚对话框没有
 * 「渲染 null」那一态——开合由调用方挂载决定，所以 `| null` 也没有对象可返回。
 */
export function CustomIntervalDialog({ existing, onCancel, onAdd }: CustomIntervalDialogProps) {
  // 状态存的是弹层里那一行本身，所以按钮上的标签与传给 `validateDraft` 的单位出自同一次
  // 选择，中间没有「按 unit 反查标签」那一步可以漂。
  const [selected, setSelected] = useState(CUSTOM_UNITS[0]);
  const [n, setN] = useState<number | null>(null);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Escape 与外点关闭照周期目录那两处写；差别只有一处：这里两个回调都是 `onCancel`，
  // 因为对话框没有「选中」这一步之外的状态可留。`preventDefault` 归本组件，
  // 焦点归还入口行归**调用方**（它才知道入口是谁）。
  useEffect(() => {
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCancel();
    };
    const handleMouseDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) onCancel();
    };
    document.addEventListener("keydown", handleEscape);
    document.addEventListener("mousedown", handleMouseDown);
    return () => {
      document.removeEventListener("keydown", handleEscape);
      document.removeEventListener("mousedown", handleMouseDown);
    };
  }, [onCancel]);

  // 结论按渲染算，不在 effect 里缓存：单位与数值任一改动都立刻反映到 disabled 与原因上。
  const verdict = validateDraft({ unit: selected.unit, n });
  const duplicate = verdict.ok && existing.includes(verdict.spec);
  const blocked = !verdict.ok || duplicate;
  const reason = !verdict.ok ? verdict.reason : duplicate ? DUPLICATE_CUSTOM_REASON : "";
  const preview = verdict.ok ? specLabel(verdict.spec) : null;

  return (
    <div
      ref={wrapRef}
      role="dialog"
      aria-label="添加自定义周期"
      className="w-64 rounded-md border bg-background p-3 text-sm shadow-lg"
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="font-medium">添加自定义周期</span>
        <button
          type="button"
          aria-label="关闭"
          onClick={onCancel}
          className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <X size={14} />
        </button>
      </div>

      <div className="mb-2 flex items-center gap-2">
        <span className="text-muted-foreground">单位</span>
        <button
          type="button"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={open ? UNIT_LISTBOX_ID : undefined}
          onClick={() => setOpen((previous) => !previous)}
          className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
        >
          {selected.label}
        </button>
        {open && (
          <ul
            id={UNIT_LISTBOX_ID}
            role="listbox"
            aria-label="单位"
            className="rounded-md border bg-background py-1"
          >
            {CUSTOM_UNITS.map((option) => (
              <li
                key={option.unit}
                role="option"
                aria-selected={option.unit === selected.unit}
                onClick={() => {
                  setSelected(option);
                  setOpen(false);
                }}
                className={cn(
                  "cursor-pointer px-3 py-1 text-xs hover:bg-muted",
                  option.unit === selected.unit && "bg-muted font-medium",
                )}
              >
                {option.label}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="mb-2 flex items-center gap-2">
        <label htmlFor={NUMBER_INPUT_ID} className="text-muted-foreground">
          数值
        </label>
        <input
          id={NUMBER_INPUT_ID}
          type="number"
          min={1}
          max={INPUT_MAX[selected.unit]}
          step={1}
          value={n === null ? "" : String(n)}
          onChange={(event) => {
            const raw = event.target.value;
            if (raw === "") {
              setN(null);
              return;
            }
            const parsed = Number(raw);
            setN(Number.isFinite(parsed) ? parsed : null);
          }}
          className="w-24 rounded-md border bg-background px-2 py-1 text-xs"
        />
      </div>

      {blocked && reason !== "" && (
        <p aria-live="polite" className="mb-2 text-xs text-destructive">
          {reason}
        </p>
      )}
      {preview !== null && <p className="mb-2 text-xs text-muted-foreground">这一档：{preview}</p>}

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="rounded-md border px-2 py-1 text-xs hover:bg-muted"
        >
          取消
        </button>
        <button
          type="button"
          disabled={blocked}
          onClick={() => {
            // 再算一次，不用渲染时那个结论：按钮可点与真正发出之间不许有任何陈旧。
            const current = validateDraft({ unit: selected.unit, n });
            onAdd(current.ok && !existing.includes(current.spec) ? current.spec : "");
          }}
          className="rounded-md bg-primary px-2 py-1 text-xs text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-40"
        >
          加入
        </button>
      </div>
    </div>
  );
}
