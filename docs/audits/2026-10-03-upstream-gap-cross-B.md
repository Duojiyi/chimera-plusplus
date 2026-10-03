# 交叉复核 B：对独立盲审 A 的逐项裁决

日期：2026-10-03，Asia/Shanghai。复核对象：`docs/audits/2026-10-03-upstream-gap-blind-A.md` 的 A01–A13，以及读取时的当前产品工作树。本轮经用户授权读取 A，不再属于首轮盲审；首轮 A/B 报告均未修改。

## 方法与边界

- 复核当前 `App → ChimeraApp → 新视图 → IPC/服务`，而不是据旧组件名称判断能力缺失。以 `PRODUCT.md` 为范围依据。
- 使用内存 TypeScript AST 脚本只读遍历 `src/App.tsx` 的静态 import/export 与字面量动态 import，确认 **133 个可达源码模块**。当前可达：NewSettingsView、ToolRegistryPanel、AboutSection、SkillsMcpView、PromptsView、LiveBackupsPanel、SessionManagerPage；不可达：SettingsPage、BackupListSection、DirectorySettings、WebdavSyncSection、GlobalProxySettings、FailoverQueueManager、UnifiedSkillsPanel、AppVisibilitySettings。再检查实际 JSX/API 调用，未把 import 闭包等同于所有按钮运行可见。
- 未运行 Rust、前端业务测试或真实 IPC；未读取/修改真实用户配置，未安装升级、停止调试进程。聚合计算的数值例子为源码公式推导，不是运行测试结果。本轮没有重跑 A 的类型检查，也不继承其“通过”作为自己的验证结果。
- 仍沿用首轮固定上游快照范围，不追最新增量。本轮主要核当前实现；A 中的上游引用不自动升级为本轮独立核验结论。未读取 CPP 源码。
- 唯一新增文件为本文。以下共 **8 项结论**，合并相关主题，但逐一标记 A01–A13 的裁决。**成立**指当前源码支持原发现；**收窄**指保留事实但限制影响、产品承诺或严重度；没有证据把任何一项入口事实整项驳回为“已被新 UI 全部修复”。

## 1. 多工具线路与显示偏好：A01、A02 成立

**裁决：A01 成立（P2）；A02 成立（P2）。不涉及重报七 CLI 安装管理缺失。**

- 当前主壳 `src/ChimeraApp.tsx:2245` 只列 Claude Code、Gemini、OpenCode、Pi 四种其他工具；`:2581` 起也只挂载对应四个 ToolView。`src/utils/toolProviderConfig.ts:4` 的可编辑工具类型与之相符。GrokBuild、OpenClaw、Hermes、MiniMax Code 线路管理尚未因七 CLI 卡片接入而获得路由。
- 新 UI **已接入**生命周期：`src/components/settings/ToolRegistryPanel.tsx:80` 挂载 AboutSection，后者 `src/components/settings/AboutSection.tsx:633` 调用安装/更新。应保留 A 对“安装”和“配置”的区分，不能将前者缺失作为问题。
- “添加工具”只跳设置（`src/ChimeraApp.tsx:2277`）；`src/components/settings/ToolRegistryPanel.tsx:124` 读取 visibleApps 显示文字，不提供修改开关。主导航 gate 由 `src/lib/productCapabilities.ts:28`、`:39` 检查能力，未消费 visibleApps；后台 `src-tauri/src/product_policy.rs:252` 则同时使用用户偏好。这是前后台状态语义不一致，而不只是缺一个菜单。
- **产品范围：** `PRODUCT.md:37` 要求明确启用流程，`:42` 要求启用工具有其 provider/entry 页面。此处有直接产品依据。Claude Desktop 仅维持“注册表存在、主壳线路不可达”的高层标记，专项仍交主审。
- **收敛动作/验证：** 按注册表和明确支持状态生成路线，未实现页面明确标示“仅安装管理”；模拟工具启用前后检查导航、托盘/后台偏好一致，确认前不得自动导入凭据。无需重做七 CLI 执行器。

