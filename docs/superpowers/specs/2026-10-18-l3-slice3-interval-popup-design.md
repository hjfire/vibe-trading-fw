# L3 第③片：周期切换按钮是弹层入口（TV-CI-03 主 ＋ TV-CI-02 附）设计

**日期**：2026-10-18　**分支**：`feat/l3-slice3-interval-popup`　**基座**：`main` 末端（号一律现读 `git log --oneline -1`，本片从第②片合入推送后的那笔开）

**一句话**：把工具栏上那排八个「点一下就换档」的周期按钮，改成**一枚自陈弹层入口的按钮 ＋ 一个目录浮层**，当前档位以无障碍 `selected` 态标在目录行上，且那一行的可达名与按钮的可达名同名。

---

## 0. 这一片在漏斗里的位置

三层各有一句现读的话要说，全部由本席 2026-10-18 当场打开文件核对，不是转述：

- **L2 判态**：`docs/forensics/gap-matrix.md:90` 的 **TV-CI-02** 判 `部分`，第三列 `frontend/src/pages/ProChart.tsx:2730`；`:91` 的 **TV-CI-03** 判 `缺`，第三列是 `未找到：周期按钮自陈弹层入口 —— 复跑命令 grep -rn --include=*.tsx -e aria-haspopup frontend/src/pages/ProChart.tsx frontend/src/components/charts`。
- **L1 规格句**：`docs/forensics/spec/chart-interaction.md:19`（CI-02）＝「当前档位以 selected 态标在目录行上，且该行的可达名与主工具栏那枚周期按钮的可达名同名……⇒『按钮显示的就是选中档位』这一交互形状到名字级可验」；`:20`（CI-03）＝「周期切换按钮是弹层入口而不是『点一下换一档』的即时开关：它在无障碍树里自陈 `hasPopup,menu` 状态」。
- **本仓现状**（全部现读，逐字开过）：周期面是工具栏里 `frontend/src/pages/ProChart.tsx:2801` 起、到 `:2826` 止的一个 `INTERVALS.map` 平铺按钮行——`:2805` 逐字 `            const disabled = !intervalAllowed(symbol, i.key);`，`:2819` 逐字 `                  periodActive(i.key) && "bg-muted font-medium",`，`:2821` 逐字 `                onClick={() => pickInterval(i.key)}`。`periodActive` 谓词在 `:2581` 逐字 `  const periodActive = (key: IntervalKey) => !timeShare && interval === key;`。`pickInterval` 在 `:1959`，函数体直接 `setView({ interval: iv, timeShare: false }, true)`。八枚档位来自 `frontend/src/lib/marketApi.ts:20-29`（`1分`/`5分`/`15分`/`30分`/`60分`/`日线`/`周线`/`月线`），合法性单一谓词 `intervalAllowed` 在 `frontend/src/lib/chartView.ts:34`。

⇒ 两格判态都是真的：本仓既没有「弹层入口」这一形状（点按钮即换档），也没有 `aria-selected`／`aria-haspopup` 这一族标记（`grep -n 'aria-haspopup\|aria-expanded\|aria-selected\|role=' frontend/src/pages/ProChart.tsx` 本席 2026-10-18 现读＝**0 命中**）。

---

## 1. 判态：本片之后两格升 `已有`，但只升这两格

**CI-03 升 `已有`**：按钮自陈 `aria-haspopup="menu"` ＋ `aria-expanded`，且点它**不换档**（只开目录）。这一条的形状就是规格句那句「弹层入口而不是即时开关」，两半都落。

**CI-02 升 `已有`**：目录行 `<role=option>` 上带 `aria-selected`，且当前选中行的可达名与按钮的可达名逐字相同（按钮正文就是那一档的 label，见 §2 裁定三）。

**同一张矩阵里相邻的 TV-CI-01 不动、不顺手升**。那一格要的是「7 个 level=1 行 ＋ 32 个 level=2 行 ＋ 六类分组」的两层 treegrid。本片产出的目录是**一层八档**，没有分类行、没有 32 个档位、不是 treegrid。谁要是把本片说成「目录也复刻了」，就是「盖章范围超出实际所做工」那枚旧病灶的重演。

判据到哪儿就写到哪儿：本片只买 CI-02、CI-03 两格。

---

## 2. 四条裁定（没有现成答案，由本席定，写在这里当约束）

