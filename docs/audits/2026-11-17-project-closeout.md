# 官方账号、界面复查与项目审计收尾（2026-11-17）

本轮承接“了解当前项目结构与功能”聊天中的官方账号体验改进、全部导航页面截图复查、独立审计及上游更新核对。功能和修复已经落地；最终前端全量测试、renderer 构建与产物大小检查均已通过，具体结果和未执行项见下文。改动保留在当前工作树，未提交、发布或更新依赖锁文件。

## 1. 官方账号与界面改进

- Codex 官方账号：把“导入本机账号”作为主要入口，整理添加菜单、空状态、当前登录与备用账号状态、重新登录和切换反馈；补充切换保留本地会话的说明，以及额度刷新范围说明。
- Claude Code／Claude Desktop：统一账号卡片、添加入口、工具栏与空状态；明确额度查询失败、需要重新登录和当前账号状态。Desktop 切换增加运行中确认，并保留本机会话正文与附件。后端接口和用户手册同步更新。
- Gemini：登录提示与工具设置文案同步修正；后端显式 API 配置优先于名称、“官方”标签和 OAuth 推断。
- 页面视觉：调整背景与提示词可读性；线路行名称最小宽度从 140px 调整为 120px，使 960px 窗口下剩余内容区域可以完整容纳操作；账号页标题禁止被压缩，修复 800px 压力尺寸下按钮和筛选栏重叠。

主要前端改动位于 `src/views/OfficialAccountsView.tsx`、`src/components/claude-accounts/`、`src/views/ToolView.tsx`、`src/views/ToolViewDesktop.tsx` 和对应样式、API 与测试。

## 2. 独立审计发现与修复复核

下表记录本轮审计后实际修复的失效路径。定向测试使用临时数据库、临时文件和可控错误注入；未操作用户的真实账号与历史库。独立审查及回归测试用于降低遗漏风险，不构成对全项目所有路径无缺陷的保证。

| 失效路径 | 修复结果 | 实现位置 |
| --- | --- | --- |
| Desktop 切换失败仅回滚账号状态，被覆盖的会话正文／附件无法恢复 | 失败时连同本地历史一起恢复；恢复失败保留备份 | `src-tauri/src/claude_accounts/desktop_swap.rs`、`claude_desktop_history.rs` |
| Claude Code 切换期间外部刷新凭据，失败回滚可能覆盖新凭据 | 凭据写入与回滚使用 CAS，只回滚本次写入 | `src-tauri/src/claude_accounts/code.rs` |
| Desktop 遗留 .old-*／.staging-* 提前清理 | 优先恢复，确认成功后清理；失败保留副本 | `src-tauri/src/claude_accounts/desktop_swap.rs` |
| OMO 更新／切换失败后 DB 选择与文件状态不一致 | 回滚选择、配置和插件，保留原始错误 | `src-tauri/src/services/omo.rs`、`services/provider/mod.rs` |
| Gemini 的官方名称／OAuth 推断覆盖显式 API 配置 | 先遵循显式 API 配置再做推断 | `src-tauri/src/services/provider/gemini_auth.rs` |
| SQL 备份导入的嵌套执行边界不完整 | 递归限制允许执行的语句，覆盖回滚情形 | `src-tauri/src/database/backup.rs` |
| 同团队、不同用户的 Codex ID／access JWT 被合并使用 | 除工作区外继续核对用户身份，拒绝不一致令牌 | `src-tauri/src/codex_accounts/identity.rs` |
| Profile 捕获“未启用提示词”后无法还原为空 | 根据捕获证据区分显式 null、缺失槽位与未捕获应用 | `src-tauri/src/services/profile.rs` |
| Profile 部分应用失败仍绑定 current，后续自动保存污染快照 | 写入前清除绑定，全部成功才绑定目标；先验证目标再自动保存旧方案 | `src-tauri/src/services/profile.rs`、`src-tauri/tests/profile_roundtrip.rs` |
| Windows 原子替换在超过 MAX_PATH 后失败 | 调用 Win32 前编码绝对扩展路径，支持盘符与 UNC；编码置于最终 CAS 检查前 | `src-tauri/src/config.rs` |

另修正三处测试夹具：JSON 宏中的 null 变量命名、SQL 导出时间注释比较、OMO canonical 插件名称。Windows 长路径用例实际创建并替换超过 260 字符的文件，同时验证提交前失败不改变原内容。

## 3. 上游核对与五项适配

五个参考仓库为 farion1231/cc-switch、Wangnov/Codex-App-Manager、yynxxxxx/Codex-X、BigPizzaV3/CodexPlusPlus、openai/codex。远程信息的采样时间固定为 **2026-11-17 17:37:52–17:37:54 Asia/Shanghai**，没有把采样结果描述为收尾时重新查询的状态。

