# AIProxy UI Guidelines

## 1. 文档信息

- 产品代号：`AIProxy`
- 文档类型：UI / UX 设计规范
- 当前阶段：`Phase 1 / 初始化设计`
- 文档状态：`Draft v1.0`
- 关联文档：
  - `docs/PRD.md`
  - `docs/ARCHITECTURE.md`
  - `docs/PAGE_BLUEPRINTS.md`

## 2. 设计目标

AIProxy 的界面目标不是“炫”，而是“高效、稳定、可读、专业”。作为开发者工具，其设计优先级如下：

1. 信息密度足够高
2. 高频操作路径足够短
3. 状态反馈足够明确
4. 长时间使用不疲劳
5. 跨平台视觉一致

## 3. 设计原则

- **Material Design 3**：采用现代 Material 体系，但避免移动端化过强
- **桌面优先**：交互以鼠标、键盘、分栏布局和右键菜单为中心
- **效率优先**：保证抓包主流程尽量不跳页
- **一致性优先**：同类对象使用同一种视觉与交互模型
- **渐进暴露**：高级功能不干扰基础功能
- **可预测性**：所有状态变化都应被用户感知
- **多语言一致性**：中英文切换后布局、信息层级与操作路径保持一致

## 3.1 多语言设计约束

- 首批支持 `简体中文` 与 `English`
- 默认跟随系统语言，允许用户在设置页显式覆盖
- 中英文文案长度差异较大时，按钮、标签页、状态栏和对话框需保证不截断关键含义
- 标题、按钮、说明文案和空状态必须成组翻译，避免页面出现混合语言
- 术语保持稳定：
  - `Sessions` / `会话`
  - `Compose` / `构造请求`
  - `Collections` / `集合`
  - `Compare` / `对比`
  - `Environment` / `环境`
  - `Global Variables` / `全局变量`
  - `Certificates` / `证书`
  - `Rules` / `规则`
  - `Settings` / `设置`
- 代码、协议名、HTTP 方法、域名、端口、URL、Header 名称等技术标识保持原样，不做翻译

## 3.2 外观主题约束

- 首批支持 `Light`、`Dark` 与 `Follow System`
- 默认跟随系统外观，允许用户在设置页显式覆盖
- 主题切换必须作用于应用壳层、导航、卡片、表格、代码区与状态栏，不允许只切页面背景
- 跟随系统时，应响应桌面外观变化并自动切换，不要求用户重启应用
- 首屏加载应尽量避免亮色/暗色闪烁

## 3.3 原生菜单本地化

macOS 原生菜单（File/Edit/View/Proxy/Tools/Window/Help）已本地化，随界面显示语言切换：

- 字符串来源：Rust 侧 `rust-i18n`（`src-tauri/locales/{en,zh-CN}.yml`），独立于前端 webview 目录。
- 切换流程：Settings 改显示语言 → `AppProviders` effect → `setMenuLocale(preference)` → Rust `apply_locale`（持久化 + `set_locale` + 重建）。
- 术语约束：菜单导航/主题项译法必须与前端一致（Compose=构造请求、Throttling=弱网、主题=暗黑/浅色/跟随系统）。
- `PredefinedMenuItem`（剪切/复制/最小化/退出等）由 macOS 系统本地化，不在本项目翻译范围。
- Windows/Linux 暂无原生菜单；命令前向兼容。

## 4. 品牌与视觉基调

## 4.1 品牌关键词

- Precision
- Observability
- Professional
- Efficient

## 4.2 UI 风格

- 基于 Material Design 3 的专业桌面风格
- 扁平化为主，轻量层级阴影
- 避免拟物和过度玻璃态效果
- 保持代码工具类产品的“克制感”

## 5. 主题系统

## 5.1 主色板

- `Primary`: `#2962FF`
- `Primary Container`: `#D6E4FF`
- `Secondary`: `#00BFA5`
- `Secondary Container`: `#B9F5EE`
- `Error`: `#D32F2F`
- `Warning`: `#ED6C02`
- `Info`: `#0288D1`
- `Success`: `#2E7D32`

## 5.2 中性色

### Light

- `Background`: `#F7F9FC`
- `Surface`: `#FFFFFF`
- `Surface Variant`: `#EEF2F7`
- `Outline`: `#C4CAD4`
- `Text Primary`: `#17202A`
- `Text Secondary`: `#556070`

建议语义分工：

- `Background`：应用壳层与页面大底
- `Surface`：主要工作面板与卡片容器
- `Surface Variant`：次级工具条、代码区、hover 背景
- `Outline`：分隔线、面板边框、拖拽分栏线

### Dark

- `Background`: `#121212`
- `Surface`: `#1B1F24`
- `Surface Variant`: `#232A33`
- `Outline`: `#4A5563`
- `Text Primary`: `#F5F7FA`
- `Text Secondary`: `#AAB4C0`

当前实现约束：

- 亮色与暗黑主题共享同一套 spacing、radius 与组件结构
- 主题选择入口位于 `Settings Page > Appearance`
- `system` 模式下使用系统外观解析结果作为最终主题
- JSON / 代码类视图在亮暗主题下分别使用独立语法高亮配色，保证可读性

## 5.3 状态色映射

- `2xx`: 绿色
- `3xx`: 蓝色
- `4xx`: 橙色
- `5xx`: 红色
- `Pending`: 紫色
- `WebSocket`: 青色

