/**
 * Tests for the in-app usage manual (local custom 24).
 *
 * The point of this file is not "does react-markdown render" -- it is the two
 * derivations the page owns and the markdown file cannot: heading ids and the
 * chapter list. They are computed by the same `slugifyHeading`, and the moment
 * they stop agreeing the sidebar silently goes nowhere. `vi.mock("@/lib/api")`
 * is deliberately absent: Help.tsx imports no data layer (a plain relative
 * `fetch` of a public asset is the whole backend contract), so the upstream
 * `@/entities/portfolio` chain that the api mock exists to cut off is never
 * pulled in here.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { render, screen } from "@testing-library/react";
import { Help, extractToc, slugifyHeading } from "@/pages/Help";

const GUIDE = [
  "# 使用说明",
  "",
  "> 面向日常使用者。",
  "",
  "## 1 三十秒上手",
  "",
  "先双击 `start.bat`。",
  "",
  "```text",
  "# 这一行在代码块里，不是章节",
  "用 600519.SH 做回测",
  "```",
  "",
  "## 6 智能体对话（`/`）",
  "",
  "输入框说明。",
  "",
  "### 6.1 目标机制",
  "",
  "| 字段 | 含义 |",
  "| --- | --- |",
  "| 温度 | 越低越稳 |",
  "",
  "## 15 专业图表（`/pro-chart`）",
  "",
  "画线。",
  ""].join("\n");

function mockFetch(body: string, ok = true, status = 200) {
  const fn = vi.fn().mockResolvedValue({
    ok,
    status,
    text: () => Promise.resolve(body),
  });
  vi.stubGlobal("fetch", fn);
  return fn;
}

beforeEach(() => {
  vi.unstubAllGlobals();
  // jsdom keeps window.location between tests in a file, and the deep-link
  // effect reads it on mount: a hash left behind by the chapter-list click test
  // makes the *next* test scroll to a stale target (and jsdom has no
  // scrollIntoView, so the effect throws and the whole page fails to render).
  window.location.hash = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("slugifyHeading", () => {
  it("drops CJK punctuation and route slashes but keeps the letters", () => {
    expect(slugifyHeading("智能体对话（`/`）")).toBe("智能体对话");
    expect(slugifyHeading("专业图表（`/pro-chart`）")).toBe("专业图表pro-chart");
  });

  it("keeps a numbered heading's dot and turns its space into a dash", () => {
    expect(slugifyHeading("15 画线清单与样式")).toBe("15-画线清单与样式");
    expect(slugifyHeading("6.1 目标机制")).toBe("6.1-目标机制");
  });

  it("is stable across the spacing a markdown author cannot avoid", () => {
    expect(slugifyHeading("  启动  关闭与两个端口 \n")).toBe(slugifyHeading("启动 关闭与两个端口"));
  });
});

describe("extractToc", () => {
  it("reads ## and ### but ignores a # inside a fenced sample", () => {
    const ids = extractToc(GUIDE).map((e) => e.text);
    expect(ids).toEqual([
      "1 三十秒上手",
      "6 智能体对话（/）",
      "6.1 目标机制",
      "15 专业图表（/pro-chart）",
    ]);
  });

  it("gives every entry the id the rendered heading will carry", () => {
    for (const entry of extractToc(GUIDE)) {
      expect(entry.id).toBe(slugifyHeading(entry.text));
    }
  });

  it("does not list the H1 title", () => {
    expect(extractToc(GUIDE).some((e) => e.text === "使用说明")).toBe(false);
  });
});

describe("the shipped manual (public/usage-guide.md)", () => {
  // Read the real document, not a fixture: the nav is only honest if the
  // headings people actually edit behave. This is what catches a duplicated or
  // punctuation-only heading the moment it is written. `__dirname` rather than
  // `import.meta.url` because under the jsdom environment import.meta.url is an
  // http URL, which fileURLToPath rejects -- src/__tests__/viteProxy.test.ts
  // already reads repository files this way.
  const raw = readFileSync(
    path.resolve(__dirname, "../../../public/usage-guide.md"),
    "utf8",
  );

  it("gives every chapter a non-empty, unique anchor", () => {
    const toc = extractToc(raw);
    expect(toc.length).toBeGreaterThan(20);
    const ids = toc.map((entry) => entry.id);
    expect(ids.every((id) => id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("keeps the promise the page header makes about the file path", () => {
    expect(raw).toContain("start.bat");
    expect(raw).toContain("/help");
  });
});

describe("<Help />", () => {
  it("renders the fetched document with tables and headings", async () => {
    mockFetch(GUIDE);
    render(<Help />);

    // By role, not by text: the chapter nav repeats every heading's text, so a
    // bare findByText matches the nav link and the heading at once.
    expect(
      await screen.findByRole("heading", { level: 2, name: /三十秒上手/ }),
    ).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 3, name: /目标机制/ })).toBeInTheDocument();
    expect(screen.getByText("越低越稳")).toBeInTheDocument();
    expect(screen.getByText(/先双击/)).toBeInTheDocument();
  });

  it("points every chapter link at an id that exists in the document", async () => {
    mockFetch(GUIDE);
    const { container } = render(<Help />);
    await screen.findByText("越低越稳");

    const links = Array.from(
      container.querySelectorAll('nav[aria-label="章节"] a'),
    ) as HTMLAnchorElement[];
    expect(links).toHaveLength(4);

    for (const link of links) {
      const id = link.getAttribute("href")?.replace(/^#/, "");
      expect(id).toBeTruthy();
      expect(container.querySelector(`#${CSS.escape(id as string)}`)).not.toBeNull();
    }
  });

  it("keeps a chapter list for narrow viewports, where the rail is hidden", async () => {
    // The sticky rail is `hidden lg:block`, so below 1024px it is gone -- and a
    // manual without a chapter list is a wall of text. jsdom applies no media
    // queries, so what this can pin down is that the collapsed list exists, is
    // complete, and resolves like the rail does.
    mockFetch(GUIDE);
    const { container } = render(<Help />);
    await screen.findByText("越低越稳");

    const rail = container.querySelectorAll('nav[aria-label="章节"] a');
    const fallback = container.querySelectorAll("details a");
    expect(rail).toHaveLength(4);
    expect(fallback).toHaveLength(rail.length);
    for (const link of Array.from(fallback) as HTMLAnchorElement[]) {
      const id = link.getAttribute("href")?.replace(/^#/, "");
      expect(container.querySelector(`#${CSS.escape(id as string)}`)).not.toBeNull();
    }

    // Picking a chapter folds the list, otherwise 49 rows stay on top of the
    // chapter that was just asked for.
    const box = container.querySelector("details") as HTMLDetailsElement;
    box.open = true;
    (fallback[1] as HTMLAnchorElement).click();
    expect(box.open).toBe(false);
  });

  it("attaches ids to the rendered headings themselves", async () => {
    mockFetch(GUIDE);
    const { container } = render(<Help />);
    await screen.findByRole("heading", { level: 3, name: /目标机制/ });

    // Dots survive (GitHub's rule), so a numbered sub-heading keeps its number.
    expect(container.querySelector("#" + CSS.escape("6-智能体对话"))).not.toBeNull();
    expect(container.querySelector("h3#" + CSS.escape("6.1-目标机制"))).not.toBeNull();
  });

  it("still renders the manual when the deep link cannot be resolved", async () => {
    // An exception from a passive effect unmounts the tree, so a hand-typed URL
    // like /help#%zz (invalid percent escape, no scrollIntoView under jsdom)
    // would otherwise take the whole document down with it.
    window.location.hash = "#%zz";
    mockFetch(GUIDE);
    render(<Help />);

    expect(await screen.findByText("越低越稳")).toBeInTheDocument();
    expect(screen.getByRole("heading", { level: 2, name: /三十秒上手/ })).toBeInTheDocument();
  });

  it("explains the rebuild requirement when the asset is missing", async () => {
    mockFetch("", false, 404);
    render(<Help />);

    expect(await screen.findByRole("alert")).toBeInTheDocument();
    expect(screen.getByText("读不到说明文档")).toBeInTheDocument();
    // The advice has to name the real fix, not just the failure.
    expect(screen.getByText(/npm run build/)).toBeInTheDocument();
  });

  it("asks for the key it was fetched with, relative to the origin", async () => {
    const fn = mockFetch(GUIDE);
    render(<Help />);
    await screen.findByText("越低越稳");
    expect(fn.mock.calls[0][0]).toBe("/usage-guide.md");
  });

  it("says it is loading before the document arrives", () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() => new Promise(() => {})),
    );
    render(<Help />);
    expect(screen.getByText("正在加载说明…")).toBeInTheDocument();
  });
});
