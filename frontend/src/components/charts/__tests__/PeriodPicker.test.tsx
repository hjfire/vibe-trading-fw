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

/** 两根针要 RTL 的 `unmount`（一根卸载整个开着的目录，一根在两次渲染之间清场），
 *  而 `renderPicker` 只回 onPick，所以这里把 render 的返回值原样交出去。 */
const renderPickerHost = (props: Partial<PeriodPickerProps> = {}) =>
  render(
    <PeriodPicker
      options={OPTIONS}
      triggerLabel="日线"
      active="1D"
      onPick={vi.fn()}
      {...props}
    />,
  );

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

  it("入口的 aria-controls 逐字等于打开后目录元素的 id", () => {
    renderPicker();
    fireEvent.click(trigger());
    const menu = screen.getByRole("listbox");
    expect(trigger().getAttribute("aria-controls")).toBe(menu.id);
    expect(document.getElementById(menu.id)).toBe(menu);
  });

  it("组件级：目录关着时入口按钮根本不带 aria-controls（不留悬空 IDREF）", () => {
    // 浮层只在 open 为真时进 DOM，那枚 id 也跟着才存在。
    // 入口若恒写 aria-controls，关着的时候就指向文档里不存在元素＝悬空 IDREF。
    // 层级限定：这根钉的是 PeriodPicker 自己渲染的那一枚入口，不主张页面级唯一。
    renderPicker();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger().getAttribute("aria-controls")).toBeNull();
  });

  it("有档位时入口 title 逐字是「周期目录：当前 日线（点开换档）」", () => {
    renderPicker();
    expect(trigger().getAttribute("title")).toBe("周期目录：当前 日线（点开换档）");
  });

  it("分时态（active=null）入口 title 逐字交代画的是分时、档位仍是日线", () => {
    renderPicker({ active: null });
    expect(trigger().getAttribute("title")).toBe(
      "周期目录：当前线上画的是分时，档位仍是 日线（点开换档）",
    );
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

  it("按下顺序 mousedown→click 开目录，入口上的 mousedown 不会关掉它", () => {
    renderPicker();
    // 真实浏览器点一下按钮是 mousedown→mouseup→click；只测 click 就测不到 wrapRef
    // 的包住范围——ref 一旦不再包住入口，目录会被自家 mousedown 当场关掉。
    fireEvent.mouseDown(trigger());
    fireEvent.click(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByRole("listbox")).toBeTruthy();
    fireEvent.mouseDown(trigger());
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(screen.queryByRole("listbox")).toBeTruthy();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
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

  it("行上的 mousedown 不算组件外：目录不关、换档恰一次", () => {
    // M10 的形状：容器 ref 一旦不包住目录行，行上的 mousedown 会被判成「组件外」，
    // 目录先卸载、随后 click 打在脱离文档的行上，onPick 一次都不发。
    // 所有既有针只发 click，看不见这个顺序，所以这里按下顺序走满并钉住恰一次。
    const onPick = renderPicker();
    fireEvent.mouseDown(trigger());
    fireEvent.click(trigger());
    const row = screen.getByRole("option", { name: "周线" });
    fireEvent.mouseDown(row);
    expect(screen.queryByRole("listbox")).toBeTruthy();
    fireEvent.click(row);
    expect(onPick).toHaveBeenCalledTimes(1);
    expect(onPick).toHaveBeenCalledWith("1W");
  });

  it("目录打开时选中行仍带 bg-muted font-medium 这个视觉标记", () => {
    renderPicker();
    fireEvent.click(trigger());
    const row = within(screen.getByRole("listbox")).getByRole("option", { name: "日线" });
    expect(row.className).toContain("bg-muted font-medium");
  });
});

describe("PeriodPicker 入口自身的亮起与监听撤销", () => {
  it("入口按钮只在 active 非 null 时亮起 bg-muted font-medium", () => {
    const { unmount } = renderPickerHost();
    expect(trigger().className).toContain("bg-muted font-medium");
    unmount();
    renderPickerHost({ active: null });
    expect(trigger().className).not.toContain("bg-muted font-medium");
  });

  it("目录开着时卸载会摘掉 mousedown 与 keydown 两枚 document 监听", () => {
    const removeEventListener = vi.spyOn(document, "removeEventListener");
    const { unmount } = renderPickerHost();
    fireEvent.click(trigger());
    expect(screen.getByRole("listbox")).toBeTruthy();
    unmount();
    expect(removeEventListener).toHaveBeenCalledWith("mousedown", expect.any(Function));
    expect(removeEventListener).toHaveBeenCalledWith("keydown", expect.any(Function));
  });
});
