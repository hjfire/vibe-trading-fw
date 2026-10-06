# Pine 脚本告警桥（alertcondition / alert）设计

日期：2026-10-06 · 状态：按用户「按推荐顺序推进」授权自决 · 分期：本文 §14

TradingView 功能对照里排第一的缺口：脚本里写了 `alertcondition()`，本项目什么都不发生。
本文把它接到项目已有的告警内核上，并给出**跨实现对账**作为唯一的验收主张。

## 1. 目标与非目标

**目标**

1. `alertcondition()` / `alert()` 在前端引擎不再是 no-op：解释器逐根算出这条条件的真假序列，
   图表侧因此第一次拥有「脚本自己的告警条件」。
2. 能在前端**静态翻译**成后端单条件语法的，一键落成真正的后端告警规则 —— 无人值守、按轮询
   自己算数、走既有 IM 投递，浏览器关掉也照样提醒。
3. 翻译不了的**必须指名道姓地拒绝**，并给出可执行的建议；绝不静默放宽语义（把 `>=` 当 `>`、
   把 `or` 只取左半边，都不允许）。
4. 一份**逐根相等**的对账夹具：前端引擎算的 bool 序列 ＝ 后端 `evaluate_condition` 逐前缀判定
   的序列。这既是翻译器的正确性证明，也是本项目「只接纳能被数值对账验证的改进」取向的落地。

**非目标（本文之后各自成为独立切片）**

- 不做「浏览器会话态告警」（页面开着才判定、经 `POST /alerts/webhook/{id}` 投递）。它需要
  Tier-B 生命周期与「只在已收盘根上判定」的门，且天生第二类公民，单开一片更诚实。
- 不改后端条件语法：不新增 `and/or` 复合、不加 `gte/lte` 算子、不动 `condition` 的存储形状。
  扩语法会同时波及 screener（`conditions.py:8` 声明两者同源）、store、routes、Alerts 表单与九语言，
  那是另一片工作，且不属于「把脚本接上」这件事。
- 不做 `freq=`（`alert.freq_once_per_bar_close` 等）的映射：后端投递节奏由
  `for_bars` / `realert_ms` / `poll_interval_ms` 决定，映射 Pine 的 freq 只会造出两套心智。
- 不做告警消息模板：Pine 的 `message="…{{close}}…"` 里的占位符是外部平台的运行时变量，本项目的
  推送文案由 `describe_condition`（`conditions.py:594`）＋ `_SERIES_LABELS`（`:539`）生成。原文照抄会
  推出一条带着未替换 `{{ticker}}` 的消息。`message` 只作为**面板里的展示文本与规则标题来源**。

## 2. 事实底座（本轮逐条实测，不是推测）

