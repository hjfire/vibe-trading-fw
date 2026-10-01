# repowiki/ — 仓库自有的 Repo Wiki 文档树

这是**本仓库自己的**Repo Wiki 事实源：被 git 跟踪的 Markdown 树，读写、漂移检测、
链接重锚、盖章全部可在 CLI 侧闭环，不依赖 Qoder IDE。

**它不是 `wiki/`。** 仓库根的 `wiki/` 是上游的公开文档站（Cloudflare Pages，
`vibetrading.wiki`），由上游拥有、由 `wiki.yml` / `wiki-deploy.yml` 部署。本树
不改动它一个字节，两棵树互不影响。

## 谁是事实源

- 事实源：本目录下的 Markdown ＋ `ledger.jsonl`（担保日志）。
- 非事实源：`.qoder/repowiki/**` 是 Qoder IDE 的导出物，冻结在 2026-08-14 的索引
  快照上，并被 `.git/info/exclude` 排除（git 不知道它存在，因此没有撤销能力）。
  `SearchKnowledge` 读的是那份 IDE 索引，所以它的 overview 会长期显示过期内容 —
  这是上游限制，只能标注，不能消除。

## 怎么更新

```bash
cd "E:/Vibe-Trading-main/Vibe-Trading-main"
python -X utf8 tools/wiki_drift.py --wiki-root repowiki report
python -X utf8 tools/wiki_drift.py --wiki-root repowiki reanchor --shifts --apply
python -X utf8 tools/wiki_drift.py --wiki-root repowiki mark \
    --page <相对 topics/ 的页路径> -m "<这次核对改了什么>"
```

每页 frontmatter 的 `verified_at` 是**该页上次核对时所处的 commit**：基线随页面走，
在 git 里可 diff、可回滚。`anchors` 记链接坐标是否已核，`vouch` 记这次盖章担保到
什么范围（`all` 只允许人工盖章写出，工具自动改链接只能写 `applied-only`）。

## 当前定性（M5 之前）

**链接层已核、散文层未核，别当事实源引用。** 播种进来的正文来自 IDE 快照，链接
坐标已全仓改写并验证幂等，但散文自 2026-08-14 起没被人重读过。

## 已知长期现象

`bash tools/ci_grep_gates.sh` 在本地**长期红一条**，且永远只有那一条：命中路径以
`./.qoder/` 开头就是它。那是门禁 (b) 按文件系统扫描的口径缺陷（IDE 导出物被 git
排除、CI 的 checkout 里没有该目录），修它要改上游拥有的 `tools/ci_grep_gates.sh`，
与「二次开发不动需要同步的上游原始部分」冲突，因此记为遗留。

**不要为了把它改绿去动上游脚本，也不要新开目录豁免。** 发布物合规靠两件事：
措辞合规（见 `项目档案.md`）＋ fork 自带的守卫用例
（`tools/test_wiki_drift.py` 里那组扫本树的商标检查，它会随一次真违规变红）。
