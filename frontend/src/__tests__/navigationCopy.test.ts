import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { NAVIGATION_GROUPS } from "@/components/layout/navigation";
import { SUPPORTED_LANGUAGES } from "@/i18n";

/**
 * Completeness guard for sidebar copy (local custom, upstream sync round).
 *
 * The sidebar label, its tooltip, and the expandable "How to use …" block under
 * PageHelp are three separate locale lookups keyed by the same navigation item
 * id. A missing key renders as the literal dotted path in every language — a
 * visible defect no behavioural test of a page would notice. Upstream now owns
 * the item list (components/layout/navigation.ts) and nine locale files, so the
 * pair can drift on either side of a merge.
 *
 * The expected key set is derived from NAVIGATION_GROUPS rather than written
 * out, so adding an entry without its copy fails here.
 */

const localesDir = resolve(__dirname, "../i18n/locales");

function readLocale(code: string): Record<string, any> {
  return JSON.parse(readFileSync(resolve(localesDir, `${code}.json`), "utf-8"));
}

const navItems = NAVIGATION_GROUPS.flatMap((group) => [...group.items]);
const groupIds = NAVIGATION_GROUPS.map((group) => group.id);
const codes = SUPPORTED_LANGUAGES.map((language) => language.code);

describe("the locale registry and the locale files agree", () => {
  it("has a parseable locale file per supported language", () => {
    // i18n/index.ts imports ./locales/<code>.json, so a code without a file
    // only fails when that language is selected — long after the merge that
    // dropped it. The reverse direction is not asserted: upstream also keeps a
    // stray tsconfig.json in this directory.
    for (const code of codes) {
      expect(() => readLocale(code), `${code}.json`).not.toThrow();
    }
  });
});

describe.each(codes)("sidebar copy for %s", (code) => {
  const locale = readLocale(code);

  it("labels every navigation entry", () => {
    for (const { id } of navItems) {
      expect(locale.layout?.[id], `layout.${id}`).toBeTypeOf("string");
      expect(locale.layout?.[id], `layout.${id}`).not.toHaveLength(0);
    }
  });

  it("names every navigation group", () => {
    for (const id of groupIds) {
      expect(locale.navigation?.groups?.[id], `navigation.groups.${id}`).not.toHaveLength(0);
    }
  });

  it("tooltips every navigation entry", () => {
    for (const { id } of navItems) {
      // The compact sidebar renders these as the link title, and the expanded
      // one as the line under the label, so they are not optional.
      expect(
        locale.navigation?.descriptions?.[id],
        `navigation.descriptions.${id}`,
      ).not.toHaveLength(0);
    }
  });

  it("explains every page that has a help block", () => {
    for (const { id } of navItems) {
      // PageHelp returns early for the agent entry, so only the others need
      // the long instruction paragraph.
      if (id === "agent") continue;
      expect(
        locale.navigation?.instructions?.[id],
        `navigation.instructions.${id}`,
      ).not.toHaveLength(0);
    }
  });

  it("interpolates the feature name into the help heading", () => {
    // t("navigation.howTo", { feature }) — without the placeholder every help
    // block claims to explain nothing.
    expect(locale.navigation?.howTo).toContain("{{feature}}");
  });

  it("never ships a key path as its own value", () => {
    const flat = [
      ...navItems.map(({ id }) => ["layout", id, locale.layout?.[id]]),
      ...navItems.map(({ id }) => [
        "navigation.descriptions",
        id,
        locale.navigation?.descriptions?.[id],
      ]),
    ] as [string, string, unknown][];
    for (const [namespace, id, value] of flat) {
      if (typeof value !== "string") continue;
      expect(value, `${namespace}.${id}`).not.toBe(`${namespace}.${id}`);
    }
  });
});
