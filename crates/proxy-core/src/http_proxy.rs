use super::*;
use crate::connection::{ConnectionContext, ConnectionMode};
use crate::MAX_CAPTURED_BODY_BYTES;
use crate::{
    apply_request_runtime_rules, apply_request_script_rules, apply_request_throttle,
    apply_response_rewrite_rules, apply_response_script_rules, apply_response_throttle,
    build_cookie_entries, build_header_entries_from_map, build_pending_session_detail,
    build_query_params, build_raw_http_head, build_request_path, build_session_detail,
    intercept_request_stage, intercept_response_stage, throttle_selection_matches_stage,
    BreakpointActionKind, ParsedProxyRequest, ProxySessionDetail, ProxyTimingBreakdown,
    RequestRuntimeOutcome, UpstreamResponse,
};
use http_body_util::BodyExt;
use std::future::Future;
use std::pin::Pin;
use std::sync::Arc;

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
// Pure helpers extracted from handle_http_request
// ---------------------------------------------------------------------------

/// Build a `ParsedProxyRequest` from the raw hyper request parts and body.
fn build_parsed_request_from_hyper(
    parts: hyper::http::request::Parts,
    body_bytes: bytes::Bytes,
    ctx: &ConnectionContext,
    request_id: &str,
) -> Result<ParsedProxyRequest, crate::ProxyError> {
    let method = Method::from_bytes(parts.method.as_str().as_bytes())
        .map_err(|e| crate::ProxyError::Other(format!("invalid HTTP method: {e}")))?;

    let is_h2 = ctx.mode.is_h2();

    // Build URL from hyper parts according to ConnectionMode.
    let url = build_url_from_hyper(&parts, &ctx.mode)?;

    let host = url
        .host_str()
        .ok_or_else(|| crate::ProxyError::Other("target URL does not contain a host".to_string()))?
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
    error: &crate::ProxyError,
    ctx: &ConnectionContext,
    started_at: DateTime<Utc>,
    started_at_instant: Instant,
) -> Result<
    hyper::Response<http_body_util::combinators::BoxBody<bytes::Bytes, String>>,
    crate::ProxyError,
