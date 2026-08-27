# Chimera++ 上游同步 + 双盲审计报告

> 日期:2026-08-27 · 范围:三上游最新基线合并价值 + 12 路双盲审计 + 对抗性复核
> 置信度标记:✅ 已亲自读码复核确认 · ⚖️ 双盲交叉验证(两个互不知情的代理各自发现同一问题) · ○ 单源(代理报告,证据精确,未二次复核)

---

## 一、执行摘要

- **你报告的问题(Codex 聊天中途不汇报、任务干完才一次性长输出)已定位并三方印证**:根因是本仓库生成的 NativeResponses 模型目录把 Codex 系统提示词整段替换成 117 字符占位符,丢失了"每 30 秒汇报进度"的 harness 指令。这不是网络/中转问题,是我们的配置生成逻辑。
- **上游合并**:三个项目的主线增量(cc-switch 的 Pi/多账号/表单重写、CodexPlusPlus 的注入面、App Manager 的引擎)对我们基本不适用;但夹带了一批**普适 bug 修复**,其中 cc-switch 有 6 项逐行确认命中我们代码(3 项近零风险)、CodexPlusPlus 有 2 项应修 + 1 项建议、App Manager 有 1 项未修 bug 就在我们 pin 的引擎里 + 1 个镜像分发故障。
- **审计结论**:发现 1 个 P0(数据毁损,已复核确认)、一批 P1、以及一个跨 6 个代理聚合的系统性主题——"配置/凭据在切换与恢复路径上被覆盖或回滚"。配置写入核心链路本身质量非常高(无 P0/P1)。

---

## 二、你的原始问题:Codex 中途不汇报的根因与修复

### 根因
`config.toml` 的 `model_catalog_json` 指向我们生成的 `cc-switch-model-catalog.json`。你的线路是 `wire_api = "responses"` 直连 `api.chimerahub.org`,命中 **NativeResponses** 档位(`src-tauri/src/proxy/providers/codex.rs:487-505`)。该档位为避免向原生网关发送它们会拒绝的 freeform `apply_patch` 工具,剥离了工具声明——但连带把 `base_instructions` 也留成了模板里的一句话占位符(`src-tauri/src/resources/codex_native_responses_template.json:5`,仅 117 字符),而正常的 gpt-5.5 模板这里有 **21459 字符**、含 `## Intermediary updates`(明确要求"每 30 秒汇报"、"探索时边做边说")。

Codex 把 `base_instructions` 整体当作系统提示词,占位符一替换,模型就没有了"边干边汇报"的指令。

### 证据(三方独立印证)
1. ✅ **实测**:你今天的 rollout(`~/.codex/sessions/2026/08/27/rollout-...T10-46-23...jsonl`)里出现连续 **17 / 23 / 31 / 57** 次工具调用中间零条助手消息,最后一次性输出 5000–9000 字——症状完全复现。同时该会话 157 条 reasoning 里 140 条带流式 summary,说明**流式管道本身是通的**,缺的就是模型主动发 commentary。
2. ⚖️ **配置写入盲审(不知道你的问题)** 独立在"待验证"里点出:"native 档位若用户未提供 base_instructions 则沿用一句式中性提示而非完整 harness……agent 行为是否因精简 harness 退化需运行期验证"——它从纯代码角度走到了同一个点。
3. ○ **Codex 语义兼容盲审** 进一步发现:原生模板还带 `tool_mode: "code_mode_only"`(`codex_native_responses_template.json:39`),把模型钉在 code-mode 工具面,而中性 base_instructions 又没教它怎么用 code mode。两者叠加。

