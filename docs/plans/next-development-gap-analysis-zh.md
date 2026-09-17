# Chimera++ 下一步开发与查漏补缺

## 文档目的

本文是给后续执行模型使用的实施规格。执行模型必须按顺序完成任务，先读指定代码，再修改，再运行该任务的验证命令。不能凭标题猜实现，也不能把“待复核”改成已确认问题。

本文不是发布说明，也不是“全部安全”的证明。每项都必须留下代码、测试或人工验证证据。若某个前置契约无法确认，停止该项实现并记录阻塞原因，不得用猜测字段或假数据继续。

## 执行总规则

1. 开始前运行 `git status --short` 和 `git diff -- src/ChimeraApp.tsx`。保留现有修改、未跟踪文件和 Pencil 文件，不执行 reset、clean、checkout 或删除操作。
2. 每个任务只修改任务表中列出的文件。发现需要扩大范围时，先把新文件和原因写入本文或任务记录。
3. 先搜索所有调用方，再改共享函数。共享函数的行为变化必须补一个回归测试。
4. 不新增依赖。优先复用已有 `UsageResult`、React Query、Tauri settings、`isTransientUsageError` 和既有测试工具。
5. 不把网络失败、鉴权失败、空数据、无限额度和真实零余额混成同一种状态。
6. 不在日志、toast、错误字符串、测试快照或截图中输出 API key、Authorization、Cookie、完整响应体或 CDP WebSocket 凭据。
7. 每个阶段完成后运行该阶段的门禁命令；命令失败时修复或记录阻塞，不得标记完成。

## 审计范围与证据等级

范围：`src/`、`src-tauri/src/`、`package.json`、CI 配置、供应商和运行时链路、代理、存储、更新及现有测试结构。

证据等级：

- **已确认**：已阅读实现并能指出触发路径。
- **待复核**：审计任务发现线索，但尚未完成独立复现。
- **未覆盖**：本轮由主审直接阅读关键实现及调用链，不使用子代理。未逐行覆盖整个仓库、未读取外部 git 依赖内部实现、未执行全量运行验证；未报告不等于没有问题。上一轮外部审计失败不作为本轮证据。

审计基线：`9891879fdd04c4e821bb7c37b2ffd4b56661c4b3`，包含进入本轮前已有的 `src/ChimeraApp.tsx` 19 行 diff。本轮仅编辑本文。

实测：`pnpm exec vitest run tests/lib/keepLastGoodUsage.test.ts` 通过，1 文件、21 测试。`git diff --check` 通过（不覆盖未跟踪文档内容）。TypeScript LSP 超时，不能记为 clean。文档诊断无缓存，不构成有效检查。本次未运行全量构建、完整 Rust 测试、真实 Codex 重启测试或线上余额请求。

## 本轮新增的确认问题与执行任务

优先级定义：P1 为应先修的正确性/数据风险，P2 为资源和维护问题。下面“确认”指源码路径成立，除明确记载外未做运行复现；旧文中的 P0 标题代表实施顺序，不表示已确认紧急可利用漏洞。

### A01：余额字段缺失被当成零（P1）

证据：`services/balance.rs` 的 `query_stepfun`、`query_siliconflow`、`query_openrouter`、`query_novita` 对金额使用 `unwrap_or(0.0)`。上游 HTTP 200 返回空对象或改名字段会产生虚假零值。`parse_f64_field` 接受字符串解析，未拒绝 NaN/Infinity。

允许修改：`src-tauri/src/services/balance.rs` 及其内联测试。先在各供应商解析位置提取最小纯解析函数，网络发送代码不重构。必需字段缺失、null、布尔、非法字符串、非有限值返回 `success:false`，真实数字 0 保持成功；OpenRouter 必须同时具备 total_credits 和 total_usage。不得把合法负值自动夹到零。

建议新增测试名 `balance_required_amounts`，表驱动覆盖上述输入与数字字符串。运行 `cargo test --manifest-path src-tauri/Cargo.toml balance_required_amounts`（本机允许 Rust 窄测试时，否则交 CI）。测试必须检查 success、remaining、错误类型，不只检查 parser 返回值。

### A02：余额识别错误与原始错误体透传（P1）

证据：`detect_provider` 使用 contains；各 query 函数实际请求硬编码官方 URL。因此问题不是已证实的任意目标 SSRF，而是伪装 URL 导致错误供应商识别，并可能把该线路 key 发给错误官方服务。两个入口是 `commands/balance.rs` 和 `commands/provider.rs` 的余额模板分支。

在同一服务中解析 URL，使用精确 hostname 匹配，保留 StepFun 两个已支持别名，不增加所有子域通配。拒绝路径/查询串伪装、userinfo、非法 scheme 和异常端口。测试合法 `/v1` 路径、大小写主机、`evil.test/?api.deepseek.com`、`api.deepseek.com.evil.test`；后两者必须在发送前失败。

所有非成功响应目前将整个 body 放进错误。改为固定 HTTP 状态消息，不返回原始 body，不记录 key。保留 `API error (HTTP 429)` / `API error (HTTP 500)` 格式以兼容 `isTransientUsageError`。不要误称现有前端没有 429/5xx 缓存处理。运行 A01 的 Rust 测试和已存在的 `pnpm exec vitest run tests/lib/keepLastGoodUsage.test.ts`。

### A03：CDP 单次命令可无限等待（P1）

证据：`codex_cdp.rs:707` 的 `send_cdp_command` 循环跳过其他 id/event/Pong；socket IO_TIMEOUT 只限制单次读，不限制持续有事件时的总时间。注入外层 deadline 不能中断卡住的内层调用。轮询请求的前端序号只忽略结果，不取消 Rust blocking 任务。

在此共享函数增加绝对 deadline，每次读前计算剩余预算并设置 socket read timeout；所有 continue 分支同样消耗总预算。超时返回固定分类。维持同一 WebSocket 上正常事件处理，不能遇到第一个无关事件就报错。调用方设置总体预算，后续 CDP 命令不得把总操作预算重置为无限。

