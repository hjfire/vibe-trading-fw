import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ReplayBar } from "../ReplayBar";

const idle = {
  active: false,
  disabled: false,
  reason: null,
  playing: false,
  speed: "1" as const,
  readout: null,
  cursorLabel: null,
};

describe("ReplayBar", () => {
  it("非回放态只有一个「回放」入口，没有步进/播放按钮", () => {
    render(<ReplayBar {...idle} onStart={vi.fn()} onStop={vi.fn()} onStep={vi.fn()} onTogglePlay={vi.fn()} onSpeed={vi.fn()} onPickDate={vi.fn()} />);
    expect(screen.getByRole("button", { name: "回放" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "播放" })).toBeNull();
    expect(screen.queryByRole("button", { name: "退出回放" })).toBeNull();
  });

  it("disabled 时原因进 title，且点击不回调", () => {
    const onStart = vi.fn();
    render(<ReplayBar {...idle} disabled reason="分时只有一节 session，没有可回放的历史" onStart={onStart} onStop={vi.fn()} onStep={vi.fn()} onTogglePlay={vi.fn()} onSpeed={vi.fn()} onPickDate={vi.fn()} />);
    const btn = screen.getByRole("button", { name: "回放" });
    expect(btn.getAttribute("title")).toContain("分时");
    fireEvent.click(btn);
    expect(onStart).not.toHaveBeenCalled();
  });

  it("回放态露读数、步进、播放与退出，读数写的是「第 k/N 根 · 剩 M 根」", () => {
    render(
      <ReplayBar
        active
        disabled={false}
        reason={null}
        playing={false}
        speed="2"
        readout={{ shown: 251, total: 501, remaining: 250, index: 250 }}
        cursorLabel="2025-09-30"
        onStart={vi.fn()}
        onStop={vi.fn()}
        onStep={vi.fn()}
        onTogglePlay={vi.fn()}
        onSpeed={vi.fn()}
        onPickDate={vi.fn()}
      />,
    );
    expect(screen.getByText(/2025-09-30/)).toBeTruthy();
    expect(screen.getByText(/第 251\/501 根/)).toBeTruthy();
    expect(screen.getByText(/剩 250 根/)).toBeTruthy();
    // `ProChartReplay.test.tsx` reads the cursor day back out of this node, so the readout has
    // to be reachable by test id and carry the date in its own text.
    expect(screen.getByTestId("replay-readout").textContent).toContain("2025-09-30");
    expect(screen.getByRole("button", { name: "退出回放" })).toBeTruthy();
  });

  it("单步按钮各推一根、快退十根", () => {
    const onStep = vi.fn();
    render(<ReplayBar {...idle} active readout={{ shown: 3, total: 9, remaining: 6, index: 2 }} onStop={vi.fn()} onStart={vi.fn()} onStep={onStep} onTogglePlay={vi.fn()} onSpeed={vi.fn()} onPickDate={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "后一根" }));
    fireEvent.click(screen.getByRole("button", { name: "前一根" }));
    fireEvent.click(screen.getByRole("button", { name: "快退 10 根" }));
    expect(onStep.mock.calls.map((c) => c[0])).toEqual([1, -1, -10]);
  });

  it("播放中按钮文字变「暂停」，再点回「播放」", () => {
    const onTogglePlay = vi.fn();
    const { rerender } = render(<ReplayBar {...idle} active onStop={vi.fn()} onStart={vi.fn()} onStep={vi.fn()} onTogglePlay={onTogglePlay} onSpeed={vi.fn()} onPickDate={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "播放" }));
    expect(onTogglePlay).toHaveBeenCalledTimes(1);
    rerender(<ReplayBar {...idle} active playing onStop={vi.fn()} onStart={vi.fn()} onStep={vi.fn()} onTogglePlay={onTogglePlay} onSpeed={vi.fn()} onPickDate={vi.fn()} />);
    expect(screen.getByRole("button", { name: "暂停" })).toBeTruthy();
  });

  it("到达末根时播放按钮 disabled，退出仍可用", () => {
    const onStop = vi.fn();
    render(
      <ReplayBar
        active
        disabled={false}
        reason={null}
        playing={false}
        speed="1"
        readout={{ shown: 9, total: 9, remaining: 0, index: 8 }}
        cursorLabel="2026-10-06"
        onStart={vi.fn()}
        onStop={onStop}
        onStep={vi.fn()}
        onTogglePlay={vi.fn()}
        onSpeed={vi.fn()}
        onPickDate={vi.fn()}
      />,
    );
    expect(screen.getByRole("button", { name: "播放" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "退出回放" }));
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("日期输入提交 ISO 串，空值不回调", () => {
    const onPickDate = vi.fn();
    render(<ReplayBar {...idle} active onStop={vi.fn()} onStart={vi.fn()} onStep={vi.fn()} onTogglePlay={vi.fn()} onSpeed={vi.fn()} onPickDate={onPickDate} />);
    const box = screen.getByLabelText("回放起点日期");
    fireEvent.change(box, { target: { value: "2025-01-08" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onPickDate).toHaveBeenCalledWith("2025-01-08");
    fireEvent.change(box, { target: { value: "" } });
    fireEvent.keyDown(box, { key: "Enter" });
    expect(onPickDate).toHaveBeenCalledTimes(1);
  });

  it("倍速四档都在，切换回调带档位", () => {
    const onSpeed = vi.fn();
    render(<ReplayBar {...idle} active onStop={vi.fn()} onStart={vi.fn()} onStep={vi.fn()} onTogglePlay={vi.fn()} onSpeed={onSpeed} onPickDate={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "4×" }));
    expect(onSpeed).toHaveBeenCalledWith("4");
  });

  it("起点两个入口：默认回退与从视图右端", () => {
    const onStart = vi.fn();
    render(<ReplayBar {...idle} onStart={onStart} onStop={vi.fn()} onStep={vi.fn()} onTogglePlay={vi.fn()} onSpeed={vi.fn()} onPickDate={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: "回放" }));
    expect(onStart).toHaveBeenCalledWith("default");
    render(<ReplayBar {...idle} active={false} disabled={false} reason={null} playing={false} speed="1" readout={null} cursorLabel={null} onStart={onStart} onStop={vi.fn()} onStep={vi.fn()} onTogglePlay={vi.fn()} onSpeed={vi.fn()} onPickDate={vi.fn()} />);
    fireEvent.click(screen.getAllByRole("button", { name: "从视图右端开始" }).at(-1)!);
    expect(onStart).toHaveBeenLastCalledWith("viewEdge");
  });
});
