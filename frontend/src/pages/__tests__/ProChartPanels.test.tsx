import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
 *
 * T3 再补两件：四个打开动作对 URL 的净变化为零（`forensics/gap-matrix.md` TV-CI-06
 * 缺的就是「没有任何测试针钉这件事」），以及 `?s=` 分享链接对盘上初值的优先权 —— 后者
 * 是唯一一条由 URL 反向驱动面板的路径，写点必须比读点晚一步。
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
    // the restore path needs `lastBarTimestamp(bars)` (`ProChart.tsx:1468`) —
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
    // The page clears a chart with `chart.removeOverlay()` (`:1461`), so the
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
  // The real mask lives at `IndicatorEditor.tsx:306`; its contents are out of scope here.
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
  // Same reasoning one layer up for the URL (T3): the 净变化为零 pin below compares
  // `window.location.href` before/after a click, and a comparison of two *dirty*
  // URLs is an identity that can never go red. jsdom shares one history across the
  // file too, so every case starts from a known-clean address. Fixed at the face
  // (this hook), not at the observed red — same ruling as the sessionStorage line
  // above (评审 F3, `89b49e9a`).
  window.history.replaceState({}, "", "/");
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

  // 四枚开关各点一次。评审 F4：原来这一格是一枚 `it` 里的 `for`，第一枚坏掉就把剩下三枚
  // 一起带走，红法只说「某一枚不对」。按 `it.each` 拆开，覆盖面不变，一圈一个断言，
  // 标题直接报出是哪一枚。每一圈都是新会话（文件级 `beforeEach` 清 `sessionStorage`，
  // `mountWithOneDrawing` 先 `cleanup()`），所以「逐枚只含自己的键」这句话仍然算数。
  // 工作台那枚没有 `aria-label`，可达名来自文本（接线后现读 ProChart.tsx:2972-2979），
  // 所以那一格的 `name` 给的是正则。评审 F2：四枚都读 `aria-pressed`，包括它。
  const fourSwitches: Array<[string | RegExp, string]> = [
    ["副图指标", "subIndicator"],
    ["图例", "legend"],
    ["画线清单", "drawings"],
    [/指标公式/, "workbench"],
  ];

  it.each(fourSwitches)(
    "只点「%s」这一枚 ⇒ 盘上只含自己的键「%s」，且这一枚自己报 pressed=true",
    async (name, field) => {
      await mountWithOneDrawing();
      fireEvent.click(screen.getByRole("button", { name }));
      expect(stored()).toEqual({ [field]: true });
      expect(screen.getByRole("button", { name }).getAttribute("aria-pressed")).toBe("true");
    },
  );

  // 评审 F5：偏差集是**整份重写**，所以上面那一组每圈都必须从干净会话挂载 —— 它们因此
  // 证不到「同一次会话里第二枚开的时候，第一枚那格字段还在」。这一根补的就是那一面。
  it("同一会话里连开两枚 ⇒ 第二枚写盘时第一枚的字段还在", async () => {
    await mountWithOneDrawing();
    fireEvent.click(screen.getByRole("button", { name: "副图指标" }));
    fireEvent.click(screen.getByRole("button", { name: "图例" }));
    expect(stored()).toEqual({ subIndicator: true, legend: true });
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
    // 评审 F2：spec §5(2) 那句「带着这条会话记录重新挂载 ⇒ 四枚开关都读得到 aria-pressed=true」
    // 的第四枚。这一格读的是**页面**（`ProChart.tsx:2972-2979` 那枚入口按钮自报 pressed），
    // 不是替身 —— 下面那行 `mock-close-workbench` 因此不再是工作台唯一的证据。
    expect(screen.getByRole("button", { name: /指标公式/ }).getAttribute("aria-pressed")).toBe("true");
    expect(stored()).toEqual({ workbench: true, subIndicator: true, drawings: true, legend: true });
    // 读侧不脏写：整份值原样还在。
    // 评审 F1：这一格原来写的是 `expect(screen.getByRole(…)).toBeTruthy()` —— 那枚按钮
    // 在任何状态下都渲染，所以那一行永远不会红。改成逐字钉它的 `title`（仓内同型钉法见
    // `ProChartCompare.test.tsx:465`、`ProChartDrawings.test.tsx:1657`），判据还是
    // 「这枚入口在场」，但现在文案一改就红 ⇒ 可失败。
    expect(screen.getByRole("button", { name: /指标公式/ }).getAttribute("title")).toBe(
      "编写/管理自定义指标公式（保存在本地）",
    );
    // 保留：`IndicatorEditor` 替身只在 `open` 为真时渲染那枚关闭按钮 ⇒ 这一行判的是
    // 「遮罩首屏真的挂上了」，与 pressed（按钮自陈状态）是两件不同的事。
    expect(screen.getByRole("button", { name: "mock-close-workbench" })).toBeTruthy();
  });

  it("坏值 ⇒ 首屏不开任何面板，且那枚键被合成点删掉（自愈，不是意外）", async () => {
    sessionStorage.setItem(PANELS_KEY, '{"drawings":"yes"}');
    await mountWithOneDrawing();
    expect(screen.getByRole("button", { name: "画线清单" }).getAttribute("aria-pressed")).toBe("false");
    expect(sessionStorage.getItem(PANELS_KEY)).toBeNull();
  });
});