## 6. 字体与排版

## 6.1 字体体系

- 正文字体：`Inter`, `Segoe UI`, `SF Pro`, 系统无衬线回退
- 等宽字体：`JetBrains Mono`, `Consolas`, `Menlo`

## 6.2 字号规范

- 页面主标题：`24 / 32`
- 区块标题：`18 / 26`
- 卡片标题：`16 / 24`
- 正文：`14 / 22`
- 表格内容：`13 / 20`
- 辅助信息：`12 / 18`
- 代码区：`12` 或 `13`
- Markdown 阅读区（`MarkdownRenderer` comfortable density）：H1 `26`、H2 `22`、H3 `18`、正文 `15`、代码 `13`；`compact` density 用于 AI 总结面板（正文 `13`、代码 `12`）

## 6.3 字重规范

- 页面标题：`600`
- 区块标题：`600`
- 常规正文：`400`
- 数据强调：`500`
- 表头：`600`

## 7. 栅格与间距

## 7.1 间距体系

采用 4pt 基线：

- `4`：极小间距
- `8`：紧凑间距
- `12`：组件内常规间距
- `16`：区块内间距
- `24`：模块间距
- `32`：页面级间距

## 7.2 圆角规范

- 输入框、按钮、Chip：`8`
- 卡片：`12`
- 对话框：`16`
- 顶层大型容器：`16`

## 7.3 阴影规范

- 默认卡片：低层级阴影
- 弹出层：中层级阴影
- 禁止大面积重阴影

## 8. 布局规范

## 8.1 应用主框架

```text
App Shell
├─ Top App Bar
├─ Left Navigation Rail
├─ Main Workspace
│  ├─ Toolbar
│  ├─ Primary Pane
│  └─ Secondary Pane
└─ Bottom Status Bar
```

## 8.2 顶部栏规范

顶部栏承载全局状态与高频操作入口：

- 应用标识
- 当前页面上下文
- Start / Stop Proxy
- Enable / Disable System Proxy
- Clear Sessions
- 代理运行状态摘要
- 设置入口

设计要求：

- 高度建议 `56`
- 保持轻量，不承载会话级筛选输入
- 左侧展示上下文，右侧展示全局入口
- 代理运行状态必须持续可见

## 8.3 左侧导航规范

- 使用 `Navigation Rail` 或桌面增强版侧边栏
- 一级导航保持 8~10 个以内
- 当前激活项突出显示
- 支持图标 + 文本组合

导航项建议：

- Sessions
- Compose
- Insights
- Breakpoints
- Rewrite Rules
- Map Local
- Map Remote
- DNS
- Throttling
- Certificates
- Settings

## 8.4 主工作台规范

抓包中心采用桌面优先的“页面轻量工具栏 + 左侧树形会话浏览区 + 中间可拖拽分隔条 + 右侧详情工作区”结构。

### 推荐布局比例

- 页面过滤栏高度：`40 - 48`
- 左侧会话浏览区宽度：`28% - 36%`
- 右侧详情工作区宽度：`64% - 72%`
- 底部固定控制栏高度：`44 - 56`

### 主工作台结构树

```text
Capture Workspace
├─ Sessions Header Toolbar
│  ├─ Quick Search
│  ├─ Clear Sessions
│  └─ Export
├─ Content Split Pane
│  ├─ Session Explorer Pane
│  │  ├─ Domain / Host Tree
│  │  ├─ Path Branch Nodes
│  │  ├─ Request Nodes
│  │  └─ Empty / Loading / Error State
│  ├─ Split Resize Handle
│  └─ Session Inspector Workspace
│     ├─ Inspector Summary Bar
│     ├─ Request Pane
│     └─ Response Pane
├─ Session Context Menu
└─ Session Export Dialog / Snackbar Feedback
   ├─ Active Proxy Preset
   └─ Port / SSL Summary
```

### 布局目标

- 用户选中一条请求后无需跳页即可查看详情
- 左侧树必须支持快速定位 `host -> request`
- 搜索和过滤必须贴近会话列表，而不是放到全局壳层中
- 会话浏览区支持高密度树形浏览，详情区支持深入分析
- 详情区宽度不能小到影响 Header / Raw / JSON 阅读
- 全局抓包控制必须固定可见，不随页面内容滚动

### 行为约束

- 分栏拖拽宽度必须可记忆
- 左侧树滚动与详情区滚动互不影响
- 左右分栏支持拖拽调整宽度，并记忆用户上次设置
- 切换选中会话时，详情区只更新内容，不整体闪烁重绘
- 过滤栏必须保持轻量，不能重新膨胀为大卡片工具区
- 分组节点展开 / 收起不应打断当前选中请求

## 8.5 底部状态栏规范

展示：

- 代理状态
- 当前代理预设
- 代理端口
- SSL 状态
- 系统代理状态
- 错误提示或后台任务提示

## 9. 页面规范

页面规范分两层维护：

- `docs/UI_GUIDELINES.md`：定义视觉、布局、组件和交互规范
- `docs/PAGE_BLUEPRINTS.md`：定义页面级低保真线框、组件树、状态模型与事件流

当核心页面结构发生变化时，必须同步更新这两个文档，避免“视觉规范”和“实现蓝图”脱节。

### 页面蓝图索引

