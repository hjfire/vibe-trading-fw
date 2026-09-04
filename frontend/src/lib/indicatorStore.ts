/** localStorage persistence for user-defined indicator formulas (custom ⑩). */

export interface UserIndicator {
  id: string;
  label: string;
  /** "overlay" = drawn on the candle pane, "pane" = its own sub-chart. */
  kind: "overlay" | "pane";
  params: number[];
  code: string;
  enabled: boolean;
}

const KEY = "pro-chart.userIndicators.v2"; // v1 held JavaScript-syntax formulas, superseded by the interpreted language

export function newIndicatorId(): string {
  return `i${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

export function loadUserIndicators(): UserIndicator[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr: unknown = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr
      .filter(
        (x): x is UserIndicator =>
          !!x &&
          typeof x === "object" &&
          typeof (x as UserIndicator).id === "string" &&
          typeof (x as UserIndicator).code === "string",
      )
      .map((x) => ({
        id: x.id,
        label: typeof x.label === "string" ? x.label : x.id,
        kind: x.kind === "overlay" ? "overlay" : "pane",
        params: Array.isArray(x.params) ? x.params.map(Number).filter(Number.isFinite) : [],
        code: x.code,
        enabled: x.enabled !== false,
      }));
  } catch {
    return [];
  }
}

export function saveUserIndicators(items: UserIndicator[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(items));
  } catch {
    /* quota errors are non-fatal for a convenience feature */
  }
}
