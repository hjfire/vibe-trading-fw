---
page: "modules/agent-backend/conventions.md"
sources: []
verified_at: "7fdffa31a0d6ff54d236db3dea6adaf8d1ca6709"
anchors: open
vouch: applied-only
---
- 新增能力通过继承基类并放入对应包目录即可被自动发现：工具继承 `BaseTool`、数据加载器继承 `base.Loader`、回测引擎继承 `base.BacktestEngine`，由 `pkgutil.iter_modules` + `__subclasses__()` 在运行时扫描注册。
- 对外暴露的接口统一使用 Pydantic 模型定义请求/响应结构（如 `src/api/models.py` 中的 `RunResponse`、`Artifact` 等），并在路由中直接作为类型提示使用。
- 敏感操作（shell 工具、写权限、live broker 下单）默认关闭，必须通过环境变量（如 `VIBE_TRADING_ENABLE_SHELL_TOOLS`）或显式 CLI 参数开启，遵循 fail-closed 安全策略。
- 网络入口（API 与 MCP HTTP/SSE）均挂载 Host/Origin 白名单中间件，仅允许 loopback 主机头与可信 Origin，防止浏览器 DNS 重绑定绕过认证。
- 长连接与后台任务通过 `lifespan`/`asynccontextmanager` 成对启动与反向顺序关闭（如 scheduled research executor、channel runtime），确保优雅退出。
- MCP 工具函数统一返回 JSON 字符串包裹的 `{status, ...}` 信封，错误走 `_json_error`，成功走 `_json_ok`，便于客户端解析。