# L3 第一片：图表面板开关的会话级持久化 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 /pro-chart 的四枚面板开关（指标工作台／副图指标选单／画线清单／图例）把「开没开」存进一枚会话级键并活过一次刷新，同时补上「这四个打开动作不改地址栏」的测试针。

**Architecture:** 一个纯模块 `frontend/src/lib/chartPanels.ts` 管读写（`sessionStorage`、偏差编码、全默认删键），`ProChart.tsx` 只在四枚 `useState` 的初值里读一次、再在**一枚** `useEffect` 合成点里写一次；分散在六七个 `set*` 调用点上的写是本片明令禁止的形状。

**Tech Stack:** React 19 ＋ TypeScript ＋ vitest（jsdom）＋ klinecharts v10（本页只用测试替身，不改库）。不加依赖。

**Spec:** `docs/superpowers/specs/2026-10-15-l3-slice1-panel-visibility-design.md`（本计划是它的论证；§2 的两条 L1 条目、§4.3 的坐标漂移裁定、§5 的七项判据都在那份里）

## Global Constraints

- 不改 `frontend/package.json`／`pyproject.toml`，不装任何依赖，不跑 `rea setup`，不注册 REA 的 MCP。
- 不动 `tools/**`、`.github/**`、`.gitignore`、`wiki/**`（上游拥有；`docs/superpowers/plans/2026-10-01-repo-wiki-m1-wiki-root.md:36`）。**T7 只读 `tools/forensics_audit.py`，不写。**
- **不碰** `frontend/src/lib/chartDrawings.ts` 与 `frontend/src/lib/__tests__/chartDrawings.test.ts`、`frontend/public/usage-guide.md`：这三枚此刻是别的席未提交的活（工作树 ` M`）。本片**读** `chartDrawings.ts` 的导出（`loadDrawings`/`drawingsBucket` 等）但不改它。
- 提交一律带 pathspec ＋ `-s`（上游 DCO），一次一个面；`docs/` 被 `.gitignore:125` 忽略，故新增文档要 `git add -f`（仓内既有 58 份 `docs/**` 跟踪件同此）。
- 前端命令的工作目录＝`frontend/`；Python 门的工作目录＝仓库根，且一律 `python -X utf8`（中文输出，GBK 会炸）。
- 判据写法：像素／活体类只写**等值关系**，不写期望常量（批次 A 口径）。文档里不写「本文件 N 行／共 X 条」这类自指读数。
- 被测面不许出现 `tradingview.com` 字样——`tools/forensics_audit.py:620-670` 对 `frontend/src` 扫这串并和主机白名单做集合等式；键名 `tradingview.toggle_delete_locked_linetools` 也不写进 `frontend/src`（它只属于取证文档）。
- 本片的规格边界（每份产出都要带上）：**scope 归属照 L1 的读数，行为面是本仓自拟**——L1 的 TV-DW-05 那一格自陈「键名↔界面行为＝推断，值面未读」。
- 未来函数自查的范围声明（spec §5(7)）：本片只动界面态，不产任何指标信号、不读任何 K 线，所以**不跑** Bar Replay 那五步。写这一句就是让下一席知道它是被裁掉的、不是被忘的。

---

### Task 1：`lib/chartPanels.ts` 纯模块 ＋ 单测

**Files:**
- Create: `frontend/src/lib/chartPanels.ts`
- Test: `frontend/src/lib/__tests__/chartPanels.test.ts`

**Interfaces:**
- Consumes: 无（新模块）
- Produces: `PanelVisibility`（四键 `workbench`/`subIndicator`/`drawings`/`legend`，全 `boolean`）、`PANELS_KEY = "pro-chart.panels.v1"`、`DEFAULT_PANEL_VISIBILITY`、`normalizePanelVisibility(raw: unknown): PanelVisibility`、`loadPanelVisibility(): PanelVisibility`、`savePanelVisibility(v: PanelVisibility): void`。Task 2 用后三个。

- [ ] **Step 1：写失败测试**（整份新建，五态照 spec §5(1)）

`frontend/src/lib/__tests__/chartPanels.test.ts`：

```ts
import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_PANEL_VISIBILITY,
  PANELS_KEY,
  type PanelVisibility,
  loadPanelVisibility,
  normalizePanelVisibility,
  savePanelVisibility,
} from "../chartPanels";

/**
 * Panel visibility (L3 第①片). The spec boundary travels with this file:
 * `docs/forensics/spec/drawings.md` TV-DW-05 only proves the counterpart's
 * visibility key name sits in its `session_storage_keys` line — the behaviour
 * (survives a reload, dies with the tab) is ours. So what is being guarded here
 * is *our* rule: one session key, deviation-only encoding, strict `=== true`.
 */

const ALL: PanelVisibility = {
  workbench: false,
  subIndicator: false,
  drawings: false,
  legend: false,
};

beforeEach(() => {
  sessionStorage.clear();
});

describe("loadPanelVisibility", () => {
  it("①键不存在 ⇒ 四枚全 false，且不等于引用同一个对象", () => {
    const a = loadPanelVisibility();
    expect(a).toEqual(ALL);
    a.drawings = true;
    expect(loadPanelVisibility().drawings).toBe(false);
  });

  it("②写一枚为真再读回 ⇒ 只有那枚真，盘上 JSON 只含该键", () => {
    savePanelVisibility({ ...ALL, drawings: true });
    expect(sessionStorage.getItem(PANELS_KEY)).toBe('{"drawings":true}');
    expect(loadPanelVisibility()).toEqual({ ...ALL, drawings: true });
  });

  it("③坏 JSON／缺键／非 true 的值一律回落默认", () => {
    sessionStorage.setItem(PANELS_KEY, "{not json");
    expect(loadPanelVisibility()).toEqual(ALL);
    sessionStorage.setItem(PANELS_KEY, '{"legend":true}');
    expect(loadPanelVisibility()).toEqual({ ...ALL, legend: true });
    for (const junk of ['{"drawings":"true"}', '{"drawings":1}', '{"drawings":{}}', '{"drawings":null}', "[]", "3"]) {
      sessionStorage.setItem(PANELS_KEY, junk);
      expect(loadPanelVisibility().drawings).toBe(false);
    }
  });

  it("④先让键存在，再写回全 false ⇒ 键被删掉", () => {
    savePanelVisibility({ ...ALL, drawings: true });
    expect(sessionStorage.getItem(PANELS_KEY)).not.toBeNull();
    savePanelVisibility(ALL);
    expect(sessionStorage.getItem(PANELS_KEY)).toBeNull();
  });

  it("⑤存储抛异常 ⇒ load 回落默认、save 不抛", () => {
    const real = Object.getOwnPropertyDescriptor(window, "sessionStorage");
    const boom = (): Storage => {
      throw new Error("storage disabled");
    };
    Object.defineProperty(window, "sessionStorage", { configurable: true, get: boom });
    try {
      expect(loadPanelVisibility()).toEqual(ALL);
      expect(() => savePanelVisibility({ ...ALL, legend: true })).not.toThrow();
    } finally {
      if (real) Object.defineProperty(window, "sessionStorage", real);
    }
    expect(loadPanelVisibility()).toEqual(ALL);
  });
});

describe("normalizePanelVisibility", () => {
  it("只认四枚已知键、只认真布尔", () => {
    expect(normalizePanelVisibility({ drawings: true, unknownKey: true })).toEqual({
      ...ALL,
      drawings: true,
    });
    expect(normalizePanelVisibility(null)).toEqual(DEFAULT_PANEL_VISIBILITY);
    expect(normalizePanelVisibility([true])).toEqual(ALL);
  });
});
```

- [ ] **Step 2：跑一次，确认它是因为「模块不存在」而红**

在 `frontend/` 下：`npx vitest run src/lib/__tests__/chartPanels.test.ts`
期望：FAIL，报错形如 `Failed to resolve import "../chartPanels"`（不是断言失败、也不是 0 个测试被收集）。

> 2026-10-15 更正（T1 实测）：括号里后半句在 vitest 4 下不可满足——套件级 import 解析失败时 stdout 必然同时印
> `❯ src/lib/__tests__/chartPanels.test.ts (0 test)` 与 `Tests  no tests`，所以「0 个测试被收集」不能当排除项用。
> 实质判据改成两半：①错误文本逐字含 `Failed to resolve import "../chartPanels"`；②`Test Files  1 failed (1)`（文件被收集且判红）。
> 两半都在 T1 那次 RED 运行里成立，留档读数见 `.superpowers/sdd/2026-10-15-l3-slice1-panel-visibility/task-1-report.md` §2。前半句照旧有效。

- [ ] **Step 3：写实现**

`frontend/src/lib/chartPanels.ts`：

