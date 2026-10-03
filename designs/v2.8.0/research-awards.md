# Chimera++ v2.8.0 界面重设计：获奖设计调研

- 调研日期：2026-09-27
- 调研目的：为 Chimera++（Tauri 2 桌面应用，1140×816 无边框窗口，product register，中文为主，10 个工具、Codex 旗舰）的界面重设计找"真正高级"的参照，并把"高级感"翻译成可操作的杠杆（atelier A7）。
- 判断框架：atelier SKILL §0-§2、`references/register-product.md`、`skills/core/anti-slop.md`、`skills/core/design-intelligence.md`、`references/typography-cjk.md`，以及 `register-brand.md` §2 的反射拒绝字体清单、`tokens.md` §4 的禁用色域。
- 证据规则：
  - 获奖以获奖页面本身为证据（链接直接指向奖项页或官方公告）；查不到就写"未查到获奖记录"并给出收录理由。
  - 文中"事实"与"推断"分开标注：能验证的给证据链接；凡是凭截图或经验判断的实现细节，一律标 **[推断]**。
  - 截图存放于 `D:\Desktop\_upstream_audit\v2.8.0\design\refs\`，文件名 `award-<站点>-<要点>.png`；截图反映的是 2026-09-27 当天的线上版本。
- 本文只做调研，不做设计稿，不定案。

---

## 1. 参考清单

### R1. Tide Guide: Charts & Tables（潮汐图表应用，Condor Digital）

- 链接：https://tideguide.com/ （tideguide.app 会跳转到这里）
- 奖项与年份（事实）：**Apple Design Awards 2026「视觉与图形」类应用获奖者**，同年也入围「交互」类。证据：Apple Newsroom 获奖公告 https://www.apple.com/newsroom/2026/06/apple-reveals-winners-of-the-2026-apple-design-awards/ ；入围名单 https://www.macstories.net/news/apple-announces-its-2026-apple-design-award-finalists/
- Apple 评语要点（事实，转述自上面的公告）：全屏图表里有定制动画；Liquid Glass 集成；水体主题；"与天空一致"的调色板。
- 截图：`refs/award-tideguide-fullscreen-chart.png`（官网首屏里的 iPad/iPhone/Watch 产品图）。截图可见的 iPad 布局（事实，来自截图）：左侧栏（搜索、今天）→ 顶部一行 7 个小号指标（气温、水温、风速、风向、浪高、湿度、紫外线）→ 一条占满工作区的潮位正弦曲线，红点标出"当前时刻"→ 12H/24H/7D/W 分段控件 → 底部一条细密的概览柱状条（相当于时间刷选器）。
- 高级感来自哪些杠杆：
  - **图表就是界面主体**，不是塞在卡片里的小插图。字号跨度靠"一个大读数 + 一条曲线 + 小号刻度"拉开，而不是靠很多同级标题。
  - **三层信息密度分得很干净**：顶部指标条（高密、小字、无容器）/ 主曲线（低密、大面积）/ 底部概览条（高密、纯图形）。密度不是平均分配的，而是"两头密、中间疏"。
  - **色相从产品自己的世界推出来**（天空、海水随时刻变化），这正是 atelier `tokens.md` §4"色相从产品世界里推"的范例，所以它不撞任何 AI 默认配色。
  - **动效挂在数据上**（曲线、当前时刻标记随时间推进），而不是入场编排。[推断：依据评语"定制动画"与应用商店图，未取得实现证据]
- 对 Chimera++ 可借鉴：用量页可以直接借"指标条 + 主曲线 + 底部概览刷选条"的三段结构：顶部一行无容器的小指标（本周期词元、成本、请求数、主力模型），中间一条词元曲线加"现在"标记，底部概览条选时间范围；图表颜色直接编码状态（正常/接近额度/超额），不另起装饰色。
- 注意（事实，2026-09-27 用浏览器读取计算样式核实）：官网标题里轮换的词（water / weather / forecast）是 `background-clip: text` + `linear-gradient(110deg, …)` 渐变字，标题字体是 `system-ui` 栈、700 字重、约 76px、负字距约 -0.03em。这是营销页写法，atelier 对渐变文字零容忍；只借它的产品界面，不借营销页。
- 不可照搬：随天空变色的全局主题在 Chimera++ 里没有对应的真实物理量，硬做就成了装饰；手机上的全屏单图适合单任务，1140×816 的桌面工作区要把图表放进分栏而不是铺满；Liquid Glass 是 Apple 平台材质，以 Windows 为主的 Tauri 应用不能依赖它成立。

### R2. Flighty（航班追踪应用，Flighty LLC）

- 链接：https://flighty.com/
- 奖项与年份（事实）：**Apple Design Awards 2023「交互」类应用获奖者**。证据：Apple Newsroom 2023 获奖公告 https://www.apple.com/newsroom/2023/06/apple-announces-winners-of-the-2023-apple-design-awards/ 。Apple 评语（原文转述）：详细的航班地图、机场导航与延误预测，"把关键信息放在最需要的地方"，界面直观。
- 收录说明：年份早于 2024，但它是"状态密集 + 实时变化"类产品界面的公认标杆，和 Chimera++"一眼看清当前线路是否健康"的核心任务同构，所以破例收录。官网首屏自己也标注了"Apple Design Award Winner 2023"。
- 截图：`refs/award-flighty-status-first.png`。截图里可见（事实）：
  - 通知文案一律"状态变化作标题，差值作副行"：`Gate changed / Changed to ORD Terminal 2 • Gate 7`、`AUS → JFK • Delayed 45m / FRA 6:30pm (45m late)`、`Flight changed / Departure: 8:28pm (was 11:30pm)`。**新值与旧值并列**，用户不用自己记上一个状态。
  - 航班列表行左侧是一个大号倒计时（`1h 38 minutes`），右侧是航线、`Departs On Time`（绿色文字）、带状态点的起降时刻。
  - 功能按旅程阶段组织：`Preflight / At the airport / After landing` 分段控件。
- 高级感来自哪些杠杆：
  - **状态先于装饰**：一张航班卡的第一视觉是"现在的状态"（准点/延误/登机口），其余信息降一级。这对应 atelier A7 的"对比度层级"：不是加颜色，而是把一个信息推到最大、其余明显退后。
  - **时间感知的渐进披露**：离起飞越近，显示的信息越具体。[推断：依据其官网宣传语与评语"关键信息放在最需要的地方"，未取得实现证据]
  - **大字号代码式标识**：机场三字码这类短标识用大字号、紧凑字距做成视觉锚点。[推断：依据产品截图]
- 对 Chimera++ 可借鉴：线路页的"当前线路"就是 Flighty 的"当前航班"：只把"线路名 + 健康状态 + 延迟"推到最大，其他（地址、协议、模型映射）降到次级；测速结果像延误预测一样用"文字 + 图标 + 色"三重编码；切换动作只在需要时出现。**"新值（原值）"的差值文案**可以直接用在切换反馈、测速与配置体检里，例如"已切换到 DeepSeek，延迟 180 ms（原 420 ms）""模型改为 deepseek-v4-pro（原 gpt-5.5）"，这比一个绿色对勾更让人放心。
- 不可照搬：地图与航迹是航班领域的真实数据，Chimera++ 没有地理语义（`PRODUCT.md` 明确禁止带标记的地图与"扫描"类安全俗套）；手机上的单卡片纵向堆叠不适合 1140×816 的双栏桌面布局。

### R3. Play（原生 SwiftUI 原型设计工具，Rabbit 3 Times）

- 链接：https://createwithplay.com/
- 奖项与年份（事实）：**Apple Design Awards 2025「创新」类应用获奖者**。证据：Apple Newsroom 2025 公告 https://www.apple.com/newsroom/2025/06/apple-unveils-winners-and-finalists-of-the-2025-apple-design-awards/ 。Apple 评语（转述）：一个"精密而易上手"的工具，让用户用 SwiftUI 框架搭建可交互原型。
- 收录理由：它是 2024-2026 年少有的、拿到顶级设计奖的**专业工具型界面**（画布 + 图层 + 检查器），和 Chimera++ 的"列表 + 检查器"结构同属一类。
- 截图：无（2026-09-27 本机访问 createwithplay.com 连接被关闭，WebFetch 同样失败）。因此本条关于界面形态的描述全部属于推断，只有奖项与评语是事实。
- 高级感来自哪些杠杆：
  - **专业工具的密度与平台原生控件并存**：检查器里是大量小控件，但控件全用平台原生形态，所以密而不乱。[推断：依据产品截图与"用 SwiftUI 框架搭建"的评语]
  - **"精密又易上手"靠渐进披露**：默认只露常用属性，高级属性折叠。[推断]
- 对 Chimera++ 可借鉴：线路编辑可以做成"左列表 + 右检查器"的专业工具形态：基础字段（名称、地址、密钥、模型）常驻，协议、模型映射、1M 上下文这类专家项放进可折叠分组，与 `PRODUCT.md` 的"渐进披露"原则一致。
- 不可照搬：iPad/iPhone 触控优先的控件尺寸与手势；它的画布是核心工作面，Chimera++ 没有画布，不应为了"像专业工具"硬造一块画布。

### R4. iA Writer（写作工具，Information Architects）

- 链接：https://ia.net/writer
- 奖项与年份（事实）：**Apple Design Awards 2025「交互」类入围**（不是获奖者；该类应用获奖者是 Taobao 的 Vision Pro 版）。证据：Apple Newsroom 2025 公告 https://www.apple.com/newsroom/2025/06/apple-unveils-winners-and-finalists-of-the-2025-apple-design-awards/
- 截图：无（不是密集桌面界面的关键参照，按"每条至多一张、只截最关键的"原则未截）
- 高级感来自哪些杠杆：
  - **字体本身就是界面**：界面几乎没有装饰，层级全靠字重、灰度和一套自有等宽/双宽字体。对比度层级靠"亮一档、暗一档"，不靠色块。
  - **状态用"压暗其余"表达**：专注模式把当前句子以外的文字压暗，这是一种"降低其余"而不是"高亮当前"的层级手法。[推断：依据其公开功能说明，细节待核]
  - **来源可视化（事实）**：iA Writer 7 的 Authorship 功能把用户自己写的文字显示为黑色、粘贴或标记为 AI 生成的文字显示为灰色，并可按作者分色。证据：https://ia.net/topics/ia-writer-7 、https://ia.net/writer/support/editor/authorship 。同一种"墨色即来源"的编码不需要任何额外图形。
- 对 Chimera++ 可借鉴：提示词中心的"受管区块预览"可以借"来源可视化"：用户自己写的内容保持正常墨色，Chimera++ 注入的受管区块用另一种墨色 + 边标，一眼看清"哪些字是软件写的、卸载后会被移除"。会话详情里也可以用"压暗其余"突出当前轮次。
- 不可照搬：iA 的自有字体（iA Writer Mono/Duo/Quattro）是 IBM Plex 的改版（事实，见 https://github.com/iaolo/iA-Fonts 原文"This is a modification of IBM's Plex font"），而 IBM Plex 全系在 atelier 反射拒绝清单上，不宜直接拿来当界面字体；纯文字、零控件的极简只适合单一写作任务，Chimera++ 有大量操作控件，不能靠"去掉一切"获得高级感。

### R5. Vercel：Geist 设计系统与控制台（Vercel Ship 2025 活动站获 Awwwards 荣誉提名）

- 链接：设计系统 https://vercel.com/geist ；活动站 https://vercel.com/ship
- 奖项与年份（事实）：**Vercel Ship 2025 活动站获 Awwwards Honorable Mention（2025-05-22）**。证据：https://www.awwwards.com/sites/vercel-ship-2025 （2026-09-27 读取页面标题为"Vercel Ship 2025 - Awwwards Honorable Mention"，日期 May 22, 2025）。
- 注意：获奖对象是**活动营销站**；Vercel 控制台与 Geist 设计系统本身**未查到获奖记录**。收录理由：Geist 是少数把产品控制台的颜色阶梯、表面层级、组件状态完整公开的设计系统，而且它服务的正是"部署列表 + 状态 + 日志"这类与 Chimera++ 同构的开发者控制台。
- 截图：`refs/award-vercel-geist-color-steps.png`（Geist 颜色页：10 条色阶的 10 步色块矩阵；页面写明"在支持的浏览器和显示器上使用 P3 色"；顶部搜索框常驻 `Ctrl K` 快捷键提示）。
- Geist 文档里可核实的做法（事实，2026-09-27 读取 https://vercel.com/geist/colors 与 https://vercel.com/geist/materials ）：
  - 颜色：10 条色阶（backgrounds、gray、gray-alpha、blue、red、amber、green、teal、purple、pink）；除背景外每条 10 步（100-1000），**步号直接对应角色**：100-300 组件背景（默认/悬停/按下），400-600 边框（默认/悬停/按下），700-800 高对比背景，900-1000 文字与图标（次要/主要）；背景只有两个 token（background-100 默认、background-200 次级）；另有 gray-alpha 透明灰阶。
  - 表面"材质"：页内材质 `material-base`/`material-small`（圆角 6px）、`material-medium`/`material-large`（圆角 12px）；浮层材质 `material-tooltip`（6px，唯一带小尖角的浮层）、`material-menu`/`material-modal`（12px）、`material-fullscreen`（16px）。**每个材质把圆角和阴影深度打包成一个名字**，抬升越高阴影越深。
- 高级感来自哪些杠杆：
  - **token 纪律本身就是高级感的来源**：步号即角色，设计者没有"随手挑个灰"的空间，所以整个控制台的灰阶关系始终一致。这对应 atelier A7 的"统一圆角与阴影"和 `tokens.md` 的三层架构。
  - **圆角与阴影成对出现、按抬升分档**：页内只有 6/12 两档，浮层才到 16，天然满足 atelier `tokens.md` §6 的"形状锁"（一页最多两种圆角）和卡片 ≤16px 的上限。
  - **强调只来自状态色**，中性色承担绝大部分面积。[推断：依据控制台使用经验，与 register-product §2 的 Restrained 策略一致]
- 对 Chimera++ 可借鉴：把 Chimera++ 的单一 token 体系做成"步号即角色"的 OKLCH 阶梯（例如中性阶 100-300 只给背景、400-600 只给描边、900-1000 只给文字），并定义 3-4 个命名材质（页面表面 / 抬升面板 / 浮层菜单 / 对话框），组件只能引用材质名。这直接满足 brief §6"单一令牌体系、组件不出现原始色值"。
- 不可照搬：Geist 字体本身在 atelier 反射拒绝清单上（无衬线一栏明确列出 Geist），而且它是 Vercel 的品牌字体，用了就会"像 Vercel"；纯黑白高对比在 Vercel 是品牌的一部分，照搬会失去 Chimera++ 自己的识别度。

### R6. Linear（项目管理/问题跟踪工具）

- 链接：https://linear.app/ ；方法论原文 https://linear.app/now/how-we-redesigned-the-linear-ui （"How we redesigned the Linear UI (part II)"，2024-03-28）
- 奖项与年份：**未查到获奖记录**。2026-09-27 在 Awwwards 站内搜索"linear""linear.app"均无 linear.app 条目；ADA 2024/2025/2026 名单中没有；Webby 公开页受注册墙限制，搜索引擎也未检出。收录理由：它是 2024-2026 年开发者工具界面最常被引用的密度与层级范本，而且**公开写了重设计方法**，可以直接转成杠杆。
- 截图：`refs/award-linear-dense-app-ui.png`（官网首页里用 HTML 搭的产品界面：侧栏 + 问题详情 + 活动流 + 右侧代理面板）。截图与计算样式可见（事实，2026-09-27）：
  - **单行两级墨色**：活动流每一行是"小图标 + 亮墨的主体（人名/对象）+ 暗墨的动作 + 更暗的时间"，例如 `Linear moved from Todo to In Progress · just now`，一行之内就有三级对比。
  - 等宽字只给标识符（行内代码 `vehicle_state`、分支路径 `master › ride/drv-364-…`）；改动统计用小号红绿数字 `+22 −10`。
  - 侧栏分组标题（Workspace、Favorites）比条目更暗更小，收藏项带彩色小图标作为唯一的色彩来源。
  - 页面字体栈 `"Inter Variable", "SF Pro Display", …`；标题 64px、字重 510（可变字体的中间字重）、字距 -1.408px（约 -0.022em）；页面底色 `rgb(8, 9, 10)`。
- 可核实的做法（事实，出自上面的文章原文）：
  - 主题生成从 HSL 换到 **LCH 色彩空间**；每个主题原本要定义 98 个变量，现在只定义 **3 个输入：基色、强调色、对比度**，其余全部推导。
  - 标题用 **Inter Display** 增加表现力，其余文字仍用 Inter。
  - 调整侧栏、标签页、页头和面板，"减少视觉噪音、保持视觉对齐、提高导航元素的层级与密度"，花时间把侧栏和标签页里的标签、图标、按钮在横纵两个方向上对齐。
  - 限制"品牌色（蓝）"在颜色计算中的参与度，以获得更持久的观感；浅色模式文字和中性图标加深、深色模式提亮，以提高内容对比。
- 高级感来自哪些杠杆：
  - **对比度层级**：内容文字更黑（或更白）、界面框架更安静，主次靠明度差拉开，而不是靠加颜色。这正是 atelier A7"不够高级"的第一条杠杆。
  - **对齐精度**：侧栏图标与标签的横纵对齐是"看不出来但感觉得到"的精致感来源。
  - **色彩克制是算出来的**：品牌色在中性色里的比例被刻意压低，中性色只带极少的色相。
- 对 Chimera++ 可借鉴：用"3 个输入推导整套主题"（基色、强调色、对比度）的思路来建 OKLCH 阶梯，外观/换肤只暴露这三个旋钮，就能保证任何皮肤都不破坏层级；侧栏与列表行做严格的图标与文字基线对齐；浅色模式正文墨色加深到接近纯黑的带色相中性色。
- 不可照搬：Inter / Inter Display 在 product register 里是允许的（`register-product.md` §1），但它也在 brand 反射清单上，用了容易"像 Linear"；Linear 的签名（深色底 + 极淡紫蓝调中性色 + 发光渐变营销图）已被大量模仿，照搬等于撞款；510 这类中间字重依赖拉丁可变字体，中文字体通常只有常规/中等/粗三档（`typography-cjk.md` §2），中文界面无法复制这种细腻的字重层级，只能靠墨色明度补。
- 对 Chimera++ 补充可借鉴：会话详情、配置体检、备份列表的时间线都可以用"亮墨主体 + 暗墨动作 + 更暗时间"的单行三级对比，例如"**OpenAI 官方** 切换为当前线路 · 2 分钟前"。这在中文里比靠字重分级更可靠。

### R7. Claude Code（终端里的 AI 编程工具，也是 Chimera++ 管理的 10 个工具之一）

- 链接：https://www.anthropic.com/claude-code
- 奖项与年份（事实）：**2026 年第 30 届 Webby Awards，AI 类"AI Features & Innovation / Best Product or Service"，同时获 Webby Award 与 People's Voice Award**。证据：Webby 官方新闻稿 https://www.webbyawards.com/press/press-releases/30th-annual-webby-awards-announce-2026-winners/
- 注意：Webby 获奖库（winners.webbyawards.com）2026-09-27 需要注册登录才显示条目，因此本条以官方新闻稿为证据；奖项颁给的是整个产品，不是某个视觉界面。
- 截图：无（终端界面，官网营销图不代表真实使用态；按"只截最关键"原则未截）
- 高级感来自哪些杠杆：
  - **每一次写操作之前都先展示"将要做什么"并请求许可**（要执行的命令、要改的文件与差异），用户可以选择允许一次、本会话内不再询问、或拒绝。[推断：依据产品使用经验与公开文档的权限机制描述，未在本次调研中逐条核对界面文案]
  - **信任感来自可预期性而不是视觉修饰**：终端里没有材质可言，高级感完全来自"说清楚、问清楚、可回退"。
- 对 Chimera++ 可借鉴：brief §5.13 要求"深链导入确认框展示完整内容与目标文件绝对路径"，这正是同一种"先展示差异、再请求许可"的模式：确认框里给目标文件绝对路径、将写入的完整内容（密钥遮蔽）、与现有配置的差异、以及"允许 / 拒绝"两个明确动作；配置体检的"一键修复"同样先列出将改动的文件与备份位置。另外，Chimera++ 的用户本来就是这类终端工具的重度用户，他们已经习惯"差异 + 许可"的交互语言，沿用它能降低学习成本。
- 不可照搬：终端的单色、逐行滚动表现形式不适合图形界面的总览任务；它的品牌元素（吉祥物、橙色系）属于 Anthropic 品牌，Chimera++ 不能挪用任何上游工具的品牌视觉（`DESIGN.md` 明确禁止在界面里出现上游作者名、赞助标记与仓库标签）。

### R8. Adobe Frame.io V4（专业视频审阅与素材协作平台）

- 链接：https://frame.io/
- 奖项与年份（事实）：**2025 年第 29 届 Webby Awards，Apps & Software 类"Software Services & Platforms / Creative Production"，Webby Award**。证据：Webby 官方新闻稿 https://www.webbyawards.com/press/press-releases/29th-annual-webby-awards-announce-2025-winners/
- 截图：无（营销站主要是视频与合成图，不是真实使用态；按"只截最关键"原则未截）
- 可核实的做法（事实，出自 Frame.io 官方博客 V4 系列：https://blog.frame.io/2024/04/23/frame-io-v4-beta-metadata-collections/ 、https://blog.frame.io/2024/05/21/frame-io-v4-web-app-beta-feature-focus-new-design-smooth-navigation/ ）：
  - 元数据是 V4 的核心：内置 32 个元数据字段，另有状态、精选、评分、指派人、关键词等可自定义字段。
  - Collections：按元数据实时筛选、分组、排序并保存的"智能视图"。
  - 新的面板系统：可以展开全部面板多任务并行，也可以全部收起获得无干扰的专注视图。
- 高级感来自哪些杠杆：
  - **把"元数据"当一等公民**：同一批条目可以按字段筛选、分组、排序并保存成视图，密集但由用户控制。
  - **面板可展开可收起**：密度不是设计者一次定死的，而是用户按任务调节，这是专业工具"密而不压迫"的关键。
  - **深色中性工作面让内容（视频画面）成为唯一的高饱和区域**，界面框架退后。[推断：依据产品截图]
- 对 Chimera++ 可借鉴：会话页与线路列表都属于"多字段条目"：可以借"列表/紧凑两种视图 + 用户决定显示哪些字段"（会话：项目目录、工具、模型、词元、时间；线路：地址域名、协议、模型、延迟），而不是把所有字段挤进一张卡片。
- 不可照搬：以视频画面为中心的暗房式界面依赖"内容本身是彩色图像"，Chimera++ 的内容是文字与数字，照搬暗房只会得到一块黑。

### R9. HarmonyOS Design 与 HarmonyOS Sans（华为，中文界面与中文字体）

- 链接：设计资源 https://developer.huawei.com/consumer/cn/design/resource-V1/
- 奖项与年份：
  - （事实，红点官网条目）**HarmonyOS Sans：Red Dot 2022，品牌与传达设计·字体（Typography）类**，https://www.red-dot.org/project/harmonyos-sans-61231 （设计方：Huawei Device (Shenzhen) Co., Ltd.）。
  - （事实，红点官网条目）**HarmonyOS 2 Design System：Red Dot 2021，品牌与传达设计·界面与用户体验设计类**，https://www.red-dot.org/project/harmonyos-2-design-system-55307 。官方描述要点：为手机、平板等不同设备提供一致体验，"用户学习时间最少"，服务卡片无需打开应用即可获取信息。
  - （媒体报道，未找到红点官方条目）HarmonyOS Design 获 **2026 年红点"Best of the Best"**，"HarmonyOS 全场景 UX 设计""小艺伴随式 AI UX 设计"获红点奖。来源：CNMO https://phone.cnmo.com/news/813918.html 。2026-09-27 在红点官网站内搜索未检出对应条目（站内搜索为前端渲染，也可能是检索方式所限），因此本条只作为线索，不作为获奖证据。
- 截图：无（本条重点是字体与排版规则，截图价值低于下方飞书条目）
- HarmonyOS Sans 的官方设计说明（经第三方转载，原始出处为华为开发者联盟设计资源页；转载见 https://www.thosefree.com/harmonyos-sans 、https://www.maoken.com/freefonts/11157.html ）：
  - 短笔画横平竖直、无装饰，撇捺弯钩等长笔画融入书法笔势，"在人文和现代中找到新的平衡"。
  - 字重从常规扩展到 Thin、Light、Bold、Black，并支持可变字重。
  - **数字有变宽与等宽两套**：段落里用变宽数字保证阅读连贯，表格、时钟、频繁变化的数据用等宽数字保证对齐。
  - **西文字形"更显大、更显宽"，以匹配汉字的视觉大小**，专门解决中英混排不协调。
  - 与汉仪字库合作定制，面向社会免费商用。
- 高级感来自哪些杠杆：
  - **中英混排在字体层面就解决了**：atelier `typography-cjk.md` §7 要求混排时把拉丁字母放大 5-10%，HarmonyOS Sans 把这件事做进了字形里，界面上不需要任何补偿样式。
  - **数字按场景分两套**，与 `register-product.md` 的"数字必须 tabular-nums"完全对齐。
  - 设计系统层面强调"跨设备一致 + 学习成本最低"，这是 product register 的可预测性原则在操作系统级别的样本。
- 对 Chimera++ 可借鉴：中文界面字体栈可以把 HarmonyOS Sans SC 放进候选（在系统已安装时优先使用），数字密集区（延迟、词元、成本、版本号）强制用等宽数字；即使最终不用这款字体，也要照它的判据挑拉丁字体：x 高度大、字面宽，能和汉字视觉等大。
- 不可照搬：CJK 字体单字重就有数 MB，brief §6 说入口包体积余量很小，**不能把它打包进安装包当默认字体**，只能走"系统已有则用"的字体栈或做严格子集化；"免费商用"不等于允许随软件再分发，打包前必须逐条核对其许可协议 [待核实]；手机系统的大圆角卡片、服务卡片形态不适合桌面密集工具。

### R10. 飞书 Feishu（字节跳动的协作办公平台，中文 B 端界面）

- 链接：https://www.feishu.cn/
- 奖项与年份：**未查到获奖记录**（2026-09-27 以"飞书 / Feishu / Lark + iF / 红点"检索未检出；红点站内搜索为前端渲染，未能逐条核对）。收录理由：它是中文开发者与知识工作者每天使用的高密度桌面产品，中文界面的字号、墨色与中英混排被大量国内产品参照，属于"公认优秀"的中文样本。
- 截图：`refs/award-feishu-cjk-typography.png`（官网首页）。截图可见（事实）：首屏是紫蓝渐变底 + 倾斜透视的产品界面图；下方 6 个产品入口是**用 1px 分隔线切出的无阴影格子**（图标 + 名称 + 一行说明 + 箭头），不是卡片堆叠；"将 AI 融入各业务环节"这类中英混排标题中英之间有空格。
- 可核实的排版做法（事实，2026-09-27 读取官网首页计算样式；注意这是营销首页，不是登录后的产品界面）：
  - 字体栈：`"Helvetica Neue", Helvetica, "PingFang SC", "Microsoft YaHei", Tahoma, Arial`，**拉丁字体在前、中文字体在后**，与 `typography-cjk.md` §2 的顺序一致；部分模块直接用 `"PingFang SC"`。
  - **所有标题与正文字距都是 0（normal）**，没有任何负字距。
  - 字号与行高：h1 40px / 48px（1.2），字重 600；区块标题 28px / 42px（1.5）；导语 20px / 30px（1.5）；卡片标题 16px / 24px（1.5），字重 500；引用小字 14px / 约 22px（1.57）。
  - 墨色：主文字 `rgb(31, 35, 41)`（#1F2329，带冷调的近黑，不是纯黑）；次级文字 `rgb(100, 106, 115)`（#646A73）。
  - **中英混排靠手工加空格**："将 AI 融入各业务环节""字节跳动旗下 AI 工作平台""2026 飞书未来无限大会"；计算样式里 `text-autospace` 为 `no-autospace`，即没有依赖 CSS 自动间距。
  - 字重只用 400 / 500 / 600 三档。
- 高级感来自哪些杠杆：
  - **墨色是带色相的近黑 + 一个明确的次级灰**，只有两级文字灰度就撑起了层级；这对应 atelier `tokens.md` §2"中性色不要纯灰"。
  - **字距归零、字重三档**：完全符合中文字体只有常规/中等/粗三档的现实（`typography-cjk.md` §2），层级靠字号与墨色拉开，不靠字距花样。
  - **中英之间留 1/4 em 左右的空隙**（此处用普通空格实现），中文里夹"AI""2026"不显得粘连。
- 对 Chimera++ 可借鉴：中文界面的文字只设两到三级墨色（主 / 次 / 弱），全部用带冷暖倾向的近黑推导；混排的技术名词（Codex、API、gpt-5.5）前后留空格，文案层面就定规则，不依赖浏览器支持 `text-autospace`（Tauri 在 Windows 上走 WebView2，也就是 Chromium 内核，新版本可用 `text-autospace`，但不应作为唯一手段）。
- 不可照搬：营销页 1.5 的行高和 14px 小字只适合短句与标签，atelier 对中文正文的下限是 15px、行高 1.7（`typography-cjk.md` §1），Chimera++ 的说明性段落（确认框、风险提示、空状态）要守这个下限；飞书的品牌蓝与大面积插画是它自己的识别，不能借；首屏的紫蓝渐变 + 倾斜透视产品图正落在 atelier `tokens.md` §4.3 的"AI 紫 / 紫蓝渐变"禁区和"悬浮 3D 产品图"俗套里，只借排版规则，不借营销视觉。

### R11. Raycast（键盘优先的桌面启动器 / 命令面板，macOS 与 Windows）

- 链接：https://www.raycast.com/ ；Windows 版 https://www.raycast.com/windows
- 奖项与年份：**未查到获奖记录**（Awwwards 站内搜索"raycast"无条目；ADA 2024-2026 名单中没有；Webby 公开新闻稿中没有）。收录理由：atelier `register-product.md` §9 把"键盘优先（Raycast/Linear）"列为 product 的交互签名范例；而且它是少数**同时认真做了 Windows 原生版**的高水准开发者工具，和 Chimera++"Windows 为主、兼顾 macOS"的约束完全一致。
- 可核实的事实：
  - Windows 版 **2025-11-20 进入公开测试**，官方原话是要让它"built to feel like it belongs here, not like something ported over"，使用 Windows 用户熟悉的快捷键和"融入系统"的设计；因为 Windows 没有满足其标准的系统级索引，文件搜索的索引器是自己从零写的。证据：https://www.raycast.com/blog/raycast-for-windows
  - 扩展 API 里有独立的 `ActionPanel` 组件，即"选中一项后调出这一项的全部动作"的操作面板。证据：https://developers.raycast.com/api-reference/user-interface/action-panel
- 截图：`refs/award-raycast-windows-command-palette.png`（Windows 版落地页）。截图可见（事实）：命令窗口的每一行是"图标 + 亮墨主名称 + 暗墨来源（GitHub / File Search）+ 右对齐的类型标签（Command）"；输入框右端是 `Ask AI` 加一个 `Tab` 键帽提示；分组标题（Favourites）是更小更暗的字；页脚用等宽字写 `v2.5.2.0 | Windows 10+ | Install via WinGet`。首屏的衬线大字与颗粒黑白照片属于营销页，不是产品界面。
- 高级感来自哪些杠杆：
  - **交互签名而非视觉签名**：输入框 + 结果列表 + 当前项的动作面板，每个动作旁边标快捷键。熟练用户越用越快，这就是 product register 的签名。
  - **动效极短、几乎只做状态反馈**，打开即可用，没有入场编排。[推断：依据使用经验]
  - **跨平台时"像原生"优先于"像自己"**：Windows 版改用 Windows 的快捷键与惯例，而不是把 macOS 的样子搬过去。
- 对 Chimera++ 可借鉴：做一个全局命令面板（`Ctrl K`），把"切换到某条线路""全部测速""打开会话""运行配置体检"都变成可搜索的命令；列表行支持"选中后调出动作面板"，动作旁显示快捷键；Windows 上一律用 Ctrl 与右侧窗口按钮，macOS 上换成 ⌘ 与左侧红绿灯，而不是一套外观硬套两个平台（`DESIGN.md` 已明确禁止在 Windows 上仿 macOS 红绿灯）。
- 不可照搬：Raycast 是"呼出即用、用完即走"的浮窗，Chimera++ 是常驻主窗口，命令面板只能是加速入口，不能是唯一入口（`register-product.md` §8）；它的扩展商店生态与 Chimera++ 的"不做推广位"原则无关，不要借商店式陈列。

### R12. Warp（带 AI 的现代终端，macOS / Linux / Windows）

- 链接：https://www.warp.dev/ ；Blocks 文档 https://docs.warp.dev/terminal/blocks
- 奖项与年份：**未查到获奖记录**（Awwwards 站内搜索"warp"无该产品条目；CSSDA、Webby 公开信息中未检出）。收录理由：它是把"终端输出"这种最无结构的信息重新结构化的代表作，并且 **2025 年 2 月推出了 Windows 原生版**（支持 PowerShell、WSL、Git Bash，x64 与 ARM64），和 Chimera++ 的用户、平台都重合。证据：https://www.warp.dev/blog/launching-warp-on-windows
- 可核实的事实：官方定义"A Block groups commands and outputs into one atomic unit"，每个 Block 可以单独复制命令、复制输出、跳到输出开头、重新输入、带格式分享、加书签。证据：上面的 Blocks 文档。
- 截图：无（按"只截最关键"原则未截；Blocks 的价值在结构，不在视觉）
- 高级感来自哪些杠杆：
  - **把一长串滚动日志切成"可操作的原子单元"**：信息密度不变，但每一块都有边界、有动作、可以被键盘选中，于是"密"不再等于"乱"。
  - **动作跟着对象走**：不是页面顶部一排按钮，而是选中哪个块就对哪个块操作，这与 Raycast 的动作面板是同一条思路。
- 对 Chimera++ 可借鉴：会话详情把"一轮对话（提问 + 回复 + 工具调用 + 词元）"做成一个 Block，块上直接有"复制 / 导出这一轮 / 查看词元"；配置体检把每个检出问题做成一块（问题、影响的文件、修复动作、修复前备份位置）；测速日志同理。
- 不可照搬：终端的等宽全文排版不适合中文为主的图形界面；它的 AI 输入框居中、营销页大面积渐变都不属于 Chimera++ 要借的部分。

### R13. (Not Boring) Camera（Not Boring Software，触感化、带皮肤的工具应用）

- 链接：https://notbor.ing/ （notboring.software 301 跳转至此）
- 奖项与年份（事实）：**Apple Design Awards 2026「视觉与图形」类入围**（不是获奖者）。证据：MacStories 转载的官方入围名单 https://www.macstories.net/news/apple-announces-its-2026-apple-design-award-finalists/ ；获奖公告见 R1 的 Apple Newsroom 链接（该类应用获奖者为 Tide Guide）。
- 可核实的事实（官网原文）："Built like a game, Runs like an app"；"using 3D, animation, physics, haptics, and sounds"；"No menus. No unnecessary features. Just simple swipes and taps."；提供按系列发布的皮肤（"Skins for every occasion"）。
- 截图：无（手机应用，与桌面密集界面差距大，按"只截最关键"原则未截）
- 高级感来自哪些杠杆：
  - **材质与物理感拉满**：控件是有体积、有光泽、会回弹的"实物"，签名元素极强。
  - **皮肤是一等功能**：同一套结构换整套材质，而结构和交互不变。
- 对 Chimera++ 可借鉴：只借一处，而且只借"分寸"：整个界面保持 product register 的克制，只让**一个**与核心任务绑定的控件拥有物理感（例如"切换当前线路"那个动作的按压、落位反馈），这就是一个可被记住的签名元素；Chimera++ 本身有"外观（换肤）"模块，它"结构不变、材质可换"的皮肤观可以用来定义换肤预览的边界（换肤只动 token，不动布局）。
- 不可照搬：它的哲学是"帮你享受时间而不是节省时间"，与 Chimera++"每天切换八次、要快要准"的任务正好相反；游戏化的 3D、物理与音效铺满全界面会违反 `register-product.md` §4（动效 150-250ms、禁止弹跳缓动）与 brief §6 的性能预算。

### R14. Things 3（任务管理，Cultured Code，Mac / iPhone / iPad）

- 链接：https://culturedcode.com/things/
- 奖项与年份（事实）：**Apple Design Award 2017**（Things 的第二个 ADA，第一个是 2009 年 Mac 版）。证据：获奖方公告 https://culturedcode.com/things/blog/2017/06/back-from-wwdc/ （原文"Things has won another Apple Design Award at this year's WWDC for our all-new version!"）；Apple 开发者站的奖项页在本机 WebFetch 下不可达，未能直接取证。
- 收录说明：年份远早于 2024，破例收录的理由只有一个：它的桌面版有一个教科书级的**交互签名**，正好补 product register 签名元素的样本。
- 可核实的事实：Mac 版 **Type Travel**：不按任何快捷键，直接开始输入想去的列表、项目、标签或待办的名字，回车即跳转。证据：https://culturedcode.com/things/features/ 、快捷键文档 https://culturedcode.com/things/support/articles/2785159/
- 截图：无（按"只截最关键"原则未截）
- 高级感来自哪些杠杆：
  - **交互签名零学习成本**：不需要记住 `Ctrl K`，"开始打字"本身就是入口，熟练用户越用越快，新用户也不会被吓到。
  - **安静的密度**：列表行高紧凑、分组靠小标题与间距而不是分隔线，界面看起来"空"但一屏信息量并不少。[推断：依据产品使用经验]
- 对 Chimera++ 可借鉴：在线路列表、会话列表、提示词库这些列表界面里，焦点不在输入框时"直接打字即筛选/跳转"（例如在线路页直接输入"kimi"就定位到 Kimi 线路），与 R11 的命令面板互补：一个是全局入口，一个是就地入口。
- 不可照搬：它的魔法加号拖拽插入、手机上的手势体系都与 Chimera++ 的任务无关；"直接打字"必须避开输入框、对话框与中文输入法组字状态（IME composition），否则会误触发，这一点要在交互规格里写死。

### 1.x 检索覆盖与未收录项（便于复核）

| 来源 | 本次检索方式 | 结果 |
|---|---|---|
| Apple Design Awards 2023-2026 | Apple Newsroom 官方公告（developer.apple.com 在本机 WebFetch 下不可达） | 收录 R1 Tide Guide、R2 Flighty、R3 Play、R4 iA Writer、R13 (Not Boring) Camera、R14 Things 3。2024 年获奖者（Crouton、Rooms、Procreate Dreams 等）与数据密集桌面工具关联弱，未收录 |
| Webby Awards 2025-2026 | 官方新闻稿（winners.webbyawards.com 需注册，条目不可见） | 收录 R7 Claude Code（2026）、R8 Frame.io V4（2025）。Raycast、Warp、Arc、Linear、Cursor 等未在公开信息中检出 |
| Awwwards | 浏览器内站内搜索 + 条目页读取 | 收录 R5 的 Vercel Ship 2025（Honorable Mention，2025-05-22）。另检出但未收录：Linearity 官网 HM（2023-08-09、2026-01-20，设计工具营销站）；Things, Inc. 官网 HM（2025-08-30，即 ADA 2024 获奖应用 Rooms 的开发商）；Resend Launch Week VI、Wispr Flow、AP Transit 仅为 Nominee（提名不等于获奖）；站内名为"Arc"的 HM 条目是英国招聘公司 wearearc.co.uk，"New Arc"是设计工作室，**都不是 The Browser Company 的 Arc 浏览器** |
| CSS Design Awards | 站内搜索（参数被忽略，只返回最新提名）+ 搜索引擎定向检索 | 未检出任何开发者工具的产品界面获奖记录 |
| The FWA | 搜索引擎定向检索 | 未检出开发者工具 / 仪表盘类产品界面 |
| Red Dot | 红点官网站内搜索 + 条目页 | 收录 R9（HarmonyOS 2 Design System 2021、HarmonyOS Sans 2022）。2026"Best of the Best"仅有媒体报道，官网未检出 |
| iF Design Award | 获奖方公告 + 搜索引擎 | 2026 年 Opera GX 获 iF 用户界面类（Opera Neon、Opera Air 获的是品牌与传达类，证据 https://blogs.opera.com/news/2026/03/opera-wins-four-2026-if-design-awards/ ）。GX 是电竞风浏览器，霓虹 RGB 视觉与 Chimera++ 的任务相反，不作正面参照，只在第 3 部分作反例。中文产品（飞书、钉钉、WPS、腾讯文档）的 iF 界面类获奖记录未检出 |

结论（推断）：**网页类奖项（Awwwards、CSSDA、FWA）几乎只奖励 brand register 的营销站与作品集**；数据密集的产品界面主要在 ADA、Webby 的应用类、红点/iF 的界面类里被认可。因此本调研里真正的"产品界面"证据主要来自后三者，营销站只取其产品截图与公开设计系统。

---

## 2. 横向规律（2024-2026 高水准产品界面的共性）

说明：以下 8 条是从上面 14 个参考中归纳出来的，**归纳本身属于推断**；每条所引例子的事实依据见对应的 R 编号。

**G1. 状态是第一视觉对象，"现在"被明确标出。**
高水准产品界面的第一眼永远是"此刻的状态"，而不是功能入口。例：Flighty 的通知标题直接写状态变化（`Gate changed`、`Delayed 45m`）（R2）；Tide Guide 在主曲线上用一个红点标出"当前时刻"（R1）；Linear 的活动流每行都以相对时间收尾（`just now`、`2 min ago`）（R6）。
→ Chimera++：线路页首屏的第一对象是"当前线路 + 健康状态 + 最近一次测速的时间"，时间用相对表述。

**G2. 层级靠墨色明度拉开，一行之内也分级；颜色只留给状态。**
例：Linear 活动流"亮墨主体 + 暗墨动作 + 更暗时间"（R6）；Raycast 结果行"亮墨名称 + 暗墨来源 + 右侧类型"（R11）；iA Writer 用黑与灰区分自写与 AI 文字（R4）；飞书只用两级文字灰（#1F2329 / #646A73）撑起层级（R10）；Geist 的 900-1000 两步专给文字（R5）。
→ Chimera++：定义 3 级墨色（主 / 次 / 弱）并允许在同一行混用；强调色不参与文字层级。这在中文里尤其重要，因为中文字体没有拉丁可变字体那样细的字重阶梯。

**G3. token 纪律本身就是"高级感"：步号即角色，少量输入推导整套主题。**
例：Geist 的颜色步号直接对应"背景 / 边框 / 高对比背景 / 文字"，表面材质把圆角和阴影打包命名（R5）；Linear 把每个主题 98 个变量压缩成"基色、强调色、对比度"3 个输入，并在 LCH 空间里推导（R6）；HarmonyOS 设计系统以"跨设备一致、学习成本最低"为目标（R9）。
→ Chimera++：brief 要求单一 token 体系，这条规律给出了做法：OKLCH 阶梯的步号固定语义，外观/换肤只暴露少数几个输入。

**G4. 交互签名胜过视觉签名：键盘与"就地输入"让熟练用户变快。**
例：Raycast 的命令面板与 `ActionPanel`，动作旁标快捷键，`Ask AI` 旁有 `Tab` 键帽（R11）；Things 的 Type Travel，直接打字即跳转（R14）；Linear 把侧栏与标签页的对齐与密度作为重设计重点（R6）。
→ Chimera++：`Ctrl K` 全局命令面板 + 列表内直接打字筛选，两者都要兼容中文输入法组字。

**G5. 把长流信息切成"可操作的原子单元"，动作跟着对象走。**
例：Warp 的 Block 把命令与输出组成一个原子单元，单独复制、分享、加书签（R12）；Raycast 选中一项再调出这一项的动作（R11）；Frame.io 用元数据生成可保存的智能视图（R8）。
→ Chimera++：会话详情按"轮"成块，配置体检按"问题"成块，每块自带动作，不在页面顶部堆一排全局按钮。

**G6. 密度是分层的、可调的，而不是整页一个值。**
例：Tide Guide"顶部指标条高密 / 主曲线低密 / 底部概览条高密"（R1）；Frame.io 的面板可全部展开多任务、也可全部收起专注（R8）；Linear 明确"提高导航元素的密度"而内容区保持宽松（R6）。
→ Chimera++：导航与列表走密（`VISUAL_DENSITY` 6-7），当前线路区与编辑检查器走疏，同一屏里有意识地"两头密、中间疏"。

**G7. 差异、来源与许可都看得见：信任是设计出来的。**
例：Flighty 通知里新值与旧值并列（`was 11:30pm`）（R2）；iA Writer 让"谁写的"一眼可见（R4）；Claude Code 在执行写操作前展示将要做的事并请求许可（R7）。
→ Chimera++：切换、导入、修复三类操作一律"先展示差异（含目标文件绝对路径与备份位置），再请求确认，完成后给出新值与原值"。这与 brief §6"凭据安全在界面上可见"是同一件事。

**G8. 平台原生感优先于"自己的样子"。**
例：Raycast 的 Windows 版明确要"像属于这里，而不是移植过来的"（R11）；Warp 的 Windows 版原生支持 PowerShell、WSL、Git Bash（R12）；Play 的评语强调基于平台框架构建（R3）；HarmonyOS 以跨设备一致为第一目标（R9）。
→ Chimera++：Windows 为主，窗口按钮在右、快捷键用 Ctrl、字体栈优先 Windows 已有字体；macOS 上换成对应惯例。签名元素要放在"内容区"，不要放在窗口外壳上跟系统较劲。

---

## 3. 俗套清单（获奖作品与 AI 生成界面里已被用滥的做法）

前三条是 atelier A2 的三个泛滥簇（命中即重做），后面是本次调研中观察到或规则里点名的补充。"在哪看到"一栏只写本次确有证据的出处。

| # | 做法 | 在哪看到 / 依据 | 为什么显得廉价或模板化 |
|---|---|---|---|
| C1 | **暖奶油底（≈`#F4F1EA`）+ 高对比衬线 + 陶土色强调** | atelier A2 簇 1；`tokens.md` §4.1-4.2 | 2026 年"高端消费品"提示词的统计学默认值，看一眼就知道是生成的；而且奶油底在数据密集界面里会让灰阶发脏、状态色失真 |
| C2 | **近黑底 + 单一酸性绿 / 朱红强调** | atelier A2 簇 2；`tokens.md` §4.4 | 2024-2025 的默认"科技感"，已过载；单一高饱和强调在深底上还会和"成功 / 危险"语义色撞车，对状态密集的 Chimera++ 尤其致命 |
| C3 | **报纸风：发丝线分隔 + 零圆角 + 密排多列** | atelier A2 簇 3；`register-brand.md` §2 的 editorial-typographic 车道 | 把"有设计感"等同于"像杂志"，信息层级靠线条而不是分组；放进桌面工具会变成一张满是细线的表格 |
| C4 | **紫蓝渐变底 + 倾斜 / 悬浮的 3D 产品截图** | 飞书官网首屏（R10 截图）；`tokens.md` §4.3"AI 紫" | SaaS 营销页的默认构图，信息量为零；在产品界面里出现就等于把营销页搬进了工作区 |
| C5 | **渐变文字**（`background-clip: text`） | Tide Guide 官网标题（R1，计算样式已核实）；`tokens.md` §4.6 零容忍 | 最容易识别的"想显得高级"的手法；对比度随渐变位置变化，局部往往不达 AA |
| C6 | **"Linear 仿品"**：近黑底 + 淡紫蓝调中性色 + 发光描边 / 光晕营销图 + Inter + 大标题负字距 | Linear 本身（R6：底色 `rgb(8,9,10)`、标题 -0.022em）是原创；问题在于它已被成千上万个模板复制 | 撞款。用户会在一秒内认出"又一个仿 Linear 的开发者工具"，原创性归零 |
| C7 | **玻璃拟态 / 液态玻璃当面板默认样式** | ADA 2026 获奖者 Moonlitt、Tide Guide 的评语都提到 Liquid Glass（R1）；`register-product.md` §10 明确禁止玻璃拟态作面板默认样式 | 在 Apple 平台上它是系统材质，在 Windows 的 WebView 里只能靠 `backdrop-filter` 仿，性能差、可读性差、和系统格格不入；Chimera++ 现有 `DESIGN.md` 在 3 个表面上用了液态玻璃，改版时要重新审视这条例外 |
| C8 | **幽灵卡片**：1px 浅色描边 + 模糊 ≥16px 的大阴影 | `tokens.md` §7、`register-product.md` §10 | GPT 类模型的典型产物；边框和阴影两套边界同时存在，层次说不清 |
| C9 | **同尺寸指标卡网格 / 指标卡三连当首屏** | `register-product.md` §10；Chimera++ `DESIGN.md` 与 `PRODUCT.md` 的反模式 | 所有信息同权重，等于没有层级；"10x / 99.9% / 5 分钟"式数字常常是编的，违反 atelier A5 |
| C10 | **每个区块顶上一行小号大写宽字距标签 / `01 02 03` 编号脚手架** | `register-product.md` §10；atelier A3 的 eyebrow 规则 | 模板脚手架，读起来像落地页；中文界面里英文大写小标签更是水土不服 |
| C11 | **霓虹 RGB、发光边、深色模式外发光** | 2026 年 iF 用户界面类获奖的 Opera GX 就是电竞霓虹路线（见 1.x 表）；`tokens.md` §7"深色模式加发光边是 tell" | 获奖不代表适合：它服务的是"游戏氛围"，放进凭据管理工具会显得不严肃，也会让"错误 / 警告"的红黄失去显著性 |
| C12 | **地球仪、网络拓扑、扫描雷达等"安全科技"意象** | Chimera++ `PRODUCT.md` 反参照（v2.3.0 的 RouteGlobe 是受限例外） | 用恐惧感和科技感代替真实信息；线路切换没有地理语义，画地球等于装饰 |
| C13 | **月桂叶奖项徽章、"App of the Year"字样、营销数字进产品界面** | Tide Guide、Flighty 官网首屏（R1、R2 截图）用于营销页 | 营销页可以，产品界面里出现就是"界面夸自己"，brief 与 atelier A5 都禁止元文案和编造数字 |
| C14 | **超大展示衬线 + 颗粒黑白照片的"杂志封面"首屏** | Raycast Windows 落地页（R11 截图）；`register-brand.md` §2"editorial-typographic 车道已是 2026 AI 反射" | 高水准团队偶尔这样做是品牌表达，AI 大量复制后已成默认；产品界面里没有它的位置 |
| C15 | **"✦ 闪光图标 + 紫蓝渐变 = AI 功能"** | 飞书官网的 AI 功能图标（R10 截图中可见同类处理）[推断：属于行业普遍现象的观察，未做量化统计] | 所有 AI 功能都长一个样，信息量为零；Chimera++ 管理的正是 AI 工具，更不该用这个符号当装饰 |
| C16 | **行操作只在悬停时出现** | `register-product.md` §6 | 键盘与触屏到不了；看起来"干净"，实际是把可用性藏起来 |

