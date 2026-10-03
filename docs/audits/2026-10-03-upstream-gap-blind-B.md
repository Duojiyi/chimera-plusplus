# 独立盲审 B：当前工作树与四上游固定快照差距

日期：2026-10-03（Asia/Shanghai）。审查对象：`D:\Desktop\chimera-plusplus` 当前工作树，而非 HEAD。用户声明的 231 项 dirty 改动均视为既有工作，不恢复、不覆盖。

## 1. 基线、方法与结论边界

四个对比基线均位于 `D:\Desktop\_upstream_audit\snapshots-2026-10-02`，下文用 CC、CX、CAM、CPP 作为其目录前缀。

| 前缀 | 快照目录 | 固定 HEAD（用户提供） | 使用范围 |
| --- | --- | --- | --- |
| CC | cc-switch | `1bc68e293f635a065fa984d4c2ca7604fbd77854` | MIT 产品源码 |
| CX | Codex-X | `8f018fddd3ee1a68464e4df8765eb370ede0c76f` | MIT 产品源码 |
| CAM | Codex-App-Manager | `99c25522e8cac87b47c9a5d325de24009c58f71f` | MIT 产品源码、README |
| CPP | CodexPlusPlus | `27d50a1a0413b3c445bc95fae081f16b6c7edbf0` | **只读 README 用户功能说明；未读源码** |

补充元数据来自用户，不是 B 独立联网核验结果：CX/CAM 远端 HEAD 与快照一致；CC 远端 `bfaaba1679b8e8df6c8673d2b963d204fc1e521e` 比快照多 8 提交；CPP 远端 `f55bb64663ba5024ab434017bb6212a0fd9f4bb3` 比快照多 35 提交。**本文不覆盖这两组增量，不声称“最新 HEAD 全量核验”。** Claude Desktop 深入实现与最新增量由主审负责。

- 未读取历史 audit/reviewer/findings 报告、另一审计输出或相关结论；未与其他代理交流结论。读取 `PRODUCT.md` 确定 v2.8 开发目标与刻意排除。
- 采用 `App.tsx → ChimeraApp.tsx → 当前挂载视图 → API invoke → lib.rs 注册 → commands → services → 文件/DB/恢复` 路径。保留的旧组件、仅注册的 IPC 与主界面可达功能分开标记。
- 这是**覆盖全部要求领域的静态链路审查，不是逐行穷尽所有源码，也不是 E2E 认证**。核心深挖 MCP、Skills、生命周期、恢复失败边界；其他领域记录审到的保护与未验证部分。
- 未编译 Rust，未运行 cargo build/test/check/clippy、Tauri dev/build；未安装升级、停止进程、访问真实用户配置、调用会写配置的 IPC。未运行前端测试或 GUI/E2E。本次验证是源码控制流与上游对照，以下运行验证均为建议、尚未执行。
- 唯一写入文件为本文。行号是审阅时当前工作树的定位锚点；并行开发可能令行号漂移。

结论：列出 **11 项**独立问题（P1 5 项、P2 6 项）。P1 表示配置越权影响、不可完整回滚或错误执行目标，应优先阻断；P2 表示可恢复一致性缺陷、平台回归或产品入口缺口。没有足够证据宣称 P0、凭据已外泄或已有用户数据损失。

## 2. 覆盖矩阵：可达性、落盘与四上游差距

