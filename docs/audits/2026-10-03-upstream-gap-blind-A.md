# Chimera++ 固定上游快照功能缺口审计 — 独立盲审 A

审计日期：2026-10-03。对象：`D:\Desktop\chimera-plusplus` **当前工作树**，不是仅审 HEAD。当前仓库 HEAD 为 `6b737c7d0aed7dd69304f40a8aa1ef35ddc9fb84`，存在大量未提交修改；本文定位到读取时的工作树文件行号。

## 1. 基线、边界与证据等级

固定上游根目录：`D:\Desktop\_upstream_audit\snapshots-2026-10-02`。下文 `CC/`、`CX/`、`CAM/`、`CPP/` 分别指该目录下的四个仓库；无前缀路径指当前 Chimera++ 工作树。四个快照均通过本地只读 `git rev-parse HEAD` 核实：

| 简称 | 快照目录 | 本次核验的固定提交 |
| --- | --- | --- |
| CC | cc-switch | `1bc68e293f635a065fa984d4c2ca7604fbd77854` |
| CX | Codex-X | `8f018fddd3ee1a68464e4df8765eb370ede0c76f` |
| CAM | Codex-App-Manager | `99c25522e8cac87b47c9a5d325de24009c58f71f` |
| CPP | CodexPlusPlus | `27d50a1a0413b3c445bc95fae081f16b6c7edbf0` |

主审补充的范围元数据：CX/CAM 远端 HEAD 与快照相同；CC 远端为 `bfaaba1679b8e8df6c8673d2b963d204fc1e521e`，比快照多 8 个提交；CPP 远端为 `f55bb64663ba5024ab434017bb6212a0fd9f4bb3`，比快照多 35 个提交。**这些最新增量未由 A 核验，交主审补查，本文不声称“最新 HEAD 全量已核验”。**

- 独立完成，未读取任何历史 audit/reviewer/findings 报告，未读取或交换另一审计输出。
- 阅读 `PRODUCT.md` 作为产品范围基准；不把遗留设计稿或旧组件当成当前可达 UI。Claude Desktop 仅做注册表/入口高层核实，专项交主审。
- CPP 只读取 README 功能说明；不读取源码，不引用其源码文件名或函数名。CPP 的功能证据是公开文档声明，不是源码或运行时证明。
- 未修改产品代码，未编译 Rust，未安装/卸载工具，未访问真实配置或凭据，未调用可能写配置的 Tauri 命令，未停止或重启调试服务器。唯一输出文件是本报告。
- 执行 `node node_modules/typescript/bin/tsc --noEmit --incremental false`：**通过，退出码 0**。没有运行 Rust 构建、测试、检查或 Clippy；没有进行桌面端/安装包运行时验证。
- 以 TypeScript AST 只读遍历 `src/App.tsx` 的静态及字面量动态 import 闭包，共 133 个源码模块；结合 JSX 路由确认可达性。`SettingsPage`、`ProxyTabContent`、`AppVisibilitySettings`、`BackupListSection`、`GlobalProxySettings`、`FailoverQueueManager` 不在闭包。`SessionManagerPage`、`NewSettingsView` 在闭包；旧 `views/SessionsView.tsx`、`views/RuntimeView.tsx` 不在闭包。静态闭包不是运行时测试，也不证明闭包内每个分支都一定可见。

状态定义：**已实现**＝当前入口→API→注册命令→服务链可由源码确认，仍不等于真机验证；**部分**＝仅部分子能力闭环；**未接入**＝已有后端/遗留 UI，但当前入口链断开；**有意排除**＝产品明确的非目标或明确限定的平台能力；**未验证**＝本次无法取得足够证据。严重度：P2 为用户工作流缺口/已开放能力断链；P3 为上游差距或较低优先级的能力一致性问题。未发现足以据此断言 P0/P1 数据损坏的证据。

## 2. 十种工具配置矩阵

上游统一基准：`CC/README_ZH.md:317` 的十工具功能表。当前后端工具定义为 `src/shared/tool-registry.json:1`，通过 `src-tauri/src/tool_registry.rs:45` 返回，并在 `src-tauri/src/lib.rs:1644` 注册。当前主导航/工具页分别见 `src/ChimeraApp.tsx:2246`、`src/ChimeraApp.tsx:2581`、`src/views/ToolView.tsx:55`。

