# M3：HTTP/2 可用级捕获 — 设计规格

**日期**：2026-05-25
**里程碑**：M3（2026-08）
**版本目标**：`0.4.0-alpha`
**状态**：草稿

## 背景

AIProxy 的代理核心当前全链路仅支持 HTTP/1.1：客户端侧用 `httparse` 解析、上游用 `hyper::client::conn::http1` 转发、响应用原始 `HTTP/1.1 {status}` 字符串写回。整个 `rustls` 配置中没有任何 ALPN 设置。

现代浏览器、移动端 SDK 和微服务普遍默认使用 HTTP/2 over TLS。没有 h2 支持，AIProxy 无法捕获大多数 HTTPS 流量的真实协议，导致它无法作为日常调试工具可靠使用。

协议数据模型已在前一个里程碑中准备就绪：`SessionSummary` 已支持 `httpVersion: "2"`，前端 helper 已能正确展示 "HTTP/2"。本规格覆盖代理层实现，使 HTTP/2 捕获成为现实。

## 设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 客户端侧 h2 技术栈 | hyper server + h2 feature | 利用 hyper 成熟的 h2 帧处理、流量控制和 HPACK。h1/h2 共用统一 Service 处理器。 |
| 上游 h2 技术栈 | 完整 h2 + 连接复用 | 协议行为正确。连接池按 host:port 复用 h2 stream。 |
| 规则引擎范围 | 仅 header 级规则 | h2 DATA 帧 body 改写复杂且风险高。Header 规则、Map、Throttle、Breakpoint、Script header 访问在 http::Request/http::Response 上操作，与线路协议无关。 |
| 架构方式 | 统一 hyper server | h1/h2 共用一个 Service 处理器。ALPN 结果决定使用 h1 还是 h2 server connection。不重复 session 构建逻辑。 |
| 开关 | 设置中可开关 HTTP/2 | 用户可禁用 h2 强制回退 HTTP/1.1 排障。默认开启。 |

## 架构

### 当前流程（仅 HTTP/1.1）

```
客户端 → CONNECT → 代理 → 200 OK → TLS 握手 → httparse 解析请求
  → 规则链 → hyper http1 上游 → 规则链 → 原始 "HTTP/1.1 {status}" 响应 → 客户端
```

### 新流程（h1 + h2 统一）

```
客户端 → CONNECT → 代理 → 200 OK → TLS 握手（ALPN: ["h2","http/1.1"]）
  → 读取 ALPN 协商结果
  → "http/1.1": hyper::server::conn::http1::Builder::serve()
  → "h2":       hyper::server::conn::http2::Builder::serve()
  → 统一 Service<Request> 处理器：
      1. 构建 ProxySessionDetail（h1/h2 共用）
      2. 应用 header 级规则
      3. 通过连接池转发到上游（h2 或 h1）
      4. 应用响应规则
      5. 通过 hyper 返回 Response<Body>
```

### 核心组件

#### 1. MITM Service 处理器

接收来自 h1 或 h2 server connection 的 `hyper::Request<Incoming>`：

- 用共享逻辑构建 `ProxySessionDetail`
- 应用 header 级规则（rewrite headers、map local/remote、DNS mapping、throttle、breakpoint）
- 通过连接池转发到上游
- 应用响应规则
- 返回 `hyper::Response<impl Body>`

HTTP/2 下，每个 stream 调用一次 Service。每个 stream 生成一个独立的 session。Service 不需要管理 stream ID 或流量控制——hyper 内部处理。

#### 2. 上游连接池

按 `(host, port)` 管理 h2 连接复用：

- 上游 TLS 握手后读取 ALPN 结果
- h2：创建 `hyper::client::conn::http2::SendRequest` 并缓存复用
- h1：使用 `hyper::client::conn::http1::handshake()`（不复用——h1 因 Connection: close 每次请求后关闭）
- 空闲连接超时淘汰（默认 60s）
- 通过 `tokio::sync::RwLock` 或 `DashMap` 保证线程安全

`TimingConnector` 升级支持 h1 和 h2 握手路径，保留 timing 采样能力。

#### 3. ALPN 配置

**MITM 服务端 TLS**（`tls-manager/src/generator.rs`）：
- `http2Enabled` 为 true 时通告 `["h2", "http/1.1"]`
- `http2Enabled` 为 false 时仅通告 `["http/1.1"]`

**上游客户端 TLS**（`proxy-core/src/timing_connector.rs`）：
- 通告 `["h2", "http/1.1"]`
- 读取 ALPN 结果决定 h1/h2 上游握手

#### 4. HTTP/2 Session 元数据

h2 stream 产生的 session 携带：
- `httpVersion: "2"`, `transportProtocol: "tcp"`, `applicationProtocol: "http"`
- 伪头（`:method`, `:path`, `:scheme`, `:authority`）存入请求 headers，标记 `isPseudo: true`
- 响应伪头（`:status`）存入响应 headers，标记 `isPseudo: true`
- Trailers 存入新增的 `trailers: HeaderEntry[]` 字段
- Stream ID 存入 `h2StreamId: number` 用于调试

