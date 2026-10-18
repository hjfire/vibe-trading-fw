import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Chart, Nullable } from "klinecharts";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { applyUserIndicator, removeUserIndicator } from "@/lib/indicatorLang";
import { isPineStrategy } from "@/lib/pineScript";
import {
  loadUserIndicators,
  newIndicatorId,
  saveUserIndicators,
  type UserIndicator,
} from "@/lib/indicatorStore";
import type { ScriptCard } from "@/lib/scriptExchange";
import type { BarLoader } from "@/lib/screener";
import type { IntervalKey } from "@/lib/marketApi";
import EditorTab from "./workbench/EditorTab";
import LibraryTab from "./workbench/LibraryTab";
import ExchangeTab from "./workbench/ExchangeTab";
import ReportTab from "./workbench/ReportTab";
import ScreenerTab from "./workbench/ScreenerTab";
import AlertsTab from "./workbench/AlertsTab";
import {
  cardToDraft,
  draftToCard,
  EMPTY_DRAFT,
  type Draft,
  type TabKey,
  type WorkbenchSeed,
} from "./workbench/types";

/**
 * Right-hand drawer: the script workbench (local custom ⑩ → ⑪).
 *
 * Five tabs share one piece of text: the editor (write), the library (built-in
 * TradingView-style scripts), the exchange tab (.pine / JSON / share link), the
 * strategy report and the condition screener. A sixth hands the same text to the
 * backend alert kernel. Everything runs client-side against the mounted
 * KLineChart instance; scripts persist in localStorage.
 *
 * The props contract is unchanged from ⑩ so ProChart keeps working verbatim;
 * `seed` / `symbols` / `onPickSymbol` are the ⑪ additions and `symbol` /
 * `interval` / `adjust` the alert bridge's, all optional.
 */

interface IndicatorEditorProps {
  open: boolean;
  onClose: () => void;
  getChart: () => Nullable<Chart>;
  /** Notified after any apply/toggle/remove so the host can refresh state. */
  onChartIndicatorsChanged: () => void;
  /** Pre-load a script and jump to a tab; identity change re-applies. */
  seed?: WorkbenchSeed | null;
  /** Host watchlist, the default pool for the screener. */
  symbols?: string[];
  /** Show a screened symbol on the chart. */
  onPickSymbol?: (symbol: string) => void;
  /** Data seam for the screener (tests run without a network). */
  loadBars?: BarLoader;
  /** What the chart is showing right now; an alert rule is written about it. */
  symbol?: string;
  interval?: IntervalKey;
  adjust?: string;
}

const TABS: { key: TabKey; label: string }[] = [
  { key: "editor", label: "编辑器" },
  { key: "library", label: "脚本库" },
  { key: "exchange", label: "导入导出" },
  { key: "report", label: "策略报告" },
  { key: "screener", label: "条件筛选" },
  { key: "alerts", label: "脚本告警" },
];

