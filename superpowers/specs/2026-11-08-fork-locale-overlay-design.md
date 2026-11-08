# 自研 locale 覆盖层：把 11 枚上游语言文件撤出分叉面

- 日期：2026-11-08
- 状态：设计已定，待实现
- 取证坐标：`main = b292dfb6`，`upstream/main = 2ac20879`（上游每日推进，本文所有「当前」读数都钉在这两枚号上；要当前值请重跑本文给出的命令）
- 归属：本片是 fork 二开的**冲突面削减**片，不是功能片。用户可见文案一字不变。

## 一、问题与证据

### 1.1 分叉面的形状

`git diff --name-only upstream/main main` 在取证坐标下列 **1112** 枚路径，其中：

- **1036** 枚是本仓新增（上游没有这个路径 ⇒ 合并时不会冲突）
- **76** 枚是**改过的上游文件**（两边都有 ⇒ 每次同步都是潜在冲突面）
- **0** 枚上游文件在本仓缺失

所以真正承载永久冲突成本的是那 76 枚，不是 1112。本片只针对其中一类。

### 1.2 locale 是已证实的复发性冲突类

三轮同步的档案记录（`项目档案.md`，行号为取证坐标时实测）：

- `:1958`（2026-10-11 轮）：内容冲突 **28** 枚，名单含 `locales×9`
- `:2231`（2026-10-22 轮）：`frontend/src/i18n/locales/*.json` **11** 枚按机械并集逐枚重解
- `:2462`（2026-11-03 轮）：`git merge-tree --write-tree --name-only HEAD^1 HEAD^2` 列 **23** 枚，其中 `frontend/src/i18n/locales/*.json`（**10**）

冲突机制在 diff 里看得见：本仓的 5 枚键插在上游自己的 `pixelOffice` 与 `paperTrading` 之间，上游每加一个页面就在同一 hunk 区动土。这不是偶发，是插入点相邻导致的结构性碰撞。

### 1.3 分叉内容是纯增量、零改值

对 11 枚语言文件逐枚做叶路径差集（`git show upstream/main:<path>` 解析后与工作树解析结果比对，脚本在仓库外）：

| 语言 | 上游叶数 | 本仓叶数 | added | removed | changed |
| --- | --- | --- | --- | --- | --- |
| en / zh-CN / ja / ko / ar / fa / es / de / pt-BR / id / tr | 2170 | 2185 | 15 | 0 | 0 |

11 枚全部同形，且 **added 的键路径集合在 11 语言间完全一致**。15 枚路径是：

```
layout.{proChart,multiChart,alerts,warehouse,help}
navigation.descriptions.{proChart,multiChart,alerts,warehouse,help}
navigation.instructions.{proChart,multiChart,alerts,warehouse,help}
```

这 5 个 id 正是本仓自研的 5 个导航入口（`frontend/src/components/layout/navigation.ts` 的 `NAVIGATION_GROUPS`，该文件本身已在分叉面内）。**没有一枚键属于上游页面。**

### 1.4 消费者与承重约束

- `frontend/src/components/layout/PageHelp.tsx:15,19,20` 读 `layout.${item.id}` / `navigation.descriptions.${item.id}` / `navigation.instructions.${item.id}`
- `frontend/src/components/layout/SidebarNavigation.tsx:49` 读 `navigation.descriptions.${itemId}`
- 两处都由 `NAVIGATION_GROUPS` 驱动迭代 ⇒ **键集由自研注册表决定，没有任何代码动态枚举 locale 键**
- `frontend/src/i18next.d.ts`（**上游所有**，`ae9aee92`）把 `CustomTypeOptions.resources.translation` 派生为 `typeof en`，其中 `en` 就是 `./i18n/locales/en.json` ⇒ 抽走键会让上述模板字面量键在 `tsc -b` 下变成类型错误。**这是本片必须同时扩类型的原因，不是可选优化。**
- `frontend/src/__tests__/navigationCopy.test.ts`（**本仓新增**）用 `node:fs` 从磁盘读 11 枚 locale，断言每个导航 id 三族文案齐全 ⇒ 抽走键后它必然红，必须改成断言**合并后的有效 bundle**
- `frontend/src/i18n/__tests__/i18n.test.ts`（上游所有，当前 +2/-2）做双向平价：每枚语言必须含 en 的全部键、且不得有多余键；还断言磁盘上的语言文件集合 == `SUPPORTED_LANGUAGES`。**11 枚同时撤掉同样 15 枚键后这套门原样通过，本片不改它。**
- `agent/tests/test_channel_config_meta.py:1076` 也读前端 `en.json`，但只沿 `hint["help_key"]` 走 channel 配置字段路径 ⇒ 与本片 15 枚键无交集，**不受影响**
- `frontend/src/i18n/locales/tsconfig.json` 是上游的游离件（`ae9aee92`，与上游逐字相同），平价门显式过滤它 ⇒ **不动**

