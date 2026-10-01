---
page: "modules/ci-gates/architecture.md"
sources: []
verified_at: "7fdffa31a0d6ff54d236db3dea6adaf8d1ca6709"
anchors: open
vouch: applied-only
---
模块由两部分组成：
- `tools/` 下的门禁工具：`ci_grep_gates.sh` 是统一入口，顺序执行五个 gate（a: 禁止 unsafe `yaml.load`；b: 禁止商标字面量（名单由 `tools/ci_grep_gates.sh` 自持）；c: 禁止 wiki/alpha-library 中的股票代码数据；d: 禁止过时的 `datetime.utcnow()` / 裸 `datetime.now()`；e: AST 扫描禁止直接 `os.getenv` / `os.environ.get` / `os.environ["KEY"]` 读取），其中 gate e 通过调用 `ci_env_var_gate.py` 复用同一份规则；`ci_env_var_gate.py` 基于 Python `ast` 构建 `_EnvReadVisitor`，按 `SCAN_TARGETS` 递归扫描 `agent/src/`、`agent/backtest/`、`agent/cli/` 等目录，跳过 `agent/tests/` 与允许区 `agent/src/config/`，支持 `# noqa: env-gate` 单行豁免；`test_ci_env_var_gate.py` 用 pytest 对 visitor 的违规/警告/放行行为进行断言。
- `.github/workflows/` 下的 GitHub Actions 定义：`test.yml` 在 push/PR 上运行 Python 3.11/3.14 多矩阵测试，先执行 `bash tools/ci_grep_gates.sh` 再跑 `pytest tools/test_ci_env_var_gate.py`，随后编译关键 Python 文件、运行全量测试及前端构建；`docker-build.yml` 通过 workflow_dispatch 触发，使用 Buildx+QEMU 构建 linux/amd64/arm64 镜像推送到 GHCR 与 Docker Hub；另有 `desktop-windows.yml`、`sync-upstream.yml`、`wiki.yml`、`wiki-deploy.yml` 分别负责桌面端、上游同步与 Wiki 部署。
依赖方向：workflows → `tools/ci_grep_gates.sh` → `tools/ci_env_var_gate.py`；tests 仅依赖 gate 模块内部函数，不触碰真实文件系统。