# Pharles Page Blueprints

## 1. 文档信息

- 产品代号：`Pharles`
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

### 4.1 页面目标

完成抓包主路径：

- 启动代理
- 开关系统代理
- 实时查看请求
- 筛选会话
- 查看请求详情

### 4.2 低保真线框

```text
[Sessions Page]
┌──────────────────────────────────────────────────────────────────────────────┐
│ [Filter hosts, paths, methods, or status........] <All> <HTTP> <Errors>    │
├──────────────────────────────────────────────────────────────────────────────┤
│ [Session Explorer]                                [Inspector Workspace]      │
│ ┌───────────────────────────────────────────────┐  ┌──────────────────────┐ │
│ │ Requests: 23                                  │  │ GET /online/ → 200   │ │
│ ├───────────────────────────────────────────────┤  │ Host: example.com    │ │
│ │ ▾ example.com (3)                             │  │ Duration: 23 ms      │ │
│ │   ▸ GET /index                                │  ├──────────────────────┤ │
│ │   ▸ GET /api/list                             │  │ <Overview> <Contents>│ │
│ │   ▸ POST /report                              │  │ <Summary> <Timing>   │ │
│ │ ▸ assets.example.com (8)                      │  ├──────────────────────┤ │
│ │ ▸ api.example.net (12)                        │  │ <Headers> <Text>     │ │
│ │ ...                                           │  │ <Hex> <Raw>          │ │
│ └───────────────────────────────────────────────┘  │ [Inspector content]  │ │
├──────────────────────────────────────────────────────────────────────────────┤
│ [Recording] Workspace: Default Port: 8888 [SSL Off] [System Proxy On/Off]  │
│ [Status only]                                                               │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 4.3 React 组件树

```text
AppShell
├─ TopAppBar
├─ LeftNavigation
├─ SessionsPage
│  ├─ SessionFilterBar
│  ├─ CaptureWorkbench
│  │  ├─ SessionExplorerPane
│  │  │  ├─ ExplorerSummary
│  │  │  ├─ SessionHostTree
│  │  │  │  ├─ HostGroupNode
│  │  │  │  └─ SessionLeafNode
│  └─ SessionInspectorWorkspace
│     ├─ RequestHeadline
│     ├─ InspectorPrimaryTabs
│     ├─ InspectorSecondaryTabs
│     └─ SessionInspectorState
└─ BottomControlStrip
```

### 4.4 页面状态模型

```ts
type SessionsPageState = {
  bootstrap: {
    proxyStatusLoading: boolean;
    sessionsLoading: boolean;
  };
  query: {
    keyword: string;
    scope: "all" | "http" | "errors";
  };
  selection: {
    selectedSessionId?: string;
  };
  tree: {
    expandedHosts: string[];
  };
  mutation: {
    startingProxy: boolean;
    stoppingProxy: boolean;
    enablingSystemProxy: boolean;
    disablingSystemProxy: boolean;
  };
  ui: {
    primaryInspectorTab: "overview" | "contents" | "summary" | "timing" | "raw";
    secondaryContentTab: "headers" | "text" | "hex" | "raw";
  };
};
```

### 4.5 页面事件流

```text
User clicks Start Proxy
-> start_proxy
-> proxy status updates
-> sessions polling starts
-> User enables system proxy
-> local HTTP traffic enters proxy
-> list_sessions returns captured sessions
-> SessionHostTree groups sessions by host
-> user expands host group and selects one session
-> inspector workspace renders selected summary and tabs
```

### 4.6 后续扩展位

- `SessionExplorerPane` 增加树形虚拟滚动与分组模式切换
- `Content Split Pane` 支持左右分栏拖拽宽度记忆
- `SessionInspectorWorkspace` 追加完整 request / response / timing 数据
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

## 6. Rules Page — `断点规则管理已实现`

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

### 6.3 React 组件树 — `断点规则部分已实现`

```text
RulesPage (断点规则管理已实现)
├─ PageHeader
├─ SectionCard "Quick Breakpoint" (一键全局断点按钮)
├─ SectionCard "Breakpoint Rules" (规则表格)
│  ├─ Table (规则列表: 启用/URL Pattern/Methods/Stage/删除)
│  └─ Button "Add Rule"
├─ Dialog "Add Breakpoint Rule" (新增规则表单)
│  ├─ OutlinedInput (URL pattern)
│  ├─ Select (HTTP Methods, 多选)
│  └─ Select (Stage: request/response)
│
│ 以下为规划中结构，尚未实现
├─ RuleTypeSwitcher (Breakpoint / Rewrite / Map Local / Map Remote)
├─ RulesWorkbench
│  ├─ RuleListPane
│  │  ├─ RuleSearchField
│  │  ├─ CreateRuleButton
│  │  └─ RuleList
│  └─ RuleEditorPane
│     ├─ RuleBasicInfoForm
│     ├─ MatchConditionForm
│     ├─ ActionConfigurationForm
│     ├─ PriorityControl
│     └─ RulePreviewPanel
└─ BottomStatusStrip
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

