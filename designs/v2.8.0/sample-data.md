# Chimera++ v2.8.0 示例数据事实表

画布上所有示例数据都以本文件为准。改画面前先改这里，再回填。每条口径后面的「依据」说明为什么取这个值、它解决了评审里的哪一条矛盾。

## 0. 总则

- **主时刻：2026-09-27（周日）14:22。** 常态画面（01 / 01D / 03 / 04A / 04B / 05 / 06 / 06B / 07 / 07B / 08 / 08D / 09A / 09B / 11 / 11C / 13A / 13B / 14 / 14D / 15 / 15B）都是这一刻的样子。
  - 依据：14:20 切到 DeepSeek（#0412）后 01 回执写「2 分钟前」，08 写「14:22 统计」，这两处在 8 张以上的帧里出现，改动最少；2026-09-27 按公历确为周日（1 月 1 日周四，第 270 天）。
  - 任务说明建议 14:3x。取 14:22 而不是 14:3x，是因为 14:3x 会让「2 分钟前」回执和 #0412 的时间对不上，两者必须改一处；14:3x 保留给故障时刻（见 §6）。
- **分支帧**：确认框、错误态这类「还没确认」或「假设出错」的画面，时刻写在 §9。它们都**不进入主时间线**：用户取消或尚未确认，不生成备份编号，所以只写备份**文件夹**（带时间戳），不写编号。
- **同一个数字只表达一种含义。** 1284 只当「四个工具的会话总数」；总词元改为 1578 万；备份编号只按 §4 的时间顺序出现。
- 路径一律写 `C:\Users\lin\...`；确认框与写入预告写绝对路径，概述性文字可写 `%APPDATA%\Chimera\...` 缩写（`%APPDATA%` = `C:\Users\lin\AppData\Roaming`）。
- 版本：**Chimera++ 2.8.0**（依据：本次交付版本；修 B-P2-13 设置页「0.9.4」）。

## 1. 用户与目录

| 项 | 值 |
|---|---|
| Windows 用户 | lin |
| Codex 配置目录 | `C:\Users\lin\.codex\`（config.toml、auth.json、AGENTS.md、sessions\、skills\） |
| Codex 可执行文件 | `C:\Users\lin\AppData\Roaming\npm\codex.cmd`（npm 全局） |
| Chimera 数据目录 | `C:\Users\lin\AppData\Roaming\Chimera\`（routes.json、backups\、logs\） |
| 备份目录 | `C:\Users\lin\AppData\Roaming\Chimera\backups\`，每次写入前一份，文件夹名 `YYYY-MM-DD_HHMM`，保留最近 30 份 |
| Claude Code | `C:\Users\lin\.claude\settings.json`；会话 `C:\Users\lin\.claude\projects\` |
| Gemini CLI | 会话 `C:\Users\lin\.gemini\tmp\` |
| OpenCode | `C:\Users\lin\.config\opencode\opencode.json` |
| OpenClaw | `C:\Users\lin\.openclaw\openclaw.json`，可执行文件 `C:\Users\lin\AppData\Roaming\npm\openclaw.cmd` |
| cc-switch | `C:\Users\lin\.cc-switch\config.json`（12 个供应商） |
| 导出默认位置 | `D:\exports\codex-sessions-0927.zip` |
| 项目 | `D:\work\chimera-plusplus` |

## 2. Codex 线路（9 条）与测速

全部测速：**今天 14:19**（15B「9 条线路 · 14:19 全部测速」）。主时刻 14:22 写「3 分钟前测速」。
- 依据：原稿 01 写 DeepSeek「2 分钟前测速」、自建中转「3 分钟前测速」，两者同属 14:19 的全部测速，统一为 3 分钟前。
- 分档：快 < 300 ms；中 300–799 ms；慢 ≥ 800 ms；超时 = 10 s 无响应。

| # | 线路 | 徽标 / 身份色 | 认证 | 地址 | 协议 | 经本地代理 | 默认模型 | 14:19 测速 |
|---|---|---|---|---|---|---|---|---|
| 1 | OpenAI 官方 · 主力 | 主 / 官方墨色 `badge-official-bg` | ChatGPT 登录 li***@gmail.com · Pro | chatgpt.com | Responses | 否 | gpt-5.5 | 240 ms 快 |
| 2 | OpenAI 官方 · 工作 | 工 / 官方墨色 | ChatGPT 登录 ch***@acme.cn · Business | chatgpt.com | Responses | 否 | gpt-5.6 | 265 ms 快 |
| 3 | OpenAI 官方 · 备用 | 备 / 官方墨色 | ChatGPT 登录 li***@outlook.com · Plus，**登录已过期** | chatgpt.com | Responses | 否 | gpt-5.5 | 不测（需重新登录） |
| 4 | DeepSeek | DS / `id-cobalt` | API 密钥 | api.deepseek.com | 自动 · Chat | **是**（Responses → Chat） | deepseek-v4-pro · 128K | 182 ms 快 |
| 5 | Kimi | Ki / `id-violet` | API 密钥 | api.moonshot.cn | 自动 · Chat | **是** | kimi-k2.5 · 256K | 310 ms 中 |
| 6 | 智谱 GLM | 智 / `id-teal` | API 密钥 | open.bigmodel.cn | Chat | **是** | glm-4.6 | 1200 ms 慢 |
| 7 | 阿里云百炼 | 百 / `id-moss` | API 密钥 | dashscope.aliyuncs.com | 自动 · Chat | **是** | qwen3-coder-plus | 290 ms 快 |
| 8 | OpenRouter | OR / `id-magenta` | API 密钥 | openrouter.ai | Responses | 否 | openai/gpt-5.6 | 460 ms 中 |
| 9 | 自建中转 | 自 / `id-ochre` | API 密钥（末 4 位 c81e，昨天 21:14 验证通过） | 已保存：`https://gw.lab.internal:8080/v1` | 自动 · Anthropic | **是**（Responses → Anthropic） | claude-sonnet-4-6 | 超时（10 s 无响应） |

