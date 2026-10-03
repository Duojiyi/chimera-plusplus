# Chimera++ 四上游全域差距审计：主审合并报告

日期：2026-10-03（Asia/Shanghai）。对象：当前工作树，不是仅已提交版本。本轮只审计，没有修复产品代码。

## 1. 结论先行

**用户对 Claude Desktop 的判断基本正确：当前主界面无法管理它。但准确原因不是完全没实现，而是专用后端与旧组件保留，新主壳没有接入。** 不能用 Claude Code 页面代替 Desktop，也不能把配置文件存在当成已安装。

整体问题分为两类：一是新版主壳裁掉了已有能力的操作入口；二是多工具写入、回滚与生命周期执行的后端仍有一致性风险。补菜单不能解决第二类问题，应先保障不误删、不跨工具意外启用、不错误执行安装目标。

- 注册表有 10 种工具，但可达的供应商/条目管理页只有 Codex、Claude Code、Gemini、OpenCode、Pi 共 5 种。这只是该页面覆盖率，**不是项目完成度 50%**。
- 七种 CLI 的检测、安装、升级入口已经接通；不能继续沿用“完全没有安装检测”的旧结论。Desktop、Pi、MiniMax Code 尚无对应安装管理。
- Skills 已有七目标，MCP 有六目标；已经不是 Codex-only。真正缺的是部分工具支持、已有资源纳管、仓库管理、更新/恢复闭环，以及多工具状态隔离。
- 源码确认四项 P1 风险，另有一项需隔离并发调度验证的 P1 风险候选；没有证据宣称已经发生数据丢失、凭据泄露或 P0 事件。
- 此报告覆盖全部指定功能领域，但不是全部文件逐行认证，更不是后端运行时/E2E 验收。

## 2. 双盲方法、范围与可复核证据

这里的“双盲”是工程上的独立盲审：A 看上游能力与产品覆盖，B 看当前端到端正确性；第一轮禁止读取历史审计及对方结论，独立出报告后才交叉复核。两者知道仓库身份，不是匿名实验或独立模型统计评测。主审另做 Desktop 专项、入口扫描和最新上游增量复核。

第一轮报告封存 SHA-256：

- A：`CA6742A7F5D7ECDAF6430B804FDC81A228B1727CFCBB4DD37CA3D8ABF8D47980`
- B：`3A503868FB18227A677AA3DB7E3EA6CB1C2D5D5A584231B1469EDFCD5D45E95F`

详细触发条件、当前/上游源码锚点、最小修复和建议回归用例见两份原始报告；本报告保留 Axx/Bxx 编号便于追踪，不将重叠项目重复计算。

| 上游              | 独立盲审固定快照                           | 主审联网核对 HEAD                          | 范围                                       |
| ----------------- | ------------------------------------------ | ------------------------------------------ | ------------------------------------------ |
| CC Switch         | `1bc68e293f635a065fa984d4c2ca7604fbd77854` | `bfaaba1679b8e8df6c8673d2b963d204fc1e521e` | 固定快照源码 + 8 个新增提交差异            |
| Codex-X           | `8f018fddd3ee1a68464e4df8765eb370ede0c76f` | 相同                                       | 固定快照源码/文档                          |
| Codex-App-Manager | `99c25522e8cac87b47c9a5d325de24009c58f71f` | 相同                                       | 固定快照源码/文档                          |
| CodexPlusPlus     | `27d50a1a0413b3c445bc95fae081f16b6c7edbf0` | `f55bb64663ba5024ab434017bb6212a0fd9f4bb3` | 只读 README 与 35 个提交的描述，未读其源码 |

远端分别为 `farion1231/cc-switch`、`yynxxxxx/Codex-X`、`Wangnov/Codex-App-Manager`、`BigPizzaV3/CodexPlusPlus`。快照位于 `D:/Desktop/_upstream_audit/snapshots-2026-10-02`。

当前项目 HEAD 为 `6b737c7d0aed7dd69304f40a8aa1ef35ddc9fb84`；开始时已有 231 项 dirty 条目，全部作为现状审查，未恢复或覆盖。行号是本轮工作树锚点，后续修改可能漂移。

