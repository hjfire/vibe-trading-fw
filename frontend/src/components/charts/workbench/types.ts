/**
 * Shared shape and conversions for the script workbench (local custom ⑪).
 *
 * The workbench moves one piece of text between four seats — the editor, the
 * library, the exchange formats (`.pine` / JSON / share link) and the chart —
 * so the glue lives here rather than being repeated in every tab.
 */

import { detectDialect } from "@/lib/indicatorLang";
import type { UserIndicator } from "@/lib/indicatorStore";
import type { PineInput } from "@/lib/pineScript";
import type { ScriptCard } from "@/lib/scriptExchange";

/** What the editor is holding at any moment. */
export type Draft = {
  /** null = not saved yet. */
  id: string | null;
  label: string;
  kind: "overlay" | "pane";
  /** Positional parameter values as free text; the Pine form writes here too. */
  paramsText: string;
  code: string;
}

export type TabKey = "editor" | "library" | "exchange" | "report" | "screener";

/** What to show when the workbench is opened from outside (share links). */
export interface WorkbenchSeed {
  draft: Draft;
  tab: TabKey;
}

export const EMPTY_DRAFT: Draft = {
  id: null,
  label: "",
  kind: "pane",
  paramsText: "",
  code: `//@version=5
indicator("我的 Pine 指标", overlay=false)
len = input.int(14, "周期", minval=1, maxval=200)
plot(ta.sma(close, len), "SMA", #2962ff, 2)
plotshape(ta.crossover(close, ta.sma(close, len)), "上穿", shape.triangleup, location.belowbar, #26a69a, "")`,
};

export function parseParams(text: string): number[] {
  return text
    .split(/[,，\s]+/)
    .map((t) => t.trim())
    // `Number("")` is 0, so an empty box must be filtered out here or it would
    // silently override the script's own defaults with zero.
    .filter((t) => t !== "")
    .map((t) => Number(t))
    .filter((n) => Number.isFinite(n));
}

export function formatParams(list: number[]): string {
  return list.join(", ");
}

/**
 * One row per declared input, filled from the stored text and falling back to
 * the script's own default, so a form always shows a complete set.
 */
export function alignParams(inputs: PineInput[], text: string): number[] {
  const raw = parseParams(text);
  return inputs.map((inp, i) => (Number.isFinite(raw[i]) ? raw[i] : inp.def));
}

/** Write a value at `index`, extending with the script defaults as needed. */
export function withParam(inputs: PineInput[], text: string, index: number, value: number): string {
  const next = alignParams(inputs, text);
  next[index] = value;
  // Trailing values equal to the script default add nothing; drop them so the
  // stored text stays readable ("14, 2" rather than "14, 2, 0, 9, 1").
  let end = next.length;
  while (end > 0 && next[end - 1] === inputs[end - 1].def) end--;
  return formatParams(next.slice(0, end));
}

export function draftToCard(d: Draft): ScriptCard {
  return {
    id: d.id ?? "draft",
    dialect: detectDialect(d.code),
    name: d.label.trim() || "未命名脚本",
    code: d.code,
    display: d.kind,
    params: parseParams(d.paramsText),
  };
}

export function cardToDraft(card: ScriptCard, id: string | null = null): Draft {
  return {
    id,
    label: card.name,
    kind: card.display,
    paramsText: formatParams(card.params),
    code: card.code,
  };
}

export function cardToIndicator(card: ScriptCard, id: string): UserIndicator {
  return {
    id,
    label: card.name,
    kind: card.display,
    params: card.params,
    code: card.code,
    enabled: true,
  };
}

export function indicatorToCard(it: UserIndicator): ScriptCard {
  return {
    id: it.id,
    dialect: detectDialect(it.code),
    name: it.label,
    code: it.code,
    display: it.kind,
    params: it.params,
  };
}

/* ------------------------------------------------------------ browser glue */

/** Save text to a file. Object URLs keep this CSP-safe (no data: eval). */
export function downloadText(filename: string, text: string, mime = "text/plain"): boolean {
  try {
    const url = URL.createObjectURL(new Blob([text], { type: `${mime};charset=utf-8` }));
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    return true;
  } catch {
    return false;
  }
}

/** Clipboard with a same-page fallback, since it is often blocked outright. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to the manual path */
  }
  return false;
}

/** File names get messy in Chinese titles; keep it filesystem-safe. */
export function slugFilename(name: string): string {
  const cleaned = name
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned || "script";
}