- 15B 概况：正常 6（快 4：主力、工作、DeepSeek、百炼；中 2：Kimi、OpenRouter），慢 1（智谱），超时 1（自建中转），需重新登录 1（备用），合计 9。
- **依赖本地代理的线路共 5 条**：DeepSeek、Kimi、智谱 GLM、阿里云百炼、自建中转。依据：Codex 只说 Responses，Chat 与 Anthropic 协议都要本地代理转换（02 预览里自建中转的路径就是「本地代理 · Responses → Anthropic」）。修 B-P1-5 的漏项（原稿只列 3 条）。
- 自建中转超时的原因：网关已迁到 8443 端口，保存的地址还是 8080。02 / 02B / 02D 是用户正在把地址改成 `https://gw.lab.internal:8443/v1`（未保存的分支，见 §9）。
- Kimi 最近 8 次测速：中位数 310 ms，9 月 26 日 20:14 有一次 1200 ms（慢），其余 280–330 ms（15 右栏）。

## 3. 切换时间线（Codex）

| 时间 | 切换 | 写入 | 备份 |
|---|---|---|---|
| 9 月 18 日 11:20 | 主力 → 工作 | auth.json、config.toml | #0388 |
| 9 月 21–25 日 | 在 DeepSeek、Kimi、智谱 GLM、阿里云百炼、OpenRouter 之间多次切换（画面不出现逐条记录） | config.toml | #0389–#0403 之间 |
| 9 月 25 日 17:10 | → DeepSeek | config.toml | #0403 |
| 9 月 26 日 19:40 | DeepSeek → 主力 | auth.json、config.toml | #0407 |
| 今天 09:02 | 主力 → OpenRouter | config.toml | #0409 |
| 今天 09:52 | OpenRouter → Kimi | config.toml | #0410 |
| 今天 12:55 | Kimi → 主力 | auth.json、config.toml | #0411 |
| **今天 14:20** | **主力 → DeepSeek**（当前） | config.toml | **#0412** |