## 3. Claude Desktop 专项

### 3.1 支持到哪一步

| 能力                       | 当前状态                                 | 证据                                                                                                                                     |
| -------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 工具身份/配置路径          | 已登记，不等于可操作                     | `src/shared/tool-registry.json:23`                                                                                                       |
| 独立线路页                 | 当前主壳没有入口                         | `src/ChimeraApp.tsx:222`、`src/ChimeraApp.tsx:2246`、`src/ChimeraApp.tsx:2581`                                                           |
| Desktop 专用表单与状态提示 | 旧组件存在，但脱离当前挂载链             | `src/components/providers/forms/ClaudeDesktopProviderForm.tsx:1`、`src/components/providers/ProviderList.tsx:195`                        |
| 3P 配置写入与快照          | 后端存在，Windows/macOS 分支；未真机验证 | `src-tauri/src/claude_desktop_config.rs:148`、`src-tauri/src/claude_desktop_config.rs:165`、`src-tauri/src/claude_desktop_config.rs:982` |
| 状态/导入/官方配置         | IPC 和前端 API 均保留                    | `src-tauri/src/commands/provider.rs:1348`、`src-tauri/src/commands/provider.rs:1363`、`src/lib/api/providers.ts:144`                     |
| 专用协议路由               | 后端存在，不应误报为完全没有代理支持     | `src-tauri/src/proxy/server.rs:347`、`src-tauri/src/proxy/server.rs:351`                                                                 |
| 已安装/版本/可执行文件检测 | 现有 DesktopStatus 不能证明这些          | `src-tauri/src/claude_desktop_config.rs:118`、`src-tauri/src/claude_desktop_config.rs:199`                                               |
| Desktop 安装/升级/重启管理 | 未发现对应可用链路                       | CLI 七目标列表不包含 Desktop；不把 Claude Code 安装算作 Desktop 安装                                                                     |
| Linux 3P 配置              | 后端明确不支持                           | `src-tauri/src/claude_desktop_config.rs:1274`                                                                                            |

`supported` 是平台支持判断，`configured` 是 profile/metadata 存在判断，不是本机安装状态。把它们直接显示成“Claude Desktop 已安装”会产生新的误导。注册表的 `proxy:false` 是产品接管策略，不能据此否定已经存在的专用路由。

### 3.2 Desktop、Code 和 MCP/Skills 不能混为一谈

CC Switch 固定快照 `src/App.tsx:183` 把 Desktop 的共享资源目标映射到 `claude`。这证明其 Desktop 页面可展示共享 Claude Code 资源，**不证明独立 Desktop 3P 配置支持原生 MCP/扩展安装**。其 Desktop 文档 `docs/user-manual/zh/2-providers/2.6-claude-desktop.md:25` 也保留 3P 不走 MCP/Skills 同步的范围说明。

当前 `src-tauri/src/services/mcp.rs:365` 的投影明确跳过 ClaudeDesktop。后续 UI 必须分别标注：Desktop 3P 线路、共享 Claude Code 资源、Desktop 原生扩展/MCP。最后一项需单独定义与验证，不能通过把 appId 改成 claude 假装完成。

### 3.3 最小正确修复范围（M01，P2）

复用现有 Desktop 表单、状态 API、专用 provider apply、路由开关，接入主壳和能力守卫；增加真正的安装探测及明确“不支持安装管理”状态。Desktop 安装器属于额外产品能力，不应谎称只是恢复旧菜单。

不能只给 `ToolView` 加一个字符串入口：`src/utils/toolProviderConfig.ts:4` 仅支持四个非 Codex 工具，未知工具存在回退到 Claude Code 的路径。验收须证明 Desktop 操作进入专用 apply，而不是修改 Code settings；还应检查继承的 `CC Switch` profile 名/ID 在两应用并存时的所有权与恢复策略。

## 4. 十工具前后端矩阵

