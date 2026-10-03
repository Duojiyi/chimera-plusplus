# 修复闭环独立复核 A

日期：2026-10-03（Asia/Shanghai）

## 结论与边界

本轮针对 A 首报 A01–A05 核验当前工作区实际文件，不以主线程修复说明或测试数字代替证据。A01、A02、A04 在本轮前端组件测试层面闭环；A03、A05 在源码层面确认原失效路径已被修正，Rust 运行验证仍留待独立确认。没有据此作全产品零缺陷声明。

A12/M02：当前上下文没有原始定义，无法可靠给出逐条未达项，本轮不扩展、不推断编号含义。

未阅读 B 首报或 B 复核。首报保持不可变。本轮仅新增本报告，未修改产品代码或测试。未编译 Rust，未执行 cargo test/check/build/clippy 或 Tauri 构建；主线程正在运行的 Rust 测试结果不计入本报告。

代码基线为 HEAD `6b737c7d0aed7dd69304f40a8aa1ef35ddc9fb84` 上的未提交工作区，约 21:22–21:33 的读取与测试；并行工作区不是冻结快照，结论不自动覆盖此后改动。

## A01：延迟打开覆盖未保存草稿

状态：原问题在前端组件范围内闭环。

证据：`src/ChimeraApp.tsx:553` 的 editorOpenSeqRef 生成号，`openToolEditor`（约 794 行）的 ownsOpen 同时检查生成号和 editorRef。openEditor 同步占有 editorRef 并递增生成号；关闭、切换页面、卸载使旧请求失效。成功回包及失败提示均受所有权校验，旧 getAll 不再无条件覆盖新草稿。

`tests/components/ChimeraApp.races.test.tsx:949` 起覆盖延迟旧请求返回时新草稿字段及 dirty baseline 保留、新编辑器关闭后不重新打开、离页再返回、最新请求胜出、过时失败静默、卸载撤销。本轮这些用例通过。

边界：这是 React 组件与 mock API 验证，不是原生客户端人工端到端操作；整文件存在另外两项首次失败，见测试记录。

## A02：刷新后导出旧消息

状态：原问题在前端组件范围内闭环。

证据：`src/components/sessions/SessionManagerPage.tsx:1294` 刷新列表同时对已选会话调用 refetchMessages。handleExport 与导出按钮均保留消息 loading/fetching/error 阻断，不把刷新中的旧缓存当成新结果导出。

`tests/components/SessionManagerPage.test.tsx:266` 的 JSON 导出用例，在原会话路径不变时返回追加消息；延迟消息请求期间断言导出禁用，完成后解析第二次生成的 Blob 并核验新消息，再验证消息错误阻断。本轮整个该测试文件通过。

边界：没有真实会话文件外部追加加原生 IPC 的集成运行；此结论针对手动刷新与当前消息缓存接线，不声称后台自动追踪文件变化。

## A03：提示词数据库先写导致失败后不一致

状态：源码闭环，Rust 运行验证未覆盖。

证据：`src-tauri/src/services/prompt.rs` 非 Codex upsert/enable 使用现有 per-app 锁，先构造 before/next 与 FileSnapshot，再由 `commit_non_codex_prompt_changes`（约 365 行）先提交文件 Changeset，后执行数据库事务。文件失败不提交数据库；数据库失败调用 applied.rollback。数据库提交使用记录数量与各字段 CAS，拒绝旧快照覆盖并发变更。`src-tauri/src/config/cas.rs:433` 回滚只恢复仍匹配本次写入状态的文件，不盲目覆盖后来的外部写入。

测试源码 `prompt.rs:966` 起含生效文件故障保留正文及 enabled、数据库故障回滚文件和所有标志、新建文件回滚为缺失、非活动编辑不改 live、启用回填本地修改、旧文件/数据库快照冲突。已静态阅读，未执行。PromptsView 组件测试本轮通过，但不替代这些后端故障测试。