### 1.5 运行时形状（必须保住的那一半）

`frontend/src/i18n/index.ts`（上游所有，逐字未改）当前：`en` eager 进 `init({resources})`，其余 10 枚经 `localeLoaders` 动态 import，落地时 `i18n.addResourceBundle(code, "translation", resources, true, true)`（deep ＋ overwrite），并有「慢 import 不得撤销更新的选择」与失败回退 `lastStableLanguage` 的逻辑。

体积实测（覆盖层 15 键 × 11 语言，扁平 JSON）：**18659 B raw / 7438 B gzip**；en 单语 **1483 B raw / 674 B gzip**。

⇒ 覆盖层必须**照上游的 eager-en / lazy-其余**形状做，否则初始载荷凭空多 6.8 KB gzip。照做则 en 侧字节零回归（那 674 B 今天就在 eager 的 en.json 里），非英语侧字节零回归、多一次约 1.5 KB 的小请求（仅在用户显式切语言时发生）。

## 二、目标与非目标

### 目标

1. `frontend/src/i18n/locales/` 下 **11 枚语言文件全部回到与上游逐字相同**
2. 15 枚键 × 11 语言迁到本仓新增的 `frontend/src/i18n/fork/`，用户可见文案**逐字不变**
3. `t()` 的类型面仍认这 15 枚键（`tsc -b` 绿）
4. 新增守卫让「覆盖层漏语言／漏键／与上游键撞名」在本地就红，而不是等到渲染出字面点路径
5. 冲突面：那 76 枚里的 11 枚 locale 撤出，换进 `i18n/index.ts` 与 `i18next.d.ts` 两枚小改 ⇒ **预期 76 → 67**（这是预期，不是读数；落地后按 §六 的命令现读）

### 非目标

- 不动 7 份 README 的分叉、不动 `package-lock.json`、不动后端 loaders
- 不在本片拆 `ProChart.tsx`（那是后续纲领，见 §八）
- 不改上游的 `i18n/__tests__/i18n.test.ts` 平价逻辑
- 不删上游的游离 `locales/tsconfig.json`
- 不引入 i18next 后端插件、不改语言探测/回退策略

## 三、设计

### 3.1 新增件（全部本仓所有，零冲突成本）

```
frontend/src/i18n/fork/
  en.json  zh-CN.json  ja.json  ko.json  ar.json  fa.json
  es.json  de.json     pt-BR.json  id.json  tr.json
  index.ts
  __tests__/forkOverlay.test.ts
```

每枚 JSON 是**嵌套**形状（`addResourceBundle` 要的就是 translation 子树），只含那 15 枚键：

```json
{
  "navigation": {
    "descriptions": { "proChart": "…", "multiChart": "…", "alerts": "…", "warehouse": "…", "help": "…" },
    "instructions": { "proChart": "…", "multiChart": "…", "alerts": "…", "warehouse": "…", "help": "…" }
  },
  "layout": { "proChart": "…", "multiChart": "…", "alerts": "…", "warehouse": "…", "help": "…" }
}
```

值从取证坐标的 11 枚 locale 里**逐字搬**（已留档在仓库外的 `locale_delta.json`，实现时以 `git show b292dfb6:<path>` 为唯一真值源重新取一遍，不靠转述）。

`fork/index.ts` 照上游 `i18n/index.ts` 的形状写：

```ts
import type { SupportedLanguageCode } from "../index";
import forkEn from "./en.json";

type ForkLazyCode = Exclude<SupportedLanguageCode, "en">;

export { forkEn };

export const forkLoaders = {
  "zh-CN": () => import("./zh-CN.json"),
  // …其余 9 枚
} satisfies Record<ForkLazyCode, () => Promise<{ default: typeof forkEn }>>;
```

