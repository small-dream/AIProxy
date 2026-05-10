# AIProxy API Specification

## 1. 文档信息

- 产品代号：`AIProxy`
- 文档类型：接口规范文档
- 当前阶段：`Phase 1 / 初始化设计`
- 文档状态：`Draft v1.0`
- 关联文档：
  - `docs/PRD.md`
  - `docs/ARCHITECTURE.md`

## 2. 设计原则

AIProxy 为桌面端应用，不采用传统远程 HTTP API 作为主交互形式，而采用以下双通道接口模型：

- **命令式接口（Commands）**：前端通过 Tauri Command 调用 Rust 领域服务，完成明确动作
- **事件式接口（Events）**：Rust 持续向前端推送代理状态、抓包会话、断点状态等实时事件

该设计的目标是：

- 适合桌面本地应用场景
- 降低前后端通信复杂度
- 保持强类型契约，便于 AI 与人工协作维护
- 支持高频实时数据流而不阻塞 UI

## 3. 接口分层

### 3.1 Command Layer

用于：

- 启动 / 停止代理
- 查询状态
- 管理代理预设（接口兼容保留 workspace 命名）
- 增删改查规则
- 查询与导出会话
- 构造并发送请求

### 3.2 Event Layer

用于：

- 代理状态变化
- 会话创建 / 更新
- 断点暂停
- 证书状态变化
- 规则命中反馈
- 导出进度

## 4. 通用约定

## 4.1 命名规范

- Command 使用 `snake_case`
- Event 使用 `domain/action` 风格
- 前端内部 TypeScript 类型使用 `PascalCase`
- Rust DTO 使用 `CamelCase` 序列化为 JSON

## 4.2 错误模型

所有命令失败时，统一返回标准错误对象。

```ts
type AppError = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};
```

错误码建议：

- `INVALID_INPUT`
- `NOT_FOUND`
- `PORT_IN_USE`
- `PROXY_NOT_RUNNING`
- `CERTIFICATE_NOT_TRUSTED`
- `RULE_CONFLICT`
- `EXPORT_FAILED`
- `INTERNAL_ERROR`

## 4.3 时间与 ID 规范

- 时间统一使用 `ISO 8601`
- 主键推荐 `UUID v7`
- 布尔字段使用显式 `true / false`
- JSON 字段保持结构稳定，不使用动态键名承载核心字段

## 5. 共享数据模型

## 5.1 Workspace（当前作为 Proxy Preset 模型）

```ts
type Workspace = {
  id: string;
  name: string;
  proxyPort: number;
  sslEnabled: boolean;
  systemProxyEnabled: boolean;
  storagePath: string;
  createdAt: string;
  updatedAt: string;
};
```

说明：

- 用户可见概念已统一为 Settings 中的 `Proxy Preset`
- 接口与存储层暂保留 `Workspace` / `workspaceId` 命名以兼容现有实现

## 5.2 ProxyStatus

```ts
type ProxyStatus = {
  running: boolean;
  port: number;
  sslEnabled: boolean;
  systemProxyEnabled: boolean;
  activeWorkspaceId?: string; // 当前激活代理预设 ID，字段名保持兼容
  startedAt?: string;
};
```

## 5.3 SessionSummary

```ts
type SessionSummary = {
  id: string;
  workspaceId: string;
  protocol: "http" | "https" | "ws" | "wss";
  method: string;
  host: string;
  path: string;
  url: string;
  statusCode?: number;
  durationMs?: number;
  sizeBytes?: number;
  startedAt: string;
  finishedAt?: string;
  pinned: boolean;
  tags: string[];
};
```

## 5.4 SessionDetail

```ts
type HeaderEntry = {
  name: string;
  value: string;
};

type BodyReference = {
  inlineText?: string;
  base64Text?: string;
  fileRef?: string;
  mimeType?: string;
  encoding?: string;
  truncated?: boolean;
  sizeBytes: number;
};

type TimingBreakdown = {
  dnsMs?: number;
  connectMs?: number;
  tlsMs?: number;
  requestSendMs?: number;
  waitingMs?: number;
  responseReadMs?: number;
  totalMs?: number;
};

type SessionDetail = {
  id: string;
  summary: SessionSummary;
  requestHeaders: HeaderEntry[];
  responseHeaders: HeaderEntry[];
  requestBody?: BodyReference;
  responseBody?: BodyReference;
  queryParams: HeaderEntry[];
  cookies: HeaderEntry[];
  timing?: TimingBreakdown;
  rawRequest?: string;
  rawResponse?: string;
  clientIp?: string;
  serverIp?: string;
  notes?: string;
};
```

