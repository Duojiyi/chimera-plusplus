# cockpit-tools 账号管理深度分析（2026-11 快照）

- 分析日期：2026-11-10
- 上游项目：`jlcodes99/cockpit-tools`
- 快照版本：`v1.3.81`（2026-11-09 发布，`package.json` `version` = 1.3.81）
- 源码快照位置：仓库外的本地只读快照 `_upstream_audit/cockpit-tools-2026-11`（codeload main tarball，2761 文件 / 69.5 MB）
- 本项目基线：Chimera++ `v2.8.10`（`package.json`）
- 目的：回答「现有平台的账号管理做得不够完善，参考 cockpit-tools 完善优化账号管理切换」这个诉求，产出可执行的差距清单。
- 标注约定：**事实**＝我读到的源码/文档原文；**推测**＝基于代码结构的合理推断但未运行验证；**未验证**＝需要实机或运行才能确认。

> 法律前提（先读）：本仓库**没有任何 LICENSE 文件**，GitHub API `license` 字段为 `null`，README 末尾「许可证」段声明为 **CC BY-NC-SA 4.0（署名-非商业性使用-相同方式共享）**。因此本文只提取**设计思路与交互契约**，不复制其代码。详见第 7 节。

---

## 1. 项目概况

### 1.1 基本事实

| 项目 | 值 | 来源 |
| --- | --- | --- |
| 仓库 | `jlcodes99/cockpit-tools` | GitHub API |
| Stars / Forks | 19,851 / 1,790 | GitHub API（2026-11-10 取） |
| 创建时间 | 2026-01-16T07:09:32Z | GitHub API |
| 最近推送 | 2026-11-09T11:01:58Z | GitHub API |
| 最新版本 | `v1.3.81`（2026-11-09T11:00:44Z，38 个 release asset） | GitHub API `/releases` |
| 发版节奏 | v1.3.79(11-05) → v1.3.80(11-07) → v1.3.81(11-09)，约 2–3 天一个版本 | GitHub API |
| Open issues | 1,030 | GitHub API |
| 主语言 | Rust | GitHub API `language` |
| 许可证 | **API 返回 `null`，仓库内无 LICENSE 文件**；README 自述 CC BY-NC-SA 4.0 | GitHub API + `README.md` 许可证段 |
| 仓库体量 | `git/trees?recursive=1` 2883 条目，全部 blob 合计 72,859,669 B（69.5 MB），无 LFS | GitHub API |
| 文件数 | 1,234 个 `.rs`；1,029 个 `.ts/.tsx`；18 个 locale JSON | 本地快照实测 |

### 1.2 技术栈（`package.json` 事实）

| 层 | 选型 |
| --- | --- |
| 桌面壳 | **Tauri 2**：`@tauri-apps/cli` 2.10.1、`@tauri-apps/api` ~2.10.0；插件 `clipboard-manager` / `dialog` / `fs` / `opener` / `process` / `updater` |
| 前端框架 | React 19.1.0 + react-dom 19.1.0，`type: module` |
| 状态管理 | zustand 5.0.10（每个平台一套 store） |
| UI 库 | daisyui 5.5.14 + tailwindcss 3.4.19 + lucide-react 0.562 + clsx + tailwind-merge |
| 国际化 | i18next 25.7.4 + react-i18next 16.5.3，18 种语言 |
| 其它前端依赖 | `protobufjs` 8.7（手工编解码 VS Code `state.vscdb` 的 topic protobuf）、`otplib` 13.4 + `otpauth` 9.5（TOTP 2FA 保险库）、`blueimp-md5`（账号 ID 生成）、`jsqr` + `qrcode-generator`（二维码）、`date-fns` 4.1 |
| 构建 | vite 7 + typescript 5.8 |
| Rust 结构 | Cargo workspace：**`crates/cockpit-core`（共享核心库）+ `crates/cockpit-cli` + `src-tauri`** |
| 测试脚本 | `test:rust` = `cargo test --package cockpit-tools --lib`；`test:rust:core` = `cargo test --package cockpit-core -- --test-threads=1` |

> 事实：`devDependencies` 里仍留着 `electron ^42`，但 Tauri 才是实际壳层；判断为历史遗留，未验证。

### 1.3 与本项目的重叠度

| 维度 | cockpit-tools | Chimera++ | 重叠判断 |
| --- | --- | --- | --- |
| 壳层 | Tauri 2（2.10.x） | Tauri 2（`@tauri-apps/api` 2.12.4） | 完全同类，UI/权限模型可直接对照 |
| 前端 | React 19 + zustand + daisyui + tailwind | React（`src/views`、`src/components`，自研 CSS 分文件） | 同类，但 cockpit-tools 的账号页是一个巨型 `use*Controller` hook 树 |
| 后端 | Rust（1,234 个 .rs） | Rust（281 个 .rs，231,765 行） | 同类，规模差约 4.4 倍 |
| 产品定位 | **16 个 AI IDE/CLI 的通用账号管理器**（Antigravity/Codex/CP/Windsurf/Kiro/Cursor/Grok/CodeBuddy×3/Qoder/Trae×4/Zed/ZCode） | **Codex + Claude 线路切换 + 运行时管理**（线路/供应商为主对象） | **部分重叠**：都把「一号一档」的凭证存本机并写回官方 CLI 的 live 配置。但 cockpit-tools 的核心对象是 `Account`，Chimera++ 的核心对象是 `Provider`（线路），账号是线路上的一个 pin |
| 数据落盘 | `~/.cockpit_tools/`（账号/配置/日志/备份/实例） | `src-tauri` 自管：Codex 用 DPAPI vault（`accounts/`、`pending/`、`tombstones/`），Claude 用 `CodeVault` | 不同实现，Chimera++ 的密钥保护更强（见 6.3） |
| 多开 | **受管实例**（`instances/<platform>`，每实例独立 profile 目录 + symlink 共享） | 无受管实例概念 | **cockpit-tools 独有** |

**结论（事实）**：cockpit-tools 不是「同类竞品」，而是**同类问题在 16 个平台上的横向展开**。它值得抄的不是架构，而是**账号这个实体的字段设计、切换过程的可观测性、以及配额/唤醒的产品化程度**。

---

## 2. 账号管理数据模型

### 2.1 三层结构：Index（明文摘要）+ Detail（加密详情）+ 平台专有扩展

这是本项目最该先抄的结构性决定（**事实**）：

```
<data_dir>/accounts.json          ← AccountIndex（明文，只存摘要，用于列表页秒开）
<data_dir>/accounts/<id>.json     ← 每账号一个详情文件（AES-256-GCM 信封，含全部凭证）
<data_dir>/accounts/<id>.json.bak ← 原子写的备份，解密失败时可回滚
```

- `AccountIndex`：`crates/cockpit-core/src/models/account.rs:101`，字段 `version: "2.0"`、`accounts: Vec<AccountSummary>`、`current_account_id: Option<String>`。
- `AccountSummary`：`crates/cockpit-core/src/models/account.rs:109`，只有 `id` / `email` / `name` / `created_at` / `last_used`。
- 设计意图（事实，来自 `src-tauri/src/modules/secure_account_storage.rs:1-5` 文件头注释）："Index/summary files stay plaintext; only per-account detail JSON is encrypted at rest." —— **列表读不碰解密，详情才解密**。
- `LIST_ACCOUNTS_CACHE_TTL_MS = 800`（`src-tauri/src/modules/account.rs:53`）：列表还有 800 ms 内存缓存，防止前端连续刷新把磁盘打满。

### 2.2 `Account`（Antigravity / 通用平台）字段表

来源：`crates/cockpit-core/src/models/account.rs:7-40`

| 字段 | 类型 | 行 | 说明 |
| --- | --- | --- | --- |
| `id` | `String` | 8 | 存储 ID；Antigravity 用 `antigravity_{md5(lower(email))}`（`src-tauri/src/modules/account.rs:681-684`） |
| `email` | `String` | 9 | 账号标识 |
| `name` | `Option<String>` | 10 | 用户可改的显示名 |
| `tags` | `Vec<String>` | 12 | **标签**，多条，用于筛选/分组 |
| `notes` | `Option<String>` | 15 | 自由备注 |
| `token` | `TokenData` | 16 | 凭证（见 2.4） |
| `quota` | `Option<QuotaData>` | 17 | **配额快照直接存在账号记录里** |
| `disabled` | `bool` | 20 | 手动停用 |
| `disabled_reason` | `Option<String>` | 23 | 停用原因（`invalid_grant…` 可在刷新成功后自动解禁，见 `:70`） |
| `disabled_at` | `Option<i64>` | 26 | 停用时间 |
| `protected_models` | `HashSet<String>` | 29 | 该账号受保护的模型清单 |
| `quota_error` | `Option<QuotaErrorInfo>` | 32 | 最近一次配额错误 |
| `usage_updated_at` | `Option<i64>` | 34 | 用量/配额更新时间 |
| `created_at` | `i64` | 35 | 创建时间 |
| `last_used` | `i64` | 36 | **最后使用时间**（切号时刷新） |

配套类型：
- `QuotaErrorInfo`：`crates/cockpit-core/src/models/account.rs:88` —— `code: Option<u16>` / `message` / `reason` / **`validation_url`** / `timestamp`。`validation_url` 用于「配额错误 → 点一下去重新授权」。
- `TokenData`：`crates/cockpit-core/src/models/token.rs:4` —— `access_token` / `refresh_token` / `expires_in` / `expiry_timestamp` / `token_type` / `email` / `project_id` / `is_gcp_tos` / `oauth_client_key` / `id_token` / `session_id`。
- `QuotaData`：`crates/cockpit-core/src/models/quota.rs:25` —— `models: Vec<ModelQuota>` / `last_updated` / `is_forbidden` / **`subscription_tier`（FREE/PRO/ULTRA）** / `credits: Vec<CreditInfo>` / `tier_id`。
- `ModelQuota`：`crates/cockpit-core/src/models/quota.rs:5` —— `name` / `display_name` / **`percentage: i32`（剩余百分比 0–100）** / `reset_time: String`。
- `CreditInfo`：`crates/cockpit-core/src/models/quota.rs:15` —— `credit_type` / `credit_amount` / `minimum_credit_amount_for_usage`。