- `Sessions Page`：抓包主工作台、会话列表、详情检查器
- `Compose Page`：请求构造、响应预览（已实现），模板面板（待实现）
- `Insights Page`：流量统计分析面板（已实现首版）
- `Compare Page`：请求 / 响应 Diff 与 AI 总结（已实现发布硬化版）
- `Rules Page`：规则类型切换、规则列表、规则编辑器
- `Certificates Page`：证书状态、安装引导、风险说明
- `Settings Page`：代理预设、设置导航与设置内容区
- `Docs Page`：应用内文档查看器，离线浏览 `apps/desktop/user-guides` 用户指南（Help 菜单入口，不进入主导航）

## 9.1 Sessions Page

### 页面定位

Sessions Page 是产品的主工作台，承担“抓包、筛选、定位、查看、重放”的主路径。

### 页面结构树

```text
Sessions Page
├─ Sessions Header Toolbar
│  ├─ Session Search
│  ├─ Clear Sessions Button
│  └─ Export Button
├─ Capture Workspace
│  ├─ Session Explorer Pane
│  │  ├─ Host Group Tree
│  │  ├─ Path Branch Nodes
│  │  ├─ Request Rows
│  │  └─ Empty / Loading / Error State
│  ├─ Split Resize Handle
│  └─ Session Inspector Workspace
│     ├─ Inspector Summary Bar
│     ├─ Request Pane
│     └─ Response Pane
├─ Session Context Menu
├─ Session Export Dialog
└─ Snackbar Feedback
```

### 页面区域定义

#### `Sessions Header Toolbar`

- 位于主内容区最上方
- 只保留会话搜索与页面级辅助动作
- 必须是高密度、低视觉噪音的桌面工具条
- 不承载 Start / Stop Proxy 等全局操作
- 当前实现包含：`Search`、`Clear Sessions`、`Export`

#### `Session Explorer Pane`

- 左主栏
- 默认按 `domain / host` 分组
- 组节点展开后展示请求项
- 每条请求项需能直接看到 `method / path / status / duration`
- 支持键盘上下切换选中项
- 会话叶子节点支持右键打开 `SessionContextMenu`
- Host 被聚焦时，其他 Host 以降透明度形式退场，而不是完全隐藏

#### `Split Resize Handle`

- 位于会话树与详情区之间 / Inspector 上下分栏之间
- 使用 1px 细线渲染，通过 `::after` 伪元素（`inset: -3px 0` 或 `inset: 0 -3px`）提供不可见但易于抓取的拖拽热区
- 拖拽热区宽度约 9px（水平）或高度约 7px（垂直），保证精确操作
- 悬停时分割线颜色变为 `primary.main`，提供即时视觉反馈
- 仅在桌面宽度下展示
- 支持拖拽调整 Explorer 宽度 / Inspector 分栏比例
- 宽度 / 比例变更应被记忆（`localStorage`），避免用户每次打开都重新布局

#### `Session Inspector Workspace`

- 右详情栏
- 与树形浏览区选中项强绑定
- 顶部显示 `Inspector Summary Bar`，承载 Method / URL / Status / Duration / Repeat
- 中部拆成上下两个面板：`Request Pane` 与 `Response Pane`
- `Request Pane` 支持收起，并单独维护 tabs 与搜索
- `Response Pane` 独立维护 tabs 与搜索
- JSON 树视图（JSON Tab）支持通过拖拽列分隔线调整 Name / Type / Value 三列宽度，列宽在当前会话内维持，切换 tab 或选中项时重置为默认 1/3 均分

#### `Session Context Menu`

- 触发方式：右键会话叶子节点
- 定位方式：以鼠标指针位置为锚点弹出
- 菜单项应按动作组分块，并使用 `Divider` 分隔
- JSON 树视图中右键节点提供 `Copy Key`（复制字段名）和 `Copy Value`（复制字段值，对象/数组以格式化 JSON 输出，字符串不带引号）
- 代码块视图（JSON Text、Raw、Text Body）中选中文字后右键提供 `Copy`（复制选中文字）和 `Search`（用选中文字激活搜索栏）
- 媒体预览区（图片）右键提供 `Copy Image`（复制图片到剪贴板）、`Save Image As...`（图片另存为）、`Copy Image URL`（复制图片地址）、`Open in Browser`（在浏览器中打开）
- 媒体预览区（音频/视频）右键提供 `Save As...`（另存为）、`Copy URL`（复制地址）、`Open in Browser`（在浏览器中打开）

- 当前动作组：
  - 复制：`Copy URL`、`Copy Request`、`Copy Response`
  - JSON 树：`Copy Key`、`Copy Value`
  - 代码块：`Copy`、`Search`
  - 媒体预览（图片）：`Copy Image`、`Save Image As...`、`Copy Image URL`、`Open in Browser`
  - 媒体预览（音频/视频）：`Save As...`、`Copy URL`、`Open in Browser`
  - 处理：`Save Response...`、`Compose`、`Repeat`
  - 会话范围：`Export Session...`、`Clear Others`
  - Host 范围：`Focus / Unfocus Host`、`Ignore / Stop Ignoring Host`
  - 跳转：`Breakpoints...`、`Map Rules...`
- 菜单动作完成后应自动关闭
- 复制类动作必须给出 `Snackbar` 成功反馈
- `Focus` 与 `Ignore` 属于当前页面的临时视图状态，不应默认持久化
- `Breakpoints...` 与 `Map Rules...` 当前都跳转到 `Rules Page`，后续可升级为深链到具体 tab

