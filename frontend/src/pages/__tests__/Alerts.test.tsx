import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Alerts } from "@/pages/Alerts";
import { AlertApiError, alertsApi, type AlertRuleRow } from "@/lib/alertsApi";

// The page pulls pure helpers (validators, formatters) from the same module the
// transport lives in, so keep the real exports and swap only the client object.
vi.mock("@/lib/alertsApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/alertsApi")>();
  return {
    ...actual,
    alertsApi: {
      listRules: vi.fn(),
      listIncidents: vi.fn(),
      listTargets: vi.fn(),
      createRule: vi.fn(),
      updateRule: vi.fn(),
      deleteRule: vi.fn(),
      setEnabled: vi.fn(),
      resetRule: vi.fn(),
      dryRun: vi.fn(),
      testSend: vi.fn(),
      runNow: vi.fn(),
    },
  };
});

const mocked = alertsApi as unknown as Record<string, ReturnType<typeof vi.fn>>;

function rule(overrides: Partial<AlertRuleRow> = {}): AlertRuleRow {
  return {
    id: "moutai-breakout",
    kind: "market",
    title: "Moutai breaks 1700",
    symbol: "600519.SH",
    interval: "1D",
    count: 320,
    adjust: "qfq",
    condition: { op: "crossUp", lhs: "close", value: 1700 },
    for_bars: 1,
    realert_ms: 14_400_000,
    exponential_realert_ms: 86_400_000,
    severity: "warning",
    send_resolved: true,
    session_only: false,
    poll_interval_ms: 300_000,
    targets: ["research-group"],
    channel: null,
    target: null,
    enabled: true,
    state: "firing",
    pending_hits: 0,
    fired_count: 2,
    last_value: 1712.5,
    last_reason: "close crossed up 1700",
    last_error: null,
    last_checked_at: 1_790_000_000_000,
    last_notify_ms: 1_790_000_000_000,
    muted_until: 0,
    created_at: 1,
    updated_at: 2,
    webhook_configured: false,
    webhook_url: null,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.listRules.mockResolvedValue([]);
  mocked.listIncidents.mockResolvedValue([]);
  mocked.listTargets.mockResolvedValue({ targets: [], channels: [] });
});

describe("Alerts list", () => {
  it("shows what a rule watches, when it was last measured and where it pushes", async () => {
    mocked.listRules.mockResolvedValue([rule()]);
    render(<Alerts />);

    const row = await screen.findByRole("listitem");
    expect(within(row).getByText("Moutai breaks 1700")).toBeInTheDocument();
    expect(within(row).getByText("close ↑ 1700")).toBeInTheDocument();
    expect(within(row).getByText(/firing/i)).toBeInTheDocument();
    expect(within(row).getByText(/Last checked/)).toBeInTheDocument();
    expect(within(row).getByText(/pushes to research-group/)).toBeInTheDocument();
    // Every count-shaped line has to be interpolated, not printed as a template.
    expect(within(row).getByText(/fired 2 times/)).toBeInTheDocument();
    expect(within(row).getByText(/value 1712\.5/)).toBeInTheDocument();
  });

  it("says so when a rule records an episode it cannot push", async () => {
    mocked.listRules.mockResolvedValue([rule({ targets: [], title: "Silent sweep" })]);
    render(<Alerts />);

    const row = await screen.findByRole("listitem");
    expect(within(row).getByText("records without pushing")).toBeInTheDocument();
  });

  it("keeps a data-feed failure on the row that failed", async () => {
    mocked.listRules.mockResolvedValue([
      rule({ state: "error", last_error: "akshare returned no bars", title: "Noisy" }),
    ]);
    render(<Alerts />);

    const row = await screen.findByRole("listitem");
    expect(within(row).getByText("akshare returned no bars")).toBeInTheDocument();
    expect(within(row).getByText(/error/i)).toBeInTheDocument();
  });

  it("surfaces a failed list read instead of an empty list", async () => {
    mocked.listRules.mockRejectedValue(new AlertApiError("no such route", 404));
    render(<Alerts />);

    expect(await screen.findByRole("alert")).toHaveTextContent("no such route");
  });

  it("prints the history of a push that failed after retrying", async () => {
    mocked.listIncidents.mockResolvedValue([
      {
        id: "inc-1",
        rule_id: "moutai-breakout",
        rule_title: "Moutai breaks 1700",
        symbol: "600519.SH",
        kind: "market",
        state: "firing",
        severity: "warning",
        value: 1712.5,
        reason: "close crossed up 1700",
        at_ms: 1_790_000_000_000,
        delivery_status: "failed",
        delivery_error: "telegram timed out",
        delivery_attempts: 3,
        provider_message_id: null,
        delivery_updated_at: null,
      },
    ]);
    render(<Alerts />);

    const entry = await screen.findByText(/telegram timed out/);
    expect(entry).toHaveTextContent("3 attempts");
    // The episode is still on the timeline even though nobody received it.
    const row = screen.getByRole("listitem");
    expect(within(row).getByText("Moutai breaks 1700")).toBeInTheDocument();
    expect(within(row).getByText(/failed/i)).toBeInTheDocument();
  });
});

