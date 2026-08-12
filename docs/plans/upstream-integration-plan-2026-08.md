# Chimera++ 上游能力集成计划

> 文档状态：调研完成，已评审并转化为 v2.5.0 执行计划（2026-08-12）
> 编写日期：2026-08-12
> 当前仓库基线：Chimera++ `main`，应用版本 `2.4.2`（本地 `79c55545`）；远程最新发布为 `v2.4.6`（`f44b103e`）
> 目标：评估并规划 CodexPlusPlus、CC Switch、Codex App Manager 的近期更新，形成可验证的分阶段集成方案
> 后续文档：[v2.5.0-upgrade-plan-zh.md](v2.5.0-upgrade-plan-zh.md)（含逐项现状审计 §0）、[v2.5.0-todo-zh.md](v2.5.0-todo-zh.md)

> **评审更新（2026-08-12）**：本计划已按当前代码逐项核对并收敛为 v2.5.0 执行计划，本文保留为调研快照，结论以 v2.5.0 升级计划 §0 为准。要点修正：
>
> 1. P0 第 1、2 项（用量去重与重建、日志/代理安全边界）经代码审计已在 v2.4.x 落地，v2.5.0 不重复实现，仅补回归测试（证据见 v2.5.0 升级计划 §0.1）。
> 2. P0 第 4 项的协议维度（按模型探测并持久化 Responses/Chat/Anthropic 协议、按所选模型路由）已于 v2.4.5–v2.4.6 落地；剩余缺口是按模型选择不同上游 provider/base_url（G4）。
> 3. 真实缺口收敛为 8 项（G1–G8），里程碑映射见 v2.5.0 升级计划 §0.2/§2；P1 第 4 项（主题运行时）按本文 §5 的决策推迟至核心能力稳定后。

## 1. 调研范围与版本快照