新增本地 WebSocket fixture，持续发送不匹配 id 的消息，断言在总预算加小量调度容差内返回；另外验证正确 id、Ping、Close。fixture 线程也必须有 deadline 并 join。用单个新增测试过滤器执行，不连接真实 Codex。

### A04：子进程句柄被故意泄漏（P2）

证据：`commands/codex_runtime.rs` 的 `launch_executable_with_codex_home` 在 spawn 后调用 `std::mem::forget(child)`。Windows 标准库 Child 的 drop 不会终止子进程，forget 会跳过句柄释放。

此任务只处理该函数：用正常 drop 释放句柄，保留现有独立存活检测；不得加 kill 或同步 wait。先确认编译平台边界，其他平台如需要 reap 单独处理。Windows 窄测试用无害测试子进程证明 drop 后仍存活并由测试负责等待清理。实机启动 Codex 保持手工验收，不在单测里启动。

### A05：解锁等待文案承诺了不存在的动作（P1）

证据：首页 `attachable=true && injected=false` 分支显示“模型解锁已附加，正在等待 Codex 刷新模型列表”；后端 probe 在运行标记缺失时正好返回这个组合，而且 probe 只读，不注入或刷新。将其映射为“调试连接可用，模型解锁未确认/未安装”，不能承诺等待会自动修复。

允许修改首页状态映射及测试。先覆盖 null、不可连接、可连接未注入、已注入、停止、unsupported；再覆盖旧请求晚到和线路变化。保留已有 request sequence，不把上一轮修订回退。

### A06：更新签名提示出现过早（P2）

证据：`ChimeraApp.tsx` 更新 banner 在没有 stagedVersion 命中时显示“已通过签名验证”；`commands/settings.rs` 的验签发生在 download 完成时。检查到更新不代表安装包已验证。

首页约 3108 行与设置约 4426 行两处提示一起修订：未下载分支为“发现新版本，下载并验证后安装”；stagedVersion 与 availableVersion 相同才显示“安装包已下载并验证”。新增/扩展 `tests/integration/ProvidersUpdateBanner.test.tsx`，模拟未暂存、已暂存、不同版本、下载失败。运行 `pnpm exec vitest run tests/integration/ProvidersUpdateBanner.test.tsx`。不修改 updater 公钥或签名流程。

### A07：跨同步入口没有共享提交锁（P1，先复现）

已确认 `webdav_sync.rs::sync_mutex` 与 `s3_sync.rs::sync_mutex` 分别定义 Mutex，二者都调用 `sync_protocol.rs::apply_snapshot`，后者没有共享事务锁。`archive.rs` 还使用同一个 `.bak` 目录。当前不能声称跨后端已互斥；具体破坏结果需确定性并发测试证明。

先读上传、下载、post-import 和 profile/provider 锁顺序。给两个后端并发提交设置 barrier，证明能否交错 Skills 和 DB 状态。若复现，给共享本地 snapshot build/apply 边界串行化，网络等待不要持同步 std Mutex。锁须覆盖回滚，且不能仅在某个前端按钮加禁用。测试最终 DB 与 Skills 必须来自同一快照；失败回滚不得覆盖另一个已成功事务。

额外确认：Skills 复制失败时 rollback 的 remove/rename 错误被忽略；`apply_snapshot` 在 restore_skills_zip 失败时直接 `?`，没有使用已创建的外层备份再次恢复。补故障注入，组合报告原始和回滚错误，失败保留可恢复备份。不要把现有处理称为崩溃安全的多资源原子事务。

### A08：非 loopback 代理监听需产品决策（P1 条件风险）

`proxy/server.rs::start` 直接绑定配置地址，无 loopback gate；服务默认 127.0.0.1，但 `services/proxy.rs` 明确处理 0.0.0.0。Origin 拒绝不是认证，不能阻挡 LAN 客户端省略 Origin。尚未进行外部连接实验，不能声称默认公网暴露。

先确认 LAN 监听是否是要保留的功能。若产品仅支持本机，后端在 bind 前拒绝非 loopback 并测试配置导入路径；若需 LAN，停止该任务，取得认证与兼容方案再实现。不得未经确认删除现有 LAN 能力，也不得只修改默认值当作修复。

## P0：先修正确性与安全边界

### P0.1 Codex 解锁状态必须与真实进程绑定

**低智模型执行卡：**

1. 先读 `src-tauri/src/codex_cdp.rs`、`src-tauri/src/commands/codex_runtime.rs` 中所有 `codex_renderer_debug_port`、`probe_codex_renderer_unlock`、`inject_codex_model_unlock` 调用方。
2. 再读 `src/ChimeraApp.tsx` 中 `refreshRendererUnlock`、`loadCodexProcess`、`rendererUnlockPending` 和启动按钮渲染。
3. 只先建立一个明确的后端/前端状态映射；不要第一步就做持久化，不要改固定端口，不要改 `CONFIRM_RESTART_REQUIRED:`。
4. 为每一种探测失败写测试，证明 UI 文案是“未确认/不支持/连接失败”，而不是“手动启动”。
5. 再调查跨重启端点发现方案。只有实际验证 Codex 支持安全端口回传或端口元数据恢复后，才实现持久化。
6. 启动、重启、关闭、轮询、窗口焦点都必须经过同一个状态更新函数；所有异步结果带序号或取消机制。

**禁止：**恢复 9229/9330 固定端口；把失败探测当作启动来源证据；删除重启确认；为了绕开竞态增加无限轮询。

**证据：已确认。**

涉及：

- `src-tauri/src/codex_cdp.rs:23-45`
- `src-tauri/src/commands/codex_runtime.rs:450-459, 866-883`
- `src/ChimeraApp.tsx:721-732, 3050-3155`

