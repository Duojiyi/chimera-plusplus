# Repair Recheck B：独立闭环复核

## 状态与边界

最新状态：源码结论已完成，不等待命令结果。已核读上一轮 Rust lib 日志 2921 passed / 0 failed / 2 ignored（22:11:23）。随后用户通知 strict Clippy 首轮有 6 个 test-only lint，已最小修改测试，Clippy 重跑中、lib 全量待再次复跑；最新改动后的命令结果尚未确认。前端全量 158 文件 / 1349 项通过为用户提供结果。本线程没有运行 Rust。历史结果仅对应当时版本，以本段和末尾状态更新为准。

日期：2026-10-03。源码复核报告封存：B-05/MCP/usage 最新快照复核完成，Rust lib 最终日志已核实通过；RC-B-01 已依本轮未发布证据排除升级阻断；其它版本边界见末尾。本报告不修改或替代首报 `2026-10-03-repair-independent-B.md`。

用户已允许交叉读取 A；本轮读取 A 首报并核对 A-03、A-05 的原始触发条件。修复交付说明只用于确定范围，不作为实现正确的证据。未读取其他修复者结论。

只读产品代码与测试；仅新增本文。没有操作真实用户配置、凭据、CLI 安装或登录。没有 Rust 编译，没有 cargo tests/check/clippy/build 或 Tauri 构建。前端测试使用现有 mocks。

“源码闭环”表示原触发链在已审版本中被截断，并有针对性的测试源码或前端执行佐证；不等于 Rust 测试已通过，不等于真实系统已验证，更不等于绝对零缺陷。本阶段没有新增可确认问题。

## 闭环矩阵

| 项目 | 本轮结论 | 核心依据 |
| --- | --- | --- |
| B-01 MCP Codex 冲突隐藏成功 | 源码闭环；Rust 待运行 | 冲突返回 Err，统一事务恢复 DB/账本/已提交投影，IPC 传播错误 |
| M02 MCP 批量修复边界 | 源码与测试设计核对通过；Rust 待运行 | repair 逐项补偿、累计错误并继续；用户 batch 保持整体原子 |
| B-03 Skill 生命周期并发 | 源码闭环；Rust 待运行 | 单一生命周期锁覆盖下载、备份、替换和数据库提交；竞争操作明确拒绝重试 |
| B-04 Skill SSOT 部分删除 | 源码闭环；Rust 待运行 | 独立备份先恢复 SSOT，成功后才恢复应用投影 |
| A-03 非 Codex Prompt 事务 | 源码闭环；Rust 待运行 | 文件 CAS → DB transaction；DB 失败条件回滚文件，旧库快照校验 |
| A-05 Skill 更新备份失败仍覆盖 | 源码闭环；Rust 待运行 | 强制持久备份成功后才能 staging/swap |
| B-08 Windows 默认程序探测 | 原报告场景源码闭环；Windows Rust 待运行 | 共享默认解析器，已解析默认程序失败不扫描备用 |
| B-09 Usage DTO/前端语义 | 源码与前端测试闭环；Rust 待运行 | 序列化语义字段，按 TOTAL/FRESH/LEGACY 归一化，显示非零 creation |
| B-10 Provider/Model 总量 | 源码闭环；Rust 待运行 | 两种汇总的 raw/rollup 都计算四项总量，有同数据集对账测试 |
| B-11 Grok 回填 | 源码闭环；Rust 待运行 | 回填白名单包含 grokbuild，语义回归测试覆盖三种 app |
| B-02 跨应用 MCP UI | 源码与前端测试闭环 | 仅 Codex 检查 server.enabled；五种非 Codex 工具跨目标 on/off 与重新加载回归通过 |
| B-05 账户删除一致性 | 当前范围源码闭环；Rust 运行验收待定 | DAO 保留提交时本地 pin，快照替换对齐本地绑定，回填锁内只刷新现存槽位；详见最后补充 |
| B-06/B-07 Desktop 所有权/回滚 | 源码闭环；Rust 待运行 | 保留 enterpriseConfig；按已提交回执条件恢复，详见补充复核 |

## 实现与测试证据

### B-01 / M02：MCP

`src-tauri/src/mcp/codex.rs` 的 `ownership_conflict` 已用于更新和删除的冲突分支。删除不仅检查 recorded，还检查调用方提供的 previous spec，覆盖无旧账本但有历史期望值的情况；repair 中从未纳管且未启用的同名外来条目不应被强制接管或错误删除。

追踪 `commands/mcp.rs` 的真实 Tauri 命令到 `upsert_mcp_server_result`、`toggle_mcp_app_result`、`delete_mcp_server_result`，再进入 `services/mcp.rs` 的统一事务。错误不再变为成功结果；`with_projection_undo` 恢复本次已提交变更及账本，外层恢复数据库行。冲突时保持外部条目不变。

`sync_app_locked` 对每条 server 建立独立补偿边界，累计带 ID 的错误，继续处理后续条目。用户批量变更仍走整体事务，不把 repair 的 best effort 混入用户 batch。

阅读的新增测试包括：

- `codex_conflicts_reach_service_and_ipc_without_changing_db_or_external_content`：有/无账本，service/IPC，update/disable/enable/delete 的组合；断言 DB、两个账本及其它客户端字节均不被残留修改。
- `single_client_repair_continues_after_multiple_errors_and_keeps_successes`：中间两项冲突仍处理后续项，错误包含两个 ID，成功项保留所有权。
- `user_batch_remains_atomic_when_a_later_server_conflicts`、`codex_repair_reports_each_conflict_but_ignores_unmanaged_disabled_names`：区分用户批量与修复语义。

边界：IPC 测试调用实际命令共用 helper，不是完整 Tauri WebView E2E。外部进程冲突仍可能导致补偿明确失败，不承诺跨进程绝对原子性。未运行 Rust。

### B-03 / B-04 / A-05：Skill

