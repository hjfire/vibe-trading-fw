# L3 第③片：周期切换按钮是弹层入口（TV-CI-03 ＋ TV-CI-02）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 ProChart 工具栏上平铺的八枚「点一下换一档」周期按钮，换成一枚自陈弹层入口的按钮＋一个目录浮层，当前档位以 `aria-selected` 标在目录行上，且该行可达名与按钮可达名同名。

**Architecture:** 新增受展示组件 `frontend/src/components/charts/PeriodPicker.tsx`（不认识 store、不碰图表库，形状照 `ReplayBar.tsx`）；`ProChart.tsx` 把 `INTERVALS.map` 平铺块换成一行 `<PeriodPicker>`，档位文案与 `intervalAllowed` 门仍在页面侧算好再传下去。标记面三条通道：`aria-haspopup="menu"`＋`aria-expanded`＋`aria-controls` 在入口按钮，`role="listbox"`／`role="option"`＋`aria-selected` 在浮层，开合由组件自己的 `mousedown`／`Escape` 监听管。

**Tech Stack:** React 19 ＋ TypeScript ＋ Vite ＋ Tailwind ＋ vitest ＋ @testing-library/react。（2026-10-18 本席当场改口：原句作「React 18」，而 `frontend/package.json:28` 逐字 `"react": "^19.3.0"`、本机 `require("react/package.json").version`＝19.2.8。）

**Spec:** `docs/superpowers/specs/2026-10-18-l3-slice3-interval-popup-design.md`（裁定一～四、排除项、判态口径都在那里；本计划是它的论证，不是它的替代）

## Global Constraints

- 回复与文档正文用中文；代码、命令、属性名保留原文。
- 每笔提交都带 `-s`（上游 DCO），当场带，不事后补（本仓把提交 SHA 当数据钉在 wiki 里，补签会让戳掉出祖先链）。
- 多面改动提交必须带 pathspec（`git commit -s -- <files>`），不许裸 `git commit` 吞别人的 staged 面。
- 本片**不新增任何依赖**，不引入图标库，不引 `lucide-react`。
- 本片**不许**把对方页面的任何档位名／键值抄进被跟踪文件（`1 day` 这类一律不出现）；可达名一律用本仓中文 label。
- `frontend/src/**` 里不许出现 `tradingview.com`，也不许出现 `tradingview.toggle_delete_locked_linetools`；既存白名单命中一枚都不许顺手清。
- 两枚本机恒红门（水位门、`ci_grep_gates.sh` 的 `[gate b]`）**不调阈值、不改门、不清白名单**，只出归属证据，且证据里的读数一律当场取。
- `docs/` 在 `.gitignore` 里：本计划的 spec／计划／档案面一律 `git add -f`。
- `项目档案.md` 整文件 CRLF，只能在 bytes 层追加，追加后断言 CR 数＝LF 数、行数差与追加条数一致。
- 坐标一律**按内容现读**（`grep -n -F '<逐字文本>'` ＋ `sed -n '<号>p'` 开眼确认），**不许**拿旧行号 ±N 平移算出来。
- TDD：每根针先看它红，再写实现。测试名字里写清它钉的是哪一件事。
- 既有针的改口要**保住它原本承诺的那一半**，不许直接删。

---

### Task 1: `PeriodPicker.tsx` 组件＋组件级针

**Files:**
- Create: `frontend/src/components/charts/PeriodPicker.tsx`
- Test: `frontend/src/components/charts/__tests__/PeriodPicker.test.tsx`

**Interfaces:**
- Consumes: `IntervalKey`（`frontend/src/lib/marketApi.ts:18` 的联合类型）、`cn`（`@/lib/utils`）。
- Produces:
  ```ts
  export type PeriodOption = { key: IntervalKey; label: string; title: string; disabled: boolean };
  export type PeriodPickerProps = {
    options: readonly PeriodOption[];
    triggerLabel: string;
    active: IntervalKey | null;
    onPick: (key: IntervalKey) => void;
  };
  export function PeriodPicker(props: PeriodPickerProps): JSX.Element;
  ```
  Task 2 的页面接线按这四个 prop 传。

- [ ] **Step 1: 写组件级失败测试**

新建 `frontend/src/components/charts/__tests__/PeriodPicker.test.tsx`，全文：

```tsx
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type { IntervalKey } from "@/lib/marketApi";
import { PeriodPicker, type PeriodOption, type PeriodPickerProps } from "../PeriodPicker";

const KEYS: IntervalKey[] = ["1m", "5m", "15m", "30m", "60m", "1D", "1W", "1M"];
const LABELS = ["1分", "5分", "15分", "30分", "60分", "日线", "周线", "月线"];

/** 八档目录，`1m` 一档禁用来模拟 BTC 这类没有分钟源的标的。 */
const OPTIONS: PeriodOption[] = KEYS.map((key, i) => ({
  key,
  label: LABELS[i],
  title: `档位 ${LABELS[i]} 的说明`,
  disabled: key === "1m",
}));

const renderPicker = (props: Partial<PeriodPickerProps> = {}) => {
  const onPick = vi.fn();
  render(
    <PeriodPicker
      options={OPTIONS}
      triggerLabel="日线"
      active="1D"
      onPick={onPick}
      {...props}
    />,
  );
  return onPick;
};

const trigger = (): HTMLButtonElement =>
  screen.getByRole("button", { name: "日线" }) as HTMLButtonElement;

describe("PeriodPicker 的入口按钮自陈弹层", () => {
  it("入口按钮带 aria-haspopup=menu 与 aria-expanded=false", () => {
    renderPicker();
    expect(trigger().getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("点入口只展开目录，一次也不换档", () => {
    const onPick = renderPicker();
    fireEvent.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(onPick).not.toHaveBeenCalled();
  });

  it("目录只在打开时进 DOM：打开前数不到 listbox，打开后数到", () => {
    renderPicker();
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(trigger());
    expect(screen.getByRole("listbox")).toBeTruthy();
  });
});

describe("PeriodPicker 的目录行", () => {
  it("当前档位那一行 aria-selected=true，其余七行 false", () => {
    renderPicker();
    fireEvent.click(trigger());
    const rows = screen.getAllByRole("option");
    expect(rows).toHaveLength(8);
    const selected = rows.filter((row) => row.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0].textContent).toBe("日线");
  });

  it("选中行的可达名逐字等于入口按钮的可达名", () => {
    renderPicker();
    fireEvent.click(trigger());
    const row = screen.getByRole("option", { name: "日线" });
    expect(row.getAttribute("aria-selected")).toBe("true");
    expect(row.textContent).toBe(trigger().textContent);
  });

  it("active=null（分时态）时八行都不选中，按钮照旧显示 triggerLabel", () => {
    renderPicker({ active: null });
    fireEvent.click(trigger());
    for (const row of screen.getAllByRole("option")) {
      expect(row.getAttribute("aria-selected")).toBe("false");
    }
    expect(trigger().textContent).toBe("日线");
  });

  it("disabled 的行点了不回调，且带 title", () => {
    const onPick = renderPicker();
    fireEvent.click(trigger());
    const row = screen.getByRole("option", { name: "1分" }) as HTMLButtonElement;
    expect(row.disabled).toBe(true);
    expect(row.getAttribute("title")).toBe("档位 1分 的说明");
    fireEvent.click(row);
    expect(onPick).not.toHaveBeenCalled();
  });

  it("点未禁用的行会带 key 回调 onPick", () => {
    const onPick = renderPicker();
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("option", { name: "周线" }));
    expect(onPick).toHaveBeenCalledWith("1W");
  });
});

describe("PeriodPicker 的三条关闭通道", () => {
  it("再点一次入口：展开→收起，aria-expanded 回 false", () => {
    renderPicker();
    fireEvent.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("组件外 mousedown 关闭目录", () => {
    renderPicker();
    fireEvent.click(trigger());
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("false");
  });

  it("Escape 关闭目录并把焦点还给入口按钮", () => {
    renderPicker();
    fireEvent.click(trigger());
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("选完一档目录自动关闭", () => {
    renderPicker();
    fireEvent.click(trigger());
    fireEvent.click(screen.getByRole("option", { name: "周线" }));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("目录打开时选中行仍带 bg-muted font-medium 这个视觉标记", () => {
    renderPicker();
    fireEvent.click(trigger());
    const row = within(screen.getByRole("listbox")).getByRole("option", { name: "日线" });
    expect(row.className).toContain("bg-muted font-medium");
  });
});
```

