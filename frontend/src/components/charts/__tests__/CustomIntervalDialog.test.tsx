import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { CUSTOM_UNITS, validateDraft } from "@/lib/customInterval";

import { CustomIntervalDialog, type CustomIntervalDialogProps } from "../CustomIntervalDialog";

/** 目录里那八档内置串的拼写——对话框的 `existing` 就是「内置八档 ∪ 已添加的自定义档」，
 *  所以针面从这里起手，重复档那一枚再往前面加一条自定义串。 */
const BUILTIN_DIRECTORY = ["1m", "5m", "15m", "30m", "60m", "1D", "1W", "1M"];

const renderDialog = (props: Partial<CustomIntervalDialogProps> = {}) => {
  const onCancel = vi.fn();
  const onAdd = vi.fn();
  render(<CustomIntervalDialog existing={BUILTIN_DIRECTORY} onCancel={onCancel} onAdd={onAdd} {...props} />);
  return { onCancel, onAdd };
};
const typeButton = () => screen.getByRole("button", { name: "分钟" });
const addButton = () => screen.getByRole("button", { name: "加入" }) as HTMLButtonElement;
const numberInput = () => screen.getByRole("spinbutton") as HTMLInputElement;
/**
 * 选单位＝点开弹层再点那一行；弹层选完自动收起（与周期目录同一姿势），所以每次都能点开。
 * 入口按钮的可达名就是当前单位，换过一次之后它不再叫「分钟」，所以调用方要说清
 * 「从哪一档点进去」——这也是用户视角下唯一可靠的定位方式。
 */
const pickUnit = (fromLabel: string, toLabel: string) => {
  fireEvent.click(screen.getByRole("button", { name: fromLabel }));
  fireEvent.click(within(screen.getByRole("listbox")).getByRole("option", { name: toLabel }));
};
const typeNumber = (text: string) => fireEvent.change(numberInput(), { target: { value: text } });

describe("CustomIntervalDialog 的骨架（C-1／C-2／C-3）", () => {
  it("C-1：对话框恰一枚", () => {
    renderDialog();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });

  it("C-2：关闭／单位按钮／数值框／取消／加入五件各在位，且「关闭」只有一枚", () => {
    renderDialog();
    expect(screen.getByRole("button", { name: "关闭" })).toBeTruthy();
    expect(typeButton()).toBeTruthy();
    expect(numberInput()).toBeTruthy();
    expect(screen.getByRole("button", { name: "取消" })).toBeTruthy();
    expect(addButton()).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "关闭" })).toHaveLength(1);
  });

  it("C-3：对话框与宿主目录共存，组件不摘目录", () => {
    // 对面那侧的读数里 dialog 与目录同层共存；我们这侧的结构性承诺是「挂载对话框
    // 不许动目录节点」。宿主用一枚带 testid 的空 div 当目录，断它还在 document 里。
    render(
      <>
        <div data-testid="directory" />
        <CustomIntervalDialog
          existing={BUILTIN_DIRECTORY}
          onCancel={vi.fn()}
          onAdd={vi.fn()}
        />
      </>,
    );
    expect(document.querySelector('[data-testid="directory"]')).not.toBeNull();
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
  });
});

describe("CustomIntervalDialog 的单位弹层（C-4／C-7）", () => {
  it("C-4：关态无 listbox 且 aria-expanded=false；开态 listbox 恰一枚、五枚 option、选中恰一枚", () => {
    renderDialog();
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(typeButton().getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(typeButton());
    const listbox = screen.getByRole("listbox");
    expect(screen.getAllByRole("listbox")).toHaveLength(1);
    const options = within(listbox).getAllByRole("option");
    expect(options).toHaveLength(5);
    expect(options.filter((option) => option.getAttribute("aria-selected") === "true")).toHaveLength(1);
    expect(typeButton().getAttribute("aria-expanded")).toBe("true");
  });

  it("C-7：单位按钮的可达名里单位标签只出现一次（关态与开态都是）", () => {
    // 展开态那枚按钮若把「当前值」和「标签」各念一遍，可达名就成了两倍的同一段文字——
    // 这是对面那侧实测到的反模式，本仓故意不复刻，所以这里正面断言它不成立。
    renderDialog();
    expect(typeButton().textContent).toBe("分钟");
    expect(screen.queryByRole("button", { name: "分钟 分钟" })).toBeNull();
    fireEvent.click(typeButton());
    expect(typeButton().textContent).toBe("分钟");
    expect(screen.queryByRole("button", { name: "分钟 分钟" })).toBeNull();
  });
});

describe("CustomIntervalDialog 的加入判据（C-5／C-8／C-9／重复档）", () => {
  it("C-5：空输入 disabled，填 2 变 enabled，点加入发出 2m", () => {
    const { onAdd } = renderDialog();
    expect(addButton().disabled).toBe(true);
    typeNumber("2");
    expect(addButton().disabled).toBe(false);
    fireEvent.click(addButton());
    expect(onAdd).toHaveBeenCalledWith("2m");
  });

  it("C-8：边界按单位走——小时 25 越界给可见原因，换回分钟同样的 25 就能加", () => {
    renderDialog();
    pickUnit("分钟", "小时");
    typeNumber("25");
    expect(addButton().disabled).toBe(true);
    expect(screen.getByText(/一天/)).toBeTruthy();
    pickUnit("小时", "分钟");
    expect(addButton().disabled).toBe(false);
    expect(screen.queryByText(/一天/)).toBeNull();
  });

  it("C-9：单位与数值合成 market 拼写——日 × 2 发出 2D", () => {
    const { onAdd } = renderDialog();
    typeNumber("2");
    pickUnit("分钟", "日");
    fireEvent.click(addButton());
    expect(onAdd).toHaveBeenCalledWith("2D");
  });

  it("重复档：existing 里已经有这条串时加入 disabled，且给可见原因", () => {
    renderDialog({ existing: ["2D", ...BUILTIN_DIRECTORY] });
    typeNumber("2");
    pickUnit("分钟", "日");
    expect(addButton().disabled).toBe(true);
    expect(screen.getByText(/已添加的自定义档/)).toBeTruthy();
  });

  it("数值框的上界与 validateDraft 那把跨度尺同界（`unitLimits` 改了或组件自己漂，这枚先红）", () => {
    // 上界现在由 `customInterval.ts` 的 `unitLimits` 端出来，组件不留字面量；提示值本身
    // 不是判据（判据是加入按钮那把尺）。这枚针钉的是**跨源**同界：组件送进 DOM 的那枚
    // `input.max` 与 `validateDraft` 这把尺必须同界，所以逐单位判两侧——`max` 本身在界内、
    // `max + 1` 被拒。改了尺没改 `unitLimits`（或反过来）时，这两枚里必有一枚红。
    renderDialog();
    let previousLabel = "分钟";
    for (const { unit, label } of CUSTOM_UNITS) {
      pickUnit(previousLabel, label);
      previousLabel = label;
      const input = numberInput();
      expect(input.min).toBe("1");
      const max = Number(input.max);
      expect(Number.isInteger(max) && max > 0, `${label}：max 得是个具体的数`).toBe(true);
      expect(validateDraft({ unit, n: max }).ok, `${label}：max=${max} 应当在界内`).toBe(true);
      expect(validateDraft({ unit, n: max + 1 }).ok, `${label}：max+1=${max + 1} 应当越界`).toBe(false);
    }
  });
});

describe("CustomIntervalDialog 的关闭通道（C-6）", () => {
  it("C-6：Escape 回调取消恰一次", () => {
    const { onCancel } = renderDialog();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