补充判断（推断）：C4、C5、C13、C14 这几条在**获奖网站**里也普遍存在，这是因为它们大多出现在营销页（brand register）上；本次调研里真正的产品界面（R1-R14 的产品部分）几乎都没有这些手法。这再次说明：借鉴获奖作品时，只借它的产品界面，不借它的营销页。

---

## 4. 中文排版观察

### 4.1 可核实的事实

- **飞书官网（R10，计算样式）**：字体栈拉丁在前、中文在后（`"Helvetica Neue", Helvetica, "PingFang SC", "Microsoft YaHei", …`）；所有字距为 0；字重只用 400 / 500 / 600；标题行高 1.2（40/48），区块标题与导语 1.5，引用小字 14px / 约 1.57；主墨 #1F2329、次墨 #646A73；中英、中数之间手工加空格，没有依赖 `text-autospace`。
- **HarmonyOS Sans（R9，官方说明经转载）**：数字分变宽与等宽两套，按"段落 / 表格与时钟"分场景使用；西文字形刻意做得"更显大、更显宽"以与汉字视觉等大；字重从 Thin 到 Black 并支持可变字重。
- **微软雅黑（Windows 默认中文界面字体）只有 Light、Regular、Bold 三档**（含 Microsoft YaHei UI 的对应三档）。证据：https://learn.microsoft.com/en-us/typography/font-list/microsoft-yahei 。按 CSS 字体匹配规则（https://www.w3.org/TR/css-fonts-4/#font-style-matching ），缺少 500 时，`font-weight: 500` 会先落到 400；缺少 600 时，`font-weight: 600` 会落到 700。**也就是说，同一份 CSS 里的 500 与 600，在 Windows 雅黑上分别渲染成"常规"和"粗体"，在 macOS 苹方上则是真正的中黑与中粗。**
- **中文文案排版指北**（https://github.com/sparanoid/chinese-copywriting-guidelines ，国内开发者社区广泛采用的公开规范）：中英文之间加空格；中文与数字之间加空格；数字与单位之间加空格（度数、百分比例外）；全角标点与其他字符之间不加空格；中文里用全角标点、数字用半角；专有名词大小写要正确。
- **atelier `typography-cjk.md`**（本项目的硬约束）：中文正文 ≥15px、行高 1.7-1.8、标题行高 1.2-1.35、中文零负字距、拉丁字体在 CJK 字体之前、只依赖三档字重、`line-break: strict`、不用 `break-all`、不用两端对齐、变化数字用 `tabular-nums`、中文界面用"万 / 亿"而不是 K / M。

