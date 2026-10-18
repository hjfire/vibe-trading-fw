# L3 第④片：脚本工作台自陈无障碍角色 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让「ƒ 脚本工作台」这层抽屉在无障碍树里自陈它是 `dialog`（带 `aria-modal` 与由标题解析的可达名、关闭按钮有中文可达名）且顶层是 `tablist`／`tab`／`aria-selected` 唯一。

**Architecture:** 纯显示层属性改动，只动一枚组件 `frontend/src/components/charts/IndicatorEditor.tsx` 的 JSX 属性面（＋页签条把「N/M 已挂载」那枚 span 从 tablist 里迁出为兄弟）与它的组件测试 `ScriptWorkbench.test.tsx`。取数／挂载／编译逻辑一字不动。形状抄仓内两枚现成件：右侧抽屉的 dialog 三件套抄 `ConnectionCenter.tsx:132-133`，tablist 与 ml-auto 兄弟分居抄 `RunDetail.tsx:391` 与 `:408`。

**Tech Stack:** React 19 ＋ TypeScript ＋ Vite ＋ Vitest（jsdom ＋ @testing-library/jest-dom）＋ Tailwind。

**Spec:** `docs/superpowers/specs/2026-10-18-l3-slice4-workbench-aria-design.md`（判态、四条裁定、改动面与测试面都从那里来；冲突时以 spec 为准）

## Global Constraints

- **`IndicatorEditor.tsx` 工作树是 CRLF**（2026-10-18 现读 `tr -cd '\r' < frontend/src/components/charts/IndicatorEditor.tsx | wc -c` ＝ 349 ＝ `wc -l` 的 349）。每次编辑后复跑这两把尺，**断言 CR 数＝行数**；若编辑把某行写成 LF-only，CR 会小于行数＝缺陷，必须改回。数 CR 只用 `tr -cd '\r' < f | wc -c`，`grep -c $'\r'` 在本机读不出 CR。
- **禁抄对方页面的控件名**：`frontend/src/**` 里不许出现对方的英文字串（`Close menu`／`Indicators`／`Script name`…）与 `tradingview.com`。可达名一律本仓中文，逐字 `关闭脚本工作台`。测试里也**不写**这些英文字串做反向断言——用「可达名逐字相等 ＋ 纯 CJK 形状尺」代替。
- **不发 `aria-controls`、不加 `role="tabpanel"`**（spec 裁定二：页身选中才挂载，逐 tab 发必悬空）。并留一根零计数针钉住这个形状。
- **不做** Escape 关闭、焦点陷阱、焦点归还、键盘 roving tabindex（spec 裁定四：L0 a7 明写未派发 Escape、未切页，那片证据是空的）。
- 每枚新针**先亲眼看它红过一次**再写实现；红过的 stdout 逐字留档到报告里。
- 提交一律 `git commit -s`；多面提交必须带显式 pathspec（裸 `git commit` 会吞别人 staged 的面）。
- `docs/` 被 `.gitignore` 忽略：改被跟踪的文档要 `git add -f` 或对该路径直接提交。
- 两枚本机恒红门**不调阈值、不改门、不清白名单**：`tools/wiki_freshness_gate.sh`（页数超阈值）与 `tools/ci_grep_gates.sh` 的 `[gate b]`。只出「本片 0 贡献」的交集归属证据。
- 面向用户的正文与总结用中文；代码、命令、属性名保留原文。
- 六道门命令（逐字）：`npx tsc -b`／`npx vitest run`／`npx vite build`（三者在 `frontend/` 下跑）／`python -X utf8 -m pytest tools/test_wiki_drift.py tools/test_wiki_qmind.py -q`（**双文件一起跑**，单跑一枚读数不同）／`python -X utf8 tools/forensics_audit.py`／`python -X utf8 -m pytest tools/test_forensics_spec.py -q`（后三者在仓库根跑）。
  - 2026-10-18 就地修（Task 3 执行席证得、控制席复跑坐实）：G4／G6 原稿写的是 `python -X utf8 tools/test_wiki_drift.py tools/test_wiki_qmind.py` 与 `python -X utf8 tools/test_forensics_spec.py`——**去掉 `-m pytest` 的那两形是假绿**。三枚文件都没有 `__main__` 守卫（`grep -c '__name__'` 现读全 0），直接跑文件＝一条测试都不收集，读数 `rc=0` 且 stdout 一个字节也没有。控制席当场两形各跑一次：`-m pytest` 形 G4＝`256 passed in 109.84s`、G6＝`166 passed in 11.76s`；裸跑形两条都 rc=0 零输出。CI 那侧本来就是 `-m pytest` 形（`.github/workflows/repowiki-freshness.yml:85`）。`tools/forensics_audit.py` 有 `__main__` 守卫，裸跑是**对的**，不要一起改。凡引用那两形读数的地方一律走 `-m pytest`。

---

### Task 1: 浮层自陈 `dialog` ＋ 关闭按钮可达名

