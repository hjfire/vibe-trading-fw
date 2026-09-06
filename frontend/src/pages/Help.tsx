import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { cn } from "@/lib/utils";

/**
 * In-app usage manual (local custom 24).
 *
 * The prose lives in `frontend/public/usage-guide.md`, which Vite serves at the
 * origin root in dev *and* copies into `dist/` for the `:8000` build -- so the
 * document can be edited without a rebuild, and read straight from an editor or
 * GitHub as the same file. It is fetched with a plain relative `fetch` because
 * the enforced CSP is `script-src 'self'` (no injected script, no external
 * host), and it is rendered by the same markdown plugin set the chat bubbles
 * use, so tables and fenced code behave identically everywhere in the app.
 *
 * Two things this page owns that the markdown file cannot:
 *  - heading ids, and
 *  - the chapter list built from the raw text.
 * Both are derived from the *same* `slugifyHeading`, which is the only thing
 * keeping the nav honest: compute them independently and the links silently go
 * nowhere. `Help.test.tsx` asserts every generated href resolves to a rendered
 * id, so the derivation cannot drift.
 */

const GUIDE_URL = "/usage-guide.md";
const GUIDE_SOURCE = "frontend/public/usage-guide.md";

type TocEntry = { level: number; text: string; id: string };

/**
 * Turn heading text into an anchor id.
 *
 * The rule is GitHub's, so the same heading is reachable by an anchor whether
 * you are reading the rendered app or the raw file on the hosting site: fold
 * whitespace, lowercase, drop everything that is not a letter, a number, `_`,
 * `.` or `-` (which removes the CJK punctuation this manual is full of, plus the
 * slashes route names are written with), then turn the *remaining* spaces into
 * dashes. Stripping punctuation before the spaces are converted is the order
 * that matters -- the other way round glues `15` onto `专业图表` and the nav links
 * land nowhere.
 */
