---
page: "modules/electron-desktop/tech-stack.md"
sources: []
verified_at: "7fdffa31a0d6ff54d236db3dea6adaf8d1ca6709"
anchors: open
vouch: applied-only
---
Electron 43.1.1 + TypeScript 5.9，使用 electron-builder 26.15.3 打包 NSIS 安装器；通过 `electron.safeStorage` 实现平台级凭据加密；Windows 下借助 `taskkill.exe /T /F` 强制终止进程树。