## 5.5 Rule Models — `BreakpointRule 已实现`

```ts
// BreakpointRule — 已实现的运行时模型
type BreakpointStage = "request" | "response";

type BreakpointActionKind = "forward" | "drop" | "mock";

type BreakpointRule = {
  id: string;
  enabled: boolean;
  urlPattern: string;       // 子串匹配，空或 "*" 匹配所有
  methods: string[];         // 空 = 所有方法
  stage: BreakpointStage;
};

type MockResponse = {
  statusCode: number;
  headers: HeaderEntry[];
  bodyBase64?: string;
};

type BreakpointHit = {
  sessionId: string;
  stage: BreakpointStage;
  method: string;
  url: string;
  host: string;
  path: string;
  requestHeaders: HeaderEntry[];
  requestBody?: BodyReference;
  responseStatusCode?: number;
  responseHeaders?: HeaderEntry[];
  responseBody?: BodyReference;
};

type BreakpointResolution = {
  sessionId: string;
  action: BreakpointActionKind;
  mock?: MockResponse;
  modifiedRequestHeaders?: HeaderEntry[];
  modifiedRequestBodyBase64?: string;
  modifiedResponseHeaders?: HeaderEntry[];
  modifiedResponseBodyBase64?: string;
};

type RuleMatchStage = "request" | "response" | "either";

type RuleMatch = {
  urlPattern: string;
  methods: string[];
  stage: RuleMatchStage;
};

type RewriteRuleType = "header" | "query" | "body" | "redirect";
type RewriteTarget = "request" | "response";

type RewriteHeaderPayload = {
  headerName: string;
  operation: "set" | "remove";
  target: RewriteTarget;
  value?: string;
};

type RewriteQueryPayload = {
  operation: "set" | "remove";
  paramName: string;
  value?: string;
};

type RewriteBodyPayload = {
  contentType: string;
  target: RewriteTarget;
  text: string;
};

type RewriteRedirectPayload = {
  preservePath: boolean;
  preserveQuery: boolean;
  targetUrl: string;
};

type RewriteRule = {
  id: string;
  workspaceId: string;
  name: string;
  note?: string;
  enabled: boolean;
  match: RuleMatch;
  priority: number;
} & (
  | { rewriteType: "header"; payload: RewriteHeaderPayload }
  | { rewriteType: "query"; payload: RewriteQueryPayload }
  | { rewriteType: "body"; payload: RewriteBodyPayload }
  | { rewriteType: "redirect"; payload: RewriteRedirectPayload }
);

type RewriteRunEntry = {
  after?: string;
  before?: string;
  kind: "header" | "query" | "body" | "redirect" | "skip" | "error";
  key?: string;
  message?: string;
  sequence: number;
};

type RewriteSessionTrace = {
  durationMs: number;
  entries: RewriteRunEntry[];
  outcome: "success" | "skipped" | "failed";
  rewriteType: RewriteRuleType;
  ruleId: string;
  ruleName: string;
  stage: "request" | "response";
};

type MapRule = {
  id: string;
  workspaceId: string;
  mode: "local" | "remote";
  sourcePattern: string;
  targetValue: string;
  enabled: boolean;
  priority: number;
};
```

## 5.6 ThrottleProfile

```ts
type ThrottleProfile = {
  id: string;
  workspaceId: string;
  name: string;
  latencyMs: number;
  uploadKbps: number;
  downloadKbps: number;
  packetLossRatio: number;
  enabled: boolean;
};
```

## 5.7 DnsMappingRule

```ts
type DnsMappingRule = {
  id: string;
  workspaceId: string;
  name: string;
  note?: string;
  enabled: boolean;
  priority: number;
  hostPattern: string;  // "*.example.com"
  targetIp: string;     // "192.168.1.100"
};
```

## 6. Command Specification

## 6.1 Proxy Commands

### `start_proxy`

用途：

- 启动本地代理服务
- 代理默认绑定到 `0.0.0.0`（所有网络接口），支持局域网内手机等设备连接
- 当 `enableSsl` 为 `true` 时，代理同时提供根证书下载端点 `GET /aiproxy-ca.crt`

请求：

```ts
type StartProxyInput = {
  workspaceId: string; // 当前激活代理预设 ID
  port?: number;
  enableSsl?: boolean;
};
```

响应：

```ts
type StartProxyOutput = ProxyStatus;
```

失败场景：

- 端口被占用
- 代理预设不存在（底层错误仍可能表现为 workspace 不存在）
- 代理启动失败

### `stop_proxy`

请求：

