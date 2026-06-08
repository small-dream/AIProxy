# Phase 5：Rust 代码质量 — 深度统一设计

> 日期：2026-06-08
> 状态：v2 — 根据审查意见补强
> 来源：`docs/plan/p2-engineering-standards-continuous-improvement.md` Phase 5（#15 + #16）
> 方案：B — 深度统一 + TLS 配置归位

---

## 背景

Phase 5 旨在消除 proxy-core 和 tls-manager 中 TLS 相关代码的重复和不一致：

1. **重复流类型**：`TimingStream`（timing_connector.rs）和 `WsUpstream`（http_proxy.rs）结构 100% 相同，各自独立定义 trait 实现
2. **重复验证器**：`NoVerifier`（server.rs）和 `AcceptAnyCert`（timing_connector.rs）功能相同但配置不一致（缓存策略、ALPN、签名方案）
3. **reqwest 类型依赖**：proxy-core 大量使用 reqwest 的 header/HTTP 类型作为纯数据类型，而 reqwest 在代理路径中仅用于一个 `DIRECT_HTTP_CLIENT`

---

## Step 0：产出 ADR 文档（前置）

> **ADR 先于代码落地**，为后续重构提供架构判定依据。

### 新建文件

`docs/DECISIONS/ADR-002-proxy-http-client-strategy.md`

### 内容要点

- **决策**：代理核心路径使用 hyper（底层控制需求：MITM、timing、connection pooling）；非代理场景使用 reqwest（便利 API）
- **TLS 后端**：两套客户端共享 rustls TLS 后端
- **TLS 管理**：客户端 TLS 配置统一由 tls-manager 管理，proxy-core 不再自行构建 ClientConfig
- **reqwest 角色**：从 proxy-core 的"类型来源"角色中释放，仅保留给需要 HTTP 客户端能力的场景（DIRECT_HTTP_CLIENT、AI chat）
- **未采纳方案**：完全移除 reqwest（AI chat 客户端重写风险不值得）

---

## Step 1：提取 `TlsOrPlain<S>` 共享流类型

### 新建文件

`crates/proxy-core/src/stream.rs`

```rust
use std::io;
use std::pin::Pin;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use hyper::rt::{Read as HyperRead, ReadBufCursor, Write as HyperWrite};
use hyper_util::client::legacy::connect::{Connected, Connection};

/// Unified stream type wrapping either a plain or TLS-wrapped connection.
/// Generic over the underlying stream type S (typically TcpStream).
///
/// S must satisfy AsyncRead + AsyncWrite + Unpin for all trait implementations.
/// All trait impls delegate to the inner stream — behavior is identical to the
/// current TimingStream and WsUpstream which this replaces.
pub(crate) enum TlsOrPlain<S> {
    Plain(S),
    Tls(Box<tokio_rustls::client::TlsStream<S>>),
}
```

### Trait 实现

为 `TlsOrPlain<S>` 实现两套 trait（逻辑与当前 TimingStream/WsUpstream **完全相同，行为等同现状**）：

- **hyper::rt::Read + Write + Connection** — 替代 TimingStream，用于 hyper legacy client
  - `Connection::connected()` 返回 `Connected::new()` — 行为等同现状（当前 TimingStream 也是这样，无法保留更细的连接元信息）
- **tokio::io::AsyncRead + AsyncWrite** — 替代 WsUpstream，用于 WebSocket upstream

> **设计决策**：泛型参数 `S` 为未来扩展（如 Unix socket）预留，但当前所有实例化点都是 `TlsOrPlain<TcpStream>`。`where S: AsyncRead + AsyncWrite + Unpin` 约束不放在 enum 定义上，而是放在各 trait impl 块上——这是更 Rust 惯用的写法，避免所有引用类型的地方都背上约束。

### API 可见性

- `stream` 模块声明为 **`pub(crate) mod stream;`** — 不新增显式 re-export，保持与当前 `TimingStream` 等同的有效可见性
- 核实依据：`TimingStream` 当前**不是** public API（`timing_connector` 模块为 `mod` 私有，lib.rs 未 re-export `TimingStream`；仅有 `TimingConnector` 和 `ConnectionTiming` 被 re-export）
- `TimingConnector` 仍是 crate public API（lib.rs:85 已 re-export），其 `Service::Response` 关联类型位置处于与当前 `TimingStream` 相同的可见性状态；实施时需编译确认无 breaking change

### 修改文件

| 文件 | 变更 |
|------|------|
| `crates/proxy-core/src/stream.rs` | 新建，包含 enum 定义 + 两套 trait impl |
| `crates/proxy-core/src/lib.rs` | 新增 `pub(crate) mod stream;` |
| `crates/proxy-core/src/timing_connector.rs` | 删除 `TimingStream` 定义和 hyper trait impl，改为 `use crate::stream::TlsOrPlain` |
| `crates/proxy-core/src/http_proxy.rs` | 删除 `WsUpstream` 定义和 tokio trait impl，改为 `use crate::stream::TlsOrPlain` |