两个要点：

- `import type` 是**纯类型**导入，编译后擦除 ⇒ 与 `../index` 不构成运行时循环
- `satisfies Record<ForkLazyCode, …>` 给**双向穷尽**：`SUPPORTED_LANGUAGES` 加一门语言而覆盖层没跟上 ⇒ `tsc` 红；覆盖层多一门没人注册的语言 ⇒ 对象字面量的多余属性检查同样红。这条守卫不花任何运行时成本。

### 3.2 上游文件的改动（两处，都尽量纯追加）

**`frontend/src/i18n/index.ts`** —— 三处追加，零删除：

1. 在 `import en from "./locales/en.json";` 之后加 `import { forkEn, forkLoaders } from "./fork";`
2. 在 `.init({…});` 之后加 `i18n.addResourceBundle("en", "translation", forkEn, true, true);`
   （`initAsync: false` ⇒ init 同步完成，追加紧随其后即可；用 `addResourceBundle` 的 deep 合并而不是对象展开，因为 `navigation.descriptions` 是上游已有的分支，浅展开会整枝覆盖掉上游的键）
3. 在 `loadLanguage` 的 try 块里、上游那句 `addResourceBundle` 之后加两行：
   ```ts
   const { default: forkResources } = await forkLoaders[code]();
   i18n.addResourceBundle(code, "translation", forkResources, true, true);
   ```
   放在 try 内 ⇒ 覆盖层加载失败走同一套两次重试与回退，不会留下半套文案。放在上游 bundle **之后** ⇒ 万一将来撞名，本仓的值确定性胜出（而不是被上游静默盖掉）；撞名本身由 §3.4 的 disjointness 针在本地拦下。

**`frontend/src/i18next.d.ts`** —— 一行 import ＋ 一行改：

```ts
import type forkEn from "./i18n/fork/en.json";
// …
translation: typeof en & typeof forkEn;
```

交叉类型对属性访问是逐层生效的：`(A & B)["navigation"]["descriptions"]` = `A[…] & B[…]`，键集取并 ⇒ 17 个导航 id 的模板字面量键全部可解析。

**待验证项（不当成已知）**：i18next 的键路径推导是否在交叉类型上完全正常，由 Task 1 的 `tsc -b` 判定。若它报键不存在，退路是在 `fork/` 里放一个本仓所有的 `DeepMerge<A, B>` 类型 helper 并让 d.ts 用它——退路同样只改这一枚上游文件的同一行，不扩散。

### 3.3 既有守卫改口（本仓新增件，零冲突成本）

`frontend/src/__tests__/navigationCopy.test.ts`：`readLocale(code)` 改为返回**有效 bundle** ＝ 磁盘 locale 与磁盘 fork 覆盖层的深合并。合并语义必须与运行时那句 `addResourceBundle(code, "translation", fork, true, true)` 一致：递归逐键合并、两枚都是分支对象时继续下潜、叶子上**覆盖层胜出**、只在一侧出现的键原样保留。所有既有断言一字不改地跑在合并结果上。

改口的理由要写进该文件的注释：这套守卫断的是「用户看得到的文案齐全」，而文案从此住在两枚文件里；只读其中一枚会把「覆盖层漏了」判成绿。原注释里「upstream now owns … nine locale files」那句按实测更正（磁盘上是 11 枚，且本片之后上游那 11 枚不再含自研键）。

### 3.4 新增守卫（`fork/__tests__/forkOverlay.test.ts`）

语言集合一律**从磁盘发现**（`import.meta.glob("../fork/*.json")` 式或 `node:fs`  readdir），不写死名单——写死名单就是「平价完美但那门语言根本没被测」的老病灶。