/** 焦点陷阱按这份顺序数抽屉里的可聚焦元素，与 `common/ConfirmDialog.tsx` 同一把尺。 */
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export default function IndicatorEditor({
  open,
  onClose,
  getChart,
  onChartIndicatorsChanged,
  seed,
  symbols = [],
  onPickSymbol,
  loadBars,
  symbol = "",
  interval = "1D",
  adjust = "qfq",
}: IndicatorEditorProps) {
  const [items, setItems] = useState<UserIndicator[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ lines: string[]; bad: boolean } | null>(null);
  const [tab, setTab] = useState<TabKey>("editor");
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  /**
   * `aria-modal="true"` 是一句承诺：声明了 modal 却不搬焦点，键盘用户 Tab 出抽屉后
   * 就落进 AT 已经当成 inert 的内容里。这里兑现承诺的三件事——进抽屉时记下
   * `document.activeElement` 并把焦点送给关闭按钮、Tab / Shift+Tab 在抽屉内首尾环回、
   * 关闭（或卸载）时把焦点归还给记下的那枚元素。承诺只到这儿的理由见下面 `trapTab`。
   *
   * 依赖只放 `open`：本组件是 `if (!open) return null` 的形状，而宿主 `ProChart.tsx`
   * 传下来的 `onClose={() => setIndPanelOpen(false)}` 每次渲染都是新函数。一旦把它
   * 写进依赖，「记 focus → 抢焦点」每轮重渲染都重放一遍，正在抽屉里打字会被偷焦点。
   */
  useEffect(() => {
    if (!open) return;
    const previouslyFocused =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    closeRef.current?.focus();
    return () => {
      if (previouslyFocused?.isConnected) previouslyFocused.focus();
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setItems(loadUserIndicators());
    setError(null);
    setNotice(null);
  }, [open]);

  // Deep link (a `?s=` share) arrives from the host: fill the editor with it.
  useEffect(() => {
    if (!open || !seed) return;
    setDraft(seed.draft);
    setTab(seed.tab);
    setError(null);
  }, [open, seed]);

  if (!open) return null;

  /** Feedback shown above the tabs: it has to outlive a tab switch. */
  const say = (lines: string[], bad = false) => setNotice({ lines: lines.filter(Boolean), bad });

  /** Where a mounted script pays off: a strategy has numbers, an indicator has a form. */
  const landingTab = (card: ScriptCard): TabKey =>
    card.dialect === "pine" && isPineStrategy(card.code) ? "report" : "editor";

  const commit = (next: UserIndicator[]) => {
    setItems(next);
    saveUserIndicators(next);
    onChartIndicatorsChanged();
  };

  const specOf = (id: string, card: ScriptCard) => ({
    id,
    label: card.name,
    code: card.code,
    params: card.params,
    kind: card.display,
  });

  /** Re-applies a card by name, so clicking 应用 twice updates instead of duplicating. */
  const install = (card: ScriptCard): string | null => {
    const chart = getChart();
    if (!chart) {
      say(["图表尚未就绪，请稍后再试"], true);
      return "图表尚未就绪，请稍后再试";
    }
    const name = card.name.trim() || "未命名脚本";
    const prev = items.find((x) => x.label === name);
    const id = prev?.id ?? newIndicatorId();
    const warns: string[] = [];
    const err = applyUserIndicator(chart, specOf(id, { ...card, name }), (m) => warns.push(m));
    if (err) {
      // Failures of the library / import paths must reach the strip: the tab
      // that raised them is often not the one on screen.
      say([`「${name}」挂载失败：${err}`], true);
      return err;
    }
    setError(null);
    const row: UserIndicator = { ...specOf(id, { ...card, name }), enabled: true };
    commit(prev ? items.map((x) => (x.id === id ? row : x)) : [...items, row]);
    say([`已挂载「${name}」`, ...warns.map((w) => `说明：${w}`)]);
    return null;
  };

  const saveDraft = () => {
    const chart = getChart();
    if (!chart) {
      setError("图表尚未就绪，请稍后再试");
      return;
    }
    const card = draftToCard(draft);
    const id = draft.id ?? newIndicatorId();
    const warns: string[] = [];
    const err = applyUserIndicator(chart, specOf(id, card), (m) => warns.push(m));
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    const row: UserIndicator = { ...specOf(id, card), enabled: true };
    const idx = items.findIndex((x) => x.id === id);
    commit(idx >= 0 ? items.map((x, i) => (i === idx ? row : x)) : [...items, row]);
    setDraft({ ...EMPTY_DRAFT });
    say([`已保存「${card.name}」`, ...warns.map((w) => `说明：${w}`)]);
    setTab(landingTab(card));
  };

  const toggle = (item: UserIndicator) => {
    const chart = getChart();
    if (!chart) return;
    if (item.enabled) {
      removeUserIndicator(chart, item.id);
      commit(items.map((x) => (x.id === item.id ? { ...x, enabled: false } : x)));
    } else {
      const warns: string[] = [];
      const err = applyUserIndicator(chart, item, (m) => warns.push(m));
      if (err) {
        say([`「${item.label}」启用失败：${err}`], true);
        return;
      }
      setError(null);
      commit(items.map((x) => (x.id === item.id ? { ...x, enabled: true } : x)));
      say([`已启用「${item.label}」`, ...warns.map((w) => `说明：${w}`)]);
    }
  };

  const remove = (item: UserIndicator) => {
    const chart = getChart();
    if (chart) removeUserIndicator(chart, item.id);
    commit(items.filter((x) => x.id !== item.id));
    if (draft.id === item.id) setDraft(EMPTY_DRAFT);
  };

  const edit = (item: UserIndicator) => {
    setDraft({
      id: item.id,
      label: item.label,
      kind: item.kind,
      paramsText: item.params.join(", "),
      code: item.code,
    });
    setError(null);
    setTab("editor");
  };

  /** Send a script to the editor instead of mounting it blind. */
  const load = (card: ScriptCard) => {
    setDraft(cardToDraft(card));
    setTab("editor");
    setError(null);
    setNotice(null);
  };

  const apply = (card: ScriptCard) => {
    if (install(card)) return;
    setTab(landingTab(card));
  };

  const importCards = (cards: ScriptCard[]): string | null => {
    let lastErr: string | null = null;
    for (const card of cards) lastErr = install(card);
    return lastErr;
  };

  const rerun = (item: UserIndicator): string | null => {
    const chart = getChart();
    if (!chart) {
      say(["图表尚未就绪，请稍后再试"], true);
      return "图表尚未就绪，请稍后再试";
    }
    const warns: string[] = [];
    const err = applyUserIndicator(chart, item, (m) => warns.push(m));
    if (err) say([`重新回测失败：${err}`], true);
    else say([`已按当前K线重新回测「${item.label}」`, ...warns.map((w) => `说明：${w}`)]);
    return err;
  };

  /**
   * 焦点陷阱：Tab / Shift+Tab 在抽屉内首尾环回。处理器刻意挂在 `role="dialog"`
   * 这枚 div 的 `onKeyDown` 上，不挂 `document`/`window`——抽屉不在树上的时候，
   * 别人家的按键不该由这里接管。
   *
   * 明确不做 Escape，也别加它：抽屉里有 Pine 公式编辑页的 `<textarea>`，
   * 全局 Escape→close 会让正在写公式的人在不自知的情况下丢草稿；这比少一枚快捷键
   * 更实的伤害，所以本片的承诺只到「焦点进得来、出不去、关得掉、关完回到原处」。
   */
  const trapTab = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (focusable.length === 0) {
      e.preventDefault();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !dialog.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  return (
    <div className="fixed inset-0 z-40 bg-black/30" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className="absolute right-0 top-0 flex h-full w-[34rem] max-w-full flex-col border-l bg-card shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="swb-title"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={trapTab}
      >
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span id="swb-title" className="text-sm font-semibold">ƒ 脚本工作台</span>
          <button
            ref={closeRef}
            type="button"
            aria-label="关闭脚本工作台"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X size={14} />
          </button>
        </div>

        <div className="flex shrink-0 flex-wrap gap-1 border-b px-2 py-1.5">
          <div role="tablist" className="flex flex-wrap gap-1">
            {TABS.map((t) => (
              <button
                key={t.key}
                type="button"
                role="tab"
                aria-selected={tab === t.key}
                onClick={() => setTab(t.key)}
                className={cn(
                  "rounded px-2 py-1 text-xs hover:bg-muted",
                  tab === t.key && "bg-primary/10 font-semibold text-primary",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <span className="ml-auto self-center text-[11px] text-muted-foreground">
            {items.filter((x) => x.enabled).length}/{items.length} 已挂载
          </span>
        </div>

        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3 text-sm">
          {notice && (
            <ul
              className={cn(
                "space-y-0.5 rounded border px-2 py-1.5 text-[11px] leading-4",
                notice.bad ? "border-red-500/40 text-red-500" : "border-primary/30 text-muted-foreground",
              )}
            >
              {notice.lines.map((line) => (
                <li key={line} className="break-words">
                  {line}
                </li>
              ))}
            </ul>
          )}

          {tab === "editor" && (
            <EditorTab
              draft={draft}
              onDraft={setDraft}
              items={items}
              error={error}
              getChart={getChart}
              onSave={saveDraft}
              onToggle={toggle}
              onRemove={remove}
              onEdit={edit}
            />
          )}

          {tab === "library" && (
            <LibraryTab onLoad={load} onApply={apply} installed={items.map((x) => x.label)} />
          )}

          {tab === "exchange" && (
            <ExchangeTab draft={draft} items={items} onLoad={load} onImport={importCards} say={say} />
          )}

          {tab === "report" && <ReportTab items={items} onRerun={rerun} />}

          {tab === "screener" && (
            <ScreenerTab
              symbols={symbols}
              items={items}
              draft={draft}
              getChart={getChart}
              loadBars={loadBars}
              onPickSymbol={onPickSymbol ?? (() => undefined)}
            />
          )}

          {tab === "alerts" && (
            <AlertsTab
              draft={draft}
              getChart={getChart}
              symbol={symbol}
              interval={interval}
              adjust={adjust}
            />
          )}
        </div>
      </div>
    </div>
  );
}