### 会话树节点建议

- 分组节点：Host、请求数量、展开状态
- 请求节点：Method、Path、Status、Duration
- 失败或异常请求：高优先级状态色提示
- 当前选中节点：明显高亮，但不应破坏整行可读性

### 详情面板标签

- Request：`Overview / Query / Headers / Body / Form / Raw`
- Response：`Overview / Preview / Headers / Text / JSON / JSON Text / Raw`
- `Preview` Tab 仅在响应 MIME 类型为图片（`image/*`）、音频（`audio/*`）或视频（`video/*`）时显示
- 图片预览使用 `<img>` 渲染 data URI，支持 `object-fit: contain` 自适应容器，底部展示尺寸、MIME 类型、文件大小
- 音频 / 视频预览使用原生 HTML5 `<audio>` / `<video>` 控件
- SVG 同时拥有 Text Tab（原始 XML）和 Preview Tab（渲染后图形）
- Preview Tab 的 base64 数据通过 `get_session_detail_content` 按需懒加载

### 详情面板内容层级

```text
Inspector Pane
├─ Inspector Summary Bar
│  ├─ Method / URL
│  ├─ Status / Duration / Size
│  └─ Repeat Action
├─ Request Pane
│  ├─ Collapse Toggle
│  ├─ Tabs: Overview / Query / Headers / Body / Form / Raw
│  └─ Optional Search Field
└─ Response Pane
   ├─ Tabs: Overview / Headers / Text / JSON / JSON Text / Raw
   └─ Optional Search Field
```

## 9.2 Compose Page — `已实现`

### 页面定位

Compose Page 用于手工构造请求、快速重放请求与查看结果，是”主动发请求”的工作台。

### 实际页面结构

```text
Compose Page
├─ Page Header (标题 + 描述)
├─ Toolbar
│  ├─ Send Button (variant=”contained”, 含 loading spinner)
│  └─ Export cURL Button (variant=”outlined”, 复制到剪贴板 + Snackbar 确认)
├─ Two-Column Grid (8fr | 4fr)
│  ├─ SectionCard “Request Builder”
│  │  ├─ Method Selector (Select: GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS)
│  │  ├─ URL Input (OutlinedInput, Enter 键触发发送)
│  │  └─ Tabs: Headers | Body | Query
│  │     ├─ Headers: EditableKeyValueTable
│  │     ├─ Body: TextField multiline
│  │     └─ Query: EditableKeyValueTable (自动从 URL 解析 query params)
│  └─ SectionCard “Response Preview”
│     ├─ InspectorSummaryBar (复用 Sessions Inspector 组件)
│     └─ Tabs: Overview | Headers | Body | Timing
│        ├─ Overview: InspectorDefinitionList
│        ├─ Headers: InspectorKeyValueTable
│        ├─ Body: SearchableCodeBlock
│        └─ Timing: InspectorDefinitionList
└─ Snackbar (cURL 复制确认)
```

### 已实现元素

- Method Selector
- URL Input（支持 Enter 键发送）
- Headers Editor（EditableKeyValueTable）
- Body Editor（TextField multiline）
- Query Editor（自动解析 URL query params）
- Send Button（含 loading 状态）
- Export cURL（前端纯函数生成，复制到剪贴板）
- Response Preview（复用 Inspector 组件：Overview/Headers/Body/Timing）
- Repeat 按钮（Sessions Inspector 摘要栏，预填数据后导航至 Compose）

### 暂未实现

- Request Presets Pane（模板/历史）
- Save Template / Duplicate 按钮

## 9.3 Collections Page — `已实现`

### 页面定位

Collections Page 是 API 集合管理页面，支持保存、分组、编辑和发送 HTTP 请求。核心对标 Postman 的 Collection 功能，亮点是可从抓包流量直接保存到 Collection。

### 页面结构

三栏布局：

- **左栏**：Collection 树（集合/文件夹），支持展开/折叠、新建、删除
- **中栏**：请求列表，显示 Method Badge + 请求名称
- **右栏**：请求编辑器（复用 Compose 的 Request/Response Section）

### 环境选择器

位于左栏底部：

- 下拉选择当前环境（`No Environment` 为默认选项）
- 右侧齿轮按钮打开 `EnvironmentManagerDialog`
- 当前环境 ID 持久化到 `localStorage`

### 变量替换视觉提示

- URL、Headers、Body 中的 `{{variable}}` 保持原样显示
- 未匹配的变量不做高亮报错，保持静默（与 Postman 行为一致）

### Collection 树图标

树节点使用 `ArrowDropDownRoundedIcon`（展开态）/ `ArrowRightRoundedIcon`（折叠态）作为展开指示器，已移除独立的文件夹图标列，合并为单图标指示展开状态。

### Collection 树拖拽交互

支持鼠标拖拽重新组织树结构，文件夹和请求项都可以拖动。

- **触发**：鼠标按下后移动 ≥4 px 才进入拖拽（`PointerSensor.activationConstraint.distance = 4`）；点击 ≤4 px 仍然作为选择/展开使用。
- **拖拽指示**：
  - **Before / After**：在被悬停行的上/下边缘渲染 2 px primary.main 颜色的指示线，仅覆盖缩进区域（不延伸到左侧 gutter）
  - **Into**：被悬停文件夹整行高亮（primary 半透明背景）
  - 被拖拽行 opacity 降到 0.4，提示用户原位置正在被搬移