1. **磁盘 ↔ 注册表双向相等**：`fork/*.json` 的码集 == `SUPPORTED_LANGUAGES`
2. **覆盖层内部平价**：11 枚的叶路径集合两两相等（对 en 覆盖层做双向差集，缺键与多键各一支）
3. **disjointness（兼冲突面回归针）**：覆盖层叶路径 ∩ 上游 locale 叶路径 == ∅，11 语言逐枚。这一条同时承担两件事：它是「合并顺序无关」的前提，也是「将来某次同步把自研键并回 locale」的本地红——键一并回去，交集立刻非空。不再另立一支「locale 不含自研键」的守卫，那与本项目判据等价，摘掉任一支都必然等价，属冗余双守卫。
4. **运行时逐语言解析**：`await i18n.changeLanguage(code)` 后，`i18n.t(k)` 对 15 枚键逐枚 `toBe(覆盖层里的值)`。断言右边是**覆盖层 JSON 的值**，不是 `t()` 再跑一次（否则恒真）；也不是只断「不等于键路径」（那会放过回退到英文）
5. **自研 id 三族齐全**：从 `NAVIGATION_GROUPS` 取 id 集，凡不在上游 locale 里的 id（即由覆盖层供文案的那些），其 `layout` / `navigation.descriptions` / `navigation.instructions` 三族必须在覆盖层里齐全。id 集从注册表派生，不写死 5 枚——注册表加了入口而文案没跟上 ⇒ 红
6. **文案质量**：非空字符串、值不等于自身键路径、无 `â€`／`Ã`／`Â` 一类 mojibake，也无 U+FFFD 替换字符、`{{变量}}` 集合与 en 覆盖层一致
7. **慢加载竞态**：连续切两门语言，最终态的覆盖层键仍解析成最终语言的值（照上游「慢 import 不得撤销更新的选择」那条）

### 3.5 数据流

```
启动：
  main.tsx → import "./i18n"
    i18n/index.ts: import en(上游 2170 叶) + import forkEn(自研 15 叶)
    init({resources:{en:{translation: en}}})        ← 上游原样
    addResourceBundle("en", …, forkEn, deep, overwrite)  ← 本片追加
    ⇒ en 有效 bundle = 2185 叶（与今天逐字相同）

显式切到 <code>：
  languageChanged → loadLanguage(code)
    await localeLoaders[code]()   → addResourceBundle(code, 上游 2170 叶)
    await forkLoaders[code]()     → addResourceBundle(code, 自研 15 叶)   ← 本片追加
    loadedLanguages.add(code)
    ⇒ <code> 有效 bundle = 2185 叶（与今天逐字相同）

渲染：
  NAVIGATION_GROUPS(自研注册表) → item.id
  PageHelp / SidebarNavigation → t(`layout.${id}`) 等
    键类型来自 i18next.d.ts: typeof en & typeof forkEn
```

不变量：**每一门语言的有效 bundle 在本片前后逐叶相等**（2185 叶，值逐字相同）。这是本片唯一的语义承诺，也是 §五 变异自证要打的靶。

## 四、错误处理

- 覆盖层 import 失败：落在 `loadLanguage` 既有 try 内 ⇒ 两次重试；仍失败则 `console.warn` ＋ 清 localStorage ＋ 回退 `lastStableLanguage`（上游既有行为，本片不改）。回退目标语言的覆盖层若已加载则文案齐全；若回退到 en，en 覆盖层在启动时已 eager 注册 ⇒ 不会退化成字面点路径。
- 覆盖层 JSON 解析失败（构建期）：Vite 的 JSON 插件在构建时报错，`npm run build` 红 ⇒ 不会带病出货。
- 键撞名（将来上游加了同名键）：§3.4 第 3 条在本地红；运行时本仓值胜出（§3.2 的顺序裁定）。两者一起保证「不会静默丢文案」。
- 类型面失配：`tsc -b` 红（门 A），退路见 §3.2。

## 五、验收

### 5.1 RED → GREEN

RED 与 GREEN 分两步，且 RED 那一步必须**已经有覆盖层文件**，否则新守卫连 import 都过不去，红得没有判别力：

**RED 步**：只新建 `fork/` 下 11 枚 JSON（值从 `git show b292dfb6:<locale>` 逐字取）＋ `fork/index.ts` ＋ `fork/__tests__/forkOverlay.test.ts`。**不**撤 locale、**不**接运行时、**不**改 d.ts、**不**改 navigationCopy。此时跑新守卫，预期：

