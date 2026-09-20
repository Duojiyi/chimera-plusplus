# Contributing to Chimera++

> [中文版本](#贡献指南)

Thank you for your interest in contributing to Chimera++! Please read our [Code of Conduct](./CODE_OF_CONDUCT.md) before participating.

## How to Contribute

There are many ways to contribute:

- **Report bugs** — Found something broken? [Open a bug report](https://github.com/Duojiyi/chimera-plusplus/issues/new?template=bug_report.yml).
- **Suggest features** — Have an idea? [Submit a feature request](https://github.com/Duojiyi/chimera-plusplus/issues/new?template=feature_request.yml).
- **Improve docs** — Spot a typo or missing info? [Report a doc issue](https://github.com/Duojiyi/chimera-plusplus/issues/new?template=doc_issue.yml).
- **Contribute code** — Fix bugs or implement features via pull requests.
- **Translate** — Help us improve translations for English, Chinese, and Japanese.

> **Security vulnerabilities**: Please do NOT use public issues. See our [Security Policy](./SECURITY.md) instead.

## Development Setup

### Prerequisites

- Node.js 20.19.x (20.19.0 in [.node-version](.node-version)); Node.js 22.12 or newer also satisfies the current Vite requirement
- pnpm 10+ (CI uses Node 20 and pnpm 10.12.3)
- Rust 1.95 and Cargo, pinned by [rust-toolchain.toml](rust-toolchain.toml) and required by [Cargo.toml](src-tauri/Cargo.toml)
- [Tauri 2 prerequisites](https://v2.tauri.app/start/prerequisites/) for your operating system; complete Codex runtime maintenance requires Windows

Follow [AGENTS.md](AGENTS.md). Coding agents must not run commands that compile Rust without an explicit user request, or delete existing Rust artifacts or caches without permission.

### Quick Start

```bash
pnpm install
pnpm dev:renderer
```

The renderer preview does not provide Tauri native commands. Validate configuration writes, tray behavior and runtime maintenance in the desktop app when Rust compilation is explicitly requested.

### Useful Commands

| Command                     | Description                                                 |
| --------------------------- | ----------------------------------------------------------- |
| `pnpm dev:renderer`         | Browser renderer preview; no Rust compilation               |
| `pnpm build:renderer:check` | Renderer build and bundle-budget check; no Rust compilation |
| `pnpm typecheck`            | TypeScript type checking                                    |
| `pnpm test:unit`            | Frontend unit and integration tests                         |
| `pnpm format`               | Format frontend code with Prettier                          |
| `pnpm format:check`         | Check frontend code formatting                              |
| `pnpm dev`                  | Desktop development with hot reload; compiles Rust          |
| `pnpm build`                | Desktop production build; compiles Rust                     |

Rust format checking does not compile code:

```bash
cargo fmt --check --manifest-path src-tauri/Cargo.toml
```

## Code Style

- **Frontend**: Prettier for formatting, strict TypeScript (`pnpm typecheck`). There is no ESLint setup in this repository.
- **Backend**: `cargo fmt` for formatting, `cargo clippy` for linting
- **Tauri IPC**: Keep Rust command names in `snake_case` and JavaScript argument keys in `camelCase`, matching the existing `invoke` wrappers.

Run checks appropriate to the change and state which checks were not run. The default frontend checks do not compile Rust:

```bash
pnpm typecheck && pnpm format:check && pnpm test:unit
pnpm build:renderer:check
```

CI runs Rust validation. For coding agents, the following local checks require an explicit user request because they compile Rust. CI denies Clippy warnings:

```bash
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

## Pull Request Guidelines

1. **Open an issue first** for new features — PRs for features that are not a good fit may be closed.
2. **Fork and branch** — Create a feature branch from `main` (e.g., `feat/my-feature` or `fix/issue-123`).
3. **Keep PRs focused** — One feature or fix per PR. Avoid unrelated changes.
4. **Follow the PR template** — Fill in the summary, related issue, and checklist.

### PR Checklist

- [ ] `pnpm typecheck` passes
- [ ] `pnpm format:check` passes
- [ ] Relevant frontend tests pass
- [ ] Rust format check passes if Rust code changed; CI or explicitly requested local Clippy/tests are reported separately
- [ ] Unrun checks and untested platforms are documented
- [ ] Localized text changes update i18n files; Chinese-only shell changes follow the exception below

### Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/):

```
feat(provider): add support for new provider
fix(tray): resolve menu not updating after switch
docs(readme): update installation instructions
ci: add format check workflow
chore(deps): update dependencies
```

## AI-Assisted Contributions

We welcome AI-assisted contributions, but **the responsibility stays with you**. AI tools lower the cost of writing code — they do not lower the cost of reviewing it. Maintainers are not obligated to clean up AI-generated output.

By submitting a PR, you agree to the following:

1. **You have read and understood your code.** You must be able to explain any line in your PR. If you cannot, it is not ready for review.
2. **You have tested it yourself.** Every change must be verified locally — not just "it looks right." Do not submit code for platforms or features you cannot test.
3. **PRs must be small and focused.** One issue, one PR. Large, sprawling, multi-topic PRs will be closed.
4. **Open an issue first.** Drive-by PRs with no prior discussion — especially AI-generated ones — may be closed without review.
5. **Maintainers may close without explanation.** PRs that appear to be unreviewed AI output — hallucinated fixes, unnecessary refactors, bulk changes with no context — may be closed at the maintainer's discretion.

**In short**: AI is a tool, not a substitute for understanding. Use it to help you contribute better, not to shift work onto maintainers.

## Internationalization (i18n)

Four locales ship, as flat files under `src/i18n/locales/`. When modifying user-facing text in a
localized component:

1. Update **all four** locale files:
   - `src/i18n/locales/en.json`
   - `src/i18n/locales/zh.json`
   - `src/i18n/locales/ja.json`
   - `src/i18n/locales/zh-TW.json`
2. Use the `t()` function from i18next for all UI text.
3. Never hardcode user-facing strings.

One deliberate exception: the Chimera v2 shell (`src/ChimeraApp.tsx` and its views) is Chinese-only
and writes its strings inline, because Chinese is the primary product language. Localized upstream
components mounted inside it — the session manager, for one — keep using `t()`. Follow whichever
convention the file you are editing already uses.

## Questions?

- [Open a question](https://github.com/Duojiyi/chimera-plusplus/issues/new?template=question.yml)
- [GitHub Discussions](https://github.com/Duojiyi/chimera-plusplus/discussions)

---

# 贡献指南

> [English Version](#contributing-to-chimera)

感谢你对 Chimera++ 的贡献兴趣！参与之前请阅读我们的[行为准则](./CODE_OF_CONDUCT.md)。

## 如何贡献

你可以通过多种方式参与贡献：

- **报告 Bug** — 发现问题？[提交 Bug 报告](https://github.com/Duojiyi/chimera-plusplus/issues/new?template=bug_report.yml)。
- **建议功能** — 有想法？[提交功能请求](https://github.com/Duojiyi/chimera-plusplus/issues/new?template=feature_request.yml)。
- **改进文档** — 发现错误或缺失？[报告文档问题](https://github.com/Duojiyi/chimera-plusplus/issues/new?template=doc_issue.yml)。
- **贡献代码** — 通过 Pull Request 修复 Bug 或实现新功能。
- **翻译** — 帮助改进英文、中文和日文的翻译。

> **安全漏洞**：请不要使用公开 Issue 报告。请参阅我们的[安全策略](./SECURITY.md)。

## 开发环境搭建

### 前提条件

- Node.js 20.19.x（[.node-version](.node-version) 指定 20.19.0）；Node.js 22.12 或更新版本也满足当前 Vite 要求
- pnpm 10+（CI 使用 Node 20 与 pnpm 10.12.3）
- Rust 1.95 和 Cargo，由 [rust-toolchain.toml](rust-toolchain.toml) 固定，[Cargo.toml](src-tauri/Cargo.toml) 要求的最低版本同为 1.95
- 对应操作系统的 [Tauri 2 开发依赖](https://v2.tauri.app/start/prerequisites/)；完整 Codex 运行时维护功能需要 Windows

遵循 [AGENTS.md](AGENTS.md)：编码代理只有在用户明确要求时，才能运行会编译 Rust 的命令；未经许可不得删除已有 Rust 构建产物或缓存。

### 快速开始

```bash
pnpm install
pnpm dev:renderer
```

浏览器预览不提供 Tauri 原生命令。配置写入、托盘行为和运行时维护需要在明确要求 Rust 编译后，通过桌面应用验证。

### 常用命令

| 命令                        | 说明                                  |
| --------------------------- | ------------------------------------- |
| `pnpm dev:renderer`         | 浏览器预览前端，不编译 Rust           |
| `pnpm build:renderer:check` | 前端生产构建与包体积检查，不编译 Rust |
| `pnpm typecheck`            | TypeScript 类型检查                   |
| `pnpm test:unit`            | 前端单元与集成测试                    |
| `pnpm format`               | 使用 Prettier 格式化前端代码          |
| `pnpm format:check`         | 检查前端代码格式                      |
| `pnpm dev`                  | 桌面应用热重载开发，会编译 Rust       |
| `pnpm build`                | 桌面应用生产构建，会编译 Rust         |

Rust 格式检查不编译代码：

```bash
cargo fmt --check --manifest-path src-tauri/Cargo.toml
```

## 代码规范

- **前端**：使用 Prettier 格式化、严格 TypeScript（`pnpm typecheck`）。本仓库没有配置 ESLint。
- **后端**：使用 `cargo fmt` 格式化、`cargo clippy` 检查
- **Tauri IPC**：Rust 命令名使用 `snake_case`，JavaScript 参数键使用 `camelCase`，与现有 `invoke` 封装保持一致。

按改动范围运行检查，并注明未执行的项目。默认前端检查不编译 Rust：

```bash
pnpm typecheck && pnpm format:check && pnpm test:unit
pnpm build:renderer:check
```

Rust 验证由 CI 执行。编码代理在本地运行以下检查前，必须得到用户的明确要求，因为这些命令会编译 Rust。CI 会把 Clippy 警告视为错误：

```bash
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

## Pull Request 指南

1. **先开 Issue 讨论** — 新功能请先开 Issue，不适合项目方向的 PR 可能会被关闭。
2. **Fork 并创建分支** — 从 `main` 创建功能分支（如 `feat/my-feature` 或 `fix/issue-123`）。
3. **保持 PR 专注** — 每个 PR 只做一件事，避免无关改动。
4. **遵循 PR 模板** — 填写概述、关联 Issue 和检查清单。

### PR 检查清单

- [ ] `pnpm typecheck` 通过
- [ ] `pnpm format:check` 通过
- [ ] 相关前端测试通过
- [ ] 如修改了 Rust 代码，格式检查通过；另行注明 CI 或用户明确要求的本地 Clippy、测试结果
- [ ] 已说明未执行的检查和未验证的平台
- [ ] 已国际化的文本同步更新语言文件；纯中文外壳遵循下文的例外约定

### 提交信息规范

我们使用 [Conventional Commits](https://www.conventionalcommits.org/)：

```
feat(provider): add support for new provider
fix(tray): resolve menu not updating after switch
docs(readme): update installation instructions
ci: add format check workflow
chore(deps): update dependencies
```

## AI 辅助贡献

我们欢迎 AI 辅助的贡献，但**责任始终在你身上**。AI 工具降低了写代码的成本，但并没有降低 review 的成本。维护者没有义务替你清理 AI 的产出。

提交 PR 即表示你同意以下规则：

1. **你已阅读并理解了你的代码。** 你必须能解释 PR 中的每一行。如果做不到，说明还没准备好提交 review。
2. **你已亲自测试过。** 每个改动都必须在本地验证——而不是"看起来对"。不要提交你自己无法测试的平台或功能的代码。
3. **PR 必须小而聚焦。** 一个 Issue 对应一个 PR。大而散、跨多个主题的 PR 会被直接关闭。
4. **先开 Issue 讨论。** 没有事先讨论的"路过式 PR"——尤其是 AI 生成的——可能会被直接关闭。
5. **维护者可以直接关闭。** 看起来是未经审阅的 AI 产出的 PR——虚构的修复、不必要的重构、缺乏上下文的批量改动——维护者可自行决定关闭。

**一句话总结**：AI 是工具，不是理解力的替代品。用它来帮助你更好地贡献，而不是把工作转移给维护者。

## 国际化（i18n）

共有四种语言，以扁平文件形式存放在 `src/i18n/locales/` 下。修改已国际化组件中的用户可见文本时：

1. **同时更新四个**语言文件：
   - `src/i18n/locales/en.json`
   - `src/i18n/locales/zh.json`
   - `src/i18n/locales/ja.json`
   - `src/i18n/locales/zh-TW.json`
2. 所有 UI 文本使用 i18next 的 `t()` 函数。
3. 不要硬编码用户可见的字符串。

有一处刻意的例外：Chimera v2 外壳（`src/ChimeraApp.tsx` 及其视图）只用中文，字符串直接内联，因为中文是本产品的主要语言。挂载在其中的上游国际化组件（例如会话管理）仍使用 `t()`。请沿用你正在修改的文件已有的约定。

## 有疑问？

- [提问](https://github.com/Duojiyi/chimera-plusplus/issues/new?template=question.yml)
- [GitHub 讨论区](https://github.com/Duojiyi/chimera-plusplus/discussions)
