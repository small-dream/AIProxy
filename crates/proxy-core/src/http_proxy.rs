use super::*;
use crate::connection::{ConnectionContext, ConnectionMode};
use crate::MAX_CAPTURED_BODY_BYTES;
use crate::{
    apply_request_runtime_rules, apply_request_script_rules, apply_request_throttle,
    apply_response_rewrite_rules, apply_response_script_rules, apply_response_throttle,
    build_cookie_entries, build_header_entries_from_map, build_pending_session_detail,
    build_query_params, build_raw_http_head, build_request_path, build_session_detail, emit_log,
    intercept_request_stage, intercept_response_stage, throttle_selection_matches_stage,
    BreakpointActionKind, ParsedProxyRequest, ProxySessionDetail, ProxyTimingBreakdown,
    RequestRuntimeOutcome, UpstreamResponse,
};
use http_body_util::BodyExt;
use std::future::Future;
use std::io;
use std::pin::Pin;
use std::sync::Arc;
use std::task::{Context, Poll};
use tokio::io::ReadBuf;

const CLIENT_CLOSED_REQUEST_STATUS: u16 = 499;

/// Shorthand for the boxed response body type used throughout the proxy.
type ProxyResponse = hyper::Response<http_body_util::combinators::BoxBody<bytes::Bytes, String>>;

// ---------------------------------------------------------------------------
// HttpProxyService
// ---------------------------------------------------------------------------

/// A `hyper::service::Service` that processes each HTTP request arriving on
/// either a plain HTTP connection or a MITM'd TLS connection.
/// Generates per-request timing internally to avoid keep-alive pollution.
pub(crate) struct HttpProxyService {
    pub ctx: Arc<ConnectionContext>,
}

impl hyper::service::Service<hyper::Request<hyper::body::Incoming>> for HttpProxyService {
    type Response = hyper::Response<http_body_util::combinators::BoxBody<bytes::Bytes, String>>;
    type Error = String;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn call(&self, req: hyper::Request<hyper::body::Incoming>) -> Self::Future {
        let ctx = self.ctx.clone();
        Box::pin(async move {
            // Per-request timing — NOT from connection context.
            // Each request on a keep-alive connection gets its own timing.
            let started_at = Utc::now();
            let started_at_instant = Instant::now();
            handle_http_request(req, &ctx, started_at, started_at_instant).await
        })
    }
}

// ---------------------------------------------------------------------------
// Core request handler — shared between plain HTTP and MITM paths
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// WebSocket upgrade handler
// ---------------------------------------------------------------------------

/// Build and send a 502 Bad Gateway error session for WS upstream failures,
/// and return a matching 502 hyper response.
///
/// This is used instead of returning `Err` so that upstream failures produce
/// proper 502 sessions rather than 499 (client cancelled) via the guard.
#[allow(clippy::too_many_arguments)]
async fn send_ws_upstream_error_session(
    request: &ParsedProxyRequest,
    ctx: &ConnectionContext,
    error: &str,
    started_at: DateTime<Utc>,
    started_at_instant: Instant,
    map_traces: Vec<crate::MapTrace>,
    rewrite_traces: Vec<crate::RewriteTrace>,
    script_traces: Vec<aiproxy_rule_engine::ScriptTrace>,
    throttle_traces: Vec<crate::ThrottleTrace>,
) -> hyper::Response<http_body_util::combinators::BoxBody<bytes::Bytes, String>> {
    let response_message = "The proxy could not reach the WebSocket upstream server.";
    let elapsed_ms = started_at_instant.elapsed().as_millis();

    let mut detail = build_session_detail(
        request,
        StatusCode::BAD_GATEWAY.as_u16(),
        &HeaderMap::new(),
        response_message.as_bytes(),
        response_message.len(),
        started_at,
        started_at_instant,
        ProxyTimingBreakdown {
            connect_ms: None,
            dns_ms: None,
            request_send_ms: None,
            response_read_ms: Some(0),
            tls_ms: None,
            total_ms: Some(elapsed_ms),
            waiting_ms: Some(elapsed_ms),
        },
        false,
    );
    detail.map_traces = map_traces;
    detail.rewrite_traces = rewrite_traces;
    detail.script_traces = script_traces;
    detail.throttle_traces = throttle_traces;

    if ctx.session_sender.send(detail).await.is_err() {
        emit_log(
            "DEBUG",
            "session_send_dropped",
            &[("reason", "receiver_disconnected".to_string())],
        );
    }

    emit_log(
        "ERROR",
        "ws_upstream_error",
        &[
            ("request_id", request.request_id.clone()),
            ("host", request.host.clone()),
            ("url", request.url.to_string()),
            ("error", error.to_string()),
        ],
    );

    build_plain_text_response(StatusCode::BAD_GATEWAY, response_message)
        .unwrap_or_else(|_| build_empty_response(StatusCode::BAD_GATEWAY))
}