| 领域 | 当前可达链路与落点 | 静态观察/差距 | 对照锚点与验证边界 |
| --- | --- | --- | --- |
| 前端入口/多工具配置 | `src/App.tsx:6` 挂载 ChimeraApp；`src/ChimeraApp.tsx:2245` 的其他工具仅 Claude Code/Gemini/OpenCode/Pi；`src/ChimeraApp.tsx:2581` 对应四个 ToolView；`src-tauri/src/commands/provider.rs:1304` 有显式本地导入，服务有更多适配 | 注册表 10 工具 ≠ 10 个线路管理入口。GrokBuild/OpenClaw/Hermes/MiniMax Code 缺当前线路页，见 B11；不是声称其后端不存在 | CC `src/App.tsx:1470` 使用 AppSwitcher；当前 `src-tauri/src/tool_registry.rs:43` / `src/shared/tool-registry.json` 保留十工具元数据 |
| Claude Desktop | 注册表/后端存在（`src-tauri/src/commands/provider.rs:1348`），当前 ChimeraApp 没有对应线路渲染分支；工具清单可见 | 高层真实可达性：清单可见、当前线路页不可达；不重复其实现细节专项 | CC `src/App.tsx:183`、`:471` 有 Desktop 路径；专项交主审，不据此判其协议实现正确或错误 |
| CLI 生命周期 | 设置 → `ToolRegistryPanel.tsx:80` → AboutSection → `AboutSection.tsx:633` → `commands/misc.rs:189` → 外部进程 | **七 CLI 已接通**：claude/codex/gemini/grok/opencode/openclaw/hermes；有执行后版本复核和有限超时。不把旧硬编码缺口再次报出。仍有 B05/B07 | CC `commands/misc.rs:291` 已用独立临时目录，`:275` 注入登录 shell PATH；CAM `app/oplock.rs:358` 有运行期互斥模型 |
| Codex 桌面维护 | ChimeraApp runtime → `commands/codex_runtime.rs:1129` 等 → 跨进程 operation lock / install journal / Windows engine | 有锁、恢复日志与平台分支；不是七 CLI 的同一执行器。未做真实安装、签名或崩溃恢复试验 | CAM `README.md:123` 描述 macOS 差量签名/回滚，`:124` Windows 暂存；当前 PRODUCT 明确 Windows 优先，不把 macOS 功能不等价直接认作缺陷 |
| 官方账户 | `views/OfficialAccountsView.tsx:407` 等 → `commands/official_accounts.rs` → codex_accounts/Vault + provider DB | 凭据留后端；Vault 有 CAS、墓碑、候选凭据；移除存在 B09。未执行登录、刷新或读取真实 auth | CPP `README.md:160`、`:161`、`:162` 区分三种认证模式；文档不能证明其账户删除事务优于当前 |
| 提示词 | `ChimeraApp.tsx:2567` → PromptsView → `commands/prompt.rs` → `services/prompt.rs:455` → 所有权块/CAS/DB 提交 | Codex 路径有 switch 锁、外来文件接管确认、DB 失败回滚；未将旧非 Codex 提示词接口视为主界面入口 | CX `live_config.rs:17`、`:69` 使用锁与 CAS；本项目不是完全缺少该保护，MCP 才是本轮突出缺口 |
| Skills | `views/SkillsMcpView.tsx:30` 七目标；安装/ZIP/启停 → `commands/skill.rs` → SSOT 与各工具目录 | 多目标已实现；见 B06/B08。更新 IPC 与 API 存在，但当前 SkillsMcpView 没有更新按钮调用，B06 归为潜伏接口缺陷，不当作当前点按钮必现 | CC `services/skill.rs:1445` / `:3189` 已优先按原仓库路径更新；`:1995` 启停仍存在文件先于 DB 的同类窗口 |
| MCP | 当前 SkillsMcpView → `lib/api/mcp.ts:101`、`:119` → `commands/mcp.rs:172`、`:187` → `services/mcp.rs` → 六类 live 配置 | OpenClaw UI 明示不支持 MCP；Pi/MiniMax/Desktop 不作为此页目标。真实问题为 B01–B04；不是多目标不存在 | CC `services/mcp.rs:255` 保留无所有权全量投影风险；当前新增回滚仍有 B03。CPP `README.md:165` 只证明用户可按供应商选资源，不能证明事务实现 |
| 会话/用量 | `ChimeraApp.tsx:2555` 多工具 SessionManager；`commands/session_manager.rs:69`、`:89` → provider adapters；UsageView → usage commands/DB/cursors | Codex 删除检查桌面进程，存在 cleanup_pending 的部分删除状态；`services/session_usage.rs:65` 在后台任务内保留同步锁。用量 UI Codex-first 符合 PRODUCT。未确认各 CLI 真实格式兼容与删除 E2E | CPP `README.md:146`、`:173` 覆盖导出/删除；CX `lib.rs:110` 引入本地删除/备份链路。只核到实现，不声称全部格式通过 |
| 备份/导入/恢复 | 当前设置 `NewSettingsView.tsx:396` ImportPanel（深链、CC 导入），`:408` LiveBackupsPanel → live_tools → live_backup | 当前是 Codex live 文件备份，明确不含 auth；`services/live_backup.rs:451` 检查工具/路径、switch 锁、CAS、恢复前备份、提示词库对账。数据库 SQL/WebDAV 的旧 IPC 仍存在，但不能当成当前设置已展示 | CX `backups.rs:21` 记录 had_config/had_agents，`lib.rs:1726` 将缺失态纳入恢复；当前 `live_backup.rs:290` 仅存存在文件，因此不是完整目录时间点恢复。UI 明说“备份中的文件”，这里记能力差距，不单独判数据丢失 bug |
| 健康/修复 | ConfigHealthView → `commands/config_health.rs:13` → `config_health.rs:80` | 只修自有 instruction refs；确认 token 包含原字节/方案、接管检查、锁、备份、CAS 均存在。此范围不是任意配置自动修复 | CX `config_health.rs:727`、`:752`、`:779` 有重算/锁/备份。CPP `README.md:207` 为 Provider Doctor 用户入口，未取源码推断 |
| 代理/路由/失败路径 | 线路编辑/切换 → provider/proxy services → `proxy/server.rs:122`、`:438` → provider credentials/转换/恢复 | 非 loopback 绑定被拒；带 Origin 请求被拒；停止超时保留任务句柄。未见理由再次报告“监听全网无鉴权”。网络重试、SSE、工具调用转换与故障转移未运行 | CPP `README.md:163`、`:211` 描述故障转移/多种轮转；文档中的能力不等于当前全部轮转策略已覆盖。广告/推广差异由 PRODUCT 刻意排除 |
| 跨平台 | CLI 有 Windows/Unix 执行分支；桌面维护 Windows 优先 | Unix 生命周期 PATH 回归 B07；Windows 并发脚本 B05。未运行 macOS/Linux、WSL、ARM64 | CC `commands/misc.rs:266`；CAM `README.md:65`、`:71` 提供差量和签名状态参考，不能据此否定 PRODUCT 的平台取舍 |
| 发布门禁 | `.github/workflows/ci.yml` 三平台 Rust/前端检查；`release.yml:17` 校验 tag 与 CI；`:875` 证据/签名；candidate 单独门禁 | 当前不是“无 Rust CI/无签名校验/有测试即通过”。本次只审工作流定义；未读取 CI 历史日志，未确认任何具体制品确实通过、签名有效或已发布 | CAM `README.md:151` 描述发行过程；本项目源码门禁不能代替发布制品测试。现有测试数量不作为 E2E 结论 |

