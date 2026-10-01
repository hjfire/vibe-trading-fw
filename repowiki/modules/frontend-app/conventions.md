---
page: "modules/frontend-app/conventions.md"
sources: []
verified_at: "7fdffa31a0d6ff54d236db3dea6adaf8d1ca6709"
anchors: open
vouch: applied-only
---
- 页面级路由组件统一通过 `lazy(() => import(...))` 懒加载，并在 router 中以 `wrap(Component)` 包裹 `<Suspense fallback={<PageLoader />}>` 提供加载占位。
- 所有 HTTP 请求经 `src/lib/api.ts` 的 `request<T>()` 发起，统一处理 Content-Type 校验、401/403 转换为带 i18n 消息的 `ApiError`，并由 `apiAuth.ts` 注入认证头。
- Zustand store 以 `create<Interface>((set) => ({ ... }))` 形式定义，所有状态变更通过函数式 `set((s) => patch)` 更新，保持不可变更新模式。
- 组件与测试文件就近组织：每个 `.tsx` 旁可放同名 `__tests__/xxx.test.tsx` 或使用 `xxx.test.tsx` 命名，测试覆盖 components、hooks、pages、stores 各层。
- 国际化文案通过 `i18n.t('key')` 访问，语言包按 `src/i18n/locales/{code}.json` 存放，非英语资源通过 `localeLoaders` 映射进行动态 import 以实现按需加载。
- 图表组件统一基于 ECharts 封装，复用 `src/lib/chart-theme.ts` 与 `src/lib/echarts.ts` 中的主题与配置，避免在各页面重复定义图表样式。