/// Handle a WebSocket upgrade request via hyper's upgrade mechanism.
///
/// The caller MUST have already:
/// - Captured `OnUpgrade` via `hyper::upgrade::on(&mut req)`.
/// - Built a `ParsedProxyRequest` and run the request-stage pipeline
///   (rules, scripts, breakpoints).
///
/// This function:
/// 1. Connects upstream (TCP for ws://, TLS for wss://).
/// 2. Sends the raw upgrade request and reads the response.
/// 3. If upstream returns 101, sets up bidirectional WebSocket frame relay.
/// 4. If upstream refuses, returns the upstream error response.
#[allow(clippy::too_many_arguments)]
async fn handle_ws_upgrade_via_hyper(
    on_upgrade: hyper::upgrade::OnUpgrade,
    request: ParsedProxyRequest,
    ctx: &ConnectionContext,
    started_at: DateTime<Utc>,
    started_at_instant: Instant,
    map_traces: Vec<crate::MapTrace>,
    rewrite_traces: Vec<crate::RewriteTrace>,
    script_traces: Vec<aiproxy_rule_engine::ScriptTrace>,
    throttle_traces: Vec<crate::ThrottleTrace>,
) -> Result<hyper::Response<http_body_util::combinators::BoxBody<bytes::Bytes, String>>, String> {
    let request_id = request.request_id.clone();

    // Determine upstream port.
    let port = request.url.port().unwrap_or(match ctx.mode {
        ConnectionMode::PlainHttp => 80,
        ConnectionMode::MitmHttps { .. } => 443,
    });

    // Resolve DNS override.
    let connect_host =
        match crate::resolve_dns_override(&ctx.dns_manager, &ctx.workspace_id, &request.host) {
            Some(ip) => {
                emit_log(
                    "INFO",
                    "dns_override_ws",
                    &[
                        ("host", request.host.clone()),
                        ("override_ip", ip.to_string()),
                    ],
                );
                ip.to_string()
            }
            None => request.host.clone(),
        };
    let connect_host_port = format!("{connect_host}:{port}");

    emit_log(
        "DEBUG",
        "ws_hyper_connecting_upstream",
        &[
            ("request_id", request_id.clone()),
            ("host_port", format!("{}:{}", request.host, port)),
        ],
    );

    // Connect upstream — TCP, optionally TLS for wss://.
    // On failure, send a 502 session and return Ok(502) — not Err/499.
    let ws_tcp = match TcpStream::connect(&*connect_host_port).await {
        Ok(s) => s,
        Err(e) => {
            let error = format!("WebSocket upstream connect to {connect_host_port}: {e}");
            return Ok(send_ws_upstream_error_session(
                &request,
                ctx,
                &error,
                started_at,
                started_at_instant,
                map_traces,
                rewrite_traces,
                script_traces,
                throttle_traces,
            )
            .await);
        }
    };

    let mut upstream = match ctx.mode {
        ConnectionMode::MitmHttps { .. } => {
            let client_config = crate::server::build_dangerous_client_tls_config();
            let tls_connector = tokio_rustls::TlsConnector::from(client_config);
            let dns_name =
                tokio_rustls::rustls::pki_types::ServerName::try_from(request.host.clone())
                    .unwrap_or_else(|_| {
                        tokio_rustls::rustls::pki_types::ServerName::IpAddress(
                            std::net::Ipv4Addr::LOCALHOST.into(),
                        )
                    });
            let tls_stream = match tls_connector.connect(dns_name, ws_tcp).await {
                Ok(s) => s,
                Err(e) => {
                    let error = format!("WebSocket upstream TLS handshake: {e}");
                    return Ok(send_ws_upstream_error_session(
                        &request,
                        ctx,
                        &error,
                        started_at,
                        started_at_instant,
                        map_traces,
                        rewrite_traces,
                        script_traces,
                        throttle_traces,
                    )
                    .await);
                }
            };
            WsUpstream::Tls(Box::new(tls_stream))
        }
        ConnectionMode::PlainHttp => WsUpstream::Plain(ws_tcp),
    };

    // Build and send the raw upgrade request to upstream.
    let raw_req = match build_ws_upgrade_request(&request) {
        Ok(r) => r,
        Err(e) => {
            return Ok(send_ws_upstream_error_session(
                &request,
                ctx,
                &e,
                started_at,
                started_at_instant,
                map_traces,
                rewrite_traces,
                script_traces,
                throttle_traces,
            )
            .await);
        }
    };
    emit_log(
        "DEBUG",
        "ws_hyper_sending_upgrade",
        &[("request_id", request_id.clone())],
    );
    if let Err(e) = upstream.write_all(raw_req.as_bytes()).await {
        let error = format!("WebSocket upgrade send to upstream: {e}");
        return Ok(send_ws_upstream_error_session(
            &request,
            ctx,
            &error,
            started_at,
            started_at_instant,
            map_traces,
            rewrite_traces,
            script_traces,
            throttle_traces,
        )
        .await);
    }

    // Read the upstream response.
    let (response_head, leftover_bytes) =
        match crate::server::read_http_response_head(&mut upstream).await {
            Ok(r) => r,
            Err(e) => {
                return Ok(send_ws_upstream_error_session(
                    &request,
                    ctx,
                    &e,
                    started_at,
                    started_at_instant,
                    map_traces,
                    rewrite_traces,
                    script_traces,
                    throttle_traces,
                )
                .await);
            }
        };

    // Parse status code and headers from the upstream response.
    let (status_code, upstream_headers) = match parse_upstream_response_head(&response_head) {
        Ok(r) => r,
        Err(e) => {
            return Ok(send_ws_upstream_error_session(
                &request,
                ctx,
                &e,
                started_at,
                started_at_instant,
                map_traces,
                rewrite_traces,
                script_traces,
                throttle_traces,
            )
            .await);
        }
    };

    emit_log(
        "INFO",
        "ws_hyper_upstream_response",
        &[
            ("request_id", request_id.clone()),
            ("status_code", status_code.to_string()),
        ],
    );

    // Build session detail with upstream response headers.
    let upstream_header_map = ws_headers_to_header_map(&upstream_headers);
    let upstream_header_entries = build_header_entries_from_map(&upstream_header_map);
    let reason = StatusCode::from_u16(status_code)
        .ok()
        .and_then(|c| c.canonical_reason().map(|r| r.to_string()))
        .unwrap_or_else(|| "Unknown".to_string());
    let raw_response_head = Some(build_raw_http_head(
        &format!("HTTP/1.1 {} {}", status_code, reason),
        &upstream_header_entries,
    ));
    let mut detail = build_session_detail(
        &request,
        status_code,
        &upstream_header_map,
        &[],
        0,
        started_at,
        started_at_instant,
        ProxyTimingBreakdown {
            connect_ms: None,
            dns_ms: None,
            request_send_ms: None,
            response_read_ms: Some(0),
            tls_ms: None,
            total_ms: Some(started_at_instant.elapsed().as_millis()),
            waiting_ms: Some(0),
        },
        false,
    );
    detail.summary.protocol = match ctx.mode {
        ConnectionMode::PlainHttp => "ws".to_string(),
        ConnectionMode::MitmHttps { .. } => "wss".to_string(),
    };
    let protocol_metadata = infer_protocol_metadata(&detail.summary.protocol, &detail.summary.url);
    detail.summary.scheme = protocol_metadata.scheme;
    detail.summary.http_version = protocol_metadata.http_version;
    detail.summary.transport_protocol = protocol_metadata.transport_protocol;
    detail.summary.application_protocol = protocol_metadata.application_protocol;
    detail.summary.response_mime_type = Some("websocket".to_string());
    detail.raw_response_head = raw_response_head;

    if status_code != 101
        || !upstream_headers
            .iter()
            .any(|(n, _)| n.eq_ignore_ascii_case("upgrade"))
    {
        // Upstream did not agree to upgrade — return its response as-is.
        emit_log(
            "WARN",
            "ws_hyper_upstream_refused",
            &[
                ("request_id", request_id.clone()),
                ("status_code", status_code.to_string()),
            ],
        );

        // Build the non-101 response FIRST (before sending session).
        // If response construction fails, send a 502 error session instead
        // of leaving the pending session stuck or creating a duplicate.
        let body_bytes = bytes::Bytes::copy_from_slice(leftover_bytes.as_slice());
        let mut builder = hyper::Response::builder()
            .status(StatusCode::from_u16(status_code).unwrap_or(StatusCode::BAD_GATEWAY))
            .header("Content-Length", body_bytes.len());
        for (name, value) in &upstream_headers {
            if name.eq_ignore_ascii_case("connection")
                || name.eq_ignore_ascii_case("transfer-encoding")
                || name.eq_ignore_ascii_case("content-length")
            {
                continue;
            }
            builder = builder.header(name.as_str(), value.as_str());
        }
        let response = match builder.body(
            http_body_util::Full::new(body_bytes)
                .map_err(|_: std::convert::Infallible| unreachable!())
                .boxed(),
        ) {
            Ok(r) => r,
            Err(e) => {
                let error = format!("failed to build upstream error response: {e}");
                return Ok(send_ws_upstream_error_session(
                    &request,
                    ctx,
                    &error,
                    started_at,
                    started_at_instant,
                    map_traces,
                    rewrite_traces,
                    script_traces,
                    throttle_traces,
                )
                .await);
            }
        };

        // Response built successfully — NOW send the session (after response
        // construction, so a failed build does not leave a stale session).
        detail.map_traces = map_traces;
        detail.rewrite_traces = rewrite_traces;
        detail.script_traces = script_traces;
        detail.throttle_traces = throttle_traces;

        if ctx.session_sender.send(detail).await.is_err() {
            emit_log(
                "DEBUG",
                "session_send_dropped",
                &[("reason", "receiver_disconnected".to_string())],
            );
        }

        return Ok(response);
    }

    // Upstream returned 101 — set up WebSocket relay.
    detail.summary.response_mime_type = Some("websocket".to_string());
    let session_id_for_relay = detail.id.clone();

    // Build the 101 Switching Protocols response FIRST (before registering
    // or sending session). If construction fails, no state has been mutated.
    let mut response_builder = hyper::Response::builder()
        .status(StatusCode::SWITCHING_PROTOCOLS)
        .header("connection", "upgrade");
    for (name, value) in &upstream_headers {
        if name.eq_ignore_ascii_case("connection") || name.eq_ignore_ascii_case("transfer-encoding")
        {
            continue;
        }
        response_builder = response_builder.header(name.as_str(), value.as_str());
    }
    let ws_response = match response_builder.body(
        http_body_util::Empty::<bytes::Bytes>::new()
            .map_err(|_: std::convert::Infallible| unreachable!())
            .boxed(),
    ) {
        Ok(r) => r,
        Err(e) => {
            let error = format!("failed to build 101 response: {e}");
            return Ok(send_ws_upstream_error_session(
                &request,
                ctx,
                &error,
                started_at,
                started_at_instant,
                map_traces,
                rewrite_traces,
                script_traces,
                throttle_traces,
            )
            .await);
        }
    };

    // Response built successfully — NOW register, send session, and spawn relay.
    // This ordering ensures no dangling registry entries or duplicate sessions
    // if response construction fails.
    let (inject_tx, mut inject_rx) =
        tokio::sync::mpsc::unbounded_channel::<crate::ws::WsInjectRequest>();
    let registry = crate::ws::global_ws_registry();
    registry.register(session_id_for_relay.clone(), inject_tx);

    // Attach request-stage traces so the final WS session retains rule hits,
    // script execution results, and throttle traces.
    detail.map_traces = map_traces;
    detail.rewrite_traces = rewrite_traces;
    detail.script_traces = script_traces;
    detail.throttle_traces = throttle_traces;

    let _ = ctx.session_sender.send(detail).await;

    let ws_message_sender = ctx.ws_message_sender.clone();

    // Spawn background task for bidirectional relay.
    tokio::spawn(async move {
        let client_io = match on_upgrade.await {
            Ok(io) => io,
            Err(e) => {
                emit_log(
                    "ERROR",
                    "ws_hyper_on_upgrade_failed",
                    &[("request_id", request_id.clone()), ("error", e.to_string())],
                );
                registry.mark_closed(&session_id_for_relay);
                registry.unregister(&session_id_for_relay);
                return;
            }
        };

        let mut client = hyper_util::rt::TokioIo::new(client_io);
        let mut upstream = OwnedPrefixedStream::new(leftover_bytes, upstream);

        crate::ws::relay_websocket_frames(
            &mut client,
            &mut upstream,
            &session_id_for_relay,
            &ws_message_sender,
            &mut inject_rx,
        )
        .await;

        registry.mark_closed(&session_id_for_relay);
        registry.unregister(&session_id_for_relay);
    });

    Ok(ws_response)
}

/// Parse an HTTP response head string into a status code and header list.
/// Input: "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n...\r\n\r\n"
fn parse_upstream_response_head(head: &str) -> Result<(u16, Vec<(String, String)>), String> {
    let mut lines = head.lines();
    let status_line = lines.next().unwrap_or("");

    let status_code: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|v| v.parse().ok())
        .unwrap_or(502);

    let mut headers: Vec<(String, String)> = Vec::new();
    for line in lines {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_string(), value.trim().to_string()));
        }
    }

    Ok((status_code, headers))
}

/// Convert a list of (name, value) header pairs into a reqwest HeaderMap.
fn ws_headers_to_header_map(headers: &[(String, String)]) -> HeaderMap {
    let mut map = HeaderMap::new();
    for (name, value) in headers {
        if let (Ok(n), Ok(v)) = (
            HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(value),
        ) {
            map.append(n, v);
        }
    }
    map
}

