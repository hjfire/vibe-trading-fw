---
page: "cards/build-system.md"
sources:
  - ".github/workflows/desktop-windows.yml"
  - ".github/workflows/docker-build.yml"
  - ".github/workflows/test.yml"
  - "Dockerfile"
  - "desktop/electron/package.json"
  - "desktop/electron/scripts/build-backend.ps1"
  - "docker-compose.yml"
  - "pyproject.toml"
  - "requirements-channels-lock.txt"
  - "requirements-lock.txt"
  - "tools/ci_grep_gates.sh"
verified_at: "7fdffa31a0d6ff54d236db3dea6adaf8d1ca6709"
anchors: open
vouch: applied-only
category: "build_system"
kind: "build_system"
name: "多端一体化构建系统：Docker 多阶段镜像、pyproject 包管理与 GitHub Actions CI/CD"
scope:
  - "**"
source_files:
  - "pyproject.toml"
  - "requirements-lock.txt"
  - "requirements-channels-lock.txt"
  - "Dockerfile"
  - "docker-compose.yml"
  - ".github/workflows/test.yml"
  - ".github/workflows/docker-build.yml"
  - ".github/workflows/desktop-windows.yml"
  - "desktop/electron/package.json"
  - "desktop/electron/scripts/build-backend.ps1"
  - "tools/ci_grep_gates.sh"
---

## 1. 使用的系统与工具

仓库采用 **多语言、多产物** 的构建体系，围绕以下核心组件组织：

- **Python 包与依赖管理**：`pyproject.toml`（`vibe-trading-ai`）定义包名、版本 `0.1.13`、入口点 `vibe-trading` / `vibe-trading-mcp`、可选 extras（`ibkr`、`longbridge`、`mt5`、`channels`、`dev` 等），并通过 `requirements-lock.txt` 与 `requirements-channels-lock.txt` 以 `--require-hashes` 锁定全部依赖。CI 在运行前对两个 lock 文件分别执行 `pip install --dry-run --require-hashes` 校验完整性。
- **容器化**：根级 `Dockerfile` 使用三阶段构建——`frontend-build`（Node 22 构建前端）、`builder`（Python 3.11-slim + build-essential 编译 wheel 并创建隔离 venv）、`runtime`（仅携带预编译 venv 与运行时 native 库）。`docker-compose.yml` 编排 `vibe-trading` 服务（端口 8899）与可选的 `frontend` 开发服务（端口 5899），并使用命名卷持久化 runs/sessions/uploads/home/swarm-runs。
- **Electron 桌面应用**：`desktop/electron/package.json` 通过 `electron-builder` 打包 NSIS 安装器，产物命名为 `Vibe-Trading-Desktop-Unofficial-${version}-${arch}.exe`；构建流程由 `scripts/build-backend.ps1` 生成最小 Python 运行时并嵌入。
- **CI/CD**：`.github/workflows/` 下四个工作流：`test.yml`（主分支 PR/Push 触发单元测试+前端构建+Windows 后台回归+Electron 生命周期 smoke）、`docker-build.yml`（手动触发，构建 linux/amd64+linux/arm64 镜像推送到 GHCR 与 Docker Hub）、`desktop-windows.yml`（手动触发，构建 Windows 安装包并记录 SHA256）、`wiki.yml`/`wiki-deploy.yml`（Wiki 静态站点部署到 Cloudflare Pages）。
- **安全门禁**：`tools/ci_grep_gates.sh` 与 `tools/ci_env_var_gate.py` 在 CI 中强制禁止绕过配置层的 `os.environ` 读取、禁用不安全 `yaml.load`、屏蔽商标词并防止敏感数据泄露到 wiki。

## 2. 关键文件

| 文件 | 作用 |
|---|---|
| `pyproject.toml` | Python 包元数据、依赖、extras、pytest/ruff/coverage 配置 |
| `requirements-lock.txt` | 主依赖哈希锁 |
| `requirements-channels-lock.txt` | 通道 SDK（飞书/Telegram 等）哈希锁 |
| `Dockerfile` | 三阶段镜像构建（前端→Python builder→runtime） |
| `docker-compose.yml` | 本地开发编排，含只读 rootfs、cap_drop ALL、tmpfs 等安全加固 |
| `.github/workflows/test.yml` | 主 CI：Python 测试、前端构建、Windows 后台回归、Electron 生命周期 |
| `.github/workflows/docker-build.yml` | 多平台镜像构建与推送（GHCR/Docker Hub） |
| `.github/workflows/desktop-windows.yml` | Windows 安装包构建与签名检查 |
| `desktop/electron/package.json` | Electron 应用脚本、electron-builder 配置、NSIS 目标 |
| `desktop/electron/scripts/build-backend.ps1` | 为桌面版裁剪最小 Python 后端 |
| `tools/ci_grep_gates.sh` | 仓库级安全 grep 门禁 |

