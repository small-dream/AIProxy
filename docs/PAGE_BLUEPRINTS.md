# AIProxy Page Blueprints

## 1. 文档信息

- 产品代号：`AIProxy`
- 文档类型：页面蓝图与实现映射
- 当前阶段：`Phase 1 / Page Blueprint`
- 文档状态：`Draft v1.0`
- 关联文档：
  - `docs/UI_GUIDELINES.md`
  - `docs/ARCHITECTURE.md`
  - `docs/API_SPEC.md`

## 2. 文档目的

本文件用于把“页面布局规范”进一步落成可执行蓝图，覆盖：

- 低保真线框结构
- React 组件树
- 页面状态模型
- 页面事件与数据流

目标是让产品、设计、前端、Rust/Tauri 接口层对同一页面结构有一致理解。

## 3. 全局约定

### 3.1 命名约定

- 页面容器：`*Page`
- 页面工作台：`*Workbench`
- 列表区：`*ListPane`
- 详情区：`*InspectorPane`
- 工具条：`*Toolbar`
- 状态卡：`*StatusCard`

### 3.2 页面状态类型

每个核心页面默认有以下状态分层：

- `bootstrap state`
- `query state`
- `selection state`
- `editor state`
- `mutation state`
- `ui state`

### 3.3 线框图说明

- `[]` 表示容器或区块
- `()` 表示动作按钮
- `<>` 表示切换器 / tabs / filters
- `...` 表示可滚动内容区域

## 4. Sessions Page

### 4.1 页面目标 — `已实现首版`

完成抓包主路径：

- 搜索与浏览会话树
- 查看请求 / 响应详情
- 从会话快速导出、复制、重放
- 针对单个 Host 做临时聚焦 / 忽略
- 从会话直接跳转到 Compose / Rules 工作台

### 4.2 低保真线框

