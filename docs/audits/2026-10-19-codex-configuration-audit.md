# Codex 配置保存与生效链路修复审计

日期：2026-10-19。项目：Chimera++ 2.8.6。基线：`c4a6f8c6`，含本轮工作区修改。

## 状态与结论边界

A1–A5 已实现。首轮独立审查确认另外三个错误路径 B1–B3，已核实修复并增加回归用例；第二轮双方对同一冻结版本完成独立只读复审，均未发现新的可确认问题。该结论仅限源码审查，不代表 Rust 编译、后端测试或发布验收通过。

本轮采用单次后端保存入口、严格配置所有权校验、纯准备与 CAS 多文件提交、可撤销通用配置投影，以及显式失败补偿。这里的“事务”指受应用锁保护的操作和补偿流程，不是文件系统与 SQLite 的分布式原子事务，不保证进程崩溃或断电时的跨资源原子性。

“模型目录”指 `model_catalog_json` 引用的 JSON 模型清单，不是 Chimera++ 安装目录。另一台电脑的实际配置、日志与进程环境没有提供，本轮不能据此认定其故障只有一个原因。

前端测试已执行；Rust 代码经过格式解析与源代码审阅，但没有编译、后端测试或桌面运行验证。静态源码断言不等于后端事务测试。

## 原发现与修复

### A1 · 线路与通用配置可能部分成功或读取旧草稿

- 编辑器把线路和可选 `commonConfigSnippet` 放入同一次新增/更新并激活请求。`None` 表示未提交片段，空字符串表示明确清空，避免混淆。
- 后端遵循 `profile → lifecycle → app` 锁顺序，在锁内恢复凭据、捕获原状态、暂存本次片段、应用线路。失败统一补偿片段、清空标记、迁移后的线路、选择指针与代理备份。
- 保存成功后刷新编辑器身份及基线；失败保留原草稿，避免重试误走新增、旧片段或重复保存。
- 主要代码：[`ChimeraApp.tsx`](D:/Desktop/chimera-plusplus/src/ChimeraApp.tsx:2030)、[`commands/provider.rs`](D:/Desktop/chimera-plusplus/src-tauri/src/commands/provider.rs:412)。

### A2 · 通用片段可能覆盖线路专属配置

- 编辑校验、入库和应用复用严格的 Codex 通用片段校验，递归处理普通表、内联表与 profile，不允许通用片段包含模型、模型目录、路由、凭据及受控执行字段。
- 对与线路共享父表的配置按子键区分所有权，禁止标量或空父表替代受保护配置结构。
- 校验失败显式报出键路径，不回显敏感值；合法用户文本原样入库，保留注释、空白与换行。旧数据清理只在明确的迁移流程使用，不静默改变新草稿。
- 主要代码：[`codex_key_ownership.rs`](D:/Desktop/chimera-plusplus/src-tauri/src/codex_key_ownership.rs:724)、[`database/dao/settings.rs`](D:/Desktop/chimera-plusplus/src-tauri/src/database/dao/settings.rs:129)。

### A3 · 模型目录生成在预检失败前已经落盘

- 目录准备只生成内存中的配置与目录文本，不提前写文件。
- 配置、受管目录、凭据和通用投影记录绑定原始读取快照，经同一个 CAS changeset 提交。未改动文件也保留为读取依赖的比较保护。
- 目录先写、配置后写，失败按已提交凭据倒序补偿；发现外部修改冲突即保留冲突文件并返回错误，不盲目覆盖用户文件。
- 代理接管、恢复、热切换与直接应用共用相同的写入机制；凭据不会新增进代理持久化备份。
- 主要代码：[`codex_config.rs`](D:/Desktop/chimera-plusplus/src-tauri/src/codex_config.rs:3191)、[`codex_live_write.rs`](D:/Desktop/chimera-plusplus/src-tauri/src/codex_live_write.rs:73)。

### A4 · 删除或禁用通用片段后 Live 残留

- 新增 `chimera-common-projection.json`，按 TOML 叶子记录最后投影值与原始值；撤销时仅处理仍匹配上次投影的值。
- 用户在 Live 中手动修改、删除的键不会因未变化的共享意图被再次覆盖。变更共享意图时会重新应用该意图。
- 仅清理投影自身创建的空父表，保留预先存在的空表、未受管兄弟键与用户修改。
- 线路投影完成后只执行一次通用投影；Codex 切出时不再从整份 Live 反向提取并覆盖明确保存的通用文本。
- 投影记录随备份保存和恢复。恢复缺少此记录的旧备份时清除不匹配的现存记录，避免错误撤销。
- 主要代码：[`codex_common_projection.rs`](D:/Desktop/chimera-plusplus/src-tauri/src/codex_common_projection.rs:335)、[`services/provider/live.rs`](D:/Desktop/chimera-plusplus/src-tauri/src/services/provider/live.rs)。

