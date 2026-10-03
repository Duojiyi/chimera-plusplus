# 独立盲审 B：后端配置、账户、探测与用量

审计日期：2026-10-03。审计对象为本工作树当前磁盘源码，不以提交记录或修复交付说明替代审查。最后一轮已纳入稳定后的 MCP、opencode_config.rs 清理、vault.rs 测试专用方法调整、settings 单目录 patch，以及 providers 内联思考协议边界。

## 独立性与方法

- 未读取 A 报告、既往 docs/audits 报告或修复者结论。仅审阅产品源码、相关测试及前端 API/消费者；本文是本次唯一报告写入。
- 未修改产品代码，未读取或操作真实用户配置、账户凭据、CLI 登录状态；未运行真实 CLI 探测。未编译 Rust，未运行 cargo test/check/clippy/build 或 Tauri 构建。
- 结论来自静态控制流、数据流和调用链。以下“可确认”表示当前代码能推导出该行为，不表示已在 Rust 运行时复现；并发与文件系统故障均明确给出必要触发条件。
- 深审范围：services/mcp.rs、mcp 子模块、commands/mcp.rs、commands/misc.rs、services/skill.rs、commands/official_accounts.rs、codex_accounts/vault.rs、services/usage_stats.rs、claude_desktop_config.rs。补充追踪相关 provider/live、settings、usage parser/logger/calculator、数据库及前端 API。providers 仅作指定 think/thinking 快速边界审计，不是全协议认证。
- 严重度：P1 为配置/内容丢失或账户一致性高风险；P2 为功能状态、探测或统计口径错误。优先级按影响而非必现频率排序。

## 结果摘要

确认 11 项：P1 四项，P2 七项。没有发现不等于绝对零缺陷。现有测试有价值，但前端 mock 测试不能证明后端文件事务、跨命令并发或真实客户端行为正确。

| 编号 | 级别 | 问题 |
| --- | --- | --- |
| B-01 | P2 | Codex MCP 所有权冲突被成功返回隐藏 |
| B-02 | P2 | Codex 软禁用状态污染其它应用的 MCP 开关 |
| B-03 | P1 | Skill 更新使用旧快照，可覆盖切换或复活已卸载记录 |
| B-04 | P1 | Skill SSOT 部分删除失败没有从独立备份恢复 |
| B-05 | P1 | 删除账户与保存登录未共享事务边界，可留下悬空绑定 |
| B-06 | P1 | Desktop 切官方模式删除未证明归属的 enterpriseConfig 字段 |
| B-07 | P2 | Desktop 全快照回滚可能覆盖外部并发修改 |
| B-08 | P2 | Windows 版本探测可能不反映 PATH 默认程序及故障 |
| B-09 | P2 | 请求用量 DTO 隐藏语义，前端 fresh input 口径错误 |
| B-10 | P2 | Provider 与 Model 的同名 totalTokens 口径不同 |
| B-11 | P2 | Grok 历史成本回填重复计入缓存输入 |

## 可确认问题

### B-01 · P2 · Codex MCP 冲突返回成功，UI 与实际配置脱节

证据：`src-tauri/src/mcp/codex.rs:395` 比较实时哈希与所有权哈希；冲突分支在 402–403 行记录 `ledger.conflict(id)` 后 `Ok(())`。删除路径 470–485 行同样保留被外部修改的条目并成功返回。`services/mcp.rs:194` 的事务先改数据库再投影，仅 Err 才恢复；`project_one` 保存账本但没有把冲突变成命令结果。`get_all_servers:23` 仅返回数据库记录。`CodexMcpLedger::projection` 在当前生产调用链没有消费者。

调用链：前端 `src/lib/api/mcp.ts` → `commands/mcp.rs` 统一增改/开关/删除 → `McpService` → Codex 投影；`src/views/SkillsMcpView.tsx` 成功后重载数据库记录。