```ts
/**
 * Which of the four chart-panel switches are open — one session-scoped key.
 *
 * The spec is `docs/forensics/spec/drawings.md` TV-DW-05 plus
 * `docs/forensics/spec/chart-interaction.md` TV-CI-06, and the boundary stated
 * there is load-bearing for this file: the L1 reading only puts the counterpart's
 * visibility *key name* on its `session_storage_keys` line (that entry's own
 * 2026-10-14 correction says key name → behaviour is an inference, the value side
 * was never read). So `sessionStorage` copies the *scope*, and "survives a reload,
 * resets with the tab" is this repo's own behaviour spec — not a复刻 claim.
 *
 * Encoding follows `saveLegendPrefs` (same family: a UI pref whose read side falls
 * back to defaults): only deviations are written, and an all-closed write deletes
 * the key. Writing the whole four-key snapshot would freeze today's defaults into
 * the session. `SESSION_KEY` writes unconditionally because "the symbol I was
 * last looking at" has no default to fall back to — different family.
 */

export interface PanelVisibility {
  workbench: boolean;
  subIndicator: boolean;
  drawings: boolean;
  legend: boolean;
}

export const PANELS_KEY = "pro-chart.panels.v1";

export const DEFAULT_PANEL_VISIBILITY: Readonly<PanelVisibility> = Object.freeze({
  workbench: false,
  subIndicator: false,
  drawings: false,
  legend: false,
});

const FIELDS: ReadonlyArray<keyof PanelVisibility> = ["workbench", "subIndicator", "drawings", "legend"];

/** Strict `=== true`: a hand-edited or stale value cannot open a panel nobody asked for. */
export function normalizePanelVisibility(raw: unknown): PanelVisibility {
  const next: PanelVisibility = { ...DEFAULT_PANEL_VISIBILITY };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return next;
  const o = raw as Record<string, unknown>;
  for (const f of FIELDS) next[f] = o[f] === true;
  return next;
}

export function loadPanelVisibility(): PanelVisibility {
  try {
    const raw = sessionStorage.getItem(PANELS_KEY);
    if (!raw) return { ...DEFAULT_PANEL_VISIBILITY };
    return normalizePanelVisibility(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_PANEL_VISIBILITY };
  }
}

/** Replaces the stored set rather than merging: a patch-only object would drop the other open panels. */
export function savePanelVisibility(v: PanelVisibility): void {
  try {
    const next = normalizePanelVisibility(v);
    const deviated: Partial<PanelVisibility> = {};
    for (const f of FIELDS) if (next[f]) deviated[f] = true;
    if (Object.keys(deviated).length === 0) {
      sessionStorage.removeItem(PANELS_KEY);
      return;
    }
    sessionStorage.setItem(PANELS_KEY, JSON.stringify(deviated));
  } catch {
    /* best effort: persistence is a convenience, a failed write must not throw out of a click */
  }
}
```

- [ ] **Step 4：跑测试到全绿**

`npx vitest run src/lib/__tests__/chartPanels.test.ts` → 期望 6 passed。**输出必须干净**（无 console 噪音、无 unhandled rejection）。

> 2026-10-15 更正（T1 评审收口，提交 `fe442489`）：上面 Step 1／Step 3 的两段代码有一处实现形状与一根针的判据被评审席判为不判别，已改，后续席**不许照本文旧码重抄**：
> ① `const FIELDS: ReadonlyArray<keyof PanelVisibility> = ["workbench", …]` 手抄第四份字段名单，且 `keyof` 数组不强制穷尽——将来加第五枚面板会静默地「读成默认、永不落盘」。现在派生自 `Object.keys(DEFAULT_PANEL_VISIBILITY)`，
> 而那个对象头上的 `Readonly<PanelVisibility>` 已经强制它带满四枚键。② ⑤号针末尾的 `expect(loadPanelVisibility()).toEqual(ALL)` 在「还原成功」与「getter 仍中毒」两个世界里都绿（load 自己吞异常），
> 已换成中毒世界里必红的往返针（`savePanelVisibility({ …ALL, legend: true })` 后 `getItem` 逐字等于 `'{"legend":true}'` 再读回）。判别力实测：摘掉 `try/finally` 还原块 ⇒ `Tests 2 failed | 4 passed (6)`，
> 红的两枚＝⑤本体（新针那一行）与下一枚 `normalizePanelVisibility` 针（中毒 getter 漏到它的 `beforeEach` 里）；装回还原块 ⇒ `6 passed`，`npx tsc -b` 无输出。

- [ ] **Step 5：类型门**

`npx tsc -b` → 期望无输出。

- [ ] **Step 6：提交**

```bash
cd "E:/Vibe-Trading-main/Vibe-Trading-main"
git add -f frontend/src/lib/chartPanels.ts frontend/src/lib/__tests__/chartPanels.test.ts
git commit -s -m "feat(pro-chart): lib/chartPanels.ts 会话级面板可见性（L3 第一片 T1）" -- frontend/src/lib/chartPanels.ts frontend/src/lib/__tests__/chartPanels.test.ts
```

---

### Task 2：`ProChart.tsx` 接线 ＋ 页面级存储针

**Files:**
- Modify: `frontend/src/pages/ProChart.tsx`（1 行 import ＋ 4 处同行替换 ＋ 1 枚 effect ＋ `:621` 注释措辞）
- Test: `frontend/src/pages/__tests__/ProChartPanels.test.tsx`（新建）

**Interfaces:**
- Consumes: Task 1 的 `loadPanelVisibility()`／`savePanelVisibility(v)`／`PANELS_KEY`
- Produces: 页面行为「四枚初值来自会话键、任何一次开或关都重写整枚偏差集」。Task 3 在这个测试文件里续写两根针，所以本任务交付的文件要留下可续写的 `describe`。

- [ ] **Step 1：先把测试替身搭起来，并跑一次「探针测试」确认前置成立**

新建 `frontend/src/pages/__tests__/ProChartPanels.test.tsx`。**替身不是从零写**：把 `ProChartLegend.test.tsx` 的 `vi.hoisted`＋`vi.mock("klinecharts", …)`＋`vi.mock("@/components/charts/WatchList")`＋`flush()`＋`beforeEach` 整块（该文件 `:14`–`:111`）抄过来，然后做**四处改动**：

1. `beforeEach` 里加 `sessionStorage.clear();`（spec §5(2)：jsdom 的会话存储在同一文件内跨挂载共享，不清就会让后一根针读前一根留下的值）。
2. `createOverlay` 从 `vi.fn()` 换成会记账的一枚，并让 `getOverlays` 返回那本账——清单按钮的 `disabled` 只认画线条数：

```ts
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
    getOverlays: () => h.overlays,
    removeOverlay: vi.fn(({ id }: { id?: string } = {}) => {
      h.overlays = id ? h.overlays.filter((o) => o.id !== id) : [];
    }),
```

（`h` 里相应加 `overlaySeq: 0` 与 `overlays: [] as Array<Record<string, unknown>>`，并在 `beforeEach` 里复位这两项。）
3. `vi.mock("@/components/charts/IndicatorEditor", …)` 换成**会调 `onClose` 的替身**——本片要钉的正是「非翻转的关闭路径也写盘」，替身只建模这一个回调，不建模编辑器内容：

```ts
vi.mock("@/components/charts/IndicatorEditor", () => ({
  // Only the callback contract is modelled: the page hands the workbench an
  // `onClose` that sets `indPanelOpen` false, and that path must reach storage.
  // The real mask lives at `IndicatorEditor.tsx:250`; its contents are out of scope here.
  default: ({ open, onClose }: { open: boolean; onClose: () => void }) =>
    open ? <button type="button" onClick={onClose}>mock-close-workbench</button> : null,
}));
```

4. 文件顶部把常量摆齐（值都是现读来的）：

```ts
const DAY = 86_400_000;
const START = 1_700_000_000_000;
const DRAWING_KEY = "pro-chart.drawings.v1"; // `chartDrawings.ts:934` 的 BUCKET_KEY
const HOST_HEIGHT = 360;
```

探针测试（本 Step 的验收物，跑完就把它**留成**正式的一根针）：

```tsx
/** 一条恢复出来的画线 ⇒ `清单` 按钮不再 disabled（spec §5(2) 的前置）。 */
async function mountWithOneDrawing(): Promise<void> {
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
```

跑：`npx vitest run src/pages/__tests__/ProChartPanels.test.tsx`
期望：这一步先红在「`../chartPanels` 未被页面使用」之前——它应当**直接绿**（前置与本片实现无关）。若这根针绿不了（`disabled` 仍 `true`），按顺序查三件：①替身的 `getDataList` 是否返回了至少一根 bar（恢复路径要 `lastBarTimestamp(bars)`，见 `ProChart.tsx:1380-1400`；Legend 那份替身给的是 `() => []`，把它换成返回 `[{ timestamp: START, open: 1300, high: 1310, low: 1290, close: 1305, volume: 10 }]` 并让 `h.loader.getBars` 的 callback 把这些数据交出去）；②`getPaneOptions` 是否含 `candle_pane`；③`removeOverlay` 被页面以**无参**形式调用过（`:1382`），所以它必须接受 `undefined`。**这条针不绿就不许往下走**——它后面所有 `drawings` 的写侧断言都站在它上面。

- [ ] **Step 2：写四根存储针（预期先红）**