### A5 · 目录所有权仅按同名文件判断

- 统一按所选 Codex home 解析相对/绝对路径，再与受管目录的完整路径身份比较；不再只比较文件名。
- 同名外部目录、跨机残留路径及仍在 Live 中的自定义引用不会被静默接管。冲突明确失败，草稿保留，便于用户选择保留自定义目录或改用受管目录。
- 主要代码：[`codex_config.rs`](D:/Desktop/chimera-plusplus/src-tauri/src/codex_config.rs:2928)、[`commands/codex_runtime.rs`](D:/Desktop/chimera-plusplus/src-tauri/src/commands/codex_runtime.rs)。

## 一致性补强

- 路由切换保留真实 `AppliedChangeset`，直至数据库和选择提交完成；补偿倒序执行，遇文件冲突停止继续文件回滚。
- 失败恢复精确的数据库选择标记（包含原先无选择）、本地指针、原代理备份内容及时间戳、代理应用/全局设置、运行状态与活动目标，不通过重跑接管来恢复。
- 首次新增的后续查询、初始化及激活均位于同一补偿边界内；回滚到无当前线路时移除内存活动目标。
- 单独保存通用片段不额外触发第二次可能失败的 MCP 文件同步；没有写入凭据时不使用普通快照擅自覆盖已变化的 Codex 文件。

## 首轮盲审后的补丁

### B1 · 首条线路启用自动路由时缺少已提交的当前供应商

- 确认场景：全新环境无当前线路，暂存首个需要自动代理的 Codex 线路并初始化 Live，严格接管仍读取“当前供应商”，导致激活失败。
- 修复：接管准备允许显式传入待激活线路；仅当原先没有当前线路时传入，不提前提交当前选择，不破坏失败补偿边界。
- 回归源码：`first_unlogged_codex_chat_provider_activates_automatic_routing`，覆盖启用、模型目录及关闭接管后恢复原地址。

### B2 · 热切换成功写入后，选择提交失败无法恢复文件

- 确认场景：直接 Live（保留备份）或已接管 Live 的热切换，文件写入成功后本地指针或数据库提交失败，写入凭据此前已丢弃，普通快照仅能检测变化而不能安全恢复。
- 修复：两条分支都保留 `AppliedChangeset` 到选择提交成功；失败先倒序撤销文件，再恢复精确选择与备份内容/时间戳。保留外部修改的冲突保护，不通过重新投影旧供应商覆盖现场。
- 回归源码：`codex_direct_live_write_rolls_back_when_provider_commit_fails` 与 `codex_taken_over_live_write_rolls_back_when_provider_commit_fails`，使用 SQLite 触发器注入提交失败，并在停止代理之前断言四个文件字节、选择及原备份一致，避免停服恢复掩盖补偿失败。

### B3 · 更换监听端口时后续应用失败，Codex 残留新端口

- 确认场景：新监听器启动并重写 Codex 接管地址后，后续 Grok 官方登录态拒绝接管；旧监听器恢复但 Codex 写入凭据已丢弃。
- 修复：跨应用监听更新保留全部 Codex 写入凭据，任何后续失败时撤销后再核对原快照。
- 回归源码：`later_app_takeover_failure_restores_codex_files_and_old_listener`，注入后续 Grok 接管失败，断言 Codex 四文件、备份以及旧监听端口和连通性恢复。

以上 Rust 回归均只编写并做格式解析，未编译、未执行。

## 独立盲审

方法：实现冻结后，两名独立审计者接收相同的中性范围，分别只读检查配置保存、所有权、目录、投影、代理接管及恢复。不读取本审计记录、备份或另一方结论，双方不交流。主执行者负责核实发现、补丁和回归；若实现改变，再分别通知双方复核同一版本。