剩余边界：文件与 SQLite 不是一个持久化事务；进程在两阶段之间崩溃，以及磁盘故障或外部修改使补偿失败，仍不能宣称绝对原子。代码对回滚失败返回明确的文件恢复失败信息。原“文件写失败但 DB 已提前保存”路径已消除；故障注入和平台文件行为仍需 Rust/集成运行确认。

## A04：今日标签及失败后的范围标题不一致

状态：原问题在前端组件范围内闭环。

证据：`src/views/UsageView.tsx:258` 使用 summary 存在时的 loadedRange 计算 displayedRange；标题、范围文案随实际显示数据，按钮 today 的可见文本为“今日”（约 496 行）。切换失败仍可保留用户请求按钮状态，但旧数据标题不伪装成请求范围。

`tests/components/UsageView.test.tsx:273` 验证今日可见按钮、小时图、查询起点为零点、切换 7 天失败后保留“今日”和“近 1 天 · 今日”标题。本轮整个文件通过。

边界：未对真实用量数据库或跨平台时区进行端到端核算。

## A05：更新备份失败仍继续覆盖

状态：源码闭环，Rust 运行验证未覆盖。

证据：`src-tauri/src/services/skill.rs:1478` 在 staging、替换及修改安装投影之前使用 `require_update_backup(...)?`。`require_update_backup`（约 4106 行）对备份错误以及没有可备份目录的 None 都返回错误，并尝试清理下载目录；不会把备份失败降级为日志继续更新。update_skill 入口持有 skill mutation 锁，覆盖下载等待及备份替换阶段。

测试源码 `skill.rs:5230` 的 update_backup_failure_aborts_and_cleans_download_without_touching_source，用普通文件阻断备份根目录，断言 guard 报错、下载目录清理、已安装正文及 DB hash 不变；恢复备份根后验证成功备份。已静态阅读，未执行。SkillsMcpView 前端组件文件本轮通过。

测试不足：该故障测试直接调用备份 guard，不是带仓库下载、投影替换及 DB 更新的完整 update_skill 故障集成测试。强制 guard 在完整函数中的顺序由源码确认；未验证真实权限故障、磁盘耗尽或进程中断恢复。

## 新增 Cloud 与 Desktop 范围

Cloud：已覆盖 `SyncPanel.tsx` 与新增 `SyncConfigForm.tsx` 的前端接线、相应 settings API 调用名称及参数、SyncPanel 测试。表单保存调用对应 WebDAV/S3 保存 API，enabled=true、autoSync=false，以 secretTouched 区分新凭据与留空保留；密码不预填，提交清空 DOM 字段，保存不自动探测或上传。手动上传/下载仍需确认，下载前检查远端兼容性，下载后审核与刷新分开处理，错误不直接回显远端密钥信息。测试涵盖两类新配置保存、不触发远端请求、已存凭据留空保留、失败信息脱敏与重试。本轮 SyncPanel 文件通过。

Cloud 未覆盖：真实 WebDAV/S3 服务、后端凭据保留实现的完整审计、远端传输及数据库恢复事务、操作系统密钥存储与完整 NewSettingsView 端到端流程。因此不是整个云同步后端闭环认证。

Desktop：已覆盖 `ToolViewDesktop.tsx` 当前组件、providers API 名称接线与 ToolView.support 测试；安装路径提示与 3P 配置状态分开，“官方配置入口”不当作已登录，不支持平台禁用写入，文案明确不提供安装/升级/重启管理及 MSIX 未验证。测试覆盖有实际 installationPath 但尚未配置、平台不支持、官方入口通过 seed service 且不切换。ToolView 与 ToolView.support 文件本轮通过。

Desktop 未覆盖：真实可执行文件探测、MSIX、自定义路径、macOS/Linux 实机、Desktop 登录、路由切换与重启、后端完整读写链及状态请求乱序压力测试。仅为新增前端的有限检查，不是 Desktop 全功能验收。

## 本轮测试记录

运行命令：

```powershell
pnpm exec vitest run tests/components/ChimeraApp.races.test.tsx tests/components/SessionManagerPage.test.tsx tests/components/UsageView.test.tsx tests/components/PromptsView.test.tsx tests/components/SkillsMcpView.test.tsx tests/components/SyncPanel.test.tsx tests/components/ToolView.test.tsx tests/components/ToolView.support.test.tsx --maxWorkers=2
```