| 工具 | 上游配置模式 | 当前可达前端与后端 | 安装维护入口 | 判定 |
| --- | --- | --- | --- | --- |
| Codex | 单当前供应商 | 线路新增/编辑/切换、官方账户、模型目录、诊断、备份均有入口；保存走补偿式激活命令 | CLI 安装/更新卡片及独立 Codex 桌面管理 | 已实现主链；故障转移、完整恢复等见问题表 |
| Claude Code | 单当前供应商 | ToolView 新建/编辑/切换，包括显式切换官方配置；不因渲染自动导入 | 已接 CLI 安装/更新卡片 | 已实现配置主链；显示偏好、提示词等部分 |
| Claude Desktop | 单当前供应商 | 后端注册表列出，无独立主导航工具页 | 设置明确提示暂无安装管理 | 未接入/专项未验证；不进一步深查 |
| Gemini CLI | 单当前供应商 | ToolView 新建/编辑/切换、官方入口 | 已接 CLI 安装/更新卡片 | 已实现配置主链；扩展能力部分 |
| GrokBuild | 单当前供应商 | 后端写入/托盘/代理元数据已存在；主导航无该工具页 | **已接** `grok` CLI 安装/更新卡片 | 配置前端未接入；不能据安装卡片认定配置闭环 |
| OpenCode | 增量条目 | ToolView 编辑、启用/停用；使用 liveConfigManaged 区分状态 | 已接 CLI 安装/更新卡片 | 已实现配置主链 |
| OpenClaw | 增量条目 | 后端供应商写入、模型目录、Agent 默认项、环境/工具命令存在；无主工具页 | **已接** CLI 安装/更新卡片 | 配置前端未接入 |
| Hermes | 增量条目 | 后端供应商、记忆、仪表盘命令存在；无主工具页 | **已接** CLI 安装/更新卡片 | 配置前端未接入 |
| Pi | 增量条目 | ToolView 可编辑/启停，经独立 Pi 服务；默认模型仍在 Pi 选择 | 设置明确提示暂无安装管理 | 配置主链已实现；Skills/提示词/会话等与上游仍有差距 |
| MiniMax Code | 增量条目 | 注册表及专用供应商服务存在，无主工具页；深链明确拒绝 | 设置明确提示暂无安装管理 | 配置前端未接入，非“完全没有后端” |

后端证据：通用写入 `src-tauri/src/services/provider/live.rs:1240`、GrokBuild `:1293`、OpenClaw `:1354`、Hermes `:1396`；Pi/MiniMax 专用分派 `src-tauri/src/services/provider/mod.rs:2420`、`:3028`，专用服务 `src-tauri/src/services/provider/pi.rs:186`、`src-tauri/src/services/provider/mcode.rs:104`。不把通用写入中要求转专用服务的报错误报成 Pi/MiniMax 全面不可用。

七种安装卡片核验：`src/components/settings/ToolRegistryPanel.tsx:80` 挂载 AboutSection，`src/components/settings/AboutSection.tsx:63` 列出 claude/codex/gemini/grok/opencode/openclaw/hermes；后端 `get_tool_versions`、`run_tool_lifecycle_action`、`probe_tool_installations` 已注册于 `src-tauri/src/lib.rs:1942`。**不复述“七种 CLI 卡片没接”的旧缺陷；本次未实际执行安装。**

## 3. 主要功能矩阵（四上游→当前可达能力）

