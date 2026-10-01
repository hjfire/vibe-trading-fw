---
page: "modules/frontend-app/architecture.md"
sources: []
verified_at: "7fdffa31a0d6ff54d236db3dea6adaf8d1ca6709"
anchors: open
vouch: applied-only
---
模块以 `src/main.tsx` 为入口，使用 `react-router` v8 的 `createBrowserRouter` 在 `src/router.tsx` 中集中声明路由，并通过 `lazy()` + `Suspense` 实现页面级代码分割；所有页面组件位于 `src/pages/`，被 `Layout` 包裹作为统一壳层。

状态管理采用 Zustand（`src/stores/agent.ts`），集中维护会话消息、SSE 流式文本、工具调用链、Agent 活动状态与 Swarm 运行状态，并提供本地内存缓存（LRU 风格，最多保留 5 个 session）。

HTTP 客户端集中在 `src/lib/api.ts`，封装统一的 `request<T>()` 方法，自动注入认证头、解析错误并区分 JSON/非 JSON 响应；SSE 流通过独立的 `useSSE` hook（`src/hooks/useSSE.ts`）配合后端 `/sessions/:id/events` 与 `/swarm/runs/:id/events` 等端点。

UI 组件按职责分层：`components/common`（通用 UI）、`components/layout`（布局与连接横幅）、`components/charts`（ECharts 封装的各类金融图表）、`components/chat`（Agent 对话渲染）、`components/options`（期权希腊字母与策略构建器）、`components/settings`（模型与 QVeris 设置）。业务逻辑与数据格式化放在 `src/lib/`（echarts 主题、指标计算、Markdown/KaTeX 渲染、PineScript 展示等）。

国际化由 `src/i18n/index.ts` 驱动，使用 i18next + react-i18next，支持 en/zh-CN/ja/ko/ar/es 六种语言，非英语资源按需动态 import，并根据语言代码切换文档 `dir`（RTL/LTR）。

构建配置在 `vite.config.ts`：定义 `@` 路径别名、开发服务器端口 5899、将多个后端 API 前缀代理到 `VITE_API_URL`（默认 `http://127.0.0.1:8000`），并按依赖拆分 vendor chunk（react/react-dom/react-router 与 echarts 独立打包）。测试使用 Vitest + jsdom，测试文件与源码同目录放置于 `__tests__/` 或 `*.test.*` 命名约定。