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
│ └─────────────────────┘      │ Response: <Overview> <Preview> <Headers> <Text>     │ │
│                               │           <JSON> <JSON Text> <Raw>      │ │
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
│  │  ├─ SessionFilterChips（生效中的 focus / ignore / throttled 过滤 chips，点 × 移除；无过滤不渲染）
│  │  ├─ MultiSelectBatchBar（多选后出现：Export / Save responses / Delete / Clear）
│  │  ├─ HostRow
│  │  ├─ SessionTreeNode
│  │  └─ SessionLeafNode
│  ├─ Split Resize Handle
│  └─ SessionInspectorWorkspace
│     ├─ InspectorSummaryBar
│     ├─ SessionInspectorRequestPane
│     └─ SessionInspectorResponsePane
│        ├─ WaterfallChart（Overview Tab 内嵌，展示 timing 水平堆叠条形图）
│        └─ SessionInspectorMediaPreview（图片/音视频预览）
│        └─ SessionInspectorMessagesPane（WebSocket 专用）
│           ├─ Connection Status Indicator
│           ├─ Message List + Detail Split
│           ├─ MessageRow（含 Replay 按钮）
│           └─ Compose Panel（方向/操作码/内容/发送）
├─ SessionExportDialog
├─ SessionContextMenu
├─ DomainContextMenu
├─ SessionFolderContextMenu
├─ SaveResponseFilesDialog
└─ Snackbar
```

### 4.4 实现文件映射

| 文件 | 职责 |
|------|------|
| `pages/sessions/index.tsx` | SessionsPage 主页面，组合搜索、导出、上下文菜单、详情与跳转动作 |
| `features/sessions/components/SessionExplorerPane.tsx` | Host 树（路径分支节点统一使用 Folder Icon，不再区分展开/折叠态）、请求节点、右键入口 |
| `features/sessions/components/SessionFilterChips.tsx` | 列表上方的单行可移除过滤 chips：每个 focused/ignored host 一枚（点 × 取消），同一类别超过 3 个 host 时聚合为"Focus/Ignored (N)"总 chip（菜单内可逐项移除/全部清除），throttled 过滤一枚总开关；被 ignore 的 host 从数据滤除后右键菜单不可达，此行是唯一取消入口 |
| `features/sessions/components/SessionInspectorWorkspace.tsx` | 请求 / 响应详情工作区，支持搜索与 Repeat 摘要动作 |
| `features/sessions/components/SessionInspectorMediaPreview.tsx` | 响应体多媒体预览（图片/音频/视频），按 MIME 类型动态显示，支持右键复制图片/另存为/复制地址/在浏览器中打开 |
| `features/sessions/components/SessionContextMenu.tsx` | 会话右键菜单，承载复制、导出、重放、Host 操作（含按 host 停用/启用 SSL 解密）、规则跳转（含 Map Local 直达） |
| `features/sessions/components/DomainContextMenu.tsx` | Host 节点右键菜单：保存该 host 下所有文件、导出 HAR、Focus / Ignore |
| `features/sessions/components/SessionFolderContextMenu.tsx` | URL 路径目录节点右键菜单，当前承载「保存所有文件」 |
| `features/sessions/components/SaveResponseFilesDialog.tsx` | 保存抓包文件的策略对话框（同名冲突：只保留最后一次 / 全部保留），无冲突时不出现 |
| `features/sessions/session-save-files.helpers.ts` | 可保存会话过滤（排除 WebSocket）与同名冲突检测 |
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
    jsonTreeColumnRatios?: {
      nameRatio: number;
      typeRatio: number;
    };
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
-> SessionFilterChips renders one removable chip per focused/ignored host
   and a throttled-only toggle chip (renders nothing when no filter active)
-> user searches / expands host / selects session
-> SessionInspectorWorkspace renders selected summary and tabs
-> user drags split handle
-> explorer width updates and persists to localStorage
-> user toggles request panel collapse
-> requestCollapsed persists to localStorage
-> user clicks "Clear Session" (header) or menu "Clear All Sessions"
-> ConfirmDialog requires explicit confirmation (unless skipClearSessionsConfirm preference is on,
   in which case clearing fires immediately; opt-out is only offered in this dialog and can be
   re-enabled in Settings)
-> clear_sessions mutation succeeds -> sessions cache cleared + Snackbar
```

**事件批处理（M1）：** `SessionsPage` 现在直接订阅会话事件，使用 100ms 批处理缓冲区。`useSessionEvents` hook 已废弃。单次批处理刷新中，容器状态和 React Query 缓存同时更新。

**搜索/筛选防抖（M1）：** SessionExplorer 全字段搜索输入和 WS Messages 搜索输入均使用 `useDebouncedValue` hook（150ms 延迟），避免高频输入触发不必要的重新渲染或查询。全字段搜索词随会话容器存储（`searchValue`），切换容器各自保留。

**键盘与多选（P1）：** 会话树支持 `↑/↓`、`Home/End`、`Esc`；`⌘/Ctrl+点击` 多选、`Shift+点击` 范围选择（按树可见顺序，`collectVisibleSessionIds` 与键盘导航共用同一顺序源）；多选批量条支持导出 / 保存响应 / 删除（删除需确认）。

**SSL 按 host 解密（P1）：** 右键菜单可对会话 host 停用/启用 SSL 解密，写入 `Workspace.sslBlindHosts`（DB `ssl_blind_hosts` 列），代理运行时对列表内 host 直接盲通（`is_ssl_blind_tunnel` / `host_in_allowlist`），修改后自动重启代理生效。

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
   disable / enable SSL decryption for host (updates Workspace.sslBlindHosts,
     restarts the proxy when running)
   create rewrite rule / map local rule (seeds Rules page with request fields)
   go to Breakpoints / Rules page
-> actions that need body/raw payload fetch detail on demand
-> copy actions show Snackbar feedback
-> menu closes after action
```

**保存目录下所有抓包文件事件流：**

```text
User right clicks a folder node (URL path branch) or a host node
-> SessionsPage stores pointer anchorPosition + folder target
   folder target = { label, sessions: collectBranchSessions(node) }
   host target   = { label: host, sessions: visibleSessions filtered by host }
-> SessionFolderContextMenu / DomainContextMenu opens at cursor position
-> "Save All Files..." branches on hasSaveTargetConflicts(saveableSessions):
   no collision -> skip the dialog, keepAll is equivalent to latestOnly
   collision    -> SaveResponseFilesDialog asks for a conflict strategy
-> invoke save_response_files({ sessionIds, conflictStrategy, title })
   -> backend opens the OS directory picker (renderer never supplies a path)
   -> backend rebuilds the full URL path below the host, which is never
      itself a directory
   -> backend sanitizes every segment
   -> backend writes raw response bytes, no base64 across IPC
-> null result (picker cancelled) keeps the dialog open
-> otherwise dialog closes and Snackbar reports saved / skipped counts
```

**Code Block 右键菜单事件流：**

```text
User selects text and right clicks in a code block view (JSON Text / Raw / Text Body)
-> SearchableCodeBlock prevents browser native context menu
-> stores anchorPosition + selected text
-> Context menu opens with Copy / Search options
   Copy  -> navigator.clipboard.writeText(selectedText)
   Search -> onSearchWithText(selectedText)
          -> parent pane opens search bar with selected text as query
