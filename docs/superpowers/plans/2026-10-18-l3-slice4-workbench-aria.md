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
① 本仓六页 vs 对方五页是**页集合不同**不是缺页（本仓含条件筛选／脚本告警两页对方没有；对方那四枚未选中页签的页名只活在 `docs/forensics/l0/tv-a7-indicator-dialog.md:113-116` 的转述段里，那里是本仓唯一合法身份，按纪律不抄进本文件——本行上一版把四枚名字逐字写在这半句里，属违令，改口与口令见 `追加更正（八）`）；
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
本节要写的五件：判态前后（两格）、四条裁定与各自的代价、变异自证十一枚注入实测（含 HARNESS-BLIND 若有则定因）（2026-10-19 原地改口：本行原稿把这件数写成「九条」，那枚数在仓里任何一把尺下都不成立——spec §4.3 那张表 8 行、本节 `:299` 原稿写十枚、MUTS 实际 11 枚键（m1…m11，第 11 枚是评审轮补的）；执行席落的是十一枚并逐名列出，缺陷未扩散。旧字面取回＝`git show 7c15798f:docs/superpowers/plans/2026-10-18-l3-slice4-workbench-aria.md` 第 564 行，详 `追加更正（八）`），活体八读数、十处连带改口的现读依据与「同一笔落地」的成因。
**自指戒律**：不写「本文件 N 行」「本片共 X 笔」「HEAD=…」这类当场即失效的话；条数只写判据形状不写总数；引用命令的条数要标明是哪把尺（次数 vs 命中行）。

- [ ] **Step 2: 记忆更正**

两条：① 已落地特性表加第 51 片一行（分支名、判态变化、坐标一律现读不写号）；② 新增/补一条对偶经验——**改 `role` 会把既有按名查 button 的针整批改掉**：动手前先 `grep` 数出受影响处数（这把尺要同时扫 `src/pages/__tests__` 与组件测试目录），实现与改口**同笔提交**，否则中间那笔全量测试必然红且无法自证是「角色迁走」。写进 `ops-react-page-silent-failures.md` 或 `plan-text-red-at-execution.md` 里最合适的那条（后者已有「拆『改签名·改消费者』两笔⇒中间提交 tsc 红」的同型病灶，**优先补到那条**）。

- [ ] **Step 3: 最终整支评审**

`git log --oneline main..HEAD` 收口，dispatch 一个评审席跑 `scripts/review-package <plan> <BASE=main 末端> <HEAD>`，评审范围＝整支（代码＋测试＋矩阵＋档案），并复核：CRLF 不变量、`[aria-controls]` 零计数、禁抄红线（`frontend/src/**` 无对方英文字串）、两枚恒红门归属、判态声明不超过证据面。发现 → 一轮修复 → 一枚收窄复评席 → 残留逐条裁定并记台账。

- [ ] **Step 4: 台账与收口**

`.superpowers/sdd/2026-10-18-l3-slice4-workbench-aria/progress.md` 每任务一行 `Task N: complete (<commit>)`。合回 `main` 与推送 `origin` **各要用户单独点头**——一次授权不等于长期授权；若本轮沿用「全程自主推进」那句长期授权，执行前要在报告里把这句的适用范围写清并先验 `ls-remote` 真值（管道尾的 `$?` 是 `tail` 的不是 `git push` 的）。


## 2026-10-18 控制席追加更正（一）：Task 5 简报把「停在某一页」的活体读数当成了全浮层形状（复评席 Critical 1，原句保留）

- 病灶落点：`:530` 的「② 仍缺**顶层搜索框**与**列表区三级标题**」与 `:532` 的「因为它们没有 L0 证据面（只打开、未 fill、未切页）」两句被席位逐字转录进 `docs/forensics/gap-matrix.md:92`，于是「三级标题缺」这句假话进了被跟踪文件。
- 盘面（控制席第一方复跑，vite dev 5899，选择器逐字 `[role="dialog"] h2, [role="dialog"] h3`）：「编辑器」页 3 枚、「导入导出」页 2 枚、其余四页各 0 枚；`searchbox` 角色六页各 0 枚。列表区那两枚＝`EditorTab.tsx:286`／`:332`，都早于本片。
- 成因＝**中间态当全集**：页身按选中挂载（`IndicatorEditor.tsx:309`／`:323`／`:327`／`:331`／`:333`／`:344` 六处条件渲染），停在脚本库页读到的零枚只描述脚本库那一页。⇒ 往后简报里「整棵 X 里 Y 零枚」这类断言必须自带**读取时的状态**（哪一页、哪一态），不带的零枚读数不许进简报；`task-4-report.md` 那枚 `bodyHeading` 连选择器都没留档，也是同一笔账。
- `:532` 那句「没有 L0 证据面」同样过宽：L0 对搜索框与列表标题各有一枚**存在性**读数（`docs/forensics/l0/tv-a7-indicator-dialog.md:110`／`:117`），那正是 L1 该格四条计数里的两条。真缺的是**行为与内容面**。矩阵已按此收窄，判态 `部分` 不动。
- 连带一笔没认领的账：`:550` 的模板消息被逐字用成提交 `0353065f` 的消息，里面「缺顶层搜索框与三级标题」现在半假。**裁定＝不改写那笔提交**（号已在台账、评审包文件名与复评词里被引用，改写会拔掉别人的坐标；本仓纪律是「一次一个面＋旧文不删」），改口由本轮修复提交的消息＋矩阵行 92 承担。

## 2026-10-18 控制席追加更正（二）：spec 裁定四引用的 L0 行号指错，内容照旧成立（控制席自查，原句保留）

- `docs/superpowers/specs/2026-10-18-l3-slice4-workbench-aria-design.md:47` 写「L0 那份记录 `:139` 明写**未派发 Escape、未切换 tab**」：那两件事逐字确在 L0，但在 `:8`，不在 `:139`（`:139` 讲的是对话框有哪几页、哪些控件名）。⇒ 内容不动、坐标改对，已在原地落带日期子句。
- 本条要同时记一笔**控制席自我推翻**：复评之前控制席曾裁定「四处（spec／`plan:18`／`plan:524`／矩阵两行）都把 L0 没写的话写成『明写』」，那是错的——当时只读了 `:146` 与 `:9`，没 grep 全文，漏了 `:8`。四处里只有 spec 这一处是坐标错指，其余三句成立。**（2026-10-19 路标：这句的枚举本身过窄——spec 内同形错指有**两处**（`:15`／`:47`），`df22faa7` 那一版只把 spec `:47` 的坐标改对；改口与取证见本节下方 `追加更正（四）`（`:600`）的 N-3 条（`:606`），被推翻那句的原文照例不删（本括注自身在 R=4 改写过一次，旧文按 `git show 8cba0f78` 本版第 591 行取）。）****过宽的否定句与过宽的肯定句是同一枚病的两面**：判「没有证据」之前要先跑一次全文 grep，和判「有证据」之前要跑一次一样。
- `:18` 与 `:524` 这两句「L0 a7 明写未派发 Escape、未切页」内容真、没给行号。⇒ 简报里「L0 明写 X」这类引用**必须带行号**：不带号的引用错不到自己头上，会顺延到下一份抄它的文件（本片是 spec 抄走并把号写错），而 spec 是评审与后续片段的读源。

## 2026-10-18 控制席追加更正（三）：Task 5 简报递的是逐字旧文，席位抄成了转述（复评席 Important 2，属席位失误不是简报病灶）

