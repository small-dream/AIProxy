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
│ Title: Sessions                                                             │
│ Subtitle: Main capture workspace for traffic inspection                     │
├──────────────────────────────────────────────────────────────────────────────┤
│ [Proxy Runtime Card]                                                        │
│ Workspace: Default    Port: 8888    [Running/Idle] [System Proxy On/Off]    │
│ (Enable System Proxy) (Start Proxy / Stop Proxy)                            │
├──────────────────────────────────────────────────────────────────────────────┤
│ [Capture Stream]                                   [Inspector]              │
│ ┌───────────────────────────────────────────────┐  ┌──────────────────────┐ │
│ │ Search                                       │  │ Summary              │ │
│ │ <Method> <Status> <Protocol> (Clear) (Export)│  │ Method               │ │
│ ├───────────────────────────────────────────────┤  │ Host                 │ │
│ │ Method | Host | Path | Status | Time | Size │  │ Path                 │ │
│ │ GET    | a.com| /api | 200    | 23ms | 1.2KB│  │ Status               │ │
│ │ POST   | b.com| /log | 204    | 14ms | 0.3KB│  │ Duration             │ │
│ │ ...                                           │  │ URL                  │ │
│ └───────────────────────────────────────────────┘  └──────────────────────┘ │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 4.3 React 组件树

```text
SessionsPage
├─ PageHeader
├─ ProxyStatusCard
├─ CaptureWorkbench
│  ├─ SessionFilterBar
│  │  ├─ SearchField
│  │  ├─ MethodFilter
│  │  ├─ StatusFilter
│  │  ├─ ProtocolFilter
│  │  ├─ ClearSessionsButton
│  │  └─ ExportSessionsButton
│  ├─ SessionListPane
│  │  ├─ SessionTableHeader
│  │  ├─ SessionList
│  │  │  └─ SessionRow
│  │  └─ SessionListState
│  └─ SessionInspectorPane
│     ├─ SessionSummaryPanel
│     ├─ InspectorTabs
│     └─ SessionInspectorState
└─ BottomStatusStrip
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
    method?: string;
    statusCode?: number;
    protocol?: string;
  };
  selection: {
    selectedSessionId?: string;
  };
  mutation: {
    startingProxy: boolean;
    stoppingProxy: boolean;
    enablingSystemProxy: boolean;
    disablingSystemProxy: boolean;
  };
  ui: {
    inspectorTab: "overview" | "request" | "response" | "timing" | "cookies" | "raw";
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
-> user selects one session
-> inspector renders selected summary
```

### 4.6 后续扩展位

- `SessionInspectorPane` 追加完整 tabs
- `list_sessions` 改为实时事件推送 + 增量合并
- `SessionFilterBar` 接分页与持久化过滤条件

## 5. Compose Page

### 5.1 页面目标

提供主动构造请求、发送请求、查看响应的完整工作台。

### 5.2 低保真线框

```text
[Compose Page]
┌──────────────────────────────────────────────────────────────────────────────┐
│ Title: Compose                                                              │
├──────────────────────────────────────────────────────────────────────────────┤
│ (Send) (Save Template) (Duplicate) (Export cURL)                            │
├───────────────┬───────────────────────────────────────┬──────────────────────┤
│ [Templates]   │ [Request Editor]                      │ [Response Preview]   │
│ Recent        │ <Method> [URL Input................]  │ Status               │
│ Saved         │ [Headers Tab] [Query Tab] [Body Tab] │ Duration             │
│ ...           │ [Editor Area.......................]  │ Response Body        │
│               │                                       │ ...                  │
└───────────────┴───────────────────────────────────────┴──────────────────────┘
```

### 5.3 React 组件树

```text
ComposePage
├─ PageHeader
├─ ComposeToolbar
├─ ComposeWorkbench
│  ├─ RequestTemplatePane
│  ├─ RequestEditorPane
│  │  ├─ MethodSelect
│  │  ├─ UrlInput
│  │  ├─ RequestEditorTabs
│  │  ├─ HeadersEditor
│  │  ├─ QueryEditor
│  │  └─ BodyEditor
│  └─ ResponsePreviewPane
│     ├─ ResponseSummary
│     ├─ ResponseTabs
│     └─ ResponseBodyViewer
└─ BottomStatusStrip
```

