import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProChart } from "../ProChart";

/**
 * Bar Replay's data path, driven through the real /pro-chart component (spec §11).
 *
 * Two things make this more than a rendering check:
 *
 * - The chart double re-implements `StoreImp._addData` and `resetData` faithfully, so
 *   `resetData()` really re-fires an `init` getBars (dist 13652 -> 13621). A double that only
 *   stored the array would let a replay that never repaints the chart pass.
 * - Every assertion is read from outside the page: the toolbar's printed date, and the
 *   recorder on the mock. The cursor is not "whatever the component says it is" — it is the
 *   calendar day the readout shows, and the loaded range is whatever `fetchKline` was asked
 *   for. That is what stops the invariant check from being the same function checking itself.
 */

const DAY = 86_400_000;
// Midnight UTC, so bar N is exactly START + N days in any CI timezone.
const START = Date.UTC(2020, 0, 1);
const PAGE = 500;
const TOTAL = 1200;
// Where DEFAULT_REPLAY_BACK = 250 lands: index 949, 950 bars on screen.
const ENTRY_LEN = TOTAL - 250;

interface Bar {
  timestamp: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const ALL_BARS: Bar[] = Array.from({ length: TOTAL }, (_, i) => ({
  timestamp: START + i * DAY,
  open: 1,
  high: 1,
  low: 1,
  close: 1,
  volume: 1,
}));

interface Answer {
  type: string;
  bars: number;
  forward: boolean;
  backward: boolean;
}

const h = vi.hoisted(() => ({
  list: [] as Array<{ timestamp: number }>,
  more: { forward: false, backward: false },
  // Every fetchKline the page made. "Length frozen" == "replay issued no request".
  requests: [] as Array<{ type: string; before: string | null }>,
  // Every callback the page handed back, whatever direction it was asked for.
  answers: [] as Answer[],
  overlays: [] as Array<Record<string, unknown>>,
  overrides: [] as Array<{ id?: string; visible?: boolean }>,
  inFlight: 0,
  askedType: "",
  // getVisibleRange().to, set per test to drive "start from the view edge".
  visibleTo: 0,
  loader: null as null | {
    getBars: (p: {
      type: string;
      timestamp: number | null;
      period: { type: string; span: number };
      symbol: { ticker: string };
      callback: (data: unknown[], more?: unknown) => void;
    }) => void | Promise<void>;
  },
}));

/** `StoreImp._addData`, the same three cases `ProChartPaging.test.tsx` models. */
function addData(data: unknown[], type: string, more: unknown): void {
  const real = { forward: false, backward: false };
  if (typeof more === "boolean") {
    real.forward = more;
    real.backward = more;
  } else if (more && typeof more === "object") {
    const m = more as { forward?: boolean; backward?: boolean };
    real.forward = m.forward ?? false;
    real.backward = m.backward ?? false;
  }
  const bars = data as Array<{ timestamp: number }>;
  if (type === "init") h.list = bars;
  else if (type === "forward") h.list = [...bars, ...h.list];
  else if (type === "backward") h.list = [...h.list, ...bars];
  if (type !== "backward") h.more.forward = real.forward;
  if (type !== "forward") h.more.backward = real.backward;
}

/**
 * What `_processDataLoad(type)` does: take the timestamp out of the list the store already
 * has, set `_loading`, call `getBars`. The callback clears `_loading` inside the library, so
 * `inFlight` drops there too — that ordering is the race spec §6 reason 3 is about.
 */
function ask(type: "init" | "forward" | "backward"): void {
  if (!h.loader) throw new Error("页面没有装 DataLoader");
  const oldest = h.list.length ? h.list[0].timestamp : null;
  const newest = h.list.length ? h.list[h.list.length - 1].timestamp : null;
  const timestamp = type === "backward" ? newest : type === "forward" ? oldest : null;
  h.inFlight += 1;
  h.askedType = type;
  void Promise.resolve(
    h.loader.getBars({
      type,
      timestamp,
      period: { type: "day", span: 1 },
      symbol: { ticker: "600519.SH" },
      callback: (data, more) => {
        const m = (more ?? {}) as { forward?: boolean; backward?: boolean };
        h.answers.push({
          type,
          bars: data.length,
          forward: m.forward ?? false,
          backward: m.backward ?? false,
        });
        addData(data, type, more);
        h.inFlight -= 1;
      },
    }),
  ).catch(() => {
    h.inFlight -= 1;
  });
}

vi.mock("klinecharts", () => ({
  registerIndicator: vi.fn(),
  getSupportedLocales: () => ["en-US", "zh-CN"],
  registerLocale: vi.fn(),
  dispose: vi.fn(),
  init: () => ({
    getSymbol: () => ({ ticker: "600519.SH" }),
    getPeriod: () => ({ type: "day", span: 1 }),
    getDataList: () => h.list,
    setDataLoader: (loader: typeof h.loader) => {
      h.loader = loader;
    },
    // StoreImp.resetData (dist 13652) = unsubscribe, _loading = false, one `init` load.
    // Modelling it is the point: a step that forgets to re-ask has nowhere to show up.
    resetData: () => ask("init"),
    setSymbol: () => ask("init"),
    setPeriod: () => ask("init"),
    setStyles: vi.fn(),
    resize: vi.fn(),
    createIndicator: vi.fn(),
    createOverlay: vi.fn(),
    removeOverlay: vi.fn(),
    removeIndicator: vi.fn(),
    getIndicators: () => [],
    getOverlays: () => h.overlays,
    getPaneOptions: () => [],
    setPaneOptions: vi.fn(),
    getOffsetRightDistance: () => 0,
    setOffsetRightDistance: vi.fn(),
    getBarSpace: () => ({ bar: 8, halfBar: 4, gapBar: 5, halfGapBar: 2 }),
    setBarSpace: vi.fn(),
    getVisibleRange: () => ({ from: 0, to: h.visibleTo, realFrom: 0, realTo: h.visibleTo }),
    overrideOverlay: (o: { id?: string; visible?: boolean }) => {
      h.overrides.push({ id: o.id, visible: o.visible });
      return true;
    },
  }),
}));

vi.mock("@/lib/marketApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/marketApi")>();
  return {
    ...actual,
    fetchKline: async (params: { before?: number | null; count?: number }) => {
      const before = params.before ?? null;
      const pool = before === null ? ALL_BARS : ALL_BARS.filter((b) => b.timestamp < before);
      const bars = pool.slice(-(params.count ?? PAGE));
      h.requests.push({
        type: h.askedType,
        before: before === null ? null : new Date(before).toISOString().slice(0, 10),
      });
      return { bars, source: "fake", symbol: "600519.SH", interval: "1D", ok: true };
    },
  };
});

