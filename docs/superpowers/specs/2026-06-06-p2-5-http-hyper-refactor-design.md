# P2.5：明文 HTTP 解析路径 hyper 化 — 设计文档

**日期**: 2026-06-06
**状态**: ✅ 实现完成，通过 63 个单元测试，0 warnings

---

## 1. 背景与动机

当前 AIProxy 的纯 HTTP（非 CONNECT）代理请求解析使用 `httparse` 手动实现：

- `read_proxy_request_from_stream` (~175 行)：手动读取 TCP stream、解析请求行/header、处理 Content-Length 和 chunked body
- `check_transfer_encoding`、`read_chunked_body`、`read_exact_from`、`read_chunk_line`、`read_chunk_trailer`、`read_trailer_line` (~280 行)：手动 chunked 传输解码

而 HTTPS MITM 路径使用 hyper server connection 自动完成上述所有解析。两条路径在请求解析后产生相同的 `ParsedProxyRequest`，经过大量重复的规则/断点/限速逻辑，最终调用同一个 `forward_request()`。

**目标**：将纯 HTTP 路径也迁移到 hyper server 模型，统一请求解析、body 读取、超时、大小限制和 raw message 生成，消除两条路径间的重复代码。

---

## 2. 当前架构

```
┌─ 纯 HTTP ─────────────────────────────────────┐
│  TcpStream                                     │
│    │ read_proxy_request_from_stream()          │
│    │   ├─ httparse::Request (手动解析)          │
│    │   ├─ read_chunked_body() (手动chunked)     │
│    │   └─ Content-Length body (手动读取)        │
│    ▼                                            │
│  ParsedProxyRequest                            │
│    │ handle_connection() 内联:                   │
│    │   ├─ 规则应用                              │
│    │   ├─ 断点/限速                             │
│    │   ├─ forward_request()                     │
│    │   └─ 手动写 HTTP/1.1 响应到 TcpStream       │
│    ▼                                            │
│  响应写回客户端                                   │
└────────────────────────────────────────────────┘

┌─ HTTPS MITM ──────────────────────────────────┐
│  TlsStream                                     │
│    │ hyper::server::conn::http1/http2          │
│    ▼                                            │
│  MitmService::call(hyper::Request<Incoming>)   │
│    │ handle_mitm_request()                      │
│    │   ├─ 构建 ParsedProxyRequest               │
│    │   ├─ 规则应用                              │
│    │   ├─ 断点/限速                             │
│    │   ├─ forward_request()                     │
│    │   └─ 构建 hyper::Response                  │
│    ▼                                            │
│  hyper server 自动写回响应                       │
└────────────────────────────────────────────────┘
```

**关键发现**：两条路径在「规则应用、断点、限速、forward_request、session 构建」上有大量重复代码（`handle_connection` 约 500 行 vs `handle_mitm_request` 约 400 行）。

---

## 3. 目标架构

```
┌─ 纯 HTTP ───────────────────────────────────────────┐
│  TcpStream                                            │
│    │ read_header_only() 探测 CONNECT / CA cert         │
│    │ 只读 header, 不读 body                             │
│    │ 返回 (request, consumed_bytes, leftover_bytes)     │
│    ▼                                                   │
│  ┌─ CA cert? → 直接写响应后关闭 stream                   │
│  ├─ CONNECT? → PrefixedStream(leftover, stream)        │
│  │             tunnel / MITM (回注 TLS 字节)             │
│  └─ 非 CONNECT:                                        │
│       │ PrefixedStream(consumed + leftover, stream)     │
│       │ 回注完整 HTTP request (hyper 需要)               │
│       │ hyper::server::conn::http1::Builder             │
│       │   .serve_connection(io, service)                │
│       │   .with_upgrades()                              │
│       ▼                                                 │
│  HttpProxyService::call(hyper::Request<Incoming>)       │
│    │ handle_http_request(req, ctx)                      │
│    │   ├─ 构建 ParsedProxyRequest                       │
│    │   ├─ 规则应用 / 断点 / 限速 (共享)                  │
│    │   ├─ forward_request()                             │
│    │   └─ 构建 hyper::Response                          │
│    ▼                                                    │
│  hyper server 自动写回响应                               │
└────────────────────────────────────────────────────────┘

┌─ HTTPS MITM ───────────────────────────────────────┐
│  TlsStream                                           │
│    │ hyper::server::conn::http1/http2                │
│    │   .serve_connection(io, service)                │
│    │   .with_upgrades()   (http1 only)               │
│    ▼                                                  │
│  HttpProxyService::call(hyper::Request<Incoming>)     │
│    │ handle_http_request(req, ctx)  ← 同一函数         │
│    │   (ctx.mode = MitmHttps { host, port, ... })     │
│    ▼                                                  │
│  hyper server 自动写回响应                             │
└──────────────────────────────────────────────────────┘
```

