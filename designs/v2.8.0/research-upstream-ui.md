# Chimera++ v2.8.0 界面重设计：上游与现有界面前端设计调研

- 调研日期：2026-09-27
- 用途：给 v2.8.0 界面重设计（brief：`product-brief.md`）提供可直接指导设计的对比依据。只做调研，不出设计稿。
- 方法依据：atelier `skills/core/design-forensics.md`（事实分级）、`skills/core/anti-slop.md`（结构指纹、诊断三条）、`references/register-product.md`（product register 判据），中文排版对照 `references/typography-cjk.md`。

## 标注约定（事实与推断分开）

| 标记 | 含义 |
|---|---|
| **[实·码]** | 直接读源码或样式得到的事实，附文件与行号 |
| **[实·图]** | 直接看截图得到的事实，附图片路径 |
| **[实·文]** | README、手册、项目文档里写明的事实 |
| **[推]** | 基于上述事实的推断或设计判断，可能出错 |

证据等级说明：本次**没有启动任何应用，没有运行时 DOM 或 computed CSS**（遵守不编译 Rust、不用浏览器工具的约束）。所以所有 token 都是"源码声明值"，截图里的尺寸是"目视估算"，两者都按 design-forensics 的要求不升级为运行时观测。截图可能落后于源码，凡是二者冲突以源码为准并注明。

CodexPlusPlus 为 AGPL，按净室约束**只看了 README 文本和图片文件**，本报告不出现其源码文件名或函数名。

## 摘要（给设计代理，先读这里）

1. 四个上游的共同俗套：通用后台外壳、当前项靠颜色、用量/路由/体检塞进设置、装饰材质、小字号且不为中文排版、推广位（§4）。
2. 多工具界面唯一的先例是 cc-switch：10 个图标分段切换工具，**切换类与累加类只在 hover 按钮上有区别**。我们要在静止状态下就把两种模式分开（§2.4、§4-3）。
3. 功能对标看 Codex-X：额度弹窗、配置体检"先给修复计划再修"、会话删除"列待删项 + 安全勾选"、导出前提示含密钥。它的越狱类提示词和可编辑 auth.json 不可沿用（§1.2）。
4. 运行时与外观的信息结构看 Codex-App-Manager：状态机英雄区、"选择安装版本"式回滚、卸载保留数据、皮肤"试穿 / 应用 / 还原"与迷你窗口配色预览。它的进场动效和噪点光晕材质不可取（§1.3）。
5. CodexPlusPlus 值得借的是"模式 / 用途 / 认证边界"的说明方式和行内协议元信息（§1.4）。
6. 现有界面的核心问题：地球占内容区六成高度，切换线路被挤进横向卡片条；外壳占 27% 高度；约 3/4 字号声明 ≤12px；没有深色；token 与 DESIGN.md 漂移；IA 放不下 10 个工具（§1.5、§5）。
7. 多官方账号 IA 本调研倾向"每账号一条线路 + 官方组置顶"（§2.5，属推断，待设计评审定）。
8. 签名元素建议用"路径条"替代地球，交互签名用"写入预告 + 可撤销切换 + Ctrl+K"（§4）。

---

## 1. 逐项目盘点

### 1.1 cc-switch（MIT，v3.20.4，本地提交 `a06a41e`）

Chimera++ 从它分叉。它现在已经管 10 个工具，工具清单与我们的注册表完全一致（Claude Code、Claude Desktop、Codex、Gemini、Grok Build、OpenCode、OpenClaw、Hermes、Pi、MiniMax Code）[实·码 `src/components/AppSwitcher.tsx` L30-54]。所以它是"多工具界面到底会长成什么样"的最直接样本，也是我们最需要拉开距离的对象。

#### 信息架构与导航

- **单一主页 + 整屏替换的轮辐结构。** 主页永远是"当前工具的供应商列表"；其余 13 个视图（设置、提示词、Skills、Skills 发现、MCP、Agents、统一供应商、会话、OpenClaw 的 workspace/env/tools/agents、Hermes Memory）全部是整屏替换，左上一个返回箭头回主页 [实·码 `src/App.tsx` L116-130、L1307-1350；`src/components/common/FullScreenPanel.tsx`]。没有持久导航，进入子页后看不到自己在哪个工具下。
- **工具切换器在顶栏右侧**，是一个只有图标的分段控件，宽度不够时把溢出的工具收进"更多"弹层，并保证当前工具始终可见 [实·码 `AppSwitcher.tsx` L124-168]。Claude Code 与 Claude Desktop 用同一个 logo，只靠右下角 11px 的终端/显示器角标区分 [实·码 `AppSwitcher.tsx` L15-20、L77-97]。
- **功能入口是顶栏中间的一组无文字图标**（扳手=Skills、书=提示词、时钟=会话、MCP 图标），随当前工具变化：Hermes 换成 Skills/Memory/WebUI/MCP，OpenClaw 换成工作区/环境变量/工具/Agents/会话；不支持的入口以宽度 0 的动画收起 [实·码 `App.tsx` L1592-1757]。好处是不会点进空页（与我们 brief §4 的要求一致），坏处是图标位置随工具跳动、没有文字。
- **顶栏塞满**：品牌字、设置、更新徽标、（接管时才出现的）用量图标、代理开关、故障转移开关、项目档案切换、10 个工具、4 个功能图标、橙色加号 [实·码 `App.tsx` L1287-1774；实·图 `docs/images/codex-kimi-routing/01-codex-providers-require-routing.png`]。
- **用量藏在设置的一个 Tab 里**，只有代理接管时顶栏才出现用量快捷图标 [实·码 `App.tsx` L1378-1393]。设置内有 6 个 Tab：通用/路由/认证/高级/使用统计/关于 [实·码 `src/components/settings/SettingsPage.tsx` L228-239；实·图 `docs/images/codex-claude-routing/04-local-route-codex-takeover.png`]。
- 上次停留的工具与视图写入 localStorage，重开恢复 [实·码 `App.tsx` L141-174]。
- 托盘是原生菜单，按工具分组、当前项打勾 [实·图 `docs/user-manual/assets/image-20260108004348993.png`]。

#### 主要界面与关键组件

| 界面 | 做法 | 证据 |
|---|---|---|
| 供应商列表 | 每条一张卡：拖拽手柄、32px 图标块、名称（16px 半粗）、蓝色 URL 链接、右侧用量/余额、hover 才出现的操作组（启用、编辑、复制、测速、用量脚本、删除） | [实·码 `src/components/providers/ProviderCard.tsx` L380-747]；[实·图 `assets/screenshots/main-zh.png`、`docs/user-manual/assets/image-20260108004946288.png`] |
| 当前线路 | 蓝色边框 + 左到右的淡蓝渐变底；代理接管时换绿色。旧截图还有"当前使用"绿色小标签，新截图里已不见 | [实·码 `ProviderCard.tsx` L381-403]；[实·图 `docs/user-manual/assets/claude-desktop-panel.png`] |
| 路由能力徽章 | "需要路由""不支持路由"小徽章贴在名称后 | [实·码 `ProviderCard.tsx` L459-493]；[实·图 `docs/images/codex-kimi-routing/01-...png`] |
| 添加供应商 | 整屏页：预设 chip 云（部分带金色星标，即合作伙伴）、居中大图标、名称/备注/官网/密钥表单、底部取消/添加 | [实·图 `assets/screenshots/add-zh.png`]；[实·码 `src/components/providers/forms/ProviderPresetSelector.tsx` L109-125、L427-453] |
| 官方 Codex 登录 | 编辑页里"认证状态 · 1 个账号"、账号下拉、"已登录账号"列表（默认/已选中标签）、"添加其他账号"。即**一条官方线路 + 账号选择器**的信息架构 | [实·图 `docs/images/claude-codex-routing/03-codex-oauth-form.png`] |
| 请求地址测速 | 端点列表，每行右侧 mono 字体延迟（绿 297ms、红 2146ms）+ 状态码，顶部"自动选择"与"测速"按钮 | [实·图 `docs/user-manual/assets/image-20260108005327817.png`] |
| MCP / Skills | 每个条目右侧竖排 Claude/Codex/Gemini 三个开关；顶部一条汇总"已配置 1 个 MCP 服务器 · Claude: 0 · Codex: 1 · Gemini: 0" | [实·图 `image-20260108005723522.png`、`image-20260108010253926.png`] |
| Skills 仓库 | 仓库 URL + 分支表单，下方已添加仓库列表（"识别到 27 个技能"标签） | [实·图 `image-20260108010308060.png`] |
| 提示词 | 列表：左开关、名称/说明、右编辑/删除；顶部"共 3 个提示词 · 已启用：…" | [实·图 `image-20260108010110382.png`] |
| 用量 | 四张指标卡（每张右上一个彩色图标方块）+ 双轴折线趋势图 + 24 小时/7 天/30 天分段 | [实·图 `image-20260108011730105.png`、`image-20260108011742847.png`] |
| 会话 | 320px 列表 + 详情双栏；搜索、按供应商筛选、分组/平铺、批量选择删除、复制恢复命令、消息目录 | [实·码 `src/components/sessions/SessionManagerPage.tsx` L853、L1009-1802 的文案键] |
| 深链导入 | 字段逐项展示，敏感值遮蔽为"前 4 位 + 12 个星号"；对环境变量劫持、私网端点、shell 命令做风险标注，**只提示不拦截**（注释写明"补的是可见性，不是黑名单"） | [实·码 `src/utils/deeplinkRisk.ts` L1-60；`src/components/DeepLinkImportDialog.tsx` L262-756] |
| 空状态 | 虚线框、圆形图标、标题、说明、"导入当前配置"主按钮 +"添加供应商"次按钮 | [实·码 `src/components/providers/ProviderEmptyState.tsx`] |
| 确认框 | 宽 384px（max-w-sm），destructive/info 两种，可带一个复选框 | [实·码 `src/components/ConfirmDialog.tsx` L21-95] |

#### 视觉语言

- **组件库**：shadcn/ui + Tailwind，HSL 变量 token [实·码 `src/index.css` L5-61；`tailwind.config.cjs`]。
- **配色**：主色 `hsl(210 100% 56%)`（苹果系统蓝一类），Tailwind 另把 blue-500 定为 `#0A84FF`、灰阶取苹果系统灰 [实·码 `index.css` L14、`tailwind.config.cjs` L41-58]。深色底 `hsl(240 5% 12%)`、卡片 16% [实·码 `index.css` L35-40]。实际画面上同时出现蓝（品牌字、链接、主按钮）、橙（加号 FAB）、绿（启用/代理/余额）、橙（移除）、紫与靛（OMO 徽章）、金色星标 [实·图 + 实·码 `ProviderActions.tsx` L146-258]。组件里大量直接写 `bg-emerald-500`、`bg-orange-100` 这类原始色，而不是语义 token [实·码 同上]。
- **字体**：系统栈 `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, …`，**没有任何中文字体**（无 PingFang SC、Microsoft YaHei）[实·码 `tailwind.config.cjs` L85-93]。正文 `text-sm`（14px）、行高 1.5 [实·码 `index.css` L131-142]。按 `typography-cjk.md`，中文正文下限 15px、行高 1.7 以上，这两项都不达标 [推]。
- **圆角**：`--radius: 0.5rem`，卡片 `rounded-xl`（扩展后 14px）[实·码 `tailwind.config.cjs` L77-82、`ProviderCard.tsx` L382]。
- **阴影与材质**：浅色阴影轻；但定义了 `.glass`、`.glass-card`（backdrop-filter blur 10/20px），深色 `.glass-card` 用 `0 8px 32px rgba(0,0,0,.37)` 配 1px 边框，顶栏 `backdrop-blur-md` [实·码 `index.css` L63-114；`App.tsx` L1288]。这正是 register-product §10 点名的"玻璃拟态作默认面板"和"大模糊阴影配 1px 边框"。
- **密度**：卡片 `p-4` 两行信息，目视估算每行 72-80px，1140 宽窗口一屏约 6-7 条 [推，依据截图比例]。按 register-product §5 属于偏松。
- **图标**：lucide-react 线性图标 + 大量彩色品牌 logo，另有全屏图标选择器 [实·图 `image-20260108004734882.png`]。
- **动效**：framer-motion 视图切换淡入 0.2s；卡片 `transition-all duration-300`，图标 hover 放大 1.05，拖拽时整卡放大 1.05；FullScreenPanel 尊重 `useReducedMotion` [实·码 `App.tsx` L1192-1203、`ProviderCard.tsx` L382-422、`FullScreenPanel.tsx` L68-129]。
- **滚动条全局隐藏**（`scrollbar-width: none` 与 `::-webkit-scrollbar { display: none }`）[实·码 `index.css` L125-129、L220-222]。
- 焦点环：`outline-2 outline-blue-500 outline-offset-2` [实·码 `index.css` L224-226]。

#### 交互模式

