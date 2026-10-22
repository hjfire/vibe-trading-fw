# L3 第⑥片：自定义周期档（对话框 → 目录新行 → 真取数）设计

**日期**：2026-10-22　**分支**：`feat/l3-slice6-interval-catalogue-l0`　**基座**：`dc048586`（＝本地/远程 main 同一个）
**凭据**：`forensics/spec/chart-interaction.md` 的 TV-CI-09／10／11（L0 五份：`forensics/l0/tv-a17…`、`tv-a18…`、`tv-d1…`、`tv-d2…`、`tv-c1…`）
**上游依赖**：第⑤片已把服务端「基档 × k」折叠取数面落地（`agent/src/api/interval_spec.py`、`market_routes.py`、`udf_routes.py`），本片不碰后端语义，只把它已经接受的拼写接到前端用户手上。

## 1. 这一片要交付什么

用户在前端图表页打开周期目录，选「添加自定义周期」，在弹出的对话框里选单位＋填数值，按「加入」，这条新档就**出现在目录里并成为当前周期**，图上的 K 线真的按那个倍数取数；刷新页面它还在；随手可以移除。对面那侧的这套东西由 TV-CI-09（对话框骨架）与 TV-CI-10（单位弹层）描述，两格现在在 L2 里都是「缺」。

一句话判据：**这一片结束时，`2小时`、`3日`、`2周` 这三档能在自家图上真切出来，且对话框的可达结构对得上 TV-CI-09/10 里被证实的那几把尺。**

## 2. 范围

### 做

1. `frontend/src/lib/customInterval.ts`（新，纯函数）——自定义档的语法与换算，前后端对齐的**唯一前端落点**。
2. `frontend/src/lib/marketApi.ts` 类型加宽——`IntervalKey` 保持那八枚内置档，另立 `AnyInterval`；两张 `Record<IntervalKey, …>` 表改成函数（`resolutionOf`／`intervalMsOf`），`intervalToPeriod`／`periodToInterval` 两侧都吃自定义串。
3. `frontend/src/lib/chartView.ts`——`intervalAllowed`／`repairInterval` 按**单位所属车道**判定自定义档（分钟道要分钟源，日/周/月道不需要），这是 TV-CI-11 那条红线唯一合法的落点。
4. `frontend/src/components/charts/CustomIntervalDialog.tsx`（新）——对话框本体：`role="dialog"`＋关闭按钮＋Type 弹层（listbox／option＋`aria-selected`）＋数值输入框＋取消＋加入。
5. `frontend/src/components/charts/PeriodPicker.tsx`——目录尾部一条「添加自定义周期」入口行；目录行集改为可由页面传入自定义档；自定义档行自带「移除」按钮（内置档行没有）。
6. `frontend/src/pages/ProChart.tsx` 接线——加入／移除／选中／会话持久化／分时互斥／MTF 下层档诚实降级。
7. 测试与验收——见 §7、§8。

### 不做（写下来是为了让它成为裁定，而不是遗漏）

