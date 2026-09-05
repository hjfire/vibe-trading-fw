/**
 * Script exchange: the file and link formats for indicator formulas and Pine
 * strategies (local custom ⑪).
 *
 * TradingView itself only shares by URL — there is no export button in the
 * script editor; the source lives on the script page's "原始码" tab. So this
 * project defines its own portable container with three faces:
 *
 *   .pine text   — metadata as `//>` comments above the source, which keeps the
 *                  file valid Pine when pasted straight into TradingView;
 *   JSON bundle  — one file holding many scripts (library backup / transfer);
 *   share link   — `?s=g<base64url>` payload, gzip-compressed when the runtime
 *                  supports it, so a whole strategy fits in one URL.
 *
 * No server and no accounts: everything here is text in, text out.
 */

import { detectDialect, type FormulaDialect } from "./indicatorLang";
import type { PineInput } from "./pineTypes";

/** One shareable script. */
export interface ScriptCard {
  /** Stable local id; regenerated on import when it clashes. */
  id: string;
  /** Which engine runs `code`. */
  dialect: FormulaDialect;
  name: string;
  code: string;
  /** Where the script is drawn: on the candles or in its own pane. */
  display: "overlay" | "pane";
  /** Parameter values, positional, matching `inputs` order. */
  params: number[];
  /** Declared inputs (Pine only), so the receiving end gets a real form. */
  inputs?: PineInput[];
  category?: string;
  description?: string;
  /** Provenance, e.g. the TradingView script page it was copied from. */
  origin?: string;
}

export interface ScriptBundle {
  format: "vibe-trading.scripts";
  version: 1;
  items: ScriptCard[];
}

const FILE_TAG = "//>";

/* ------------------------------------------------------------------ .pine */

/** Metadata header as comments + the untouched source. */
export function toPineFile(card: ScriptCard): string {
  const head = [
    `${FILE_TAG} name: ${card.name}`,
    `${FILE_TAG} dialect: ${card.dialect}`,
    `${FILE_TAG} display: ${card.display}`,
  ];
  if (card.params.length) head.push(`${FILE_TAG} params: ${card.params.join(",")}`);
  if (card.category) head.push(`${FILE_TAG} category: ${card.category}`);
  if (card.description) head.push(`${FILE_TAG} desc: ${card.description}`);
  if (card.origin) head.push(`${FILE_TAG} origin: ${card.origin}`);
  return `${head.join("\n")}\n\n${card.code.trim()}\n`;
}

/** Read a `toPineFile` document, or any bare .pine/.txt source. */
export function fromPineFile(text: string, fallbackName = "导入的脚本"): ScriptCard {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const meta = new Map<string, string>();
  let i = 0;
  // Only the leading `//>` block belongs to us: a script's own //@version pragma
  // and comments have to survive so the source still compiles on TradingView.
  for (; i < lines.length; i++) {
    const hit = /^\/\/\s*>\s*([A-Za-z_]+)\s*:\s*(.*)$/.exec(lines[i].trim());
    if (!hit) break;
    meta.set(hit[1].toLowerCase(), hit[2].trim());
  }
  const code = lines.slice(i).join("\n").trim();
  const dialect = pickDialect(meta.get("dialect"), code);
  return {
    id: newScriptId(),
    dialect,
    name: meta.get("name") || declaredTitle(code) || fallbackName,
    code,
    // An explicit header wins; otherwise a Pine script defaults to the candles.
    display: pickDisplay(meta.get("display"), dialect),
    params: numberList(meta.get("params")),
    category: meta.get("category") || undefined,
    description: meta.get("desc") || undefined,
    origin: meta.get("origin") || undefined,
  };
}

/* ------------------------------------------------------------------- JSON */

export function toBundle(items: ScriptCard[]): string {
  const bundle: ScriptBundle = { format: "vibe-trading.scripts", version: 1, items };
  return JSON.stringify(bundle, null, 2);
}

export interface ImportReport {
  cards: ScriptCard[];
  /** One line per rejected entry, so nothing fails silently. */
  errors: string[];
}

/** Accepts a bundle, a bare array, or a single card. */
export function fromBundleJson(raw: string): ImportReport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { cards: [], errors: [`不是合法的 JSON：${e instanceof Error ? e.message : String(e)}`] };
  }
  const list = Array.isArray(parsed)
    ? parsed
    : isBundle(parsed)
      ? parsed.items
      : [parsed];
  const cards: ScriptCard[] = [];
  const errors: string[] = [];
  list.forEach((entry, n) => {
    const card = readCard(entry, n);
    if (!card) errors.push(`第 ${n + 1} 条：缺少 code 字段或格式不对`);
    else cards.push(card);
  });
  if (!cards.length && !errors.length) errors.push("文件里没有可导入的脚本");
  return { cards, errors };
}

