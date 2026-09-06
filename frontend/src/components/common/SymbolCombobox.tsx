import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/lib/utils";
import { createSearchSequence, isRoutableSymbol, marketLabel, typeLabel, type SymbolCandidate } from "@/lib/symbolSearch";

/** Type-ahead text field for trading symbols (local custom ㉓).
 *
 *  Borrowed interaction contract, not code:
 *  * the keyboard / ARIA shape and the `onMouseDown` blur guard follow the
 *    in-repo `ModelPicker`, so this stays consistent with the settings page and
 *    adds no dependency (the frontend has no Radix/cmdk/AntD to lean on);
 *  * "an empty box still shows something" and the `name` over
 *    `symbol | exchange | type` row layout follow OpenStock's `SearchCommand`,
 *    the closest high-star open-source analogue — with its ⌘K modal dropped,
 *    because here the picker replaces a field the user is already looking at.
 *
 *  It degrades to a plain input on purpose: if the roster is unavailable the
 *  user can always type the whole symbol, exactly as before. */

interface SymbolComboboxProps {
  value: string;
  /** Raw keystrokes, so callers keep control of what is typed but uncommitted. */
  onChange: (text: string) => void;
  /** A committed choice: a picked candidate, or the typed text itself. */
  onPick: (symbol: string, candidate?: SymbolCandidate) => void;
  ariaLabel: string;
  /** DOM id, so a surrounding <label htmlFor> keeps working. */
  id?: string;
  placeholder?: string;
  className?: string;
  /** Sizing for the positioning wrapper; the dropdown is as wide as this. */
  wrapperClassName?: string;
  /** Shown while the box is empty — pass the user's own favourites. */
  hot?: SymbolCandidate[];
  /** Open the list upward, for fields pinned to the bottom of a pane. */
  drop?: "up" | "down";
  limit?: number;
  disabled?: boolean;
  onKeyDown?: (event: KeyboardEvent<HTMLInputElement>) => void;
}

const DEBOUNCE_MS = 220;

/** Normalise free text into the symbol shape the data layer expects. */
export function normalizeSymbolInput(text: string): string {
  return text.trim().toUpperCase().replace(/\s+/g, "");
}

function isExactSymbolRow(candidate: SymbolCandidate, text: string): boolean {
  return candidate.symbol.toUpperCase() === normalizeSymbolInput(text);
}