当前调试端口用进程内 `OnceLock` 保存。Chimera++ 重启后，Codex 仍可能存活，但新 Chimera++ 不知道旧实例实际使用的端口。探测失败又被旧界面解释为“手动启动”，会产生错误引导。

**实现要求：**

1. 启动时持久化本次受管 Codex 实例的进程标识、启动时间和调试端点元数据；凭据不得写入日志或普通配置。
2. 探测端口必须限定为 loopback，并校验目标进程、WebSocket 主机、端口和 target URL。
3. 状态模型至少区分：`checking`、`running_unconfirmed`、`attachable`、`injected`、`unsupported`、`stopped`。
4. `attachable: false` 不得翻译成“手动启动”。只有进程命令行和启动来源被可靠识别时，才能展示“非 Chimera++ 启动”。
5. 重启仍必须保留现有确认哨兵 `CONFIRM_RESTART_REQUIRED:`。

**验收：**

- Chimera++ 重启而 Codex 不重启时，能正确探测或明确显示“状态未确认”，不能错误断言手动启动。
- Codex 由 Chimera++ 启动时，模型注入成功后重启前后状态一致。
- 自定义 `CODEX_HOME`、MSIX、无 CDP target、WebSocket 握手失败各有独立状态和提示。
- CDP 地址不是非 loopback 地址；恶意或不匹配的 target 被拒绝。

**测试：**

- Rust：为端口、target 校验、状态解析和错误分类增加单元测试。
- 前端：模拟请求乱序，确认旧探测结果不能覆盖新结果。
- Windows：手工测试“先启动 Codex，再关闭/重启 Chimera++”场景。

### P0.2 CDP 端口生命周期需要消除 TOCTOU 风险

**低智模型执行卡：**先确认 `LaunchOptions` 是否能接收端口 0、是否能返回实际端口、Codex 是否会写调试端点文件。若不能确认，不要臆造协议；保留 loopback、启动后校验和有界重试，并把 TOCTOU 记录为残余风险。

**证据：待复核，安全敏感。**

`pick_ephemeral_loopback_port` 先绑定端口、读取端口、释放监听器，再交给 Codex。释放到 Codex 绑定之间存在竞态。当前代码已限制 loopback，但仍应减少暴露窗口。

**调查与实现要求：**同一把应用锁只能防止自身并发启动，不能阻止其他进程抢占已释放的端口。先核实 Codex 是否支持由自身分配端口并安全回传；否则启动后验证实际监听者和目标进程，不匹配时拒绝连接并有界重试。不要恢复固定端口。

**验收：**增加并发启动和端口占用测试；失败时给出可恢复错误，不回退到公开固定端口。

## P1：余额功能的正确数据契约

### P1.1 明确 ChimeraHub 的两个余额来源

**低智模型执行卡：**

1. 先读 `src/lib/api/subscription.ts`、`src/lib/query/subscription.ts`、`src/lib/query/queries.ts`，确认当前余额调用是不是复用通用用量卡片。
2. 再读 `src-tauri/src/commands/balance.rs` 和 `src-tauri/src/services/balance.rs` 全部实现，不要只复制 DeepSeek 的字段处理。
3. 在实现前固定 DTO 和错误枚举。`Option<f64>` 缺失字段必须导致 schema error，不能 `unwrap_or(0.0)`。
4. 确认 ChimeraHub 服务端账户接口、鉴权方式、单位、无限额度编码和换算规则。没有正式契约时只实现 API Key 额度，账户余额显示“未支持”，不要伪造账户余额。
5. 对 URL 使用解析后的 scheme、hostname、port；允许列表放在后端常量中。测试 `api.chimerahub.org.evil.test`、用户名字段、非 HTTPS、异常端口、重定向。
6. 余额查询请求不能复用会把任意 provider 识别成已支持余额的宽松 `contains` 逻辑。
7. 前端使用已有 React Query 和 keep-last-good 规则；查询 key 必须包含 provider ID、hostname 和凭据版本，切换线路后不能显示上一条线路余额。

**禁止：**用账单接口猜账户余额；用 API Key 额度冒充账户余额；缺字段显示 0；把 0、无限、未知、失败混为一谈；在前端单独做安全域名判断。

**证据：已确认接口存在，业务口径未完成确认。**

本地 ChimeraHub `new-api` 中可见：

- `GET /api/usage/token/`（API Key 用量接口；本地源码可见，不代表线上契约已验证）
- `/dashboard/billing/subscription`
- `/dashboard/billing/usage`

`GetTokenUsage` 返回 `total_available`、`total_used`、`total_granted`；账单接口受服务端配置影响，可能按额度、人民币或 token 数量展示。不能未经契约确认，把 Key 剩余额度称为账户余额。

**实现要求：**

1. 定义明确响应类型：`apiKeyBalance` 与 `accountBalance` 分开，均带 `value`、`unit`、`currency`、`source`、`updatedAt`、`available`。
2. API Key 余额只使用当前 provider 的 API key 请求经核实的 Token 用量接口；原始 quota 必须按正式契约转换后才能显示货币值。
3. 账户余额必须使用明确的用户级认证接口；API key 无法读取时显示“不可用”，不得猜测、不得用 Key 额度替代。
4. 对 HTTP 状态、业务错误、字段缺失、单位未知分别处理。
5. 余额接口只允许 HTTPS；域名匹配使用 URL 解析后的 hostname，禁止任意字符串 `contains` 作为授权依据。
6. 默认关闭设置；关闭时不请求、不渲染、不缓存敏感余额。
7. 缓存只保留短时间成功值；瞬态网络失败显示上次成功值和更新时间，确定性鉴权失败不显示旧值为当前值。
8. 日志中禁止 API key、Authorization、完整余额响应。

**建议数据流：**

设置开关 → 前端判断是否为支持的 provider → Rust 独立校验 HTTPS 和明确允许的 hostname（当前模板为 `api.chimerahub.org`）→ HTTPS 请求 → schema 校验 → 脱敏 DTO → React Query 缓存。后端不能依赖前端校验；重定向也不能绕过主机限制。