首轮 21:27:12 开始，118.05 秒：8 文件，7 通过、1 失败；210 项，208 通过、2 失败。失败为 ChimeraApp.races 的 `opens Skills/MCP with the target selected from the claude/gemini page`，停在 openTool 等待 Claude Code/Gemini CLI 一级标题，尚未执行跳转断言。不得把这两项算作首轮通过。

针对性复跑：

```powershell
pnpm exec vitest run tests/components/ChimeraApp.races.test.tsx -t "opens Skills/MCP" --maxWorkers=2
```

21:30:44 开始，19.53 秒：3 通过、46 跳过。两项失败未复现，原因未定，保留为测试稳定性待观察项，不认定为已确认的产品缺陷，也不宣布整套稳定全绿。测试有 Node localStorage experimental warning。

原始日志保存在当前机器 TEMP 下 `chimera-recheck-A.log` 与 `chimera-recheck-A-rerun.log`。本轮没有运行前端全量测试、类型检查或 Rust 编译/测试。

首报 SHA256（复核前）：`17223FFA9A4F7B3F6EA35EAE0F8D40533F3A0A11B3D5BE1E177CDE5114E65A44`。

## 最终前端稳定性补充

本节为后续证据补充，保留上文独立首轮及针对性复跑的历史记录，不将首次失败改写为通过。

已直接核对主线程提供的 `%TEMP%/chimera-repair-frontend-verified.log`：日志命令为 `vitest run "--maxWorkers=2"`，开始时间 21:39:08，耗时 255.60 秒，最终汇总 **158/158 文件通过，1349/1349 测试通过**。这是对主线程运行日志的独立核读，不是 A 再执行一次全量测试。日志仍含 localStorage 实验性警告等输出，不能表述为无警告运行。

已核对 `tests/components/ChimeraApp.races.test.tsx:771` 的 openTool：导航按钮查找、等待 enabled 和点击步骤不变；相较前次读取，标题查找只增加第三参数 `{ timeout: 5000 }` 及 lazy 初载说明，仍要求 `role=heading`、原 label 和 `level: 1`，没有改成宽松查询、固定 sleep 或删除断言。该参数作用于此 helper 的标题等待，并非修改全局超时。原失败相关用例仍点击对应工具的 Skills/MCP 管理按钮，并断言目标工具 appId 和已安装 Skills 页面；A01 的草稿与竞态断言保留。

因此，上文“未能取得整套全绿”的证据状态现由这次最终全量通过更新：**已有调整 lazy 页面等待上限后的完整前端通过记录，先前标题等待失败在最终全套中未复现**。这支持在本次测试条件下收口前端稳定性问题，但不单凭一次通过证明高负载是唯一原因，也不承诺任意负载下绝无超时。A01/A02/A04 的组件范围闭环结论维持。

主线程另提供 typecheck、Vite 构建与 budget、Prettier 均通过的结果；本次未取得并逐项核读这些独立日志，也未重跑，故仅作为主线程补充信息，不列为 A 独立执行通过项。

Rust：主线程告知此前有 6 项失败、已逐项修复且待重跑；本轮没有运行 Rust 或验证这些修复，A03/A05 仍保持“源码修复路径确认，Rust 运行验证待主报告补齐”，不得据前端全绿推定原生通过。

A12：主线程已澄清其为语言覆盖不足，目前未全译，**不可关闭**。此前“缺少定义”的说明是当时边界；本节记录澄清后的未完成状态，未另行扩大翻译审计。M02 的 MCP 修复及 B 复核闭环由主报告记录，本轮未独立重审或阅读 B 复核。

本次仅追加 A 复核报告，未修改产品、测试或 A 首报。A 首报 SHA256 复核仍为 `17223FFA9A4F7B3F6EA35EAE0F8D40533F3A0A11B3D5BE1E177CDE5114E65A44`。至此结束 A 报告，后续原生验证结果归入主报告。