**核心变化**：
- 两条路径使用同一个 `HttpProxyService` + `handle_http_request`
- `ConnectionContext` 使用 `ConnectionMode` enum 区分 plain/mitm，而非散落的 `Option<T>` 字段
- 删除 ~280 行手动 chunked 解析代码（`read_chunked_body` 等），保留 ~60 行 header-only 探测函数
- `PrefixedStream` 保留为共享 IO 工具，同时服务于首包回注和 WebSocket relay
- per-request timing（`started_at`/`started_at_instant`）在 `handle_http_request` 内部生成，不放入连接级 context
- `read_header_only()` 返回三元素元组 `(request, consumed, leftover)`；按分支回注：CONNECT 用 `leftover`，非 CONNECT 用 `consumed + leftover`，CA cert 不回注直接关闭

---

## 4. 关键协议边界

### 4.1 `read_header_only()` — 首包探测协议

```rust
/// Header-only probe to detect CONNECT / CA cert requests.
///
/// Reads from the stream until `\r\n\r\n` is found, then parses the
/// request line and headers via httparse. Does NOT read the body.
///
/// Returns:
/// - `request`  — ParsedProxyRequest with method, path, URL, headers (body is empty)
/// - `consumed`  — all raw bytes read from the stream up to and including `\r\n\r\n`
/// - `leftover`  — any bytes read PAST the header terminator (body prefix, TLS
///                  ClientHello for CONNECT, or pipelined next request)
///
/// The caller MUST replay the consumed bytes before any subsequent IO.
/// Which bytes to replay depends on the branch:
///   - CONNECT / MITM / tunnel: replay only `leftover` (TLS acceptor must not
///     see CONNECT header bytes).
///   - Non-CONNECT (hyper): replay `[consumed, leftover].concat()` — hyper
///     needs the COMPLETE HTTP request including request line + headers.
///   - CA cert: neither is replayed — `stream` is used directly, then closed.
async fn read_header_only<S: AsyncReadExt + AsyncWriteExt + Unpin>(
    stream: &mut S,
) -> Result<(ParsedProxyRequest, Vec<u8>, Vec<u8>), String> {
    // Reads chunks until \r\n\r\n found (MAX_HEADER_BYTES limit, CLIENT_HEADER_READ_TIMEOUT).
    // Parses request line + headers via httparse (no body parsing).
    // Returns (request, all_bytes_read, bytes_after_header_end).
}
```

**关键约束**：`read_header_only()` 在一次 `read()` 可能多读到 header 后的字节（TCP buffer 特性）。四个分支的回注字节不同：

| 分支 | 回注内容 | 原因 |
|------|---------|------|
| CA cert | 不回注，直接用 `stream` 写 cert 后关闭 | GET 无 body，不需要后续 IO |
| CONNECT → tunnel | `leftover` | TLS ClientHello 字节；TLS acceptor 不能看到 CONNECT header |
| CONNECT → MITM | `leftover` | 同上 |
| 非 CONNECT | `[consumed, leftover].concat()` | hyper 必须看到完整 HTTP request（request line + headers + body prefix） |

### 4.2 URL 构建规则

**Plain HTTP (ConnectionMode::PlainHttp)**：

代理请求的 request-target 有两种合法形式：

