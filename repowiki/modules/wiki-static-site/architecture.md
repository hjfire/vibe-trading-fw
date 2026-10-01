---
page: "modules/wiki-static-site/architecture.md"
sources: []
verified_at: "7fdffa31a0d6ff54d236db3dea6adaf8d1ca6709"
anchors: open
vouch: applied-only
---
站点以纯静态 HTML/CSS/JS 为主，按功能分区组织：`home/`、`docs/`（含 `content.js` 中声明式版本与页面结构）、`tutorials/`、`alpha-library/`、`research-lab/` 各自独立入口；根目录 `main.js`、`theme.js`、`styles.css`、`theme-init.js` 提供全局主题、GitHub star 缓存、安装标签页切换、i18n (`locales/en.json`) 与页脚流量统计渲染。动态能力集中在 `functions/`：`_middleware.js` 作为 Pages 中间件对每个 HTML 请求按 User-Agent 分类为 agent/bot/human，并将计数写入 D1 数据库 `visits` 表；`api/stats.js` 聚合 D1 中的访问数据并拉取 PyPI 安装量（带 D1 缓存兜底）返回给前端。路由通过 `_redirects` 将 `/docs`、`/alpha-library` 等路径重定向到对应子目录或最新版本。构建产物由 `scripts/build_alpha_library.py` 从 `vibe-trading alpha export-manifest` 输出的 manifest 用 Jinja2 渲染生成 Alpha Library 静态页面，并强制 CSP 禁止脚本执行。部署配置在 `wrangler.toml`，Pages 构建输出目录为根 `.`，无需构建步骤。