**验收：**

- 非 ChimeraHub provider 不发余额请求。
- 设置关闭时不发余额请求且首页不留空白占位。
- Key 余额和账户余额来源不同、显示标签不同。
- 401/403、429、5xx、超时、字段缺失、未知单位均不会显示为 `$0`。
- API key 不出现在错误 toast、Rust 日志、网络诊断结果中。

### P1.2 真实首页的显示位置

**低智模型执行卡：**先打开真实首页截图和当前 `src/ChimeraApp.tsx` 首页 JSX/CSS，标出当前线路、Codex 状态、模型名、启动按钮和线路切换控件的实际边界。Pencil 只画这一个首页，不得重做导航、地图、Codex 面板或窗口尺寸。

先出两个小方案：线路信息下方紧凑行、线路切换区右侧紧凑行。比较可用宽度、隐藏状态、错误状态和移动/窄宽度溢出，选不挤压启动控件的方案。余额关闭时必须完全不占布局空间。Pencil 文件和截图只能作为设计证据，不能替代真实组件验证。

上一版 Pencil 稿与实际首页脱离，不能作为实现依据。基于当前代码结构，第一候选位置是**当前线路信息下方的一行紧凑信息**，只在“当前线路是 ChimeraHub 且设置已开启”时出现：

`API Key 余额  ¥…  ·  账户余额  ¥…  ·  更新时间  刷新`

不要新增整块导航、侧栏或大卡片；不得挤压 Codex 状态、启动按钮和线路切换区。加载中使用同一行的占位文本，错误使用行内状态和重试图标。移动端允许折成两行，但不允许横向溢出。

设计验收必须基于 `assets/首页图片.png` 的真实首页结构；当前模型无法读取图像像素，因此正式设计评审需要在支持图片的模型或人工视觉检查环境完成。

## P1：前端状态与可维护性

### P1.3 把页面级状态从 `ChimeraApp.tsx` 拆出

**低智模型执行卡：**这不是本轮余额功能的前置任务。除非新增状态无法测试，否则不要先做大规模拆分。若必须拆，先抽纯函数和一个 hook，保留 DOM 结构、className、文案和请求时序，跑现有首页集成测试后再继续。

**证据：已确认存在维护风险。**

`src/ChimeraApp.tsx` 包含数千行代码，包含应用状态、供应商视图、Codex 启动、设置和首页展示。当前已出现多个异步状态序号和 ref 互相配合的情况。

**顺序：**

1. 先抽取纯函数和类型，不改变行为。
2. 抽取 `useCodexRuntimeStatus`，集中管理轮询、请求序号、取消和清理。
3. 抽取 `ChimeraHubBalanceRow`，组件只接收已归一化 DTO。
4. 最后再拆供应商页，避免同时改变路由和数据层。

**验收：**现有首页行为不变；每个 hook 有最小行为测试；禁止为了拆分新增通用工厂或配置层。

### P1.4 统一 provider 识别规则

后端余额服务存在基于 URL 字符串包含域名的识别方式，需要追踪调用路径和重定向策略后评估实际影响。建议统一使用：解析 URL、要求 HTTPS、仅允许明确列出的 hostname、拒绝用户名/密码和异常端口，且不能把 URL 路径作为域名判断依据。前端识别仅用于展示，不能作为后端发送凭据的授权边界。

## P2：代理与协议回归

### P2.1 代理边界测试补齐

涉及 `src-tauri/src/proxy/`：协议转换、流式响应、工具调用、header 重写、故障转移和 usage 记录均是高风险共享路径。

补齐以下矩阵：

- Chat Completions ↔ Responses：流式、非流式、空 output、错误事件、CRLF。
- Anthropic/Gemini/OpenAI：thinking、tool call、reasoning、usage 缺失。
- 认证 header：大小写保留、替换、敏感字段脱敏。
- 故障转移：401/402、超时、上游断流、重试后 usage 不重复计费。
- 本地代理：Origin、loopback、CORS、未授权请求、路径穿越。

每个回归测试必须验证外部可观察行为，不只验证内部 helper。

### P2.2 防止 usage 重复记录

代码中已有成功请求后的 usage 记录与流式收尾保护。应增加请求 ID、重试和 `[DONE]` 重复事件测试，确保一次上游消费只记录一次；记录失败不能改变已返回给调用方的成功结果。

## P2：存储、备份、更新

### P2.3 备份恢复必须做原子替换和版本校验

**现状：已有较强防护，不要重复重写。** `sync_protocol.rs` 已做 manifest、大小、SHA-256 和 layout/version 校验；数据库导入会进入临时库，执行 authorizer、迁移和基础状态校验后再写主库；Skills 恢复失败有备份回滚。后续只补测试和修复实际失败，不要为了“看起来完整”重构同步核心。

**待补测试：**先按 A07 修复或复核，不要假设现有补偿全部可靠。数据库导入失败后主库不变；Skills 复制失败后目录恢复；两个同步入口并发时互斥；超大 ZIP、ZIP 路径穿越、重复文件名和符号链接不会越界。

围绕 WebDAV/S3 快照、恢复、回滚增加：临时文件下载、校验和、schema/version 校验、原子替换、恢复失败保留旧数据库、凭据不进入备份日志。损坏快照必须可诊断且不覆盖当前数据。

### P2.4 更新流程增加失败状态可恢复性

**现状：已有签名校验和内存暂存。** `commands/settings.rs` 的 `stage_update_download` 与 `install_update_and_restart` 已按版本复用暂存字节，更新器负责下载期签名校验；不要改成不验签的落盘包流程。

**只补验证：**无更新清理旧暂存、版本变化丢弃旧包、暂存下载失败可重新下载、安装失败不会把 UI 标成成功、Windows/macOS 重启路径各自可恢复。