触发：同 ID 的 Codex 实时条目已由用户修改，再更新、关闭或删除该条目。外部内容被保留是正确保护，但命令成功、数据库状态已变，UI 未告知未应用；删除后仍可能有实时条目运行。其它应用的投影冲突返回错误，契约也不一致。

测试缺口/建议：增加服务层到 IPC 结果的 Codex 冲突用例，并验证 UI 可见的“未应用/冲突”状态。不要为了返回成功而覆盖外部条目；应显式传播冲突或采用可观察的部分应用结果。

### B-02 · P2 · Codex enabled=false 被前端错误用于所有应用

证据：`services/mcp.rs:663` 的非 Codex `app_toggle_target` 只改变对应 apps 标志；`codex_toggle_target:685` 对仅 Codex 启用的条目写入 `server.enabled=false`。非 Codex 投影有意移除该属性。`src/views/SkillsMcpView.tsx:151` 却对所有 targetApp 使用 `Boolean(s.apps[targetApp]) && s.server.enabled !== false`；178 行按这个结果取反发送开关命令。

触发：先禁用 Codex-only 条目，再将该条目启用到 Claude/Gemini 等应用。后端实际写入启用配置，前端仍显示关闭；再次点击持续发送 enable，不能通过此开关关闭该应用。

测试缺口/建议：现有后端 `other_app_enable_disable_and_import_preserve_codex_intent` 保留 Codex 意图是合理的，但缺少跨应用 UI 序列测试。前端仅在 Codex 上叠加 Codex 的软禁用属性。

### B-03 · P1 · Skill 更新与切换/卸载竞争，旧记录覆盖新意图

证据：`services/skill.rs:1395` 的 `update_skill` 先读取 installed skill，再在 1425 行附近等待下载；1556 行从旧对象复制 apps，1562 行保存整个更新对象并后续同步投影。1896 行的 `TOGGLE_LOCK` 仅属于 toggle 路径，更新和卸载不共用。`commands/skill.rs` 与 `src/lib/api/skills.ts` 分别暴露更新、切换、卸载，没有统一操作锁。

触发顺序一：更新读取 enabled=true → 下载等待 → 另一个请求成功关闭该 skill → 更新恢复并保存旧 apps，关闭被撤销。触发顺序二：更新已通过 require_update_backup 并创建备份 → 在 swap_staged_directory 前另一个请求成功卸载 → 更新把 staged 内容放回原目录并通过 save_skill 重新插入记录，记录和投影被复活。注意：若卸载完整发生在下载等待期间，后续备份检查可能阻止更新，不能把这一较早窗口直接当作必然复活。单个面板的 busyRef 不能阻止其它调用入口或窗口。

影响：用户已确认的关闭/卸载被后续旧操作覆盖。仅给 toggle 加锁不足以保护同一 skill 的生命周期。

测试缺口/建议：用 barrier 分别固定下载暂停点和备份完成后的替换前暂停点，覆盖 update-vs-toggle、update-vs-uninstall，并断言 DB、SSOT 和各应用投影。使用同一 skill 的共享锁或版本检查；不要跨等待后无条件写回旧完整记录。

### B-04 · P1 · Skill SSOT 部分删除失败后，用损坏源恢复投影

证据：`services/skill.rs:1084` 创建独立卸载备份；1107 行注释假设“失败时 SSOT 仍在”，1109–1116 行在 SSOT 删除失败后只调用 `restore_removed_app_projections`。`remove_path:2550` 的目录分支在 2582 行调用 `fs::remove_dir_all`，失败不保证目录内容未变。`restore_removed_app_projections:3930` 使用 SSOT 重建；独立备份恢复只出现在数据库删除失败的 1124–1127 行。

触发：目录中前几个文件已删，随后因锁定子项、权限或 I/O 错误导致递归删除失败。数据库保留已安装记录，但 SSOT 已残缺；恢复投影从残缺源复制或失败，不能恢复卸载前状态。

边界：独立备份可能仍可人工恢复，因此不声称不可恢复地丢失全部内容。另一个补偿边界是应用目录本地修改未逐份备份，不能承诺失败后每个应用副本逐字恢复。

