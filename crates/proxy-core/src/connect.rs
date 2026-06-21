use super::*;
use crate::server::PrefixedStream;
use tokio::io::{AsyncRead, AsyncWrite};

// ---------------------------------------------------------------------------
// CONNECT tunnel handling: blind relay, MITM, HTTPS WebSocket upgrade
// ---------------------------------------------------------------------------

/// Blind TCP relay for CONNECT when SSL interception is disabled.
pub(crate) async fn tunnel_blind_relay<S: AsyncRead + AsyncWrite + Unpin>(
    mut client_stream: S,
    host: &str,
    port: u16,
    dns_manager: &Option<Arc<DnsManager>>,
    workspace_id: &str,
) -> Result<(), String> {
    // Send 200 Connection Established
    client_stream
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await
        .map_err(map_io_error)?;

    let connect_host = match resolve_dns_override(dns_manager, workspace_id, host) {
        Some(ip) => {
            tracing::info!(
                event = "dns_override_applied",
                host = %host,
                override_ip = %ip,
                "dns_override_applied"
            );
            ip.to_string()
        }
        None => host.to_string(),
    };
    let mut upstream = TcpStream::connect((&*connect_host, port))
        .await
        .map_err(|e| format!("failed to connect to upstream {host}:{port}: {e}"))?;

    // Bidirectional relay honoring TCP half-close.
    //
    // `copy_bidirectional` is the correct primitive here: when one side reaches
    // EOF it shuts down the OTHER side's writer (so a server waiting on EOF
    // proceeds and returns its response), while continuing to flush any in-flight
    // data on the surviving direction. The loop returns once both directions are
    // done. This replaces a hand-rolled select loop that (a) aborted the tunnel
    // on the first EOF (dropping in-flight data) and (b) when patched to wait for
    // both directions, failed to shut down the peer writer, which could hang a
    // server still expecting an EOF (H6 + hang regression).
    let (client_bytes, upstream_bytes) =
        tokio::io::copy_bidirectional(&mut client_stream, &mut upstream)
            .await
            .map_err(map_io_error)?;

    tracing::debug!(
        event = "tunnel_relay_completed",
        host = %host,
        client_to_upstream_bytes = client_bytes,
        upstream_to_client_bytes = upstream_bytes,
        "tunnel_relay_completed"
    );

    Ok(())
}