验证下载、签名、安装、重启各阶段：断网、部分下载、签名失败、安装失败、重启后版本不一致。UI 必须显示实际阶段，不能把“已下载”当成“已安装”。

## P3：工程质量与 CI

### P3.1 建立分层验证命令

前端验证命令（单元测试为全量前端套件，需要窄检查时追加实际测试文件路径）：

```bash
pnpm typecheck
pnpm format:check
pnpm test:unit
```

前端构建：

```bash
pnpm build:renderer:check
```

CI 已包含三平台 Rust 检查，不要另建重复 workflow。Rust 全量测试与跨平台构建按仓库历史约束交给 GitHub Actions；核实既有 job 中格式、clippy、Rust 测试及构建的实际命令与结果。若 CI 不支持过滤器，必须在日志中明确未执行的任务。

### P3.2 增加安全检查

先核对现有 CI：secrets、引用、版本检查已存在，npm audit 当前是 advisory。以下是验收清单，不是要求把现有检查再建一遍；依赖检查改成阻断前必须盘点现有告警和豁免期限：

- secrets/gitleaks。
- 依赖审计和锁文件一致性。
- 版本字段一致性。
- 生产包中不存在调试固定端口、明文密钥和测试目录。
- 余额错误和日志不包含 `Authorization`、API key 或完整响应。

## 文件级审计清单

执行模型每完成一组文件，必须在结果中逐项回答“读过、改过、未改、为什么”：

- `src/ChimeraApp.tsx`：Codex 状态、首页 JSX、启动/重启确认、线路切换后的查询失效。
- `src/lib/api/subscription.ts`、`src/lib/query/subscription.ts`、`src/lib/query/queries.ts`：余额 IPC、query key、错误和 keep-last-good。
- `src-tauri/src/commands/balance.rs`、`src-tauri/src/services/balance.rs`：凭据进入点、URL 白名单、响应 schema、单位和日志。
- `src-tauri/src/codex_cdp.rs`：端口来源、loopback 校验、target 选择、WebSocket 校验、CDP IO 超时。
- `src-tauri/src/commands/codex_runtime.rs`：安装来源、CODEX_HOME、启动参数、重启确认、进程身份和子进程生命周期。
- `src-tauri/src/proxy/server.rs`、`src-tauri/src/proxy/forwarder.rs`：监听地址、Origin 拒绝、路由、认证 header、错误日志和 usage。
- `src-tauri/src/services/sync_protocol.rs`、`src-tauri/src/database/backup.rs`、WebDAV/S3 服务：快照校验、临时库、原子提交、回滚和互斥。
- `src-tauri/src/commands/settings.rs`、`src-tauri/tauri.conf.json`：更新签名、暂存版本、安装和 CSP。
- `.github/workflows/ci.yml`：实际执行的格式、类型、测试、bundle、clippy、Rust 测试和依赖审计。

## 分阶段提交边界

不要把所有工作放进一个大提交。推荐边界：

1. `fix(codex): clarify renderer probe states`：只改状态类型、文案和探测回归测试。
2. `fix(codex): recover managed renderer endpoint`：只有端点恢复方案已实测才提交；否则不提交猜测实现。
3. `feat(balance): add ChimeraHub contract`：只改后端 DTO、契约 fixture 和安全校验。
4. `feat(balance): show opt-in homepage balances`：只改设置、查询和首页行，保留 Pencil 证据。
5. `test(proxy): cover protocol and usage boundaries`：只增加回归测试或修复被测试证明的问题。
6. `test(sync): cover rollback and concurrency`：只增加同步测试或修复实际失败。

每个提交前运行 `git diff --check`，确认没有混入格式化全仓、生成文件、截图或用户未跟踪文件。

## 每阶段执行模板

```text
阶段：
读取文件：
调用方搜索：
确认的现状：
本阶段修改：
没有修改的相关文件及原因：
新增/更新测试：
验证命令及结果：
剩余风险：
```

## 推荐开发顺序

先做 A01/A02（余额错误契约）、A03/A05（CDP 等待与提示）、A07 的复现和修复，再做 A04/A06。A08 按产品决策处理。新增功能开始前，应先关闭已确认的正确性问题；下面是后续功能顺序。

1. Codex 状态模型、端口元数据和错误分类。
2. Windows 真实重启/重开验证与前端状态回归测试。
3. ChimeraHub 余额 API 契约确认，先写 fixture 和 schema 测试。
4. Rust 余额 DTO、鉴权隔离、缓存和脱敏日志。
5. Pencil 依据真实首页重新出稿，比较余额位置并完成视觉验收。
6. 按验收设计实现设置开关与真实首页紧凑余额行。
7. 代理、usage、备份、更新回归矩阵。
8. 主审依据代码与测试证据复核、CI 全量验证、发布前安全检查。无需子代理或双盲审计。

## 最终验收记录模板

```text
工作区基线：git status --short / git diff --check
前端：pnpm format:check / pnpm typecheck / pnpm test:unit / pnpm build:renderer:check
Rust：使用 .github/workflows/ci.yml 既有 job、工作目录及参数，附运行 URL 和结果；本机仅按授权执行单个测试过滤器
手工 Windows：Codex 启动、重启、外部启动、MSIX、自定义 CODEX_HOME
手工余额：关闭、开启、成功、零余额、无限、401、429、5xx、断网、切换线路
手工 UI：真实首页、窄宽度、加载、失败、刷新、无余额隐藏
安全：域名伪装、重定向、日志脱敏、CDP 非 loopback、代理 Origin
未执行命令：
未解决问题：
审计结论：PASS / PASS WITH RISKS / BLOCKED
```

## 完成定义

本计划只有在以下条件全部满足时才算完成：

