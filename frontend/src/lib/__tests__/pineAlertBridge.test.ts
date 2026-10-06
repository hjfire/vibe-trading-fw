import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { KLineData } from "klinecharts";
import { compilePine } from "../pineScript";
import { translatePineAlerts } from "../pineAlertRules";

/**
 * Reconciliation fixtures. The expectation is NOT hand-written: it is the
 * frontend Pine interpreter's own per-bar verdict (`PineResult.alerts`), and the
 * Python leg (`agent/tests/test_alerts_pine_reconciliation.py`) recomputes the
 * translated condition bar prefix by prefix with the backend's own
 * `evaluate_condition`. Two independent implementations must agree on all 400
 * prefixes, or the bridge is a coincidence.
 *
 * `minPrefix` is the transient gate, not a "backend needs N bars" floor: the two
 * sides seed EMA/RSI differently (frontend RMA seeds with an SMA over the first
 * n bars, backend `ewm` defaults to `adjust=True`), so the leading bars are
 * legitimately transient. Only from `minPrefix` on must the verdicts match.
 *
 * Fixtures are generated, but this file never writes into the repository:
 * regenerating needs `PINE_ALERT_FIXTURE_OUT` pointing at a directory OUTSIDE the
 * repo, and the JSON is then copied in by hand. A default CI run is read-only.
 */

// `__dirname`, not `import.meta.url`: this suite runs under the config's jsdom
// environment, where vitest rewrites import.meta.url to an http URL (see
// pineOracleFixtures.ts).
const DIR = resolve(__dirname, "__fixtures__/pineAlertBridge");
const OUT = process.env.PINE_ALERT_FIXTURE_OUT ?? "";
if (OUT && DIR.startsWith(resolve(OUT))) {
  throw new Error("PINE_ALERT_FIXTURE_OUT 必须指向仓库外的目录，否则跑测试就是在改被跟踪文件");
}

/** Deterministic random walk: mixed up/down days, so no one-sided RSI segment. */
function walk(seed: number, n: number): KLineData[] {
  let s = seed >>> 0;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  let close = 100;
  const out: KLineData[] = [];
  for (let i = 0; i < n; i++) {
    close = Math.max(1, close * (1 + (rnd() - 0.48) * 0.02));
    const open = close * (1 + (rnd() - 0.5) * 0.004);
    out.push({
      timestamp: 1_700_000_000_000 + i * 86_400_000,
      open,
      high: Math.max(open, close) * 1.004,
      low: Math.min(open, close) * 0.996,
      close,
      volume: 1e5 * (1 + rnd()),
    } as KLineData);
  }
  return out;
}

interface Case {
  name: string;
  seed: number;
  minPrefix: number;
  code: string;
}

const CASES: Case[] = [
  {
    name: "ema-cross-up",
    seed: 20261006,
    minPrefix: 120,
    code: '//@version=5\nindicator("对账-EMA")\nalertcondition(ta.crossover(ta.ema(close,5), ta.ema(close,20)), "EMA金叉", "")',
  },
  {
    name: "ema-cross-down",
    seed: 777001,
    minPrefix: 120,
    code: '//@version=5\nindicator("对账-EMA2")\nalertcondition(ta.crossunder(ta.ema(close,9), ta.ema(close,21)), "EMA死叉", "")',
  },
  {
    name: "rsi-under-30",
    seed: 4242,
    minPrefix: 120,
    code: '//@version=5\nindicator("对账-RSI")\nalertcondition(ta.rsi(close, 14) < 30, "RSI超卖", "")',
  },
  {
    name: "close-under-sma",
    seed: 90210,
    minPrefix: 120,
    code: '//@version=5\nindicator("对账-SMA")\nalertcondition(close < ta.sma(close, 20), "跌破均线", "")',
  },
  {
    name: "volume-rising",
    seed: 13579,
    minPrefix: 120,
    code: '//@version=5\nindicator("对账-VOL")\nalertcondition(volume > volume[1], "放量", "")',
  },
];

