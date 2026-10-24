/**
 * 自定义周期的红线面（E 组·页面半枚）：目录行的 `disabled` 位只有 `intervalAllowed` 一个来源。
 *
 * 这一件与 `ProChartCustomInterval.test.tsx` 故意分开住：那件钉功能闭环（加入 → 目录 → 当前档 →
 * 取数 → 会话 → 移除），本件钉「哪一位说了算」这类形状。分开的理由是变异自证——spec §9 的 M-10
 * 把 `intervalAllowed` 打成恒 true／恒 false 各一次，读数只需要在本件里取，不必把闭环那批针
 * 一起拖进红，也不许让闭环针顺手去量禁用位（那样「谁红的」就分不出来了）。
 *
 * `forensics/spec/chart-interaction.md` 的 TV-CI-11 那条红线的本仓读法：**对面那侧的 `[disabled]`
 *  标记是每趟取数的瞬态，本仓不许据任何 disabled 标记推定可用性**。⇒ 这一位的唯一来源只能是
 * `lib/chartView.ts` 的 `intervalAllowed`：不从 label 推、不从 `custom` 标记推、不从「这一趟里
 * 别的行被禁过」推。（不复述那一格的读数。）
 *
 * 替身姿势与 `ProChartCustomInterval.test.tsx` 同源：页面从不自己在点击里发请求，图被交给哪个
 * 周期必须由 `setPeriod` → DataLoader 那条腿才有 observable；本件不取数断言，但挂载路径必须是真的，
 * 否则目录那一层根本没渲染，禁用位无从可数。轻量到只记 `setPeriod` 的 double 在这里同样不够。
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DataLoader } from "klinecharts";

import { ProChart } from "../ProChart";

const h = vi.hoisted(() => ({
  ticker: "600519.SH",
  periods: [] as Array<{ type: string; span: number }>,
  requests: [] as Array<Record<string, unknown>>,
  loader: null as DataLoader | null,
}));

/** `StoreImp.setPeriod` 会重设数据并向 loader 要一页 `init`——observable 就住在这条腿上。 */
function driveInitLoad(period: { type: string; span: number }): void {
  const loader = h.loader;
  if (!loader) return;
  void loader.getBars({
    type: "init",
    timestamp: null,
    period: period as never,
    symbol: { ticker: h.ticker, pricePrecision: 2, volumePrecision: 0 },
    callback: () => {},
  });
}

vi.mock("klinecharts", () => ({
  init: () => ({
    getSymbol: () => ({ ticker: h.ticker, pricePrecision: 2, volumePrecision: 0 }),
    getPeriod: () => ({ type: "day", span: 1 }),
    getDataList: () => [],
    getIndicators: () => [],
    getOverlays: () => [],
    getPaneOptions: () => [{ id: "candle_pane", height: 300, minHeight: 30, state: "normal" }],
    getBarSpace: () => ({ bar: 8, halfBar: 4, gapBar: 5, halfGapBar: 2 }),
    getOffsetRightDistance: () => 0,
    applyOptions: () => {},
    setStyles: () => {},
    setPaneOptions: () => true,
    resize: () => {},
    setDataLoader: (loader: DataLoader) => {
      h.loader = loader;
    },
    setSymbol: (s: { ticker: string }) => {
      h.ticker = s.ticker;
    },
    setPeriod: (p: { type: string; span: number }) => {
      h.periods.push(p);
      driveInitLoad(p);
    },
    createIndicator: () => true,
    removeIndicator: () => true,
    createOverlay: () => null,
    removeOverlay: () => true,
    overrideOverlay: () => true,
  }),
  dispose: () => {},
  registerIndicator: () => {},
  registerOverlay: () => {},
  getSupportedLocales: () => ["en-US", "zh-CN"],
  registerLocale: () => {},
  version: () => "test",
}));

// 只换 `fetchKline`：`intervalAllowed`（`lib/chartView.ts`）与 `INTERVALS`／`normalizeInterval`
// 全留真的——「这一档在这一枚标的上答不答得了」正是被测对象本身。
vi.mock("@/lib/marketApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/marketApi")>();
  return {
    ...actual,
    fetchKline: async (params: Record<string, unknown>) => {
      h.requests.push(params);
      return {
        status: "ok",
        symbol: params.symbol,
        interval: params.interval,
        source: "fake:daily",
        bars: [],
      };
    },
  };
});

vi.mock("@/components/charts/WatchList", () => ({ default: () => null }));
vi.mock("@/components/charts/IndicatorEditor", () => ({ default: () => null }));

const SESSION_KEY = "pro-chart.session.v1";

type StoredSession = {
  symbol?: string;
  interval?: string;
  timeShare?: boolean;
  customIntervals?: string[];
};