测试缺口/建议：故障注入必须发生在至少一个子项被删之后，不能只在 remove 前失败。SSOT 删除失败也应先从已创建备份恢复 SSOT，再恢复应用投影，并报告恢复失败。

### B-05 · P1 · 账户删除与保存登录交错，可产生绑定到不存在槽位的线路

证据：`commands/official_accounts.rs:161` 的删除 helper 在 168 行读取一次线路，逐条解绑，179 行才删除凭据。`save_current_official_login` → `codex_accounts/mod.rs:177 save_current_login` 在 199 行写槽位，202 行 `register_account_line` 重新绑定/创建线路。`register_account_line:137` 同样没有与删除共用锁；设备登录登记也进入这一链路。provider 切换锁不是这些操作的共同边界。

触发顺序：删除读出并解绑旧线路 → 保存登录写同一账号槽位并登记新绑定 → 删除移除槽位。两个命令都可能成功，最终线路仍带 account key，槽位却不存在。反向交错还可能使删除后的账户重新出现。

已核对边界：`vault.rs:499 remove_account` 的单次删除失败/墓碑恢复处理不能覆盖上述跨 DB 与 vault 操作的窗口；最新 cfg(test) 清理不改变这一点。删除已保存账户不等于登出 live auth，本文不将 live auth 留存本身报为缺陷。

测试缺口/建议：现有 `second_detach_failure_retains_credentials_and_retry_completes`、`vault_failure_is_explicit_and_retryable_after_detach` 是串行失败测试。新增删除与保存/登录登记交错测试，给解绑、登记、槽位变更建立共同串行化或可检测版本边界。

### B-06 · P1 · Desktop 恢复官方模式删除未确认归属的配置

证据：`services/provider/live.rs:744` → Desktop `apply_provider` → `claude_desktop_config.rs:1027` 的 official 分支。`restore_official_at_paths_inner:1106` 无条件执行 `remove_cc_switch_enterprise_config`；该函数 1223–1246 行删除现有 enterpriseConfig 的 `disableDeploymentModeChooser`、`inferenceGatewayApiKey`、`inferenceGatewayAuthScheme`、`inferenceGatewayBaseUrl`、`inferenceProvider`，没有比较所有权、曾写值或当前 profile。相比之下，meta 清理有 PROFILE_ID 限定。

触发：用户原本由第三方或企业管理写入这些字段，未曾由本程序托管，随后首次切到官方 Desktop provider。上述字段也被移除。切换部署模式不等于授权清理所有来源的企业网关配置。

测试缺口/建议：增加无本程序 profile/appliedId、但已有 enterpriseConfig 的 official 切换测试。仅撤销能证明为本程序写入且未被外部修改的字段，或明确提示并征求覆盖确认。存在备份不消除归属错误。

### B-07 · P2 · Desktop 回滚不是条件恢复，可覆盖外部进程的新写入

证据：`claude_desktop_config.rs:1155 snapshot_files` 保存四个文件原始内容；`restore_snapshots:1176` 遍历全部快照，无条件 atomic_write 旧字节，原不存在则 delete_file。没有核对失败前本操作实际写过哪些文件，也没有比较当前内容是否仍等于本操作的写入结果。

触发：拍快照 → Desktop/其它进程更新某个快照文件 → 本次后续步骤失败 → restore_snapshots 将该文件写回旧版本，或删除拍快照时尚不存在的新文件。即使应用内串行化，也不能锁住外部进程。

测试缺口/建议：现有多文件回滚测试证明会继续恢复其它文件，不证明不会覆盖并发编辑。增加中途外部修改/新建文件案例；仅补偿实际提交过的文件，使用内容比较/CAS 并显式返回恢复冲突。

### B-08 · P2 · Windows 探测选择常见目录版本，可能掩盖默认程序损坏