| # | 事实 | 坐标 |
|---|---|---|
| F1 | `alertcondition` / `alert` 现在是「前端不起作用，已忽略」的装饰性 no-op | `frontend/src/lib/pineRuntime.ts:1521-1524` |
| F2 | 两者同时被登记为「只作装饰、永不为数值」的名字白名单，改运行时必须一起改这里 | `frontend/src/lib/pineMath.ts:547-551` |
| F3 | 后端条件语法是封闭的 8 算子 × 单条比较：`nonEmpty/truthy/gt/lt/crossUp/crossDown/rising/falling`，`{op, lhs, rhs?, value?}` | `agent/src/alerts/models.py:95-110`、`validate_condition` `:173-206` |
| F4 | `crossUp` 的确切语义 `prev <= r_prev and last > r_last`，且必须有上一根的值，数据不够时是 **error 而不是 miss** | `agent/src/alerts/conditions.py:504-520` |
| F5 | 后端只在**最新一根**上判定；逐根历史由轮询的状态机推进（`inactive→pending→firing→resolved`、`for_bars`、`realert_ms`、抑制） | `conditions.py:432-441`、`engine.py:1-30,183-250` |
| F6 | 可解析序列名册固定：OHLCV、`change_pct`、`sma:N`/`ema:N`/`rsi:N`（**只吃 close**，见 `series = ctx.close()`）、`macd_*`/`bb_*`（**无参数**，走 `_compute_macd(s)` 默认 12/26/9）、账户与持仓类、`event_*` | `conditions.py:284-420`，指标实现 `:174-232` |
| F7 | 指标数学统一来自 `src.tools.technical_indicator_tool`（Wilder RSI / MACD / Bollinger），注释明令「本模块不得重新推导」 | `conditions.py:174-202` |
| F8 | 规则 HTTP 面已完整存在：`POST/PUT /alerts/rules`（bearer）、`GET /alerts/rules`、`/dry-run`、`/test-send`、`POST /alerts/run?deliver=false`；`event` 规则才有 `POST /alerts/webhook/{rule_id}`（凭 per-rule secret，非 bearer） | `agent/src/api/alerts_routes.py:447-478,538-567,609-691` |
| F9 | 前端已有完整规则客户端与建规则表单：`alertsApi.createRule/updateRule/listTargets/runNow/dryRun`，`AlertRuleDraft`、`RULE_ID_RE`、`validateAlertRuleForm`、`draftFromForm`、`describeCondition` | `frontend/src/lib/alertsApi.ts:25-75,179-230,272-331,446-615` |
| F10 | 周期词表两边不等：图表 `IntervalKey` 有 `1W`/`1M`，后端 `_INTERVALS` 只有 `1m/5m/15m/30m/60m/1D` | `frontend/src/lib/marketApi.ts:18,20-29`、`alerts_routes.py:51` |
| F11 | 真实语料里的 `alertcondition` 几乎都用命名参数 ＋ 引用一个已声明的 bool：`alertcondition(condition=alert_tk_cross_up or alert_tk_cross_dn, title=…)` | `.qoder/tmp/pine_corpus/16_…Cloud.pine:76-80`、`frontend/src/lib/__tests__/__fixtures__/corpus/movings/*.pine`（多份） |
| F12 | `PineArtifact` 不携带 AST（`this.stmts` 私有），但 `parsePine(src)` 是导出的纯函数 ⇒ 静态翻译走「重新解析」，不碰运行时 | `pineScript.ts:49-62`、`pineLang.ts:1303`、`pineRuntime.ts:196,336` |
| F13 | AST 形状可直接遍历：`Expr` 的 `k:"call"|"bin"|"id"|"num"|"idx"|"un"|"tern"`，`Stmt` 的 `k:"decl"(names[], value)`；`Arg` 支持 `name?` 命名参数 | `pineLang.ts:245-330` |
| F14 | 脚本工作台已有五页签外壳与「拿图表 bars 编译」的探针范式，新增页签是本仓既定扩展位；`IndicatorEditor` 的可选 props（`seed`/`symbols`/`onPickSymbol`）就是先例 | `frontend/src/components/charts/IndicatorEditor.tsx:40-63`、`workbench/EditorTab.tsx:79-127` |
| F15 | `pineSignal.ts` 只有测试在用，产物是**磁盘 JSON**（`artifacts/<code>.json`）由 skill 侧读取，没有任何上传端点 | `agent/src/skills/pine-signal/example_signal_engine.py:40,51,58` |
| F16 | **一处我此前的错判已更正**：`AlertRule.session_only` 的含义是「标的所在市场休市时跳过判定」（`models.py:277`、`service.py:385,723` → `symbol_market_is_open`），与「浏览器会话」无关，本文不复用它 | 同坐标 |
| F17 | 归属实测：`agent/src/alerts`、`agent/src/api/alerts_routes.py`、`frontend/src/lib/alertsApi.ts`、`frontend/src/pages/Alerts.tsx`、四个 `pine*.ts`、`workbench/*`、`docs/superpowers` 对 `upstream/main` 的 `ls-tree` 计数全为 **0** ⇒ 全部 fork 拥有，可改。`frontend/src/lib` 整目录计数 38 ⇒ 该目录**混有上游文件**，逐个路径判定不可省略 | `git -c core.quotepath=off ls-tree -r --name-only upstream/main -- <路径>` |