/// Handle WebSocket upgrade for plain HTTP (ws://) connections.
/// Opens a raw TCP connection to upstream, sends the upgrade request, reads the 101 response,
/// writes it back to the client, then enters bidirectional frame relay.
///
/// Handle WebSocket upgrade for HTTPS (wss://) connections via MITM.
/// Opens a raw TLS connection to upstream, sends the upgrade request, reads the 101 response,
/// writes it back to the client, then enters bidirectional frame relay.
#[allow(dead_code)]
#[allow(clippy::too_many_arguments)]
async fn handle_https_websocket_upgrade<S: AsyncReadExt + AsyncWriteExt + Unpin>(
    client_stream: &mut S,
    request: &ParsedProxyRequest,
    session_sender: &mpsc::Sender<ProxySessionDetail>,
    ws_message_sender: &mpsc::Sender<crate::ws::WsMessageData>,
    started_at: DateTime<Utc>,
    started_at_instant: Instant,
    tls_ms: u128,
    dns_manager: &Option<Arc<DnsManager>>,
    workspace_id: &str,
) -> Result<(), String> {
    let port = request.url.port().unwrap_or(443);
    let host_port = format!("{}:{}", request.host, port);
    let connect_host = match resolve_dns_override(dns_manager, workspace_id, &request.host) {
        Some(ip) => {
            tracing::info!(
                event = "dns_override_wss",
                host = %request.host,
                override_ip = %ip,
                "dns_override_wss"
            );
            ip.to_string()
        }
        None => request.host.clone(),
    };
    let connect_host_port = format!("{}:{}", connect_host, port);

    tracing::debug!(
        event = "wss_connecting_upstream",
        request_id = %request.request_id,
        host_port = %host_port,
        "wss_connecting_upstream"
    );

    let ws_tcp = TcpStream::connect(&*connect_host_port).await.map_err(|e| {
        tracing::error!(
            event = "wss_upstream_connect_failed",
            request_id = %request.request_id,
            host_port = %host_port,
            error = %e,
            "wss_upstream_connect_failed"
        );
        format!("wss upstream connect: {e}")
    })?;

    tracing::debug!(
        event = "wss_tcp_connected",
        request_id = %request.request_id,
        "wss_tcp_connected"
    );

    let client_config = aiproxy_tls_manager::client::build_dangerous_client_config();
    let tls_connector = tokio_rustls::TlsConnector::from(client_config);
    let ws_host = request.host.clone();
    let dns_name = tokio_rustls::rustls::pki_types::ServerName::try_from(ws_host.clone())
        .unwrap_or_else(|_| {
            tokio_rustls::rustls::pki_types::ServerName::IpAddress(
                std::net::Ipv4Addr::LOCALHOST.into(),
            )
        });

    tracing::debug!(
        event = "wss_starting_tls_handshake",
        request_id = %request.request_id,
        ws_host = %ws_host,
        "wss_starting_tls_handshake"
    );

    let mut upstream = tls_connector.connect(dns_name, ws_tcp).await.map_err(|e| {
        tracing::error!(
            event = "wss_tls_handshake_failed",
            request_id = %request.request_id,
            ws_host = %ws_host,
            error = %e,
            "wss_tls_handshake_failed"
        );
        format!("wss upstream tls handshake: {e}")
    })?;

    tracing::debug!(
        event = "wss_tls_connected",
        request_id = %request.request_id,
        "wss_tls_connected"
    );

    let raw_req = build_raw_upgrade_request(request)?;
    tracing::debug!(
        event = "wss_sending_upgrade",
        request_id = %request.request_id,
        raw_req_len = raw_req.len(),
        "wss_sending_upgrade"
    );
    tracing::debug!(
        event = "wss_raw_request",
        request_id = %request.request_id,
        raw_req = %raw_req,
        "wss_raw_request"
    );

    upstream.write_all(raw_req.as_bytes()).await.map_err(|e| {
        tracing::error!(
            event = "wss_upgrade_send_failed",
            request_id = %request.request_id,
            error = %e,
            "wss_upgrade_send_failed"
        );
        format!("wss upgrade send: {e}")
    })?;

    // Read the upstream 101 response and relay it to the client
    let (response_head, response_prefix) = read_http_response_head(&mut upstream)
        .await
        .inspect_err(|e| {
            tracing::error!(
                event = "wss_read_response_head_failed",
                request_id = %request.request_id,
                error = %e,
                "wss_read_response_head_failed"
            );
        })?;

    tracing::debug!(
        event = "wss_got_response_head",
        request_id = %request.request_id,
        response_head = %response_head,
        "wss_got_response_head"
    );

    let status_line = response_head.lines().next().unwrap_or("");
    let status_code: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|v| v.parse().ok())
        .unwrap_or(502);

    tracing::info!(
        event = "wss_upstream_status",
        request_id = %request.request_id,
        status_code = status_code,
        "wss_upstream_status"
    );

    client_stream
        .write_all(response_head.as_bytes())
        .await
        .map_err(|e| {
            tracing::error!(
                event = "wss_write_to_client_failed",
                request_id = %request.request_id,
                error = %e,
                "wss_write_to_client_failed"
            );
            format!("wss response write to client: {e}")
        })?;
    client_stream
        .flush()
        .await
        .map_err(|e| format!("wss flush: {e}"))?;

    tracing::info!(
        event = "wss_entering_relay",
        request_id = %request.request_id,
        session_id = %request.request_id,
        "wss_entering_relay"
    );

    let mut detail = build_session_detail(
        request,
        status_code,
        &HeaderMap::new(),
        &[],
        0,
        started_at,
        started_at_instant,
        ProxyTimingBreakdown {
            connect_ms: None,
            dns_ms: None,
            request_send_ms: None,
            response_read_ms: Some(0),
            tls_ms: Some(tls_ms),
            total_ms: Some(started_at_instant.elapsed().as_millis()),
            waiting_ms: Some(0),
        },
        false,
    );
    detail.summary.protocol = "wss".to_string();
    let protocol_metadata = infer_protocol_metadata(&detail.summary.protocol, &detail.summary.url);
    detail.summary.scheme = protocol_metadata.scheme;
    detail.summary.http_version = protocol_metadata.http_version;
    detail.summary.transport_protocol = protocol_metadata.transport_protocol;
    detail.summary.application_protocol = protocol_metadata.application_protocol;
    detail.summary.response_mime_type = Some("websocket".to_string());
    let session_id_for_relay = detail.id.clone();
    if session_sender.send(detail).await.is_err() {
        return Ok(());
    }

    let (inject_tx, mut inject_rx) =
        tokio::sync::mpsc::unbounded_channel::<crate::ws::WsInjectRequest>();
    let registry = crate::ws::global_ws_registry();
    registry.register(session_id_for_relay.clone(), inject_tx);

    let mut upstream = PrefixedStream::new(response_prefix, &mut upstream);
    crate::ws::relay_websocket_frames(
        client_stream,
        &mut upstream,
        &session_id_for_relay,
        ws_message_sender,
        &mut inject_rx,
    )
    .await;

    registry.mark_closed(&session_id_for_relay);
    registry.unregister(&session_id_for_relay);
    Ok(())
}