### 4.2 对 Chimera++ 的排版建议（推断 / 建议，交设计阶段定案）

1. **字体栈**：系统字体优先（brief §6 包体积余量小，CJK 字体不打包）。建议形态：`<拉丁 UI 字体>, "PingFang SC", "HarmonyOS Sans SC", "MiSans", "Microsoft YaHei UI", "Microsoft YaHei", sans-serif`。拉丁 UI 字体可以是 Windows 11 的 Segoe UI Variable / macOS 的系统字体，或一款体积小的开源拉丁字体（只含拉丁与数字，约百 KB 级，给界面一点自己的识别度）；无论选哪款，都要按 HarmonyOS Sans 的判据挑：x 高度大、字面宽，与汉字视觉等大，否则技术名词（gpt-5.5、Responses、Anthropic）在中文句子里会显得瘦小。[推断]
2. **字重只设计两档层级，第三级靠字号与墨色**：鉴于雅黑只有 300/400/700，中文层级建议只用 **400（正文）与 700（强调）**；需要第三级时用字号或墨色（主 / 次 / 弱三级墨）拉开，不要依赖 500/600，否则 Windows 与 macOS 会得到两套不同的层级。
3. **字号阶梯（中文）**：说明性正文 15px（行高 1.7）；列表行主文字 14-15px 单行（此时行高由行高度决定，不是段落行高）；元数据与时间戳 13px（只放短信息，不放句子）；徽章 12px 为下限。页标题 20-22px，区块标题 16-18px，比例控制在 1.125-1.2（`register-product.md` §1）。
4. **行高分两类**：多行段落（确认框说明、风险提示、空状态、提示词预览）一律 1.7；单行控件文字（按钮、标签页、列表标题）不套段落行高，按组件高度垂直居中。这是在 `register-product.md`"行高压到 1.4-1.5"与 `typography-cjk.md`"中文 1.7"之间的分场景处理。
5. **字距**：中文一律 0；只有纯拉丁的大数字（例如用量页的主读数）可以用最多 -0.01em；混排字符串整体不许加负字距。
6. **中英混排**：文案规范层面强制"中英之间、中数之间、数字与单位之间加空格"（例："延迟 180 ms""切换到 DeepSeek""本月 12.3 万词元"）；CSS 的 `text-autospace` 只作为补充，Tauri 在 Windows 上使用 WebView2（Chromium 内核），需要在项目支持的最低 WebView2 版本上实测后才能依赖 [待核实]。
7. **数字**：所有会变化或需要纵向对齐的数字（延迟、词元、成本、版本号、时间）开 `tabular-nums`，并让拉丁字体负责数字字形；数量级统一用"万 / 亿"（`Intl.NumberFormat('zh-CN', { notation: 'compact' })`），成本保留货币符号与两位小数；同一界面里不混用"万"和"K"。
8. **等宽字只给机器文本**：地址、模型 ID、文件绝对路径、密钥遮蔽串（如 `sk-…3f9a`）、版本号用等宽；中文句子里嵌入这些值时，等宽片段两侧同样留空格。
9. **标点**：中文句子用全角标点；不使用单个破折号（atelier A5），需要时用冒号、括号或断句；确认框里的文件路径独占一行，避免与中文标点挤在一起换行。

