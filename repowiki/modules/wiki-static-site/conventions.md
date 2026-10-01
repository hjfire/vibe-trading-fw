---
page: "modules/wiki-static-site/conventions.md"
sources: []
verified_at: "7fdffa31a0d6ff54d236db3dea6adaf8d1ca6709"
anchors: open
vouch: applied-only
---
- 所有外部数据获取（GitHub stars、PyPI 安装数、D1 查询）均包裹 try/catch 并以静默失败处理，确保不影响页面正常渲染。
- 用户可见文本通过 `data-i18n` / `data-i18n-html` 属性配合 `locales/en.json` 进行客户端 i18n 替换，HTML 中保留静态回退文案。
- Analytics 写入使用 `context.waitUntil` 异步提交且 `.catch(() => {})`，保证计数失败绝不阻塞页面响应。
- Alpha Library 生成的页面统一注入严格 CSP meta（`script-src 'none'`），公式以 `<pre><code>` 原始文本展示而不执行脚本。
- 文档版本与页面结构以 `docs/content.js` 中的常量数组集中声明，页面通过 id 路由而非文件系统路径。
- 跨域 API（`/api/stats`）统一设置 `Access-Control-Allow-Origin: *` 与 `Cache-Control: public, max-age=60` 响应头。