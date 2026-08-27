<div align="center">

<img src="src-tauri/icons/icon.png" width="112" alt="Chimera++" />

# Chimera++

Codex 线路切换与桌面运行时管理工具

[![Latest Release](https://img.shields.io/github/v/release/Duojiyi/chimera-codex?label=release)](https://github.com/Duojiyi/chimera-codex/releases/latest)
[![CI](https://github.com/Duojiyi/chimera-codex/actions/workflows/ci.yml/badge.svg)](https://github.com/Duojiyi/chimera-codex/actions/workflows/ci.yml)
[![Platform](https://img.shields.io/badge/platform-Windows%20%7C%20macOS-555)](#平台支持)
[![Built with Tauri](https://img.shields.io/badge/Tauri-2-24C8DB)](https://tauri.app/)

[下载最新版](https://github.com/Duojiyi/chimera-codex/releases/latest) · [提交问题](https://github.com/Duojiyi/chimera-codex/issues) · [开发说明](#本地开发)

</div>

Chimera++ 用于管理 Codex 的供应商配置、模型和本机运行时。它把 API 地址、密钥、模型、官方账户和 Codex 安装维护集中在一个桌面界面中，避免手动修改 `auth.json` 与 `config.toml`。

## 主要功能

- **线路管理**：添加、编辑、测试和切换 Codex 线路，支持 OpenAI Responses、OpenAI Chat 和 Anthropic 兼容接口。
- **官方账户保护**：切换第三方线路时默认保留 ChatGPT OAuth 登录；切回官方线路时移除 API 登录状态并继续使用有效的官方令牌。
- **可靠重启**：线路切换后可直接重启 Codex。Chimera++ 会锁定运行时操作、关闭检测到的 Codex 安装并确认进程退出后再启动。
- **Codex 运行时**：检测标准版或绿色版安装，查看版本，并执行安装、更新、修复、回滚和卸载。
- **模型目录**：同步可用模型并更新 Codex 桌面端模型列表。
- **词元统计**：查看请求、词元消耗、模型分布和历史记录。
- **外观管理**：预览、安装、应用和恢复 Codex 客户端皮肤。
- **会话管理**：浏览本机 CLI 写下的会话记录，按对话内容、目录或 ID 搜索，按来源筛选，查看会话详情，复制恢复命令和项目目录。在终端中直接恢复目前仅 macOS 可用；Windows 上为复制恢复命令。
- **应用更新**：启动后自动检查，运行期间每 15 分钟检查一次；发现新版本会在后台预下载安装包，点击“立即更新”时直接安装。标题栏按钮和“设置”页都可手动检查。

## 平台支持

| 平台            | 支持情况 | 说明                                                                     |
| --------------- | -------- | ------------------------------------------------------------------------ |
| Windows x64     | 完整支持 | 推荐平台；支持线路管理、Codex 快速启动和运行时维护                       |
| Windows ARM64   | 完整支持 | 提供原生 MSI 与绿色版                                                    |
| macOS Universal | 可用     | 同时支持 Intel 与 Apple Silicon；Codex 快速启动和 Windows 安装维护不可用 |
| Linux x86_64    | 可用     | 提供 deb / rpm / AppImage；Codex 快速启动和 Windows 安装维护不可用       |

Windows 10/11 与 macOS 12 及以上版本为当前发布目标。

## 下载与安装

前往 [Releases](https://github.com/Duojiyi/chimera-codex/releases/latest) 下载最新版。

### Windows

- `Chimera++-v*-Windows.msi`：Windows x64 安装版
- `Chimera++-v*-Windows-Portable.zip`：Windows x64 绿色版，内置经 SHA-256 校验的 Codex 桌面本体
- `Chimera++-v*-Windows-arm64.msi`：Windows ARM64 安装版
- `Chimera++-v*-Windows-arm64-Portable.zip`：Windows ARM64 绿色版

### macOS

- `Chimera++-v*-macOS.dmg`：图形安装包
- `Chimera++-v*-macOS.zip`：压缩包

### Linux

- `Chimera++-v*-Linux-x86_64.deb`：Debian/Ubuntu
- `Chimera++-v*-Linux-x86_64.rpm`：Fedora/RHEL/openSUSE
- `Chimera++-v*-Linux-x86_64.AppImage`：通用

macOS 构建目前没有 Apple Developer ID 签名和公证。如果 Gatekeeper 阻止首次打开，请在 Finder 中右键应用并选择“打开”。Release 中的 `.sig` 是 Tauri 应用内更新签名，不是 Apple 代码签名。

## 快速开始

1. 打开“供应商”，确认当前线路和模型。
2. 选择“添加线路”，填写 API 地址、密钥与模型；需要时展开高级选项设置协议和模型映射。
3. 先执行连接测试，再保存并切换线路。
4. 如果 Codex 正在运行，点击“重启 Codex”让新配置生效；未运行时点击“启动 Codex”。
5. 使用官方账户时选择官方线路。没有有效 OAuth 登录时，按钮会显示“启动并登录”或“重启并登录”。

切换线路只修改当前用户的 Codex 配置，不会静默结束正在执行的 Codex 任务。是否重启由主界面的操作按钮明确决定。

## 更新机制

- Chimera++ 在启动后检查应用更新，运行期间每 15 分钟检查一次。
- 最小化到托盘期间不会打断操作；窗口恢复可见后会补做已到期的检查。
- 发现新版本后会在后台预下载并暂存安装包，每个版本只下载一次。点击“立即更新”时复用这份数据，不必再等下载；预下载失败不影响更新，只是退回到点击时下载。
- 手动检查有两个入口：标题栏的更新按钮，以及“设置”页。有可用更新时标题栏按钮会高亮。
- Windows 和 macOS 更新包通过 Tauri updater 签名验证；`latest.json` 包含各平台下载地址和签名。
- Codex 本体的更新通道和 Chimera++ 应用更新相互独立。

## 数据与配置

Chimera++ 的应用数据默认保存在：

- Windows：`%USERPROFILE%\.chimera-plus-plus\`
- macOS：`~/.chimera-plus-plus/`

Codex 的实时配置仍位于 `~/.codex/`。Chimera++ 对关键配置采用临时文件加原子替换，并在运行时维护操作之间使用跨进程锁。建议在导入、恢复或卸载前保留自己的配置备份。

应用不会把 API 密钥提交到本仓库。提交 Issue 时请删除日志、截图和配置中的令牌、账户标识及私有地址。

## 常见问题

### 切换线路后为什么需要重启 Codex？

Codex 会在启动时读取部分认证和模型配置。线路切换后，Chimera++ 会标记需要重启；点击主按钮时，后端会再次检查真实进程状态，决定启动还是关闭后重启。

### 切回官方线路后为什么仍要求登录？

Chimera++ 只会把包含有效 `tokens.access_token` 的 ChatGPT 认证视为已登录。只有账户元数据或过期残缺数据时，会要求重新完成官方登录，避免把无效认证写回 `auth.json`。

### 第三方线路会覆盖官方 OAuth 吗？

默认不会。`preserve_codex_official_auth_on_switch` 默认为开启，第三方 API 密钥通过供应商配置投影，不覆盖长期保存的 ChatGPT OAuth。兼容旧工作流时仍可显式关闭该行为。

### 应用更新会结束正在运行的 Codex 吗？

不会。Chimera++ 应用更新只重启自身，不会主动关闭 Codex。线路切换后的 Codex 重启由用户单独触发。

## 本地开发

### 环境

- Node.js 20+
- pnpm 10+
- Rust 1.85+
- Windows 或 macOS；完整运行时功能需要 Windows

### 常用命令

```bash
pnpm install
pnpm typecheck
pnpm test:unit
pnpm build:renderer
pnpm tauri dev
```

Rust 检查：

```bash
cargo fmt --check --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml -- -D warnings
cargo test --manifest-path src-tauri/Cargo.toml
```

## 项目结构

```text
src/                  React + TypeScript 界面
src-tauri/src/        Tauri 命令、Codex 配置、运行时和数据服务
tests/                前端单元与集成测试
src-tauri/tests/      Rust 集成测试
.github/workflows/    CI、发布与仓库维护流程
```

## 贡献

提交 PR 前请至少运行 TypeScript 类型检查、相关前端测试、Rust 格式检查和相关 Rust 测试。涉及认证、配置写入、进程终止或更新流程的改动应包含回归测试，并说明 Windows/macOS 的行为差异。

Bug 报告和功能建议请使用 [GitHub Issues](https://github.com/Duojiyi/chimera-codex/issues)。不要在 Issue、PR 或日志中公开 API 密钥和 OAuth 令牌。

## 许可与来源

本项目采用 [MIT License](LICENSE)。Chimera++ 延续了 CC Switch 的部分基础组件，并在此基础上聚焦 Codex 线路与桌面运行时管理；第三方组件分别遵循其原始许可证。
