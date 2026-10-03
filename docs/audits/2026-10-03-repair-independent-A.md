# 独立盲审 A：当前前端接线与相关后端接口

日期：2026-10-03（Asia/Shanghai）
审查截止：约 20:55；工作树基准 HEAD：`6b737c7d0aed7dd69304f40a8aa1ef35ddc9fb84`，实际审查包含未提交代码，不等同于该提交快照。

## 边界与方法

- 只读产品代码和测试；未读取 `docs/audits` 历史报告、B 报告或其他 agent 的结论，未询问主线程修复预期。产品源码内自带的历史审计字样不作为本报告证据。
- 顺序为资源、提示词、会话导出与刷新、用量，然后主壳、工具、设置及关联 API/后端。审查了 `src/App.tsx`、`src/ChimeraApp.tsx`、指定的 ToolView 系列、PromptsView、SkillsMcpView、NewSettingsView、UsageView、SessionManagerPage、DeepLinkImportDialog，以及下述引用的辅助组件与接口。
- 只写本报告；没有修改产品代码或测试。没有执行真实安装、线路切换、删除、云端上传/下载或用户配置文件写入。
- 没有编译 Rust，没有运行 cargo build/test/check/clippy、tauri build/dev，也未清理 Rust 产物。Rust 结论来自源码追踪，未作本地原生执行验证。
- 使用现有聚焦前端测试，均限制 `--maxWorkers=2`；另对当前源码抽取出的编辑器打开函数做内存隔离时序验证。该验证不是完整 React/WebView E2E。
- 这是持续变化工作树上的有限审查，不是绝对零缺陷声明，也不是全仓库安全认证。

## 确认问题

### A-01 / P1：异步打开旧线路可覆盖新建且已修改的草稿

位置：`src/ChimeraApp.tsx:765`（openEditor）、`:781`（openToolEditor）、`:797`（等待 getAll）；入口为 `src/views/ToolView.tsx:391` 与 `:620`。

触发条件：Claude/Gemini/OpenCode/Pi 等使用主壳原生编辑器的工具，读取现有线路尚未返回时，用户点击“添加线路”并编辑新草稿。

证据：

1. `openToolEditor` 仅在发起时检查闭包中的 `editor`；编辑已有线路会 `await providersApi.getAll(appId)`。
2. 等待期间没有设置打开中锁，列表编辑和添加按钮也未因这个请求禁用。新建路径同步调用 `openEditor`，可先建立新草稿。
3. 旧请求返回后直接调用 `openEditor`，未校验请求代次、当前工具/视图或 `editorRef.current`。`openEditor` 无条件重置 baseline、appId 与 editor，也没有走未保存确认。

隔离执行：读取当前 `ChimeraApp.tsx`，抽取并由已安装 TypeScript 转译原 `openToolEditor` 函数；getAll 使用延迟 Promise，顺序为“打开 old → 打开 new → 修改 new.name → 返回 old”。输出为：

```json
{"events":[["opened","new"],["opened","old"]],"finalEditor":{"id":"old","name":"existing line","app":"claude"}}
```

影响：新草稿被覆盖，未保存内容丢失。跨工具导航期间返回也存在同类过期打开风险，但本次隔离验证只验证同工具旧请求覆盖新草稿。

修复方向：给编辑器打开请求增加代次/占用校验，提交结果前核对当前编辑器状态；新建、关闭及工具切换应使旧请求失效。补充真实组件延迟返回回归测试，不能仅验证保存时 appId 正确。

### A-02 / P2：会话列表刷新不刷新消息，导出仍可能包含旧正文

位置：`src/components/sessions/SessionManagerPage.tsx:329`、`:339`、`:1294`；`src/lib/query/queries.ts:307`、`:315`；后端 `src-tauri/src/commands/session_manager.rs:6`、`:21`。

触发条件：正在查看会话，外部工具向同一 sourcePath 追加消息；用户保持当前选择，点击会话页刷新，再导出 JSON。

证据：

- 刷新按钮仅执行列表 query 的 `refetch()`。
- 正文使用独立 key `["sessionMessages", providerId, sourcePath]`；列表刷新即使更新 lastActiveAt，也不改变消息 key，没有 invalidate/refetch 当前消息。
- `handleExport` 序列化当前缓存中的 `messages`。它正确阻止消息正在请求/请求失败时导出，但未发生消息请求时，旧数据仍满足导出条件。
- `refetchMessages` 仅接在正文加载失败的重试按钮上；普通列表刷新不调用它。后端 list/getMessages 是两个独立命令。

影响：列表元数据可以是新的，导出正文却是旧的，用户认为刷新后导出的完整记录可能遗漏最新消息。30 秒 staleTime 并不自动轮询，不能保证点击刷新会更新正文。焦点自动刷新等可能缓解个别场景，不消除上述稳定选择、同一 key 的路径。

验证级别：源码接线确认；已有会话导出/消息错误测试通过，但未真实追加用户会话文件或执行 WebView 下载。

修复方向：用户刷新时同时重读当前消息，或把可确认的内容版本纳入消息失效策略；导出应等待该刷新完成。增加“相同 sourcePath 追加消息 → 刷新 → 导出包含新正文”的集成测试。