| 形式 | 示例 | 处理 |
|------|------|------|
| absolute-form | `GET http://example.com/path HTTP/1.1` | 原样使用，保留 scheme + authority + path |
| origin-form | `GET /path HTTP/1.1` | 从 Host header 重建：`http://<Host>/path` |

```rust
fn build_url_from_hyper(parts: &Parts, mode: &ConnectionMode) -> Result<Url, String> {
    match mode {
        ConnectionMode::PlainHttp => {
            let uri_str = parts.uri.to_string();
            if uri_str.starts_with("http://") || uri_str.starts_with("https://") {
                // absolute-form — use as-is
                Url::parse(&uri_str)
            } else {
                // origin-form — reconstruct from Host header
                let host = parts.headers.get("host")
                    .and_then(|v| v.to_str().ok())
                    .ok_or("Host header required for origin-form")?;
                Url::parse(&format!("http://{host}{uri_str}"))
            }
        }
        ConnectionMode::MitmHttps { host, port, alpn_protocol, .. } => {
            if alpn_protocol.as_deref() == Some("h2") {
                // h2: :authority + :path pseudo-headers
                let authority = parts.uri.authority()
                    .map(|a| a.as_str()).unwrap_or(host);
                let path = parts.uri.path_and_query()
                    .map(|pq| pq.as_str()).unwrap_or("/");
                Url::parse(&format!("https://{authority}{path}"))
            } else {
                // h1 MITM: URI may be origin-form or absolute-form
                let uri_str = parts.uri.to_string();
                if uri_str.starts_with("http://") || uri_str.starts_with("https://") {
                    Url::parse(&uri_str)
                } else if uri_str.starts_with('/') {
                    // origin-form — host priority: URI authority > Host header > CONNECT host
                    let authority = parts.uri.authority().map(|a| a.as_str());
                    let host_header = parts.headers.get("host")
                        .and_then(|v| v.to_str().ok());
                    let effective_host = authority.or(host_header).unwrap_or(host);
                    Url::parse(&format!("https://{effective_host}{uri_str}"))
                } else {
                    // authority-form (unlikely for MITM after CONNECT)
                    Url::parse(&format!("https://{uri_str}/"))
                }
            }
        }
    }
    .map_err(|e| format!("invalid URL: {e}"))
}
```

### 4.3 hyper 1 `.with_upgrades()` API 正确调用方式

在 hyper 1.x 中，`.with_upgrades()` 是在 `serve_connection` 返回的 `Connection` future 上调用的，**不是**在 `Builder` 上调用的：

```rust
// ✅ 正确：在 serve_connection 返回值上调用 .with_upgrades()
hyper::server::conn::http1::Builder::new()
    .serve_connection(io, service)
    .with_upgrades()
    .await

// ❌ 错误：Builder 上没有 .with_upgrades() 方法
// hyper::server::conn::http1::Builder::new()
//     .with_upgrades()                      // 编译错误!
//     .serve_connection(io, service)
```

### 4.4 请求 body 大小限制语义

`http_body_util::Limited` 用于请求 body 时：**超过限制 → 报错，不是截断**。

```rust
// 在 handle_http_request 中读取请求 body：
let limited_body = http_body_util::Limited::new(body, MAX_REQUEST_BODY_BYTES);
let body_bytes = BodyExt::collect(limited_body)
    .await
    .map_err(|e| format!("request body exceeds max size or read failed: {e}"))?
    .to_bytes();
```

这与当前源码行为一致（`read_content_length` 中 `len > MAX_REQUEST_BODY_BYTES` 返回错误）。

响应 body 则不同——`read_hyper_response_body_with_limit` 是截断 + spool 到磁盘，语义不变。

### 4.5 WebSocket Upgrade 处理（已实现）

**流程**：

