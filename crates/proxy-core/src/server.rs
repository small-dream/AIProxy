use super::*;
use std::pin::Pin;
use std::task::{Context, Poll};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};

struct PrefixedStream<'a, S> {
    prefix: Cursor<Vec<u8>>,
    inner: &'a mut S,
}

impl<'a, S> PrefixedStream<'a, S> {
    fn new(prefix: Vec<u8>, inner: &'a mut S) -> Self {
        Self {
            prefix: Cursor::new(prefix),
            inner,
        }
    }
}

static DIRECT_HTTP_CLIENT: OnceLock<Client> = OnceLock::new();

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

fn direct_http_client() -> Result<Client, String> {
    if let Some(client) = DIRECT_HTTP_CLIENT.get() {
        return Ok(client.clone());
    }

    let client = Client::builder()
        .redirect(Policy::none())
        .no_proxy()
        .build()
        .map_err(|e| format!("failed to create HTTP client: {e}"))?;
    let _ = DIRECT_HTTP_CLIENT.set(client);

    DIRECT_HTTP_CLIENT
        .get()
        .cloned()
        .ok_or_else(|| "failed to initialize HTTP client".to_string())
}

impl<S: AsyncRead + Unpin> AsyncRead for PrefixedStream<'_, S> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        let position = self.prefix.position() as usize;
        let prefix = self.prefix.get_ref();
        if position < prefix.len() {
            let bytes_to_copy = std::cmp::min(buf.remaining(), prefix.len() - position);
            buf.put_slice(&prefix[position..position + bytes_to_copy]);
            self.prefix.set_position((position + bytes_to_copy) as u64);
            return Poll::Ready(Ok(()));
        }

        Pin::new(&mut *self.inner).poll_read(cx, buf)
    }
}

impl<S: AsyncWrite + Unpin> AsyncWrite for PrefixedStream<'_, S> {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bytes: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        Pin::new(&mut *self.inner).poll_write(cx, bytes)
    }

    fn poll_flush(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut *self.inner).poll_flush(cx)
    }

    fn poll_shutdown(mut self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Pin::new(&mut *self.inner).poll_shutdown(cx)
    }
}

#[allow(clippy::too_many_arguments)]
pub async fn start_proxy_server(
    config: ProxyRuntimeConfig,
    tls_manager: Option<Arc<TlsManager>>,
    breakpoint_manager: Option<Arc<BreakpointManager>>,
    rewrite_manager: Option<Arc<RewriteManager>>,
    map_manager: Option<Arc<MapManager>>,
    script_manager: Option<Arc<ScriptManager>>,
    throttle_manager: Option<Arc<ThrottleManager>>,
    dns_manager: Option<Arc<DnsManager>>,
    workspace_id: Option<String>,
    event_emitter: Option<BreakpointEventEmitter>,
) -> Result<StartedProxyServer, String> {
    config.validate().map_err(str::to_string)?;

    let bind_addr: &str = DEFAULT_BIND_ADDRESS;
    let listener = TcpListener::bind((bind_addr, config.port))
        .await
        .map_err(|error| format_listener_bind_error(bind_addr, config.port, &error))?;
    let bound_port = listener
        .local_addr()
        .map_err(|error| format!("failed to read proxy listener address: {error}"))?
        .port();

    let client = Client::builder()
        .redirect(Policy::none())
        .no_proxy()
        .build()
        .map_err(|error| format!("failed to create upstream HTTP client: {error}"))?;
    let client = Arc::new(client);

    let (shutdown_sender, mut shutdown_receiver) = oneshot::channel::<()>();
    let (session_sender, session_receiver) = mpsc::channel(4096);
    let (ws_message_sender, ws_message_receiver) = mpsc::channel(4096);
    let connection_semaphore = Arc::new(Semaphore::new(MAX_CONCURRENT_CONNECTIONS));

    emit_log(
        "INFO",
        "listener_started",
        &[
            ("host", bind_addr.to_string()),
            ("port", bound_port.to_string()),
            ("ssl_enabled", config.ssl_enabled.to_string()),
            ("max_connections", MAX_CONCURRENT_CONNECTIONS.to_string()),
        ],
    );

    let join_handle = tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = &mut shutdown_receiver => {
                    emit_log(
                        "INFO",
                        "listener_stopped",
                        &[("reason", "shutdown_requested".to_string())],
                    );
                    break;
                }
                accept_result = listener.accept() => {
                    match accept_result {
                        Ok((stream, client_addr)) => {
                            let permit = match connection_semaphore.clone().try_acquire_owned() {
                                Ok(permit) => permit,
                                Err(_) => {
                                    emit_log(
                                        "WARN",
                                        "connection_rejected",
                                        &[
                                            ("client_addr", client_addr.to_string()),
                                            ("reason", "max_connections_reached".to_string()),
                                        ],
                                    );
                                    continue;
                                }
                            };

                            let client = Arc::clone(&client);
                            let session_sender = session_sender.clone();
                            let ws_message_sender = ws_message_sender.clone();
                            let tls_manager = tls_manager.clone();
                            let breakpoint_manager = breakpoint_manager.clone();
                            let rewrite_manager = rewrite_manager.clone();
                            let map_manager = map_manager.clone();
                            let script_manager = script_manager.clone();
                            let throttle_manager = throttle_manager.clone();
                            let dns_manager = dns_manager.clone();
                            let workspace_id = workspace_id.clone();
                            let event_emitter = event_emitter.clone();

                            tokio::spawn(async move {
                                let _permit = permit;
                                if let Err(error) = handle_connection(
                                    stream,
                                    client_addr,
                                    client,
                                    session_sender,
                                    ws_message_sender,
                                    tls_manager,
                                    breakpoint_manager,
                                    rewrite_manager,
                                    map_manager,
                                    script_manager,
                                    throttle_manager,
                                    dns_manager,
                                    workspace_id,
                                    event_emitter,
                                )
                                .await
                                {
                                    emit_log(
                                        "ERROR",
                                        "connection_failed",
                                        &[
                                            ("client_addr", client_addr.to_string()),
                                            ("error", error),
                                        ],
                                    );
                                }
                            });
                        }
                        Err(error) => {
                            emit_log(
                                "ERROR",
                                "listener_accept_failed",
                                &[("error", error.to_string())],
                            );
                            continue;
                        }
                    }
                }
            }
        }
    });

    Ok(StartedProxyServer {
        bound_port,
        server_handle: ProxyServerHandle {
            shutdown_sender: Some(shutdown_sender),
            join_handle,
        },
        session_receiver,
        ws_message_receiver,
    })
}

fn format_listener_bind_error(bind_addr: &str, port: u16, error: &std::io::Error) -> String {
    if error.kind() == std::io::ErrorKind::AddrInUse {
        return serde_json::json!({
            "code": "PORT_IN_USE",
            "message": format!("Port {port} is already in use."),
            "details": {
                "host": bind_addr,
                "port": port,
            }
        })
        .to_string();
    }

    format!("failed to bind proxy listener on {bind_addr}:{port}: {error}")
}

#[cfg(test)]
mod tests {
    use super::format_listener_bind_error;

    #[test]
    fn serializes_port_in_use_bind_failures_as_app_errors() {
        let error = std::io::Error::new(std::io::ErrorKind::AddrInUse, "Address already in use");
        let actual = format_listener_bind_error("127.0.0.1", 8888, &error);
        let parsed: serde_json::Value = serde_json::from_str(&actual).expect("valid json");

        assert_eq!(parsed["code"], "PORT_IN_USE");
        assert_eq!(parsed["details"]["port"], 8888);
        assert_eq!(parsed["details"]["host"], "127.0.0.1");
    }
}