- **两层 treegrid 分组行**（对面把目录分成 Ticks/Seconds/Minutes/Hours/Days/Ranges 六个 rowgroup，档位行是 level=2 兄弟）。本片目录仍是单层 listbox。L2 里没有这一格，所以不做不算欠账；它要单独一片。
- **收藏星标与 `Remove` 那一列**：TV-CI-11 只证实了「已在列表里的行同时带收藏格与 `Remove` 格」这一形状，**没证实**收藏的行为语义。本片的「移除」按钮是我们自己需要的闭环件（否则自定义档只增不减），不宣称复刻那一列。
- **`/multi-chart` 四视图格子里的自定义档**：本片只接 `/chart` 单图页。`ChartCell` 在类型加宽后天然吃得下自定义串（它只把 `interval` 透传给 `intervalToPeriod`），但页面不产出这种格子，所以它的自定义档路径没有凭据、也没有验收。
- **九语言 locale**：周期目录现有文案是硬编码中文（`marketApi.ts` 的 `INTERVALS.label` 与 `PeriodPicker` 那三条 title 都是），本片新文案沿用同一口径、同一处，不为它单开 i18n 通道——开了就得九份，而目录本来就不是 i18n 面。
- **`range` 家族**：TV-CI-10 的六档里有 `range`，但服务端折叠文法只认 `m`/`D`/`W`/`M`（`_FOLDED_RE`），`range` 没有取数面。⇒ 我们的 Type 弹层给**五档**（分钟/小时/日/周/月），并在 L2 回灌时把这枚差写明，不许偷偷摆一枚按了没反应的第六行。
- **对面单位切换后的数值域**：TV-CI-10 的限制条写死了「选中别的档要第二次 click，本批没做」⇒ 对面「选 `hours` 之后 `Interval` 那侧怎么变」没有任何读数。本片的数值边界是**我们自己定的规则**（§4），不是复刻。
- **doubled 可达名**：TV-CI-10 证实对面展开态那枚按钮的名字是 `minutes minutes`（值被念了两遍）。这是可达性反模式，不是结构要求，**故意不复刻**；对应的针反而断言我们这枚按钮的名字里单位标签**只出现一次**（§7 针 C-7）。
- **`aria-modal`／焦点陷阱**：TV-CI-09 的证据只到 `role: dialog` 与那七把骨架尺，没有任何读数说对面锁了焦点。⇒ 只做 `role="dialog"`＋`aria-label`＋Escape 归还焦点，不发明凭据里没有的行为。

## 3. 架构：为什么是「前端只做形状、后端仍是唯一判据」

第⑤片的裁定（服务端不发明新源，只在既有基档上做折叠）意味着：**任何一个 `n{m|D|W|M}` 串，只要形状合法，服务端都能答**。所以前端不需要第二套「这一档能不能取」的真理，只需要：

- 即时反馈——把明显不成形的输入挡住，不让用户按一个必败的按钮（`Add` 的 enabled 条件）；
- 拼写换算——把「单位＋数值」这一对（对话框里用户真正看见的东西）编译成服务端认得的 market 拼写，再派生 UDF `resolution`、KLineChart `Period`、毫秒跨度三件事。

这两件事全部收进 `lib/customInterval.ts` 一枚纯模块，`marketApi`/`chartView` 只消费它。

**防漂**：前后端各拿同一份样本表对账（§7 针组 A）。样本表不生成、不共享文件，而是在两枚测试里各自逐字写一遍同一批串——这样任何一侧改了文法，必有一侧的针先红。用「谁也不引用谁的同一份数据」是故意的：共享夹具会让对账退化成自证。

## 4. `customInterval.ts` 的判据

```ts
export type IntervalUnit = "minute" | "hour" | "day" | "week" | "month";
export type CustomInterval = { unit: IntervalUnit; n: number };  // n ≥ 1
```