**Files:**
- Modify: `frontend/src/components/charts/IndicatorEditor.tsx`（`:250` 遮罩、`:251-254` 抽屉、`:256` 标题、`:257-263` 关闭按钮）
- Test: `frontend/src/components/charts/__tests__/ScriptWorkbench.test.tsx`（文件末尾追加一个 describe）

**Interfaces:**
- Consumes: 既有测试助手 `open(props)`（同文件 `:69-81`，`{...props}` 在默认 `onClose={vi.fn()}` **之后**展开 ⇒ 传 `{ onClose }` 能覆盖）。
- Produces: 标题节点 `id="swb-title"`；Task 2 不依赖它。关闭按钮的可达名逐字 `关闭脚本工作台`（Task 3 变异表与 Task 4 活体读数按这个名字）。

- [ ] **Step 1: 写失败测试**

在 `frontend/src/components/charts/__tests__/ScriptWorkbench.test.tsx` 的**文件末尾**追加（不改动既有内容）：

```tsx
describe("脚本工作台浮层的无障碍角色", () => {
  it("抽屉自陈 role=dialog＋aria-modal，可达名由标题节点解析；遮罩只是 presentation", () => {
    const { container } = open();

    const dialog = screen.getByRole("dialog", { name: /脚本工作台/ });
    expect(dialog).toHaveAttribute("aria-modal", "true");

    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).toBeTruthy();
    const title = document.getElementById(labelledBy as string);
    expect(title).not.toBeNull();
    expect((title as HTMLElement).textContent).toBe("ƒ 脚本工作台");

    // 整棵树只有这一枚 dialog，且它不是那层整屏遮罩。
    expect(container.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(container.querySelector(".fixed.inset-0")).toHaveAttribute("role", "presentation");
  });

  it("关闭按钮有本仓中文可达名（纯 CJK 形状），点它真的调 onClose", () => {
    const onClose = vi.fn();
    open({ onClose });

    const btn = screen.getByRole("button", { name: "关闭脚本工作台" });
    expect(screen.getAllByRole("button", { name: "关闭脚本工作台" })).toHaveLength(1);
    expect(btn.getAttribute("aria-label")).toBe("关闭脚本工作台");
    // 本仓可达名一律中文：抄进任何英文控件名，这把尺直接判红。
    expect(btn.getAttribute("aria-label")).toMatch(/^[一-鿿]+$/);

    fireEvent.click(btn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
```

`/^[一-鿿]+$/` 是纯 CJK 形状尺（`一`＝U+4E00、`鿿`＝U+9FFF）。写成字面字符而不用 `\u` 转义，是为了避免读的人以为它是通配。

- [ ] **Step 2: 跑测试，确认它按预期红**

Run: `cd frontend && npx vitest run src/components/charts/__tests__/ScriptWorkbench.test.tsx`
Expected: FAIL，两条新 it 都红；第一枚的报错应是 `Unable to find role="dialog"`，第二枚应是 `Unable to find an accessible element with the role "button" and name "关闭脚本工作台"`。**既有 describe 必须仍全绿**——若它们也红了，说明这步的改动面越界了（本步一行实现都没写）。把红跑 stdout 逐字贴进报告。

- [ ] **Step 3: 写最小实现**

`frontend/src/components/charts/IndicatorEditor.tsx`，把这一段（从遮罩那行的 `<div className="fixed inset-0` 起，到关闭按钮的 `>` 止；行号现读约 `:250-261`，按内容锚定不按号）：

```tsx
    <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose}>
      <div
        className="absolute right-0 top-0 flex h-full w-[34rem] max-w-full flex-col border-l bg-card shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span className="text-sm font-semibold">ƒ 脚本工作台</span>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
```

改为：

```tsx
    <div className="fixed inset-0 z-40 bg-black/30" role="presentation" onClick={onClose}>
      <div
        className="absolute right-0 top-0 flex h-full w-[34rem] max-w-full flex-col border-l bg-card shadow-xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby="swb-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b px-3 py-2">
          <span id="swb-title" className="text-sm font-semibold">ƒ 脚本工作台</span>
          <button
            type="button"
            aria-label="关闭脚本工作台"
            onClick={onClose}
            className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
```

只加属性，不动 className、不动 onClick、不重排 JSX。

- [ ] **Step 4: 跑测试确认绿，并复跑 CRLF 尺**

Run: `cd frontend && npx vitest run src/components/charts/__tests__/ScriptWorkbench.test.tsx` → 全绿（含既有各 describe）。
Run: `tr -cd '\r' < frontend/src/components/charts/IndicatorEditor.tsx | wc -c` 与 `wc -l < frontend/src/components/charts/IndicatorEditor.tsx` → **两把尺必须相等**（净加行数只给形状不给数：本步真正新增的是「抽屉三行属性 ＋ 关闭按钮的 aria-label 一行」＝**4 行**，`id` 加在标题 span 上是行内的、不加行。原稿这句写的是「本步净加 3 行，故由 349 变 352」，那半截算术在写下时就是错的（漏了 `aria-label` 那一行），2026-10-18 Task 1 执行席现读为 349→353 后按实改口；两把尺相等这条断言不动，行数一律由你当场测）。

