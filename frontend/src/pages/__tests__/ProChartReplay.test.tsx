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
  // A parked response: `getBars` has been called, `callback` has not. That is the shape of
  // "the user clicked 回放 while a page was still on the wire" — no other test parks one, so
  // the mount paging in this file has always settled before entry.
  gate: null as null | Promise<void>,
  // Bars the fake backend knows about *beyond* ALL_BARS. A `backward` request asks with
  // `before = null` (klinePaging's `pagingBefore`), so this is what it gets back: a block
  // newer than everything on screen, which `_addData` case `backward` appends (dist 13464).
  newer: 0,
  // A symbol the backend answers with zero bars: the blank chart spec §7 also covers.
  blank: false,
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
      // Two knobs for the races and the blank chart (see `h`); both are off by default, so
      // every other test in this file walks exactly the path it walked before.
      if (h.gate) await h.gate;
      const before = params.before ?? null;
      const universe =
        h.newer > 0
          ? [
              ...ALL_BARS,
              ...Array.from({ length: h.newer }, (_, i) => ({
                timestamp: START + (TOTAL + i) * DAY,
                open: 1,
                high: 1,
                low: 1,
                close: 1,
                volume: 1,
              })),
            ]
          : ALL_BARS;
      const pool = before === null ? universe : universe.filter((b) => b.timestamp < before);
      const bars = h.blank ? [] : pool.slice(-(params.count ?? PAGE));
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

/** The page's own `callback` deliveries for the two paging directions. */
const directional = (): Answer[] => h.answers.filter((a) => a.type === "forward" || a.type === "backward");