## 3. 有证据问题

### B01 — P1：修改一个 MCP，可删除目标工具中从未接管的同名 MCP

- **状态/可达性：静态确认，当前 UI 可达；待隔离运行复现。**
- **当前证据：** `src/views/SkillsMcpView.tsx:147` → `src/lib/api/mcp.ts:119` → `src-tauri/src/commands/mcp.rs:187`。`src-tauri/src/services/mcp.rs:360` 读取全库，`:390` 对目标工具未启用的每条记录调用 remove；`src-tauri/src/mcp/claude.rs:137` 按 ID 无条件删除，Gemini 对应 `src-tauri/src/mcp/gemini.rs:132`，没有 Codex 那样的所有权账本/内容核对。
- **触发：** 管理库有只属于 Codex 的 `foo`；Claude Code 本地独立创建同 ID、不同命令/密钥的 `foo`，从未导入。用户仅在 Claude Code 启用另一个 `bar`，整库重投影即把 Claude 的 `foo` 删除。目标工具只需已有配置，不要求 `foo` 曾被本产品启用。
- **影响：** 跨工具误删外来配置；修改 bar 成功且没有 foo 的确认或专用恢复快照。不要将“全量投影幂等”误当作所有权安全。
- **上游：** CC `src-tauri/src/services/mcp.rs:255`、`:267` 同样按全库删除 disabled ID，属于继承风险、不是上游已修。当前 Codex ledger 不能保护 Claude/Gemini 等路径。
- **最小修复：** 只删除能证明由本产品写入且内容未被外部修改的条目；复用 Codex ownership/CAS 思路，或先把变更收窄到本次条目并保留“从未接管不可删”的硬约束。
- **验证：** 临时 HOME 中构造两工具同名不同内容，toggle bar 后逐字节断言外来 foo 保留；增加旧托管 foo 被外部修改后禁用的冲突用例。