| 领域 | 固定上游能力与证据 | 当前实际能力与证据 | 状态/边界 |
| --- | --- | --- | --- |
| 供应商及协议 | CC 十工具；CX `README.md:233` 检测/切换；CPP `README.md:144`、`:156` 官方/混入/API/聚合 | Codex 和四个 ToolView 可达；Codex 编辑保存携带模型映射、协议及高级元数据，`src/ChimeraApp.tsx:1540`、`:1555`、`:1632` | 部分；其余工具 A01。CPP 聚合的会话/请求/权重轮转未验证为当前等价能力 |
| 模型发现/上下文 | CPP `README.md:145`、`:167` 每模型窗口/catalog；CX `README.md:240` 模型获取和测试 | 获取模型 `src/ChimeraApp.tsx:1797`；每模型窗口 `:5044`；保存后校验目录 `:1661`，重启提示 `:5986` | 已实现发现/目录链；仅地址探测不等同实际推理测试 |
| 模型测试 | CX `README.md:240`；CPP `README.md:144` 模型测试/Doctor | `src/ChimeraApp.tsx:1306` 仅地址延迟；`:5664` 明确不验证 Key/模型。`src-tauri/src/commands/stream_check.rs:1` 也明确仅可达性 | 部分；没有把地址探测误报成真实推理验证，也不把 stream_check 名称误当推理测试后端 |
| 官方账户 | CX `README.md:238` 多个官方登录配置；CPP `README.md:158` 认证边界 | 列表/额度、设备登录轮询、保存当前登录、切换和移除：`src/views/OfficialAccountsView.tsx:153`、`:253`、`:349`、`:384`；API `src/lib/api/officialAccounts.ts:30` | 已实现源码主链；真实 OAuth/令牌刷新/额度网络未验证 |
| Codex 安装维护 | CAM `README.md:64` 检测/规划/更新，`:66` MSIX/便携；CPP `README.md:150` 维护 | 当前真正可达的是内联 NewRuntimeView：`src/ChimeraApp.tsx:2800`，历史版本规划 `:2956`、安装 `:2974`、离线包 `:3007`、`:3023`、修复/回滚/卸载 `:2004` | Windows 主链已实现；实际安装、回滚和进程恢复未验证 |
| 提示词 | CC `README_ZH.md:358` 按工具；CX `README.md:128` 注入中心 | Codex 模板/Markdown 导入/启用/冲突认领有 API；`src/views/PromptsView.tsx:56`、`:127`、`:373` | 部分；多工具入口 A08。并未核验为 CX 全部高级注入能力的等价实现 |
| Skills/MCP 多目标 | CC `README_ZH.md:357`；CX `README.md:269` | `src/views/SkillsMcpView.tsx:30` 七目标 Skills，`:40` 六目标 MCP（OpenClaw 排除）；`:143`/`:150` 仅更改选中目标；ZIP `:680` | 已接入多目标，不能报成 Codex-only；生命周期缺口 A06 |
| Pi/MiniMax 扩展资源 | CC `README_ZH.md:327`、`:328` 提供 Skills 等 | 当前 `src-tauri/src/app_config.rs:35`、`:120` 和 `src-tauri/src/services/skill.rs:2324` 明确不管理 Pi/MiniMax 相关能力；MiniMax MCP 与上游不同，Pi 原生无 MCP 不算缺口 | 部分/当前实现延期，不是 UI 多目标选择器的“漏接已实现后端”；PRODUCT 未明确把这些永久排除 |
| 会话 | CC `README_ZH.md:370`；CX `README.md:245`；CPP `README.md:146` 删除/导出/用量/元数据 | 真正入口是 `src/components/sessions/SessionManagerPage.tsx:188`，搜索/筛选/批量确认删除/历史归拢有链；后端扫描七种来源 `src-tauri/src/session_manager/mod.rs:86` | 部分；导出 A05；Pi/MiniMax 不在扫描列表。Windows 复制恢复命令、macOS 终端恢复是现有平台边界 |
| 用量/成本 | CC `README_ZH.md:364`、`:366` 多工具、日志、成本、自定义价；CPP `README.md:146` Token 历史 | `src/views/UsageView.tsx:103` 读取 Codex 汇总/趋势/模型，`:156` 同步，`:212` 重建，`:246` CSV | Token 主链已实现；成本/请求明细/定价未接入 A09；不声称已有全工具用量 UI |
| 路由与故障转移 | CC `README_ZH.md:346`；CPP `README.md:164` 聚合路由 | Codex 协议切换自动协调接管，`src-tauri/src/commands/provider.rs:921`；故障队列命令注册 `src-tauri/src/lib.rs:1907` | 自动协议路由已实现；用户可管理故障队列/熔断设置缺失 A03；出站代理配置 A11 |
| 备份/导入 | CC `README_ZH.md:477` DB 备份；CX `README.md:280` 先预览再纳管；CPP `README.md:144` cc-switch/链接导入 | 当前 CC 导入预览/提交 `src/components/settings/CcSwitchImportPreview.tsx:92`、`:139`，深链显式确认 `src/App.tsx:72`；Codex Live 恢复 `src/components/LiveBackupsPanel.tsx:217` | 已有安全显式导入与 Live 恢复；完整 DB 和其他工具恢复入口 A04；导入后状态刷新 A07 |
| 云同步 | CC `README_ZH.md:376` WebDAV/S3 | 注册完整命令 `src-tauri/src/lib.rs:1806`；当前设置页没有同步区；worker 受独立策略关闭 | 未接入 A10；不能把 policy capability=true 视作自动同步已经运行 |
| 设置/语言/路径 | CC `README_ZH.md:492` WSL 路径；CAM `README.md:70` 11 语言 | 语言持久化、主题、自启动/关闭偏好、更新已接；仅部分文字走翻译；高级路径配置不在新设置页 | 部分；A02/A12/A13。无需以 CAM 的 11 语言数作为本产品硬性要求 |
| 外观/增强 | CAM `README.md:126` 皮肤；CPP `README.md:148`、`:173` 多种注入增强 | `src/views/AppearanceView.tsx:74` 目录、`:111` 操作；Codex 管理另有诊断 | 皮肤链已实现、真机注入未验证。CPP 微信/Stepwise/脚本/项目移动等没有逐一核验，不冒充当前承诺，也不武断称 PRODUCT 已排除 |
| 发布/平台 | CAM `README.md:151` 四平台、签名公证；CX `README.md:334` 跨平台；CPP `README.md:186` 安装包 | `.github/workflows/release.yml:117` 含 Win x64/ARM64、macOS universal、Linux；`src-tauri/tauri.conf.json` updater 有公钥/端点；当前 `README.md:75` 明示 macOS 未签名公证 | 发布配置已实现；产物、签名、下载可用性未验证。非 Windows Codex 本体维护受 `src-tauri/src/commands/codex_runtime.rs:1421` 限定，属于 PRODUCT 已承认的平台边界，不报“漏移植 CAM macOS delta”缺陷 |