F6 与 F10 是本文最重要的两条约束：它们决定「能翻译什么」不是设计者的偏好，而是两边名册的交集。

## 3. 三条候选路与裁定

| 路 | 做法 | 无人值守 | 覆盖率 | 裁定 |
|---|---|---|---|---|
| **A 静态翻译** | Pine AST → 后端单条件规则；不可译显式拒绝 | ✅（后端自己轮询算数） | 窄（名册交集） | **采纳**，本文主体 |
| B 序列导出 | 前端逐根 bool 序列导出成 artifact，后端盯这条序列的上升沿 | ⚠️ 取决于谁在生产者刷新上跑 | 宽 | 延后为 ①b。它需要新的数据管道与生产者调度，而 F15 证明现有 pine artifact 通道是「手工产文件」，接进轮询等于新造一套子系统 |
| C 后端跑解释器 | 后端起 Node 跑 Pine 引擎 | ✅ | 全 | **否决**。「解释器只在前端」是本仓有意的架构边界（`pine-architecture-and-csp-decisions`），且会把 2000 行求值器复制成第二个语义源 |

A 的真实代价就是覆盖率，而覆盖率是**可以用数字量出来的**（§7 的夹具与 §12 的 DoD 都要求报出「语料里 N 条 alertcondition，M 条可译」），不是用形容词辩护的。

## 4. 架构与数据流

```
Pine 源码
  ├─(1) parsePine ──→ Stmt[] ──→ pineAlertRules.ts（纯，静态）──→ PineAlertPlan[]
  │                                                      native / refused
  └─(2) compilePine ─→ runPine ─→ PineResult.alerts（逐根 bool 序列）
                                        │
      面板（AlertsTab）读取两者并并排显示 ┘
                                        │
                     alertsApi.createRule / updateRule（同 id ⇒ PUT，幂等）
                                        │
                                        ▼
        后端既有链路（本设计一行不改）：poller → EvalContext → evaluate_condition
        → advance_rule 状态机 → delivery → IM 通道
```

(1) 与 (2) 是**两个独立实现**，这正是设计要的地方：面板把两者摆在一起，用户在图表上看到
「脚本自己怎么判」，规则里存的是「后端将怎么判」，两者不一致当场就能看出来。§7 把这条
不一致变成 CI 里的硬断言。

三个新单元，每个只回答一件事：

| 单元 | 是什么 | 依赖 |
|---|---|---|
| `frontend/src/lib/pineAlertRules.ts` | 源码 → 告警计划表，纯函数，无 DOM 无网络 | `parsePine`（`pineLang.ts:1303`）、`alertsApi` 的类型 |
| `PineResult.alerts`（`pineTypes.ts:274`） | 引擎逐根算出的条件序列 | 运行时求值，已有 |
| `workbench/AlertsTab.tsx` | 呈现＋建规则，唯一有副作用的一层 | 上两者、`alertsApi` |

## 5. 运行时改动（让 F1 不再是 no-op）

`pineRuntime.ts:1521-1524` 改为：对 `alertcondition`，取 `condition=`（或第 1 个位置参数）与
`title=`/`message=`，把当根的求值结果 `=== true` 记进 `result.alerts[i].hits`；对 `alert`，取第
1 个参数同理，消息文本取第 2 个参数的字面量（**仅用于展示**）。同时从 `isDecorativeName`
（F2）的白名单里摘掉这两个名字，否则别处的「装饰性」分类会跟运行时打架。

四条语义裁定：

1. **na 不是命中**。Pine 早期 `na` 的 bool 记 `false`，与 TV 一致；不额外造 warning。
2. **判定在当根收盘后完成**。引擎本来就是逐根走 `bars`，不做任何前瞻；`barstate.isconfirmed`
   为假时 TV 允许 `once_per_bar_open` 之类提前触发，本文一律不当回事（非目标 §1）。
