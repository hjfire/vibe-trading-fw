import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AlertApiError,
  EMPTY_ALERT_RULE_FORM,
  alertsApi,
  deliveryTone,
  describeCondition,
  describeTargets,
  draftFromForm,
  durationPreset,
  formFromRule,
  severityTone,
  stateTone,
  trimNumber,
  validateAlertRuleForm,
  webhookUrl,
  type AlertRuleForm,
  type AlertRuleRow,
} from "../alertsApi";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function form(overrides: Partial<AlertRuleForm> = {}): AlertRuleForm {
  // A complete, sendable rule by default: each test below changes one field, so
  // a failure names the field it touched instead of the empty form.
  return {
    ...EMPTY_ALERT_RULE_FORM,
    id: "moutai-breakout",
    symbol: "600519.SH",
    value: "1700",
    ...overrides,
  };
}

function rule(overrides: Partial<AlertRuleRow> = {}): AlertRuleRow {
  return {
    id: "moutai-breakout",
    kind: "market",
    title: "茅台突破 1700",
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
    last_reason: "收盘 上穿 1700",
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

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.removeItem("vibe_trading_api_auth_key");
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("alertsApi transport", () => {
  it("sends the stored API key and drops empty filters from the query", async () => {
    localStorage.setItem("vibe_trading_api_auth_key", "k3y");
    fetchMock.mockResolvedValue(jsonResponse([]));

    await alertsApi.listRules({ kind: "event", enabled: undefined, limit: undefined });

    expect(fetchMock).toHaveBeenCalledWith(
      "/alerts/rules?kind=event",
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: "Bearer k3y" }) }),
    );
  });

  it("keeps enabled=false, which is a filter and not an absent one", async () => {
    fetchMock.mockResolvedValue(jsonResponse([]));
    await alertsApi.listRules({ enabled: false });
    expect(fetchMock.mock.calls[0][0]).toBe("/alerts/rules?enabled=false");
  });

  it("posts a draft as JSON", async () => {
    fetchMock.mockResolvedValue(jsonResponse(rule(), 201));
    const draft = draftFromForm(form({ id: "x", symbol: "AAPL.US" }));

    await alertsApi.createRule(draft);

    const [path, init] = fetchMock.mock.calls[0];
    expect(path).toBe("/alerts/rules");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toMatchObject({ id: "x", symbol: "AAPL.US" });
  });

  it("escapes a rule id into the path", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ status: "deleted", id: "a/b" }));
    await alertsApi.deleteRule("a/b");
    expect(fetchMock.mock.calls[0][0]).toBe("/alerts/rules/a%2Fb");
  });

  it("surfaces the backend's validation text with its status", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ detail: "推送目标不可用：unknown or disabled delivery target ref 'gone'" }, 422),
    );

    const error = await alertsApi.createRule(draftFromForm(form({ id: "x" }))).catch((e) => e);

    expect(error).toBeInstanceOf(AlertApiError);
    expect(error.status).toBe(422);
    expect(error.message).toContain("unknown or disabled delivery target ref");
  });

  it("still reports a status when the failure body is not JSON", async () => {
    fetchMock.mockResolvedValue(new Response("<html>boom</html>", { status: 502 }));

    await expect(alertsApi.listTargets()).rejects.toMatchObject({
      status: 502,
      message: "HTTP 502",
    });
  });

  it('defaults "evaluate now" to not pushing', async () => {
    // Two fresh Responses: a body can only be read once, so one shared object
    // would make the second call fail for a reason unrelated to the query.
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ status: "ok" }))
      .mockResolvedValueOnce(jsonResponse({ status: "ok" }));
    await alertsApi.runNow();
    expect(fetchMock.mock.calls[0][0]).toBe("/alerts/run?deliver=false");

    await alertsApi.runNow({ deliver: true, ruleId: "a b" });
    expect(fetchMock.mock.calls[1][0]).toBe("/alerts/run?deliver=true&rule_id=a+b");
  });

  it("returns null for an empty body instead of throwing on JSON.parse", async () => {
    fetchMock.mockResolvedValue(new Response("", { status: 200 }));
    await expect(alertsApi.resetRule("gone").catch((e) => e)).resolves.toBeNull();
  });
});