- [ ] **Step 5: 提交**

```bash
cd /e/Vibe-Trading-main/Vibe-Trading-main
git add frontend/src/components/charts/IndicatorEditor.tsx frontend/src/components/charts/__tests__/ScriptWorkbench.test.tsx
git commit -s -m "feat(workbench): 抽屉自陈 role=dialog＋aria-modal，关闭按钮拿到本仓中文可达名（TV-CI-04 的下半）"
```

`git status --porcelain` 确认工作树只剩 `?? .superpowers/`（那是本席 scratch，永不 add）。

---

### Task 2: 页签自陈 `tablist`／`tab`／`aria-selected` ＋ 十处连带改口（**必须同一笔落地**）

**Files:**
- Modify: `frontend/src/components/charts/IndicatorEditor.tsx`（页签条那一段，Task 1 落地后行号约 `:269-286`）
- Test: `frontend/src/components/charts/__tests__/ScriptWorkbench.test.tsx`（末尾追加新 describe ＋ 把既有 10 处 `"button"` 改 `"tab"`）

**Interfaces:**
- Consumes: Task 1 无（两任务改同一文件不同段）。
- Produces: `role="tablist"` 一枚、`role="tab"` 六枚、`aria-selected` 恰一枚 `"true"`；`[aria-controls]` 零命中（Task 3 变异表与 Task 5 矩阵说明按这个形状）。

- [ ] **Step 1: 数出连带面（先数，别先改）**

Run:

```bash
cd /e/Vibe-Trading-main/Vibe-Trading-main/frontend
grep -rn -e 'button", { name: "编辑器' -e 'button", { name: "脚本库' -e 'button", { name: "导入导出' \
          -e 'button", { name: "策略报告' -e 'button", { name: "条件筛选' -e 'button", { name: "脚本告警' \
          src --include=*.tsx --include=*.ts
```

（2026-10-18 就地修：原稿这条写的是 `grep -n -e ...`，**少了 `-r`**——逐字照抄跑出来是 `grep: src: Is a directory`、exit 2，一把尺根本读不出数。加 `-r` 后实测 10 处命中，与下面那十行号相等。）

Expected: 全部命中都在 `src/components/charts/__tests__/ScriptWorkbench.test.tsx`（2026-10-18 现读＝10 处，行号 154／177／200／209／218／241／248／253／266／272）。**把这把尺的当场输出逐字贴进报告**；若与上面那十行号不一致，以当场读为准并在报告里登记差异，不要回去引用计划里的号。

- [ ] **Step 2: 写失败测试**

在 `ScriptWorkbench.test.tsx` **文件末尾**追加：

```tsx
describe("脚本工作台页签的无障碍角色", () => {
  it("恰一枚 tablist、六枚 tab、selected 唯一且默认落在编辑器；tablist 的孩子全是 tab", () => {
    const { container } = open();

    expect(container.querySelectorAll('[role="tablist"]')).toHaveLength(1);
    expect(screen.getAllByRole("tab")).toHaveLength(6);

    // 「N/M 已挂载」那枚计数不属于页签，必须住在 tablist 之外。
    const tablist = container.querySelector('[role="tablist"]') as HTMLElement;
    for (const child of Array.from(tablist.children)) {
      expect(child.getAttribute("role")).toBe("tab");
    }

    const tabs = screen.getAllByRole("tab");
    const selected = tabs.filter((t) => t.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveAccessibleName("编辑器");
    for (const t of tabs.filter((x) => x !== selected[0])) {
      expect(t.getAttribute("aria-selected")).toBe("false");
    }

    // 裁定二：页身选中才挂载 ⇒ 不发 aria-controls，否则五枚永远悬空。
    expect(container.querySelectorAll("[aria-controls]")).toHaveLength(0);
  });

  it("点另一页后 selected 跟着换页，且仍然恰一枚", () => {
    open();
    fireEvent.click(screen.getByRole("tab", { name: "脚本库" }));
    const selected = screen
      .getAllByRole("tab")
      .filter((t) => t.getAttribute("aria-selected") === "true");
    expect(selected).toHaveLength(1);
    expect(selected[0]).toHaveAccessibleName("脚本库");
  });
});
```

- [ ] **Step 3: 跑测试，确认按预期红**

Run: `cd frontend && npx vitest run src/components/charts/__tests__/ScriptWorkbench.test.tsx`
Expected: 两条新 it 红（`Unable to find role="tab"`／`expected 0 to be 1` 一类）；**既有各 describe 此时仍全绿**（`role="tab"` 还没落地，那 10 处 button 查法还没坏）。红跑 stdout 逐字留档。

