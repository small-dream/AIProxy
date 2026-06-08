# ADR-003 Proxy HTTP Client Strategy

## 状态

Accepted

## 背景

AIProxy 的代理核心（proxy-core）同时依赖 hyper 和 reqwest 两个 HTTP 客户端库：

- **hyper**：用于代理核心路径（MITM 拦截、上游转发、WebSocket relay、timing 测量）。需要底层连接控制（TLS handshake、HTTP/2 framing、connection pooling）。
- **reqwest**：用于非代理场景（AI chat completion API 调用、header 类型引用）。提供高层便利 API（JSON 序列化、redirect 策略、timeout）。

proxy-core 中大量使用 reqwest 的 header/HTTP 类型（`HeaderMap`、`Method`、`StatusCode`、`Url`）作为纯数据类型，而非 HTTP 客户端功能。这些类型实际是 `http` crate 的 re-export。

客户端 TLS 配置方面，proxy-core 内部存在两个功能相同但配置不一致的 no-op 证书验证器（`NoVerifier` 和 `AcceptAnyCert`），散落在 `server.rs` 和 `timing_connector.rs` 中。

## 决策

1. **HTTP 客户端分工**：代理核心路径使用 hyper（底层控制需求），非代理场景使用 reqwest（便利 API）。双客户端共存是架构合理的。
2. **TLS 配置统一**：客户端 TLS 配置统一归位到 `tls-manager` crate 的 `client` 模块。proxy-core 不再自行构建 `ClientConfig`。
3. **reqwest 角色收窄**：reqwest 在 proxy-core 中的角色从"类型来源 + HTTP 客户端"收窄为"仅 HTTP 客户端"。Header/HTTP 类型改为从 `http` crate 直接引入。
4. **共享 TLS 后端**：两套客户端共享 rustls TLS 后端，证书策略统一管理。

## 理由

- 完全移除 reqwest 需要重写 AI chat 客户端（当前使用 reqwest 的 JSON/redirect/timeout 便利 API），风险不值得。
- 统一 TLS 配置到 tls-manager 消除了两个重复验证器的不一致问题（缓存策略、ALPN、签名方案列表），且 tls-manager 作为 TLS 权威 crate 是自然的归属地。

## 后果

- proxy-core 的 reqwest 依赖保留，但 import 表面积显著减小。
- 后续维护者只需在 tls-manager 一处修改客户端 TLS 策略。
- `http` crate 的 `HeaderMap`/`Method`/`StatusCode` 与 reqwest re-export 的是同一类型，切换零成本。