/// Read a complete HTTP response head (status line + headers) from a stream.
/// Returns the full text including the trailing \r\n\r\n.
pub(crate) async fn read_http_response_head<R: AsyncReadExt + Unpin>(
    reader: &mut R,
) -> Result<(String, Vec<u8>), String> {
    let mut buf = Vec::with_capacity(READ_BUFFER_BYTES);
    let mut chunk = [0u8; READ_BUFFER_BYTES];

    loop {
        let bytes_read = reader
            .read(&mut chunk)
            .await
            .map_err(|e| format!("read response head: {e}"))?;
        if bytes_read == 0 {
            return Err("upstream closed before response head completed".to_string());
        }

        buf.extend_from_slice(&chunk[..bytes_read]);
        if buf.len() > MAX_HEADER_BYTES {
            return Err(format!(
                "response head exceeded maximum size of {MAX_HEADER_BYTES} bytes"
            ));
        }

        if let Some(header_end) = buf.windows(4).position(|window| window == b"\r\n\r\n") {
            let body_start = header_end + 4;
            let head = buf[..body_start].to_vec();
            let prefix = buf[body_start..].to_vec();
            let head = String::from_utf8(head).map_err(|e| format!("response head utf8: {e}"))?;
            return Ok((head, prefix));
        }
    }
}