### B02 — P1：给另一工具启用 MCP，会偷偷重新启用用户已在 Codex 关闭的 MCP

- **状态/可达性：静态确认，当前 UI 的目标选择器可达；待隔离运行。**
- **当前证据：** `src-tauri/src/services/mcp.rs:721` 的 Codex-only 关闭保留 `apps.codex=true`，将共享 spec 设为 `enabled=false`；`:144`–`:149` 在任意非 Codex 工具启用时删除共享 `enabled` 字段，`:156`–`:160` 同步受影响的所有工具。当前 UI `src/views/SkillsMcpView.tsx:123` 把该字段参与启用状态判断。
- **触发：** MCP 最初只供 Codex 使用 → 在 Codex 关闭 → 切换该页目标为 Gemini/Claude → 启用同一个 MCP。
- **影响：** 非 Codex 操作清掉 Codex 的关闭标记；Codex 重投影后在新会话再次加载服务（可能启动命令或连接携带凭据的服务），超出用户本次授权范围。
- **上游：** CC `src-tauri/src/services/mcp.rs:102` 使用独立 app enabled 更新，`:108` 仅删除目标 app。其这里没有本项目的 Codex-only 软关闭设计，不能直接复制旧实现，但对照证明这是当前共享 spec 与每工具状态混用带来的新增交互风险。
- **最小修复：** Codex 的 effective-enabled 单独建模；生成各工具 spec 时派生，非 Codex 启用不得删除 Codex 的关闭意图。
- **验证：** 按上述三步操作，断言 Codex 仍关闭、Gemini 已开启；再显式启用 Codex 才允许恢复。覆盖共享→独占与独占→共享两种转换。

### B03 — P1：新增 MCP 部分同步失败后的“回滚”会遗留已经写入的服务

- **状态/可达性：静态确认；新建多目标 MCP UI、批量导入 IPC 可达；待故障注入。**
- **当前证据：** `src-tauri/src/services/mcp.rs:19` 保存新记录后跨工具同步；`:183` 即使部分失败仍尝试其他目标。`:201` 对原先不存在的记录仅删 DB；`:214` 随后用已恢复 DB 再投影；`:380`、`:390` 只遍历现存记录，不再能看到新 ID。
- **触发：** 新建同时面向 Claude/Codex/Gemini 的 foo；某个可写工具写入成功，另一个工具因坏 JSON/TOML、权限或锁失败。
- **影响：** UI 报操作失败，DB 无 foo，但已成功写入的工具还会加载 foo；用户无法在列表中找到它并关闭。Codex ledger 的存在也不够：回滚投影不枚举那个已删 DB 的 ID。
- **上游：** CC `src-tauri/src/services/mcp.rs:19`、`:59` 的旧路径没有此跨工具回滚保证；不能称上游已解决。本项目增强了回滚提示但未完成撤销集合。
- **最小修复：** 记录成功写入的目标和原字节/不存在态，按逆序 CAS 恢复；至少显式撤销新增 ID，不能只恢复 DB 后从 DB 重算。
- **验证：** 隔离 HOME，将一个目标配置设为非法文档、另一个设为正常文档；新建失败后断言每个文件与 DB 都与操作前一致，包含原先不存在文件的情形。

