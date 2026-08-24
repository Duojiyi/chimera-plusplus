# 2026-08-25 上游同步 + 修复 双盲审计报告

> 审计范围：本轮“上游同步 + 修复”全部变更（相对 `origin/main` `371778b0` / v2.6.3）。
> 独立复核，结论均可代码复现。不发版（版本号保持不变）。

## 一、结论

| 维度 | 结论 |
|---|---|
| 变更范围 | 12 个文件 + 本审计文档，无夹带；版本号未提升 |
| P0 权限修复 | 命中根因，一行声明，权限名在 schema 中有效 |
| P1 皮肤目录死锁 | 同 v2.6.3 修复 2 根因，切换正确，异步边界正确 |
| P2 TeamoRouter 域名 | 主域切 `.cn`，支持 `endpointCandidates` 的 4 文件保留 `.com` fallback，其余直接切换 |
| 上游处置 | CC Switch 2 项合并（1 项不适用）、CodexPlusPlus 不合并、Codex App Manager 无功能漂移不合并 |
| 验证 | cargo check / fmt / test 全绿；tsc 通过；prettier（7 preset）通过 |
| 既有问题 | 前端 `machine-state.test.ts` 8 项失败为 HEAD 既有，与本轮无关（已用 stash 基线复现证明） |

## 二、P0 —— 退出按钮权限缺失（`process:allow-exit`）

**根因链**：`src-tauri/capabilities/default.json` 只授予 `process:allow-restart`，缺 `process:allow-exit`。
前端两处调用 `exit()`：
- `src/main.tsx:81` —— 配置加载失败 `await exit(1)`；
- `src/components/DatabaseUpgrade.tsx:292` —— 库版本过新恢复屏“退出”按钮 `void exit(0)`。

二者均 `import { exit } from "@tauri-apps/plugin-process"`（`package.json` 依赖 `@tauri-apps/plugin-process ^2.3.1`）。
未授权时该 IPC 被 Tauri 静默拒绝，`void`/`await` 吞掉 rejection → **恢复屏退出按钮实际无效**。

**对齐上游**：`farion1231/cc-switch` commit `4549d290`（`fix(capabilities): grant process:allow-exit so exit buttons can quit the app`）。

**变更**：`default.json` 权限列表追加一行 `"process:allow-exit"`。

**证据**：
- 权限名有效：`src-tauri/gen/schemas/desktop-schema.json`（`default.json` 的 `$schema` 指向它）含 `"const": "process:allow-exit"`（char offset 约 132217），描述 `Enables the exit command...`。
- 未扩大安全面：仅授权 `exit` 命令，与既有 `process:allow-restart` 同级、同来源插件。

## 三、P1 —— 皮肤目录进程外 curl 死锁残留

**根因**：`skin_catalog.rs` 的 `fetch_catalog()` 仍调用 `codex_win_engine::fetch_text(CATALOG_URL)`（进程外 curl），
即 v2.6.3 修复 2 注释点名要取代的 helper——先等进程退出再读 stdout，Windows 匿名管道缓冲约 4KB，
大响应会背压死锁。皮肤目录 `index.json` 当前较小、触发概率低，属同类技术债。

**对齐**：v2.6.3 修复 2 的模式（`codex_runtime.rs` 的 `fetch_mirror_text`：应用内 reqwest、20s 超时、8MB 上限、标准 UA）。

**变更**：
- 新增 `fetch_catalog_text()`：经 `crate::proxy::http_client::get()`（跟随全局代理）、`USER_AGENT=chimera-plus-plus`、
  20s 超时、8MB 上限、非 2xx 附有限错误体、UTF-8 校验。
- `fetch_catalog()` 提为 `async`（`await fetch_catalog_text()` + `parse_catalog`）。
- `list_skin_catalog` / `install_catalog_skin` 改为**先 await 抓目录，再 `spawn_blocking` 做本地工作**
  （枚举主题 / 加锁 / 下载 / 校验 / 导入），避免在阻塞线程中做网络 I/O。

**证据**：
- grep 确认 `skin_catalog.rs` 中已无 `codex_win_engine::fetch_text` 调用（仅剩 doc 注释文字）。
- 异步边界正确：网络在 `await` 中、`list_themes` / `OperationLock` / 下载在 `spawn_blocking` 中。
- `reqwest` 为 crate 既有依赖（`codex_runtime.rs` 已在用 `reqwest::header::USER_AGENT`）；`Duration` 已导入。

## 四、P2 —— TeamoRouter 域名迁移（`.com` → `.cn`）

