# 画线扩展 · 磁吸 · 图例 实现计划（推荐清单第 ③ 片）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to execute this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 `/pro-chart` 的画线面补 7 件库内置工具、加一挡磁吸、把图例的五个库开关做成可关可开的偏好，并为标注补上文字。

**Architecture:** 全部走 klinecharts 10.0.3 的公开 API 面，不改库、不 patch、不自绘 canvas。画线侧的两个新维度（`dim`/`hasText`）落在 `lib/chartDrawings.ts` 的 `DRAW_TOOLS` 表上，由 `toolCreateExtras()` 这一个函数同时供给「建线」与「恢复」两个入口；磁吸是 overlay 实例上的 `mode` 键，批量改走 `overrideOverlay({id, mode})`；图例是纯样式，新增 `lib/chartLegend.ts` 产出一份「只含 show / showRule / template 三类键」的片段，由 `chartStyles()` 唯一合成点并进整份样式，主题 effect 的依赖里必须带上它。

**Tech Stack:** React 19 + TypeScript + Vite + Vitest（jsdom）+ klinecharts 10.0.3 + Tailwind。

**Spec:** `docs/superpowers/specs/2026-10-07-drawings-magnet-legend-design.md` —— 本计划每条判据都从它论证。实现前先读它的 §二（决定性事实，带库坐标）、§三（方案裁定 A/B/C/D）、§五（错误处理与边界）、§六（测试与验收）。§二的表格里 `KC` = `frontend/node_modules/klinecharts/dist/index.esm.js`，`KD` = 同目录 `index.d.ts`。

## Global Constraints

- 只改前端。`agent/**`、`api_server*`、后端 Python、`node_modules/**` 本片零改动；`git diff --name-only <base>..HEAD -- agent` 必须是空。
- 不新增依赖、不 patch 库、不改 `node_modules`、不自绘 canvas、不新增环境变量。
- **默认态逐像素不变**（spec §一）：新偏好的默认值逐项等于库默认；未偏离默认的键一律不落盘（`mode: "normal"` 不写、空 `text` 不写、默认样式不写、图例不改时 `pro-chart.legend.v1` 不出现）。
- `overrideOverlay` 的返回值**永远不当判决**：`shouldUpdate()`（`KC:8314-8318`）只看 `zLevel/points/visible/extendData/styles`，只改 `mode` 或 `lock` 会返回 `false` 而改动已生效（spec §二.4）。要判成败读实例（照 `applyDrawingFlags` 的读回写法）。
- 任何「按名字遍历 `getOverlays()` 再批量 override」的代码必须先 `toolOf(name)` 过滤、并跳过 `isInProgress`——Pine 的线只有 `dataIndex`、不在 `DRAW_TOOLS` 里，摸它就是把脚本图层改成用户偏好（spec §二.6）。
- 任何「读 overlay 再落盘」的路径必须先过 `ProChart.tsx` 里的 `hideFree`——回放造成的 `visible:false` 是视图态，不是用户偏好（spec §二.9）。
- 图例样式片段里**一个颜色键都不写**：`{change}` 的取色本来就来自 `candle.priceMark.last`，本片不碰主题面（spec §二.12 末段）。
- 建线附加键只有 `toolCreateExtras()` 一份实现，两个入口共用（spec §三.A）。
- 文案沿用 ProChart 现有硬编码中文面：不新增 locale 键、不动九语言文件（spec §八）。
- 时间戳在本页继续以**毫秒**流动，新代码不得再乘除 1000。
- 每个任务结束时 `cd frontend && npx tsc --noEmit` 必须静默。
- **先探红**：每条新判据先写测试、跑出预期失败、把失败原文逐字留在任务报告里，再实现。不许先实现后补测试。
- 提交一律 `git commit -s` ＋ 显式 pathspec（工作树可能是脏的）；`docs/` 被 `.gitignore:125` 忽略，加 `git add -f`。

## 基线（本轮实测，不是判据；每席开工前自己复跑取当前值）

| 套件 | 本轮读数 | 取数命令（ANSI 必须先剥掉） |
| --- | --- | --- |
| `src/lib/__tests__/chartDrawings.test.ts` | 56 passed | `cd frontend && npx vitest run src/lib/__tests__/chartDrawings.test.ts 2>&1 \| sed 's/\x1b\[[0-9;]*m//g' \| grep -o "Tests  *[0-9]* passed"` |
| `src/lib/__tests__/drawingExchange.test.ts` | 31 passed | 同上换文件 |
| `src/pages/__tests__/ProChartDrawings.test.tsx` | 59 passed | 同上换文件 |

不许变红的连带面（spec §六.6）：`ProChartReplayDrawings.test.tsx`、`ProChartReplay.test.tsx`、`ProChartPaging.test.tsx`、`ProChartTimeShare.test.tsx`、`ProChartMinuteBars.test.tsx`、`MultiChart.test.tsx`、`paneLayout.test.ts`。它们的条数也在漂，改测试时只改**期望的来源**（由 `DRAW_TOOLS` 表长度推导，而不是硬编码数），不放宽判据。

## File Structure

| 文件 | 动作 | 职责 |
| --- | --- | --- |
| `frontend/src/lib/chartDrawings.ts` | 修改 | `DrawTool.dim/hasText`、`DRAW_TOOLS` +7、`toolCreateExtras`、`StoredDrawing.text`、`MAX_DRAWING_TEXT`/`normalizeDrawingText`、serialize/restore 的文字与样式片段、`applyDrawingText`、`MagnetMode`/`loadMagnet`/`saveMagnet`/`applyMagnetMode`、`describeDrawing` 的 dim 分支 |
| `frontend/src/lib/chartLegend.ts` | 新建 | 图例偏好的形状、库默认值、样式片段合成、存储读写与逐键校验（纯模块，无 React） |
| `frontend/src/lib/__tests__/chartLegend.test.ts` | 新建 | 上述全部判据 |
| `frontend/src/lib/drawingExchange.ts` | 修改 | `readDrawing` 认 `text`、`drawingKey` 认 `text`、`DRAWING_BUNDLE_VERSION` 1→2 |
| `frontend/src/pages/ProChart.tsx` | 修改 | `armTool` 送 `toolCreateExtras` 与 `mode`、`restoreDrawings` 三个调用点、磁吸状态与开关 pass、清单行文字输入框、`chartStyles` 第三参与图例面板 |
| `frontend/src/lib/__tests__/chartDrawings.test.ts` | 修改 | 新工具表、dim 行、文字存储、磁吸；替身 `overlay()`/`fakeChart()` 要能承载 `extendData`/`mode` |
| `frontend/src/lib/__tests__/drawingExchange.test.ts` | 修改 | `text` 往返、截断、非字符串丢弃、version 不校验、`drawingKey` 两半 |
| `frontend/src/pages/__tests__/ProChartDrawings.test.tsx` | 修改 | 磁吸按钮与批量 override、标注建线附加键、清单文字输入框；`FakeOverlay` 要能承载 `extendData`/`mode` |
| `frontend/src/pages/__tests__/ProChartLegend.test.tsx` | 新建 | 图例面板五项、改后 `setStyles` 内容、**切主题不冲掉偏好** |
| `frontend/src/pages/__tests__/ProChartTimeShare.test.tsx` | 修改 | 在既有「survives a theme switch」那条上补一句：分时态下切主题，图例偏好也还在（分时那半的回归钉） |

**不新建 hook、不拆 `LegendPanel.tsx` 组件**：图例面板只有五个控件、且必须与 `chartStyles` 同页才能被主题 effect 的依赖数组看见；抽出去只会多一面接线要维护。

---

### Task 1: 七件新工具、`dim`/`hasText` 两维、`toolCreateExtras`、垂直线的清单行

**Files:**
- Modify: `frontend/src/lib/chartDrawings.ts`（`DrawTool` 接口 :107-113、`DRAW_TOOLS` :115-122、`describeDrawing` :692-698、import :1）
- Modify: `frontend/src/pages/ProChart.tsx:1747-1752`（`armTool` 的 `createOverlay`）＋ 其 import 块 :61 附近
- Test: `frontend/src/lib/__tests__/chartDrawings.test.ts`
- Test: `frontend/src/pages/__tests__/ProChartDrawings.test.tsx`

**Interfaces:**
- Consumes: 无新依赖；`getSupportedOverlays` 从 `"klinecharts"` 值导入（测试里），库导出面已核实。
- Produces: `DrawTool.dim?: "time" | "price" | "both"`、`DrawTool.hasText?: boolean`、`toolCreateExtras(name: string): Partial<OverlayCreate>`、扩展后的 `DRAW_TOOLS`（13 件）。Task 2 用 `hasText` 决定读不读 `extendData`；Task 5 把 `toolCreateExtras` 的签名放宽到 `(name, mode)`。

- [ ] **Step 1: 写 lib 层失败测试**

在 `frontend/src/lib/__tests__/chartDrawings.test.ts` 顶部 `describe("tool metadata")` **之前**插入新块，并把 `toolCreateExtras` 加进那个大 import 列表（按字母序放在 `toolOf` 之后）。文件顶部还需要 `import { getSupportedOverlays } from "klinecharts";`：

```ts
/**
 * 第③片 A：七件库内置模板挂上工具栏。名字这一条不抄表——直接问库要注册表，
 * 于是「升级后某模板改名」是测试变红，而不是用户画不出线。
 */
describe("新增工具与建线附加键", () => {
  it("每件工具的名字都是库里真实存在的内置模板", () => {
    const supported = getSupportedOverlays();
    for (const t of DRAW_TOOLS) {
      expect(supported, `${t.name} 不在 klinecharts 内置模板里`).toContain(t.name);
    }
  });

  it("13 件工具，落点数与库的 totalStep 逐行相等", () => {
    expect(DRAW_TOOLS.map((t) => t.name)).toEqual([
      "segment",
      "rayLine",
      "horizontalStraightLine",
      "priceLine",
      "fibonacciLine",
      "brush",
      "straightLine",
      "verticalStraightLine",
      "horizontalSegment",
      "horizontalRayLine",
      "parallelStraightLine",
      "priceChannelLine",
      "simpleAnnotation",
    ]);
    // `totalStep`（spec §二.1 表）减一就是落点数；`brush` 是拖动，-1。
    const clicks: Record<string, number> = {
      segment: 2,
      rayLine: 2,
      horizontalStraightLine: 1,
      priceLine: 1,
      fibonacciLine: 2,
      brush: -1,
      straightLine: 2,
      verticalStraightLine: 1,
      horizontalSegment: 2,
      horizontalRayLine: 2,
      parallelStraightLine: 3,
      priceChannelLine: 3,
      simpleAnnotation: 1,
    };
    for (const t of DRAW_TOOLS) expect(t.clicks, t.name).toBe(clicks[t.name]);
  });

  it("只有垂直线是纯时间的，只有标注带文字", () => {
    expect(toolOf("verticalStraightLine")?.dim).toBe("time");
    expect(toolOf("simpleAnnotation")?.hasText).toBe(true);
    for (const t of DRAW_TOOLS) {
      if (t.name === "verticalStraightLine" || t.name === "simpleAnnotation") continue;
      expect(t.dim, t.name).toBeUndefined();
      expect(t.hasText, t.name).toBeUndefined();
    }
  });

  it("toolCreateExtras 只给带文字的线补默认锚点图元", () => {
    expect(toolCreateExtras("simpleAnnotation")).toEqual({ needDefaultPointFigure: true });
    expect(toolCreateExtras("priceLine")).toEqual({});
    expect(toolCreateExtras("nope")).toEqual({});
  });

  it("垂直线的清单行不印价位，价格线照旧", () => {
    const ts = 1_700_000_000_000;
    const v = describeDrawing(
      overlay({ id: "v", name: "verticalStraightLine", points: [{ timestamp: ts, value: 1300 }] }),
    );
    expect(v?.detail).toBe(formatBarTime(ts));
    expect(v?.detail).not.toContain("价位");
    const p = describeDrawing(overlay({ id: "p", name: "priceLine", points: [{ timestamp: ts, value: 1300 }] }));
    expect(p?.detail).toContain("价位 1300");
  });
});
```

- [ ] **Step 2: 跑一次，确认它红**

Run: `cd frontend && npx vitest run src/lib/__tests__/chartDrawings.test.ts`
Expected: FAIL。形如 `AssertionError: expected [ 'segment', …(6) ] to deeply equal [ 'segment', …(13) ]`，以及 `toolCreateExtras is not a function`。**把失败原文逐字贴进报告**。

- [ ] **Step 3: 实现 lib 层**

`chartDrawings.ts:1` 改成 `import type { Chart, OverlayCreate } from "klinecharts";`。

`DrawTool` 接口整体替换为：

```ts
export interface DrawTool {
  label: string;
  /** A KLineChart v10 built-in overlay name (see `getSupportedOverlays()`). */
  name: string;
  /** Clicks the user has to make; drives the hint text. */
  clicks: number;
  /**
   * Does this line's `value` mean price at all? A vertical line only carries a
   * bar, so `describeDrawing` calling its number a 价位 would be a lie. Absent
   * means "both axes apply"; `"price"` is reserved for a future axis-only tool.
   */
  dim?: "time" | "price" | "both";
  /** The line's words come from `extendData`, so the list owes it a text box. */
  hasText?: boolean;
}
```

`DRAW_TOOLS` 整体替换为（注释保留原有那条）：