function isBundle(v: unknown): v is ScriptBundle {
  return (
    !!v &&
    typeof v === "object" &&
    (v as ScriptBundle).format === "vibe-trading.scripts" &&
    Array.isArray((v as ScriptBundle).items)
  );
}

function pickDialect(declared: string | null | undefined, code: string): FormulaDialect {
  return declared === "vector" || declared === "pine" ? declared : detectDialect(code);
}

/** The title inside `indicator("...")` / `strategy("...")`, when present. */
function declaredTitle(code: string): string {
  const hit = /^\s*(?:indicator|study|strategy)\s*\(\s*(?:title\s*=\s*)?["']([^"']+)["']/m.exec(code);
  return hit ? hit[1].trim() : "";
}

function pickDisplay(declared: string | undefined | null, dialect: FormulaDialect): ScriptCard["display"] {
  if (declared === "overlay" || declared === "pane") return declared;
  return dialect === "pine" ? "overlay" : "pane";
}

function readCard(entry: unknown, n: number): ScriptCard | null {
  if (!entry || typeof entry !== "object") return null;
  const o = entry as Partial<ScriptCard>;
  if (typeof o.code !== "string" || !o.code.trim()) return null;
  const dialect: FormulaDialect = pickDialect(o.dialect, o.code);
  return {
    id: typeof o.id === "string" && o.id ? o.id : newScriptId(),
    dialect,
    name: typeof o.name === "string" && o.name.trim() ? o.name.trim() : `脚本 ${n + 1}`,
    code: o.code,
    display: pickDisplay(o.display, dialect),
    params: Array.isArray(o.params) ? o.params.map(Number).filter(Number.isFinite) : [],
    inputs: Array.isArray(o.inputs) ? (o.inputs as PineInput[]) : undefined,
    category: typeof o.category === "string" ? o.category : undefined,
    description: typeof o.description === "string" ? o.description : undefined,
    origin: typeof o.origin === "string" ? o.origin : undefined,
  };
}

/** Parse whatever the user dropped in the import box. */
export function importAny(text: string, filename = ""): ImportReport {
  const trimmed = text.trim();
  if (!trimmed) return { cards: [], errors: ["内容是空的"] };
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return fromBundleJson(trimmed);
  const single = fromPineFile(text, filename.replace(/\.[^.]+$/, "") || undefined);
  if (!hasBody(single.code)) return { cards: [], errors: ["文件里没有脚本正文"] };
  if (!looksLikeScript(single.code)) {
    return { cards: [], errors: ["内容看起来不是脚本代码：没有标识符或运算符"] };
  }
  return { cards: [single], errors: [] };
}

/** Source that is only comments/blank lines cannot run. */
function hasBody(code: string): boolean {
  return code.split("\n").some((line) => {
    const t = line.trim();
    return t !== "" && !t.startsWith("//");
  });
}

/**
 * Both languages are ASCII, so prose pasted by accident has neither
 * identifiers nor operators. Caught here instead of at save time.
 */
function looksLikeScript(code: string): boolean {
  return /[A-Za-z_][A-Za-z0-9_]{2,}/.test(code) && /[(){}\[\];=<>!+*/%]/.test(code);
}

/** An empty `//> params:` header must stay empty: Number("") would give [0]. */
function numberList(text: string | null | undefined): number[] {
  return (text ?? "")
    .split(/[,，\s]+/)
    .map((x) => x.trim())
    .filter((x) => x !== "")
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x));
}

/* ------------------------------------------------------------ share links */

/** Payload marker: `g` = gzip + base64url, `j` = plain JSON + base64url. */
type Codec = "g" | "j";

/** Query parameter a share link is carried in; the reader must use the same. */
export const SHARE_QUERY_KEY = "s";

/** Above this the link stops fitting the usual browser/URL comfort limit. */
export const SHARE_LINK_SOFT_LIMIT = 1900;

export interface ShareLink {
  url: string;
  /** Characters in `url`; long scripts may exceed what some clients accept. */
  length: number;
  /** True when the link is longer than the safe-by-everywhere length. */
  verbose: boolean;
  codec: Codec;
}

/** Encode one script into a URL that reopens the workbench with it loaded. */
export async function createShareLink(
  card: ScriptCard,
  base = `${window.location.origin}${window.location.pathname}`,
): Promise<ShareLink> {
  const json = JSON.stringify({ v: 1, c: slim(card) });
  const compressed = await gzipString(json);
  let codec: Codec = "j";
  let bytes: Uint8Array = utf8(json);
  if (compressed) {
    codec = "g";
    bytes = compressed;
  }
  const payload = `${codec}${base64Url(bytes)}`;
  const url = `${base.split("#")[0].replace(/\?.*$/, "")}?${SHARE_QUERY_KEY}=${payload}`;
  return { url, length: url.length, verbose: url.length > SHARE_LINK_SOFT_LIMIT, codec };
}

