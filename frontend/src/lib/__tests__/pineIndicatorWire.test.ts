import { afterEach, describe, expect, it, vi } from "vitest";

// Capture what the mount layer registers instead of touching the real chart.
const registered: Array<Record<string, unknown>> = [];
vi.mock("klinecharts", () => ({
  registerIndicator: (spec: Record<string, unknown>) => registered.push(spec),
}));

import {
  applyUserIndicator,
  compileFormula,
  detectDialect,
  getPineArtifact,
  indicatorName,
  normalizeRows,
  removeUserIndicator,
  subscribePineArtifact,
} from "../indicatorLang";
import type { ApplySpec } from "../indicatorLang";
import { compilePine } from "../pineScript";
import { FORMULA_TEMPLATES } from "../indicatorTemplates";
import { SCRIPT_LIBRARY } from "../scriptLibrary";
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
    // ⑲: pane mounts carry the stable `sub:<name>` pane id, not a fresh random one.
    expect(chart.createIndicator).toHaveBeenCalledWith({
      name: indicatorName("w4"),
      paneId: `sub:${indicatorName("w4")}`,
    });
  });
});

/**
 * A registered figure without a drawable `type` is silently dropped by
 * KLineChart (`prepareIndicatorFigures` keeps only `isValid(figure.type)`),
 * which loses the lines, the pane legend values and the last-value marks at
 * once — the formula computes correctly while the chart shows nothing. The
 * Bollinger overlay hit exactly that, so every template in both dialects is
 * checked for it here rather than eyeballed in a browser.
 */
const DRAWABLE = new Set(["line", "bar", "circle", "text", "area"]);

function registeredFigures(id: string): Array<{ key: string; title: string; type?: string }> {
  const reg = registered[registered.length - 1] as {
    name: string;
    figures: Array<{ key: string; title: string; type?: string }>;
  };
  expect(reg.name).toBe(indicatorName(id));
  return reg.figures;
}

describe("每个输出序列都必须可画", () => {
  it("向量语言的 figure 带上 KLineChart 认得的 type", () => {
    const chart = fakeChart();
    expect(
      applyUserIndicator(chart as never, {
        id: "vt1",
        label: "布林带",
        code: "mid = ma(close, P[0]);\nsd = stdev(close, P[0]);\nreturn { MID: mid, UP: mid + P[1] * sd, LOW: mid - P[1] * sd };",
        params: [20, 2],
        kind: "overlay",
      }),
    ).toBeNull();
    const figs = registeredFigures("vt1");
    expect(figs.map((f) => f.key)).toEqual(["MID", "UP", "LOW"]);
    expect(figs.every((f) => DRAWABLE.has(String(f.type)))).toBe(true);
    // Titles reach the legend, so they need the same `NAME:` shape as the
    // built-ins instead of a bare key.
    expect(figs.map((f) => f.title)).toEqual(["MID:", "UP:", "LOW:"]);
    expect(chart.createIndicator).toHaveBeenCalledWith(
      { name: indicatorName("vt1"), paneId: "candle_pane" },
      true,
    );
  });

  it("12 个公式模板逐个挂载，没有一个 figure 会被丢掉", () => {
    for (const tpl of FORMULA_TEMPLATES) {
      const chart = fakeChart();
      const err = applyUserIndicator(chart as never, {
        id: `tpl-${tpl.key}`,
        label: tpl.label,
        code: tpl.code,
        params: tpl.params,
        kind: tpl.kind,
      });
      expect(err, `${tpl.key}: ${err}`).toBeNull();
      const figs = registeredFigures(`tpl-${tpl.key}`);
      expect(figs.length, `${tpl.key} 没有输出序列`).toBeGreaterThan(0);
      for (const f of figs) expect(DRAWABLE.has(String(f.type)), `${tpl.key}/${f.key}`).toBe(true);
      expect(chart.createIndicator).toHaveBeenCalled();
    }
  });

  it("脚本库条目的 figure 同样全部可画", () => {
    for (const entry of SCRIPT_LIBRARY) {
      const chart = fakeChart();
      const err = applyUserIndicator(chart as never, {
        id: `lib-${entry.id}`,
        label: entry.name,
        code: entry.code,
        params: entry.params,
        kind: entry.display,
      });
      if (err) continue; // a strategy without trades is reported, not mounted blind
      const figs = registeredFigures(`lib-${entry.id}`);
      for (const f of figs) expect(DRAWABLE.has(String(f.type)), `${entry.id}/${f.key}`).toBe(true);
    }
  });
});

/**
 * The app ships the same study twice: 布林带 as a vector template and as a
 * Pine library entry. They are rendered on the same pane, so a convention that
 * only differs between the two engines shows up as two sets of bands over one
 * chart. Both are pinned against a hand-computed population σ here, which
 * catches a shared drift as well as a disagreement.
 */
describe("两套引擎口径一致", () => {
  it("同一个布林带用两种语言写出来逐根重合", () => {
    const tpl = FORMULA_TEMPLATES.find((t) => t.key === "boll");
    const lib = SCRIPT_LIBRARY.find((e) => e.id === "lib-bb");
    expect(tpl?.key).toBe("boll");
    expect(lib?.id).toBe("lib-bb");

    const compiled = compileFormula(tpl!.code);
    if (!("run" in compiled)) throw new Error(compiled.error);
    const vec = normalizeRows(compiled.run(BARS, tpl!.params), BARS.length).rows;

    const pine = compilePine(lib!.code, BARS, { params: tpl!.params });
    if ("error" in pine) throw new Error(pine.error);
    const byTitle = (title: string) => {
      const fig = pine.figures.find((f) => f.title === title);
      if (!fig) throw new Error(`Pine 脚本没有输出 ${title}`);
      return pine.rows.map((r) => r[fig.key]);
    };
    const mid = byTitle("中轨");
    const up = byTitle("上轨");
    const low = byTitle("下轨");

    const near = (a: number | undefined, b: number | undefined, where: string) => {
      if (a === undefined || b === undefined) expect(b, where).toBe(a);
      else expect(b, where).toBeCloseTo(a, 10);
    };

    // 20-bar window on 80 bars: 19 warm-up gaps, then identical numbers.
    expect(vec.filter((r) => r.MID === undefined).length).toBe(19);
    for (let i = 0; i < BARS.length; i++) {
      near(vec[i].MID, mid[i], `bar ${i} 中轨`);
      near(vec[i].UP, up[i], `bar ${i} 上轨`);
      near(vec[i].LOW, low[i], `bar ${i} 下轨`);
    }

    // Absolute anchor, so both engines moving to ÷ n-1 together still fails.
    const window = BARS.slice(60, 80).map((b) => b.close);
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const sigma = Math.sqrt(window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length);
    expect(vec[79].MID).toBeCloseTo(mean, 10);
    expect(vec[79].UP).toBeCloseTo(mean + 2 * sigma, 10);
    expect(vec[79].LOW).toBeCloseTo(mean - 2 * sigma, 10);
    expect(up[79]).toBeCloseTo(mean + 2 * sigma, 10);
    expect(low[79]).toBeCloseTo(mean - 2 * sigma, 10);
  });
});
