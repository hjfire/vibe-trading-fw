import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SymbolCombobox from "../SymbolCombobox";
// Relative to match the sibling lib test; the file sits outside tsconfig's
// `include` (tests are excluded from `tsc -b`), so the alias resolves at run
// time through Vite but not in every editor's inferred project.
import type { SymbolCandidate } from "../../../lib/symbolSearch";

/** Type-ahead field contract (local custom ㉓).
 *
 *  The search client is mocked so the assertions are about the widget: what it
 *  shows before typing, when it queries, what a click or Enter commits, and
 *  that it never traps a user whose symbol is not in the roster at all. */

const mocks = vi.hoisted(() => ({ search: vi.fn() }));

vi.mock("@/lib/symbolSearch", async (importOriginal) => ({
  // Keep the real pure helpers (marketLabel, isRoutableSymbol) so the widget
  // test exercises the same routing predicate the browser bug hinged on, and
  // stub only the network client.
  ...(await importOriginal<typeof import("../../../lib/symbolSearch")>()),
  createSearchSequence: () => {
    let token = 0;
    return {
      run: async (q: string, limit = 10) => {
        const mine = ++token;
        const out = await mocks.search(q, limit);
        return mine === token ? out : null;
      },
      cancel: () => {
        token += 1;
      },
    };
  },
}));

const MAOTAI: SymbolCandidate = { symbol: "600519.SH", name: "贵州茅台", market: "SH", type: "equity" };
const PAB: SymbolCandidate = { symbol: "600000.SH", name: "浦发银行", market: "SH", type: "equity" };

function answer(results: SymbolCandidate[], ready = true) {
  return { status: ready ? ("ok" as const) : ("warming" as const), ready, results, count: results.length };
}

interface HarnessProps {
  hot?: SymbolCandidate[];
  onPick: (symbol: string, candidate?: SymbolCandidate) => void;
}

/** The component is controlled, so the harness owns the text like a page does. */
function Harness({ hot = [], onPick }: HarnessProps) {
  const [text, setText] = useState("");
  return (
    <SymbolCombobox
      value={text}
      onChange={setText}
      onPick={onPick}
      ariaLabel="代码"
      hot={hot}
      placeholder="600519.SH"
    />
  );
}

beforeEach(() => {
  mocks.search.mockReset();
  mocks.search.mockResolvedValue(answer([MAOTAI, PAB]));
});

const input = () => screen.getByRole("combobox", { name: "代码" });