3. **一个脚本里多条同名 title 的 alertcondition 是两条独立序列**，以 `line` 号区分，绝不合并。
4. **MTF/HTF 游标照旧**。`request.security` 的宿主游标切换（`pine-mtf-request-security`）不受影响：
   本文只是在调用返回处多记一个 bool，不引入新的求值路径。

`pineIndicatorWire.test.ts:155-162` 现在断言「警告文本包含 alertcondition」，那是 F1 的快照，
必须改成断言 `result.alerts` 的形状。这是一条**回归红**，不是兼容性问题：旧断言描述的是缺陷。

## 6. 翻译器判据（v1 完整语法表）

序列表达式（`lhs`/`rhs` 可接受的形式）。**后端指标只吃 close**（F6），所以源参数不是 `close`
就不是可译的，这一条不接受任何「大概是同一个东西」的近似。

| Pine 写法 | 后端序列名 | 备注 |
|---|---|---|
| `close` `open` `high` `low` `volume` | 同名 | 大小写按后端 `raw.lower()` 归一 |
| `ta.sma(close, N)` / `sma(close, N)` | `sma:N` | N 必须是字面整数，1..500（`_split_name` `:235-248`） |
| `ta.ema(close, N)` / `ema(close, N)` | `ema:N` | 同上 |
| `ta.rsi(close, N)` / `rsi(close, N)` | `rsi:N` | 同上 |
| `[a,b,c] = ta.macd(close)` 后引用 `a`/`b`/`c` | `macd_line`/`macd_signal`/`macd_hist` | **仅当** decl 调用不带任何周期实参（后端走默认 12/26/9） |
| `[u,m,l] = ta.bb(close)` 后引用 | `bb_upper`/`bb_middle`/`bb_lower` | 同上限制 |
| 数字字面量 | `value` | 只能出现在 rhs 位 |
| 其它任何表达式 | — | 拒绝，reason 点名它 |

算子（`op`）：

| Pine | 后端 | 处理 |
|---|---|---|
| `a > b` | `gt` | ✅ |
| `a < b` | `lt` | ✅ |
| `a >= b` / `a <= b` | — | ❌ 后端无 `gte/lte`；`gt` 少等号就是少等号，拒绝 |
| `ta.crossover(a, b)` | `crossUp` | ✅ |
| `ta.crossunder(a, b)` | `crossDown` | ✅ |
| `ta.cross(a, b)` | — | ❌ 双向穿越，单条件表达不了，建议拆两条规则 |
| `x > x[1]` / `x < x[1]` | `rising x` / `falling x` | ✅ 仅当 `x` 在上表名册内且下标是字面 `1` |
| `ta.change(x) > 0` / `< 0` | `rising x` / `falling x` | ✅ |
| 裸 bool 序列 `x` | `truthy x` | ✅ 仅当 `x` 本身是名册内的**数值**序列（`truthy` 的实现是 `last > 0`，`conditions.py:484`）；来自脚本自定义比较结果的 bool 拒绝 |
| `a and b` / `a or b` / `not a` / 三元 / `if` 表达式 | — | ❌ |

标识符解析：从**顶层** `decl`/`assign` 建一张 `name → Expr` 表，`id` 节点按表展开，允许多跳
（`longSignal = ta.crossover(fast, slow)`，`fast = ta.ema(close, 5)` ⇒ 全链可展开）。三种情况一律
拒绝而不是猜：解析不到（局部作用域、函数参数、循环变量）、成环、展开后越出名册。
`input.int/float` 的引用取其 `def` 字面量当作 `value`，但**必须在面板里把这条注明出来**（用户改
了滑块，规则不会跟着变——这是翻译的固有失真，只能标注不能掩盖）。

