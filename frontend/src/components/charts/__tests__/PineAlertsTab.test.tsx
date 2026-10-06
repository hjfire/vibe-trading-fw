import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { KLineData } from "klinecharts";

// The tab only reads bars off the chart; the real library stays unimported.
vi.mock("klinecharts", () => ({ registerIndicator: vi.fn() }));

import AlertsTab from "../workbench/AlertsTab";
import { EMPTY_DRAFT } from "../workbench/types";
import { alertsApi, type AlertCondition, type AlertRuleRow } from "@/lib/alertsApi";

/**
 * The 脚本告警 tab (local custom ⑪, Pine alert bridge): what the translator
 * decided and what the interpreter computed must both be on screen before a
 * click writes a rule, and a click must never overwrite a hand-edited rule
 * without asking.
 */

const BARS = Array.from({ length: 300 }, (_, i) => {
  const close = 100 + 6 * Math.sin(i / 3) + i * 0.05;
  return {
    timestamp: 1700000000000 + i * 86400000,
    open: close,
    high: close + 1,
    low: close - 1,
    close,
    volume: 1000 + i,
  } as KLineData;
});

const getChart = () => ({ getDataList: () => BARS }) as never;

const NATIVE =
  '//@version=5\nindicator("t")\nalertcondition(ta.crossover(ta.ema(close,5), ta.ema(close,20)), "EMA金叉", "")';
const REFUSED = '//@version=5\nindicator("t")\nalertcondition(close >= 1700, "越界", "")';
const BROKEN = '//@version=5\nindicator("t")\nalertcondition(ta.crossover(, ), "坏脚本", "")';

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

function renderTab(code: string, interval: "1D" | "1W" = "1D") {
  return render(
    <AlertsTab
      draft={{ ...EMPTY_DRAFT, code }}
      getChart={getChart}
      symbol="600519.SH"
      interval={interval}
      adjust="qfq"
    />,
  );
}

function emptyTargets() {
  vi.spyOn(alertsApi, "listTargets").mockResolvedValue({ targets: [], channels: [] });
}

function ruleRow(
  id: string,
  condition: Partial<AlertCondition> | null | undefined,
  over: Partial<AlertRuleRow> = {},
): AlertRuleRow {
  // The settings fields default to the panel's own defaults, so a row with the
  // same condition really is "已建，条件一致" — a test that wants a divergence
  // passes `over`.
  return {
    id,
    title: "手改过的",
    symbol: "600519.SH",
    interval: "1D",
    condition,
    for_bars: 1,
    severity: "info",
    send_resolved: true,
    targets: [],
    ...over,
  } as unknown as AlertRuleRow;
}

it("可译条目显示后端条件文案与引擎命中根号，并有创建按钮", async () => {
  emptyTargets();
  vi.spyOn(alertsApi, "listRules").mockResolvedValue([]);
  renderTab(NATIVE);
  await waitFor(() => expect(screen.getByText("EMA金叉")).toBeInTheDocument(), { timeout: 3000 });
  // describeCondition is symbol-based, exactly as the pushed message reads it.
  expect(screen.getByText("ema:5 ↑ ema:20")).toBeInTheDocument();
  expect(screen.getByText(/引擎命中/)).toBeInTheDocument();
  expect(screen.getByText(/共 \d+ 根/)).toBeInTheDocument();
  expect(screen.getByRole("button", { name: /创建/ })).toBeEnabled();
});

it("不可译条目没有创建按钮，reason 原文可见", async () => {
  emptyTargets();
  vi.spyOn(alertsApi, "listRules").mockResolvedValue([]);
  renderTab(REFUSED);
  await waitFor(() => expect(screen.getByText("越界")).toBeInTheDocument(), { timeout: 3000 });
  expect(screen.getByText(/>=/)).toBeInTheDocument();
  expect(screen.queryByRole("button", { name: /创建|更新/ })).toBeNull();
});

it("解析失败的条目单独成行， reason 带着解析报错", async () => {
  emptyTargets();
  vi.spyOn(alertsApi, "listRules").mockResolvedValue([]);
  renderTab(BROKEN);
  await waitFor(() => expect(screen.getByText(/语法解析失败/)).toBeInTheDocument(), { timeout: 3000 });
  expect(screen.queryByRole("button", { name: /创建|更新/ })).toBeNull();
});