---

## 5. 三个概念方向草案（只给方向，不定案）

共同前提（三个方向都遵守）：
- Design Read（atelier §1.1）：**为了让每天多次切换线路的中文开发者感到"心里有数、敢切敢改"，这个界面必须把"现在用的是哪条线路、它健不健康、改了什么、能不能退回"放在第一眼。**
- register 锁定 product；中文字体一律走系统字体栈（见 4.2），三个方向只在**拉丁 / 数字字体、色彩逻辑、签名元素**上拉开差异；所选拉丁字体均已核实为 Google Fonts 上的 OFL 开源字体，且不在 atelier 反射拒绝清单上。
- 色相都从 Chimera++ 自己的世界推导（"线路""仪表""回执"），不从流行配色里挑；以下 OKLCH 值是方向性的起点，**对比度必须在设计阶段用工具逐对实测**，本文没有做对比度计算。
- 三个方向都必须回答 brief 的两个硬问题：切换类与累加类一眼可分；Codex 与其他工具能力不对称但不割裂。

### 方向 A「换乘」：线路即身份

- 情绪词：清楚、有方向感、亲切、可预期。
- 世界来源：Chimera++ 的"线路"与地铁"线路"是同一个词。每条供应商线路有一个固定的**线路色 + 线路徽标**，就像地铁的线路编号牌；界面框架本身是单色的，**颜色只属于线路身份**，不做装饰。
- 配色倾向（浅色优先，另配深色）：
  - 画布 `oklch(0.972 0.004 250)`、表面 `oklch(0.992 0.002 250)`（冷调近白，明确避开奶油色域 H 40-100）
  - 主墨 `oklch(0.22 0.02 255)`、次墨 `oklch(0.46 0.015 255)`、弱墨 `oklch(0.56 0.012 255)`
  - 主操作：主墨实底 + 白字（不用彩色主按钮）；焦点环 `oklch(0.55 0.17 250)`
  - 线路色：8 个等明度色（L 约 0.62、C 约 0.14），**色相刻意避开危险色（H 25 附近）与成功色（H 145 附近）**，保证线路身份与健康状态不会混淆
  - 状态色：成功 `oklch(0.55 0.13 150)`、警告 `oklch(0.72 0.15 75)`、危险 `oklch(0.55 0.20 25)`，一律配图标 + 文字