## 3. 架构与设计约定

- **依赖可重现**：所有 Python 依赖通过 hash-pinned lock 安装（`--require-hashes`），CI 与 Docker 构建均要求 lock 自洽；Channel SDK 单独维护一个 lock，避免 `pip install -e ".[feishu,telegram]"` 带来的非确定性解析。
- **镜像分层最小化**：`build-essential` 仅在 builder stage 存在，runtime 仅安装 weasyprint PDF 渲染所需的 Pango/HarfBuzz/Fontconfig/Cairo/gdk-pixbuf 共享库与 DejaVu 字体；用户态目录 `/app`、`/home/vibe/.vibe-trading` 由 `vibe` 用户拥有，代码执行子进程进一步降权至 `vibe-sandbox`（UID 10001）。
- **前后端解耦**：前端（React+Vite）独立构建产出 `frontend/dist`，被拷贝进 runtime 镜像并由 FastAPI 作为静态资源提供；Compose 支持将 `./agent/.env` 挂载回容器以便 Web UI 编辑持久化。
- **可选功能按 extras 切分**：Broker 连接器（`ibkr`、`longbridge`、`mt5`）、LLM 提供商（`deepseek`、`anthropic`、`copilot`）、统计模块（`stats`）、各渠道（`dingtalk`、`discord`、`matrix`、`slack`、`telegram`、`wecom`、`whatsapp`、`weixin`、`qq`、`mochat`、`msteams`、`napcat`）均以 optional-dependencies 形式声明，默认安装保持精简。
- **CI 全链路门禁**：`test.yml` 依次执行 lock 校验 → 安装 dev+openbb+stats → 安全门禁脚本 → 语法检查 → pytest（排除 e2e 与 live 用例）→ Node 22 前端构建与 vitest → Windows 后台工具回归 → Electron 源码生命周期 smoke。
- **发布策略**：Docker 镜像标签由 workflow_dispatch 输入控制，同时打 `latest`（除非输入就是 latest）；Windows 安装包仅用于 review，输出 SHA256SUMS 并写入步骤摘要，不自动上传。

## 4. 约定与约束

- **Python 版本约束**：`requires-python = ">=3.11,<3.14"`，CI 使用 3.11，Windows 后台回归使用 3.14，Electron 构建使用 3.12；3.14 被上限阻止是因为 `llvmlite` 尚无 cp314 wheel。
- **Lock 文件必须自洽**：CI 对 `requirements-lock.txt` 和 `requirements-channels-lock.txt` 分别执行 `--dry-run --require-hashes`，任一不完整即失败。
- **Docker 运行时不可写**：Compose 启用 `read_only: true`，仅通过 named volumes 与 tmpfs（`/tmp`、`/home/vibe/.cache`、`/home/vibe/.config`）提供可写空间。
- **能力边界**：容器 `cap_drop: ALL` 仅保留 `SETUID`/`SETGID`（供 `runner.py` 降权到 `vibe-sandbox`），并设置 `no-new-privileges:true`；内存限制 4g、CPU 2、PIDs 512。
- **环境变量注入方式**：Compose 通过 `env_file: agent/.env` 与 `environment` 字段注入，Ollama URL 默认走 `host.docker.internal:11434`，可通过 `OLLAMA_BASE_URL` 覆盖。
- **前端构建固定 Node 版本**：Dockerfile 与 CI 均使用 `node:22`（带 digest），前端构建命令为 `npm ci && npm run build`。
- **Electron 产物命名**：`artifactName: Vibe-Trading-Desktop-Unofficial-${version}-${arch}.${ext}`，NSIS 安装器通过 `installer:win:review` 构建并在 CI 中记录 SHA256。
- **安全门禁不可绕过**：`tools/ci_grep_gates.sh` 与 `tools/test_ci_env_var_gate.py` 在每次 CI 中强制执行，任何试图直接读取 `os.environ` 绕过配置层的行为都会导致构建失败。