export default function SymbolCombobox({
  value,
  onChange,
  onPick,
  ariaLabel,
  id,
  placeholder,
  className,
  wrapperClassName,
  hot = [],
  drop = "down",
  limit = 10,
  disabled = false,
  onKeyDown,
}: SymbolComboboxProps) {
  const [candidates, setCandidates] = useState<SymbolCandidate[]>([]);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [searching, setSearching] = useState(false);
  const [warming, setWarming] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const seq = useRef(createSearchSequence());
  const listId = useId();

  // Empty input shows the caller's own list, so the box is useful before the
  // user has typed anything at all.
  const trimmed = value.trim();
  const rows = trimmed ? candidates : hot;
  // A full symbol already in the box makes the "use what I typed" row
  // redundant, and it is the one case where suggesting it back is noise.
  const canSubmitRaw =
    trimmed.length > 0 && !rows.some((row) => isExactSymbolRow(row, trimmed));
  const visible = useMemo(() => rows.slice(0, limit), [rows, limit]);

  const stopTimer = useCallback(() => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }, []);

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, []);

  // Debounce, and tear the pending query down with the component: an
  // unmount-mid-keystroke response would otherwise land on a dead setter.
  useEffect(() => {
    stopTimer();
    if (!trimmed) {
      setCandidates([]);
      setSearching(false);
      return;
    }
    timer.current = setTimeout(() => {
      setSearching(true);
      seq
        .current.run(trimmed, limit)
        .then((out) => {
          if (!out) return; // superseded by a newer keystroke
          setCandidates(out.results);
          setWarming(!out.ready && out.status !== "ok");
          setSearching(false);
        })
        .catch(() => {
          // A failed lookup is a missing dropdown, nothing more: the input
          // still accepts the full symbol, and no toast is warranted.
          setCandidates([]);
          setSearching(false);
        });
    }, DEBOUNCE_MS);
    return () => {
      stopTimer();
      seq.current.cancel();
      setSearching(false);
    };
  }, [trimmed, limit, stopTimer]);

  const commit = (symbol: string, candidate?: SymbolCandidate) => {
    stopTimer();
    seq.current.cancel();
    setOpen(false);
    setActiveIndex(-1);
    onPick(normalizeSymbolInput(symbol), candidate);
  };

  const move = (direction: 1 | -1) => {
    const count = visible.length + (canSubmitRaw ? 1 : 0);
    if (count === 0) return;
    setOpen(true);
    setActiveIndex((current) => {
      if (current < 0) return direction > 0 ? 0 : count - 1;
      return (current + direction + count) % count;
    });
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;
    if (event.key === "Escape") {
      setOpen(false);
      setActiveIndex(-1);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      move(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    if (event.key === "Enter") {
      if (!open) {
        setOpen(true);
        return;
      }
      if (activeIndex >= 0 && activeIndex < visible.length) {
        event.preventDefault();
        const picked = visible[activeIndex];
        commit(picked.symbol, picked);
        return;
      }
      event.preventDefault();
      if (!trimmed) return;
      if (canSubmitRaw && activeIndex === visible.length) {
        // The 'use what I typed' row is deliberately highlighted, so the raw
        // text wins even when nothing could route it.
        commit(trimmed);
        return;
      }
      // Nothing is highlighted, so Enter commits what was typed — the path a
      // crypto pair or FX symbol takes, since those are not in the roster at
      // all. It stops there when the text is not a symbol any loader can route:
      // a bare 00700 only resolves by walking the whole fallback chain (measured
      // `_provenance.source = backtest:loader_fallback_chain`), and it is the
      // form the session, the watchlist and an alert rule then go on storing, so
      // the listing already on screen is the better answer.
      if (visible.length > 0 && !isRoutableSymbol(trimmed)) {
        const first = visible[0];
        commit(first.symbol, first);
        return;
      }
      commit(trimmed);
      return;
    }
    if (event.key === "Tab") setOpen(false);
  };

  const emptyHint = warming
    ? "代码库首次构建中…"
    : trimmed && !searching && visible.length === 0
      ? "无匹配，可直接输入完整代码"
      : null;

  // The 'use what I typed' row sits after the candidates, so the active option
  // is not always `${listId}-${index}` — pointing activedescendant at a missing
  // id would silently break screen-reader announcement of that row.
  const activeOptionId =
    !open || activeIndex < 0
      ? undefined
      : activeIndex < visible.length
        ? `${listId}-${activeIndex}`
        : `${listId}-raw`;

  return (
    <div ref={rootRef} className={cn("relative min-w-0", wrapperClassName)}>
      <input
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.value);
          setActiveIndex(-1);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onClick={() => setOpen(true)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        role="combobox"
        aria-label={ariaLabel}
        aria-expanded={open}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeOptionId}
        className={className}
      />

      {open && (visible.length > 0 || canSubmitRaw || !!emptyHint) && (
        <div
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          className={`absolute left-0 z-50 max-h-64 w-full min-w-[15rem] overflow-y-auto rounded-md border bg-card p-1 shadow-lg ring-1 ring-black/5 ${
            drop === "up" ? "bottom-full mb-1" : "mt-1"
          }`}
        >
          {visible.map((row, index) => (
            <button
              key={row.symbol}
              id={`${listId}-${index}`}
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commit(row.symbol, row)}
              className={`flex w-full flex-col gap-0.5 rounded px-2 py-1.5 text-left ${
                index === activeIndex ? "bg-muted" : "hover:bg-muted/70"
              }`}
            >
              <span className="flex min-w-0 items-baseline gap-1.5">
                <span className="shrink-0 font-mono text-[11px] text-foreground">
                  {row.symbol}
                </span>
                {row.name && (
                  <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                    {row.name}
                  </span>
                )}
              </span>
              {/* Hot rows built from a bare symbol carry neither name nor type. */}
              {(() => {
                const meta = [
                  row.market ? marketLabel(row.market) : "",
                  row.type ? typeLabel(row.type) : "",
                ]
                  .filter(Boolean)
                  .join(" · ");
                return meta ? (
                  <span className="text-[10px] text-muted-foreground">{meta}</span>
                ) : null;
              })()}
            </button>
          ))}

          {canSubmitRaw && (
            <button
              id={`${listId}-raw`}
              type="button"
              role="option"
              aria-selected={activeIndex === visible.length}
              onMouseEnter={() => setActiveIndex(visible.length)}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => commit(trimmed)}
              className={`flex w-full items-center gap-1.5 rounded px-2 py-1.5 text-left text-[11px] ${
                activeIndex === visible.length ? "bg-muted" : "hover:bg-muted/70"
              }`}
            >
              <span className="text-muted-foreground">使用</span>
              <span className="font-mono text-foreground">{normalizeSymbolInput(trimmed)}</span>
            </button>
          )}

          {emptyHint && !searching && (
            <p className="px-2 py-1.5 text-[10px] leading-4 text-muted-foreground">{emptyHint}</p>
          )}
          {searching && <p className="px-2 py-1.5 text-[10px] text-muted-foreground">搜索中…</p>}
        </div>
      )}
    </div>
  );
}