- 字体搭配：拉丁与数字用 **Overpass**（Delve Fonts 对美国公路标志字体 Highway Gothic 的屏幕化诠释，OFL，事实见 google/fonts 的官方简介），地址与模型 ID 用 **Overpass Mono**；中文走系统栈。标识体系的字体气质与"线路 / 换乘"一致。[待核实：Overpass 是否带 `tnum` 等宽数字特性，若没有则数字改用系统 UI 字体]
- 候选签名元素：**线路徽标 + "换乘"**。徽标是一个 20-24px 的小圆角方块（圆角 6），里面是 1-2 个字符的线路简称（如"DS""K""智"），在工具栏、线路列表、用量图的图例、会话筛选里处处一致；切换时，新线路的徽标从列表移入"当前"槽位（150-200ms，ease-out），旧徽标淡出，同时给出"已换乘到 DeepSeek（原 OpenAI 官方）"。减弱动效时直接替换并保留文字差值。
- 两个硬问题：切换类工具只有一个"当前"槽位、槽里只有一个徽标；累加类工具**没有"当前"槽位**，而是一排小徽标表示已启用的条目（如"已启用 3 / 5"）。Codex 作为"干线"排在工具栏首位并有完整的标签页，其他工具是"支线"，只出现它们真有的标签页（不出现空页）。
- 三个旋钮：`DESIGN_VARIANCE` 5、`MOTION_INTENSITY` 3、`VISUAL_DENSITY` 6。
- 主要风险：8 个线路色同时出现时容易变花，需要规定"一屏最多同时出现 N 个彩色徽标"；色觉障碍用户靠徽标里的字符而不是颜色识别，所以简称必须唯一；线路超过 8 条时颜色会重复，身份以字符为准；地铁隐喻一旦画成线路图就会滑向"装饰性地图"（第 3 部分 C12），**只用徽标，不画图**。