- **判定区域**（基于光标 Y 在被悬停行内的相对位置）：
  - 文件夹行：上 25% = before / 中 50% = into / 下 25% = after
  - 空且已展开的文件夹：整行 = into（避免用户找不到 into 区）
  - 请求项行：上 50% = before / 下 50% = after，没有 into
- **跨类型规则**：
  - 文件夹拖到请求项行 → 无指示线，禁止（请求项不能与文件夹同级）
  - 请求项拖到文件夹行 → 始终是 into
  - 文件夹拖到自己或其后代 → 无指示线，前后端双重 cycle check
- **Spring-load**：拖动悬停在折叠文件夹的中部 ≥500 ms 自动展开该文件夹；移开或释放则清掉计时器。
- **后端写入**：松开后调用 `move_api_collection` / `move_api_collection_item`，目标 `sortOrder` 触发 dense renumber；失败时通过底部 Snackbar 反馈。乐观更新先写入 React Query 缓存，失败回滚。

## 9.4 Rules Page

### 页面定位

Rules Page 是全产品的规则配置中心，统一管理 Breakpoint、Rewrite、Map Local、Map Remote、DNS。

当前实现补充：

- 顶部使用 `Tabs` 固定承载规则类型切换
- Breakpoint 使用”快捷断点 + 规则列表 + 新增对话框”的轻量流
- Rewrite 使用”左侧模板 + 规则列表，右侧 When / Then / Test”的桌面工作台流
- Map / DNS 使用”左侧列表 + 右侧编辑器 + 即时预览”的桌面工作台流
- 规则创建优先提供快捷模板，降低首次配置门槛

### 页面结构树

```text
Rules Page
├─ Page Header
├─ Rule Type Switcher
├─ Main Split Layout
│  ├─ Rule List Pane
│  │  ├─ Create Rule
│  │  ├─ Search Rule
│  │  ├─ Templates / Quick Actions
│  │  └─ Rule Cards
│  └─ Rule Editor Pane
│     ├─ Basic Information
│     ├─ When / Match Conditions
│     ├─ Then / Action Configuration
│     ├─ Priority Settings
│     ├─ Enable Toggle
│     └─ Test / Validation Result
└─ Bottom Status Strip
```

### 布局要求

- 左侧规则列表用于查找与切换
- 右侧编辑区必须能完整容纳复杂表单
- 顶部规则类型切换必须常驻可见
- Rewrite 的 Test 面板必须始终可见或易达，帮助用户保存前确认是否命中
- Rewrite 无效组合必须在编辑器内直接提示，并阻止保存明显不会生效的配置

### 编辑区结构

- 基本信息
- 匹配条件
- 动作配置
- 优先级
- 启用状态
- 命中预览

### 交互要点

- 切换规则类型时，列表与编辑器必须同步切换，不让用户在旧上下文里误编辑
- 左侧列表项必须始终暴露：名称、启停、优先级、核心作用摘要
- 右侧编辑器应把“规则会命中谁”和“命中后会做什么”明确拆开
- 预览卡应使用自然语言总结最终效果，避免用户只看表单字段猜结果

### 断点拦截面板

- 断点命中属于高压调试时刻，面板应优先保证方法、阶段、Host、Path、状态码和队列位置可一眼识别。
- Header 与 Body 应以工作台区块展示；Header 使用紧凑行编辑，Body 使用固定高度编辑器并在编辑器内部滚动。
- 底部决策按钮必须始终可见，且不得覆盖可编辑内容；Mock 模式控制与 Drop / Forward 等最终决策分区摆放。
- Mock Response 是请求阶段的临时模式，进入后应明确显示 Mock 状态，并复用 Response 区域编辑状态码、Header 和 Body。

## 9.4 Throttling Page

### 页面定位

Throttling Page 负责让用户在“快速套预设”“精确调参数”与“只影响目标接口”之间高效切换。这里的 Throttling 指弱网 / 链路模拟，不等同于 API QPS / Quota 限流。

### 页面结构树

```text
Throttling Page
├─ Runtime Status Bar
│  ├─ Active State
│  ├─ Hits / Drops / Delay Stats
│  ├─ Temporary Enable
│  └─ Disable
├─ Main Split Layout
│  ├─ Left Pane
│  │  ├─ Segmented Control: Profiles / Rules
│  │  ├─ Preset Profiles
│  │  ├─ Custom Profiles
│  │  └─ Targeted Rules
│  └─ Right Pane
│     ├─ Profile Editor
│     │  ├─ Basic Fields
│     │  ├─ Enable After Save
│     │  └─ Latency / Bandwidth / Packet Loss
│     └─ Rule Scope Editor
│        ├─ URL / Host Pattern
│        ├─ Methods / Stage / Priority
│        └─ Profile / Enabled
```

### 交互要点

- 预设配置必须支持一键启用
- 自定义配置必须支持“保存”和“保存并启用”两条路径
- 运行状态栏始终可见，避免用户误以为编辑即生效
- 全局启用必须提供一键关闭；临时启用需显示剩余时长
- Rules 模式必须清楚展示作用范围，避免误伤所有请求
- 从 Session 创建规则时，应自动带入 host / path / method，减少复制粘贴
- Session Automation tab 应展示 Throttling trace，让用户确认 profile / rule 是否命中

## 9.5 Sessions Export