`alert()` 的位置：顶层 `alert(cond, "msg")` 与「`if (cond)` 体内只有这一条 `alert()`」两种形状
按 `alertcondition` 同等处理；`if` 体里还有别的语句时拒绝（条件到底门住了什么已经不确定了）。

规则字段推导（`AlertRuleDraft`，F9）：

- `id` = `"pine-" + fnv1a(symbol + "|" + line + "|" + canonicalCondition)` 的 12 位十六进制。
  确定性 ⇒ 同一脚本同一标的重复创建走 PUT 覆盖而不是堆重复规则；`symbol` 参与哈希 ⇒ 同一条
  alertcondition 挂两个标的不会互相顶掉。字符集满足 `RULE_ID_RE`/`SAFE_RULE_ID_RE`。
- `kind` = `market`；`title` = `title=` 的字面量，缺失时退化为 `alertcondition@L{line}`。
- `symbol`/`interval` = 图表当前标的与周期；**`1W`/`1M` 直接拒绝**（F10），reason 说明后端没有
  这两个周期，建议改用 `1D` 或手工建规则。
- `count` = `min(2000, max(320, 最长所需周期 + 60))`，满足 `count ≥ 2`（`validate_rule:233`）与
  `count ≤ 2000`（`:235`），并给指标留收敛余量。
- `adjust` 取图表当前复权档（拿不到就用后端默认 `qfq`），并在面板里显式显示为可改 ——
  两边的复权口径不一致会让 `close` 本身就不是同一个数，这是比算子更容易出错的一处，所以它必须
  可见、可改、而不是被自动决定掉。
- `for_bars`/`severity`/`targets`/`session_only`/`send_resolved`/`poll_interval`：面板给默认值
  （1 / info / 用户选过的推送目标 / false / true / 后端默认），全部可改。
- `enabled` = `true`（建了就要生效），面板上直接给暂停开关。

## 7. 数值对账 harness（本设计的验收核心）

一份夹具、两个消费者，比较的是**两个独立实现**：

`frontend/src/lib/__tests__/__fixtures__/pineAlertBridge/<case>.json`

```jsonc
{
  "name": "ema-cross-up",
  "code": "//@version=5\nindicator(\"t\")\nalertcondition(ta.crossover(ta.ema(close,5), ta.ema(close,20)), \"EMA金叉\", \"\")\n",
  "interval": "1D",
  "bars": [{ "timestamp": 1704067200000, "open": 1, "high": 1, "low": 1, "close": 100, "volume": 1 } /* 400 根 */],
  "cases": [
    { "condition": { "op": "crossUp", "lhs": "ema:5", "rhs": "ema:20" },
      "pineHits": [false, false /* … 400 项 */],
      "minPrefix": 120 }
  ]
}
```

- **`bars` 存在夹具里**，两边读同一组数字，不做「各自生成随机序列再对表」。
- **`minPrefix` 是预热／播种暂态闸门，不是「后端够不够算」的下限。** 两边递推约定实测不同：
  后端 `_compute_ema` 是 `ewm(span=period, adjust=False)`（`technical_indicator_tool.py:151-155`），
  与前端 `emaStep` 的「首值播种＋递推」（`pineTa.ts:134-143`）**是同一个递归**，但后端在
  `len < period` 时直接返回 None（`_compute_ema:153`）、RSI 在 `len < period+1` 返回 None
  （`_compute_rsi:167`）；而 `ta.rsi` 两侧真的不一样——后端用 `ewm(alpha=1/period,
  min_periods=period)` 且**没有显式 `adjust=False`**（`:172-173`，pandas 默认 `adjust=True`
  ⇒ 几何加权带重归一，不是标准 Wilder 递推），前端 `rmaStep` 是「前 n 根 SMA 播种再按
  `1/n` 递推」（`pineTa.ts:147-160`）。两者只差在**暂态**，随 `(1-1/n)^k` 几何衰减，长窗口尾部
  数值一致。所以 `minPrefix` 取 `max(2*周期 + 40, 100)`：对账要比在「规则真正会站的数据位置」
  （生产里 `count` 默认 320），而不是比谁把暂态也凑巧对齐。这一条必须写进夹具字段说明，否则
  后来者会把它误读成后端最小可算根数、填进 22 之类的数，于是一条正常的 EMA 规则会因为第 25 根
  上的播种差被判成实现有 bug。
