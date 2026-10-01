---
page: "modules/agent-backend/architecture.md"
sources: []
verified_at: "7fdffa31a0d6ff54d236db3dea6adaf8d1ca6709"
anchors: open
vouch: applied-only
---
模块以三个可独立启动的进程为入口：`api_server.py` 通过 `FastAPI` 组装路由（runs/sessions/system/settings/uploads/channels/swarm/live/alpha/options/auth/scheduled），并在 lifespan 中执行预检查、状态迁移、定时研究执行器和可选 channel runtime；`mcp_server.py` 基于 `fastmcp.FastMCP` 暴露 ~70 个只读金融工具，支持 stdio/SSE/streamable-http 三种传输，并通过自定义 `_HostGuardMiddleware`/`_OriginGuardMiddleware` 防御 DNS 重绑定攻击，shell 工具默认关闭需显式启用；`cli/` 实现 slash 命令路由（chat/goal/memory/session/show/update/research_playbook/institutional）。核心业务代码集中在 `src/` 下按领域划分：`agent`（会话循环、技能、工具基类）、`tools`（自动发现 `BaseTool` 子类的注册表，支持本地+MCP 远程工具合并）、`backtest`（`engines` 多市场回测引擎、`loaders` 统一数据源抽象 + 各交易所/行情源实现、`optimizers` 组合权重优化器）、`channels`（多 IM/聊天平台通道）、`live`（实盘交易生命周期与订单守卫）、`factors`/`quantlib`（因子库与量化分析）、`swarm`（多智能体编排）、`goal`/`memory`/`session`（研究目标与持久化记忆）、`trading/connectors`（券商连接器）、`config`/`security`/`providers`（配置与安全）。依赖方向自上而下：入口 → API/MCP 路由 → `src.*` 领域层 → 外部数据源/LLM/券商 SDK；所有扩展点（工具、数据加载器、回测引擎、频道、技能）均通过子类发现或注册表机制动态装配。