1. **`handle_http_request` 入口处**：检测 `Upgrade: websocket` + `Connection: upgrade`，通过 `hyper::upgrade::on(&mut req)` 捕获 `OnUpgrade`（不消费 `Request`），设置 `ws_on_upgrade: Option<OnUpgrade>` 标志。
2. **正常构建 `ParsedProxyRequest`**：`req.into_parts()` → body 读取 → URL 构建 → header 处理。
3. **运行完整 request-stage 管线**：rules → scripts → breakpoint → pending session → request throttle。
4. **WS 分流点**（request throttle 之后）：仅在 `ws_on_upgrade.is_some() && local_response.is_none()` 时进入 `handle_ws_upgrade_via_hyper`。若已被 local response 处理则走正常响应管线。
5. **`handle_ws_upgrade_via_hyper(on_upgrade, request, ctx, ...)`**：
   - 连接上游（`WsUpstream` enum：`Plain` 为 TCP，`Tls` 为 tokio-rustls）
   - 发送 raw upgrade 请求 → 读取上游响应 → `parse_upstream_response_head()` 解析状态码和 header
   - 上游返回 **101** + 含 `Upgrade` header：构建 session（含上游 101 响应头）→ 注册全局 WS registry → 构建 101 `hyper::Response`（透传 `Sec-WebSocket-Accept` 等上游头 + 显式设置 `Connection: upgrade`）→ `tokio::spawn` 双向 frame relay
   - 上游返回 **非 101**：返回上游错误响应（状态码 + 实际 body 长度，去掉上游 `Content-Length` 防客户端 hang）
6. **Drop 语义**：`handle_drop_action(ctx)` 按 `ConnectionMode` 分支 — `PlainHttp` 返回 `Err` 使 hyper 关闭连接（等同于旧 `stream.shutdown()`）；`MitmHttps` 返回 204 No Content

**`ws://` / `wss://` absolute-form 支持**：`resolve_target_url` 和 `build_url_from_hyper` 均识别 `ws://`、`wss://` scheme，作为 absolute-form URL 原样保留。

---

## 5. 模块设计

### 5.1 新增: `connection.rs` — `ConnectionContext` + `ConnectionMode`

```rust
/// Distinguishes plain HTTP from MITM HTTPS at the type level.
/// URL construction, protocol string, pseudo-header synthesis,
/// and TLS metadata all branch on this enum.
#[derive(Debug, Clone)]
pub(crate) enum ConnectionMode {
    PlainHttp,
    MitmHttps {
        host: String,               // CONNECT target host
        port: u16,                  // CONNECT target port
        tls_protocol: Option<String>,
        tls_cipher_suite: Option<String>,
        tls_ms: u128,
        alpn_protocol: Option<String>,  // "h2" | "http/1.1" | None
    },
}

impl ConnectionMode {
    /// The protocol string stored in ParsedProxyRequest.protocol.
    pub(crate) fn protocol(&self) -> &str {
        match self {
            ConnectionMode::PlainHttp => "http",
            ConnectionMode::MitmHttps { alpn_protocol, .. } => {
                if alpn_protocol.as_deref() == Some("h2") { "h2" } else { "https" }
            }
        }
    }

    /// Whether this connection uses HTTP/2 (h2 ALPN negotiated).
    pub(crate) fn is_h2(&self) -> bool {
        matches!(self, ConnectionMode::MitmHttps { alpn_protocol: Some(a), .. } if a == "h2")
    }
}
```

```rust
/// Per-connection state shared across all requests on this connection.
/// Per-request state (timing, request_id) is NOT stored here —
/// it is created inside HttpProxyService::call for each request.
pub(crate) struct ConnectionContext {
    pub mode: ConnectionMode,
    pub client_addr: SocketAddr,
    pub session_sender: mpsc::Sender<ProxySessionDetail>,
    pub ws_message_sender: mpsc::Sender<WsMessageData>,
    pub rewrite_manager: Option<Arc<RewriteManager>>,
    pub map_manager: Option<Arc<MapManager>>,
    pub script_manager: Option<Arc<ScriptManager>>,
    pub throttle_manager: Option<Arc<ThrottleManager>>,
    pub breakpoint_manager: Option<Arc<BreakpointManager>>,
    pub dns_manager: Option<Arc<DnsManager>>,
    pub workspace_id: String,
    pub event_emitter: Option<BreakpointEventEmitter>,
    pub upstream_pool: Arc<UpstreamConnectionPool>,
}
```

