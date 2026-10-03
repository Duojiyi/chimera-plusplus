# 交叉复核 A：B01–B05 / B09 / B10

日期：2026-10-03。复核对象为 B 首轮报告 `docs/audits/2026-10-03-upstream-gap-blind-B.md` 指定的七项，以及复核时当前工作树源码；不是重新编辑首轮报告，也不是追加一轮全量审计。

## 方法与封存边界

- 按本轮授权读取 B 报告后，独立沿当前 UI、API、注册命令、服务、数据库及文件写入路径寻找支持证据和反证。以下判断不能再称为“双盲原始发现”，应作为交叉复核意见保存。
- 只读核对固定 CC 快照的相关实现：`D:\Desktop\_upstream_audit\snapshots-2026-10-02\cc-switch`，提交 `1bc68e293f635a065fa984d4c2ca7604fbd77854`。下文 `CC/` 为此目录；无前缀为 Chimera++ 当前工作树。未追远端增量，未读取 CPP 源码，也未进入 Claude Desktop 专项。
- 未编译或运行 Rust，未运行安装命令、真实配置/凭据/数据库操作或 Tauri IPC，未操作调试服务器。本轮没有运行测试；“成立”指源码存在完整触发路径，不表示已发生用户损失或已运行时复现。
- 唯一写入为本报告；首轮 A/B 保持封存。复核前记录的 SHA-256：A=`CA6742A7F5D7ECDAF6430B804FDC81A228B1727CFCBB4DD37CA3D8ABF8D47980`；B=`3A503868FB18227A677AA3DB7E3EA6CB1C2D5D5A584231B1469EDFCD5D45E95F`。

## 判定摘要

| 原项 | 交叉判定 | 严重级别建议 | 关键限定 |
| --- | --- | --- | --- |
| B01 | 成立 | 保留 P1 风险级别 | 目标工具已初始化；Claude/Gemini 的按 ID 删除不受 Codex ledger 保护 |
| B02 | 成立 | 保留 P1 风险级别 | Codex-only 软关闭之后启用另一个工具；Codex live 未被外部改动且同步未失败 |
| B03 | 成立 | 保留 P1 风险级别 | 新 ID 曾在至少一个目标写入成功，另一目标失败；不是所有失败都遗留 |
| B04 | 收窄，保留竞态风险 | P1 并发风险候选，调度待验证 | 数据库回滚覆盖需同记录交错；provider 重投影是另一类 live 竞态，不能混作同一证明 |
| B05 | 成立 | 保留 P1 风险级别 | 同进程、同操作类型的并发调用；安装与更新的标签不同，不互撞 |
| B09 | 成立 | 保留 P2 | Vault 删除后 provider 保存错误被吞；不等于主动删除当前 live auth 或远端注销 |
| B10 | 收窄，保留潜伏缺陷 | 保留 P2 | 同 ID 冲突会丢失第二份管理语义；后续覆盖对非 Codex 易成立，Codex 有外来内容保护 |

合计 **5 项成立、2 项收窄、0 项整体驳回**。七项均未运行时确认。严重级别是风险排序，不是事故已经发生的断言。

## 1. B01 — 成立：整库重投影确实会删除其他工具的外来同名条目

**核对链路**：`SkillsMcpView` 调 `mcpApi.toggleApp`（`src/views/SkillsMcpView.tsx:150`），注册后的 `toggle_mcp_app` 直接进入服务（`src-tauri/src/commands/mcp.rs:187`）。`toggle_app` 保存当前行后对 affected apps 调 `sync_apps`；后者读取整个 MCP 库，不只投影本次 server（`src-tauri/src/services/mcp.rs:156`、`:183`、`:360`）。非 Codex 分支对每个目标 app 标志为 false 的库记录调用 remove（`:390`）。

**关键证据**：`remove_server_from_app` 对 Claude/Gemini 仅传 ID，不传最后写入内容（`src-tauri/src/services/mcp.rs:297`）。`src-tauri/src/mcp/claude.rs:137` 和 `src-tauri/src/mcp/gemini.rs:132` 读取本地映射、`remove(id)`、写回，未比较其是否由本产品创建，也未比较实际 spec。

**反证检查及触发边界**：二者都检查工具目录是否存在（`src-tauri/src/mcp/claude.rs:11`、`src-tauri/src/mcp/gemini.rs:11`）。未初始化的工具会跳过，不应声称每次开关都创建/删除配置。但 B 构造的“本地已存在外来 foo”满足该前提：库中 foo 仅属 Codex，Claude 中有另一个 foo；启用 Claude 的 bar 时仍会访问 foo 并删除 Claude foo。是否启用 bar 与是否拥有 Claude foo 没有被关联验证。

