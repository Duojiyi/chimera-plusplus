# Claude 账号管理扩展设计（2.9.0）

> 编写日期：2026-11-04
> 范围：停用/排序、令牌与 API Key 账号、并行多账号、目录绑定、用量总览、默认 Claude Desktop 账号切换
> 参考：claude-swap（凭据模型、add-token）、claude_switch（会话配置目录、目录映射、Desktop 登录快照）、claude-code-account-switcher（目录继承、Desktop 独立目录）
> 决策方：计划作者（用户授权按最佳实践决定），每条决定都写了理由，方便否决。

## 1. 用户要求与结论

| 要求 | 结论 |
|---|---|
| 账号禁用/启用 | 做。语义见 2.1 |
| 别名 | **不新增字段**。账号已有可改的显示名称，界面里它就是别名；只把改名入口做得更明显（双击名称、行内按钮） |
| 拖拽排序 | 做。同时给上移/下移按钮，键盘可用 |
| 令牌缓存支持写入，实现真正的 Desktop 切换 | **换一种做法**，见 2.6：写令牌缓存换不了 Desktop 的账号，改为切换登录快照 |
| 并行多账号 | 做，仅 Windows，见 2.3 |
| 目录绑定账号 | 做，通过应用内启动生效，见 2.4 |
| 用量总览 | 做，见 2.5 |
| setup-token / Console API Key 直接添加 | 做，见 2.2 |

## 2. 设计

### 2.1 账号元数据：停用与排序

`Slot` 增加字段，全部 `#[serde(default)]`，`version` 仍为 1，旧文件照常读取：

- `disabled: bool`。停用的账号：不能被切换、不能并行打开、不能被目录绑定选用；不再读取额度（少打接口）；列表中变暗并标「已停用」；保留登录，可以导出，随时启用。已经在用的账号（当前登录）不能停用，要先切走。
- `position: Option<u64>`。排序键，`None` 表示还没手动排过，排在已排序账号之后并按创建时间排。拖拽或上下移后，一次写入全部账号的 `position`（持锁，逐个原子写）。

排序键是 `(position.unwrap_or(u64::MAX), created_at, id)`。

### 2.2 账号种类：订阅登录、setup-token、API Key

`Slot.kind`：`oauth`（默认，现有账号）、`setup_token`、`api_key`。

| 种类 | 存什么 | 写入 Claude Code 的方式 | 额度 |
|---|---|---|---|
| oauth | `claudeAiOauth`（含 refresh token）+ `oauthAccount` | 现有切换逻辑 | 有 |
| setup_token | `claudeAiOauth = {accessToken, scopes:["user:inference"]}`，无 refresh token | 同 oauth，并去掉 `oauthAccount` | 无（令牌只有推理权限） |
| api_key | `apiKey`（整个槽位文件由 DPAPI 加密） | `.claude.json` 写 `primaryApiKey` 与 `customApiKeyResponses.approved`（末 20 位），删掉 `.credentials.json` 里的 `claudeAiOauth` | 无（按量计费） |

规则：

- 输入校验：去掉首尾空白；不得含空白或控制字符；长度 20–2048；字符集 `[A-Za-z0-9_-]`。`sk-ant-oat` 开头是 setup-token，`sk-ant-` 开头但不是 `sk-ant-oat`/`sk-ant-ort` 的是 API Key；其余拒绝。`sk-ant-ort` 是 refresh token，不能单独添加。
- **不联网验证**。理由：和 claude-swap 一致，添加动作不向外发任何请求，也避免把用户的密钥发给我们没打算调用的接口。界面提示“保存后在终端运行一次 claude 即可确认可用”。
- 名称必填（没有邮箱可用），默认“令牌账号”“API Key 账号”。
- 同一密钥（指纹相同）已存在则拒绝重复添加。
- 从其他账号切换到 API Key 账号时，`.claude.json` 里原有的 `oauthAccount` 一并移除，避免 Claude Code 显示旧账号；切回 oauth/setup-token 时移除 `primaryApiKey`。
- 导入导出：claude-swap 格式里 API Key 的 `credentials` 是字符串，setup-token 是没有 refresh token 的 `claudeAiOauth`。两者都支持互通。
- 实时登录里如果只有 `primaryApiKey`，「保存当前登录」把它存成 API Key 账号。

