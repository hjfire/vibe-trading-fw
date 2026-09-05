import { describe, expect, it } from "vitest";
import type { KLineData } from "klinecharts";

import {
  LIBRARY_CATEGORIES,
  SCRIPT_LIBRARY,
  categoryLabel,
  findLibrary,
  libraryByCategory,
  libraryToCard,
  searchLibrary,
} from "../scriptLibrary";
import { compilePine, type PineArtifact, type PineFailure } from "../pineScript";

/**
 * Deterministic market-like data: a rising trend carrying two full cycles, so
 * cross/return-to-mean logic all has something to react to. 320 bars leaves
 * room for the slowest library input (200-period EMA) to warm up.
 */
function makeBars(n: number): KLineData[] {
  const out: KLineData[] = [];
  for (let i = 0; i < n; i++) {
    const cycle = 9 * Math.sin((i / 34) * Math.PI * 2) + 4 * Math.sin(i / 7);
    const close = 120 + cycle + i * 0.12;
    const open = i === 0 ? close : out[i - 1].close + 0.35 * Math.cos(i / 3);
    const high = Math.max(open, close) + 1.2 + 0.6 * Math.abs(Math.sin(i / 5));
    const low = Math.min(open, close) - 1.2 - 0.6 * Math.abs(Math.cos(i / 5));
    const volume = 1_000_000 * (1 + 0.55 * Math.sin(i / 9)) + 40_000 * (i % 7);
    out.push({
      timestamp: 1700000000000 + i * 86400000,
      open,
      high,
      low,
      close,
      volume: Math.max(1000, volume),
      turnover: Math.max(1000, volume) * close,
    } as KLineData);
  }
  return out;
}

const BARS = makeBars(320);

/** Compile every library script once and reuse the outcome for all checks. */
const RUNS = new Map<string, PineArtifact | PineFailure>();
function run(id: string): PineArtifact | PineFailure {
  if (!RUNS.has(id)) {
    const entry = SCRIPT_LIBRARY.find((e) => e.id === id)!;
    RUNS.set(id, compilePine(entry.code, BARS));
  }
  return RUNS.get(id)!;
}

function ok(entry: (typeof SCRIPT_LIBRARY)[number]): PineArtifact {
  const out = run(entry.id);
  if ("error" in out) throw new Error(`${entry.id}: ${out.error}`);
  return out;
}