export function slugifyHeading(text: string): string {
  return text
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_.\- ]+/gu, "")
    .replace(/ /g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Flatten rendered heading children back to plain text (code spans included). */
function nodeText(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  const props = (node as { props?: { children?: ReactNode } }).props;
  return props?.children != null ? nodeText(props.children) : "";
}

/**
 * Read `##` / `###` headings out of the raw markdown.
 *
 * Fences are tracked because a `#` line inside a code sample is documentation,
 * not a chapter -- the manual shows formula and prompt snippets that would
 * otherwise inject phantom nav rows.
 */
export function extractToc(markdown: string): TocEntry[] {
  const out: TocEntry[] = [];
  let inFence = false;
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = /^(#{2,3})\s+(.*)$/.exec(line);
    if (!match) continue;
    const text = match[2].replace(/`/g, "").trim();
    out.push({ level: match[1].length, text, id: slugifyHeading(text) });
  }
  return out;
}

function Heading({ level, children }: { level: number; children?: ReactNode }) {
  const id = slugifyHeading(nodeText(children));
  const className = "scroll-mt-20";
  const Tag = `h${Math.min(Math.max(level, 1), 6)}` as "h1";
  return <Tag id={id} className={className}>{children}</Tag>;
}

const markdownComponents = {
  h1: ({ children }: { children?: ReactNode }) => <Heading level={1}>{children}</Heading>,
  h2: ({ children }: { children?: ReactNode }) => <Heading level={2}>{children}</Heading>,
  h3: ({ children }: { children?: ReactNode }) => <Heading level={3}>{children}</Heading>,
  h4: ({ children }: { children?: ReactNode }) => <Heading level={4}>{children}</Heading>,
  // Route the in-document links through the browser rather than the router: a
  // bare `#anchor` is same-page scrolling, not a navigation.
  a: ({ href, children }: { href?: string; children?: ReactNode }) => (
    <a href={href} target={href?.startsWith("http") ? "_blank" : undefined} rel="noreferrer">
      {children}
    </a>
  ),
};

const PROSE =
  "prose dark:prose-invert max-w-none text-[15px] leading-relaxed " +
  "prose-p:leading-[1.8] prose-headings:font-semibold prose-code:font-mono " +
  "prose-table:font-sans prose-th:bg-muted/30 prose-th:px-3 prose-th:py-1.5 " +
  "prose-td:px-3 prose-td:py-1.5 prose-th:text-left prose-blockquote:font-sans " +
  "prose-blockquote:border-l-2 prose-blockquote:border-primary/40 " +
  "prose-a:text-primary [&_pre]:overflow-x-auto";

function TocList({
  toc,
  onNavigate,
}: {
  toc: TocEntry[];
  onNavigate?: () => void;
}) {
  return (
    <ul
      className="space-y-0.5 text-sm"
      onClick={(event) => {
        // Only a chapter link counts; the padding around one should not close
        // the list.
        if (onNavigate && (event.target as HTMLElement).closest("a")) onNavigate();
      }}
    >
      {toc.map((entry) => (
        <li key={entry.id} className={cn(entry.level === 3 && "pl-3")}>
          <a
            href={`#${entry.id}`}
            className="block rounded px-2 py-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            {entry.text}
          </a>
        </li>
      ))}
    </ul>
  );
}

export function Help() {
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const mobileTocRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    let alive = true;
    const controller = new AbortController();
    fetch(GUIDE_URL, { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.text();
      })
      .then((body) => {
        if (alive) setMarkdown(body);
      })
      .catch(() => {
        // An aborted fetch on unmount is not a failure the user can act on.
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
      controller.abort();
    };
  }, []);

  const toc = useMemo(() => (markdown ? extractToc(markdown) : []), [markdown]);

  // A deep link (/help#reports arriving from a page's "?" affordance, a bookmark)
  // has no target until the fetched text has been rendered, so scroll once the
  // content is actually in the DOM.
  //
  // The whole lookup is wrapped because an exception thrown from a passive
  // effect unmounts the tree: a manual that blanks out on a hand-typed or badly
  // encoded bookmark is far worse than one that simply starts at the top.
  // `decodeURIComponent` throws on any invalid percent escape (`#%zz`), which is
  // a URL a reader can absolutely produce.
  useEffect(() => {
    if (markdown == null) return;
    const raw = window.location.hash.replace(/^#/, "");
    if (!raw) return;
    try {
      document.getElementById(decodeURIComponent(raw))?.scrollIntoView({ block: "start" });
    } catch {
      // Unresolvable deep link -- render from the top.
    }
  }, [markdown]);

  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-6 lg:px-6">
      <header className="mb-4">
        <h1 className="text-2xl font-semibold">使用说明</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          这份文档的真源是仓库里的 <code className="font-mono">{GUIDE_SOURCE}</code>
          ；用编辑器改完刷新本页即可看到，不需要重新构建。
        </p>
      </header>

      {failed && markdown == null && (
        <div
          role="alert"
          className="mb-6 rounded-lg border border-destructive/40 bg-destructive/5 p-4 text-sm"
        >
          <p className="font-medium">读不到说明文档</p>
          <p className="mt-1 text-muted-foreground">
            当前服务没有 <code className="font-mono">{GUIDE_URL}</code>。若你是从
            <span className="font-mono"> :8000</span> 打开的，那是上一次构建的产物，在
            <span className="font-mono"> frontend</span> 目录跑一次
            <code className="font-mono"> npm run build</code> 就有了；或者直接改用
            <span className="font-mono"> :5899</span>，它一直是最新的。
          </p>
        </div>
      )}

      {/* Below `lg` the sticky rail is display:none. A manual with no chapter
          list is a wall of text, so the same list collapses inline instead of
          vanishing. It sits *outside* the flex row below (a flex child would
          land beside the prose instead of above it) and outside
          nav[aria-label] (which is what Help.test.tsx counts to prove the rail
          resolves). */}
      {toc.length > 0 && (
        <details
          ref={mobileTocRef}
          className="mb-4 rounded-lg border border-border/60 bg-muted/20 p-3 text-sm lg:hidden"
        >
          <summary className="cursor-pointer select-none font-medium">
            目录（{toc.length} 节）
          </summary>
          <div className="mt-2 max-h-[50vh] overflow-y-auto">
            {/* A 49-row list left open after a pick buries the chapter that was
                just asked for, so choosing a row folds the list away. */}
            <TocList
              toc={toc}
              onNavigate={() => {
                if (mobileTocRef.current) mobileTocRef.current.open = false;
              }}
            />
          </div>
        </details>
      )}

      <div className="flex gap-8">
        <nav
          aria-label="章节"
          className="sticky top-6 hidden h-[calc(100vh-3rem)] w-56 shrink-0 overflow-y-auto lg:block"
        >
          <TocList toc={toc} />
        </nav>

        <article className="min-w-0 flex-1">
          {markdown == null ? (
            <p className="text-sm text-muted-foreground" aria-busy="true">
              正在加载说明…
            </p>
          ) : (
            <div className={PROSE}>
              <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
                components={markdownComponents}
              >
                {markdown}
              </ReactMarkdown>
            </div>
          )}
        </article>
      </div>
    </div>
  );
}