> 关键约定（事实）：**`percentage` 存的是「剩余」而不是「已用」**，因为 UI 语义是「这个号还剩多少能跑」。本项目 Claude 侧存的是 `utilization`（已用，见 `src-tauri/src/claude_accounts/quota.rs:61`），两边语义相反 —— 做统一视图时必须显式换算。

### 2.3 `CodexAccount`（Codex 专有，字段最多）字段表

来源：`crates/cockpit-core/src/models/codex.rs:52-107`

| 分组 | 字段 | 行 | 说明 |
| --- | --- | --- | --- |
| 身份 | `id` / `email` | 53-54 | |
| 登录方式 | `auth_mode: CodexAuthMode` | 55 | `OAuth` \| `Apikey`（`codex.rs:14`，serde lowercase） |
| | `openai_api_key` / `api_base_url` | 56-57 | API Key 账号 |
| | `api_provider_mode` / `api_provider_id` / `api_provider_name` / `api_supports_websockets` | 58-61 | `OpenaiBuiltin` \| `Custom`（`codex.rs:28`） |
| | `bound_oauth_use_local_gateway` | 62 | API Key 账号绑定一份官方 OAuth，但走本地网关 |
| 官方身份 | `user_id` / `plan_type` / `account_id` / `organization_id` | 63-66 | 从 JWT claim 解出 |
| | **`agent_identity: Option<CodexAgentIdentity>`** | 67 | Agent 运行时身份，见下 |
| 展示 | `account_name` / `account_structure` / `account_note` | 68-70 | `account_structure` 用于识别 Team 结构 |
| 出口 | **`egress_proxy_url`** | 71 | **账号级出口代理**（一个号一个出口 IP） |
| 凭证 | `tokens: CodexTokens` | 72 | `id_token` / `access_token` / `refresh_token`（`codex.rs:109`） |
| | `token_generation: u64` | 73 | 令牌代号，防并发覆盖 |
| | `token_updated_at` | 74 | |
| | `token_source_mode: String`（默认 `"managed"`） | 75 | `managed` \| 其它（外部接管） |
| | `requires_reauth` / `reauth_reason` | 76-77 | **需要重新登录**状态 |
| 配额 | `quota: Option<CodexQuota>` | 78 | 双窗口，见 2.5 |
| | `quota_error` / `usage_updated_at` | 79-80 | |
| 组织 | `tags` / `created_at` / `last_used` | 81-83 | |

`CodexAgentIdentity`（`crates/cockpit-core/src/models/codex.rs:118-130`）：`agent_runtime_id` / `agent_private_key` / `task_id` / `account_id` / `chatgpt_user_id` / `email` / `plan_type` / `chatgpt_account_is_fedramp`。serde alias 同时接受 `agentRuntimeId`/`agentPrivateKey`/`taskId`/`accountId`/`chatgptUserId`/`planType` —— **这是为了让本项目的结构体既能读官方 `auth.json` 的 camelCase，也能读自己落盘的 snake_case**（事实，由 alias 列表推断）。

`CodexAuthFile`（`crates/cockpit-core/src/models/codex.rs:176-201`）＝ `~/.codex/auth.json` 的形状：`auth_mode` / `OPENAI_API_KEY`（`serde_json::Value`，**可 null 可 string**）/ `base_url`（alias `api_base_url`、`apiBaseUrl`）/ `tokens: CodexAuthTokens` / `agent_identity`（alias `agentIdentity`）/ `last_refresh`（`Value`，字符串或数字都接受）。`CodexAuthTokens`（`:203`）比 `CodexTokens` 多一个 `account_id`。

### 2.4 `CodexQuota`：双窗口（5 小时 + 周）

`crates/cockpit-core/src/models/codex.rs:139-165`：

| 字段 | 行 | 说明 |
| --- | --- | --- |
| `hourly_percentage: i32` | 140 | 5 小时窗口剩余百分比 |
| `hourly_reset_time: Option<i64>` | 141 | 重置时刻（unix） |
| `hourly_window_minutes: Option<i64>` | 142 | 窗口长度 |
| `hourly_window_present: Option<bool>` | 143 | 服务端是否给了这个窗口 |
| `weekly_percentage: i32` | 146 | 周窗口剩余百分比 |
| `weekly_reset_time` / `weekly_window_minutes` / `weekly_window_present` | 147-149 | |
| `raw_data: Option<Value>` | 152 | 原始响应留存，便于事后排查 |

`CodexQuotaErrorInfo`（`:167`）：`code: Option<String>` / `message` / `timestamp`。

### 2.5 凭证存储：本地随机密钥 + 每账号 AES-256-GCM 信封

来源：`src-tauri/src/modules/secure_account_storage.rs`（313 行，事实）

| 项 | 值 | 行 |
| --- | --- | --- |
| 密钥文件名 | `secure-account-storage.key` | 15 |
| 信封版本 | `VERSION: u32 = 1` | 16 |
| 密钥轮换周期 | `ROTATION_SECONDS = 30 * 24 * 60 * 60`（30 天） | 17 |
| 信封结构 | `SecureAccountEnvelope { version, kind, algorithm, key_id, nonce, ciphertext, encrypted_at }` | 20 |
| 密钥落盘 | `get_data_dir()/secure-account-storage.key`，32 随机字节 base64，走 `atomic_write::write_secret_string_atomic` | 31、75 |
| 并发保护 | `fs2::FileExt::try_lock_exclusive` 锁 `<key>.key.lock` | 55-67 |
| 加密 | 12 字节随机 nonce，`key_id = "local-secure-account-storage-v1"` | 128-140 |
| 读取 | `deserialize_account_file(path, content) -> (T, needs_rewrite)` | 203 |
| 旧明文兼容 | 明文能读，读后标 `needs_rewrite = true`，下次写自动转加密 | 203-230 |
| 恢复读取 | `read_account_file_readonly`（不建 key、不轮换、不覆盖备份） | 88 |
| 切号时间保护 | `write_account_preserving_switch_time`：只对 `last_switched_at` 做单调 max 合并 | 151 |

历史格式（只读兼容）：`EncryptedTokenEnvelope`（`src-tauri/src/modules/account.rs:58`）+ `LEGACY_TOKEN_KEY_FILE = "account-token.key"`（`:68`）+ `decrypt_legacy_token_envelope`（`:90`）—— 早期只加密 token，现已统一为整文件加密。

**结论（事实）**：既**不是**系统钥匙串，也**不是**明文，而是「本地随机密钥文件 + 每账号 AES-GCM 信封」。密钥本身只是 0600 的秘密文件，**没有绑定 OS 用户身份**（没用 DPAPI / Keychain），所以任何能读该文件的进程都能解密。README 里对 Grok CLI 更坦率："access token/refresh token 以明文 JSON 保存在本机，主要依赖操作系统账号隔离与本地文件权限保护；Unix 系统上凭据目录设为 0700、凭据文件设为 0600"。

### 2.6 账号指纹 / 身份识别

**cockpit-tools 的做法（事实）**：
- Antigravity 系：`is_strict_account_identity_match(existing, email, token)`（`src-tauri/src/modules/account.rs:656-678`）三级判定 —— ① `session_id` 相同 → 同号；② `refresh_token` 相同 → 同号；③ `email` 相同 **且** `project_id` 相同 → 同号。
- 存储 ID：`build_account_storage_id(email) = "antigravity_{md5(lower(trim(email)))}"`（`:681-684`）。
- 匹配流程 `find_matching_account_id`（`:686-750`）：先试 `generated_id` 精确命中 → 再试 strict 匹配 → 只剩一个同 email 的账号就覆盖它 → 多个同 email 时优先 `pending_oauth` 那条。
- Codex 系：**走 JWT claim**。`CodexJwtPayload`（`crates/cockpit-core/src/models/codex.rs:251`）+ `CodexAuthData`（`:266`）从 claim `https://api.openai.com/auth` 取 `chatgpt_user_id` / `chatgpt_plan_type` / `account_id` / `organization_id`。

**它的弱点（推测，基于代码）**：Antigravity 的 ID 只由 email 决定，**同一邮箱的不同 workspace/project 会坍缩成同一个账号**，只能靠 `project_id` 兜住；Codex 侧则完全没有「同 user 不同 workspace 算不同号」的显式处理。

### 2.7 与 `auth.json` 的关系

**每个账号一份快照**，不是「同一份 auth.json 反复切换」（事实，由 2.1 的目录结构 + `CodexAuthFile` 的双向映射推出）。切换时把它投影成 `~/.codex/auth.json`。Antigravity 例外：它是**原地改写 IDE 的 `state.vscdb`**（见 3.2），只有一份活登录态。

---

## 3. 切换机制

### 3.1 Codex 侧：prepare → before_commit → commit 的三段事务

来源：`src-tauri/src/modules/codex_account_runtime_switch.rs`（1073 行）

关键设计注释（**原文事实**，`:933-935`）：

> 切号事务：先同步当前官方凭证并准备目标凭证，准备成功后才停止旧 Codex 运行态并提交。目标凭证准备失败时不会关闭当前客户端；`before_commit` 失败时不会覆盖 auth.json / keyring，也不会更新当前账号索引。

函数路径：

| 阶段 | 函数 | 行 |
| --- | --- | --- |
| 判定是否需要刷新 | `is_managed_auth_refresh_due` | 3 |
| 刷新（Token Authority） | `perform_managed_token_refresh` / `refresh_managed_account_locked` / `refresh_managed_account_with_authority` | 18 / 175 / 267 |
| 校验可用 | `validate_managed_account_for_client_locked` | 142 |
| 保证新鲜 | `ensure_managed_account_fresh` / `force_refresh_managed_account` / `keepalive_managed_account` | 366 / 370 / 386 |
| 准备注入 | `prepare_account_for_injection_from_auth_dir` / `prepare_account_for_injection_from_store` | 509 / 686 |
| 实例启动预检 | `prepare_account_for_instance_launch_preflight` | 529（注释 526-528：只在 access_token 过期时才在 Token Authority 内 refresh，**不写目标 profile**） |
| 预检结果投影 | `project_preflighted_account_for_instance_launch` | 559（注释 557-558：不再发网络请求、不再轮换 refresh_token） |
| 事务外框 | `switch_account_with_prepared` | 695 |
| 阶段一 | `prepare_account_switch_locked` | 806 |
| 阶段二 | `commit_account_switch_locked` | 875 |
| 对外入口 | `switch_account_managed` / `switch_account_managed_with_before_commit` | 929 / 936 |
| 变体 | `..._and_revalidation`(949) / `..._and_revalidation_options`(961) / `..._after_reauth_with_before_commit`(978) / `..._after_reauth_options`(995) / `..._with_before_commit_options`(1039) / `..._internal`(1055) | |
| 切后动作 | `activate_provider_gateway_after_switch_if_needed` / `reactivate_if_imported_matches_current` | 733 / 769 |

