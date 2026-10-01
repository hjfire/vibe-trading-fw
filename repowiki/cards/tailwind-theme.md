---
page: "cards/tailwind-theme.md"
sources:
  - "frontend/package.json"
  - "frontend/postcss.config.js"
  - "frontend/public/theme-boot.js"
  - "frontend/src/index.css"
  - "frontend/src/lib/chart-theme.ts"
  - "frontend/src/lib/pnl-colors.ts"
  - "frontend/src/lib/utils.ts"
  - "frontend/src/main.tsx"
  - "frontend/tailwind.config.ts"
  - "frontend/vite.config.ts"
verified_at: "7fdffa31a0d6ff54d236db3dea6adaf8d1ca6709"
anchors: open
vouch: applied-only
category: "frontend_style"
kind: "frontend_style"
name: "前端样式体系：Tailwind CSS + CSS 变量主题系统"
scope:
  - "**"
source_files:
  - "frontend/tailwind.config.ts"
  - "frontend/src/index.css"
  - "frontend/public/theme-boot.js"
  - "frontend/src/lib/utils.ts"
  - "frontend/postcss.config.js"
  - "frontend/package.json"
  - "frontend/vite.config.ts"
  - "frontend/src/main.tsx"
  - "frontend/src/lib/chart-theme.ts"
  - "frontend/src/lib/pnl-colors.ts"
---

## 1. 使用的系统与工具

Vibe-Trading 的前端（`frontend/`）采用 **React + Vite** 构建，样式体系基于 **Tailwind CSS v3**，并通过 CSS 自定义属性（CSS Variables / Design Tokens）实现可切换的明暗主题。核心依赖包括：
- `tailwindcss`、`@tailwindcss/typography`、`autoprefixer`、`postcss`
- `clsx` + `tailwind-merge` 用于安全合并 className
- `@fontsource/inter`、`@fontsource/jetbrains-mono` 提供字体
- `echarts` 图表库配合独立的图表主题 token
- `sonner` 作为全局 toast 通知组件
- `katex`、`highlight.js`、`react-markdown` 等渲染层样式由各自包引入

构建配置在 `vite.config.ts` 中通过 `@vitejs/plugin-react` 启用 React，并使用 `manualChunks` 将 `react/react-dom/react-router` 与 `echarts` 单独拆包。

## 2. 关键文件

- `frontend/tailwind.config.ts`：定义 Tailwind 主题扩展，将颜色、字体、圆角映射到 CSS 变量
- `frontend/src/index.css`：根样式入口，声明 `:root` 与 `.dark` 两套设计 token，注入 Tailwind base/components/utilities
- `frontend/public/theme-boot.js`：在页面加载前读取 `localStorage('qa-theme')` 并切换 `<html>` 上的 `dark` class，避免闪烁
- `frontend/src/lib/utils.ts`：导出 `cn(...)` 工具函数，封装 `clsx` + `tailwind-merge` 以安全合并 className
- `frontend/postcss.config.js`：PostCSS 管线仅包含 `tailwindcss` 与 `autoprefixer`
- `frontend/package.json`：声明所有样式相关依赖版本
- `frontend/src/main.tsx`：应用入口，导入 `index.css` 与 `highlight.js/styles/github-dark-dimmed.min.css`，挂载 Sonner Toaster
- `frontend/src/lib/chart-theme.ts`、`pnl-colors.ts`：为 ECharts 提供与主题联动的颜色 token
- `frontend/src/i18n/`：多语言资源，配合 RTL 支持（见 index.css 中的 `[dir="rtl"] .rtl\:flip-x`）

## 3. 架构与设计约定

### 3.1 设计 Token 体系（CSS 变量）

所有视觉语义通过 CSS 变量集中管理，分为四类：

| 类别 | 变量名 | 用途 |
|---|---|---|
| 表面色 | `--background`、`--card`、`--popover` | 页面背景、卡片、浮层 |
| 前景色 | `--foreground`、`--card-foreground`、`--muted-foreground` | 文字、图标 |
| 语义色 | `--primary`、`--destructive`、`--success`、`--danger`、`--warning`、`--info` | 品牌、错误、状态 |
| 图表色 | `--chart-grid`、`--chart-text`、`--chart-axis`、`--chart-compare-a/b` | ECharts 网格、坐标轴、对比线 |