- 依据：B-P1-3 指出会话的线路与切换记录冲突。原稿只有 09:52 与 14:20 两次切换，会话却在 09:40 走 OpenRouter、11:05 走 Kimi、13:08 起走 DeepSeek。改法是补上 09:02、09:52、12:55 三次切换，并把 13:08–14:20 那条长会话改到「主力」（它结束后才切到 DeepSeek）。
- 15B「最近切换」只列最近两次：14:20 主力 → DeepSeek、12:55 Kimi → 主力。
- 当前线路：**DeepSeek**，14:20 起。侧栏 Codex 行徽标 DS；标题栏迷你站牌「Codex → DS DeepSeek → 182 ms」。

## 4. 备份编号（主时间线，按时间递增）

| 编号 | 时间 | 触发 | 文件 | 大小 |
|---|---|---|---|---|
| #0388 | 9 月 18 日 11:20 | 切换到 OpenAI 官方 · 工作前 | auth.json、config.toml | 11 KB |
| #0391 | 9 月 19 日 10:12 | 首次启用 Claude Code 前 | settings.json | 2 KB |
| #0396 | 9 月 20 日 21:04 | Codex 升级到 0.61.0 前 | config.toml | 8 KB |
| #0402 | 9 月 25 日 16:40 | 从 cc-switch 导入前 | config.toml、routes.json | 14 KB |
| #0403 | 9 月 25 日 17:10 | 切换到 DeepSeek 前 | config.toml | 8 KB |
| #0407 | 9 月 26 日 19:40 | 切换到 OpenAI 官方 · 主力前 | auth.json、config.toml | 11 KB |
| #0408 | 9 月 26 日 21:14 | 编辑「自建中转」前 | routes.json | 3 KB |
| #0409 | 今天 09:02 | 切换到 OpenRouter 前 | config.toml | 8 KB |
| #0410 | 今天 09:52 | 切换到 Kimi 前 | config.toml | 8 KB |
| #0411 | 今天 12:55 | 切换到 OpenAI 官方 · 主力前 | auth.json、config.toml | 11 KB |
| #0412 | 今天 14:20 | 切换到 DeepSeek 前 | config.toml | 8 KB |
| #0413 | 今天 14:42 | 配置体检修复前 | config.toml、auth.json | 11 KB |
| #0414 | 今天 14:44 | 删除「自建中转」前（01E 分支，见 §9） | routes.json | 3 KB |

