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

  it("numbers every source line in the editor gutter, tracking edits", () => {
    const code = '//@version=5\nindicator("x", overlay=true)\nplot(close)';
    open({ seed: { draft: { ...EMPTY_DRAFT, code }, tab: "editor" as const } });
    const gutter = screen.getByTestId("code-gutter");
    const nums = () => Array.from(gutter.querySelectorAll("div")).map((d) => d.textContent);
    expect(nums()).toEqual(["1", "2", "3"]);
    // Editing the source must grow the gutter in lockstep with the textarea.
    fireEvent.change(screen.getByPlaceholderText(/本地公式/), {
      target: { value: `${code}\nplot(open)` },
    });
    expect(nums()).toEqual(["1", "2", "3", "4"]);
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

    fireEvent.click(screen.getByRole("tab", { name: "脚本库" }));
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
      fireEvent.click(screen.getByRole("tab", { name: "脚本库" }));
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
    fireEvent.click(screen.getByRole("tab", { name: "导入导出" }));
    fireEvent.change(screen.getByPlaceholderText(/粘贴/), { target: { value: toPineFile(card) } });
    fireEvent.click(screen.getByRole("button", { name: "导入" }));

    expect(await screen.findByText(/已载入「外部脚本」到编辑器/)).toBeTruthy();
    // Nothing is mounted without a look: the chart stays untouched…
    expect(chart.createIndicator).not.toHaveBeenCalled();
    expect(stored()).toHaveLength(0);
    // …and the editor now holds the source with its stored parameters.
    fireEvent.click(screen.getByRole("tab", { name: "编辑器" }));
    const box = screen.getByPlaceholderText(/本地公式/) as HTMLTextAreaElement;
    expect(box.value).toBe(FORM_SRC);
    expect(screen.getByDisplayValue("外部脚本")).toBeTruthy();
    expect(screen.getByPlaceholderText("如 14, 2")).toHaveProperty("value", "7");
  });

  it("rejects a paste that is not a script", async () => {
    open();
    fireEvent.click(screen.getByRole("tab", { name: "导入导出" }));
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
    fireEvent.click(screen.getByRole("tab", { name: "策略报告" }));
    expect(await screen.findByText(/还没有 Pine 脚本/)).toBeTruthy();
  });

  it("reruns a saved script and keeps its report", async () => {
    const strategy = SCRIPT_LIBRARY.find((e) => e.category === "strategy")!;
    open();
    fireEvent.click(screen.getByRole("tab", { name: "脚本库" }));
    fireEvent.change(screen.getByPlaceholderText(/搜索名称/), { target: { value: strategy.name } });
    fireEvent.click(await screen.findByRole("button", { name: "应用" }));
    await screen.findByText("净收益");

    fireEvent.click(screen.getByRole("tab", { name: "策略报告" }));
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
      fireEvent.click(screen.getByRole("tab", { name: "脚本库" }));
      fireEvent.change(screen.getByPlaceholderText(/搜索名称/), { target: { value: name } });
      fireEvent.click(await screen.findByRole("button", { name: "应用" }));
    };

    await applyFromLibrary(drawn.name);
    fireEvent.click(screen.getByRole("tab", { name: "策略报告" }));
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

describe("脚本工作台浮层的无障碍角色", () => {
  it("抽屉自陈 role=dialog＋aria-modal，可达名由标题节点解析；遮罩只是 presentation", () => {
    const { container } = open();

    const dialog = screen.getByRole("dialog", { name: /脚本工作台/ });
    expect(dialog).toHaveAttribute("aria-modal", "true");

    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    const title = document.getElementById(labelledBy as string);
    expect(title).not.toBeNull();
    expect((title as HTMLElement).textContent).toBe("ƒ 脚本工作台");

    // 整棵树只有这一枚 dialog，且它不是那层整屏遮罩。
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(container.querySelector(".fixed.inset-0")).toHaveAttribute("role", "presentation");
  });

  it("关闭按钮有本仓中文可达名（纯 CJK 形状），点它真的调 onClose", () => {
    const onClose = vi.fn();
    open({ onClose });

    const btn = screen.getByRole("button", { name: "关闭脚本工作台" });
    expect(screen.getAllByRole("button", { name: "关闭脚本工作台" })).toHaveLength(1);
    expect(btn.getAttribute("aria-label")).toBe("关闭脚本工作台");
    // 本仓可达名一律中文：抄进任何英文控件名，这把尺直接判红。
    expect(btn.getAttribute("aria-label")).toMatch(/^[一-鿿]+$/);

    fireEvent.click(btn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("脚本工作台页签的无障碍角色", () => {
  it("恰一枚 tablist、六枚 tab、selected 唯一且默认落在编辑器；tablist 的孩子全是 tab", () => {
    const { container } = open();

    expect(container.querySelectorAll('[role="tablist"]')).toHaveLength(1);
    expect(screen.getAllByRole("tab")).toHaveLength(6);

    // 「N/M 已挂载」那枚计数不属于页签，必须住在 tablist 之外。
    const tablist = container.querySelector('[role="tablist"]') as HTMLElement;
    for (const child of Array.from(tablist.children)) {
      expect(child.getAttribute("role")).toBe("tab");
    }

    const tabs = screen.getAllByRole("tab");
    const selected = tabs.filter((t) => t.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveAccessibleName("编辑器");
    for (const t of tabs.filter((x) => x !== selected[0])) {
      expect(t.getAttribute("aria-selected")).toBe("false");
    }

    // 裁定二只管 tab→panel 这一条线：本片不给六枚 tab 发 aria-controls，因为条件发它
    // 需要同时给页身面板补上 id 与 aria-labelledby，那是另一片的范围（仓内两条形状都可达：
    // PeriodPicker.tsx:65 的「open 才发 aria-controls」、WelcomeScreen.tsx:346 的
    // 「只渲染选中页身 + role=tabpanel」）。针因此只逐枚钉六枚 tab，不数整棵抽屉——
    // 否则六段页身将来任何一页正当加一枚可折叠区，都会为无关的事把这根针判红。
    for (const t of tabs) {
      expect(t.hasAttribute("aria-controls")).toBe(false);
    }

    // m11 变异自证补针：搬家后的「N/M 已挂载」计数文本必须仍在树里可读。
    expect(screen.getByText(/已挂载/)).toBeTruthy();
  });

  it("点另一页后 selected 跟着换页，且仍然恰一枚", () => {
    open();
    fireEvent.click(screen.getByRole("tab", { name: "脚本库" }));
    const selected = screen
      .getAllByRole("tab")
      .filter((t) => t.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveAccessibleName("脚本库");
  });
});

/**
 * `aria-modal="true"` 是一句承诺：声明它的代价是把焦点管起来。以下三枚针断的是
 * 真 DOM 焦点（`document.activeElement`），不是 mock 调用记录。
 */
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

describe("脚本工作台浮层的焦点管理", () => {
  it("打开后 document.activeElement 就是关闭按钮（焦点进得来）", () => {
    open();
    const close = screen.getByRole("button", { name: "关闭脚本工作台" });
    expect(document.activeElement).toBe(close);
  });

  it("Tab 与 Shift+Tab 在抽屉首尾环回并吃掉默认动作（焦点出不去）", () => {
    open();
    const dialog = screen.getByRole("dialog", { name: /脚本工作台/ });
    const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
    expect(focusables.length).toBeGreaterThan(2);
    const first = focusables[0];
    const last = focusables[focusables.length - 1];

    // 焦点在末枚上按 Tab ⇒ 环回首枚；fireEvent 返回 false 就是 preventDefault 被调的证据。
    last.focus();
    expect(document.activeElement).toBe(last);
    expect(fireEvent.keyDown(last, { key: "Tab" })).toBe(false);
    expect(document.activeElement).toBe(first);

    // 焦点在首枚上 Shift+Tab ⇒ 环回末枚。
    first.focus();
    expect(document.activeElement).toBe(first);
    expect(fireEvent.keyDown(first, { key: "Tab", shiftKey: true })).toBe(false);
    expect(document.activeElement).toBe(last);
  });

  it("关闭后焦点归还给打开前那枚元素，且中途重渲染不偷焦点（关完回到原处）", () => {
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    chart = fakeChart();
    onChanged = vi.fn();
    const props = (next: { open: boolean; onClose: () => void }) => (
      <IndicatorEditor
        open={next.open}
        onClose={next.onClose}
        getChart={() => chart as never}
        onChartIndicatorsChanged={onChanged}
      />
    );
    const view = render(props({ open: true, onClose: vi.fn() }));
    const close = screen.getByRole("button", { name: "关闭脚本工作台" });
    expect(document.activeElement).toBe(close);

    // ProChart.tsx 那侧 `onClose={() => setIndPanelOpen(false)}` 每轮渲染都是新函数，
    // 所以这里刻意换一枚 onClose 重渲染：归还焦点那步一旦被挂进依赖 onClose 的 effect，
    // 这轮重渲染就会把它重放一遍，抽屉打字时焦点会被偷走。
    view.rerender(props({ open: true, onClose: vi.fn() }));
    expect(document.activeElement).toBe(close);

    view.rerender(props({ open: false, onClose: vi.fn() }));
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("抽屉里打字时重渲染不偷焦点：记 focus 只跟 open 走，不跟 onClose 走", () => {
    const view = open();
    const close = screen.getByRole("button", { name: "关闭脚本工作台" });
    // 先进关闭按钮这一笔，是为了让这枚针与「压根不管焦点」的旧形状分得开：
    // 旧实现里焦点本来就待在 textarea 上，不这样起手就测不出偷焦点。
    expect(document.activeElement).toBe(close);

    const box = screen.getByPlaceholderText(/本地公式/) as HTMLTextAreaElement;
    box.focus();
    expect(document.activeElement).toBe(box);

    // 宿主那侧 `onClose={() => setIndPanelOpen(false)}` 每次渲染都是新函数，这里照那个
    // 形状换一枚 onClose 重渲染：归还/抓取焦点一旦被挂进依赖 onClose 的 effect，
    // cleanup 与 effect 重放就会把焦点从 textarea 抢回关闭按钮。
    view.rerender(
      <IndicatorEditor
        open
        onClose={vi.fn()}
        getChart={() => chart as never}
        onChartIndicatorsChanged={onChanged}
      />,
    );
    expect(document.activeElement).toBe(box);
  });
});
