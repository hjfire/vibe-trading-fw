// One-shot community Pine corpus fetcher (Track A1).
//
// Downloads the real, third-party scripts listed in pine-community.manifest.json
// straight from the raw.githubusercontent CDN (reachable here even though the
// GitHub API is proxy-blocked), preserving each file's GPL attribution header,
// and writes them verbatim under __tests__/__fixtures__/corpus/.
//
// This is a local generator, not part of the build or CI: the bulk corpus is
// external content we do not commit. The committed artefacts are the manifest
// (so the exact set is reproducible) and the small curated smoke subset.
//
// Usage:  node frontend/scripts/corpus/fetchPineCorpus.mjs

import { readFile, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", ".."); // frontend/
// Default target is the v3/v4 everget corpus; a second source (e.g. the v6
// mihakralj corpus) is fetched by pointing CORPUS_MANIFEST at its manifest and
// CORPUS_OUT at a sibling fixtures dir, so the bulk measurements stay separable.
const MANIFEST_NAME = process.env.CORPUS_MANIFEST || "pine-community.manifest.json";
const OUT_DIR = process.env.CORPUS_OUT
  ? resolve(ROOT, process.env.CORPUS_OUT)
  : join(ROOT, "src", "lib", "__tests__", "__fixtures__", "corpus");
const CONCURRENCY = 8;
const RAW_BASE = "https://raw.githubusercontent.com";

/** A file is a real Pine script only if it opens with a version pragma and has
 *  a top-level study/indicator/strategy declaration. Anything else (README
 *  fragments, index lists) is a dirty export and gets dropped, per the lesson
 *  that a pass-rate computed over non-source is meaningless. */
function looksLikePine(text) {
  const head = text.slice(0, 4000);
  return /\/\/\s*@version\s*=/i.test(head) &&
    /^\s*(study|indicator|strategy)\s*\(/im.test(head);
}

async function download(repo, branch, path) {
  const url = `${RAW_BASE}/${repo}/${branch}/${encodeURI(path)}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": "vt-corpus" } });
      if (res.status === 404) return { path, status: "not_found" };
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = (await res.text()).replace(/^\uFEFF/, "");
      if (!looksLikePine(text)) return { path, status: "not_pine" };
      await mkdir(dirname(join(OUT_DIR, path)), { recursive: true });
      await writeFile(join(OUT_DIR, path), text, "utf8");
      return { path, status: "ok", bytes: text.length };
    } catch (err) {
      if (attempt === 3) return { path, status: `error: ${err.message}` };
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }
  return { path, status: "unknown" };
}

async function main() {
  const manifest = JSON.parse(
    (await readFile(join(HERE, MANIFEST_NAME), "utf8")).replace(/^\uFEFF/, ""),
  );
  const { repo, branch, files } = manifest;
  console.log(`Fetching ${files.length} files from ${repo}@${branch} ...`);

  const tally = { ok: 0, not_found: 0, not_pine: 0, error: 0 };
  const failures = [];
  let cursor = 0;
  async function worker() {
    while (cursor < files.length) {
      const path = files[cursor++];
      const r = await download(repo, branch, path);
      if (r.status === "ok") tally.ok++;
      else if (r.status === "not_found") tally.not_found++;
      else if (r.status === "not_pine") tally.not_pine++;
      else {
        tally.error++;
        failures.push(`${path}: ${r.status}`);
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  await writeFile(
    join(OUT_DIR, "_fetch-summary.json"),
    JSON.stringify({ repo, branch, ...tally, failures }, null, 2),
    "utf8",
  );
  console.log("CORPUS_FETCH_TALLY", JSON.stringify(tally));
  if (failures.length) console.log("FAILURES", failures.join("\n"));
  console.log(`Corpus dir: ${OUT_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