-> menu closes after action
```

### 4.8 当前实现说明

- Inspector Response Overview Tab 内嵌 `WaterfallChart` 组件，展示 timing 水平堆叠条形图（dns / connect / tls / request_send / waiting / response_read / total），各阶段使用不同颜色区分并支持 Tooltip 显示具体耗时。WaterfallChart 根据 `timingSource` 自动调整展示粒度：`"proxy"` 显示全部 7 个阶段，`"compose"` 仅显示已采集的阶段，`"har-import"` 取决于导入数据。
- Inspector Request Overview 的 General 分组包含 `Route`（出网路径）行，取值为 `Direct`（直连）/ `Via upstream proxy`（经上游代理）/ `N/A`。`N/A` 对应 `viaUpstreamProxy` 为空的情况——mock / Map Local / script 合成响应根本没有出网，以及该字段存在之前抓的历史会话；这类会话不显示为 `Direct`，否则会被误读成「上游代理被绕过了」。
- JSON 树视图（Response JSON Tab）中右键节点弹出独立菜单，提供 `Copy Key`（复制字段名）和 `Copy Value`（复制字段值，字符串不带引号，对象/数组以格式化 JSON 输出）。
- 代码块视图（JSON Text、Raw、Text Body 等 Tab）中选中文字右键弹出独立菜单，提供 `Copy`（复制选中文字到剪贴板）和 `Search`（用选中文字激活搜索栏并填入搜索词）。仅当有文字选中且 `onSearchWithText` 回调存在时，`Search` 选项才显示。
- 会话树的三类节点各有一套右键菜单：叶子节点 → `SessionContextMenu`，host 节点 → `DomainContextMenu`，URL 路径目录节点 → `SessionFolderContextMenu`；三者共用同一套锚点状态，打开任一菜单会关闭另外两个。
- 「保存所有文件」的落盘范围覆盖所选节点的整个子树；WebSocket 会话、无响应体的请求，以及仅存在于渲染层的 HAR 导入会话不会落盘，计入 Snackbar 的跳过数。
- 落盘层级为去掉域名后的**完整 URL 路径**：右键 `assets` 得到 `所选目录/assets/...`。右键哪一层结果一致，同一站点多次保存到同一目录会自然合并。
- 策略对话框只在存在同名冲突时出现；每个请求都落到不同文件时直接拉起目录选择器，少一次无意义的确认。
- `Focus Host` 会把其他 Host 降低透明度；`Ignore Host` 会直接从当前列表中过滤对应 Host。
- Host 聚焦 / 忽略仅保留在当前页面内存状态，刷新页面后不会持久化。
- `Breakpoints...` 与 `Map Rules...` 当前都跳转到 `/rules`，尚未做规则页 tab 深链。
- 复制请求、复制响应、保存响应、Compose、Repeat 会在需要时按需调用 `get_session_detail`。
- `Cmd+F / Ctrl+F` 会把搜索焦点交给当前激活的 Inspector 面板。

### 4.9 后续扩展位

- ~~`SessionExplorerPane` 增加树形虚拟滚动与分组模式切换~~ **已实现（M1）**：SessionExplorer 使用 `@tanstack/react-virtual` 实现树形虚拟滚动，host → path → session 三级树被展平为一维列表，虚拟化器只渲染可见窗口内的行。行高 26px，overscan 12 行。WS Messages 面板同样使用 `@tanstack/react-virtual`，行高 42px，overscan 8 行。
- `SessionContextMenu` 补充键盘触发入口与禁用态说明
- `Focus / Ignore Host` 升级为可持久化筛选策略
- `Rules` 跳转支持按动作类型直达对应 tab
- `list_sessions` 改为实时事件推送 + 增量合并
- `get_session_detail` 按需加载 Inspector 真正内容，列表与详情解耦

### 4.10 WebSocket Messages 面板 — `已实现`

当 Inspector 检测到 WebSocket 会话（`protocol: "ws"/"wss"` 或 `responseMimeType: "websocket"`）时，Response 面板显示 **Messages** 标签页替代 Text / JSON / Raw 标签。

组件：`SessionInspectorMessagesPane`

状态模型：

```ts
interface WsMessagesPaneState {
  messages: WsMessage[];           // 全部消息
  directionFilter: "all" | "clientToServer" | "serverToClient";
  opcodeFilter: "all" | "text" | "binary" | "control";
  search: string;                  // 客户端搜索
  selectedId: string | null;       // 选中消息 ID
  connectionStatus: "active" | "closed";
  composeOpen: boolean;            // 编写面板展开状态
  composeDirection: WsMessageDirection;
  composeOpcode: "text" | "ping" | "pong";
  composePayload: string;
}
```

事件流：

1. 挂载时调用 `listWsMessages(sessionId)` 加载历史消息
2. 订阅 `onWsMessage` 事件实时追加新帧
3. 订阅 `onWsConnectionStatus` 事件更新连接状态
4. 点击 Compose 或 Replay 按钮展开编写面板
5. 发送时调用 `injectWsMessage()` 注入帧，成功后面板关闭

UI 布局：

```text
┌──────────────────────────────────────────────────────────────────┐
│ [方向 Tabs] [类型 Tabs] [搜索框]     [状态●活跃] [✉Compose]     │
├─────────────────────────┬────────────────────────────────────────┤
│ Message List            │ Message Detail                         │
│ ┌─────────────────────┐ │ ┌──────────────────────────────────┐  │
│ │ 12:30:01 text ↑ 60B │ │ │ Frame Metadata Card              │  │
│ │ 12:30:02 text ↓ 1KB▶│ │ │ direction / opcode / fin / time  │  │
│ │ 12:30:03 ping ↑   ▶│ │ ├──────────────────────────────────┤  │
│ │         ...         │ │ │ [Text] [JSON] [Hex]    [Copy]    │  │
│ └─────────────────────┘ │ ├──────────────────────────────────┤  │
│                         │ │ Payload Content                   │  │
│                         │ └──────────────────────────────────┘  │
├─────────────────────────┴────────────────────────────────────────┤
│ ▼ Compose Message（折叠/展开）                                    │
│ [Send to Server ▾] [Text ▾]                                      │
│ ┌──────────────────────────────────────────────────────────────┐ │
│ │ payload textarea                                             │ │
│ └──────────────────────────────────────────────────────────────┘ │
│                                          [Cancel] [Send]         │
└──────────────────────────────────────────────────────────────────┘
```

**虚拟滚动（M1）：** WS Messages 消息列表使用 `@tanstack/react-virtual` 渲染，常量 `MESSAGE_ROW_HEIGHT = 42`，`MESSAGE_ROW_OVERSCAN = 8`。即使消息量达到上千条，滚动仍保持流畅。

**Body 截断提示（M1）：** 当请求/响应 Body 在 20MB 处被截断时，Inspector 各面板会显示 MUI Alert 警告，提示用户 Body 已被截断。该提示文案通过 i18n 系统维护（`en.ts` / `zh-CN.ts`）。

## 5. Compose Page — `已实现`

### 5.1 页面目标

提供主动构造请求、发送请求、查看响应的完整工作台。

### 5.2 低保真线框

```text
[Compose Page]
┌──────────────────────────────────────────────────────────────────────────────┐
│ Title: Compose                                          (Send) (Export cURL) │
├──────────────────────────────────────────────────────────────────────────────┤
│ [Request Builder]                                                            │
│ <GET▼> [https://example.com/api..............]                              │
│ [Headers] [Body] [Query]                                                     │
│ Body: (none | form-data | x-www-form-urlencoded | raw)  [raw 时: 语言选择▼]   │
│       EditableKeyValueTable（键值对） / multiline TextField（raw）             │
├──────────────────────────────────────────────────────────────────────────────┤
│ [Response Preview]                                                           │
│ Status • Duration • Size                                                     │
│ <Overview> <Headers> <Body> …（复用 Sessions Inspector 响应标签集合）         │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 5.3 实际 React 组件树

```text
ComposePage
├─ PageHeader (title + description)
├─ Toolbar (Send button + Export cURL button)
├─ 垂直分栏（请求在上、响应在下，各自内部滚动）
│  ├─ SectionCard "Request Builder"
│  │  ├─ MethodSelect (GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS)
│  │  ├─ UrlInput (OutlinedInput, Enter 键触发发送)
│  │  ├─ Tabs: Headers | Body | Query
│  │  │  ├─ Headers: EditableKeyValueTable
│  │  │  ├─ Body: ToggleButtonGroup (none | form-data | x-www-form-urlencoded | raw)
│  │  │  │  ├─ none: 空态提示
│  │  │  │  ├─ form-data / x-www-form-urlencoded: EditableKeyValueTable
│  │  │  │  └─ raw: 语言 Select (Text/JSON/XML/HTML/JavaScript) + multiline TextField
│  │  │  └─ Query: EditableKeyValueTable (自动从 URL 解析)
│  └─ SectionCard "Response Preview"
│     ├─ InspectorSummaryBar (复用 Sessions Inspector 组件)
│     └─ Tabs 复用 Sessions Inspector 的响应标签集合（Overview / Headers / Body / Timing 等）
```

### 5.4 实现文件映射

| 文件 | 职责 |
|------|------|
| `pages/compose/index.tsx` | ComposePage 主页面 |
| `features/compose/use-compose-request.ts` | React Query mutation，调用 `sendComposedRequest` |
| `features/compose/compose-editor.store.ts` | Zustand store，管理 method/url/headers/body/bodyType/rawLanguage/activeTab |
| `features/compose/types.ts` | `BodyType`（none/formdata/urlencoded/raw）、`RawLanguage` 等类型 |
| `features/compose/curl-export.ts` | 纯函数 `generateCurlCommand()`，前端生成 cURL 命令 |
| `features/compose/components/ComposeRequestSection.tsx` | 请求构造区（含 body 类型切换） |
| `features/compose/components/ComposeResponseSection.tsx` | 响应预览区（复用 Inspector） |
| `features/compose/components/EditableKeyValueTable.tsx` | 可编辑键值对组件（Headers/Query/form-data 共用） |

### 5.5 页面状态模型

```ts
// Zustand store: compose-editor.store.ts
type ComposeEditorState = {
  method: string;           // 默认 "GET"
  url: string;
  headers: HeaderEntry[];
  body: string;             // raw 模式的文本内容
  bodyType: BodyType;       // "none" | "formdata" | "urlencoded" | "raw"，默认 "none"
  rawLanguage: RawLanguage; // raw 模式的语言（text/json/xml/html/javascript），默认 "json"
  formDataEntries: HeaderEntry[];        // form-data 键值对
  urlEncodedEntries: HeaderEntry[];      // x-www-form-urlencoded 键值对
  activeTab: "headers" | "body" | "query";
  setMethod / setUrl / setHeaders / setBody / setBodyType / setRawLanguage
  setFormDataEntries / setUrlEncodedEntries / setActiveTab
  loadFromSession(data)     // Repeat 按钮调用，预填数据（含 bodyType 等字段）
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

统一管理断点、改写、本地映射、远程映射与 DNS 映射规则。

### 6.2 低保真线框

```text
[Rules Page]
┌──────────────────────────────────────────────────────────────────────────────┐
│ Title: Rules                                                                │
├──────────────────────────────────────────────────────────────────────────────┤
│ <Breakpoint> <Rewrite> <Map Local> <Map Remote> <DNS>                       │
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
│  ├─ RuleTypeTabs (Breakpoint / Rewrite / Map Local / Map Remote / DNS)
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
│     └─ DnsMappingsPanel
│        ├─ ManagedRulesWorkbench
│        │  ├─ Left Pane
│        │  │  ├─ Create Rule Button
│        │  │  ├─ Rule Search Field
│        │  │  └─ ManagedRuleList
│        │  └─ Right Pane
│        │     ├─ FieldGroup "Rule Name"
│        │     ├─ FieldGroup "Host Pattern"
│        │     ├─ FieldGroup "Target IP"
│        │     └─ FieldGroup "Priority / Enabled / Note"
```

断点拦截面板（独立组件，在 AppShell 中渲染）：

```text
BreakpointInterceptPanel (在 AppShell 主内容区与状态栏之间渲染)
├─ SummaryBar (Method Chip + Stage Badge + Status / Mock Mode + Host + Path + 导航 1/N)
├─ Tabs (Request / Response)
│  ├─ Request Tab
│  │  └─ InspectorGrid
│  │     ├─ HeaderSection (标题 + 数量 + Add Header + 紧凑行编辑)
│  │     └─ BodySection (标题 + 字符数/空状态 + 固定高度编辑器)
│  └─ Response Tab
│     └─ InspectorGrid
│        ├─ HeaderSection (响应 Header 或 Mock Header)
│        └─ BodySection (响应 Body 或 Mock Body)
└─ ActionBar (左侧 Mock 模式控制，右侧 Drop / Forward 或 Send Mock)
```

### 6.3.1 实现文件映射

| 文件 | 职责 |
|------|------|
| `features/breakpoints/breakpoint.store.ts` | Zustand store，管理 pendingHits / activeHitId / rules |
| `features/breakpoints/use-breakpoint-events.ts` | 订阅 `breakpoint-hit` / `breakpoint-released` Tauri 事件的 React hook |
| `features/breakpoints/use-breakpoint-rules.ts` | React Query hooks，调用 `listBreakpointRules` / `setBreakpointRules` |
| `features/rules/use-rule-center.ts` | React Query hooks，管理 Rewrite / Mapping / Script 规则的读取、保存、删除 |
| `features/breakpoints/components/BreakpointInterceptPanel.tsx` | 断点拦截面板主组件，含 HeaderEditor、BodyEditor、Mock 编辑器、倒计时 chip |
| `pages/rules/index.tsx` | Rules 页面，规则中心工作台（Tabs + 列表 + 编辑器 + 预览） |
| `components/layout/AppShell.tsx` | 集成 BreakpointInterceptPanel 和状态栏断点计数指示器 |
| `services/events/index.ts` | `onBreakpointHit()` Tauri 事件订阅 |
| `services/commands/index.ts` | `listBreakpointRules` / `resolveBreakpoint` 以及 Rewrite / Map / Throttling 的命令与本地 fallback |

### 6.4 页面状态模型

```ts
type RulesPageState = {
  query: {
    ruleType: "breakpoint" | "rewrite" | "mapping" | "script";
    mappingMode?: "local" | "remote" | "dns";
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

**开关语义：** 断点规则行内开关即时生效；Rewrite / Mapping / DNS / Script 列表行的开关也即时保存已保存规则版本，不是 draft 开关。编辑器顶部的 Enabled 仍属于 draft，需保存后才落盘。

**脏检查：** 规则 draft 通过 `useUnsavedChangesGuard` 挂载，切换 tab、切换规则、跳路由、关窗口都要先确认丢弃修改；Collections / Throttling / Settings 相关编辑页使用同一套脏检查约定。

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
-> countdown chip shows remaining wait time
-> BreakpointInterceptPanel renders with request details
-> User edits headers/body and clicks "Forward"
-> resolveBreakpoint({ action: "forward", modifiedRequestHeaders: [...] })
-> Rust resolves oneshot channel, proxy task resumes with modifications
-> pending hit removed from store
-> if wait window expires or sender drops, "breakpoint-released" event emits and the frontend removes the hit with a warning toast

规则中心事件流：
User switches rule type
-> active workbench changes
-> left rule list + right editor both switch to the selected domain
-> user selects or creates a rule
-> editor loads the draft model
-> preview card updates immediately as the draft changes
-> save command persists the rule
-> list refreshes and keeps the saved rule selected

## 6.6 Throttling Page — `已实现 P0/P1`

### 6.6.1 页面目标

让用户能够在“快速套预设”“精确调参数”和“只影响目标接口”三条路径之间自由切换，并能从 Session 侧确认弱网是否生效。

### 6.6.2 低保真线框

```text
[Throttling Page]
┌──────────────────────────────────────────────────────────────────────────────┐
│ Runtime Status: on/off · active profile · hits · drops · total delay         │
│ [15 min enable] [Disable]                                                    │
├──────────────────────────────────────────────────────────────────────────────┤
│ [Profiles | Rules]    │ [Editor]                                             │
│                       │                                                      │
│ Profiles              │ Profile Editor                                       │
│ - Fast 4G             │ - Name / Enable after save                           │
│ - Slow 3G             │ - Latency / Packet Loss                              │
│ - Custom A            │ - Download / Upload                                  │
│                       │ - Save / Save & Apply                                │
│ Rules                 │                                                      │
│ - GET api.example     │ Rule Scope Editor                                    │
│ - * checkout *        │ - URL / Host pattern                                 │
│                       │ - Methods / Stage / Priority                         │
│                       │ - Profile / Enabled                                  │
└───────────────────────┴──────────────────────────────────────────────────────┘
```

### 6.6.3 React 组件树

```text
ThrottlingPage
├─ RuntimeStatusBar
│  ├─ ActiveProfileSummary
│  ├─ RuntimeStatsPills
│  ├─ TemporaryEnableButton
│  └─ DisableButton
├─ Main Split Layout
│  ├─ Left Pane
│  │  ├─ Mode Toggle: Profiles / Rules
│  │  ├─ Profile List
│  │  │  ├─ Preset Profiles
│  │  │  └─ Custom Profiles
│  │  └─ Rule List
│  └─ Right Pane
│     ├─ ProfileEditor
│     └─ RuleScopeEditor
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

User creates a targeted throttling rule
-> user starts from Throttling page or Session context menu
-> rule draft receives URL / host / method from the captured session when available
-> user chooses profile, stage, priority, and enabled state
-> save persists the rule
-> matching sessions record Throttling trace entries in Automation tab

**保存失败提示：** Throttling / Rules 编辑器与列表开关路径都要显式展示 mutation error，不允许只靠按钮 loading 结束来表示失败。

User wants to inspect impact
-> Sessions page can filter to throttled sessions
-> Session Automation tab shows request / response throttle traces
-> trace explains profile, optional rule, stage, delay, transfer delay, body size, and dropped outcome
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
│ (Generate) (Install Certificate) (Refresh Status) (Remove Certificate)      │
│ ── Remove Confirm Dialog；结果 Alert（success / partial+手动命令 / error）    │
├──────────────────────────────────────────────────────────────────────────────┤
│ [Installation Guide]                                                        │
│ Windows Steps | macOS Steps | Linux Steps（Linux 含 Debian 与 Fedora 两套）   │
├──────────────────────────────────────────────────────────────────────────────┤
│ [Mobile Setup Card]                                                         │
│ Local IP: [192.168.x.x ▾]     Proxy Port: 8888   （多地址时下拉可切换）        │
│ Wi-Fi Proxy: 192.168.x.x:8888                                              │
│ ┌──────────────────┐  Cert URL: http://192.168.x.x:8888/aiproxy-ca.crt     │
│ │   [QR Code]      │  (Copy Proxy Address)                                 │
│ └──────────────────┘                                                        │
│ [Verify Phone Traffic Card]（基线快照 + 实时检测新会话）                      │
│ iOS Guide | Android Guide | HarmonyOS Guide                                 │
├──────────────────────────────────────────────────────────────────────────────┤
│ [FAQ / Risk Notes]（MITM 设计说明 / 如何恢复 / 证书锁定）                     │
└──────────────────────────────────────────────────────────────────────────────┘
```

### 7.3 React 组件树

```text
CertificatesPage
├─ DesktopCertificateTab（status card + generate/install/refresh/remove）
│  ├─ DiagnosticsCard
│  ├─ ConfirmDialog（移除确认，不可逆 → 不提供「不再确认」）
│  └─ RemoveFeedbackAlert（success / partial+manualCommands / error）
├─ PlatformTrustGuide（当前平台步骤 + 展开“其他平台”）
├─ CertificateRiskNotes
├─ MobileSetupTab
│  ├─ IosQuickActionsPanel
│  ├─ AndroidQuickActionsPanel
│  ├─ HarmonyQuickActionsPanel
│  ├─ NetworkInfoPanel（Local IP 行内 Select，多地址时可切换）
│  ├─ QrCodePanel
│  ├─ MobileTrafficCheckCard（验证手机流量闭环）
│  └─ MobileDeviceGuide
└─ BottomStatusStrip
```

> 移动端设备扫描（`IosQuickActionsPanel` / `AndroidQuickActionsPanel` / `HarmonyQuickActionsPanel`）为**静默自动探测**：进入面板时立即自动发起设备/模拟器查询。各面板用 `userRefreshed` 标志区分「自动/后台探测」与「用户主动刷新」：探测失败（未安装对应工具链 Xcode simctl / adb / hdc 等）时**静默降级**——只显示中性「点击刷新设备」提示，不弹红色「设备检测失败」，避免打扰未安装工具链或无该平台抓包需求（如纯网页抓包）的用户；只有用户主动点击「刷新」后查询仍失败，才在面板内显示错误。

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
    activeMobileGuideTab: "ios" | "android" | "harmony";
    selectedIp?: string; // 多网卡时用户选择的地址，缺省取列表第一个
    removeConfirmOpen: boolean;
    removeFeedback?: { kind: "success" } | { kind: "partial"; failed: TrustRemovalFailure[]; systemProxyError?: string } | { kind: "error"; message: string };
    mobileVerify: { baselineCount: number | null; startedAtMs: number | null };
  };
  mutation: {
    generatingCertificate: boolean;
    refreshingStatus: boolean;
    removingCertificate: boolean;
  };
  data: {
    localIps?: string[];
    proxyPort?: number;
    certDownloadUrl?: string;
  };
};
```

**通知开关：** Settings 页新增 breakpoint system notifications 开关，开启时会 best-effort 请求系统权限；权限被拒绝只静默降级，不打断面板内通知链路。

## 8. Settings Page — `基础设置与代理预设已实现`

### 8.1 页面目标

集中管理应用默认设置与代理启动配置，不再提供独立 Workspaces Page。

当前已实现目标：

- 管理代理预设（端口、SSL）
- 配置上游（链式）代理
- 配置逐域名 SSL proxying / blind tunneling 策略
- 在「General」区统一管理语言、主题、界面字体、内容字体与字号偏好
- 管理危险操作确认开关（Clear All Sessions 确认可关闭并在此恢复）
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
│ [Upstream Proxy]                          (Test Connection) (Save)          │
│ Route through an upstream proxy  [ Toggle ]                                 │
│ Protocol [HTTP v]  Host [__________]  Port [_____]                          │
│ Username [__________]  Password [__________]                                │
│ Bypass List (multiline)                                                     │
│ Probe Result / No-Fallback Hint / Credential Storage Hint                   │
├──────────────────────────────────────────────────────────────────────────────┤
│ [SSL Proxying]                      (Restore Recommended) (Save)            │
│ Mode Hint (all-except-excluded / include-list)                              │
│ Include (multiline)                                                         │
│ Exclude (multiline)                                                         │
│ Pinning Hint / SSL-Disabled Hint                                            │
├──────────────────────────────────────────────────────────────────────────────┤
│ [General]  (macOS 风格分组行，Divider 分隔，控件右对齐)                       │
│ Display Language                        [Follow System v]                   │
│ ─────────────────────────────────────────────────────────────────────────── │
│ Appearance Theme                        [Follow System v]                   │
│ ─────────────────────────────────────────────────────────────────────────── │
│ Interface Font                          [System Default v]                  │
│ (custom 时追加 Custom Font 行)                                               │
│ ─────────────────────────────────────────────────────────────────────────── │
│ Content & Code Font                     [System Monospace v]                │
│ ─────────────────────────────────────────────────────────────────────────── │
│ Font Size                               [14px v]                            │
├──────────────────────────────────────────────────────────────────────────────┤
│ [Dangerous Action Confirmations]                                            │
│ Ask before clearing all sessions                    [========○]             │
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
├─ UpstreamProxySection
│  ├─ EnableToggle
│  ├─ ProtocolSelect / HostField / PortField
│  ├─ CredentialFields
│  ├─ BypassTextarea
│  ├─ TestConnectionButton
│  └─ ProbeResultAlert / NoFallbackAlert / CredentialStorageAlert
├─ SslProxyingSection
│  ├─ IncludeTextarea
│  ├─ ExcludeTextarea
│  ├─ RestoreRecommendedButton
│  └─ PinningHint / SslDisabledHint
├─ SectionCard "General"
│  └─ SettingsGroup (Divider 分隔)
│     ├─ SettingsRow LanguagePreferenceSelect
│     ├─ SettingsRow ThemePreferenceSelect
│     ├─ SettingsRow FontFamilyPreferenceSelect (+ custom 行)
│     ├─ SettingsRow ContentFontPreferenceSelect (+ custom 行)
│     └─ SettingsRow FontSizeSelect
├─ SectionCard "Dangerous Action Confirmations"
│  ├─ Description
│  └─ ClearSessionsConfirmSwitch (bound to !skipClearSessionsConfirm)
├─ SectionCard "Notifications"
│  ├─ Description
│  └─ BreakpointSystemNotificationsSwitch
```

**行组件约定：** `SettingsRow`（label/description 左、控件右，`stacked` 用于 TLS hosts 等宽输入）、`SettingsGroup`（Divider 分隔行列表）、`SettingsFooter`（hint 左、动作右）是 Settings 页统一的行级布局原语，各 Section 内部一律复用，不再手写行布局。

### 8.4 页面状态模型

```ts
type SettingsPageState = {
  presets: {
    activePresetId?: string;
    selectedPresetId?: string | null;
    isCreatingPreset: boolean;
  };
  upstreamProxy: {
    // 表单草稿；bypass 以换行分隔文本编辑，保存时解析为数组
    draft: {
      enabled: boolean;
      protocol: "http" | "https" | "socks5";
      host: string;
      port: number;
      username: string;
      password: string;
      bypassText: string;
    };
    // 一次性连通性探测结果，任何字段变更都会清空
    testResult: UpstreamProxyProbeResult | null;
    isTesting: boolean;
  };
  preferences: {
    languagePreference: "system" | "zh-CN" | "en";
    themePreference: "system" | "light" | "dark";
    skipClearSessionsConfirm: boolean; // "don't ask again" from the Clear All Sessions dialog
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

## 9.4 Upstream Proxy（上游代理）— 已实现

### 功能目标

把抓包流量转发给另一个代理，而不是直接连接目标。典型场景：手机把代理指向 AIProxy 做抓包，实际出网由本机的规则代理（Clash / Surge / mitmproxy / Charles）按分流规则完成。

### 实现位置

Settings Page（`pages/settings/index.tsx`）内的独立 `UpstreamProxySection` 组件。

### 关键设计约束

- **统一拨号**：Rust 侧三个出站点（CONNECT 盲转发、HTTP/MITM 转发、WebSocket 上游）共用 `upstream_proxy::dial_target()`，所以四类流量的路由行为完全一致。
- **不回退直连**：上游代理不可用时请求失败。静默绕过会把用户明确要求经由代理的流量泄漏出去。
- **域名交给上游解析**：默认以主机名形式把目标交给代理（SOCKS5 `ATYP=domain` / CONNECT authority），否则 Clash 的域名分流规则无法匹配。存在 DNS 覆盖时覆盖 IP 优先。
- **重启才生效**：配置在代理服务器生命周期内固定；保存时若代理正在运行会自动重启。
- **测试忽略绕行列表**：`test_upstream_proxy` 探测的是代理本身，绕行命中不应被报成「连接成功」。

### 实现文件映射

| 层级 | 文件 | 职责 |
| --- | --- | --- |
| 页面 | `pages/settings/index.tsx` — `UpstreamProxySection` | 配置表单 + 连通性测试 + 保存/重启 |
| Feature Hooks | `features/workspace-manager/use-workspaces.ts` | `useUpdateWorkspace`（`upstreamProxy` 入参） |
| 服务层 | `services/commands/workspaces.ts` | `updateWorkspace`, `testUpstreamProxy`；日志脱敏密码 |
| 共享类型 | `packages/shared-types/src/workspaces.ts` | `UpstreamProxySettings`, `UpstreamProxyProtocol`, `UpstreamProxyProbeResult` 及其校验/解析函数 |
| Rust 命令 | `src-tauri/src/commands/proxy.rs` | `test_upstream_proxy`；`start_proxy` 中解析 workspace 配置 |
| Rust 领域 | `crates/proxy-core/src/upstream_proxy.rs` | 协议握手、绕行匹配、`dial_target`、连通性探测 |
| 存储 | `crates/db/src/workspaces.rs`, `schema.rs` | `workspaces.upstream_proxy` JSON 列；`session_details.via_upstream_proxy` |
| i18n | `i18n/messages/en.ts`, `zh-CN.ts` | `upstreamProxy.*`、`inspector.request.overview.route*` 文案键 |

## 9.5 SSL Proxying（逐域名解密策略）— 已实现

### 功能目标

决定哪些域名的 TLS 需要解密。对标 Charles 的 SSL Proxying Settings。

解决的问题：拦截是全局开关时，使用证书绑定（SSL Pinning）的 App 会拒绝 AIProxy 的证书，而**握手失败会直接断开连接**——结果不是「抓不到这个 App 的包」，而是「这个 App 在开着 AIProxy 时完全不能用」。Charles 默认不解密任何域名，所以不会出现这个问题；把域名排除后走盲转发即可获得同样的效果。

### 实现位置

Settings Page（`pages/settings/index.tsx`）内的独立 `SslProxyingSection` 组件。

### 关键设计约束

- **exclude 优先于 include**：exclude 是 App 出问题时的逃生舱，不能被宽泛的 include 规则击穿。
- **默认保持历史行为**：`include` 为空 ⇒ 解密所有未被排除的域名。若默认改为白名单模式，升级后用户会突然什么都抓不到。
- **「从未配置」≠「两个空列表」**：DB 列为空串时回退到内置推荐排除表，因此已有 workspace 升级后能直接获得保护，而不必手动配置。
- **未解密仍然转发**：被排除的域名走 `tunnel_blind_relay`，与 `ssl_enabled=false` 是同一条代码路径，App 功能不受影响。
- **仅在 `ssl_enabled` 为 true 时生效**：拦截关闭时没有可缩放的范围，此时运行时策略为 `None`。
- **重启才生效**：策略在代理服务器生命周期内固定；保存时若代理正在运行会自动重启。
- **推荐列表由后端提供**：`default_ssl_proxying_exclusions` 命令返回内置列表，避免前后端各存一份而漂移。
- **握手失败按原因分级**：客户端因绑定拒绝证书记为 `debug`（预期行为，且无法通过配置解决），客户端不信任根证书记为 `warn`（用户可修复）。此前两者都会各产生一条 WARN + 一条 ERROR，把真正的问题淹没掉。

### 实现文件映射

| 层级 | 文件 | 职责 |
| --- | --- | --- |
| 页面 | `pages/settings/index.tsx` — `SslProxyingSection` | include / exclude 表单 + 恢复推荐 + 保存/重启 |
| Feature Hooks | `features/workspace-manager/use-workspaces.ts` | `useUpdateWorkspace`（`sslProxying` 入参） |
| 服务层 | `services/commands/workspaces.ts` | `updateWorkspace`, `loadDefaultSslProxyingExclusions` |
| 共享类型 | `packages/shared-types/src/workspaces.ts` | `SslProxyingSettings` 及其校验/解析函数 |
| Rust 命令 | `src-tauri/src/commands/proxy.rs` | `default_ssl_proxying_exclusions`；`start_proxy` 中解析 workspace 策略 |
| Rust 领域 | `crates/proxy-core/src/ssl_proxying.rs` | `should_intercept()`、推荐排除表 |
| Rust 领域 | `crates/proxy-core/src/host_pattern.rs` | 域名模式匹配（与上游代理绕行列表共用） |
| Rust 分流 | `crates/proxy-core/src/server.rs` | CONNECT 时按域名决定 MITM 还是盲转发 |
| 存储 | `crates/db/src/workspaces.rs`, `schema.rs` | `workspaces.ssl_proxying` JSON 列 |
| i18n | `i18n/messages/en.ts`, `zh-CN.ts` | `sslProxying.*` 文案键 |

## 8.5 Compare Page — `已实现发布硬化版`

Compare Page 是面向 AI 的会话对比工作台，用于回答“这两次请求 / 响应到底差在哪里，以及可能意味着什么”。

```text
[Compare Page]
┌──────────────────────────────────────────────────────────────────────────────┐
│ Compare                                      (Preview AI Payload) (Generate) │
├──────────────────────────────────────────────────────────────────────────────┤
│ Left Session [select........]        Right Session [select........]          │
│ [Include redacted body context in AI payload]                                │
├──────────────────────────────────────────────┬───────────────────────────────┤
│ Diff Workbench                               │ AI Summary                    │
│ ┌ Summary / Query / Headers / Body / Timing ┐│ Configure / Generate / Result │
│ │ added / removed / changed / unchanged      ││                               │
│ │ lazy Body diff / truncation warnings       ││                               │
│ └────────────────────────────────────────────┘│                               │
└──────────────────────────────────────────────┴───────────────────────────────┘
```

| 文件 | 职责 |
|------|------|
| `pages/compare/index.tsx` | ComparePage 主页面，管理会话选择、payload 预览、AI 总结（Markdown 渲染）、Body diff 按需展开和截断提示 |
| `features/session-compare/session-diff.helpers.ts` | 生成 summary / query / headers / body / timing diff；提供 lazy body diff、size guard、binary 状态和截断元数据 |
| `features/session-compare/redaction.helpers.ts` | 对 AI payload 做默认脱敏 |
| `services/commands/ai.ts` | AI settings、连接测试、diff 总结命令包装 |
| `pages/compare.test.tsx` | Compare 页面集成测试，覆盖 lazy Body diff、binary body 状态和截断展开 |

Body diff 行为：

- Compare 默认展示 Body 元数据摘要，包括 size、MIME、encoding、text availability 和 truncated 状态。
- 点击 `Compute body diff` 后才计算该 section 的 JSON path diff 或文本行级 diff，避免进入页面时解析大 body 卡顿。
- 单次 Body diff 有字符数 guard；超过 guard 时不计算详细 entries，并显示跳过原因。
- 详细 Body diff entries 有上限；被截断时 section 展示 warning，并通过 `Show all changes` 展开当前已装载 entries。
- 非文本 / binary body 明确显示 `Non-text or binary`，不再误报为未捕获 body。

事件流：

```text
Sessions 右键 Set as Compare Base
-> Sessions 右键 Compare with...
-> navigate /compare?left=<base>&right=<current>
-> ComparePage 按需加载两个 Session detail/body
-> buildSessionDiffPayload(redacted, bodyDiffMode="summary") 生成默认工作台视图
-> 用户展开 Body section 时 buildSessionDiffPayload(redacted, expandedBodySections=...)
-> 用户预览 payload 或手动 Generate Summary 时生成 bounded AI payload
-> summarize_session_diff 返回 AI 总结
```

### 9.4 页面事件流

| 用户操作 | 触发 | 结果 |
| --- | --- | --- |
| 点击列表中的预设 | `handleSelect(preset)` | 选中该预设，展开编辑区 |
| 点击 "New Preset" | `handleNew()` | 清空表单，进入新建模式 |
| 点击 "Save" (新建) | `createWorkspaceMutation.mutate()` | 调用 Rust `create_workspace` |
| 点击 "Save" (编辑) | `updateWorkspaceMutation.mutate()` | 调用 Rust `update_workspace` |
| 点击 "Apply" | `loadWorkspaceMutation.mutate()` | 切换当前活跃预设 |
| AppShell 底部状态栏预设切换 | `handleWorkspaceSwitch(id)` | 从底部状态栏打开预设列表；若代理运行中则以当前配置重启并切换到目标预设 |

## 10. Collections Page（集合页面）

### 10.1 页面结构

三栏布局：

```text
┌────────────────────────────────────────────────────────────┐
│ CollectionsPage                                             │
│ ┌─────────────┐ ┌──────────────┐ ┌──────────────────────┐ │
│ │ Collection  │ │  Item List   │ │   Item Editor        │ │
│ │   Tree      │ │   Pane       │ │   Pane               │ │
│ │             │ │              │ │                      │ │
│ │ ▸ Auth      │ │ GET Login    │ │ [URL Bar]            │ │
│ │ ▾ User      │ │ POST Create  │ │ [Request Section]    │ │
│ │   ▸ Profile │ │ GET Profile  │ │ [Response Section]   │ │
│ │   ▸ Orders  │ │              │ │                      │ │
│ │             │ │              │ │                      │ │
│ │ [+ New]     │ │ [+ Save]     │ │ [Send] [Save]        │ │
│ │             │ │              │ │                      │ │
│ │ [Env Select │ │              │ │                      │ │
│ │  ⚙ Manage]  │ │              │ │                      │ │
│ └─────────────┘ └──────────────┘ └──────────────────────┘ │
└────────────────────────────────────────────────────────────┘
```

### 10.2 组件树

```text
CollectionsPage
  ├── CollectionTreePane (左栏)
  │   ├── DndContext (PointerSensor 4px / KeyboardSensor + autoScroll)
  │   │   └── CollectionTreeNodeView (递归 folder)
  │   │       └── ItemRow (selected folder 下的请求项)
  │   ├── CreateCollectionDialog
  │   └── EnvironmentSelector + ManageButton
  ├── CollectionItemEditorPane (右栏，仅当 editor.collectionId 时显示)
  │   ├── EditorToolbar (name + save + send)
  │   ├── URLBar (method select + url input)
  │   ├── ComposeRequestSection (复用)
  │   └── ComposeResponseSection (复用)
  ├── EnvironmentManagerDialog (全局弹窗)
  │   ├── Tabs: Environments | Global Variables
  │   ├── EnvironmentList + VariableEditorTable
  │   └── GlobalVariableEditorTable
  └── Snackbar (移动失败提示)
```

### 10.3 状态模型

| 状态 | 类型 | 来源 |
| --- | --- | --- |
| `selectedCollectionId` | `string \| null` | 用户点击树节点 |
| `selectedItemId` | `string \| null` | 用户点击列表行 |
| `activeEnvironmentId` | `string \| null` | localStorage 恢复 + 用户下拉选择 |
| `editor` | Zustand store | `collection-editor.store.ts` |
| `requestTab` / `responseTab` | UI state | 用户切换标签 |
| `manageEnvDialogOpen` | UI state | 用户点击管理按钮 |
| `collapsedFolders` | `Set<string>` | 用户折叠/展开节点；spring-load 也写入 |
| `activeDnd` | `{ kind, id, sourceCollectionId? } \| null` | DnD 拖拽开始/结束 |
| `dropTarget` | `{ overDndId, position } \| null` | onDragOver 计算结果，驱动指示线渲染 |
| `moveError` | `string \| null` | 移动失败时弹出 Snackbar |

### 10.4 页面事件流

| 用户操作 | 触发 | 结果 |
| --- | --- | --- |
| 点击集合树节点 | `setSelectedCollectionId(id)` | 中栏加载该集合的请求列表 |
| 点击列表请求项 | `handleSelectItem(item)` | 右栏加载请求到编辑器 |
| 修改编辑器内容 + 点击 Send | `handleSend()` | 合并环境+全局变量 → `substituteVariables` → `sendComposedRequest` |
| 点击 Save | `handleSave()` | `upsertCollectionItem.mutate()` |
| 点击环境管理 ⚙ | `setManageEnvDialogOpen(true)` | 弹出 EnvironmentManagerDialog |
| 在弹窗中新建环境 | `upsertEnvironment.mutate()` | 环境列表刷新，自动选中新建环境 |
| 在弹窗中修改变量 | `debouncedSave` | 500ms 后自动保存到后端 |
| 在树中拖动节点 | `DndContext.onDragStart/Over/End` | `computeDropIntent` 计算 25/50/25 区域 + cycle check → `useMoveCollection` / `useMoveCollectionItem` 触发乐观更新 + IPC 调用 |
| 拖动悬停在折叠的文件夹中部 ≥500ms | spring-load timer | 自动展开该文件夹（写入 `collapsedFolders`） |

### 10.5 变量替换引擎

发送请求前，按以下优先级合并变量：

1. 全局变量（`api_global_variables`）作为基础层
2. 当前环境变量（`api_environment_variables`）覆盖同名全局变量
3. 对 URL、Headers、Body（raw）、FormData（name/value）、URL-encoded（name/value）执行 `{{key}}` → `value` 替换
4. 未匹配的 `{{key}}` 保持原样

### 10.6 实现文件映射

| 层级 | 文件 | 职责 |
| --- | --- | --- |
| 页面 | `pages/collections/index.tsx` — `CollectionsPage` | 三栏布局 + 状态管理 + DnD orchestration |
| Feature Store | `features/collections/collection-editor.store.ts` | Zustand：编辑器表单状态 |
| Feature Hooks | `features/collections/use-collections.ts` | 集合 React Query hooks（含 `useMoveCollection` 乐观更新） |
| Feature Hooks | `features/collections/use-collection-items.ts` | 请求项 React Query hooks（含 `useMoveCollectionItem` 乐观更新） |
| Feature Hooks | `features/environments/use-environments.ts` | 环境/全局变量 hooks + 替换引擎 |
| Feature Components | `features/collections/components/CollectionTreeNodeView.tsx` | 树节点（含 DnD draggable/droppable + 指示线 + 添加菜单） |
| Feature Components | `features/collections/components/ItemRow.tsx` | 请求项行（含 DnD） |
| Feature Components | `features/collections/components/dnd-helpers.ts` | `computeDropIntent` + `isFolderCycleViolation` 纯函数 |
| Feature Components | `features/environments/components/EnvironmentManagerDialog.tsx` | 环境管理弹窗 |
| Feature Components | `features/environments/components/VariableEditorTable.tsx` | 变量编辑表格（带启用开关） |
| 服务层 | `services/commands/index.ts` | Collection + Environment 命令包装（含 `moveApiCollection` / `moveApiCollectionItem`） |
| 共享类型 | `packages/shared-types/src/index.ts` | `ApiCollection`, `ApiCollectionItem`, `ApiEnvironment`, `ApiEnvironmentVariable`, `ApiGlobalVariable`, `MoveApiCollectionInput`, `MoveApiCollectionItemInput` |
| Rust DB | `crates/db/src/collections.rs` | Collection/Item CRUD + `move_collection` / `move_collection_item`（dense renumber + cycle check） |
| Rust DB | `crates/db/src/environments.rs` | Environment/Variable/Global CRUD |
| Rust 命令 | `src-tauri/src/commands/mod.rs` | `list_api_collections`, `upsert_api_collection`, `delete_api_collection`, `move_api_collection`, `list_api_collection_items`, `upsert_api_collection_item`, `delete_api_collection_item`, `move_api_collection_item`, `save_session_to_collection`, `list_api_environments`, `upsert_api_environment`, `delete_api_environment`, `list_api_environment_variables`, `set_api_environment_variables`, `list_api_global_variables`, `set_api_global_variables`, `batch_execute_collection_items` |
| i18n | `i18n/messages/en.ts`, `zh-CN.ts` | `collectionsPage.*` 文案键 |

## 10.7 Insights Page — `已实现首版`

### 10.7.1 页面目标

提供流量统计分析面板，基于已捕获会话的聚合数据展示概览、Host 维度分析、分布图和慢请求排名。

### 10.7.2 低保真线框

```text
[Insights Page]
┌──────────────────────────────────────────────────────────────────────────────┐
│ Title: Insights                                                               │
├──────────────────────────────────────────────────────────────────────────────┤
│ [Overview Cards]                                                             │
│ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐ ┌─────────────┐            │
│ │ Total       │ │ Avg         │ │ Error       │ │ Total       │            │
│ │ Requests    │ │ Duration    │ │ Rate        │ │ Size        │            │
│ │ 1,234       │ │ 234 ms      │ │ 2.3%        │ │ 12.4 MB     │            │
│ └─────────────┘ └─────────────┘ └─────────────┘ └─────────────┘            │
├──────────────────────────────────────────────────────────────────────────────┤
│ [Host Breakdown Table]                                                       │
│ Host         │ Requests │ Avg (ms) │ P95 (ms) │ Size     │ Errors          │
│ api.exam.com │ 456      │ 123      │ 340      │ 5.2 MB   │ 2               │
│ cdn.exam.com │ 312      │ 45       │ 89       │ 3.1 MB   │ 0               │
│ ...                                                                          │
├──────────────────────────────────────────────────────────────────────────────┤
│ [Distributions]              │ [Slow Requests]                               │
│ Status Codes                 │ 1. GET api.example.com/users  2.3s           │
│ ┌────┐ ┌────┐ ┌────┐       │ 2. POST api.example.com/data 1.8s           │
│ │2xx │ │4xx │ │5xx │       │ 3. GET cdn.example.com/img   1.2s           │
│ │980 │ │ 30 │ │  4 │       │ ...                                           │
│ └────┘ └────┘ └────┘       │                                               │
│ Methods                      │                                               │
│ GET: 800  POST: 300  ...    │                                               │
└──────────────────────────────┴───────────────────────────────────────────────┘
```

### 10.7.3 React 组件树

```text
InsightsPage
├─ PageHeader (title)
├─ OverviewCardsSection
│  ├─ OverviewCard (Total Requests)
│  ├─ OverviewCard (Avg Duration)
│  ├─ OverviewCard (Error Rate)
│  └─ OverviewCard (Total Size)
├─ HostBreakdownTable
│  ├─ TableHead (Host / Requests / Avg / P95 / Size / Errors)
│  └─ TableBody (HostInsight rows, sortable columns)
├─ Bottom Split Layout
│  ├─ DistributionSection
│  │  ├─ StatusCodeDistribution (chips or mini bars)
│  │  └─ MethodDistribution (chips or mini bars)
│  └─ SlowRequestsSection (仅在有过滤时渲染，见 10.7.6)
│     └─ SlowRequestList (ranked list with method/host/path/duration)
```

### 10.7.4 实现文件映射

| 文件 | 职责 |
|------|------|
| `pages/insights/index.tsx` | InsightsPage 主页面，组合概览卡片、Host 表格、分布和慢请求 |
| `features/insights/use-insights.ts` | React Query hook，调用 `getInsights` |
| `services/commands/insights.ts` | `getInsights` 命令包装 |
| `crates/db/src/insights.rs` | `compute_insights()` SQLite 聚合查询实现 |

### 10.7.5 页面状态模型

```ts
type InsightsPageState = {
  query: {
    insightsLoading: boolean;
  };
  ui: {
    hostSortField: "requestCount" | "avgDurationMs" | "p95DurationMs" | "totalSizeBytes" | "errorCount";
    hostSortOrder: "asc" | "desc";
  };
};
```

### 10.7.6 页面事件流

```text
User navigates to /insights
-> InsightsPage mounts
-> useInsights({ workspaceId }) triggers get_insights
-> Rust compute_insights() queries SQLite
-> InsightsResult returns to frontend
-> OverviewCardsSection renders summary metrics
-> HostBreakdownTable renders per-host breakdown
-> DistributionSection renders status code and method distributions
-> SlowRequestsSection renders slowest requests list (only when a domain/host
   filter is active; with no filter the section is hidden and HostBreakdownTable
   flexes to fill the remaining space with its own scroll + sticky head)

User clicks Export dropdown
-> menu opens with Markdown / JSON options
-> selected export function generates content
-> save_text_file writes to Downloads directory
-> Snackbar confirms export success
```

## 11. 页面与模块映射

| 页面 | 主 Feature 模块 | 主要命令/接口 |
| --- | --- | --- |
| Sessions | `session-list`, `session-detail`, `proxy-status` | `start_proxy`, `stop_proxy`, `list_sessions`, `enable_system_proxy`, `disable_system_proxy` |
| Compose | `compose-request` | `send_composed_request` (已实现)，`repeat_session` (前端 Repeat 按钮替代) |
| Collections | `collections`, `environments` | `list_api_collections`, `upsert_api_collection`, `delete_api_collection`, `list_api_collection_items`, `upsert_api_collection_item`, `delete_api_collection_item`, `save_session_to_collection`, `list_api_environments`, `upsert_api_environment`, `delete_api_environment`, `list_api_environment_variables`, `set_api_environment_variables`, `list_api_global_variables`, `set_api_global_variables`, `batch_execute_collection_items` |
| Compare | `session-compare`, `ai` | `get_ai_settings`, `save_ai_settings`, `test_ai_connection`, `summarize_session_diff` |
| Rules | `breakpoints` (已实现), `rewrite-rules`, `map-rules`, `dns-mappings` (已实现) | `list_breakpoint_rules` (已实现), `set_breakpoint_rules` (已实现), `resolve_breakpoint` (已实现), `list_dns_mappings` (已实现), `save_dns_mapping` (已实现) |
| Certificates | `certificate-center` | `get_certificate_status`, `generate_root_certificate`, `get_local_ip` |
| Settings | `settings`, `workspace-manager` | settings service / local config + Proxy Presets section；`list_workspaces` (已实现), `create_workspace` (已实现), `load_workspace` (已实现), `update_workspace` (已实现), `test_upstream_proxy` (已实现) |
| Insights | `insights` | `get_insights` (已实现) |

## 12. 实现建议

- 先按页面蓝图搭稳定的 `layout + feature + shared component` 骨架
- 页面级状态与服务调用放入 `features/*`
- 页面容器只负责拼装，不承载复杂业务逻辑
- 所有分栏页优先实现拖拽宽度记忆和空状态统一策略

## 13. Setup Wizard & Setup Checklist — 首启引导

### 12.1 目标

让首次安装的新用户能走通"生成根证书 → 安装并信任 → 启动代理 → 开启系统代理/手动配置 → 抓到第一条 HTTPS 流量"。完成口径以 `captureReady` 为准(而非仅"证书已信任")。

### 12.2 状态模型(纯函数 `computeSetupProgress`)

派生自 `useCertificateStatus()` + `useProxyStatus()` + 持久化的 `manualProxyAcknowledgedFor`,无新增后端状态源:

```ts
httpsReady        = certGenerated && certTrusted;
manualProxyStillValid = ack.port === proxyStatus.port && ack.workspaceId === activeWorkspaceId;
proxySatisfied    = proxyRunning && (systemProxyOn || manualProxyStillValid);
captureReady      = httpsReady && proxySatisfied;
nextAction        = [certGenerated, certTrusted, proxyRunning, systemProxyOrManual] 中首个未完成项;
```

持久化字段(`app-preferences.store`,key `aiproxy.app-preferences`):`setupWizardCompleted`、`setupWizardDismissedAt`、`manualProxyAcknowledgedFor`(带 port+workspace 上下文,变化即失效)。

### 12.3 门控逻辑(`shouldShowSetupWizard`)

- 弹模态向导 iff `!completed && !dismissedAt && !captureReady`。
- 跳过 → 只写 `dismissedAt`,不再强弹;未完成项改由常驻清单承接。
- 完成 → `captureReady` 为真时写 `completed`。
- 回退(证书被删/代理停)→ `captureReady` 退回 false 时**不**重弹模态,由常驻清单指引自救。
- 常驻清单显示 iff `!captureReady`(与 dismiss/complete 无关)。

### 12.4 组件与文件映射

- 向导:`features/setup-wizard/SetupWizard.tsx`(常驻挂载于 AppShell,自管 open)+ `SetupWizardSteps.tsx`(9 步:欢迎/生成/安装/验证信任轮询/启动代理/SSL 解密/系统代理·手动/首条 HTTPS 流量检测/完成)+ `use-setup-wizard.ts`。
- 常驻清单:`components/shared/SetupChecklistCard.tsx`,挂载于 Sessions 页顶部;主按钮随 `nextAction` 动态化("启动代理"步骤→"启动代理"按钮,调用 `useStartProxy`),端口占用时 inline Alert + "更改端口";「打开设置向导」按钮调用 `resetSetupWizardState`——该 action **只重置** `setupWizardCompleted`/`setupWizardDismissedAt`,**不清** `manualProxyAcknowledgedFor`(手动代理用户的确认必须保留)。
- 端口占用状态:`features/proxy-status/proxy-start.store.ts`(非持久 Zustand),`useStartProxy` 在端口占用失败时写入、成功时清除;`requestOpenPortDialog` 为一次性信号,桥接清单卡(Outlet 外)到 `useProxyLifecycle` 拥有的端口对话框;判断/取值用 `features/proxy-status/proxy-start.helpers.ts`(`isPortInUseError`/`readPortFromError`)。
- 端口占用进程管理:`apps/desktop/src-tauri/src/port_manager/`(跨平台 `#[cfg]`:Unix `lsof`+`kill -9` / Windows `netstat`+`taskkill`,零新依赖),command `get_port_occupant` / `kill_proxy_port_process`(`src-tauri/src/commands/port_manager.rs`);前端 `services/commands/port-manager.ts`。`PortOccupant` / `KillPortProcessInput` / `parsePortOccupant` 契约在 `packages/shared-types/src/proxy.ts`。kill 前 re-verify PID 防 TOCTOU(`PROCESS_CHANGED`)。
- 错误闭环:`components/shared/CertificateErrorGuidance.tsx`(消费 `error-guidance.ts` 分类;`onOpenGuide` 回调由向导航航到 `/docs?doc=certificate-setup&anchor=<错误类锚点>`);routing 步在 Linux 且未满足代理路由时显示 info Alert 预告"仅 GNOME/KDE 支持自动接管,失败请改手动配置"。
- 代理启动默认值:`features/proxy-status/use-proxy-start-defaults.ts`(AppShell 与向导共用)。
- 移动端 preflight:`features/certificate-center/mobile-preflight.helpers.ts`,门控 `MobileSetupTab`。

### 12.5 事件流

- 各步动作调用既有 mutation(`useGenerateRootCertificate`/`useLaunchCertificateInstaller`/`useStartProxy`/`useEnableSystemProxy`),成功推进、失败经 `CertificateErrorGuidance` 渲染页面级指引;指引中的「打开排障指南」按错误类深链到应用内 Docs 页对应锚点(见 §13)。
- 验证信任步轮询 `useCertificateStatus().trusted`(2s);首条流量步复用 `useSessions()` + `session-upsert` 事件检测首条会话。
- 启动代理失败:端口占用经 `proxy-start.store` 汇聚;auto-start 弹端口对话框、清单卡 inline 提示(二者不重复,模态在前、关闭后清单卡承接);其他启动失败 auto-start 走全局 snackbar、引导链路内走页面级 `CertificateErrorGuidance`。
- 结束占用进程并重启:端口对话框(占用场景,标题「解决端口冲突」+ `Divider` 两路径)查 `get_port_occupant` 展示 `进程名 · PID` → MUI 二次确认 → `kill_proxy_port_process`(后端 re-verify PID 防 TOCTOU,失败含 `PROCESS_CHANGED`)→ 用 `retryWhilePortInUse`(`proxy-start.helpers`)带退避重试 `start_proxy`(SIGKILL 异步、端口释放有 race,默认 5 次 × 300ms)→ 成功则关对话框 + `clearPortInUse`;失败关确认窗回端口对话框、走 snackbar 并重查占用者。
- 命令层 `reportCommandFailure` 仅记日志;全局 snackbar 与页面级 Alert 不重复表达(引导链路内以页面级为权威)。

## 14. Docs Page — 应用内文档查看器 `已实现`

入口：Help → AIProxy 文档（macOS 原生菜单与 Windows/Linux 自定义菜单收敛到同一 `case "documentation" → navigate("/docs")`）。把 `apps/desktop/user-guides/` 的用户指南在构建时打包进应用，离线浏览，不进入左侧主导航。

### 13.1 页面目标

- 离线提供覆盖主要功能的用户指南，按四组组织（快速上手 / 抓包与检视 / 规则与改写 / 进阶），含证书安装、会话检视、DNS 映射、WebSocket、Rewrite、脚本、限速、断点、映射（本地/远程）、集合与环境变量、Compose、Insights、会话对比、设置等，无需维护独立文档站。
- 文档源单一：`apps/desktop/user-guides/*.md` 是应用内置指南的事实源，经 Vite `@docs` 别名 + `import.meta.glob ?raw` eager 内联进前端 bundle。

### 13.2 低保真线框

```text
┌─────────────────────────────────────────────────┐
│ 📖 文档 / 离线浏览 AIProxy 用户指南             │
├──────────────┬──────────────────────────────────┤
│ 目录          │ <当前指南 Markdown 正文>          │
│ ▸ 快速上手    │ # H1                             │
│ ▾ 抓包与检视  │ 正文 / 列表 / 代码块 / 表格       │
│ ▸ 规则与改写  │                                  │
│ ▸ 进阶        │                                  │
└──────────────┴──────────────────────────────────┘
```

窄屏（`< md`）：左侧目录收起为顶部 `Select`（`ListSubheader` 分组）。

### 13.3 组件树

- `DocsPage`（`pages/docs/index.tsx`）
  - 页面标题区（icon + `docsPage.title` / `docsPage.subtitle`）
  - 窄屏 `FormControl` / `Select`（`ListSubheader` 分组，`flatMap` 扁平 children）
  - 两栏 `Box`（grid `260px minmax(0,1fr)`）
    - 侧栏 `Paper` + `List` / `ListSubheader` / `ListItemButton`
    - 正文 `Paper`（独立 `overflowY: auto`）+ `MarkdownRenderer`（`density="comfortable"`）

### 13.4 文件映射

- 页面：`pages/docs/index.tsx`、`pages/docs/index.test.tsx`
- 文档加载：`features/docs/docs-content.ts`（两个 `import.meta.glob("@docs/{en,zh-CN}/*.md", ?raw, eager)`，各按 basename 归一化 slug，导出 `getDocContent(slug, locale)` 与按 locale 的 slug 列表）
- 元数据清单：`features/docs/docs-manifest.ts`（`slug` / `titleKey` / `group` / `order`，标题与分组走 i18n；正文按 locale 取，两种语言 1:1，由 `docs-navigation.test.ts` 的 bilingual parity 用例锁死）
- 导航纯函数：`features/docs/docs-navigation.ts`（`groupDocsEntries` / `resolveInitialSlug` / `resolveDocLink`）+ `.test.ts`
- 共享渲染：`components/shared/MarkdownRenderer.tsx`（compact / comfortable，链接分派）

### 13.5 状态模型

- `activeSlug`：由 URL `?doc=` 派生，`resolveInitialSlug` 在缺失/未知时回退到清单第一项。
- 锚点深链：`?anchor=<id>`（如设置向导错误指引跳 `/docs?doc=certificate-setup&anchor=port-in-use`）。规范化回填 `?doc=` 时保留 `anchor`；文章渲染后按 `document.getElementById(anchor)` `scrollIntoView`（重试若干动画帧，markdown 虽同步渲染但需等元素进 DOM）；有 anchor 时跳过滚动复位。
- 切换文档：`setSearchParams({ doc: slug })`（同时清掉 anchor）；URL 缺失/无效时用 `replace` 回填规范化 slug。
- 正文滚动复位：`viewportRef.scrollTo({ top: 0 })`（依赖 `activeSlug` + `locale`，切文档或切语言都回到顶部；带 anchor 的深链跳过复位，由锚点滚动接管）。
- 正文按当前 `locale`（来自 `useI18n`）取；`MarkdownRenderer` 用 `key={activeSlug + locale}` 强制 remount，避免切语言时旧标题/锚点残留。

### 13.6 数据流

- 构建期：Vite 把 `apps/desktop/user-guides/{en,zh-CN}/*.md` 作为 raw 字符串内联；`docs-content.ts` 按 locale 分桶、各按 basename 归一化为 `slug → content`，两种语言必须 1:1 同名 slug（parity 测试强制）。
- 运行期：`DocsPage` 据 `activeSlug` + 当前 `locale` 调 `getDocContent(slug, locale)` 取对应语言正文（精确取，不回退），交 `MarkdownRenderer` 渲染；`MarkdownRenderer` 经 `resolveInternalLink`（`DocsPage` 注入 `resolveDocLink`）把 `*.md` 相对引用归一化为 slug → `onInternalLink` 站内切换（按当前 locale 重载）；`http(s)` 经 `onExternalLink`（`@tauri-apps/plugin-opener` 的 `openUrl`）交系统浏览器；`#anchor` 走默认行为。

## Sessions UX Constraints

- The host tree in `Session Explorer` must stay collapsed by default.
- A host group expands only after explicit user interaction on that host row.
- The Inspector must not auto-select and render an arbitrary request while every host group is collapsed.

## 菜单 locale 同步事件流

触发：`useAppPreferencesStore.languagePreference` 变更，或 `system` 偏好下系统语言变化（`navigator.languagechange`）。

```text
languagePreference/locale 变化
  → AppProviders useEffect([languagePreference, locale])
  → setMenuLocale(preference)            // 前端 service，fire-and-forget
  → invoke("set_menu_locale", { preference })
  → menu::apply_locale
      ├─ save_menu_locale(preference)     // 持久化 menu-locale.json
      ├─ rust_i18n::set_locale(resolved)  // 解析 system via sys-locale
      └─ build_menu(app)                  // macOS 重建（t! 读全局 locale）
```

冷启动：`main.rs setup()` → `load_menu_locale()` → `apply_locale`（同上，无需前端参与）。
