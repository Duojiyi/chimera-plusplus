# 上游同步矩阵（2026-08 / v2.5.0 周期）

> 状态：M1 审计完成（TASK-001、TASK-002、TASK-027）
> 基线：Chimera++ `origin/main` `f44b103e`（v2.4.6）
> 处置词表：`parity`（行为已对齐）/ `adapt`（按 Chimera++ 架构适配实现）/ `planned`（v2.5.0 任务）/ `deferred`（明确延后并记录原因）/ `not-applicable`（不适用）
> 配套计划：[v2.5.0-upgrade-plan-zh.md](../plans/v2.5.0-upgrade-plan-zh.md)、[v2.5.0-todo-zh.md](../plans/v2.5.0-todo-zh.md)

## 1. 依赖固定与上游版本映射（TASK-001）

| 依赖 | 固定 rev | 来源 | 上游最新 | 差距 |
| --- | --- | --- | --- | --- |
| `chimera-runtime` / `chimera-platform` | `a5075e6e` | 本仓库分支 `v2-task-10-owned-mirror`（该分支 tip 即固定 rev） | 同 rev | 无差距。该分支是 Chimera 自有镜像适配层工作区（workspace `1.2.42-chimera.1`），内部以 workspace 依赖引用 `codex-win-engine`，同样固定 `89b542b9` |
| `codex-win-engine` / `codex-theme-engine` | ~~`89b542b9`~~ → **`d29fda32`（v0.5.2，v2.5.1 已升级）** | [Wangnov/Codex-App-Manager](https://github.com/Wangnov/Codex-App-Manager) | `v0.5.2`（`d29fda32`） | 已对齐。v2.5.1 双侧联动重固定（runtime 分支新 tip `b12a02ce`），API 纯加法零适配；上游加固（ASAR 上限、MSIX 身份严格化）随升级生效；主题引擎 4 项变更随升级带入，实机皮肤回归开放给维护者（v2.5.1 TODO TASK-108） |

依赖引用关系：`src-tauri` 直接固定引擎 rev，`chimera-runtime`（runtime 分支 workspace）也固定同一 rev；升级引擎必须同时更新两处并重新固定 runtime 分支，否则产生双拷贝。

## 2. Codex App Manager `89b542b9` → `v0.5.2` 逐提交处置（TASK-002）

| commit | 内容 | 涉及 | 处置 |
| --- | --- | --- | --- |
| `98ef9b02` | feat: install historical GitHub Release builds (#257) | `codex-win-engine`（`app_version.rs` +140、`msix.rs` +71、`portable.rs` +89/−59、`sys.rs` +88/−34、`lib.rs`）+ App Manager 应用层 | `adapt` → v2.5.0 M3（TASK-009/010/028）。历史版本目录与离线导入在 `src-tauri` 应用层实现，不升级引擎 rev（原因见 §2.1）；上游新增的 ASAR 读取上限（`MAX_ASAR_PACKAGE_OFFSET_BYTES` 256MiB、`MAX_PACKAGE_JSON_BYTES` 1MiB）与 MSIX `resource_id`/publisher-ID 校验，由应用层导入前置校验（文件大小上限、SHA-256、authenticode、身份/架构/版本）等效覆盖 |
| `79f70945` | fix(themes): support Codex 26.727 main surface (#246) | `codex-theme-engine` | `deferred` → 随引擎 rev 升级一并带入（v2.5.1 计划，需配套主题回归测试） |
| `9bd21ba0` | fix(themes): harden composer scroll ownership (#248) | `codex-theme-engine` | `deferred` 同上 |
| `3036e05d` | fix(themes): invalidate composer overflow cache (#249) | `codex-theme-engine` | `deferred` 同上 |
| `f0379ee6` | feat(themes): add CSP-safe motion video intros (#226) | `codex-theme-engine` | `deferred`（主题能力扩展，P2 边界） |
| `d29fda32` / `fd730290` | 0.5.1 / 0.5.2 版本号 | — | `not-applicable` |
| `66487369` | base64 0.22 → 0.23（src-tauri 依赖） | App Manager 自身 | `not-applicable`（Chimera++ 独立管理自身依赖） |
| 其余 9 项 | App Manager 前端/CI 依赖升级（globals、vite、jsdom、@types/react 等） | App Manager 自身 | `not-applicable` |

### 2.1 决策：v2.5.0 不升级引擎 rev

- 引擎核心变更全部来自 `98ef9b02`，为**加法 API**（`read_codex_app_version_from_msix`）与**读取上限加固**；无我方可达路径上的安全修复缺失——当前引擎只处理来源受控（镜像 + SHA-256 锁定）的安装包，用户自选文件的离线导入是 v2.5.0 新增入口，由应用层前置校验覆盖。
- 升级 rev 会同时带入 4 项主题引擎行为变更，与"不破坏现有功能"的发布约束冲突；且需要联动重固定 runtime 分支 workspace。
- 结论：引擎 rev 升级 + 主题回归测试单独立项到 v2.5.1；本周期在应用层按上游 #257 语义实现历史版本安装。

## 3. CC Switch v3.19.2 处置（对照 v2.5.0 升级计划 §0）

| 上游能力 | 处置 | 证据 / 任务 |
| --- | --- | --- |
| Codex 用量交错计数、fork/sub-agent 去重、重建入口 | `parity`（v2.4.x 已落地） | 升级计划 §0.1；回归测试随 TASK-023 |
| 日志轮转、URL/body 脱敏、响应上限、MCP 字段保护 | `parity`（v2.4.x 已落地） | 升级计划 §0.1 |
| 工具调用缺函数名显式处理 | `parity` | `proxy/handlers.rs`、`proxy/providers/streaming.rs` |
| MCP/Skills/Prompts 搜索 + 批量启停 | `deferred`（2026-08-12 实施期修正：三面板在线上外壳 `ChimeraApp` 无挂载点，仅测试引用；在未挂载组件上实现属于死代码。待面板挂载策略确定后随面板一起交付） | G5 / TASK-017、018 |
| 用量导入批处理 | `adapt`（v2.5.0 实现：每文件一次锁 + 单事务提交，Claude/Codex 两路径） | G7 / TASK-020 |
| 备份导出批量 INSERT、恢复单事务 | `not-applicable`（Chimera++ 备份为整库文件级；SQL 导入已是"备份→临时库→原子替换"，优于上游方案） | TASK-030 |
| blocking 解析移出异步线程、single-flight | `parity`（v2.4.x 已落地：`session_sync_mutex` + `spawn_blocking` + `MissedTickBehavior::Skip` + 单次刷新通知） | TASK-031 |
| 逐账号 OAuth 订阅用量 | `adapt`（v2.5.0 实现于实际挂载的 `CodexOAuthSection` 账号列表；`AuthCenterPanel` 未挂载） | G6 / TASK-019 |
| OMO `~/.omo/omo.jsonc` + `[opencode]` 分区 | `parity+fix`（v2.5.1 完成写入端：round-trip 编辑器随 `json5`+`json-five` 依赖与上游辅助函数移植落地，分区写入/删除带磁盘变化检测与重解析校验，读取端切换 json5 解析。v2.5.2 修复：`json-five` 0.3.1 分词器 off-by-one 会截断文件中任何位置的块注释收尾 `/`，特定排列可穿透三重防线静默落盘——新增加载期保真门（重序列化 ≠ 原文即拒绝编辑，读取/导入不受影响），禁用流程遇不可编辑文件降级为跳过分区移除。**上游 CC Switch v3.19.2 同样受此缺陷影响**（同一实现、无第四道防线），crates.io 尚无修复版本） | G8 / v2.5.1 TASK-110～113、v2.5.2 修复 |
| Hermes `SOUL.md` | `adapt`（v2.5.0：写入/读取切换到 `SOUL.md`，旧 `AGENTS.md` 首访一次性迁移并保留备份） | G8 / TASK-022 |

## 4. CodexPlusPlus v1.2.47 处置

| 上游能力 | 处置 | 证据 / 任务 |
| --- | --- | --- |
| 供应商内单模型路由（协议维度） | `parity`（v2.4.5 `codexModelApiFormats`） | 升级计划 §0.1 |
| 供应商内单模型路由（上游维度：不同 base_url/凭据） | `planned` | G4 / TASK-013～016 |
| 系统证书链 | `planned`（本周期 M2 已实现：`combined_root_store()` 统一直连 + CONNECT 隧道，reqwest 启用 `rustls-tls-native-roots`） | G1 / TASK-004～006 |
| 会话删除撤销后的刷新一致性 | `not-applicable`（2026-08-12 审计：Chimera++ 会话删除无撤销机制，删除即终态；`useDeleteSessionMutation` 删除后乐观移除缓存 + `invalidateQueries(["sessions"])` 全量刷新 + `removeQueries` 清消息缓存，链路一致，上游缺陷类不存在） | TASK-032 |
| 新版 Codex 顶部栏注入兼容、DreamSkin、注入脚本 | `not-applicable`（P2 边界，产品定位不同） | 升级计划 §0.3 |

## 5. 回归基线（TASK-003）

- 用量正确性：`src-tauri/src/services/session_usage_codex.rs`、`session_usage.rs` 现有单元测试为基线；重建/去重行为以 v2.4.6 测试快照为准。
- 代理脱敏：`src-tauri/src/lib.rs` 的 `redact_url_for_log_with_secrets` 测试集为基线。
- 安装事务：v2.4.6 的 `commands/codex_runtime.rs` 行为（`fetch_windows_release_plan` / `install_windows_release` / `latest_portable_rollback` / `rollback_portable_install`）为基线；M3 改动不得改变既有安装入口语义。
- 跨平台 CI：`ci.yml` 三平台（windows-2022 / macos-15 / ubuntu-22.04）矩阵产物为基线。

## 6. 审计记录

- 审计日期：2026-08-12；审计人：v2.5.0 实施代理
- 数据来源：GitHub compare API（`89b542b9...v0.5.2`：17 commits / 50 files）、本仓库 `v2-task-10-owned-mirror` 分支、`src-tauri/Cargo.toml`/`Cargo.lock`
- 本矩阵随各实施 PR 持续更新；新增 `deferred` 或 `not-applicable` 项必须附原因

## 7. v2.6.0 周期同步（2026-08-18）

> 漂移扫描（2026-08-18）：CC Switch HEAD `a98829b`（v3.19.2 之后 17+ 提交，至 2026-08-17）；CodexPlusPlus `v1.2.48`（2026-08-17）；Codex App Manager `v0.5.2`（`d29fda32`，与我们固定 rev 完全一致，之后仅 1 条 dev-deps 提交，无漂移）。

### 7.1 CC Switch 推理等级能力移植（本周期完成）

| 上游提交 | 内容 | 处置 |
| --- | --- | --- |
| `40cac1a` #6228 | 模型目录 per-model reasoning levels：模型映射行新增 `reasoningLevels`/`defaultReasoningLevel`，后端叠加在原生模板与官方 vendor 目录之上（未知档位丢弃、按规范序输出、默认值回退校验）；代理 Chat/Anthropic transform 处理 `ultra` 档位 | `adapt`（cherry-pick 移植；CodexFormFields 冲突按"保留 v2.4.6 图片输入列 + 新增思考等级列"合并为 7 列网格） |
| `e163a67` | 预设预填第一轮：火山 Agent/Coding Plan low/medium/high、DouBaoSeed、Hunyuan（新增预设）、Longcat high、Grok low/medium/high | `adapt`（新增"火山 Coding Plan"与"Tencent Hunyuan"预设） |
| `c6247d1` | 预设预填第二轮：DeepSeek low/high/max、MiniMax/MiMo none/high、GLM none/high（补 Chat 路由关思考入口） | `adapt`（测试预设名对齐本 fork 既有"火山Agentplan"命名） |

### 7.2 漂移处置（本周期未合并，记录原因）

| 上游 | 内容 | 处置 |
| --- | --- | --- |
| CC Switch `3f75bbd` | StepFun effort 推断扩展到 step-3.7-flash | `deferred`（同属推理机制，未随本周期合并；后续周期可 cherry-pick） |
| CC Switch `af06356`/`9dcd348`/`e12fc62`/`d01eab9` | Kimi effort、Qianfan/BytePlus thinking 方言、OpenCode Zen 平台路由 | `deferred`（同上，reasoning 方言修正族） |
| CC Switch `46f19a1` | DeepSeek chat 缓存命中 token 计入用量 | `deferred`（用量正确性独立项） |
| CC Switch `bdeaac7` | 代理支持 Codex Alpha Search + Claude hosted WebSearch | `deferred`（代理功能面，独立评估） |
| CC Switch `de9af49` | Windows CLI 从注册表 PATH 检测 | `deferred` |
| CC Switch `d4fefef` | Windows 启动白黑闪（FOUC）修复 | `deferred` |
| CC Switch `a2e22f3` | 受管 OAuth 账户选择（54 文件） | `deferred`（大面改动，独立周期） |
| CC Switch 其余 | IME 字段加固、设备登录取消、多年趋势 tooltip、Grok 表单文案 | `deferred`（小修复） |
| CodexPlusPlus `v1.2.48` | 微信连接、Remote Control 会话恢复、临时线程 ID 防护、隐藏官方用量提醒、DeepSeek Responses code_mode 兼容 | `not-applicable`（Codex++ 自身产品面：注入/远程控制/微信；按既定政策不吸收注入与产品面；DeepSeek 兼容能力本 fork 已有等价处理） |
| Codex App Manager | 仅 `fa871cf`（js-yaml/postcss dev-deps bump） | `not-applicable`（dev-deps，与 Rust 引擎无关） |
