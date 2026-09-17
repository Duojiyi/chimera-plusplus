# Chimera++ 查漏补缺清单（2026-09-16）

> 文档性质：**只读审计产出**。本轮未修改任何代码，未运行任何构建或测试。
> 基线：`0ee680a2`（= `origin/main` = 注解 tag `v2.7.2` 所指提交，2026-09-16；工作分支 `release/v2.7.0`）。
> 用途：作为下一个版本（v2.8 / v2.7.3 热修）的候选范围池。每条都带 `文件:行号` 与置信度，可直接进入实施排期。

---

## 0. 怎么用这份文档

1. **不要把本文当作"全部问题"的证明**。未列出不等于不存在；每域末尾都有"未覆盖范围"。
2. **置信度决定动作**：
   - ✅ **已逐行确认**——审计员读到实现并能指出触发路径；可直接进入实施。
   - ⚖️ **双盲交叉确认**——两个互不知情的审计域各自独立发现同一问题；优先级上浮一档。
   - ○ **推断待验证**——代码路径已确认，但效果依赖运行时行为/外部网关/特定平台；实施前必须先复现。
3. **优先级不等于紧急度**：P1 是"有真实触发路径的明确缺陷"，不是"正在爆炸"。第 8 节给出按用户影响排序的建议路线图。
4. 与既往文档的关系见第 7 节"对账"——其中包含 **3 条曾被记为已修、实际仍在或已回归**的项，这是本轮最需要先看的部分。

---

## 1. 基线与上游版本对照

### 1.1 本项目

| 项 | 值 |
| --- | --- |
| HEAD | `0ee680a2` `fix: lazy-load settings view to meet renderer bundle budget`（2026-09-16）——**注解 tag `v2.7.2` 正指向该提交**，即 HEAD 就是已发布的 v2.7.2 本身，不是发布后的补丁 |
| 版本 | 2.7.2（`package.json` / `src-tauri/Cargo.toml` / `tauri.conf.json` 三处一致） |
| 与 origin/main | 无差异（0 ahead / 0 behind） |
| 工作区 | `src/ChimeraApp.tsx` 6 行未提交格式改动；未跟踪目录 `codex-proto/`、`designs/`、`assets/首页图片.png`、`docs/plans/next-development-gap-analysis-zh.md` |
| 规模 | Rust 后端 `src-tauri/src` 约 17.5 万行（`proxy/` 6.1 万、`services/` 4.6 万、`commands/` 1.9 万）；前端 `src` 约 9.7 万行 |
| 测试 | Rust `#[test]`/`#[tokio::test]` 约 2,539 处；前端 vitest 90 个测试文件 |

### 1.2 三个参考上游 + Codex 本体

