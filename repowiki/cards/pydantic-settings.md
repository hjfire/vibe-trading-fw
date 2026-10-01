---
page: "cards/pydantic-settings.md"
sources:
  - "agent/.env.example"
  - "agent/src/config/accessor.py"
  - "agent/src/config/env_schema.py"
  - "agent/src/config/loader.py"
  - "agent/src/config/paths.py"
  - "agent/src/config/schema.py"
  - "pyproject.toml"
verified_at: "7fdffa31a0d6ff54d236db3dea6adaf8d1ca6709"
anchors: open
vouch: applied-only
category: "configuration_system"
kind: "configuration_system"
name: "基于 Pydantic 的集中式环境变量与结构化 Agent 配置系统"
scope:
  - "**"
source_files:
  - "agent/src/config/env_schema.py"
  - "agent/src/config/accessor.py"
  - "agent/src/config/schema.py"
  - "agent/src/config/loader.py"
  - "agent/src/config/paths.py"
  - "agent/.env.example"
  - "pyproject.toml"
---

## 1. 系统概览

Vibe-Trading 在 `agent/src/config/` 下实现了一套**双轨配置体系**：

- **运行时环境变量层**（`env_schema.py` + `accessor.py`）：用 Pydantic 模型统一声明所有 `os.environ` 读取点，替代了原先散落在 66 个文件中的 ~207 处 `os.getenv` 调用。
- **磁盘结构化配置层**（`schema.py` + `loader.py` + `paths.py`）：以 JSON/YAML 文件形式持久化 MCP Server、Channel、Agent 等可版本化的算子级配置。

两者通过 `EnvConfig` 顶层模型组合，并由 `accessor.get_env_config()` 提供线程安全的单例访问。

## 2. 关键文件与职责

| 文件 | 职责 |
|---|---|
| `env_schema.py` | 定义 `LLMConfig` / `DataConfig` / `APIConfig` / `SwarmConfig` / `AgentTuningConfig` / `PathConfig` / `OcrConfig` / `MemoryConfig` 及顶层 `EnvConfig`；每个字段带 `Field(alias=...)` 指向 UPPER_SNAKE_CASE 环境变量名，并声明默认值与类型约束 |
| `accessor.py` | 模块级 `get_env_config()` 单例（`threading.Lock` 保护），`reset_env_config()` 用于 Settings API 热更新后重建缓存；提供 `_parse_bool`、`get_env_or`（新旧别名回退）、`get_env_value` 等辅助 |
| `schema.py` | 定义 `AgentConfig` / `MCPServerConfig` / `ChannelsConfig` / `MCPOAuthConfig` 等 Pydantic 模型；内置 live-broker 安全校验（禁止 `enabled_tools=["*"]` 对 Robinhood/IBKR 等真实下单通道） |
| `loader.py` | 从磁盘加载 JSON/YAML 配置（`_read_config_file`），支持 `agent.json` / `agent.yaml` / `agent.yml` 三种文件名；实现 `merge_agent_config_overrides`（运行时覆盖层）和 swarm 专用解析 `load_swarm_agent_config` |
| `paths.py` | 解析 `~/.vibe-trading` 运行时根目录（可通过 `VIBE_TRADING_HOME` 覆盖），提供 `get_config_path` / `get_data_dir` / `get_sessions_dir` / `get_workspace_path` 等路径常量 |
| `.env.example` | 全量环境变量清单，按功能分区注释，作为用户配置模板 |
| `pyproject.toml` | 声明 `python-dotenv`、`pyyaml`、`pydantic` 等依赖，以及 `package-data` 中嵌入的技能 YAML/JSON 等资源 |

## 3. 架构与设计约定

### 3.1 环境变量 → Pydantic 模型映射

`_EnvBase` 基类通过 `model_validator(mode="before")` 自动从 `os.environ` 读取未显式传入的字段，使用 `Field(alias=...)` 指定的 UPPER_SNAKE_CASE 名称。数值型字段遇到无法解析的字符串时**静默丢弃**，由 Pydantic 回退到默认值而非抛出异常——这是有意为之的健壮性设计。