- 第 3 条（disjointness）**红**：15 枚键此刻还住在 locale 里，交集非空
- 第 4 条（运行时解析）**红**：覆盖层尚未注册，`t()` 对非 en 语言回退英文、对 en 则恰好命中 locale 里那份同值 ⇒ **en 支绿、其余 10 支红**。这个不对称本身就是判别力证据，要逐字留档
- 第 1/2/5/6 条绿（覆盖层自身齐全）；第 7 条与第 4 条同因红（覆盖层尚未注册）

**GREEN 步**：撤 11 枚 locale 回上游（`git checkout upstream/main -- frontend/src/i18n/locales/*.json`，注意这会同时写索引与工作树，且经 autocrlf 过滤保持 CRLF）＋ 接 `i18n/index.ts` 三处追加 ＋ 扩 d.ts ＋ navigationCopy 改口。复跑全绿。

两步的读数都留逐字记录。撤 locale 之前必须先确认 §5.2 的对账脚本能跑通「旧 locale 叶映射」这一侧的取值（即覆盖层确实逐字承载了那 15 枚键），否则撤完才发现搬漏就要从历史里捞。

Task 1 单独先验 §3.2 的类型退路：只加 `fork/en.json` 与 d.ts 的交叉类型，跑 `tsc -b`，确认 17 个 id 的模板字面量键全部可解析。这一步的读数决定要不要 `DeepMerge` 退路。

### 5.2 语义等价对账（本片的核心判据）

在仓库外跑一支对账脚本：对 11 枚语言逐枚构造「取证坐标 `b292dfb6` 的 locale 叶映射」与「实现后的 locale ∪ fork 覆盖层叶映射」，断言**两枚映射逐键逐值相等**（键集相等 ＋ 每键值相等），并打印每枚语言的叶数。任何一枚不等即失败。

这条判据不依赖测试替身，也不依赖渲染，直接钉住 §3.5 的不变量。

### 5.3 变异自证

每枚变异注入后跑对应守卫，确认**红**，再从动手前的内存副本还原（不用 `git checkout --`，树上有在飞改动）。至少覆盖：

| 编号 | 注入 | 期望红的判据 |
| --- | --- | --- |
| M1 | 某语言覆盖层删一枚键 | §3.4 第 2 条缺键支 ＋ 第 4 条运行时 |
| M2 | 某语言覆盖层加一枚无关键 | §3.4 第 2 条多键支 |
| M3 | 删 `loadLanguage` 里那两行 | §3.4 第 4 条（非 en 全红，en 仍绿 ⇒ 证明针分得清两侧） |
| M4 | 删启动那句 en 注册 | §3.4 第 4 条 en 支 |
| M5 | d.ts 退回 `typeof en` | 门 A `tsc -b` |
| M6 | 把一枚自研键并回某枚 locale | §3.4 第 3 条 |
| M7 | `forkLoaders` 删一门语言 | 门 A（`satisfies` 穷尽） |
| M8 | 某覆盖层值改成自身键路径 | §3.4 第 6 条 |
| M9 | 某覆盖层值改成英文原文 | §3.4 第 4 条（`toBe` 覆盖层值 ⇒ 红；若只断「不等于键路径」则此针存活，正好证明第 4 条必须用 `toBe`） |
| M10 | 某一语言的覆盖层整份换成空对象 | §3.4 第 2/4/5 条 ＋ §5.2 对账 |

M9 是判别力针：它专门否证「断言写宽了也能全绿」。每枚变异都要记录**注入前后的读数**，不能只写「已验证」。

### 5.4 门册

按本仓既有门册全量复跑，串行、不与重 CPU 活并发：A `tsc -b`／B 全量 vitest／C `vite build`／D `forensics_audit.py`／E `test_forensics_spec.py`／F drift 套件／G `test_wiki_drift.py + test_wiki_qmind.py + test_upstream_sync.py`（`-m "not local_archive"`）／H `wiki_freshness_gate.sh`／I `ci_grep_gates.sh`。

本地恒红的门：**先在动手前取同树基线**（未跟踪件存仓库外），落地后复跑并逐字比对，证明**本片 0 贡献**；不调阈值、不改门、不清白名单。门 I 的比对要做到字节相同。

### 5.5 活体