### A-03 / P2：非 Codex 提示词先提交库记录，写文件失败后库与实际生效文件不一致

位置：`src-tauri/src/services/prompt.rs:29`、`:57`、`:59`、`:64`、`:74`；`src/views/PromptsView.tsx:102`、`:123`、`:452`。

触发条件：非 Codex 提示词已有启用条目，保存修改或禁用时数据库可写，但目标提示词文件写入失败，例如权限不足或文件占用。

证据：非 Codex `upsert_prompt` 先执行 `state.db.save_prompt(...)`，然后才调用 `write_text_file`，失败直接 `?` 返回，没有回滚库记录。前端捕获错误后重新读取库与 live 文件，无法恢复一致性。

具体后果：

- 编辑启用条目失败：库保存了新正文、enabled 仍为 true，实际文件继续使用旧正文。
- 禁用唯一启用条目失败：库已显示 disabled，但清空文件失败，工具继续读取旧指令；UI 禁用状态不代表实际停用。

这不是把正常的确认风险误判为静默覆盖：当前 UI 已明确提示“可能覆盖或清空、不保证失败回滚”，因此本项属于**已披露但仍存在的失败一致性问题**。本报告不声称导入 .md 或深链触发同样问题：当前非 Codex Markdown 导入和深链提示词导入都直接保存禁用库条目，绕开这条 upsert 写文件路径。

验证级别：Rust 源码控制流确认，没有执行权限故障注入。建议后续在临时数据库/临时文件夹做 DB 成功 + live 写失败的回归验证，不对用户真实提示词文件注入故障。

修复方向：为库/文件更新提供补偿或恢复记录，至少显式呈现“库状态与生效文件不一致”，而不是只依赖一次失败 toast。

### A-04 / P2：用量“本月”按钮请求今日窗口，时间范围文字也有混用

位置：`src/views/UsageView.tsx:302`、`:490`；`src/utils/usageMetrics.ts:3`、`:11`；`src/lib/api/usage.ts:50`、`:79`；`src-tauri/src/commands/usage.rs:12`、`:48`。

证据：可见按钮数组是 `["today", "本月"]`，aria-label 却为“今日”。点击后 range=today，`usageWindow` 返回本地当天 00:00 到现在，并非月初到现在；API 将这一 start/end 传给后端统计。导出也基于该窗口的 trends。

触发：在非每月 1 日点击可见“本月”，所见统计/CSV 实际只覆盖当天，可能被当成月累计。

关联显示问题：顶部“近 N 天”取当前请求的 `range`，旁边范围标签和数据取 `loadedRange`；例如今日数据加载成功后切到 7 天失败，可能出现“近 7 天 · 今日”的混合标题。页面虽另有保留旧结果提示，标题仍不一致。

测试缺口：`UsageView.test.tsx:273` 已通过 accessible name “今日”选择按钮，因此测试会绕过可见文案“本月”；该测试验证保留旧数据，但未验证顶部整句范围标题。

修复方向：若功能是今日，统一可见文字为“今日”；若确需本月，则新增独立月窗口与测试。展示已有数据的标题统一使用 loadedRange。

### A-05 / P1：最终 Skills 更新入口承诺先备份，但备份失败仍继续覆盖并删除旧版本

位置：`src/views/SkillsMcpView.tsx:604`、`:618`、`:620`；`src-tauri/src/services/skill.rs:1477`、`:1596`、`:4048`。

此项来自 20:52:22 落地的新更新确认入口，收尾时已重新读取，而非沿用之前入口未开放的判断。

触发条件：当前 Skill 含有需保留的本地修改，备份目录不可写或备份复制失败，但受管目录及更新 staging/swap 仍可正常写入；用户依据“当前版本会先备份”的确认文案执行更新。

证据：

1. 页面与确认框都声明更新前备份，确认后调用 `skillsApi.updateSkill(update.id)`。
2. 后端 `create_uninstall_backup(&skill)` 返回 Err 时仅 `log::warn!`，文字明确“将继续使用可回滚 swap”，不终止更新，也不向前端返回备份缺失警告。
3. 更新、数据库保存和工具投影成功后，`previous_dir` 被 `remove_path` 删除；这个临时回滚目录不是持久用户备份。函数随后返回 `Ok(updated_skill)`。
4. 备份写入失败分支会尽力移除不完整备份目录，因此不能把失败留下的碎片视为有效恢复路径。

影响：用户被承诺有旧版本备份，实际成功更新却可能没有该次备份，旧受管目录也已清理，本地修改可能无法恢复。源码中的 swap 回滚只能覆盖更新失败分支，不解决“更新成功后想恢复旧版本”的需求。

验证级别：UI → API → Rust 错误分支与清理路径的源码确认；未在用户目录或本地 Rust 可执行程序上注入权限故障。最终 SkillsMcpView 35 个前端测试通过，其中新增确认/失败重试用例仍 mock updateSkill，无法检验备份真正存在。