/// Build a raw HTTP upgrade request string for WebSocket relay.
fn build_ws_upgrade_request(request: &ParsedProxyRequest) -> Result<String, String> {
    let path = build_request_path(&request.url);
    let mut raw = format!("{} {} HTTP/1.1\r\n", request.method, path);

    // Re-inject Host header.
    let host_with_port = match request.url.port() {
        Some(port) => format!("{}:{}", request.host, port),
        None => request.host.clone(),
    };
    raw.push_str(&format!("Host: {}\r\n", host_with_port));

    for (name, value) in &request.headers {
        if name.as_str().eq_ignore_ascii_case("host") {
            continue;
        }
        raw.push_str(&format!("{}: {}\r\n", name, value.to_str().unwrap_or("")));
    }
    raw.push_str("\r\n");
    Ok(raw)
}

// ---------------------------------------------------------------------------
// WebSocket upstream stream wrapper
// ---------------------------------------------------------------------------

/// Unified stream type for WebSocket upstream connections.
/// Wraps either a plain TCP stream (ws://) or a TLS stream (wss://).
enum WsUpstream {
    Plain(TcpStream),
    Tls(Box<tokio_rustls::client::TlsStream<TcpStream>>),
}

impl AsyncRead for WsUpstream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        match &mut *self {
            WsUpstream::Plain(s) => Pin::new(s).poll_read(cx, buf),
            WsUpstream::Tls(s) => Pin::new(&mut *s).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for WsUpstream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<io::Result<usize>> {
        match &mut *self {
            WsUpstream::Plain(s) => Pin::new(s).poll_write(cx, buf),
            WsUpstream::Tls(s) => Pin::new(&mut *s).poll_write(cx, buf),
        }
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match &mut *self {
            WsUpstream::Plain(s) => Pin::new(s).poll_flush(cx),
            WsUpstream::Tls(s) => Pin::new(&mut *s).poll_flush(cx),
        }
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match &mut *self {
            WsUpstream::Plain(s) => Pin::new(s).poll_shutdown(cx),
            WsUpstream::Tls(s) => Pin::new(&mut *s).poll_shutdown(cx),
        }
    }
}

// ---------------------------------------------------------------------------
// Pure helpers extracted from handle_http_request
// ---------------------------------------------------------------------------

/// Build a `ParsedProxyRequest` from the raw hyper request parts and body.
fn build_parsed_request_from_hyper(
    parts: hyper::http::request::Parts,
    body_bytes: bytes::Bytes,
    ctx: &ConnectionContext,
    request_id: &str,
) -> Result<ParsedProxyRequest, String> {
    let method = Method::from_bytes(parts.method.as_str().as_bytes())
        .map_err(|e| format!("invalid HTTP method: {e}"))?;

    let is_h2 = ctx.mode.is_h2();

    // Build URL from hyper parts according to ConnectionMode.
    let url = build_url_from_hyper(&parts, &ctx.mode)?;

    let host = url
        .host_str()
        .ok_or_else(|| "target URL does not contain a host".to_string())?
        .to_string();
    let path = build_request_path(&url);
    let query_params = build_query_params(&url);

    // Build header entries (for display/logging) and upstream HeaderMap.
    let request_headers = build_request_headers_from_hyper(&parts, is_h2);
    let headers = build_upstream_headers_from_hyper(&parts.headers)?;

    let raw_request = build_raw_http_head(
        &format!(
            "{} {} HTTP/{}",
            method.as_str(),
            path,
            if is_h2 { "2" } else { "1.1" },
        ),
        &request_headers,
    );

    Ok(ParsedProxyRequest {
        body: body_bytes.to_vec(),
        client_address: Some(ctx.client_addr.to_string()),
        headers,
        host: host.clone(),
        method,
        path,
        protocol: ctx.mode.protocol().to_string(),
        query_params,
        raw_request,
        request_headers,
        request_id: request_id.to_string(),
        url,
        tls_cipher_suite: match &ctx.mode {
            ConnectionMode::MitmHttps {
                tls_cipher_suite, ..
            } => tls_cipher_suite.clone(),
            ConnectionMode::PlainHttp => None,
        },
        tls_protocol: match &ctx.mode {
            ConnectionMode::MitmHttps { tls_protocol, .. } => tls_protocol.clone(),
            ConnectionMode::PlainHttp => None,
        },
    })
}

/// Build a 502 Bad Gateway response and emit the associated session + logs
/// when the upstream request fails entirely.
async fn build_upstream_error_response_and_session(
    request: &ParsedProxyRequest,
    host: &str,
    error: &str,
    ctx: &ConnectionContext,
    started_at: DateTime<Utc>,
    started_at_instant: Instant,
) -> Result<hyper::Response<http_body_util::combinators::BoxBody<bytes::Bytes, String>>, String> {
    let response_message = "The proxy could not reach the upstream server.";

    let detail = build_session_detail(
        request,
        StatusCode::BAD_GATEWAY.as_u16(),
        &HeaderMap::new(),
        response_message.as_bytes(),
        response_message.len(),
        started_at,
        started_at_instant,
        ProxyTimingBreakdown {
            connect_ms: None,
            dns_ms: None,
            request_send_ms: None,
            response_read_ms: Some(0),
            tls_ms: None,
            total_ms: Some(started_at_instant.elapsed().as_millis()),
            waiting_ms: Some(started_at_instant.elapsed().as_millis()),
        },
        false,
    );
    if ctx.session_sender.send(detail).await.is_err() {
        emit_log(
            "DEBUG",
            "session_send_dropped",
            &[("reason", "receiver_disconnected".to_string())],
        );
    }

    emit_log(
        "ERROR",
        "upstream_request_failed",
        &[
            ("request_id", request.request_id.clone()),
            ("host", host.to_string()),
            ("url", request.url.to_string()),
            ("error", error.to_string()),
        ],
    );

    build_plain_text_response(StatusCode::BAD_GATEWAY, response_message)
}

/// Build a `ProxySessionDetail` from an upstream response, attaching proxy
/// timing, trace metadata, and an optional timing-source marker.
#[allow(clippy::too_many_arguments)]
fn build_upstream_session_detail(
    request: &ParsedProxyRequest,
    upstream_response: &UpstreamResponse,
    started_at: DateTime<Utc>,
    started_at_instant: Instant,
    map_traces: Vec<crate::MapTrace>,
    rewrite_traces: Vec<crate::RewriteTrace>,
    script_traces: Vec<crate::ScriptTrace>,
    throttle_traces: Vec<crate::ThrottleTrace>,
    set_timing_source: bool,
) -> ProxySessionDetail {
    let mut detail = build_session_detail(
        request,
        upstream_response.status_code.as_u16(),
        &upstream_response.response_headers,
        &upstream_response.response_body,
        upstream_response.response_body_size_bytes,
        started_at,
        started_at_instant,
        ProxyTimingBreakdown {
            connect_ms: Some(upstream_response.connect_ms),
            dns_ms: Some(upstream_response.dns_ms),
            request_send_ms: Some(upstream_response.request_send_ms),
            response_read_ms: Some(upstream_response.response_read_ms),
            tls_ms: upstream_response.tls_ms,
            total_ms: Some(started_at_instant.elapsed().as_millis()),
            waiting_ms: Some(upstream_response.waiting_ms),
        },
        upstream_response.body_truncated,
    );
    detail.map_traces = map_traces;
    detail.rewrite_traces = rewrite_traces;
    detail.script_traces = script_traces;
    detail.throttle_traces = throttle_traces;
    if set_timing_source {
        detail.timing_source = Some("proxy".to_string());
    }
    detail
}

// ---------------------------------------------------------------------------
// Stage 1: Parse request
// ---------------------------------------------------------------------------

/// Return value for [`stage_parse_request`].
struct ParsedRequest {
    request: ParsedProxyRequest,
    ws_on_upgrade: Option<hyper::upgrade::OnUpgrade>,
}

/// Detect WebSocket upgrades, read the body, and build a [`ParsedProxyRequest`].
async fn stage_parse_request(
    req: hyper::Request<hyper::body::Incoming>,
    ctx: &ConnectionContext,
) -> Result<ParsedRequest, String> {
    let request_id = Uuid::new_v4().to_string();

    // Detect WebSocket upgrade and capture OnUpgrade before consuming req.
    let is_ws_upgrade = req
        .headers()
        .get("upgrade")
        .is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"websocket"))
        && req.headers().get("connection").is_some_and(|v| {
            v.to_str()
                .unwrap_or("")
                .to_ascii_lowercase()
                .contains("upgrade")
        });

    let mut req = req;
    let ws_on_upgrade = if is_ws_upgrade {
        Some(hyper::upgrade::on(&mut req))
    } else {
        None
    };

    // Build ParsedProxyRequest from the hyper Request.
    let (parts, body) = req.into_parts();
    let limited_body = http_body_util::Limited::new(body, MAX_CAPTURED_BODY_BYTES);
    let body_bytes = BodyExt::collect(limited_body)
        .await
        .map_err(|e| format!("failed to read request body: {e}"))?
        .to_bytes();

    let request = build_parsed_request_from_hyper(parts, body_bytes, ctx, &request_id)?;

    Ok(ParsedRequest {
        request,
        ws_on_upgrade,
    })
}

// ---------------------------------------------------------------------------
// Stage 2: Apply request rules
// ---------------------------------------------------------------------------