**时序（事实，由函数名与注释还原）**：

```
1. prepare  (Token Authority 内)
   - 同步「当前」官方凭证回它的槽位（避免 Codex 刚轮换的 refresh_token 丢失）
   - 刷新/校验「目标」账号凭证
   - 失败 → 直接返回错误，客户端不动，索引不动，auth.json 不动
2. before_commit（可选钩子，调用方注入）
   - 允许调用方在真正落盘前做阻断性检查
   - 失败 → 同样保证「未变更」
3. commit
   - 停止旧 Codex 运行态（stopRuntime）
   - 写 auth.json / keyring（writeCredentials）
   - 同步设置（syncSettings）
   - 启动客户端（startClient，可选）
   - 更新 current_account_id 索引
```

### 3.2 Antigravity 侧：原地改 VS Code 的 `state.vscdb`

来源：`crates/cockpit-core/src/modules/db.rs`（233 行）

- 目标库：`.../User/globalStorage/state.vscdb`（SQLite）。Windows 走 `instance::get_default_user_data_dir()/User/globalStorage/state.vscdb`（`db.rs:21`）。
- `inject_account_token_to_path`（`db.rs:62`）→ `inject_token_to_path_with_metadata`（`:86`）依次写 4 个 `ItemTable` 键：
  1. `antigravityUnifiedStateSync.oauthToken`：base64 解码现存值 → `protobuf::remove_unified_topic_entry(..., "oauthTokenInfoSentinelKey")` 清旧项 → 写入新的 `create_oauth_info_with_metadata(...)` + `create_unified_topic_entry(...)` → `INSERT OR REPLACE`（`:131-179`）。
  2. `antigravityUnifiedStateSync.userStatus`：`userStatusSentinelKey` + `create_minimal_user_status_payload(email)`（`:184-194`）。
  3. `antigravityUnifiedStateSync.enterprisePreferences`：`enterpriseGcpProjectId`（有 project_id 才写，否则删 key）（`:196-218`）。
  4. `antigravityOnboarding = "true"`（`:120-125`）。
- 另有 `write_service_machine_id(service_machine_id)`（`db.rs:221`）写 `storage.serviceMachineId` —— 设备指纹字段。

**含义（事实）**：Antigravity 是**文件/数据库级 in-place 改凭证**，不是每账号一份 profile。因此它天然需要 3.4 的互斥锁。

### 3.3 多开实例：独立 profile + symlink 共享 + 复制降级

来源：`src-tauri/src/modules/codex_instance.rs`（1410 行）

- 存储：`instances_path`（`:150`）/ `load_instance_store`（`:155`）/ `save_instance_store`（`:165`）。
- profile 目录：`get_default_codex_home`（`:274`）、`get_default_instances_root_dir`（`:278`）、`profile_dir_for_instance`（`:1213`）。
- 共享实现：`create_directory_symlink`（`:420` 平台分派 / `:425` Windows）→ `create_directory_shared_link_or_copy`（`:435`）→ 失败降级 `prepare_directory_copy_fallback_target`（`:477`）+ `mark_directory_copy_fallback`（`:500`）+ `is_directory_copy_fallback`（`:509`）。文件级同理：`create_file_symlink`（`:519/524/531`）。
- 一致性：`directories_are_equivalent`（`:587`）/ `paths_point_to_same_location`（`:632`）/ `files_have_same_content`（`:563`）/ `sync_shared_directory`（`:654`）/ `sync_shared_file`（`:783`）/ `ensure_instance_shared_skills`（`:924`）。
- Windows 细节：`is_windows_reparse_point`（`:542`）；`data_paths.rs:228` 注释说明用 junction —— "Junctions do not require Windows Developer Mode or elevated privileges"。
- 账号引用重写（删号时）：`routing_references_accounts`（`:1227`）/ `disable_model_routing_for_deleted_accounts`（`:1250`）/ `replace_instance_account_reference`（`:1311`）/ `replace_bind_account_references`（`:1346`）。
- 注入：`inject_account_to_profile`（`:1362`）/ `inject_account_to_profile_for_launch`（`:1372`）。

### 3.4 并发与互斥

- Antigravity 切换门：`ANTIGRAVITY_SWITCH_GATE = Semaphore::new(1)`（`src-tauri/src/modules/account.rs:20-22`），拿不到就返回错误码 **`ANTIGRAVITY_SWITCH_BUSY`**（`:24`）。
- 自动切号互斥：`AUTO_SWITCH_IN_PROGRESS: AtomicBool` + `AutoSwitchGuard`（`:32-44`，Drop 时复位，防 panic 泄漏）。
- 全局账号变更锁（本项目对应物）：`account_mutation()`（`src-tauri/src/codex_accounts/mod.rs:37`）。

### 3.5 崩溃恢复

- cockpit-tools：`deserialize_account_from_storage`（`src-tauri/src/modules/account.rs:152`）解密失败时读 `.json.bak`，**要求备份文件名与解密出的 `id` 一致**（`:170-172`）才允许 `restore_string_atomic_if_hash_matches`（`:178-182`，SHA-256 比对）；若并发保存已胜出则放弃恢复（`:190-196`）。
- 另有 `repair_account_index_from_details`（`:304`）：index 丢了能按详情文件重建。

### 3.6 切换后如何让 IDE/CLI 生效

| 平台 | 生效方式 | 证据 |
| --- | --- | --- |
| Codex | 写 `~/.codex/auth.json` + keyring；可选 `stopRuntime` → `startClient`（**自动重启客户端**） | `CodexSwitchProgressModal.tsx:71-77` 的步骤序列含 `stopRuntime` / `startClient` |
| Antigravity IDE | 原地写 `state.vscdb`；切号前需确保 IDE 未被占用，`ensure_antigravity_running_for_no_restart_switch`（`account.rs:2423`） | `db.rs:86` |
| Antigravity 桌面版 | 写系统凭据 + 同步回退文件 `~/.gemini/jetski-standalone-oauth-token`（保留 id_token，Unix 0600） | `README.md` |
| 通用 | 通过本地 WebSocket API（`127.0.0.1:19528`）接受外部切号请求 | `README.md` |

**这一步是本项目最大的行为差异**：cockpit-tools 在 capability 上做「停/启客户端」，本项目明确不碰进程（见 6.1 P0-1）。

---

## 4. 配额监控与自动唤醒

### 4.1 Codex 配额查询

来源：`crates/cockpit-core/src/modules/codex_quota.rs`

| 项 | 值 | 行 |
| --- | --- | --- |
| 端点 | `https://chatgpt.com/backend-api/wham/usage` | 7 |
| 请求头 | `Authorization: Bearer <access_token>`、`Accept: application/json`、**`ChatGPT-Account-Id`**（空则从 access_token 解 `extract_chatgpt_account_id_from_access_token` 兜底） | 152-165 |
| 响应 | `UsageResponse { plan_type, rate_limit, code_review_rate_limit }` | 86 |
| | `RateLimitInfo { allowed, limit_reached, primary_window, secondary_window }` | 74 |
| | `WindowInfo { used_percent, limit_window_seconds, reset_after_seconds, reset_at }` | 61 |
| 语义归一 | `percentage = 100 - used_percent.clamp(0,100)`（**存剩余**） | 95-98 |
| 窗口分钟 | `(limit_window_seconds + 59) / 60` | 100-106 |
| 重置时刻 | 优先 `reset_at`，否则 `now + reset_after_seconds` | 108-119 |
| **窗口含义** | Primary = 5 小时（session），Secondary = 周 | 234（注释） |
| 失败信息 | 非 2xx 把 `[error_code:xxx]`、`[body_len:n]` 拼进错误串，并记 `request-id` / `x-request-id` / `cf-ray` | 196-216 |
| 并发上限 | `MAX_CONCURRENT: usize = 5` | 366 |

### 4.2 刷新调度：按账号去重 + 手动优先

来源：`src-tauri/src/modules/codex_quota_refresh_scheduler.rs`（349 行）

文件头注释（**原文事实**）：

> Keep the queue small and keyed by account ID. A duplicate refresh joins the existing request instead of creating another network request or cloning a full `CodexAccount`. The worker owns the operation and removes its entry on every exit path, including timeout and panic.

| 常量 | 值 |
| --- | --- |
| `MANUAL_CONCURRENCY` | 1 |
| `BACKGROUND_CONCURRENCY` | 1 |
| `MAX_BACKGROUND_PENDING_ACCOUNTS` | 16 |
| `MAX_MANUAL_PENDING_ACCOUNTS` | 16 |
| `MAX_WAITERS_PER_ACCOUNT` | 16 |
| `QUEUE_WAIT_TIMEOUT` | 120 s |
| `REFRESH_TIMEOUT` | 120 s |

结构：`PendingRefresh { waiters, priority, started, generation }`、`RefreshPriority { Manual, Background }`、全局 `IN_FLIGHT: HashMap<String, PendingRefresh>`、`MANUAL_PERMIT`/`BACKGROUND_PERMIT` 信号量、`QUEUE_CHANGED: Notify`、`BACKGROUND_EPOCH: AtomicU64`。

语义（事实）：
- **同一账号的重复请求合并**：后到者成为 waiter，共享同一结果，不重复发网络请求。
- **手动刷新会取消该账号排队中的后台刷新**（`refresh_account` 开头 `cancel_queued_background_refreshes(Some(&account_id))`）。

### 4.3 自动同步节奏：按运行时活动 + 动态间隔 + 失败退避

