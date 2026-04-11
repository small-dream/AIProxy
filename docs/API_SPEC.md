# Pharles API Specification

## 1. 文档信息

- 产品代号：`Pharles`
- 文档类型：接口规范文档
- 当前阶段：`Phase 1 / 初始化设计`
- 文档状态：`Draft v1.0`
- 关联文档：
  - `docs/PRD.md`
  - `docs/ARCHITECTURE.md`

## 2. 设计原则

Pharles 为桌面端应用，不采用传统远程 HTTP API 作为主交互形式，而采用以下双通道接口模型：

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
- 管理工作区
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

## 5.1 Workspace

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

## 5.2 ProxyStatus

```ts
type ProxyStatus = {
  running: boolean;
  port: number;
  sslEnabled: boolean;
  systemProxyEnabled: boolean;
  activeWorkspaceId?: string;
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

## 5.5 Rule Models

```ts
type MatchExpression = {
  hostContains?: string;
  pathContains?: string;
  methodIn?: string[];
  statusCodeIn?: number[];
  urlRegex?: string;
};

type BreakpointRule = {
  id: string;
  workspaceId: string;
  name: string;
  enabled: boolean;
  matchExpression: MatchExpression;
  breakStage: "request" | "response";
  actionPolicy: "inspect" | "edit" | "drop" | "mock";
  priority: number;
};

type RewriteRule = {
  id: string;
  workspaceId: string;
  name: string;
  enabled: boolean;
  matchExpression: MatchExpression;
  rewriteType: "header" | "query" | "body" | "redirect";
  rewritePayload: Record<string, unknown>;
  priority: number;
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

## 6. Command Specification

## 6.1 Proxy Commands

### `start_proxy`

用途：

- 启动本地代理服务

请求：

```ts
type StartProxyInput = {
  workspaceId: string;
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
- 工作区不存在
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

## 6.2 Workspace Commands

### `list_workspaces`

响应：

```ts
type ListWorkspacesOutput = Workspace[];
```

### `create_workspace`

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

### `load_workspace`

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

### `update_workspace`

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

## 6.4 Compose / Repeat Commands

### `repeat_session`

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

### `send_composed_request`

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

响应：

```ts
type SendComposedRequestOutput = {
  sessionId: string;
};
```

## 6.5 Rule Commands

### `list_breakpoint_rules`

请求：

```ts
type ListBreakpointRulesInput = {
  workspaceId: string;
};
```

响应：

```ts
type ListBreakpointRulesOutput = BreakpointRule[];
```

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

### `delete_rule`

请求：

```ts
type DeleteRuleInput = {
  ruleType: "breakpoint" | "rewrite" | "map";
  ruleId: string;
};
```

响应：

```ts
type DeleteRuleOutput = {
  success: boolean;
};
```

## 6.6 Breakpoint Runtime Commands

### `resume_breakpoint`

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

## 6.9 Export Commands

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

### `session/created`

```ts
type SessionCreatedEvent = SessionSummary;
```

### `session/updated`

```ts
type SessionUpdatedEvent = SessionSummary;
```

### `session/removed`

```ts
type SessionRemovedEvent = {
  sessionId: string;
};
```

## 7.3 断点事件

### `breakpoint/paused`

```ts
type BreakpointPausedEvent = {
  pauseId: string;
  sessionId: string;
  stage: "request" | "response";
  requestHeaders: HeaderEntry[];
  responseHeaders?: HeaderEntry[];
  requestBody?: string;
  responseBody?: string;
};
```

## 7.4 规则事件

### `rule/matched`

```ts
type RuleMatchedEvent = {
  sessionId: string;
  ruleType: "breakpoint" | "rewrite" | "map";
  ruleId: string;
  ruleName: string;
};
```

## 7.5 导出事件

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
- 不引入脚本运行接口

### v2

- 增加脚本化规则 API
- 增加插件注册与生命周期 API
- 增加分析面板聚合查询 API

## 11. 实现建议

- 在 `packages/shared-types/` 维护所有接口 DTO
- 用 Zod 或等价 schema 在前端做运行时校验
- Rust 侧以模块拆分 Command Handler，避免 `main.rs` 过大
- 事件名保持稳定，避免在 UI 中硬编码字符串分散出现