**有意排除的对比项**：赞助商目录、affiliate、上游广告/推广预设、营销入口、旧版六项导航/装饰地球、非真实窗口控制等按 PRODUCT 的 Anti-references/Navigation 不追平。只保留 ChimeraHub 默认模板并不等于遗漏上游商家目录。中文优先并不等于设置中 English 选择后允许所有主要内容仍为简中。

## 4. 有证据的问题（13 项）

### A01 — 四种已实现配置适配没有主界面操作链（P2，未接入）

- **现象/影响**：GrokBuild、OpenClaw、Hermes、MiniMax Code 只在工具清单（前三者还在安装卡片）出现，没有对应线路页。用户能安装部分工具，却不能用当前主界面新增/编辑/激活这些工具的配置。Claude Desktop 同类入口情况仅记矩阵，不重复专项。
- **实际调用链**：`App → ChimeraApp → tool-* → ToolView` 只定义 Claude/Gemini/OpenCode/Pi；不存在其余四者的入口。后端 `add_and_activate_provider/switch_provider → ProviderService → live/专用服务` 已具备工具分派。
- **当前证据**：`src/ChimeraApp.tsx:2246`、`:2581`；`src/lib/productCapabilities.ts:28`；`src/views/ToolView.tsx:55`；`src-tauri/src/commands/provider.rs:119`、`:909`；`src-tauri/src/services/provider/live.rs:1293`、`:1354`、`:1396`；`src-tauri/src/services/provider/mod.rs:3032`。
- **上游证据**：`CC/README_ZH.md:323`、`:325`、`:326`、`:328`。上游是可操作工具配置，不只是列出配置文件路径。
- **最小建议**：按后端能力/工具注册表补四个明确入口，复用现有线路工作流并保留单当前/增量语义；不要先复制一套大而全后台。
- **运行时确认**：否；路由定义、JSX、注册命令及服务分派源码确认。

### A02 — “显示偏好”没有编辑入口，且导航未消费该偏好（P2，部分）

- **现象/影响**：工具清单可能显示“未设为显示”，对应 Claude/Gemini/OpenCode/Pi 导航却始终列出；当前工具设置没有开关。用户不能完成 PRODUCT 描述的明确工具启用流程，也不能让导航与托盘/后台按同一偏好收敛。
- **实际调用链**：`NewSettingsView → ToolRegistryPanel → settings.visibleApps` 仅展示；`ChimeraApp → canOpenProductView` 仅检查 multi_tool 能力，未检查 visibleApps。后端 `is_tool_enabled` 则同时检查产品策略和用户可见偏好。旧 `AppVisibilitySettings → onChange → save_settings` 路径不在当前入口闭包。
- **当前证据**：`src/components/settings/ToolRegistryPanel.tsx:124`；`src/ChimeraApp.tsx:2246`；`src/lib/productCapabilities.ts:39`；`src/components/settings/AppVisibilitySettings.tsx:58`；`src-tauri/src/product_policy.rs:252`；`src-tauri/src/commands/settings.rs:153`。
- **上游证据**：`CC/src/components/settings/SettingsPage.tsx:258`；`CC/README_ZH.md:428` 允许设置中关掉不常用工具。
- **最小建议**：恢复小型显式显示/启用开关，并让导航读取同一状态；启用不能顺带无确认导入凭据。不要通过删除后端后台保护来消除不一致。
- **运行时确认**：否；确定的是状态消费断链，不据此声称已经发生隐式凭据导入。