- 首轮审计 A（Meitner）：报告 B2、B3，主执行者已核实并补丁。
- 首轮审计 B（Volta）：报告 B1、B2，主执行者已核实并补丁。
- 第二轮审计 A（Meitner）：完成配置保存/新增/编辑/切线与自动路由、所有权与投影、模型目录、代理接管/热切换/监听更新/备份恢复，以及关键补偿链路的静态复核，本轮未发现新的可确认问题；无具备具体触发证据的未决缺陷链。
- 第二轮审计 B（Volta）：完成上述范围及前端失败草稿、重试身份、相关测试定义和非 Codex 分支复核，本轮未发现新的可确认问题。
- 两方分别确认只读、未读取审计记录或另一方结论、未接触真实用户配置与进程；均指出未编译 Rust、未执行后端测试和端到端验证的限制。
- 第二轮源代码与测试快照 SHA256：`52bbb14855478c7ce6bc31750dbe378293e7b9af547c2d0fa99cd710d32bb017`。对 `git diff --name-only` 中的 `.rs/.ts/.tsx` 与新增投影模块、事务测试共 19 个路径排序，逐一摘要 `路径 UTF-8 + NUL + 文件原始字节 + NUL`；审计文档不参与摘要。
- 该流程是相互独立、互不共享结论的双人盲审，不是匿名随机试验意义的双盲证明，也不替代 Rust 编译与真实失败注入。

## 已执行验证

- `pnpm typecheck`：通过。
- `pnpm build:renderer:check`：通过，Vite 生产构建和 bundle budget 均通过；仅有 Zod 依赖注释位置告警，不涉及 Rust 编译。
- 首轮定向回归：12 个测试文件、94 条测试通过（补丁前记录）。
- 补丁后重跑扩展 Codex/线路/通用配置/路由/备份回归：42 个文件、411 条测试通过。
- 补丁后重跑主界面与编辑页：`ChimeraApp.characterization.test.tsx` 和 `ProviderEditorPage.test.tsx`，2 个文件、40 条测试通过；与上述范围部分重叠，不相加。
- 新增 `codex-configuration-transaction.test.ts`：10 条通过，含 3 条 mock IPC 行为测试与 7 条静态 Rust 源码保护断言，已包含于 411 条中，明确不执行 Rust 事务。
- 最终冻结版本再次执行 `pnpm typecheck`，并合并重跑事务 IPC/源码保护、主界面、编辑页：3 个文件、50 条测试通过；与以上用例重叠，不额外累加。再次执行修改文件的 Rustfmt、Prettier 及 `git diff --check`，全部通过。
- `codex_common_projection.rs` 包含 32 条 Rust 单元测试源码；未运行，不计入通过数。
- 所有修改 Rust 文件及新投影文件的 `rustfmt --check --edition 2021`：通过，仅证明格式和语法可解析。
- 所有修改 TS/TSX 与新增测试的 Prettier 检查：通过。
- `git diff --check`：通过。
- 未运行 Rust 编译、`cargo test/check/clippy`、Tauri dev 或桌面交互；未修改真实 Codex 用户配置，未启动或重启 Codex，未删除构建产物或缓存。

测试运行排除 `**/.qa/**`，避免扫描编辑前备份。修改前备份保存在工作区 `.qa/configuration-fix-backup/`，不含真实 Codex 用户配置。

## 迁移与环境限制

1. 旧版本没有投影记录，只能采用当前启用片段且与 Live 匹配的共享叶子建立迁移基线。升级前已经覆盖掉的用户原值无法凭空重建，不能承诺恢复。
2. 损坏的投影记录必须显式报错，不能被当作“没有记录”忽略；需要后续人工核对备份再恢复。
3. 本轮补偿不能提供断电或进程中断时的跨数据库/文件崩溃一致性；若要该保证，需另行设计持久化恢复日志，而非把当前流程称作分布式原子事务。
4. 文件正确不证明已运行的 Codex 进程已经重载。外部快捷方式、终端、编辑器扩展或 WSL 的 `CODEX_HOME`、profile、`--config` 和工作区配置仍可能不同。
5. 独立 CLI 模型探针成功不证明现有桌面进程采用相同目录或版本。日志应只记录选用 home、配置路径、目录解析结果、安装模式/版本及重启要求，不记录 API Key、令牌或完整敏感配置。

## 后续验收门槛

两份独立复审已回收，首轮 B1–B3 修复后双方均未发现新的可确认问题；最终代码快照与双方复核的摘要一致。获得明确许可后，下一门槛是执行 Rust 编译与后端失败注入测试，覆盖保存交错、切线交错、清空/禁用、手动修改保护、目录写入后失败、接管失败与退出恢复。当前不宣称已达到发布验收或绝对无缺陷，不自动进入下一项。