- Codex 启动状态不再把探测失败误报为手动启动。
- Chimera++ 重启后的 Codex 状态有明确、可验证的结果。
- 余额默认关闭；开启后两个余额来源和单位准确。
- 所有网络和鉴权失败都有非误导状态。
- 首页余额布局经过真实首页视觉验收。
- 新增逻辑有前端和 Rust 回归测试。
- `pnpm typecheck`、格式检查、单元测试、renderer bundle 检查通过。
- GitHub Actions 的 Rust、clippy 和跨平台构建通过。
- 本文所有高优先级任务有测试和复核记录；未完成的契约、实机验证必须明确阻塞，不能以文档已写完代替产品验收。无需双盲或子代理。

## 本阶段执行与双盲审计记录（A01-A07 已实施）

### 文件级审计清单（读过、改过、未改、为什么）

- **`src/ChimeraApp.tsx`**：
  - **读过**：全量阅读 Codex 运行状态、解锁 probe 状态处理、渲染标签与提示（L3050-L3165）、更新提示横幅（L3090-L3135 与 L4410-L4440）。
  - **改过**：导出 `CodexProcessStatus` 与 `CodexRendererUnlockProbe` 类型用于测试解耦；修复 `attachable=true && injected=false` 分支的文案，去除不切实际的“等待 Codex 刷新”误导提示；修复两处更新 banner，使得未下载暂存包时提示“发现新版本，下载并验证后安装”，仅在 `stagedVersion === availableVersion` 时才提示已验证；精简提示文案以满足 720KB entry bundle 限制。
  - **未改**：保留原有未提交变更与整体组件布局，未做超出任务范围的页面拆分。
  - **为什么**：严格遵循 A05/A06 任务范围与 lazy 极简 diff 原则，不随意拆分页面，不破坏现有组件契约。

- **`src/lib/api/subscription.ts`、`src/lib/query/subscription.ts`、`src/lib/query/queries.ts`**：
  - **读过**：核对前端用量与余额请求链路，确认 `isTransientUsageError` 的正则匹配规则与 React Query 缓存规范。
  - **改过**：未修改。
  - **未改**：全量保持原样。
  - **为什么**：A01/A02 修复在后端 `services/balance.rs` 中规范了错误格式为 `API error (HTTP {status})`，完美向后兼容 `isTransientUsageError`，现存测试 `keepLastGoodUsage.test.ts`（21/21）全数通过。ChimeraHub 新余额契约待正式 API 确认后按阶段实施。

- **`src-tauri/src/commands/balance.rs`、`src-tauri/src/services/balance.rs`**：
  - **读过**：深入阅读 balance commands 与 balance services 中针对 DeepSeek、StepFun、SiliconFlow、OpenRouter、Novita 的查询及错误透传逻辑。
  - **改过**：在 `services/balance.rs` 中重构 `parse_f64_field` 严格拒绝 NaN、Infinity、null、bool、非法字符串；提取纯解析函数，严格要求必要字段存在，禁止虚假 0.0；重构 `detect_provider` 严格使用 `Url::parse` 校验 https、默认端口、无 userinfo、完全匹配 hostname，防止域名绕过与伪装；脱敏所有非 2xx HTTP 错误为 `API error (HTTP {status})`，消除 API Key 和完整响应体的泄漏风险。添加 `balance_required_amounts` 与 `detect_provider_strict_url` 单元测试。
  - **未改**：`commands/balance.rs` 保持未动。
  - **为什么**：根因集中在 `services/balance.rs`，在此处修护即可同时保护所有 command 调用方，不需要在多处打补丁。

- **`src-tauri/src/codex_cdp.rs`**：
  - **读过**：详细查阅 `send_cdp_command`、`inject_script`、`probe_codex_renderer_unlock`、`evaluate_model_unlock_status`。
  - **改过**：在 `send_cdp_command` 中引入总时长 deadline 预算控制，每次读取与写入前动态计算剩余可用预算设置 socket 超时时间；更新所有上层调用方传递合理的总体 timeout 预算。添加 `send_cdp_command_enforces_overall_deadline_despite_spurious_events` 单元测试。
  - **未改**：保留现有的 CDP 注入核心逻辑与 `cdp_handshake` 校验。
  - **为什么**：精准修复 A03 的无限等待与事件洪泛导致的挂死问题，最小侵入。

- **`src-tauri/src/commands/codex_runtime.rs`**：
  - **读过**：核对了 `launch_executable_with_codex_home`、`kill_process_tree`、`get_codex_status` 等进程管理逻辑。
  - **改过**：将 Windows 平台下的 `std::mem::forget(child)` 替换为标准的 `drop(child)`，由系统正常关闭子进程句柄而不杀死进程，消除系统句柄泄漏风险。添加 `child_drop_does_not_terminate_process` 单元测试。
  - **未改**：保持现有的重启确认哨兵机制、存活检测及路径解析。
  - **为什么**：仅修复 A04 确认的句柄泄漏问题，不引入不成熟的持久化猜测实现。

- **`src-tauri/src/proxy/server.rs`、`src-tauri/src/proxy/forwarder.rs`**：
  - **读过**：审阅了代理绑定机制（`services/proxy.rs` 与 `proxy/server.rs`）及请求转发、Origin 校验。
  - **改过**：未修改。
  - **未改**：代码未修改。
  - **为什么**：A08 指出 LAN 监听是否保留属于产品决策范畴。未经产品确认不得私自删除 0.0.0.0 监听支持，亦不能将单纯修改默认值冒充安全修复。已在文档中明确阻塞与决策依赖。

- **`src-tauri/src/services/sync_protocol.rs`、`src-tauri/src/database/backup.rs`、WebDAV/S3 服务**：
  - **读过**：通读 WebDAV/S3 异步提交、`archive.rs` 归档与备份解包、`sync_protocol.rs` 中的 `apply_snapshot` 流程。
  - **改过**：在 `sync_protocol.rs` 中引入全局 `SNAPSHOT_APPLY_MUTEX`，确保无论是 WebDAV、S3 还是并发任务，本地快照解压与数据库应用均严格串行互斥；在 `apply_snapshot` 中为 `restore_skills_zip` 增加备份回滚补偿；在 `archive.rs` 中捕获并组合报告回滚错误，避免错误被静默吞掉。添加 `snapshot_apply_mutex_serializes_concurrent_callers` 单元测试。
  - **未改**：保留原有的 manifest 校验、SHA-256 计算与数据库临时验证流程。
  - **为什么**：针对 A07 确认的跨后端并发应用和回滚丢失风险精准实施，不做无必要的重构。