```tsx
describe("/pro-chart 面板开关的会话级持久化", () => {
  const stored = (): Record<string, unknown> => JSON.parse(sessionStorage.getItem(PANELS_KEY) ?? "null");

  it("未动过任何开关 ⇒ 会话键根本不存在（偏差编码，默认不落盘）", async () => {
    await mountWithOneDrawing();
    expect(sessionStorage.getItem(PANELS_KEY)).toBeNull();
  });

  it("四枚开关各点一次，盘上逐枚只含自己的键", async () => {
    await mountWithOneDrawing();
    const cases: Array<[string, string]> = [
      ["副图指标", "subIndicator"],
      ["图例", "legend"],
      ["画线清单", "drawings"],
    ];
    for (const [name, field] of cases) {
      sessionStorage.clear();
      fireEvent.click(screen.getByRole("button", { name }));
      expect(stored()).toEqual({ [field]: true });
      expect(screen.getByRole("button", { name }).getAttribute("aria-pressed")).toBe("true");
    }
    // 工作台那枚没有 aria-label，可达名来自文本（现读 ProChart.tsx:2750-2756）
    sessionStorage.clear();
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
    expect(screen.getByRole("button", { name: /指标公式/ }).toBeTruthy()).toBe(true);
  });

  it("坏值 ⇒ 首屏不开任何面板，且那枚键被合成点删掉（自愈，不是意外）", async () => {
    sessionStorage.setItem(PANELS_KEY, '{"drawings":"yes"}');
    await mountWithOneDrawing();
    expect(screen.getByRole("button", { name: "画线清单" }).getAttribute("aria-pressed")).toBe("false");
    expect(sessionStorage.getItem(PANELS_KEY)).toBeNull();
  });
});
```

跑：`npx vitest run src/pages/__tests__/ProChartPanels.test.tsx`
期望：`前置` 那根绿，其余五根红，红在「`aria-pressed` 是 `false`」或「`sessionStorage.getItem` 恒 `null`」这一类**机制缺失**上，而不是 `getByRole` 找不到元素（找不到元素＝替身坏，先修替身）。

- [ ] **Step 3：接线 `ProChart.tsx`（四处同行替换 ＋ 1 行 import ＋ 1 枚 effect）**

3a. import：在 `:116` 那行 `} from "@/lib/chartLegend";` **之后**插入一行

```ts
import { loadPanelVisibility, savePanelVisibility } from "@/lib/chartPanels";
```

> 2026-10-15 更正（T2 开工前现读）：3a 那个行号是错的——`} from "@/lib/chartLegend";` 现读在 `ProChart.tsx:115`，`:116` 是下一枚 import 的开头 `import {`（`@/lib/heikinAshiChart`）。
> 内容锚是权威的，按内容锚插；若照字面在 `:116` 之后插一行，会把 `heikinAshiChart` 那枚多行 import 从中间劈开。3b 表里那四枚行号（527／548／561／591）与 Step 3 末尾那个 `}, [symbol, interval, timeShare]);`（796）现读都对得上，不必改。

3b. 四枚初值（**同一行内替换，不增行**；逐字旧文本现读自 2026-10-15 的树）：

| 行号 | 旧（逐字） | 新（逐字） |
|---|---|---|
| 527 | `  const [indPanelOpen, setIndPanelOpen] = useState(false);` | `  const [indPanelOpen, setIndPanelOpen] = useState(() => loadPanelVisibility().workbench);` |
| 548 | `  const [subPanelOpen, setSubPanelOpen] = useState(false);` | `  const [subPanelOpen, setSubPanelOpen] = useState(() => loadPanelVisibility().subIndicator);` |
| 561 | `  const [drawPanelOpen, setDrawPanelOpen] = useState(false);` | `  const [drawPanelOpen, setDrawPanelOpen] = useState(() => loadPanelVisibility().drawings);` |
| 591 | `  const [legendPanelOpen, setLegendPanelOpen] = useState(false);` | `  const [legendPanelOpen, setLegendPanelOpen] = useState(() => loadPanelVisibility().legend);` |

（四枚各调一次 `loadPanelVisibility()` 是刻意的：多一次 30 字节的 `JSON.parse`，换四个初值彼此独立、不新增一行状态。要合并成一枚 `useState<PanelVisibility>` 会把十来个调用点全牵进来，不属于本片。）

3c. 写点：在 `:790` 那枚 `SESSION_KEY` effect 的闭合 `}, [symbol, interval, timeShare]);` **之后**插入（那枚闭合括号现读在 **796** 行，插入点＝它后面那个空行处。**不许**插在 792 之前：`docs/forensics/gap-matrix.md` TV-DW-04 那格的说明列把写点钉成「同文件 792 行 `localStorage.setItem(SESSION_KEY, …)`」，插在 792 之前会把一条历史读数当场作废，而校验器对说明列失明——插到 796 之后，792 及其以前的一概不动）

```ts
  // Panel visibility (L3 第①片): one session key, deviation-only, the only writer
  // being this composition point. Scattering the write over the six `set*` call
  // sites is what the legend chapter already paid for — a missed path leaves the
  // chart's memory half-true, and nothing downstream can see which half.
  useEffect(() => {
    savePanelVisibility({
      workbench: indPanelOpen,
      subIndicator: subPanelOpen,
      drawings: drawPanelOpen,
      legend: legendPanelOpen,
    });
  }, [indPanelOpen, subPanelOpen, drawPanelOpen, legendPanelOpen]);
```

3d. `:621` 那句注释的措辞（现读逐字：`  // 一个例外如实记着（第三席的 S3-4）：`timeShare` 来自**会话**（`sessionStorage`）而不是偏好，`）：它把 `localStorage` 说成了 `sessionStorage`。本片之后这个文件**真的**开始用 `sessionStorage` 了，所以这句含糊会变成活陷阱。**同一行内替换**成如实的一句：

```ts
  // 一个例外如实记着（第三席的 S3-4）：`timeShare` 来自**会话键**（`localStorage` 的 `SESSION_KEY`，见 281 行）而不是偏好，
```

（只改措辞，不改 `readSession` 的行为。行号引用在改后仍指 281——本处改动全在 281 之后。）

- [ ] **Step 4：跑到全绿**

`npx vitest run src/pages/__tests__/ProChartPanels.test.tsx` → 6 passed。再 `npx vitest run src/pages/__tests__/ProChartLegend.test.tsx src/lib/__tests__/chartLegend.test.ts`（同族回归面）→ 全绿。

- [ ] **Step 5：类型门 ＋ 提交**

`npx tsc -b`（无输出）后：

```bash
cd "E:/Vibe-Trading-main/Vibe-Trading-main"
git add -f frontend/src/pages/ProChart.tsx frontend/src/pages/__tests__/ProChartPanels.test.tsx
git commit -s -m "feat(pro-chart): 四枚面板开关接会话级可见性键，读写各一个面（L3 第一片 T2）" -- frontend/src/pages/ProChart.tsx frontend/src/pages/__tests__/ProChartPanels.test.tsx
```

---

### Task 3：URL 不变性针（CI-06 的驱动缺口）＋ `?s=` 链接优先针

**Files:**
- Test: `frontend/src/pages/__tests__/ProChartPanels.test.tsx`（追加）
- Modify: 无实现改动（这两根针钉的是既有性质与新持久化的交互）

**Interfaces:**
- Consumes: Task 2 的替身与 `mountWithOneDrawing()`
- Produces: 把 `docs/forensics/gap-matrix.md` TV-CI-06 那一行从 `部分` 升 `已有` 所缺的那根针

- [ ] **Step 1：写 URL 不变性针**（先红＝它断言的东西此前从未被断言过，故它会**直接绿**——这是本任务如实要记的形状，见 Step 3）

```tsx
describe("/pro-chart 四个打开动作对 URL 的净变化为零（TV-CI-06 的针）", () => {
  it.each([
    ["副图指标", "副图指标"],
    ["图例", "图例"],
    ["画线清单", "画线清单"],
    ["指标公式工作台", /指标公式/],
  ])("%s：点之前点之后 window.location.href 逐字相同", async (_label, name) => {
    await mountWithOneDrawing();
    const before = window.location.href;
    fireEvent.click(screen.getByRole("button", { name: name as string | RegExp }));
    await flush();
    expect(window.location.href).toBe(before);
    fireEvent.click(screen.getByRole("button", { name: name as string | RegExp }));
    await flush();
    expect(window.location.href).toBe(before);
  });
});
```

- [ ] **Step 2：写链接优先针**（照 `ProChartDrawings.test.tsx:1742-1763` 的既有配方：`?s=` 是在**模块作用域**捕获的（`ProChart.tsx:396` `let pendingShare = readShareQuery()`），所以必须先换 `window.location` 再 `vi.resetModules()` ＋ 动态 `import("../ProChart")`）