“已接”均为源码链路存在，不等于本轮已经执行真实安装、切换或写入。

| 工具           | 当前供应商/条目页  | 检测/安装升级                  | Skills     | MCP                      | 主要缺口                           |
| -------------- | ------------------ | ------------------------------ | ---------- | ------------------------ | ---------------------------------- |
| Codex          | 已接               | CLI 已接；桌面维护另有专用模块 | 已接       | 已接                     | 故障转移管理、完整恢复、资源一致性 |
| Claude Code    | 已接               | CLI 已接                       | 已接       | 已接                     | 非 Codex 提示词入口、显示偏好      |
| Claude Desktop | 未接；专用后端保留 | 无专用管理；状态不等于安装     | 无独立目标 | 无原生受管投影           | M01 专项                           |
| Gemini CLI     | 已接               | CLI 已接                       | 已接       | 已接                     | 显示偏好、提示词入口               |
| Grok Build     | 未接；后端保留     | grok CLI 已接                  | 已接       | 已接                     | 安装后仍无线路页                   |
| OpenCode       | 已接；增量条目语义 | CLI 已接                       | 已接       | 已接                     | 资源生命周期、提示词入口           |
| OpenClaw       | 未接；后端保留     | CLI 已接                       | 已接       | 当前明确不管理           | 专用配置/模型/Agent 入口           |
| Hermes         | 未接；后端保留     | CLI 已接                       | 已接       | 已接                     | 专用配置/记忆/仪表盘入口           |
| Pi             | 已接；增量条目语义 | 暂无安装管理                   | 当前未管理 | 原生不支持，不计产品漏接 | Skills/提示词等覆盖差距            |
| MiniMax Code   | 未接；后端保留     | 暂无安装管理                   | 当前未管理 | 当前未管理               | 专用配置及资源适配                 |

资源目标以 `src/views/SkillsMcpView.tsx:30` 和后端支持范围为准。上游支持某工具不代表此项目只加一个下拉选项就能正确写入。

## 5. 优先阻断的后端风险

以下均为源码控制流确认，尚未进行隔离故障注入；并发项的具体调度窗口尚未运行复现。P1 表示优先修复，不表示已观察到用户损失。

| 编号 | 级别           | 触发与影响                                                                                     | 当前证据                                                                                                     | 最小修复/验收方向                                                             |
| ---- | -------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| B01  | P1             | 一次 MCP 修改会重投影目标工具全部记录；未为该工具启用的同名记录可能删除外来 MCP                | `src-tauri/src/services/mcp.rs:390`；`src-tauri/src/mcp/claude.rs:137`；`src-tauri/src/mcp/gemini.rs:132`    | 删除需所有权与内容 CAS；外来同 ID 不可删；临时配置逐字节回归                  |
| B02  | P1             | Codex-only MCP 软关闭后，在另一工具启用会删共享 enabled=false，重新启用 Codex                  | `src-tauri/src/services/mcp.rs:144`、`src-tauri/src/services/mcp.rs:721`                                     | 各工具启用意图分离；Codex 关闭→Gemini 开启后仍须保持 Codex 关闭               |
| B03  | P1             | 新建多目标 MCP 某目标失败，回滚删除 DB 行却未撤销已写入的新增 live ID                          | `src-tauri/src/services/mcp.rs:19`、`src-tauri/src/services/mcp.rs:201`、`src-tauri/src/services/mcp.rs:214` | 记录成功写集合与原态，逆序 CAS 撤销；不能只从恢复后的 DB 重投影               |
| B04  | P1 风险候选    | MCP 缺操作级锁/版本条件；同记录并发失败回滚可能覆盖另一笔成功更新；实际调度待验证              | `src-tauri/src/commands/mcp.rs:172`、`src-tauri/src/services/mcp.rs:207`                                     | 后端串行化与条件回滚；provider 重投影属于另一个 live 竞态，不混作同一覆盖证明 |
| B05  | P1             | 同进程同类 CLI 操作共用 label+PID BAT 路径，并发时可串脚本或提前删除                           | `src-tauri/src/commands/misc.rs:189`、`src-tauri/src/commands/misc.rs:240`                                   | 每请求独立临时目录；同工具作业互斥；假执行器验证，不运行真实安装              |
| B06  | P2，潜伏 IPC   | Skill 更新仅匹配目录 basename，同仓库同名 Skill 可选错来源                                     | `src-tauri/src/services/skill.rs:1258`、`src-tauri/src/services/skill.rs:1374`                               | 保留并匹配原仓库相对路径；歧义拒绝；当前更新 UI 未开放                        |
| B07  | P2，非 Windows | GUI 安装执行器未合并登录 shell PATH，可能检测得到但升级找不到依赖                              | `src-tauri/src/commands/misc.rs:221`                                                                         | 复用探测环境/绝对路径，验证受限 GUI PATH；不算当前 Windows 已复现故障         |
| B08  | P2             | Skill 投影先变更文件，再写 DB；DB 失败导致 UI 状态与实际加载不一致                             | `src-tauri/src/services/skill.rs:1836`                                                                       | 安全补偿或明确部分完成；临时 DB 拒写分别测 enable/disable                     |
| B09  | P2             | 删除官方账户先删 Vault，解绑 provider 的 DB 错误被吞，仍返回成功                               | `src-tauri/src/commands/official_accounts.rs:158`、`src-tauri/src/commands/official_accounts.rs:163`         | 不吞错误；可恢复删除意图/解绑事务；前端支持部分完成                           |
| B10  | P2，潜伏 IPC   | MCP 导入同 ID 不比配置就合并；Claude/Gemini 后续同步可覆盖原定义，Codex 所有权保护可能阻止覆盖 | `src-tauri/src/services/mcp.rs:636`                                                                          | 比较规范化 spec，冲突显式确认或命名空间；启动导入已禁用，非每次启动触发       |