- 复评席读数（本席复跑同形）：`git show cd0bd9fa:docs/forensics/gap-matrix.md | sed -n '92p' | grep -c -F '那枚关闭按钮没有可达名'` → 0（rc=1），而逐字版「但它没有可达名（无 aria-label，内容只有 X 图标）」→ 1；L1 那条逐字带两层引号的「不许把「有 searchbox」写成「可按关键字过滤」」被抹平成单层后，`grep -c -F` 打 `docs/forensics/spec/chart-interaction.md` 得 0。
- 形状名字＝**引号里装转述**。本仓这些账是拿 `grep -c -F` 还的，引号里放同义改写等于把可复算的那半截证据销掉。简报 Step 3 当时给的正是逐字版 ⇒ 这一条不计「计划病灶」，计席位组织语言失误；两处均已改回逐字。
- 同族第二例登记：矩阵 CI-05 的「连带 9 条 `it` 红（本行的三条 aria 判据＋十处按名查页签的行为针）」按 3＋10 数不出 9，而席位自己的 `task-3-report.md:98` 记的是「2 枚 aria `it` ＋ 7 枚页签导航 `it`，那七枚含十处查询」⇒ 简报（`:392`）只承诺「两条新 it 全红」，这处分解句是席位自己组织的，同属组织语言失误，已按台账的 2＋7 改写。

## 2026-10-18 控制席追加更正（四）——收窄复评判「部分」：九条全落地，但本轮在自己刚命名的那味病上重犯

复评席（`task-5-rereview.md`，只读席）判上一轮九条 findings **无一条 `未落地`**，全部 `已落地`；另立 N-1／N-2／N-3 三枚必修与 N-4…N-7 四枚 Minor，总判决因此是 `部分` 而非 `addressed`。本节记下逐条裁定；除注明外，本席都**自己重跑过复评席那条读数**，没有采信转述。

- **N-1 矩阵行 92 领句自相矛盾（必修）**——成立。同格现读并存「四件判据控件现在对上三件」「真缺的那件是顶层搜索框」「剩下两半仍缺」「本行升到已有还差的只有搜索框那半」：上一轮把 ② 改成「有对应物」，**却没同步改那句把 ①② 都算成缺的领句**。修法＝领句改成「真缺的只剩那一半」＋带日期归属。**旧领句不重抄**：`0353065f` 那一版留原文，被跟踪面上不回填一枚已知为假的串——这是文档自指那一族的老账（逐字复写被删串＝自己喂下一席那把尺）。这里与「原文不删」纪律不冲突，因为那条护的是**读数**，而领句是本行自己刚写的**断言**。
- **N-2 「引号里装转述」重犯（必修）**——成立，且落点是 **四处**：矩阵行 92、行 93、spec `:47`、spec `:15`。L0 `:8` 的真形是 `**只打开，…未添加任何指标**、未派发 Escape`（中段自带 markdown 强调符）；不带 `**` 的 needle 在 L0 里 `grep -c -F` 现读 **0 命中**，带 `**` 的现读 **1 命中**。⇒ 三处自称「逐字写着」的引用全都拿不到自己承诺的那笔账。修法＝矩阵两处与 spec `:47` 的反引号里改回带符逐字形并写明「原句自带强调符，照抄是为可复算」。**语义从头到尾没动，故判 Important 不判 Critical**；但成因要写清：上一轮 `追加更正（三）` 刚把这味病命名成「引号里装转述＝把可复算的那半截证据销掉」，**下一轮就重犯——命名不等于免疫，病名要落进简报的检查项，不能只落进台账**。
- **N-3 spec `:15` 的 `:139` 错指未平账（必修）**——成立。本席现读 `:139` 全行＝「**本面撑得住的结论（对话框有哪几页、每页有哪些控件名）**：…⇒ 「指标对话框顶层有五页签…」这句话到名字级有证据面」，不含动作纪律那句。⇒ 上一版那句「四处里只有 spec 这一处是坐标错指」的枚举**漏了 `:15`**（`grep -n ':139'` 现读 spec 内两处命中），那句话本身过窄为假。修法＝`:15` 原地补带日期括注＋本节把枚举行改口；`plan:18`／`plan:524` 两句本席现读确未给行号，仍成立。
- **N-4 行 93「按台账」＋条内归属＋人称**——成立。本文件自己的既有口径是「它落在 `.superpowers/` 里那枚**未跟踪**的评审 scratch 上……本格不拿它当坐标」（TV-CI-02 格现读），行 93 新写的「按台账是 2＋7＝9」正违反它。修法＝换成仓内静态尺：本席现读 `grep -c 'ByRole("tab"' frontend/src/components/charts/__tests__/ScriptWorkbench.test.tsx`＝**14**，其中按名查询 **11** 枚（`154 177 200 209 218 241 248 253 266 272 444`）——10 枚在那七枚导航 `it` 体内、第 11 枚 `:444` 属 aria `it`；九枚红的留档明确写成「不当坐标」。同时给本轮新增的 `:439`／m11／9 枚红三处补「本席 2026-10-18 现读」。**人称**：矩阵「本席第一方复跑」与计划／提交消息／`task-4-report.md:149` 的「控制席第一方复跑」是同一动作的两种自称，本轮统一成后者并写明「起浏览器的那一席就是写这行改口的这一席」——复算者从矩阵分辨不出谁起的浏览器，就是归属没做到位。
- **N-5 行 83 的第二把尺同被本片染脏**——成立。`grep -rln -e tablist -e 'role="tab"' frontend/src` 本席现跑 **5 枚**文件（`IndicatorEditor.tsx`／`ScriptWorkbench.test.tsx`／`WelcomeScreen.tsx`／`RunDetail.tsx`／`RunDetail.test.tsx`）：旧清单那三枚仍在，多出的是本片自己两枚。上一轮只就第一条命令落了改口子句 ⇒ 同格第二条命令的同类漂移未并账。修法＝同一括注里并一句。
- **N-6 `task-5-report.md:33` 两句仍冒充**——成立，面在未跟踪 scratch（`git status`＝`?? .superpowers/`，不进提交）。上一轮 Important 2 的附属修法「把报告里『逐字销掉』那半句改成实情」确实没做，本轮就地改口。
- **N-7 `Tests 18 passed (18)` 空白归一化**——成立。留档去 ANSI 后是 `Tests␣␣18 passed (18)`（双空格），矩阵写的是单空格形且未自称逐字 ⇒ 非语义错。修法＝原地注明双空格，**不改引号本体**：换成一枚真双空格的收益只有保真，代价是下一席肉眼看不出差别、还可能被工具折叠。
- **`searchbox` 口径裁定**（复评席请裁）：**判不违令、维持现状**。禁令的对象是「对方页面的档位名／键值／控件名英文原文」；`searchbox` 是 ARIA role token，且在矩阵里的两味身份都不读对方页面——① 是被跟踪的 L1 文件**自身原文**的逐字引用（Important 2 要求必须逐字，只能带它），② 是本仓自家 DOM 的选择器字面量。上一轮 D 栏把「写成中文」记为加分，那记的是**更保守**，不是**禁令要求**；保守与合规不冲突，本行以合规为准，并在本节留下这枚裁定以免下一席再问。真红线复算：**那一族对方档位名／键值／控件名（清单只活在 `docs/forensics/l0/**` 的转述段里，那里是本仓唯一合法身份，本席不复抄进计划——上一句就是把清单复抄进被跟踪面、同时自称「0 命中」，属于自己喂自己那把尺，已由本句改掉）**按「本轮净新增」这把尺现读 **0 命中**；2026-10-19 复评 I-1 给这句补两枚限定——①**字面**跑 `git diff df22faa7..90d5c3a1 -- docs | grep '^+'` 得 **4 枚**命中，落在两枚*被修改行*上（矩阵行 83 与 spec `:15`；本尺不含 `searchbox`——它由本条前半的裁定归为 ARIA role token，不在「对方控件名」那一族里），逐枚拿 `git show df22faa7:<file>` 取同一行再 `sed -n '<行>p'` 与现版同一行比＝差集 0，四枚全是该行**保留的旧文**；把「保留旧文」算成「本轮新增」是这把尺的口径错，不是禁令违例，本句不复抄那些名字（复抄即亲手把它从 0 变成 1）。②同句引的 `-- frontend`＝0 字节原本只写了上一轮窗口 `0353065f..df22faa7`，本轮窗口 `df22faa7..90d5c3a1` 现跑同样 0 字节，两把都记在这儿，属范围漂、本句改掉。下一席若要复算这枚 0，判据从 L0 转述段的引号内容当场取，别从本计划取。
- 复评席「观察（不立条）」登记备用：`EditorTab.tsx:145` 那枚 `<h3>` 的**文本**是条件式（`:146` 逐字 `{draft.id ? "编辑脚本" : "新建脚本"}`）——枚数 3 稳定、文本随状态搬家。矩阵只把它放在活体读数串里、没当静态坐标使，本轮不动；**若下一席要拿「新建脚本」当断言，先问它处在编辑还是新建态**。