### B04 — P1：MCP 缺少操作级串行化，失败回滚可覆盖另一笔成功修改

- **状态/可达性：静态确认无事务级保护；具体并发调度待运行验证。** 当前页 busyRef 只约束当前组件实例，不是后端全局锁。
- **当前证据：** `src-tauri/src/commands/mcp.rs:172`、`:187` 直接进入同步 service；`src-tauri/src/services/mcp.rs:22` 读旧值、`:27` 写新值、`:207` 无版本条件写旧快照；ledger `:238`–`:240` 也是独立 load/save。未获得 provider/prompt 路径的 `lock_switch_for_app`。provider 保存也会从 `src-tauri/src/services/provider/mod.rs:2793` 重投影 MCP。
- **触发：** 两笔 MCP IPC/与 provider 重投影交错：A 读 S0；B 保存 S1 成功；A 后续某目标失败并恢复 S0。或两次 ledger 读同一版本后分别保存。
- **影响：** 成功返回的修改被另一操作回滚，DB、所有权账本和实际配置出现错位。单条 SQL 的 mutex 不覆盖“读旧值→多文件写→回滚”生命周期。
- **上游：** CC `src-tauri/src/services/mcp.rs:19` 亦非完整跨工具事务；CX `apps/desktop/src-tauri/src/live_config.rs:17`、`:69` 提供锁+字节 CAS 的可借鉴机制，但不能称 CX 直接修复了本项目统一多工具 MCP 问题。
- **最小修复：** 在共享 MCP 写入口持有操作锁；与其他 live 写入按固定工具顺序协调，回滚须比对本次提交版本。内部已持锁调用与外层入口分离，避免重入死锁。
- **验证：** 用 barrier 控制 A/B 交错并故障注入；断言 B 已确认的版本不会被 A 回滚；重复 provider 重投影/MCP toggle 竞争。必须隔离 DB/HOME。

### B05 — P1：Windows 并发 CLI 操作共用临时 BAT，可执行错工具或提前删脚本

- **状态/可达性：静态确认路径碰撞；重挂载/并发 IPC 的实际时间窗口待验证。**
- **当前证据：** `src-tauri/src/commands/misc.rs:189` 没有后端生命周期互斥；`:236`–`:249` 用 `cc_switch_{label}_{pid}.bat`，label 只有 install/update，同进程同类操作同一路径。前端 `src/components/settings/AboutSection.tsx:633` 可调用；busy 状态属于 AboutSection 实例（`:238`、`:851`），不是后端作业状态。设置工具页和各工具页均可挂载 AboutSection。
- **触发：** A 工具安装尚未结束，离开/返回页面或另一调用入口发起 B 工具安装；A 尚未读取脚本或读后续行时 B 重写同名文件，或任一调用结束删除另一个仍使用的脚本。
- **影响：** 请求 A 实际运行 B 安装命令、脚本中断或两个请求得到不可靠结果；即使最终版本复核能发现异常，也不能撤销安装到错误工具的副作用。这不是“七 CLI 尚未实现”。
- **上游：** **固定 CC 快照已处理**：`src-tauri/src/commands/misc.rs:291`–`:295` 每次创建独立 tempfile 目录。CAM `src-tauri/src/app/oplock.rs:358`、`:743` 另有运行期互斥设计。
- **最小修复：** 每次请求独立临时目录/文件且保活到子进程结束；同一工具 lifecycle 再加后端互斥与可查询作业状态。
- **验证：** 不启动真实安装器。注入假执行器/barrier 同时提交两个安装请求，检查脚本路径不同、内容目标正确、一方清理不影响另一方；补页面卸载再进入测试。