```ts
type StopProxyInput = {
  workspaceId: string;
};
```

响应：

```ts
type StopProxyOutput = {
  success: boolean;
};
```

### `get_proxy_status`

请求：

```ts
type GetProxyStatusInput = {
  workspaceId?: string;
};
```

响应：

```ts
type GetProxyStatusOutput = ProxyStatus;
```

### `list_sessions`

用途：

- 返回当前应用内存中的已捕获会话列表

请求：

```ts
type ListSessionsInput = Record<string, never>;
```

响应：

```ts
type SessionSummary = {
  id: string;
  method: string;
  host: string;
  path: string;
  protocol: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  sizeBytes: number;
  statusCode: number;
  url: string;
};

type ListSessionsOutput = SessionSummary[];
```

### `enable_system_proxy`

请求：

```ts
type EnableSystemProxyInput = Record<string, never>;
```

响应：

```ts
type EnableSystemProxyOutput = ProxyStatus;
```

### `disable_system_proxy`

请求：

```ts
type DisableSystemProxyInput = Record<string, never>;
```

响应：

```ts
type DisableSystemProxyOutput = ProxyStatus;
```

## 6.2 Proxy Preset Commands（兼容 workspace 命名）— 已实现

这些命令当前由 `Settings` 页中的 `Proxy Presets` 区块调用。

### `list_workspaces` — 已实现

响应：

```ts
type ListWorkspacesOutput = Workspace[];
```

### `create_workspace` — 已实现

请求：

```ts
type CreateWorkspaceInput = {
  name: string;
  proxyPort: number;
  sslEnabled?: boolean;
};
```

响应：

```ts
type CreateWorkspaceOutput = Workspace;
```

### `load_workspace` — 已实现

请求：

```ts
type LoadWorkspaceInput = {
  workspaceId: string;
};
```

响应：

```ts
type LoadWorkspaceOutput = Workspace;
```

### `update_workspace` — 已实现

请求：

```ts
type UpdateWorkspaceInput = {
  workspaceId: string;
  name?: string;
  proxyPort?: number;
  sslEnabled?: boolean;
};
```

响应：

```ts
type UpdateWorkspaceOutput = Workspace;
```

## 6.3 Session Commands

### `list_sessions`

请求：

```ts
type SessionFilter = {
  keyword?: string;
  host?: string;
  method?: string;
  statusCode?: number;
  protocol?: "http" | "https" | "ws" | "wss";
  pinnedOnly?: boolean;
};

type ListSessionsInput = {
  workspaceId: string;
  filter?: SessionFilter;
  limit?: number;
  cursor?: string;
};
```

响应：

```ts
type ListSessionsOutput = {
  items: SessionSummary[];
  nextCursor?: string;
};
```

### `get_session_detail`

请求：

```ts
type GetSessionDetailInput = {
  sessionId: string;
};
```

响应：

```ts
type GetSessionDetailOutput = SessionDetail;
```

当前阶段约束：

- 仅对已捕获的明文 `HTTP` 会话返回完整详情
- `requestHeaders` 与 `responseHeaders` 返回真实抓包头信息
- `requestBody` 与 `responseBody` 优先返回 `inlineText`，非 UTF-8 内容回退到 `base64Text`
- `timing` 当前优先提供：
  - `requestSendMs`
  - `waitingMs`
  - `responseReadMs`
  - `totalMs`
- `dnsMs / connectMs / tlsMs` 预留，待更细粒度链路采样后补齐

### `clear_sessions`

请求：

```ts
type ClearSessionsInput = {
  workspaceId: string;
};
```

响应：

```ts
type ClearSessionsOutput = {
  deletedCount: number;
};
```

### `pin_session`

请求：

```ts
type PinSessionInput = {
  sessionId: string;
  pinned: boolean;
};
```

响应：

```ts
type PinSessionOutput = {
  success: boolean;
};
```

## 6.4 Compose / Repeat Commands — `已实现`

### `send_composed_request` — `已实现`

请求：

```ts
type SendComposedRequestInput = {
  workspaceId: string;
  method: string;
  url: string;
  headers: HeaderEntry[];
  body?: string;
};
```

响应（直接返回完整的 `ProxySessionDetail`，避免二次 IPC 调用）：

```ts
// 返回 ProxySessionDetail（即 SessionDetail 的 Rust 镜像）
// 包含完整的 summary、requestHeaders、responseHeaders、requestBody、responseBody、timing 等字段
// 同时该 session 会自动插入到 AppState 的 session 列表中，出现在 Sessions 页面
type SendComposedRequestOutput = ProxySessionDetail;
```

