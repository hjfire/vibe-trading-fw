---
page: "cards/error-handling.md"
sources:
  - "agent/api_server.py"
  - "agent/backtest/loaders/base.py"
  - "agent/backtest/loaders/rsshub_events.py"
  - "agent/backtest/loaders/tickerall_loader.py"
  - "agent/backtest/loaders/tushare_fundamentals.py"
  - "agent/cli/main.py"
  - "agent/src/api/helpers.py"
  - "agent/src/api/security.py"
  - "agent/src/entities/cashflow.py"
  - "agent/src/entities/ingest.py"
  - "agent/src/factors/registry.py"
  - "agent/src/governance/ledger.py"
  - "agent/src/live/mandate/commit.py"
  - "agent/src/live/runtime/jobstore.py"
  - "agent/src/providers/chat.py"
  - "agent/src/providers/openai_codex.py"
  - "desktop/electron/src/main.ts"
verified_at: "7fdffa31a0d6ff54d236db3dea6adaf8d1ca6709"
anchors: open
vouch: applied-only
category: "error_handling"
kind: "error_handling"
name: "Vibe-Trading 错误处理体系：FastAPI HTTPException + 领域异常类 + CLI 吞错 + Electron 进程级兜底"
scope:
  - "**"
source_files:
  - "agent/api_server.py"
  - "agent/src/api/security.py"
  - "agent/src/api/helpers.py"
  - "agent/backtest/loaders/base.py"
  - "agent/backtest/loaders/rsshub_events.py"
  - "agent/backtest/loaders/tickerall_loader.py"
  - "agent/backtest/loaders/tushare_fundamentals.py"
  - "agent/src/entities/cashflow.py"
  - "agent/src/entities/ingest.py"
  - "agent/src/factors/registry.py"
  - "agent/src/governance/ledger.py"
  - "agent/src/live/mandate/commit.py"
  - "agent/src/live/runtime/jobstore.py"
  - "agent/src/providers/chat.py"
  - "agent/src/providers/openai_codex.py"
  - "agent/cli/main.py"
  - "desktop/electron/src/main.ts"
---

## 1. 总体方案

仓库采用 **分层错误模型**，不同边界使用不同的错误传播与呈现方式：

- **HTTP API 层（FastAPI）**：统一通过 `fastapi.HTTPException` 抛出，由 FastAPI/Starlette 自动序列化为 JSON 响应；所有安全校验、参数校验、跨站请求拒绝等都在 `src/api/security.py` 中集中完成。
- **业务/数据加载层**：在各子模块内定义具名异常类（如 `NoAvailableSourceError`、`DataProviderError`、`CommitError`、`CorruptJobStoreError`、`LedgerCorruptionError`、`ProviderStreamError`、`CodexAuthenticationError` 等），用于在工具链内部区分可恢复与不可恢复错误。
- **CLI 交互层**：大量使用 `try/except Exception` 包裹关键路径，将异常以 Rich 控制台红色文本打印后继续运行 REPL，避免单个命令失败导致整个会话崩溃。
- **Electron 桌面层**：主进程捕获 `uncaughtException` 并通过 `dialog.showErrorBox` 弹窗；启动失败时通过 IPC `desktop:error` 通知渲染进程显示本地化错误消息。
- **日志安全**：Uvicorn access/error logger 挂载 `_AccessLogRedactionFilter`，对 `api_key=` / `ticket=` 查询串值做脱敏替换，防止敏感信息泄露到日志。

## 2. 关键文件与位置

| 层次 | 关键文件 | 职责 |
|---|---|---|
| FastAPI 入口 | `agent/api_server.py` | 注册中间件（CORS、安全头、SPA 回退）、安装日志脱敏过滤器、挂载路由 |
| 安全与认证 | `agent/src/api/security.py` | 所有 `HTTPException` 抛出处、SSE ticket、CORS/DNS 重绑定防护、访问日志脱敏 |
| 路径/配置写入 | `agent/src/api/helpers.py` | 参数校验失败返回 `HTTPException(400)`，`.env` 原子写入失败静默降级 |
| 领域异常 - 数据加载 | `agent/backtest/loaders/base.py`、`rsshub_events.py`、`tickerall_loader.py`、`tushare_fundamentals.py` | 定义 `NoAvailableSourceError`、`EventProviderError`、`UnknownFeedError`、`IncompleteHistoryError`、`DataProviderError` 等 |
| 领域异常 - 实体/资金流 | `agent/src/entities/cashflow.py`、`ingest.py` | `CurrencyMismatchError`、`MissingExchangeRateError`、`CashFlowIngestError`、`PanelIngestError` |
| 领域异常 - 因子/治理/交易 | `agent/src/factors/registry.py`、`governance/ledger.py`、`live/mandate/commit.py`、`live/runtime/jobstore.py` | `RegistryError`、`LedgerCorruptionError`、`CommitError`、`CorruptJobStoreError` |
| 领域异常 - LLM Provider | `agent/src/providers/chat.py`、`openai_codex.py` | `ProviderStreamError`、`CodexStreamError`、`CodexAuthenticationError` |
| CLI 入口 | `agent/cli/main.py` | REPL 循环、slash 命令分发、`SystemExit` 与 `Exception` 的差异化处理 |
| Electron 主进程 | `desktop/electron/src/main.ts` | `app.whenReady().catch`、`bootInternal` try/catch、`process.on('uncaughtException')`、IPC 错误通道 |

## 3. 架构约定与设计决策