### B06 — P2：Skill 更新按目录末段匹配，可能把另一路径的同名 Skill 覆盖进来

- **状态/可达性：静态确认，**当前主视图未提供更新按钮；属于已注册 IPC 的潜伏真实缺陷，不宣称用户现在可从该页点击复现。
- **当前证据：** `src/lib/api/skills.ts:190` → `src-tauri/src/lib.rs:1863` → `src-tauri/src/commands/skill.rs:147` → `src-tauri/src/services/skill.rs:1374`，仅 `.find` 第一个 basename 相等项；检查更新也在 `:1258` 同样处理。`:1477` 已有 readme_url，却只在选定源后拿来构造文档地址，不用于定位内容。
- **触发：** 同一仓库存在 `team-a/foo/SKILL.md` 与 `team-b/foo/SKILL.md`，用户安装后者，扫描先遇到前者；调用 update_skill。
- **影响：** SSOT 及启用工具被替换为错误 Skill 的指令/脚本；更新成功但来源身份错配。其 staging/swap 回滚不能识别语义选错源。
- **上游：** **固定 CC 快照已优先处理原路径**：`src-tauri/src/services/skill.rs:1445` 调用 helper，`:3189` 先用 stored_readme_url 中仓库相对路径匹配。其 fallback 仍需单独注意歧义，不能泛称上游所有同名情况都安全。
- **最小修复：** 持久化并优先使用安装时完整仓库相对路径；旧记录仅在唯一匹配时回退，歧义明确拒绝。
- **验证：** 本地 mock 下载仓库放两个同名末段目录，交换扫描顺序，检查更新始终命中原路径；原路径消失时应提示，不静默选另一个。

### B07 — P2：Unix GUI 生命周期执行环境未补登录 PATH，已探测安装仍可能无法升级

- **状态/可达性：静态确认执行环境差异；macOS/Linux 实机验证未运行。**
- **当前证据：** `src-tauri/src/commands/misc.rs:219`–`:229` 直接 `bash -c` 执行，无登录 PATH 注入；`:688` 对已安装工具进行锚定。锚定 npm/脚本的绝对路径不保证其内部 `env node`、npm、uv 等可从 GUI PATH 找到。
- **触发：** 从 macOS Finder/LaunchServices 启动，Node/包管理器仅在用户登录 shell 的 nvm/Homebrew 路径中；执行已探测工具更新，或推荐安装器失败后的 npm fallback。
- **影响：** “已安装/已探测”却更新失败，或 fallback 命中不同包管理器；并非当前所有 Unix 安装都失败。
- **上游：** **固定 CC 快照已处理**：`src-tauri/src/commands/misc.rs:275` 合并 `login_shell_path()` 与 inherited PATH，再交给执行器。
- **最小修复：** 复用探测得到的可信登录 PATH 并传给子进程，保留当前有界输出/超时机制；不要为修复 PATH 退回无界执行。
- **验证：** 假 GUI PATH 与临时工具链中放依赖 PATH 找 node 的假 npm；探测和执行必须使用同一环境。另在 macOS 应用启动场景验证，而非只从终端启动。

### B08 — P2：Skills 启停先改文件再改 DB，DB 失败后启用状态与真实加载状态相反

