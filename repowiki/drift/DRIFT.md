# Repo Wiki 漂移报告

- 生成时间：2026-10-01T20:24:53+00:00
- 当前 HEAD：`fc590da907408b1593ce3b3dd8f77e41a54c1c20`
- Wiki 快照基线：`7fdffa31a0d6ff54d236db3dea6adaf8d1ca6709`（只读取，不改写 `repowiki-metadata.json`）
- 页面：共 450｜需更新 445｜已一致 5（其中台账已对齐 1、台账失效 0、只改了链接 423）
- 引用源文件：813 个｜自各页有效基线以来有变更 338｜已不存在 8
- 缺 frontmatter 的页面：0（播种之前应为全部；播种之后非零即漏播种）｜基线来自页自身的 0
- 无任何页面引用的改动文件：888

## 待更新页面（按问题引用数排序）

| # | 页面 | 状态 | 有效基线 | 引用数 | 问题 |
| --- | --- | --- | --- | --- | --- |
| 1 | `前端应用/聊天界面组件/专用组件.md` | stale | `7fdffa31` | 136 | 变更 14、锚点越界 20 |
| 2 | `前端应用/组件架构设计/组件分层设计/图表组件/图表组件.md` | partial | `7fdffa31` | 91 | 变更 7、锚点越界 14 |
| 3 | `前端应用/图表组件库/图表组件库.md` | partial | `7fdffa31` | 66 | 变更 6、锚点越界 7 |
| 4 | `工具生态系统/内置工具集合/交易执行工具.md` | partial | `7fdffa31` | 82 | 变更 13 |
| 5 | `高级主题/高级交易策略/信号生成系统.md` | partial | `7fdffa31` | 87 | 变更 13 |
| 6 | `安装与配置/安装与配置.md` | partial | `7fdffa31` | 82 | 变更 12 |
| 7 | `工具生态系统/内置工具集合/高级分析工具.md` | partial | `7fdffa31` | 82 | 变更 11 |
| 8 | `数据层架构/数据标准化/符号映射.md` | partial | `7fdffa31` | 80 | 变更 11 |
| 9 | `桌面应用/打包与分发/打包与分发.md` | partial | `7fdffa31` | 67 | 变更 10、锚点越界 1 |
| 10 | `项目概述/技术栈说明.md` | partial | `7fdffa31` | 80 | 变更 11 |
| 11 | `安装与配置/安装方式/源码开发环境搭建.md` | partial | `7fdffa31` | 57 | 变更 9、锚点越界 1 |
| 12 | `实时交易/订单管理系统.md` | partial | `7fdffa31` | 82 | 变更 10 |
| 13 | `数据层架构/数据源集成/市场数据加载器/外汇期货加载器/外汇期货加载器.md` | partial | `7fdffa31` | 94 | 变更 10 |
| 14 | `数据层架构/数据源集成/市场数据加载器/市场数据加载器.md` | partial | `7fdffa31` | 49 | 变更 10 |
| 15 | `桌面应用/开发与调试/测试策略与实践/测试数据管理.md` | partial | `7fdffa31` | 62 | 变更 10 |
| 16 | `Agent 核心系统/工具调用系统/结果处理系统/结果过滤转换.md` | partial | `7fdffa31` | 103 | 变更 9 |
| 17 | `回测引擎/回测引擎.md` | partial | `7fdffa31` | 72 | 变更 9 |
| 18 | `回测引擎/数据加载器/专业数据源/外汇与期货数据源.md` | partial | `7fdffa31` | 69 | 变更 9 |
| 19 | `安装与配置/交易连接器配置/交易连接器配置.md` | partial | `7fdffa31` | 64 | 变更 9 |
| 20 | `安装与配置/交易连接器配置/其他券商连接器.md` | partial | `7fdffa31` | 94 | 变更 9 |
| 21 | `安装与配置/交易连接器配置/加密货币交易所配置.md` | partial | `7fdffa31` | 94 | 变更 9 |
| 22 | `安装与配置/故障排除/常见错误.md` | partial | `7fdffa31` | 104 | 缺失 1、变更 8 |
| 23 | `安装与配置/数据源配置/A股市场数据源.md` | partial | `7fdffa31` | 74 | 变更 9 |
| 24 | `安装与配置/数据源配置/国际市场数据源.md` | partial | `7fdffa31` | 102 | 变更 9 |
| 25 | `实时交易/审计追踪记录.md` | partial | `7fdffa31` | 75 | 变更 9 |

## 已消失的引用（页面指向不存在的文件）

