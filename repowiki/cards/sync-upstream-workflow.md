---
page: "cards/sync-upstream-workflow.md"
sources:
  - ".github/workflows/sync-upstream.yml"
verified_at: "7fdffa31a0d6ff54d236db3dea6adaf8d1ca6709"
anchors: open
vouch: applied-only
category: "external_dependency"
category_hints:
  - "framework_behavior"
  - "auth_protocol"
kind: "external_dependency"
name: "GitHub Actions 每日同步工作流（sync-upstream）"
scope:
  - "**"
slug: "github-actions"
source_files:
  - ".github/workflows/sync-upstream.yml"
---

### 角色与集成点
- 任务在 `ubuntu-latest` Runner 上执行：检出 main、添加 `upstream` 远指向官方仓库 `HKUDS/Vibe-Trading`、fetch 并 merge，然后 push 回 origin/main。

### 关键行为与约束
- 工作流**不声明 `permissions:`**——因为当官方提交包含 `.github/workflows/` 变更时，默认的 `GITHUB_TOKEN` 会被 GitHub 硬性拒绝推送工作流文件。因此 checkout 步骤通过 `token: ${{ secrets.SYNC_TOKEN }}` 注入一个**个人访问令牌（PAT）**作为推送凭证，该 PAT 必须同时勾选 `repo` 和 `workflow` 两个 scope，并保存在仓库密钥 `SYNC_TOKEN` 中。
- 若 upstream/main 已是 main 的祖先则直接退出；否则合并后以 `github-actions[bot]` 身份 push。
- 其他官方继承的工作流（CI、docker-build、wiki-deploy、desktop-windows、wiki）在本仓库已禁用，仅保留 sync-upstream。

### 维护要点
- 更换 PAT 后需同步更新仓库密钥 `SYNC_TOKEN`；旧令牌立即失效。
- 分支保护规则不要启用“禁止由非授权人员或工作流推送”，否则会再次阻断自动同步。
- 如需修改上游地址，改 `git remote add upstream https://github.com/HKUDS/Vibe-Trading.git` 这一行即可。