修复方向：在承诺自动备份的更新流程中，持久备份失败应中止覆盖；或改为明确的无备份风险二次授权并保留可恢复旧目录。增加备份失败但 swap 可写的临时目录后端回归测试。

## 已核对但不等于全面通过

- 深链：App 以 pending id 保持确认队列，导入成功后递增刷新版本；DeepLinkImportDialog 的 importedRef 防止确认/缓存刷新失败导致重复导入。PromptsView、SkillsMcpView、ToolView 接到了刷新版本。配置 URL 当前后端不支持，不据此臆测远程重复取数问题。
- 提示词：Codex 与非 Codex 路径分开；Markdown/深链禁用导入不走非 Codex upsert 的清空路径；非 Codex 写入有显式风险确认。
- 资源导出：检查到 env、headers、http_headers 值被替换，页面有地址、参数、备注分享前检查提示。没有据此声称所有任意嵌套字段或用户文本均已脱敏；未做真实 WebView 下载兼容性验证。
- 工具身份：ToolView 元数据将 Claude Code/Desktop、Grok Build 等分开；Desktop UI 明确区分安装探测、3P 配置及登录状态。主壳原生保存使用 editorAppId，删除显式传入 appId。A-01 是打开请求竞态，不是已证实的后端跨工具写入。
- 安装误报：AboutSection 生命周期操作返回后重读工具版本；不可运行、更新版本不变且仍落后都有失败/警告路径。相应现有测试通过。没有执行真实安装，也未覆盖所有 Windows/MSIX/WSL 与上游安装器行为。
- 设置：PreferencesPatch 后端使用 mutate_settings；当前 ConfigDirectoriesPanel 已改用 patchConfigDirectory，后端只修改指定目录字段，不重放整份设置对象。新云同步入口已读到，接入 SyncPanel；确认后调用 WebDAV/S3 手动 API、导入审核与刷新，没有在此次审查中进行网络同步。

## 测试结果与不足

所有命令均为 `pnpm exec vitest run ... --maxWorkers=2`，没有新增或修改测试。

| 批次 | 文件 | 结果 |
| --- | --- | --- |
| 1 | PromptsView、SkillsMcpView、UsageView、SessionManagerPage、App.deeplink、ChimeraApp.races、ToolView、ToolView.support、App.connectedRoutes | 9 文件：8 通过、1 失败；178 测试通过、13 失败 |
| 2 | AboutSection.tools、ConfigDirectoriesPanel、AdvancedConnectionPanels、ImportPanel、DatabaseRecoveryPanel、lib/prompts、lib/productCapabilities | 7 文件全部通过；71 测试通过 |
| 3 | 新 SyncPanel、SkillsMcpView、ConfigDirectoriesPanel | 3 文件全部通过；60 测试通过 |
| 4 | 最终更新确认入口落地后的 SkillsMcpView | 1 文件通过；35 测试通过 |

批次 1 的 13 个失败全部在 `ChimeraApp.races.test.tsx`，错误集中于找不到工具导航按钮。源码可确认夹具不匹配：该文件 `settingsApi.get` mock 返回 `{}`（约第 68 行），当前 `isProductToolVisible` 要求 `visibleApps[appId] === true`，所以工具被隐藏；只启用 multi_tool capability 不足以打开导航。这些失败不能直接计作产品缺陷，也意味着这组真实工具编辑器身份/竞态用例本次没有有效走到目标操作。未修改夹具来“跑绿”。

测试日志暂存在系统临时目录 `chimera-independent-A-tests.log`、`chimera-independent-A-extra.log`、`chimera-independent-A-final.log`、`chimera-independent-A-skills-final.log`，本报告已记录高信号结果。测试产生 localStorage ExperimentalWarning；未把该警告当成业务失败。

优先补测：A-01 的延迟打开与草稿保护；A-02 的同路径消息刷新/导出；A-03 的文件写失败一致性；A-04 的可见文案、请求时间窗口与完整范围标题；A-05 的持久备份失败与更新成功清理组合。同时修复主壳测试 visibleApps 夹具，恢复对真实工具路线的覆盖。

未执行：完整前端测试集、TypeScript 全项目检查、Rust 编译/测试、桌面端安装/权限故障注入、云存储真实上传下载、真实导出文件打开验证。本报告的通过结果不能替代这些验证。

## 并行变更边界

- 最后读取时 NewSettingsView 已出现手动 WebDAV/S3 入口；SyncPanel 与目录 atomic patch 已纳入有限源码复核和批次 3 测试。
- 收尾捕获了 20:52:22 的 SkillsMcpView 新更新确认入口，并补跑批次 4。确认 action 调用 updateSkill，成功移除对应更新条目，再经 run/reload 重读资源。后端 select_update_source 按保存的仓库文档路径选择；缺少原路径时仅允许唯一名称匹配，精确 source 解析不再随意取同名目录。该源码复核仍不替代 Rust 回归测试；本次额外确认了 A-05 的备份承诺不一致，故不对最终更新组合行为作无缺陷结论。
- 报告只覆盖此次读取的工作树状态；之后的并行修改可能改变行号与结论，需按上述函数和行为复核。