---
page: "modules/ci-gates/conventions.md"
sources: []
verified_at: "7fdffa31a0d6ff54d236db3dea6adaf8d1ca6709"
anchors: open
vouch: applied-only
---
- 门禁规则以集中式 shell 脚本 (`ci_grep_gates.sh`) 串联多个独立 gate，每个 gate 输出 `[gate x] ... ok/fail` 并累积 FAILED 标志，任一失败即非零退出。
- AST 门禁通过自定义 `NodeVisitor` 子类在 `visit_Call` / `visit_Subscript` 中按模式匹配 `os.getenv`、`os.environ.get`、`os.environ[...]` 读操作，并将结果区分为 blocking violations 与 non-blocking warnings。
- 扫描范围通过顶层常量 `SCAN_TARGETS`、`SKIP_PREFIXES`、`ALLOWED_PREFIX` 声明式配置，新增目录只需修改列表而无需改动遍历逻辑。
- 允许单行豁免：在触发行末尾添加 `# noqa: env-gate` 注释可抑制该行的违规告警，由 `_line_has_noqa` 检查。
- GitHub Actions 工作流将 action 版本锁定到固定 commit SHA（如 `actions/checkout@3d3d...`）而非标签，避免上游漂移引入不可控变更。
- workflow_dispatch 输入一律通过 `env:` 注入并在 `run:` 中引用，禁止直接将 `${{ inputs.* }}` 插值到命令字符串中以规避 shell 注入风险。