**本席判自己（一枚纪律补充）**：本轮三枚必修是同一族——改了一件断言的**件数**，没扫同格里所有提到那件数的句子（「对上三件」改了，「剩下两半」没改）；自称「逐字」的引用没逐条回跑一次 `grep -F`；写「只有这一处」这类枚举完备性断言时没先把该模式的全文命中数列出来。补成的口令：**改件数要重扫全格，写「逐字」要当场 `grep -c -F`，写「只有」要交命中数。**

## 2026-10-19 控制席追加更正（五）——第三轮复评只剩一枚必修，且是「对自己这一刀的描摹不中」

第三轮复评（`task-5-rereview-3.md`，488 行）判 I-1／M-2／M-3 三条 `已落地`、M-1 `落地但改成新错`。本席逐条自己复跑后再落笔（下面每条都带本席实跑的命令与读数，不是转述）：

- **M-1 的必修（唯一）**：spec `:15` 本席上一轮写的那句自称「原句照例不删」，本席用 `git show 90d5c3a1:` 同一行与现版对比，确认被吃掉的是**尾半**、以「」逐字引回的是**头半**（那串按**行**记：spec 第 15 行 `grep -c -F` 现读 1 行；本计划不复写那把尺的字面，复写了本行自己就成了第二枚命中——见下方 `:621` 记的那型；要复算请从 spec 第 15 行当场取串）。那半尾串本处不复抄：复抄会让「尾半不在跟踪面」这枚读数当场失效——这一味（复抄即亲手把一枚「0 命中」的读数染成非 0）的形状已由本节上方 `searchbox` 那条命名过（那条在 `:611`，它给这味的字面名作「自己喂自己那把尺」，本句引的是那一条的名，不是被数的半串）。⇒ 自述与实跑互斥，即复评第三轮 M-1 所命名的那一型「对自己刚动过的这一刀自述失实」。修法＝按实情写两半的命运（头半引回可 `grep -F`、尾半不在跟踪面＋给 `git show 90d5c3a1:` 的取回坐标），本笔已由 R=4 落地。
- **两枚 Minor 一并还**：计划 `:611` 内嵌命令里那枚「反斜杠紧跟竖线」的转义形，逐字粘进 shell 会 `rc=128`（本席 2026-10-19 现跑同形状一条：`git show df22faa7:docs/forensics/gap-matrix.md` 后面接转义竖线再接 `sed -n '92p'` → rc=128，`fatal: ambiguous argument`），故改成交错两句（先 `git show` 取行、再 `sed -n` 比对）；同句补「本尺不含 `searchbox`」的豁免面，免得下一席拿「4 枚」去数含 `searchbox` 的集合；`:591` 路标里「本句只钉了 `:47`」的「本句」指错对象——被推翻的那句从未枚过号，枚号的是它上面那条 `:590`（复评第三轮 Minor 2 给的修法），本笔改成点名提交的形状「`df22faa7` 那一版只把 spec `:47` 的坐标改对」。本行把被改掉的那半句以「」引回，所以唯一命中就在本行：本席 2026-10-19 现跑 `grep -c -F`（按行）＝1、`grep -o -F`（按枚）＝1。**这两个数本来会不一样**——本行早前一版把「数这串命中几条」的命令原样写进了同一行，于是按枚＝2、多出的那一枚正是那把尺自己（文档自指那一族里「复跑命令写进被它扫的那个文件」那型的**同一行版**：前一型跨文件，这一型连行都不出）。本席发现之后把命令里的被数串抽掉，枚数才回落到 1。⇒ 口令：**要在一行里既引回一枚串、又报它的命中数，就别把那把尺的字面写在这行**；否则只能报「按行」并写明口径。`:591` 原位那枚命中已消失——别拿这串当「已消失」的尺，它现在只消失在那个行上。同笔再做两件：把 `:591` 那句「本句原文照例不删」限制成「被推翻那句的原文照例不删」，因为「本句」自指到括注自身就是假的（本括注自己在 R=4 改写过一次，旧文坐标随本句写进 `:591`），这枚形状与 M-1 在 spec `:15` 上判的完全是同一枚；再给 `:591` 的路标补上被指节与条的行号（`:600`／`:606`，本席现读两枚未漂）。
- **本节的旧文指针（复评第三轮观察 O2：就地改写未留指针）**：本轮与上一轮在跟踪面上吃掉的旧文，逐枚可从 git 按**行**取回。指针只给「哪一版・哪个文件・哪一行」，**一律不复抄旧串**——本计划上一版就是为了让指针「可验证」而把旧串抄进跟踪面，结果那枚「现在 0 命中」的尺当场被自己喂脏（见 `:611` 那条的自我推翻）。复算配方：`git show <号>:<相对路径>` 取该行，再与现版同一行做逐字符差集；差集非空即旧文确实在那一版。
  - ① 矩阵行 92 那句把 ①② 都算成缺的旧领句：`0353065f` 与 `df22faa7` 两版都在，`90d5c3a1` 吃掉 ⇒ 取回看 `git show df22faa7:docs/forensics/gap-matrix.md` 第 92 行（矩阵是 CRLF，按行取时别拿它做替换）。
  - ② spec `:15` 那条括注被本笔改掉的尾半：只在 `90d5c3a1` ⇒ `git show 90d5c3a1:docs/superpowers/specs/2026-10-18-l3-slice4-workbench-aria-design.md` 第 15 行。
  - ③ 那一版把强调符的**位置与枚数**写错了（说成住在中段、说成两枚；实情是前后各一枚，且引号从「只打开」起只带得住尾部那一枚）：`90d5c3a1` 版矩阵第 92／93 行各一枚、spec 第 47 行一枚，`8cba0f78` 起三处全部为 0 ⇒ 逐处 `git show 90d5c3a1:<该文件>` 再按这三行取。本条给的是旧句**大意**，不是它的字面，别拿本条的措辞当 needle 去跑。
  - ④ 计划那句把「保留的旧文」算进「新增行」的过宽范围词：只在 `90d5c3a1` 的第 611 行 ⇒ `git show 90d5c3a1:docs/superpowers/plans/2026-10-18-l3-slice4-workbench-aria.md` 第 611 行。
  本席 2026-10-19 逐枚跑过这四条配方（上面每枚数都是现读，不是转述）。**同批登记本席自己这一轮的失误**：本节初稿的 ③／④ 两条各写了一枚自造的引号串、当作「`90d5c3a1` 里的原文」，本席现跑 `grep -o -F` 在 `90d5c3a1`／`8cba0f78`／工作树三处**全部 0 命中**——那两串从未存在于任何版本，是凭记忆造的假 needle；初稿还给 `:591` 那句配过一枚「某串只出现在某行」的完备性断言，现跑同样为假（同一枚串在计划里另有命中）。⇒ 口令补一条：**指针只给坐标；引号只有当场 `grep -F` 命中过才许写；「只出现在」这类完备性断言必须交出现场命中数。**
