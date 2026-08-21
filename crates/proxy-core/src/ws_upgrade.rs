use super::*;
use crate::connection::{ConnectionContext, ConnectionMode};
use crate::stream::TlsOrPlain;
use crate::{
    build_header_entries_from_map, build_raw_http_head, build_request_path, build_session_detail,
    infer_protocol_metadata, ParsedProxyRequest, ProxyTimingBreakdown,
};
use http_body_util::BodyExt;

type ProxyResponse = hyper::Response<http_body_util::combinators::BoxBody<bytes::Bytes, String>>;

/// How the body of a non-101 (refused WS upgrade) upstream response is
/// delimited, per RFC 7230 §3.3.3.
enum BodyFraming {
    /// Explicit Content-Length: read exactly N bytes.
    ContentLength(usize),
    /// Transfer-Encoding: chunked — decode frames until the 0-size terminator.
    Chunked,
    /// No length hint — read until the peer closes (or the idle timeout fires).
    ReadUntilClose,
}

/// Determine the body framing of an upstream response from its headers.
/// chunked takes precedence over Content-Length (RFC 7230 §3.3.3); absence of
/// both means read-until-close.
fn parse_response_body_framing(headers: &[(String, String)]) -> BodyFraming {
    let is_chunked = headers.iter().any(|(name, value)| {
        name.eq_ignore_ascii_case("transfer-encoding") && value.eq_ignore_ascii_case("chunked")
    });
    if is_chunked {
        return BodyFraming::Chunked;
    }
    if let Some(total) = headers
        .iter()
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))
        .and_then(|(_, value)| value.parse::<usize>().ok())
    {
        return BodyFraming::ContentLength(total);
    }
    BodyFraming::ReadUntilClose
}

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
) -> ProxyResponse {
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
        false, // M2 skip_bodies
    );
    detail.map_traces = map_traces;
    detail.rewrite_traces = rewrite_traces;
    detail.script_traces = script_traces;
    detail.throttle_traces = throttle_traces;

    if ctx.session_sender.send(detail).await.is_err() {
        tracing::debug!(
            event = "session_send_dropped",
            reason = "receiver_disconnected",
            "session_send_dropped"
        );
    }

    tracing::error!(
        event = "ws_upstream_error",
        request_id = %request.request_id,
        host = %request.host,
        url = %request.url,
        error = %error,
        "ws_upstream_error"
    );

    crate::http_proxy::build_plain_text_response(StatusCode::BAD_GATEWAY, response_message)
        .unwrap_or_else(|_| crate::http_proxy::build_empty_response(StatusCode::BAD_GATEWAY))
}

/// Default upstream port for a WebSocket upgrade request (R6-1).
///
/// The transport is decided by the URL scheme, not just `ctx.mode`: a `wss://`
/// absolute-form request sent directly over the plain HTTP proxy port still
/// targets 443. `ws://` (and the MITM path, where the URL is normalized to
/// `https://`) keep the connection-mode defaults.
fn ws_default_port(url: &url::Url, mode: &ConnectionMode) -> u16 {
    if url.scheme() == "wss" {
        443
    } else {
        match mode {
            ConnectionMode::PlainHttp => 80,
            ConnectionMode::MitmHttps { .. } => 443,
        }
    }
}

/// Whether the upstream WebSocket connection must use TLS (R6-1).
///
/// TLS is required when EITHER the connection is the MITM path (the browser
/// already CONNECTed, URL normalized to `https://`) OR the URL scheme is
/// `wss://` (absolute-form `wss://` request sent over the plain proxy port).
fn ws_needs_tls(url: &url::Url, mode: &ConnectionMode) -> bool {
    matches!(mode, ConnectionMode::MitmHttps { .. }) || url.scheme() == "wss"
}

/// Build the TLS `ServerName` for the WebSocket upstream.
///
/// `request.host` keeps the brackets of an IPv6 authority
/// (`wss://[2001:db8::5]/...` → `[2001:db8::5]`), which `ServerName` rejects —
/// the same normalization every other outbound TLS path applies. An empty
/// fallback is not possible here (the host came from a parsed URL), so on
/// failure we keep the historical behavior of falling back to loopback rather
/// than failing the whole upgrade.
fn ws_tls_server_name(host: &str) -> tokio_rustls::rustls::pki_types::ServerName<'static> {
    let normalized = crate::timing_connector::tls_server_name_host(host).to_owned();
    tokio_rustls::rustls::pki_types::ServerName::try_from(normalized).unwrap_or_else(|_| {
        tokio_rustls::rustls::pki_types::ServerName::IpAddress(std::net::Ipv4Addr::LOCALHOST.into())
    })
}

