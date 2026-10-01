---
page: "cards/logging.md"
sources:
  - "agent/api_server.py"
  - "agent/backtest/engines/base.py"
  - "agent/backtest/loaders/_http.py"
  - "agent/backtest/loaders/akshare_loader.py"
  - "agent/scripts/w4a_run_benches.py"
  - "agent/src/api/security.py"
  - "agent/src/channels/base.py"
  - "agent/src/channels/feishu.py"
  - "agent/src/channels/qq.py"
verified_at: "7fdffa31a0d6ff54d236db3dea6adaf8d1ca6709"
anchors: open
vouch: applied-only
category: "logging_system"
kind: "logging_system"
name: "基于 Python stdlib logging + Uvicorn 访问日志脱敏的日志体系"
scope:
  - "**"
source_files:
  - "agent/api_server.py"
  - "agent/src/api/security.py"
  - "agent/scripts/w4a_run_benches.py"
  - "agent/src/channels/base.py"
  - "agent/src/channels/qq.py"
  - "agent/src/channels/feishu.py"
  - "agent/backtest/loaders/_http.py"
  - "agent/backtest/loaders/akshare_loader.py"
  - "agent/backtest/engines/base.py"
---

## 1. 使用的框架与工具

仓库采用 **Python 标准库 `logging`** 作为统一的日志框架，没有引入第三方日志库（如 loguru、structlog）。HTTP 服务由 **Uvicorn** 启动，其内置的 access/error 日志通过附加自定义 `logging.Filter` 进行敏感信息脱敏。部分第三方 SDK（如飞书 Lark、QQ botpy）自带独立日志系统，代码中显式关闭或降级其输出以避免重复/冲突。

## 2. 关键文件

- `agent/api_server.py`：FastAPI 应用入口，调用 `uvicorn.run(..., log_level="info")`，并在启动时安装访问日志脱敏过滤器。
- `agent/src/api/security.py`：定义 `_AccessLogRedactionFilter` 和 `install_access_log_redaction_filter()`，将脱敏逻辑挂载到 `uvicorn.access`、`uvicorn.error`、`uvicorn` 三个 logger。
- `agent/scripts/w4a_run_benches.py`：脚本类入口，使用 `logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s | %(message)s")` 初始化根日志器。
- `agent/src/channels/base.py`：所有 Channel 子类共享基类，在 `__init__` 中创建命名 logger：`self.logger = logging.getLogger(f"{__name__}.{self.name}")`。
- 各模块文件（`backtest/loaders/*.py`、`backtest/engines/*.py`、`channels/dingtalk.py`、`channels/qq.py` 等）统一以 `logger = logging.getLogger(__name__)` 获取模块级 logger。

## 3. 架构与约定

### 3.1 Logger 获取方式
- **模块级**：每个 `.py` 文件顶部 `import logging` 后执行 `logger = logging.getLogger(__name__)`，形成以包路径为名的层级 logger（例如 `agent.backtest.loaders.akshare_loader`）。
- **实例级**：Channel 子系统通过基类构造时按 `f"{__name__}.{self.name}"` 生成带通道标识的 logger，便于区分不同渠道（dingtalk、feishu、qq 等）的日志来源。
- **进程/脚本级**：CLI 脚本通过 `logging.basicConfig` 配置根 handler；HTTP 服务依赖 Uvicorn 默认 handler，并通过 `install_access_log_redaction_filter` 注入过滤器。

### 3.2 日志级别策略
- HTTP 服务默认 `log_level="info"`（Uvicorn 启动参数），生产环境仅输出 info 及以上级别。
- 测试 fixture 中的 Uvicorn 子进程使用 `log_level="warning"` 抑制噪音。
- 脚本类入口统一设为 `INFO`，保证回测/基准脚本能输出数据加载进度。
- 业务代码中广泛使用 `logger.info` / `logger.warning` / `logger.error` / `logger.exception`，未发现强制的 level 白名单，但错误路径普遍使用 `exception` 并附带异常堆栈。

### 3.3 结构化字段与格式
- 未使用 JSON 结构化日志；消息体以字符串模板形式传递，常见风格包括：
  - 位置占位符：`logger.info("bench %s done: ...", key, ...)`
  - 关键字段拼接：`logger.warning("media download exceeded redirect limit ref={}", media_ref)`
- 日志记录对象本身不携带额外结构化字段（如 `extra={}`），而是把上下文信息嵌入消息文本。
- 唯一接近“结构化”的设计是 `install_access_log_redaction_filter`，它针对 URL 查询串中的 `api_key=`、`ticket=` 等键名做值级替换，属于安全层面的结构化清洗。

### 3.4 输出路由
- **HTTP 请求日志**：由 Uvicorn 输出，经 `security.install_access_log_redaction_filter` 附加的 `_AccessLogRedactionFilter` 过滤后再写入 stderr（Uvicorn 默认 sink）。
- **业务日志**：遵循 Python logging 传播机制，最终由 Uvicorn 的 root handler 或脚本的 `basicConfig` 配置的 handler 输出到 stdout/stderr。
- **第三方 SDK 日志**：飞书 SDK 通过 `.log_level(lark.LogLevel.INFO)` 显式设置；QQ botpy 通过 `ext_handlers=False` 禁用其文件日志，避免在只读文件系统上写 `botpy.log`。

## 4. 约定与约束

- **禁止直接 `print` 替代日志**：除启动 banner 等一次性提示外，业务路径全部走 `logger.*`，确保可被 handler/filter 拦截。
- **敏感信息必须脱敏**：URL 查询参数中的 API Key、SSE ticket 等通过 `_redact_query_secrets` 在日志层自动替换，该过滤器对同一 logger 幂等安装（已存在则跳过），防止重复叠加。
- **每个 Channel 必须有独立 logger**：基类强制 `self.logger = logging.getLogger(f"{__name__}.{self.name}")`，下游 channel 实现不得再自行创建全局 logger。
- **异常必须用 `logger.exception`**：网络/IO 错误路径普遍使用 `logger.exception("...", exc_info=True)` 保留完整堆栈，便于定位外部依赖失败。
- **无集中配置文件**：日志级别、格式、handler 均由运行时入口（`api_server.serve_main`、`w4a_run_benches.py`）硬编码决定，未暴露环境变量开关。
- **未启用结构化 JSON 日志**：当前所有日志均为人类可读文本，若需对接 ELK/Loki 等后端，需在 `basicConfig` 或 Uvicorn handler 处统一改为 JSON formatter。

## 5. 适用性说明

本仓库确实存在一套完整的日志体系，但规模较小且高度依赖 Python stdlib logging 与 Uvicorn 默认行为，没有独立的 `log/` 目录、没有集中式 logger 工厂、没有 JSON 结构化输出。因此该类别适用，但成熟度为中等。