- **日期口径**：本片的 L0／活体／矩阵读数都在 2026-10-18，修复轮 R=2 起跨到 2026-10-19，故同一文件里「2026-10-18」与「2026-10-19」并存**不是笔误**——前者是取证日、后者是改口日。拿日期做一致性检查的席请注意这条区分，别把「改口日期」抹成「取证日期」。

**成因升级成口令（这一味「对自己刚动过的那一刀自述失实」本轮又落了数次）**：本轮落笔后、提交前，本席按上一节那条口令把新写的每一枚断言回跑一遍，抓到下面这几件，全在 R=4 这笔里改掉（**故意不写总数**：写了就得再数一遍，而本行本身就是那一遍里的改动——这正是本族第一型）：① spec `:15` 那句「原句照例不删」对不上差集实跑（复评 M-1 判的正是它）；② 旧文指针 ③／④ 两枚自造的假 needle；③ 一枚「某串只出现在某行」的完备性断言（现场另有命中）；④ 同一行里既引回某串又报它的命中枚数，那把尺自己成了多出来的一枚（见上方 `:621`）。这枚病从不在**外部**文件上，只在**描述自己这一刀**的那半句上——而它每次都被同一件事治好：落笔之后当场把每一枚断言跑一遍，别等下一席。补成三条口令：写「原文不删」之前，先跑一次 `git show <上一笔>:<文件>` 与现版的逐字符差集，确认差集为空再落这四个字；差集非空时，必须写成「X 半引回、Y 随本句改写、旧文在 <号>」这种**两半各有下落**的形状。写「本句／本节」这类自指之前，先问它指括注自身还是指被推翻那句，指错了就把限定词写死（本轮 `:591` 就干过这件事）。写「只出现在」之前，先把命中数交在句子旁边，或者干脆别写枚数与范围。

## 2026-10-19 控制席追加更正（六）——R=5：一枚 R=4 旧账，加一枚「修复自己把描述改脏」

R=4 那笔（`52b3983f`）落地后，第四轮收窄复评判四条 carried 全部 `已落地`，另给一枚 Important 与两枚 Minor；本席逐条自跑复核为真，修法跨**两笔提交**（号一律现读 `git log --oneline main..HEAD`，本节不钉）：前一笔落复评三件＋本席自纠的两件＋登记本节；后一笔改掉本节**初稿自己**又落的两枚失实（一枚死指针：把水位门的归属指给了从未提过水位的 `追加更正（四）`；一枚归因错日：把 R=5 现版的按枚读数记成 R=4 那句当时的假账，而 R=4 版两把尺都是 1、那句在当时成立）。更要紧的是：**本席把 R=4 已提交文本里的每一枚计数断言重跑了一遍**（上一节那句「落笔之后当场把每一枚断言跑一遍」对本笔同样成立，但 R=4 那一遍只扫了当轮新写的句子，没扫 R=3 留下、R=4 又改过的句子），抓到**两枚要登记的**，都是本族的旧型换新装，但**归属不同日**：一枚是 R=4 文本里就有的旧账（病灶乙），一枚是本笔为满足复评而补坐标时**把描述自己的那句改脏**（病灶甲）：

- **病灶甲＝修复的那一刀把描述自己的那句改脏（按行与按枚两把尺在此分岔）**。spec 第 15 行 R=4 版有一句「某个命令关键词在本文件只出现在第 15 行这一处」——本席当场把两版都跑了：**R=4 版按行 1／按枚 1，那句在当时成立**；本笔为满足复评 Important-1 补进两枚真实取回坐标，按枚被**自己**抬到 3（仍全在第 15 行内，其中一枚正是那句话自身），若继续只写「这一处」就成了假账。⇒ 修法不是删数字，而是**两把尺都写在句子旁边并点明自指那一枚**：现版该句同时给按行 1／按枚 3／`:100` 以后 0 三个读数，本席落笔后复跑三个数都对得上（三个数都是 **R=5 现版**的，R=4 版那两个 1 不在本账内；本条不复抄被数的串，要复算从 spec 第 15 行当场取）。这型与前几枚不同处在于：**它不是落笔时就不会算，而是修别处时把「我修了什么」那句话的读数改漂了**——所以复算必须在修复落地之后、提交之前，不能在派单之前。⇒ 口令补一刀：**凡「只出现在」后面的单位可能是行也可能是枚，就把两把尺一起交出去**；只交一把，另一把的读数早晚成为那句话里的假账。（**2026-10-19 最终评审 M-4 复评本行**——本行那句「现版该句同时给按行 1／按枚 3／`:100` 以后 0 三个读数，本席落笔后复跑三个数都对得上」在 `追加更正（六）` 落笔当时为真，`（七）` 往 spec 第 15 行再补一枚取回坐标后按枚抬到 4；本席 2026-10-19 现跑 spec＝按行 1／按枚 4，与 `（七）` 自己那句「按枚＝4」一致。这就是 `追加更正（七）` 立的那枚「相对版本词每改一版过期」在本行自身应验：「现版」二字正是那枚动态 ref。绝对坐标＝`git show 809a035a:docs/superpowers/specs/2026-10-18-l3-slice4-workbench-aria-design.md` 第 15 行——那一版的三个数才配得上「都对得上」那句话。原文不删，由本括注改口，详 `追加更正（八）`。）
- **病灶乙＝引号里装转述，且转述被当成「被引那条的字面名」**。spec 第 15 行与本节上方 `:620` 在 R=4 版里各有一枚带引号的串，用来指认 `:611` 那条 `searchbox` 条目「命名过」这味病——那枚带引号的串本席当场核对过：它既不在 `:611` 那一行，也不在 R=5 落笔后的两枚跟踪文件里（逐枚 `grep -c -F`＝spec 0／plan 0），旧形取回看 `git show 52b3983f:` 对应行；本条不复抄它。这是上一节口令里「引号只有当场 `grep -F` 命中过才许写」的同型复发：本席这次引的是**自己造的名字**，却写成「那条命名过」，等于把转述包装成引用。修法＝两处都改成「本句给大意，字面名在 `:611`，本句引的是那条的名而不是被数的半串」，串本身不复抄（本条也不报它的命中枚数——`追加更正（五）` 那把「只在某行命中一处」的尺就是被这种复抄喂脏的，枚数一律留给下一席现跑）。⇒ 口令补第二刀：**引号要么是被引文本的字面（当场 `grep -F` 过），要么就明写「大意」二字**；「某某命名过／某某写的是」这类归属句里的引号，先跑一次「那串在被引处命中几枚」。
- **R=5 本笔的读数（全部当场现跑，非转述）**：`forensics_audit.py`＝clean；`pytest tools/test_forensics_spec.py -q`＝166 passed；`git diff HEAD -- frontend tools docs/forensics`＝0 字节（代码面与本片的 L0／L1／L2 三层件本窗零改动）；矩阵形状尺＝CR 120／LF 120、`awk -F'|'` NF==7 的数据行 15，第 92 行状态列 `部分`、第 93 行 `已有`；净新增对方控件名尺＝difflib **配对逐行**差集（候选 8 枚当场从 `docs/forensics/l0/tv-a7-indicator-dialog.md` 的引号内大写串取，不写进跟踪面；窗口＝`52b3983f` 对**本轮全部落地后的现版**，本笔跨两枚提交，故别拿单枚提交的 diff 复算），判定 **0 枚**——同一批用不配对的朴素尺跑会得 2 枚假阳性，成因就是 `:611` 记过的那口径错：被修改行上保留的旧文不是净新增。
- **`ci_grep_gates.sh` 的恒红归属**：rc=1，红只在 `[gate b]`（那枚商标字面）。本笔现读命中文件 21 枚，比 R=4 基线多 **1** 枚；多出那一枚＝本计划自己的 scratch 目录里第四号复评报告的正文原样引了门输出（`.superpowers/` 未跟踪、`docs/` 整棵被该门排除）。逐枚 `git ls-files --error-unmatch` 判 21 枚**全部未跟踪**，本笔两枚跟踪文件各自计数 0 ⇒ 跟踪面对本门零贡献。阈值一字未动、门一字未改、既存白名单一枚未清。另一枚本机恒红的水位门（G7）本窗同样未调：本席落笔后现跑 `bash tools/wiki_freshness_gate.sh`＝rc=1、`wiki stale pages: 446 (threshold 439)`，与本计划留档的前轮读数**逐字相同**（`diff` 无输出）⇒ 本窗改的两份文档在 `docs/superpowers/**`，不在该门的页扫描面里（扫描面由 `tools/wiki_drift.py` 的 `WIKI_ROOT_DEFAULT` 定死，本席现读其值＝`repowiki`），对它的贡献为 0。

