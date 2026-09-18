# 全项目独立审计复核（2026-09-18）

## 方法与范围

- 基于当前完整工作区，包含未提交更改，不只是本轮布局 diff。
- 两位审阅者分别从前端用户链路、后端失败路径独立审阅，不读取旧审计报告，也不共享初始结论；初始结论冻结后交叉核验安全项，主审复读证据并运行验证。
- 这是独立代码审阅与交叉复核，不等同于严格实验意义的双盲，也不声称对约 27 万行前后端源码逐行穷尽。
- 覆盖当前页面及命令注册、线路 CRUD/切换、Live/代理状态、更新偏好、会话扫描/删除/恢复、统计同步/重建、备份恢复、配置与发布门禁。遗留功能单独标注。
- 未改业务代码，未执行真实删除、恶意终端命令、恢复、安装或网络故障注入。未运行 Rust 编译、测试或 Clippy；cargo fmt --check 不产生编译产物。

## 确认发现

### F1 · P1 · OpenCode 消息 ID 可越过递归删除边界

- 位置：`src-tauri/src/session_manager/providers/opencode.rs:341`、`:347`、`:608`。
- 从消息 JSON 读取任意 `id`，直接 `storage.join("part").join(message_id)` 并递归删除；入口对 source_path 的校验不涵盖派生路径。
- 条件：旧格式本机会话消息被污染，ID 包含父级跳转或绝对路径，用户删除该会话。
- 影响：删除允许根目录之外的可写目录。当前全来源会话页可达；不是已证明的远程攻击。
- 修复：校验 ID 只能是一个合法路径组件，并在执行前验证派生路径和链接行为；预检所有目标再开始删除。
- 验证：源码调用链，加纯内存 Windows 路径拼接模型；未执行删除。

### F2 · P1 · 恢复命令将会话 ID 解释为 shell 代码

- 位置：`src-tauri/src/session_manager/providers/codex.rs:439`、`:532`；`src-tauri/src/session_manager/terminal/mod.rs:319`。
- metadata 中 ID 直接生成 `codex resume {session_id}`，shell 命令构造只引用 cwd，不引用 ID。
- 条件：污染的本地会话 ID 含 shell 元字符；macOS 用户点击恢复。Windows/Linux 当前界面复制命令，需用户另行粘贴执行。
- 影响：会话数据可携带附加 shell 命令，以用户权限执行。不是无前提远程代码执行。
- 修复：严格校验 Codex UUID，同时统一将动态 ID 作为单个参数安全引用，检查其他 provider 同类构造。
- 验证：源码闭环，未执行恶意命令。

### F3 · P2 · 删除线路与切换线路缺少共同互斥

- 位置：`src-tauri/src/commands/provider.rs:382`；`src-tauri/src/services/provider/mod.rs:2514`；`src-tauri/src/database/dao/providers.rs:280`。
- 删除检查本地/数据库当前 ID 后，无条件执行删除，未持有切换使用的锁。
- 条件：删除非当前线路 B 的检查通过后，托盘操作切换至 B，再完成删除。当前单页面操作互斥不能覆盖托盘。
- 影响：当前 ID、Live 配置指向数据库中已删除的线路。
- 修复：删除和切换遵循相同锁顺序，在锁内重新检查并删除；仅禁用前端按钮不够。
- 验证：源码锁路径与审阅者纯内存 SQLite 交错模型；未做 Rust 并发故障注入。

### F4 · P2 · 更新页未使用持久化偏好初始化操作

- 位置：`src/ChimeraApp.tsx:2341`、`:2361`；`src-tauri/src/commands/codex_runtime.rs:1011`。
- 更新页从 runtime.installMode 与 release.source 设置选择，release 为空时采用 auto；手动操作显式传递这两个值，使后端持久化默认值失效。
- 条件：关闭启动检查并保存镜像源，重启后手动检查；或保存与当前安装不同的安装方式，离开页面再返回。
- 影响：已保存的选择与实际检查/安装参数不一致。
- 修复：由保存的设置初始化操作偏好，区分当前安装状态与期望安装方式，避免状态 effect 覆盖选择。
- 验证：源码参数链，未执行下载/安装。

### F5 · P2 · 双来源会话删除后会重新出现