- `src-tauri/src/modules/codex_quota_sync.rs` 文件头注释（原文）："Automatic quota synchronization. No API gateway, subscription or WebSocket is needed: runtime activity schedules authoritative usage GETs through the common account refresh queue. Only committed quota snapshots are sent to webviews."
- `dynamic_interval(quota)`（`:91`）、`failure_backoff(failures, error)`（`:107`）—— **不是死板定时器**，是「运行时活动驱动 + 动态间隔 + 失败退避」。
- 前端兜底：`src/utils/autoRefreshScheduler.ts`，`createAutoRefreshScheduler`（`:62`）、`DEFAULT_MAX_CONCURRENT = 1`（`:21`）、初始延迟按 `stableHash(task.key)` 在 `interval*5% ~ interval*20%` 间抖动（`:30-60`）避免同一刻打满，`window.setInterval(scheduleDueTasks, tickMs)`（`:128`）。
- 其它平台用「按邮箱 hash 落盘的配额缓存」：`crates/cockpit-core/src/modules/quota_cache.rs` —— `hash_email`（`:47`）/ `write_quota_cache`（`:81`）/ `apply_cached_quota`（`:88`）。

### 4.4 默认值（`crates/cockpit-core/src/modules/config.rs`）

| 配置 | 默认 | 行 |
| --- | --- | --- |
| `auto_refresh_minutes` | **10** | 81-82 / 485 |
| `codex_auto_refresh_minutes` | 10 | 84-85 / 488 |
| `codex_auto_refresh_plan_types` | 全套餐 `free,go,plus,pro,team,business,enterprise,edu_k12,unknown` | 87-88 / 491 |
| `auto_switch_enabled` | **false** | 285 / 676 |
| `auto_switch_threshold` | **5** | 679 |
| `auto_switch_scope_mode` | `"any_group"` | 682 |
| `auto_switch_account_scope_mode` | `"all_accounts"` | 685 |
| `codex_auto_switch_enabled` | false | 303 / 691 |
| `codex_auto_switch_primary_threshold` | **20** | 694 |
| `codex_auto_switch_secondary_threshold` | **20** | 699 |
| `quota_alert_enabled` / `quota_alert_threshold` | false / **20** | 318 / 321 / 706-710 |
| `codex_quota_alert_enabled` / `_threshold` | false / 20 | 324 / 327 / 712-716 |
| `codex_quota_alert_primary_threshold` / `_secondary_threshold` | 20 / 20 | 336 / 339 / 727-731 |
| `*_startup_wakeup_enabled` + `_delay_seconds` | 分平台各一份 | 153-162 |

> 事实：**每个平台都有一份独立的 `*_auto_refresh_minutes` / `*_quota_alert_enabled` / `*_quota_alert_threshold`**（zed / ghcp / windsurf / kiro / cursor / codebuddy / codebuddy_cn / workbuddy / qoder / trae×4，见 `config.rs:99-133`）。这是「平台数 × 配置项」的二维表，代价很高。

### 4.5 自动切号评分模型

来源：`src-tauri/src/modules/account.rs`

| 函数 | 行 | 作用 |
| --- | --- | --- |
| `QuotaRefreshTrigger`（enum） | 1102 | 刷新触发来源 |
| `AutoSwitchGroupDefinition` | 1163 | 一个「模型组」的自动切号规则 |
| `AutoSwitchGroupQuota` | 1170 | 组的配额聚合 |
| `AutoSwitchTriggerContext` | 1177 | 触发上下文 |
| `normalize_auto_switch_threshold` | 1137 | 阈值归一 |
| `normalize_auto_switch_credits_threshold` | 1141 | credits 阈值归一 |
| `normalize_quota_alert_threshold` | 1145 | 预警阈值归一 |
| `available_ai_credits` | 1203 | 可用 credits |
| `default_auto_switch_groups` | 1222 | 默认组 |
| `normalize_auto_switch_scope_mode` | 1298 | 作用域 |
| `resolve_monitored_auto_switch_account_ids` | 1342 | 监控哪些号 |
| `model_matches_group_model` | 1426 | 模型是否属于该组 |
| `collect_group_quotas` | 1438 | 收集组内配额 |
| `evaluate_auto_switch_trigger` | 1493 | **核心判定** |
| `can_be_auto_switch_candidate` | 1600 | 是否可作候选 |
| `can_be_quota_alert_candidate` | 1643 | 是否可作预警对象 |
| `average_quota_percentage` | 1659 | 平均余量 |
| `compare_auto_switch_candidates` | 1670 | **候选排序** |
| `build_auto_switch_reason` | 1687 | 生成切号理由（给 UI/通知） |
| `should_emit_quota_alert` | 1712 | 预警去抖 |
| `build_quota_alert_notification_text` | 1759 | 通知文案 |
| `emit_quota_alert` / `send_quota_alert_native_notification` / `dispatch_quota_alert` / `run_quota_alert_if_needed` | 1804 / 1810,1831 / 1858 / 1870 | 原生通知链路 |
| `run_auto_switch_if_needed_inner` | 1938 | 自动切号入口 |

### 4.6 自动唤醒（「配额重置唤醒」）

来源：`src-tauri/src/modules/wakeup_scheduler.rs`（1333 行）+ `wakeup.rs`（83.4 KB）

**本质（事实）**：真的向模型发一次真实请求，把配额窗口「提前用掉/提前触发」，从而让重置周期提前滚动。README 原话："定时唤醒 AI 模型，提前触发配额重置周期"。前端对应页面 `src/pages/WakeupTasksPage.tsx`（127.4 KB）、`src/pages/WakeupVerificationPage.tsx`（58.2 KB）、`src/components/codex/CodexWakeupContent.tsx`（154.7 KB）。

常量（事实）：
- `DEFAULT_PROMPT = "hi"`
- `RESET_TRIGGER_COOLDOWN_MS = 10 * 60 * 1000`
- `RESET_SAFETY_MARGIN_MS = 2 * 60 * 1000`
- `WAKEUP_TASKS_FILE = "wakeup_tasks.json"`
- `wakeup.rs`：`CLOUD_CODE_BASE_URLS`（3 个 Google cloudcode 端点）+ `/v1internal:streamGenerateContent?alt=sse`、`USER_AGENT = "antigravity"`、`ANTIGRAVITY_SYSTEM_PROMPT`、`DEFAULT_ATTEMPTS = 2`、`BACKOFF_BASE_MS = 500`、`BACKOFF_MAX_MS = 4000`、`CLIENT_GATEWAY_POLL_INTERVAL_MS = 250`、`CLIENT_GATEWAY_MAX_POLL_ROUNDS = 240`（≈60 s）

任务模型 `ScheduleConfig`（`#[serde(rename_all = "camelCase")]`）字段：`repeatMode`、`dailyTimes`、`weeklyDays`、`weeklyTimes`、`intervalHours`、`intervalStartTime`、`intervalEndTime`、`selectedModels`、`selectedAccounts`、`crontab`、**`wakeOnReset: Option<bool>`**、`customPrompt`、`maxOutputTokens`、`timeWindowEnabled/Start/End`、`fallbackTimes`、`startupDelayMinutes`、**`executionMode`（只接受 `"auto"` \| `"confirm"`，`:282-285`）**、`confirmTimeoutMinutes`。

触发逻辑（事实）：
1. `if task.schedule.wake_on_reset { handle_quota_reset_task(app, task, now) }`（`:919-920`）
2. `handle_quota_reset_task`（`:956`）遍历账号配额
3. `should_trigger_on_reset(state, model_key, reset_at)`（`:832`）**三重去重**：
   - 同一 `reset_at` 时间戳已触发过 → 不再触发（`:846-858`）
   - `RESET_TRIGGER_COOLDOWN_MS` 10 分钟冷却（`:860-865`）
   - `last_reset_trigger_timestamps` 精确相等判定（`:869`）
4. `mark_reset_triggered`（`:882`）记录后 `run_task_with_models(&app_handle, &task_clone, "quota_reset", models)`（`:1027`）
5. `executionMode == "confirm"` 时先存 `PendingConfirmation` + 发系统通知等用户确认，`confirmTimeoutMinutes` 超时（`:1034-1049`、`:1068`、`:1098-1104`）

`WakeupResponse { reply, prompt_tokens, completion_tokens, total_tokens, trace_id, response_id, duration_ms }` —— 唤醒结果被完整记录，可在 `WakeupVerificationPage` 里核对。

---

## 5. UI 形态与交互流程

> 本节是重做界面的主要输入。cockpit-tools 的账号页信息密度远超常规，结构上是「工具栏 → 选择栏 → 卡片网格/列表/紧凑行」四层。

### 5.1 页面骨架（Codex 账号页）

| 层级 | 元素 | 来源 |
| --- | --- | --- |
| ① 工具栏 `.toolbar` | 左：搜索、视图切换、套餐筛选、标签筛选、排序、升降序；右：添加、刷新全部、隐私模式、导出、分组管理、快捷设置 | `src/pages/CodexAccountsOverviewPanel.tsx:367-585` |
| ② 全局提示 | `message-bar error\|success` | 同文件 `:356-365` |
| ③ 筛选态横幅 | `codex-overview-filter-banner is-active` + 计数 + 已选 chips + 清除 | 同文件 |
| ④ 选择栏 `codex-overview-selection-bar` | 左：全选 / 已选 N / 取消选择 / 选择全部符合条件 N 条；中：分组标签页；右：批量动作 | 同文件 `:587-708` |
| ⑤ 内容区 | 网格卡片 / 列表行 / 紧凑行 三形态切换 | `src/pages/useCodexAccountsRenderers.tsx:346 / 502 / 1748` |

#### 工具栏细节（事实）

- **搜索**：`search-box`，Search 图标 + placeholder「搜索账号...」，绑定 `searchQuery`（`:369-377`）。
- **视图切换**：`view-switcher` 三按钮 —— 紧凑 `Rows3` / 列表 `List` / 卡片 `LayoutGrid`（`:378-400`）。
- **套餐筛选**：`<MultiSelectFilterDropdown options={tierFilterOptions}>`，`allLabel` = 「全部套餐 ({{count}})」（`:401-414`）。选项来自 `buildCodexPlanFilterOptions`，固定几条：各套餐、**待授权**、**授权失败**、**0% 额度**、**已过期**、**正常账号**（`src/pages/useCodexAccountsLocalAccessController.tsx:1271-1286`），计数由 `createCodexPlanFilterCounts` 统计 `VALID`/各套餐/`ERROR`/`ZERO_QUOTA`/`EXPIRED`（`:1254-1269`）。
- **标签筛选**：`tag-filter` 按钮（无选中显示「标签筛选」，有选中显示「标签(N)」）；面板内每个标签一行 checkbox + 删除 X；底部「按标签分组展示」`groupByTag` 开关 + 「清空筛选」（`:415-491`）。
- **排序**：`<SingleSelectFilterDropdown value={sortBy} options={codexAccountSortOptions} icon={<ArrowDownWideNarrow/>}>`（`:493-499`）。
- **升降序**：`sort-direction-btn`（⬇/⬆），**自定义排序时隐藏**（`:500-526`）。
- **右侧动作**：添加账号（`Plus`，打开 `tempLogin` tab）、刷新全部（`RefreshCw`，同时刷套餐总览 + `handleRefreshAll()`）、**隐私模式**（`Eye`/`EyeOff`，切换邮箱掩码）、导出（`Upload`，标题带选中数量）、分组管理（`FolderOpen`，有筛选时加 `btn-filter-active` 并显示计数）、`<QuickSettingsPopover type="codex"/>`（`:528-585`）。