```ts
export const DRAW_TOOLS: DrawTool[] = [
  { label: "趋势线", name: "segment", clicks: 2 },
  { label: "射线", name: "rayLine", clicks: 2 },
  { label: "水平线", name: "horizontalStraightLine", clicks: 1 },
  { label: "价格线", name: "priceLine", clicks: 1 },
  { label: "斐波那契", name: "fibonacciLine", clicks: 2 },
  { label: "画笔", name: "brush", clicks: -1 }, // freehand: drag, double-click to finish
  { label: "直线", name: "straightLine", clicks: 2 },
  { label: "垂直线", name: "verticalStraightLine", clicks: 1, dim: "time" },
  { label: "水平线段", name: "horizontalSegment", clicks: 2 },
  { label: "水平射线", name: "horizontalRayLine", clicks: 2 },
  { label: "平行线", name: "parallelStraightLine", clicks: 3 },
  { label: "价格通道", name: "priceChannelLine", clicks: 3 },
  { label: "标注", name: "simpleAnnotation", clicks: 1, hasText: true },
];
```

紧跟 `toolOf` 之后新增（`drawHint` 不动：它按 `clicks` 生成，新行不需要改文案）：

```ts
/**
 * The `createOverlay` keys a tool needs beyond name/paneId/points/styles.
 *
 * `simpleAnnotation` draws three figures and marks every one of them
 * `ignoreEvent: true` (dist 12466-12516), and `needDefaultPointFigure` is false
 * in the constructor (dist 8245) — so an annotation straight from the template
 * is inert: unclickable, undraggable, and undeletable by right-click. Asking the
 * library for its default point figures (dist 8245 / `KD:1094`) is the only
 * public way to give it a hit target.
 *
 * One implementation, both entry points (`armTool` and `restoreDrawings`): if
 * only one entry asked, a drawn annotation would be editable and a restored one
 * would not, which is the same asymmetry ⑮ had to fix for events.
 */
export function toolCreateExtras(name: string): Partial<OverlayCreate> {
  return toolOf(name)?.hasText === true ? { needDefaultPointFigure: true } : {};
}
```

`describeDrawing` 里的价位分支加 dim 门（原 :692-698）：

```ts
  // A vertical line's `value` is whatever the click happened to land on; the
  // tool is pure time (`DrawTool.dim`), so printing it as a price is a lie.
  if (values.length > 0 && toolOf(name)?.dim !== "time") {
    // "价位" on a MACD pane is the same lie as the invisible line: the number is
    // real and the reader's unit is wrong (⑭, again, in the reporting half).
    const unit = paneId === MAIN_PANE_ID ? "价位" : "值";
    const first = formatPrice(values[0]);
    bits.push(values.length === 1 ? `${unit} ${first}` : `${first} → ${formatPrice(values[values.length - 1])}`);
  }
```

- [ ] **Step 4: 跑 lib 层，确认它绿**

Run: `cd frontend && npx vitest run src/lib/__tests__/chartDrawings.test.ts`
Expected: 全部 PASS，条数 = Step 2 那次读数 + 5。

- [ ] **Step 5: 写页面层失败测试**

`ProChartDrawings.test.tsx` 里，`describe("/pro-chart 画线")`（就是含 `mountChart()` 那组）末尾追加：

```tsx
  it("标注在建线那一刻就要到默认锚点图元，其余不送", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "标注" }));
    const arg = h.chart?.createOverlay.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(arg.needDefaultPointFigure).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "水平线" }));
    const plain = h.chart?.createOverlay.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(plain).not.toHaveProperty("needDefaultPointFigure");
  });
```

Run: `cd frontend && npx vitest run src/pages/__tests__/ProChartDrawings.test.tsx -t 标注在建线`
Expected: FAIL，`AssertionError: expected undefined to be true`。留原文。

- [ ] **Step 6: 接线 `armTool`**

`ProChart.tsx` 的 import 块里（`DRAW_TOOLS` 同组，:61 附近）加 `toolCreateExtras`。`armTool` 的 `createOverlay` 调用（:1747-1752）改为：

```ts
    chart.createOverlay({
      name,
      paneId: MAIN_PANE_ID,
      styles: overlayStylesOf(drawStyleRef.current),
      ...toolCreateExtras(name),
      ...drawingEvents(),
    });
```

- [ ] **Step 7: 跑页面层与门禁**

Run: `cd frontend && npx vitest run src/pages/__tests__/ProChartDrawings.test.tsx && npx tsc --noEmit`
Expected: 全部 PASS（含既有的「画线工具全在工具栏上」那条，它由 `DRAW_TOOLS.map` 驱动，自动覆盖 13 件）；tsc 静默。
再跑连带面确认没被表格变长撞倒：`npx vitest run src/pages/__tests__/MultiChart.test.tsx src/pages/__tests__/ProChartTimeShare.test.tsx src/pages/__tests__/ProChartMinuteBars.test.tsx`，全绿。

- [ ] **Step 8: 提交**

```bash
cd /e/Vibe-Trading-main/Vibe-Trading-main
git add -- frontend/src/lib/chartDrawings.ts frontend/src/pages/ProChart.tsx \
  frontend/src/lib/__tests__/chartDrawings.test.ts frontend/src/pages/__tests__/ProChartDrawings.test.tsx
git commit -s -m "$(cat <<'EOF'
feat(drawings): DRAW_TOOLS 挂上 7 件库内置模板，工具表加 dim/hasText 两维

垂直线的清单行不再印「价位」（它的 value 只是鼠标落在哪，没有时间以外的含义），
标注建线时经 toolCreateExtras 统一要到 needDefaultPointFigure——模板的三段图元全带
ignoreEvent，不补锚点图元就是一条点不中、拖不动、右键也删不掉的惰性对象。
工具名不再抄表，测试直接问 getSupportedOverlays() 要注册表。
EOF
)"
```

---

### Task 2: 标注文字的存储贯通（`StoredDrawing.text`、`extendData` 往返、恢复补默认样式）

**Files:**
- Modify: `frontend/src/lib/chartDrawings.ts`（`StoredDrawing` :255-265、`OverlayLike` :273-282、`serializeDrawings` :305-330、`restoreDrawings` :515-548、新常量/函数）
- Test: `frontend/src/lib/__tests__/chartDrawings.test.ts`（含替身 `overlay()` :71-87 与 `fakeChart()` :89-175 扩键）

**Interfaces:**
- Consumes: Task 1 的 `toolOf(...)?.hasText`、`toolCreateExtras(name)`、`DEFAULT_DRAWING_STYLE`、`overlayStylesOf`。
- Produces: `MAX_DRAWING_TEXT = 40`、`normalizeDrawingText(raw: unknown): string | undefined`、`StoredDrawing.text?: string`；`serializeDrawings` 对 `hasText` 工具读 `extendData`；`restoreDrawings` 送 `extendData` ＋ `toolCreateExtras` ＋（`hasText` 且无落盘样式时）默认样式片段。Task 3 用 `normalizeDrawingText`，Task 4 用 `StoredDrawing.text`。

- [ ] **Step 1: 扩替身（先让它能承载）**

`chartDrawings.test.ts` 的 `interface FakeOverlay`（:53-69）在 `visible?: boolean;` 之后加两行，并给 `overlay()` 的默认对象补上库默认值：

```ts
  // `extendData` is what `simpleAnnotation` prints (dist 12466-12478); the
  // library default is undefined, `OverlayImp`'s constructor does not seed it.
  extendData?: unknown;
  // `mode` is the magnet key: 'normal' | 'weak_magnet' | 'strong_magnet'
  // (dist 8248, `KD:988`). A live instance always carries it.
  mode?: string;
```

`overlay()`（:71-87）的默认对象里 `visible: true,` 之后加 `mode: "normal",`（`OverlayImp` 构造的默认值，dist 8248）。

`fakeChart()` 的 `createOverlay`（:99-…）形参类型加 `mode?: string; extendData?: unknown; needDefaultPointFigure?: boolean;`，push 的 `overlay({...})` 里补：

```ts
          ...(typeof v.mode === "string" ? { mode: v.mode } : {}),
          ...("extendData" in v ? { extendData: v.extendData } : {}),
          ...("needDefaultPointFigure" in v ? { needDefaultPointFigure: v.needDefaultPointFigure } : {}),
```

并把 `FakeOverlay` 加 `needDefaultPointFigure?: boolean;`。

`fakeChart()` 的 `overrideOverlay`（:127-…）形参类型加 `mode?: string; extendData?: unknown;`，合并分支里补两行，**并且把 `extendData` 计入重绘判决、`mode` 不计入**（这正是 `shouldUpdate()` 的实际行为，`KC:8314-8318`）：

```ts
        if ("mode" in v) target.mode = v.mode;
        if ("extendData" in v) target.extendData = v.extendData;
```

在该分支已有的 `draw = draw || ...` 表达式里追加一项 `|| prevExtendData !== target.extendData`（`prevExtendData` 在改动前和 `prevStyles` 一起捕获）。

- [ ] **Step 2: 写失败测试**

`chartDrawings.test.ts` 追加（`normalizeDrawingText`、`MAX_DRAWING_TEXT` 加进 import 列表）：

```ts
/**
 * 第③片 D：标注的文字。`extendData` 是库给 `simpleAnnotation` 的文案通道
 * （dist 12466-12478），本仓要让它跟着线走。
 */
describe("标注文字的存储", () => {
  const ts = 1_700_000_000_000;
  const dot = [{ timestamp: ts, value: 1300 }];

  it("带文字的标注落盘带 text，空白文字与别的工具都不落盘", () => {
    const rows = serializeDrawings([
      overlay({ id: "a", name: "simpleAnnotation", points: dot, extendData: "前高" }),
      overlay({ id: "b", name: "simpleAnnotation", points: dot, extendData: "   " }),
      overlay({ id: "c", name: "priceLine", points: dot, extendData: "不该被读" }),
    ]);
    expect(rows.map((r) => r.text)).toEqual(["前高", undefined, undefined]);
    expect(rows[1]).not.toHaveProperty("text");
    expect(rows[2]).not.toHaveProperty("text");
  });

  it("extendData 是函数时不崩也不落盘", () => {
    const rows = serializeDrawings([
      overlay({ id: "a", name: "simpleAnnotation", points: dot, extendData: () => "x" }),
    ]);
    expect(rows[0]).not.toHaveProperty("text");
  });

  it("超长文字截到 40 个字符", () => {
    const long = "字".repeat(45);
    const rows = serializeDrawings([overlay({ id: "a", name: "simpleAnnotation", points: dot, extendData: long })]);
    expect(rows[0]?.text).toBe(long.slice(0, MAX_DRAWING_TEXT));
    expect(MAX_DRAWING_TEXT).toBe(40);
  });

  it("normalizeDrawingText 只认字符串、去空白、截断", () => {
    expect(normalizeDrawingText("  前高  ")).toBe("前高");
    expect(normalizeDrawingText("")).toBeUndefined();
    expect(normalizeDrawingText("   ")).toBeUndefined();
    expect(normalizeDrawingText(7)).toBeUndefined();
    expect(normalizeDrawingText(null)).toBeUndefined();
    expect(normalizeDrawingText(undefined)).toBeUndefined();
    expect(normalizeDrawingText("字".repeat(41))?.length).toBe(40);
  });

  it("恢复把文字送回 extendData，并与建线共用 toolCreateExtras", () => {
    const chart = fakeChart();
    restoreDrawings(chart, [
      { name: "simpleAnnotation", paneId: MAIN_PANE_ID, points: dot, text: "前高" },
    ]);
    const arg = chart.createOverlay.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(arg.extendData).toBe("前高");
    expect(arg.needDefaultPointFigure).toBe(true);
  });

  it("没落盘样式的标注恢复时是实线，价格线仍不落样式（§二.11 两半）", () => {
    const a = fakeChart();
    restoreDrawings(a, [{ name: "simpleAnnotation", paneId: MAIN_PANE_ID, points: dot }]);
    const argA = a.createOverlay.mock.calls.at(-1)?.[0] as { styles?: { line?: { style?: string } } };
    expect(argA.styles?.line?.style).toBe("solid");

    const b = fakeChart();
    restoreDrawings(b, [{ name: "priceLine", paneId: MAIN_PANE_ID, points: dot }]);
    const argB = b.createOverlay.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(argB).not.toHaveProperty("styles");
  });

  it("落盘了样式的标注仍用落盘的那份，不被默认片段盖掉", () => {
    const chart = fakeChart();
    restoreDrawings(chart, [
      { name: "simpleAnnotation", paneId: MAIN_PANE_ID, points: dot, style: { color: "#F23645", size: 2, dashed: true } },
    ]);
    const arg = chart.createOverlay.mock.calls.at(-1)?.[0] as { styles: { line: Record<string, unknown> } };
    expect(arg.styles.line).toMatchObject({ color: "#F23645", size: 2, style: "dashed" });
  });

  it("无文字的线一个键都不多写（默认态不落盘）", () => {
    const chart = fakeChart();
    restoreDrawings(chart, [{ name: "segment", paneId: MAIN_PANE_ID, points: dot }]);
    const arg = chart.createOverlay.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(arg).not.toHaveProperty("extendData");
    expect(arg).not.toHaveProperty("needDefaultPointFigure");
    expect(arg).not.toHaveProperty("styles");
  });
});
```

- [ ] **Step 3: 跑一次，确认它红**