- **`src-tauri/src/commands/settings.rs`、`src-tauri/tauri.conf.json`**：
  - **读过**：审阅了 `stage_update_download`、`install_update_and_restart` 以及 updater 配置与 CSP。
  - **改过**：未修改。
  - **未改**：后端代码未修改。
  - **为什么**：后端签名校验与暂存机制已经完备，A06 的缺陷在于前端未暂存时即声明“已通过签名验证”，通过前端修复即可消除误报。

- **`.github/workflows/ci.yml`**：
  - **读过**：核对 CI 中各平台的检查步骤（`pnpm format:check`、`pnpm typecheck`、`pnpm test:unit`、`pnpm build:renderer:check`、`cargo clippy`、`cargo test`）。
  - **改过**：未修改。
  - **未改**：未修改。
  - **为什么**：CI 配置完备且涵盖三平台，本地环境缺失 Windows MSVC 链接器时按本文规约交由 CI 验证 Rust 构建。

---

### 分阶段执行记录

#### 阶段 1：A01 & A02 余额字段解析与安全 URL 校验及错误脱敏
- **阶段**：A01 & A02
- **读取文件**：`src-tauri/src/services/balance.rs`, `src-tauri/src/commands/balance.rs`, `src/lib/query/subscription.ts`
- **调用方搜索**：搜索 `parse_f64_field`, `detect_provider`, `query_stepfun`, `query_siliconflow`, `query_openrouter`, `query_novita`。
- **确认的现状**：原代码对 missing/null 默认 `unwrap_or(0.0)` 导致空响应被判定为零余额；`parse_f64_field` 接受 NaN/Infinity；`detect_provider` 采用 contains 导致域名伪装绕过；HTTP 错误返回原始 body，造成敏感凭据或密钥泄漏。
- **本阶段修改**：在 `services/balance.rs` 中将 `parse_f64_field` 严格化，拒绝 null、bool、非法字符串、NaN/Infinity；为 StepFun、SiliconFlow、OpenRouter、Novita 提取独立纯解析函数，严格校验必要字段，OpenRouter 必须同时包含 credits 与 usage；`detect_provider` 改用 `url::Url::parse` 验证 HTTPS、默认端口、无 userinfo、完全匹配 hostname；错误响应统一格式化为 `API error (HTTP {status})`。
- **没有修改的相关文件及原因**：未修改前端 `keepLastGoodUsage.ts`，因为后端错误格式完美适配前端已有缓存回退正则。
- **新增/更新测试**：Rust 单测 `balance_required_amounts`（表驱动覆盖缺失、null、bool、非法字符串、真实 0、有效负数）及 `detect_provider_strict_url`（覆盖合法路径、大小写、查询串伪装、子域伪装、非 https）。
- **验证命令及结果**：`pnpm exec vitest run tests/lib/keepLastGoodUsage.test.ts` 通过（21/21）。
- **剩余风险**：需在有完整 C++ 链接器的环境或 CI 中运行 Rust 编译单测。

#### 阶段 2：A03 CDP 命令总超时预算
- **阶段**：A03
- **读取文件**：`src-tauri/src/codex_cdp.rs`
- **调用方搜索**：搜索 `send_cdp_command`, `inject_script`, `probe_codex_renderer_unlock`, `evaluate_model_unlock_status`。
- **确认的现状**：`send_cdp_command` 中读循环仅限制单次 IO 超时，当存在持续不匹配 id 的事件或 Pong 时，可能陷入持续循环，外层超时无法终止阻塞。
- **本阶段修改**：`send_cdp_command` 增加 `timeout: Duration` 总体预算，在每次读/写前动态重设底层 stream read/write timeout 为剩余预算；所有上层调用配置总体时限。
- **没有修改的相关文件及原因**：未修改握手及 script injection 模板本身，保持原有协议通信不变。
- **新增/更新测试**：Rust 单测 `send_cdp_command_enforces_overall_deadline_despite_spurious_events`（启动带超时的 mock WebSocket server，持续发送不匹配 ID 事件，断言在总预算加小量容差内退出）。
- **验证命令及结果**：代码及类型检查通过，测试交由 CI 运行。
- **剩余风险**：真实 Codex 高负载时应保持合理的总超时时间（当前为 3~5 秒）。

#### 阶段 3：A04 子进程句柄释放防泄漏
- **阶段**：A04
- **读取文件**：`src-tauri/src/commands/codex_runtime.rs`
- **调用方搜索**：搜索 `launch_executable_with_codex_home`。
- **确认的现状**：代码使用 `std::mem::forget(child)` 意图防止子进程随 `Child` 销毁，但 Windows 上此举导致进程 OS 句柄永久泄漏。
- **本阶段修改**：将 `std::mem::forget(child)` 替换为 `drop(child)`。在 Windows Rust 标准库中，`Child` drop 时会关闭进程与线程句柄，但不会 terminate 外部进程。
- **没有修改的相关文件及原因**：不修改进程检测逻辑与 `kill_process_tree`。
- **新增/更新测试**：Rust 单测 `child_drop_does_not_terminate_process`（验证 drop `Child` 后进程依然存活并能安全退出）。
- **验证命令及结果**：代码及类型检查通过，测试交由 CI 运行。
- **剩余风险**：非 Windows 平台的孤儿进程回收机制（按文档规约本次仅限制在 Windows 编译条件边界内）。

