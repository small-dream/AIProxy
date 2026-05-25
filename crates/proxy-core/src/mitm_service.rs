use super::*;
use crate::{
    apply_request_runtime_rules, apply_request_script_rules, apply_request_throttle,
    apply_response_rewrite_rules, apply_response_script_rules, apply_response_throttle,
    build_cookie_entries, build_header_entries_from_map, build_pending_session_detail,
    build_query_params, build_raw_http_head, build_request_path, build_session_detail,
    emit_log,
    intercept_request_stage, intercept_response_stage,
    throttle_selection_matches_stage, RequestRuntimeOutcome,
    BreakpointActionKind, BreakpointEventEmitter, BreakpointManager, DnsManager,
    MapManager, ParsedProxyRequest, ProxySessionDetail, ProxyTimingBreakdown,
    RewriteManager, ScriptManager, ThrottleManager,
    UpstreamResponse,
};
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;
use http_body_util::BodyExt;

/// Shared state for a single MITM TLS connection. Created once per TLS handshake,
/// cloned into every request handled on this connection.
#[allow(dead_code)]
pub(crate) struct MitmConnectionState {
    pub host: String,
    pub port: u16,
    pub client_addr: std::net::SocketAddr,
    pub tls_protocol: Option<String>,
    pub tls_cipher_suite: Option<String>,
    pub tls_ms: u128,
    pub alpn_protocol: Option<String>,
    pub session_sender: tokio::sync::mpsc::Sender<ProxySessionDetail>,
    pub ws_message_sender: tokio::sync::mpsc::Sender<crate::ws::WsMessageData>,
    pub rewrite_manager: Option<Arc<RewriteManager>>,
    pub map_manager: Option<Arc<MapManager>>,
    pub script_manager: Option<Arc<ScriptManager>>,
    pub throttle_manager: Option<Arc<ThrottleManager>>,
    pub breakpoint_manager: Option<Arc<BreakpointManager>>,
    pub dns_manager: Option<Arc<DnsManager>>,
    pub workspace_id: String,
    pub event_emitter: Option<BreakpointEventEmitter>,
    pub started_at: DateTime<Utc>,
    pub started_at_instant: Instant,
    pub upstream_pool: Arc<crate::upstream_pool::UpstreamConnectionPool>,
}

/// A `hyper::service::Service` that processes each HTTP request arriving on a
/// MITM'd TLS connection. Hyper calls `call()` for every request; the service
/// builds a `ParsedProxyRequest`, applies rules, forwards upstream, and returns
/// the response as a `hyper::Response`.
pub(crate) struct MitmService {
    pub state: Arc<MitmConnectionState>,
}

impl hyper::service::Service<hyper::Request<hyper::body::Incoming>> for MitmService {
    type Response = hyper::Response<
        http_body_util::combinators::BoxBody<bytes::Bytes, String>,
    >;
    type Error = String;
    type Future = Pin<Box<dyn Future<Output = Result<Self::Response, Self::Error>> + Send>>;

    fn call(&self, req: hyper::Request<hyper::body::Incoming>) -> Self::Future {
        let state = self.state.clone();
        Box::pin(async move { handle_mitm_request(req, state).await })
    }
}

