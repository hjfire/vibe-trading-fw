---
page: "modules/electron-desktop/conventions.md"
sources: []
verified_at: "7fdffa31a0d6ff54d236db3dea6adaf8d1ca6709"
anchors: open
vouch: applied-only
---
- IPC 通道采用 `desktop:` 前缀命名（如 `desktop:retry`、`desktop:error`、`desktop:get-credential-status`），并通过 `assertMainWindowSender` 校验 sender 等于当前 `mainWindow.webContents` 以防御跨上下文调用。
- 对外部 URL 跳转统一经 `isSafeExternalUrl` 白名单检查（仅允许 `http:`/`https:`），再通过 `shell.openExternal` 打开，禁止在窗口内导航到非后端 origin 的地址。
- 后端可执行文件解析遵循严格优先级链：`VIBE_TRADING_EXECUTABLE` 环境变量 → 受限的打包根目录集合 → 源码模式下的 `pyproject.toml` 标记祖先目录 → `PATH` 逐项查找，绝不递归扫描任意父目录或驱动器根。
- 敏感数据写入采用原子替换模式：先写 `.tmp` 文件（mode 0o600），再 `fs.rename` 覆盖目标，避免并发写入导致损坏。
- 用户可见文本全部走 `locales.ts` 的 `formatDesktopMessage` 模板函数，错误消息通过 `messages.*` 键名注入，不出现硬编码字符串。
- 子进程通信通过 `child_process.spawn` + `ipc` channel 传递结构化消息（如 `WatchdogMessage`），stdout/stderr 按行捕获并追加到按日期命名的日志文件中，同时保留最近 80 条用于错误详情。