### 方向 B「座舱」：值的来源看得见

- 情绪词：沉着、精确、夜间友好、专业。
- 世界来源：航空玻璃座舱的显示惯例。二手资料显示，空客座舱里"托管（managed）目标"用品红、"选定（selected）目标"用青 / 蓝，绿、琥珀、红分别表示正常、注意、警告（来源：https://flyawaysimulation.com/ask/answers/airbus-a320-pfd-how-to-read/ 、https://en.wikipedia.org/wiki/Electronic_centralised_aircraft_monitor ；设计阶段若要引用，应以空客原始手册为准 [待核实]）。Chimera++ 里恰好也有三类值：**你设置的**（地址、密钥、手选模型）、**软件推导或托管的**（协议"自动"、默认模型映射、受管提示词区块）、**实测的**（延迟、可用性、额度）。
- 配色倾向（深色优先，另配浅色）：
  - 深色画布 `oklch(0.235 0.006 230)`、表面 `oklch(0.265 0.006 230)`、抬升 `oklch(0.295 0.007 230)`（每级差 0.03，符合 `register-product.md` §2；明度不低于 0.22，色度压到 0.006，避开近黑与"深蓝灰科技风"）
  - 实测值与正文：`oklch(0.94 0.005 230)`；次级：`oklch(0.74 0.008 230)`
  - "你设置的"：青 `oklch(0.80 0.11 215)`；"软件托管的"：品红 `oklch(0.72 0.17 345)`
  - 状态：正常 `oklch(0.78 0.15 150)`、注意 `oklch(0.80 0.14 80)`、警告 `oklch(0.66 0.20 28)`
  - 浅色模式：画布 `oklch(0.975 0.003 230)`、主墨 `oklch(0.20 0.01 230)`，青、品红分别压暗到约 L 0.50 以满足 AA