- [ ] **Step 4: 改实现（页签条结构）**

`IndicatorEditor.tsx`，把这一段（从页签条的 `<div className="flex shrink-0 flex-wrap gap-1 border-b px-2 py-1.5">` 起，到它配平的 `</div>` 止；含 `{TABS.map(...)}` 与尾部那枚「已挂载」span）整段：

```tsx
        <div className="flex shrink-0 flex-wrap gap-1 border-b px-2 py-1.5">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={cn(
                "rounded px-2 py-1 text-xs hover:bg-muted",
                tab === t.key && "bg-primary/10 font-semibold text-primary",
              )}
            >
              {t.label}
            </button>
          ))}
          <span className="ml-auto self-center text-[11px] text-muted-foreground">
            {items.filter((x) => x.enabled).length}/{items.length} 已挂载
          </span>
        </div>
```

改为：

```tsx
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
```

要点：外层 div 的 className 一字不动（视觉不变）；新增的 tablist div 只装六枚 tab；span 与 tablist **平级**。缩进按上层 div 递进（这段是 JSX 嵌套，比原样多缩两格）。

- [ ] **Step 5: 同一笔里改口那 10 处查询**

对 Step 1 数出的每一处，把 `screen.getByRole("button", { name: "<页签名>" })` 里的 `"button"` 改成 `"tab"`，name、行号位置与其余断言一字不动。形如：

```tsx
    fireEvent.click(screen.getByRole("tab", { name: "脚本库" }));
```

**为什么必须与 Step 4 同笔提交**：`role="tab"` 一落地，这六枚元素就不再是 button 角色，先提交实现会让中间那笔 `npx vitest run` 红十处——那是「角色迁走」不是「行为改坏」，但它照样把 CI 打红，也没法用中间态自证。

- [ ] **Step 6: 跑全套件确认全绿**

Run: `cd frontend && npx vitest run src/components/charts/__tests__/ScriptWorkbench.test.tsx` → 全绿（新 2 枚＋既有各枚）。
Run: `cd frontend && npx vitest run` → 全量绿，特别是 `src/pages/__tests__/ProChart*.test.tsx` 那些会渲染工作台的页面测试。
Run: CRLF 两把尺（`tr -cd '\r'` 与 `wc -l`）→ 相等。

- [ ] **Step 7: 提交**

```bash
cd /e/Vibe-Trading-main/Vibe-Trading-main
git add frontend/src/components/charts/IndicatorEditor.tsx frontend/src/components/charts/__tests__/ScriptWorkbench.test.tsx
git commit -s -m "feat(workbench): 页签自陈 tablist／tab／aria-selected 唯一，计数 span 迁出 tablist（TV-CI-05）

role=tab 落地后按名查 button 的十处针必然红，故与实现同笔改口为查 tab；
不发 aria-controls（页身选中才挂载，逐 tab 发必悬空）。"
```

---

### Task 3: 变异自证（十枚注入，覆盖 spec §4.3 那八行）＋六道门

**Files:**
- 不新增文件；临时改坏 `frontend/src/components/charts/IndicatorEditor.tsx` 后**必须逐字节还原**
- Test: 同前两任务的针

**Interfaces:**
- Consumes: Task 1／2 的全部针名与属性字串。
- Produces: 一张「注入 → 哪枚针红」的实测表（Task 5 的矩阵说明与 Task 6 的档案 §7.28 引用它）。

- [ ] **Step 0: 先探基线（否则「针没红」与「命令没跑成」分不开）**

```bash
cd /e/Vibe-Trading-main/Vibe-Trading-main/frontend
npx vitest run src/components/charts/__tests__/ScriptWorkbench.test.tsx
```

Expected: 全绿，且 stdout 里有 `Tests  N passed` 那一行——**把这行的逐字形状记住**：Step 1 的脚本靠 `×` 与 `Tests ` 两种行判读，若基线跑不出这两种形状，那是取数形状的缺陷，先修脚本再谈变异。

- [ ] **Step 1: 写探针脚本（内存副本还原法，不碰 git）**

把 `IndicatorEditor.tsx` 的**原始字节**先读进内存留作还原源，每枚注入＝把 needle 换成 dead 后写盘、跑焦点套件、读 stdout，然后**只用那份内存副本**写回。脚本落在 `.superpowers/sdd/2026-10-18-l3-slice4-workbench-aria/mutate.py`（该目录未跟踪，不进仓）：