### A03 — 故障转移队列和策略后端已注册，当前 UI 无配置入口（P2，未接入）

- **现象/影响**：自动协议路由不是自动故障转移。当前用户不能创建/维护候选队列、开启自动故障转移或调整相关熔断重试参数；导入已有配置后也缺少检查和修改界面。
- **实际调用链**：当前线路页走 `providersApi.switch → switch_provider → automatic routing`；故障转移应走 `FailoverQueueManager/AutoFailoverConfigPanel → failover/proxy API → 队列及 proxy_config`，但承载它们的 ProxyTabContent 未被当前应用引用。
- **当前证据**：`src/ChimeraApp.tsx:1255`；`src-tauri/src/commands/provider.rs:921`；`src/components/settings/ProxyTabContent.tsx:198`、`:204`；`src-tauri/src/commands/failover.rs:13`、`:38`、`:64`；`src-tauri/src/lib.rs:1907`。
- **上游证据**：`CC/README_ZH.md:349`；`CC/src/components/settings/ProxyTabContent.tsx:350`；CPP 仅文档 `CPP/README.md:164`。
- **最小建议**：先为 Codex 增加队列、启用状态和简明健康提示入口，复用既有 API；高级阈值继续折叠，不要求本轮实现 CPP 所有轮转算法。
- **运行时确认**：否；确认的是配置链缺失，不否认后端转发/熔断本身存在。

### A04 — “备份与恢复”仅覆盖 Codex Live，完整应用数据及其他工具无法从 UI 恢复（P2，部分）

- **现象/影响**：当前入口只能创建/恢复 Codex Live 文件；不能从应用 UI 管理数据库备份、恢复供应商库/资源库，也不能选其他工具的 Live 备份。不是“没有备份后端”，而是恢复范围和入口断开。
- **实际调用链**：`NewSettingsView → LiveBackupsPanel → liveBackupsApi.*('codex') → commands/live_tools → live_backup`；独立 `create/list/restore_db_backup` 及 export/import_config 命令已注册，却未由新设置页调用。
- **当前证据**：`src/views/NewSettingsView.tsx:6`、`:23`；`src/components/LiveBackupsPanel.tsx:110`、`:123`、`:217`；`src-tauri/src/commands/live_tools.rs:35`、`:70`；`src-tauri/src/commands/import_export.rs:22`、`:43`、`:169`、`:193`；`src-tauri/src/lib.rs:1821`。
- **上游证据**：`CC/README_ZH.md:477`；`CC/src/components/settings/SettingsPage.tsx:420`。
- **最小建议**：并列区分“当前工具 Live 文件备份”和“应用数据库备份”，复用既有备份列表/恢复确认；给 Live 面板增加支持工具选择。继续明确 auth.json 不在 Live 恢复范围，不承诺凭据被完整备份。
- **运行时确认**：否；未创建、读取或恢复真实备份。

### A05 — 会话导出未进入真实会话页，能力清单却宣布开放（P2，未接入）

- **现象/影响**：真实会话页支持检索/删除/恢复命令，但没有单条 Markdown 或批量导出流程；用户清理会话前缺少应用内导出手段。旧 SessionsView 中的导出提示不能算实现。
- **实际调用链**：`ChimeraApp → SessionManagerPage → sessionsApi → list/get_messages/delete/...`，没有 export 分支；`session_export` 由统一 capability=true 返回，但注册命令表没有对应导出命令。前端也未使用现有消息读取接口生成导出文件。
- **当前证据**：`src/ChimeraApp.tsx:187`；`src/components/sessions/SessionManagerPage.tsx:188`、`:451`；`src/lib/api/sessions.ts:30`；`src-tauri/src/lib.rs:1936`；`src-tauri/src/product_policy.rs:115`。不可达旧稿的 toast 位于 `src/views/SessionsView.tsx:52`，不作为现成功能。
- **上游证据**：`CX/apps/desktop/src/main.tsx:2503`；`CX/apps/desktop/src/pages/SessionManagementPage.tsx:237`；`CX/apps/desktop/src-tauri/src/transfers.rs:82`；CPP 文档 `CPP/README.md:146`。
- **最小建议**：在真实页复用现有消息读取链，先接单条 Markdown，再考虑批量；完成前不要把 capability 当成用户可用性保证。
- **运行时确认**：否；调用链及入口闭包确认。