- `安装与配置/故障排除/常见错误.md`
  - `agent/src/agent/grounding.py`
- `Agent 核心系统/内存与上下文系统/上下文管理机制/事实锚定机制.md`
  - `agent/src/agent/grounding.py`
- `数据层架构/数据标准化/数据标准化.md`
  - `agent/src/agent/grounding.py`
- `数据层架构/数据质量验证/数据完整性检查/数据质量规则.md`
  - `agent/src/agent/grounding.py`
- `实时交易/风险控制机制/止损止盈机制.md`
  - `agent/skills/execution-model/SKILL.md`
- `高级主题/因子模型开发/因子有效性检验.md`
  - `agent/quantlib/crossvalidation.py`
  - `agent/quantlib/multipletesting.py`
  - `agent/quantlib/factormodel.py`
- `Agent 核心系统/内存与上下文系统/上下文管理机制/上下文构建机制.md`
  - `agent/src/agent/grounding.py`
- `命令行界面使用/交互式会话/实时反馈/实时反馈.md`
  - `wiki/theme.js`
- `数据层架构/数据质量验证/统计验证框架/Bootstrap夏普置信区间.md`
  - `agent/skills/quant-statistics/SKILL.md`
- `工具生态系统/因子分析工具/因子库使用指南.md`
  - `agent/src/factors/zoo/academic/carma_mom.py`

## 锚点越界（引用行号超出文件当前长度）

- `前端应用/聊天界面组件/专用组件.md`
  - `frontend/src/components/chat/RunCompleteCard.tsx#L1-L200 (past the end at the snapshot too: 141 lines then, 141 now)`
  - `frontend/src/components/chat/MetricsCard.tsx#L1-L200 (past the end at the snapshot too: 65 lines then, 65 now)`
  - `frontend/src/components/chat/PineScriptViewer.tsx#L1-L200 (past the end at the snapshot too: 111 lines then, 111 now)`
  - `frontend/src/components/chat/ModelRuntimeBar.tsx#L1-L200 (past the end at the snapshot too: 55 lines then, 55 now)`
  - `frontend/src/components/layout/ConnectionBanner.tsx#L1-L200 (past the end at the snapshot too: 44 lines then, 44 now)`
  - `frontend/src/components/charts/EquityChart.tsx#L1-L200 (past the end at the snapshot too: 141 lines then, 121 now)`
  - `frontend/src/components/charts/AnnualReturnsChart.tsx#L1-L200 (past the end at the snapshot too: 103 lines then, 82 now)`
  - `frontend/src/components/charts/MonthlyReturnsHeatmap.tsx#L1-L200 (past the end at the snapshot too: 141 lines then, 120 now)`
  - `frontend/src/components/charts/DistributionChart.tsx#L1-L200 (past the end at the snapshot too: 110 lines then, 110 now)`
  - `frontend/src/components/chat/ProgressBar.tsx#L1-L200 (past the end at the snapshot too: 74 lines then, 74 now)`
  - `frontend/src/components/chat/ConversationTimeline.tsx#L1-L200 (past the end at the snapshot too: 82 lines then, 82 now)`
  - `frontend/src/components/chat/AgentAvatar.tsx#L1-L200 (past the end at the snapshot too: 10 lines then, 10 now)`
  - `frontend/src/components/chat/ThinkingTimeline.tsx#L1-L200 (past the end at the snapshot too: 85 lines then, 85 now)`
  - `frontend/src/components/chat/SwarmStatusCard.tsx#L1-L200 (past the end at the snapshot too: 189 lines then, 189 now)`
  - `frontend/src/components/common/BrandMark.tsx#L1-L200 (past the end at the snapshot too: 31 lines then, 31 now)`
  - `frontend/src/components/common/ConfirmDialog.tsx#L1-L200 (past the end at the snapshot too: 128 lines then, 132 now)`
  - `frontend/src/components/common/ErrorBoundary.tsx#L1-L200 (past the end at the snapshot too: 27 lines then, 27 now)`
  - `frontend/src/components/common/Skeleton.tsx#L1-L200 (past the end at the snapshot too: 23 lines then, 23 now)`
  - `frontend/src/components/options/GreeksCards.tsx#L1-L200 (past the end at the snapshot too: 71 lines then, 71 now)`
  - `frontend/src/components/settings/ModelPicker.tsx#L1-L200 (past the end at the snapshot too: 136 lines then, 136 now)`