**设计要点**：
- `ConnectionMode` 用 enum 而非散落 `Option<T>`，URL 构建、protocol 字符串、pseudo-header 合成全部显式分支，编译期保证不会把 plain HTTP 按 `https://` 重建 URL
- `started_at`/`started_at_instant` 不在 `ConnectionContext` 中——每个请求在 `HttpProxyService::call` 中独立生成，keep-alive 下多个请求互不污染

### 5.2 新增: `http_proxy.rs` — `HttpProxyService` + `handle_http_request`

**`HttpProxyService`** — 实现 `hyper::Service` trait：

```rust
pub(crate) struct HttpProxyService {
    pub ctx: Arc<ConnectionContext>,
}

impl hyper::service::Service<hyper::Request<hyper::body::Incoming>> for HttpProxyService {
    type Response = hyper::Response<BoxBody<Bytes, String>>;
    type Error = String;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn call(&self, req: hyper::Request<hyper::body::Incoming>) -> Self::Future {
        let ctx = self.ctx.clone();
        Box::pin(async move {
            // Per-request timing — NOT from connection context
            let started_at = Utc::now();
            let started_at_instant = Instant::now();
            handle_http_request(req, &ctx, started_at, started_at_instant).await
        })
    }
}
```

**`handle_http_request`** — 合并自 `handle_mitm_request` + `handle_connection` 的非 CONNECT 部分：

1. 检测 WebSocket upgrade → 委托给 `handle_ws_upgrade_via_hyper()`（先通过 `&mut req` capture `OnUpgrade`，再 `req.into_parts()`）
2. 从 hyper Request + `ConnectionMode` 构建 `ParsedProxyRequest`
   - body 通过 `http_body_util::Limited` 限制到 `MAX_REQUEST_BODY_BYTES`（超过报错）
   - URL 构建依据 `ConnectionMode` 和 §4.2 的规则（absolute-form / origin-form / h2 pseudo-headers）
3. 应用请求规则（rewrite, map, throttle）
4. 请求阶段断点
5. 发送 pending session
6. 转发上游（`forward_request()`）或使用本地响应
7. 应用响应规则
8. 响应阶段断点
9. 构建 session detail 并发送（使用 per-request timing）
10. 返回 `hyper::Response`

**辅助函数**（从 `mitm_service.rs` 迁移并修正）：
- `build_url_from_hyper(parts, mode)` — 支持 absolute-form / origin-form / h2，按 mode 正确选择 scheme
- `build_upstream_headers_from_hyper()` — 过滤伪头部和 hop-by-hop 头
- `build_hyper_response_from_upstream()` — 构建 hyper Response
- `build_plain_text_response()` — 错误响应
- `build_empty_response()` — 空响应
- `build_throttle_failure_response()` — 限速失败响应
- `send_session()` — 发送 session detail
- `PendingRequestCancellationGuard` — 请求取消兜底

### 5.3 保留: `PrefixedStream` 作为共享 IO 工具

`PrefixedStream` **不删除**。从 `server.rs` 移到 `http_io.rs`（新建），作为共享工具模块。两个用途：

1. **首包回注**：`read_header_only` 返回的 `consumed + leftover` 通过 `PrefixedStream` 回注给后续 IO（CONNECT 只回注 `leftover`，非 CONNECT 回注 `consumed + leftover`）
2. **WebSocket relay**：`handle_https_websocket_upgrade` 中回注 101 响应后的剩余上游字节（已存在）

补充 `PrefixedStream` 的单元测试：empty prefix、partial read、exact prefix consumption。

### 5.4 修改: `server.rs`

**删除**：
- `read_chunked_body()`、`read_exact_from()`、`read_chunk_line()`、`read_chunk_trailer()`、`read_trailer_line()` (~220 行) — hyper 替代
- `check_transfer_encoding()` (~60 行) — hyper 替代
- `handle_http_websocket_upgrade()` (~195 行) — 移到 `http_proxy.rs` 用 hyper upgrade 重写
- `handle_connection` 中非 CONNECT 分支的规则/断点/forward/响应写回逻辑 (~600 行) — 合并到 `handle_http_request`