- **单位表**：`minute → "m"`、`hour → 60 × n 分钟 → "m"`、`day → "D"`、`week → "W"`、`month → "M"`。小时不在服务端文法里（`1H` 只是 `_UDF_ALIASES` 的别名，不是折叠单位），所以**小时换算成分钟**再拼，产出 `120m` 而不是 `2H`。
- **market 拼写**：`toMarketSpec({unit,n})` ⇒ 分钟/小时走 `f"{60·n if hour else n}m"`，日/周/月走 `f"{n}{D|W|M}"`；`n === 1` 且单位是日/周/月时回到内置拼写（`1D`/`1W`/`1M`），是分钟时同理（`1m`）——因为 `parse_interval` 对这些返回 `kind="native"`，前端造一个 `1m` 的自定义档只会多出一条与内置行同义的行。⇒ `fromMarket()` 认到内置档时直接判「已存在」，对话框给出可见提示（§6）。
- **数值边界（本仓自己的规则，写明理由）**：`n` 必须是 `1..999` 的整数，且单位是分钟/小时时 `60·n`（小时）或 `n`（分钟）不得超过 `1440`（一日的分钟数），日/周/月的 `n` 不得超过 `366`。理由：服务端对 `k` 不设上限、只按 `_MAX_BARS` 少返（`market_routes.py` 的 `ask = min(count * k + k - 1 + slack, _MAX_BARS)`），一个 `500m` 的请求名义合法但只会拿到远少于 `count` 的根数；与其让用户拿到一条空图，不如把「一个折叠窗口跨多于一天的分钟档」「跨过多于一年」这类明显失用的形状在按下去之前就挡住。**这条边界不复刻对面的任何东西**（无凭据），也不许写成「对面如此」。
  - **两把尺的分界（2026-10-22 第 2 轮复评补，N-1）**：上面那句里 `1..999` 管的是**用户手打的数值**，`60·n ≤ 1440`／`n ≤ 366` 管的是**折算后的跨度**——两者不能混成一枚。URL／会话那道门（`normalizeInterval` 经 `isCustomSpec`）收到的串里已经没有「单位」这一层，串中那个数**就是**折算后的跨度，所以门**只按跨度判**：`1001m…1440m` 这一带合法（对话框只造得出其中小时档 `n=17..24` 折算的那几枚——`1020m`、`1080m` 每 60 一跳；`1000m` 这类分钟串对话框到不了，门按跨度收它，「门比对话框宽」是无害的方向，N-1 要治的是反方向），`1441m`／`367D` 非法。跨度判据全仓只允许一处拼写（对话框与门共用它），把 `1..999` 也套到串上就会造出「对话框发得出、门收不下、刷新静默退 `1D`」的档——这条要有往返针（`validateDraft` 的 `ok:true` ⇒ `isCustomSpec(spec)` 必真）。I-2 那条裁定（越界的合法文法串不算合法自定义档）在此分界下**仍然成立**，只是「越界」的读法按跨度取。
- **换算**：`resolutionOf(interval)`——内置档查旧表，自定义档原样送出 market 拼写（`2D`／`120m`／`3W` 都被 `parse_resolution` 认：它先查别名，再认裸分钟数，最后落回 `parse_interval`）；`intervalMsOf(interval)`——`m` 用 60_000、`D` 用 86_400_000、`W` 用 604_800_000、`M` 用 30 日（沿用 `INTERVAL_MS` 现有的「月＝30 天」口径，不与服务端 `MONTH_SECONDS = 31 日` 统一——那枚 31 是服务端为**少返**故意取宽的近似，两处的用途不同，统一反而会改掉既有分页行为；差异在两处注释里互相指认）；`intervalToPeriod(interval)`——分钟 `{type:"minute", span}`、日/周/月 `{type, span:n}`。
- **反向**：`periodToInterval(period)` 现在返回 `AnyInterval`，`span > 1` 时按 `n{m|D|W|M}` 造串（`{minute, 120}` → `"120m"`），造不出来的形状（`second`/`year`）照旧退 `"1D"`。

## 5. 类型加宽的形状

`IntervalKey` **不动**——它是「目录里那八枚内置行」的身份，`INTERVALS`、分时、 screener 都靠它穷举。加宽只加一层：

```ts
export type AnyInterval = string;                       // 内置拼写 ∪ 合法自定义拼写
export function isBuiltinInterval(x: string): x is IntervalKey;
```

调用点上 `IntervalKey` 的值天然可赋给 `AnyInterval`，所以 `ChartCell`、`MultiChart` 这类只传不改的地方**零改动**；必须改口的是三处「把 interval 当枚举键索引表」的地方（`RESOLUTION_BY_INTERVAL[...]`、`INTERVAL_MS[...]`、`CALENDAR_PERIODS.find(c => c.key === key)`），全表改函数即消解。`tsc -b` 会把漏改的每一处点名——这一片的类型加宽是「编译器替我扫全仓」的形状，不靠 grep 计数。

**分时与自定义档**：`market_routes.py:648` 在 `session == "latest" and spec.k > 1` 时**直接拒绝**（折叠会跨天，而分时只画当日）。⇒ 当前周期是自定义档时，分时按钮必须 disable 且 `title` 说清是这条规则（不是「源不支持」那种假话），`pickTimeShare()` 的守卫同步；否则用户按下去拿到的是一枚 HTTP 错误。