- `前端应用/组件架构设计/组件分层设计/图表组件/图表组件.md`
  - `frontend/src/components/charts/EquityChart.tsx#L1-L141 (121 lines now, 141 at the snapshot)`
  - `frontend/src/components/charts/MonthlyReturnsHeatmap.tsx#L1-L141 (120 lines now, 141 at the snapshot)`
  - `frontend/src/components/charts/CorrelationMatrix.tsx#L1-L123 (120 lines now, 123 at the snapshot)`
  - `frontend/src/components/charts/OptionsPayoffChart.tsx#L1-L176 (159 lines now, 176 at the snapshot)`
  - `frontend/src/components/charts/EquityChart.tsx#L10-L141 (121 lines now, 141 at the snapshot)`
  - `frontend/src/components/charts/MonthlyReturnsHeatmap.tsx#L8-L141 (120 lines now, 141 at the snapshot)`
  - `frontend/src/components/charts/CorrelationMatrix.tsx#L7-L123 (120 lines now, 123 at the snapshot)`
  - `frontend/src/components/charts/OptionsPayoffChart.tsx#L10-L176 (159 lines now, 176 at the snapshot)`
  - `frontend/src/components/charts/EquityChart.tsx#L20-L134 (121 lines now, 141 at the snapshot)`
  - `frontend/src/components/charts/MonthlyReturnsHeatmap.tsx#L22-L134 (120 lines now, 141 at the snapshot)`
  - `frontend/src/components/charts/OptionsPayoffChart.tsx#L21-L169 (159 lines now, 176 at the snapshot)`
  - `frontend/src/components/charts/EquityChart.tsx#L120-L134 (121 lines now, 141 at the snapshot)`
  - `frontend/src/components/charts/MonthlyReturnsHeatmap.tsx#L120-L134 (120 lines now, 141 at the snapshot)`
  - `frontend/src/components/charts/OptionsPayoffChart.tsx#L155-L169 (159 lines now, 176 at the snapshot)`
- `前端应用/图表组件库/图表组件库.md`
  - `frontend/src/components/charts/EquityChart.tsx#L1-L141 (121 lines now, 141 at the snapshot)`
  - `frontend/src/components/charts/AnnualReturnsChart.tsx#L1-L103 (82 lines now, 103 at the snapshot)`
  - `frontend/src/components/charts/MonthlyReturnsHeatmap.tsx#L1-L141 (120 lines now, 141 at the snapshot)`
  - `frontend/src/components/charts/CorrelationMatrix.tsx#L1-L123 (120 lines now, 123 at the snapshot)`
  - `frontend/src/components/charts/EquityChart.tsx#L20-L134 (121 lines now, 141 at the snapshot)`
  - `frontend/src/components/charts/EquityChart.tsx#L120-L134 (121 lines now, 141 at the snapshot)`
  - `frontend/src/components/charts/MonthlyReturnsHeatmap.tsx#L120-L134 (120 lines now, 141 at the snapshot)`
- `桌面应用/打包与分发/打包与分发.md`
  - `desktop/electron/src/secure-credentials.ts#L1-L240 (239 lines now, 240 at the snapshot)`
- `安装与配置/安装方式/源码开发环境搭建.md`
  - `tools/ci_grep_gates.sh#L1-L200 (past the end at the snapshot too: 156 lines then, 175 now)`
- `部署与运维/部署与运维.md`
  - `agent/api_server.py#L446-L519 (past the end at the snapshot too: 400 lines then, 420 now)`
- `前端应用/图表组件库/热力图组件.md`
  - `frontend/src/components/charts/MonthlyReturnsHeatmap.tsx#L1-L141 (120 lines now, 141 at the snapshot)`
  - `frontend/src/components/charts/CorrelationMatrix.tsx#L1-L123 (120 lines now, 123 at the snapshot)`
  - `frontend/src/components/charts/MonthlyReturnsHeatmap.tsx#L22-L134 (120 lines now, 141 at the snapshot)`
  - `frontend/src/components/charts/MonthlyReturnsHeatmap.tsx#L120-L134 (120 lines now, 141 at the snapshot)`
- `前端应用/组件架构设计/组件分层设计/图表组件/权益曲线图.md`
  - `frontend/src/components/charts/EquityChart.tsx#L16-L134 (121 lines now, 141 at the snapshot)`
- `命令行界面使用/交互式会话/高级对话模式/高级对话模式.md`
  - `agent/src/agent/tools.py#L178-L208 (past the end at the snapshot too: 95 lines then, 170 now)`