it("创建走 alertsApi.createRule，draft 带 symbol/interval/condition 与确定性 id", async () => {
  const create = vi
    .spyOn(alertsApi, "createRule")
    .mockResolvedValue({ id: "pine_x", condition: { op: "crossUp" } } as never);
  emptyTargets();
  vi.spyOn(alertsApi, "listRules").mockResolvedValue([]);
  renderTab(NATIVE);
  await waitFor(() => expect(screen.getByText("EMA金叉")).toBeInTheDocument(), { timeout: 3000 });
  fireEvent.change(screen.getByLabelText("连续满足根数"), { target: { value: "3" } });
  fireEvent.change(screen.getByLabelText("级别"), { target: { value: "warning" } });
  fireEvent.click(screen.getByRole("button", { name: /创建/ }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  const draft = create.mock.calls[0][0];
  expect(draft).toMatchObject({
    symbol: "600519.SH",
    interval: "1D",
    kind: "market",
    adjust: "qfq",
    for_bars: 3,
    severity: "warning",
  });
  expect(draft.id).toMatch(/^pine_/);
  expect(draft.condition).toMatchObject({ op: "crossUp", lhs: "ema:5", rhs: "ema:20" });
});

it("周月线周期不给创建按钮（后端没有这两个周期）", async () => {
  emptyTargets();
  vi.spyOn(alertsApi, "listRules").mockResolvedValue([]);
  renderTab(NATIVE, "1W");
  await waitFor(() => expect(screen.getByText("EMA金叉")).toBeInTheDocument(), { timeout: 3000 });
  expect(screen.queryByRole("button", { name: /创建|更新/ })).toBeNull();
  expect(screen.getByText(/1W/)).toBeInTheDocument();
});

it("已有同 id 规则且条件被手改过 ⇒ 先确认再覆盖，不静默吃掉", async () => {
  emptyTargets();
  const create = vi.spyOn(alertsApi, "createRule").mockResolvedValue({ id: "pine_x" } as never);
  const list = vi.spyOn(alertsApi, "listRules").mockResolvedValue([]);

  const first = renderTab(NATIVE);
  fireEvent.click(await screen.findByRole("button", { name: /创建/ }, { timeout: 3000 }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  // The id is the shape's whole point: same script, same symbol, same line.
  const id = create.mock.calls[0][0].id;
  expect(id).toMatch(/^pine_/);

  create.mockClear();
  list.mockResolvedValue([ruleRow(id, { op: "crossDown", lhs: "ema:5", rhs: "ema:20" })]);
  first.unmount();
  renderTab(NATIVE);

  fireEvent.click(await screen.findByRole("button", { name: /更新/ }, { timeout: 3000 }));
  // A rule the script still describes is live, not an orphan to clean up.
  expect(screen.queryByRole("button", { name: /删除/ })).toBeNull();
  expect(create).not.toHaveBeenCalled();
  expect(screen.getByText(/ema:5 ↓ ema:20/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /确认覆盖/ }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  expect(create.mock.calls[0][0].id).toBe(id);
});

it("目标为空时警告只记录不通知；本脚本已删除的 pine 规则可删", async () => {
  emptyTargets();
  const del = vi.spyOn(alertsApi, "deleteRule").mockResolvedValue({ status: "ok", id: "pine_gone" } as never);
  vi.spyOn(alertsApi, "listRules").mockResolvedValue([
    ruleRow("pine_deadbeef_L9", { op: "gt", lhs: "close", value: 1 }),
  ]);
  renderTab(NATIVE);
  await waitFor(() => expect(screen.getByText("EMA金叉")).toBeInTheDocument(), { timeout: 3000 });
  expect(screen.getByText(/未选择推送目标/)).toBeInTheDocument();
  expect(screen.getByRole("link", { name: /告警页/ })).toHaveAttribute("href", "/alerts");

  const row = screen.getByText("pine_deadbeef_L9");
  expect(row).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /删除/ }));
  await waitFor(() => expect(del).toHaveBeenCalledWith("pine_deadbeef_L9"));
});

it("有推送目标时勾选进 draft.targets，并显示已注册的名称", async () => {
  vi.spyOn(alertsApi, "listTargets").mockResolvedValue({
    targets: [
      { ref: "-100123", label: "研究群", channel: "napcat" },
      { ref: "-999", label: "运维群", channel: "napcat" },
    ],
    channels: ["napcat"],
  });
  const create = vi.spyOn(alertsApi, "createRule").mockResolvedValue({ id: "pine_x" } as never);
  vi.spyOn(alertsApi, "listRules").mockResolvedValue([]);
  renderTab(NATIVE);
  await waitFor(() => expect(screen.getByText("EMA金叉")).toBeInTheDocument(), { timeout: 3000 });
  const box = screen.getByLabelText("研究群 · napcat");
  fireEvent.click(box);
  expect(screen.queryByText(/未选择推送目标/)).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /创建/ }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  expect(create.mock.calls[0][0].targets).toEqual(["-100123"]);
});

it("条件一致但这里的参数不同 ⇒ 露出更新与差在哪，而不是「已建，条件一致」", async () => {
  emptyTargets();
  const create = vi.spyOn(alertsApi, "createRule").mockResolvedValue({ id: "pine_x" } as never);
  const list = vi.spyOn(alertsApi, "listRules").mockResolvedValue([]);

  const first = renderTab(NATIVE);
  fireEvent.click(await screen.findByRole("button", { name: /创建/ }, { timeout: 3000 }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  const id = create.mock.calls[0][0].id;
  const cond = create.mock.calls[0][0].condition;

  create.mockClear();
  // Same id and the same condition; only the stored debounce is the old number.
  list.mockResolvedValue([ruleRow(id, cond, { for_bars: 1 })]);
  first.unmount();
  renderTab(NATIVE);
  fireEvent.change(screen.getByLabelText("连续满足根数"), { target: { value: "4" } });

  expect(screen.queryByRole("button", { name: /已建/ })).toBeNull();
  fireEvent.click(await screen.findByRole("button", { name: /更新/ }, { timeout: 3000 }));
  expect(screen.getByText(/连续满足根数：后端 1 → 这里 4/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: /确认覆盖/ }));
  await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  expect(create.mock.calls[0][0]).toMatchObject({ id, for_bars: 4 });
});