证据：`commands/misc.rs:829 get_single_tool_version_impl` 的 Windows 分支直接调用 `scan_cli_version`，而非先解析 PATH 默认项。`build_tool_search_paths:1674` 先放常见安装路径，1805–1808 行才追加 PATH。`scan_cli_version:1859` 遍历后遇到成功就返回，失败可继续尝试其它安装。`resolve_path_default:2021` 用于安装枚举而非此版本探测。前端 `src/lib/api/settings.ts`、`src/components/settings/AboutSection.tsx` 消费 localVersion/installedButBroken。

触发：常见目录存在健康版本 A，PATH 默认指向不同版本 B，或 B 已损坏。版本卡可能显示 A，并把 installedButBroken 设为 false；终端默认执行 B。枚举 API 的 default 项与版本卡可能不一致。

测试缺口/建议：在隔离目录模拟两个安装，测试“默认版本不同”和“默认失败、备用成功”。探测默认解析路径应与枚举共用规则；备用可作为替代安装展示，不应替默认程序消除故障。本文未执行真实工具，未判断本机当前是否处于该场景。

### B-09 · P2 · 请求 DTO 不带 token 语义，前端仍只按 app 扣 cache read

证据：`services/usage_stats.rs:141` 对 `input_token_semantics` 使用 serde(skip)，请求列表/详情保留原始 input_tokens。后端 `services/sql_helpers.rs:33 fresh_input_sql` 区分 TOTAL、FRESH、LEGACY；TOTAL 扣 read 与 creation。`src/types/usage.ts:223 getFreshInputTokens` 却按 app 白名单仅扣 read，且接口不含 cacheCreationTokens 或语义。`RequestLogTable.tsx`、`RequestDetailPanel.tsx` 使用该函数。

真实生产来源：`proxy/providers/transform_codex_anthropic.rs:140` 附近把 fresh/read/creation 合为 total，并输出 cache_write_tokens；`proxy/usage/parser.rs` 读取，`logger.rs:138` 标为 TOTAL。因此并非只有理论构造的数据库记录才有 cache write。

触发证据：TOTAL input=1000、read=600、creation=200 时，后端汇总 fresh=200，前端请求详情 fresh=400。FRESH 历史记录也不能通过 app 名称判断是否再次扣减。前端关于这类 app 的 creation 恒为零、应显示 N/A 的假设亦不覆盖该转译路径。

测试缺口/建议：增加从序列化请求 DTO 到 UI 的 TOTAL/FRESH/LEGACY 契约测试，覆盖非零 cache creation。后端统一输出归一化值，或显式传递语义让前端按同一规则计算。

### B-10 · P2 · Provider 与 Model 的 totalTokens 不可直接对账

证据：`services/usage_stats.rs:1358,1370` provider 聚合为 fresh_input+output；1512、1521 行 model 聚合为 fresh_input+output+cache_creation+cache_read。明细和 rollup 两条 SQL 分支均有差异。`src/components/usage/ProviderStatsTable.tsx` 与 `ModelStatsTable.tsx` 使用同名 totalTokens 和 Tokens 标题，没有注明口径不同。

触发：相同时间和过滤条件下，一条 fresh=100、output=20、read=80 的记录在 provider 表显示 120，在 model 表显示 200。不能靠按 provider/model 求和相互核对。

测试缺口/建议：增加同一数据集跨 provider、model、总览的对账断言，分别覆盖原始日志与归档 rollup。选择统一总量定义，或明确字段名与 UI 标题。日报前端会从四列重新合计，本条不声称当前日报图也必然错误。

### B-11 · P2 · Grok 成本回填与实时计费不一致

证据：`services/usage_stats.rs:1919` 的 cache-inclusive 白名单只有 codex/gemini，遗漏 grokbuild。`proxy/usage/calculator.rs:56` 实时计算包含 grokbuild，`logger.rs:138` 也为其写 TOTAL 语义。列表/详情的 `maybe_backfill_log_costs` 等回填入口会走这份不同的计算规则。

触发：grokbuild 缓存请求最初没有有效成本，后续有了价格并回填。TOTAL input=1000、read=600、creation=0 时，实时规则按 fresh=400 计输入费；回填按输入 1000 再加 read=600 的缓存费，高估输入费用。

