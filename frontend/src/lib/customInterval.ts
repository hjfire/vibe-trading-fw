/**
 * 自定义周期档的文法与换算——前端唯一持有这把尺的地方。
 *
 * 文法不是这里发明的：它是服务端 `agent/src/api/interval_spec.py` 的 `_FOLDED_RE`
 * （`^(\d+)([mDWM])$`）加内置八档。两侧对账由两份逐字同表的测试钉住（本文件那条
 * 与 `agent/tests/test_interval_spec_frontend_align.py`），共享夹具是假的对齐，
 * 所以谁也不 import 谁。
 *
 * 边界（`1..999`、分钟侧封顶一天、日历侧封顶一年）是本仓自己的规则：服务端对 `k`
 * 不设上限，只按 `_MAX_BARS` 少返，一个 `500m` 名义合法却只会拿到远少于请求根数的
 * 图。这里把它挡住是为了不让用户按一个必败的按钮，**不是**对面也这么判。
 */

export type IntervalUnit = "minute" | "hour" | "day" | "week" | "month";

export const CUSTOM_UNITS: readonly { unit: IntervalUnit; label: string }[] = [
  { unit: "minute", label: "分钟" },
  { unit: "hour", label: "小时" },
  { unit: "day", label: "日" },
  { unit: "week", label: "周" },
  { unit: "month", label: "月" },
];

export type CustomIntervalDraft = { unit: IntervalUnit; n: number | null };

type SpecUnit = "m" | "D" | "W" | "M";

const MAX_COUNT = 999;
const MINUTES_PER_DAY = 1440;
const MAX_CALENDAR_MULTIPLE = 366;
const MINUTE_MS = 60_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;
/** 月＝30 日，沿用 `marketApi.ts` 的 `INTERVAL_MS` 口径。服务端折叠用的是
 *  `MONTH_SECONDS = 31 日`，那是为「少返」故意取宽的近似，两处用途不同；
 *  统一它会改掉既有分页行为，所以这里保留差异并让它互相指认。 */
const MONTH_MS = 30 * DAY_MS;

/** 只有内置八档的拼写会走表；自定义串的推导全在 `parseSpec`／`draftToSpec`。 */
const BUILTIN_SPECS = new Set(["1m", "5m", "15m", "30m", "60m", "1D", "1W", "1M"]);

const SPEC_RE = /^(\d+)([mDWM])$/;

export function parseSpec(text: string): { unit: SpecUnit; n: number } | null {
  const m = SPEC_RE.exec((text ?? "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n <= 0) return null; // `0m`／前导零之外的非整数都由正则挡掉
  return { unit: m[2] as SpecUnit, n };
}

export function isCustomSpec(text: string): boolean {
  const parsed = parseSpec(text);
  return parsed !== null && !BUILTIN_SPECS.has(`${parsed.n}${parsed.unit}`);
}

export function draftToSpec(draft: { unit: IntervalUnit; n: number }): string {
  if (draft.unit === "hour") return `${draft.n * 60}m`;
  if (draft.unit === "minute") return `${draft.n}m`;
  const unit: SpecUnit = draft.unit === "day" ? "D" : draft.unit === "week" ? "W" : "M";
  return `${draft.n}${unit}`;
}

export function validateDraft(draft: CustomIntervalDraft): { ok: true; spec: string } | { ok: false; reason: string } {
  const n = draft.n;
  if (n === null || Number.isNaN(n)) return { ok: false, reason: "还没有填数值" };
  if (!Number.isInteger(n)) return { ok: false, reason: "数值只能是整数" };
  if (n < 1) return { ok: false, reason: "数值至少是 1" };
  if (n > MAX_COUNT) return { ok: false, reason: `数值最多 ${MAX_COUNT}` };
  const minutes = draft.unit === "hour" ? n * 60 : draft.unit === "minute" ? n : 0;
  if (minutes > MINUTES_PER_DAY) return { ok: false, reason: "分钟档的一档不能跨过多于一天" };
  if (draft.unit !== "minute" && draft.unit !== "hour" && n > MAX_CALENDAR_MULTIPLE) {
    return { ok: false, reason: `日／周／月的倍数最多 ${MAX_CALENDAR_MULTIPLE}` };
  }
  const spec = draftToSpec({ unit: draft.unit, n });
  if (BUILTIN_SPECS.has(spec)) return { ok: false, reason: "这一档目录里已经有了（它就是内置档）" };
  return { ok: true, spec };
}

export function specLabel(text: string): string | null {
  const parsed = parseSpec(text);
  if (!parsed) return null;
  if (parsed.unit !== "m") {
    const unit = parsed.unit === "D" ? "日" : parsed.unit === "W" ? "周" : "月";
    return `${parsed.n}${unit}`;
  }
  if (parsed.n >= 60 && parsed.n % 60 === 0) return `${parsed.n / 60}小时`;
  return `${parsed.n}分`;
}

export function specMs(text: string): number | null {
  const parsed = parseSpec(text);
  if (!parsed) return null;
  if (parsed.unit === "m") return parsed.n * MINUTE_MS;
  if (parsed.unit === "D") return parsed.n * DAY_MS;
  if (parsed.unit === "W") return parsed.n * WEEK_MS;
  return parsed.n * MONTH_MS;
}

export function specPeriodShape(text: string): { type: "minute" | "day" | "week" | "month"; span: number } | null {
  const parsed = parseSpec(text);
  if (!parsed) return null;
  const type = parsed.unit === "m" ? "minute" : parsed.unit === "D" ? "day" : parsed.unit === "W" ? "week" : "month";
  return { type, span: parsed.n };
}