实现说明：
- Rust 端使用 `proxy-core::send_direct_request()` 发送请求，复用 `reqwest::Client`
- 返回的 `ProxySessionDetail` 与代理捕获的会话结构完全一致，前端 Inspector 组件可零修改复用
- 组合请求会自动出现在 Sessions 页面的会话列表中
- Timing 仅包含 `totalMs`、`waitingMs`、`responseReadMs`，其余字段为 `None`（reqwest 不暴露 DNS/Connect/TLS 粒度）
- 前端使用 Zustand store（`compose-editor.store.ts`）管理编辑器状态，支持从 Sessions 页面的 "Repeat" 按钮预填数据

### `repeat_session` — `暂未实现，使用前端 Repeat 按钮替代`

> 当前 Repeat 功能通过前端状态预填实现：点击 Inspector 摘要栏的 "Repeat" 按钮后，
> 将选中会话的 method/url/headers/body 写入 Zustand store，然后导航至 `/compose` 页面。
> 后端 `repeat_session` 命令保留在 API 规范中供未来实现。

请求：

```ts
type RepeatSessionInput = {
  sessionId: string;
  overrideHeaders?: HeaderEntry[];
  overrideBody?: string;
};
```

响应：

```ts
type RepeatSessionOutput = {
  newSessionId: string;
};
```

## 6.5 WebSocket Commands — `已实现`

### `list_ws_messages` — `已实现`

获取指定 WebSocket 会话的消息帧列表，按时间升序排列，支持分页。

请求：

```ts
type ListWsMessagesInput = {
  sessionId: string;
  limit?: number;   // 默认 500
  offset?: number;  // 默认 0
};
```

响应：

```ts
type WsMessage = {
  id: string;
  sessionId: string;
  direction: "clientToServer" | "serverToClient";
  timestamp: string;          // RFC 3339
  opcode: "text" | "binary" | "close" | "ping" | "pong" | "continuation";
  payloadText?: string;       // 仅文本帧有值
  payloadSize: number;
  fin: boolean;
};
```

实现说明：
- 消息存储在 SQLite `ws_messages` 表中，通过 `session_id` 关联父会话
- WebSocket 会话通过 `protocol: "ws" | "wss"` 或 `responseMimeType: "websocket"` 识别
- 消息帧在代理实时中继时同步写入数据库并推送 `ws-message` 事件

### `get_ws_connection_status` — `已实现`

查询指定 WebSocket 会话的连接状态（活跃 / 已关闭）。

请求：

```ts
type GetWsConnectionStatusInput = {
  sessionId: string;
};
```

响应：

```ts
type WsConnectionStatusOutput = {
  status: "active" | "closed";
};
```

实现说明：
- `proxy-core` 维护全局 `WsConnectionRegistry`，在 WebSocket 升级时注册，中继结束时标记关闭并注销
- 前端可在 Messages 面板据此显示连接状态指示器并控制 Compose 按钮的可用性

### `inject_ws_message` — `已实现`

向活跃的 WebSocket 连接注入（重放）一帧消息。注入的帧会正常转发并通过 `ws-message` 事件出现在消息列表中。

请求：

```ts
type WsInjectInput = {
  sessionId: string;
  direction: "clientToServer" | "serverToClient";
  opcode: "text" | "binary" | "close" | "ping" | "pong";
  payload: string;
  fin?: boolean;  // 默认 true
};
```

响应：

```ts
// 无返回值，成功时为空
```

失败场景：
- 会话不存在或连接已关闭：返回错误信息
- 注入通道异常：返回错误信息

实现说明：
- 注入帧通过 `mpsc::unbounded_channel` 传入中继循环
- `clientToServer` 方向的帧使用掩码发送（RFC 6455 §5.1）
- `serverToClient` 方向的帧不使用掩码
- 注入的帧同时作为 `WsMessageData` 发送到会话层，确保 UI 实时更新

### `search_ws_messages` — `已实现`

在指定 WebSocket 会话中搜索消息，使用 SQLite `LIKE` 匹配 `payload_text` 字段。

请求：

```ts
type SearchWsMessagesInput = {
  sessionId: string;
  query: string;
  limit?: number;   // 默认 500
  offset?: number;  // 默认 0
};
```

响应：

```ts
// 返回 WsMessage[]，结构与 list_ws_messages 一致
```

实现说明：
- 使用 `payload_text LIKE ? ESCAPE '\\'` 进行匹配
- 仅搜索有文本内容的帧（binary 帧的 `payload_text` 为 `NULL`）
- 适用于消息量较大的会话中进行深度搜索

