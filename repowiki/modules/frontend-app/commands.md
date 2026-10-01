---
page: "modules/frontend-app/commands.md"
sources: []
verified_at: "7fdffa31a0d6ff54d236db3dea6adaf8d1ca6709"
anchors: open
vouch: applied-only
---
Node ≥ 22.22.0；开发服务器启动 `npm run dev`（监听 5899 端口），构建命令 `npm run build`（先执行 `tsc -b` 类型检查再 `vite build`）；单元测试 `npm run test` / `npm run test:run`，覆盖率 `npm run test:coverage`；开发时通过 Vite proxy 将 `/auth`、`/sessions`、`/swarm/*`、`/settings/*`、`/channels`、`/mandate`、`/live`、`/upload`、`/options`、`/alpha*`、`/scheduled-runs` 等路径转发至 `VITE_API_URL`（默认 http://127.0.0.1:8000）。