```text
[Sessions Page]
┌──────────────────────────────────────────────────────────────────────────────┐
│ [Search sessions by host, path, or query.............] (Clear) (Export)    │
├──────────────────────────────────────────────────────────────────────────────┤
│ [Session Explorer]      [Drag Handle] [Inspector Workspace]                 │
│ ┌─────────────────────┐  ││  ┌───────────────────────────────────────────┐ │
│ │ ▾ example.com       │      │ GET /online/ → 200                        │ │
│ │   ▸ /index          │      │ Host: example.com  Duration: 23 ms        │ │
│ │   ▸ /api/list?a=1   │      ├───────────────────────────────────────────┤ │
│ │ ▸ assets.example.com│      │ Request: <Overview> <Query> <Headers>     │ │
│ │ ...                 │      │          <Body> <Form> <Raw>              │ │
│ └─────────────────────┘      │ Response: <Overview> <Headers> <Text>     │ │
│                               │           <JSON> <JSON Text> <Raw>        │ │
│                               │ [Inspector content / search / repeat]     │ │
│                               └───────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────────────────────────────┤
│ Right click on a session row                                                 │
│ ┌──────────────────────────────┐                                            │
│ │ Copy URL                     │                                            │
│ │ Copy Request / Response      │                                            │
│ │ Save Response...             │                                            │
│ │ Compose / Repeat             │                                            │
│ │ Export Session...            │                                            │
│ │ Clear Others                 │                                            │
│ │ Focus / Ignore Host          │                                            │
│ │ Breakpoints... / Map Rules...│                                            │
│ └──────────────────────────────┘                                            │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 4.3 实际 React 组件树

```text
SessionsPage
├─ Header Toolbar
│  ├─ Search Input
│  ├─ Clear Sessions Button
│  └─ Export Button
├─ Main Split Workspace
│  ├─ SessionExplorerPane
│  │  ├─ HostRow
│  │  ├─ SessionTreeNode
│  │  └─ SessionLeafNode
│  ├─ Split Resize Handle
│  └─ SessionInspectorWorkspace
│     ├─ InspectorSummaryBar
│     ├─ SessionInspectorRequestPane
│     └─ SessionInspectorResponsePane
├─ SessionExportDialog
├─ SessionContextMenu
└─ Snackbar
```

### 4.4 实现文件映射

| 文件 | 职责 |
|------|------|
| `pages/sessions/index.tsx` | SessionsPage 主页面，组合搜索、导出、上下文菜单、详情与跳转动作 |
| `features/sessions/components/SessionExplorerPane.tsx` | Host 树、请求节点、右键入口 |
| `features/sessions/components/SessionInspectorWorkspace.tsx` | 请求 / 响应详情工作区，支持搜索与 Repeat 摘要动作 |
| `features/sessions/components/SessionContextMenu.tsx` | 会话右键菜单，承载复制、导出、重放、Host 操作与页面跳转 |
| `features/sessions/components/SessionExportDialog.tsx` | Selected / Filtered / All 导出范围与格式选择 |

### 4.5 页面状态模型

```ts
type SessionsPageState = {
  bootstrap: {
    proxyStatusLoading: boolean;
    sessionsLoading: boolean;
    sessionDetailLoading: boolean;
  };
  query: {
    keyword: string;
  };
  selection: {
    selectedSessionId?: string;
    contextMenuSessionId?: string;
  };
  tree: {
    expandedKeys: string[]; // host key + host::path branch key
  };
  hostFilters: {
    focusedHost: string | null;
    ignoredHosts: string[];
  };
  persistence: {
    explorerWidth: number; // localStorage: aiproxy.sessions.explorerWidth
    requestCollapsed: boolean; // localStorage: aiproxy.sessions.requestCollapsed
  };
  ui: {
    requestTab: "overview" | "query" | "headers" | "body" | "form" | "raw";
    responseTab: "overview" | "headers" | "text" | "json" | "jsonText" | "raw";
    requestCollapsed: boolean;
    explorerWidth: number;
    exportDialogOpen: boolean;
    contextMenuAnchor?: { left: number; top: number };
    snackbarMessage: string | null;
  };
};
```

### 4.6 页面事件流

```text
Sessions polling returns captured sessions
-> SessionsPage filters ignored hosts
-> SessionExplorerPane groups remaining sessions by host and path
-> user searches / expands host / selects session
-> SessionInspectorWorkspace renders selected summary and tabs
-> user drags split handle
-> explorer width updates and persists to localStorage
-> user toggles request panel collapse
-> requestCollapsed persists to localStorage
```

### 4.7 上下文菜单事件流

```text
User right clicks a session leaf node
-> SessionsPage stores pointer anchorPosition + target session
-> SessionContextMenu opens at cursor position
-> menu action executes one of:
   copy URL / request / response
   save response
   compose from session
   repeat request directly
   export selected session
   clear all other sessions
   focus or unfocus host
   ignore or stop ignoring host
   go to Rules page