/** Lets every parked microtask (and the `callback` at the end of it) run to completion. */
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));
  });
}

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
  h.gate = null;
  h.newer = 0;
  h.blank = false;
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

  // spec §5's invariant has a second way to break that no test here covered: the *answer* to a
  // paging request the page issued before 回放 can land after entry, because the closure that
  // asked was built with the pre-replay list in mind. `_addData` appends a `backward` answer
  // (dist 13464) — bars newer than the snapshot, onto the list entry just truncated.
  it("进入回放时还有一页在飞：它落不进回放窗口，且必须被答掉", async () => {
    render(<ProChart />);
    // Only the mount's `init` pages land; the chart is deliberately NOT settled to the end of
    // the fake universe, so a `forward` ask still has a real 500-bar page to bring back.
    await flush();
    expect(h.list.length).toBe(500);
    expect(h.inFlight).toBe(0);

    let release!: () => void;
    h.gate = new Promise<void>((r) => {
      release = r;
    });
    h.newer = 20; // the backward page comes back with 20 bars nobody has ever seen
    await act(async () => {
      ask("forward");
      ask("backward");
    });
    expect(h.inFlight).toBe(2);
    expect(directional().length).toBe(0); // both still on the wire

    const cache = visible();
    await click("回放");
    const entered = visible();
    expect(entered.length).toBeGreaterThan(0);

    await act(async () => {
      release();
      h.gate = null;
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });

    const dayEnd = readoutDayEnd();
    // §5's invariant: after both parked pages were delivered, the list is still exactly the
    // prefix of the cache the cursor allows — not one bar more.
    expect(visible()).toEqual(cache.filter((ts) => ts <= dayEnd));
    // Said plainer: none of the 20 bars newer than the snapshot reached a chart reading 回放中.
    expect(h.list.some((b) => b.timestamp > dayEnd)).toBe(false);
    // Both pages were ANSWERED, with 0 bars and both flags dead. The callback may not be
    // skipped — the library clears `_loading` inside it (dist 13616), so swallowing it wedges
    // the chart. That is why this counts deliveries, not blocks.
    const late = directional();
    expect(late.map((a) => a.type).sort()).toEqual(["backward", "forward"]);
    for (const a of late) {
      expect(a.bars).toBe(0);
      expect({ forward: a.forward, backward: a.backward }).toEqual({ forward: false, backward: false });
    }
    expect(h.inFlight).toBe(0);
    // And replay itself still works: one more step, the invariant still holds.
    await click("后一根");
    expect(visible()).toEqual(cache.filter((ts) => ts <= readoutDayEnd()));
  });

  // The same race one type over: the case the test above left unproved is `init`, because for
  // `init` an empty answer is not "nothing new" — `_addData` case `init` does
  // `_clearData(); this._dataList = data` (dist 13455-13456) and `_clearData` empties the list
  // (dist 14574-14578), so an `[]` here *clears the store*. It is on the wire for real: 换周期
  // asks an `init` of its own (`setView` → `setPeriod` → `resetData`, which clears `_loading` and
  // re-asks, dist 13652-13656), and 回放 stays clickable throughout because `barCount` still
  // holds the outgoing view's count. spec §6's table says what the answer has to be.
  it("换周期那一问的 init 在回放中落地：它答窗口，不许答清空", async () => {
    render(<ProChart />);
    await flush();
    expect(h.list.length).toBe(500); // the mount's `init` landed; paging deliberately not settled
    expect(h.inFlight).toBe(0);
    h.answers = []; // recorders start at the switch, same convention as `mountLoaded`

    let release!: () => void;
    h.gate = new Promise<void>((r) => {
      release = r;
    });
    h.newer = 20; // the incoming view answers with bars newer than anything on screen
    const reqs = h.requests.length;
    await click("60分"); // setView → dropReplay (idle no-op) + setPeriod → one `init` on the wire
    expect(h.inFlight).toBe(1);
    expect(h.answers.length).toBe(0); // it really is still on the wire, not answered early

    const cache = visible(); // what `enterReplay` snapshots: the outgoing view, unchanged
    await click("回放");
    const dayEnd = readoutDayEnd();
    const win = cache.filter((ts) => ts <= dayEnd);
    expect(win.length).toBeGreaterThan(0);
    expect(visible()).toEqual(win); // entry drew the window out of the snapshot, cost no request

    await act(async () => {
      release();
      h.gate = null;
      await new Promise((r) => setTimeout(r, 0));
      await new Promise((r) => setTimeout(r, 0));
    });

    // The parked request really did leave the page, so the branch below is the delivery-time one
    // and not the gate at the top of `getBars`.
    expect(h.requests.length).toBe(reqs + 1);
    expect(h.requests[h.requests.length - 1].type).toBe("init");
    // §5's invariant at the instant that answer lands: the store still holds exactly the prefix
    // the cursor allows — not `[]`, and not the incoming view's 500 bars either.
    expect(visible()).toEqual(win);
    expect(h.list.some((b) => b.timestamp > dayEnd)).toBe(false);
    // Both `init`s were ANSWERED with the window and both flags dead. The callback may not be
    // skipped (dist 13616-13617 clears `_loading` inside it), so this counts deliveries.
    const inits = h.answers.filter((a) => a.type === "init");
    expect(inits.length).toBe(2); // entry's own `resetData()`, plus this parked one
    for (const a of inits) {
      expect(a.bars).toBe(win.length);
      expect({ forward: a.forward, backward: a.backward }).toEqual({ forward: false, backward: false });
    }
    expect(h.inFlight).toBe(0);
    // And replay still works from there.
    await click("后一根");
    expect(visible()).toEqual(cache.filter((ts) => ts <= readoutDayEnd()));
    expect(h.requests.length).toBe(reqs + 1); // still: replay itself issued nothing
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
    const cache = visible();
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
    // The exit moment, in the form the invariant is written in everywhere else: at exit
    // `cursorTs` is null, so `replayWindow(cache, cursorTs)` is the whole cache and the
    // assertion is equality *by content*, not by length — a handback that is the right number of
    // bars in the wrong order, or with the wrong bars in it, satisfies a length and breaks §5.
    expect(cache.length).toBe(TOTAL);
    expect(visible()).toEqual(cache);
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

  // spec §7's other entry condition. A lit button whose handler only `return`s is a silent
  // no-op on a blank chart (backend down, or a symbol with no bars), and jsdom — like the
  // browser — fires nothing on a `disabled` button, so this affordance IS the only way the
  // guard can be observed: `click()` on it would have passed either way.
  it("空表进不去：两颗入口按钮 disabled、原因写在 title", async () => {
    h.blank = true;
    render(<ProChart />);
    await settle();
    expect(h.list.length).toBe(0); // the backend answered, it just had nothing
    for (const name of ["回放", "从视图右端开始"]) {
      const btn = buttonOf(name);
      expect(btn).toBeDisabled();
      expect(btn.getAttribute("title")).toContain("图上还没有数据");
    }
    expect(screen.queryByTestId("replay-readout")).toBeNull();
  });

  // The other half of the same gate: `barCount` is written by the answer that *replaces* the
  // list, never by a paging answer. A universe of exactly 4 pages makes `settle` end on an
  // EMPTY closing page (klinePaging: `fresh.length >= pageSize` is what stops it), so a page
  // length written there would put 0 on screen and snuff the button out on a full chart.
  it("翻页只加 bar：收尾那一页交回 0 根，也不该把入口按钮按灭", async () => {
    h.newer = 800; // 2000 根 = 4 × PAGE
    render(<ProChart />);
    await settle();
    expect(h.list.length).toBe(TOTAL + 800);
    // Non-vacuity: the closing paging answer really was the empty one.
    expect(h.answers.filter((a) => a.type === "forward" && a.bars === 0).length).toBe(1);
    for (const name of ["回放", "从视图右端开始"]) {
      expect(buttonOf(name)).not.toBeDisabled();
    }
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