- [ ] **Step 2: 跑一次，确认它红**

Run: `cd frontend && npx vitest run src/components/charts/__tests__/PeriodPicker.test.tsx`
Expected：FAIL，报错是模块解析不了（`Failed to resolve import "../PeriodPicker"`）。这就是「功能还没有」的那种红，不是拼写错。

- [ ] **Step 3: 写组件实现**

新建 `frontend/src/components/charts/PeriodPicker.tsx`，全文：

```tsx
import { useEffect, useRef, useState } from "react";

import type { IntervalKey } from "@/lib/marketApi";
import { cn } from "@/lib/utils";

/** One row of the interval directory, fully decided by the page. */
export type PeriodOption = {
  key: IntervalKey;
  label: string;
  title: string;
  disabled: boolean;
};

export type PeriodPickerProps = {
  options: readonly PeriodOption[];
  /** The trigger's accessible name — the page passes the current option's label,
   *  so "the button names the selected row" holds at name level. */
  triggerLabel: string;
  /** Which row carries the selected state. `null` while 分时 is on: 分时 is a
   *  view, not a period, so no directory row is the current one. */
  active: IntervalKey | null;
  onPick: (key: IntervalKey) => void;
};

/**
 * TV-CI-03/02: the interval control is a popup entry, not an instant switch.
 * The trigger self-reports `hasPopup,menu` the way the other side's toolbar
 * button does, and the directory it opens marks the current interval with
 * `aria-selected` on a row whose name equals the trigger's.
 */
export function PeriodPicker({ options, triggerLabel, active, onPick }: PeriodPickerProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleMouseDown = (event: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("mousedown", handleMouseDown);
    document.addEventListener("keydown", handleEscape);
    return () => {
      document.removeEventListener("mousedown", handleMouseDown);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [open]);

  return (
    <div className="relative" ref={wrapRef}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((previous) => !previous)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls="pro-chart-period-menu"
        title={
          active === null
            ? `周期目录：当前线上画的是分时，档位仍是 ${triggerLabel}（点开换档）`
            : `周期目录：当前 ${triggerLabel}（点开换档）`
        }
        className={cn(
          "rounded-md border px-2 py-1 text-xs hover:bg-muted",
          active !== null && "bg-muted font-medium",
        )}
      >
        {triggerLabel}
      </button>
      {open && (
        <div
          id="pro-chart-period-menu"
          role="listbox"
          aria-label="周期目录"
          className="absolute left-0 top-full z-50 mt-1 min-w-full rounded-md border bg-background py-1 shadow-lg"
        >
          {options.map((option) => (
            <button
              key={option.key}
              type="button"
              role="option"
              aria-selected={option.key === active}
              disabled={option.disabled}
              title={option.title}
              onClick={() => {
                setOpen(false);
                onPick(option.key);
              }}
              className={cn(
                "block whitespace-nowrap px-3 py-1 text-left text-xs hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40",
                option.key === active && "bg-muted font-medium",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: 复跑组件测试，确认本文件里每一根针全绿**

Run: `cd frontend && npx vitest run src/components/charts/__tests__/PeriodPicker.test.tsx`
Expected：PASS。条数按当场读数对账，别信任何写在这里的数字——`npx vitest run …` 末尾那行 `Tests  N passed` 的 `N` 必须等于
`grep -c '^  it(' src/components/charts/__tests__/PeriodPicker.test.tsx`，且 `skipped`／`failed` 都是 0。
输出干净、没有 warning。

- [ ] **Step 5: 类型检查**

Run: `cd frontend && npx tsc -b`
Expected：rc=0。（若 `JSX.Element` 这族名字在本仓 tsconfig 下不成立，返回类型那行删掉让 TS 自己推，**不要**引 `React.*` 命名空间。）

- [ ] **Step 6: 提交**

```bash
git add frontend/src/components/charts/PeriodPicker.tsx frontend/src/components/charts/__tests__/PeriodPicker.test.tsx
git commit -s -m "feat(pro-chart): PeriodPicker 受展示组件——入口按钮自陈 haspopup/expanded，目录行带 aria-selected（TV-CI-03/02）"
```

---

### Task 2: ProChart 接线＋五个既有测试文件的消费者改口（同一笔）

接线与它的消费者必须同笔落地：先改签名再改调用点会留一笔 `tsc`／vitest 红的中间提交。

**Files:**
- Modify: `frontend/src/pages/ProChart.tsx`（平铺块、`periodActive` 谓词、`:2579` 那句注释、import 段）
- Modify: `frontend/src/pages/__tests__/ProChartMinuteBars.test.tsx`
- Modify: `frontend/src/pages/__tests__/ProChartCompare.test.tsx`
- Modify: `frontend/src/pages/__tests__/ProChartReplay.test.tsx`
- Modify: `frontend/src/pages/__tests__/ProChartReplayDrawings.test.tsx`
- Modify: `frontend/src/pages/__tests__/ProChartTimeShare.test.tsx`

**Interfaces:**
- Consumes: Task 1 的 `PeriodPicker`／`PeriodOption`。
- Produces: 页面上不再有名为「日线」的**平铺**按钮；档位行的角色是 `option`。Task 3 的新针按这个形状写。

- [ ] **Step 1: 现读要动的四处坐标（不许用本计划里的号，号会漂）**

```bash
cd frontend && grep -n -F 'INTERVALS.map((i) => {' src/pages/ProChart.tsx
grep -n -F 'const periodActive = (key: IntervalKey) => !timeShare && interval === key;' src/pages/ProChart.tsx
grep -n -F 'Which period button is lit.' src/pages/ProChart.tsx
grep -n -F 'isCalendarInterval(i.key)' src/pages/ProChart.tsx
```
Expected：四条各命中 1 次（`INTERVALS.map` 那枚若在同文件出现两次，以带 `const disabled = !intervalAllowed(symbol, i.key);` 的那一处为准——现读它只有一处）。把这四枚号抄进任务报告，作为改动前后各读一次的凭据。

- [ ] **Step 2: 加 import**

`ProChart.tsx` 的组件 import 段（`import { ReplayBar … }` 那一族旁边，按现有分组）加一行：

```tsx
import { PeriodPicker, type PeriodOption } from "@/components/charts/PeriodPicker";
```

- [ ] **Step 3: 加派生数据 `periodOptions`，删 `periodActive`**

在 `periodActive` 那三行（注释＋谓词）所在位置写入：

```tsx
  // The interval directory's rows: the copy and the gate stay here because they
  // are the page's rules (`intervalAllowed` is asked by 分时 and by the repair on
  // symbol switch too). `active` is null while 分时 is on — 分时 is not a period,
  // so no directory row may claim to be the current one (㉖).
  const periodOptions = useMemo<PeriodOption[]>(
    () =>
      INTERVALS.map((i) => {
        const disabled = !intervalAllowed(symbol, i.key);
        return {
          key: i.key,
          label: i.label,
          disabled,
          title: disabled
            ? "分钟线需 FutuOpenD（支持 .SH/.SZ/.HK/.US）"
            : isCalendarInterval(i.key)
              ? "日线链：周线/月线把日线按自然周/自然月合并，复权口径与日线一致"
              : "分钟线优先取 FutuOpenD，A股在其未应答时落回新浪",
        };
      }),
    [symbol],
  );
  // `?? interval` is a typing necessity, not a fallback: every IntervalKey is in
  // INTERVALS, so the find always answers.
  const periodTriggerLabel = INTERVALS.find((i) => i.key === interval)?.label ?? interval;
  const periodActiveKey: IntervalKey | null = timeShare ? null : interval;
