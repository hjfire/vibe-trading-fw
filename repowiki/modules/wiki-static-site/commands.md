---
page: "modules/wiki-static-site/commands.md"
sources: []
verified_at: "7fdffa31a0d6ff54d236db3dea6adaf8d1ca6709"
anchors: open
vouch: applied-only
---
本地预览使用 `cd wiki && python3 -m http.server 8088` 并在 `http://localhost:8088/home/` 访问；开发时运行 `cd wiki && wrangler pages dev` 以启用 Pages Functions 和 D1 绑定；生产部署设置项目根为 `wiki`、构建命令为空、输出目录为 `.`；Alpha Library 需先执行 `vibe-trading alpha export-manifest --out wiki/alpha-library/manifest.json`，再运行 `python wiki/scripts/build_alpha_library.py` 生成静态页面。