describe("describeCondition", () => {
  it("renders a fixed level with the operator glyph", () => {
    expect(describeCondition({ op: "crossUp", lhs: "close", value: 1700 })).toBe("close ↑ 1700");
    expect(describeCondition({ op: "gt", lhs: "rsi:14", value: 70 })).toBe("rsi:14 > 70");
    expect(describeCondition({ op: "crossDown", lhs: "close", value: 1680.5 })).toBe(
      "close ↓ 1680.5",
    );
  });

  it("renders a series-to-series comparison", () => {
    expect(describeCondition({ op: "crossUp", lhs: "close", rhs: "sma:20" })).toBe(
      "close ↑ sma:20",
    );
  });

  it("renders a unary operator without a partner", () => {
    expect(describeCondition({ op: "rising", lhs: "equity_usd" })).toBe("equity_usd ↗");
    expect(describeCondition({ op: "nonEmpty", lhs: "event_value" })).toBe("event_value ≠ ∅");
  });

  it("is blank for the shapes that carry no condition", () => {
    expect(describeCondition({})).toBe("");
    expect(describeCondition(null)).toBe("");
    expect(describeCondition(undefined)).toBe("");
  });

  it("keeps a zero level rather than treating it as absent", () => {
    expect(describeCondition({ op: "lt", lhs: "pnl_pct", value: 0 })).toBe("pnl_pct < 0");
  });
});

describe("number rendering", () => {
  it("never produces an exponent or a trailing zero", () => {
    expect(trimNumber(1700)).toBe("1700");
    expect(trimNumber(1712.5)).toBe("1712.5");
    expect(trimNumber(2.31)).toBe("2.31");
    expect(trimNumber(0.0001234)).toBe("0.0001234");
    expect(trimNumber(1e-7)).toBe("0.0000001");
    expect(trimNumber(0)).toBe("0");
    expect(trimNumber(-8.5)).toBe("-8.5");
    expect(trimNumber(Number.NaN)).toBe("—");
  });
});

describe("target summary", () => {
  it("prefers registered refs over the inline pair", () => {
    expect(describeTargets(rule())).toBe("research-group");
    expect(describeTargets(rule({ targets: [], channel: "telegram", target: "-1" }))).toBe(
      "telegram:-1",
    );
    expect(describeTargets(rule({ targets: [], channel: null, target: null }))).toBe("");
  });
});

describe("validateAlertRuleForm", () => {
  it("accepts the default shape once it has an id and a symbol", () => {
    expect(validateAlertRuleForm(form())).toEqual({});
  });

  it("requires an id that the routes can also address", () => {
    expect(validateAlertRuleForm(form({ id: "" }))).toEqual({ id: "required" });
    expect(validateAlertRuleForm(form({ id: "../escape" })).id).toBe("invalid_id");
    expect(validateAlertRuleForm(form({ id: "has space" })).id).toBe("invalid_id");
    expect(validateAlertRuleForm(form({ id: "a".repeat(129) })).id).toBe("invalid_id");
    expect(validateAlertRuleForm(form({ id: "ok_-1" })).id).toBeUndefined();
  });

  it("requires a symbol only for the kinds that have a subject", () => {
    expect(validateAlertRuleForm(form({ symbol: "" })).symbol).toBe("required");
    expect(validateAlertRuleForm(form({ kind: "account", symbol: "" })).symbol).toBeUndefined();
    expect(validateAlertRuleForm(form({ kind: "event", symbol: "", sendResolved: false }))).toEqual({});
  });

  it("demands a partner for a relational operator and none for a unary one", () => {
    expect(validateAlertRuleForm(form({ op: "gt", value: "" })).value).toBe("needs_partner");
    expect(validateAlertRuleForm(form({ op: "gt", value: "", rhs: "sma:20" })).value).toBeUndefined();
    expect(validateAlertRuleForm(form({ op: "rising", value: "" }))).toEqual({});
    expect(validateAlertRuleForm(form({ op: "gt", value: "abc" })).value).toBe("not_a_number");
  });

  it("keeps the bar window and debounce inside what the engine accepts", () => {
    expect(validateAlertRuleForm(form({ count: "1" })).count).toBe("out_of_range");
    expect(validateAlertRuleForm(form({ count: "2001" })).count).toBe("out_of_range");
    expect(validateAlertRuleForm(form({ forBars: "0" })).forBars).toBe("out_of_range");
  });

  it("refuses a half-declared inline destination", () => {
    expect(validateAlertRuleForm(form({ channel: "telegram" })).target).toBe("needs_channel");
    expect(validateAlertRuleForm(form({ channel: "telegram", target: "-1" }))).toEqual({});
  });

  it("refuses the resolution notice an event rule cannot deliver", () => {
    expect(validateAlertRuleForm(form({ kind: "event" })).sendResolved).toBe("event_no_resolution");
    expect(validateAlertRuleForm(form({ kind: "event", sendResolved: false }))).toEqual({});
  });

  it("checks the webhook secret against the same grammar the store hashes", () => {
    expect(
      validateAlertRuleForm(form({ kind: "event", sendResolved: false, webhookSecret: "short" }))
        .webhookSecret,
    ).toBe("invalid_secret");
    expect(
      validateAlertRuleForm(
        form({ kind: "event", sendResolved: false, webhookSecret: "long_enough-1" }),
      ),
    ).toEqual({});
  });

  it("requires the repeat ceiling to be at least the gap it doubles toward", () => {
    expect(
      validateAlertRuleForm(form({ realert: "4h", exponentialRealert: "1h" })).exponentialRealert,
    ).toBe("shorter_than_realert");
    expect(
      validateAlertRuleForm(form({ realert: "4h", exponentialRealert: "24h" })),
    ).toEqual({});
  });
});