```tsx
it("?s= 分享链接打开工作台：链接优先，且这次真的写进会话键", async () => {
  sessionStorage.setItem(PANELS_KEY, JSON.stringify({ workbench: false }));
  // `?s=` 一侧有公开的写侧编码器（`scriptExchange.ts:233` `createShareLink(card, base)`），
  // 所以这里用真码，不用夹具。解码只在 `out.ok` 时才走到 1608 行那句 setIndPanelOpen(true)，
  // 故卡片必须能过 `readCard`：`code` 是非空字符串就够，dialect 缺省会由 pickDialect 推。
  const { createShareLink } = await import("@/lib/scriptExchange");
  const { url } = await createShareLink(
    { id: "pin-link", dialect: "pine", name: "链接优先针", code: "indicator(\"1\")", display: "pane", params: [] },
    "http://localhost:3000/pro-chart",
  );
  const search = url.slice(url.indexOf("?"));
  const real = window.location;
  Object.defineProperty(window, "location", {
    configurable: true,
    value: new URL(`http://localhost:3000${search}`),
  });
  vi.resetModules();
  try {
    const { ProChart: WithLink } = await import("../ProChart");
    vi.spyOn(window.HTMLElement.prototype, "clientHeight", "get").mockReturnValue(HOST_HEIGHT);
    render(<WithLink />);
    await flush();
    await flush(); // 解码是 promise，`takeShareTask()` 的 `.then` 要再排一次微任务
    expect(JSON.parse(sessionStorage.getItem(PANELS_KEY) ?? "null")).toEqual({ workbench: true });
  } finally {
    Object.defineProperty(window, "location", { configurable: true, value: real });
    vi.resetModules();
  }
});
```

（`sessionStorage.getItem(PANELS_KEY)` 直接读，不复用 Task 2 那枚 `stored()`——它声明在 `/pro-chart 面板开关的会话级持久化` 那个 `describe` 的作用域里，本针在另一个 `describe`，跨块取不到。）

> **2026-10-16 追加（T3 评审轮落地后，不覆盖上文）**：本节上面那段字面码**只钉了存储那半**，而 spec §5(2) 的判据是「存储 ∧ DOM」合取——以 spec 为权威，缺的 DOM 半句已由 `e69aba57` 补进针里（终态坐标：DOM 半句 `ProChartPanels.test.tsx:388`、存储半句 `:390`。该席那次验红的读数打在当时的 `:368:19`——那是发现 2 尚未改上文时的中间行号，别抄它当终态——红点落在 DOM 半句且存储半句没被执行到，所以计划字面码的形状是「合取只有半句」而非「半句恒绿」，评审抓的是前者）。
> 同时记两处上文的坐标漂与形状变更，供后续片引用时不再抄旧值：① 上文 `:491` 注释写的「1608 行那句 `setIndPanelOpen(true)`」现读在 `ProChart.tsx:1622`（T2 接线把文件从 3257 行推到 3272 行）；② Step 1 那组「四个打开动作对 URL 净变化为零」的针，终态形状是**四格各带一枚关闭动作＋两枚 `aria-pressed` 读数**（开→URL 等值＋pressed `"true"`→关→URL 等值＋pressed `"false"`），因为单向打开的 `ƒ` 入口（`openFormulaPanel`，`ProChart.tsx:762-765` 只 `setIndPanelOpen(true)`）使「开→关」对第四格结构性不成立，它借替身 handle `mock-close-workbench` 关闭——**代价是该格耦合了测试替身的文案**，改替身按钮名会让这格红。这一点不在上文计划里，是执行时才发现的，落此条。

- [ ] **Step 3：确认链接优先针断言的是「链接赢过盘上值」这件事**

预置的是 `{"workbench":false}`——按 §4.1 的严格读取，`false` 本来也读成关，所以这根针钉的不是「真赢过假」，而是**挂载时初值来自盘、随后被链接的 `setIndPanelOpen(true)` 覆盖并回写盘**。这正是要的形状：写点在链接之后必须再跑一次，键才会从 `{"workbench":false}` 变成 `{"workbench":true}`（偏差编码 ⇒ `false` 不落盘 ⇒ 全 false 时键被删）。
所以断言写成 `toEqual({ workbench: true })`。读盘时如果拿到的值是 `null`，含义是四枚全成了 false ⇒ 链接**没有**打开工作台，这根针该红而不是该绿——不许把它写成 `toBeNull()` 来「过」。
跑一次确认它绿；再把 `ProChart.tsx:1608` 那句 `setIndPanelOpen(true);` 临时注掉跑一次，确认它红，然后还原（`git diff --stat` 只该有这一枚文件、且只含那一行注释）。

若 `createShareLink` 在这台 node/jsdom 下走进 `gzipString` 分支而 `DecompressionStream` 缺失导致解码失败，针会红在「工作台没开」——那不是机制坏，是替身环境缺能力；判法＝`npx vitest run` 贴出 `setFormulaError` 那句文案，若逐字是「分享链接无效：…」则按 `scriptExchange.ts:422` 的 `gzipSupported()` 现读结论处理（该函数怎么探的就怎么读），并在报告里记这一条，不放宽断言。

- [ ] **Step 4：跑全绿并如实记 URL 针的形状**

`npx vitest run src/pages/__tests__/ProChartPanels.test.tsx`
**Step 1 那根针会在实现之前就绿**（本仓从来不改 URL），这不是假绿——CI-06 的缺口按矩阵原文就是「没有任何测试针钉这件事」，针立起来绿了就是它要的东西；但变异自证（Task 4）必须证明它**不是恒真**：Step 5 那根加粗的验红要做完。

- [ ] **Step 5：证明 URL 针有判别力（当场验，不留到 T4）**

临时把 `toggleDrawPanel`（`:2283` 附近）之后加一行 `window.history.replaceState({}, "", "?x=1");`，跑该文件 → 期望「画线清单」那根 URL 针**红**；撤掉临时行（`git checkout -- frontend/src/pages/ProChart.tsx` 之前先确认工作树只有你这一处改动：本任务从干净树起步，故 `git diff --stat` 只该有这一枚文件、且只含那一行），复跑 → 全绿。报告里贴两次的读数。

- [ ] **Step 6：提交**

```bash
cd "E:/Vibe-Trading-main/Vibe-Trading-main"
git add -f frontend/src/pages/__tests__/ProChartPanels.test.tsx
git commit -s -m "test(pro-chart): 四个打开动作对 URL 净变化为零＋?s= 链接优先，两根针（L3 第一片 T3）" -- frontend/src/pages/__tests__/ProChartPanels.test.tsx
```

---

### Task 4：变异自证三处 ＋ 六道门

**Files:**
- Modify: 无（变异是临时的，验红后必须逐字还原）

- [ ] **Step 1：变异①** 把四枚初值改回 `useState(false)`（四处同行替换回旧文本）→ `npx vitest run src/pages/__tests__/ProChartPanels.test.tsx` → 期望「预置会话键 ⇒ 首屏 aria-pressed=true」与「坏值自愈」两根红。记录红名单后还原。
- [ ] **Step 2：变异②** 删掉 effect 里 `workbench: indPanelOpen,` 之外……不，按 spec §5(3)：把合成 effect 整枚删掉，改在 `toggleDrawPanel`（`:2283`）与两枚 `(v) => !v`（`:2768`／`:2889`）里各写一次 → 期望「经遮罩 onClose 关掉工作台也会写盘」红（其余绿——这正是这根针存在的理由）。还原。
- [ ] **Step 3：变异③** `chartPanels.ts` 里 `o[f] === true` 放宽成 `Boolean(o[f])` → `npx vitest run src/lib/__tests__/chartPanels.test.ts src/pages/__tests__/ProChartPanels.test.tsx` → 期望单测③与页面「坏值自愈」两根红。还原。
- [ ] **Step 4：确认还原干净**：`git diff --stat` 应为空（本任务不产出提交）；若非空，逐条核对是谁的活——**不许**对别人的在途文件跑 `git checkout --`（本仓记忆里的红线）。
- [ ] **Step 5：六道门全量**（前端四枚在 `frontend/`，Python 两枚在仓库根）

```bash
cd "E:/Vibe-Trading-main/Vibe-Trading-main/frontend"
npx tsc -b
npx vitest run
npm run build
cd "E:/Vibe-Trading-main/Vibe-Trading-main"
python -X utf8 -m pytest tools/test_wiki_drift.py tools/test_wiki_qmind.py -q
python -X utf8 tools/forensics_audit.py
python -X utf8 -m pytest tools/test_forensics_spec.py -q
bash tools/wiki_freshness_gate.sh
bash tools/ci_grep_gates.sh
```

（仓库根只有两枚 shell 门，`ls tools/*.sh` 现读为 `wiki_freshness_gate.sh` 与 `ci_grep_gates.sh`；上面两行的文件名就是现读值。）`wiki_freshness_gate.sh` 在本地恒红（水位超阈值，见记忆 §八），要先证「本片 0 贡献」再报告：把红的读数与本片新增/改动文件做交集，空集才算归属成立——本片只动 `frontend/src/**` 与 `docs/forensics/gap-matrix.md`，不动 wiki 页与 `verified_at`，交集天然为空，但仍要贴出现读的那条判定行，不能只声称。

- [ ] **Step 6：写读数小结**（只进本片台账，不进被跟踪文档——自指纪律）

---

### Task 5：L4 活体取证——「活过一次刷新」要在这台机器上读到

**Files:**
- Create: `docs/forensics/l0/self-dw05-panel-session.md`（六枚必填键齐：`命令`／`evidence_id`／`浏览器`／`目标 URL`／`观察条件`／`完整性`——键名逐字取自 `tools/forensics_audit.py` 的 `L0_REQUIRED_KEYS`，冒号是全角 `：`，见同文件 `KEY_LINE`）
- Modify: 无代码（本趟只产读数；若读数与判据不符，按 Step 7 分诊，不在这里改实现）

**Interfaces:**
- Consumes: Task 4 全量门之后的树（本趟读的是**提交后**的页面，不是工作树里的半成品）
- Produces: 矩阵 TV-DW-05 那一格升态的活体凭据；同时对 `docs/forensics/l0/self-ci07-panel-toggle.md` 的判因做一次**反事实检验**——那一格写的是「场景命令每趟开头强制 `goto_start` ⇒ 非持久初值 ⇒ 跨两趟必然同相」，本片把初值变成持久的，所以这三趟逐字相同的命令是否仍然同相，就是那条判因的读数

**判据纪律**：只写等值关系（「run2 的 `画线清单` 形态 == run1 的 `scenario_start` 形态」这一类），不写常量、不写「应该看到 pressed」。跑出来不符就如实登记，不放宽。

- [ ] **Step 1：记账起点**

`git rev-parse --short HEAD` 与 `git status --short` 逐字进报告。若别席那三枚在途件（`frontend/src/lib/chartDrawings.ts`、其测试、`frontend/public/usage-guide.md`）仍在树里，如实写一句「dev server 走的是工作树，本趟读数含未提交的 `chartDrawings.ts`」——这一句决定读数的归属边界，省略它等于把混合态读成干净态。

- [ ] **Step 2：起两个进程（日志落仓外，不进仓库）**

```bash
mkdir -p "$TEMP/rea-l3t5"
cd "E:/Vibe-Trading-main/Vibe-Trading-main/agent"
python api_server.py > "$TEMP/rea-l3t5/backend-start.txt" 2>&1 &
cd "E:/Vibe-Trading-main/Vibe-Trading-main/frontend"
npm run dev > "$TEMP/rea-l3t5/frontend-start.txt" 2>&1 &
```

后端必须起，理由与凭据照 `docs/forensics/spec/drawings.md` 的 TV-DW-07 前置格：只起 vite 时 `/pro-chart` 的可达树逐字带「无法连接 API 服务」，画布上没有任何 K 线，「画布上已有一条图元」这个渲染态就立不住。端口出处要**当场开那一行确认还在**（`frontend/vite.config.ts` 的 `apiTarget` 与 `port`），别抄本文写的数字。探活：

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8000/health
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:5899/pro-chart
```

- [ ] **Step 3：起 headless Edge，取 CDP 现场的 PID 与 target_id**

只访问 `localhost`，所以带 `--no-proxy-server`（这是自家页那两枚 L0 记录的既有形状，见 `docs/forensics/l0/self-dw07-pixel-equality.md` 的「浏览器」键；`msedge.exe` 不在 PATH 上，必须写绝对路径）：

```bash
"$TEMP/rea-l3t5/edge-start.txt" >/dev/null 2>&1 || true
"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" \
  --headless=new --no-proxy-server --remote-debugging-port=9222 \
  --user-data-dir="$TEMP/rea-l3t5/edge-profile" --window-size=1100,800 \
  "http://localhost:5899/pro-chart" > "$TEMP/rea-l3t5/edge-start.txt" 2>&1 &
netstat -ano | grep ":9222" | grep LISTENING
```

PID 从 `netstat` 现读，核身只用 `tasklist //FI "PID eq <号>"` 读一次。**本步的红线**：任何清理只按这个 PID 走，绝不按镜像名杀 `msedge.exe`（用户明确要求过）。

```bash
npx -y rea-agents@latest list-browser-targets '{"browser":{"mode":"connect","cdp_endpoint":"http://127.0.0.1:9222"}}'
```

`target_id` 取这一趟现读的值。**不许**沿用旧记录里那枚 32 位十六进制号——那是上一批那趟现场的号，浏览器进程一换即作废；本趟所有场景命令里它统一写成 `<tid>`，落档时替换成现读值并说明替换发生在哪。

- [ ] **Step 4：前置导入趟（让 `画线清单` 那枚按钮解禁）**

零画线时该按钮 `states` 逐字带 `disabled,true`（凭据 `docs/forensics/l0/self-ci07-panel-toggle.md`），必须先经第一方 `?d=` 分享链接导入一条图元——鼠标落点在现行工具词汇表里不可表达，所以没有「点出来一条线」这条路。命令逐字（`<tid>` 换成 Step 3 现读值；`?d=` 那串是本仓自己的分享码，解码后是 `{"v":2,"d":[{"name":"horizontalStraightLine","paneId":"candle_pane","points":[{"timestamp":4102444800000,"value":1700}]}]}`）：

```bash
cd "$TEMP/rea-l3t5"
npx -y rea-agents@latest capture-browser-scenario '{"browser":{"mode":"connect","cdp_endpoint":"http://127.0.0.1:9222","target_id":"<tid>"},"start_url":{"url":"http://localhost:5899/pro-chart?d=jeyJ2IjoyLCJkIjpbeyJuYW1lIjoiaG9yaXpvbnRhbFN0cmFpZ2h0TGluZSIsInBhbmVJZCI6ImNhbmRsZV9wYW5lIiwicG9pbnRzIjpbeyJ0aW1lc3RhbXAiOjQxMDI0NDQ4MDAwMDAsInZhbHVlIjoxNzAwfV19XX0"},"actions":[{"step_id":"s1","action":"wait_for_timeout","duration_ms":9000}],"storage":{"cookies":[],"local_storage":[],"session_storage":[]},"secrets":[],"capture":{"after_each_step":[],"at_end":["url","accessibility"],"events":[],"network":{"request_body":false,"response_body":false,"header_values":false}}}' --filter-output evidence_id,normalized_result --token-limit 150000 | tee setup-import.out
```

（导入命令的形状取自留档 `rea-t11b/setup-draw.cmd`，改动只有三处：`target_id` 换本趟现读值、`goto` 步换成 `start_url` 直接带码、加一步 `wait_for_timeout` 等 hydrate。）判据＝该趟树里那枚按钮**不带** `disabled`、可达名带 `清单 · 1`；两串都用 `grep -c` 数，读数进报告。

导入趟失败（面板里那条图元没进来）时的降级顺序，逐级试、逐级如实记是哪一级成立的：
1. 加长 `wait_for_timeout`（画线恢复发生在 API 数据落地之后，9000ms 是上一批的实测值，不是保证）；
2. 现读一遍那条旧码还在不在当前解码器的接受集合里：`grep -n "version\|v ===\|v !==" frontend/src/lib/drawingExchange.ts` 读它认的版本号，与码串解码出来的 `v` 对一次。**没有**「在页面上手画一条线」这条路——REA 的现行词汇表表达不了 canvas 落点，这正是本趟要靠导入的原因；也不为造一条新码去装任何编译工具链（Global Constraints 第一条）。
3. 直接种 `pro-chart.drawings.v1` 桶——**这只在场景命令的 `storage.local_storage` 支持写入时才可行**。先探形状再决定：`npx -y rea-agents@latest --schema capture-browser-scenario`，把 `storage` 段那几个数组的项形状逐字贴进报告。**不许**照猜的字段名写命令；这条若成立，落 L0 时必须写明「画线条目由我方直接种盘，不是第一方导入」，它支撑的只是「按钮解禁」这一件事，不支撑 `?d=` 通道本身。
4. 三条都不通 ⇒ 本面判**不可取证**，记录照写（`状态：不可取证` 那种形状，见 `_audit_l0` 的 `UNCAPTURABLE` 分支），并在矩阵那一格留「活体未覆盖」，不拿 jsdom 读数冒充活体读数。

- [ ] **Step 5：观察三趟——逐字相同的命令跑三次**

run1／run2／run3 用**同一条**命令、同一 `target_id`、同一浏览器现场，不重启、不清 storage。这条命令就是 `self-ci07-panel-toggle.md` 主键那条 `命令：`（一步 click ＋ `at_end:["url","accessibility"]`），只把 `<tid>` 换成本趟现读值：

```bash
for r in run1 run2 run3; do
  npx -y rea-agents@latest capture-browser-scenario '{"browser":{"mode":"connect","cdp_endpoint":"http://127.0.0.1:9222","target_id":"<tid>"},"start_url":{"url":"http://localhost:5899/pro-chart"},"actions":[{"step_id":"s1","action":"click","locator":{"kind":"role","role":"button","name":"画线清单"}}],"storage":{"cookies":[],"local_storage":[],"session_storage":[]},"secrets":[],"capture":{"after_each_step":[],"at_end":["url","accessibility"],"events":[],"network":{"request_body":false,"response_body":false,"header_values":false}}}' --filter-output evidence_id,normalized_result --token-limit 150000 | tee $r.out
done
diff run1.cmd run2.cmd; diff run2.cmd run3.cmd
```

（先把每条实际跑出去的命令 `tee` 成 `runN.cmd`，`diff` 的 rc 才是「三趟命令逐字相同」的证据；命令行本身要留档是 `取证纪律` 的一部分。）每趟各记两枚计数：

```bash
for r in run1 run2 run3; do
  echo "== $r"; grep -c 'button \\"画线清单\\" \[pressed\]' $r.out; grep -c 'button \\"画线清单\\":' $r.out
done
```

期望的形状（**这是待验假设，不是判据**）：run1 起步于关 ⇒ 点开；run2 起步于开（会话键活过了这趟开头的 `goto_start`）⇒ 点关；run3 起步于关（run2 收尾时四枚全 false ⇒ 键被删）⇒ 又点开。三趟的 pressed 计数若呈「1/0/1」这种交替，就同时读到两件事：持久化真的跨过一次刷新，且「全默认 ⇒ 删键」在活体上成立。若三趟全同相，先分诊再报告：先查 `target_id` 是不是同一个（换 tab 就没有同一份 sessionStorage），再查 `ProChart.tsx` 那四枚初值真读到了键，最后才考虑判据本身。

- [ ] **Step 6：诊断趟——拿到「点之前」那棵树**

run1-run3 只在 click **之后**采树，所以「run2 起步就是开着」这一步在两趟计数里是**推断**。补一趟 `after_each_step:["accessibility"]` 的：

```bash
npx -y rea-agents@latest capture-browser-scenario '{"browser":{"mode":"connect","cdp_endpoint":"http://127.0.0.1:9222","target_id":"<tid>"},"start_url":{"url":"http://localhost:5899/pro-chart"},"actions":[{"step_id":"s1","action":"wait_for_timeout","duration_ms":9000},{"step_id":"s2","action":"click","locator":{"kind":"role","role":"button","name":"画线清单"}}],"storage":{"cookies":[],"local_storage":[],"session_storage":[]},"secrets":[],"capture":{"after_each_step":["accessibility"],"at_end":["url"],"events":[],"network":{"request_body":false,"response_body":false,"header_values":false}}}' --filter-output evidence_id,normalized_result --token-limit 150000 | tee diag.out
```

判据：`step_id: s1` 那棵树里那枚按钮的形态 == run1 的 at_end 形态，且 `step_id: s2` 那棵树里的形态 == run1 的 at_end 形态的**反面**。
旧记录踩过的那个坑要写进报告纪律：`step_index: 0`（`goto_start`）那棵树只有 1560 字节、页面还没 hydrate、整棵树里没有 `画线清单`——**那枚空读数不许当「点之前的面板态」用**，所以要一个显式的 `wait_for_timeout` 步。

- [ ] **Step 7：落 `self-dw05-panel-session.md`**

形状逐字照 `self-ci07-panel-toggle.md`：六个必填键在最前（`- 命令：` 写**当趟实际跑出去**的那条，run1 为主键趟；其余趟的形状差异另起一段散文说明，别把四条命令挤进一个键）；`- evidence_id：` 由 `sed -n '1p' run1.out` 现读，**同趟**取，不抄别的趟；`- 浏览器：` 抄该趟 stdout 的 browser 块（注意旧记录那条口径：场景命令给 `product: Chromium` ＋ 独立 `version`，单趟 CDP 给 `product: Edg/…`，同属一个浏览器，别写成两个）；`- 目标 URL：` 写明「**自家 dev server，不是 tradingview.com**」并带 scheme（`_is_tv_page_record` 按 host 判，值里没有带 scheme 的 URL 就判不出 host）；`- 观察条件：` 列全「除这些 click 外未点按别的元素、未 fill、未登录、未保存、未交易」＋ `storage` 三段全空＝未请求任何 storage 读数；`- 完整性：` 抄顶层**并解释缺席面**（`events` 缺席是场景自己声明空数组的结果，不是页面没事件）；`- 用途：规格`。
判据与复算那节贴 Step 5/6 的 `grep -c` 循环原样，留档路径写仓外绝对路径并注明会随系统清理消失。

- [ ] **Step 8：清场**

按 Step 3 现读到的 PID 停（`taskkill //PID <号> //T //F`，一个一个来），再复核：

```bash
for p in 9222 5899 8000; do echo -n "$p "; netstat -ano | grep ":$p" | grep -c LISTENING; done
```

三个计数都该是 0（`TIME_WAIT` 残行属内核记账，无监听者，不算没停干净）。

- [ ] **Step 9：复跑吃 L0 的那两枚门 ＋ 提交**

新记录进了 `docs/forensics/l0/`，`forensics_audit.py` 会扫它，所以本步不是可选项：

```bash
cd "E:/Vibe-Trading-main/Vibe-Trading-main"
python -X utf8 tools/forensics_audit.py
python -X utf8 -m pytest tools/test_forensics_spec.py -q
git add -f docs/forensics/l0/self-dw05-panel-session.md
git commit -s -m "docs(forensics): L0 自家页会话级面板持久化活体读数（L3 第一片 T5）" -- docs/forensics/l0/self-dw05-panel-session.md
```

- [ ] **Step 10：若活体读数与假设不符，按这里收尾**

不实现「让判据变绿」的任何改动。做法＝L0 记录照实写读数、矩阵那一格**不升**、把不符的形状写成本片台账的一条 `Ruling:`，并在 Task 7 的档案一节里作为「实测不符」而不是「实测通过」落档。

---

### Task 6：回灌 L2 差距矩阵（两格升态 ＋ 第三列八枚锚按内容重钉）

**Files:**
- Modify: `docs/forensics/gap-matrix.md`（只动 TV-DW-05、TV-CI-06 两格，外加其余六格第三列的行号）
- 不动: `docs/forensics/spec/*.md`（L1 记的是**对方**页面，本片不产生改它的读数）、`docs/forensics/l0/**` 里的历史读数、`tools/**`

**Interfaces:**
- Consumes: Task 1-5 的落地件与活体读数
- Produces: L2 与 L3 重新咬合；`python -X utf8 tools/forensics_audit.py` rc=0

- [ ] **Step 1：先数本片到底增了几行**

```bash
cd "E:/Vibe-Trading-main/Vibe-Trading-main"
git diff --numstat <BASE> HEAD -- frontend/src/pages/ProChart.tsx
```

`<BASE>` 用 Task 2 开工前记下的那个 commit（台账里有）。这一行的两个数字进报告，也进 Step 2b 那条全表口径——**本文不预先填数字**，spec §4.3 之所以这么写就是因为预填会漂。

- [ ] **Step 2：第三列八枚锚，逐枚按内容重钉（不许按 ±N 平移算出来就交）**

每枚的流程＝①`grep -n -F '<逐字文本>' frontend/src/pages/ProChart.tsx` 取新行号 → ②`sed -n '<新号>p'` 开一次确认文本对得上 → ③改矩阵那一格。八枚的 grep 键（现读自 `205908d3` 的矩阵，逐字）：

| 条目 | 第三列旧值 | 该行记录的逐字文本（键） | 备注 |
|---|---|---|---|
| TV-DW-04 | `ProChart.tsx:182` | `const SESSION_KEY = "pro-chart.session.v1";` | 在插入点之前，预期只被 import 那一行挪动 |
| TV-CI-06 | `ProChart.tsx:527` | **本片之后旧逐字文本已不存在**（`useState(false)` 改成了读会话键）⇒ 键换成新文本 `const [indPanelOpen, setIndPanelOpen] = useState(() => loadPanelVisibility().workbench);` | 见 Step 3 |
| TV-DW-07 | `ProChart.tsx:1398` | `const report = restoreDrawings(` | |
| TV-CI-02 | `ProChart.tsx:2716` | `periodActive(i.key) && "bg-muted font-medium",` | |
| TV-DW-01 | `ProChart.tsx:2778` | `{DRAW_TOOLS.map((t) => (` | |
| TV-CI-07 | `ProChart.tsx:2830` | `aria-pressed={drawPanelOpen}` | |
| TV-DW-02 | `ProChart.tsx:3060` | `{drawPanelOpen && (` | |
| TV-DW-06 | `ProChart.tsx:3238` | `<div ref={hostRef}` | 说明列写的就是「图表容器 `<div ref={hostRef} …>`」 |

报告里逐枚贴三件：记录的逐字文本 → 新行号 → `sed -n '<新号>p'` 的开行读数。

- [ ] **Step 2b：给矩阵头部「口径」那节追加一条带日期的子句（全表共用，不逐格重复）**

矩阵「口径」那节里以 ``- `已有`／`部分` 的第三列只有一个 `路径:行号`，由校验器验`` 起头的 bullet（`grep -n '第三列只有一个' docs/forensics/gap-matrix.md` 现读行号）是这张表自己的读法说明，本片要往那节里加**一条**（不是改现有的任何一条），内容三件事实：①L3 第①片在 `frontend/src/pages/ProChart.tsx` 实际增了 Step 1 数到的行数；②第三列那 8 枚锚已按**内容**重钉，所以 `forensics_audit.py` 的行号越界判据对本次改动**不是**证据（它本来就判不出「那一行指的是不是那回事」，这条失明「口径」那节自己已经写着，本条是它的实例）；③说明列里 2026-10-14 那批现读号按既有口径**保留不改写**，其中不带文件名的「NNNN 行」引用（如 TV-DW-04 的「同文件 792 行」、TV-CI-07 的「同文件 2283 行」、TV-CI-06 的 415／421／1598／2466／1608 那一串、TV-DW-01 的「`chartDrawings.ts:131`」、TV-CI-02 的「同文件 2492 行」、TV-DW-07 的「另有 2234 行」）整体后移 ①里那个数。
写的时候逐枚现开一次那些号在**改动后的**树上指向哪一行，把「后移」这句话落成可读的等值式而不是笼统承诺——本仓的红线是「原地覆盖历史读数」和「留无坐标的旧号」两个方向都算错，带日期的追加声明是第三个方向，也是唯一被认可的那个。

- [ ] **Step 3：TV-CI-06 那一格 `部分` → `已有`**

改三处、保留一处：
- 状态列：`部分` → `已有`；
- 第三列：换成 Step 2 重钉后的 `frontend/src/pages/ProChart.tsx:<新号>`（`COORD` 是 `[\w./-]+:\d+` 的 fullmatch，多一个字符都会违规）；
- 说明列：**历史读数一个字不删**（`那一行是 \`const [indPanelOpen, setIndPanelOpen] = useState(false);\`` 和那批「415／421／1598／2466／1608／218／74 行」全留着），在同一格末尾追加一条带日期的子句，只写本片这一格的事：这把针立起来的位置＝`frontend/src/pages/__tests__/ProChartPanels.test.tsx` 里那根 URL 针的 `describe` 标题（**逐字贴**），并指回 Step 2b 那条全表口径；
- 升 `已有` 只能升「打开动作对 URL 净变化为零」这半条。那一格原本就写着 `?s=` 反向驱动面板是**反形状**、且规格句不管这个方向——这句留着，别在升态时顺手把它写成「URL 双向都不动」。

- [ ] **Step 4：TV-DW-05 那一格 `缺` → 只升到你读到的那一档**

这一格现在是 `缺`，第三列写的是「未找到：…」加一条复跑命令。升态动作：
1. 先跑一遍那条旧复跑命令，把 rc 与命中数贴进报告——它现在应该**仍然** 0 命中（本仓没有「收藏画线工具栏」，也没有 `deleteLocked`）。这条读数决定这一格升不改升：
   - 若 `画线清单` 那枚面板可见性真的有了会话级键、但「收藏画线工具栏」与「锁定删除开关」两半仍然没有 ⇒ 升 **`部分`**（本仓只覆盖DW-05 那一格里 scope 归属＋面板可见性这一半）；
   - 不要因为本片做了「面板开关持久化」就把它读成对方那条键名所指的「收藏画线工具栏可见性」。规格边界必须跟着写：**scope 归属（会话级，不是本地级）照的是 L1 那一行的 session/local 之分；行为面（刷新保持、新标签回默认）是本仓自拟**，这句话在 L1 那一格已有，矩阵里要再落一次并指向本次的活体记录。
2. 第三列换成 `frontend/src/lib/chartPanels.ts:<PANELS_KEY 那行的行号>`（先 `grep -n 'PANELS_KEY' frontend/src/lib/chartPanels.ts` 取现读行号；这枚锚是本片新产出的，指得到）。
3. 原来那段 `未找到：… ＋复跑命令` 整段搬进**说明列**开头，逐字不删（`缺` 才要求第三列以 `未找到：` 起头；改成 `部分` 后第三列必须是 `路径:行号`，所以这条搜索记录只能挪，不能删也不能留在第三列），并写明它跑出来仍然 0 命中这件事。
4. 说明列补一句后半个键为什么还没做：`tradingview.toggle_delete_locked_linetools` 落在 spec §6 排除的第一条（库没有删除前否决钩子，`chartDrawings.ts` 头部第 5 条自陈右键删除不读 lock），并**不许**把对方那个键名以外的任何 TV 键值抄进被跟踪文件；写矩阵格时也不要往 `frontend/src` 里塞含 `tradingview.com` 的串（`forensics_audit.py` 的主机白名单那把尺扫的是 `frontend/src`）。

- [ ] **Step 5：复跑三层门**

```bash
cd "E:/Vibe-Trading-main/Vibe-Trading-main"
python -X utf8 tools/forensics_audit.py
python -X utf8 -m pytest tools/test_forensics_spec.py -q
bash tools/ci_grep_gates.sh
```

`forensics_audit.py` 的 `已有／部分` 分支只验「仓库根之内、不在 `docs/forensics/**` 之下、文件存在、行号在 `1..n` 之内」——**它对「那一行指的是不是那回事」失明**，所以 Step 2 的逐枚开行确认不能被这枚门的 rc=0 顶替。改完矩阵再跑一次，两次 rc 都进报告。

- [ ] **Step 6：提交**

```bash
git add -f docs/forensics/gap-matrix.md
git commit -s -m "docs(forensics): 矩阵 TV-CI-06 升已有、TV-DW-05 按实测定档，第三列八枚锚按内容重钉（L3 第一片 T6）" -- docs/forensics/gap-matrix.md
```

---

### Task 7：档案落档 ＋ 记忆更正 ＋ 最终整支评审

**Files:**
- Modify: `项目档案.md`（仓库根，**工作树全 CRLF、`git check-attr text eol -- 项目档案.md` 两个值都是 unspecified ⇒ git 不做归一化，改动必须在 bytes 层做**；用 Python 文本层追加会按 `newline=None` 翻译，本仓记过的坑。长度与行数自己 `wc -c`／`grep -c $'\r'` 现读，本文不写死）
- Modify: 记忆两份（不在仓库内，路径见 Step 3）

- [ ] **Step 1：追加 §7.25 一节**

标题照既有格式（现读最后三节是 `### 7.22 …`／`### 7.23 REA 取证片 T11：…`／`### 7.24 REA 取证片收口轮：…`），新节：

```
### 7.25 REA 复刻漏斗 L3 第①片：图表面板开关的会话级持久化（分支 `feat/l3-panel-visibility`，基座 `92087084`，开工 2026-10-15；设计席＋实现席＋评审席）
```

正文用 §7.24 那节的**粗体标签 bullet** 形状（现读那一节的标签逐字是 `- **这一节管什么**：`／`- **门禁现在判什么（…）**：`／`- **两条被探针抓出来的缺陷（…）**：`／`- **合规三硬线在本轮的落点**：`／`- **门禁读数（本轮现读，两种性质别混）**：`），本片对应写成六条，标签自拟但内容固定：
1. **这一节管什么**——L3 分片的第一片，把漏斗从「观察／规格／矩阵」推进到「实现」；两层文档的内容本身在 §7.23／§7.24，本节不重复。
2. **两条 L1 条目各自的复跑读数**——逐条写「命令 ＋ rc ＋ 命中数」，别只写结论；DW-05 那条要带上规格边界那句（scope 归属照 L1、行为面本仓自拟）。
3. **实现与七项判据的实测读数**——五态单测／页面针／URL 针（含 Step 5 那次验红）／变异三处各自红在哪一枚针／坐标重钉（贴每枚「文本→新号→开行读数」的一件）／六道门／活体三趟的 `grep -c` 交替形状。
4. **两处改判与理由**——写侧从「无条件整体写」改判成「偏差编码＋全默认删键」，接线形状 (B)(C)(D) 三个候选为什么否。
5. **活体那趟顺带读到的东西**——本片对 `self-ci07-panel-toggle.md` 那条「跨两趟必然同相」判因构成一次反事实检验，无论成立与否都照实写，并把要写进用户记忆的那条收窄结论指给 Step 3。
6. **刻意分歧与未尽项**——DW-04 三项合键不分家（刻意分歧）、`tradingview.toggle_delete_locked_linetools`（留下一片，先做可行性探针）、`?s=` 那根针若降级就写明降到哪一步。
**自指纪律**：本节里不写「本片共 N 笔提交」「本文件 X 行」「HEAD=…」，也不把本片新增的 needle 写进会被同一把尺扫到的位置；数字只写「由你当场测」或带 `file:line`。

追加写法（bytes 层，CRLF）：

```bash
cd "E:/Vibe-Trading-main/Vibe-Trading-main"
python -X utf8 - <<'PY'
from pathlib import Path
p = Path("项目档案.md")
b = p.read_bytes()
# `sec` 的正文＝上面那六条 bullet 逐条落字（内容来自 T1-T6 的实测读数），这里只示范追加机制。
sec = """
### 7.25 REA 复刻漏斗 L3 第①片：图表面板开关的会话级持久化（分支 `feat/l3-panel-visibility`，基座 `92087084`，开工 2026-10-15；设计席＋实现席＋评审席）

- **这一节管什么**：……
- **两条 L1 条目各自的复跑读数**：……
- **实现与七项判据的实测读数**：……
- **两处改判与理由**：……
- **活体那趟顺带读到的东西**：……
- **刻意分歧与未尽项**：……
"""
new = b + sec.replace("\r\n", "\n").replace("\n", "\r\n").encode("utf-8")
p.write_bytes(new)
print(len(b), "->", len(new))
PY
git diff --numstat -- 项目档案.md   # 删除列必须是 0——这一节只追加，不覆盖任何历史读数
```

（`……` 是六条 bullet 的正文位，由实现席按 T1-T6 的读数落字，本文不代写；heredoc 用**带引号**的 `'PY'`，否则反引号内容会被 shell 吃掉——本仓记忆里的既有坑。`git diff --numstat` 那条是硬判据：删除列不为 0 就说明写成了覆盖而不是追加，停下来重做。）

> **2026-10-16 追加（判据更正，不覆盖上文）**：上面 T7 `Files:` 那一行（本追加前在 `:796`，追加后现读 `:799` ⇒ **认文字别认号**）让人「自己 `wc -c`／`grep -c $'\r'` 现读」长度与 CR 数——后一条判据在本机**读不出东西**，实测坐标＝仓库根 `项目档案.md`（该文件工作树全 CRLF）：`wc -l` → `2042`、`grep -c $'\r'` → `0` 且 **rc=1**、`tr -cd '\r' < 项目档案.md | wc -c` → `2042`。也就是说 grep 那条会把一份逐行 CRLF 的档案误报成「一枚 CR 也没有」，按它判定「我把 CRLF 写坏了／写对了」都是在读空气。量 CR 只有 `tr -cd '\r' < f | wc -c` 这一种形状；行数照旧 `wc -l`，字节数照旧 `wc -c`。成因不在本文考证（本机 msys 运行时怎么处置 CR 不属于本计划的判据面），只登记「这条判据失效」＋替代形状。这属于本仓记忆里「规则 10＝守卫断言本身可能恒真（或恒不真）」那一族：判据造不出红来的时候，它的读数不构成证据。

- [ ] **Step 2：改完档案立刻复跑吃它的门**

`tools/test_wiki_drift.py` 与水位门都会读档案路径（记忆里那条「改档案要复跑它」）。跑：

```bash
cd "E:/Vibe-Trading-main/Vibe-Trading-main"
python -X utf8 -m pytest tools/test_wiki_drift.py tools/test_wiki_qmind.py -q
python -X utf8 tools/forensics_audit.py
bash tools/wiki_freshness_gate.sh
bash tools/ci_grep_gates.sh
```

水位门若恒红，按本仓口径先证「本片 0 贡献」再报告（交集是「本片改动的文件」×「门报红的来源页」，本片只动 `frontend/src/**`、`docs/forensics/**` 与 `项目档案.md`），**不调阈值**。

- [ ] **Step 3：记忆更正（两份，都在仓库外）**

1. `C:\Users\fire\.qoder-cn\projects\E--Vibe-Trading-main-Vibe-Trading-main\memory\ops-delivered-features-and-comparisons.md`：追加本片一条（分支／基座／终态 commit／这一片把哪两格矩阵推动到哪一档），并更新「已合入并推送」那一句只在真的推送后才改。
2. `C:\Users\fire\.qoder-cn\memory\env-rea-web-forensics.md`：那条「跨两趟读互补态这类判据不可满足」要按本次活体读数**收窄**——`goto_start` 每趟强制跑这件事没变，变的是「初值非持久」这个前提：初值一旦读自 sessionStorage，逐字相同的三趟就能读到互补态。改写成带 `2026-10-15` 日期的收窄子句，**不删原结论**（它对非持久初值仍然成立），并指明证据是那枚新 L0 记录。
3. 两份都要同步更新各自 `MEMORY.md` 索引行的那句 hook（索引 ≤150 字符、不放正文）。

- [ ] **Step 4：最终整支评审**

范围＝`92087084..HEAD` 整支。评审席 inputs 三件：`git log --oneline`＋`git diff --stat`＋`git diff -U10` 打成一份 review package（用 SDD skill 的 `scripts/review-package <plan> <BASE> <HEAD>`），加本片 spec 路径与 Global Constraints 原文。评审维度按本片自己的判据走七条（持久化读写面／偏差编码与删键自愈／四枚初值／URL 针的判别力／坐标重钉有没有真按内容／活体读数的归属边界／矩阵两格升态有没有超出读数），不接受「全绿所以正确」。

发现回来逐条裁定，落到台账；需要改的走**一轮**修复席＋一次 scoped 复评，剩余项裁定后收口。

- [ ] **Step 5：收口**

台账终态写完 → 删本片 SDD 工作区（`git clean` 会连台账一起清，所以顺序是先落档案再清）→ 把分支终态 commit 号写进档案那一节的「坐标」位。
**合回 main 与推送是另一件事，要用户点头**（本仓纪律：推送共享分支属跨范围动作，一次授权不等于长期授权）。


> **2026-10-16 追加（T6 回报后的四条裁定与一条自指更正，不覆盖上文；落点选在文件末尾，因为本文上面已有一条按行号自指的追加，中间插行会把它说过的号挪掉）**
>
> 1. **T6 的 `Files:` 范围被裁定扩了两枚面**（计划缺陷，非席位越权）。T6 原文逐字写着「不动: `docs/forensics/spec/*.md`（L1 记的是**对方**页面，本片不产生改它的读数）」——这条前提被 T5 的产物证伪了一半：`forensics_audit.py:535-541` 的孤证规则让「`用途：规格` 而零规格引用」直接 rc=1，所以 T5 席只能按 `docs/forensics/batch-A-playbook.md:390-393` 的既有口径先写 `基线`。自家页的反事实检验记录进 L1 是**本仓既有形状**（前例 `self-ci07-panel-toggle.md`、`self-dw07-pixel-equality.md` 都已被写进 L1 的 `L0 依据` 列），不是新先例。⇒ 落地形状＝三笔、各自一面、按 ①L1 引用 → ②`用途` 翻格 → ③矩阵 的顺序（引用先落地，翻格才不红）。
> 2. **`- 用途：` 那一格「同行末尾带日期注」不可执行**（本席 2026-10-16 现读 `tools/forensics_audit.py`：`:31` 的 `L0_PURPOSES` 只收 `harness`／`规格`／`基线` 三个字面，`:211` 判 `purpose not in L0_PURPOSES`，`:40` 的 `KEY_LINE` 把整行行尾当值）⇒ 并进同一行会把值读成 `规格（…）` 而假红。席位选的「值原地翻转＋注落该记录末尾」是这一形状下唯一可执行的落点，**追认**。
> 3. **控制器盘面复算把矩阵做实了一遍**：十枚第三列锚逐枚开行＝逐字对得上；「口径」bullet 那批旧号→新号共 38 对，控制器读 `92087084` 与 HEAD 两版全文逐对比对＝**36 对同文＋2 对 MISS**（`527→528`、`561→562`，那两枚旧逐字文本在树上已 0 命中），与 bullet 自己的分档计数 4＋11＋21 逐档相符；四枚多命中的锚按结构邻接定号成立。三门＝`forensics_audit.py` rc=0／`pytest tools/test_forensics_spec.py` 166 passed／`ci_grep_gates.sh` 仍恒红且命中全在两棵未跟踪 scratch 树。
> 4. **两条新发现进了 T6 修复轮 1**（都在文档面，都按带日期追加修）。其一：矩阵 **TV-CI-07 那一格的 L2 判因散文没跟着收窄**——那格仍写「面板初值不持久（同文件 561 行逐字 …）于是两趟必然同相」，而这枚前提正是本片换掉的东西（L1 同一格拿到了带日期反事实子句，L2 没有）。后果不是文字难看，而是**下一片若按 L2 排门禁趟，会写出一根结构上不会红的针**。其二：`docs/forensics/l0/self-dw05-panel-session.md` 里 T6 那句「第 25 行仍是一行、文件仍是 119 行」后半句为假（现读 121 行；那一笔自己就是 3 增 1 删），同格「与今天落库件 `diff` 只读出一处 `118a119`」**版本坐标不清**——同一枚留档 `.bak` 逐版本实测：对 `cac8d6dd` 确实只有 `118a119`，对 `a4f8c2c7` 是 11 处，对 HEAD 是 12 处＋`118a119,121`。⇒ 本仓口径补一条：**会被后续提交改写的文件里，「今天落库件」不算版本坐标，版本坐标只能是 commit 号。**
> 5. **本文那条 T3 追加自己漂了**（同一族，就地登记）：那句写着「终态坐标：DOM 半句 `ProChartPanels.test.tsx:388`、存储半句 `:390`」——这两个号在 `e69aba57` 那版上逐字成立（本席现读该版比对），而本片后续一笔（`33ff7ede`，把数圈数改成条件等待）在**同一棵测试文件**上净 12 增／6 删，今天同一处代码落在 DOM 半句 `:390-391`、存储半句 `:395`（`await waitFor(` 在 `:394`）。**「终态」这个词就是缺陷本体**：一笔还在进行的分支里不存在终态坐标。复算配方（谁也别抄上面任何一号）＝`grep -n "mock-close-workbench" frontend/src/pages/__tests__/ProChartPanels.test.tsx` 取工作台那枚 handle 的行，存储那半句在同一根针的 `waitFor` 块体内。

> **2026-10-16 追加（判据更正，不覆盖上文）**：Task 2 Step 3 那句「行号引用在改后仍指 281——本处改动全在 281 之后」（按**条目**认，别认号；本追加前它在 `:435`）**两个半句都被本片自己的落地打脸**。凭据（三条都可现跑）：`git show 92087084:frontend/src/pages/ProChart.tsx` 第 281 行逐字＝`    const raw = localStorage.getItem(SESSION_KEY);`；同一串在 `git show 49fe9208:frontend/src/pages/ProChart.tsx` 落到第 **282** 行；落地注释 `frontend/src/pages/ProChart.tsx:622` 写的也是「见 282 行」。后半句「本处改动全在 281 之后」更不成立——本片自己的 import 落在同一文件 `:116`（`import { loadPanelVisibility, savePanelVisibility } from "@/lib/chartPanels";`），**在 281 之前**。⇒ 口径补一条：**同一文件里，改点之前的行同样会位移它之后的所有行号**；写「本处改动全在某行之后」这类断言之前，先 `git diff --uniform=0` 数一遍本片在该文件一共动了几处、各自在哪一行，别只想着自己那一处。本片矩阵侧已经按纪律登记了 ＋1／＋14／＋15 三个位移档（`docs/forensics/gap-matrix.md` 开头那条「口径」bullet），计划这一句没登记。落点选文件末尾的原因照上几段既有说明：本计划已有按行号自指的末尾追加段，中间插行会挪掉它们说过的号。