describe("Alerts composer", () => {
  it("creates a market rule with the condition the operator described", async () => {
    mocked.createRule.mockResolvedValue(rule());
    render(<Alerts />);
    await screen.findByText(/No alert rules yet/);

    fireEvent.change(screen.getByLabelText("Rule id"), { target: { value: "moutai-breakout" } });
    fireEvent.change(screen.getByLabelText("Symbol"), { target: { value: "600519.SH" } });
    fireEvent.change(screen.getByLabelText("Level"), { target: { value: "1700" } });
    fireEvent.submit(screen.getByRole("button", { name: /Save rule/ }));

    await waitFor(() =>
      expect(mocked.createRule).toHaveBeenCalledWith(
        expect.objectContaining({
          id: "moutai-breakout",
          symbol: "600519.SH",
          condition: { op: "crossUp", lhs: "close", rhs: null, value: 1700 },
          send_resolved: true,
        }),
      ),
    );
    expect(mocked.updateRule).not.toHaveBeenCalled();
    expect(await screen.findByText("Saved moutai-breakout")).toBeInTheDocument();
  });

  it("updates a rule that is already listed rather than re-creating it", async () => {
    mocked.listRules.mockResolvedValue([rule()]);
    mocked.updateRule.mockResolvedValue(rule({ title: "Renamed" }));
    render(<Alerts />);

    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    fireEvent.submit(screen.getByRole("button", { name: /Save rule/ }));

    await waitFor(() => expect(mocked.updateRule).toHaveBeenCalled());
    expect(mocked.updateRule.mock.calls[0][0]).toBe("moutai-breakout");
    expect(mocked.updateRule.mock.calls[0][1]).toMatchObject({ id: "moutai-breakout" });
    expect(mocked.createRule).not.toHaveBeenCalled();
  });

  it("refuses a rule id the routes could not address", async () => {
    render(<Alerts />);
    await screen.findByText(/No alert rules yet/);

    fireEvent.change(screen.getByLabelText("Rule id"), { target: { value: "has space" } });
    fireEvent.change(screen.getByLabelText("Symbol"), { target: { value: "600519.SH" } });
    fireEvent.change(screen.getByLabelText("Level"), { target: { value: "1700" } });
    fireEvent.submit(screen.getByRole("button", { name: /Save rule/ }));

    expect(await screen.findByText(/Use letters, digits/)).toBeInTheDocument();
    expect(mocked.createRule).not.toHaveBeenCalled();
  });

  it("asks for what a relational operator compares against", async () => {
    render(<Alerts />);
    await screen.findByText(/No alert rules yet/);

    fireEvent.change(screen.getByLabelText("Rule id"), { target: { value: "x" } });
    fireEvent.change(screen.getByLabelText("Symbol"), { target: { value: "600519.SH" } });
    fireEvent.submit(screen.getByRole("button", { name: /Save rule/ }));

    expect(await screen.findByText(/compares against a series or a fixed level/)).toBeInTheDocument();
    expect(mocked.createRule).not.toHaveBeenCalled();
  });

  it("hides the bar mechanics for a rule that is only fed by a webhook", async () => {
    render(<Alerts />);
    await screen.findByText(/No alert rules yet/);

    expect(screen.getByLabelText("Condition")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Watches"), { target: { value: "event" } });

    expect(screen.queryByLabelText("Condition")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Webhook secret")).toBeInTheDocument();
    // And the recovery promise, which an inbound event cannot keep, is dropped
    // rather than left as an error the operator cannot edit away.
    const recovery = screen.getByRole("checkbox", { name: /Announce the recovery/ });
    expect(recovery).toBeDisabled();
    expect(recovery).not.toBeChecked();
  });

  it("reveals a webhook URL exactly once, because the secret is only hashed after", async () => {
    mocked.createRule.mockResolvedValue(rule({ kind: "event", id: "tv-push", webhook_secret: "s3cret" }));
    render(<Alerts />);
    await screen.findByText(/No alert rules yet/);

    fireEvent.change(screen.getByLabelText("Rule id"), { target: { value: "tv-push" } });
    fireEvent.change(screen.getByLabelText("Watches"), { target: { value: "event" } });
    fireEvent.submit(screen.getByRole("button", { name: /Save rule/ }));

    const url = await screen.findByText(/\/alerts\/webhook\/tv-push\?key=s3cret$/);
    expect(screen.getByText("Webhook URL for tv-push")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText(/\/alerts\/webhook\/tv-push/)).not.toBeInTheDocument();
  });
});

describe("Alerts row actions", () => {
  it("pauses without deleting, and resumes from the same control", async () => {
    mocked.listRules.mockResolvedValue([rule()]);
    mocked.setEnabled.mockResolvedValue(rule({ enabled: false }));
    render(<Alerts />);

    fireEvent.click(await screen.findByRole("button", { name: /Pause alert rule/ }));

    await waitFor(() => expect(mocked.setEnabled).toHaveBeenCalledWith("moutai-breakout", false));
    expect(await screen.findByText("Paused moutai-breakout")).toBeInTheDocument();
  });

  it("deletes only after an explicit confirm click", async () => {
    mocked.listRules.mockResolvedValue([rule()]);
    mocked.deleteRule.mockResolvedValue({ status: "deleted", id: "moutai-breakout" });
    render(<Alerts />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete alert rule moutai-breakout" }));
    expect(mocked.deleteRule).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(mocked.deleteRule).toHaveBeenCalledWith("moutai-breakout"));
    expect(await screen.findByText("Deleted moutai-breakout. Its history stays.")).toBeInTheDocument();
  });

  it("shows what the engine sees when a condition is tested", async () => {
    mocked.listRules.mockResolvedValue([rule()]);
    mocked.dryRun.mockResolvedValue({
      status: "ok",
      rule_id: "moutai-breakout",
      hit: true,
      reason: "close crossed up 1700",
      note: "",
      error: null,
      value: 1712.5,
      bars: 120,
      positions: 0,
      market_open: true,
      would_notify: false,
      action: "suppressed",
      next_state: "firing",
    });
    render(<Alerts />);

    fireEvent.click(await screen.findByRole("button", { name: "Test condition" }));

    const line = await screen.findByText(/would notify no/);
    expect(line).toHaveTextContent("suppressed · would notify no · next state firing");
    expect(line.parentElement).toHaveTextContent("120 bars · 0 positions · market open");
  });

  it("reports a refused test push instead of a sent one", async () => {
    mocked.listRules.mockResolvedValue([rule()]);
    mocked.testSend.mockRejectedValue(new AlertApiError("channel 'slack' is not enabled", 409));
    render(<Alerts />);

    fireEvent.click(await screen.findByRole("button", { name: "Send test" }));

    expect(await screen.findByText("channel 'slack' is not enabled")).toBeInTheDocument();
    expect(screen.queryByText(/Test push sent/)).not.toBeInTheDocument();
  });

  it("does not claim a push was sent when the rule has nowhere to go", async () => {
    // The route answers 200 for sent / failed / no_target alike, so the banner
    // has to be written from the body.
    mocked.listRules.mockResolvedValue([rule()]);
    mocked.testSend.mockResolvedValue({
      status: "no_target",
      addresses: 0,
      error: "no delivery target configured",
    });
    render(<Alerts />);

    fireEvent.click(await screen.findByRole("button", { name: "Send test" }));

    expect(await screen.findByText("Nothing arrived: no delivery target configured")).toBeInTheDocument();
    expect(screen.queryByText(/Test push sent/)).not.toBeInTheDocument();
  });

  it("counts the addresses a successful test push reached", async () => {
    mocked.listRules.mockResolvedValue([rule()]);
    mocked.testSend.mockResolvedValue({
      status: "sent",
      addresses: 2,
      provider_message_id: "slack:7",
    });
    render(<Alerts />);

    fireEvent.click(await screen.findByRole("button", { name: "Send test" }));

    expect(await screen.findByText("Test push sent for moutai-breakout · 2 addresses")).toBeInTheDocument();
  });
});

describe("Alerts evaluation", () => {
  it("counts an evaluation that pushed, suppressed and skipped", async () => {
    mocked.runNow.mockResolvedValue({
      status: "ok",
      evaluated: 4,
      fired: 1,
      resolved: 0,
      suppressed: 1,
      errors: 0,
      skipped: 2,
      delivered: 1,
      incidents: ["inc-1"],
    });
    render(<Alerts />);

    fireEvent.click(await screen.findByRole("button", { name: /Evaluate now/ }));

    expect(
      await screen.findByText(
        "Measured 4 · fired 1 · resolved 0 · pushed 1 · errors 0 · skipped 2",
      ),
    ).toBeInTheDocument();
    // Measuring is not the same as notifying: the plain button must not push.
    expect(mocked.runNow).toHaveBeenCalledWith({ deliver: false });
  });

  it("keeps a stale poll from undoing a fresher one", async () => {
    const polls: Array<ReturnType<typeof deferred<AlertRuleRow[]>>> = [];
    mocked.listRules.mockImplementation(() => {
      const gate = deferred<AlertRuleRow[]>();
      polls.push(gate);
      return gate.promise;
    });
    mocked.runNow.mockResolvedValue({
      status: "ok",
      evaluated: 0,
      fired: 0,
      resolved: 0,
      suppressed: 0,
      errors: 0,
      skipped: 0,
      delivered: 0,
      incidents: [],
    });
    render(<Alerts />);

    await waitFor(() => expect(polls).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: /Evaluate now/ }));
    await waitFor(() => expect(polls).toHaveLength(2));

    polls[1].resolve([rule({ id: "fresh", title: "Fresh A" }), rule({ id: "newer", title: "Fresh B" })]);
    await screen.findByText("Fresh B");
    polls[0].resolve([rule({ id: "old", title: "Stale A" })]);

    await waitFor(() => expect(mocked.listRules).toHaveBeenCalledTimes(2));
    expect(screen.getByText("Fresh B")).toBeInTheDocument();
    expect(screen.queryByText("Stale A")).not.toBeInTheDocument();
  });

  it("never renders a placeholder for a value that had no translation", async () => {
    mocked.listRules.mockResolvedValue([rule({ muted_until: 1_790_000_000_000 })]);
    mocked.dryRun.mockResolvedValue({
      status: "ok",
      rule_id: "moutai-breakout",
      hit: false,
      reason: "close 1680 below 1700",
      note: "",
      error: null,
      value: 1680,
      bars: 120,
      positions: 0,
      market_open: false,
      would_notify: true,
      action: "noop",
      next_state: "inactive",
    });
    mocked.runNow.mockResolvedValue({
      status: "ok",
      evaluated: 1,
      fired: 0,
      resolved: 0,
      suppressed: 0,
      errors: 0,
      skipped: 0,
      delivered: 0,
      incidents: [],
    });
    render(<Alerts />);

    fireEvent.click(await screen.findByRole("button", { name: "Test condition" }));
    await screen.findByText(/next state inactive/);
    fireEvent.click(screen.getByRole("button", { name: /Evaluate now/ }));
    await screen.findByText(/Measured 1/);

    expect(document.body.textContent).not.toContain("{{");
    expect(document.body.textContent).toMatch(/quiet until \S/);
  });
});