#### 选择栏细节（事实）

- 左：全选 checkbox（`:590-598`）；已选 N + 取消选择（`:599-615`）；**「选择全部符合条件 N 条」**（跨分页选中）（`:616-627`）；切换成「已选择全部符合条件 N 条」+ 取消选择（`:628-644`）。
- 中：`<PlatformGroupTabs groups activeGroupId accounts onSelectGroup onOpenManage>` 分组标签页（`:647-661`）。
- 右：Pelican 面板（`Play`）、回收站、**唤醒账号**（`Power`，title「打开账号唤醒测试，账号默认按 5h 额度从高到低排序。」，仅当存在可唤醒账号时出现）、**清理 ERROR 账号**（`CircleAlert`，`btn-danger`，带数量）、添加至分组（`FolderPlus`），以及批量导出/打标/删除（`:663-708+`）。

### 5.2 账号卡片（`grid` 形态）—— 8 个层级

来源：`src/pages/useCodexAccountsRenderers.tsx:649-1061`，样式 `src/styles/pages/codex-account-cards.css`（3044 行）

**根元素 class 组合（`:649-653`）**：

```
codex-account-card
  current                ← 当前账号
  selected               ← 多选选中
  pending-auth           ← 待授权（OAuth 流程未完成）
  new-api-exclusive      ← new-api 专供
  api-key-usage-account  ← 有额度可查的 API Key 账号
  sponsor-api-account    ← 赞助商 API 账号
  <cardSkin>             ← 皮肤（codex-account-card-skins.css）
属性 data-codex-sort-id（拖拽排序用）
```

| # | 层级 | 内容 | 行 |
| --- | --- | --- | --- |
| 1 | `card-top` | 勾选框 `card-select` → 账号名 `account-email`（API Key 账号可双击行内改名 `inline-name-editor`）→ `current-tag`「当前」→ `<CodexDeviceRestrictionBadge/>` → 配额错误 `codex-status-pill quota-error\|quota-refresh`（CircleAlert/Info 图标）→ 套餐徽章 `tier-badge ${displayPlanClass}`（`codex-plus` / `codex-pro-lite` / `codex-pro-max` / `sponsor-api` / `new-api-exclusive` / `pending-auth`） | 654-713 |
| 2 | `account-sub-line` | Team Name、API 服务徽章（添加/移除）+ `<CodexAccountOfficialBadge/>`、备注按钮、重置额度控件 `renderResetCreditControls`、代理按钮 `<CodexAccountProxyButton/>` | 719-768 |
| 3 | 摘要 | `<CodexAccountProxyCard placement="summary">`、重置额度到期行 | 770-771 |
| 4 | 登录信息行 | `signedInWithText` 或 `{accountIdLabel}: {maskAccountText(accountIdText)}` | 772-779 |
| 5 | API Key 专属 | 密钥显隐 `renderApiKeyRevealLine`、绑定官方授权 `renderOAuthBindingLine`、供应商行 + 「切换」快速换供应商、Base URL 行 + 「详情」打开服务面板（仅 cockpit/sub2api/token-plan/openai-official 类） | 780-826 |
| 6 | `card-tags` | `tag-pill` **最多显示 8 个**（注释 #962：充分利用横向空间，避免 3 个就 `+N`），超出显示 `+N` | 827-838 |
| 7 | `codex-quota-section` | 错误行 `renderQuotaErrorInline`（可带「重新授权」）→ `<CodexQuotaMiniRows/>`（**双窗口小进度条**）→ `<CodexTeamQuotaHistory/>` → 空态「暂无配额数据」；待授权账号显示「OAuth 授权」按钮 | 839-885 |
| 8 | `codex-subscription-footer ${tone}` | Calendar 图标 +「有效期」+ 剩余天数；右侧到期日期 + 「刷新」 | 886-927 |
| 9 | `codex-card-bottom` | 详细代理卡、`<AccountLastUsed accountId lastSwitchedAt createdAt formatDate>`、`<CodexSpeedControl scope="account">`、`card-footer > card-actions` 图标按钮排 | 928-1061 |

**卡片底部按钮顺序（事实）**：CLI 快速启动（Terminal）→ 服务面板（Database，仅 new-api）→ 编辑标签（Tag）→ 账号备注（FileText，仅非 API Key）→ 编辑凭据（Pencil）→ **切换（Play，非当前账号时绿色 `success`）** → 刷新配额（RotateCw）→ 导出（Upload）→ **删除/移入回收站（Trash2，`danger`）**。全部带 `title` tooltip，并用 `switchOrLaunchBlockedReason` 透传禁用原因。

**配额进度条配色（事实）**：`.codex-quota-mini-bar` / `-pct` 各有 `high | medium | low | critical | neutral` 五档，按剩余额度分色（`codex-account-cards.css`）。

### 5.3 排序规则（7 种，事实）

`src/utils/codexAccountOverview.ts:246-279` `buildCodexOverviewSortOptions`：

| value | 标签 |
| --- | --- |
| `created_at` | 按创建时间 |
| `weekly` | 按周配额 |
| `hourly` | 按 5 小时配额 |
| `weekly_reset` | 按周配额重置时间 |
| `hourly_reset` | 按 5 小时配额重置时间 |
| `subscription_expiry` | 按订阅有效期 |
| `custom` | 自定义顺序（拖拽，`.codex-custom-sort-modal`） |

比较器 `createCodexOverviewAccountComparator({ sortBy, sortDirection, customSortOrder, currentAccountId, resolveSubscriptionTimestamp })`（`src/pages/useCodexAccountsLocalAccessController.tsx:1232-1252`）—— **`currentAccountId` 参与比较：当前账号永远置顶**。

### 5.4 添加账号：5 个 tab 的单一入口

来源：`src/pages/CodexAddAccountDialog.tsx`（1639 行）

| tab | 标签 | 说明 | 行 |
| --- | --- | --- | --- |
| `tempLogin` | 官方登录 | 走有序步骤表 `<ol className="codex-temp-login-steps">`，每步 `pending\|running\|done\|error` + 序号 + 文案 | 198-206 / 322-345 |
| `oauth` | OAuth 授权 | 浏览器授权 | 210-220 |
| `token` | Token 粘贴 | | 223-230 |
| `apikey` | API Key | | 233-240 |
| `import` | 本地导入 | Database 图标 | 243-249 |

非 oauth tab 顶部都有 `<MfaQuickCodeSelect/>`（`:313`）—— **从 MFA 保险库直接取 TOTP 一次性码**，这是它比一般工具多出的一步（`src/components/MfaVaultManager.tsx` 41.8 KB、`src/utils/mfaVault.ts` 17.1 KB）。

### 5.5 切换过程的可观测性（最值得抄的交互）

来源：`src/components/CodexSwitchProgressModal.tsx`（724 行）

```
SwitchStage  = preparing | credentials | writing | starting | completed      (:23-24)
SwitchStatus = running | completed | auth-required | error                   (:25)

STEP_IDS (:71-77) =
  credentials → accessToken → refreshTokens → stopRuntime
              → writeCredentials → syncSettings → startClient

SwitchStepStatus = pending | running | completed | warning | skipped | error  (:34-35)
```

- 事件驱动：监听 `"codex-switch-progress"` CustomEvent（`:70`、`:229-230`）。
- payload（`:38-51`）：`type`（`start|error|complete|cancelled`）、`accountId`、`stage`、`progress`、`error`、`authFailure`、`step`、`stepStatus`、`details`、`launchAfterSwitch`、`canRetry`、`cancelled`。
- 完成后 **1600 ms 自动消失**（`:248-250`）。
- 有 `prerequisite` 错误文案映射（`:145`），把后端前置条件失败翻译成人话。

> 交互价值：用户点「切换」后**看得见每一步在做什么**，失败时**知道停在哪一步**、**能不能重试**、**要不要重新授权**。这直接消灭了「点了没反应 / 转了 30 秒不知道在干嘛」这类投诉。

### 5.6 健康度与辅助面板

| 面板 | 文件 | 作用 |
| --- | --- | --- |
| 账号池健康度 | `src/components/CodexAccountPoolHealthModal.tsx`（36.5 KB + 5.6 KB CSS + 25.4 KB 测试） | 池级别的可用性总览 |
| 回收站 | `src/components/CodexRecycleBinModal.tsx`（9.7 KB）+ `src/services/codexRecycleBinService.ts` | **软删除**，可恢复 |
| 账号分组 | `src/components/AccountGroupModal.tsx`（41.5 KB）+ `codexAccountGroupService.ts` | 分组管理 |
| MFA 保险库 | `src/components/MfaVaultManager.tsx`（41.8 KB） | TOTP |
| 标签编辑 | `src/components/TagEditModal.tsx`（19.7 KB） | 标签 |
| 迁移/导出 | `src/components/SettingsAccountTransferSection.tsx`（93.4 KB）+ `src/services/dataTransferService.ts`（52.9 KB）+ `src/utils/codexExportFormats.ts`（22.4 KB） | 导入导出、脱敏导出 |
| 唤醒 | `src/pages/WakeupTasksPage.tsx`（127.4 KB）+ `WakeupVerificationPage.tsx`（58.2 KB） | 唤醒任务与核验 |

---

## 6. 差距对照表

### 6.1 主表

优先级定义：**P0**＝直接影响「切得对不对、看不看得见」；**P1**＝显著提升日常效率；**P2**＝锦上添花或依赖前置条件。