### 页面定位

会话导出是 Sessions Page 的高频辅助动作，不应拆成独立页面。

### 结构建议

```text
Sessions Header
└─ Export Button

Export Dialog
├─ Scope Cards (Selected / Filtered / All)
├─ Format Cards (Snapshot / HAR / cURL)
├─ Summary Alert
└─ Feedback / Error
```

### 交互要点

- 范围选择优先使用卡片式单选，让用户一眼看到“导出多少条”
- `cURL` 属于复制动作，应在按钮文案上明确区别于文件导出
- 如果当前没有选中会话，应禁用“Selected Session”并说明原因
- 导出过程中只阻塞当前对话框，不阻塞 Sessions 主工作台

## 9.6 Certificates Page

### 页面定位

Certificates Page 是 HTTPS 解密前的准备中心，承担“状态确认 + 安装引导 + 风险告知”三项职责。

### 页面结构树

```text
Certificates Page
├─ Page Header
├─ Certificate Status Card
│  ├─ Root Certificate Presence
│  ├─ Trust Status
│  ├─ Fingerprint
│  └─ Generate / Install / Refresh Actions
├─ Installation Guide Section
│  ├─ Windows Steps
│  ├─ macOS Steps
│  └─ Linux Steps
├─ Mobile Setup Card
│  ├─ Network Information (Local IP / Proxy Port / Wi-Fi Proxy Address)
│  ├─ QR Code (编码证书下载 URL)
│  ├─ Certificate Download URL (可复制)
│  ├─ iOS Setup Guide
│  └─ Android Setup Guide
└─ Risk / FAQ Section
```

### 内容结构

- 当前证书状态
- 生成 / 安装 / 刷新操作
- 安装指引
- 平台差异说明
- 手机端抓包配置（网络信息、二维码、iOS/Android/HarmonyOS 指引）；其中设备/模拟器扫描（iOS Simulator / adb / hdc）为**静默自动探测**：进入面板即自动查询；若未安装对应工具链或当前无该平台抓包需求（如纯网页抓包），探测失败时**静默降级**（仅显示中性「点击刷新」提示，不弹红色错误）；只有用户主动点击「刷新」后仍失败，才在面板内显示错误
- 常见问题
- 风险提示

## 9.7 Settings Page

### 页面定位

Settings Page 负责应用级默认配置与代理预设管理，不再提供独立 Workspaces Page。

当前已实现范围：

- 语言偏好：`Follow System / 简体中文 / English`
- 外观偏好：`Follow System / Light / Dark`
- 代理预设：列表选择、创建、编辑、应用
- 语言与外观偏好均为应用级持久化设置

### 页面结构树

```text
Settings Page
├─ Page Header
├─ Settings Navigation
│  ├─ General
│  ├─ Proxy
│  ├─ Certificates
│  ├─ Session Storage
│  ├─ Appearance
│  ├─ Shortcuts
│  └─ Advanced
└─ Settings Content Pane
   ├─ Section Header
   ├─ Setting Rows
   ├─ Inline Validation
   └─ Save / Reset Actions
```

### 分组建议

- General
- Proxy
- Certificates
- Session Storage
- Appearance
- Shortcuts
- Advanced

当前实现说明：

- 当前桌面端先落地 `Proxy Presets`、`Language & Region` 与 `Appearance` 三个设置区块
- 后续如扩展左侧设置导航，需保持当前字段归属不变

- `ProxyPresetsSection`：代理预设管理，`SectionCard` 内含预设列表（`List` + `ListItemButton`，活跃预设有 `CheckCircleRoundedIcon` 标记，hover 阴影提升）、操作栏（New Preset / Apply / Save 按钮）、展开式编辑表单（name, port, SSL Switch）。数据由 `useWorkspaces` 等 hooks 驱动，底层继续复用 workspace 命名接口

## 10. 组件规范

## 10.1 原子组件

- `Button`
- `IconButton`
- `TextField`
- `SearchField`
- `Select`
- `Switch`
- `Checkbox`
- `Radio`
- `Tabs`
- `Chip`
- `Tooltip`
- `Badge`
- `Dialog`
- `Snackbar`
- `Menu`
- `Divider`
- `Progress`
- `StatusDot`

## 10.2 复合组件

- `ProxyStatusCard`
- `SessionFilterBar`
- `SessionTable`
- `SessionInspector`
- `SessionContextMenu`
- `SessionExportDialog`
- `HeaderEditor`
- `KeyValueEditor`
- `BodyEditor`
- `TimingPanel`
- `WaterfallChart` — 水平堆叠条形图，展示请求 timing 各阶段（dns / connect / tls / request_send / waiting / response_read / total）耗时；根据 `timingSource` 调整展示粒度，每个阶段使用不同颜色并支持 Tooltip
- `CookiePanel`
- `RawPanel`
- `RuleList`
- `RuleEditor`
- `CertificateWizard`
- `MobileSetupCard`
- `ThrottlePresetPanel`
- `ProxyPresetSwitcher` — 内嵌于 AppShell 状态栏，点击打开代理预设切换对话框（列表选择）
- `VariableEditorTable` — 环境变量编辑表格，4 列：启用开关（Switch）、Key（OutlinedInput）、Value（OutlinedInput）、删除（IconButton）。禁用行以 `opacity: 0.5` 降显。底部有"添加变量"按钮
- `EnvironmentManagerDialog` — 环境管理弹窗，Tabs 切换"环境变量"和"全局变量"。环境变量标签页左侧为环境列表（增删改），右侧为 VariableEditorTable。全局变量标签页直接使用 VariableEditorTable。变量修改后 debounced 自动保存（500ms）