测试缺口/建议：已有 `grokbuild_does_not_double_bill_cached_input` 覆盖实时 calculator，但不覆盖本回填路径。补充同一记录实时/回填一致性测试，尽量复用语义归一化与计费规则，避免重复 app 白名单漂移。

## 其它审阅结果与边界

### MCP 事务与当前架构

已复核当前 `services/mcp.rs` 全局操作锁、client switch → MCP → 短 DB 锁顺序，以及增改删、批量、provider 再投影、导入链路。非 Codex 的 `mcp/projection.rs` 使用所有权哈希、旧值迁移匹配和 CAS 提交；失败按实际 AppliedChangeset 反向补偿，并尝试恢复数据库与账本。

阅读 `projection_tests.rs`、`service_regression_tests.rs` 中外来 ID、外部编辑、批量 DB 失败、账本保存失败、回滚不覆盖后续成功操作、provider 锁顺序等测试源码。它们不能替代本线程未执行的 Rust 验证。OpenCode 当前 MCP 读取与统一投影链已核对，旧未调用函数清理不作为功能正确性的证明。

导入全部应用明确采用 best effort 并报告部分失败，不将其误判为承诺原子性。旧 Claude 原始增删 API 仍是独立写入边界，当前前端搜索未找到对应旧 wrapper 的活动消费；只记录兼容入口风险，不将其当作当前 UI 已触达的新缺陷。

### Settings 单目录 Patch

调用链：`src/components/settings/ConfigDirectoriesPanel.tsx` → `src/lib/api/settings.ts:79` → 已注册 `commands/settings.rs:202 patch_config_directory` → `settings.rs:1088 mutate_settings`。命令校验 app 白名单和绝对路径语法，空值复位，只改变一个目录字段；mutate_settings 在写锁内读取、合并、落盘，成功后发布内存值。面板不再重放整份 settings，明确不迁移文件。

本次未发现这一链路新的可确认缺陷。源码测试覆盖其它字段保留与路径输入，但名为 concurrent 的字段保留测试不等于真实多线程压力验证。目录变更与正在进行的多文件 MCP/Skill/provider 操作的跨命令一致性、实际目录可访问性和迁移不在该单字段原子性保证内；未将未验证风险升级为确认缺陷。

### 程序探测与账户失败边界

Desktop 安装探测检查程序路径，不把存在用户配置目录直接等同于已安装；跨平台真实程序启动/卸载/沙箱环境未测试。misc 只做源码和隔离前端 mock 测试，未触碰本机实际安装。

账户删除的顺序性故障处理已阅读：解绑失败保留凭据并明确重试，vault 辅助文件失败可报告并保留可重试状态。本报告 B-05 指跨操作并发，不否认这些串行失败改进。DPAPI、ACL、文件锁的真实平台行为未运行验证。

### 内联 think/thinking 快速边界审计

追踪 `proxy/providers/codex_chat_common.rs:211 InlineThinkParser`、334 行 normalize_inline_think 到 `transform.rs`、`transform_codex_chat.rs` 非流式消费者，以及 `streaming.rs`、`streaming_codex_chat.rs` 流式消费者。

检查拆分标签、UTF-8 字符边界、连续 text/output_text 块、非文本块边界、显式 reasoning 合并、反引号/转义字面量、未闭合标签、空/非空 tool_calls、finish_reason、DONE 与 EOF 收尾；阅读相应内嵌测试。此快审未发现新增可确认问题。

边界：精确小写标签作为分隔符；普通正文中裸标签与协议标签本来存在歧义。不是完整 Markdown 语法解析认证，波浪号围栏等未扩展验证；没有跑 Rust 协议测试或真实供应商端到端流。无发现不表示流式/非流式所有组合都正确。

## 验证记录

前端执行命令：