```

并把原来的 `const periodActive = …` 那一行连同它上面那句「Which period button is lit.」注释一起删掉（谓词没有别的消费者，留着撞 `noUnusedLocals`）。注释里那句「`viewPeriod` would answer "1分" while the line …」的语义已经由上面的 `active` 注释接手。

- [ ] **Step 4: 换掉工具栏的平铺块**

把 Step 1 现读到的那一整块 `INTERVALS.map((i) => { … })}`（从 `{INTERVALS.map((i) => {` 起到配对的 `})}`，现读为 26 行）整块替换为：

```tsx
          <PeriodPicker
            options={periodOptions}
            triggerLabel={periodTriggerLabel}
            active={periodActiveKey}
            onPick={pickInterval}
          />
```

三条不许动的东西：`pickInterval`（`:1959` 那处函数体一字不改）、分时按钮那块（`disabled={!intervalAllowed(symbol, TIME_SHARE_INTERVAL)}` 起）、以及包裹它的 `<div className="flex gap-1">` 与闭合 `</div>`。

- [ ] **Step 5: 改口五个测试文件的 helper**

统一用这一组四个 helper（**一枚入口定位 ＋ 一枚行定位 ＋ 两枚动作**），逐个文件原样抄进模块级位置（放在 `seedSession` 之后／第一个 `describe` 之前；已有 `buttonOf` 的文件保留 `buttonOf` 不动）：

```tsx
/** 目录是浮层。工具栏里唯一一枚自陈 haspopup=menu 的按钮就是周期入口——
 *  按属性定位而不是按可达名，因为它的名字随当前档位变。 */
const periodTrigger = (): HTMLElement => {
  const candidates = screen
    .getAllByRole("button")
    .filter((b) => b.getAttribute("aria-haspopup") === "menu");
  expect(candidates).toHaveLength(1);
  return candidates[0];
};

const optionOf = (label: string): HTMLButtonElement =>
  screen.getByRole("option", { name: label }) as HTMLButtonElement;

/** 幂等地把目录打开：已经开着就一步都不做。
 *  写成无条件点入口的话，凡是「先开目录读一行、再选一行」的调用点都会在第二次点入口时
 *  把目录关掉，于是 `optionOf` 数不到东西——那是 helper 自己的坑，不是被测实现的缺陷。 */
async function openPeriodMenu(): Promise<void> {
  if (periodTrigger().getAttribute("aria-expanded") === "true") return;
  await act(async () => {
    fireEvent.click(periodTrigger());
  });
}