## 6.6 Rule Commands — `Breakpoint 部分已实现`

### `list_breakpoint_rules` — `已实现`

请求：无参数。

响应：

```ts
type ListBreakpointRulesOutput = BreakpointRule[];
```

### `set_breakpoint_rules` — `已实现`

请求：

```ts
type SetBreakpointRulesInput = BreakpointRule[];
```

响应：`void`

说明：整体替换断点规则列表。前端通过 "Add Rule" 和 "Delete" 操作构造新数组后一次性提交。

### `save_breakpoint_rule`

请求：

```ts
type SaveBreakpointRuleInput = Omit<BreakpointRule, "id"> & {
  id?: string;
};
```

响应：

```ts
type SaveBreakpointRuleOutput = BreakpointRule;
```

### `delete_breakpoint_rule`

请求：

```ts
type DeleteBreakpointRuleInput = {
  ruleId: string;
};
```

响应：

```ts
type DeleteBreakpointRuleOutput = {
  success: boolean;
};
```

### `list_rewrite_rules`

状态：`已实现`

请求：

```ts
type ListRewriteRulesInput = {
  workspaceId: string;
};
```

响应：

```ts
type ListRewriteRulesOutput = RewriteRule[];
```

### `save_rewrite_rule`

状态：`已实现`

请求：

```ts
type SaveRewriteRuleInput = Omit<RewriteRule, "id"> & {
  id?: string;
};
```

响应：

```ts
type SaveRewriteRuleOutput = RewriteRule;
```

### `list_rewrite_session_trace`

状态：`已实现`

请求：

```ts
type ListRewriteSessionTraceInput = {
  sessionId: string;
};
```

响应：

```ts
type ListRewriteSessionTraceOutput = RewriteSessionTrace[];
```

说明：

- 返回指定 Session 的 Rewrite 命中记录
- 每条 trace 包含执行阶段、结果、耗时、规则信息和 before / after entries
- 前端在 Session Inspector 的 `Automation` 标签页懒加载该数据

### `list_map_rules`

请求：

```ts
type ListMapRulesInput = {
  workspaceId: string;
  mode?: "local" | "remote";
};
```

响应：

```ts
type ListMapRulesOutput = MapRule[];
```

### `save_map_rule`

请求：

```ts
type SaveMapRuleInput = Omit<MapRule, "id"> & {
  id?: string;
};
```

响应：

```ts
type SaveMapRuleOutput = MapRule;
```

### `list_dns_mappings`

请求：

```ts
type ListDnsMappingsInput = {
  workspaceId: string;
};
```

响应：

```ts
type ListDnsMappingsOutput = DnsMappingRule[];
```

### `save_dns_mapping`

请求：

```ts
type SaveDnsMappingInput = Omit<DnsMappingRule, "id"> & {
  id?: string;
};
```

响应：

```ts
type SaveDnsMappingOutput = DnsMappingRule;
```

### `delete_rule`

请求：

```ts
type DeleteRuleInput = {
  ruleType: "breakpoint" | "rewrite" | "map" | "dns";
  ruleId: string;
};
```

响应：

```ts
type DeleteRuleOutput = {
  success: boolean;
};
```

## 6.6 Breakpoint Runtime Commands — `已实现`

### `resolve_breakpoint` — `已实现`

请求：

```ts
type ResolveBreakpointInput = BreakpointResolution;
// {
//   sessionId: string;
//   action: "forward" | "drop" | "mock";
//   mock?: MockResponse;
//   modifiedRequestHeaders?: HeaderEntry[];
//   modifiedRequestBodyBase64?: string;
//   modifiedResponseHeaders?: HeaderEntry[];
//   modifiedResponseBodyBase64?: string;
// }
```

响应：`void`

说明：
- 代理管道通过 `oneshot` 通道暂停在断点命中处，前端调用此命令发送决策以解除暂停
- `forward`：放行请求/响应，可选附带修改的 headers 或 body（base64 编码）
- `drop`：直接关闭客户端连接，不返回任何响应
- `mock`：仅在请求阶段有效，跳过上游请求，直接返回用户构造的 MockResponse

### `resume_breakpoint`（已由 `resolve_breakpoint` 替代）

请求：

```ts
type ResumeBreakpointInput = {
  pauseId: string;
  action: "forward" | "drop";
  editedRequest?: {
    headers?: HeaderEntry[];
    body?: string;
  };
  editedResponse?: {
    statusCode?: number;
    headers?: HeaderEntry[];
    body?: string;
  };
};
```

响应：