## 2. 深链刷新：A07 成立，但严格限定在已挂载的新页面

**裁决：成立（P2），不是“导入未落盘”或“全部 provider 导入都不刷新”。**

- `src/components/DeepLinkImportDialog.tsx:156` 导入成功后，provider 在 `:201` invalidate Query；MCP 在 `:172` invalidate/refetch；Skill 在 `:227` invalidate/refetch；prompt 在 `:212` 发 `prompt-imported`。
- 新页面的数据所有者却不同：`src/views/ToolView.tsx:108` 自己调用 getAll/getCurrent，`:154` 只订阅 `chimera-provider-mutated`；`src/views/SkillsMcpView.tsx:70` 自己 reload，`:93` 在挂载时加载；`src/views/PromptsView.tsx:47` 自己 load，`:68` 在挂载时加载，没有 `prompt-imported` 订阅。无订阅者的 Query 刷新不会更新这些 useState。
- **已修/不适用部分：** `src/App.tsx:90` 对 Codex provider 递增 refreshVersion；`src/ChimeraApp.tsx:984` 消费该版本，Codex 线路不属于此缺陷。切换路由重新挂载相关页面也会重新读取，不是永远不可见。
- **明确触发：** 已停留在非 Codex 工具线路页或资源/提示词页，再接受相应深链；成功后页面可能保留旧列表。直接从设置发起、随后首次进入目的页，不一定复现。
- **产品范围：** 显式深链确认已是当前功能，结果可见性属于其完整工作流，不需要另行追平上游授权。
- **最小修复/验证：** 统一发成功资源变更通知或共享刷新版本，按 app/resource 定向刷新；mock 导入 IPC，在已挂载页面完成确认后断言新记录出现，同时断言缓存/ack 失败不会重复导入。仅需刷新接线，不建议为本项重构整个状态库。

## 3. 恢复能力：A04 收窄为数据库与其他工具入口缺口

**裁决：收窄。入口事实成立；“完整应用数据恢复”不能与恢复 SQLite 画等号。**

- 新设置已挂载恢复面板：`src/views/NewSettingsView.tsx:408` → `src/components/LiveBackupsPanel.tsx:110` 创建、`:217` 恢复，目标固定 `codex`。不是“备份/恢复功能没接新 UI”。
- `src/components/LiveBackupsPanel.tsx:123` 明确不备份/恢复 auth.json；`:201` 的确认语句明确恢复备份中配置文件、保留当前可读取模型。后端 `src-tauri/src/services/live_backup.rs:451` 有工具/允许路径校验、switch 锁、恢复前备份和提示词库对账。不能从其他入口缺失推断该闭环已经损坏。
- DB 备份命令确实保留于 `src-tauri/src/commands/import_export.rs:169`、`:193`，但承载 BackupListSection 的旧设置未接主壳。其他工具 live 备份 API 有 app 参数，而当前面板无工具选择。A 对这两项的静态定位成立。
- **产品范围：** `PRODUCT.md:44` 明确本地备份/恢复，但没有承诺目录全量快照、账号凭据迁移或所有资源二进制的统一恢复。SQLite 中有供应商/资源元数据，不代表 SSOT Skill 文件、外部配置与独立 Vault 凭据均在数据库备份内。因此应改称“应用数据库备份/恢复入口”，不能声称接回旧面板即可完整恢复应用。
- **保留优先级：** 对已支持工具恢复范围不透明可保留 P2 工作流问题；扩大为跨工具完整灾难恢复属于待定义范围。登录凭据不在 Live 备份内是已声明边界，不是本项缺陷。
- **最小修复/验证：** 展示备份类型与覆盖清单，按支持范围选择工具；临时配置/DB 中分别验证 live 恢复、DB 恢复和不覆盖的资源，不能用其中一种成功替代其余恢复验收。

## 4. 资源功能：A06 部分成立；A08 收窄为上游差距

