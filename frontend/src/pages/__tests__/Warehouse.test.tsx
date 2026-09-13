import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Warehouse } from "@/pages/Warehouse";
import {
  warehouseApi,
  WarehouseApiError,
  type WarehouseAuditReport,
  type WarehouseStatus,
} from "@/lib/warehouseApi";

// Pure helpers (formatters) come from the same module as the transport, so keep
// the real exports and swap only the client object — the Alerts test convention.
vi.mock("@/lib/warehouseApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/warehouseApi")>();
  return {
    ...actual,
    warehouseApi: { status: vi.fn(), audit: vi.fn() },
  };
});

const mocked = warehouseApi as unknown as Record<string, ReturnType<typeof vi.fn>>;

function status(overrides: Partial<WarehouseStatus> = {}): WarehouseStatus {
  return {
    status: "ok",
    enabled: true,
    enable_env_var: "VIBE_TRADING_WAREHOUSE_ENABLED",
    root: "C:/Users/fire/.vibe-trading/warehouse",
    root_exists: true,
    has_data: true,
    intervals: [
      {
        interval: "1D",
        grain: "year",
        symbols: 300,
        rows: 742_000,
        first: "2016-01-04",
        last: "2026-09-04",
        markets: ["a_share"],
        asset_classes: ["equity"],
        sources: ["tushare"],
        partitions: 11,
        bytes: 58_720_256,
      },
    ],
    totals: {
      symbols: 300,
      rows: 742_000,
      partitions: 11,
      bytes: 58_720_256,
      first: "2016-01-04",
      last: "2026-09-04",
    },
    universes: ["csi300"],
    manifest: { schema_version: 1, updated_at: "2026-09-04T02:11:00+00:00", sources: null },
    commands: {
      fill: "vibe-trading warehouse sync --universe csi300 --years 10",
      fill_symbols: "vibe-trading warehouse sync --symbols 600519.SH --years 10",
      inventory: "vibe-trading warehouse list",
      health: "vibe-trading warehouse audit --interval 1D --min-gap 3",
    },
    ...overrides,
  };
}

function auditReport(overrides: Partial<WarehouseAuditReport> = {}): WarehouseAuditReport {
  return {
    status: "ok",
    interval: "1D",
    root: "C:/Users/fire/.vibe-trading/warehouse",
    symbols: 300,
    rows: 742_000,
    first: "2016-01-04",
    last: "2026-09-04",
    partitions: 11,
    clean: true,
    issues: [],
    gaps: [
      {
        symbol: "600519.SH",
        market: "a_share",
        start: "2020-01-09",
        end: "2020-01-13",
        sessions: 3,
        neighbors: "2020-01-08 / 2020-01-14",
      },
    ],
    gaps_total: 1,
    coverage: [
      {
        symbol: "600000.SH",
        market: "a_share",
        asset_class: "equity",
        first: "2024-06-03",
        last: "2026-09-04",
        rows: 540,
        sources: ["tushare"],
      },
    ],
    coverage_total: 300,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocked.status.mockResolvedValue(status());
  mocked.audit.mockResolvedValue(auditReport());
});