### 2.3 并行多账号（仅 Windows）

Claude Code 的配置和凭据都由 `CLAUDE_CONFIG_DIR` 决定。给每个账号一个独立目录 `<保险库>/sessions/<账号 id>/`，用它启动终端，就能同时用多个账号，而 `~/.claude` 的默认登录不受影响。

- 目录里放 `.credentials.json` 和 `.claude.json`（带 `oauthAccount`、`hasCompletedOnboarding: true`；API Key 账号写 `primaryApiKey`）。启动前按需（重新）播种。
- 共享配置：每次启动把 `~/.claude` 的 `settings.json`、`keybindings.json`、`CLAUDE.md`、`skills`、`commands`、`agents` 复制进去（Windows 软链需要权限，所以用复制，并用清单只管理我们创建的项）；`.claude.json` 里的 `mcpServers` 镜像过去。对话记录不复制，用量总览会把每个目录都当作一个来源。
- **刷新令牌只能在一处**：Claude Code 每次刷新都会换新的 refresh token。同一账号的两份拷贝会互相作废。所以：
  - 当前登录就是这个账号时，不允许再开它的并行会话（提示直接在终端运行 `claude`）；
  - 并行会话在运行时，不允许把默认登录切换到这个账号；
  - 每次用保险库里的令牌之前（额度刷新、切换、导出、再次启动），先从并行目录里“收回”较新的令牌（同一账号、`expiresAt` 更大才采用）。
- 启动：生成一次性批处理文件（私有临时目录，结束后自删），先清掉会改变认证的环境变量（`ANTHROPIC_API_KEY` 等），设置 `CLAUDE_CONFIG_DIR`，进入目录，运行 `claude`。终端沿用设置里的首选终端（cmd / PowerShell / Windows Terminal）。启动器进程号记在目录里，用来判断“会话是否还开着”。
- 也提供“复制启动命令”，方便在 VS Code 终端里使用（`set CLAUDE_CONFIG_DIR=… && claude`）。

### 2.4 目录绑定