| 能力 | cockpit-tools 做法 | 本项目现状（path:line） | 差距 | 优先级 |
| --- | --- | --- | --- | --- |
| **切换后自动重启客户端** | 切换事务含 `stopRuntime` → `writeCredentials` → `syncSettings` → `startClient` 四步（`CodexSwitchProgressModal.tsx:71-77`） | 明确**不碰进程**：切号弹窗文案「已经打开的 Codex 需要你手动重启后使用新账号，本次操作不会自动关闭或重启 Codex」（`src/views/OfficialAccountsView.tsx:1362-1365`）；成功 toast 也这么写（`:736`） | **最大行为差**：用户切完必须自己重启 | **P0** |
| **切换过程可视化** | 7 步进度 + 6 种状态 + 可重试 + auth-required 分支（`CodexSwitchProgressModal.tsx:23-77`） | 只有一个 `switching` 布尔 + 按钮文案「正在切换…」（`src/views/OfficialAccountsView.tsx:1387-1396`），失败仅 toast | 无步骤、无进度、不知道卡在哪 | **P0** |
| **切换前校验** | prepare 阶段先刷目标凭证 + 可选 `before_commit` 钩子，任一失败都保证「未变更」（`codex_account_runtime_switch.rs:933-935`） | 有前置校验但很薄：`switchAccount` 前端只检查 `providerId` 存在、`needsRelogin` 为假（`src/lib/api/officialAccounts.ts:84-86`）；确认弹窗展示「更新内容/会话记录」三条静态说明（`OfficialAccountsView.tsx:1366-1378`） | 缺「目标账号令牌是否可续期 / 会不会触发重新登录」的预检 | **P1** |
| **账号标签** | `tags: Vec<String>`（`account.rs:12`）+ 标签筛选 + 按标签分组 + 卡片最多 8 个 tag-pill + `TagEditModal`（19.7 KB） | **完全不存在**：Rust 侧 `tags` 命中全是 npm `dist-tags` / release tag（`commands/misc.rs:1017`、`commands/codex_runtime.rs:3754`）；`OfficialAccountDto` 无 tags 字段（`src-tauri/src/commands/official_accounts.rs:44-65`） | 无标签、无分组、无按标签筛选 | **P0** |
| **账号分组** | `AccountGroupModal` + `codexAccountGroupService` + `PlatformGroupTabs` + `AutoSwitchGroupDefinition`（`account.rs:1163`） | 不存在 | 无 | **P1** |
| **备注** | `notes: Option<String>`（`account.rs:15`）+ 卡片备注按钮 + 专用弹窗 | **有但没接 UI**：`get_notes` / `set_notes` 命令已存在（`src-tauri/src/commands/official_accounts.rs:519/528`），前端也有封装（`src/lib/api/officialAccounts.ts:94-104`），但 `OfficialAccountsView.tsx` 未使用 | 后端能力已具备，缺 UI | **P1** |
| **配额随账号持久化** | `quota: Option<QuotaData>` / `Option<CodexQuota>` 存在账号记录里（`account.rs:17`、`codex.rs:78`） | 官方 Codex 账号**不存配额**：`get_official_account_quota(key)` 每次实时查（`commands/official_accounts.rs:378-402`），`OfficialAccountDto` 无 quota 字段；前端把结果放组件内存 `quotas` 表 | 关掉页面就没了；每次进页面要重查全部账号 | **P0** |
| **配额刷新调度（去重/合并/超时）** | 专门调度器：按账号 ID 去重、手动优先、120 s 超时、并发 1（`codex_quota_refresh_scheduler.rs` 头注释 + 常量） | 前端 `Promise.allSettled` 一把梭（`OfficialAccountsView.tsx:451`），无去重、无超时、无优先级；`localStorage` 存刷新间隔 `[0,1,5,15,30]` 分钟（`:189-190`、`:1044-1063`） | 无后端调度，多窗口/多页面会重复打接口 | **P1** |
| **配额语义（剩余 vs 已用）** | 存**剩余**百分比（`codex_quota.rs:95-98`），UI 语义「还剩多少」 | Codex 侧：`percentText(quota.remaining)`，也是剩余（`OfficialAccountsView.tsx:104`）✅ 但 Claude 侧存**已用** `utilization`（`src-tauri/src/claude_accounts/quota.rs:61`、`:73-90`） | 两条线语义相反，未来统一视图/合并排序时容易搞错 | **P2**（但要写进注释） |
| **配额错误 → 重新授权直达** | `QuotaErrorInfo.validation_url`（`account.rs:88`）+ 卡片 `renderQuotaErrorInline` 带「重新授权」动作（`useCodexAccountsRenderers.tsx:839-885`） | 只有文字：「配额查询失败，请刷新重试」（`OfficialAccountsView.tsx:35`）或后端错误串 | 用户看到错不知道怎么修 | **P1** |
| **配额预警（阈值 + 原生通知 + 去抖）** | `quota_alert_enabled` / 阈值 20（`config.rs:706-716`）+ `should_emit_quota_alert` 去抖 + `send_quota_alert_native_notification`（`account.rs:1712/1810`）+ `QUOTA_ALERT_COOLDOWN_SECONDS = 300`（`account.rs:52`） | **完全不存在**：全仓 `grep auto_switch\|wakeup\|quota_alert` 在 Rust 侧 **0 命中** | 无 | **P1** |
| **自动切号** | `evaluate_auto_switch_trigger`（`account.rs:1493`）+ `compare_auto_switch_candidates`（`:1670`）+ `build_auto_switch_reason`（`:1687`）+ Codex 双窗口阈值各 20（`config.rs:694-699`），默认关 | 不存在。唯一的「自动切换」是**故障转移队列**（`src/components/proxy/FailoverQueueManager.tsx:144`：「开启后将立即切换到队列 P1，并在请求失败时自动切换到队列中的下一个供应商」）—— 那是**请求失败切供应商**，不是**额度耗尽切账号** | 概念相近但目标不同，不能复用 | **P1** |
| **自动唤醒（配额重置唤醒）** | `wakeOnReset` + 三重去重 + 10 min 冷却 + auto/confirm 两种执行模式 + 完整结果核验页（`wakeup_scheduler.rs:832-1027`，`WakeupTasksPage.tsx` 127.4 KB） | 不存在 | 无 | **P2**（产品面差异大，见第 7 节） |
| **账号指纹展示** | 不展示；靠 `is_strict_account_identity_match`（`account.rs:656`）内部匹配 | **已经有且更好**：`AccountIdentity::key() = sha256(len‖user_id‖len‖account_id)`（`src-tauri/src/codex_accounts/identity.rs:226-237`），`Debug` 只打印前 12 位（`:240-245`）；Claude 侧 DTO 直接带 `fingerprint` 并在行内显示 `#{fingerprint}`（`src/lib/api/claudeAccounts.ts:13`、`src/components/claude-accounts/AccountRow.tsx:222`） | **本项目更强** | — |
| **同 user 不同 workspace 区分** | 未做（Antigravity ID 只由 email 决定，`account.rs:681-684`） | **已做**：`AccountIdentity { user_id, account_id }` 双字段入 key（`identity.rs:219-237`），并有测试 `same user in another workspace is another account`（`identity.rs:443-452`） | **本项目更强** | — |
| **混合登录态检测** | 无对应概念 | **已做**：`LoginClass::Conflict` —— "tokens of one account, the account id of another. Never captured or applied."（`identity.rs:252-255`、`:288-296`，测试 `:437-441`） | **本项目更强** | — |
| **新鲜度比较（防旧覆盖新）** | `write_account_preserving_switch_time` 只保 `last_switched_at`（`secure_account_storage.rs:151`） | **已做且更细**：`is_at_least_as_fresh` 按 `last_refresh` → access `exp` → id_token `iat` 三级判定（`identity.rs:334-356`）；`last_refresh_is_in_future` 防时钟回拨（`:358-373`）；测试 `material_of_another_identity_or_from_the_future_is_refused`（`vault.rs:951`） | **本项目更强** | — |
| **凭证加密** | 本地随机密钥文件 + 每账号 AES-256-GCM，密钥未绑 OS 身份（`secure_account_storage.rs:15-75`） | **已做且更强**：`CPPVAULT1\n` 魔数 + Windows **DPAPI** `CryptProtectData`（`src-tauri/src/codex_accounts/vault.rs:216`、`:707`、`:727`），目录 0700 / 文件 0600（`:186`、`:1144`），**owner-only DACL**（`restrict_to_current_user` `:781`、`vault_has_a_protected_owner_only_dacl_and_dpapi_entries` `:1180`），拒绝符号链接根（`:1163`），且 vault 路径**不跟随 app data 目录**（`:1112`） | **本项目更强** | — |
| **撤销/墓碑（删号防复活）** | 无墓碑；删除即删文件 | **已做**：`TOMBSTONES_DIR`（`vault.rs:40`）+ `set_tombstone`（`:538`）/ `has_tombstone`（`:531`）/ `clear_tombstone`（`:544`），测试 `missing_corrupt_or_tombstoned_slots_need_login`（`:1008`）、`quota_does_not_revive_missing_or_tombstoned_slots_from_live`（`mod.rs:527`） | **本项目更强** | — |
| **导入待确认（staging）** | `pending_oauth` 标记（`account.rs:760-764`）+ `find_matching_account_id` 多匹配时优先 pending | **已做**：`PENDING_DIR`（`vault.rs:39`）+ `store_candidate`（`:441`）/ `promote_candidate`（`:467`）/ `candidate_keys`（`:527`），规则「imported material only becomes a candidate until confirmed」（测试 `:972`） | **本项目更强** | — |
| **崩溃恢复** | `.json.bak` + SHA-256 比对 + 防并发覆盖（`account.rs:152-196`） | **已做且更强**：Claude Desktop 侧有完整 journal —— `PENDING_FILE`（`.swap-pending.json`）+ `ROLLBACK_DIR`（`.rollback`）+ `return_interrupted` 恢复 + 失败自动回滚（`src-tauri/src/claude_accounts/desktop_swap.rs:381-410`、`:662-748`），切前先存旧登录（`:676-716`），失败 `copy_auth_set(&rollback, main)` 复原并提示（`:734-745`） | **本项目更强**（仅 Desktop 侧；Codex 侧无此机制） | — |
| **多开实例** | 受管实例：每实例独立 profile + symlink/junction 共享 + 复制降级打 marker（`codex_instance.rs:420-509`），含实例级账号引用重写（`:1250-1346`） | 无受管实例概念；只有 Claude Code 的「并行打开」会话（`src-tauri/src/claude_accounts/code/sessions.rs` 40.4 KB，前端 `AccountRow.tsx:265-281`） | 缺实例管理 | **P2**（产品面差异） |
| **批量操作** | 全选 / 选择全部符合条件 / 批量导出 / 批量打标 / 批量删除（`CodexAccountsOverviewPanel.tsx:587-708`），`delete_accounts`（`account.rs:936`）、`reorder_accounts`（`:961`） | 无多选、无批量；删除只能一个个点（`OfficialAccountsView.tsx:1144-1157`） | 账号一多就无法管理 | **P1** |
| **回收站（软删除）** | `CodexRecycleBinModal` + `codexRecycleBinService` | 硬删除，二次确认（`OfficialAccountsView.tsx:1400-1419`） | 误删无法恢复 | **P2** |
| **搜索** | `search-box`（`CodexAccountsOverviewPanel.tsx:369-377`） | **官方账号页没有搜索**；Claude 账号页**有**（`src/components/claude-accounts/AccountsToolbar.tsx`，搜索 `name/email/note/plan`） | Codex 官方账号页缺 | **P0** |
| **筛选** | 套餐多选（含「待授权/授权失败/0% 额度/已过期/正常」5 个状态项）+ 标签筛选 | 无。Claude 侧有 6 个 filter：`all/current/oauth/token/disabled/relogin`（`AccountsToolbar.tsx:7-14`） | Codex 官方账号页缺 | **P0** |
| **排序** | 7 种 + 升降序 + 自定义拖拽 + 当前账号置顶（`codexAccountOverview.ts:246-279`） | 固定顺序：按线路在 official group 里的位置，未绑定的排最后（`src-tauri/src/commands/official_accounts.rs:177-182`）。Claude 侧有 4 种：`custom/quota/name/added`（`AccountsToolbar.tsx:17-22`） | Codex 官方账号页缺 | **P1** |
| **视图形态** | 紧凑行 / 列表 / 卡片 三形态（`useCodexAccountsRenderers.tsx:346/502/1748`） | 只有一种横向行（`OfficialAccountsView.tsx:1088-1159`）。Claude 侧有 grid/list 两种（`ClaudeAccountsCard.tsx:581`） | 缺卡片形态（信息密度不够） | **P1** |
| **邮箱隐私模式** | 工具栏 `Eye/EyeOff` 全局切换掩码 | 无开关；邮箱明文展示（`OfficialAccountsView.tsx:1114-1116`）。不过后端有 `mask_email`（`src-tauri/src/codex_accounts/identity.rs:197-202`）和 `maskAccountText` | 后端已有掩码函数，缺开关 | **P1** |
| **「当前账号」语义** | 单一 `current_account_id` | **更细致，有两个概念**：`isCurrent`（Codex 进程实际在用的登录） vs `isSelected`（所选线路 pin 的账号），以及 `liveState` 五态 `matched/unsaved/mismatch/third_party/unknown`（`src-tauri/src/commands/official_accounts.rs:53-64`、`src/lib/api/officialAccounts.ts:6-29`） | **概念上本项目更强**，但 UI 把它压成一行「使用中」标签（`OfficialAccountsView.tsx:1108-1110`），信息被浪费 | 保留概念，**P1** 把 mismatch/unsaved 做成明确状态 | 
| **不一致态提示** | 无对应概念（只有一个 current） | **已有 banner**：`liveState === "mismatch"` → 「Codex 当前没有使用所选账号」+「重新应用」（`OfficialAccountsView.tsx:956-986`）；`unsaved` → 「当前登录的账号还没有保存」+「导入本机登录」（`:940-955`）；`third_party` → 说明文案（`:987-992`） | **本项目更好**，但只有 3 条 banner，没有状态徽章 | **P1**（升级为卡片状态） |
| **空态引导** | 有添加弹窗 5 tab | **已有** `accounts-empty`：「连接第一个官方账号」+ 说明 + 主按钮（`OfficialAccountsView.tsx:1010-1030`） | **本项目已达标** | — |
| **账号计数** | 无显式计数（有筛选计数） | **已有**：`已保存账号 <span>{rows.length}</span>`（`OfficialAccountsView.tsx:1033-1036`） | — | — |
| **最后使用时间** | `last_used` 字段 + `<AccountLastUsed accountId lastSwitchedAt createdAt formatDate>`（`useCodexAccountsRenderers.tsx:928-1061`） | 无 `last_used` 概念；只有 `capturedAt`（vault 快照时间，`official_accounts.rs:52`） | 无法判断「哪个号最久没用」 | **P1** |
| **停用/启用** | `disabled` + `disabled_reason` + `disabled_at`，`invalid_grant` 刷新成功自动解禁（`account.rs:20-26`、`:70`） | 无停用概念。Claude 侧有 `disabled`（`src/lib/api/claudeAccounts.ts:24`、`AccountRow.tsx:190-192`） | Codex 官方账号页缺 | **P1** |
| **重新授权直达** | `requires_reauth` / `reauth_reason`（`codex.rs:76-77`）+ 卡片「OAuth 授权」按钮 | 有 `needsRelogin` + 按钮变「重新登录」（`OfficialAccountsView.tsx:1138-1142`） | **本项目已达标** | — |
| **令牌过期说明** | 通过 `quota_error` 体现 | **更清晰**：`accessExpired` 单独标记，文案区分「当前账号：令牌已过期 · Codex 下次使用时续期」/「非当前：切换后由 Codex 续期」（`OfficialAccountsView.tsx:775-782`），后端还专门有 `expired_access_quota()` 不发无谓请求（`commands/official_accounts.rs:361-375`） | **本项目更强** | — |
| **导出/导入** | `handleExport` + `codexExportFormats.ts`（22.4 KB）+ 脱敏导出 + 明文令牌警告 | Claude 侧有导出（`AddAccountMenu.tsx:262-273`，含「导出的文件里是明文令牌」警告 `:497`）；Codex 官方账号页**无导出** | Codex 官方账号页缺 | **P1** |
| **多账号「按用量排序」快捷动作** | 选择栏「唤醒账号」，默认按 5h 额度从高到低（`CodexAccountsOverviewPanel.tsx:668-683`） | 无 | 无 | **P2** |
| **健康度总览** | `CodexAccountPoolHealthModal`（36.5 KB） | 无池级视图；但有 `ConfigHealthView.tsx`（13.3 KB）是配置健康，不是账号健康 | 无 | **P2** |