Run: `cd frontend && npx vitest run src/lib/__tests__/chartDrawings.test.ts -t 标注文字的存储`
Expected: FAIL（`normalizeDrawingText is not a function` / `expected undefined to be '前高'`）。留原文。

- [ ] **Step 4: 实现 lib 层**

`StoredDrawing`（:255-265）加：

```ts
  /**
   * An annotation's words — `overlay.extendData` for a `hasText` tool, and only
   * for that class. Absent means the template's own (empty) text.
   */
  text?: string;
```

`OverlayLike`（:273-282）加 `extendData?: unknown;`。

在 `DEFAULT_DRAWING_STYLE` 之后新增：

```ts
/** What an annotation's text box accepts; longer gets cut, not refused. */
export const MAX_DRAWING_TEXT = 40;

/**
 * The storable form of an annotation's text: trimmed, capped, or absent.
 *
 * `extendData` is `unknown` by contract (`KD:1118`) and the template also
 * accepts a **function** (dist 12470), which is a rendering callback, not text —
 * storing `String(fn)` would bank a wall of source code as a label. Only a real
 * string survives.
 */
export function normalizeDrawingText(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.trim();
  if (!text) return undefined;
  return text.length > MAX_DRAWING_TEXT ? text.slice(0, MAX_DRAWING_TEXT) : text;
}
```

`serializeDrawings` 的 `out.push({...})` 前算一行、对象里加一项：

```ts
    const text = toolOf(o.name)?.hasText ? normalizeDrawingText(o.extendData) : undefined;
    out.push({
      name: o.name,
      paneId: o.paneId ?? MAIN_PANE_ID,
      points,
      ...(style ? { style } : {}),
      ...(text ? { text } : {}),
      // Flags are only written when they deviate from the library default, so a
      // plain line keeps costing exactly what it costed before ⑰.
      ...(o.lock === true ? { lock: true as const } : {}),
      ...(o.visible === false ? { hidden: true as const } : {}),
    });
```

`restoreDrawings` 的 `createOverlay` 调用（:535-543）改为——注意样式与文字两条都要注释交代为什么存在：

```ts
    // `simpleAnnotation`'s template pins `styles.line.style: 'dashed'`
    // (dist 12465-12469) and `override` merges the caller's fragment *over* it
    // (dist 8288-8291). `armTool` always sends an explicit solid, so a stored
    // annotation that never had a style would come back dashed after a reload —
    // and the next edit would bank that dashed as the user's own preference.
    // Only the `hasText` class gets the default fragment; the other twelve
    // templates pin no `line.style`, so they must keep costing nothing.
    const styles = d.style
      ? overlayStylesOf(d.style)
      : toolOf(d.name)?.hasText === true
        ? overlayStylesOf(DEFAULT_DRAWING_STYLE)
        : undefined;
    const id = chart.createOverlay({
      name: d.name,
      paneId,
      points,
      ...(styles ? { styles } : {}),
      ...(d.text ? { extendData: d.text } : {}),
      ...(d.lock ? { lock: true } : {}),
      ...(d.hidden ? { visible: false } : {}),
      ...toolCreateExtras(d.name),
      ...events,
    });
```

- [ ] **Step 5: 跑 lib 层与存储面连带，确认绿**

Run: `cd frontend && npx vitest run src/lib/__tests__/chartDrawings.test.ts src/lib/__tests__/drawingExchange.test.ts`
Expected: 全绿。**注意**：`ProChartDrawings.test.tsx` 里有一条对整份桶 JSON 的 `toEqual` 精确断言——它不该被本片影响（无 `text` 的线不落 `text` 键），若它红了就是实现多写了键，改实现而不是改那条断言。

- [ ] **Step 6: 提交**

```bash
git add -- frontend/src/lib/chartDrawings.ts frontend/src/lib/__tests__/chartDrawings.test.ts
git commit -s -m "$(cat <<'EOF'
feat(drawings): StoredDrawing.text 贯通 extendData 往返，恢复时给标注补默认样式

标注模板把 line.style 钉成 dashed，而默认样式从不落盘：不设防的话「画时实线、
刷新后虚线」，再被下一次编辑把 dashed 记成用户偏好（spec §二.11）。片段只补
hasText 这一类，其余十二件模板不钉这个键，继续一个样式键都不写。
extendData 也接受函数（渲染回调），那不是文字，只认字符串。
EOF
)"
```

---

### Task 3: 交换面认文字（`readDrawing`、`drawingKey`、bundle v2）＋ `applyDrawingText`

**Files:**
- Modify: `frontend/src/lib/drawingExchange.ts`（`DRAWING_BUNDLE_VERSION` :49、`readDrawing` :93-120、`drawingKey` :238-240、import :28-37）
- Modify: `frontend/src/lib/chartDrawings.ts`（新增 `applyDrawingText`）
- Test: `frontend/src/lib/__tests__/drawingExchange.test.ts`、`frontend/src/lib/__tests__/chartDrawings.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `normalizeDrawingText`、`StoredDrawing.text`。
- Produces: `DRAWING_BUNDLE_VERSION = 2`、带 `text` 的 `readDrawing` 输出、认 `text` 的 `drawingKey`、`applyDrawingText(chart, id, text): string | null`（Task 4 的输入框用它）。

- [ ] **Step 1: 写失败测试（交换面）**

`drawingExchange.test.ts` 追加（`DRAWING_BUNDLE_VERSION`、`normalizeDrawingText` 不需要，前者从本模块导出，加进 import 列表）：

```ts
/**
 * 第③片 D 的交换面。读侧本来就不校验 version（`resolveList` 只看 `drawings`），
 * 所以 bump 只是自我描述：老文件必须照进，新文件被老版本读时丢的是文字、不是线。
 */
describe("标注文字过交换", () => {
  const base = (patch: Partial<StoredDrawing> = {}): StoredDrawing => ({
    name: "simpleAnnotation",
    paneId: MAIN_PANE_ID,
    points: [{ timestamp: T0, value: 1300 }],
    ...patch,
  });

  it("文件里文字往返一致", () => {
    const json = exportDrawingsJson([base({ text: "前高" })], { symbol: "600519.SH", interval: "1D" });
    const out = importDrawingsJson(json);
    expect(out.ok && out.drawings[0]?.text).toBe("前高");
  });

  it("超过 40 字截断，非字符串丢弃，空串不落键", () => {
    const json = JSON.stringify({
      kind: DRAWING_BUNDLE_KIND,
      version: DRAWING_BUNDLE_VERSION,
      drawings: [
        base({ text: "字".repeat(45) }),
        { ...base(), text: 7 },
        { ...base(), text: "   " },
      ],
    });
    const out = importDrawingsJson(json);
    if (!out.ok) throw new Error(out.error);
    expect(out.drawings[0]?.text).toBe("字".repeat(40));
    expect(out.drawings[1]).not.toHaveProperty("text");
    expect(out.drawings[2]).not.toHaveProperty("text");
    expect(out.skipped).toEqual([]);
  });

  it("version 写 1／2／99／没有都能导入", async () => {
    for (const version of [1, 2, 99, undefined]) {
      const json = JSON.stringify({ kind: DRAWING_BUNDLE_KIND, ...(version === undefined ? {} : { version }), drawings: [base({ text: "前高" })] });
      const out = importDrawingsJson(json);
      expect(out.ok && out.drawings[0]?.text).toBe("前高");
    }
    expect(DRAWING_BUNDLE_VERSION).toBe(2);
  });

  it("同点同名的两条标注，文字不同就不是同一条线", () => {
    const a = base({ text: "前高" });
    const b = base({ text: "前低" });
    expect(drawingKey(a)).not.toBe(drawingKey(b));
    const merged = mergeDrawings([a], [b]);
    expect(merged.added).toBe(1);
    expect(merged.duplicates).toBe(0);
  });

  it("没有文字的线键形一字不改（防把全仓去重键换掉）", () => {
    expect(drawingKey(base())).toBe(`${MAIN_PANE_ID}|simpleAnnotation|${T0}:1300`);
    expect(drawingKey({ name: "priceLine", paneId: MAIN_PANE_ID, points: [{ timestamp: T0, value: 1300 }] })).toBe(
      `${MAIN_PANE_ID}|priceLine|${T0}:1300`,
    );
  });
});
```

Run: `cd frontend && npx vitest run src/lib/__tests__/drawingExchange.test.ts -t 标注文字过交换`
Expected: FAIL（`expected undefined to be '前高'`）。留原文。

- [ ] **Step 2: 实现交换面**

`drawingExchange.ts:49` 改 `export const DRAWING_BUNDLE_VERSION = 2;`。
import 列表加 `normalizeDrawingText`。
`readDrawing` 的返回对象加一条（放在 `style` 之后、`lock` 之前）：

```ts
      ...(text ? { text } : {}),
```

并在 `const style = normalizeDrawingStyle(o.style);` 之后加：

```ts
  // Key-by-key rebuild (the header's anti-prototype-pollution rule) means a
  // file's `text` only survives if this line asks for it; `normalizeDrawingText`
  // is the same cap the chart itself applies, so an import cannot smuggle a
  // longer label past it.
  const text = normalizeDrawingText(o.text);
```

`drawingKey` 整体替换：

```ts
/**
 * Identity of a line: pane + tool + geometry (+ an annotation's words).
 * Colour, width and the lock/hide flags are **not** part of it — restyling and
 * re-importing must not double up. The pane *is* (⑲): the same two points on the
 * price chart and on MACD are two different lines.
 *
 * Text joins the key only when a line actually has some (spec §五.8): two
 * annotations on the same bar that say different things are not the same line,
 * and without this the second one would be swallowed as a duplicate on import.
 * A line without text keeps its old key shape byte for byte.
 */
export function drawingKey(d: StoredDrawing): string {
  const base = `${d.paneId || MAIN_PANE_ID}|${d.name}|${d.points.map((p) => `${p.timestamp}:${p.value ?? ""}`).join(",")}`;
  return d.text ? `${base}|${d.text}` : base;
}
```

- [ ] **Step 3: 写 `applyDrawingText` 的失败测试**

`chartDrawings.test.ts` 追加（import 加 `applyDrawingText`）：

```ts
describe("改掉一条标注的文字", () => {
  it("指名道姓地 override，并把读回的文字交回去", () => {
    const chart = fakeChart([
      overlay({ id: "a", name: "simpleAnnotation", points: [{ timestamp: 1_700_000_000_000, value: 1300 }], extendData: "前高" }),
    ]);
    expect(applyDrawingText(chart, "a", "前低")).toBe("前低");
    expect(chart.overrideOverlay.mock.calls).toEqual([[{ id: "a", extendData: "前低" }]]);
    expect(chart.overlays[0].extendData).toBe("前低");
  });

  it("清空文字回空串；id 空或线不存在都不动图", () => {
    const chart = fakeChart([overlay({ id: "a", name: "simpleAnnotation" })]);
    expect(applyDrawingText(chart, "a", "   ")).toBe("");
    expect(applyDrawingText(chart, "", "x")).toBeNull();
    expect(applyDrawingText(chart, "zz", "x")).toBeNull();
  });

  it("超长输入截到上限再写进去", () => {
    const chart = fakeChart([overlay({ id: "a", name: "simpleAnnotation" })]);
    const out = applyDrawingText(chart, "a", "字".repeat(50));
    expect(out?.length).toBe(40);
    expect(chart.overlays[0].extendData).toBe("字".repeat(40));
  });
});
```

Run: `cd frontend && npx vitest run src/lib/__tests__/chartDrawings.test.ts -t 改掉一条标注的文字`
Expected: FAIL（`applyDrawingText is not a function`）。留原文。

- [ ] **Step 4: 实现 `applyDrawingText`**

`chartDrawings.ts` 里紧跟 `applyDrawingFlags` 之后：

```ts
/**
 * Set one annotation's words, and read them back.
 *
 * Unlike `mode` and `lock`, `extendData` **is** in `shouldUpdate()`
 * (dist 8314-8318), so this one does repaint — but the verdict is still the
 * instance, not the boolean: an id that matches nothing and an id that matched
 * are both answers `overrideOverlay` gives, and the caller has to know which
 * happened before it re-reads the list. `""` means "no text" (the template draws
 * no label for it, and `serializeDrawings` then drops the key).
 *
 * Returns null when there is no such overlay; the normalized text otherwise.
 */
export function applyDrawingText(chart: OverlayHost, id: string, text: string): string | null {
  if (!id) return null;
  const next = normalizeDrawingText(text) ?? "";
  chart.overrideOverlay({ id, extendData: next });
  const current = chart.getOverlays({ id })[0] as { extendData?: unknown } | undefined;
  if (!current) return null;
  return normalizeDrawingText(current.extendData) ?? "";
}
```

- [ ] **Step 5: 跑两套 lib 测试**

Run: `cd frontend && npx vitest run src/lib/__tests__/chartDrawings.test.ts src/lib/__tests__/drawingExchange.test.ts && npx tsc --noEmit`
Expected: 全绿、tsc 静默。

- [ ] **Step 6: 提交**

```bash
git add -- frontend/src/lib/drawingExchange.ts frontend/src/lib/chartDrawings.ts \
  frontend/src/lib/__tests__/drawingExchange.test.ts frontend/src/lib/__tests__/chartDrawings.test.ts
git commit -s -m "$(cat <<'EOF'
feat(drawings): 交换面认 text，bundle 版本 1→2，导入去重键按文字分开