- **切换**：hover 卡片出现"启用"按钮（播放图标）；当前线路按钮变灰"使用中"并禁用；托盘也能切 [实·码 `ProviderActions.tsx` L228-258]。
- **累加类工具**（OpenCode、OpenClaw、Hermes、Pi）：同一位置的主按钮换成"添加"（绿）/"移除"（橙），Pi 用"启用" [实·码 `ProviderActions.tsx` L107-205]。也就是说，**切换类与累加类的区别只体现在 hover 才出现的那个按钮的颜色和字上**，列表静止时两类看起来一样 [推]。
- **编辑**：整屏页替换，底部固定"取消/保存"栏 [实·图 `add-zh.png`、`03-codex-oauth-form.png`]。
- **确认**：模态确认框；删除当前线路时删除按钮半透明禁用，要先切走 [实·文 `docs/user-manual/zh/1-getting-started/1.3-interface.md` 按钮说明表]。
- **反馈**：sonner toast；测速中按钮换旋转图标；余额旁显示"刚刚"与刷新按钮 [实·码 `ProviderActions.tsx` L426-430；实·图 `main-zh.png`]。
- **快捷键**：Ctrl/Cmd+, 打开设置、Ctrl/Cmd+F 搜索供应商、Esc 返回 [实·文 `1.3-interface.md` 快捷键表；实·码 `FullScreenPanel.tsx` L86-110]。
- 拖拽排序 [实·码 `ProviderCard.tsx` L406-420]。

#### 值得吸收

1. **"可见性而非黑名单"的深链确认原则**：逐字段展示、敏感值遮蔽、按风险类型标注但不拦截。直接对应 brief §5-13 的深链确认框，我们再补上"目标文件绝对路径"即可 [实·码 `deeplinkRisk.ts` 注释]。
2. **端点测速的呈现**：延迟用等宽数字、颜色加数值、附状态码，是"测速/状态"最省空间的写法 [实·图 `image-20260108005327817.png`]。我们要补一个非颜色的等级标记。
3. **功能入口随工具能力增减，不出现空页**。方向对，但要换成有文字、位置稳定的表达 [实·码 `App.tsx` L1701-1753]。
4. **会话双栏 + 批量模式 + 复制恢复命令** [实·码 `SessionManagerPage.tsx`]。
5. **顶部计数汇总行**（"共 3 个 · 已启用 …"）给列表一个一句话的状态摘要，比指标卡便宜 [实·图 `image-20260108010110382.png`]。
6. **官方账号"一条官方线路 + 账号选择器"已有先例**，可作为 brief §5-5 二选一时的参考样本 [实·图 `03-codex-oauth-form.png`]。
7. `docs/pi-frontend-uiux-guidelines-zh.md` 里有几条可直接照抄的产品原则：默认路径短、入口少、术语清楚；固定术语表（请求地址、接口格式、配置 JSON…）；不用"1、2、3"编号步骤；**前端只展示后端已稳定实现的状态** [实·文 该文 §1、§4.3、§7]。

#### 应该避免

1. **操作按钮只在 hover 时出现**（`opacity-0 pointer-events-none`，仅靠 `group-focus-within` 兜底）[实·码 `ProviderCard.tsx` L693]。register-product §6 明确禁止；触屏和新用户根本不知道有"启用"。
2. **当前线路主要靠颜色（蓝边框 + 渐变）表达**，形状与文字信号在新版里弱化 [实·码 `ProviderCard.tsx` L381-403；实·图 `claude-desktop-panel.png`]。
3. **切换类与累加类静止时不可区分**（见上）。
4. **工具切换器只有图标**，10 个彩色 logo 排成一排，还要靠 11px 角标区分两个 Claude [实·码 `AppSwitcher.tsx`]。
5. **顶栏信息过载**，1140 宽时工具要被折叠进"更多"[实·码 `App.tsx` L1429-1439 注释]。
6. **推广位**：预设按"官方 → 头部合作 → 合作 → 其他"排序并打星标，Codex 预设里有 22 处 `aff=` 推广参数，README 有大量赞助 banner [实·码 `ProviderPresetSelector.tsx` L109-125；`src/config/codexProviderPresets.ts`（grep 计数 22）；实·文 `README_ZH.md` L28-200]。这是我们 PRODUCT.md 的明确反模式。
7. **玻璃拟态、大模糊阴影、渐变底、组件里的原始色值** [实·码 `index.css` L63-114、`ProviderActions.tsx`]。
8. **滚动条全局隐藏**：长列表没有位置感，也不利于可访问性 [实·码 `index.css` L125-129]。
9. **中文排版不达标**：无中文字体栈、14px 正文 [实·码 `tailwind.config.cjs` L85-93、`index.css` L139]。
10. **用量是设置里的第三层**，与"信息一眼看清"相悖 [实·码 `App.tsx` L1378-1393]。
11. **13 个整屏子页 + 返回箭头**，没有"我在哪"的持久指示 [实·码 `App.tsx` L1307-1350]。

**结构指纹**（anti-slop 格式）[推]：顶栏工具条 + 单列全宽卡片列表 + 整屏子页；无签名元素，唯一的记忆点是橙色圆形加号；密度偏松；字体单一系统栈；材质是白底轻阴影偶有玻璃。

---

### 1.2 Codex-X（MIT，桌面端 `apps/desktop` v0.3.21，本地提交 `73f0c4c`）

只管 Codex 的单工具管理器，Tauri 2 + React 18，**不用组件库，也不用 Tailwind**，全部手写 CSS（16 个样式文件，约 8000 行）[实·码 `apps/desktop/package.json`；`apps/desktop/src/styles/*.css`]。它覆盖了我们 v2.8.0 要新增的大部分 Codex 能力（提示词中心、Skills/MCP、配置体检、多官方账号、会话、用量），是**功能对标**最重要的样本。截图有两代：v0.2.x 深色玻璃风 [实·图 `docs/screenshots/app/preview.png`]，v0.3.x 浅色侧栏风 [实·图 `docs/screenshots/app/new-ui/*.png`]，下文以 v0.3.x 为准。

#### 信息架构与导航

- **左侧固定侧栏 + 右侧内容区**，侧栏 256px，窗口窄于 1100px 时收成 78px 图标栏；整个外壳 `min-width: 1180px` [实·码 `styles/app-shell.css` L14-20、L511-513]。这比我们的最小窗口 1140 还宽 [推]。
- **8 个一级入口，图标 + 文字**：概览、供应商、会话管理、技能和MCP、指令提示词、TOML、设置、关于 [实·码 `components/AppShell.tsx` L42-51]。当前项：浅蓝底 + 左侧 4px 竖条，并设 `aria-current="page"` [实·码 `AppShell.tsx` L161-173；`app-shell.css` L243-245；实·图 `new-ui/prompts.png`]。
- **侧栏底部常驻环境信息**：Codex CLI 版本号、外观模式开关 [实·码 `AppShell.tsx` L178-205；实·图 `new-ui/prompts.png`]。品牌区有应用版本和"有更新"图标按钮 [实·码 `AppShell.tsx` L132-154]。
- **用量与路由藏在设置的 Tab 里**：设置 = 通用设置 / 用量统计 / 路由与故障转移，Tab 支持方向键、Home/End 的 roving tabindex [实·码 `pages/UtilityPages.tsx` L191-201]。
- **配置体检挂在设置 → 通用设置**，同时在检出问题时主动弹一个不自动消失的提醒卡 [实·码 `components/ConfigHealthToast.tsx` L15-33]。
- **二级页（添加提示词、编辑供应商）在内容区内替换**，右上角"返回"按钮，侧栏仍在 [实·图 `new-ui/prompt-form.png`；实·码 `pages/ProvidersPage.tsx` L575-589]。

#### 主要界面与关键组件

| 界面 | 做法 | 证据 |
|---|---|---|
| 页头（全站统一） | 一行 10px 大写宽字距英文小标（PROMPT INJECTION、SKILLS / MCP、CUSTOM PROMPT）+ 约 22px 粗体中文标题 + 一句说明；右侧次按钮（描边）若干 + 一个蓝色实心主按钮 | [实·码 `styles/providers-page.css` L49-56]；[实·图 `new-ui/prompts.png`、`new-ui/skills-mcp.png`] |
| 供应商列表 | 行卡（最小高 78px、圆角 16px）：首字母或 OpenAI logo 头像、名称 + 来源徽章（官方为天蓝小徽章）、等宽字体的 Base URL、官方行额外显示账号徽章（邮箱 + 套餐）；右侧"当前"徽章（圆点 + 字）、"启用"次按钮、额度/测速/编辑/复制/删除图标按钮，**常驻不隐藏** | [实·码 `pages/ProvidersPage.tsx` L456-530；`styles/providers-page.css` L199-222、L339-372] |
| 多官方账号 | **每个官方登录是一行独立线路**（source=official），行内显示邮箱与套餐徽章（免费/Plus/Pro/企业用不同图标）；额度按需点开弹窗查询；默认官方配置不可删除 | [实·码 `ProvidersPage.tsx` L462-525；`components/OfficialAccountBadge.tsx`] |
| 额度弹窗 | 账号 + 套餐头；"可用重置 N 次"；主额度窗口：剩余百分比大数字、进度条（带 `role=progressbar` 与 aria 值）、已用百分比、"X 小时后重置"+ 精确时间；其他额度折叠；"查询于 …"与"以最近一次查询为准"脚注；刷新失败时**保留上次结果并标注** | [实·码 `components/OfficialQuotaDialog.tsx` L104-212] |
| 官方线路编辑 | 信息栅格（官方地址、auth 路径、当前）、名称/模型、**可编辑的 auth.json 文本框**与完整 config.toml 文本框、"开启 1M 上下文窗口"开关紧贴 TOML 标题 | [实·码 `ProvidersPage.tsx` L591-660、L227-330]；[实·文 `README.md`"查看 / 编辑 ChatGPT 登录态 Auth"] |
| 模型映射 | "模型映射（可选）"：添加当前模型、导入已获取模型、添加空行；上限 64 个且当前默认模型计入；空状态说明"留空表示不设置" | [实·码 `components/ProviderModelMappings.tsx` L12-20] |
| 提示词中心 | 顶部"当前状态"条（绿点 + 当前模板 + "追加到 AGENTS.md"标签 + 一句解释）与"启用方式"二选一（保留原提示词 / 替换原提示词，带帮助气泡）；分类分段控件 + "分类管理"；**三列卡片网格**，每卡文件图标、标题、开关、说明 | [实·图 `new-ui/prompts.png`]；[实·码 `pages/PromptsPage.tsx` L98-140] |
| 提示词表单 | 名称 + 文件名两栏、大号 Markdown 文本框，底部右侧"保存" | [实·图 `new-ui/prompt-form.png`] |
| 分类管理 | 模态：分类折叠列表带计数徽章 + 虚线"新增分类" | [实·图 `new-ui/prompt-categories.png`] |
| Skills 与 MCP | 一页两 Tab（MCP 7 / Skills 69，计数胶囊）；一句"启用后会写入 Codex config.toml"；列表行 = 等宽名称 + 右侧开关；页头动作：刷新、导入已有、从 ZIP 安装、检查更新；导入前先弹"确认导入已有内容"预览；每项可加备注（1000 字上限）；导出 ZIP 的提示写明"MCP 包可能包含连接密钥" | [实·图 `new-ui/skills-mcp.png`]；[实·码 `pages/SkillsMcpPage.tsx` L57-99] |
| 会话 | 页头"同步到 [当前供应商]" + 检查/同步两按钮；摘要行"有 N 条会话需要同步"；类表格列表：全选、按项目分组（组级复选）、"显示内部会话 (N)"开关、搜索（标题/项目/供应商/ID）、导出选中（单个 Markdown、多个 ZIP）、"永久删除 N 条" | [实·码 `pages/SessionManagementPage.tsx` L160-214、L343-506] |
| 删除会话确认 | 标题"永久删除 N 条会话"、"此操作不可恢复"、会一并删除子会话、先关闭正在用的 Codex；**列出待删项（超过 8 条折叠计数）**；**必须勾选"我已关闭其他正在使用这些会话的 Codex 窗口或 CLI"**才能确认 | [实·码 `SessionManagementPage.tsx` L203-214、L285-340] |
| 用量 | 设置里的 Tab。总量大卡（总词元 + 输入/缓存/输出构成条 + 日期范围）、若干指标卡（含缓存命中率）、手绘 SVG 堆叠柱状趋势（可点某天看明细，另有折叠的逐日表格）、模型分布环图（点模型即筛选）、最近主会话表格；"本地数据"徽章；部分数据警告、错误时保留旧数据、空状态、加载骨架都有；脚注写刷新时间、时区、扫描文件数 | [实·码 `pages/UsageStatisticsPage.tsx` L124-327] |
| 配置体检 | 状态胶囊（未检查/检查中/配置正常/发现问题/尚无配置/暂时无法检查）；问题列表（图标 + 标题 + 说明）；**"点击修复后，将进行以下调整："修复计划预览**；"检查不会修改配置。点击修复后，会先自动备份"；不能自动修的写明"不会猜测或覆盖" | [实·码 `components/ConfigHealthPanel.tsx` L18-87] |
| 重启确认 | 设置里"重启 Codex"按钮，确认框写明目标"Codex（ChatGPT）桌面客户端"，初始焦点在取消 | [实·码 `pages/UtilityPages.tsx` L180-316] |
| 概览（旧版） | 深色玻璃卡片：配置文件/供应商/提示词状态/认证文件四格 + "当前 Codex 配置"键值表 + 快捷操作 | [实·图 `docs/screenshots/app/preview.png`] |