| 上游项目 | 本次参考版本 | 发布时间 | 与 Chimera++ 的关系 |
| --- | --- | --- | --- |
| [CodexPlusPlus](https://github.com/BigPizzaV3/CodexPlusPlus) | `v1.2.47` | 2026-08-11 | Codex 桌面端增强、注入脚本、Relay/模型路由、主题运行时 |
| [CC Switch](https://github.com/farion1231/cc-switch) | `v3.19.2` | 2026-08-06 | Chimera++ 的主要配置管理、代理、用量和多应用能力上游 |
| [Codex App Manager](https://github.com/Wangnov/Codex-App-Manager) | `v0.5.2` | 2026-08-11 | Chimera++ 的 Codex 桌面运行时与 Windows/macOS 安装能力上游 |
| [Chimera++](https://github.com/Duojiyi/chimera-codex) | `v2.4.6` | 2026-08-11 | 本项目当前远程发布基线 |

### 1.1 当前依赖差距

`src-tauri/Cargo.toml` 当前固定：

- `chimera-runtime` / `chimera-platform`：`a5075e6e4d58aad13db259e3eebeabdc0417e3b3`
- `codex-win-engine` / `codex-theme-engine`：`89b542b9299453dcd833757b10cdb15f6d14d527`

Codex App Manager `v0.5.2` 相对于本地固定提交已有 17 个提交、约 40 个文件变化；不能通过只改 Git rev 来完成安全升级，必须先审查 API、状态机、安装路径和测试契约。CC Switch `v3.19.2` 相对 `v3.19.1` 有 26 个提交，涉及代理、用量、备份、MCP、Skills、配置和前端批量交互；也不应整仓覆盖式同步。

## 2. 结论摘要

### P0：必须优先集成

1. **Codex 用量去重与重建能力**：修复交错计数器、fork/sub-agent 回放重复计数和代理响应重复入账，补齐一次性重建入口与同步锁。（评审：已在 v2.4.x 落地，转回归测试）
2. **日志、代理响应和配置的安全边界**：持久日志轮转、URL/请求体/响应体脱敏、响应体大小上限、未知工具调用显式报错、受保护配置遍历。（评审：已在 v2.4.x 落地，转回归测试）
3. **Codex App Manager 安装事务**：历史版本安装、离线安装包、SHA-256 锁定与复核、平台签名/身份/架构/版本校验、崩溃恢复和自动回滚。（评审：缺口成立 → v2.5.0 G2/G3）
4. **Codex 模型目录与供应商内单模型路由**：将 Codex++ 的 per-model relay routing 与现有模型映射、Native Responses/Chat fallback 统一，避免全供应商切换只能选择单一路由。（评审：协议维度已于 v2.4.5 落地；按模型选上游的缺口成立 → v2.5.0 G4）
5. **系统证书链支持与跨平台代理可靠性**：本地代理已具备 `rustls-native-certs`，需要核查是否完整覆盖最新上游实现和错误分类。（评审：核查结论为主路径仍 webpki-only，缺口成立 → v2.5.0 G1）

### P1：应在同一产品周期完成

1. MCP、Skills、Prompts 面板搜索与批量启停。（→ v2.5.0 G5）
2. 会话/用量导入的单飞锁、批量数据库写入和单次刷新通知。（评审：单飞锁与单次刷新已落地；批量写入 → v2.5.0 G7）
3. Codex OAuth 多账号逐账号订阅用量展示。（→ v2.5.0 G6）
4. 主题运行时的布局溢出修复、动画测试和新版 Codex 界面适配。（评审：推迟至核心能力稳定后，见 §5）
5. 更新器的目标锁定、暂停恢复一致性和安装策略恢复。（→ v2.5.0 M3）

### P2：单独评估，不直接移植

1. Codex++ DreamSkin 社区主题市场、`dreamskin://` 协议和 ZIP 主题包生态。
2. Codex++ 的网页注入、菜单注入和桌面端 UI 主题注入逻辑。
3. Codex App Manager 的完整独立安装器 UI 与中国镜像产品流程。
4. 与 Chimera++ 当前产品定位无关的官网、赞助商、广告和特定社区运营功能。

## 3. 上游更新拆解

### 3.1 CodexPlusPlus v1.2.47

### 值得集成

- **供应商内单模型路由**：同一供应商内将指定模型转发到独立的 Responses API 供应商；同时修复反向校验、首次启动竞态和输入焦点问题。
- **新版 Codex 顶部栏与注入兼容**：适配新版 Codex 主界面，限制观察范围，阻止脚本误注入嵌入式浏览器页面。
- **系统证书链**：Relay 请求信任系统证书，适用于企业代理、私有 CA 和本机证书环境。
- **会话删除撤销后的刷新修复**：与 Chimera++ 已有 Sessions 页面相关，需检查删除、撤销和刷新事件是否一致。

### 不宜直接移植

Codex++ 的核心仍是对 Codex Desktop 的 CDP/Renderer 注入、Dream Skin 和网页增强。Chimera++ 的核心是供应商、运行时、代理和会话管理，不能把注入脚本直接并入主应用。只吸收可独立验证的数据模型、路由校验和证书处理；注入逻辑必须隔离成可选能力，并默认关闭。

### 3.2 CC Switch v3.19.2

### 用量正确性

- 修复 Codex 真实日志中交错累计计数器导致的 6 到 8 倍虚高。
- 修复 fork/sub-agent rollout 重放父会话造成的重复计费，并增加 deferred files 和 suspected duplicates 可观测性。
- 代理使用记录改为响应范围稳定去重键，避免重试或 failover 反复写入。
- 提供 `Rebuild Codex Usage`：备份、清理 Codex 明细与游标、全量重导入，整个流程持有同步锁，并保证只发送一次刷新通知。

Chimera++ 已有 `rebuild_codex_usage`，但必须逐项对照上游 parser、cursor 清理、fork 识别、去重键和通知语义，不能因为命令名称相同就视为已完成。

### 安全与可靠性

- 持久诊断日志按大小轮转，限制归档数量和总容量。
- URL 去除 userinfo、query、fragment；请求/响应体不写入日志，仅保留字节数、短哈希和安全分类。
- 响应头采用 allowlist；MCP 自定义字段值不记录。
- 代理缓冲响应体和结构化输入设置大小上限，拒绝无界读取。
- 配置遍历保护压缩包、symlink/junction 和危险路径；SQL 导入隔离语句；POSIX 终端路径正确引用。
- 第三方网关返回缺少函数名的工具调用时显式失败并记录结构化诊断，不静默结束对话。

Chimera++ 已有 URL 脱敏和 `rustls-native-certs`，但应以最新上游测试作为反向回归清单。

### 管理效率与性能

- MCP、Prompts、Skills 列表增加搜索。
- MCP、Skills 增加按应用批量启用/停用，采用顺序批量操作并展示失败项。
- 备份导出改为批量 INSERT、同步恢复改为单事务。
- 用量全量重导入批量化；大文件解析放到 blocking 线程；单次同步只刷新一次前端。
- OMO 兼容 `~/.omo/omo.jsonc` / `omo.json` 和 `[opencode]` 分区。
- Hermes 提示词写入实际读取的 `~/.hermes/SOUL.md`。
- 每个 ChatGPT/Codex OAuth 账号展示订阅用量。

### 3.3 Codex App Manager v0.5.2

### 安装与更新能力

- 从 GitHub Release 分页读取历史 Codex 版本，并按平台、架构过滤。
- 确认页锁定版本、构建、安装包、来源和更新策略，防止后台目录刷新后静默改变目标。
- 支持离线 macOS `.dmg` / `.zip` 与 Windows `.msix` 安装；离线流程不访问 GitHub，也不依赖 Sparkle。
- 安装前后复核 SHA-256，并校验平台签名、包身份、架构和版本。
- macOS 原子替换、健康检查、失败回滚；Windows 支持 MSIX 强制降级和已验证的便携回退。
- 安装事务在破坏性 rename/rollback 前持久化状态，崩溃或断电后可重新接管操作。

### 对 Chimera++ 的直接价值

Chimera++ 已经承担 Codex Runtime install/update/repair/rollback，但当前依赖的 `codex-win-engine` 和 `chimera-runtime` 版本落后。优先把上游能力拆成运行时库升级、安装事务升级和 UI 目标选择三层，不要直接复制 App Manager 的完整产品界面。

### 必须同步的诚实披露

当前 App Manager 最新发布明确说明部分 Windows 安装器没有 Authenticode 签名，Tauri `.sig` 只验证更新字节，不代表系统发行者身份。Chimera++ 的下载、更新和官网文案必须保持同样的区分：Tauri updater 签名、SHA-256、Windows Authenticode、Apple Developer ID/公证不是同一种保证。

## 4. Chimera++ 已有能力与缺口

| 能力 | 当前状态 | 判定 |
| --- | --- | --- |
| 多供应商配置、API 格式与模型映射 | 已有；包含 Codex/Claude Desktop 等模型路由结构 | 继续增强 per-model routing 和校验 |
| Native Responses / Chat fallback | 已有 v2.2/v2.3 相关逻辑 | 对照 CC Switch 最新协议与错误分类补测试 |
| Codex Runtime 安装、更新、修复、回滚 | 已有 | 升级底层依赖并引入历史/离线安装目标 |
| 更新 staging | 已有 v2.3 | 加入目标锁定、暂停恢复和失败恢复验证 |
| Session manager 与 Codex 用量重建 | 已有 | 按 v3.19.2 parser/去重/单飞模型补齐 |
| URL/密钥日志脱敏 | 已有 | 扩展到持久日志、body/header、结构化错误和 crash log |
| 系统证书链 | 已有 `rustls-native-certs` 依赖 | 核查实际客户端路径和测试，不重复引入旁路实现 |
| MCP/Skills/Prompts | 已有管理能力 | 增加搜索和批量启停，保持现有权限/应用边界 |
| OAuth 账号用量 | 有认证中心和 Codex 能力基础 | 增加逐账号配额查询与失效状态显示 |
| DreamSkin/注入 | 非 Chimera++ 核心能力 | 暂不作为本计划主线 |
| 历史版本/离线安装 | 当前未达到 App Manager v0.5.2 完整能力 | P0 |

## 5. 分阶段实施计划

### Phase 0：基线冻结与差异审计

**目标**：先确认当前分支实际能力，避免重复实现或把上游不兼容代码带入。

工作项：

1. 建立三个上游的 commit/tag 清单和本地依赖映射。
2. 对 `chimera-runtime`、`chimera-platform`、`codex-win-engine`、`codex-theme-engine` 做 API、状态结构和错误类型差异审计。
3. 对 CC Switch v3.19.2 的 Codex usage、proxy、backup、MCP、Skills、config 变更分别建立 cherry-pick/手工移植清单。
4. 固定当前用量数据库样本、安装事务样本、代理脱敏样本和跨平台 CI 产物作为回归基线。

交付物：差异矩阵、依赖升级分支、不可直接移植清单。

### Phase 1：P0 安全与数据正确性

**目标**：先保证升级不会泄漏密钥、不虚报用量、不破坏现有数据库。

工作项：

1. 移植 Codex fork/sub-agent 识别和 replay 截断算法。
2. 统一代理响应去重键，加入 provider/app 命名空间和无 ID 时的确定性 fallback。
3. 完成 Codex 用量一次性重建：备份失败即停止，删除游标按路径形状匹配，导入锁覆盖全流程，前端只刷新一次。
4. 为日志、URL、header、body、MCP 字段和错误序列化建立统一脱敏出口。
5. 为压缩响应体、代理缓冲、结构化日志输入和会话文件增加明确上限。
6. 将工具调用缺函数名从静默丢弃改为可诊断错误，并确认 failover 不会掩盖真实协议错误。

验收：历史样本重算偏差小于 0.001%；重复响应不新增账单；任意测试 secret 不出现在日志、错误、快照和导出文件；大输入不会无界增长内存。

### Phase 2：供应商路由与 Codex 兼容

**目标**：增强已有供应商切换，而不是引入一套平行路由系统。

工作项：

1. 增加 provider-scoped per-model route 数据结构，明确 route 的上游 provider、模型、协议和启用条件。
2. 将 per-model route 纳入现有自动路由事务、模型 catalog 生成、认证文件写入和回滚快照。
3. 修复首次启动竞态、反向校验、空模型、重复模型和保存后重载不一致。
4. 对 Codex 新版严格 catalog 字段、Responses/Chat tool schema、reasoning、parallel tool call 顺序继续补回归测试。
5. 确认代理客户端所有路径都使用系统证书，并覆盖企业 CA/代理环境。
6. 如果保留 Codex Desktop 注入能力，单独建立 opt-in 模块和嵌入式页面排除规则，不与普通供应商切换耦合。

验收：同一 provider 可将模型 A/B 分别送往不同 Responses 上游；切换失败可完全回滚；新版 Codex 能读取生成 catalog；代理在系统证书环境下正常连接。

### Phase 3：运行时历史版本与离线安装

**目标**：把 Runtime 管理提升为可恢复的安装事务。

工作项：

1. 升级 `codex-win-engine`、`codex-theme-engine` 和 Chimera runtime 依赖到经过审计的 App Manager 上游提交，逐项处理 API 破坏性变化。
2. 新增历史版本目录查询，按平台/架构过滤并支持分页、取消和缓存。
3. 新增安装确认对象，锁定版本、构建、资产、来源、SHA-256、安装路径和自更新策略。
4. 新增本地离线安装入口；文件读取、哈希、平台签名、身份、架构和版本校验全部在安装前完成。
5. 将安装事务状态持久化到受保护目录；启动时检测未完成事务并进入恢复流程。
6. macOS 使用原子替换、健康检查和回滚；Windows 支持 MSIX 降级与便携回退；Linux 先保持现有包管理路径，不复制 Windows 语义。
7. 让 staging、暂停下载和恢复操作继续使用用户最初确认的目标，不接受后台刷新后的新目标。

验收：升级中断后可恢复；哈希改变时安装被拒绝；历史版本降级不被静默升级覆盖；失败安装不会替换健康旧版本；不同架构不会误装。

### Phase 4：管理效率与可观测性

**目标**：降低大规模配置和数据库操作的交互成本。

工作项：

1. MCP、Skills、Prompts 增加统一搜索组件和空状态。
2. MCP、Skills 增加按应用批量启停，采用顺序执行、失败继续、结果汇总和可重试。
3. 用量导入、备份导出、同步恢复改为批量数据库写入/单事务。
4. 将 blocking 解析工作移出 Tokio 异步线程，后台同步采用 single-flight，跳过错过的 tick。
5. OAuth 认证中心增加按账号的 ChatGPT/Codex 订阅用量、过期和刷新状态。
6. OMO/Hermes 配置路径按上游实际读取文件修正，并为旧文件迁移增加备份与回滚。

验收：大数据库导入期间 UI 可交互；批量操作能显示成功/失败明细；搜索在所有目标面板行为一致；旧配置不会被静默覆盖。

### Phase 5：主题和非核心能力评估

只在核心稳定后评估：

- DreamSkin 社区市场、主题包安全校验和导入协议。
- Codex++ 注入脚本和新版顶部栏增强。
- 主题运行时 overflow/motion 测试。

该阶段必须先回答：能力是否属于 Chimera++ 产品边界、是否会扩大远程内容和脚本执行面、是否需要新的安全审计与隐私披露。没有明确答案时不合并。

## 6. 数据库、配置与兼容策略

1. **不直接覆盖用户配置**：所有 provider、模型路由、OAuth、MCP、Skills 和主题迁移先写备份，再执行版本化迁移。
2. **保持未知字段**：解析 TOML/JSON/JSONC 时保留未知字段，避免上游新增字段被 Chimera++ 保存时丢失。
3. **数据库迁移可重入**：每个迁移有 schema 版本、事务边界和失败回滚；用量重建是维护操作，不伪装成普通迁移。
4. **依赖升级分批落地**：运行时库、用量 parser、代理层和前端批量操作分开提交，便于回滚和定位跨平台问题。
5. **安全版本记录**：记录上游仓库、commit、变更摘要和本地适配说明，避免未来再次混淆 fork 来源。

## 7. 测试与发布门禁

### 单元与集成测试

- Codex rollout：普通会话、fork、sub-agent、缺父日志、父子 ID 冲突、重复导入。
- Proxy usage：有/无 response id、重试、failover、跨 provider、Chat/Responses/Gemini。
- Routing：provider-scoped per-model route 的增删改、反向校验、首次启动竞态和回滚。
- Security：URL、query、userinfo、header、body、MCP 自定义字段、双重编码 JSON、超大输入。
- Install：目标锁定、哈希变化、签名/身份/架构不匹配、中断恢复、失败回滚、MSIX/DMG/ZIP。
- Bulk UI：搜索、批量启停、部分失败、取消、刷新和本地化 key 完整性。

### 跨平台验证

- Windows x64、Windows ARM64、macOS Universal、Linux x86_64。
- GUI 启动与终端 PATH、nvm/fnm/mise、系统证书、企业代理、文件锁和 rename 失败。
- 运行中的 Codex 关闭/重启、更新 staging、降级安装和恢复未完成事务。

### 发布门禁

1. 前端 format、typecheck、unit tests、生产构建通过。
2. Rust fmt、Clippy warnings denied、Rust tests 通过。
3. Candidate 构建验证版本、架构、checksum、SBOM/provenance 和 updater 元数据。
4. 每个安装资产的 SHA-256 与签名绑定关系可重算。
5. 发布说明准确区分 updater 签名、哈希、平台代码签名和公证。
6. 先发布 candidate，再进行旧版本升级/降级/恢复人工验收，最后创建正式 tag。

## 8. 任务拆分建议

| 任务 | 优先级 | 依赖 | 产出 |
| --- | --- | --- | --- |
| 上游 commit/API 差异报告 | P0 | 无 | 依赖升级清单 |
| Codex 用量 parser/去重/重建 | P0 | 差异报告 | 数据正确性补丁与样本报告 |
| 日志与代理安全边界 | P0 | 无 | 统一脱敏和大小限制 |
| per-model provider routing | P0 | 现有路由事务 | 路由数据模型、catalog、回滚 |
| runtime 历史/离线安装 | P0 | App Manager API 审计 | 安装事务和 UI |
| 批量管理与大库性能 | P1 | 数据库锁模型 | 搜索、bulk action、single-flight |
| OAuth 账号用量 | P1 | 认证中心现有实现 | 逐账号配额卡片 |
| OMO/Hermes 路径适配 | P1 | 配置迁移框架 | 兼容读写与迁移测试 |
| DreamSkin/注入能力评估 | P2 | 核心能力稳定 | 单独技术决策记录 |

## 9. 风险与决策记录

- **风险：上游发布速度很快。** 采用固定 commit、每周差异扫描和人工挑选，不追求实时整仓同步。
- **风险：三个项目的职责边界不同。** Codex++ 的注入能力、App Manager 的独立安装器流程不能未经适配搬入 Chimera++。
- **风险：历史数据修复会改变用户看到的统计。** 必须先自动备份，明确提示“重建历史用量”，并保留失败恢复路径。
- **风险：平台签名现状不一致。** UI 和官网不能把 updater 签名宣传为操作系统发行者签名。
- **决策：先做数据正确性、安全和安装恢复，再做主题市场。** 这些能力直接影响信任、可恢复性和发布质量，优先级高于视觉扩展。

## 10. 参考来源

- [CodexPlusPlus v1.2.47 Release](https://github.com/BigPizzaV3/CodexPlusPlus/releases/tag/v1.2.47)
- [CodexPlusPlus v1.2.46 Release](https://github.com/BigPizzaV3/CodexPlusPlus/releases/tag/v1.2.46)
- [CC Switch v3.19.2 Release](https://github.com/farion1231/cc-switch/releases/tag/v3.19.2)
- [CC Switch v3.19.2 English Release Notes](https://github.com/farion1231/cc-switch/blob/v3.19.2/docs/release-notes/v3.19.2-en.md)
- [Codex App Manager v0.5.2 Release](https://github.com/Wangnov/Codex-App-Manager/releases/tag/v0.5.2)
- [Chimera++ v2.4.6 Release](https://github.com/Duojiyi/chimera-codex/releases/tag/v2.4.6)
- [Chimera++ CHANGELOG](../../CHANGELOG.md)
- [现有 v2.1.0 升级计划](v2.1.0-upgrade-plan-zh.md)
