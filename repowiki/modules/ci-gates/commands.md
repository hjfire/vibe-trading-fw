---
page: "modules/ci-gates/commands.md"
sources: []
verified_at: "7fdffa31a0d6ff54d236db3dea6adaf8d1ca6709"
anchors: open
vouch: applied-only
---
本地验证门禁：`bash tools/ci_grep_gates.sh`；查看环境变量读取白名单：`python tools/ci_env_var_gate.py --allowlist`；运行门禁单元测试：`pytest tools/test_ci_env_var_gate.py -q`；Docker 镜像发布需通过 workflow_dispatch 传入 `image_tag` 参数。