```text
node_modules/.bin/vitest.CMD run tests/lib/officialAccounts.test.ts tests/components/OfficialAccountsView.test.tsx tests/components/ConfigDirectoriesPanel.test.tsx tests/components/SkillsMcpView.test.tsx tests/components/AboutSection.tools.test.tsx tests/utils/usageMetrics.test.ts tests/utils/usageDisplay.test.ts
```

首次执行 7 文件 / 98 测试通过（20:48 本地时间，12.82s）。提交报告前再次执行的结果见下方追加记录。使用项目既有 Tauri/MSW mocks，不能覆盖 Rust 文件事务或真实配置。出现 Node localStorage 实验性警告，不是测试失败。

Rust 编译、cargo tests/clippy/check：未运行，按用户要求留给主线程统一执行。没有用前端绿灯替代 Rust 验证，也未为复现这些问题操作用户配置。

## 最终源码快照

以下 SHA-256 记录报告落盘时的指定后端审阅范围和主要前端契约文件，用于识别后续并发修改；不是全仓库快照，也不表示每个文件每一分支均已穷尽审计。行号以本轮磁盘版本为准。

快照时间：2026-10-03T21:02:29.5434194+08:00

| 文件 | SHA-256 |
| --- | --- |
| `src-tauri/src/claude_desktop_config.rs` | `C958ECB401A17BF4165CF4014488C93A1F34291E25CEE8AD3F3B3519AF846B89` |
| `src-tauri/src/codex_accounts/mod.rs` | `F3FB8A28C3A079B6063766E4B40580D8E38F213891D598AB2E636C2B08B37E98` |
| `src-tauri/src/codex_accounts/vault.rs` | `1120C431C1B2FDE18348BC0BBD1F59250E9CB49C78FDCD938A047D1DC095FDAC` |
| `src-tauri/src/commands/mcp.rs` | `221EC798D2F08013D26532B6BD5036CDBFA5B2D2899FCC921B1B10A604D33EBB` |
| `src-tauri/src/commands/misc.rs` | `6F9BF71EEFD8E239B06852F56666656A89B69085A80D5FDAE33E5224E93C38CE` |
| `src-tauri/src/commands/official_accounts.rs` | `76B835AB486C94AF935D416DB99CF6A64736489858A0EE6788B7CB933F7AC62E` |
| `src-tauri/src/commands/settings.rs` | `5B45108FDF9AD9DD28B258F6C343474D8FC66FDF9A8870807C465CC850D6C679` |
| `src-tauri/src/mcp/claude.rs` | `37413E3F5A7C27FB76ED2029D693AC83EFDDCDCB8F3AA0BFE5B2076F0F9189EA` |
| `src-tauri/src/mcp/codex.rs` | `74BF2B3C358D532E482306F8B2C16066C42A39165D07EF71072006FFFB07036B` |
| `src-tauri/src/mcp/gemini.rs` | `76BAA5EE04BC68E1CB2814BE0A14AC040AE8EE2219C275940E31A29267DE91FE` |
| `src-tauri/src/mcp/grokbuild.rs` | `FD4C2B803DBA753925B37B92C06C3CBF4FD568B6389C387C4480EFB394B5EE96` |
| `src-tauri/src/mcp/hermes.rs` | `3F05FFD85B702A29869CDF67366E4AABDE358733D1AE1FCDD2E7F1C36EA96478` |
| `src-tauri/src/mcp/mod.rs` | `D8A96004AD0D612CF0ADE78C7CCA94B0EE7B294376FFFA4588D36AC4C28DB414` |
| `src-tauri/src/mcp/opencode.rs` | `2004568E735B85D763A23990EA4BCC1DA62B8CDEF879A918109A1CEAE7E75CBC` |
| `src-tauri/src/mcp/projection_tests.rs` | `0041C272FD63E630CFAE38F836B79597894B2C64D067BA31E93B7E787DFA9173` |
| `src-tauri/src/mcp/projection.rs` | `5E72516C88F0BF7B88B333174C1BD21CFF67D10B0E81FA80272624E04E95B8AE` |
| `src-tauri/src/mcp/service_regression_tests.rs` | `68D08EECAE8C17A3212C63C9F097269C2E89EDA1B5BE33B23C780D753137EA1E` |
| `src-tauri/src/mcp/validation.rs` | `0CC213213E2DD46E14CD4DFCCB6121EF4D73EA6E158E0AF85DD18C758F0C6807` |
| `src-tauri/src/opencode_config.rs` | `F9AE0F5E9A439397BC51B5471059BCFD5B2A02962DD391D159EDA0FD72F95D00` |
| `src-tauri/src/proxy/providers/codex_chat_common.rs` | `91BD7EFCE1AB3B5FFA5B6571937CCB4BEACBBDE4D455CDBCBB9856D77865C94C` |
| `src-tauri/src/proxy/providers/streaming_codex_chat.rs` | `744E34F3105D5AE65B00D199D0DBADDD30442F63AA1CD3B6A8BE59702009B891` |
| `src-tauri/src/proxy/providers/streaming.rs` | `41ACB48AF1A95297E7828628A8F6E8E8DE0E4AB73DDAA56B267E3C7BCCAF395A` |
| `src-tauri/src/proxy/providers/transform_codex_anthropic.rs` | `4BE08E2C23565E409D84A238F46FCEC9A6A35F9F2FCAB7E143750476E3FA3828` |
| `src-tauri/src/proxy/providers/transform_codex_chat.rs` | `D4E269E32EF512F3464357A61A06A0D7721470D405436FFAA1E9E428ADD3AA3F` |
| `src-tauri/src/proxy/providers/transform.rs` | `89E926933D28C0E027199741693E5F3DC9CE7F83EFDF692A604FAD8535236C79` |
| `src-tauri/src/services/mcp.rs` | `A41691D3CC2D330EA601CCF965D303E0BDE75FC19A521441B61D672C5D4A4D00` |
| `src-tauri/src/services/skill.rs` | `E77B4510D53C983416DE5D433B8BA7A1D5CB64D44AC2EC2782CBD5BD83E02EBA` |
| `src-tauri/src/services/usage_stats.rs` | `9249ABD8AD51490CBA829F7DEBEED0895F3DE2025A7ED0E466E8BE6A4C0D204A` |
| `src-tauri/src/settings.rs` | `F4220E667E0EEA8D6DEE4BA9A08F54E55F33D4269CA63196C619F4215F5AD2B3` |
| `src/components/settings/ConfigDirectoriesPanel.tsx` | `98B36F3F3BEE463223D80348D66988C431CC29ACF436792839A40988A6B156FC` |
| `src/lib/api/mcp.ts` | `108B39C89FFCC741C9A5AFEB795D68B079BF9B54A95B67915968C52A71F0C6BA` |
| `src/lib/api/settings.ts` | `10F980626D994BF09A127C3B5EE8B889F11AE4EE8C3B9D9A7278E0F45A260B22` |
| `src/types/usage.ts` | `6BDC0D6EFD0FD1D31DAAD65A971858D52F26B144AF6377D39EBAA1DECE09B7C7` |
| `src/views/SkillsMcpView.tsx` | `DAD1CE9DC48E9A3358652C2F1705D17664070A193B42CD45269CFD65E512DBF5` |


最终复跑：2026-10-03 20:58:12 开始，23.05s，7 个测试文件通过、98 项测试通过；无失败。


## 第一轮封存说明

封存时间：2026-10-03T21:04:33.8384902+08:00。按用户进度要求封存第一轮，不追随随后交付；本文结论绑定上表已审阅快照。用户通知 services/skill.rs、services/prompt.rs 另有后续变更，留待收口复核，本文不据此宣称后续版本已验证。

封存校验相较上表发现变化的文件：src-tauri/src/mcp/hermes.rs。这些快照后的变化尚未复核，不覆盖为新的已审版本；保留原哈希以便收口对照。

本轮仍为 11 项静态确认问题，前端复跑 7 文件 / 98 项通过，Rust 验证未运行。未读取 A 或既往报告，未操作真实用户配置。