`services/skill.rs` 使用进程级 `SKILL_MUTATION_LOCK` 和 `try_lock`；竞争操作立即返回“稍后重试”，没有在同步命令中等待下载持锁者。安装、更新、卸载、切换、恢复、导入、迁移、同步等写入口均核对过；内部受锁函数避免递归取锁，兼容 `copy_to_app` 进入受锁同步入口。

`update_skill` 在读取原记录前拿锁，锁跨越下载 await、备份、swap、DB 保存及投影。首报中的“等待期间切换”和“备份后、swap 前卸载”不能再由这些正常服务入口成功交错。`lifecycle_boundary_rejects_toggle_uninstall_and_update_at_both_checkpoints` 在持有同一锁时由另一线程调用真实入口，验证拒绝且文件/DB 不变，释放后允许操作。

测试边界：这项测试手工持有相同锁，并未驱动真实下载的两个暂停点；源码检查确认生产函数的 guard 作用域覆盖这些阶段。后续下载实现变更时仍需保持 guard 生命周期。

SSOT 删除改走 `remove_ssot_with_recovery` → `recover_uninstall` → `restore_skill_from_backup_to_ssot`。后者从独立备份 staging 后 swap 残缺目录；恢复源失败时停止投影恢复并保留备份位置，避免继续从损坏源复制。恢复完成但旧残缺目录清理失败只警告，不把已恢复 SSOT 错当失败并重删。

`partial_ssot_delete_restores_independent_backup_before_projection` 确实先删除 SKILL.md 再注入失败，验证两个文件在 SSOT 与投影恢复，并验证独立备份无效时不会从损坏源投影。这比只在删除前返回错误更贴合 B-04。

`require_update_backup` 要求备份为 Some 且成功，出错清理下载目录后返回；调用位于 staging/swap 前。`update_backup_failure_aborts_and_cleans_download_without_touching_source` 用文件阻塞备份根目录，同时证明原 source 可写，断言本地修改未变、下载被清理、随后正常备份保存 SKILL.md 与 meta.json。该测试调用备份 gate，而非网络更新端到端；gate 的生产接线已核对。

仍有明确边界：共享锁不约束外部程序；它会让同时进行的其它 Skill 操作返回忙，属于当前可见行为。恢复可因真实锁定/权限再次失败，现有错误会报告，不保证必然成功。应用副本的外部本地修改不等价于 SSOT 备份，未将所有投影逐字回滚提升为新承诺。

### A-03：Prompt

`services/prompt.rs` 非 Codex upsert/enable 使用 per-app switch lock，构造 before/next 和文件 Changeset；不再先保存库记录再盲写文件。禁用与启用编辑都进入 `commit_non_codex_prompt_changes`。未启用条目的编辑保持 live 不变。

提交次序为：CAS 提交文件 → `persist_non_codex_prompts` 短 SQLite transaction → 成功提交。DB 事务比较整库行数及原有每行所有相关字段，拒绝绕过操作锁的旧快照覆盖。DB 提交失败后调用实际 AppliedChangeset 的条件回滚；回滚冲突会明确返回“数据库未提交，请检查生效文件”，不是静默覆盖外部新内容。

阅读测试：`live_file_failure_preserves_enabled_body_and_flags`、`database_failure_rolls_back_file_and_every_enabled_flag`、`failed_insert_restores_missing_live_file`、`inactive_edit_preserves_live_and_enable_backfills_local_edits`、`stale_file_or_database_snapshot_cannot_overwrite_newer_edits`。覆盖编辑/禁用文件失败、部分 DB 写入触发器失败、原文件不存在、未启用编辑，以及过期文件/库快照。

边界：文件与 SQLite 不是单一持久事务，进程崩溃或文件写入后外部客户端立即读取仍有窗口；当前闭环针对 A-03 的可返回错误路径。源码没有承诺跨崩溃恢复。未运行 Rust。

### B-08：Windows 程序默认状态

`commands/misc.rs` Windows 版本卡已调用 `probe_windows_default_or_fallback(resolve_path_default(...), ...)`，与安装枚举共用默认路径解析。已解析路径的非零退出、空版本输出、执行错误都返回 FoundButFailed，不再因其它安装成功而消除错误；只有没有默认路径时才扫描备用。函数还在执行前拒绝 WindowsApps alias 目录。

`path_default_version_and_failure_are_not_masked_by_alternative` 使用 tempfile 的 CMD 脚本覆盖成功、失败，fallback 闭包在不应执行时 panic；None 才返回备用。没有执行真实安装。

测试/契约边界：此用例测试注入默认路径后的分支，不是多 PATH 目录真实解析测试，也未测试 alias 拒绝。`resolve_path_default` 仍返回 Option，where 执行/超时/规范化失败与不存在都映射 None。因此“不回退”保证针对已经成功解析的默认项；默认路径解析故障仍可能进入 fallback。这是保留的诊断边界，不据此宣称本机存在缺陷，也不把该场景标为已验证。

### B-09 / B-10 / B-11：Usage

`services/usage_stats.rs` 的 RequestLogDetail 不再跳过 input_token_semantics 序列化，camelCase DTO 带 `inputTokenSemantics`。`src/types/usage.ts` 的 `getFreshInputTokens` 按 2=FRESH、1=TOTAL、0/缺省=LEGACY 计算；TOTAL 扣 read 与 creation，缺省保留兼容策略，异常计数回退与 `fresh_input_sql` 的有效语义范围一致。

追踪 `RequestLogTable` 与 `RequestDetailPanel`：共用归一化 helper，实际非零 cache creation 可以展示；`UsageHero` 在实际 creation > 0 时优先显示数值，不被 app 推断的 N/A 覆盖。

Provider 汇总的 raw 和 rollup SQL 均已改为 fresh+output+read+creation，与 Model 和总览 realTotalTokens 对齐。`request_semantics_are_serialized_and_cached_totals_reconcile` 构造 Grok 的 LEGACY/TOTAL/FRESH 日志和 FRESH rollup，序列化真实 detail DTO，并验证 summary/provider/model 总量均为 5100。