/// Build a raw HTTP upgrade request string for WebSocket relay.
fn build_raw_upgrade_request(request: &ParsedProxyRequest) -> Result<String, String> {
    let path = build_request_path(&request.url);
    let mut raw = format!("{} {} HTTP/1.1\r\n", request.method, path,);

    // Re-inject Host header because build_upstream_headers strips it as hop-by-hop.
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

/// HTTPS MITM: terminate TLS, capture decrypted traffic, forward upstream.
///
/// Uses a hyper server connection to parse HTTP requests from the TLS stream.
/// This allows handling both HTTP/1.1 and HTTP/2 (based on ALPN negotiation)
/// through the same `HttpProxyService` request handler.
#[allow(clippy::too_many_arguments)]
pub(crate) async fn handle_connect_mitm<S: AsyncRead + AsyncWrite + Unpin + Send + 'static>(
    mut stream: S,
    host: String,
    port: u16,
    tls_manager: Arc<TlsManager>,
    client_addr: SocketAddr,
    session_sender: mpsc::Sender<ProxySessionDetail>,
    ws_message_sender: mpsc::Sender<crate::ws::WsMessageData>,
    breakpoint_manager: Option<Arc<BreakpointManager>>,
    rewrite_manager: Option<Arc<RewriteManager>>,
    map_manager: Option<Arc<MapManager>>,
    script_manager: Option<Arc<ScriptManager>>,
    throttle_manager: Option<Arc<ThrottleManager>>,
    dns_manager: Option<Arc<DnsManager>>,
    workspace_id: String,
    event_emitter: Option<BreakpointEventEmitter>,
    upstream_pool: Arc<crate::upstream_pool::UpstreamConnectionPool>,
) -> Result<(), ProxyError> {
    // Send 200 Connection Established
    stream
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await
        .map_err(ProxyError::IoError)?;

    let tls_acceptor = tokio_rustls::TlsAcceptor::from(tls_manager.server_config.clone());
    let tls_instant = Instant::now();
    let tls_stream = match tls_acceptor.accept(stream).await {
        Ok(stream) => stream,
        Err(error) => {
            tracing::warn!(
                event = "tls_handshake_failed",
                host = %host,
                port = port,
                error = %error,
                "tls_handshake_failed"
            );
            return Err(ProxyError::TlsError(format!(
                "TLS handshake failed for {host}:{port}: {error}"
            )));
        }
    };
    let tls_ms = tls_instant.elapsed().as_millis();
    let tls_protocol = tls_stream
        .get_ref()
        .1
        .protocol_version()
        .map(format_tls_protocol_version);
    let tls_cipher_suite = tls_stream
        .get_ref()
        .1
        .negotiated_cipher_suite()
        .map(|suite| format_tls_cipher_suite(suite.suite()));
    let alpn_protocol = tls_stream
        .get_ref()
        .1
        .alpn_protocol()
        .map(|proto| String::from_utf8_lossy(proto).to_string());

    tracing::debug!(
        event = "tls_handshake_succeeded",
        host = %host,
        port = port,
        alpn = %alpn_protocol.as_deref().unwrap_or("(none)"),
        "tls_handshake_succeeded"
    );

    let is_h2 = alpn_protocol.as_deref() == Some("h2");

    if is_h2 {
        tracing::info!(
            host = %host,
            alpn = ?alpn_protocol,
            "HTTP/2 negotiated for MITM connection"
        );
    }

    // Build shared connection context for this MITM connection.
    let ctx = Arc::new(ConnectionContext {
        mode: ConnectionMode::MitmHttps {
            host: host.clone(),
            port,
            tls_protocol,
            tls_cipher_suite,
            tls_ms,
            alpn_protocol,
        },
        client_addr,
        session_sender,
        ws_message_sender,
        rewrite_manager,
        map_manager,
        script_manager,
        throttle_manager,
        breakpoint_manager,
        dns_manager,
        workspace_id,
        event_emitter,
        upstream_pool,
    });
    let service = HttpProxyService { ctx };

    // Use hyper server to handle the decrypted HTTP traffic.
    // Wrap the TLS stream in TokioIo to bridge tokio's AsyncRead/AsyncWrite
    // to hyper's Read/Write traits.
    let io = hyper_util::rt::TokioIo::new(tls_stream);

    if is_h2 {
        let executor = hyper_util::rt::TokioExecutor::new();
        hyper::server::conn::http2::Builder::new(executor)
            .serve_connection(io, service)
            .await
            .map_err(|e| {
                tracing::warn!(
                    event = "h2_serve_error",
                    host = %host,
                    error = %e,
                    "h2_serve_error"
                );
                ProxyError::Other(format!(
                    "HTTP/2 server connection error for {host}:{port}: {e}"
                ))
            })?;
    } else {
        hyper::server::conn::http1::Builder::new()
            .serve_connection(io, service)
            .with_upgrades()
            .await
            .map_err(|e| {
                tracing::warn!(
                    event = "h1_serve_error",
                    host = %host,
                    error = %e,
                    "h1_serve_error"
                );
                ProxyError::Other(format!(
                    "HTTP/1.1 server connection error for {host}:{port}: {e}"
                ))
            })?;
    }

    Ok(())
}

fn format_tls_protocol_version(version: tokio_rustls::rustls::ProtocolVersion) -> String {
    match version {
        tokio_rustls::rustls::ProtocolVersion::TLSv1_2 => "TLSv1.2".to_string(),
        tokio_rustls::rustls::ProtocolVersion::TLSv1_3 => "TLSv1.3".to_string(),
        other => format!("{other:?}"),
    }
}

fn format_tls_cipher_suite(suite: tokio_rustls::rustls::CipherSuite) -> String {
    let suite_name = format!("{suite:?}");

    suite_name
        .strip_prefix("TLS13_")
        .or_else(|| suite_name.strip_prefix("TLS12_"))
        .unwrap_or(&suite_name)
        .to_string()
}