/** Run one case and assemble its fixture, gating on non-vacuous expectations. */
function build(c: Case): string {
  const bars = walk(c.seed, 400);
  const out = compilePine(c.code, bars, { opLimit: 6e7 });
  if ("error" in out) throw new Error(`${c.name}: 脚本编译失败 ${out.error}`);
  if (out.abort) throw new Error(`${c.name}: 脚本中断 ${out.abort}`);
  const plans = translatePineAlerts(c.code, { symbol: "BRIDGE.TEST", interval: "1D" });
  if (plans.length !== 1) throw new Error(`${c.name}: 翻译器给出 ${plans.length} 条，应为 1 条`);
  if (plans[0].status !== "native") {
    throw new Error(`${c.name}: 翻译器不认这条条件 —— ${plans[0].reason}`);
  }
  const series = out.result.alerts?.[0];
  if (!series) throw new Error(`${c.name}: 引擎没有产出 alerts`);
  if (series.hits.length !== bars.length) {
    throw new Error(`${c.name}: hits 长度 ${series.hits.length} !== bars 长度 ${bars.length}`);
  }
  // Three anti-vacuity gates: an all-false series would let the Python leg pass
  // by doing nothing, an all-true one likewise, and a signal that only appears
  // inside the transient window would never be compared at all.
  if (!series.hits.some((h) => h)) throw new Error(`${c.name}: 期望序列全 false，对账会 trivially 通过`);
  if (!series.hits.some((h) => !h)) throw new Error(`${c.name}: 期望序列全 true，同样没有信息`);
  if (!series.hits.slice(c.minPrefix).some((h) => h)) {
    throw new Error(`${c.name}: minPrefix(${c.minPrefix}) 之后一次都没命中，比较区间里没有信号`);
  }
  return JSON.stringify(
    {
      name: c.name,
      seed: c.seed,
      code: c.code,
      interval: "1D",
      bars: bars.map((b) => ({
        timestamp: b.timestamp,
        open: b.open,
        high: b.high,
        low: b.low,
        close: b.close,
        volume: b.volume,
      })),
      cases: [{ condition: plans[0].condition, pineHits: series.hits, minPrefix: c.minPrefix }],
    },
    null,
    1,
  );
}

if (OUT) {
  it("PINE_ALERT_FIXTURE_OUT 生成夹具（只写仓库外目录）", () => {
    for (const c of CASES) {
      const json = build(c);
      writeFileSync(`${OUT.replace(/[/\\]$/, "")}/${c.name}.json`, json, "utf8");
      process.stdout.write(`emit ${c.name}.json ${json.length} bytes\n`);
    }
  });
}

if (!OUT) {
  describe("对账夹具（TS 腿）", () => {
    it("夹具目录非空——读不到就抛，不许 skip", () => {
      if (!existsSync(DIR)) throw new Error(`夹具目录不存在：${DIR}`);
      const files = readdirSync(DIR).filter((f) => f.endsWith(".json"));
      if (files.length < CASES.length) {
        throw new Error(`夹具只有 ${files.length} 份，少于 ${CASES.length} 条`);
      }
    });

    for (const c of CASES) {
      it(`${c.name}：引擎逐根序列 === 夹具 pineHits`, () => {
        const fx = JSON.parse(readFileSync(`${DIR}/${c.name}.json`, "utf8"));
        expect(fx.bars.length, "bars 与 pineHits 必须等长").toBe(fx.cases[0].pineHits.length);
        expect(fx.bars.length).toBe(400);
        const rows = fx.bars as KLineData[];
        const out = compilePine(fx.code, rows, { opLimit: 6e7 });
        if ("error" in out) throw new Error(`编译失败：${out.error}`);
        if (out.abort) throw new Error(`脚本中断：${out.abort}`);
        const hits = out.result.alerts?.[0]?.hits;
        if (!hits) throw new Error("引擎没有产出 alerts");
        expect(hits).toEqual(fx.cases[0].pineHits);
        // The translator's output today must still be the condition in the
        // fixture: each fixture is also a snapshot of the translator.
        const plan = translatePineAlerts(fx.code, { symbol: "BRIDGE.TEST", interval: fx.interval })[0];
        expect(plan.status).toBe("native");
        expect(plan.condition).toEqual(fx.cases[0].condition);
        expect(fx.cases[0].minPrefix).toBeGreaterThanOrEqual(100);
        expect(fx.cases[0].pineHits.slice(fx.cases[0].minPrefix).some((h: boolean) => h)).toBe(true);
      });
    }
  });
}