### 3.1 HTTP 层：仅用 `HTTPException`
所有 API 错误都通过 `raise HTTPException(status_code=..., detail=...)` 表达，没有自定义 HTTP 异常基类。状态码集中在 `security.py` 中：
- `401`：无效或缺失 API key（`_validate_api_auth`、`require_event_stream_auth`）
- `403`：跨站请求被拒、非本地客户端未配置 key、不受信任的 loopback host
- `400`：路径参数不合法、环境变量值包含换行符（`_format_env_value`、`_validate_path_param`）

### 3.2 业务层：按域划分异常族
每个子系统定义自己的异常继承树，例如：
```
Exception
├── DataProviderError (tushare_fundamentals)
│   ├── UnknownTableError
│   └── SchemaValidationError
├── EventProviderError (rsshub_events)
│   └── UnknownFeedError
├── CodexStreamError (providers/openai_codex)
│   └── CodexAuthenticationError
├── ValueError
│   ├── CurrencyMismatchError
│   ├── MissingExchangeRateError
│   ├── StaleGoalError
│   └── CommitError
└── RuntimeError
    ├── LongbridgeDependencyError
    ├── IncompleteHistoryError
    ├── LedgerCorruptionError
    ├── CorruptJobStoreError
    └── ProviderStreamError
```
这些异常在工具调用链中被上层捕获并转换为富文本结果或重试策略，而不是直接冒泡到 HTTP 层。

### 3.3 CLI：健壮优先，吞掉非致命错误
`cli/main.py` 中几乎所有外部 I/O 都被 `try/except Exception` 包裹，注释明确标注 `# noqa: BLE001 — never block startup on stats` 或 `— persistence is best-effort`。典型模式：
- slash 命令分发：`SystemExit` 解析为退出码，其他 `Exception` 打印后继续循环
- 预检探针：统计工具/技能数量失败时回退到硬编码数字
- 会话持久化：JSONL 写入失败不影响本轮 agent 执行
- kill switch：trip_halt/clear_halt 失败只打印红色提示，不中断 REPL

### 3.4 Electron：进程级兜底
- `app.whenReady().then(...).catch(error => dialog.showErrorBox(...))` 捕获启动期异常
- `bootInternal` 的 try/catch 捕获后端启动失败，通过 `reportBootError` 发送 `desktop:error` IPC
- `process.on('uncaughtException', ...)` 作为最后防线弹出系统对话框
- 所有 IPC handler 使用 `assertMainWindowSender` 校验来源，非法来源直接 `throw new Error(...)`

### 3.5 日志脱敏
`install_access_log_redaction_filter()` 在 Uvicorn 启动前安装，对 `uvicorn.access`、`uvicorn.error` 及根 logger 添加 `_AccessLogRedactionFilter`，将 `api_key=` 和 `ticket=` 的值替换为 `***REDACTED***`，防止长生命周期凭证泄露到访问日志。

## 4. 约定与约束

| 规则 | 证据来源 |
|---|---|
| API 层禁止抛出自定义异常，必须使用 `HTTPException` | `security.py` 中所有鉴权/校验分支均 raise `HTTPException`，无自定义 HTTP 异常 |
| CORS_ORIGINS 不允许 `*`（启用凭据时） | `_parse_cors_origins` 显式 `raise RuntimeError` |
| `.env` 写入必须原子且权限 0600 | `_atomic_write_secret` 使用 `mkstemp` + `os.replace`，失败时回退原地写但仍强制 `chmod(0o600)` |
| CLI 中任何外部依赖导入失败不得阻塞启动 | `_probe_tool_count`、`_probe_skill_count`、`_start_preflight_async` 全部 `except Exception` 并给出回退值 |
| REPL 中 slash 命令失败不得退出循环 | `_dispatch_slash` 捕获 `SystemExit` 与 `Exception`，仅打印后返回 0 |
| Electron 主进程未捕获异常必须弹窗 | `process.on('uncaughtException', ...)` 调用 `dialog.showErrorBox` |
| SSE ticket 一次性使用，消费后立即删除 | `_consume_sse_ticket` 使用 `tickets.pop(ticket, None)`，已过期或被消费的 ticket 不可复用 |
| 路径参数必须匹配白名单正则，否则 400 | `_SAFE_PATH_PARAM_RE = r'^[A-Za-z0-9_-]{1,128}$'`，不匹配即 `HTTPException(400)` |
| 环境变量值禁止含换行符 | `_format_env_value` 检测到 `\n`/`\r` 即返回 400 |

## 5. 前端（React/Vite）

前端代码未在 grep 结果中暴露出统一的错误处理框架（如全局 error boundary、Axios interceptor）。当前可见的错误处理模式是分散在各组件中的局部 try/catch 与 toast 提示（基于 `toast.success` / `toast.error` 等调用），以及通过 `lib/api.ts` 封装的 fetch 调用。由于该仓库的前端部分未被本次搜索覆盖到具体实现细节，此处不做过度推断。

## 6. 总结

该仓库的错误处理遵循 **“边界清晰、就近呈现”** 的原则：HTTP 层用 `HTTPException` 走 FastAPI 标准流程；业务层用领域异常族表达语义；CLI 层追求“永远不死”——把异常降级为用户可读的提示；Electron 主进程用系统对话框兜底。日志层面通过 Uvicorn filter 主动脱敏敏感字段，避免凭证泄露。整体设计强调可用性（CLI 不崩溃）与安全（API 严格鉴权、日志脱敏、SSE ticket 一次性）并重。