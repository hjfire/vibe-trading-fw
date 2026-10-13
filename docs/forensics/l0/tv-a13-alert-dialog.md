# L0：告警对话框（面 A13）

- 状态：不可取证
- 原因：需登录，按裁定 1 不做登录绕过
- 命令：npx -y rea-agents@latest inspect-web-event-listeners http://127.0.0.1:9222 162F72C6F52A032716B333A93738AEC8 --allowed-origins https://www.tradingview.com "[role="dialog"]" --filter-output evidence_id,normalized_result.selected_node,normalized_result.listeners --token-limit 500
- 执行状态：**本席未执行这一条**（按简报第 6 步：这两面不跑命令）⇒ 本面没有 stdout 留档、没有面名同名的那份 cmd 留档、没有 `evidence_id`，也不写 `用途：`
- 入参照抄：命令里的 target_id 是本次现场挂载趟真实读到的那一个（`C:\Users\fire\AppData\Local\Temp\rea-t10b\targets-3.txt:22`；browser 读数同趟 `targets-3.txt:16-20`）——只说明「若执行会用哪个 target」，**不代表执行过**
- 目标 URL：https://www.tradingview.com/chart/?symbol=NASDAQ%3AAAPL
- 观察条件：若执行，现场与本批次其余面同一趟挂载（Edge `--headless=new` ＋ 9222 ＋ 专属 profile 目录 `%TEMP%\rea-cdp-profile-t10b` ＋ `--proxy-server="http://127.0.0.1:7897"`，端口当次 `reg query` 现读）；`--filter-output` 按批次清单 §3② 止步于 `selected_node,listeners`（A4 那一族命令会把内联回调脚本正文带出来，这一条照抄同一口径）；`--token-limit 500` 与本席八枚 A4 正式趟同闸门；未点按、未登录、未创建告警、未提交任何表单
- 为什么是这一条命令：A13 的第一句话是「告警对话框这一处在对方页面上存不存在、能不能被指认」，最省形的探针就是 A4 那族单趟命令按 `[role="dialog"]` 查一次（同形参照：`tv-a4-rolemenu.md` 那一枚未命中的读数形状）。它只回答可达性；「对话框有哪几栏、每栏什么字段」那一层要的是点开之后的 `accessibility` 读数（A7／A8 那类 ② 交互面形状），前置同样是登录，因此同样不可取证。
- 卡在哪：告警的创建与告警对话框的完整呈现都以登录态为前提（批次清单 §5③ 写死）；纪律是«不登录／不保存／不交易»＋«只点自己触发的 UI» ⇒ 我方不能为了打开它先登录，也不做会话态注入一类绕过。
- 本面在 L1 里的位置：判据缺口。不支撑任何规格句；进 L2 时能落的只有一句「本批次未取证，成因＝登录门前置＋裁定 1 不绕过」，不是「对方没有告警对话框」。
- 一条必须留下来的对照：本面**未跑**，所以不能拿 `tv-a4-rolemenu.md` 里那枚 `[role="menu"]` 的 `not_found` 来推「对话框也不存在」——那是另一枚 selector、另一趟、另一主键；两趟之间没有可传递的存在性结论（批次清单 §3①「摘录与主键必须同一趟」的同一条纪律在面与面之间同样成立）。
- 若要翻案：同 A12——属批次内容变更，需重新点头，本席不自扩。