/// Core per-request handler for MITM connections.
///
/// Converts the hyper `Request` into a `ParsedProxyRequest`, applies rules,
/// forwards upstream (or returns a local/mock response), then builds a hyper
/// `Response` to send back through the hyper server connection.
async fn handle_mitm_request(
    req: hyper::Request<hyper::body::Incoming>,
    state: Arc<MitmConnectionState>,
) -> Result<hyper::Response<http_body_util::combinators::BoxBody<bytes::Bytes, String>>, String> {
    let request_id = Uuid::new_v4().to_string();

    // --- Build ParsedProxyRequest from the hyper Request ---
    let (parts, body) = req.into_parts();
    let body_bytes = BodyExt::collect(body)
        .await
        .map_err(|e| format!("failed to read request body: {e}"))?
        .to_bytes();

    let method = Method::from_bytes(parts.method.as_str().as_bytes())
        .map_err(|e| format!("invalid HTTP method: {e}"))?;

    let is_h2 = state.alpn_protocol.as_deref() == Some("h2");

    if !is_h2 {
        tracing::debug!(
            host = %state.host,
            alpn = ?state.alpn_protocol,
            "HTTP/2 not negotiated, using HTTP/1.1"
        );
    }

    // Build URL: for h2 use :authority + :path; for h1 use the URI directly.
    let url = build_url_from_hyper(&parts, &state.host, state.port, is_h2)?;

    let host = url
        .host_str()
        .ok_or_else(|| "target URL does not contain a host".to_string())?
        .to_string();
    let path = build_request_path(&url);
    let query_params = build_query_params(&url);

    // Build header entries and upstream HeaderMap.
    let mut request_headers: Vec<ProxyHeaderEntry> = Vec::new();
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

    // Filter out pseudo headers from the upstream HeaderMap.
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

    let mut https_request = ParsedProxyRequest {
        body: body_bytes.to_vec(),
        client_address: Some(state.client_addr.to_string()),
        headers,
        host: host.clone(),
        method,
        path,
        protocol: "https".to_string(),
        query_params,
        raw_request,
        request_headers,
        request_id: request_id.clone(),
        url,
        tls_cipher_suite: state.tls_cipher_suite.clone(),
        tls_protocol: state.tls_protocol.clone(),
    };

    // --- Apply request rules ---
    let RequestRuntimeOutcome {
        mut local_response,
        map_traces,
        rewrite_traces,
        throttle_selection,
    } = apply_request_runtime_rules(
        &state.rewrite_manager,
        &state.map_manager,
        &state.throttle_manager,
        &state.workspace_id,
        &mut https_request,
        is_h2,
    )?;

    let map_traces = map_traces;
    let mut rewrite_traces = rewrite_traces;
    let mut script_traces = Vec::new();
    let mut throttle_traces = Vec::new();

    if local_response.is_none() {
        let script_outcome =
            apply_request_script_rules(&state.script_manager, &state.workspace_id, &mut https_request);
        local_response = script_outcome.local_response;
        script_traces.extend(script_outcome.traces);
    }

    // --- Request-stage breakpoint ---
    if let Some(resolution) =
        intercept_request_stage(&state.breakpoint_manager, &state.event_emitter, &mut https_request)
            .await?
    {
        match resolution.action {
            BreakpointActionKind::Drop => {
                // For hyper server, we return a response that closes the connection.
                return Ok(build_empty_response(StatusCode::NO_CONTENT));
            }
            BreakpointActionKind::Mock => {
                if let Some(ref mock) = resolution.mock {
                    if let Some(selection) = throttle_selection
                        .as_ref()
                        .filter(|s| throttle_selection_matches_stage(s, "request"))
                    {
                        match apply_request_throttle(selection, https_request.body.len()).await {
                            Ok(trace) => {
                                if let Some(manager) = state.throttle_manager.as_ref() {
                                    manager.record_trace(&trace);
                                }
                                throttle_traces.push(trace);
                            }
                            Err(failure) => {
                                if let Some(manager) = state.throttle_manager.as_ref() {
                                    manager.record_trace(&failure.trace);
                                }
                                throttle_traces.push(failure.trace);
                                return build_throttle_failure_response(
                                    &https_request,
                                    &state,
                                    &failure.error,
                                    map_traces,
                                    throttle_traces,
                                )
                                .await;
                            }
                        }
                    }

                    let mut mock_response = crate::build_mock_upstream_response(mock);
                    rewrite_traces.extend(apply_response_rewrite_rules(
                        &state.rewrite_manager,
                        &state.workspace_id,
                        &https_request,
                        &mut mock_response,
                        is_h2,
                    )?);
                    script_traces.extend(apply_response_script_rules(
                        &state.script_manager,
                        &state.workspace_id,
                        &https_request,
                        &mut mock_response,
                    ));

                    if let Some(selection) = throttle_selection
                        .as_ref()
                        .filter(|s| throttle_selection_matches_stage(s, "response"))
                    {
                        let trace =
                            apply_response_throttle(selection, mock_response.response_body.len())
                                .await;
                        if let Some(manager) = state.throttle_manager.as_ref() {
                            manager.record_trace(&trace);
                        }
                        throttle_traces.push(trace);
                    }

                    let detail = build_session_detail(
                        &https_request,
                        mock_response.status_code.as_u16(),
                        &mock_response.response_headers,
                        &mock_response.response_body,
                        mock_response.response_body_size_bytes,
                        state.started_at,
                        state.started_at_instant,
                        ProxyTimingBreakdown {
                            connect_ms: None,
                            dns_ms: None,
                            request_send_ms: None,
                            response_read_ms: Some(0),
                            tls_ms: Some(state.tls_ms),
                            total_ms: Some(state.started_at_instant.elapsed().as_millis()),
                            waiting_ms: Some(0),
                        },
                        mock_response.body_truncated,
                    );
                    send_session(&state.session_sender, detail, map_traces, rewrite_traces, script_traces, throttle_traces).await;

                    return build_hyper_response_from_upstream(
                        mock_response.status_code,
                        &mock_response.response_headers,
                        &mock_response.response_body,
                    );
                }
            }
            BreakpointActionKind::Forward => {}
        }
    }

    // --- Send pending session ---
    let mut pending_detail = build_pending_session_detail(&https_request, state.started_at);
    pending_detail.map_traces = map_traces.clone();
    let _ = state.session_sender.send(pending_detail).await;

    // --- Request throttle ---
    if let Some(selection) = throttle_selection
        .as_ref()
        .filter(|s| throttle_selection_matches_stage(s, "request"))
    {
        match apply_request_throttle(selection, https_request.body.len()).await {
            Ok(trace) => {
                if let Some(manager) = state.throttle_manager.as_ref() {
                    manager.record_trace(&trace);
                }
                throttle_traces.push(trace);
            }
            Err(failure) => {
                if let Some(manager) = state.throttle_manager.as_ref() {
                    manager.record_trace(&failure.trace);
                }
                throttle_traces.push(failure.trace);
                return build_throttle_failure_response(
                    &https_request,
                    &state,
                    &failure.error,
                    map_traces,
                    throttle_traces,
                )
                .await;
            }
        }
    }

    // --- Forward upstream ---
    let upstream_result: Result<UpstreamResponse, String> = match local_response {
        Some(local_response) => Ok(local_response),
        None => {
            crate::server::forward_request(&https_request, &state.dns_manager, &state.workspace_id, Some(state.upstream_pool.clone())).await
        }
    };

    match upstream_result {
        Ok(mut upstream_response) => {
            if upstream_response.body_truncated {
                emit_log(
                    "WARN",
                    "response_body_passthrough_mode",
                    &[
                        ("request_id", https_request.request_id.clone()),
                        ("url", https_request.url.to_string()),
                        (
                            "reason",
                            "response body exceeded capture limit; skipping response mutations"
                                .to_string(),
                        ),
                    ],
                );
            } else {
                rewrite_traces.extend(apply_response_rewrite_rules(
                    &state.rewrite_manager,
                    &state.workspace_id,
                    &https_request,
                    &mut upstream_response,
                    is_h2,
                )?);
                script_traces.extend(apply_response_script_rules(
                    &state.script_manager,
                    &state.workspace_id,
                    &https_request,
                    &mut upstream_response,
                ));
            }

            let mut session_detail = build_session_detail(
                &https_request,
                upstream_response.status_code.as_u16(),
                &upstream_response.response_headers,
                &upstream_response.response_body,
                upstream_response.response_body_size_bytes,
                state.started_at,
                state.started_at_instant,
                ProxyTimingBreakdown {
                    connect_ms: Some(upstream_response.connect_ms),
                    dns_ms: Some(upstream_response.dns_ms),
                    request_send_ms: Some(upstream_response.request_send_ms),
                    response_read_ms: Some(upstream_response.response_read_ms),
                    tls_ms: upstream_response.tls_ms.or(Some(state.tls_ms)),
                    total_ms: Some(state.started_at_instant.elapsed().as_millis()),
                    waiting_ms: Some(upstream_response.waiting_ms),
                },
                upstream_response.body_truncated,
            );
            session_detail.map_traces = map_traces.clone();
            session_detail.rewrite_traces = rewrite_traces.clone();
            session_detail.script_traces = script_traces.clone();
            session_detail.throttle_traces = throttle_traces.clone();
            session_detail.timing_source = Some("proxy".to_string());

            // --- Response-stage breakpoint ---
            let breakpoint_resolution = if upstream_response.body_truncated {
                None
            } else {
                match intercept_response_stage(
                    &state.breakpoint_manager,
                    &state.event_emitter,
                    &https_request,
                    upstream_response.status_code.as_u16(),
                    &upstream_response.response_headers,
                    &upstream_response.response_body,
                )
                .await
                {
                    Ok(resolution) => resolution,
                    Err(error) => {
                        let _ = state.session_sender.send(session_detail).await;
                        return Err(error);
                    }
                }
            };

            if let Some(resolution) = breakpoint_resolution {
                match resolution.action {
                    BreakpointActionKind::Drop => {
                        let _ = state.session_sender.send(session_detail).await;
                        return Ok(build_empty_response(StatusCode::NO_CONTENT));
                    }
                    BreakpointActionKind::Mock => {
                        if let Some(ref mock) = resolution.mock {
                            upstream_response = crate::build_mock_upstream_response(mock);
                            session_detail = build_session_detail(
                                &https_request,
                                upstream_response.status_code.as_u16(),
                                &upstream_response.response_headers,
                                &upstream_response.response_body,
                                upstream_response.response_body_size_bytes,
                                state.started_at,
                                state.started_at_instant,
                                ProxyTimingBreakdown {
                                    connect_ms: Some(upstream_response.connect_ms),
                                    dns_ms: Some(upstream_response.dns_ms),
                                    request_send_ms: Some(upstream_response.request_send_ms),
                                    response_read_ms: Some(upstream_response.response_read_ms),
                                    tls_ms: upstream_response.tls_ms.or(Some(state.tls_ms)),
                                    total_ms: Some(state.started_at_instant.elapsed().as_millis()),
                                    waiting_ms: Some(upstream_response.waiting_ms),
                                },
                                upstream_response.body_truncated,
                            );
                            session_detail.map_traces = map_traces.clone();
                            session_detail.rewrite_traces = rewrite_traces.clone();
                            session_detail.script_traces = script_traces.clone();
                            session_detail.throttle_traces = throttle_traces.clone();
                        }
                    }
                    BreakpointActionKind::Forward => {
                        crate::apply_response_resolution(&resolution, &mut upstream_response);
                        if resolution.modified_response_body_base64.is_some() {
                            session_detail = build_session_detail(
                                &https_request,
                                upstream_response.status_code.as_u16(),
                                &upstream_response.response_headers,
                                &upstream_response.response_body,
                                upstream_response.response_body_size_bytes,
                                state.started_at,
                                state.started_at_instant,
                                ProxyTimingBreakdown {
                                    connect_ms: Some(upstream_response.connect_ms),
                                    dns_ms: Some(upstream_response.dns_ms),
                                    request_send_ms: Some(upstream_response.request_send_ms),
                                    response_read_ms: Some(upstream_response.response_read_ms),
                                    tls_ms: upstream_response.tls_ms.or(Some(state.tls_ms)),
                                    total_ms: Some(state.started_at_instant.elapsed().as_millis()),
                                    waiting_ms: Some(upstream_response.waiting_ms),
                                },
                                upstream_response.body_truncated,
                            );
                            session_detail.map_traces = map_traces.clone();
                            session_detail.rewrite_traces = rewrite_traces.clone();
                            session_detail.script_traces = script_traces.clone();
                            session_detail.throttle_traces = throttle_traces.clone();
                            session_detail.timing_source = Some("proxy".to_string());
                        } else {
                            if resolution.modified_response_status_code.is_some() {
                                session_detail.summary.status_code =
                                    upstream_response.status_code.as_u16();
                            }
                            if resolution.modified_response_headers.is_some() {
                                session_detail.response_headers =
                                    build_header_entries_from_map(&upstream_response.response_headers);
                                session_detail.cookies = build_cookie_entries(
                                    &https_request.request_headers,
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
                                        upstream_response.status_code.canonical_reason()
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
                    apply_response_throttle(selection, upstream_response.response_body_size_bytes)
                        .await;
                if let Some(manager) = state.throttle_manager.as_ref() {
                    manager.record_trace(&trace);
                }
                throttle_traces.push(trace);
                session_detail.throttle_traces = throttle_traces.clone();
            }

            session_detail.rewrite_traces = rewrite_traces;
            session_detail.script_traces = script_traces;
            session_detail.map_traces = map_traces;

            send_session(
                &state.session_sender,
                session_detail,
                Vec::new(), // already set above
                Vec::new(),
                Vec::new(),
                Vec::new(),
            )
            .await;

            emit_log(
                "DEBUG",
                "https_request_forwarded",
                &[
                    ("request_id", https_request.request_id.clone()),
                    ("host", state.host.clone()),
                    ("method", https_request.method.to_string()),
                    (
                        "status_code",
                        upstream_response.status_code.as_u16().to_string(),
                    ),
                    ("url", https_request.url.to_string()),
                ],
            );

            // If the upstream response is spooled to disk, read it back into memory
            // for the hyper response body. For large spooled responses this is
            // suboptimal, but it keeps the initial implementation correct. Streaming
            // from disk can be added as a follow-up optimisation.
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
        Err(error) => {
            let response_message = "The proxy could not reach the upstream HTTPS server.";

            let detail = build_session_detail(
                &https_request,
                StatusCode::BAD_GATEWAY.as_u16(),
                &HeaderMap::new(),
                response_message.as_bytes(),
                response_message.len(),
                state.started_at,
                state.started_at_instant,
                ProxyTimingBreakdown {
                    connect_ms: None,
                    dns_ms: None,
                    request_send_ms: None,
                    response_read_ms: Some(0),
                    tls_ms: Some(state.tls_ms),
                    total_ms: Some(state.started_at_instant.elapsed().as_millis()),
                    waiting_ms: Some(state.started_at_instant.elapsed().as_millis()),
                },
                false,
            );
            if state.session_sender.send(detail).await.is_err() {
                emit_log(
                    "DEBUG",
                    "session_send_dropped",
                    &[("reason", "receiver_disconnected".to_string())],
                );
            }

            emit_log(
                "ERROR",
                "https_upstream_request_failed",
                &[
                    ("request_id", https_request.request_id.clone()),
                    ("host", state.host.clone()),
                    ("url", https_request.url.to_string()),
                    ("error", error.clone()),
                ],
            );

            build_plain_text_response(StatusCode::BAD_GATEWAY, response_message)
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Build the target URL from hyper request parts.
///
/// - For HTTP/2: uses `:authority` and `:path` pseudo-headers.
/// - For HTTP/1.1: uses the URI directly (authority-form or origin-form + Host).
fn build_url_from_hyper(
    parts: &hyper::http::request::Parts,
    default_host: &str,
    _default_port: u16,
    is_h2: bool,
) -> Result<Url, String> {
    if is_h2 {
        // h2 sends `:path` pseudo-header and `:authority` pseudo-header.
        let path = parts
            .uri
            .path_and_query()
            .map(|pq| pq.as_str())
            .unwrap_or("/");
        let authority = parts
            .uri
            .authority()
            .map(|a| a.as_str())
            .unwrap_or(default_host);
        let target = format!("https://{authority}{path}");
        Url::parse(&target)
            .map_err(|e| format!("invalid h2 URL '{target}': {e}"))
    } else {
        // h1: URI may be in origin-form or authority-form.
        let uri_str = parts.uri.to_string();
        let target = if uri_str.starts_with("http://") || uri_str.starts_with("https://") {
            uri_str
        } else if uri_str.starts_with('/') {
            // origin-form — reconstruct with host.
            let host_header = parts
                .headers
                .get("host")
                .and_then(|v| v.to_str().ok())
                .unwrap_or(default_host);
            format!("https://{host_header}{uri_str}")
        } else {
            // authority-form (e.g. "example.com:443") — unlikely for MITM but handle.
            format!("https://{uri_str}/")
        };
        Url::parse(&target).map_err(|e| format!("invalid h1 URL '{target}': {e}"))
    }
}

/// Build a `reqwest::HeaderMap` from hyper headers, filtering out pseudo-headers
/// and hop-by-hop headers that should not be forwarded upstream.
fn build_upstream_headers_from_hyper(
    headers: &hyper::http::HeaderMap,
) -> Result<HeaderMap, String> {
    let is_ws_upgrade = headers.get("upgrade").map_or(false, |v| {
        v.as_bytes().eq_ignore_ascii_case(b"websocket")
    });

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
    state: &Arc<MitmConnectionState>,
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
        state.started_at,
        state.started_at_instant,
        ProxyTimingBreakdown {
            connect_ms: None,
            dns_ms: None,
            request_send_ms: None,
            response_read_ms: Some(0),
            tls_ms: Some(state.tls_ms),
            total_ms: Some(state.started_at_instant.elapsed().as_millis()),
            waiting_ms: Some(state.started_at_instant.elapsed().as_millis()),
        },
        false,
    );
    detail.map_traces = map_traces;
    detail.throttle_traces = throttle_traces;
    if state.session_sender.send(detail).await.is_err() {
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

/// Send a session detail, attaching the provided traces.
async fn send_session(
    sender: &mpsc::Sender<ProxySessionDetail>,
    mut detail: ProxySessionDetail,
    map_traces: Vec<crate::MapTrace>,
    rewrite_traces: Vec<crate::RewriteTrace>,
    script_traces: Vec<aiproxy_rule_engine::ScriptTrace>,
    throttle_traces: Vec<crate::ThrottleTrace>,
) {
    // Only overwrite if the caller provided non-empty traces; otherwise keep
    // what's already in the detail (the caller may have set them already).
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