读侧本来就不校验 version，bump 只是自我描述：老文件照常导入，新文件被老版本读时
丢掉的是文字而不是线。同点同名的两条标注不是一根线，所以 text 非空才追加进
drawingKey——没有文字的线键形逐字不变。
EOF
)"
```

---

### Task 4: 清单行的文字输入框（`DrawingRow.text` ＋ 页面 handler）

**Files:**
- Modify: `frontend/src/lib/chartDrawings.ts`（`DrawingRow` :631-646、`describeDrawing` :699-709、`OverlayLike`）
- Modify: `frontend/src/pages/ProChart.tsx`（清单行 :2320-2385、新增 handler 于 `flagDrawing` :1801 附近）
- Test: `frontend/src/lib/__tests__/chartDrawings.test.ts`、`frontend/src/pages/__tests__/ProChartDrawings.test.tsx`（含 `FakeOverlay`/替身扩 `extendData`）

**Interfaces:**
- Consumes: Task 3 的 `applyDrawingText`；Task 2 的 `normalizeDrawingText`。
- Produces: `DrawingRow.text?: string`（仅 `hasText` 且非空时出现）、`ProChart` 的 `setDrawingText(id, text)`。

- [ ] **Step 1: lib 层失败测试**

```ts
describe("清单行带出标注文字", () => {
  it("hasText 工具的行带出 text，其余工具不带", () => {
    const dot = [{ timestamp: 1_700_000_000_000, value: 1300 }];
    const a = describeDrawing(overlay({ id: "a", name: "simpleAnnotation", points: dot, extendData: "前高" }));
    expect(a?.text).toBe("前高");
    const b = describeDrawing(overlay({ id: "b", name: "simpleAnnotation", points: dot }));
    expect(b).toBeTruthy();
    expect(b).not.toHaveProperty("text");
    const c = describeDrawing(overlay({ id: "c", name: "priceLine", points: dot, extendData: "不该出现" }));
    expect(c).not.toHaveProperty("text");
  });
});
```

Run: `cd frontend && npx vitest run src/lib/__tests__/chartDrawings.test.ts -t 清单行带出标注文字` → FAIL（`expected undefined to be '前高'`）。

- [ ] **Step 2: 实现 lib 层**

`DrawingRow`（:631-646）在 `pointCount` 前加：

```ts
  /**
   * An annotation's words, present only when this row's tool is a `hasText` one
   * and the line actually says something — the list panel renders an input box
   * exactly when this is set, so "no text" and "not a text tool" must not
   * collapse into the same shape.
   */
  text?: string;
```

`describeDrawing` 的返回对象里加（放在 `style:` 之后）：

```ts
    // Read through the same normalizer storage uses, so a live instance holding
    // a function (`extendData` also accepts one) never reaches JSX as a child.
    ...(toolOf(name)?.hasText
      ? (() => {
          const text = normalizeDrawingText((o as { extendData?: unknown }).extendData);
          return text ? { text } : {};
        })()
      : {}),
```

- [ ] **Step 3: 扩页面替身并写失败测试**

`ProChartDrawings.test.tsx` 的 `interface FakeOverlay`（:49-72）在 `visible?: boolean;` 之后加：

```ts
  // The annotation's words (第③片 D): `extendData` in the library, `text` here.
  extendData?: unknown;
  // Set only when the caller asked; `simpleAnnotation` needs it to be clickable.
  needDefaultPointFigure?: boolean;
```

`makeOverlay()`（:140-154）不动（`extendData` 默认 undefined 就是库的默认）。`init` 里的 `createOverlay`（:281-308）形参类型加 `extendData?: unknown; needDefaultPointFigure?: boolean;`，`makeOverlay({...})` 里补：

```ts
          ...("extendData" in v ? { extendData: v.extendData } : {}),
          ...("needDefaultPointFigure" in v ? { needDefaultPointFigure: v.needDefaultPointFigure } : {}),
```

`overrideOverlay`（:313-353）形参类型加 `extendData?: unknown;`，合并分支里补一行、并在 `draw` 判决里加一项：

```ts
          if ("extendData" in v) target.extendData = v.extendData;
```

```ts
          draw =
            draw ||
            prevVisible !== target.visible ||
            prevStyles !== target.styles ||
            prevExtendData !== target.extendData ||
            prevPoints !== JSON.stringify(target.points);
```

（`prevExtendData` 与 `prevStyles` 一起在循环开头捕获。）

追加测试（放 `describe("/pro-chart 画线")` 末尾）：

```tsx
  it("标注行有文字输入框，改字即 override 并落盘", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "标注" }));
    finishDrawing({ timestamp: START + 3 * DAY, value: 1300 });
    await flush();
    const id = h.overlays[0].id;

    // The row only earns a text box because the tool says it carries words.
    fireEvent.click(screen.getByRole("button", { name: "画线清单" }));
    const box = (await screen.findByLabelText(`画线文字 ${id}`)) as HTMLInputElement;
    expect(box.value).toBe("");

    fireEvent.change(box, { target: { value: "前高" } });
    await flush();

    const call = h.chart?.overrideOverlay.mock.calls.at(-1)?.[0] as { id?: string; extendData?: unknown };
    expect(call).toEqual({ id, extendData: "前高" });
    const bucket = readBuckets()["600519.SH|1D"] as Array<Record<string, unknown>>;
    expect(bucket[0]?.text).toBe("前高");
  });

  it("非标注的行没有文字输入框", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "价格线" }));
    finishDrawing({ timestamp: START + DAY, value: 1290 });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "画线清单" }));
    await flush();
    expect(screen.queryByLabelText(/^画线文字/)).toBeNull();
  });
```

Run: `cd frontend && npx vitest run src/pages/__tests__/ProChartDrawings.test.tsx -t 标注行有文字输入框` → FAIL（`Unable to find a label with the text of: 画线文字 o1`）。

- [ ] **Step 4: 实现页面层**

`ProChart.tsx` 的 import 块（`applyDrawingFlags`/`applyDrawingStyle` 同组）加 `applyDrawingText`。
`flagDrawing`（:1801-1805）之后加：

```ts
  /**
   * Type an annotation's words. `overrideOverlay` is the channel (the library
   * repaints `extendData` changes — it is one of the keys `shouldUpdate()`
   * watches, dist 8314-8318), and the bank that follows is what puts the text in
   * storage; `syncDrawings` re-reads the rows, so the box keeps showing exactly
   * what the instance holds, including a value truncated to the cap.
   */
  const setDrawingText = (id: string, text: string) => {
    const chart = chartRef.current;
    if (!chart) return;
    if (applyDrawingText(chart, id, text) === null) return;
    syncDrawings(chart);
  };
```

清单行 JSX：在 `pointCount` 那一段之后、行末的删除按钮之前（即 :2356 的 `</button>` 与 :2357 的锁定按钮之间）插入：

```tsx
                {row.text !== undefined && (
                  <input
                    aria-label={`画线文字 ${row.id}`}
                    title={`标注文字（最多 ${MAX_DRAWING_TEXT} 字）：改完即存，刷新还在`}
                    className="w-20 shrink-0 rounded-md border bg-transparent px-1 py-0.5"
                    defaultValue={row.text}
                    key={row.id}
                    onChange={(e) => setDrawingText(row.id, e.target.value)}
                  />
                )}
```

`MAX_DRAWING_TEXT` 加进 import 块。**为什么用 `defaultValue` 而不是 `value`**：`onChange` 每敲一个字就落盘并重读 `drawRows`，受控 `value` 会在截断/去空白之前把光标弹到末尾；非受控 + `key={row.id}` 让输入框只随「哪一行」重建，不随内容重建。（这条要在代码注释里写一句。）

在插入块上方加一行短注释：

```tsx
                // Uncontrolled on purpose: banking re-renders the row on every
                // keystroke, and a controlled `value` would fight the IME.
```

- [ ] **Step 5: 跑全套画线面**

Run: `cd frontend && npx vitest run src/pages/__tests__/ProChartDrawings.test.tsx src/lib/__tests__/chartDrawings.test.ts src/pages/__tests__/ProChartReplayDrawings.test.tsx && npx tsc --noEmit`
Expected: 全绿、tsc 静默。特别检查既有的「没选中线时点颜色不碰图上任何东西」那条（它 `toEqual` 整份存储记录）仍绿——若它红了就是多写了键。

- [ ] **Step 6: 提交**

```bash
git add -- frontend/src/lib/chartDrawings.ts frontend/src/pages/ProChart.tsx \
  frontend/src/lib/__tests__/chartDrawings.test.ts frontend/src/pages/__tests__/ProChartDrawings.test.tsx
git commit -s -m "$(cat <<'EOF'
feat(drawings): 清单行为标注渲染文字输入框，改字即 override 并落盘

DrawingRow.text 只在 hasText 且真有内容时出现，所以「没有文字」与「不是文字工具」
不会塌成同一个形状。输入框非受控：每敲一字就重读行，受控会把 IME 的组合过程打断。
EOF
)"
```

---

### Task 5: 磁吸（偏好 ＋ 批量 override ＋ 三个建线入口 ＋ 工具栏按钮）

**Files:**
- Modify: `frontend/src/lib/chartDrawings.ts`（`toolCreateExtras` 签名、`restoreDrawings` 第 5 参、新存储与批量函数）
- Modify: `frontend/src/pages/ProChart.tsx`（state/ref :455-534、`armTool`、三个 `restoreDrawings` 调用点 :1127 / :1714 / :1864、工具栏 :2138 之后、import 块）
- Test: `frontend/src/lib/__tests__/chartDrawings.test.ts`、`frontend/src/pages/__tests__/ProChartDrawings.test.tsx`（替身再扩 `mode`）

**Interfaces:**
- Consumes: Task 1 的 `toolCreateExtras`、`toolOf`、`isInProgress`。
- Produces: `MagnetMode = "normal" | "strong_magnet"`、`loadMagnet(): MagnetMode`、`saveMagnet(on: boolean): void`、`applyMagnetMode(chart, mode): number`、`toolCreateExtras(name, mode?)`、`restoreDrawings(chart, drawings, events?, paneExists?, mode?)`。

- [ ] **Step 1: lib 层失败测试**

`chartDrawings.test.ts`（import 加 `MagnetMode`、`applyMagnetMode`、`loadMagnet`、`saveMagnet`）：

```ts
/**
 * 第③片 B：磁吸。库里本来就有 `mode`，本仓一行没用过（全仓 grep magnet 零命中）。
 */
describe("磁吸", () => {
  const ts = 1_700_000_000_000;
  const dot = [{ timestamp: ts, value: 1300 }];

  it("偏好读写只有 1/0 两种值，脏值与读不到都回关", () => {
    expect(loadMagnet()).toBe("normal");
    saveMagnet(true);
    expect(localStorage.getItem("pro-chart.magnet.v1")).toBe("1");
    expect(loadMagnet()).toBe("strong_magnet");
    saveMagnet(false);
    expect(localStorage.getItem("pro-chart.magnet.v1")).toBe("0");
    localStorage.setItem("pro-chart.magnet.v1", "weak_magnet");
    expect(loadMagnet()).toBe("normal");
    localStorage.removeItem("pro-chart.magnet.v1");
    expect(loadMagnet()).toBe("normal");
  });

  it("toolCreateExtras 只在开的时候写 mode", () => {
    expect(toolCreateExtras("priceLine")).toEqual({});
    expect(toolCreateExtras("priceLine", "strong_magnet")).toEqual({ mode: "strong_magnet" });
    expect(toolCreateExtras("priceLine", "normal")).toEqual({});
    expect(toolCreateExtras("simpleAnnotation", "strong_magnet")).toEqual({
      needDefaultPointFigure: true,
      mode: "strong_magnet",
    });
  });

  it("恢复带上 mode，默认参数不写这个键", () => {
    const on = fakeChart();
    restoreDrawings(on, [{ name: "priceLine", paneId: MAIN_PANE_ID, points: dot }], undefined, undefined, "strong_magnet");
    expect(on.createOverlay.mock.calls.at(-1)?.[0]).toMatchObject({ mode: "strong_magnet" });

    const off = fakeChart();
    restoreDrawings(off, [{ name: "priceLine", paneId: MAIN_PANE_ID, points: dot }]);
    expect(off.createOverlay.mock.calls.at(-1)?.[0]).not.toHaveProperty("mode");
  });

  it("批量切换只碰用户自己的已完成线", () => {
    const chart = fakeChart([
      overlay({ id: "a", name: "priceLine", points: dot }),
      overlay({ id: "b", name: "segment", points: [{ timestamp: ts, value: 1 }, { timestamp: ts + 1, value: 2 }] }),
      // Pine 画的线：名字不在 DRAW_TOOLS 里，落点只有 dataIndex（所以也进不了存储）。
      overlay({ id: "pine", name: "straightLine", points: [{ dataIndex: 3, value: 9 } as never], currentStep: -1 }),
      // 半成品的用户线：正在放第二个点，不该被改。
      overlay({ id: "c", name: "segment", points: dot, drawing: true, currentStep: 1 }),
    ]);
    const touched = applyMagnetMode(chart, "strong_magnet");
    expect(touched).toBe(2);
    const ids = chart.overrideOverlay.mock.calls.map((c) => (c[0] as { id?: string }).id);
    expect(ids.sort()).toEqual(["a", "b"]);
    expect(chart.overlays.find((o) => o.id === "pine")?.mode).not.toBe("strong_magnet");
  });

  it("每条 override 都指名道姓，且关掉也把 mode 写回去", () => {
    const chart = fakeChart([overlay({ id: "a", name: "priceLine", points: dot, mode: "strong_magnet" })]);
    applyMagnetMode(chart, "normal");
    expect(chart.overrideOverlay.mock.calls).toEqual([[{ id: "a", mode: "normal" }]]);
    expect(chart.overlays[0].mode).toBe("normal");
  });
});
```

Run: `cd frontend && npx vitest run src/lib/__tests__/chartDrawings.test.ts -t 磁吸` → FAIL（`loadMagnet is not a function`）。留原文。

替身补 `mode`：Task 2 已给 `chartDrawings.test.ts` 的 `FakeOverlay`/`createOverlay`/`overrideOverlay` 加了 `mode`；若 Step 1 的断言 `overlay(...).mode` 需要 `points` 里带 `dataIndex`，把 `FakeOverlay["points"]` 的类型放宽为 `Array<{ timestamp?: number; value?: number; dataIndex?: number }>`。

- [ ] **Step 2: 实现 lib 层**

`chartDrawings.ts` 里 `STYLE_KEY` 那一节之后（文件末尾）新增一节：

```ts
// ---------------------------------------------------------------------------
// Magnet: a chart-wide interaction preference, one key, default off.
// ---------------------------------------------------------------------------

