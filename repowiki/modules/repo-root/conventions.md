---
page: "modules/repo-root/conventions.md"
sources: []
verified_at: "7fdffa31a0d6ff54d236db3dea6adaf8d1ca6709"
anchors: open
vouch: applied-only
---
- 依赖通过 `requirements-lock.txt` / `requirements-channels-lock.txt` 以 hash 锁定，构建时一律使用 `--require-hashes` 安装以保证可重现性。
- 可选能力（broker connector、LLM provider、消息渠道）以 `pyproject.toml` 的 `[project.optional-dependencies]` extras 形式声明，并在代码中以 lazy import + 可操作 ImportError 提示降级。
- 测试统一位于 `agent/tests`，使用 pytest markers 区分 unit（无网络）与 integration（可能需网络）。
- 代码风格遵循 Ruff target-version=py311、line-length=120，并在 `pyproject.toml` 中集中配置 lint/coverage 规则。