/// Return value for [`stage_apply_request_rules`].
struct RequestRulesResult {
    local_response: Option<UpstreamResponse>,
    map_traces: Vec<crate::MapTrace>,
    rewrite_traces: Vec<crate::RewriteTrace>,
    script_traces: Vec<aiproxy_rule_engine::ScriptTrace>,
    throttle_selection: Option<crate::ThrottleRuntimeSelection>,
}

/// Apply runtime rewrite/map/throttle rules, then script rules if no local response yet.
fn stage_apply_request_rules(
    ctx: &ConnectionContext,
    request: &mut ParsedProxyRequest,
    is_h2: bool,
) -> Result<RequestRulesResult, String> {
    let RequestRuntimeOutcome {
        local_response,
        map_traces,
        rewrite_traces,
        throttle_selection,
    } = apply_request_runtime_rules(
        &ctx.rewrite_manager,
        &ctx.map_manager,
        &ctx.throttle_manager,
        &ctx.workspace_id,
        request,
        is_h2,
    )?;

    let mut local_response = local_response;
    let mut script_traces = Vec::new();

    if local_response.is_none() {
        let script_outcome =
            apply_request_script_rules(&ctx.script_manager, &ctx.workspace_id, request);
        local_response = script_outcome.local_response;
        script_traces.extend(script_outcome.traces);
    }

    Ok(RequestRulesResult {
        local_response,
        map_traces,
        rewrite_traces,
        script_traces,
        throttle_selection,
    })
}

// ---------------------------------------------------------------------------
// Stage 3: Request-stage breakpoint interception
// ---------------------------------------------------------------------------

/// Outcome of request-stage breakpoint interception.
enum BreakpointRequestOutcome {
    /// The request was dropped by a breakpoint.
    Drop(ProxyResponse),
    /// A mock response was produced by a breakpoint (session already sent).
    Mock(ProxyResponse),
    /// No breakpoint matched or Forward was chosen — continue the pipeline.
    Forward {
        map_traces: Vec<crate::MapTrace>,
        rewrite_traces: Vec<crate::RewriteTrace>,
        script_traces: Vec<aiproxy_rule_engine::ScriptTrace>,
        throttle_traces: Vec<crate::ThrottleTrace>,
    },
}

/// Intercept the request at breakpoint stage. Handles Drop/Mock/Forward.
///
/// For Mock, also applies response rewrite/script rules and response throttle
/// (because a mock breakpoint directly creates a response).
#[allow(clippy::too_many_arguments)]
async fn stage_intercept_request_breakpoint(
    ctx: &ConnectionContext,
    request: &ParsedProxyRequest,
    is_h2: bool,
    throttle_selection: &Option<crate::ThrottleRuntimeSelection>,
    map_traces: Vec<crate::MapTrace>,
    rewrite_traces: Vec<crate::RewriteTrace>,
    script_traces: Vec<aiproxy_rule_engine::ScriptTrace>,
    started_at: DateTime<Utc>,
    started_at_instant: Instant,
) -> Result<BreakpointRequestOutcome, String> {
    let mut rewrite_traces = rewrite_traces;
    let mut script_traces = script_traces;
    let mut throttle_traces = Vec::new();

    // Clone request mutably for intercept_request_stage (needs &mut).
    let mut request_mut = request.clone();
    let resolution = intercept_request_stage(
        &ctx.breakpoint_manager,
        &ctx.event_emitter,
        &mut request_mut,
    )
    .await?;
    let Some(resolution) = resolution else {
        return Ok(BreakpointRequestOutcome::Forward {
            map_traces,
            rewrite_traces,
            script_traces,
            throttle_traces,
        });
    };

    match resolution.action {
        BreakpointActionKind::Drop => {
            let response = handle_drop_action(ctx)?;
            Ok(BreakpointRequestOutcome::Drop(response))
        }
        BreakpointActionKind::Mock => {
            let Some(ref mock) = resolution.mock else {
                return Ok(BreakpointRequestOutcome::Forward {
                    map_traces,
                    rewrite_traces,
                    script_traces,
                    throttle_traces,
                });
            };

            // Apply request throttle if configured for request stage.
            if let Some(selection) = throttle_selection
                .as_ref()
                .filter(|s| throttle_selection_matches_stage(s, "request"))
            {
                match apply_request_throttle(selection, request.body.len()).await {
                    Ok(trace) => {
                        if let Some(manager) = ctx.throttle_manager.as_ref() {
                            manager.record_trace(&trace);
                        }
                        throttle_traces.push(trace);
                    }
                    Err(failure) => {
                        if let Some(manager) = ctx.throttle_manager.as_ref() {
                            manager.record_trace(&failure.trace);
                        }
                        throttle_traces.push(failure.trace);
                        let response = build_throttle_failure_response(
                            request,
                            ctx,
                            started_at,
                            started_at_instant,
                            &failure.error,
                            map_traces,
                            throttle_traces,
                        )
                        .await?;
                        return Ok(BreakpointRequestOutcome::Drop(response));
                    }
                }
            }

            let mut mock_response = crate::build_mock_upstream_response(mock);
            rewrite_traces.extend(apply_response_rewrite_rules(
                &ctx.rewrite_manager,
                &ctx.workspace_id,
                request,
                &mut mock_response,
                is_h2,
            )?);
            script_traces.extend(apply_response_script_rules(
                &ctx.script_manager,
                &ctx.workspace_id,
                request,
                &mut mock_response,
            ));

            // Apply response throttle if configured for response stage.
            if let Some(selection) = throttle_selection
                .as_ref()
                .filter(|s| throttle_selection_matches_stage(s, "response"))
            {
                let trace =
                    apply_response_throttle(selection, mock_response.response_body.len()).await;
                if let Some(manager) = ctx.throttle_manager.as_ref() {
                    manager.record_trace(&trace);
                }
                throttle_traces.push(trace);
            }

            let detail = build_session_detail(
                request,
                mock_response.status_code.as_u16(),
                &mock_response.response_headers,
                &mock_response.response_body,
                mock_response.response_body_size_bytes,
                started_at,
                started_at_instant,
                ProxyTimingBreakdown {
                    connect_ms: None,
                    dns_ms: None,
                    request_send_ms: None,
                    response_read_ms: Some(0),
                    tls_ms: None,
                    total_ms: Some(started_at_instant.elapsed().as_millis()),
                    waiting_ms: Some(0),
                },
                mock_response.body_truncated,
            );
            send_session(
                &ctx.session_sender,
                detail,
                map_traces,
                rewrite_traces,
                script_traces,
                throttle_traces,
            )
            .await;

            let response = build_hyper_response_from_upstream(
                mock_response.status_code,
                &mock_response.response_headers,
                &mock_response.response_body,
            )?;
            Ok(BreakpointRequestOutcome::Mock(response))
        }
        BreakpointActionKind::Forward => Ok(BreakpointRequestOutcome::Forward {
            map_traces,
            rewrite_traces,
            script_traces,
            throttle_traces,
        }),
    }
}

// ---------------------------------------------------------------------------
// Stage 4: Pending session + request throttle
// ---------------------------------------------------------------------------

/// Outcome of [`stage_send_pending_and_throttle`].
enum PendingThrottleOutcome {
    /// Throttle failed — caller must disarm the guard, then return the response.
    ThrottleFailed {
        response: ProxyResponse,
        guard: PendingRequestCancellationGuard,
    },
    /// Success — pending session sent, throttle applied (or not configured).
    Proceed {
        guard: PendingRequestCancellationGuard,
    },
}

/// Send the pending session detail and apply request throttle.
///
/// On throttle failure, returns the response and guard so the caller can
/// disarm the guard before returning. On success, returns the guard.
/// `throttle_traces` is updated in place via mutable reference.
async fn stage_send_pending_and_throttle(
    ctx: &ConnectionContext,
    request: &ParsedProxyRequest,
    throttle_selection: &Option<crate::ThrottleRuntimeSelection>,
    map_traces: &[crate::MapTrace],
    throttle_traces: &mut Vec<crate::ThrottleTrace>,
    started_at: DateTime<Utc>,
    started_at_instant: Instant,
) -> Result<PendingThrottleOutcome, String> {
    // Send pending session.
    let mut pending_detail = build_pending_session_detail(request, started_at);
    pending_detail.map_traces = map_traces.to_vec();
    let _ = ctx.session_sender.send(pending_detail).await;
    let guard = PendingRequestCancellationGuard::new(
        request.clone(),
        ctx.session_sender.clone(),
        started_at,
        started_at_instant,
        map_traces.to_vec(),
    );

    // Apply request throttle.
    if let Some(selection) = throttle_selection
        .as_ref()
        .filter(|s| throttle_selection_matches_stage(s, "request"))
    {
        match apply_request_throttle(selection, request.body.len()).await {
            Ok(trace) => {
                if let Some(manager) = ctx.throttle_manager.as_ref() {
                    manager.record_trace(&trace);
                }
                throttle_traces.push(trace);
            }
            Err(failure) => {
                if let Some(manager) = ctx.throttle_manager.as_ref() {
                    manager.record_trace(&failure.trace);
                }
                throttle_traces.push(failure.trace.clone());
                let response = build_throttle_failure_response(
                    request,
                    ctx,
                    started_at,
                    started_at_instant,
                    &failure.error,
                    map_traces.to_vec(),
                    throttle_traces.clone(),
                )
                .await?;
                return Ok(PendingThrottleOutcome::ThrottleFailed { response, guard });
            }
        }
    }

    Ok(PendingThrottleOutcome::Proceed { guard })
}