## 10.3 业务组件

- `CaptureWorkbench`
- `ComposeWorkbench`
- `BreakpointWorkbench`
- `RewriteWorkbench`
- `MapWorkbench`
- `DnsMappingsPanel`
- `CertificateCenter`

## 11. 交互规范

## 11.1 按钮优先级

- 主按钮：单页唯一主任务
- 次按钮：辅助任务
- 文本按钮：低风险轻操作
- 危险按钮：删除、清空、覆盖

## 11.2 表格交互

- 单击：选中会话
- 双击：展开或进入专注视图
- 右键：上下文菜单，仅作用于会话叶子节点
- 支持列排序
- 支持键盘上下移动

## 11.3 编辑器交互

- Header / Query / Cookie 统一使用键值对编辑器
- Body 支持纯文本、JSON、美化视图切换
- 对 JSON 错误提供即时提示

## 11.4 反馈机制

- 成功：`Snackbar`
- 错误：`Snackbar + 详细错误入口`
- 长任务：状态栏 + 进度提示
- 危险操作：`Dialog Confirm`

## 12. 状态设计

## 12.1 空状态

适用场景：

- 尚未启动代理
- 暂无会话
- 当前筛选无结果
- 未创建规则

原则：

- 说明当前状态
- 提供下一步动作
- 避免仅展示空白

## 12.2 加载状态

- 表格区域使用 skeleton 或行级占位
- 详情区使用局部加载
- 禁止全屏阻塞式加载，除首次启动外

## 12.3 错误状态

- 明确说明错误原因
- 显示可执行操作：重试、查看帮助、打开证书页、修改端口

## 13. 快捷键建议

- `Ctrl/Cmd + K`：全局搜索
- `Ctrl/Cmd + R`：Repeat 当前请求
- `Ctrl/Cmd + Enter`：发送 Compose 请求
- `Ctrl/Cmd + E`：导出
- `Ctrl/Cmd + L`：清空会话列表
- `Ctrl/Cmd + ,`：打开设置
- `Space`：快速预览当前会话详情

## 13.5 Compare Page — `已实现发布硬化版`

Compare Page 是面向 AI 的高密度分析页面，不使用营销式介绍区。首屏直接展示两个 Session 选择器、Diff 工作台和 AI Summary 面板。

- 顶部操作只保留 `Preview AI Payload` 与 `Generate Summary`，AI 调用必须由用户手动触发。
- Diff Workbench 按 section 展示 added / removed / changed / unchanged 计数，并只展开有变化的条目。
- Body section 默认展示元数据摘要；使用 `Compute body diff` 按需计算详细 diff，避免页面初始渲染时解析大 body。
- 当 body diff 被 entry 上限或 size guard 截断 / 跳过时，必须显示 warning 和可读原因；当前已装载的变化可用 `Show all changes` 展开。
- 非文本 / binary body 必须明确显示不可文本 diff 状态，不显示成未捕获 body。
- AI Summary 面板在未配置模型时显示 `Configure AI Model` 入口，配置完成后显示模型名和生成结果。
- AI 返回的总结内容使用 Markdown 渲染（标题、粗体、表格、列表、代码块等），不再以纯文本预格式化形式展示。
- “包含 Body 上下文”使用 Switch；默认发送的是脱敏 payload，不提供默认完整原文发送入口。
- 窄屏下 AI Summary 移到 Diff 下方，避免右侧窄栏挤压代码文本。

## 13.6 Insights Page — `已实现首版`

Insights Page 是流量统计分析面板，基于已捕获会话的聚合数据提供概览指标、Host 维度分析、分布图和慢请求排名。

### 页面定位

- 面向开发者的流量概览页面，回答"整体流量健康吗？哪些 Host 最慢？有多少错误？"
- 数据完全来自本地 SQLite 聚合查询，不依赖外部服务

### 页面结构

```text
Insights Page
├─ Page Header (title)
├─ Overview Cards Row
│  ├─ Total Requests Card
│  ├─ Avg Duration Card
│  ├─ Error Rate Card
│  └─ Total Size Card
├─ Host Breakdown Table (sortable columns)
│  ├─ Host
│  ├─ Requests
│  ├─ Avg Duration / P95 Duration
│  ├─ Total Size
│  └─ Error Count
├─ Bottom Split
│  ├─ Distribution Section
│  │  ├─ Status Code Distribution (chips/bars)
│  │  └─ Method Distribution (chips/bars)
│  └─ Slow Requests List (ranked, clickable to navigate to session)
```

### 设计要求

- 概览卡片使用 MUI `Card`，数值使用 `Typography h4`，标签使用 `caption`
- Host 表格使用 MUI `Table`，支持点击表头排序；无过滤时 flex 撑满剩余空间并在表格内滚动（表头 sticky），有过滤时自然高度让位给慢请求列表
- 分布图使用 Chip 或小型水平条形展示，不引入重量级图表库
- 慢请求列表使用虚拟列表布局，显示方法徽章、URL 和耗时；仅在应用了过滤（关键词 / 聚焦 Host / 排除 Host）时渲染，全局视角下隐藏，避免单条偶发请求干扰概览
- 空状态：未捕获会话时显示提示引导用户返回 Sessions 开始抓包