起后端托管的 prod 构建（不是 dev，React prod 不双跑 StrictMode），按 asset 指纹对账确认服务里的 `assets/index-*.js` 就是本地 dist 那一枚，然后在浏览器里逐语言切一遍，读侧栏标签、link title 与 PageHelp 两段文案。至少覆盖 en／zh-CN／ar（RTL）／tr（平价门特别盯的那门）。

本片不新增任何指标或信号，**未来函数自查不适用**；但 Bar Replay 与画线面要在活体里顺手点一遍确认没被 i18n 改动波及。

## 六、冲突面账（可复算，不写终态数）

耐久的判据不是「76 变 67」这个会随上游推进而漂的数，而是这条：

```bash
git diff --name-only upstream/main main -- frontend/src/i18n/locales/
```

**落地后必须输出为空**（11 枚语言文件与上游逐字相同）。这条不随上游每日推进而失效，除非上游删改这些文件本身。

配套两条：

```bash
git diff --numstat upstream/main main -- frontend/src/i18n/index.ts frontend/src/i18next.d.ts
git diff --name-only upstream/main main | wc -l
```

前者预期 `index.ts` 纯追加（deleted == 0）、`d.ts` 为 +2/-1；后者给出当前分叉总数，**引用时必须连 `upstream/main` 的 sha 一起写**。取证坐标下的基线是 1112／76，落地后的数由实现席当场测，本文不预填。

## 七、风险与回退

| 风险 | 处置 |
| --- | --- |
| 交叉类型不被 i18next 键推导接受 | Task 1 先单独验；退路 `DeepMerge` helper，仍只改 d.ts 同一行 |
| 覆盖层与上游 bundle 的合并顺序被将来改动翻转 | §3.4 第 3 条 disjointness 针 ＋ §3.2 的顺序裁定注释 |
| 某语言覆盖层漏搬 | §3.4 第 1/2/4 条 ＋ §5.2 逐叶对账 |
| 非英语多一次小请求 | 实测约 1.5 KB／语言，仅在显式切语言时发生；如实登记，不声称零成本 |
| `navigationCopy` 改口后放宽了断言 | 断言体一字不改，只换输入为合并 bundle；M3/M4/M9 证明它仍抓得住 |

回退：本片全部改动在一条分支上，`git revert` 即可；15 枚键的原文在 `b292dfb6` 的历史里永久可取，覆盖层 JSON 也逐字承载同一份值 ⇒ 不存在「撤掉就丢文案」的状态。

## 八、后续纲领（本片不做，只登记）

取证同时量出的另外两个热点，按价值×风险×可验证性排：

- **A 序：`ProChart.tsx` 拆解**（`frontend/src/pages/ProChart.tsx`，取证坐标 3518 行，fork-added ⇒ 零冲突成本）。组件自 `:549` 起，内含 42 枚 `useState`、22 枚 `useRef`、15 枚 `useEffect`、4 枚 `useMemo`、24 个处理器常量、**0 枚 `useCallback`**；JSX 自 `:2731` 起独占 788 行。安全网是 13 套 `ProChart*.test.tsx`、298 个 `it/test` 调用点（不含参数化展开）。第一刀只抽受展示组件（图例面板 `:3242`、画线面板 `:3307`、工具栏 `:2996` 起），**不动 ref 镜像与 effect 机器**——那批闭包纪律是承重的，历史上多次静默失效都出在那里。
- **C 序：后端 loader 补丁外置**（`akshare_loader.py` +351/-8、`futu.py` +129/-12、`tushare.py` +102/-17、`registry.py` +94/-38、`market_data.py` +77/-2）。这是最大的一块冲突面，但外置只有两条路：整体 fork（丢上游改进，与 fork 的目标相反）或补丁层（脆弱）。**先取证 `backtest/loaders/registry.py` 的发现机制**（fan-in 44）能不能承载本仓自己的 loader 模块，再决定；本片不裁定。
- **不动项（取证后明确判为健康）**：`src/factors/base.py` fan-in 463，其中 461 枚来自 `src/factors` 内部，内容是 `rank`/`zscore`/`ts_corr`/`delta`/`decay_linear`/`safe_div` 一类数学原语 ⇒ 这是共享核，不是上帝模块。Python 模块图 1535 节点／2334 边／**0 环**，前端生产图 150 模块／560 边／**0 环** ⇒ 没有环要解。
