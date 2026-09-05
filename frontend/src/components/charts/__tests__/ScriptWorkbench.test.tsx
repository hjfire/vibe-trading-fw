import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { KLineData } from "klinecharts";

// The workbench only needs `registerIndicator` to exist; the real chart is
// replaced by the fake we hand through `getChart`.
vi.mock("klinecharts", () => ({ registerIndicator: vi.fn() }));

import IndicatorEditor from "../IndicatorEditor";
import { SCRIPT_LIBRARY } from "@/lib/scriptLibrary";
import { toPineFile, type ScriptCard } from "@/lib/scriptExchange";
import { EMPTY_DRAFT } from "../workbench/types";
import type { UserIndicator } from "@/lib/indicatorStore";

/**
 * Workbench wiring (local custom ⑪): the tabs must actually mount scripts on
 * the chart, persist them, and hand the strategy report back — not just render.
 */

const STORE_KEY = "pro-chart.userIndicators.v2";

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

const BARS = makeBars(120);

function fakeChart() {
  return {
    getDataList: () => BARS,
    removeIndicator: vi.fn(),
    createIndicator: vi.fn(),
  };
}

function stored(): UserIndicator[] {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) ?? "[]") as UserIndicator[];
  } catch {
    return [];
  }
}

const FORM_SRC = [
  '//@version=5',
  'indicator("表单测试", overlay=false)',
  'n = input.int(14, "周期", minval=1, maxval=200)',
  'mid = input.bool(false, "显示中轴")',
  'plot(ta.sma(close, n), "均线")',
  'plot(mid ? 50 : na, "中轴")',
].join("\n");

let chart: ReturnType<typeof fakeChart>;
let onChanged: () => void;

function open(props: Partial<ComponentProps<typeof IndicatorEditor>> = {}) {
  chart = fakeChart();
  onChanged = vi.fn();
  return render(
    <IndicatorEditor
      open
      onClose={vi.fn()}
      getChart={() => chart as never}
      onChartIndicatorsChanged={onChanged}
      {...props}
    />,
  );
}

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("编辑器 tab", () => {
  it("compiles the source, fills the form, and saves the edited parameter", async () => {
    vi.useFakeTimers();
    const seed = { draft: { ...EMPTY_DRAFT, label: "表单测试", code: FORM_SRC }, tab: "editor" as const };
    open({ seed });

    // Debounced compile → the generated form appears with the script's defaults.
    // (Queried synchronously: `findBy*` needs real timers to poll.)
    await act(async () => {
      vi.advanceTimersByTime(600);
    });
    expect(screen.getByText("参数（脚本内 input.* 自动生成）")).toBeTruthy();
    expect(screen.getByText("周期")).toBeTruthy();
    expect(screen.getByText("显示中轴")).toBeTruthy();
    expect(screen.getByDisplayValue("14")).toBeTruthy();

    fireEvent.change(screen.getByDisplayValue("14"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: /保存并应用/ }));

    expect(chart.createIndicator).toHaveBeenCalledTimes(1);
    const rows = stored();
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("表单测试");
    expect(rows[0].params).toEqual([20]);
    expect(rows[0].code).toBe(FORM_SRC);
    expect(onChanged).toHaveBeenCalled();
    // An indicator trades nothing, so saving it stays on the editor — the
    // report tab is only for scripts that can produce numbers.
    expect(screen.queryByText("策略：")).toBeNull();
    expect(screen.getByRole("button", { name: /保存并应用/ })).toBeTruthy();
  });

  it("refuses to mount a script that does not compile", async () => {
    open();
    fireEvent.change(screen.getByPlaceholderText(/本地公式/), {
      target: { value: '//@version=5\nindicator("坏脚本"\nplot(close' },
    });
    fireEvent.click(screen.getByRole("button", { name: /保存并应用/ }));
    expect(await screen.findByText(/Pine 脚本错误/)).toBeTruthy();
    expect(chart.createIndicator).not.toHaveBeenCalled();
    expect(stored()).toHaveLength(0);
  });
});

describe("脚本库 tab", () => {
  it("applies a library strategy onto the candles and reports it", async () => {
    const strategy = SCRIPT_LIBRARY.find((e) => e.category === "strategy");
    expect(strategy).toBeTruthy();
    open();

    fireEvent.click(screen.getByRole("button", { name: "脚本库" }));
    fireEvent.change(screen.getByPlaceholderText(/搜索名称/), { target: { value: strategy!.name } });
    expect(await screen.getByText(strategy!.description)).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "应用" }));

    const rows = stored();
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe(strategy!.name);
    // Strategies declare overlay=true, so they belong on the candle pane.
    expect(chart.createIndicator).toHaveBeenCalledWith(
      { name: expect.stringContaining(rows[0].id), paneId: "candle_pane" },
      true,
    );
    // Applying a strategy lands on its report, with real numbers behind it.
    expect(await screen.findByText("净收益")).toBeTruthy();
    expect(await screen.findByText(/权益曲线/)).toBeTruthy();
    expect(screen.getByText(`策略：`)).toBeTruthy();
  });

  it("re-applying the same script updates in place instead of duplicating", async () => {
    const entry = SCRIPT_LIBRARY[0];
    open();
    const pick = async () => {
      fireEvent.click(screen.getByRole("button", { name: "脚本库" }));
      fireEvent.change(screen.getByPlaceholderText(/搜索名称/), { target: { value: entry.name } });
      fireEvent.click(await screen.findByRole("button", { name: "应用" }));
    };
    await pick();
    await pick();
    expect(stored()).toHaveLength(1);
    expect(stored()[0].label).toBe(entry.name);
    expect(chart.createIndicator).toHaveBeenCalledTimes(2);
  });
});

