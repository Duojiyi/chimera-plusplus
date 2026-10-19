# 2026-10-19 全站液态玻璃样式审计

## 当前状态

全站样式实现、前端构建、最终 107 项关键回归及浏览器材料验证已通过。两位互不交流的审计者均已完成最终复核，已知样式发现均关闭，未发现剩余可行动样式问题。dev 编译暴露的前序私有模块引用问题已做最小修复并通过独立增量复核。2026-10-19 22:39 dev 重新编译成功，新窗口已实际启动、可见、未最小化且正在响应，保留运行供用户预览。

## 范围与实现边界

- 本轮新增 `src/theme/liquid-glass.css`、`src/components/ui/liquid-glass-ui.css`、`src/theme/liquid-glass-pages.css`，统一从 `src/main.tsx` 最后导入。
- 覆盖侧栏与选中态、顶部工具栏、全局搜索、线路信息牌、卡片、表单、分段导航、按钮、弹窗、菜单、下拉、浮层、提示及确认框。
- 13 个通用 UI primitive 增加语义样式 hooks，不改变原有事件、Radix 状态、键盘处理、ref 或业务 API。
- 页面层覆盖线路与编辑器、官方账号、提示词、Skills/MCP、用量、Codex 管理、外观、配置体检、其他工具、会话、设置及相关引导/导入状态。
- 采用静态透光渐变、边缘高光、内阴影、局部 backdrop blur；避免逐帧指针跟随、全屏滤镜及新增持续动画。
- 表格、代码编辑器和长文本仍保留稳定阅读底色，不为增加透明度而牺牲信息可读性。
- 同时提供明暗主题、减少透明度、减少动画、高对比度及不支持 backdrop-filter 时的回退。Portal 使用根级材质变量，避免脱离 shell 后失去主题。
- 工作区中此前的 Codex 配置事务修复及其他既有文件保留。本报告不把这些业务变更算成本轮样式修改。

## 独立审计方式

两位审计者使用同一工作区进行互不交流的只读审查，不互传报告，不修改源码。主线程统一整合发现、实施修复、执行验证；审计者再分别复核。这里的“双盲审计”指两份独立审查，并非严格实验设计中的双盲或绝对无缺陷证明。

| 审计者 | 主要复核面 | 最终状态 |
| --- | --- | --- |
| A / Hooke | primitive 接入、导航、可访问性、forced-colors | 两项 P2 复核关闭，独立 53/53 测试通过，四张高对比度导航图复核通过，无新增阻塞 |
| B / Mill | 全站页面覆盖、懒加载级联、生产 CSS、用量及提示词 | 当前源码及最新生产产物未发现剩余可行动问题 |

## 发现与修复

| 发现 | 修复与验证 |
| --- | --- |
| 主操作和激活控件的渐变亮端可能降低白色文字对比 | 调整主色渐变，浏览器计算的所测最小对比分别为浅色 4.558、深色 4.629 |
| shadow token 组合及非 blur 环境可能出现失效材质 | 统一完整阴影值，提供稳定底色与显式透明度/滤镜回退 |
| 通用 ghost hover 可能覆盖危险操作文字语义 | 保留调用方 destructive 语义，真实浏览器验证明暗主题 hover 颜色 |
| 未勾选 checkbox/switch 边界不足 | 增强控件边界，所测边界对比最小 3.257 |
| 普通导航与能力树导航的旧 hover / 伪元素规则竞争 | 使用语义 selected hooks 和定向规则，保留原树轨道避让及点击区域 |
| 用量高级 tab 保留 primitive 蓝色渐变 | 页面规则显式清除 `background-image`；所测激活文字对比浅色 5.813、深色 6.024 |
| 提示词页面懒加载 CSS 可能覆盖透明画布 | canvas 规则增加 `.chimera-shell` 祖先优先级，核对懒加载和生产 CSS |
| 打包后基础 CSS 可能排在材质层之后 | 仅将三份 glass CSS 分组为 `liquid-glass`，确认生产 HTML 先 base 后 glass，保持原有包体预算 |
| forced-colors 普通选中导航出现白底白字 | 明确系统 `Highlight` / `HighlightText` 配对，并对选中导航使用 `forced-color-adjust: none` |
| forced-colors 选中导航焦点不明显 | 普通导航和能力树伪元素增加 `2px HighlightText` 内圈；真实浏览器检查焦点、颜色和尺寸 |

上述浏览器对比值仅针对记录中的控件及状态，不代表对所有文本和所有外观完成了 WCAG 合规认证。

## 验证结果

- `pnpm typecheck`：通过。
- `pnpm build:renderer:check`：通过，包含 Vite 生产打包与原包体预算检查。
- 变更前端文件的 `prettier --check`：通过。
- `git diff --check`：通过；Git 提示既有 snapshot 的 LF/CRLF 转换，不影响检查结果。
- 最终关键回归：4 个文件、107 个测试全部通过，单 worker、排除 `.qa/**` 备份测试。
- `LiquidGlassPrimitives.test.tsx`：53 项，覆盖通用控件、事件/ref、主题、媒体回退及样式保护。
- `ChimeraApp.characterization.test.tsx`：19 项；`ChimeraShell.snapshot.test.tsx`：1 项；`SessionManagerPage.test.tsx`：34 项。
- 另一次十文件复跑中有 9 文件通过，3 个会话测试超时；会话文件随后在最终 107 项运行中 34/34 通过。
- 未声称“一次全量全部通过”：早先全量存在资源竞争超时与预期样式快照差异，后续按文件复跑。更新的 5 处快照已核对为样式 hooks，不是业务结构改变。CSS selector 换行导致的保护测试误报也已通过空白归一化修正。