/**
 * The two states this app offers. The library also has `weak_magnet`, which only
 * snaps inside `modeSensitivity` pixels (dist 8822-8835) — explaining "why did
 * that one not snap" needs a UI for that band, which this app does not have, so
 * the choice is TradingView's: land on the bar's OHLC or don't (spec §三.B).
 */
export type MagnetMode = "normal" | "strong_magnet";

const MAGNET_KEY = "pro-chart.magnet.v1";

/** Anything but the stored "1" is off, including a value this app never wrote. */
export function loadMagnet(): MagnetMode {
  try {
    return localStorage.getItem(MAGNET_KEY) === "1" ? "strong_magnet" : "normal";
  } catch {
    return "normal";
  }
}

export function saveMagnet(on: boolean): void {
  try {
    localStorage.setItem(MAGNET_KEY, on ? "1" : "0");
  } catch {
    /* best effort */
  }
}

/**
 * Put the magnet choice on every finished drawing the user owns (spec §三.B.3).
 *
 * Three filters, each load-bearing:
 * - `toolOf(name)` — Pine's overlays are not the user's drawings (they carry
 *   `dataIndex` instead of a timestamp, and never reach storage; header note 6).
 *   Changing their `mode` would be a page rewriting the script's layer.
 * - `isInProgress` — a line still being placed has points on their way.
 * - the return value is **never** read: `shouldUpdate()` does not watch `mode`
 *   (dist 8314-8318), so a successful change answers `false` (header note 5,
 *   now for `mode`). Turning the magnet off also writes `mode`, because the
 *   instance may already hold `strong_magnet`.
 *
 * The library only ever honours `mode` on the candle pane (dist 8817), so a line
 * on a sub pane is set and never magnetised. That is the button's title text,
 * not something to hide in a wiki.
 */
export function applyMagnetMode(chart: OverlayHost, mode: MagnetMode): number {
  let touched = 0;
  for (const raw of chart.getOverlays()) {
    const o = raw as OverlayLike;
    if (!o || typeof o.id !== "string" || !o.id) continue;
    if (!toolOf(o.name ?? "")) continue;
    if (isInProgress(o)) continue;
    chart.overrideOverlay({ id: o.id, mode });
    touched += 1;
  }
  return touched;
}
```

`toolCreateExtras` 签名放宽（Task 1 的实现整体替换）：

```ts
export function toolCreateExtras(name: string, mode: MagnetMode = "normal"): Partial<OverlayCreate> {
  return {
    ...(toolOf(name)?.hasText === true ? { needDefaultPointFigure: true } : {}),
    // Only written when it deviates from the library default, exactly like
    // `lock`/`hidden`/`text` — so a chart drawn with the magnet off stores and
    // creates precisely what it stored before this feature existed.
    ...(mode === "strong_magnet" ? { mode } : {}),
  };
}
```

`restoreDrawings` 加第 5 参并把 extras 换成带 mode 的形式：

```ts
export function restoreDrawings(
  chart: OverlayHost,
  drawings: readonly StoredDrawing[],
  events?: ReturnType<typeof makeDrawingEvents>,
  paneExists: PaneLookup = ALL_PANES_PRESENT,
  mode: MagnetMode = "normal",
): RestoreReport {
```

（内部 `...toolCreateExtras(d.name)` → `...toolCreateExtras(d.name, mode)`。）

- [ ] **Step 3: 页面层失败测试**

`ProChartDrawings.test.tsx` 的 `FakeOverlay` 加 `mode?: string;`；`makeOverlay()` 默认对象补 `mode: "normal",`（`OverlayImp` 构造的默认值，dist 8248）；`init` 的 `createOverlay` 形参加 `mode?: string` 并 `...(typeof v.mode === "string" ? { mode: v.mode } : {})`；`overrideOverlay` 形参加 `mode?: string`，合并分支加 `if ("mode" in v) target.mode = v.mode;`，**`draw` 判决不加 `mode`**（这就是「返回 false 但已生效」的建模，注释写一句）。

追加测试：

```tsx
  it("磁吸开关：按钮反映状态，切换逐条指名道姓改 mode", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "价格线" }));
    finishDrawing({ timestamp: START + 5 * DAY, value: 1305 });
    await flush();
    const magnet = screen.getByRole("button", { name: "磁吸" });
    expect(magnet.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(magnet);
    await flush();
    expect(magnet.getAttribute("aria-pressed")).toBe("true");
    expect(localStorage.getItem("pro-chart.magnet.v1")).toBe("1");
    expect(h.chart?.overrideOverlay).toHaveBeenCalledTimes(1);
    expect(h.chart?.overrideOverlay.mock.calls[0][0]).toEqual({ id: h.overlays[0].id, mode: "strong_magnet" });

    // Off must write the mode back: the instance still holds strong_magnet.
    fireEvent.click(magnet);
    await flush();
    expect(h.chart?.overrideOverlay.mock.calls.at(-1)?.[0]).toEqual({ id: h.overlays[0].id, mode: "normal" });
    expect(localStorage.getItem("pro-chart.magnet.v1")).toBe("0");
  });

  it("磁吸开着画的线带上 mode，关着画的一个键都不多", async () => {
    localStorage.setItem("pro-chart.magnet.v1", "1");
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "水平线" }));
    let arg = h.chart?.createOverlay.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(arg.mode).toBe("strong_magnet");

    fireEvent.click(screen.getByRole("button", { name: "磁吸" })); // off
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "趋势线" }));
    arg = h.chart?.createOverlay.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(arg).not.toHaveProperty("mode");
  });

  it("Pine 的线不被磁吸摸到（名字不在工具表里的那种）", async () => {
    await mountChart();
    fireEvent.click(screen.getByRole("button", { name: "价格线" }));
    finishDrawing({ timestamp: START + DAY, value: 1299 });
    await flush();
    // A Pine drawing: an overlay name the toolbar does not ship, anchored by
    // dataIndex only (see chartDrawings header note 6).
    h.chart?.createOverlay({ name: "simpleTag", paneId: "candle_pane", points: [{ dataIndex: 3, value: 9 }] });
    const pine = h.overlays.at(-1)!;
    const before = pine.mode;

    fireEvent.click(screen.getByRole("button", { name: "磁吸" }));
    await flush();
    const ids = (h.chart?.overrideOverlay.mock.calls ?? []).map((c) => (c[0] as { id?: string }).id);
    expect(ids).not.toContain(pine.id);
    expect(pine.mode).toBe(before);
    // Only the user's one line got touched.
    expect(h.chart?.overrideOverlay).toHaveBeenCalledTimes(1);
  });

  it("磁吸按钮的提示写明副图不受效（库闸门，不是我们藏的坑）", async () => {
    await mountChart();
    const title = screen.getByRole("button", { name: "磁吸" }).getAttribute("title") ?? "";
    expect(title).toContain("副图");
  });
```

Run: `cd frontend && npx vitest run src/pages/__tests__/ProChartDrawings.test.tsx -t 磁吸` → FAIL（`Unable to find role "button", name "磁吸"`）。留原文。

- [ ] **Step 4: 实现页面层**

import 块加 `applyMagnetMode`、`loadMagnet`、`saveMagnet`、`type MagnetMode`。
state 块（`drawStyleRef` :481 附近）之后加：

```ts
  // Magnet (第③片 B): a chart-wide interaction preference, default off so the
  // page behaves exactly as it did before this feature existed.
  const [magnet, setMagnet] = useState<MagnetMode>(() => loadMagnet());
  // The mirror the closures read. The symbol/interval swap lives inside the
  // DataLoader closure built once per chart (:955), so it can only ever see a
  // ref — and `restoreDrawings` there has to stamp the same `mode` the toolbar
  // armed with, or a line comes back from storage with a different magnet
  // behaviour than the one the user is drawing with. Same reason as
  // `drawStyleRef` above.
  const magnetRef = useRef<MagnetMode>(magnet);
```

`armTool` 的 `toolCreateExtras(name)` → `toolCreateExtras(name, magnetRef.current)`。
三个 `restoreDrawings(...)` 调用点（:1127、:1714、:1864）各加第 5 实参 `magnetRef.current`（:1127 那个是四行的多行形式，最后一个实参写 `paneLookup(chart), magnetRef.current`）。
新增 handler（放在 `armTool` 之前）：

```ts
  /**
   * Flip the magnet. Everything already on the chart is re-stamped, because the
   * library reads `mode` off the instance (dist 8817) and a line drawn while the
   * magnet was off keeps `normal` forever otherwise.
   */
  const toggleMagnet = () => {
    const chart = chartRef.current;
    const next: MagnetMode = magnetRef.current === "strong_magnet" ? "normal" : "strong_magnet";
    magnetRef.current = next;
    setMagnet(next);
    saveMagnet(next === "strong_magnet");
    if (chart) applyMagnetMode(chart, next);
  };
```

工具栏：`DRAW_TOOLS.map` 那个 `<div className="flex gap-1">` 里，紧跟 `))}` 之后、`撤销` 按钮之前插入：

```tsx
          <button
            type="button"
            className={cn(
              "rounded-md border px-2 py-1 text-xs hover:bg-muted",
              magnet === "strong_magnet" && "bg-muted font-medium ring-1 ring-primary",
            )}
            aria-label="磁吸"
            aria-pressed={magnet === "strong_magnet"}
            title={
              magnet === "strong_magnet"
                ? "磁吸已开：落点吸到那根 K 线的开/高/低/收上。只对主图生效——副图的 y 是指标量级，吸到 OHLC 才是错的（库的闸门，不是开关能绕的）"
                : "磁吸已关：落点是鼠标的连续投影。打开后新画与已画的线都吸到那根 K 线的 OHLC 四个价上（仅主图）"
            }
            onClick={toggleMagnet}
          >
            磁吸
          </button>
```

- [ ] **Step 5: 跑全套画线面与门禁**

Run: `cd frontend && npx vitest run src/pages/__tests__/ProChartDrawings.test.tsx src/lib/__tests__/chartDrawings.test.ts src/pages/__tests__/ProChartReplayDrawings.test.tsx src/pages/__tests__/ProChartReplay.test.tsx && npx tsc --noEmit`
Expected: 全绿、tsc 静默。既有的「每一次 override 都指名道姓」那条（`ProChartDrawings.test.tsx` 里断言恰好 2 次调用）**不许改**：它红的就说明新代码在某个不该 override 的时机动了手——查时机，别改期望次数。

- [ ] **Step 6: 提交**

```bash
git add -- frontend/src/lib/chartDrawings.ts frontend/src/pages/ProChart.tsx \
  frontend/src/lib/__tests__/chartDrawings.test.ts frontend/src/pages/__tests__/ProChartDrawings.test.tsx
git commit -s -m "$(cat <<'EOF'
feat(drawings): 磁吸开关——落点吸到那根 K 线的 OHLC（库自带 mode，本仓此前零使用）

默认关，未偏离默认时一个键都不写。切换时逐条 overrideOverlay({id, mode})，
先看 toolOf 再跳过 isInProgress：Pine 的线不属于用户，半成品的线还有点在路上。
返回值绝不当判决——shouldUpdate 不看 mode，改成功了也回 false（档案里那条
lock 的教训推广到这儿）。按钮 title 写明副图不受效，那是库的 paneId 闸门。
EOF
)"
```

---

### Task 6: `lib/chartLegend.ts` 纯模块

**Files:**
- Create: `frontend/src/lib/chartLegend.ts`
- Create: `frontend/src/lib/__tests__/chartLegend.test.ts`

**Interfaces:**
- Consumes: 只有 `klinecharts` 的类型（`TooltipShowRule` `KD:292`、`TooltipLegend` `KD:338`）。
- Produces: `LegendPrefs`、`DEFAULT_LEGEND_PREFS`、`LEGEND_PREFS_KEY`、`legendTemplate(p)`、`legendStyles(p): LegendStyleFragment`、`normalizeLegendPrefs(raw)`、`loadLegendPrefs()`、`saveLegendPrefs(p)`、`RULE_OPTIONS`（面板的下拉选项）。Task 7 全部用到。

- [ ] **Step 1: 写失败测试**

创建 `frontend/src/lib/__tests__/chartLegend.test.ts`：

```ts
import { beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_LEGEND_PREFS,
  LEGEND_PREFS_KEY,
  RULE_OPTIONS,
  legendStyles,
  legendTemplate,
  loadLegendPrefs,
  normalizeLegendPrefs,
  saveLegendPrefs,
} from "../chartLegend";