**MTF 下层档**：`pickLowerInterval(chartKey: IntervalKey, …)` 只认内置档，Pine 的 `request.security_lower_tf` 靠它。当前周期是自定义档时**不传 `lowerBars`**（这条降级路径早已存在并被文档化：调用方不传，builtin 退化成空数组），不许拿「最近的内置细档」冒充——那会让脚本画的不是它请求的那条时间轴。

## 6. 对话框的可达结构与交互

对得上 TV-CI-09 那七把尺的形状（我们的名字是自己的文案，结构是它的）：

| 对面的尺（L1） | 我们这侧 |
| --- | --- |
| `dialog "…"` 恰一枚，且与目录**同层共存** | `role="dialog"`＋`aria-label="添加自定义周期"`；打开时目录**不摘**（断言：对话框与目录同时可达） |
| `button "Close menu"` | 一枚关闭按钮，可达名「关闭」 |
| `text: Type` ＋未展开态按钮 | 「单位」标签＋一枚 `aria-haspopup="listbox"` 的按钮，关态 `aria-expanded={false}` 且**没有** listbox 子树 |
| `text: Interval` ＋ `textbox` | 「数值」标签＋一枚数字输入框（`type="number"`、`min`/`max` 与 §4 边界同源，不重复写第二遍） |
| `button "Cancel"` | 「取消」 |
| `button "Add" [disabled]` | 「加入」，enabled 条件＝§4 形状校验通过**且**该串不在目录里；初态（空输入）因此是 disabled，但这条是我们校验函数的输出，不是照抄那枚 `[disabled]` |

- **Type 弹层**：展开后恰一枚 `role="listbox"`＋五枚 `role="option"`（分钟/小时/日/周/月），当前单位那枚 `aria-selected={true}`；按钮可达名＝单位标签**一次**（不复刻 doubled 名，§2）。选中另一枚 ⇒ 数值输入的 `min`/`max` 与单位边界同步收窄（换单位后旧数值非法时，`加入` 变 disabled 并给出可见原因，不静默改用户的数）。
- **键盘**：Escape 关对话框、焦点归还入口行；这是第④片立过的自家规矩，与对面证据无关。目录那层的 Escape 与外点关闭沿用 `PeriodPicker` 现有实现，不重写。
- **加入之后**：新档插进目录末尾（不进内置八行之间，免得「档位顺序」被我们 invented 一遍），当前周期切到它，触发与内置行**完全相同**的 `pickInterval` → `setView` 路径——自定义档不是第二条取数通道，这是这一片最重要的结构约束。
- **移除按钮的落点与事件**：那一整行本身是一枚可点行的 `button[role=option]`，所以移除按钮**不能嵌在它里面**（button 套 button 不合法，且 `role=option` 的无障碍子树会被拍平）。结构定为一行一枚 `div` 容器，容器里并排两枚按钮：选档那枚仍带 `role="option"`＋`aria-selected`（与内置行同一形状，目录不因档位不同而换形状），移除那枚只在自定义档行上存在，`onMouseDown`/`onClick` 一律 `stopPropagation`——否则按「×」会先选中那档、再把它移除，用户看到的是「点了删除，图先闪一下换档」。这条要有自己的针（D 组补一枚：按移除后当前周期**不是**被移除那档，且不产生新的取数请求）；另加一枚针断「内置行上没有移除按钮，目录所有行的 role/aria-selected 形状不因档位来源不同而分叉」。

## 7. 测试策略（针组，逐组给判别力）

