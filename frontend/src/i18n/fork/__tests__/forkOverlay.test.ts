import { waitFor } from "@testing-library/react";
import { NAVIGATION_GROUPS } from "@/components/layout/navigation";
import i18n, { SUPPORTED_LANGUAGES } from "@/i18n";

// Both sides are discovered from disk, never listed here: a hardcoded list is
// how a language ships with perfect parity and no coverage at all.
const overlayModules = import.meta.glob<Record<string, unknown>>("../*.json", {
  eager: true,
  import: "default",
});
const localeModules = import.meta.glob<Record<string, unknown>>("../../locales/*.json", {
  eager: true,
  import: "default",
});

function codeOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1, -".json".length);
}

const overlays: Record<string, Record<string, unknown>> = {};
for (const [path, mod] of Object.entries(overlayModules)) {
  overlays[codeOf(path)] = mod;
}

const locales: Record<string, Record<string, unknown>> = {};
for (const [path, mod] of Object.entries(localeModules)) {
  const code = codeOf(path);
  // Upstream keeps a stray tsconfig.json in the locales directory.
  if (code !== "tsconfig") locales[code] = mod;
}

/** Every leaf value keyed by its dot path; Object.keys of this is the key set. */
function leafValues(obj: Record<string, unknown>, prefix = ""): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      Object.assign(out, leafValues(value as Record<string, unknown>, full));
    } else {
      out[full] = value;
    }
  }
  return out;
}

const codes = SUPPORTED_LANGUAGES.map((language) => language.code);
const enOverlay = leafValues(overlays.en ?? {});
const enOverlayKeys = Object.keys(enOverlay).sort();
const navIds = NAVIGATION_GROUPS.flatMap((group) => [...group.items]).map((item) => item.id);
const upstreamIds = new Set(Object.keys((locales.en?.layout ?? {}) as Record<string, unknown>));
const forkIds = navIds.filter((id) => !upstreamIds.has(id));
const FAMILIES = ["layout", "navigation.descriptions", "navigation.instructions"] as const;
const VAR_RE = /\{\{(\w+)\}\}/g;
const MOJIBAKE_RE = /â€|Ã|Â|\uFFFD/;

describe("fork overlay registry", () => {
  it("has one overlay file per registered language, and no others", () => {
    expect(Object.keys(overlays).sort()).toEqual([...codes].sort());
  });
});

describe.each(codes)("fork overlay parity for %s", (code) => {
  const mine = leafValues(overlays[code] ?? {});

  it("carries every key the English overlay carries", () => {
    const present = new Set(Object.keys(mine));
    expect(enOverlayKeys.filter((key) => !present.has(key))).toEqual([]);
  });

  it("carries no key the English overlay lacks", () => {
    const canonical = new Set(enOverlayKeys);
    expect(Object.keys(mine).filter((key) => !canonical.has(key)).sort()).toEqual([]);
  });
});

describe.each(codes)("fork overlay stays out of upstream copy for %s", (code) => {
  it("shares no leaf path with the upstream locale", () => {
    // Also the regression pin for a future sync that unions our keys back into
    // locales/: the moment both sides carry a key, this intersection is non-empty.
    const upstream = new Set(Object.keys(leafValues(locales[code] ?? {})));
    const collisions = Object.keys(leafValues(overlays[code] ?? {}))
      .filter((key) => upstream.has(key))
      .sort();
    expect(collisions).toEqual([]);
  });
});

describe.each(codes)("fork overlay copy quality for %s", (code) => {
  const mine = leafValues(overlays[code] ?? {});

  it("ships non-empty strings that are not their own key path", () => {
    for (const [key, value] of Object.entries(mine)) {
      expect(value, key).toBeTypeOf("string");
      expect((value as string).length, key).toBeGreaterThan(0);
      expect(value, key).not.toBe(key);
    }
  });

  it("has no UTF-8 text decoded as Windows-1252", () => {
    const broken = Object.entries(mine)
      .filter(([, value]) => MOJIBAKE_RE.test(String(value)))
      .map(([key]) => key);
    expect(broken).toEqual([]);
  });

  it("interpolates the same variables as the English overlay", () => {
    // Vacuous at landing: none of the fork's keys carry a {{variable}}. Kept so
    // a future placeholder cannot drift between languages; M11 proves it bites.
    const mismatches: string[] = [];
    for (const key of enOverlayKeys) {
      const enVars = [...String(enOverlay[key]).matchAll(VAR_RE)].map((m) => m[1]).sort();
      const locVars = [...String(mine[key] ?? "").matchAll(VAR_RE)].map((m) => m[1]).sort();
      if (enVars.join(",") !== locVars.join(",")) mismatches.push(key);
    }
    expect(mismatches).toEqual([]);
  });
});

describe("fork overlay Turkish copy", () => {
  it("does not ship copied English", () => {
    // Upstream's i18n.test.ts stops covering these keys once they move out of
    // tr.json, so the check is re-established here. Stricter than upstream's:
    // no shared-term allowlist, because every fork key is prose.
    const tr = leafValues(overlays.tr ?? {});
    const copied = Object.entries(tr)
      .filter(([key, value]) => value === enOverlay[key])
      .map(([key]) => key);
    expect(copied).toEqual([]);
  });
});

describe("fork overlay covers every fork-owned navigation entry", () => {
  it("has at least one fork-owned entry to cover", () => {
    // Non-vacuity: without this the it.each below passes on an empty id set.
    expect(forkIds.length).toBeGreaterThan(0);
  });

  it.each(codes)("%s supplies all three copy families for every fork-owned entry", (code) => {
    const mine = leafValues(overlays[code] ?? {});
    for (const id of forkIds) {
      for (const family of FAMILIES) {
        expect(mine[`${family}.${id}`], `${code} ${family}.${id}`).toBeTypeOf("string");
      }
    }
  });
});

describe.each(codes)("runtime resolution for %s", (code) => {
  it("resolves every overlay key to that language's own value", async () => {
    await i18n.changeLanguage(code);
    // layout.agent belongs to upstream, so its presence says the locale bundle
    // landed without saying anything about the overlay under test. Waiting on a
    // fork key instead would time out for 20s per language in RED-B.
    await waitFor(() => {
      expect(i18n.getResource(code, "translation", "layout.agent")).toBeTypeOf("string");
    });
    const expected = leafValues(overlays[code] ?? {});
    for (const key of enOverlayKeys) {
      // Right side is the overlay JSON's value, never t() re-run (tautology) and
      // never "not equal to the key path" (would pass on an English fallback).
      expect(i18n.t(key, key)).toBe(expected[key]);
    }
  });
});

describe("language switching", () => {
  it("leaves the final language's overlay copy in effect after two quick switches", async () => {
    // Ordering is not forced: this pins the final state, not a simulated slow
    // import. The slice adds a second await to loadLanguage, widening the window
    // in which a stale load could otherwise win.
    void i18n.changeLanguage("de");
    await i18n.changeLanguage("id");
    await waitFor(() => {
      expect(i18n.getResource("id", "translation", "layout.agent")).toBeTypeOf("string");
    });
    const expected = leafValues(overlays.id ?? {});
    for (const key of enOverlayKeys) {
      expect(i18n.t(key, key)).toBe(expected[key]);
    }
    expect(i18n.language).toBe("id");
  });
});