| 编号 | 已实施适配 | 兼容边界 |
| --- | --- | --- |
| R1 | S3 的 OSS／COS／OBS virtual-hosted 寻址及签名 | 既有其他 S3 端点行为保留；无真实桶连接验证 |
| R2 | 同步／备份跳过失效 skill 链接 | Windows 适用测试已跑；Unix 专用用例未跑 |
| R3 | Codex thread_read_receipts 删除、孤儿检测与事务回滚 | 兼容稳定版与旧库缺表；未加入 main-only session_model_ids |
| R4 | 第三方原生 Responses 私有字段清理及无 call_id 输出归一化 | 只作用于 Codex／GrokBuild 原生 Responses；排除官方／托管 OAuth 和 Chat／Anthropic 转换；保留未知字段及有效密文／call_id |
| R5 | Codex ordinal-only fork 用量导入 | 覆盖缺少父 ID／路径线索时的 cutoff ordinal，保留既有去重与继承逻辑 |

完整的来源 SHA、许可证、上游差异、暂缓理由与证据索引见 [五个上游更新核对与五项适配实施](../upstream/review-2026-11-17.md)。未整体升级引擎 pin；没有新增依赖，Cargo.lock 未改。CodexPlusPlus 的 AGPL 边界继续隔离。`session_model_ids` 暂缓的原因是稳定版结构与删除语义尚需确认。

## 4. 截图范围与视觉复查

最终截图根目录：`E:/cargo-target/chimera-plusplus/ui-audit/2026-11-17`。

| 范围 | 页面数 | 内容 |
| --- | ---: | --- |
| Codex | 8 | 线路、官方账号、提示词、Skills 与 MCP、用量、管理、外观、配置体检 |
| Claude Code | 5 | 线路、官方账号、提示词、Skills 与 MCP、安装与更新 |
| Claude Desktop | 2 | 线路、官方账号 |
| Gemini | 4 | 线路、提示词、Skills 与 MCP、安装与更新 |
| OpenCode | 4 | 线路、提示词、Skills 与 MCP、安装与更新 |
| Pi | 5 | 模型线路、提示词、默认模型与 MCP、插件市场、安装与更新 |
| oh-my-pi | 4 | 模型线路、提示词、插件市场、安装与更新 |
| Grok Build | 4 | 线路、提示词、Skills 与 MCP、安装与更新 |
| 全局 | 2 | 会话、设置 |
| 合计 | **38** | 全部导航页面 |

- `before/` 保留 38 张基线截图。
- `after/wide/`：39 张，38 页的 1440×1000 截图，加设置页底部。
- `after/narrow/`：45 张，38 页的 960×640 截图，加设置页与 6 个长页面的底部。
- `after/compact/`：1 张，800×640 的 Codex 账号页压力检查。
- 最终共 **85 张页面截图**；权威清单为 `after/final-manifest.json`，并同步到 `after/manifest.json`。联系表 `contact-wide-1..3.png`、`contact-narrow-1..3.png`、`contact-bottoms.png` 已复查。
- 清单中的 body、main、content 均无页面级横向溢出。剩余子元素 overflow 为有意省略文本或版本列表边距，已目视复核；浏览器巡检的 `uiErrors=[]`。

截图来自浏览器设计预览夹具，使用虚构账号与示例数据。它验证导航页布局、文案及可见状态，不等于真实账号登录／切换端到端测试，也未穷举每一个弹窗和错误组合。设计预览禁用了账号变更与添加菜单操作，未绕过限制。

## 5. 已执行验证

日志根目录：`E:/cargo-target/chimera-plusplus/closeout-2026-11-17`。

| 检查 | 本轮结果 | 日志／说明 |
| --- | --- | --- |
| `pnpm typecheck` | 通过 | `frontend-typecheck.log` |
| `pnpm format:check` | 通过 | `frontend-format.log` |
| `pnpm test:unit --maxWorkers=1 --pool=forks --reporter=verbose` | **181 个文件、2094 项全部通过** | `frontend-unit-forks.log`，552.86s |
| `pnpm build:renderer:check` | **构建和产物大小检查均通过** | `frontend-build-final.log`；Vite 构建 16.91s，产物和临时文件位于 E: |
| `cargo fmt --manifest-path src-tauri/Cargo.toml -- --check` | 通过 | 最终 Rust 格式复核 |
| `cargo check --manifest-path src-tauri/Cargo.toml --tests` | 通过 | `cargo-check-tests.log`；运行于最后长路径修复前，随后真实测试重新编译最终源码 |
| 定向 Rust 库测试 | **738 passed，0 failed，2938 filtered out** | `rust-focused-final.log`，24.76s |
| `cargo test --manifest-path src-tauri/Cargo.toml --test profile_roundtrip -- --test-threads=2` | **15 passed，0 failed** | `profile-roundtrip.log`，12.57s |
| `git diff --check` | 通过 | 文档收尾后再次检查工作树补丁格式 |