成本回填白名单包含 grokbuild；`test_backfill_distinguishes_legacy_and_total_cache_semantics` 对 codex/gemini/grokbuild 实际调用 backfill_missing_usage_costs，再读库断言 LEGACY 与 TOTAL 的输入费一致。不是只测实时 calculator。

前端 `usageTokenSemantics.test.ts` 验证三种 app 的语义值、缺省、异常计数及 Claude；`UsageHero.cache.test.tsx` 以 Codex 非零 creation 数据验证实际数值显示、没有 N/A。Rust DTO/SQL 与前端 helper 的桥接仍是两侧测试加源码对照，不是运行真实 IPC 的集成测试。

## 本线程验证

```text
node_modules/.bin/vitest.CMD run tests/utils/usageTokenSemantics.test.ts tests/utils/usageMetrics.test.ts tests/utils/usageDisplay.test.ts tests/components/UsageHero.cache.test.tsx tests/components/RequestLogTable.test.tsx tests/components/PromptsView.test.tsx tests/components/SkillsMcpView.test.tsx tests/components/AboutSection.tools.test.tsx --maxWorkers=2
```

结果：2026-10-03 21:16:47 开始，23.00s，8 个文件、102 项测试全部通过。仅出现 Node localStorage 实验性警告。测试使用 mocks，不触及真实用户配置。

Rust 编译/测试/clippy：未运行，待主线程统一验证。未以主线程已通过测试的说明替代本线程执行记录。阶段一执行时 B-02/B-05/B-06/B-07 尚未完成复核；后续进展见矩阵与下方补充。本文不作为整批修复最终验收。

## 已审源码快照

下表用于识别本阶段结论的版本。后续修改须重新核对；不表示穷尽每个文件所有行为。

记录时间：2026-10-03T21:20:38.9302677+08:00

| 文件 | SHA-256 |
| --- | --- |
| `src-tauri/src/mcp/codex.rs` | `EFCE92D492C69848710BD7F591CBEB03E51151E8B22D5239573F76CDA2F02A58` |
| `src-tauri/src/mcp/service_regression_tests.rs` | `A1EFAACDFAFA6593B2589B2AC0D9FF5EF765EE28B827FC6D5EA79CC316F2E6AA` |
| `src-tauri/src/services/mcp.rs` | `D3D04D291E895EF3CA5609B9683B52FEDBB77EBED6F1F63EAC3E941104D2B3D7` |
| `src-tauri/src/commands/mcp.rs` | `85BCAC8B8A858A997C46C7F6CD00418E3DD884FE35A0ACE3DE0DFA4E14DCE925` |
| `src-tauri/src/services/skill.rs` | `791B88D90B065E6FE997D75456FC6F190971A9F5BADEFF7914C0668E64F01BC0` |
| `src-tauri/src/services/prompt.rs` | `644A024712B62B9637621BA28BC27ED7D2B57EE2FEB74FD237DBC0BD0E583F6C` |
| `src-tauri/src/services/usage_stats.rs` | `D1D5B4E5C1F7ED7245EE375BC0EA49EC6A4E9C75D1EE2FE227C3E96D7A75665C` |
| `src-tauri/src/services/sql_helpers.rs` | `5B08EE8F253F335D67C9871E47778D2395EEBA78D1F65E733FB9B9AF45E69B17` |
| `src-tauri/src/commands/misc.rs` | `074FE57D3901C561274A110EF49D7FD888A0E0256D7051395791BE35484C6B74` |
| `src/types/usage.ts` | `B8DB6E59E662F542DEC1D26D3616FE40E7FE37214862C3E07FA495F1BC7519F8` |
| `src/components/usage/UsageHero.tsx` | `4D5E72C2B9EDFBACF90462442ED77C89936A054EE3AF211A412A2CDAF5D298EE` |
| `src/components/usage/RequestLogTable.tsx` | `855ED6F6431F9443BA23FADC42341EE951E08BDE88A830A07D0B1B197C4EB511` |
| `src/components/usage/RequestDetailPanel.tsx` | `3C6BE6F403AFC54E30B3B38F1A03584AFCBFB3C60D17FFBC9DAC8FB366871B33` |


## 补充复核：Desktop、详情总计与账户主路径

### B-06/B-07：Desktop 源码闭环，Rust 待运行

在用户通知稳定后，复核完整 Desktop 配置变更链及其 status、平台路径、provider/live 快照接线；模型路由不是本轮新增缺陷验证的重点。本轮读取 `claude_desktop_config.rs` 的计划、提交、所有权、回执、恢复实现及新增测试，不以交付说明替代证据。

B-06：`plan_desktop_config` 仅改变部署模式，保留 enterpriseConfig，不再按字段名猜测归属。官方恢复只在 meta 的 `ccSwitchProfileHash` 与当前 profile 字节哈希一致时删除 profile；外来、历史无哈希、已编辑的 profile 保留。`update_meta` 仅撤销本程序 profile entry，未归属本程序的 appliedId 不被清除。读取 `official_preserves_unowned_enterprise_config_and_profile` 和 `official_preserves_edited_owned_profile_and_copied_enterprise_fields`，覆盖首次 official、外来字段、相似 profile/appliedId 不足以证明 enterpriseConfig 归属的情况。

B-07：写入先计划 CasSnapshot/Changeset，提交前检查观察字节。外层 LiveSnapshot 不再直接盲写四份 capture 内容；成功提交时绑定实际修改文件的回执，回执包含实际写入前字节和本次写入值。恢复仅遍历这些文件，当前值不等于本次写入值则报冲突并继续尝试其它文件。文件新建、删除和 no-op 的回执均区别处理。捕获后、写入前的外部修改在重新计划时被纳入实际 before，恢复不会倒退到过时 capture。

新增测试源码覆盖：计划后外部修改/创建导致提交拒绝；未提交的 snapshot 不碰外部新文件；已提交后外部编辑/删除/重新创建保留并报冲突；一个文件失败仍尝试其它文件；使用实际 prewrite 字节；no-op 消费观察者；旧 snapshot 不接管后续切换。`services/provider/live.rs` 的 Desktop 恢复分支仍调用此 restore，因而不是只改了无调用 helper。

