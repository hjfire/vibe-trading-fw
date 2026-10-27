import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  test: {
    globals: true,
    environment: "jsdom",
    setupFiles: ["./src/tests/setup.ts"],
    include: ["src/**/__tests__/**/*.test.{ts,tsx}"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html", "lcov"],
      include: ["src/lib/**", "src/stores/**"],
      exclude: ["src/**/__tests__/**", "src/tests/**"],
    },
    restoreMocks: true,
    // The defaults (5s test / 10s hook) are calibrated for an idle machine. CI hands
    // vitest's forks a fraction of a core each, so a test's wall clock inflates while
    // the code under it is unchanged — and one aborted test is not one red: it leaves
    // that file's container empty, so every later test in it fails too (measured: two
    // 5000ms aborts in ProChartDrawings.test.tsx were followed by 75 more failures in
    // that same file, 77 of the round's 80).
    // Caps stay finite on purpose, so a genuine hang still fails — it costs 20s now.
    testTimeout: 20_000,
    hookTimeout: 20_000,
  },
});