### 6.3.1 断点功能实现文件映射

| 文件 | 职责 |
|------|------|
| `features/breakpoints/breakpoint.store.ts` | Zustand store，管理 pendingHits / activeHitId / rules |
| `features/breakpoints/use-breakpoint-events.ts` | 订阅 `breakpoint-hit` Tauri 事件的 React hook |
| `features/breakpoints/use-breakpoint-rules.ts` | React Query hooks，调用 `listBreakpointRules` / `setBreakpointRules` |
| `features/breakpoints/components/BreakpointInterceptPanel.tsx` | 断点拦截面板主组件，含 HeaderEditor、BodyEditor、Mock 编辑器 |
| `pages/rules/index.tsx` | Rules 页面，断点规则管理（表格 + 快捷按钮 + 新增对话框） |
| `components/layout/AppShell.tsx` | 集成 BreakpointInterceptPanel 和状态栏断点计数指示器 |
| `services/events/index.ts` | `onBreakpointHit()` Tauri 事件订阅 |
| `services/commands/index.ts` | `listBreakpointRules` / `setBreakpointRules` / `resolveBreakpoint` 命令 |

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

### 6.5 页面事件流 — `断点部分已实现`

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

规划中的完整规则事件流：
User switches rule type
-> list of rules changes
-> user selects or creates rule
-> editor loads rule model
-> save command persists rule
-> list refreshes
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
│ ┌──────────────────┐  Cert URL: http://192.168.x.x:8888/pharles-ca.crt     │
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

## 8. Settings Page — `基础设置已实现`

### 8.1 页面目标

集中管理应用默认设置，而不是项目级调试数据。

当前已实现目标：

- 管理界面语言偏好
- 管理界面外观偏好
- 支持 `system` 级别的自动解析与持久化

### 8.2 低保真线框

```text
[Settings Page]
┌──────────────────────────────────────────────────────────────────────────────┐
│ Title: Settings                                                             │
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
├─ SectionCard "Language & Region"
│  ├─ Description
│  ├─ LanguagePreferenceSelect
│  └─ EffectiveLanguageAlert
├─ SectionCard "Appearance"
│  ├─ Description
│  ├─ ThemePreferenceSelect
│  └─ EffectiveThemeAlert
└─ BottomStatusStrip
```

### 8.4 页面状态模型

```ts
type SettingsPageState = {
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

## 9. Workspaces Page

### 9.1 页面目标

管理项目级工作区及其代理端口、会话隔离、规则隔离。

### 9.2 低保真线框

```text
[Workspaces Page]
┌──────────────────────────────────────────────────────────────────────────────┐
│ Title: Workspaces                                                           │
├───────────────────────┬──────────────────────────────────────────────────────┤
│ [Workspace List]      │ [Workspace Detail]                                  │
│ (New Workspace)       │ Name                                                 │
│ Default               │ Proxy Port                                           │
│ Mobile App            │ SSL Enabled                                          │
│ Web QA                │ Storage Path                                         │
│ ...                   │ (Save) (Delete) (Load)                               │
└───────────────────────┴──────────────────────────────────────────────────────┘
```

### 9.3 React 组件树

```text
WorkspacesPage
├─ PageHeader
├─ WorkspaceManager
│  ├─ WorkspaceListPane
│  └─ WorkspaceDetailPane
│     ├─ WorkspaceForm
│     └─ WorkspaceActions
└─ BottomStatusStrip
```

## 10. 页面与模块映射

| 页面 | 主 Feature 模块 | 主要命令/接口 |
| --- | --- | --- |
| Sessions | `session-list`, `session-detail`, `proxy-status` | `start_proxy`, `stop_proxy`, `list_sessions`, `enable_system_proxy`, `disable_system_proxy` |
| Compose | `compose-request` | `send_composed_request` (已实现)，`repeat_session` (前端 Repeat 按钮替代) |
| Rules | `breakpoints` (已实现), `rewrite-rules`, `map-rules` | `list_breakpoint_rules` (已实现), `set_breakpoint_rules` (已实现), `resolve_breakpoint` (已实现) |
| Certificates | `certificate-center` | `get_certificate_status`, `generate_root_certificate`, `get_local_ip` |
| Settings | `settings` | settings service / local config |
| Workspaces | `workspace-manager` | `list_workspaces`, `create_workspace`, `load_workspace` |

## 11. 实现建议

- 先按页面蓝图搭稳定的 `layout + feature + shared component` 骨架
- 页面级状态与服务调用放入 `features/*`
- 页面容器只负责拼装，不承载复杂业务逻辑
- 所有分栏页优先实现拖拽宽度记忆和空状态统一策略

## Sessions UX Constraints

- The host tree in `Session Explorer` must stay collapsed by default.
- A host group expands only after explicit user interaction on that host row.
- The Inspector must not auto-select and render an arbitrary request while every host group is collapsed.