### 浏览器与视觉证据

- 初始矩阵：23 个页面入口及状态、304 张截图，涵盖 populated / empty / error 场景。
- 最终常规主题复拍：22 个页面入口、88 张截图，浅/深主题及 `1140×816` / `960×640` 两种窗口。
- 最终截图集：consoleErrors、pageErrors、unhandled、步骤失败与 sanity 检查均为 0。
- 非零 failed IPC 是夹具中的已知场景，例如版本未开放 `thread_usage`、不存在 Gemini `.env`，不表示样式引发的新 IPC 错误。
- 截图使用 `.qa/mock/` 合成夹具，不接触真实账号或密钥。人工抽查线路、提示词、用量、设置、会话、工具、外观、命令面板与确认弹窗，未声称逐张人工审查所有 304 张。
- 最新材料脚本额外验证主操作对比、未选中边界、ghost 语义、减少透明度、Portal、forced-colors，以及真实 Claude Code / 线路选中导航焦点。
- 常规主题最终截图早于最后的 forced-colors 补丁；该补丁只作用于对应 media，最新专项检查与生产构建已包含它。

证据（工作区本地 `.qa/`，不作为需提交的构建产物）：

- [最终 107 项结果](../../.qa/screens/liquid-glass/final-focused-results.json)
- [最终关键测试日志](../../.qa/screens/liquid-glass/final-focused-test.log)
- [类型检查](../../.qa/screens/liquid-glass/final-typecheck.log)
- [生产构建与预算](../../.qa/screens/liquid-glass/renderer-build-final.log)
- [浏览器材料验证](../../.qa/screens/liquid-glass/material-checks.json)
- [最终 88 张截图索引](../../.qa/screens/liquid-glass-release/index.md)
- [初始状态矩阵](../../.qa/screens/liquid-glass/index.json)

## Dev 编译发现的既有模块路径问题

首次重新编译失败于五处 `E0603: module dao is private`，来源是此前配置事务修复中对 `ProviderUpdateSelection` 的跨模块引用，并非 glass CSS 导致。没有将 `dao` 改成公开模块，而是沿项目已有数据库边界处理：

- `database/mod.rs` 增加 `pub(crate) use dao::providers::ProviderUpdateSelection`。
- `commands/provider.rs` 四处类型路径改为 `crate::database::ProviderUpdateSelection`。
- `services/proxy.rs` 改为经 `crate::database` 引用该类型。
- `codex_config.rs` 移除唯一未使用的 `write_json_file` import。

修改前四文件完整备份在 `.qa/liquid-glass-backups/20261019-223355-dev-build-exports/`，并原子替换源文件。定向 `rustfmt --check --edition 2021 --config skip_children=true` 及差异检查通过。审计 B 与备份完整对比，确认只有导出、引用路径和 import 变化，没有事务、补偿、锁、分支或 I/O 调用变化，无可行动发现。修复后的 dev 编译已成功，实际产物和窗口验收见下节。

## Dev 预览

- 用户本轮明确要求重新编译 dev，因此执行 `pnpm dev`，包括 Tauri/Rust dev 编译，不执行额外 Rust 测试或 clippy。
- 使用已验证的 MSVC / Windows SDK 环境，复用 `D:\cargo-target\chimera`；未清理、移动或删除现有 Rust 产物和缓存。
- 新一轮启动目录：`.qa/dev-run/20261019-222854-liquid-glass/`，含脚本、stdout、stderr、元数据和临时目录。
- 临时文件指向本轮 D 盘目录；启动前确认 3000 端口空闲且无其他 cargo/rustc/app 实例。
- 只停止了核对命令行属于本项目 `.qa/vite.config.ts` 的截图 harness（PID 16776 / 端口 3100）。未停止其他项目进程。
- Rust dev 编译成功：日志为 `Finished dev profile [unoptimized + debuginfo] target(s) in 5m 19s`，随后运行新二进制。仍有 5 条非阻塞 `dead_code` 警告，未发现新的启动错误。
- 新二进制：`D:\cargo-target\chimera\debug\chimera-plus-plus.exe`，最后写入时间 2026-10-19 22:39:14，大小 80,321,536 bytes。
- 窗口验收：2026-10-19 22:39:19，新进程 PID 8652（22:39:16 启动），窗口句柄 5243760；系统检查 `windowVisible=true`、`windowMinimized=false`，后续检查 `Responding=true`。
- 前端服务 `http://localhost:3000/` 返回 HTTP 200，入口 `/main.tsx` 及三份新增样式均已确认可加载；保留 dev 服务及新窗口运行供预览。
- 证据：[窗口验收记录](../../.qa/dev-run/20261019-222854-liquid-glass/window-verification.json)、[启动日志](../../.qa/dev-run/20261019-222854-liquid-glass/dev.stdout.log)、[编译日志](../../.qa/dev-run/20261019-222854-liquid-glass/dev.stderr.log)。编译日志保留此前失败段，最终一轮为成功。

## 局限

独立审查和自动验证未发现剩余已知样式回归，不等于证明所有硬件、Windows 高对比度配色、屏幕缩放、WebView 版本和所有业务状态均无问题。浏览器材料检查使用 Edge；未逐页完成真实 WebView 的所有错误状态和高对比度验收，未进行定量 GPU / 长时间滚动性能测试。Rust 后端测试未在本轮单独执行。