## 数据模型变更

### `SessionDetail`（shared-types, `sessions.ts`）

新增可选字段：

```typescript
trailers?: HeaderEntry[];     // HTTP/2 响应 trailers
h2StreamId?: number;          // 调试用
```

### `HeaderEntry`（shared-types, `sessions.ts`）

新增可选字段：

```typescript
isPseudo?: boolean;  // HTTP/2 伪头标记
```

### `Workspace`（shared-types, `workspaces.ts`）

```typescript
http2Enabled?: boolean;  // 默认 true
```

### `StartProxyInput`（shared-types, `proxy.ts`）

```typescript
enableHttp2?: boolean;
```

### `ProxyStatus`（shared-types, `proxy.ts`）

```typescript
http2Enabled?: boolean;
```

### Rust 侧（`ProxySessionDetail`, `types.rs`）

- 新增 `trailers: Vec<HeaderEntry>` 字段
- 新增 `h2_stream_id: Option<u32>` 字段
- `HeaderEntry.is_pseudo: Option<bool>` 字段
- `build_session_detail()` 在 ALPN 协商为 h2 时填充 `httpVersion: "2"`

## 规则引擎兼容性

### HTTP/2 支持的规则

| 规则 | 说明 |
|------|------|
| Rewrite headers | 操作 http::HeaderMap，与协议无关 |
| Map Local | 返回 mock 响应，无需上游 |
| Map Remote | 改写 URL，切换上游目标 |
| DNS Mapping | 连接前修改上游 IP |
| Throttle | tokio sleep + body 分块 |
| Breakpoint | 拦截请求/响应，用户裁决 |
| Script rules（header） | ctx.request.setHeader()、ctx.response.setHeader() |

### HTTP/2 不支持的规则

| 规则 | 行为 |
|------|------|
| Rewrite body | 跳过，写 trace：`body_rewrite_skipped, reason: http2_body_rules_not_supported` |
| Script rules（body 写入） | setText()/setJson() 打印警告并跳过。getText()/getJson() 仍可读取。 |

### Trace 消息格式

```json
{
  "action": "body_rewrite_skipped",
  "reason": "http2_body_rules_not_supported",
  "level": "warn"
}
```

在 Session Inspector 的 trace 面板中可见。

## 前端变更

### 设置页：HTTP/2 开关

在 `ProxySettingsSection` 新增开关：
- 标签："HTTP/2 支持"（i18n: `settings.proxy.http2Enabled`）
- 默认：开启
- 关闭时代理仅通告 `["http/1.1"]` ALPN
- i18n 同步更新 `en.ts` 和 `zh-CN.ts`

### Session Inspector

- **伪头**：Headers 标签页中用视觉标记（斜体或 badge）区分。前端检测 `isPseudo: true` 标志。
- **Trailers**：响应区新增 "Trailers" 子标签页。仅当 `detail.trailers` 非空时显示。
- **协议显示**：无需改动——`formatSessionProtocol()` 已能渲染 "HTTP/2"。

### HAR 导入修复

`session-import.helpers.ts`：
- 读取 HAR 条目中的 `entry.request.httpVersion` 和 `entry.response.httpVersion`
- 通过 `resolveHttpVersion()` 将 `"HTTP/2"` 映射为 `httpVersion: "2"`
- 当前硬编码 `"1.1"` 属于 bug

### 协议过滤

- 将 `protocol` 和 `httpVersion` 加入 `matchesKeyword` 搜索范围
- 输入 "h2" 或 "HTTP/2" 可匹配 HTTP/2 session

### 诊断

- HTTP/2 协商失败：记录日志，包含 ALPN 结果和回退行为
- UI toast 提示："{host} 的 HTTP/2 协商失败，回退到 HTTP/1.1"（非阻塞）
- 代理状态新增 `http2NegotiationErrors` 计数器

## 实现阶段

### 阶段 1：基础

**目标**：ALPN 配置生效，h2 依赖到位，设置 UI 可用。

变更：
- `crates/proxy-core/Cargo.toml`：启用 hyper http2 feature，添加 h2 crate
- `crates/tls-manager/src/generator.rs`：服务端 TLS 配置添加 ALPN（根据 http2Enabled 条件）
- `crates/proxy-core/src/timing_connector.rs`：上游客户端 TLS 配置添加 ALPN
- `packages/shared-types/src/workspaces.ts`：添加 `http2Enabled?: boolean`
- `packages/shared-types/src/proxy.ts`：添加 `enableHttp2?: boolean` 和 `http2Enabled?: boolean`
- `apps/desktop/src/pages/settings/index.tsx`：添加 HTTP/2 开关
- i18n 文件：添加设置相关 key

**检查点**：代理启动时通告 ALPN。h2 连接优雅回退。