**裁定一：形状选「单枚入口按钮 ＋ 浮层目录」，不选「保留平铺行 ＋ 另加一枚入口按钮」。**
后者能让工具栏保住一次点击换档的快路径，但那样本仓同时存在「即时开关」与「弹层入口」两种周期按钮，CI-03 那句「周期切换按钮是弹层**而不是**即时开关」就在自家页上变成假的——最多数到 `部分`。选前者：形状唯一，代价是换档从一次点击变两次。附带收益：工具栏最挤的那八枚没了（这块窄屏换行是老账）。

**裁定二：目录的 widget 族用 `listbox`／`option` ＋ `aria-selected`，不用 `menu`／`menuitemradio` ＋ `aria-checked`。**
CI-02 的规格句要的是「selected 态」，`aria-selected` 是 `option` 的合法状态；`menuitemradio` 的对应状态是 `aria-checked`（ARIA 1.2 已把 `aria-selected` 在 `menuitem*` 上标弃用），拿它当「selected」的证据要额外辩解。

**裁定三：入口按钮的可达名＝当前档位的 label，逐字，不加任何装饰文字。**
`title` 属性、`aria-label` 属性、以及一个可见的 `▾` 文本箭头，三者都会（或可能）改变可达名／或让「按钮名＝行名」这条同名关系变成要解释的东西。对方那一侧 a1 读到的按钮可达名逐字就是档位名（`1 day`），本仓照这个形状走：按钮正文＝`日线`，选中行正文＝`日线`。图标面放弃（本仓 `ProChart.tsx` 与 `ReplayBar.tsx` 都没引 `lucide-react`，本片不为一个箭头新增依赖）。

**裁定四：入口按钮写 `aria-haspopup="menu"`，尽管浮层本身是 `listbox`。**
这是**照对方那一侧的实测形状抄**，不是笔误：a1 那块节点自陈 `hasPopup,menu`（`docs/forensics/l0/tv-a1-page.md`，CI-03 判据三条计数指的就是它），而 a5 点它打开的是 **treegrid**（`docs/forensics/l0/tv-a5-intervals.md`，CI-01 判据）——对方自己就是「`hasPopup` 值说的是入口那一族，浮层的 role 说的是浮层自己」。本仓同形。严 ARIA 洁癖的读者可以要求改成 `aria-haspopup="listbox"`，代价是丢掉与规格句 `hasPopup,menu` 那个 token 的逐字对应，这条改口记录在矩阵格说明列里，由评审席裁。

---

## 3. 实现面

### 3.1 新组件 `frontend/src/components/charts/PeriodPicker.tsx`

受展示组件（与 `ReplayBar.tsx` 同形：不认识 store、不发请求、不碰图表库）。

```ts
export type PeriodOption = { key: IntervalKey; label: string; title: string; disabled: boolean };
export type PeriodPickerProps = {
  options: readonly PeriodOption[];
  triggerLabel: string;      // 入口按钮的可达名（裁定三：由页面算，等于当前档位 label）
  active: IntervalKey | null; // 目录里该被标 selected 的那一档；分时态为 null
  onPick: (key: IntervalKey) => void;
};
```

标记面（本片的全部承诺都在这几行上）：

- 入口 `<button type="button">`：`aria-haspopup="menu"`、`aria-expanded={open}`、`aria-controls="pro-chart-period-menu"`，正文＝`triggerLabel`。三枚属性的写法照本仓既有的同一形状抄：`frontend/src/components/chat/Composer.tsx:331-333`（`aria-haspopup="menu"`／`aria-expanded={showUploadMenu}`／`aria-controls="agent-more-options-menu"`）。
- 浮层 `<div id="pro-chart-period-menu" role="listbox" aria-label="周期目录">`，**只在 `open` 时渲染**（条件渲染，不在 DOM 里挂 `hidden`）：这一条是 CI-03「点它不换档」能被子代理级针钉住的前提——没打开时目录不在树里，所以「按钮存在」与「档位可选」是两件事。
- 每行 `<button type="button" role="option" aria-selected={option.key === active} disabled={option.disabled} title={option.title} onClick={...}`，正文＝`option.label`。
- 选中行除 `aria-selected` 外继续带原来的视觉类 `bg-muted font-medium`（`:2819` 那条 CSS 标记**不许删**：§4 说它有一枚既有针在数它）。
- 关闭通道三条：再次点入口按钮／`mousedown` 落在组件外／`Escape`。焦点在 `Escape` 后还给入口按钮。这三条逐字照 `Composer.tsx:238-256` 的 `handleClickOutside`＋`handleEscape` 写（含 `if (open)` 才挂监听、cleanup 里两条都摘）。
- 不做的事：方向键 roving tabindex、typeahead、ARIA 1.2 的 menu 键盘契约。对方目录里那 39 行的键盘行为本批**一份读数都没有**，没有规格可对齐，凭空实现就是自拟。

