import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { translatePineAlerts } from "@/lib/pineAlertRules";

/**
 * Coverage guard over the real community corpus (spec §11.5).
 *
 * The translator refuses almost everything people actually write, and that is
 * the accepted design — but a number has to be on record for how much, or
 * "narrow but honest" and "silently broken" look identical. So this walks the
 * same `.pine` files the interpreter's corpus tests walk, counts the alert sites
 * and how many translate, prints the reason distribution, and puts a floor under
 * the walk and the distribution so a future edit that stops reaching the scripts
 * goes red instead of quietly reporting zero.
 */

const CORPUS_DIR = resolve(process.cwd(), process.env.PINE_CORPUS_DIR || "src/lib/__tests__/__fixtures__/corpus");

/**
 * The bulk corpus is local-only — `frontend/.gitignore:9` keeps it out of the
 * checkout and `scripts/corpus/fetchPineCorpus.mjs` fills it on demand — so CI
 * never has it and this gate has never run there. Absent therefore means *not
 * installed*, not *broken*: it reports as a skip (the verbose log counts it
 * `skipped`, never as a pass), while a directory that IS there but walks to
 * fewer than 100 scripts still throws below, since that is the rot this gate
 * exists to catch. Same shape as `pineCorpusReport.test.ts`'s `corpusReady`.
 */
const corpusReady = existsSync(CORPUS_DIR);
if (!corpusReady) {
  process.stdout.write(
    `\n[corpus-absent] ${CORPUS_DIR} 不在这份检出里（语料只装本机），告警覆盖度门跳过 —— 跳过＝未覆盖，不是通过。\n`,
  );
}
const gate = corpusReady ? it : it.skip;

function pineFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...pineFiles(abs));
    else if (entry.name.endsWith(".pine")) out.push(abs);
  }
  return out.sort();
}

gate("translates some corpus alerts, refuses the rest with a reason, and never crashes", () => {
  const files = pineFiles(CORPUS_DIR);
  if (files.length < 100) throw new Error(`语料只有 ${files.length} 份，遍历坏了：${CORPUS_DIR}`);

  let withAlerts = 0;
  let total = 0;
  let native = 0;
  let crashed = 0;
  let reasonless = 0;
  let compound = 0;
  const reasons = new Map<string, number>();
  for (const file of files) {
    const code = readFileSync(file, "utf8");
    if (!code.includes("alertcondition") && !code.includes("alert(")) continue;
    let plans;
    try {
      plans = translatePineAlerts(code, { symbol: "600519.SH", interval: "1D" });
    } catch (e) {
      crashed++;
      process.stdout.write(`[bridge-crash] ${file}: ${e instanceof Error ? e.message : String(e)}\n`);
      continue;
    }
    if (!plans.length) continue;
    withAlerts++;
    for (const p of plans) {
      total++;
      if (p.status === "native") {
        native++;
        continue;
      }
      if (!p.reason) reasonless++;
      if (p.reason?.includes("布尔组合")) compound++;
      const key = (p.reason || "（没有理由）").slice(0, 26);
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
  }

  process.stdout.write(
    `\n[bridge-coverage] files=${files.length} scripts=${withAlerts} alertcondition=${total} native=${native} compound=${compound}\n`,
  );
  for (const [reason, n] of [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    process.stdout.write(`  ${n}× ${reason}\n`);
  }

  expect(total, "语料里一条告警都没找到：遍历或匹配坏了").toBeGreaterThanOrEqual(55);
  expect(withAlerts).toBeGreaterThanOrEqual(15);
  // native gets no floor here: measured 2026-10-06, 0 of 63 community alert sites
  // is a single comparison over roster series, because a real script gates a
  // signal on `direction != direction[1]` and then ANDs three of those. The
  // translatable forms are pinned by name in pineAlertRules.test.ts instead;
  // this file keeps the coverage number on the record and the walk honest.
  // The distribution is what proves the walk still reaches those scripts.
  expect(compound, "带 and/or 的告警站点数掉了：语料遍历或分类坏了").toBeGreaterThanOrEqual(20);
  expect(crashed, "翻译器抛了拒绝以外的异常").toBe(0);
  expect(reasonless, "有拒绝没写理由，面板只能显示空白").toBe(0);
});