/**
 * TV-CI-06 的驱动缺口（T3 第一根针）。
 *
 * 矩阵那一行判 `部分` 的**唯一**理由不是「本仓会改 URL」——它不会（那一行的现读记录
 * 是 `grep -n -e useNavigate -e "navigate(" -e pushState ProChart.tsx` ＝ 0 命中）——
 * 而是「这是顺带结果，不是被断言的性质」。下面四格把那个 0 命中变成会红的东西：
 * 每格开一次、关一次，两个方向都逐字比 `window.location.href`。
 *
 * 每格带两枚动作（评审 修复轮 F2「让形状追上声明」，不是把注释改口）：`openName` 打开、
 * `closeName` 关回去；`aria-pressed` 一律从 `openName` 读，四枚入口都自报状态（现读
 * `:2986` subPanelOpen／`:3134` legendPanelOpen／`:3077` drawPanelOpen／`:2974` indPanelOpen）。
 * 前三格 `closeName === openName` —— 那三枚是真翻转（现读 `ProChart.tsx:2990`
 * `setSubPanelOpen((v) => !v)`、`:3136` `setLegendPanelOpen((v) => !v)`、`toggleDrawPanel`
 * `:2416-2419` `setDrawPanelOpen((open) => !open)`）。
 * **第四格的关闭为什么必须借替身 handle**：页面那枚入口按钮的 `onClick` 是
 * `openFormulaPanel`（现读 `ProChart.tsx:821-824`），体内只有 `setFormulaError(null);` ＋
 * `:823 setIndPanelOpen(true);` —— 单向打开、没有关闭分支，所以点第二次什么都没关，
 * 唯一能把工作台关回去的可达点是遮罩 `onClose`（现读 `:3505`），它在替身里就是那枚
 * `mock-close-workbench`（本文件 `:143-149`）。上一版四格都点同一枚按钮两次、注释却写
 * 「开一次、关一次」，对第四格是不实的声明，本轮改的是针的形状而不是那句注释。
 *
 * 每格还读 `aria-pressed` 开→true、关→false（评审 修复轮 F3）：只比 URL 的话，一次静默的
 * 空点击也照样绿（「the URL is unchanged」恒成立），而这根针什么也没测。
 *
 * 这四格在实现之前就是绿的，这是本任务如实要记的形状；判别力由变异自证补上——
 * Task 3 那席往 `toggleDrawPanel` 塞一行 `replaceState` ⇒ 「画线清单」红；本轮 修复轮 1
 * 往 `ProChart.tsx:2990` 之后塞一行 `replaceState` ⇒ 「副图指标」红（两枚不同格，各证一次本体）。
 * 注意本仓确实有写 URL 的动作，但它不在这四格里：`stripQueryKey`（`ProChart.tsx:462`，
 * 写点 `:468`）只在 `?s=`／`?d=` 在场时才落笔，盘上没有那两个参数时它 `:465` 早退。
 */
const fourOpenActions: Array<[string, string | RegExp, string | RegExp]> = [
  ["副图指标", "副图指标", "副图指标"],
  ["图例", "图例", "图例"],
  ["画线清单", "画线清单", "画线清单"],
  // 工作台那枚入口没有 `aria-label`，可达名来自文本（现读 ProChart.tsx:2972-2979），
  // 所以给正则 —— 和上面四枚开关那组同判据。关闭动作换成替身 handle，理由见上面那段。
  ["指标公式工作台", /指标公式/, "mock-close-workbench"],
];

describe("/pro-chart 四个打开动作对 URL 的净变化为零（TV-CI-06 的针）", () => {
  it.each(fourOpenActions)(
    "%s：开一次、关一次，两次都逐字比 window.location.href，且 aria-pressed 跟着开→关走",
    async (_label, openName, closeName) => {
      await mountWithOneDrawing();
      const before = window.location.href;
      // 第一圈：打开。URL 不许留痕迹，且这一下必须真的把面板打开了（pressed=true）。
      fireEvent.click(screen.getByRole("button", { name: openName }));
      await flush();
      expect(window.location.href).toBe(before);
      expect(screen.getByRole("button", { name: openName }).getAttribute("aria-pressed")).toBe("true");
      // 第二圈：关回去。前三格点同一枚真翻转，第四格点替身那枚 handle（入口按钮单向打开）。
      fireEvent.click(screen.getByRole("button", { name: closeName }));
      await flush();
      expect(window.location.href).toBe(before);
      expect(screen.getByRole("button", { name: openName }).getAttribute("aria-pressed")).toBe("false");
    },
  );
});

