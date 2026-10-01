---
page: "cards/glossary.md"
sources: []
verified_at: "7fdffa31a0d6ff54d236db3dea6adaf8d1ca6709"
anchors: open
vouch: applied-only
category: "business_term"
kind: "business_term"
name: "业务术语表"
scope:
  - "**"
---

### 本地自定义①~⑥
- 定义：项目档案中对用户在官方 HKUDS/Vibe-Trading 代码之上所做的六处本地修改的编号化称呼：① start.bat 一键启动脚本；② vite.config.ts 代理端口改为 8000；③ api_server.py 的 sys.modules 注册修复；④ sync.bat 同步脚本 + 每日同步工作流；⑤ 项目档案.md 交接文档（仅本地，未入库）；⑥ sync-upstream.yml 改用 SYNC_TOKEN 个人访问令牌推送以绕过 GITHUB_TOKEN 对 .github/workflows/ 的推送限制。用于在每次官方同步后快速定位需要重新应用的本地改动。
- 别名：本地自定义、本地补丁、本地修改

### SYNC_TOKEN
- 定义：仓库级 GitHub Actions 密钥的名称，存放一个具有 `repo` + `workflow` 权限的经典个人访问令牌（PAT）。sync-upstream 工作流通过 `actions/checkout` 的 `token` 参数注入该令牌，使合并后的 push 操作以 PAT 身份执行，从而绕过 GitHub 对 `GITHUB_TOKEN` 推送 `.github/workflows/` 文件的限制。
- 别名：同步令牌、PAT

### Repo Wiki
- 定义：IDE（Qoder）基于仓库源码自动生成的中文技术文档集合，导出到本项目的 `.qoder/repowiki` 目录。依赖 IDE 打开 Git 仓库根目录才能识别提交历史并启用增量更新；生成后每次新 commit 会触发自动补齐。曾因在父目录误生成导致元数据基线丢失，现已移回本项目目录。
- 别名：repowiki、Wiki、自动更新

### Options Lab
- 定义：Vibe-Trading 官方于 2026-08-14 新增的多腿期权收益图、标的×隐含波动率情景矩阵、持仓希腊字母与实时链路的 Web 页面，由现有的 options payoff 工具与 `src/quantlib` 计算而非二次实现数学。
- 别名：期权实验室、options_payoff_tool、options_chain_tool

### tickerall
- 定义：Vibe-Trading 第 25 个市场数据源，提供托管版 MetaTrader 5 外汇/贵金属 K 线，无需本地终端，仅在显式指定 `source=tickerall` 时启用（不会静默成为 fallback 目标），且历史窗口截断视为错误而非返回短序列。
- 别名：TickerAll、mt5 分类器
