---
page: "modules/agent-backend/tech-stack.md"
sources: []
verified_at: "7fdffa31a0d6ff54d236db3dea6adaf8d1ca6709"
anchors: open
vouch: applied-only
---
FastAPI + Uvicorn 提供 REST/SSE；fastmcp 构建 MCP 协议服务器；LangChain/LangGraph 驱动 LLM 工作流；pandas/numpy/scipy/duckdb 做量化计算；yfinance/akshare/ccxt/tushare/baostock/eastmoney 等作为行情数据源；weasyprint/matplotlib/jinja2 生成 PDF/HTML 报告；websockets/aiohttp/httpx 处理异步通信。