async function pickPeriod(label: string): Promise<void> {
  await openPeriodMenu();
  await act(async () => {
    fireEvent.click(optionOf(label));
  });
}
```

定位方式为什么不用 `aria-controls`：testing-library 的 `controls` 选项要求被引用的那个 id **在树里**，而目录是条件渲染，关着的时候 `getByRole("button", { controls: "pro-chart-period-menu" })` 数不到东西。`aria-haspopup` 属性定位不依赖浮层在不在，且「全页只有一枚弹层入口」这条前提被 helper 里那句 `toHaveLength(1)` 自己守住。

用了 `openPeriodMenu`／`pickPeriod` 的 `it` 必须是 `async`；原本不 `async` 的补上 `async`（箭头函数那行的 `it("…", () => {` 改 `it("…", async () => {`）。

调用点逐处改法（按内容现读定位，别按本表的号）：

| 文件 | 原句（按内容现读定位，别按本表的号） | 改成 |
|---|---|---|
| `ProChartMinuteBars.test.tsx` | `  const disabledOf = (name: string): boolean =>`<br>`    (screen.getByRole("button", { name }) as HTMLButtonElement).disabled;` | 换成 `const disabledOf = (label: string): boolean => optionOf(label).disabled;`——名字保持 `disabledOf`，消费者一行都不用动，但它现在读的是目录里的行，所以**每个用它的地方之前必须已经开过目录** |
| 同上 `disabledOf("5分")` 那一问 | `    expect(disabledOf("5分")).toBe(false);` | 本行不动，在它前面插入一步 `    await openPeriodMenu();` |
| 同上紧随其后的点档位 | `    fireEvent.click(screen.getByRole("button", { name: "5分" }));` | `    await pickPeriod("5分");`（上一行已经把目录开着，`pickPeriod` 走 `openPeriodMenu` 的幂等分支，不会重复点入口；选完目录自己关闭，所以后面的断言照旧读按钮） |
| 同上 `:302`–`:308` 的循环 | `      expect(disabledOf(label)).toBe(true);` 等五行 | 循环之前插入一次 `    await openPeriodMenu();`，循环体保持 `disabledOf(label)` 形状（此时它读的是 option）。**不许**把开目录写进循环体——每次点入口会在开／关之间交替 |
| 同上 `:314`／`:316` | `    fireEvent.click(screen.getByRole("button", { name: "周线" }));`／同形「月线」句 | `    await pickPeriod("周线");`／`    await pickPeriod("月线");` |
| `ProChartCompare.test.tsx` 三处 | `    fireEvent.click(screen.getByRole("button", { name: "周线" }));` | 三处各换成 `await pickPeriod("周线");`（所在 `it` 已是 `async`） |

`ProChartReplay.test.tsx` 与 `ProChartReplayDrawings.test.tsx` 已经有 `buttonOf`／`click` helper（`ProChartReplay.test.tsx:240-247`，`ProChartReplayDrawings.test.tsx:263-270`），**调用点一行都不改**：把上面那一整组 helper（`periodTrigger`／`optionOf`／`openPeriodMenu`／`pickPeriod`）抄进去，再只把 `click` 的实现换成先分流：

```tsx
const periodLabels = new Set(["1分", "5分", "15分", "30分", "60分", "日线", "周线", "月线"]);

const click = async (name: string): Promise<void> => {
  if (periodLabels.has(name)) {
    await pickPeriod(name);
    return;
  }
  await act(async () => {
    fireEvent.click(buttonOf(name));
  });
};
```

`ProChartTimeShare.test.tsx` 同样保留 `buttonOf`，另把上面那一整组四个 helper 原样抄进来，并把调用点逐处改口：

| 现读坐标（按内容重找） | 原句 | 改成 |
|---|---|---|
| `:550` | `    fireEvent.click(buttonOf("日线"));` | `    await pickPeriod("日线");` |
| `:563` 的八枚循环 | `      expect(buttonOf(label).className).not.toContain("bg-muted font-medium");` | 见 Step 6 |
| `:645-646` 的 `it.each` 表 | 表里点档位的执行体 | 换成 `await pickPeriod(label);` |
| `:737` 的五枚循环 | `      fireEvent.click(buttonOf(label));` | `      await pickPeriod(label);` |

- [ ] **Step 6: 那枚「分时态下没有周期档位亮着」的循环，按承诺改口**

`ProChartTimeShare.test.tsx:563` 那个循环原本钉的是「分时开着，没有周期按钮带 `bg-muted font-medium`」。**保住承诺**的写法＝CSS 那半条留着，再加无障碍那半条：

```tsx
    fireEvent.click(buttonOf("分时"));
    await settle();
    await openPeriodMenu();
    for (const label of ["1分", "5分", "15分", "30分", "60分", "日线", "周线", "月线"]) {
      const row = optionOf(label);
      expect(row.getAttribute("aria-selected")).toBe("false");
      expect(row.className).not.toContain("bg-muted font-medium");
    }
    expect(buttonOf("分时").className).toContain("bg-muted font-medium");
```

（上面这段替换的是原块里 `for (const label of [...])` 那一个循环体，`fireEvent.click(buttonOf("分时"))` 与末行的断言原样保留——写在一起只为让替换边界看得清楚，实际改动手顺序：在循环前插入 `await openPeriodMenu();`，循环体换成两行断言。CSS 那半条 `not.toContain` 逐字不动，它是这枚针原本的承诺。）

- [ ] **Step 7: 全量前端测试复跑**

Run: `cd frontend && npx tsc -b && npx vitest run`
Expected：tsc rc=0；vitest 全绿（本片动的五个文件＋新组件文件在内）。若某一枚 helper 在本仓的 jsdom／`act` 形状下不成立（例如 `openPeriodMenu` 里 `aria-expanded` 读不到、或 `getByRole("option")` 数不到 `<button role="option">`），**当场定形成实际可用的那一种**，五份文件统一用同一种，不许留下「一处 A 写法、另一处 B 写法」；把这条现读结论写进报告。

- [ ] **Step 8: 提交（一笔，带 pathspec）**

```bash
git add frontend/src/pages/ProChart.tsx frontend/src/pages/__tests__/ProChartMinuteBars.test.tsx frontend/src/pages/__tests__/ProChartCompare.test.tsx frontend/src/pages/__tests__/ProChartReplay.test.tsx frontend/src/pages/__tests__/ProChartReplayDrawings.test.tsx frontend/src/pages/__tests__/ProChartTimeShare.test.tsx
git commit -s -m "feat(pro-chart): 周期平铺行换成弹层入口——目录行带 selected 态，八档改由浮层承载（TV-CI-03/02）"
```

---

### Task 3: 页面级三根新针

**Files:**
- Modify: `frontend/src/pages/__tests__/ProChartMinuteBars.test.tsx`（复用它的活页 harness）
- Modify: `frontend/src/pages/__tests__/ProChartTimeShare.test.tsx`

**Interfaces:**
- Consumes: Task 2 落地后的页面形状（入口按钮 `aria-haspopup="menu"`、浮层 `role="listbox"`／行 `role="option"`＋`aria-selected`）与 Task 2 Step 5 抄进这两个文件的同一组 helper（`periodTrigger`／`optionOf`／`openPeriodMenu`／`pickPeriod`）。
- Produces: 无（末端任务）。

- [ ] **Step 1: 写三根针（先看它们红或写得对）**

追加进 `ProChartMinuteBars.test.tsx` 最后那个 `describe` 里：

```tsx
  it("入口按钮的可达名跟着当前档位走，换档后一起换", async () => {
    seedSession("0700.HK", "1D");
    await mountChart();
    expect(periodTrigger().textContent).toBe("日线");
    await pickPeriod("周线");
    expect(periodTrigger().textContent).toBe("周线");
  });

  it("目录里选中行的可达名与入口按钮同名（TV-CI-02 那一半句的形状）", async () => {
    seedSession("0700.HK", "1D");
    await mountChart();
    const name = periodTrigger().textContent;
    await openPeriodMenu();
    const row = optionOf("日线");
    expect(row.getAttribute("aria-selected")).toBe("true");
    expect(row.textContent).toBe(name);
  });

  it("点目录里的档位＝换档并且目录自己关闭", async () => {
    seedSession("0700.HK", "1D");
    await mountChart();
    await pickPeriod("60分");
    expect(h.periods.at(-1)).toEqual({ type: "minute", span: 60 });
    expect(screen.queryByRole("listbox")).toBeNull();
  });
```

第二枚那三行的形状是这格的重点：**入口的名字是从入口读的，不是写死的**——「同名」这一半句要的是两个读数相等，把它写成 `toBe("日线")` 就退化成第一枚针的重复断言。

- [ ] **Step 2: 跑，确认三根绿**（它们钉的是 Task 2 已落地的形状；若某一枚直接绿且实现里根本没有那个形状，说明针写空了——按 §Task 4 的注入法验它的判别力。）

Run: `cd frontend && npx vitest run src/pages/__tests__/ProChartMinuteBars.test.tsx`

- [ ] **Step 3: 分时态入口按钮的可达名**

追加进 `ProChartTimeShare.test.tsx` 那个 `describe("分时 and the period buttons are mutually exclusive")`：

```tsx
  it("分时态下入口按钮仍显示 underlying 档位，但目录里没有选中行", async () => {
    seedSession("0700.HK", "15m");
    await mountChart();
    fireEvent.click(buttonOf("分时"));
    await settle();
    expect(periodTrigger().textContent).toBe("15分");
    await openPeriodMenu();
    expect(optionOf("15分").getAttribute("aria-selected")).toBe("false");
  });
```

- [ ] **Step 4: 复跑＋提交**

```bash
cd frontend && npx vitest run src/pages/__tests__/ProChartMinuteBars.test.tsx src/pages/__tests__/ProChartTimeShare.test.tsx
git add frontend/src/pages/__tests__/ProChartMinuteBars.test.tsx frontend/src/pages/__tests__/ProChartTimeShare.test.tsx
git commit -s -m "test(pro-chart): 页面级三根针——入口名跟档位变、名到名同名、分时态无 selected 行"
```

---

### Task 4: 变异自证（针的判别力）

八枚注入。每条都按本仓 Windows 探针纪律：动手前把所有将被写的文件**一次读进内存**当基线并算 sha，还原只从那份副本写回，还原后看**全树** `git diff --stat` 与逐文件 sha 两项。

- [ ] **Step 1: 写探针脚本**（仓库外，`%TEMP%` 下；路径用正斜杠或原始串，别在带引号 heredoc 里写反斜杠）

```python
import hashlib, subprocess, pathlib
FILES = [
    "frontend/src/components/charts/PeriodPicker.tsx",
    "frontend/src/pages/ProChart.tsx",
]
BASE = {f: pathlib.Path(f).read_bytes() for f in FILES}          # 读必须发生在任何写之前
SHA = {f: hashlib.sha256(BASE[f]).hexdigest() for f in FILES}

INJECTIONS = [
    ("M1 摘 aria-haspopup", FILES[0], b'        aria-haspopup="menu"\n', b''),
    ("M2 摘 aria-expanded", FILES[0], b'        aria-expanded={open}\n', b''),
    ("M3 入口改即时开关", FILES[0], b'        onClick={() => setOpen((previous) => !previous)}\n', b'        onClick={() => onPick(active ?? "1D")}\n'),
    ("M4 selected→checked", FILES[0], b'              aria-selected={option.key === active}\n', b'              aria-checked={option.key === active}\n'),
    ("M5 目录常渲染+hidden", FILES[0], b'      {open && (\n', b'      {true && (\n'),
    ("M6 去掉选完关闭", FILES[0], b'                setOpen(false);\n                onPick(option.key);\n', b'                onPick(option.key);\n'),
    ("M7 active 不判分时", FILES[1], b'  const periodActiveKey: IntervalKey | null = timeShare ? null : interval;', b'  const periodActiveKey: IntervalKey | null = interval;'),
    ("M8 triggerLabel 加后缀", FILES[1], b'const periodTriggerLabel = INTERVALS.find((i) => i.key === interval)?.label ?? interval;', b'const periodTriggerLabel = (INTERVALS.find((i) => i.key === interval)?.label ?? interval) + " 周期";'),
    ("M9 摘 aria-controls 与孤儿 id", FILES[0], b'        aria-controls="pro-chart-period-menu"\n', b''),
]
```

（M9 是 Task 1 修复轮带回来的第 九 枚——评审席量出「摘掉 `aria-controls` 连同目录那一侧的 `id`，19 根针全绿」，修复轮补了名到名那一根（`aria-controls` 的值必须等于打开后浮层的 `id`），所以 M9 现在预期 `RED`。单摘 `aria-controls` 一根就够红，不必连 `id` 一起摘。）

（M10 是收窄复评带回来的第 十 枚，形状与前九枚不同＝**一处注入要同时做两处替换**：把 `wrapRef` 从容器 `<div className="relative" ref={wrapRef}>` 上摘掉、改挂到入口按钮上（按钮已有 `ref={triggerRef}`，第二枚 ref 用回调 ref 一并交上去）。这一枚钉的是「容器到底包住谁」：`wrapRef` 只管浮层或只管按钮时，真实浏览器里在目录行上按下鼠标会先被判成「组件外」而关掉目录，随后的 `click` 打在已卸载的行上 ⇒ `onPick` 永不触发，而本计划给的针全部只用 `fireEvent.click`、不发 `mousedown`，结构上看不见它。复评已明写：`ref` 只挂按钮的那一枚反向变异**目前整套全绿**，所以本枚预期 `NEEDLE-MISS` 或 `HARNESS-BLIND` 都要按 Step 3 补针——要补的形状是「`mouseDown(行)` ＋ `click(行)` 之后 `onPick` 恰被调一次」，补完重跑本枚到 `RED`。）

（八枚 needle 由执行席**按落地后文件里的逐字文本现读**再生成一遍——上面这组是按本计划代码块推的目标形状，行内缩进差一个字节就注不进去；注入前先断言 `BASE` 里那枚 needle 出现次数恰为 1，出现 0 次或 >1 次就停下改 needle，不许「注不上就算等价」。）

- [ ] **Step 2: 逐枚跑**：注入 → `cd frontend && npx vitest run src/components/charts/__tests__/PeriodPicker.test.tsx src/pages/__tests__/ProChartMinuteBars.test.tsx src/pages/__tests__/ProChartTimeShare.test.tsx` → 记录哪几根红 → 从 `BASE` 写回 → 校验 sha 全等。三态判定：`RED`（至少一根红）／`HARNESS-BLIND`（既没报错也没变红）／`NEEDLE-MISS`（针没注进去）。

- [ ] **Step 3: 对 `HARNESS-BLIND` 的枚补针**，补完重跑该枚，直到每枚要么 `RED` 要么有书面理由记进台账（M5「常渲染＋hidden」这一枚预期是 HARNESS-BLIND 的形状＝`hidden` 属性在 jsdom 里不禁 role 查询，`queryByRole("listbox")` 仍非 null ⇒ 第 3 根针会红，如果它不红就是针写错了）。

- [ ] **Step 4: 收尾校验**（不许省）

```bash
git status --porcelain && git diff --stat && python - <<'PY'
import hashlib, pathlib
for f in ["frontend/src/components/charts/PeriodPicker.tsx","frontend/src/pages/ProChart.tsx"]:
    print(f, hashlib.sha256(pathlib.Path(f).read_bytes()).hexdigest())
PY
```
Expected：`git status --porcelain` 只剩未跟踪的 scratch；`git diff --stat` 无输出；sha 与 Step 1 记录的基线逐枚相等。

---

### Task 5: 门禁全量＋恒红门归属

- [ ] **Step 1:** `cd frontend && npx tsc -b` → 记 rc。
- [ ] **Step 2:** `cd frontend && npx vitest run` → 记 tally（与基线比：基线数**当场**在 `main` 基座或本片第一笔之前测一次，两个数都要写）。
- [ ] **Step 3:** `cd frontend && npx vite build` → 记 rc。
- [ ] **Step 4:** `python -m pytest tools/test_wiki_drift.py tools/test_wiki_qmind.py -q` → 记 tally。
- [ ] **Step 5:** `python tools/forensics_audit.py` → 记 rc。
- [ ] **Step 6:** `python -m pytest tools/test_forensics_spec.py -q` → 记 tally。
- [ ] **Step 7:** `bash tools/wiki_freshness_gate.sh` → 预期红；取 `wiki stale pages: N (threshold M)` 那一行，并**与本片开工前同一命令的读数比页数**，写成等值式（本片只动 `frontend/src/**` 与 `docs/**`，不动 wiki 页面 driver，页数应逐字不变）。
- [ ] **Step 8:** `bash tools/ci_grep_gates.sh` → 预期只红在 `[gate b]`；归属证据两条：命中文件集合与本片 `git diff --name-only <base> HEAD` 的交集为空；被改文件里 `WorldQuant` 计数 0。
- [ ] **Step 9:** 把八道读数写进任务报告。不调任何阈值、不改任何门、不清任何白名单命中。

---

### Task 6: L2 矩阵两格升态

**Files:**
- Modify: `docs/forensics/gap-matrix.md`（第 90、91 两行；号按内容现读，条目号才是主键）

- [ ] **Step 1: 现读新锚**

```bash
grep -n 'aria-haspopup="menu"' frontend/src/components/charts/PeriodPicker.tsx
grep -n 'aria-selected={option.key === active}' frontend/src/components/charts/PeriodPicker.tsx
sed -n '<上面两个号>p' frontend/src/components/charts/PeriodPicker.tsx
git status --porcelain -- frontend/src/components/charts/PeriodPicker.tsx
```
Expected：各 1 命中、开行确认那两行确实写着这枚属性、该文件状态干净（已提交、工作树无改动）——矩阵坐标只许落在干净文件上。

- [ ] **Step 2: 复跑两格的老 needle，取新读数**

```bash
grep -rn --include=*.tsx -e aria-haspopup frontend/src/pages/ProChart.tsx frontend/src/components/charts
grep -rn --include=*.tsx -e aria-selected frontend/src/pages/ProChart.tsx frontend/src/components/charts
```
Expected：都不再是 0 命中。逐字记下命中行（含文件与号），命中数用 `grep -c` 行数那把尺时要说清口径（`PeriodPicker.test.tsx` 这类测试文件里的命中要单独说明，别让「1 枚生产标记」被测试文件的计数污染）。

- [ ] **Step 3: 改 TV-CI-03 那一行**

状态列 `缺` → `已有`。第三列那整串 `未找到：周期按钮自陈弹层入口 —— 复跑命令 …` **逐字搬进说明列开头、一字不删**，后面接：

- 新第三列＝`frontend/src/components/charts/PeriodPicker.tsx:<Step 1 现读的 aria-haspopup 行号>`；
- 带日期追加子句（本席 2026-10-18 跑）＝**同一条命令命中 `<N>` 行**（其中生产标记 `<M>` 枚，`<文件:行号>` 逐字列出；其余命中在测试文件里，列出文件名），这条读数就是升 `已有` 的判据；
- 形状句：入口按钮 `aria-haspopup="menu"`＋`aria-expanded`，点它**不换档**（`onPick` 一次也不被调），目录只在打开时进 DOM；
- 裁定四的登记：本仓的 `hasPopup` 值写 `menu` 而浮层是 `listbox`，理由照 spec §2 裁定四一句写清（对方自己就是 `hasPopup,menu` 开出一个 treegrid），并写明这是**本仓自拟的实现选择**，不是对对方 widget 族的复刻主张；
- 反外推红线：本格只买「按钮自陈弹层入口」这一形状，**不**声称本仓目录是两层 treegrid、也**不**声称有 39 行／六类分组（那是 TV-CI-01，判态不动）。

- [ ] **Step 4: 改 TV-CI-02 那一行**

状态列 `部分` → `已有`。第三列旧值 `frontend/src/pages/ProChart.tsx:2730` **逐字搬进说明列开头**，并带日期登记：该号 2026-10-18 现读那一行逐字是「对比（第⑥片）」那段注释，本格记录的 `periodActive(i.key) && "bg-muted font-medium",` 那句话在当时的行号是 **`<现读号>`**（第⑥片的对比按钮注释插入造成的漂移），本格按**内容**重钉、不拿号平移算。新第三列＝`frontend/src/components/charts/PeriodPicker.tsx:<Step 1 现读的 aria-selected 行号>`。说明列继续写：

- 两半句各自怎么落：目录行 `aria-selected`（无障碍 selected 态，不再是只有 CSS 类），入口按钮可达名逐字等于选中行可达名（按钮正文就是那一档的 label，不加 `aria-label`／不加可见箭头文字）；
- 复跑命令：`grep -rn --include=*.tsx -e aria-selected frontend/src/pages/ProChart.tsx frontend/src/components/charts` 的实际新读数（同 Step 2 的口径说明）；
- 分时态那条边界：分时开着时目录里**没有** selected 行（分时不是档位，㉖），而入口按钮仍显示 underlying 档位名——这一格不假装「任何时候都有一行选中」；
- 反外推红线：本仓目录是一层八档，没有 level=1 分组行，`row`/`treegrid` 那族形状与 TV-CI-01 一样不在本格承诺里。

- [ ] **Step 5: 两门复跑**

```bash
python tools/forensics_audit.py
python -m pytest tools/test_forensics_spec.py -q
```
Expected：两条各自 rc=0／全绿。矩阵那一行的合同（审计器实际读的规则在 `tools/forensics_audit.py` 里，本席写计划时读过：列数必须正好 5；`已有`／`部分` 的第三列必须 fullmatch `[\w./-]+:\d+`、解析到仓库根之内、且**不许**落在 `docs/forensics/**`（漏斗产物不能自证）、文件存在且行号在 `1..行数` 之内）由这两条门替你验，红了就按消息改矩阵，不改审计器。

- [ ] **Step 6: 提交**

```bash
git add -f docs/forensics/gap-matrix.md
git commit -s -m "docs(forensics): L2 两格升态——TV-CI-03 与 TV-CI-02 落「弹层入口＋目录 selected 态」（含旧锚逐字搬迁与漂移登记）"
```

---

### Task 7: 活体验收＋未来函数自查

- [ ] **Step 1: 起服务**（后端 8000／前端 5899，照本仓启动方式；代理端口**现读**注册表，别照抄旧值）

- [ ] **Step 2: 浏览器实测五件事**，逐件记下读数（点入口→目录出现且当前档位高亮；点另一档→图与按钮正文一起换、目录关；分时态→目录无选中行；`Escape` 与外点都能关）；**浮层层叠**这一件必须看截图：`z-50` 在工具栏 `flex-wrap` 行里有没有被图表盖住、目录有没有被 `overflow` 裁掉。

- [ ] **Step 3: 无障碍树自证**（可选，`take_snapshot` 里入口按钮的 role/state 有没有报出 haspopup/expanded，目录行的 selected 有没有进树）。跑不动就写「本席未取该读数」，不许把源码属性当活体读数写。

- [ ] **Step 4: 未来函数五步自查**：本片纯交互面，不产指标不产信号。五步照走一遍并给结论句「本片不参与重绘面，不声称证明了无未来函数」。

---

### Task 8: 落档 §7.27＋记忆更正

- [ ] **Step 1:** `项目档案.md` bytes 层追加一节 §7.27（一节一行一条目，含：本片刻意选两次点击换档的裁定、`hasPopup=menu` 配 `listbox` 的选择、测试定位改走 `aria-haspopup` 属性而不是 `aria-controls`（浮层条件渲染，`controls` 那枚选项要求被引用的 id 在树里）、两格升态与旧锚漂移登记、恒红门归属、活体读数）。追加前后各读一次 CR/LF 计数与字节数，断言差与追加内容一致；追加脚本**幂等门写在落笔之前**（先查这一节的标题是否已存在）。
- [ ] **Step 2:** 记忆更正：`chart-overlay-flags-lock-visible` 附近那条交互面条目补「周期控制自 2026-10-18 起是弹层入口，档位行的角色是 `option`，测试要经 `pickPeriod` helper」；`ops-delivered-features-and-comparisons` 加㊿ 第③片条目（坐标一律现读号，别在记忆里写号）。
- [ ] **Step 3:** `git add -f 项目档案.md` ＋ pathspec 提交（`-s`）。
- [ ] **Step 4:** 最终整支评审（最 capable 席）→ 一枚修复席 → 一次收窄复评 → 残留逐条裁定入台账。

---

## 自检清单（写完计划的本席自跑，不交给执行席）

- spec §0～§9 每一节都有对应任务：§1 判态→Task 6；§2 四裁定→Task 1/2 的实现与 Task 6 的登记；§3.1→Task 1；§3.2→Task 2 Step 2-4；§3.3→Task 2 Step 5-6；§4 十一根针→Task 1 Step 1（组件级）＋Task 3（页面级）；§5 排除面→Task 1/2 的代码边界（不做两层 treegrid、不做 roving focus／typeahead、不动 `MultiChart`／`TVChart`、目录不持久化、不抄对方键值）；§6→Task 5/7；§7→Task 4；§8→Task 6/8；§9 风险表→Task 4 的注入面与 Task 7 Step 2 的层叠实测。
- 计划里**没有**「实现席要去别处才知道的值」：文案、属性名、key 联合、helper 形状全部就地给出。
- 已知三处「必须执行时定形」的东西已明写要现读：helper 组在本仓 jsdom／`act` 形状下是否逐字可用（Task 2 Step 7 的当场定形句）、八枚变异 needle 的逐字文本与缩进（Task 4 Step 1 括号）、矩阵两个新行号（Task 6 Step 1）。它们不是占位符，是「书面事实要真跑／当场读」那条纪律的正面处置。

## 追加更正（2026-10-18，Task 1 执行与评审带回）

1. **Task 1 Step 1 测试代码块的 import 那一行原本缺一枚类型**：正文用了 `Partial<PeriodPickerProps>` 而 import 只取了 `PeriodPicker, type PeriodOption`，`npx tsc -b` 在测试文件第 5 行报 `TS2304: Cannot find name 'PeriodPickerProps'`。已就地补 `type PeriodPickerProps`（上面代码块现为逐字定形）。这是「计划正文逐字照抄」这条纪律的第五型病灶之一：**代码块内部的自洽没人报警，只有编译器报**。
2. **Tech Stack 那句「React 18」是错的**，见该行的当场改口子句。连带一条本机事实：`node_modules` 相对 `package.json` 是陈旧的（装的是 react 19.2.8／vitest 4.1.11／vite 8.2.2，声明的是 ^19.3.0／^5.0.2／^8.3.1，三个都不落在声明区间内）。本片的 RED／GREEN／门禁一律在**装着的**这一套上跑，不许为对齐声明去装或升级东西（那是全局工具链面，范围外）；Task 5 报告要把这组版本读数带上，别让人以为读数来自 ^5 的 vitest。
3. **Task 4 的注入清单从八枚增到十枚**（M9 摘 `aria-controls`、M10 挪 `wrapRef`），来源是 Task 1 的评审席与收窄复评席各量出一处「摘掉生产代码而整套全绿」。M10 的形状与前九枚不同（一处变异要同时改两处），并且它暴露的是**本计划所有针只用 `fireEvent.click` 而不发 `mousedown`** 这一族盲区——真实浏览器的按下顺序是 mousedown→mouseup→click，浮层「点外面关掉」这类逻辑只有在针里发出 `mousedown` 才可能被钉住。Task 3 的页面级针若要读目录里的行，一律经 `openPeriodMenu()`／`pickPeriod()`，那两枚 helper 的定义里已经带了一次真实 `click`；**是否要在 helper 里补 `mouseDown`，由 Task 4 跑完 M10 之后当场定形并写进报告**，本席不在这里替它决定。
4. **Global Constraints 那句主机红线的转述**在派发词里被我写严成了「不许出现 `tradingview` 这个词」，评审席按门原文纠正，本席随后自己读了 `tools/forensics_audit.py:650`／`:652`：这把尺量的是 `tradingview.com` 子串（大小写不敏感）与 `s3.tradingview` 计数，配一份**双向集合等式**的白名单，而「TradingView」这个普通词在本仓 `frontend/src` 下本来就有既存命中（评审席当场数 53 个文件，本席未复核该数）。执行席按**门原文**执行，既存命中一枚也不许顺手清；把转述写严是我的派发缺陷，不是约束。

## 追加更正（2026-10-18，Task 4 复跑、Task 6 升态与计划外 6b 带回）

1. **档位键值禁令的适用范围要写清**（＝Global Constraints 第 **19** 行那条；本节不复写那个字面，needle 取法＝`sed -n '19p' docs/superpowers/plans/2026-10-18-l3-slice3-interval-popup.md` 里那对反引号之间的字面量）。澄清三句：
   - 实现面（`frontend/**`）与本片新增的一切用户可见文案一律用本仓中文 label（`日线` 等），**该侧计数为 0**。本席当场复量：`git grep -n "<那一枚键值>" -- frontend/` ＝ **0 命中**（rc=1，无输出行），`grep -rn "<那一枚键值>" frontend/src/` ＝ **0**。这一侧没有例外。
   - `docs/**` 里出现它只有两种合法身份：**禁令自身的举例**（本计划 :19 与本片 spec §5 排除项 :131 就属这一类），或对既有 L0 取证读数的**逐字转述**（spec §2 裁定三 :42 转述对方 a1 读到的可达名，属这一类）；且转述必须**紧邻**标明那是对方的读数、不是本仓的命名，缺这层标明就算违例。
   - 本条只划范围：**不改动任何既存命中，也不放松禁令**（阈值、白名单、两枚本机恒红门一律不碰）。本席在本节里一次也没有复写那个字面。
2. **Task 4 的 M9 注入 needle 字面在 `f1187a8b` 之后已不存在**：本计划 :632 那枚 `INJECTIONS` 元组写的是 `b'        aria-controls="pro-chart-period-menu"\n'`，:275 的 Task 1 目标代码块同样是无条件字面量；现树 `frontend/src/components/charts/PeriodPicker.tsx:65` 逐字已是 `aria-controls={open ? "pro-chart-period-menu" : undefined}`（本席 `sed -n '65p'` 开眼确认）。⇒ 原样复跑 M9 会 `NEEDLE-MISS`，不是假绿——:640 那句「八枚 needle 由执行席**按落地后文件里的逐字文本现读**再生成一遍」＋「注入前先断言 `BASE` 里那枚 needle 出现次数恰为 1」就是本条的既存出口，本席不新造规矩。判别力口径登记在此：**按内容重读 needle 后 M9 仍是 `RED`，它的红只由「名到名」那根针提供**＝`frontend/src/components/charts/__tests__/PeriodPicker.test.tsx:69-74`（逐字断言在 :73）；6b 新增的关态针（同文件 :77-84，断言在 :83）**不计入 M9 的判别力**——整枚摘掉 `aria-controls` 时关态本就是 `null`，那根针不红（本席按 6b 报告的逻辑复述，未跑注入，不作实测结论）。Task 8 若要引 M9 读数，得连这句一起带上。
3. **Task 6 Step 4 的前提与盘面不符**：:708 那一步假设「`periodActive(i.key) && "bg-muted font-medium",`」这句话还能在 `frontend/src/pages/ProChart.tsx` 里按内容现读出一个 `<现读号>`。本席实测：该串在当前 `frontend/src/pages/ProChart.tsx` 里 `grep -c -F` ＝ **0**（rc=1）。漂移链逐段亲验（每段都是当场 `git show` ＋ `grep -n -F`，不是算术）：`817d5627` 那版该句逐字在 **:2730**、`a5a8c252^`（第⑥片收口那一趟之前）那版在 **:2819**、`a5a8c252` 把八档平铺行换成 `PeriodPicker` 之后该句从 `ProChart.tsx` 消失（同一命令 ＝ 0）；等价句按内容重钉＝`frontend/src/components/charts/PeriodPicker.tsx:99`，逐字 `option.key === active && "bg-muted font-medium",`。⇒ 落地走的就是「**按内容重钉、旧号不平移**」，本条只登记「Step 4 写下的前提在现树已不成立」。另把**成因归因**改成实测口径：2730→2819 这一跳是**第⑥片对比那一整块改动**（对比输入框＋开关＋注释一起插进工具栏那一段）造成的 89 行位移，**不是**「一段注释插入」——:708 括号里那句「（第⑥片的对比按钮注释插入造成的漂移）」把成因写窄了，号与链都为真、归因失真，矩阵 :90 那格已同步改成实测口径。
4. **Task 6 Step 6 的命令形状要更正**：非法形状是 `git commit -s -- <path> -m "…"`——`--` 之后一律按 pathspec 解析，那枚 `-m` 连同它的值会被当成路径，命令在 git 里根本走不通；正确形式＝`git commit -s -m "…" -- <path>`。**简报指的位置与盘面对不上，照实登记**：本计划正文里现读**没有**那枚非法形状（`grep -n -- "git commit -s --"` 只命中 :17 那句 `git commit -s -- <files>`，那是合法的 pathspec 写法），而 :727 那一步实际写的是 `git commit -s -m "docs(forensics): L2 两格升态——…"`，它的缺陷是**没带 pathspec**、与全局约束 :17 冲突；`69db7316` 那席按约束方向把命令补成 `-- docs/forensics/gap-matrix.md` 才落对（Task 6 评审席 Step 6 那条已核到同一事实）。plan 文本不回改，两种形状都在此登记，往后一律写 `git commit -s -m "…" -- <path>`。
5. **本片插入了一笔计划外任务 6b**（`f1187a8b`＝`PeriodPicker.tsx:65` 的 `aria-controls` 改成条件式，外加组件级关态针 `PeriodPicker.test.tsx:77-84`）。起因＝Task 6 评审席 Minor 5：那枚无条件字面量在目录关着时指向不在 DOM 里的 `id`＝悬空 IDREF。裁定理由＝本片升的正是「入口按钮自陈弹层入口」的无障碍形状，明知悬空 IDREF 还把它留在生产面上不成立，而代价是一行条件式，不必为它重开一片。代价＝全量用例数从 **2411** 变 **2412**（本席当场复跑 `cd frontend && npx vitest run` ＝ `Test Files 144 passed (144)`／`Tests 2412 passed (2412)`，`Duration 133.67s`，rc=0；`2411` 是 `69db7316` 上 Task 5 台账的读数，本席未在那个 SHA 复跑）⇒ Task 5 那八道读数里只有「Step 2 全量用例数」这一枚受影响，其余七道本席没有重测、6b 那一笔（只动一枚组件与它的测试）也动不到它们；矩阵两格的第三列锚（`PeriodPicker.tsx:63` 的 `aria-haspopup="menu"`／`:90` 的 `aria-selected={option.key === active}`）逐字未动，该文件行数仍 **109**，刚升的两格没有被打回。
6. **上面追加更正第 3 则把 2730→2819 那 **89** 行归给「第⑥片对比那一整块改动」，本席 2026-10-18 修复轮裁定：为假。** 真账（本席逐枚 `git show "<rev>:frontend/src/pages/ProChart.tsx"` ＋ `grep -n -F 'periodActive(i.key) && "bg-muted font-medium"'` 现读该句行号）＝**L3 第②片** 三段插入＝`809ee079` **+10**／`6b6de129` **+65**／`af44fd00` **+14**（`2ef5f454` 移动 **0** 行），等式 **10＋65＋14＝89**；本席 `git log --oneline 817d5627..a5a8c252^ -- frontend/src/pages/ProChart.tsx` 现读恰四笔、日期全是 2026-10-17、提交标题全是第②片。第⑥片那一整块（对比输入框＋开关＋注释，`d8789334`，2026-10-10）造成的是更早的一段＝**2414→2610＝+196**（`d8789334^` 那版该句在 :2414、`d8789334` 那版在 :2610），且 `git merge-base --is-ancestor d8789334 817d5627` 本席现读 rc=0、`git show 817d5627:frontend/src/pages/ProChart.tsx` 第 **2641** 行逐字已是那段「对比（第⑥片）」注释的开头，⇒ 它早于 `817d5627`（2026-10-16，也就是在本仓矩阵写下 `:2730` 那枚号的那一笔 docs(forensics)）落地，不可能是那 89 行的来源。号与链（2730／2819／差 89，以及「等价句按内容重钉到 `PeriodPicker.tsx:99`」）一律为真，**只有成因换账**。矩阵 :90 那格已同步改口，句末带日子句。**上面第 3 则的文字一行不删**——它是 6c 当日写下的转述、不是盘面读数，而本文件的档案惯例是只追加，所以用本则推翻旧则，不回改旧则。
7. **`a5a8c252^` 在上面第 3 则里被括注成「（第⑥片收口那一趟之前）」——该括注反了**：`a5a8c252^`＝`ebf38d07`（本席 `git rev-parse a5a8c252^ ebf38d07` 现读两枚同一枚 SHA），那棵树里第⑥片（`d8789334`，2026-10-10）与 L3 第②片（`809ee079`／`6b6de129`／`2ef5f454`／`af44fd00`，2026-10-17）**都已落地**（本席逐枚 `git merge-base --is-ancestor <各枚> ebf38d07` 现读 rc=0，五枚全在祖先链上），正确说法＝「第⑥片与第②片都已落地、本支换组件之前」。旧括注文字不回改，靠本则改口——第 6 则与本则是同一枚漂移的两半：第 6 则改的是「谁把这 89 行推走的」，本则改的是「`a5a8c252^` 那棵树上已经有什么」。
8. **6b 那枚组件级关态针没进 spec §4 的针清单**：spec `docs/superpowers/specs/2026-10-18-l3-slice3-interval-popup-design.md` §4 现读 **11** 条（本席 `sed -n '100,123p' docs/superpowers/specs/2026-10-18-l3-slice3-interval-popup-design.md` 再数编号项 ＝ 11），而 `f1187a8b`（6b）新增的那枚组件级关态针 `frontend/src/components/charts/__tests__/PeriodPicker.test.tsx:77-84`（断言在 :83）不在那 11 条之内；spec 新增的 §10 第 1 则写了「§4 那批针的判别面没换」——**就「没换」为真、就「清单完整」为假**：那枚组件级测试文件现读 `it` **21** 枚（本席 `grep -c '  it(' frontend/src/components/charts/__tests__/PeriodPicker.test.tsx` ＝ 21），§4 只列了 11 条。登记口径＝spec §4 清单**不回改**，把 §4 那 11 条当全集往下数的第 **12** 枚组件级针在 §10 第 1 则里点名（那里已写着「关态不带该属性＝同文件 :77-84」）；plan 上面 :755 那句「§4 十一根针→Task 1 Step 1（组件级）＋Task 3（页面级）」的可追溯句同样**不回改**，靠本则限定。spec §10 的第 3 则按同一口径登记这枚不等（本轮紧接的 spec 面那一笔），两本文书不许各说一套。