### 3.2 页面接线 `frontend/src/pages/ProChart.tsx`

- 删掉 `:2801-2826` 那个 `INTERVALS.map` 平铺块，换成一行 `<PeriodPicker …>`。
- `options` 由页面构造：`label` 取 `INTERVALS` 的 label；`disabled` 走 `intervalAllowed(symbol, i.key)`（`:2805` 那条门一字不改地搬过去）；`title` 三分支逐字沿用 `:2810-2816` 那三段文案（含 2026-10-18 现读的那句「分钟线需 FutuOpenD（支持 .SH/.SZ/.HK/.US）」）。
- `active`＝`timeShare ? null : interval`，也就是 `:2581` 的 `periodActive` 语义的键化写法。**`periodActive` 就此删除**（现读它只有 `:2581` 定义与 `:2819` 一处消费两个命中，删掉后不留死谓词；留着而只被测试用会撞 `noUnusedLocals`）。
- `triggerLabel`＝`INTERVALS` 里 `key === interval` 那枚的 `label`。**注意**：分时态下 `active` 是 `null` 而 `triggerLabel` 仍是那个 underlying 档位的 label——按钮显示「日线」而目录里没有 selected 行，这是分时语义的必然结果（`:2579` 那条注释已经把「`viewPeriod` 会说 1分 而线上画的不是 1分」这件事写死过一遍），本片给它单独一枚针（§4 第 6 条）。
- `onPick`＝现有 `pickInterval`（`:1959`），外加一句：选完关浮层。**`pickInterval` 本体一字不动**——它已经有 `intervalAllowed` 守卫、有 `setDrawNotice(null)`、有「任何周期按钮都结束分时」那句注释。
- 分时按钮（`:2659-2673`）与它后面的平均K线／量分布等**一律不动**：分时不是档位（local custom ㉖），它留在工具栏上当即时开关。
- `:2579` 那句注释「Which period button is lit.」要改口成目录行＋入口按钮两件事——它是本片自己造的措辞漂移，不许留给下一席当陷阱。

### 3.3 既有测试面的连带改动（五个文件，形状＝「先开目录再取行」）

现读命中清单（本席 2026-10-18 用 `grep -rn '"1分"|"5分"|"15分"|"30分"|"60分"|"日线"|"周线"|"月线"' frontend/src` 数出来的，`marketApi.ts` 的定义行与 `MultiChart.test.tsx`（那是 `/multi-chart` 自己的 `<option>` 下拉，与本片无关）除外）：

| 文件 | 现读坐标 | 要动的东西 |
|---|---|---|
| `ProChartMinuteBars.test.tsx` | `:272` `disabledOf`；`:278`／`:314`／`:316` 点档位；`:302`–`:308` 逐个读 disabled | helper 加一步「开目录」，`disabledOf` 改查 `role="option"` |
| `ProChartCompare.test.tsx` | `:442`／`:606`／`:731` 点「周线」 | 同上，走 helper |
| `ProChartReplay.test.tsx` | `:240-247` `buttonOf`／`click`；`:416`／`:545`／`:549`／`:630`／`:856` | `click("60分")` 这类调用点不改名，改 helper 内部：先点入口再点行 |
| `ProChartReplayDrawings.test.tsx` | `:263-270`；`:366` | 同上 |
| `ProChartTimeShare.test.tsx` | `:364-365` `buttonOf`；`:550`；`:563` 八枚循环；`:645-646`；`:737` 五枚循环 | 见 §4 第 5 条，这处是**改口不是搬家** |

纪律照旧一条：**改口要保住那枚针原本承诺的那一半**。`:563` 那个循环的承诺不是「八枚按钮的 className 里有没有 `bg-muted font-medium`」，而是「**分时开着时没有任何周期档位处于选中态**」。新写法：打开目录，断言八行里 `aria-selected="true"` 的数量为 0，同时保留 CSS 那半条（`bg-muted font-medium` 命中数也为 0）。旧针不许直接删——它承诺的东西还在。

