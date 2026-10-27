import { configure } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
// Initialize i18n so `useTranslation()` resolves real strings in tests.
// With no localStorage entry under jsdom this falls back to English, keeping
// the suite's English assertions stable.
import "../i18n";

// `findBy*` waits on testing-library's own 1s budget, separate from vitest's
// testTimeout — raising that one does not raise this. The budget is smaller than
// these tests' own wall clock under fork starvation: at 48 workers the QVeris
// i18n test passes in 1419ms when unaborted, and it is this 1s wait that fails
// when it is. Nothing stalls; the polling just crosses the budget.
configure({ asyncUtilTimeout: 5_000 });

// ── Global mocks for jsdom ───────────────────────────────────

// jsdom doesn't implement ResizeObserver (ECharts + layout components need it)
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

// jsdom doesn't implement matchMedia
if (typeof window !== "undefined") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  });
}