#### 视觉语言

- **配色**：浅色画布 `#f3f4f6`、主色 `#2563eb`、正文 `#172033`/`#202226` [实·码 `styles/base.css` L3-4；`styles/ui-primitives.css` L24-40]；深色画布 `#24262b`、侧栏 `#2a2d33`、蓝 `#76a8ff` [实·码 `styles/dark-theme.css` L1-16]。眉题有蓝有紫，提示词卡的文件图标是紫色 [实·图 `new-ui/prompts.png`]。旧版是紫蓝渐变按钮 + 深色玻璃 [实·图 `preview.png`]。
- **token 体系弱**：只有 `ui-primitives.css` 的十几个 `--ui-*` 变量；各页 CSS 与 1145 行的深色覆盖文件里有大量原始色值（grep 计数：深色覆盖 190 处、Skills/提示词页 181 处、会话页 107 处）[实·码 `styles/*.css`]。深色模式靠逐组件覆盖选择器实现 [实·码 `dark-theme.css`]。
- **字体**：`Inter, ui-sans-serif, system-ui, -apple-system, …, "Segoe UI"`，**没有中文字体** [实·码 `base.css` L5]。字号普遍偏小：导航 13px、按钮 12-13px、徽章 10-11px、眉题 10px [实·码 `app-shell.css` L196、`ui-primitives.css` L86-88、L238-239]。用了 620、680、720 这类中间字重 [实·码 `base.css` L96、L110、L115]，按 `typography-cjk.md` 中文只有三档，会被回退或合成 [推]。
- **圆角**：基础 8px，行卡与提示词卡 16px，个别 24px [实·码 `ui-primitives.css` L19；`providers-page.css` L208；`skills-prompts-pages.css` L247、L1196]。
- **阴影**：主按钮带彩色投影 `0 8px 18px`（accent 24%）；弹窗与提醒卡 `0 12px 28-32px`；深色弹窗最大 `0 28px 80px` [实·码 `ui-primitives.css` L95、L114；`app-dialogs.css` L18-36；`dark-theme.css` L141]。
- **密度**：侧栏 + 大页头占去约 1/3 高度，Skills/MCP 一屏只放下 5-6 行，提示词卡片一屏 5 张 [实·图 `new-ui/skills-mcp.png`、`prompts.png`]。属于中偏松 [推]。
- **图标**：lucide-react，线宽 1.8-1.9 [实·码 `AppShell.tsx` L171]。
- **动效**：页面切换退出 250ms + 进入 250ms（合计 500ms），尊重 `prefers-reduced-motion` [实·码 `components/PageTransition.tsx` L15-80；`app-shell.css` L420-460]。按钮、开关过渡 140-160ms [实·码 `ui-primitives.css` L60、L203]。

#### 交互模式

- **切换线路**：每行常驻"启用"按钮；当前行显示"当前"徽章并禁用启用按钮 [实·码 `ProvidersPage.tsx` L481-490]。启用后 toast 提示"请重启 Codex 更新模型菜单" [实·码 `main.tsx` L1943-1959]。
- **复制线路**：点"复制"直接生成副本，不确认也不进编辑页 [实·文 `README.md` §2]。
- **启停**：提示词、Skills、MCP 一律一个开关，写入方式由页面级"启用方式"决定 [实·图 `prompts.png`、`skills-mcp.png`]。
- **确认**：统一 `ModalShell`，忙碌时禁用遮罩关闭与 Esc，初始焦点放在"取消" [实·码 `ProvidersPage.tsx` L539-570；`components/ui/ModalShell.tsx`]。高风险删除加"我已关闭…"勾选 [实·码 `SessionManagementPage.tsx` L334-338]。
- **反馈**：按钮内换成旋转图标并改文案（"检查中…""同步中…"）；状态胶囊 `role=status aria-live=polite`；错误 `role=alert` [实·码 `ConfigHealthPanel.tsx` L33-57；`UsageStatisticsPage.tsx` L297-304]。

#### 值得吸收

1. **额度弹窗的完整状态模型**：按需查询、剩余百分比 + 进度条 + 重置倒计时 + 精确时间、"查询于"、失败保留上次结果并说明 [实·码 `OfficialQuotaDialog.tsx`]。可以直接作为 brief §5-5"额度展示（按需查询）"的内容规格。
2. **配置体检"先给修复计划、再修复、修复前备份"的三段式**，以及"不会猜测或覆盖无法确认的内容"的措辞 [实·码 `ConfigHealthPanel.tsx` L66-79]。
3. **会话删除的"列出待删项 + 安全勾选"**，比单纯的"确定删除？"可靠 [实·码 `SessionManagementPage.tsx` L311-340]。
4. **导出按钮上的风险提示**："MCP 包可能包含连接密钥" [实·码 `SkillsMcpPage.tsx` L67]。brief §5-8 要求会话导出前提示可能含密钥，这是同类写法。
5. **提示词中心把"当前生效什么、用什么方式写入"放在列表上方**，而不是藏进每张卡 [实·图 `prompts.png`]。
6. **用量页的数据诚实**：本地数据徽章、时区、扫描文件数、部分数据警告；"子代理用量归入所属主会话" [实·码 `UsageStatisticsPage.tsx` L289-327；实·文 `README.md` 功能表]。
7. **1M 上下文开关紧贴 TOML 标题**，开关和它影响的配置在同一视野 [实·码 `ProvidersPage.tsx` L653-657]。
8. 侧栏底部常驻 Codex CLI 版本，这是运行时状态的最省成本露出 [实·码 `AppShell.tsx` L180-186]。
9. 可访问性细节做得扎实：`aria-current`、roving tabindex、progressbar 的 aria 值、live region [实·码 见上]。

#### 应该避免

1. **越狱类内容**：提示词中心的示例分类与内置模板包含越狱/"破甲"类内容，README 另有相关导航与效果截图 [实·文 `README.md` §1、§6；实·图 `new-ui/prompts.png`、`new-ui/prompt-categories.png`]。按 brief §5-6，结构可参考，**分类、示例数据、文案一律不可沿用**。仓库 `docs/screenshots/prompt-effects/` 下的效果截图与界面设计无关，本次刻意未查看。
2. **官方凭据明文可编辑**：官方线路编辑页直接给出 auth.json 文本框 [实·码 `ProvidersPage.tsx` L68-73、L591-660]，与 brief §6"官方账号令牌永远不显示"正面冲突。
3. **每个区块顶上一行小号大写宽字距英文眉题**：register-product §10 点名的俗套；中文界面里夹英文大写眉题，读起来是装饰不是信息 [实·码 `providers-page.css` L49-56]。
4. **三列卡片网格装开关列表**：提示词卡片里只有标题、开关和一句话，用卡片网格浪费高度，也让"当前启用"难以一眼扫到 [实·图 `prompts.png`]。
5. **用量、路由、体检都在设置第二层** [实·码 `UtilityPages.tsx` L191-201]。
6. **字号偏小、无中文字体、中间字重**（见视觉语言）。
7. **原始色值 + 逐组件深色覆盖**，维护成本高，也是我们"单一令牌体系"约束要防的 [实·码 `dark-theme.css`]。
8. **页面切换合计 500ms**，超过 register-product §4 建议的 150-250ms，且退出不比进入快 [实·码 `app-shell.css` L454-460]。
9. `min-width: 1180px` 大于我们的 1140 最小窗口，布局不能直接照搬 [实·码 `app-shell.css` L17]。

**结构指纹** [推]：左侧 8 项文字侧栏 + 眉题/大标题/右上按钮的页头 + 分段 Tab + 卡片或行卡列表；签名元素是侧栏底部的"Codex CLI 版本 + 外观开关"小面板；密度中偏松；字体 Inter + 系统；材质浅灰画布、白卡片、16px 圆角、彩色投影主按钮。

---

### 1.3 Codex-App-Manager（MIT，v0.5.6，本地提交 `3c5fefa`）

**有 GUI**。它只做官方 Codex 桌面应用的"安装 / 更新 / 卸载"生命周期，外加"皮肤"（素材化主题）运行时 [实·文 `README.md` 能力一览；`docs/product-design.md` §1]。React 19 + GSAP，Tauri 无边框透明窗口 [实·码 `package.json`；`src-tauri/tauri.conf.json` L20-27]。它是 brief §5-10"Codex 运行时 + 外观"的**唯一直接样本**。

截图情况：仓库里**没有应用界面截图**。`website/public/img/hero-*.webp` 是官网背景云图，不是界面 [实·图 `website/public/img/hero-light-1600.webp`、`hero-dark-1600.webp`]。README 引用了两张远程皮肤预览图（未下载）：`https://raw.githubusercontent.com/Wangnov/awesome-codex-skins/main/skins/guts-terminal/previews/home.webp`、`https://raw.githubusercontent.com/Wangnov/awesome-codex-skins/main/skins/rei-eva00/previews/home.webp` [实·文 `README.md` L130-132]。因此本节视觉描述全部来自源码，属"声明值"。

#### 信息架构与导航

- **两种窗口形态**：默认是 400×640、不可调尺寸的"弹层卡片"（compact）；可展开成"工作台"（expanded），左侧多出一张 208px 的浮动导航卡 [实·码 `tauri.conf.json` L20-22；`src/app/styles.css` L286-300、L357-367；`src/app/Rail.tsx`]。
- **导航极浅**：导航卡只有 3 项（主页、皮肤、设置）；关于、卸载、Codex 配置都挂在设置下，导航卡上高亮"设置" [实·码 `Rail.tsx` L8-11、L33-37；`src/app/App.tsx` L17、L71-113]。
- **主页常驻不卸载**：返回主页不重新检查，直接显示上次状态 [实·码 `App.tsx` L40-53]。
- **操作进行中锁导航**：进度页挂载时导航卡按钮禁用，防止并发操作 [实·码 `Rail.tsx` L26-31、L55]。
- 视图切换后主动把键盘焦点放到新页面的首个目标 [实·码 `App.tsx` L19-63]。

#### 主要界面与关键组件

| 界面 | 做法 | 证据 |
|---|---|---|
| 主页（状态机式英雄区） | 一个 96px 发光浮雕圆章 + 大标题 + 一行副信息，按状态切换：正在检查 / 检查失败 / 未检测到 Codex / 已安装（本应用管理或外部安装）/ 有新版本 / 检测到外部安装 / 已是最新（"官方版本 · 刚刚检查"）。检查中保持同样行数，避免下方内容跳动 | [实·码 `src/app/views/Home.tsx` L1085-1154；`styles.css` L1532-1640] |
| 版本信息 | 圆章下方一组键值行：新版本、发布时间、更新大小、当前版本、安装位置（等宽、完整路径 + title） | [实·码 `Home.tsx` L1156-1208] |
| 主操作 | 大号主按钮 + 幽灵次按钮，随状态变化：安装 Codex / 立即更新 + 重新检查 / 启动 Codex + 重新检查 / 开始管理（接管外部安装）；检查失败时仍给"启动"和"重试" | [实·码 `Home.tsx` L1210-1366] |
| 次级入口 | "选择安装版本…"（历史版本 = 回滚）；"已经安装了 Codex？手动选择位置"；"跳过当前（只跳过 x.y）" | [实·码 `Home.tsx` L1368-1410；`src/app/i18n.tsx` L173-199] |
| 更新确认 | 底部弹出的 Sheet：圆章 + "更新到 {version}?" + "更新时会关闭 Codex，完成后自动重启，大约一分钟。若 Codex 弹出退出确认框，请在 Codex 中点击确认。" | [实·码 `Home.tsx` L1423-1443；`i18n.tsx` confirm.*] |
| 进度 | 来源（"正在从 {source} 下载"）、暂停/继续/取消、"当前阶段不能取消"、"下载完成，正在安装，请勿关闭"；完成横幅"已更新 {from} → {to}"；失败"更新未完成，已恢复到原版本" | [实·码 `src/app/views/ProgressScreen.tsx`；`i18n.tsx` progress.*、success.*] |
| 版本选择（回滚） | 按设备架构筛选的历史版本：推荐 / 当前 / 将安装 / 已验证兼容标签；也可导入本地官方安装包"验证并安装"；确认文案"将把 {current} 更换为 {target}。Codex 用户数据会保留。"；提示"避免安装后立即被 Codex 更新回最新版" | [实·码 `src/app/views/InstallOtherVersion.tsx`；`i18n.tsx` versionPicker.*] |
| 卸载 | "保留我的数据"默认选项，显示数据位置（复制路径 / 打开目录），并提示"此文件夹可能也被 Codex CLI 或其他客户端使用"；部分失败时**只重试失败的那一步**（清理快捷方式、清除托管记录、清除用户数据） | [实·码 `src/app/views/Uninstall.tsx`；`i18n.tsx` uninstall.*] |
| 修复与恢复 | 设置里的"修复与恢复"区："仅在设置或管理异常时使用"，状态为"正常 / 需处理" | [实·码 `i18n.tsx` settings.health.*] |
| 更新源 | 自动（推荐）/ 镜像 / 官方直连 / 自定义 https，文案写明"自动选用可用的更新源（非网速测速）" | [实·码 `i18n.tsx` settings.source.*] |
| 皮肤 | 本地 / 商店两 Tab，卡片与列表两种视图，搜索、分类、分组、多选删除；卡片封面优先用真机截图（懒加载、可放大），没有截图时**用皮肤自己的配色画一个迷你 Codex 窗口**（侧栏条、两行文字条、带发送键的输入框）；三级承诺：**试穿**（热切换、不落盘、随时还原）→ **应用（重启 Codex）**（持久，含原生 accent/字体）→ **还原原生外观**；状态"使用中 / 试穿中"；"制作时在 Codex {v} 上验收通过" | [实·码 `src/app/views/CodexThemes.tsx` L55-110、L787-832；`i18n.tsx` themes.*；实·文 `README.md` Codex 主题皮肤] |
| Codex 配置管理 | 只有一个圆章 + "即将支持"的占位页 | [实·码 `src/app/views/CodexConfig.tsx`] |
| 错误文案 | 每类错误都给下一步："磁盘空间不足，请清理后重试""安装未完成。已保留现有 Codex，请展开详情后重试" | [实·码 `i18n.tsx` error.*] |