**保留并修正**：
- `read_proxy_request()` / `read_proxy_request_from_stream()` → **重命名并简化为 `read_header_only()`**：
  - 只读 header（遇到 `\r\n\r\n` 即停止），不读 body
  - **返回值 `(ParsedProxyRequest, Vec<u8> consumed, Vec<u8> leftover)`**
  - `consumed` = 从 stream 读取的全部原始字节（含 `\r\n\r\n`）
  - `leftover` = header 终止符之后的字节（可能非空，TCP buffer 可能一次性读到 body/TLS 数据）
  - 所有分支都必须通过 `PrefixedStream` 回注正确的字节：CA cert 直接关闭；CONNECT 回注 `leftover`；非 CONNECT 回注 `consumed + leftover`

**保留不变**：
- `start_proxy_server()` — 不变
- `tunnel_blind_relay()` — 参数改为接受已回注的 stream
- `forward_request()` — 不变
- `build_upstream_response_from_hyper()` — 不变
- `read_hyper_response_body_with_limit()`、`read_response_body_with_limit()` — 不变
- `write_upstream_response()`、`write_plain_text_response()` — 保留（CA cert / 本地 mock 回退用）
- `write_spooled_upstream_response()` — 不变
- `build_raw_upgrade_request()`、`handle_https_websocket_upgrade()` — 保留（MITM WebSocket）

**`handle_connection` 改造后**：

```rust
async fn handle_connection(
    mut stream: TcpStream,
    client_addr: SocketAddr,
    ...
) -> Result<(), String> {
    // Header-only probe — reads until \r\n\r\n, returns (request, consumed, leftover).
    // consumed = full header bytes (up to and including \r\n\r\n).
    // leftover = bytes accidentally read past the header (body/TLS ClientHello).
    let (mut request, consumed, leftover) = match read_header_only(&mut stream).await {
        Ok(result) => result,
        Err(error) => {
            write_plain_text_response(&mut stream, StatusCode::BAD_REQUEST, ...).await?;
            return Ok(());
        }
    };
    request.client_address = Some(client_addr.to_string());

    // CA cert serving — write directly, then close (GET has no body)
    if request.method == Method::GET
        && (request.path == "/aiproxy-ca.crt" || request.path == "/aiproxy-ca.pem")
    {
        // ... write cert response to stream ...
        let _ = stream.shutdown().await;
        return Ok(());
    }

    // CONNECT dispatch — replay ONLY leftover (TLS ClientHello bytes).
    // TLS acceptor must NOT see the CONNECT request header.
    if request.method == Method::CONNECT {
        let prefixed = PrefixedStream::new(leftover, stream);
        if tls_manager.is_none() {
            return tunnel_blind_relay(prefixed, &host, port, ...).await;
        } else {
            return handle_connect_mitm(prefixed, host, port, mgr, ...).await;
        }
    }

    // === Non-CONNECT: hand off to hyper server ===
    // hyper needs the COMPLETE HTTP request — replay consumed + leftover.
    let ctx = Arc::new(ConnectionContext {
        mode: ConnectionMode::PlainHttp,
        client_addr,
        session_sender,
        // ... other fields ...
    });

    let service = HttpProxyService { ctx };
    let mut prefix = consumed;
    prefix.extend_from_slice(&leftover);
    let io = hyper_util::rt::TokioIo::new(PrefixedStream::new(prefix, stream));

    hyper::server::conn::http1::Builder::new()
        .serve_connection(io, service)
        .with_upgrades()   // ← on the Connection future, not the Builder
        .await
        .map_err(|e| format!("HTTP/1.1 server error: {e}"))?;

    Ok(())
}
```

### 5.5 `handle_connect_mitm` 改造