```ts
type ResumeBreakpointOutput = {
  success: boolean;
};
```

## 6.7 Throttling Commands

### `list_throttle_profiles`

请求：

```ts
type ListThrottleProfilesInput = {
  workspaceId: string;
};
```

响应：

```ts
type ListThrottleProfilesOutput = ThrottleProfile[];
```

### `save_throttle_profile`

请求：

```ts
type SaveThrottleProfileInput = Omit<ThrottleProfile, "id"> & {
  id?: string;
};
```

响应：

```ts
type SaveThrottleProfileOutput = ThrottleProfile;
```

### `set_active_throttle_profile`

请求：

```ts
type SetActiveThrottleProfileInput = {
  workspaceId: string;
  profileId?: string;
};
```

响应：

```ts
type SetActiveThrottleProfileOutput = {
  success: boolean;
};
```

## 6.8 Certificate Commands

### `get_certificate_status`

请求：

```ts
type GetCertificateStatusInput = {
  workspaceId?: string;
};
```

响应：

```ts
type GetCertificateStatusOutput = {
  certPath?: string;
  fingerprint?: string;
  trusted: boolean;
  platform: "windows" | "macos" | "linux";
};
```

### `generate_root_certificate`

请求：

```ts
type GenerateRootCertificateInput = {
  forceRegenerate?: boolean;
};
```

响应：

```ts
type GenerateRootCertificateOutput = {
  certPath: string;
  fingerprint: string;
};
```

### `open_certificate_install_guide`

请求：

```ts
type OpenCertificateInstallGuideInput = {
  platform?: "windows" | "macos" | "linux";
};
```

响应：

```ts
type OpenCertificateInstallGuideOutput = {
  success: boolean;
};
```

### `get_local_ip`

获取本机局域网 IP 地址，用于手机端代理配置和证书下载 URL 生成。

请求：无参数。

响应：

```ts
type GetLocalIpOutput = string[];
```

返回字符串数组，每个元素为一个局域网 IP 地址（如 `["192.168.1.100"]`）。内部通过 UDP socket 绑定到 `0.0.0.0` 并连接外部地址来探测首选出口 IP，不发送实际流量。

### `launch_certificate_installer`

启动系统证书安装器。

请求：无参数。

响应：`void`

平台行为：

- Windows：通过 `rundll32.exe` 调用系统证书安装器
- macOS：通过 `open -a "Keychain Access"` 打开钥匙串访问
- Linux：通过 `xdg-open` 打开证书文件，由系统默认程序处理

### `install_android_certificate_via_adb`

通过 `adb` 将根证书推送到已连接 Android 设备的 `Downloads` 目录，并尝试拉起系统证书安装界面。

请求：

```ts
type InstallAndroidCertificateViaAdbInput = {
  deviceSerial?: string;
};
```

响应：

```ts
type InstallAndroidCertificateViaAdbOutput = {
  success: boolean;
  deviceSerial: string;
  remotePath: string;
};
```

说明：

- 需要本机已安装 Android Platform Tools，且 `adb` 在 PATH 中可用
- 若传入 `deviceSerial`，会安装到指定设备；若未传入，则仅在恰好 1 台设备处于 `device` 状态时自动选择
- 该能力会辅助打开系统安装流程，但不会绕过 Android 的手动确认步骤

### `list_android_adb_devices`

列出当前 `adb devices -l` 可见的 Android 设备，用于在多个手机或模拟器并存时选择目标 `serial`。

请求：无参数。

响应：

```ts
type ListAndroidAdbDevicesOutput = Array<{
  serial: string;
  state: string;
  model?: string;
  product?: string;
  device?: string;
  transportId?: string;
}>;
```

## 6.9 代理内建 HTTP 端点

代理核心在启动时同时监听来自局域网的直连请求，提供以下内建 HTTP 端点：

### `GET /aiproxy-ca.crt`

下载根 CA 证书（PEM 格式）。手机端可直接通过浏览器访问 `http://<local-ip>:<proxy-port>/aiproxy-ca.crt` 下载证书。

- Content-Type: `application/x-x509-ca-cert`
- 需要已生成根证书且代理已启动
- 仅响应非代理风格的直连请求（origin-form），不会拦截代理转发的请求

### `GET /aiproxy-ca.pem`

同 `/aiproxy-ca.crt`，为 PEM 格式证书提供备用路径。

## 6.10 Export Commands

### `export_sessions`

请求：

```ts
type ExportSessionsInput = {
  workspaceId: string;
  sessionIds?: string[];
  format: "har" | "curl" | "json";
  outputPath: string;
};
```

响应：