### 修复建议(按推荐度)
1. **给 NativeResponses 模板补回与工具无关的 harness 章节**(推荐):把 gpt-5.5 模板里的 `## Intermediary updates`、`## Final answer instructions` 等**不引用具体工具**的段落接在中性身份句之后。注意 gpt-5.5 全文 3 次引用 `apply_patch`,不能整段照搬(该档位剥离了此工具),只取工具无关章节即可。
2. **把 baseInstructions 开放为目录编辑器可编辑字段**:真正的编辑器是 `ChimeraApp.tsx` 内联实现(不是死代码 `CodexFormFields.tsx`),该文件目前完全没有 baseInstructions 输入框,自建线路无从自定义。
3. **临时办法(你现在就能用)**:往 `~/.codex/AGENTS.md`(当前 0 字节)写几条"每 30 秒用一两句话说明正在做什么"的规则。该文件不会被 Chimera++ 覆盖;直接改 `cc-switch-model-catalog.json` 则会在下次切换线路时被冲掉。

> 附带清理:你的 `config.toml` 里有 `disable_response_storage = true`,该键已从 Codex ≤0.150 全系移除(死字段,`--strict-config` 下会报 unknown field)——见 P3。

---

## 三、上游合并建议

### 3.1 cc-switch(基线 v3.19.2 → HEAD,93 提交)

**值得合并 — 已逐行确认命中我们代码:**

