import { useRef, useState } from "react";
import { createShareLink, importAny, readShareLink, toBundle, toPineFile, type ScriptCard } from "@/lib/scriptExchange";
import { copyText, downloadText, draftToCard, indicatorToCard, slugFilename, type Draft } from "./types";
import type { UserIndicator } from "@/lib/indicatorStore";

/**
 * Import / export / share (local custom ⑪).
 *
 * TradingView shares by URL only, so the workbench offers all three containers:
 * a `.pine` file that still compiles when pasted back into TradingView, a JSON
 * bundle for backing up the whole list, and a gzip-compressed share link.
 */

interface ExchangeTabProps {
  draft: Draft;
  items: UserIndicator[];
  /** Drop an imported script into the editor. */
  onLoad: (card: ScriptCard) => void;
  /** Install imported scripts; returns an error string when nothing stuck. */
  onImport: (cards: ScriptCard[]) => string | null;
  /** Feedback lives in the shell: importing switches tabs and would wipe local state. */
  say: (lines: string[], bad?: boolean) => void;
}

/** A link that came from this app, in any of its three written forms. */
function looksLikeShareLink(text: string): boolean {
  const t = text.trim();
  return /^[gj][A-Za-z0-9_-]{8,}$/.test(t) || /[?&#]s=[^&#\s]+/.test(t);
}

export default function ExchangeTab({ draft, items, onLoad, onImport, say }: ExchangeTabProps) {
  const [text, setText] = useState("");
  const [shareUrl, setShareUrl] = useState("");
  const [shareNote, setShareNote] = useState("");
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement | null>(null);

  const card = draftToCard(draft);

  const exportPine = () => {
    const body = toPineFile(card);
    if (downloadText(`${slugFilename(card.name)}.pine`, body)) {
      say([`已导出 ${slugFilename(card.name)}.pine（${body.length} 字符），可直接贴回 TradingView`]);
    } else {
      say(["浏览器拦住了下载，请改用「复制文本」"], true);
    }
  };

  const exportAll = () => {
    if (!items.length) {
      say(["我的指标是空的，没有可导出的内容"], true);
      return;
    }
    const body = toBundle(items.map(indicatorToCard));
    if (downloadText("vibe-scripts.json", body, "application/json")) {
      say([`已导出 ${items.length} 个脚本到 vibe-scripts.json`]);
    } else {
      say(["浏览器拦住了下载"], true);
    }
  };

  const makeShareLink = async () => {
    setBusy(true);
    try {
      const link = await createShareLink(card);
      setShareUrl(link.url);
      setShareNote(
        link.verbose
          ? `链接 ${link.length} 字符，偏长：部分聊天工具会折行截断，建议改用 .pine 文件`
          : `链接 ${link.length} 字符（${link.codec === "g" ? "gzip 压缩" : "明文 JSON"}）`,
      );
      const copied = await copyText(link.url);
      say(copied ? ["分享链接已复制到剪贴板"] : ["复制失败，请手动选中下方链接复制"]);
    } catch (e) {
      say([`生成分享链接失败：${e instanceof Error ? e.message : String(e)}`], true);
    } finally {
      setBusy(false);
    }
  };

  const runImport = async (raw: string, filename = "") => {
    const trimmed = raw.trim();
    if (!trimmed) {
      say(["先粘贴内容，或选择文件"], true);
      return;
    }
    if (looksLikeShareLink(trimmed)) {
      const out = await readShareLink(trimmed);
      if (!out.ok) {
        say([out.error], true);
        return;
      }
      onLoad(out.card);
      say([`已从分享链接载入「${out.card.name}」，确认无误后保存即可`]);
      return;
    }
    const report = importAny(trimmed, filename);
    if (!report.cards.length) {
      say(report.errors.length ? report.errors : ["没有识别到脚本"], true);
      return;
    }
    if (report.cards.length === 1 && !report.errors.length) {
      // A single script goes to the editor first: mounting unreviewed source
      // straight onto the chart is how people get surprised by their own paste.
      onLoad(report.cards[0]);
      say([`已载入「${report.cards[0].name}」到编辑器，检查后保存即可上图`]);
      return;
    }
    const err = onImport(report.cards);
    say(
      [
        `导入 ${report.cards.length} 个脚本${err ? `（安装失败：${err}）` : "并已挂载"}`,
        ...report.errors.map((x) => `跳过：${x}`),
      ],
      Boolean(err),
    );
  };

  const pickFiles = async (files: FileList | null) => {
    if (!files || !files.length) return;
    const chunks: string[] = [];
    const names: string[] = [];
    for (const f of Array.from(files)) {
      try {
        chunks.push(await f.text());
        names.push(f.name);
      } catch {
        /* unreadable file: reported through the empty-result path below */
      }
    }
    setText(chunks.join("\n\n"));
    const report = chunks.map((c, i) => importAny(c, names[i]));
    const cards = report.flatMap((r) => r.cards);
    const errors = report.flatMap((r) => r.errors);
    if (!cards.length) {
      say(errors.length ? errors : ["文件里没有可导入的脚本"], true);
      return;
    }
    if (cards.length === 1 && names.length === 1) {
      onLoad(cards[0]);
      say([`已从 ${names[0]} 载入「${cards[0].name}」到编辑器`]);
      return;
    }
    const err = onImport(cards);
    const lines = [`从 ${names.length} 个文件导入 ${cards.length} 个脚本${err ? `（安装失败：${err}）` : ""}`];
    for (const x of errors) lines.push(`跳过：${x}`);
    say(lines, Boolean(err));
  };

  return (
    <div className="space-y-4 text-sm">
      <section className="space-y-2 rounded-lg border p-2.5">
        <h3 className="text-xs font-semibold text-muted-foreground">导出当前脚本</h3>
        <p className="text-[11px] leading-4 text-muted-foreground">
          导出内容 = 编辑器里的代码与参数。文件名取自脚本名称。
        </p>
        <div className="flex flex-wrap gap-1.5">
          <button type="button" onClick={exportPine} className="rounded border px-2 py-1 text-[11px] hover:bg-muted">
            下载 .pine
          </button>
          <button
            type="button"
            onClick={async () => {
              const copied = await copyText(toPineFile(card));
              say(copied ? ["脚本已复制到剪贴板"] : ["复制失败，请手动全选下方导入框内容"], !copied);
            }}
            className="rounded border px-2 py-1 text-[11px] hover:bg-muted"
          >
            复制文本
          </button>
          <button type="button" onClick={makeShareLink} disabled={busy} className="rounded border px-2 py-1 text-[11px] hover:bg-muted disabled:opacity-50">
            生成分享链接
          </button>
          <button type="button" onClick={exportAll} className="rounded border px-2 py-1 text-[11px] hover:bg-muted">
            导出我的全部（JSON）
          </button>
        </div>
        {shareUrl && (
          <div className="space-y-1">
            <input
              readOnly
              value={shareUrl}
              onFocus={(e) => e.currentTarget.select()}
              className="h-7 w-full rounded border bg-background px-2 font-mono text-[10px] outline-none"
            />
            <p className="text-[11px] text-muted-foreground">{shareNote}</p>
          </div>
        )}
      </section>

      <section className="space-y-2 rounded-lg border p-2.5">
        <h3 className="text-xs font-semibold text-muted-foreground">导入脚本</h3>
        <p className="text-[11px] leading-4 text-muted-foreground">
          支持三种来源：从 TradingView 脚本页复制的原始码、本工具导出的 .pine / JSON、以及分享链接。
        </p>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          spellCheck={false}
          rows={7}
          placeholder={"粘贴 .pine 源码、JSON 脚本包或分享链接…"}
          className="w-full resize-y rounded border bg-background p-2 font-mono text-[11px] leading-4 outline-none focus:border-primary"
        />
        <div className="flex flex-wrap gap-1.5">
          <button
            type="button"
            onClick={() => void runImport(text)}
            className="rounded bg-primary px-2.5 py-1 text-[11px] font-medium text-primary-foreground hover:opacity-90"
          >
            导入
          </button>
          <button type="button" onClick={() => fileRef.current?.click()} className="rounded border px-2.5 py-1 text-[11px] hover:bg-muted">
            选择文件…
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".pine,.txt,.json"
            multiple
            className="hidden"
            onChange={(e) => {
              void pickFiles(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      </section>
    </div>
  );
}
