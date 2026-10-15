import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { PANELS_KEY } from "@/lib/chartPanels";
import { ProChart } from "../ProChart";

/**
 * /pro-chart 四枚面板开关的会话级持久化（L3 第①片 T2）。
 *
 * 规则是本仓自己的：四个开关记住「哪些是开着的」，写在一个 `sessionStorage` 键里，
 * 刷新活得住、标签页关掉就没了。L1 读数只贡献了存储**范围**这一件事 —— 那一条自己
 * 的 2026-10-14 更正写明「键名 → 行为」只是推断，值侧从没读到 —— 所以下面任何一根
 * 针都不声称复刻了对面的行为。
 *
 * 编解码在 `lib/chartPanels.ts`（T1）。这里钉的是页面这一侧的两件事：四枚初值确实
 * 从那枚键上取，以及开与关都从同一个合成写点回去 —— 包括工作台被遮罩 `onClose` 关掉、
 * 而不是被工具条那枚开关翻转掉的那条路径。
 */

const DAY = 86_400_000;
const START = 1_700_000_000_000;
const DRAWING_KEY = "pro-chart.drawings.v1"; // `chartDrawings.ts:934` 的 BUCKET_KEY
const HOST_HEIGHT = 360;

interface Bar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const h = vi.hoisted(() => ({
  list: [] as Bar[],
  // The 清单 button's `disabled` reads the drawing count, so the double has to
  // keep the book: an overlay the page never handed the library does not exist.
  overlays: [] as Array<Record<string, unknown>>,
  overlaySeq: 0,
  loader: null as null | {
    getBars: (p: {
      type: string;
      timestamp: number | null;
      period: unknown;
      symbol: { ticker: string };
      callback: (d: unknown[], m?: unknown) => void;
    }) => void | Promise<void>;
  },
}));

/** The page asks the loader for bars; here that is what puts them on the chart. */
function runLoad(): void {
  if (!h.loader) return;
  void h.loader.getBars({
    type: "init",
    timestamp: h.list.length ? h.list[0].timestamp : null,
    period: { type: "day", span: 1 },
    symbol: { ticker: "600519.SH" },
    // The callback is the only way bars reach the double's `getDataList`, and
    // the restore path needs `lastBarTimestamp(bars)` (`ProChart.tsx:1403`) —
    // a `() => []` answer would leave 清单 disabled, and every `drawings` pin
    // below would then be asserting nothing at all.
    callback: (data) => {
      h.list = data as Bar[];
    },
  });
}

vi.mock("klinecharts", () => ({
  registerIndicator: vi.fn(),
  getSupportedLocales: () => ["en-US", "zh-CN"],
  registerLocale: vi.fn(),
  dispose: vi.fn(),
  init: () => ({
    getSymbol: () => ({ ticker: "600519.SH", pricePrecision: 2, volumePrecision: 0 }),
    getDataList: () => h.list,
    getIndicators: () => [],
    getOverlays: () => h.overlays,
    getPaneOptions: () => [{ id: "candle_pane", height: 300, minHeight: 30, state: "normal" }],
    setPaneOptions: vi.fn(),
    setDataLoader: (loader: typeof h.loader) => {
      h.loader = loader;
    },
    setSymbol: () => {
      runLoad();
    },
    setPeriod: () => undefined,
    setStyles: vi.fn(),
    resize: vi.fn(),
    createIndicator: vi.fn(),
    removeIndicator: vi.fn(),
    createOverlay: vi.fn((arg: unknown) => {
      const o = {
        id: `ov_${h.overlaySeq}`,
        ...(arg as Record<string, unknown>),
        points: ((arg as { points?: unknown[] })?.points ?? [{ timestamp: START, value: 1300 }]),
        drawing: false,
        currentStep: -1,
      };
      h.overlaySeq += 1;
      h.overlays.push(o);
      return o.id;
    }),
    // The page clears a chart with `chart.removeOverlay()` (`:1396`), so the
    // double has to accept the no-argument form as well as `{ id }`.
    removeOverlay: vi.fn(({ id }: { id?: string } = {}) => {
      h.overlays = id ? h.overlays.filter((o) => o.id !== id) : [];
    }),
    overrideOverlay: vi.fn(),
    getOffsetRightDistance: () => 0,
    getBarSpace: () => ({ bar: 8, halfBar: 4, gapBar: 5, halfGapBar: 2 }),
  }),
}));

// Only the transport is faked; the bars are what the page's own paging code
// hands to the callback below (see the same choice in ProChartDrawings.test.tsx).
vi.mock("@/lib/marketApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/marketApi")>();
  return {
    ...actual,
    fetchKline: async () => ({
      bars: Array.from({ length: 200 }, (_, i): Bar => ({
        timestamp: START + i * DAY,
        open: 1300,
        high: 1310,
        low: 1290,
        close: 1305,
        volume: 52_874,
      })),
      source: "fake",
      symbol: "600519.SH",
      interval: "1D",
      ok: true,
    }),
  };
});