describe("导入导出 tab", () => {
  it("imports pasted TradingView source into the editor rather than onto the chart", async () => {
    const card: ScriptCard = {
      id: "",
      dialect: "pine",
      name: "外部脚本",
      code: FORM_SRC,
      display: "pane",
      params: [7],
    };
    open();
    fireEvent.click(screen.getByRole("button", { name: "导入导出" }));
    fireEvent.change(screen.getByPlaceholderText(/粘贴/), { target: { value: toPineFile(card) } });
    fireEvent.click(screen.getByRole("button", { name: "导入" }));

    expect(await screen.findByText(/已载入「外部脚本」到编辑器/)).toBeTruthy();
    // Nothing is mounted without a look: the chart stays untouched…
    expect(chart.createIndicator).not.toHaveBeenCalled();
    expect(stored()).toHaveLength(0);
    // …and the editor now holds the source with its stored parameters.
    fireEvent.click(screen.getByRole("button", { name: "编辑器" }));
    const box = screen.getByPlaceholderText(/本地公式/) as HTMLTextAreaElement;
    expect(box.value).toBe(FORM_SRC);
    expect(screen.getByDisplayValue("外部脚本")).toBeTruthy();
    expect(screen.getByPlaceholderText("如 14, 2")).toHaveProperty("value", "7");
  });

  it("rejects a paste that is not a script", async () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "导入导出" }));
    fireEvent.change(screen.getByPlaceholderText(/粘贴/), { target: { value: "今天天气不错" } });
    fireEvent.click(screen.getByRole("button", { name: "导入" }));
    expect(await screen.findByText(/不是脚本代码/)).toBeTruthy();
    expect(stored()).toHaveLength(0);
  });

  it("builds a share link for the current draft", async () => {
    open({ seed: { draft: { ...EMPTY_DRAFT, label: "分享我", code: FORM_SRC }, tab: "exchange" } });
    fireEvent.click(await screen.findByRole("button", { name: /生成分享链接/ }));
    const link = (await waitFor(() => {
      const el = document.querySelector<HTMLInputElement>("input[readonly]");
      if (!el?.value) throw new Error("waiting");
      return el;
    })) as HTMLInputElement;
    expect(link.value).toContain("?s=");
    expect(link.value).toMatch(/[?&]s=[gj][A-Za-z0-9_-]{8,}$/);
  });
});

describe("策略报告 tab", () => {
  it("says so when the chart holds no Pine script", async () => {
    open();
    fireEvent.click(screen.getByRole("button", { name: "策略报告" }));
    expect(await screen.findByText(/还没有 Pine 脚本/)).toBeTruthy();
  });

  it("reruns a saved script and keeps its report", async () => {
    const strategy = SCRIPT_LIBRARY.find((e) => e.category === "strategy")!;
    open();
    fireEvent.click(screen.getByRole("button", { name: "脚本库" }));
    fireEvent.change(screen.getByPlaceholderText(/搜索名称/), { target: { value: strategy.name } });
    fireEvent.click(await screen.findByRole("button", { name: "应用" }));
    await screen.findByText("净收益");

    fireEvent.click(screen.getByRole("button", { name: "策略报告" }));
    chart.createIndicator.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "重新回测" }));
    expect(await screen.findByText(/已按当前K线重新回测/)).toBeTruthy();
    expect(chart.createIndicator).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("净收益")).toBeTruthy();
  });

  it("lists strategies only — a drawing script never poses as one", async () => {
    const drawn = SCRIPT_LIBRARY.find((e) => e.dialect === "pine" && e.category !== "strategy")!;
    const strategy = SCRIPT_LIBRARY.find((e) => e.category === "strategy")!;
    open();
    const applyFromLibrary = async (name: string) => {
      fireEvent.click(screen.getByRole("button", { name: "脚本库" }));
      fireEvent.change(screen.getByPlaceholderText(/搜索名称/), { target: { value: name } });
      fireEvent.click(await screen.findByRole("button", { name: "应用" }));
    };

    await applyFromLibrary(drawn.name);
    fireEvent.click(screen.getByRole("button", { name: "策略报告" }));
    expect(await screen.findByText(/都是 indicator/)).toBeTruthy();
    expect(screen.queryByText("策略：")).toBeNull();

    await applyFromLibrary(strategy.name);
    // Applying a strategy lands on its own report, and the selector holds just it.
    await screen.findByText("净收益");
    expect(await screen.findByText("策略：")).toBeTruthy();
    expect(screen.queryByText(drawn.name)).toBeNull();
    expect(screen.getByRole("button", { name: strategy.name })).toBeTruthy();
  });
});