**对齐上游**：`farion1231/cc-switch` commit `9a596158`
（`chore(presets): move TeamoRouter to teamorouter.cn, keep .com as fallback`）。

**适配差异（与上游不同，有意为之）**：上游把 `apiKeyUrl` 改成数组；本仓库各 preset 的
`apiKeyUrl` 类型仍是 `string`（`apiKeyUrl?: string`），故未照搬数组化，改为——
- 支持 `endpointCandidates` 的 4 个文件：主域切 `.cn`、API 切 `api.teamorouter.cn`，`.com` 保留为 fallback 末位；
- 其余 3 个无 `endpointCandidates` 字段的文件：直接切 `.cn`；
- 本仓库无 `piProviderPresets.ts`，跳过上游 Pi 部分。

**变更文件（7 preset + 3 README）**：

| 文件 | 主域 | base URL | fallback |
|---|---|---|---|
| `claudeProviderPresets.ts` | `.cn` | `api.teamorouter.cn` | `endpointCandidates` 加 `.cn`/`.com` |
| `claudeDesktopProviderPresets.ts` | `.cn` | `api.teamorouter.cn` | 同上 |
| `codexProviderPresets.ts` | `.cn` | `api.teamorouter.cn/v1` | 同上 |
| `grokBuildProviderPresets.ts` | `.cn` | `api.teamorouter.cn/v1` | 同上 |
| `hermesProviderPresets.ts` | `.cn` | `api.teamorouter.cn/v1` | 无（无该字段） |
| `openclawProviderPresets.ts` | `.cn` | `api.teamorouter.cn/v1` | 无 |
| `opencodeProviderPresets.ts` | `.cn` | `api.teamorouter.cn/v1` | 无 |
| `README_ZH/JA/DE.md` | sponsor 链接 `.com`→`.cn`（banner + 注册链接各 2 处） | — | — |

**证据**：
- grep 残留：`src/config/*.ts` 中 `teamorouter.com` 仅剩 4 处，且均为 `endpointCandidates` 内的 `.com` fallback；
  README 各文件 0 残留。
- 类型有效：`claude`/`claudeDesktop`/`codex`/`grokBuild` 均声明 `endpointCandidates?: string[]`。
- 上游夹带的 `gpt-5.5`→`gpt-5.6-sol` 模型号更新未纳入（本仓库 TeamoRouter 模型条目保持既有 `gpt-5.5`，
  域名迁移与模型号无关，避免混入未验证的模型改动）。

## 五、上游参考项目处置（本次审计范围之外，仅记录）

| 上游 | 版本/提交 | 处置 |
|---|---|---|
| CC Switch | `4549d290`（allow-exit） | **合并** → P0 |
| CC Switch | `9a596158`（TeamoRouter `.cn`） | **合并（适配）** → P2 |
| CC Switch | `5ca9459d`（Pi 用量去重索引） | **不适用**（本仓库无 Pi 管道） |
| CodexPlusPlus | `v1.2.51`、`v1.2.52` | **不合并**（注入/CDP/远程控制/管理器产品面，违反既定吸收政策） |
| Codex App Manager | v0.5.2 后仅 dev-deps/lock 提交 | **不合并**（引擎无功能漂移，固定 rev `d29fda32` 仍最优） |

## 六、验证证据（可复现）

```text
# Rust
cargo check --workspace --all-targets     → exit 0
cargo fmt --check                          → exit 0
cargo test --workspace --all-targets       → exit 0（全绿）

# 前端
pnpm typecheck                             → exit 0（tsc --noEmit 无错误）
pnpm exec prettier --check <7 preset 文件>  → All matched files use Prettier code style!

# 既有问题非回归证明
pnpm test:unit → tests/integration/machine-state.test.ts 8 项失败
   在 `git stash`（仅暂存本轮 12 文件）后的干净基线 + 仅跑该文件下仍复现同样 8 项失败，
   确认与本轮改动无关（仓库 HEAD 既有问题）。
```

## 七、边界与后续

- 本轮提交只含 12 个文件 + 本审计文档；`src-tauri/Cargo.toml`（行尾伪改动，文本 diff 为空）、
  `src/ChimeraApp.tsx`、`src/chimera.css`（用户既有功能改动）及未跟踪目录均未纳入。
- 版本号未提升（不发版），CHANGELOG 未新增条目，记录以本文档为准。
- `machine-state.test.ts` 的 8 项失败为独立既有缺陷，建议另开任务修复，不在本轮范围。
