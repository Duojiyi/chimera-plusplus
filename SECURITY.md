# Security Policy / 安全策略

## Supported Versions / 支持的版本

Only the latest release of Chimera++ receives security updates.

仅最新版本的 Chimera++ 会收到安全更新。

| Version / 版本                                | Supported / 是否支持 |
| --------------------------------------------- | -------------------- |
| Latest Chimera++ release / Chimera++ 最新版本 | Yes / 是             |
| Older Chimera++ releases / Chimera++ 较旧版本 | No / 否              |

The inherited CC Switch 3.x entries in the changelog are upstream history, not Chimera++ release versions.

更新日志中保留的 CC Switch 3.x 条目属于上游历史，不是 Chimera++ 的发行版本。

## Reporting a Vulnerability / 报告漏洞

**Please do NOT report security vulnerabilities through public GitHub issues.**

**请不要通过公开的 GitHub Issue 报告安全漏洞。**

Instead, please report them through [GitHub Security Advisories](https://github.com/Duojiyi/chimera-plusplus/security/advisories/new).

请通过 [GitHub 安全公告](https://github.com/Duojiyi/chimera-plusplus/security/advisories/new) 进行报告。

When reporting, please include:

报告时请包含以下信息：

- A description of the vulnerability / 漏洞描述
- Steps to reproduce / 复现步骤
- Potential impact / 潜在影响
- Affected versions / 受影响版本

## Response Timeline / 响应时间

- **Acknowledgment / 确认**: within 48 hours / 48 小时内
- **Initial assessment / 初步评估**: within 7 days / 7 天内
- **Fix for critical issues / 关键问题修复**: within 14 days / 14 天内

## Disclosure Policy / 披露政策

We follow a coordinated disclosure process:

我们遵循协调披露流程：

1. The reporter submits the vulnerability privately. / 报告者私下提交漏洞。
2. We confirm and work on a fix. / 我们确认并修复漏洞。
3. A patch release is published. / 发布修复版本。
4. The vulnerability is publicly disclosed. / 公开披露漏洞详情。

Reporters will be credited in the release notes unless they prefer to remain anonymous.

除非报告者希望匿名，否则将在发布说明中致谢。

## Security Updates / 安全更新

Security fixes are released as patch versions and announced via [GitHub Releases](https://github.com/Duojiyi/chimera-plusplus/releases). We recommend always updating to the latest version.

安全修复通过补丁版本发布，并通过 [GitHub Releases](https://github.com/Duojiyi/chimera-plusplus/releases) 通知。建议始终更新到最新版本。

## Dependency Audit Scope / 依赖审计范围

CI blocks release on known npm vulnerabilities (including development dependencies) and RustSec vulnerability findings. The lockfiles are reviewed together with application code; a clean vulnerability count is not a guarantee of zero risk.

CI 将 npm 已知漏洞（含开发依赖）和 RustSec 漏洞项作为发布阻断条件。锁文件与应用代码一并复核；漏洞计数为零不等于不存在风险。

The 2.7.7 dependency review still reports upstream informational advisories for the Tauri/GTK dependency graph: unmaintained `fxhash`, `proc-macro-error` and `unic-*` crates, plus soundness advisories affecting `glib 0.18` (RUSTSEC-2024-0429) and `rand 0.7` (RUSTSEC-2026-0097). These are not hidden with audit ignore rules. They require upstream-compatible dependency migrations and remain tracked limitations; new reachable security issues must still block release.

2.7.7 的依赖复查仍包含 Tauri/GTK 依赖链的上游信息提示：停止维护的 `fxhash`、`proc-macro-error`、`unic-*`，以及 `glib 0.18`（RUSTSEC-2024-0429）和 `rand 0.7`（RUSTSEC-2026-0097）的健全性警告。没有使用审计忽略规则隐藏这些提示；相关升级需要与上游依赖链保持兼容，仍属于已知边界。新增且可达的安全问题仍须阻断发布。

`rand 0.7` is reached through `phf_generator` in the Tauri HTML-selector build dependency chain; `glib 0.18` belongs to the Linux GTK runtime stack. They are not interchangeable drop-in upgrades, and this release does not claim those upstream advisories are fixed.

`rand 0.7` 经由 Tauri HTML 选择器的构建依赖 `phf_generator` 引入；`glib 0.18` 属于 Linux GTK 运行时依赖。两者均不能直接跨不兼容版本替换，本版本不宣称已经修复这些上游警告。