describe("the inventory", () => {
  it("shows what is on disk, in units a person reads", async () => {
    render(<Warehouse />);

    await screen.findByText("Bar warehouse");
    // Twice on purpose: once as the store-wide total, once on the 1D line. The
    // two must agree, so a totals bug shows up here rather than silently.
    expect(screen.getAllByText("742,000")).toHaveLength(2);
    expect(screen.getAllByText("56.0MB")).toHaveLength(2);
    expect(screen.getByText("2016-01-04 → 2026-09-04")).toBeInTheDocument();
    expect(screen.getByText("11")).toBeInTheDocument();
    expect(screen.getByText("C:/Users/fire/.vibe-trading/warehouse")).toBeInTheDocument();
    // The roster line is one node: the stored universe name has to reach the
    // reader, because a csi300 backfill without it is a survivorship trap.
    expect(screen.getByText("rosters: csi300")).toBeInTheDocument();
    expect(screen.getByText("tushare / a_share")).toBeInTheDocument();
  });

  it("renders the empty store as an empty state, not a zero dashboard", async () => {
    mocked.status.mockResolvedValue(
      status({ has_data: false, root_exists: false, intervals: [], universes: [] }),
    );

    render(<Warehouse />);

    expect(await screen.findByText("Nothing stored yet")).toBeInTheDocument();
    expect(screen.queryByText("742,000")).not.toBeInTheDocument();
    expect(screen.getByText("not created yet")).toBeInTheDocument();
  });

  it("quotes the read-path switch by name when it is off", async () => {
    // The whole point of showing this: the env var's exact name is the fix, and
    // a paraphrase of it is not something you can paste into a .env file.
    mocked.status.mockResolvedValue(status({ enabled: false }));

    render(<Warehouse />);

    expect(await screen.findByText("VIBE_TRADING_WAREHOUSE_ENABLED=true")).toBeInTheDocument();
    // Disabled or not, the inventory stays visible — that is what the switch
    // gates (the loader), not this readout.
    expect((await screen.findAllByText("742,000")).length).toBeGreaterThan(0);
    expect((await screen.findAllByText("300")).length).toBeGreaterThan(0);
  });

  it("says the failure out loud when the store cannot be read", async () => {
    mocked.status.mockRejectedValue(new WarehouseApiError("cannot read the warehouse", 500));

    render(<Warehouse />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("cannot read the warehouse");
  });
});

describe("the command block", () => {
  it("offers the backend's command line, not a paraphrase of it", async () => {
    render(<Warehouse />);

    const code = await screen.findByText("vibe-trading warehouse sync --universe csi300 --years 10");
    expect(code).toBeInTheDocument();
    // No `python -m backtest.warehouse` anywhere: the page must not send a
    // packaged-install user to a module path plus a working directory.
    expect(document.body.textContent).not.toContain("python -m");
  });

  it("copies the command to the clipboard", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<Warehouse />);

    const button = await screen.findByRole("button", { name: "Copy the backfill command" });
    fireEvent.click(button);

    expect(writeText).toHaveBeenCalledWith(
      "vibe-trading warehouse sync --universe csi300 --years 10",
    );
    expect(await screen.findByText("Copied")).toBeInTheDocument();
  });
});

describe("the health check", () => {
  it("runs on the selected interval and reports halts without calling them defects", async () => {
    render(<Warehouse />);
    fireEvent.click(await screen.findByRole("button", { name: /Run health check/ }));

    expect(await screen.findByText("Health check")).toBeInTheDocument();
    expect(mocked.audit).toHaveBeenCalledWith({ interval: "1D" });
    expect(screen.getByText("No impossible rows")).toBeInTheDocument();
    // A halt is a fact about the market: it is listed, and `clean` stays true.
    expect(screen.getByText("1 suspected halt(s)")).toBeInTheDocument();
    expect(screen.getByText("600519.SH")).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("marks a defect group as dirty", async () => {
    mocked.audit.mockResolvedValue(
      auditReport({
        clean: false,
        issues: [
          { code: "nonpositive_price", severity: "error", rows: 12, detail: "close <= 0" },
        ],
        gaps: [],
        gaps_total: 0,
      }),
    );

    render(<Warehouse />);
    fireEvent.click(await screen.findByRole("button", { name: /Run health check/ }));

    expect(await screen.findByText("1 defect group(s)")).toBeInTheDocument();
    expect(screen.getByText("nonpositive_price")).toBeInTheDocument();
    expect(screen.getByText("12")).toBeInTheDocument();
  });

  it("surfaces a rejected audit instead of showing a stale panel", async () => {
    mocked.audit.mockRejectedValue(new WarehouseApiError("no '5m' bars stored", 400));

    render(<Warehouse />);
    fireEvent.click(await screen.findByRole("button", { name: /Run health check/ }));

    const alerts = await screen.findAllByRole("alert");
    const last = alerts[alerts.length - 1];
    expect(within(last).getByText("no '5m' bars stored")).toBeInTheDocument();
    expect(screen.queryByText("Health check")).not.toBeInTheDocument();
  });

  it("offers a chooser only when there is more than one interval stored", async () => {
    render(<Warehouse />);
    await screen.findAllByText("742,000");

    expect(screen.queryByLabelText("Audit interval")).not.toBeInTheDocument();

    mocked.status.mockResolvedValue(
      status({
        intervals: [
          ...status().intervals,
          {
            ...status().intervals[0],
            interval: "1m",
            grain: "year,month",
          },
        ],
      }),
    );
    render(<Warehouse />);

    expect(await screen.findByLabelText("Audit interval")).toBeInTheDocument();
  });
});