```python
import subprocess
from pathlib import Path

SRC = Path("frontend/src/components/charts/IndicatorEditor.tsx")   # 相对仓库根
FRONTEND = "frontend"
ORIG = SRC.read_bytes()                      # 还原源＝动手前的内存副本
# vitest 的配置在 frontend/ 下 ⇒ subprocess 必带 cwd；Windows 上 bare `npx` 找不着
# （那是 npx.cmd，CreateProcess 不套 PATHEXT）⇒ 写死 npx.cmd。
CMD = ["npx.cmd", "vitest", "run", "src/components/charts/__tests__/ScriptWorkbench.test.tsx"]

# needle 一律**不带换行**：本文件工作树是 CRLF，`b'role="tab"\n'` 这种写法
# 在这把尺上永远 count=0，注入根本没发生（不是「针没红」）。
MUTS = {
    "m1-tablist":  (b'role="tablist"',                b''),
    "m2-tab-role": (b'role="tab"',                   b''),
    "m3-noselect": (b'aria-selected={tab === t.key}', b'aria-selected={false}'),
    "m4-allsel":   (b'aria-selected={tab === t.key}', b'aria-selected={true}'),
    "m5-nodialog": (b'role="dialog"',                b''),
    "m6-nomodal":  (b'aria-modal="true"',            b''),
    "m7-maskdlg":  (b'className="fixed inset-0 z-40 bg-black/30" role="presentation"',
                    b'className="fixed inset-0 z-40 bg-black/30" role="dialog"'),
    # 2026-10-18 就地修：原稿这行写的是 b'aria-label="关闭脚本工作台"' ——**bytes 字面量装不下中文**，
    # Python 3 编译期即 `SyntaxError: bytes can only contain ASCII literal characters`，脚本连跑都跑不起来
    # （不是「注入没发生」那种静默失效，是整份脚本炸）。中文 needle 一律写 str 字面量再 `.encode()`。
    "m8-nolabel":  ('aria-label="关闭脚本工作台"'.encode(), b''),
    # 往 tablist 里塞一枚真·非 tab 孩子（span 是它的兄弟，动兄弟判不动这条针）
    "m9-child":    (b'<div role="tablist" className="flex flex-wrap gap-1">',
                    b'<div role="tablist" className="flex flex-wrap gap-1"><span>x</span>'),
    # 补发悬空 aria-controls（钉住裁定二那根零计数针）
    "m10-dangle":  (b'role="tab"',
                    b'role="tab" aria-controls="swb-panel-editor"'),
    # 2026-10-18 追加（Task 2 评审 Minor-2）：搬家后的「N/M 已挂载」span 今天没有任何存活针。
    # needle 取带前导空格的 ` 已挂载`——裸 `已挂载` 在本文件 count=2（`:152` 那句 say 文案也用它），
    # 会被脚本判成 SKIP needle count!=1 而静默不注入。
    "m11-span-text": (b' \xe5\xb7\xb2\xe6\x8c\x82\xe8\xbd\xbd', b''),
}

for name, (needle, dead) in MUTS.items():
    n = ORIG.count(needle)
    if n != 1:
        print(f"{name}: SKIP needle count={n} (期望恰 1 枚)")
        continue
    SRC.write_bytes(ORIG.replace(needle, dead, 1))
    try:
        p = subprocess.run(CMD, cwd=FRONTEND, capture_output=True, text=True,
                           encoding="utf-8", errors="replace")
        print(f"{name}: rc={p.returncode}")
        for line in p.stdout.splitlines():
            if "×" in line or "Tests " in line:
                print("   ", line.strip())
    finally:
        SRC.write_bytes(ORIG)               # 只从内存副本还原，不用 git checkout
        assert SRC.read_bytes() == ORIG, name
print("restored ok")
```

在仓库根跑：`python -X utf8 .superpowers/sdd/2026-10-18-l3-slice4-workbench-aria/mutate.py`

三点已知坑：① **任何一枚打出 `SKIP needle count=0` 都不算跑过**——那是注入没发生，必须换 needle 形状重跑，不许把「针没红」写成结论；② needle 里的中文按 UTF-8 字节匹配（Python 源文件字面量即 UTF-8，与本机控制台 cp936 无关；若报 `count=0`，单独验一次 `python -X utf8 -c "print(open('frontend/src/components/charts/IndicatorEditor.tsx','rb').read().count('关闭脚本工作台'.encode()))"`，别改编码路线）；③ 判针身份看 stdout 里的 `×` 行，**不要**只看 rc。

第四点（2026-10-18 Task 2 执行席提出后补）：本机 `core.autocrlf=true` ⇒ **入库 blob 是 LF-only，CRLF 那把尺只对工作树成立**。注入源与还原源都必须来自 `Path.read_bytes()` 读到的工作树字节；谁也不许拿 `git show HEAD:frontend/...` 的输出当注入底本或去数它的 CR（那是 LF，needle 形状与行数都会读错）。

- [ ] **Step 2: 逐条判读**

预期（把实测与预期不符的逐条记成 HARNESS-BLIND 并定因，不许含糊过）：