**上游关系需准确**：固定 `CC/src-tauri/src/services/mcp.rs:255` 的整库投影也有同类按 ID 删除；但 CC 普通 toggle 在 `:100` 只同步/移除当前 server。因此可称“继承危险投影原语”，不宜称“上游点另一个 bar 必然同样触发”。当前 toggle 扩大了该原语的触发面。

**最小建议/验证**：删除必须要求目标工具所有权及内容匹配，或至少避免无关 ID 的全量清理；后续用隔离配置断言外来 foo 在启停 bar 后字节保持。不能靠只给确认框增加泛化警告解决所有权问题。

## 2. B02 — 成立：Codex 的软关闭意图被其他工具启用操作清除

**状态推演**：起点 `apps.codex=true`、其他 app=false。Codex 关闭走 `codex_toggle_target`，独占分支只设置 `server.enabled=false`，不清 `apps.codex`（`src-tauri/src/services/mcp.rs:722`、`:740`）。随后对 Gemini/Claude 启用时，非 Codex 分支把新目标设为 true，并无条件移除共享 spec 的 `enabled`（`:142`）。affected apps 包含 Codex 和新目标，保存后都会重新投影（`:154`、`:172`）。

**实际闭环**：前端当前启用状态同时参考目标标志和 `server.enabled`（`src/views/SkillsMcpView.tsx:123`），因此上述 Codex 关闭行仍显示为关闭，但切换目标后可以触发另一 app 的启用。Codex 投影仍看到 `apps.codex=true`（`src-tauri/src/services/mcp.rs:380`），输出不再有 false 覆盖，关闭意图丢失。

**反证检查**：Codex ledger 并非万能阻挡。正常由本产品写出的“关闭”配置，其 live hash 与 ledger 相同；`src-tauri/src/mcp/codex.rs:397` 将其识别为 owned，允许写入新 spec，最后记录新 hash（`:415`）。只有发生外部修改冲突、工具未初始化或写入失败等条件时，该具体 live 改变可能被阻断。故不能声称任何环境下都一定启动服务；成立的是配置被重新开放的正常路径，实际子进程/连接还取决于 Codex 后续加载。

**上游对照**：`CC/src-tauri/src/services/mcp.rs:102` 使用目标 app 开关更新，没有这里的共享 `enabled=false` 软关闭转换。B 对新增交互风险的定位成立。

**最小建议/验证**：独立保存每工具 effective-enabled，投影时再派生 spec。隔离验证“Codex 关闭→Gemini 开启”后 Codex 仍 false，只有显式 Codex 开启才恢复。

## 3. B03 — 成立：删 DB 后重投影无法撤销已写入的新 ID

**入口核实**：不是仅注册的潜伏接口。`src/views/SkillsMcpView.tsx:883` 挂载 MCP 表单并开放多工具（`:893`）；表单 `src/components/mcp/McpFormModal.tsx:407` 调 upsert mutation。命令 `src-tauri/src/commands/mcp.rs:172` 进入 `McpService::upsert_server`。

**失败路径**：服务先保存新行（`src-tauri/src/services/mcp.rs:22`、`:27`），`sync_apps` 即使某工具失败仍继续其他目标（`:183`）。失败后的 `restore_snapshots` 对 previous=None 仅删除 DB 新 ID（`:208`），然后 `rollback_changes` 再调用 `sync_apps`（`:225`）。两个投影分支均只枚举恢复后 DB 的 `servers.values()`（`:380`、`:390`）。新 ID 已不存在，所以先前写成功的配置没有对应 remove 操作。

**反证检查**：Codex 有 ledger，但该回滚没有枚举 ledger 中“数据库不再存在”的 ID；Claude/Gemini 则更没有这层账本。Codex 底层写入的单次 CAS（`src-tauri/src/codex_live_write.rs:253`）也不会自动撤销另一个已完成调用。若所有目标都跳过/失败而从未落盘，不会发生所述遗留；若原来已存在该记录，属于其他恢复场景，不能用本项的新建证明泛化。

**确定性见证**：隔离环境中一个已初始化目标正常可写，另一个目标文档解析失败；新建同一 MCP 选中二者。正常目标成功落盘、另一目标失败、DB 删除新行、重新投影缺少该 ID。这是可由控制流推出的遗留路径，但本次未执行。