### 6.2 三个最大的短板（可直接转成工单）

1. **切换＝黑盒 + 手动重启**（P0）
   - 现状：`OfficialAccountsView.tsx:1362-1365` 明确要求用户自己重启；`switching` 只是布尔。
   - cockpit-tools 参照：7 步进度弹窗 + `stopRuntime`/`startClient` + `canRetry` + `auth-required` 分支。
   - 建议：先做「进度可视化」（不碰进程也能做），再评估是否允许代管进程。

2. **账号实体太瘦：没有标签、没有分组、配额不落盘**（P0）
   - 现状：`OfficialAccountDto` 只有 14 个字段（`commands/official_accounts.rs:44-65`），无 tags / 无 quota / 无 lastUsed。
   - cockpit-tools 参照：`Account` 有 tags/notes/quota/disabled/last_used（`account.rs:7-40`）；`CodexAccount` 更细（`codex.rs:52-107`）。
   - 建议：先给 DTO 加 `tags`、`quota`(可选缓存)、`lastUsedAt`，再补 UI。

3. **列表页没有检索能力：无搜索、无筛选、无排序、无批量**（P0/P1）
   - 现状：固定按线路顺序（`official_accounts.rs:177-182`）。
   - cockpit-tools 参照：搜索 + 套餐多选（含 5 个状态项）+ 标签筛选 + 7 种排序 + 三形态视图 + 批量操作。
   - 好消息：**Claude 账号页已经全套做过了**（`AccountsToolbar.tsx`：搜索/6 filter/4 sort/grid-list/hideEmail/refreshAll），可以直接搬。

### 6.3 我们已经更好的地方（不要为了「对齐上游」而退化）

| 能力 | 本项目证据 |
| --- | --- |
| 身份模型（user × workspace 双键 + 伪匿名 key） | `src-tauri/src/codex_accounts/identity.rs:219-237`，测试 `:443-452` |
| 混合/污染登录态拒绝 | `LoginClass::Conflict`，`identity.rs:252-255` / `:288-296` / 测试 `:437-441` |
| 多级新鲜度比较 + 防未来时间 | `identity.rs:334-373`，测试 `vault.rs:951` |
| DPAPI + owner-only DACL + 0700/0600 + 拒符号链接 | `vault.rs:216/707/727/781/829/1163/1180` |
| 墓碑 + 候选（导入需确认） | `vault.rs:40/439-490/531-544`，测试 `:972` / `:1008` |
| Desktop 切换的 journal + 自动回滚 + stash 保留 5 份 | `desktop_swap.rs:40-48/662-748/486-503` |
| 配额状态机（6 态）与超额用量 | `src-tauri/src/claude_accounts/quota.rs:35-48`、`:72-78`、`:150-155` |
| 配额快照持久化（Claude 侧） | `quota.rs:81-93`、`read_snapshot`/`write_snapshot` `:327/333` |
| `isCurrent` vs `isSelected` vs `liveState` 三概念 | `commands/official_accounts.rs:53-64`、`src/lib/api/officialAccounts.ts:6-29` |
| 令牌过期时不发无效请求 | `commands/official_accounts.rs:361-375` |
| Claude 账号页的工具栏 / 卡片 / 拖拽排序 / 备注 / 停用 | `AccountsToolbar.tsx`、`AccountRow.tsx`、`ClaudeAccountsCard.tsx` |
| 令牌指纹展示 | `AccountRow.tsx:222`（`#{account.fingerprint}`） |

---

## 7. 不可借鉴的部分

### 7.1 法律 / 许可证（硬约束）