- 还有一个已知的边界分歧，夹具数据必须避开、测试里点名断言：全涨序列下 `dn === 0` 时前端 RSI
  返回 50（`up === 0` 时）或 100（`pineTa.ts:554-555`），后端只看 `avg_loss == 0` 就返回 100
  （`_compute_rsi:174-175`）。合成序列用带涨带跌的随机游走，不允许出现单边段。
- **TS 侧**（`pineAlertBridge.test.ts`）：`compilePine(code, bars)` → `result.alerts[0].hits` 必须逐根
  等于 `pineHits`。这一腿证明「夹具里的期望序列就是引擎今天的输出」。
- **Python 侧**（`agent/tests/test_alerts_pine_reconciliation.py`）：对每个前缀长度 `i ≥ minPrefix`，
  用 `bars[0..i]` 构造 `EvalContext`，`evaluate_condition(case.condition, ctx).hit` 必须等于
  `pineHits[i]`；对 `i < minPrefix` 断言后端**不得给出 hit**（数据不足时必须是 error 或 false，
  绝不能是 true）。
- **反假绿三闸**（本仓两次教训的形状：空集合真空通过／全 False 序列 trivially 相等）：
  1. 每条 case 的 `pineHits` 必须**同时含 true 与 false**，且 true 至少出现 1 次 —— 断言出来，
     不是靠肉眼看夹具；
  2. 每条 case 必须**实际比较 ≥ 100 个前缀**，测试里断言这个计数；
  3. 夹具目录读不到、`cases` 为空、`pineHits.length !== bars.length` 一律 `raise`，**不许 skip**。
- **生成纪律**：夹具由一次性的显式命令（`EMIT=1` 环境变量守卫）产出后**提交入库**，正常测试运行
  全程只读。本仓有过 oracle 生成器覆写被跟踪文件的事故（`ops-oracle-fixture-generators-side-effects`），
  默认关闭不是可选项。
- 首批夹具 ≥ 4 条，覆盖：`crossUp(ema,ema)`、`gt(rsi,常量)`、`lt(close, sma)`、`rising(volume)`，
  外加一条语料派生的真实脚本。

对账最可能**通不过**的一条腿是 `rsi:N`（F7 ＋ 上面实测的 `adjust` 缺省项）：后端 RSI 与前端 RMA
在长窗口上会收敛，但收敛到的位有多少根、`min_periods` 与 `full(st,n)` 的门槛谁更晚，都得由夹具
说话。处理办法是数据驱动的：**哪条 case 对不上，就从 §6 名册里摘掉哪个序列**，并在本文留一条
更正记录，而不是放宽容差、也不是让两边「差不多就行」。告警比图表早一根或晚一根响，用户无法
区分是语义分歧还是数据延迟，这种含糊必须消灭在门禁里。首批夹具若 `rsi:N` 对不齐，本文的
§6 表里那一行改成 ❌ 并附差分读数——这是设计允许的收口方向，不是失败。

## 8. 面板（AlertsTab）

`IndicatorEditor` 增加第 6 个页签 `{ key: "alerts", label: "脚本告警" }`（`types.ts` 的 `TabKey`
同步），沿用 F14 的可选 props 先例，`ProChart` 传入 `symbol`/`interval`/`adjust` 三个可选值。
页签取不到 `draft.code` 或不是 Pine 方言时，与 `EditorTab.tsx:83-88` 一样安静地不出内容。