-> actions that need body/raw payload fetch detail on demand
-> copy actions show Snackbar feedback
-> menu closes after action
```

### 4.8 当前实现说明

- 右键菜单只挂在会话叶子节点，不作用于 Host 分组节点。
- `Focus Host` 会把其他 Host 降低透明度；`Ignore Host` 会直接从当前列表中过滤对应 Host。
- Host 聚焦 / 忽略仅保留在当前页面内存状态，刷新页面后不会持久化。
- `Breakpoints...` 与 `Map Rules...` 当前都跳转到 `/rules`，尚未做规则页 tab 深链。
- 复制请求、复制响应、保存响应、Compose、Repeat 会在需要时按需调用 `get_session_detail`。
- `Cmd+F / Ctrl+F` 会把搜索焦点交给当前激活的 Inspector 面板。

### 4.9 后续扩展位

- `SessionExplorerPane` 增加树形虚拟滚动与分组模式切换
- `SessionContextMenu` 补充键盘触发入口与禁用态说明
- `Focus / Ignore Host` 升级为可持久化筛选策略
- `Rules` 跳转支持按动作类型直达对应 tab
- `list_sessions` 改为实时事件推送 + 增量合并
- `get_session_detail` 按需加载 Inspector 真正内容，列表与详情解耦

## 5. Compose Page — `已实现`

### 5.1 页面目标

提供主动构造请求、发送请求、查看响应的完整工作台。

### 5.2 低保真线框

```text
[Compose Page]
┌──────────────────────────────────────────────────────────────────────────────┐
│ Title: Compose                                          (Send) (Export cURL) │
├──────────────────────────────────────────────────────────────────────────────┤
│ [Request Builder]                                  │ [Response Preview]       │
│ <GET▼> [https://example.com/api..............]    │ Status • Duration • Size │
│ [Headers] [Body] [Query]                          │ <Overview> <Headers>     │
│ [EditableKeyValueTable / TextField]               │ <Body> <Timing>          │
│                                                    │ [Inspector content]      │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 5.3 实际 React 组件树

```text
ComposePage
├─ PageHeader (title + description)
├─ Toolbar (Send button + Export cURL button)
├─ Two-column grid (8fr | 4fr)
│  ├─ SectionCard "Request Builder"
│  │  ├─ MethodSelect (GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS)
│  │  ├─ UrlInput (OutlinedInput, Enter 键触发发送)
│  │  ├─ Tabs: Headers | Body | Query
│  │  │  ├─ Headers: EditableKeyValueTable
│  │  │  ├─ Body: TextField multiline
│  │  │  └─ Query: EditableKeyValueTable (自动从 URL 解析)
│  └─ SectionCard "Response Preview"
│     ├─ InspectorSummaryBar (复用 Sessions Inspector 组件)
│     ├─ Tabs: Overview | Headers | Body | Timing
│     │  ├─ Overview: InspectorDefinitionList
│     │  ├─ Headers: InspectorKeyValueTable
│     │  ├─ Body: SearchableCodeBlock
│     │  └─ Timing: InspectorDefinitionList
```

### 5.4 实现文件映射

| 文件 | 职责 |
|------|------|
| `pages/compose/index.tsx` | ComposePage 主页面 |
| `features/compose/use-compose-request.ts` | React Query mutation，调用 `sendComposedRequest` |
| `features/compose/compose-editor.store.ts` | Zustand store，管理 method/url/headers/body/activeTab |
| `features/compose/curl-export.ts` | 纯函数 `generateCurlCommand()`，前端生成 cURL 命令 |
| `features/compose/components/EditableKeyValueTable.tsx` | 可编辑键值对组件（Headers/Query 共用） |

### 5.5 页面状态模型

```ts
// Zustand store: compose-editor.store.ts
type ComposeEditorState = {
  method: string;           // 默认 "GET"
  url: string;
  headers: HeaderEntry[];
  body: string;
  activeTab: "headers" | "body" | "query";
  setMethod / setUrl / setHeaders / setBody / setActiveTab
  loadFromSession(data)     // Repeat 按钮调用，预填数据
  reset()                   // 重置为初始状态
};

// React Query mutation: use-compose-request.ts
// mutation.data → SessionDetail（直接复用 Inspector 组件渲染）
// mutation.isPending → 加载状态
// mutation.isError → 错误提示
```

### 5.6 页面事件流

```text
用户编辑请求 → 点击 Send
→ sendComposedRequest(input)
→ Rust: send_direct_request() 发送 HTTP 请求
→ 返回 ProxySessionDetail → 存入 AppState → 前端 mutation.data 更新
→ Response Preview 渲染结果（复用 Inspector 组件）
→ Sessions 页面列表自动刷新（包含组合请求）

Repeat 流程：
Sessions Inspector 选中会话 → 点击 "Repeat" 按钮
→ loadFromSession() 预填 Zustand store
→ navigate("/compose") → Compose 页面显示预填数据
→ 用户可编辑后发送
```

## 6. Rules Page — `规则中心首版已实现`

### 6.1 页面目标

统一管理断点、改写、本地映射与远程映射规则。

### 6.2 低保真线框

```text
[Rules Page]
┌──────────────────────────────────────────────────────────────────────────────┐
│ Title: Rules                                                                │
├──────────────────────────────────────────────────────────────────────────────┤
│ <Breakpoint> <Rewrite> <Map Local> <Map Remote>                             │
├───────────────────────┬──────────────────────────────────────────────────────┤
│ [Rule List]           │ [Rule Editor]                                        │
│ (New Rule)            │ Name                                                 │
│ Search                │ Enabled                                              │
│ Rule A                │ Match Conditions                                     │
│ Rule B                │ Action Configuration                                 │
│ ...                   │ Priority                                             │
│                       │ Preview / Validation                                 │
└───────────────────────┴──────────────────────────────────────────────────────┘
```

### 6.3 React 组件树 — `规则中心首版已实现`

```text
RulesPage
├─ PageHeader
├─ SectionCard "Rule Center"
│  ├─ RuleTypeTabs (Breakpoint / Rewrite / Map Local / Map Remote)
│  └─ ActiveWorkbench
│     ├─ BreakpointRulesPanel
│     │  ├─ SectionCard "Quick Breakpoint"
│     │  ├─ SectionCard "Breakpoint Rules"
│     │  └─ Dialog "Add Breakpoint Rule"
│     ├─ RewriteRulesPanel
│     │  ├─ ManagedRulesWorkbench
│     │  │  ├─ Left Pane
│     │  │  │  ├─ Quick Create Buttons
│     │  │  │  ├─ Rule Search Field
│     │  │  │  └─ ManagedRuleList
│     │  │  └─ Right Pane
│     │  │     ├─ SectionCard "Basic Information"
│     │  │     ├─ MatchConditionsCard
│     │  │     ├─ RewriteActionEditor
│     │  │     └─ RulePreviewCard
│     └─ MapRulesPanel (local / remote)
│        ├─ ManagedRulesWorkbench
│        │  ├─ Left Pane
│        │  │  ├─ Create Rule Button
│        │  │  ├─ Rule Search Field
│        │  │  └─ ManagedRuleList
│        │  └─ Right Pane
│        │     ├─ SectionCard "Basic Information"
│        │     ├─ SectionCard "Source & Target"
│        │     └─ RulePreviewCard
```

断点拦截面板（独立组件，在 AppShell 中渲染）：

```text
BreakpointInterceptPanel (在 AppShell 主内容区与状态栏之间渲染)
├─ TopBar (Method Chip + Stage Badge + URL + 导航 1/N)
├─ Tabs (Request / Response)
│  ├─ Request Tab: HeaderEditor + BodyEditor
│  └─ Response Tab: Status + HeaderEditor + BodyEditor (或 Mock 编辑器)
└─ Action Buttons (Mock Response / Drop / Forward)
```

### 6.3.1 实现文件映射

| 文件 | 职责 |
|------|------|
| `features/breakpoints/breakpoint.store.ts` | Zustand store，管理 pendingHits / activeHitId / rules |
| `features/breakpoints/use-breakpoint-events.ts` | 订阅 `breakpoint-hit` Tauri 事件的 React hook |
| `features/breakpoints/use-breakpoint-rules.ts` | React Query hooks，调用 `listBreakpointRules` / `setBreakpointRules` |
| `features/rules/use-rule-center.ts` | React Query hooks，管理 Rewrite / Map Local / Map Remote 的读取、保存、删除 |
| `features/breakpoints/components/BreakpointInterceptPanel.tsx` | 断点拦截面板主组件，含 HeaderEditor、BodyEditor、Mock 编辑器 |
| `pages/rules/index.tsx` | Rules 页面，规则中心工作台（Tabs + 列表 + 编辑器 + 预览） |
| `components/layout/AppShell.tsx` | 集成 BreakpointInterceptPanel 和状态栏断点计数指示器 |
| `services/events/index.ts` | `onBreakpointHit()` Tauri 事件订阅 |
| `services/commands/index.ts` | `listBreakpointRules` / `resolveBreakpoint` 以及 Rewrite / Map / Throttling 的命令与本地 fallback |

### 6.4 页面状态模型

```ts
type RulesPageState = {
  query: {
    ruleType: "breakpoint" | "rewrite" | "mapLocal" | "mapRemote";
    keyword: string;
  };
  selection: {
    selectedRuleId?: string;
  };
  editor: {
    dirty: boolean;
    enabled: boolean;
    priority: number;
  };
  mutation: {
    saving: boolean;
    deleting: boolean;
  };
};
```

### 6.5 页面事件流 — `断点与规则中心首版已实现`

```text
Rules 页面事件流：
User clicks "Break on All Requests"
-> setBreakpointRules([...existingRules, catchAllRule])
-> rule list refreshes
-> proxy pipeline now intercepts requests matching the rule

断点拦截事件流：
Proxy receives request
-> BreakpointManager.should_break() matches a rule
-> oneshot channel created, proxy task awaits
-> "breakpoint-hit" event emitted to frontend
-> Zustand store adds pending hit
-> BreakpointInterceptPanel renders with request details
-> User edits headers/body and clicks "Forward"
-> resolveBreakpoint({ action: "forward", modifiedRequestHeaders: [...] })
-> Rust resolves oneshot channel, proxy task resumes with modifications
-> pending hit removed from store

规则中心事件流：
User switches rule type
-> active workbench changes
-> left rule list + right editor both switch to the selected domain
-> user selects or creates a rule
-> editor loads the draft model
-> preview card updates immediately as the draft changes
-> save command persists the rule
-> list refreshes and keeps the saved rule selected

## 6.6 Throttling Page — `已实现`

### 6.6.1 页面目标

让用户能够在“快速套预设”和“精确调参数”两条路径之间自由切换。

### 6.6.2 低保真线框

```text
[Throttling Page]
┌──────────────────────────────────────────────────────────────────────────────┐
│ Title: Throttling                                                           │
├──────────────────────────────────────────────────────────────────────────────┤
│ [Global Control]                                     [Global On/Off Switch] │
├───────────────────────┬──────────────────────────────────────────────────────┤
│ [Preset Profiles]     │ [Profile Editor]                                    │
│ Fast 4G               │ Name                                                 │
│ Slow 3G               │ Latency / Packet Loss                                │
│ Lossy Wi-Fi           │ Download / Upload                                    │
│ [Custom Profiles]     │ Note                                                 │
│ Team Profile A        │ Enable after save                                    │
│ ...                   │ [Preview / Validation]                               │
└───────────────────────┴──────────────────────────────────────────────────────┘
```

### 6.6.3 React 组件树

```text
ThrottlingPage
├─ PageHeader
├─ SectionCard "Global Control"
├─ Main Split Layout
│  ├─ Left Pane
│  │  ├─ SectionCard "Preset Profiles"
│  │  │  ├─ Preset Profile Cards
│  │  │  └─ New Custom Button
│  │  └─ Custom Profile List
│  └─ Right Pane
│     ├─ SectionCard "Profile Editor"
│     ├─ SectionCard "Preview & Validation"
│     └─ Save / Save & Apply Actions
```

### 6.6.4 页面事件流

```text
User clicks a preset
-> preset becomes selected in the left pane
-> editor loads the preset values on the right
-> user can apply it directly, or branch into a custom profile

User creates a custom profile
-> empty draft is created
-> user edits bandwidth / latency / loss
-> validation and preview update immediately
-> save persists the profile
-> save & apply persists then toggles global throttling on with this profile
```

## 6.7 Sessions Export Dialog — `已实现`

### 6.7.1 页面目标

在不离开 Sessions 工作台的前提下，让用户快速导出“当前选中 / 当前筛选 / 全部会话”。

### 6.7.2 低保真线框

```text
[Export Sessions Dialog]
┌──────────────────────────────────────────────────────────────────────────────┐
│ Export Sessions                                                             │
├──────────────────────────────────────────────────────────────────────────────┤
│ Scope: [Selected Session] [Filtered Sessions] [All Sessions]                │
│ Format: [Session Snapshot] [HAR] [cURL]                                     │
│ Summary: Ready to export N sessions as ...                                  │
│ Feedback / Error                                                            │
├──────────────────────────────────────────────────────────────────────────────┤
│ (Cancel)                                                     (Export / Copy)│
└──────────────────────────────────────────────────────────────────────────────┘
```

### 6.7.3 实现文件映射

| 文件 | 职责 |
|------|------|
| `pages/sessions/index.tsx` | 在 Sessions 页头部提供导出入口，并挂载导出对话框 |
| `features/sessions/components/SessionExportDialog.tsx` | 范围选择、格式选择、导出反馈 |
| `features/sessions/session-export.helpers.ts` | 生成会话快照 JSON、HAR、cURL bundle |

### 6.7.4 页面事件流

```text
User clicks Export in Sessions header
-> dialog opens
-> user chooses scope: selected / filtered / all
-> user chooses format: snapshot / HAR / cURL
-> selected scope sessions are resolved into details
-> snapshot or HAR downloads as a file
-> cURL copies to clipboard as a bundle of commands
```
```

## 7. Certificates Page

### 7.1 页面目标

让用户完成 HTTPS 解密前的环境准备和风险理解。

### 7.2 低保真线框

```text
[Certificates Page]
┌──────────────────────────────────────────────────────────────────────────────┐
│ Title: Certificates                                                         │
├──────────────────────────────────────────────────────────────────────────────┤
│ [Certificate Status Card]                                                   │
│ Root Certificate: Present / Missing                                         │
│ Trusted: Yes / No                                                           │
│ Fingerprint: ...                                                            │
│ (Generate) (Install Certificate) (Refresh Status)                           │
├──────────────────────────────────────────────────────────────────────────────┤
│ [Installation Guide]                                                        │
│ Windows Steps | macOS Steps | Linux Steps                                   │
├──────────────────────────────────────────────────────────────────────────────┤
│ [Mobile Setup Card]                                                         │
│ Local IP: 192.168.x.x        Proxy Port: 8888                              │
│ Wi-Fi Proxy: 192.168.x.x:8888                                              │
│ ┌──────────────────┐  Cert URL: http://192.168.x.x:8888/aiproxy-ca.crt     │
│ │   [QR Code]      │  (Copy Proxy Address)                                 │
│ └──────────────────┘                                                        │
│ iOS Guide | Android Guide                                                   │
├──────────────────────────────────────────────────────────────────────────────┤
│ [FAQ / Risk Notes]                                                          │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 7.3 React 组件树

```text
CertificatesPage
├─ PageHeader
├─ CertificateCenter
│  ├─ CertificateStatusCard
│  ├─ CertificateActions
│  ├─ PlatformGuideTabs
│  ├─ MobileSetupCard
│  │  ├─ QRCodeSVG
│  │  ├─ Network Information Display
│  │  └─ MobilePlatformGuide (iOS / Android Tabs)
│  └─ CertificateRiskNotes
└─ BottomStatusStrip
```

### 7.4 页面状态模型

```ts
type CertificatesPageState = {
  query: {
    loadingStatus: boolean;
    loadingLocalIp: boolean;
    loadingProxyStatus: boolean;
  };
  ui: {
    activePlatformTab: "windows" | "macos" | "linux";
    activeMobileGuideTab: "ios" | "android";
  };
  mutation: {
    generatingCertificate: boolean;
    refreshingStatus: boolean;
  };
  data: {
    localIp?: string;
    proxyPort?: number;
    certDownloadUrl?: string;
  };
};
```

## 8. Settings Page — `基础设置与代理预设已实现`

### 8.1 页面目标

集中管理应用默认设置与代理启动配置，不再提供独立 Workspaces Page。

当前已实现目标：

- 管理代理预设（端口、SSL）
- 管理界面语言偏好
- 管理界面外观偏好
- 支持 `system` 级别的自动解析与持久化

### 8.2 低保真线框

```text
[Settings Page]
┌──────────────────────────────────────────────────────────────────────────────┐
│ Title: Settings                                                             │
├──────────────────────────────────────────────────────────────────────────────┤
│ [Proxy Presets]                                                             │
│ Preset List                  (New Preset) (Apply) (Save)                    │
│ Name / Port / SSL Editor                                                    │
├──────────────────────────────────────────────────────────────────────────────┤
│ [Language & Region]                                                         │
│ Display Language: [Follow System v]                                         │
│ Info Hint                                                                   │
├──────────────────────────────────────────────────────────────────────────────┤
│ [Appearance]                                                                │
│ Appearance Theme: [Follow System v]                                         │
│ Info Hint                                                                   │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 8.3 React 组件树

```text
SettingsPage
├─ PageHeader
├─ ProxyPresetsSection
│  ├─ PresetList
│  ├─ PresetActions
│  ├─ PresetEditor
│  └─ SuccessAlert
├─ SectionCard "Language & Region"
│  ├─ Description
│  ├─ LanguagePreferenceSelect
│  └─ EffectiveLanguageAlert
├─ SectionCard "Appearance"
│  ├─ Description
│  ├─ ThemePreferenceSelect
│  └─ EffectiveThemeAlert
```

### 8.4 页面状态模型

```ts
type SettingsPageState = {
  presets: {
    activePresetId?: string;
    selectedPresetId?: string | null;
    isCreatingPreset: boolean;
  };
  preferences: {
    languagePreference: "system" | "zh-CN" | "en";
    themePreference: "system" | "light" | "dark";
  };
  derived: {
    resolvedLocale: "zh-CN" | "en";
    resolvedTheme: "light" | "dark";
  };
};
```

## 9. Proxy Presets（代理预设）— 已实现

> 原设计为独立 Workspaces Page，已降级为 Settings Page 内的 Proxy Presets section。
> 后端 API 不变（`list_workspaces` 等命令），用户面向概念从"工作区"简化为"代理预设"。

### 9.1 功能目标

保存常用代理启动配置（端口、SSL），支持一键切换。每个预设只携带端口和 SSL 开关，不承诺会话或规则隔离。

### 9.2 实现位置

Settings Page（`pages/settings/index.tsx`）内的 `ProxyPresetsSection` 组件。

### 9.3 实现文件映射

| 层级 | 文件 | 职责 |
| --- | --- | --- |
| 页面 | `pages/settings/index.tsx` — `ProxyPresetsSection` | 预设列表 + 新建/编辑表单 + Apply/Save 操作 |
| Feature Hooks | `features/workspace-manager/use-workspaces.ts` | `useWorkspaces`, `useCreateWorkspace`, `useLoadWorkspace`, `useUpdateWorkspace` |
| 服务层 | `services/commands/index.ts` | `listWorkspaces`, `createWorkspace`, `loadWorkspace`, `updateWorkspace` |
| 共享类型 | `packages/shared-types/src/index.ts` | `Workspace` 类型, `isWorkspace`, `parseWorkspaces` |
| Rust 命令 | `src-tauri/src/commands/mod.rs` | `list_workspaces`, `create_workspace`, `load_workspace`, `update_workspace` |
| Rust 领域 | `src-tauri/src/workspace.rs` | `WorkspaceManager` — 内存中预设 CRUD |
| i18n | `i18n/messages/en.ts`, `zh-CN.ts` | `proxyPresets.*` 文案键 |

### 9.4 页面事件流

| 用户操作 | 触发 | 结果 |
| --- | --- | --- |
| 点击列表中的预设 | `handleSelect(preset)` | 选中该预设，展开编辑区 |
| 点击 "New Preset" | `handleNew()` | 清空表单，进入新建模式 |
| 点击 "Save" (新建) | `createWorkspaceMutation.mutate()` | 调用 Rust `create_workspace` |
| 点击 "Save" (编辑) | `updateWorkspaceMutation.mutate()` | 调用 Rust `update_workspace` |
| 点击 "Apply" | `loadWorkspaceMutation.mutate()` | 切换当前活跃预设 |
| AppShell 底部状态栏预设切换 | `handleWorkspaceSwitch(id)` | 从底部状态栏打开预设列表；若代理运行中则以当前配置重启并切换到目标预设 |

## 10. 页面与模块映射

| 页面 | 主 Feature 模块 | 主要命令/接口 |
| --- | --- | --- |
| Sessions | `session-list`, `session-detail`, `proxy-status` | `start_proxy`, `stop_proxy`, `list_sessions`, `enable_system_proxy`, `disable_system_proxy` |
| Compose | `compose-request` | `send_composed_request` (已实现)，`repeat_session` (前端 Repeat 按钮替代) |
| Rules | `breakpoints` (已实现), `rewrite-rules`, `map-rules` | `list_breakpoint_rules` (已实现), `set_breakpoint_rules` (已实现), `resolve_breakpoint` (已实现) |
| Certificates | `certificate-center` | `get_certificate_status`, `generate_root_certificate`, `get_local_ip` |
| Settings | `settings`, `workspace-manager` | settings service / local config + Proxy Presets section；`list_workspaces` (已实现), `create_workspace` (已实现), `load_workspace` (已实现), `update_workspace` (已实现) |

## 11. 实现建议

- 先按页面蓝图搭稳定的 `layout + feature + shared component` 骨架
- 页面级状态与服务调用放入 `features/*`
- 页面容器只负责拼装，不承载复杂业务逻辑
- 所有分栏页优先实现拖拽宽度记忆和空状态统一策略

## Sessions UX Constraints

- The host tree in `Session Explorer` must stay collapsed by default.
- A host group expands only after explicit user interaction on that host row.
- The Inspector must not auto-select and render an arbitrary request while every host group is collapsed.
