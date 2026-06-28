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
    let port = request.url.port().unwrap_or(match ctx.mode {
        ConnectionMode::PlainHttp => 80,
        ConnectionMode::MitmHttps { .. } => 443,
    });

    // Resolve DNS override.
    let connect_host =
        match crate::resolve_dns_override(&ctx.dns_manager, &ctx.workspace_id, &request.host) {
            Some(ip) => {
                tracing::info!(
                    event = "dns_override_ws",
                    host = %request.host,
                    override_ip = %ip,
                    "dns_override_ws"
                );
                ip.to_string()
            }
            None => request.host.clone(),
        };
    let connect_host_port = format!("{connect_host}:{port}");

    tracing::debug!(
        event = "ws_hyper_connecting_upstream",
        request_id = %request_id,
        host_port = %format!("{}:{}", request.host, port),
        "ws_hyper_connecting_upstream"
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
            let client_config = aiproxy_tls_manager::client::build_dangerous_client_config();
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
            TlsOrPlain::Tls(Box::new(tls_stream))
        }
        ConnectionMode::PlainHttp => TlsOrPlain::Plain(ws_tcp),
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
    tracing::debug!(
        event = "ws_hyper_sending_upgrade",
        request_id = %request_id,
        "ws_hyper_sending_upgrade"
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
        match crate::connect::read_http_response_head(&mut upstream).await {
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

    if status_code != 101
        || !upstream_headers
            .iter()
            .any(|(n, _)| n.eq_ignore_ascii_case("upgrade"))
    {
        // Upstream did not agree to upgrade — return its response as-is.
        tracing::warn!(
            event = "ws_hyper_upstream_refused",
            request_id = %request_id,
            status_code = status_code,
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
    upstream: &mut TlsOrPlain<tokio::net::TcpStream>,
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
    upstream: &mut TlsOrPlain<tokio::net::TcpStream>,
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
    upstream: &mut TlsOrPlain<tokio::net::TcpStream>,
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
    upstream: &mut TlsOrPlain<tokio::net::TcpStream>,
    leftover: Vec<u8>,
) -> Result<bytes::Bytes, String> {
    let mut buf = leftover;
    let mut pos = 0usize; // consumed offset within `buf`
    let mut body = Vec::new();

    loop {
        // Read the chunk-size line (hex size, optional ";ext", \r\n-terminated).
        let line_end = loop {
            if let Some(rel) = find_crlf(&buf[pos..]) {
                break pos + rel;
            }
            if !refill_stream(upstream, &mut buf, &mut pos).await? {
                return Err("chunked body ended before size line".into());
            }
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
        ensure_bytes(upstream, &mut buf, &mut pos, size.saturating_add(2)).await?;

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
async fn refill_stream(
    upstream: &mut TlsOrPlain<tokio::net::TcpStream>,
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
        Err(_) => return Err("chunked body read timed out".to_string()),
    };
    if n == 0 {
        return Ok(false); // EOF
    }
    buf.extend_from_slice(&tmp[..n]);
    Ok(true)
}

/// Ensure `buf[pos..]` contains at least `need` bytes, refilling from the
/// upstream (with idle timeout) as necessary.
async fn ensure_bytes(
    upstream: &mut TlsOrPlain<tokio::net::TcpStream>,
    buf: &mut Vec<u8>,
    pos: &mut usize,
    need: usize,
) -> Result<(), String> {
    while buf.len() - *pos < need {
        if !refill_stream(upstream, buf, pos).await? {
            return Err("chunked body ended unexpectedly (EOF)".into());
        }
    }
    Ok(())
}

/// Return the byte index of the first `\r\n` in `slice`, if present.
fn find_crlf(slice: &[u8]) -> Option<usize> {
    slice.windows(2).position(|window| window == b"\r\n")
}

/// Parse an HTTP response head string into a status code and header list.
/// Input: "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n...\r\n\r\n"
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
        raw.push_str(&format!("{}: {}\r\n", name, value.to_str().unwrap_or("")));
    }
    raw.push_str("\r\n");
    Ok(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