## 14. 可访问性规范

- 文本对比度满足可读性要求
- 所有图标按钮必须提供 Tooltip 与可访问名称
- 焦点态必须明确可见
- 支持键盘完整操作主流程
- 状态颜色不能作为唯一信息表达方式

## 15. 响应式策略

虽然是桌面优先，但仍需支持窗口缩放：

- `>= 1440`：三栏最佳体验
- `1024 - 1439`：双栏布局
- `< 1024`：详情区切换为抽屉或标签式展示

## 16. 图标与插画规范

- 图标建议使用 Material Symbols 或一致风格线性图标
- 状态图标应语义明确
- 空状态插画轻量即可，不应喧宾夺主

## 17. 内容文案规范

- 优先使用工程语义明确的词汇
- 避免营销化语言
- 错误提示要求包含原因与建议动作
- 同一概念命名在全应用保持一致

示例：

- 用 `Start Proxy`，不要用 `Launch Magic`
- 用 `Certificate Not Trusted`，不要用 `Security Issue`

## 18. 暗色模式规范

- 默认跟随系统
- 深色模式下优先保证表格、代码区、状态色可读
- 亮色与暗色主题应共享同一套间距与组件结构
- 暗色主题下壳层、面板与浮层应去除不必要的亮色背景图和强反光效果
- 主题切换后状态色、语法高亮与 hover/selected 态仍应保持层级区分

## 19. 实现建议

- 在 `packages/ui-tokens/` 管理颜色、字号、圆角、阴影令牌
- 统一封装 `components/ui`，不要直接在业务层散用 MUI 原生样式
- 会话表格采用虚拟滚动，保证大数据量流畅性
- 详情区编辑器支持只读/可编辑两种模式复用

## 20. 验收标准

- 主工作台支持高密度会话浏览且不混乱
- 亮/暗色主题下状态色与文本均清晰可读
- 核心操作均能在 3 步内完成
- 页面之间的布局、间距、标题和按钮层级一致
- 基础组件可复用，不出现业务页面各自造样式的情况

## 21. 首启引导(Setup Wizard / Setup Checklist)

### 21.1 交互规则

- 首启向导为**模态 Dialog**,首次满足门控条件时自动弹出;`captureReady` 达成前保持可走通,用户可随时跳过。
- 向导永远**可跳过、可后补**;不阻断使用,跳过后由常驻清单承接未完成项。
- 常驻清单卡(`SetupChecklistCard`)挂在 Sessions 页顶部,`!captureReady` 时显示,`captureReady` 达成即消失;回退时自动重现,不重弹模态。
- 向导顶部用 `LinearProgress` + "Step N/8" 表达进度,避免 8 步全列 Stepper 造成拥挤。
- 常驻清单卡的主按钮随 `nextAction` 动态化:卡在"启动代理"步骤时为"启动代理"(而非固定"打开证书"),调用 `useStartProxy`;该步启动失败且为端口占用时,清单内 inline 显示端口占用 Alert 并提供"更改端口"(复用 AppShell 端口对话框,经 `proxy-start.store` 桥接)。其余步骤仍为"打开证书"。

### 21.2 跳过 / 完成 / 回退语义

- **跳过**:只写 `setupWizardDismissedAt`,不写 `completed`;模态不再自动弹出。
- **完成**:`captureReady` 为真时写 `setupWizardCompleted`。
- **回退**:`captureReady` 退回 false(证书被删/代理停)**不**重弹模态,仅常驻清单重现并指引补齐。
- **手动代理**:带 port+workspace 上下文持久化;端口或 workspace 变化即失效,清单提示重新确认。

### 21.3 错误闭环层级

- 引导链路内(向导 / 清单 / 证书页安装区)以**页面级 `CertificateErrorGuidance`** 为权威可操作 UI。
- 命令层 `reportCommandFailure` **仅记日志**,不承载用户提示。
- 全局 snackbar 仅用于引导链路之外的动作;同一动作不在两处重复表达。
- 应用启动自动拉起代理(auto-start)属引导链路之外:端口占用时直接弹端口修改对话框,其他启动错误走全局 snackbar;端口占用事实由 `useStartProxy` 统一写入 `proxy-start.store`,清单卡据此 inline 表达,二者不重复(模态对话框在前,关闭后清单卡承接持续提醒)。
- 端口占用对话框标题切为「解决端口冲突」,用 `Divider` 分两路径:① 结束占用进程(展示 `进程名 · PID` + 危险色「结束并重启」按钮,经 MUI 二次确认;后端 kill 前重新核对 PID 仍属该端口防 TOCTOU,不匹配返回 `PROCESS_CHANGED` 并重查);② 在其他端口启动(端口输入)。查不到占用者(Linux 缺 `lsof` 等)或非占用场景(主动改端口)时回到单一路径的端口输入。占用场景不再用红框/重复错误文案,`portDialogError` 仅用于换端口的校验失败。

### 21.4 状态栏证书 chip 语义

- chip 文案随 `nextAction` 表达 `captureReady` 进度:未安装 / 未信任 / 已信任·待启动代理 / 已信任·待开路由 / HTTPS 就绪。
- chip 始终可点跳转证书页;`!captureReady` 时作为主动提醒入口(隐蔽入口→主动提醒)。