B01/B08/B10 等存在继承上游问题，不能假设照搬上游就会消失。B05 的独立临时目录、B06 的原路径优先选择在固定 CC 快照已有可借鉴实现。B03 不同于已处理的普通删除路径，不能因 delete_server 显式删除 ID 就认为新增失败回滚也正确。

## 6. 前端接线与功能覆盖缺口

| 编号    | 主审分级                   | 缺口/边界                                                                                     | 当前证据                                                                                                    |
| ------- | -------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| A01/B11 | P2，合并                   | Grok Build/OpenClaw/Hermes/MiniMax Code 缺线路页；Desktop 归 M01                              | `src/ChimeraApp.tsx:2581`                                                                                   |
| A02     | P2                         | visibleApps 仅展示不可编辑；导航不消费偏好，与后台策略不一致                                  | `src/components/settings/ToolRegistryPanel.tsx:124`、`src-tauri/src/product_policy.rs:252`                  |
| A03     | 覆盖差距，开放后按 P2 验收 | 自动故障转移队列/阈值后端有，当前无管理入口；不否定已有自动协议路由                           | `src/components/settings/ProxyTabContent.tsx:198`、`src-tauri/src/lib.rs:1907`                              |
| A04     | P2                         | 仅开放 Codex Live 恢复；应用 DB 和其他工具 Live 恢复入口缺失；不保证 auth.json 备份           | `src/components/LiveBackupsPanel.tsx:110`、`src/views/NewSettingsView.tsx:23`                               |
| A05     | P2                         | 会话导出 capability 宣布开放，但真实会话页未实现导出                                          | `src/components/sessions/SessionManagerPage.tsx:188`、`src-tauri/src/product_policy.rs:115`                 |
| A06     | P2                         | 资源多目标已接，但仓库管理、扫描纳管、更新与恢复入口未闭环                                    | `src/views/SkillsMcpView.tsx:680`、`src/lib/api/skills.ts:155`                                              |
| A07     | P2                         | 深链导入刷新旧 Query 缓存，新工具/资源/提示词页用局部状态，成功后列表不自动更新               | `src/components/DeepLinkImportDialog.tsx:156`、`src/views/ToolView.tsx:154`、`src/views/PromptsView.tsx:68` |
| A08     | P3，覆盖差距               | 提示词页固定 Codex；非 Codex 后端仍有支持，但 Pi/MiniMax 不是只缺 UI                          | `src/views/PromptsView.tsx:56`、`src-tauri/src/prompt_files.rs:12`                                          |
| A09     | 覆盖差距，范围待定         | 用量 Token/趋势/CSV 已有；成本、计价和逐请求日志无当前入口，不等于后端没有计算成本            | `src/views/UsageView.tsx:103`、`src-tauri/src/commands/usage.rs:105`                                        |
| A10     | P3，待产品决策             | WebDAV/S3 无当前入口，自动 worker 策略关闭；不能为补齐而默认开启网络同步                      | `src-tauri/src/product_policy.rs:280`、`src/views/NewSettingsView.tsx:23`                                   |
| A11     | 覆盖差距，范围待定         | 全局 HTTP/SOCKS 出站代理的设置/测试入口缺失，不等同于本地协议代理，也不证明系统/环境代理失效  | `src-tauri/src/commands/global_proxy.rs:15`、`src/components/settings/GlobalProxySettings.tsx:12`           |
| A12     | P3                         | English/繁中可保存，但主导航及多个新页硬编码简中                                              | `src/views/NewSettingsView.tsx:146`、`src/views/ToolView.tsx:213`                                           |
| A13     | 覆盖差距，范围待定         | 自定义配置目录/WSL 路径后端保留，新设置页不能配置；不证明旧 override 失效或非默认目录一定写错 | `src/components/settings/DirectorySettings.tsx:29`、`src-tauri/src/settings.rs:711`                         |