/**
 * `?s=` 分享链接优先（T3 第二根针）。
 *
 * 链接是在**模块作用域**被捕获的（`ProChart.tsx:444` `let pendingShare = readShareQuery();`），
 * 所以必须先换 `window.location` 再 `vi.resetModules()` ＋ 动态 `import("../ProChart")` ——
 * 和 `ProChartDrawings.test.tsx:1731-1769` 那根 `?d=` 针同一配方。
 *
 * 预置的是 `{"workbench":false}`。按 `chartPanels.ts:37-44` 的严格读取，`false` 本来也读成关，
 * 所以这根针钉的不是「真赢过假」，而是**挂载时初值来自盘、随后被链接的 `setIndPanelOpen(true)`
 * （`:1687`）覆盖并回写盘**：偏差编码 ⇒ 全 false 时键被删 ⇒ 若链接没打开工作台，这里读到的是
 * `null` 而不是 `{ workbench: true }`。所以断言不许写成 `toBeNull()` 来「过」。
 */
it("?s= 分享链接打开工作台：链接优先，且这次真的写进会话键", async () => {
  // 文件级 `beforeEach` 不清 DOM，先 cleanup —— 本文件 `mountWithOneDrawing()` 的同一条约定。
  cleanup();
  sessionStorage.setItem(PANELS_KEY, JSON.stringify({ workbench: false }));
  // `?s=` 一侧有公开的写侧编码器（`scriptExchange.ts:233` `createShareLink(card, base)`），
  // 所以这里用真码，不用夹具。解码只在 `out.ok` 时才走到 `:1687` 那句 setIndPanelOpen(true)，
  // 故卡片必须能过 `readCard`：`code` 是非空字符串就够，dialect 缺省会由 pickDialect 推。
  const { createShareLink } = await import("@/lib/scriptExchange");
  const { url } = await createShareLink(
    { id: "pin-link", dialect: "pine", name: "链接优先针", code: 'indicator("1")', display: "pane", params: [] },
    "http://localhost:3000/pro-chart",
  );
  const search = url.slice(url.indexOf("?"));
  const real = window.location;
  // 换不掉 location 就等于这根针什么都没测 —— 按 `ProChartDrawings.test.tsx:1749-1755` 的
  // 形状把它变成一句会红的断言，而不是静默跳过。
  let redefined = true;
  try {
    Object.defineProperty(window, "location", {
      configurable: true,
      value: new URL(`http://localhost:3000${search}`),
    });
  } catch {
    redefined = false;
  }
  expect(redefined, "jsdom 不允许换掉 location：这根针必须跑在能换的环境上").toBe(true);
  vi.resetModules();
  try {
    const { ProChart: WithLink } = await import("../ProChart");
    vi.spyOn(window.HTMLElement.prototype, "clientHeight", "get").mockReturnValue(HOST_HEIGHT);
    render(<WithLink />);
    // 解码链（`scriptExchange.ts:426-475`）走的是 `DecompressionStream` + `ReadableStream`，
    // 不是微任务链：200 轮 `await Promise.resolve()` 也等不到它落地，要等的是**可变次数的事件循环圈**
    // （本机 20 趟分布读数＝1 圈 9 次／2 圈 11 次）。所以这里不数 tick，改成条件等待
    // —— 仓内既有约定，先例 `497fabae`／`a56e6ace`。
    // spec §5(2) 那句「断言工作台被打开**且**会话键被写成 `workbench:true`」是合取，原来这根针
    // 只钉了后半句 —— 存储那半句会红，「被打开」这半句没钉任何东西。判据不另造：抄本文件
    // `:242` 那根既有针用的同一个 handle —— `IndicatorEditor` 替身（`:143-149`）只在 `open`
    // 为真时渲染这枚按钮，工作台没开时这句直接超时抛 ⇒ 结构上不可能恒真。
    const workbenchHandle = await screen.findByRole("button", { name: "mock-close-workbench" });
    expect(workbenchHandle).toBeTruthy();
    // 跨 describe 取不到 Task 2 那枚 `stored()`（它声明在持久化块的作用域里），直接读键。
    // 写点（`ProChart.tsx:868-875` 的合成 `useEffect`）跟在面板状态之后，同一把条件等待的尺。
    await waitFor(() => {
      expect(JSON.parse(sessionStorage.getItem(PANELS_KEY) ?? "null")).toEqual({ workbench: true });
    });
  } finally {
    Object.defineProperty(window, "location", { configurable: true, value: real });
    vi.resetModules();
  }
});