## 2026-10-19 控制席追加更正（七）——R=5 封顶：第五席残留六枚逐条裁定，加一枚「相对版本词自己会过期」的口令

第五轮收窄复评（本报告留档于本计划的工作目录，文件名 `task-5-rereview-5.md`）裁决 `部分`，Critical 零枚，carried 五条无一「未落地」，残留四枚 Important＋两枚 Minor。修复轮到顶 ⇒ **本席不再开第六轮**，改为本节逐条裁定：五枚属「写下时即为假」，按本仓纪律就地改正＋原文不删，由本席这一笔落；一枚（I-4）是 L2 回灌那笔留下的旧账，本席裁定**同笔补标注、不挂账**——理由＝它是全部残留里唯一一枚能让下一席在一棵干净的树上当场判假的旧文，成本只有一枚括注。每条的数本席自己重跑过，不采信派单与报告里的数（派单里的数字会被下一席当证据，这一型本仓记过）。

- **I-1 落地，并把成因从「漂一代」改判为「写下时即假」**。第五席说 spec 第 15 行那句把取回坐标称作「紧邻前版」并点名 `8cba0f78`，限定词漂了一代；本席的版本对账不同意它的成因，但同意它的判决：那枚限定词与 `8cba0f78` 坐标是**同一笔**由 `6f3ff582` 写进第 15 行的（实跑＝该行含「紧邻前版」在 `8cba0f78`／`52b3983f`＝0、`6f3ff582`／`809a035a`＝1；含 `8cba0f78` 同形 0/0/1/1），而 `6f3ff582` 落笔时本行真正的紧邻前版是 `52b3983f` ⇒ 这枚限定词从写下那一秒起就是假的，不是被后来的提交漂过去的。两版第 15 行确是不同字面（本席现跑 `wc -c` 含行尾换行：`8cba0f78` 1540／`52b3983f` 2188）。修法＝spec 第 15 行末尾追加一枚带日期括注：明写「隔一版」、给出真实紧邻前版的可复制坐标、并把计数连同追加自己一并交出。
- **I-2 落地（改判方式＝不复抄，明写它是转述）**。计划 `:637` 把一枚 8 字串（该行第 6 枚「」内的串，len 8、md5 前 8 位 `87f0538e`）用引号归给 `追加更正（五）`。本席实跑：该串在（五）正文 `:616-631` **按行 0**、全文件唯一命中＝`:637` 自身；而（五）里那把尺的实际措辞是**另一枚** 8 字串（len 8、md5 前 8 位 `c8aaac23`），命中行＝`:627`（该行第 2 枚「」）／`:630`（该行第 3 枚「」）；两枚本席都不复抄。⇒ 判决＝「大意被包装成被引处的字面」，与 `:637` 自己同一句立的口令同型违例，可当场判死。修法＝由本节明写它是转述、按坐标交出真串住哪几行，不复抄任一枚（复抄即亲手喂尺，见 `追加更正（四）`／`（五）` 记过的同族）。
- **I-3 落地（数字真，归属与那张「当时成立」的证书假）**。计划 `:636` 写「spec 第 15 行 R=4 版有一句『……』（该行第 1 枚 24 字「」串）……那句在当时成立」。本席实跑：那枚 24 字串在 `52b3983f` 版 spec 第 15 行＝0、现版 spec＝0，探针「只出现在」在现版 spec＝0；R=4 版第 15 行该处的真句是一枚**指向不存在节号的旧文指针**（`52b3983f:15` 含「旧文按」＝1，现版＝0；可复制取回坐标＝`git show 52b3983f:docs/superpowers/specs/2026-10-18-l3-slice4-workbench-aria-design.md` 第 15 行，本席不复抄那 5 字），而那枚指针正是第三号复评所判的假坐标。⇒ 「只出现在第 15 行这一处」这类句子**从未属于 R=4**，它是 `6f3ff582` 本轮自己新写的；R=4 的两个读数（按行 1／按枚 1）与 R=5 的三个读数都为真，但把后者写成「吃掉了 R=4 的那句话」是假的。修法＝本节把归属改口，并收回那张「当时成立」的证书。
- **M-1 落地（口径标签）**：`:637` 那句「逐枚 `grep -c -F`＝spec 0／plan 0」把按行尺称作逐枚。本席用两把尺各测同一枚串（S＝`52b3983f` 版计划第 620 行 `这一味「(.*?)」` 捕获的那枚 8 字串，不复抄）＝按行 0／按枚 0，数值不受影响、标签受污染；同一行还自称「不报枚数」，下一席只能靠猜。⇒ 本节写死：**`grep -c -F`＝按行、`grep -o -F`＝按枚**，凡交计数必带这两字之一。
- **M-2 落地（枚偏移）**：`:636` 说 `6f3ff582` 那笔「补进两枚真实取回坐标」。实跑＝spec 第 15 行那条命令名按枚 `8cba0f78` 0→`52b3983f` 1→`6f3ff582` 3，其中 `90d5c3a1` 那枚 R=4 已有（`52b3983f:15` 含它＝1）⇒ 净添的两枚里只有**一枚**是取回坐标（`8cba0f78`），另一枚是那处自指。说法改成「一枚取回坐标＋一枚自指」。
- **I-4 裁定＝同笔落地，不挂账**：spec 第 13 行那句 L2 判态自 `0353065f` 起逐字未动（本席现跑该行 `wc -c` 在 `8cba0f78`／`52b3983f`／`6f3ff582`／`809a035a` 四版＝599 字节，四版逐字相同；**2026-10-19 最终评审 M-2 复评这一句**：本行原稿在此还写了「且均含」加一枚带引号的串，那串被 markdown 强调符与反引号切断，`grep -F` 在 spec 上打不中（本席现跑按行＝0），数值部分（599／1583）全复现，故判**引号形态失实、账不失效**；按本节上方 `:637` 立的口令，此处只给**大意**，字面从 spec 第 13 行当场取，本句不复抄）。它与本片落地后的矩阵不是谁对谁错，而是**前态与现态同树并存却缺一半归属**。修法＝该行末追加带日期括注，交出现读矩阵的两格（尺＝`awk -F'|'` 切列，状态＝第 2 格、实现坐标＝第 3 格；**同一把尺的最终评审 M-3 复评：`awk` 的 `$1` 是行首竖线之前的空场，按它的编号状态＝`$3`、坐标＝`$4`，「第 2／3 格」是不计空场的逻辑列号——本行原稿没交代口径，两处（spec 第 13 行与本行）已由 `追加更正（八）` 写死两套编号**）：第 92 行 `部分`／`IndicatorEditor.tsx:253`，第 93 行 `已有`／`:271`，并把 `:65`（`const TABS` 声明行，形状证据不是无障碍证据）与 `:250`（遮罩行）标明为前态坐标。第五席建议「可挂账」，本席不采——挂账的代价是让最终整支评审席替一句本席当场能平账的旧文做判定。
- **本节新立的口令（自指这一族的又一型）**：**相对版本词（上一版／紧邻前版／前一笔）是每改一版就自动过期一次的读数**。它与「本文件 N 行」同族，但更隐蔽，因为它看起来像坐标而不像数字。写法二选一：给绝对号（`git show <号>:<路径>` 第 N 行），或把「隔几版」与被跳过的那一版一起点名——本席在 spec 第 15 行的追加句用的就是后一种形状。**本句再立第二枚口令**（本节标题只点名了第一枚，那句是封顶那一笔落笔当时的真读数，本笔不覆盖，两说并存）：**枚序本身也是一枚坐标——写『该行第 N 枚』必须同句交代切分尺，否则下一席只能猜**。本席这把尺＝对目标整行做非贪婪配对，从左引号字形起、到其后最近的右引号字形止，按出现顺序从 1 编号；两枚字形直接相邻的空对同样各计一枚；嵌套不合并、不跳读。现算＝`:646` 三处枚位（`:637` 第 6 枚／`:627` 第 2 枚／`:630` 第 3 枚）与 `:647` 那处（`:636` 第 1 枚，len 24）在这把尺下全对。第五席报告 §8 倒数第二行记的那枚枚序错住的是本节**初稿**（面在未跟踪 scratch，本仓不拿它当可复算坐标），本席在封顶那一笔落笔前按这把尺把它改回第 2 枚 ⇒ 现版 `sed -n '646p'` 逐字是『第 2 枚』，该登记属前态、不是活缺陷。`len`＋`md5` 前缀是本席为口径分歧留的后路，但号本身仍要连尺一起交。
- **封顶后的读数（全部当场现跑，含本节与 spec 那两句追加自己）**：spec 行数 117、CR 0／LF 117（LF 件没被写坏）；spec 第 15 行 `wc -c` 落地后 3975、第 13 行 1583；`git show` 在 spec **按行 1**（仍只在第 15 行）、**按枚 4**、`:100` 以后 **0**；「旧文按」与「只出现在」在现版 spec 各 0；计划 `:621` 那枚自称「唯一命中就在本行」的自指针仍按行 1／按枚 1，本节的字面没有喂它；净新增对方控件名尺＝difflib **配对逐行**差集，窗口＝`52b3983f` 对本节落地后的两枚跟踪文件＝**0 枚**（候选 8 枚当场从 `docs/forensics/l0/tv-a7-indicator-dialog.md` 的引号内大写串取，本席不复抄；同一批用不配对的朴素 `+` 行尺对本窗得 **1** 枚假阳性，落在 spec 那行被修改的旧 L0 逐字转述上——成因就是 `:611` 记过的那口径错：被修改行上保留的旧文不是净新增；R=5 那一遍用同一把朴素尺得的是 2 枚，两遍的差值只说明窗口不同，不说明净新增）；`forensics_audit.py`＝clean rc=0、`pytest tools/test_forensics_spec.py -q`＝166 passed rc=0——本笔只动 `docs/superpowers/**`，这两门读的是 `docs/forensics/**`，跑是给收口留档、不是必需；水位门（G7）与 grep 门（G8）本笔零贡献，判据沿用 `追加更正（六）` 那两条（前者扫描面由 `WIKI_ROOT_DEFAULT` 定死，后者 `[gate b]` 明确 `--exclude-dir=docs`），阈值一字未动、门一字未改、既存白名单一枚未清。（**2026-10-19 最终评审 M-4 附带**——本行的 3975／1583／按枚 4 三枚都是 `809a035a` 那一版的读数：`追加更正（八）` 又改了 spec 第 13 行的列号口径，那枚 1583 随本笔过期，属本节自己那条「相对版本词每改一版过期」的口令管着的形状，复算请当场跑，别拿本行当现读。）
- **独立性交给谁**：本 harness 无 resume 通道 ⇒ 五轮修复全由控制席本人落笔，第五轮封顶后不再有收窄复评席；本节六枚裁定的独立复算落在**最终整支评审席**上（range＝`678864e1..HEAD`，覆盖本片全部跟踪面，含本节与 spec 那两枚追加句里的每一枚读数）。这五轮的账最后收敛成一句可执行的判据：**不看措辞漂不漂亮，看有没有一条命令能把它跑红。**