- 11 设置（14:22）显示最近 5 份：#0412、#0411、#0410、#0409、#0408（列表可滚动，#0407 及更早在下面）。
- 依据：B-P2-6「10 与 11B 写进同一分钟目录」。10 页脚改为只说备份目录，不预告时间戳；10B 实际备份 `2026-09-27_1442\`（#0413）；11B 是取消的分支，只写它自己的时间戳文件夹 `2026-09-27_1424\`。
- 原稿「昨天 21:14 #0409 编辑自建中转」改为 #0408，给今天 09:02 腾出 #0409；#0412 保持不变（它在 01 / 01D / 13C / 13E / 14 / 14D / 15 / 15B 的回执里出现）。

## 5. 官方账号与 auth.json 归属

| 账号 | 邮箱 | 套餐 | 状态 | 额度 |
|---|---|---|---|---|
| OpenAI 官方 · 主力 | li***@gmail.com | Pro | 登录有效 | 今天 14:21 查询：5 小时剩余 62%（17:55 重置），本周剩余 41%（周一 08:00 重置） |
| OpenAI 官方 · 工作 | ch***@acme.cn | Business | 登录有效 | 未查询（「查看额度」） |
| OpenAI 官方 · 备用 | li***@outlook.com | Plus | 需要重新登录 | 登录过期，无法查询 |

- **auth.json 写入记录**（只有切到官方账号时才写 auth.json，第三方切换不改它）：今天 12:55 写入主力（#0411）；9 月 26 日 19:40 写入主力（#0407）；9 月 18 日 11:20 写入工作（#0388）。
- 所以主时刻 auth.json = **主力 li***@gmail.com**，已保存为账号；Codex 走 DeepSeek，这份登录暂未使用。
- 额度：主力 12:55–14:20 在用，5 小时窗从 12:55 起算，17:55 重置；本周主力用了 394 万词元（§7），本周剩余 41%。
- 「检测到未保存的登录」：主时刻**不出现**（auth.json 里的登录已是「主力」）。这个状态只画在 DS 里作为规格。依据：A-N-P3-4，原稿提示条里的 wa***@gmail.com 没有任何 `codex login` 来源，已删除；12 首次启动检测到的登录改为 li***@gmail.com（ChatGPT Pro），也就是后来保存的「主力」。
- 03B 设备码：`K7QD-9XMP`，**14 分 32 秒后过期**（A-N-P2-6）。

## 6. 本地代理状态时间线

| 时间 | 事件 |
|---|---|
| 今天 14:20 | 切到 DeepSeek，本地代理 127.0.0.1:15721 在跑（Responses → Chat），01「HTTP 200 · 已连通」 |
| 主时刻 14:22 | 正常。所有常态帧的迷你站牌都是正常态 |
| **14:28** | 本地代理重启时端口 15721 已被 node.exe（PID 18244）占用，代理没起来。5 条依赖代理的线路从此无法转发 |
| **14:40** | 10 配置体检：「本地代理端口 15721 被占用 · node.exe · PID 18244 · 已占用 12 分钟」 |
| **14:42** | 10B 开始修复，先备份 #0413；改用 15722 失败（python.exe，PID 20110 占用） |
| 14:43 | 同一次修复里改用 15723 成功，本地代理恢复（沿用 #0413 这份修复前备份，不另占编号）。画面不出现，只为 01E 的「本地代理 · 运行中」提供前提 |

- 10 / 10B 的迷你站牌显示故障态「本地代理未运行」，侧栏 Codex 行加警示；受影响线路写 5 条（§2）。依据：B-P1-5。
- 当前线路仍是 DeepSeek（配置没变，只是代理不可用），所以站牌里线路段仍写 DeepSeek。

## 7. 用量（Codex，近 7 天 = 9 月 21 日至 27 日，14:22 统计）

**总词元 1578 万**（依据：原稿 1284 万与会话总数 1284 撞号，B-P1-2；新值由下表逐日相加得到）。

按日按线路（单位：万词元）：

| 线路 | 一 21 | 二 22 | 三 23 | 四 24 | 五 25 | 六 26 | 日 27（今天） | 合计 | 占比 |
|---|---|---|---|---|---|---|---|---|---|
| DeepSeek（deepseek-v4-pro） | 90 | 158 | 122 | 149 | 134 | 88 | 0 | 741 | 47% |
| 主力（gpt-5.5） | 0 | 0 | 0 | 0 | 0 | 208 | 186 | 394 | 25% |
| Kimi（kimi-k2.5） | 30 | 0 | 0 | 47 | 0 | 0 | 97 | 174 | 11% |
| 智谱 GLM（glm-4.6） | 0 | 40 | 38 | 0 | 32 | 0 | 0 | 110 | 7% |
| 阿里云百炼（qwen3-coder-plus） | 22 | 0 | 0 | 35 | 22 | 0 | 0 | 79 | 5% |
| OpenRouter（openai/gpt-5.6） | 0 | 0 | 16 | 0 | 0 | 0 | 64 | 80 | 5% |
| **当日合计** | **142** | **198** | **176** | **231** | **188** | **296** | **347** | **1578** | 100% |

- 模型分布 = 线路分布（每条线路一个默认模型）：deepseek-v4-pro 47%、gpt-5.5 25%、kimi-k2.5 11%、glm-4.6 7%、qwen3-coder-plus 5%、openai/gpt-5.6 5%。依据：B-P1-4 要求补上 OpenRouter 的 openai/gpt-5.6。工作账号（gpt-5.6）与自建中转本周 0 用量，不列。
- 今天（周日）DeepSeek 为 0：14:20 才切过去，到 14:22 还没有请求。
- 按周：主力 394 万，对应 03 本周剩余 41%。
- **对话数：96 个（根对话）**，另有子代理 31 个，已并入发起它的对话。会话文件 = 96 + 31 = 127 个。
- 估算成本（官方账号订阅内不计）：单价 DeepSeek 0.12、Kimi 0.05、智谱 0.08、百炼 0.06、OpenRouter 0.15 元 / 万词元 → 88.92 + 8.70 + 8.80 + 4.74 + 12.00 = **123.16 元**。
- 缓存命中 62%；较上周 +8%（上周约 1461 万）。
- 按对话汇总（前 5 个根对话，按词元降序）：

| 对话 | 时间 | 线路 | 词元 | 成本 | 子代理 |
|---|---|---|---|---|---|
| 拆分用量汇总里的子代理归属 | 昨天 21:12 | 主力 | 208 万 | 订阅内 | 3 个 |
| 修复 config.toml 迁移时丢失 profile 的问题 | 今天 14:20 | 主力 | 186 万 | 订阅内 | 2 个：读取迁移流程的 4 个函数 42 万；补一条旧版 profile 的回归测试 18 万 |
| 为线路列表加上键盘上下选择 | 今天 11:05 | Kimi | 97 万 | ¥ 4.85 | 1 个 |
| 把 cc-switch 导入改成四类结果 | 昨天 16:30 | DeepSeek | 88 万 | ¥ 10.56 | 0 |
| 排查 OpenRouter 返回 429 的重试间隔 | 今天 09:40 | OpenRouter | 64 万 | ¥ 9.60 | 0 |

- 14 / 14D 命令面板「查看 kimi-k2.5 的用量」：**近 7 天 174 万词元 · 占 11%**（原稿 97 万是单个对话的值）。

## 8. 会话

| 工具 | 全部会话（根会话） | 近 7 天 | 会话目录 |
|---|---|---|---|
| Codex | 862 | 96 | `C:\Users\lin\.codex\sessions\` |
| Claude Code | 311 | 23 | `C:\Users\lin\.claude\projects\` |
| Gemini CLI | 64 | **0**（最近一次 9 月 12 日） | `C:\Users\lin\.gemini\tmp\` |
| OpenCode | 47 | 5 | `C:\Users\lin\.local\share\opencode\` |
| **合计** | **1284** | **124** | |

- Pi、Mcode 不记录会话（brief §4）。
- Codex 会话文件：根会话 862 + 子代理 280 = **1142 个文件**。13B 首次汇总进度写「已读取 412 / 1142 个文件」（B-P1-2：只读 Codex 的文件）。
- 13D 卸载确认写「862 条会话记录」（原稿 1284 是四个工具合计）。
- 07 页口径：页头 / 状态头写「共 1284 条」；筛选「工具：Codex · 近 7 天」时列表显示 **96 条**（B-P1-2）。
- 13A 空状态改为 **Gemini CLI · 近 7 天 0 条**（「近 7 天没有会话记录」+「清除时间筛选」）。原稿写 Claude Code 0 条，与 Claude Code 311 条矛盾。
- 07 列表里能看到的根会话（主时刻）：

| 分组 | 标题 | 线路 | 起止 | 轮 |
|---|---|---|---|---|
| 今天 | 修复 config.toml 迁移时丢失 profile 的问题 | 主力（gpt-5.5） | 13:08–14:20，1 小时 12 分 | 38 |
| 今天 | 为线路列表加上键盘上下选择 | Kimi | 09:58–11:05 | 12 |
| 今天 | 排查 OpenRouter 返回 429 的重试间隔 | OpenRouter | 09:04–09:40 | 6 |
| 昨天 | 拆分用量汇总里的子代理归属 | 主力 | 19:52–21:12 | 54 |
| 昨天 | 把 cc-switch 导入改成四类结果 | DeepSeek | 15:10–16:30 | 22 |
| 9 月 25 日（滚动到下方才看得到） | 整理 v2.8.0 升级计划的风险表 | DeepSeek | 19:40–20:48 | 20 |

- 详情「修复 config.toml…」：第 1 轮 13:08，第 12 轮 **13:41**，第 13 轮 **13:44**，最后活动 14:20（B-P2-5：原稿第 12 轮 14:32 比最后活动还晚）。`codex resume 0199a3f2-7c41`。
- 原稿列表分组「9 月 24 日」改为「9 月 25 日」：该会话属于周五 188 万里 DeepSeek 的 134 万。
- 07 / 07B 详情里的单轮词元是示例值，不计入 §7 的合计：第 12 轮「输入 1.8 万 · 输出 2140」，上一张卡「输入 2.6 万 · 输出 1180」（R3 抽样核对时补记）。
- 07B 删除：2 条会话（38 轮含 2 个子代理；12 轮含 1 个子代理），共 5 个文件，目录 `C:\Users\lin\.codex\sessions\2026\09\27\`。

## 9. 分支帧的时刻

| 帧 | 时刻 | 结果 | 备份 |
|---|---|---|---|
| 02 / 02B / 02D 编辑自建中转 | 14:23 | 未保存 | 保存时写 routes.json |
| 03B 设备码登录 | 14:23 | 等待中 | 无 |
| 03C 切换到工作 | 14:23 | 待确认 | 预告文件夹 `2026-09-27_1423\` |
| 07 导出 / 07B 删除 | 14:22 | 待确认 | 无 |
| 11B 首次启用 OpenClaw | 14:24 | 取消（侧栏里没有 OpenClaw） | 预告文件夹 `2026-09-27_1424\` |
| 11D 恢复 #0412 | 14:23 | 待确认 | 预告文件夹 `2026-09-27_1423\` |
| 13C config.toml 第 57 行无法解析 | 14:31（假设用户手改坏了文件） | 错误态 | 最后一次成功读取 14:20；可从 #0412 恢复 |
| 13D / 13DD 卸载 Codex | 14:23 | 待确认（默认未勾选「同时删除配置目录」，按钮「卸载」） | 无 |
| 13D2 卸载 · 勾选删除配置 | 14:23 | 待确认（勾选态，按钮「卸载并删除配置」）。这条分支不接 09C / 09D | 无 |
| 13E 深链导入 SiliconFlow | 14:25 | 待确认（回执「5 分钟前」） | 无 |
| 13F Mcode 拒绝深链 | 14:26 | 已拒绝，什么都没改 | 无 |
| 13G 从 cc-switch 导入 | 14:24 | 逐条确认中 | 预告文件夹 `2026-09-27_1424\` |
| 09C / 09D 安装 Codex | 14:24 / 14:26，接 13D / 13DD 的**未勾选分支**「卸载」之后（配置目录默认保留，所以线路、账号、会话都还在，侧栏徽标仍是 DS）；已下载 24 MB 时超时，09D 写「已清理 24 MB」 | 安装中 / 失败 | 无（只写安装目录） |
| 12 / 12B 首次启动 | 另一台新电脑，今天 14:20 | 首次启动 | 无 |
| 01E 线路 · 删除后撤销 | 14:44（10 体检建议处理「自建中转测速超时」，用户选择删除；这条线路不是当前线路，不需要先切换） | 已删除，回执可撤销：「刚刚 已删除「自建中转」，已备份 #0414」；列表 8 条（第三方 5）；站牌测速写「25 分钟前测速」 | **#0414**（routes.json）。删除已经执行，所以和其他分支帧不同，占用编号；它排在 #0413 之后，不影响任何常态帧 |

- 12 / 12B 设为「同一用户在新电脑上首次装 Chimera++ 2.8.0」：主机的备份已经排到 #0412，不可能是首次启动；12 检测到的 Codex 是 0.61.0、登录是 li***@gmail.com（Pro）、cc-switch 里有 12 个供应商，与主机一致。12B 是这台新电脑还没装 Codex 的分支。
- 13C：列表不标「当前」（无法确认），改为灰字「14:20 读取时在用」；侧栏 Codex 徽标换为问号态（B-P2-8）。

## 10. 配置体检（10 在 14:40 检查，用时 1.2 秒，共 19 项）

| 严重度 | 项 | 依据 / 数据 |
|---|---|---|
| 需修复 | config.toml 里有两个同名 profile「work」 | 第 42 行、第 88 行；修复：保留第 88 行，删除第 42 至 44 行 |
| 需修复 | 本地代理端口 15721 被占用 | node.exe · PID 18244 · 已占用 12 分钟（14:28 起）；修复：改用 15722 |
| 需修复 | auth.json 可被本机其他用户读取 | 继承了 Users 组的读取权限；修复：收紧权限 |
| 建议 | **自建中转测速超时** | 14:19 全部测速时 10 s 无响应 · 地址 gw.lab.internal:8080；操作：编辑线路 |
| 建议 | config.toml 还在用旧版顶层 profile 字段 | 第 3 行；操作：迁移 |
| 通过 | 14 项 | |

- 依据：B-P1-11，原稿「OpenRouter 的密钥 90 天没有验证 · 上次验证 6 月 29 日」与 14:19 全部测速（OpenRouter 460 ms）和本周 80 万词元冲突，换成与测速结果一致的真实问题。
- 10B（14:42）：已修复 1（同名 profile，可撤销）、失败 1（15722 也被 python.exe PID 20110 占用）、修复中 1（auth.json 权限）；主按钮「修复中…（1 项进行中）」，状态头读数「3 项 · 1 项进行中」（R3 P3-4：原「修复中 3 / 3」读起来像已完成）。10 的端口项也写受影响的 5 条线路（R3 P3-9）。

## 11. 其他工具（10 个）

| 工具 | 模式 | 状态 | 版本 | 侧栏 | 深链 |
|---|---|---|---|---|---|
| Codex | 切换类 | 始终显示 | 0.61.0 | Codex 行徽标 DS | 导入 + 确认 |
| Claude Code | 切换类 | 已启用（9 月 19 日，#0391） | 2.1.9 | 徽标 智（当前 智谱 GLM，210 ms，14:17 测速） | 仅导入 |
| Claude Desktop | 切换类 | 未安装 | | | 仅导入 |
| Gemini CLI | 切换类 | 已启用 | 0.9.2 | 徽标 官（Google 官方登录） | 仅导入 |
| Grok Build | 切换类 | 未启用（已检测到） | 0.4.1 | | 仅导入 |
| OpenCode | 累加类 | 已启用 | 1.2.0 | 计数 3/5 | 仅导入 |
| OpenClaw | 累加类 | 未启用（已检测到） | 1.4.2 | | 仅导入 |
| Hermes | 累加类 | 未安装 | | | 仅导入 |
| Pi | 累加类 | 已启用 | 0.7.3 | 计数 2/3 | 仅导入 |
| Mcode | 累加类 | 未启用（已检测到） | 0.3.0 | | **拒绝** |

- 已启用 5（含 Codex）/ 未启用 3 / 未安装 2，合计 10。
- Claude Code 线路：Claude 官方 · 订阅（li***@gmail.com · Max，180 ms）、智谱 GLM（当前，210 ms）、DeepSeek 260 ms、Kimi 340 ms。
- OpenCode 条目：DeepSeek、OpenRouter、阿里云百炼已启用；智谱 GLM、自建中转未启用。
- 「3/5」「2/3」的可访问名称：「OpenCode：已启用 3 条，共 5 条」「Pi：已启用 2 条，共 3 条」。

## 12. cc-switch 导入（13G，14:24，从 `C:\Users\lin\.cc-switch\config.json` 读到 12 个供应商）

| 分类 | 数 | 供应商 | 说明 |
|---|---|---|---|
| 新增 | 3 | 火山方舟（ark.cn-beijing.volces.com · doubao-seed-code）、ModelScope（api-inference.modelscope.cn · Qwen3-Coder-480B-A35B）、Azure OpenAI（acme-openai.openai.azure.com · gpt-5.5） | 默认勾选 |
| 与现有相同 | 4 | DeepSeek、智谱 GLM、阿里云百炼、OpenRouter | 跳过，不写入 |
| 冲突 | 2 | 自建中转（cc-switch 里是 :8000/v1，现有 :8080/v1）；Kimi（cc-switch 里模型 kimi-k2-turbo，现有 kimi-k2.5） | 默认「保留现有」 |
| 不支持 | 3 | OpenAI 官方（ChatGPT 登录）：登录令牌不能导出；AWS Bedrock：需要 SigV4 签名；Vertex AI：需要 Google 服务账号 | 只列出，不导入 |

- 3 + 4 + 2 + 3 = 12，与 12 首次启动「检测到 cc-switch 配置里有 12 个供应商」一致。
- 写入 `C:\Users\lin\AppData\Roaming\Chimera\routes.json`；导入前备份到 `…\backups\2026-09-27_1424\`；不改动 config.toml。

## 13. 提示词、Skills、MCP

- 提示词共 7：内置 6（代码评审、调试、维护者、清晰度编辑、结构化草稿、技术文档）+ 导入 1（团队约定.md，来自 `D:\work\team\AGENTS.team.md`）；已启用 3（代码评审、清晰度编辑、团队约定）。
- Skills 共 7，已启用 5：pdf-toolkit（ZIP）、frontend-design（anthropics/skills）、release-notes（git.acme.cn/tools）、test-plan（anthropics/skills）、sql-explain（ZIP）、docx-export（ZIP）、webapp-testing（anthropics/skills）；来源 3 个（本地 ZIP、anthropics/skills、git.acme.cn/tools）。
- 06 识别 anthropics/skills：**5 个 Skill**，docx、xlsx 可选；frontend-design、test-plan、webapp-testing 已安装（禁选）；按钮「安装 2 个」（A-N-P2-5）。
- MCP 4 个。DS 里标签页示例计数改为「Skills 7」「MCP 4」（A-N-P3-2）。
- **MCP 4 个，已启用 3**（06B，主时刻 14:22）。全部写在 `C:\Users\lin\.codex\config.toml` 的 `[mcp_servers.<名称>]` 下，传输方式都是 stdio：

| 名称 | 开关 | command | args | env | 备注 |
|---|---|---|---|---|---|
| filesystem | 开 | `npx` | `-y @modelcontextprotocol/server-filesystem D:\work` | 无 | 只开放 D:\work |
| github | 开（06B 选中） | `npx` | `-y @modelcontextprotocol/server-github` | `GITHUB_PERSONAL_ACCESS_TOKEN = ghp_••••a91f`（界面固定 4 个点加末 4 位） | 读 PR 与 issue |
| playwright | 关 | `npx` | `@playwright/mcp@latest` | 无 | 前端回归时再开 |
| context7 | 开 | `npx` | `-y @upstash/context7-mcp` | 无 | 查第三方库文档 |

  - 命令摘要（列表第二行，等宽）：`npx server-filesystem`（目录 D:\work 写在备注里）、`npx server-github`、`npx @playwright/mcp`、`npx context7-mcp`。
  - 关闭开关只写该段的 `enabled = false`，令牌原样留在 config.toml；写入前按 §4 规则备份（主时刻没有发生写入，不占编号）。
  - 导出 Skills 与 MCP 时默认去掉 env 里的密钥与令牌（与 06 标签栏右侧的提示一致）。
  - 依据：R3 评审 P1-2（§5.7 的 MCP 只有页签计数）；数量与 06 状态头「MCP 另有 4 个」一致。

## 14. 版本

| 项 | 值 |
|---|---|
| Chimera++ | 2.8.0 |
| Codex CLI | 0.61.0（9 月 20 日 21:04 安装，从 0.60.2 升级，备份 #0396；**安装体积 41 MB** = `codex.cmd` + `node_modules\@openai\codex\`，13D / 13DD / 13D2 卸载确认「共 41 MB」用这个值）；可升级 0.62.0（9 月 25 日发布）；可回滚 0.60.2（9 月 12 日 09:31 安装，本机缓存 38 MB）；0.59.1（8 月 30 日 18:20 安装，缓存已清理） |
| 运行时检测 | 今天 14:10；运行中 2 个会话 |
| 09C 安装 | 卸载后重装 0.62.0（Node.js 22.11.0 已检测到）：npm 全局到 `C:\Users\lin\AppData\Roaming\npm\`，或独立安装包到 `C:\Users\lin\AppData\Local\Programs\Codex\`；下载 24 / 38 MB |
| 09D 失败 | `npm ERR! code ETIMEDOUT`（registry.npmjs.org 30 秒无响应）；已清理临时文件，未写入配置；日志 `C:\Users\lin\AppData\Roaming\Chimera\logs\codex-install-2026-09-27_1424.log` |

- 依据（R4 B-P3-3）：原稿 13D / 13DD / 13D2 写「共 38 MB」，和 09A「0.60.2 本机缓存 38 MB」、09C「0.62.0 下载 24 / 38 MB」撞号，而且没有来源。0.61.0 安装体积改为 41 MB，38 MB 只保留前两种含义（0.60.2 缓存、0.62.0 下载包，两个不同版本的实测值）。
