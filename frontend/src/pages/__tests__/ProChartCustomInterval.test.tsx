/**
 * 自定义档在页面上的那一圈：目录多一行、会话多一个键、分时让位。
 *
 * 这一份钉的是**功能闭环**（加入 → 目录 → 当前档 → 取数 → 会话 → 移除 → 共存），
 * 「disabled 只由谓词决定」那类形状针住在 `ProChartCustomIntervalRedline.test.tsx`，
 * 两件故意分开：前者改的是行为，后者改的是红线形状，混在一起时变异自证分不出谁红。
 *
 * 全部断言走外部世界收得到的东西：目录里的 `role="option"`、入口按钮的可达名与
 * `title`、`fetchKline` 替身收到的参数、`localStorage` 里那坨 JSON。没有一枚针是
 * 「把谓词自己调一遍再比一次」——那种针在变异面前是哑的。
 *
 * 替身姿势照仓内既有页面测试：`klinecharts` 用 `ProChartTimeShare.test.tsx` 那一份
 * （记下 `setPeriod`，并且**像库那样在 `setPeriod` 上驱动一次 `init` 取数**——页面从不
 * 自己发请求，它只把周期交给图，由图的 DataLoader 回调去问 `fetchKline`，轻量到只记
 * `setPeriod` 的 double 会让「取数问的是哪一档」这一腿根本没有 observable）；取数那一腿
 * 用同一份 `fetchKline` double（记参数）。票面甲 Step 1 允许的另一支（断 `globalThis.fetch`
 * 的 URL）在本仓没有先例，故不取。
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DataLoader } from "klinecharts";

import { ProChart, readSession } from "../ProChart";
import { INTERVALS } from "@/lib/marketApi";

const h = vi.hoisted(() => ({
  ticker: "600519.SH",
  periods: [] as Array<{ type: string; span: number }>,
  requests: [] as Array<Record<string, unknown>>,
  loader: null as DataLoader | null,
}));

/**
 * What the library does with the period it is handed: `StoreImp.setPeriod` resets
 * the data and asks the loader for a fresh `init` page. The page never calls
 * `fetchKline` on a click, so this is the only way "which interval did the click
 * end up asking for" has an observable behind it.
 */
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

// klinecharts 一被构造就摸 DOM。这份 double 只记「图被交给了哪个周期」。
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

// 只有 `fetchKline` 被换掉：`INTERVALS`／`normalizeInterval`／`isBuiltinInterval` 全留真的，
// 因为「这一次点击究竟问了服务端什么」正是被测对象本身。
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

/** 会话落盘后的读回：`setItem` 写什么，这里就看见什么。 */
function storedSession(): StoredSession {
  return JSON.parse(localStorage.getItem(SESSION_KEY) ?? "{}") as StoredSession;
}

/** 分时开着的那几趟取数的唯一外部痕迹：请求带着 `session=latest`。 */
const latestAsks = (): number => h.requests.filter((r) => r.session === "latest").length;

/** 工具栏里唯一一枚自陈 `haspopup=menu` 的按钮就是周期入口（按属性定位：它的可达名随档位变）。 */
const periodTrigger = (): HTMLElement => {
  const candidates = screen
    .getAllByRole("button")
    .filter((b) => b.getAttribute("aria-haspopup") === "menu");
  expect(candidates).toHaveLength(1);
  return candidates[0];
};

const optionOf = (label: string): HTMLElement => screen.getByRole("option", { name: label });

/** 幂等地把目录打开：已经开着就一步都不做（同 `ProChartMinuteBars.test.tsx` 那枚 helper 的纪律）。 */
async function openPeriodMenu(): Promise<void> {
  if (periodTrigger().getAttribute("aria-expanded") === "true") return;
  await act(async () => {
    fireEvent.click(periodTrigger());
  });
}

async function clickByRole(
  role: Parameters<typeof screen.getByRole>[0],
  name: string,
): Promise<void> {
  await act(async () => {
    fireEvent.click(screen.getByRole(role, { name }));
  });
}

/**
 * 走对话框那一条真路加一档，全程不碰内部状态。
 *
 * 单位不是按钮名可以硬碰的东西：`CustomIntervalDialog` 的单位入口的可达名**就是当前单位**
 * （默认「分钟」，换过一次之后它不再叫「分钟」），所以要由调用方说清「从哪一档点进去」——
 * 这与 `CustomIntervalDialog.test.tsx` 那枚 `pickUnit(from, to)` 同一姿势。
 */
