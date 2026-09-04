import { useEffect, useState } from "react";
import type { Chart, Nullable } from "klinecharts";
import { Pencil, Plus, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { applyUserIndicator, removeUserIndicator } from "@/lib/indicatorLang";
import {
  loadUserIndicators,
  newIndicatorId,
  saveUserIndicators,
  type UserIndicator,
} from "@/lib/indicatorStore";
import { FORMULA_TEMPLATES } from "@/lib/indicatorTemplates";

/**
 * Right-hand drawer: write / import / manage custom indicator formulas
 * (local custom ⑩). Everything runs client-side against the mounted
 * KLineChart instance; formulas persist in localStorage.
 */

interface IndicatorEditorProps {
  open: boolean;
  onClose: () => void;
  getChart: () => Nullable<Chart>;
  /** Notified after any apply/toggle/remove so the host can refresh state. */
  onChartIndicatorsChanged: () => void;
}

interface Draft {
  id: string | null; // null = brand new
  label: string;
  kind: "overlay" | "pane";
  paramsText: string;
  code: string;
}

const EMPTY_DRAFT: Draft = {
  id: null,
  label: "",
  kind: "pane",
  paramsText: "14",
  code: `// 变量：open high low close volume hl2 hlc3，参数数组 P（P[0]、P[1]…）
// 函数：ma ema rma stdev dev sum cumsum hh ll ref change roc cross nz
//       where abs max min avg sqrt pow log log10 round floor ceil sign na
// 算术自动逐根对齐（标量与序列混算会拉伸），NaN 处自动留空
return { M1: ma(close, P[0]) };`,
};

function parseParams(text: string): number[] {
  return text
    .split(/[,，\s]+/)
    .map((t) => Number(t))
    .filter((n) => Number.isFinite(n));
}

export default function IndicatorEditor({
  open,
  onClose,
  getChart,
  onChartIndicatorsChanged,
}: IndicatorEditorProps) {
  const [items, setItems] = useState<UserIndicator[]>([]);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setItems(loadUserIndicators());
      setError(null);
    }
  }, [open]);

  if (!open) return null;

  const commit = (next: UserIndicator[]) => {
    setItems(next);
    saveUserIndicators(next);
    onChartIndicatorsChanged();
  };

  const saveDraft = () => {
    const chart = getChart();
    if (!chart) {
      setError("图表尚未就绪，请稍后再试");
      return;
    }
    const label = draft.label.trim() || "我的指标";
    const id = draft.id ?? newIndicatorId();
    const err = applyUserIndicator(chart, {
      id,
      label,
      code: draft.code,
      params: parseParams(draft.paramsText),
      kind: draft.kind,
    });
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    const row: UserIndicator = {
      id,
      label,
      kind: draft.kind,
      params: parseParams(draft.paramsText),
      code: draft.code,
      enabled: true,
    };
    const idx = items.findIndex((x) => x.id === id);
    commit(idx >= 0 ? items.map((x, i) => (i === idx ? row : x)) : [...items, row]);
    setDraft({ ...EMPTY_DRAFT });
  };

  const toggle = (item: UserIndicator) => {
    const chart = getChart();
    if (!chart) return;
    if (item.enabled) {
      removeUserIndicator(chart, item.id);
      commit(items.map((x) => (x.id === item.id ? { ...x, enabled: false } : x)));
    } else {
      const err = applyUserIndicator(chart, item);
      if (err) {
        setError(`「${item.label}」启用失败：${err}`);
        return;
      }
      commit(items.map((x) => (x.id === item.id ? { ...x, enabled: true } : x)));
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
  };

  const useTemplate = (key: string) => {
    const t = FORMULA_TEMPLATES.find((x) => x.key === key);
    if (!t) return;
    setDraft({
      id: null,
      label: t.label.replace(/（.*）$/, ""),
      kind: t.kind,
      paramsText: t.params.join(", "),
      code: t.code,
    });
    setError(null);
  };

  return (
    <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose}>
      <div
        className="absolute right-0 top-0 flex h-full w-[28rem] max-w-full flex-col border-l bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-semibold">ƒ 指标公式工作台</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X size={14} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3 text-sm">
          {/* templates */}
          <section>
            <h3 className="mb-1.5 text-xs font-semibold text-muted-foreground">内置常用公式（点击载入，可再修改）</h3>
            <div className="grid grid-cols-2 gap-1.5">
              {FORMULA_TEMPLATES.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => useTemplate(t.key)}
                  className="rounded border px-2 py-1 text-left text-xs hover:bg-muted"
                >
                  {t.label}
                </button>
              ))}
            </div>
          </section>

          {/* editor */}
          <section className="space-y-2 rounded-lg border p-2.5">
            <h3 className="text-xs font-semibold text-muted-foreground">
              {draft.id ? "编辑指标" : "新建指标"}
            </h3>
            <div className="flex gap-2">
              <input
                value={draft.label}
                onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                placeholder="指标名称"
                className="h-7 min-w-0 flex-1 rounded border bg-background px-2 text-xs outline-none focus:border-primary"
              />
              <input
                value={draft.paramsText}
                onChange={(e) => setDraft({ ...draft, paramsText: e.target.value })}
                placeholder="参数，如 14, 2"
                className="h-7 w-28 rounded border bg-background px-2 font-mono text-xs outline-none focus:border-primary"
              />
            </div>
            <div className="flex items-center gap-3 text-xs">
              <span className="text-muted-foreground">显示位置:</span>
              {(["overlay", "pane"] as const).map((k) => (
                <label key={k} className="flex cursor-pointer items-center gap-1">
                  <input
                    type="radio"
                    name="ind-kind"
                    checked={draft.kind === k}
                    onChange={() => setDraft({ ...draft, kind: k })}
                  />
                  {k === "overlay" ? "主图叠加" : "副图"}
                </label>
              ))}
            </div>
            <textarea
              value={draft.code}
              onChange={(e) => setDraft({ ...draft, code: e.target.value })}
              spellCheck={false}
              rows={10}
              className="w-full resize-y rounded border bg-background p-2 font-mono text-[11px] leading-4 outline-none focus:border-primary"
            />
            {error && <p className="whitespace-pre-wrap text-xs text-red-500">{error}</p>}
            <div className="flex gap-2">
              <button
                type="button"
                onClick={saveDraft}
                className="flex items-center gap-1 rounded bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground hover:opacity-90"
              >
                <Plus size={12} /> {draft.id ? "保存并更新" : "保存并应用"}
              </button>
              {draft.id && (
                <button
                  type="button"
                  onClick={() => setDraft(EMPTY_DRAFT)}
                  className="rounded border px-2.5 py-1 text-xs hover:bg-muted"
                >
                  取消编辑
                </button>
              )}
            </div>
          </section>

          {/* installed list */}
          <section>
            <h3 className="mb-1.5 text-xs font-semibold text-muted-foreground">我的指标（勾选 = 显示在图上）</h3>
            {items.length === 0 && (
              <p className="text-xs text-muted-foreground">还没有自定义指标 — 从上方模板开始，或直接写公式。</p>
            )}
            <div className="space-y-1">
              {items.map((it) => (
                <div key={it.id} className="flex items-center gap-2 rounded border px-2 py-1.5 text-xs">
                  <input
                    type="checkbox"
                    checked={it.enabled}
                    onChange={() => toggle(it)}
                    title="显示/隐藏"
                    className="accent-[var(--primary)]"
                  />
                  <span className={cn("min-w-0 flex-1 truncate", !it.enabled && "text-muted-foreground")}>
                    {it.label}
                  </span>
                  <span className="rounded bg-muted px-1 py-0.5 text-[10px] text-muted-foreground">
                    {it.kind === "overlay" ? "主图" : "副图"}
                  </span>
                  <button
                    type="button"
                    onClick={() => edit(it)}
                    title="编辑公式"
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(it)}
                    title="删除"
                    className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-red-500"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              ))}
            </div>
          </section>

          {/* cheat sheet */}
          <details className="rounded-lg border p-2.5 text-xs">
            <summary className="cursor-pointer font-semibold text-muted-foreground">
              公式语法速查
            </summary>
            <div className="mt-2 space-y-1 leading-5 text-muted-foreground">
              <p>
                数据变量：<code className="font-mono text-foreground">open high low close volume hl2 hlc3</code>
                （与K线逐根对齐的序列）
              </p>
              <p>
                参数：<code className="font-mono text-foreground">P</code> 数组，取自上方"参数"输入框，如
                <code className="font-mono text-foreground"> P[0]</code>
              </p>
              <p>
                逐行写：<code className="font-mono text-foreground">名字 = 表达式;</code>，最后
                <code className="font-mono text-foreground">{" return { 线名: 序列 };"}</code>（每键一条线）或
                <code className="font-mono text-foreground"> return 序列;</code>
              </p>
              <p>
                滚动函数：<code className="font-mono text-foreground">ma ema rma stdev dev sum cumsum hh ll ref change roc cross nz</code>
                ，如 <code className="font-mono text-foreground">ma(close, 20)</code>、
                <code className="font-mono text-foreground">hh(high, 20)</code>、
                <code className="font-mono text-foreground">cross(快线, 慢线)</code>（金叉 1 / 死叉 -1）
              </p>
              <p>
                数学与判断：<code className="font-mono text-foreground">abs max min avg sqrt pow log log10 round floor ceil sign</code>
                、<code className="font-mono text-foreground">+ - * / % &gt; &lt; &gt;= &lt;= == != and or not</code>
                、三元 <code className="font-mono text-foreground">条件 ? 值A : 值B</code>、
                <code className="font-mono text-foreground">where(条件, 值A, 值B)</code>
              </p>
              <p>
                广播：标量与序列混算自动拉伸，所以 <code className="font-mono text-foreground">{"return { 轴: 0 };"}</code> 是一条水平参考线；除零/数据不足产生 NaN，图上自动留空
              </p>
              <p>
                注释：<code className="font-mono text-foreground">//</code> 或 <code className="font-mono text-foreground">#</code> 到行末。本语言由页面内置解释器执行（不走 eval，生产环境 CSP 下同样可用）
              </p>
            </div>
          </details>
        </div>
      </div>
    </div>
  );
}