Rust 定向库测试的完整筛选命令：

```powershell
cargo test --manifest-path src-tauri/Cargo.toml --lib -- claude_desktop_history:: claude_accounts::code:: claude_accounts::desktop_swap:: codex_accounts::identity::tests::same_workspace_ database::backup::tests:: services::omo::tests:: services::provider::gemini_auth::tests:: services::provider::tests::switch_omo_ services::provider::tests::update_current_omo_ services::s3::tests:: services::webdav_sync::archive::tests:: session_manager::providers::codex::tests::codex_read_receipts_ services::session_usage_codex::tests:: proxy::providers::codex::tests:: proxy::providers::transform_codex_responses_xai_sanitize::tests:: proxy::forwarder::tests:: config::tests:: config::cas::tests:: --test-threads=2
```

`config::tests::` 同时匹配 `app_config::tests::`，738 是实际执行数量，不是新增测试数量。两个既有 dead-code warning（`write_codex_live_for_provider`、`write_live_snapshot`）仍存在。

前端执行记录包含失败尝试：早先并发验证出现两个进程内存耗尽；线程池全量运行实际得到 180 个文件通过、1 个文件失败，2093 项通过、1 项失败（`frontend-unit-final.log`）。该失败发生在测试更改 TZ 后、调用功能前的 25 小时日期断言；独立 forks 进程复跑该文件 **22 项全部通过**（`frontend-unit-timezone.log`）。最终串行 forks 全量运行 **181 个文件、2094 项全部通过**，耗时 552.86s；不把此前失败尝试计为通过。

验证专用的 E: 外部脚本使 esbuild 使用自带 inline 传输，避免临时输入文件删除失败；renderer 构建也用外部 preload 将输出和 bundle-budget 检查重定向至 E:，未修改仓库的构建配置。所有最终前端检查串行执行。renderer 产物位于 `closeout-2026-11-17/dist`；入口 JS 为 242,153 bytes，启动资源总计 1,122,470 bytes，最大 JS 分块 663,833 bytes，最大 CSS 179,931 bytes，均低于现有预算。

## 6. 桌面启动检查与未执行项

使用 `E:/cargo-target/chimera-plusplus/debug/chimera-plus-plus.exe` 执行隔离启动检查。设置 `CC_SWITCH_TEST_HOME` 指向 `native-smoke/home`，同时重定向 APPDATA、LOCALAPPDATA、WebView 用户数据及临时目录；先确认真实 Tauri store 没有目录 override。实际新建数据库位于 `native-smoke/home/.chimera-plus-plus/chimera.db`。日志确认 v2.9.0 启动、数据库迁移至当前结构、各账号管理器初始化、主窗口创建／显示；stderr 为空，窗口枚举返回该 E: 可执行文件的唯一窗口。

系统截图两次失败，错误分别为 `FrameArrived timed out: timed out waiting on channel` 和 `window capture timed out: timed out waiting on channel`。因此原生窗口视觉检查没有确认成功，不能把浏览器截图替代为原生截图。证据在 `native-smoke/result.json`、`stdout.log`、`stderr.log` 与 `launch.json`；本轮启动的进程检查后已停止。

未执行：完整 Rust 测试集、`cargo clippy --all-targets`、完整 release／Tauri 打包、Unix 专用符号链接测试、真实云桶／同步服务请求，以及真实账号登录、凭据刷新、Claude Desktop 退出／重启和切换端到端测试。没有操作真实 Claude 进程。现有定向编译与回归已覆盖本轮相关路径，未为重复验证再运行完整 build。

构建前检查 D: 与 E: 容量；Rust 构建输出始终使用 `CARGO_TARGET_DIR=E:/cargo-target/chimera-plusplus`。2026-11-17 19:32:34（Asia/Shanghai）收尾复核 D: 约 9.98 GB、E: 约 961.66 GB 可用，构建卷满足至少 10 GB 的要求。没有删除既有缓存、node_modules 或 Rust 产物。Renderer 开发服务 PID 5668 仍监听 `127.0.0.1:3000`，`http://127.0.0.1:3000/?preview=design` 返回 HTTP 200。
