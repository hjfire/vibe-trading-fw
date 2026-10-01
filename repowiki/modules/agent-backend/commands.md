---
page: "modules/agent-backend/commands.md"
sources: []
verified_at: "7fdffa31a0d6ff54d236db3dea6adaf8d1ca6709"
anchors: open
vouch: applied-only
---
API 服务：`python api_server.py [--port 8000] [--host 127.0.0.1] [--dev]`，开发模式会拉起 Vite 前端；MCP 服务：`python mcp_server.py`（默认 stdio），或通过 `--transport sse|http` 暴露网络端点，HTTP 模式下需在 `/mcp` 访问；CLI：通过 `cli/__main__.py` 进入交互式终端；测试：`pytest agent/tests`。