---

## 4. 新针清单（每根都写清「生产代码里改哪一处它会红」）

组件级 `frontend/src/components/charts/__tests__/PeriodPicker.test.tsx`：

1. **入口按钮自陈 `aria-haspopup="menu"` 且 `aria-expanded="false"`** → 摘掉 `aria-haspopup` 那行会红。
2. **点入口：`aria-expanded` 翻成 `"true"`，且 `onPick` 一次也没被调用** → 把 `onClick` 换成 `onPick(active)`（即时开关的写法）会红。这一根是 CI-03 的后半句「而不是点一下换一档」的直接形状。
3. **打开前目录不在树里，打开后在**（`queryByRole("listbox")` 先 null 后非 null）→ 改成常渲染＋`hidden` 会红。
4. **当前档位那一行 `aria-selected="true"`，其余七行 `"false"`；且该行的可达名逐字等于入口按钮的可达名** → 把 `aria-selected` 写成 `aria-checked`、或把 `triggerLabel` 加个后缀，都会红。这一根是 CI-02 两半句的形状。
5. **`disabled` 行点了不回调 `onPick`** → 摘掉 `disabled` 会红（`intervalAllowed` 的门还在页面侧，那半由 `ProChartMinuteBars` 的循环钉，见 §3.3）。
6. **`active={null}` 时八行都是 `aria-selected="false"`，而入口按钮仍照常显示 `triggerLabel`**（组件级：这是纯 props 行为）→ 组件里若把 `null` 当成「全不选但按钮也不渲染」或直接读 `options[0]`，会红。页面级的那一半（分时态确实把 `null` 传下去）另有一枚针，与 §3.3 里 `:563` 那条改口同一处。

页面级（`ProChartPeriodMenu.test.tsx` 新增，或直接进 `ProChartMinuteBars`）：

7. **入口按钮正文＝当前档位 label；换档后正文跟着变** → `triggerLabel` 硬编码某档会红。
8. **点目录里的行＝换档 ＋ 目录自动关** → 去掉「选完关闭」会红。

三条通道各一根关闭针（**同一条 `fireEvent` 形状，三个不同触发**，不许合并成一条「能关」）：

9. 再点入口 → 关（`aria-expanded="false"`）。
10. `mousedown` 落在组件外 → 关。
11. `Escape` → 关，且焦点回到入口按钮（`document.activeElement` 断言）。

---

## 5. 排除项（写在前面，别让实现席顺手做）

- **不做目录的两层结构与六类分组**（CI-01）。理由见 §1。
- **不做键盘 roving／typeahead**。理由见 §3.1 末尾。
- **不碰 `/multi-chart` 的每格周期下拉**（`frontend/src/pages/MultiChart.tsx:457-464` 用的是原生 `<select>`＋`<option>`，那本来就是「弹层入口＋selected」的浏览器原生形状，不在两格差距里）。
- **不碰 `TVChart.tsx`**：那是 `/tv-chart` 路由上的另一页（`frontend/src/router.tsx:88`），它自己有一份局部 `INTERVALS`（`frontend/src/pages/TVChart.tsx:16`），不是复刻面的锚。本片不动它，也不声称它对齐。
- **不给浮层加会话级持久**：开合是瞬时态。第①片那四枚会话级键管的是**面板可见性**，不是浮层开合。
- **不新增任何 TV 侧键名／键值**：本片与被跟踪文件里那枚 `tradingview.toggle_delete_locked_linetools` 无涉；可达名一律用本仓中文 label（`日线` 等），**不许**把对方读到的 `1 day` 这类值抄进代码或文档。

---

## 6. 门禁与验收序

门禁面（每道单独取 rc，一道也不合并）：`cd frontend && npx tsc -b`／`npx vitest run`／`npx vite build`；根面 `python -m pytest tools/test_wiki_drift.py tools/test_wiki_qmind.py -q`、`python tools/forensics_audit.py`、`python -m pytest tools/test_forensics_spec.py -q`、`bash tools/wiki_freshness_gate.sh`、`bash tools/ci_grep_gates.sh`。

其中后两条在本机恒红，与本片无关，处置口径照旧：**不调阈值、不改门、不清白名单**，只出归属证据——水位门按「本片前后页数逐字相同」这条实测写，`ci_grep_gates.sh` 按「命中文件集合与本片跟踪面交集为空＋被改文件 needle 计数 0」写。两句里的读数都由执行席当场取，本 spec 不替它预填数字。

