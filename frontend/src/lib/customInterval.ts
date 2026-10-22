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
 * 图。这里把它挡住是为了不让用户按一个必败的按钮，**不是**对面也这么判。同一把尺
 * 现在也管从 URL／会话读进来的串（`normalizeInterval` 经 `isCustomSpec` 走它），
 * 对话框拒收的跨度，门也不收。两把尺各判一件事（N-1，2026-10-22）：`MAX_COUNT` 只
 * 管**用户手打的那个数**，只有 `validateDraft` 收得到它；折算后的跨度只由下面
 * `durationOk` 那一处拼写判，对话框与门都按它判——串里那个数就已经是跨度。
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

export type SpecUnit = "m" | "D" | "W" | "M";

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
export const BUILTIN_SPECS = new Set(["1m", "5m", "15m", "30m", "60m", "1D", "1W", "1M"]);

const SPEC_RE = /^(\d+)([mDWM])$/;

export function parseSpec(text: string): { unit: SpecUnit; n: number } | null {
  const m = SPEC_RE.exec((text ?? "").trim());
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isInteger(n) || n <= 0) return null; // `0m`／前导零之外的非整数都由正则挡掉
  return { unit: m[2] as SpecUnit, n };
}

/** 折算后的跨度上限——对话框（`validateDraft`，先过 `mintedShape`）与门（`isCustomSpec`，
 *  串里那个数就已经是跨度）共用这一处拼写。N-1（2026-10-22）：两侧各写一遍就会漏出
 *  「对话框发得出、门收不下」的串，那串在会话里被静默退成 `1D`。 */
function durationOk(minted: { unit: SpecUnit; n: number }): boolean {
  return minted.unit === "m" ? minted.n <= MINUTES_PER_DAY : minted.n <= MAX_CALENDAR_MULTIPLE;
}

/** 草案 → 折算后的串形状。`draftToSpec` 用它拼字面量，`validateDraft` 用它判跨度。 */
function mintedShape(draft: { unit: IntervalUnit; n: number }): { unit: SpecUnit; n: number } {
  if (draft.unit === "hour") return { unit: "m", n: draft.n * 60 };
  if (draft.unit === "minute") return { unit: "m", n: draft.n };
  return { unit: draft.unit === "day" ? "D" : draft.unit === "week" ? "W" : "M", n: draft.n };
}

export function isCustomSpec(text: string): boolean {
  // 门侧不委托 `validateDraft`（那是 Task 2 修复轮的写法，N-1 已撤销这枚委托）：
  // 传进来的串里没有「单位」这一层，委托等于把手打数上限 `MAX_COUNT` 套到跨度上，
  // 于是小时档折算出来的 `1020m…1440m` 会「对话框发得出、门收不下」。三步：文法、
  // 非内置、跨度。文法由 `parseSpec` 管（它已拒 `0m` 与坏拼法），跨度只问 `durationOk`。
  const parsed = parseSpec(text);
  if (parsed === null) return false;
  // 「非内置」按折算后的拼写查，不按 raw 查：`parseSpec` 会 trim，拿带空白的 raw 查表
  // 会让 `" 1m"` 绕过内置判定被当成自定义档（撤销委托前的写法经 `draftToSpec` 拼回规范串，
  // 行为就是这样，这里不许顺手放宽）。
  if (BUILTIN_SPECS.has(`${parsed.n}${parsed.unit}`)) return false;
  return durationOk(parsed);
}

export function draftToSpec(draft: { unit: IntervalUnit; n: number }): string {
  const minted = mintedShape(draft);
  return `${minted.n}${minted.unit}`;
}

export function validateDraft(draft: CustomIntervalDraft): { ok: true; spec: string } | { ok: false; reason: string } {
  const n = draft.n;
  if (n === null || Number.isNaN(n)) return { ok: false, reason: "还没有填数值" };
  if (!Number.isInteger(n)) return { ok: false, reason: "数值只能是整数" };
  if (n < 1) return { ok: false, reason: "数值至少是 1" };
  if (n > MAX_COUNT) return { ok: false, reason: `数值最多 ${MAX_COUNT}` };
  // 跨度只判这一次：先折算，再问那唯一一处拼写；原因文案按**折算后的单位**分岔，
  // 不按草案的单位——小时档越界时用户看到的是一句「跨过多于一天」，因为它的跨度就是分钟。
  const minted = mintedShape({ unit: draft.unit, n });
  if (!durationOk(minted)) {
    return {
      ok: false,
      reason: minted.unit === "m" ? "分钟档的一档不能跨过多于一天" : `日／周／月的倍数最多 ${MAX_CALENDAR_MULTIPLE}`,
    };
  }
  const spec = draftToSpec({ unit: draft.unit, n });
  if (BUILTIN_SPECS.has(spec)) return { ok: false, reason: "这一档目录里已经有了（它就是内置档）" };
  return { ok: true, spec };
}

/** 数值框的 `min`／`max` **提示值**，按单位给。它不是判据（判据只有 `validateDraft`
 *  那一处），但它必须由 `MAX_COUNT`／`MINUTES_PER_DAY`／`MAX_CALENDAR_MULTIPLE` 算出来——
 *  那句「与边界同源、不重复写第二遍」在 spec §6 的对话框结构表里，边界本身在 §4。
 *  同界的可观察形状由对话框那枚针钉：`validateDraft({unit, n: max})` 真、`max + 1` 假。 */
export function unitLimits(unit: IntervalUnit): { min: number; max: number } {
  if (unit === "hour") return { min: 1, max: Math.min(MAX_COUNT, Math.floor(MINUTES_PER_DAY / 60)) };
  if (unit === "minute") return { min: 1, max: Math.min(MAX_COUNT, MINUTES_PER_DAY) };
  return { min: 1, max: Math.min(MAX_COUNT, MAX_CALENDAR_MULTIPLE) };
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