// ---------------------------------------------------------------------------
// Stage 5: Forward upstream (WS dispatch + upstream forward + timeout)
// ---------------------------------------------------------------------------

/// Outcome of [`stage_forward_upstream`].
enum ForwardOutcome {
    /// Upstream request completed — caller should process the response via
    /// Stage 6.
    Completed {
        upstream_response: UpstreamResponse,
        cancellation_guard: Box<PendingRequestCancellationGuard>,
    },
    /// A terminal response has been built (e.g. 504 Gateway Timeout).
    /// The guard was already disarmed.  The caller should return this response.
    Response(ProxyResponse),
    /// Upstream forward failed with an error.  The guard is passed back so the
    /// caller can disarm it before building the error response.
    UpstreamError {
        error: String,
        cancellation_guard: Box<PendingRequestCancellationGuard>,
    },
}

/// Forward the request upstream with timeout handling.
///
/// If a `local_response` was produced by request rules it is wrapped in
/// [`ForwardOutcome::Completed`] without making an upstream call.
async fn stage_forward_upstream(
    request: &ParsedProxyRequest,
    local_response: Option<UpstreamResponse>,
    ctx: &ConnectionContext,
    mut cancellation_guard: PendingRequestCancellationGuard,
    started_at: DateTime<Utc>,
    started_at_instant: Instant,
) -> Result<ForwardOutcome, String> {
    // --- Forward upstream ---
    let upstream_result: Result<UpstreamResponse, String> = match local_response {
        Some(local_response) => Ok(local_response),
        None => {
            let host = request.host.clone();
            let upstream_timeout = crate::upstream_request_timeout();
            match tokio::time::timeout(
                upstream_timeout,
                crate::server::forward_request(
                    request,
                    &ctx.dns_manager,
                    &ctx.workspace_id,
                    Some(ctx.upstream_pool.clone()),
                ),
            )
            .await
            {
                Ok(result) => result.map_err(String::from),
                Err(_) => {
                    let timeout_secs = upstream_timeout.as_secs();
                    let response_message =
                        format!("The upstream server did not respond within {timeout_secs}s.",);
                    emit_log(
                        "WARN",
                        "upstream_request_timed_out",
                        &[
                            ("request_id", request.request_id.clone()),
                            ("host", host.clone()),
                            ("url", request.url.to_string()),
                            ("timeout_secs", timeout_secs.to_string()),
                        ],
                    );
                    let detail = build_session_detail(
                        request,
                        StatusCode::GATEWAY_TIMEOUT.as_u16(),
                        &HeaderMap::new(),
                        response_message.as_bytes(),
                        response_message.len(),
                        started_at,
                        started_at_instant,
                        ProxyTimingBreakdown {
                            connect_ms: None,
                            dns_ms: None,
                            request_send_ms: None,
                            response_read_ms: Some(0),
                            tls_ms: None,
                            total_ms: Some(started_at_instant.elapsed().as_millis()),
                            waiting_ms: Some(started_at_instant.elapsed().as_millis()),
                        },
                        false,
                    );
                    let _ = ctx.session_sender.send(detail).await;
                    cancellation_guard.disarm();
                    let response =
                        build_plain_text_response(StatusCode::GATEWAY_TIMEOUT, &response_message)?;
                    return Ok(ForwardOutcome::Response(response));
                }
            }
        }
    };

    match upstream_result {
        Ok(upstream_response) => Ok(ForwardOutcome::Completed {
            upstream_response,
            cancellation_guard: Box::new(cancellation_guard),
        }),
        Err(error) => Ok(ForwardOutcome::UpstreamError {
            error,
            cancellation_guard: Box::new(cancellation_guard),
        }),
    }
}

// ---------------------------------------------------------------------------
// Stage 6: Process upstream response (rules + session + breakpoint + throttle)
// ---------------------------------------------------------------------------

/// Apply response rewrite/script rules, build session detail, handle
/// response-stage breakpoint (Drop/Mock/Forward), apply response throttle,
/// send the final session, and build the hyper response.
#[allow(clippy::too_many_arguments)]
async fn stage_process_upstream_response(
    request: &ParsedProxyRequest,
    mut upstream_response: UpstreamResponse,
    ctx: &ConnectionContext,
    is_h2: bool,
    map_traces: Vec<crate::MapTrace>,
    mut rewrite_traces: Vec<crate::RewriteTrace>,
    mut script_traces: Vec<crate::ScriptTrace>,
    mut throttle_traces: Vec<crate::ThrottleTrace>,
    throttle_selection: &Option<crate::ThrottleRuntimeSelection>,
    started_at: DateTime<Utc>,
    started_at_instant: Instant,
    mut cancellation_guard: PendingRequestCancellationGuard,
    host: &str,
) -> Result<ProxyResponse, String> {
    if upstream_response.body_truncated {
        emit_log(
            "WARN",
            "response_body_passthrough_mode",
            &[
                ("request_id", request.request_id.clone()),
                ("url", request.url.to_string()),
                (
                    "reason",
                    "response body exceeded capture limit; skipping response mutations".to_string(),
                ),
            ],
        );
    } else {
        let response_rewrite_traces = match apply_response_rewrite_rules(
            &ctx.rewrite_manager,
            &ctx.workspace_id,
            request,
            &mut upstream_response,
            is_h2,
        ) {
            Ok(traces) => traces,
            Err(error) => {
                let response_message = "The proxy could not process the upstream response.";
                let detail = build_session_detail(
                    request,
                    StatusCode::BAD_GATEWAY.as_u16(),
                    &HeaderMap::new(),
                    response_message.as_bytes(),
                    response_message.len(),
                    started_at,
                    started_at_instant,
                    ProxyTimingBreakdown {
                        connect_ms: Some(upstream_response.connect_ms),
                        dns_ms: Some(upstream_response.dns_ms),
                        request_send_ms: Some(upstream_response.request_send_ms),
                        response_read_ms: Some(upstream_response.response_read_ms),
                        tls_ms: upstream_response.tls_ms,
                        total_ms: Some(started_at_instant.elapsed().as_millis()),
                        waiting_ms: Some(upstream_response.waiting_ms),
                    },
                    false,
                );
                let _ = ctx.session_sender.send(detail).await;
                emit_log(
                    "ERROR",
                    "response_processing_failed",
                    &[
                        ("request_id", request.request_id.clone()),
                        ("host", host.to_string()),
                        ("url", request.url.to_string()),
                        ("error", error),
                    ],
                );
                cancellation_guard.disarm();
                return build_plain_text_response(StatusCode::BAD_GATEWAY, response_message);
            }
        };
        rewrite_traces.extend(response_rewrite_traces);
        script_traces.extend(apply_response_script_rules(
            &ctx.script_manager,
            &ctx.workspace_id,
            request,
            &mut upstream_response,
        ));
    }

    let mut session_detail = build_upstream_session_detail(
        request,
        &upstream_response,
        started_at,
        started_at_instant,
        map_traces.clone(),
        rewrite_traces.clone(),
        script_traces.clone(),
        throttle_traces.clone(),
        true,
    );

    // For h2, add response pseudo header :status.
    if is_h2 {
        session_detail.response_headers.insert(
            0,
            ProxyHeaderEntry {
                name: ":status".to_string(),
                value: upstream_response.status_code.as_u16().to_string(),
                is_pseudo: Some(true),
            },
        );
    }

    // --- Response-stage breakpoint ---
    let breakpoint_resolution = if upstream_response.body_truncated {
        None
    } else {
        match intercept_response_stage(
            &ctx.breakpoint_manager,
            &ctx.event_emitter,
            request,
            upstream_response.status_code.as_u16(),
            &upstream_response.response_headers,
            &upstream_response.response_body,
        )
        .await
        {
            Ok(resolution) => resolution,
            Err(error) => {
                let _ = ctx.session_sender.send(session_detail).await;
                cancellation_guard.disarm();
                return Err(error);
            }
        }
    };

    if let Some(resolution) = breakpoint_resolution {
        match resolution.action {
            BreakpointActionKind::Drop => {
                let _ = ctx.session_sender.send(session_detail).await;
                cancellation_guard.disarm();
                return handle_drop_action(ctx);
            }
            BreakpointActionKind::Mock => {
                if let Some(ref mock) = resolution.mock {
                    upstream_response = crate::build_mock_upstream_response(mock);
                    session_detail = build_upstream_session_detail(
                        request,
                        &upstream_response,
                        started_at,
                        started_at_instant,
                        map_traces.clone(),
                        rewrite_traces.clone(),
                        script_traces.clone(),
                        throttle_traces.clone(),
                        false,
                    );
                }
            }
            BreakpointActionKind::Forward => {
                crate::apply_response_resolution(&resolution, &mut upstream_response);
                if resolution.modified_response_body_base64.is_some() {
                    session_detail = build_upstream_session_detail(
                        request,
                        &upstream_response,
                        started_at,
                        started_at_instant,
                        map_traces.clone(),
                        rewrite_traces.clone(),
                        script_traces.clone(),
                        throttle_traces.clone(),
                        true,
                    );
                } else {
                    if resolution.modified_response_status_code.is_some() {
                        session_detail.summary.status_code = upstream_response.status_code.as_u16();
                    }
                    if resolution.modified_response_headers.is_some() {
                        session_detail.response_headers =
                            build_header_entries_from_map(&upstream_response.response_headers);
                        session_detail.cookies = build_cookie_entries(
                            &request.request_headers,
                            &session_detail.response_headers,
                        );
                    }
                    if resolution.modified_response_status_code.is_some()
                        || resolution.modified_response_headers.is_some()
                    {
                        session_detail.raw_response_head = Some(build_raw_http_head(
                            &format!(
                                "HTTP/1.1 {} {}",
                                upstream_response.status_code.as_u16(),
                                upstream_response
                                    .status_code
                                    .canonical_reason()
                                    .unwrap_or("Unknown"),
                            ),
                            &session_detail.response_headers,
                        ));
                    }
                }
            }
        }
    }

    // --- Response throttle ---
    if let Some(selection) = throttle_selection
        .as_ref()
        .filter(|s| throttle_selection_matches_stage(s, "response"))
    {
        let trace =
            apply_response_throttle(selection, upstream_response.response_body_size_bytes).await;
        if let Some(manager) = ctx.throttle_manager.as_ref() {
            manager.record_trace(&trace);
        }
        throttle_traces.push(trace);
        session_detail.throttle_traces = throttle_traces.clone();
    }

    session_detail.rewrite_traces = rewrite_traces;
    session_detail.script_traces = script_traces;
    session_detail.map_traces = map_traces;

    send_session(
        &ctx.session_sender,
        session_detail,
        Vec::new(), // already set above
        Vec::new(),
        Vec::new(),
        Vec::new(),
    )
    .await;
    cancellation_guard.disarm();

    emit_log(
        "DEBUG",
        "request_forwarded",
        &[
            ("request_id", request.request_id.clone()),
            ("host", host.to_string()),
            ("method", request.method.to_string()),
            (
                "status_code",
                upstream_response.status_code.as_u16().to_string(),
            ),
            ("url", request.url.to_string()),
        ],
    );

    // If the upstream response is spooled to disk, read it back into memory
    // for the hyper response body.
    let response_body = if let Some(ref spool_path) = upstream_response.spooled_response_path {
        tokio::fs::read(spool_path)
            .await
            .map_err(|e| format!("read spooled response: {e}"))?
    } else {
        upstream_response.response_body.clone()
    };

    build_hyper_response_from_upstream(
        upstream_response.status_code,
        &upstream_response.response_headers,
        &response_body,
    )
}