```rust
async fn handle_connect_mitm(
    stream: impl AsyncRead + AsyncWrite + Unpin + Send + 'static,  // 泛化，接受 PrefixedStream
    ...
) -> Result<(), String> {
    // Send 200 ... (unchanged)
    // TLS accept ... (unchanged)
    // Build ConnectionContext with ConnectionMode::MitmHttps { ... }
    // Use HttpProxyService instead of MitmService:

    let io = hyper_util::rt::TokioIo::new(tls_stream);
    let service = HttpProxyService { ctx: Arc::new(ctx) };

    if is_h2 {
        hyper::server::conn::http2::Builder::new(executor)
            .serve_connection(io, service)
            .await?;
    } else {
        hyper::server::conn::http1::Builder::new()
            .serve_connection(io, service)
            .with_upgrades()   // ← 新增，支持 wss:// upgrade
            .await?;
    }

    Ok(())
}
```

### 5.6 修改: `lib.rs`

```rust
mod connection;
mod http_proxy;

// mitm_service.rs retained until Step 3

pub(crate) use connection::{ConnectionContext, ConnectionMode};
pub(crate) use http_proxy::HttpProxyService;
```

---

## 6. 三步实现策略

不采用 big-bang 删除 `mitm_service.rs`。分三步走，每步可独立验证：

### Step 1: 提取共享业务管线（不改入口）

- 在 `http_proxy.rs` 中新建 `handle_http_request(req, ctx, started_at, started_at_instant)` 函数
- 从 `handle_mitm_request` 中提取公共逻辑：构建 `ParsedProxyRequest` → 规则 → 断点 → forward → 响应构建 → session → 返回 `hyper::Response`
- `handle_mitm_request` 改为调用 `handle_http_request`（薄 wrapper）
- `handle_connection` 保持不变
- **验证**：所有现有测试通过；HTTPS MITM 功能回归正常
- **文件变更**：新增 `connection.rs`、`http_proxy.rs`；修改 `mitm_service.rs`（减量）、`lib.rs`

### Step 2: 纯 HTTP 入口 hyper 化 ✅

- ✅ 将 `read_proxy_request_from_stream` 简化为 `read_header_only()`（只读 header，返回 consumed + leftover）
- ✅ 修改 `handle_connection`：CONNECT 用 `OwnedPrefixedStream(leftover, stream)`；非 CONNECT 用 `OwnedPrefixedStream(consumed + leftover, stream)` + hyper server + `HttpProxyService`
- ✅ 删除 `read_chunked_body`、`check_transfer_encoding`、`handle_http_websocket_upgrade` 等手动代码（约 1000 行）
- ✅ `OwnedPrefixedStream` 作为共享 IO 工具迁入 `http_io.rs`
- ✅ `tunnel_blind_relay` 和 `handle_connect_mitm` 改为泛型 stream
- ✅ `resolve_target_url` / `build_url_from_hyper` 支持 `ws://` / `wss://` absolute-form
- ✅ **验证**：63/63 测试通过；0 warnings

### Step 3: 合并 MITM service + WebSocket 实现 ✅

- ✅ `handle_connect_mitm` 改用 `HttpProxyService` + `ConnectionContext`；删除 `MitmService` 和 `MitmConnectionState`
- ✅ h1 MITM + plain HTTP 路径均添加 `.with_upgrades()`
- ✅ 实现 `handle_ws_upgrade_via_hyper(on_upgrade, request, ctx, ...)`：
  - `WsUpstream` enum 统一 TCP/TLS 上游
  - `parse_upstream_response_head()` 解析上游 101 头并透传（`Sec-WebSocket-Accept` 等）
  - 非 101 响应返回上游错误并重写 `Content-Length`
  - 101 响应显式设置 `Connection: upgrade`
  - session detail 记录上游响应头
- ✅ WebSocket 分流在完整 request-stage 管线之后（rules → breakpoint → pending → throttle）
- ✅ `handle_drop_action(ctx)` 按 `ConnectionMode` 分支 Drop 语义
- ✅ 删除 `mitm_service.rs` + 最终清理
- ✅ **验证**：63/63 测试通过；0 errors；0 warnings

---

## 7. 验证计划