- **状态/可达性：静态确认，当前 UI 可达；待 DB 故障注入。**
- **当前证据：** `src/views/SkillsMcpView.tsx:139` → skills toggle → `src-tauri/src/commands/skill.rs:88` → `src-tauri/src/services/skill.rs:1836`。`:1847` 同步或删除投影完成后，`:1853` 才 `update_skill_apps`；错误直接传播，没有投影补偿或部分成功结果。
- **触发：** 投影操作成功后，SQLite 写入因只读、磁盘满、触发器拒绝等失败。
- **影响：** 启用报错但服务文件已存在、下一会话照常加载；禁用报错而文件已经删除，UI/DB 仍记为开启。后续全量 sync 还可能把已删除文件重新装回。
- **上游：** CC `src-tauri/src/services/skill.rs:1995`、`:2015` 仍是同类文件先于 DB 顺序，未发现该失败窗口的补偿；上游新增状态写锁解决并发，不能解决本项提交失败。
- **最小修复：** 保存投影原态并在 DB 失败时安全恢复；若无法恢复，返回结构化部分成功并刷新实际状态，而不是笼统失败。
- **验证：** 临时 DB 增加拒绝更新触发器，分别 enable/disable，断言文件与 app flag 一致；禁止使用真实用户库进行试验。

### B09 — P2：官方账户移除吞掉解绑 DB 错误，界面会宣称全部成功

- **状态/可达性：静态确认，当前账户页可达；待注入数据库失败。**
- **当前证据：** `src/views/OfficialAccountsView.tsx:407` 调 remove 并在 `:408` toast 成功；`src-tauri/src/commands/official_accounts.rs:158` 先移除 Vault，`:163` 用 `let _ = save_provider(...)` 丢弃每条解绑错误，`:166` 无条件 Ok。Vault 删除入口见 `src-tauri/src/codex_accounts/vault.rs:501`。
- **触发：** Vault 文件删除成功，但 provider DB 写失败（只读/满盘/事务失败）。
- **影响：** 账号列表中凭据消失，线路仍指向已删除账号；用户收到“已移除”，后续切换才失败。多线路解绑时还可能只成功一部分。
- **上游：** CPP `README.md:160`–`:162` 仅描述认证模式，不描述本项目 Vault 的账户删除事务，**无法判定它是否处理此失败**。CX `apps/desktop/src-tauri/src/lib.rs:1726`–`:1731` 的多文件变更/失败回滚仅是事务设计参考，不是同功能已修证据。没有以 CPP 源码推断行为。
- **最小修复：** 不吞 DB 错误；先事务化更新绑定并记录可恢复删除意图，再删除凭据，或返回明确部分成功与修复动作。保证无法把未完成解绑包装成普通成功。
- **验证：** 假 Vault 与临时 DB，令第二条解绑失败；断言不返回普通成功、所有未完成绑定可见且能重试，前端展示部分完成而非成功 toast。

### B10 — P2：MCP 导入只按同 ID 合并，冲突命令/凭据将被跨工具复用

- **状态/可达性：静态确认潜伏接口缺陷。** `import_mcp_from_apps` 已注册，但当前 SkillsMcpView 未提供该调用入口；启动导入由 `product_policy.rs:268` 明确关闭，不报告为每次启动必发。
- **当前证据：** `src/lib/api/mcp.ts:126` → `src-tauri/src/lib.rs:1772` → `src-tauri/src/commands/mcp.rs:199`。`src-tauri/src/services/mcp.rs:636` 遇相同 ID 直接返回已有对象，不比 spec；`:532` 启用新工具标志；`:599` 顺序导入多个工具。
- **触发：** Claude 的 `db` 指向测试库，Gemini 的 `db` 指向生产库；导入两者时同 ID 被合并到首个 spec。导入本身不写 live，但后续编辑、启停或同步会将首个 spec 投影到另一工具。
- **影响：** 来源配置丢失于管理模型中，随后跨工具写错 URL/凭据/命令。不能因为导入函数当下只读 live 就认为后续安全。
- **上游：** CC `src-tauri/src/services/mcp.rs:344`、`:382` 也仅按 ID 启用工具、保留原内容，为继承缺陷，未见冲突确认机制。
- **最小修复：** 相同 ID 必须比较规范化 spec；不同内容保存工具命名空间的新 ID 或报告冲突供用户确认，不默认共享。
- **验证：** 两工具相同 ID、不同 spec 导入后，断言 DB 保留两份语义或拒绝冲突；再执行无关服务启停，两个原始服务配置都不得改变。

