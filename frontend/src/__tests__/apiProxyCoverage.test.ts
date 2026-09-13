import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Every path the API clients call must be covered by a dev-server proxy rule.
 *
 * This is the check that `viteProxy.test.ts` was too small to be: it named
 * three prefixes by hand, so a fourth (`/alerts`, local custom ㉑) shipped
 * unproxied and its page has been failing under `npm run dev` ever since —
 * Vite's SPA fallback answers `/alerts/rules` with `index.html` at status
 * **200**, which reads as a successful request right up until `JSON.parse`
 * throws `Unexpected token '<'`. The API server's own handler puts on the same
 * disguise for an unregistered `/api/...` route (see `agent/src/api/spa.py`),
 * which is why one symptom kept arriving with three different causes.
 *
 * The scanner, not the assertion list, is the product here: a new client method
 * pointing at a prefix nobody proxied should fail here, not in a browser.
 */

const ROOT = resolve(__dirname, "../..");
const LIB_DIR = resolve(ROOT, "src/lib");

/** Vite matches a string key as a path prefix and a `^...` key as a RegExp. */
interface ProxyRule {
  key: string;
  /** Which handler the key is wired to, so the dual-role check can read it. */
  target: string;
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

/** `/sessions/${sid}/goal` is proxied as `/sessions/`, so the head is enough. */
function staticHead(literal: string): string {
  return literal.split("${")[0].split("?")[0];
}

function looksLikeApiPath(path: string): boolean {
  if (!path.startsWith("/") || path.startsWith("//")) return false;
  const segments = path.slice(1).split("/").filter((segment) => segment !== "");
  if (!segments.length) return false;
  if (!/^[a-z][\w.-]+$/.test(segments[0])) return false;
  return segments.every((segment) => /^[\w.-]+$/.test(segment) && !segment.includes(".."));
}

/** Every path literal in an argument position of `fetch` / `request` / `call`. */
function apiPathsIn(source: string): string[] {
  const code = stripComments(source).replace(/\$\{BASE\}/g, "");
  const found: string[] = [];
  for (const match of code.matchAll(/\b(?:fetch|request|call)(?:<[^<>()]*>)?\s*\(\s*([^,\n]{0,160})/g)) {
    const literal = match[1].match(/^(["'`])(\/[^"'`\s]*)/);
    if (!literal) continue;
    const head = staticHead(literal[2]);
    if (looksLikeApiPath(head)) found.push(head);
  }
  return found;
}

function libSources(): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of readdirSync(LIB_DIR)) {
    const full = resolve(LIB_DIR, entry);
    if (!entry.endsWith(".ts") || entry.endsWith(".d.ts") || !statSync(full).isFile()) continue;
    out.set(entry, readFileSync(full, "utf-8"));
  }
  return out;
}

const viteConfig = readFileSync(resolve(ROOT, "vite.config.ts"), "utf-8");

/** Text between the braces of the object that starts at `marker`, inclusive. */
function balancedBlock(text: string, marker: string): string {
  const start = text.indexOf(marker);
  if (start < 0) return "";
  let depth = 0;
  for (let index = start + marker.length - 1; index < text.length; index += 1) {
    if (text[index] === "{") depth += 1;
    else if (text[index] === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start + marker.length, index);
    }
  }
  return "";
}

/** `PROXY_PATHS` plus every key of the explicit `proxy: { ... }` object. */
function proxyRules(): ProxyRule[] {
  const byKey = new Map<string, ProxyRule>();
  const list = viteConfig.match(/const PROXY_PATHS = \[([\s\S]*?)\];/);
  for (const entry of list?.[1].matchAll(/["']([^"']+)["']/g) ?? []) {
    byKey.set(entry[1], { key: entry[1], target: "apiProxy" });
  }
  const block = balancedBlock(viteConfig, "proxy: {");
  for (const entry of block.matchAll(/["']([^"']+)["']\s*:\s*([A-Za-z_$][\w$]*)/g) ?? []) {
    // An explicit key overrides the spread entry above, same as in the config.
    byKey.set(entry[1], { key: entry[1], target: entry[2] });
  }
  return [...byKey.values()];
}

function covers(rule: ProxyRule, apiPath: string): boolean {
  return rule.key.startsWith("^")
    ? new RegExp(rule.key).test(apiPath)
    : apiPath.startsWith(rule.key);
}

const rules = proxyRules();
const used = new Map<string, string[]>();
for (const [file, text] of libSources()) {
  for (const apiPath of apiPathsIn(text)) {
    used.set(apiPath, [...(used.get(apiPath) ?? []), file]);
  }
}

describe("every API path the clients call is proxied in dev", () => {
  it("finds the paths at all, so the scanner cannot pass by matching nothing", () => {
    // A regex that quietly stops matching turns the test below into a vacuous
    // green, which is the one failure mode that looks like a passing guard.
    expect([...used.keys()]).toEqual(
      expect.arrayContaining([
        "/alerts/rules",
        "/api/warehouse/status",
        "/market/kline",
        "/sessions/",
        "/correlation",
        "/upload",
      ]),
    );
    expect(used.size).toBeGreaterThan(20);
  });

  it("has a proxy rule for each one", () => {
    const uncovered = [...used.keys()]
      .filter((apiPath) => !rules.some((rule) => covers(rule, apiPath)))
      .map((apiPath) => `${apiPath}  (called from ${[...new Set(used.get(apiPath))].join(", ")})`);
    expect(uncovered).toEqual([]);
  });
});

describe("the scanner's own filter", () => {
  /**
   * The two cases above read the repository, so their green depends on the
   * repository happening to be clean. These two feed themselves, which is the
   * only way to watch the filter decide: with the corpus in `src/lib` holding no
   * rejected literal, "the filter stopped filtering" is unobservable through
   * `used`, and a probe on it survives as an equivalent mutant.
   */
  it("keeps call-site literals that a proxy could match and drops the rest", () => {
    const source = [
      'fetch("/alerts/rules", { method: "GET" })',
      'fetch(`/sessions/${sid}/goal`)',
      'request("/api/warehouse/status")',
      // Not paths, or paths that cannot be matched as a prefix:
      'fetch("alerts/rules")',
      'fetch("//cdn.example/x")',
      'fetch("/")',
      'fetch("/UPPER/x")',
      // Well-formed at the head, junk further down: the segment rules decide.
      'fetch("/api/../x")',
      'fetch("/api/a:b")',
      'fetch("/api/...")',
    ].join("\n");

    expect(apiPathsIn(source)).toEqual([
      "/alerts/rules",
      "/sessions/",
      "/api/warehouse/status",
    ]);
  });

  it("ignores prose, so a doc comment cannot invent an API path", () => {
    // Prose that mentions a real-looking path is the shape that first poisoned
    // this scanner (`/*`, `//@version`, `/eval:` all arrived as paths). The
    // literal used here is deliberately one the filter above would accept, so
    // this case fails when comment-stripping breaks rather than hiding behind
    // the filter.
    const source = [
      "/**",
      ' * Example: fetch("/alerts/ghost") is only documentation.',
      " */",
      'fetch("/alerts/rules");',
    ].join("\n");

    expect(apiPathsIn(source)).toEqual(["/alerts/rules"]);
  });
});

describe("prefixes that are both an API namespace and an SPA route", () => {
  const router = readFileSync(resolve(ROOT, "src/router.tsx"), "utf-8");
  const routePrefixes = [...router.matchAll(/\{ path: "\/(?<seg>[\w-]+)/g)].map(
    (match) => match.groups?.seg ?? "",
  );

  for (const prefix of ["alerts", "correlation", "options"]) {
    it(`/${prefix} navigates through the html fallback, not the plain proxy`, () => {
      expect(routePrefixes).toContain(prefix);
      // A plain proxy rule would send a browser navigation for the *page* to
      // the API server, which answers from the built `dist/` shell — a stale
      // app, silently, instead of the dev sources being edited right now.
      const rule = rules.find((candidate) => candidate.key === `/${prefix}`);
      expect(rule?.target).toBe("apiProxyWithHtmlFallback");
    });
  }
});