**上游/建议**：固定 `CC/src-tauri/src/services/mcp.rs:19` 不能作为完整事务已解决的证据。最小修复应记录本次成功目标及原状态，显式补偿新增 ID，最好按原字节/不存在状态加 CAS 回滚；不能仅恢复 DB 再从 DB 重算。

## 4. B04 — 收窄：缺少业务事务锁成立，但需拆开数据库回滚与 live 重投影的并发证明

**成立部分**：`src-tauri/src/commands/mcp.rs:172`、`:187` 是 async 命令，直接调用同步服务，没有在入口获取同一 MCP 操作锁；服务的读取旧值、保存新值、跨文件同步、恢复旧值是分开的调用（`src-tauri/src/services/mcp.rs:22`、`:27`、`:207`）。数据库 `lock_conn!` 仅覆盖每次 DAO 操作（`src-tauri/src/database/dao/mcp.rs:14`、`:92`、`:120`），不是整条业务事务；更新 SQL 也没有旧版本条件。

**有效竞态见证必须这样限定**：同一 ID 的 A 保存新值并进入投影，B 在 A 回滚前更新同一 ID 为 S1 并完成；A 随后因另一目标失败恢复自己保存的 S0。`:207` 的无条件 save 会覆盖 S1。可以让 A 涉及一个坏配置目标、B 只更新可写目标，以避免把“两者必然一起失败”当成证据。需要真实重叠执行；正常单组件顺序点击并不能证明该调度出现。

**需收窄的部分**：

- provider 重投影（`src-tauri/src/services/provider/mod.rs:2793`、`:3373`）本身不是“第二笔 MCP DB 保存 S1”，因此只能支持并行 live/ledger 风险，不能单独证明 MCP 旧 DB 快照覆盖另一成功 DB 更新。
- ledger 的 load→写 live→save 没有整体版本条件（`src-tauri/src/services/mcp.rs:238`；`src-tauri/src/mcp/codex.rs:294`、`:304`），但发生丢更新仍须两个操作实际交错。不能仅看到无锁就称已经观察到错误配置。
- Codex 单次文件写确有 CAS（`src-tauri/src/codex_live_write.rs:66`、`:253`）；它不覆盖前面的 DB 旧快照，也不串行化整个多工具流程。“没有完整业务事务锁”不等于“项目所有写入都没有 CAS”。

**判定/建议**：保留 P1 并发一致性风险候选，不将其表述为单次操作必发；先用受控 barrier 对同 ID 的两次调用证明回滚覆盖，再选共享操作锁/版本条件补偿。必须让 MCP 命令、provider 重投影和 Codex 专用开关遵守一致锁序；只给其中一个入口加锁不构成闭环。本次不运行 Rust，未验证实际 Tauri 运行时调度。

## 5. B05 — 成立：Windows 同类 lifecycle 请求共享脚本路径

**直接证据**：`src-tauri/src/commands/misc.rs:189` 每次请求独立进入 `spawn_blocking`（`:207`），没有后端作业级串行化。Windows 执行器 `:236` 使用 `temp_dir/cc_switch_{label}_{pid}.bat`，先写内容，再 `cmd /C` 启动，退出后删除同一路径（`:245`、`:250`）。同进程同 label 没有工具名或唯一请求 ID，路径碰撞不需要推测。

**UI 可达条件**：`src/components/settings/AboutSection.tsx:633` 调安装/更新 API，状态位在组件实例内；它在设置工具区和部分 ToolView 中都有挂载入口。离开旧实例不会取消已在后端执行的进程。当前这一实例内的顺序批处理及禁用按钮不能充当后端全局锁。

**限定而非扩大**：label 是 `tool_install` 或 `tool_update`（`src-tauri/src/commands/misc.rs:200`），因此同进程 install/install、update/update 会碰撞，install/update 不共用路径。跨进程 PID 通常也不同。至少可以构造 A 写完脚本、尚未 spawn/读取，B 覆写脚本，A 执行 B 内容的窗口；无需假设 cmd 已运行后一定会重读任意后续行。另一请求删除脚本的影响同样取决于时序。版本复核仅能发现部分结果异常，不能撤回错装副作用。

**固定上游反证**：`CC/src-tauri/src/commands/misc.rs:291` 每次创建独立 tempfile 目录并保活到 `.output()` 返回，已消除该路径共享问题。B 对此确为“固定快照已处理”的判断成立。

**最小建议/验证**：每请求独立临时目录，生命周期内持有目录句柄；同工具并发进一步用后端锁约束。后续只用假执行器/barrier 检查路径、脚本内容与清理隔离，不应通过真的并发安装来试错。