### 阶段 2：客户端侧 h2 Server

**目标**：客户端 HTTP/2 请求被捕获为 session。

变更：
- `crates/proxy-core/src/server.rs`：重构 `handle_connect_mitm()`，使用 hyper server connection
  - TLS 握手后读取 ALPN 结果
  - 分支到 `hyper::server::conn::http1::Builder` 或 `http2::Builder`
  - 实现统一 Service 处理器
- `crates/proxy-core/src/types.rs`：添加 trailers、h2_stream_id、is_pseudo 字段
- `packages/shared-types/src/sessions.ts`：添加 `trailers`、`h2StreamId`、`isPseudo` 字段
- `crates/db/src/sessions.rs`：持久化新字段

**检查点**：Chrome/curl h2 HTTPS 请求以 session 形式出现，含 headers、body、正确的 `httpVersion: "2"`。

### 阶段 3：上游 h2 + 连接池

**目标**：代理通过 h2 转发请求到上游，支持连接复用。

变更：
- `crates/proxy-core/src/timing_connector.rs`：支持 h2 握手路径，读取上游 ALPN
- 新增 `crates/proxy-core/src/upstream_pool.rs`：连接池，按 (host, port) 管理
  - 缓存 h2 SendRequest
  - 空闲超时淘汰
- `crates/proxy-core/src/server.rs`：更新 `forward_request()` 使用连接池
- h1/h2 上游路径均保留 timing 采样

**检查点**：端到端 h2。客户端与代理协商 h2，代理与上游协商 h2，stream 复用生效。

### 阶段 4：收尾打磨

**目标**：规则、HAR、诊断、所有验收标准。

变更：
- 规则引擎：header 级规则在 h2 session 上生效。body 规则生成 trace 消息。
- `session-import.helpers.ts`：读取 HAR httpVersion
- `session-explorer.helpers.ts`：协议字段加入搜索范围
- `SessionInspectorOverview.tsx`：伪头样式
- 新增 trailers 标签页组件
- 协商失败的诊断日志和 UI toast
- 所有新文案的 i18n

**检查点**：所有 M3 验收标准达成。

## 验收标准

1. Chrome / curl / 常见移动端 SDK 的 HTTPS HTTP/2 请求可被捕获并显示为独立 session。
2. HTTP/2 伪头（`:method`、`:path`、`:scheme`、`:authority`）和响应伪头（`:status`）在 Inspector 中可见。
3. HTTP/2 trailers 保留并在专用标签页中可见。
4. HAR 导出中 h2 session 的 HTTP version 正确。
5. HAR 导入读取条目中的 `httpVersion` 而非硬编码 "1.1"。
6. 设置中的 HTTP/2 开关可禁用 h2 ALPN，强制回退 HTTP/1.1，不影响现有 h1 抓包。
7. Header 级规则（rewrite、map、throttle、breakpoint）在 h2 session 上工作。
8. Body rewrite 规则在 h2 下跳过时生成明确的 trace 消息。
9. HTTP/2 协商失败时生成诊断日志和 UI 通知。
10. WebSocket 和 HTTP/1.1 流量不受 h2 支持影响。

## 不做

- HTTP/3 / QUIC 捕获
- h2 下 body rewrite 完整兼容
- 完整 gRPC message inspector（M4）
- 上游 h2 连接池调优
- HTTP/2 server push（实际已废弃）
- HTTP/2 优先级/依赖处理

## 关键文件

| 文件 | 变更类型 |
|------|---------|
| `crates/proxy-core/Cargo.toml` | 依赖更新 |
| `crates/proxy-core/src/server.rs` | 重大重构 |
| `crates/proxy-core/src/timing_connector.rs` | 增加 h2 支持 |
| `crates/proxy-core/src/upstream_pool.rs` | 新增模块 |
| `crates/proxy-core/src/types.rs` | 新增 h2 字段 |
| `crates/proxy-core/src/rules.rs` | 新增 h2 trace 消息 |
| `crates/tls-manager/src/generator.rs` | 添加 ALPN 配置 |
| `crates/db/src/sessions.rs` | 持久化 h2 字段 |
| `packages/shared-types/src/sessions.ts` | 新增 h2 字段 |
| `packages/shared-types/src/proxy.ts` | 新增 http2 开关 |
| `packages/shared-types/src/workspaces.ts` | 新增 http2 开关 |
| `apps/desktop/src/pages/settings/index.tsx` | 新增 HTTP/2 开关 |
| `apps/desktop/src/features/sessions/session-import.helpers.ts` | 修复 HAR 导入 |
| `apps/desktop/src/features/sessions/session-explorer.helpers.ts` | 增加协议过滤 |
| `apps/desktop/src/features/sessions/components/SessionInspectorOverview.tsx` | 伪头展示 |
| `apps/desktop/src/i18n/messages/en.ts` | 新增 key |
| `apps/desktop/src/i18n/messages/zh-CN.ts` | 新增 key |