| 注入 | 必红的针 |
|---|---|
| m1-tablist | 「恰一枚 tablist」那枚（`querySelectorAll` 读到 0） |
| m2-tab-role | `getAllByRole("tab")` 六枚读不到 ⇒ 两条新 it 全红 |
| m3-noselect | 「selected 恰一枚」读不到 true |
| m4-allsel | 「恰一枚」变六枚 ⇒ 两条新 it 都红 |
| m5-nodialog | `getByRole("dialog")` 找不到 |
| m6-nomodal | `aria-modal` 属性断言红 |
| m7-maskdlg | 「整棵树只有一枚 dialog」红（遮罩也变 dialog）——**这枚是裁定一的回归钉** |
| m8-nolabel | 关闭按钮可达名查不到 |
| m9-child | 「tablist 的孩子全是 tab」那一半红（children 里第一枚的 role 是 null）——**这是「span 迁出 tablist」的唯一可注入判据**，动兄弟判不动它 |
| m10-dangle | 「`[aria-controls]` 零计数」那根针红（读到 6）——钉住裁定二 |
| m11-span-text | **预期谁都别红**（这是故意摆出来的盲区，不是缺陷漏网）：Task 2 把「N/M 已挂载」那枚 span 搬出 tablist，全套件里没有任何针读它的文本或存在性（2026-10-18 Task 2 评审席现读：`grep -rn "已挂载" frontend/src` 的测试侧命中只有 `ScriptWorkbench.test.tsx:421` 的一句注释）。m11 跑出「全绿」⇒ 盲区证毕 ⇒ Step 3 补一根文本针 `expect(screen.getByText(/已挂载/)).toBeTruthy();`（摆进「恰一枚 tablist」那枚 `it` 的末尾），补完**只重跑 m11** 确认它由绿转红，再还原确认由红转绿。这条补针就是它的 RED 证据来源——不补针而直接在干净树上写它，会当场绿，违反红-first。 |

跑完必须确认还原干净：`git status --porcelain` 只剩 `?? .superpowers/`，且 `git diff --stat` 为空。

- [ ] **Step 3: 六道门全量**

```bash
cd /e/Vibe-Trading-main/Vibe-Trading-main/frontend
npx tsc -b && npx vitest run && npx vite build
cd /e/Vibe-Trading-main/Vibe-Trading-main
python -X utf8 -m pytest tools/test_wiki_drift.py tools/test_wiki_qmind.py -q
python -X utf8 tools/forensics_audit.py
python -X utf8 -m pytest tools/test_forensics_spec.py -q
bash tools/wiki_freshness_gate.sh; echo "gate g7 rc=$?"
bash tools/ci_grep_gates.sh; echo "gate g8 rc=$?"
```

后两枚预期本机恒红：G7 页数超阈值、G8 只在 `[gate b]`。归属证据＝本片改动面与那两把尺的命中集求交集（`comm -12`）应为空行，且不调阈值不改门。把六门 rc 与两枚恒红门的归属证据写进报告。

- [ ] **Step 4: 报告与提交**

变异表写进 `.superpowers/sdd/2026-10-18-l3-slice4-workbench-aria/task-3-report.md`。本任务若无代码改动则**不产生提交**（`git status` 应只剩 `?? .superpowers/`）；若有改动（例如为某枚 HARNESS-BLIND 补针），照 pathspec ＋ `-s` 提交。

---

### Task 4: 浏览器活体验收（八步）＋未来函数豁免证据

**Files:** 无代码改动；读数进 Task 6 的档案。

**Interfaces:**
- Consumes: 本机 dev server（`frontend` → `npm run dev`，端口 5899；起服务前先按现读 PID 处理端口占用，**绝不按镜像名杀 `msedge.exe`**）。
- Produces: 八步 DOM 读数（Task 5 矩阵说明与 Task 6 档案引用）。

- [ ] **Step 1: 起自家页**

```bash
cd /e/Vibe-Trading-main/Vibe-Trading-main/frontend && npm run dev
```

后台起，等 5899 就绪，用 browser-use 的 `navigate_page` 打开 `http://localhost:5899/pro-chart`。**验收跑的是 dev 页**（本片纯属性面，不需要 prod 构建的 asset 指纹对账；那条纪律挂在「端点是否真注册」类判据上）。

- [ ] **Step 2: 打开工作台**

先 `take_snapshot` 找到工具栏上打开脚本工作台的那枚入口（可达名含「脚本工作台」或「指标」，按快照现读，不猜），`click` 它。

- [ ] **Step 3: 八步 DOM 读数**

用 `evaluate_script` 跑一次批量读数，返回 JSON 逐项打印：