vi.mock("@/components/charts/WatchList", () => ({ default: () => null }));
vi.mock("@/components/charts/IndicatorEditor", () => ({ default: () => null }));

/** Pumps the library's edge triggers until nothing wants more data. */
async function settle(limit = 40): Promise<void> {
  for (let round = 0; round < limit; round++) {
    while (h.inFlight > 0) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 0));
      });
    }
    if (!h.more.forward && !h.more.backward) return;
    await act(async () => {
      ask(h.more.forward ? "forward" : "backward");
    });
  }
  throw new Error(`分页没有停止：已发出 ${h.requests.length} 次请求`);
}

const buttonOf = (name: string): HTMLButtonElement =>
  screen.getByRole("button", { name }) as HTMLButtonElement;

const click = async (name: string): Promise<void> => {
  await act(async () => {
    fireEvent.click(buttonOf(name));
  });
};

/** The calendar day the toolbar prints for the cursor — the outside-the-page anchor. */
function readoutDayEnd(): number {
  const text = screen.getByTestId("replay-readout").textContent ?? "";
  const m = /(\d{4}-\d{2}-\d{2})/.exec(text);
  if (!m) throw new Error(`读数里没有游标日期：${JSON.stringify(text)}`);
  // End of that UTC day: a bar stamped at any hour of its trading day falls inside it.
  return Date.parse(`${m[1]}T23:59:59.999Z`);
}