function seedSession(session: StoredSession): void {
  localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

/** 工具栏里唯一一枚自陈 `haspopup=menu` 的按钮就是周期入口（可达名随档位变，所以按属性定位）。 */
const periodTrigger = (): HTMLElement => {
  const candidates = screen
    .getAllByRole("button")
    .filter((b) => b.getAttribute("aria-haspopup") === "menu");
  expect(candidates).toHaveLength(1);
  return candidates[0];
};

/** 幂等地把目录打开：已经开着就一步都不做。 */
async function openPeriodMenu(): Promise<void> {
  if (periodTrigger().getAttribute("aria-expanded") === "true") return;
  await act(async () => {
    fireEvent.click(periodTrigger());
  });
}

async function mountChart(): Promise<void> {
  // `applyPaneLayout` 从宿主高度算 pane 预算，jsdom 对未样式化的 div 报 0。
  vi.spyOn(window.HTMLElement.prototype, "clientHeight", "get").mockReturnValue(360);
  render(<ProChart />);
  await act(async () => {
    await Promise.resolve();
  });
}

/** 目录里当前**被禁**的那几行的可达名（按行序）。这就是 `intervalAllowed` 在本页的唯一可观察后果。 */
const disabledRowNames = (): string[] =>
  screen
    .getAllByRole("option")
    .filter((row) => (row as HTMLButtonElement).disabled)
    .map((row) => String(row.textContent));

const allRowNames = (): string[] => screen.getAllByRole("option").map((row) => String(row.textContent));

beforeEach(() => {
  localStorage.clear();
  // 面板可见性住在 `sessionStorage`，jsdom 一整份文件共用一个 store。
  sessionStorage.clear();
  h.periods = [];
  h.requests = [];
  h.loader = null;
  h.ticker = "600519.SH";
});

afterEach(() => cleanup());

describe("E 组·页面半枚：禁用位只有 `intervalAllowed` 一个来源", () => {
  it("E-2 BTC（无分钟源）：目录十行一行不少，被禁的恰是分钟道那六行——含自定义的 `120m`，不含自定义的 `2D`", async () => {
    seedSession({ symbol: "BTCUSD", interval: "1D", customIntervals: ["120m", "2D"] });
    await mountChart();
    await openPeriodMenu();
    // 结构面：禁用不摘行、不改名、不改选中位——内置八行在前、两行自定义在尾。
    expect(allRowNames()).toEqual([
      "1分",
      "5分",
      "15分",
      "30分",
      "60分",
      "日线",
      "周线",
      "月线",
      "2小时",
      "2日",
    ]);
    expect(screen.getAllByRole("option").filter((r) => r.getAttribute("aria-selected") === "true")).toHaveLength(1);
    expect(screen.getByRole("option", { name: "日线" }).getAttribute("aria-selected")).toBe("true");
    // 禁用位：只有分钟道被禁。自定义行与内置行走同一把尺——`custom` 标记不是第二个来源。
    expect(disabledRowNames()).toEqual(["1分", "5分", "15分", "30分", "60分", "2小时"]);
    // 那两枚「对面曾经见过 disabled」的推定形状，逐个点名排掉：被禁的档位仍然在树上、仍然可达。
    expect(screen.getByRole("option", { name: "2小时" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "2日" }).getAttribute("aria-disabled")).toBeNull();
  });

  it("E-3 A 股（有分钟源）：同一组行的名字与顺序逐字不变，被禁的那组清空——禁用位随谓词动，结构不随它动", async () => {
    // 与 E-2 同一组档位（`120m`＋`2D`），只换标的：这一位必须**只**由 `intervalAllowed` 决定。
    seedSession({ symbol: "600519.SH", interval: "1D", customIntervals: ["120m", "2D"] });
    await mountChart();
    await openPeriodMenu();
    expect(allRowNames()).toEqual([
      "1分",
      "5分",
      "15分",
      "30分",
      "60分",
      "日线",
      "周线",
      "月线",
      "2小时",
      "2日",
    ]);
    expect(disabledRowNames()).toEqual([]);
    expect(screen.getByRole("option", { name: "2小时" }).hasAttribute("disabled")).toBe(false);
  });

  it("E-4 自定义分钟档在 BTC 下不成为当前档：会话里躺着 `120m`，恢复出来的档位是日线，而那一行还在目录里", async () => {
    // 这一枚钉的是「谓词被禁用时的第二道后果」：`repairInterval` 与目录行读的是同一把尺，
    // 所以按钮不会念着一个答不了的档、目录也不会把那行摘掉。恒 true 的注入在这里红（行被
    // 判成可用 ⇒ 当前档不再是日线），恒 false 的注入在 E-2 红（日线也被禁）。
    seedSession({ symbol: "BTCUSD", interval: "120m", customIntervals: ["120m"] });
    await mountChart();
    expect(periodTrigger().textContent).toBe("日线");
    await openPeriodMenu();
    const row = screen.getByRole("option", { name: "2小时" }) as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    expect(row.getAttribute("aria-selected")).toBe("false");
  });
});