### B11 — P2 / 产品覆盖缺口：十工具注册表和“添加工具”不能到达其余工具线路管理

- **状态/可达性：静态确认前端结构缺口；无需推断后端缺失。**
- **当前证据：** `PRODUCT.md:41` 要求启用工具拥有对应 provider/entry 管理；`src/ChimeraApp.tsx:2245` 只列四个其他工具，`:2581`–`:2612` 只渲染这四个 ToolView；`src/utils/toolProviderConfig.ts:4` 的可编辑类型同样只含四种。添加工具按钮 `src/ChimeraApp.tsx:2277` 只跳设置；`src/components/settings/ToolRegistryPanel.tsx:112` 以后是 details/说明，`:131` 附近只显示 visibleApps 状态，不是启用流程。
- **触发：** 用户在设置中检测/安装 GrokBuild、OpenClaw 或 Hermes 后，希望配置该工具线路；或查看 MiniMax Code/Claude Desktop 清单后希望进入配置页。
- **影响：** 七 CLI 生命周期已存在，但这些工具的线路管理仍不在当前主壳可达图中；已有对应 provider/service/IPC 不能弥补入口。Claude Desktop 此处只标记高层不可达，不重复专项。
- **上游：** CC `src/App.tsx:1470` 的 AppSwitcher 与 `:1690` 的 OpenClaw 分支属于真实应用路由；当前 `src-tauri/src/tool_registry.rs:43` 保留十工具注册表，`src-tauri/src/commands/provider.rs:1304` 有显式导入入口，证明不是后台功能不存在。
- **最小修复：** 按后端能力生成主壳路由与启用确认流程，接入已有工具表单；尚未接通的工具明确显示“仅安装管理/线路管理未开放”，不把静态注册表称为已可管理。
- **验证：** 纯前端 mock registry/IPC，逐工具从“添加工具”走到对应线路页或明确不支持提示；在确认前断言没有 import/write IPC；不以菜单文字存在代替全链路可达。

## 4. 已看到的保护与不能过度推断之处

1. 七 CLI 安装管理、七目标 Skills/六目标 MCP 已接通；本报告没有重报过去的单工具硬编码。B11 是**provider 主壳路由**缺口，与这两项修复不矛盾。
2. Codex prompts/健康修复/live 恢复已使用所有权、备份、CAS、switch 锁等保护。不能因 MCP 同类保护不足就笼统宣称“全项目无原子写入”。
3. 会话删除有部分完成模型，用量同步有后台任务持锁；代理已有 loopback/Origin 拒绝与超时任务句柄保护；发行有 CI/tag/证据/签名门禁。本轮未确认这些保护的运行效果，也不把未运行视为缺陷。
4. 当前设置没有展示旧 SQL/WebDAV/备份管理全部界面、Skills 更新 IPC 未接主视图；这些是**可达性/覆盖记录**。除正文已明确触发的缺陷外，不凭后端存在就要求把所有旧界面搬回。
5. CPP 文档中的微信、脚本、界面增强、按供应商资源、轮转等不自动成为本项目必做项；PRODUCT 的 Codex-first、平台范围与禁止推广优先。文档只能证明用户行为承诺，不能证明崩溃一致性或安全实现。

## 5. 优先修复与验证顺序

最高优先五项：**B01 外来 MCP 误删 → B02 跨工具重新开启 Codex MCP → B03 回滚遗留服务 → B05 并发执行错 BAT → B04 并发旧快照覆盖成功更新**。B06 虽为潜伏入口，错误更新 Skill 的影响较大，应在开放更新按钮前处理。

建议先用临时 HOME/独立 SQLite、假安装执行器做上述确定性回归，再做前端路线/状态测试。只有用户另行授权后才能进行 Rust 编译与隔离后端测试；真实安装、真实凭据登录、真实配置恢复另需明确操作许可。本报告未进行上述运行验证，因此不提供虚构通过率或 E2E 完成声明。