/**
 * Legend preferences (推荐清单第③片 C).
 *
 * What is being guarded, in one line each: the defaults must equal the library's
 * own (§二.8) so a user who never opens the panel sees the same picture; the
 * fragment must not carry a single colour key, or it fights `chartStyles`' red-up
 * theme面; and the reader must survive a dirty file by answering defaults,
 * because it runs before the first paint.
 */

const LIB_TEMPLATE = [
  { title: "time", value: "{time}" },
  { title: "open", value: "{open}" },
  { title: "high", value: "{high}" },
  { title: "low", value: "{low}" },
  { title: "close", value: "{close}" },
  { title: "volume", value: "{volume}" },
];

beforeEach(() => localStorage.clear());

describe("默认值等于库默认", () => {
  it("always / always / 涨幅关 / 高低开 / 最新价开", () => {
    expect(DEFAULT_LEGEND_PREFS).toEqual({
      candleRule: "always",
      indicatorRule: "always",
      showChange: false,
      highLowMark: true,
      lastPriceLine: true,
    });
  });

  it("默认模板与库的六行逐键相等，且顺序一致", () => {
    expect(legendTemplate(DEFAULT_LEGEND_PREFS)).toEqual(LIB_TEMPLATE);
  });

  it("勾上涨幅是七行，新增行落在 volume 之后", () => {
    const rows = legendTemplate({ ...DEFAULT_LEGEND_PREFS, showChange: true });
    expect(rows).toHaveLength(7);
    expect(rows[6]).toEqual({ title: "change", value: "{change}" });
    expect(rows.slice(0, 6)).toEqual(LIB_TEMPLATE);
  });
});

describe("样式片段", () => {
  it("只产 show / showRule / template 三类键，一个颜色键都不写", () => {
    const json = JSON.stringify(legendStyles({ ...DEFAULT_LEGEND_PREFS, showChange: true }));
    expect(json).not.toMatch(/[Cc]olor/);
    expect(json).not.toMatch(/[Uu]p|[Dd]own/);
  });

  it("三态与两个开关各归其位", () => {
    const s = legendStyles({
      candleRule: "follow_cross",
      indicatorRule: "none",
      showChange: true,
      highLowMark: false,
      lastPriceLine: false,
    });
    expect(s.candle.tooltip.showRule).toBe("follow_cross");
    expect(s.indicator.tooltip.showRule).toBe("none");
    expect(s.candle.priceMark.high.show).toBe(false);
    expect(s.candle.priceMark.low.show).toBe(false);
    // One preference drives all three last-price keys: TV hides line *and* tag,
    // and a lone tag left on the axis is not a thing a user asks for.
    expect(s.candle.priceMark.last).toEqual({ show: false, line: { show: false }, text: { show: false } });
    expect(s.candle.tooltip.legend.template).toHaveLength(7);
  });

  it("默认态下片段全是库默认的那几个值", () => {
    const s = legendStyles(DEFAULT_LEGEND_PREFS);
    expect(s.candle.tooltip.showRule).toBe("always");
    expect(s.indicator.tooltip.showRule).toBe("always");
    expect(s.candle.priceMark.high.show).toBe(true);
    expect(s.candle.priceMark.last).toEqual({ show: true, line: { show: true }, text: { show: true } });
  });
});

describe("读偏好：脏值回默认，不抛", () => {
  it("读不到就是默认，且不写回", () => {
    expect(loadLegendPrefs()).toEqual(DEFAULT_LEGEND_PREFS);
    expect(localStorage.getItem(LEGEND_PREFS_KEY)).toBeNull();
  });

  it("非 JSON／数组／未知 showRule／字符串布尔／缺键／多余的成交额键都回默认", () => {
    const bad: unknown[] = [
      "{not json",
      "[]",
      "null",
      JSON.stringify({ candleRule: "sometimes" }),
      JSON.stringify({ showChange: "true" }),
      JSON.stringify({ highLowMark: 1 }),
      JSON.stringify({ candleRule: "none" }), // 缺其余键 → 其余回默认
      JSON.stringify({ ...DEFAULT_LEGEND_PREFS, showTurnover: true }), // 被否掉的那行
    ];
    for (const raw of bad) {
      localStorage.setItem(LEGEND_PREFS_KEY, raw as string);
      expect(loadLegendPrefs(), raw).not.toHaveProperty("showTurnover");
    }
    localStorage.setItem(LEGEND_PREFS_KEY, JSON.stringify({ ...DEFAULT_LEGEND_PREFS, candleRule: "none" }));
    expect(loadLegendPrefs().candleRule).toBe("none");
    localStorage.setItem(LEGEND_PREFS_KEY, JSON.stringify({ ...DEFAULT_LEGEND_PREFS, showChange: "true" }));
    expect(loadLegendPrefs().showChange).toBe(false);
  });

  it("normalizeLegendPrefs 逐键取值，多余的键不带出去", () => {
    const p = normalizeLegendPrefs({ candleRule: "none", extra: 1 });
    expect(Object.keys(p).sort()).toEqual(["candleRule", "highLowMark", "indicatorRule", "lastPriceLine", "showChange"]);
    expect(p.candleRule).toBe("none");
  });

  it("存进去再读出来一致", () => {
    const p = { candleRule: "follow_cross", indicatorRule: "none", showChange: true, highLowMark: false, lastPriceLine: true } as const;
    saveLegendPrefs(p);
    expect(loadLegendPrefs()).toEqual(p);
  });

  it("下拉选项就是库的 TooltipShowRule 三值", () => {
    expect(RULE_OPTIONS.map((o) => o.value)).toEqual(["always", "follow_cross", "none"]);
  });
});
```

Run: `cd frontend && npx vitest run src/lib/__tests__/chartLegend.test.ts` → FAIL（`Cannot find module '../chartLegend'`）。留原文。

- [ ] **Step 2: 写模块**

创建 `frontend/src/lib/chartLegend.ts`：

```ts
import type { TooltipLegend, TooltipShowRule } from "klinecharts";

/**
 * Legend preferences: the switches the library already has and this app never
 * exposed (推荐清单第③片 C).
 *
 * Two things about v10 are load-bearing here, and both were measured before this
 * file existed (see the spec's §二.7/§二.8/§二.12):
 *
 * 1. There is **no `setTooltipOptions`** — grep answers 0 in `index.d.ts` and in
 *    the bundle. `setStyles` is the only public lever on the legend, so this
 *    module's job is to produce *one* fragment shape, and `ProChart.chartStyles`
 *    is the only place allowed to fold it into the theme object. The theme
 *    effect pushes that whole object on every dark-mode flip; leaving these prefs
 *    out of its dependency list is how the last slice painted candles back over
 *    a 分时 line.
 * 2. `StoreImp.setStyles` deep-merges (`dist 13309-13322`) but **replaces** the
 *    `candle.tooltip.legend.template` array wholesale. So pushing the same prefs
 *    twice is idempotent and rows cannot duplicate — but a partial template
 *    would silently drop the library's rows, which is why `legendTemplate`
 *    returns the full list every time.
 *
 * No colour key is ever written from here: `{change}` takes its colour from
 * `candle.priceMark.last` (dist 7687-7689), which this page's theme owns.
 * There is also no turnover row: the data pipeline never carries the field
 * (spec §二.12), so that row would print `n/a` forever — a claim, not a gap.
 */

export interface LegendPrefs {
  /** The 时间/开/高/低/收/量 block on the main chart. */
  candleRule: TooltipShowRule;
  /** Each sub pane's indicator legend. */
  indicatorRule: TooltipShowRule;
  /** The extra `{change}` row. Default off — it is the one row that *adds* pixels. */
  showChange: boolean;
  /** The high/low price marks. Library default on. */
  highLowMark: boolean;
  /** Last price: line and tag together (one preference, three style keys). */
  lastPriceLine: boolean;
}

export const DEFAULT_LEGEND_PREFS: LegendPrefs = {
  candleRule: "always",
  indicatorRule: "always",
  showChange: false,
  highLowMark: true,
  lastPriceLine: true,
};

const LEGEND_KEY = "pro-chart.legend.v1";
export { LEGEND_KEY as LEGEND_PREFS_KEY };

/** The three states the panel offers, in the order the user reads them. */
export const RULE_OPTIONS: ReadonlyArray<{ value: TooltipShowRule; label: string }> = [
  { value: "always", label: "总是" },
  { value: "follow_cross", label: "跟随光标" },
  { value: "none", label: "隐藏" },
];

/** The library's own six rows (`dist 11524-11531`), plus the optional 涨幅 one. */
export function legendTemplate(p: LegendPrefs): TooltipLegend[] {
  const rows: TooltipLegend[] = [
    { title: "time", value: "{time}" },
    { title: "open", value: "{open}" },
    { title: "high", value: "{high}" },
    { title: "low", value: "{low}" },
    { title: "close", value: "{close}" },
    { title: "volume", value: "{volume}" },
  ];
  // Titles are *keys*, not Chinese: the library runs them through `i18n` again
  // (dist 7685) and zh_CN already carries `change: '涨幅：'` (dist 6973). Hardcoding
  // 中文 would print a Chinese row on an English UI.
  if (p.showChange) rows.push({ title: "change", value: "{change}" });
  return rows;
}

/** The style fragment this module owns — keys only, no colours. */
export interface LegendStyleFragment {
  candle: {
    tooltip: { showRule: TooltipShowRule; legend: { template: TooltipLegend[] } };
    priceMark: {
      high: { show: boolean };
      low: { show: boolean };
      last: { show: boolean; line: { show: boolean }; text: { show: boolean } };
    };
  };
  indicator: { tooltip: { showRule: TooltipShowRule } };
}

export function legendStyles(p: LegendPrefs): LegendStyleFragment {
  return {
    candle: {
      tooltip: { showRule: p.candleRule, legend: { template: legendTemplate(p) } },
      priceMark: {
        high: { show: p.highLowMark },
        low: { show: p.highLowMark },
        last: { show: p.lastPriceLine, line: { show: p.lastPriceLine }, text: { show: p.lastPriceLine } },
      },
    },
    indicator: { tooltip: { showRule: p.indicatorRule } },
  };
}

function rule(raw: unknown, fallback: TooltipShowRule): TooltipShowRule {
  return RULE_OPTIONS.some((o) => o.value === raw) ? (raw as TooltipShowRule) : fallback;
}

function flag(raw: unknown, fallback: boolean): boolean {
  return typeof raw === "boolean" ? raw : fallback;
}

/** Key by key, defaults for anything unrecognised; never throws, never writes. */
export function normalizeLegendPrefs(raw: unknown): LegendPrefs {
  const d = DEFAULT_LEGEND_PREFS;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { ...d };
  const o = raw as Record<string, unknown>;
  return {
    candleRule: rule(o.candleRule, d.candleRule),
    indicatorRule: rule(o.indicatorRule, d.indicatorRule),
    showChange: flag(o.showChange, d.showChange),
    highLowMark: flag(o.highLowMark, d.highLowMark),
    lastPriceLine: flag(o.lastPriceLine, d.lastPriceLine),
  };
}

export function loadLegendPrefs(): LegendPrefs {
  try {
    const raw = localStorage.getItem(LEGEND_KEY);
    if (!raw) return { ...DEFAULT_LEGEND_PREFS };
    return normalizeLegendPrefs(JSON.parse(raw));
  } catch {
    return { ...DEFAULT_LEGEND_PREFS };
  }
}

export function saveLegendPrefs(p: LegendPrefs): void {
  try {
    localStorage.setItem(LEGEND_KEY, JSON.stringify(p));
  } catch {
    /* best effort */
  }
}
```

- [ ] **Step 3: 跑绿 + tsc**

Run: `cd frontend && npx vitest run src/lib/__tests__/chartLegend.test.ts && npx tsc --noEmit`
Expected: 全绿、静默。若 `JSON.stringify` 的颜色断言意外命中 `change`（值里含 `change` 字样），把正则改成 `/[Cc]olor|[Cc]olour/` 而不是放宽整条判据。

- [ ] **Step 4: 提交**

```bash
git add -- frontend/src/lib/chartLegend.ts frontend/src/lib/__tests__/chartLegend.test.ts
git commit -s -m "$(cat <<'EOF'
feat(legend): chartLegend 纯模块——库默认值、样式片段与逐键校验的偏好读写