活体验收（前端起着 `localhost:5899`，浏览器实测）：点入口 → 目录出现且当前档位高亮；点另一档 → 图与按钮正文一起换、目录关闭；分时态 → 目录里无选中行；`Escape` 与外点都能关。像素层用 `take_screenshot` 看浮层**有没有被图表盖住**（`z-50` 在工具栏这条 `flex-wrap` 行里的层叠关系是 jsdom 判不了的，这是本片唯一必须在真浏览器里看的一处）。

未来函数自查：本片纯交互面，不产生任何指标或信号；五步 Bar Replay 自查仍走一遍（切片惯例），结论按「本片不参与重绘面」写，不写成「已证明无未来函数」。

---

## 7. 变异自证（针的判别力，逐枚写注入形状）

按本仓惯例，每根新针配一次「把生产代码改坏、看它红、再原地还原」的探针。本片至少八枚注入：摘 `aria-haspopup`／摘 `aria-expanded`／`onClick` 改成立切换（裁定二/三/四各一枚）／`aria-selected` 换成 `aria-checked`／`triggerLabel` 加后缀／目录改成常渲染＋`hidden`／去掉「选完关闭」／`active` 不判 `timeShare`。

三条硬规矩（都是本仓实烧过的坑，逐条要满足）：
1. 动手前把所有会被写的文件**一次读进内存**当基线，还原只从那份副本写回，**绝不**用 `git checkout --`，也绝不手写「互逆替换串」。
2. 每枚注入还原后要看**全树** `git diff --stat` 与**动手前**算好的逐文件基线 sha，两项都对上才算这枚探针跑干净。
3. 注入如果让测试「既没报错也没变红」，那枚针记 `HARNESS-BLIND`，不许升级成「等价／不需要」。

---

## 8. 落档与文档面

- **L2 矩阵**：CI-02、CI-03 两格升 `已有`，第三列各换成新锚（`PeriodPicker.tsx` 里 `aria-selected` 那一行／`aria-haspopup` 那一行，行号由执行席**当场** `grep -n` 现读＋`sed -n` 开眼确认）。两格**原来那串第三列全文逐字搬进说明列开头**（第①片 T6 立的规矩），后面接带日期的复跑读数：CI-03 那条 needle 从「0 命中 rc=1」变成「`PeriodPicker.tsx` 1 命中」，CI-02 那条 `aria-selected` 搜索从「0 命中」变成实际条数。旧读数一字不删。
- **L1 规格表**：本片**不改**。CI-02／CI-03 两格的判据全是对方侧 L0 的 `grep -c` 计数，本片的验收是本仓实现面对得上那些形状，不是给规格句新增自家页判据。要新增 L0 记录就得连带动 L1 的 `L0 依据`（`tools/forensics_audit.py:540` 那条孤证规则），本片不走这条路——验收凭的是 §4 那批针的 DOM 属性断言，加上一次活体目视。
- **档案**：`项目档案.md` §7.27 一节，bytes 层追加（整文件 CRLF，追加后要断言 CR 数与 LF 数、行数差、以及「本片不动 §7.26 及以前任何一行」）。

---

## 9. 风险与退路

| 风险 | 形状 | 处置 |
|---|---|---|
| 换档多一次点击，用户觉得变慢 | 真实产品代价，不是缺陷 | 已按裁定一选它；如需快路径，退路是「入口按钮 ＋ 目录之外再留一排常用档」，那要重开一片并重新裁 CI-03 的判态，不许在本片里顺手做 |
| 浮层被图表／工具栏层叠盖住 | jsdom 判不出来 | 活体那一步专看这一处；出问题时改 `z-`／`relative` 定位，不改语义标记 |
| 五个既有测试文件改动面大，改口改过头 | 「保住的承诺」变空 | §3.3 那条纪律＋每处改口在提交信息里点名它守的是哪一半；任务评审席按 §4 逐枚核对 |
| `aria-haspopup="menu"` 配 `listbox` 被评审席判 ARIA 违规 | 语义洁癖 vs 逐字对应 | 裁定四已写清理由与代价；评审席若坚持，按 §2 裁定四末尾那句改成 `listbox`，并在矩阵格带日期追加一条改口登记（原句不删） |