### A06 — 多目标资源已接，但来源纳管、仓库管理、更新/恢复链仍断开（P2，部分）

- **现象/影响**：可 ZIP 安装、按目标启停和手动编辑 MCP；但“读取已配置仓库”无法在当前设置页配置仓库。已有本机 Skills/MCP 的扫描纳管、Skill 检查更新/升级/备份恢复也没有对应当前入口。新用户尤其容易得到空发现列表，已有仓库或深链导入仓库的用户则不一定为空。
- **实际调用链**：当前 `SkillsMcpView → discoverAvailable/installFromZip/installUnified/toggle`；完整的 `get/add/remove_skill_repo`、`scan_unmanaged_skills/import_skills_from_apps`、`check_skill_updates/update_skill/restore_skill_backup`、`import_mcp_from_apps` 仍是注册后端，但新页不调用。启动默认仓库初始化也被独立策略关闭。
- **当前证据**：`src/views/SkillsMcpView.tsx:680`、`:690`、`:696`；`src/lib/api/skills.ts:155`、`:168`、`:185`、`:233`；`src/lib/api/mcp.ts:126`；`src-tauri/src/lib.rs:1772`、`:1857`、`:1862`、`:1872`；`src-tauri/src/lib.rs:799`；`src-tauri/src/product_policy.rs:272`。
- **上游证据**：`CC/README_ZH.md:357`、`:359`、`:479`；`CC/src/components/skills/UnifiedSkillsPanel.tsx:461`、`:516`；`CX/README.md:277`、`:281`。
- **最小建议**：先补“管理仓库”和“扫描现有资源后选择导入”两个入口，再复用已有更新/备份能力；移除或修正“复用设置中的仓库来源”的悬空指引。不需要重做已经完成的多目标选择器。
- **运行时确认**：否；未扫描用户目录、下载或安装 Skill。

### A07 — 深链导入成功只刷新旧查询缓存，新页面局部状态不会同步（P2，前后端未闭环）

- **现象/影响**：停留在其他工具线路页、Skills/MCP 或提示词页接受深链导入时，后端导入成功后列表仍可能不出现新条目，需重新挂载/手动刷新。容易误以为导入失败并重复操作。Codex 线路有独立 refreshVersion，不属于本问题。
- **实际调用链**：`App → DeepLinkImportDialog → deeplinkApi.importFromDeeplink` 成功后，provider 只 invalidate `['providers', app]`，MCP/Skills 只 invalidate React Query；prompt 发 `prompt-imported`。但是 ToolView/SkillsMcpView/PromptsView 都采用自己的 useState+load；ToolView 只监听另一事件 `chimera-provider-mutated`，新提示词页未监听 prompt-imported；App 的 provider 回调只增加 Codex 版本。
- **当前证据**：`src/components/DeepLinkImportDialog.tsx:156`、`:164`、`:172`、`:201`、`:212`、`:228`；`src/App.tsx:90`；`src/views/ToolView.tsx:154`；`src/views/SkillsMcpView.tsx:70`、`:93`；`src/views/PromptsView.tsx:47`、`:68`。
- **上游证据**：功能基准 `CC/README_ZH.md:378`（深链资源导入）；当前导入弹窗保留的刷新策略与新页面数据所有权不一致，是本工作树自身可证明的接线问题，不需要推定上游也存在同样错误。
- **最小建议**：让成功导入通知当前各资源页使用同一刷新事件/版本，或统一使用已有 Query 数据源；不要仅追加更多无订阅者的 invalidateQueries。
- **运行时确认**：否；成功路径通知与订阅者的源码匹配确认，未提交真实深链。

### A08 — 非 Codex 提示词后端仍可用，当前提示词页固定 Codex（P3，未接入）