```ts
type ExportSessionsOutput = {
  taskId: string;
};
```

## 7. Event Specification

## 7.1 代理状态事件

### `proxy/status_changed`

```ts
type ProxyStatusChangedEvent = ProxyStatus;
```

触发时机：

- 代理启动
- 代理停止
- 系统代理状态变化
- SSL 状态变化

## 7.2 会话事件

### `session-upsert`

```ts
type SessionUpsertEvent = SessionSummary;
```

### `session-remove`

```ts
type SessionRemoveEvent = string;
```

## 7.3 断点事件 — `已实现`

### `breakpoint-hit` — `已实现`

```ts
type BreakpointHitEvent = BreakpointHit;
// {
//   sessionId: string;
//   stage: "request" | "response";
//   method: string;
//   url: string;
//   host: string;
//   path: string;
//   requestHeaders: HeaderEntry[];
//   requestBody?: BodyReference;
//   responseStatusCode?: number;
//   responseHeaders?: HeaderEntry[];
//   responseBody?: BodyReference;
// }
```

触发时机：

- 请求阶段断点命中：在 `forward_request` 之前
- 响应阶段断点命中：在 `write_upstream_response` 之前

前端处理：

- `services/events/index.ts` 中的 `onBreakpointHit()` 订阅此事件
- 事件载荷经过 `parseBreakpointHit()` 校验后写入 Zustand store
- `BreakpointInterceptPanel` 组件监听 store 并渲染拦截面板

## 7.4 规则事件

### `rule/matched`

```ts
type RuleMatchedEvent = {
  sessionId: string;
  ruleType: "breakpoint" | "rewrite" | "map" | "dns";
  ruleId: string;
  ruleName: string;
};
```

## 7.5 WebSocket 事件 — `已实现`

### `ws-message` — `已实现`

每个 WebSocket 帧被捕获时实时推送。

```ts
type WsMessageEvent = WsMessage;
// {
//   id: string;
//   sessionId: string;
//   direction: "clientToServer" | "serverToClient";
//   timestamp: string;
//   opcode: "text" | "binary" | "close" | "ping" | "pong" | "continuation";
//   payloadText?: string;
//   payloadSize: number;
//   fin: boolean;
// }
```

触发时机：

- 代理中继捕获到每个 WebSocket 帧
- 注入（重放）的帧也会触发此事件

前端处理：

- `services/events/index.ts` 中的 `onWsMessage()` 订阅此事件
- 事件载荷经过 `isWsMessage()` 类型守卫校验
- `SessionInspectorMessagesPane` 组件根据 `sessionId` 过滤并追加到消息列表

### `ws-connection-status` — `已实现`

WebSocket 连接状态变化时推送。

```ts
type WsConnectionStatusEvent = {
  sessionId: string;
  status: "active" | "closed";
};
```

触发时机：

- WebSocket 升级完成、中继开始时（`status: "active"`）
- 中继结束（任一方关闭连接或连接异常断开）时（`status: "closed"`）

前端处理：

- `services/events/index.ts` 中的 `onWsConnectionStatus()` 订阅此事件
- `SessionInspectorMessagesPane` 据此更新连接状态指示器（绿点 = 活跃，灰点 = 已关闭）
- 状态为 `closed` 时 Compose 和 Replay 按钮自动禁用

## 7.6 导出事件

### `export/progress`

```ts
type ExportProgressEvent = {
  taskId: string;
  progress: number;
  status: "running" | "completed" | "failed";
  errorMessage?: string;
};
```

## 8. 前端调用规范

## 8.1 Command Client 约束

- 所有 Command 调用统一走 `services/commands/*`
- 每个命令必须有明确输入输出类型
- 禁止在 UI 组件中直接散落调用 Tauri 底层 API
- 所有错误统一转换为 `AppError`

## 8.2 Event Subscription 约束

- 所有 Event 订阅统一走 `services/events/*`
- 页面卸载时必须释放订阅
- 实时事件进入状态层前先做 schema 校验

## 8.3 缓存与同步策略

- 会话详情按需加载
- 会话列表实时增量更新
- 规则、工作区、证书状态可用 Query 缓存
- 长任务进度以事件流为准，不依赖轮询

## 9. 安全约束

- 命令层必须校验文件路径与工作区归属
- 对证书、密钥、导出路径进行白名单校验
- Body 大文件避免一次性加载到内存
- 日志中默认不打印完整敏感 Body

## 10. 版本策略

### v1

- 覆盖本地桌面必需命令与实时事件
- 覆盖脚本规则配置接口与会话 trace 查询接口

### v2