面板内容：每条 alertcondition 一行，左侧状态徽标（可译为规则／不可译），中间同时显示
「引擎逐根判定：第 12、45 根命中」与「后端条件：`ema:5` 上穿 `ema:20`」，右侧按钮
创建／更新／在告警页打开。不可译的行显示 reason 全文与建议，**没有创建按钮**（拒绝必须是
不可绕过的，不给「还是要一下」的入口）。

推送目标来自 `alertsApi.listTargets()`（`GET /alerts/targets`）。一次都没有时，面板要明说
「未选择推送目标，规则只记录不通知」并给出告警页链接 —— 建出一条永远不会说话的策略是
最坏的交付。面板的默认设置（symbol/interval/target/for_bars/severity）持久化在
`localStorage["pro-chart.pineAlerts.v1"]`，与 `ScreenerTab.tsx:44` 同一范式。

文案沿用 workbench 既有做法：页签标签与正文直接写中文（`IndicatorEditor.tsx:57-63` 就是字面量），
`Alerts.tsx:77-89` 的 `useText()` + `defaultValue` 只在需要 i18n 时用。本切片**不动九份 locale**，
与 workbench 现状一致，也不产生上游冲突面。

## 9. 错误处理与边界

- `parsePine` 抛错（语法不通）：翻译器把错误原样带回 `[{status:"refused", reason: 解析错误}]`，
  面板提示「先修语法」。翻译器**不吞异常**，也不返回空数组冒充「没有告警条件」。
- 脚本里根本没有 `alertcondition`/`alert`：返回空数组，面板出一个诚实的空态。
- 后端 422（`validate_rule` 的任何一条）：原样显示 `detail`，不降级成「创建失败」。
- `createRule` 命中已存在但**不是** pine 派生（id 前缀不同）的规则：不可能发生，因为 id 由本文
  生成；反过来，同 id 的旧规则被用户手工改过条件时，PUT 会覆盖它 —— 面板在覆盖前显示该规则的
  现有条件（`GET /alerts/rules/{id}`）并要求二次确认。静默吃掉用户手改的规则是不可接受的。
- 引擎中止（`artifact.abort`）：`alerts` 序列只覆盖已走到的根，序列长度小于 `bars` 时面板标注
  「脚本在第 N 根后停止，告警序列不完整」。

## 10. 文件清单

| 面 | 路径 | 归属（F17） |
|---|---|---|
| 新 | `frontend/src/lib/pineAlertRules.ts` | fork |
| 新 | `frontend/src/lib/__tests__/pineAlertRules.test.ts` | fork |
| 新 | `frontend/src/lib/__tests__/pineAlertBridge.test.ts` ＋ `__fixtures__/pineAlertBridge/*.json` | fork |
| 新 | `agent/tests/test_alerts_pine_reconciliation.py` | fork |
| 新 | `frontend/src/components/charts/workbench/AlertsTab.tsx` | fork |
| 改 | `frontend/src/lib/pineRuntime.ts:1521-1524` ＋ `pineMath.ts:547-551` ＋ `pineTypes.ts:274`（`alerts` 字段） | fork |
| 改 | `frontend/src/components/charts/IndicatorEditor.tsx`（页签＋可选 props） | fork |
| 改 | `frontend/src/components/charts/workbench/types.ts`（`TabKey`） | fork |
| 改 | `frontend/src/pages/ProChart.tsx`（传三个 props） | fork |
| 改 | `frontend/src/lib/__tests__/pineIndicatorWire.test.ts:155-162`（旧 no-op 快照） | fork |
| 新 | `docs/superpowers/specs/2026-10-06-pine-alert-bridge-design.md`（本文） | fork |

后端 `agent/src/alerts/**` 与 `alerts_routes.py` **零改动** —— 这是本设计刻意压下来的爆炸半径：
规则只是通过既有 HTTP 面创建，告警内核的状态机、投递、抑制、轮询一行不动。

## 11. 门禁与 DoD

1. `npx tsc --noEmit` 静默；`npx vitest run` 全量绿（用例数只增不减，基线在开工当轮现场取，
   不引用历史读数）；`npx vite build` 成功。