#[allow(clippy::too_many_arguments)]
async fn handle_connection(
    mut stream: TcpStream,
    client_addr: SocketAddr,
    client: Arc<Client>,
    session_sender: mpsc::Sender<ProxySessionDetail>,
    ws_message_sender: mpsc::Sender<crate::ws::WsMessageData>,
    tls_manager: Option<Arc<TlsManager>>,
    breakpoint_manager: Option<Arc<BreakpointManager>>,
    rewrite_manager: Option<Arc<RewriteManager>>,
    map_manager: Option<Arc<MapManager>>,
    script_manager: Option<Arc<ScriptManager>>,
    throttle_manager: Option<Arc<ThrottleManager>>,
    dns_manager: Option<Arc<DnsManager>>,
    workspace_id: Option<String>,
    event_emitter: Option<BreakpointEventEmitter>,
) -> Result<(), String> {
    let started_at = Utc::now();
    let started_at_instant = Instant::now();

    let mut request = match read_proxy_request(&mut stream).await {
        Ok(request) => request,
        Err(error) => {
            write_plain_text_response(
                &mut stream,
                StatusCode::BAD_REQUEST,
                "Unable to parse the HTTP proxy request.",
            )
            .await?;

            emit_log(
                "WARN",
                "request_parse_failed",
                &[("client_addr", client_addr.to_string()), ("error", error)],
            );

            return Ok(());
        }
    };
    request.client_address = Some(client_addr.to_string());

    // Serve root CA certificate for mobile device download.
    // Mobile browsers hit http://<local-ip>:<port>/aiproxy-ca.crt directly (no proxy config yet).
    if request.method == Method::GET
        && (request.path == "/aiproxy-ca.crt" || request.path == "/aiproxy-ca.pem")
    {
        if let Some(ref mgr) = tls_manager {
            let cert_pem = mgr.root_ca.cert_pem();
            emit_log(
                "INFO",
                "cert_served",
                &[
                    ("client_addr", client_addr.to_string()),
                    ("path", request.path.clone()),
                ],
            );

            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/x-x509-ca-cert\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                cert_pem.len(),
                cert_pem
            );
            stream
                .write_all(response.as_bytes())
                .await
                .map_err(|e| format!("cert write: {e}"))?;
            let _ = stream.shutdown().await;
            return Ok(());
        } else {
            write_plain_text_response(
                &mut stream,
                StatusCode::NOT_FOUND,
                "No root certificate available. Enable SSL and generate a certificate first.",
            )
            .await?;
            return Ok(());
        }
    }

    let active_workspace_id = workspace_id.unwrap_or_else(|| "default".to_string());

    if request.method == Method::CONNECT {
        let host = request.host.clone();
        let port: u16 = request.path.parse().unwrap_or(DEFAULT_HTTPS_PORT);

        emit_log(
            "DEBUG",
            "connect_received",
            &[
                ("request_id", request.request_id.clone()),
                ("client_addr", client_addr.to_string()),
                ("host", host.clone()),
                ("port", port.to_string()),
                (
                    "ssl_interception_enabled",
                    tls_manager.is_some().to_string(),
                ),
            ],
        );

        match tls_manager {
            None => {
                emit_log(
                    "WARN",
                    "connect_tunneling_without_mitm",
                    &[
                        ("request_id", request.request_id.clone()),
                        ("client_addr", client_addr.to_string()),
                        ("host", host.clone()),
                        ("port", port.to_string()),
                    ],
                );

                // No TLS manager — blind tunnel (no decryption)
                return tunnel_blind_relay(stream, &host, port, &dns_manager, &active_workspace_id)
                    .await;
            }
            Some(mgr) => {
                emit_log(
                    "DEBUG",
                    "connect_mitm_started",
                    &[
                        ("request_id", request.request_id.clone()),
                        ("client_addr", client_addr.to_string()),
                        ("host", host.clone()),
                        ("port", port.to_string()),
                    ],
                );

                // MITM: TLS terminate, capture, forward
                return handle_connect_mitm(
                    stream,
                    host,
                    port,
                    mgr,
                    client,
                    client_addr,
                    session_sender,
                    ws_message_sender,
                    started_at,
                    started_at_instant,
                    breakpoint_manager,
                    rewrite_manager,
                    map_manager,
                    script_manager,
                    throttle_manager,
                    dns_manager,
                    active_workspace_id,
                    event_emitter,
                )
                .await;
            }
        }
    }

    let RequestRuntimeOutcome {
        mut local_response,
        map_traces,
        rewrite_traces,
        throttle_selection,
    } = apply_request_runtime_rules(
        &rewrite_manager,
        &map_manager,
        &throttle_manager,
        &active_workspace_id,
        &mut request,
    )?;
    let map_traces = map_traces;
    let mut rewrite_traces = rewrite_traces;
    let mut script_traces = Vec::new();
    let mut throttle_traces = Vec::new();

    if local_response.is_none() {
        let script_outcome =
            apply_request_script_rules(&script_manager, &active_workspace_id, &mut request);
        local_response = script_outcome.local_response;
        script_traces.extend(script_outcome.traces);
    }

    // --- Request-stage breakpoint ---
    if let Some(resolution) =
        intercept_request_stage(&breakpoint_manager, &event_emitter, &mut request).await?
    {
        match resolution.action {
            BreakpointActionKind::Drop => {
                let _ = stream.shutdown().await;
                return Ok(());
            }
            BreakpointActionKind::Mock => {
                if let Some(ref mock) = resolution.mock {
                    if let Some(selection) = throttle_selection
                        .as_ref()
                        .filter(|selection| throttle_selection_matches_stage(selection, "request"))
                    {
                        match apply_request_throttle(selection, request.body.len()).await {
                            Ok(trace) => {
                                if let Some(manager) = throttle_manager.as_ref() {
                                    manager.record_trace(&trace);
                                }
                                throttle_traces.push(trace);
                            }
                            Err(failure) => {
                                if let Some(manager) = throttle_manager.as_ref() {
                                    manager.record_trace(&failure.trace);
                                }
                                throttle_traces.push(failure.trace);
                                return respond_with_throttle_failure(
                                    &mut stream,
                                    &request,
                                    &session_sender,
                                    started_at,
                                    started_at_instant,
                                    None,
                                    &failure.error,
                                    map_traces.clone(),
                                    throttle_traces,
                                )
                                .await;
                            }
                        }
                    }

                    let mut mock_response = build_mock_upstream_response(mock);
                    rewrite_traces.extend(apply_response_rewrite_rules(
                        &rewrite_manager,
                        &active_workspace_id,
                        &request,
                        &mut mock_response,
                    )?);
                    script_traces.extend(apply_response_script_rules(
                        &script_manager,
                        &active_workspace_id,
                        &request,
                        &mut mock_response,
                    ));

                    if let Some(selection) = throttle_selection
                        .as_ref()
                        .filter(|selection| throttle_selection_matches_stage(selection, "response"))
                    {
                        let trace =
                            apply_response_throttle(selection, mock_response.response_body.len())
                                .await;
                        if let Some(manager) = throttle_manager.as_ref() {
                            manager.record_trace(&trace);
                        }
                        throttle_traces.push(trace);
                    }

                    write_upstream_response(
                        &mut stream,
                        mock_response.status_code,
                        &mock_response.response_headers,
                        &mock_response.response_body,
                    )
                    .await?;

                    let mut detail = build_session_detail(
                        &request,
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
                    detail.map_traces = map_traces;
                    detail.rewrite_traces = rewrite_traces;
                    detail.script_traces = script_traces;
                    detail.throttle_traces = throttle_traces;
                    if session_sender.send(detail).await.is_err() {
                        emit_log(
                            "DEBUG",
                            "session_send_dropped",
                            &[("reason", "receiver_disconnected".to_string())],
                        );
                    }
                    return Ok(());
                }
            }
            BreakpointActionKind::Forward => {
                // Modifications already applied inside intercept_request_stage
            }
        }
    }

    let mut pending_detail = build_pending_session_detail(&request, started_at);
    pending_detail.map_traces = map_traces.clone();
    if session_sender.send(pending_detail).await.is_err() {
        emit_log(
            "DEBUG",
            "session_send_dropped",
            &[("reason", "receiver_disconnected".to_string())],
        );
    }

    if let Some(selection) = throttle_selection
        .as_ref()
        .filter(|selection| throttle_selection_matches_stage(selection, "request"))
    {
        match apply_request_throttle(selection, request.body.len()).await {
            Ok(trace) => {
                if let Some(manager) = throttle_manager.as_ref() {
                    manager.record_trace(&trace);
                }
                throttle_traces.push(trace);
            }
            Err(failure) => {
                if let Some(manager) = throttle_manager.as_ref() {
                    manager.record_trace(&failure.trace);
                }
                throttle_traces.push(failure.trace);
                return respond_with_throttle_failure(
                    &mut stream,
                    &request,
                    &session_sender,
                    started_at,
                    started_at_instant,
                    None,
                    &failure.error,
                    map_traces.clone(),
                    throttle_traces,
                )
                .await;
            }
        }
    }

    let upstream_result = match local_response {
        Some(local_response) => Ok(local_response),
        None => {
            // WebSocket upgrade requests must bypass reqwest (which can't handle 101 protocol switch).
            let is_ws = request.headers.iter().any(|(name, value)| {
                name.as_str().eq_ignore_ascii_case("upgrade")
                    && value.as_bytes().eq_ignore_ascii_case(b"websocket")
            });
            if is_ws {
                emit_log(
                    "INFO",
                    "ws_http_upgrade_detected",
                    &[
                        ("request_id", request.request_id.clone()),
                        ("host", request.host.clone()),
                        ("url", request.url.to_string()),
                        ("method", request.method.to_string()),
                    ],
                );
                handle_http_websocket_upgrade(
                    &mut stream,
                    &request,
                    &session_sender,
                    &ws_message_sender,
                    started_at,
                    started_at_instant,
                    &dns_manager,
                    &active_workspace_id,
                )
                .await?;
                return Ok(());
            }
            forward_request(&client, &request, &dns_manager, &active_workspace_id).await
        }
    };

    match upstream_result {
        Ok(mut upstream_response) => {
            if upstream_response.body_truncated {
                emit_log(
                    "WARN",
                    "response_body_passthrough_mode",
                    &[
                        ("request_id", request.request_id.clone()),
                        ("url", request.url.to_string()),
                        (
                            "reason",
                            "response body exceeded capture limit; skipping response mutations"
                                .to_string(),
                        ),
                    ],
                );
            } else {
                rewrite_traces.extend(apply_response_rewrite_rules(
                    &rewrite_manager,
                    &active_workspace_id,
                    &request,
                    &mut upstream_response,
                )?);
                script_traces.extend(apply_response_script_rules(
                    &script_manager,
                    &active_workspace_id,
                    &request,
                    &mut upstream_response,
                ));
            }

            // Build session detail once; rebuild only if Mock/Forward modifies the response.
            let mut session_detail = build_session_detail(
                &request,
                upstream_response.status_code.as_u16(),
                &upstream_response.response_headers,
                &upstream_response.response_body,
                upstream_response.response_body_size_bytes,
                started_at,
                started_at_instant,
                ProxyTimingBreakdown {
                    connect_ms: None,
                    dns_ms: None,
                    request_send_ms: None,
                    response_read_ms: Some(upstream_response.response_read_ms),
                    tls_ms: None,
                    total_ms: Some(started_at_instant.elapsed().as_millis()),
                    waiting_ms: Some(upstream_response.waiting_ms),
                },
                upstream_response.body_truncated,
            );
            session_detail.map_traces = map_traces.clone();
            session_detail.rewrite_traces = rewrite_traces.clone();
            session_detail.script_traces = script_traces.clone();
            session_detail.throttle_traces = throttle_traces.clone();

            // --- Response-stage breakpoint ---
            let breakpoint_resolution = if upstream_response.body_truncated {
                None
            } else {
                match intercept_response_stage(
                    &breakpoint_manager,
                    &event_emitter,
                    &request,
                    upstream_response.status_code.as_u16(),
                    &upstream_response.response_headers,
                    &upstream_response.response_body,
                )
                .await
                {
                    Ok(resolution) => resolution,
                    Err(error) => {
                        let _ = session_sender.send(session_detail).await;
                        return Err(error);
                    }
                }
            };

            if let Some(resolution) = breakpoint_resolution {
                match resolution.action {
                    BreakpointActionKind::Drop => {
                        let _ = session_sender.send(session_detail).await;
                        let _ = stream.shutdown().await;
                        return Ok(());
                    }
                    BreakpointActionKind::Mock => {
                        if let Some(ref mock) = resolution.mock {
                            upstream_response = build_mock_upstream_response(mock);
                            session_detail = build_session_detail(
                                &request,
                                upstream_response.status_code.as_u16(),
                                &upstream_response.response_headers,
                                &upstream_response.response_body,
                                upstream_response.response_body_size_bytes,
                                started_at,
                                started_at_instant,
                                ProxyTimingBreakdown {
                                    connect_ms: None,
                                    dns_ms: None,
                                    request_send_ms: None,
                                    response_read_ms: Some(upstream_response.response_read_ms),
                                    tls_ms: None,
                                    total_ms: Some(started_at_instant.elapsed().as_millis()),
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
                        apply_response_resolution(&resolution, &mut upstream_response);
                        if resolution.modified_response_body_base64.is_some() {
                            // Body changed — must rebuild (includes decompression).
                            session_detail = build_session_detail(
                                &request,
                                upstream_response.status_code.as_u16(),
                                &upstream_response.response_headers,
                                &upstream_response.response_body,
                                upstream_response.response_body_size_bytes,
                                started_at,
                                started_at_instant,
                                ProxyTimingBreakdown {
                                    connect_ms: None,
                                    dns_ms: None,
                                    request_send_ms: None,
                                    response_read_ms: Some(upstream_response.response_read_ms),
                                    tls_ms: None,
                                    total_ms: Some(started_at_instant.elapsed().as_millis()),
                                    waiting_ms: Some(upstream_response.waiting_ms),
                                },
                                upstream_response.body_truncated,
                            );
                            session_detail.map_traces = map_traces.clone();
                            session_detail.rewrite_traces = rewrite_traces.clone();
                            session_detail.script_traces = script_traces.clone();
                            session_detail.throttle_traces = throttle_traces.clone();
                        } else {
                            // Only headers/status may have changed — update in place, no body decompression needed.
                            if resolution.modified_response_status_code.is_some() {
                                session_detail.summary.status_code =
                                    upstream_response.status_code.as_u16();
                            }
                            if resolution.modified_response_headers.is_some() {
                                session_detail.response_headers =
                                    build_header_entries_from_map(&upstream_response.response_headers);
                                session_detail.cookies = build_cookie_entries(
                                    &request.request_headers,
                                    &session_detail.response_headers,
                                );
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

            if let Some(selection) = throttle_selection
                .as_ref()
                .filter(|selection| throttle_selection_matches_stage(selection, "response"))
            {
                let trace =
                    apply_response_throttle(selection, upstream_response.response_body_size_bytes)
                        .await;
                if let Some(manager) = throttle_manager.as_ref() {
                    manager.record_trace(&trace);
                }
                throttle_traces.push(trace);
                session_detail.throttle_traces = throttle_traces.clone();
            }

            let write_result = if let Some(spooled_response_path) =
                upstream_response.spooled_response_path.as_deref()
            {
                write_spooled_upstream_response(
                    &mut stream,
                    upstream_response.status_code,
                    &upstream_response.response_headers,
                    upstream_response.response_body_size_bytes,
                    spooled_response_path,
                )
                .await
            } else {
                write_upstream_response(
                    &mut stream,
                    upstream_response.status_code,
                    &upstream_response.response_headers,
                    &upstream_response.response_body,
                )
                .await
            };

            if let Err(error) = write_result {
                let _ = session_sender.send(session_detail).await;
                return Err(error);
            }

            session_detail.rewrite_traces = rewrite_traces;
            session_detail.script_traces = script_traces;
            session_detail.map_traces = map_traces;

            if session_sender.send(session_detail).await.is_err() {
                emit_log(
                    "DEBUG",
                    "session_send_dropped",
                    &[("reason", "receiver_disconnected".to_string())],
                );
            }

            emit_log(
                "DEBUG",
                "request_forwarded",
                &[
                    ("request_id", request.request_id.clone()),
                    ("client_addr", client_addr.to_string()),
                    ("method", request.method.to_string()),
                    (
                        "status_code",
                        upstream_response.status_code.as_u16().to_string(),
                    ),
                    ("url", request.url.to_string()),
                ],
            );

            Ok(())
        }
        Err(error) => {
            let response_message = "The proxy could not reach the upstream server.";

            write_plain_text_response(&mut stream, StatusCode::BAD_GATEWAY, response_message)
                .await?;

            let detail = build_session_detail(
                &request,
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
            if session_sender.send(detail).await.is_err() {
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
                    ("client_addr", client_addr.to_string()),
                    ("method", request.method.to_string()),
                    ("url", request.url.to_string()),
                    ("error", error.clone()),
                ],
            );

            Err(format!("upstream request failed: {error}"))
        }
    }
}
async fn forward_request(
    client: &Client,
    request: &ParsedProxyRequest,
    dns_manager: &Option<Arc<DnsManager>>,
    workspace_id: &str,
) -> Result<UpstreamResponse, String> {
    emit_log(
        "INFO",
        "upstream_request_started",
        &[
            ("request_id", request.request_id.clone()),
            ("method", request.method.to_string()),
            ("scheme", request.url.scheme().to_string()),
            ("host", request.host.clone()),
            ("url", request.url.to_string()),
        ],
    );

    let mut upstream_url = request.url.clone();
    let mut upstream_headers = request.headers.clone();

    if let Some(ip) = resolve_dns_override(dns_manager, workspace_id, &request.host) {
        emit_log(
            "INFO",
            "dns_override_applied",
            &[
                ("host", request.host.clone()),
                ("override_ip", ip.to_string()),
            ],
        );

        let port = upstream_url
            .port()
            .unwrap_or(if upstream_url.scheme() == "https" {
                443
            } else {
                80
            });
        upstream_url
            .set_host(Some(&ip.to_string()))
            .map_err(|_| format!("failed to apply DNS override host: {ip}"))?;
        upstream_url
            .set_port(Some(port))
            .map_err(|_| format!("failed to apply DNS override port: {port}"))?;
        let host_header = match request.url.port() {
            Some(port) => format!("{}:{port}", request.host),
            None => request.host.clone(),
        };
        upstream_headers.insert(
            HOST,
            HeaderValue::from_str(&host_header)
                .map_err(|error| format!("invalid DNS override Host header: {error}"))?,
        );
    }

    let mut request_builder = client
        .request(request.method.clone(), upstream_url)
        .headers(upstream_headers);

    if !request.body.is_empty() {
        request_builder = request_builder.body(request.body.clone());
    }

    let waiting_started_at = Instant::now();
    let response = request_builder.send().await.map_err(|error| {
        emit_log(
            "ERROR",
            "upstream_request_send_failed",
            &[
                ("request_id", request.request_id.clone()),
                ("method", request.method.to_string()),
                ("scheme", request.url.scheme().to_string()),
                ("host", request.host.clone()),
                ("url", request.url.to_string()),
                ("error", error.to_string()),
            ],
        );
        format!("failed to send upstream request: {error}")
    })?;
    let waiting_ms = waiting_started_at.elapsed().as_millis();
    let status_code = response.status();
    let response_headers = response.headers().clone();
    let response_read_started_at = Instant::now();
    let (response_body, response_body_size_bytes, body_truncated, spooled_response_path) =
        read_response_body_with_limit(response, &request.request_id, true)
            .await
            .map_err(|error| {
                emit_log(
                    "ERROR",
                    "upstream_response_read_failed",
                    &[
                        ("request_id", request.request_id.clone()),
                        ("method", request.method.to_string()),
                        ("scheme", request.url.scheme().to_string()),
                        ("host", request.host.clone()),
                        ("url", request.url.to_string()),
                        ("status_code", status_code.as_u16().to_string()),
                        ("error", error.clone()),
                    ],
                );
                format!("failed to read upstream response body: {error}")
            })?;
    let response_read_ms = response_read_started_at.elapsed().as_millis();

    emit_log(
        "INFO",
        "upstream_request_succeeded",
        &[
            ("request_id", request.request_id.clone()),
            ("method", request.method.to_string()),
            ("scheme", request.url.scheme().to_string()),
            ("host", request.host.clone()),
            ("url", request.url.to_string()),
            ("status_code", status_code.as_u16().to_string()),
            ("waiting_ms", waiting_ms.to_string()),
            ("response_read_ms", response_read_ms.to_string()),
        ],
    );

    Ok(UpstreamResponse {
        body_truncated,
        response_body,
        response_body_size_bytes,
        response_headers,
        response_read_ms,
        spooled_response_path,
        status_code,
        waiting_ms,
    })
}

async fn read_response_body_with_limit(
    mut response: reqwest::Response,
    request_id: &str,
    preserve_full_body: bool,
) -> Result<(Vec<u8>, usize, bool, Option<PathBuf>), String> {
    let mut response_body = Vec::new();
    let mut response_body_size_bytes = 0usize;
    let mut body_truncated = false;
    let mut spooled_response_path = None;
    let mut spooled_file: Option<tokio::fs::File> = None;

    if let Some(content_length) = response.content_length() {
        response_body.reserve((content_length as usize).min(MAX_CAPTURED_BODY_BYTES));
    }

    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|error| format!("read response chunk: {error}"))?
    {
        if preserve_full_body {
            if body_truncated {
                if let Some(file) = spooled_file.as_mut() {
                    file.write_all(&chunk)
                        .await
                        .map_err(|error| format!("write spooled response chunk: {error}"))?;
                }
            } else if response_body_size_bytes + chunk.len() > MAX_CAPTURED_BODY_BYTES {
                let (mut file, path) = create_response_spool_file(request_id).await?;
                if !response_body.is_empty() {
                    file.write_all(&response_body)
                        .await
                        .map_err(|error| format!("seed spooled response body: {error}"))?;
                }
                file.write_all(&chunk)
                    .await
                    .map_err(|error| format!("write spooled response chunk: {error}"))?;
                spooled_response_path = Some(path);
                spooled_file = Some(file);
                body_truncated = true;
            }
        } else if !body_truncated
            && response_body_size_bytes + chunk.len() > MAX_CAPTURED_BODY_BYTES
        {
            body_truncated = true;
        }

        response_body_size_bytes += chunk.len();

        if response_body.len() < MAX_CAPTURED_BODY_BYTES {
            let remaining = MAX_CAPTURED_BODY_BYTES - response_body.len();
            response_body.extend_from_slice(&chunk[..remaining.min(chunk.len())]);
        }
    }

    if let Some(file) = spooled_file.as_mut() {
        file.flush()
            .await
            .map_err(|error| format!("flush spooled response body: {error}"))?;
    }

    if body_truncated {
        emit_log(
            "WARN",
            "response_body_truncated",
            &[
                ("request_id", request_id.to_string()),
                ("original_size", response_body_size_bytes.to_string()),
                ("captured_size", MAX_CAPTURED_BODY_BYTES.to_string()),
                ("spooled", preserve_full_body.to_string()),
            ],
        );
    }

    Ok((
        response_body,
        response_body_size_bytes,
        body_truncated,
        spooled_response_path,
    ))
}

async fn create_response_spool_file(
    request_id: &str,
) -> Result<(tokio::fs::File, PathBuf), String> {
    let dir = env::temp_dir().join("aiproxy-response-spool");
    tokio::fs::create_dir_all(&dir).await.map_err(|error| {
        format!(
            "create response spool directory '{}': {error}",
            dir.display()
        )
    })?;

    let path = dir.join(format!("{request_id}-{}.body", Uuid::new_v4()));
    let file = tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&path)
        .await
        .map_err(|error| format!("create spooled response file '{}': {error}", path.display()))?;

    Ok((file, path))
}

async fn write_spooled_upstream_response<S: AsyncReadExt + AsyncWriteExt + Unpin>(
    stream: &mut S,
    status_code: StatusCode,
    headers: &HeaderMap,
    body_size_bytes: usize,
    spooled_response_path: &Path,
) -> Result<(), String> {
    let reason = status_code.canonical_reason().unwrap_or("Unknown");
    let mut response = format!("HTTP/1.1 {} {reason}\r\n", status_code.as_u16());

    for (header_name, header_value) in headers {
        if should_skip_response_header(header_name) {
            continue;
        }

        let header_value = header_value
            .to_str()
            .map_err(|error| format!("response header value is not valid UTF-8: {error}"))?;

        response.push_str(header_name.as_str());
        response.push_str(": ");
        response.push_str(header_value);
        response.push_str("\r\n");
    }

    response.push_str(&format!("Content-Length: {body_size_bytes}\r\n"));
    response.push_str("Connection: close\r\n\r\n");

    stream
        .write_all(response.as_bytes())
        .await
        .map_err(map_io_error)?;

    let mut file = tokio::fs::File::open(spooled_response_path)
        .await
        .map_err(|error| {
            format!(
                "open spooled response file '{}': {error}",
                spooled_response_path.display()
            )
        })?;
    let mut buffer = vec![0_u8; 64 * 1024];

    loop {
        let bytes_read = file
            .read(&mut buffer)
            .await
            .map_err(|error| format!("read spooled response file: {error}"))?;

        if bytes_read == 0 {
            break;
        }

        stream
            .write_all(&buffer[..bytes_read])
            .await
            .map_err(map_io_error)?;
    }

    stream.flush().await.map_err(map_io_error)?;

    Ok(())
}

/// Blind TCP relay for CONNECT when SSL interception is disabled.
async fn tunnel_blind_relay(
    mut client_stream: TcpStream,
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
            emit_log(
                "INFO",
                "dns_override_applied",
                &[("host", host.to_string()), ("override_ip", ip.to_string())],
            );
            ip.to_string()
        }
        None => host.to_string(),
    };
    let mut upstream = TcpStream::connect((&*connect_host, port))
        .await
        .map_err(|e| format!("failed to connect to upstream {host}:{port}: {e}"))?;

    // Bidirectional copy
    let (mut cr, mut cw) = client_stream.split();
    let (mut ur, mut uw) = upstream.split();

    let client_to_upstream = tokio::io::copy(&mut cr, &mut uw);
    let upstream_to_client = tokio::io::copy(&mut ur, &mut cw);

    tokio::select! {
        r = client_to_upstream => {
            if let Err(e) = r {
                emit_log("WARN", "tunnel_client_to_upstream_error", &[("error", e.to_string())]);
            }
        }
        r = upstream_to_client => {
            if let Err(e) = r {
                emit_log("WARN", "tunnel_upstream_to_client_error", &[("error", e.to_string())]);
            }
        }
    }

    Ok(())
}

fn build_dangerous_client_tls_config() -> Arc<tokio_rustls::rustls::ClientConfig> {
    static CONFIG: OnceLock<Arc<tokio_rustls::rustls::ClientConfig>> = OnceLock::new();

    use tokio_rustls::rustls::client::danger::{
        HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier,
    };
    use tokio_rustls::rustls::crypto::CryptoProvider;
    use tokio_rustls::rustls::pki_types::{CertificateDer, ServerName, UnixTime};
    use tokio_rustls::rustls::DigitallySignedStruct;

    #[derive(Debug)]
    struct NoVerifier;

    impl ServerCertVerifier for NoVerifier {
        fn verify_server_cert(
            &self,
            _end_entity: &CertificateDer<'_>,
            _intermediates: &[CertificateDer<'_>],
            _server_name: &ServerName<'_>,
            _ocsp_response: &[u8],
            _now: UnixTime,
        ) -> Result<ServerCertVerified, tokio_rustls::rustls::Error> {
            Ok(ServerCertVerified::assertion())
        }

        fn verify_tls12_signature(
            &self,
            _message: &[u8],
            _cert: &CertificateDer<'_>,
            _dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, tokio_rustls::rustls::Error> {
            Ok(HandshakeSignatureValid::assertion())
        }

        fn verify_tls13_signature(
            &self,
            _message: &[u8],
            _cert: &CertificateDer<'_>,
            _dss: &DigitallySignedStruct,
        ) -> Result<HandshakeSignatureValid, tokio_rustls::rustls::Error> {
            Ok(HandshakeSignatureValid::assertion())
        }

        fn supported_verify_schemes(&self) -> Vec<tokio_rustls::rustls::SignatureScheme> {
            CryptoProvider::get_default()
                .map(|p| p.signature_verification_algorithms.supported_schemes())
                .unwrap_or_default()
        }
    }

    Arc::clone(CONFIG.get_or_init(|| {
        Arc::new(
            tokio_rustls::rustls::ClientConfig::builder()
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(NoVerifier))
                .with_no_client_auth(),
        )
    }))
}

/// Handle WebSocket upgrade for plain HTTP (ws://) connections.
/// Opens a raw TCP connection to upstream, sends the upgrade request, reads the 101 response,
/// writes it back to the client, then enters bidirectional frame relay.
async fn handle_http_websocket_upgrade<S: AsyncReadExt + AsyncWriteExt + Unpin>(
    client_stream: &mut S,
    request: &ParsedProxyRequest,
    session_sender: &mpsc::Sender<ProxySessionDetail>,
    ws_message_sender: &mpsc::Sender<crate::ws::WsMessageData>,
    started_at: DateTime<Utc>,
    started_at_instant: Instant,
    dns_manager: &Option<Arc<DnsManager>>,
    workspace_id: &str,
) -> Result<(), String> {
    let port = request.url.port().unwrap_or(80);
    let connect_host = match resolve_dns_override(dns_manager, workspace_id, &request.host) {
        Some(ip) => {
            emit_log(
                "INFO",
                "dns_override_ws_http",
                &[
                    ("host", request.host.clone()),
                    ("override_ip", ip.to_string()),
                ],
            );
            ip.to_string()
        }
        None => request.host.clone(),
    };
    let host_port = format!("{}:{}", request.host, port);
    let connect_host_port = format!("{}:{}", connect_host, port);

    emit_log(
        "DEBUG",
        "ws_http_connecting_upstream",
        &[
            ("request_id", request.request_id.clone()),
            ("host_port", host_port.clone()),
        ],
    );

    let mut upstream = TcpStream::connect(&*connect_host_port).await.map_err(|e| {
        emit_log(
            "ERROR",
            "ws_http_upstream_connect_failed",
            &[
                ("request_id", request.request_id.clone()),
                ("host_port", host_port.clone()),
                ("error", e.to_string()),
            ],
        );
        format!("ws upstream connect: {e}")
    })?;

    emit_log(
        "DEBUG",
        "ws_http_upstream_connected",
        &[("request_id", request.request_id.clone())],
    );

    let raw_req = build_raw_upgrade_request(request)?;
    emit_log(
        "DEBUG",
        "ws_http_sending_upgrade",
        &[
            ("request_id", request.request_id.clone()),
            ("raw_req_len", raw_req.len().to_string()),
        ],
    );
    emit_log(
        "DEBUG",
        "ws_http_raw_request",
        &[
            ("request_id", request.request_id.clone()),
            ("raw_req", raw_req.clone()),
        ],
    );

    upstream.write_all(raw_req.as_bytes()).await.map_err(|e| {
        emit_log(
            "ERROR",
            "ws_http_upgrade_send_failed",
            &[
                ("request_id", request.request_id.clone()),
                ("error", e.to_string()),
            ],
        );
        format!("ws upgrade send: {e}")
    })?;

    // Read the upstream 101 response and relay it to the client
    let (response_head, response_prefix) =
        read_http_response_head(&mut upstream).await.map_err(|e| {
            emit_log(
                "ERROR",
                "ws_http_read_response_head_failed",
                &[
                    ("request_id", request.request_id.clone()),
                    ("error", e.clone()),
                ],
            );
            e
        })?;

    emit_log(
        "DEBUG",
        "ws_http_got_response_head",
        &[
            ("request_id", request.request_id.clone()),
            ("response_head", response_head.clone()),
        ],
    );

    // Parse status code from the response
    let status_line = response_head.lines().next().unwrap_or("");
    let status_code: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|v| v.parse().ok())
        .unwrap_or(502);

    emit_log(
        "INFO",
        "ws_http_upstream_status",
        &[
            ("request_id", request.request_id.clone()),
            ("status_code", status_code.to_string()),
        ],
    );

    // Write the response head back to the client
    client_stream
        .write_all(response_head.as_bytes())
        .await
        .map_err(|e| {
            emit_log(
                "ERROR",
                "ws_http_write_to_client_failed",
                &[
                    ("request_id", request.request_id.clone()),
                    ("error", e.to_string()),
                ],
            );
            format!("ws response write to client: {e}")
        })?;
    client_stream
        .flush()
        .await
        .map_err(|e| format!("ws flush: {e}"))?;

    emit_log(
        "INFO",
        "ws_http_entering_relay",
        &[
            ("request_id", request.request_id.clone()),
            ("session_id", request.request_id.clone()),
        ],
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
            tls_ms: None,
            total_ms: Some(started_at_instant.elapsed().as_millis()),
            waiting_ms: Some(0),
        },
        false,
    );
    detail.summary.protocol = "ws".to_string();
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

/// Handle WebSocket upgrade for HTTPS (wss://) connections via MITM.
/// Opens a raw TLS connection to upstream, sends the upgrade request, reads the 101 response,
/// writes it back to the client, then enters bidirectional frame relay.
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
            emit_log(
                "INFO",
                "dns_override_wss",
                &[
                    ("host", request.host.clone()),
                    ("override_ip", ip.to_string()),
                ],
            );
            ip.to_string()
        }
        None => request.host.clone(),
    };
    let connect_host_port = format!("{}:{}", connect_host, port);

    emit_log(
        "DEBUG",
        "wss_connecting_upstream",
        &[
            ("request_id", request.request_id.clone()),
            ("host_port", host_port.clone()),
        ],
    );

    let ws_tcp = TcpStream::connect(&*connect_host_port).await.map_err(|e| {
        emit_log(
            "ERROR",
            "wss_upstream_connect_failed",
            &[
                ("request_id", request.request_id.clone()),
                ("host_port", host_port.clone()),
                ("error", e.to_string()),
            ],
        );
        format!("wss upstream connect: {e}")
    })?;

    emit_log(
        "DEBUG",
        "wss_tcp_connected",
        &[("request_id", request.request_id.clone())],
    );

    let client_config = build_dangerous_client_tls_config();
    let tls_connector = tokio_rustls::TlsConnector::from(client_config);
    let ws_host = request.host.clone();
    let dns_name = tokio_rustls::rustls::pki_types::ServerName::try_from(ws_host.clone())
        .unwrap_or_else(|_| {
            tokio_rustls::rustls::pki_types::ServerName::IpAddress(
                std::net::Ipv4Addr::LOCALHOST.into(),
            )
        });

    emit_log(
        "DEBUG",
        "wss_starting_tls_handshake",
        &[
            ("request_id", request.request_id.clone()),
            ("ws_host", ws_host.clone()),
        ],
    );

    let mut upstream = tls_connector.connect(dns_name, ws_tcp).await.map_err(|e| {
        emit_log(
            "ERROR",
            "wss_tls_handshake_failed",
            &[
                ("request_id", request.request_id.clone()),
                ("ws_host", ws_host.clone()),
                ("error", e.to_string()),
            ],
        );
        format!("wss upstream tls handshake: {e}")
    })?;

    emit_log(
        "DEBUG",
        "wss_tls_connected",
        &[("request_id", request.request_id.clone())],
    );

    let raw_req = build_raw_upgrade_request(request)?;
    emit_log(
        "DEBUG",
        "wss_sending_upgrade",
        &[
            ("request_id", request.request_id.clone()),
            ("raw_req_len", raw_req.len().to_string()),
        ],
    );
    emit_log(
        "DEBUG",
        "wss_raw_request",
        &[
            ("request_id", request.request_id.clone()),
            ("raw_req", raw_req.clone()),
        ],
    );

    upstream.write_all(raw_req.as_bytes()).await.map_err(|e| {
        emit_log(
            "ERROR",
            "wss_upgrade_send_failed",
            &[
                ("request_id", request.request_id.clone()),
                ("error", e.to_string()),
            ],
        );
        format!("wss upgrade send: {e}")
    })?;

    // Read the upstream 101 response and relay it to the client
    let (response_head, response_prefix) =
        read_http_response_head(&mut upstream).await.map_err(|e| {
            emit_log(
                "ERROR",
                "wss_read_response_head_failed",
                &[
                    ("request_id", request.request_id.clone()),
                    ("error", e.clone()),
                ],
            );
            e
        })?;

    emit_log(
        "DEBUG",
        "wss_got_response_head",
        &[
            ("request_id", request.request_id.clone()),
            ("response_head", response_head.clone()),
        ],
    );

    let status_line = response_head.lines().next().unwrap_or("");
    let status_code: u16 = status_line
        .split_whitespace()
        .nth(1)
        .and_then(|v| v.parse().ok())
        .unwrap_or(502);

    emit_log(
        "INFO",
        "wss_upstream_status",
        &[
            ("request_id", request.request_id.clone()),
            ("status_code", status_code.to_string()),
        ],
    );

    client_stream
        .write_all(response_head.as_bytes())
        .await
        .map_err(|e| {
            emit_log(
                "ERROR",
                "wss_write_to_client_failed",
                &[
                    ("request_id", request.request_id.clone()),
                    ("error", e.to_string()),
                ],
            );
            format!("wss response write to client: {e}")
        })?;
    client_stream
        .flush()
        .await
        .map_err(|e| format!("wss flush: {e}"))?;

    emit_log(
        "INFO",
        "wss_entering_relay",
        &[
            ("request_id", request.request_id.clone()),
            ("session_id", request.request_id.clone()),
        ],
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
async fn read_http_response_head<R: AsyncReadExt + Unpin>(
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
#[allow(clippy::too_many_arguments)]
async fn handle_connect_mitm(
    mut stream: TcpStream,
    host: String,
    port: u16,
    tls_manager: Arc<TlsManager>,
    client: Arc<Client>,
    client_addr: SocketAddr,
    session_sender: mpsc::Sender<ProxySessionDetail>,
    ws_message_sender: mpsc::Sender<crate::ws::WsMessageData>,
    started_at: DateTime<Utc>,
    started_at_instant: Instant,
    breakpoint_manager: Option<Arc<BreakpointManager>>,
    rewrite_manager: Option<Arc<RewriteManager>>,
    map_manager: Option<Arc<MapManager>>,
    script_manager: Option<Arc<ScriptManager>>,
    throttle_manager: Option<Arc<ThrottleManager>>,
    dns_manager: Option<Arc<DnsManager>>,
    workspace_id: String,
    event_emitter: Option<BreakpointEventEmitter>,
) -> Result<(), String> {
    // Send 200 Connection Established
    stream
        .write_all(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        .await
        .map_err(map_io_error)?;

    let tls_acceptor = tokio_rustls::TlsAcceptor::from(tls_manager.server_config.clone());
    let tls_instant = Instant::now();
    let tls_stream = match tls_acceptor.accept(stream).await {
        Ok(stream) => stream,
        Err(error) => {
            emit_log(
                "WARN",
                "tls_handshake_failed",
                &[
                    ("host", host.clone()),
                    ("port", port.to_string()),
                    ("error", error.to_string()),
                ],
            );
            return Err(format!("TLS handshake failed for {host}:{port}: {error}"));
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

    emit_log(
        "DEBUG",
        "tls_handshake_succeeded",
        &[("host", host.clone()), ("port", port.to_string())],
    );

    let mut tls_stream = tls_stream;

    // Read the decrypted HTTP request from the TLS stream
    let mut request = match read_proxy_request_from_stream(&mut tls_stream).await {
        Ok(r) => r,
        Err(error) => {
            emit_log(
                "WARN",
                "tls_request_parse_failed",
                &[("host", host.clone()), ("error", error)],
            );
            return Ok(());
        }
    };
    request.client_address = Some(client_addr.to_string());
    request.tls_cipher_suite = tls_cipher_suite;
    request.tls_protocol = tls_protocol;

    // Rewrite URL to https://
    let https_url = if request.url.scheme() == "http" {
        let mut https = format!("https://{host}:{port}");
        if !request.path.is_empty() && request.path != "/" {
            https.push_str(&request.path);
        } else {
            https.push('/');
        }
        https
    } else {
        request.url.to_string()
    };

    // Build a modified request for HTTPS upstream
    let mut https_request = ParsedProxyRequest {
        protocol: "https".to_string(),
        url: Url::parse(&https_url).map_err(|e| format!("invalid https URL {https_url}: {e}"))?,
        ..request
    };

    let RequestRuntimeOutcome {
        mut local_response,
        map_traces,
        rewrite_traces,
        throttle_selection,
    } = apply_request_runtime_rules(
        &rewrite_manager,
        &map_manager,
        &throttle_manager,
        &workspace_id,
        &mut https_request,
    )?;
    let map_traces = map_traces;
    let mut rewrite_traces = rewrite_traces;
    let mut script_traces = Vec::new();
    let mut throttle_traces = Vec::new();

    if local_response.is_none() {
        let script_outcome =
            apply_request_script_rules(&script_manager, &workspace_id, &mut https_request);
        local_response = script_outcome.local_response;
        script_traces.extend(script_outcome.traces);
    }

    // --- Request-stage breakpoint (HTTPS) ---
    if let Some(resolution) =
        intercept_request_stage(&breakpoint_manager, &event_emitter, &mut https_request).await?
    {
        match resolution.action {
            BreakpointActionKind::Drop => {
                let _ = tls_stream.shutdown().await;
                return Ok(());
            }
            BreakpointActionKind::Mock => {
                if let Some(ref mock) = resolution.mock {
                    if let Some(selection) = throttle_selection
                        .as_ref()
                        .filter(|selection| throttle_selection_matches_stage(selection, "request"))
                    {
                        match apply_request_throttle(selection, https_request.body.len()).await {
                            Ok(trace) => {
                                if let Some(manager) = throttle_manager.as_ref() {
                                    manager.record_trace(&trace);
                                }
                                throttle_traces.push(trace);
                            }
                            Err(failure) => {
                                if let Some(manager) = throttle_manager.as_ref() {
                                    manager.record_trace(&failure.trace);
                                }
                                throttle_traces.push(failure.trace);
                                return respond_with_throttle_failure(
                                    &mut tls_stream,
                                    &https_request,
                                    &session_sender,
                                    started_at,
                                    started_at_instant,
                                    Some(tls_ms),
                                    &failure.error,
                                    map_traces.clone(),
                                    throttle_traces,
                                )
                                .await;
                            }
                        }
                    }

                    let mut mock_response = build_mock_upstream_response(mock);
                    rewrite_traces.extend(apply_response_rewrite_rules(
                        &rewrite_manager,
                        &workspace_id,
                        &https_request,
                        &mut mock_response,
                    )?);
                    script_traces.extend(apply_response_script_rules(
                        &script_manager,
                        &workspace_id,
                        &https_request,
                        &mut mock_response,
                    ));

                    if let Some(selection) = throttle_selection
                        .as_ref()
                        .filter(|selection| throttle_selection_matches_stage(selection, "response"))
                    {
                        let trace =
                            apply_response_throttle(selection, mock_response.response_body.len())
                                .await;
                        if let Some(manager) = throttle_manager.as_ref() {
                            manager.record_trace(&trace);
                        }
                        throttle_traces.push(trace);
                    }

                    write_upstream_response(
                        &mut tls_stream,
                        mock_response.status_code,
                        &mock_response.response_headers,
                        &mock_response.response_body,
                    )
                    .await?;

                    let mut detail = build_session_detail(
                        &https_request,
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
                            tls_ms: Some(tls_ms),
                            total_ms: Some(started_at_instant.elapsed().as_millis()),
                            waiting_ms: Some(0),
                        },
                        mock_response.body_truncated,
                    );
                    detail.map_traces = map_traces;
                    detail.rewrite_traces = rewrite_traces;
                    detail.script_traces = script_traces;
                    detail.throttle_traces = throttle_traces;
                    if session_sender.send(detail).await.is_err() {
                        emit_log(
                            "DEBUG",
                            "session_send_dropped",
                            &[("reason", "receiver_disconnected".to_string())],
                        );
                    }
                    return Ok(());
                }
            }
            BreakpointActionKind::Forward => {}
        }
    }

    let mut pending_detail = build_pending_session_detail(&https_request, started_at);
    pending_detail.map_traces = map_traces.clone();
    let _ = session_sender.send(pending_detail).await;

    if let Some(selection) = throttle_selection
        .as_ref()
        .filter(|selection| throttle_selection_matches_stage(selection, "request"))
    {
        match apply_request_throttle(selection, https_request.body.len()).await {
            Ok(trace) => {
                if let Some(manager) = throttle_manager.as_ref() {
                    manager.record_trace(&trace);
                }
                throttle_traces.push(trace);
            }
            Err(failure) => {
                if let Some(manager) = throttle_manager.as_ref() {
                    manager.record_trace(&failure.trace);
                }
                throttle_traces.push(failure.trace);
                return respond_with_throttle_failure(
                    &mut tls_stream,
                    &https_request,
                    &session_sender,
                    started_at,
                    started_at_instant,
                    Some(tls_ms),
                    &failure.error,
                    map_traces.clone(),
                    throttle_traces,
                )
                .await;
            }
        }
    }

    let upstream_result = match local_response {
        Some(local_response) => Ok(local_response),
        None => {
            // WebSocket upgrade requests must bypass reqwest (which can't handle 101 protocol switch).
            let is_ws = https_request.headers.iter().any(|(name, value)| {
                name.as_str().eq_ignore_ascii_case("upgrade")
                    && value.as_bytes().eq_ignore_ascii_case(b"websocket")
            });
            if is_ws {
                handle_https_websocket_upgrade(
                    &mut tls_stream,
                    &https_request,
                    &session_sender,
                    &ws_message_sender,
                    started_at,
                    started_at_instant,
                    tls_ms,
                    &dns_manager,
                    &workspace_id,
                )
                .await?;
                return Ok(());
            }
            forward_request(&client, &https_request, &dns_manager, &workspace_id).await
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
                    &rewrite_manager,
                    &workspace_id,
                    &https_request,
                    &mut upstream_response,
                )?);
                script_traces.extend(apply_response_script_rules(
                    &script_manager,
                    &workspace_id,
                    &https_request,
                    &mut upstream_response,
                ));
            }

            // Build session detail once; rebuild only if Mock/Forward modifies the response.
            let mut session_detail = build_session_detail(
                &https_request,
                upstream_response.status_code.as_u16(),
                &upstream_response.response_headers,
                &upstream_response.response_body,
                upstream_response.response_body_size_bytes,
                started_at,
                started_at_instant,
                ProxyTimingBreakdown {
                    connect_ms: None,
                    dns_ms: None,
                    request_send_ms: None,
                    response_read_ms: Some(upstream_response.response_read_ms),
                    tls_ms: Some(tls_ms),
                    total_ms: Some(started_at_instant.elapsed().as_millis()),
                    waiting_ms: Some(upstream_response.waiting_ms),
                },
                upstream_response.body_truncated,
            );
            session_detail.map_traces = map_traces.clone();
            session_detail.rewrite_traces = rewrite_traces.clone();
            session_detail.script_traces = script_traces.clone();
            session_detail.throttle_traces = throttle_traces.clone();

            // --- Response-stage breakpoint (HTTPS) ---
            let breakpoint_resolution = if upstream_response.body_truncated {
                None
            } else {
                match intercept_response_stage(
                    &breakpoint_manager,
                    &event_emitter,
                    &https_request,
                    upstream_response.status_code.as_u16(),
                    &upstream_response.response_headers,
                    &upstream_response.response_body,
                )
                .await
                {
                    Ok(resolution) => resolution,
                    Err(error) => {
                        let _ = session_sender.send(session_detail).await;
                        return Err(error);
                    }
                }
            };

            if let Some(resolution) = breakpoint_resolution {
                match resolution.action {
                    BreakpointActionKind::Drop => {
                        let _ = session_sender.send(session_detail).await;
                        let _ = tls_stream.shutdown().await;
                        return Ok(());
                    }
                    BreakpointActionKind::Mock => {
                        if let Some(ref mock) = resolution.mock {
                            upstream_response = build_mock_upstream_response(mock);
                            session_detail = build_session_detail(
                                &https_request,
                                upstream_response.status_code.as_u16(),
                                &upstream_response.response_headers,
                                &upstream_response.response_body,
                                upstream_response.response_body_size_bytes,
                                started_at,
                                started_at_instant,
                                ProxyTimingBreakdown {
                                    connect_ms: None,
                                    dns_ms: None,
                                    request_send_ms: None,
                                    response_read_ms: Some(upstream_response.response_read_ms),
                                    tls_ms: Some(tls_ms),
                                    total_ms: Some(started_at_instant.elapsed().as_millis()),
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
                        apply_response_resolution(&resolution, &mut upstream_response);
                        if resolution.modified_response_body_base64.is_some() {
                            // Body changed — must rebuild (includes decompression).
                            session_detail = build_session_detail(
                                &https_request,
                                upstream_response.status_code.as_u16(),
                                &upstream_response.response_headers,
                                &upstream_response.response_body,
                                upstream_response.response_body_size_bytes,
                                started_at,
                                started_at_instant,
                                ProxyTimingBreakdown {
                                    connect_ms: None,
                                    dns_ms: None,
                                    request_send_ms: None,
                                    response_read_ms: Some(upstream_response.response_read_ms),
                                    tls_ms: Some(tls_ms),
                                    total_ms: Some(started_at_instant.elapsed().as_millis()),
                                    waiting_ms: Some(upstream_response.waiting_ms),
                                },
                                upstream_response.body_truncated,
                            );
                            session_detail.map_traces = map_traces.clone();
                            session_detail.rewrite_traces = rewrite_traces.clone();
                            session_detail.script_traces = script_traces.clone();
                            session_detail.throttle_traces = throttle_traces.clone();
                        } else {
                            // Only headers/status may have changed — update in place, no body decompression needed.
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

            if let Some(selection) = throttle_selection
                .as_ref()
                .filter(|selection| throttle_selection_matches_stage(selection, "response"))
            {
                let trace =
                    apply_response_throttle(selection, upstream_response.response_body_size_bytes)
                        .await;
                if let Some(manager) = throttle_manager.as_ref() {
                    manager.record_trace(&trace);
                }
                throttle_traces.push(trace);
                session_detail.throttle_traces = throttle_traces.clone();
            }

            let write_result = if let Some(spooled_response_path) =
                upstream_response.spooled_response_path.as_deref()
            {
                write_spooled_upstream_response(
                    &mut tls_stream,
                    upstream_response.status_code,
                    &upstream_response.response_headers,
                    upstream_response.response_body_size_bytes,
                    spooled_response_path,
                )
                .await
            } else {
                write_upstream_response(
                    &mut tls_stream,
                    upstream_response.status_code,
                    &upstream_response.response_headers,
                    &upstream_response.response_body,
                )
                .await
            };

            if let Err(error) = write_result {
                let _ = session_sender.send(session_detail).await;
                return Err(error);
            }

            session_detail.rewrite_traces = rewrite_traces;
            session_detail.script_traces = script_traces;
            session_detail.map_traces = map_traces;

            if session_sender.send(session_detail).await.is_err() {
                emit_log(
                    "DEBUG",
                    "session_send_dropped",
                    &[("reason", "receiver_disconnected".to_string())],
                );
            }

            emit_log(
                "DEBUG",
                "https_request_forwarded",
                &[
                    ("request_id", https_request.request_id.clone()),
                    ("host", host.clone()),
                    ("method", https_request.method.to_string()),
                    (
                        "status_code",
                        upstream_response.status_code.as_u16().to_string(),
                    ),
                    ("url", https_url),
                ],
            );

            Ok(())
        }
        Err(error) => {
            let response_message = "The proxy could not reach the upstream HTTPS server.";

            write_plain_text_response(&mut tls_stream, StatusCode::BAD_GATEWAY, response_message)
                .await?;

            let detail = build_session_detail(
                &https_request,
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
                    tls_ms: Some(tls_ms),
                    total_ms: Some(started_at_instant.elapsed().as_millis()),
                    waiting_ms: Some(started_at_instant.elapsed().as_millis()),
                },
                false,
            );
            if session_sender.send(detail).await.is_err() {
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
                    ("host", host.clone()),
                    ("url", https_url),
                    ("error", error.clone()),
                ],
            );

            Err(format!("upstream HTTPS request failed: {error}"))
        }
    }
}

async fn read_proxy_request(stream: &mut TcpStream) -> Result<ParsedProxyRequest, String> {
    read_proxy_request_from_stream(stream).await
}

async fn read_proxy_request_from_stream<S: AsyncReadExt + AsyncWriteExt + Unpin>(
    stream: &mut S,
) -> Result<ParsedProxyRequest, String> {
    let mut buffer = Vec::with_capacity(READ_BUFFER_BYTES);
    let mut chunk = vec![0_u8; READ_BUFFER_BYTES];
    let header_end = loop {
        let read_result = timeout(CLIENT_HEADER_READ_TIMEOUT, stream.read(&mut chunk))
            .await
            .map_err(|_| "timed out waiting for client request headers".to_string())?;

        let bytes_read =
            read_result.map_err(|error| format!("failed to read from client stream: {error}"))?;

        if bytes_read == 0 {
            return Err("client disconnected before sending headers".to_string());
        }

        buffer.extend_from_slice(&chunk[..bytes_read]);

        if buffer.len() > MAX_HEADER_BYTES {
            return Err("request headers exceed the maximum supported size".to_string());
        }

        if let Some(header_end) = find_header_end(&buffer) {
            break header_end;
        }
    };

    let mut headers = [EMPTY_HEADER; MAX_REQUEST_HEADERS];
    let mut request = Request::new(&mut headers);
    let parse_status = request
        .parse(&buffer[..header_end])
        .map_err(|error| format!("failed to parse request line and headers: {error}"))?;

    if parse_status != Status::Complete(header_end) {
        return Err("request headers are incomplete".to_string());
    }

    let (
        method,
        raw_path,
        url,
        body_length,
        headers,
        request_headers,
        host,
        path,
        protocol,
        query_params,
        request_version,
    ) = {
        let method = Method::from_bytes(
            request
                .method
                .ok_or_else(|| "request method is missing".to_string())?
                .as_bytes(),
        )
        .map_err(|error| format!("unsupported HTTP method: {error}"))?;
        let raw_path = request
            .path
            .ok_or_else(|| "request target is missing".to_string())?
            .to_string();
        let target_url = if method == Method::CONNECT {
            format!("http://{raw_path}")
        } else {
            resolve_target_url(&raw_path, request.headers)?
        };
        let url = Url::parse(&target_url)
            .map_err(|error| format!("invalid proxy target URL: {error}"))?;
        let body_length = read_content_length(request.headers)?;
        if body_length > MAX_REQUEST_BODY_BYTES {
            return Err(format!(
                "request body exceeds the maximum supported size of {MAX_REQUEST_BODY_BYTES} bytes"
            ));
        }
        let headers = build_upstream_headers(request.headers)?;
        let request_headers = build_header_entries_from_httparse_headers(request.headers);
        let host = url
            .host_str()
            .ok_or_else(|| "target URL does not contain a host".to_string())?
            .to_string();
        let path = if method == Method::CONNECT {
            raw_path.clone()
        } else {
            build_request_path(&url)
        };
        let protocol = if method == Method::CONNECT {
            "connect".to_string()
        } else {
            url.scheme().to_string()
        };
        let query_params = build_query_params(&url);
        let request_version = request.version.unwrap_or(1);

        (
            method,
            raw_path,
            url,
            body_length,
            headers,
            request_headers,
            host,
            path,
            protocol,
            query_params,
            request_version,
        )
    };

    while buffer.len() < header_end + body_length {
        let read_result = timeout(CLIENT_BODY_READ_TIMEOUT, stream.read(&mut chunk))
            .await
            .map_err(|_| "timed out waiting for client request body".to_string())?;

        let bytes_read =
            read_result.map_err(|error| format!("failed to read request body: {error}"))?;

        if bytes_read == 0 {
            return Err("client disconnected before request body was fully received".to_string());
        }

        buffer.extend_from_slice(&chunk[..bytes_read]);
    }
    let body = buffer[header_end..header_end + body_length].to_vec();
    let raw_request = build_raw_http_head(
        &format!(
            "{} {} HTTP/1.{}",
            method.as_str(),
            raw_path,
            request_version,
        ),
        &request_headers,
    );

    Ok(ParsedProxyRequest {
        body,
        client_address: None,
        headers,
        host,
        method,
        path,
        protocol,
        query_params,
        raw_request,
        request_headers,
        request_id: Uuid::new_v4().to_string(),
        url,
        tls_cipher_suite: None,
        tls_protocol: None,
    })
}

pub async fn send_direct_request(
    method: String,
    url: String,
    headers: Vec<ProxyHeaderEntry>,
    body: Option<String>,
) -> Result<ProxySessionDetail, String> {
    let request_method = Method::from_bytes(method.as_bytes())
        .map_err(|e| format!("invalid HTTP method '{method}': {e}"))?;
    let request_url = Url::parse(&url).map_err(|e| format!("invalid URL '{url}': {e}"))?;

    let host = request_url
        .host_str()
        .ok_or_else(|| format!("URL '{url}' does not contain a host"))?
        .to_string();
    let path = build_request_path(&request_url);
    let protocol = request_url.scheme().to_string();
    let query_params = build_query_params(&request_url);
    let request_id = Uuid::new_v4().to_string();

    // Build header map, skipping hop-by-hop headers
    let mut header_map = HeaderMap::new();
    for header in &headers {
        if should_skip_request_header(&header.name) {
            continue;
        }
        let header_name = HeaderName::from_bytes(header.name.as_bytes())
            .map_err(|e| format!("invalid header name '{}': {e}", header.name))?;
        let header_value = HeaderValue::from_str(&header.value)
            .map_err(|e| format!("invalid header value for '{}': {e}", header.name))?;
        header_map.append(header_name, header_value);
    }

    let body_bytes = body
        .as_deref()
        .filter(|b| !b.is_empty())
        .map(|b| b.as_bytes().to_vec())
        .unwrap_or_default();

    let raw_request = build_raw_http_head(&format!("{method} {path} HTTP/1.1"), &headers);

    let client = direct_http_client()?;

    let mut request_builder = client.request(request_method.clone(), request_url.clone());
    request_builder = request_builder.headers(header_map.clone());

    if !body_bytes.is_empty() {
        request_builder = request_builder.body(body_bytes.clone());
    }

    let started_at = Utc::now();
    let started_at_instant = Instant::now();

    let waiting_started_at = Instant::now();
    let response = request_builder
        .send()
        .await
        .map_err(|e| format!("failed to send request to '{url}': {e}"))?;
    let waiting_ms = waiting_started_at.elapsed().as_millis();

    let status_code = response.status();
    let response_headers = response.headers().clone();

    let response_read_started_at = Instant::now();
    let (response_body, response_body_size_bytes, body_truncated, _) =
        read_response_body_with_limit(response, &request_id, false)
            .await
            .map_err(|error| format!("failed to read response body: {error}"))?;
    let response_read_ms = response_read_started_at.elapsed().as_millis();

    emit_log(
        "DEBUG",
        "direct_request_completed",
        &[
            ("request_id", request_id.clone()),
            ("method", method.clone()),
            ("url", url.clone()),
            ("status_code", status_code.as_u16().to_string()),
            ("waiting_ms", waiting_ms.to_string()),
            ("response_read_ms", response_read_ms.to_string()),
        ],
    );

    let timing = ProxyTimingBreakdown {
        connect_ms: None,
        dns_ms: None,
        request_send_ms: None,
        response_read_ms: Some(response_read_ms),
        tls_ms: None,
        total_ms: Some(started_at_instant.elapsed().as_millis()),
        waiting_ms: Some(waiting_ms),
    };

    let id = Uuid::new_v4().to_string();
    let response_header_entries = build_header_entries_from_map(&response_headers);
    let response_mime_type = response_headers
        .get(CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);

    let summary = build_session_summary(SessionSummaryInput {
        id: id.clone(),
        method,
        host,
        path,
        protocol,
        url,
        status_code: status_code.as_u16(),
        size_bytes: response_body_size_bytes,
        response_mime_type,
        started_at,
        started_at_instant,
    });

    Ok(ProxySessionDetail {
        client_address: None,
        cookies: build_cookie_entries(&headers, &response_header_entries),
        id,
        query_params,
        raw_request_head: Some(raw_request),
        raw_response_head: Some(build_raw_http_head(
            &format!(
                "HTTP/1.1 {} {}",
                status_code.as_u16(),
                status_code.canonical_reason().unwrap_or("Unknown"),
            ),
            &response_header_entries,
        )),
        request_body: build_body_reference(
            &body_bytes,
            header_map.get(CONTENT_TYPE),
            header_map.get(reqwest::header::CONTENT_ENCODING),
            body_bytes.len(),
            false,
        ),
        request_headers: headers,
        response_body: build_body_reference(
            &response_body,
            response_headers.get(CONTENT_TYPE),
            response_headers.get(reqwest::header::CONTENT_ENCODING),
            response_body_size_bytes,
            body_truncated,
        ),
        response_headers: response_header_entries,
        map_traces: Vec::new(),
        rewrite_traces: Vec::new(),
        server_ip: None,
        script_traces: Vec::new(),
        summary,
        throttle_traces: Vec::new(),
        tls_cipher_suite: None,
        tls_protocol: None,
        timing: Some(timing),
    })
}

async fn respond_with_throttle_failure<S: AsyncReadExt + AsyncWriteExt + Unpin>(
    stream: &mut S,
    request: &ParsedProxyRequest,
    session_sender: &mpsc::Sender<ProxySessionDetail>,
    started_at: DateTime<Utc>,
    started_at_instant: Instant,
    tls_ms: Option<u128>,
    error: &str,
    map_traces: Vec<MapTrace>,
    throttle_traces: Vec<ThrottleTrace>,
) -> Result<(), String> {
    let response_message = "The request was dropped by the active throttle profile.";

    write_plain_text_response(stream, StatusCode::GATEWAY_TIMEOUT, response_message).await?;

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
            tls_ms,
            total_ms: Some(started_at_instant.elapsed().as_millis()),
            waiting_ms: Some(started_at_instant.elapsed().as_millis()),
        },
        false,
    );
    detail.map_traces = map_traces;
    detail.throttle_traces = throttle_traces;
    if session_sender.send(detail).await.is_err() {
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

    Ok(())
}
