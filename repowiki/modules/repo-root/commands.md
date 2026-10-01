---
page: "modules/repo-root/commands.md"
sources: []
verified_at: "7fdffa31a0d6ff54d236db3dea6adaf8d1ca6709"
anchors: open
vouch: applied-only
---
`docker compose up -d` 启动后端（8899）与可选 frontend profile（5899）；`pip install -e .[channels,dev]` 安装带全部渠道 SDK 的可编辑版本；`npm run build` 在前端目录内生成静态资源供后端 serve 或 Docker 构建使用。