---

## Step 2：统一客户端 TLS 配置到 tls-manager

### 新建文件

`crates/tls-manager/src/client.rs`

```rust
use std::sync::{Arc, OnceLock};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::ring::default_provider;
use rustls::{ClientConfig, DigitallySignedStruct, Error, SignatureScheme};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};

/// No-op certificate verifier for debugging proxy upstream connections.
/// Accepts any server certificate without validation.
pub struct NoOpVerifier;

impl ServerCertVerifier for NoOpVerifier {
    // 统一实现，采用硬编码签名方案列表（8 种标准方案）
    // 而非 CryptoProvider::get_default()（可能在 provider 安装前返回空 vec）
}

/// Build a ClientConfig that accepts any server certificate (no ALPN).
/// Cached via OnceLock — all callers share the same config instance.
pub fn build_dangerous_client_config() -> Arc<ClientConfig> { ... }

/// Build a ClientConfig that accepts any server certificate, with ALPN negotiation.
/// Not cached — each call creates a new config with the specified ALPN list.
pub fn build_dangerous_client_config_with_alpn(
    alpn_protocols: Vec<Vec<u8>>,
) -> Arc<ClientConfig> { ... }

/// Build a TlsConnector from the dangerous client config (no ALPN).
pub fn build_dangerous_tls_connector() -> tokio_rustls::TlsConnector { ... }

/// Build a TlsConnector from the dangerous client config, with ALPN negotiation.
pub fn build_dangerous_tls_connector_with_alpn(
    alpn_protocols: Vec<Vec<u8>>,
) -> tokio_rustls::TlsConnector { ... }
```

### ALPN API 设计

采用**两个命名函数**而非 `Option<Vec<Vec<u8>>>`：

| 函数 | ALPN | 缓存 | 调用方 |
|------|------|------|--------|
| `build_dangerous_client_config()` | 无 | OnceLock singleton | WS upstream、MITM relay |
| `build_dangerous_client_config_with_alpn(protocols)` | 有 | 无缓存，每次新建 | TimingConnector（需 `[h2, http/1.1]`） |

> **理由**：避免 `None` 和 `Some(vec![])` 两种"无 ALPN"状态导致缓存策略和调用语义不一致。无 ALPN 的 singleton 语义用函数名显式表达。

### 签名方案测试

为 `NoOpVerifier::supported_verify_schemes()` 补充单元测试：

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supported_verify_schemes_is_non_empty() {
        let verifier = NoOpVerifier;
        let schemes = verifier.supported_verify_schemes();
        assert!(!schemes.is_empty(), "supported_verify_schemes must not be empty");
        // Verify the 8 expected schemes are present
        assert!(schemes.contains(&SignatureScheme::ECDSA_NISTP256_SHA256));
        assert!(schemes.contains(&SignatureScheme::ECDSA_NISTP384_SHA384));
        assert!(schemes.contains(&SignatureScheme::ED25519));
        assert!(schemes.contains(&SignatureScheme::RSA_PSS_SHA256));
        assert!(schemes.contains(&SignatureScheme::RSA_PSS_SHA384));
        assert!(schemes.contains(&SignatureScheme::RSA_PKCS1_SHA256));
        assert!(schemes.contains(&SignatureScheme::RSA_PKCS1_SHA384));
        assert!(schemes.contains(&SignatureScheme::RSA_PKCS1_SHA512));
    }
}
```

### 设计决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 签名方案 | 硬编码 8 种标准方案 + 单元测试 | 比 `CryptoProvider::get_default()` 更健壮，不依赖 provider 安装顺序；测试防止未来误删 |
| 缓存策略 | 两个命名函数分离无 ALPN（cached）和有 ALPN（uncached） | 语义清晰，无 `None`/`Some(vec![])` 歧义 |
| 位置 | tls-manager 而非 proxy-core | tls-manager 是 TLS 权威 crate，客户端配置归属于此 |

### 修改文件

| 文件 | 变更 |
|------|------|
| `crates/tls-manager/src/client.rs` | 新建，包含 NoOpVerifier + 4 个 build 函数 + 单元测试 |
| `crates/tls-manager/src/lib.rs` | 新增 `pub mod client;` |
| `crates/tls-manager/Cargo.toml` | 新增 `tokio-rustls = { version = "0.26", default-features = false, features = ["tls12"] }` |
| `crates/proxy-core/src/server.rs` | 删除 `build_dangerous_client_tls_config()` 和 `NoVerifier`，改为调用 `aiproxy_tls_manager::client::build_dangerous_client_config()` |
| `crates/proxy-core/src/timing_connector.rs` | 删除 `build_dangerous_tls_connector()` 和 `AcceptAnyCert`，改为调用 `aiproxy_tls_manager::client::build_dangerous_tls_connector_with_alpn(vec![b"h2".to_vec(), b"http/1.1".to_vec()])` |
| `crates/proxy-core/src/http_proxy.rs` | 对 `build_dangerous_client_tls_config()` 的引用改为 tls-manager API |

---

## Step 3：清理 reqwest 类型依赖

### 关键发现

`reqwest 0.12` 的 `HeaderMap`、`Method`、`StatusCode`、`HeaderName`、`HeaderValue` **就是** `http` crate 的同名类型（reqwest 直接 re-export）。切换 import 路径**风险低，需编译验证**。

**注意事项**：
- `Url` 在 server.rs:1661 被传入 `reqwest::Client::request()`，属于功能性使用。import 路径从 `reqwest::Url` 改为 `url::Url` 后需确认 `reqwest::Client::request()` 的 `IntoUrl` trait 仍能匹配
- proxy-core 需新增 `url = "2"` 直接依赖（当前通过 reqwest 间接引入）。`url` 已在 workspace 中通过 reqwest 和 deno_ast 存在，不会造成依赖漂移

### 修改文件

**`crates/proxy-core/src/lib.rs`** — 主 import 替换：

```rust
// 重构前
use reqwest::{
    header::{HeaderMap, HeaderName, HeaderValue, CONNECTION, CONTENT_LENGTH, CONTENT_TYPE, HOST, TRANSFER_ENCODING},
    redirect::Policy,
    Client, Method, StatusCode, Url,
};