#### 视觉语言

- **设计系统写得最完整的一个**：文件头自述"温润材质感"，一个自上而下的光源；OKLCH 调色，中性色向品牌色相 274（蓝紫）偏移；**深色为主**，浅色是完整对等版本而非反相 [实·码 `styles.css` L1-10、L76-190]。
- **token 齐全**：圆角 9/12/16/22px + 胶囊；4pt 间距 4-48；固定 rem 字号阶梯 11/12/13/14/16/19/23/38；缓动四条；层级 `--elev-1/2/3`（顶部高光 + 双层带色阴影）；语义色 success/amber/danger 各带 tint [实·码 `styles.css` L12-75、L118-138]。
- **字体**：`ui-rounded, "SF Pro Rounded", -apple-system, …, "Segoe UI Variable Display", "Segoe UI", system-ui, "PingFang SC", "Microsoft YaHei"`，拉丁在前、中文在后，顺序正确；等宽另设一栈 [实·码 `styles.css` L35-40]。但正文 14px、标题字重 720、`letter-spacing: -0.022em` [实·码 `styles.css` L1608-1614]，按 `typography-cjk.md` 中文不应负字距（全文件 11 处负字距、28 处中间字重，grep 计数）[实·码]。
- **材质**：整窗 SVG 噪点颗粒（深色 5%、浅色 3.5% 不透明度）+ 顶部品牌色径向光晕；按钮是上下渐变 + 内高光 + 带色投影；圆章多层内外阴影发光 [实·码 `styles.css` L66、L250-285、L1540-1564、L1776-1830]。
- **密度**：弹层 400 宽，一屏一个状态、一两个按钮，是"低频工具"的密度 [推]。
- **动效**：GSAP 时间线编排进场：圆章 0.72s 带回弹缩放、标题**逐字**上浮（stagger 34ms）、副信息与列表行与按钮依次错峰；成功时对勾描线；尊重 `prefers-reduced-motion` [实·码 `src/app/motion.ts` L40-120]。窗口形态切换先淡出 150ms 再换框 [实·码 `styles.css` L286-300]。
- **多语言**：11 种语言，含阿拉伯语 RTL [实·文 `README.md`；实·码 `i18n.tsx` L4650-4707]。

#### 交互模式

- **检测 → 规划 → 确认 → 执行**：先探测安装状态与平台能力，生成计划，确认后才做破坏性操作 [实·文 `README.md`"工作原理"]。接管外部安装必须显式同意（"修改用户已有的官方安装，对安全敏感人群是信任红线"）[实·文 `docs/product-design.md` §2 决策 A]。
- **可中断性诚实**：下载可暂停、可取消；进入安装阶段后明确说"不可中断" [实·码 `i18n.tsx` progress.*]。
- **失败保底**：失败不触碰安装根、保留 staging 以便重试；更新失败自动回滚并明说 [实·文 `docs/product-design.md` §7；实·码 `i18n.tsx` success.rolledBack]。
- **结果横幅**：成功横幅 6 秒自动收起，带详情时钉住不收 [实·码 `Home.tsx` L1053-1082]。
- **确认用底部 Sheet**，焦点陷阱，Sheet 打开时底层 `inert` [实·码 `Home.tsx` L1044-1052、L1423-1429；`src/app/useFocusTrap.ts`]。

#### 值得吸收

1. **运行时页的"状态机英雄区"**：一个区域只回答"现在是什么状态 + 下一步做什么"，七种状态各有一句标题和对应主按钮 [实·码 `Home.tsx` L1085-1366]。我们的"Codex 运行时"页可以照这个信息结构做，但换成 product register 的克制外观。
2. **回滚 = "选择安装版本"**，并附"避免安装后立即被 Codex 更新回最新版" [实·码 `i18n.tsx` versionPicker.*]。比一个孤零零的"回滚"按钮更好懂。
3. **卸载默认保留数据 + 显示数据路径 + 说明该目录与 CLI 共用** [实·码 `i18n.tsx` uninstall.*]。对应 brief §6"破坏性操作有明确风险提示"。
4. **部分失败只重试失败步骤** [实·码 `i18n.tsx` uninstall.partial.*]。
5. **皮肤的"试穿 / 应用 / 还原"三级承诺**，以及**用皮肤配色绘制迷你窗口作预览**：不依赖大图，符合 brief §6 的性能约束 [实·码 `CodexThemes.tsx` L55-85]。
6. **更新确认把副作用说全**："会关闭 Codex，完成后自动重启，大约一分钟" [实·码 `i18n.tsx` confirm.body]。这正是 brief §5-5"带重启确认的切换"需要的文案粒度。
7. **错误文案都带修复动作** [实·码 `i18n.tsx` error.*]。
8. **检查中保持版面行数不变**，避免跳动 [实·码 `Home.tsx` L1086-1100 注释]。
9. token 的组织方式（OKLCH、中性色偏品牌色相、语义色三件套）可作为我们单一令牌体系的参考结构 [实·码 `styles.css` L76-190]。

#### 应该避免

1. **进场编排、逐字揭示、回弹缓动**：对"一个月打开几次"的更新器可以接受，对我们"每天切换多次"的工具就是 register-product §4 明令禁止的折磨 [实·码 `motion.ts`]。
2. **噪点纹理、径向光晕、发光圆章、渐变按钮**：register-product §10 点名"装饰性网格背景、噪点纹理" [实·码 `styles.css` L66、L273-285]。
3. **"即将支持"占位页**：正是 brief §4 禁止的"点进去是空页" [实·码 `CodexConfig.tsx`]。
4. **中文负字距与中间字重**（见视觉语言）。
5. **400×640 固定弹层**不适合我们 1140×816 的信息密度；它的布局不可迁移，只迁移信息结构 [推]。
6. 皮肤商店分类含"动漫""影视明星""科技人物" [实·码 `i18n.tsx` themes.category.*]，涉及肖像与 IP，我们的示例数据不要沿用这种分类 [推]。
7. README 顶部有赞助商位 [实·文 `README.md` L36-50]，与我们 PRODUCT.md 反模式冲突（只影响仓库文档，不影响界面）。

**结构指纹** [推]：弹层单卡（可展开出三项导航卡）+ 居中状态圆章 + 键值列表 + 纵向大按钮；签名元素是发光浮雕圆章；密度低；字体 SF Pro Rounded / Segoe UI + 苹方/雅黑；材质深色为主、噪点、光晕、渐变按钮。

---

### 1.4 CodexPlusPlus（AGPL-3.0-only，**净室**：只看 README 文本与图片）

本节证据只有两类：`README.md` / `README_EN.md` 的文字，和仓库内的图片文件。没有打开任何源码或样式文件，所以**本节不含任何 token 数值**，视觉描述全部是截图目视 [实·图] 或据此的推断 [推]。

它是"外部启动器 + 管理工具"：通过 CDP 和本地辅助服务给官方 Codex 桌面应用做供应商切换、协议转换、会话管理与界面增强，不改官方安装文件；安装后有两个入口，一个静默启动 Codex，一个是"管理工具" [实·文 `README.md` 开头、"快速使用"]。

#### 信息架构与导航

- **左侧深色侧栏，13 个一级入口**：概览、供应商配置、会话管理、工具与插件、Codex增强、皮肤管理、Zed 远程项目、脚本市场、推荐内容、安装维护、关于、设置、中转站环境配置检测 [实·图 `docs/images/manager-providers.jpg`、`manager-skin-market.png`]。核心功能（供应商、会话）与边缘功能（Zed 远程项目、脚本市场、推荐内容）平铺在同一层 [推]。
- **页头右上角是全局动作**：语言、主题、"重启 Codex++"、刷新；每页都有 [实·图 `manager-providers.jpg`、`manager-enhancements.jpg`、`manager-script-market.jpg`]。结合 README"依赖注入脚本的设置通常需要保存后重新启动 Codex++ 才会生效"，重启被做成常驻按钮 [实·文 `README.md`"Codex 界面增强"末句；推]。
- **品牌区**：多彩渐变的"Codex++"字标 + "管理控制台"副标 [实·图 `manager-providers.jpg`]。
- 还有一部分界面**注入到官方 Codex 内部**：Codex 标题栏上的绿点"Codex++ 1.0.4"表示后台状态，Codex 里的增强设置弹窗、输入框上的"fast"服务模式徽章、会话列表的"删除"按钮 [实·图 `docs/images/backend-status-indicator.png`、`settings-panel.png`、`service-tier-composer-badge.png`、`solution-plugin-and-delete.png`]。

#### 主要界面与关键组件（均为截图目视）

| 界面 | 做法 | 证据 |
|---|---|---|
| 供应商配置 | 先是一个总开关"启用供应商配置切换"，说明写明"关闭后本工具不会在手动切换时写入 Codex 的 config.toml / auth.json；启动 Codex 时始终不会自动改这些文件"；右对齐三个按钮：添加供应商 / 添加聚合供应商 / 从第三方导入；列表行 = 拖拽手柄 + 单字头像（"默"）+ 名称 + 一行蓝色元信息"官方登录 · Responses API · 不写 API 文件"；选中行蓝色描边；面板右上角一句"1 个供应商配置；可拖动排序，点编辑进入详情" | [实·图 `manager-providers.jpg`] |
| 供应商模式 | 官方登录 / 官方登录 + API / 纯 API / 聚合供应商四种，README 用一张"模式 / 用途 / 认证边界"表讲清每种模式动哪些认证文件；FAQ 专门澄清"混入 API 不是官方优先、额度不足再补" | [实·文 `README.md`"供应商模式"表、FAQ] |
| Codex 增强 | 总开关"启用 Codex 增强"；两张大号互斥模式卡"兼容增强 / 完整增强"（选中的描蓝边）；下面按"插件与模型""对话与输入"分组，每组两列开关卡（标题 + 一两句说明 + 开关）；个别项带"未检查"橙色状态与"释放并注册内置缓存""刷新"按钮 | [实·图 `manager-enhancements.jpg`] |
| 皮肤管理 | 顶部来源说明条"项目来源 · 原作者 · MIT License · 第三方图片需自行确认授权"；"运行状态"面板：启用开关 +"应用会保存当前图片与主题配置；恢复原始外观不会删除主题"，右侧"当前状态：需要处理 / 未检查"，按钮"应用皮肤 / 恢复 Codex 外观 / 刷新"；"图片与主题"：三个带计数的 Tab（社区 252 / 主题市场 14 / 我的主题 2）、搜索 + "最新审核"排序、三列大图卡片（名称、版本、作者 · 许可 · 下载次数、主题包大小） | [实·图 `manager-skin-market.png`] |
| 脚本市场 | 键值状态面板（市场状态：尚未刷新 / 远程脚本 0 个 / 已安装 0 个 / 本地整体 开启）+ 刷新市场 / 投稿 / 刷新本地；搜索 + "板块 / 列表"视图切换；空状态是虚线框里一句"点击刷新市场加载远程脚本。""未发现用户脚本。" | [实·图 `manager-script-market.jpg`] |
| 服务模式（注入到 Codex） | 分段按钮：继承 / 全局 Standard / 全局 Fast / 自定义，右上角绿字显示当前值；下一行"当前 thread 覆盖"：继承 / Standard / Fast | [实·图 `service-tier-settings.png`] |
| 流程说明图 | 一张深色背景的模型后缀处理流程图（内容是实现细节，按净室约束本报告不转述） | [实·图 `model-suffix-flow.png`] |

README 还列了若干本次没有截图的能力：Provider Doctor、cc-switch 与链接导入、每模型上下文窗口（"`1M`、`200K` 或纯数字"）、按供应商选择 MCP/Skill/Plugin、会话批量删除与 Markdown 导出、Token 用量历史、健康检查与 Release 更新；"切换供应商时会先保存当前配置，再写入目标配置"；"所有界面增强都可以单独关闭" [实·文 `README.md`"当前功能""供应商模式"]。