vi.mock("@/components/charts/WatchList", () => ({ default: () => null }));
vi.mock("@/components/charts/IndicatorEditor", () => ({
  // Only the callback contract is modelled: the page hands the workbench an
  // `onClose` that sets `indPanelOpen` false, and that path must reach storage.
  // The real mask lives at `IndicatorEditor.tsx:250`; its contents are out of scope here.
  default: ({ open, onClose }: { open: boolean; onClose: () => void }) =>
    open ? <button type="button" onClick={onClose}>mock-close-workbench</button> : null,
}));

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

beforeEach(() => {
  h.list = [];
  h.overlays = [];
  h.overlaySeq = 0;
  h.loader = null;
  localStorage.clear();
  // jsdom shares one session store across the whole file, so a pin that reads
  // "what survived the reload" has to start from an empty one (spec §5(2)).
  sessionStorage.clear();
  document.documentElement.classList.remove("dark");
});

/** 一条恢复出来的画线 ⇒ `清单` 按钮不再 disabled（spec §5(2) 的前置）。 */
async function mountWithOneDrawing(): Promise<void> {
  // One call = one clean session: tear the previous mount down first, or the
  // panels it left open would ride along into this mount's write.
  cleanup();
  localStorage.setItem(
    DRAWING_KEY,
    JSON.stringify({
      "600519.SH|1D": [{ name: "priceLine", paneId: "candle_pane", points: [{ timestamp: START, value: 1300 }] }],
    }),
  );
  vi.spyOn(window.HTMLElement.prototype, "clientHeight", "get").mockReturnValue(HOST_HEIGHT);
  render(<ProChart />);
  await flush();
}

it("前置：有一条恢复的画线时清单按钮可点", async () => {
  await mountWithOneDrawing();
  const btn = screen.getByRole("button", { name: "画线清单" }) as HTMLButtonElement;
  expect(btn.disabled).toBe(false);
});

describe("/pro-chart 面板开关的会话级持久化", () => {
  const stored = (): Record<string, unknown> => JSON.parse(sessionStorage.getItem(PANELS_KEY) ?? "null");

  it("未动过任何开关 ⇒ 会话键根本不存在（偏差编码，默认不落盘）", async () => {
    await mountWithOneDrawing();
    expect(sessionStorage.getItem(PANELS_KEY)).toBeNull();
  });

  it("四枚开关各点一次，盘上逐枚只含自己的键", async () => {
    const cases: Array<[string, string]> = [
      ["副图指标", "subIndicator"],
      ["图例", "legend"],
      ["画线清单", "drawings"],
    ];
    for (const [name, field] of cases) {
      sessionStorage.clear();
      await mountWithOneDrawing();
      fireEvent.click(screen.getByRole("button", { name }));
      expect(stored()).toEqual({ [field]: true });
      expect(screen.getByRole("button", { name }).getAttribute("aria-pressed")).toBe("true");
    }
    // 工作台那枚没有 aria-label，可达名来自文本（接线后现读 ProChart.tsx:2765-2771）
    sessionStorage.clear();
    await mountWithOneDrawing();
    fireEvent.click(screen.getByRole("button", { name: /指标公式/ }));
    expect(stored()).toEqual({ workbench: true });
  });

  it("经遮罩 onClose 关掉工作台也会写盘 ⇒ 键回到不存在", async () => {
    await mountWithOneDrawing();
    fireEvent.click(screen.getByRole("button", { name: /指标公式/ }));
    expect(stored()).toEqual({ workbench: true });
    fireEvent.click(screen.getByRole("button", { name: "mock-close-workbench" }));
    expect(sessionStorage.getItem(PANELS_KEY)).toBeNull();
  });

  it("预置会话键 ⇒ 四枚开关首屏就 aria-pressed=true（活过一次刷新）", async () => {
    sessionStorage.setItem(PANELS_KEY, JSON.stringify({ workbench: true, subIndicator: true, drawings: true, legend: true }));
    vi.spyOn(window.HTMLElement.prototype, "clientHeight", "get").mockReturnValue(HOST_HEIGHT);
    render(<ProChart />);
    await flush();
    expect(screen.getByRole("button", { name: "副图指标" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "图例" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "画线清单" }).getAttribute("aria-pressed")).toBe("true");
    expect(stored()).toEqual({ workbench: true, subIndicator: true, drawings: true, legend: true });
    // 读侧不脏写：整份值原样还在
    expect(screen.getByRole("button", { name: /指标公式/ })).toBeTruthy();
    // 工作台那枚入口没有 `aria-pressed`（`ProChart.tsx:2765-2771` 是动作按钮，不是开关），
    // 所以 spec §5(2)「四枚都读得到」在这一枚上只能经替身读：`IndicatorEditor` 只在
    // `open` 为真时渲染那枚关闭按钮 ⇒ 首屏就有它，才是「会话记录活过一次刷新」。
    expect(screen.getByRole("button", { name: "mock-close-workbench" })).toBeTruthy();
  });

  it("坏值 ⇒ 首屏不开任何面板，且那枚键被合成点删掉（自愈，不是意外）", async () => {
    sessionStorage.setItem(PANELS_KEY, '{"drawings":"yes"}');
    await mountWithOneDrawing();
    expect(screen.getByRole("button", { name: "画线清单" }).getAttribute("aria-pressed")).toBe("false");
    expect(sessionStorage.getItem(PANELS_KEY)).toBeNull();
  });
});