| 提交 | 内容 | 我方文件 | 风险 |
|---|---|---|---|
| 3c592d93e (#6283) | WiX 注册表键单反斜杠被 Handlebars 吞成转义,每个 MSI 写垃圾键 | `src-tauri/wix/per-user-main.wxs:156` | 零(1 行 `\`→`\\`) |
| 413c09e07 (#6087) | `model_catalog_json` 的 Some 分支无 ownership 检查,覆盖用户自定义目录路径 | `codex_config.rs:1793-1796` | 低 |
| 46f19a158 (#6126) | DeepSeek `prompt_cache_hit_tokens` 未计,成本高估 | `proxy/usage/parser.rs:14`、`transform_codex_chat.rs:1673` | 低 |
| c82624761 | Kimi/Moonshot 已不需思考回放,注入占位 thinking 反扰乱思维链 | `proxy/providers/claude.rs:25` REASONING_VENDOR_HINTS | 低(需翻转测试) |
| 1f38c8382 (#6160) | 智谱 .cn 把配额类型改名 `CREDIT_LIMIT`,面板空白 | `services/coding_plan.rs:257` | 零 |
| d2b070c96 (#6277) | 接管恢复用旧快照覆盖 live 官方登录 | `services/proxy.rs:2106-2112` 简单恢复路径 | 中(见主题聚合) |

**已有等价实现(好消息):** WSL 原子写回归我们从未引入(用 `MoveFileExW` 而非上游出问题的 `ReplaceFileW`);env-check 挂死我们已独立解决且更完整;逐模型思考档位、config-only 注入 `experimental_bearer_token` 均已具备。

**不适用:** Pi 全线(无 Pi)、多 ChatGPT 账号全线(单账号架构)、供应商表单对齐簇(UI 已重写)、各家预设/定价数据刷新(按需)。

### 3.2 CodexPlusPlus(v1.2.52 → v1.2.55)

主体(管理器 UI/插件市场/注入/远控)全部在"不合并"政策内。政策内实质收获:

- ○ **应修①(最高优先级) #1996**:Chat 方向 tool 输出图片被 JSON 字符串化——`transform_codex_chat.rs:641-659` 对数组 output 走 `canonical_json_string`(base64 当文本),`media_sanitizer.rs:190-222` 只扫 `input_image`/`content` 不扫 `output[]`。单张 2MB 图 ≈ 200 万 token 撑爆上下文。我们 Anthropic 方向已正确(`transform_codex_anthropic.rs:726`)可对照移植。
- ○ **应修② #1870**:`delete_session` 只删 rollout 文件(`session_manager/providers/codex.rs:255-274`),不清 Codex 的 `session_index.jsonl`/`state_5.sqlite`(路径解析设施 `codex_state_db.rs` 我们都有)→ 桌面端留脏线程"no rollout found"。
- ○ **建议 #327**:Chat 方向补中段孤儿 function_call 摘除降级(尾部保留),对齐 Anthropic 方向既有行为,消除 DeepSeek "insufficient tool messages" 400。
- ○ **防御 #1997**:MCP 写入器 `mcp/codex.rs:571-574` 的 `_ => vec!["type"]` 分支理论上可写出无 transport 的表 → Codex 26.820 `invalid transport` 整配置拒载。加写入前校验。
- **预警**:Codex 桌面端 26.818→26.820 一周两跳,均把"静默容忍"改成"严格拒载/解析"(mcp transport、provider 存在性、reasoning_tokens、id 前缀)。我们大多已提前达标。

### 3.3 Codex-App-Manager(引擎 pin `d29fda32` = v0.5.2)

- **引擎零实质漂移,pin 无需前移**:v0.5.2→HEAD 28 提交中 26 条是 deps bump,唯一实质提交只动 mac-engine,不在我们依赖的 win-engine/theme-engine 内。
- ✅ **#260(bug 就在我们 pin 的源码里,未修)**:便携 MSIX 解压 `extract_msix`(`portable.rs:182-219`)用 `enclosed_name()` 直接 `dest.join` 写盘,无 OPC percent-decode → `@oai`/`$_Statsig` 落成 `%40oai`/`%24_` → Node 找不到模块 → **Codex Computer Use 失效**。非 zip-slip(有 `..` 防护),纯编码 bug。修:解压后按段 percent-decode 重命名。
- ○ **镜像分发故障(唯一紧急项)**:`Duojiyi/codex-app-mirror` 今天 CI `digest-mismatch` 失败,落后上游 1 个 Codex 桌面版(26.820.71523),用户此刻拿不到最新版,历史版本目录碰缺失 asset 会 404。建议重跑失败 workflow,或 cherry-pick 上游 4 条管道健壮性修复(fff833b/eb0742b/b5d74b4/a4a8f45)。

---

## 四、审计发现清单(12 路双盲 + 对抗性复核)

### P0 — 数据毁损

**P0-1 ✅ 自定义便携安装目录指向已有非 Codex 目录 → 永久删除该目录内容(无回收站)**
- 环节(五处全坐实):`settings.rs:110-241` 两个校验函数只拒符号链接/根目录/家目录/系统目录,**不要求空目录、不校验 Codex 身份** → 引擎 `portable.rs:818` `had_previous = install_root.exists()` 存在即当旧版本 → `810` 强杀目录内所有进程 → `848` 整目录改名为 `Codex.rollback-*` → `948` 安装成功后 `remove_dir_all` 永久删除。
- 触发:用户在设置里把 portable root 指到一个已有非空目录(目录选择器天然只能选已存在目录,把有内容的目录当"安装位置"很自然),然后执行便携安装/更新/修复。
- 修复:安装前对非空目录跑 `detect_portable_install` 身份校验(AppxManifest == OpenAI.Codex / asar 包名),否则拒绝并提示;设置保存时也对非空非 Codex 目录硬报错。**本轮最该优先修的一条。**

### P1 — 明确 bug,有真实触发路径

| # | 置信度 | 问题 | 位置 | 后果 |
|---|---|---|---|---|
| P1-1 | ⚖️ | `save_settings` 非原子读-改-写回退并发的供应商切换(前端+后端两侧独立发现) | `commands/settings.rs:72-77` + `ChimeraApp.tsx:4767` | 托盘/failover 切到 B 后用户存设置回退 A,代理路由与 UI 分裂 |
| P1-2 | ✅ | 编辑线路保存静默清空 createdAt/sortIndex/icon/iconColor + 强改 category | `ChimeraApp.tsx:1185-1238` + `dao/providers.rs:208-228` | 迁移用户改个名字就丢排序/图标元数据、列表跳位 |
| P1-3 | ✅ | 模型映射"实际请求模型"输入框每敲一字符失焦、IME 被打断 | `ChimeraApp.tsx:3919` key 含受控值 | 该列功能不可用 |
| P1-4 | ✅ | 便携安装崩溃/断电后回滚必然失败(root 缺失时 rollback 报"未检测到 Codex",备份完好却无法应用内恢复,横幅还误导"可回滚") | `commands/codex_runtime.rs:1087` + `ChimeraApp.tsx:2458` | 唯一出路是重下 ~1GB 重装 |
| P1-5 | ○ | 云同步(WebDAV/S3)无条件 last-writer-wins,无 If-Match/etag 比对,auto-sync 只上传不下载 | `webdav_sync.rs:64` / `s3_sync.rs:49` | 双机并发改配置静默互相覆盖丢数据 |
| P1-6 | ✅ | >32MB 的 Codex rollout 用量永久缺账 + 会话从列表消失 + 每 60s 重试报错不收敛 | `security_limits.rs:14` + `session_usage_codex.rs:576` | 重度用户统计系统性低估(Claude 侧无此上限,口径不一) |
| P1-7 | ○ | 历史归桶迁移改写正被 Codex 写入的 rollout,Unix 上 rename 后 Codex 持旧 inode,后续对话内容写进已 unlink 文件永久丢失 | `codex_history_migration.rs:1253-1296`(切线路后 auto_reclaim 自动触发) | 活跃会话内容丢失且不在备份里 |
| P1-8 | ○ | 模型目录跨版本必填字段回填不完整(只回填 supports_reasoning_summaries,漏 supports_parallel_tool_calls/base_instructions) | `codex_config.rs:1651` | 新旧 Codex 并存时老版本整体拒载目录、Codex 起不来 |
| P1-9 | ○ | 官方 OAuth 回切用切走时的 DB 快照覆盖被 Codex 持续刷新过的 live token | `codex_config.rs:468-485`(preserve 默认 true) | 旧 refresh_token 已失效则被迫重登/间歇 401 |
| P1-10 | ○ | 绿色版三个更新入口无 portable 防护 → 点更新装出 MSI 副本(裸 exe 无 bundle_type,updater 回落 MSI URL) | `ChimeraApp.tsx:3150/562/4809` | 两份安装并存,绿色目录仍旧版继续提示更新 |
| P1-11 | ○ | 本地代理无本机鉴权(默认绑 127.0.0.1、无 CORS 层、主端点无 token) | `proxy/server.rs` + `handlers.rs:120` | 恶意网页可用 text/plain 简单请求盗配额、以你的密钥注入 prompt(偷不到密钥,响应被 CORS 挡);改绑 0.0.0.0 后局域网可盗用 |
| P1-12 | ○ | 更新签名私钥暴露给无 environment 门禁的 workflow(candidate/windows-test/macos-test 无 `environment: release`,checkout 任意 ref 后注入 secret) | `.github/workflows/` | 私钥泄露=可对任意恶意包出具通过验签的 .sig(供应链风险) |
| P1-13 | ○ | Chat→Responses 桥对内联 `<think>` 整段缓冲,且静默超时监控转换器出口而非上游到达 | `streaming_codex_chat.rs:199` | chat 桥线路(MiniMax/DeepSeek)深思考被代理自己掐断(注:不影响你当前 responses 直连线路) |
| P1-14 | ○ | 并发保存供应商时 `block_on` 在 runtime worker 上等 tokio 锁(Claude/Gemini 分支漏了 spawn_blocking,Codex 分支已正确) | `commands/provider.rs:142-166` | 接管态 + 并发 ≥ worker 数(单核机 1 个即可)→ 全后端冻结 |

### P2 — 边界/健壮性(择要,完整见各代理报告)

- ○ 出站请求体无差别递归删除 `_` 前缀字段,篡改工具调用参数 `_id`/`_meta`(`forwarder.rs:3564` + `body_filter.rs:74`)→ 缓存 miss + 模型据被篡改历史推理出错。
- ○ 透传流式判定只看 Content-Type,错标 SSE 的网关整条流被缓冲后才返回(转换路径已有嗅探兜底,透传路径没有)。
- ⚖️ usage_script 的 rquickjs 无执行超时/内存上限(安全 + 数据两个代理各自发现)→ deeplink 导入的恶意 `while(true){}` 永久占死一个 worker 线程。
- ○ CDP 固定调试端口 9330 在便携 Codex 整个生命周期开放,本机任意进程可 `Runtime.evaluate` 接管 renderer 偷令牌(`codex_cdp.rs:15`)。
- ○ 每日/启动维护(备份+vacuum)与 WebDAV/S3 同步直接在 async 任务持 DB 大锁 → 代理请求同步 park;`Database` 是 std Mutex 单连接,长操作与请求热路径共用一把锁,"一次维护=一次全局卡顿"。
- ○ 切走前 backfill 在 live 读取/校验失败(触发之一=Windows Codex 正持有 config.toml)时静默跳过,丢用户就地编辑且 warnings 无记录。
- ○ 顶层 `experimental_bearer_token`/`base_url`/`wire_api` 回退写法不是 Codex 键,静默忽略(strict-config 硬报错)。
- ○ 未处理 `profile`:活跃 `[profiles.x]` 声明 model_provider 会覆盖我们写的顶层字段 → 切换"成功"实际走旧路由。
- ○ MSIX 冷启动只等 10s(引擎自述 30s)→ 成功启动误报失败;try_skin_package 不取 OperationLock 可与更新并发撞 rename;"打开 Codex"对运行实例无条件关闭重启 30s 强杀、无确认;回滚残留目录无清理每次泄漏 0.5–1GB;便携卸载 `remove_dir_all` 无重试。
- ○ 双语言割裂:主界面全硬编码中文、会话页走 i18n、语言切换入口在死代码里。

### P3 — 代码质量/轻微(择要)

- ○ **约 76% 前端源码是不可达死代码**(`CodexFormFields.tsx`/`ProviderForm.tsx`/`useCodexConfigState` 整条链路;ChimeraApp.tsx 5728 行重写了整个 UI 却未清尾),4 个 `void` 引用死视图仍进 bundle。极易改错目标文件。
- ○ `disable_response_storage`(死字段,你的 config 里有)、`minimal_client_version`(纯装饰无门槛)、`shell_type: shell_command`(≥0.148 只是 unified_exec 别名,注释按旧语义)、推理档白名单丢弃 persistent/自定义值。
- ○ `dump_sql` 表名不转义 `"`、REAL 的 inf/NaN 直接输出;开机自启注册表值含空格路径不加引号;历史版本发布日期按 UTC 截取致东八区差一天;进程探测瞬时失败被伪造成"未安装"。

### 正面结论(值得肯定)
- ✅ **配置写入核心链路质量非常高,无 P0/P1**:全程 `toml_edit` 就地编辑保留注释/未知字段(无有损往返)、原子写防 symlink 抢占、live 以原始文本存库保真、切换事务式回滚。
- 供应链:Codex 运行时安装做 SHA-256 + Authenticode + MSIX 身份 + 受信镜像多重校验;自更新 minisign 验签 + fail-closed;deeplink 有纵深防御 + 导入确认对话框 + 凭据脱敏。
- 代理:SSE 对 UTF-8 跨 chunk/CRLF/缺尾空行/错标 Content-Type 均有处理;usage 记账有语义去重;取消经 Drop 链正确传播。
- `wire_api="chat"` 命门处理正确(0.145 起 Codex 硬拒 chat,我们全预设只写 responses,Chat/Anthropic 强制走代理改写回 responses)。

---

## 五、主题聚合:跨代理指向的系统性问题

**"配置/凭据在切换与恢复路径上被覆盖或回滚"** —— 这是本次审计信号最强的主题,6 个独立来源同时指向,且与 cc-switch 最近一周的高频用户 issue(#6875/#6886/#6902)完全吻合:

| 来源 | 表现 |
|---|---|
| 前端 D + 后端 G | save_settings 回退并发切换(P1-1) |
| Codex 语义 I | OAuth 回切回滚已轮换的 refresh_token(P1-9) |
| cc-switch d2b070c96 + issue #6875/#6886 | 接管恢复覆盖 live 官方登录 |
| 配置写入 A | 切走前 backfill 静默跳过丢就地编辑;多文件写非崩溃原子 |
| 数据层 F | 云同步 last-writer-wins(P1-5) |

**建议把它作为一条独立加固专项**:确立不变量——"provider 切换/恢复不得覆盖用户手写的外部字段、不得回写陈旧 token、关键写入前留物理备份"。参考上游思路,但按我们架构实现(上游 926af9492 + d2b070c96 尚未完全解决,#6886 就是 3.20.0 实测复现)。

**上游尚未修复、我们同样中招的共享 bug**(无补丁可抄,需自查):#6867(Kimi `$ref` sibling 清洗)、#6903(Anthropic 尾随 thinking 块乱序)、#6890(body 覆盖无删除语义,`forwarder.rs:3432`)、#4341(Codex 第三方对话自动中断)。

---

## 六、改进计划路线图

### 阶段 0 — 立即(热修,面向你当前的问题 + 紧急项)
1. **修复你的流式问题**:NativeResponses 模板补回工具无关的 harness 章节(§二方案 1)。
2. **修复镜像分发故障**:重跑失败 workflow / cherry-pick 上游 4 条管道修复,让用户能拿到最新 Codex 版。
3. **P0-1 数据毁损**:便携安装前加目录身份/空目录校验。

### 阶段 1 — 补丁版(低风险高收益,可一版打包)
4. cc-switch 3 项零/低风险修复:WiX 反斜杠、model_catalog_json ownership、DeepSeek 缓存字段。
5. cc-switch 另 3 项:Kimi 思考注入撤出、智谱 CREDIT_LIMIT、恢复路径 live 登录保护(与主题聚合合并)。
6. P1-2/P1-3 前端两条(编辑丢元数据、模型映射失焦)——影响日常操作,改动小。
7. P3 死字段清理:disable_response_storage 等。

### 阶段 2 — "配置/凭据完整性"加固专项(主题聚合)
8. save_settings 走写锁内合并 + current_provider_* 不接受前端回传(P1-1)。
9. OAuth 回切按 last_refresh 取新(P1-9);backfill 失败要 warn 不静默(A P2-1)。
10. 云同步加乐观并发控制(etag/If-Match)(P1-5);切换关键写入留物理备份。

### 阶段 3 — "Codex 严格化对齐"专项(跟上 26.820 收紧)
11. 目录必填字段回填补全 supports_parallel_tool_calls/base_instructions(P1-8)。
12. MCP 写入器 transport 校验(#1997);profile 覆盖检测(I P2-4);reserved id 列表对齐 + 精确匹配。
13. CodexPlusPlus 应修两项:Chat 方向图片字符串化(#1996)、delete_session 清 session_index(#1870)。

### 阶段 4 — 健壮性与技术债
14. P1-4 便携回滚恢复闭环;P1-6 >32MB rollout 流式解析;P1-7 迁移跳过活跃文件。
15. P1-10 绿色版更新入口防护;P1-11 代理本机 token;P1-12 CI 私钥 environment 门禁;usage_script 资源限制;CDP 随机端口。
16. 前端死代码清理(76%);把 DB 长操作全部移出 runtime worker(P2)。

### App Manager #260
17. 便携安装后对解压产物做 OPC percent-decode 重命名(修 Computer Use),或向上游提 PR。

---

## 附录:审计方法

12 路互不知情的双盲代理并行审计(配置写入、代理流式、全仓安全、前端状态、运行时进程、数据层、并发异步、发布更新、Codex 语义兼容,+ 3 个上游调研),各自只拿到自己的视角、不读既往审计结论、以代码为唯一证据。返回后由主控做对抗性复核:P0 + 8 条核心 P1 已亲自读码验证(标 ✅),3 组主题经双盲交叉验证(标 ⚖️),其余单源发现证据精确但未二次复核(标 ○)。两个代理曾因 API 连接中断早退,已重启重跑。