这些变量在 `:root`（亮色）和 `.dark`（暗色）下分别赋值，Tailwind 通过 `hsl(var(--xxx))` 形式引用，例如 `bg-background`、`text-primary`、`border-destructive`。

### 3.2 明暗主题策略

- 使用 Tailwind 的 `darkMode: "class"` 模式，通过给 `<html>` 添加/移除 `dark` class 切换主题
- 主题切换脚本 `theme-boot.js` 在 React 渲染前执行，优先读取 `localStorage('qa-theme')`，否则回退到 `prefers-color-scheme`，并设置 `colorScheme` 以适配原生表单控件
- 暗色模式下刻意保持相邻表面之间 ≥5% 明度差（注释明确说明），确保面板层级可区分

### 3.3 字体与排版

- 无衬线体：`Inter`（webfont）+ `system-ui` 兜底
- 衬线体：`Georgia` + `Songti SC` + `Noto Serif SC`，仅用于 hero greeting 展示，注释明确禁止用于答案/表格（数值内容保持 sans/mono）
- 等宽体：`JetBrains Mono`（webfont）+ `ui-monospace` 兜底
- 通过 `@tailwindcss/typography` 插件增强 Markdown 渲染的 prose 样式

### 3.4 组件级样式约定

- 组件内 className 统一通过 `cn()` 工具合并，如 `Skeleton` 组件中使用 `cn("animate-pulse rounded-md bg-muted/50", className)`，允许调用方覆盖默认类
- 布局组件按职责分目录：`components/common/`、`components/charts/`、`components/chat/`、`components/layout/`、`components/options/`、`components/settings/`
- 全局 UI 反馈通过 `sonner` 的 `<Toaster position="bottom-right" richColors />` 提供

### 3.5 图表主题联动

ECharts 不直接使用 Tailwind 类，而是通过 `src/lib/chart-theme.ts`、`pnl-colors.ts` 从 CSS 变量读取颜色，保证图表与页面主题一致。

### 3.6 动画与无障碍

- 消息进入动画 `msg-enter` 使用 `cubic-bezier(0.16, 1, 0.3, 1)`，并通过 `@media (prefers-reduced-motion: reduce)` 禁用
- 滚动条通过 `::-webkit-scrollbar` 自定义，宽度 6px，hover 时高亮
- RTL 支持：`[dir="rtl"] .rtl\:flip-x { transform: scaleX(-1); }` 自动镜像方向性图标

## 4. 约定与约束

- **主题变量命名规范**：所有颜色必须通过 `--xxx` 变量暴露，不得在组件中硬编码十六进制色值（除图表对比色等少数场景）；Tailwind 配置中已将所有语义色映射到 `hsl(var(--xxx))` 形式
- **暗色模式开关方式**：只能通过给 `<html>` 添加/移除 `dark` class 切换，禁止直接操作 `style.backgroundColor` 等内联样式
- **字体使用限制**：衬线体仅用于 hero greeting，注释明确要求“Deliberately NOT used for answers/tables”，数值内容保持 sans/mono
- **className 合并**：组件对外暴露的 className 必须通过 `cn()` 合并，确保调用方可覆盖默认样式而不产生冲突
- **主题持久化键名**：主题偏好存储在 `localStorage('qa-theme')`，值为 `light` 或 `dark`，其他值视为未设置
- **Prose 表格增强**：Markdown 表格统一使用 `border-collapse`、边框色来自 `--border`、偶数行背景来自 `--muted/0.3`，禁止在组件中重写表格样式
- **构建产物拆分**：`react`、`react-dom`、`react-router` 打包为 `vendor-react`，`echarts` 打包为 `vendor-charts`，避免重复加载
- **国际化与 RTL**：i18n 通过 `react-i18next` 管理，RTL 布局通过 `dir="rtl"` 配合 CSS 选择器处理，新增方向性图标需遵循 `rtl\:flip-x` 模式