- **A 组｜前后端文法对账**（`customInterval` 单测 ×1 ＋ pytest ×1，同一张样本表逐字两份）：合法串（`120m`/`2D`/`3W`/`5m`/`1`…）、非法串（`0m`/`2.5m`/`-5m`/`2h`/`1tick`/空/纯空格/`1H`（前端不认这个别名，服务端认——这条**故意不同**，并在两枚测试里写明：前端只产规范拼写，不接用户手打的别名））。前端断言 `parse` 结果，后端断言 `parse_interval`/`parse_resolution` 的 `kind`/`base`/`k`，两边对同一批串的**接受集与拒绝集**逐条相等（除那条已登记的别名差）。
- **B 组｜换算三件套**：`resolutionOf`／`intervalMsOf`／`intervalToPeriod` 对内置八档必须与旧表**逐字节同值**（旧 `Record` 的读数当夹具，防「加宽顺手改了内置档的拼写」这类最贵的回归——`1M`→`1m` 那种字符串 munging 事故就住在这条线上）；对自定义档给出 §4 的期望值。
- **C 组｜对话框结构**（组件测试）：C-1 打开后 `role=dialog` 恰一枚；C-2 七件骨架逐件在位；C-3 目录没有被摘（共存）；C-4 关态无 listbox、开态 listbox 恰一枚、option 恰五枚、`aria-selected` 恰一枚为 true；C-5 空输入时加入 disabled、合法输入时 enabled、重复档时 disabled 且原因可见；C-6 Escape 关闭并把焦点还给入口行；**C-7 单位按钮的可达名里单位标签只出现一次**（不复刻 doubled 名的正面断言）；C-8 换单位后越界数值 ⇒ 加入 disabled。
- **D 组｜页面接线**：加入 ⇒ 目录出现新行且当前周期是它、取数请求里的 `resolution` 是那条串（用既有 `fetchKline` spy，断言 URL 参数，不断言内部状态）；点内置行路径不变；自定义档时分时按钮 disabled 且 title 指名那条服务端规则；会话编解码往返（刷新后仍在），坏串退回 `1D` 且不被静默接受。
- **E 组｜红线（TV-CI-11）**：一枚针断言「目录行的 `disabled` 位只由 `intervalAllowed` 决定」——把 `intervalAllowed` 打成恒 `true` 与恒 `false` 各一次（变异自证，见 §9），证明这一位没有第二个来源；另加一句注释钉住「对面 `[disabled]` 是每趟瞬态，本仓不许据任何 disabled 标记推定可用性」。
- **F 组｜零回归**：`PeriodPicker` 既有的第③片针（弹层入口、`role=option`、`aria-selected`、关态 `aria-controls` 为 null）必须原样绿；`PeriodPicker.tsx` 里那句「页面测试 helper 有多份抄本，改一处不够」的旧账在本片要现场处理——`grep -rn 'PeriodPicker' frontend/src --include='*.test.tsx'` 枚数当场数，逐枚跑。

## 8. 活体验收（prod 构建，后端真进程）

沿用交付端点探真进程的规矩（asset 指纹对账，服务里的 `assets/index-*.js` 与本地 dist 那一枚同名）。八步：

1. 打开 `/chart`，点周期按钮 → 目录浮层出现。
2. 选「添加自定义周期」→ 对话框出现，**目录同时仍在 DOM 里**（读 `document.querySelectorAll('[role=dialog]').length` 与目录节点同时存在）。
3. 点单位按钮 → listbox 出现，读 option 枚数＝5、`aria-selected` 恰一枚。
4. 选「小时」、填 `2` → 加入变 enabled。
5. 按加入 → 图切到 2 小时；`list_network_requests` 里那条 `/api/udf/history` 的 `resolution=120m` 逐字读到，且响应 `s:"ok"`、bar 数 > 0。
6. 与后端真值对账：同一 `count` 下，`120m` 返回的根数应当是 `60m` 的约一半（±边界根），拿两条真实响应的条数比，不拿代码推。
7. F5 刷新 → 自定义档仍在目录、仍是当前档；分时按钮此时是 disabled，title 指名服务端那条拒绝。
8. 移除该档 → 目录回到八行、周期退回上一个合法档、图重取数。

**未来函数自查（五步）**：本片不引入任何新的前视通道——取数全部走服务端已收盘的折叠（折叠锚点在 `calendar_group_key`，第⑤片已钉）；自查步骤照旧：切档后对比「同一时刻之前的根序列」是否逐根不变（前缀不变量），Bar Replay 游标在自定义档上逐步前进不跳未来根。

## 9. 变异自证（先证明针能红）