| 层级 | 验证内容 | 方法 |
|------|---------|------|
| 单元测试 | 现有 `tests.rs` 测试保持通过（每步） | `cargo test -p aiproxy-proxy-core` |
| 单元测试 | `PrefixedStream` 行为（empty / partial / exact） | 新增测试 |
| 集成测试 | 纯 HTTP GET/POST（origin-form + absolute-form） | `curl -x http://proxy:port http://example.com/path` |
| 集成测试 | chunked transfer encoding | `curl -H "Transfer-Encoding: chunked" -d @file` |
| 集成测试 | 请求 body 超限 → 报错（非截断） | 上传 >20MB 文件，期望 413 或连接关闭 |
| 集成测试 | 请求超时 + keep-alive 多请求 | 慢速客户端 + 同一连接发送多个请求 |
| 回归测试 | CONNECT tunnel（无 MITM） | `curl -x http://proxy:port --proxy-tunnel https://example.com` |
| 回归测试 | HTTPS MITM 抓包 | `curl -x http://proxy:port https://example.com` |
| 回归测试 | WebSocket over HTTP (ws://) | ws:// echo server 发送/接收消息 |
| 回归测试 | WebSocket over HTTPS (wss://) | wss:// echo server 发送/接收消息 |
| 回归测试 | 规则/断点/限速 | 各功能独立验证 |

---

## 8. 相关文件

| 文件 | Step | 变更类型 | 说明 |
|------|------|---------|------|
| `crates/proxy-core/src/connection.rs` | 1 | **新增** | `ConnectionContext` + `ConnectionMode` |
| `crates/proxy-core/src/http_proxy.rs` | 1 | **新增** | `HttpProxyService` + `handle_http_request` + WS upgrade |
| `crates/proxy-core/src/mitm_service.rs` | 1→3 | 修改后删除 | Step1 减量为薄 wrapper；Step3 删除 |
| `crates/proxy-core/src/server.rs` | 2→3 | **修改** | `read_header_only`；CONNECT/非CONNECT 都用 PrefixedStream；Step3 替换 MITM service |
| `crates/proxy-core/src/http_io.rs` | 2 | 修改 | 迁入 `PrefixedStream` 作为共享工具 |
| `crates/proxy-core/src/lib.rs` | 1→3 | **修改** | 更新模块声明 |
| `crates/proxy-core/src/types.rs` | — | 不变 | `ParsedProxyRequest` 结构保持不变 |
| `crates/proxy-core/src/rules.rs` | — | 不变 | 规则引擎无变更 |
| `crates/proxy-core/src/upstream_pool.rs` | — | 不变 | 连接池无变更 |

---

## 9. 风险与缓解

| 风险 | 缓解 |
|------|------|
| `read_header_only` 的 leftover 可能包含 TLS ClientHello — CONNECT 分支丢掉会断开 TLS 握手；非 CONNECT 只回注 leftover 会丢失 request header | CA cert 直接关闭 stream；CONNECT 回注 `leftover`；非 CONNECT 回注 `consumed + leftover`；`PrefixedStream` 补充测试覆盖 |
| `build_url_from_hyper` 对 plain HTTP 默认构建 `https://` URL | `ConnectionMode` enum 显式分支；absolute-form 原样保留 scheme |
| MITM h1 origin-form host 来源混乱 | 优先级明确：URI authority > Host header > CONNECT host |
| keep-alive 下 timing 被连接级时间污染 | per-request `started_at`/`started_at_instant` 在 `HttpProxyService::call` 中生成 |
| `.with_upgrades()` 写法不符合 hyper 1 API | 明确写在 `serve_connection(...)` 返回的 Connection future 上调用 |
| WebSocket: `req.into_parts()` 后无法 `upgrade::on(req)` | `hyper::upgrade::on(&mut req)` 接受可变引用，先 capture `OnUpgrade` 再 `into_parts()` |
| 请求 body 超限语义不一致（截断 vs 报错） | 请求侧用 `Limited` → 超限报错；响应侧保持截断+spool |
| 三步走中 Step1 引入 dead code | Step1 和 Step2 连续完成，不长期停留中间态 |