A07 的 Codex 线路另有 refreshVersion，不扩大成全部导入都不刷新。A03/A08/A09/A10 要区分上游覆盖差距与当前产品硬性承诺；Codex-first 不意味着必须复制所有高级 UI，但显式承诺的入口不能是空壳。

### 6.1 交叉复核新增：M04，用量总览与模型排行口径不一致（P2）

主审已独立核对公式：`src-tauri/src/services/usage_stats.rs:53` 的真实总量含 fresh input、output、cache creation、cache read；每日/CSV 的 `src/utils/usageMetrics.ts:22` 也包含缓存。但模型聚合 `src-tauri/src/services/usage_stats.rs:1512`、`src-tauri/src/services/usage_stats.rs:1521` 只加 fresh input 与 output，`src/views/UsageView.tsx:679` 却标为“真实词元总量”。

公式推导例（未运行 DB）：一条 TOTAL 语义输入 1000、cache read 800、output 100、cache creation 0 的记录，fresh input 为 200；总览 1100，唯一模型为 300。不同模型缓存占比会影响排行顺序。最小修复是统一缓存口径或明确“不含缓存”；用隔离 DB 对同一记录校验总览/每日/模型/CSV。此项比要求新增成本面板更明确，不应因 A09 收窄而漏掉。

### 6.2 封存后的交叉裁决

| 主题                    | 交叉复核                       | 主审结论                                                                                                 |
| ----------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------- |
| B01/B02/B03/B05/B09     | A 确认成立                     | 保留，均须满足正文触发条件；无事故已发生断言                                                             |
| B04                     | A 收窄                         | 保留 P1 并发风险候选；同记录回滚覆盖与 provider live 竞态分开验证                                        |
| B10                     | A 收窄                         | 保留潜伏冲突合并缺陷；Codex 所有权保护不等于 Claude/Gemini 也安全                                        |
| A01/A02/A05/A07/A12     | B 确认核心事实                 | 保留；深链只影响已挂载相关页，语言仅指暴露选择器后的覆盖不足                                             |
| A04/A06                 | B 收窄                         | 已有 Live 恢复与多目标安装启停不重报；缺 DB 恢复/资源生命周期入口；DB 备份本身也不等于完整应用含凭据恢复 |
| A03/A08/A09/A10/A11/A13 | B 收窄产品必做性               | 入口差距存在，是否本版开放另定；不一律作为发布阻断                                                       |
| 用量缓存口径            | B 交叉阶段新发现，主审核对源码 | 增加 M04，独立于成本功能覆盖差距                                                                         |