async function addCustomViaDialog(unitLabel: string, value: string): Promise<void> {
  await openPeriodMenu();
  await clickByRole("button", "添加自定义周期…");
  await clickByRole("button", "分钟");
  // 单位弹层与周期目录都是 `role="listbox"`，靠可达名分开（「单位」／「周期目录」）。
  const unitListbox = screen.getByRole("listbox", { name: "单位" });
  await act(async () => {
    fireEvent.click(within(unitListbox).getByRole("option", { name: unitLabel }));
  });
  await act(async () => {
    fireEvent.change(screen.getByLabelText("数值"), { target: { value } });
  });
  await clickByRole("button", "加入");
}

async function mountChart(): Promise<void> {
  // `applyPaneLayout` 从宿主高度算 pane 预算，jsdom 对未样式化的 div 报 0。
  vi.spyOn(window.HTMLElement.prototype, "clientHeight", "get").mockReturnValue(360);
  render(<ProChart />);
  await act(async () => {
    await Promise.resolve();
  });
}

beforeEach(() => {
  localStorage.clear();
  // 面板可见性住在 `sessionStorage`，jsdom 一整份文件共用一个 store（同 `ProChartTimeShare`）。
  sessionStorage.clear();
  h.periods = [];
  h.requests = [];
  h.loader = null;
  h.ticker = "600519.SH";
});