#### 视觉语言（目视，非 token）

- **深色为主**：近黑画布、略亮的深灰面板、1px 边框、中等圆角（目视约 8-10px）；主色是蓝（选中描边、开关、元信息文字），状态色有橙（"未检查"）和绿（当前值、后台状态点）[实·图 `manager-*.jpg/png`]。
- **品牌字标用多彩渐变**，是整个界面唯一的装饰性元素 [实·图 `manager-providers.jpg`]。
- **字体**：看起来是系统中文黑体，标题加粗；1440 宽截图里正文与说明文字很小（目视 11-12px），说明文字是深底灰字，对比偏低 [实·图 `manager-providers.jpg`、`manager-script-market.jpg`；推]。
- **布局**：内容区有固定最大宽度，1440 宽窗口时右侧留出大片空白 [实·图 `manager-providers.jpg`]。
- **密度**：设置类页面密度较高（两列开关卡），列表类页面偏空 [实·图 `manager-enhancements.jpg`、`manager-providers.jpg`]。
- **皮肤**：大尺寸插画位图作为主题素材 [实·图 `assets/inject/dream-skin-default.png`、`manager-skin-market.png`]。

#### 交互模式（据截图与 README 推断）

- 每个功能先给一个**总开关**，关掉就不写对应文件；总开关的说明写的是"关掉之后不会发生什么" [实·图 `manager-providers.jpg`、`manager-enhancements.jpg`]。
- **状态先于操作**：皮肤页、脚本市场都先放一块"运行状态 / 市场状态"键值面板，再放操作 [实·图 `manager-skin-market.png`、`manager-script-market.jpg`]。
- 需重启的设置用常驻的"重启 Codex++"兜底，而不是在改动处就地提示 [实·图；推]。
- 列表可拖动排序，点"编辑"进详情 [实·图 `manager-providers.jpg` 面板右上说明]。

#### 值得吸收

1. **"模式 / 用途 / 认证边界"三列讲清官方与第三方的区别**：每种模式动不动 `auth.json`、保不保官方登录，一眼可比 [实·文 `README.md`"供应商模式"]。这正是 brief §5-2"官方线路与第三方线路的区别"要在界面上表达的内容，可以做成线路编辑页里的一行"认证边界"说明。
2. **列表行上的一行协议元信息**（"官方登录 · Responses API · 不写 API 文件"），把"这条线路怎么接、写不写文件"压进一行 [实·图 `manager-providers.jpg`]。
3. **总开关的说明写后果**（"关闭后本工具不会…写入…"），而不是写功能介绍 [实·图 `manager-providers.jpg`]。
4. **状态面板先于操作**，让"尚未刷新""需要处理"这类状态有固定位置 [实·图 `manager-script-market.jpg`、`manager-skin-market.png`]。
5. **皮肤来源与许可的显式标注**（原作者、许可证、"第三方图片需自行确认授权"）[实·图 `manager-skin-market.png`]。
6. **"中转站环境配置检测"独立成页**，说明中转用户对"体检"有高频需求 [实·图 侧栏；推]。
7. 服务模式的"全局值 + 当前覆盖"两层分段按钮，是"默认 + 覆盖"类设置的清晰写法 [实·图 `service-tier-settings.png`]。

#### 应该避免

1. **13 项平铺侧栏**：核心与边缘功能同级，"推荐内容"之类入口挤占一级导航 [实·图 侧栏]。
2. **推广**：README 有长篇赞助商表，大量带 `aff=`、优惠码、返佣的推广文案 [实·文 `README.md`"赞助商"]；侧栏还有"推荐内容"一级入口，结合前者推测是推广位 [推]。都属于我们 PRODUCT.md 的反模式。
3. **小字 + 深底灰字**，中文说明可读性差 [实·图；推]。
4. **大图皮肤**：位图素材体积大，与 brief §6"不能依赖大图"冲突；第三方图片授权风险要用户自己承担 [实·图 `manager-skin-market.png` 来源条]。
5. **注入官方应用**的能力（改 Codex 内部界面）不在我们产品边界内，只作了解 [实·文 `README.md` 开头；推]。
6. 重启需求集中到一个常驻按钮，用户改完设置不知道要不要重启 [推]。

**结构指纹** [推]：深色 13 项侧栏 + 标题/副标题页头 + 右上全局动作 + 面板式分组（面板标题左、说明右）+ 开关卡网格；签名元素是渐变字标"Codex++"和常驻"重启 Codex++"按钮；密度中高但字小；字体系统黑体；材质深灰面板、1px 边框。

---

### 1.5 Chimera++ 现有界面（`D:\Desktop\chimera-plusplus`，分支 `v2.8.0/backend`）

证据：`DESIGN.md`、`PRODUCT.md`、`src/ChimeraApp.tsx`、`src/chimera.css`、`src/views/*.tsx`、`src-tauri/tauri.conf.json`，以及 `designs/` 下的截图与草稿。窗口当前是固定尺寸：1140×816、`resizable: false`、无边框透明、关闭系统阴影 [实·码 `src-tauri/tauri.conf.json` L17-27]。所以 brief 要求的 1440×900 放大画板是面向未来的验证，现有代码并不支持缩放 [推]。

#### 信息架构与导航

- **6 项浮动胶囊底栏**：供应商、更新、词元、外观、会话、设置，图标 + 文字，当前项 `aria-current="page"` [实·码 `src/ChimeraApp.tsx` L254-261、L1965-1990；实·图 `designs/guide-images/chimera-home.png`]。register-product §8 建议底部导航不超过 5 项。
- **竖向空间被外壳吃掉**：主网格是 `70px 标题栏 / 内容 / 150px 导航行`（窗口高于 760 时），即 816 高里有 220px（27%）是框架 [实·码 `src/chimera.css` L1133-1137、L4507-4508]。
- **标题栏**：左品牌，中间"● 当前页名"，右侧"检查 Chimera++ 更新"图标按钮与窗口控制 [实·码 `ChimeraApp.tsx` L1809-1864]。中间的页名与底栏重复表达"我在哪" [推]。
- **"更新"一词承担三件事**：标题栏 ↑ 是 Chimera++ 自身更新；底栏"更新"是 Codex 运行时；供应商页顶部还会出现 Chimera++ 更新横幅 [实·码 `ChimeraApp.tsx` L1829-1861、L256、L3345-3390]。用户很难分清"更新"指谁 [推]。
- **线路编辑是整页替换**：进入时隐藏底栏与内容区，保留标题栏 [实·码 `ChimeraApp.tsx` L1874-1878、L1965-1968；实·图 `designs/provider-editor-notes.png/K48PU.png` 约定 01]。
- **"管理线路"是模态**：搜索、切换、编辑、删除都在这个弹窗里，官方线路显示"由 Codex 管理"不可编辑 [实·码 `ChimeraApp.tsx` L3552-3687；实·图 `designs/guide-images/chimera-manage-routes.png`]。
- **首次启动**：没有线路时整屏显示独立引导页 [实·码 `ChimeraApp.tsx` L1789-1802、L5205-5258]。
- **会话页直接嵌入继承自 cc-switch 的会话管理器**（`appId="all"`）[实·码 `ChimeraApp.tsx` L1957-1961]，是整个应用里唯一的 shadcn/Tailwind 视觉孤岛 [推]。
- **只管 Codex**：PRODUCT.md 明确供应商配置是 Codex 专属，其他工具只在会话筛选里出现 [实·文 `PRODUCT.md` "Navigation and Product Scope"]。v2.8.0 的 10 工具注册表在现有 IA 里没有位置 [推]。

#### 主要界面与关键组件

| 界面 | 做法 | 证据 |
|---|---|---|
| 供应商（首页） | 顶部可选的 Chimera++ 更新横幅；中央 390px 高的 WebGL 点阵地球（官方文档称"空闲态装饰"，不编码任何数据），上方一行"连接稳定 / 正在检测 / 连接异常"；地球下沿压着一张 Codex 状态卡（"Codex 已就绪 · 当前模型 gpt-5.6-sol"）+ 橙红主按钮（启动 / 打开 / 重启 / 重启并登录 Codex）；再下面"线路切换 · N 条可用 · 管理线路 →"与 88px 高的**横向滚动线路卡片条**（带左右箭头）+ "添加线路"；底部一行"当前模型 / 连接状态" | [实·码 `ChimeraApp.tsx` L3343-3700；`chimera.css` L1574-1579、L3737-3748、L4054-4057；实·图 `designs/guide-images/chimera-home.png`；实·文 `DESIGN.md` Components、`PRODUCT.md` Visual Research Reference] |
| 线路命名 | 自动规整：官方线路一律叫"官方账户 / ChatGPT 官方登录"，自家中转叫"默认线路 / 备用线路 / 线路 N · Chimera 中转站"，其余"自定义线路"；头像是单字母 O / C / 首字 | [实·码 `ChimeraApp.tsx` L3112-3171] |
| 当前线路 | 卡片淡橙底 + 名称前绿色小点；`aria-pressed` | [实·码 `ChimeraApp.tsx` L3504-3531；实·图 `chimera-home.png`] |
| 线路编辑（维护者 9 月草稿） | 整页：返回按钮、"未保存修改"标记；"基础连接"两列（名称、官网、API 请求地址、API Key 遮蔽 + 显隐、默认模型 + 获取模型）；"模型映射"表格行（菜单显示名 / 实际请求模型 / 上下文 tokens / 思考等级 / 指令、删除）；"高级配置"默认折叠并显示摘要"Codex 功能 · 通用配置 · 协议与兼容性"；固定底栏：测试地址连通性 +"尚未测试"、删除线路、取消、保存并应用；配套状态稿覆盖新建、零映射、思考等级多选、保存中锁定、部分成功、需重启、获取模型失败、映射缺模型 ID | [实·图 `designs/provider-editor-desktop.png/CKDhX.png`、`provider-editor-narrow.png/DEkWg.png`、`provider-editor-states/ONcim.png`、`provider-editor-states/K48PU.png`] |
| 线路编辑（旧版右侧抽屉） | 右侧抽屉覆盖在首页上：模板提示条"Chimera 中转站默认模板"+ 恢复模板、名称、官网、请求地址、Key、默认模型、高级选项、测试连接 / 保存并应用 | [实·图 `designs/guide-images/add-provider.png`] |
| 更新（Codex 运行时） | 识别状态；"安装与维护"：安装方式分段（标准安装 / 免安装版）、更新源；维护区：诊断（只检查，不修改本机文件）、修复、回滚（恢复上一个可用版本）、安装历史版本、离线导入安装包、卸载 Codex（保留 Chimera++ 与供应商配置） | [实·码 `ChimeraApp.tsx` L2128-3010 文案] |
| 词元 | 今日 / 7 天 / 30 天；累计词元 + 非缓存输入 / 输出 / 缓存构成；每小时或每日"光谱"；请求数与成功率；模型排行；同步、重建（先备份）与失败重试 | [实·码 `src/views/UsageView.tsx` L103-621 文案] |
| 外观 | "皮肤市场"：精选 / 已安装 / 深色 / 浅色筛选 + 导入本地；产品策略关闭时整页只剩一句"当前产品策略未启用 Codex 皮肤能力。" | [实·码 `src/views/AppearanceView.tsx` L114-150] |
| 空状态与引导 | "开始配置你的 Codex"+ 1/2/3 编号步骤 + 开始配置 / 稍后配置；底部写死"Chimera++ 2.0 · 数据仅保存在本机" | [实·码 `ChimeraApp.tsx` L5165-5258] |
| 读取失败 | "无法读取线路列表"+ 错误原文 + 重试（带加载态）；注释说明为何不能把读取失败当成首次安装 | [实·码 `ChimeraApp.tsx` L1786-1903] |
| 早期概念稿（8 月） | 两组：粉橙"VPN 风"（请求/延迟/Ping 三张指标卡、"99.9% 正常运行"、延迟柱状图、大红"当前路由 ID"卡）；深色窄窗（"你 → CHIMERA++ → OpenAI 官方"路径线随状态变绿/变琥珀，SWITCH 列表，CODEX 进程 PID 与停止，"已切换线路，需重启 Codex 生效"横幅，"切换中… / 取消切换"），但用了 macOS 红绿灯与大写英文区块标签 | [实·图 `designs/S7aiW.png`、`z3i2mz.png`、`CrGFF.png`、`A24AwO.png`、`d91lB.png`、`ECYby.png`、`YPQbu.png`] |
| 维护者自己的诊断稿 | 已写出供应商页"诊断三条"：装饰图 390px 硬编码挤占内容、横向 rail 超过 4 条失效、窗口与白色桌面融在一起；改法是约 100px 的紧凑状态区 + 纵向线路列表 + 窗口细阴影 | [实·码 `designs/providers-redesign.html` L212-226、L394-396] |

#### 视觉语言

