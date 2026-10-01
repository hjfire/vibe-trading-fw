---
page: "cards/dependency-management.md"
sources:
  - ".github/dependabot.yml"
  - "agent/requirements.txt"
  - "desktop/electron/package-lock.json"
  - "desktop/electron/package.json"
  - "desktop/electron/requirements-windows-lock.txt"
  - "frontend/package-lock.json"
  - "frontend/package.json"
  - "pyproject.toml"
  - "requirements-channels-lock.txt"
  - "requirements-lock.txt"
verified_at: "7fdffa31a0d6ff54d236db3dea6adaf8d1ca6709"
anchors: open
vouch: applied-only
category: "dependency_management"
kind: "dependency_management"
name: "多语言仓库依赖管理：pip + pip-compile、npm lockfile 与 Dependabot 协同治理"
scope:
  - "**"
source_files:
  - "pyproject.toml"
  - "agent/requirements.txt"
  - "requirements-lock.txt"
  - "requirements-channels-lock.txt"
  - "desktop/electron/requirements-windows-lock.txt"
  - "frontend/package.json"
  - "frontend/package-lock.json"
  - "desktop/electron/package.json"
  - "desktop/electron/package-lock.json"
  - ".github/dependabot.yml"
---

## 1. 使用的系统与工具

本仓库是一个多端一体化项目，包含 Python Agent、React 前端、Electron 桌面宿主与 Wiki 静态站点，因此采用**分语言、分目录的依赖声明 + 全量锁定文件 + 自动化更新**的组合策略：

- **Python（Agent）**：使用 `pyproject.toml` 作为主声明源（定义包名、可选依赖 extras、脚本入口），配合 `agent/requirements.txt` 作为人类可读清单；通过 `pip-compile`（来自 `pip-tools`）生成带 SHA256 hash 的 `requirements-lock.txt` 与 `requirements-channels-lock.txt`，并针对 Windows Electron 打包单独生成 `desktop/electron/requirements-windows-lock.txt`。
- **前端（React/Vite）**：使用 `frontend/package.json` 声明依赖，并通过 `frontend/package-lock.json`（lockfileVersion 3）锁定所有子依赖版本。
- **Electron 桌面**：使用 `desktop/electron/package.json` 声明构建期依赖（electron、electron-builder、typescript），并通过 `desktop/electron/package-lock.json` 锁定。
- **自动化升级**：通过 `.github/dependabot.yml` 对 pip、npm、GitHub Actions 三类生态配置月度扫描与 PR 推送。

## 2. 关键文件

| 作用 | 路径 |
|---|---|
| Python 包元数据与核心/可选依赖 | `pyproject.toml` |
| Python 人类可读依赖清单 | `agent/requirements.txt` |
| Python 全量锁定（含 hash） | `requirements-lock.txt` |
| Channels 通道扩展锁定（基于主锁定约束） | `requirements-channels-lock.txt` |
| Windows Electron 运行时 Python 锁定 | `desktop/electron/requirements-windows-lock.txt` |
| 前端依赖与锁文件 | `frontend/package.json`、`frontend/package-lock.json` |
| Electron 桌面依赖与锁文件 | `desktop/electron/package.json`、`desktop/electron/package-lock.json` |
| Dependabot 自动升级规则 | `.github/dependabot.yml` |

## 3. 架构与约定

### 3.1 Python 依赖分层

- **核心依赖**集中在 `pyproject.toml` 的 `[project] dependencies` 中（如 langchain、fastapi、pandas、ccxt、akshare、yfinance 等），并通过 `requires-python = ">=3.11,<3.14"` 限制解释器范围。
- **可选依赖**通过 `[project.optional-dependencies]` 按功能域拆分：`ibkr`、`longbridge`、`mt5`、`deepseek`、`anthropic`、`openbb`、`stats`、`ashare`、`harmonic`、各消息通道（`dingtalk`、`discord`、`feishu`、`matrix`、`mochat`、`msteams`、`napcat`、`qq`、`slack`、`telegram`、`wecom`、`weixin`、`whatsapp`）、聚合的 `channels` extra 以及 `dev` 开发依赖。注释明确说明每个 extra 是“lazy-import”且缺失时给出可操作的安装提示，保证基础安装保持精简。
- `agent/requirements.txt` 是对 `pyproject.toml` 的镜像式人类可读清单，顶部用注释标注可选依赖的安装方式（如 `pip install "vibe-trading-ai[deepseek]"`）。
- `requirements-lock.txt` 由 `pip-compile --allow-unsafe --generate-hashes --output-file=requirements-lock.txt agent/requirements.txt` 生成，包含每个包的多个平台 wheel 的 sha256 hash，确保安装确定性。
- `requirements-channels-lock.txt` 在 `requirements-lock.txt` 基础上通过 `-c requirements-lock.txt` 约束复用共享依赖，再叠加 channels 专属包。
- `desktop/electron/requirements-windows-lock.txt` 使用 Python 3.12 重新编译，适配 Windows 桌面运行时的二进制差异。

