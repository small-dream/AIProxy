# AIProxy API Specification

## 1. 文档信息

- 产品代号：`AIProxy`
- 文档类型：接口规范文档
- 当前阶段：`P3 / 持续改进完成后的契约同步`
- 文档状态：`Living Spec v1.3`
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
- 管理 API Collections 与环境变量

### 3.2 Event Layer

用于：

- 会话创建 / 更新
- 断点暂停
- 断点自动释放（超时 / sender dropped）
- 会话清空 / 批量移除
- WebSocket 消息与连接状态变化

## 4. 通用约定

## 4.1 命名规范

- Command 使用 `snake_case`
- Event 使用 `domain/action` 风格
- 前端内部 TypeScript 类型使用 `PascalCase`
- Rust DTO 使用 `CamelCase` 序列化为 JSON

## 4.2 错误模型

所有命令失败时，语义上统一返回标准错误对象。Tauri command 的 Rust 签名仍保持 `Result<T, String>`，因此实际传输形态是由 `app_error()` / `app_error_with_details()` 生成的 JSON 字符串；前端必须通过 `coerceAppError()` 解析为 `AppError`。

```ts
type AppError = {
  code: string;
  message: string;
  details?: Record<string, unknown>;
};
```

约束：

- Rust command 边界禁止新增用户可见裸字符串错误。
- DB 错误由 `DbError` 在 command 边界显式转换为 `app_error(ERR_INTERNAL, ...)`。
- 列表查询失败返回错误载荷；只有真实空结果返回空数组。

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
  http2Enabled?: boolean;  // default true
  // H3: upstream TLS certificate verification. Optional for backward
  // compatibility — defaults to false (NoOp verifier, the historical
  // debug-proxy behavior).
  verifyUpstreamTls?: boolean;
  // H3: hostnames always TLS-verified even when verifyUpstreamTls is false.
  // Optional; defaults to []. The DB column stores a JSON-encoded array.
  tlsVerifyHosts?: string[];
  // Per-host SSL-decryption opt-out: hostnames that are tunneled blindly
  // (no MITM) even while sslEnabled stays on. Optional; defaults to [].
  // The DB column stores a JSON-encoded array.
  sslBlindHosts?: string[];
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
  http2Enabled?: boolean;
};
```

## 5.3 SessionSummary

```ts
type SessionSummary = {
  id: string;
  method: string;
  host: string;
  path: string;
  protocol: string;
  scheme?: string;
  httpVersion?: string;
  transportProtocol?: string;
  applicationProtocol?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  sizeBytes: number;
  statusCode: number;
  url: string;
  responseMimeType?: string;
};
```

## 5.4 SessionDetail

```ts
type HeaderEntry = {
  name: string;
  value: string;
  isPseudo?: boolean;  // true for HTTP/2 pseudo headers (:method, :path, :scheme, :authority, :status)
};