export interface DecodedShare {
  card: ScriptCard;
  ok: true;
}

export interface FailedShare {
  ok: false;
  error: string;
}

/** Read a share URL, a bare query string, or just the payload. */
export async function readShareLink(input: string): Promise<DecodedShare | FailedShare> {
  const payload = extractPayload(input);
  if (!payload) return { ok: false, error: "链接里没有分享码" };
  const codec = payload[0];
  if (codec !== "g" && codec !== "j") return { ok: false, error: "无法识别的分享码前缀" };
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(payload.slice(1));
  } catch {
    return { ok: false, error: "分享码不是合法的 base64" };
  }
  let json = "";
  try {
    json = codec === "g" ? await gunzipString(bytes) : new TextDecoder().decode(bytes);
  } catch (e) {
    return { ok: false, error: `解分享码失败：${e instanceof Error ? e.message : String(e)}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: "分享码内容不是合法 JSON" };
  }
  const card = readCard((parsed as { c?: unknown })?.c ?? parsed, 0);
  if (!card) return { ok: false, error: "分享码里没有可运行的脚本" };
  return { card, ok: true };
}

function extractPayload(input: string): string {
  const direct = input.trim();
  if (/^[gj][A-Za-z0-9_-]+$/.test(direct)) return direct;
  const hit = /[?&#]s=([^&#\s]+)/.exec(direct);
  return hit ? decodeURIComponent(hit[1]) : "";
}

/** Drop fields the receiving end can recompute, to keep the link short. */
function slim(card: ScriptCard): ScriptCard {
  const out: ScriptCard = {
    // Empty id: the receiving end must mint its own, or two shared scripts collide.
    id: "",
    dialect: card.dialect,
    name: card.name,
    code: card.code.trim(),
    display: card.display,
    params: card.params,
  };
  const opts = (card.inputs ?? []).map((i) => ({ varName: i.varName, label: i.label, kind: i.kind, def: i.def, min: i.min, max: i.max, step: i.step }));
  if (opts.length) out.inputs = opts as PineInput[];
  if (card.category) out.category = card.category;
  if (card.description) out.description = card.description;
  if (card.origin) out.origin = card.origin;
  return out;
}

/* --------------------------------------------------------------- byte utils */

export function newScriptId(): string {
  return `s${Date.now().toString(36)}${Math.floor(Math.random() * 1e4).toString(36)}`;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function base64Url(bytes: Uint8Array): string {
  let out = "";
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    let str = "";
    for (const b of bytes.subarray(i, i + CHUNK)) str += String.fromCharCode(b);
    out += btoa(str);
  }
  return out.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(text: string): Uint8Array {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

type StreamConstructor = new (format: string) => {
  writable: WritableStream<Uint8Array>;
  readable: ReadableStream<Uint8Array>;
};

function compressor(kind: "compress" | "decompress"): StreamConstructor | null {
  const host = globalThis as unknown as Record<string, unknown>;
  const ctor = (kind === "compress" ? host.CompressionStream : host.DecompressionStream) as
    | StreamConstructor
    | undefined;
  return typeof ctor === "function" ? ctor : null;
}

/** Whether this runtime can gzip, i.e. whether share links will be short. */
export function gzipSupported(): boolean {
  return compressor("compress") !== null && compressor("decompress") !== null;
}

function streamFrom(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const bytes = value instanceof Uint8Array ? value : new Uint8Array(value as ArrayBufferLike);
    chunks.push(bytes);
    total += bytes.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function pipe(bytes: Uint8Array, Ctor: StreamConstructor): ReadableStream<Uint8Array> {
  const src = streamFrom(bytes) as unknown as { pipeThrough(x: unknown): ReadableStream<Uint8Array> };
  return src.pipeThrough(new Ctor("gzip"));
}

async function gzipString(text: string): Promise<Uint8Array | null> {
  const Ctor = compressor("compress");
  if (!Ctor) return null;
  try {
    return await readAll(pipe(utf8(text), Ctor));
  } catch {
    return null; // old engine without CompressionStream: fall back to plain JSON links
  }
}

async function gunzipString(bytes: Uint8Array): Promise<string> {
  const Ctor = compressor("decompress");
  if (!Ctor) throw new Error("当前环境不支持 gzip，请改用文件导入");
  return new TextDecoder().decode(await readAll(pipe(bytes, Ctor)));
}