/** The prefix of the loaded range a cursor day allows, computed WITHOUT the lib helpers. */
const allowedByDay = (dayEnd: number): number[] =>
  ALL_BARS.filter((b) => b.timestamp <= dayEnd).map((b) => b.timestamp);

const visible = (): number[] => h.list.map((b) => b.timestamp);

async function mountLoaded(): Promise<void> {
  render(<ProChart />);
  await settle();
  expect(h.list.length).toBe(TOTAL); // the whole fake history is on the chart
  // Recording starts here. Reaching `TOTAL` from one 500-bar `init` *requires* the page to
  // answer real `forward` asks with real pages, and those belong to the mount, not to replay;
  // leaving them in the recorder would make "各收到一次空答" count 4 (2 mount + 2 the test
  // itself issued). Nothing is hidden: the `fetchKline` recorder below is never reset, so the
  // zero-network assertion still sees every request the page ever made.
  h.answers = [];
}

beforeEach(() => {
  h.list = [];
  h.more = { forward: false, backward: false };
  h.requests = [];
  h.answers = [];
  h.overlays = [];
  h.overrides = [];
  h.inFlight = 0;
  h.askedType = "";
  h.visibleTo = TOTAL;
  h.loader = null;
  localStorage.clear();
});

describe("/pro-chart 回放的数据通路", () => {
  it("进入回放：只留前缀，右端就是游标，读数说的是同一件事", async () => {
    await mountLoaded();
    const before = h.requests.length;
    await click("回放");

    expect(visible()).toEqual(ALL_BARS.slice(0, ENTRY_LEN).map((b) => b.timestamp));
    // The independent anchor: what the toolbar *says*, not what the list ends with.
    expect(visible()).toEqual(allowedByDay(readoutDayEnd()));
    expect(screen.getByText(`第 ${ENTRY_LEN}/${TOTAL} 根`)).toBeTruthy();
    expect(screen.getByText("剩 250 根")).toBeTruthy();
    // Entry is answered out of the snapshot, so it costs no request.
    expect(h.requests.length).toBe(before);
  });

  it("不变量：每一步 dataList 恒等于「按游标日允许的那段前缀」", async () => {
    await mountLoaded();
    await click("回放");
    for (const name of ["后一根", "后一根", "前一根", "快进 10 根", "前一根"]) {
      await click(name);
      const dayEnd = readoutDayEnd();
      const list = visible();
      expect(list).toEqual(allowedByDay(dayEnd));
      expect(list.length).toBeGreaterThan(0);
      expect(list[list.length - 1]).toBeLessThanOrEqual(dayEnd);
    }
  });

  // ~2160 clicks (955 back to the first bar, 1205 forward to the last, plus the clamped
  // no-ops), and one click costs about what a page render costs: 73s run alone, 113s when the
  // full suite runs it beside 118 other files. The vitest default 5s cannot hold it, so the
  // budget is raised — only the budget moves, the assertions are the brief's.
  it(
    "两端夹紧：到首根／末根后再步一次，游标不动也不越界",
    async () => {
      await mountLoaded();
      await click("回放");
      for (let i = 0; i < ENTRY_LEN + 5; i++) await click("前一根");
      expect(visible()).toEqual([ALL_BARS[0].timestamp]);
      expect(screen.getByText("第 1/1200 根")).toBeTruthy();

      for (let i = 0; i < TOTAL + 5; i++) await click("后一根");
      expect(visible()).toEqual(ALL_BARS.map((b) => b.timestamp));
      expect(screen.getByText("第 1200/1200 根")).toBeTruthy();
    },
    300_000,
  );

  it("回放全程零网络请求——最硬的那条（含退出后的一次性交回）", async () => {
    await mountLoaded();
    const before = h.requests.length;
    // Non-vacuity of the gate this test is the gate for: the recorder is not sitting at zero.
    // Reaching `TOTAL` from one 500-bar page takes three real `fetchKline` calls, so
    // `toBe(before)` below means "replay added none", not "nobody ever counted one".
    expect(before).toBeGreaterThan(0);
    await click("回放");
    for (let i = 0; i < 30; i++) await click("后一根");
    // The library does ask on its own, from the left-edge trigger `from === 0 && more.forward`;
    // answering it from the page is what keeps `_loading` from eating the next step.
    await act(async () => {
      ask("forward");
      ask("backward");
    });
    await click("退出回放");
    expect(h.requests.length).toBe(before);
    // And the handback put the whole loaded range back without one.
    expect(h.list.length).toBe(TOTAL);
  });

  it("forward / backward 各收到一次空答、两旗全 false（反真空通过：先数被问过几次）", async () => {
    await mountLoaded();
    await click("回放");
    await act(async () => {
      ask("forward");
      ask("backward");
    });
    const directional = h.answers.filter((a) => a.type === "forward" || a.type === "backward");
    expect(directional.length).toBe(2);
    expect(directional.filter((a) => a.type === "forward").length).toBe(1);
    expect(directional.filter((a) => a.type === "backward").length).toBe(1);
    for (const a of directional) {
      expect(a.bars).toBe(0);
      expect({ forward: a.forward, backward: a.backward }).toEqual({ forward: false, backward: false });
    }
  });

  it("init 答出去的每一根都 ≤ 游标，两旗都 false", async () => {
    await mountLoaded();
    await click("回放");
    const dayEnd = readoutDayEnd();
    const inits = h.answers.filter((a) => a.type === "init");
    expect(inits.length).toBeGreaterThan(0);
    const last = inits[inits.length - 1];
    expect(last.bars).toBeGreaterThan(0);
    expect(last.forward).toBe(false);
    expect(last.backward).toBe(false);
    expect(h.list.every((b) => b.timestamp <= dayEnd)).toBe(true);
  });

  it("「从视图右端开始」把库的可见下标折成游标", async () => {
    await mountLoaded();
    h.visibleTo = 1000;
    await click("从视图右端开始");
    expect(visible()).toEqual(allowedByDay(readoutDayEnd()));
    expect(h.list.length).toBe(1000);
  });

  it("换周期与切分时一律退出回放（cache 的数据身份变了）", async () => {
    await mountLoaded();
    await click("回放");
    expect(screen.queryByRole("button", { name: "退出回放" })).toBeTruthy();
    await click("60分");
    expect(screen.queryByRole("button", { name: "退出回放" })).toBeNull();
    // 分钟线可以回放：spec 第七节只禁分时。回放的仍是"已加载的那段分钟 bar"。
    expect(buttonOf("回放").hasAttribute("disabled")).toBe(false);
    await click("日线");
    await click("回放");
    await click("分时");
    expect(screen.queryByRole("button", { name: "退出回放" })).toBeNull();
  });

  it("分时态进不去：按钮 disabled、原因在 title、读数根本不存在", async () => {
    await mountLoaded();
    await click("分时");
    const btn = buttonOf("回放");
    expect(btn.hasAttribute("disabled")).toBe(true);
    expect(btn.getAttribute("title")).toContain("分时");
    expect(screen.queryByTestId("replay-readout")).toBeNull();
  });

  it("日期框输入的日期落回同一根（往返）", async () => {
    await mountLoaded();
    await click("回放");
    const target = ALL_BARS[500];
    const iso = new Date(target.timestamp).toISOString().slice(0, 10);
    const box = screen.getByLabelText("回放起点日期") as HTMLInputElement;
    await act(async () => {
      fireEvent.change(box, { target: { value: iso } });
      fireEvent.keyDown(box, { key: "Enter" });
    });
    expect(visible()).toEqual(allowedByDay(readoutDayEnd()));
    expect(h.list[h.list.length - 1].timestamp).toBe(target.timestamp);
  });
});