- **现象/影响**：使用 Claude/Gemini/GrokBuild/OpenCode 等工具的用户无法通过当前提示词页管理对应指令文件。该项是上游覆盖差距，不把“其他工具只开放配置页”扩张成已经承诺所有功能。
- **实际调用链**：`ChimeraApp → PromptsView → promptsApi.*('codex')`；后端 prompt 命令接收 app，PromptService 经 prompt_file_path 支持多种工具文件。Pi/MiniMax 在后端明确拒绝，不能误称其仅缺一个 UI 下拉框。
- **当前证据**：`src/ChimeraApp.tsx:2567`；`src/views/PromptsView.tsx:56`、`:110`、`:127`、`:352`；`src-tauri/src/commands/prompt.rs:13`、`:45`；`src-tauri/src/prompt_files.rs:12`、`:23`、`:34`；`src-tauri/src/lib.rs:1774`。
- **上游证据**：`CC/README_ZH.md:302`、`:358`；`CC/src/App.tsx:1073`。
- **最小建议**：给现有提示词页加能力驱动的目标选择，复用现有 app 参数；Hermes/OpenClaw 特殊记忆/工作区不要伪装成完全等价普通提示词。
- **运行时确认**：否；未读写用户指令文件。

### A09 — 用量页只展示 Token，成本、定价与请求明细后端未接入（P2，部分）

- **现象/影响**：当前能查看 Codex Token、趋势及模型排行，也能导出 CSV；无法查看/维护自定义计价或逐请求记录，不能复现上游成本诊断工作流。其他工具统计入口亦缺，但不把 Codex-first 直接判为错误。
- **实际调用链**：`UsageView → getUsageSummary/getUsageTrends/getModelStats(...,'codex')`；可用的 `get_request_logs/get_request_detail/get_model_pricing/update_model_pricing` 不在该页操作链，CSV 也只有 Token/请求数，不是成本报表。
- **当前证据**：`src/views/UsageView.tsx:103`、`:246`；`src-tauri/src/commands/usage.rs:105`、`:116`、`:125`、`:175`；`src-tauri/src/lib.rs:1919`。
- **上游证据**：`CC/README_ZH.md:364`、`:366`；`CC/src/components/usage/PricingConfigPanel.tsx:49`、`:79`。
- **最小建议**：在现有用量页补“成本/计价”及请求明细入口，复用注册 API，明确未定价模型与价格来源；多工具统计单独评估，不强行扩大本轮范围。
- **运行时确认**：否；未扫描真实用量数据库或发出计费请求。

### A10 — WebDAV/S3 命令开放，但手动入口和自动 worker 都未形成用户流程（P3，未接入）

- **现象/影响**：当前不能配置、测试、上传或恢复云同步；即便旧设置里存在启用状态，也不能据此期待自动同步 worker 运行。PRODUCT 没有把云同步列为必须首发功能，因此按上游差距而非核心故障定级。
- **实际调用链**：旧 `SettingsPage → WebdavSyncSection` 已脱离 App；`NewSettingsView` 仅六组设置。后端注册 WebDAV/S3 全套命令；启动 `if start_cloud_sync_workers()` 被常量 false 阻断，与 capability 全 true 不等价。
- **当前证据**：`src/views/NewSettingsView.tsx:23`；`src/components/settings/SettingsPage.tsx:449`；`src-tauri/src/commands/webdav_sync.rs:86`、`:106`、`:133`、`:171`；`src-tauri/src/lib.rs:1398`、`:1806`；`src-tauri/src/product_policy.rs:280`。
- **上游证据**：`CC/README_ZH.md:376`；`CC/src/components/settings/SettingsPage.tsx:448`。
- **最小建议**：若本轮开放，先接显式手动测试/同步/冲突确认；自动同步必须单独征得用户启用，不能为了对齐 capability 默认启动网络任务。
- **运行时确认**：否；未连接云端或读取同步凭据。

### A11 — 全局出站代理可设置/测试的后端无法从新设置页操作（P2，未接入）

- **现象/影响**：需要 HTTP/SOCKS 出站代理的用户无法在当前 UI 设置、测试或清除应用全局代理。不要把它与 Codex 本地协议转换代理混为一谈；后者存在不能弥补前者缺入口。
- **实际调用链**：原 `ProxyTabContent → GlobalProxySettings → useGlobalProxy → globalProxy API` 不可达；后端 `set_global_proxy_url` 校验、写 DB、更新客户端，以及测试/扫描命令均已注册。
- **当前证据**：`src/components/settings/ProxyTabContent.tsx:259`；`src/components/settings/GlobalProxySettings.tsx:12`；`src-tauri/src/commands/global_proxy.rs:15`、`:35`；`src-tauri/src/lib.rs:1983`；`src/views/NewSettingsView.tsx:23`。
- **上游证据**：`CC/src/components/settings/ProxyTabContent.tsx:285`。CAM 的下载/网络配置也属于维护体验基准，见 `CAM/README.md:145`，但不要求复制其镜像基础设施。
- **最小建议**：在设置加入独立“网络代理”折叠块，复用现有认证、测试、清除逻辑；不要自动扫描/修改系统代理。
- **运行时确认**：否；未探测本机代理端口或改变网络配置。