每根针给一枚注入，逐枚记录「注入 → 哪根针红」；拿不到红的针按 HARNESS-BLIND 登记，不许默默当绿。本片最少十枚：M-1 `parse` 放过 `0m`；M-2 小时换算写成 `×10` 而非 `×60`；M-3 `resolutionOf` 对自定义档返回 `"1D"`；M-4 `intervalToPeriod` 忽略 span；M-5 对话框打开时把目录摘掉（`{!open && <Directory/>}` 那一类）；M-6 option 少给一枚（四枚）；M-7 单位按钮名 doubled；M-8 加入的 enabled 条件丢掉「重复档」那半；M-9 分时守卫摘掉（自定义档可开分时 ⇒ D 组那枚针必须红）；M-10 `intervalAllowed` 恒 true（E 组那枚必须红）；M-11 会话编码不写自定义档（刷新丢档）。

## 10. 门禁与文档面

八道门照旧（G1 `tsc -b`／G2 `vitest run`／G3 `vite build`／G4 wiki drift 套件／G5 `forensics_audit`／G6 `test_forensics_spec`／G7 水位门／G8 grep 门）。本片**动了 `frontend/**`**，所以：

- G1/G2/G3 必须跑，且 G2 要按「同一棵树 before/after」给出本片贡献枚数。
- **L0 的取证动作边界**：本片的活体步骤只允许打开类动作（`goto`/`click`/`wait_for`，`press` 只许 Escape）。填数值这一步是 `fill`，**越界**——处理方式沿用第⑥片 T0 已定的裁定：活体那趟若需要 `fill`，先按边界拒绝，把它降级为「组件测试 + 后端真值对账」，除非另立一片先修订 playbook 的动作边界。⇒ §8 的第 4～5 步在 `fill` 被禁的前提下不可自动执行，改为：手工由控制席本人完成一次并如实登记为「人做的、非 REA 取证面」，不进 L0；自动化验收只做到第 3 步为止。这条限制在档案里要写明，不假装跑齐。
- **L2 回灌**：TV-CI-09「缺」→「部分」（列 3 写自家 `CustomIntervalDialog.tsx:行`，说明里钉住「七把尺齐但名字是自己的文案、`aria-modal` 无凭据故不做」）；TV-CI-10「缺」→「部分」（五档而非六档、doubled 名不复刻）；TV-CI-11「部分」→「部分」但列 3 换成本片新坐标（红线落了代码针，`Remove` 那一列仍缺）。
- **档案**：`项目档案.md` 追加 §7.31（bytes 层，断 `CR==LF==CRLF`、裸 CR/裸 LF 为 0）。
- 商标与档位名字面量：本片在 `frontend/src/**` 里**不写**对面的控件名、档位名、键值；目录与对话框的文案全用自家中文。跟踪面四枚 needle 的读数由评审席当场取，不在本设计里引用旧数。

## 11. 风险与取舍

| 风险 | 处置 |
| --- | --- |
| 类型加宽把 `indicatorLang`／MTF 的「下层档」语义搅浑 | §5 明写：自定义档时不传 `lowerBars`，走既有空数组降级；D 组加一枚针断「自定义周期时 Pine 请求不带 lowerBars」 |
| `1M`（月线）与 `1m`（一分钟）这类大小写敏感串在加宽中被顺手 munging | B 组针把内置八档的三件套输出逐字节钉死；`customInterval` 内部一律用显式单位枚举，不解析首字符小写 |
| 前端数值边界与后端接受集不同 ⇒ 用户「加不进去」的档其实服务端能答 | A 组对账表就是为这条摆的：除登记在案的别名差，前端接受集必须等于后端接受集；边界（`1..999` 等）只砍**形状合法但明显失用**的形状，且 §4 给了理由 |
| 分时/自定义档交互是服务端硬拒绝（`session=latest` × `k>1`），前端漏守卫就是运行时错误 | §5 末段＋D 组＋M-9 三层 |
| 活体验收被动作边界卡住（`fill` 禁用） | §10 明写降级路径与限制登记，不偷偷放宽纪律，也不假装跑过 |
