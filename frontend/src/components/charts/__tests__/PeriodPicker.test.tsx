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
