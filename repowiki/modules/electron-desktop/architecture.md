---
page: "modules/electron-desktop/architecture.md"
sources: []
verified_at: "7fdffa31a0d6ff54d236db3dea6adaf8d1ca6709"
anchors: open
vouch: applied-only
---
模块以 `src/main.ts` 为 Electron 主进程入口，通过 `app.requestSingleInstanceLock()` 保证单实例，并创建带 `contextIsolation`/`nodeIntegration: false`/`sandbox: true` 的 `BrowserWindow`，使用 `preload.ts` 经 `contextBridge.exposeInMainWorld('vibeDesktop')` 暴露最小 IPC API（重试、打开日志、重启后端、凭证读写）给渲染进程。

核心职责分层：
- 进程与网络层：`backend-manager.ts` 的 `BackendManager` 类解析后端可执行文件（优先 `VIBE_TRADING_EXECUTABLE`，再打包路径，最后 PATH），绑定空闲 loopback 端口，通过 spawn 启动 `backend-watchdog.js` 子进程，设置 `API_AUTH_KEY`、`VIBE_TRADING_DESKTOP_BACKEND_ARGUMENTS` 等环境变量，轮询 `/health` 直至就绪；关闭时先调用 `system/shutdown`，再向 watchdog 发送 terminate 消息，最终用 `taskkill /T /F` 强制终止。
- 安全边界：`main.ts` 在 `webRequest.onBeforeSendHeaders` 中仅对匹配后端 origin 的请求注入 `Authorization: Bearer ${apiAuthKey}`，并通过 `setPermissionCheckHandler`/`setPermissionRequestHandler` 拒绝所有权限请求；`secure-credentials.ts` 使用 `electron.safeStorage` 加密持久化受白名单 `ENV_CREDENTIALS` 限定的密钥，并在初始化时从 `.env` 和 `qveris.json` 迁移旧凭证。
- 国际化：`locales.ts` 提供桌面端加载页、菜单、错误提示的多语言文案，通过 `loading.html` 的 base64url locale 查询参数传递给渲染侧。
- 构建与打包：`package.json` 配置 electron-builder 输出 NSIS 安装包，`extraResources` 将 `runtime/backend` 嵌入应用；`scripts/` 下包含 Windows 签名安装器、审查版安装器、静态资源复制、Electron 预准备以及一组 smoke/lifecycle 测试脚本。
依赖方向单向：`main.ts` → `BackendManager` + `SecureCredentialStore` + `locales`；`preload.ts` 仅桥接 IPC，不直接访问 Node/Electron 原生 API。