**裁决：A06 的悬空仓库指引成立（P2）；其余生命周期入口保留为分项覆盖缺口。A08 收窄，不作为当前 Codex-first 违约。**

- 新页已接 **七目标 Skills、六目标 MCP**：`src/views/SkillsMcpView.tsx:30` 的目标列表、`:143`/`:150` 的启停、`:680` ZIP 安装、`:707` 仓库安装；MCP 编辑/删除也有链路。任何“只有 Codex 资源/所有资源功能未接”的概括均应驳回；A 原文没有这样概括。
- `src/views/SkillsMcpView.tsx:690` 调 discoverAvailable，`:695` 写“复用设置中的仓库来源”，但当前设置闭包没有 repo 管理组件，也未调用 add/remove_skill_repo。该悬空指引是已展示功能自身的缺口，不只是上游功能更多。
- 本地扫描纳管、Skill 更新/备份恢复、MCP 导入仍有 API/注册命令（如 `src/lib/api/skills.ts:185`、`:190`、`src/lib/api/mcp.ts:126`），新页没有对应调用。启动 `src-tauri/src/product_policy.rs:272` 明确关闭自动初始化；不能因为默认仓库没自动写入而报告启动故障，也不能断言所有用户的发现列表必空。
- A08 所说 `src/views/PromptsView.tsx:56` 固定 Codex 属实；但 `PRODUCT.md:41` 将提示词列在 Codex 下，`:42` 对其他工具的明确承诺是 provider/entry 页面，不是所有指令/记忆管理。后端接收 app 不等于产品必须暴露每个 app。
- **最小修复/验证：** 优先补仓库编辑入口或修正“设置中配置来源”的指引；扫描/更新/恢复逐项决定开放范围，而非一次恢复整个旧资源后台。mock 空仓库、已有仓库和更新能力，验证用户有真实可执行路径；不扫描真实 HOME。

## 5. 会话导出：A05 成立，消息复制与用量 CSV 不是会话导出

**裁决：成立（P2）；无需为“必须新增 Rust 导出命令”背书。**

- 当前实际页面由 `src/ChimeraApp.tsx:187` 加载 SessionManagerPage；`src/lib/api/sessions.ts:29` 是列表、消息读取、删除等接口。页面没有会话 Markdown/文件导出流程。
- `src/components/sessions/SessionManagerPage.tsx:405` 有 clipboard 写入，`:419` 是消息内容复制。复制消息/恢复命令不等同于保存完整会话。`src/views/UsageView.tsx:246` 的 CSV 导出属于统计，也不补足会话导出。
- `src-tauri/src/product_policy.rs:46`、`:102` 暴露 SessionExport/session_export，`:115` 统一 enabled=true，但当前调用链没有与之匹配的导出功能。无 export IPC 本身不构成缺陷——前端读取消息生成文件也可实现；缺陷是当前两条实现路径都没接通。
- **产品范围：** `PRODUCT.md:43` 写“export where supported”。结合能力已宣告 enabled，而非纯上游功能差异，可以保留 A 的 P2。若暂不支持，应准确返回/显示不支持，不能用 capability=true 宣布完成。
- **最小修复/验证：** 复用消息读取做最小 Markdown 导出，或关闭未兑现能力标记。mock 会话消息验证输出顺序、完整性、空会话和导出失败；不把旧稿 toast 或复制按钮计作通过。

## 6. 用量：A09 收窄；另确认缓存词元导致总览与模型排行口径不一致

**裁决：A09 的成本/定价/逐请求入口事实成立，但收窄为未承诺的分析深度差距；本轮查到的聚合口径不一致可作为更具体 P2。**