describe("条件筛选 tab", () => {
  /** Two plotted lines, so the cross rules have something to compare. */
  const CROSS_SRC = [
    "//@version=5",
    'indicator("双均线条件", overlay=true)',
    "fast = ta.sma(close, 3)",
    "slow = ta.sma(close, 6)",
    'plot(fast, "快线")',
    'plot(slow, "慢线")',
  ].join("\n");

  /** Flat until one decisive bar, so the cross is true only for the rising leg. */
  function stepBars(dir: 1 | -1): KLineData[] {
    const n = 120;
    return Array.from({ length: n }, (_, i) => {
      const close = i === n - 1 ? 100 + dir * 6 : 100;
      return {
        timestamp: 1700000000000 + i * 86400000,
        open: close,
        high: close + 0.5,
        low: close - 0.5,
        close,
        volume: 1000,
        turnover: 0,
      } as KLineData;
    });
  }

  it("scans the watchlist with the editor draft and keeps the misses honest", async () => {
    const picked: string[] = [];
    open({
      seed: { draft: { ...EMPTY_DRAFT, label: "双均线条件", code: CROSS_SRC }, tab: "screener" },
      symbols: ["AAA.SH", "BBB.SH"],
      onPickSymbol: (s) => picked.push(s),
      loadBars: async (symbol: string) => (symbol === "AAA.SH" ? stepBars(1) : stepBars(-1)),
    });

    fireEvent.click(screen.getByRole("button", { name: /开始扫描/ }));

    expect(await screen.findByText("扫描完成：2 只，命中 1 只。")).toBeTruthy();
    // The pass carries the marker, the failure carries the reason it failed.
    expect(screen.getByText("命中")).toBeTruthy();
    expect(screen.getByText(/未在最后一根上穿/)).toBeTruthy();
    // Hits sort first, so the actionable row is on top.
    const codes = screen.getAllByText(/^(AAA|BBB)\.SH$/).map((el) => el.textContent);
    expect(codes).toEqual(["AAA.SH", "BBB.SH"]);

    // A result is a jump to the chart, for eyeballing the signal.
    fireEvent.click(screen.getByText("BBB.SH"));
    expect(picked).toEqual(["BBB.SH"]);
    // Nothing was mounted by screening: a scan must not touch the chart.
    expect(chart.createIndicator).not.toHaveBeenCalled();
    expect(stored()).toHaveLength(0);
  });

  it("screens a pasted pool and keeps the setup for next time", async () => {
    const custom = "600519.sh 300750.SZ，000001.SZ";
    open({
      seed: { draft: { ...EMPTY_DRAFT, code: CROSS_SRC }, tab: "screener" },
      symbols: [],
      loadBars: async () => stepBars(1),
    });
    fireEvent.click(screen.getByRole("button", { name: /自定义/ }));
    fireEvent.change(screen.getByPlaceholderText(/粘贴代码/), { target: { value: custom } });
    // Space, comma (both kinds) or one per line — and case is not the user's problem.
    expect(screen.getByText("自定义 3")).toBeTruthy();
    expect(await screen.findByRole("button", { name: /开始扫描 3 只/ })).toBeTruthy();

    // The setup survives a reload, so a saved screen does not have to be rebuilt.
    expect(JSON.parse(localStorage.getItem("pro-chart.screener.v1") ?? "{}")).toMatchObject({
      pool: "custom",
      custom,
      rule: "crossUp",
      interval: "1D",
    });
  });

  it("will not burn a scan on a rule the script cannot satisfy", async () => {
    // The default draft plots one line; the default rule needs two.
    open({
      seed: { draft: { ...EMPTY_DRAFT }, tab: "screener" },
      symbols: ["AAA.SH"],
      loadBars: async () => stepBars(1),
    });
    expect(await screen.findByText(/本判定需要 2 条/)).toBeTruthy();
    const scan = screen.getByRole("button", { name: /开始扫描/ }) as HTMLButtonElement;
    expect(scan.disabled).toBe(true);

    // A rule that fits the script's own output is runnable again.
    fireEvent.change(screen.getByRole("combobox", { name: "判定" }), { target: { value: "nonEmpty" } });
    expect((screen.getByRole("button", { name: /开始扫描/ }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: /开始扫描/ }));
    expect(await screen.findByText("扫描完成：1 只，命中 1 只。")).toBeTruthy();
  });
});