type BodyReference = {
  base64Text?: string;
  base64Deferred?: boolean;
  encoding?: string;
  inlineText?: string;
  mimeType?: string;
  textDeferred?: boolean;
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

// Timing 来源标识：
// - "proxy": 代理捕获的会话，通过 TimingConnector（hyper）采集全部 7 个阶段
// - "compose": Compose 发送的请求，通过 reqwest 采集（仅 totalMs/waitingMs/responseReadMs）
// - "har-import": 从 HAR 文件导入的会话，字段取决于 HAR 原始数据

type SessionDetail = {
  clientAddress?: string;
  cookies: HeaderEntry[];
  id: string;
  summary: SessionSummary;
  queryParams: HeaderEntry[];
  rawRequestHead?: string;
  rawRequest?: string;
  rawRequestDeferred?: boolean;
  rawResponseHead?: string;
  rawResponse?: string;
  rawResponseDeferred?: boolean;
  requestBody?: BodyReference;
  requestHeaders: HeaderEntry[];
  responseBody?: BodyReference;
  responseHeaders: HeaderEntry[];
  serverIp?: string;
  mapTraces?: MapSessionTrace[];
  rewriteTraces?: RewriteSessionTrace[];
  scriptTraces?: ScriptSessionTrace[];
  throttleTraces?: ThrottleSessionTrace[];
  tlsCipherSuite?: string;
  tlsProtocol?: string;
  timing?: TimingBreakdown;
  timingSource?: "proxy" | "compose" | "har-import";
  trailers?: HeaderEntry[];     // HTTP/2 response trailers
  h2StreamId?: number;          // HTTP/2 stream ID (debugging)
};

type SessionDetailContentRequest = {
  sessionId: string;
  includeRawRequest?: boolean;
  includeRawResponse?: boolean;
  includeRequestBodyText?: boolean;
  includeResponseBodyText?: boolean;
  includeRequestBodyBase64?: boolean;
  includeResponseBodyBase64?: boolean;
};

type SessionDetailContentPatch = {
  sessionId: string;
  rawRequest?: string;
  rawRequestDeferred?: boolean;
  rawResponse?: string;
  rawResponseDeferred?: boolean;
  requestBody?: Pick<BodyReference, "inlineText" | "textDeferred" | "base64Text" | "base64Deferred">;
  responseBody?: Pick<BodyReference, "inlineText" | "textDeferred" | "base64Text" | "base64Deferred">;
};

// HTTP/2 Session Notes:
// - HTTP/2 sessions have `httpVersion: "2"` (set in SessionSummary).
// - Headers may contain pseudo-headers (`:method`, `:path`, `:scheme`, `:authority`, `:status`)
//   with `isPseudo: true` in the HeaderEntry.
// - HTTP/2 responses may include `trailers` (returned in SessionDetail).
```

## 5.5 Rule Models — `BreakpointRule 已实现`

```ts
// BreakpointRule — 已实现的运行时模型
type BreakpointStage = "request" | "response";

type BreakpointActionKind = "forward" | "drop" | "mock";

type BreakpointRule = {
  id: string;
  enabled: boolean;
  urlPattern: string;       // 匹配方式由 matchType 决定，默认 contains（子串匹配）
  methods: string[];         // 空 = 所有方法
  stage: BreakpointStage;
  matchType?: MatchType;     // 默认 "contains"，可选 "wildcard" / "exact" / "regex"
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
  modifiedRequestQueryParams?: HeaderEntry[];
  modifiedRequestBodyBase64?: string;
  modifiedResponseStatusCode?: number;
  modifiedResponseHeaders?: HeaderEntry[];
  modifiedResponseBodyBase64?: string;
};

type RuleMatchStage = "request" | "response" | "either";

type MatchType = "contains" | "wildcard" | "exact" | "regex";

type RuleMatch = {
  urlPattern: string;
  methods: string[];
  stage: RuleMatchStage;
  matchType?: MatchType;     // 默认 "contains"（子串匹配），可选 "wildcard" / "exact" / "regex"
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

type RewriteBodyFieldEdit = {
  operation: "set" | "remove";
  path: string;
  value?: string;
  valueType?: "string" | "number" | "boolean" | "null" | "json";
};

type RewriteBodyPayload = {
  contentType: string;
  fields?: RewriteBodyFieldEdit[];
  mode?: "replace" | "fields";
  target: RewriteTarget;
  text?: string;
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
  kind: "body-field" | "header" | "query" | "body" | "redirect" | "skip" | "error";
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
  name: string;
  note?: string;
  mode: "local" | "remote";
  sourcePattern: string;
  targetValue: string;
  enabled: boolean;
  preservePath: boolean;
  preserveQuery: boolean;
  priority: number;
};

type MapSessionTrace = {
  durationMs: number;
  localPath?: string;
  mappedUrl?: string;
  mode: "local" | "remote";
  originalUrl: string;
  outcome: "success" | "failed" | string;
  ruleId: string;
  ruleName: string;
  sourcePattern: string;
  targetValue: string;
};
```

## 5.6 ThrottleProfile

```ts
type ThrottleProfile = {
  id: string;
  workspaceId: string;
  name: string;
  note?: string;
  latencyMs: number;
  uploadKbps: number;
  downloadKbps: number;
  packetLossRatio: number;
  enabled: boolean;
  preset: boolean;
};
```

## 5.7 ThrottleRule

```ts
type ThrottleRule = {
  id: string;
  workspaceId: string;
  name: string;
  note?: string;
  enabled: boolean;
  priority: number;
  profileId: string;
  urlPattern: string;       // "*" / "https://api.example.com/users" / "*://api.example.com/*"
  methods: string[];        // [] = any method
  stage: "both" | "request" | "response";
};
```

## 5.8 ThrottleRuntimeStats

```ts
type ThrottleRuntimeStats = {
  matchedRequests: number;
  droppedRequests: number;
  requestDelayMs: number;
  responseDelayMs: number;
};
```

## 5.9 ThrottleSessionTrace

```ts
type ThrottleSessionTrace = {
  sequence: number;
  stage: "request" | "response" | string;
  outcome: "applied" | "dropped" | string;
  profileId: string;
  profileName: string;
  ruleId?: string;
  ruleName?: string;
  bodyBytes: number;
  latencyMs: number;
  transferDelayMs: number;
  delayMs: number;
  message?: string;
};
```

## 5.10 DnsMappingRule

```ts
type DnsMappingRule = {
  id: string;
  workspaceId: string;
  name: string;
  note?: string;
  enabled: boolean;
  priority: number;
  hostPattern: string;  // 子串匹配（非通配符），如 "example.com"
  targetIp: string;     // "192.168.1.100"
};
```

## 5.11 ScriptRule

```ts
type ScriptRuleLanguage = "javascript" | "typescript";
type ScriptRuleSourceType = "inline" | "fileImport";

type ScriptEntrypoints = {
  onRequest: boolean;
  onResponse: boolean;
};

type ScriptRule = {
  enabled: boolean;
  entrypoints: ScriptEntrypoints;
  id: string;
  language: ScriptRuleLanguage;
  match: RuleMatch;
  name: string;
  note?: string;
  priority: number;
  sourceCode: string;
  sourcePath?: string;
  sourceType: ScriptRuleSourceType;
  workspaceId: string;
};

type ScriptRunEntry = {
  kind: "log" | "extraction" | "error";
  key?: string;
  level?: "debug" | "info" | "warn" | "error";
  message?: string;
  payloadJson?: string;
  sequence: number;
};

type ScriptSessionTrace = {
  durationMs: number;
  entries: ScriptRunEntry[];
  outcome: "success" | "skipped" | "runtimeError" | "timedOut" | "invalidResult";
  ruleId: string;
  stage: "request" | "response";
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
  enableHttp2?: boolean;  // default true
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
type StopProxyOutput = ProxyStatus;
```

### `get_bootstrap_status`

请求：

```ts
type GetBootstrapStatusInput = Record<string, never>;
```

响应：

```ts
type GetBootstrapStatusOutput = ProxyStatus;
```

### `get_port_occupant`

用途：

- 解析当前占用指定 TCP 端口的进程（PID + 名称），供端口占用时「结束占用进程并用原端口重启代理」使用。
- 跨平台：Unix 用 `lsof`，Windows 用 `netstat` + `tasklist`。无法确定占用者（端口空闲、Linux 缺 `lsof` 等）返回 `null`，不报错。

请求参数：`{ port: number }`（`invoke("get_port_occupant", { port })`）。

响应：

```ts
type GetPortOccupantOutput = PortOccupant | null;
// PortOccupant = { pid: number; name: string }
```

失败场景：系统命令执行失败或解析异常时返回 `null`（静默降级为仅「更换端口」），不抛错。

### `kill_proxy_port_process`

用途：结束占用代理端口的进程，使代理能在原端口重启。**TOCTOU 防护**：后端 kill 前用 `find_port_occupant(port)` 重新核对当前占用者 pid（+ name 若提供）仍匹配，不匹配则拒绝，避免 PID 复用后误杀无关进程。

请求：

```ts
type KillPortProcessInput = {
  port: number;
  pid: number;
  name?: string; // 占用者名称辅助校验，若提供则需匹配
};
```

响应：`void`。

失败场景：

- `PROCESS_CHANGED`：占用进程已变化（PID/名称不再匹配）→ 前端应重新查询占用者。
- `INVALID_INPUT`：拒绝结束保留进程（PID 0；Windows 额外拒绝 PID 4）。
- 权限不足 / 进程已退出：底层 kill（Unix `kill -9` / Windows `taskkill /F`）失败。

### `list_sessions`

用途：

- 返回当前应用内存中的已捕获会话列表，HAR 导入的本地会话由前端合并展示

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
  scheme?: string;
  httpVersion?: string;
  transportProtocol?: string;
  applicationProtocol?: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  sizeBytes: number;
  statusCode: number;
  url: string;
  responseMimeType?: string;
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
  http2Enabled?: boolean;
  // H3: enable/disable upstream TLS certificate verification for new
  // HTTPS/WSS connections in this workspace. Omit to leave unchanged.
  verifyUpstreamTls?: boolean;
  // H3: hostnames always TLS-verified even when verifyUpstreamTls is false
  // (a per-host allowlist). Array form (matches Workspace.tlsVerifyHosts);
  // the backend serializes it to the JSON-encoded DB column. Omit to leave
  // unchanged.
  tlsVerifyHosts?: string[];
  // Hostnames for which SSL decryption is disabled while the workspace
  // sslEnabled switch stays on (privacy / certificate-pinning escape hatch).
  // Array form (matches Workspace.sslBlindHosts); omit to leave unchanged.
  sslBlindHosts?: string[];
};
```

响应：

```ts
type UpdateWorkspaceOutput = Workspace;
```

> **H3 行为说明**：每条新上游连接的有效校验决策为 `verifyUpstreamTls || tlsVerifyHosts.contains(host)`（大小写不敏感、去空白）——即白名单内的 host 即使总开关关闭也会被校验。`true`（或 host 命中白名单）时依据系统根证书校验上游证书（无效/自签名被拒）；`false`（默认）保持 NoOp verifier，接受任意上游证书。开关在新连接上生效（已建立的连接不强制断开）。`start_proxy` / 重启会按当前 workspace 的设置解析进 `ProxyConfig`。

> **SSL 按 host 解密开关**：`sslBlindHosts` 内的 host 在 CONNECT 阶段直接盲通（不终止 TLS、不捕获解密后的明文），即使 workspace 级 `sslEnabled` 保持开启——既是隐私合规控制，也是绕过证书固定（pinning）的手段。匹配为大小写不敏感、去空白（复用 `host_in_allowlist`）。修改通过 `update_workspace` 持久化，代理运行时在 `start_proxy` / 重启后按新列表解析生效。

## 6.3 Session Commands

### `list_sessions`

请求：

```ts
type ListSessionsInput = Record<string, never>;
```

响应：

```ts
type ListSessionsOutput = SessionSummary[];
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

- `requestHeaders` 与 `responseHeaders` 返回真实抓包头信息
- `requestBody` 与 `responseBody` 对小体积内容优先返回 `inlineText`，非 UTF-8 内容回退到 `base64Text`
- 大体积 raw/body 内容可返回 `rawRequestDeferred`、`rawResponseDeferred`、`textDeferred`、`base64Deferred`，由 `get_session_detail_content` 按需加载
- 当 `BodyReference.truncated` 为 `true` 时，UI 在请求和响应 Inspector 面板中显示 Alert 警告提示用户 body 已被截断
- `timing` 所有 7 个阶段（`dnsMs`、`connectMs`、`tlsMs`、`requestSendMs`、`waitingMs`、`responseReadMs`、`totalMs`）在代理捕获会话中均已通过 `TimingConnector`（hyper）完整填充
- `timingSource` 标识 timing 数据来源：`"proxy"`（代理捕获，全阶段）、`"compose"`（Compose 发送，仅部分阶段）、`"har-import"`（HAR 导入，取决于原始数据）
- Compose 发送的请求仍通过 `reqwest`，仅提供 `totalMs`、`waitingMs`、`responseReadMs`

### `get_session_detail_content`

请求：

```ts
type GetSessionDetailContentInput = SessionDetailContentRequest;
```

响应：

```ts
type GetSessionDetailContentOutput = SessionDetailContentPatch;
```

说明：

- 用于按需加载详情中被延迟的 raw request / raw response / request body / response body 内容
- 前端通过 `mergeSessionDetailContent()` 合并 patch，避免列表轮询或详情首屏携带大体积 payload
- `includeResponseBodyBase64` 用于媒体预览场景：当响应 MIME 类型为 `image/*`、`audio/*`、`video/*` 时，前端切换到 Preview Tab 后按需请求 base64 数据，构造 data URI 进行行内渲染

### `save_media_file`

请求：

```ts
type SaveMediaFileInput = {
  base64Content: string;
  path: string;
};
```

响应：

```ts
type SaveMediaFileOutput = string; // 保存的文件路径
```

说明：

- 用于媒体预览区的「另存为...」功能，将 base64 编码的媒体内容解码后写入用户通过文件对话框选择的路径
- 前端通过 Tauri `dialog.save()` 获取目标路径，再调用此命令写入文件

### `clear_sessions`

请求：

```ts
type ClearSessionsInput = Record<string, never>;
```

响应：

```ts
type ClearSessionsOutput = void;
```

说明：

- 清空当前 workspace 的全部会话（含持久化数据），UI 侧需先做危险操作确认

### `delete_sessions_except`

请求：

```ts
type DeleteSessionsExceptInput = {
  keepSessionId: string;
};
```

响应：

```ts
type DeleteSessionsExceptOutput = void;
```

### `set_focused_hosts`

请求：

```ts
type SetFocusedHostsInput = {
  hosts: string[];
};
```

响应：`void`

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
- `timingSource` 为 `"compose"`，前端 Inspector 可据此区分 timing 数据来源并调整 WaterfallChart 展示
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
- WebSocket 会话优先通过 `applicationProtocol: "websocket"` 识别，旧数据仍可回退到 `protocol: "ws" | "wss"` 或 `responseMimeType: "websocket"`
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

### `save_breakpoint_rule` — `暂未注册，当前由 set_breakpoint_rules 整体替换`

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

### `delete_breakpoint_rule` — `暂未注册，当前由 set_breakpoint_rules 整体替换`

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
  ruleType: "rewrite" | "map" | "dns" | "script";
  ruleId: string;
};
```

响应：

```ts
type DeleteRuleOutput = void;
```

## 6.7 Breakpoint Runtime Commands — `已实现`

### `resolve_breakpoint` — `已实现`

请求：

```ts
type ResolveBreakpointInput = BreakpointResolution;
// {
//   sessionId: string;
//   action: "forward" | "drop" | "mock";
//   mock?: MockResponse;
//   modifiedRequestHeaders?: HeaderEntry[];
//   modifiedRequestQueryParams?: HeaderEntry[];
//   modifiedRequestBodyBase64?: string;
//   modifiedResponseStatusCode?: number;
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

## 6.8 Throttling Commands

> Throttling 在当前产品中指弱网 / 链路模拟，不是 API QPS、Quota 或 429 限流。

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

### `list_throttle_rules`

请求：

```ts
type ListThrottleRulesInput = {
  workspaceId: string;
};
```

响应：

```ts
type ListThrottleRulesOutput = ThrottleRule[];
```

### `save_throttle_rule`

请求：

```ts
type SaveThrottleRuleInput = Omit<ThrottleRule, "id"> & {
  id?: string;
};
```

响应：

```ts
type SaveThrottleRuleOutput = ThrottleRule;
```

### `delete_throttle_rule`

请求：

```ts
type DeleteThrottleRuleInput = {
  ruleId: string;
};
```

响应：

```ts
type DeleteThrottleRuleOutput = void;
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
type SetActiveThrottleProfileOutput = void;
```

### `get_throttle_runtime_stats`

请求：

```ts
type GetThrottleRuntimeStatsInput = void;
```

响应：

```ts
type GetThrottleRuntimeStatsOutput = ThrottleRuntimeStats;
```

### `list_throttle_session_trace`

请求：

```ts
type ListThrottleSessionTraceInput = {
  sessionId: string;
};
```

响应：

```ts
type ListThrottleSessionTraceOutput = ThrottleSessionTrace[];
```

### `list_throttled_session_ids`

请求：

```ts
type ListThrottledSessionIdsInput = {
  workspaceId: string;
};
```

响应：

```ts
type ListThrottledSessionIdsOutput = string[];
```

## 6.9 Certificate Commands

### `get_certificate_status`

请求：无参数。

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
type GenerateRootCertificateOutput = CertificateStatus;
```

### `remove_certificate_trust`

请求：无参数。端到端移除根证书：撤销系统信任 → 删除本地证书文件 → 工作区降级为 HTTP-only → 交还系统代理 → 运行中的代理以仅 HTTP 模式重启。证书文件不存在时（手动删除/半删除状态）仅跳过"平台信任撤销"（各平台撤销命令都需要证书文件定位目标），**运行态与配置清理照常执行**——运行中的代理仍持有启动时捕获的 `Arc<TlsManager>`，会继续用内存里的根 CA 签发，必须清理。

响应：

```ts
type TrustRemovalFailure = {
  store: string; // 见下方 store 枚举
  error: string;
};

type TrustRemovalReport = {
  attempted: string[];
  succeeded: string[]; // 含"已移除"与"本就不存在"（幂等成功）
  failed: TrustRemovalFailure[];
};

type RemoveCertificateTrustOutput = {
  status: CertificateStatus; // 移除后：certPath 为空、trusted=false
  trustRemoval: TrustRemovalReport;
  systemProxyHandbackError?: string; // 系统代理交还失败的原因（见下方语义）
};
```

`store` 标识（与 `tls-manager::trust::trust_store` 常量保持一致）：

| store | 说明 | 自动移除是否常需提权 |
| --- | --- | --- |
| `windows.currentUserRoot` | Windows CurrentUser\Root | 否 |
| `windows.localMachineRoot` | Windows LocalMachine\Root | 是（管理员） |
| `macos.userDomain` | macOS 用户域信任设置 | 否 |
| `macos.systemDomain` | macOS 系统域信任设置 | 是（sudo） |
| `macos.loginKeychain` | login 钥匙串证书对象 | 否 |
| `macos.systemKeychain` | System 钥匙串证书对象 | 是（sudo） |
| `linux.anchors` | Debian/Fedora anchor 目录中的证书文件 | 是（sudo） |
| `linux.caStore` | `update-ca-certificates` / `update-ca-trust` 刷新 | 是（sudo） |

语义要点：

- 信任撤销按 store 独立尝试，**失败不中断整体流程**——提权失败是常态（见上表），失败项由前端配对各平台手动命令展示（`certificatesPage.remove.manualCommands.*`）。
- 顺序刚性：先撤销信任（macOS/Linux 命令需要证书文件定位目标）→ 再删文件 → 清 TLS manager → 持久化 `ssl_enabled=false` → 关系统代理 → HTTP-only 重启。
- DB 持久化失败仅告警（M9 降级语义），不回滚移除动作。
- 若系统代理此前已接管，会调用 `disable_system_proxy` 恢复用户原代理设置，避免移除证书后整机指向不受信任的 MITM 代理。**交还失败时**：`disable_system_proxy` 只有恢复成功才把 `system_proxy_enabled` 写回 false，因此该标志仍为 true，随后的 HTTP-only 重启尾声会重新把 OS 代理指向本代理——整机仍被劫持。此错误经 `systemProxyHandbackError` 返回，前端以 warning 提示用户从状态栏/设置手动关闭系统代理。

### `diagnose_certificate_setup`

请求：无参数。聚合证书/代理环境探测,供 UI 渲染可操作的排障指引。

响应：

```ts
type DiagnosticCheck = {
  key: string; // "cert_present" | "cert_trusted" | "adb" | "hdc" | "ios_simulator"
  ok: boolean;
  message?: string;
};

type DiagnoseCertificateSetupOutput = {
  platform: "windows" | "macos" | "linux";
  certPresent: boolean;
  certPath?: string;
  certTrusted: boolean;
  adbAvailable: boolean;
  hdcAvailable: boolean; // hdc(HarmonyOS Device Connector)是否可用,跨平台检查
  iosSimulatorTooling: boolean; // 仅 macOS 可能为 true
  checks: DiagnosticCheck[];
};
```

说明:`ios_simulator` 检查仅在 macOS 下出现;`adb` 与 `hdc` 检查跨平台都会出现;跨平台信任探测复用 `tls-manager::trust`。

### `open_certificate_install_guide`

请求：无参数。

响应：

```ts
type OpenCertificateInstallGuideOutput = {
  success: boolean;
  certPath: string;
  platform: string;
  steps: Array<{ order: number; description: string }>;
};
```

### `get_local_ip`

获取本机局域网 IP 地址，用于手机端代理配置和证书下载 URL 生成。

请求：无参数。

响应：

```ts
type GetLocalIpOutput = string[];
```

返回字符串数组，每个元素为一个局域网 IP 地址（如 `["192.168.1.100"]`），按优先级排序（物理接口 + 常见私有网段优先，虚拟/隧道接口降权）。内部通过平台特定的网络接口枚举获取 IP 列表，再通过 UDP socket 探测补充首选出口 IP：

- Unix（macOS/Linux）：通过 `libc::getifaddrs()` 遍历网络接口
- Windows：通过 PowerShell `Get-NetIPAddress` 枚举 IPv4 地址（过滤 `AddressState=Preferred`）
- UDP socket 探测作为补充手段，不发送实际流量

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

### `set_android_proxy_via_adb`

请求：

```ts
type SetAndroidProxyViaAdbInput = {
  deviceSerial?: string;
  host: string;
  port: number;
};
```

响应：

```ts
type AndroidAdbProxyResult = {
  success: boolean;
  deviceSerial: string;
  proxyAddress?: string;
};
```

### `clear_android_proxy_via_adb`

请求：

```ts
type ClearAndroidProxyViaAdbInput = {
  deviceSerial?: string;
};
```

响应：`AndroidAdbProxyResult`

### `list_ios_simulators`

列出可用 iOS Simulator 设备，用于选择目标模拟器安装根证书。

请求：无参数。

响应：

```ts
type ListIosSimulatorsOutput = Array<{
  name: string;
  udid: string;
  state: string;
  runtime: string;
}>;
```

### `install_ios_certificate_via_simulator`

请求：

```ts
type InstallIosCertificateViaSimulatorInput = {
  simulatorUdid?: string;
};
```

响应：

```ts
type InstallIosCertificateViaSimulatorOutput = {
  success: boolean;
  simulatorName: string;
  simulatorUdid: string;
};
```

### `list_harmony_hdc_devices`

列出当前 `hdc list targets` 可见的 HarmonyOS NEXT 设备，用于在多台设备并存时选择目标 `serial`。

请求：无参数。

响应：

```ts
type ListHarmonyHdcDevicesOutput = Array<{
  serial: string;
  state: string; // "Connected" 表示就绪
  model?: string;
}>;
```

说明：

- 需要本机已安装 HarmonyOS SDK / DevEco Studio，且 `hdc` 在 PATH 中可用，或设置了 `HDC_PATH` 环境变量
- 设备需在开发者选项中开启 HDC 调试

### `install_harmony_certificate_via_hdc`

通过 `hdc` 将根证书推送到已连接 HarmonyOS NEXT 设备的「下载」目录（`/storage/media/100/local/files/Download/`），并尽力拉起系统证书管理器以便用户手动完成安装。

请求：

```ts
type InstallHarmonyCertificateViaHdcInput = {
  deviceSerial?: string;
};
```

响应：

```ts
type InstallHarmonyCertificateViaHdcOutput = {
  success: boolean;
  deviceSerial: string;
  remotePath: string;
};
```

说明：

- 需要本机已安装 HarmonyOS SDK / DevEco Studio，且 `hdc` 在 PATH 中可用，或设置了 `HDC_PATH` 环境变量
- 若传入 `deviceSerial`，会安装到指定设备；若未传入，则仅在恰好 1 台设备处于 `Connected` 状态时自动选择
- HarmonyOS NEXT **没有**等价于 `adb shell settings put global http_proxy` 的全局代理命令，系统代理需用户在 Wi-Fi 设置中手动配置
- 该能力仅推送证书并尝试打开证书管理器，**不会绕过** HarmonyOS 的手动确认步骤：用户需进入「设置 → 安全与隐私 → 加密与凭据 → 从存储设备安装」，在文件选择器中进入「下载」目录选中推送的证书完成安装

## 6.10 代理内建 HTTP 端点

代理核心在启动时同时监听来自局域网的直连请求，提供以下内建 HTTP 端点：

### `GET /aiproxy-ca.crt`

下载根 CA 证书（PEM 格式）。手机端可直接通过浏览器访问 `http://<local-ip>:<proxy-port>/aiproxy-ca.crt` 下载证书。

- Content-Type: `application/x-x509-ca-cert`
- 需要已生成根证书且代理已启动
- 仅响应非代理风格的直连请求（origin-form），不会拦截代理转发的请求

### `GET /aiproxy-ca.pem`

同 `/aiproxy-ca.crt`，为 PEM 格式证书提供备用路径。

## 6.11 File Import / Export Commands

当前没有注册 `export_sessions` 后端命令。Sessions 导出由前端 `session-export.helpers.ts` 生成 Session Snapshot / HAR / cURL 文本，再通过 `save_text_file` 写入用户 Downloads 目录。

### `save_text_file`

请求：

```ts
type SaveTextFileInput = {
  content: string;
  fileName: string;
  revealInFolder?: boolean;
};
```

响应：

```ts
type SaveTextFileOutput = string; // 写入后的本地路径
```

### `pick_and_read_har_file`

请求：

```ts
type PickHarFileInput = {
  title: string; // 本地化后的文件选择器标题
};
```

响应：

```ts
type HarFileOutput = {
  fileName: string;  // 所选文件名（用于展示）
  contents: string;  // HAR 文件内容
} | null;            // 用户取消选择时返回 null
```

约束：

- 文件选择器由后端拉起，前端只传标题、不接触原始路径（与 `pick_and_read_script_file` 同一安全模型）
- 仅接受 `.har` 扩展名
- 读取后由前端解析并导入为本地会话快照

### `save_response_files`

请求：

```ts
type SaveResponseFilesInput = {
  sessionIds: string[];
  conflictStrategy: "latestOnly" | "keepAll";
  title: string; // 本地化后的目录选择器标题
};
```

响应：

```ts
type SaveResponseFilesOutput = {
  directory: string;    // 用户选中的目标目录（canonical 路径）
  savedCount: number;
  skippedCount: number; // 无响应体 / WebSocket / 后端已无此 id / 被 latestOnly 淘汰
  failedCount: number;  // 读取或写入失败
} | null;               // 用户取消目录选择时返回 null
```

说明：

- 用于会话树目录节点（host 分支与 path 分支）右键的「保存所有文件」，把选中目录下每个请求的响应体按 URL 路径层级还原写入用户选择的目录
- **host 不作为目录**：用户已经指定了落盘位置，再套一层 `example.com/` 只是噪音
- host 以下的 URL 路径**完整保留**：右键 `assets` 确实会得到一个 `assets/` 文件夹；右键哪一层结果都一样，因此同一站点多次保存到同一目录可以自然合并
- 目录层级、文件名、扩展名、去重序号全部由后端从 `ProxySessionSummary.url` 与 `responseMimeType` 推导，前端不参与路径构造
- 响应体在 Rust 侧从 `ProxyBodyReference::read_bytes()` 直接写盘，不经过 base64 与 IPC，二进制文件字节保真

约束：

- 目录选择器由后端拉起，前端只传标题、不接触任何路径（与 `pick_and_read_har_file` 同一 H3 安全模型）
- URL 每一段都经过清洗：拒绝 `..`/`.`、路径分隔符与控制字符，规避 Windows 保留设备名与尾部点/空格，超长段截断并保留扩展名
- 目录深度上限 24 层、单次导出上限 20000 个请求；写入前对解析后的目录再次校验仍位于所选根目录内，防止destination 内既有符号链接改写落点
- URL 已带扩展名时原样保留，无扩展名时按响应 MIME 推导；未知二进制类型落 `bin`（不同于前端面向文本的 `guessExtension` 默认 `txt`）
- query string 不参与路径推导，因此 `?page=1` 与 `?page=2` 会落到同一文件，由 `conflictStrategy` 决定取舍：`latestOnly` 按 `startedAt` 保留最新一次，`keepAll` 以 ` (n)` 后缀全部保留
- WebSocket 会话、无响应体的请求，以及仅存在于渲染层的导入会话（HAR 导入）计入 `skippedCount`

## 6.12 Menu Locale Command

### set_menu_locale

```ts
invoke("set_menu_locale", { preference: "en" | "system" | "zh-CN" }): Promise<void>
```

设置原生（macOS）菜单的显示语言。`preference` 为三态语言偏好：`en` / `system` / `zh-CN`。Rust 侧由 `menu::apply_locale` 持久化偏好到 `menu-locale.json`、经 `sys-locale` 解析 `system`、`rust_i18n::set_locale` 后重建菜单。

**语义：不可失败。** 命令返回 unit，持久化或重建失败仅 `tracing::warn!`，不向 JS reject。

**平台：** 所有平台注册；macOS 重建菜单，Windows/Linux 仅持久化 + set_locale（无原生菜单）。

**持久化：** `<app_data_dir>/menu-locale.json`，内容 `{ "preference": "en" | "system" | "zh-CN" }`，启动期读取并解析。

## 7. Event Specification

## 7.1 会话事件

### `session-upsert`

```ts
type SessionUpsertEvent = SessionSummary;
```

### `session-remove`

```ts
type SessionRemoveEvent = string;
```

### `sessions-cleared`

```ts
type SessionsClearedEvent = void;
```

### `sessions-removed`

```ts
type SessionsRemovedEvent = string[];
```

前端批量化行为：

- `SessionsPage` 对 `session-upsert` 事件采用 100ms 缓冲窗口进行批量合并
- 同一窗口内的多个 upsert 事件会合并为一次状态更新，避免高频事件（如突发流量）触发逐事件的 UI 刷新
- 批量刷新时同步更新 Zustand 容器状态和 React Query 缓存

触发时机：

- `clear_sessions` 清空会话后触发 `sessions-cleared`
- `delete_sessions_except` 批量移除会话后触发 `sessions-removed`

## 7.2 断点事件 — `已实现`

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

### `breakpoint-released` — `已实现`

```ts
type BreakpointReleaseReason = "timeout" | "senderDropped";

type BreakpointReleasedEvent = {
  sessionId: string;
  stage: "request" | "response";
  reason: BreakpointReleaseReason;
};
```

触发时机：

- pending breakpoint 超过 5 分钟等待窗口时
- breakpoint 的 oneshot 发送方被释放 / dropped 时

前端处理：

- `services/events/index.ts` 中的 `onBreakpointReleased()` 订阅此事件
- 事件载荷经过 `parseBreakpointReleased()` 校验后，从 pending hit store 中移除
- 若匹配到对应 hit，前端推送 warning toast，提示该请求已原样放行
- `breakpoint-hit` 事件仍是唯一创建 pending hit 的入口，`breakpoint-released` 只负责收尾

## 7.3 WebSocket 事件 — `已实现`

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

## 7.4 菜单事件

```ts
type MenuEvent = unknown;
```

说明：

- macOS：`menu-event` 由 Tauri 原生菜单层推送，前端通过 `services/events/index.ts` 统一订阅
- Windows / Linux：顶部菜单栏由 React 自绘，菜单项点击直接调用 `AppShell` 的同一套菜单命令分发逻辑，不再依赖原生 Tauri 菜单栏
- 自绘菜单与原生菜单必须保持相同的 `menuId` 语义；新增菜单项时需同时更新 `apps/desktop/src/components/layout/app-shell-windows-menu.definitions.ts` 与 macOS 原生菜单定义（如该项也应出现在 macOS）
- 窗口控制类菜单项（如最小化、最大化、关闭）在 Windows / Linux 通过 Tauri window API 执行，并需要在 `src-tauri/capabilities/default.json` 中声明对应 `core:window:*` 权限
- 当前未注册 `proxy/status_changed`、`rule/matched`、`certificate/status_changed`、`export/progress` 事件；代理状态和证书状态由命令查询，规则命中通过各类 session trace 查询

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
- `session-upsert` 事件在 `SessionsPage` 中以 100ms 间隔批量处理，Zustand 容器状态与 React Query 缓存在同一次批量刷新中同步更新
- `useSessionEvents` hook 已废弃，事件监听与批量合并逻辑已内联至 SessionsPage
- 规则、工作区、证书状态可用 Query 缓存
- 长任务进度以事件流为准，不依赖轮询

## 9. 安全约束

- 命令层必须校验文件路径与工作区归属
- 对证书、密钥、导出路径进行白名单校验
- Body 大文件避免一次性加载到内存
- 日志中默认不打印完整敏感 Body

## 10. 版本策略

### App Build Info

- `get_app_build_info() -> { version: string; buildNumber: string; versionIdentifier: string }`
- `version` 来自应用版本号配置，例如 `0.1.0`。
- `buildNumber` 默认由 `apps/desktop/src-tauri/build.rs` 执行 `git rev-list --count HEAD` 生成；CI 可通过 `AIPROXY_BUILD_NUMBER` 覆盖。
- `versionIdentifier` 使用 `version+buildNumber` 格式，例如 `0.1.0+153`，作为软件构建的唯一标识。
- 原生 About 菜单和 Settings > About 都应展示版本号与 Build Number。

### v1

- 覆盖本地桌面必需命令与实时事件
- 覆盖脚本规则配置接口与会话 trace 查询接口

### v2

- 增加插件注册与生命周期 API
- 增加分析面板聚合查询 API

## 11. Insights Commands — `已实现`

这些命令由 `Insights` 页面调用，基于 SQLite 聚合查询提供流量统计分析。

### Insights 共享类型

```ts
type HostInsight = {
  host: string;
  requestCount: number;
  errorCount: number;
  avgDurationMs: number;
  p95DurationMs: number;
  totalBytes: number;
};

type StatusCodeDistribution = {
  statusCode: number;
  count: number;
};

type MethodDistribution = {
  method: string;
  count: number;
};

type SlowRequest = {
  sessionId: string;
  url: string;
  method: string;
  statusCode: number;
  durationMs: number;
  sizeBytes: number;
};

type InsightsResult = {
  totalRequests: number;
  totalErrors: number;
  errorRate: number;
  avgDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  p99DurationMs: number;
  totalBytes: number;
  byHost: HostInsight[];
  byStatusCode: StatusCodeDistribution[];
  byMethod: MethodDistribution[];
  slowRequests: SlowRequest[];
  largestRequests: SlowRequest[];
};
```

### `get_insights`

请求：

```ts
type GetInsightsInput = {
  sessionIds: string[];       // 需要分析的会话 ID 列表
  excludedHosts?: string[];   // 排除的 host 列表
  hostExact?: string;         // 精确匹配的 host
  hostKeyword?: string;       // host 关键词筛选
};
```

响应：

```ts
type GetInsightsOutput = InsightsResult;
```

实现说明：

- 后端通过 `aiproxy-db` 的 `compute_insights()` 函数执行 SQLite 聚合查询（`crates/db/src/insights.rs`）
- 输入以 `sessionIds` 确定查询范围，支持 `excludedHosts` / `hostExact` / `hostKeyword` 进一步过滤
- `byHost` 按 host 分组聚合请求计数、平均/P95 耗时、错误数和总字节数；按请求计数降序，计数并列时按 host 升序作确定性次级键
- `byStatusCode` 统计各状态码出现次数；按次数降序，并列时按状态码升序
- `byMethod` 统计各 HTTP 方法出现次数；按次数降序，并列时按方法升序
- `slowRequests` 按耗时降序返回最慢的请求；总览态（无 host 过滤）取前 20 条（SQL LIMIT 20），聚焦 host（`hostExact` / `hostKeyword`）时不设上限，用于逐条排障；耗时并列时按 `started_at` 降序、`id` 升序作确定性次级键，保证后端持久化结果与前端实时计算逐项一致、不抖动
- `largestRequests` 按响应字节数降序返回最大的请求；上限规则同 `slowRequests`；字节数并列时的次级键同 `slowRequests`
- `InsightsResult` 包含全局统计：`totalErrors`、`avgDurationMs`、分位数 `p50` / `p95` / `p99`

## 12. Script Rule Commands

- `list_script_rules({ workspaceId }) -> ScriptRule[]`
- `save_script_rule({ input: ScriptRule }) -> ScriptRule`
- `pick_and_read_script_file({ title }) -> { fileName, language, path, sourceCode } | null` — H10（闭合）：脚本文件导入。**后端拥有 OS 文件选择器**——渲染进程只传入本地化的对话框标题（`title`），从不传入路径；Rust 侧驱动 `tauri-plugin-dialog` 弹窗、读取所选文件并返回内容。这彻底消除了「被攻破的渲染进程经 IPC 读任意文件」的原语：渲染进程只能触发弹窗，无法注入路径（选择结果不作为 IPC 输入跨边界）。canonicalize 解析 symlink 防选择后目标被替换。用户取消返回 `null`。
- `list_script_session_trace({ sessionId }) -> ScriptSessionTrace[]`

约束：

- 仅支持单文件 `JS / TS`
- 仅支持 `export function onRequest(ctx) {}` 与 `export function onResponse(ctx) {}`
- 运行时不开放文件系统、网络、模块加载、宿主命令执行
- QuickJS heap 限制为 **16MB** 每次脚本执行，超出此限制的脚本将以 `RuntimeError` 结果失败
- 沙箱使用 QuickJS 默认分配器（rquickjs 未启用 `allocator` feature），以确保可靠的内存追踪

## 13. API Collection Commands — 已实现

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
- `upsert_api_collection({ id?, parentId?, name, description?, sortOrder? }) -> ApiCollection` — 当 `id` 存在且 `parentId` 改变时会进行 cycle check（拒绝把文件夹移到自己的子级）
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

## 14. Environment Commands — 已实现

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

## 15. AI Compare Commands — 已实现发布硬化版

这些命令由 `Compare` 页面和 `Settings > AI Model` 调用。当前仅支持 OpenAI-compatible Chat Completions，API Key 存在本地 SQLite 的 `ai_settings` 表中，前端只接收 masked key。Compare 页面生成的 diff payload 默认脱敏，并带有 Body lazy diff、截断和 binary 状态元数据。

### AI 共享类型

```ts
type AiProviderType = "openai-compatible";

type AiSettingsPublic = {
  provider: AiProviderType;
  baseUrl: string;
  model: string;
  hasApiKey: boolean;
  maskedApiKey?: string;
  temperature: number;
  timeoutMs: number;
  updatedAt?: string;
};

type SaveAiSettingsInput = {
  provider: AiProviderType;
  baseUrl: string;
  model: string;
  apiKey?: string;
  clearApiKey?: boolean;
  temperature: number;
  timeoutMs: number;
};

type SessionDiffChangeKind = "added" | "changed" | "removed" | "unchanged";

type SessionDiffEntry = {
  path: string;
  kind: SessionDiffChangeKind;
  before?: string;
  after?: string;
};

type SessionDiffSection = {
  key: string;
  title: string;
  added: number;
  removed: number;
  changed: number;
  unchanged: number;
  entries: SessionDiffEntry[];
  canExpand?: boolean;
  note?: string;
  totalEntries?: number;
  truncated?: boolean;
  truncationReason?: string;
};
```

`SessionDiffSection` 元数据约定：

- `canExpand`：该 section 可在 UI 中按需展开计算更多上下文，目前主要用于 Body lazy diff。
- `totalEntries`：完整 bounded diff 发现的 entry 数，可能大于当前 `entries.length`。
- `truncated` / `truncationReason`：当前 entries 被上限或 size guard 截断 / 跳过时必须提供可展示原因。
- binary / non-text body 通过 Body section 的 `note` 和 `body.text` metadata entry 表达，不应显示成 “No body captured”。

### AI Settings

- `get_ai_settings() -> AiSettingsPublic`
- `save_ai_settings(input: SaveAiSettingsInput) -> AiSettingsPublic` — 空 `apiKey` 保留旧 key，`clearApiKey` 显式清除 key
- `test_ai_connection() -> { ok: boolean; message: string }`

### AI Diff Summary

- `summarize_session_diff({ payload, language }) -> { summary, model, provider, createdAt }`
- `payload` 为前端生成的 `SessionDiffPayload`，默认已脱敏；后端不读取 session 原始内容，不记录 API Key。
- 后端对序列化后的 payload 有大小上限；超过上限时返回 `AI_PAYLOAD_TOO_LARGE`，用户可关闭 Body context 或选择更小的 sessions。
- `language` 当前为 `en | zh-CN`，用于约束模型输出语言。

## 16. 实现建议

- 所有接口 DTO 维护在 `packages/shared-types/`，按业务域拆分文件，`index.ts` 仅做 barrel re-export
- 用 Zod 或等价 schema 在前端做运行时校验
- Rust 端 Tauri Command Handler 按业务域拆分到 `apps/desktop/src-tauri/src/commands/<domain>.rs`，`commands/mod.rs` 仅做 `mod` 声明和 `pub use` 汇聚；新增命令必须归位到对应业务域文件，不允许写回 `mod.rs` 或 `main.rs`
- 前端命令客户端按业务域拆分到 `apps/desktop/src/services/commands/<domain>.ts`，基础设施（`invokeCommand` 等）放在 `runtime.ts`，`index.ts` 仅做 barrel re-export
- 三层（Rust 命令、前端命令客户端、共享类型）的业务域模块文件名必须保持一一对应，新增业务域需同步建立同名模块
- 事件名保持稳定，避免在 UI 中硬编码字符串分散出现