- **token 有结构、执行不到位**：`chimera.css` 顶部有 OKLCH 原子 token + 语义 token + 动效与圆角 token [实·码 `src/chimera.css` L1-60]，但全文件原始色值 306 个十六进制 + 62 个 rgba，OKLCH 只有 14 处，`var(--…)` 327 处（grep 计数）[实·码]。
- **主色三处不一致**：DESIGN.md 写 `accent: oklch(0.61 0.205 32)` [实·文 `DESIGN.md` L15]；CSS 是 `--p-orange: oklch(0.52 0.17 30)`，旁注却写 `#ff5a36` [实·码 `chimera.css` L10]；按钮 hover 又直接写 `#e84c2b` [实·码 `chimera.css` L86]。按 OKLCH 换算，L=0.52 明显比 `#ff5a36` 暗，注释与取值不符 [推，近似换算]。
- **字体**：`Inter, "PingFang SC", "Microsoft YaHei", ui-sans-serif, system-ui`，拉丁在前，顺序正确 [实·码 `chimera.css` L50-52]；等宽 `"Geist Mono"` 与 DESIGN.md 写的 `JetBrains Mono, Cascadia Mono, Consolas` 不一致 [实·码 L53；实·文 `DESIGN.md` L55]。
- **字号过小**：`font-size` 声明里 9px 5 处、10px 30 处、11px 49 处、12px 43 处、13px 21 处、14px 4 处（grep 计数），约四分之三 ≤12px；主次按钮都是 12px [实·码 `chimera.css` L73、L99]。DESIGN.md 自己规定"UI text must not drop below 13px"[实·文 `DESIGN.md` L115]，`typography-cjk.md` 要求中文正文 ≥15px，两条都没达到。
- **字重**：DESIGN.md 规定 650、550 [实·文 `DESIGN.md` L27、L51]，CSS 另有 7 处 550/650/750/800/900 [实·码 grep]，中文字体只有三档 [推]。
- **圆角**：DESIGN.md 说 4/8/12/16 四档 [实·文 `DESIGN.md` L137]，CSS 实际出现 2、3、4、5、6、7、8、9、10、11、12、14、16、20、999 共 15 种（grep 计数）[实·码]。
- **没有深色模式**：继承来的 ThemeProvider 会给根节点切 `.dark` [实·码 `src/components/theme-provider.tsx` L66-86]，但 `chimera.css` 里没有任何深色规则（grep `dark` 只命中注释）[实·码]；外观页的"深色 / 浅色"是 Codex 皮肤筛选，不是本应用主题 [实·码 `AppearanceView.tsx` L128-129]。brief §6 要求深浅两套。
- **材质**：底栏、线路切换器、线路条用"液态玻璃"（6 处 `backdrop-filter`、10 处渐变）[实·码 grep；实·文 `DESIGN.md` L133]；标题栏按钮是圆形灰底 [实·图 `chimera-home.png`]。
- **签名元素**：点阵地球 [实·文 `DESIGN.md` L141]。
- **动效**：DESIGN.md 有一张完整的事件-动效-时长表（页面切换 180ms、选择 180ms、保存 220ms…），明确"No page-load choreography" [实·文 `DESIGN.md` Motion]；这是五个对象里写得最好的动效契约 [推]。

#### 交互模式

- **切换**：点横向卡片即切换，卡片头像处转圈 [实·码 `ChimeraApp.tsx` L3287-3295、L3504-3531]；切换后若 Codex 在运行，主按钮变"重启 Codex" [实·码 L3325-3341]。
- **删除**：当前线路的删除按钮禁用，title 提示"请先切换到其他线路"；其他线路弹确认框 [实·码 L3644-3665、L4976]。
- **编辑**：返回 / 取消 / Esc 共用未保存检查，保存中锁定输入，失败保留草稿，部分成功要写清 [实·图 `provider-editor-notes.png/K48PU.png` 约定 03、07]。
- **余额**：可选开启，60 秒自动刷新，查询失败或不支持时有文字 [实·码 L3182-3248]。
- **反馈**：toast（sonner）+ 页内横幅 [实·码 L3375-3379]。

#### 值得保留

1. 线路名规整和"由 Codex 管理"的官方线路处理 [实·码 L3112-3171、L3622-3625]。
2. 主按钮文案随状态变化（启动 / 打开 / 重启 / 重启并登录）[实·码 L3325-3341]。
3. 9 月线路编辑草稿：结构、状态稿、交互约定都成熟，可直接作为 brief §5-3 的底稿 [实·图 `designs/provider-editor-*`]。需要改的只有：保存时"探测协议可能产生费用"一条已过时，现行实现是"自动模式按模型名称选择默认协议，不会在保存时调用上游" [实·图 `provider-editor-states/K48PU.png` 约定 06；实·码 `ChimeraApp.tsx` L4687]。
4. 深色概念稿里"你 → Chimera++ → 目标"的路径线和"切换中 / 需要重启"两个中间态 [实·图 `A24AwO.png`、`d91lB.png`、`ECYby.png`]，比地球更适合当签名元素（见 §4）[推]。
5. DESIGN.md 的动效表与 PRODUCT.md 的反模式清单 [实·文]。
6. 维护者自己的诊断稿方向（紧凑状态区 + 纵向列表）[实·码 `designs/providers-redesign.html`]。

#### 现有问题（证据见上）

1. 地球占掉内容区六成以上高度且不承载信息；真正高频的"切换线路"被挤进 88px 横条，超过 4 条就要横向翻页。
2. 6 项底栏 + 150px 导航行 + 70px 标题栏；无法容纳 10 个工具。
3. "更新"三义；标题栏页名与底栏重复。
4. 字号普遍 10-12px，没有深色模式，token 与 DESIGN.md 三处漂移。
5. 引导页用 1/2/3 编号步骤（DESIGN.md 与 register-product §10 都禁止），并写死过期的"Chimera++ 2.0" [实·码 `ChimeraApp.tsx` L5175-5254]。
6. 外观页可能整页只有一句"未启用"，即导航通向空页 [实·码 `AppearanceView.tsx` L114]。
7. 会话页是继承组件，视觉与其他五页不一致 [推]。
8. 8 月概念稿里的指标卡三连、"99.9%"之类伪数据、macOS 红绿灯、大写英文标签，都在 atelier 与 DESIGN.md 的禁止清单里，不要复活 [实·图 `S7aiW.png`、`CrGFF.png`、`A24AwO.png`]。

**结构指纹** [推]：自绘标题栏 + 居中大装饰（地球）+ 悬浮状态卡 + 横向卡片条 + 浮动玻璃底栏；签名元素是点阵地球；密度低（首页）到中（编辑页）；字体 Inter + 苹方/雅黑；材质浅灰画布、白卡、液态玻璃、橙红主色。

---

## 2. 功能到界面的映射（brief §5 的 13 项）

缩写：CCS = cc-switch，CX = Codex-X，CAM = Codex-App-Manager，CPP = CodexPlusPlus，现状 = Chimera++ 现有界面。每项最后一行"含义"是给设计的推断 [推]。

### 2.1 首次启动（空状态、引导到第一条线路）

| 来源 | 怎么做 | 好在哪 | 差在哪 |
|---|---|---|---|
| CCS | 虚线框空状态：圆形图标、标题、说明，主按钮"导入当前配置"，次按钮"添加供应商" [实·码 `src/components/providers/ProviderEmptyState.tsx`]；Pi 规范要求新建页默认选"自定义配置"、预设只做快速填充不做门槛、不用"1、2、3"编号步骤 [实·文 `docs/pi-frontend-uiux-guidelines-zh.md` §4.3] | 把用户已有配置直接变成第一条线路，路径最短 | 没有检测结果，用户不知道"当前配置"是什么 |
| CAM | 首页即状态机：未检测到 Codex → "安装 Codex"；检测到外部安装 → "开始管理"（显式同意接管）；"已经安装了 Codex？手动选择位置" [实·码 `src/app/views/Home.tsx` L1108-1143；`i18n.tsx` home.*] | 先检测、后提问；接管前征得同意 | 进场动效重；弹层尺寸不可迁移 |
| CX | 供应商列表为空时只有一行状态文字 [实·码 `pages/ProvidersPage.tsx` L457-458]；会话空状态指明"点击右上角'检查会话'刷新" [实·码 `SessionManagementPage.tsx` L200] | 会话空状态告诉用户下一步 | 供应商空状态没有引导 |
| CPP | README 建议首次先确认应用路径与运行状态，再配供应商 [实·文 `README.md` 快速使用]；空列表是虚线框里一句话 [实·图 `docs/images/manager-script-market.jpg`] | 顺序正确：先环境后配置 | 靠 README 教，不在界面里 |
| 现状 | 独立整屏引导，1/2/3 编号步骤，"开始配置 / 稍后配置" [实·码 `src/ChimeraApp.tsx` L5205-5258] | 有"稍后配置"出口 | 编号步骤被 DESIGN.md 禁止；版本号写死 |

含义：首启做一次**只读检测**（Codex 是否安装、安装方式、`~/.codex` 是否已有线路、是否已官方登录），按检测结果只给 1-2 个动作，例如"把当前登录保存为官方账号""导入当前配置为第一条线路"，兜底才是"添加线路"；明写"只读取，不修改文件"。

### 2.2 线路（Codex）：列表、当前线路、切换、测速/状态、添加入口；官方与第三方的区别

| 来源 | 怎么做 | 好在哪 | 差在哪 |
|---|---|---|---|
| CCS | 全宽卡片；hover 才出操作；当前 = 蓝边框 + 渐变底；"需要路由/不支持路由"徽章；余额内联；拖拽排序；橙色圆形加号 [实·码 `ProviderCard.tsx` L380-747；实·图 `assets/screenshots/main-zh.png`] | 余额和路由能力贴在行上 | 操作不可见、颜色是唯一当前信号、一屏 6-7 条 |
| CX | 行卡；"当前"徽章（圆点 + 字）；官方行有来源徽章与账号徽章（邮箱 + 套餐）；Base URL 等宽；操作常驻 [实·码 `pages/ProvidersPage.tsx` L456-530] | 操作可达；官方身份清楚 | 每行 5 个图标 + 1 个按钮，噪音大；16px 圆角卡片堆叠 |
| CPP | 行元信息"官方登录 · Responses API · 不写 API 文件"；README 用"模式 / 用途 / 认证边界"表讲清官方与第三方 [实·图 `manager-providers.jpg`；实·文 `README.md` 供应商模式] | 一行说清接入方式与写哪些文件 | 列表过空、字小 |
| CCS 测速 | 端点列表，右侧等宽延迟（绿/红）+ 状态码，"自动选择""测速" [实·图 `docs/user-manual/assets/image-20260108005327817.png`] | 数字对齐、信息密 | 只靠红绿区分快慢 |
| 现状 | 地球 + 状态卡 + 88px 横向卡片条 + "管理线路"弹窗 [实·码 `ChimeraApp.tsx` L3343-3700] | 官方线路名规整、"由 Codex 管理" | 超过 4 条要横翻；编辑删除藏进弹窗 |

含义：纵向紧凑列表（行高 40-48px），固定列：名称 / 类型（官方账号、中转、自建）/ 协议 / 模型 / 延迟（等宽数字 + "快/慢/超时"文字）；当前线路用形状 + 文字（例如左侧实心标记 + "当前"），灰度下也能认出；官方与第三方的差别用一列"认证方式"表达（CPP 的认证边界写法），不靠配色。

### 2.3 线路编辑（名称、地址、密钥遮蔽、协议、模型与映射、1M 开关）

| 来源 | 怎么做 | 好在哪 | 差在哪 |
|---|---|---|---|
| CCS | 整屏表单：预设 chip 云（带合作伙伴星标）、居中大图标、名称/备注/官网/Key、端点管理与测速、高级区 [实·图 `add-zh.png`]；Pi 规范给出字段分级表、"配置 JSON"与结构化字段双向同步、未知字段原样透传、失败保留输入 [实·文 `pi-frontend-uiux-guidelines-zh.md` §4.4-4.7、§9] | 字段分级与无损往返原则可直接沿用 | 预设推广；大图标占位；表单很长 |
| CX | Base URL、Key（显隐）、模型 + 获取模型、Wire API、完整 TOML 同页；模型映射上限 64 并说明默认模型计入；1M 开关贴在 TOML 标题旁 [实·码 `ProvidersPage.tsx` L217-330、L653-657；`ProviderModelMappings.tsx` L12-20] | 1M 开关与受影响配置同视野；映射限制写明 | 官方线路直接编辑 auth.json |
| CPP | 每模型上下文窗口可填 `1M`、`200K` 或数字；Responses/Chat；Provider Doctor [实·文 `README.md`] | 上下文按模型设置 | 无截图，布局未知 |
| 现状 | 9 月整页草稿：基础两列、映射表格行、高级折叠带摘要、固定底栏、未保存标记、完整状态稿 [实·图 `designs/provider-editor-desktop.png/CKDhX.png` 等] | 五个对象里最成熟的编辑器方案 | 状态稿里"保存时探测协议可能产生费用"已过时 [实·码 `ChimeraApp.tsx` L4687] |