/// Wrap an already-connected TCP stream in TLS for the WebSocket upstream
/// (R6-1). Shared by the MITM path and the `wss://`-over-plain-proxy path.
///
/// On handshake failure returns `Err(message)` so the caller can emit a 502
/// session (mirroring the original inline behavior).
async fn connect_ws_upstream_tls(
    tcp: crate::upstream_proxy::DialedStream,
    request: &ParsedProxyRequest,
    ctx: &ConnectionContext,
) -> Result<TlsOrPlain<crate::upstream_proxy::DialedStream>, String> {
    // H3: select the verifying vs dangerous client config based on the
    // effective verify decision for THIS host: verify when the global
    // switch is on OR the host is on the per-host allowlist. WSS has no
    // ALPN requirements, so pass an empty protocol list.
    let verify = ctx.verify_upstream_tls
        || crate::timing_connector::host_in_allowlist(&ctx.tls_verify_hosts, &request.host);
    let client_config =
        aiproxy_tls_manager::client::build_client_config_with_alpn_and_verify(vec![], verify);
    let tls_connector = tokio_rustls::TlsConnector::from(client_config);
    let dns_name = ws_tls_server_name(&request.host);
    let tls_stream = tls_connector
        .connect(dns_name, tcp)
        .await
        .map_err(|e| format!("WebSocket upstream TLS handshake: {e}"))?;
    Ok(TlsOrPlain::Tls(Box::new(tls_stream)))
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
pub(crate) async fn handle_ws_upgrade_via_hyper(
    on_upgrade: hyper::upgrade::OnUpgrade,
    request: ParsedProxyRequest,
    ctx: &ConnectionContext,
    started_at: DateTime<Utc>,
    started_at_instant: Instant,
    map_traces: Vec<crate::MapTrace>,
    rewrite_traces: Vec<crate::RewriteTrace>,
    script_traces: Vec<aiproxy_rule_engine::ScriptTrace>,
    throttle_traces: Vec<crate::ThrottleTrace>,
) -> Result<ProxyResponse, crate::ProxyError> {
    let request_id = request.request_id.clone();

    // Determine upstream port.
    // R6-1: the transport (plain vs TLS) must follow the URL scheme, not just
    // `ctx.mode`. A `wss://` absolute-form request arriving over the plain HTTP
    // proxy port (`ctx.mode == PlainHttp`) still needs port 443 + TLS; browsers
    // normally CONNECT first (-> MitmHttps), so this is an edge but real path.
    let port = request
        .url
        .port()
        .unwrap_or(ws_default_port(&request.url, &ctx.mode));

    // Resolve DNS override. Handed to the dialer rather than substituted into
    // the host, so an upstream proxy still receives the hostname verbatim.
    let dns_override_ip =
        crate::resolve_dns_override(&ctx.dns_manager, &ctx.workspace_id, &request.host);
    if let Some(ip) = &dns_override_ip {
        tracing::info!(
            event = "dns_override_ws",
            host = %request.host,
            override_ip = %ip,
            "dns_override_ws"
        );
    }
    let connect_host_port = format!("{}:{}", request.host, port);

    tracing::debug!(
        event = "ws_hyper_connecting_upstream",
        request_id = %request_id,
        host_port = %connect_host_port,
        "ws_hyper_connecting_upstream"
    );

    // Build the raw upgrade request to upstream (pure — no IO, not timed).
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
    tracing::debug!(
        event = "ws_hyper_sending_upgrade",
        request_id = %request_id,
        "ws_hyper_sending_upgrade"
    );

    // P1-2: dial → TLS handshake → write upgrade request → read response head
    // must be bounded AS A WHOLE. Previously none of these steps carried a
    // timeout: a half-open TCP peer, a stalled TLS handshake or an upstream
    // that accepted the request but never answered left this future Pending
    // forever, pinning one of the 1024 connection permits until the client
    // disconnected. The CONNECT blind-tunnel path already wraps its dial in a
    // timeout; this brings the WS path to parity using the same
    // `upstream_request_timeout` semantics. The post-101 relay keeps its own
    // idle/grace timeouts; the non-101 body read below keeps
    // `ws_upstream_body_read_idle_timeout`.
    let upgrade_deadline = crate::upstream_request_timeout();
    let established = tokio::time::timeout(upgrade_deadline, async {
        // Connect upstream — TCP (or an upstream-proxy tunnel), optionally TLS
        // for wss://. On failure, send a 502 session and return Ok(502) — not
        // Err/499.
        let ws_tcp = crate::upstream_proxy::dial_target(
            ctx.upstream_proxy.as_deref(),
            &request.host,
            port,
            dns_override_ip,
        )
        .await
        .map(|(stream, _route)| stream)
        .map_err(|e| format!("WebSocket upstream connect to {connect_host_port}: {e}"))?;

        // R6-1: TLS is required when EITHER we are in MITM mode (CONNECT
        // already happened, URL normalized to https://) OR the URL scheme
        // itself is `wss` (a wss:// absolute-form request sent directly over
        // the plain proxy port).
        let needs_tls = ws_needs_tls(&request.url, &ctx.mode);
        let mut upstream = if needs_tls {
            connect_ws_upstream_tls(ws_tcp, &request, ctx).await?
        } else {
            TlsOrPlain::Plain(ws_tcp)
        };

        if let Err(e) = upstream.write_all(raw_req.as_bytes()).await {
            return Err(format!("WebSocket upgrade send to upstream: {e}"));
        }

        // Read the upstream response head.
        crate::connect::read_http_response_head(&mut upstream)
            .await
            .map(|(head, leftover)| (upstream, head, leftover))
    })
    .await;

    let (mut upstream, response_head, leftover_bytes) = match established {
        Ok(Ok(triple)) => triple,
        Ok(Err(error)) => {
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
        Err(_elapsed) => {
            let error = format!(
                "WebSocket upgrade to {connect_host_port} did not complete within {}s",
                upgrade_deadline.as_secs()
            );
            tracing::warn!(
                event = "ws_hyper_upgrade_timeout",
                request_id = %request_id,
                host_port = %connect_host_port,
                timeout_secs = upgrade_deadline.as_secs(),
                "ws_hyper_upgrade_timeout"
            );
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

    // Parse status code and headers from the upstream response. M4: use a lossy
    // decode — HTTP header field values are opaque octets (obs-text / Latin-1
    // are legal), and a strict UTF-8 requirement turned any non-UTF-8 byte into
    // a synthetic error that broke otherwise-valid 101 upgrades. Status parsing
    // and header names are ASCII, so lossy decoding is safe here.
    let response_head_lossy = String::from_utf8_lossy(&response_head);
    let (status_code, upstream_headers) = match parse_upstream_response_head(&response_head_lossy) {
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

    tracing::info!(
        event = "ws_hyper_upstream_response",
        request_id = %request_id,
        status_code = status_code,
        "ws_hyper_upstream_response"
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
        false, // M2 skip_bodies
    );
    detail.map_traces = map_traces.clone();
    detail.rewrite_traces = rewrite_traces.clone();
    detail.script_traces = script_traces.clone();
    detail.throttle_traces = throttle_traces.clone();
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

    // M5: validate the full RFC 6455 §4.2.2 101 handshake before entering the
    // relay. Previously the check only required an `Upgrade` header, accepting
    // malformed 101 responses (e.g. `Upgrade: h2c` with no accept key) as a
    // valid WebSocket upgrade and then parsing arbitrary upstream bytes as WS
    // frames. Now require Connection: upgrade + Upgrade: websocket + a
    // Sec-WebSocket-Accept value that matches SHA1(client Sec-WebSocket-Key +
    // magic GUID), so the upstream must have actually processed our key.
    let client_ws_key = request
        .headers
        .get("sec-websocket-key")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.trim())
        .filter(|s| !s.is_empty());
    if status_code != 101 || !is_valid_ws_upgrade_handshake(&upstream_headers, client_ws_key) {
        // Upstream did not agree to upgrade — return its response as-is, EXCEPT
        // when the upstream claimed 101 with an invalid handshake (e.g. wrong
        // Sec-WebSocket-Accept value, or missing Connection/Upgrade/Accept).
        // In that malformed-101 case we must NOT forward the 101 to the client:
        // the client would believe the upgrade succeeded and start framing WS,
        // but the proxy never registered a relay, so the connection would hang
        // waiting for frames that will never arrive. Treat it as an upstream
        // protocol error and respond 502 Bad Gateway instead.
        let malformed_101 = status_code == 101;
        let forwarded_status = if malformed_101 {
            tracing::warn!(
                event = "ws_hyper_upstream_malformed_101",
                request_id = %request_id,
                "upstream returned 101 with an invalid WebSocket handshake; responding 502 instead of forwarding the 101"
            );
            // Reflect the synthesized 502 in the captured session detail too,
            // so the Inspector does not show a misleading 101 for a connection
            // the proxy never upgraded. Clear the WS mime type for the same
            // reason.
            detail.summary.status_code = StatusCode::BAD_GATEWAY.as_u16();
            detail.summary.response_mime_type = None;
            StatusCode::BAD_GATEWAY.as_u16()
        } else {
            status_code
        };

        tracing::warn!(
            event = "ws_hyper_upstream_refused",
            request_id = %request_id,
            status_code = forwarded_status,
            "ws_hyper_upstream_refused"
        );

        // Build the non-101 response FIRST (before sending session).
        // If response construction fails, send a 502 error session instead
        // of leaving the pending session stuck or creating a duplicate.
        //
        // The leftover bytes captured while reading the response head are
        // only a PREFIX of the body — the head-reader stops as soon as it
        // sees the \r\n\r\n terminator, so any body bytes beyond what that
        // single read returned are still on the upstream. Forward the FULL
        // body: leftover as the prefix, then continue reading from upstream
        // until Content-Length is satisfied (or EOF if no Content-Length).
        let framing = parse_response_body_framing(&upstream_headers);

        let body_bytes = match read_full_response_body(&mut upstream, leftover_bytes, framing).await
        {
            Ok(b) => b,
            Err(e) => {
                let error = format!("failed to read upstream non-101 body: {e}");
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
        let mut builder = hyper::Response::builder()
            .status(StatusCode::from_u16(forwarded_status).unwrap_or(StatusCode::BAD_GATEWAY))
            .header("Content-Length", body_bytes.len());
        for (name, value) in &upstream_headers {
            // For a malformed-101, strip the upgrade-related headers so the
            // client does not see a contradictory 502 carrying Connection/
            // Upgrade: websocket (which could confuse some clients into WS
            // framing). For a genuine non-101 refusal, forward headers as-is.
            if malformed_101
                && (name.eq_ignore_ascii_case("connection")
                    || name.eq_ignore_ascii_case("upgrade")
                    || name.eq_ignore_ascii_case("sec-websocket-accept"))
            {
                continue;
            }
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
            tracing::debug!(
                event = "session_send_dropped",
                reason = "receiver_disconnected",
                "session_send_dropped"
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
    let (inject_tx, mut inject_rx) = tokio::sync::mpsc::channel::<crate::ws::WsInjectRequest>(
        crate::ws::WS_INJECT_CHANNEL_CAPACITY,
    );
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
                tracing::error!(
                    event = "ws_hyper_on_upgrade_failed",
                    request_id = %request_id,
                    error = %e,
                    "ws_hyper_on_upgrade_failed"
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

/// Read the full response body for a non-101 (refused WS upgrade) upstream
/// response.
///
/// `leftover` is the body prefix captured while reading the response head
/// (the head-reader stops once it sees the `\r\n\r\n` terminator, so any body
/// bytes past that first read are still on the upstream). The body is
/// delimited per `framing` (Content-Length / chunked / read-until-close).
///
/// All three framings are bounded by a per-read idle timeout
/// (`crate::ws_upstream_body_read_idle_timeout()`) and a byte ceiling
/// (`MAX_CAPTURED_BODY_BYTES`). The idle timeout is essential for the
/// read-until-close case on an HTTP/1.1 keep-alive connection: without it a
/// peer that keeps the connection open (e.g. a 403 error page with no
/// Content-Length) would block `upstream.read()` forever and the client would
/// never receive the refusal. On idle timeout or byte ceiling the body
/// collected so far is returned, preserving the upstream refusal status.
async fn read_full_response_body(
    upstream: &mut TlsOrPlain<crate::upstream_proxy::DialedStream>,
    leftover: Vec<u8>,
    framing: BodyFraming,
) -> Result<bytes::Bytes, String> {
    match framing {
        BodyFraming::ContentLength(total) => {
            read_length_delimited_body(upstream, leftover, total).await
        }
        BodyFraming::Chunked => read_chunked_body(upstream, leftover).await,
        BodyFraming::ReadUntilClose => read_until_close_body(upstream, leftover).await,
    }
}

/// Read exactly `total` bytes (Content-Length delimited). Each read is bounded
/// by the idle timeout and `total` is capped at `MAX_CAPTURED_BODY_BYTES` to
/// avoid unbounded memory on an absurd/malicious Content-Length.
async fn read_length_delimited_body(
    upstream: &mut TlsOrPlain<crate::upstream_proxy::DialedStream>,
    mut body: Vec<u8>,
    total: usize,
) -> Result<bytes::Bytes, String> {
    let total = total.min(MAX_CAPTURED_BODY_BYTES);
    if body.len() >= total {
        body.truncate(total);
        return Ok(bytes::Bytes::from(body));
    }

    let mut chunk = [0u8; READ_BUFFER_BYTES];
    while body.len() < total {
        let target = std::cmp::min(chunk.len(), total - body.len());
        let n = match timeout(
            crate::ws_upstream_body_read_idle_timeout(),
            upstream.read(&mut chunk[..target]),
        )
        .await
        {
            Ok(Ok(n)) => n,
            Ok(Err(e)) => return Err(format!("read body: {e}")),
            Err(_) => break, // idle timeout — return what we have so far
        };
        if n == 0 {
            break; // EOF
        }
        body.extend_from_slice(&chunk[..n]);
    }
    Ok(bytes::Bytes::from(body))
}

/// Read until the peer closes the connection (no length hint). Each read is
/// bounded by the idle timeout, which prevents indefinite blocking on an
/// HTTP/1.1 keep-alive peer that never sends EOF. The byte ceiling guards
/// against an unbounded body.
async fn read_until_close_body(
    upstream: &mut TlsOrPlain<crate::upstream_proxy::DialedStream>,
    mut body: Vec<u8>,
) -> Result<bytes::Bytes, String> {
    let mut chunk = [0u8; READ_BUFFER_BYTES];
    loop {
        if body.len() >= MAX_CAPTURED_BODY_BYTES {
            body.truncate(MAX_CAPTURED_BODY_BYTES);
            break;
        }
        let n = match timeout(
            crate::ws_upstream_body_read_idle_timeout(),
            upstream.read(&mut chunk),
        )
        .await
        {
            Ok(Ok(n)) => n,
            Ok(Err(e)) => return Err(format!("read body: {e}")),
            Err(_) => break, // idle timeout — treat as end of body
        };
        if n == 0 {
            break; // EOF
        }
        body.extend_from_slice(&chunk[..n]);
    }
    Ok(bytes::Bytes::from(body))
}

/// Decode a chunked (Transfer-Encoding: chunked) response body into a flat
/// buffer with chunk framing stripped. Reads are bounded by the idle timeout
/// and the total decoded size is capped at `MAX_CAPTURED_BODY_BYTES`.
/// `leftover` may already contain part of the first chunk.
async fn read_chunked_body(
    upstream: &mut TlsOrPlain<crate::upstream_proxy::DialedStream>,
    leftover: Vec<u8>,
) -> Result<bytes::Bytes, String> {
    let mut buf = leftover;
    let mut pos = 0usize; // consumed offset within `buf`
    let mut body = Vec::new();

    loop {
        // Read the chunk-size line (hex size, optional ";ext", \r\n-terminated).
        // M1: if the upstream stops (EOF / idle timeout) before the size line
        // arrives, return the body collected so far rather than erroring — the
        // caller needs the partial refusal body to preserve the upstream status.
        let line_end = loop {
            if let Some(rel) = find_crlf(&buf[pos..]) {
                break Some(pos + rel);
            }
            if !refill_stream(upstream, &mut buf, &mut pos).await? {
                break None;
            }
        };
        let Some(line_end) = line_end else {
            break;
        };

        let size_str = std::str::from_utf8(&buf[pos..line_end])
            .map_err(|_| "chunk size line is not utf-8".to_string())?;
        // Ignore chunk extensions (";key=value"); clamp absurd sizes to the
        // body ceiling and saturate the +2 ("\r\n") to avoid overflow.
        let size_hex = size_str.split(';').next().unwrap_or("").trim();
        let size = usize::from_str_radix(size_hex, 16)
            .map_err(|_| format!("invalid chunk size: {size_hex:?}"))?
            .min(MAX_CAPTURED_BODY_BYTES);
        pos = line_end + 2; // consume the size line + \r\n

        if size == 0 {
            break; // last-chunk terminator
        }

        // Buffer the full chunk data + trailing \r\n before copying it out.
        // M1: a mid-chunk idle timeout / EOF (ensure_bytes returns Ok(false))
        // ends the body — return what was collected so far instead of erroring
        // and dropping the partial refusal body.
        if !ensure_bytes(upstream, &mut buf, &mut pos, size.saturating_add(2)).await? {
            break;
        }

        let remaining = MAX_CAPTURED_BODY_BYTES.saturating_sub(body.len());
        let to_take = std::cmp::min(size, remaining);
        body.extend_from_slice(&buf[pos..pos + to_take]);
        pos += size + 2; // consume data + \r\n

        if body.len() >= MAX_CAPTURED_BODY_BYTES {
            body.truncate(MAX_CAPTURED_BODY_BYTES);
            break;
        }
    }

    Ok(bytes::Bytes::from(body))
}

/// Drop consumed bytes before `*pos`, then read more from the upstream with an
/// idle timeout. Returns `false` on EOF (no more data available).
///
/// M1: an idle timeout returns `Ok(false)` (treated as end of body) instead of
/// `Err`, matching `read_until_close_body`. The contract of
/// `read_full_response_body` is to preserve the upstream refusal status code
/// (e.g. 403) and return the body collected so far on idle timeout or byte
/// ceiling; surfacing the timeout as a hard error dropped the partial refusal
/// body and synthesized a 502.
async fn refill_stream(
    upstream: &mut TlsOrPlain<crate::upstream_proxy::DialedStream>,
    buf: &mut Vec<u8>,
    pos: &mut usize,
) -> Result<bool, String> {
    if *pos > 0 {
        buf.drain(..*pos);
        *pos = 0;
    }
    let mut tmp = [0u8; READ_BUFFER_BYTES];
    let n = match timeout(
        crate::ws_upstream_body_read_idle_timeout(),
        upstream.read(&mut tmp),
    )
    .await
    {
        Ok(Ok(n)) => n,
        Ok(Err(e)) => return Err(format!("read chunked body: {e}")),
        Err(_) => return Ok(false), // idle timeout — treat as end of body (M1)
    };
    if n == 0 {
        return Ok(false); // EOF
    }
    buf.extend_from_slice(&tmp[..n]);
    Ok(true)
}

/// Ensure `buf[pos..]` contains at least `need` bytes, refilling from the
/// upstream (with idle timeout) as necessary.
///
/// Returns `Ok(false)` when the upstream stops producing bytes (EOF or idle
/// timeout, signalled by `refill_stream` as `Ok(false)`) before `need` is
/// satisfied, so the caller can treat it as end of body. Returns `Ok(true)`
/// once `need` bytes are buffered. Returns `Err` only on a genuine I/O error.
async fn ensure_bytes(
    upstream: &mut TlsOrPlain<crate::upstream_proxy::DialedStream>,
    buf: &mut Vec<u8>,
    pos: &mut usize,
    need: usize,
) -> Result<bool, String> {
    while buf.len() - *pos < need {
        if !refill_stream(upstream, buf, pos).await? {
            return Ok(false);
        }
    }
    Ok(true)
}

/// Return the byte index of the first `\r\n` in `slice`, if present.
fn find_crlf(slice: &[u8]) -> Option<usize> {
    slice.windows(2).position(|window| window == b"\r\n")
}

/// Parse an HTTP response head string into a status code and header list.
/// Input: "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n...\r\n\r\n"
///
/// M4: handles RFC 7230 §3.2.4 obs-fold — a line beginning with SP or HTAB is
/// a continuation of the previous header's value and is appended (with a
/// separating space) to it, instead of being silently dropped because it has
/// no `:`. A non-continuation line that has no valid `name:value` split is
/// logged and skipped (rather than silently discarded), so malformed upstream
/// responses are at least visible to operators.
pub(crate) fn parse_upstream_response_head(
    head: &str,
) -> Result<(u16, Vec<(String, String)>), String> {
    let mut lines = head.lines();
    let status_line = lines.next().unwrap_or("");

    let status_code: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|v| v.parse().ok())
        .unwrap_or(502);

    let mut headers: Vec<(String, String)> = Vec::new();
    for line in lines {
        // A leading SP/HTAB marks an obs-fold continuation line (RFC 7230
        // §3.2.4). Append it to the most recent header's value. If there is no
        // previous header the continuation is orphaned — warn and skip.
        let is_continuation = line.starts_with(' ') || line.starts_with('\t');
        if is_continuation {
            let continuation = line.trim_matches(|c: char| c == ' ' || c == '\t');
            if continuation.is_empty() {
                continue;
            }
            match headers.last_mut() {
                Some((_, value)) => {
                    if !value.is_empty() {
                        value.push(' ');
                    }
                    value.push_str(continuation);
                }
                None => {
                    tracing::warn!(
                        event = "ws_upgrade_obs_fold_orphan",
                        "obs-fold continuation line appeared before any header; ignored"
                    );
                }
            }
            continue;
        }

        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if let Some((name, value)) = line.split_once(':') {
            headers.push((name.trim().to_string(), value.trim().to_string()));
        } else {
            // No `:` and not a continuation: a malformed header line. Warn so
            // the operator can see the broken upstream, instead of silently
            // dropping it (the previous behaviour could hide a missing
            // Sec-WebSocket-Accept or Content-Length line).
            tracing::warn!(
                event = "ws_upgrade_malformed_header_line",
                line = %line,
                "malformed upstream header line has no ':' separator; skipped"
            );
        }
    }

    Ok((status_code, headers))
}

/// The RFC 6455 §1.3 magic GUID appended to the client's Sec-WebSocket-Key
/// before SHA-1'ing to derive the expected Sec-WebSocket-Accept value.
const WS_ACCEPT_MAGIC_GUID: &str = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

/// Compute the expected `Sec-WebSocket-Accept` value for a client key per
/// RFC 6455 §1.3: `base64(SHA1(key + magic GUID))`. SHA-1 is used purely as the
/// spec-defined handshake confirmation, not for any security-sensitive digest.
pub(crate) fn compute_ws_accept(client_key: &str) -> String {
    use sha1::{Digest, Sha1};
    let mut hasher = Sha1::new();
    hasher.update(client_key.as_bytes());
    hasher.update(WS_ACCEPT_MAGIC_GUID.as_bytes());
    BASE64_STANDARD.encode(hasher.finalize())
}

/// Validate a full RFC 6455 §4.2.2 101 Switching Protocols handshake.
///
/// M5: the previous check only required `status == 101` plus any `Upgrade`
/// header, accepting `HTTP/1.1 101 Upgrade: h2c` (no accept key) as a valid
/// WebSocket upgrade. To enter the relay we now require:
/// - `Connection:` header whose token list contains `upgrade` (case-insensitive)
/// - `Upgrade: websocket`
/// - a `Sec-WebSocket-Accept` header whose value equals
///   `base64(SHA1(client_sec_websocket_key + magic GUID))` — the full RFC 6455
///   §4.2.2 confirmation that the upstream actually processed our key, not just
///   echoed a header name. `client_key` is the request's `Sec-WebSocket-Key`
///   value; if it is missing the accept value cannot be verified and the
///   handshake is rejected.
pub(crate) fn is_valid_ws_upgrade_handshake(
    headers: &[(String, String)],
    client_key: Option<&str>,
) -> bool {
    let has_connection_upgrade = headers.iter().any(|(name, value)| {
        name.eq_ignore_ascii_case("connection")
            && value
                .split(',')
                .any(|token| token.trim().eq_ignore_ascii_case("upgrade"))
    });
    let has_upgrade_websocket = headers.iter().any(|(name, value)| {
        name.eq_ignore_ascii_case("upgrade") && value.trim().eq_ignore_ascii_case("websocket")
    });
    if !has_connection_upgrade || !has_upgrade_websocket {
        return false;
    }
    // RFC 6455 §4.2.2 §5.: the response Sec-WebSocket-Accept must equal the
    // SHA-1 of our key + GUID. A bare/echoed/wrong value means the upstream did
    // not actually perform the handshake calculation (e.g. an `Upgrade: h2c`
    // server that happens to send an accept header) and we must NOT relay WS
    // frames over the connection.
    let Some(client_key) = client_key else {
        return false;
    };
    let expected_accept = compute_ws_accept(client_key);
    headers.iter().any(|(name, value)| {
        name.eq_ignore_ascii_case("sec-websocket-accept") && value.trim() == expected_accept
    })
}

/// Convert a list of (name, value) header pairs into a reqwest HeaderMap.
pub(crate) fn ws_headers_to_header_map(headers: &[(String, String)]) -> HeaderMap {
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
        // M6: HTTP header field values are opaque octets; obs-text / Latin-1
        // bytes are legal but `HeaderValue::to_str()` rejects them, and the old
        // `unwrap_or("")` silently erased those values when forwarding to the
        // upstream (e.g. a Latin-1 Origin or an echoed Sec-WebSocket-Protocol).
        // Use a lossy decode so the value is preserved.
        let value_str = String::from_utf8_lossy(value.as_bytes());
        raw.push_str(&format!("{}: {}\r\n", name, value_str));
    }
    raw.push_str("\r\n");
    Ok(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    // -----------------------------------------------------------------------
    // ws_tls_server_name (IPv6 authority hosts)
    // -----------------------------------------------------------------------

    #[test]
    fn ws_tls_server_name_accepts_ipv6_authority_hosts() {
        use tokio_rustls::rustls::pki_types::ServerName;

        // `request.host` keeps the brackets of a `wss://[2001:db8::5]/...`
        // authority; ServerName::try_from used to reject that outright (and
        // silently fell back to a loopback ServerName).
        let bracketed = ws_tls_server_name("[2001:db8::5]");
        match bracketed {
            ServerName::IpAddress(ip) => {
                assert_eq!(std::net::IpAddr::from(ip).to_string(), "2001:db8::5");
            }
            other => panic!("expected an IP ServerName, got {other:?}"),
        }

        let bare = ws_tls_server_name("2001:db8::5");
        assert!(matches!(bare, ServerName::IpAddress(_)));

        let dns_name = ws_tls_server_name("api.example.com");
        assert!(matches!(dns_name, ServerName::DnsName(_)));
        assert_eq!(dns_name.to_str().to_ascii_lowercase(), "api.example.com");
    }

    // -----------------------------------------------------------------------
    // ws_default_port / ws_needs_tls (R6-1)
    // -----------------------------------------------------------------------

    fn mitm_mode() -> ConnectionMode {
        ConnectionMode::MitmHttps {
            host: "example.com".to_string(),
            port: 443,
            tls_protocol: None,
            tls_cipher_suite: None,
            tls_ms: 0,
            alpn_protocol: None,
        }
    }

    #[test]
    fn ws_default_port_wss_over_plain_proxy_is_443() {
        // R6-1: a `wss://` absolute-form request over the plain HTTP proxy port
        // must default to 443, not 80.
        let url = url::Url::parse("wss://echo.example.com/chat").unwrap();
        assert_eq!(ws_default_port(&url, &ConnectionMode::PlainHttp), 443);
    }

    #[test]
    fn ws_default_port_ws_over_plain_proxy_is_80() {
        let url = url::Url::parse("ws://echo.example.com/chat").unwrap();
        assert_eq!(ws_default_port(&url, &ConnectionMode::PlainHttp), 80);
    }

    #[test]
    fn ws_default_port_mitm_is_443() {
        // MITM path: URL is normalized to https://, default stays 443.
        let url = url::Url::parse("https://echo.example.com/chat").unwrap();
        assert_eq!(ws_default_port(&url, &mitm_mode()), 443);
    }

    #[test]
    fn ws_default_port_explicit_port_wins() {
        // When the URL carries an explicit port, the caller already selects it
        // via `url.port().unwrap_or(ws_default_port(...))`. Verify the default
        // is NOT consulted for a scheme that the `url` crate knows about (https),
        // so explicit ports on the real MITM path (normalized to https://) win.
        let url = url::Url::parse("https://echo.example.com:8443/chat").unwrap();
        assert_eq!(url.port(), Some(8443));
        assert_eq!(ws_default_port(&url, &mitm_mode()), 443); // default only, as fallback
    }

    #[test]
    fn ws_needs_tls_wss_over_plain_proxy_requires_tls() {
        // R6-1: `wss://` over plain proxy must use TLS even though ctx.mode is
        // PlainHttp. Before the fix this returned false (plain TCP) — the bug.
        let url = url::Url::parse("wss://echo.example.com/chat").unwrap();
        assert!(ws_needs_tls(&url, &ConnectionMode::PlainHttp));
    }

    #[test]
    fn ws_needs_tls_ws_over_plain_proxy_is_plain() {
        let url = url::Url::parse("ws://echo.example.com/chat").unwrap();
        assert!(!ws_needs_tls(&url, &ConnectionMode::PlainHttp));
    }

    #[test]
    fn ws_needs_tls_mitm_always_requires_tls() {
        // MITM path (browser CONNECTed) always uses TLS regardless of scheme.
        let https = url::Url::parse("https://echo.example.com/chat").unwrap();
        assert!(ws_needs_tls(&https, &mitm_mode()));
        // Even if a wss:// URL somehow reached the MITM path, TLS is still used.
        let wss = url::Url::parse("wss://echo.example.com/chat").unwrap();
        assert!(ws_needs_tls(&wss, &mitm_mode()));
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

    // M4: obs-fold continuation lines (RFC 7230 §3.2.4) must be folded into the
    // preceding header's value rather than silently dropped.
    #[test]
    fn parses_obs_fold_continuation_into_previous_header() {
        let head = concat!(
            "HTTP/1.1 101 Switching Protocols\r\n",
            "Upgrade: websocket\r\n",
            "Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n",
            // obs-fold continuation — leading SP, no ':'
            "  continuation-token\r\n",
            "Connection: upgrade\r\n",
            "\r\n",
        );
        let (status, headers) = parse_upstream_response_head(head).unwrap();
        assert_eq!(status, 101);
        let accept = headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case("sec-websocket-accept"))
            .map(|(_, v)| v.clone())
            .expect("sec-websocket-accept header must be present");
        assert!(
            accept.contains("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="),
            "accept header must contain original value, got: {accept}"
        );
        assert!(
            accept.contains("continuation-token"),
            "obs-fold continuation must be appended to accept header, got: {accept}"
        );
    }

    // M4: a tab-prefixed continuation folds the same way as a space-prefixed one.
    #[test]
    fn parses_obs_fold_with_tab_prefix() {
        let head = "HTTP/1.1 200 OK\r\nX-Folded: a\r\n\tb\r\n\r\n";
        let (_status, headers) = parse_upstream_response_head(head).unwrap();
        let folded = headers
            .iter()
            .find(|(n, _)| n.eq_ignore_ascii_case("x-folded"))
            .map(|(_, v)| v.as_str())
            .expect("x-folded header must be present");
        assert_eq!(folded, "a b");
    }

    // M4: a non-continuation line with no ':' is logged and skipped (not silently
    // dropped, not parsed as a header with empty name). The remaining headers
    // must still parse correctly.
    #[test]
    fn parses_skips_malformed_line_without_colon() {
        let head = concat!(
            "HTTP/1.1 200 OK\r\n",
            "X-Valid: yes\r\n",
            "this-line-has-no-colon\r\n",
            "X-Other: ok\r\n",
            "\r\n",
        );
        let (status, headers) = parse_upstream_response_head(head).unwrap();
        assert_eq!(status, 200);
        // The malformed line must not become a header entry.
        assert_eq!(headers.len(), 2);
        assert!(headers
            .iter()
            .any(|(n, v)| n.eq_ignore_ascii_case("x-valid") && v == "yes"));
        assert!(headers
            .iter()
            .any(|(n, v)| n.eq_ignore_ascii_case("x-other") && v == "ok"));
    }

    // -----------------------------------------------------------------------
    // compute_ws_accept / is_valid_ws_upgrade_handshake (M5)
    // -----------------------------------------------------------------------

    // The RFC 6455 §1.3 worked example: client key "dGhlIHNhbXBsZSBub25jZQ=="
    // must produce accept "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=". This is the canonical
    // test vector from the spec.
    const RFC6455_EXAMPLE_CLIENT_KEY: &str = "dGhlIHNhbXBsZSBub25jZQ==";
    const RFC6455_EXAMPLE_ACCEPT: &str = "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=";

    #[test]
    fn compute_ws_accept_matches_rfc6455_example() {
        assert_eq!(
            compute_ws_accept(RFC6455_EXAMPLE_CLIENT_KEY),
            RFC6455_EXAMPLE_ACCEPT,
            "computed accept must match the RFC 6455 §1.3 worked example"
        );
    }

    #[test]
    fn handshake_valid_with_correct_accept_value() {
        let headers = vec![
            ("Connection".to_string(), "upgrade".to_string()),
            ("Upgrade".to_string(), "websocket".to_string()),
            (
                "Sec-WebSocket-Accept".to_string(),
                RFC6455_EXAMPLE_ACCEPT.to_string(),
            ),
        ];
        assert!(is_valid_ws_upgrade_handshake(
            &headers,
            Some(RFC6455_EXAMPLE_CLIENT_KEY)
        ));
    }

    #[test]
    fn handshake_invalid_when_accept_value_is_wrong() {
        // M5 value verification: a bare/echoed/wrong accept value must be
        // rejected even though the header is present. Previously the check only
        // verified header existence, so "Sec-WebSocket-Accept: x" passed and the
        // relay accepted a handshake the upstream never actually computed.
        let headers = vec![
            ("Connection".to_string(), "upgrade".to_string()),
            ("Upgrade".to_string(), "websocket".to_string()),
            ("Sec-WebSocket-Accept".to_string(), "x".to_string()),
        ];
        assert!(!is_valid_ws_upgrade_handshake(
            &headers,
            Some(RFC6455_EXAMPLE_CLIENT_KEY)
        ));
    }

    #[test]
    fn handshake_invalid_when_accept_is_a_bogus_echoed_value() {
        // The upstream must NOT pass by echoing a plausible-looking but
        // uncomputed base64 value.
        let headers = vec![
            ("Connection".to_string(), "upgrade".to_string()),
            ("Upgrade".to_string(), "websocket".to_string()),
            ("Sec-WebSocket-Accept".to_string(), "abc123==".to_string()),
        ];
        assert!(!is_valid_ws_upgrade_handshake(
            &headers,
            Some(RFC6455_EXAMPLE_CLIENT_KEY)
        ));
    }

    #[test]
    fn handshake_invalid_when_connection_missing_upgrade_token() {
        // Connection present but no "upgrade" token — must NOT validate.
        let headers = vec![
            ("Connection".to_string(), "keep-alive".to_string()),
            ("Upgrade".to_string(), "websocket".to_string()),
            (
                "Sec-WebSocket-Accept".to_string(),
                RFC6455_EXAMPLE_ACCEPT.to_string(),
            ),
        ];
        assert!(!is_valid_ws_upgrade_handshake(
            &headers,
            Some(RFC6455_EXAMPLE_CLIENT_KEY)
        ));
    }

    #[test]
    fn handshake_valid_when_connection_lists_upgrade_among_other_tokens() {
        let headers = vec![
            ("Connection".to_string(), "keep-alive, upgrade".to_string()),
            ("Upgrade".to_string(), "websocket".to_string()),
            (
                "Sec-WebSocket-Accept".to_string(),
                RFC6455_EXAMPLE_ACCEPT.to_string(),
            ),
        ];
        assert!(is_valid_ws_upgrade_handshake(
            &headers,
            Some(RFC6455_EXAMPLE_CLIENT_KEY)
        ));
    }

    #[test]
    fn handshake_invalid_when_upgrade_not_websocket() {
        // e.g. the malformed `HTTP/1.1 101 Upgrade: h2c` case — Connection has
        // upgrade, but Upgrade is "h2c" not "websocket", and no Accept header.
        let headers = vec![
            ("Connection".to_string(), "upgrade".to_string()),
            ("Upgrade".to_string(), "h2c".to_string()),
        ];
        assert!(!is_valid_ws_upgrade_handshake(
            &headers,
            Some(RFC6455_EXAMPLE_CLIENT_KEY)
        ));
    }

    #[test]
    fn handshake_invalid_when_accept_header_absent() {
        let headers = vec![
            ("Connection".to_string(), "upgrade".to_string()),
            ("Upgrade".to_string(), "websocket".to_string()),
        ];
        assert!(!is_valid_ws_upgrade_handshake(
            &headers,
            Some(RFC6455_EXAMPLE_CLIENT_KEY)
        ));
    }

    #[test]
    fn handshake_invalid_when_client_key_is_missing() {
        // Without the client Sec-WebSocket-Key the accept value cannot be
        // verified — reject rather than fall back to existence-only.
        let headers = vec![
            ("Connection".to_string(), "upgrade".to_string()),
            ("Upgrade".to_string(), "websocket".to_string()),
            (
                "Sec-WebSocket-Accept".to_string(),
                RFC6455_EXAMPLE_ACCEPT.to_string(),
            ),
        ];
        assert!(!is_valid_ws_upgrade_handshake(&headers, None));
    }

    #[test]
    fn handshake_is_case_insensitive() {
        let headers = vec![
            ("connection".to_string(), "Upgrade".to_string()),
            ("upgrade".to_string(), "WebSocket".to_string()),
            (
                "sec-websocket-accept".to_string(),
                RFC6455_EXAMPLE_ACCEPT.to_string(),
            ),
        ];
        assert!(is_valid_ws_upgrade_handshake(
            &headers,
            Some(RFC6455_EXAMPLE_CLIENT_KEY)
        ));
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

    // M6: a header value containing non-ASCII bytes (legal obs-text / Latin-1)
    // must be forwarded lossily rather than erased to an empty string by
    // `HeaderValue::to_str()`.
    #[test]
    fn ws_upgrade_request_preserves_non_ascii_header_value() {
        let mut request = make_ws_request();
        // 0xE9 is 'é' in Latin-1 / obs-text — `to_str()` rejects it.
        request
            .headers
            .insert("x-origin", HeaderValue::from_bytes(b"caf\xe9").unwrap());

        let raw = build_ws_upgrade_request(&request).unwrap();
        assert!(
            raw.contains("x-origin: caf"),
            "non-ASCII header value must be preserved (lossily), got: {raw}"
        );
        assert!(
            !raw.contains("x-origin: \r\n"),
            "non-ASCII header value must NOT be erased to empty, got: {raw}"
        );
    }
}