```js
() => {
  const tl = document.querySelectorAll('[role="tablist"]');
  const tabs = [...document.querySelectorAll('[role="tablist"] [role="tab"]')];
  const sel = tabs.filter((t) => t.getAttribute("aria-selected") === "true");
  const dlg = document.querySelectorAll('[role="dialog"]');
  const mask = dlg[0]?.parentElement;
  const close = [...document.querySelectorAll('[role="dialog"] button')]
    .find((b) => b.getAttribute("aria-label") === "关闭脚本工作台");
  return {
    tablistCount: tl.length,                                  // 期望 1
    tabCount: tabs.length,                                    // 期望 6
    selectedCount: sel.length,                                // 期望 1
    selectedName: sel[0]?.textContent,                        // 期望「编辑器」
    tablistChildRoles: [...(tl[0]?.children ?? [])].map((c) => c.getAttribute("role")),
    dialogCount: dlg.length,                                  // 期望 1
    dialogModal: dlg[0]?.getAttribute("aria-modal"),          // 期望 "true"
    dialogLabelledBy: dlg[0]?.getAttribute("aria-labelledby"),
    labelledByText: document.getElementById(dlg[0]?.getAttribute("aria-labelledby") || "")?.textContent,
    maskRole: mask?.getAttribute("role"),                     // 期望 "presentation"
    ariaControlsCount: document.querySelectorAll('[role="dialog"] [aria-controls]').length, // 期望 0
    closeFound: !!close,
  };
}
```

- [ ] **Step 4: 切页复读**

`click` 「脚本库」那枚 tab，重跑 `selectedCount`／`selectedName`／`tabCount` 三件（期望 1／「脚本库」／6 不变）。

- [ ] **Step 5: 关闭按钮真关**

`click` 那枚 `aria-label="关闭脚本工作台"` 的按钮，复跑 `document.querySelectorAll('[role="dialog"]').length`（期望 0，关态整棵树不存在）。

- [ ] **Step 6: 未来函数豁免证据**

```bash
cd /e/Vibe-Trading-main/Vibe-Trading-main
git diff --stat main..HEAD
```

Expected: 代码面只含 `frontend/src/components/charts/IndicatorEditor.tsx` 与 `__tests__/ScriptWorkbench.test.tsx` 两枚 ＋ 文档面。**本片没有任何取数／序列计算／信号改动**，故不附 Bar Replay 五步自查——把这句与上面这条 `--stat` 输出一起留档，豁免是有证据的而不是口头声明。

- [ ] **Step 7: 收摊**

按**现读 PID** 关掉本席起的 dev server 与 Edge 实例（绝不按镜像名杀）。

---

### Task 5: L2 差距矩阵两行回灌

**Files:**
- Modify: `docs/forensics/gap-matrix.md:92`（TV-CI-04）与 `:93`（TV-CI-05）

**Interfaces:**
- Consumes: Task 1／2 落地的属性面坐标（**当场 `grep -n` 现读**）、Task 3 变异表、Task 4 活体八读数。
- Produces: 两行的新「状态／坐标／说明」三列（Task 6 档案引用它）。

- [ ] **Step 1: 现读坐标，不许引用计划里的号**

```bash
cd /e/Vibe-Trading-main/Vibe-Trading-main
grep -n -e 'role="tablist"' -e 'role="dialog"' -e 'aria-modal' -e 'aria-label="关闭脚本工作台"' \
  -e 'role="presentation"' -e 'aria-selected=' frontend/src/components/charts/IndicatorEditor.tsx
grep -n '^| TV-CI-0[45] ' docs/forensics/gap-matrix.md
```

- [ ] **Step 2: 改写 TV-CI-05 那行（`部分` → `已有`）**

五个竖线、六段一格不许多不许少（`tools/forensics_audit.py` 数这个形状）。第三列写 Step 1 现读的 `frontend/src/components/charts/IndicatorEditor.tsx:<行号>`。说明列要点含五条，措辞按实读收窄：
① 本仓六页 vs 对方五页是**页集合不同**不是缺页（本仓含条件筛选／脚本告警两页对方没有，对方的 Strategies／Profiles／Patterns／Options 内容在 L0 里没读）；
② 三条判据形状对上的现读计数（tablist 1／tab 6／selected 恰 1，活体读数与组件测试各一枚）；
③ 默认页 `editor`（`:91` 现读）由 `useState` 决定，另有分享链接 seed 切页；
④ **不发 `aria-controls`、没有 `role="tabpanel"`** 是本片裁定，理由是页身选中才挂载 ⇒ 逐 tab 发必悬空，代价（读屏切页不自动进内容区）写明；
⑤ 键盘 roving／Escape／焦点没有实现也没有判据级证据（L0 a7 明写未派发、未切页），本行不宣称任何键鼠行为。

- [ ] **Step 3: 改写 TV-CI-04 那行（保持 `部分`，理由换掉）**

状态列**不动**（仍 `部分`）。第三列坐标换成 Step 1 现读的 `role="dialog"` 那一行。说明列要销掉旧文的两句断言（「没有 role=dialog 也没有 aria-modal」「它没有可达名（无 aria-label，内容只有 X 图标）」）并写剩下的半：
① 本片落下 dialog＋aria-modal＋`aria-labelledby` 指向标题（可达名由标题文本解析，不是直填 aria-label）＋关闭按钮中文可达名；
② 仍缺**顶层搜索框**与**列表区三级标题**；③ 本仓搜索面确实有但既不在顶层也不是 `searchbox` 角色——`workbench/LibraryTab.tsx` 里那枚 `<input>` **没有 `type` 属性**（默认 `type="text"` ⇒ a11y 角色 `textbox`），行号由 Step 2 之外另跑 `grep -n '<input' frontend/src/components/charts/workbench/LibraryTab.tsx` 现读；
④ dialog 落在抽屉不是遮罩（遮罩 `role="presentation"`）；
⑤ 一句归属：本行升到 `已有` 还差的那两半**不在本片范围**，因为它们没有 L0 证据面（只打开、未 fill、未切页）。