边界：回执绑定依赖当前“每个 snapshot 对应下一次同目录切换”的生命周期与应用切换串行化；未做真实 Desktop 外部进程或跨平台文件锁测试。CAS 避免盲目覆盖，不构成系统级多文件不可中断事务。B-06/B-07 的首报触发链已在源码中截断，Rust 运行验证仍交由主线程。

### B-09 补充：RequestDetailPanel 总计

用户另行通知发现并修正详情总计遗漏缓存；本线程独立核对当前 `RequestDetailPanel.tsx` 的总计表达式已为 freshInput + output + cacheRead + cacheCreation，不把用户发现冒充为本线程新增发现。

读取并独立执行 `RequestDetailPanel.tokens.test.tsx`，真实组件在 TOTAL/FRESH/LEGACY 输入下分别显示 fresh 200/1000/400、总计 1050/1850/1250。连同 Hero 和语义 helper 复跑：

```text
node_modules/.bin/vitest.CMD run tests/components/RequestDetailPanel.tokens.test.tsx tests/components/UsageHero.cache.test.tsx tests/utils/usageTokenSemantics.test.ts --maxWorkers=2
```

2026-10-03 21:21:56 开始，8.41s，3 文件 / 8 测试通过。与前一轮有重复测试，不将两个执行次数简单相加冒充独立用例数。此补充覆盖阶段一 RequestDetailPanel 源码哈希后的最新版本。

### B-05 主路径：已核对，但整体未关闭

当前 `codex_accounts/mod.rs` 引入共同 ACCOUNT_MUTATION；save_current_login 从读取 live 到 store_slot、register_account_line 均持锁。register_cli_login 在同一锁下保存 CLI 槽位、pin default 和登记线路。`commands/official_accounts.rs` 删除 helper 在读取绑定列表之前取同一锁，直到 remove_credentials 返回后才释放。

`login.rs::capture_cli_login` 只读取、验证并返回身份与 auth；poll 完成并释放 ACTIVE_LOGIN 后，命令层才调用 register_cli_login，未在登录锁下反向获取账户锁。登记内部 helper 接收 guard，避免同线程重复取非重入锁。

阅读 `deletion_serializes_live_save_and_cli_registration_through_vault_removal`：用通道暂停删除在解绑后/移除槽位前的位置，另线程分别调用保存与 CLI 登记，验证不能提前完成；释放后最终槽位和单一绑定一致，反向串行删除后两者皆无，live auth 未被改写。这是线程交错测试源码，不是本线程执行结果。