## 2026-10-19 控制席追加更正（八）——最终整支评审的文档面逐条裁定（代码面另派一席）

最终整支评审席（`task-6-final-review.md`，range＝`678864e1..7657feb8`，只读席）判 **With fixes**：Critical 零枚、Important 四枚（I-1…I-4）、Minor 七枚（M-1…M-7）。落笔前先立本片的分工：**代码面**（I-1 焦点管理＋M-1 收窄那根回归钉的辖域）派一枚修复 implementer 席做，**文档面**（I-2／I-3／I-4 与 M-2…M-7 的文档半）由本席自己落。拆两面不是省力——本片的自指损伤全部发生在文档面，`追加更正（二）`～`（七）` 五轮没有一轮红在代码上，把两面塞给同一席只会让下一席分不清哪一面被谁复算过；两面的判据形状本就不同：代码面的针要先看红，文档面的账要当场能跑红。提交序＝代码面先落（它动 `frontend/**` 与那根针），本节紧随；矩阵第 92／93 行的回灌与 I-4 那枚 L0 记录等焦点行为落地后再写——焦点一改那批活体读数就换值，抢跑＝往跟踪面写假账。

- **I-3 落地，并立本节唯一的新口令**。计划 `:520` 的 ① 那半逐字要求把对方四枚未选中页签的页名抄进被跟踪矩阵，与长期禁令（档案 §7.27「未尽项与刻意排除」那条「不把对方页面的任何档位名或键值抄进被跟踪文件」）正面冲突。本席 2026-10-19 现跑 `git show 7c15798f:docs/superpowers/plans/2026-10-18-l3-slice4-workbench-aria.md | grep -c ':520'`＝**0**（尺取**已提交版**，不取工作树——本节自己的文字现在就是第一批指向 `:520` 的指针，本席落完本节对工作树现跑 `grep -n ':520'`＝659、660、661 三行、全住在本节内，下一席复跑必非 0，那不是本句的假账），而同文件为别的病灶开了 `追加更正（一）`…`（七）` 七节 ⇒ 「就地追一笔带日期更正」是本片自己的修法，这一行却一直没被点名。执行席抗命成功了（矩阵第 92／93 行现跑对方页名 0 命中），但抗命只记在档案 §7.28 的「一处对简报的知情抗命」那条 bullet 里，**计划文本没改**：计划是约束性文本，下一席按字面执行就把同一笔违例再做一遍，而「上一席抗命过」这件事只活在未跟踪 scratch 与一枚编号 bullet 里——这是 plan 级缺陷，不是本片代码缺陷。
- **比 I-3 说的更重的一层，本席复跑才看见：泄漏面不止矩阵，计划自己就是泄漏面**。那四枚名字此前逐字躺在 `:520` 的跟踪面上（本席不在此复抄——复抄即亲手把下一席那把「净新增」尺从 0 喂成非 0，`追加更正（四）` 的 `searchbox` 条目命名过这一味）。本笔把它就地改成指向 L0 坐标的形状：`docs/forensics/l0/tv-a7-indicator-dialog.md:113-116`＝那四枚未选中页签（`:112` 是带 `[selected]` 的那枚；三枚坐标本席 2026-10-19 现跑 `sed -n '112,116p'`＋`grep -c` 对上：范围内 `tab "` 五枚、`[selected]` 一枚住在 `:112`）。旧字面取回＝`git show 7c15798f:docs/superpowers/plans/2026-10-18-l3-slice4-workbench-aria.md` 第 520 行，本笔不复抄。
- **口令（本节新立，写给每一片）**：**简报或计划里的单句与长期禁令冲突时，以禁令为准，并且必须在计划就地改口**。只在执行席自己的报告与档案 bullet 里记抗命，不算平账——下一席读的是计划。落笔形状＝把冲突那半句换成「按纪律不抄进本文件，见 <L0 坐标>」，再在本类追加更正里留一枚带日期括注。这条与 `:520` 那笔的关系，就是「抗命成功」与「账已还」的区别。
- **M-6 落地（按评审席建议并入上一笔一起改口）**：`:564` 原稿让档案写「变异表九条实测」，那枚数在仓里任何一把尺下都不成立——本席 2026-10-19 现跑：本计划里 `"m` 开头的注入键 **11 枚**（m1…m11）、spec §4.3 那张表**数据行 8 行**（`grep -n '^|'` 在 4.3 段内 10 枚命中，减去表头与分隔行）、同文件 `:299` 原稿写「十枚注入」。执行席落的是 `项目档案.md` §7.28 的「十一枚注入、HARNESS-BLIND 零枚」并逐名列出，与计划 `:335-357` 读到的键名一枚不差 ⇒ 缺陷未扩散，但 `:564` 作为指令仍在原地；本笔已就地改口，旧字面取回＝同上一笔的 `7c15798f` 版第 564 行。
- **I-2 落地＝论证缺陷，代码不动**：spec 裁定二那句「于是只有两种写法」是假二分，漏掉的第三种＝**条件发**（只在选中那枚 tab 上发 `aria-controls`，指向当时存在的面板 id）。本席现跑 `grep -rn "aria-controls" frontend/src` 取回两枚在跟踪面的现成形状与它们的针：`PeriodPicker.tsx:65` 是条件式，配套 `PeriodPicker.test.tsx:77` 那条 it 与 `:83` 那句 null 断言；`WelcomeScreen.tsx:346` 是「页身只挂一枚 tabpanel」，内容由同文件 `:328-344` 那六枚 tab 的 activeCategory 决定只渲染选中那一页——它直接否证原句「② 必须六页全挂载」。公平起见记下原句成立的那半：**`RunDetail.tsx` 零枚，`WelcomeScreen.tsx` 只有 `:290` 那枚目录开关、不在 tab 上**，所以「仓内两枚现成 tablist 也一律不发」为真。⇒ 判决＝裁定把可达形状说成不存在，代码忠实执行了裁定。spec 第 40 行已由本笔的 spec 追加改写成范围裁定。被冻住的那枚位置＝`ScriptWorkbench.test.tsx` 里裁定二的零计数针（行号本席不钉，代码面那一席正在改这个文件，改了行号就挪；判据＝它现在数的是整棵抽屉，而裁定只管 tab→panel 关联），修法归 M-1。
- **M-1 与 I-1 归代码面那一席**，本席只在这里记裁定与判据，落地由它的提交承担、独立复算由收窄复评席判。**M-1**：把整棵抽屉的 `[aria-controls]` 零计数改成逐枚 tab 断言不带该属性（抽屉里六段页身，任何一页将来正当加一枚可折叠区都会误红原针——本仓该写法先例：`ActivityLine.tsx:148`、`ModelPicker.tsx:85`）。**I-1**：`aria-modal="true"` 是对读屏软件的一句话承诺，承诺了却不搬焦点、不设陷阱、不接 Escape，比不声明更难自处；裁定一说「照 `ConnectionCenter.tsx:132-133` 这个形状做，不新造第三种」，而那枚抽屉**恰好是全仓最没有焦点管理的一枚**（同一把尺跑它只命中 CSS 类名里的 `focus:`），同仓另两枚 `aria-modal="true"` 都做了全套：`PineScriptViewer.tsx:14`／`:17-18`／`:27`（进抽屉聚焦关闭钮、卸载归还 `previouslyFocused`）与 `ConfirmDialog.tsx:47`／`:69-74`／`:80`（打开即聚焦、Escape、首尾环回、归还）。**这一句里评审席的数字本席复跑时被否证（2026-10-19，本笔自己抄错的那一半）**：`grep -rn 'aria-modal' frontend/src --include=*.tsx` 现读源码面共**五枚**声明，除本片这枚之外是 `PineScriptViewer.tsx:53`、`ConfirmDialog.tsx:94`、`PortfolioSourceEditor.tsx:94`、`ConnectionCenter.tsx:133`——「另两枚都做了全套」应为「另四枚里两枚做了全套、`PortfolioSourceEditor.tsx:42-44` 只在 `window` 上接 Escape 不搬不还、`ConnectionCenter.tsx` 一件没做（`grep -c -e activeElement -e previouslyFocused -e '\.focus()'`＝0）」；本席上面那句「最没有焦点管理的一枚」仍成立（它与之并列，不是唯一），判决与修法一字不改，只有面数要还账，逐字读数已交进 spec 裁定四追加段。本席 2026-10-19 逐枚 `sed -n` 现读过这四段，坐标未漂。**本席对它的裁定范围＝焦点进＋dialog 内 Tab 环回＋焦点归还，Escape 不做**，理由写进 spec 裁定四的追加句：这棵抽屉里有 Pine 草稿，Escape 静默丢弃未保存草稿是有代价的行为，而 L0 对 Escape 零读数（`追加更正（二）` 已把那句平账到 L0 `:8`）——「不替对方编造规格」这半句仍成立；`aria-modal="true"` 保留，因为陷阱补齐后那句承诺才兑现得了。归还的锚要点：`ProChart.tsx:3393-3395` 传的 `onClose` 每次渲染换身份 ⇒ 焦点效果只能键在 `open` 上、`previouslyFocused` 存 ref，否则每次父组件重渲染都会把焦点抢回关闭按钮。
- **M-2／M-3／M-4 落地（本席自己那三枚引号与编号口径）**：M-2＝`:650` 原稿那枚带引号的串被 markdown 强调符与反引号切断，`grep -F` 在 spec 上打不中（本席现跑按行＝0），数值部分（四版 599 字节、现版 1583）全复现 ⇒ 判**引号形态失实、账不失效**，已按 `:637` 立的口令改成明写「大意」。M-3＝`awk -F'|'` 那把尺没交代编号口径：本席现跑 `awk -F'|' 'NR==92{print $3, $4}' docs/forensics/gap-matrix.md` 得 `部分` 与 `IndicatorEditor.tsx:253`（`$1` 是行首竖线前的空场），故「状态＝第 2 格」只在**不计空场的逻辑列号**下成立，spec 第 13 行与本计划 `:650` 两处都已把两套编号写死。M-4＝`:636` 那句「现版该句同时给按行 1／按枚 3…都对得上」里的**「现版」正是 `追加更正（七）` 立的那枚相对版本词**，本席现跑 spec＝按行 1／按枚 4（与 `（七）` 自己那句一致），已在原地补带日期括注并交出绝对坐标 `809a035a`，同一件事也打到 `:652` 那句「第 13 行 1583 字节」——本笔改过 spec 第 13 行，那枚数现读 **2046**，两处都由本笔收回「现版」读法。
- **M-5 落地（表格与 MUTS 逐行对齐）**：spec §4.3 第二行原稿承诺的注入形状跑不出来——`aria-selected` 在 `IndicatorEditor.tsx` 里只有一枚源表达式，变异脚本的 `count == 1` 自护下无法只摘六枚渲染结果里的一枚；实际跑的是 m3 整式写死 `false`／m4 整式写死 `true`（本席静态判定：m3 后 selected 计数 0、m4 后 6，二者确实能红 P1／P2）⇒ **覆盖等价、字面承诺表达不出来**。该行已改写成写死 `false` 的形状并带日期括注，表仍 8 行、针仍 11 枚，与档案 §7.28 那笔「计划原稿写十枚、第 11 枚是评审轮补的」的账对齐。
- **M-7 裁定＝不改写历史**：`git log --oneline 678864e1..HEAD` 里 `0353065f` 那笔的 subject 含「缺顶层搜索框与三级标题」，后半个短语已被 `追加更正（一）` 与矩阵第 92 行判为**写下时即假**。改 hash 的代价大于收益（号已在台账、评审包文件名与派单词里被引用），本席沿用在收口笔 body 留一句「标题里的『三级标题』以档案 §7.28 现读为准」的做法；只读 `git log` 的下一席由那句话兜住。
- **评审席自己也错指一枚坐标（「派发的数字会被当证据」对评审回报同样成立）**：M-3 那句「同一条尺也被计划 `:651` 引用」不中——本席现跑 `grep -n "awk -F"` 对本计划得两枚：`:638`（那是另一把尺，数 `NF==7`）与 `:650`（就是这条尺）；`:651` 是枚序口令那条，不含这把尺。判决不受影响（缺陷真、修法真），但坐标照抄就把下一席引到错行。本席自己的复算尺也翻过一次，记在下面那枚。
- **本席这轮的一枚量尺假阴性（新成型，写给下一席）**：复跑 `:621` 那枚自称「唯一命中就在本行」的自指针时，本席第一次把带反引号字形的 needle **内联在双引号命令行**里跑 `grep -c -F`，得 **0**，据此几乎判那根自指针失效；改成 `printf` 写进临时文件、再 `grep -F -f <文件>` 取 needle，真值＝**按行 1／按枚 1**（命中行＝`:621`），那句话成立。⇒ 补一刀口令：**needle 里含反引号、竖线这类 shell 活性字形时，不许内联交给 `grep -F`，一律 `-f <文件>` 取**；否则那个「0 命中」可能是引号层的假阴性而不是跟踪面的实情。同族旧账：管道尾 `$?` 不是 `grep` 的、`--exclude-dir` 的豁免面被另一把尺共用。
- **待落地面（本笔不抢跑的四件，都等代码面提交落地）**（2026-10-19 同一窗追记：代码面已落 `4063dbe0`，下面四件自本笔起转入落地序，其中②③④要先跑一趟活体读数）：①spec 裁定四的追加句（Escape 仍排除、焦点三件改成本片已做）；②矩阵第 92／93 行「模态只声明了一半」那半句的改口与活体重读；③I-4 的 `docs/forensics/l0/self-ci0405-workbench-aria.md`——本席认这枚 L0 缺失是**形状退化**（`ls docs/forensics/l0/` 现读四枚自家页记录，矩阵第 86／88／95 行逐行引用它们，而本片两行零枚 self），但造它要真跑一趟浏览器（L0 的 `命令：` 与 `evidence_id` 必须同趟取，本仓记过「键与摘录不同源」这型缺陷），焦点行为一改旧读数就作废 ⇒ 与②同一笔做；④计划 `:432` 那句 Produces 的路由（追加 `＋ docs/forensics/l0/self-*.md`），与③同笔，否则下一片还走同一条只到散文的路。三层咬合那条硬规则也钉着同一件事：新 L0 的 `用途` 若不是 harness／基线／不可取证，必须被某枚 L1 的 `L0 依据` 引用，补引用与翻面同笔。
- **文档面的门读数（本节与 spec 三处改口落完当场跑，2026-10-19 02:39 一趟，HEAD 仍＝`7c15798f`，工作树含未提交的文档面）**：G4 rc=0（`256 passed in 112.15s`）、G5 rc=0（`forensics audit: clean`）、G6 rc=0（`166 passed in 11.29s`）；两枚本机恒红门照旧——G7 rc=1 `wiki stale pages: 446 (threshold 439)`，G8 rc=1 且六枝里**只有 `[gate b]` 一枝红**（a／c／d／e／f 五枝全 `ok`，`ok` 那五行带 ANSI 色序，故 `grep -c '^ok$'`＝0，别据此判门没跑）。命中集本席数错了一次，把它当**新成型**记下来：第一把尺 `grep -c 'FAIL:'` 得 **11**，第二把尺 `grep -o '^[^:]*/[a-zA-Z0-9_.-]*\.md'` 去重得 **18** 枚路径且「前缀无一例外」——两把都失真。`FAIL:` 那 11 枚把 `[gate b]` 的表头句与若干正文里转述 `FAIL: literal` 的行一起算了进来，不是命中行数；第二把的字面类 `[a-zA-Z0-9_.-]` 天生进不了含空格与中文的路径，把唯一一枚非 scratch 命中整枚吃掉。真尺＝按 `cut -d: -f1` 取路径（`[gate b]` 住日志第 3 行、`[gate c]` 第 40 行，故区间 `NR>=3 && NR<=39`）：**命中行 35 枚、去重 21 个文件**，其中 20 个住 `./.superpowers/sdd/**`、1 个住 `./.qoder/repowiki/knowledge/zh/…（Agent_前端_Electron_Wiki_CI）/CI 流水线与安全门禁脚本/架构设计.md`。两棵根都属未跟踪面：前者本席 `git status --porcelain` 现读整棵 `?? .superpowers/`；后者 `git ls-files --error-unmatch` 报 did not match、`git check-ignore -v` 命中 `.git/info/exclude:7` 的 `.qoder/` 一条。⇒ 本笔跟踪面对 G8 零贡献的机械凭据仍是 `tools/ci_grep_gates.sh:66` 的 `--exclude-dir=docs`（本席现读该行逐字带这枚旗标）把整棵 `docs/**` 挡在尺外，而本笔只动 `docs/superpowers/**` 两枚文件；对 G7 零贡献＝水位尺的驱动集是 `repowiki/` 页面，不在本笔触面内。两枚门一字未动（未调阈值、未改门、未清白名单）。留档＝同目录 `t8-g4.txt`…`t8-g8.txt`／`t8-gates.txt`（未跟踪，随清理消失，故上面把三枚 rc 与两枚恒红读数逐字抄进本节）。**G1–G3（tsc／vitest／vite build）本窗没跑**，不是遗漏：同一棵树里代码面那一席的 `frontend/**` 改动在这一趟（02:39:08）尚未提交——它落在 `4063dbe0`，提交时刻现读 `git show -s --format=%ci`＝`2026-10-19 03:45:34 +0800`，晚于这趟门六十六分钟，那三枚读数既不代表 `7c15798f`、也不代表 `4063dbe0`，属「读数撞上并发写入」那型。**这一空档本席随后自己补上了**：`4063dbe0` 落定后复跑，跑前现读 `git diff --stat HEAD -- frontend`＝**空**（工作树的 `frontend/**` 与提交态逐字一致，故读数归属清楚），读数＝G1 `npx tsc -b` rc=0（无输出）、G2 `npx vitest run` rc=0（`Test Files 144 passed (144)`／`Tests 2420 passed (2420)`，`Start at 03:49:30`／`Duration 137.29s`；代码面那一席在 BASE 上撞到的那枚 `SettingsQVeris.test.tsx` 负载 flake 这一趟没复现）、G3 `npx vite build` rc=0（只有 rolldown 插件耗时提示，非错误）。留档＝同目录 `t9-g123.txt`。修复席报告 §9 把 G8 的红点写成「全在 `.superpowers/**`」，与本席第一把尺同型失真（漏了 `.qoder/repowiki` 那枚），但它的结论——`frontend/` 对门 needle 计数 0 ⇒ 零贡献——由本席另尺独立证实：`git diff -U0 7657feb8..4063dbe0` 对 `tradingview`／`worldquant`／`toggle_delete_locked` 三把 needle `grep -c -i`＝**0**（rc 1）。