未发现足以将首轮入口事实整项驳回为“当前新 UI 已完整接通”的证据。交叉阶段结论不冒充独立盲审原始发现；B 的入口扫描从 App 开始得到 133 模块，主审从 main 开始得到 136，入口不同，二者不能当作冲突或功能完成比例。

## 7. 四上游按领域对照

| 上游              | 主要基准领域                                        | 当前已有的链路                                                | 本轮主要差距                                                                  |
| ----------------- | --------------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| CC Switch         | 十工具、供应商、资源、故障转移、同步与恢复          | 五工具配置、七 CLI 生命周期、七 Skills/六 MCP、代理与备份后端 | M01、A01–A04、A06、A08–A13；多工具资源一致性 B01–B08/B10                      |
| Codex-X           | Codex 管理、显式资源导入、会话、live 文件安全       | Codex 路线、体检/恢复、显式 CC 导入预览、会话查删             | 会话导出 A05、资源纳管 A06；其锁/CAS 可借鉴，但不证明本项目事务已安全         |
| Codex-App-Manager | 桌面安装维护、版本、平台/发布、皮肤                 | Codex 管理、运行期锁/日志、外观、更新与发行门禁               | 真机安装/崩溃恢复/发行产物未验证；Windows 优先导致的平台差异不是全部必修缺陷  |
| CodexPlusPlus     | 文档描述的线路/账户模式、聚合、会话与用量、增强体验 | 官方账户、线路、会话主链与 Token 统计                         | 故障转移、导出、完整数据/资源工作流仍有差距；不依据 README 推断其内部安全实现 |

会话、账户、用量、代理、备份、平台和发行均纳入审阅；不能把没有确认到具体缺陷的领域写成“完全合格”。广告、推广目录属于明确排除；微信、脚本、注入增强等上游扩展未形成逐项产品承诺，本轮不作为必修清单，也不泛称全部永久禁止。

## 8. 最新上游增量：已吸收与未吸收

主审比对 CC 固定快照至联网 HEAD 的 8 个提交，发现不能简单把所有新增提交都算当前欠账：

1. OAuth 客户端身份 0.159.0：当前已更新，见 `src-tauri/src/services/codex_oauth_models.rs:16`，不重报。
2. Codex MCP TOML 的 type/URL-only HTTP/传输字段：当前已有处理和对应源码测试，见 `src-tauri/src/mcp/codex.rs:659`、`src-tauri/src/mcp/codex.rs:707`、`src-tauri/src/mcp/codex.rs:979`；本轮没有运行 Rust 测试。
3. **M02，P2：单工具批量 MCP 投影仍 fail-fast。** 当前跨工具会收集失败，但工具内部在 `src-tauri/src/services/mcp.rs:380` / `src-tauri/src/services/mcp.rs:390` 中首错停止。最新 CC 改为逐服务继续并汇总错误。应区分“修复/批量重投影”的 best-effort 与“用户事务修改”的原子语义，不能为了继续运行破坏回滚。
4. **M03，P2：think/thinking 内联块兼容差距。** 当前 `src-tauri/src/proxy/providers/codex_chat_common.rs:210` 只解析开头的 think；相关流式/非流式转换仍依赖该路径，`src-tauri/src/proxy/providers/transform.rs:515` 有原样文本转换。最新 CC 扩展 inline think/thinking 处理。此项是协议输出兼容风险，不宣称已发生秘密泄露；需流式跨 chunk、普通文字标签、未闭合块和 reasoning/text 分离测试。
5. 最新输出 TPS 修复不能直接变成本项目的“TPS 飙高缺陷”：当前未发现对应输出 TPS 功能。现有首事件延迟也不能当精确首 token 延迟。
6. 赞助/预设调整不是本产品需吸收的功能；非 macOS lint 修改属于工程维护，不单列用户缺陷。