- **事实**：仓库无 LICENSE 文件，GitHub API `license = null`；`README.md` 末尾声明 **CC BY-NC-SA 4.0**，并明确禁止「任何未获授权的商业使用（含企业内部商业目的、对外商业服务、付费产品集成、二次分发售卖等）」，商业使用需单独书面授权。
- **结论**：**不能复制其代码、不能逐字搬运注释文案、不能把它的 CSS 直接拿来改**。可以借鉴的是：字段设计、状态机、流程顺序、交互契约、命名思路。CSS class 名与文案都必须自己重写。
- 另外它致谢里点名参考了 Antigravity-Manager（切号逻辑）、`router-for-me/CLIProxyAPI`（MIT）、CC Switch、Electron、Mihomo。若要从头实现某段算法，**优先去读 CLIProxyAPI（MIT）**，而不是抄 cockpit-tools。

### 7.2 产品面不同，强行对齐会变成负担

| 它做的事 | 为什么本项目不该照搬 |
| --- | --- |
| 16 个平台的账号管理 | 本项目只做 Codex + Claude。`config.rs:99-133` 那种「平台 × 配置项」二维表，在多平台时是必需品，在两平台时是纯负担 |
| 自动唤醒（真的发一次模型请求去滚动配额窗口） | 需要长期挂后台、要真花配额、还要「唤醒结果核验页」（58 KB）。这是灰色玩法，且有被上游判定异常的风险。**未验证**其合规性 |
| 应用多开（受管实例 + symlink 共享目录 + 复制降级） | 需要接管 IDE 安装/启动/进程树。本项目刻意不碰进程（见 `OfficialAccountsView.tsx:1362-1365`），引入实例管理会推翻这个边界 |
| 账号级出口代理（`egress_proxy_url`，`codex.rs:71`） | 本项目已有全局代理与故障转移（`src/components/proxy/*`、`commands/global_proxy.rs` 7.5 KB），账号级代理会与现有代理栈冲突 |
| MFA 保险库 / TOTP（`otplib` + `MfaVaultManager` 41.8 KB） | 存 TOTP secret 等于把第二因子也放本机，安全面显著扩大。本项目当前不碰 2FA 是对的 |
| WebSocket 外部切号 API（`127.0.0.1:19528`） | 增加一个本地攻击面。本项目走 Tauri IPC 已足够 |
| 赞助商皮肤（`codex-account-card-skins.css`、`sponsor-api-account`） | 商业化产物，与产品定位无关 |

### 7.3 依赖 Windows 特定的部分

| 机制 | 说明 |
| --- | --- |
| `junction::create` 建目录联接 | `src-tauri/src/modules/data_paths.rs:228`，注释明说「Junctions do not require Windows Developer Mode or elevated privileges」。本项目若要跨平台共享目录需另设方案 |
| 复制降级 fallback + marker | `codex_instance.rs:477-509`，Windows 无符号链接权限（未开开发者模式）时的兜底 |
| 注册表 / 系统凭据 | Antigravity 桌面版写「系统凭据」+ `~/.gemini/jetski-standalone-oauth-token` 回退文件（`README.md`） |
| 进程枚举 | `codex_instance.rs:363` `get_windows_app_user_data_dir` 依赖 `%APPDATA%` 布局 |

> 本项目在 Windows 上已有更强的等价物（DPAPI + DACL，`vault.rs:707/781`），不需要照搬。

### 7.4 工程质量上不该学的

- **单文件巨型化**：`src-tauri/src/lib.rs` 92.1 KB、`src/App.tsx` 143.6 KB、`src/pages/useCodexAccountsRenderers.tsx` 133.8 KB、`useCodexAccountsAccessController.tsx` 121.9 KB。可读性靠人肉记忆。
- **CSS 与组件强耦合**：`codex-account-dialogs.css` 90.2 KB、`codex-account-cards.css` 69.1 KB（3044 行），改一个卡片要动 3 个 CSS 文件。
- **约 500 个 `codex_*` 模块**：`src-tauri/src/modules/` 下 `codex_*` 前缀文件近 500 个，命名密度极高（`codex_local_access_quota_reserve.rs`、`codex_local_access_quota_cooldown.rs` 分开两个文件各 26.3/7.5 KB）。
- **`*_auto_refresh_minutes` 的平台 × 配置二维复制**（`config.rs:99-133`）：每加一个平台要改 5 处。

---

## 8. 事实、推测与未验证清单

### 8.1 本文档中的「事实」

全部带 `path:line` 的引用都来自本地源码快照（仓库外的本地只读快照 `_upstream_audit/cockpit-tools-2026-11`，`v1.3.81`）或本项目仓库，逐条读过原文。GitHub 元数据来自 `api.github.com` 实时请求。

### 8.2 明确的「推测」

| 推测 | 依据 | 风险 |
| --- | --- | --- |
| `electron ^42` 是历史遗留 | Tauri CLI 才是实际壳层，`src-tauri/` 存在 | 无（不影响结论） |
| `CodexAgentIdentity` 的 serde alias 是为了兼容官方 `auth.json` 的 camelCase | alias 列表 `agentRuntimeId`/`agentPrivateKey`/`taskId`/`accountId`/`chatgptUserId`/`planType` 与官方字段一一对应（`codex.rs:118-130`） | 低 |
| Antigravity 的 email-based ID 会让同邮箱不同 workspace 坍缩 | `build_account_storage_id` 只用 email（`account.rs:681-684`），`is_strict_account_identity_match` 需 email + `project_id` 同时相等才认（`:669-675`） | 中（需实测多 workspace 场景） |
| 自动唤醒被上游判定为异常的风险 | 它确实发真实模型请求（`wakeup.rs` 常量与 `WakeupResponse`） | 中（无法从源码判断） |
| 配额查询的 `ChatGPT-Account-Id` 头是官方后端要求 | 代码显式设置并在缺失时从 token 兜底（`codex_quota.rs:152-165`） | 低 |

### 8.3 「未验证」

- cockpit-tools 的切换在**真实 Codex CLI / IDE 上**的实际成功率、失败模式、重启耗时 —— 需要实机运行（本任务禁止编译 Rust）。
- `kill`/重启客户端的**副作用**（未保存会话是否丢失）—— 只能看它弹窗文案声称「保留已有会话，不修改会话内容」（本项目文案，非上游）。
- cockpit-tools 的 `CodexSwitchProgressModal` 事件在**后端哪一处 emit** —— 只确认了前端监听 `"codex-switch-progress"`（`:70`），未逐一定位 emit 点。
- CC BY-NC-SA 4.0 对本项目的具体适用边界（例如「接口字段名是否受版权保护」）—— 建议有商业化计划时咨询法务。
- 本项目 `get_notes`/`set_notes` 的 `table` 参数具体取值与账号的对应关系 —— 只确认命令存在（`official_accounts.rs:519/528`）与前端封装（`officialAccounts.ts:94-104`），未追到表结构。

---

## 附录 A：关键源码索引（cockpit-tools）

| 主题 | 文件 |
| --- | --- |
| 账号模型 | `crates/cockpit-core/src/models/account.rs` |
| Codex 账号模型 | `crates/cockpit-core/src/models/codex.rs` |
| 配额模型 | `crates/cockpit-core/src/models/quota.rs` |
| 令牌模型 | `crates/cockpit-core/src/models/token.rs` |
| 加密存储 | `src-tauri/src/modules/secure_account_storage.rs` |
| 账号库（增删改查/自动切号/预警） | `src-tauri/src/modules/account.rs` |
| Codex 配额解析 | `crates/cockpit-core/src/modules/codex_quota.rs` |
| 配额刷新调度 | `src-tauri/src/modules/codex_quota_refresh_scheduler.rs` |
| 配额自动同步 | `src-tauri/src/modules/codex_quota_sync.rs` |
| 配额缓存（按邮箱） | `crates/cockpit-core/src/modules/quota_cache.rs` |
| 切号事务 | `src-tauri/src/modules/codex_account_runtime_switch.rs` |
| 多开实例 | `src-tauri/src/modules/codex_instance.rs` |
| 数据目录策略 | `crates/cockpit-core/src/modules/data_paths.rs` |
| Antigravity token 注入 | `crates/cockpit-core/src/modules/db.rs` |
| 唤醒调度 | `src-tauri/src/modules/wakeup_scheduler.rs` |
| 唤醒执行 | `src-tauri/src/modules/wakeup.rs` |
| 配置默认值 | `crates/cockpit-core/src/modules/config.rs` |
| 账号页控制器 | `src/pages/CodexAccountsPage.tsx`、`useCodexAccountsBaseController.tsx`、`useCodexAccountsRenderers.tsx` |
| 账号页工具栏/选择栏 | `src/pages/CodexAccountsOverviewPanel.tsx` |
| 添加账号弹窗 | `src/pages/CodexAddAccountDialog.tsx` |
| 切号进度弹窗 | `src/components/CodexSwitchProgressModal.tsx` |
| 排序/筛选项 | `src/utils/codexAccountOverview.ts` |
| 卡片样式 | `src/styles/pages/codex-account-cards.css`、`codex-account-card-skins.css` |

## 附录 B：本项目相关源码索引

| 主题 | 文件 |
| --- | --- |
| 身份识别/登录分类/JWT | `src-tauri/src/codex_accounts/identity.rs` |
| Vault（DPAPI + 墓碑 + 候选） | `src-tauri/src/codex_accounts/vault.rs` |
| 账号 → 线路注册、quota 凭证选择 | `src-tauri/src/codex_accounts/mod.rs` |
| 登录流程 | `src-tauri/src/codex_accounts/login.rs` |
| 官方账号命令与 DTO | `src-tauri/src/commands/official_accounts.rs` |
| 线路实体（含账号 pin） | `src-tauri/src/provider.rs`（`Provider` :11、`ProviderMeta` :671、`OfficialAccountPin` :869、`official_account_key` :75） |
| Claude 配额 | `src-tauri/src/claude_accounts/quota.rs` |
| Claude Desktop 快照切换 | `src-tauri/src/claude_accounts/desktop_swap.rs` |
| Claude Desktop 登录态读取 | `src-tauri/src/claude_accounts/desktop_auth.rs` |
| 官方账号页 | `src/views/OfficialAccountsView.tsx`（+ `.css` 715 行） |
| 官方账号 API 封装 | `src/lib/api/officialAccounts.ts` |
| Claude 账号页组件 | `src/components/claude-accounts/AccountsToolbar.tsx`、`AccountRow.tsx`、`ClaudeAccountsCard.tsx`、`AddAccountMenu.tsx`、`quota.tsx`、`ClaudeUsageCard.tsx` |