用户通知 generic provider update 的旧 pin 及 switch 回填路径仍在扩展处理。即使上述三条首报主路径已被共同锁保护，也不能据此宣布所有 DB/vault 写入口一致。B-05 保持未关闭，等待 services/provider/* 最小扩展稳定后追踪调用链和锁顺序。B-02 在下方补充复核中已闭环。

## 补充快照

记录时间：2026-10-03T21:25:25.4606954+08:00

| 文件 | SHA-256 |
| --- | --- |
| `src-tauri/src/claude_desktop_config.rs` | `9701E47D39CD047C06C45E6178354851CCCE3FF59F8B40842AA5458F5A1ED6DA` |
| `src/components/usage/RequestDetailPanel.tsx` | `3C6BE6F403AFC54E30B3B38F1A03584AFCBFB3C60D17FFBC9DAC8FB366871B33` |
| `tests/components/RequestDetailPanel.tokens.test.tsx` | `ABE2F98CF8F511ED1A1ACA4BB703E4ED27A01D43C674062C2E33F647E8B91896` |
| `src-tauri/src/codex_accounts/mod.rs` | `619B9742457139206ADCC367575ED4F7841DBBBF71D8DA7C370492BC6A8D8CD0` |
| `src-tauri/src/codex_accounts/login.rs` | `490258A269BBC071F92022F3D5E19D924AF4966B2AFFF059560A1706E0704198` |
| `src-tauri/src/commands/official_accounts.rs` | `EB55B2869340F826138EA785C6BF4DC2C9DC44793D4D1DF6EFCE9B1BEBF8CBB2` |

## B-02 与云配置入口补充复核

### B-02：跨工具 MCP 开关

`src/views/SkillsMcpView.tsx:151` 的派生状态为 `apps[targetApp] && (targetApp !== "codex" || server.enabled !== false)`。`handleToggleMcp` 对此状态取反调用 `mcpApi.toggleApp`，操作后重新读取权威数据。Codex 的软禁用标记不再覆盖非 Codex 的 apps 标记。

`tests/components/SkillsMcpView.test.tsx:415` 对 claude、gemini、grokbuild、opencode、hermes 分别执行：先关闭 Codex，再切换目标工具，开启、关闭，并在每次操作后切回 Codex 验证仍关闭。mock 按后端语义分别更新 `server.enabled` 或 `apps[target]`，每次重新加载验证 UI、计数和参数，断言 4 次 getAllServers 与 3 次 toggleApp。另保留 Codex-only on/off/on 回归。本项源码与前端定向执行闭环；mock 测试不是 Tauri 与真实配置文件端到端测试。

### 新云配置入口：有界补审

范围为 `SyncPanel.tsx`、`SyncConfigForm.tsx`、`NewSettingsView.tsx` 挂载与刷新、`lib/api/settings.ts` 的保存映射，以及后端 `commands/webdav_sync.rs` / `commands/s3_sync.rs` 保存命令到 `settings.rs` 的本地持久化。没有扩大到云协议、全站权限或整个导入恢复事务审计，没有发起真实同步网络。

源码证据：

- NewSettingsView 默认不挂载同步面板；须用户点击展开，且设置尚未加载时禁用入口。SyncPanel 无挂载即调用远端 API 的 effect。
- 表单保存明确构造 `enabled: true, autoSync: false`，调用对应 save-settings API，成功后仅调用父级 onRefresh。后端保存命令执行凭据保留、normalize、validate、set-settings；set-settings 进入持锁的 mutate_settings，本地文件保存成功后更新内存，没有测试连接、上传或下载调用。
- 保存刷新链重新读取 settings 并通知 provider 刷新；表单保存不调用 invalidateQueries。既有 autoSync 配置的手动上传/下载按钮禁用，提供显式关闭自动项按钮。此处结论是新入口不主动启动远端操作，不承诺取消此前已运行的后台任务。
- secret 输入不预填，提交即清空 DOM；留空时 `passwordTouched=false`，后端保留已有凭据。通用失败文案不回显后端可能含凭据的错误。保存失败不报告已完成；保存后刷新失败可明确报告操作未完整完成。
- 上传/下载均需确认；下载先检查远端兼容信息。下载后的审核读取失败仍尝试刷新，重试审核不重复下载；组件 ref 锁覆盖异步操作，防重复提交。

边界与测试不足：

- 留空保留凭据不比较 endpoint/用户名/accessKeyId 是否改变，依赖表单已有提示要求换服务器或身份时填写新凭据。不能将留空解释成清除凭据，也未证明跨目标凭据迁移受自动拦截。此处作为显式行为边界记录，未升级为本轮新增缺陷。
- 组件锁不是跨窗口/跨进程的配置事务锁；保存命令读取旧凭据/状态后再写入，未在本轮证明它与其它配置编辑入口的并发合并性质。
- getCodexImportReview 不在 mount 时读取，只有下载后或显式“重试审核与刷新”时读取；本轮没有验证重开面板时既有待审核状态的完整用户流程。
- 集成测试 mock 了 SyncPanel，仅验证懒挂载与父级刷新；组件测试 mock 后端 API。两层证据不能替代真实 Tauri、云端存储或后台调度端到端验证。没有据此关闭整个云同步系统的风险。

本次有界补审没有新增可确认问题。无发现不等于绝对零缺陷。

### 本轮执行

2026-10-03 21:36:39 开始执行：

```powershell
& node_modules/.bin/vitest.CMD run tests/components/SkillsMcpView.test.tsx tests/components/SyncPanel.test.tsx tests/integration/NewSettingsSync.test.tsx --maxWorkers=2
```

结果：3 个文件、62 项测试通过，耗时 10.52s。仅见 Node localStorage 实验性警告。覆盖新配置保存、凭据不回显/留空保留、失败清理、自动项关闭、确认取消、重复提交、审核/刷新恢复以及 B-02 跨工具序列。与前次测试有重叠，不累计为独立覆盖项。Rust 编译、测试与 clippy 仍未运行。

B-05 仍等待 provider 写入口扩展稳定后复核，本报告尚不是整批最终验收。

### 本轮文件快照

记录时间：2026-10-03T21:39:19.1270191+08:00

| 文件 | SHA-256 |
| --- | --- |
| `src/views/SkillsMcpView.tsx` | `7A65A76529AFA1DDC11AC0F7D14E2AC4FF118A5D75D1634FF4D0726621D62621` |
| `tests/components/SkillsMcpView.test.tsx` | `39D4B97CFFCE7186576FFD94576F03705DCF0A1DAF793042B6983537D9B75F89` |
| `src/components/settings/SyncPanel.tsx` | `7EDE03337ABFA0AB3C1DC909CC99DAECEA15C548304185468FFF9ACE768319C5` |
| `src/components/settings/SyncConfigForm.tsx` | `F46498F1AA65656D0729B92947B49954A6105E5653073F000A7680EC1FB1A1BC` |
| `src/views/NewSettingsView.tsx` | `AA970AC634D11A6133D26878E290E1BEF13313F885457A156540A3FBF9632712` |
| `src/lib/api/settings.ts` | `10F980626D994BF09A127C3B5EE8B889F11AE4EE8C3B9D9A7278E0F45A260B22` |
| `src-tauri/src/commands/webdav_sync.rs` | `6182A845662E778085F89202BF14AE0877613451494E8902055969D3BCFA5FB2` |
| `src-tauri/src/commands/s3_sync.rs` | `B976E82C1E51192D6751D4F00B3B0395D74F013A47E73583D093619FCCAB8215` |
| `src-tauri/src/settings.rs` | `F4220E667E0EEA8D6DEE4BA9A08F54E55F33D4269CA63196C619F4215F5AD2B3` |
| `tests/components/SyncPanel.test.tsx` | `9BB1EC8C549AD2CDB83F1BF74A392A6465833A67A1300FA4555156153C696109` |
| `tests/integration/NewSettingsSync.test.tsx` | `0BA1D4B85E5D94BB1D7436BDD2F4DAB3E8735AC93E450D8C4C0E1F23D3611360` |

提交前快照核对：本报告各路径最新快照中，仅 src-tauri/src/codex_accounts/mod.rs 与 src-tauri/src/commands/official_accounts.rs 已发生后续变化；其余记录匹配当前磁盘。账户主路径的前次核对结论仅对应上表较早快照，不自动适用于这两个新版本；B-05 待稳定后连同 provider 扩展一起复核。未以更新哈希代替重新审查。

## MCP 哈希与 Usage SQL 运行失败补审

本次只读实现与测试；没有修改产品，没有运行 Rust。用户通知的 stream 空格 chunk、skill 目录夹具、vault 来源夹具失败本次未独立复核，也未据说明判定已解决。账户 provider 扩展继续等待稳定。

### MCP 对象顺序

`src-tauri/src/mcp/projection.rs::hash` 对 Value clone 调用 `sort_all_objects()` 后序列化、计算 SHA-256。递归规范化对象键，包括数组中的对象；数组元素顺序仍有语义，不排序数组。live hash 与写入 owned 的 hash 共用此函数，避免投影序列化/解析重排键后误报所有权冲突。此处作用于非 Codex 投影；Codex 的 `codex_mcp_table_hash` 仍使用 `canonical_toml_item`，其 table 递归排序、array 保序逻辑已核对，不能误述为所有客户端都改了同一个哈希函数。

新增 `ownership_hash_ignores_object_order_but_detects_content_and_array_changes` 覆盖顶层键、env 嵌套键、数组内对象键重排相等，并断言值变化、数组逆序不等。`codex_soft_disable_does_not_disable_other_clients` 覆盖五种非 Codex 格式写出后重读删除，以核对序列化前后 ownership 匹配。上述是测试源码证据，未在本线程执行 Rust，待主线程确认修后运行。

**条件性兼容风险 RC-B-01：修正前哈希账本没有显式迁移。** `mcp_client_projection_ledger` 不区分哈希版本；当旧实现已写入一个按插入顺序计算、与新规范化摘要不同的记录时，现有 `recorded` 与新 live hash 不相等，且 `legacy_match` 仅在 recorded 缺失时执行。此时用户直接更新为不同内容或删除，会报 ownership conflict，即使 live 没有被外部修改。相同内容的同步会通过 desired==live 分支重记新哈希，可恢复该记录。未发现静默覆盖外来配置的行为。

该条件链可由当前分支逻辑确认；是否实际影响用户取决于旧投影实现是否已生成持久账本，不能假设开发中版本已经发布。新增语义测试使用新 hash 生成两侧摘要，没有覆盖旧哈希记录。应确认无此存量，或增加旧记录更新/删除与外部修改拒绝的兼容性测试后再关闭这个边界。不能直接用无条件 previous 匹配替代所有权检查。

### Usage 详情 SQL

`services/usage_stats.rs::get_request_detail` 已给 token、cost、latency、status、error、created_at 等日志列加 `l.` 限定。LEFT JOIN providers 时，`l.created_at` 明确取请求时间，避免与 provider 创建时间歧义。投影的 26 列顺序与 `row_to_request_log_detail` 保持一致：created_at 仍为索引 22，input_token_semantics 仍为 25。分页列表的对应字段、日期条件和排序也已限定 `l.`。

既有 `request_semantics_are_serialized_and_cached_totals_reconcile` 实际调用 get_request_detail，能在运行时暴露这类 prepare 失败；之前“读过测试源码”不能等同该测试已经通过，此次主线程运行失败正体现该验证边界。

本线程补做非 Rust 的最小 SQL 检查：从当前 get_request_detail 提取真实 SELECT，并展开源码 provider_name_coalesce；Python sqlite3 仅使用 `:memory:` 和合成表/行，两张表都含 created_at，provider 时间与日志时间不同。当前查询成功返回 26 列，索引 22 为日志时间，索引 25 为语义值；对照取消 `l.created_at` 限定，确认报 `ambiguous column name: created_at`。第一次辅助脚本误提取同名 detail_sql 的趋势查询，因未展开其模板失败；改为限定在 get_request_detail 函数内后完成上述验证，没有产品或真实数据库写入。

结论：字段修正在所审 SQL 层有效，但该合成 SQLite 检查不覆盖 Rust 类型转换、完整真实 schema、成本回填或整套 lib 测试，不能替代修后 Rust 重跑。

### 验收状态

- 用户提供：前端全量 158 文件 / 1349 项通过；本线程未重新执行该全量。
- 用户提供：Rust lib 2913 pass / 6 fail，当前不得记为全量通过；修后结果待主线程通知。
- 本线程：仅当前 SQL 内存检查通过、两处实现与测试源码补审完成；MCP Rust 回归未执行。
- B-05 保持未关闭；RC-B-01 作为新增条件性兼容风险保留，不将其混入已证实的真实用户事故。

### 本次补审快照

记录时间：2026-10-03T21:58:36.1768874+08:00

| 文件 | SHA-256 |
| --- | --- |
| `src-tauri/src/mcp/projection.rs` | `451CC5C0759FE5871770EDA50BAFD9F025ABDD0B88432F94632819FA2468838F` |
| `src-tauri/src/mcp/projection_tests.rs` | `B23DCE0447EFF0064E2EC9170C31079FE8A90AD6E966C76EF8841B95C7CC230A` |
| `src-tauri/src/mcp/codex.rs` | `EFCE92D492C69848710BD7F591CBEB03E51151E8B22D5239573F76CDA2F02A58` |
| `src-tauri/src/codex_key_ownership.rs` | `A3DFA45DFDDF8C03B3CFB0909DB18F018AD4ADBF15DD6CDF8B79B1893F2C38E7` |
| `src-tauri/src/services/usage_stats.rs` | `37470E6147C398C9E817110A1BCC9E2A5D54288725387FF3AEEDD6B92772DEDB` |

## B-05 最后源码复核：DAO、快照导入与回填

用户通知账户扩展已保存并要求 worker 冻结；本轮按当前磁盘源码审查，不把该通知当成测试通过证据。范围限于 B-05 的 ordinary provider save、批量/快照导入和 switch-away vault 回填，以及它们与既有删除/登记锁的关系，不扩大到完整 provider 切换系统。前文“B-05 待稳定”的文字为当时阶段记录，以本节和顶部矩阵为最新结论。

### 1. 普通保存只保留 DB 当前 pin

`database/dao/providers.rs:187` 的 save_provider 以 write_account_pin=false 进入内部事务；`save_provider_on_connection` 同样禁止写入调用方 pin，覆盖 `commands/cc_switch_import.rs` 的调用方事务批量保存。

`save_provider_on_connection_internal` 在同一数据库事务/连接锁保护下读取已有行 meta。Codex official 行的 official_account 只取这次读取的 stored_meta，而非 incoming provider；新插入没有 stored_meta，故为 None；改成非 official 分类则解绑。这样 renderer 编辑、切走回填、失败补偿持有的旧对象，都不能重放删除前的 pin，也不能用 incoming None/伪造 key 改写已有绑定。

只有账户模块和删除路径使用 `save_provider_with_account_pin`，当前生产调用均传入共同账户事务 guard。该参数的 Rust 类型是通用 MutexGuard 而不是专用能力类型，因此它不是编译期“只能来自账户锁”的强证明；当前调用点人工核对符合约定。普通 DAO 保存不在 DB 锁内反向获取账户锁。

### 2. 快照替换保留本地提交时绑定

`preserve_local_account_pins_on_connection` 先读本地主库 current lines，移除 staged 各 Codex 行的 officialAccount；只有同 ID 的本地 official 行和 staged official 行同时满足条件时，才填回本地当前 pin。远端新 ID、已解绑本地行、非 official 行均不能从快照导入 pin；其它 JSON metadata 保留。

`database/backup.rs` 的 SQL 导入（含同步导入）、备份恢复最终提交、恢复失败的安全快照回滚，均在主库连接锁持有期间完成 preservation + Backup 写回。不存在“对齐后放锁、删除解绑、再写回旧 pin”的窗口。回滚使用安全备份的内存副本，不修改备份源文件。该路径不获取账户锁，不引入 DB → account 的锁顺序反转。

本地 catalog 读取失败时 helper 用空映射，从 staged 删除所有账户 pin，再进行恢复。这是保守丢弃本地绑定的降级，不是恢复完整账户关系的保证；报告不将此降级误述为无损合并。

### 3. 切换回填不复活已删除账户

真实链为 provider/mod.rs 切走回填 → strip_common_config_from_live_settings → restore_live_settings_for_provider_backfill → vault.refresh_existing_slot。已有 pin 先与 live identity 匹配；vault refresh 自行获取与 remove/register/save-current 相同的 ACCOUNT_MUTATION，在 guard 生命周期内检查 tombstone 和 read_slot。存在 tombstone 或槽位不存在时直接返回，不调用 store_slot，不清 tombstone。

只有槽位存在且可刷新时才调用受身份/新鲜度检查的 store_slot。删除若先完成，回填观察 missing 后跳过；回填若先完成，删除随后清理该槽位。refresh 返回释放账户锁后，外层普通 save_provider 再从 DB 当前值保留 pin，因此即使删除发生在 refresh 与 save 之间，也不会恢复旧 pin。

检查所需 DB 读取均在进入 refresh 前结束，当前链没有持 DB guard 等待账户锁；账户删除持账户锁完成逐行解绑，再删除 vault 凭据。保存当前登录/CLI 注册仍在同一账户锁内执行可信槽位写入及绑定；这些显式登录保存可以重新添加账户，不应与被动旧快照回填混淆。

### 测试证据与不足

阅读 `commands/official_accounts.rs` 的以下测试源码：

- `stale_provider_writes_during_and_after_deletion_cannot_restore_the_pin`：解绑后/槽位删除前普通保存，删除后再次保存，调用方事务保存和复制新行，均不恢复 pin。
- `generic_writes_preserve_the_current_pin_but_cannot_import_one`：incoming None/伪造 key 均保留 DB 当前绑定，新 ID 不带入绑定，改分类解绑。
- `switch_backfill_waits_for_deletion_and_cannot_recreate_a_slot_or_pin`：通道暂停在解绑后/删槽位前，另一线程真实 refresh + 普通 save，检查等待删除完成及最终无槽位/无 pin。
- `backfill_refreshes_existing_credentials_but_preserves_tombstones`：有效已有槽位可更新，tombstone 不清除，删除后刷新不创建槽位。
- `database_snapshot_replacement_keeps_only_current_local_bindings`：保留本地 pin、清除远端新行 pin、删除后 staged + Backup 不恢复绑定，以及损坏本地 metadata 的保守解绑。

这些测试未在本线程运行。回填并发测试调用真实 vault/DAO 原语，而非驱动完整 provider switch；快照测试调用 reconciliation + Backup，不是完整云下载/磁盘恢复失败注入流程。线程等待测试含 100ms 未完成窗口，属于有界并发证据，不是穷举调度证明。账户锁仅进程内有效，不承诺崩溃原子性或协调外部直接改文件的程序。删除部分失败仍遵守明确报错/保留或重试语义，不变成跨 DB/vault 的全局原子事务。

### 明确剩余结论

**B-05 在本次限定范围内源码闭环，没有新增可确认问题；运行验收尚未通过确认。** 不再因 provider 扩展而保持源码待审。主进程已开始的新一轮 lib 编译/测试仅记录为“进行中”，没有收到完成结果前不覆盖此前 2913 pass / 6 fail 的事实，也不把测试源码存在当作执行通过。

整批复核剩余：主线程修后 Rust 运行结果；RC-B-01 的旧哈希账本存量确认或兼容性处理；若 worker 再修改本节文件，只对差异做增量复核。本节不新增无限范围审计要求。

### B-05 最后快照

记录时间：2026-10-03T22:12:00.9009398+08:00

| 文件 | SHA-256 |
| --- | --- |
| `src-tauri/src/database/dao/providers.rs` | `45156A2E5C286CABD3BEF0895CEF002E4014524A293F8D042C7AE26D36066BE1` |
| `src-tauri/src/database/backup.rs` | `289000CB69A9EA0EBD45DFE2005FE1CF90AEC239D480807D66BB3279724E02AB` |
| `src-tauri/src/commands/cc_switch_import.rs` | `528F44BB5FA32F68645239CFC682A7973CCF842929C01DDDC827EA677CC1F4B9` |
| `src-tauri/src/codex_accounts/mod.rs` | `37DBF3E6247BF4D86DBB2A6356C3E47FEF0C319A58E664633E77195AF4FC0852` |
| `src-tauri/src/codex_accounts/login.rs` | `490258A269BBC071F92022F3D5E19D924AF4966B2AFFF059560A1706E0704198` |
| `src-tauri/src/codex_accounts/vault.rs` | `9F5D4B49A3FF14B708A70993173B8C1BD29381000E6D582F171C79CFC7CCE23A` |
| `src-tauri/src/commands/official_accounts.rs` | `8C15E8E57012001607E76B4BC21D559C3144D9FE814B5791A49E02CA494E874D` |
| `src-tauri/src/services/provider/live.rs` | `B90D6CD5ED6464755163D4FC9FDE4EC622B9B23147FF4179AB3F66A947F53A78` |
| `src-tauri/src/services/provider/mod.rs` | `F22C2F98AFF2C030E5B104058127074334CA201D1B8082F19BE8274ED31BCD0E` |

## 最终封存说明

本轮完成用户要求的有界 source review，停止扩大审计范围。未修改产品和首报，未运行 Rust，也未操作真实用户配置。

已独立读取主线程日志 `C:/Users/Administrator/AppData/Local/Temp/chimera-repair-rust-lib-verified.log`（最后写入 2026-10-03 22:11:23）：

```text
test result: ok. 2921 passed; 0 failed; 2 ignored; 0 measured; 0 filtered out; finished in 29.72s
```

日志中确认 B-05 的 deletion serialization、stale provider writes、generic pin preservation、switch backfill、tombstone preservation、snapshot replacement 测试均为 ok；MCP ownership hash 语义测试、usage request semantics/detail 对账测试也为 ok。因此此前 2913 pass / 6 fail 已被此次成功的 lib 运行结果更新，并非把未过运行记作通过。两项忽略为 live S3 connection 与 put/get/head roundtrip，不算通过，不代表真实云存储已验证。

前端全量 158 文件 / 1349 项通过仍注明来自用户，本线程执行过的定向测试记录不变。strict Clippy `--all-targets --no-default-features -j1 -- -D warnings` 用户通知执行中，本报告不推断其结果，也不等待它才完成源码报告。

**最终结论：B-05 限定范围源码闭环，且相关 Rust 回归已从主线程最终日志核实通过。MCP hash 与 usage SQL 的对应测试也已核实通过。没有新增可确认的 B-05 问题。**

明确剩余事项与边界：

- RC-B-01：后续已核对本轮未发布证据，关闭本轮升级阻断，详见末尾证据补充；不据此推断所有历史发行。
- strict Clippy 结果尚未收到，不是本次源码结论的隐含通过项。
- 提交前核对全部最新记录的文件哈希，只有 `services/skill.rs` 与其早期受审快照不同（磁盘最后修改 21:45:11）；B-05 最后 9 文件及 MCP/usage 补审快照均匹配。用户此前通知 skill 目录夹具修正，但本次未根据交付说明推定该差异仅为夹具，不以全量测试代替这份文件的增量源码审查。早期 Skill 源码结论仍限定其记录快照，不声称新版本逐行复核完成。
- 其余测试/平台/跨进程/真实配置边界保留。无发现不等于绝对零缺陷。本报告不为未来 worker 变更背书。
封存时间：2026-10-03T22:19:23.9328321+08:00
最终 Rust 日志 SHA-256：`757D3DBF2EE72094FF86A3CBC575954E5EEA74BC868B88101C287ADE1A6A9924`

## RC-B-01 存量证据核对与结论收敛

本线程独立执行只读核对，未读取或修改真实用户配置/数据库：

- `git status --short -- src-tauri/src/mcp/projection.rs` 返回 `??`，本轮文件仍为 untracked。
- `git ls-tree HEAD -- src-tauri/src/mcp/projection.rs` 无条目，退出码 0。
- `git grep -n mcp_client_projection_ledger HEAD -- src-tauri` 无匹配，退出码 1。
- 当前文件 CreationTime：2026-10-03 20:22:01；LastWriteTime：21:45:06。
- 当前进程 chimera-plus-plus，PID 14328，StartTime：2026-10-03 18:13:31.8048271 +08:00。
- 该进程 EXE：`D:/Desktop/chimera-plusplus/src-tauri/target/debug/chimera-plus-plus.exe`；LastWriteTime：2026-10-03 17:06:49.4618652 +08:00，早于本轮 projection 文件创建。

用户另明确确认没有启动本轮编译的应用程序、没有写真实配置。这是操作历史的用户确认，当前进程/文件时间与其一致；本线程未声称仅凭时间戳证明所有历史执行，也未读取真实用户数据库来证明不存在该 key。

**更新结论：RC-B-01 在本轮交付范围内关闭为“未发布中间实现的兼容性边界”，不作为发布升级阻断，不要求仅为本轮中间状态补生产迁移。** 先前关于旧哈希记录可能冲突的源码条件分析保留，但其“已产生需兼容的用户存量”前提在本轮没有部署依据。此结论严格限于已核对的 HEAD、本轮新文件、当前应用进程及用户确认的操作范围；不扩展为所有历史发行/分支都不存在该账本。

再次读取最终 lib 日志尾部仍为 2921 passed / 0 failed / 2 ignored。Rust 验证结论不变，strict Clippy 尚无完成结果；此前 Skill 快照差异边界不因本次存量核对而自动消除。源码报告已完成，不新增迁移阻断或扩大审计范围。
证据补充时间：2026-10-03T22:21:07.9906994+08:00

## 源码结论完成与命令状态交接

按用户要求，源码复核在既定范围内完成，不等待 Clippy，也不因 test-only lint 启动额外范围审计。B-05、MCP hash、usage SQL 的源码结论维持；RC-B-01 已结合未发布证据裁决为本轮非升级阻断，不再列为待解决发布问题。此前明确记录的 Skill 快照差异及测试边界继续有效，不据本次状态通知扩大背书。

用户最新通知（本线程未执行或独立检查此次 lint 修正）：strict Clippy --all-targets 首次报告 6 个 test-only lint，涉及 3 处 default 初始化以及 clone slice、as_bytes 切片、autoderef；已按建议最小修改测试，Clippy 重跑中，lib 全量将再次复跑。

命令结果交接：此前已核读的 2921/0/2 保留为对应版本的真实通过记录，不自动认定最新测试修改后也已通过；strict Clippy 首轮未通过，重跑结果未知；最新 lib 复跑结果未知。收到结果后只需更新验证记录，不需要本轮继续等待或追加无界审计。没有新增产品修改，没有运行 Rust，没有修改首报。
完成时间：2026-10-03T22:23:50.4989707+08:00