describe("D 组：加入自定义档的闭环", () => {
  it("D-1 加入后目录出现新行，且它就是当前周期，取数问的是那一条折叠档", async () => {
    seedSession({ symbol: "600519.SH", interval: "1D" });
    await mountChart();
    await addCustomViaDialog("小时", "2");
    // 对话框关掉了；目录也关着（入口那一次点击就把目录关了）。重开看那一行。
    await openPeriodMenu();
    const row = optionOf("2小时");
    expect(row.getAttribute("aria-selected")).toBe("true");
    expect(screen.queryByRole("dialog")).toBeNull();
    // 当前周期是它 ⇒ 入口按钮的可达名逐字等于那一行的可达名（TV-CI-02 页面级那一半）。
    expect(periodTrigger().textContent).toBe("2小时");
    expect(row.textContent).toBe(periodTrigger().textContent);
    // 取数那一腿：折叠档的拼写就是它自己，不是被压回内置八档。
    expect(h.requests.at(-1)).toMatchObject({ interval: "120m" });
    expect(h.periods.at(-1)).toEqual({ type: "minute", span: 120 });
  });

  it("D-2 坏串不进目录，当前周期退到日线", async () => {
    seedSession({ symbol: "600519.SH", interval: "2d", customIntervals: ["2d"] });
    await mountChart();
    await openPeriodMenu();
    expect(periodTrigger().textContent).toBe("日线");
    expect(screen.queryByRole("option", { name: "2d" })).toBeNull();
    expect(screen.getAllByRole("option").map((o) => o.textContent)).not.toContain("2d");
  });

  it("D-3 内置档路径零变化：默认态目录恰八行，名字逐字等于 INTERVALS 的 label", async () => {
    seedSession({ symbol: "600519.SH", interval: "1D" });
    await mountChart();
    await openPeriodMenu();
    const rows = screen.getAllByRole("option");
    expect(rows).toHaveLength(8);
    expect(rows.map((row) => row.textContent)).toEqual(INTERVALS.map((item) => item.label));
  });

  it("D-4 自定义档开着时分时按钮 disabled，且 title 指名服务端那条拒绝", async () => {
    seedSession({ symbol: "600519.SH", interval: "1D", customIntervals: ["120m"] });
    await mountChart();
    await openPeriodMenu();
    await clickByRole("option", "2小时");
    const line = screen.getByRole("button", { name: "分时" }) as HTMLButtonElement;
    expect(line.disabled).toBe(true);
    const title = line.getAttribute("title") ?? "";
    expect(title).toContain("分时不能与折叠档同时");
    // 「服务端会拒绝」这句话必须说的是 session=latest 那一条，不是含糊的「不支持」。
    expect(title).toContain("服务端会拒绝 session=latest");
    expect(title).not.toContain("不支持");
    // 点击面之外也不许有第二套真相：按下去既不取分时数据、也不进分时态。
    const before = h.requests.length;
    await act(async () => {
      fireEvent.click(line);
    });
    expect(h.requests.length).toBe(before);
    expect(latestAsks()).toBe(0);
  });

  it("D-5 按移除摘掉的不是当前档：目录少一行、当前周期不动、一次新的取数也不发", async () => {
    seedSession({ symbol: "600519.SH", interval: "1D", customIntervals: ["2W"] });
    await mountChart();
    const before = h.requests.length;
    await openPeriodMenu();
    expect(optionOf("2周")).toBeTruthy();
    await clickByRole("button", "移除 2周");
    expect(h.requests.length).toBe(before);
    expect(periodTrigger().textContent).toBe("日线");
    // 移除是「就地改清单」，不是「换一层浮层」：目录保持开着，那一行消失。
    expect(screen.queryByRole("option", { name: "2周" })).toBeNull();
    expect(screen.getAllByRole("option")).toHaveLength(8);
  });

  it("D-6 按移除摘掉的正是当前档：当前周期回到 1D，且重取一次数", async () => {
    // 走真路：先把那一档点成当前周期，再摘掉它。会话里直接躺着 `120m` 那种挂法只测得到
    // 「挂载时那一次」，测不到目录里那枚 `onRemove` 是不是还认得**当下**的档位——它住在
    // `periodOptions` 那枚 `useMemo` 的闭包里，而依赖只有 `[symbol, customIntervals]`。
    seedSession({ symbol: "600519.SH", interval: "1D", customIntervals: ["120m"] });
    await mountChart();
    await openPeriodMenu();
    await clickByRole("option", "2小时");
    expect(periodTrigger().textContent).toBe("2小时");
    // 选完一档，目录自己收起来（`PeriodPicker` 的 `onPick` 就关浮层），所以要重开再摘。
    await openPeriodMenu();
    const before = h.requests.length;
    await clickByRole("button", "移除 2小时");
    expect(h.requests.length).toBeGreaterThan(before);
    expect(periodTrigger().textContent).toBe("日线");
    expect(readSession().interval).toBe("1D");
    expect(storedSession().customIntervals).toEqual([]);
  });

  it("D-7 会话往返：加入的档落进 payload，用这坨 payload 重新挂载 ⇒ 目录里有那一行", async () => {
    seedSession({ symbol: "600519.SH", interval: "1D" });
    await mountChart();
    await addCustomViaDialog("周", "2");
    const payload = storedSession();
    expect(payload.customIntervals).toEqual(["2W"]);
    const restored = readSession();
    expect(restored.customIntervals).toEqual(["2W"]);
    expect(restored.interval).toBe("2W");
    // 真的重新挂载，而不是在同一棵树上继续看那行——往返的另一半必须由 mount 完成。
    cleanup();
    await mountChart();
    await openPeriodMenu();
    const row = optionOf("2周");
    expect(row.getAttribute("aria-selected")).toBe("true");
    expect(periodTrigger().textContent).toBe("2周");
    expect(h.requests.at(-1)).toMatchObject({ interval: "2W" });
  });

  it("D-8 摘掉非当前档也要重写会话：payload 里那一串得跟着消失（预检 ②）", async () => {
    seedSession({ symbol: "600519.SH", interval: "1D", customIntervals: ["2W", "3W"] });
    await mountChart();
    expect(storedSession().customIntervals).toEqual(["2W", "3W"]);
    await openPeriodMenu();
    await clickByRole("button", "移除 2周");
    expect(storedSession().customIntervals).toEqual(["3W"]);
  });

  it("D-9 会话里躺着折叠档＋分时时，恢复出来分时是关的、档位仍是那一档（预检 ⑥）", async () => {
    seedSession({ symbol: "600519.SH", interval: "120m", timeShare: true, customIntervals: ["120m"] });
    await mountChart();
    // 分时没有被恢复：互斥门在共享谓词 `viewForSymbol` 里，不在按钮上。
    expect(readSession().timeShare).toBe(false);
    expect(readSession().interval).toBe("120m");
    expect(latestAsks()).toBe(0);
    const line = screen.getByRole("button", { name: "分时" }) as HTMLButtonElement;
    expect(line.disabled).toBe(true);
    await openPeriodMenu();
    expect(optionOf("2小时").getAttribute("aria-selected")).toBe("true");
  });

  it("D-10 目录开着时点入口：同一趟之后对话框是开的，按一次 Escape 只关对话框且焦点回周期按钮（预检 ⑧）", async () => {
    seedSession({ symbol: "600519.SH", interval: "1D" });
    await mountChart();
    await openPeriodMenu();
    expect(screen.getByRole("listbox", { name: "周期目录" })).toBeTruthy();
    await clickByRole("button", "添加自定义周期…");
    // 不是「开了又被目录那枚外点监听在同一趟里关掉」：对话框在树上，目录已经不在。
    expect(screen.getByRole("dialog", { name: "添加自定义周期" })).toBeTruthy();
    expect(screen.queryByRole("listbox", { name: "周期目录" })).toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(periodTrigger());
  });
});