`<保险库>/bindings.json`：规范化后的目录路径 → `{accountId, email}`。目录路径规范化：去掉 `\\?\`、统一分隔符、去掉末尾分隔符、Windows 下比较时忽略大小写。

- 解析：对给定目录逐级向上找最近的绑定（子目录继承父目录）。
- 账号被删除或停用时，绑定保留但标为“失效”，启动时拒绝并提示；按邮箱可以在重新导入后恢复（先按 id，再按邮箱匹配）。
- 生效范围：**通过 Chimera 启动**。界面里“在此目录打开 Claude”会按绑定选账号并启动并行会话；没绑定就走默认登录。我们不改用户的 PATH、不装 shell 钩子（侵入大、难卸载），用“复制启动命令”覆盖其它终端。

### 2.5 用量总览

独立扫描器，不改数据库结构。理由：现有的会话日志入库只读默认目录、表里没有项目和账号维度，加列要做数据库迁移，收益不抵风险。

- 来源：默认 `~/.claude/projects` 与每个并行目录的 `projects`；递归 `*.jsonl`（含 `subagents`）。
- 只解析含 `"usage"` 的行；同一 `message.id` 在文件间、文件内都去重，取各字段最大值（流式写入会先写部分用量）。
- 按 天 / 项目（`cwd`，退回目录名）/ 模型 / 来源账号 汇总输入、输出、缓存读、缓存写，费用用数据库里的模型定价估算（和现有用量页同一套计算）。
- 区间：近 7 天、30 天、90 天、全部。热力图按天。
- 性能：按文件的（大小、修改时间）缓存每个文件的解析结果，只重读变化的文件；单行上限与现有导入相同；文件数上限 20 万。后台线程执行，界面显示进度状态。

### 2.6 Claude Desktop：为什么不写令牌缓存，以及怎么做真正的切换

**不写 `oauth:tokenCacheV2`。** 调研结论：

1. Desktop 的登录状态不只在令牌缓存里：会话 Cookie（`Network/Cookies`）、`Local State` 里的 DPAPI 加密密钥、`Preferences`、本地存储共同构成登录。只改缓存，Desktop 仍然是原来的账号。
2. 缓存里的令牌是 Desktop 自己的 OAuth 客户端签发的；Claude Code 的登录令牌属于另一个客户端，写进去也无法被 Desktop 刷新，刷新还会让原来的令牌作废。
3. 两个参考项目都明确不这样做：claude-code-account-switcher 指出“交换登录数据会混淆认证状态并触发服务端重新认证”；claude_switch 的做法是整套登录文件的快照切换。

**做法：登录快照切换（默认 Desktop）。** Chimera 已有独立目录方案（多个账号可同时打开）；它管不了从开始菜单打开的“默认 Desktop”，Microsoft Store 版也不能带 `--user-data-dir`。这一块用快照补上：

- 快照 = Desktop 数据目录里的登录文件白名单（`Local State`、`config.json`、`Preferences`、`ant-did`、`ant-device-registry.json`、`Network/` 下的 Cookies 与传输状态文件、`Cookies*`）加目录 `Local Storage`、`Session Storage`、`IndexedDB`、`WebStorage`。MCP 配置 `claude_desktop_config.json` 和 `window-state.json` 不换，所有账号共用。
- 快照存在 `<保险库>/desktop-auth/<账号 id>/`，只在本机有效（Cookie 密钥绑定当前 Windows 用户），**不进导出文件**。
- 创建：用户在默认 Desktop 里登录某个账号后，点“保存默认 Desktop 的登录到该账号”。账号用 `config.json` 里明文的 `lastKnownAccountUuid` 与保险库账号的 `accountUuid` 自动匹配，匹配不上让用户选。
- 切换：关闭 Desktop（先请求关闭，超时强制）→ 先把当前登录存回对应账号的快照（认不出是谁就存为“未归属快照”并保留最近 3 份，不丢）→ 暂存回滚副本 → 应用目标快照 → 失败则回滚 → 原来在运行就重新启动。
- 数据目录：优先 `%APPDATA%\Claude`；MSIX 版虚拟化目录 `%LOCALAPPDATA%\Packages\Claude_*\LocalCache\Roaming\Claude` 仅在存在且更新时采用。
- 仅 Windows。macOS 密钥在钥匙串、Linux 在 libsecret，不在本版范围。

## 3. 安全要点

- 槽位文件整体由 DPAPI 加密（现有机制），新增的 API Key 也在里面。
- 并行目录里的 `.credentials.json` 是明文（Claude Code 在 Windows 上就是明文文件），目录权限继承用户配置目录；会话结束后不主动删除（下次启动需要它），删除账号时一并擦除。
- 启动器脚本只含目录路径和固定命令，不含任何令牌；API Key 账号写进该目录的 `.claude.json`，不经环境变量。
- 所有传给 `cmd.exe` 的路径来自我们生成的临时文件，目录选择来自系统对话框；路径含 `%`、`&`、`^`、`"` 时先拒绝。
- 日志不记录令牌和密钥。

## 4. 验证

- Rust 单元测试：槽位新字段的向后兼容读取、排序键、停用的各个拒绝路径、令牌/密钥解析与切换文件写入、并行目录播种与收回、绑定解析与路径规范化、用量去重与汇总、快照白名单拷贝与回滚（用临时目录）。
- 前端测试：每个新界面的主路径和拒绝路径。
- 双盲审计：两路独立审查（一路按本文档审实现，一路不给本文档只给需求描述审实现），出具问题清单后整改，再各复核一次。通过后才启动 dev 版本。
