# L0：Pine 编辑器（面 A12）

- 状态：不可取证
- 原因：需登录，按裁定 1 不做登录绕过
- 命令：npx -y rea-agents@latest inspect-web-page http://127.0.0.1:9222 162F72C6F52A032716B333A93738AEC8 --allowed-origins https://www.tradingview.com --observation-ms 1500 --include-accessibility-text --filter-output evidence_id,normalized_result --token-limit 400000
- 执行状态：**本席未执行这一条**（按简报第 6 步：这两面不跑命令）⇒ 本面没有 stdout 留档、没有面名同名的那份 cmd 留档、没有 `evidence_id`，也不写 `用途：`
- 入参照抄：上面那条命令里的 target_id 是本次现场挂载趟真实读到的那一个（`C:\Users\fire\AppData\Local\Temp\rea-t10b\targets-3.txt:22`，同一趟的 browser 读数在 `targets-3.txt:16-20`）——它只说明「若执行会用哪个 target」，**不代表执行过**这一条
- 目标 URL：https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL
- 观察条件：若执行，现场与本批次其余面同一趟挂载：Edge `--headless=new` ＋ `--remote-debugging-port=9222` ＋ 专属 profile 目录 `%TEMP%\rea-cdp-profile-t10b` ＋ `--proxy-server="http://127.0.0.1:7897"`（当次 `reg query` 现读：`ProxyEnable=0x1`／`ProxyServer=127.0.0.1:7897`）；旗标只开 `--include-accessibility-text` 一把（按批次清单 §2 的取舍：`--include-script-sources` 写死禁开，Pine 编辑器里的脚本正文正是最不该带回来的东西）；`--filter-output` 按 §3① 显列顶层 `evidence_id`；`--token-limit` 按 §3③ 的收口口径；观察窗 1500ms；未点按、未登录、未保存、未提交
- 为什么是这一条命令：A12 要读的是「Pine 编辑器那面板有哪几栏、按钮与菜单的可达名是什么」，形状上与 A1 的无障碍读数同类（`role`＋`name`），所以同形命令就是 `inspect-web-page` 加那把无障碍旗标；不需要我方自己起第二个面
- 卡在哪：该面板在对方页上的呈现以登录态为前提（批次清单 §5③ 把它写死为「要登录才能看到」）；我方纪律是«允许：只做打开类动作»＋«不登录／不保存／不交易»（用户 2026-10-13 晚选项原文，spec 裁定 1 同源）⇒ 打开它的前置不在许可动作范围内，本席**不绕过、不伪装、不试任何登录态捷径**
- 本面在 L1 里的位置：这是一个**判据缺口**，不是一份弱证据。它不支撑任何规格句，也不给差距矩阵「不可复刻」的读数依据——本席连一趟都没跑，所以能落进 L2 的只有「本批次未取证，成因是登录门前置＋裁定 1」。
- 若要翻案：把 A12 从「不可取证」翻成任何一档（哪怕只点开面板不读内容）都属**批次内容变更**，按批次清单前言要重新点头，且需要控制器就「登录」这条红线单独裁定；本席不自作主张扩面。
- 与「not_found」的区别（写在这免得后续席混）：`tv-a4-rolemenu.md` 那枚是**跑成功的趟读到未命中**，有主键有留档，照 §7 落档；本面是**根本没跑**，所以只有 状态／原因／命令 三件事可写。两件事不是一回事。