含义：以现有草稿为底。协议"自动 / Responses / Chat / Anthropic"用分段控件，选"自动"时旁边显示推导结果（"按模型族将使用 Responses"）；密钥默认遮蔽，显隐按钮有文字标签；1M 开关放在模型区，写明"需模型支持"；官方账号线路的编辑页不出现任何令牌字段。

### 2.4 其他工具：切换类（如 Claude Code）与累加类（如 OpenCode、Pi）

| 来源 | 怎么做 | 好在哪 | 差在哪 |
|---|---|---|---|
| CCS | 唯一先例。工具切换器是 10 个图标的分段控件 + "更多" [实·码 `AppSwitcher.tsx`]；功能入口随工具增减 [实·码 `App.tsx` L1592-1757]；累加类主按钮是"添加（绿）/ 移除（橙）"，Pi 用"启用"，OpenClaw 另有"设为默认"模型下拉，Hermes 托管项只读 [实·码 `ProviderActions.tsx` L164-205、L281-364；`ProviderCard.tsx` L512-523]；Pi 规范：文件存在即生效、不显示"当前使用"、术语用"启用 / 移除"而不是"切换 / 设为默认" [实·文 `pi-frontend-uiux-guidelines-zh.md` §3、§4.2、§7] | 语义正确：累加类确实没有"当前线路" | **静止时两类看起来一样**，区别只在 hover 才出现的按钮上 |
| CX / CAM / CPP | 都是单工具，没有可参考的界面 | | |

含义：切换类用**单选语义**：列表上方固定一个"当前线路"槽，其余行是"切换到这条"；累加类用**复选语义**：每行一个开关，列表头写"已启用 3 / 5 条"，没有"当前"槽。工具页头第一句直接说模式："同一时间只使用一条线路"或"可同时启用多条"。Mcode 拒绝深链、Grok Build 维持本地路由这类差异，用工具页头的能力标签表达，不做空页。

### 2.5 多官方账号

| 来源 | 怎么做 | 好在哪 | 差在哪 |
|---|---|---|---|
| CCS | **一条官方线路 + 账号选择器**：编辑页里"认证状态 · N 个账号"、账号下拉、"已登录账号"列表（默认 / 已选中）、"添加其他账号"；卡片副行显示账号或"需要重新登录" [实·图 `docs/images/claude-codex-routing/03-codex-oauth-form.png`；实·码 `ProviderCard.tsx` L526-591] | 线路列表不膨胀 | 换账号要进编辑页；额度不在列表上 |
| CX | **每个账号一条线路**：官方登录各占一行，邮箱 + 套餐徽章（免费 / Plus / Pro / 企业），额度按需弹窗，默认官方不可删 [实·码 `ProvidersPage.tsx` L462-525；`OfficialAccountBadge.tsx`；`OfficialQuotaDialog.tsx`] | 换账号与换线路是同一个动作；额度入口在行上；额度弹窗状态完整 | auth.json 可编辑，令牌外露 |
| CPP | "官方登录 / 官方登录 + API"模式，README 讲清认证边界与"混入 API 不是官方优先" [实·文 `README.md` 供应商模式、FAQ] | 边界说明清楚 | 不是多账号 |
| CAM | 重启确认文案的粒度："会关闭 Codex，完成后自动重启，大约一分钟。若 Codex 弹出退出确认框，请在 Codex 中点击确认。" [实·码 `i18n.tsx` confirm.body] | 可直接借鉴到"带重启确认的切换" | |
| 后端 | 两种信息架构都支持，因为"线路固定账号"（lines pin accounts）[实·文 `v2.8.0/m0-official-accounts-design.md` L831] | | |

取舍 [推]：选 A（每账号一条线路）时，切账号与切线路、托盘切换完全一致，额度能并排比较，最适合"额度用完换号"的场景；代价是需要把官方账号成组置顶，避免与中转线路混排。选 B（一条官方线路 + 账号选择器）时，"官方 vs 第三方"只剩一行对比，列表最短；代价是换号多一步，额度要进选择器才看得到。**本调研倾向 A + 分组**：brief 的用户画像是"经常在官方账号与多个第三方线路之间切换""在意切换快"，后端的账号线路模型也天然对应 A。设备码添加（`codex login --device-auth`）与"保存当前登录为账号"放在官方组的组头；账号行只显示邮箱、套餐、令牌状态（有效 / 需重新登录）和"查看额度"，永不显示令牌。

### 2.6 提示词中心（模板库、导入 .md、启停、追加/替换、受管区块预览）

| 来源 | 怎么做 | 好在哪 | 差在哪 |
|---|---|---|---|
| CX | 顶部"当前状态"条 + 页面级"启用方式"二选一（保留原提示词 / 替换原提示词，带帮助气泡）；分类分段控件 + 分类管理；三列卡片网格，每卡一个开关；导入 md、同步 GitHub 模板、添加提示词；表单 = 名称 + 文件名 + Markdown 文本框 [实·图 `new-ui/prompts.png`、`prompt-form.png`；实·码 `PromptsPage.tsx` L98-140] | "写入方式"提升到页面级，一眼知道当前生效什么 | 卡片网格浪费高度；**示例分类含越狱类内容，禁止沿用**；没有受管区块预览 |
| CCS | 列表：开关 + 名称/说明 + 编辑/删除，顶部"共 N 个 · 已启用：…" [实·图 `image-20260108010110382.png`]；Pi 版三 Tab，原生文件与提示库不一致时显示"外部 AGENTS.md"，替换型文件创建前必须警告 [实·文 `pi-frontend-uiux-guidelines-zh.md` §5] | 如实显示外部冲突状态；替换前警告 | 没有预览 |
| CAM / CPP | 无 | | |

含义：列表（6 个内置模板 + 用户导入）+ 右侧预览。预览即"受管区块预览"：显示写入 AGENTS.md 后的片段，受管部分用边线标出，上下文灰显。追加 / 替换是页面级分段控件，选"替换"时就地警告会覆盖什么。6 个内置模板只需"内置"标签，不需要分类 Tab。

### 2.7 Skills 与 MCP（安装 ZIP / 仓库、启停、备注、导出）

| 来源 | 怎么做 | 好在哪 | 差在哪 |
|---|---|---|---|
| CX | 一页两 Tab（带计数胶囊），行 = 等宽名称 + 开关；导入前预览；ZIP 安装；每项备注（1000 字）；导出 ZIP 并提示"MCP 包可能包含连接密钥"；检查更新 [实·图 `new-ui/skills-mcp.png`；实·码 `SkillsMcpPage.tsx` L57-99] | 导入预览、导出风险提示、备注 | 行里只有名称和开关，一屏 5-6 行 |
| CCS | 每条目 × 工具的开关矩阵；仓库管理（URL + 分支 + "识别到 N 个技能"）；ZIP 安装、从备份恢复、检查更新、导入、发现 [实·图 `image-20260108005723522.png`、`image-20260108010308060.png`；实·码 `App.tsx` L1486-1573] | 仓库来源与识别数量清楚 | 矩阵对我们无意义（只有 Codex 有 Skills/MCP）；页头 5 个按钮 |
| CPP | 按供应商选择启用的 MCP / Skill / Plugin [实·文 `README.md`] | 与线路关联 | 无截图 |

含义：单工具，不做矩阵。两 Tab + 表格化行（名称 / 来源 / 备注 / 启用）；"安装"合成一个入口（ZIP 或仓库）；导出前写明可能含密钥。

### 2.8 会话（浏览、搜索、筛选、详情、导出、删除）

| 来源 | 怎么做 | 好在哪 | 差在哪 |
|---|---|---|---|
| CCS | 320px 列表 + 详情双栏；搜索、按供应商筛选、分组/平铺、批量删除、复制恢复命令、消息目录 [实·码 `SessionManagerPage.tsx` L853-1802] | 能读详情；恢复命令 | 在我们这里是视觉孤岛 |
| CX | 类表格；按项目分组；"显示内部会话"；导出选中（单个 Markdown、多个 ZIP）；删除确认列出待删项 + 必须勾选"我已关闭…" [实·码 `SessionManagementPage.tsx` L160-340] | 删除确认最严谨 | 没有详情阅读 |
| CPP | 批量删除、Markdown 导出 [实·文 `README.md`] | | 无截图 |

含义：CCS 的双栏阅读 + CX 的删除确认 + 导出前密钥提示。现状已有删除确认与恢复命令 [实·文 `PRODUCT.md` 会话]，重做时统一到新 token 即可。

### 2.9 用量（词元、成本、模型分布、按对话汇总）

| 来源 | 怎么做 | 好在哪 | 差在哪 |
|---|---|---|---|
| CX | 总量大卡 + 输入/缓存/输出构成条；缓存命中率；堆叠柱状趋势 + 可展开逐日表；模型环图（点击即筛选）；最近主会话表；子代理归入主会话；"本地数据"、时区、扫描文件数；部分数据警告、错误保留旧数据 [实·码 `UsageStatisticsPage.tsx` L124-327；实·文 `README.md`] | 按对话汇总与数据诚实 | 藏在设置 Tab；环图 |
| CCS | 四张指标卡（彩色图标方块）+ 双轴折线 + 24 小时/7 天/30 天；另有请求日志、供应商与模型统计表 [实·图 `image-20260108011730105.png`；实·码 `src/components/usage/`] | 有请求日志 | 指标卡四连；在设置里；只统计经代理的请求 |
| 现状 | 今日/7 天/30 天、累计词元与构成、每小时/每日光谱、请求数与成功率、模型排行、重建前备份 [实·码 `views/UsageView.tsx`] | 构成与重建流程完整 | **缺成本、缺按对话汇总**（grep 无相关文案）[实·码] |

含义：一级页面。首屏一个结论数字（总词元 + 估算成本，标明计价来源）+ 构成条；模型分布用横向排行条（不超过 6 项，其余合并），不用环图；"按对话"表格把子代理折叠进根对话，可展开。

### 2.10 Codex 运行时（检测、安装、更新、修复、回滚、卸载）与外观（皮肤预览与应用）

| 来源 | 怎么做 | 好在哪 | 差在哪 |
|---|---|---|---|
| CAM | 状态机英雄区（七种状态各一句标题 + 对应主按钮）+ 版本键值 + "选择安装版本"（回滚，附"避免安装后立即被 Codex 更新回最新版"）+ 卸载默认保留数据并显示路径 + 部分失败只重试失败步骤 + 进度可暂停、明说"当前阶段不能取消" [实·码 `Home.tsx`；`i18n.tsx` versionPicker.*、uninstall.*、progress.*] | 信息结构最清楚，文案给后果 | 装饰动效与材质不可取 |
| CAM 皮肤 | 本地 / 商店；截图封面或**用皮肤配色画的迷你窗口**；试穿（热切换不落盘）/ 应用（重启 Codex）/ 还原原生外观；"制作时在 Codex {v} 上验收通过" [实·码 `CodexThemes.tsx` L55-85；`i18n.tsx` themes.*] | 三级承诺清楚；迷你窗口预览不依赖大图 | 分类含明星/动漫 |
| CPP 皮肤 | 来源与许可条；"运行状态"面板（启用开关、当前状态、应用皮肤 / 恢复 Codex 外观）；三个带计数 Tab；大图卡片 [实·图 `manager-skin-market.png`] | 许可标注；状态先于操作 | 大位图素材 |
| 现状 | 更新页已有诊断 / 修复 / 回滚 / 安装历史版本 / 离线导入 / 卸载（保留配置）；外观是皮肤市场 [实·码 `ChimeraApp.tsx` L2128-3010；`AppearanceView.tsx`] | 能力齐全 | 与 Chimera++ 自身更新同名"更新" |

含义：运行时页 = 一句状态 + 版本键值 + 一个主操作 + 维护动作列表（每项一句后果）；页名改为"Codex 运行时"之类，避免与应用更新混淆。外观用迷你窗口配色预览，"试用 / 应用 / 还原"分级。

### 2.11 配置体检（问题列表 + 一键修复，修复前备份）

| 来源 | 怎么做 | 好在哪 | 差在哪 |
|---|---|---|---|
| CX | 状态胶囊（未检查 / 检查中 / 配置正常 / 发现问题 / 尚无配置 / 暂时无法检查）；问题列表；**"点击修复后，将进行以下调整："**；"检查不会修改配置。点击修复后，会先自动备份"；检出时主动弹不自动消失的提醒卡 [实·码 `ConfigHealthPanel.tsx`、`ConfigHealthToast.tsx`] | 修复计划预览 | 放在设置第二层 |
| CPP | 独立一级页"中转站环境配置检测"；Provider Doctor [实·图 侧栏；实·文 `README.md`] | 入口显眼 | 无截图 |
| CCS | 环境变量冲突横幅、OpenClaw 健康横幅，出现在主页顶部 [实·码 `App.tsx` L1262-1285、L1780-1782] | 问题就地出现 | 横幅无修复计划 |
| CAM | 设置里"修复与恢复"：正常 / 需处理 [实·码 `i18n.tsx` settings.health.*] | | 入口深 |

含义：问题按严重度排序，每条写"会改什么、改哪个文件"；"一键修复"按钮旁写备份位置；有问题时在相关页面顶部出现一条可关闭提示，点进体检页。