2. `python -X utf8 -m pytest agent/tests/test_alerts_pine_reconciliation.py -q` 绿，且输出里能看到
   「比了几条 case、几根」的计数断言通过。
3. `python -X utf8 -m pytest tools/test_wiki_drift.py -q` 与 `bash tools/wiki_freshness_gate.sh`
   复跑；水位**不放宽**（开工基线实测：`HEAD=1efc1cc1` 上 `stale --format count` = **443**，阈值
   `WIKI_STALE_MAX=439` ⇒ 门在本片开工前已经是红的，那是 M5 次片在报的活，本文不解决也不得掩盖）。
   新页面/新模块若被 wiki 引用锚点覆盖，按 `ops-repo-wiki-git-root-and-update` 的配方处理。
4. `bash tools/ci_grep_gates.sh` 只允许既有的 `./.qoder/` 命中（上游文件的口径缺陷，明令不修）。
5. 覆盖率数字必须报出来：对 `.qoder/tmp/pine_corpus/` 与 `__fixtures__/corpus/` 里全部含
   `alertcondition` 的脚本跑翻译器，报告 `N 条 alertcondition 中 M 条可译`、以及不可译的 reason
   分布。这条统计本身进测试（阈值下限断言，防止翻译器被改哑后静默 0 覆盖）。
6. 活体验收（用户要求的交付形态）：真实图表上跑一条 `alertcondition`，创建规则，回 `/alerts`
   页确认条件文案与状态，`POST /alerts/run?deliver=false` 对该规则出判定；并附未来函数自查
   （规则只用 `count` 根已收盘数据、`crossUp` 读的是 `prev/last` 两根已收盘值，无重绘）。
7. 变异探针：至少对「na 当命中」「`>=` 译成 `gt`」「空 `cases` 被 skip」「`pineHits` 全 false 也算过」
   四处下针，逐处必须杀得掉；杀不掉的按 `verify-mutation-probe-blindness` 三态裁定写明成因。

## 12. 风险登记

| 风险 | 处置 |
|---|---|
| 两边指标数学有微小分歧 ⇒ 告警与图表差一根 | §7 对账硬断言；对不上就缩名册，不放宽容差 |
| 覆盖率被质疑「翻译了个寂寞」 | §11.5 要求报出真实 N/M 与 reason 分布；不可译项在面板里直接给手工建规则的指引 |
| 用户改了脚本条件，旧规则还挂在后端 | 确定性 id 让重新创建即覆盖；面板列出「后端现存规则但脚本里已删除」的孤儿项，提示删除 |
| `adjust`/`count`/`interval` 与图表不一致导致判定的不是同一份数据 | 三项都在面板显式可见可改，不做无人认领的自动决定 |
| 新建 `PineResult.alerts` 让 artifact 变大 | 只在脚本确有 alertcondition 时才建数组；`publishArtifact`/`ReportTab` 消费者不动 |
| wiki 水位开工即 443/439（`HEAD=1efc1cc1` 实测）已经红了，本片的 wiki 连带读数会被误读成我造成的 | 交付时同一命令复跑对比，两个数都带坐标写进档案 |

## 13. 已否决／延后的相邻想法

- 后端加 `and/or` 复合条件：见 §1 非目标，动的是共用语法。
- 告警消息模板（`{{close}}`）：见 §1 非目标。
- `plotshape`/`barcolor` 驱动的隐式告警：语义是装饰性的，与「条件」不同源，不做。
- 会话态告警（Tier B）、序列导出（Tier B 的无人值守版）：§14。

## 14. 切片顺序（用户已批准的推荐序）

①本文＝脚本告警桥 → ② Bar Replay → ③ 画线扩充＋magnet＋图例 → ④ Heikin-Ashi → ⑤ VPVR。
本文交付后，①b（序列导出 → 盯上升沿）作为独立切片评估，它才有资格动后端。