v10 没有 setTooltipOptions，setStyles 是唯一杠杆，所以片段形状由这个模块唯一决定。
模板整体替换（深合并只对对象成立），于是每次返回完整六/七行。
一个颜色键都不写：{change} 的取色本来就归主题面。没有成交额行——数据面根本没有
turnover，恒为 n/a 的一行是把拿不到的数字挂上去充当有。
EOF
)"
```

---

### Task 7: ProChart 的图例接线与面板（含「切主题不冲掉偏好」的回归钉）

**Files:**
- Modify: `frontend/src/pages/ProChart.tsx`（`chartStyles` :257-299、init :955、主题 effect :1213-1215、state 块、工具栏 :2210 之后、面板 JSX）
- Create: `frontend/src/pages/__tests__/ProChartLegend.test.tsx`
- Modify: `frontend/src/pages/__tests__/ProChartTimeShare.test.tsx`（既有那条 theme-switch 测试加一句图例判据）

**Interfaces:**
- Consumes: Task 6 的全部导出。
- Produces: `chartStyles(dark, timeShare, legend)` 三参形式；`ProChart` 的图例按钮（`aria-label="图例"`）与面板控件（`aria-label="主图图例显示规则"` / `"副图图例显示规则"` / `"涨幅行"` / `"高低标记"` / `"最新价线"`）。

- [ ] **Step 1: 写失败测试（新文件）**

创建 `frontend/src/pages/__tests__/ProChartLegend.test.tsx`。harness 以 `ProChartPaging.test.tsx` 的 mock 为底（那份能挂起 `ProChart`，已核实），改动只有一处——把 `setStyles` 换成记录调用：

```tsx
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { publishThemeChange } from "@/lib/theme-store";
import { DEFAULT_LEGEND_PREFS, LEGEND_PREFS_KEY } from "@/lib/chartLegend";
import { ProChart } from "../ProChart";

/**
 * Legend wiring (第③片 C). The regression this exists for is on the record
 * already: `chartStyles` is pushed whole through `setStyles` on every theme
 * flip, and when the 分时/candle choice lived outside that function, switching
 * themes quietly repainted it. Legend prefs join the same object, so they inherit
 * the same trap — hence "change a pref, *then* flip the theme, still there".
 */

const h = vi.hoisted(() => ({
  styles: [] as Array<Record<string, unknown>>,
  loader: null as null | { getBars: (p: { type: string; timestamp: number | null; period: unknown; symbol: { ticker: string }; callback: (d: unknown[], m?: unknown) => void }) => void | Promise<void> },
}));

function styleAt(i: number): Record<string, unknown> {
  return h.styles[i];
}

/** `candle.tooltip.showRule` as the *i*-th pushed object carried it. */
function candleRule(i: number): unknown {
  const s = styleAt(i) as {
    candle?: { tooltip?: { showRule?: string }; type?: string };
  };
  return s.candle?.tooltip?.showRule;
}

function candleType(i: number): unknown {
  return (styleAt(i) as { candle?: { type?: string } }).candle?.type;
}

vi.mock("klinecharts", () => ({
  registerIndicator: vi.fn(),
  getSupportedLocales: () => ["en-US", "zh-CN"],
  registerLocale: vi.fn(),
  dispose: vi.fn(),
  init: () => ({
    getSymbol: () => ({ ticker: "600519.SH", pricePrecision: 2, volumePrecision: 0 }),
    getDataList: () => [],
    getIndicators: () => [],
    getOverlays: () => [],
    getPaneOptions: () => [{ id: "candle_pane", height: 300, minHeight: 30, state: "normal" }],
    setPaneOptions: vi.fn(),
    setDataLoader: (loader: typeof h.loader) => {
      h.loader = loader;
    },
    setSymbol: () => undefined,
    setPeriod: () => undefined,
    setStyles: (s: Record<string, unknown>) => h.styles.push(s),
    resize: vi.fn(),
    createIndicator: vi.fn(),
    removeIndicator: vi.fn(),
    createOverlay: vi.fn(),
    removeOverlay: vi.fn(),
    overrideOverlay: vi.fn(),
    getOffsetRightDistance: () => 0,
    getBarSpace: () => ({ bar: 8, halfBar: 4, gapBar: 5, halfGapBar: 2 }),
  }),
}));

vi.mock("@/components/charts/WatchList", () => ({ default: () => null }));
vi.mock("@/components/charts/IndicatorEditor", () => ({ default: () => null }));

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

const pushCount = () => h.styles.length;

beforeEach(() => {
  h.styles = [];
  h.loader = null;
  localStorage.clear();
  document.documentElement.classList.remove("dark");
});

describe("/pro-chart 图例偏好", () => {
  it("面板五项都在，默认值逐项等于库默认", async () => {
    render(<ProChart />);
    await flush();
    const open = screen.getByRole("button", { name: "图例" });
    expect(open.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(open);
    expect(screen.getByRole("button", { name: "图例" }).getAttribute("aria-pressed")).toBe("true");

    expect((screen.getByLabelText("主图图例显示规则") as HTMLSelectElement).value).toBe(DEFAULT_LEGEND_PREFS.candleRule);
    expect((screen.getByLabelText("副图图例显示规则") as HTMLSelectElement).value).toBe(DEFAULT_LEGEND_PREFS.indicatorRule);
    expect((screen.getByLabelText("涨幅行") as HTMLInputElement).checked).toBe(DEFAULT_LEGEND_PREFS.showChange);
    expect(screen.getByRole("button", { name: "高低标记" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "最新价线" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("改一项就 push 一次含新值的样式，并把偏好写进存储", async () => {
    render(<ProChart />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "图例" }));
    const before = pushCount();

    fireEvent.change(screen.getByLabelText("主图图例显示规则"), { target: { value: "follow_cross" } });
    await flush();

    const s = styleAt(pushCount() - 1);
    expect((s as { candle: { tooltip: { showRule: string } } }).candle.tooltip.showRule).toBe("follow_cross");
    expect(pushCount()).toBeGreaterThan(before);
    expect(JSON.parse(localStorage.getItem(LEGEND_PREFS_KEY) ?? "{}")).toMatchObject({ candleRule: "follow_cross" });
  });

  it("改完图例再切主题，偏好还在，candle.type 也还在（历史冲掉回归点）", async () => {
    render(<ProChart />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "图例" }));
    fireEvent.change(screen.getByLabelText("主图图例显示规则"), { target: { value: "none" } });
    await flush();
    expect(candleRule(pushCount() - 1)).toBe("none");

    act(() => {
      document.documentElement.classList.add("dark");
      publishThemeChange();
    });
    await flush();

    const last = pushCount() - 1;
    expect(candleRule(last)).toBe("none");
    // The other half of the same trap: the theme push must not lose the candle
    // type either (that is the bug the 分时 slice already paid for).
    expect(candleType(last)).toBe("candle_solid");
    expect(candleRule(last - 1)).toBe("none");
  });

  it("涨幅行勾上后模板多出第 7 行，取消又回到 6 行", async () => {
    render(<ProChart />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "图例" }));
    const box = screen.getByLabelText("涨幅行");
    fireEvent.click(box);
    await flush();
    const tpl = (styleAt(pushCount() - 1) as { candle: { tooltip: { legend: { template: unknown[] } } } }).candle.tooltip.legend
      .template;
    expect(tpl).toHaveLength(7);
    fireEvent.click(screen.getByLabelText("涨幅行"));
    await flush();
    expect(
      (styleAt(pushCount() - 1) as { candle: { tooltip: { legend: { template: unknown[] } } } }).candle.tooltip.legend
        .template,
    ).toHaveLength(6);
  });

  it("两个开关各自落到 priceMark 的对应键，且从不写颜色", async () => {
    render(<ProChart />);
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "图例" }));
    fireEvent.click(screen.getByRole("button", { name: "最新价线" }));
    await flush();
    const mark = (styleAt(pushCount() - 1) as { candle: { priceMark: Record<string, unknown> } }).candle.priceMark;
    expect(mark.last).toEqual({ show: false, line: { show: false }, text: { show: false } });
    expect(JSON.stringify(styleAt(pushCount() - 1))).not.toMatch(/Color/);
    fireEvent.click(screen.getByRole("button", { name: "高低标记" }));
    await flush();
    const m2 = (styleAt(pushCount() - 1) as { candle: { priceMark: Record<string, { show: boolean }> } }).candle.priceMark;
    expect(m2.high.show).toBe(false);
    expect(m2.low.show).toBe(false);
  });

  it("没动过偏好的用户：首屏样式对象里图例三项等于库默认", async () => {
    render(<ProChart />);
    await flush();
    expect(candleRule(0)).toBe("always");
    const s = styleAt(0) as {
      indicator?: { tooltip?: { showRule?: string } };
      candle?: { priceMark?: Record<string, unknown> };
    };
    expect(s.indicator?.tooltip?.showRule).toBe("always");
    expect(s.candle?.priceMark?.last).toEqual({ show: true, line: { show: true }, text: { show: true } });
    expect(localStorage.getItem(LEGEND_PREFS_KEY)).toBeNull(); // 偏好不落盘，除非用户改过
  });
});
```

Run: `cd frontend && npx vitest run src/pages/__tests__/ProChartLegend.test.tsx` → FAIL（`Unable to find role "button", name "图例"`；以及 `candleRule(0)` 是 `undefined`）。留原文。

- [ ] **Step 2: 实现 `chartStyles` 合成**

`ProChart.tsx` 加 import：

```ts
import {
  DEFAULT_LEGEND_PREFS,
  type LegendPrefs,
  legendStyles,
  loadLegendPrefs,
  saveLegendPrefs,
} from "@/lib/chartLegend";
```

`chartStyles`（:257-299）签名与合成改为——**注意 `candle` 的展开顺序**：片段先展开、本函数自己的键在后，这样 `type` 等自有键不会被片段覆盖，且两条历史注释都要留在原处：

```ts
function chartStyles(dark: boolean, timeShare = false, legend: LegendPrefs = DEFAULT_LEGEND_PREFS) {
```

```ts
  const type: CandleType = timeShare ? "area" : "candle_solid";
  const legendFragment = legendStyles(legend);
  return {
    grid: { horizontal: { color: dark ? "#1f2733" : "#f0f0f0" }, vertical: { color: dark ? "#1f2733" : "#f0f0f0" } },
    candle: {
      // Legend prefs fold in *here*, the only composition point (spec §三.C):
      // the theme effect below re-pushes this whole object, so a pref that lived
      // anywhere else would be wiped out by the next dark-mode flip — which is
      // exactly how the 分时 toggle used to "stop working".
      ...legendFragment.candle,
      type,
      bar: { /* …原有九个键逐字不动… */ },
      area: { /* …原有五个键逐字不动… */ },
    },
    indicator: legendFragment.indicator,
    xAxis: { axisLine: { color: dark ? "#4a4a4a" : "#ccc" }, tickText: { color: dark ? "#aaa" : "#666" } },
    yAxis: { axisLine: { color: dark ? "#4a4a4a" : "#ccc" }, tickText: { color: dark ? "#aaa" : "#666" } },
  };
}
```

（`bar:` / `area:` 两处注释标记只是给读计划的人看的位置，落地时保留文件里现有的那些键与注释原样。）

- [ ] **Step 3: state、init、主题 effect**

state 块（Task 5 的 `magnetRef` 之后）加：

```ts
  const [legend, setLegend] = useState<LegendPrefs>(() => loadLegendPrefs());
  // Same closure problem as `drawStyleRef`/`magnetRef`: two clicks inside one
  // task would otherwise both compose onto the same stale snapshot and the
  // second would undo the first.
  const legendRef = useRef<LegendPrefs>(legend);
```

`init` 的 `styles:`（:955）→ `styles: chartStyles(dark, session.timeShare, legend),`（mount 时读 state 初值即为正确值；这条 effect 的依赖数组本来为空，注释里写一句「mount value is the right value here」）。

主题 effect（:1213-1215）→

```ts
  useEffect(() => {
    chartRef.current?.setStyles(chartStyles(dark, timeShare, legend));
  }, [dark, timeShare, legend]);
```

- [ ] **Step 4: handler 与面板 JSX**

`toggleMagnet` 之后加：

```ts
  /**
   * Change a legend pref. Nothing else has to happen: `legend` is in the theme
   * effect's dependency list, so the new value goes onto the chart through the
   * same single composition point that the theme flip uses.
   */
  const patchLegend = (patch: Partial<LegendPrefs>) => {
    const next: LegendPrefs = { ...legendRef.current, ...patch };
    legendRef.current = next;
    setLegend(next);
    saveLegendPrefs(next);
  };
```

工具栏：在 `画线:` 那个 `<div className="flex gap-1">…</div>` **之后**、样式色块 `<div className="flex items-center gap-1">` 之前插入按钮：

```tsx
        <button
          type="button"
          className={cn(
            "rounded-md border px-2 py-1 text-xs hover:bg-muted",
            legendPanelOpen && "bg-muted font-medium ring-1 ring-primary",
          )}
          aria-label="图例"
          aria-pressed={legendPanelOpen}
          title="图例与标记：主图数值块、副图指标图例、涨幅行、高低标记、最新价线（默认全部等于 klinecharts 出厂值）"
          onClick={() => setLegendPanelOpen((v) => !v)}
        >
          图例
        </button>
