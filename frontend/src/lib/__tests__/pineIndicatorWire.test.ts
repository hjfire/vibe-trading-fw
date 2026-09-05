import { afterEach, describe, expect, it, vi } from "vitest";

// Capture what the mount layer registers instead of touching the real chart.
const registered: Array<Record<string, unknown>> = [];
vi.mock("klinecharts", () => ({
  registerIndicator: (spec: Record<string, unknown>) => registered.push(spec),
}));

import {
  applyUserIndicator,
  detectDialect,
  getPineArtifact,
  indicatorName,
  removeUserIndicator,
  subscribePineArtifact,
} from "../indicatorLang";
import type { ApplySpec } from "../indicatorLang";
import type { KLineData } from "klinecharts";

/** Oscillating prices, so `ta.crossover` genuinely fires on this data. */
function makeBars(n: number): KLineData[] {
  return Array.from({ length: n }, (_, i) => {
    const close = 100 + 8 * Math.sin(i / 4) + i * 0.1;
    const open = close + 0.6 * Math.cos(i);
    return {
      timestamp: 1700000000000 + i * 86400000,
      open,
      high: Math.max(open, close) + 0.6,
      low: Math.min(open, close) - 0.6,
      close,
      volume: 1000 + i,
      turnover: 0,
    } as KLineData;
  });
}

const BARS = makeBars(80);

function fakeChart() {
  return {
    getDataList: () => BARS,
    removeIndicator: vi.fn(),
    createIndicator: vi.fn(),
  };
}

const SMA_SRC = [
  '//@version=5',
  'indicator("SMA 叠加", overlay=true)',
  'n = input.int(5, "周期")',
  'plot(ta.sma(close, n), "均线", color=color.orange)',
  'plotshape(ta.crossover(close, ta.sma(close, n)), "金叉", shape.triangleup, location.belowbar, color.green)',
  'hline(100, "基准")',
].join("\n");

afterEach(() => registered.length = 0);

describe("dialect dispatch", () => {
  it("routes Pine source to the Pine engine and keeps the vector language", () => {
    expect(detectDialect(SMA_SRC)).toBe("pine");
    expect(detectDialect("return { ma(close, 5) };")).toBe("vector");
  });

  it("mounts a Pine indicator as an overlay with figures and gaps", () => {
    const chart = fakeChart();
    const spec: ApplySpec = { id: "w1", label: "SMA", code: SMA_SRC, params: [5], kind: "pane" };
    const notes: string[] = [];
    expect(applyUserIndicator(chart as never, spec, (m) => notes.push(m))).toBeNull();
    // The header's overlay=true wins over the locally stored kind.
    expect(chart.createIndicator).toHaveBeenCalledWith(
      { name: indicatorName("w1"), paneId: "candle_pane" },
      true,
    );
    const reg = registered[registered.length - 1] as {
      series: string;
      figures: Array<{ key: string; title: string; type: string }>;
    };
    expect(reg.series).toBe("price");
    expect(reg.figures.map((f) => f.type)).toEqual(["line", "circle", "line"]);
    expect(reg.figures.map((f) => f.title)).toEqual(["均线:", "金叉:", "基准:"]);

    const artifact = getPineArtifact("w1");
    expect(artifact?.rows.length).toBe(80);
    expect(notes).toEqual([]);
    expect(artifact?.result.inputs).toHaveLength(1);
  });

  it("re-runs the script through calc and notifies subscribers", () => {
    const chart = fakeChart();
    applyUserIndicator(chart as never, {
      id: "w2",
      label: "x",
      code: SMA_SRC,
      params: [5],
      kind: "pane",
    });
    const reg = registered[registered.length - 1] as {
      calc: (data: KLineData[], indicator: { calcParams: number[] }) => Array<Record<string, number | undefined>>;
    };
    const seen: Array<string | undefined> = [];
    const off = subscribePineArtifact("w2", (a) => seen.push(a ? "run" : "clear"));
    const rows = reg.calc(BARS, { calcParams: [20] });
    expect(rows.length).toBe(80);
    expect(seen).toEqual(["run"]);
    // A longer window leaves more warm-up gaps than the default did.
    const key = (reg as unknown as { figures: Array<{ key: string }> }).figures[0].key;
    expect(rows[5][key]).toBeUndefined();
    expect(rows[79][key]).toBeCloseTo(
      BARS.slice(60, 80).reduce((a, b) => a + b.close, 0) / 20,
      8,
    );
    removeUserIndicator(chart as never, "w2");
    expect(seen).toEqual(["run", "clear"]);
    expect(getPineArtifact("w2")).toBeUndefined();
    off();
  });

  it("returns a readable error and mounts nothing when the script is broken", () => {
    const chart = fakeChart();
    const err = applyUserIndicator(chart as never, {
      id: "w3",
      label: "x",
      code: 'indicator("bad")\nplot(ta.nope(close))',
      params: [],
      kind: "pane",
    });
    expect(err).toContain("Pine 脚本错误");
    expect(err).toContain("ta.nope");
    expect(chart.createIndicator).not.toHaveBeenCalled();
  });

  it("surfaces degraded calls as notes, not as failures", () => {
    const chart = fakeChart();
    const notes: string[] = [];
    const err = applyUserIndicator(
      chart as never,
      {
        id: "w4",
        label: "x",
        code: '//@version=5\nindicator("deco")\nplot(close, "c")\nbgcolor(color.red)\n',
        params: [],
        kind: "pane",
      },
      (m) => notes.push(m),
    );
    expect(err).toBeNull();
    expect(notes.join(" ")).toContain("bgcolor");
    expect(chart.createIndicator).toHaveBeenCalledWith({ name: indicatorName("w4") });
  });
});