- [ ] **Step 4: 跑三层咬合两门**

```bash
cd /e/Vibe-Trading-main/Vibe-Trading-main
python -X utf8 tools/forensics_audit.py; echo "g5 rc=$?"
python -X utf8 -m pytest tools/test_forensics_spec.py -q; echo "g6 rc=$?"
tr -cd '\r' < docs/forensics/gap-matrix.md | wc -c; wc -l < docs/forensics/gap-matrix.md
```

Expected: 两门 rc=0；`gap-matrix.md` 的 CR 与 LF 现读保持它本来的关系（2026-10-18 现读 CR＝LF＝120，即整篇 CRLF——编辑必须保持两把尺仍相等，改行数则两把尺同步增长）。

- [ ] **Step 5: 提交**

```bash
cd /e/Vibe-Trading-main/Vibe-Trading-main
git add -f docs/forensics/gap-matrix.md
git commit -s -m "docs(forensics): L2 回灌——TV-CI-05 升已有（tablist/tab/selected 唯一落满），TV-CI-04 仍部分并改写理由（dialog 三件套已落，缺顶层搜索框与三级标题）"
```

---

### Task 6: 档案 §7.28 ＋ 记忆更正 ＋ 最终整支评审

**Files:**
- Modify: `项目档案.md`（bytes 层追加一节 `### 7.28`）
- Modify: 记忆目录 `C:\Users\fire\.qoder-cn\projects\e--Vibe-Trading-main-Vibe-Trading-main\memory\`（`ops-delivered-features-and-comparisons.md` 增第 51 片条目；`chart-overlay-flags-lock-visible.md` 或新建一条「role 变更连带按名查 button 的针」经验）

- [ ] **Step 1: §7.28 只追加，bytes 层写**

`项目档案.md` 整篇 CRLF（2026-10-18 现读 CR＝LF＝2101）。**只能在字节层改**：Python 读 bytes、拼上以 `\r\n` 结尾的新段落、`write_bytes` 写回；写完复跑 `tr -cd '\r' < 项目档案.md | wc -c` 与 `wc -l` 两把尺（仍相等）＋ wiki 双套件与水位门（G4/G7）。
本节要写的五件：判态前后（两格）、四条裁定与各自的代价、变异表九条实测（含 HARNESS-BLIND 若有则定因）、活体八读数、十处连带改口的现读依据与「同一笔落地」的成因。
**自指戒律**：不写「本文件 N 行」「本片共 X 笔」「HEAD=…」这类当场即失效的话；条数只写判据形状不写总数；引用命令的条数要标明是哪把尺（次数 vs 命中行）。

- [ ] **Step 2: 记忆更正**

两条：① 已落地特性表加第 51 片一行（分支名、判态变化、坐标一律现读不写号）；② 新增/补一条对偶经验——**改 `role` 会把既有按名查 button 的针整批改掉**：动手前先 `grep` 数出受影响处数（这把尺要同时扫 `src/pages/__tests__` 与组件测试目录），实现与改口**同笔提交**，否则中间那笔全量测试必然红且无法自证是「角色迁走」。写进 `ops-react-page-silent-failures.md` 或 `plan-text-red-at-execution.md` 里最合适的那条（后者已有「拆『改签名·改消费者』两笔⇒中间提交 tsc 红」的同型病灶，**优先补到那条**）。

- [ ] **Step 3: 最终整支评审**

`git log --oneline main..HEAD` 收口，dispatch 一个评审席跑 `scripts/review-package <plan> <BASE=main 末端> <HEAD>`，评审范围＝整支（代码＋测试＋矩阵＋档案），并复核：CRLF 不变量、`[aria-controls]` 零计数、禁抄红线（`frontend/src/**` 无对方英文字串）、两枚恒红门归属、判态声明不超过证据面。发现 → 一轮修复 → 一枚收窄复评席 → 残留逐条裁定并记台账。

- [ ] **Step 4: 台账与收口**

`.superpowers/sdd/2026-10-18-l3-slice4-workbench-aria/progress.md` 每任务一行 `Task N: complete (<commit>)`。合回 `main` 与推送 `origin` **各要用户单独点头**——一次授权不等于长期授权；若本轮沿用「全程自主推进」那句长期授权，执行前要在报告里把这句的适用范围写清并先验 `ls-remote` 真值（管道尾的 `$?` 是 `tail` 的不是 `git push` 的）。
