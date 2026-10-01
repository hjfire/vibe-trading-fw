---
page: "cards/novita-openai-gateway.md"
sources:
  - "agent/.env.example"
  - "agent/src/providers/capabilities.py"
verified_at: "7fdffa31a0d6ff54d236db3dea6adaf8d1ca6709"
anchors: open
vouch: applied-only
category: "external_dependency"
category_hints:
  - "vendor_identity"
  - "sdk_real_api"
kind: "external_dependency"
name: "Novita AI — OpenAI 兼容推理网关"
scope:
  - "**"
slug: "novita-ai"
source_files:
  - "agent/.env.example"
  - "agent/src/providers/capabilities.py"
---

### 角色
Novita AI 是 Vibe-Trading 内置的第 N 个 LLM 提供商（README 2026-08-14 新闻确认），提供 OpenAI 兼容的推理服务，可作为 LangChain 的 `LANGCHAIN_PROVIDER=novita` 后端使用。

### 接入方式
- 环境变量：`NOVITA_API_KEY`（从 Novita 控制台获取）、`NOVITA_BASE_URL`（默认 `https://api.novita.ai/openai`）。
- 模型命名采用 `vendor/model` 形式（如 `moonshotai/kimi-k3`、`zai-org/glm-5.2`、`deepseek/deepseek-v4-flash-0731`），由 provider capabilities 注册为通用 OpenAI 兼容路径，无特殊能力标志。

### 注意事项
- 属于可选 provider，未安装对应 extra 时不影响基础安装；使用时需在 Settings 或 `.env` 中显式选择 `novita` 并提供 key。
- 与 DeepSeek native adapter、OpenRouter 等其它多模型网关并列，按用户选择的 `LANGCHAIN_PROVIDER` 路由。