CPP 35 个提交仅审描述和最新 README。**没有做其源码差异认证**，也不以不同 engine pin 直接证明引擎缺陷。清洁室边界保持不变。

## 9. 验证结果与未覆盖风险

- AST 入口扫描：364 个非测试 TS/JS 模块，136 个保守可达模块；353 个注册 Tauri 命令；351 个字面量 invoke 调用点，保守可达模块含 301 种唯一调用字面量；未发现未注册的字面量 IPC（排除 plugin 命令）。这不覆盖动态/别名调用，也不证明参数及语义正确。
- 导入图是可达性上界；API barrel 被引用不代表其全部函数都有 UI。旧 AppSwitcher、ProviderList、Desktop 表单/路由开关、统一资源面板等不在当前入口闭包，支持“迁移后入口断开”的判断。
- 本轮 7 个相关前端测试文件 **113/113 通过**；A 另报告前端类型检查通过。扫描脚本通过语法/格式检查。此前 1209 项全套测试结果不当作本轮重新运行。
- **未编译 Rust，未跑 cargo build/test/check/clippy、Tauri build/dev。** 未做真实用户目录/DB 故障注入、账户删除、CLI 安装升级、Desktop 配置写入、代理请求或云同步。
- 用户曾反馈窗口不能移动：当前 `src/ChimeraApp.tsx:878` 已有 startDragging handler，`src-tauri/capabilities/default.json:12` 已授权。源码存在不能证明用户正在看的二进制已包含修改，也不能证明实际拖拽成功。本轮没有重新编译或做原生窗口验收，保持待验证，不宣布修复。
- 发行 workflow、签名门禁、更新端点配置不等于当前安装包签名/下载/升级都已实测；外观、可访问性、小窗口/缩放、后台恢复与多进程竞争尚需专项运行验收。

## 10. 修复顺序与验收门槛

1. **先防误写（B01–B05）**：外来配置所有权、各工具启用意图、可逆写集合、后端锁、独立安装脚本。隔离 HOME/DB + 假执行器 + 故障注入/barrier，禁止拿真实账户试错。
2. **再补用户当下受阻的入口（M01、A01/A02）**：Desktop 与其余四工具，真实安装状态，显式启用和清晰的不支持提示；复用已有表单/API，不另造一套框架。每工具测试“导航→表单→正确 appId→正确服务”。
3. **补工作流闭环（A04–A07、B06/B08/B09/B10、M04）**：恢复、纳管、仓库、导出、通知刷新、用量口径；潜伏有风险 API 在开放 UI 前修好。路径/代理 A11/A13 按本版开放范围补小表单。
4. **按产品决策补高级能力（A03/A08/A09/A10/A12、M02/M03）**：故障转移、非 Codex 提示词、成本、语言、可选同步与协议兼容，不为了功能数量默认打开有副作用的后台任务。
5. **最后才声明可发布**：经明确许可做隔离后端编译/测试；再确认启动最新构建、真机拖动窗口、Desktop MSIX/普通安装两类路径、错误/离线状态和升级恢复。前端测试通过不足以替代这些验收。

## 11. 文件索引

- `docs/audits/2026-10-03-upstream-gap-blind-A.md`：独立上游/产品覆盖审计，13 项原始发现及十工具/全域矩阵。
- `docs/audits/2026-10-03-upstream-gap-blind-B.md`：独立端到端正确性审计，11 项原始发现及最小回归方案。
- `docs/audits/2026-10-03-upstream-gap-cross-A.md`、`docs/audits/2026-10-03-upstream-gap-cross-B.md`：封存后交叉复核，第一轮文件不修改。
- `docs/audits/evidence/2026-10-03-upstream-gap/baselines.json`：基线与边界。
- `docs/audits/evidence/2026-10-03-upstream-gap/inventory.mjs`、`docs/audits/evidence/2026-10-03-upstream-gap/inventory.json`：可复跑静态扫描及结果。
- `docs/audits/evidence/2026-10-03-upstream-gap/targeted-tests.log`：本轮前端测试日志。