布尔值通过自定义 `EnvBool = Annotated[bool, BeforeValidator(_parse_env_bool)]` 统一解析：`"1"` / `"true"` / `"yes"` / `"on"`（不区分大小写）为真，其余为假。

`MemoryConfig` 额外提供 `VT_MEMORY=off|on|full` 业务预设，再被各 `VT_MEMORY_*` 标志位覆盖，形成“预设 + 细粒度开关”的两层开关模式。

### 3.2 磁盘配置发现顺序

主 Agent 配置查找顺序（`get_config_candidates`）：
1. 显式传入的 `config_path`
2. `<runtime_root>/agent.json`
3. `<runtime_root>/agent.yaml`
4. `<runtime_root>/agent.yml`
5. 不存在则返回第一个候选（`agent.json`）以便后续创建

Swarm 专用配置另有独立解析顺序（`_resolve_swarm_agent_config_path`）：
1. `VIBE_TRADING_SWARM_AGENT_CONFIG` 环境变量（CI/沙箱绝对覆盖）
2. `<runtime_root>/swarm-agent.json`
3. 回退到主 agent 配置文件
4. 无匹配时返回 `None`，使 swarm 仅运行本地工具

### 3.3 配置分层与合并策略

`load_runtime_agent_config` 将磁盘基础配置与运行时 `overrides` 合并：
- 非 `mcp_servers` 字段采用递归字典合并（`_merge_dicts`）
- `mcp_servers` 按 server key 进行**部分替换**，若 transport 家族变化（如 stdio ↔ sse）则先重置为默认负载再合并
- 合并结果经 `AgentConfig.model_validate` 二次校验，失败则回退到基础配置

### 3.4 安全门禁

- `sanitize_session_overrides`：默认剥离 session 级覆盖中的 `mcpServers` / `mcp_servers` 键（因涉及子进程 `command`/`args`/`env` 执行能力），需设置 `ALLOW_SESSION_MCP_SERVERS=1` 才允许注入
- `AgentConfig.validate_live_broker_servers`：对 live broker（Robinhood、IBKR）禁止 `enabled_tools=["*"]`，必须显式列出只读工具白名单；IBKR 仅在 OAuth scope 严格限制为 `mcp.read` 且不含 write scope 时才允许临时通配符探测
- `MCPServerConfig.validate_transport_config`：强制 HTTP 传输必须 HTTPS（OAuth refresh token 不得明文传输），stdio 禁止携带 `url`/`headers`/`auth`

### 3.5 路径约定

- 运行时根目录：`~/.vibe-trading`，可通过 `VIBE_TRADING_HOME` 覆盖（禁止 UNC 路径）
- 子目录：`sessions/`、`runs/`、`swarm/runs/`、`uploads/`、`workspace/`、`cache/loaders/`（可选数据缓存）
- 配置目录即 data dir，首次访问时自动 `mkdir(parents=True)`

## 4. 约定与约束

- **所有环境变量必须在 `env_schema.py` 中声明**，新增 env var 需添加对应字段、alias、默认值和类型约束，禁止在业务代码中直接 `os.getenv` 绕过
- 配置格式仅限 JSON 与 YAML（PyYAML 可选依赖），不支持 TOML/INI
- snake_case 与 camelCase 字段名在配置文件中均可接受（`alias_generator=_to_camel` + `populate_by_name=True`）
- 运行时覆盖层（session overrides）使用 `AgentConfigOverride` 模型，其 `extra="ignore"` 是刻意为之，以兼容历史会话结构
- 二进制/敏感配置（如 OAuth 令牌）通过独立的 OAuth 缓存目录管理（`~/.vibe-trading/live/*/oauth`），不在 agent.json 中明文存放
- CI 安全门禁脚本（`tools/ci_env_var_gate.py`）禁止绕过配置层的裸 `os.environ` 读取，确保所有配置走上述集中式入口