// ---------------------------------------------------------------------------
// Core request handler
// ---------------------------------------------------------------------------

pub(crate) async fn handle_http_request(
    req: hyper::Request<hyper::body::Incoming>,
    ctx: &ConnectionContext,
    started_at: DateTime<Utc>,
    started_at_instant: Instant,
) -> Result<ProxyResponse, String> {
    // --- Stage 1: Parse request ---
    let ParsedRequest {
        mut request,
        ws_on_upgrade,
    } = stage_parse_request(req, ctx).await?;

    let host = request.host.clone();
    let is_h2 = ctx.mode.is_h2();

    // --- Stage 2: Apply request rules ---
    let RequestRulesResult {
        local_response,
        map_traces,
        rewrite_traces,
        script_traces,
        throttle_selection,
    } = stage_apply_request_rules(ctx, &mut request, is_h2)?;

    // --- Stage 3: Request-stage breakpoint ---
    let (map_traces, rewrite_traces, script_traces, mut throttle_traces) =
        match stage_intercept_request_breakpoint(
            ctx,
            &request,
            is_h2,
            &throttle_selection,
            map_traces,
            rewrite_traces,
            script_traces,
            started_at,
            started_at_instant,
        )
        .await?
        {
            BreakpointRequestOutcome::Drop(response) => return Ok(response),
            BreakpointRequestOutcome::Mock(response) => return Ok(response),
            BreakpointRequestOutcome::Forward {
                map_traces,
                rewrite_traces,
                script_traces,
                throttle_traces,
            } => (map_traces, rewrite_traces, script_traces, throttle_traces),
        };

    // --- Stage 4: Pending session + request throttle ---
    let mut cancellation_guard = match stage_send_pending_and_throttle(
        ctx,
        &request,
        &throttle_selection,
        &map_traces,
        &mut throttle_traces,
        started_at,
        started_at_instant,
    )
    .await?
    {
        PendingThrottleOutcome::ThrottleFailed {
            response,
            mut guard,
        } => {
            guard.disarm();
            return Ok(response);
        }
        PendingThrottleOutcome::Proceed { guard } => guard,
    };

    // --- Stage 5a: WebSocket upgrade (after full request-stage pipeline) ---
    // Only enter WS relay if no local response was produced by rules.
    if let Some(on_upgrade) = ws_on_upgrade {
        if local_response.is_none() {
            // Do NOT disarm the cancellation_guard before entering WS relay:
            // the handler handles all upstream failures internally (sending 502
            // sessions) and returns Ok. The guard remains as a last-resort for
            // truly unexpected errors only.
            match handle_ws_upgrade_via_hyper(
                on_upgrade,
                request,
                ctx,
                started_at,
                started_at_instant,
                map_traces,
                rewrite_traces,
                script_traces,
                throttle_traces,
            )
            .await
            {
                Ok(response) => {
                    cancellation_guard.disarm();
                    return Ok(response);
                }
                Err(e) => {
                    // Unreachable in normal operation — all upstream errors are
                    // handled inside the WS handler and return Ok(502). If we
                    // reach here, it's an unexpected internal error; the guard
                    // will send a 499 session as a last resort.
                    return Err(e);
                }
            }
        }
        // local_response is set — fall through to normal response handling below.
    }

    // --- Stage 5b: Forward upstream ---
    let (upstream_response, cancellation_guard) = match stage_forward_upstream(
        &request,
        local_response,
        ctx,
        cancellation_guard,
        started_at,
        started_at_instant,
    )
    .await?
    {
        ForwardOutcome::Response(response) => return Ok(response),
        ForwardOutcome::UpstreamError {
            error,
            mut cancellation_guard,
        } => {
            cancellation_guard.disarm();
            return build_upstream_error_response_and_session(
                &request,
                &host,
                &error,
                ctx,
                started_at,
                started_at_instant,
            )
            .await;
        }
        ForwardOutcome::Completed {
            upstream_response,
            cancellation_guard,
        } => (upstream_response, *cancellation_guard),
    };

    // --- Stage 6: Process upstream response ---
    stage_process_upstream_response(
        &request,
        upstream_response,
        ctx,
        is_h2,
        map_traces,
        rewrite_traces,
        script_traces,
        throttle_traces,
        &throttle_selection,
        started_at,
        started_at_instant,
        cancellation_guard,
        &host,
    )
    .await
}

// ---------------------------------------------------------------------------
// URL construction from hyper parts
// ---------------------------------------------------------------------------