- 字体搭配：拉丁与数字用 **B612**（官方简介："designed and tested to be used on aircraft cockpit screens"，源自空客与 ENAC、图卢兹第三大学的研究，OFL），数值与路径用 **B612 Mono**；中文走系统栈。B612 在 Google Fonts 上只有常规与粗体两档，正好与 4.2 建议的"中文只用 400 / 700"对齐。
- 候选签名元素：**值来源着色 + "拉出 / 按下"两态**。线路编辑器与当前线路面板里，每个值都按来源着色（青 = 你设置的，品红 = 自动或托管，白 = 实测），并始终配"自动""实测"等文字标签；每个可推导字段旁有一个两态控件：切到"手动"时值由品红变青，切回"自动"时变回品红（借座舱"拉出旋钮 = 选定、按下旋钮 = 托管"的操作语义）。这让"哪些是我改的、哪些是软件替我决定的"一眼可见，也直接服务于 R4、G7 的"来源可视化"。
- 两个硬问题：切换类工具的面板顶部只有一个"当前线路"（青色，表示你选定的）；累加类工具的面板是一张条目清单，每条带启停开关与实测状态，标题写"已启用条目 3 / 5"，两种面板的主控件形状不同（单选 vs 开关）。Codex 面板仪表更多（运行时、用量、会话），其他工具只出现它有的仪表。
- 三个旋钮：`DESIGN_VARIANCE` 4、`MOTION_INTENSITY` 2、`VISUAL_DENSITY` 7。
- 主要风险：深色底 + 青色最容易滑进 `tokens.md` §4.5 的"通用深青科技风"和第 3 部分 C2、C11，必须守住三条线：底色色度 ≤0.008、青与品红只用于文字与细小标记（不做底色、不发光）、浅色模式同等完整；来源着色需要一次学习（在编辑器顶部放常驻图例）；颜色不能是唯一载体，每个品红值都要带"自动"标签。

### 方向 C「回执」：每一次改动都有凭据

- 情绪词：诚实、可追溯、安静、克制。
- 世界来源：银行回单与修改凭证。Chimera++ 的每次写操作（切换、导入、修复、恢复、删除）都会改动用户的本地配置文件；这个方向把"改了什么、改在哪、备份在哪、怎么撤销"做成一张张回执，并沿用 Chimera++ 现有品牌的信号红作为"盖章"色，保留老用户的识别延续性。
- 配色倾向（浅色优先，另配深色）：
  - 画布 `oklch(0.982 0.002 240)`、表面 `oklch(0.998 0 0)`（冷白，色度 ≤0.004，**明确避开奶油色域**）
  - 蓝黑主墨 `oklch(0.19 0.012 255)`、次墨 `oklch(0.45 0.01 255)`
  - 主操作：主墨实底 + 白字
  - 印章朱 `oklch(0.60 0.19 32)`（与现有 `DESIGN.md` 的 accent `oklch(0.61 0.205 32)` 同族），**只用于"已写入 / 已备份"的印记**，不用于按钮与大面积
  - 危险：`oklch(0.50 0.19 25)` 只出现在破坏性操作的确认区，并且必须配图标、描边分区与明确文字
  - 深色模式：画布 L 约 0.24 的石墨色（不做近黑），主操作改为浅墨实底