### 5.4 页面状态模型

```ts
type ComposePageState = {
  editor: {
    method: string;
    url: string;
    headers: Array<{ name: string; value: string }>;
    query: Array<{ name: string; value: string }>;
    body: string;
    activeTab: "headers" | "query" | "body";
  };
  response: {
    sessionId?: string;
    statusCode?: number;
    body?: string;
    durationMs?: number;
  };
  ui: {
    selectedTemplateId?: string;
  };
  mutation: {
    sending: boolean;
    savingTemplate: boolean;
  };
};
```

### 5.5 页面事件流

```text
User edits request
-> send_composed_request
-> response session created
-> response preview updates
-> user may save as template or export cURL
```

## 6. Rules Page

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

### 6.3 React 组件树

```text
RulesPage
├─ PageHeader
├─ RuleTypeSwitcher
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

### 6.5 页面事件流

```text
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
│ (Generate) (Refresh Status)                                                 │
├──────────────────────────────────────────────────────────────────────────────┤
│ [Installation Guide]                                                        │
│ Windows Steps | macOS Steps | Linux Steps                                   │
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
│  └─ CertificateRiskNotes
└─ BottomStatusStrip
```

### 7.4 页面状态模型

```ts
type CertificatesPageState = {
  query: {
    loadingStatus: boolean;
  };
  ui: {
    activePlatformTab: "windows" | "macos" | "linux";
  };
  mutation: {
    generatingCertificate: boolean;
    refreshingStatus: boolean;
  };
};
```

## 8. Settings Page

### 8.1 页面目标

集中管理应用默认设置，而不是项目级调试数据。

### 8.2 低保真线框

```text
[Settings Page]
┌──────────────────────────────────────────────────────────────────────────────┐
│ Title: Settings                                                             │
├───────────────┬──────────────────────────────────────────────────────────────┤
│ [Nav]         │ [Content]                                                    │
│ General       │ Section Title                                                │
│ Proxy         │ Setting Row                                                  │
│ Certificates  │ Setting Row                                                  │
│ Storage       │ Setting Row                                                  │
│ Appearance    │ Setting Row                                                  │
│ Shortcuts     │ (Save) (Reset)                                               │
│ Advanced      │                                                              │
└───────────────┴──────────────────────────────────────────────────────────────┘
```

### 8.3 React 组件树

```text
SettingsPage
├─ PageHeader
├─ SettingsWorkbench
│  ├─ SettingsNavigation
│  └─ SettingsContentPane
│     ├─ SettingsSectionHeader
│     ├─ SettingsFieldRow
│     └─ SettingsActions
└─ BottomStatusStrip
```

### 8.4 页面状态模型

```ts
type SettingsPageState = {
  ui: {
    activeSection:
      | "general"
      | "proxy"
      | "certificates"
      | "storage"
      | "appearance"
      | "shortcuts"
      | "advanced";
  };
  editor: {
    dirty: boolean;
  };
  mutation: {
    saving: boolean;
    resetting: boolean;
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
|---|---|---|
| Sessions | `session-list`, `session-detail`, `proxy-status` | `start_proxy`, `stop_proxy`, `list_sessions`, `enable_system_proxy`, `disable_system_proxy` |
| Compose | `compose-request` | `send_composed_request`, `repeat_session` |
| Rules | `breakpoints`, `rewrite-rules`, `map-rules` | `save_*_rule`, `list_*_rules` |
| Certificates | `certificate-center` | `get_certificate_status`, `generate_root_certificate` |
| Settings | `settings` | settings service / local config |
| Workspaces | `workspace-manager` | `list_workspaces`, `create_workspace`, `load_workspace` |

## 11. 实现建议

- 先按页面蓝图搭稳定的 `layout + feature + shared component` 骨架
- 页面级状态与服务调用放入 `features/*`
- 页面容器只负责拼装，不承载复杂业务逻辑
- 所有分栏页优先实现拖拽宽度记忆和空状态统一策略