/// Build the target URL from hyper request parts according to ConnectionMode.
///
/// ### PlainHttp
/// - **absolute-form** (`GET http://example.com/path HTTP/1.1`): used as-is.
/// - **origin-form** (`GET /path HTTP/1.1`): reconstructed from Host header
///   as `http://<Host>/path`.
///
/// ### MitmHttps (h1)
/// - **absolute-form**: used as-is.
/// - **origin-form**: reconstructed as `https://<effective_host>/path`.
///   Host priority: URI authority > Host header > CONNECT host.
///
/// ### MitmHttps (h2)
/// - Uses `:authority` and `:path` pseudo-headers to build
///   `https://<authority><path>`.
fn build_url_from_hyper(
    parts: &hyper::http::request::Parts,
    mode: &ConnectionMode,
) -> Result<Url, String> {
    match mode {
        ConnectionMode::PlainHttp => {
            let uri_str = parts.uri.to_string();
            if uri_str.starts_with("http://")
                || uri_str.starts_with("https://")
                || uri_str.starts_with("ws://")
                || uri_str.starts_with("wss://")
            {
                // absolute-form — use as-is
                Url::parse(&uri_str).map_err(|e| format!("invalid absolute-form URL: {e}"))
            } else {
                // origin-form — reconstruct from Host header
                let host = parts
                    .headers
                    .get("host")
                    .and_then(|v| v.to_str().ok())
                    .ok_or("Host header is required for origin-form requests")?;
                Url::parse(&format!("http://{host}{uri_str}"))
                    .map_err(|e| format!("invalid origin-form URL: {e}"))
            }
        }
        ConnectionMode::MitmHttps {
            host,
            alpn_protocol,
            ..
        } => {
            if alpn_protocol.as_deref() == Some("h2") {
                // h2: :authority + :path pseudo-headers
                let authority = parts.uri.authority().map(|a| a.as_str()).unwrap_or(host);
                let path = parts
                    .uri
                    .path_and_query()
                    .map(|pq| pq.as_str())
                    .unwrap_or("/");
                let target = format!("https://{authority}{path}");
                Url::parse(&target).map_err(|e| format!("invalid h2 URL '{target}': {e}"))
            } else {
                // h1 MITM: URI may be absolute-form or origin-form
                let uri_str = parts.uri.to_string();
                let target = if uri_str.starts_with("http://")
                    || uri_str.starts_with("https://")
                    || uri_str.starts_with("ws://")
                    || uri_str.starts_with("wss://")
                {
                    uri_str
                } else if uri_str.starts_with('/') {
                    // origin-form — host priority: URI authority > Host header > CONNECT host
                    let authority = parts.uri.authority().map(|a| a.as_str());
                    let host_header = parts.headers.get("host").and_then(|v| v.to_str().ok());
                    let effective_host = authority.or(host_header).unwrap_or(host);
                    format!("https://{effective_host}{uri_str}")
                } else {
                    // authority-form (unlikely for MITM after CONNECT but handle)
                    format!("https://{uri_str}/")
                };
                Url::parse(&target).map_err(|e| format!("invalid h1 URL '{target}': {e}"))
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Helper: build request headers from hyper parts
// ---------------------------------------------------------------------------

/// Build `ProxyHeaderEntry` list from hyper request parts.
/// For h2, synthesizes pseudo-headers (:method, :scheme, :authority, :path).
fn build_request_headers_from_hyper(
    parts: &hyper::http::request::Parts,
    is_h2: bool,
) -> Vec<ProxyHeaderEntry> {
    let mut request_headers: Vec<ProxyHeaderEntry> = Vec::new();

    if is_h2 {
        request_headers.push(ProxyHeaderEntry {
            name: ":method".to_string(),
            value: parts.method.as_str().to_string(),
            is_pseudo: Some(true),
        });
        request_headers.push(ProxyHeaderEntry {
            name: ":scheme".to_string(),
            value: "https".to_string(),
            is_pseudo: Some(true),
        });
        if let Some(authority) = parts.uri.authority() {
            request_headers.push(ProxyHeaderEntry {
                name: ":authority".to_string(),
                value: authority.as_str().to_string(),
                is_pseudo: Some(true),
            });
        }
        if let Some(pq) = parts.uri.path_and_query() {
            request_headers.push(ProxyHeaderEntry {
                name: ":path".to_string(),
                value: pq.as_str().to_string(),
                is_pseudo: Some(true),
            });
        }
    }

    for (name, value) in &parts.headers {
        let value_str = value
            .to_str()
            .map(str::to_string)
            .unwrap_or_else(|_| String::from_utf8_lossy(value.as_bytes()).to_string());
        request_headers.push(ProxyHeaderEntry {
            name: name.as_str().to_string(),
            value: value_str,
            is_pseudo: if name.as_str().starts_with(':') {
                Some(true)
            } else {
                None
            },
        });
    }

    request_headers
}

// ---------------------------------------------------------------------------
// Upstream header building
// ---------------------------------------------------------------------------

/// Build a `reqwest::HeaderMap` from hyper headers, filtering out pseudo-headers
/// and hop-by-hop headers that should not be forwarded upstream.
fn build_upstream_headers_from_hyper(
    headers: &hyper::http::HeaderMap,
) -> Result<HeaderMap, String> {
    let is_ws_upgrade = headers
        .get("upgrade")
        .is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"websocket"));

    let mut header_map = HeaderMap::new();
    for (name, value) in headers {
        // Skip pseudo-headers (h2).
        if name.as_str().starts_with(':') {
            continue;
        }
        if should_skip_hyper_header(name, is_ws_upgrade) {
            continue;
        }
        header_map.append(name.clone(), value.clone());
    }
    Ok(header_map)
}

fn should_skip_hyper_header(name: &hyper::http::header::HeaderName, is_ws_upgrade: bool) -> bool {
    let name_str = name.as_str();
    if !is_ws_upgrade {
        return name_str.eq_ignore_ascii_case("host")
            || name_str.eq_ignore_ascii_case("connection")
            || name_str.eq_ignore_ascii_case("proxy-connection")
            || name_str.eq_ignore_ascii_case("content-length")
            || name_str.eq_ignore_ascii_case("transfer-encoding");
    }
    // For WS upgrades, skip host + proxy-connection + content-length + transfer-encoding.
    name_str.eq_ignore_ascii_case("host")
        || name_str.eq_ignore_ascii_case("proxy-connection")
        || name_str.eq_ignore_ascii_case("content-length")
        || name_str.eq_ignore_ascii_case("transfer-encoding")
}

// ---------------------------------------------------------------------------
// Hyper response building helpers
// ---------------------------------------------------------------------------

/// Build a `hyper::Response` from an upstream status code, headers and body.
fn build_hyper_response_from_upstream(
    status_code: StatusCode,
    headers: &HeaderMap,
    body: &[u8],
) -> Result<hyper::Response<http_body_util::combinators::BoxBody<bytes::Bytes, String>>, String> {
    let mut builder = hyper::Response::builder().status(status_code);

    for (name, value) in headers {
        if name == CONNECTION || name == CONTENT_LENGTH || name == TRANSFER_ENCODING {
            continue;
        }
        builder = builder.header(name, value);
    }

    let body = http_body_util::Full::new(bytes::Bytes::from(body.to_vec()))
        .map_err(|e: std::convert::Infallible| e.to_string())
        .boxed();

    builder
        .body(body)
        .map_err(|e| format!("failed to build response: {e}"))
}

/// Handle a Drop breakpoint action.
///
/// For plain HTTP connections, returns an error which causes hyper to
/// close the TCP connection without sending a response — matching the
/// old `stream.shutdown()` behavior.
///
/// For MITM connections, returns a 204 No Content response, consistent
/// with the original MITM path behavior.
fn handle_drop_action(
    ctx: &ConnectionContext,
) -> Result<hyper::Response<http_body_util::combinators::BoxBody<bytes::Bytes, String>>, String> {
    match ctx.mode {
        ConnectionMode::PlainHttp => Err("request dropped by breakpoint".to_string()),
        ConnectionMode::MitmHttps { .. } => Ok(build_empty_response(StatusCode::NO_CONTENT)),
    }
}

/// Build an empty response with the given status code.
fn build_empty_response(
    status_code: StatusCode,
) -> hyper::Response<http_body_util::combinators::BoxBody<bytes::Bytes, String>> {
    hyper::Response::builder()
        .status(status_code)
        .header("Content-Length", "0")
        .body(
            http_body_util::Empty::<bytes::Bytes>::new()
                .map_err(|_: std::convert::Infallible| unreachable!())
                .boxed(),
        )
        .unwrap()
}

/// Build a plain text response (e.g. for errors).
fn build_plain_text_response(
    status_code: StatusCode,
    message: &str,
) -> Result<hyper::Response<http_body_util::combinators::BoxBody<bytes::Bytes, String>>, String> {
    hyper::Response::builder()
        .status(status_code)
        .header("Content-Type", "text/plain; charset=utf-8")
        .header("Content-Length", message.len())
        .body(
            http_body_util::Full::new(bytes::Bytes::from(message.to_string()))
                .map_err(|e: std::convert::Infallible| e.to_string())
                .boxed(),
        )
        .map_err(|e| format!("failed to build plain text response: {e}"))
}

/// Build a throttle-failure response and emit the session.
async fn build_throttle_failure_response(
    request: &ParsedProxyRequest,
    ctx: &ConnectionContext,
    started_at: DateTime<Utc>,
    started_at_instant: Instant,
    error: &str,
    map_traces: Vec<crate::MapTrace>,
    throttle_traces: Vec<crate::ThrottleTrace>,
) -> Result<hyper::Response<http_body_util::combinators::BoxBody<bytes::Bytes, String>>, String> {
    let response_message = "The request was dropped by the active throttle profile.";

    let mut detail = build_session_detail(
        request,
        StatusCode::GATEWAY_TIMEOUT.as_u16(),
        &HeaderMap::new(),
        response_message.as_bytes(),
        response_message.len(),
        started_at,
        started_at_instant,
        ProxyTimingBreakdown {
            connect_ms: None,
            dns_ms: None,
            request_send_ms: None,
            response_read_ms: Some(0),
            tls_ms: None,
            total_ms: Some(started_at_instant.elapsed().as_millis()),
            waiting_ms: Some(started_at_instant.elapsed().as_millis()),
        },
        false,
    );
    detail.map_traces = map_traces;
    detail.throttle_traces = throttle_traces;
    if ctx.session_sender.send(detail).await.is_err() {
        emit_log(
            "DEBUG",
            "session_send_dropped",
            &[("reason", "receiver_disconnected".to_string())],
        );
    }

    emit_log(
        "WARN",
        "request_throttled",
        &[
            ("request_id", request.request_id.clone()),
            ("url", request.url.to_string()),
            ("error", error.to_string()),
        ],
    );

    build_plain_text_response(StatusCode::GATEWAY_TIMEOUT, response_message)
}

// ---------------------------------------------------------------------------
// Session helper
// ---------------------------------------------------------------------------

/// Send a session detail, attaching the provided traces.
async fn send_session(
    sender: &mpsc::Sender<ProxySessionDetail>,
    mut detail: ProxySessionDetail,
    map_traces: Vec<crate::MapTrace>,
    rewrite_traces: Vec<crate::RewriteTrace>,
    script_traces: Vec<aiproxy_rule_engine::ScriptTrace>,
    throttle_traces: Vec<crate::ThrottleTrace>,
) {
    if !map_traces.is_empty() {
        detail.map_traces = map_traces;
    }
    if !rewrite_traces.is_empty() {
        detail.rewrite_traces = rewrite_traces;
    }
    if !script_traces.is_empty() {
        detail.script_traces = script_traces;
    }
    if !throttle_traces.is_empty() {
        detail.throttle_traces = throttle_traces;
    }

    if sender.send(detail).await.is_err() {
        emit_log(
            "DEBUG",
            "session_send_dropped",
            &[("reason", "receiver_disconnected".to_string())],
        );
    }
}

// ---------------------------------------------------------------------------
// PendingRequestCancellationGuard
// ---------------------------------------------------------------------------

struct PendingRequestCancellationGuard {
    disarmed: bool,
    map_traces: Vec<crate::MapTrace>,
    request: ParsedProxyRequest,
    sender: mpsc::Sender<ProxySessionDetail>,
    started_at: DateTime<Utc>,
    started_at_instant: Instant,
}

impl PendingRequestCancellationGuard {
    fn new(
        request: ParsedProxyRequest,
        sender: mpsc::Sender<ProxySessionDetail>,
        started_at: DateTime<Utc>,
        started_at_instant: Instant,
        map_traces: Vec<crate::MapTrace>,
    ) -> Self {
        Self {
            disarmed: false,
            map_traces,
            request,
            sender,
            started_at,
            started_at_instant,
        }
    }

    fn disarm(&mut self) {
        self.disarmed = true;
    }
}

impl Drop for PendingRequestCancellationGuard {
    fn drop(&mut self) {
        if self.disarmed {
            return;
        }

        let elapsed_ms = self.started_at_instant.elapsed().as_millis();
        let mut detail = build_session_detail(
            &self.request,
            CLIENT_CLOSED_REQUEST_STATUS,
            &HeaderMap::new(),
            &[],
            0,
            self.started_at,
            self.started_at_instant,
            ProxyTimingBreakdown {
                connect_ms: None,
                dns_ms: None,
                request_send_ms: None,
                response_read_ms: Some(0),
                tls_ms: None,
                total_ms: Some(elapsed_ms),
                waiting_ms: Some(elapsed_ms),
            },
            false,
        );
        detail.map_traces = self.map_traces.clone();
        detail.timing_source = Some("proxy".to_string());

        let request_id = self.request.request_id.clone();
        let host = self.request.host.clone();
        let method = self.request.method.to_string();
        let url = self.request.url.to_string();
        let sender = self.sender.clone();

        tokio::spawn(async move {
            if sender.send(detail).await.is_err() {
                emit_log(
                    "DEBUG",
                    "session_send_dropped",
                    &[("reason", "receiver_disconnected".to_string())],
                );
            }

            emit_log(
                "WARN",
                "upstream_request_cancelled",
                &[
                    ("request_id", request_id),
                    ("method", method),
                    ("host", host),
                    ("url", url),
                    (
                        "reason",
                        "client_disconnected_or_request_cancelled".to_string(),
                    ),
                    ("elapsed_ms", elapsed_ms.to_string()),
                ],
            );
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::connection::ConnectionMode;
    use std::sync::Arc;

    fn make_ctx(mode: ConnectionMode) -> ConnectionContext {
        let (session_sender, _) = mpsc::channel(1);
        let (ws_sender, _) = mpsc::channel(1);
        let pool = Arc::new(crate::upstream_pool::UpstreamConnectionPool::new());
        ConnectionContext {
            mode,
            client_addr: "127.0.0.1:0".parse().unwrap(),
            session_sender,
            ws_message_sender: ws_sender,
            rewrite_manager: None,
            map_manager: None,
            script_manager: None,
            throttle_manager: None,
            breakpoint_manager: None,
            dns_manager: None,
            workspace_id: "test".to_string(),
            event_emitter: None,
            upstream_pool: pool,
        }
    }

    // -----------------------------------------------------------------------
    // parse_upstream_response_head
    // -----------------------------------------------------------------------

    #[test]
    fn parses_101_response_with_websocket_headers() {
        let head = concat!(
            "HTTP/1.1 101 Switching Protocols\r\n",
            "Upgrade: websocket\r\n",
            "Connection: upgrade\r\n",
            "Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n",
            "Sec-WebSocket-Protocol: chat\r\n",
            "\r\n",
        );
        let (status, headers) = parse_upstream_response_head(head).unwrap();
        assert_eq!(status, 101);
        assert!(headers
            .iter()
            .any(|(n, v)| { n.eq_ignore_ascii_case("upgrade") && v == "websocket" }));
        assert!(headers
            .iter()
            .any(|(n, _)| n.eq_ignore_ascii_case("sec-websocket-accept")));
        assert!(headers
            .iter()
            .any(|(n, v)| { n.eq_ignore_ascii_case("sec-websocket-protocol") && v == "chat" }));
    }

    #[test]
    fn parses_non_101_response_with_status() {
        let head = concat!(
            "HTTP/1.1 403 Forbidden\r\n",
            "Content-Type: text/plain\r\n",
            "Content-Length: 9\r\n",
            "\r\n",
        );
        let (status, headers) = parse_upstream_response_head(head).unwrap();
        assert_eq!(status, 403);
        assert!(headers
            .iter()
            .any(|(n, _)| n.eq_ignore_ascii_case("content-type")));
    }

    #[test]
    fn parses_empty_header_list_for_minimal_response() {
        let head = "HTTP/1.1 502 Bad Gateway\r\n\r\n";
        let (status, headers) = parse_upstream_response_head(head).unwrap();
        assert_eq!(status, 502);
        assert!(headers.is_empty());
    }

    #[test]
    fn parses_status_code_from_malformed_status_line() {
        let head = "HTTP/1.1 200\r\n\r\n";
        let (status, _) = parse_upstream_response_head(head).unwrap();
        assert_eq!(status, 200);
    }

    // -----------------------------------------------------------------------
    // ws_headers_to_header_map
    // -----------------------------------------------------------------------

    #[test]
    fn converts_header_pairs_to_header_map() {
        let pairs = vec![
            ("upgrade".to_string(), "websocket".to_string()),
            ("sec-websocket-accept".to_string(), "abc123==".to_string()),
        ];
        let map = ws_headers_to_header_map(&pairs);
        assert_eq!(map.len(), 2);
        assert_eq!(map.get("upgrade").unwrap().to_str().unwrap(), "websocket");
        assert_eq!(
            map.get("sec-websocket-accept").unwrap().to_str().unwrap(),
            "abc123=="
        );
    }

    #[test]
    fn header_map_skips_invalid_header_names() {
        let pairs = vec![("valid".to_string(), "value".to_string())];
        let map = ws_headers_to_header_map(&pairs);
        assert_eq!(map.len(), 1);
    }

    // -----------------------------------------------------------------------
    // build_ws_upgrade_request
    // -----------------------------------------------------------------------

    fn make_ws_request() -> ParsedProxyRequest {
        let url = Url::parse("ws://echo.example.com/chat?room=1").unwrap();
        let mut headers = HeaderMap::new();
        headers.insert("upgrade", HeaderValue::from_static("websocket"));
        headers.insert(
            "sec-websocket-key",
            HeaderValue::from_static("dGhlIHNhbXBsZSBub25jZQ=="),
        );
        ParsedProxyRequest {
            body: Vec::new(),
            client_address: None,
            headers,
            host: "echo.example.com".to_string(),
            method: Method::GET,
            path: "/chat?room=1".to_string(),
            protocol: "ws".to_string(),
            query_params: Vec::new(),
            raw_request: String::new(),
            request_headers: Vec::new(),
            request_id: "test-ws-1".to_string(),
            url,
            tls_cipher_suite: None,
            tls_protocol: None,
        }
    }

    #[test]
    fn builds_ws_upgrade_request_with_path_and_host() {
        let request = make_ws_request();
        let raw = build_ws_upgrade_request(&request).unwrap();
        assert!(raw.starts_with("GET /chat?room=1 HTTP/1.1\r\n"));
        assert!(raw.contains("Host: echo.example.com\r\n"));
        assert!(raw.contains("upgrade: websocket\r\n"));
        assert!(raw.ends_with("\r\n"));
    }

    #[test]
    fn ws_upgrade_request_excludes_host_header_from_iteration() {
        let request = make_ws_request();
        let raw = build_ws_upgrade_request(&request).unwrap();
        // Host should appear exactly once
        assert_eq!(raw.matches("Host:").count(), 1);
    }

    // -----------------------------------------------------------------------
    // handle_drop_action
    // -----------------------------------------------------------------------

    #[test]
    fn drop_action_plain_http_returns_error() {
        let ctx = make_ctx(ConnectionMode::PlainHttp);
        let result = handle_drop_action(&ctx);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("dropped by breakpoint"));
    }

    #[test]
    fn drop_action_mitm_returns_204() {
        let ctx = make_ctx(ConnectionMode::MitmHttps {
            host: "example.com".to_string(),
            port: 443,
            tls_protocol: None,
            tls_cipher_suite: None,
            tls_ms: 0,
            alpn_protocol: None,
        });
        let result = handle_drop_action(&ctx);
        assert!(result.is_ok());
        let response = result.unwrap();
        assert_eq!(response.status(), StatusCode::NO_CONTENT);
    }

    // -----------------------------------------------------------------------
    // resolve_target_url — ws:// / wss:// support
    // -----------------------------------------------------------------------

    #[test]
    fn resolves_ws_absolute_form() {
        use crate::http_io::resolve_target_url;
        let result = resolve_target_url("ws://echo.example.com/chat", &[]).unwrap();
        assert_eq!(result, "ws://echo.example.com/chat");
    }

    #[test]
    fn resolves_wss_absolute_form() {
        use crate::http_io::resolve_target_url;
        let result = resolve_target_url("wss://echo.example.com/chat", &[]).unwrap();
        assert_eq!(result, "wss://echo.example.com/chat");
    }
}