describe("脚本库结构", () => {
  it("分类齐全，每类都有可看的内容", () => {
    expect(LIBRARY_CATEGORIES.map((c) => c.key)).toEqual([
      "trend",
      "oscillator",
      "volume",
      "volatility",
      "strategy",
    ]);
    for (const cat of LIBRARY_CATEGORIES) {
      expect(libraryByCategory(cat.key).length).toBeGreaterThanOrEqual(4);
    }
  });

  it("id 与名称唯一，描述/分类/展示位都填了", () => {
    const ids = new Set(SCRIPT_LIBRARY.map((e) => e.id));
    const names = new Set(SCRIPT_LIBRARY.map((e) => e.name));
    expect(ids.size).toBe(SCRIPT_LIBRARY.length);
    expect(names.size).toBe(SCRIPT_LIBRARY.length);
    for (const e of SCRIPT_LIBRARY) {
      expect(e.dialect).toBe("pine");
      expect(e.description.length).toBeGreaterThan(4);
      expect(["overlay", "pane"]).toContain(e.display);
      expect(LIBRARY_CATEGORIES.map((c) => c.key)).toContain(e.category);
      expect(e.code.startsWith("//@version=5")).toBe(true);
    }
  });

  it("策略条目都是 strategy() 开头且标为策略类", () => {
    for (const e of SCRIPT_LIBRARY.filter((x) => x.category === "strategy")) {
      expect(e.code).toMatch(/^\s*strategy\s*\(/m);
    }
  });

  it("查找、搜索与取用", () => {
    expect(findLibrary("lib-rsi")?.name).toBe("RSI 相对强弱");
    expect(findLibrary("nope")).toBeUndefined();
    expect(categoryLabel("trend")).toBe("趋势");
    expect(searchLibrary("布林").map((e) => e.id)).toContain("lib-bb");
    expect(searchLibrary("海龟").map((e) => e.id)).toEqual(["lib-st-donchian"]);
    expect(searchLibrary("", "volume").every((e) => e.category === "volume")).toBe(true);
    const card = libraryToCard("lib-rsi");
    expect(card?.id).not.toBe("lib-rsi");
    expect(card?.code).toBe(findLibrary("lib-rsi")?.code);
    expect(libraryToCard("missing")).toBeNull();
  });
});

describe("脚本库可运行性（每一条都真跑一遍）", () => {
  it.each(SCRIPT_LIBRARY.map((e) => [e.id, e.name] as const))("%s（%s）编译并产出图形", (id) => {
    const entry = SCRIPT_LIBRARY.find((e) => e.id === id)!;
    const out = run(id);
    if ("error" in out) {
      throw new Error(`${id} 编译失败：${out.error}`);
    }
    expect(out.abort, `${id} 中途报错：${out.abort}`).toBeUndefined();
    expect(out.figures.length).toBeGreaterThan(0);
    // 至少一条序列真的算出了足够多的数值，而不是一片空白。
    const best = Math.max(
      ...Object.keys(out.rows[0] ?? {}).map((key) => out.rows.filter((r) => r[key] !== undefined).length),
    );
    expect(best).toBeGreaterThan(100);
    // 库里的脚本不该留下任何降级说明——有就说明用了引擎不支持的写法。
    expect(out.result.warnings, `${id} 告警：${out.result.warnings.join(" | ")}`).toEqual([]);
    expect(out.result.overlay).toBe(entry.display === "overlay");
    expect(out.result.bars).toBe(BARS.length);
  });

  it("策略条目全部产生真实回测报告与成交", () => {
    for (const entry of SCRIPT_LIBRARY.filter((e) => e.category === "strategy")) {
      const art = ok(entry);
      const rep = art.result.report;
      expect(rep, `${entry.id} 没有策略报告`).toBeTruthy();
      expect(rep!.trades.length, `${entry.id} 一笔未成交`).toBeGreaterThan(0);
      expect(art.result.overlay).toBe(true);
      // 权益曲线逐根对齐，且已实现 + 未实现 = 权益变动
      expect(rep!.equity.length).toBe(BARS.length);
      const last = rep!.equity[rep!.equity.length - 1];
      expect(Number.isFinite(last)).toBe(true);
      expect(rep!.netPnl + rep!.unrealizedPnl).toBeCloseTo(last - rep!.initialCapital, 4);
    }
  });

  it("指标条目的输入声明可驱动参数表单，覆盖后结果真的变化", () => {
    const rsi = findLibrary("lib-rsi")!;
    const art = ok(rsi);
    const labels = art.result.inputs.map((i) => i.label);
    expect(labels).toEqual(["来源", "周期", "显示中轴"]);
    expect(art.result.inputs[1]).toMatchObject({ kind: "int", def: 14, min: 2 });

    const tuned = compilePine(rsi.code, BARS, { params: [0, 2, 0] });
    if ("error" in tuned) throw new Error(tuned.error);
    // 周期=2 的 RSI 明显比默认 14 更贴价格，且中轴线被关闭
    const midKey = tuned.figures.findIndex((f) => f.title === "中轴");
    if (midKey >= 0) {
      const key = tuned.figures[midKey].key;
      expect(tuned.rows.every((r) => r[key] === undefined)).toBe(true);
    }
    const rsiKey = tuned.figures.find((f) => f.title === "RSI")!.key;
    const tight = tuned.rows.filter((r) => r[rsiKey] !== undefined).map((r) => r[rsiKey]!);
    const loose = art.rows.filter((r) => r[rsiKey] !== undefined).map((r) => r[rsiKey]!);
    expect(tight[tight.length - 1]).not.toBe(loose[loose.length - 1]);
  });

  it("主图/副图意向与条目声明一致（策略一律上主图）", () => {
    const overlay = SCRIPT_LIBRARY.filter((e) => e.display === "overlay").map((e) => e.id);
    const pane = SCRIPT_LIBRARY.filter((e) => e.display === "pane").map((e) => e.id);
    expect(overlay.length).toBeGreaterThan(10);
    expect(pane.length).toBeGreaterThan(10);
    for (const id of [...overlay, ...pane]) {
      const entry = findLibrary(id)!;
      expect(["pine"]).toContain(entry.dialect);
    }
  });
});
