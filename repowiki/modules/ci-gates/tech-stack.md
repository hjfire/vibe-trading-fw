---
page: "modules/ci-gates/tech-stack.md"
sources: []
verified_at: "7fdffa31a0d6ff54d236db3dea6adaf8d1ca6709"
anchors: open
vouch: applied-only
---
Python 3 标准库 `ast` 实现静态分析门禁；Bash + grep 实现文本级安全门；GitHub Actions (actions/checkout@v7, actions/setup-python@v7, docker/build-push-action@v5) 编排 CI；Pytest 驱动门禁单元测试。