- **已有闭环：** `src/views/UsageView.tsx:103` 调 Codex summary/trends/models；`:156` 启动本机会话同步，`:130` 起在确有导入后重新加载；`:212` 支持重建；`:246` 导出 CSV。不是只有静态 Token 卡片，也不是没有聚合。
- **聚合确实存在：** `src-tauri/src/services/usage_stats.rs:621` 的 summary 合并明细与日 rollup；`:702` 使用 fresh_input_sql；`:716`、`:725` 同时聚合 cost。`:297`、`:385` 有跨来源身份与去重处理。不能从界面未显示金额推断成本未计算，也不能只看到两类数据源就断言重复计数。
- **A09 需收窄的产品判断：** `PRODUCT.md:41` 承诺 Codex“用量”，没有明确列出价格管理、完整账单或请求日志分析。现有 Token/趋势/排行/CSV 已满足一部分真实用量流程。成本、定价、详情缺 UI 可记录，不宜不加范围条件就作为必须补齐的 P2；多工具用量也不是 Codex-first 的必然缺陷。
- **新发现的明确口径差异：** 总览用 `src/views/UsageView.tsx:234` 的 realTotalTokens，后端 `src-tauri/src/services/usage_stats.rs:53` = fresh input + output + cache creation + cache read；每日/CSV 经 `src/utils/usageMetrics.ts:22` 也含缓存。但模型聚合 `src-tauri/src/services/usage_stats.rs:1512`、`:1521` 只计算 fresh input + output；UI `src/views/UsageView.tsx:620` 显示该数，`:679` 却称“真实词元总量”。这不是成本显示问题，而是相同用量页中的总量语义不一致。
- **确定性触发例：** 一条 Codex 记录，input_token_semantics=TOTAL、input=1000、cache_read=800、output=100、cache_creation=0。fresh_input_sql 得 200；总览为 1100，唯一模型排行为 300。不同模型缓存比例不同时，按当前值排序还可能不同于“真实总量”排行。此例由公式推导，未创建数据库执行。
- **来源边界亦应说明：** `src/views/UsageView.tsx:275` 附近文案“只统计本机会话记录”，而 summary 查询只按 app/date 等过滤，effective_usage_log_filter 会保留符合条件的 proxy 行并消除对应 session 重复。这里只确认文案不能证明 session-only，不据此再断言金额错误或重复计费。
- **最小修复/验证：** 先统一模型排行与总览的缓存口径，或明确标成“不含缓存词元”；在临时 DB 注入上述单记录以及缓存比例不同的双模型，断言总览、每日、模型和 CSV 的已声明口径一致。成本/定价 UI 另作产品决策。

## 7. 高级网络/路径/云功能：A03、A10、A11、A13 的入口事实保留，产品必做性分开

**裁决：A03 收窄；A10 成立为已注明的上游差距；A11 收窄；A13 收窄。没有证据称这些入口已由新设置页补齐。**

| A 项 | 当前核实 | 范围与级别裁决 |
| --- | --- | --- |
| A03 故障转移队列 | FailoverQueueManager 不在 App 闭包；当前线路切换 `src-tauri/src/commands/provider.rs:921` 的自动路由不等于用户可管理 failover 队列 | 收窄为缺可管理入口，不宣称转发/熔断失效。PRODUCT 没明确要求队列/熔断参数 UI；P2 应以本版决定开放或支持导入既有 failover 状态为前提，否则保留覆盖差距 |
| A10 WebDAV/S3 | WebdavSyncSection 不在主壳；`src-tauri/src/product_policy.rs:280` start_cloud_sync_workers=false | A 已注明 PRODUCT 不要求首发，此限定成立。不能把所有 capability=true 解读为已承诺自动启动网络任务。未接入是事实，不建议为了追平而默认启云同步 |
| A11 全局出站代理 | GlobalProxySettings 不可达；`src-tauri/src/commands/global_proxy.rs:15`、`:35` 的读写命令存在，当前新页没有等价表单 | 收窄为应用内显式代理配置缺入口；本地协议代理不是替代，但也不能据此断言所有代理网络用户必然无法联网。未验证系统代理/环境变量/继承旧设置的效果；产品未明确要求所有出站协议配置面板 |
| A13 配置目录/WSL | DirectorySettings 不可达，`src-tauri/src/commands/settings.rs:103` 的 PreferencesPatch 不含路径；ToolRegistryPanel 只展示默认位置 | 收窄为 UI 无法编辑 override，不是“WSL 后端不支持/非默认路径一定写错”。当前 Codex runtime 的安装目录/便携目录控制是另一领域，不能充当 CLI 配置路径编辑，也不能被本项否认 |