// 重构后
use http::{HeaderMap, HeaderName, HeaderValue, Method, StatusCode};
use http::header::{CONNECTION, CONTENT_LENGTH, CONTENT_TYPE, HOST, TRANSFER_ENCODING, CONTENT_ENCODING};
use url::Url;
// 保留 reqwest::{Client, redirect::Policy} 仅给 DIRECT_HTTP_CLIENT 使用
use reqwest::{Client, redirect::Policy};
```

**其他文件的 `reqwest::header::CONTENT_ENCODING` 替换**：
- `crates/proxy-core/src/rules/script.rs` — `reqwest::header::CONTENT_ENCODING` → `http::header::CONTENT_ENCODING`
- `crates/proxy-core/src/http_io.rs` — 同上
- `crates/proxy-core/src/server.rs` — 同上
- `crates/proxy-core/src/tests.rs` — 更新 import 路径

### 保留 reqwest 的场景

| 场景 | 文件 | 理由 |
|------|------|------|
| DIRECT_HTTP_CLIENT | `proxy-core/src/server.rs` | 实际 HTTP 客户端，`Url` 传入 `Client::request()` |
| AI chat API 客户端 | `apps/desktop/src-tauri/src/commands/ai.rs` | 便利 API（JSON、redirect、timeout），独立于代理 |

### 新增依赖

`crates/proxy-core/Cargo.toml` 新增 `url = "2"`。

---

## 执行顺序

```
PR 5-0: ADR 文档（Step 0）                     ← 前置，提供架构判定依据
PR 5-1: TlsOrPlain<S> 提取（Step 1）           ← 纯搬移，零行为变更
PR 5-2: TLS 配置统一到 tls-manager（Step 2）    ← 跨 crate，需验证
PR 5-3: reqwest 类型清理（Step 3）              ← import 路径替换，低风险
```

PR 5-0 必须最先落地。PR 5-1 和 5-3 互不依赖可并行；5-2 依赖 5-1。

---

## 验证

### 全量命令验证（每个 PR 后执行）

```bash
cargo build --workspace
cargo test --workspace
cargo clippy --workspace -- -D warnings
cargo fmt --check --all
```

### 风险面专项验证

| 验证项 | 方法 | 对应风险 |
|--------|------|----------|
| HTTP/1.1 HTTPS 捕获正常 | 启动代理，浏览器访问 `https://` 站点 | TlsOrPlain hyper trait impl 正确 |
| HTTP/2 HTTPS 捕获正常 | 启动代理，确认 timing connector ALPN 仍包含 `h2, http/1.1` | ALPN 配置未丢失 |
| wss:// 握手正常 | WebSocket 客户端连接 `wss://` 上游 | TlsOrPlain tokio trait impl 正确，无 ALPN 配置不改变现状 |
| `supported_verify_schemes()` 非空 | `cargo test -p aiproxy-tls-manager` | 签名方案硬编码列表完整 |
| reqwest import 清零 | `rg "reqwest::header\|reqwest::Url" crates/proxy-core/src` 仅剩明确允许点（DIRECT_HTTP_CLIENT 相关） | import 替换无遗漏 |

### 集成验证

- `pnpm desktop:run` 启动无崩溃
- 代理功能正常：捕获 HTTP/HTTPS 请求
- WebSocket 升级正常（ws:// 和 wss://）
- AI chat 功能正常（reqwest 客户端未受影响）