> {
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
        false, // M2 skip_bodies
    );
    if ctx.session_sender.send(detail).await.is_err() {
        tracing::debug!(
            event = "session_send_dropped",
            reason = "receiver_disconnected",
            "session_send_dropped"
        );
    }

    tracing::error!(
        event = "upstream_request_failed",
        request_id = %request.request_id,
        host = %host,
        url = %request.url,
        error = %error,
        "upstream_request_failed"
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
        false, // M2 skip_bodies
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
) -> Result<ParsedRequest, crate::ProxyError> {
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
        .map_err(|e| crate::ProxyError::Other(format!("failed to read request body: {e}")))?
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
async fn stage_apply_request_rules(
    ctx: &ConnectionContext,
    request: &mut ParsedProxyRequest,
    is_h2: bool,
) -> Result<RequestRulesResult, crate::ProxyError> {
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
    )
    .map_err(crate::ProxyError::RuleError)?;

    let mut local_response = local_response;
    let mut script_traces = Vec::new();

    if local_response.is_none() {
        // H6: script execution is now offloaded to spawn_blocking, so this
        // stage is async and must be awaited by its caller.
        let script_outcome =
            apply_request_script_rules(&ctx.script_manager, &ctx.workspace_id, request).await;
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
//
// `Forward` carries several trace Vecs plus an edited request, making it much
// larger than Drop/Mock. Boxing those fields would ripple through every match
// arm and the pipeline callers, so for now we accept the size difference (the
// enum is constructed once per request and lives on the stack briefly). Box the
// `Forward` fields if this ever shows up in allocation profiling.
#[allow(clippy::large_enum_variant)]
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
        /// When a breakpoint Forward resolution carried user edits (header/
        /// query/body changes), the edited request is returned here so the
        /// caller forwards the modified request upstream instead of the
        /// original. `None` when no breakpoint matched or the resolution had
        /// no edits.
        edited_request: Option<ParsedProxyRequest>,
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
) -> Result<BreakpointRequestOutcome, crate::ProxyError> {
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
    .await
    .map_err(crate::ProxyError::Other)?;
    let Some(resolution) = resolution else {
        return Ok(BreakpointRequestOutcome::Forward {
            map_traces,
            rewrite_traces,
            script_traces,
            throttle_traces,
            edited_request: None,
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
                    edited_request: None,
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
            rewrite_traces.extend(
                apply_response_rewrite_rules(
                    &ctx.rewrite_manager,
                    &ctx.workspace_id,
                    request,
                    &mut mock_response,
                    is_h2,
                )
                .map_err(crate::ProxyError::RuleError)?,
            );
            script_traces.extend(
                apply_response_script_rules(
                    &ctx.script_manager,
                    &ctx.workspace_id,
                    request,
                    &mut mock_response,
                )
                .await,
            );

            // Apply response throttle if configured for response stage.
            if let Some(selection) = throttle_selection
                .as_ref()
                .filter(|s| throttle_selection_matches_stage(s, "response"))
            {
                // Mock responses are never spooled/truncated, so the in-memory
                // body length IS the true wire size — this matches the upstream
                // path's `response_body_size_bytes` basis (M10 consistency).
                match apply_response_throttle(selection, mock_response.response_body.len()).await {
                    Ok(trace) => {
                        if let Some(manager) = ctx.throttle_manager.as_ref() {
                            manager.record_trace(&trace);
                        }
                        throttle_traces.push(trace);
                    }
                    // M9: response-stage packet loss drops the response. Send a
                    // 504 (mirrors the request-stage drop path) and
                    // short-circuit before forwarding the mock response body.
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
                false, // M2 skip_bodies
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
                // M3: mock breakpoint bodies are in-memory and never spooled,
                // so wrap them in a Full<Bytes> BoxBody. No explicit
                // Content-Length needed — hyper derives it from Full.
                http_body_util::Full::new(bytes::Bytes::from(mock_response.response_body.clone()))
                    .map_err(|e: std::convert::Infallible| e.to_string())
                    .boxed(),
                None,
            )?;
            Ok(BreakpointRequestOutcome::Mock(response))
        }
        BreakpointActionKind::Forward => Ok(BreakpointRequestOutcome::Forward {
            map_traces,
            rewrite_traces,
            script_traces,
            throttle_traces,
            // `intercept_request_stage` applied the user's header/query/body
            // edits to `request_mut` (a clone). Hand it back so the caller
            // forwards the modified request upstream — otherwise the edits are
            // silently discarded (H5).
            edited_request: Some(request_mut),
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
) -> Result<PendingThrottleOutcome, crate::ProxyError> {
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
        error: crate::ProxyError,
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
) -> Result<ForwardOutcome, crate::ProxyError> {
    // --- Forward upstream ---
    let upstream_result: Result<UpstreamResponse, crate::ProxyError> = match local_response {
        Some(local_response) => Ok(local_response),
        None => {
            let host = request.host.clone();
            let upstream_timeout = crate::upstream_request_timeout();
            match tokio::time::timeout(
                upstream_timeout,
                crate::upstream::forward_request(
                    request,
                    &ctx.dns_manager,
                    &ctx.workspace_id,
                    Some(ctx.upstream_pool.clone()),
                    ctx.verify_upstream_tls,
                    Arc::clone(&ctx.tls_verify_hosts),
                ),
            )
            .await
            {
                Ok(result) => result,
                Err(_) => {
                    let timeout_secs = upstream_timeout.as_secs();
                    let response_message =
                        format!("The upstream server did not respond within {timeout_secs}s.",);
                    tracing::warn!(
                        event = "upstream_request_timed_out",
                        request_id = %request.request_id,
                        host = %host,
                        url = %request.url,
                        timeout_secs = timeout_secs,
                        "upstream_request_timed_out"
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
                        false, // M2 skip_bodies
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
) -> Result<ProxyResponse, crate::ProxyError> {
    if upstream_response.body_truncated {
        tracing::warn!(
            event = "response_body_passthrough_mode",
            request_id = %request.request_id,
            url = %request.url,
            reason = "response body exceeded capture limit; skipping response mutations",
            "response_body_passthrough_mode"
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
                    false, // M2 skip_bodies
                );
                let _ = ctx.session_sender.send(detail).await;
                tracing::error!(
                    event = "response_processing_failed",
                    request_id = %request.request_id,
                    host = %host,
                    url = %request.url,
                    error = %error,
                    "response_processing_failed"
                );
                cancellation_guard.disarm();
                return build_plain_text_response(StatusCode::BAD_GATEWAY, response_message);
            }
        };
        rewrite_traces.extend(response_rewrite_traces);
        script_traces.extend(
            apply_response_script_rules(
                &ctx.script_manager,
                &ctx.workspace_id,
                request,
                &mut upstream_response,
            )
            .await,
        );
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
                return Err(crate::ProxyError::Other(error));
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
        match apply_response_throttle(selection, upstream_response.response_body_size_bytes).await {
            Ok(trace) => {
                if let Some(manager) = ctx.throttle_manager.as_ref() {
                    manager.record_trace(&trace);
                }
                throttle_traces.push(trace);
                session_detail.throttle_traces = throttle_traces.clone();
            }
            // M9: response-stage packet loss drops the response. Discard the
            // upstream body and return a 504 carrying the accumulated traces.
            // The spool file (if any) is cleaned up when `upstream_response`
            // is dropped on return.
            Err(failure) => {
                if let Some(manager) = ctx.throttle_manager.as_ref() {
                    manager.record_trace(&failure.trace);
                }
                throttle_traces.push(failure.trace);
                session_detail.throttle_traces = throttle_traces.clone();
                session_detail.rewrite_traces = rewrite_traces;
                session_detail.script_traces = script_traces;
                session_detail.map_traces = map_traces;
                if ctx.session_sender.send(session_detail).await.is_err() {
                    tracing::debug!(
                        event = "session_send_dropped",
                        reason = "receiver_disconnected",
                        "session_send_dropped"
                    );
                }
                tracing::warn!(
                    event = "response_throttled",
                    request_id = %request.request_id,
                    url = %request.url,
                    error = %failure.error,
                    "response_throttled"
                );
                // Disarm the guard: we already sent the session detail above,
                // and an armed Drop would emit a second, conflicting
                // "client-closed" detail for the same request id.
                cancellation_guard.disarm();
                return build_plain_text_response(
                    StatusCode::GATEWAY_TIMEOUT,
                    "The response was dropped by the active throttle profile.",
                );
            }
        }
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

    tracing::debug!(
        event = "request_forwarded",
        request_id = %request.request_id,
        host = %host,
        method = %request.method,
        status_code = upstream_response.status_code.as_u16(),
        url = %request.url,
        "request_forwarded"
    );

    // M3: stream a spooled response body back to the client instead of reading
    // the whole file into memory. We take() the spool path out of the
    // UpstreamResponse so its Drop impl does NOT delete the file before the
    // body is fully read — the CleanupStream wrapper owns the file and removes
    // it when the body stream ends (EOF, client disconnect, or hyper dropping
    // the response body).
    let spool_path = upstream_response.spooled_response_path.take();
    let (response_body, streamed_content_length) = if let Some(spool_path) = spool_path {
        // The spool file holds the full, untruncated upstream body. Use its
        // on-disk size as the authoritative Content-Length so hyper emits a
        // fixed-length response (a StreamBody has no inherent length, and
        // without this hint hyper would use chunked transfer-encoding,
        // which a raw-TCP client reading to EOF would mis-read).
        let content_length = match std::fs::metadata(&spool_path) {
            Ok(meta) => Some(meta.len()),
            Err(error) => {
                tracing::warn!(
                    event = "spool_file_metadata_failed",
                    error = %error,
                    "spool_file_metadata_failed"
                );
                None
            }
        };
        let file = tokio::fs::File::open(&spool_path)
            .await
            .map_err(crate::ProxyError::IoError)?;
        let reader_stream = tokio_util::io::ReaderStream::new(file);
        let cleaned = CleanupStream::new(reader_stream, spool_path);
        // StreamBody frames a Stream<Result<Frame<Bytes>, E>> as a Body.
        // ReaderStream yields Result<Bytes, io::Error>; wrap each Bytes in
        // Frame::data and translate the io::Error into the String error
        // type the rest of the proxy uses for BoxBody<Bytes, String>.
        use futures_util::TryStreamExt;
        let framed = cleaned
            .map_ok(http_body::Frame::data)
            .map_err(|e| e.to_string());
        (
            http_body_util::StreamBody::new(framed).boxed(),
            content_length,
        )
    } else {
        // In-memory body (small responses / responses under the spool
        // threshold). Clone into Bytes; no file to clean up. hyper derives
        // the Content-Length from the finite Full<Bytes> body.
        (
            http_body_util::Full::new(bytes::Bytes::from(upstream_response.response_body.clone()))
                .map_err(|e: std::convert::Infallible| e.to_string())
                .boxed(),
            None,
        )
    };

    build_hyper_response_from_upstream(
        upstream_response.status_code,
        &upstream_response.response_headers,
        response_body,
        streamed_content_length,
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
    } = stage_apply_request_rules(ctx, &mut request, is_h2).await?;

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
                edited_request,
            } => {
                // Adopt the breakpoint-edited request (if any) so stages 4/5
                // and the upstream forward see the user's modifications (H5).
                if let Some(edited) = edited_request {
                    request = edited;
                }
                (map_traces, rewrite_traces, script_traces, throttle_traces)
            }
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
            match crate::ws_upgrade::handle_ws_upgrade_via_hyper(
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
                    return Err(e.into());
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
            .await
            .map_err(String::from);
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
    .map_err(String::from)
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
) -> Result<Url, crate::ProxyError> {
    match mode {
        ConnectionMode::PlainHttp => {
            let uri_str = parts.uri.to_string();
            if uri_str.starts_with("http://")
                || uri_str.starts_with("https://")
                || uri_str.starts_with("ws://")
                || uri_str.starts_with("wss://")
            {
                // absolute-form — use as-is
                Url::parse(&uri_str).map_err(|e| {
                    crate::ProxyError::Other(format!("invalid absolute-form URL: {e}"))
                })
            } else {
                // origin-form — reconstruct from Host header
                let host = parts
                    .headers
                    .get("host")
                    .and_then(|v| v.to_str().ok())
                    .ok_or_else(|| {
                        crate::ProxyError::Other(
                            "Host header is required for origin-form requests".to_string(),
                        )
                    })?;
                Url::parse(&format!("http://{host}{uri_str}"))
                    .map_err(|e| crate::ProxyError::Other(format!("invalid origin-form URL: {e}")))
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
                Url::parse(&target).map_err(|e| {
                    crate::ProxyError::Other(format!("invalid h2 URL '{target}': {e}"))
                })
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
                Url::parse(&target).map_err(|e| {
                    crate::ProxyError::Other(format!("invalid h1 URL '{target}': {e}"))
                })
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

/// Build a `HeaderMap` from hyper headers, filtering out pseudo-headers
/// and hop-by-hop headers that should not be forwarded upstream.
fn build_upstream_headers_from_hyper(
    headers: &hyper::http::HeaderMap,
) -> Result<HeaderMap, crate::ProxyError> {
    let is_ws_upgrade = headers
        .get("upgrade")
        .is_some_and(|v| v.as_bytes().eq_ignore_ascii_case(b"websocket"));
    // H2: RFC 7230 §6.1 — strip headers named in `Connection` plus the standard
    // hop-by-hop set.
    let strip =
        crate::hop_by_hop_strip_set(headers.iter().map(|(n, v)| (n.as_str(), v.as_bytes())));

    let mut header_map = HeaderMap::new();
    for (name, value) in headers {
        // Skip pseudo-headers (h2).
        if name.as_str().starts_with(':') {
            continue;
        }
        if should_skip_hyper_header(name, is_ws_upgrade) {
            continue;
        }
        if crate::should_strip_hop_by_hop(name.as_str(), &strip, is_ws_upgrade) {
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

/// M3: a stream wrapper that owns a spool file and deletes it when dropped.
///
/// `tokio_util::io::ReaderStream` produces a `Stream<Result<Bytes, io::Error>>`
/// from a `tokio::fs::File`. This wrapper transparently forwards the stream
/// and, on drop — which happens when the body reaches EOF, the client
/// disconnects, or hyper drops the response body — removes the spool file via
/// `spawn_blocking` (mirroring `UpstreamResponse::clear_spooled_response` so
/// the worker thread is not blocked on a slow temp dir / AV scan). This is the
/// only owner of the spool path once it is `take()`n from `UpstreamResponse`,
/// so the file is never deleted before the body is fully streamed.
struct CleanupStream<S> {
    inner: S,
    spool_path: Option<std::path::PathBuf>,
}

impl<S> CleanupStream<S> {
    fn new(inner: S, spool_path: std::path::PathBuf) -> Self {
        Self {
            inner,
            spool_path: Some(spool_path),
        }
    }
}

impl<S, B, E> futures_util::Stream for CleanupStream<S>
where
    S: futures_util::Stream<Item = Result<B, E>> + Unpin,
{
    type Item = Result<B, E>;

    fn poll_next(
        self: Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<Option<Self::Item>> {
        // CleanupStream only forwards the inner stream; the spool_path lives
        // solely in Drop. We require S: Unpin so a simple &mut projection is
        // sound without pin-projecting. ReaderStream (our only use) is Unpin.
        let this = self.get_mut();
        Pin::new(&mut this.inner).poll_next(cx)
    }
}

impl<S> Drop for CleanupStream<S> {
    fn drop(&mut self) {
        if let Some(path) = self.spool_path.take() {
            // Offload the remove_file so the dropping thread (a Tokio worker
            // finishing the body pump) is not blocked. Fall back to an inline
            // remove if there is no runtime (e.g. process teardown), matching
            // UpstreamResponse::clear_spooled_response.
            if let Ok(handle) = tokio::runtime::Handle::try_current() {
                handle.spawn_blocking(move || {
                    let _ = std::fs::remove_file(path);
                });
            } else {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

/// Build a `hyper::Response` from an upstream status code, headers and a
/// pre-built body.
///
/// M3: the body is now passed as an already-constructed `BoxBody` so callers
/// can choose between an in-memory `Full<Bytes>` (small bodies) and a streamed
/// `StreamBody` backed by a spool file (large bodies), instead of this helper
/// always buffering the body into a `Vec<u8>`.
///
/// When `streamed_content_length` is `Some(n)` (the spooled-body case, where we
/// know the exact byte count from the spool file size), a `Content-Length:
/// n` header is emitted. This matters for the streamed path: a `StreamBody`
/// has no inherent length, so without an explicit Content-Length hyper falls
/// back to chunked transfer-encoding, which a raw-TCP client reading to EOF
/// would mis-read. The in-memory `Full<Bytes>` path needs no hint (hyper
/// derives the length from the finite body).
fn build_hyper_response_from_upstream(
    status_code: StatusCode,
    headers: &HeaderMap,
    body: http_body_util::combinators::BoxBody<bytes::Bytes, String>,
    streamed_content_length: Option<u64>,
) -> Result<
    hyper::Response<http_body_util::combinators::BoxBody<bytes::Bytes, String>>,
    crate::ProxyError,
> {
    let mut builder = hyper::Response::builder().status(status_code);

    // H2: strip hop-by-hop headers before forwarding the response downstream
    // (RFC 7230 §6.1). This covers both the standard hop-by-hop set and any
    // header the upstream named in its `Connection` header (e.g. a custom
    // `x-foo` listed in `Connection: keep-alive, x-foo`). A 101 Switching
    // Protocols response is treated like a WS upgrade: the `Connection` and
    // `Upgrade` handshake headers are preserved.
    let is_upgrade_response = status_code == StatusCode::SWITCHING_PROTOCOLS;
    let strip =
        crate::hop_by_hop_strip_set(headers.iter().map(|(n, v)| (n.as_str(), v.as_bytes())));

    for (name, value) in headers {
        // Content-Length and Transfer-Encoding are always dropped here; the
        // framing is re-derived below (M3) or by the body type.
        if name == CONTENT_LENGTH || name == TRANSFER_ENCODING {
            continue;
        }
        if crate::should_strip_hop_by_hop(name.as_str(), &strip, is_upgrade_response) {
            continue;
        }
        builder = builder.header(name, value);
    }

    // M3: restore a Content-Length for streamed bodies so hyper uses a
    // fixed-length response instead of chunked encoding.
    if let Some(len) = streamed_content_length {
        builder = builder.header(CONTENT_LENGTH, len);
    }

    builder
        .body(body)
        .map_err(crate::ProxyError::ResponseBuildError)
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
) -> Result<
    hyper::Response<http_body_util::combinators::BoxBody<bytes::Bytes, String>>,
    crate::ProxyError,
> {
    match ctx.mode {
        ConnectionMode::PlainHttp => Err(crate::ProxyError::RequestDropped),
        ConnectionMode::MitmHttps { .. } => Ok(build_empty_response(StatusCode::NO_CONTENT)),
    }
}

/// Build an empty response with the given status code.
pub(crate) fn build_empty_response(
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
pub(crate) fn build_plain_text_response(
    status_code: StatusCode,
    message: &str,
) -> Result<
    hyper::Response<http_body_util::combinators::BoxBody<bytes::Bytes, String>>,
    crate::ProxyError,
> {
    hyper::Response::builder()
        .status(status_code)
        .header("Content-Type", "text/plain; charset=utf-8")
        .header("Content-Length", message.len())
        .body(
            http_body_util::Full::new(bytes::Bytes::from(message.to_string()))
                .map_err(|e: std::convert::Infallible| e.to_string())
                .boxed(),
        )
        .map_err(crate::ProxyError::ResponseBuildError)
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
) -> Result<
    hyper::Response<http_body_util::combinators::BoxBody<bytes::Bytes, String>>,
    crate::ProxyError,
> {
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
        false, // M2 skip_bodies
    );
    detail.map_traces = map_traces;
    detail.throttle_traces = throttle_traces;
    if ctx.session_sender.send(detail).await.is_err() {
        tracing::debug!(
            event = "session_send_dropped",
            reason = "receiver_disconnected",
            "session_send_dropped"
        );
    }

    tracing::warn!(
        event = "request_throttled",
        request_id = %request.request_id,
        url = %request.url,
        error = %error,
        "request_throttled"
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
        tracing::debug!(
            event = "session_send_dropped",
            reason = "receiver_disconnected",
            "session_send_dropped"
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
            true, // M2 skip_bodies
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
                tracing::debug!(
                    event = "session_send_dropped",
                    reason = "receiver_disconnected",
                    "session_send_dropped"
                );
            }

            tracing::warn!(
                event = "upstream_request_cancelled",
                request_id = %request_id,
                method = %method,
                host = %host,
                url = %url,
                reason = "client_disconnected_or_request_cancelled",
                elapsed_ms = elapsed_ms,
                "upstream_request_cancelled"
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
            verify_upstream_tls: false,
            tls_verify_hosts: Arc::from(Vec::<String>::new()),
        }
    }

    // -----------------------------------------------------------------------
    // handle_drop_action
    // -----------------------------------------------------------------------

    #[test]
    fn drop_action_plain_http_returns_error() {
        let ctx = make_ctx(ConnectionMode::PlainHttp);
        let result = handle_drop_action(&ctx);
        assert!(result.is_err());
        assert!(matches!(
            result.unwrap_err(),
            crate::ProxyError::RequestDropped
        ));
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

    // M3: CleanupStream must forward all bytes from the inner stream AND delete
    // the spool file when dropped. We drive the stream to completion inside a
    // tokio runtime (Drop spawns the file removal on the blocking pool), then
    // assert the file is gone and the bytes match the input.
    #[tokio::test]
    async fn m3_cleanup_stream_forwards_bytes_and_deletes_spool_file() {
        use futures_util::StreamExt;
        use std::io::Write;

        // Write a small "spool" file with known content.
        let mut tmp = std::env::temp_dir();
        tmp.push(format!(
            "aiproxy-m3-test-{}-{}",
            std::process::id(),
            uuid::Uuid::new_v4()
        ));
        let content = b"hello spooled world";
        {
            let mut f = std::fs::File::create(&tmp).unwrap();
            f.write_all(content).unwrap();
        }
        assert!(tmp.exists(), "precondition: spool file exists");

        let path = tmp.clone();
        // Build a stream of Result<Bytes, io::Error> (ReaderStream shape) by
        // mapping a simple vec stream; CleanupStream is generic over the inner
        // stream.
        let inner = futures_util::stream::iter(vec![Ok::<bytes::Bytes, std::io::Error>(
            bytes::Bytes::from_static(content),
        )]);
        let mut cleaned = CleanupStream::new(inner, path);

        let mut collected = Vec::new();
        while let Some(item) = cleaned.next().await {
            collected.extend_from_slice(&item.unwrap());
        }
        // Drop happens implicitly when `cleaned` goes out of scope at the end;
        // the spawn_blocking removal runs asynchronously, so give it a moment.
        drop(cleaned);
        // The Drop spawns the removal on the blocking pool; poll briefly.
        for _ in 0..50 {
            if !tmp.exists() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }

        assert_eq!(collected, content);
        assert!(
            !tmp.exists(),
            "M3: CleanupStream must delete the spool file on drop"
        );
    }
}