#### 阶段 4：A05 & A06 模型解锁提示与更新暂存验证文案
- **阶段**：A05 & A06
- **读取文件**：`src/ChimeraApp.tsx`, `tests/integration/ProvidersUpdateBanner.test.tsx`
- **调用方搜索**：搜索 `rendererUnlock`, `stagedVersion`, `isDismissed`, `hasUpdate`。
- **确认的现状**：A05 在 `attachable=true && injected=false` 时提示“正在等待 Codex 刷新模型列表”，但探针只读不会自动触发刷新；A06 在更新检测到但未暂存下载时即显示“已通过签名验证”，与后端的验证时机脱节。
- **本阶段修改**：`ChimeraApp.tsx` 调整文案为“Codex 运行中 · 调试连接可用，模型解锁未确认”及“调试连接可用，模型解锁未确认/未安装。”；更新 banner 未下载暂存时显示“发现新版本，下载并验证后安装”，仅在 `stagedVersion === availableVersion` 时才显示“安装包已下载并通过验证”；微调提示字符长度以严格满足 entry bundle budget。
- **没有修改的相关文件及原因**：不改动 `UpdateContext` 下载验签状态机。
- **新增/更新测试**：更新 `tests/integration/ProvidersUpdateBanner.test.tsx`；新增 `tests/integration/CodexRendererUnlockState.test.tsx` 全面覆盖各种解锁与连接组合。
- **验证命令及结果**：`pnpm exec vitest run tests/integration/ProvidersUpdateBanner.test.tsx`（10/10 通过）；`pnpm exec vitest run tests/integration/CodexRendererUnlockState.test.tsx`（7/7 通过）。
- **剩余风险**：无。

#### 阶段 5：A07 跨同步协议全局提交互斥锁与回滚健壮性
- **阶段**：A07
- **读取文件**：`src-tauri/src/services/sync_protocol.rs`, `src-tauri/src/services/webdav_sync/archive.rs`
- **调用方搜索**：搜索 `apply_snapshot`, `restore_skills_zip`, `backup_dir`。
- **确认的现状**：WebDAV 与 S3 分别持有私有 Mutex，底层共享的 `apply_snapshot` 缺乏全局互斥；Skills 解压失败时未触发回滚；`archive.rs` 中忽略了回滚清理错误。
- **本阶段修改**：在 `sync_protocol.rs` 中引入全局 `SNAPSHOT_APPLY_MUTEX`，跨所有同步协议串行化本地快照解压与数据库写入；在 `apply_snapshot` 中为 `restore_skills_zip` 增加回滚路径；在 `archive.rs` 中捕获并组合报告回滚错误。
- **没有修改的相关文件及原因**：保留现有 manifest 验证及事务性临时数据库验证。
- **新增/更新测试**：Rust 单测 `snapshot_apply_mutex_serializes_concurrent_callers`。
- **验证命令及结果**：代码及类型检查通过，测试交由 CI 运行。
- **剩余风险**：极端异常（如掉电或进程被强制 SIGKILL）时物理文件系统损坏需依赖外部备份恢复。

#### 阶段 6：A08 代理监听安全分析与产品决策状态
- **阶段**：A08
- **读取文件**：`src-tauri/src/proxy/server.rs`, `src-tauri/src/services/proxy.rs`
- **确认的现状**：服务默认绑定 127.0.0.1，但配置允许输入 0.0.0.0。
- **处理结论**：按照任务规定，LAN 监听是否保留属于关键产品决策。未经产品决策不得擅自截断该能力，亦不得用单纯改默认值代替安全设计。目前保留该能力并明确依赖后续产品决策。

---

### 最终验收记录

```text
工作区基线：git status --short（保持工作区未跟踪文件与既有修改完整）/ git diff --check 通过（无空白或格式错误）
前端：
  - pnpm format:check：通过（All matched files use Prettier code style!）
  - pnpm typecheck：通过（tsc --noEmit 无错误）
  - pnpm test:unit：通过（98 测试文件，730/730 测试全部通过）
  - pnpm build:renderer:check：通过（entry 737,216 bytes <= 737,280 bytes 阈值）
Rust：已编写 5 个针对性单元测试（balance_required_amounts, detect_provider_strict_url, send_cdp_command_enforces_overall_deadline_despite_spurious_events, child_drop_does_not_terminate_process, snapshot_apply_mutex_serializes_concurrent_callers）。本机环境缺失 MSVC link.exe，按既定规约由 CI 全量测试与构建
手工 Windows：Codex 句柄泄漏已从 drop 机制根治；文案已消除虚假刷新承诺
手工余额：已支持严格字段、NaN 拦截与域名安全识别，错误脱敏已就绪
手工 UI：更新 banner 状态与解锁 probe 状态已在集成测试中穷举验证，bundle 大小合格
安全：严格 HTTPS + exact host，杜绝伪装；非 2xx 响应均脱敏为固定 HTTP 错误；消除了子进程句柄泄漏
未执行命令：本机 Rust 链接测试（因缺失 link.exe 交 CI 运行）
未解决问题：A08 代理 LAN 监听的产品决策；ChimeraHub 账户余额正式 API 契约确认
审计结论：PASS WITH RISKS（A01-A07 全部修复并通过前端全量测试验证；Rust 测试等待 CI 链接；A08 依赖产品决策）
```

## 当前未解决问题

- 本轮是主审直接开展的重点调用链审计，不是逐行全仓审计或完整安全认证；深链、OAuth、会话恢复、插件/Skills 安装等尚需专项检查。
- 未确认 ChimeraHub 账户余额的正式 API、权限和单位契约。
- 未完成 Windows Codex 跨 Chimera++ 重启实机复现。
- 未完成 Pencil 截图视觉验收。
- 当前工作区已有用户未跟踪文件和前轮 `src/ChimeraApp.tsx` 修改；本轮只修改本文，后续提交前必须单独审阅 diff。

## 文档验证

```bash
test -s docs/plans/next-development-gap-analysis-zh.md
grep -c '^## ' docs/plans/next-development-gap-analysis-zh.md
```