```

state 块再加 `const [legendPanelOpen, setLegendPanelOpen] = useState(false);`（紧贴 `legend` 声明）。

面板 JSX：插在 `{drawPanelOpen && (`（:2313）之前：

```tsx
      {legendPanelOpen && (
        <div className="flex shrink-0 flex-wrap items-center gap-3 rounded-lg border bg-background px-3 py-2 text-xs">
          <span className="text-muted-foreground">图例:</span>
          <label className="flex items-center gap-1">
            主图数值
            <select
              aria-label="主图图例显示规则"
              className="rounded-md border bg-transparent px-1 py-0.5"
              value={legend.candleRule}
              onChange={(e) => patchLegend({ candleRule: e.target.value as TooltipShowRule })}
            >
              {RULE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            副图指标
            <select
              aria-label="副图图例显示规则"
              className="rounded-md border bg-transparent px-1 py-0.5"
              value={legend.indicatorRule}
              onChange={(e) => patchLegend({ indicatorRule: e.target.value as TooltipShowRule })}
            >
              {RULE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              aria-label="涨幅行"
              checked={legend.showChange}
              onChange={(e) => patchLegend({ showChange: e.target.checked })}
            />
            涨幅行
          </label>
          <button
            type="button"
            aria-label="高低标记"
            aria-pressed={legend.highLowMark}
            className="rounded-md border px-2 py-1 hover:bg-muted"
            title="高/低价位标记（库默认开）"
            onClick={() => patchLegend({ highLowMark: !legend.highLowMark })}
          >
            高低标记
          </button>
          <button
            type="button"
            aria-label="最新价线"
            aria-pressed={legend.lastPriceLine}
            className="rounded-md border px-2 py-1 hover:bg-muted"
            title="最新价的虚线与价签一起开关（只关线会在轴上留一个孤立价签）"
            onClick={() => patchLegend({ lastPriceLine: !legend.lastPriceLine })}
          >
            最新价线
          </button>
        </div>
      )}
```

import 里补 `RULE_OPTIONS` 与 `type TooltipShowRule`（后者从 `"klinecharts"`）。

- [ ] **Step 5: 跑新测试与全页面门禁**

Run: `cd frontend && npx vitest run src/pages/__tests__/ProChartLegend.test.tsx src/lib/__tests__/chartLegend.test.ts && npx tsc --noEmit`
Expected: 全绿、tsc 静默。

- [ ] **Step 6: 分时那半的回归钉（改既有测试）**

`ProChartTimeShare.test.tsx` 的 `setStyles` 形参类型（:210）放宽一项并加一个读数助手，然后把判据补进既有的那条主题切换测试（:475-490，**不新建测试**——那份 harness 已经跑过分时态）：

```ts
    setStyles: (s: { candle?: { type?: string; tooltip?: { showRule?: string } } }) => {
      h.styles.push(s);
    },
```

```ts
/** The last `candle.tooltip.showRule` the page pushed onto the chart. */
function lastCandleShowRule(): string | undefined {
  return h.styles.at(-1)?.candle?.tooltip?.showRule;
}
```

在 `expect(lastCandleType()).toBe("area");`（该测试末尾，约 :489）之后加：

```ts
    // 第③片: legend prefs ride the same re-pushed object, so a theme flip in a
    // 分时 view has to keep both halves — type *and* legend rule.
    expect(lastCandleShowRule()).toBe("always");
```

Run: `cd frontend && npx vitest run src/pages/__tests__/ProChartTimeShare.test.tsx`
Expected: 全绿（条数不变）。若它是红的，说明 `chartStyles` 的展开顺序把 `candle.type` 挤掉了——修合成点，不修断言。

- [ ] **Step 7: 提交**

```bash
git add -- frontend/src/pages/ProChart.tsx frontend/src/pages/__tests__/ProChartLegend.test.tsx \
  frontend/src/pages/__tests__/ProChartTimeShare.test.tsx
git commit -s -m "$(cat <<'EOF'
feat(legend): 图例五项做成偏好，经 chartStyles 唯一合成点上图

chartStyles 是这片最容易写错的地方：主题 effect 每次都把整份样式重推，
偏好活在别处就会被换主题冲掉（分时/candle 那次已经付过学费）。于是图例并入
同一个函数、并进同一个依赖数组，测试的判据就是「改完偏好再切主题还在不在」。
默认值逐项等于库默认，没改过的用户首屏样式对象里图例三项还是 always/true。
EOF
)"
```

---

### Task 8: 全量门禁 ＋ 真实浏览器活体验收 ＋ 五步未来函数自查

**Files:**
- 无源码改动（除非验收发现缺陷，则按 TDD 补一条测试再修）

- [ ] **Step 1: 前端门禁（逐条跑，记录实测数字）**

```bash
cd /e/Vibe-Trading-main/Vibe-Trading-main/frontend
npx tsc --noEmit
npx vitest run 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | tail -20
npx vite build 2>&1 | tail -15
```

Expected: tsc 静默；vitest 全绿（记下 `Test Files`/`Tests` 实数）；build 成功。

- [ ] **Step 2: 后端与档案面门禁（本片不动后端，跑一次证明没连带）**

```bash
cd /e/Vibe-Trading-main/Vibe-Trading-main
python -X utf8 -m pytest -q 2>&1 | tail -8
python -X utf8 -m pytest tools/test_wiki_drift.py -q 2>&1 | tail -8
python -X utf8 tools/wiki_drift.py stale --format count
bash tools/wiki_freshness_gate.sh; echo "water rc=$?"
bash tools/ci_grep_gates.sh; echo "grep rc=$?"
```

Expected: 逐条记录**实测** rc 与数字，写进报告。硬判据只有两条：`tools/test_wiki_drift.py` 全绿；`WIKI_STALE_MAX` 一个字节不改（`git diff -- tools/wiki_freshness_gate.sh` 必须为空）。水位门本来就可能是 rc=1（继承的存量），那不是本片引入的，**不许为了让它变绿去调阈值或改档案**。

- [ ] **Step 3: 范围自检**

```bash
cd /e/Vibe-Trading-main/Vibe-Trading-main
git diff --name-only <本任务开始时记的 BASE>..HEAD
git diff --name-only <BASE>..HEAD -- agent | wc -l
```

Expected: 文件清单只含 `frontend/src/**`、`docs/superpowers/**`；`agent` 那条必须是 0。

- [ ] **Step 4: 浏览器活体验收（browser-use MCP，前端 5899，需后端 8000 已在跑）**

后端/前端未起则按 `项目档案.md` 里那套启动方式起（`scripts/` 的双击脚本或 `pnpm dev`），端口口径 8000/5899（vite `apiTarget` 出厂 8899 必改，见既有记忆）。逐项做并把**读到的值**记进报告，不接受「应该可以」：

1. `/pro-chart` 上 13 件工具逐件画一条（斐波那契/画笔之外的落点数按 `clicks`），刷新 → 13 条都在、类型不变；`document.querySelectorAll` 不算证据，读 `window.__chart.getOverlays()` 的 `name` 列表。
2. 磁吸关：在某一根的中间画水平线，读 `getOverlays()[i].points[0].value`，记录它**不等于**该根 OHLC 任何一个。
3. 磁吸开：在同一根再画一条，读它的 `value`，断言它 **∈ {open, high, low, close}**（四个值一起打出来对照）。
4. 副图（VOL）上开磁吸画一条，读回 `mode` 是 `strong_magnet` 而 `value` **不**是主图 OHLC 之一 ⇒ 证明库闸门属实、按钮 title 那句话是真的。
5. 标注：画一条、在清单里输入「前高」、刷新 → 图上文字仍在、`getOverlays()` 里那条 `extendData === "前高"`、且 `styles.line.style === "solid"`（§二.11 那条虚线缺陷的实地反证）。
6. 图例五项各切一遍，每项切换后 `getStyles()` 里对应键跟着变；切深色主题再读一次，五项都还在。
7. 导入/导出：把带标注的当前画线导出 `.json`，读文件里 `version: 2` 与该条的 `text`；清空后导入，标注文字与线型都回来。
8. 控制台零 error（`list_console_messages`），且没有 `[klinecharts]` 的 unknown-overlay 警告。

- [ ] **Step 5: 五步未来函数自查（spec §七，交付必附）**

按 spec §七 的五步逐字执行（进回放停在第 T 根 → 开磁吸画水平线 → 断言落点等于游标那根的 OHLC 之一，且等于全量态把游标当最新根时的同一个值 → 退出回放、切粗周期再切回、复查值未变 → 同一天重画一条比对 → `serializeDrawings` 快照除这一条外零差异），把每一步的实测数值写进报告。判据：磁吸取的是 `getDataByDataIndex(point.dataIndex)`（`KC:8817-8818`）的 OHLC，`point.dataIndex` 不可能越过游标（回放态 `backward:false` 已在 §7.14 钉死）。

- [ ] **Step 6: 若有缺陷按 TDD 修，无缺陷则提交本报告**

```bash
git add -f -- docs/superpowers/plans/2026-10-07-drawings-magnet-legend.md
git commit -s -m "$(cat <<'EOF'
chore(gates): 第③片全量门禁＋活体八项＋五步未来函数自查

…逐条填实测读数…
EOF
)"
```

（`docs/` 被 gitignore，故 `-f`；这条提交只在计划与验收记录需要进仓时做，若验收无缺陷也可与 Task 9 的落档合并。）

---

### Task 9: 落档 ＋ 记忆更正 ＋ 收口

**Files:**
- Modify: `项目档案.md`（仓库根，被 git 跟踪；工作树是 **CRLF**，追加要在 bytes 层做，别用会改写换行的方式）
- Modify: 项目记忆目录下的 `chart-drawing-landing-and-figure-channel.md`（以及新建磁吸/图例条目）

- [ ] **Step 1: 先数档案里现有的最后一节，再写新的一节**

```bash
cd /e/Vibe-Trading-main/Vibe-Trading-main
grep -n "^### 7\." 项目档案.md | tail -3
wc -l 项目档案.md
```

取最后一节号 +1 作为新节号（**不要引用计划里写的号**——档案可能已被别的轮次推进）。新节要写：本片交付形状（改了哪几个文件、每处职责）、门禁实测读数（条数/rc/构建耗时）、活体八项的读数、五步自查的数值、被否决与留档项（成交额行、`weak_magnet`、自定义图形、z 序）、下一片候选。轮内读数只写进这一节与提交说明，不署成基座坐标；不要在这一节加总本片笔数。

- [ ] **Step 2: 复跑读档案的门（改档案必须复跑，否则是交付态没被判定）**

```bash
cd /e/Vibe-Trading-main/Vibe-Trading-main
python -X utf8 -m pytest tools/test_wiki_drift.py -q 2>&1 | tail -8
bash tools/wiki_freshness_gate.sh; echo "water rc=$?"
```

Expected: 套件仍全绿；水位 rc 与 Step 1 之前一致（档案追加会引入新引用行，若水位因此要动，**只降不升**，不许改 `WIKI_STALE_MAX`）。

- [ ] **Step 3: 提交**

```bash
git add -- 项目档案.md
git commit -s -m "$(cat <<'EOF'
docs(archive): 第③片（画线扩展·磁吸·图例）落档

…门禁与活体读数、被否决项、坐标取证…
EOF
)"
```

- [ ] **Step 4: 记忆更正（ owed，必须做）**

- `chart-drawing-landing-and-figure-channel.md`：纠正「图元只有 line/bar/circle/text」——overlay 通道实测 7 种（`getSupportedFigures()` = `circle,line,polygon,rect,text,arc,path`，本轮实测打印），`bar` **不是**图元类型，四元限制只适用于 indicator 的逐-bar figure 通道；并补上本片新发现的库能力：`mode`（磁吸，只在蜡烛 pane 生效 `KC:8817`）与 `simpleAnnotation` 的 `ignoreEvent` + 模板钉 `line.style: dashed`（恢复不设防会变虚线并被记成用户偏好）；自定义图形从此是「未做」而不是「库不支持」。
- 新建一条：图例/样式的**唯一合成点**纪律（`chartStyles` ＋主题 effect 依赖数组），以及 v10 没有 `setTooltipOptions`、`setStyles` 深合并但 template 数组整体替换。
- 按 `verify-dispatch-prose-numbers-become-evidence` 那条：本轮再次撞到「旧数字被当判据」（TimeShare 44→46、MinuteBars 26→42），补一句到该条目。
- `ops-alert-feature-implementation.md` 里那句「Pine 告警桥在前端、语料实测 0/63 可译」之外，补第③片已交付与推荐顺序推进到 ④。

- [ ] **Step 5: 最终整支评审后收口**

用 superpowers:requesting-code-review 的评审席做一轮全分支评审（BASE = 本计划开工前的那个 commit），缺陷按 SDD 的修复循环处理；然后 `git log --oneline` 确认笔数与内容，**不推送**（推送要用户点头）。

---

## 自检（写完之后自己走一遍）

1. **spec 覆盖**：§三 A→Task 1、§三 D 存储→Task 2、§三 D 交换→Task 3、§三 D UI→Task 4、§三 B→Task 5、§三 C 纯函数→Task 6、§三 C 接线→Task 7、§六→Task 8、§七→Task 8 Step 5、§八 留档→Task 9 Step 1。§五 的 8 条边界分别由 Task 6（脏值）、Task 5（返回值不当判决/回放态不写存储）、Task 5 Step 1（Pine 线过滤）、Task 1 Step 3（工具名不存在→7 个实测存在，不做防御分支）、Task 2/3（上限 200/60 不动、40 字截断）、Task 3 Step 2（`drawingKey` 认文字）承担。
2. **占位符**：`chartStyles` 的 `bar:`/`area:` 两处「原有键逐字不动」不是占位符，是**不许改**的边界，落地时保留原文件内容；除此之外不得出现 TBD。
3. **类型一致**：`toolCreateExtras(name, mode?)`（Task 1 一参、Task 5 二参，默认值保证 Task 1 的调用与测试不破）；`MagnetMode` 只在 `chartDrawings.ts` 定义；`LegendPrefs`/`legendStyles`/`LEGEND_PREFS_KEY`/`RULE_OPTIONS` 只在 `chartLegend.ts` 定义；`applyDrawingText` 返回 `string | null`，Task 4 的 handler 只判 `null`。