- `回测引擎/绩效评估与指标/相关性分析.md`
  - `frontend/src/components/charts/CorrelationMatrix.tsx#L1-L122 (120 lines now, 123 at the snapshot)`
  - `frontend/src/components/charts/CorrelationMatrix.tsx#L118-L122 (120 lines now, 123 at the snapshot)`
- `桌面应用/后端集成/后端集成.md`
  - `desktop/electron/src/secure-credentials.ts#L1-L240 (239 lines now, 240 at the snapshot)`
- `前端应用/图表组件库/仪表板图表组件.md`
  - `frontend/src/components/charts/EquityChart.tsx#L16-L134 (121 lines now, 141 at the snapshot)`
- `前端应用/图表组件库/收益曲线图表.md`
  - `frontend/src/components/charts/EquityChart.tsx#L1-L141 (121 lines now, 141 at the snapshot)`
  - `frontend/src/components/charts/EquityChart.tsx#L20-L134 (121 lines now, 141 at the snapshot)`
- `前端应用/图表组件库/期权图表组件.md`
  - `frontend/src/components/charts/OptionsPayoffChart.tsx#L17-L176 (159 lines now, 176 at the snapshot)`
  - `frontend/src/components/charts/OptionsScenarioMatrix.tsx#L16-L142 (122 lines now, 143 at the snapshot)`
- `前端应用/组件架构设计/组件分层设计/图表组件/期权损益图.md`
  - `frontend/src/components/charts/OptionsPayoffChart.tsx#L17-L176 (159 lines now, 176 at the snapshot)`
  - `frontend/src/components/charts/OptionsPayoffChart.tsx#L10-L176 (159 lines now, 176 at the snapshot)`
  - `frontend/src/components/charts/OptionsPayoffChart.tsx#L21-L169 (159 lines now, 176 at the snapshot)`
  - `frontend/src/components/charts/OptionsPayoffChart.tsx#L1-L176 (159 lines now, 176 at the snapshot)`
- `前端应用/组件架构设计/组件分层设计/图表组件/热力图组件.md`
  - `frontend/src/components/charts/MonthlyReturnsHeatmap.tsx#L1-L141 (120 lines now, 141 at the snapshot)`
  - `frontend/src/components/charts/MonthlyReturnsHeatmap.tsx#L22-L134 (120 lines now, 141 at the snapshot)`
  - `frontend/src/components/charts/MonthlyReturnsHeatmap.tsx#L120-L134 (120 lines now, 141 at the snapshot)`
- `前端应用/组件架构设计/组件分层设计/组件分层设计.md`
  - `frontend/src/components/charts/EquityChart.tsx#L16-L141 (121 lines now, 141 at the snapshot)`
  - `frontend/src/components/charts/EquityChart.tsx#L1-L141 (121 lines now, 141 at the snapshot)`
  - `frontend/src/components/charts/EquityChart.tsx#L120-L134 (121 lines now, 141 at the snapshot)`
- `前端应用/组件架构设计/组件分层设计/期权交易组件/策略构建器组件.md`
  - `frontend/src/components/options/GreeksCards.tsx#L1-L200 (past the end at the snapshot too: 71 lines then, 71 now)`
- `桌面应用/开发与调试/性能优化技巧/渲染性能优化.md`
  - `frontend/src/components/charts/EquityChart.tsx#L1-L141 (121 lines now, 141 at the snapshot)`
  - `frontend/src/components/charts/EquityChart.tsx#L120-L133 (121 lines now, 141 at the snapshot)`
- `桌面应用/开发与调试/测试策略与实践/安全测试与验证.md`
  - `desktop/electron/src/secure-credentials.ts#L1-L240 (239 lines now, 240 at the snapshot)`
- `前端应用/组件架构设计/组件分层设计/布局组件层.md`
  - `frontend/src/router.tsx#L1-L200 (past the end at the snapshot too: 73 lines then, 96 now)`
- `桌面应用/开发与调试/性能优化技巧/进程通信优化.md`
  - `desktop/electron/src/secure-credentials.ts#L1-L240 (239 lines now, 240 at the snapshot)`
- `前端应用/设置面板.md`
  - `frontend/src/pages/Settings.tsx#L37-L780 (682 lines now, 780 at the snapshot)`
- `前端应用/组件架构设计/状态管理策略.md`
  - `frontend/src/hooks/useDarkMode.ts#L1-L200 (past the end at the snapshot too: 80 lines then, 80 now)`

## 未覆盖子系统（按自快照基线以来的改动量排序）