- **产品依据：** PRODUCT 的工具管理、明确启用与安全可逆工作流应优先；不能从保留旧后端/设置字段，推导本版必须恢复全部高级页。也不能将未明确承诺误写成“产品明确排除”：除云 worker 的默认关闭外，这些仍需产品决策，而非永久禁用结论。
- **最小动作/验证：** 先标清本版支持范围及已有设置是否仍生效；对决定开放的选项接复用的小表单，并 mock 验证“保存前显示目标、不自动改系统、不自动扫描/迁移配置”。本轮不建议将这四项一律作为发布阻断。

## 8. 语言：A12 成立，限于已暴露语言选择的主界面覆盖

**裁决：成立（P3），不是要求追平上游语言数量。**

- `src/views/NewSettingsView.tsx:466` 附近当前选择器实际还包含日本語，除简中/繁中/English 外。`src/views/NewSettingsView.tsx:146` 的持久化/语言切换链已接通，不是设置保存失败。
- `src/ChimeraApp.tsx:2241`、`:2246` 导航文字、`src/views/SkillsMcpView.tsx:695` 仓库指引等仍为简中字面量；切换 i18n 不能翻译字面量。新 UI 的部分设置文字已用 t，并不能证明全部主要页面已本地化。
- **产品范围：** `PRODUCT.md:63` 中文优先允许限制语言数量；但既然暴露其他语言选择，应注明翻译覆盖范围或补核心动作/报错。不能据现状要求复制 CAM 全部语言，也不应宣称主界面所有文字都没有翻译。
- **最小修复/验证：** 先覆盖导航/关键动作/失败反馈，未覆盖处明确 fallback；在内存 i18n/mock preferences 中逐语言检查可达页，不修改真实偏好。本轮未做视觉或交互验证。

## 复核结果索引（对应上述 8 项，不新增结论）

| 首轮编号 | 裁决 | 交叉结论 |
| --- | --- | --- |
| A01 | 成立 | 1：缺的是四工具线路路由，不是七 CLI 安装 |
| A02 | 成立 | 1：导航/显示偏好/后台启用状态未统一 |
| A03 | 收窄 | 7：缺 failover 配置入口，是否本版必做另定 |
| A04 | 收窄 | 3：Live 已接；DB 备份不等于完整应用恢复 |
| A05 | 成立 | 5：会话导出未闭环，复制/统计 CSV 不替代 |
| A06 | 部分成立并收窄 | 4：仓库指引悬空成立；多目标安装启停已接 |
| A07 | 成立并限定触发 | 2：已挂载资源/非 Codex 页面；Codex provider 刷新已接 |
| A08 | 收窄 | 4：多工具提示词为上游差距，不扩张 PRODUCT |
| A09 | 收窄并补充口径证据 | 6：聚合已实现；真实总量与模型缓存口径不一致更具体 |
| A10 | 成立为覆盖差距 | 7：明确非首发承诺，不推定自动云同步必须开启 |
| A11 | 收窄 | 7：缺显式代理 UI，不断言全网连接失败 |
| A12 | 成立 | 8：已暴露语言选择的翻译覆盖不足 |
| A13 | 收窄 | 7：缺 override 编辑 UI，不断言后端路径能力缺失 |

建议优先验证结论 2 的深链局部状态、结论 6 的缓存聚合口径、结论 1 的显式工具启用/路由，以及结论 5 的导出能力声明。其余按当前产品承诺分阶段处理。本文不替代首轮报告，不修改其证据，也不把任何静态结论升级为运行时/E2E 通过。
