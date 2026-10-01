---
page: "modules/electron-desktop/commands.md"
sources: []
verified_at: "7fdffa31a0d6ff54d236db3dea6adaf8d1ca6709"
anchors: open
vouch: applied-only
---
开发运行需先在仓库根目录激活 Python venv 并安装 `vibe-trading`，再进入 `desktop/electron` 执行 `npm ci && npm start`；CI 生命周期冒烟测试通过 `npm run smoke:lifecycle` 触发，会依次验证本地化消息、优雅关闭、认证及父进程死亡后的子进程清理；Windows 打包分两步：`npm run pack:win` 生成 dir 产物，`npm run installer:win:review` 生成未签名审查包，`npm run installer:win:signed` 生成已签名安装包。