| 文件 | 状态 | +行 | -行 |
| --- | --- | --- | --- |
| `tools/test_wiki_drift.py` | A | 3192 | 0 |
| `frontend/src/lib/pineRuntime.ts` | A | 2380 | 0 |
| `agent/tests/test_grounding_release.py` | A | 2357 | 0 |
| `README_id.md` | A | 2299 | 0 |
| `CHANGELOG.md` | M | 2257 | 0 |
| `tools/wiki_drift.py` | A | 2239 | 0 |
| `agent/src/agent/grounding/policies.py` | A | 2114 | 0 |
| `frontend/src/i18n/locales/de.json` | A | 2090 | 0 |
| `frontend/src/i18n/locales/id.json` | A | 2090 | 0 |
| `frontend/src/i18n/locales/pt-BR.json` | A | 2090 | 0 |
| `frontend/src/pages/ProChart.tsx` | A | 2069 | 0 |
| `frontend/src/pages/__tests__/ProChartDrawings.test.tsx` | A | 1845 | 0 |
| `docs/superpowers/plans/2026-10-01-repo-wiki-m2-seeding.md` | A | 1805 | 0 |
| `docs/superpowers/plans/2026-10-01-repo-wiki-m1-wiki-root.md` | A | 1491 | 0 |
| `frontend/src/lib/pineLang.ts` | A | 1316 | 0 |
| `agent/tests/test_channels_config_api.py` | A | 1305 | 0 |
| `frontend/src/pages/__tests__/ProChartTimeShare.test.tsx` | A | 1276 | 0 |
| `wiki/alpha-library/i18n.zh.json` | A | 1250 | 0 |
| `agent/src/agent/grounding/evidence.py` | A | 1243 | 0 |
| `frontend/src/lib/indicatorLang.ts` | A | 1216 | 0 |
| `agent/tests/test_strategy_discovery_facade.py` | A | 1173 | 0 |
| `agent/tests/test_grounding_role_hardening.py` | A | 1162 | 0 |
| `frontend/src/lib/pineTa.ts` | A | 1133 | 0 |
| `frontend/src/pages/Alerts.tsx` | A | 1127 | 0 |
| `agent/src/agent/grounding/figures.py` | A | 1122 | 0 |
| `agent/src/portfolio/service.py` | A | 1061 | 0 |
| `wiki/docs/content.en.js` | A | 1054 | 0 |
| `wiki/docs/content.zh.js` | A | 1053 | 0 |
| `项目档案.md` | M | 1046 | 1 |
| `agent/backtest/warehouse/sync.py` | A | 1019 | 0 |
| `frontend/src/lib/__tests__/pineBuiltins.test.ts` | A | 1006 | 0 |
| `agent/src/agent/grounding/identity.py` | A | 1002 | 0 |
| `agent/tests/test_warehouse_sync.py` | A | 951 | 0 |
| `agent/src/portfolio/extraetf.py` | A | 939 | 0 |
| `frontend/src/lib/__tests__/chartDrawings.test.ts` | A | 906 | 0 |
| `agent/tests/test_extraetf_reader.py` | A | 898 | 0 |
| `agent/src/trading/connectors/kis/sdk.py` | A | 891 | 0 |
| `agent/tests/test_grounding_figures_contract.py` | A | 877 | 0 |
| `agent/tests/test_email_connection_test.py` | A | 871 | 0 |
| `frontend/src/components/settings/__tests__/ChannelSettings.test.tsx` | A | 866 | 0 |
| `agent/src/api/market_routes.py` | A | 864 | 0 |
| `agent/tests/test_strategy_discovery_harness.py` | A | 852 | 0 |
| `frontend/src/lib/__tests__/pineRealWorld.test.ts` | A | 835 | 0 |
| `frontend/src/lib/chartDrawings.ts` | A | 830 | 0 |
| `agent/src/api/attribution_core.py` | A | 818 | 0 |
| `frontend/src/i18n/locales/ar.json` | M | 800 | 13 |
| `frontend/src/i18n/locales/es.json` | M | 800 | 13 |
| `frontend/src/i18n/locales/ja.json` | M | 800 | 13 |
| `frontend/src/i18n/locales/ko.json` | M | 800 | 13 |
| `agent/tests/test_channel_config_meta.py` | A | 807 | 0 |

> 目录与导航由 IDE 的 Wiki 生成器持有（`repowiki-metadata.json` 里的 `WikiEncrypted` 字段），本页只能改正文。新增子系统需要成页时，回 IDE 触发一次增量生成。