| 上游 | 我方基线 | 上游最新（2026-09-16 抓取） | 差距 | 结论 |
| --- | --- | --- | --- | --- |
| [Duojiyi/chimera-plusplus](https://github.com/Duojiyi/chimera-plusplus) | v3.20.2 | **v3.20.3**（09-11）+ 4 提交至 `06082e18`（09-15） | 33 提交 | 6 条建议合并，见 §4.1 |
| [BigPizzaV3/CodexPlusPlus](https://github.com/BigPizzaV3/CodexPlusPlus) | v1.2.56 | **v1.3.0**（09-10）+ 至 `14edc14`（09-15） | 133 提交 | 3 条同样中招 + 5 条缺失能力，见 §4.2 |
| [Wangnov/Codex-App-Manager](https://github.com/Wangnov/Codex-App-Manager) | pin `222de90c` | **v0.5.6 = `222de90c`**（即我方 pin） | 其后仅 9 条依赖 bump，`crates/` 零变化 | **已对齐，无需升级**，见 §4.3 |
| [openai/codex](https://github.com/openai/codex) | 自报 0.153.4 | 稳定 **rust-v0.154.0**；alpha 0.155.0-alpha.9 | — | 见 §4.4 |

> **引擎 pin 结论**：`codex-win-engine` / `codex-theme-engine` 固定的 `222de90c` 经核实**就是上游 v0.5.6 标签所指提交**，其后 9 条提交全部是 `package.json` / `Cargo.lock` 依赖 bump（`git diff 222de90c..HEAD --stat` 只动 5 个锁文件与清单）。**本周期无引擎升级动作**——这是与 09-09 计划（当时 pin 还是 `d29fda32`）相比已经完成的部分。

---

## 2. 审计方法

本轮派出 15 路互不知情的独立审计代理，按域切分，全部只读：

| 代理 | 域 | 状态 |
| --- | --- | --- |
| U1 | cc-switch 增量逐提交处置 | ✅ |
| U2 | CodexPlusPlus 增量处置 | ✅ |
| U4 | openai/codex 0.153.4→0.154.0 语义漂移 | ✅ |
| A1 | 代理协议转换正确性（三条桥字段级） | ✅ |
| A2 | 代理健壮性、对抗性输入、协议探测 | ✅ |
| B1 | Codex 配置与模型目录语义（对照 0.154 源码） | ✅ |
| B2 | 切换事务与"当前线路"五副本一致性 | ✅ |
| C1 | 运行时/安装/更新/回滚/CDP/皮肤 | ✅ |
| D1 | 数据层、云同步、用量、会话 | ✅（第一路中断，主审补写 + 第二路补充审计） |
| D2 | 并发、锁、异步桥接、资源生命周期 | ✅ |
| E1 | 前端正确性 + IPC 契约一致性 | ✅ |
| E2 | 前端 a11y / i18n / 死代码 / 产物预算 | ✅（第一路中断，主审补写 + 第二路完成对比度与焦点实测） |
| F1 | 安全（攻击面与凭据保护） | ✅ |
| G1 | CI / 发布 / 供应链 / 仓库卫生 / 文档一致性 | ✅（第一路中断，第二路完成；含 `release.yml` 逐段与 `gh api` 实查） |
| H1 | 测试质量与覆盖缺口 | ✅（第一路中断，主审补写 + 第二路完成精确统计） |

> **14 份代理报告已落盘**在 `D:\Desktop\_upstream_audit\reports\`，本文是它们加主审复核的汇总。过程中有 5 路代理因会话中断或平台错误未能一次走完（U4、D1、E2、G1、H1），其中 U4 收窄范围后由替补完成，D1/E2/G1/H1 由主审先直接读码补写、再派第二路独立补充审计——**这四个域因此是"主审 + 一路代理"两批互不知情的结果**，反而多了一层交叉。

**约束**（写进每个代理的 brief）：① 只读，不改仓库；② 严禁运行 `cargo build/test/clippy`、`pnpm build/test/typecheck`（沿用"本地不做群量构建、验证交给 CI"的既定边界）；③ **盲审**——不得阅读 `docs/plans/`、`docs/upstream/`、`CHANGELOG.md` 里的既往审计结论来"找答案"，一切以当前代码为准；④ 每条发现必须给 `文件:行号` + 触发路径 + 后果 + 置信度 + 一句话修法。

**主审复核**：以下条目由主审亲自读码逐行确认（在正文中标 ✅✅）：`save_settings` 合并保护、官方 OAuth 材料随同步导出、探测/转发 URL 分叉、熔断器名额释放、合成 message id 前缀、`multi_agent_version` 模板缺失、`approval_policy` 裸 `granular`、官方种子空配置、便携版更新守卫缺失、托盘子菜单锁、诊断强杀 Codex（含引擎 PowerShell 脚本）、工具输出图片留在 `role:tool`、评论文本与工具调用拆分、rollout 增长检测、顶层 `base_url` 回退。

---

## 3. 结论速览

- **无 P0**：本轮未发现"默认配置下、无用户误操作即毁损磁盘数据"或"零点击远程利用"的路径。
- **P1 跨域去重后 37 条**，集中在五个主题（见 §6.2）：单一真相源没覆盖边路、状态多副本互相回退、崩溃恢复三组件失配、确认框承担了它承担不了的安全责任、模型目录字段跟着 Codex 版本漂移。
- **一类此前从未被审到的问题：治理与归属仍停在上游**。`SECURITY.md` 把安全漏洞报告指向 `Duojiyi/chimera-plusplus`，`SUPPORT.md`、`CODEOWNERS`、issue 模板同理；三份多语言 README 是**未改造的上游整份文档**（首行标题就是 `# CC Switch`）；`CODEOWNERS` 还声称 `main` 启用了 Code Owners 审核，而实际上 `main` 无任何分支保护、`release` 环境的 `protection_rules` 为空。**安全报告收不到、签名门禁是装饰性的**——这批见 §5.11，修复成本极低但影响面大。
- **最该先看的一条**：**"诊断"按钮会强杀用户正在运行的 Codex**（C1-P1-1）。标准安装下它走引擎健康探测，该探测收集安装目录下**所有** Codex 进程（含点击前就在运行的）并循环强制终止；而界面文案写的是"只检查，不修改本机文件"，没有确认框，也不取操作锁。未完成的 agent 任务与未发送的输入直接丢失。这是本轮唯一一条"点一个自称无害的按钮就丢工作"的路径。
- **另外三条是回归或未竟**（既往记为已修、今天仍在）：
  1. **便携版更新守卫回归**——可达前端零处调用 `is_portable_mode`，后端也不检查；08-27 的修复挂在如今已不可达的 `AboutSection.tsx`（§7.1）。
  2. **探测 URL ≠ 转发 URL 回归**——v2.7.0 的核心不变量在原生协议 × 自定义前缀线路下被破坏，且等价性测试因两侧共用同一常量而结构上测不出（§7.2）。
  3. **保存设置回退当前线路**——08-27 修的是锁，`merge_settings_for_save` 的合并规则至今仍不保护 `current_provider_*`（§7.3）。
- **一条被推翻**：U2 依上游 issue 提出的"模板缺 `multi_agent_version` 会失去 spawn_agent"，经对照 0.154 源码**不成立**（详见 §4.2）。记录在案以免下次重复怀疑。

---

## 4. 上游增量合并清单

### 4.1 cc-switch（v3.20.2 → `06082e18`，33 提交）

处置统计：merge 6 · adapt 2 · deferred 4 · not-applicable 21 · parity 0。

> not-applicable 占多数的原因：Chimera++ 的可达 UI 只有 Codex 一条线（`ChimeraApp.tsx` 硬编码），Claude/Gemini/OpenClaw 等 Rust 模块与路由虽然存在但前端不可达，上游针对这些应用的 21 条修复没有落点。

| # | 上游提交 | 内容 | 我方现状 | 处置 | 置信度 |
| --- | --- | --- | --- | --- | --- |
| 1 | `45f9e819` + `45b9a952` | rollout 增长用持久化**字节游标**检测，跳过未变化的不完整尾部 | `services/session_usage_codex.rs:1008-1012` 只比 mtime，无 `last_byte_offset` 列 | **merge**（~120 行 + schema v17 迁移） | ✅✅ |
| 2 | `99f9dd2c` | 无 `model_provider` 时接管地址要写进 provider 表而非顶层 | `codex_config.rs:3037-3057` 回退写 Codex 根本不读的顶层 `base_url`/`wire_api` → 直连 401 | **merge**（~90 行） | ✅✅（频率 ○） |
| 3 | `5e0f3442` | 把相邻的评论文本与待发工具调用合并进同一条 assistant 消息 | `transform_codex_chat.rs:792-810` `flush_pending_tool_calls` 另起一条 `content:null` 的 assistant | **merge**（~75 行） | ✅✅ |
| 4 | `11317c62` | 关停/动态端口时按 app 保留各自设置 | `services/proxy.rs:597-610, 1695-1699` 旧接口把 claude 行的值写进 codex 行 | **merge**（~15 行） | ✅ |
| 5 | `7726c834` + `746e2288` | DeepSeek 目录支持识图；退役 V4 家族并入 V4.1 Flash 定价档 | `model_capabilities.rs:76-77` 把 v4-flash/v4-pro 列为纯文本 → 剥图；定价表缺 3 个 id → 按 0 计费 | **adapt**（~75 行，repair 守卫须按我方旧值写） | ✅ |
| 6 | `c6286e14` | grok-4.6 保留 reasoning effort，`xhigh` 原样透传 | `transform.rs:72-73` 未含 grok-4.6 | **merge**（2 行） | ✅ |
| 7 | `f49c7d68` | 智谱 OpenAI-Responses 形态的模型列表（`models[].slug`） | `services/model_fetch.rs:27-35, 116-124` 不解析该形状 | **merge**（~20 行） | ✅ |

**deferred（记录原因，不在本周期）**：
- `e0982799` Images API follow-up——我方从未合入基础端点接管，Codex ≥0.145 的 image_generation/alpha search 经代理是 404；补齐需 ~250 行基础实现，属功能项而非缺陷修复。
- `556bb2ca` npm dist-tags 专用端点——`get_tool_versions` 在可达 UI 无调用方。
- `dc0febe5` 输出 token/s——`UsageView` 不渲染请求日志表。
- `bd247a4a` 工具 description 为 null 时省略而非序列化——Claude 路径不可达；Codex 路径（`transform_codex_chat.rs:1258`）上游同样未修。

**上游 issue 观察（○ 待核实，我方疑似同源）**：#7425 流式中途错误被记为成功（我方 `forwarder.rs:3210-3211` 注释与上游逐字相同）；#7421/#7418 工具消息内图片导致 Chat 上游 400（= §5.1 P2-1，已独立确认）；#7400 孤立 `function_call_output` 无守卫。

### 4.2 CodexPlusPlus（v1.2.56 → `14edc14`，133 提交）

过滤：跳过广告/赞助/UI 排版/Grok/DreamSkin/Stepwise/VLM/CI 约 62 项（产品面不同，按既定政策不吸收注入与远控体系）；细读 37 项。

**同样中招（建议修，P0/P1 级）**

| # | 上游 | 现象 | 我方位置 | 置信度 |
| --- | --- | --- | --- | --- |
| 1 | `e957279` | Responses item id 前缀不合法 → `invalid_id_prefix` 会话永久报废 | `streaming_codex_chat.rs:371` 合成 `{response_id}_msg`（无 `msg_` 前缀）；入站归一化 `handlers.rs:1150/1444` 只覆盖**经代理**的请求，切回官方直连时历史直打 OpenAI | ✅✅ |
| 2 | `494b12a` | `model_catalog_json` 指向含未展开变量（`%userprofile%`）的路径 → Codex 26.901 整份配置拒载（os error 3） | `codex_config.rs:2029-2076` 对非我方生成的指针一律原样保留，无存在性/可展开性自检 | ✅ |
| 3 | ~~issue #2161 模型目录缺 `multi_agent_version`~~ | **已推翻，非缺陷** | 见下方"被推翻的条目" | ❌ |

> **被推翻的条目（保留记录以免下次重复怀疑）**：U2 依据上游 issue #2161 提出"模板缺 `multi_agent_version` 会让 Codex 26.903+ 失去 spawn_agent"，主审对照 rust-v0.154.0 源码**予以推翻**：该字段是 `Option<MultiAgentVersion>` 且带 `#[serde(default)]` 与宽松反序列化器（`protocol/src/openai_models.rs:492-497`、`:348-357`——未知值一律归 `None`，绝不拒载）；上游自己的 `models-manager/models.json` 对 `gpt-5.5`/`gpt-5.4`/`gpt-5.4-mini`/`gpt-5.2` **显式写 `null`**，只有 `gpt-6-astra`/`gpt-5.6-*`/daybreak 系写 `"v2"`/`"v1"`。因此我方 `gpt5_5_template.json` 不写该字段与上游 gpt-5.5 条目**精确一致**；`codex_deepseek_catalog_template.json:20,87` 的 `"v2"` 是逐字镜像 DeepSeek 官方目录。若将来希望第三方原生模型也具备多智能体能力，那是**能力增强**（P3 选项），不是缺陷修复。

**缺失能力（建议补）**：`51c5cc0` 删除会话时同步清理 Codex 侧边栏索引（我方留幽灵会话）；`a7dcee1` Chat 工具参数 `$ref` 兄弟键内联（我方仅强制 `type=object`）；`2edabfe` 递归删除前拒绝 CODEX_HOME 及其祖先目录的中央守卫；`531275a` 解锁脚本强制 default_model。

**已等价（parity，无需动作）**：`2a41afb` 从 AppxManifest 解析 Application Id（我方 `codex_runtime.rs:597-605` + 引擎 `sys.rs:1562` 已如此）；`be67b30`/`f4f9bae` 更新后重新解析包路径；`d95ebd8` skill 更新先备份再顶替（`skill.rs:3708`）；`95c3002` 历史回收先校验 live 路由；`6b84ae0` 切换时替换陈旧 catalog。

### 4.3 Codex-App-Manager

**无动作**。我方 pin `222de90c` 即上游 v0.5.6 最新提交，其后 9 条全是依赖 bump，`crates/codex-win-engine`、`crates/codex-theme-engine` 零变化。09-09 计划中的"引擎 pin 升级"任务已于 `4db2a9ae` 完成。

需继续保留的应用层 workaround（上游对应 issue 仍未合并）：百分号解码修复（`codex_runtime.rs:1044-1102`，上游 #260 open / #271 draft blocked）、便携根身份守卫、陈旧备份清扫、MSIX 冷启动等待。

### 4.4 openai/codex rust-v0.153.4 → rust-v0.154.0

**结论：无拒载级漂移**。`config.schema.json` 从 153.4 到 154.0 是纯增量 94 行、0 删除、0 类型变化，新增键全部与 Guardian V2、TUI、macOS 沙箱、app-server 生命周期有关，与模型目录无交集；`minimal_client_version` 门槛未变（最高仍 0.153.0，我方自报 0.153.4 满足）。**唯一真实缺口是 rollout 的 `.jsonl.zst` 压缩**（7 天阈值）我方读取端不认。逐条见 §5.13。

---

## 5. 缺陷清单（按域）

> 编号规则：`域-级别-序号`。位置一律给 `文件:行号`（基线 `0ee680a2`）。级别定义：**P1** = 有真实触发路径的明确缺陷；**P2** = 边界与健壮性；**P3** = 代码质量与轻微问题。带 ✅✅ 的条目经主审亲自读码复核。

### 5.1 代理协议转换正确性（A1 · 三条桥字段级）

审计范围：`proxy/` 约 2 万行非测试代码；三条桥 = 原生 Responses 透传 / Responses→Chat Completions / Responses→Anthropic Messages。

| ID | 级 | 现象 | 位置 | 修法 | 置信度 |
| --- | --- | --- | --- | --- | --- |
| A1-P1-1 | P1 | Chat 流式把 `"error": null` / `"error": {}` 占位字段当致命错误，直接发 `response.failed` 掐断正常回答；**非流式聚合器已容忍同一形状**，两边不一致 | `providers/streaming_codex_chat.rs:837`（`chunk.get("error").is_some()`）对照 `handlers.rs:2914-2939` | 判空：仅当 error 为非空对象/字符串才失败 | ✅✅ |
| A1-P1-2 | P1 | Chat 桥对被截断/非法 JSON 的 tool_call `arguments` 无防护，一律标 `completed` 并原样回放；Codex `function_call` 项无 `status` 字段可表达"不完整"，严格上游此后每轮 400 → **会话永久卡死** | `streaming_codex_chat.rs:596-700`、`transform_codex_chat.rs:1271-1293`、`json_canonical.rs:57-74`；Anthropic 桥已有 `__raw_arguments` 包装可对照 | 参照 Anthropic 桥降级包装，不原样回放 | ✅（频率 ○） |
| A1-P2-1 | P2 | 工具输出里的图片虽已转成 `image_url`，但仍留在 `role:"tool"` 消息内 —— OpenAI/DeepSeek 严格上游对 tool 消息含图片部件返回 400 | `transform_codex_chat.rs:641-666, 676-701`；测试 `:3074-3117` 把该形状钉死 | 图片挪入紧随其后的 user 消息，同步改测试 | ✅✅ |
| A1-P2-2 | P2 | Chat 自动回退成功后不看 `result2.codex_bridge`，硬走 Chat→Responses 转换；故障链上若由原生/Anthropic 线路成功，会被喂进 Chat 状态机 | `handlers.rs:1233-1286, 1518-1567`（对照主路径 `:1346`、`:1619` 已按 `codex_bridge` 分派） | 回退分支同样按 `codex_bridge` 分派 | ✅✅ |
| A1-P2-3 | P2 | Responses `text.format`（结构化输出 JSON Schema）与 `text.verbosity` 在两条桥上均被静默丢弃 | `transform_codex_chat.rs:260-347`、`transform_codex_anthropic.rs:225-436` | 映射到 Chat `response_format` / Anthropic 对应能力；无法映射时显式报错 | ✅ |
| A1-P2-4 | P2 | Anthropic 桥默认 `max_tokens = 8192`、thinking 预算钳到 4096，medium/high/xhigh 三档无差别 | `forwarder.rs:1592`、`transform_codex_anthropic.rs:291-357` | 按 effort 档位映射预算 | ✅（前提 ○） |
| A1-P2-5 | P2 | Anthropic 流式：无签名 thinking 块已发 `output_item.added` + delta，却在 close 时 `return Vec::new()` → **永不发 done**，客户端侧块悬空 | `streaming_codex_anthropic.rs:241-273, 419-437` | close 时无条件补发 done | ✅ |
| A1-P2-6 | P2 | 自动回退把 404 一律当"端点不支持 Responses"，`model_not_found` 也会把整条线路持久化为 `openai_chat` | `handlers.rs:869-884` | 404 需检查响应体协议性证据后再翻转 | ○ |
| A1-P2-7 | P2 | Chat 流式：`message` 形单事件"假流式"内容被丢弃但 `finish_reason` 被采纳 → 空 output 假成功 | `streaming_codex_chat.rs:125-183` | 采纳 `message.content` 后再结束 | ○ |
| A1-P2-8 | P2 | 入站 id 前缀归一化对所有 Codex 线路无条件执行，会改写非 OpenAI 原生网关自签的 id | `handlers.rs:1150, 1444` + `providers/codex_id_normalize.rs` | 仅对需要 OpenAI 契约的上游归一化 | ○ |
| A1-P2-9 | P2 | Codex 工具声明里的 `strict: false` 被原样复制进 Anthropic `tools[]`（Anthropic 无此字段） | `transform_codex_anthropic.rs:459-461` | 转换时剥离 | ○ |
| A1-P3 | P3 | 另 11 条：`content_filter`→`completed`（`transform_codex_chat.rs:1826`）；合成 message id 无 `msg_` 前缀（见 §6 交叉项）；`input_audio` 字段名与 Codex 的 `audio_url` 不符（`:1101`）；工具输出中的 `encrypted_content` 被当文本喂模型（`:661/696`）；`learn_codex_model_protocol` 用 `outbound_model` 作键与查表键不一致（`handlers.rs:1318-1327`）；gpt-5 经 Chat 应转 `max_completion_tokens`（`:289-295`）；usage 未读顶层 `cached_tokens`（`:1736-1815`）；原生透传无 usage 仍写全 0 行（`response_processor.rs:520-556`）；Codex 指纹头仅 Anthropic 桥剥离（`forwarder.rs:2136`）；默认注入 `cache_control`（`forwarder.rs:1614`）；`response_id` 逐 chunk 覆盖（无害） | 见 A1 报告 | 按需 | 混合 |

**正面**：`codex_bridge` 单点决策 + 主路径按桥分派；三桥 URL 同源；Anthropic 桥的工具配对、签名 thinking 信封往返、thinking 与 forced `tool_choice` 互斥、usage 与计价器扣减互逆均正确；Chat 桥 `include_usage`、system 合并、namespace/custom 工具往返、`reasoning_content` 历史恢复、`<think>` 流式拆分、截断判定正确；SSE 的 UTF-8/CRLF/多行 data 解析健壮；错误信封保留状态码。

### 5.2 代理健壮性与协议探测（A2）

| ID | 级 | 现象 | 位置 | 修法 | 置信度 |
| --- | --- | --- | --- | --- | --- |
| A2-P1-1 | **P1** | **探测 URL ≠ 转发 URL（Native × 自定义前缀 base）**：探测端用常量 `CodexUpstreamProtocol::endpoint()` = `/v1/responses`，转发端传入的是 `endpoint_with_query(&uri, "/responses")`；同一解析器在 `/api`、`/api/v3`、`/backend-api/codex` 等自定义前缀 base 上产出不同路径。**等价性测试两侧都调 `protocol.endpoint()`，结构上测不出** | `services/model_fetch.rs:1471-1478` + `proxy/codex_url.rs:40-46` 对照 `proxy/handlers.rs:1158`（`endpoint_with_query` 只是原样返回 `"/responses"` 加 query，见 `:648-653`）+ `proxy/forwarder.rs:1469-1494, 1504-1512`；测试 `model_fetch.rs:1860-1869` | **先定哪边对**：`codex_url.rs` 自身的测试把 `{base}/v1/responses` 断言为自定义前缀下的期望值，即**转发端才是偏离的一方**；但改转发端会改变存量用户的实际请求地址，需配实机验证与 CHANGELOG 说明。落地方式建议在 `codex_upstream_url` 内部对 `Native` 做端点归一化，让两侧传什么都得到同一结果；等价性测试改由"转发端真实 endpoint 串"驱动 | ✅✅ |
| A2-P1-2 | **P1** ⚖️ | 熔断器 HalfOpen 探测名额**无 RAII 守卫**：`forward().await` 期间客户端断连（future 被取消）即永久泄漏 → `is_available()` 仍为真但 `allow_request` 永远拒绝，该供应商在故障转移中被静默跳过直到重启 | `proxy/forwarder.rs:452-505`、`proxy/circuit_breaker.rs:97-102, 315-377`（`release_half_open_permit` 存在但靠手工调用） | 改 `impl Drop` 守卫；补 `tokio::select!` 取消场景测试 | ✅✅（D2-02 独立命中） |
| A2-P1-3 | P2↓ | 运行时自动探测只凭 2xx + 首包即持久化协议；流式首块为 `event: error` 的 SSE 会造成永久误判 | `handlers.rs:1332-1341, 1608-1617`；`prime_streaming_response`（`forwarder.rs:2652-2685`）只等首包不看内容 | 首包做协议形状/错误信封检查后再持久化 | ✅（主审复核后由 P1 降 P2：非流式已有 `validate_responses_success_response` 兜底） |
| A2-P1-4 | P2↓ | 上游已返 2xx 后的 body/首包超时被归类 Retryable → 同一非幂等 POST 重放到下一家（双计费、双执行）；推理模型首 chunk 超过 60s 并不罕见 | `forwarder.rs:2482-2511, 2652-2685` | 2xx 之后的超时不再切换供应商，直接向客户端报错 | ✅（定级为设计权衡） |
| A2-P2 | P2 | 12 条：raw 写入失败回退 hyper-util 重发 POST 可能重复执行（`hyper_client.rs:341-364`）；错误体与 2xx 校验体读取无超时（`forwarder.rs:2458-2460, 2523-2552`）；故障转移关闭时 hyper 非流式 body 无超时（`handler_context.rs:210-217`）；SSE 检视缓冲无上限（`response_processor.rs:749, 805-838`，对照 `forwarder.rs:2574` 有 256KB 上限）；流式转换器累加器无上限；reqwest 路径默认跟随 ≤10 次重定向且不剥 `x-api-key`/`chatgpt-account-id`（`http_client.rs:216-264`）；允许绑 0.0.0.0 无鉴权（同 §5.8 F1-P1-3）；懒探测无去重/冷却、任何错误（含 429）都触发（`handlers.rs:1297-1306`）；探测 Generated 分支产生完整计费生成仅记一条 warn（`model_fetch.rs:1127-1153`）；Anthropic 与 Chat 探测体完全相同 → catch-all 网关误判（`:1143-1151`）；任何非 Responses 形状的 400 都触发 Chat 重放并永久翻转（`handlers.rs:869-886`）；客户端/本地错误计入供应商熔断器（`forwarder.rs:2839-2841`） | 见 A2 报告 | 按需 | 混合 |
| A2-P3 | P3 | 10 条：回退重跑整链导致统计与熔断双计；学习键与查表键不一致；请求侧 hop-by-hop 头未剥离；raw 路径重复头丢值；CONNECT 状态行要求带尾空格；同步解压跑在 tokio worker；无并发/连接上限；客户端中断记为 200 零用量成功行；熔断错误率为终身累计；探测信号量 permit 跨重试 sleep 持有 | 见 A2 报告 | 按需 | 混合 |

**正面**：请求侧压缩闸门与大小上限齐备；UTF-8/SSE 解析无 panic；SSE 聚合有 BTreeMap 防 OOM 与截断容忍；响应侧 hop-by-hop 完整剥离；缓存按指纹绑定；DB compare-before-write；显式协议永远优先于探测；探测用真实模型 + 非法预算的非生成探针；pydantic 回显与 `unsupported_parameter` 的分类处理正确；失败诊断可达前端。

### 5.3 Codex 配置与模型目录语义（B1 · 对照 rust-v0.154.0 源码）

| ID | 级 | 现象 | 位置 | 修法 | 置信度 |
| --- | --- | --- | --- | --- | --- |
| B1-P1-1 | **P1** | `approval_policy` 允许列表把**裸字符串** `"granular"` 当合法；0.154 的 `AskForApproval::Granular(GranularApprovalConfig)` 是带数据变体，只接受表形态 `approval_policy = { granular = { … } }`。裸值 → **整份配置拒载**；更糟的是前端提示主动推荐"请改为 on-request 或 granular"，且启动自修复因值在允许列表内而不会修 | `codex_config.rs:263`；`src/chimeraUtils.ts:347-352, 380`；上游 `protocol/src/protocol.rs:982-1007` | 允许列表拆成"字符串三值 + 表形态 granular"；前端提示给出表形态示例 | ✅✅ |
| B1-P1-2 | P1 | 原生/Anthropic 档模板固定 `tool_mode = "code_mode_only"`。主审对照 0.154 源码逐行确认两点：① `requested_tool_mode` 用 `model_info.tool_mode.unwrap_or_else(…)` —— **目录声明优先于用户 `[features]`**；② `effective_tool_mode` 的"代码模式不可用则回退 `Direct`"条件写死为 `requested_tool_mode == ToolMode::CodeMode`，**`CodeModeOnly` 不在其中，永不回退**。于是第三方原生模型只能看到代码模式的 `exec`/`wait`，Node 运行时缺失时工具面照旧却无法执行。**而该字段的原始动机（抑制向严格网关发送 `{"type":"namespace"}` 工具）已经失效**：`search_tool_enabled = model_info.supports_search_tool && namespace_tools_enabled(...)`，我方原生模板本就写了 `supports_search_tool: false`，namespace 工具无论如何不会下发 | `resources/codex_native_responses_template.json:39`；`codex_config.rs:961-993`（剥离清单不含该键）；上游 `core/src/tools/mod.rs:68-90`、`spec_plan.rs:629-631, 245-251` | 改为 `"direct"` 或直接删除该键；若仍需兼容 0.147–0.150，按检测到的 Codex 版本分别生成 | 上游语义 ✅✅ / 对第三方模型的实际质量影响 ○（实机确认后可升 P0） |
| B1-P1-3 | P1 | 切到内置"OpenAI Official"种子把 live `config.toml` **写成空文件**：种子为 `{"auth":{},"config":""}`，用户手写的 `approval_policy`/`sandbox_mode`/`[features]`/`[tui]`/`[profiles]`/`notify` 等全部从 live 消失（数据留在上一条线路的回填行里，切回才恢复） | `database/dao/providers_seed.rs:57-66` → `services/provider/live.rs:1168-1191` → `codex_config.rs:2897-2928` → `:348-395` | 官方种子 config 为空时，以剥离路由键后的当前 live 文本为写入基线 | ✅✅ |
| B1-P2-1 | P2 | 顶层 `experimental_bearer_token` 兜底写入的是 0.154 根配置**不存在的键**（只有 `[model_providers.*]` 有）→ 保留官方登录模式下第三方密钥到不了 Codex；inline table 形态的 provider 表也未处理 | `codex_config.rs:2421-2446`（三处）、读取侧 `:2385-2399` | 无有效 provider 表时拒绝并提示；补 `as_inline_table_mut` 分支 | 上游 ✅ / 频率 ○ |
| B1-P2-2 | P2 | 0.154 已移除 Chat wire API（`wire_api = "chat"` → 整份拒载），我方仍把它当路由信号且可能原样写进 live；`strip_rejected_codex_settings` 不覆盖该键 | 识别 `proxy/providers/codex.rs:770-780`、`src/utils/providerConfigUtils.ts:775-778`；写入 `codex_config.rs:2947-2957`、`commands/provider.rs:634-650`、`services/proxy.rs:2244-2284` | 剥离函数把 `chat` 改写为 `responses`，路由判定交给 `apiFormat` 元数据 | 上游 ✅ / 可达性 ○ |
| B1-P2-3 | P2 | ProxyChat 档克隆 live `models_cache.json` 的 gpt-5.5 条目时未剥模型绑定字段：`tool_mode`、`multi_agent_version`、`use_responses_lite`、`auto_review_model_override`、`comp_hash`、`guardian`、`model_messages`（含 `{{ personality }}` 模板）等会被带进 glm/kimi/minimax 条目 | `codex_config.rs:1168-1177, 1924-1929, 931-947` | 克隆后按白名单只保留通用能力字段 | 代码 ✅ / 缓存取值 ○ |
| B1-P2-4 | P2 | `supports_parallel_tool_calls` / `supports_reasoning_summaries` 在 0.154 已不是 `ModelInfo` 字段 → 逐模型声明与"保守回退 false"形同虚设；应改用 `supports_reasoning_summary_parameter` | `codex_config.rs:1859-1900, 990-992, 1815-1817`；预设 `codexProviderPresets.ts:1338, 1543` | 改写为 0.154 语义字段；UI 上降级为"仅旧版本生效" | ✅ |
| B1-P2-5 | P2 | 0.154 要求每个非 bedrock `[model_providers.*]` 的 `name` 非空否则整份拒载；接管改写新建的表**只含 `base_url`/`wire_api`**，保存校验只查 TOML 语法 | `codex_config.rs:3037-3057`（经 `services/proxy.rs:3253-3278`）；`services/provider/mod.rs:3634-3671` | 新建表补 `name = <id>`；保存增加语义校验 | 上游 ✅ / 频率 ○ |
| B1-P2-6 | P2 | E-FlowCode 预设把 `model_context_window` / `model_auto_compact_token_limit` 写进 provider 表（这两个键只在根配置），且阈值 9,000,000 大于窗口 1,000,000（自动压缩永不触发） | `src/config/codexProviderPresets.ts:1698-1709` | 移到根并改为窗口的约 90% | ✅ |
| B1-P2-7 | P2 | `prepare_codex_official_auth` 无条件删 `OPENAI_API_KEY` 并强写 `auth_mode = "chatgpt"` → 用 API Key 登录官方的用户切官方后被清成未登录 | `codex_config.rs:617-659`（`:652-656`） | 任一侧为 apikey 模式且无 OAuth 材料时保留原值 | 代码 ✅ / 频率 ○ |
| B1-P3 | P3 | `supports_search_tool` 被误读为"支持托管 web_search"（上游是 tool-search 命名空间门控），注释与捆绑模板自相矛盾（`codex_config.rs:126-144, 2127-2139` 对照 `codex_deepseek_catalog_template.json` 两条目均 false）；推理档位推断与预设矛盾（`:824-843`）；默认模型四处不一致（`codexTemplates.ts:24` 为 `gpt-5.6-sol`、`codexProviderPresets.ts:63` 为 `gpt-5.5`、`UniversalProviderFormModal.tsx:151` 为 `gpt-4o`）；MCP 的 `tools`/`oauth`/`auth` 复合对象被静默丢弃（`mcp/codex.rs:544-565`）；保存不拦保留 provider id / `untrusted` / `wire_api=chat`；仅 `last_refresh` 也算登录材料 | 见 B1 报告 | 按需 | ✅ |

**正面**：模板必填字段与枚举全部合法；`base_instructions` 经 legacy 提升仍生效且三条路径都不会缺失；`web_search = "disabled"` 合法且对自定义供应商有效；相对 `model_catalog_json` 按配置目录解析正确；`untrusted` 剥离正确、`on-failure` 仍是合法别名；官方路由与统一会话桶键全部存在且 `name = "OpenAI"` 确实驱动 `is_openai()`；保留 id 列表与 0.154 一致；MCP 写入器键集合与传输约束同 `RawMcpServerConfig` 完全一致；前端统一强制 `wire_api = "responses"`。

### 5.4 切换事务与"当前线路"五副本一致性（B2）

"当前线路"在五处有副本：① SQLite `providers.is_current` ② `settings.json` 的 `current_provider_*` ③ `~/.codex/` 下的 config.toml/auth.json/目录文件 ④ 代理进程内 `current_providers` 与路由缓存 ⑤ 前端状态。

| ID | 级 | 现象 | 位置 | 修法 | 置信度 |
| --- | --- | --- | --- | --- | --- |
| B2-P1-1 | **P1** | 前端保存设置回传整份 settings，`merge_settings_for_save` 只保护 webdav/s3 密钥与 `local_migrations`，**不保护 `current_provider_*`** → 设置页打开期间托盘/故障转移/UI 切换的线路被回退；代理按 settings 走旧线路而 DB 与 UI 显示新线路 | `commands/settings.rs:13-58`（合并函数）、`:86-93`（已在 `mutate_settings` 写锁内，但合并规则本身缺字段）；前端 `views/NewSettingsView.tsx:56-70` 与 `ChimeraApp.tsx:2329-2338` 已做"保存前重读"缓解 | `current_provider_*` 一律从 `existing` 取，不接受前端回传 | ✅✅ |
| B2-P1-2 | **P1** | 切走官方 Codex 时 backfill 把 live `auth.json`（含 ChatGPT OAuth access/refresh/id token）写入官方供应商行；`providers` 表随 WebDAV/S3 同步 → **OAuth 令牌明文出境**；回切时的 refresh_token 轮换保护只覆盖"live 更新"一种情形 | `services/provider/mod.rs:2716-2750`、`live.rs:827-905`（`restore_live_settings_for_provider_backfill` 对 Codex 不剥 auth）、`database/backup.rs:84-91`（`providers` 不在 skip/preserve 列表） | 回填前剥离 OAuth 材料，或把官方行排除出同步 | 写入与导出 ✅✅ / 跨设备后果 ○ |
| B2-P2 | P2 | 7 条：非 Codex 族 `add` 以 ① 判定"无当前"绕过接管判定与锁（`mod.rs:2153-2160`）；`reapply_current_codex_official_live` 无锁重写 live（`mod.rs:58-107` 经 `commands/settings.rs:111`）；非 Codex 族编辑当前线路 DB 先写 live 后写且失败无补偿（`mod.rs:2337→2407`）；整行读改写的旁路写者覆盖代理探测结果（`mod.rs:3561-3577`、`dao/providers.rs:196-235`）；post-import sync 用全新 `AppState` 不共享锁与 ④（`commands/sync_support.rs:10-14`）；整库替换期间无写互斥且 `restore_db_backup` 完全没有 post-sync（`database/backup.rs:159-222`）；`delete` 与 `switch` 存在 TOCTOU 且 `set_current_provider` 对不存在 id 静默成功（`dao/providers.rs:290-310`） | 见 B2 报告 | 按需 | ✅/○ |
| B2-P3 | P3 | 8 条：托盘 Auto 与点击的切换顺序相反、失败留脏状态（`tray.rs:523-536`）；Codex 三文件写非原子且共享 catalog 文件名，崩溃留"旧 config + 新 catalog"且启动不修复；`import_default_config` 三步写无事务；② 已写 ① 未写被杀后无对齐；请求上下文用未校验的 ② 原值；`provider-switched` 事件**无前端监听**且非代理态无轮询 → ⑤ 长期陈旧（放大 P1-1）；编辑保存以缓存 meta 重建，丢弃运行期累积的 `codexModelApiFormats`（`ProviderForm.tsx:1441-1447`，与 §5.7 E1-07 同源）；`get_effective_current_provider` 在读路径（含代理每请求）做自愈写 | 见 B2 报告 | 按需 | ✅/○ |

**正面**：`mutate_settings` 单锁读改写；`atomic_write` 全覆盖；③→②→① 提交顺序加 `LiveSnapshot` 回滚；Codex 族 `profile_apply_lock → lifecycle_lock → switch_locks` 锁序全路径一致且有 `_with_app_lock_held` 变体；探测结果 compare-before-write；导入走临时库校验；`proxy_live_backup` 不参与同步；官方 OAuth 按 `last_refresh` 取新；接管占位 live 拒绝导入；编辑保存经 `...provider` 展开保留 `createdAt`/`sortIndex`/`icon`（08-27 的 P1-1 修复仍有效）。

### 5.5 Windows 运行时 / 安装 / CDP / 皮肤（C1）

| ID | 级 | 现象 | 位置 | 修法 | 置信度 |
| --- | --- | --- | --- | --- | --- |
| C1-P1-1 | **P1** | **"诊断"会强杀用户正在运行的 Codex**：标准版走引擎 `verify_msix_health()`（`keep_running = false`），其 PowerShell `Get-PackageProcesses` 按 InstallLocation 收集**包括探测前就在运行的用户进程**，`Stop-PackageProcesses` 循环 `Stop-Process -Force` 5 秒直到清空。而 UI 文案是"只检查，不修改本机文件"，**无确认框、不取操作锁** | `commands/codex_runtime.rs:1424-1436`（无 `acquire_operation_lock`）；`ChimeraApp.tsx:2575-2579`（文案）、`:2308-2311`（直调）；引擎 `sys.rs:1441-1443, 1535-1540, 1648-1649` | 诊断改用 `verify_msix_health_with_options(true)`，或检测到 Codex 运行时跳过激活探测；补操作锁与文案修正 | ✅✅（含引擎脚本逐行） |
| C1-P1-2 | P1 | 标准模式安装/更新会**静默回退为便携版**，其中一条分支还会 `Remove-AppxPackage` 掉用户原本正常的 MSIX（协议注册、开始菜单磁贴随之消失）；返回的 `actualMode` 与 `notes` 被前端整体丢弃，无条件提示"操作已完成" | `chimera-runtime/manager.rs:519-568`；`ChimeraApp.tsx:1704-1760`（`:1754` 无条件成功提示） | 前端消费 `actualMode`/`notes`；"健康探测失败即卸载 MSIX"改为二次确认 | ✅（探测超时条件 ○） |
| C1-P1-3 | P1 | 皮肤"应用/试穿"在 **MSIX 加自定义 CODEX_HOME** 下绕过门禁：带 CDP 参数走引擎激活器时**不设置 CODEX_HOME**，Codex 以默认 `~/.codex` 重启（表现为被登出、线路失效、会话历史消失），而主题原生设置却写进自定义目录 | `commands/skin_catalog.rs:298-309, 360-366`；`codex_runtime.rs:641-667`（`:658` MSIX 加 CDP 分支）；门禁 `renderer_unlock_available`（`:436-443`）存在但皮肤路径未复用 | 皮肤三个命令统一经同一门禁，MSIX 加自定义 home 时拒绝并提示 | ✅✅ |
| C1-P1-4 | P1 | MSIX 自定义 CODEX_HOME 依赖"PowerShell 进程环境被 shell 激活的打包应用继承"，该假设很可能不成立（AppX 激活服务代为建进程，环境块来自用户默认环境）；若不成立则主启动按钮也走错目录，且 UI 报"已启动"属成功误报 | `codex_runtime.rs:583-639`（`:610` 设 env、`:605` shell 激活）、`:460-461`（文案称受支持） | 实机验证；不继承则改用 AppExecutionAlias 或 `CreateProcess` 带环境启动，或明确不支持并在设置页阻止 | ○（需实机） |
| C1-P1-5 | P1 | 便携根一旦通过身份检查，目录内**任何非 Codex 用户文件**都会随更新或卸载被永久删除；确认框不显示目标绝对路径 | 门禁 `codex_runtime.rs:306-334`；引擎 `portable.rs:818-832`（整根改名）、`:949`（成功后 `remove_dir_all`）、`:1060-1063`（卸载）；`ChimeraApp.tsx:4409-4445` | 确认框显示将被替换或删除的绝对路径；对含额外顶层条目的根目录警告 | ✅（场景 b 为 ○） |
| C1-P2 | P2 | 10 条：`codex_config_dir` 无后端校验，相对路径使凭据落进安装目录并随更新被删（`settings.rs:1001-1017`）；**CDP 端口按进程 `OnceLock` 随机分配且不持久化** → Chimera++ 重启后探测必失败、UI 误报"未解锁"，且皮肤与模型解锁**互斥**（`codex_cdp.rs:23-45`、`skin_catalog.rs:130-134`）；CDP 端口全程开放且可从进程命令行读取；引擎离线 AppX 恢复会弹 UAC 提权但确认框未披露；**崩溃恢复链条断裂** —— `BeforeMoveOld` 无旧安装也写 `backup_path`、标准模式无观察者、根目录缺失时后端的恢复分支因 `canRollback=false` 从 UI 不可达（`codex_runtime.rs:1162-1195, 1595-1620`、`ChimeraApp.tsx:2397-2419, 2596`）；回滚与清理按硬编码前缀扫**父目录**不绑定根名（跨工具互删备份）；架构判定用编译期 `ARCH` 而非宿主检测；"修复"实为"装最新版"会静默升级锁定的历史版本；便携根守卫使损坏安装无法修复；注入脚本对 Codex 版本强假设并打全局 `JSON.parse` 补丁 | 见 C1 报告 | 按需 | ✅/○ |
| C1-P3 | P3 | 8 条：另一份非托管 Codex 在跑时把成功当失败；进程轮询每 4 秒起一次 PowerShell `Get-AppxPackage`；离线包"签名验证器出错"报成"签名未通过"；安装日志有界截断可能丢 in-flight 项且无跨进程锁；陈旧备份清扫在任何校验前执行；开机自启不校验注册表路径是否仍指向当前可执行文件；终端脚本落在临时目录且文件名可预测；`skin_id` 接受任意目录路径 | 见 C1 报告 | 按需 | ✅ |

**正面**：下载校验链完整（curl 强制 https、大小、SHA-256、Authenticode 三重校验，历史版本 URL 锁定到镜像仓库前缀、tag 字符集白名单）；进程关闭按组件边界匹配加 `QueryFullProcessImageNameW` 并排除自身 PID，不会误杀 ChatGPT 桌面版；便携根校验严格（绝对路径、无 `..`、非系统或家目录、各级父目录不可为 reparse point）；安装前身份门禁有效阻断"把任意目录当旧安装删除"；所有变更命令取同一跨进程 advisory lock 且需 `confirm: true`；CDP 客户端仅 loopback 加端口与路径校验、512KB 与 3 秒上限；崩溃日志用 `atomic_write` 且启动阶段绝不动安装目录；OPC 百分号解码拒绝分隔符、盘符与数据流名；皮肤包导入有路径穿越、条目数、解压大小三重限制。

### 5.6 并发、锁与异步桥接（D2）

| ID | 级 | 现象 | 位置 | 修法 | 置信度 |
| --- | --- | --- | --- | --- | --- |
| D2-01 | **P1** | **托盘子菜单锁与主线程事件循环双向死锁 → 整个应用冻结（含退出）**：`update_tray_usage_labels` 持 `TRAY_SECTION_SUBMENUS`（std Mutex）时调 `Submenu::set_text`（tauri 内部阻塞等主线程），而主线程经托盘菜单重建在 `tray.rs:854` 等同一把锁 | `tray.rs:43`（静态锁）、`:854`（主线程写）、`:864-891`（持锁调 `set_text`）、`:1004`（调用点） | 先克隆句柄再释放锁，把 `set_text` 移出临界区 | ✅✅ |
| D2-02 | **P1** ⚖️ | 同 A2-P1-2（熔断器名额泄漏），两路独立发现 | `forwarder.rs:452-505`、`circuit_breaker.rs:315-377` | RAII 守卫 | ✅✅ |
| D2-03 | P2 | tokio worker 上用 `futures::executor::block_on` 等 tokio 切换锁**残留两处**（同一饥饿模型已在 `commands/provider.rs:143-152` 被承认并修过） | `commands/settings.rs:111` 到 `provider/mod.rs:83`；`commands/config.rs:348` 到 `mod.rs:2984` 与 `live.rs:1396` | 包 `spawn_blocking` 或改 async | ✅ |
| D2-04 | P2 | 单 SQLite 连接（std Mutex）被全库备份、快照、导入、30 天 DELETE **秒级持有**，代理热路径 worker 与 92 个非 async 命令（主线程）一起被 park；`periodic_backup_if_needed` 还直接跑在 worker 上 | `database/mod.rs:81`、`backup.rs:398/224/207/714`、`usage_rollup.rs:62-177`、`lib.rs:1433/1447` | 备份改 `VACUUM INTO` 或分片 step；维护任务 `spawn_blocking`；WAL 加独立读连接列入长期 | ✅ |
| D2-05..07 | P2 | 用量脚本 QuickJS 求值（每次最多 10 秒，两次）内联在 async fn，托盘并发刷新可占满 worker 池（`usage_script.rs:70-200`）；`ProxyServer::stop` 只停 accept loop，keep-alive 连接未追踪 → "停止代理"后旧连接继续转发并记账（`proxy/server.rs:159-231`）；启动期 config.toml 有两个无互斥的读改写者（自修复与接管恢复，`lib.rs:962-970` 对 `:1430`） | 见 D2 报告 | 按需 | ✅/○ |
| D2-08..16 | P3 | 9 条：抑制期的无关 DB 变更不补发同步信号；主线程 `block_on(is_running())` 与写锁竞争致 UI 卡顿最多 5 秒；`Database.conn` 毒化后永久失败（不 `into_inner`）；`http_client` 锁毒化时静默回退直连**绕过全局上游代理**；多处秒级同步 IO 在 worker 上；accept loop 无连接上限与首部读超时；`Database::init` 在主线程做 VACUUM 与 rollup（大库启动白屏）；退出清理依赖 runtime 存活且无看门狗；92 个非 async 命令在主线程做文件与 DB IO | 见 D2 报告 | 按需 | ✅ |

**正面**：`profile → lifecycle → per-app` 锁序全路径一致；`SwitchLockManager` 读到写升级正确；DAO 的 async fn 不跨 await 持 std 守卫；SQLite update hook 到 `try_send` 全程非阻塞且容量减一的通道不丢脏信号；`ActiveConnectionGuard` 为 RAII；`OperationLock` 是 OS 独占文件锁（进程死亡自动释放）；`process_utils`、`codex_cdp`、`usage_script` 均有超时与上限；故障转移 `try_switch` 已 spawn 解耦；退出与重启路径顺序正确并规避了 window-state 插件死锁。

### 5.7 前端正确性与 IPC 契约（E1）

**IPC 契约结论**：277 处 `invoke` 对 321 个 `#[tauri::command]` 与 322 条注册项，**命令名、参数键驼峰化、Option 与必填、返回字段全部匹配，0 处不一致**；50 个已注册命令在可达前端无调用方。

**可达性**：从 `src/main.tsx` 静态 import 闭包出发，可达 86 文件 / 22,786 行；其余 244 文件不可达（`components/providers/forms/*`、`config/*ProviderPresets.ts`、多数 hooks 与 views）。

| ID | 级 | 现象 | 位置 | 修法 | 置信度 |
| --- | --- | --- | --- | --- | --- |
| E1-01 | P1 | "保存并应用"**先激活线路、后写通用配置片段** → 本次写入 Codex 的 live 用的是旧片段，新片段要等下次切换才生效；若切换失败回滚，片段仍已被改写且编辑器已关闭 | `ChimeraApp.tsx:1363-1373`（`:1372` 才 `setCommonConfigSnippet`）；后端读取点 `services/provider/live.rs:674, 728, 922` | 把片段写入移到激活之前，失败则中止保存 | ✅ |
| E1-02 | P2 | 探测失败面板的"按 Chat / Responses / Anthropic 保存"按钮**只改下拉框、不保存**；`saveProvider(formatOverride)` 的 override 分支是死代码。用户以为已保存，关闭编辑器时点"放弃"会丢掉整份修改 | `ChimeraApp.tsx:3849-3851`；`:1095-1104` 对唯一调用点 `:1999` | 改为 `void saveProvider(format)` | ✅ |
| E1-03 | **P1** | **便携版无任何更新保护**：`settingsApi.isPortable()` 在可达代码中零调用，后端 `install_update_and_restart` 也无 portable 分支；三个更新入口都直接 `installUpdate()`。对照：不可达的旧 `AboutSection.tsx:463-475` 曾为 portable 用户改为打开发布页 | `ChimeraApp.tsx:581, 3204`、`views/NewSettingsView.tsx:96-105`、`lib/api/settings.ts:74`（零调用）、`commands/settings.rs:325` | 启动读 `is_portable_mode`，portable 改为打开发布页；后端同时拒绝 | ✅✅（主审升为 P1，理由见 §7.1） |
| E1-04 | P2 | 更新页"安装方式/更新源"的用户选择被 effect 无条件重置；`codexInstallMode` 与 `codexUpdateSource` 在可达前端**只写不读** → UI、设置页、持久化值三方不一致，随后按错误模式安装 | `ChimeraApp.tsx:2323-2328`（effect）、`:2521-2569`（写入） | effect 只在首次初始化；挂载时回读设置 | ✅ |
| E1-05 | P2 | 首页余额栏 `queryKey` 只含线路 id，不含 baseUrl 与 apiKey → 换 Key 后最多 60 秒显示旧 Key 余额；刷新按钮在 `enabled=false` 时仍发请求（v5 的 `refetch()` 不受 enabled 约束）→ 文案在"查询失败"与"暂无余额数据"间跳动 | `ChimeraApp.tsx:3033, 3027-3031, 3296` | queryKey 加入 baseUrl 与 apiKey 哈希；禁用态禁用刷新按钮 | ✅ |
| E1-06 | P2 | `useDialogFocus` 在 `enabled` 翻转时重跑焦点逻辑 → 每次进入或退出保存态、开关模型选择器、Esc 确认框关闭后，焦点都跳到表单首项或背景按钮；"返回焦点"语义失效 | `hooks/useDialogFocus.ts:34-82`；`ChimeraApp.tsx:3552-3555`、`:2003-2008` | 把启用判断移进 keydown 处理器（读 ref），effect 只依赖挂载生命周期 | ✅ |
| E1-07 | P2 | "获取模型"失败时清空 `apiFormatDetection`，**丢弃从线路元数据恢复的持久化探测结果** → 保存时被迫全量重探，可能被"无法自动识别协议"阻断 | `ChimeraApp.tsx:1604`；恢复逻辑 `:395-405` | 失败只清 `models` 与 `modelFetchError` | ✅ |
| E1-08..20 | P3 | 13 条：runtime 为 null 或未安装仍显示"已准备就绪"；"自动检查 已开启"硬编码；皮肤页四处问题（回退分支死代码、"已安装/已下载"语义相反、capabilities 失败误报"产品策略未启用"、`importLocal` 未捕获）；`codexRestartRequired` 仅自家重启才清零；映射行 model 为空静默丢弃；保存中输入被忽略但控件未禁用；"恢复模板"生成新 id 致 Esc 总弹确认；非 Windows 保存后仍弹"重新加载模型列表"；会话页目录跳转的定时器未清理；设置页"显示供应商余额"说明与实现不符；活动记录用英文枚举名；`DatabaseUpgrade` 两处 `void invoke` 无 catch；余额禁用态文案误导且"不支持"判定靠匹配后端英文文案；URL 前后端均无格式校验；启动静默连接检测仍弹成功提示 | 见 E1 报告 | 按需 | ✅ |

**正面**：序号守卫覆盖获取模型、探测、连接测试、运行时检查、进程轮询、解锁探测与用量；保存对象经 spread 透传全部元数据且后端 `ProviderMeta` 无丢键；TOML 写入全部转义；定时器、`listen`、rAF 与 Observer 成对清理；前端日志多层脱敏；"已下载并通过验证"文案与 updater 内置签名校验语义一致（v2.7.2 的修复有效）。

### 5.8 安全（F1）

**无 P0（零点击）**。三条 P1 均为"恶意网页加用户一次确认"即可达成，确认框只提示不拦截。

| ID | 级 | 现象 | 位置 | 修法 | 置信度 |
| --- | --- | --- | --- | --- | --- |
| F1-P1-1 | P1 | deeplink 内联 `config.env` 原样写入 `~/.claude/settings.json` → `NODE_OPTIONS` 与 `NODE_EXTRA_CA_CERTS` 等使下次 Claude 启动即远程代码执行或 TLS 中间人；前端仅标黄提示不拦截 | `deeplink/provider.rs:326-380`；提示表 `src/utils/deeplinkRisk.ts:1-33`（自述"只用于 UI 提示，不参与拦截决策"） | env 白名单（`ANTHROPIC_*` 等），命中危险名默认剔除加二次确认 | ✅ |
| F1-P1-2 | P1 | deeplink 导入的 MCP stdio `command` 与 `args` 无命令限制且**始终启用**，投影到 live 后宿主应用启动即执行任意命令 | `deeplink/mcp.rs:106-160`、`deeplink/validation.rs:70-83` | 导入的 MCP 默认禁用，命令需显式确认 | ✅ |
| F1-P1-3 | P1 ⚖️ | 本地代理无调用方鉴权令牌，`listen_address` 可设 `0.0.0.0`；Origin 检查只挡浏览器 → 局域网客户端可直接盗用用户的 AI 凭据（开放中继） | `proxy/server.rs:404-475`、`proxy/types.rs:7`；UI `components/proxy/ProxyPanel.tsx:150-154` | 非 loopback 强制 bearer token 或拒绝绑定 | ✅（A2-P2 独立命中） |
| F1-P2 | P2 | 4 条：终端启动的临时 JSON 明文写 API Key，Unix 下 0644 且文件名可预测（`commands/misc.rs:2827-2881`）；SSRF —— provider `base_url` 未拦内网与云元数据 IP 且全局客户端默认跟随 10 跳重定向（`deeplink/utils.rs:14-49`、`http_client.rs:216`）；CDP 端口运行期无鉴权，本机任意进程可接入读 token（`codex_runtime.rs:546-570`）；云同步信任边界 —— 恶意或被中间人的同步端可提供自洽 manifest 与 db.sql 注入 provider 端点或 MCP stdio 行，且 WebDAV 允许明文 http（`services/sync_protocol.rs:337-433`、`webdav.rs:49`） | 见 F1 报告 | 按需 | ✅ |
| F1-P3 | P3 | 7 条：`/status` 与 `/health` 无鉴权泄漏 provider 名与 last_error；CSP 的 `connect-src` 与 `img-src` 放行全网；WebDAV 与 S3 凭据明文存 settings.json；macOS 的 `RunEvent::Opened` 回传未脱敏的原始 deeplink URL；skill deeplink 默认启用，导入即下载任意 GitHub 仓库；`open_external` 仅在缺 scheme 时补 https，`file://` 与 `smb://` 透传给系统处理器；依赖卫生（glib 0.18.5、多版本 zip 与 tls 栈，○ 未联网核对公告） | 见 F1 报告 | 按需 | ✅/○ |

**正面**：代理的 Origin 拒绝有效挡住浏览器 CSRF 与 DNS rebinding；全链路 rustls 且无 `danger_accept_invalid`；脱敏体系完整；SQL 导入 authorizer 拦 `ATTACH`、`VACUUM INTO` 与虚拟表；skill 压缩包解包的路径穿越、软链与炸弹三重防护；MSIX 校验链（大小、SHA256、Authenticode、身份、架构）；用量脚本的 rquickjs 内存与超时沙箱且同源校验；发布链的 environment 门禁、SHA 固定 action 与 minisign 签名；OAuth token 权限 0600。

### 5.9 数据层 / 云同步 / 用量 / 会话（D1 域）

> **说明**：该域的第一路代理中断，由主审直接读码补写（D1-01…D1-08），随后第二路代理完成了补充审计（D1-09…D1-20）。两批互不知情，无重叠。

| ID | 级 | 现象 | 位置 | 修法 | 置信度 |
| --- | --- | --- | --- | --- | --- |
| D1-01 | **P1** | **压缩后的会话整份消失**：Codex 会把超过 `MIN_ROLLOUT_AGE` 的 rollout 压成 `.jsonl.zst`（0.154 上核实阈值为 **7 天**，且与是否被 fork 引用无关，见 §5.13 U4-4；更早版本的阈值未核实）。我方两处扫描器都只认 `jsonl`：用量侧 `collect_files_with_extensions(dir, &["jsonl"], …)` 与 `file_name.ends_with(".jsonl")`；会话列表侧按 `Path::extension() == "jsonl"`。结果是**超过 7 天的会话同时从用量统计和会话列表中消失** | `services/session_usage_codex.rs:209, 212, 634`；`session_manager/providers/codex.rs:591-625` | 两处读取端加 `.jsonl.zst` 分支并用 `zstd` 解压（已是现有依赖，`proxy/content_encoding.rs` 在用） | ✅✅ |
| D1-02 | P1 | **半行游标导致永久漏计**：`read_capped_line` 在 EOF 未遇换行时仍返回已读内容（`:104-107` 的 `saw_any_bytes` 分支），调用方 `:660` 无条件 `line_offset += 1`；下次扫描时 `:1137`/`:1142` 以 `line_offset <= last_offset` 跳过 —— 那一行补全后**永不再被解析** | `services/session_usage_codex.rs:58-107, 657-660, 1137-1142` | 只把以换行结尾的完整行计入可提交 offset（Claude 侧 `session_usage.rs` 同理） | ✅✅ |
| D1-03 | P1 | **进行中会话的用量滞后**：是否重新导入只比 mtime（`file_modified <= last_modified` 即跳过），不看文件大小/字节游标。Windows 上 Codex 持续追加写时 mtime 更新有延迟，活跃会话的新增用量可能长时间不被采集 | `services/session_usage_codex.rs:1002-1012` | 移植 cc-switch `45f9e819` 的持久化字节游标（§4.1 第 1 条，同一处修复） | ✅（Windows mtime 延迟幅度 ○） |
| D1-04 | P2 | **备份轮转会删掉用户自己留的备份**：`cleanup_db_backups` 按"扩展名为 `.db`"加 mtime 排序删除，不限自家 `db_backup_` 前缀；用户手工另存或重命名的 `.db` 一并进入淘汰池 | `database/backup.rs:413-444`（生成侧前缀在 `:388`） | 只轮转 `db_backup_` 前缀；导入/恢复的安全备份用独立前缀与独立配额 | ✅✅ |
| D1-05 | P2 | **设备本地状态随同步跨机**：`SYNC_PRESERVE_TABLES` 只含四张运行期表，**不含 `settings` 与 `session_log_sync`** → A 机的本机代理地址、游标等被同步覆盖到 B 机 | `database/backup.rs:84-99` | 加入 preserve 列表，或把设备本地字段迁到 `settings.json` | ✅✅ |
| D1-06 | P2 | **SQLite 无 WAL 与 `busy_timeout`**：单连接 + std Mutex，长事务（备份/VACUUM/rollup/导入）与代理热路径共用同一把锁 | `database/mod.rs`（无 `journal_mode`/`busy_timeout` 设置）；后果见 D2-04 | 备份改 `VACUUM INTO` 或分片 step，维护任务 `spawn_blocking`；WAL + 独立读连接列长期 | ✅✅ |
| D1-07 | P2 | 整库替换（导入/备份恢复）期间与并发写者无互斥；`restore_db_backup` 之后完全不做 post-sync，②/③ 停留旧值 | `database/backup.rs:159-222`；见 B2-P2 | 导入全程持同步锁；恢复后触发 post-sync | ✅（并发后果 ○） |
| D1-08 | P2 | post-import 同步跑在一次性 `AppState` 上，绕过真实锁与代理进程内状态 | `commands/sync_support.rs:10-14` | 接收真实 `State<AppState>` | ✅✅ |

**补充审计（第二路代理，D1-09…D1-20）**

| ID | 级 | 现象 | 位置 | 置信度 |
| --- | --- | --- | --- | --- |
| D1-09 | **P1** | **自动同步会把刚下载的数据反向推给另一个后端**：数据库变更钩子**无条件同时通知** WebDAV 与 S3 两个自动同步器，而两者各自持有**独立的**抑制计数静态变量。于是 WebDAV 下载期间只抑制了 WebDAV 侧——如果 S3 自动同步也开着，刚落库的（可能更旧的）快照会被自动推上 S3 | `database/mod.rs:84-94`（两行 `notify_db_changed`）；`services/webdav_auto_sync.rs:19` 与 `services/s3_auto_sync.rs:19` 各自的 `AUTO_SYNC_SUPPRESS_DEPTH` | ✅✅ |
| D1-10 | **P1** | **僵尸会话在应用内完全无法删除**：rollout 文件已丢失但 `session_index`/`threads` 仍有条目时，删除入口在路径校验阶段就以"session source not found"提前返回，后端根本走不到清理逻辑 | `session_manager/mod.rs:161, 188-193` | ✅✅ |
| D1-11 | P1 | 云同步的 `db.sql` 与 `skills.zip` **全程无条件写**，只有 `manifest.json` 带 If-Match → 两台设备并发上传会产生 manifest 与实际产物不一致的撕裂，且要到下载时才发现 | `services/webdav_sync.rs:100-136`、`services/s3_sync.rs:83-114` | ✅ |
| D1-12 | P1 | 远端三个键名固定、无版本历史，**覆盖即永久丢失**（没有可回溯的前一版快照） | 同上 | ✅ |
| D1-13 | P1 | 冲突提示建议用户"下载后合并"，但产品形态是**整库快照替换**，根本不存在合并功能——提示把用户引向一个不存在的操作 | 同步冲突 UI 文案 | ✅ |
| D1-14 | P2 ○ | S3 自定义端点（MinIO / R2 / OSS / COS 等）是否支持 If-Match 不确定（AWS S3 本身 2024-11 才支持），非 AWS 后端可能连 manifest 的乐观并发都没有 | `services/s3_sync.rs` | ○ |
| D1-15 | P1 | 用量去重指纹是"非消费型"的 EXISTS 匹配，可能一对多误伤合法请求；而 `usage_rollup` 的剪枝会把被误伤的行**永久删除、不可恢复** | `database/usage_rollup.rs` | ✅ |
| D1-16 | P2 | Codex 会话内部的"疑似重复"检测**只告警不拦截**，仍会插入并双计；前端只在破坏性的"重建"之后才展示计数，不影响总额 | `services/session_usage_codex.rs` | ✅ |
| D1-17 | P2 | Codex 侧边栏索引清理是 best-effort，`busy_timeout` 只有 2 秒；Codex 占用数据库时静默失败且不提示用户 | `session_manager/providers/codex.rs` | ✅ |
| D1-18 | P2 | `dump_sql` 跳过全部 `sqlite_*` 对象 → 从不导出 `sqlite_sequence`。`provider_endpoints` 与 `stream_check_logs` 两张 AUTOINCREMENT 表有真实删除路径，导出再导入后 ID 高水位会回退并被复用 | `database/backup.rs:497-500` | ✅ |
| D1-19 | P2 | 非 UTF-8 文本值会让整个导出/云同步**硬失败**，且错误信息不含表名/列名/rowid，无法定位 | `database/backup.rs` | ✅ |

**该域正面结论**：前后端"今日"边界的时区口径一致（均为本地时区）；实时代理落账的幂等与防覆盖设计扎实；下载侧先做双重校验再原子应用；SQL 转义、BLOB、NaN 处理正确；强制上传前会展示对端设备名与时间；大会话删除不受 32MB 门槛影响。

**未覆盖（该域）**：`proxy/usage/calculator.rs` 与 `parser.rs`；非 Codex 的 `session_usage_*.rs` 细节；非 AWS S3 后端的 If-Match 实测；`.codex-global-state.json` 一类文件是否真实存在（约束下未读本机真实 Codex 安装）；`>32MB` 会话加载的表现。

### 5.10 前端可访问性 / i18n / 死代码 / 产物预算（E2 域）

> **说明**：该域的专职代理在本轮未能返回完整报告。下表为主审用脚本与读码直接测得的结果。

**死代码与可达性**（主审用 import 图遍历独立计算，含 `lazy()` 动态导入）：

| 指标 | 值 |
| --- | --- |
| 可达 | 118 文件 / 42,798 行 |
| 不可达 | **253 文件 / 69,808 行** |
| 不可达占比 | **74.6% 文件 / 75.4% 行** |
| 最大的不可达文件 | `components/providers/forms/ProviderForm.tsx`（2,854 行）、`config/openclawProviderPresets.ts`（2,545）、`config/opencodeProviderPresets.ts`（2,092）、`components/settings/WebdavSyncSection.tsx`（1,930）、`config/codexProviderPresets.ts`（1,763）、`components/UsageScriptModal.tsx`（1,622）、`components/providers/forms/CodexFormFields.tsx`（1,615）、`components/settings/AboutSection.tsx`（1,284） |

> E1 代理独立算得"可达 86 文件 / 22,786 行"，与主审的 118 / 42,798 有出入（多半源于对类型导入与别名解析的处理差异）。**两者一致的结论是：约四分之三的前端代码不可达。** 其中 `AboutSection.tsx` 正是 §7.1 那条回归的载体，`codexProviderPresets.ts` 则解释了为什么 cc-switch 的 8 条预设提交对我方无落点。

**产物预算**（用现有 `dist/` 实测，未重新构建）：

| 项 | 实际 | 上限 | 占用 | 余量 |
| --- | --- | --- | --- | --- |
| entry | 734,518 B | 737,280 B | **99.63%** | **2,762 B** |
| startup 合计 | 1,360,264 B | 1,536,000 B | 88.56% | 175,736 B |
| css | 164,046 B | 204,800 B | 80.10% | 40,754 B |

最大 chunk：`index`（734,518）、`vendor-three`（734,334，懒加载的 3D 地球）、`vendor-charts`（364,155）、`SessionManagerPage`（256,410）。

> **结构性问题**：入口余量只剩 **2,762 字节（0.37%）**，意味着**任何**进入入口的新增代码都会让 CI 变红。最近一次提交 `0ee680a2` 正是"把设置视图改成懒加载以挤进预算"——预算已经在驱动架构决策。考虑到入口里还含着约 75% 的不可达代码所在的同一棵树，正确解法是清理死代码而不是继续拆懒加载点。

**i18n**：

| 观察 | 数据 |
| --- | --- |
| 四个 locale 的键集合 | `zh` / `zh-TW` / `en` / `ja` **各 2,654 个键，0 缺失** —— 相比 09-09 记录的"`en.json` 缺复数"已修复 |
| 主壳体 `ChimeraApp.tsx` | 311 处中文字符串字面量 + 92 处中文 JSX 文本，**`t()` 调用 0 次** |
| `views/NewSettingsView.tsx` | 38 + 12，`t()` **0** 次 |
| `views/AppearanceView.tsx` | 33 + 6，`t()` **0** 次 |
| `components/sessions/SessionManagerPage.tsx` | 60 处中文字符串，`t()` **80** 次 |
| 语言选择 | `src/i18n/index.ts:81` 用 `getInitialLanguage()` 跟随 `navigator.language` |

→ **后果**：在非中文系统上，会话页按系统语言渲染成英文/日文，而主壳体、设置页、外观页仍是硬编码中文 —— **同一窗口内中英混排**。翻译资源本身是齐的（2,654 键），缺的是主壳体的迁移。**最小修**：固定 `lng: "zh"` 消除混排；全量 `t()` 迁移单独立项。

**主题**：`src/main.tsx:106, 133` 传 `defaultTheme="system"`，`src/index.css:35` 定义了 shadcn 的 `.dark` 令牌，但主样式表 `src/chimera.css`（4,740 行）**0 处 `.dark`、0 处 `prefers-color-scheme`** → 系统深色模式下，Dialog/Card/Sonner 等组件变深色而应用外壳仍是浅色，**混合主题**。（`prefers-reduced-motion` 有 3 处，动效方面有基本支持。）**最小修**：`defaultTheme="light"` 并去掉 system 分支。

**产品归属**：`src/components/DatabaseUpgrade.tsx:17` 的 `RELEASES_URL` 仍指向上游 `https://github.com/Duojiyi/chimera-plusplus/releases`，而该组件**从 `main.tsx` 可达**——数据库升级提示会把用户引到上游仓库。

**对比度实测**（第二路代理用 WCAG 公式逐色计算，主审独立复现关键项）：

| 对象 | 前景/背景 | 实测 | 要求 | 位置 |
| --- | --- | --- | --- | --- |
| **主行动按钮"打开 Codex"** | 白字 on `#ff5a36` | **3.10:1** | 4.5:1 | `chimera.css:3946-3947`（`--p-orange: oklch(0.652 0.205 30)`，`:11`） |
| 其 hover 态 | 白字 on `#ed4d32` | 3.68:1 | 4.5:1 | `chimera.css:3955` |
| 全局 primary 按钮 | 白字 on `#f34e3b` | 3.52:1 | 4.5:1 | `chimera.css:70, 1536` |
| 主导航选中标签 | — | 3.27:1 | 4.5:1 | `chimera.css:1452` |
| "accent-on-soft" 选中态（11 条规则共用） | — | 3.18:1 | 4.5:1 | `chimera.css` |
| 三个焦点环 | 半透明 rgba 填充 | **1.26–2.32:1** | 3:1 | `chimera.css` |
| shadcn `primary-foreground` / `destructive-foreground` | — | 3.27–3.60:1 | 4.5:1 | `src/index.css`（被设置页、用量页、会话页使用） |

合计：`chimera.css` 内 **24 组同规则的前景/背景配对 + 20 个纯文本色**不达 4.5:1。

**焦点管理**：可达 UI 的 12 个对话框中 **9 个正确接入了 `useDialogFocus`**（`ChimeraApp.tsx:2930, 3552, 4359, 4418, 4461, 4497, 4531, 4570, 4620`）。缺口集中且干净——**运行时视图内的三个弹层全部没有接**：维护抽屉（`:2495`）、历史版本选择器（`:2653`）、离线安装确认（`:2776`）。其中两个还声明了 `role="dialog"` / `aria-modal="true"` 却没有任何焦点陷阱、Esc 处理或初始焦点，属于"无障碍语义与实现不符"。

**其它**：未发现仅靠颜色传达状态的活代码（唯一候选 `.provider-list-dot` 是死 CSS）；`chimera.css` 有 33 条规则使用 ≤10px 字号；两个响应式断点（760px / 1180px）在锁定的 1140×816 窗口下**永远不会触发**，属死规则。

**未覆盖（该域）**：图标库混用；动效在 `prefers-reduced-motion` 下的实际表现；屏幕阅读器实测。

### 5.11 CI / 发布 / 供应链 / 文档一致性（G1 域）

> **说明**：该域第一路代理中断，第二路完成了完整审计（含对 `release.yml` 1,300 行的逐段阅读与 `gh api` 实查）。以下 P1 密度是全文最高的。

| ID | 级 | 现象 | 位置 | 置信度 |
| --- | --- | --- | --- | --- |
| G1-01 | **P1** | **`release` 环境的保护规则是空的**：`protection_rules: []`、`deployment_branch_policy: null`（代理用 `gh api` 直查）。08-27 给各 job 补的 `environment: release` 因此**形同虚设**；`candidate.yml` 又没有"CI 必须先通过"的前置，等于可对任意 ref 签发生产签名 | GitHub 仓库设置（代码内无法自检） | ✅（`gh api` 实查） |
| G1-02 | **P1** | **`main` 无分支保护、无 ruleset**；而 `.github/CODEOWNERS` 的注释明写"Branch protection on `main` has 'Require review from Code Owners' enabled"——**声称的门禁并不存在**，且指定的 owner `@farion1231` 是上游维护者、非本仓库协作者 | `.github/CODEOWNERS:1-9`（文件首行就是 `# Code owners for cc-switch`） | ✅✅ |
| G1-03 | **P1** | **安全漏洞报告会被送到上游仓库**：`SECURITY.md:20,22` 把安全公告入口指向 `Duojiyi/chimera-plusplus/security/advisories/new`，`:56,58` 的发布通知也指向上游 Releases；`SUPPORT.md`、`ISSUE_TEMPLATE/config.yml`、`FUNDING.yml`、`CODEOWNERS` 同样指向上游。**本仓库维护者收不到安全报告** | `SECURITY.md:20, 22, 56, 58`；`SUPPORT.md:11-27, 42` | ✅✅ |
| G1-04 | **P1** | **三份多语言 README 是未改造的上游整份文档**：`README_ZH.md` / `README_JA.md` / `README_DE.md` 首行标题就是 `# CC Switch`，正文描述的是"Claude Code、Claude Desktop、Codex、Gemini CLI、Grok Build、OpenCode、OpenClaw 和 Hermes Agent 的全方位管理工具"，下载链接与赞助位全部指向上游。这不是"翻译陈旧"，是**根本没做本地化改造** | `README_ZH.md:3-5`、`README_JA.md:3`、`README_DE.md` | ✅✅ |
| G1-05 | **P1** | **Linux 从未进入发布门禁**：`release.yml` 的 `required_jobs` 只有 `Windows Frontend Validation`、`Backend Validation (windows-2022)`、`Backend Validation (macos-15)`——**没有 ubuntu**。但正式发布件里包含 deb / rpm / AppImage，即这三个产物的编译、测试与 clippy 从未被要求通过 | `.github/workflows/release.yml:76-86` | ✅✅ |
| G1-06 | **P1** | 便携版更新守卫缺失（详见 §7.1 与 E1-03） | `commands/settings.rs:325`、三个前端入口 | ✅✅ |
| G1-07 | **P1** | `src/components/DatabaseUpgrade.tsx:17, 271` 不只是文档问题——它**运行时真的会把用户跳转到上游 release 页**（该组件从 `main.tsx` 可达） | 同左 | ✅✅ |
| G1-08 | P1 | v2.7.2 的 CHANGELOG **漏记 4 项 Fixed 级改动**：CDP 超时防挂起、同步快照互斥锁、Skills 回滚硬化、Windows 子进程句柄泄漏 | `CHANGELOG.md` v2.7.2 节 | ✅ |
| G1-09 | P2 | `claude.yml` 未禁用 Bash；`pull_request_review_comment` / `pull_request_review` 触发会检出 fork 的 HEAD（`issue_comment` 因表达式回退到 main，风险较低） | `.github/workflows/claude.yml` | ✅ / fork 可达性 ○ |
| G1-10 | P2 | **依赖审计是 advisory 不阻断**：`pnpm audit --prod --audit-level=high` 与 `cargo audit` 均 `continue-on-error: true`（注释写明"until the signal proves stable"）。与 09-09 计划"warn-only 起步"一致，但至今未转必需。另：Dependabot 安全更新处于关闭状态 | `.github/workflows/ci.yml:61-65, 130-133` | ✅✅ |
| G1-11 | P2 | `scripts/verify-release-version.mjs` **不校验 CHANGELOG**（四处版本号一致性有校验，CHANGELOG 有无对应小节没有）；NSIS legacy 安装器与 MSI 更新通道潜在错配 | 同左 | ✅ / 错配 ○ |
| G1-12 | P2 | CHANGELOG 有 4 处措辞夸大，例如把纯测试改动写成"不再崩溃" | `CHANGELOG.md` | ✅ |
| G1-13 | P3 | `scripts/check-repo-references.mjs` 只检测旧名 `Duojiyi/chimera-codex`，**不检测 `Duojiyi/chimera-plusplus`** ——正因如此 G1-03/04 才能长期存活。另 `designs/chimera-user-guide.html:628` 含旧仓库名但该目录未跟踪，断言扫不到 | `scripts/check-repo-references.mjs:2, 14` | ✅✅ |
| G1-14 | P3 | `README.md` 自身缺 Linux 相关信息且落后代码一个版本；TerminalSettings 暴露了已失效的路径选项；陈旧分支与 tag 堆积 | 仓库根 | ✅ |
| G1-15 | P3 | 应用标识符仍是上游命名 `com.bigpizzav3.codexplusplus.manager`（影响数据目录、单实例标识与升级路径；**改动有迁移风险，不建议轻动**，仅记录） | `src-tauri/tauri.conf.json:5` | ✅ |

**该域正面结论（逐项核实）**：所有 `uses:` 均 SHA 固定；provenance 的 `externalGitDependencies` **从 `Cargo.lock` 动态提取**且与 `Cargo.toml` 的 rev 精确一致（09-09 计划里担心的"硬编码 rev 过时"已解决）；`latest.json` 的发布时序**无 404 窗口**（`make_latest` 最后才置位）；updater 签名验证是真实的 minisign 密码学校验；`windows-test.yml` 与 `macos-test.yml` 主动不接触签名密钥；`README.md` 的四项功能声明（15 分钟检查更新、后台预下载、会话恢复的平台差异、官方账户保护）经代码核实**全部准确**；引擎 rev 双侧一致，无双份依赖。

**CHANGELOG 2.7.x 对账**：12 条中 10 条有对应实现（其中 4 条措辞与实际有出入），1 条生产代码零改动，1 条门禁存在但清洁度未验证；**无一条完全没做**。

**未覆盖（该域）**：未运行任何 workflow；未实测 NSIS/MSI 的升级行为；未审计 Anthropic 侧 OIDC 配置；156 个 tag 未逐一分类。

### 5.12 测试质量与覆盖缺口（H1 域）

> **说明**：该域的专职代理在本轮未能返回完整报告。下表为主审直接核实项。

| ID | 级 | 现象 | 位置 | 置信度 |
| --- | --- | --- | --- | --- |
| H1-01 | **P1** | **`cargo test` 会写开发机真实的 Claude Desktop 配置（已端到端追踪确认）**：`tests/support.rs` 只设 `CC_SWITCH_TEST_HOME`，而 Windows 下 Claude Desktop 的路径解析读的是 `LOCALAPPDATA`。第二路代理把链路走通了——`tests/profile_roundtrip.rs` 的 `#[serial]` 测试会到达 `claude_desktop_config.rs` 的 Windows 路径解析，在 Windows CI 与开发机上**真的落到 `%LOCALAPPDATA%`**。同时核对了三处形似但实际安全的用法（`hermes_config.rs`、`services/provider/mod.rs`、`deeplink/provider.rs` 各自手工设置了隔离） | `src-tauri/tests/support.rs:16-17`；`claude_desktop_config.rs:1284-1292`；`src-tauri/tests/profile_roundtrip.rs` | ✅✅ |
| H1-02 | P2 | **等价性测试测不出它要守的不变量**：探测/转发 URL 一致性测试两侧都调 `protocol.endpoint()`（详见 §7.2） | `services/model_fetch.rs:1860-1869` | ✅✅ |
| H1-03 | P2 | **大量测试针对不可达组件（已精确统计）**：`tests/components/` + `tests/hooks/` 共 **53 个文件 / 352 个用例**，其中 **17–18 个文件 / 82–83 个用例测的是 100% 死代码**，25 个文件 / 184 个用例混合，**只有 8 个文件 / 81 个用例完全落在可达代码上**。这些测试绿色，但保护的是用户到不了的代码，同时给覆盖率制造假象 | `tests/components/`、`tests/hooks/` | ✅✅ |
| H1-05 | P2 | **"把源码当字符串读"的反模式**：3 个测试文件用 `fs.readFileSync(...)` 再 `toContain` / `indexOf` 断言源码文本，其中一个针对的还是死代码。这类测试不验证行为，只在重构改动措辞时制造假失败 | 见 E2-H1 报告 | ✅ |
| H1-06 | P2 | **`useDialogFocus` 零测试**——而 E1 已经在该 hook 里发现了确实的缺陷（E1-06）。全仓库**零快照测试**（这点是好事，避免了把错误行为钉死） | `src/hooks/useDialogFocus.ts` | ✅ |
| H1-07 | P3 | Rust 侧统计：共 **2,319 个 `#[test]`**，其中 **40 个只在 Windows 编译**（CI 确实跑 windows-2022，故有效），`#[ignore]` 仅 2 个 | `src-tauri/` | ✅ |
| H1-04 | ✅ 正面 | `tests/integration/machine-state.test.ts` **已在 v2.7.0 改为密封 fixture**，不再 shell 出 `python3`、不再读开发机 `~/.codex` 与真实数据库；文件头注释完整记录了"旧写法在 CI 上等于从未执行"的动机 | `tests/integration/machine-state.test.ts:1-16` | ✅✅ |

**高风险零/弱覆盖清单**（建议的最小回归矩阵）：代理三条桥的端到端事件序列（尤其混合目录：默认 Responses + 某模型 Chat）；线路切换的五副本一致性；便携安装中断后的恢复；CDP 探测各状态到 UI 文案的映射；deeplink 导入的拦截边界；云同步撕裂快照的自救；用量游标（半行 / 压缩 / 双 UUID）；便携版更新守卫。

**未覆盖（该域）**：2,539 处 Rust 测试的断言质量抽样、`#[cfg(windows)]` 门控导致的跨平台不编译统计、`#[ignore]` 清单、flaky 模式（sleep/端口硬编码）、msw handler 与真实 IPC 契约的漂移、CI 覆盖率收集。

### 5.13 openai/codex rust-v0.153.4 → rust-v0.154.0 漂移（U4）

方法：本地 blob-less 克隆 `openai/codex`，用 `git show <tag>:<path>` 精确取源（不用网页摘要，避免大文件失真）。

| # | 问题 | 结论 | 级 | 我方动作 |
| --- | --- | --- | --- | --- |
| U4-1 | `multi_agent_version` 缺失的后果 | **无后果**。`Option<MultiAgentVersion>` + `#[serde(default)]` + 宽松反序列化器（`protocol/src/openai_models.rs:492-497`、`:348-357`），缺失/null/未知值一律归 `None`，**绝不拒载**。上游自己对 `gpt-5.5`/`gpt-5.4`/`gpt-5.4-mini`/`gpt-5.2` 显式写 `null`，只有 `gpt-6-astra`/`gpt-5.6-*`/daybreak 写 `"v2"`/`"v1"` | P3 | **无需改动**（详见 §4.2 被推翻条目）。若要让第三方原生模型获得多智能体能力，属能力增强 |
| U4-2 | `config.schema.json` 键级 diff | **纯增量 94 行，0 删除、0 类型变化**。新增键集中在 Guardian V2（`guardian_v2.thread_context`）、`experimental_features` 四项、`allow_symlinked_codex_home`、`thread_unload_delay_secs`、TUI 键位；**与模型目录无交集** | P3 | 无需改动；`allow_symlinked_codex_home` 可留意（我方 `atomic_write` 拒写符号链接，与之无冲突） |
| U4-3 | 内置 slug 与默认模型 | 共 11 个内置 slug；`gpt-5.6-sol` 仍是 `visibility: "list"` 的**有效 slug**，153.4→154.0 该条目未变。未找到客户端硬编码的"默认模型"常量，疑似服务端下发 | P3 | `codexTemplates.ts:24` 用 `gpt-5.6-sol` 正确，无需改动（默认模型决策点 ○ 未坐实） |
| U4-4 | **rollout `.jsonl.zst` 压缩** | 阈值为**7 天**（`MIN_ROLLOUT_AGE`），**与 fork 引用无关**——`rollout_reference_index.rs` 文档明确写"不得用于压缩/删除判定"，`compression.rs` 全文零处调用该索引，且有单测证明 fork 源文件与子文件会一起被压缩。命名由 `.jsonl` 变为 `.jsonl.zst` | **P2** | **本轮唯一确认的真实兼容性缺口**：我方 `services/session_usage_codex.rs`（`ends_with(".jsonl")`）与 `session_manager/providers/codex.rs`（`Path::extension() == "jsonl"`）均精确匹配 → 压缩后的会话**整份从扫描结果消失**（用量与会话列表同时不可见）。`zstd` 已是现有依赖，读取端加分支即可 |
| U4-5 | `minimal_client_version` 门槛 | 153.4→154.0 的 `models.json` 只多 1 行（`gpt-6-astra` 加 `supports_experimental_context`），**无新模型、门槛未变**，当前最高仍是 `0.153.0` | P3 | 我方自报 `0.153.4` ≥ 0.153.0，内部引用一致，**无需上调** |

**旁证（主审复核时顺带确认）**：`supports_parallel_tool_calls` 与 `supports_reasoning_summaries` 确实**已不在** 0.154 的 `ModelInfo` 结构体中（该文件只有 `supports_reasoning_summary_parameter`，`:434`），但上游 `models.json` 仍在写 `supports_parallel_tool_calls: true` —— 说明它已是被忽略的遗留键。这**印证了 B1-P2-4**：我方逐模型声明该字段不会生效。

**未覆盖**：新会话默认模型的确切决策点；是否还存在第三条 rollout 读取入口；`codex-rs/config-schema` 等新 crate 的 schema 比对。

---

## 6. 交叉确认与主题聚合

### 6.1 双盲交叉命中（⚖️ 高可信）

两个互不知情的审计域独立发现同一问题，历史经验表明这类条目误报率最低：

| 问题 | 域 A | 域 B | 结论 |
| --- | --- | --- | --- |
| 熔断器 HalfOpen 探测名额无 RAII 守卫，取消时永久泄漏 | A2（代理健壮性）从"取消安全"角度 | D2（并发）从"资源生命周期"角度 | 定 P1，主审已复核 `circuit_breaker.rs` 无 `impl Drop` |
| 合成的 Responses item id 缺 `msg_` 前缀 | A1（转换正确性）标 P3"靠入站归一化兜底" | U2（上游）以 CodexPlusPlus `e957279` 实证为"会话永久报废" | 上浮为 P1：归一化只覆盖经代理路径，切回官方直连时历史直打 OpenAI |
| 代理可绑 0.0.0.0 且无调用方鉴权 | A2 | F1（安全） | 定 P1，需产品决策（保留 LAN 能力则必须加 token） |
| 工具消息内图片导致严格 Chat 上游 400 | A1（读码） | U1（cc-switch issue #7421/#7418 实证） | 定 P2，有上游用户实证 |
| 编辑保存丢弃运行期累积的 `codexModelApiFormats` | B2（事务视角） | E1（前端视角） | 定 P3，两侧指向同一行为 |

### 6.2 主题聚合（跨域指向同一类设计缺陷）

**主题 A：单一真相源建立了，但"喂给它的参数"没有统一。**
`codex_url.rs` 是正确的抽象，`ForwardResult.codex_bridge` 也是；但探测端传常量 endpoint、转发端传请求 endpoint（§7.2），主路径按桥分派而回退分支硬编码（A1-P2-2）。抽象只覆盖了主路径，边路仍在旁路它。
→ **对策**：不变量要用两条真实调用路径的实参驱动测试；新增旁路视为回归。

**主题 B：状态有多个副本，写者比读者多。**
"当前线路"五副本（§5.4）、安装模式三处（E1-04）、CDP 端口两套（C1-P2）、探测结果内存与元数据两份（E1-07）。每处都能找到一个"整体覆盖"的写者把另一个写者的结果抹掉。
→ **对策**：为每个字段指定唯一 owner；非 owner 的写入路径改为"只读或显式合并"，而不是整体快照回写。

**主题 C：崩溃恢复的三个组件互相失配。**
安装日志记录边界（`BeforeMoveOld` 无旧安装也写 `backup_path`）、状态查询（`canRollback` 要求已检测到便携安装）、UI 横幅（只看 `backupPath` 非空）——三者对"什么是可恢复态"的定义不一致，结果是**后端专门为"根目录缺失"写的恢复分支从 UI 完全不可达**（C1-P2）。
→ **对策**：把"可恢复"定义成一个后端计算的单一布尔值，UI 不再自行推断。

**主题 D：确认框承担了它承担不了的安全责任。**
deeplink 的 env 与 MCP command（F1-P1-1/2）、便携根删除（C1-P1-5）、诊断强杀 Codex（C1-P1-1）、标准安装静默回退并卸载 MSIX（C1-P1-2）——共同模式是"确认框文案与实际行为不符"，用户点"确认"时并不知道自己同意了什么。`deeplinkRisk.ts` 甚至在注释里明确写了"只用于 UI 提示，不参与任何拦截决策"。
→ **对策**：高危操作要么在后端硬拦（白名单），要么在确认框里显示**将要发生的具体事实**（绝对路径、将被杀的进程、将被卸载的包）。

**主题 E：模型目录字段跟着 Codex 版本漂移，我方按"曾经的必填字段"维护。**
`supports_parallel_tool_calls` 与 `supports_reasoning_summaries` 在 0.154 已不是 `ModelInfo` 字段（B1-P2-4）；`tool_mode = "code_mode_only"` 的原始动机（抑制 namespace 工具）已被 `supports_search_tool: false` 覆盖（B1-P1-2）；克隆 live 缓存时不剥模型绑定字段（B1-P2-3）；`multi_agent_version` 三份模板只有一份写（§4.2）。
→ **对策**：把"目录字段 × Codex 版本"做成一张显式表并配版本化测试，而不是靠注释记忆。

---

## 7. 与既往审计和计划的对账

本节由主审逐条读码核实（不依赖代理），回答一个问题：**上一轮记为"已修"或"已计划"的项，今天到底还在不在。**

### 7.1 回归：便携版更新守卫（08-27 记为已修 → 今天不存在）

2026-08-27 审计的发布域 P1-1 是"绿色版三个更新入口无 portable 防护"，整改记录称已在 `AboutSection.tsx:463` 处修复（portable 用户改为打开发布页）。

**今天的实际状态**：UI 改版后 `components/settings/AboutSection.tsx` **从 `src/main.tsx` 不可达**，修复随之失效。可达路径上：

- `settingsApi.isPortable()`（`src/lib/api/settings.ts:74`）在可达前端**零处调用**；
- 三个更新入口 `ChimeraApp.tsx:581`（标题栏）、`:3204`（首页横幅）、`views/NewSettingsView.tsx:96-105`（设置页）都直接 `installUpdate()`；
- 后端 `commands/settings.rs:325` `install_update_and_restart` 也**没有 portable 分支**。

这是"修复挂在一个后来被绕过的组件上"的典型模式：修复本身没被删，但它所在的代码路径死了。**教训**：把守卫放在**后端命令**里，而不是某个前端组件里——后端是唯一无法被 UI 改版绕过的位置。

### 7.2 回归：探测 URL == 转发 URL（v2.7.0 的核心不变量，今天在一条路径上破了）

v2.7.0（`23013bf8`）为此专门新建了 `proxy/codex_url.rs`，文件头注释写明设计意图："Every Codex URL now goes through `codex_upstream_url`, so a probe result is by construction a statement about the URL that will be used."

**今天的实际状态**：解析器确实是单一的，但**传给它的 `endpoint` 参数两侧不同**：

| 侧 | endpoint 来源 | 值 |
| --- | --- | --- |
| 探测 | `protocol.endpoint()` 常量（`codex_url.rs:40-46`） | `/v1/responses` |
| 转发 | `endpoint_with_query(&uri, "/responses")`（`handlers.rs:1158`） | `/responses`（含 query） |

对 origin-only 与 `/v1` 结尾的 base，`join_codex_path` 的 `/v1/v1` 去重让两者殊途同归；但对**自定义前缀 base**（`/api`、`/api/v3`、`/backend-api/codex`、`/coding`、`/compat` 等），前者得到 `{base}/v1/responses`、后者得到 `{base}/responses` —— 正是当初要消灭的那类错配。

更关键的是**等价性测试测不出来**：`model_fetch.rs:1860-1869` 的断言两侧都调 `protocol.endpoint()`，结构上不可能失败。

**哪边是对的**：`codex_url.rs` 自身的测试把 `{base}/v1/responses` 钉为自定义前缀下的期望值（含 `chatgpt.com/backend-api/codex/v1/responses`），也就是说**偏离设计意图的是转发端**。但修转发端等于改变存量用户的实际请求地址，必须配实机验证；较稳妥的落地是让 `codex_upstream_url` 对 `Native` 做内部端点归一化，使两侧传 `/responses` 还是 `/v1/responses` 都收敛到同一结果。

**教训**：不变量测试必须用**两条真实调用路径各自的实参**来驱动，而不是用双方共享的常量——后者只证明了函数是确定性的。

### 7.3 仍在：保存设置回退当前线路（08-27 记为已修，修的是锁不是合并规则）

08-27 并发域 P1-2 指出 `save_settings` 的读-改-写会回退并发切换。整改把读-改-写移进了 `mutate_settings` 的写锁内（`commands/settings.rs:86-93`，注释详细说明了这一点）。

**今天的实际状态**：锁确实修好了，但 `merge_settings_for_save`（`:13-58`）的合并规则**只保护 webdav/s3 密钥与 `local_migrations`**，`current_provider_*` 仍从前端回传值取。前端 `NewSettingsView.tsx:56-70` 与 `ChimeraApp.tsx:2329-2338` 都加了"保存前重读"缓解，但那只缩小窗口，不消除竞态——托盘或故障转移在"重读"与"保存"之间切换，仍会被回退。

**教训**：把竞态修成"窗口更小的竞态"不等于修好；正确做法是让后端拥有的字段**永不接受前端回传**。

### 7.4 v2.7.0 计划（09-09）逐项落地核对

✅ **已落地**（在代码中确认）：单一 URL 解析器（`codex_url.rs`，但见 §7.2）；`ForwardResult.codex_bridge` 与主路径按桥分派（`forwarder.rs:74,86`、`handlers.rs:1316,1346`）；前端只探默认模型与映射行且不阻断保存（`19123f90`）；探测结果持久化到 `meta.codexModelApiFormats`（`ChimeraApp.tsx:1307`）与逐模型失败诊断（`lib/api/model-fetch.ts:61-67`）；未映射模型 fail-open 加警告（`forwarder.rs:1228-1233`）；`approval_policy="untrusted"` 剥离（`codex_config.rs:263-319`）；MCP transport 写入前校验（`8ead6866`）；OAuth 自报客户端 0.153.4；DeepSeek 模板修正；`input_modalities` 回填（`codex_config.rs:707`）；glm-5.3 纯文本清单；默认模型改 `gpt-5.6-sol`（`codexTemplates.ts:24`）；双 UUID rollout 用量修复；云同步强制上传逃生口（`e89dc92c`）；内联 `<think>` 流式化与截断工具调用（Anthropic 侧）（`cc5acf21`）；`ChimeraApp.tsx` 内 `void` 死组件清除；模型选择器 Esc 不再连带关闭编辑器（`:2004-2008`）；CI 加 `pnpm audit` 与 `cargo audit`（两者均 `continue-on-error: true`，与计划的"warn-only 起步"一致，`ci.yml:61-65, 130-133`）；仓库改名断言脚本（`scripts/check-repo-references.mjs`）；**`tests/integration/machine-state.test.ts` 已改为密封 fixture**，不再 shell 出 `python3`、不再读开发机的 `~/.codex` 与真实数据库（文件头注释完整记录了动机，`:1-16`）——该项曾是"在 CI 上永远跳过、零价值"的典型，现已真正执行。

❌ **未落地**（计划中列出但今天代码里仍是原状）：

| 计划项 | 今天的位置 | 本文对应条目 |
| --- | --- | --- |
| M3.2 `model_catalog_json` 悬空指针自检 | `codex_config.rs:2029-2076` 对非我方指针原样放行 | §4.2 第 2 条 |
| M3.9 Chat 工具参数 `$ref` 兄弟键内联 | `proxy/` 下无任何 `$ref` 处理（仅 `gemini_schema.rs:136`） | §4.2 缺失能力 |
| M3.13a rollout `.jsonl.zst` 读取 | `session_usage_codex.rs` 与 `session_manager/providers/codex.rs` 均无 `zst` 匹配 | §5.9（D1） |
| M4.5 代理私有 `encrypted_content` 出站剥离 | `forwarder.rs` 无 `encrypted_content` 处理 | §5.1 |
| M4.10 熔断器 RAII 守卫 | `circuit_breaker.rs` 无 `impl Drop` | A2-P1-2 / D2-02 |
| M5.2 半行游标 | 两个用量文件均无"仅计完整行"逻辑 | §5.9（D1） |
| M5.4 post-import 用真实 `AppState` | `commands/sync_support.rs:10-14` 仍 `AppState::new(db)` | B2-P2 |
| M5.6 设备本地状态不随同步跨机 | `database/backup.rs:92-99` preserve 列表不含 `settings`/`session_log_sync` | §5.9（D1） |
| M5.8 DB 的 WAL 与 `busy_timeout` | `database/mod.rs` 无 `journal_mode`/`busy_timeout` 设置 | D2-04 |
| M5.9 备份轮转只认自家前缀 | `backup.rs:413-444` 仅按 `.db` 扩展名加 mtime 删除 | §5.9（D1） |
| M6.1 CDP 改 `--remote-debugging-pipe` | `codex_runtime.rs:559-560` 仍传 `--remote-debugging-port` | C1-P2 |
| M6.2 deeplink env 白名单 | `src/utils/deeplinkRisk.ts:1-7` 明确自述"只用于 UI 提示，不参与拦截决策" | F1-P1-1 |
| M6.3 非 loopback 强制 token | `proxy/server.rs` 无 token 校验 | F1-P1-3 |
| M6.6 gateway token 常量时间比较 | 无 `subtle` 依赖 | F1-P3 |
| M7.4 锁定浅色主题 | `src/main.tsx:106,133` 仍 `defaultTheme="system"` | §5.10（E2） |
| M7.5 固定 `lng: "zh"` | `src/i18n/index.ts:81` 仍 `getInitialLanguage()` 跟随系统语言 | §5.10（E2） |
| M7.8 `DatabaseUpgrade` 发布页链接 | `src/components/DatabaseUpgrade.tsx:17` 仍指向 `Duojiyi/chimera-plusplus` | §5.10（E2） |
| M8 测试不污染真实用户目录 | `src-tauri/tests/support.rs:16-17` 只设 `CC_SWITCH_TEST_HOME`，而 `claude_desktop_config.rs:1290` 读的是 `LOCALAPPDATA` | §5.12（H1） |

⚠️ **部分落地**：M3.4（DeepSeek 模板已写 `use_responses_lite: false`，但原生模板未写、克隆剥离清单仍不含该字段 → B1-P2-3）；M3.6（`session_index.jsonl` 已清理，Codex 侧边栏索引未清 → §4.2）；M3.11（`z.ai` 已加入但仍是子串匹配而非 DNS 标签边界 → B1-P3）；M4.2（Anthropic 侧已加 `__raw_arguments`，Chat 侧仍原样回放 → A1-P1-2）；M4.3（图片已转 `image_url`，但仍留在 `role:tool` → A1-P2-1）；M6.5（一条路径已用 `tempfile`，`misc.rs:2832` 仍是可预测文件名 → F1-P2）。

### 7.4b 供应链固定的一处正面核实

`src-tauri/Cargo.toml` 固定的引擎 rev `222de90c`，与 `chimera-runtime` / `chimera-platform` 所在 workspace（rev `c1b59b27`）自身 `Cargo.toml:66-67` 固定的 rev **完全一致**。09-09 计划中反复强调的"升级引擎必须同时改两处，否则锁文件出现两份 `codex-win-engine`"这一风险，本轮核实**没有发生**。

### 7.5 09-15 未提交文档（`next-development-gap-analysis-zh.md`）的落地情况

该文档（untracked，基线 v2.7.1）列的 A01–A07 已在 v2.7.2（`ca1c5d44`）落地：余额字段严格解析、`detect_provider` 改用 URL 解析加精确 hostname、错误体脱敏、CDP 总预算 deadline、子进程句柄改 `drop`、解锁与更新文案修正、快照应用全局互斥锁。

**未落地**：P0.1 / P0.2（CDP 端口跨 Chimera++ 重启的持久化与端口元数据恢复）—— `codex_cdp.rs:23` 仍是进程内 `OnceLock`，对应本文 C1-P2；P1.1（ChimeraHub 余额契约）—— 待正式 API 确认；A08（代理 LAN 监听）—— 待产品决策，对应 F1-P1-3。

**建议**：该文档目前未跟踪。要么补 commit 进 `docs/plans/`，要么把其中未完成项并入本文后删除——两份平行的"下一步"文档容易互相失效。

---

## 8. 建议路线图

按"用户实际受影响程度 × 修复成本"排序，不按审计级别排序。

### 阶段 0 — 热修（建议单独发 v2.7.3，每项可独立 revert）

这批的共同点：**当前用户正在受影响**，且改动小、风险低、不涉及结构重构。

| # | 项 | 位置 | 估量 |
| --- | --- | --- | --- |
| 0.1 | **"诊断"不再强杀用户的 Codex**：标准分支改用 `verify_msix_health_with_options(true)`，或检测到 Codex 运行时跳过激活探测；同时补操作锁、把 UI 文案"只检查，不修改本机文件"改成实际行为 | `commands/codex_runtime.rs:1424-1436`、`ChimeraApp.tsx:2575-2579` | 小 |
| 0.2 | **便携版更新守卫**：后端 `install_update_and_restart` 在 portable 模式下直接拒绝并返回"请到发布页下载"；前端三个入口读 `is_portable_mode` 后改为打开发布页 | `commands/settings.rs:325`、`ChimeraApp.tsx:581/3204`、`views/NewSettingsView.tsx:96-105` | 小 |
| 0.3 | **`approval_policy` 裸 `granular` 会让 Codex 整份拒载**：允许列表拆成"三个字符串值 + 表形态"，前端提示改为给出表形态示例 | `codex_config.rs:263`、`src/chimeraUtils.ts:347-352, 380` | 小 |
| 0.4 | **Chat 流式 `"error": null` 误杀正常回答**：改为仅当 error 为非空对象或字符串时才失败（与非流式聚合器对齐） | `providers/streaming_codex_chat.rs:837` | 极小 |
| 0.5 | **熔断器 HalfOpen 名额 RAII 守卫**：客户端断连不再让供应商永久不可路由 | `proxy/circuit_breaker.rs`、`forwarder.rs:452-505` | 小 |
| 0.6 | **`save_settings` 不接受前端回传的 `current_provider_*`** | `commands/settings.rs:13-58` | 极小 |
| 0.7 | **切官方不再清空 live `config.toml`**：种子 config 为空时以剥离路由键后的当前 live 为基线 | `database/dao/providers_seed.rs:57-66` 及写入链 | 中小 |
| 0.8 | **官方 OAuth 材料不随 providers 表进入云同步**：回填前剥离，或把官方行排除出同步 | `services/provider/live.rs:827-905`、`database/backup.rs:84-91` | 中小 |
| 0.9 | **托盘子菜单锁与主线程死锁**：先克隆句柄再释放锁 | `tray.rs:864-891` | 极小 |
| 0.10 | **合成 message id 补 `msg_` 前缀** | `streaming_codex_chat.rs:371` | 极小 |
| 0.11 | cc-switch 两行级修复：grok-4.6 加入 `supports_reasoning_effort`；关停/动态端口按 app 保留设置 | `transform.rs:72-73`、`services/proxy.rs:597-610` | 极小 |
| 0.12 | **读取 `.jsonl.zst` 会话**：超过 7 天的会话目前在用量统计与会话列表中同时消失，用户看到的是"我的历史不见了"。`zstd` 已是现有依赖，两处读取端各加一个分支 | `services/session_usage_codex.rs:209, 212, 634`、`session_manager/providers/codex.rs:591-625` | 中小 |
| 0.13 | **自动同步抑制改为全局**：数据库变更钩子同时通知两个后端，抑制计数却各自独立 → WebDAV 下载期间 S3 会把刚落库的旧数据反推上去。把抑制改成进程级共享，或在钩子处统一判定 | `database/mod.rs:84-94`、`services/webdav_auto_sync.rs:19`、`services/s3_auto_sync.rs:19` | 极小 |
| 0.14 | **允许删除僵尸会话**：源文件缺失时不要在路径校验阶段直接报错返回，应按 id 继续清理索引与数据库条目 | `session_manager/mod.rs:161, 188-193` | 小 |
| 0.15 | **把安全与支持入口改回本仓库**：`SECURITY.md` 的安全公告链接、`SUPPORT.md`、`ISSUE_TEMPLATE/config.yml`、`FUNDING.yml`、`CODEOWNERS` 目前全部指向上游 `Duojiyi/chimera-plusplus`，安全报告到不了本仓库维护者。同时给 `check-repo-references.mjs` 加上对 `Duojiyi/chimera-plusplus` 的检测，否则同类问题还会复发 | `SECURITY.md:20,22,56,58`、`SUPPORT.md`、`.github/*`、`scripts/check-repo-references.mjs:14` | 小 |
| 0.16 | **`DatabaseUpgrade` 的发布页链接改回本仓库**（运行时会真的跳转到上游） | `src/components/DatabaseUpgrade.tsx:17, 271` | 极小 |
| 0.17 | **把 `Backend Validation (ubuntu-22.04)` 加入发布必需 job**，或停止发布 deb/rpm/AppImage —— 二选一，不能继续发布从未被门禁覆盖的产物 | `.github/workflows/release.yml:76-86` | 极小 |
| 0.18 | **主行动按钮对比度**：`打开 Codex` 是白字配 `#ff5a36` = 3.10:1，全局 primary 按钮 3.52:1，三个焦点环 1.26–2.32:1。把强调色调深到满足 4.5:1（焦点环 3:1），一次改令牌即可覆盖 24 组配对 | `chimera.css:11`（`--p-orange`）、`:70, 1452, 1536, 3946` | 小 |
| 0.19 | **运行时视图三个弹层接入 `useDialogFocus`**：维护抽屉、历史版本选择器、离线安装确认；其中两个已声明 `aria-modal="true"` 却无实现，属语义与实现不符 | `ChimeraApp.tsx:2495, 2653, 2776` | 极小 |

### 阶段 1 — 协议与目录一致性（v2.8 主线之一）

| # | 项 | 依赖 |
| --- | --- | --- |
| 1.1 | **探测端与转发端共用同一 endpoint 实参**；等价性测试改由转发端真实 endpoint 驱动（§7.2） | — |
| 1.2 | Chat 自动回退分支按 `result2.codex_bridge` 分派（补齐 v2.7.0 未覆盖的边路） | — |
| 1.3 | Chat 桥截断工具调用降级（移植 Anthropic 侧 `__raw_arguments` 方案） | — |
| 1.4 | 工具输出图片移出 `role:tool` 消息（含改测试） | — |
| 1.5 | 目录字段按 Codex 版本表重整：`tool_mode` 改 `direct`（B1-P1-2）、`supports_parallel_tool_calls`/`supports_reasoning_summaries` 改为 0.154 的 `supports_reasoning_summary_parameter`（B1-P2-4，已由 §5.13 旁证印证）、克隆 live 缓存时按白名单剥模型绑定字段（B1-P2-3）。**不含** `multi_agent_version`（§4.2 已推翻） | §5.13 结论 |
| 1.6 | `model_catalog_json` 悬空/未展开变量指针自检 | — |
| 1.7 | `wire_api = "chat"` 写盘前归一化为 `responses` | — |
| 1.8 | cc-switch merge 项：rollout 字节游标、顶层 `base_url` 回退修正、评论与工具调用合并、DeepSeek 目录与定价、智谱模型列表形态 | — |

### 阶段 2 — 数据完整性与恢复可达性

| # | 项 |
| --- | --- |
| 2.1 | 半行游标：只把以换行结尾的完整行计入可提交 offset（Claude 与 Codex 两条路径） |
| 2.2 | ~~rollout `.jsonl.zst` 读取支持~~ → **已上移至阶段 0（0.12）**，因为用户可见症状是"历史会话消失" |
| 2.3 | 崩溃恢复三组件对齐：`can_rollback` 在"根目录缺失但存在备份"时为真，横幅按同一布尔值渲染，观察者记录 `had_previous` |
| 2.4 | 备份轮转只认自家前缀；设备本地状态不随同步跨机 |
| 2.5 | post-import 同步使用真实 `AppState` 与锁 |
| 2.6 | CDP 端口持久化（含 Codex PID），使 Chimera++ 重启后状态可确认；皮肤与模型解锁不再互斥 |

### 阶段 3 — 安全加固（需产品决策的先决策）

| # | 项 | 决策点 |
| --- | --- | --- |
| 3.0 | **在 GitHub 网页端给 `release` 环境配保护规则、给 `main` 配分支保护** —— 这两项代码无法自检，08-27 就已列为"待仓库管理员操作"，至今 `protection_rules` 仍为空。在此之前，`environment: release` 门禁是装饰性的 | 由谁做 reviewer；是否接受单人仓库下的自审 |
| 3.1 | deeplink env 白名单 + MCP 默认禁用 | 是否接受"部分合法预设需要用户手动开启" |
| 3.2 | 代理非 loopback 强制 bearer token，或直接拒绝非 loopback 绑定 | **是否保留 LAN 监听能力**（09-15 文档 A08 同一决策，至今未决） |
| 3.3 | CDP 改 `--remote-debugging-pipe`，或注入后重启无调试参数实例 | 是否接受皮肤/解锁流程变复杂 |
| 3.4 | 终端启动临时文件改 `tempfile` + 0600；SSRF 内网地址拦截；重定向不跟随 | — |

### 阶段 4 — 工程债（长期，单独立项）

DB 的 WAL 与连接池（消除"一次维护等于一次全局卡顿"）；244 个不可达前端文件的整树清理；i18n 统一；对比度与焦点管理；Images API 端点接管；`>32MB` 会话消息分页。

### 不建议在近期做

- **引擎 pin 升级**：已对齐 v0.5.6，无可升。
- **cc-switch 的 Claude/Gemini/OpenClaw 相关修复**：UI 不可达，无落点。
- **CodexPlusPlus 的注入/远控/插件市场/广告体系**：与产品定位冲突，按既定政策不吸收。

---

## 9. 未覆盖范围

1. **未运行任何代码**：本轮全部为静态阅读。所有标 ○ 的条目（MSIX 环境继承、ARM64 宿主、健康探测超时条件、Electron 单实例行为、第三方网关实际报文、`tool_mode` 对第三方模型的实际影响）必须先实机复现再动手。
2. **未审计的代码**：`commands/misc.rs` 5000 余行中仅覆盖终端启动与 `open_external`；`codex_model_unlock.js` 仅审网络与 MessagePort 钩子段；`codex-theme-engine` 的 payload 与运行期模板；引擎提权 AppX 恢复的 PowerShell 脚本（仅略读）；macOS 与 Linux 分支；Claude/Gemini/OpenClaw/Hermes 方向的转换与配置写入（UI 不可达但 Rust 代码仍在）。
3. **未评估**：镜像仓库 `Duojiyi/codex-app-mirror` 自身的供应链；四个 pinned git 依赖的完整审计；依赖公告（未联网核对 CVE）。
4. **上游差距**：我方与 cc-switch v3.20.2 本身已高度分叉（`codex_config.rs` 5454 diff 行、`services/proxy.rs` 4997 行、`transform_responses.rs` 3219 行），本轮只审了 33 个新提交，分叉存量部分未审。
5. **本文档未覆盖**：性能剖析、内存占用、启动耗时、实际用户遥测。