describe("draftFromForm", () => {
  it("sends no condition for an event rule", () => {
    const draft = draftFromForm(form({ id: "tv", kind: "event", op: "gt", value: "1" }));
    expect(draft.condition).toBeNull();
    // And never a recovery promise, whatever the checkbox said.
    expect(draft.send_resolved).toBe(false);
  });

  it("turns blank fields into nulls rather than empty strings", () => {
    const draft = draftFromForm(form({ value: "", pollInterval: "" }));
    expect(draft.realert).toBeNull();
    expect(draft.exponential_realert).toBeNull();
    expect(draft.channel).toBeNull();
    expect(draft.target).toBeNull();
    expect(draft.webhook_secret).toBeNull();
    expect(draft.poll_interval).toBeNull();
    expect(draft.condition).toEqual({ op: "crossUp", lhs: "close", rhs: null, value: null });
  });

  it("omits a level the operator did not set", () => {
    const draft = draftFromForm(form({ op: "rising", value: "" }));
    expect(draft.condition?.value).toBeNull();
  });
});

describe("formFromRule", () => {
  it("maps stored milliseconds back onto the presets", () => {
    expect(durationPreset(14_400_000)).toBe("4h");
    expect(durationPreset(300_000)).toBe("5m");
    expect(durationPreset(7_000)).toBe("");
  });

  it("round-trips a rule into an editable form", () => {
    const loaded = formFromRule(rule());
    expect(loaded.id).toBe("moutai-breakout");
    expect(loaded.realert).toBe("4h");
    expect(loaded.exponentialRealert).toBe("24h");
    expect(loaded.pollInterval).toBe("5m");
    expect(loaded.value).toBe("1700");
    expect(loaded.targets).toEqual(["research-group"]);
    // The plaintext secret is unrecoverable, so the form must not pretend.
    expect(loaded.webhookSecret).toBe("");
  });

  it("re-validates after a round trip", () => {
    expect(validateAlertRuleForm(formFromRule(rule()))).toEqual({});
  });

  it("leaves an event rule's empty condition blank rather than inventing one", () => {
    const loaded = formFromRule(rule({ kind: "event", condition: {}, webhook_configured: true }));
    expect(loaded.rhs).toBe("");
    expect(loaded.value).toBe("");
  });
});

describe("webhookUrl", () => {
  it("makes the relative URL the server returned reachable from outside", () => {
    expect(webhookUrl("https://lab.example", "tv rule", "s3cret")).toBe(
      "https://lab.example/alerts/webhook/tv%20rule?key=s3cret",
    );
  });

  it("does not double up the slash on an origin that carries one", () => {
    expect(webhookUrl("http://127.0.0.1:8000/", "tv", "s3cret")).toBe(
      "http://127.0.0.1:8000/alerts/webhook/tv?key=s3cret",
    );
  });
});

describe("tones", () => {
  it("marks a firing or broken rule as loud and a cleared one as calm", () => {
    expect(stateTone("firing")).toBe("danger");
    expect(stateTone("error")).toBe("danger");
    expect(stateTone("pending")).toBe("warning");
    expect(stateTone("resolved")).toBe("success");
    expect(stateTone("inactive")).toBe("neutral");
  });

  it("keeps severity and delivery on the same scale", () => {
    expect(severityTone("critical")).toBe("danger");
    expect(severityTone("info")).toBe("neutral");
    expect(deliveryTone("failed")).toBe("danger");
    // A skipped push is not a failure: the rule simply had nowhere to send.
    expect(deliveryTone("skipped")).toBe("neutral");
    expect(deliveryTone("pending")).toBe("warning");
  });
});
