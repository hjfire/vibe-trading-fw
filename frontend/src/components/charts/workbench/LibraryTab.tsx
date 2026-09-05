import { useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import {
  LIBRARY_CATEGORIES,
  SCRIPT_LIBRARY,
  categoryLabel,
  searchLibrary,
  type LibraryCategoryKey,
} from "@/lib/scriptLibrary";
import type { ScriptCard } from "@/lib/scriptExchange";

/**
 * The built-in script library, laid out like TradingView's script categories.
 * Every entry is verified runnable by `scriptLibrary.test.ts`, so "应用" here
 * is not a demo — it mounts.
 */

interface LibraryTabProps {
  /** Load a script into the editor for tweaking. */
  onLoad: (card: ScriptCard) => void;
  /** Mount a script as-is. */
  onApply: (card: ScriptCard) => void;
  /** Names already installed, so the list can say so. */
  installed: string[];
}

export default function LibraryTab({ onLoad, onApply, installed }: LibraryTabProps) {
  const [category, setCategory] = useState<LibraryCategoryKey | "">("");
  const [query, setQuery] = useState("");

  const entries = useMemo(() => searchLibrary(query, category), [query, category]);
  const installedNames = useMemo(() => new Set(installed), [installed]);

  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap gap-1.5">
        <Chip active={category === ""} onClick={() => setCategory("")} label={`全部 ${SCRIPT_LIBRARY.length}`} />
        {LIBRARY_CATEGORIES.map((c) => (
          <Chip
            key={c.key}
            active={category === c.key}
            title={c.hint}
            onClick={() => setCategory(c.key)}
            label={`${c.label} ${SCRIPT_LIBRARY.filter((e) => e.category === c.key).length}`}
          />
        ))}
      </div>

      <input
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="搜索名称、说明或函数，如 布林 / supertrend / strategy.entry"
        className="h-8 w-full rounded border bg-background px-2 text-xs outline-none focus:border-primary"
      />

      <p className="text-[11px] leading-4 text-muted-foreground">
        全部为 Pine Script v5 语法，可直接复制到 TradingView 使用；「应用」立即挂载到当前图表，「编辑」载入工作台再改。
      </p>

      {entries.length === 0 && <p className="text-xs text-muted-foreground">没有匹配的脚本，换个关键词试试。</p>}

      <div className="space-y-1.5">
        {entries.map((e) => (
          <div key={e.id} className="rounded border p-2">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-xs font-semibold">
                {e.name}
                {installedNames.has(e.name) && (
                  <span className="ml-1.5 rounded bg-muted px-1 py-0.5 text-[10px] font-normal text-muted-foreground">
                    已安装
                  </span>
                )}
              </span>
              <span className="shrink-0 rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                {categoryLabel(e.category)} · {e.display === "overlay" ? "主图" : "副图"}
              </span>
            </div>
            <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{e.description}</p>
            <div className="mt-1.5 flex gap-1.5">
              <button
                type="button"
                onClick={() => onApply(e)}
                className="rounded bg-primary px-2 py-0.5 text-[11px] font-medium text-primary-foreground hover:opacity-90"
              >
                应用
              </button>
              <button
                type="button"
                onClick={() => onLoad(e)}
                className="rounded border px-2 py-0.5 text-[11px] hover:bg-muted"
              >
                编辑
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Chip({
  label,
  active,
  onClick,
  title,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  title?: string;
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className={cn(
        "rounded-full border px-2 py-0.5 text-[11px] hover:bg-muted",
        active && "border-primary bg-primary/10 font-semibold text-foreground",
      )}
    >
      {label}
    </button>
  );
}