- 增加插件注册与生命周期 API
- 增加分析面板聚合查询 API

## 10.1 Script Rule Commands

- `list_script_rules({ workspaceId }) -> ScriptRule[]`
- `save_script_rule({ input: ScriptRule }) -> ScriptRule`
- `read_script_source_file({ path }) -> { fileName, language, path, sourceCode }`
- `list_script_session_trace({ sessionId }) -> ScriptSessionTrace[]`

约束：

- 仅支持单文件 `JS / TS`
- 仅支持 `export function onRequest(ctx) {}` 与 `export function onResponse(ctx) {}`
- 运行时不开放文件系统、网络、模块加载、宿主命令执行

## 11. API Collection Commands — 已实现

这些命令由 `Collections` 页面调用，支持保存、分组、编辑和发送 HTTP 请求集合。

### Collection 共享类型

```ts
type ApiCollection = {
  id: string;
  parentId: string | null;
  name: string;
  description: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

type ApiCollectionItem = {
  id: string;
  collectionId: string;
  name: string;
  description: string;
  sortOrder: number;
  method: string;
  url: string;
  headers: HeaderEntry[];
  body: string;
  bodyType: "none" | "formdata" | "urlencoded" | "raw";
  rawLanguage: string;
  formData: HeaderEntry[];
  urlEncoded: HeaderEntry[];
  createdAt: string;
  updatedAt: string;
};
```

### Collection CRUD

- `list_api_collections() -> ApiCollection[]`
- `upsert_api_collection({ id?, parentId?, name, sortOrder? }) -> ApiCollection` — 当 `id` 存在且 `parentId` 改变时会进行 cycle check（拒绝把文件夹移到自己的子级）
- `delete_api_collection({ id }) -> void` — 级联删除子文件夹和请求项
- `move_api_collection({ id, targetParentId, sortOrder }) -> void` — 在树中移动文件夹；`sortOrder` 是新父级下的目标索引，会触发 dense renumber 和 cycle check

### Collection Item CRUD

- `list_api_collection_items({ collectionId }) -> ApiCollectionItem[]`
- `get_api_collection_item({ id }) -> ApiCollectionItem`
- `upsert_api_collection_item({ id?, collectionId, name, description?, method, url, headers, body, bodyType, rawLanguage, formData, urlEncoded }) -> ApiCollectionItem`
- `delete_api_collection_item({ id }) -> void`
- `move_api_collection_item({ id, targetCollectionId, sortOrder }) -> void` — 在文件夹之间移动请求项或在同一文件夹内重排，`sortOrder` 是目标列表中的目标索引，触发 dense renumber
- `save_session_to_collection({ sessionId, collectionId, name? }) -> ApiCollectionItem` — 从抓包流量保存

### Batch Execute

- `batch_execute_collection_items({ itemIds, environmentId? }) -> SessionDetail[]` — 顺序执行，自动替换环境变量

## 12. Environment Commands — 已实现

这些命令支持多环境管理和变量替换。环境变量与全局变量均支持 `{{key}}` 语法，在请求发送时自动替换 URL、Headers、Body、FormData 和 URL-encoded 值。

### Environment 共享类型

```ts
type ApiEnvironment = {
  id: string;
  name: string;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
};

type ApiEnvironmentVariable = {
  id: string;
  environmentId: string;
  key: string;
  value: string;
  enabled: boolean;
  sortOrder: number;
};

type ApiGlobalVariable = {
  id: string;
  key: string;
  value: string;
  enabled: boolean;
  sortOrder: number;
};
```

### Environment CRUD

- `list_api_environments() -> ApiEnvironment[]`
- `upsert_api_environment({ id?, name, sortOrder? }) -> ApiEnvironment`
- `delete_api_environment({ id }) -> void` — 级联删除关联变量

### Environment Variables

- `list_api_environment_variables({ environmentId }) -> ApiEnvironmentVariable[]`
- `set_api_environment_variables({ environmentId, variables }) -> void` — 事务性全量替换

### Global Variables

- `list_api_global_variables() -> ApiGlobalVariable[]`
- `set_api_global_variables({ variables }) -> void` — 事务性全量替换

### 变量作用域

变量解析优先级：环境变量 > 全局变量。未匹配的 `{{key}}` 保持原样，不报错。

## 13. 实现建议

- 在 `packages/shared-types/` 维护所有接口 DTO
- 用 Zod 或等价 schema 在前端做运行时校验
- Rust 侧以模块拆分 Command Handler，避免 `main.rs` 过大
- 事件名保持稳定，避免在 UI 中硬编码字符串分散出现