- 位置：`src-tauri/src/session_manager/providers/opencode.rs:42`、`:412`；`src-tauri/src/session_manager/providers/hermes.rs:27`、`:262`。
- 扫描合并 SQLite 与旧文件，同 ID 优先 SQLite；SQLite 删除不处理旧文件副本。
- 条件：迁移后同一会话同时存在数据库和 JSON/JSONL 文件。
- 影响：删除成功后刷新，文件副本再次成为可见会话，消息依然可读。当前 OpenCode/Hermes 会话入口可达。
- 修复：按 provider 和会话 ID 协调所有可信来源，或持久屏蔽已删除 ID；清理失败不得宣称完整成功。
- 验证：扫描/删除源码与纯内存合并模型，未操作用户会话。

### F6 · P2 · 遗留 Claude 同步仍可能跳过未写完末行

- 位置：`src-tauri/src/services/session_usage.rs:273`、`:290`、`:431`。
- 先增加行游标，解析失败跳过，但提交该游标；末行补写完整后仍被增量读取跳过。
- 条件：Claude 写入 JSONL 与同步并发，尾行只写入一部分。
- 影响：对应 token/费用漏计。仅遗留 sync_session_usage 命令链，当前 Codex 词元页不受此项影响。
- 修复：未完成尾行不提交游标，复用 Codex 解析器的同类保护并补回归。
- 验证：源码检查；未执行 Rust 测试。

### F7 · P2 · 遗留数据库恢复未协调 Live/运行态

- 位置：`src-tauri/src/commands/import_export.rs:152`；`src-tauri/src/database/backup.rs:739`；`src/hooks/useBackupManager.ts:21`。
- 恢复命令只替换数据库；前端仅刷新查询，没有同步 Live 或代理运行配置。
- 条件：恢复备份中的 provider 地址/密钥与恢复前不同。
- 影响：界面显示恢复后的配置，目标程序仍使用旧 Live 内容。当前简化设置页未发现入口，属于遗留命令/组件风险。
- 修复：恢复后执行共享状态协调并显式报告后置同步失败，或提供明确的重启/重新应用流程。
- 验证：源码检查，未恢复真实数据库。

### F8 · P2 · 当前工作区不能通过全部 CI 门禁

- 位置：`src-tauri/src/services/proxy.rs:124`；`.github/workflows/ci.yml:118`；`src/chimera.css`、`src/index.css`；`.github/workflows/ci.yml:46`。
- 上一次用户授权编译已产生未使用函数警告：该 helper 唯一调用者是 cfg(test) 函数，但自身未限定 cfg(test)。CI 的 Clippy 使用 -D warnings，源码与已有编译输出表明会被提升为错误；本轮未实际运行 Clippy。
- 本轮 pnpm format:check 实际失败，报告两份 CSS 不符合 Prettier。
- 影响：Debug 可运行不代表可通过发布/合并门禁。
- 修复：将仅测试 helper 限定在测试构建或移入测试模块；对两份 CSS 作纯格式修复，不要用全局 suppress 掩盖警告。

## 验证记录

| 检查 | 结果 |
| --- | --- |
| 全量前端测试 | 105 文件，104 通过、1 失败；787 用例，786 通过、1 超时 |
| 会话测试单文件复跑 | 16/16 通过；首次超时用例约 1.9 秒完成 |
| TypeScript | 通过 |
| 前端生产构建与包体积检查 | 通过 |
| Prettier | 失败：src/chimera.css、src/index.css |
| cargo fmt --check | 通过，未编译 |
| 版本一致性 | 通过，2.7.4 |
| 仓库引用检查 | 通过 |
| pnpm audit --prod | 0 已知漏洞；仅 npm 生产依赖，不包含 Rust/Git 依赖 |
| IPC 字面量注册核对 | 304 个前端命令名均找到后端注册；不代表参数和行为已全覆盖 |

首次超时不能等同于已证实功能缺陷，也不能把本轮全量测试描述为全部通过。并行构建负载可能有关，暂作为测试稳定性观察项。

## 优先级与限制

先修 F1/F2 安全边界，再修 F3/F4/F5 当前操作一致性；F8 应在合并/发布前清理。F6/F7 单独按遗留功能范围处理。

无本轮证据证明当前词元页新增统计错误。尚未覆盖真实跨平台运行、Rust 并发/故障注入、真实升级/回滚、所有外部依赖内部实现；通过检查不代表不存在其他缺陷。