### 2.12 设置（可见工具管理、从 cc-switch 导入、live 备份列表与恢复、语言、通用）

| 来源 | 怎么做 | 好在哪 | 差在哪 |
|---|---|---|---|
| CCS | 设置 6 个 Tab（通用 / 路由 / 认证 / 高级 / 使用统计 / 关于）；应用可见性、目录、导入导出、备份列表、WebDAV 同步 [实·码 `settings/SettingsPage.tsx` L228-239；`settings/` 目录] | 可见工具管理有先例 | Tab 太多；用量混进设置；云同步（我们不做） |
| CX | 通用（语言分段、配置检查、重启 Codex）/ 用量 / 路由；"从 cc-switch 导入"放在供应商页头，结果区分新增 / 更新 / 合并 / 跳过 [实·码 `UtilityPages.tsx` L191-316；实·文 `README.md` §2] | 导入结果分类清楚 | 功能塞进设置 |
| CAM | 更新源四选一，"自动：自动选用可用的更新源（非网速测速）"；定时检查；跳过的版本可"恢复提醒" [实·码 `i18n.tsx` settings.*] | 说明诚实，不夸大 | |
| CPP | 设置、安装维护、关于分成三个一级页 [实·图 侧栏] | | 一级导航过多 |

含义：设置只放偏好与数据。可见工具用列表 + 开关，首次启用走"检测 → 备份 → 导入预览 → 确认写入"；从 cc-switch 导入沿用 CX 的四类结果；live 备份列表每行写时间、触发动作、文件绝对路径和"恢复"。

### 2.13 状态（空 / 加载 / 错误、破坏性确认、深链导入确认）

| 来源 | 怎么做 | 好在哪 | 差在哪 |
|---|---|---|---|
| CCS | 深链确认逐字段展示，敏感值遮蔽，环境变量劫持 / 私网端点 / shell 命令做风险标注但不拦截 [实·码 `utils/deeplinkRisk.ts`；`DeepLinkImportDialog.tsx`]；确认框 384px，可带复选框 [实·码 `ConfirmDialog.tsx`] | "可见性而非黑名单" | 没有目标文件路径 |
| CX | 用量页加载 / 错误（保留旧数据）/ 部分数据 / 空四态齐全；删除列出待删项 + 安全勾选；确认框初始焦点在"取消"，忙碌时禁用 Esc [实·码 `UsageStatisticsPage.tsx` L297-305；`SessionManagementPage.tsx` L285-340；`ProvidersPage.tsx` L539-570] | 状态覆盖最全 | |
| CAM | 检查中保持版面；错误都带下一步；结果横幅 6 秒自动收、带详情时钉住；失败回滚并说明 [实·码 `Home.tsx` L1053-1100；`i18n.tsx` error.*、success.*] | 文案给动作 | |
| 现状 | 读取失败页带重试并解释为何不当首装处理；删除当前线路禁用并提示 [实·码 `ChimeraApp.tsx` L1786-1903、L3644-3665] | | 没有深色态；加载多为一句文字 |

含义：深链确认框 = 来源 + 目标工具 + **目标文件绝对路径（等宽、可复制）** + 完整内容（密钥遮蔽、可展开）+ 风险标注（CCS 的三类）；Mcode 直接显示"此工具不接受深链导入"。破坏性确认统一模板：范围、后果、能否恢复、备份位置。

---

## 3. 横向对比表

| 维度 | cc-switch | Codex-X | Codex-App-Manager | CodexPlusPlus（仅图文） | Chimera++ 现状 |
|---|---|---|---|---|---|
| 信息架构 | 单主页（当前工具的供应商列表）+ 13 个整屏子页，返回箭头回主页；用量在设置里 | 8 项文字侧栏；用量、路由、体检在设置 Tab | 3 项（主页 / 皮肤 / 设置），其余挂在设置下 | 13 项平铺侧栏，核心与边缘同级 | 6 项浮动底栏；编辑整页替换；管理线路是弹窗 |
| 导航形态 | 顶栏图标工具条 + 图标功能按钮 | 左侧栏，图标 + 文字 | 弹层卡片，可展开出导航卡 | 左侧深色栏 | 底部玻璃胶囊 |
| 视觉风格 | shadcn 白底、苹果蓝、橙色 FAB、玻璃类、原始色值多 | 浅灰画布、白卡、16px 圆角、英文大写眉题、彩色投影 | OKLCH 深色为主、噪点、光晕、发光圆章、渐变按钮 | 深灰面板、蓝色强调、渐变字标 | 浅灰画布、橙红主色、点阵地球、液态玻璃 |
| 字体与字号 | 系统栈无中文字体；14px 正文 | Inter + 系统无中文字体；10-13px；中间字重 | SF Pro Rounded / Segoe + 苹方雅黑（顺序正确）；14px；负字距 | 系统黑体（目视）；字小 | Inter + 苹方雅黑（顺序正确）；约 3/4 声明 ≤12px |
| 深色模式 | 有（HSL 变量） | 有（1145 行覆盖） | 有（深色为主，浅色对等） | 深色为主（截图） | **无** |
| 密度 | 低：一屏 6-7 张卡 | 中偏松：一屏 5-6 行 | 低（低频工具） | 中高，但字小 | 首页低：可见线路 3-4 条 |
| 多工具表达 | 10 个图标分段 + 更多；入口随工具增减；切换 / 累加只在 hover 按钮上区别 | 单工具 | 单工具 | 单工具 | Codex 专属，其他工具仅在会话筛选里 |
| 当前项表达 | 蓝边框 + 渐变（颜色为主） | "当前"徽章（点 + 字）+ 浅蓝底 | 不适用 | 蓝描边（目视） | 淡橙底 + 绿点 |
| 状态反馈 | toast、按钮转圈、余额"刚刚" | 状态胶囊（live region）、四态齐全、保留旧数据 | 状态机英雄区、结果横幅、失败回滚说明 | 状态面板先于操作、"未检查"胶囊 | toast + 页内横幅、按钮文案随状态变 |
| 破坏性确认 | 384px 确认框，可加复选框 | 列出待删项 + 安全勾选 | 底部 Sheet，写全副作用 | 未观测 | 确认框；当前线路禁删 |
| 推广 | 合作伙伴星标、预设 aff 链接、README 赞助 | 无（但有越狱模板） | README 赞助位 | README 大量赞助 + 侧栏"推荐内容" | 无（PRODUCT.md 明令禁止） |

---

## 4. 差异化机会

四个上游的**共同俗套**（均有证据，见 §1）：通用后台外壳（侧栏或顶栏 + "大标题 + 右上按钮" + 卡片列表）；当前项主要靠颜色；把用量、路由、体检塞进设置；装饰材质（玻璃、渐变、噪点、光晕、彩色投影）；小字号且不为中文排版；推广位；卡片网格装开关；无文字图标按钮。

建议（每条都是 [推]，括号里是依据）：

1. **用"路径条"替换地球做签名元素。** 一条横向路径：本机 Codex → Chimera++（直连或本地代理接管）→ 目标（官方账号 / 中转 / 自建），上面标协议与模型；切换时显示"切换中""需要重启"两个中间态，失败时断点落在出错的那一段。它编码真实信息，高度约 64-96px，替代 390px 的地球。（现有深色概念稿 `A24AwO.png`、`d91lB.png`、`ECYby.png`；维护者诊断稿"紧凑状态区 ~100px"；PRODUCT.md 要求"一眼看清当前路由"。）
2. **"工具 × 能力"的二维导航，而不是扁平页面。** 左侧窄栏只列"已启用的工具"（名称 + 模式标记 + 当前线路名或"已启用 N 条"），Codex 置顶并展开它独有的能力（线路、账号、提示词、Skills/MCP、会话、用量、运行时、外观、体检）；其他工具只有"线路"一项。能力不对称一眼可见，也不会出现空页。（brief §4；CCS 用"入口随工具增减"证明方向可行，但它用无文字图标且位置跳动。）
3. **静止状态下就能分出切换类与累加类。** 切换类 = 单选语义（顶部"当前线路"槽 + 其余行"切换到此"）；累加类 = 复选语义（每行开关 + "已启用 3 / 5 条"，没有当前槽）；工具页头第一句写模式。四个上游都没做到。（CCS `ProviderActions.tsx` 只在 hover 按钮上区分。）
4. **"写入预告"作为信任签名。** 任何会写本机配置的动作（切换、启用、修复、深链导入、恢复备份、首次启用工具）在确认处统一显示：将修改的文件绝对路径、是否先备份及备份位置、是否需要重启 Codex。（CX 的修复计划、CAM 的重启副作用文案、CPP 的"关闭后不会写入…"、brief §5-13 的路径要求，各做了一部分，没人做成统一机制。）
5. **表格化的高密度列表与中文排版底线。** 线路行 40-48px，列对齐，数字等宽（延迟、词元、额度）；中文正文 15px、辅助 12-13px、只用三档字重；1140×816 下首屏可见 8 条以上线路。（上游一屏 5-7 条；现状约 3/4 字号声明 ≤12px；register-product §5、typography-cjk §1。）
6. **材质克制，深浅同权。** 不用玻璃、渐变、噪点、发光；三层中性色 + 一个信号色 + 语义色三件套；深浅两套从同一张 token 表派生，组件零原始色值。（现状无深色、306 个十六进制色值；register-product §2、§10；brief §6。）
7. **交互签名：键盘优先 + 可撤销切换。** Ctrl+K 命令面板（"切换到 DeepSeek""查看额度"）、列表上下键 + Enter 切换；切换成功的提示带"撤销"，一键回到上一条线路。（register-product §9；四个上游都没有撤销。）
8. **凭据状态可见，但凭据本身不可见。** 密钥字段显示"已保存 · 末 4 位 · 最近验证时间"而不是一串星号；官方账号只显示邮箱、套餐、令牌状态（有效 / 需要重新登录），任何页面都没有令牌字段。（brief §6；CX 的 auth.json 可编辑是反例；CCS 的"前 4 位 + 星号"遮蔽是半步。）

---

## 5. 现有界面的诊断三条（atelier 改版要求）

1. **什么坏了（可观察）**：首页把内容区六成以上高度（390px 舞台）给了不承载信息的点阵地球，最高频的"切换线路"被压进一条 88px 的横向卡片带，超过 4 条就要横翻 [实·码 `chimera.css` L1574-1579、L3737-3748、L4054-4057；实·图 `chimera-home.png`]；外壳再占 27% 高度（70px 标题栏 + 150px 导航行）[实·码 `chimera.css` L1137]；约 3/4 的字号声明 ≤12px，没有深色模式，"更新"一词指三件事 [实·码 见 §1.5]；v2.8.0 的 10 个工具和 Codex 的 9 项能力在 6 项底栏里放不下 [推]。
2. **为什么坏**：构图从 VPN 类"连接控制台"氛围参考出发，装饰被当成主角，固定高度抵抗内容增长（维护者自己的诊断稿已指出）[实·文 `PRODUCT.md` Visual Research Reference；实·码 `designs/providers-redesign.html` L212-226]；信息架构按"只管 Codex"设计，导航是扁平页面集合，不是"工具 × 能力"结构 [实·文 `PRODUCT.md` Navigation and Product Scope]；token 只停在文件顶部，组件里直接写十六进制与 10-12px，DESIGN.md 与代码各自演化（主色三处不一致、圆角 15 种、等宽字体不同）[实·码 `chimera.css`；实·文 `DESIGN.md`]。
3. **改完应该有什么不同（可验收）**：在 1140×816 下不滚动即可看到至少 8 条线路及其类型、协议、模型、延迟；当前线路在灰度截图中仍可辨认；不看说明就能分出切换类与累加类工具；外壳占高不超过 15%；中文正文 ≥15px；深浅两套关键界面齐全；组件里不出现原始色值；导航里 Codex 显示全部能力、其他工具只显示有内容的项；"更新"只指一件事 [推，均可在设计稿上逐条核对]。

---

## 6. 事实、推断与未观测项

- **事实**全部带 [实·码] / [实·图] / [实·文] 与路径或行号；**推断**带 [推]；§2 每项的"含义"和 §4 全部建议都是推断。
- **没有运行时证据**：没有启动任何应用、没有 DOM 或 computed CSS；hover、focus、动效实际表现只来自源码声明。
- **截图可能落后于源码**：cc-switch 截图有 2026-01 手册图与更早的 README 图，与 v3.20.4 源码不完全一致（例如"当前使用"标签在新截图里已不见）；Codex-X 新版 UI 没有供应商页截图；Codex-App-Manager 仓库里没有应用截图，视觉全部是源码声明值。
- **CodexPlusPlus** 只用了 README 文字与图片，没有任何 token 数值；一张流程图含实现细节，按净室约束未转述。
- 刻意未查看：Codex-X `docs/screenshots/prompt-effects/` 下的越狱效果截图（与界面设计无关，且内容不可沿用）。
- 远程图片只记链接未下载：Codex-App-Manager README 的两张皮肤预览（见 §1.3）；cc-switch README 顶部赞助图。

---
