---
page: "modules/repo-root/architecture.md"
sources: []
verified_at: "7fdffa31a0d6ff54d236db3dea6adaf8d1ca6709"
anchors: open
vouch: applied-only
---
根目录通过 `pyproject.toml` 定义 `vibe-trading` / `vibe-trading-mcp` 两个 CLI entrypoint，将 `agent/` 下的后端代码打包为可安装包；`Dockerfile` 采用三阶段构建：先用 Node 22 编译 `frontend/` 产出静态资源，再用 Python 3.11-slim 在 builder stage 中基于 `requirements-lock.txt` 与 `requirements-channels-lock.txt` 锁定依赖并安装 agent，最后将预编译 venv 与前端 dist 复制到最小 runtime 镜像并以 `vibe-trading serve` 暴露 8899 端口。

- 进程编排：`docker-compose.yml` 同时拉起 `vibe-trading`（后端 + 内置前端静态文件）与可选的 `frontend`（Node dev server，`VITE_API_URL=http://vibe-trading:8899`），并通过命名卷持久化 runs/sessions/uploads/swarm 等用户态数据。
- 桌面集成：`desktop_electron/` 作为 Electron 宿主负责启动同一份 FastAPI 后端、注入认证头并管理进程生命周期，使桌面端复用后端 API 契约。
- 文档与发布：`wiki_docs/` 独立部署到 Cloudflare Pages，提供与 Agent 配套的 wiki 站点，由 `ci_scripts/` 中的 GitHub Actions 工作流与仓库级门禁脚本强制禁止绕过配置层读取 `os.environ`、禁用不安全 yaml.load、屏蔽商标词并防止敏感数据泄露到 wiki。
- 跨端共享约束：所有子模块共同遵守 Python ≥3.11 <3.14 运行时、Ruff 行宽 120、Pytest 标记（unit/integration）以及通过 hash-pinned lock 文件进行可重现构建的约定。