### 3.2 前端与 Electron 依赖

- `frontend/package.json` 声明 React 19、Vite 8、Tailwind、ECharts、i18next、Zustand 等运行时依赖，以及 TypeScript、Vitest、Testing Library、PostCSS 等开发依赖，并通过 `engines.node >= 22.22.0` 强制 Node 版本。
- `desktop/electron/package.json` 仅声明构建期 devDependencies（electron 43.1.1、electron-builder 26.15.3、typescript），不包含运行时依赖；其 `build.extraResources` 将预编译的 backend 二进制嵌入安装包。

### 3.3 依赖锁定与可重复构建

- Python 侧全部使用 `--generate-hashes` 生成的锁定文件，CI 或部署时应校验 hash 而非仅匹配版本。
- npm 侧使用 lockfile v3（`package-lock.json`），锁定精确解析树。
- 三个 Python 锁定文件分别对应不同目标环境（通用、channels 扩展、Windows 桌面），避免跨平台二进制冲突。

### 3.4 Dependabot 升级策略

`.github/dependabot.yml` 定义了统一的月度扫描节奏，并对三类生态分组：

- **pip**：minor/patch 合并为 `pip-minor-patch` 组批量提交 PR，major 单独处理以便重点审查；显式 ignore pandas 的 major（因 <3.0.0 上限）、websockets（被 langgraph-sdk 限制）、以及 ccxt 4.5.71 精确固定的大量传递依赖（aiohappyeyeballs、aiohttp-fast-zlib、aiosignal、attrs、certifi、cffi、charset-normalizer、coincurve、frozenlist、idna、multidict、orjson、propcache、pycparser、typing-extensions、urllib3、uvloop、zlib-ng、pydantic-core）。注释详细解释了忽略原因与后续迁移计划。
- **npm**：minor/patch 合并为 `npm-minor-patch` 组；ignore `@vitejs/plugin-react` 的 major（peer 要求 vite ^8，当前工程使用 vite 6.x）。
- **GitHub Actions**：minor/patch 合并为 `actions-minor-patch` 组。

## 4. 约定与约束

- **Python 版本边界**：`requires-python = ">=3.11,<3.14"`，注释说明 3.14 被 smartmoneyconcepts → numba → llvmlite 无 wheel 阻塞，需等待上游发布 cp314 wheel。
- **pandas 向上封顶**：`pandas>=2.0.0,<3.0.0`，Dependabot 也显式 ignore pandas major，原因是 3.x 引入 Copy-on-Write 等破坏性变更，需作为独立迁移任务处理。
- **langchain/langgraph 系列**：均使用 `<2` / `<1.3` / `<5` 等上界，防止大版本升级破坏兼容性。
- **可选依赖 lazy-import**：每个 optional dependency 的注释都强调“base install 保持精简”，缺失时代码会 raise 可操作 ImportError，这是仓库内统一的设计约定。
- **ccxt 传递依赖冻结**：由于 ccxt 4.5.71 精确固定了 requests、cryptography、aiohttp、yarl 等传递依赖，这些包不能独立升级，必须随 ccxt 一起升级；Dependabot 对这些包发出 PR 会被判定为 ResolutionImpossible。
- **Node 引擎要求**：前端通过 `engines.node >= 22.22.0` 强制新 Node，同时移除了之前因 Node 20 EOL 而保留的旧依赖 ignore 条目。
- **Electron 打包产物隔离**：Electron 包不直接声明 Python 依赖，而是通过 `extraResources.runtime/backend` 注入预编译后端，Python 依赖由独立的 `requirements-windows-lock.txt` 管理。
- **无私有注册表**：未发现自定义 PyPI 镜像或 npm registry 配置，所有依赖从官方源（PyPI、npmjs.org）拉取。
- **无 vendoring**：未使用 `vendor/` 或 `third_party/` 手动拷贝第三方源码，完全依赖包管理器与锁定文件。
