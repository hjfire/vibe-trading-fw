/**
 * Which of the four chart-panel switches are open — one session-scoped key.
 *
 * The spec is `docs/forensics/spec/drawings.md` TV-DW-05 plus
 * `docs/forensics/spec/chart-interaction.md` TV-CI-06, and the boundary stated
 * there is load-bearing for this file: the L1 reading only puts the counterpart's
 * visibility *key name* on its `session_storage_keys` line (that entry's own
 * 2026-10-14 correction says key name → behaviour is an inference, the value side
 * was never read). So `sessionStorage` copies the *scope*, and "survives a reload,
 * resets with the tab" is this repo's own behaviour spec — not a复刻 claim.
 *
 * Encoding follows `saveLegendPrefs` (same family: a UI pref whose read side falls
 * back to defaults): only deviations are written, and an all-closed write deletes
 * the key. Writing the whole four-key snapshot would freeze today's defaults into
 * the session. `SESSION_KEY` writes unconditionally because "the symbol I was
 * last looking at" has no default to fall back to — different family.
 */

export interface PanelVisibility {
  workbench: boolean;
  subIndicator: boolean;
  drawings: boolean;
  legend: boolean;
}

export const PANELS_KEY = "pro-chart.panels.v1";

export const DEFAULT_PANEL_VISIBILITY: Readonly<PanelVisibility> = Object.freeze({
  workbench: false,
  subIndicator: false,
  drawings: false,
  legend: false,
});

const FIELDS: ReadonlyArray<keyof PanelVisibility> = ["workbench", "subIndicator", "drawings", "legend"];

/** Strict `=== true`: a hand-edited or stale value cannot open a panel nobody asked for. */
export function normalizePanelVisibility(raw: unknown): PanelVisibility {
  const next: PanelVisibility = { ...DEFAULT_PANEL_VISIBILITY };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return next;
  const o = raw as Record<string, unknown>;
  for (const f of FIELDS) next[f] = o[f] === true;
  return next;
}

export function loadPanelVisibility(): PanelVisibility {
  try {
    const raw = sessionStorage.getItem(PANELS_KEY);
    if (!raw) return { ...DEFAULT_PANEL_VISIBILITY };
    return normalizePanelVisibility(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_PANEL_VISIBILITY };
  }
}

/** Replaces the stored set rather than merging: a patch-only object would drop the other open panels. */
export function savePanelVisibility(v: PanelVisibility): void {
  try {
    const next = normalizePanelVisibility(v);
    const deviated: Partial<PanelVisibility> = {};
    for (const f of FIELDS) if (next[f]) deviated[f] = true;
    if (Object.keys(deviated).length === 0) {
      sessionStorage.removeItem(PANELS_KEY);
      return;
    }
    sessionStorage.setItem(PANELS_KEY, JSON.stringify(deviated));
  } catch {
    /* best effort: persistence is a convenience, a failed write must not throw out of a click */
  }
}