describe("SymbolCombobox", () => {
  it("shows the caller's own list the moment the box is focused, without querying", async () => {
    const user = userEvent.setup();
    render(<Harness hot={[PAB]} onPick={() => {}} />);

    await user.click(input());

    expect(screen.getByRole("option", { name: /600000.SH/ })).toBeInTheDocument();
    expect(mocks.search).not.toHaveBeenCalled();
  });

  it("queries after the debounce settles and lists the candidates", async () => {
    const user = userEvent.setup();
    render(<Harness onPick={() => {}} />);

    await user.type(input(), "600");
    await waitFor(() => expect(mocks.search).toHaveBeenCalledWith("600", 10));

    expect(await screen.findByRole("option", { name: /600519.SH/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /600000.SH/ })).toBeInTheDocument();
  });

  it("commits the picked candidate, not the raw keystrokes", async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(<Harness onPick={onPick} />);

    await user.type(input(), "茅台");
    await waitFor(() => expect(mocks.search).toHaveBeenCalled());
    await user.click(screen.getByRole("option", { name: /600519.SH/ }));

    expect(onPick).toHaveBeenCalledWith("600519.SH", MAOTAI);
  });

  it("offers 'use what I typed' so an off-roster pair stays enterable", async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    mocks.search.mockResolvedValue(answer([]));
    render(<Harness onPick={onPick} />);

    await user.type(input(), "btc-usdt");
    await waitFor(() => expect(mocks.search).toHaveBeenCalled());

    await user.click(screen.getByRole("option", { name: /BTC-USDT/ }));
    expect(onPick).toHaveBeenCalledWith("BTC-USDT", undefined);
  });

  it("hides the redundant raw row once the box already holds an exact symbol", async () => {
    const user = userEvent.setup();
    render(<Harness onPick={() => {}} />);

    await user.type(input(), "600519.SH");
    await waitFor(() => expect(mocks.search).toHaveBeenCalled());

    expect(screen.getAllByRole("option")).toHaveLength(2); // candidates only
  });

  it("commits the typed text on Enter when nothing is highlighted", async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(<Harness onPick={onPick} />);

    await user.type(input(), "BTC-USDT");
    await waitFor(() => expect(mocks.search).toHaveBeenCalled());
    await user.keyboard("{Enter}");

    expect(onPick).toHaveBeenCalledWith("BTC-USDT", undefined);
  });

  it("takes the top suggestion when Enter would commit an unroutable code", async () => {
    // Measured in the browser: typing 00700 and pressing Enter committed the
    // bare text, which then only resolved by walking the whole loader fallback
    // chain and got stored as-is in the session. A code no loader can route is
    // not "what the user typed" in any useful sense, so the listing already on
    // screen wins.
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(<Harness onPick={onPick} />);

    await user.type(input(), "00700");
    await waitFor(() => expect(mocks.search).toHaveBeenCalled());
    await user.keyboard("{Enter}");

    expect(onPick).toHaveBeenCalledWith("600519.SH", MAOTAI);
  });

  it("still commits raw text from the highlighted 'use what I typed' row", async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(<Harness onPick={onPick} />);

    await user.type(input(), "00700");
    await waitFor(() => expect(mocks.search).toHaveBeenCalled());
    // Two candidates, so the raw row sits at index 2 — reach it, then Enter.
    await user.keyboard("{ArrowDown}{ArrowDown}{ArrowDown}{Enter}");

    expect(onPick).toHaveBeenLastCalledWith("00700", undefined);
  });

  it("walks the list with the arrow keys and wraps past the ends", async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(<Harness onPick={onPick} />);

    // An exact symbol in the box drops the 'use what I typed' row, so the ring
    // is exactly the two candidates and the wrap positions are unambiguous.
    await user.type(input(), "600519.SH");
    await waitFor(() => expect(mocks.search).toHaveBeenCalled());

    // One ArrowUp from "nothing selected" lands on the last candidate.
    await user.keyboard("{ArrowUp}{Enter}");
    expect(onPick).toHaveBeenLastCalledWith("600000.SH", PAB);

    // Then from the top: down, down, wrapping past the end back onto the last.
    await user.keyboard("{ArrowDown}{ArrowDown}{Enter}");
    expect(onPick).toHaveBeenLastCalledWith("600000.SH", PAB);
  });

  it("includes the 'use what I typed' row in the keyboard ring", async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(<Harness onPick={onPick} />);

    await user.type(input(), "btc");
    await waitFor(() => expect(mocks.search).toHaveBeenCalled());

    // Two candidates + the raw row: ArrowUp once highlights the raw row.
    expect(screen.getAllByRole("option")).toHaveLength(3);
    await user.keyboard("{ArrowUp}");
    expect(input().getAttribute("aria-activedescendant")).toMatch(/-raw$/);
  });

  it("exposes the active option through aria-activedescendant", async () => {
    const user = userEvent.setup();
    render(<Harness onPick={() => {}} />);

    await user.type(input(), "600");
    await waitFor(() => expect(mocks.search).toHaveBeenCalled());
    await user.keyboard("{ArrowDown}");

    const box = input();
    expect(box).toHaveAttribute("aria-expanded", "true");
    expect(box.getAttribute("aria-activedescendant")).toBe(
      screen.getByRole("option", { name: /600519.SH/ }).id,
    );
  });

  it("closes on Escape without committing anything", async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    render(<Harness onPick={onPick} />);

    await user.type(input(), "600");
    await waitFor(() => expect(mocks.search).toHaveBeenCalled());
    await user.keyboard("{Escape}");

    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onPick).not.toHaveBeenCalled();
  });

  it("says the roster is still building instead of claiming no match", async () => {
    const user = userEvent.setup();
    mocks.search.mockResolvedValue(answer([], false));
    render(<Harness onPick={() => {}} />);

    await user.type(input(), "600");
    await waitFor(() => expect(mocks.search).toHaveBeenCalled());

    expect(await screen.findByText("代码库首次构建中…")).toBeInTheDocument();
  });

  it("does not claim 'no match' while it is showing matches", async () => {
    // The browser pass caught this: the hint keyed off "there is text" alone,
    // so a successful search was captioned 无匹配 right under two candidates.
    const user = userEvent.setup();
    render(<Harness onPick={() => {}} />);

    await user.type(input(), "600");
    await waitFor(() => expect(mocks.search).toHaveBeenCalled());

    expect(await screen.findByRole("option", { name: /600519.SH/ })).toBeInTheDocument();
    expect(screen.queryByText(/无匹配/)).not.toBeInTheDocument();
  });

  it("tells the user a symbol-less query is still enterable", async () => {
    const user = userEvent.setup();
    mocks.search.mockResolvedValue(answer([]));
    render(<Harness onPick={() => {}} />);

    await user.type(input(), "zzzz");
    await waitFor(() => expect(mocks.search).toHaveBeenCalled());

    expect(await screen.findByText("无匹配，可直接输入完整代码")).toBeInTheDocument();
  });

  it("keeps working as a plain input when the lookup fails", async () => {
    const onPick = vi.fn();
    const user = userEvent.setup();
    mocks.search.mockRejectedValue(new Error("backend down"));
    render(<Harness onPick={onPick} />);

    await user.type(input(), "600519.SH");
    await waitFor(() => expect(mocks.search).toHaveBeenCalled());
    await user.keyboard("{Enter}");

    expect(onPick).toHaveBeenCalledWith("600519.SH", undefined);
  });
});