## 6. B09 — 成立：删除凭据后解绑保存失败被吞，可能普通成功返回

**完整链路**：`src/views/OfficialAccountsView.tsx:407` 调 remove，下一行先显示成功，再重新加载。`src-tauri/src/commands/official_accounts.rs:158` 先 `vault.remove_account`，获取官方线路后逐条清 pin；`:163` 的 `let _ = state.db.save_provider(...)` 丢弃保存错误，最终 `Ok(())`（`:166`）。`src-tauri/src/codex_accounts/mod.rs:99` 的 set_pin 只是修改内存对象，不能替代 DB 保存。

**失败见证及边界**：Vault 删除成功、official_lines 查询成功，但其中一条 provider 保存失败，即可普通成功返回并留下原账号 key 绑定。多条线路也可能部分解绑。若 Vault 删除本身或线路查询失败，`?` 会返回错误，不能称“任何删除失败都无条件成功”。前端后续刷新是否再提示其他错误也不改变原删除命令已经错误返回普通成功。

**避免误报影响**：Vault 的删除范围是 slot/candidate/tombstone（`src-tauri/src/codex_accounts/vault.rs:501`），不是本项证明删除了当前 Codex live auth.json 或远端登录状态。保留 P2 的本地一致性/结果报告问题，不升级成已发生凭据泄露、远端注销或所有会话不可用。

**上游关系/最小建议**：B 已正确注明 CPP 文档不能证明同事务实现，本轮不追加源码推断。至少传播解绑失败及部分结果；更完整的方案是数据库事务化解绑配合可恢复删除意图，确保删凭据与清关联的失败能重试、不能假成功。隔离验证应让第二条 provider 保存失败，检查 IPC 结果及残留绑定；本次未进行故障注入。

## 7. B10 — 收窄：同 ID 冲突合并成立，后续跨工具覆盖须区分 Codex 保护及潜伏入口

**直接证据**：`src-tauri/src/services/mcp.rs:636` 的 `import_target` 优先按 ID 命中即返回已有对象（`:640`）；内容规范化比较只用于没有命中 ID 的后续分支（`:643`）。`save_imported_servers` 遇 SameId 仅把目标 app 设 true，仍保存首个 spec（`:532`、`:554`）。`import_from_all_apps` 按 Claude、Codex、Gemini 等顺序导入（`:599`）。因此 Claude `db=测试库`、Gemini `db=生产库` 在同 ID 下不会保留两份不同管理定义，成立。

**可达性维持 B 的限定**：`src-tauri/src/commands/mcp.rs:199`/`src-tauri/src/lib.rs:1772` 注册接口，`src/lib/api/mcp.ts:126` 有包装；当前 SkillsMcpView 没有扫描纳管按钮，启动导入策略关闭（`src-tauri/src/product_policy.rs:268`）。这是开放该入口前应修复的潜伏缺陷，不是“当前每次启动自动覆盖配置”。导入本身没有 live 写回（服务 `:518` 的契约及 `:528` 后的实际操作一致）。

**需要收窄后续影响**：对于 Gemini/Claude，后续投影按 ID insert 首个 spec，覆盖不同本地内容的路径可成立（`src-tauri/src/mcp/claude.rs:117`、`src-tauri/src/mcp/gemini.rs:111`）。但若冲突目标是 Codex，`src-tauri/src/mcp/codex.rs:397` 会检查 ledger/内容；不属本产品且与待写入不同的 live 条目会记录 conflict 并保持原样（`:402`）。所以不能一概声称“所有工具冲突在后续同步必然覆盖”，更不能推导“凭据已经外泄”。即便 Codex 阻止落盘，DB 错误合并与错误关联本身仍存在。

**上游/建议**：固定 `CC/src-tauri/src/services/mcp.rs:344`、`:382` 同样保留先到内容并开启目标标志，是继承的导入冲突缺陷，不应写成上游已解决。最小修复是同 ID 也比较规范化内容；不同时返回可见冲突或建立有明确映射的新 ID，不静默合并。未来隔离验证分开断言：导入阶段只读 live；DB 不丢两份语义；后续投影不覆盖另一工具原配置；Codex conflict 不被错误报告为成功同步。

---

交接：优先保留 B01/B02/B03/B05 的阻断性风险，B09 修复错误传播；B04 用隔离并发实验确认具体调度，B10 在开放纳管 UI 前处理。此处只表达交叉复核意见，不修改首轮 A/B 的问题编号、原始定级或封存内容。