### A12 — English/繁中选择可保存，但多个主页面仍硬编码简中（P3，部分）

- **现象/影响**：设置提供 English/繁中并正确更改语言状态，但主导航、工具页和多个新页面的大量标题/操作/报错使用字面量简中；选择语言并不能完成相应界面本地化。不是要求追平 CAM 的 11 语言。
- **实际调用链**：`NewSettingsView.save → loadLanguages → patchPreferences → i18n.changeLanguage` 已通；未使用 t 的 JSX 文本不会随着 i18n 状态改变。
- **当前证据**：`src/views/NewSettingsView.tsx:146`、`:157`、`:466`；`src/ChimeraApp.tsx:2241`、`:2246`；`src/views/ToolView.tsx:213`；`src/views/SkillsMcpView.tsx:89`、`:211`；`src-tauri/src/commands/settings.rs:144`。
- **上游证据**：`CC/README_ZH.md:380` 国际化；`CAM/README.md:70` 语言支持。产品的中文优先可以减少语言数量，但已暴露的语言选择仍应准确。
- **最小建议**：先迁移已可达主导航/核心动作/错误文本到现有翻译系统；若不承诺完整翻译，在选择器旁明确覆盖范围。
- **运行时确认**：否；字面量不受语言切换影响由源码可确定，未修改用户语言设置。

### A13 — 自定义配置目录/WSL 适配后端存在，新设置页不能配置（P2，未接入）

- **现象/影响**：工具清单说明“自定义目录以本机设置为准”，安装能力也保留 WSL 环境概念，但当前设置只显示默认路径，无法指定 CLI 配置所在目录。非默认目录用户不能通过当前 UI 完成路径纠正。
- **实际调用链**：旧 `SettingsPage → DirectorySettings → settings 保存/目录 override` 脱离入口；新页 PreferencesPatch 只包含语言和少量偏好，不包含目录字段。后端 AppSettings 及原保存命令仍保留 claude/codex/gemini/grok/opencode/openclaw/hermes 的覆盖路径。
- **当前证据**：`src/components/settings/ToolRegistryPanel.tsx:131`；`src/components/settings/SettingsPage.tsx:346`；`src/components/settings/DirectorySettings.tsx:29`；`src-tauri/src/settings.rs:711`、`:731`；`src-tauri/src/commands/settings.rs:100`、`:153`、`:551`；`src/lib/api/settings.ts:143`。
- **上游证据**：`CC/README_ZH.md:492` 明确通过路径覆盖管理 WSL 配置及安装检测；`:485` 说明目录迁移边界。
- **最小建议**：恢复高级目录区，保存前显示最终解析路径/目标工具并检查冲突；不自动搬运原配置或改变真实安装。
- **运行时确认**：否；未访问 WSL、修改路径或运行安装探测。

## 5. 收敛结论与交接

1. 当前工作树已明显形成 Codex 主工作流：线路/模型、账户、提示词、Skills/MCP、Token 用量、Windows 管理、Live 备份、显式导入均有可达实现。七种 CLI 卡片和七目标 Skills/六目标 MCP 不能再报“完全未接”。
2. 首要问题不是缺少更多后端命令，而是新应用入口和既有能力脱节：A01 工具配置入口、A03 故障转移、A04 完整恢复、A06 资源生命周期、A07 深链刷新优先处理；各项都是当前源码证据，不借用旧报告结论。
3. A05 会话导出尤其不能由“能力清单为 true”或不可达设计页的 toast 证明完成；A02 也说明工具注册、策略允许、用户启用、已安装、主页面可达必须分开。
4. 真机待确认：OAuth/额度网络、模型实际请求、代理故障切换、七 CLI 安装升级、MSIX/便携修复回滚、数据库/Live 恢复、跨平台产物签名更新。未执行不等于失败；不得将本报告升级为发布验收证明。
5. 最新上游增量、Claude Desktop 模型映射/认证/安装专项留主审。CPP 未做源码等价性核验，只有文档功能差异；其其他增强不应未经产品决策全部转化为缺陷清单。

本次没有对产品文件进行修复。本文“已确认”均指静态源码/调用链已确认，**13 项均未运行时复现**。