- 字体搭配：拉丁与数字用 **Atkinson Hyperlegible Next**（盲文研究所等设计，2025-01-07 上架 Google Fonts，可变字重 200-800，OFL；只取 400 / 700 两档），路径、密钥遮蔽串、模型 ID 用 **Atkinson Hyperlegible Mono**；中文走系统栈。这款字族以字符辨识为设计目标 [待核实原文]，对 `gpt-5.5` / `gpt-5.6`、`I` / `l` / `1`、`O` / `0` 这类最容易看错的技术字符有直接好处。
- 候选签名元素：**变更回执**。任何写操作完成后，在触发位置旁出现一张回执：动作、"新值（原值）"、目标文件绝对路径、备份编号、`撤销`；随后回执收进窗口边缘的"回执栏"，成为可搜索的操作记录，点开即看差异。回执上的朱色小印记（"已备份 09:41"）落下一次（约 100ms 的轻微缩放，无弹跳）；回执上缘的一道细小撕口是整个界面唯一的材质细节。深链导入确认框就是一张"待签的回执"：完整内容、目标文件绝对路径、差异、`允许 / 拒绝`。
- 两个硬问题：切换类工具的回执写"切换：DeepSeek（原 OpenAI 官方）"，界面主控件是单选列表；累加类工具的回执写"启用 / 停用：某条目"，主控件是开关清单。Codex 的回执类型更多（运行时更新、皮肤应用、体检修复），其他工具只有配置类回执，回执栏的筛选项随工具变化。
- 三个旋钮：`DESIGN_VARIANCE` 4、`MOTION_INTENSITY` 3、`VISUAL_DENSITY` 5。
- 主要风险：画布一旦偏暖或引入衬线字体，就会滑进 A2 簇 1（第 3 部分 C1）；回执栏如果用很多分隔线，会滑进簇 3 报纸风（C3），分组应靠间距而不是线；"印章"做重了会变成新中式的装饰；连续操作会刷出一串回执，必须合并（如"3 项变更"折叠）并自动收起；印章朱与危险红同属红色系，必须靠"印记形状 vs 确认区结构"而不是只靠色相区分。

### 三个方向的差异一览

| | A「换乘」 | B「座舱」 | C「回执」 |
|---|---|---|---|
| 颜色承担什么 | 线路身份 | 值的来源 | 几乎不承担（单色墨），只有"已写入"印记 |
| 默认主题 | 浅色优先 | 深色优先 | 浅色优先 |
| 签名元素 | 线路徽标 + 换乘动效 | 来源着色 + 拉出 / 按下两态 | 变更回执 + 印记 |
| 拉丁字体 | Overpass / Overpass Mono | B612 / B612 Mono | Atkinson Hyperlegible Next / Mono |
| 旋钮 V / M / D | 5 / 3 / 6 | 4 / 2 / 7 | 4 / 3 / 5 |
| 最容易滑进的俗套 | 装饰性地图（C12）、色彩过花 | 深青科技风、霓虹（C2、C11） | 奶油衬线、报纸风（C1、C3） |

---

## 6. 事实 / 推断分开

正文里已逐条标注；这里把设计阶段最可能引用的判断集中列一次，方便评审代理复核。

### 6.1 已核实的事实（附证据）

| 判断 | 证据 |
|---|---|
| Tide Guide 获 ADA 2026 视觉与图形类应用奖，同年入围交互类 | Apple Newsroom 2026 公告；MacStories 入围名单（R1） |
| Tide Guide 官网标题轮换词是 `background-clip: text` 渐变字，字体 system-ui | 2026-09-27 浏览器计算样式（R1） |
| Flighty 获 ADA 2023 交互类 | Apple Newsroom 2023 公告（R2） |
| Flighty 通知采用"状态作标题、差值作副行、新值旁列旧值" | 官网首屏截图 `award-flighty-status-first.png`（R2） |
| Play 获 ADA 2025 创新类；iA Writer 为 ADA 2025 交互类入围 | Apple Newsroom 2025 公告（R3、R4） |
| iA Writer 7 的 Authorship 以黑 / 灰区分自写与 AI 文字；iA 字体是 IBM Plex 的改版 | ia.net 官方页面；github.com/iaolo/iA-Fonts（R4） |
| Vercel Ship 2025 获 Awwwards Honorable Mention（2025-05-22） | Awwwards 条目页（R5） |
| Geist：10 条色阶、100-1000 步号对应角色；材质把圆角与阴影打包命名（6 / 12 / 16px） | vercel.com/geist/colors、/materials（R5） |
| Linear 2024-03-28 重设计：LCH 取代 HSL，98 个主题变量改为 3 个输入；标题用 Inter Display | linear.app/now 原文（R6） |
| Linear 官网字体栈以 Inter Variable 开头、标题字重 510、字距约 -0.022em、底色 rgb(8,9,10) | 2026-09-27 浏览器计算样式（R6） |
| Claude Code 获 2026 Webby（AI 类最佳产品或服务）与人民之声奖 | Webby 官方新闻稿（R7） |
| Frame.io V4 获 2025 Webby（Apps & Software 创意制作类）；V4 以元数据、Collections、可展开 / 收起的面板系统为核心 | Webby 官方新闻稿；Frame.io 官方博客（R8） |
| HarmonyOS 2 Design System 获红点 2021 界面与用户体验类；HarmonyOS Sans 获红点 2022 字体类 | 红点官网条目页（R9） |
| 飞书官网：拉丁字体在前的字体栈、字距 0、字重 400 / 500 / 600、主墨 #1F2329、次墨 #646A73、中英之间手工空格 | 2026-09-27 浏览器计算样式与截图（R10） |
| Raycast Windows 版 2025-11-20 公测，官方目标是"像属于这里，而不是移植过来的"；API 有 `ActionPanel` | raycast.com 博客与开发者文档（R11） |
| Warp 2025 年 2 月推出 Windows 版；Block 定义为"命令与输出组成的原子单元" | warp.dev 博客；docs.warp.dev（R12） |
| (Not Boring) Camera 为 ADA 2026 视觉与图形类入围 | MacStories 入围名单（R13） |
| Things 3 获 ADA 2017（第二个 ADA）；Mac 版 Type Travel "直接打字即跳转" | Cultured Code 官方博客与功能页（R14） |
| Opera GX 获 2026 iF 用户界面类；Opera Neon、Air 获的是品牌与传达类 | Opera 官方博客（1.x 表） |
| 微软雅黑只有 Light / Regular / Bold 三档（含 UI 变体） | Microsoft Learn 字体页（4.1） |
| Overpass、B612、Atkinson Hyperlegible Next / Mono 均为 Google Fonts 上的 OFL 字体；B612 为座舱屏设计且只有 400 / 700；Overpass 源自 Highway Gothic；Atkinson Hyperlegible Next 可变字重 200-800 | google/fonts 仓库的 OFL.txt、METADATA.pb 与官方简介（第 5 部分） |

### 6.2 推断（未取得实现或原始证据）

- 各参考"高级感来自哪些杠杆"的归因，除上表列出的可见事实外，均为基于截图与使用经验的判断。
- Play 的界面形态描述（R3）：官网在本机不可达，全部为推断。
- Flighty 的"时间感知渐进披露"、Things 的"安静密度"、Frame.io 的"暗房式工作面"、Raycast 的"动效极短"、Claude Code 权限提示的具体文案形态：推断。
- 第 2 部分的 8 条横向规律是归纳，属推断。
- 第 3 部分 C15"闪光图标 + 紫蓝渐变 = AI 功能"是行业观察，未做量化统计。
- "网页类奖项几乎只奖励营销站"（1.x 结论）：基于本次有限检索的推断。

### 6.3 待核实（设计阶段引用前需补证）

- HarmonyOS Design 获 2026 红点"Best of the Best"：只有媒体报道（CNMO），红点官网未检出。
- HarmonyOS Sans 的许可是否允许随软件再分发；Overpass 是否支持 `tnum`；Atkinson Hyperlegible 系列"以字符辨识为设计目标"的官方原文。
- 航空座舱"托管 = 品红、选定 = 青"的惯例：目前只有二手资料，需以空客原始手册为准。
- `text-autospace` 在项目最低支持的 WebView2 版本上的实际表现。
- 第 5 部分全部 OKLCH 取值的对比度：本文未计算，必须用工具逐对实测到 WCAG 2.2 AA（文本 4.5:1、非文本 3:1）。

### 6.4 截图清单（`D:\Desktop\_upstream_audit\v2.8.0\design\refs\`）

| 文件 | 内容 | 对应条目 |
|---|---|---|
| `award-tideguide-fullscreen-chart.png` | Tide Guide 官网首屏的 iPad / iPhone / Watch 产品图（指标条 + 主曲线 + 概览条） | R1 |
| `award-flighty-status-first.png` | Flighty 官网首屏的通知文案与航班列表行 | R2 |
| `award-vercel-geist-color-steps.png` | Geist 颜色页：10 条色阶 × 10 步 | R5 |
| `award-linear-dense-app-ui.png` | Linear 官网用 HTML 搭的产品界面：侧栏、活动流、代理面板 | R6 |
| `award-feishu-cjk-typography.png` | 飞书官网首页：中文标题、中英混排、1px 分隔的产品入口格 | R10 |
| `award-raycast-windows-command-palette.png` | Raycast Windows 版落地页：命令窗口的行结构与键位提示 | R11 |

说明：截图均为 2026-09-27 的线上版本，且多数是官网营销页里的产品图，不等于真实登录后的使用态。

